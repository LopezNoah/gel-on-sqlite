import { AppError } from "../errors.js";
import type { FilterExprIR, IRStatement, SelectIR, SelectShapeElementIR } from "../ir/model.js";
import { canLowerStdlibFunctionToSql, type RuntimeTarget } from "../runtime/target.js";
import type { ScalarValue } from "../types.js";

export interface SQLArtifact {
  sql: string;
  params: ScalarValue[];
  loweringMode: "single_statement" | "fallback_multi_query";
}

export interface SQLCompileOptions {
  target?: RuntimeTarget;
}

export const compileToSQL = (ir: IRStatement, options: SQLCompileOptions = {}): SQLArtifact => {
  const target = options.target ?? "sqlite";
  if (ir.kind === "select") {
    return compileSelectToSQL(ir, target);
  }

  if (ir.kind === "select_free") {
    return {
      sql: "SELECT 1",
      params: [],
      loweringMode: "fallback_multi_query",
    };
  }

  if (ir.kind === "insert") {
    const keys = Object.keys(ir.values);
    if (keys.length === 0) {
      throw new AppError("E_SQL", "Cannot compile empty insert value map");
    }

    const placeholders = keys.map(() => "?").join(", ");
    const columns = keys.map(quoteIdent).join(", ");
    const sql = `INSERT INTO ${quoteIdent(ir.table)} (${columns}) VALUES (${placeholders})`;
    const params = keys.map((key) => encodeParam(ir.values[key]));

    return { sql, params, loweringMode: "single_statement" };
  }

  if (ir.kind === "update") {
    const keys = Object.keys(ir.values);
    if (keys.length === 0) {
      throw new AppError("E_SQL", "Cannot compile empty update value map");
    }

    const setClause = keys.map((key) => `${quoteIdent(key)} = ?`).join(", ");
    let sql = `UPDATE ${quoteIdent(ir.table)} SET ${setClause}`;
    const params = keys.map((key) => encodeParam(ir.values[key]));

    if (ir.filter) {
      sql += ` WHERE ${quoteIdent(ir.filter.column)} = ?`;
      params.push(encodeParam(ir.filter.value));
    }

    return { sql, params, loweringMode: "single_statement" };
  }

  let sql = `DELETE FROM ${quoteIdent(ir.table)}`;
  const params: ScalarValue[] = [];
  if (ir.filter) {
    sql += ` WHERE ${quoteIdent(ir.filter.column)} = ?`;
    params.push(encodeParam(ir.filter.value));
  }

  return { sql, params, loweringMode: "single_statement" };
};

const compileSelectToSQL = (ir: SelectIR, target: RuntimeTarget): SQLArtifact => {
  const params: ScalarValue[] = [];
  const rootAlias = "t0";
  const requiresFallback = shapeRequiresFallbackLowering(ir.shape, target);
  const includePayloads = !requiresFallback;
  const projections: string[] = [
    `${rootAlias}.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}`,
    ...ir.columns.map(
    (column) => `${rootAlias}.${quoteIdent(column)} AS ${quoteIdent(column)}`,
    ),
  ];

  for (const element of ir.shape) {
    if (element.kind !== "computed" || element.expr.kind !== "function_call") {
      continue;
    }

    const lowered = compileStdlibFunctionCallSQL(element.expr, rootAlias, params, target);
    if (!lowered) {
      continue;
    }

    projections.push(`${lowered} AS ${quoteIdent(computedValueAlias(element.pathId))}`);
  }

  if (includePayloads) {
    for (const element of ir.shape) {
      if (element.kind !== "link" && element.kind !== "backlink") {
        continue;
      }

      const alias = shapePayloadAlias(element.pathId);
      const expr =
        element.kind === "link"
          ? compileLinkArrayExpr(element, rootAlias, params, target)
          : compileBacklinkArrayExpr(element, rootAlias, params);
      projections.push(`${expr} AS ${quoteIdent(alias)}`);
    }
  }

  const sources = ir.sourceTables.length > 0 ? ir.sourceTables : [ir.typeRef];
  const filterColumns = collectFieldFilterColumns(ir.filter);
  const unionColumns = [...new Set(["id", ...ir.columns, ...filterColumns, ...(ir.orderBy ? [ir.orderBy.column] : [])])];
  const sourceSelects = sources.map(
    (source) =>
      `SELECT ${quoteLiteral(source.name)} AS ${quoteIdent("__source_type")}, ${unionColumns.map((column) => `${quoteIdent(column)} AS ${quoteIdent(column)}`).join(", ")} FROM ${quoteIdent(source.table)}`,
  );

  let sql = `SELECT ${projections.join(", ")} FROM (${sourceSelects.join(" UNION ALL ")}) ${rootAlias}`;

  if (ir.filter) {
    sql += ` WHERE ${compileFilterExprSQL(ir.filter, rootAlias, params)}`;
  }

  if (ir.orderBy) {
    sql += ` ORDER BY ${rootAlias}.${quoteIdent(ir.orderBy.column)} ${ir.orderBy.direction.toUpperCase()}`;
  }

  if (ir.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(ir.limit);
  }

  if (ir.offset !== undefined) {
    sql += " OFFSET ?";
    params.push(ir.offset);
  }

  return {
    sql,
    params,
    loweringMode: includePayloads ? "single_statement" : "fallback_multi_query",
  };
};

const compileLinkArrayExpr = (
  element: Extract<SelectShapeElementIR, { kind: "link" }>,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
): string => {
  const targetAlias = `l_${sanitizePathId(element.pathId)}`;
  const rowExpr = compileShapeObjectExpr(
    element.shape,
    targetAlias,
    `${targetAlias}.${quoteIdent("__source_type")}`,
    params,
    target,
  );

  const whereClauses: string[] = [];
  let fromClause = `${compilePolymorphicTargetSource(element.relation, targetAlias)}`;

  if (element.relation.storage === "inline") {
    fromClause = `${compilePolymorphicTargetSource(element.relation, targetAlias)}`;
    whereClauses.push(
      `${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(requiredInlineColumn(element.relation.inlineColumn))}`,
    );
  } else {
    const junctionAlias = `j_${sanitizePathId(element.pathId)}`;
    fromClause = `${compilePolymorphicTargetSource(element.relation, targetAlias)} JOIN ${quoteIdent(requiredLinkTable(element.relation.linkTable))} ${junctionAlias} ON ${junctionAlias}.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")}`;
    whereClauses.push(`${junctionAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`);
  }

  if (element.filter) {
    whereClauses.push(compileFilterExprSQL(element.filter, targetAlias, params));
  }

  let inner = `SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${fromClause}`;
  if (whereClauses.length > 0) {
    inner += ` WHERE ${whereClauses.join(" AND ")}`;
  }

  if (element.orderBy) {
    inner += ` ORDER BY ${targetAlias}.${quoteIdent(element.orderBy.column)} ${element.orderBy.direction.toUpperCase()}`;
  }

  if (element.limit !== undefined) {
    inner += " LIMIT ?";
    params.push(element.limit);
  }

  if (element.offset !== undefined) {
    inner += " OFFSET ?";
    params.push(element.offset);
  }

  return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
};

const compileBacklinkArrayExpr = (
  element: Extract<SelectShapeElementIR, { kind: "backlink" }>,
  sourceAlias: string,
  params: ScalarValue[],
): string => {
  const sourceUnions = element.sources.map((source) => {
    const sourceTableAlias = `b_${source.table}_${Math.abs(hashString(source.sourceType)).toString(16)}`;
    if (source.storage === "inline") {
      return `SELECT ${sourceTableAlias}.${quoteIdent("id")} AS ${quoteIdent("id")}, ${quoteLiteral(source.sourceType)} AS ${quoteIdent("type_name")} FROM ${quoteIdent(source.table)} ${sourceTableAlias} WHERE ${sourceTableAlias}.${quoteIdent(requiredInlineColumn(source.inlineColumn))} = ${sourceAlias}.${quoteIdent("id")}`;
    }

    const junctionAlias = `bj_${source.table}_${Math.abs(hashString(source.sourceType)).toString(16)}`;
    return `SELECT ${sourceTableAlias}.${quoteIdent("id")} AS ${quoteIdent("id")}, ${quoteLiteral(source.sourceType)} AS ${quoteIdent("type_name")} FROM ${quoteIdent(source.table)} ${sourceTableAlias} JOIN ${quoteIdent(requiredLinkTable(source.linkTable))} ${junctionAlias} ON ${junctionAlias}.${quoteIdent("source")} = ${sourceTableAlias}.${quoteIdent("id")} WHERE ${junctionAlias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")}`;
  });

  if (sourceUnions.length === 0) {
    return "'[]'";
  }

  const unionSql = sourceUnions.join(" UNION ALL ");
  const ordered = `SELECT ${quoteIdent("id")}, ${quoteIdent("type_name")} FROM (${unionSql}) ORDER BY ${quoteIdent("type_name")} ASC, ${quoteIdent("id")} ASC`;
  return `COALESCE((SELECT json_group_array(json_object('id', ${quoteIdent("id")}, '__type__', ${quoteIdent("type_name")})) FROM (${ordered})), '[]')`;
};

const compileShapeObjectExpr = (
  shape: SelectShapeElementIR[],
  sourceAlias: string,
  sourceTypeExpr: string,
  params: ScalarValue[],
  target: RuntimeTarget,
): string => {
  const pairs: string[] = [];

  for (const element of shape) {
    pairs.push(quoteLiteral(element.name));

    if (element.kind === "field") {
      pairs.push(`${sourceAlias}.${quoteIdent(element.column)}`);
      continue;
    }

    if (element.kind === "computed") {
      if (element.expr.kind === "field_ref") {
        pairs.push(`${sourceAlias}.${quoteIdent(element.expr.column)}`);
      } else if (element.expr.kind === "literal") {
        pairs.push("?");
        params.push(encodeParam(element.expr.value));
      } else if (element.expr.kind === "polymorphic_field_ref") {
        pairs.push(
          `CASE WHEN ${sourceTypeExpr} = ${quoteLiteral(element.expr.sourceType)} THEN ${sourceAlias}.${quoteIdent(element.expr.column)} ELSE json('[]') END`,
        );
      } else if (element.expr.kind === "type_name") {
        pairs.push(`json_object('name', ${sourceTypeExpr})`);
      } else if (element.expr.kind === "concat") {
        const sqlParts = element.expr.parts.map((part) => {
          if (part.kind === "field_ref") {
            return `COALESCE(${sourceAlias}.${quoteIdent(part.column)}, '')`;
          }

          params.push(encodeParam(part.value));
          return "COALESCE(?, '')";
        });
        pairs.push(sqlParts.length === 0 ? "''" : `(${sqlParts.join(" || ")})`);
      } else if (element.expr.kind === "function_call") {
        const lowered = compileStdlibFunctionCallSQL(element.expr, sourceAlias, params, target);
        pairs.push(lowered ?? "json('[]')");
      } else {
        pairs.push("json('[]')");
      }

      continue;
    }

    if (element.kind === "link") {
      pairs.push(`json(${compileLinkArrayExpr(element, sourceAlias, params, target)})`);
      continue;
    }

    pairs.push(`json(${compileBacklinkArrayExpr(element, sourceAlias, params)})`);
  }

  return `json_object(${pairs.join(", ")})`;
};

export const shapePayloadAlias = (pathId: string): string => `__shape_${sanitizePathId(pathId)}`;

export const computedValueAlias = (pathId: string): string => `__computed_${sanitizePathId(pathId)}`;

const sanitizePathId = (pathId: string): string => pathId.replaceAll(".", "_");

const requiredInlineColumn = (value: string | undefined): string => {
  if (!value) {
    throw new AppError("E_SQL", "Missing inline column metadata");
  }

  return value;
};

const requiredLinkTable = (value: string | undefined): string => {
  if (!value) {
    throw new AppError("E_SQL", "Missing link table metadata");
  }

  return value;
};

const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const hashString = (value: string): number => {
  let hash = 0;
  for (let idx = 0; idx < value.length; idx += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(idx);
    hash |= 0;
  }
  return hash;
};

const encodeParam = (value: ScalarValue): ScalarValue => {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value;
};

const compileFilterPredicate = (lhsSql: string, op: "=" | "!=" | "like" | "ilike"): string => {
  if (op === "=") {
    return `${lhsSql} = ?`;
  }

  if (op === "!=") {
    return `${lhsSql} != ?`;
  }

  if (op === "like") {
    return `${lhsSql} LIKE ?`;
  }

  return `LOWER(${lhsSql}) LIKE LOWER(?)`;
};

const compileBacklinkFilterPredicate = (
  rootAlias: string,
  filter: Extract<FilterExprIR, { kind: "backlink" }>,
  params: ScalarValue[],
): string => {
  if (!filter || filter.kind !== "backlink") {
    throw new AppError("E_SQL", "Invalid backlink filter");
  }

  const clauses = filter.sources.map((source) => {
    if (source.storage === "inline") {
      params.push(encodeParam(filter.value));
      return `EXISTS (SELECT 1 FROM ${quoteIdent(source.table)} s WHERE s.${quoteIdent(requiredInlineColumn(source.inlineColumn))} = ${rootAlias}.${quoteIdent("id")} AND s.${quoteIdent("id")} = ?)`;
    }

    params.push(encodeParam(filter.value));
    return `EXISTS (SELECT 1 FROM ${quoteIdent(source.table)} s JOIN ${quoteIdent(requiredLinkTable(source.linkTable))} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ${rootAlias}.${quoteIdent("id")} AND s.${quoteIdent("id")} = ?)`;
  });

  if (clauses.length === 0) {
    return filter.op === "=" ? "0" : "1";
  }

  return filter.op === "=" ? `(${clauses.join(" OR ")})` : `NOT (${clauses.join(" OR ")})`;
};

const compileFilterExprSQL = (filter: FilterExprIR, sourceAlias: string, params: ScalarValue[]): string => {
  if (filter.kind === "field") {
    params.push(encodeParam(filter.value));
    return compileFilterPredicate(`${sourceAlias}.${quoteIdent(filter.column)}`, filter.op);
  }

  if (filter.kind === "backlink") {
    return compileBacklinkFilterPredicate(sourceAlias, filter, params);
  }

  if (filter.kind === "not") {
    return `(NOT ${compileFilterExprSQL(filter.expr, sourceAlias, params)})`;
  }

  const left = compileFilterExprSQL(filter.left, sourceAlias, params);
  const right = compileFilterExprSQL(filter.right, sourceAlias, params);
  return filter.kind === "and" ? `(${left} AND ${right})` : `(${left} OR ${right})`;
};

const collectFieldFilterColumns = (filter: FilterExprIR | undefined): string[] => {
  if (!filter) {
    return [];
  }

  if (filter.kind === "field") {
    return [filter.column];
  }

  if (filter.kind === "backlink") {
    return [];
  }

  if (filter.kind === "not") {
    return collectFieldFilterColumns(filter.expr);
  }

  return [...collectFieldFilterColumns(filter.left), ...collectFieldFilterColumns(filter.right)];
};

const shapeRequiresFallbackLowering = (shape: SelectShapeElementIR[], target: RuntimeTarget): boolean => {
  for (const element of shape) {
    if (element.kind === "computed") {
      if (element.expr.kind === "subquery") {
        return true;
      }

      if (element.expr.kind === "function_call" && !canLowerStdlibFunctionCall(element.expr, target)) {
        return true;
      }
    }

    if (element.kind === "link" && shapeRequiresFallbackLowering(element.shape, target)) {
      return true;
    }
  }

  return false;
};

type FunctionCallExprIR = Extract<Extract<SelectShapeElementIR, { kind: "computed" }>["expr"], { kind: "function_call" }>;
type FunctionCallArgIR = FunctionCallExprIR["args"][number];

const canLowerStdlibFunctionCall = (expr: FunctionCallExprIR, target: RuntimeTarget): boolean => {
  if (!isLowerableStdlibFunctionName(expr.functionName, target)) {
    return false;
  }

  for (const arg of expr.args) {
    if (!canLowerStdlibFunctionArg(arg, target)) {
      return false;
    }
  }

  return true;
};

const canLowerStdlibFunctionArg = (arg: FunctionCallArgIR, target: RuntimeTarget): boolean => {
  if (arg.kind === "literal" || arg.kind === "field_ref") {
    return true;
  }

  if (arg.kind === "function_call") {
    return canLowerStdlibFunctionCall(arg, target);
  }

  return false;
};

const compileStdlibFunctionCallSQL = (
  expr: FunctionCallExprIR,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
): string | null => {
  if (!canLowerStdlibFunctionCall(expr, target)) {
    return null;
  }

  const args = expr.args.map((arg) => compileStdlibFunctionArgSQL(arg, sourceAlias, params, target));
  if (args.some((arg) => arg === null)) {
    return null;
  }

  const argSql = args as string[];
  switch (expr.functionName) {
    case "math::abs":
      return `abs(${argSql[0]})`;
    case "math::ceil":
      return `ceil(${argSql[0]})`;
    case "math::floor":
      return `floor(${argSql[0]})`;
    case "math::exp":
      return `exp(${argSql[0]})`;
    case "math::ln":
      return `ln(${argSql[0]})`;
    case "math::lg":
      return `log(${argSql[0]})`;
    case "math::log":
      return `(ln(${argSql[0]}) / ln(${argSql[1]}))`;
    case "math::pi":
      return "pi()";
    case "math::e":
      return "exp(1.0)";
    case "math::acos":
      return `acos(${argSql[0]})`;
    case "math::asin":
      return `asin(${argSql[0]})`;
    case "math::atan":
      return `atan(${argSql[0]})`;
    case "math::atan2":
      return `atan2(${argSql[0]}, ${argSql[1]})`;
    case "math::cos":
      return `cos(${argSql[0]})`;
    case "math::cot":
      return `(1.0 / tan(${argSql[0]}))`;
    case "math::sin":
      return `sin(${argSql[0]})`;
    case "math::tan":
      return `tan(${argSql[0]})`;
    case "std::datetime_current":
    case "std::datetime_of_transaction":
    case "std::datetime_of_statement":
      return `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
    case "std::to_str":
      return `CAST(${argSql[0]} AS TEXT)`;
    case "std::datetime_get": {
      const firstExpr = `LOWER(CAST(${argSql[0]} AS TEXT))`;
      const secondExpr = `LOWER(CAST(${argSql[1]} AS TEXT))`;
      const partExpr = `CASE WHEN ${firstExpr} IN ('year', 'month', 'day', 'hour', 'minute', 'second', 'epochseconds') THEN ${firstExpr} ELSE ${secondExpr} END`;
      const dateExpr = normalizeDateTimeSQLInput(`CASE WHEN ${firstExpr} IN ('year', 'month', 'day', 'hour', 'minute', 'second', 'epochseconds') THEN ${argSql[1]} ELSE ${argSql[0]} END`);
      return `CASE ${partExpr} WHEN 'year' THEN CAST(strftime('%Y', ${dateExpr}) AS INTEGER) WHEN 'month' THEN CAST(strftime('%m', ${dateExpr}) AS INTEGER) WHEN 'day' THEN CAST(strftime('%d', ${dateExpr}) AS INTEGER) WHEN 'hour' THEN CAST(strftime('%H', ${dateExpr}) AS INTEGER) WHEN 'minute' THEN CAST(strftime('%M', ${dateExpr}) AS INTEGER) WHEN 'second' THEN CAST(strftime('%S', ${dateExpr}) AS INTEGER) WHEN 'epochseconds' THEN CAST(strftime('%s', ${dateExpr}) AS INTEGER) ELSE NULL END`;
    }
    case "std::datetime_truncate": {
      const firstExpr = `LOWER(CAST(${argSql[0]} AS TEXT))`;
      const secondExpr = `LOWER(CAST(${argSql[1]} AS TEXT))`;
      const partExpr = `CASE WHEN ${firstExpr} IN ('year', 'month', 'day', 'hour', 'minute', 'second') THEN ${firstExpr} ELSE ${secondExpr} END`;
      const dateExpr = normalizeDateTimeSQLInput(`CASE WHEN ${firstExpr} IN ('year', 'month', 'day', 'hour', 'minute', 'second') THEN ${argSql[1]} ELSE ${argSql[0]} END`);
      return `CASE ${partExpr} WHEN 'year' THEN strftime('%Y-01-01T00:00:00.000Z', ${dateExpr}) WHEN 'month' THEN strftime('%Y-%m-01T00:00:00.000Z', ${dateExpr}) WHEN 'day' THEN strftime('%Y-%m-%dT00:00:00.000Z', ${dateExpr}) WHEN 'hour' THEN strftime('%Y-%m-%dT%H:00:00.000Z', ${dateExpr}) WHEN 'minute' THEN strftime('%Y-%m-%dT%H:%M:00.000Z', ${dateExpr}) WHEN 'second' THEN strftime('%Y-%m-%dT%H:%M:%S.000Z', ${dateExpr}) ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${dateExpr}) END`;
    }
    default:
      return null;
  }
};

const compileStdlibFunctionArgSQL = (
  arg: FunctionCallArgIR,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
): string | null => {
  if (arg.kind === "literal") {
    params.push(encodeParam(arg.value));
    return "?";
  }

  if (arg.kind === "field_ref") {
    return `${sourceAlias}.${quoteIdent(arg.column)}`;
  }

  if (arg.kind === "function_call") {
    return compileStdlibFunctionCallSQL(arg, sourceAlias, params, target);
  }

  return null;
};

const isLowerableStdlibFunctionName = (functionName: string, target: RuntimeTarget): boolean =>
  canLowerStdlibFunctionToSql(target, functionName);

const normalizeDateTimeSQLInput = (dateExpr: string): string =>
  `replace(replace(CAST(${dateExpr} AS TEXT), 'T', ' '), 'Z', '')`;

const compilePolymorphicTargetSource = (
  relation: Extract<SelectShapeElementIR, { kind: "link" }>["relation"],
  alias: string,
): string => {
  const targets = relation.targetTables.length > 0
    ? relation.targetTables
    : [{ name: relation.targetType, table: relation.targetTable }];

  if (targets.length === 1) {
    const only = targets[0];
    return `(
      SELECT ${quoteLiteral(only.name)} AS ${quoteIdent("__source_type")}, *
      FROM ${quoteIdent(only.table)}
    ) ${alias}`;
  }

  const selects = targets.map(
    (target) => `SELECT ${quoteLiteral(target.name)} AS ${quoteIdent("__source_type")}, * FROM ${quoteIdent(target.table)}`,
  );
  return `(${selects.join(" UNION ALL ")}) ${alias}`;
};
