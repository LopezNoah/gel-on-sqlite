import { quoteIdent, quoteLiteral, tableNameForType } from "../codegen/sql.js";
import type { RuntimeTarget } from "../runtime/target.js";
import { lowerStdlibFunctionSql } from "./stdlib_lowering.js";
import type {
  BaseConstant,
  CallArg,
  CoalesceExpr,
  ConfigStmt,
  ExistsExpr,
  DeleteStmt,
  Expr,
  ForExpr,
  FunctionCall,
  GroupStmt,
  IfElseExpr,
  IndexExpr,
  InsertStmt,
  OperatorCall,
  Pointer,
  PointerRef,
  SelectExpr,
  SelectStmt,
  Set,
  ShapeElement,
  SliceExpr,
  SortExpr,
  TypeRoot,
  TypeCheckOpExpr,
  TypeCast,
  TypeRef,
  Tuple,
  UpdateStmt,
} from "../ir/gel_ir.js";
import type { ScalarValue } from "../types.js";

export interface GelIRSQLArtifact {
  sql: string;
  params: ScalarValue[];
  loweringMode: "single_statement" | "fallback_multi_query";
}

export interface GelIRCompileOptions {
  resolveTableName?: (typeName: string) => string;
  maxShapeDepth?: number;
  target?: RuntimeTarget;
  parameterValues?: Record<string, ScalarValue>;
  globalValues?: Record<string, ScalarValue>;
}

export const compileGelIRToSQL = (
  statement: SelectStmt | InsertStmt | UpdateStmt | DeleteStmt | GroupStmt | ConfigStmt,
  options: GelIRCompileOptions = {},
): GelIRSQLArtifact => {
  if (statement.kind === "insert_stmt") {
    return compileInsertStmtToSQL(statement, options);
  }
  if (statement.kind === "update_stmt") {
    return compileUpdateStmtToSQL(statement, options);
  }
  if (statement.kind === "delete_stmt") {
    return compileDeleteStmtToSQL(statement, options);
  }
  if (statement.kind === "group_stmt") {
    return compileGroupStmtToSQL(statement, options);
  }
  if (statement.kind === "config_stmt") {
    return compileConfigStmtToSQL(statement, options);
  }
  const target = options.target ?? "sqlite";
  const params: ScalarValue[] = [];
  const topSelect = unwrapSelectExprSet(statement.expr);
  const selectWhere = statement.where ?? topSelect.selectExpr?.where;
  const selectOrderBy = statement.orderBy ?? topSelect.selectExpr?.orderBy;
  const sourceSet = topSelect.selectExpr ? topSelect.result : unwrapSelectResultSet(statement.expr);
  if (sourceSet?.expr.kind === "for_expr") {
    const projectedColumns = collectForExprProjectedColumns(sourceSet, selectWhere, selectOrderBy);
    const forSource = compileForExprSource(sourceSet, projectedColumns, options);
    const bodySet = innermostForExprBody(sourceSet);
    const bodySql = forSource
      ? compileValueSetSQLWithAliases(bodySet, forSource.bindingAliases, forSource.baseAlias, params, target, options, forSource.linkPropertyAliases)
      : null;

    if (forSource && bodySql) {
      let sql = `SELECT ${bodySql} AS ${quoteIdent("value")} FROM ${forSource.fromSql}`;
      const whereSets = [...forSource.whereSets, ...(selectWhere ? [selectWhere] : [])];
      if (whereSets.length > 0) {
        const whereSql = whereSets
          .map((where) => compilePredicateWithAliases(where, forSource.bindingAliases, params, target, options, forSource.linkPropertyAliases))
          .filter((entry): entry is string => Boolean(entry))
          .join(" AND ");
        if (whereSql) {
          sql += ` WHERE ${whereSql}`;
        }
      }
      const orderBy = selectOrderBy ?? forSource.orderBy;
      if (orderBy && orderBy.length > 0) {
        const orders = orderBy
          .map((order) => compileForExprSort(order, "value"))
          .filter((entry): entry is string => entry.length > 0);
        if (orders.length > 0) {
          sql += ` ORDER BY ${orders.join(", ")}`;
        }
      }
      return { sql, params, loweringMode: "single_statement" };
    }
  }
  const compiledSource = sourceSet ? compileSelectSource(sourceSet, statement.where, statement.orderBy, options) : null;
  if (!compiledSource) {
    if (sourceSet) {
      const scalarSql = compileScalarSelectSQL(sourceSet, params, target, options);
      if (scalarSql) {
        let sql = scalarSql;
        if (selectOrderBy && selectOrderBy.length > 0) {
          const orders = selectOrderBy
            .map((order) => {
              const direction = order.direction.toUpperCase();
              // ORDER BY a reference to the result value column, or any expression
              // referencing the synthesized "value", routes to that column.
              return `${quoteIdent("value")} ${direction}`;
            })
            .filter((entry): entry is string => entry.length > 0);
          if (orders.length > 0) {
            sql += ` ORDER BY ${orders.join(", ")}`;
          }
        }
        return { sql, params, loweringMode: "single_statement" };
      }
    }
    return {
      sql: `SELECT NULL AS ${quoteIdent("id")}, NULL AS ${quoteIdent("__source_type")}`,
      params,
      loweringMode: "single_statement",
    };
  }

  const sourceAlias = compiledSource.alias;
  const sourceSql = compiledSource.sql;

  const projections = [
    `${sourceAlias}.${quoteIdent("id")} AS ${quoteIdent("id")}`,
    `${sourceAlias}.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}`,
  ];

  const sourceShape = sourceSet?.shape ?? [];
  for (const element of sourceShape) {
    const projection = compileShapeProjection(element, sourceAlias, params, options, target, 0);
    if (projection) {
      projections.push(projection);
    }
  }

  let sql = `SELECT ${projections.join(", ")} FROM ${sourceSql}`;

  if (statement.where) {
    const whereSql = compileWhereClause(statement.where, sourceAlias, params, target, options);
    if (whereSql) {
      sql += ` WHERE ${whereSql}`;
    }
  }

  if (statement.orderBy && statement.orderBy.length > 0) {
    const orders = statement.orderBy.map((order) => {
      const orderColumn = compileSetColumnRef(order.path);
      if (!orderColumn) {
        return "";
      }
      return `${sourceAlias}.${quoteIdent(orderColumn)} ${order.direction.toUpperCase()}`;
    }).filter((entry) => entry.length > 0);

    if (orders.length > 0) {
      sql += ` ORDER BY ${orders.join(", ")}`;
    }
  }

  return {
    sql,
    params,
    loweringMode: "single_statement",
  };
};

const compileInsertStmtToSQL = (statement: InsertStmt, options: GelIRCompileOptions): GelIRSQLArtifact => {
  const target = options.target ?? "sqlite";
  const params: ScalarValue[] = [];
  const table = resolveTypeTableName(statement.subject, options);
  const paramsCheckpoint = params.length;
  const assigns = compileDmlAssignments(statement.shape, "new_row", params, target, options);
  if (!assigns) {
    params.length = paramsCheckpoint;
    return {
      sql: `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`,
      params,
      loweringMode: "single_statement",
    };
  }
  if (assigns.columns.length === 0) {
    params.length = paramsCheckpoint;
    return {
      sql: `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`,
      params,
      loweringMode: "single_statement",
    };
  }
  const columns = assigns.columns.map((col) => quoteIdent(col)).join(", ");
  const placeholders = assigns.values.join(", ");
  return {
    sql: `INSERT INTO ${quoteIdent(table)} (${columns}) VALUES (${placeholders})`,
    params,
    loweringMode: "single_statement",
  };
};

const compileUpdateStmtToSQL = (statement: UpdateStmt, options: GelIRCompileOptions): GelIRSQLArtifact => {
  const target = options.target ?? "sqlite";
  const params: ScalarValue[] = [];
  const table = resolveTypeTableName(statement.subject, options);
  const paramsCheckpoint = params.length;
  const assigns = compileDmlAssignments(statement.shape, "g0", params, target, options);
  if (!assigns) {
    params.length = paramsCheckpoint;
  }
  const setClause = !assigns || assigns.columns.length === 0
    ? `${quoteIdent("id")} = ${quoteIdent("id")}`
    : assigns.columns.map((column, idx) => `${quoteIdent(column)} = ${assigns.values[idx]}`).join(", ");
  let sql = `UPDATE ${quoteIdent(table)} AS g0 SET ${setClause}`;
  if (statement.where) {
    const where = compileWhereClause(statement.where, "g0", params, target, options);
    if (!where) {
      sql += " WHERE 0";
      return {
        sql,
        params,
        loweringMode: "single_statement",
      };
    }
    sql += ` WHERE ${where}`;
  }
  return {
    sql,
    params,
    loweringMode: "single_statement",
  };
};

const compileDeleteStmtToSQL = (statement: DeleteStmt, options: GelIRCompileOptions): GelIRSQLArtifact => {
  const target = options.target ?? "sqlite";
  const params: ScalarValue[] = [];
  const table = resolveTypeTableName(statement.subject, options);
  let sql = `DELETE FROM ${quoteIdent(table)}`;
  if (statement.where) {
    const where = compileWhereClause(statement.where, "g0", params, target, options);
    if (!where) {
      sql += " AS g0 WHERE 0";
      return {
        sql,
        params,
        loweringMode: "single_statement",
      };
    }
    sql += ` AS g0 WHERE ${where}`;
  }
  return {
    sql,
    params,
    loweringMode: "single_statement",
  };
};

const compileDmlAssignments = (
  shape: ShapeElement[],
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): { columns: string[]; values: string[] } | null => {
  const columns: string[] = [];
  const values: string[] = [];
  for (const element of shape) {
    const ptr = resolveShapeElementPointer(element);
    if (!ptr || ptr.isLinkProperty) {
      continue;
    }
    if (
      element.cardinality === "many"
      || element.cardinality === "at_least_one"
      || ptr.outCardinality === "many"
      || ptr.outCardinality === "at_least_one"
    ) {
      continue;
    }
    if (containsUnionOperator(element.expr)) {
      const unionSql = compileValueSetSQL(element.expr, sourceAlias, params, target, options);
      if (!unionSql) {
        if (ptr.outTarget.isScalar) {
          return null;
        }
        continue;
      }
      if (ptr.outTarget.isScalar) {
        columns.push(ptr.shortName);
        values.push(unionSql);
      } else {
        columns.push(`${ptr.shortName}_id`);
        values.push(`json_extract(${unionSql}, '$[0].id')`);
      }
      continue;
    }
    const valueSql = compileValueSetSQL(element.expr, sourceAlias, params, target, options);
    if (!valueSql) {
      if (ptr.outTarget.isScalar) {
        return null;
      }
      continue;
    }
    if (ptr.outTarget.isScalar) {
      columns.push(ptr.shortName);
      values.push(valueSql);
      continue;
    }
    columns.push(`${ptr.shortName}_id`);
    values.push(`json_extract(${valueSql}, '$[0].id')`);
  }
  return { columns, values };
};

const containsUnionOperator = (set: Set): boolean => {
  const expr = set.expr;
  if (expr.kind === "operator_call") {
    const op = expr as OperatorCall;
    if (op.operator === "union") {
      return true;
    }
    return orderedCallArgs(op.args).some((arg) => containsUnionOperator(arg.expr));
  }
  if (expr.kind === "type_cast") {
    return containsUnionOperator((expr as TypeCast).expr);
  }
  if (expr.kind === "coalesce_expr") {
    const coalesce = expr as CoalesceExpr;
    return containsUnionOperator(coalesce.left) || containsUnionOperator(coalesce.right);
  }
  if (expr.kind === "if_else_expr") {
    const ifElse = expr as IfElseExpr;
    return containsUnionOperator(ifElse.condition)
      || containsUnionOperator(ifElse.ifExpr)
      || containsUnionOperator(ifElse.elseExpr);
  }
  if (expr.kind === "for_expr") {
    return containsUnionOperator((expr as ForExpr).body);
  }
  if (expr.kind === "exists_expr") {
    return containsUnionOperator((expr as ExistsExpr).expr);
  }
  if (expr.kind === "tuple") {
    return (expr as Tuple).elements.some((element) => containsUnionOperator(element.val));
  }
  if (expr.kind === "array") {
    return expr.elements.some((element) => containsUnionOperator(element));
  }
  if (expr.kind === "index_expr") {
    const indexExpr = expr as IndexExpr;
    return containsUnionOperator(indexExpr.expr) || containsUnionOperator(indexExpr.index);
  }
  if (expr.kind === "slice_expr") {
    const sliceExpr = expr as SliceExpr;
    return containsUnionOperator(sliceExpr.expr)
      || (sliceExpr.start ? containsUnionOperator(sliceExpr.start) : false)
      || (sliceExpr.end ? containsUnionOperator(sliceExpr.end) : false);
  }
  if (expr.kind === "select_expr") {
    const selectExpr = expr as SelectExpr;
    return containsUnionOperator(selectExpr.result)
      || (selectExpr.where ? containsUnionOperator(selectExpr.where) : false)
      || (selectExpr.limit ? containsUnionOperator(selectExpr.limit) : false)
      || (selectExpr.offset ? containsUnionOperator(selectExpr.offset) : false)
      || (selectExpr.orderBy ?? []).some((order) => containsUnionOperator(order.path));
  }
  if (set.shape.length > 0) {
    return set.shape.some((shape) => containsUnionOperator(shape.expr));
  }
  return false;
};

const unwrapSelectResultSet = (set: Set): Set | null => {
  if (set.expr.kind === "select_expr") {
    const selectExpr = set.expr as SelectExpr;
    return selectExpr.result;
  }
  return set;
};

const compileGroupStmtToSQL = (statement: GroupStmt, options: GelIRCompileOptions): GelIRSQLArtifact => {
  const target = options.target ?? "sqlite";
  const params: ScalarValue[] = [];
  const subjectSql = compileValueSetSQL(statement.subject, "g0", params, target, options);
  if (!subjectSql) {
    return {
      sql: `SELECT NULL AS ${quoteIdent("group_subject")}`,
      params,
      loweringMode: "single_statement",
    };
  }
  return {
    sql: `SELECT ${subjectSql} AS ${quoteIdent("group_subject")}`,
    params,
    loweringMode: "single_statement",
  };
};

const compileConfigStmtToSQL = (statement: ConfigStmt, options: GelIRCompileOptions): GelIRSQLArtifact => {
  const target = options.target ?? "sqlite";
  const params: ScalarValue[] = [];
  if (statement.operation === "reset") {
    return {
      sql: `SELECT NULL AS ${quoteIdent(statement.name)}`,
      params,
      loweringMode: "single_statement",
    };
  }
  const valueSet = statement.value ?? statement.expr;
  const valueSql = compileValueSetSQL(valueSet, "g0", params, target, options);
  if (!valueSql) {
    return {
      sql: `SELECT NULL AS ${quoteIdent(statement.name)}`,
      params,
      loweringMode: "single_statement",
    };
  }
  return {
    sql: `SELECT ${valueSql} AS ${quoteIdent(statement.name)}`,
    params,
    loweringMode: "single_statement",
  };
};

const collectScalarPointerSources = (set: Set, sources: Map<string, TypeRef>): void => {
  const expr = set.expr;
  if (!expr) return;
  if (expr.kind === "pointer") {
    const pointer = expr as Pointer;
    if (pointer.source.expr.kind === "type_root") {
      const id = qualifyTypeName(pointer.source.typeref);
      if (!sources.has(id)) {
        sources.set(id, pointer.source.typeref);
      }
    }
    return;
  }
  if (expr.kind === "type_cast") {
    collectScalarPointerSources((expr as { expr: Set }).expr, sources);
    return;
  }
  if (expr.kind === "operator_call" || expr.kind === "function_call") {
    const call = expr as { args: Record<string, CallArg> };
    for (const arg of orderedCallArgs(call.args)) {
      collectScalarPointerSources(arg.expr, sources);
    }
    return;
  }
  if (expr.kind === "if_else_expr") {
    const ifElse = expr as IfElseExpr;
    collectScalarPointerSources(ifElse.condition, sources);
    collectScalarPointerSources(ifElse.ifExpr, sources);
    collectScalarPointerSources(ifElse.elseExpr, sources);
    return;
  }
  if (expr.kind === "coalesce_expr") {
    const coalesce = expr as CoalesceExpr;
    collectScalarPointerSources(coalesce.left, sources);
    collectScalarPointerSources(coalesce.right, sources);
    return;
  }
  if (expr.kind === "exists_expr") {
    collectScalarPointerSources((expr as ExistsExpr).expr, sources);
    return;
  }
  if (expr.kind === "array") {
    for (const element of expr.elements) {
      collectScalarPointerSources(element, sources);
    }
    return;
  }
  if (expr.kind === "tuple") {
    for (const element of (expr as Tuple).elements) {
      collectScalarPointerSources(element.val, sources);
    }
    return;
  }
  if (expr.kind === "index_expr") {
    const indexExpr = expr as IndexExpr;
    collectScalarPointerSources(indexExpr.expr, sources);
    collectScalarPointerSources(indexExpr.index, sources);
    return;
  }
  if (expr.kind === "slice_expr") {
    const slice = expr as SliceExpr;
    collectScalarPointerSources(slice.expr, sources);
    if (slice.start) collectScalarPointerSources(slice.start, sources);
    if (slice.end) collectScalarPointerSources(slice.end, sources);
  }
};

const compileScalarSelectSQL = (
  sourceSet: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  const expr = sourceSet.expr;
  if (expr.kind === "operator_call" && (expr as OperatorCall).operator === "union") {
    const args = orderedCallArgs((expr as OperatorCall).args);
    const parts: string[] = [];
    for (const arg of args) {
      const partSql = compileScalarSelectSQL(arg.expr, params, target, options);
      if (!partSql) return null;
      parts.push(partSql);
    }
    if (parts.length === 0) return null;
    return parts.join(" UNION ALL ");
  }
  const sources = new Map<string, TypeRef>();
  collectScalarPointerSources(sourceSet, sources);
  const valueSql = compileValueSetSQL(sourceSet, "g0", params, target, options);
  if (!valueSql) return null;
  if (sources.size === 0) {
    return `SELECT ${valueSql} AS ${quoteIdent("value")}`;
  }
  if (sources.size > 1) return null;
  const [typeRef] = sources.values();
  const projectedColumns = collectReferencedColumns(sourceSet);
  const sourceSql = compilePolymorphicSource(typeRef!, false, "g0", projectedColumns, options);
  return `SELECT ${valueSql} AS ${quoteIdent("value")} FROM ${sourceSql}`;
};

const compileSelectSource = (
  sourceSet: Set,
  where: Set | undefined,
  orderBy: SortExpr[] | undefined,
  options: GelIRCompileOptions,
): { sql: string; alias: string } | null => {
  const alias = "g0";
  const projectedColumns = collectProjectedColumns(sourceSet.shape, where, orderBy);
  if (sourceSet.expr.kind === "type_root") {
    const root = sourceSet.expr.typeref;
    return { sql: compilePolymorphicSource(root, sourceSet.expr.skipSubtypes, alias, projectedColumns, options), alias };
  }
  if (sourceSet.expr.kind !== "pointer") {
    return null;
  }
  const pointer = sourceSet.expr as Pointer;
  if (pointer.ptrref.outTarget.isScalar || pointer.source.expr.kind !== "type_root" || pointer.direction !== "outbound") {
    return null;
  }
  const sourceAlias = "s0";
  const sourceCols = shouldUseLinkTable(pointer)
    ? ["id"]
    : ["id", `${pointer.ptrref.shortName}_id`];
  const sourceSql = compilePolymorphicSource(pointer.source.typeref, true, sourceAlias, sourceCols, options);
  const targetAlias = "t0";
  const targetSql = compilePolymorphicSource(pointer.ptrref.outTarget, false, targetAlias, projectedColumns, options);
  if (shouldUseLinkTable(pointer)) {
    const sourceType = qualifyTypeName(pointer.source.typeref);
    const linkTable = `${tableNameForType(sourceType)}__${pointer.ptrref.shortName.toLowerCase()}`;
    return {
      sql: `(SELECT ${targetAlias}.* FROM ${targetSql} JOIN ${quoteIdent(linkTable)} j0 ON j0.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")} JOIN ${sourceSql} ON ${sourceAlias}.${quoteIdent("id")} = j0.${quoteIdent("source")}) ${alias}`,
      alias,
    };
  }
  return {
    sql: `(SELECT ${targetAlias}.* FROM ${targetSql} JOIN ${sourceSql} ON ${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(`${pointer.ptrref.shortName}_id`)}) ${alias}`,
    alias,
  };
};

const compileForExprSource = (
  sourceSet: Set,
  projectedColumns: string[],
  options: GelIRCompileOptions,
): { fromSql: string; baseAlias: string; bindingAliases: Map<string, string>; linkPropertyAliases: Map<string, string>; whereSets: Set[]; orderBy?: SortExpr[] } | null => {
  const levels: Array<{
    iteratorPathId: string;
    alias: string;
    pointer?: Pointer;
    typeRef?: TypeRef;
    linkAlias?: string;
  }> = [];
  const whereSets: Set[] = [];
  let orderBy: SortExpr[] | undefined;
  let currentExpr: Expr = sourceSet.expr;

  while (currentExpr.kind === "for_expr") {
    const forExpr = currentExpr as ForExpr;
    const iterator = forExpr.iterator;
    const alias = `g${levels.length}`;
    const iteratorPathId = pathIdKey(iterator);

    if (iterator.expr.kind === "type_root") {
      levels.push({ iteratorPathId, alias, typeRef: (iterator.expr as TypeRoot).typeref });
    } else if (iterator.expr.kind === "pointer") {
      levels.push({ iteratorPathId, alias, pointer: iterator.expr as Pointer });
    } else {
      return null;
    }

    if (forExpr.where) {
      whereSets.push(forExpr.where);
    }
    orderBy = orderBy ?? forExpr.orderBy;
    currentExpr = forExpr.body.expr;
  }

  if (levels.length === 0 || !levels[0].typeRef) {
    return null;
  }

  const bindingAliases = new Map<string, string>();
  const linkPropertyAliases = new Map<string, string>();
  for (const level of levels) {
    bindingAliases.set(level.iteratorPathId, level.alias);
  }

  const firstAlias = levels[0].alias;
  let fromSql = compilePolymorphicSource(levels[0].typeRef, false, firstAlias, projectedColumns, options);

  for (let i = 1; i < levels.length; i++) {
    const level = levels[i];
    const previousAlias = levels[i - 1].alias;
    const pointer = level.pointer;
    if (!pointer) {
      return null;
    }

    if (shouldUseLinkTable(pointer)) {
      const sourceType = qualifyTypeName(pointer.direction === "inbound" ? pointer.ptrref.outSource : pointer.source.typeref);
      const linkTable = `${tableNameForType(sourceType)}__${pointer.ptrref.shortName.toLowerCase()}`;
      const linkAlias = `j${i}`;
      const targetType = pointer.direction === "inbound" ? pointer.ptrref.outSource : pointer.ptrref.outTarget;
      const targetSource = compilePolymorphicSource(targetType, false, level.alias, projectedColumns, options);
      if (pointer.direction === "inbound") {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSource}`
          + ` ON ${level.alias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
      } else {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSource}`
          + ` ON ${level.alias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      }
      level.linkAlias = linkAlias;
      linkPropertyAliases.set(level.iteratorPathId, linkAlias);
      continue;
    }

    const inlineColumn = `${pointer.ptrref.shortName}_id`;
    const targetType = pointer.direction === "inbound" ? pointer.ptrref.outSource : pointer.ptrref.outTarget;
    const targetSource = compilePolymorphicSource(targetType, false, level.alias, projectedColumns, options);
    if (pointer.direction === "inbound") {
      fromSql += ` JOIN ${targetSource}`
        + ` ON ${level.alias}.${quoteIdent(inlineColumn)} = ${previousAlias}.${quoteIdent("id")}`;
    } else {
      fromSql += ` JOIN ${targetSource}`
        + ` ON ${level.alias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`;
    }
  }

  return { fromSql, baseAlias: firstAlias, bindingAliases, linkPropertyAliases, whereSets, orderBy };
};

const innermostForExprBody = (sourceSet: Set): Set => {
  let current = sourceSet;
  while (current.expr.kind === "for_expr") {
    current = (current.expr as ForExpr).body;
  }
  return current;
};

const collectForExprProjectedColumns = (sourceSet: Set, where?: Set, orderBy?: SortExpr[]): string[] => {
  const columns = new Set<string>(["id"]);
  const visit = (set: Set): void => {
    const expr = set.expr;
    if (expr.kind === "pointer") {
      const pointer = expr as Pointer;
      if (!pointer.ptrref.isLinkProperty && pointer.ptrref.outTarget.isScalar) {
        columns.add(columnForPointer(pointer));
      }
      return;
    }
    if (expr.kind === "for_expr") {
      const forExpr = expr as ForExpr;
      visit(forExpr.iterator);
      visit(forExpr.body);
      if (forExpr.where) {
        visit(forExpr.where);
      }
      for (const order of forExpr.orderBy ?? []) {
        visit(order.path);
      }
      return;
    }
    if (expr.kind === "tuple") {
      for (const element of (expr as Tuple).elements) {
        visit(element.val);
      }
      return;
    }
    if (expr.kind === "operator_call") {
      for (const arg of orderedCallArgs((expr as OperatorCall).args)) {
        visit(arg.expr);
      }
      return;
    }
    if (expr.kind === "function_call") {
      for (const arg of orderedCallArgs((expr as FunctionCall).args)) {
        visit(arg.expr);
      }
      return;
    }
    if (expr.kind === "if_else_expr") {
      const ifElse = expr as IfElseExpr;
      visit(ifElse.condition);
      visit(ifElse.ifExpr);
      visit(ifElse.elseExpr);
      return;
    }
    if (expr.kind === "coalesce_expr") {
      const coalesce = expr as CoalesceExpr;
      visit(coalesce.left);
      visit(coalesce.right);
      return;
    }
    if (expr.kind === "type_cast") {
      visit((expr as TypeCast).expr);
      return;
    }
    if (expr.kind === "exists_expr") {
      visit((expr as ExistsExpr).expr);
      return;
    }
    if (expr.kind === "array") {
      for (const element of expr.elements) {
        visit(element);
      }
      return;
    }
    if (expr.kind === "index_expr") {
      const indexExpr = expr as IndexExpr;
      visit(indexExpr.expr);
      visit(indexExpr.index);
    }
  };

  visit(sourceSet);
  if (where) {
    visit(where);
  }
  for (const order of orderBy ?? []) {
    visit(order.path);
  }
  return [...columns];
};

const compileValueSetSQLWithAliases = (
  set: Set,
  bindingAliases: Map<string, string>,
  fallbackAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAliases?: Map<string, string>,
): string | null => {
  const checkpoint = params.length;
  const unwrapped = unwrapSelectExprSet(set);
  const expr = unwrapped.result.expr;

  if (expr.kind === "pointer") {
    const pointer = expr as Pointer;
    const sourceKey = pathIdKey(pointer.source);
    const alias = bindingAliases.get(sourceKey) ?? fallbackAlias;
    if (pointer.ptrref.isLinkProperty) {
      const linkAlias = linkPropertyAliases?.get(sourceKey) ?? alias;
      return `${linkAlias}.${quoteIdent(columnForPointer(pointer).replace(/^@/, ""))}`;
    }
    return `${alias}.${quoteIdent(columnForPointer(pointer))}`;
  }

  const literal = extractScalarConstant(unwrapped.result);
  if (literal !== undefined) {
    params.push(typeof literal === "boolean" ? Number(literal) : literal);
    return "?";
  }

  if (expr.kind === "tuple") {
    const tuple = expr as Tuple;
    const parts = tuple.elements.map((element) => compileValueSetSQLWithAliases(element.val, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases));
    if (parts.some((part) => !part)) {
      params.length = checkpoint;
      return null;
    }
    return tuple.named
      ? `json_object(${tuple.elements.map((element, idx) => `${quoteLiteral(element.name ?? String(idx))}, ${parts[idx]}`).join(", ")})`
      : `json_array(${parts.join(", ")})`;
  }

  if (expr.kind === "operator_call") {
    const call = expr as OperatorCall;
    const op = normalizeOperator(call.operator);
    const args = orderedCallArgs(call.args);
    if (op && args.length >= 2) {
      const left = compileValueSetSQLWithAliases(args[0].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases);
      const right = compileValueSetSQLWithAliases(args[1].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases);
      if (!left || !right) {
        params.length = checkpoint;
        return null;
      }
      return `(${left} ${op} ${right})`;
    }
  }

  const value = compileValueSetSQL(set, fallbackAlias, params, target, options);
  if (!value) {
    params.length = checkpoint;
  }
  return value;
};

const compilePredicateWithAliases = (
  set: Set,
  bindingAliases: Map<string, string>,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAliases?: Map<string, string>,
): string | null => compileValueSetSQLWithAliases(set, bindingAliases, "g0", params, target, options, linkPropertyAliases);

const compileForExprSort = (order: SortExpr, valueAlias: string): string => {
  if (order.path.expr.kind !== "index_expr") {
    return "";
  }
  const index = extractNumericLiteral((order.path.expr as IndexExpr).index);
  if (index === undefined) {
    return "";
  }
  return `json_extract(${quoteIdent(valueAlias)}, '$[${index}]') ${order.direction.toUpperCase()}`;
};

const pathIdKey = (set: Set): string => JSON.stringify(set.pathId);

const collectProjectedColumns = (shape: ShapeElement[], where?: Set, orderBy?: SortExpr[]): string[] => {
  const columns = new Set<string>(["id"]);
  for (const element of shape) {
    const column = compileProjectedSourceColumnRef(element.expr);
    if (column) {
      columns.add(column);
    }
    if (element.expr.expr.kind === "pointer") {
      const pointer = element.expr.expr as Pointer;
      if (!pointer.ptrref.outTarget.isScalar && pointer.direction === "outbound" && !shouldUseLinkTable(pointer)) {
        columns.add(`${pointer.ptrref.shortName}_id`);
      }
    }
  }
  if (where) {
    for (const column of collectReferencedColumns(where)) {
      columns.add(column);
    }
  }
  if (orderBy) {
    for (const sort of orderBy) {
      for (const column of collectReferencedColumns(sort.path)) {
        columns.add(column);
      }
    }
  }
  return [...columns];
};

const collectReferencedColumns = (set: Set): string[] => {
  const out = new Set<string>();
  const visit = (node: Set): void => {
    const direct = compileProjectedSourceColumnRef(node);
    if (direct) {
      out.add(direct);
    }
    const expr = node.expr;
    if (expr.kind === "operator_call") {
      for (const arg of orderedCallArgs((expr as OperatorCall).args)) {
        visit(arg.expr);
      }
      return;
    }
    if (expr.kind === "function_call") {
      for (const arg of orderedCallArgs((expr as FunctionCall).args)) {
        visit(arg.expr);
      }
      return;
    }
    if (expr.kind === "coalesce_expr") {
      const coalesce = expr as CoalesceExpr;
      visit(coalesce.left);
      visit(coalesce.right);
      return;
    }
    if (expr.kind === "if_else_expr") {
      const ifElse = expr as IfElseExpr;
      visit(ifElse.condition);
      visit(ifElse.ifExpr);
      visit(ifElse.elseExpr);
      return;
    }
    if (expr.kind === "type_cast") {
      visit((expr as TypeCast).expr);
      return;
    }
    if (expr.kind === "exists_expr") {
      visit((expr as ExistsExpr).expr);
      return;
    }
    if (expr.kind === "for_expr") {
      visit((expr as ForExpr).body);
      return;
    }
    if (expr.kind === "select_expr") {
      const sel = expr as SelectExpr;
      visit(sel.result);
      if (sel.where) {
        visit(sel.where);
      }
      for (const sort of sel.orderBy ?? []) {
        visit(sort.path);
      }
      if (sel.limit) {
        visit(sel.limit);
      }
      if (sel.offset) {
        visit(sel.offset);
      }
      return;
    }
    if (expr.kind === "array") {
      for (const element of expr.elements) {
        visit(element);
      }
      return;
    }
    if (expr.kind === "tuple") {
      for (const element of (expr as Tuple).elements) {
        visit(element.val);
      }
      return;
    }
    if (expr.kind === "index_expr") {
      const indexExpr = expr as IndexExpr;
      visit(indexExpr.expr);
      visit(indexExpr.index);
      return;
    }
    if (expr.kind === "slice_expr") {
      const slice = expr as SliceExpr;
      visit(slice.expr);
      if (slice.start) {
        visit(slice.start);
      }
      if (slice.end) {
        visit(slice.end);
      }
      return;
    }
  };
  visit(set);
  return [...out];
};

const compileProjectedSourceColumnRef = (set: Set): string | null => {
  if (set.expr.kind !== "pointer") {
    return null;
  }
  const pointer = set.expr as Pointer;
  if (pointer.ptrref.isLinkProperty || !pointer.ptrref.outTarget.isScalar) {
    return null;
  }
  return columnForPointer(pointer);
};

const compilePolymorphicSource = (
  typeRef: TypeRef,
  skipSubtypes: boolean,
  alias: string,
  projectedColumns: string[],
  options: GelIRCompileOptions,
): string => {
  const candidates = skipSubtypes ? [typeRef] : flattenTypeClosure(typeRef);
  const concrete = candidates.filter((candidate) => !candidate.isAbstract);
  const sources = concrete.length > 0 ? concrete : [typeRef];

  const cols = projectedColumns.map((column) => `${quoteIdent(column)} AS ${quoteIdent(column)}`).join(", ");
  const selects = sources.map((source) => {
    const sourceTypeName = qualifyTypeName(source);
    const sourceTable = resolveTypeTableName(source, options);
    return `SELECT ${quoteLiteral(sourceTypeName)} AS ${quoteIdent("__source_type")}, ${cols} FROM ${quoteIdent(sourceTable)}`;
  });

  return `(${selects.join(" UNION ALL ")}) ${alias}`;
};

const flattenTypeClosure = (root: TypeRef): TypeRef[] => {
  const out: TypeRef[] = [];
  const seen = new Set<string>();
  const visit = (typeRef: TypeRef): void => {
    if (seen.has(typeRef.id)) {
      return;
    }
    seen.add(typeRef.id);
    out.push(typeRef);
    for (const child of typeRef.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return out;
};

const compileShapeProjection = (
  shape: ShapeElement,
  sourceAlias: string,
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
): string | null => {
  const shapeExpr = unwrapSelectExprSet(shape.expr);
  if (shapeExpr.result.expr.kind === "pointer" && !shapeExpr.result.typeref.isScalar) {
    const linkExpr = compilePointerArrayExpr(
      shapeExpr.result.expr,
      sourceAlias,
      shapeExpr.result.shape,
      params,
      options,
      target,
      depth + 1,
      shapeExpr.selectExpr,
    );
    const alias = shapeAliasForElement(shape, shape.expr, depth);
    return `${linkExpr} AS ${quoteIdent(alias)}`;
  }

  const valueExpr = compileValueSetSQL(shapeExpr.result, sourceAlias, params, target, options);
  if (!valueExpr) {
    return null;
  }
  if (shape.cardinality === "many" || shape.cardinality === "at_least_one") {
    return `COALESCE((SELECT json_group_array(value) FROM (SELECT ${valueExpr} AS value)), '[]') AS ${quoteIdent(shapeAliasForElement(shape, shapeExpr.result, depth))}`;
  }
  return `${valueExpr} AS ${quoteIdent(shapeAliasForElement(shape, shapeExpr.result, depth))}`;
};

const compileWhereClause = (
  set: Set,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  const checkpoint = params.length;
  const compiled = compilePredicateSetSQL(set, sourceAlias, params, target, options);
  if (!compiled) {
    params.length = checkpoint;
    return null;
  }
  return compiled;
};

const normalizeOperator = (op: string): "=" | "!=" | "<" | "<=" | ">" | ">=" | null => {
  if (op === "=" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    return op;
  }

  return null;
};

const compilePredicateSetSQL = (
  set: Set,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias?: string,
): string | null => {
  const checkpoint = params.length;
  if (set.expr.kind !== "operator_call") {
    params.length = checkpoint;
    return null;
  }

  const call = set.expr as OperatorCall;
  if (call.operator === "and" || call.operator === "or") {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      params.length = checkpoint;
      return null;
    }
    const left = compilePredicateSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compilePredicateSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left || !right) {
      params.length = checkpoint;
      return null;
    }
    return `(${left} ${call.operator.toUpperCase()} ${right})`;
  }

  if (call.operator === "not") {
    const args = orderedCallArgs(call.args);
    if (args.length < 1) {
      params.length = checkpoint;
      return null;
    }
    const inner = compilePredicateSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!inner) {
      params.length = checkpoint;
      return null;
    }
    return `(NOT ${inner})`;
  }

  if (call.operator === "in" || call.operator === "not in") {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      params.length = checkpoint;
      return null;
    }
    const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left) {
      params.length = checkpoint;
      return null;
    }
    const rightValues = extractInPredicateLiteralValues(args[1].expr);
    if (!rightValues || rightValues.length === 0) {
      params.length = checkpoint;
      return null;
    }
    const placeholders = rightValues.map(() => "?").join(", ");
    params.push(...rightValues);
    return `(${left} ${call.operator === "in" ? "IN" : "NOT IN"} (${placeholders}))`;
  }

  const op = normalizeOperator(call.operator);
  if (!op) {
    params.length = checkpoint;
    return null;
  }

  const args = orderedCallArgs(call.args);
  if (args.length < 2) {
    params.length = checkpoint;
    return null;
  }

  const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
  const right = compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
  if (!left || !right) {
    params.length = checkpoint;
    return null;
  }

  return `${wrapPredicateOperand(left)} ${op} ${wrapPredicateOperand(right)}`;
};

const wrapPredicateOperand = (sql: string): string => {
  const trimmed = sql.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return trimmed;
  }
  if (trimmed.includes(" AND ") || trimmed.includes(" OR ") || trimmed.includes(" = ") || trimmed.includes(" != ")) {
    return `(${trimmed})`;
  }
  return trimmed;
};

const extractInPredicateLiteralValues = (set: Set): ScalarValue[] | null => {
  const expr = set.expr;
  if (expr.kind === "operator_call") {
    const call = expr as OperatorCall;
    if (call.operator === "distinct") {
      const args = orderedCallArgs(call.args);
      if (args.length < 1) {
        return null;
      }
      return extractInPredicateLiteralValues(args[0].expr);
    }
    if (call.operator === "union") {
      const args = orderedCallArgs(call.args);
      const out: ScalarValue[] = [];
      for (const arg of args) {
        const values = extractInPredicateLiteralValues(arg.expr);
        if (!values) {
          return null;
        }
        out.push(...values);
      }
      return out;
    }
  }

  const scalar = extractScalarConstant(set);
  if (scalar !== undefined) {
    return [scalar];
  }
  return null;
};

const compileValueSetSQL = (
  set: Set,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias?: string,
): string | null => {
  const checkpoint = params.length;
  const unwrapped = unwrapSelectExprSet(set);
  if (unwrapped.selectExpr) {
    const subquery = compileSelectExprSubquery(unwrapped.selectExpr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!subquery) {
      params.length = checkpoint;
      return null;
    }
    return subquery;
  }

  const expr = unwrapped.result.expr;
  if (expr.kind === "pointer") {
    const pointer = expr as Pointer;
    const col = columnForPointer(pointer);
    if (pointer.ptrref.isLinkProperty) {
      const alias = linkPropertyAlias ?? sourceAlias;
      return `${alias}.${quoteIdent(col)}`;
    }
    return `${sourceAlias}.${quoteIdent(col)}`;
  }

  const literal = extractScalarConstant(unwrapped.result);
  if (literal !== undefined) {
    params.push(typeof literal === "boolean" ? Number(literal) : literal)
    return "?";
  }

  if (expr.kind === "type_cast") {
    const castExpr = expr as TypeCast;
    const inner = compileValueSetSQL(castExpr.expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!inner) {
      params.length = checkpoint;
      return null;
    }
    const castTarget = sqlCastTarget(castExpr.toType);
    return castTarget ? `CAST(${inner} AS ${castTarget})` : inner;
  }

  if (expr.kind === "function_call") {
    const compiled = compileFunctionCallSQL(expr as FunctionCall, sourceAlias, params, target, options, linkPropertyAlias);
    if (!compiled) {
      params.length = checkpoint;
      return null;
    }
    return compiled;
  }

  if (expr.kind === "operator_call") {
    const compiled = compileOperatorValueSQL(expr as OperatorCall, sourceAlias, params, target, options, linkPropertyAlias);
    if (!compiled) {
      params.length = checkpoint;
      return null;
    }
    return compiled;
  }

  if (expr.kind === "if_else_expr") {
    const ifExpr = expr as IfElseExpr;
    const cond = compilePredicateSetSQL(ifExpr.condition, sourceAlias, params, target, options, linkPropertyAlias) ?? compileValueSetSQL(ifExpr.condition, sourceAlias, params, target, options, linkPropertyAlias);
    const whenTrue = compileValueSetSQL(ifExpr.ifExpr, sourceAlias, params, target, options, linkPropertyAlias);
    const whenFalse = compileValueSetSQL(ifExpr.elseExpr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!cond || !whenTrue || !whenFalse) {
      params.length = checkpoint;
      return null;
    }
    return `(CASE WHEN ${cond} THEN ${whenTrue} ELSE ${whenFalse} END)`;
  }

  if (expr.kind === "for_expr") {
    const forExpr = expr as ForExpr;
    const body = compileValueSetSQL(forExpr.body, sourceAlias, params, target, options, linkPropertyAlias);
    if (!body) {
      params.length = checkpoint;
      return null;
    }
    return body;
  }

  if (expr.kind === "type_check_op") {
    const typeCheck = expr as TypeCheckOpExpr;
    if (typeCheck.result !== undefined) {
      return typeCheck.result ? "1" : "0";
    }
    const leftType = qualifyTypeName(typeCheck.left.typeref);
    const rightType = qualifyTypeName(typeCheck.right);
    const rightChildren = (typeCheck.right.children ?? []).map((child) => qualifyTypeName(child));
    const matches = leftType === rightType || rightChildren.includes(leftType);
    if (typeCheck.op === "is") {
      return matches ? "1" : "0";
    }
    if (typeCheck.op === "is not") {
      return matches ? "0" : "1";
    }
    params.length = checkpoint;
    return null;
  }

  if (expr.kind === "coalesce_expr") {
    const coalesce = expr as CoalesceExpr;
    const left = compileValueSetSQL(coalesce.left, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compileValueSetSQL(coalesce.right, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left || !right) {
      params.length = checkpoint;
      return null;
    }
    return `COALESCE(${left}, ${right})`;
  }

  if (expr.kind === "exists_expr") {
    const existsExpr = expr as ExistsExpr;
    const inner = compileValueSetSQL(existsExpr.expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!inner) {
      params.length = checkpoint;
      return null;
    }
    return `(CASE WHEN ${inner} IS NULL THEN 0 ELSE 1 END)`;
  }

  if (expr.kind === "tuple") {
    const tuple = expr as Tuple;
    const parts = tuple.elements.map((element) => compileValueSetSQL(element.val, sourceAlias, params, target, options, linkPropertyAlias));
    if (parts.some((part) => !part)) {
      params.length = checkpoint;
      return null;
    }
    return tuple.named
      ? `json_object(${tuple.elements.map((element, idx) => `${quoteLiteral(element.name ?? String(idx))}, ${parts[idx]}`).join(", ")})`
      : `json_array(${parts.join(", ")})`;
  }

  if (expr.kind === "array") {
    const parts = expr.elements.map((element) => compileValueSetSQL(element, sourceAlias, params, target, options, linkPropertyAlias));
    if (parts.some((part) => !part)) {
      params.length = checkpoint;
      return null;
    }
    return `json_array(${parts.join(", ")})`;
  }

  if (expr.kind === "index_expr") {
    const indexExpr = expr as IndexExpr;
    const base = compileValueSetSQL(indexExpr.expr, sourceAlias, params, target, options, linkPropertyAlias);
    const index = compileValueSetSQL(indexExpr.index, sourceAlias, params, target, options, linkPropertyAlias);
    if (!base || !index) {
      params.length = checkpoint;
      return null;
    }
    return `json_extract(${base}, '$[' || ${index} || ']')`;
  }

  if (expr.kind === "slice_expr") {
    const sliceExpr = expr as SliceExpr;
    const base = compileValueSetSQL(sliceExpr.expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!base) {
      params.length = checkpoint;
      return null;
    }
    const start = sliceExpr.start ? compileValueSetSQL(sliceExpr.start, sourceAlias, params, target, options, linkPropertyAlias) : "0";
    const end = sliceExpr.end ? compileValueSetSQL(sliceExpr.end, sourceAlias, params, target, options, linkPropertyAlias) : null;
    if (!start || (sliceExpr.end && !end)) {
      params.length = checkpoint;
      return null;
    }
    return end
      ? `json_extract(${base}, '$[' || ${start} || ':' || ${end} || ']')`
      : `json_extract(${base}, '$[' || ${start} || ':]')`;
  }

  if (expr.kind === "parameter" || expr.kind === "query_parameter" || expr.kind === "function_parameter") {
    params.push(resolveInputValue(options, "parameter", expr.name));
    return "?";
  }

  if (expr.kind === "global_expr") {
    params.push(resolveInputValue(options, "global", expr.name));
    return "?";
  }

  if (expr.kind === "empty_set") {
    return "NULL";
  }

  params.length = checkpoint;
  return null;
};

const compileOperatorValueSQL = (
  call: OperatorCall,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias?: string,
): string | null => {
  const checkpoint = params.length;
  if (call.operator === "and" || call.operator === "or" || call.operator === "not") {
    return compilePredicateSetSQL(
      {
        kind: "set",
        expr: call,
        pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] },
        typeref: call.returning,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      },
      sourceAlias,
      params,
      target,
      options,
      linkPropertyAlias,
    );
  }
  const op = normalizeOperator(call.operator);
  if (op) {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      return null;
    }
    const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left || !right) {
      params.length = checkpoint;
      return null;
    }
    return `(${left} ${op} ${right})`;
  }
  if (call.operator === "??") {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      return null;
    }
    const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left || !right) {
      params.length = checkpoint;
      return null;
    }
    return `COALESCE(${left}, ${right})`;
  }

  if (call.operator === "union") {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      return null;
    }
    const values = args.map((arg) => compileValueSetSQL(arg.expr, sourceAlias, params, target, options, linkPropertyAlias));
    if (values.some((value) => !value)) {
      params.length = checkpoint;
      return null;
    }
    const selects = (values as string[]).map((value) => `SELECT ${value} AS ${quoteIdent("value")}`).join(" UNION ALL ");
    return `(SELECT json_group_array(${quoteIdent("value")}) FROM (${selects}))`;
  }

  const infixOperator = operatorToInfixSql(call.operator);
  if (infixOperator) {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      return null;
    }
    const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left || !right) {
      params.length = checkpoint;
      return null;
    }
    if (call.operator === "ilike") {
      return `(LOWER(${left}) LIKE LOWER(${right}))`;
    }
    return `(${left} ${infixOperator} ${right})`;
  }

  if (call.operator === "in" || call.operator === "not in") {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      return null;
    }
    const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left || !right) {
      params.length = checkpoint;
      return null;
    }
    return `(${left} ${call.operator === "in" ? "IN" : "NOT IN"} ${right})`;
  }
  params.length = checkpoint;
  return null;
};

const compileFunctionCallSQL = (
  call: FunctionCall,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias?: string,
): string | null => {
  const checkpoint = params.length;
  const args = orderedCallArgs(call.args)
    .map((arg) => compileValueSetSQL(arg.expr, sourceAlias, params, target, options, linkPropertyAlias));
  if (args.some((arg) => !arg)) {
    params.length = checkpoint;
    return null;
  }

  const lowered = lowerStdlibFunctionSql(target, call.functionName, args as string[]);
  if (!lowered) {
    params.length = checkpoint;
    return null;
  }
  return lowered;
};

const orderedCallArgs = (args: Record<string, CallArg>): CallArg[] => {
  return Object.entries(args)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([, arg]) => arg);
};

const sqlCastTarget = (typeRef: TypeRef): "TEXT" | "INTEGER" | "REAL" | null => {
  const qualified = qualifyTypeName(typeRef);
  if (
    qualified === "std::str"
    || qualified === "std::uuid"
    || qualified === "std::json"
    || qualified === "std::datetime"
  ) {
    return "TEXT";
  }

  if (qualified === "std::int64") {
    return "INTEGER";
  }

  if (qualified === "std::float64") {
    return "REAL";
  }

  return null;
};

const compileSetColumnRef = (set: Set, linkPropertyAlias?: string): string | null => {
  if (set.expr.kind === "pointer") {
    const pointer = set.expr as Pointer;
    if (pointer.ptrref.isLinkProperty) {
      return linkPropertyAlias ? pointer.ptrref.shortName : null;
    }
    return columnForPointer(pointer);
  }

  return null;
};

const compilePointerArrayExpr = (
  pointer: Pointer,
  sourceAlias: string,
  targetShape: ShapeElement[],
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
  modifiers?: SelectExpr,
): string => {
  const maxDepth = options.maxShapeDepth ?? 2;
  if (depth > maxDepth) {
    return "'[]'";
  }

  const targetAlias = `p${depth}`;
  const joinAlias = `j${depth}`;
  const projectedCols = collectProjectedColumns(targetShape);
  const rowExpr = compileShapeObjectExpr(targetAlias, targetShape, params, options, target, depth, joinAlias);

  if (pointer.direction === "inbound") {
    return compileBacklinkArrayExpr(pointer, sourceAlias, targetAlias, joinAlias, projectedCols, rowExpr, options, modifiers, params, target);
  }

  return compileOutboundLinkArrayExpr(pointer, sourceAlias, targetAlias, joinAlias, projectedCols, rowExpr, options, modifiers, params, target);
};

const compileOutboundLinkArrayExpr = (
  pointer: Pointer,
  sourceAlias: string,
  targetAlias: string,
  joinAlias: string,
  projectedCols: string[],
  rowExpr: string,
  options: GelIRCompileOptions,
  modifiers: SelectExpr | undefined,
  params: ScalarValue[],
  target: RuntimeTarget,
): string => {
  const targetSource = compilePolymorphicSource(pointer.ptrref.outTarget, false, targetAlias, projectedCols, options);
  if (shouldUseLinkTable(pointer)) {
    const sourceType = qualifyTypeName(pointer.source.typeref);
    const linkTable = `${tableNameForType(sourceType)}__${pointer.ptrref.shortName.toLowerCase()}`;
    const inner = compileLinkedInnerSelect(`SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${targetSource} JOIN ${quoteIdent(linkTable)} ${joinAlias} ON ${joinAlias}.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")} WHERE ${joinAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`, modifiers, targetAlias, params, target, options, joinAlias);
    return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
  }

  const inlineColumn = `${pointer.ptrref.shortName}_id`;
  const inner = compileLinkedInnerSelect(`SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${targetSource} WHERE ${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(inlineColumn)}`, modifiers, targetAlias, params, target, options);
  return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
};

const compileBacklinkArrayExpr = (
  pointer: Pointer,
  sourceAlias: string,
  backlinkAlias: string,
  joinAlias: string,
  projectedCols: string[],
  rowExpr: string,
  options: GelIRCompileOptions,
  modifiers: SelectExpr | undefined,
  params: ScalarValue[],
  target: RuntimeTarget,
): string => {
  const sourceType = pointer.ptrref.outSource;
  const projectedBacklinkCols = shouldUseLinkTable(pointer)
    ? projectedCols
    : [...new Set<string>([...projectedCols, `${pointer.ptrref.shortName}_id`])];
  const backlinkSource = compilePolymorphicSource(sourceType, false, backlinkAlias, projectedBacklinkCols, options);
  if (shouldUseLinkTable(pointer)) {
    const linkTable = `${tableNameForType(qualifyTypeName(sourceType))}__${pointer.ptrref.shortName.toLowerCase()}`;
    const inner = compileLinkedInnerSelect(`SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${backlinkSource} JOIN ${quoteIdent(linkTable)} ${joinAlias} ON ${joinAlias}.${quoteIdent("source")} = ${backlinkAlias}.${quoteIdent("id")} WHERE ${joinAlias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")}`, modifiers, backlinkAlias, params, target, options, joinAlias);
    return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
  }

  const inlineColumn = `${pointer.ptrref.shortName}_id`;
  const inner = compileLinkedInnerSelect(`SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${backlinkSource} WHERE ${backlinkAlias}.${quoteIdent(inlineColumn)} = ${sourceAlias}.${quoteIdent("id")}`, modifiers, backlinkAlias, params, target, options);
  return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
};

const compileLinkedInnerSelect = (
  baseSql: string,
  modifiers: SelectExpr | undefined,
  targetAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias?: string,
): string => {
  if (!modifiers) {
    return baseSql;
  }
  let inner = baseSql;
  const clauses: string[] = [];
  if (modifiers.where) {
    const where = compilePredicateSetSQL(modifiers.where, targetAlias, params, target, options, linkPropertyAlias)
      ?? compileValueSetSQL(modifiers.where, targetAlias, params, target, options, linkPropertyAlias);
    if (where) {
      clauses.push(where);
    }
  }
  if (clauses.length > 0) {
    inner += ` AND ${clauses.join(" AND ")}`;
  }
  if (modifiers.orderBy && modifiers.orderBy.length > 0) {
    const orderSql = compileSortExprs(modifiers.orderBy, targetAlias, linkPropertyAlias);
    if (orderSql) {
      inner += ` ORDER BY ${orderSql}`;
    }
  }
  const limit = extractNumericLiteral(modifiers.limit);
  if (limit !== undefined) {
    inner += " LIMIT ?";
    params.push(limit);
  }
  const offset = extractNumericLiteral(modifiers.offset);
  if (offset !== undefined) {
    inner += " OFFSET ?";
    params.push(offset);
  }
  return inner;
};

const compileSortExprs = (orderBy: SortExpr[], sourceAlias: string, linkPropertyAlias?: string): string => {
  return orderBy
    .map((entry) => {
      const column = compileSetColumnRef(entry.path, linkPropertyAlias);
      if (!column) {
        return "";
      }
      const isLinkPropertyPointer = entry.path.expr.kind === "pointer" && (entry.path.expr as Pointer).ptrref.isLinkProperty;
      const orderAlias = isLinkPropertyPointer && linkPropertyAlias ? linkPropertyAlias : sourceAlias;
      return `${orderAlias}.${quoteIdent(column)} ${entry.direction.toUpperCase()}`;
    })
    .filter((entry) => entry.length > 0)
    .join(", ");
};

const extractNumericLiteral = (set: Set | undefined): number | undefined => {
  if (!set) {
    return undefined;
  }
  if (set.expr.kind !== "integer_constant") {
    return undefined;
  }
  return Number((set.expr as BaseConstant).value);
};

const unwrapSelectExprSet = (set: Set): { result: Set; selectExpr?: SelectExpr } => {
  if (set.expr.kind !== "select_expr") {
    return { result: set };
  }
  return { result: (set.expr as SelectExpr).result, selectExpr: set.expr as SelectExpr };
};

const compileSelectExprSubquery = (
  selectExpr: SelectExpr,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias?: string,
): string | null => {
  const unwrapped = unwrapSelectExprSet(selectExpr.result);
  const shapedResult = unwrapped.result;
  const value = shapedResult.shape.length > 0
    ? compileSelectExprShapeProjection(shapedResult, sourceAlias, params, target, options, linkPropertyAlias)
    : compileValueSetSQL(selectExpr.result, sourceAlias, params, target, options, linkPropertyAlias);
  if (!value) {
    return null;
  }
  let sql = `SELECT ${value}`;
  if (selectExpr.where) {
    const where = compilePredicateSetSQL(selectExpr.where, sourceAlias, params, target, options, linkPropertyAlias) ?? compileValueSetSQL(selectExpr.where, sourceAlias, params, target, options, linkPropertyAlias);
    if (where) {
      sql += ` WHERE ${where}`;
    }
  }
  if (selectExpr.orderBy && selectExpr.orderBy.length > 0) {
    const orderSql = compileSortExprs(selectExpr.orderBy, sourceAlias, linkPropertyAlias);
    if (orderSql) {
      sql += ` ORDER BY ${orderSql}`;
    }
  }
  const limit = extractNumericLiteral(selectExpr.limit);
  if (limit !== undefined) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const offset = extractNumericLiteral(selectExpr.offset);
  if (offset !== undefined) {
    sql += " OFFSET ?";
    params.push(offset);
  }
  return `(${sql})`;
};

const compileSelectExprShapeProjection = (
  set: Set,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias?: string,
): string | null => {
  if (set.expr.kind !== "type_root" && set.expr.kind !== "pointer") {
    return null;
  }
  return compileShapeObjectExpr(sourceAlias, set.shape, params, options, target, 0, linkPropertyAlias);
};

const shapeAliasForElement = (shape: ShapeElement, exprSet: Set, depth: number): string => {
  const column = compileSetColumnRef(exprSet);
  if (column) {
    return column;
  }
  if (shape.expr.expr.kind === "pointer") {
    return (shape.expr.expr as Pointer).ptrref.shortName;
  }
  return `__shape_${depth}_${Math.abs(hashShapeExpr(shape.expr.pathId.steps.length, exprSet.typeref.id))}`;
};

const hashShapeExpr = (seed: number, value: string): number => {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
};

const compileShapeObjectExpr = (
  sourceAlias: string,
  shape: ShapeElement[],
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
  linkPropertyAlias?: string,
): string => {
  const pairs = [
    `${quoteLiteral("id")}, ${sourceAlias}.${quoteIdent("id")}`,
    `${quoteLiteral("__source_type")}, ${sourceAlias}.${quoteIdent("__source_type")}`,
  ];

  for (const element of shape) {
    if (element.expr.expr.kind === "pointer" && !element.expr.typeref.isScalar) {
      const nested = compilePointerArrayExpr(element.expr.expr, sourceAlias, element.expr.shape, params, options, target, depth + 1);
      const key = quoteLiteral(element.expr.expr.ptrref.shortName);
      if (element.cardinality === "many" || element.cardinality === "at_least_one") {
        pairs.push(`${key}, json(${nested})`);
      } else {
        pairs.push(`${key}, json(COALESCE(json_extract(${nested}, '$[0]'), 'null'))`);
      }
      continue;
    }

    const column = compileSetColumnRef(element.expr, linkPropertyAlias);
    if (column) {
      if (column.startsWith("@") && linkPropertyAlias) {
        const rawValue = `${linkPropertyAlias}.${quoteIdent(column.slice(1))}`;
        const value = element.expr.typeref.collection ? `json(${rawValue})` : rawValue;
        pairs.push(`${quoteLiteral(column)}, ${value}`);
        continue;
      }
      const rawValue = `${sourceAlias}.${quoteIdent(column)}`;
      const value = element.expr.typeref.collection ? `json(${rawValue})` : rawValue;
      pairs.push(`${quoteLiteral(column)}, ${value}`);
      continue;
    }

    const computed = compileValueSetSQL(element.expr, sourceAlias, params, target, options);
    if (computed) {
      pairs.push(`${quoteLiteral(shapeAliasForElement(element, element.expr, depth))}, ${computed}`);
    }
  }

  if (pairs.length === 0) {
    return "json_object()";
  }

  return `json_object(${pairs.join(", ")})`;
};

const shouldUseLinkTable = (pointer: Pointer): boolean => {
  if (pointer.forceLinkTable) {
    return true;
  }

  if (pointer.ptrref.hasProperties) {
    return true;
  }

  return pointer.ptrref.outCardinality === "many" || pointer.ptrref.outCardinality === "at_least_one";
};

const columnForPointer = (pointer: Pointer): string => pointer.ptrref.shortName;

const resolveShapeElementPointer = (element: ShapeElement): PointerRef | undefined => {
  if (element.targetPtr) {
    return element.targetPtr;
  }
  if (element.expr.expr.kind === "pointer") {
    return (element.expr.expr as Pointer).ptrref;
  }
  return undefined;
};

const operatorToInfixSql = (operator: string): string | null => {
  if (operator === "+" || operator === "-" || operator === "*" || operator === "/" || operator === "%" || operator === "^") {
    return operator;
  }
  if (operator === "//") {
    return "/";
  }
  if (operator === "++") {
    return "||";
  }
  if (operator === "like") {
    return "LIKE";
  }
  if (operator === "ilike") {
    return "ILIKE";
  }
  if (operator === "union") {
    return "UNION";
  }
  if (operator === "distinct") {
    return "IS DISTINCT FROM";
  }
  return null;
};

const extractScalarConstant = (set: Set): ScalarValue | undefined => {
  const expr = set.expr;
  if (
    expr.kind === "string_constant"
    || expr.kind === "integer_constant"
    || expr.kind === "float_constant"
    || expr.kind === "decimal_constant"
    || expr.kind === "bigint_constant"
    || expr.kind === "boolean_constant"
    || expr.kind === "bytes_constant"
  ) {
    return (expr as BaseConstant).value;
  }

  return undefined;
};

const resolveInputValue = (
  options: GelIRCompileOptions,
  kind: "parameter" | "global",
  name: string,
): ScalarValue => {
  if (kind === "parameter") {
    const value = options.parameterValues?.[name];
    return value === undefined ? null : value;
  }
  const value = options.globalValues?.[name];
  if (value !== undefined) {
    return value;
  }
  const legacyGlobal = options.globalValues?.[`global::${name}`] ?? options.globalValues?.[`default::${name}`];
  return legacyGlobal === undefined ? null : legacyGlobal;
};

const qualifyTypeName = (typeRef: TypeRef): string => {
  if (typeRef.nameHint.includes("::")) {
    return typeRef.nameHint;
  }
  return `${typeRef.module}::${typeRef.nameHint}`;
};

const resolveTypeTableName = (typeRef: TypeRef, options: GelIRCompileOptions): string => {
  const qualified = qualifyTypeName(typeRef);
  if (options.resolveTableName) {
    return options.resolveTableName(qualified);
  }
  return tableNameForType(qualified);
};
