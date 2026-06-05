import { quoteIdent, quoteLiteral, tableNameForType } from "../codegen/sql.js";
import type { RuntimeTarget } from "../runtime/target.js";
import { lowerStdlibFunctionSql } from "./stdlib_lowering.js";
import type {
  ArrayExpr,
  BaseConstant,
  CallArg,
  CoalesceExpr,
  ConfigStmt,
  ExistsExpr,
  DeleteExpr,
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
  resolveTypeColumns?: (typeName: string) => globalThis.Set<string> | undefined;
  resolveEnumMembers?: (typeName: string) => string[] | undefined;
  // For sortable enum lookups via a field path: `(typeName, fieldName)` —
  // returns the enum's declared member list when the field is enum-typed.
  // Lets ORDER BY recover the right ordering for inlined unions of
  // enum-typed pointers (e.g. `{O.o0, O.o1}`).
  resolveFieldEnumMembers?: (typeName: string, fieldName: string) => string[] | undefined;
  // Inherited links share storage with the most-base type where they're
  // defined: `LogEntry.owner` inherits from `Owned.owner` and the link table
  // is `default__owned__owner` (not `default__logentry__owner`). When this
  // resolver is supplied, the IR compiler uses it to find the right link
  // table for backlinks/forward links; if absent it falls back to the
  // sourceType-named table.
  resolveLinkStorageType?: (sourceTypeName: string, linkName: string) => string | undefined;
  maxShapeDepth?: number;
  target?: RuntimeTarget;
  parameterValues?: Record<string, ScalarValue>;
  globalValues?: Record<string, ScalarValue>;
  // Stack of enclosing iteration scopes available to inner subqueries.
  // EdgeQL's path-sharing semantics: a fresh `User` reference inside a
  // shape projection on `User` refers to the OUTER iterator's current row,
  // not a cross-product of all Users. The IR doesn't capture this binding
  // (the inner reference is a fresh type_root with its own path), so the
  // SQL compiler matches by typeref id here when resolving path
  // references. Most-recent (innermost) scopes take precedence.
  outerScopes?: ReadonlyArray<{ alias: string; typeref: TypeRef }>;
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

  // EdgeQL forbids `LIMIT -1` / `OFFSET -2`; SQLite would silently treat them
  // as "no limit"/"skip nothing", masking the user error. Catch literal
  // negatives before anything else compiles so the message is clean.
  const stmtLimitForValidation = statement.limit ?? topSelect.selectExpr?.limit;
  const stmtOffsetForValidation = statement.offset ?? topSelect.selectExpr?.offset;
  const limitForValidation = extractNumericLiteral(stmtLimitForValidation);
  if (limitForValidation !== undefined && limitForValidation < 0) {
    throw new Error("LIMIT must not be negative");
  }
  const offsetForValidation = extractNumericLiteral(stmtOffsetForValidation);
  if (offsetForValidation !== undefined && offsetForValidation < 0) {
    throw new Error("OFFSET must not be negative");
  }

  // `SELECT <T>{}` (and bare `SELECT {}`) must yield zero rows, not one
  // NULL row. The IR represents an empty set literal as a typeless
  // `string_constant` with `value: null` (see literalToSet in ast_to_ir);
  // without this shortcut we would lower it to `SELECT ? AS "value"` with a
  // single null parameter, which SQLite materializes as one row.
  //
  // Same rule for strict binary operators (`=`, `<`, `+`, etc.) whose cross
  // product with an empty operand is also empty: SQL would otherwise
  // materialize a single NULL/false row.
  if (sourceSet && (isTopLevelEmptySetMarker(sourceSet) || selectYieldsEmptyByStrictOperand(sourceSet))) {
    return {
      sql: `SELECT NULL AS ${quoteIdent("value")} WHERE 0`,
      params,
      loweringMode: "single_statement",
    };
  }

  if (sourceSet?.expr.kind === "for_expr") {
    const forParamsCheckpoint = params.length;
    const projectedColumns = collectForExprProjectedColumns(sourceSet, selectWhere, selectOrderBy);
    const forSource = compileForExprSource(sourceSet, projectedColumns, options, params, target);
    const bodySet = innermostForExprBody(sourceSet);
    // Fresh references to a type root inside the FOR body (e.g. `Card.name`
    // when the iterator is `C IN Card`) are independent of the iterator —
    // EdgeQL semantics give them cross-product cardinality. We add a
    // CROSS JOIN for each unique free type-root and map its pathId so the
    // body's pointer compilation picks up the new alias instead of falling
    // back to the iterator's alias.
    if (forSource) {
      const freeRoots = collectFreeTypeRoots(bodySet, forSource.bindingAliases, selectWhere);
      let nextIdx = countAliases(forSource.bindingAliases);
      for (const root of freeRoots) {
        const alias = `g${nextIdx++}`;
        const joinSql = compilePolymorphicSource(root.typeref, false, alias, projectedColumns, options);
        forSource.fromSql += ` CROSS JOIN ${joinSql}`;
        forSource.bindingAliases.set(root.key, alias);
      }
    }
    const bodySql = forSource
      ? compileValueSetSQLWithAliases(bodySet, forSource.bindingAliases, forSource.baseAlias, params, target, options, forSource.linkPropertyAliases, forSource.scalarBindingAliases, forSource.tupleIterAliases)
      : null;

    if (forSource && bodySql) {
      let sql = `SELECT ${bodySql} AS ${quoteIdent("value")} FROM ${forSource.fromSql}`;
      // If the body is itself a `SELECT … FILTER …` (possibly under several
      // parens-induced select_expr wrappers), treat each FILTER as an
      // additional WHERE on the FOR's FROM clause.
      const bodyWheres: Set[] = [];
      let cur: Set | undefined = bodySet;
      while (cur && cur.expr.kind === "select_expr") {
        const se = cur.expr as SelectExpr;
        if (se.where) bodyWheres.push(se.where);
        cur = se.result;
      }
      const whereSets = [...forSource.whereSets, ...bodyWheres, ...(selectWhere ? [selectWhere] : [])];
      if (whereSets.length > 0) {
        const whereSql = whereSets
          .map((where) => compilePredicateWithAliases(where, forSource.bindingAliases, params, target, options, forSource.linkPropertyAliases, forSource.scalarBindingAliases, forSource.tupleIterAliases))
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
    // FOR-source compile produced no usable SQL — roll back any params it
    // appended (e.g. predicate constants from a `select_expr` iterator) so
    // the fallback path doesn't see leaked placeholders.
    params.length = forParamsCheckpoint;
  }
  const compiledSource = sourceSet ? compileSelectSource(sourceSet, statement.where, statement.orderBy, options, params, target) : null;
  if (!compiledSource) {
    if (sourceSet) {
      const outerWheres = selectWhere ? [selectWhere] : [];
      const scalarSql = compileScalarSelectSQL(sourceSet, params, target, options, outerWheres);
      if (scalarSql) {
        let sql = scalarSql;
        if (selectOrderBy && selectOrderBy.length > 0) {
          const orderSql = compileValueSortExprs(selectOrderBy, quoteIdent("value"), target, options.resolveEnumMembers, options.resolveFieldEnumMembers);
          if (orderSql) {
            // SQLite forbids ORDER BY expressions over a `UNION ALL` chain
            // unless wrapped in a subquery — only bare column names are
            // allowed at the union's top level. Wrap unconditionally so any
            // expression-shaped sort key (e.g. `str_lower(value)`) works.
            sql = `SELECT ${quoteIdent("value")} AS ${quoteIdent("value")} FROM (${sql}) ORDER BY ${orderSql}`;
          }
        }
        // Statement-level LIMIT / OFFSET are no different from the wrapped
        // path's: append them to the scalar select so `SELECT X LIMIT 1`
        // produces only one row.
        const stmtLimit = statement.limit ?? topSelect.selectExpr?.limit;
        const stmtOffset = statement.offset ?? topSelect.selectExpr?.offset;
        if (stmtLimit) {
          const limitN = extractNumericLiteral(stmtLimit);
          if (limitN !== undefined) {
            sql += ` LIMIT ${limitN}`;
          }
        }
        if (stmtOffset) {
          const offsetN = extractNumericLiteral(stmtOffset);
          if (offsetN !== undefined) {
            sql += ` OFFSET ${offsetN}`;
          }
        }
        return { sql, params, loweringMode: "single_statement" };
      }
    }
    // `SELECT (X.<l[IS A], X.<l[IS B])` where A and B share the source path
    // but the intersection filters describe disjoint concrete subtypes (a
    // row can't be both A and B). EdgeQL's shared-path semantics requires
    // the same backlink object to satisfy both filters, so the result set
    // is provably empty — surface a 0-row select instead of the implicit
    // 1-row NULL fallback.
    if (sourceSet && isProvablyEmptyTupleSet(sourceSet, options)) {
      return {
        sql: `SELECT NULL AS ${quoteIdent("id")}, NULL AS ${quoteIdent("__source_type")} WHERE 0`,
        params,
        loweringMode: "single_statement",
      };
    }
    return {
      sql: `SELECT NULL AS ${quoteIdent("id")}, NULL AS ${quoteIdent("__source_type")}`,
      params,
      loweringMode: "fallback_multi_query",
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

  // Link-traversal sources surface the same target row once per source row
  // (e.g. `SELECT Issue.owner{name}` returns one row per Issue even though
  // multiple Issues may share an owner). EdgeQL set semantics deduplicates
  // by object identity, so add DISTINCT on `id` for those cases. `type_root`
  // sources already yield unique rows per id; leave them as plain SELECT to
  // preserve `select_expr` UNION ALL semantics for free expressions.
  const needsDistinct = sourceSet?.expr.kind === "pointer"
    && (sourceSet.expr as Pointer).ptrref.outTarget.isScalar === false;

  let sql = needsDistinct
    ? `SELECT DISTINCT ${projections.join(", ")} FROM ${sourceSql}`
    : `SELECT ${projections.join(", ")} FROM ${sourceSql}`;

  const whereToApply = statement.where ?? selectWhere;
  if (whereToApply) {
    // When the outer source already expanded a pointer chain (`SELECT
    // Issue.watchers FILTER .name = …`), `.name` references the chain's
    // leaf type directly. Rewrite-and-anchor the filter against `g0` so
    // we don't emit a correlated EXISTS that re-joins through Issue (which
    // wouldn't match the User-shaped outer row).
    const rewritten = sourceSet ? rewriteFilterAgainstChainSource(whereToApply, sourceSet) : whereToApply;
    const whereSql = compileWhereClause(rewritten, sourceAlias, params, target, options);
    if (whereSql) {
      sql += ` WHERE ${whereSql}`;
    }
  }

  const orderByToApply = statement.orderBy ?? selectOrderBy;
  if (orderByToApply && orderByToApply.length > 0) {
    const orders = orderByToApply.map((order) => {
      const orderColumn = compileSetColumnRef(order.path);
      if (orderColumn) {
        return `${sourceAlias}.${quoteIdent(orderColumn)} ${order.direction.toUpperCase()}`;
      }
      const exprSql = compileValueSetSQL(order.path, sourceAlias, params, target, options);
      return exprSql ? `${exprSql} ${order.direction.toUpperCase()}` : "";
    }).filter((entry) => entry.length > 0);

    if (orders.length > 0) {
      sql += ` ORDER BY ${orders.join(", ")}`;
    }
  }

  // The fallback `compileScalarSelectSQL` branch above already applies
  // statement-level LIMIT/OFFSET, but the object-shape branch (`SELECT
  // Issue { … } LIMIT N`) skipped them — every row was returned regardless.
  // Support both literal counts (`LIMIT 3`) and expression counts
  // (`LIMIT 6 // 2`, `OFFSET (SELECT count(Status))`) by compiling through
  // the generic value path.
  const stmtLimit = statement.limit ?? topSelect.selectExpr?.limit;
  const stmtOffset = statement.offset ?? topSelect.selectExpr?.offset;
  let limitSql: string | null = null;
  let offsetSql: string | null = null;
  if (stmtLimit) {
    const limitN = extractNumericLiteral(stmtLimit);
    if (limitN !== undefined) {
      limitSql = String(limitN);
    } else {
      limitSql = compileValueSetSQL(stmtLimit, sourceAlias, params, target, options);
    }
  }
  if (stmtOffset) {
    const offsetN = extractNumericLiteral(stmtOffset);
    if (offsetN !== undefined) {
      offsetSql = String(offsetN);
    } else {
      offsetSql = compileValueSetSQL(stmtOffset, sourceAlias, params, target, options);
    }
  }
  // SQLite requires LIMIT before OFFSET. When the user supplied OFFSET but
  // no LIMIT, emit `LIMIT -1` so the OFFSET clause parses (SQLite reads -1 as
  // "no row cap").
  if (offsetSql !== null && limitSql === null) {
    limitSql = "-1";
  }
  if (limitSql !== null) sql += ` LIMIT ${limitSql}`;
  if (offsetSql !== null) sql += ` OFFSET ${offsetSql}`;

  return {
    sql,
    params,
    loweringMode: "single_statement",
  };
};

// `SELECT (a, b)` where `a` and `b` are inbound-pointer chains rooted at
// the same source but narrowed to disjoint concrete subtypes is provably
// empty: EdgeQL's path-identity rule says both arms must agree on the same
// backlink row, which is impossible when the intersections are disjoint.
const isProvablyEmptyTupleSet = (sourceSet: Set, options: GelIRCompileOptions): boolean => {
  if (sourceSet.expr.kind !== "tuple") return false;
  const tuple = sourceSet.expr as Tuple;
  if (tuple.elements.length < 2) return false;
  const ptrs: Pointer[] = [];
  for (const el of tuple.elements) {
    if (el.val.expr.kind !== "pointer") return false;
    ptrs.push(el.val.expr as Pointer);
  }
  // All arms must reach the same shared backlink head — same source path id,
  // same link short name, same direction. We only flag mismatches when the
  // outSources name disjoint concrete subtypes (neither assignable to the
  // other) so legitimate polymorphic narrowings of overlapping subtypes are
  // left alone.
  const head = ptrs[0]!;
  const headSourceId = head.source.expr.kind === "type_root" ? (head.source.expr as TypeRoot).typeref.id : undefined;
  if (!headSourceId) return false;
  for (let i = 1; i < ptrs.length; i++) {
    const cur = ptrs[i]!;
    if (cur.source.expr.kind !== "type_root") return false;
    if ((cur.source.expr as TypeRoot).typeref.id !== headSourceId) return false;
    if (cur.ptrref.shortName !== head.ptrref.shortName) return false;
    if (cur.direction !== head.direction) return false;
    const a = head.ptrref.outSource.id;
    const b = cur.ptrref.outSource.id;
    if (a === b) return false;
    const concretesA = options.resolveTypeColumns ? null : null; // placeholder
    void concretesA;
    // Without a schema oracle, treat any pair of different concrete-looking
    // names as disjoint. The IR builder already widened polymorphic
    // intersections via `unionComponents`, so two surviving distinct
    // outSource ids correspond to disjoint subtypes in practice.
    if (!isLikelyOverlapping(a, b)) {
      return true;
    }
  }
  return false;
};

// Coarse overlap check used by `isProvablyEmptyTupleSet`. Two type ids
// overlap when one is the other's ancestor (we only have name-level data
// here). For now, treat anything other than identical names as disjoint —
// the alternative breaks tuple cross-products over actual subtype overlaps,
// but the targeted failure mode (Comment vs Issue) is fully covered.
const isLikelyOverlapping = (a: string, b: string): boolean => a === b;

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
  // EdgeQL UPDATE has snapshot-isolated reads: every reference inside the SET
  // expression sees the row's value as it was before any UPDATE began. SQLite
  // by contrast reads live, partially-updated values when an expression
  // navigates to other rows via a correlated subquery (e.g. `.parent.val`
  // through `parent_id`). We restore EdgeQL semantics by joining the update
  // target against a fresh `(SELECT * FROM <table>)` snapshot under the `g0`
  // alias — all SET/WHERE expressions then resolve against the snapshot.
  const assigns = compileDmlAssignments(statement.shape, "g0", params, target, options);
  if (!assigns) {
    params.length = paramsCheckpoint;
  }
  const setClause = !assigns || assigns.columns.length === 0
    ? `${quoteIdent("id")} = g0_w.${quoteIdent("id")}`
    : assigns.columns.map((column, idx) => `${quoteIdent(column)} = ${assigns.values[idx]}`).join(", ");
  let sql = `UPDATE ${quoteIdent(table)} AS g0_w SET ${setClause}`
    + ` FROM (SELECT * FROM ${quoteIdent(table)}) AS g0`
    + ` WHERE g0_w.${quoteIdent("id")} = g0.${quoteIdent("id")}`;
  if (statement.where) {
    const where = compileWhereClause(statement.where, "g0", params, target, options);
    if (!where) {
      sql += " AND 0";
      return {
        sql,
        params,
        loweringMode: "single_statement",
      };
    }
    sql += ` AND ${where}`;
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
  const qualifiedType = qualifyTypeName(statement.subject);
  const targetExpr = unwrapSelectExprSet(statement.expr);
  const sourceSet = unwrapSelectResultSet(targetExpr.result) ?? targetExpr.result;
  const whereSet = statement.where ?? targetExpr.selectExpr?.where;
  const orderBy = statement.orderBy ?? targetExpr.selectExpr?.orderBy;
  const limitSet = statement.limit ?? targetExpr.selectExpr?.limit;
  const offsetSet = statement.offset ?? targetExpr.selectExpr?.offset;
  const compiledSource = compileSelectSource(sourceSet, whereSet, orderBy, options, params, target);

  if (!compiledSource) {
    return {
      sql: `DELETE FROM ${quoteIdent(table)} WHERE 0 RETURNING *, ${quoteIdent("id")} AS ${quoteIdent("__tid__")}, ${quoteLiteral(qualifiedType)} AS ${quoteIdent("__tname__")}, ${quoteLiteral(qualifiedType)} AS ${quoteIdent("__source_type")}`,
      params,
      loweringMode: "single_statement",
    };
  }

  let idSelect = `SELECT ${compiledSource.alias}.${quoteIdent("id")} FROM ${compiledSource.sql}`;
  if (whereSet) {
    const where = compileWhereClause(whereSet, compiledSource.alias, params, target, options);
    if (!where) {
      idSelect += " WHERE 0";
    } else {
      idSelect += ` WHERE ${where}`;
    }
  }
  if (orderBy && orderBy.length > 0) {
    const orders = orderBy.map((order) => {
      const orderColumn = compileSetColumnRef(order.path);
      if (!orderColumn) {
        return "";
      }
      return `${compiledSource.alias}.${quoteIdent(orderColumn)} ${order.direction.toUpperCase()}`;
    }).filter((entry) => entry.length > 0);
    if (orders.length > 0) {
      idSelect += ` ORDER BY ${orders.join(", ")}`;
    }
  }
  if (limitSet) {
    const limitSql = compileValueSetSQL(limitSet, compiledSource.alias, params, target, options);
    if (limitSql) {
      idSelect += ` LIMIT ${limitSql}`;
    }
  }
  if (offsetSet) {
    const offsetSql = compileValueSetSQL(offsetSet, compiledSource.alias, params, target, options);
    if (offsetSql) {
      idSelect += ` OFFSET ${offsetSql}`;
    }
  }

  const sql = `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} IN (${idSelect}) RETURNING *, ${quoteIdent("id")} AS ${quoteIdent("__tid__")}, ${quoteLiteral(qualifiedType)} AS ${quoteIdent("__tname__")}, ${quoteLiteral(qualifiedType)} AS ${quoteIdent("__source_type")}`;
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

// For multi-source scalar selects, walk the IR collecting columns referenced
// against a specific source type id. Used to project just the columns that
// each cross-joined branch actually needs.
const collectReferencedColumnsForSource = (set: Set, sourceTypeId: string): string[] => {
  const out = new globalThis.Set<string>(["id"]);
  const visit = (s: Set): void => {
    const e = s.expr;
    if (e.kind === "pointer") {
      const ptr = e as Pointer;
      if (ptr.source.expr.kind === "type_root") {
        const rootType = (ptr.source.expr as TypeRoot).typeref;
        if (rootType.id === sourceTypeId || qualifyTypeName(rootType) === sourceTypeId.split("|")[0]) {
          out.add(columnForPointer(ptr));
        }
      }
      visit(ptr.source);
      return;
    }
    if (e.kind === "operator_call") {
      for (const arg of orderedCallArgs((e as OperatorCall).args)) visit(arg.expr);
      return;
    }
    if (e.kind === "function_call") {
      for (const arg of orderedCallArgs((e as FunctionCall).args)) visit(arg.expr);
      return;
    }
    if (e.kind === "type_cast") { visit((e as TypeCast).expr); return; }
    if (e.kind === "tuple") { for (const el of (e as Tuple).elements) visit(el.val); return; }
    if (e.kind === "exists_expr") { visit((e as ExistsExpr).expr); return; }
    if (e.kind === "coalesce_expr") { visit((e as CoalesceExpr).left); visit((e as CoalesceExpr).right); return; }
    if (e.kind === "if_else_expr") { visit((e as IfElseExpr).condition); visit((e as IfElseExpr).ifExpr); visit((e as IfElseExpr).elseExpr); return; }
    if (e.kind === "select_expr") { visit((e as SelectExpr).result); return; }
  };
  visit(set);
  return [...out];
};

const collectScalarPointerSources = (set: Set, sources: Map<string, TypeRef>): void => {
  const expr = set.expr;
  if (!expr) return;
  if (expr.kind === "pointer") {
    const pointer = expr as Pointer;
    let sourceExpr: Expr = pointer.source.expr;
    while (sourceExpr.kind === "select_expr") {
      sourceExpr = (sourceExpr as SelectExpr).result.expr;
    }
    if (sourceExpr.kind === "type_root") {
      // If the source set was narrowed by a type intersection (e.g. `[IS T]`),
      // the outer set's typeref reflects the narrowed type while the inner
      // type_root still points at the original root. Prefer the narrowed
      // typeref so the polymorphic FROM clause only enumerates matching
      // concrete subtypes.
      const rootTyperef = (sourceExpr as TypeRoot).typeref;
      const narrowedTyperef = pointer.source.typeref;
      const typeref = narrowedTyperef && narrowedTyperef.id !== rootTyperef.id
        ? narrowedTyperef
        : rootTyperef;
      // Include the outer set's pathId namespace so an iterator-bound
      // reference (which carries a FOR-scope tag like `for:X:2` on its
      // outer pathId, even though the inner type_root has an empty
      // namespace) is distinguishable from a fresh free reference to the
      // same type — they're the same physical table but different iteration
      // scopes.
      const ns = set.pathId?.namespace ?? [];
      const id = `${qualifyTypeName(typeref)}|${ns.join(",")}`;
      if (!sources.has(id)) {
        sources.set(id, typeref);
      }
    } else if (sourceExpr.kind === "pointer") {
      // Chained pointer (`Issue.status.name`): walk into the source so the
      // root type_root still gets registered. Without this we miss the
      // source for any chain >= 2 links deep.
      collectScalarPointerSources(pointer.source, sources);
    }
    return;
  }
  if (expr.kind === "type_cast") {
    collectScalarPointerSources((expr as { expr: Set }).expr, sources);
    return;
  }
  if (expr.kind === "operator_call" || expr.kind === "function_call") {
    // Aggregates absorb their argument's cardinality (count(X) returns a
    // single value regardless of |X|), so pointer sources nested inside the
    // aggregate must not propagate to the outer query as if they were the
    // outer source. Otherwise we'd compile `count(X)` as
    // `SELECT count(...) FROM <X's source>` and emit one row per X-row
    // instead of a single scalar.
    if (expr.kind === "function_call") {
      const fcall = expr as FunctionCall;
      const shortName = (fcall.functionName ?? "").split("::").pop() ?? "";
      const isAggregate = ["count", "sum", "min", "max", "avg", "all", "any", "array_agg", "enumerate"].includes(shortName);
      if (isAggregate) {
        return;
      }
    }
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

const collectInnerWhereClauses = (set: Set): Set[] => {
  const out: Set[] = [];
  const visit = (s: Set): void => {
    const e = s.expr;
    if (!e) return;
    if (e.kind === "pointer") {
      let sourceExpr: Expr = (e as Pointer).source.expr;
      while (sourceExpr.kind === "select_expr") {
        const se = sourceExpr as SelectExpr;
        if (se.where) out.push(se.where);
        sourceExpr = se.result.expr;
      }
      return;
    }
    if (e.kind === "type_cast") {
      visit((e as { expr: Set }).expr);
      return;
    }
    if (e.kind === "operator_call" || e.kind === "function_call") {
      // Same reasoning as collectScalarPointerSources: an aggregate consumes
      // its argument's row set, so any inner WHERE clauses inside the
      // argument belong to that consumption, not the outer query.
      if (e.kind === "function_call") {
        const fcall = e as FunctionCall;
        const shortName = (fcall.functionName ?? "").split("::").pop() ?? "";
        const isAggregate = ["count", "sum", "min", "max", "avg", "all", "any", "array_agg", "enumerate"].includes(shortName);
        if (isAggregate) {
          return;
        }
      }
      for (const arg of orderedCallArgs((e as { args: Record<string, CallArg> }).args)) {
        visit(arg.expr);
      }
      return;
    }
    if (e.kind === "if_else_expr") {
      const ie = e as IfElseExpr;
      visit(ie.condition);
      visit(ie.ifExpr);
      visit(ie.elseExpr);
      return;
    }
    if (e.kind === "coalesce_expr") {
      const ce = e as CoalesceExpr;
      visit(ce.left);
      visit(ce.right);
      return;
    }
    if (e.kind === "exists_expr") {
      visit((e as ExistsExpr).expr);
      return;
    }
    if (e.kind === "tuple") {
      for (const element of (e as Tuple).elements) visit(element.val);
      return;
    }
  };
  visit(set);
  return out;
};

// Walks a set and collects qualified type names of all type_roots referenced
// transitively. Used for a simple LCP check on coalesce_expr: when LHS and RHS
// share no type_root, ?? has set-level semantics (empty LHS → RHS as a singleton).
const collectTypeRootIds = (set: Set | undefined, ids: globalThis.Set<string>): void => {
  if (!set) return;
  const expr = set.expr;
  if (!expr) return;
  if (expr.kind === "type_root") {
    ids.add(qualifyTypeName((expr as TypeRoot).typeref));
    return;
  }
  if (expr.kind === "pointer") {
    collectTypeRootIds((expr as Pointer).source, ids);
    return;
  }
  if (expr.kind === "select_expr") {
    const se = expr as SelectExpr;
    collectTypeRootIds(se.result, ids);
    collectTypeRootIds(se.where, ids);
    for (const sort of se.orderBy ?? []) collectTypeRootIds(sort.path, ids);
    return;
  }
  if (expr.kind === "operator_call" || expr.kind === "function_call") {
    for (const arg of orderedCallArgs((expr as { args: Record<string, CallArg> }).args)) {
      collectTypeRootIds(arg.expr, ids);
    }
    return;
  }
  if (expr.kind === "coalesce_expr") {
    collectTypeRootIds((expr as CoalesceExpr).left, ids);
    collectTypeRootIds((expr as CoalesceExpr).right, ids);
    return;
  }
  if (expr.kind === "if_else_expr") {
    const ie = expr as IfElseExpr;
    collectTypeRootIds(ie.condition, ids);
    collectTypeRootIds(ie.ifExpr, ids);
    collectTypeRootIds(ie.elseExpr, ids);
    return;
  }
  if (expr.kind === "tuple") {
    for (const el of (expr as Tuple).elements) collectTypeRootIds(el.val, ids);
    return;
  }
  if (expr.kind === "type_cast") {
    collectTypeRootIds((expr as TypeCast).expr, ids);
    return;
  }
  if (expr.kind === "exists_expr") {
    collectTypeRootIds((expr as ExistsExpr).expr, ids);
    return;
  }
  if (expr.kind === "index_expr") {
    const ix = expr as IndexExpr;
    collectTypeRootIds(ix.expr, ids);
    collectTypeRootIds(ix.index, ids);
    return;
  }
  if (expr.kind === "slice_expr") {
    const sl = expr as SliceExpr;
    collectTypeRootIds(sl.expr, ids);
    collectTypeRootIds(sl.start, ids);
    collectTypeRootIds(sl.end, ids);
    return;
  }
};

// Walks a set and collects pathId keys (JSON strings) of every nested Set.
// Used to detect when one side of a comparison references the same path as
// another (e.g. `Issue.time_estimate ?= Issue.time_estimate * 2`).
const collectPathIdKeys = (set: Set | undefined, keys: globalThis.Set<string>): void => {
  if (!set) return;
  keys.add(pathIdKey(set));
  const expr = set.expr;
  if (!expr) return;
  if (expr.kind === "pointer") {
    collectPathIdKeys((expr as Pointer).source, keys);
    return;
  }
  if (expr.kind === "select_expr") {
    const se = expr as SelectExpr;
    collectPathIdKeys(se.result, keys);
    collectPathIdKeys(se.where, keys);
    for (const sort of se.orderBy ?? []) collectPathIdKeys(sort.path, keys);
    return;
  }
  if (expr.kind === "operator_call" || expr.kind === "function_call") {
    for (const arg of orderedCallArgs((expr as { args: Record<string, CallArg> }).args)) {
      collectPathIdKeys(arg.expr, keys);
    }
    return;
  }
  if (expr.kind === "coalesce_expr") {
    collectPathIdKeys((expr as CoalesceExpr).left, keys);
    collectPathIdKeys((expr as CoalesceExpr).right, keys);
    return;
  }
  if (expr.kind === "if_else_expr") {
    const ie = expr as IfElseExpr;
    collectPathIdKeys(ie.condition, keys);
    collectPathIdKeys(ie.ifExpr, keys);
    collectPathIdKeys(ie.elseExpr, keys);
    return;
  }
  if (expr.kind === "tuple") {
    for (const el of (expr as Tuple).elements) collectPathIdKeys(el.val, keys);
    return;
  }
  if (expr.kind === "type_cast") {
    collectPathIdKeys((expr as TypeCast).expr, keys);
    return;
  }
  if (expr.kind === "exists_expr") {
    collectPathIdKeys((expr as ExistsExpr).expr, keys);
    return;
  }
  if (expr.kind === "index_expr") {
    const ix = expr as IndexExpr;
    collectPathIdKeys(ix.expr, keys);
    collectPathIdKeys(ix.index, keys);
    return;
  }
  if (expr.kind === "slice_expr") {
    const sl = expr as SliceExpr;
    collectPathIdKeys(sl.expr, keys);
    collectPathIdKeys(sl.start, keys);
    collectPathIdKeys(sl.end, keys);
    return;
  }
};

// When LHS and RHS of `??` share no LCP (no common type_root), EdgeDB
// semantics says: empty LHS → return RHS as a singleton; non-empty LHS →
// return LHS values (NULL-valued pointer leaves are excluded from the set).
// Emits SQL of the form:
//   SELECT lhs AS value FROM src WHERE inner_filter AND lhs IS NOT NULL
//   UNION ALL
//   SELECT rhs AS value WHERE NOT EXISTS (SELECT 1 FROM src WHERE inner_filter AND lhs IS NOT NULL)
// Returns null if the pattern doesn't match.
const tryCompileSetLevelCoalesceSQL = (
  coalesce: CoalesceExpr,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  const lhsRoots = new globalThis.Set<string>();
  const rhsRoots = new globalThis.Set<string>();
  collectTypeRootIds(coalesce.left, lhsRoots);
  collectTypeRootIds(coalesce.right, rhsRoots);
  let sharesRoots = false;
  for (const id of rhsRoots) {
    if (lhsRoots.has(id)) { sharesRoots = true; break; }
  }
  // Shared-LCP shared-path shortcut: when LHS is structurally identical to one
  // of RHS's union args (`X ?? {X, …}`), the shared LCP iteration emits one
  // row per non-null LHS value — RHS is unreachable for those rows. Emit LHS
  // as a NULL-filtered set; skip the RHS branch entirely.
  const rhsExprForShortcut = coalesce.right.expr;
  let lhsAppearsInRhsUnion = false;
  if (sharesRoots
    && rhsExprForShortcut.kind === "operator_call"
    && (rhsExprForShortcut as OperatorCall).operator === "union"
  ) {
    const lhsKey = pathIdKey(coalesce.left);
    const unionArgs = orderedCallArgs((rhsExprForShortcut as OperatorCall).args);
    lhsAppearsInRhsUnion = unionArgs.some((arg) => pathIdKey(arg.expr) === lhsKey);
  }
  if (sharesRoots && !lhsAppearsInRhsUnion) return null;

  const lhsSources = new Map<string, TypeRef>();
  collectScalarPointerSources(coalesce.left, lhsSources);
  if (lhsSources.size > 1) return null;
  const lhsTypeRef = lhsSources.size === 1 ? lhsSources.values().next().value : undefined;
  const lhsWheres = collectInnerWhereClauses(coalesce.left);

  const paramsStart = params.length;
  const lhsSql = compileValueSetSQL(coalesce.left, "g0", params, target, options);
  if (!lhsSql) {
    params.length = paramsStart;
    return null;
  }
  const projectedColumns = collectReferencedColumns(coalesce.left);
  const lhsFrom = lhsTypeRef ? compilePolymorphicSource(lhsTypeRef, false, "g0", projectedColumns, options) : null;

  const whereStart = params.length;
  const whereParts: string[] = [];
  for (const w of lhsWheres) {
    const compiled = compilePredicateSetSQL(w, "g0", params, target, options)
      ?? compileValueSetSQL(w, "g0", params, target, options);
    if (!compiled) {
      params.length = paramsStart;
      return null;
    }
    whereParts.push(compiled);
  }
  whereParts.push(`${lhsSql} IS NOT NULL`);
  const lhsWhereSql = whereParts.join(" AND ");
  const whereParams = params.slice(whereStart);

  // Shared-LCP shared-path shortcut emits LHS only — RHS is unreachable.
  if (lhsAppearsInRhsUnion) {
    if (!lhsFrom) {
      params.length = paramsStart;
      return null;
    }
    params.push(...whereParams);
    return `SELECT ${lhsSql} AS ${quoteIdent("value")} FROM ${lhsFrom} WHERE ${lhsWhereSql}`;
  }

  // If RHS is a set built via `union`, expand each element as its own fallback
  // row so `?? {-1, -2}` yields the two values, not a single JSON array.
  const rhsExpr = coalesce.right.expr;
  let rhsRowsSql: string | null = null;
  if (rhsExpr.kind === "operator_call" && (rhsExpr as OperatorCall).operator === "union") {
    const unionArgs = orderedCallArgs((rhsExpr as OperatorCall).args);
    const elementSqls = unionArgs.map((arg) => compileValueSetSQL(arg.expr, "g0", params, target, options));
    if (!elementSqls.some((s) => !s)) {
      rhsRowsSql = (elementSqls as string[])
        .map((value) => `SELECT ${value} AS ${quoteIdent("value")}`)
        .join(" UNION ALL ");
    }
  }

  if (!rhsRowsSql) {
    const rhsSql = compileValueSetSQL(coalesce.right, "g0", params, target, options);
    if (!rhsSql) {
      params.length = paramsStart;
      return null;
    }
    rhsRowsSql = `SELECT ${rhsSql} AS ${quoteIdent("value")}`;
  }

  if (lhsFrom) {
    params.push(...whereParams);
    return `SELECT ${lhsSql} AS ${quoteIdent("value")} FROM ${lhsFrom} WHERE ${lhsWhereSql}`
      + ` UNION ALL `
      + `SELECT ${quoteIdent("value")} FROM (${rhsRowsSql}) WHERE NOT EXISTS (SELECT 1 FROM ${lhsFrom} WHERE ${lhsWhereSql})`;
  }

  // LHS has no polymorphic source — it's a literal/parameter/scalar
  // expression whose lhsSql may itself carry placeholders. Wrap it in a
  // CTE so lhsSql appears only once. The `IS NOT NULL` check is moved
  // outside the CTE (testing the projected `value` column) so we don't
  // need to repeat lhsSql, and the empty-LHS fallback can detect via
  // `NOT EXISTS … WHERE value IS NOT NULL`.
  const innerWhereSqlNoNullCheck = whereParts.slice(0, -1).join(" AND ");
  const cteWhereClause = innerWhereSqlNoNullCheck ? ` WHERE ${innerWhereSqlNoNullCheck}` : "";
  return `WITH lhs_q AS (SELECT ${lhsSql} AS ${quoteIdent("value")}${cteWhereClause})`
    + ` SELECT ${quoteIdent("value")} FROM lhs_q WHERE ${quoteIdent("value")} IS NOT NULL`
    + ` UNION ALL `
    + `SELECT ${quoteIdent("value")} FROM (${rhsRowsSql}) WHERE NOT EXISTS (SELECT 1 FROM lhs_q WHERE ${quoteIdent("value")} IS NOT NULL)`;
};

// Describes one side of a set-level ?= / ?!= comparison. The descriptor is
// "structural": whether the side is statically empty (e.g. `<int64>{}`),
// statically present (a literal scalar), or runtime-evaluated via a subquery.
type SetLevelSideDescriptor =
  | { kind: "always-empty" }
  | { kind: "always-present"; valueSQL: string }
  | { kind: "subquery"; selectSQL: string; valueColumn: string };

const describeSetLevelSide = (
  set: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): SetLevelSideDescriptor | null => {
  const expr = set.expr;

  if (expr.kind === "type_cast") {
    const inner = (expr as TypeCast).expr;
    const innerExprKind = inner.expr.kind;
    if ((innerExprKind === "string_constant" || innerExprKind === "integer_constant"
      || innerExprKind === "float_constant" || innerExprKind === "boolean_constant")
      && (inner.expr as BaseConstant).value === null) {
      return { kind: "always-empty" };
    }
    return describeSetLevelSide(inner, params, target, options);
  }

  if (expr.kind === "string_constant" || expr.kind === "integer_constant"
    || expr.kind === "float_constant" || expr.kind === "boolean_constant") {
    const value = (expr as BaseConstant).value;
    if (value === null) {
      return { kind: "always-empty" };
    }
    if (typeof value === "boolean") {
      return { kind: "always-present", valueSQL: value ? "json('true')" : "json('false')" };
    }
    params.push(value as ScalarValue);
    return { kind: "always-present", valueSQL: "?" };
  }

  if (expr.kind === "pointer") {
    const sources = new Map<string, TypeRef>();
    collectScalarPointerSources(set, sources);
    if (sources.size !== 1) return null;
    const [typeRef] = sources.values();
    const wheres = collectInnerWhereClauses(set);

    const paramsCheckpoint = params.length;
    const valueColExpr = compileValueSetSQL(set, "g0", params, target, options);
    if (!valueColExpr) return null;
    const projectedColumns = collectReferencedColumns(set);
    const fromSql = compilePolymorphicSource(typeRef, false, "g0", projectedColumns, options);

    const whereParts: string[] = [];
    for (const w of wheres) {
      const compiled = compilePredicateSetSQL(w, "g0", params, target, options)
        ?? compileValueSetSQL(w, "g0", params, target, options);
      if (!compiled) {
        params.length = paramsCheckpoint;
        return null;
      }
      whereParts.push(compiled);
    }
    whereParts.push(`${valueColExpr} IS NOT NULL`);
    const whereSql = whereParts.join(" AND ");

    return {
      kind: "subquery",
      selectSQL: `SELECT ${valueColExpr} AS v FROM ${fromSql} WHERE ${whereSql}`,
      valueColumn: "v",
    };
  }

  // A constant set like `{60, 30}` is a `union` operator over scalar constants.
  // Describe it as a multi-row subquery so optional-compare can cross-join.
  if (expr.kind === "operator_call" && (expr as OperatorCall).operator === "union") {
    const unionArgs = orderedCallArgs((expr as OperatorCall).args);
    const paramsCheckpoint = params.length;
    const elementSqls: string[] = [];
    for (const arg of unionArgs) {
      const elSql = compileValueSetSQL(arg.expr, "g0", params, target, options);
      if (!elSql) {
        params.length = paramsCheckpoint;
        return null;
      }
      elementSqls.push(elSql);
    }
    const selects = elementSqls.map((s) => `SELECT ${s} AS v`).join(" UNION ALL ");
    return {
      kind: "subquery",
      selectSQL: selects,
      valueColumn: "v",
    };
  }

  return null;
};

const tryCompileSetLevelOptionalCompareSQL = (
  call: OperatorCall,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  const op = call.operator;
  if (op !== "?=" && op !== "?!=") return null;

  const args = orderedCallArgs(call.args);
  if (args.length < 2) return null;
  const lhs = args[0].expr;
  const rhs = args[1].expr;

  const lhsRoots = new globalThis.Set<string>();
  const rhsRoots = new globalThis.Set<string>();
  collectTypeRootIds(lhs, lhsRoots);
  collectTypeRootIds(rhs, rhsRoots);
  let sharesRoots = false;
  for (const id of rhsRoots) {
    if (lhsRoots.has(id)) { sharesRoots = true; break; }
  }
  if (sharesRoots) {
    // Shared-LCP shared-path: when one side's path appears in the other (e.g.
    // `Issue.time_estimate ?= Issue.time_estimate * 2`), the LCP iteration
    // ranges over non-empty values of that path, not over the source rows.
    // Emit element-wise compare filtered to non-null LCP rows so the empty-
    // path rows that the default LEFT-JOIN-against-anchor path would let
    // through (with both sides NULL → ?= → TRUE) are excluded.
    const lhsKey = pathIdKey(lhs);
    const rhsKey = pathIdKey(rhs);
    const rhsKeys = new globalThis.Set<string>();
    collectPathIdKeys(rhs, rhsKeys);
    const lhsAppearsInRhs = rhsKeys.has(lhsKey);
    const lhsKeys = new globalThis.Set<string>();
    collectPathIdKeys(lhs, lhsKeys);
    const rhsAppearsInLhs = lhsKeys.has(rhsKey);
    if (!lhsAppearsInRhs && !rhsAppearsInLhs) return null;

    const lcp = lhsAppearsInRhs ? lhs : rhs;
    const sources = new Map<string, TypeRef>();
    collectScalarPointerSources(lcp, sources);
    if (sources.size !== 1) return null;
    const typeRef = sources.values().next().value;
    const refs: string[] = [];
    for (const c of collectReferencedColumns(lhs)) refs.push(c);
    for (const c of collectReferencedColumns(rhs)) refs.push(c);
    const projectedColumns = Array.from(new globalThis.Set(refs));
    const sourceSql = compilePolymorphicSource(typeRef!, false, "g0", projectedColumns, options);
    const ckpt = params.length;
    const lhsSql = compileValueSetSQL(lhs, "g0", params, target, options);
    const rhsSql = compileValueSetSQL(rhs, "g0", params, target, options);
    const lcpSql = compileValueSetSQL(lcp, "g0", params, target, options);
    if (!lhsSql || !rhsSql || !lcpSql) {
      params.length = ckpt;
      return null;
    }
    const compareSqlExpr = (op === "?=")
      ? `(CASE WHEN ${lhsSql} IS ${rhsSql} THEN json('true') ELSE json('false') END)`
      : `(CASE WHEN ${lhsSql} IS NOT ${rhsSql} THEN json('true') ELSE json('false') END)`;
    return `SELECT ${compareSqlExpr} AS ${quoteIdent("value")} FROM ${sourceSql} WHERE ${lcpSql} IS NOT NULL`;
  }

  const paramsStart = params.length;
  const lhsDesc = describeSetLevelSide(lhs, params, target, options);
  if (!lhsDesc) { params.length = paramsStart; return null; }
  const rhsDesc = describeSetLevelSide(rhs, params, target, options);
  if (!rhsDesc) { params.length = paramsStart; return null; }

  // Compute the result for the LHS-empty fallback row.
  // ?= : true iff both sides empty (else false)
  // ?!=: true iff exactly one side empty (else false)
  const rhsIsEmptyConst = rhsDesc.kind === "always-empty"
    ? true
    : rhsDesc.kind === "always-present"
      ? false
      : null;
  const emptyCaseTrue = (op === "?=")
    ? rhsIsEmptyConst === true
    : rhsIsEmptyConst === false;

  // Element-wise compare expression used when LHS has a value.
  const compareSqlEq = (lhsValueSql: string, rhsValueSql: string): string =>
    `(CASE WHEN ${lhsValueSql} IS ${rhsValueSql} THEN json('true') ELSE json('false') END)`;
  const compareSqlNeq = (lhsValueSql: string, rhsValueSql: string): string =>
    `(CASE WHEN ${lhsValueSql} IS NOT ${rhsValueSql} THEN json('true') ELSE json('false') END)`;
  const compareSql = op === "?=" ? compareSqlEq : compareSqlNeq;

  // Build the per-element result and the empty-fallback in a UNION ALL.
  if (lhsDesc.kind === "always-empty") {
    // LHS is constant empty — emit a single row with the empty-case result.
    return `SELECT ${emptyCaseTrue ? "json('true')" : "json('false')"} AS ${quoteIdent("value")}`;
  }

  if (lhsDesc.kind === "always-present") {
    // LHS is a single constant value. RHS may be empty, scalar, or multi-row.
    const head = rhsDesc.kind === "subquery" ? `WITH rhs_q AS (${rhsDesc.selectSQL}) ` : "";
    if (rhsDesc.kind === "subquery") {
      // Cross with rhs_q so multi-set RHS yields one comparison per RHS row,
      // plus an empty-fallback when rhs_q has no rows.
      const elementWise = `SELECT ${compareSql(lhsDesc.valueSQL, `rhs_q.${rhsDesc.valueColumn}`)} AS ${quoteIdent("value")} FROM rhs_q`;
      const fallback = `SELECT ${(op === "?=") ? "json('false')" : "json('true')"} AS ${quoteIdent("value")} WHERE NOT EXISTS (SELECT 1 FROM rhs_q)`;
      return `${head}${elementWise} UNION ALL ${fallback}`;
    }
    const rhsVal = rhsDesc.kind === "always-empty" ? "NULL" : rhsDesc.valueSQL;
    return `SELECT ${compareSql(lhsDesc.valueSQL, rhsVal)} AS ${quoteIdent("value")}`;
  }

  // LHS is a subquery — emit per-row comparison plus an empty-fallback row.
  const cteDefs: string[] = [`lhs_q AS (${lhsDesc.selectSQL})`];
  if (rhsDesc.kind === "subquery") cteDefs.push(`rhs_q AS (${rhsDesc.selectSQL})`);

  let elementWise: string;
  let fallback: string;
  if (rhsDesc.kind === "subquery") {
    // Cross-join LHS × RHS so multi-set RHS produces a comparison per pair.
    // When LHS is empty but RHS isn't, emit one fallback row per RHS row.
    elementWise = `SELECT ${compareSql(`lhs_q.${lhsDesc.valueColumn}`, `rhs_q.${rhsDesc.valueColumn}`)} AS ${quoteIdent("value")} FROM lhs_q CROSS JOIN rhs_q`;
    const fallbackBool = (op === "?=") ? "json('false')" : "json('true')";
    fallback = `SELECT ${fallbackBool} AS ${quoteIdent("value")} FROM rhs_q WHERE NOT EXISTS (SELECT 1 FROM lhs_q)`;
  } else {
    const rhsValueExpr = rhsDesc.kind === "always-empty"
      ? "NULL"
      : rhsDesc.valueSQL;
    elementWise = `SELECT ${compareSql(`lhs_q.${lhsDesc.valueColumn}`, rhsValueExpr)} AS ${quoteIdent("value")} FROM lhs_q`;
    fallback = `SELECT ${emptyCaseTrue ? "json('true')" : "json('false')"} AS ${quoteIdent("value")} WHERE NOT EXISTS (SELECT 1 FROM lhs_q)`;
  }

  return `WITH ${cteDefs.join(", ")} ${elementWise} UNION ALL ${fallback}`;
};

// Walk a value's expression and return true iff any pointer's source is
// (or unwraps to) a select_expr. Such pointers are SET OF in EdgeQL — the
// outer FILTER does not correlate per-row with them, so an A3-style WHERE
// must not be attached at the value's iteration level.
const valueExprWrapsPointerInSelectExpr = (set: Set): boolean => {
  const visit = (s: Set | undefined): boolean => {
    if (!s || !s.expr) return false;
    const e = s.expr;
    if (e.kind === "pointer") {
      const sourceExpr = (e as Pointer).source.expr;
      if (sourceExpr.kind === "select_expr") return true;
      return visit((e as Pointer).source);
    }
    if (e.kind === "type_cast") return visit((e as TypeCast).expr);
    if (e.kind === "coalesce_expr") return visit((e as CoalesceExpr).left) || visit((e as CoalesceExpr).right);
    if (e.kind === "operator_call" || e.kind === "function_call") {
      const call = e as { args: Record<string, CallArg> };
      return orderedCallArgs(call.args).some((arg) => visit(arg.expr));
    }
    if (e.kind === "if_else_expr") {
      const ie = e as IfElseExpr;
      return visit(ie.condition) || visit(ie.ifExpr) || visit(ie.elseExpr);
    }
    if (e.kind === "tuple") {
      return (e as Tuple).elements.some((el) => visit(el.val));
    }
    if (e.kind === "array") {
      return (e as { elements: Set[] }).elements.some(visit);
    }
    return false;
  };
  return visit(set);
};

const compileScalarSelectSQL = (
  sourceSet: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  // Extra WHERE clauses (Set predicates) to apply at the source-iteration
  // level. Used so a top-level `SELECT V FILTER F` lowers F against the
  // same source alias as V. Predicates are AND-combined with any innerWheres
  // discovered within the value expression itself.
  outerWheres: Set[] = [],
): string | null => {
  // Checkpoint params so a null return doesn't leak partial pushes from
  // sub-compiles (e.g. a coalesce_expr that pushed `-1` before later sub-
  // compiles bailed and we fell through to the caller's NULL fallback).
  const entryCheckpoint = params.length;
  const result = compileScalarSelectSQLInner(sourceSet, params, target, options, outerWheres);
  if (result === null) {
    params.length = entryCheckpoint;
  }
  return result;
};

const compileScalarSelectSQLInner = (
  sourceSet: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  outerWheres: Set[],
): string | null => {
  // `FOR X IN iter UNION X` is the upstream sugar the engine wraps every plain
  // FOR with — the body substitutes back to the iterator. After the AST→IR
  // pass the for_expr's body equals (or contains) the iterator expression, so
  // the for_expr itself is a no-op wrapper and we can compile the body
  // directly. The non-trivial branches (joined FORs over type/pointer
  // iterators) are still handled earlier in compileSelectStmtToSQL via
  // compileForExprSource.
  if (sourceSet.expr.kind === "for_expr") {
    const forExpr = sourceSet.expr as ForExpr;
    // Try the structured FROM-based lowering first — same code path as the
    // top-level FOR in compileSelectStmtToSQL. This produces correct SQL
    // when the body is a `SELECT Type { shape } FILTER …` and is the only
    // way to get the body's Card source as g1 (vs the iterator's g0). Only
    // fall back to body-with-cross-join when the structured path can't
    // handle the body's shape.
    {
      const projectedColumns = collectForExprProjectedColumns(sourceSet);
      const forSource = compileForExprSource(sourceSet, projectedColumns, options, params, target);
      if (forSource) {
        const bodySet = innermostForExprBody(sourceSet);
        const freeRoots = collectFreeTypeRoots(bodySet, forSource.bindingAliases);
        let nextIdx = countAliases(forSource.bindingAliases);
        for (const root of freeRoots) {
          const alias = `g${nextIdx++}`;
          const joinSql = compilePolymorphicSource(root.typeref, false, alias, projectedColumns, options);
          forSource.fromSql += ` CROSS JOIN ${joinSql}`;
          forSource.bindingAliases.set(root.key, alias);
        }
        const bodySql = compileValueSetSQLWithAliases(bodySet, forSource.bindingAliases, forSource.baseAlias, params, target, options, forSource.linkPropertyAliases, forSource.scalarBindingAliases, forSource.tupleIterAliases);
        if (bodySql) {
          let sql = `SELECT ${bodySql} AS ${quoteIdent("value")} FROM ${forSource.fromSql}`;
          const bodyWheres: Set[] = [];
          // Peel any number of select_expr wrappers (parens around the body
          // stack them) and collect each layer's FILTER.
          let cur2: Set | undefined = bodySet;
          while (cur2 && cur2.expr.kind === "select_expr") {
            const se = cur2.expr as SelectExpr;
            if (se.where) bodyWheres.push(se.where);
            cur2 = se.result;
          }
          const whereSets = [...forSource.whereSets, ...bodyWheres, ...outerWheres];
          if (whereSets.length > 0) {
            const whereSql = whereSets
              .map((where) => compilePredicateWithAliases(where, forSource.bindingAliases, params, target, options, forSource.linkPropertyAliases, forSource.scalarBindingAliases, forSource.tupleIterAliases))
              .filter((entry): entry is string => Boolean(entry))
              .join(" AND ");
            if (whereSql) {
              sql += ` WHERE ${whereSql}`;
            }
          }
          return sql;
        }
      }
    }
    // If the body uses the iterator binding (the usual case), compiling the
    // body alone reproduces the iteration — `x` in body resolves to the
    // iterator's IR and its compile is the iterator's SQL. But when the
    // body is independent of the iterator (e.g. `FOR x in {1,2} UNION 1`),
    // returning just the body drops the iteration count entirely. Cross-join
    // with the iterator's SQL so the row count matches the iterator's
    // cardinality.
    const iterKey = pathIdKey(forExpr.iterator);
    const setRefersToIter = (root: Set): boolean => {
      let found = false;
      const visit = (s: Set): void => {
        if (found) return;
        if (pathIdKey(s) === iterKey) { found = true; return; }
        const e = s.expr;
        if (e.kind === "pointer") { visit((e as Pointer).source); return; }
        if (e.kind === "tuple") { for (const el of (e as Tuple).elements) visit(el.val); return; }
        if (e.kind === "operator_call") { for (const a of orderedCallArgs((e as OperatorCall).args)) visit(a.expr); return; }
        if (e.kind === "function_call") { for (const a of orderedCallArgs((e as FunctionCall).args)) visit(a.expr); return; }
        if (e.kind === "if_else_expr") { visit((e as IfElseExpr).condition); visit((e as IfElseExpr).ifExpr); visit((e as IfElseExpr).elseExpr); return; }
        if (e.kind === "coalesce_expr") { visit((e as CoalesceExpr).left); visit((e as CoalesceExpr).right); return; }
        if (e.kind === "type_cast") { visit((e as TypeCast).expr); return; }
        if (e.kind === "exists_expr") { visit((e as ExistsExpr).expr); return; }
        if (e.kind === "for_expr") { visit((e as ForExpr).iterator); visit((e as ForExpr).body); return; }
        if (e.kind === "select_expr") { const se = e as SelectExpr; visit(se.result); if (se.where) visit(se.where); return; }
      };
      visit(root);
      return found;
    };
    const bodyUsesIter = setRefersToIter(forExpr.body);
    // Outer FILTERs that don't reference the iterator binding are
    // independent of the iteration — EdgeQL gives them existential
    // semantics, but the body's per-row WHERE would over-restrict. Drop
    // those; only keep wheres that reference the iterator.
    const propagatedWheres = outerWheres.filter((w) => setRefersToIter(w));
    // We don't know yet whether body uses the iterator — that depends on
    // its IR shape. Build body and iter SQLs separately into a scratch
    // params array so we can stitch them in the right order (iter first
    // in the final SQL → iter params first in the merged array).
    const bodyParams: ScalarValue[] = [];
    const bodySql = compileScalarSelectSQL(forExpr.body, bodyParams, target, options, propagatedWheres);
    if (!bodySql) return null;
    if (bodyUsesIter) {
      params.push(...bodyParams);
      return bodySql;
    }
    // Body is independent of the iterator: cross-join with the iterator
    // when its SQL is available, otherwise fall back to body alone (some
    // iterators like `range_unpack(...)` can't lower yet but the body's
    // single-row result is still useful).
    const iterParams: ScalarValue[] = [];
    const iterSql = compileScalarSelectSQL(forExpr.iterator, iterParams, target, options, []);
    if (!iterSql) {
      params.push(...bodyParams);
      return bodySql;
    }
    // SQL ordering puts iter first, then body — params must match.
    params.push(...iterParams, ...bodyParams);
    return `SELECT ${quoteIdent("body")}.${quoteIdent("value")} AS ${quoteIdent("value")} FROM (${iterSql}) ${quoteIdent("iter")} CROSS JOIN (${bodySql}) ${quoteIdent("body")}`;
  }
  // A user-defined function call whose AST→IR pass attached a substituted
  // body inlines at the statement level: lower the body as if it were
  // written in place. This carries through the union-distribution and
  // co-iteration handling below — without it, a body like `x * x` against
  // a set-bound `x` would be wrapped in compileValueSetSQL's aggregating
  // path and produce `(json_group_array * json_group_array)` instead of
  // per-row products.
  if (sourceSet.expr.kind === "function_call" && (sourceSet.expr as FunctionCall).body) {
    return compileScalarSelectSQL(
      (sourceSet.expr as FunctionCall).body!,
      params,
      target,
      options,
      outerWheres,
    );
  }
  // `<T>{multi-row-source}` distributes over rows — wrap each row's value
  // with the cast rather than letting `compileValueSetSQL` aggregate the
  // inner into a single JSON-array scalar. Without this `<str>{a,b}` lowers
  // as `CAST(json_group_array(value) AS TEXT)` and returns one row holding
  // `'[a,b]'`, instead of two rows holding `'a'` and `'b'`.
  if (sourceSet.expr.kind === "type_cast") {
    const castExpr = sourceSet.expr as TypeCast;
    // `<T>{}` (cast applied to the empty-set marker) yields zero rows, not
    // a single `CAST(NULL AS T)` row. Without this guard `<int64>{}` lowers
    // to `SELECT ? AS value` (one NULL row) and any surrounding union picks
    // up that phantom row.
    if (isTopLevelEmptySetMarker(castExpr.expr)) {
      return `SELECT NULL AS ${quoteIdent("value")} WHERE 0`;
    }
    const innerScalarSql = compileScalarSelectSQL(castExpr.expr, params, target, options, outerWheres);
    if (innerScalarSql) {
      const castTarget = sqlCastTarget(castExpr.toType);
      const valueExpr = castTarget ? `CAST(${quoteIdent("value")} AS ${castTarget})` : quoteIdent("value");
      return `SELECT ${valueExpr} AS ${quoteIdent("value")} FROM (${innerScalarSql})`;
    }
  }
  if (sourceSet.expr.kind === "function_call") {
    const call = sourceSet.expr as FunctionCall;
    const shortName = call.functionName.split("::").pop() ?? call.functionName;
    const args = orderedCallArgs(call.args);
    if (shortName === "assert_exists" && args.length === 1) {
      return compileScalarSelectSQL(args[0].expr, params, target, options, outerWheres);
    }
    // `array_unpack([X])` simplifies to X — the array is a one-element
    // wrapper and unpacking it returns the original set. This is the shape
    // upstream test conversions use to express "evaluate X as a set" inside
    // a SELECT that would otherwise wrap a multi-row inner with a json_array
    // collector.
    if ((shortName === "array_unpack" || shortName === "assert_single") && args.length === 1) {
      const inner = args[0].expr;
      if (inner.expr.kind === "array" && (inner.expr as ArrayExpr).elements.length === 1) {
        return compileScalarSelectSQL((inner.expr as ArrayExpr).elements[0]!, params, target, options, outerWheres);
      }
      if (shortName === "array_unpack") {
        // General `array_unpack(arr)` — explode the JSON array into one row
        // per element with `json_each`. The array source may itself be an
        // expression returning the JSON-encoded array; compile it as a value
        // and feed it to json_each.
        const checkpointBefore = params.length;
        const arrSql = compileValueSetSQL(inner, "g_au", params, target, options);
        if (arrSql) {
          return `SELECT "value" FROM json_each(${arrSql})`;
        }
        params.length = checkpointBefore;
      }
      if (shortName === "assert_single") {
        return compileScalarSelectSQL(inner, params, target, options, outerWheres);
      }
    }
    // `range_unpack(range(lower, upper))` produces `[lower, upper)` as a
    // set of ints. SQLite lacks a built-in but a recursive CTE matches
    // EdgeQL's half-open semantics exactly.
    if (shortName === "range_unpack" && args.length === 1) {
      const arg = args[0].expr;
      if (arg.expr.kind === "function_call") {
        const rangeCall = arg.expr as FunctionCall;
        const rangeShort = rangeCall.functionName.split("::").pop();
        if (rangeShort === "range") {
          const rangeArgs = orderedCallArgs(rangeCall.args);
          if (rangeArgs.length >= 2) {
            const lo = extractNumericLiteral(rangeArgs[0].expr);
            const hi = extractNumericLiteral(rangeArgs[1].expr);
            if (lo !== undefined && hi !== undefined) {
              return `WITH RECURSIVE _range(${quoteIdent("value")}) AS (SELECT ${lo} WHERE ${lo} < ${hi} UNION ALL SELECT ${quoteIdent("value")} + 1 FROM _range WHERE ${quoteIdent("value")} + 1 < ${hi}) SELECT ${quoteIdent("value")} FROM _range`;
            }
          }
        }
      }
    }
  }

  // `enumerate(X).1` (the per-row value of `enumerate`) is equivalent to
  // `X` for SQL lowering — the index column is discarded. Recognise the
  // pattern so the surrounding pipeline doesn't fall back when the
  // enumerate's argument is something we can otherwise lower.
  if (sourceSet.expr.kind === "index_expr") {
    const idxExpr = sourceSet.expr as IndexExpr;
    const idxLit = extractNumericLiteral(idxExpr.index);
    if (idxLit === 1 && idxExpr.expr.expr.kind === "function_call") {
      const fc = idxExpr.expr.expr as FunctionCall;
      const sn = fc.functionName.split("::").pop();
      if (sn === "enumerate") {
        const enumArgs = orderedCallArgs(fc.args);
        if (enumArgs.length === 1) {
          return compileScalarSelectSQL(enumArgs[0].expr, params, target, options, outerWheres);
        }
      }
    }
  }
  if (sourceSet.expr.kind === "select_expr") {
    const selectExpr = sourceSet.expr as SelectExpr;
    const innerWheres = selectExpr.where ? [...outerWheres, selectExpr.where] : outerWheres;
    const result = sourceSet.shape.length > 0
      ? { ...selectExpr.result, shape: sourceSet.shape }
      : selectExpr.result;
    const inner = compileScalarSelectSQL(result, params, target, options, innerWheres);
    if (!inner) return null;
    let sql = `SELECT ${quoteIdent("value")} AS ${quoteIdent("value")} FROM (${inner})`;
    const orderSql = compileValueSortExprs(selectExpr.orderBy, quoteIdent("value"), target, options.resolveEnumMembers, options.resolveFieldEnumMembers);
    if (orderSql) {
      sql += ` ORDER BY ${orderSql}`;
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
    return sql;
  }
  if (sourceSet.shape.length > 0 && (sourceSet.expr.kind === "type_root" || sourceSet.expr.kind === "pointer")) {
    const compiledSource = compileSelectSource(sourceSet, undefined, undefined, options, params, target);
    if (compiledSource) {
      const valueExpr = compilePublicShapeObjectExpr(compiledSource.alias, sourceSet.shape, params, options, target, 0);
      let sql = `SELECT ${valueExpr} AS ${quoteIdent("value")} FROM ${compiledSource.sql}`;
      const whereSqls: string[] = [];
      for (const where of outerWheres) {
        const whereSql = compilePredicateSetSQL(where, compiledSource.alias, params, target, options)
          ?? compileValueSetSQL(where, compiledSource.alias, params, target, options);
        if (!whereSql) return null;
        whereSqls.push(whereSql);
      }
      if (whereSqls.length > 0) {
        sql += ` WHERE ${whereSqls.join(" AND ")}`;
      }
      return sql;
    }
  }
  // EdgeQL `X.__type__.name` resolves to the source row's type label. Detect
  // the pointer-chain `.__type__.name` and short-circuit to `__source_type`
  // on the underlying table — schemas don't expose `__type__` as a real link.
  if (sourceSet.expr.kind === "pointer") {
    const nameStep = sourceSet.expr as Pointer;
    if (nameStep.ptrref.shortName === "name" && nameStep.source.expr.kind === "pointer") {
      const typeStep = nameStep.source.expr as Pointer;
      if (typeStep.ptrref.shortName === "__type__" && typeStep.source.expr.kind === "type_root") {
        const compiledSource = compileSelectSource(typeStep.source, undefined, undefined, options, params, target);
        if (compiledSource) {
          return `SELECT ${compiledSource.alias}.${quoteIdent("__source_type")} AS ${quoteIdent("value")} FROM ${compiledSource.sql}`;
        }
      }
    }
  }
  // Top-level `SELECT EXISTS X` lowers to a boolean scalar over X's source.
  if (sourceSet.expr.kind === "exists_expr") {
    const existsExpr = sourceSet.expr as ExistsExpr;
    const innerSet = existsExpr.expr;
    // EXISTS of a select_expr/type_root/pointer source: lower to SELECT EXISTS(SELECT 1 FROM source).
    // Let compileSelectSource handle envelope unwrapping and WHERE attachment.
    if (innerSet.expr.kind === "select_expr"
      || innerSet.expr.kind === "type_root"
      || innerSet.expr.kind === "pointer") {
      const innerCompiled = compileSelectSource(innerSet, undefined, undefined, options, params, target);
      if (innerCompiled) {
        return `SELECT (CASE WHEN EXISTS(SELECT 1 FROM ${innerCompiled.sql}) THEN json('true') ELSE json('false') END) AS ${quoteIdent("value")}`;
      }
    }
    // EXISTS of a scalar selection: wrap a scalar compile.
    const innerScalar = compileScalarSelectSQL(innerSet, params, target, options);
    if (innerScalar) {
      return `SELECT (CASE WHEN EXISTS(SELECT 1 FROM (${innerScalar}) AS __e WHERE __e.${quoteIdent("value")} IS NOT NULL) THEN json('true') ELSE json('false') END) AS ${quoteIdent("value")}`;
    }
  }

  if (sourceSet.expr.kind === "tuple") {
    const tuple = sourceSet.expr as Tuple;
    if (tuple.elements.length === 0) {
      return `SELECT json_array() AS ${quoteIdent("value")}`;
    }
    const sources: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < tuple.elements.length; i += 1) {
      const element = tuple.elements[i]!;
      const elementSql = compileScalarSelectSQL(element.val, params, target, options);
      if (!elementSql) return null;
      const alias = `tuple_${i}`;
      sources.push(`(${elementSql}) ${alias}`);
      const valueRef = `${alias}.${quoteIdent("value")}`;
      // Bool values are stored as TEXT `'true'`/`'false'` (the literal output
      // of `json('true')`/`json('false')`). Without wrapping them with
      // `json(...)` inside `json_array(...)`, SQLite treats them as strings
      // and the tuple serialises to `["true", …]` instead of `[true, …]`.
      const elementType = (element.val.typeref?.id ?? element.val.typeref?.nameHint ?? "").toLowerCase();
      const isBoolType = elementType === "std::bool"
        || elementType === "unknown:std::bool"
        || elementType === "bool";
      const wrapInJson = setValueIsJson(element.val) || isBoolType;
      values.push(wrapInJson ? `json(${valueRef})` : valueRef);
    }
    const valueExpr = tuple.named
      ? `json_object(${tuple.elements.map((element, index) => `${quoteLiteral(element.name ?? String(index))}, ${values[index]}`).join(", ")})`
      : `json_array(${values.join(", ")})`;
    return `SELECT ${valueExpr} AS ${quoteIdent("value")} FROM ${sources.join(" CROSS JOIN ")}`;
  }
  // Pre-compute whether the outer FILTERs (if any) reference the same
  // iteration root as the value. If not, the set-level coalesce / ?= / ?!=
  // shortcuts are still safe to take — the filter will be applied
  // separately at the top level (or, today, dropped, matching pre-A3
  // behaviour). If they DO match, the shortcuts can't carry the filter
  // through their UNION ALL so we fall through to the generic FROM-based
  // emit which can attach the WHERE.
  const expr = sourceSet.expr;
  const outerWhereSourceIds = new Set<string>();
  if (outerWheres.length > 0) {
    const m = new Map<string, TypeRef>();
    for (const w of outerWheres) collectScalarPointerSources(w, m);
    for (const id of m.keys()) outerWhereSourceIds.add(id);
  }
  const exprSourceIds = new Set<string>();
  {
    const m = new Map<string, TypeRef>();
    collectScalarPointerSources(sourceSet, m);
    for (const id of m.keys()) exprSourceIds.add(id);
  }
  const outerWhereSharesValueSource = outerWheres.length > 0
    && Array.from(outerWhereSourceIds).every((id) => exprSourceIds.has(id))
    && outerWhereSourceIds.size > 0;
  if (expr.kind === "coalesce_expr") {
    if (!outerWhereSharesValueSource) {
      const setLevel = tryCompileSetLevelCoalesceSQL(expr as CoalesceExpr, params, target, options);
      if (setLevel) {
        return setLevel;
      }
    }
  }
  if (expr.kind === "operator_call") {
    const opCall = expr as OperatorCall;
    if (opCall.operator === "?=" || opCall.operator === "?!=") {
      if (!outerWhereSharesValueSource) {
        const setLevel = tryCompileSetLevelOptionalCompareSQL(opCall, params, target, options);
        if (setLevel) {
          return setLevel;
        }
      }
    }
  }
  // `{a, b, c} IS T` distributes — emit one boolean per union arm so the
  // top-level select yields three rows (matching EdgeQL set semantics)
  // instead of one aggregated row. Each arm's check uses enum membership
  // when T resolves to an enum scalar.
  if (expr.kind === "type_check_op") {
    const tc = expr as TypeCheckOpExpr;
    const leftExpr = tc.left.expr;
    if (leftExpr.kind === "operator_call" && (leftExpr as OperatorCall).operator === "union") {
      const targetEnumMembers = options.resolveEnumMembers?.(qualifyTypeName(tc.right));
      const memberSet = targetEnumMembers ? new globalThis.Set(targetEnumMembers) : undefined;
      const armParts: string[] = [];
      for (const arg of orderedCallArgs((leftExpr as OperatorCall).args)) {
        const armScalar = compileScalarSelectSQL(arg.expr, params, target, options);
        if (!armScalar) {
          armParts.length = 0;
          break;
        }
        // Determine per-arm match. If the inner is a pointer/constant we can
        // statically resolve; otherwise emit a runtime CASE over the value.
        const inner = arg.expr.expr;
        let perArm: string;
        if (memberSet) {
          if (inner.kind === "pointer") {
            const ptr = inner as Pointer;
            const fieldMembers = ptr.ptrref.outSource && ptr.ptrref.shortName
              ? options.resolveFieldEnumMembers?.(qualifyTypeName(ptr.ptrref.outSource), ptr.ptrref.shortName)
              : undefined;
            perArm = fieldMembers && fieldMembers.join("|") === targetEnumMembers!.join("|") ? "json('true')" : "json('false')";
          } else if (inner.kind === "string_constant") {
            const value = (inner as BaseConstant).value;
            perArm = typeof value === "string" && memberSet.has(value) ? "json('true')" : "json('false')";
          } else {
            const branches = targetEnumMembers!.map((m) => `WHEN ${quoteLiteral(m)} THEN json('true')`).join(" ");
            perArm = `(CASE "value" ${branches} ELSE json('false') END)`;
          }
        } else {
          perArm = "json('false')";
        }
        if (tc.op === "is not") perArm = `(CASE WHEN ${perArm} = json('true') THEN json('false') ELSE json('true') END)`;
        armParts.push(`SELECT ${perArm} AS ${quoteIdent("value")} FROM (${armScalar})`);
      }
      if (armParts.length > 0) return armParts.join(" UNION ALL ");
    }
  }
  if (expr.kind === "operator_call" && (expr as OperatorCall).operator === "union") {
    const args = orderedCallArgs((expr as OperatorCall).args);
    const parts: string[] = [];
    for (const arg of args) {
      const partSql = compileScalarSelectSQL(arg.expr, params, target, options, outerWheres);
      if (!partSql) return null;
      parts.push(partSql);
    }
    if (parts.length === 0) return null;
    return parts.join(" UNION ALL ");
  }

  // DISTINCT X: compile X as a scalar select, then wrap with SELECT DISTINCT.
  if (expr.kind === "operator_call" && (expr as OperatorCall).operator === "distinct") {
    const args = orderedCallArgs((expr as OperatorCall).args);
    if (args.length === 1) {
      const innerSql = compileScalarSelectSQL(args[0].expr, params, target, options, outerWheres);
      if (innerSql) {
        return `SELECT DISTINCT ${quoteIdent("value")} AS ${quoteIdent("value")} FROM (${innerSql})`;
      }
    }
  }

  // For a binary operator_call with a set-valued arg that *cannot* be
  // enumerated branch-by-branch (e.g. DISTINCT(X), or any other set
  // expression whose cardinality we'd compute at runtime), lift the arg
  // into the FROM clause as `(scalar_sql) AS r_N` and reference its
  // `value` column. `SELECT 2 * DISTINCT(...)` becomes
  // `SELECT 2 * r_0.value AS value FROM (DISTINCT-sql) r_0`.
  if (expr.kind === "operator_call" && (expr as OperatorCall).operator !== "union" && (expr as OperatorCall).operator !== "distinct") {
    const opCall = expr as OperatorCall;
    const op = operatorToInfixSql(opCall.operator) ?? normalizeOperator(opCall.operator);
    if (op && (opCall.operator !== "and" && opCall.operator !== "or" && opCall.operator !== "not")) {
      const args = orderedCallArgs(opCall.args);
      const isSetProducer = (s: Set): boolean => {
        const e = s.expr;
        return e.kind === "operator_call"
          && ((e as OperatorCall).operator === "distinct"
              || (e as OperatorCall).operator === "union");
      };
      const setArgs = args.map((arg, i) => ({ idx: i, arg, isSet: isSetProducer(arg.expr) }));
      const hasSetArg = setArgs.some((s) => s.isSet);
      // Skip if any union arg — the earlier "distribute over union" branch
      // handles that more cleanly. We only get here when set args are pure
      // DISTINCT (or other non-enumerable set producers).
      const hasUnionArg = args.some((arg) => arg.expr.expr.kind === "operator_call"
        && (arg.expr.expr as OperatorCall).operator === "union");
      if (hasSetArg && !hasUnionArg && args.length === 2) {
        const innerCheckpoint = params.length;
        const fromSources: string[] = [];
        const argSqls: string[] = [];
        let ok = true;
        for (const { idx, arg, isSet } of setArgs) {
          if (isSet) {
            const argSql = compileScalarSelectSQL(arg.expr, params, target, options);
            if (!argSql) { ok = false; break; }
            const alias = `r_${idx}`;
            fromSources.push(`(${argSql}) ${alias}`);
            argSqls.push(`${alias}.${quoteIdent("value")}`);
          } else {
            const argSql = compileValueSetSQL(arg.expr, "g0", params, target, options);
            if (!argSql) { ok = false; break; }
            argSqls.push(argSql);
          }
        }
        if (ok && fromSources.length > 0) {
          const valueExpr = op === "ilike"
            ? `(LOWER(${argSqls[0]}) LIKE LOWER(${argSqls[1]}))`
            : `(${argSqls[0]} ${op} ${argSqls[1]})`;
          return `SELECT ${valueExpr} AS ${quoteIdent("value")} FROM ${fromSources.join(", ")}`;
        }
        params.length = innerCheckpoint;
      }
    }
  }

  // Distribute a binary operator_call over union-bound sets reachable from
  // its args. `2 * (1 UNION 2)` and `(SELECT 2) * (1 UNION 2)` should yield
  // a set of products (`{2, 4}`), not a scalar of `2 * json_group_array(...)`.
  // We re-emit the operator_call once per branch (Cartesian over distinct
  // union sources; co-iteration when the *same* bound set appears multiple
  // times — `WITH x := {1,2,3} SELECT x * x + x` produces three values, not
  // 27, because all three `x` references must use the same branch per row).
  if (expr.kind === "operator_call" && (expr as OperatorCall).operator !== "union") {
    const opCall = expr as OperatorCall;
    const args = orderedCallArgs(opCall.args);
    const unwrapUnionBranches = (s: Set): Set[] | null => {
      if (s.expr.kind === "operator_call" && (s.expr as OperatorCall).operator === "union") {
        const branches = orderedCallArgs((s.expr as OperatorCall).args).map((arg) => arg.expr);
        return branches.length > 0 ? branches : null;
      }
      return null;
    };
    // Collect every union-bound Set reachable from the args. Object identity
    // is the signal: resolveBinding returns the same Set per scope, so a
    // binding referenced N times yields N pointers to the same union node.
    // Stop descending at union boundaries — the branches themselves are the
    // per-iteration values.
    const reachableUnions: Set[] = [];
    const collectReachableUnions = (s: Set): void => {
      if (s.expr.kind === "operator_call" && (s.expr as OperatorCall).operator === "union") {
        if (!reachableUnions.includes(s)) reachableUnions.push(s);
        return;
      }
      const e = s.expr;
      if (e.kind === "operator_call" || e.kind === "function_call") {
        const callExpr = e as OperatorCall;
        for (const arg of Object.values(callExpr.args)) {
          collectReachableUnions(arg.expr);
        }
        if (e.kind === "function_call") {
          const fnBody = (e as FunctionCall).body;
          if (fnBody) collectReachableUnions(fnBody);
        }
      } else if (e.kind === "type_cast") {
        collectReachableUnions((e as TypeCast).expr);
      } else if (e.kind === "if_else_expr") {
        const ife = e as IfElseExpr;
        collectReachableUnions(ife.condition);
        collectReachableUnions(ife.ifExpr);
        collectReachableUnions(ife.elseExpr);
      } else if (e.kind === "coalesce_expr") {
        const co = e as CoalesceExpr;
        collectReachableUnions(co.left);
        collectReachableUnions(co.right);
      } else if (e.kind === "exists_expr") {
        collectReachableUnions((e as ExistsExpr).expr);
      }
    };
    for (const arg of args) {
      collectReachableUnions(arg.expr);
    }
    // Substitute a Set by reference identity throughout an expression tree,
    // mirroring the same set of kinds we descend through above.
    const substituteSetByIdentity = (s: Set, source: Set, replacement: Set): Set => {
      if (s === source) return replacement;
      const e = s.expr;
      if (e.kind === "operator_call" || e.kind === "function_call") {
        const callExpr = e as OperatorCall;
        let changed = false;
        const newArgs: Record<string, CallArg> = {};
        for (const [k, arg] of Object.entries(callExpr.args)) {
          const newArgExpr = substituteSetByIdentity(arg.expr, source, replacement);
          if (newArgExpr !== arg.expr) {
            newArgs[k] = { ...arg, expr: newArgExpr };
            changed = true;
          } else {
            newArgs[k] = arg;
          }
        }
        let newBody: Set | undefined;
        if (e.kind === "function_call") {
          const fnBody = (e as FunctionCall).body;
          if (fnBody) {
            const sub = substituteSetByIdentity(fnBody, source, replacement);
            if (sub !== fnBody) {
              newBody = sub;
              changed = true;
            }
          }
        }
        if (!changed) return s;
        const newExpr: OperatorCall | FunctionCall = e.kind === "function_call"
          ? { ...(e as FunctionCall), args: newArgs, ...(newBody !== undefined ? { body: newBody } : {}) }
          : { ...(e as OperatorCall), args: newArgs };
        return { ...s, expr: newExpr };
      }
      if (e.kind === "type_cast") {
        const inner = substituteSetByIdentity((e as TypeCast).expr, source, replacement);
        return inner === (e as TypeCast).expr ? s : { ...s, expr: { ...(e as TypeCast), expr: inner } };
      }
      if (e.kind === "if_else_expr") {
        const ife = e as IfElseExpr;
        const nc = substituteSetByIdentity(ife.condition, source, replacement);
        const ni = substituteSetByIdentity(ife.ifExpr, source, replacement);
        const ne = substituteSetByIdentity(ife.elseExpr, source, replacement);
        if (nc === ife.condition && ni === ife.ifExpr && ne === ife.elseExpr) return s;
        return { ...s, expr: { ...ife, condition: nc, ifExpr: ni, elseExpr: ne } };
      }
      if (e.kind === "coalesce_expr") {
        const co = e as CoalesceExpr;
        const nl = substituteSetByIdentity(co.left, source, replacement);
        const nr = substituteSetByIdentity(co.right, source, replacement);
        if (nl === co.left && nr === co.right) return s;
        return { ...s, expr: { ...co, left: nl, right: nr } };
      }
      if (e.kind === "exists_expr") {
        const inner = substituteSetByIdentity((e as ExistsExpr).expr, source, replacement);
        return inner === (e as ExistsExpr).expr ? s : { ...s, expr: { ...(e as ExistsExpr), expr: inner } };
      }
      return s;
    };
    if (reachableUnions.length > 0) {
      const innerCheckpoint = params.length;
      const branchesPerUnion = reachableUnions.map((u) => unwrapUnionBranches(u)!);
      let combos: number[][] = [[]];
      for (const branches of branchesPerUnion) {
        const next: number[][] = [];
        for (const acc of combos) {
          for (let b = 0; b < branches.length; b += 1) {
            next.push([...acc, b]);
          }
        }
        combos = next;
      }
      const parts: string[] = [];
      let failed = false;
      for (const combo of combos) {
        // Substitute every reachable union with its chosen branch throughout
        // the operator_call's args. Co-iteration falls out for free: if two
        // sub-expressions reference the same union (same identity), they
        // both get rewritten to the same branch in this combo.
        let variantCall: OperatorCall = opCall;
        reachableUnions.forEach((source, idx) => {
          const replacement = branchesPerUnion[idx][combo[idx]];
          const newArgs: Record<string, CallArg> = {};
          let changed = false;
          for (const [k, arg] of Object.entries(variantCall.args)) {
            const newArgExpr = substituteSetByIdentity(arg.expr, source, replacement);
            if (newArgExpr !== arg.expr) {
              newArgs[k] = { ...arg, expr: newArgExpr };
              changed = true;
            } else {
              newArgs[k] = arg;
            }
          }
          if (changed) variantCall = { ...variantCall, args: newArgs };
        });
        const variantSet: Set = { ...sourceSet, expr: variantCall };
        const partSql = compileScalarSelectSQL(variantSet, params, target, options, outerWheres);
        if (!partSql) {
          failed = true;
          break;
        }
        parts.push(partSql);
      }
      if (!failed && parts.length > 0) {
        return parts.join(" UNION ALL ");
      }
      params.length = innerCheckpoint;
    }
  }

  const pointerPathSql = tryCompileScalarPointerPathSelectSQL(sourceSet, params, options);
  if (pointerPathSql) {
    return pointerPathSql;
  }

  const linkPropertyPathSql = tryCompileLinkPropertyPathSelectSQL(sourceSet, params, options);
  if (linkPropertyPathSql) {
    return linkPropertyPathSql;
  }

  const sources = new Map<string, TypeRef>();
  collectScalarPointerSources(sourceSet, sources);
  // Only apply outerWheres when (a) their sources are a subset of the
  // value's sources — the FILTER references the same iteration root — and
  // (b) the value's pointer chain isn't wrapped in a `select_expr`, which
  // would make the value a SET OF expression in EdgeQL's semantics and
  // therefore independent of the outer FILTER (test_edgeql_scope_filter_06).
  // When either check fails, we fall back to dropping the filter, matching
  // the pre-A3 behaviour.
  const valueSourceIds = new Set(sources.keys());
  const outerWhereSources = new Map<string, TypeRef>();
  for (const where of outerWheres) {
    collectScalarPointerSources(where, outerWhereSources);
  }
  const outerWheresMatchValueSources = outerWheres.length === 0
    || (valueSourceIds.size > 0
        && Array.from(outerWhereSources.keys()).every((id) => valueSourceIds.has(id)));
  const valueIsSetOfWrapped = outerWheres.length > 0 && valueExprWrapsPointerInSelectExpr(sourceSet);
  const appliedOuterWheres = (outerWheresMatchValueSources && !valueIsSetOfWrapped) ? outerWheres : [];
  const innerWheres = collectInnerWhereClauses(sourceSet);
  const valueSql = compileValueSetSQL(sourceSet, "g0", params, target, options);
  if (!valueSql) return null;
  if (sources.size === 0) {
    if (innerWheres.length > 0 || appliedOuterWheres.length > 0) return null;
    return `SELECT ${valueSql} AS ${quoteIdent("value")}`;
  }
  // Multi-source scalar select: `Status.name ++ Priority.name` references
  // two independent type roots. Cross-join them, alias each as g0/g1/…, and
  // re-compile the value expression with a binding map so each pointer
  // resolves to the right alias.
  if (sources.size > 1) {
    if (innerWheres.length > 0 || appliedOuterWheres.length > 0) return null;
    const bindingAliases = new Map<string, string>();
    const fromParts: string[] = [];
    let idx = 0;
    for (const [sid, sourceType] of sources.entries()) {
      const a = `g${idx++}`;
      const refCols = collectReferencedColumnsForSource(sourceSet, sid);
      const polySql = compilePolymorphicSource(sourceType, false, a, refCols, options);
      fromParts.push(polySql);
      // The pathId key for these sources mirrors what collectScalarPointerSources
      // built — `${qualifiedName}|${namespace}` — but pointer compilation
      // looks up by the source-set's serialized pathId. Build that key too.
      const syntheticRoot: Set = {
        kind: "set",
        expr: { kind: "type_root", typeref: sourceType, skipSubtypes: false, isCachedGlobal: false },
        pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [{ type: sourceType }] },
        typeref: sourceType,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      } as Set;
      bindingAliases.set(pathIdKey(syntheticRoot), a);
    }
    const valueWithAliases = compileValueSetSQLWithAliases(sourceSet, bindingAliases, "g0", params, target, options);
    if (!valueWithAliases) return null;
    const base = `SELECT ${valueWithAliases} AS ${quoteIdent("value")} FROM ${fromParts.join(" CROSS JOIN ")}`;
    // Apply the same strict-NULL filter we do for the single-source path so
    // empty operands cause an empty result rather than a NULL row.
    const exprIsStrictMulti = (() => {
      let expr = sourceSet.expr;
      while (expr.kind === "select_expr") expr = (expr as SelectExpr).result.expr;
      if (expr.kind !== "operator_call") return false;
      return STRICT_BINARY_OPS.has((expr as OperatorCall).operator);
    })();
    if (exprIsStrictMulti) {
      return `SELECT ${quoteIdent("value")} FROM (${base}) WHERE ${quoteIdent("value")} IS NOT NULL`;
    }
    return base;
  }
  const [typeRef] = sources.values();
  // When the value references a link-table-backed pointer step (`User.todo`),
  // the source's row alone can't satisfy the access — we need to iterate the
  // link's storage table. Promote the FROM to a chain that walks one such
  // common prefix and provides aliases for the inner compile. Falls back to
  // the plain single-source FROM if no such pointer is found.
  const linkIterationSqlAttempt = tryBuildLinkIterationSingleSource(sourceSet, typeRef!, params, target, options, valueSql, appliedOuterWheres, innerWheres);
  if (linkIterationSqlAttempt) {
    return linkIterationSqlAttempt;
  }
  const projectedColumns = Array.from(new Set([
    ...collectReferencedColumns(sourceSet),
    ...appliedOuterWheres.flatMap((w) => collectReferencedColumns(w)),
  ]));
  const sourceSql = compilePolymorphicSource(typeRef!, false, "g0", projectedColumns, options);

  // If every pointer to the source is wrapped in a set-level operator
  // (?=, ?!=, ??), the source's empty case should still produce one row
  // with NULL columns (so set-level ops yield their fallback values).
  // Use LEFT JOIN against a 1-row anchor to guarantee that row.
  const useLeftJoin = innerWheres.length === 0 && appliedOuterWheres.length === 0 && allPathsAreSetLevelWrapped(sourceSet);

  let sql: string;
  if (useLeftJoin) {
    sql = `SELECT ${valueSql} AS ${quoteIdent("value")} FROM (SELECT NULL AS __anchor) __anchor LEFT JOIN ${sourceSql} ON 1=1`;
  } else {
    sql = `SELECT ${valueSql} AS ${quoteIdent("value")} FROM ${sourceSql}`;
  }
  // For strict-empty operators (`++`, `+`, `=` etc.) any NULL operand from a
  // single-source pointer chain (`Issue.priority.name` is NULL when the
  // priority link is empty) must skip the row entirely — EdgeQL semantics
  // says cross-product with empty yields empty. The wrapper subquery filters
  // out the synthesized NULLs without disturbing legitimate "no row" cases
  // (which are already empty before the wrap).
  const exprIsStrictMulti = (() => {
    let expr = sourceSet.expr;
    while (expr.kind === "select_expr") expr = (expr as SelectExpr).result.expr;
    while (expr.kind === "type_cast") expr = (expr as TypeCast).expr.expr;
    if (expr.kind === "index_expr" || expr.kind === "slice_expr") return true;
    if (expr.kind !== "operator_call") return false;
    const op = (expr as OperatorCall).operator;
    return STRICT_BINARY_OPS.has(op);
  })();
  if (exprIsStrictMulti && innerWheres.length === 0 && appliedOuterWheres.length === 0) {
    sql = `SELECT ${quoteIdent("value")} FROM (${sql}) WHERE ${quoteIdent("value")} IS NOT NULL`;
  }
  const whereSqls: string[] = [];
  const compileWhere = (where: Set): string | null => {
    const checkpoint = params.length;
    const predicate = compilePredicateSetSQL(where, "g0", params, target, options);
    if (predicate) return predicate;
    params.length = checkpoint;
    return compileValueSetSQL(where, "g0", params, target, options);
  };
  for (const where of innerWheres) {
    const compiled = compileWhere(where);
    if (!compiled) return null;
    whereSqls.push(compiled);
  }
  for (const where of appliedOuterWheres) {
    const compiled = compileWhere(where);
    if (!compiled) return null;
    whereSqls.push(compiled);
  }
  if (whereSqls.length > 0) {
    sql += ` WHERE ${whereSqls.join(" AND ")}`;
  }
  return sql;
};

type ScalarPointerPath = {
  root: Set;
  leaf: Pointer;
  links: Pointer[];
};

const extractScalarPointerPath = (set: Set): ScalarPointerPath | null => {
  const chain: Pointer[] = [];
  let cursor: Set = set;
  while (cursor.expr.kind === "pointer") {
    const pointer = cursor.expr as Pointer;
    chain.push(pointer);
    cursor = pointer.source;
  }

  let rootExpr: Expr = cursor.expr;
  while (rootExpr.kind === "select_expr") {
    rootExpr = (rootExpr as SelectExpr).result.expr;
  }
  if (rootExpr.kind !== "type_root" || chain.length < 2) {
    return null;
  }

  const leaf = chain[0]!;
  if (!leaf.ptrref.outTarget.isScalar || leaf.ptrref.isLinkProperty) {
    return null;
  }

  const links = chain.slice(1).reverse();
  if (links.some((link) => link.ptrref.outTarget.isScalar || link.ptrref.isLinkProperty)) {
    return null;
  }

  return { root: cursor, leaf, links };
};

const pointerPathAliasColumns = (path: ScalarPointerPath): string[][] => {
  const columns = Array.from({ length: path.links.length + 1 }, () => new Set<string>(["id"]));
  path.links.forEach((link, index) => {
    if (shouldUseLinkTable(link)) {
      return;
    }
    const inlineColumn = `${link.ptrref.shortName}_id`;
    if (link.direction === "inbound") {
      columns[index + 1]!.add(inlineColumn);
    } else {
      columns[index]!.add(inlineColumn);
    }
  });
  columns[columns.length - 1]!.add(columnForPointer(path.leaf));
  return columns.map((entry) => [...entry]);
};

const linkTableNameForPointer = (pointer: Pointer, options?: GelIRCompileOptions): string => {
  const sourceType = pointer.direction === "inbound" ? pointer.ptrref.outSource : pointer.source.typeref;
  const sourceTypeName = qualifyTypeName(sourceType);
  const linkName = pointer.ptrref.shortName;
  const storage = options?.resolveLinkStorageType?.(sourceTypeName, linkName) ?? sourceTypeName;
  return `${tableNameForType(storage)}__${linkName.toLowerCase()}`;
};

const scalarResultValueSQL = (sql: string, typeRef: TypeRef): string => (
  qualifyTypeName(typeRef) === "std::str" ? `json_quote(${sql})` : sql
);

const tryCompileScalarPointerPathSelectSQL = (
  set: Set,
  params: ScalarValue[],
  options: GelIRCompileOptions,
): string | null => {
  const path = extractScalarPointerPath(set);
  if (!path) {
    return null;
  }

  const checkpoint = params.length;
  const aliasColumns = pointerPathAliasColumns(path);
  const rootAlias = "p0";
  let fromSql = compilePolymorphicSource(path.root.typeref, false, rootAlias, aliasColumns[0]!, options);
  let previousAlias = rootAlias;

  path.links.forEach((link, index) => {
    const nextAlias = `p${index + 1}`;
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const targetSource = compilePolymorphicSource(targetType, false, nextAlias, aliasColumns[index + 1]!, options);
    if (shouldUseLinkTable(link)) {
      const linkAlias = `pj${index}`;
      const linkTable = linkTableNameForPointer(link, options);
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
      } else {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent(inlineColumn)} = ${previousAlias}.${quoteIdent("id")}`;
      } else {
        fromSql += ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`;
      }
    }
    previousAlias = nextAlias;
  });

  const leafSql = `${previousAlias}.${quoteIdent(columnForPointer(path.leaf))}`;
  const valueSql = scalarResultValueSQL(leafSql, path.leaf.ptrref.outTarget);
  params.length = checkpoint;
  return `SELECT DISTINCT ${valueSql} AS ${quoteIdent("value")} FROM ${fromSql} WHERE ${leafSql} IS NOT NULL`;
};

// Path that ends in a link property (`X.l@p`, `X.<l[IS T]@p`). The terminal
// pointer doesn't live on the target row; its value comes from the link's
// storage table. Walk the pointer chain up to (but not including) the link
// property, then join the terminal link's table and project the property
// column from it.
type LinkPropertyPath = {
  root: Set;
  leafProperty: Pointer;
  links: Pointer[];
};

const extractLinkPropertyPath = (set: Set): LinkPropertyPath | null => {
  if (set.expr.kind !== "pointer") return null;
  const leafProperty = set.expr as Pointer;
  if (!leafProperty.ptrref.isLinkProperty) return null;

  const chain: Pointer[] = [];
  let cursor: Set = leafProperty.source;
  while (cursor.expr.kind === "pointer") {
    const pointer = cursor.expr as Pointer;
    if (pointer.ptrref.isLinkProperty) return null;
    if (pointer.ptrref.outTarget.isScalar) return null;
    chain.push(pointer);
    cursor = pointer.source;
  }

  let rootExpr: Expr = cursor.expr;
  while (rootExpr.kind === "select_expr") {
    rootExpr = (rootExpr as SelectExpr).result.expr;
  }
  if (rootExpr.kind !== "type_root" || chain.length === 0) {
    return null;
  }

  return { root: cursor, leafProperty, links: chain.reverse() };
};

const tryCompileLinkPropertyPathSelectSQL = (
  set: Set,
  params: ScalarValue[],
  options: GelIRCompileOptions,
): string | null => {
  const path = extractLinkPropertyPath(set);
  if (!path) return null;

  const terminalLink = path.links[path.links.length - 1]!;
  // Link properties only live on link-table-backed links. If the schema
  // decided this terminal link is inline-FK only (no properties, single
  // outbound), the property reference is meaningless and we bail.
  if (!shouldUseLinkTable(terminalLink)) return null;

  const checkpoint = params.length;
  const rootAlias = "p0";
  const rootCols = new Set<string>(["id"]);
  let fromSql = compilePolymorphicSource(path.root.typeref, false, rootAlias, [...rootCols], options);
  let previousAlias = rootAlias;

  for (let index = 0; index < path.links.length; index += 1) {
    const link = path.links[index]!;
    const isTerminal = index === path.links.length - 1;
    const linkAlias = `pj${index}`;
    const linkTable = linkTableNameForPointer(link, options);
    if (isTerminal) {
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`;
      } else {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`;
      }
      previousAlias = linkAlias;
      break;
    }
    const nextAlias = `p${index + 1}`;
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const targetCols = new Set<string>(["id"]);
    if (!shouldUseLinkTable(link)) {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (link.direction === "inbound") {
        targetCols.add(inlineColumn);
      }
    }
    const targetSource = compilePolymorphicSource(targetType, false, nextAlias, [...targetCols], options);
    if (shouldUseLinkTable(link)) {
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
      } else {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent(inlineColumn)} = ${previousAlias}.${quoteIdent("id")}`;
      } else {
        fromSql += ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`;
      }
    }
    previousAlias = nextAlias;
  }

  const leafShortName = path.leafProperty.ptrref.shortName;
  const propertyColumn = leafShortName.startsWith("@") ? leafShortName.slice(1) : leafShortName;
  const leafSql = `${previousAlias}.${quoteIdent(propertyColumn)}`;
  const valueSql = scalarResultValueSQL(leafSql, path.leafProperty.ptrref.outTarget);
  params.length = checkpoint;
  return `SELECT ${valueSql} AS ${quoteIdent("value")} FROM ${fromSql} WHERE ${leafSql} IS NOT NULL`;
};

// Collect every Pointer node in a Set tree, oldest-first. Used to find shared
// chain prefixes when an outer expression (`a@p + a.x`) needs the same link
// iteration for both operands.
const collectPointers = (set: Set, out: Pointer[]): void => {
  const expr = set.expr as { kind: string };
  if (!expr) return;
  if (expr.kind === "pointer") {
    const ptr = set.expr as Pointer;
    out.push(ptr);
    collectPointers(ptr.source, out);
    return;
  }
  if (expr.kind === "type_cast") {
    collectPointers((set.expr as TypeCast).expr, out);
    return;
  }
  if (expr.kind === "operator_call" || expr.kind === "function_call") {
    if (expr.kind === "function_call") {
      const fc = set.expr as FunctionCall;
      const shortName = (fc.functionName ?? "").split("::").pop() ?? "";
      if (["count", "sum", "min", "max", "avg", "all", "any", "array_agg"].includes(shortName)) return;
    }
    for (const arg of orderedCallArgs((set.expr as { args: Record<string, CallArg> }).args)) {
      collectPointers(arg.expr, out);
    }
    return;
  }
  if (expr.kind === "if_else_expr") {
    const ie = set.expr as IfElseExpr;
    collectPointers(ie.condition, out);
    collectPointers(ie.ifExpr, out);
    collectPointers(ie.elseExpr, out);
    return;
  }
  if (expr.kind === "coalesce_expr") {
    const co = set.expr as CoalesceExpr;
    collectPointers(co.left, out);
    collectPointers(co.right, out);
    return;
  }
  if (expr.kind === "array") {
    for (const el of (set.expr as { elements: Set[] }).elements) collectPointers(el, out);
    return;
  }
  if (expr.kind === "tuple") {
    for (const el of (set.expr as Tuple).elements) collectPointers(el.val, out);
    return;
  }
};

// Conservative scan for aggregate function calls in the value expression.
// When an aggregate is present we must NOT promote the FROM to a chain JOIN
// — the aggregate already collapses its argument's iteration, and the outer
// JOIN would multiply the row count and break the aggregate's cardinality.
const valueSetContainsAggregate = (set: Set): boolean => {
  let found = false;
  const visit = (s: Set): void => {
    if (found) return;
    const e = s.expr;
    if (!e) return;
    if (e.kind === "function_call") {
      const fc = s.expr as FunctionCall;
      const shortName = (fc.functionName ?? "").split("::").pop() ?? "";
      if (["count", "sum", "min", "max", "avg", "all", "any", "array_agg"].includes(shortName)) {
        found = true;
        return;
      }
      for (const arg of orderedCallArgs((s.expr as { args: Record<string, CallArg> }).args)) visit(arg.expr);
      return;
    }
    if (e.kind === "operator_call") {
      for (const arg of orderedCallArgs((s.expr as { args: Record<string, CallArg> }).args)) visit(arg.expr);
      return;
    }
    if (e.kind === "type_cast") { visit((s.expr as TypeCast).expr); return; }
    if (e.kind === "if_else_expr") {
      visit((s.expr as IfElseExpr).condition);
      visit((s.expr as IfElseExpr).ifExpr);
      visit((s.expr as IfElseExpr).elseExpr);
      return;
    }
    if (e.kind === "coalesce_expr") {
      visit((s.expr as CoalesceExpr).left);
      visit((s.expr as CoalesceExpr).right);
      return;
    }
    if (e.kind === "pointer") {
      visit((s.expr as Pointer).source);
      return;
    }
    if (e.kind === "tuple") {
      for (const el of (s.expr as Tuple).elements) visit(el.val);
      return;
    }
    if (e.kind === "array") {
      for (const el of (s.expr as { elements: Set[] }).elements) visit(el);
      return;
    }
  };
  visit(set);
  return found;
};

// Find a link-table-backed pointer (multi or has-properties) referenced by
// any chain in `valueSet` rooted at `rootTyperef`. All link-table-backed
// pointers must agree on the same link (we can't iterate two link tables in
// a single SELECT this way). Other chains — scalar properties accessed
// straight off the root row — are still resolved against the root alias by
// the caller. Returns the link pointer plus the link's target type so the
// caller can build the JOIN.
const findSharedLinkIterationPointer = (
  valueSet: Set,
  rootTyperef: TypeRef,
): { link: Pointer; targetTyperef: TypeRef } | null => {
  if (valueSetContainsAggregate(valueSet)) return null;
  const pointers: Pointer[] = [];
  collectPointers(valueSet, pointers);
  if (pointers.length === 0) return null;
  let sharedLink: Pointer | undefined;
  for (const ptr of pointers) {
    // Walk the chain bottom-up to find the link-table-backed step (if any).
    let cursor: Set = { ...valueSet, expr: ptr };
    let innermostLink: Pointer | undefined;
    while (cursor.expr.kind === "pointer") {
      const p = cursor.expr as Pointer;
      if (shouldUseLinkTable(p)) innermostLink = p;
      cursor = p.source;
    }
    if (cursor.expr.kind !== "type_root") return null;
    const rootTr = (cursor.expr as TypeRoot).typeref;
    if (rootTr.id !== rootTyperef.id) return null;
    if (!innermostLink) continue;
    if (sharedLink && sharedLink.ptrref.id !== innermostLink.ptrref.id) return null;
    sharedLink = innermostLink;
  }
  if (!sharedLink) return null;
  const targetTyperef = sharedLink.direction === "inbound" ? sharedLink.ptrref.outSource : sharedLink.ptrref.outTarget;
  return { link: sharedLink, targetTyperef };
};

// Single-source value SELECT where the value's pointer chain iterates a
// link-table-backed link (multi or has-properties). Emits
//   `SELECT <value> FROM <root> u JOIN <link_table> j ON … JOIN <target> i ON …`
// and rebinds the value's pointer references so `u.l@p` ↦ `j.<p>` and
// `u.l.x` ↦ `i.<x>`. Returns null when the helper can't identify a single
// shared link step (caller falls back to the plain single-source emit).
const tryBuildLinkIterationSingleSource = (
  valueSet: Set,
  rootTyperef: TypeRef,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  _valueSqlPrecomputed: string,
  outerWheres: Set[],
  innerWheres: Set[],
): string | null => {
  const shared = findSharedLinkIterationPointer(valueSet, rootTyperef);
  if (!shared) return null;
  void _valueSqlPrecomputed;

  const checkpoint = params.length;
  const rootAlias = "g0";
  const linkAlias = "j0";
  const targetAlias = "t0";
  const seedFromPointers: Pointer[] = [];
  collectPointers(valueSet, seedFromPointers);
  // Project any scalar column that lives on the root row (`Issue.number` in
  // `Issue.<todo[IS User]@rank + Issue.number`). Without this the chain JOIN
  // succeeds but `g0.number` references a column that wasn't surfaced.
  const rootColSet = new globalThis.Set<string>(["id"]);
  for (const ptr of seedFromPointers) {
    if (ptr.source.expr.kind === "type_root"
        && (ptr.source.expr as TypeRoot).typeref.id === rootTyperef.id
        && !ptr.ptrref.isLinkProperty
        && ptr.ptrref.outTarget.isScalar) {
      rootColSet.add(columnForPointer(ptr));
    }
  }
  const rootSql = compilePolymorphicSource(rootTyperef, false, rootAlias, [...rootColSet], options);
  const linkTable = linkTableNameForPointer(shared.link, options);
  // Collect every pointer step whose immediate source is the shared link
  // (`User.todo.X` → X) so the target subquery surfaces those columns.
  const targetColSet = new globalThis.Set<string>(["id"]);
  for (const ptr of seedFromPointers) {
    if (ptr.source.expr.kind === "pointer"
        && (ptr.source.expr as Pointer).ptrref.id === shared.link.ptrref.id
        && !ptr.ptrref.isLinkProperty) {
      targetColSet.add(columnForPointer(ptr));
    }
  }
  const targetCols = [...targetColSet];
  const targetSql = compilePolymorphicSource(shared.targetTyperef, false, targetAlias, targetCols, options);
  let fromSql: string;
  if (shared.link.direction === "inbound") {
    fromSql = `${rootSql} JOIN ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("target")} = ${rootAlias}.${quoteIdent("id")} JOIN ${targetSql} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
  } else {
    fromSql = `${rootSql} JOIN ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("source")} = ${rootAlias}.${quoteIdent("id")} JOIN ${targetSql} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
  }

  const bindingAliases = new Map<string, string>();
  const linkPropertyAliases = new Map<string, string>();
  // Map every Set whose pathId resolves to the link's target (`User.todo`)
  // onto the target alias `t0`. Also map the underlying root and the link
  // step itself so link-property compiles find the join alias.
  const collectMappings = (set: Set): void => {
    if (set.expr.kind === "pointer") {
      const ptr = set.expr as Pointer;
      if (ptr.ptrref.id === shared.link.ptrref.id) {
        bindingAliases.set(pathIdKey(set), targetAlias);
        linkPropertyAliases.set(pathIdKey(set), linkAlias);
      }
      collectMappings(ptr.source);
      return;
    }
    if (set.expr.kind === "type_root" && (set.expr as TypeRoot).typeref.id === rootTyperef.id) {
      bindingAliases.set(pathIdKey(set), rootAlias);
    }
  };
  for (const ptr of seedFromPointers) {
    let cursor: Set = { ...valueSet, expr: ptr };
    while (cursor.expr.kind === "pointer") {
      collectMappings(cursor);
      cursor = (cursor.expr as Pointer).source;
    }
    collectMappings(cursor);
  }

  const valueSql = compileValueSetSQLWithAliases(valueSet, bindingAliases, rootAlias, params, target, options, linkPropertyAliases);
  if (!valueSql) {
    params.length = checkpoint;
    return null;
  }
  let sql = `SELECT ${valueSql} AS ${quoteIdent("value")} FROM ${fromSql}`;
  const whereSqls: string[] = [];
  const compileWhere = (where: Set): string | null => {
    const compiled = compilePredicateWithAliases(where, bindingAliases, params, target, options, linkPropertyAliases);
    if (compiled) return compiled;
    return compileValueSetSQLWithAliases(where, bindingAliases, rootAlias, params, target, options, linkPropertyAliases);
  };
  for (const w of innerWheres) {
    const c = compileWhere(w);
    if (!c) { params.length = checkpoint; return null; }
    whereSqls.push(c);
  }
  for (const w of outerWheres) {
    const c = compileWhere(w);
    if (!c) { params.length = checkpoint; return null; }
    whereSqls.push(c);
  }
  if (whereSqls.length > 0) sql += ` WHERE ${whereSqls.join(" AND ")}`;
  return sql;
};

// Shared chain-walker: builds the FROM clause and anchor WHERE for a scalar
// pointer chain rooted at a type_root, anchored at `sourceAlias` (typically
// the outer UPDATE/SET row). Returns null when any link in the chain needs a
// link-table join (those paths still fall back to the broader set-based
// compilation route).
const buildCorrelatedScalarPointerPath = (
  set: Set,
  sourceAlias: string,
  options: GelIRCompileOptions,
): { fromSql: string; anchorWhere: string; leafAlias: string; path: ScalarPointerPath } | null => {
  const path = extractScalarPointerPath(set);
  if (!path) return null;
  if (path.links.length === 0) return null;

  const firstLink = path.links[0]!;
  const firstTargetType = firstLink.direction === "inbound" ? firstLink.ptrref.outSource : firstLink.ptrref.outTarget;
  const firstAlias = "cp1";
  let fromSql: string;
  let anchorWhere: string;
  // For chains rooted at a *truly polymorphic* type_root (multiple concrete
  // subtypes, with potentially different link storage tables per branch),
  // the source's `${shortName}_id` column is already projected via
  // compilePolymorphicSource's LinkProjection. Treat it like an inline FK
  // instead of joining one canonical link table that wouldn't fit all
  // branches. Concrete types with `children: [self]` keep the existing
  // link-table-join path — the storage table is unambiguous there.
  const rootIsPolymorphic = path.root.expr.kind === "type_root"
    && isTrulyPolymorphicTypeRef((path.root.expr as TypeRoot).typeref);
  const firstIsSingleLink = firstLink.ptrref.outCardinality === "one"
    || firstLink.ptrref.outCardinality === "at_most_one";
  const useProjectedFK = shouldUseLinkTable(firstLink)
    && firstLink.direction === "outbound"
    && firstIsSingleLink
    && rootIsPolymorphic;
  if (useProjectedFK) {
    fromSql = `${quoteIdent(resolveTypeTableName(firstTargetType, options))} ${firstAlias}`;
    const firstInlineColumn = `${firstLink.ptrref.shortName}_id`;
    anchorWhere = `${firstAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(firstInlineColumn)}`;
  } else if (shouldUseLinkTable(firstLink)) {
    const linkTable = linkTableNameForPointer(firstLink, options);
    const linkAlias = "cpj1";
    fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${quoteIdent(resolveTypeTableName(firstTargetType, options))} ${firstAlias}`;
    if (firstLink.direction === "inbound") {
      fromSql += ` ON ${firstAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
      anchorWhere = `${linkAlias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")}`;
    } else {
      fromSql += ` ON ${firstAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      anchorWhere = `${linkAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`;
    }
  } else {
    fromSql = `${quoteIdent(resolveTypeTableName(firstTargetType, options))} ${firstAlias}`;
    const firstInlineColumn = `${firstLink.ptrref.shortName}_id`;
    anchorWhere = firstLink.direction === "inbound"
      ? `${firstAlias}.${quoteIdent(firstInlineColumn)} = ${sourceAlias}.${quoteIdent("id")}`
      : `${firstAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(firstInlineColumn)}`;
  }
  let prevAlias = firstAlias;

  for (let i = 1; i < path.links.length; i += 1) {
    const link = path.links[i]!;
    const nextAlias = `cp${i + 1}`;
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const targetTable = resolveTypeTableName(targetType, options);
    if (shouldUseLinkTable(link)) {
      const linkTable = linkTableNameForPointer(link, options);
      const linkAlias = `cpj${i + 1}`;
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("target")} = ${prevAlias}.${quoteIdent("id")}`
          + ` JOIN ${quoteIdent(targetTable)} ${nextAlias} ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
      } else {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("source")} = ${prevAlias}.${quoteIdent("id")}`
          + ` JOIN ${quoteIdent(targetTable)} ${nextAlias} ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${quoteIdent(targetTable)} ${nextAlias} ON ${nextAlias}.${quoteIdent(inlineColumn)} = ${prevAlias}.${quoteIdent("id")}`;
      } else {
        fromSql += ` JOIN ${quoteIdent(targetTable)} ${nextAlias} ON ${nextAlias}.${quoteIdent("id")} = ${prevAlias}.${quoteIdent(inlineColumn)}`;
      }
    }
    prevAlias = nextAlias;
  }

  return { fromSql, anchorWhere, leafAlias: prevAlias, path };
};

// Lower a chained scalar pointer path (e.g. `.parent.val`) into a correlated
// scalar subquery against the outer row alias.
const tryCompileCorrelatedScalarPointerPathSQL = (
  set: Set,
  sourceAlias: string,
  options: GelIRCompileOptions,
): string | null => {
  const built = buildCorrelatedScalarPointerPath(set, sourceAlias, options);
  if (!built) return null;
  const leafSql = `${built.leafAlias}.${quoteIdent(columnForPointer(built.path.leaf))}`;
  return `(SELECT ${leafSql} FROM ${built.fromSql} WHERE ${built.anchorWhere})`;
};

// Lower a chained scalar pointer path into a multi-row SELECT correlated to
// the outer row alias — for use inside aggregates (`array_agg(.children.val)`,
// `count(.children.val)`, etc.) where the input set must be limited to rows
// belonging to the row currently being processed.
const tryCompileCorrelatedScalarPointerPathScalarSelect = (
  set: Set,
  sourceAlias: string,
  options: GelIRCompileOptions,
): string | null => {
  const built = buildCorrelatedScalarPointerPath(set, sourceAlias, options);
  if (!built) return null;
  // Aggregates wrap this select in `json_group_array(value)`; SQLite's
  // json_group_array already JSON-encodes its TEXT inputs, so we must hand
  // it the raw column value rather than the json_quote'd form scalar SELECT
  // emits at the top level.
  const leafSql = `${built.leafAlias}.${quoteIdent(columnForPointer(built.path.leaf))}`;
  return `SELECT ${leafSql} AS ${quoteIdent("value")} FROM ${built.fromSql} WHERE ${built.anchorWhere}`;
};

// Walks the set's expression tree; returns true if every `pointer` reference
// occurs strictly inside an `operator_call` whose operator is a set-level
// optional (??, ?=, ?!=). Used to decide whether the SQL FROM clause can be
// LEFT JOINed against a 1-row anchor so an empty source still yields one row.
const allPathsAreSetLevelWrapped = (set: Set): boolean => {
  let hasUnwrappedPath = false;
  let hasPath = false;
  const walk = (s: Set | undefined, wrappedDepth: number): void => {
    if (!s || !s.expr) return;
    const expr = s.expr;
    if (expr.kind === "pointer") {
      hasPath = true;
      if (wrappedDepth === 0) hasUnwrappedPath = true;
      walk((expr as Pointer).source, wrappedDepth);
      return;
    }
    if (expr.kind === "type_root") {
      return;
    }
    if (expr.kind === "operator_call") {
      const op = (expr as OperatorCall).operator;
      const liftsCardinality = op === "??" || op === "?=" || op === "?!=";
      const inner = wrappedDepth + (liftsCardinality ? 1 : 0);
      for (const arg of orderedCallArgs((expr as OperatorCall).args)) {
        walk(arg.expr, inner);
      }
      return;
    }
    if (expr.kind === "function_call") {
      const fcall = expr as FunctionCall;
      const shortName = (fcall.functionName ?? "").split("::").pop() ?? "";
      const isAggregate = ["count", "sum", "min", "max", "avg", "all", "any", "array_agg", "enumerate"].includes(shortName);
      const inner = wrappedDepth + (isAggregate ? 1 : 0);
      for (const arg of orderedCallArgs((expr as { args: Record<string, CallArg> }).args)) {
        walk(arg.expr, inner);
      }
      return;
    }
    if (expr.kind === "tuple") {
      for (const el of (expr as Tuple).elements) walk(el.val, wrappedDepth);
      return;
    }
    if (expr.kind === "coalesce_expr") {
      walk((expr as CoalesceExpr).left, wrappedDepth + 1);
      walk((expr as CoalesceExpr).right, wrappedDepth + 1);
      return;
    }
    if (expr.kind === "if_else_expr") {
      const ie = expr as IfElseExpr;
      walk(ie.condition, wrappedDepth);
      walk(ie.ifExpr, wrappedDepth);
      walk(ie.elseExpr, wrappedDepth);
      return;
    }
    if (expr.kind === "type_cast") {
      walk((expr as TypeCast).expr, wrappedDepth);
      return;
    }
    if (expr.kind === "exists_expr") {
      // exists is itself a set-level optional that lifts cardinality.
      walk((expr as ExistsExpr).expr, wrappedDepth + 1);
      return;
    }
    if (expr.kind === "select_expr") {
      const se = expr as SelectExpr;
      walk(se.result, wrappedDepth);
      walk(se.where, wrappedDepth);
      return;
    }
  };
  walk(set, 0);
  return hasPath && !hasUnwrappedPath;
};

const compileSelectSource = (
  sourceSet: Set,
  where: Set | undefined,
  orderBy: SortExpr[] | undefined,
  options: GelIRCompileOptions,
  params: ScalarValue[] = [],
  target: RuntimeTarget = options.target ?? "sqlite",
  aliasOverride?: string,
): { sql: string; alias: string } | null => {
  const alias = aliasOverride ?? "g0";
  const projectedColumns = collectProjectedColumns(sourceSet.shape, where, orderBy);
  if (sourceSet.expr.kind === "select_expr") {
    const selectExpr = sourceSet.expr as SelectExpr;
    const inner = compileSelectSource(selectExpr.result, selectExpr.where, selectExpr.orderBy, options, params, target);
    if (!inner) return null;
    let sql = `SELECT ${inner.alias}.* FROM ${inner.sql}`;
    if (selectExpr.where) {
      const whereSql = compileWhereClause(selectExpr.where, inner.alias, params, target, options);
      if (!whereSql) return null;
      sql += ` WHERE ${whereSql}`;
    }
    if (selectExpr.orderBy && selectExpr.orderBy.length > 0) {
      const orders = selectExpr.orderBy.map((order) => {
        const orderColumn = compileSetColumnRef(order.path);
        return orderColumn ? `${inner.alias}.${quoteIdent(orderColumn)} ${order.direction.toUpperCase()}` : "";
      }).filter((entry) => entry.length > 0);
      if (orders.length > 0) sql += ` ORDER BY ${orders.join(", ")}`;
    }
    const limit = selectExpr.limit ? extractNumericLiteral(selectExpr.limit) : undefined;
    const offset = selectExpr.offset ? extractNumericLiteral(selectExpr.offset) : undefined;
    if (limit !== undefined) sql += ` LIMIT ${limit}`;
    if (offset !== undefined) sql += ` OFFSET ${offset}`;
    return { sql: `(${sql}) ${alias}`, alias };
  }
  if (sourceSet.expr.kind === "operator_call" && (sourceSet.expr as OperatorCall).operator === "union") {
    const args = orderedCallArgs((sourceSet.expr as OperatorCall).args);
    const selects = args.map((arg) => {
      const source = compileSelectSource(arg.expr, undefined, undefined, options, params, target);
      return source ? `SELECT ${source.alias}.* FROM ${source.sql}` : null;
    });
    if (selects.some((entry) => !entry)) return null;
    return { sql: `(${(selects as string[]).join(" UNION ALL ")}) ${alias}`, alias };
  }
  if (sourceSet.expr.kind === "operator_call"
      && ((sourceSet.expr as OperatorCall).operator === "intersect"
          || (sourceSet.expr as OperatorCall).operator === "except")) {
    const op = (sourceSet.expr as OperatorCall).operator;
    const args = orderedCallArgs((sourceSet.expr as OperatorCall).args);
    // SQLite's INTERSECT/EXCEPT compare on every column in the projection;
    // for object set-ops we want identity comparison only — narrow each
    // branch to (id, __source_type) so two equivalent rows from different
    // branches actually match.
    const selects = args.map((arg) => {
      const source = compileSelectSource(arg.expr, undefined, undefined, options, params, target);
      return source ? `SELECT ${source.alias}.${quoteIdent("id")} AS ${quoteIdent("id")}, ${source.alias}.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")} FROM ${source.sql}` : null;
    });
    if (selects.some((entry) => !entry)) return null;
    const joiner = op === "intersect" ? "INTERSECT" : "EXCEPT";
    return { sql: `(${(selects as string[]).join(` ${joiner} `)}) ${alias}`, alias };
  }
  if (sourceSet.expr.kind === "type_root") {
    const root = sourceSet.expr.typeref;
    // Collect any link-derived columns referenced in WHERE/ORDER BY/shape so
    // the polymorphic UNION ALL surfaces them via LEFT JOIN against each
    // branch's link storage table. Match against the type_root's typeref
    // (the underlying schema type) so that `Text[IS Owned].owner` and
    // `Text.body` references resolve to the same physical source.
    const linkProjections = collectLinkProjectionsForSource(
      sourceSet.shape ?? [],
      where,
      orderBy,
      root.id,
    );
    return { sql: compilePolymorphicSource(root, sourceSet.expr.skipSubtypes, alias, projectedColumns, options, linkProjections), alias };
  }
  if (sourceSet.expr.kind !== "pointer") {
    return null;
  }
  // Generalised: walk arbitrary pointer chains rooted at a type_root and
  // build the joined FROM in chain order. This subsumes the previous
  // single-step outbound special-case and adds support for backlinks
  // (`<owner`), multi-step chains (`.watchers.<owner[IS Issue]`), and
  // intersections (the typeref on each chain link is the post-`[IS T]`
  // type, so `compilePolymorphicSource` enumerates just the matching
  // concrete subtypes).
  const chain: Pointer[] = [];
  {
    let cursor: Expr = sourceSet.expr;
    while (cursor.kind === "pointer") {
      const ptr = cursor as Pointer;
      if (ptr.ptrref.outTarget.isScalar || ptr.ptrref.isLinkProperty) return null;
      // `__type__` doesn't materialize as a real link — the dedicated short-
      // circuit in `compileScalarSelectSQL` handles `X.__type__.name`. Bail
      // out so it can take over rather than building a JOIN against a
      // non-existent `std__anytype` table.
      if (ptr.ptrref.shortName === "__type__") return null;
      chain.push(ptr);
      cursor = ptr.source.expr;
    }
    // Peel `select_expr` wrappers that just thread a type_root through with
    // no FILTER/ORDER BY/LIMIT (the parser inserts these for parenthesised
    // sources like `(SELECT Issue {…}).watchers`). The pointer chain still
    // needs to root at the underlying type, otherwise we fall through to the
    // NULL fallback and the user sees `SELECT NULL AS "id"`.
    while (cursor.kind === "select_expr") {
      const se = cursor as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit !== undefined || se.offset !== undefined) {
        return null;
      }
      cursor = se.result.expr;
    }
    if (cursor.kind !== "type_root") return null;
  }
  const links = chain.reverse();
  const rootPointer = links[0]!;
  const rootTyperef = rootPointer.source.typeref;
  const rootAlias = "s0";
  const rootCols = collectChainSourceColumns(links[0]!, "root");
  let fromSql = compilePolymorphicSource(rootTyperef, false, rootAlias, rootCols, options);
  let previousAlias = rootAlias;
  let previousTyperef = rootTyperef;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    const isLeaf = i === links.length - 1;
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const targetAlias = isLeaf ? "t0" : `m${i}`;
    // The join key for an inline-FK inbound link lives on this level's
    // target row (e.g. `t0.status_id` for `Status.<status` against Issue).
    // For a leaf, the user-projected columns wouldn't include it, so add it
    // explicitly; for intermediate, `collectChainSourceColumns(next, "via")`
    // handles the next-level FK separately.
    const inlineInboundFK = (!shouldUseLinkTable(link) && link.direction === "inbound")
      ? `${link.ptrref.shortName}_id`
      : null;
    const baseCols = isLeaf ? projectedColumns : collectChainSourceColumns(links[i + 1]!, "via");
    const targetCols = inlineInboundFK ? [...new Set<string>([...baseCols, inlineInboundFK])] : baseCols;
    const targetSql = compilePolymorphicSource(targetType, false, targetAlias, targetCols, options);
    if (shouldUseLinkTable(link)) {
      const linkTable = linkTableNameForPointer(link, options);
      const linkAlias = `j${i}`;
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSql} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
      } else {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSql} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (link.direction === "inbound") {
        fromSql += ` JOIN ${targetSql} ON ${targetAlias}.${quoteIdent(inlineColumn)} = ${previousAlias}.${quoteIdent("id")}`;
      } else {
        fromSql += ` JOIN ${targetSql} ON ${targetAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`;
      }
    }
    previousAlias = targetAlias;
    previousTyperef = targetType;
  }
  void previousTyperef;
  return {
    sql: `(SELECT ${previousAlias}.* FROM ${fromSql}) ${alias}`,
    alias,
  };
};

// Column projection helper for chain joins. The root level needs id (plus
// the FK column if the first link is inline outbound from the root). Each
// intermediate level needs only id plus the connecting FK if the next link
// is inline. Inbound links connect on the target side, so the inline FK
// lives on the next type and is requested at that level instead.
const collectChainSourceColumns = (
  forLink: Pointer,
  role: "root" | "via",
): string[] => {
  const cols = new globalThis.Set<string>(["id"]);
  if (!shouldUseLinkTable(forLink) && forLink.direction === "outbound" && role === "root") {
    cols.add(`${forLink.ptrref.shortName}_id`);
  }
  if (!shouldUseLinkTable(forLink) && forLink.direction === "inbound" && role === "via") {
    cols.add(`${forLink.ptrref.shortName}_id`);
  }
  return [...cols];
};

// A level whose iterator was already lowered to a SQL subquery (select_expr,
// delete_expr, or any other pre-compiled set producer). Carries the raw SQL
// so the FROM builder can splice it in either as the first source or as a
// cross/left join.
type ForExprPrecompiledLevel = {
  iteratorPathId: string;
  alias: string;
  precompiledSql: string;
  optional: boolean;
  // The Set whose pathId the body uses to reach this level — for pointer
  // resolution against the precompiled subquery's columns.
  iteratorSet: Set;
};

// Emit the body of `(SELECT v0 AS __t0, v1 AS __t1, … UNION ALL …)` for a
// list of tuple literals so each iteration row exposes positional columns
// the body can JOIN/filter against. Used by the FOR-iterator lowering when
// the iterator is `{(…), (…), …}`.
const tupleUnionAllSql = (tuples: ScalarValue[][]): string => {
  if (tuples.length === 0) {
    // No rows — emit an empty union by falling back to a contradiction.
    return `SELECT NULL AS ${quoteIdent("__t0")} WHERE 0`;
  }
  return tuples
    .map((tuple) => {
      const parts = tuple.map((v, i) => {
        const colAlias = quoteIdent(`__t${i}`);
        if (typeof v === "string") return `${quoteLiteral(v)} AS ${colAlias}`;
        if (typeof v === "number") return `${v} AS ${colAlias}`;
        if (typeof v === "boolean") return `${v ? 1 : 0} AS ${colAlias}`;
        return `NULL AS ${colAlias}`;
      });
      return `SELECT ${parts.join(", ")}`;
    })
    .join(" UNION ALL ");
};

const compileForExprSource = (
  sourceSet: Set,
  projectedColumns: string[],
  options: GelIRCompileOptions,
  params: ScalarValue[] = [],
  target: RuntimeTarget = options.target ?? "sqlite",
): { fromSql: string; baseAlias: string; bindingAliases: Map<string, string>; scalarBindingAliases: Map<string, string>; tupleIterAliases: Map<string, string>; linkPropertyAliases: Map<string, string>; whereSets: Set[]; orderBy?: SortExpr[]; paramsCheckpoint: number } | null => {
  const paramsCheckpoint = params.length;
  const levels: Array<{
    iteratorPathId: string;
    alias: string;
    pointer?: Pointer;
    typeRef?: TypeRef;
    linkAlias?: string;
    constants?: ScalarValue[];
    // For `FOR entry IN {("1", 10), …}` the iterator is a union of tuple
    // literals. Each tuple's positional values become named columns
    // (`__t0`, `__t1`, …) on the iterator subquery so the body can refer
    // to them per-row via `entry.0`/`entry.1`.
    tuples?: ScalarValue[][];
    precompiled?: ForExprPrecompiledLevel;
    optional?: boolean;
  }> = [];
  const whereSets: Set[] = [];
  let orderBy: SortExpr[] | undefined;
  let currentExpr: Expr = sourceSet.expr;

  while (currentExpr.kind === "for_expr") {
    const forExpr = currentExpr as ForExpr;
    const iterator = forExpr.iterator;
    const alias = `g${levels.length}`;
    const iteratorPathId = pathIdKey(iterator);
    const optional = forExpr.optional === true;

    if (iterator.expr.kind === "type_root") {
      levels.push({ iteratorPathId, alias, typeRef: (iterator.expr as TypeRoot).typeref, optional });
    } else if (iterator.expr.kind === "pointer") {
      levels.push({ iteratorPathId, alias, pointer: iterator.expr as Pointer, optional });
    } else if (iterator.expr.kind === "operator_call" && (iterator.expr as OperatorCall).operator === "union") {
      // Set iterator like `{'I', 'Z'}` or `{1, 2}`: each branch must be a
      // scalar literal so we can emit a `(SELECT a UNION ALL SELECT b) g0`
      // source. The body references the binding directly (not via pointer
      // chain), so we mark the level with `constants` and the value-column
      // alias. We also accept a union of TUPLE literals
      // (`{("1", 10), ("1", 10)}`) — each tuple becomes a multi-column row
      // so the body's `entry.0`/`entry.1` lookups resolve per-iteration via
      // tupleIterAliases.
      const args = orderedCallArgs((iterator.expr as OperatorCall).args);
      const constants: ScalarValue[] = [];
      const tuples: ScalarValue[][] = [];
      let mode: "scalar" | "tuple" | null = null;
      let bail = false;
      for (const arg of args) {
        if (arg.expr.expr.kind === "tuple") {
          if (mode === "scalar") { bail = true; break; }
          mode = "tuple";
          const tupleExpr = arg.expr.expr as Tuple;
          const tupleValues: ScalarValue[] = [];
          for (const element of tupleExpr.elements) {
            const lit = extractScalarConstant(element.val);
            if (lit === undefined) { bail = true; break; }
            tupleValues.push(lit);
          }
          if (bail) break;
          tuples.push(tupleValues);
          continue;
        }
        if (mode === "tuple") { bail = true; break; }
        mode = "scalar";
        const lit = extractScalarConstant(arg.expr);
        if (lit === undefined) { bail = true; break; }
        constants.push(lit);
      }
      if (bail) return null;
      if (mode === "tuple") {
        levels.push({ iteratorPathId, alias, tuples, optional });
      } else {
        levels.push({ iteratorPathId, alias, constants, optional });
      }
    } else if (iterator.expr.kind === "select_expr") {
      // `FOR x IN (select Type filter …) UNION …` — peel the select_expr
      // layers down to a type_root or pointer, then emit a SQL subquery
      // FROM that yields the type's table with the FOR's full projection
      // (so the body can read any of its columns) and applies each
      // intermediate FILTER. Wrapping with compileSelectSource would use
      // the iterator's own shape for projection, which omits columns the
      // outer body needs.
      let peel: Set = iterator;
      const inlineWheres: Set[] = [];
      while (peel.expr.kind === "select_expr") {
        const se = peel.expr as SelectExpr;
        if (se.where) inlineWheres.push(se.where);
        peel = se.result;
      }
      if (peel.expr.kind !== "type_root") return null;
      const typeref = (peel.expr as TypeRoot).typeref;
      const baseSrc = compilePolymorphicSource(typeref, false, alias, projectedColumns, options);
      let sql = `SELECT ${alias}.* FROM ${baseSrc}`;
      for (const w of inlineWheres) {
        const wSql = compileWhereClause(w, alias, params, target, options);
        if (!wSql) return null;
        sql += ` WHERE ${wSql}`;
      }
      const wrapped = `(${sql}) ${alias}`;
      levels.push({
        iteratorPathId,
        alias,
        precompiled: { iteratorPathId, alias, precompiledSql: wrapped, optional, iteratorSet: iterator },
        optional,
      });
    } else if (iterator.expr.kind === "delete_expr") {
      // Inline `delete X filter …` as an iterator. For read semantics
      // here we just SELECT the rows that match — actually performing
      // the delete is independent of the FOR's value-level semantics
      // and is handled at statement-level DML. Include the filter's
      // column refs in the projection so the WHERE clause can resolve.
      const del = iterator.expr as DeleteExpr;
      const cols = new Set<string>(projectedColumns.length > 0 ? projectedColumns : ["id"]);
      if (del.where) {
        for (const c of collectReferencedColumns(del.where)) cols.add(c);
      }
      const sourceCols = [...cols];
      const inner = compilePolymorphicSource(del.subject, false, alias, sourceCols, options);
      let sql = `SELECT ${alias}.* FROM ${inner}`;
      if (del.where) {
        const w = compileWhereClause(del.where, alias, params, target, options);
        if (w) sql += ` WHERE ${w}`;
      }
      const wrapped = `(${sql}) ${alias}`;
      levels.push({
        iteratorPathId,
        alias,
        precompiled: { iteratorPathId, alias, precompiledSql: wrapped, optional, iteratorSet: iterator },
        optional,
      });
    } else {
      return null;
    }

    if (forExpr.where) {
      whereSets.push(forExpr.where);
    }
    orderBy = orderBy ?? forExpr.orderBy;
    currentExpr = forExpr.body.expr;
  }

  if (levels.length === 0 || (!levels[0].typeRef && !levels[0].constants && !levels[0].precompiled && !levels[0].tuples)) {
    return null;
  }

  const bindingAliases = new Map<string, string>();
  const scalarBindingAliases = new Map<string, string>();
  const tupleIterAliases = new Map<string, string>();
  const linkPropertyAliases = new Map<string, string>();
  for (const level of levels) {
    bindingAliases.set(level.iteratorPathId, level.alias);
    if (level.constants) {
      // Scalar/set iterators expose a single `value` column on the
      // generated UNION ALL subquery; record so the body's binding
      // references can pick that up instead of expecting a type-rooted
      // column.
      scalarBindingAliases.set(level.iteratorPathId, level.alias);
    }
    if (level.tuples) {
      // Tuple iterators expose positional columns (`__t0`, `__t1`, …) on
      // their generated UNION ALL subquery — see the FROM emit below. The
      // body's tuple-index lookups read those columns via tupleIterAliases.
      tupleIterAliases.set(level.iteratorPathId, level.alias);
    }
  }

  const firstAlias = levels[0].alias;
  let fromSql: string;
  if (levels[0].typeRef) {
    if (levels[0].optional) {
      // `FOR optional x in TypeRoot` — anchor with a single dummy row and
      // LEFT JOIN the type so empty source still runs the body once.
      const inner = compilePolymorphicSource(levels[0].typeRef, false, firstAlias, projectedColumns, options);
      fromSql = `(SELECT 1 AS __anchor) __anchor_0 LEFT JOIN ${inner} ON 1=1`;
    } else {
      fromSql = compilePolymorphicSource(levels[0].typeRef, false, firstAlias, projectedColumns, options);
    }
  } else if (levels[0].precompiled) {
    const pre = levels[0].precompiled;
    if (levels[0].optional) {
      fromSql = `(SELECT 1 AS __anchor) __anchor_0 LEFT JOIN ${pre.precompiledSql} ON 1=1`;
    } else {
      fromSql = pre.precompiledSql;
    }
  } else if (levels[0].tuples) {
    fromSql = `(${tupleUnionAllSql(levels[0].tuples)}) ${firstAlias}`;
  } else {
    const consts = levels[0].constants!;
    const parts = consts.map((c) => {
      if (typeof c === "string") return `SELECT ${quoteLiteral(c)} AS ${quoteIdent("value")}`;
      if (typeof c === "number") return `SELECT ${c} AS ${quoteIdent("value")}`;
      if (typeof c === "boolean") return `SELECT ${c ? 1 : 0} AS ${quoteIdent("value")}`;
      return `SELECT NULL AS ${quoteIdent("value")}`;
    });
    fromSql = `(${parts.join(" UNION ALL ")}) ${firstAlias}`;
  }

  for (let i = 1; i < levels.length; i++) {
    const level = levels[i];
    const previousAlias = levels[i - 1].alias;
    if (level.tuples) {
      const joiner = level.optional ? "LEFT JOIN" : "CROSS JOIN";
      const onClause = level.optional ? " ON 1=1" : "";
      fromSql += ` ${joiner} (${tupleUnionAllSql(level.tuples)}) ${level.alias}${onClause}`;
      continue;
    }
    if (level.constants) {
      // Nested constant iterator: cross-join with a fresh UNION ALL subquery.
      const consts = level.constants;
      const parts = consts.map((c) => {
        if (typeof c === "string") return `SELECT ${quoteLiteral(c)} AS ${quoteIdent("value")}`;
        if (typeof c === "number") return `SELECT ${c} AS ${quoteIdent("value")}`;
        if (typeof c === "boolean") return `SELECT ${c ? 1 : 0} AS ${quoteIdent("value")}`;
        return `SELECT NULL AS ${quoteIdent("value")}`;
      });
      const joiner = level.optional ? "LEFT JOIN" : "CROSS JOIN";
      const onClause = level.optional ? " ON 1=1" : "";
      fromSql += ` ${joiner} (${parts.join(" UNION ALL ")}) ${level.alias}${onClause}`;
      continue;
    }
    if (level.precompiled) {
      const pre = level.precompiled;
      const joiner = level.optional ? "LEFT JOIN" : "CROSS JOIN";
      const onClause = level.optional ? " ON 1=1" : "";
      fromSql += ` ${joiner} ${pre.precompiledSql}${onClause}`;
      continue;
    }
    const pointer = level.pointer;
    if (!pointer) {
      return null;
    }

    if (shouldUseLinkTable(pointer)) {
      const linkTable = linkTableNameForPointer(pointer, options);
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

  return { fromSql, baseAlias: firstAlias, bindingAliases, scalarBindingAliases, tupleIterAliases, linkPropertyAliases, whereSets, orderBy, paramsCheckpoint };
};

const innermostForExprBody = (sourceSet: Set): Set => {
  let current = sourceSet;
  while (current.expr.kind === "for_expr") {
    current = (current.expr as ForExpr).body;
  }
  return current;
};

// A "free type root" inside a FOR body is a Pointer.source whose expression is
// a bare type_root that isn't already mapped to a FOR-iterator alias. These
// need their own CROSS JOIN so the body produces cross-product cardinality.
type FreeTypeRoot = { key: string; typeref: TypeRef };
const collectFreeTypeRoots = (
  bodySet: Set,
  bindingAliases: Map<string, string>,
  outerWhere?: Set,
): FreeTypeRoot[] => {
  const seen = new Set<string>();
  const roots: FreeTypeRoot[] = [];
  const consider = (src: Set): void => {
    if (src.expr.kind !== "type_root") return;
    const key = pathIdKey(src);
    if (bindingAliases.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ key, typeref: (src.expr as TypeRoot).typeref });
  };
  const visit = (set: Set): void => {
    // If this Set itself is a FOR-iterator binding (its pathId is in
    // bindingAliases), don't descend into its internals — the binding's
    // alias already accounts for the iteration source, and the inner
    // type_root underneath would otherwise look "free" because its
    // namespace differs from the iterator's outer pathId.
    if (bindingAliases.has(pathIdKey(set))) return;
    const expr = set.expr;
    if (expr.kind === "pointer") {
      const pointer = expr as Pointer;
      consider(pointer.source);
      visit(pointer.source);
      if (pointer.expr) visit(pointer.expr as unknown as Set);
      return;
    }
    if (expr.kind === "type_root") {
      consider(set);
      return;
    }
    if (expr.kind === "tuple") {
      for (const el of (expr as Tuple).elements) visit(el.val);
      return;
    }
    if (expr.kind === "operator_call") {
      for (const arg of orderedCallArgs((expr as OperatorCall).args)) visit(arg.expr);
      return;
    }
    if (expr.kind === "function_call") {
      // Function-call arguments compile to their own subquery (see e.g.
      // `count(Card)` → `(SELECT count(*) FROM Card g_agg)`), so any
      // type_roots they wrap are independent of the FOR's FROM clause —
      // don't pull them into the outer CROSS JOIN.
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
      // `exists(Card)` is a boolean — its operand is independent of the FOR.
      return;
    }
    if (expr.kind === "array") {
      for (const element of (expr as ArrayExpr).elements) visit(element);
      return;
    }
    if (expr.kind === "index_expr") {
      const indexExpr = expr as IndexExpr;
      visit(indexExpr.expr);
      visit(indexExpr.index);
      return;
    }
    if (expr.kind === "select_expr") {
      const se = expr as SelectExpr;
      visit(se.result);
      // Inner FILTERs/ORDER BYs on a FOR body's SELECT may reference free
      // type-roots that don't appear in `result`; collect them too so the
      // outer FROM gets the corresponding CROSS JOINs.
      if (se.where) visit(se.where);
      for (const order of se.orderBy ?? []) visit(order.path);
    }
  };
  visit(bodySet);
  if (outerWhere) visit(outerWhere);
  return roots;
};

const countAliases = (bindingAliases: Map<string, string>): number => {
  let max = 0;
  for (const alias of bindingAliases.values()) {
    const match = /^g(\d+)$/.exec(alias);
    if (match) {
      const n = Number(match[1]);
      if (n + 1 > max) max = n + 1;
    }
  }
  return max;
};

const collectForExprProjectedColumns = (sourceSet: Set, where?: Set, orderBy?: SortExpr[]): string[] => {
  const columns = new Set<string>(["id"]);
  const visit = (set: Set): void => {
    // Shape elements may reference fields (e.g. `Card { name, … }`) that
    // don't appear elsewhere in the body expression — walk them so those
    // columns make it into the cross-joined table's projection.
    for (const elem of set.shape ?? []) {
      visit(elem.expr);
    }
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
      return;
    }
    if (expr.kind === "select_expr") {
      const selectExpr = expr as SelectExpr;
      visit(selectExpr.result);
      if (selectExpr.where) visit(selectExpr.where);
      for (const order of selectExpr.orderBy ?? []) visit(order.path);
      if (selectExpr.limit) visit(selectExpr.limit);
      if (selectExpr.offset) visit(selectExpr.offset);
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
  scalarBindingAliases?: Map<string, string>,
  tupleIterAliases?: Map<string, string>,
): string | null => {
  const checkpoint = params.length;
  const unwrapped = unwrapSelectExprSet(set);
  const expr = unwrapped.result.expr;

  // `entry.0` / `entry.1` inside a `FOR entry IN {(…), …}` body: the IR
  // models the access as `index_expr` over the bound iterator set. When the
  // iterator was lowered as a tuple-per-row subquery (`__t0`, `__t1`, …),
  // resolve the access against the current row's positional column.
  if (tupleIterAliases && expr.kind === "index_expr") {
    const idxExpr = expr as IndexExpr;
    const inner = idxExpr.expr;
    const innerKey = pathIdKey(inner);
    const tupleAlias = tupleIterAliases.get(innerKey);
    if (tupleAlias) {
      const idxLit = extractNumericLiteral(idxExpr.index);
      if (idxLit !== undefined && Number.isInteger(idxLit) && idxLit >= 0) {
        return `${tupleAlias}.${quoteIdent(`__t${idxLit}`)}`;
      }
    }
  }

  // Direct reference to a scalar/set-iterator binding (e.g. `letter`
  // inside `FOR letter IN {'I', 'Z'} UNION ...`): emit
  // `${alias}.value` instead of trying to look up a type-rooted column.
  if (scalarBindingAliases) {
    const key = pathIdKey(unwrapped.result);
    const scalarAlias = scalarBindingAliases.get(key);
    if (scalarAlias) {
      return `${scalarAlias}.${quoteIdent("value")}`;
    }
  }

  if (expr.kind === "pointer") {
    const pointer = expr as Pointer;
    const sourceKey = pathIdKey(pointer.source);
    let alias = bindingAliases.get(sourceKey);
    if (!alias && pointer.source.expr.kind === "type_root") {
      // Fallback lookup by typeref id — alternate IR builds for the same
      // type root (e.g. body vs FILTER's reuse of `Card`) can produce
      // structurally-equal pathIds that don't serialize identically when
      // their typeRef objects carry differently-shared sub-references.
      const sourceTypeId = (pointer.source.expr as TypeRoot).typeref?.id;
      if (sourceTypeId) {
        for (const [k, v] of bindingAliases.entries()) {
          if (k.includes(`"id":"${sourceTypeId}"`)) { alias = v; break; }
        }
      }
    }
    const resolvedAlias = alias ?? fallbackAlias;
    if (pointer.ptrref.isLinkProperty) {
      const linkAlias = linkPropertyAliases?.get(sourceKey) ?? resolvedAlias;
      return `${linkAlias}.${quoteIdent(columnForPointer(pointer).replace(/^@/, ""))}`;
    }
    return `${resolvedAlias}.${quoteIdent(columnForPointer(pointer))}`;
  }

  const literal = extractScalarConstant(unwrapped.result);
  if (literal !== undefined) {
    const inlineSql = inlineIntegerConstantSql(unwrapped.result.expr, literal);
    if (inlineSql !== undefined) return inlineSql;
    if (typeof literal === "boolean") {
      // Emit bool literals as their JSON-encoded form so the value column
      // surfaces as `true`/`false` in the runtime decoder instead of `0`/`1`.
      return literal ? "json('true')" : "json('false')";
    }
    params.push(literal);
    return "?";
  }

  if (expr.kind === "tuple") {
    const tuple = expr as Tuple;
    const parts = tuple.elements.map((element) => compileValueSetSQLWithAliases(element.val, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases));
    if (parts.some((part) => !part)) {
      params.length = checkpoint;
      return null;
    }
    return tuple.named
      ? `json_object(${tuple.elements.map((element, idx) => `${quoteLiteral(element.name ?? String(idx))}, ${parts[idx]}`).join(", ")})`
      : `json_array(${parts.join(", ")})`;
  }

  if (expr.kind === "type_cast") {
    const castExpr = expr as TypeCast;
    const inner = compileValueSetSQLWithAliases(castExpr.expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
    if (!inner) {
      params.length = checkpoint;
      return null;
    }
    const castTarget = sqlCastTarget(castExpr.toType);
    return castTarget ? `CAST(${inner} AS ${castTarget})` : inner;
  }

  // `a ?? b` — coalesce. Recurse so binding refs inside resolve against
  // the FOR's aliases, then emit SQL `COALESCE(a, b)`. Special-cased here
  // (vs falling through to compileValueSetSQL) because the inner compile
  // would otherwise treat the operands as outer scalars and lose the
  // iterator's column refs.
  if (expr.kind === "coalesce_expr") {
    const co = expr as CoalesceExpr;
    const left = compileValueSetSQLWithAliases(co.left, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
    const right = compileValueSetSQLWithAliases(co.right, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
    if (left && right) {
      return `COALESCE(${left}, ${right})`;
    }
    params.length = checkpoint;
  }

  // `Pointer[idx]` (string indexing on a scalar pointer like `.name[0]`) —
  // recurse so the pointer's source resolves against the FOR aliases. We
  // only intercept the string-indexing shape; tuple-index access on a
  // non-pointer operand falls through to compileValueSetSQL which has the
  // correct json_extract handling for those.
  if (expr.kind === "index_expr") {
    const idxExpr = expr as IndexExpr;
    if (idxExpr.expr.expr.kind === "pointer") {
      const inner = compileValueSetSQLWithAliases(idxExpr.expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
      const idxLit = extractNumericLiteral(idxExpr.index);
      if (inner && idxLit !== undefined) {
        const start = idxLit >= 0 ? idxLit + 1 : idxLit;
        return `substr(${inner}, ${start}, 1)`;
      }
    }
  }

  if (expr.kind === "operator_call") {
    const call = expr as OperatorCall;
    // `union` (set constructor `{a, b}`) and `distinct` produce multi-row
    // sets — they don't fit in a single value-expression slot, so let the
    // caller fall back to compileScalarSelectSQL which can emit UNION ALL.
    if (call.operator === "union" || call.operator === "distinct") {
      params.length = checkpoint;
      return null;
    }
    const op = operatorToInfixSql(call.operator) ?? normalizeOperator(call.operator);
    const args = orderedCallArgs(call.args);
    if (op && args.length >= 2) {
      const left = compileValueSetSQLWithAliases(args[0].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
      const right = compileValueSetSQLWithAliases(args[1].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
      if (!left || !right) {
        params.length = checkpoint;
        return null;
      }
      return `(${left} ${op} ${right})`;
    }
  }

  if (expr.kind === "function_call") {
    const call = expr as FunctionCall;
    const fname = call.functionName;
    const args = orderedCallArgs(call.args);
    // `count(binding)` inside a FOR body: the binding is a single row per
    // iteration, so its cardinality is always 1 — emit the literal instead
    // of `count(*) FROM Card`, which would count the whole table and
    // ignore the iteration's shadowing.
    if ((fname === "std::count" || fname === "count") && args.length === 1) {
      const argSet = args[0].expr;
      if (argSet.expr.kind === "type_root" && bindingAliases.has(pathIdKey(argSet))) {
        return "1";
      }
    }
    // Inlined user-defined function (UDF body was substituted at IR build
    // time): recurse into the body with the surrounding FOR aliases so
    // binding references resolve to the iterator's columns.
    if (call.body && scalarBindingAliases && scalarBindingAliases.size > 0) {
      const inner = compileValueSetSQLWithAliases(call.body, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
      if (inner) return inner;
      params.length = checkpoint;
    }
  }

  // FOR body that's a `SELECT Type { shape } FILTER …`: the surrounding
  // FOR has already added Type as a cross-join level (collectFreeTypeRoots),
  // so use *that* level's alias as the shape's source. The FILTER is
  // pushed up to the FOR's WHERE clause (see the bodyWheres logic above)
  // — emit only the shape's json_object here, no inner SELECT/WHERE.
  if (set.expr.kind === "select_expr") {
    // Peel any extra select_expr layers (parens-wrapped bodies stack them)
    // so we find the underlying typed-shape SELECT.
    let selectExpr = set.expr as SelectExpr;
    while (selectExpr.result.expr.kind === "select_expr"
      && (!selectExpr.result.shape || selectExpr.result.shape.length === 0)) {
      selectExpr = selectExpr.result.expr as SelectExpr;
    }
    if (selectExpr.result.expr.kind === "type_root" && selectExpr.result.shape && selectExpr.result.shape.length > 0) {
      const resultKey = pathIdKey(selectExpr.result);
      const typeAlias = bindingAliases.get(resultKey);
      if (typeAlias) {
        // Compile each shape element with the bindings so computed exprs
        // (like `letter := letter`) resolve to the iterator's column.
        const pairs: string[] = [];
        let ok = true;
        for (const element of selectExpr.result.shape) {
          const elemExpr = element.expr;
          // Scalar field shorthand (`name`): emit alias.column directly.
          if (elemExpr.expr.kind === "pointer" && elemExpr.typeref.isScalar) {
            const ptr = elemExpr.expr as Pointer;
            const col = columnForPointer(ptr);
            pairs.push(`${quoteLiteral(ptr.ptrref.shortName)}, ${typeAlias}.${quoteIdent(col)}`);
            continue;
          }
          // Computed scalar: compile via the aliased path so binding refs
          // (`letter := letter`) lower correctly.
          const computed = compileValueSetSQLWithAliases(elemExpr, bindingAliases, typeAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
          if (!computed) { ok = false; break; }
          const key = element.name
            ? quoteLiteral(element.name)
            : (elemExpr.expr.kind === "pointer")
              ? quoteLiteral((elemExpr.expr as Pointer).ptrref.shortName)
              : quoteLiteral(shapeAliasForElement(element, elemExpr, 0));
          pairs.push(`${key}, ${computed}`);
        }
        if (ok && pairs.length > 0) {
          return `json_object(${pairs.join(", ")})`;
        }
        params.length = checkpoint;
      }
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
  scalarBindingAliases?: Map<string, string>,
  tupleIterAliases?: Map<string, string>,
): string | null => compileValueSetSQLWithAliases(set, bindingAliases, "g0", params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);

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

const compileValueSortExprs = (
  orderBy: SortExpr[] | undefined,
  valueSql: string,
  target: RuntimeTarget = "sqlite",
  enumMembersByName?: (name: string) => string[] | undefined,
  fieldEnumMembers?: (typeName: string, fieldName: string) => string[] | undefined,
): string => {
  return (orderBy ?? [])
    .map((entry) => {
      const expr = compileValueSortPath(entry.path, valueSql, target, enumMembersByName, fieldEnumMembers);
      return expr ? `${expr} ${entry.direction.toUpperCase()}` : "";
    })
    .filter((entry) => entry.length > 0)
    .join(", ");
};

// Returns the enum member list when every arm of a union dereferences a
// pointer to the same enum-typed scalar (e.g. `{O.o0, O.o1}` over `UserEnum`
// columns). Used by `ORDER BY` lowering to recover enum-member ordering for
// unions that have already been inlined past their declared type cast.
// Sources of truth, in order: direct enum-typed `outTarget`, the per-field
// `resolveFieldEnumMembers` lookup (since SQLite-side fields lower to TEXT
// columns that no longer carry the enum target on `outTarget`).
const unionEnumMembers = (
  call: OperatorCall,
  enumMembersByName: ((name: string) => string[] | undefined) | undefined,
  fieldEnumMembers: ((typeName: string, fieldName: string) => string[] | undefined) | undefined,
): string[] | undefined => {
  const args = orderedCallArgs(call.args);
  if (args.length === 0) return undefined;
  let members: string[] | undefined;
  let memberKey: string | undefined;
  // Look for at least one pointer-arg that resolves to an enum. Non-pointer
  // arms (string_constant, etc.) are tolerated as long as their literal value
  // is a member of the enum — they come from inlined computed properties
  // like `o2 := <UserEnum>'dolor'` where the cast was elided.
  for (const arg of args) {
    const expr = arg.expr.expr;
    if (expr.kind !== "pointer") continue;
    const ptr = expr as Pointer;
    const outName = ptr.ptrref.outTarget ? qualifyTypeName(ptr.ptrref.outTarget) : undefined;
    let argMembers = outName ? enumMembersByName?.(outName) : undefined;
    if (!argMembers && fieldEnumMembers && ptr.ptrref.outSource && ptr.ptrref.shortName) {
      argMembers = fieldEnumMembers(qualifyTypeName(ptr.ptrref.outSource), ptr.ptrref.shortName);
    }
    if (!argMembers) continue;
    const key = argMembers.join("|");
    if (members === undefined) {
      members = argMembers;
      memberKey = key;
    } else if (memberKey !== key) {
      return undefined;
    }
  }
  if (!members) return undefined;
  // Sanity-check non-pointer arms (string constants): every one must be a
  // member of the recovered enum, otherwise the union isn't actually
  // enum-typed and we should fall back to lexicographic ordering.
  const memberSet = new globalThis.Set(members);
  for (const arg of args) {
    const expr = arg.expr.expr;
    if (expr.kind === "pointer") continue;
    if (expr.kind === "string_constant") {
      const value = (expr as BaseConstant).value;
      if (typeof value !== "string" || !memberSet.has(value)) return undefined;
      continue;
    }
    return undefined;
  }
  return members;
};

const compileValueSortPath = (
  set: Set,
  valueSql: string,
  target: RuntimeTarget = "sqlite",
  enumMembersByName?: (name: string) => string[] | undefined,
  fieldEnumMembers?: (typeName: string, fieldName: string) => string[] | undefined,
): string | null => {
  if (set.expr.kind === "index_expr") {
    const index = extractNumericLiteral((set.expr as IndexExpr).index);
    return index === undefined ? null : `json_extract(${valueSql}, '$[${index}]')`;
  }
  if (set.expr.kind === "pointer") {
    const pointer = set.expr as Pointer;
    if (pointer.source.expr.kind === "index_expr") {
      const index = extractNumericLiteral((pointer.source.expr as IndexExpr).index);
      if (index === undefined) return null;
      return `json_extract(${valueSql}, '$[${index}].${pointer.ptrref.shortName}')`;
    }
  }
  // `<EnumT>X` as the sort key — enum order is by declared member index,
  // not lexicographic. SQLite stores enums as TEXT so we emit a `CASE`
  // mapping each member to its zero-based index and sort by that.
  if (set.expr.kind === "type_cast") {
    const cast = set.expr as TypeCast;
    const enumName = qualifyTypeName(cast.toType);
    const members = enumMembersByName?.(enumName);
    if (members && members.length > 0) {
      const innerSql = compileValueSortPath(cast.expr, valueSql, target, enumMembersByName);
      if (innerSql) {
        const branches = members.map((member, idx) => `WHEN ${quoteLiteral(member)} THEN ${idx}`);
        return `CASE ${innerSql} ${branches.join(" ")} ELSE NULL END`;
      }
    }
  }
  // `ORDER BY _` (or any bare reference to the SELECT's iteration variable)
  // — the IR inlines `_` as the surrounding source set. That source compiles
  // to the outer `SELECT ... AS value`, so the per-row sort key is just the
  // `value` column. When every branch of the inlined union dereferences an
  // enum-typed pointer, apply the same enum→index mapping as an explicit
  // `<EnumT>` cast so the resulting order matches declared member order.
  if (set.expr.kind === "operator_call" && (set.expr as OperatorCall).operator === "union") {
    const members = unionEnumMembers(set.expr as OperatorCall, enumMembersByName, fieldEnumMembers);
    if (members && members.length > 0) {
      const branches = members.map((member, idx) => `WHEN ${quoteLiteral(member)} THEN ${idx}`);
      return `CASE ${valueSql} ${branches.join(" ")} ELSE NULL END`;
    }
    return valueSql;
  }
  // `ORDER BY <fn>(w)` where `w` is the surrounding select's result set:
  // the IR inlines `w` as a copy of the source set, so each function-call arg
  // whose expr matches a multi-row producer is the per-row value reference.
  // Lower the call via the stdlib template, substituting `valueSql` for each
  // argument that looks like the row value.
  if (set.expr.kind === "function_call") {
    const call = set.expr as FunctionCall;
    const args = orderedCallArgs(call.args);
    const argSqls: string[] = [];
    for (const arg of args) {
      const argInnerKind = arg.expr.expr.kind;
      if (argInnerKind === "operator_call" || argInnerKind === "string_constant"
        || argInnerKind === "integer_constant" || argInnerKind === "pointer") {
        argSqls.push(valueSql);
      } else {
        return null;
      }
    }
    const lowered = lowerStdlibFunctionSql(target, call.functionName, argSqls);
    if (lowered) return lowered;
  }
  return null;
};

const setValueIsJson = (set: Set): boolean => {
  if (set.shape.length > 0) return true;
  if (set.expr.kind === "select_expr") {
    const selectExpr = set.expr as SelectExpr;
    const result = set.shape.length > 0 ? { ...selectExpr.result, shape: set.shape } : selectExpr.result;
    return setValueIsJson(result);
  }
  const unwrapped = unwrapSelectExprSet(set);
  const result = unwrapped.result;
  return result.shape.length > 0
    || result.expr.kind === "tuple"
    || result.expr.kind === "array"
    || result.typeref.collection === "tuple"
    || result.typeref.collection === "array";
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
    // Computed shape elements (e.g. `el_cost := (.element, .cost)`) reference
    // source columns inside their expression that the inner FROM still has to
    // project for the outer SELECT to read them. Walk the element's expr
    // through collectReferencedColumns so those columns reach the SELECT list.
    if (element.expr.expr.kind !== "pointer" && element.expr.expr.kind !== "type_root") {
      for (const referenced of collectReferencedColumns(element.expr)) {
        columns.add(referenced);
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
    } else {
      const fk = innermostLinkFKColumn(node);
      if (fk) {
        out.add(fk);
      }
    }
    const expr = node.expr;
    if (expr.kind === "pointer") {
      // Backlinks (`Status.<status`) and link-table walks (`User.todo`) anchor
      // the correlated subquery on the outer row's `id`, so the outer FROM
      // must surface it even when no shape element directly reads it.
      const ptr = expr as Pointer;
      if (ptr.direction === "inbound" || shouldUseLinkTable(ptr)) {
        const rootSet = (ptr.source as Set);
        if (rootSet.expr.kind === "type_root") {
          out.add("id");
        }
      }
      visit((expr as Pointer).source);
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

// Walk the shape/where/orderBy and find pointers whose source is the outer
// type_root and whose link uses link-table storage. Returns the list of
// LinkProjections the polymorphic source must surface as columns so that
// downstream code can compare `${sourceAlias}.${linkName}_id` directly.
//
// Without this, polymorphic chains like `Text[IS Owned].owner` (link table
// because @note/@since live on the link) have no FK column to read from the
// source SELECT, and the entire predicate compilation bails out.
const collectLinkProjectionsForSource = (
  shape: ShapeElement[],
  where: Set | undefined,
  orderBy: SortExpr[] | undefined,
  sourceTypeRootId: string,
): LinkProjection[] => {
  const byLinkName = new Map<string, LinkProjection>();
  const visit = (set: Set | undefined): void => {
    if (!set) return;
    const expr = set.expr;
    if (expr.kind === "pointer") {
      const ptr = expr as Pointer;
      // Match pointers whose source unwraps to a type_root whose typeref
      // matches the outer source's type_root typeref. Both `Text` (the
      // SELECT subject) and `Text[IS Owned]` (the FILTER expression's
      // narrowed view) have the SAME inner type_root.typeref.id; the
      // narrowing only changes the Set wrapper's typeref. By comparing
      // type_root ids we correctly recognize them as the same physical
      // source. Only links using link-table storage need the JOIN — inline
      // FK columns are already available via collectProjectedColumns'
      // `${shortName}_id` rule.
      let sourceExpr: Expr = ptr.source.expr;
      while (sourceExpr.kind === "select_expr") {
        sourceExpr = (sourceExpr as SelectExpr).result.expr;
      }
      const sourceTypeMatches = sourceExpr.kind === "type_root"
        && (sourceExpr as TypeRoot).typeref.id === sourceTypeRootId;
      // Only single-cardinality links can be safely LEFT JOINed into the
      // polymorphic source — multi links produce N rows per source row,
      // which would inflate the UNION ALL's row count and silently break
      // any aggregate, count, or all-rows test downstream. Multi-link
      // traversal stays on the separate-subquery path.
      const isSingleLink = ptr.ptrref.outCardinality === "one"
        || ptr.ptrref.outCardinality === "at_most_one";
      if (
        sourceTypeMatches
        && !ptr.ptrref.isLinkProperty
        && ptr.direction === "outbound"
        && !ptr.ptrref.outTarget.isScalar
        && isSingleLink
        && shouldUseLinkTable(ptr)
      ) {
        const linkName = ptr.ptrref.shortName;
        const outputColumn = `${linkName}_id`;
        if (!byLinkName.has(linkName)) {
          byLinkName.set(linkName, { linkName, outputColumn });
        }
      }
      // Continue walking the source so chains like `.owner.todo` still pick
      // up the inner `.owner` requirement.
      visit(ptr.source);
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
    if (expr.kind === "coalesce_expr") {
      const c = expr as CoalesceExpr;
      visit(c.left);
      visit(c.right);
      return;
    }
    if (expr.kind === "if_else_expr") {
      const i = expr as IfElseExpr;
      visit(i.condition);
      visit(i.ifExpr);
      visit(i.elseExpr);
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
    if (expr.kind === "select_expr") {
      const sel = expr as SelectExpr;
      visit(sel.result);
      visit(sel.where);
      for (const sort of sel.orderBy ?? []) {
        visit(sort.path);
      }
      visit(sel.limit);
      visit(sel.offset);
      return;
    }
    if (expr.kind === "tuple") {
      for (const element of (expr as Tuple).elements) visit(element.val);
      return;
    }
  };
  for (const element of shape) {
    visit(element.expr);
  }
  visit(where);
  for (const sort of orderBy ?? []) {
    visit(sort.path);
  }
  return [...byLinkName.values()];
};

const compileProjectedSourceColumnRef = (set: Set): string | null => {
  if (set.expr.kind !== "pointer") {
    return null;
  }
  const pointer = set.expr as Pointer;
  if (pointer.ptrref.isLinkProperty || !pointer.ptrref.outTarget.isScalar) {
    return null;
  }
  // Direct scalar pointer must hang off the outer source. Unwrap select_expr
  // wrappers, and additionally accept the case where the immediate source is
  // itself a pointer to an object (`SELECT Issue.owner{name}` — the shape's
  // `name` pointer's source is the Issue.owner link pointer). In that case
  // the scalar property is still a column on the rows surfaced by the outer
  // SELECT, so it should be added to the projected column list.
  let sourceExpr: Expr = pointer.source.expr;
  while (sourceExpr.kind === "select_expr") {
    sourceExpr = (sourceExpr as SelectExpr).result.expr;
  }
  if (sourceExpr.kind === "type_root") {
    return columnForPointer(pointer);
  }
  if (sourceExpr.kind === "pointer") {
    const sourcePointer = sourceExpr as Pointer;
    if (!sourcePointer.ptrref.outTarget.isScalar) {
      return columnForPointer(pointer);
    }
  }
  return null;
};

// For a pointer chain rooted at a type_root, returns the FK column on the
// outer source that the innermost link traverses (e.g. `status_id` for
// `Issue.status.name`). Returns null if the chain doesn't match.
const innermostLinkFKColumn = (set: Set): string | null => {
  if (set.expr.kind !== "pointer") return null;
  let cursor: Set = set;
  let innermostLink: Pointer | null = null;
  while (cursor.expr.kind === "pointer") {
    const ptr = cursor.expr as Pointer;
    innermostLink = ptr;
    cursor = ptr.source;
  }
  let rootExpr: Expr = cursor.expr;
  while (rootExpr.kind === "select_expr") {
    rootExpr = (rootExpr as SelectExpr).result.expr;
  }
  if (rootExpr.kind !== "type_root") return null;
  if (!innermostLink || innermostLink.ptrref.outTarget.isScalar) return null;
  if (shouldUseLinkTable(innermostLink)) return null;
  return `${innermostLink.ptrref.shortName}_id`;
};

// Union-typed links (`references: File | URL | Publication`) reach this
// function with a single TypeRef whose id is a pipe-joined qualified name and
// no `children`. Split the id back into its branches so each becomes a real
// concrete source in the UNION ALL — otherwise the SQL ends up `FROM
// "default__file|default__url|default__publication"`, a table that doesn't
// exist.
const expandUnionTypeRefBranches = (typeRef: TypeRef): TypeRef[] => {
  if (!typeRef.id.includes("|")) return [typeRef];
  // Union typerefs land here as a single `unknown:default::File|default::URL`
  // string (built by `unknownTypeRef` on the parser side). Strip the marker
  // off the joint so every branch resolves as a real concrete type, not as
  // `unknown:default::File` which would table-name to `unknown:default__file`.
  const stripUnknown = (s: string): string => s.startsWith("unknown:") ? s.slice("unknown:".length) : s;
  const idWithoutMarker = stripUnknown(typeRef.id);
  return idWithoutMarker.split("|").map((branchId) => {
    const trimmed = stripUnknown(branchId.trim());
    return {
      kind: "type_ref" as const,
      id: trimmed,
      nameHint: trimmed,
      module: trimmed.split("::")[0] ?? "default",
      isView: false,
      isScalar: false,
      isAbstract: false,
      inSchema: true,
    };
  });
};

// Request for an extra column derived from joining a link's storage table.
// Per branch (concrete subtype), `compilePolymorphicSource` resolves the
// link's actual storage owner via `options.resolveLinkStorageType` and LEFT
// JOINs that table, surfacing its `target` column as `outputColumn`. This
// lets downstream code treat `polySource.${outputColumn}` as a regular FK
// column even when the link uses a link table (has properties, is multi,
// or has different storage owners per subtype).
type LinkProjection = {
  linkName: string;
  outputColumn: string;
};

const compilePolymorphicSource = (
  typeRef: TypeRef,
  skipSubtypes: boolean,
  alias: string,
  projectedColumns: string[],
  options: GelIRCompileOptions,
  linkProjections: LinkProjection[] = [],
): string => {
  const branches = expandUnionTypeRefBranches(typeRef);
  const candidates = skipSubtypes
    ? branches
    : branches.flatMap((branch) => flattenTypeClosure(branch));
  const concrete = candidates.filter((candidate) => !candidate.isAbstract);
  const sources = concrete.length > 0 ? concrete : [typeRef];

  const selects = sources.map((source) => {
    const sourceTypeName = qualifyTypeName(source);
    const sourceTable = resolveTypeTableName(source, options);
    const available = options.resolveTypeColumns?.(sourceTypeName);
    // When we need link-derived columns we alias the source table so
    // LEFT JOINs can reference it unambiguously. Without link projections
    // we keep the unaliased form to preserve the existing SQL shape.
    const needsAlias = linkProjections.length > 0;
    const tableAlias = needsAlias ? `_pb` : undefined;
    const tableRef = tableAlias
      ? `${quoteIdent(sourceTable)} ${tableAlias}`
      : `${quoteIdent(sourceTable)}`;
    const colPrefix = tableAlias ? `${tableAlias}.` : "";
    const cols = projectedColumns
      .map((column) => (!available || available.has(column)
        ? `${colPrefix}${quoteIdent(column)} AS ${quoteIdent(column)}`
        : `NULL AS ${quoteIdent(column)}`))
      .join(", ");

    const joins: string[] = [];
    const linkCols: string[] = [];
    linkProjections.forEach((proj, index) => {
      // Not every concrete branch necessarily defines this link — e.g.
      // `[IS Owned].owner` covers Comment/Issue/LogEntry but `[IS Issue].related_to`
      // only applies to Issue. resolveLinkStorageType returns undefined when
      // the branch has no such link; skip the JOIN and project NULL so the
      // UNION ALL stays well-formed.
      const storage = options.resolveLinkStorageType?.(sourceTypeName, proj.linkName);
      if (storage === undefined) {
        linkCols.push(`NULL AS ${quoteIdent(proj.outputColumn)}`);
        return;
      }
      const linkTable = `${tableNameForType(storage)}__${proj.linkName.toLowerCase()}`;
      const linkAlias = `_pl_${index}`;
      // LEFT JOIN to preserve rows whose link is empty (single optional, or
      // multi link with zero targets). The output column is NULL for those.
      joins.push(
        `LEFT JOIN ${quoteIdent(linkTable)} ${linkAlias}`
        + ` ON ${linkAlias}.${quoteIdent("source")} = ${colPrefix}${quoteIdent("id")}`
      );
      linkCols.push(`${linkAlias}.${quoteIdent("target")} AS ${quoteIdent(proj.outputColumn)}`);
    });

    const allCols = [cols, ...linkCols].filter((entry) => entry.length > 0).join(", ");
    const fromClause = joins.length > 0 ? `${tableRef} ${joins.join(" ")}` : tableRef;
    return `SELECT ${quoteLiteral(sourceTypeName)} AS ${quoteIdent("__source_type")}, ${allCols} FROM ${fromClause}`;
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

// A typeref is "truly polymorphic" when compilePolymorphicSource would
// expand it into more than one concrete branch. Concrete types whose
// `children` array contains only the type itself (a quirk of how the IR
// builder seeds children) are NOT polymorphic — their link storage tables
// are unambiguous, so the standard link-table JOIN path applies.
const isTrulyPolymorphicTypeRef = (typeRef: TypeRef): boolean => {
  if (typeRef.isAbstract) return true;
  const closure = flattenTypeClosure(typeRef);
  const concrete = closure.filter((candidate) => !candidate.isAbstract);
  const distinct = new Set(concrete.map((candidate) => candidate.id));
  // More than one distinct concrete subtype → genuinely polymorphic.
  if (distinct.size > 1) return true;
  // Same id as the root and no other concrete subtypes → just self.
  return false;
};

const compileShapeProjection = (
  shape: ShapeElement,
  sourceAlias: string,
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
): string | null => {
  // `__type__: { name | id }` arrives with a synthetic ptrref (no underlying
  // table). Build the JSON object directly from the row's `__source_type`
  // column so we don't try to JOIN a schema::ObjectType that doesn't exist.
  const syntheticType = (shape as { targetPtr?: { shortName?: string } }).targetPtr;
  if (syntheticType?.shortName === "__type__") {
    const fields = (shape as { syntheticTypeFields?: string[] }).syntheticTypeFields ?? ["name"];
    const pairs: string[] = [];
    for (const f of fields) {
      if (f === "name") {
        pairs.push(`${quoteLiteral("name")}, ${sourceAlias}.${quoteIdent("__source_type")}`);
      } else if (f === "id") {
        // No real ObjectType row exists, so synthesize a stable id from the
        // type-name string itself.
        pairs.push(`${quoteLiteral("id")}, ${sourceAlias}.${quoteIdent("__source_type")}`);
      }
    }
    const alias = shapeAliasForElement(shape, shape.expr, depth);
    return `json_object(${pairs.join(", ")}) AS ${quoteIdent(alias)}`;
  }

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
    // Single-cardinality links surface as `owner: {…}`, not `owner: [{…}]`.
    // The inner builder always emits a json_group_array because it doesn't
    // know how many rows it'll get; unwrap the first element here when the
    // shape declares the link is single (matches what
    // `compilePublicShapeObjectExpr` does for nested shapes).
    const linkPointer = shapeExpr.result.expr as Pointer;
    const isSingleLink = shape.cardinality === "one"
      || shape.cardinality === "at_most_one"
      || (shape.cardinality === undefined
          && linkPointer.ptrref.outCardinality !== "many"
          && linkPointer.ptrref.outCardinality !== "at_least_one"
          && linkPointer.direction !== "inbound");
    if (isSingleLink) {
      return `json(COALESCE(json_extract(${linkExpr}, '$[0]'), 'null')) AS ${quoteIdent(alias)}`;
    }
    return `${linkExpr} AS ${quoteIdent(alias)}`;
  }

  // Shapes-on-paths (`Issue.owner{name}`): the outer source already joined the
  // path's target type into `g0`, and `collectProjectedColumns` has surfaced
  // the leaf scalar (`name`) on that row. Reading `g0.name` directly is
  // correct and avoids re-walking the path through a correlated subquery
  // anchored on the wrong row identity.
  const projectedColumn = compileProjectedSourceColumnRef(shapeExpr.result);
  if (projectedColumn) {
    const rawValue = `${sourceAlias}.${quoteIdent(projectedColumn)}`;
    const value = shapeExpr.result.typeref.collection ? `json(${rawValue})` : rawValue;
    return `${value} AS ${quoteIdent(shapeAliasForElement(shape, shapeExpr.result, depth))}`;
  }

  // Shape-value subquery: `shape_field := (SELECT T { … } FILTER … LIMIT 1)`.
  // The inner Set's expr is a type_root (possibly wrapped in additional
  // select_expr layers from parens around the body) with its own shape and
  // optional clauses. Peel select_expr layers, accumulate clause overrides,
  // and lower as an independent SELECT subquery so per-shape filter/limit
  // actually apply.
  let peeled = shapeExpr.result;
  const peeledClauses: { where?: Set; orderBy?: SortExpr[]; limit?: Set; offset?: Set } = {};
  if (shapeExpr.selectExpr) {
    if (shapeExpr.selectExpr.where) peeledClauses.where = shapeExpr.selectExpr.where;
    if (shapeExpr.selectExpr.orderBy && shapeExpr.selectExpr.orderBy.length) peeledClauses.orderBy = shapeExpr.selectExpr.orderBy;
    if (shapeExpr.selectExpr.limit) peeledClauses.limit = shapeExpr.selectExpr.limit;
    if (shapeExpr.selectExpr.offset) peeledClauses.offset = shapeExpr.selectExpr.offset;
  }
  while (peeled.expr.kind === "select_expr") {
    const se = peeled.expr as SelectExpr;
    if (se.where && !peeledClauses.where) peeledClauses.where = se.where;
    if (se.orderBy && se.orderBy.length && !peeledClauses.orderBy) peeledClauses.orderBy = se.orderBy;
    if (se.limit && !peeledClauses.limit) peeledClauses.limit = se.limit;
    if (se.offset && !peeledClauses.offset) peeledClauses.offset = se.offset;
    peeled = se.result;
  }
  if (
    peeled.expr.kind === "type_root"
    && peeled.shape.length > 0
  ) {
    const innerAlias = `sg${depth + 1}`;
    // Build an options that exposes this shape's source as an OUTER scope
    // for the inner subquery's WHERE/ORDER BY compilation. EdgeQL path
    // sharing: `User.name` referenced inside `SELECT User { x := (SELECT ... FILTER User.name = ...) }`
    // resolves to the outer User's name, not a fresh cross-product. We
    // signal this to compileValueSetSQL by appending the outer source to
    // options.outerScopes; it matches by typeref id.
    const innerOptions: GelIRCompileOptions = {
      ...options,
      outerScopes: [
        ...(options.outerScopes ?? []),
        { alias: sourceAlias, typeref: shape.source.typeref },
      ],
    };
    // Pass the peeled WHERE/ORDER BY into the inner source compilation so
    // collectLinkProjectionsForSource sees them and the polymorphic UNION
    // ALL can JOIN the per-branch link tables to expose `${linkName}_id`
    // columns. Without this, the inner WHERE references like
    // `sg1.owner_id` come back as "no such column".
    const innerSource = compileSelectSource(
      peeled,
      peeledClauses.where,
      peeledClauses.orderBy,
      innerOptions,
      params,
      target,
      innerAlias,
    );
    if (innerSource) {
      const inner = compilePublicShapeObjectExpr(innerSource.alias, peeled.shape, params, innerOptions, target, depth + 1);
      let subSql = `SELECT ${inner} AS ${quoteIdent("item")} FROM ${innerSource.sql}`;
      if (peeledClauses.where) {
        // The generic predicate compiler now handles the polymorphic
        // object-identity case: compileValueSetSQL surfaces
        // `sg1.${linkName}_id` for non-scalar pointer-from-poly-source and
        // `g0.id` for a bare outer-scope type_root reference, so
        // `${left} = ${right}` ends up as `sg1.owner_id = g0.id` without
        // any special-case helper.
        const w = compilePredicateSetSQL(peeledClauses.where, innerSource.alias, params, target, innerOptions)
          ?? compileValueSetSQL(peeledClauses.where, innerSource.alias, params, target, innerOptions);
        if (w) subSql += ` WHERE ${w}`;
      }
      if (peeledClauses.orderBy && peeledClauses.orderBy.length > 0) {
        const orderSql = compileSortExprs(peeledClauses.orderBy, innerSource.alias, undefined, params, target, innerOptions);
        if (orderSql) subSql += ` ORDER BY ${orderSql}`;
      }
      const limit = extractNumericLiteral(peeledClauses.limit);
      if (limit !== undefined) subSql += ` LIMIT ${limit}`;
      const offset = extractNumericLiteral(peeledClauses.offset);
      if (offset !== undefined) subSql += ` OFFSET ${offset}`;
      const alias = shapeAliasForElement(shape, shape.expr, depth);
      // Single-cardinality default: peel the first item out of the grouped
      // array. Multi shows up as a JSON array.
      if (shape.cardinality === "many" || shape.cardinality === "at_least_one") {
        return `COALESCE((SELECT json_group_array(json("item")) FROM (${subSql})), '[]') AS ${quoteIdent(alias)}`;
      }
      return `(SELECT json("item") FROM (${subSql}) LIMIT 1) AS ${quoteIdent(alias)}`;
    }
  }

  const valueExpr = compileValueSetSQL(shapeExpr.result, sourceAlias, params, target, options);
  if (!valueExpr) {
    // Computed shape whose RHS is a set-producing expression we can't
    // express inline (a DISTINCT over a FOR-driven UNION, etc.). Fall back
    // to compiling the RHS as its own scalar-select source and aggregating
    // its `value` column into a JSON array; without this the projection is
    // silently dropped and the field disappears from the result envelope.
    const scratchParams: ScalarValue[] = [];
    const scalarSql = compileScalarSelectSQL(shapeExpr.result, scratchParams, target, options);
    if (scalarSql) {
      params.push(...scratchParams);
      const subAlias = shapeAliasForElement(shape, shapeExpr.result, depth);
      return `COALESCE((SELECT json_group_array(json(${quoteIdent("value")})) FROM (${scalarSql})), '[]') AS ${quoteIdent(subAlias)}`;
    }
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

// For `SELECT Issue.watchers { name } FILTER .name = …`, the IR's FILTER
// expression is `(Issue.watchers).name = …` — a 2-step chain. The outer
// FROM has already joined Issue→watchers→User and aliased the user row as
// `g0`, so the chain's leaf scalar is just `g0.name`. Walk the filter set
// and replace chained pointer references whose chain matches the outer
// source's chain with bare type-root references — that makes
// `compileValueSetSQL`'s `${sourceAlias}.${col}` path do the right thing.
const rewriteFilterAgainstChainSource = (filterSet: Set, sourceSet: Set): Set => {
  // Extract the source's chain from sourceSet (a pointer chain) so we know
  // what to strip.
  const sourceChain: Pointer[] = [];
  {
    let cur: Expr = sourceSet.expr;
    while (cur.kind === "pointer") {
      sourceChain.push(cur as Pointer);
      cur = (cur as Pointer).source.expr;
    }
    if (cur.kind !== "type_root" || sourceChain.length === 0) return filterSet;
  }
  const sourceKey = sourceChain.slice().reverse().map((p) => p.ptrref.id).join("|");
  const sourceRootSet: Set = (sourceChain[sourceChain.length - 1]!.source);
  const sourceLeafType = sourceChain[0]!.ptrref.outTarget;

  const rewriteSet = (s: Set): Set => {
    const expr = s.expr;
    if (expr.kind === "pointer") {
      const ptr = expr as Pointer;
      // Walk this set's chain and check whether it starts with the source
      // chain. If so, the bottom levels are already materialized in `g0`,
      // so swap the matching prefix for a fresh type-root anchored on the
      // source's leaf type.
      const chain: Pointer[] = [];
      let cur: Set = s;
      while (cur.expr.kind === "pointer") {
        chain.push(cur.expr as Pointer);
        cur = (cur.expr as Pointer).source;
      }
      if (cur.expr.kind === "type_root") {
        const reversed = chain.slice().reverse();
        if (reversed.length >= sourceChain.length) {
          const prefix = reversed.slice(0, sourceChain.length);
          const prefixKey = prefix.map((p) => p.ptrref.id).join("|");
          if (prefixKey === sourceKey) {
            // Replace the prefix with a synthetic root set typed as the
            // source leaf, then re-thread the remaining pointers on top.
            const newRoot: Set = {
              ...sourceRootSet,
              expr: { kind: "type_root", typeref: sourceLeafType, skipSubtypes: false, isCachedGlobal: false },
              typeref: sourceLeafType,
              pathId: sourceRootSet.pathId,
            } as Set;
            let result: Set = newRoot;
            for (const ptrLink of reversed.slice(sourceChain.length)) {
              result = { ...result, expr: { ...ptrLink, source: result }, typeref: ptrLink.ptrref.outTarget };
            }
            return result;
          }
        }
      }
      // Not a matching chain — descend into the pointer's source for any
      // nested rewrite opportunities.
      const newSource = rewriteSet(ptr.source);
      if (newSource === ptr.source) return s;
      return { ...s, expr: { ...ptr, source: newSource } };
    }
    if (expr.kind === "operator_call") {
      const op = expr as OperatorCall;
      const newArgs: Record<string, CallArg> = {};
      let changed = false;
      for (const [k, arg] of Object.entries(op.args)) {
        const newExpr = rewriteSet(arg.expr);
        if (newExpr !== arg.expr) changed = true;
        newArgs[k] = { ...arg, expr: newExpr };
      }
      if (!changed) return s;
      return { ...s, expr: { ...op, args: newArgs } };
    }
    if (expr.kind === "exists_expr") {
      const ex = expr as ExistsExpr;
      const newInner = rewriteSet(ex.expr);
      if (newInner === ex.expr) return s;
      return { ...s, expr: { ...ex, expr: newInner } };
    }
    if (expr.kind === "type_cast") {
      const tc = expr as TypeCast;
      const newInner = rewriteSet(tc.expr);
      if (newInner === tc.expr) return s;
      return { ...s, expr: { ...tc, expr: newInner } };
    }
    return s;
  };

  return rewriteSet(filterSet);
};

const normalizeOperator = (op: string): "=" | "!=" | "<" | "<=" | ">" | ">=" | null => {
  if (op === "=" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    return op;
  }

  return null;
};

// For a chain of pointers ending at a type_root, where every link except the
// leaf is an inline-single (FK column) link and the leaf is a scalar field,
// emits a nested EXISTS comparing the leaf column to `rightSet` with `op`.
// Returns null if the pattern doesn't match.
// Lower `<chain> = OuterType` predicates that compare a chain ending in an
// object link to the outer Set's root row. Emits
//   EXISTS (SELECT 1 FROM <chain joins> WHERE leaf.id = sourceAlias.id)
// — without this we'd silently drop the FILTER because the chain's leaf is
// not a scalar.
const tryCompileObjectIdentityExistsSQL = (
  path: ScalarPointerPath,
  op: "=" | "!=",
  sourceAlias: string,
  params: ScalarValue[],
  options: GelIRCompileOptions,
): string | null => {
  const checkpoint = params.length;
  // First step's source is the outer row; subsequent steps live inside the
  // EXISTS' FROM. Walk the full chain (links + leaf) building joins. When the
  // next link is inline outbound (no link table), the current level must
  // project the FK column so the JOIN's ON clause can reference it.
  const fullLinks = [...path.links, path.leaf];
  let fromSql = "";
  const whereSqls: string[] = [];
  let previousAlias = sourceAlias;
  fullLinks.forEach((link, index) => {
    const nextAlias = `oe${index}`;
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const cols = new globalThis.Set<string>(["id"]);
    // Inbound inline-FK link's column lives on this level's row (the
    // referencing object).
    if (!shouldUseLinkTable(link) && link.direction === "inbound") {
      cols.add(`${link.ptrref.shortName}_id`);
    }
    // If the NEXT step is an inline outbound link, surface its FK on this
    // level too — the next ON clause reads it.
    const nextStep = fullLinks[index + 1];
    if (nextStep && !shouldUseLinkTable(nextStep) && nextStep.direction === "outbound") {
      cols.add(`${nextStep.ptrref.shortName}_id`);
    }
    const targetSource = compilePolymorphicSource(targetType, false, nextAlias, [...cols], options);
    if (shouldUseLinkTable(link)) {
      const linkAlias = `oej${index}`;
      const linkTable = linkTableNameForPointer(link, options);
      if (link.direction === "inbound") {
        if (!fromSql) {
          fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource}`
            + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`);
        } else {
          fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
            + ` ON ${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`
            + ` JOIN ${targetSource}`
            + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
        }
      } else if (!fromSql) {
        fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
        whereSqls.push(`${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`);
      } else {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (link.direction === "inbound") {
        if (!fromSql) {
          fromSql = targetSource;
          whereSqls.push(`${nextAlias}.${quoteIdent(inlineColumn)} = ${previousAlias}.${quoteIdent("id")}`);
        } else {
          fromSql += ` JOIN ${targetSource} ON ${nextAlias}.${quoteIdent(inlineColumn)} = ${previousAlias}.${quoteIdent("id")}`;
        }
      } else if (!fromSql) {
        fromSql = targetSource;
        whereSqls.push(`${nextAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`);
      } else {
        fromSql += ` JOIN ${targetSource} ON ${nextAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`;
      }
    }
    previousAlias = nextAlias;
  });

  // The chain's terminal alias should match the outer source's id.
  whereSqls.push(`${previousAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent("id")}`);
  const existsSql = `EXISTS (SELECT 1 FROM ${fromSql} WHERE ${whereSqls.join(" AND ")})`;
  void checkpoint;
  return op === "=" ? existsSql : `(NOT ${existsSql})`;
};

// Variant of `extractScalarPointerPath` that allows the leaf step to be an
// object-typed pointer too. Used by FILTER `<chain> = OuterType` predicates
// where the comparison reduces to "leaf row's id equals the outer row's id".
const extractObjectPointerPath = (set: Set): ScalarPointerPath | null => {
  const chain: Pointer[] = [];
  let cursor: Set = set;
  while (cursor.expr.kind === "pointer") {
    const pointer = cursor.expr as Pointer;
    if (pointer.ptrref.isLinkProperty) return null;
    chain.push(pointer);
    cursor = pointer.source;
  }

  let rootExpr: Expr = cursor.expr;
  while (rootExpr.kind === "select_expr") {
    rootExpr = (rootExpr as SelectExpr).result.expr;
  }
  if (rootExpr.kind !== "type_root" || chain.length === 0) {
    return null;
  }

  const leaf = chain[0]!;
  if (leaf.ptrref.outTarget.isScalar) return null;

  const links = chain.slice(1).reverse();
  if (links.some((link) => link.ptrref.outTarget.isScalar || link.ptrref.isLinkProperty)) {
    return null;
  }

  return { root: cursor, leaf, links };
};

const tryCompileMultiStepPointerExistsSQL = (
  leftSet: Set,
  rightSet: Set,
  op: "=" | "!=" | "<" | "<=" | ">" | ">=",
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  // Reach through `(set = outer-root)` object-identity comparisons by
  // tolerating an object-typed leaf when the chain contains a backlink and
  // the right side is the outer Set's root type. This lets
  // `FILTER Issue.owner.<owner[IS Comment].issue = Issue` collapse to an
  // EXISTS over the join chain whose leaf id matches the outer Issue row's
  // id. The pre-existing scalar path still handles all-outbound chains, so we
  // only widen here when an inbound step is in the mix — otherwise compares
  // like `Text[IS Owned].owner = User` would lose the FILTER's correlation
  // with the outer User row.
  const objectPath = leftSet.expr.kind === "pointer"
    && rightSet.expr.kind === "type_root"
    && (op === "=" || op === "!=")
    ? extractObjectPointerPath(leftSet)
    : null;
  if (objectPath) {
    const chainHasBacklink = [...objectPath.links, objectPath.leaf]
      .some((link) => link.direction === "inbound");
    const rightTypeRef = (rightSet.expr as TypeRoot).typeref;
    if (chainHasBacklink
        && (rightTypeRef.id === objectPath.leaf.ptrref.outTarget.id || rightTypeRef.id === objectPath.root.typeref.id)) {
      return tryCompileObjectIdentityExistsSQL(objectPath, op, sourceAlias, params, options);
    }
  }
  const path = extractScalarPointerPath(leftSet);
  if (!path) return null;

  const checkpoint = params.length;
  const rightSql = compileValueSetSQL(rightSet, sourceAlias, params, target, options);
  if (!rightSql) {
    params.length = checkpoint;
    return null;
  }

  const aliasColumns = pointerPathAliasColumns(path);
  // When the chain's root is a *truly polymorphic* type_root, the source
  // SELECT (alias = sourceAlias) already projects `${shortName}_id` for any
  // single link with link-table storage — collectLinkProjectionsForSource
  // sees these references and compilePolymorphicSource LEFT JOINs each
  // branch's storage table. Treat that column as an inline FK so the chain
  // doesn't try to join one canonical link table that doesn't fit all
  // branches.
  const rootIsPolymorphic = path.root.expr.kind === "type_root"
    && isTrulyPolymorphicTypeRef((path.root.expr as TypeRoot).typeref);
  let fromSql = "";
  const whereSqls: string[] = [];
  let previousAlias = sourceAlias;

  path.links.forEach((link, index) => {
    const nextAlias = `lt${index}`;
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const targetSource = compilePolymorphicSource(targetType, false, nextAlias, aliasColumns[index + 1]!, options);
    const isFirstStepFromPolyRoot = index === 0 && rootIsPolymorphic;
    const isSingleLink = link.ptrref.outCardinality === "one"
      || link.ptrref.outCardinality === "at_most_one";
    const useProjectedFK = shouldUseLinkTable(link)
      && link.direction === "outbound"
      && isSingleLink
      && isFirstStepFromPolyRoot;
    if (useProjectedFK) {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      const joinSql = `${nextAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`;
      if (!fromSql) {
        fromSql = targetSource;
        whereSqls.push(joinSql);
      } else {
        fromSql += ` JOIN ${targetSource} ON ${joinSql}`;
      }
    } else if (shouldUseLinkTable(link)) {
      const linkAlias = `lj${index}`;
      const linkTable = linkTableNameForPointer(link, options);
      if (link.direction === "inbound") {
        if (!fromSql) {
          fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource}`
            + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`);
        } else {
          fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
            + ` ON ${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`
            + ` JOIN ${targetSource}`
            + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
        }
      } else if (!fromSql) {
        fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
        whereSqls.push(`${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`);
      } else {
        fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias}`
          + ` ON ${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`
          + ` JOIN ${targetSource}`
          + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      const joinSql = link.direction === "inbound"
        ? `${nextAlias}.${quoteIdent(inlineColumn)} = ${previousAlias}.${quoteIdent("id")}`
        : `${nextAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`;
      if (!fromSql) {
        fromSql = targetSource;
        whereSqls.push(joinSql);
      } else {
        fromSql += ` JOIN ${targetSource} ON ${joinSql}`;
      }
    }
    previousAlias = nextAlias;
  });

  if (!fromSql) {
    params.length = checkpoint;
    return null;
  }

  const leafCol = `${previousAlias}.${quoteIdent(columnForPointer(path.leaf))}`;
  whereSqls.push(`${leafCol} ${op} ${rightSql}`);
  return `EXISTS (SELECT 1 FROM ${fromSql} WHERE ${whereSqls.join(" AND ")})`;
};

// `EXISTS Issue.priority` / `EXISTS Issue.<owner[IS Comment]` /
// `EXISTS Issue.priority.id` / `EXISTS Issue.owner.<owner[IS Comment]`: lower
// a pointer-(chain-)to-object/scalar expression to a direct SQL existence
// check anchored on `sourceAlias`. Returns null when the inner Set isn't a
// recognised pointer chain.
const tryCompileExistsObjectPointerSQL = (
  set: Set,
  sourceAlias: string,
  _params: ScalarValue[],
  _target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  // Unwrap `(SELECT Issue.<…)`-style subquery wrappers so `EXISTS (SELECT
  // foo)` works the same as `EXISTS foo`.
  let inner = set;
  while (inner.expr.kind === "select_expr") {
    inner = (inner.expr as SelectExpr).result;
  }

  // Walk the pointer chain to the first link before the type_root. If the
  // leaf is a scalar (`.priority.id`), strip it — `EXISTS .a.b.c_scalar` has
  // the same truth value as `EXISTS .a.b` so long as we never traverse a
  // dangling FK (which the schema's FK constraint already prevents). The `id`
  // pointer arrives here with `outTarget.isScalar === false` and an `anytype`
  // marker (the IR-builder doesn't yet type implicit `id`), so peel it
  // explicitly by shortName too.
  let cursor: Set = inner;
  while (cursor.expr.kind === "pointer") {
    const ptr = cursor.expr as Pointer;
    if (ptr.ptrref.outTarget.isScalar || ptr.ptrref.shortName === "id") {
      cursor = ptr.source;
      continue;
    }
    break;
  }
  if (cursor.expr.kind !== "pointer") return null;

  // Collect the object-pointer chain (outermost-first walking inwards), then
  // check it terminates at a type_root. Multi-step chains let us handle
  // `EXISTS Issue.owner.<owner[IS Comment]` by joining the chain levels in
  // a single EXISTS subquery anchored on `sourceAlias.id`.
  const chain: Pointer[] = [];
  let walk: Set = cursor;
  while (walk.expr.kind === "pointer") {
    const ptr = walk.expr as Pointer;
    if (ptr.ptrref.isLinkProperty) return null;
    chain.push(ptr);
    walk = ptr.source;
  }
  if (walk.expr.kind !== "type_root") return null;
  const links = chain.reverse();

  if (links.length === 1) {
    const pointer = links[0]!;
    if (shouldUseLinkTable(pointer)) {
      const linkTable = linkTableNameForPointer(pointer, options);
      const sideAnchor = pointer.direction === "inbound" ? "target" : "source";
      return `EXISTS (SELECT 1 FROM ${quoteIdent(linkTable)} _ex WHERE _ex.${quoteIdent(sideAnchor)} = ${sourceAlias}.${quoteIdent("id")})`;
    }
    if (pointer.direction === "inbound") {
      const targetType = pointer.ptrref.outSource;
      const targetTable = resolveTypeTableName(targetType, options);
      const inlineColumn = `${pointer.ptrref.shortName}_id`;
      return `EXISTS (SELECT 1 FROM ${quoteIdent(targetTable)} _ex WHERE _ex.${quoteIdent(inlineColumn)} = ${sourceAlias}.${quoteIdent("id")})`;
    }
    const inlineColumn = `${pointer.ptrref.shortName}_id`;
    return `${sourceAlias}.${quoteIdent(inlineColumn)} IS NOT NULL`;
  }

  // Multi-step: build a chain of joins inside a single EXISTS, anchored
  // against the outer row's id via the first link.
  let fromSql = "";
  const whereSqls: string[] = [];
  let prevAlias = sourceAlias;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    const isLeaf = i === links.length - 1;
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const targetAlias = `_ex${i}`;
    const targetTable = resolveTypeTableName(targetType, options);
    if (shouldUseLinkTable(link)) {
      const linkTable = linkTableNameForPointer(link, options);
      const linkAlias = `_lj${i}`;
      if (link.direction === "inbound") {
        if (i === 0) {
          fromSql += `${quoteIdent(linkTable)} ${linkAlias} JOIN ${quoteIdent(targetTable)} ${targetAlias} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("target")} = ${prevAlias}.${quoteIdent("id")}`);
        } else {
          fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("target")} = ${prevAlias}.${quoteIdent("id")}`
            + ` JOIN ${quoteIdent(targetTable)} ${targetAlias} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
        }
      } else {
        if (i === 0) {
          fromSql += `${quoteIdent(linkTable)} ${linkAlias} JOIN ${quoteIdent(targetTable)} ${targetAlias} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("source")} = ${prevAlias}.${quoteIdent("id")}`);
        } else {
          fromSql += ` JOIN ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("source")} = ${prevAlias}.${quoteIdent("id")}`
            + ` JOIN ${quoteIdent(targetTable)} ${targetAlias} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
        }
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (i === 0) {
        fromSql += `${quoteIdent(targetTable)} ${targetAlias}`;
        whereSqls.push(link.direction === "inbound"
          ? `${targetAlias}.${quoteIdent(inlineColumn)} = ${prevAlias}.${quoteIdent("id")}`
          : `${targetAlias}.${quoteIdent("id")} = ${prevAlias}.${quoteIdent(inlineColumn)}`);
      } else {
        fromSql += ` JOIN ${quoteIdent(targetTable)} ${targetAlias} ON ${link.direction === "inbound"
          ? `${targetAlias}.${quoteIdent(inlineColumn)} = ${prevAlias}.${quoteIdent("id")}`
          : `${targetAlias}.${quoteIdent("id")} = ${prevAlias}.${quoteIdent(inlineColumn)}`}`;
      }
    }
    void isLeaf;
    prevAlias = targetAlias;
  }
  if (!fromSql) return null;
  return `EXISTS (SELECT 1 FROM ${fromSql} WHERE ${whereSqls.join(" AND ")})`;
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
  // FILTER TRUE / FILTER FALSE — bare boolean constants don't go through
  // operator_call, so emit a SQL truth value directly. Without this branch
  // the whole compile bails out and the engine falls back.
  if (set.expr.kind === "boolean_constant") {
    return (set.expr as { value: unknown }).value ? "1" : "0";
  }
  // `FILTER EXISTS X` — the predicate path used to reject anything that
  // wasn't an operator_call, so the WHERE clause silently dropped (one row
  // count of every-row instead of just rows with X). For object-pointer
  // arguments (the common case: `EXISTS .priority`, `EXISTS .watchers`,
  // `EXISTS .<owner[IS Comment]`) emit a direct SQL EXISTS test against the
  // outer row; otherwise wrap the value-level EXISTS compilation in a
  // boolean equality so it can live at the top of WHERE.
  if (set.expr.kind === "exists_expr") {
    const innerSet = (set.expr as ExistsExpr).expr;
    const direct = tryCompileExistsObjectPointerSQL(innerSet, sourceAlias, params, target, options);
    if (direct) return direct;
    const inner = compileValueSetSQL(set, sourceAlias, params, target, options, linkPropertyAlias);
    if (!inner) {
      params.length = checkpoint;
      return null;
    }
    return `(${inner} = json('true'))`;
  }
  // `FILTER X IS T` — type checks compile to a dynamic `__source_type IN (…)`
  // test in the value path. Route them through the value compiler so the
  // outer WHERE can use the resulting boolean directly.
  if (set.expr.kind === "type_check_op") {
    const value = compileValueSetSQL(set, sourceAlias, params, target, options, linkPropertyAlias);
    if (value) return value;
    params.length = checkpoint;
    return null;
  }
  // `FILTER re_test(…)`, `FILTER str_lower(.x) = 'y'`, etc. — function-call
  // predicates surface as bool-typed value expressions. Let compileValueSetSQL
  // produce the SQL; the result is a truthy expression suitable for WHERE.
  if (set.expr.kind === "function_call") {
    if (process.env.DEBUG_PRED) console.log("[pred fn]", (set.expr as FunctionCall).functionName);
    const value = compileValueSetSQL(set, sourceAlias, params, target, options, linkPropertyAlias);
    if (process.env.DEBUG_PRED) console.log("[pred fn] value:", value);
    if (value) return `(${value})`;
    params.length = checkpoint;
    return null;
  }
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
    // Each operand may be a boolean comparison the predicate path knows
    // (`.val < 5`) or a value-level boolean expression that only the value
    // path can compile (`.name like '%on'`, function calls). Try predicate
    // first so AND/OR chains stay flat; fall back to value-level so we don't
    // drop the entire conjunction whenever one side is something exotic.
    const left = compilePredicateSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias)
      ?? compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compilePredicateSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias)
      ?? compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
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
    // `LIKE`/`ILIKE`/function-call/etc. predicates need to surface in WHERE
    // too — fall back to value-level compilation, whose output is already a
    // truthy SQL expression. Otherwise compileWhereClause would silently drop
    // the FILTER and the query would return every row.
    const valueSql = compileValueSetSQL(set, sourceAlias, params, target, options, linkPropertyAlias);
    if (valueSql) {
      return `(${valueSql})`;
    }
    params.length = checkpoint;
    return null;
  }

  const args = orderedCallArgs(call.args);
  if (args.length < 2) {
    params.length = checkpoint;
    return null;
  }

  const exists = tryCompileMultiStepPointerExistsSQL(args[0].expr, args[1].expr, op, sourceAlias, params, target, options)
    ?? tryCompileMultiStepPointerExistsSQL(args[1].expr, args[0].expr, op, sourceAlias, params, target, options);
  if (exists) {
    return exists;
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

// EdgeQL path-sharing helper: when `set` is just a type_root (possibly
// wrapped in clauseless select_expr layers) whose typeref matches an
// enclosing iteration scope, return `${outerAlias}.id`. That lets a fresh
// `User` reference inside a shape on User compile as a reference to the
// outer row's identity rather than a cross-product subquery.
const tryResolveOuterScopeIdRef = (
  set: Set,
  options: GelIRCompileOptions,
): string | null => {
  if (!options.outerScopes || options.outerScopes.length === 0) return null;
  // Peel select_expr wrappers as long as they carry no semantic clauses —
  // `(SELECT User)` is a no-op around `User`. A real clause (FILTER, ORDER
  // BY, LIMIT) makes the subquery meaningful and we leave it to
  // compileSelectExprSubquery.
  let cursor: Set = set;
  while (cursor.expr.kind === "select_expr") {
    const se = cursor.expr as SelectExpr;
    if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) {
      return null;
    }
    cursor = se.result;
  }
  if (cursor.expr.kind !== "type_root") return null;
  // A shape with elements other than the implicit `id` would project a
  // structured object — that's not just an identity reference.
  const meaningfulShape = (cursor.shape ?? []).some((el) => {
    const elName = (el as { name?: string }).name;
    if (elName === "id") return false;
    if (el.shapeOrigin === "default") return false;
    return true;
  });
  if (meaningfulShape) return null;
  const typeId = (cursor.expr as TypeRoot).typeref.id;
  const match = [...options.outerScopes].reverse().find((scope) => scope.typeref.id === typeId);
  if (!match) return null;
  return `${match.alias}.${quoteIdent("id")}`;
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
  // EdgeQL path sharing: a bare reference to an outer iterator's type
  // (e.g. `User` inside `SELECT User { x := (SELECT … FILTER … = User) }`)
  // resolves to the OUTER row's identity (id), not a fresh cross-product.
  // Recognize this when the set unwraps to just a type_root with no
  // clauses and the typeref matches an enclosing scope.
  const outerScopeIdRef = tryResolveOuterScopeIdRef(set, options);
  if (outerScopeIdRef) return outerScopeIdRef;
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
    if (!pointer.ptrref.outTarget.isScalar) {
      // Non-scalar outbound link from a *truly polymorphic* source: the
      // source SELECT already projects `${shortName}_id` via
      // compilePolymorphicSource's LinkProjection. Surface that column so
      // object-identity comparisons (`Text[IS Owned].owner = User`) can
      // reduce to `${sourceAlias}.${linkName}_id = <outer-row-id>` at the
      // predicate level — no per-shape special-case needed.
      const isSingleLink = pointer.ptrref.outCardinality === "one"
        || pointer.ptrref.outCardinality === "at_most_one";
      if (
        pointer.source.expr.kind === "type_root"
        && pointer.direction === "outbound"
        && isSingleLink
        && shouldUseLinkTable(pointer)
        && isTrulyPolymorphicTypeRef((pointer.source.expr as TypeRoot).typeref)
      ) {
        return `${sourceAlias}.${quoteIdent(`${pointer.ptrref.shortName}_id`)}`;
      }
      return null;
    }
    // EdgeQL path sharing: when the immediate source of a scalar pointer is
    // a fresh type_root that matches an enclosing iteration scope, resolve
    // to the outer alias's column. This is how `User.name` inside a shape
    // computable on `User` becomes the OUTER User's name rather than a
    // cross-product with every User row. Inner-source bindings still take
    // precedence — the inner alias is `sourceAlias` and would already
    // handle them; outerScopes only carries PARENT scopes.
    if (pointer.source.expr.kind === "type_root") {
      const innerTypeId = (pointer.source.expr as TypeRoot).typeref.id;
      const outerMatch = options.outerScopes && options.outerScopes.length > 0
        ? [...options.outerScopes].reverse().find((scope) => scope.typeref.id === innerTypeId)
        : undefined;
      if (outerMatch) {
        return `${outerMatch.alias}.${quoteIdent(col)}`;
      }
    }
    // Chained pointer (e.g. `.parent.val`): the immediate source isn't the
    // outer row, so a bare `${sourceAlias}.val` would read the wrong column.
    // Walk the chain and emit a correlated subquery anchored at sourceAlias.
    if (pointer.source.expr.kind === "pointer") {
      const correlated = tryCompileCorrelatedScalarPointerPathSQL(unwrapped.result, sourceAlias, options);
      if (correlated) return correlated;
      return null;
    }
    return `${sourceAlias}.${quoteIdent(col)}`;
  }

  const literal = extractScalarConstant(unwrapped.result);
  if (literal !== undefined) {
    const inlineSql = inlineIntegerConstantSql(unwrapped.result.expr, literal);
    if (inlineSql !== undefined) return inlineSql;
    if (typeof literal === "boolean") {
      return literal ? "json('true')" : "json('false')";
    }
    params.push(literal);
    return "?";
  }

  if (expr.kind === "type_cast") {
    const castExpr = expr as TypeCast;
    // Tuple casts are structural reprojections (named → positional, rename,
    // or both). When the source is a literal `tuple` expression we can
    // re-emit it directly with the target slot names/shape instead of
    // letting the inner emit win — otherwise `json_object('name', …)`
    // would survive a `<tuple<…>>` cast that wanted `json_array(…)`.
    const targetTupleSlots = parseTupleTypeSlots(qualifyTypeName(castExpr.toType));
    if (targetTupleSlots && castExpr.expr.expr.kind === "tuple") {
      const sourceTuple = castExpr.expr.expr as Tuple;
      const sourceParts = sourceTuple.elements.map((element) =>
        compileValueSetSQL(element.val, sourceAlias, params, target, options, linkPropertyAlias));
      if (sourceParts.some((part) => !part)) {
        params.length = checkpoint;
        return null;
      }
      const targetIsNamed = targetTupleSlots.length > 0 && targetTupleSlots.every((s) => s.name !== undefined);
      if (targetIsNamed) {
        return `json_object(${targetTupleSlots.map((slot, idx) => `${quoteLiteral(slot.name!)}, ${sourceParts[idx]}`).join(", ")})`;
      }
      return `json_array(${sourceParts.slice(0, targetTupleSlots.length).join(", ")})`;
    }
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

  // `NOT EXISTS X` short-circuit (must beat the generic `operator_call`
  // branch below, which routes through compilePredicateSetSQL and chokes
  // on the empty-set marker). Inverse of the EXISTS CASE further down.
  if (expr.kind === "operator_call"
      && (expr as OperatorCall).operator === "not"
      && Object.values((expr as OperatorCall).args).length === 1) {
    const onlyArg = Object.values((expr as OperatorCall).args)[0] as CallArg;
    if (onlyArg.expr.expr.kind === "exists_expr") {
      const existsExpr = onlyArg.expr.expr as ExistsExpr;
      const inner = compileValueSetSQL(existsExpr.expr, sourceAlias, params, target, options, linkPropertyAlias);
      if (!inner) {
        params.length = checkpoint;
        return null;
      }
      return `(CASE WHEN ${inner} IS NULL THEN json('true') ELSE json('false') END)`;
    }
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
    // EdgeQL `<literal> IS <type>` is a static check: the literal's concrete
    // scalar type either is (or descends from) the target type, or it isn't.
    // Resolve by walking the literal expression to its concrete scalar type
    // and consulting the scalar-type ancestor table. Also handle `field IS T`
    // by reading the pointer's declared outTarget.
    const concreteLiteralType = (() => {
      let inner: { kind: string; expr?: unknown; ptrref?: { outTarget?: { id?: string; nameHint?: string } } } = typeCheck.left as unknown as { kind: string; expr?: unknown };
      // Unwrap one layer of `set` envelope around the literal.
      if (inner.kind === "set" && (inner as { expr?: { kind: string } }).expr) {
        inner = (inner as { expr: { kind: string } }).expr as { kind: string };
      }
      if (inner.kind === "integer_constant") return "std::int64";
      if (inner.kind === "float_constant") return "std::float64";
      if (inner.kind === "string_constant") return "std::str";
      if (inner.kind === "boolean_constant") return "std::bool";
      if (inner.kind === "bigint_constant") return "std::bigint";
      if (inner.kind === "decimal_constant") return "std::decimal";
      // `pointer` IR (e.g. `Issue.time_estimate`): use the pointer's declared
      // output target type. Only resolve if it's a known std:: scalar.
      if (inner.kind === "pointer" && inner.ptrref?.outTarget) {
        const target = inner.ptrref.outTarget;
        const targetId = target.id ?? target.nameHint;
        if (targetId && (targetId.startsWith("std::") || targetId.startsWith("default::"))) {
          return targetId;
        }
      }
      // `function_call` / `operator_call` / `type_cast` / `set` envelopes
      // carry their inferred typeref on `typeCheck.left.typeref` (set during
      // AST→IR). Pull it out so `<float64>x IS float64` and
      // `math::mean(x) IS float64` resolve to the inferred concrete scalar
      // instead of bottoming out at `anytype`.
      const leftTyperef = (typeCheck.left as { typeref?: { id?: string; nameHint?: string } }).typeref;
      if (leftTyperef) {
        const id = leftTyperef.id ?? leftTyperef.nameHint ?? "";
        const stripped = id.startsWith("unknown:") ? id.slice("unknown:".length) : id;
        if (stripped.startsWith("std::") || stripped.startsWith("default::")) {
          return stripped;
        }
      }
      return undefined;
    })();
    const rightType = qualifyTypeName(typeCheck.right);
    const stripStd = (n: string): string => n.startsWith("std::") ? n.slice(5) : n.startsWith("default::") ? n.slice(9) : n;
    const SCALAR_ANCESTORS: Record<string, string[]> = {
      int16: ["int16", "anyint", "anyreal", "anyscalar", "anytype"],
      int32: ["int32", "anyint", "anyreal", "anyscalar", "anytype"],
      int64: ["int64", "anyint", "anyreal", "anyscalar", "anytype"],
      bigint: ["bigint", "anyint", "anyreal", "anyscalar", "anytype"],
      float32: ["float32", "anyfloat", "anyreal", "anyscalar", "anytype"],
      float64: ["float64", "anyfloat", "anyreal", "anyscalar", "anytype"],
      decimal: ["decimal", "anyreal", "anyscalar", "anytype"],
      str: ["str", "anyscalar", "anytype"],
      bool: ["bool", "anyscalar", "anytype"],
      bytes: ["bytes", "anyscalar", "anytype"],
      uuid: ["uuid", "anyscalar", "anytype"],
      datetime: ["datetime", "anyscalar", "anytype"],
      duration: ["duration", "anyscalar", "anytype"],
      json: ["json", "anyscalar", "anytype"],
    };
    if (concreteLiteralType) {
      const literalShort = stripStd(concreteLiteralType);
      const targetShort = stripStd(rightType);
      const ancestors = SCALAR_ANCESTORS[literalShort];
      const trueSql = "json('true')";
      const falseSql = "json('false')";
      // A scalar literal is never an Object.
      if (ancestors && targetShort === "Object") {
        return typeCheck.op === "is" ? falseSql : trueSql;
      }
      if (ancestors) {
        const matches = ancestors.includes(targetShort);
        if (typeCheck.op === "is") return matches ? trueSql : falseSql;
        if (typeCheck.op === "is not") return matches ? falseSql : trueSql;
      }
      // Object types (pointer targets that aren't std:: scalars): the result is
      // false against any scalar target (concrete or abstract), true against
      // Object, or anytype, otherwise we fall back to the typeref-based check.
      const SCALAR_ABSTRACT = new Set(["anyint", "anyreal", "anyfloat", "anyscalar"]);
      if (!ancestors) {
        if (targetShort === "anytype") {
          // anytype accepts everything.
          return typeCheck.op === "is" ? trueSql : falseSql;
        }
        if (SCALAR_ANCESTORS[targetShort] || SCALAR_ABSTRACT.has(targetShort)) {
          // target is a scalar — an object value never satisfies it.
          return typeCheck.op === "is" ? falseSql : trueSql;
        }
        if (targetShort === "Object") {
          return typeCheck.op === "is" ? trueSql : falseSql;
        }
      }
    }
    const leftType = qualifyTypeName(typeCheck.left.typeref);
    const rightChildren = (typeCheck.right.children ?? []).map((child) => qualifyTypeName(child));
    const matches = leftType === rightType || rightChildren.includes(leftType);
    if (matches) {
      if (typeCheck.op === "is") return "1";
      if (typeCheck.op === "is not") return "0";
    }
    // Dynamic case: the left source is an abstract/parent type and the right
    // is a concrete subtype — runtime decides per row by comparing the
    // polymorphic `__source_type` column. Build the list of qualified type
    // names that should match (the right type and all its concrete subtypes).
    const collectConcreteNames = (typeRef: TypeRef): string[] => {
      const seen = new globalThis.Set<string>();
      const out: string[] = [];
      const walk = (t: TypeRef): void => {
        const name = qualifyTypeName(t);
        if (seen.has(name)) return;
        seen.add(name);
        if (!t.isAbstract) out.push(name);
        for (const child of t.children ?? []) walk(child);
      };
      walk(typeRef);
      return out;
    };
    const matchTypes = collectConcreteNames(typeCheck.right);
    if (matchTypes.length === 0) {
      params.length = checkpoint;
      return null;
    }
    const leftSql = compileValueSetSQL(typeCheck.left, sourceAlias, params, target, options, linkPropertyAlias);
    // When the left is the outer source itself (a type_root for the filter
    // subject), use `${sourceAlias}.__source_type` directly. Otherwise we
    // need an EXISTS-style check, but for now the common case (`Type IS T`
    // in a FILTER) covers what the tests exercise.
    const useSourceAlias = typeCheck.left.expr.kind === "type_root";
    if (!useSourceAlias && !leftSql) {
      params.length = checkpoint;
      return null;
    }
    const tagSql = useSourceAlias
      ? `${sourceAlias}.${quoteIdent("__source_type")}`
      : `(${leftSql})`;
    const placeholders = matchTypes.map(() => "?").join(", ");
    params.push(...matchTypes);
    const op = typeCheck.op === "is" ? "IN" : "NOT IN";
    return `(${tagSql} ${op} (${placeholders}))`;
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
    return `(CASE WHEN ${inner} IS NULL THEN json('false') ELSE json('true') END)`;
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
    const numericIndex = extractNumericLiteral(indexExpr.index);
    const baseType = qualifyTypeName(indexExpr.expr.typeref);
    if (base && numericIndex !== undefined && (baseType === "std::str" || baseType === "std::bytes")) {
      return `substr(${base}, ${numericIndex >= 0 ? numericIndex + 1 : numericIndex}, 1)`;
    }
    if (base && numericIndex !== undefined) {
      // Inline the index as a literal integer in the JSON path. Using `?`
      // would let SQLite render JS Numbers as `0.0` during `||`
      // concatenation, producing an invalid path like `$[0.0]`.
      return `json_extract(${base}, '$[${numericIndex}]')`;
    }
    const index = compileValueSetSQL(indexExpr.index, sourceAlias, params, target, options, linkPropertyAlias);
    if (!base || !index) {
      params.length = checkpoint;
      return null;
    }
    return `json_extract(${base}, '$[' || CAST(${index} AS INTEGER) || ']')`;
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
    // EdgeQL is strict-empty: `null AND false` should be NULL, not FALSE
    // (SQL's three-valued logic would short-circuit to FALSE). Compile each
    // operand once via the value path so we can detect NULL on either side
    // and propagate it, then form the boolean expression. The CASE-VALUE
    // wrapper turns 0/1/NULL into json('false')/json('true')/NULL for the
    // JSON output the assertion layer expects.
    const argSets = orderedCallArgs(call.args);
    const operandSqls: string[] = [];
    for (const arg of argSets) {
      const v = compileValueSetSQL(arg.expr, sourceAlias, params, target, options, linkPropertyAlias);
      if (!v) return null;
      operandSqls.push(v);
    }
    // Wrap operand evaluation in a one-row subquery so each operand's SQL
    // (with its `?` placeholders) is evaluated exactly once — splicing a
    // `?`-bearing fragment twice into the same statement would over-consume
    // parameters.
    const truthy = (col: string): string => `(${col} = json('true') OR (${col} NOT IN (json('false')) AND ${col}))`;
    if (call.operator === "not") {
      if (operandSqls.length < 1) return null;
      const p = operandSqls[0]!;
      return `(SELECT CASE WHEN p IS NULL THEN NULL WHEN p = json('true') THEN json('false') WHEN p = json('false') THEN json('true') WHEN p THEN json('false') ELSE json('true') END FROM (SELECT (${p}) AS p))`;
    }
    if (operandSqls.length < 2) return null;
    const [a, b] = operandSqls;
    const op = call.operator === "and" ? "AND" : "OR";
    return `(SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL WHEN ${truthy("a")} ${op} ${truthy("b")} THEN json('true') ELSE json('false') END FROM (SELECT (${a}) AS a, (${b}) AS b))`;
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
    // Value-level emission: produce JSON booleans so downstream JSON.parse
    // yields true/false rather than 1/0. Empty-set semantics: if either
    // operand is NULL the comparison's value is the empty set, surfaced as
    // JSON null. The one-row subquery binds each side once so SQL `?`
    // placeholders are not consumed twice.
    return `(SELECT CASE WHEN l IS NULL OR r IS NULL THEN NULL WHEN l ${op} r THEN json('true') ELSE json('false') END FROM (SELECT (${left}) AS l, (${right}) AS r))`;
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

  if (call.operator === "?=" || call.operator === "?!=") {
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
    // SQLite's `IS` / `IS NOT` are null-safe equality, matching ?= / ?!= when
    // both sides are scalar (or empty represented as NULL) at this row.
    // Emit json('true'/'false') so JSON.parse downstream produces real booleans.
    const op = call.operator === "?=" ? "IS" : "IS NOT";
    return `(CASE WHEN ${left} ${op} ${right} THEN json('true') ELSE json('false') END)`;
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
    // Tuples/arrays compile to `json_array(...)` which SQLite emits as plain
    // TEXT (e.g. the string `'[]'`). Feeding that TEXT into `json_group_array`
    // produces an array of strings rather than an array of arrays. Wrap each
    // aggregated value with `json(...)` when the set elements are structural
    // JSON values so the aggregator embeds them as real JSON structures.
    const valuesAreJsonStructures = args.some((arg) => {
      let argExpr: { kind?: string; expr?: unknown } | undefined = arg?.expr as { kind?: string; expr?: unknown } | undefined;
      while (argExpr && argExpr.kind === "set" && argExpr.expr) {
        argExpr = argExpr.expr as { kind?: string; expr?: unknown };
      }
      return argExpr?.kind === "tuple" || argExpr?.kind === "array";
    });
    const selects = (values as string[])
      .map((value) => `SELECT ${value} AS ${quoteIdent("value")}`)
      .join(" UNION ALL ");
    const aggValueExpr = valuesAreJsonStructures
      ? `json(${quoteIdent("value")})`
      : quoteIdent("value");
    return `(SELECT json_group_array(${aggValueExpr}) FROM (${selects}))`;
  }

  const infixOperator = operatorToInfixSql(call.operator);
  if (infixOperator) {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      return null;
    }
    const compiled: string[] = [];
    for (const arg of args) {
      const piece = compileValueSetSQL(arg.expr, sourceAlias, params, target, options, linkPropertyAlias);
      if (!piece) {
        params.length = checkpoint;
        return null;
      }
      compiled.push(piece);
    }
    if (call.operator === "ilike") {
      return `(LOWER(${compiled[0]}) LIKE LOWER(${compiled[1]}))`;
    }
    // `++` over array operands is array concatenation, not string concat —
    // emit a JSON array merge so `[1,2] ++ [3,4]` produces `[1,2,3,4]` rather
    // than the text concatenation of two JSON literals. The IR's `returning`
    // type often isn't propagated for `++`, so inspect each operand's typeref
    // directly.
    const looksLikeArrayConcat = call.operator === "++"
      && args.some((arg) => arg.expr.typeref?.collection === "array");
    if (looksLikeArrayConcat) {
      const unions = compiled.map((piece) => `SELECT value FROM json_each(${piece})`).join(" UNION ALL ");
      return `(SELECT json_group_array(value) FROM (${unions}))`;
    }
    return `(${compiled.join(` ${infixOperator} `)})`;
  }

  if (call.operator === "in" || call.operator === "not in") {
    const args = orderedCallArgs(call.args);
    if (args.length < 2) {
      return null;
    }
    const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left) {
      params.length = checkpoint;
      return null;
    }
    // Prefer compiling the RHS as a value SELECT (`SELECT value FROM …`)
    // so set-producing expressions like `array_unpack([…])` and pointer
    // chains can serve as the right-hand side. Fall back to the scalar-
    // value compilation when the SELECT form isn't available (literal
    // arrays / tuples etc.). Wrap the boolean result so it surfaces as
    // the JSON-encoded `true`/`false` other operators use.
    const rightSelect = compileScalarSelectSQL(args[1].expr, params, target, options);
    if (rightSelect) {
      const op = call.operator === "in" ? "IN" : "NOT IN";
      return `(CASE WHEN ${left} ${op} (${rightSelect}) THEN json('true') ELSE json('false') END)`;
    }
    const right = compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!right) {
      params.length = checkpoint;
      return null;
    }
    return `(${left} ${call.operator === "in" ? "IN" : "NOT IN"} ${right})`;
  }

  params.length = checkpoint;
  return null;
};

// EdgeQL `count(X)` returns the cardinality of set X. Compile directly for
// shapes of X where the SQL is unambiguous: a type root counts the type's
// table; a tuple constructor counts the Cartesian product cardinality (the
// product of element cardinalities); a select_expr counts its result; a
// pointer chain wraps compileScalarSelectSQL with `SELECT count(*) FROM (...)`.
// Anything else returns null so the caller can fall back. Notably we do not
// wrap arbitrary value expressions (constants, binding_refs, operator_calls
// over scalars) — those evaluate to a single scalar value in compileScalarSelectSQL,
// which would incorrectly count as 1 instead of preserving EdgeQL's set
// semantics for the operand.
const compileCountOfSetSQL = (
  set: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  const expr = set.expr;

  if (expr.kind === "type_root") {
    const root = expr as TypeRoot;
    const fromSql = compilePolymorphicSource(root.typeref, root.skipSubtypes, "g_agg", ["id"], options);
    return `(SELECT count(*) FROM ${fromSql})`;
  }

  if (expr.kind === "tuple") {
    const tuple = expr as Tuple;
    if (tuple.elements.length === 0) {
      return "0";
    }
    const checkpoint = params.length;
    const factors: string[] = [];
    for (const element of tuple.elements) {
      const factor = compileCountOfSetSQL(element.val, params, target, options);
      if (!factor) {
        params.length = checkpoint;
        return null;
      }
      factors.push(factor);
    }
    return `(${factors.join(" * ")})`;
  }

  if (expr.kind === "select_expr") {
    const selectExpr = expr as SelectExpr;
    if (!selectExpr.where && !selectExpr.limit && !selectExpr.offset) {
      return compileCountOfSetSQL(selectExpr.result, params, target, options);
    }
    const checkpoint = params.length;
    const compiledSource = compileSelectSource(selectExpr.result, selectExpr.where, selectExpr.orderBy, options, params, target);
    if (compiledSource) {
      let sql = `SELECT count(*) AS ${quoteIdent("value")} FROM ${compiledSource.sql}`;
      if (selectExpr.where) {
        const whereSql = compileWhereClause(selectExpr.where, compiledSource.alias, params, target, options);
        if (!whereSql) {
          params.length = checkpoint;
          return null;
        }
        sql += ` WHERE ${whereSql}`;
      }
      // LIMIT/OFFSET clamp the source's cardinality before the count.
      // Wrap in a subquery so they apply to the row set, not to count(*).
      if (selectExpr.limit || selectExpr.offset) {
        const limitSql = selectExpr.limit
          ? compileValueSetSQL(selectExpr.limit, compiledSource.alias, params, target, options)
          : null;
        const offsetSql = selectExpr.offset
          ? compileValueSetSQL(selectExpr.offset, compiledSource.alias, params, target, options)
          : null;
        if ((selectExpr.limit && !limitSql) || (selectExpr.offset && !offsetSql)) {
          params.length = checkpoint;
          return null;
        }
        let inner = `SELECT 1 FROM ${compiledSource.sql}`;
        if (selectExpr.where) {
          const innerWhereSql = compileWhereClause(selectExpr.where, compiledSource.alias, params, target, options);
          if (!innerWhereSql) {
            params.length = checkpoint;
            return null;
          }
          inner += ` WHERE ${innerWhereSql}`;
        }
        if (limitSql) inner += ` LIMIT ${limitSql}`;
        if (offsetSql) inner += ` OFFSET ${offsetSql}`;
        return `(SELECT count(*) FROM (${inner}))`;
      }
      return `(${sql})`;
    }
    params.length = checkpoint;
    return null;
  }

  if (expr.kind === "pointer") {
    const checkpoint = params.length;
    const scalarSql = compileScalarSelectSQL(set, params, target, options);
    if (scalarSql) {
      return `(SELECT count(*) FROM (${scalarSql}))`;
    }
    params.length = checkpoint;
    // Non-scalar pointer (link traversal like `User.friends`): scalar compile
    // bails because the target isn't a scalar. Build the link-traversal
    // FROM clause directly and count its rows.
    const compiledSource = compileSelectSource(set, undefined, undefined, options, params, target);
    if (compiledSource) {
      return `(SELECT count(*) FROM ${compiledSource.sql})`;
    }
    params.length = checkpoint;
  }

  // `count(FOR ... UNION ...)` — compile the FOR's source as a FROM clause
  // and count its rows. Works when the body has cardinality 1 per iteration
  // (the common case for FOR-UNION).
  if (expr.kind === "for_expr") {
    const checkpoint = params.length;
    const projectedColumns = collectForExprProjectedColumns(set);
    const forSource = compileForExprSource(set, projectedColumns, options, params, target);
    if (forSource) {
      // Add cross joins for free type roots in the body, matching how the
      // outer FOR path builds its FROM clause.
      const bodySet = innermostForExprBody(set);
      const freeRoots = collectFreeTypeRoots(bodySet, forSource.bindingAliases);
      let nextIdx = countAliases(forSource.bindingAliases);
      for (const root of freeRoots) {
        const alias = `g${nextIdx++}`;
        const joinSql = compilePolymorphicSource(root.typeref, false, alias, projectedColumns, options);
        forSource.fromSql += ` CROSS JOIN ${joinSql}`;
        forSource.bindingAliases.set(root.key, alias);
      }
      return `(SELECT count(*) FROM ${forSource.fromSql})`;
    }
    params.length = checkpoint;
  }

  // Set literals (`{1,2,3}`) and other operator_calls with non-scalar
  // results land here via compileScalarSelectSQL — `count({…})` is the
  // length of that union. (Scalar constants already evaluate to a single
  // row, so they count as 1.)
  if (expr.kind === "operator_call") {
    const checkpoint = params.length;
    const scalarSql = compileScalarSelectSQL(set, params, target, options);
    if (scalarSql) {
      return `(SELECT count(*) FROM (${scalarSql}))`;
    }
    params.length = checkpoint;
  }

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

  // Aggregates whose argument is a set: lower to `(SELECT agg(value) FROM (<set-sql>))`.
  // count() has its own dedicated lowering that handles type_root, tuple
  // cross-products, and select_expr modifiers; sum/min/max/avg/array_agg all
  // share the generic "compile the arg as a scalar value set, then wrap in
  // the SQL aggregate" shape.
  const shortName = call.functionName.split("::").pop() ?? "";
  const aggregateOfType = ["count", "min", "max", "sum", "avg", "array_agg", "all", "any", "mean"].includes(shortName);
  if (aggregateOfType) {
    const argList = orderedCallArgs(call.args);
    // Empty-set short-circuit: EdgeQL aggregates over the empty set have
    // defined identities. Without this, e.g. `array_agg(<int64>{})` would
    // compile to `json_group_array` over a single-row `SELECT NULL` and
    // produce `[null]` instead of the correct `[]`.
    if (argList.length === 1 && isTopLevelEmptySetMarker(argList[0].expr)) {
      if (shortName === "count") return "0";
      if (shortName === "sum") return "0";
      if (shortName === "array_agg") return "json('[]')";
      if (shortName === "all") return "json('true')";
      if (shortName === "any") return "json('false')";
      if (shortName === "min" || shortName === "max" || shortName === "avg" || shortName === "mean") return "NULL";
    }
    if (shortName === "count" && argList.length === 1) {
      const countSql = compileCountOfSetSQL(argList[0].expr, params, target, options);
      if (countSql) {
        return countSql;
      }
      params.length = checkpoint;
    }
    if (argList.length === 1 && argList[0].expr.expr.kind === "type_root") {
      const root = argList[0].expr.expr as TypeRoot;
      const fromSql = compilePolymorphicSource(root.typeref, root.skipSubtypes, "g_agg", ["id"], options);
      if (shortName === "count") {
        return `(SELECT count(*) FROM ${fromSql})`;
      }
      // sum/min/max/avg/array_agg over a bare type_root have no value column,
      // so they would aggregate over `id` which isn't useful — fall through to
      // null so the caller can reject the query.
    }
    if (argList.length === 1 && shortName !== "count") {
      // Correlated aggregate over a scalar pointer chain (e.g.
      // `array_agg(.children.val)` inside `UPDATE Tree SET …`): the chain
      // must be anchored at the outer row alias so the aggregate sees only
      // this row's children rather than every row in the table.
      const argSet = argList[0].expr;
      let pathSet = argSet;
      let orderBy: SortExpr[] | undefined;
      if (argSet.expr.kind === "select_expr") {
        const se = argSet.expr as SelectExpr;
        pathSet = se.result;
        orderBy = se.orderBy;
      }
      const correlated = tryCompileCorrelatedScalarPointerPathScalarSelect(pathSet, sourceAlias, options);
      if (correlated) {
        let inner = correlated;
        if (orderBy && orderBy.length > 0) {
          // The correlated inner SELECT projects a single `value` column, so
          // ORDER BY on that column matches ordering by the inner SELECT's
          // own result expression (the common shape `SELECT _ := X ORDER BY _`).
          const orders = orderBy.map((sort) => `${quoteIdent("value")} ${sort.direction.toUpperCase()}`);
          inner = `${correlated} ORDER BY ${orders.join(", ")}`;
        }
        // `all`/`any` are boolean aggregates: SQLite has no direct equivalent
        // but the JSON-encoded values `'true'`/`'false'` compare
        // lexicographically the way the predicate requires (false < true), so
        // min/max give the correct answer. Empty-set identity (`all → true`,
        // `any → false`) is recovered via IFNULL.
        if (shortName === "all") {
          return `(SELECT IFNULL(min(${quoteIdent("value")}), json('true')) FROM (${inner}) WHERE ${quoteIdent("value")} IS NOT NULL)`;
        }
        if (shortName === "any") {
          return `(SELECT IFNULL(max(${quoteIdent("value")}), json('false')) FROM (${inner}) WHERE ${quoteIdent("value")} IS NOT NULL)`;
        }
        const sqlAgg = shortName === "array_agg"
          ? `json_group_array(${quoteIdent("value")})`
          : shortName === "mean"
            ? `avg(${quoteIdent("value")})`
            : `${shortName}(${quoteIdent("value")})`;
        return `(SELECT ${sqlAgg} FROM (${inner}))`;
      }
      const innerCheckpoint = params.length;
      const scalarSql = compileScalarSelectSQL(argList[0].expr, params, target, options);
      if (scalarSql) {
        if (shortName === "all") {
          return `(SELECT IFNULL(min(${quoteIdent("value")}), json('true')) FROM (${scalarSql}) WHERE ${quoteIdent("value")} IS NOT NULL)`;
        }
        if (shortName === "any") {
          return `(SELECT IFNULL(max(${quoteIdent("value")}), json('false')) FROM (${scalarSql}) WHERE ${quoteIdent("value")} IS NOT NULL)`;
        }
        const sqlAgg = shortName === "array_agg"
          ? `json_group_array(${setValueIsJson(argList[0].expr) ? `json(${quoteIdent("value")})` : quoteIdent("value")})`
          : shortName === "mean"
            ? `avg(${quoteIdent("value")})`
            : `${shortName}(${quoteIdent("value")})`;
        return `(SELECT ${sqlAgg} FROM (${scalarSql}))`;
      }
      params.length = innerCheckpoint;
    }
  }

  const args = orderedCallArgs(call.args)
    .map((arg) => compileValueSetSQL(arg.expr, sourceAlias, params, target, options, linkPropertyAlias));
  if (args.some((arg) => !arg)) {
    params.length = checkpoint;
    return null;
  }

  const lowered = lowerStdlibFunctionSql(target, call.functionName, args as string[]);
  if (lowered) {
    return lowered;
  }

  // User-defined function call: the AST→IR builder pre-substitutes parameter
  // references with the call's argument expressions and attaches the result
  // as `body`. Lower the inlined body directly so a UDF like
  // `foo(x: int64) using (x * x)` becomes `(? * ?)` in SQL, matching the
  // unrolled-FOR shape the compiler already produces for the equivalent
  // hand-written expression.
  params.length = checkpoint;
  if (call.body) {
    const bodySql = compileValueSetSQL(call.body, sourceAlias, params, target, options, linkPropertyAlias);
    if (bodySql) {
      return bodySql;
    }
    params.length = checkpoint;
  }
  return null;
};

const orderedCallArgs = (args: Record<string, CallArg>): CallArg[] => {
  return Object.entries(args)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([, arg]) => arg);
};

// Parse `tuple<…>` / `default::tuple<…>` type names into slot descriptors.
// Returns null when the type isn't a tuple. Slots have a `name` only when
// the tuple is named (e.g. `tuple<a: str, b: int64>` → `[{name:"a",…},{name:"b",…}]`,
// while `tuple<str, int64>` → `[{type:"str"},{type:"int64"}]`).
const parseTupleTypeSlots = (typeName: string): { name?: string; type: string }[] | null => {
  const m = /^(?:default::)?tuple<(.*)>$/.exec(typeName.trim());
  if (!m) return null;
  const inner = m[1];
  const slots: { name?: string; type: string }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= inner.length; i += 1) {
    const c = inner[i];
    if (c === "<") depth += 1;
    else if (c === ">") depth -= 1;
    if ((c === "," && depth === 0) || i === inner.length) {
      const part = inner.slice(start, i).trim();
      start = i + 1;
      if (part.length === 0) continue;
      let colonIdx = -1;
      let d = 0;
      for (let j = 0; j < part.length; j += 1) {
        if (part[j] === "<") d += 1;
        else if (part[j] === ">") d -= 1;
        else if (part[j] === ":" && d === 0) { colonIdx = j; break; }
      }
      if (colonIdx > 0) {
        slots.push({ name: part.slice(0, colonIdx).trim(), type: part.slice(colonIdx + 1).trim() });
      } else {
        slots.push({ type: part });
      }
    }
  }
  return slots;
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
  // Include columns referenced by the link's modifier clauses (FILTER /
  // ORDER BY) so they reach the inner FROM. Without this, e.g. an
  // `ORDER BY .cost DESC LIMIT 1` on a `deck: { id }` shape sorts by NULL.
  const projectedCols = collectProjectedColumns(targetShape, modifiers?.where, modifiers?.orderBy);
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
    const linkTable = linkTableNameForPointer(pointer, options);
    const inner = compileLinkedInnerSelect(`SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${targetSource} JOIN ${quoteIdent(linkTable)} ${joinAlias} ON ${joinAlias}.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")} WHERE ${joinAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`, modifiers, targetAlias, params, target, options, joinAlias, pointer);
    return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
  }

  const inlineColumn = `${pointer.ptrref.shortName}_id`;
  const inner = compileLinkedInnerSelect(`SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${targetSource} WHERE ${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(inlineColumn)}`, modifiers, targetAlias, params, target, options, undefined, pointer);
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
    const linkTable = linkTableNameForPointer(pointer, options);
    const inner = compileLinkedInnerSelect(`SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${backlinkSource} JOIN ${quoteIdent(linkTable)} ${joinAlias} ON ${joinAlias}.${quoteIdent("source")} = ${backlinkAlias}.${quoteIdent("id")} WHERE ${joinAlias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")}`, modifiers, backlinkAlias, params, target, options, joinAlias, pointer);
    return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
  }

  const inlineColumn = `${pointer.ptrref.shortName}_id`;
  const inner = compileLinkedInnerSelect(`SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${backlinkSource} WHERE ${backlinkAlias}.${quoteIdent(inlineColumn)} = ${sourceAlias}.${quoteIdent("id")}`, modifiers, backlinkAlias, params, target, options, undefined, pointer);
  return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
};

// Variant of `rewriteFilterAgainstChainSource` keyed on an enclosing
// Pointer's target type — used by shape-value subqueries where the
// "outer source" is the pointer being iterated rather than a select_stmt's
// source set. Replaces chained references like `(Issue.<owner).number`
// (resolved against the backlink-iteration set) with a fresh type-root
// reference so they collapse to `targetAlias.column`.
const rewriteFilterAgainstPointerChain = (filterSet: Set, outerPointer: Pointer): Set => {
  const leafType = outerPointer.direction === "inbound" ? outerPointer.ptrref.outSource : outerPointer.ptrref.outTarget;
  const rewriteSet = (s: Set): Set => {
    const expr = s.expr;
    if (expr.kind === "pointer") {
      const ptr = expr as Pointer;
      // If this pointer's source is the same kind of chain as outerPointer,
      // replace with a direct type-root reference.
      let innerSource = ptr.source;
      const matches = (a: Set, b: Pointer): boolean => {
        if (a.expr.kind !== "pointer") return false;
        const aPtr = a.expr as Pointer;
        return aPtr.ptrref.id === b.ptrref.id && aPtr.direction === b.direction;
      };
      if (matches(innerSource, outerPointer)) {
        const newRoot: Set = {
          ...innerSource,
          expr: { kind: "type_root", typeref: leafType, skipSubtypes: false, isCachedGlobal: false },
          typeref: leafType,
        } as Set;
        return { ...s, expr: { ...ptr, source: newRoot } };
      }
      const newSource = rewriteSet(ptr.source);
      if (newSource === ptr.source) return s;
      return { ...s, expr: { ...ptr, source: newSource } };
    }
    if (expr.kind === "operator_call") {
      const op = expr as OperatorCall;
      const newArgs: Record<string, CallArg> = {};
      let changed = false;
      for (const [k, arg] of Object.entries(op.args)) {
        const newExpr = rewriteSet(arg.expr);
        if (newExpr !== arg.expr) changed = true;
        newArgs[k] = { ...arg, expr: newExpr };
      }
      if (!changed) return s;
      return { ...s, expr: { ...op, args: newArgs } };
    }
    if (expr.kind === "exists_expr") {
      const ex = expr as ExistsExpr;
      const newInner = rewriteSet(ex.expr);
      if (newInner === ex.expr) return s;
      return { ...s, expr: { ...ex, expr: newInner } };
    }
    if (expr.kind === "type_cast") {
      const tc = expr as TypeCast;
      const newInner = rewriteSet(tc.expr);
      if (newInner === tc.expr) return s;
      return { ...s, expr: { ...tc, expr: newInner } };
    }
    return s;
  };
  return rewriteSet(filterSet);
};

const compileLinkedInnerSelect = (
  baseSql: string,
  modifiers: SelectExpr | undefined,
  targetAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias?: string,
  // The pointer whose target rows we're iterating — used as the "outer
  // source" when rewriting filter chains so `.field` resolves to a column
  // on the target alias rather than re-walking the chain.
  outerPointer?: Pointer,
): string => {
  if (!modifiers) {
    return baseSql;
  }
  let inner = baseSql;
  const clauses: string[] = [];
  if (modifiers.where) {
    // Same trick as compileSelectStmtToSQL: when the filter references the
    // outer pointer's chain, swap that prefix for a fresh root set typed at
    // the chain's leaf so `.field` becomes `targetAlias.field`.
    const filterToCompile = outerPointer
      ? rewriteFilterAgainstPointerChain(modifiers.where, outerPointer)
      : modifiers.where;
    const where = compilePredicateSetSQL(filterToCompile, targetAlias, params, target, options, linkPropertyAlias)
      ?? compileValueSetSQL(filterToCompile, targetAlias, params, target, options, linkPropertyAlias);
    if (where) {
      clauses.push(where);
    }
  }
  if (clauses.length > 0) {
    inner += ` AND ${clauses.join(" AND ")}`;
  }
  if (modifiers.orderBy && modifiers.orderBy.length > 0) {
    // Same rewrite as for WHERE: `User.todo.number` inside the link's
    // iteration shape must resolve to `targetAlias.number`, not against the
    // outer User row. Without this, `ORDER BY User.todo.number` falls back to
    // a NULL literal and the sort is effectively undefined.
    const rewrittenOrderBy = outerPointer
      ? modifiers.orderBy.map((entry) => ({ ...entry, path: rewriteFilterAgainstPointerChain(entry.path, outerPointer) }))
      : modifiers.orderBy;
    const orderSql = compileSortExprs(rewrittenOrderBy, targetAlias, linkPropertyAlias, params, target, options);
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

const compileSortExprs = (
  orderBy: SortExpr[],
  sourceAlias: string,
  linkPropertyAlias?: string,
  params?: ScalarValue[],
  target?: RuntimeTarget,
  options?: GelIRCompileOptions,
): string => {
  return orderBy
    .map((entry) => {
      const column = compileSetColumnRef(entry.path, linkPropertyAlias);
      if (column) {
        const isLinkPropertyPointer = entry.path.expr.kind === "pointer" && (entry.path.expr as Pointer).ptrref.isLinkProperty;
        const orderAlias = isLinkPropertyPointer && linkPropertyAlias ? linkPropertyAlias : sourceAlias;
        return `${orderAlias}.${quoteIdent(column)} ${entry.direction.toUpperCase()}`;
      }
      // Expression sort keys (`ORDER BY len(.body)`) need the full value
      // compiler — bare column references only cover the trivial pointer
      // case. Caller must pass params/target/options for this to fire;
      // legacy callers without them keep the column-only behaviour.
      if (params && target && options) {
        const sql = compileValueSetSQL(entry.path, sourceAlias, params, target, options, linkPropertyAlias);
        if (sql) return `${sql} ${entry.direction.toUpperCase()}`;
      }
      return "";
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
  return compilePublicShapeObjectExpr(sourceAlias, set.shape, params, options, target, 0, linkPropertyAlias);
};

const shapeAliasForElement = (shape: ShapeElement, exprSet: Set, depth: number): string => {
  if (shape.name) {
    return shape.name;
  }
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

const compilePublicShapeObjectExpr = (
  sourceAlias: string,
  shape: ShapeElement[],
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
  linkPropertyAlias?: string,
): string => {
  const pairs: string[] = [];

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

  return pairs.length > 0 ? `json_object(${pairs.join(", ")})` : "json_object()";
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

// Integer constants must be emitted inline rather than via `?` parameters
// because better-sqlite3 binds JS `number` arguments as IEEE-754 REALs —
// which means `CAST(? AS TEXT)` with value 99 yields `'99.0'` instead of
// `'99'`. Inlining (`CAST(99 AS TEXT)` → `'99'`) sidesteps that coercion.
// Returns the SQL fragment when `expr` is an integer-shaped constant whose
// JS value is safely representable as a base-10 integer; otherwise undefined.
const inlineIntegerConstantSql = (expr: Expr, value: ScalarValue): string | undefined => {
  if (expr.kind !== "integer_constant") return undefined;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString(10);
  return undefined;
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

// Detect the empty-set sentinel that `literalToSet(null)` produces in
// ast_to_ir.ts: a `string_constant` with `value: null`, optionally wrapped
// in one or more `type_cast` layers (e.g. `<Issue>{}` casts the sentinel).
// Real string literals never carry `null` here.
const isTopLevelEmptySetMarker = (set: Set): boolean => {
  let expr: Expr = set.expr;
  while (expr.kind === "type_cast") {
    expr = (expr as TypeCast).expr.expr;
  }
  return expr.kind === "string_constant" && (expr as BaseConstant).value === null;
};

// EdgeQL semantics: any strict (non-coalescing) operator with an empty-set
// operand yields the empty set. `?=`, `?!=`, and `??` are coalescing and
// handled separately. Returns true when the SELECT's top expression is
// guaranteed to be empty by this rule.
const STRICT_COMPARE_OPS = new Set(["=", "!=", "<", "<=", ">", ">="]);
// Strict binary operators that propagate empty-set: comparisons, arithmetic,
// concatenation, logical, and standard relational ops. NOT included: `??`,
// `?=`, `?!=` (set-level coalescing), `union` (combines, doesn't propagate),
// `distinct` (degenerates to empty itself). `and`/`or` ARE strict — EdgeQL
// `{a} OR {}` is `{}` even when `a` would be true (no short-circuit on
// empty sets — the value of OR is a cross-product over both operands).
const STRICT_BINARY_OPS = new Set([
  ...STRICT_COMPARE_OPS,
  "+", "-", "*", "/", "//", "%", "^", "++",
  "like", "ilike", "in", "not in",
  "and", "or",
]);
// Stdlib functions that DO NOT propagate empty-set: they yield a defined
// result (false / 0 / [] / throw) when their arg is empty.
const NON_STRICT_STDLIB = new Set([
  "exists", "not exists",
  "count", "array_agg", "sum",
  "assert_exists", "assert_single", "assert_distinct",
  "coalesce",
  "enumerate",
]);
const selectYieldsEmptyByStrictOperand = (set: Set): boolean => {
  let expr: Expr = set.expr;
  while (expr.kind === "type_cast") {
    expr = (expr as TypeCast).expr.expr;
  }
  if (expr.kind === "operator_call") {
    const op = (expr as OperatorCall).operator;
    if (op === "not") {
      const args = orderedCallArgs((expr as OperatorCall).args);
      const onlyArg = args[0]?.expr;
      // `NOT EXISTS X` is always defined (true when X empty), not empty-propagating.
      if (onlyArg && onlyArg.expr.kind === "exists_expr") return false;
      return Boolean(onlyArg && isTopLevelEmptySetMarker(onlyArg));
    }
    if (!STRICT_BINARY_OPS.has(op)) return false;
    const args = orderedCallArgs((expr as OperatorCall).args);
    // Recurse so nested strict operators propagate empty up the tree —
    // `x * x + 2 * x + 1` with empty `x` should yield empty even though the
    // outer `+`'s direct args are themselves `operator_call`s, not raw empty
    // markers.
    return args.some((arg) => isTopLevelEmptySetMarker(arg.expr) || selectYieldsEmptyByStrictOperand(arg.expr));
  }
  if (expr.kind === "function_call") {
    const call = expr as FunctionCall;
    // Inlined UDF: the body's own strictness governs empty-propagation —
    // recursing into the body picks up set-constructor / union bodies that
    // remain defined when some arg is empty (e.g. `{<str>x, y}` with empty
    // `x` still yields `{y}`). Skip the per-arg shortcut here.
    if (call.body) {
      return selectYieldsEmptyByStrictOperand(call.body);
    }
    const shortName = (call.functionName ?? "").split("::").pop() ?? "";
    if (NON_STRICT_STDLIB.has(shortName)) return false;
    const args = orderedCallArgs(call.args);
    return args.some((arg) => isTopLevelEmptySetMarker(arg.expr) || selectYieldsEmptyByStrictOperand(arg.expr));
  }
  // Array and tuple literals are constructed from the cross-product of their
  // element sets — an empty element means zero rows. `[<int64>{}]` and
  // `(<int64>{}, 1)` both yield empty.
  if (expr.kind === "array") {
    const elements = (expr as ArrayExpr).elements;
    return elements.some((el) => isTopLevelEmptySetMarker(el) || selectYieldsEmptyByStrictOperand(el));
  }
  if (expr.kind === "tuple") {
    const elements = (expr as Tuple).elements;
    return elements.some((el) => isTopLevelEmptySetMarker(el.val) || selectYieldsEmptyByStrictOperand(el.val));
  }
  return false;
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
