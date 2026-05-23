import { AppError } from "../errors.js";
import type { FreeObjectExpr } from "../edgeql/ast.js";
import type { FilterExprIR, IRStatement, LinkRelationIR, PathIdIR, SelectFreeIR, SelectIR, SelectShapeElementIR } from "../ir/model.js";
import type { RuntimeTarget } from "../runtime/target.js";
import { canLowerStdlibFunctionSql, lowerStdlibFunctionSql } from "./stdlib_lowering.js";
import type { ComputedLinkPropertyDef, ComputedLinkPropertyExpr, ScalarValue } from "../types.js";

export interface SQLArtifact {
  sql: string;
  params: ScalarValue[];
  loweringMode: "single_statement" | "fallback_multi_query";
}

export interface SQLCompileOptions {
  target?: RuntimeTarget;
  parameterValues?: Record<string, ScalarValue>;
  globalValues?: Record<string, ScalarValue>;
}

export const compileToSQL = (ir: IRStatement, options: SQLCompileOptions = {}): SQLArtifact => {
  const target = options.target ?? "sqlite";
  if (ir.kind === "select") {
    return compileSelectToSQL(ir, target);
  }

  if (ir.kind === "select_free") {
    return compileSelectFreeToSQL(ir, target);
  }

  if (ir.kind === "select_expr") {
    return {
      sql: "SELECT 1",
      params: [],
      loweringMode: "fallback_multi_query",
    };
  }

  if (ir.kind === "group") {
    // The runtime evaluator runs the source SelectIR's own SQL; this artifact
    // is a placeholder so the rest of the pipeline (cache/trace) doesn't choke.
    return {
      sql: "SELECT 1",
      params: [],
      loweringMode: "fallback_multi_query",
    };
  }

  if (ir.kind === "insert") {
    const keys = Object.keys(ir.values);
    if (keys.length === 0) {
      return {
        sql: `INSERT INTO ${quoteIdent(ir.table)} DEFAULT VALUES`,
        params: [],
        loweringMode: "single_statement",
      };
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
      return {
        sql: "SELECT 1",
        params: [],
        loweringMode: "fallback_multi_query",
      };
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

const compileSelectFreeToSQL = (ir: SelectFreeIR, target: RuntimeTarget): SQLArtifact => {
  const params: ScalarValue[] = [];
  const projections: string[] = [];

  for (const entry of ir.entries) {
    const lowered = compileSelectFreeEntrySQL(entry, params, target);
    if (!lowered) {
      return {
        sql: "SELECT 1",
        params: [],
        loweringMode: "fallback_multi_query",
      };
    }

    projections.push(`${lowered} AS ${quoteIdent(entry.name)}`);
  }

  if (projections.length === 0) {
    return {
      sql: "SELECT 1",
      params: [],
      loweringMode: "fallback_multi_query",
    };
  }

  return {
    sql: `SELECT ${projections.join(", ")}`,
    params,
    loweringMode: "single_statement",
  };
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

  const extraShapeColumns: string[] = [];
  for (const element of ir.shape) {
    if (element.kind !== "computed") {
      continue;
    }

    if (element.expr.kind === "function_call") {
      const lowered = compileStdlibFunctionCallSQL(element.expr, rootAlias, params, target);
      if (!lowered) {
        continue;
      }

      projections.push(`${lowered} AS ${quoteIdent(computedValueAlias(element.pathId))}`);
      continue;
    }

    if (element.expr.kind === "link_aggregate") {
      const lowered = compileLinkAggregateExpr(element.expr, rootAlias);
      projections.push(`${lowered} AS ${quoteIdent(computedValueAlias(element.pathId))}`);
      continue;
    }

    if (element.expr.kind === "select_expr") {
      const referenced = collectShapeScalarValueColumns(element.expr.expr);
      extraShapeColumns.push(...referenced);
      const lowered = compileShapeScalarValueSQL(
        element.expr.expr,
        rootAlias,
        undefined,
        params,
      );
      if (lowered) {
        projections.push(`${lowered} AS ${quoteIdent(computedValueAlias(element.pathId))}`);
      } else {
        // When SQL lowering fails for a shape-computed expression, the runtime
        // falls back to JS evaluation on the row. Project any referenced raw
        // columns so they're available on the row.
        for (const column of referenced) {
          projections.push(`${rootAlias}.${quoteIdent(column)} AS ${quoteIdent(column)}`);
        }
      }
    }
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
          : compileBacklinkArrayExpr(element, rootAlias, params, target);
      projections.push(`${expr} AS ${quoteIdent(alias)}`);
    }
  }

  const sources = ir.sourceTables.length > 0 ? ir.sourceTables : [ir.typeRef];
  const filterColumns = collectFieldFilterColumns(ir.filter);
  const orderByValues: string[] = [];
  for (let term: typeof ir.orderBy | undefined = ir.orderBy; term; term = term.then) {
    orderByValues.push(term.value);
  }
  const unionColumns = [...new Set(["id", ...ir.columns, ...filterColumns, ...orderByValues, ...extraShapeColumns])]
    .filter((column) => column !== "__source_type");
  const sourceSelects = sources.map((source) => {
    const available = source.columns && source.columns.length > 0 ? new Set(source.columns) : undefined;
    const projection = unionColumns
      .map((column) => (
        !available || available.has(column)
          ? `${quoteIdent(column)} AS ${quoteIdent(column)}`
          : `NULL AS ${quoteIdent(column)}`
      ))
      .join(", ");
    return `SELECT ${quoteLiteral(source.name)} AS ${quoteIdent("__source_type")}, ${projection} FROM ${quoteIdent(source.table)}`;
  });

  let sql = `SELECT ${projections.join(", ")} FROM (${sourceSelects.join(" UNION ALL ")}) ${rootAlias}`;

  if (ir.filter) {
    sql += ` WHERE ${compileFilterExprSQL(ir.filter, rootAlias, params)}`;
  }

  if (ir.orderBy) {
    const computedByPointer = new Map<string, string>();
    for (const element of ir.shape) {
      if (element.kind !== "computed") continue;
      if (!element.name) continue;
      computedByPointer.set(element.name, computedValueAlias(element.pathId));
    }
    const terms: string[] = [];
    let term: typeof ir.orderBy | undefined = ir.orderBy;
    while (term) {
      const nullsClause = term.nullsPosition === "first"
        ? " NULLS FIRST"
        : term.nullsPosition === "last"
          ? " NULLS LAST"
          : "";
      const alias = computedByPointer.get(term.value);
      const ref = alias
        ? quoteIdent(alias)
        : `${rootAlias}.${quoteIdent(term.value)}`;
      terms.push(`${ref} ${term.direction.toUpperCase()}${nullsClause}`);
      term = term.then;
    }
    sql += ` ORDER BY ${terms.join(", ")}`;
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
  const junctionAlias = element.relation.storage === "table" ? `j_${sanitizePathId(element.pathId)}` : undefined;
  const rowExpr = compileShapeObjectExpr(
    element.shape,
    targetAlias,
    `${targetAlias}.${quoteIdent("__source_type")}`,
    params,
    target,
    junctionAlias,
    element.relation.computedProperties,
  );

  const linkPropertyColumns = new Set(element.relation.propertyColumns ?? []);
  const computedLinkPropertyByName = new Map((element.relation.computedProperties ?? []).map((property) => [property.name, property] as const));
  const requestedComputedLinkProperties = element.shape.flatMap((shapeElement) => {
    if (shapeElement.kind !== "computed" || shapeElement.expr.kind !== "field_ref" || !shapeElement.expr.column.startsWith("@")) {
      return [];
    }
    const property = computedLinkPropertyByName.get(shapeElement.expr.column.slice(1));
    return property ? [property] : [];
  });
  const orderByTargetColumns = element.orderBy && !linkPropertyColumns.has(element.orderBy.value)
    ? [element.orderBy.value]
    : [];
  const requiredTargetColumns = [
    ...element.columns,
    ...requestedComputedLinkProperties.flatMap((property) => collectComputedLinkPropertyTargetColumns(property.computedExpr)),
    ...orderByTargetColumns,
    ...collectFieldFilterColumns(element.filter).filter((column) => !column.startsWith("@")),
  ];

  const whereClauses: string[] = [];
  let fromClause: string;

  if (element.relation.storage === "inline") {
    fromClause = `${compilePolymorphicTargetSource(element.relation, targetAlias, requiredTargetColumns)}`;
    whereClauses.push(
      `${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(requiredInlineColumn(element.relation.inlineColumn))}`,
    );
  } else {
    fromClause = `${compilePolymorphicTargetSource(element.relation, targetAlias, requiredTargetColumns)} JOIN ${linkJunctionFrom(element.relation, junctionAlias!)} ON ${junctionAlias}.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")}`;
    whereClauses.push(`${junctionAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`);
  }

  if (element.filter) {
    whereClauses.push(compileFilterExprSQL(element.filter, targetAlias, params, junctionAlias));
  }

  let inner = `SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${fromClause}`;
  if (whereClauses.length > 0) {
    inner += ` WHERE ${whereClauses.join(" AND ")}`;
  }

  if (element.orderBy) {
    const orderAlias = element.relation.storage === "table" && linkPropertyColumns.has(element.orderBy.value)
      ? requiredAlias(junctionAlias)
      : targetAlias;
    inner += ` ORDER BY ${orderAlias}.${quoteIdent(element.orderBy.value)} ${element.orderBy.direction.toUpperCase()}`;
    if (element.orderBy.value !== "name" && element.columns.includes("name")) {
      inner += `, ${targetAlias}.${quoteIdent("name")} ASC`;
    }
  } else if (element.relation.storage === "table" && junctionAlias) {
    inner += ` ORDER BY ${junctionAlias}.rowid ASC`;
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
  params: ScalarValue[] = [],
  target: RuntimeTarget = "sqlite",
): string => {
  const shape = element.shape;
  const hasShape = Array.isArray(shape) && shape.length > 0;
  const projectedColumns = hasShape
    ? Array.from(new Set(shape!.flatMap((shapeElement) => {
        if (shapeElement.kind === "field") return [shapeElement.column];
        if (shapeElement.kind === "computed" && shapeElement.expr.kind === "field_ref" && !shapeElement.expr.column.startsWith("@")) {
          return [shapeElement.expr.column];
        }
        return [];
      })))
    : [];
  const projectedColumnsSql = projectedColumns.length > 0
    ? projectedColumns.map((column) => `, ${quoteIdent(column)} AS ${quoteIdent(column)}`).join("")
    : "";

  const linkPropertyColumns = hasShape
    ? Array.from(new Set(shape!.flatMap((shapeElement) => {
        if (shapeElement.kind === "computed") {
          if (shapeElement.expr.kind === "field_ref" && shapeElement.expr.column.startsWith("@")) {
            return [shapeElement.expr.column.slice(1)];
          }
          if (shapeElement.expr.kind === "literal" && shapeElement.name.startsWith("@")) {
            return [shapeElement.name.slice(1)];
          }
        }
        return [];
      })))
    : [];

  const sourceUnions = element.sources.map((source) => {
    const sourceTables = source.sourceTables && source.sourceTables.length > 0
      ? source.sourceTables
      : [{ name: source.sourceType, table: source.table }];
    const junctionAlias = `bj_${source.table}_${Math.abs(hashString(source.sourceType)).toString(16)}`;
    const innerSelections = projectedColumns.length > 0
      ? projectedColumns.map((column) => `, s.${quoteIdent(column)} AS ${quoteIdent(column)}`).join("")
      : "";
    const linkPropertySelections = linkPropertyColumns.length > 0
      ? linkPropertyColumns.map((column) => `, ${junctionAlias}.${quoteIdent(column)} AS ${quoteIdent(`@${column}`)}`).join("")
      : "";

    if (source.storage === "inline") {
      const inlineUnion = sourceTables
        .map((tableRef) => {
          const stAlias = `b_${tableRef.table}_${Math.abs(hashString(source.sourceType)).toString(16)}`;
          const tableProjections = projectedColumns.length > 0
            ? projectedColumns.map((column) => `, ${stAlias}.${quoteIdent(column)} AS ${quoteIdent(column)}`).join("")
            : "";
          const linkPropProjections = linkPropertyColumns.length > 0
            ? linkPropertyColumns.map((column) => `, NULL AS ${quoteIdent(`@${column}`)}`).join("")
            : "";
          return `SELECT ${stAlias}.${quoteIdent("id")} AS ${quoteIdent("id")}, ${quoteLiteral(tableRef.name)} AS ${quoteIdent("type_name")}${tableProjections}${linkPropProjections} FROM ${quoteIdent(tableRef.table)} ${stAlias} WHERE ${stAlias}.${quoteIdent(requiredInlineColumn(source.inlineColumn))} = ${sourceAlias}.${quoteIdent("id")}`;
        })
        .join(" UNION ALL ");
      return inlineUnion;
    }

    const linkTable = requiredLinkTable(source.linkTable);
    const sourceTableSelect = sourceTables.length === 1
      ? `SELECT ${quoteLiteral(sourceTables[0].name)} AS ${quoteIdent("__source_type")}, ${quoteIdent("id")} AS ${quoteIdent("id")}${projectedColumnsSql} FROM ${quoteIdent(sourceTables[0].table)}`
      : sourceTables.map((entry) => `SELECT ${quoteLiteral(entry.name)} AS ${quoteIdent("__source_type")}, ${quoteIdent("id")} AS ${quoteIdent("id")}${projectedColumnsSql} FROM ${quoteIdent(entry.table)}`).join(" UNION ALL ");
    const fromClause = sourceTables.length === 1
      ? `(${sourceTableSelect}) s`
      : `(${sourceTableSelect}) s`;
    return `SELECT s.${quoteIdent("id")} AS ${quoteIdent("id")}, s.${quoteIdent("__source_type")} AS ${quoteIdent("type_name")}${innerSelections}${linkPropertySelections} FROM ${fromClause} JOIN ${quoteIdent(linkTable)} ${junctionAlias} ON ${junctionAlias}.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE ${junctionAlias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")}`;
  });

  if (sourceUnions.length === 0) {
    return "'[]'";
  }

  const unionSql = sourceUnions.join(" UNION ALL ");
  const allProjectedCols = [
    quoteIdent("id"),
    quoteIdent("type_name"),
    ...projectedColumns.map((column) => quoteIdent(column)),
    ...linkPropertyColumns.map((column) => quoteIdent(`@${column}`)),
  ];
  const ordered = `SELECT ${allProjectedCols.join(", ")} FROM (${unionSql}) ORDER BY ${quoteIdent("type_name")} ASC, ${quoteIdent("id")} ASC`;

  if (!hasShape) {
    return `COALESCE((SELECT json_group_array(json_object('id', ${quoteIdent("id")}, '__type__', ${quoteIdent("type_name")})) FROM (${ordered})), '[]')`;
  }

  const itemPairs: string[] = [];
  for (const shapeElement of shape!) {
    itemPairs.push(quoteLiteral(shapeElement.name));
    if (shapeElement.kind === "field") {
      itemPairs.push(quoteIdent(shapeElement.column));
      continue;
    }
    if (shapeElement.kind === "computed") {
      if (shapeElement.expr.kind === "field_ref") {
        const colName = shapeElement.expr.column.startsWith("@")
          ? quoteIdent(shapeElement.expr.column)
          : quoteIdent(shapeElement.expr.column);
        itemPairs.push(colName);
        continue;
      }
      if (shapeElement.expr.kind === "literal") {
        if (shapeElement.name.startsWith("@")) {
          itemPairs.push(quoteIdent(shapeElement.name));
          continue;
        }
        params.push(encodeParam(shapeElement.expr.value));
        itemPairs.push("?");
        continue;
      }
      if (shapeElement.expr.kind === "type_name") {
        itemPairs.push(quoteIdent("type_name"));
        continue;
      }
      itemPairs.push("json('[]')");
      continue;
    }
    itemPairs.push("json('[]')");
  }
  void target;
  return `COALESCE((SELECT json_group_array(json_object(${itemPairs.join(", ")})) FROM (${ordered})), '[]')`;
};

type FreePathTail = { fields: string[]; linkProperty?: string };

const extractFreePathTail = (expr: FreeObjectExpr): FreePathTail | null => {
  const fields: string[] = [];
  let linkProperty: string | undefined;
  let cursor: FreeObjectExpr = expr;
  while (cursor.kind === "field_access") {
    const field = cursor.field;
    if (field.startsWith("@")) {
      if (linkProperty !== undefined || fields.length > 0) return null;
      linkProperty = field.slice(1);
    } else {
      fields.unshift(field);
    }
    cursor = cursor.expr;
  }
  if (cursor.kind === "select_expr_subquery") {
    cursor = cursor.expr;
  }
  if (cursor.kind !== "select") return null;
  return { fields, linkProperty };
};

const operatorToSqlInfix = (op: string): string | null => {
  if (op === "=" || op === "!=" || op === ">" || op === "<" || op === ">=" || op === "<=") {
    return op === "!=" ? "<>" : op;
  }
  return null;
};

const compileShapeComputedFreeExprSQL = (
  expr: FreeObjectExpr,
  sourceAlias: string,
  linkPropertyAlias: string | undefined,
  params: ScalarValue[],
): string | null => {
  const compile = (node: FreeObjectExpr): string | null => {
    if (node.kind === "literal") {
      params.push(encodeParam(node.value));
      return "?";
    }
    if (node.kind === "field_access") {
      const tail = extractFreePathTail(node);
      if (!tail) return null;
      if (tail.linkProperty !== undefined) {
        if (!linkPropertyAlias) return null;
        return `${linkPropertyAlias}.${quoteIdent(tail.linkProperty)}`;
      }
      if (tail.fields.length === 0) return null;
      const last = tail.fields[tail.fields.length - 1];
      return `${sourceAlias}.${quoteIdent(last)}`;
    }
    if (node.kind === "compare") {
      const left = compile(node.left);
      const right = compile(node.right);
      const op = operatorToSqlInfix(node.op);
      if (!left || !right || !op) return null;
      return `(${left} ${op} ${right})`;
    }
    if (node.kind === "logical") {
      const left = compile(node.left);
      const right = compile(node.right);
      if (!left || !right) return null;
      return `(${left} ${node.op === "and" ? "AND" : "OR"} ${right})`;
    }
    if (node.kind === "and") {
      const left = compile(node.left);
      const right = compile(node.right);
      if (!left || !right) return null;
      return `(${left} AND ${right})`;
    }
    if (node.kind === "or") {
      const left = compile(node.left);
      const right = compile(node.right);
      if (!left || !right) return null;
      return `(${left} OR ${right})`;
    }
    if (node.kind === "not") {
      const inner = compile(node.expr);
      if (!inner) return null;
      return `(NOT ${inner})`;
    }
    if (node.kind === "unary") {
      const inner = compile(node.expr);
      if (!inner) return null;
      if (node.op === "not") return `(NOT ${inner})`;
      if (node.op === "neg") return `(-${inner})`;
      return null;
    }
    if (node.kind === "math") {
      const left = compile(node.left);
      const right = compile(node.right);
      if (!left || !right) return null;
      return `(${left} ${node.op} ${right})`;
    }
    if (node.kind === "if_else") {
      const cond = compile(node.condition);
      const then = compile(node.thenExpr);
      const other = compile(node.elseExpr);
      if (!cond || !then || !other) return null;
      return `(CASE WHEN ${cond} THEN ${then} ELSE ${other} END)`;
    }
    if (node.kind === "cast") {
      return compile(node.expr);
    }
    return null;
  };

  const checkpoint = params.length;
  const result = compile(expr);
  if (!result) {
    params.length = checkpoint;
    return null;
  }
  return `json(CASE WHEN ${result} THEN 'true' ELSE 'false' END)`;
};

/**
 * Compile a shape-level computed `FreeObjectExpr` to a *scalar* SQL value
 * (not a JSON-wrapped boolean cast).
 *
 * Field accesses against the implicit subject (e.g. `.cost` via `current_item`
 * or `Card.cost` via a self-`SELECT Card { id }`) resolve to the row's
 * column. Field accesses starting with `@` resolve to a link-property column
 * via `linkPropertyAlias`.
 *
 * Returns `null` if any sub-expression can't be lowered.
 */
const compileShapeScalarValueSQL = (
  expr: FreeObjectExpr,
  sourceAlias: string,
  linkPropertyAlias: string | undefined,
  params: ScalarValue[],
): string | null => {
  const isCurrentRow = (node: FreeObjectExpr): boolean => {
    if (node.kind === "current_item") return true;
    if (node.kind === "select" && node.shape.length <= 1) return true;
    if (node.kind === "select_expr_subquery") return isCurrentRow(node.expr);
    return false;
  };

  const compile = (node: FreeObjectExpr): string | null => {
    if (node.kind === "literal") {
      if (node.value === null) {
        return "NULL";
      }
      params.push(encodeParam(node.value));
      return "?";
    }
    if (node.kind === "field_access") {
      if (node.field.startsWith("@")) {
        const alias = linkPropertyAlias;
        if (!alias) return null;
        return `${alias}.${quoteIdent(node.field.slice(1))}`;
      }
      if (isCurrentRow(node.expr)) {
        return `${sourceAlias}.${quoteIdent(node.field)}`;
      }
      return null;
    }
    if (node.kind === "math") {
      const left = compile(node.left);
      const right = compile(node.right);
      if (!left || !right) return null;
      const op = node.op === "//" ? "/" : node.op;
      return `(${left} ${op} ${right})`;
    }
    if (node.kind === "unary") {
      const inner = compile(node.expr);
      if (!inner) return null;
      if (node.op === "neg") return `(-${inner})`;
      if (node.op === "not") return `(NOT ${inner})`;
      return null;
    }
    if (node.kind === "compare") {
      const left = compile(node.left);
      const right = compile(node.right);
      const op = operatorToSqlInfix(node.op);
      if (!left || !right || !op) return null;
      return `(${left} ${op} ${right})`;
    }
    if (node.kind === "logical" || node.kind === "and" || node.kind === "or") {
      const opName = node.kind === "logical" ? node.op : node.kind;
      const left = compile(node.left);
      const right = compile(node.right);
      if (!left || !right) return null;
      return `(${left} ${opName === "and" ? "AND" : "OR"} ${right})`;
    }
    if (node.kind === "not") {
      const inner = compile(node.expr);
      if (!inner) return null;
      return `(NOT ${inner})`;
    }
    if (node.kind === "if_else") {
      const cond = compile(node.condition);
      const thenSql = compile(node.thenExpr);
      const elseSql = compile(node.elseExpr);
      if (!cond || !thenSql || !elseSql) return null;
      return `(CASE WHEN ${cond} THEN ${thenSql} ELSE ${elseSql} END)`;
    }
    if (node.kind === "coalesce") {
      const left = compile(node.left);
      const right = compile(node.right);
      if (!left || !right) return null;
      return `COALESCE(${left}, ${right})`;
    }
    if (node.kind === "concat") {
      const parts = node.parts.map((p) => compile(p));
      if (parts.some((p) => p === null)) return null;
      return `(${(parts as string[]).map((p) => `COALESCE(CAST(${p} AS TEXT), '')`).join(" || ")})`;
    }
    if (node.kind === "cast") {
      return compile(node.expr);
    }
    if (node.kind === "select_expr_subquery") {
      return compile(node.expr);
    }
    return null;
  };

  const checkpoint = params.length;
  const result = compile(expr);
  if (!result) {
    params.length = checkpoint;
    return null;
  }
  return result;
};

/**
 * Collect the names of columns on the implicit subject row that a shape-level
 * scalar expression references (i.e. fields accessed through `current_item` or
 * a self-`SELECT`). Link-property references (`@x`) are not included — those
 * come from the junction alias, not the subject row.
 */
const collectShapeScalarValueColumns = (expr: FreeObjectExpr): string[] => {
  const isCurrentRow = (node: FreeObjectExpr): boolean => {
    if (node.kind === "current_item") return true;
    if (node.kind === "select" && node.shape.length <= 1) return true;
    if (node.kind === "select_expr_subquery") return isCurrentRow(node.expr);
    return false;
  };
  const out: string[] = [];
  const walk = (node: FreeObjectExpr): void => {
    if (node.kind === "field_access") {
      if (!node.field.startsWith("@") && isCurrentRow(node.expr)) {
        out.push(node.field);
      } else {
        walk(node.expr);
      }
      return;
    }
    if (node.kind === "math" || node.kind === "compare" || node.kind === "and" || node.kind === "or" || node.kind === "logical" || node.kind === "coalesce") {
      walk(node.left);
      walk(node.right);
      return;
    }
    if (node.kind === "unary" || node.kind === "not" || node.kind === "cast" || node.kind === "select_expr_subquery") {
      walk(node.expr);
      return;
    }
    if (node.kind === "if_else") {
      walk(node.condition);
      walk(node.thenExpr);
      walk(node.elseExpr);
      return;
    }
    if (node.kind === "concat") {
      for (const part of node.parts) walk(part);
    }
  };
  walk(expr);
  return out;
};

const compileShapeObjectExpr = (
  shape: SelectShapeElementIR[],
  sourceAlias: string,
  sourceTypeExpr: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  linkPropertyAlias?: string,
  computedLinkProperties: ComputedLinkPropertyDef[] = [],
): string => {
  const pairs: string[] = [];
  const computedLinkPropertyByName = new Map(computedLinkProperties.map((property) => [property.name, property] as const));

  for (const element of shape) {
    pairs.push(quoteLiteral(element.name));

    if (element.kind === "field") {
      pairs.push(`${sourceAlias}.${quoteIdent(element.column)}`);
      continue;
    }

    if (element.kind === "computed") {
      if (element.expr.kind === "field_ref") {
        const linkPropertyName = element.expr.column.startsWith("@") ? element.expr.column.slice(1) : undefined;
        const computedLinkProperty = linkPropertyName ? computedLinkPropertyByName.get(linkPropertyName) : undefined;
        if (computedLinkProperty && linkPropertyAlias) {
          pairs.push(compileComputedLinkPropertyExprSQL(computedLinkProperty.computedExpr, sourceAlias, linkPropertyAlias, params));
          continue;
        }
        pairs.push(filterColumnSql(element.expr.column, sourceAlias, linkPropertyAlias));
      } else if (element.expr.kind === "literal") {
        if (linkPropertyAlias && element.name.startsWith("@")) {
          pairs.push(`${linkPropertyAlias}.${quoteIdent(element.name.slice(1))}`);
          continue;
        }

        pairs.push("?");
        params.push(encodeParam(element.expr.value));
      } else if (element.expr.kind === "set_literal") {
        const placeholders = element.expr.values.map(() => "?");
        params.push(...element.expr.values.map(encodeParam));
        pairs.push(`json_array(${placeholders.join(", ")})`);
      } else if (element.expr.kind === "polymorphic_field_ref") {
        const concretes = element.expr.concreteSourceTypes && element.expr.concreteSourceTypes.length > 0
          ? element.expr.concreteSourceTypes
          : [element.expr.sourceType];
        const matchCondition = concretes.length === 1
          ? `${sourceTypeExpr} = ${quoteLiteral(concretes[0])}`
          : `${sourceTypeExpr} IN (${concretes.map(quoteLiteral).join(", ")})`;
        pairs.push(
          `CASE WHEN ${matchCondition} THEN ${sourceAlias}.${quoteIdent(element.expr.column)} ELSE NULL END`,
        );
      } else if (element.expr.kind === "type_name") {
        pairs.push(sourceTypeExpr);
      } else if (element.expr.kind === "is_type") {
        if (element.expr.concreteSourceTypes.length === 0) {
          pairs.push("0");
        } else {
          const list = element.expr.concreteSourceTypes.map(quoteLiteral).join(", ");
          pairs.push(`CASE WHEN ${sourceTypeExpr} IN (${list}) THEN 1 ELSE 0 END`);
        }
      } else if (element.expr.kind === "concat") {
        const sqlParts = element.expr.parts.map((part) => {
          if (part.kind === "field_ref") {
            return `COALESCE(${filterColumnSql(part.column, sourceAlias, linkPropertyAlias)}, '')`;
          }

          params.push(encodeParam(part.value));
          return "COALESCE(?, '')";
        });
        pairs.push(sqlParts.length === 0 ? "''" : `(${sqlParts.join(" || ")})`);
      } else if (element.expr.kind === "function_call") {
        const lowered = compileStdlibFunctionCallSQL(element.expr, sourceAlias, params, target);
        pairs.push(lowered ?? "json('[]')");
      } else if (element.expr.kind === "link_aggregate") {
        pairs.push(compileLinkAggregateExpr(element.expr, sourceAlias));
      } else if (element.expr.kind === "select_expr") {
        const scalar = compileShapeScalarValueSQL(
          element.expr.expr,
          sourceAlias,
          linkPropertyAlias,
          params,
        );
        if (scalar) {
          pairs.push(scalar);
        } else {
          const lowered = compileShapeComputedFreeExprSQL(
            element.expr.expr,
            sourceAlias,
            linkPropertyAlias,
            params,
          );
          pairs.push(lowered ?? "json('[]')");
        }
      } else {
        pairs.push("json('[]')");
      }

      continue;
    }

    if (element.kind === "link") {
      const linkArrayExpr = compileLinkArrayExpr(element, sourceAlias, params, target);
      if (element.relation.multi) {
        pairs.push(`json(${linkArrayExpr})`);
      } else {
        pairs.push(`json(COALESCE(json_extract(${linkArrayExpr}, '$[0]'), 'null'))`);
      }
      continue;
    }

    pairs.push(`json(${compileBacklinkArrayExpr(element, sourceAlias, params, target)})`);
  }

  return `json_object(${pairs.join(", ")})`;
};

const compileComputedLinkPropertyExprSQL = (
  expr: ComputedLinkPropertyExpr,
  targetAlias: string,
  linkAlias: string,
  params: ScalarValue[],
): string => {
  if (expr.kind === "literal") {
    params.push(encodeParam(expr.value));
    return "?";
  }

  if (expr.kind === "field_ref") {
    return `${targetAlias}.${quoteIdent(expr.name)}`;
  }

  if (expr.kind === "link_property_ref") {
    return `${linkAlias}.${quoteIdent(expr.name)}`;
  }

  const left = compileComputedLinkPropertyExprSQL(expr.left, targetAlias, linkAlias, params);
  const right = compileComputedLinkPropertyExprSQL(expr.right, targetAlias, linkAlias, params);
  if (expr.op === "++") {
    return `(COALESCE(${left}, '') || COALESCE(${right}, ''))`;
  }
  if (expr.op === "??") {
    return `COALESCE(${left}, ${right})`;
  }
  return `(${left} ${expr.op} ${right})`;
};

const collectComputedLinkPropertyTargetColumns = (expr: ComputedLinkPropertyExpr): string[] => {
  if (expr.kind === "field_ref") {
    return [expr.name];
  }
  if (expr.kind === "binary_op") {
    return [
      ...collectComputedLinkPropertyTargetColumns(expr.left),
      ...collectComputedLinkPropertyTargetColumns(expr.right),
    ];
  }
  return [];
};

const resolvePathIdStr = (pathId: string | PathIdIR): string =>
  typeof pathId === "string" ? pathId : pathId.id;

export const shapePayloadAlias = (pathId: string | PathIdIR): string =>
  `__shape_${sanitizePathId(pathId)}`;

export const computedValueAlias = (pathId: string | PathIdIR): string =>
  `__computed_${sanitizePathId(pathId)}`;

const sanitizePathId = (pathId: string | PathIdIR): string =>
  resolvePathIdStr(pathId).replaceAll(".", "_");

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

/**
 * Returns a FROM-source fragment for the junction table of a multi-link.
 *
 * Polymorphic ownership means a link declared on an abstract or base type
 * lives in different per-subtype tables (e.g. `default__v__l_a` carries
 * data for `S.l_a` when only V instances exist). When the relation's
 * `linkTables` list has more than one entry, this UNION ALLs them so the
 * query sees the combined junction across every subtype. The result is
 * aliased so callers can JOIN ... ON `alias.source` / `alias.target` /
 * link-property columns as if they had a single table.
 *
 * `rowid` is projected so callers can preserve insertion order via
 * `ORDER BY junction.rowid` like they would for a single physical table.
 */
const linkJunctionFrom = (
  relation: LinkRelationIR,
  alias: string,
): string => {
  const tables = relation.linkTables && relation.linkTables.length > 0
    ? relation.linkTables.map((entry) => entry.table)
    : relation.linkTable
      ? [relation.linkTable]
      : (() => {
          throw new AppError("E_SQL", "Missing link table metadata");
        })();
  if (tables.length === 1) {
    return `${quoteIdent(tables[0]!)} ${alias}`;
  }
  const projection = ["source", "target", ...(relation.propertyColumns ?? [])]
    .map((column) => quoteIdent(column))
    .join(", ");
  const parts = tables.map((table) => `SELECT ${projection}, rowid AS ${quoteIdent("rowid")} FROM ${quoteIdent(table)}`);
  return `(${parts.join(" UNION ALL ")}) ${alias}`;
};

const requiredAlias = (value: string | undefined): string => {
  if (!value) {
    throw new AppError("E_SQL", "Missing SQL alias metadata");
  }

  return value;
};

const compileLinkAggregateExpr = (
  expr: Extract<Extract<SelectShapeElementIR, { kind: "computed" }>["expr"], { kind: "link_aggregate" }>,
  sourceAlias: string,
): string => {
  const targetAlias = `a_${Math.abs(hashString(`${sourceAlias}:${expr.relation.sourceType}:${expr.relation.targetType}:${expr.column}`)).toString(16)}`;
  const relation = expr.relation;
  const linkPropertyColumns = new Set(relation.propertyColumns ?? []);
  const aggregateUsesLinkProperty = relation.storage === "table" && linkPropertyColumns.has(expr.column);
  let fromClause = compilePolymorphicTargetSource(relation, targetAlias, aggregateUsesLinkProperty ? [] : [expr.column]);
  let whereClause: string;
  let aggregateColumn = `${targetAlias}.${quoteIdent(expr.column)}`;

  if (relation.storage === "inline") {
    whereClause = `${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(requiredInlineColumn(relation.inlineColumn))}`;
  } else {
    const junctionAlias = linkAggregateJunctionAlias(relation, sourceAlias);
    fromClause = `${fromClause} JOIN ${linkJunctionFrom(relation, junctionAlias)} ON ${junctionAlias}.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")}`;
    whereClause = `${junctionAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`;
    if (aggregateUsesLinkProperty) {
      aggregateColumn = `${junctionAlias}.${quoteIdent(expr.column)}`;
    }
  }

  return `COALESCE((SELECT SUM(${aggregateColumn}) FROM ${fromClause} WHERE ${whereClause}), 0)`;
};

const linkAggregateJunctionAlias = (relation: LinkRelationIR, sourceAlias: string): string =>
  `aj_${Math.abs(hashString(`${sourceAlias}:${relation.sourceType}:${relation.targetType}`)).toString(16)}`;

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

const compileFilterPredicate = (lhsSql: string, op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike"): string => {
  if (op === "=") {
    return `${lhsSql} = ?`;
  }

  if (op === "!=") {
    return `${lhsSql} != ?`;
  }

  if (op === "like") {
    return `${lhsSql} LIKE ?`;
  }

  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    return `${lhsSql} ${op} ?`;
  }

  if (op === "?=") {
    return `(${lhsSql} IS NULL OR ${lhsSql} = ?)`;
  }

  if (op === "?!=") {
    return `(${lhsSql} IS NULL OR ${lhsSql} != ?)`;
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
    const sourceTables = source.sourceTables && source.sourceTables.length > 0
      ? source.sourceTables
      : [{ name: source.sourceType, table: source.table }];
    const sourceFrom = sourceTables.length === 1
      ? `${quoteIdent(sourceTables[0].table)} s`
      : `(${sourceTables.map((entry) => `SELECT ${quoteLiteral(entry.name)} AS ${quoteIdent("__source_type")}, * FROM ${quoteIdent(entry.table)}`).join(" UNION ALL ")}) s`;

    if (source.storage === "inline") {
      params.push(encodeParam(filter.value));
      return `EXISTS (SELECT 1 FROM ${sourceFrom} WHERE s.${quoteIdent(requiredInlineColumn(source.inlineColumn))} = ${rootAlias}.${quoteIdent("id")} AND s.${quoteIdent("id")} = ?)`;
    }

    params.push(encodeParam(filter.value));
    return `EXISTS (SELECT 1 FROM ${sourceFrom} JOIN ${quoteIdent(requiredLinkTable(source.linkTable))} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ${rootAlias}.${quoteIdent("id")} AND s.${quoteIdent("id")} = ?)`;
  });

  if (clauses.length === 0) {
    return filter.op === "=" ? "0" : "1";
  }

  return filter.op === "=" ? `(${clauses.join(" OR ")})` : `NOT (${clauses.join(" OR ")})`;
};

const filterColumnSql = (column: string, sourceAlias: string, linkPropertyAlias?: string): string => {
  if (column.startsWith("@")) {
    const alias = linkPropertyAlias ?? sourceAlias;
    return `${alias}.${quoteIdent(column.slice(1))}`;
  }

  if (column === "__type__.name") {
    return `${sourceAlias}.${quoteIdent("__source_type")}`;
  }

  return `${sourceAlias}.${quoteIdent(column)}`;
};

const compileFilterExprSQL = (
  filter: FilterExprIR,
  sourceAlias: string,
  params: ScalarValue[],
  linkPropertyAlias?: string,
): string => {
  if (filter.kind === "field") {
    params.push(encodeParam(filter.value));
    return compileFilterPredicate(filterColumnSql(filter.column, sourceAlias, linkPropertyAlias), filter.op);
  }

  if (filter.kind === "field_in") {
    const column = filterColumnSql(filter.column, sourceAlias, linkPropertyAlias);
    const placeholders = filter.values.map(() => "?").join(", ");
    const encodedValues = filter.values.map((v) => encodeParam(v));
    params.push(...encodedValues);
    const op = filter.op === "in" ? "IN" : "NOT IN";
    return `${column} ${op} (${placeholders})`;
  }

  if (filter.kind === "self_in_select") {
    const sourceAliasInner = "s_in";
    const filterColumns = collectFieldFilterColumns(filter.filter).filter((column) => column !== "id");
    const projectedColumns = [quoteIdent("id"), ...filterColumns.map((column) => quoteIdent(column))];
    const sourceSelects = filter.sourceTables.map(
      (source) => `SELECT ${quoteLiteral(source.name)} AS ${quoteIdent("__source_type")}, ${projectedColumns.join(", ")} FROM ${quoteIdent(source.table)}`,
    );
    const subqueryFrom = `(${sourceSelects.join(" UNION ALL ")}) ${sourceAliasInner}`;
    const where = filter.filter
      ? ` WHERE ${compileFilterExprSQL(filter.filter, sourceAliasInner, params)}`
      : "";
    const op = filter.op === "in" ? "IN" : "NOT IN";
    return `${sourceAlias}.${quoteIdent("id")} ${op} (SELECT ${sourceAliasInner}.${quoteIdent("id")} FROM ${subqueryFrom}${where})`;
  }

  if (filter.kind === "backlink_contains") {
    const clauses = filter.sources.map((source) => {
      const sourceTables = source.sourceTables && source.sourceTables.length > 0
        ? source.sourceTables
        : [{ name: source.sourceType, table: source.table }];
      const sourceFrom = sourceTables.length === 1
        ? `${quoteIdent(sourceTables[0].table)} s`
        : `(${sourceTables.map((entry) => `SELECT ${quoteLiteral(entry.name)} AS ${quoteIdent("__source_type")}, * FROM ${quoteIdent(entry.table)}`).join(" UNION ALL ")}) s`;

      params.push(encodeParam(filter.value));
      if (source.storage === "inline") {
        return `EXISTS (SELECT 1 FROM ${sourceFrom} WHERE s.${quoteIdent(requiredInlineColumn(source.inlineColumn))} = ${sourceAlias}.${quoteIdent("id")} AND s.${quoteIdent(filter.column)} = ?)`;
      }

      return `EXISTS (SELECT 1 FROM ${sourceFrom} JOIN ${quoteIdent(requiredLinkTable(source.linkTable))} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")} AND s.${quoteIdent(filter.column)} = ?)`;
    });

    if (clauses.length === 0) {
      return filter.op === "in" ? "0" : "1";
    }

    return filter.op === "in" ? `(${clauses.join(" OR ")})` : `NOT (${clauses.join(" OR ")})`;
  }

  if (filter.kind === "field_compare") {
    const left = filterColumnSql(filter.leftColumn, sourceAlias, linkPropertyAlias);
    const right = filterColumnSql(filter.rightColumn, sourceAlias, linkPropertyAlias);
    if (filter.op === "=") {
      return `${left} = ${right}`;
    }
    if (filter.op === "!=") {
      return `${left} != ${right}`;
    }
    if (filter.op === "like") {
      return `${left} LIKE ${right}`;
    }
    return `LOWER(${left}) LIKE LOWER(${right})`;
  }

  if (filter.kind === "backlink") {
    return compileBacklinkFilterPredicate(sourceAlias, filter, params);
  }

  if (filter.kind === "link_property_exists") {
    if (filter.relation.storage !== "table" || !filter.relation.linkTable) {
      return "0";
    }
    const alias = `lp_${Math.abs(hashString(`${filter.relation.sourceType}:${filter.relation.linkTable}:${filter.property}`)).toString(16)}`;
    return `EXISTS (SELECT 1 FROM ${linkJunctionFrom(filter.relation, alias)} WHERE ${alias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")} AND ${alias}.${quoteIdent(filter.property)} IS NOT NULL)`;
  }

  if (filter.kind === "link_property_compare_exists") {
    if (filter.relation.storage !== "table" || !filter.relation.linkTable) {
      return "0";
    }
    const relationAlias = `lp_${Math.abs(hashString(`${filter.relation.sourceType}:${filter.relation.linkTable}:${filter.property}:${filter.targetColumn}`)).toString(16)}`;
    const clauses = (filter.relation.targetTables.length > 0 ? filter.relation.targetTables : [{ name: filter.relation.targetType, table: filter.relation.targetTable }]).map((target, index) => {
      const targetAlias = `${relationAlias}_t${index}`;
      const left = `${targetAlias}.${quoteIdent(filter.targetColumn)}`;
      const right = `${relationAlias}.${quoteIdent(filter.property)}`;
      const comparison = filter.op === "="
        ? `${left} = ${right}`
        : filter.op === "!="
          ? `${left} != ${right}`
          : filter.op === "like"
            ? `${left} LIKE ${right}`
            : `LOWER(${left}) LIKE LOWER(${right})`;
      return `EXISTS (SELECT 1 FROM ${linkJunctionFrom(filter.relation, relationAlias)} JOIN ${quoteIdent(target.table)} ${targetAlias} ON ${targetAlias}.${quoteIdent("id")} = ${relationAlias}.${quoteIdent("target")} WHERE ${relationAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")} AND ${comparison})`;
    });
    return clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`;
  }

  if (filter.kind === "link_target_field_compare") {
    const targets = filter.relation.targetTables.length > 0
      ? filter.relation.targetTables
      : [{ name: filter.relation.targetType, table: filter.relation.targetTable }];
    const relationAlias = `lt_${Math.abs(hashString(`${filter.relation.sourceType}:${filter.relation.targetType}:${filter.targetColumn}`)).toString(16)}`;
    const clauses = targets.map((target, index) => {
      const targetAlias = `${relationAlias}_t${index}`;
      const column = `${targetAlias}.${quoteIdent(filter.targetColumn)}`;
      params.push(encodeParam(filter.value));
      const predicate = compileFilterPredicate(column, filter.op);
      if (filter.relation.storage === "inline") {
        const inlineColumn = filter.relation.inlineColumn ?? `${filter.relation.targetType.split("::").at(-1)?.toLowerCase()}_id`;
        return `EXISTS (SELECT 1 FROM ${quoteIdent(target.table)} ${targetAlias} WHERE ${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(inlineColumn)} AND ${predicate})`;
      }
      return `EXISTS (SELECT 1 FROM ${linkJunctionFrom(filter.relation, relationAlias)} JOIN ${quoteIdent(target.table)} ${targetAlias} ON ${targetAlias}.${quoteIdent("id")} = ${relationAlias}.${quoteIdent("target")} WHERE ${relationAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")} AND ${predicate})`;
    });
    if (clauses.length === 0) return "0";
    return clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`;
  }

  if (filter.kind === "backlink_property_compare" || filter.kind === "backlink_property_in") {
    const clauses = filter.sources
      .filter((source) => source.storage === "table" && source.linkTable)
      .map((source, index) => {
        const alias = `bp_${index}`;
        const left = `${sourceAlias}.${quoteIdent(filter.column)}`;
        const right = `${alias}.${quoteIdent(filter.property)}`;
        const comparison = filter.kind === "backlink_property_in"
          ? `${left} ${filter.op === "in" ? "IN" : "NOT IN"} (SELECT ${right} FROM ${quoteIdent(source.linkTable!)} ${alias} WHERE ${alias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")} AND ${right} IS NOT NULL)`
          : `EXISTS (SELECT 1 FROM ${quoteIdent(source.linkTable!)} ${alias} WHERE ${alias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")} AND ${(
              filter.op === "="
                ? `${left} = ${right}`
                : filter.op === "!="
                  ? `${left} != ${right}`
                  : filter.op === "like"
                    ? `${left} LIKE ${right}`
                    : `LOWER(${left}) LIKE LOWER(${right})`
            )})`;
        return comparison;
      });
    if (clauses.length === 0) {
      return filter.kind === "backlink_property_in" && filter.op === "not_in" ? "1" : "0";
    }
    return filter.kind === "backlink_property_in" && filter.op === "not_in" ? `(${clauses.join(" AND ")})` : `(${clauses.join(" OR ")})`;
  }

  if (filter.kind === "backlink_property_value_compare") {
    const clauses = filter.sources
      .filter((source) => source.storage === "table" && source.linkTable)
      .map((source, index) => {
        const alias = `bpv_${index}`;
        const column = `${alias}.${quoteIdent(filter.property)}`;
        params.push(encodeParam(filter.value));
        return `EXISTS (SELECT 1 FROM ${quoteIdent(source.linkTable!)} ${alias} WHERE ${alias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")} AND ${compileFilterPredicate(column, filter.op)})`;
      });
    if (clauses.length === 0) {
      return "0";
    }
    return `(${clauses.join(" OR ")})`;
  }

  if (filter.kind === "not") {
    return `(NOT ${compileFilterExprSQL(filter.expr, sourceAlias, params, linkPropertyAlias)})`;
  }

  if (filter.kind === "expr_compare") {
    const isNullLiteral = (e: import("../ir/model.js").ScalarExprIR): boolean =>
      e.kind === "literal" && e.value === null;
    if ((filter.op === "=" || filter.op === "!=") && (isNullLiteral(filter.left) || isNullLiteral(filter.right))) {
      const nonNullSide = isNullLiteral(filter.left) ? filter.right : filter.left;
      const sql = compileScalarExprSQL(nonNullSide, sourceAlias, params);
      return filter.op === "=" ? `(${sql} IS NULL)` : `(${sql} IS NOT NULL)`;
    }
    const left = compileScalarExprSQL(filter.left, sourceAlias, params);
    const right = compileScalarExprSQL(filter.right, sourceAlias, params);
    return `(${left} ${filter.op} ${right})`;
  }

  const left = compileFilterExprSQL(filter.left, sourceAlias, params, linkPropertyAlias);
  const right = compileFilterExprSQL(filter.right, sourceAlias, params, linkPropertyAlias);
  return filter.kind === "and" ? `(${left} AND ${right})` : `(${left} OR ${right})`;
};

const compileScalarExprSQL = (
  expr: import("../ir/model.js").ScalarExprIR,
  sourceAlias: string,
  params: ScalarValue[],
): string => {
  if (expr.kind === "column") {
    return `${sourceAlias}.${quoteIdent(expr.column)}`;
  }
  if (expr.kind === "literal") {
    params.push(encodeParam(expr.value));
    return "?";
  }
  if (expr.kind === "neg") {
    return `(-${compileScalarExprSQL(expr.expr, sourceAlias, params)})`;
  }
  if (expr.kind === "index_access") {
    const inner = compileScalarExprSQL(expr.value, sourceAlias, params);
    return `substr(${inner}, ${expr.index + 1}, 1)`;
  }
  const leftSql = compileScalarExprSQL(expr.left, sourceAlias, params);
  const rightSql = compileScalarExprSQL(expr.right, sourceAlias, params);
  if (expr.op === "//") {
    // SQLite has no integer-division operator; emit CAST(left / right AS INTEGER).
    return `(CAST(${leftSql} / ${rightSql} AS INTEGER))`;
  }
  if (expr.op === "++") {
    return `(${leftSql} || ${rightSql})`;
  }
  return `(${leftSql} ${expr.op} ${rightSql})`;
};

const collectFieldFilterColumns = (filter: FilterExprIR | undefined): string[] => {
  if (!filter) {
    return [];
  }

  if (filter.kind === "field") {
    return [filter.column];
  }

  if (filter.kind === "field_in") {
    return [filter.column];
  }

  if (filter.kind === "field_compare") {
    return [filter.leftColumn, filter.rightColumn];
  }

  if (filter.kind === "backlink") {
    return [];
  }

  if (filter.kind === "self_in_select") {
    return [];
  }

  if (filter.kind === "backlink_contains") {
    return [];
  }

  if (filter.kind === "link_property_exists") {
    return [];
  }

  if (filter.kind === "link_property_compare_exists") {
    return [];
  }

  if (filter.kind === "link_target_field_compare") {
    return filter.relation.storage === "inline" && filter.relation.inlineColumn
      ? [filter.relation.inlineColumn]
      : [];
  }

  if (filter.kind === "backlink_property_compare" || filter.kind === "backlink_property_in") {
    return [filter.column];
  }

  if (filter.kind === "backlink_property_value_compare") {
    return [];
  }

  if (filter.kind === "not") {
    return collectFieldFilterColumns(filter.expr);
  }

  if (filter.kind === "expr_compare") {
    return [...collectScalarExprColumns(filter.left), ...collectScalarExprColumns(filter.right)];
  }

  return [...collectFieldFilterColumns(filter.left), ...collectFieldFilterColumns(filter.right)];
};

const collectScalarExprColumns = (expr: import("../ir/model.js").ScalarExprIR): string[] => {
  if (expr.kind === "column") return [expr.column];
  if (expr.kind === "literal") return [];
  if (expr.kind === "neg") return collectScalarExprColumns(expr.expr);
  if (expr.kind === "index_access") return collectScalarExprColumns(expr.value);
  return [...collectScalarExprColumns(expr.left), ...collectScalarExprColumns(expr.right)];
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

    if (element.kind === "link") {
      if (shapeRequiresFallbackLowering(element.shape, target)) {
        return true;
      }
    }
  }

  return false;
};

type FunctionCallExprIR = Extract<Extract<SelectShapeElementIR, { kind: "computed" }>["expr"], { kind: "function_call" }>;
type FunctionCallArgIR = FunctionCallExprIR["args"][number];
type SelectFreeEntryIR = SelectFreeIR["entries"][number];
type SelectFreeFunctionCallEntryIR = Extract<SelectFreeEntryIR, { kind: "function_call" }>;
type SelectFreeFunctionArgIR = SelectFreeFunctionCallEntryIR["args"][number];

const compileSelectFreeEntrySQL = (
  entry: SelectFreeEntryIR,
  params: ScalarValue[],
  target: RuntimeTarget,
): string | null => {
  if (entry.kind === "literal") {
    if (typeof entry.value === "boolean") {
      return null;
    }

    params.push(encodeParam(entry.value));
    return "?";
  }

  if (entry.kind === "enum_path") {
    params.push(entry.member);
    return "?";
  }

  if (entry.kind === "cast") {
    const valueSql = compileSelectFreeEntrySQL(entry.value, params, target);
    if (!valueSql) {
      return null;
    }

    const sqlType = sqlCastType(entry.castType);
    return sqlType ? `CAST(${valueSql} AS ${sqlType})` : null;
  }

  if (entry.kind === "concat") {
    const parts = entry.parts.map((part) => compileSelectFreeEntrySQL(part, params, target));
    if (parts.some((part) => part === null)) {
      return null;
    }

    return parts.length === 0 ? "''" : `(${(parts as string[]).map((part) => `COALESCE(CAST(${part} AS TEXT), '')`).join(" || ")})`;
  }

  if (entry.kind === "function_call") {
    return compileSelectFreeFunctionCallSQL(entry, params, target);
  }

  return null;
};

const compileSelectFreeFunctionCallSQL = (
  expr: SelectFreeFunctionCallEntryIR,
  params: ScalarValue[],
  target: RuntimeTarget,
): string | null => {
  if (!canLowerSelectFreeFunctionCall(expr, target)) {
    return null;
  }

  const args = expr.args.map((arg) => compileSelectFreeFunctionArgSQL(arg, params, target));
  if (args.some((arg) => arg === null)) {
    return null;
  }

  return lowerStdlibFunctionSql(target, expr.functionName, args as string[]);
};

const canLowerSelectFreeFunctionCall = (expr: SelectFreeFunctionCallEntryIR, target: RuntimeTarget): boolean => {
  if (!isLowerableStdlibFunctionName(expr.functionName, target)) {
    return false;
  }

  return expr.args.every((arg) => canLowerSelectFreeFunctionArg(arg, target));
};

const canLowerSelectFreeFunctionArg = (arg: SelectFreeFunctionArgIR, target: RuntimeTarget): boolean => {
  if (arg.kind === "literal") {
    return typeof arg.value !== "boolean";
  }

  if (arg.kind === "function_call") {
    return canLowerSelectFreeFunctionCall(arg as SelectFreeFunctionCallEntryIR, target);
  }

  return false;
};

const compileSelectFreeFunctionArgSQL = (
  arg: SelectFreeFunctionArgIR,
  params: ScalarValue[],
  target: RuntimeTarget,
): string | null => {
  if (arg.kind === "literal") {
    if (typeof arg.value === "boolean") {
      return null;
    }

    params.push(encodeParam(arg.value));
    return "?";
  }

  if (arg.kind === "function_call") {
    return compileSelectFreeFunctionCallSQL(arg as SelectFreeFunctionCallEntryIR, params, target);
  }

  return null;
};

const sqlCastType = (castType: string): string | null => {
  if (castType === "std::str" || castType === "str") {
    return "TEXT";
  }

  if (castType === "std::int" || castType === "int" || castType === "std::int64" || castType === "int64") {
    return "INTEGER";
  }

  if (castType === "std::float" || castType === "float" || castType === "std::float64" || castType === "float64") {
    return "REAL";
  }

  return null;
};

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

  return lowerStdlibFunctionSql(target, expr.functionName, args as string[]);
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
  canLowerStdlibFunctionSql(target, functionName);

const compilePolymorphicTargetSource = (
  relation: Extract<SelectShapeElementIR, { kind: "link" }>["relation"],
  alias: string,
  requiredColumns: string[],
): string => {
  const targets = relation.targetTables.length > 0
    ? relation.targetTables
    : [{ name: relation.targetType, table: relation.targetTable }];

  const columns = [...new Set(["id", ...requiredColumns.filter((column) => column !== "__source_type")])];
  const allTargetsDeclareColumns = targets.every((target) => target.columns && target.columns.length > 0);
  const projected = (target: (typeof targets)[number]): string => {
    const available = target.columns ? new Set(target.columns) : undefined;
    return columns
      .map((column) =>
        !allTargetsDeclareColumns || available?.has(column)
          ? `${quoteIdent(column)} AS ${quoteIdent(column)}`
          : `NULL AS ${quoteIdent(column)}`)
      .join(", ");
  };

  if (targets.length === 1) {
    const only = targets[0];
    return `(
      SELECT ${quoteLiteral(only.name)} AS ${quoteIdent("__source_type")}, ${projected(only)}
      FROM ${quoteIdent(only.table)}
    ) ${alias}`;
  }

  const selects = targets.map(
    (target) => `SELECT ${quoteLiteral(target.name)} AS ${quoteIdent("__source_type")}, ${projected(target)} FROM ${quoteIdent(target.table)}`,
  );
  return `(${selects.join(" UNION ALL ")}) ${alias}`;
};
