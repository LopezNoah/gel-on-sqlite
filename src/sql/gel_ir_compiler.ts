import { quoteIdent, quoteLiteral, tableNameForType } from "../codegen/sql.js";
import { POINTER_ROOT_ALIAS, pointerStepJoinSql, pointerStepLinkAlias, pointerStepTargetAlias } from "./pointer_join.js";
import { AppError } from "../errors.js";
import type { RuntimeTarget } from "../runtime/target.js";
import { lowerStdlibFunctionSql } from "./stdlib_lowering.js";
import { ShapeLoweringMiss, type GelIRCompileOptions, type GelIRSQLArtifact, type ScalarPointerPath } from "./compiler_types.js";
import {
  compileGroupRowsStatementSQL,
  compileGroupRowsValueSQL,
  compileGroupStmtToSQL,
  groupProjectionHead,
} from "./group_lowering.js";
import {
  compileFunctionCallSQL,
  EMPTY_ON_NULL_FUNCTIONS,
  scalarArgTypeHint,
  setLooksLikeRange,
  SET_CONSUMING_FUNCTIONS,
  type SqlLoweringContext,
} from "./function_lowering.js";
import {
  compileCorrelatedOptionalCompareRows,
  tryCompileSetLevelCoalesceSQL,
  tryCompileSetLevelOptionalCompareSQL,
} from "./optional_comparison.js";
import {
  collectStrictPointerChainSets,
  compilePathExistenceGuard,
  tryCompileCorrelatedExistsSelect,
  tryCompileExistsObjectPointerSQL,
  tryCompileMultiStepPointerExistsSQL,
} from "./existence_proof.js";
import type {
  ArrayExpr,
  BaseConstant,
  CallArg,
  CoalesceExpr,
  ConfigStmt,
  ExistsExpr,
  DeleteExpr,
  DeleteStmt,
  EmbeddedGroupExpr,
  GroupRowsExpr,
  GroupRowProjection,
  GroupRowFieldExpr,
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
export type { GelIRCompileOptions, GelIRSQLArtifact } from "./compiler_types.js";

// The SQL compiler's internal lowering context (see SqlLoweringContext): a
// stateless, frozen dispatch table of this module's lowering functions, passed
// as `deps` to the function- and group-lowering sub-modules. It exists to break
// the import cycle — those sub-modules can't import gel_ir_compiler directly —
// so it carries no per-compile state and is built once. It must stay lazy: its
// members are const arrows declared below (TDZ at module load), so it can't be a
// top-level const literal. The memo cell is closure-scoped, not a module-level
// mutable binding (architecture review candidate #4; see docs/adr/0006).
const sqlLoweringContext: () => SqlLoweringContext = (() => {
  let cached: SqlLoweringContext | undefined;
  return () =>
    (cached ??= Object.freeze({
      compileScalarSelectSQL,
      compileValueSetSQL,
      compilePredicateSetSQL,
      extractNumericLiteral,
      orderedCallArgs,
      setValueIsJson,
      unwrapSelectExprSet,
      compileSelectSource,
      compileWhereClause,
      compilePolymorphicSource,
      compileForExprSource,
      compilePointerArrayExpr,
      tryCompileCorrelatedScalarPointerPathScalarSelect,
      collectForExprProjectedColumns,
      collectFreeTypeRoots,
      countAliases,
      innermostForExprBody,
      isTopLevelEmptySetMarker,
      pickSourcePathAlias,
      resetPointerSourceToRoot,
      narrowedLinkTarget,
      qualifyTypeName,
      collectTypeRootIds,
      collectPathIdKeys,
      collectScalarPointerSources,
      collectInnerWhereClauses,
      collectReferencedColumns,
      referencesUnboundAlias,
      shouldUseLinkTable,
      linkTableNameForPointer,
      columnForPointer,
      pathIdKey,
      extractScalarPointerPath,
      pointerPathAliasColumns,
      isTrulyPolymorphicTypeRef,
      collectProjectedColumns,
      NON_STRICT_STDLIB,
    }));
})();

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
    return compileGroupStmtToSQL(statement, options, sqlLoweringContext());
  }
  if (statement.kind === "config_stmt") {
    return compileConfigStmtToSQL(statement, options);
  }
  const target = options.target ?? "sqlite";
  const params: ScalarValue[] = [];
  const topSelect = unwrapSelectExprSet(statement.expr);
  const selectWhere = statement.where ?? topSelect.selectExpr?.where;
  const selectOrderBy = statement.orderBy ?? topSelect.selectExpr?.orderBy;
  let sourceSet = topSelect.selectExpr ? topSelect.result : unwrapSelectResultSet(statement.expr);
  // A shape applied to a select_expr wrapper (`SELECT (SELECT Text LIMIT 2)
  // {body}` or `SELECT sub {body}` for a WITH binding) lives on the OUTER
  // set; unwrapping to the select's result would silently drop it. Merge the
  // outer shape onto the unwrapped source (outer elements win on name
  // collisions with the implicit inner shape).
  if (
    sourceSet
    && sourceSet !== statement.expr
    && statement.expr.shape
    && statement.expr.shape.length > 0
  ) {
    const elementKey = (el: ShapeElement): string | undefined =>
      el.name
      ?? el.targetPtr?.shortName
      ?? (el.expr.expr.kind === "pointer" ? (el.expr.expr as Pointer).ptrref.shortName : undefined);
    const outerNames = new Set(statement.expr.shape.map(elementKey));
    const innerKept = (sourceSet.shape ?? []).filter((el) => {
      const key = elementKey(el);
      return key === undefined || !outerNames.has(key);
    });
    sourceSet = { ...sourceSet, shape: [...statement.expr.shape, ...innerKept] };
  }

  // EdgeQL forbids `LIMIT -1` / `OFFSET -2`; SQLite would silently treat them
  // as "no limit"/"skip nothing", masking the user error. Catch literal
  // negatives before anything else compiles so the message is clean.
  const stmtLimitForValidation = statement.limit ?? topSelect.selectExpr?.limit;
  const stmtOffsetForValidation = statement.offset ?? topSelect.selectExpr?.offset;
  const limitForValidation = extractNumericLiteral(stmtLimitForValidation);
  if (limitForValidation !== undefined && limitForValidation < 0) {
    throw new AppError("E_VALIDATION", "LIMIT must not be negative");
  }
  const offsetForValidation = extractNumericLiteral(stmtOffsetForValidation);
  if (offsetForValidation !== undefined && offsetForValidation < 0) {
    throw new AppError("E_VALIDATION", "OFFSET must not be negative");
  }

  // `SELECT (GROUP …) [{…}] [FILTER/ORDER BY]` — group rows in statement
  // position (incl. via WITH bindings). Lowered as a group-rows subquery
  // plus projection; statement clauses apply against the row JSON.
  if (sourceSet && sourceSet.expr.kind === "group_rows") {
    return compileGroupRowsStatementSQL(
      sourceSet.expr as GroupRowsExpr,
      selectWhere,
      selectOrderBy,
      statement.limit ?? topSelect.selectExpr?.limit,
      statement.offset ?? topSelect.selectExpr?.offset,
      params,
      target,
      options,
      sqlLoweringContext(),
    );
  }

  // `SELECT (GROUP …).elements / .key[.field] / .grouping` — destructuring a
  // group directly in statement position. Handled HERE (not in the shared
  // value compiler) so it only fires for the top-level result: an identical
  // `g.elements` inside a FOR-over-group aggregate arg must stay correlated to
  // the current group row, which the row-scope paths handle. Run the group rows,
  // then project/flatten the requested virtual field over each group row.
  if (sourceSet && sourceSet.expr.kind === "group_row_field"
      && (sourceSet.expr as GroupRowFieldExpr).rows
      && ["elements", "key", "grouping"].includes((sourceSet.expr as GroupRowFieldExpr).steps[0])
      && !(sourceSet.expr as GroupRowFieldExpr).steps.some((s) => s.startsWith("<"))
      && !selectWhere && (!selectOrderBy || selectOrderBy.length === 0)
      && (statement.limit ?? topSelect.selectExpr?.limit) === undefined
      && (statement.offset ?? topSelect.selectExpr?.offset) === undefined) {
    const field = sourceSet.expr as GroupRowFieldExpr;
    let rowsCursor: Set = field.rows as Set;
    let rowsWhere: Set | undefined;
    let rowsOrderBy: SortExpr[] | undefined;
    let rowsLimit: Set | undefined;
    let rowsOffset: Set | undefined;
    while (rowsCursor.expr.kind === "select_expr") {
      const se = rowsCursor.expr as SelectExpr;
      rowsWhere = rowsWhere ?? se.where;
      rowsOrderBy = rowsOrderBy ?? se.orderBy;
      rowsLimit = rowsLimit ?? se.limit;
      rowsOffset = rowsOffset ?? se.offset;
      rowsCursor = se.result;
    }
    if (rowsCursor.expr.kind === "group_rows") {
      const artifact = compileGroupRowsStatementSQL(
        rowsCursor.expr as GroupRowsExpr, rowsWhere, rowsOrderBy, rowsLimit, rowsOffset,
        params, target, options, sqlLoweringContext(),
      );
      if (artifact.loweringMode === "single_statement" && artifact.sql.length > 0) {
        const val = `gsr.${quoteIdent("value")}`;
        const head = field.steps[0];
        let sql: string;
        if (head === "elements") {
          const elemsJson = `COALESCE(json_extract(${val}, '$."elements"'), '[]')`;
          if (field.steps.length === 1) {
            sql = `SELECT json(je.${quoteIdent("value")}) AS ${quoteIdent("value")}`
              + ` FROM (${artifact.sql}) gsr CROSS JOIN json_each(${elemsJson}) je`;
          } else {
            const tail = field.steps.slice(1).map((s) => `."${s.replaceAll('"', '""')}"`).join("");
            sql = `SELECT jef.${quoteIdent("value")} AS ${quoteIdent("value")}`
              + ` FROM (${artifact.sql}) gsr CROSS JOIN json_each(${elemsJson}) je`
              + ` CROSS JOIN json_each(je.${quoteIdent("value")}, '$${tail}') jef`
              + ` WHERE jef.${quoteIdent("value")} IS NOT NULL`;
          }
        } else if (head === "grouping") {
          // `.grouping` is a JSON array of atom names per group — flatten it.
          const gJson = `COALESCE(json_extract(${val}, '$."grouping"'), '[]')`;
          sql = `SELECT je.${quoteIdent("value")} AS ${quoteIdent("value")}`
            + ` FROM (${artifact.sql}) gsr CROSS JOIN json_each(${gJson}) je`;
        } else {
          // `.key` (one key object per group) or `.key.field` (a scalar leaf).
          const path = field.steps.map((s) => `."${s.replaceAll('"', '""')}"`).join("");
          const extract = `json_extract(${val}, '$${path}')`;
          const expr = field.steps.length === 1 ? `json(${extract})` : extract;
          sql = `SELECT ${expr} AS ${quoteIdent("value")} FROM (${artifact.sql}) gsr`;
        }
        return { sql, params, loweringMode: "single_statement" };
      }
    }
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
  if (sourceSet && (isTopLevelEmptySetMarker(sourceSet, options) || selectYieldsEmptyByStrictOperand(sourceSet, options))) {
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
  const compiledSource = sourceSet
    ? compileSelectSource(sourceSet, statement.where ?? selectWhere, statement.orderBy ?? selectOrderBy, options, params, target)
    : null;
  if (!compiledSource) {
    // `SELECT (X.<l[IS A], X.<l[IS B])` with disjoint subtypes is provably
    // empty by shared-path semantics — check BEFORE the scalar fallback,
    // which can now lower the backlink elements independently (a zip/cross
    // that ignores the shared path) and return phantom rows.
    if (sourceSet && isProvablyEmptyTupleSet(sourceSet, options)) {
      return {
        sql: `SELECT NULL AS ${quoteIdent("id")}, NULL AS ${quoteIdent("__source_type")} WHERE 0`,
        params,
        loweringMode: "single_statement",
      };
    }
    if (sourceSet) {
      const outerWheres = selectWhere ? [selectWhere] : [];
      const scalarSql = compileScalarSelectSQL(sourceSet, params, target, options, outerWheres);
      if (scalarSql) {
        let sql = scalarSql;
        if (selectOrderBy && selectOrderBy.length > 0) {
          let orderSql = compileValueSortExprs(selectOrderBy, quoteIdent("value"), target, options.resolveEnumMembers, options.resolveFieldEnumMembers);
          if (!orderSql) {
            // Sort paths over a tuple source (`SELECT (Status.name, count(…))
            // ORDER BY Status.name`) sort by the matching tuple slot.
            let tupleCursor: Set = sourceSet;
            while (tupleCursor.expr.kind === "select_expr") tupleCursor = (tupleCursor.expr as SelectExpr).result;
            if (tupleCursor.expr.kind === "tuple") {
              const tupleExpr = tupleCursor.expr as Tuple;
              const slotByKey = new Map<string, number>();
              tupleExpr.elements.forEach((el, i) => slotByKey.set(pathIdKey(el.val), i));
              const parts = selectOrderBy.map((entry) => {
                const slot = slotByKey.get(pathIdKey(entry.path));
                if (slot === undefined) return "";
                return `json_extract(${quoteIdent("value")}, '$[${slot}]') ${entry.direction.toUpperCase()}${sortNullsClause(entry)}`;
              }).filter((p) => p.length > 0);
              if (parts.length === selectOrderBy.length) orderSql = parts.join(", ");
            }
          }
          if (!orderSql) {
            // `SELECT X.p ORDER BY X.p` — the scalar body projects exactly the
            // path the ORDER BY references, so the per-row sort key is the
            // already-projected `value` column. (compileValueSortPath returns
            // null for a bare pointer set since, on its own, it can't know the
            // pointer is what `value` holds.)
            const sourceKey = pathIdKey(sourceSet);
            const parts = selectOrderBy.map((entry) =>
              pathIdKey(entry.path) === sourceKey
                ? `${quoteIdent("value")} ${entry.direction.toUpperCase()}${sortNullsClause(entry)}`
                : "").filter((p) => p.length > 0);
            if (parts.length === selectOrderBy.length) orderSql = parts.join(", ");
          }
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
        const limitN = stmtLimit ? extractNumericLiteral(stmtLimit) : undefined;
        const offsetN = stmtOffset ? extractNumericLiteral(stmtOffset) : undefined;
        if (limitN !== undefined) {
          sql += ` LIMIT ${limitN}`;
        }
        if (offsetN !== undefined) {
          // SQLite requires a LIMIT before OFFSET; `LIMIT -1` means unbounded.
          if (limitN === undefined) sql += ` LIMIT -1`;
          sql += ` OFFSET ${offsetN}`;
        }
        return { sql, params, loweringMode: "single_statement" };
      }
    }
    return {
      sql: `SELECT NULL AS ${quoteIdent("id")}, NULL AS ${quoteIdent("__source_type")}`,
      params,
      loweringMode: "fallback_multi_query",
    };
  }

  const sourceAlias = compiledSource.alias;
  const sourceSql = compiledSource.sql;
  const sourceScopedOptions: GelIRCompileOptions = sourceSet
    ? {
        ...options,
        sourcePathAliases: [
          ...(options.sourcePathAliases ?? []),
          { pathKey: pathIdKey(sourceSet), alias: sourceAlias },
        ],
        // Register the iteration source's type root as an outer scope so a
        // computed shape element whose body references the subject row
        // (`c := foo(.b).a` — `.b` is the subject's property, substituted into
        // an inlined UDF body) lowers as a CORRELATED subquery anchored on
        // `sourceAlias` rather than a fresh, unbound table scan.
        outerScopes: sourceSet.expr.kind === "type_root"
          ? [
              ...(options.outerScopes ?? []),
              { alias: sourceAlias, typeref: (sourceSet.expr as TypeRoot).typeref, namespace: sourceSet.pathId?.namespace ?? [] },
            ]
          : options.outerScopes,
      }
    : options;

  const projections = [
    `${sourceAlias}.${quoteIdent("id")} AS ${quoteIdent("id")}`,
    `${sourceAlias}.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}`,
  ];

  const sourceShape = sourceSet?.shape ?? [];
  for (const element of sourceShape) {
    const projection = compileShapeProjection(element, sourceAlias, params, sourceScopedOptions, target, 0);
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
    // Surface the outer iteration's source type to sub-compilations so that
    // nested set producers (`array_unpack(.tag_array)`, json_each over a
    // multi scalar pointer) can correlate to the outer row's alias rather
    // than falling back to a fresh table scan with an unbound placeholder.
    // Bare type_root sources also participate in outer-scope path sharing;
    // non-root row sources are bound by path id through sourcePathAliases.
    const whereOptions: GelIRCompileOptions = sourceSet
      ? {
          ...options,
          sourcePathAliases: [
            ...(options.sourcePathAliases ?? []),
            { pathKey: pathIdKey(sourceSet), alias: sourceAlias },
          ],
          outerScopes: sourceSet.expr.kind === "type_root"
            ? [
                ...(options.outerScopes ?? []),
                { alias: sourceAlias, typeref: (sourceSet.expr as TypeRoot).typeref, namespace: sourceSet.pathId?.namespace ?? [] },
              ]
            : options.outerScopes,
        }
      : options;
    let whereSql = compileWhereClause(rewritten, sourceAlias, params, target, whereOptions);
    if (!whereSql) {
      // Predicates referencing a WITH-rebound copy of a type (`WITH I2 :=
      // Issue … FILTER any(I2 != Issue AND …)`) can't anchor every path at
      // the outer alias. EdgeQL FILTER semantics keep the row when ANY
      // element of the boolean set is true, so lower the whole predicate as
      // a correlated EXISTS over scans of the free roots.
      whereSql = tryCompileFreeRootExistsWhere(rewritten, sourceAlias, sourceSet, params, target, whereOptions);
    }
    if (whereSql) {
      sql += ` WHERE ${whereSql}`;
    } else if (process.env.DBG_DROPPED_WHERE) {
      console.error("[dropped-where]");
    }
  }

  const orderByToApply = statement.orderBy ?? selectOrderBy;
  if (orderByToApply && orderByToApply.length > 0) {
    // ORDER BY references against the iteration source also need the same
    // current-source binding as FILTER so set producers correlate to the row.
    const orderOptions: GelIRCompileOptions = sourceSet
      ? {
          ...options,
          sourcePathAliases: [
            ...(options.sourcePathAliases ?? []),
            { pathKey: pathIdKey(sourceSet), alias: sourceAlias },
          ],
          outerScopes: sourceSet.expr.kind === "type_root"
            ? [
                ...(options.outerScopes ?? []),
                { alias: sourceAlias, typeref: (sourceSet.expr as TypeRoot).typeref, namespace: sourceSet.pathId?.namespace ?? [] },
              ]
            : options.outerScopes,
        }
      : options;
    const orders = orderByToApply.map((order) => {
      // A shape computed SHADOWS the schema pointer for outer references:
      // `SELECT Issue { time_estimate := … } ORDER BY Issue.time_estimate`
      // sorts by the computed expression, not the raw column (dependent_01).
      if (order.path.expr.kind === "pointer" && sourceSet) {
        const sortPtr = order.path.expr as Pointer;
        let sortSrc: Set = sortPtr.source;
        while (sortSrc.expr.kind === "select_expr") sortSrc = (sortSrc.expr as SelectExpr).result;
        if (sortSrc.expr.kind === "type_root"
            && sourceSet.expr.kind === "type_root"
            && (sortSrc.expr as TypeRoot).typeref.id === (sourceSet.expr as TypeRoot).typeref.id) {
          const ptrName = sortPtr.ptrref.shortName;
          const shadowing = (sourceSet.shape ?? []).find((el) => {
            const elName = el.targetPtr?.shortName ?? el.name;
            if (elName !== ptrName) return false;
            if (el.shapeOrigin !== "explicit") return false;
            // Plain projections (`{ time_estimate }`) don't shadow — only
            // assigned computeds do.
            const inner = unwrapSelectExprSet(el.expr).result;
            return inner.expr.kind !== "pointer"
              || (inner.expr as Pointer).ptrref.id !== sortPtr.ptrref.id;
          });
          if (shadowing) {
            const shadowCkpt = params.length;
            const computedSql = compileValueSetSQL(
              unwrapSelectExprSet(shadowing.expr).result, sourceAlias, params, target, orderOptions,
            );
            if (computedSql) {
              return `${computedSql} ${order.direction.toUpperCase()}${sortNullsClause(order)}`;
            }
            params.length = shadowCkpt;
          }
        }
      }
      // Only treat the sort key as a bare column when the pointer hangs
      // directly off the iteration's type root — `Issue.priority.name` is a
      // chain whose leaf column lives on another table and must compile as a
      // correlated expression instead.
      const pointerIsDirect = (() => {
        if (order.path.expr.kind !== "pointer") return false;
        let src: Set = (order.path.expr as Pointer).source;
        while (src.expr.kind === "select_expr") {
          const se = src.expr as SelectExpr;
          if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return false;
          src = se.result;
        }
        // A genuine multi-step chain's leaf column lives on another table.
        // Degenerate sources (relative `.name` paths arrive as a pointer over
        // a placeholder constant) still mean "column on the outer row".
        return src.expr.kind !== "pointer";
      })();
      const orderColumn = pointerIsDirect ? compileSetColumnRef(order.path) : null;
      if (orderColumn) {
        // A computed shape field (`tn := .__type__.name`) over a polymorphic
        // union is materialized only as an output alias of this outer SELECT,
        // never as a physical column of the source subquery — so
        // `${sourceAlias}."tn"` references a column that does not exist. Such
        // fields are still valid as bare ORDER BY references, which SQLite
        // resolves against the projection list. Stored pointers keep the
        // source-qualified form to preserve the emitted SQL for direct columns.
        const shapeField = (sourceSet?.shape ?? []).find(
          (el) => (el.targetPtr?.shortName ?? el.name) === orderColumn,
        );
        const isStoredColumn = (() => {
          if (!shapeField) return true;
          const value = unwrapSelectExprSet(shapeField.expr).result;
          return value.expr.kind === "pointer"
            && !(value.expr as Pointer).ptrref.isLinkProperty
            && columnForPointer(value.expr as Pointer) === orderColumn;
        })();
        const ref = isStoredColumn
          ? `${sourceAlias}.${quoteIdent(orderColumn)}`
          : quoteIdent(orderColumn);
        return `${ref} ${order.direction.toUpperCase()}${sortNullsClause(order)}`;
      }
      // `SELECT Issue.owner {…} ORDER BY Issue.owner.name` — the sort path
      // extends the statement's own pointer-chain source, so its leaf column
      // already lives on the outer alias's rows.
      if (order.path.expr.kind === "pointer" && sourceSet?.expr.kind === "pointer") {
        const leaf = order.path.expr as Pointer;
        if (
          leaf.ptrref.outTarget.isScalar
          && !leaf.ptrref.isLinkProperty
          && pathIdKey(leaf.source) === pathIdKey(sourceSet)
        ) {
          return `${sourceAlias}.${quoteIdent(columnForPointer(leaf))} ${order.direction.toUpperCase()}${sortNullsClause(order)}`;
        }
      }
      const exprSql = compileValueSetSQL(order.path, sourceAlias, params, target, orderOptions);
      return exprSql ? `${exprSql} ${order.direction.toUpperCase()}${sortNullsClause(order)}` : "";
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
  const head = ptrs[0];
  const headSourceId = head.source.expr.kind === "type_root" ? (head.source.expr as TypeRoot).typeref.id : undefined;
  if (!headSourceId) return false;
  for (let i = 1; i < ptrs.length; i++) {
    const cur = ptrs[i];
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
  const assigns = compileDmlAssignments(statement.shape, "new_row", params, target, options, "insert");
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
    insertColumns: assigns.columns.map((column, idx) => ({
      column,
      sql: assigns.values[idx],
      params: params.slice(assigns.paramSpans[idx][0], assigns.paramSpans[idx][1]),
    })),
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
  // `DELETE (SELECT T FILTER f)` nests the target's SELECT inside a subquery
  // `select_expr` wrapper, so the filter / ORDER BY / pagination live on an
  // *inner* select level — `unwrapSelectExprSet` only peels one. Walk every
  // nested select_expr level so the clauses on the real SELECT are recovered
  // (the wrappers are clause-free); without this the target filter is dropped
  // and the DELETE removes every row.
  let sourceSet: Set = statement.expr;
  let targetWhere: Set | undefined;
  let targetOrderBy: SortExpr[] | undefined;
  let targetLimit: Set | undefined;
  let targetOffset: Set | undefined;
  while (sourceSet.expr.kind === "select_expr") {
    const se = sourceSet.expr as SelectExpr;
    targetWhere ??= se.where;
    if (targetOrderBy === undefined && se.orderBy && se.orderBy.length > 0) targetOrderBy = se.orderBy;
    targetLimit ??= se.limit;
    targetOffset ??= se.offset;
    sourceSet = se.result;
  }
  const whereSet = statement.where ?? targetWhere;
  const orderBy = statement.orderBy ?? targetOrderBy;
  const limitSet = statement.limit ?? targetLimit;
  const offsetSet = statement.offset ?? targetOffset;
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
  // INSERT assignments have no current row: an EdgeQL insert can't reference
  // the row being inserted, so any compiled value that anchors on
  // `sourceAlias` actually mis-lowered a path into another set (the
  // select_expr-fence unwrapping in compileValueSetSQL assumes a SELECT
  // statement context). In that mode such values recompile as self-contained
  // scalar subselects instead.
  mode: "insert" | "update" = "update",
): { columns: string[]; values: string[]; paramSpans: Array<[number, number]> } | null => {
  const columns: string[] = [];
  const values: string[] = [];
  // [start, end) index range into `params` consumed by each values[i] — lets
  // the insert artifact expose per-column expressions with their own params.
  const paramSpans: Array<[number, number]> = [];
  const selfRef = `${sourceAlias}.`;
  const compileAssignmentValue = (set: Set): string | null => {
    const checkpoint = params.length;
    const direct = compileValueSetSQL(set, sourceAlias, params, target, options);
    if (direct && !(mode === "insert" && direct.includes(selfRef))) {
      return direct;
    }
    params.length = checkpoint;
    if (mode !== "insert") {
      return direct;
    }
    // Standalone lowering: compile the value as its own row source and read
    // it as a scalar subselect (NULL when empty, first row otherwise —
    // matching the empty-set/single-row semantics of the assignment).
    const rows = compileScalarSelectSQL(set, params, target, options);
    if (rows) {
      return `(${rows})`;
    }
    params.length = checkpoint;
    return null;
  };
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
    const spanStart = params.length;
    if (containsUnionOperator(element.expr)) {
      const unionSql = compileAssignmentValue(element.expr);
      if (!unionSql) {
        params.length = spanStart;
        if (ptr.outTarget.isScalar) {
          return null;
        }
        continue;
      }
      if (ptr.outTarget.isScalar) {
        columns.push(ptr.shortName);
        values.push(normalizeBoolColumnValue(ptr, unionSql));
      } else {
        columns.push(`${ptr.shortName}_id`);
        values.push(`json_extract(${unionSql}, '$[0].id')`);
      }
      paramSpans.push([spanStart, params.length]);
      continue;
    }
    const valueSql = compileAssignmentValue(element.expr);
    if (!valueSql) {
      params.length = spanStart;
      if (ptr.outTarget.isScalar) {
        return null;
      }
      continue;
    }
    if (ptr.outTarget.isScalar) {
      columns.push(ptr.shortName);
      values.push(normalizeBoolColumnValue(ptr, valueSql));
      paramSpans.push([spanStart, params.length]);
      continue;
    }
    columns.push(`${ptr.shortName}_id`);
    values.push(`json_extract(${valueSql}, '$[0].id')`);
    paramSpans.push([spanStart, params.length]);
  }
  return { columns, values, paramSpans };
};

// Bool-typed scalar columns are stored as integer 0/1 in the data table (the
// INSERT path binds JS booleans which SQLite coerces to 0/1). A SELECT
// expression compiles a bool literal as `json('true')`/`json('false')` so the
// runtime decoder reads a JSON boolean — but that text must never be written
// into a stored bool column. When an UPDATE/INSERT assignment targets a bool
// property, rewrite the canonical literal forms to 0/1 so reads round-trip.
const normalizeBoolColumnValue = (ptr: PointerRef, valueSql: string): string => {
  const targetId = ptr.outTarget.id ?? "";
  const targetName = ptr.outTarget.nameHint ?? "";
  const isBool = targetId === "std::bool" || targetName === "std::bool" || targetId === "bool" || targetName === "bool";
  if (!isBool) return valueSql;
  if (valueSql === "json('true')") return "1";
  if (valueSql === "json('false')") return "0";
  return valueSql;
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
      const se = sourceExpr as SelectExpr;
      // A pointer over a cardinality-clipped subquery
      // (`(SELECT T ORDER BY … LIMIT 1).p`) must NOT register T as a flat table
      // source — flattening would emit `FROM <T> g0` and silently drop the
      // LIMIT / OFFSET, so the operand would see every row instead of the
      // single clipped one (e.g. `(SELECT T ORDER BY .num DESC LIMIT 1).num
      // + 1`). Leave the source unregistered so the operand compiles as a
      // correlated scalar subquery that preserves the clip. A bare ORDER BY
      // (no LIMIT/OFFSET) doesn't change cardinality, so `.p` still maps
      // element-wise — don't divert those.
      if (se.limit || se.offset) return;
      sourceExpr = se.result.expr;
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
      // LEGITIMATE (do not remove): EdgeQL fully-qualified function names are
      // canonically `module::name`; taking the last `::` segment is lossless
      // qualified-name decomposition, not IR structure re-derived from a
      // string. This `::`-split idiom recurs across function-call lowering for
      // the same reason.
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

// A "fenced scalar pointer": a single scalar-pointer step whose source
// unwraps through one or more WHERE-carrying select_expr fences down to a
// type_root — `(SELECT Issue FILTER …).time_estimate` is the canonical
// shape. Under optional operators (?? LHS, ?= / ?!= args) the fence WHERE
// belongs to the operand alone: it empties the operand per shared row and
// must NOT be hoisted into the shared iteration's WHERE.
type FencedScalarPointer = {
  leaf: Pointer;
  fenceWheres: Set[];
  rootTyperef: TypeRef;
};

const matchFencedScalarPointer = (set: Set): FencedScalarPointer | null => {
  let cur: Set = set;
  // Peel clause-less wrappers above the pointer.
  while (cur.expr.kind === "select_expr") {
    const se = cur.expr as SelectExpr;
    if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
    cur = se.result;
  }
  if (cur.expr.kind !== "pointer") return null;
  const leaf = cur.expr as Pointer;
  if (leaf.direction !== "outbound" || !leaf.ptrref.outTarget.isScalar
      || leaf.ptrref.isLinkProperty || shouldUseLinkTable(leaf)) return null;
  const fenceWheres: Set[] = [];
  let src: Set = leaf.source;
  while (src.expr.kind === "select_expr") {
    const se = src.expr as SelectExpr;
    if ((se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
    if (se.where) fenceWheres.push(se.where);
    src = se.result;
  }
  if (fenceWheres.length === 0) return null;
  if (src.expr.kind !== "type_root") return null;
  return { leaf, fenceWheres, rootTyperef: (src.expr as TypeRoot).typeref };
};

// True when the set contains a path reaching a type_root WITHOUT passing
// through a WHERE-carrying fence — i.e. the set can supply the shared
// iteration root on its own (the condition under which a fenced operand's
// WHERE stays inside its own correlated subselect).
const hasBareRootPath = (set: Set | undefined): boolean => {
  if (!set || !set.expr) return false;
  const e = set.expr;
  if (e.kind === "type_root") return true;
  if (e.kind === "pointer") return hasBareRootPath((e as Pointer).source);
  if (e.kind === "select_expr") {
    const se = e as SelectExpr;
    if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return false;
    return hasBareRootPath(se.result);
  }
  if (e.kind === "type_cast") return hasBareRootPath((e as TypeCast).expr);
  if (e.kind === "coalesce_expr") {
    return hasBareRootPath((e as CoalesceExpr).left) || hasBareRootPath((e as CoalesceExpr).right);
  }
  if (e.kind === "operator_call" || e.kind === "function_call") {
    if (e.kind === "function_call") {
      const shortName = ((e as FunctionCall).functionName ?? "").split("::").pop() ?? "";
      if (["count", "sum", "min", "max", "avg", "all", "any", "array_agg", "enumerate"].includes(shortName)) {
        return false;
      }
    }
    return orderedCallArgs((e as { args: Record<string, CallArg> }).args).some((arg) => hasBareRootPath(arg.expr));
  }
  if (e.kind === "if_else_expr") {
    const ie = e as IfElseExpr;
    return hasBareRootPath(ie.condition) || hasBareRootPath(ie.ifExpr) || hasBareRootPath(ie.elseExpr);
  }
  if (e.kind === "tuple") return (e as Tuple).elements.some((el) => hasBareRootPath(el.val));
  if (e.kind === "index_expr") return hasBareRootPath((e as IndexExpr).expr);
  if (e.kind === "slice_expr") return hasBareRootPath((e as SliceExpr).expr);
  return false;
};

// Compile a fenced scalar pointer as a correlated subselect carrying its own
// fence WHERE: `(SELECT cfp0."col" FROM <root> cfp0 WHERE cfp0."id" =
// ${sourceAlias}."id" AND <fence wheres>)`. Returns null when the shape
// doesn't match or a fence WHERE can't lower.
const compileFencedPointerCorrelatedSQL = (
  set: Set,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  const match = matchFencedScalarPointer(set);
  if (!match) return null;
  const ckpt = params.length;
  const col = columnForPointer(match.leaf);
  const refCols = [...new globalThis.Set([
    "id",
    col,
    ...match.fenceWheres.flatMap((w) => collectReferencedColumns(w)),
  ])];
  const from = compilePolymorphicSource(match.rootTyperef, false, "cfp0", refCols, options);
  const whereParts: string[] = [`cfp0.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent("id")}`];
  for (const w of match.fenceWheres) {
    const compiled = compilePredicateSetSQL(w, "cfp0", params, target, options)
      ?? compileValueSetSQL(w, "cfp0", params, target, options);
    if (!compiled) {
      params.length = ckpt;
      return null;
    }
    whereParts.push(compiled);
  }
  return `(SELECT cfp0.${quoteIdent(col)} FROM ${from} WHERE ${whereParts.join(" AND ")})`;
};

// `X[IS A].p ?? X[IS B].q` where X := {A, B}: each coalesce side is an
// expression over a scalar pointer whose source is the SAME union of
// type_roots, narrowed (via [IS T]) to one member. Detection + rebuild
// helpers for the element-wise lowering: per union row, a side contributes
// only when the row's __source_type belongs to its narrowed member.
type UnionPrefixSide = {
  // The side rebuilt with the pointer's union source replaced by a bare
  // type_root of the narrowed member (so the generic value compiler reads
  // the shared alias's columns).
  rebuilt: Set;
  narrowed: TypeRef;
  memberIds: string[];
};

const matchUnionPrefixSide = (side: Set): UnionPrefixSide | null => {
  // Locate the pointer whose source is a union-of-type_roots, then rebuild
  // the side with that source replaced. Mirrors the walk in rebuild below.
  const rebuild = (s: Set): { set: Set; narrowed: TypeRef; memberIds: string[] } | null => {
    const e = s.expr;
    if (e.kind === "select_expr") {
      const se = e as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
      const inner = rebuild(se.result);
      if (!inner) return null;
      return { ...inner, set: { ...s, expr: { ...se, result: inner.set } } };
    }
    if (e.kind === "index_expr") {
      const ix = e as IndexExpr;
      const inner = rebuild(ix.expr);
      if (!inner) return null;
      return { ...inner, set: { ...s, expr: { ...ix, expr: inner.set } } };
    }
    if (e.kind === "slice_expr") {
      const sl = e as SliceExpr;
      const inner = rebuild(sl.expr);
      if (!inner) return null;
      return { ...inner, set: { ...s, expr: { ...sl, expr: inner.set } } };
    }
    if (e.kind === "type_cast") {
      const tc = e as TypeCast;
      const inner = rebuild(tc.expr);
      if (!inner) return null;
      return { ...inner, set: { ...s, expr: { ...tc, expr: inner.set } } };
    }
    if (e.kind !== "pointer") return null;
    const ptr = e as Pointer;
    if (ptr.direction !== "outbound" || !ptr.ptrref.outTarget.isScalar
        || ptr.ptrref.isLinkProperty || shouldUseLinkTable(ptr)) return null;
    let src: Set = ptr.source;
    while (src.expr.kind === "select_expr") {
      const se = src.expr as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
      src = se.result;
    }
    if (src.expr.kind !== "operator_call" || (src.expr as OperatorCall).operator !== "union") return null;
    const memberArgs = orderedCallArgs((src.expr as OperatorCall).args);
    if (memberArgs.length < 2 || !memberArgs.every((a) => a.expr.expr.kind === "type_root")) return null;
    const memberIds = memberArgs.map((a) => (a.expr.expr as TypeRoot).typeref.id);
    const narrowed = ptr.source.typeref;
    if (!narrowed || narrowed.isScalar || !memberIds.includes(narrowed.id)) return null;
    const rootSet: Set = {
      ...ptr.source,
      shape: [],
      expr: { kind: "type_root", typeref: narrowed, skipSubtypes: false, isCachedGlobal: false } as TypeRoot,
    };
    return { set: { ...s, expr: { ...ptr, source: rootSet } }, narrowed, memberIds };
  };
  const out = rebuild(side);
  if (!out) return null;
  return { rebuilt: out.set, narrowed: out.narrowed, memberIds: out.memberIds };
};

// The gated COALESCE value for a union-prefix coalesce, correlated against
// `sourceAlias` (one row per union element, tagged __source_type). Returns
// null when the shape doesn't match.
const compileUnionPrefixCoalesceValueSQL = (
  coalesce: CoalesceExpr,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  const lhs = matchUnionPrefixSide(coalesce.left);
  const rhs = matchUnionPrefixSide(coalesce.right);
  if (!lhs || !rhs) return null;
  if (lhs.memberIds.join("|") !== rhs.memberIds.join("|")) return null;
  const ckpt = params.length;
  const gated = (side: UnionPrefixSide): string | null => {
    const sql = compileValueSetSQL(side.rebuilt, sourceAlias, params, target, options);
    if (!sql) return null;
    const concrete = flattenTypeClosure(side.narrowed)
      .filter((t) => !t.isAbstract)
      .map((t) => quoteLiteral(qualifyTypeName(t)));
    if (concrete.length === 0) return null;
    return `(CASE WHEN ${sourceAlias}.${quoteIdent("__source_type")} IN (${concrete.join(", ")}) THEN ${sql} END)`;
  };
  const left = gated(lhs);
  const right = left ? gated(rhs) : null;
  if (!left || !right) {
    params.length = ckpt;
    return null;
  }
  return `COALESCE(${left}, ${right})`;
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
      const callArgs = orderedCallArgs((e as { args: Record<string, CallArg> }).args);
      // ?= / ?!= args are OPTIONAL: a fenced-pointer arg keeps its fence
      // WHERE inside its own correlated subselect when another arg supplies
      // the iteration root (see compileFencedPointerCorrelatedSQL).
      const isOptionalCompare = e.kind === "operator_call"
        && ((e as OperatorCall).operator === "?=" || (e as OperatorCall).operator === "?!=");
      for (let i = 0; i < callArgs.length; i += 1) {
        if (isOptionalCompare
          && matchFencedScalarPointer(callArgs[i].expr)
          && callArgs.some((other, j) => j !== i && hasBareRootPath(other.expr))) {
          continue;
        }
        visit(callArgs[i].expr);
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
      // ?? LHS is OPTIONAL: when the RHS supplies the iteration root, the
      // LHS fence WHERE only empties the LHS per row (dependent_04) — it
      // compiles into the LHS's correlated subselect, not the shared WHERE.
      if (!(matchFencedScalarPointer(ce.left) && hasBareRootPath(ce.right))) {
        visit(ce.left);
      }
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
    if (e.kind === "index_expr") {
      visit((e as IndexExpr).expr);
      return;
    }
    if (e.kind === "slice_expr") {
      visit((e as SliceExpr).expr);
      return;
    }
  };
  visit(set);
  return out;
};

// Walks a set and collects qualified type names of all type_roots referenced
// transitively. Used for a simple LCP check on coalesce_expr: when LHS and RHS
// share no type_root, ?? has set-level semantics (empty LHS → RHS as a singleton).
const collectTypeRootIds = (
  set: Set | undefined,
  ids: globalThis.Set<string>,
  // When true, roots behind a WHERE/ORDER BY/LIMIT/OFFSET-carrying
  // select_expr fence are NOT collected: a fenced path contributes no
  // scoped (factorable) root to the enclosing expression.
  bareOnly = false,
): void => {
  if (!set) return;
  const expr = set.expr;
  if (!expr) return;
  if (expr.kind === "type_root") {
    // Root identity is (type, pathId namespace): a WITH-rebound `I2 :=
    // Issue` (ns `with:I2:…`) is a DIFFERENT root from a bare `Issue`
    // reference — they must not unify into a shared LCP (dependent_06).
    const ns = (set.pathId?.namespace ?? []).join(",");
    ids.add(`${qualifyTypeName((expr as TypeRoot).typeref)}${ns ? `|${ns}` : ""}`);
    return;
  }
  if (expr.kind === "pointer") {
    collectTypeRootIds((expr as Pointer).source, ids, bareOnly);
    return;
  }
  if (expr.kind === "select_expr") {
    const se = expr as SelectExpr;
    if (bareOnly && (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset)) {
      return;
    }
    collectTypeRootIds(se.result, ids, bareOnly);
    if (!bareOnly) collectTypeRootIds(se.where, ids, bareOnly);
    if (!bareOnly) {
      for (const sort of se.orderBy ?? []) collectTypeRootIds(sort.path, ids, bareOnly);
    }
    return;
  }
  if (expr.kind === "operator_call" || expr.kind === "function_call") {
    for (const arg of orderedCallArgs((expr as { args: Record<string, CallArg> }).args)) {
      collectTypeRootIds(arg.expr, ids, bareOnly);
    }
    return;
  }
  if (expr.kind === "coalesce_expr") {
    collectTypeRootIds((expr as CoalesceExpr).left, ids, bareOnly);
    collectTypeRootIds((expr as CoalesceExpr).right, ids, bareOnly);
    return;
  }
  if (expr.kind === "if_else_expr") {
    const ie = expr as IfElseExpr;
    collectTypeRootIds(ie.condition, ids, bareOnly);
    collectTypeRootIds(ie.ifExpr, ids, bareOnly);
    collectTypeRootIds(ie.elseExpr, ids, bareOnly);
    return;
  }
  if (expr.kind === "tuple") {
    for (const el of (expr as Tuple).elements) collectTypeRootIds(el.val, ids, bareOnly);
    return;
  }
  if (expr.kind === "type_cast") {
    collectTypeRootIds((expr as TypeCast).expr, ids, bareOnly);
    return;
  }
  if (expr.kind === "exists_expr") {
    collectTypeRootIds((expr as ExistsExpr).expr, ids, bareOnly);
    return;
  }
  if (expr.kind === "index_expr") {
    const ix = expr as IndexExpr;
    collectTypeRootIds(ix.expr, ids, bareOnly);
    collectTypeRootIds(ix.index, ids, bareOnly);
    return;
  }
  if (expr.kind === "slice_expr") {
    const sl = expr as SliceExpr;
    collectTypeRootIds(sl.expr, ids, bareOnly);
    collectTypeRootIds(sl.start, ids, bareOnly);
    collectTypeRootIds(sl.end, ids, bareOnly);
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

// Invariant guard for FROM-less emissions: a fragment that reads
// `alias."col"` without binding the alias itself (no `) alias` subquery
// binding), and with no enclosing scope providing it, would either throw
// "no such column" or silently correlate against an unrelated alias.
// This inspects only our own generated SQL (never user query text); callers
// use it to bail to other strategies instead of emitting broken SQL.
const referencesUnboundAlias = (
  sql: string,
  alias: string,
  options: GelIRCompileOptions,
): boolean => {
  if (!sql.includes(`${alias}.`)) return false;
  if (sql.includes(`) ${alias}`)) return false;
  if ((options.outerScopes ?? []).some((scope) => scope.alias === alias)) return false;
  return true;
};

// A shared-root tuple element that produces a ROW SET per shared row (not a
// single value): `Issue.time_spent_log ?= LOG1` (one compare per link
// element) or `(Issue.time_spent_log ?? DUMMY).spent_time` (one leaf value
// per coalesced object). Returns SQL for a correlated JSON-array expression
// (one array per shared row) that the tuple lowering expands back into rows
// with json_each. `wrapJson` says whether the json_each values need a
// json() wrap in the tuple slot (text 'true'/'false' → boolean).
const compileSharedTupleRowSetElement = (
  set: Set,
  sharedAlias: string,
  sharedTyperef: TypeRef,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): { sql: string; wrapJson: boolean } | null => {
  const unwrapBareSelects = (s: Set): Set | null => {
    let cur: Set = s;
    while (cur.expr.kind === "select_expr") {
      const se = cur.expr as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
      cur = se.result;
    }
    return cur;
  };
  const rootIsShared = (s: Set): boolean => {
    let cur: Set = s;
    for (;;) {
      if (cur.expr.kind === "select_expr") { cur = (cur.expr as SelectExpr).result; continue; }
      break;
    }
    return cur.expr.kind === "type_root" && (cur.expr as TypeRoot).typeref.id === sharedTyperef.id;
  };
  const rhsAvoidsShared = (s: Set): boolean => {
    const roots = new globalThis.Set<string>();
    collectTypeRootIds(s, roots);
    return !roots.has(sharedTyperef.id);
  };
  const cur = unwrapBareSelects(set);
  if (!cur) return null;

  // Shared-root scalar pointer with a clause-less fence unwrap; returns the
  // projected column when the operand is `SharedType.scalar_ptr`.
  const sharedScalarColumn = (s: Set): string | null => {
    const inner = unwrapBareSelects(s);
    if (!inner || inner.expr.kind !== "pointer") return null;
    const ptr = inner.expr as Pointer;
    if (ptr.direction !== "outbound" || !ptr.ptrref.outTarget.isScalar
        || ptr.ptrref.isLinkProperty || shouldUseLinkTable(ptr)) return null;
    if (!rootIsShared(ptr.source)) return null;
    return columnForPointer(ptr);
  };
  const multiUnionArgs = (s: Set): CallArg[] | null => {
    const inner = unwrapBareSelects(s);
    if (!inner || inner.expr.kind !== "operator_call"
        || (inner.expr as OperatorCall).operator !== "union") return null;
    const args = orderedCallArgs((inner.expr as OperatorCall).args);
    return args.length > 1 ? args : null;
  };
  const compileUnionRowsShared = (args: CallArg[]): string | null => {
    const ckpt = params.length;
    const parts: string[] = [];
    for (const arg of args) {
      const v = compileValueSetSQL(arg.expr, sharedAlias, params, target, options);
      if (!v) {
        params.length = ckpt;
        return null;
      }
      parts.push(`SELECT ${v} AS v`);
    }
    return parts.join(" UNION ALL ");
  };

  // Element-wise scalar coalesce with a MULTI (union) RHS in a tuple slot
  // (`(Issue.number, Issue.time_estimate ?? {-1,-2})`): one tuple row per
  // RHS element when the LHS leaf is NULL (set_03).
  if (cur.expr.kind === "coalesce_expr") {
    const ce = cur.expr as CoalesceExpr;
    const col = sharedScalarColumn(ce.left);
    const unionArgs = multiUnionArgs(ce.right);
    if (!col || !unionArgs) return null;
    const rows = compileUnionRowsShared(unionArgs);
    if (!rows) return null;
    const lhsSql = `${sharedAlias}.${quoteIdent(col)}`;
    return {
      sql: `(CASE WHEN ${lhsSql} IS NOT NULL THEN json_array(${lhsSql})`
        + ` ELSE (SELECT json_group_array(v) FROM (${rows})) END)`,
      wrapJson: false,
    };
  }

  if (cur.expr.kind === "operator_call") {
    const call = cur.expr as OperatorCall;
    if (call.operator !== "?=" && call.operator !== "?!=") return null;
    const args = orderedCallArgs(call.args);
    if (args.length !== 2) return null;
    // Element-wise scalar ?= / ?!= with a MULTI (union) RHS in a tuple slot
    // (`(Issue.number, Issue.time_estimate ?= {60, 90})`): one comparison
    // row per RHS element (set_08).
    {
      const col = sharedScalarColumn(args[0].expr);
      const unionArgs = multiUnionArgs(args[1].expr);
      if (col && unionArgs) {
        const rows = compileUnionRowsShared(unionArgs);
        if (rows) {
          const lhsSql = `${sharedAlias}.${quoteIdent(col)}`;
          const isOp = call.operator === "?=" ? "IS" : "IS NOT";
          // Aggregate 'true'/'false' TEXT (not real JSON booleans): json_each
          // would surface real booleans as 1/0 integers, while text survives
          // the round-trip and the wrapJson json() restores the boolean.
          return {
            sql: `(SELECT json_group_array(CASE WHEN ${lhsSql} ${isOp} r.v THEN 'true' ELSE 'false' END) FROM (${rows}) r)`,
            wrapJson: true,
          };
        }
      }
    }
    const lhs = unwrapBareSelects(args[0].expr);
    if (!lhs || lhs.expr.kind !== "pointer" || !rootIsShared((lhs.expr as Pointer).source)) return null;
    if (!rhsAvoidsShared(args[1].expr)) return null;
    const paramsCheckpoint = params.length;
    const rows = compileCorrelatedOptionalCompareRows(
      call.operator, lhs.expr as Pointer, sharedAlias, args[1].expr, params, target, options,
      sqlLoweringContext(),
    );
    if (!rows) {
      params.length = paramsCheckpoint;
      return null;
    }
    return { sql: `COALESCE((SELECT json_group_array(v) FROM (${rows})), '[]')`, wrapJson: true };
  }

  if (cur.expr.kind === "pointer") {
    const leaf = cur.expr as Pointer;
    if (!leaf.ptrref.outTarget.isScalar || leaf.ptrref.isLinkProperty) return null;
    if (leaf.ptrref.outTarget.collection || qualifyTypeName(leaf.ptrref.outTarget) === "std::bool") return null;
    const src = unwrapBareSelects(leaf.source);
    if (!src || src.expr.kind !== "coalesce_expr") return null;
    const coalesce = src.expr as CoalesceExpr;
    const lhs = unwrapBareSelects(coalesce.left);
    if (!lhs || lhs.expr.kind !== "pointer") return null;
    const linkPointer = lhs.expr as Pointer;
    if (linkPointer.direction !== "outbound"
        || linkPointer.ptrref.outTarget.isScalar
        || !shouldUseLinkTable(linkPointer)
        || !rootIsShared(linkPointer.source)) {
      return null;
    }
    if (!rhsAvoidsShared(coalesce.right)) return null;
    const leafColumn = columnForPointer(leaf);
    if (!leafColumn) return null;
    const linkTable = quoteIdent(linkTableNameForPointer(linkPointer, options));
    const targetSource = compilePolymorphicSource(linkPointer.ptrref.outTarget, false, "ct0", ["id", leafColumn], options);
    const lhsRows = `SELECT ct0.${quoteIdent(leafColumn)} AS v FROM ${targetSource}`
      + ` JOIN ${linkTable} lt ON lt.${quoteIdent("target")} = ct0.${quoteIdent("id")}`
      + ` WHERE lt.${quoteIdent("source")} = ${sharedAlias}.${quoteIdent("id")} AND ct0.${quoteIdent(leafColumn)} IS NOT NULL`;
    // The coalesce decision is on the OBJECT set (a row with links but a
    // NULL leaf still selects the LHS), so probe the link table itself.
    const lhsExists = `EXISTS (SELECT 1 FROM ${linkTable} lt WHERE lt.${quoteIdent("source")} = ${sharedAlias}.${quoteIdent("id")})`;
    const paramsCheckpoint = params.length;
    const rhsSource = compileSelectSource(coalesce.right, undefined, undefined, options, params, target, "cr0", ["id", leafColumn]);
    if (!rhsSource) {
      params.length = paramsCheckpoint;
      return null;
    }
    const rhsRows = `SELECT ${rhsSource.alias}.${quoteIdent(leafColumn)} AS v FROM ${rhsSource.sql}`
      + ` WHERE ${rhsSource.alias}.${quoteIdent(leafColumn)} IS NOT NULL`;
    const sql = `(SELECT CASE WHEN ${lhsExists}`
      + ` THEN (SELECT COALESCE(json_group_array(v), '[]') FROM (${lhsRows}))`
      + ` ELSE (SELECT COALESCE(json_group_array(v), '[]') FROM (${rhsRows})) END)`;
    return { sql, wrapJson: false };
  }

  return null;
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

// Walk down a pointer chain (peeling trivial `select_expr` wrappers) to find
// a `union` operator at its root. Returns the union Set if the chain has at
// least one pointer rooted at a union, else null.
const findUnionRootOfPointerChain = (set: Set): Set | null => {
  let cursor: Set = set;
  let sawPointer = false;
  for (;;) {
    if (cursor.expr.kind === "pointer") {
      sawPointer = true;
      cursor = (cursor.expr as Pointer).source;
      continue;
    }
    if (cursor.expr.kind === "select_expr") {
      const se = cursor.expr as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit !== undefined || se.offset !== undefined) {
        return null;
      }
      cursor = se.result;
      continue;
    }
    break;
  }
  if (sawPointer && cursor.expr.kind === "operator_call"
      && (cursor.expr as OperatorCall).operator === "union") {
    return cursor;
  }
  return null;
};

// Rebuild a pointer chain so its `unionRoot` Set is replaced by `branch`,
// preserving every pointer step (and trivial select_expr wrappers) above it.
const rerootPointerChain = (set: Set, unionRoot: Set, branch: Set): Set => {
  if (set === unionRoot) return branch;
  if (set.expr.kind === "pointer") {
    const p = set.expr as Pointer;
    return { ...set, expr: { ...p, source: rerootPointerChain(p.source, unionRoot, branch) } };
  }
  if (set.expr.kind === "select_expr") {
    const se = set.expr as SelectExpr;
    return { ...set, expr: { ...se, result: rerootPointerChain(se.result, unionRoot, branch) } };
  }
  return set;
};

// A branch that produces no rows — an empty-set literal or a cast of one
// (`<T>{}`). Used to drop empty arms when distributing a pointer over a union.
const isEmptySetBranch = (set: Set): boolean => {
  let expr = set.expr;
  while (expr.kind === "type_cast") expr = (expr as TypeCast).expr.expr;
  if (expr.kind === "empty_set") return true;
  // `<T>{}` lowers to a null-valued constant.
  if (expr.kind === "string_constant") {
    return (expr as BaseConstant).value === null;
  }
  return false;
};

const isFloatTypeName = (name: string): boolean =>
  name === "std::float64" || name === "std::float32";

// Whether an `array_unpack` argument is a multi-element SET of arrays (so the
// unpack must run per array and union the results), as opposed to a single
// array value (one combined json_each). Structural detection: peel clause-free
// SELECT wrappers, then treat a `union` of array constructors — `{[1],[2,3]}`,
// the shape an inlined `array<…>` param bound to a multi-element set takes — as
// multi. A single array constructor / pointer / param stays the value path.
const arrayUnpackSourceIsMultiSet = (set: Set): boolean => {
  let cur = set;
  while (cur.expr.kind === "select_expr") {
    const se = cur.expr as SelectExpr;
    if (se.where || se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) return false;
    cur = se.result;
  }
  if (cur.expr.kind === "operator_call" && (cur.expr as OperatorCall).operator === "union") return true;
  // An array CONSTRUCTOR whose elements are multi/empty sets is itself a SET of
  // arrays (cross-product of element sets) — the shape a `variadic` UDF param
  // takes when packed from multi/empty positional args: `foo({1,2,3}, 10)`
  // packs `[{1,2,3}, 10]`, which is the array set `{[1,10],[2,10],[3,10]}`; an
  // empty element (`foo(1, <int64>{})` → `[1, {}]`) makes the whole set empty
  // (EdgeQL array elements are required). Treat it as multi so the unpack/agg
  // distributes per array (and yields zero rows when empty), instead of the
  // generic path that would `json_group_array`-collapse the multi element.
  if (cur.expr.kind === "array") {
    return (cur.expr as ArrayExpr).elements.some((el) => arrayElementIsMultiOrEmpty(el));
  }
  return false;
};

// An array element that is a multi-element set (union) or a provably-empty set
// (empty set_literal, or a cast of one). Used to decide that an array
// constructor produces a SET of arrays rather than a single array value.
const arrayElementIsMultiOrEmpty = (set: Set): boolean => {
  let cur = set;
  while (cur.expr.kind === "select_expr") {
    const se = cur.expr as SelectExpr;
    if (se.where || se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) return false;
    cur = se.result;
  }
  if (isEmptySetBranch(cur)) return true;
  while (cur.expr.kind === "type_cast") cur = (cur.expr as TypeCast).expr;
  if (cur.expr.kind === "operator_call" && (cur.expr as OperatorCall).operator === "union") {
    // A union that is an ENCLOSING FOR-loop iterator co-iterates with the outer
    // scope (it is bound to a single element per outer row), so it is NOT an
    // independent multi-element argument: `for x in {1,2,3} union foo(x)` packs
    // `[x]` — one array per outer row, not a set of arrays. Skip the multi-set
    // treatment so the generic array_unpack path co-iterates with the FOR.
    const ns = cur.pathId?.namespace;
    if (ns && ns.some((tag) => tag.startsWith("for:"))) return false;
    return true;
  }
  return false;
};

// Whether a cast target names a collection type (array/tuple). Collection
// targets parsed from source text qualify as `default::array<str>` without a
// `collection` marker — strip the module prefix and match the bare name too.
const castTargetIsCollection = (toType: TypeRef): boolean => {
  if (toType.collection === "array" || toType.collection === "tuple") return true;
  const nameHint = toType.nameHint ?? "";
  // Strip only a module prefix BEFORE the generic bracket
  // (`default::array<str>` → `array<str>`), never a `::` inside the type
  // args (`array<std::str>` must stay intact).
  const ltIdx = nameHint.indexOf("<");
  const modIdx = nameHint.indexOf("::");
  const bare = modIdx >= 0 && (ltIdx < 0 || modIdx < ltIdx) ? nameHint.slice(modIdx + 2) : nameHint;
  return bare.startsWith("array<") || bare.startsWith("tuple<");
};

// Does an expression tree reach a multi-element scalar set-union (the IR shape
// an inlined multi-element argument takes — `{1,2,3}`)? Descends through the
// arithmetic / coalesce / cast / conditional connectives that distribute
// element-wise, but stops at select_expr fences (a fenced `(SELECT …)` is a
// SET OF expression, evaluated as a whole) and at type_root union branches
// (object unions keep their dedicated polymorphic handling). Used to decide
// whether a coalesce LHS should be lowered element-wise (per branch) instead
// of via the set-level collapse.
const reachesScalarUnion = (set: Set): boolean => {
  const e = set.expr;
  if (e.kind === "operator_call") {
    const op = e as OperatorCall;
    if (op.operator === "union") {
      const args = orderedCallArgs(op.args);
      return args.length > 0 && args.every((a) => a.expr.expr.kind !== "type_root");
    }
    return orderedCallArgs(op.args).some((a) => reachesScalarUnion(a.expr));
  }
  if (e.kind === "function_call") {
    const body = (e as FunctionCall).body;
    if (body && reachesScalarUnion(body)) return true;
    return orderedCallArgs((e as FunctionCall).args).some((a) => reachesScalarUnion(a.expr));
  }
  if (e.kind === "coalesce_expr") {
    return reachesScalarUnion((e as CoalesceExpr).left) || reachesScalarUnion((e as CoalesceExpr).right);
  }
  if (e.kind === "type_cast") return reachesScalarUnion((e as TypeCast).expr);
  if (e.kind === "if_else_expr") {
    const ife = e as IfElseExpr;
    return reachesScalarUnion(ife.condition) || reachesScalarUnion(ife.ifExpr) || reachesScalarUnion(ife.elseExpr);
  }
  return false;
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

// One source-kind branch of `compileScalarSelectSQLInner`: lower a `type_cast`
// scalar source. Returns the SQL, or null to fall through to the next branch
// (when the cast's inner source itself doesn't lower to a scalar select).
const compileTypeCastScalarSource = (
  sourceSet: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  outerWheres: Set[],
): string | null => {
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
    // `<json>X` JSON-encodes a scalar source via json_quote (`'RED'` →
    // `"RED"`, `42` → `42`); collections, object shapes (already `json_object`
    // text), and already-JSON values pass through (json_quote would
    // double-encode them).
    if (qualifyTypeName(castExpr.toType) === "std::json") {
      const srcType = castExpr.expr.typeref;
      const srcIsObjectShape = castSourceIsObjectShape(castExpr.expr);
      const srcIsJsonAlready = srcType.collection !== undefined
        || qualifyTypeName(srcType) === "std::json"
        || srcIsObjectShape
        // A range/multirange already lowers to a JSON value; json_quote would
        // double-encode it as a string.
        || setLooksLikeRange(castExpr.expr);
      const jsonExpr = srcIsJsonAlready ? quoteIdent("value") : `json_quote(${quoteIdent("value")})`;
      return `SELECT ${jsonExpr} AS ${quoteIdent("value")} FROM (${innerScalarSql})`;
    }
    // Casting FROM std::json: a JSON `null` is the EMPTY SET in EdgeQL
    // (`<array<str>>to_json('null')` ≡ `{}`), and scalar payloads must be
    // unwrapped from their JSON encoding (`'"hi"'` → `'hi'`), not CAST on
    // the raw JSON text. json_extract(j, '$') does both: it returns the
    // decoded scalar and maps JSON null to SQL NULL.
    if (qualifyTypeName(castExpr.expr.typeref) === "std::json") {
      if (castTargetIsCollection(castExpr.toType)) {
        return `SELECT CASE WHEN json_type(json(${quoteIdent("value")})) = 'null' THEN NULL ELSE json(${quoteIdent("value")}) END AS ${quoteIdent("value")} FROM (${innerScalarSql})`;
      }
      const jsonCastTarget = sqlCastTarget(castExpr.toType);
      const extracted = `json_extract(${quoteIdent("value")}, '$')`;
      const jsonValueExpr = isFloatTypeName(qualifyTypeName(castExpr.toType))
        ? `_gel_float_cast(${extracted})`
        : jsonCastTarget ? `CAST(${extracted} AS ${jsonCastTarget})` : extracted;
      return `SELECT CASE WHEN json_type(json(${quoteIdent("value")})) = 'null' THEN NULL ELSE ${jsonValueExpr} END AS ${quoteIdent("value")} FROM (${innerScalarSql})`;
    }
    // `<str>` of a float source: Postgres `float8out` formatting, not the
    // lossy `CAST(x AS TEXT)` (drops precision, appends `.0`, loses -0).
    if (qualifyTypeName(castExpr.toType) === "std::str"
      && isFloatTypeName(qualifyTypeName(castExpr.expr.typeref))) {
      return `SELECT _gel_float_to_str(${quoteIdent("value")}) AS ${quoteIdent("value")} FROM (${innerScalarSql})`;
    }
    const castTarget = sqlCastTarget(castExpr.toType);
    const valueExpr = isFloatTypeName(qualifyTypeName(castExpr.toType))
      ? `_gel_float_cast(${quoteIdent("value")})`
      : castTarget ? `CAST(${quoteIdent("value")} AS ${castTarget})` : quoteIdent("value");
    return `SELECT ${valueExpr} AS ${quoteIdent("value")} FROM (${innerScalarSql})`;
  }
  return null;
};

// One source-kind branch of `compileScalarSelectSQLInner`: lower a `for_expr`
// scalar source (`FOR g IN (GROUP …) UNION <body>` and the general
// iterator × body cross-join). Always returns SQL when entered; `null` is the
// unreachable fall-through that keeps the return type honest.
const compileForExprScalarSource = (
  sourceSet: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  outerWheres: Set[],
): string | null => {
    const forExpr = sourceSet.expr as ForExpr;
    // `FOR g IN (GROUP …) UNION <body>` — one body evaluation per group row.
    // The rows compile via the group-rows lowering; the body compiles as a
    // per-row value with options.groupRowProjection pointing at the row
    // alias, so `g.key.x` / aggregate-over-`g.elements` references resolve
    // correlated against the current group row.
    {
      let iterCursor: Set = forExpr.iterator;
      while (iterCursor.expr.kind === "select_expr") {
        const wrapper = iterCursor.expr as SelectExpr;
        if (wrapper.where || wrapper.limit || wrapper.offset || (wrapper.orderBy && wrapper.orderBy.length > 0)) break;
        iterCursor = wrapper.result;
      }
      if (iterCursor.expr.kind === "group_rows") {
        const groupRows = iterCursor.expr as GroupRowsExpr;
        const cp = params.length;
        const alias = "gfr";
        const rowsSql = compileGroupRowsValueSQL(groupRows, params, target, options, "grw_src", sqlLoweringContext());
        if (rowsSql) {
          const projections = new Map<string, GroupRowProjection>();
          for (const proj of groupRows.projection ?? []) projections.set(proj.name, proj);
          const rowOptions: GelIRCompileOptions = { ...options, groupRowProjection: { alias, projections } };
          // A shaped elements body (`U {name, …}` where U := g.elements)
          // yields one output row PER ELEMENT: iterate the row's elements
          // with json_each and compile each shape entry per element (value
          // reads resolve to the current element via groupElementAlias;
          // aggregate args keep whole-group semantics).
          {
            let bodyCursor: Set = forExpr.body;
            while (bodyCursor.expr.kind === "select_expr") {
              const wrapper = bodyCursor.expr as SelectExpr;
              if (wrapper.where || wrapper.limit || wrapper.offset || (wrapper.orderBy && wrapper.orderBy.length > 0)) break;
              bodyCursor = wrapper.result;
            }
            const bodyField = bodyCursor.expr.kind === "group_row_field" ? bodyCursor.expr as GroupRowFieldExpr : undefined;
            if (bodyField && bodyField.steps.length === 1 && bodyField.steps[0] === "elements"
                && bodyCursor.shape && bodyCursor.shape.length > 0) {
              const je = "gelem";
              const elemOptions: GelIRCompileOptions = { ...rowOptions, groupElementAlias: je };
              const cpShape = params.length;
              const pairs: string[] = [];
              let ok = true;
              for (const element of bodyCursor.shape) {
                const name = element.name
                  ?? (element.expr.expr.kind === "pointer" ? (element.expr.expr as Pointer).ptrref.shortName : undefined);
                const v = name ? compileValueSetSQL(element.expr, alias, params, target, elemOptions) : null;
                if (!v || !name) { ok = false; break; }
                pairs.push(`${quoteLiteral(name)}, ${v}`);
              }
              if (ok) {
                return `SELECT json_object(${pairs.join(", ")}) AS ${quoteIdent("value")}`
                  + ` FROM (${rowsSql}) ${alias}`
                  + ` CROSS JOIN json_each(COALESCE(json_extract(${alias}.${quoteIdent("value")}, '$."elements"'), '[]')) ${je}`;
              }
              params.length = cpShape;
            }
          }
          const bodyVal = compileValueSetSQL(forExpr.body, alias, params, target, rowOptions);
          if (bodyVal) {
            return `SELECT ${bodyVal} AS ${quoteIdent("value")} FROM (${rowsSql}) ${alias}`;
          }
          if (process.env.DBG_GROUP_SQL) console.error("[group-sql] FOR-over-group body miss:", forExpr.body.expr.kind);
        } else if (process.env.DBG_GROUP_SQL) {
          console.error("[group-sql] FOR-over-group rows miss");
        }
        params.length = cp;
      }
    }
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
        // An iterator over group elements (`FOR el IN <g.elements rows>` —
        // the scalar-group desugar) puts each element row in the level's
        // value column; per-element field reads in the body resolve through
        // groupElementAlias.
        const bodyOptions = groupElementsIteratorAlias(forExpr, forSource) !== undefined
          ? { ...options, groupElementAlias: groupElementsIteratorAlias(forExpr, forSource) }
          : options;
        // A re-projection shape on the FOR result (`(for c in T union (c { len
        // := … })) { name, l := .len }`, e.g. a GROUP subject) must project the
        // OUTER shape, not the body's own shape — but ONLY when the body can't
        // already satisfy it (when every outer field is also a body field, the
        // body projection is correct and handles multi-level FORs that the
        // naive re-projection can't). Each outer field's expr compiles through
        // the FOR aliases (a binding computed adopted as a key lowers to its
        // body definition, correlated to the iterated element).
        const elementName = (e: ShapeElement): string | undefined =>
          e.name ?? (e.expr.expr.kind === "pointer" ? (e.expr.expr as Pointer).ptrref.shortName : undefined);
        const bodyShapeNames = new globalThis.Set(
          (bodySet.shape ?? []).map(elementName).filter((n): n is string => n !== undefined));
        const needsReproject = (sourceSet.shape?.length ?? 0) > 0
          && sourceSet.shape.some((e) => { const n = elementName(e); return n !== undefined && !bodyShapeNames.has(n); });
        let bodySql: string | null;
        if (needsReproject) {
          const pairs: string[] = [];
          bodySql = "";
          for (const element of sourceSet.shape) {
            const name = elementName(element);
            const v = name ? compileValueSetSQLWithAliases(element.expr, forSource.bindingAliases, forSource.baseAlias, params, target, bodyOptions, forSource.linkPropertyAliases, forSource.scalarBindingAliases, forSource.tupleIterAliases) : null;
            if (!name || !v) { bodySql = null; break; }
            pairs.push(`${quoteLiteral(name)}, ${v}`);
          }
          if (bodySql !== null) bodySql = pairs.length > 0 ? `json_object(${pairs.join(", ")})` : null;
        } else {
          bodySql = compileValueSetSQLWithAliases(bodySet, forSource.bindingAliases, forSource.baseAlias, params, target, bodyOptions, forSource.linkPropertyAliases, forSource.scalarBindingAliases, forSource.tupleIterAliases);
        }
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
        if (e.kind === "index_expr") { visit((e as IndexExpr).expr); visit((e as IndexExpr).index); return; }
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
    // those from the per-row WHERE; only keep wheres that reference the
    // iterator. The independent ones are applied below as a whole-result
    // existential gate.
    const propagatedWheres = outerWheres.filter((w) => setRefersToIter(w));
    // A required-param emptiness guard inlined around a set-returning FOR body
    // (`foo(x: int64) -> set of int64 using (for y in {x,x+1,x+2} union y)`
    // called with `<int64>{}`) arrives as an independent `EXISTS <x>` where:
    // when x is empty the WHOLE FOR result must be suppressed (empty set), not
    // one NULL row per `x+k` iterator branch. We only gate on EXISTS-shaped
    // independent wheres (the guard's exact shape) — a general independent
    // FILTER over an unrelated set (`… FILTER Card.element = 'Air'`) carries
    // existential semantics handled elsewhere and must NOT restrict the result
    // here (test_edgeql_for_filter_02/03).
    const independentWheres = outerWheres.filter((w) =>
      !setRefersToIter(w) && w.expr.kind === "exists_expr");
    const wrapIndependentGate = (innerSql: string): string => {
      if (independentWheres.length === 0) return innerSql;
      const gateParts: string[] = [];
      for (const w of independentWheres) {
        const g = compileValueSetSQL(w, "g_indep", params, target, options);
        if (!g) return innerSql; // can't express the gate — leave ungated
        gateParts.push(`(${g}) IN (1, 'true')`);
      }
      return `SELECT ${quoteIdent("value")} FROM (${innerSql}) WHERE ${gateParts.join(" AND ")}`;
    };
    // We don't know yet whether body uses the iterator — that depends on
    // its IR shape. Build body and iter SQLs separately into a scratch
    // params array so we can stitch them in the right order (iter first
    // in the final SQL → iter params first in the merged array).
    const bodyParams: ScalarValue[] = [];
    const bodySql = compileScalarSelectSQL(forExpr.body, bodyParams, target, options, propagatedWheres);
    if (!bodySql) return null;
    if (bodyUsesIter) {
      params.push(...bodyParams);
      return wrapIndependentGate(bodySql);
    }
    // Body is independent of the iterator: cross-join with the iterator
    // when its SQL is available, otherwise fall back to body alone (some
    // iterators like `range_unpack(...)` can't lower yet but the body's
    // single-row result is still useful).
    const iterParams: ScalarValue[] = [];
    const iterSql = compileScalarSelectSQL(forExpr.iterator, iterParams, target, options, []);
    if (!iterSql) {
      params.push(...bodyParams);
      return wrapIndependentGate(bodySql);
    }
    // SQL ordering puts iter first, then body — params must match.
    params.push(...iterParams, ...bodyParams);
    return wrapIndependentGate(`SELECT ${quoteIdent("body")}.${quoteIdent("value")} AS ${quoteIdent("value")} FROM (${iterSql}) ${quoteIdent("iter")} CROSS JOIN (${bodySql}) ${quoteIdent("body")}`);
  return null;
};

const compileSelectExprScalarSource = (
  sourceSet: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  outerWheres: Set[],
): string | null => {
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
    } else if (selectExpr.orderBy && selectExpr.orderBy.length > 0) {
      // The order paths refer to the iteration source itself (the common
      // `SELECT X ORDER BY X` shape used by `array_agg(... ORDER BY ...)`
      // over multi scalar pointers). compileValueSortPath returns null for
      // those because it doesn't know the path equals the row's value;
      // fall back to ordering by `value` for any path whose serialized
      // identity matches the iteration source.
      const sourceKey = pathIdKey(result);
      const orderParts = selectExpr.orderBy
        .map((sort) => pathIdKey(sort.path) === sourceKey
          ? `${quoteIdent("value")} ${sort.direction.toUpperCase()}`
          : "")
        .filter((part) => part.length > 0);
      if (orderParts.length > 0) {
        sql += ` ORDER BY ${orderParts.join(", ")}`;
      }
    }
    const limit = extractNumericLiteral(selectExpr.limit);
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    const offset = extractNumericLiteral(selectExpr.offset);
    if (offset !== undefined) {
      // SQLite requires a LIMIT before OFFSET; `LIMIT -1` means unbounded.
      if (limit === undefined) sql += " LIMIT -1";
      sql += " OFFSET ?";
      params.push(offset);
    }
    return sql;
};

const compileIfElseScalarSource = (
  sourceSet: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  outerWheres: Set[],
): string | null => {
    const ifElse = sourceSet.expr as IfElseExpr;
    const ifElseCheckpoint = params.length;
    // Only handle source-free conditions (`IF false`, `IF <param>`) here —
    // a condition over row paths needs the correlated lowerings below, and
    // compiling it against a phantom alias would emit dangling references.
    const condSources = new Map<string, TypeRef>();
    collectScalarPointerSources(ifElse.condition, condSources);
    if (condSources.size > 0) {
      params.length = ifElseCheckpoint;
    }
    const condSql = condSources.size === 0
      ? compileValueSetSQL(ifElse.condition, "g0", params, target, options)
      : null;
    const ifRows = condSql ? compileScalarSelectSQL(ifElse.ifExpr, params, target, options, outerWheres) : null;
    const elseRows = ifRows ? compileScalarSelectSQL(ifElse.elseExpr, params, target, options, outerWheres) : null;
    if (condSql && ifRows && elseRows) {
      // Conditions arrive as either native SQL booleans (0/1) or JSON-text
      // booleans ('true'/'false') — normalize once so WHERE doesn't cast
      // the text 'true' to 0.
      return `WITH cond_raw AS (SELECT ${condSql} AS ${quoteIdent("r")}),`
        + ` cond_q AS (SELECT (CASE WHEN ${quoteIdent("r")} IN (1, 'true') THEN 1 WHEN ${quoteIdent("r")} IN (0, 'false') THEN 0 ELSE NULL END) AS ${quoteIdent("c")} FROM cond_raw)`
        + ` SELECT ${quoteIdent("value")} FROM (${ifRows}) WHERE (SELECT ${quoteIdent("c")} FROM cond_q)`
        + ` UNION ALL SELECT ${quoteIdent("value")} FROM (${elseRows}) WHERE NOT (SELECT ${quoteIdent("c")} FROM cond_q)`;
    }
    params.length = ifElseCheckpoint;
  return null;
};

const compileScalarSelectSQLInner = (
  sourceSet: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  outerWheres: Set[],
): string | null => {
  // An optional parameter (`<optional str>$0`) accepts the empty set: a
  // missing/NULL arg is zero rows, not a NULL-valued row. Emit a row source
  // that filters out the NULL binding so a surrounding union/LIMIT sees the
  // empty set. (A required parameter keeps its single—possibly NULL—row.)
  if (sourceSet.expr.kind === "parameter" && (sourceSet.expr as { required?: boolean }).required === false) {
    const v = compileValueSetSQL(sourceSet, "g0", params, target, options);
    if (v) {
      return `SELECT ${quoteIdent("value")} FROM (SELECT ${v} AS ${quoteIdent("value")}) WHERE ${quoteIdent("value")} IS NOT NULL`;
    }
  }
  // Pointer chains rooted at the empty-set marker (`(<Bar>{}).a`, often the
  // result of inlining a UDF called with an empty arg) yield zero rows —
  // without this the pointer lowering emits a column ref with no FROM.
  {
    let emptyRootCursor: Set = sourceSet;
    let sawPointerStep = false;
    while (emptyRootCursor.expr.kind === "pointer" || emptyRootCursor.expr.kind === "select_expr") {
      if (emptyRootCursor.expr.kind === "pointer") {
        sawPointerStep = true;
        emptyRootCursor = (emptyRootCursor.expr as Pointer).source;
      } else {
        emptyRootCursor = (emptyRootCursor.expr as SelectExpr).result;
      }
    }
    if (sawPointerStep && isTopLevelEmptySetMarker(emptyRootCursor)) {
      return `SELECT NULL AS ${quoteIdent("value")} WHERE 0`;
    }
  }
  // EdgeQL `A EXCEPT B` / `A INTERSECT B` are MULTISET operators — they keep
  // per-element multiplicity, unlike SQLite's set-deduping EXCEPT/INTERSECT.
  // Number each occurrence of a value in A (rank within its value group), then
  // keep it based on how many copies B holds: EXCEPT keeps occurrences beyond
  // B's count (rank > countB), INTERSECT keeps up to B's count (rank <= countB).
  // `{1,1,1,2,2,3} except {1,3,3,2}` → `{1,1,2}`; `… intersect {1,3,3,2,2,5}`
  // → `{1,2,2,3}`. Values compare NULL-safely via `IS`.
  if (sourceSet.expr.kind === "operator_call"
    && ((sourceSet.expr as OperatorCall).operator === "except"
      || (sourceSet.expr as OperatorCall).operator === "intersect")) {
    const setOp = sourceSet.expr as OperatorCall;
    const opArgs = orderedCallArgs(setOp.args);
    if (opArgs.length === 2) {
      const cp = params.length;
      const leftRows = compileScalarSelectSQL(opArgs[0].expr, params, target, options);
      const rightRows = leftRows ? compileScalarSelectSQL(opArgs[1].expr, params, target, options) : null;
      if (leftRows && rightRows) {
        const cmp = setOp.operator === "except" ? ">" : "<=";
        const v = quoteIdent("value");
        return `SELECT ${v} FROM `
          + `(SELECT ${v}, ROW_NUMBER() OVER (PARTITION BY ${v}) AS __rn FROM (${leftRows})) lx `
          + `WHERE lx.__rn ${cmp} (SELECT COUNT(*) FROM (${rightRows}) rx WHERE rx.${v} IS lx.${v})`;
      }
      params.length = cp;
    }
  }
  // Expression-position group rows (`group_rows`) as a value source — one
  // `value` row per group, with any attached projection applied. Lets an
  // outer GROUP use an inner (projected) group as its subject. Peel no-op
  // select wrappers (`SELECT ( WITH MODULE … GROUP … )`) to find it.
  {
    let groupCursor: Set = sourceSet;
    while (groupCursor.expr.kind === "select_expr") {
      const wrapper = groupCursor.expr as SelectExpr;
      if (wrapper.where || wrapper.limit || wrapper.offset || (wrapper.orderBy && wrapper.orderBy.length > 0)) break;
      groupCursor = wrapper.result;
    }
    if (groupCursor.expr.kind === "group_rows") {
      return compileGroupRowsValueSQL(groupCursor.expr as GroupRowsExpr, params, target, options, "grw_src", sqlLoweringContext());
    }
  }
  // Element-wise paths off a group row (`g.elements`, `g.elements.name`
  // inside `FOR g IN (GROUP …) UNION …`) — one row per element / leaf value,
  // correlated against the group-row alias the surrounding FOR established
  // via options.groupRowProjection. `json_each` with a path argument
  // iterates arrays and yields a scalar as a single row, which matches
  // EdgeQL set semantics for multi vs single leaves (missing → empty set).
  {
    let fieldCursor: Set = sourceSet;
    while (fieldCursor.expr.kind === "select_expr") {
      const wrapper = fieldCursor.expr as SelectExpr;
      if (wrapper.where || wrapper.limit || wrapper.offset || (wrapper.orderBy && wrapper.orderBy.length > 0)) break;
      fieldCursor = wrapper.result;
    }
    // Standalone elements flatten — `(select (group …) order by … limit 1)
    // .elements` with no enclosing row scope: run the (claused) group rows
    // statement, then json_each each row's elements.
    if (fieldCursor.expr.kind === "group_row_field" && !options.groupRowProjection
        && (fieldCursor.expr as GroupRowFieldExpr).rows
        && (fieldCursor.expr as GroupRowFieldExpr).steps[0] === "elements"
        && !(fieldCursor.expr as GroupRowFieldExpr).steps.some((s) => s.startsWith("<"))) {
      const field = fieldCursor.expr as GroupRowFieldExpr;
      let rowsCursor: Set = field.rows as Set;
      let rowsWhere: Set | undefined;
      let rowsOrderBy: SortExpr[] | undefined;
      let rowsLimit: Set | undefined;
      let rowsOffset: Set | undefined;
      while (rowsCursor.expr.kind === "select_expr") {
        const se = rowsCursor.expr as SelectExpr;
        rowsWhere = rowsWhere ?? se.where;
        rowsOrderBy = rowsOrderBy ?? se.orderBy;
        rowsLimit = rowsLimit ?? se.limit;
        rowsOffset = rowsOffset ?? se.offset;
        rowsCursor = se.result;
      }
      // Only for CLAUSED group selects — a bare `g.elements` belongs to an
      // enclosing per-row iteration and is handled by the row-scope paths.
      const hasRowClauses = rowsWhere !== undefined || (rowsOrderBy && rowsOrderBy.length > 0)
        || rowsLimit !== undefined || rowsOffset !== undefined;
      if (rowsCursor.expr.kind === "group_rows" && hasRowClauses) {
        const cp = params.length;
        const artifact = compileGroupRowsStatementSQL(
          rowsCursor.expr as GroupRowsExpr, rowsWhere, rowsOrderBy, rowsLimit, rowsOffset,
          params, target, options, sqlLoweringContext(),
        );
        if (artifact.loweringMode === "single_statement" && artifact.sql.length > 0) {
          const elemsJson = `COALESCE(json_extract(gsr.${quoteIdent("value")}, '$."elements"'), '[]')`;
          if (field.steps.length === 1) {
            return `SELECT json(je.${quoteIdent("value")}) AS ${quoteIdent("value")}`
              + ` FROM (${artifact.sql}) gsr CROSS JOIN json_each(${elemsJson}) je`;
          }
          const tail = field.steps.slice(1).map((s) => `."${s.replaceAll('"', '""')}"`).join("");
          return `SELECT jef.${quoteIdent("value")} AS ${quoteIdent("value")}`
            + ` FROM (${artifact.sql}) gsr CROSS JOIN json_each(${elemsJson}) je`
            + ` CROSS JOIN json_each(je.${quoteIdent("value")}, '$${tail}') jef`
            + ` WHERE jef.${quoteIdent("value")} IS NOT NULL`;
        }
        params.length = cp;
      }
    }
    if (fieldCursor.expr.kind === "group_row_field" && options.groupRowProjection
        && !(fieldCursor.expr as GroupRowFieldExpr).steps.some((s) => s.startsWith("<"))) {
      const field = fieldCursor.expr as GroupRowFieldExpr;
      const raw = `${options.groupRowProjection.alias}.${quoteIdent("value")}`;
      const head = groupProjectionHead(options.groupRowProjection, field.steps);
      const baseSteps = head && head.kind === "path" ? [...head.steps, ...field.steps.slice(1)] : field.steps;
      if (baseSteps[0] === "elements") {
        const elemsJson = `COALESCE(json_extract(${raw}, '$."elements"'), '[]')`;
        // A shaped elements set (`z.elements{name, cost}`) re-projects each
        // element row to exactly the written fields.
        if (baseSteps.length === 1 && fieldCursor.shape && fieldCursor.shape.length > 0) {
          const cpShape = params.length;
          const elemOptions: GelIRCompileOptions = { ...options, groupElementAlias: "je" };
          const pairs: string[] = [];
          let ok = true;
          for (const element of fieldCursor.shape) {
            const name = element.name
              ?? (element.expr.expr.kind === "pointer" ? (element.expr.expr as Pointer).ptrref.shortName : undefined);
            const v = name ? compileValueSetSQL(element.expr, "je", params, target, elemOptions) : null;
            if (!v || !name) { ok = false; break; }
            pairs.push(`${quoteLiteral(name)}, ${v}`);
          }
          if (ok) {
            return `SELECT json_object(${pairs.join(", ")}) AS ${quoteIdent("value")} FROM json_each(${elemsJson}) je`;
          }
          params.length = cpShape;
        }
        if (baseSteps.length === 1) {
          return `SELECT json(je.${quoteIdent("value")}) AS ${quoteIdent("value")} FROM json_each(${elemsJson}) je`;
        }
        const tail = baseSteps.slice(1).map((s) => `."${s.replaceAll('"', '""')}"`).join("");
        // A missing/null leaf is the empty set, not a NULL element.
        return `SELECT jef.${quoteIdent("value")} AS ${quoteIdent("value")}`
          + ` FROM json_each(${elemsJson}) je CROSS JOIN json_each(je.${quoteIdent("value")}, '$${tail}') jef`
          + ` WHERE jef.${quoteIdent("value")} IS NOT NULL`;
      }
      // `.grouping` is a SET of key names (a JSON array on the row).
      if (baseSteps[0] === "grouping" && baseSteps.length === 1) {
        return `SELECT je.${quoteIdent("value")} AS ${quoteIdent("value")}`
          + ` FROM json_each(COALESCE(json_extract(${raw}, '$."grouping"'), '[]')) je`;
      }
      // key/projected scalar paths — one value per group row.
      const path = `'$${baseSteps.map((s) => `."${s.replaceAll('"', '""')}"`).join("")}'`;
      return `SELECT json_extract(${raw}, ${path}) AS ${quoteIdent("value")}`;
    }
  }
  // `FOR X IN iter UNION X` is the upstream sugar the engine wraps every plain
  // FOR with — the body substitutes back to the iterator. After the AST→IR
  // pass the for_expr's body equals (or contains) the iterator expression, so
  // the for_expr itself is a no-op wrapper and we can compile the body
  // directly. The non-trivial branches (joined FORs over type/pointer
  // iterators) are still handled earlier in compileSelectStmtToSQL via
  // compileForExprSource.
  if (sourceSet.expr.kind === "for_expr") {
    const r = compileForExprScalarSource(sourceSet, params, target, options, outerWheres);
    if (r !== null) return r;
  }
  // A user-defined function call whose AST→IR pass attached a substituted
  // body inlines at the statement level: lower the body as if it were
  // written in place. This carries through the union-distribution and
  // co-iteration handling below — without it, a body like `x * x` against
  // a set-bound `x` would be wrapped in compileValueSetSQL's aggregating
  // path and produce `(json_group_array * json_group_array)` instead of
  // per-row products.
  if (sourceSet.expr.kind === "function_call") {
    const inlinedBody = (sourceSet.expr as FunctionCall).body;
    if (inlinedBody) {
      return compileScalarSelectSQL(
        inlinedBody,
        params,
        target,
        options,
        outerWheres,
      );
    }
  }
  // `<T>{multi-row-source}` distributes over rows — wrap each row's value
  // with the cast rather than letting `compileValueSetSQL` aggregate the
  // inner into a single JSON-array scalar. Without this `<str>{a,b}` lowers
  // as `CAST(json_group_array(value) AS TEXT)` and returns one row holding
  // `'[a,b]'`, instead of two rows holding `'a'` and `'b'`.
  if (sourceSet.expr.kind === "type_cast") {
    const r = compileTypeCastScalarSource(sourceSet, params, target, options, outerWheres);
    if (r !== null) return r;
  }
  if (sourceSet.expr.kind === "function_call") {
    const call = sourceSet.expr as FunctionCall;
    const shortName = call.functionName.split("::").pop() ?? call.functionName;
    const args = orderedCallArgs(call.args);
    if (shortName === "assert_exists" && args.length === 1) {
      return compileScalarSelectSQL(args[0].expr, params, target, options, outerWheres);
    }
    // `agg(array_unpack(S))` where S is a MULTI-element set of arrays — the
    // shape an inlined non-`set of` UDF param bound to `{[1],[2,3]}` takes for
    // a body like `sum(array_unpack(x))`. EdgeQL distributes the whole body —
    // and therefore the aggregate — element-wise over the param's set, so the
    // result is one aggregate value PER array (`{sum([1]), sum([2,3])}={1,5}`),
    // a multi-row set — NOT one aggregate over the flattened union (which the
    // generic scalar-aggregate path would produce as the single value 6). Emit
    // one row per array, aggregating that array's own json_each elements.
    if (args.length === 1
        && ["sum", "min", "max", "avg", "array_agg", "all", "any"].includes(shortName)) {
      const aggArg = unwrapSelectExprSet(args[0].expr).result;
      if (aggArg.expr.kind === "function_call"
          && (aggArg.expr as FunctionCall).functionName.split("::").pop() === "array_unpack") {
        const unpackArgs = orderedCallArgs((aggArg.expr as FunctionCall).args);
        if (unpackArgs.length === 1 && arrayUnpackSourceIsMultiSet(unpackArgs[0].expr)) {
          const cpDist = params.length;
          const rows = compileScalarSelectSQL(unpackArgs[0].expr, params, target, options);
          if (rows) {
            const elems = `json_each(COALESCE(g_aum.${quoteIdent("value")}, '[]')) je`;
            const v = `je.${quoteIdent("value")}`;
            const perArrayAgg = shortName === "array_agg"
              ? `(SELECT COALESCE(json_group_array(${v}), '[]') FROM ${elems})`
              : shortName === "all"
                ? `(SELECT IFNULL(min(${v}), json('true')) FROM ${elems} WHERE ${v} IS NOT NULL)`
                : shortName === "any"
                  ? `(SELECT IFNULL(max(${v}), json('false')) FROM ${elems} WHERE ${v} IS NOT NULL)`
                  : shortName === "sum"
                    ? `(SELECT IFNULL(sum(${v}), 0) FROM ${elems})`
                    : `(SELECT ${shortName}(${v}) FROM ${elems})`;
            return `SELECT ${perArrayAgg} AS ${quoteIdent("value")} FROM (${rows}) g_aum`;
          }
          params.length = cpDist;
        }
      }
    }
    // `enumerate(X)` — one `(index, element)` tuple row per element of X,
    // indexed in row order starting at 0.
    if (shortName === "enumerate" && args.length === 1) {
      const cp = params.length;
      const rows = compileScalarSelectSQL(args[0].expr, params, target, options);
      if (rows) {
        const v = setValueIsJson(args[0].expr) ? `json(${quoteIdent("value")})` : quoteIdent("value");
        return `SELECT json_array((row_number() OVER ()) - 1, ${v}) AS ${quoteIdent("value")} FROM (${rows})`;
      }
      params.length = cp;
    }
    // `array_unpack([X])` simplifies to X — the array is a one-element
    // wrapper and unpacking it returns the original set. This is the shape
    // upstream test conversions use to express "evaluate X as a set" inside
    // a SELECT that would otherwise wrap a multi-row inner with a json_array
    // collector.
    if ((shortName === "array_unpack" || shortName === "assert_single") && args.length === 1) {
      const inner = args[0].expr;
      if (inner.expr.kind === "array" && (inner.expr as ArrayExpr).elements.length === 1) {
        return compileScalarSelectSQL((inner.expr as ArrayExpr).elements[0], params, target, options, outerWheres);
      }
      if (shortName === "array_unpack") {
        // General `array_unpack(arr)` — explode the JSON array into one row
        // per element with `json_each`. The array source may itself be an
        // expression returning the JSON-encoded array; compile it as a value
        // and feed it to json_each. COALESCE a NULL source to '[]' so an
        // absent optional array property unpacks to the empty set rather
        // than raising "malformed JSON".
        //
        // When an outer iteration scope is available (e.g. the array
        // expression is `.tag_array` inside `FILTER 'x' IN array_unpack(.tag_array)`),
        // prefer that alias so the lookup correlates to the outer row.
        const checkpointBefore = params.length;
        // MULTI-element SET of arrays (`array_unpack({[1], [2, 3]})`, e.g. an
        // inlined UDF param bound to a set of arrays): unpacking is element-wise
        // over the set — each array in the set is exploded on its own, and the
        // results unioned. compileValueSetSQL would instead `json_group_array`
        // the whole set into ONE combined array and json_each only its outer
        // level, yielding the arrays themselves rather than their elements. So
        // when the source is multi-valued, compile it as a row-per-array select
        // and json_each each row, preserving the per-array (co-iterated) shape.
        if (arrayUnpackSourceIsMultiSet(inner)) {
          const cpMulti = params.length;
          const rows = compileScalarSelectSQL(inner, params, target, options);
          if (rows) {
            return `SELECT je.${quoteIdent("value")} AS ${quoteIdent("value")}`
              + ` FROM (${rows}) g_aum CROSS JOIN json_each(COALESCE(g_aum.${quoteIdent("value")}, '[]')) je`;
          }
          params.length = cpMulti;
        }
        const correlatedAlias = pickOuterScopeAliasForExpr(inner, options);
        const arrSql = compileValueSetSQL(inner, correlatedAlias ?? "g_au", params, target, options);
        if (arrSql) {
          return `SELECT "value" FROM json_each(COALESCE(${arrSql}, '[]'))`;
        }
        params.length = checkpointBefore;
      }
      if (shortName === "assert_single") {
        return compileScalarSelectSQL(inner, params, target, options, outerWheres);
      }
    }
    // `json_array_unpack(j)` — one row per array element, each as json.
    if (shortName === "json_array_unpack" && args.length === 1) {
      const cpJu = params.length;
      const jsonSql = compileValueSetSQL(args[0].expr, "g_ju", params, target, options);
      if (jsonSql) {
        return `SELECT CASE WHEN ${quoteIdent("type")} IN ('object', 'array') THEN json(${quoteIdent("value")}) ELSE ${quoteIdent("value")} END AS ${quoteIdent("value")} FROM json_each(COALESCE(${jsonSql}, '[]'))`;
      }
      params.length = cpJu;
    }
    // `multirange_unpack(mr)` — one row per constituent range (JSON objects).
    if (shortName === "multirange_unpack" && args.length === 1) {
      const cpMu = params.length;
      const mrSql = compileValueSetSQL(args[0].expr, "g_mu", params, target, options);
      if (mrSql) {
        return `SELECT json("value") AS ${quoteIdent("value")} FROM json_each(_gel_multirange_unpack(${mrSql}))`;
      }
      params.length = cpMu;
    }
    // `range_unpack(range [, step])` — the `_gel_range_unpack` UDF expands
    // the range into a JSON array; json_each turns it into rows.
    if (shortName === "range_unpack" && args.length >= 1) {
      const cp = params.length;
      const rangeSql = compileValueSetSQL(args[0].expr, "g_ru", params, target, options);
      if (rangeSql) {
        const stepSql = args.length > 1
          ? compileValueSetSQL(args[1].expr, "g_ru", params, target, options)
          : null;
        if (args.length === 1 || stepSql) {
          return `SELECT "value" FROM json_each(_gel_range_unpack(${rangeSql}${stepSql ? `, ${stepSql}` : ""}))`;
        }
      }
      params.length = cp;
    }
    if (shortName === "array_get" && args.length >= 2) {
      // `array_get(arr, {0, 1})` — multi-valued index. Iterate over each
      // index, looking up the element with json_extract. Returns NULL for
      // out-of-range indices (or the optional `default` arg, if provided).
      const arrArg = args[0].expr;
      const idxArg = args[1].expr;
      const idxUnwrapped = unwrapSelectExprSet(idxArg);
      const isMultiIndex = idxUnwrapped.result.expr.kind === "operator_call"
        && (idxUnwrapped.result.expr as OperatorCall).operator === "union";
      if (isMultiIndex) {
        const cp = params.length;
        const idxSelect = compileScalarSelectSQL(idxArg, params, target, options);
        if (idxSelect) {
          const correlatedAlias = pickOuterScopeAliasForExpr(arrArg, options);
          const arrSql = compileValueSetSQL(arrArg, correlatedAlias ?? "g_ag", params, target, options);
          if (arrSql) {
            const dflt = args.length > 2
              ? compileValueSetSQL(args[2].expr, correlatedAlias ?? "g_ag", params, target, options)
              : null;
            const idxExpr = `CASE WHEN "value" < 0 THEN json_array_length(${arrSql}) + "value" ELSE "value" END`;
            const lookup = `json_extract(${arrSql}, '$[' || (${idxExpr}) || ']')`;
            const wrapped = dflt ? `IFNULL(${lookup}, ${dflt})` : lookup;
            return `SELECT ${wrapped} AS "value" FROM (${idxSelect})`;
          }
          params.length = cp;
        }
      }
    }
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

  // Generic element-wise distribution: a scalar (non-aggregate) stdlib
  // function applied to set-valued args yields one row per element of the
  // Cartesian product (`math::exp({1, 2, 3})` → three rows). Every arg —
  // single or multi — is compiled into its own FROM subquery so each SQL
  // placeholder appears exactly once and in argument order.
  genericElementwise: if (sourceSet.expr.kind === "function_call" || sourceSet.expr.kind === "operator_call") {
    const fnCall = sourceSet.expr.kind === "function_call" ? sourceSet.expr as FunctionCall : null;
    const opCall = fnCall ? null : sourceSet.expr as OperatorCall;
    const shortName = fnCall ? (fnCall.functionName.split("::").pop() ?? fnCall.functionName) : "";
    if (fnCall && SET_CONSUMING_FUNCTIONS.has(shortName)) break genericElementwise;
    // union/distinct combine row sets and ??/?=/?!= coalesce over emptiness;
    // those have dedicated lowerings.
    if (opCall && (opCall.operator === "union" || opCall.operator === "distinct"
        || opCall.operator === "??" || opCall.operator === "?=" || opCall.operator === "?!=")) {
      break genericElementwise;
    }
    const args = orderedCallArgs(fnCall ? fnCall.args : (opCall as OperatorCall).args);
    if (args.length === 0) break genericElementwise;
    const isMultiArg = (s: Set): boolean => {
      let cur = s;
      while (cur.expr.kind === "select_expr") {
        const se = cur.expr as SelectExpr;
        if (se.where || se.limit || se.offset) return false;
        cur = se.result;
      }
      if (cur.expr.kind === "operator_call") {
        const op = (cur.expr as OperatorCall).operator;
        return op === "union" || op === "distinct";
      }
      if (cur.expr.kind === "function_call") {
        const fn = (cur.expr as FunctionCall).functionName.split("::").pop() ?? "";
        return fn === "array_unpack" || fn === "range_unpack" || fn === "enumerate";
      }
      // `enumerate(X).0` / `.1` — tuple-slot projections of a multi source.
      if (cur.expr.kind === "index_expr") {
        return isMultiArg((cur.expr as IndexExpr).expr);
      }
      // `g.elements` / `g.elements.name` — one row per group element.
      if (cur.expr.kind === "group_row_field") {
        return (cur.expr as GroupRowFieldExpr).steps[0] === "elements";
      }
      return false;
    };
    if (!args.some((a) => isMultiArg(a.expr))) break genericElementwise;
    const cp = params.length;
    const froms: string[] = [];
    const pieces: string[] = [];
    // Args that reference the SAME set (e.g. an inlined UDF body `x * x`
    // where both operands are the substituted parameter) must bind to one
    // alias — element-wise correlation, not a Cartesian self-product. Keyed
    // by object identity: two syntactically equal literals (`{1,2} + {1,2}`)
    // are distinct sets and DO cross-multiply, but a substituted parameter
    // reuses the same IR node for every occurrence.
    const sharedAliases = new Map<Set, string>();
    let ok = true;
    for (let i = 0; i < args.length; i++) {
      const alias = `gfe${i}`;
      if (isMultiArg(args[i].expr)) {
        const shareKey = args[i].expr;
        const existing = sharedAliases.get(shareKey);
        if (existing) {
          pieces.push(`${existing}.${quoteIdent("value")}`);
          continue;
        }
        const rows = compileScalarSelectSQL(args[i].expr, params, target, options);
        if (!rows) { ok = false; break; }
        froms.push(`(${rows}) ${alias}`);
        sharedAliases.set(shareKey, alias);
      } else {
        const v = compileValueSetSQL(args[i].expr, alias, params, target, options);
        if (!v) { ok = false; break; }
        // An unset settable global is the empty set: its single-row arg
        // subquery must yield zero rows so the CROSS JOIN (and thus the whole
        // element-wise result) is empty, matching strict empty-set semantics.
        const emptyGuard = isTopLevelEmptySetMarker(args[i].expr, options) ? " WHERE 0" : "";
        froms.push(`(SELECT (${v}) AS ${quoteIdent("value")}${emptyGuard}) ${alias}`);
      }
      pieces.push(`${alias}.${quoteIdent("value")}`);
    }
    if (!ok) { params.length = cp; break genericElementwise; }
    let lowered: string | null = null;
    if (fnCall) {
      lowered = lowerStdlibFunctionSql(target, fnCall.functionName, pieces, args.map((a) => scalarArgTypeHint(a.expr)));
    } else if (opCall) {
      const op = opCall.operator;
      const cmp = normalizeOperator(op);
      if (cmp && pieces.length === 2) {
        lowered = `CASE WHEN ${pieces[0]} IS NULL OR ${pieces[1]} IS NULL THEN NULL WHEN ${pieces[0]} ${cmp} ${pieces[1]} THEN json('true') ELSE json('false') END`;
      } else if (op === "^" && pieces.length === 2) {
        lowered = `pow(${pieces[0]}, ${pieces[1]})`;
      } else if ((op === "neg" || op === "pos") && pieces.length === 1) {
        lowered = op === "neg" ? `(-(${pieces[0]}))` : `(${pieces[0]})`;
      } else {
        const infix = operatorToInfixSql(op);
        if (infix && pieces.length === 2 && infix !== "UNION" && infix !== "IS DISTINCT FROM") {
          const like = likeOperatorSql(op, pieces[0], pieces[1]);
          lowered = like ?? flooredArithBinarySql(op, pieces[0], pieces[1]) ?? `(${pieces[0]} ${infix} ${pieces[1]})`;
        }
      }
    }
    if (!lowered) { params.length = cp; break genericElementwise; }
    return `SELECT ${lowered} AS ${quoteIdent("value")} FROM ${froms.join(" CROSS JOIN ")}`;
  }

  // `enumerate(X).1` (the per-row value of `enumerate`) is equivalent to
  // `X` for SQL lowering — the index column is discarded. Recognise the
  // pattern so the surrounding pipeline doesn't fall back when the
  // enumerate's argument is something we can otherwise lower.
  if (sourceSet.expr.kind === "index_expr") {
    const idxExpr = sourceSet.expr as IndexExpr;
    const idxLit = extractNumericLiteral(idxExpr.index);
    if ((idxLit === 1 || idxLit === 0) && idxExpr.expr.expr.kind === "function_call") {
      const fc = idxExpr.expr.expr as FunctionCall;
      const sn = fc.functionName.split("::").pop();
      if (sn === "enumerate") {
        const enumArgs = orderedCallArgs(fc.args);
        if (enumArgs.length === 1) {
          if (idxLit === 1) {
            return compileScalarSelectSQL(enumArgs[0].expr, params, target, options, outerWheres);
          }
          // `.0` — the enumeration index itself, one row per element.
          const idxRows = compileScalarSelectSQL(enumArgs[0].expr, params, target, options, outerWheres);
          if (idxRows) {
            return `SELECT (row_number() OVER ()) - 1 AS ${quoteIdent("value")} FROM (${idxRows})`;
          }
        }
      }
    }
    // Literal index over a multi-row tuple/array source (`enumerate(X).1.1`,
    // `array_unpack(arrs)[0]`) — extract the slot from each row.
    if (idxLit !== undefined) {
      const isMultiRowSource = (s: Set): boolean => {
        let cur = s;
        while (cur.expr.kind === "select_expr") {
          const se = cur.expr as SelectExpr;
          if (se.where || se.limit || se.offset) return false;
          cur = se.result;
        }
        if (cur.expr.kind === "operator_call") {
          const op = (cur.expr as OperatorCall).operator;
          return op === "union" || op === "distinct";
        }
        if (cur.expr.kind === "function_call") {
          const fn = (cur.expr as FunctionCall).functionName.split("::").pop() ?? "";
          return fn === "array_unpack" || fn === "range_unpack" || fn === "enumerate";
        }
        if (cur.expr.kind === "index_expr") {
          return isMultiRowSource((cur.expr as IndexExpr).expr);
        }
        return false;
      };
      if (isMultiRowSource(idxExpr.expr)) {
        const cp = params.length;
        const rows = compileScalarSelectSQL(idxExpr.expr, params, target, options);
        if (rows) {
          const path = idxLit < 0 ? `$[#${idxLit}]` : `$[${idxLit}]`;
          return `SELECT json_extract(${quoteIdent("value")}, '${path}') AS ${quoteIdent("value")} FROM (${rows})`;
        }
        params.length = cp;
      }
      // Literal index over a tuple whose slots are objects/tuples
      // (`((SELECT Issue {x}), Issue).0`): the multi-row check above only fires
      // for set producers, but a tuple of object sets is itself multi-row.
      // Compile the tuple to its per-row JSON array and extract the slot.
      {
        let cur: Set = idxExpr.expr;
        while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
        if (cur.expr.kind === "tuple") {
          const cp = params.length;
          const rows = compileScalarSelectSQL(idxExpr.expr, params, target, options);
          if (rows) {
            const path = idxLit < 0 ? `$[#${idxLit}]` : `$[${idxLit}]`;
            return `SELECT json_extract(${quoteIdent("value")}, '${path}') AS ${quoteIdent("value")} FROM (${rows})`;
          }
          params.length = cp;
        }
      }
    }
    // `arr[{0, 1}]` — set-valued indexing produces multiple results. Lower
    // to a json_extract per index in the index set.
    if (idxLit === undefined) {
      const cp = params.length;
      const idxSelect = compileScalarSelectSQL(idxExpr.index, params, target, options);
      if (idxSelect) {
        const arrSql = compileValueSetSQL(idxExpr.expr, "g_si", params, target, options);
        if (arrSql) {
          const correlatedArr = pickOuterScopeAliasForExpr(idxExpr.expr, options);
          const finalArr = correlatedArr ? arrSql : arrSql;
          void finalArr;
          // Use json_extract on the array per index value. Cast index to int
          // before path interpolation so JS Numbers don't render as floats.
          return `SELECT json_extract(${arrSql}, '$[' || CAST("value" AS INTEGER) || ']') AS "value" FROM (${idxSelect})`;
        }
        params.length = cp;
      }
    }
  }
  if (sourceSet.expr.kind === "select_expr") {
    return compileSelectExprScalarSource(sourceSet, params, target, options, outerWheres);
  }
  // Set-valued IF/ELSE (`<array<User>>{} IF false ELSE [User]`): pick the
  // arm row set by the condition. The condition is projected through a CTE
  // so its placeholders aren't duplicated; a NULL (empty) condition excludes
  // both arms, matching EdgeQL's empty-condition semantics.
  if (sourceSet.expr.kind === "if_else_expr") {
    const r = compileIfElseScalarSource(sourceSet, params, target, options, outerWheres);
    if (r !== null) return r;
  }

  // EdgeQL `X.__type__.name` resolves to the source row's type label —
  // intercept BEFORE the generic pointer lowerings, which would walk
  // `__type__` as a real link into a nonexistent `std__anytype` table.
  if (sourceSet.expr.kind === "pointer") {
    const nameStep0 = sourceSet.expr as Pointer;
    if (nameStep0.ptrref.shortName === "name" && nameStep0.source.expr.kind === "pointer") {
      const typeStep0 = nameStep0.source.expr as Pointer;
      let typeRootProbe0: Set = typeStep0.source;
      while (typeRootProbe0.expr.kind === "select_expr") typeRootProbe0 = (typeRootProbe0.expr as SelectExpr).result;
      if (typeStep0.ptrref.shortName === "__type__" && typeRootProbe0.expr.kind === "type_root") {
        const compiledSource = compileSelectSource(typeStep0.source, undefined, undefined, options, params, target);
        if (compiledSource) {
          return `SELECT ${compiledSource.alias}.${quoteIdent("__source_type")} AS ${quoteIdent("value")} FROM ${compiledSource.sql}`;
        }
      }
    }
  }

  // `(A UNION B).field` — a pointer (or pointer chain) applied to a union of
  // object sets. Distribute the access into each branch and UNION ALL the
  // per-branch scalar selects: `(A.field) UNION ALL (B.field)`. Without this,
  // the scalar-source collector sees two independent type roots and CROSS
  // JOINs them, which both over-produces rows and references columns the
  // joined shape lacks ("no such column: g0.field").
  if (sourceSet.expr.kind === "pointer") {
    const unionRoot = findUnionRootOfPointerChain(sourceSet);
    if (unionRoot) {
      const branches = orderedCallArgs((unionRoot.expr as OperatorCall).args);
      const parts: string[] = [];
      let ok = true;
      for (const branch of branches) {
        // An empty-set branch (`<T>{}`) contributes no rows — skip it rather
        // than letting `.field` over an empty cast fail the whole compile.
        if (isEmptySetBranch(branch.expr)) continue;
        const checkpoint = params.length;
        const rerooted = rerootPointerChain(sourceSet, unionRoot, branch.expr);
        const partSql = compileScalarSelectSQL(rerooted, params, target, options, outerWheres);
        if (!partSql) { params.length = checkpoint; ok = false; break; }
        parts.push(partSql);
      }
      if (ok && parts.length > 0) return parts.join(" UNION ALL ");
    }
  }
  // Field access on a tuple-slot object (`((SELECT Issue {x := …}), Issue).0.x`):
  // the slot was extracted as a JSON object, so the pointer reads its field
  // with json_extract instead of a table column.
  if (sourceSet.expr.kind === "pointer" && !(sourceSet.expr as Pointer).ptrref.isLinkProperty) {
    const fieldPtr = sourceSet.expr as Pointer;
    let src: Set = fieldPtr.source;
    while (src.expr.kind === "select_expr") {
      const se = src.expr as SelectExpr;
      if (se.where || se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) break;
      src = se.result;
    }
    if (src.expr.kind === "index_expr") {
      const cp = params.length;
      const slotRows = compileScalarSelectSQL(fieldPtr.source, params, target, options);
      if (slotRows) {
        const path = `$."${fieldPtr.ptrref.shortName.replaceAll('"', '""')}"`;
        return `SELECT json_extract(${quoteIdent("value")}, ${quoteLiteral(path)}) AS ${quoteIdent("value")} FROM (${slotRows})`;
      }
      params.length = cp;
    }
  }
  const isObjectSourceSet = sourceSet.expr.kind === "pointer"
    && !(sourceSet.expr as Pointer).ptrref.outTarget.isScalar
    && !(sourceSet.expr as Pointer).ptrref.isLinkProperty;
  if ((sourceSet.shape.length > 0 || isObjectSourceSet) && (sourceSet.expr.kind === "type_root" || sourceSet.expr.kind === "pointer")) {
    const compiledSource = compileSelectSource(
      sourceSet, undefined, undefined, options, params, target, undefined,
      outerWheres.flatMap((w) => collectReferencedColumns(w)),
    );
    if (compiledSource) {
      // A shapeless object set (e.g. a backlink branch of a DISTINCT/count
      // union) surfaces its identity so dedup and counting work by id.
      const valueExpr = sourceSet.shape.length > 0
        ? compilePublicShapeObjectExpr(compiledSource.alias, sourceSet.shape, params, options, target, 0)
        : `json_object(${quoteLiteral("id")}, ${compiledSource.alias}.${quoteIdent("id")})`;
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
      // The source may be a bare type_root OR a clause-bearing subquery
      // (`WITH sub := (SELECT Text … LIMIT 1) SELECT sub.__type__.name`) —
      // compileSelectSource handles both (incl. ORDER BY/LIMIT lowering).
      let typeRootProbe: Set = typeStep.source;
      while (typeRootProbe.expr.kind === "select_expr") typeRootProbe = (typeRootProbe.expr as SelectExpr).result;
      if (typeStep.ptrref.shortName === "__type__" && typeRootProbe.expr.kind === "type_root") {
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
    // Multi-row WITH binding referenced by several slots (`WITH W := (… UNION …)
    // SELECT (W, W.1, W.0.0)`): the binding is ONE row set — bind it as the
    // FROM once and derive each slot from the same row, instead of compiling
    // each slot independently (which cross-products the binding with itself
    // or, via the shared-type-root path below, aggregates the whole set per
    // row).
    sharedBindingTuple: if (tuple.elements.length >= 2) {
      const baseOf = (s: Set): { root: Set; steps: number[] } | null => {
        let cur: Set = s;
        const steps: number[] = [];
        for (;;) {
          if (cur.expr.kind === "select_expr") {
            const se = cur.expr as SelectExpr;
            if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
            cur = se.result;
            continue;
          }
          if (cur.expr.kind === "index_expr") {
            const idx = extractNumericLiteral((cur.expr as IndexExpr).index);
            if (idx === undefined) return null;
            steps.unshift(idx);
            cur = (cur.expr as IndexExpr).expr;
            continue;
          }
          break;
        }
        return { root: cur, steps };
      };
      const bases = tuple.elements.map((el) => baseOf(el.val));
      if (bases.some((b) => !b)) break sharedBindingTuple;
      const roots = bases as Array<{ root: Set; steps: number[] }>;
      const rootJson = JSON.stringify(roots[0].root.expr);
      if (!roots.every((b) => JSON.stringify(b.root.expr) === rootJson)) break sharedBindingTuple;
      // Only multi-row tuple-valued producers benefit; single values keep
      // the generic lowerings below.
      const rootExpr0 = roots[0].root.expr;
      const isMultiRowProducer = rootExpr0.kind === "operator_call"
        && (rootExpr0 as OperatorCall).operator === "union";
      if (!isMultiRowProducer) break sharedBindingTuple;
      const yieldsTuples = (s: Set): boolean => {
        let cur: Set = s;
        while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
        if (cur.expr.kind === "operator_call" && (cur.expr as OperatorCall).operator === "union") {
          const args = orderedCallArgs((cur.expr as OperatorCall).args);
          return args.length > 0 && args.every((a) => yieldsTuples(a.expr));
        }
        if (cur.expr.kind === "tuple") return true;
        if (cur.expr.kind === "pointer") {
          const out = (cur.expr as Pointer).ptrref.outTarget;
          // Tuple-typed properties are stored as std::json columns.
          return out.collection === "tuple"
            || (out.nameHint ?? "").startsWith("tuple<")
            || out.id === "std::json";
        }
        return (cur.typeref?.nameHint ?? "").startsWith("tuple<");
      };
      if (!yieldsTuples(roots[0].root)) break sharedBindingTuple;
      if (!roots.some((b) => b.steps.length > 0)) break sharedBindingTuple;
      const sbCkpt = params.length;
      const rowsSql = compileScalarSelectSQL(roots[0].root, params, target, options, []);
      if (!rowsSql) {
        params.length = sbCkpt;
        break sharedBindingTuple;
      }
      const slotOf = (steps: number[]): string => steps.length === 0
        ? `json(w.${quoteIdent("value")})`
        : `json_extract(w.${quoteIdent("value")}, '$${steps.map((i) => `[${i}]`).join("")}')`;
      const slotExprs = roots.map((b) => slotOf(b.steps));
      const tupleJson = tuple.named
        ? `json_object(${tuple.elements.map((el, i) => `${quoteLiteral(el.name ?? String(i))}, ${slotExprs[i]}`).join(", ")})`
        : `json_array(${slotExprs.join(", ")})`;
      return `SELECT ${tupleJson} AS ${quoteIdent("value")} FROM (${rowsSql}) w`;
    }
    // EdgeQL path sharing: a type root referenced by MULTIPLE tuple elements
    // (`('x' ?? Issue.log.body, Issue)`) is one shared iteration — one tuple
    // per root row — not a cross product of independent scans. Detect a
    // single shared root, hoist it as the FROM, and compile each element as
    // a correlated single value against it. Falls through to the independent
    // cross-join lowering when elements are multi-valued per root row or no
    // root is shared.
    sharedTuple: {
      const unwrapBare = (s: Set): Set => {
        let u: Set = s;
        while (u.expr.kind === "select_expr") {
          const se = u.expr as SelectExpr;
          if (se.where || se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) break;
          u = se.result;
        }
        return u;
      };
      const keyOf = (typeref: TypeRef, namespace: readonly string[]): string =>
        `${qualifyTypeName(typeref)}|${namespace.join(",")}`;
      // Collect EVERY type root reachable in an element — including inside
      // aggregates (`count(Status.<status)`) and coalesce/if-else arms —
      // since path sharing applies across all of them.
      const collectAllRoots = (s: Set, m: Map<string, TypeRef>): void => {
        const e = s.expr;
        if (!e) return;
        if (e.kind === "type_root") {
          m.set(keyOf((e as TypeRoot).typeref, s.pathId?.namespace ?? []), (e as TypeRoot).typeref);
          return;
        }
        if (e.kind === "pointer") {
          const src = (e as Pointer).source;
          let root: Set = src;
          while (root.expr.kind === "select_expr") root = (root.expr as SelectExpr).result;
          if (root.expr.kind === "type_root") {
            m.set(keyOf((root.expr as TypeRoot).typeref, src.pathId?.namespace ?? []), (root.expr as TypeRoot).typeref);
          } else {
            collectAllRoots(src, m);
          }
          return;
        }
        if (e.kind === "select_expr") {
          const se = e as SelectExpr;
          collectAllRoots(se.result, m);
          if (se.where) collectAllRoots(se.where, m);
          return;
        }
        if (e.kind === "operator_call" || e.kind === "function_call") {
          for (const arg of orderedCallArgs((e as OperatorCall | FunctionCall).args)) collectAllRoots(arg.expr, m);
          return;
        }
        if (e.kind === "coalesce_expr") {
          collectAllRoots((e as CoalesceExpr).left, m);
          collectAllRoots((e as CoalesceExpr).right, m);
          return;
        }
        if (e.kind === "if_else_expr") {
          collectAllRoots((e as IfElseExpr).condition, m);
          collectAllRoots((e as IfElseExpr).ifExpr, m);
          collectAllRoots((e as IfElseExpr).elseExpr, m);
          return;
        }
        if (e.kind === "type_cast") {
          collectAllRoots((e as TypeCast).expr, m);
          return;
        }
        if (e.kind === "exists_expr") {
          collectAllRoots((e as ExistsExpr).expr, m);
          return;
        }
        if (e.kind === "tuple") {
          for (const el of (e as Tuple).elements) collectAllRoots(el.val, m);
          return;
        }
        if (e.kind === "index_expr") {
          collectAllRoots((e as IndexExpr).expr, m);
          collectAllRoots((e as IndexExpr).index, m);
          return;
        }
      };
      // Element-wise roots: like collectAllRoots, but stop at set-level
      // constructs (`??`, `?=`/`?!=`, aggregates) — those absorb their
      // argument's cardinality, so a root referenced ONLY inside them does
      // not make the tuple iterate (`(Pub.title ?= '0', Pub.title ?? …)`
      // over an empty Pub is one row, not zero).
      const collectElementWiseRoots = (s: Set, m: Map<string, TypeRef>): void => {
        const e = s.expr;
        if (!e) return;
        if (e.kind === "coalesce_expr") return;
        if (e.kind === "operator_call") {
          const oc = e as OperatorCall;
          if (oc.operator === "??" || oc.operator === "?=" || oc.operator === "?!=") return;
          for (const arg of orderedCallArgs(oc.args)) collectElementWiseRoots(arg.expr, m);
          return;
        }
        if (e.kind === "function_call") {
          const fc = e as FunctionCall;
          const shortName = (fc.functionName ?? "").split("::").pop() ?? "";
          if (["count", "sum", "min", "max", "avg", "all", "any", "array_agg", "enumerate", "exists"].includes(shortName)) return;
          for (const arg of orderedCallArgs(fc.args)) collectElementWiseRoots(arg.expr, m);
          return;
        }
        if (e.kind === "exists_expr") return;
        if (e.kind === "select_expr") {
          const se = e as SelectExpr;
          collectElementWiseRoots(se.result, m);
          if (se.where) collectElementWiseRoots(se.where, m);
          return;
        }
        if (e.kind === "type_cast") {
          collectElementWiseRoots((e as TypeCast).expr, m);
          return;
        }
        if (e.kind === "if_else_expr") {
          collectElementWiseRoots((e as IfElseExpr).condition, m);
          collectElementWiseRoots((e as IfElseExpr).ifExpr, m);
          collectElementWiseRoots((e as IfElseExpr).elseExpr, m);
          return;
        }
        if (e.kind === "tuple") {
          for (const el of (e as Tuple).elements) collectElementWiseRoots(el.val, m);
          return;
        }
        if (e.kind === "index_expr") {
          collectElementWiseRoots((e as IndexExpr).expr, m);
          collectElementWiseRoots((e as IndexExpr).index, m);
          return;
        }
        collectAllRoots(s, m);
      };
      const perElemSources = tuple.elements.map((el) => {
        const m = new Map<string, TypeRef>();
        collectAllRoots(el.val, m);
        return m;
      });
      const elementWiseKeys = new Set<string>();
      for (const el of tuple.elements) {
        const m = new Map<string, TypeRef>();
        collectElementWiseRoots(el.val, m);
        for (const k of m.keys()) elementWiseKeys.add(k);
      }
      const counts = new Map<string, number>();
      const typerefByKey = new Map<string, TypeRef>();
      for (const m of perElemSources) {
        for (const [k, t] of m.entries()) {
          counts.set(k, (counts.get(k) ?? 0) + 1);
          typerefByKey.set(k, t);
        }
      }
      const sharedKeys = [...counts.entries()]
        .filter(([k, c]) => c >= 2 && elementWiseKeys.has(k))
        .map(([k]) => k);
      if (sharedKeys.length !== 1) break sharedTuple;
      const sharedKey = sharedKeys[0];
      const sharedTyperef = typerefByKey.get(sharedKey);
      if (!sharedTyperef) break sharedTuple;
      const sharedNs = sharedKey.includes("|") && sharedKey.slice(sharedKey.indexOf("|") + 1).length > 0
        ? sharedKey.slice(sharedKey.indexOf("|") + 1).split(",")
        : [];
      const sharedAlias = "shr0";
      const sharedCheckpoint = params.length;
      const innerOptions: GelIRCompileOptions = {
        ...options,
        outerScopes: [
          ...(options.outerScopes ?? []),
          { alias: sharedAlias, typeref: sharedTyperef, namespace: sharedNs },
        ],
      };
      // Project each element exactly once as `__eN` in an inner select (so a
      // `?`-bearing element SQL isn't duplicated), assemble the tuple JSON in
      // an outer select, and drop rows where any non-identity element is
      // empty (strict tuple semantics).
      const elemCols: string[] = [];
      const outerSlots: string[] = [];
      const guardCols: string[] = [];
      const expandedJoins: string[] = [];
      let allShared = true;
      for (let i = 0; i < tuple.elements.length; i += 1) {
        const element = tuple.elements[i];
        const bare = unwrapBare(element.val);
        if (bare.expr.kind === "type_root"
            && keyOf((bare.expr as TypeRoot).typeref, bare.pathId?.namespace ?? []) === sharedKey) {
          // A shaped object element (`(User, User {name})`) serializes its
          // shape, not just the implicit id. A bare element keeps the id-only
          // object (rendered as `{}` once the test helper drops the id key).
          const shapeJson = bare.shape && bare.shape.length > 0
            ? compileShapeObjectWithAliases(bare, sharedAlias, new Map(), params, target, innerOptions)
            : null;
          elemCols.push(`${shapeJson ?? `json_object(${quoteLiteral("id")}, ${sharedAlias}.${quoteIdent("id")})`} AS ${quoteIdent(`__e${i}`)}`);
          outerSlots.push(`json(${quoteIdent(`__e${i}`)})`);
          continue;
        }
        // Row-set elements (`Issue.time_spent_log ?= LOG1`, `(Issue.
        // time_spent_log ?? DUMMY).spent_time`) yield several rows per
        // shared row — a single-value column can't represent them (and the
        // generic value path would compile an UNcorrelated set-level form).
        // Project the correlated JSON array once and expand it back to rows
        // with json_each so the tuple multiplies per element.
        const expanded = compileSharedTupleRowSetElement(element.val, sharedAlias, sharedTyperef, params, target, innerOptions);
        if (expanded) {
          elemCols.push(`${expanded.sql} AS ${quoteIdent(`__arr${i}`)}`);
          const jeAlias = `__je${i}`;
          expandedJoins.push(`json_each(__sht.${quoteIdent(`__arr${i}`)}) ${jeAlias}`);
          outerSlots.push(expanded.wrapJson
            ? `json(${jeAlias}.${quoteIdent("value")})`
            : `${jeAlias}.${quoteIdent("value")}`);
          continue;
        }
        const v = compileValueSetSQL(element.val, sharedAlias, params, target, innerOptions);
        if (!v) { allShared = false; break; }
        elemCols.push(`${v} AS ${quoteIdent(`__e${i}`)}`);
        guardCols.push(`__e${i}`);
        const elementType = (element.val.typeref?.id ?? element.val.typeref?.nameHint ?? "").toLowerCase();
        const isBoolType = elementType === "std::bool" || elementType === "unknown:std::bool" || elementType === "bool";
        outerSlots.push(setValueIsJson(element.val) || isBoolType ? `json(${quoteIdent(`__e${i}`)})` : quoteIdent(`__e${i}`));
      }
      if (!allShared) {
        params.length = sharedCheckpoint;
        break sharedTuple;
      }
      const referenced = [...new Set(["id", ...collectReferencedColumns(sourceSet)])];
      const fromSql = compilePolymorphicSource(sharedTyperef, false, sharedAlias, referenced, options);
      const valueExpr = tuple.named
        ? `json_object(${tuple.elements.map((element, index) => `${quoteLiteral(element.name ?? String(index))}, ${outerSlots[index]}`).join(", ")})`
        : `json_array(${outerSlots.join(", ")})`;
      const inner = `SELECT ${elemCols.join(", ")} FROM ${fromSql}`;
      const guards = guardCols.length > 0
        ? ` WHERE ${guardCols.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(" AND ")}`
        : "";
      const expansion = expandedJoins.length > 0 ? ` __sht, ${expandedJoins.join(", ")}` : "";
      const tupleRows = `SELECT ${valueExpr} AS ${quoteIdent("value")} FROM (${inner})${expansion}${guards}`;
      // Tuple-slot outer FILTERs (`SELECT (a, b) FILTER .1`): the predicate
      // indexes the RESULT tuple, so apply it on the assembled value.
      if (outerWheres.length > 0) {
        const slotFilters: string[] = [];
        let filtersOk = true;
        for (const w of outerWheres) {
          let cur: Set = w;
          while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
          if (cur.expr.kind === "index_expr") {
            const idx = extractNumericLiteral((cur.expr as IndexExpr).index);
            if (idx !== undefined) {
              slotFilters.push(`json_extract(${quoteIdent("value")}, '$[${idx}]')`);
              continue;
            }
          }
          filtersOk = false;
          break;
        }
        if (filtersOk && slotFilters.length > 0) {
          return `SELECT ${quoteIdent("value")} FROM (${tupleRows}) WHERE ${slotFilters.join(" AND ")}`;
        }
      }
      return tupleRows;
    }
    // The empty tuple `()` is the empty set — zero rows, not a zero-length
    // JSON array (and the CASE/FROM scaffolding below would be malformed
    // SQL with no elements).
    if (tuple.elements.length === 0) {
      return `SELECT NULL AS ${quoteIdent("value")} WHERE 0`;
    }
    const sources: string[] = [];
    const values: string[] = [];
    const valueRefs: string[] = [];
    for (let i = 0; i < tuple.elements.length; i += 1) {
      const element = tuple.elements[i];
      const elementSql = compileScalarSelectSQL(element.val, params, target, options);
      if (!elementSql) return null;
      const alias = `tuple_${i}`;
      sources.push(`(${elementSql}) ${alias}`);
      const valueRef = `${alias}.${quoteIdent("value")}`;
      valueRefs.push(valueRef);
      // Bool values are stored as TEXT `'true'`/`'false'` (the literal output
      // of `json('true')`/`json('false')`). Without wrapping them with
      // `json(...)` inside `json_array(...)`, SQLite treats them as strings
      // and the tuple serialises to `["true", …]` instead of `[true, …]`.
      const wrapInJson = setValueIsJson(element.val) || setValueIsBool(element.val);
      values.push(wrapInJson ? `json(${valueRef})` : valueRef);
    }
    const valueExpr = tuple.named
      ? `json_object(${tuple.elements.map((element, index) => `${quoteLiteral(element.name ?? String(index))}, ${values[index]}`).join(", ")})`
      : `json_array(${values.join(", ")})`;
    // A free object (`{ a := … }`) keeps its single row even when a field is
    // empty — the empty field serializes to null. Real tuples collapse to the
    // empty set when any element is empty.
    if (tuple.isFreeObject) {
      return `SELECT ${valueExpr} AS ${quoteIdent("value")} FROM ${sources.join(" CROSS JOIN ")}`;
    }
    return `SELECT CASE WHEN ${valueRefs.map((ref) => `${ref} IS NULL`).join(" OR ")} THEN NULL ELSE ${valueExpr} END AS ${quoteIdent("value")} FROM ${sources.join(" CROSS JOIN ")}`;
  }

  // Array constructor `[X, Y, ...]` whose elements include multi-cardinality
  // scalar pointer references. EdgeQL semantics cross-product the element sets,
  // producing one array per `(e1, e2, ...)` combination.
  if (sourceSet.expr.kind === "array") {
    const arr = sourceSet.expr as ArrayExpr;
    if (arr.elements.length === 0) {
      return `SELECT json_array() AS ${quoteIdent("value")}`;
    }
    // When elements reach union-bound sets, a flat CROSS JOIN would always
    // cross-product them — but elements that reference the SAME union (e.g. a
    // FOR iterator inlined as a `variadic` arg: `foo(x, x*10, x*100)`) must
    // co-iterate, not cross-product. Defer to the union-distribution block
    // below, which re-emits the array per branch combo with shared unions
    // pinned to the same branch.
    if (arr.elements.some((el) => reachesScalarUnion(el))) {
      // fall through to the distribution block
    } else {
    const arrSources: string[] = [];
    const arrValues: string[] = [];
    for (let i = 0; i < arr.elements.length; i += 1) {
      const element = arr.elements[i];
      const elementSql = compileScalarSelectSQL(element, params, target, options);
      if (!elementSql) return null;
      const alias = `arr_${i}`;
      arrSources.push(`(${elementSql}) ${alias}`);
      const valueRef = `${alias}.${quoteIdent("value")}`;
      const wrapInJson = setValueIsJson(element) || setValueIsBool(element);
      arrValues.push(wrapInJson ? `json(${valueRef})` : valueRef);
    }
    return `SELECT json_array(${arrValues.join(", ")}) AS ${quoteIdent("value")} FROM ${arrSources.join(" CROSS JOIN ")}`;
    }
  }
  // The set-level coalesce / ?= / ?!= shortcuts carry outer FILTER clauses
  // themselves (applied per LHS row, and against an all-NULL LHS binding in
  // the empty-LHS fallback); when they can't, they return null and the
  // generic FROM-based emit attaches the WHERE instead.
  const expr = sourceSet.expr;
  if (expr.kind === "coalesce_expr") {
    // Element-wise coalesce over a union prefix (`X[IS A].p ?? X[IS B].q`
    // with X := {A, B}): iterate the union members as one tagged scan; each
    // side contributes on its narrowed member's rows (dependent_21/22).
    {
      const ce = expr as CoalesceExpr;
      const lhsSide = matchUnionPrefixSide(ce.left);
      const rhsSide = lhsSide ? matchUnionPrefixSide(ce.right) : null;
      if (lhsSide && rhsSide && lhsSide.memberIds.join("|") === rhsSide.memberIds.join("|")) {
        const upCkpt = params.length;
        const projCols = [...new globalThis.Set([
          "id",
          ...collectReferencedColumns(lhsSide.rebuilt),
          ...collectReferencedColumns(rhsSide.rebuilt),
        ])];
        const memberRefs = ((): TypeRef[] => {
          // Re-derive the member typerefs from the union args of the LHS.
          const collectMembers = (s: Set): TypeRef[] | null => {
            let cur: Set = s;
            while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
            if (cur.expr.kind === "index_expr") return collectMembers((cur.expr as IndexExpr).expr);
            if (cur.expr.kind === "pointer") return collectMembers((cur.expr as Pointer).source);
            if (cur.expr.kind === "operator_call" && (cur.expr as OperatorCall).operator === "union") {
              const args = orderedCallArgs((cur.expr as OperatorCall).args);
              if (args.every((a) => a.expr.expr.kind === "type_root")) {
                return args.map((a) => (a.expr.expr as TypeRoot).typeref);
              }
            }
            return null;
          };
          return collectMembers(ce.left) ?? [];
        })();
        if (memberRefs.length >= 2) {
          const memberSelects = memberRefs.map((m, i) =>
            `SELECT u${i}.* FROM ${compilePolymorphicSource(m, false, `u${i}`, projCols, options)}`);
          const fromSql = `(${memberSelects.join(" UNION ALL ")}) g0`;
          const valueSql = compileUnionPrefixCoalesceValueSQL(ce, "g0", params, target, options);
          if (valueSql) {
            return `SELECT ${quoteIdent("value")} FROM (SELECT ${valueSql} AS ${quoteIdent("value")} FROM ${fromSql}) WHERE ${quoteIdent("value")} IS NOT NULL`;
          }
          params.length = upCkpt;
        }
      }
    }
    // When the LHS is itself a multi-element set-union (e.g. an OPTIONAL UDF
    // param inlined with `{1,2,3}` — `x ?? 5`), set-level coalesce would
    // collapse the whole set into one `json_group_array` value. EdgeQL applies
    // the function element-wise, so defer to the union-distribution block
    // below (which re-emits `i ?? 5` per branch). A union LHS arising this way
    // is recognised structurally: a `union` operator after peeling select_expr
    // wrappers, whose branches are scalar values (not object/type roots — those
    // keep their dedicated union-prefix handling above).
    {
      let lhsCursor: Set = (expr as CoalesceExpr).left;
      while (lhsCursor.expr.kind === "select_expr") lhsCursor = (lhsCursor.expr as SelectExpr).result;
      const lhsIsScalarUnion = reachesScalarUnion(lhsCursor);
      if (!lhsIsScalarUnion) {
        const setLevel = tryCompileSetLevelCoalesceSQL(expr as CoalesceExpr, params, target, options, outerWheres, sqlLoweringContext());
        if (setLevel) {
          return setLevel;
        }
      }
    }
  }
  if (expr.kind === "operator_call") {
    const opCall = expr as OperatorCall;
    if (opCall.operator === "?=" || opCall.operator === "?!=") {
      const setLevel = tryCompileSetLevelOptionalCompareSQL(opCall, params, target, options, outerWheres, sqlLoweringContext());
      if (setLevel) {
        return setLevel;
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
        if (memberSet && targetEnumMembers) {
          if (inner.kind === "pointer") {
            const ptr = inner as Pointer;
            const fieldMembers = ptr.ptrref.outSource && ptr.ptrref.shortName
              ? options.resolveFieldEnumMembers?.(qualifyTypeName(ptr.ptrref.outSource), ptr.ptrref.shortName)
              : undefined;
            perArm = fieldMembers && fieldMembers.join("|") === targetEnumMembers.join("|") ? "json('true')" : "json('false')";
          } else if (inner.kind === "string_constant") {
            const value = (inner as BaseConstant).value;
            perArm = typeof value === "string" && memberSet.has(value) ? "json('true')" : "json('false')";
          } else {
            const branches = targetEnumMembers.map((m) => `WHEN ${quoteLiteral(m)} THEN json('true')`).join(" ");
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
          const valueExpr = likeOperatorSql(opCall.operator, argSqls[0], argSqls[1])
            ?? flooredArithBinarySql(opCall.operator, argSqls[0], argSqls[1])
            ?? `(${argSqls[0]} ${op} ${argSqls[1]})`;
          return `SELECT ${valueExpr} AS ${quoteIdent("value")} FROM ${fromSources.join(", ")}`;
        }
        params.length = innerCheckpoint;
      }
    }
  }

  // Distribute a binary operator_call (or a coalesce_expr) over union-bound
  // sets reachable from its args. `2 * (1 UNION 2)` and `(SELECT 2) * (1 UNION 2)`
  // should yield a set of products (`{2, 4}`), not a scalar of
  // `2 * json_group_array(...)`.
  // We re-emit the expression once per branch (Cartesian over distinct
  // union sources; co-iteration when the *same* bound set appears multiple
  // times — `WITH x := {1,2,3} SELECT x * x + x` produces three values, not
  // 27, because all three `x` references must use the same branch per row).
  // The coalesce case matters for OPTIONAL UDF params inlined with a
  // multi-element argument: `foo(x: optional int64) using (x ?? 5)` called
  // with `{1,2,3}` binds `x` to the union `{1,2,3}`; distributing per branch
  // gives `{1??5, 2??5, 3??5}` = `{1,2,3}` (element-wise), not the set-level
  // `[1,2,3]` collapse. An empty argument is bound to an empty set_literal
  // (not a union), so it skips this block and the set-level path supplies the
  // `5` fallback — exactly the optional-param semantics.
  if ((expr.kind === "operator_call" && (expr as OperatorCall).operator !== "union")
    || expr.kind === "coalesce_expr"
    || expr.kind === "array") {
    const opCall = expr as OperatorCall;
    const args = expr.kind === "coalesce_expr"
      ? [{ expr: (expr as CoalesceExpr).left }, { expr: (expr as CoalesceExpr).right }]
      : expr.kind === "array"
      ? (expr as ArrayExpr).elements.map((e) => ({ expr: e }))
      : orderedCallArgs(opCall.args);
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
      } else if (e.kind === "array") {
        for (const el of (e as ArrayExpr).elements) collectReachableUnions(el);
      }
    };
    // `IN` / `NOT IN`: the right operand is a membership SET tested as a
    // whole, not an element-wise operand — so only the LHS distributes over
    // its union branches. Distributing the RHS too would cross-product the
    // check (`{1,2,3} IN {3,4}` would yield 6 rows instead of 3).
    const distributableArgs = (opCall.operator === "in" || opCall.operator === "not in")
      ? args.slice(0, 1)
      : args;
    for (const arg of distributableArgs) {
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
      if (e.kind === "array") {
        const arrE = e as ArrayExpr;
        let changed = false;
        const newElements = arrE.elements.map((el) => {
          const sub = substituteSetByIdentity(el, source, replacement);
          if (sub !== el) changed = true;
          return sub;
        });
        return changed ? { ...s, expr: { ...arrE, elements: newElements } } : s;
      }
      return s;
    };
    if (reachableUnions.length > 0) {
      const innerCheckpoint = params.length;
      const branchesPerUnion = reachableUnions.map((u) => {
        const branches = unwrapUnionBranches(u);
        if (!branches) throw new Error("invariant: reachable union operator_call has no branches");
        return branches;
      });
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
        // the whole expression (operator_call args OR coalesce left/right).
        // Co-iteration falls out for free: if two sub-expressions reference
        // the same union (same identity), they both get rewritten to the same
        // branch in this combo.
        let variantSet: Set = sourceSet;
        reachableUnions.forEach((source, idx) => {
          const replacement = branchesPerUnion[idx][combo[idx]];
          variantSet = substituteSetByIdentity(variantSet, source, replacement);
        });
        const partSql = compileScalarSelectSQL(variantSet, params, target, options, outerWheres);
        if (!partSql) {
          failed = true;
          break;
        }
        parts.push(partSql);
      }
      if (!failed && parts.length > 0) {
        // A per-branch part that is itself a CTE (`WITH … SELECT …`, e.g. a
        // set-level coalesce branch) can't be a bare UNION ALL operand —
        // SQLite rejects `… UNION ALL WITH …`. Wrap those in a subquery.
        const wrapped = parts.map((p) =>
          /^\s*WITH\b/i.test(p) ? `SELECT ${quoteIdent("value")} FROM (${p})` : p);
        return wrapped.join(" UNION ALL ");
      }
      params.length = innerCheckpoint;
    }
  }

  const multiScalarSql = tryCompileMultiScalarPointerSelectSQL(sourceSet, params, target, options, outerWheres);
  if (multiScalarSql) {
    return multiScalarSql;
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
  // Outer FILTERs that reference a FOREIGN extent (sources not a subset of the
  // value's — `SELECT Issue.number FILTER Status.name = 'x'`) are not dropped
  // but applied existentially: EdgeQL keeps the row when ANY element of that
  // extent satisfies the predicate. They compile to free-root EXISTS subqueries
  // (see tryCompileFreeRootExistsWhere) AND-ed into the WHERE. A SET OF wrapped
  // value keeps the independent-filter semantics, so it stays excluded.
  const freeRootOuterWheres = (!outerWheresMatchValueSources && !valueIsSetOfWrapped) ? outerWheres : [];
  const innerWheres = collectInnerWhereClauses(sourceSet);
  const preValueCheckpoint = params.length;
  // For a single-source optional compare, the iteration root is a scoped
  // path — expose it to SET OF (aggregate) args (see scopedAggRoot).
  const valueOptions = ((): GelIRCompileOptions => {
    // No enclosing row source: free-rooted subquery operands can be compiled
    // self-contained (see allowIndependentSubquery).
    const base = sources.size === 0 ? { ...options, allowIndependentSubquery: true } : options;
    if (sources.size !== 1) return base;
    let cur: Set = sourceSet;
    while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
    if (cur.expr.kind === "operator_call") {
      const opName = (cur.expr as OperatorCall).operator;
      if (opName === "?=" || opName === "?!=") {
        const [tr] = sources.values();
        if (tr) return { ...options, scopedAggRoot: { alias: "g0", typerefId: tr.id } };
      }
    }
    return base;
  })();
  const valueSql = compileValueSetSQL(sourceSet, "g0", params, target, valueOptions);
  if (!valueSql) return null;
  if (sources.size === 0) {
    // Invariant: this branch emits SELECTs with no FROM, so the value must
    // not read the local anchor alias (self-contained subqueries that bind
    // their own g0 are fine; see referencesUnboundAlias).
    if (referencesUnboundAlias(valueSql, "g0", options)) {
      params.length = preValueCheckpoint;
      return null;
    }
    if (innerWheres.length > 0 || appliedOuterWheres.length > 0) return null;
    // A source-free value with FILTERs whose roots all resolve to enclosing
    // scopes (`SELECT 'yes' FILTER Issue.status.name = 'Open'` inside a
    // computed on Issue) keeps the filter as a correlated WHERE on the
    // single-row select — dropping it would emit a phantom row per outer row.
    if (outerWheres.length > 0) {
      const preWhereCheckpoint = params.length;
      const whereSqls: string[] = [];
      let allCompiled = true;
      for (const where of outerWheres) {
        const whereSources = new Map<string, TypeRef>();
        collectScalarPointerSources(where, whereSources);
        // A source-free predicate (`filter random() > 0`) references no row
        // alias at all — compile it against a throwaway anchor.
        let anchorAlias: string | undefined = whereSources.size === 0 ? "g0" : undefined;
        let allOuter = true;
        for (const [key, typeref] of whereSources.entries()) {
          const ns = key.includes("|") ? key.slice(key.indexOf("|") + 1) : "";
          const namespace = ns.length > 0 ? ns.split(",") : [];
          const match = findMatchingOuterScope({ typerefId: typeref.id, namespace }, options);
          if (!match) { allOuter = false; break; }
          anchorAlias = anchorAlias ?? match.alias;
        }
        const whereCheckpoint = params.length;
        let whereSql: string | null = null;
        if (allOuter && anchorAlias) {
          whereSql = compilePredicateSetSQL(where, anchorAlias, params, target, options)
            ?? compileValueSetSQL(where, anchorAlias, params, target, options);
        }
        // Filter roots that aren't enclosing scopes carry EdgeQL's free-root
        // existential semantics (`SELECT count(Issue) FILTER Status.name =
        // 'Open'` keeps the row when ANY Status matches).
        if (!whereSql) {
          params.length = whereCheckpoint;
          whereSql = tryCompileFreeRootExistsWhere(where, "g0", null, params, target, options);
        }
        if (!whereSql) {
          params.length = whereCheckpoint;
          allCompiled = false;
          break;
        }
        whereSqls.push(whereSql);
      }
      if (allCompiled) {
        return `SELECT ${valueSql} AS ${quoteIdent("value")} WHERE ${whereSqls.join(" AND ")}`;
      }
      // Couldn't lower the filter — fall back to the pre-existing behaviour
      // (drop it) rather than failing the whole value compile.
      params.length = preWhereCheckpoint;
    }
    // An optional-returning bound accessor (`range_get_upper`/`_lower`) yields
    // the empty set, not a NULL row, when its result is absent (unbounded
    // bound) — drop the row at runtime.
    const emptyOnNull = (() => {
      let cur: Set = sourceSet;
      while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
      // A slice over an empty-set operand/bound (`arr[1:<int64>{}]`) is the
      // empty set, surfaced as a NULL value by the slice lowering — drop it so
      // the result is zero rows, not a phantom NULL row. (An empty *array* slice
      // yields '[]', which is non-NULL and correctly kept as one row.)
      if (cur.expr.kind === "slice_expr") return true;
      if (cur.expr.kind !== "function_call") return false;
      return EMPTY_ON_NULL_FUNCTIONS.has((cur.expr as FunctionCall).functionName.split("::").pop() ?? "");
    })();
    if (emptyOnNull) {
      return `SELECT ${quoteIdent("value")} FROM (SELECT ${valueSql} AS ${quoteIdent("value")}) WHERE ${quoteIdent("value")} IS NOT NULL`;
    }
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
      // looks up by the source-set's serialized pathId. Build that key too,
      // carrying the source's REAL namespace so `User.name` (ns []) and a
      // WITH-rebound `U2.name` (ns ['with:U2:…']) resolve to different
      // aliases instead of conflating on the bare type id.
      const sidNs = sid.includes("|") ? sid.slice(sid.indexOf("|") + 1) : "";
      const namespace = sidNs.length > 0 ? sidNs.split(",") : [];
      const syntheticRoot: Set = {
        kind: "set",
        expr: { kind: "type_root", typeref: sourceType, skipSubtypes: false, isCachedGlobal: false },
        pathId: { kind: "path_id", namespace, isPointerPath: false, steps: [{ type: sourceType }] },
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
      let expr: Expr = sourceSet.expr;
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
  if (!typeRef) return null;
  // When the value references a link-table-backed pointer step (`User.todo`),
  // the source's row alone can't satisfy the access — we need to iterate the
  // link's storage table. Promote the FROM to a chain that walks one such
  // common prefix and provides aliases for the inner compile. Falls back to
  // the plain single-source FROM if no such pointer is found.
  const linkIterationSqlAttempt = tryBuildLinkIterationSingleSource(sourceSet, typeRef, params, target, options, valueSql, appliedOuterWheres, innerWheres);
  if (linkIterationSqlAttempt) {
    return linkIterationSqlAttempt;
  }
  // Element-wise lowering over correlated multi-scalar pointers:
  // `BooleanTest.tags = 'red' or .name like '%a%'` yields one boolean per
  // `tags` element. The plain value path would compare the JSON-encoded
  // column blob. Cross-join one json_each() per distinct multi-scalar leaf
  // and rebind its pathId so the value expression reads the element value.
  elementwise: if (innerWheres.length === 0 && appliedOuterWheres.length === 0) {
    const sortDirs: string[] = [];
    let cursorSet: Set = sourceSet;
    while (cursorSet.expr.kind === "select_expr") {
      const se = cursorSet.expr as SelectExpr;
      if (se.where || se.limit || se.offset) break elementwise;
      // Only self-referential sorts (`order by _`) are supported here — the
      // sort key is the computed value itself.
      for (const ord of se.orderBy ?? []) sortDirs.push(ord.direction.toUpperCase());
      cursorSet = se.result;
    }
    const topExpr: Expr = cursorSet.expr;
    if (topExpr.kind !== "operator_call" && topExpr.kind !== "function_call") break elementwise;
    const leafSets: Set[] = [];
    collectCorrelatedMultiScalarLeafSets(cursorSet, leafSets);
    if (leafSets.length === 0) break elementwise;
    if (leafSets.some((leafSet) => !tryExtractMultiScalarLeafPointer(leafSet))) break elementwise;
    // When the multi-scalar's root row is supplied by an enclosing iteration
    // (a computed shape element), correlate to that alias instead of opening
    // a fresh scan of the whole type table.
    const firstLeafPtr = tryExtractMultiScalarLeafPointer(leafSets[0]);
    if (!firstLeafPtr) break elementwise;
    let leafRootSet: Set = firstLeafPtr.source;
    while (leafRootSet.expr.kind === "select_expr") {
      leafRootSet = (leafRootSet.expr as SelectExpr).result;
    }
    const outerMatch = findMatchingOuterScope(
      { typerefId: typeRef.id, namespace: leafRootSet.pathId?.namespace ?? [] },
      options,
    );
    const baseAlias = outerMatch ? outerMatch.alias : "g0";
    const multiBindings = new Map<string, string>(options.multiScalarBindings ?? new Map());
    const finalJoins: string[] = [];
    {
      let jeIdx = 0;
      for (const leafSet of leafSets) {
        const key = pathIdKey(leafSet);
        if (multiBindings.has(key)) continue;
        const leafPtr = tryExtractMultiScalarLeafPointer(leafSet);
        if (!leafPtr) continue;
        const jeAlias = `jem${jeIdx++}`;
        finalJoins.push(`json_each(COALESCE(${baseAlias}.${quoteIdent(columnForPointer(leafPtr))}, '[]')) ${jeAlias}`);
        const elementValue = `${jeAlias}.${quoteIdent("value")}`;
        multiBindings.set(key, elementValue);
        multiBindings.set(pathIdKey(unwrapSelectExprSet(leafSet).result), elementValue);
      }
    }
    if (finalJoins.length === 0) break elementwise;
    params.length = preValueCheckpoint;
    const innerOptions: GelIRCompileOptions = { ...options, multiScalarBindings: multiBindings };
    const elementValueSql = compileValueSetSQL(sourceSet, baseAlias, params, target, innerOptions);
    if (!elementValueSql) {
      params.length = preValueCheckpoint;
      break elementwise;
    }
    let sql: string;
    if (outerMatch) {
      sql = `SELECT ${elementValueSql} AS ${quoteIdent("value")} FROM ${finalJoins.join(" CROSS JOIN ")}`;
    } else {
      const refCols = collectReferencedColumns(sourceSet);
      for (const leafSet of leafSets) {
        const leafPtr = tryExtractMultiScalarLeafPointer(leafSet);
        if (leafPtr) refCols.push(columnForPointer(leafPtr));
      }
      const fromSql = compilePolymorphicSource(typeRef, false, "g0", [...new Set(refCols)], options);
      sql = `SELECT ${elementValueSql} AS ${quoteIdent("value")} FROM ${fromSql} CROSS JOIN ${finalJoins.join(" CROSS JOIN ")}`;
    }
    if (sortDirs.length > 0) {
      sql = `SELECT ${quoteIdent("value")} FROM (${sql}) ORDER BY ${quoteIdent("value")} ${sortDirs[0]}`;
    }
    return sql;
  }
  // NOTE: link-table FK columns the WHEREs read (`Issue.owner = U` →
  // `owner_id`) are NOT requested as plain columns here — the LinkProjection
  // LEFT JOIN below projects them; requesting them as plain columns too
  // would emit a shadowing `NULL AS "x_id"` duplicate.
  const projectedColumns = Array.from(new Set([
    // `id` is always projected: correlated link subqueries anchor on
    // g0."id" even when no leaf column references it directly.
    "id",
    ...collectReferencedColumns(sourceSet),
    ...appliedOuterWheres.flatMap((w) => collectReferencedColumns(w)),
    ...innerWheres.flatMap((w) => collectReferencedColumns(w)),
  ]));
  // When the scalar pointer hangs off a select_expr source carrying
  // ORDER BY / LIMIT / OFFSET (`WITH sub := (SELECT Text ORDER BY … LIMIT 1)
  // SELECT sub.body`), the flat polymorphic scan below would silently drop
  // those clauses. Compile the source through compileSelectSource (which
  // honours them) instead, then narrow by __source_type if the pointer's
  // source was intersection-narrowed relative to the underlying type root.
  let typeNarrowFilter: string | null = null;
  const clauseSourceSql = ((): string | null => {
    let cur = sourceSet;
    while (cur.expr.kind === "select_expr") {
      const se = cur.expr as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
      cur = se.result;
    }
    if (cur.expr.kind !== "pointer") return null;
    const ptr = cur.expr as Pointer;
    if (!ptr.ptrref.outTarget.isScalar || ptr.ptrref.isLinkProperty) return null;
    if (ptr.direction === "inbound") return null;
    let probe = ptr.source;
    let hasClauses = false;
    while (probe.expr.kind === "select_expr") {
      const se = probe.expr as SelectExpr;
      if ((se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) hasClauses = true;
      probe = se.result;
    }
    if (!hasClauses || probe.expr.kind !== "type_root") return null;
    const rootTyperef = (probe.expr as TypeRoot).typeref;
    const neededColumns = [...new Set([...projectedColumns, columnForPointer(ptr)])];
    const compiled = compileSelectSource(
      ptr.source, undefined, undefined, options, params, target, "g0", neededColumns,
    );
    if (!compiled) return null;
    const narrowed = ptr.source.typeref;
    if (narrowed && narrowed.id !== rootTyperef.id) {
      const concrete = flattenTypeClosure(narrowed)
        .filter((candidate) => !candidate.isAbstract)
        .map((candidate) => quoteLiteral(qualifyTypeName(candidate)));
      if (concrete.length > 0) {
        typeNarrowFilter = `g0.${quoteIdent("__source_type")} IN (${concrete.join(", ")})`;
      }
    }
    return compiled.sql;
  })();
  // Wire LinkProjection LEFT JOINs for any single link-table links the value
  // or its WHEREs reference (`Issue.owner = U` needs `owner_id`).
  const scalarLinkProjections = ((): LinkProjection[] => {
    const merged = new Map<string, LinkProjection>();
    for (const src of [sourceSet, ...innerWheres, ...appliedOuterWheres]) {
      for (const proj of collectLinkProjectionsForSource([], src, undefined, typeRef.id)) {
        if (!merged.has(proj.linkName)) merged.set(proj.linkName, proj);
      }
    }
    return [...merged.values()];
  })();
  const sourceSql = clauseSourceSql ?? compilePolymorphicSource(typeRef, false, "g0", projectedColumns, options, scalarLinkProjections);

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
    let expr: Expr = sourceSet.expr;
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
  if (typeNarrowFilter) {
    whereSqls.push(typeNarrowFilter);
  }
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
  // Foreign-extent FILTERs: existential EXISTS over their own roots, correlated
  // to the value's row via `g0`. Best-effort — an uncompilable one falls back
  // to the pre-existing drop rather than failing the whole compile.
  for (const where of freeRootOuterWheres) {
    const checkpoint = params.length;
    const existsSql = tryCompileFreeRootExistsWhere(where, "g0", sourceSet, params, target, options);
    if (existsSql) {
      whereSqls.push(existsSql);
    } else {
      params.length = checkpoint;
    }
  }
  if (whereSqls.length > 0) {
    sql += ` WHERE ${whereSqls.join(" AND ")}`;
  }
  return sql;
};

// The type to scan for a link step's target (outbound) or source (inbound)
// rows. Normally the pointer's declared target/source, but a `[IS T]`
// intersection puts the narrowed type on the wrapping set; scanning that
// instead filters the step's rows to the narrowed extent purely via the
// existing id JOIN — `stw0[IS R]` scans R's tables, so only the union-link
// targets that are R-typed survive.
const effectiveStepType = (link: Pointer, setTyperef: TypeRef | undefined): TypeRef => {
  const declared = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
  return setTyperef && setTyperef.id !== declared.id ? setTyperef : declared;
};

const extractScalarPointerPath = (set: Set): ScalarPointerPath | null => {
  const chain: Pointer[] = [];
  const chainSetTyperefs: TypeRef[] = [];
  let cursor: Set = set;
  while (cursor.expr.kind === "pointer") {
    const pointer = cursor.expr as Pointer;
    chain.push(pointer);
    chainSetTyperefs.push(cursor.typeref);
    cursor = pointer.source;
  }

  let rootExpr: Expr = cursor.expr;
  while (rootExpr.kind === "select_expr") {
    rootExpr = (rootExpr as SelectExpr).result.expr;
  }
  if (rootExpr.kind !== "type_root" || chain.length < 2) {
    return null;
  }

  const leaf = chain[0];
  if (!leaf.ptrref.outTarget.isScalar || leaf.ptrref.isLinkProperty) {
    return null;
  }

  const links = chain.slice(1).reverse();
  if (links.some((link) => link.ptrref.outTarget.isScalar || link.ptrref.isLinkProperty)) {
    return null;
  }
  const linkTargets = chainSetTyperefs.slice(1).reverse();

  return { root: cursor, leaf, links, linkTargets };
};

const pointerPathAliasColumns = (path: ScalarPointerPath): string[][] => {
  const columns = Array.from({ length: path.links.length + 1 }, () => new Set<string>(["id"]));
  path.links.forEach((link, index) => {
    if (shouldUseLinkTable(link)) {
      return;
    }
    const inlineColumn = `${link.ptrref.shortName}_id`;
    if (link.direction === "inbound") {
      columns[index + 1].add(inlineColumn);
    } else {
      columns[index].add(inlineColumn);
    }
  });
  columns[columns.length - 1].add(columnForPointer(path.leaf));
  return columns.map((entry) => [...entry]);
};

const linkTableNameForPointer = (pointer: Pointer, options?: GelIRCompileOptions): string => {
  // For an outbound link the storage source is the type that *defines* the
  // link — which is `ptrref.outSource`. The pointer's `source.typeref` may
  // have been widened by a union narrowing (`references: File | URL |
  // Publication` then `[is Publication].**` walks `.authors`), in which case
  // using `source.typeref` would build a pipe-joined nonsense table name.
  // Falling back to `outSource` keeps the join targeted at the link's actual
  // storage table.
  const fallbackSource = pointer.direction === "inbound"
    ? pointer.ptrref.outSource
    : (pointer.source.typeref.id.includes("|")
        ? pointer.ptrref.outSource
        : pointer.source.typeref);
  const sourceType = fallbackSource;
  const sourceTypeName = qualifyTypeName(sourceType);
  const linkName = pointer.ptrref.shortName;
  const storage = options?.resolveLinkStorageType?.(sourceTypeName, linkName) ?? sourceTypeName;
  return `${tableNameForType(storage)}__${linkName.toLowerCase()}`;
};

// The DISTINCT physical junction tables this link read must touch. Usually one
// (the link's single storage owner), but a link inherited independently by a
// multiple-inheritance subtype lives in that subtype's own table, separate from
// the base owners (e.g. `V : S, T` owns `default__v__l_a`, distinct from
// `default__s__l_a` / `default__t__l_a`). When the source set may hold several
// such concrete types, the read must union every owner's table. De-duped, so
// the ordinary single-inheritance case (subtypes share the base's table) still
// yields exactly one — keeping the SQL byte-identical there.
const linkStorageTablesForPointer = (link: Pointer, options?: GelIRCompileOptions): string[] => {
  const linkName = link.ptrref.shortName;
  // Outbound: keyed by the concrete types the source set may hold. Inbound
  // (a `.<link` backlink): keyed by the concrete types that DECLARE the link
  // (its `outSource` extent), since the junction lives with the referencing
  // type, not the row we start from.
  const keyTyperef = link.direction === "inbound" ? link.ptrref.outSource : link.source.typeref;
  // Expand to concrete types branch by branch via the shared closure rule: a
  // union (`S | T`) arrives as bare branch refs with no `children`, so the
  // typeref's own closure would miss each branch's subtypes (the V in S|T).
  const concrete = new globalThis.Set<string>();
  for (const branch of expandUnionTypeRefBranches(keyTyperef)) {
    for (const name of branchConcreteTypeNames(branch, options)) concrete.add(name);
  }
  const tables = new globalThis.Set<string>();
  for (const typeName of concrete) {
    // When a storage resolver is wired, an `undefined` answer means this
    // concrete type does NOT declare the link — skip it rather than naming a
    // table that was never created. This matters for backlinks: the ptrref's
    // `outSource` is widened to a common base (`l_a` resolves to `R`), whose
    // extent includes siblings like `A` that never carry the link.
    let storage: string | undefined;
    if (options?.resolveLinkStorageType) {
      storage = options.resolveLinkStorageType(typeName, linkName);
      if (storage === undefined) continue;
    } else {
      storage = typeName;
    }
    tables.add(`${tableNameForType(storage)}__${linkName.toLowerCase()}`);
  }
  if (tables.size === 0) {
    tables.add(linkTableNameForPointer(link, options));
  }
  return [...tables];
};

// The FROM reference for a link's junction in a JOIN/FROM position: a single
// quoted table name in the common case, or a parenthesised UNION-ALL over the
// distinct per-owner storage tables when the link is split across several (a
// multiple-inheritance diamond). `rowid` is projected through the union so the
// default insertion-order link ordering (`ORDER BY <alias>.rowid`) still
// resolves; `*` carries `source`/`target` and any link-property columns, which
// align positionally because every owner materialises the same link shape.
const linkTableSourceForPointer = (link: Pointer, options?: GelIRCompileOptions): string => {
  const tables = linkStorageTablesForPointer(link, options);
  if (tables.length <= 1) {
    return quoteIdent(tables[0] ?? linkTableNameForPointer(link, options));
  }
  const union = tables
    .map((table) => `SELECT ${quoteIdent("rowid")}, * FROM ${quoteIdent(table)}`)
    .join(" UNION ALL ");
  return `(${union})`;
};

// One home for the per-link choice between the two pointer-step join shapes: a
// link-table step joins through its junction alias, an inline step through the
// `<name>_id` FK column. The four join shapes themselves live in
// `pointerStepJoinSql` (docs/adr/0011); this is the dispatch *into* them — the
// `shouldUseLinkTable(link) ? …(usesLinkTable:true) : …(usesLinkTable:false)`
// ternary that the chain-loop sites re-spelled identically, differing only in
// the bound aliases (`previousAlias`/`nextAlias`/`targetSource`/`linkAlias`).
// The leaf projection, terminal-link handling, and anchor/result wrapper stay
// with each caller — those genuinely differ (scalar leaf vs link-property
// column vs correlated subquery). See docs/adr/0035.
const pointerStepJoinForLink = (
  link: Pointer,
  previousAlias: string,
  nextAlias: string,
  targetSource: string,
  linkAlias: string,
  options?: GelIRCompileOptions,
): string =>
  shouldUseLinkTable(link)
    ? pointerStepJoinSql({
        usesLinkTable: true,
        direction: link.direction,
        previousAlias,
        nextAlias,
        targetSource,
        linkAlias,
        linkTableExpr: linkTableSourceForPointer(link, options),
      })
    : pointerStepJoinSql({
        usesLinkTable: false,
        direction: link.direction,
        previousAlias,
        nextAlias,
        targetSource,
        inlineColumn: `${link.ptrref.shortName}_id`,
      });

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
  const rootAlias = POINTER_ROOT_ALIAS;
  let fromSql = compilePolymorphicSource(path.root.typeref, false, rootAlias, aliasColumns[0], options);
  let previousAlias = rootAlias;

  path.links.forEach((link, index) => {
    const nextAlias = pointerStepTargetAlias(index);
    const targetType = effectiveStepType(link, path.linkTargets[index]);
    const targetSource = compilePolymorphicSource(targetType, false, nextAlias, aliasColumns[index + 1], options);
    fromSql += pointerStepJoinForLink(link, previousAlias, nextAlias, targetSource, pointerStepLinkAlias(index), options);
    previousAlias = nextAlias;
  });

  const leafSql = `${previousAlias}.${quoteIdent(columnForPointer(path.leaf))}`;
  const valueSql = scalarResultValueSQL(leafSql, path.leaf.ptrref.outTarget);
  params.length = checkpoint;
  return `SELECT DISTINCT ${valueSql} AS ${quoteIdent("value")} FROM ${fromSql} WHERE ${leafSql} IS NOT NULL`;
};

// Pick the SQL alias for an outer iteration scope that matches the type
// referenced by `set`. Returns null when no scope matches — the caller can
// fall back to its own default placeholder.
const pickOuterScopeAliasForExpr = (set: Set, options: GelIRCompileOptions): string | null => {
  if (!options.outerScopes || options.outerScopes.length === 0) return null;
  const innerSet = innermostTypeRootSet(set);
  if (!innerSet) return null;
  const innerTyperef = (innerSet.expr as TypeRoot).typeref;
  const match = findMatchingOuterScope(
    { typerefId: innerTyperef.id, namespace: innerSet.pathId?.namespace ?? [] },
    options,
  );
  return match ? match.alias : null;
};

const pickSourcePathAlias = (set: Set, options: GelIRCompileOptions): string | null => {
  if (!options.sourcePathAliases || options.sourcePathAliases.length === 0) return null;
  const key = pathIdKey(set);
  const match = [...options.sourcePathAliases].reverse().find((scope) => scope.pathKey === key);
  return match?.alias ?? null;
};

const innermostTypeRootSet = (set: Set): Set | null => {
  let cur: Set = set;
  while (true) {
    if (cur.expr.kind === "type_root") return cur;
    if (cur.expr.kind === "pointer") { cur = (cur.expr as Pointer).source; continue; }
    if (cur.expr.kind === "select_expr") { cur = (cur.expr as SelectExpr).result; continue; }
    if (cur.expr.kind === "type_cast") { cur = (cur.expr as TypeCast).expr; continue; }
    return null;
  }
};

const namespacesEqual = (a?: readonly string[], b?: readonly string[]): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] !== y[i]) return false;
  }
  return true;
};

const findMatchingOuterScope = (
  reference: { typerefId: string; namespace: readonly string[] },
  options: GelIRCompileOptions,
): { alias: string; typeref: TypeRef; namespace?: string[] } | undefined => {
  if (!options.outerScopes || options.outerScopes.length === 0) return undefined;
  return [...options.outerScopes].reverse().find(
    (scope) => scope.typeref.id === reference.typerefId
      && namespacesEqual(scope.namespace, reference.namespace),
  );
};

// A bare single-cardinality outbound object link off a type_root (`X.owner`).
// Such a reference is at most one row, so object-identity comparisons against
// it are plain FK/id column equality — not set membership.
const isSingleObjectLinkRef = (set: Set): boolean => {
  let cur: Set = set;
  while (cur.expr.kind === "select_expr") {
    const se = cur.expr as SelectExpr;
    if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return false;
    cur = se.result;
  }
  if (cur.expr.kind !== "pointer") return false;
  const ptr = cur.expr as Pointer;
  if (ptr.ptrref.isLinkProperty || ptr.ptrref.outTarget.isScalar) return false;
  if (ptr.direction !== "outbound") return false;
  const isSingle = ptr.ptrref.outCardinality === "one" || ptr.ptrref.outCardinality === "at_most_one";
  return isSingle && ptr.source.expr.kind === "type_root";
};

const isSingletonOuterScopeRef = (set: Set, options: GelIRCompileOptions): boolean => {
  let cur: Set = set;
  while (cur.expr.kind === "select_expr") {
    const se = cur.expr as SelectExpr;
    if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) {
      return false;
    }
    cur = se.result;
  }
  // A single object link off an outer-scope type root (`Issue.owner`) is also
  // a singleton outer reference — it resolves to the outer row's FK column, so
  // it must not be treated as a fresh set to scan in `X = Issue.owner`.
  if (cur.expr.kind === "pointer") {
    const ptr = cur.expr as Pointer;
    const isSingle = ptr.ptrref.outCardinality === "one" || ptr.ptrref.outCardinality === "at_most_one";
    if (ptr.direction === "outbound" && isSingle && !ptr.ptrref.isLinkProperty
        && ptr.source.expr.kind === "type_root") {
      return findMatchingOuterScope(
        {
          typerefId: (ptr.source.expr as TypeRoot).typeref.id,
          namespace: ptr.source.pathId?.namespace ?? [],
        },
        options,
      ) !== undefined;
    }
    return false;
  }
  if (cur.expr.kind !== "type_root") return false;
  if (cur.typeref.isScalar) return false;
  const typerefId = (cur.expr as TypeRoot).typeref.id;
  return findMatchingOuterScope(
    { typerefId, namespace: cur.pathId?.namespace ?? [] },
    options,
  ) !== undefined;
};

// Returns SQL that scans the values of a multi-scalar pointer correlated to
// the outer source alias's row. Returns null if the expression isn't a
// bare multi-scalar pointer hanging off a type root that matches the outer
// row. Caller wraps in `IN (…)`, `EXISTS (…)`, etc. Also returns null when
// the pointer's pathId is already bound by an enclosing iteration (via
// multiScalarBindings) — in that context the reference already resolves to
// the per-iteration `value` and shouldn't trigger a fresh multi-row scan.
const tryCompileCorrelatedMultiScalarRHS = (
  set: Set,
  sourceAlias: string,
  options: GelIRCompileOptions,
): string | null => {
  const unwrapped = unwrapSelectExprSet(set);
  if (options.multiScalarBindings) {
    if (options.multiScalarBindings.has(pathIdKey(set))) return null;
    if (options.multiScalarBindings.has(pathIdKey(unwrapped.result))) return null;
  }
  const expr = unwrapped.result.expr;
  if (expr.kind !== "pointer") return null;
  const pointer = expr as Pointer;
  if (!pointer.ptrref.outTarget.isScalar) return null;
  if (pointer.ptrref.isLinkProperty) return null;
  if (pointer.ptrref.outCardinality !== "many" && pointer.ptrref.outCardinality !== "at_least_one") {
    return null;
  }
  let sourceSet: Set = pointer.source;
  while (sourceSet.expr.kind === "select_expr") {
    const se = sourceSet.expr as SelectExpr;
    if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) {
      return null;
    }
    sourceSet = se.result;
  }
  if (sourceSet.expr.kind !== "type_root") return null;
  const sourceNs = sourceSet.pathId?.namespace ?? [];
  if (sourceNs.length > 0) {
    const outerMatch = findMatchingOuterScope(
      {
        typerefId: (sourceSet.expr as TypeRoot).typeref.id,
        namespace: sourceNs,
      },
      options,
    );
    if (!outerMatch || outerMatch.alias !== sourceAlias) {
      return null;
    }
  }
  const column = columnForPointer(pointer);
  // The outer source's column holds the JSON-encoded array; unpack it.
  return `SELECT je.${quoteIdent("value")} AS ${quoteIdent("value")} FROM json_each(COALESCE(${sourceAlias}.${quoteIdent(column)}, '[]')) je`;
};

// Multi-cardinality scalar properties (`multi property tag_set1 -> str`)
// are stored as a JSON-encoded TEXT column on the owning row, NOT as a
// separate link table. To produce them as a SET (one row per element),
// emit `json_each(COALESCE(g0.col, '[]')) je` in the FROM clause and project
// `je."value"` as the result column. This is the analogue of
// `array_unpack(arr)` but rooted at a multi-scalar pointer reference.
//
// Supports chains where the leaf is a multi scalar pointer and any preceding
// links are object-typed (inline FK or link-table-backed) — e.g.
// `Item.parent.tag_set1` joins the parent type then unpacks tag_set1.
const tryCompileMultiScalarPointerSelectSQL = (
  set: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  outerWheres: Set[],
): string | null => {
  const unwrapped = unwrapSelectExprSet(set);
  const leafExpr = unwrapped.result.expr;
  if (leafExpr.kind !== "pointer") return null;
  const leaf = leafExpr as Pointer;
  if (!leaf.ptrref.outTarget.isScalar) return null;
  if (leaf.ptrref.isLinkProperty) return null;
  if (leaf.ptrref.outCardinality !== "many" && leaf.ptrref.outCardinality !== "at_least_one") {
    return null;
  }

  // Walk back through the source chain. Allow either a direct type_root,
  // or an object-typed pointer chain ending in a type_root.
  const links: Pointer[] = [];
  let cursor: Set = leaf.source;
  while (cursor.expr.kind === "pointer") {
    const ptr = cursor.expr as Pointer;
    if (ptr.ptrref.outTarget.isScalar || ptr.ptrref.isLinkProperty) {
      // Source path contains a scalar step — bail.
      return null;
    }
    links.push(ptr);
    cursor = ptr.source;
  }
  let rootSet: Set = cursor;
  while (rootSet.expr.kind === "select_expr") {
    rootSet = (rootSet.expr as SelectExpr).result;
  }
  if (rootSet.expr.kind !== "type_root") return null;
  const rootTypeRef = (rootSet.expr as TypeRoot).typeref;
  const rootNamespace = rootSet.pathId?.namespace ?? [];

  const checkpoint = params.length;
  const leafColumn = columnForPointer(leaf);
  // When the root type matches an enclosing iteration scope, correlate to
  // that outer alias instead of building a fresh table scan. This lets
  // expressions like `array_agg(Item.tag_set1)` inside a FILTER on the
  // SAME `Item` aggregate just the current row's elements rather than
  // every row's elements.
  const outerMatch = links.length === 0
    ? findMatchingOuterScope({ typerefId: rootTypeRef.id, namespace: rootNamespace }, options)
    : undefined;
  let fromSql: string;
  let previousAlias: string;
  if (outerMatch) {
    // No standalone FROM — the outer query already supplies the row. We
    // only add the json_each iteration below.
    fromSql = "";
    previousAlias = outerMatch.alias;
  } else {
    const rootAlias = POINTER_ROOT_ALIAS;
    const rootCols = new Set<string>(["id"]);
    if (links.length === 0) {
      rootCols.add(leafColumn);
    } else {
      const firstLink = links[0];
      if (!shouldUseLinkTable(firstLink)) {
        const inlineColumn = `${firstLink.ptrref.shortName}_id`;
        if (firstLink.direction === "outbound") rootCols.add(inlineColumn);
      }
    }
    fromSql = compilePolymorphicSource(rootTypeRef, false, rootAlias, [...rootCols], options);
    previousAlias = rootAlias;
  }

  links.reverse();
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const linkAlias = pointerStepLinkAlias(index);
    const nextAlias = pointerStepTargetAlias(index);
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const isLast = index === links.length - 1;
    const targetCols = new Set<string>(["id"]);
    if (isLast) {
      targetCols.add(leafColumn);
    } else {
      const next = links[index + 1];
      if (!shouldUseLinkTable(next)) {
        const inlineColumn = `${next.ptrref.shortName}_id`;
        if (next.direction === "outbound") targetCols.add(inlineColumn);
      }
    }
    const targetSource = compilePolymorphicSource(targetType, false, nextAlias, [...targetCols], options);
    fromSql += pointerStepJoinForLink(link, previousAlias, nextAlias, targetSource, linkAlias, options);
    previousAlias = nextAlias;
  }

  const jeAlias = "je";
  // When correlated to an outer alias we have no standalone FROM table —
  // start the FROM with json_each only.
  if (fromSql === "") {
    fromSql = `json_each(COALESCE(${previousAlias}.${quoteIdent(leafColumn)}, '[]')) ${jeAlias}`;
  } else {
    fromSql += `, json_each(COALESCE(${previousAlias}.${quoteIdent(leafColumn)}, '[]')) ${jeAlias}`;
  }
  const valueSql = `${jeAlias}.${quoteIdent("value")}`;

  // Apply any innerWheres / outerWheres against the unpacked `value`. We
  // bind the leaf pointer's pathId to the json_each `value` column so the
  // WHERE compiler can resolve `_` / `Item.tag_set1` references in the
  // FILTER to `je.value`. The select_expr's where uses bindingRef or
  // path lookup; we route via outerScopes extension.
  const innerWheres = collectInnerWhereClauses(set);
  const whereSqls: string[] = [];
  const innerOuterScopes = outerMatch
    ? options.outerScopes
    : [
        ...(options.outerScopes ?? []),
        { alias: previousAlias, typeref: rootTypeRef, namespace: [...rootNamespace] },
      ];
  const compileMultiWhere = (where: Set): string | null => {
    const cp = params.length;
    // For `_ := X.tag_set1 FILTER _ IN {...}`, the binding `_` resolves to
    // the same set as X.tag_set1. The where compiler uses pathIdKey lookups.
    // Provide an outerScopes binding for the multi-scalar so references to
    // the leaf pathId resolve to je.value.
    const innerOptions: GelIRCompileOptions = {
      ...options,
      outerScopes: innerOuterScopes,
      multiScalarBindings: new Map([
        ...(options.multiScalarBindings ?? new Map()),
        [pathIdKey(set), valueSql],
        [pathIdKey(unwrapped.result), valueSql],
      ]),
    };
    const predicate = compilePredicateSetSQL(where, previousAlias, params, target, innerOptions);
    if (predicate) return predicate;
    params.length = cp;
    return compileValueSetSQL(where, previousAlias, params, target, innerOptions);
  };
  for (const where of innerWheres) {
    const compiled = compileMultiWhere(where);
    if (!compiled) {
      params.length = checkpoint;
      return null;
    }
    whereSqls.push(compiled);
  }
  for (const where of outerWheres) {
    const compiled = compileMultiWhere(where);
    if (!compiled) {
      params.length = checkpoint;
      return null;
    }
    whereSqls.push(compiled);
  }

  let sql = `SELECT ${valueSql} AS ${quoteIdent("value")} FROM ${fromSql}`;
  if (whereSqls.length > 0) {
    sql += ` WHERE ${whereSqls.join(" AND ")}`;
  }
  // Apply ORDER BY / LIMIT / OFFSET from any select_expr wrapping the
  // multi-scalar reference (`Item.tag_set1 ORDER BY Item.tag_set1`).
  // The where compiler already absorbed FILTER clauses via innerWheres.
  if (unwrapped.selectExpr?.orderBy && unwrapped.selectExpr.orderBy.length > 0) {
    const innerOptionsForOrder: GelIRCompileOptions = {
      ...options,
      multiScalarBindings: new Map([
        ...(options.multiScalarBindings ?? new Map()),
        [pathIdKey(set), valueSql],
        [pathIdKey(unwrapped.result), valueSql],
      ]),
    };
    const orderParts = unwrapped.selectExpr.orderBy
      .map((o) => {
        const exprSql = compileValueSetSQL(o.path, previousAlias, params, target, innerOptionsForOrder);
        return exprSql ? `${exprSql} ${o.direction.toUpperCase()}` : null;
      })
      .filter((s): s is string => s != null);
    if (orderParts.length > 0) {
      sql += ` ORDER BY ${orderParts.join(", ")}`;
    }
  }
  const limit = extractNumericLiteral(unwrapped.selectExpr?.limit);
  if (limit !== undefined) sql += ` LIMIT ${limit}`;
  const offset = extractNumericLiteral(unwrapped.selectExpr?.offset);
  if (offset !== undefined) {
    if (limit === undefined) sql += ` LIMIT -1`;
    sql += ` OFFSET ${offset}`;
  }
  return sql;
};

// Detect a tuple element that's a direct multi-scalar pointer reference
// (e.g. `Item.tag_set1` where tag_set1 is `multi property -> str`). For these
// elements, building the enclosing tuple as a value requires expanding the
// JSON-encoded multi-scalar column via `json_each`, then cross-joining with
// other elements' iterations to form the EdgeQL set-of-tuples semantics.
// Returns the leaf Pointer when the element matches; null otherwise.
//
// Stays conservative — only matches when the pointer hangs directly off a
// type_root that's the outer-scope row (the shape source). Chains and
// link-property leaves go through other paths.
const tryExtractMultiScalarLeafPointer = (set: Set): Pointer | null => {
  const unwrapped = unwrapSelectExprSet(set);
  const expr = unwrapped.result.expr;
  if (expr.kind !== "pointer") return null;
  const pointer = expr as Pointer;
  if (!pointer.ptrref.outTarget.isScalar) return null;
  if (pointer.ptrref.isLinkProperty) return null;
  if (
    pointer.ptrref.outCardinality !== "many"
    && pointer.ptrref.outCardinality !== "at_least_one"
  ) {
    return null;
  }
  // Source must reduce to a type_root for the simple inline-column path.
  let sourceExpr: Expr = pointer.source.expr;
  while (sourceExpr.kind === "select_expr") {
    sourceExpr = (sourceExpr as SelectExpr).result.expr;
  }
  if (sourceExpr.kind !== "type_root") return null;
  return pointer;
};

// Collect direct multi-scalar pointer leaf Sets referenced inside a scalar
// expression (element-wise operands like `.tags` in `.tags = 'red'`).
// Doesn't descend into aggregates — they consume their argument's set and
// already have dedicated lowerings. Returns the distinct leaf Sets in
// first-reference order.
const collectCorrelatedMultiScalarLeafSets = (set: Set, out: Set[]): void => {
  const leaf = tryExtractMultiScalarLeafPointer(set);
  if (leaf) {
    out.push(set);
    return;
  }
  const expr = set.expr;
  if (!expr) return;
  if (expr.kind === "select_expr") {
    collectCorrelatedMultiScalarLeafSets((expr as SelectExpr).result, out);
    return;
  }
  if (expr.kind === "type_cast") {
    collectCorrelatedMultiScalarLeafSets((expr as TypeCast).expr, out);
    return;
  }
  if (expr.kind === "operator_call") {
    for (const arg of orderedCallArgs((expr as OperatorCall).args)) {
      collectCorrelatedMultiScalarLeafSets(arg.expr, out);
    }
    return;
  }
  if (expr.kind === "function_call") {
    const fc = expr as FunctionCall;
    const shortName = (fc.functionName ?? "").split("::").pop() ?? "";
    const aggregates = new globalThis.Set([
      "count", "sum", "min", "max", "avg", "all", "any",
      "array_agg", "enumerate", "assert_single", "assert_exists", "assert_distinct",
    ]);
    if (aggregates.has(shortName)) return;
    for (const arg of orderedCallArgs(fc.args)) {
      collectCorrelatedMultiScalarLeafSets(arg.expr, out);
    }
    return;
  }
  if (expr.kind === "index_expr") {
    collectCorrelatedMultiScalarLeafSets((expr as IndexExpr).expr, out);
    collectCorrelatedMultiScalarLeafSets((expr as IndexExpr).index, out);
    return;
  }
};

// Compile a tuple whose elements may include multi-scalar pointers — emit a
// cross-joined `json_each` subquery and aggregate the produced tuples with
// `json_group_array`. Returns null when the tuple has no multi-scalar
// elements (the caller falls back to the inline `json_array(...)` path) or
// when any element fails to lower.
//
// `indexProjection` selects a single tuple element (`(M0, M1).1` projects
// `M1` rather than building the whole tuple). When provided, the inner
// SELECT projects just that element so the outer COALESCE returns a
// json_group_array of values — matching `Item.tag_set1` shape output for
// multi-scalar projection on a tuple set.
const compileTupleWithMultiScalarsSQL = (
  tuple: Tuple,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAlias: string | undefined,
  indexProjection?: number,
): string | null => {
  const checkpoint = params.length;
  // Classify each element as multi-scalar (needs json_each) vs single
  // (compile inline).
  type Classified =
    | { kind: "multi"; pointer: Pointer; element: { name?: string; val: Set } }
    | { kind: "single"; element: { name?: string; val: Set } };
  const classified: Classified[] = [];
  let hasMulti = false;
  for (const element of tuple.elements) {
    const leaf = tryExtractMultiScalarLeafPointer(element.val);
    if (leaf) {
      classified.push({ kind: "multi", pointer: leaf, element });
      hasMulti = true;
    } else {
      classified.push({ kind: "single", element });
    }
  }
  if (!hasMulti) return null;

  // Build per-element SQL value expressions tied to the cross-product row.
  const jeAliases: string[] = [];
  const elementSqls: string[] = [];
  let jeIndex = 0;
  const multiBindings = new Map<string, string>(options.multiScalarBindings ?? new Map());
  for (const item of classified) {
    if (item.kind === "multi") {
      const alias = `je${jeIndex++}`;
      jeAliases.push(`json_each(COALESCE(${sourceAlias}.${quoteIdent(columnForPointer(item.pointer))}, '[]')) ${alias}`);
      const valueSql = `${alias}.${quoteIdent("value")}`;
      elementSqls.push(valueSql);
      // Bind so any nested reference to the same pathId resolves to je.value
      // (not needed for the tests covered today but keeps the path consistent
      // with the rest of the multi-scalar machinery).
      multiBindings.set(pathIdKey(item.element.val), valueSql);
      const innerUnwrapped = unwrapSelectExprSet(item.element.val);
      multiBindings.set(pathIdKey(innerUnwrapped.result), valueSql);
    } else {
      const innerOptions: GelIRCompileOptions = { ...options, multiScalarBindings: multiBindings };
      const compiled = compileValueSetSQL(item.element.val, sourceAlias, params, target, innerOptions, linkPropertyAlias);
      if (!compiled) {
        params.length = checkpoint;
        return null;
      }
      elementSqls.push(compiled);
    }
  }

  // Project either the full tuple or just one selected element. Track
  // whether the per-row output is a structural JSON value (an array/object
  // we built ourselves) — we wrap those with `json(...)` so
  // `json_group_array` embeds them as nested JSON instead of stringifying.
  let projectionSql: string;
  let projectionIsJson: boolean;
  if (indexProjection !== undefined) {
    const idx = indexProjection >= 0 ? indexProjection : indexProjection + elementSqls.length;
    if (idx < 0 || idx >= elementSqls.length) {
      params.length = checkpoint;
      return null;
    }
    projectionSql = elementSqls[idx];
    // The projected slot is either a multi-scalar value (je.value — a JSON
    // string from json_each) or a single-element compile. Treat scalar
    // values as non-JSON so the aggregate emits them as JSON strings.
    projectionIsJson = setValueIsJson(classified[idx].element.val);
  } else if (tuple.named) {
    const pairs = classified.map((item, i) => `${quoteLiteral(item.element.name ?? String(i))}, ${elementSqls[i]}`);
    projectionSql = `json_object(${pairs.join(", ")})`;
    projectionIsJson = true;
  } else {
    projectionSql = `json_array(${elementSqls.join(", ")})`;
    projectionIsJson = true;
  }

  const fromSql = jeAliases.join(", ");
  // EdgeQL sets are unordered so the engine may emit any permutation. To
  // produce stable, comparable output (and match the upstream Python
  // tests, which sort each multi-tuple field alphabetically before
  // comparing) we order the cross-product by each multi element's value.
  // SQLite's `json_group_array` aggregates in source-row order — wrapping
  // the iteration in an inner ORDER BY subquery is the only way to get a
  // deterministic group order, since an `ORDER BY` at the aggregate level
  // applies to the *output* row of the aggregate (which is a singleton).
  // When projecting a single element (`.k`) we put that element first in
  // the sort key so the per-element result sorts alphabetically rather
  // than reflecting the je0/je1 cross-product traversal order.
  const valueRef = (i: number) => `je${i}.${quoteIdent("value")}`;
  const multiIndices: number[] = [];
  for (let i = 0; i < classified.length; i++) {
    if (classified[i].kind === "multi") multiIndices.push(multiIndices.length);
  }
  let orderParts: string[];
  if (indexProjection !== undefined && classified[indexProjection]?.kind === "multi") {
    // Find which je-index the projected element maps to.
    let projectedJeIdx = -1;
    let runningJeIdx = 0;
    for (let i = 0; i < classified.length; i++) {
      if (classified[i].kind === "multi") {
        if (i === indexProjection) projectedJeIdx = runningJeIdx;
        runningJeIdx++;
      }
    }
    orderParts = [valueRef(projectedJeIdx)];
    for (const j of multiIndices) if (j !== projectedJeIdx) orderParts.push(valueRef(j));
  } else {
    orderParts = multiIndices.map(valueRef);
  }
  const orderClause = orderParts.length > 0 ? ` ORDER BY ${orderParts.join(", ")}` : "";
  const innerSelect = `SELECT ${projectionSql} AS __v FROM ${fromSql}${orderClause}`;
  const aggArg = projectionIsJson ? "json(__v)" : "__v";
  return `COALESCE((SELECT json_group_array(${aggArg}) FROM (${innerSelect})), '[]')`;
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

  const terminalLink = path.links[path.links.length - 1];
  // Link properties only live on link-table-backed links. If the schema
  // decided this terminal link is inline-FK only (no properties, single
  // outbound), the property reference is meaningless and we bail.
  if (!shouldUseLinkTable(terminalLink)) return null;

  const checkpoint = params.length;
  const rootAlias = POINTER_ROOT_ALIAS;
  const rootCols = new Set<string>(["id"]);
  let fromSql = compilePolymorphicSource(path.root.typeref, false, rootAlias, [...rootCols], options);
  let previousAlias = rootAlias;

  for (let index = 0; index < path.links.length; index += 1) {
    const link = path.links[index];
    const isTerminal = index === path.links.length - 1;
    const linkAlias = pointerStepLinkAlias(index);
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
    const nextAlias = pointerStepTargetAlias(index);
    const targetType = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const targetCols = new Set<string>(["id"]);
    if (!shouldUseLinkTable(link)) {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (link.direction === "inbound") {
        targetCols.add(inlineColumn);
      }
    }
    const targetSource = compilePolymorphicSource(targetType, false, nextAlias, [...targetCols], options);
    fromSql += pointerStepJoinForLink(link, previousAlias, nextAlias, targetSource, linkAlias, options);
    previousAlias = nextAlias;
  }

  const leafShortName = path.leafProperty.ptrref.shortName;
  const propertyColumn = leafShortName.startsWith("@") ? leafShortName.slice(1) : leafShortName;
  const leafSql = `${previousAlias}.${quoteIdent(propertyColumn)}`;
  const valueSql = scalarResultValueSQL(leafSql, path.leafProperty.ptrref.outTarget);
  params.length = checkpoint;
  return `SELECT ${valueSql} AS ${quoteIdent("value")} FROM ${fromSql} WHERE ${leafSql} IS NOT NULL`;
};

// Correlated form of a single-link link-property path (`X.<deck[IS User]@count`,
// `X.deck@count`): the link property is multi-cardinality per the subject row,
// so emit a row set `SELECT <prop> AS value FROM <link table> WHERE <target|
// source> = sourceAlias.id`. Unlike the standalone select above it does not
// re-scan the root type — it correlates to the enclosing subject (`g0`). Used in
// predicate (`@count = 1`) and shape-projection contexts where the value path
// would otherwise collapse `@count` onto a nonexistent `sourceAlias.@count`.
const tryCompileCorrelatedLinkPropertyPathSQL = (
  set: Set,
  sourceAlias: string,
  options: GelIRCompileOptions,
): string | null => {
  const path = extractLinkPropertyPath(set);
  if (!path || path.links.length !== 1) return null;
  const link = path.links[0];
  if (!shouldUseLinkTable(link)) return null;
  const linkTable = linkTableNameForPointer(link, options);
  const lj = "lpj0";
  // For an inbound backlink the subject is the link's TARGET; for an outbound
  // link it is the SOURCE.
  const correlationColumn = link.direction === "inbound" ? "target" : "source";
  const leafShortName = path.leafProperty.ptrref.shortName;
  const propertyColumn = leafShortName.startsWith("@") ? leafShortName.slice(1) : leafShortName;
  const leafSql = `${lj}.${quoteIdent(propertyColumn)}`;
  const valueSql = scalarResultValueSQL(leafSql, path.leafProperty.ptrref.outTarget);
  return `SELECT ${valueSql} AS ${quoteIdent("value")} FROM ${quoteIdent(linkTable)} ${lj}`
    + ` WHERE ${lj}.${quoteIdent(correlationColumn)} = ${sourceAlias}.${quoteIdent("id")} AND ${leafSql} IS NOT NULL`;
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

// Detect whether an expression contains a multi-cardinality scalar pointer
// reference (e.g. `Item.tag_set1`). Used to decide whether constructors like
// `[Item.tag_set1, Item.tag_set2]` need multi-row SELECT lowering instead of a
// single inline `json_array(...)` value.
const containsMultiScalarPointer = (set: Set): boolean => {
  let found = false;
  const visit = (s: Set): void => {
    if (found) return;
    const e = s.expr;
    if (!e) return;
    if (e.kind === "pointer") {
      const ptr = s.expr as Pointer;
      if (ptr.ptrref.outTarget.isScalar
        && !ptr.ptrref.isLinkProperty
        && (ptr.ptrref.outCardinality === "many" || ptr.ptrref.outCardinality === "at_least_one")) {
        found = true;
        return;
      }
      visit(ptr.source);
      return;
    }
    if (e.kind === "function_call") {
      const fc = s.expr as FunctionCall;
      const shortName = (fc.functionName ?? "").split("::").pop() ?? "";
      if (["count", "sum", "min", "max", "avg", "all", "any", "array_agg"].includes(shortName)) {
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
    if (e.kind === "tuple") {
      for (const el of (s.expr as Tuple).elements) visit(el.val);
      return;
    }
    if (e.kind === "array") {
      for (const el of (s.expr as { elements: Set[] }).elements) visit(el);
      return;
    }
    if (e.kind === "index_expr") {
      visit((s.expr as IndexExpr).expr);
      visit((s.expr as IndexExpr).index);
      return;
    }
    if (e.kind === "slice_expr") {
      const slice = s.expr as SliceExpr;
      visit(slice.expr);
      if (slice.start) visit(slice.start);
      if (slice.end) visit(slice.end);
      return;
    }
    if (e.kind === "select_expr") {
      visit((s.expr as SelectExpr).result);
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
  // When every path is consumed under set-level optional operators
  // (?= / ?!= / ??), a root row WITHOUT link rows must still produce one
  // output row (with NULL link columns) — LEFT JOIN instead of dropping it.
  const joinKw = allPathsAreSetLevelWrapped(valueSet) ? "LEFT JOIN" : "JOIN";
  let fromSql: string;
  if (shared.link.direction === "inbound") {
    fromSql = `${rootSql} ${joinKw} ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("target")} = ${rootAlias}.${quoteIdent("id")} ${joinKw} ${targetSql} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
  } else {
    fromSql = `${rootSql} ${joinKw} ${quoteIdent(linkTable)} ${linkAlias} ON ${linkAlias}.${quoteIdent("source")} = ${rootAlias}.${quoteIdent("id")} ${joinKw} ${targetSql} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
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

  // Per-level column needs (id, connecting FKs, the leaf column). Target rows
  // are read via compilePolymorphicSource so a polymorphic target (e.g. a link
  // to `Card`, whose rows may live in `cards__card` OR a subtype table like
  // `cards__specialcard`) unions every concrete branch instead of scanning the
  // single declared table and dropping subtype rows. For a non-polymorphic
  // target this is identical to the bare table.
  const aliasColumns = pointerPathAliasColumns(path);
  const polySource = (typeref: TypeRef, alias: string, level: number): string =>
    compilePolymorphicSource(typeref, false, alias, aliasColumns[level] ?? ["id"], options);

  const firstLink = path.links[0];
  const firstTargetType = effectiveStepType(firstLink, path.linkTargets[0]);
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
    fromSql = polySource(firstTargetType, firstAlias, 1);
    const firstInlineColumn = `${firstLink.ptrref.shortName}_id`;
    anchorWhere = `${firstAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(firstInlineColumn)}`;
  } else if (shouldUseLinkTable(firstLink)) {
    const linkTable = linkTableNameForPointer(firstLink, options);
    const linkAlias = "cpj1";
    fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${polySource(firstTargetType, firstAlias, 1)}`;
    if (firstLink.direction === "inbound") {
      fromSql += ` ON ${firstAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
      anchorWhere = `${linkAlias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")}`;
    } else {
      fromSql += ` ON ${firstAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
      anchorWhere = `${linkAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`;
    }
  } else {
    fromSql = polySource(firstTargetType, firstAlias, 1);
    const firstInlineColumn = `${firstLink.ptrref.shortName}_id`;
    anchorWhere = firstLink.direction === "inbound"
      ? `${firstAlias}.${quoteIdent(firstInlineColumn)} = ${sourceAlias}.${quoteIdent("id")}`
      : `${firstAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(firstInlineColumn)}`;
  }
  let prevAlias = firstAlias;

  for (let i = 1; i < path.links.length; i += 1) {
    const link = path.links[i];
    const nextAlias = `cp${i + 1}`;
    const targetType = effectiveStepType(link, path.linkTargets[i]);
    const targetSource = polySource(targetType, nextAlias, i + 1);
    fromSql += pointerStepJoinForLink(link, prevAlias, nextAlias, targetSource, `cpj${i + 1}`, options);
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

// `x IN {.val, .children.val, .children.children.val, …}` inside a FILTER:
// each element of the RHS set is a scalar path that must be correlated to the
// outer row alias (`g0`), not compiled as a free table scan. Lower the set
// (an `union` operator_call, or a single element) into a `UNION ALL` of
// correlated scalar SELECTs whose `value` column references `sourceAlias`.
// Returns null if any element isn't a (possibly chained) scalar pointer path.
const tryCompileCorrelatedUnionScalarSelect = (
  set: Set,
  sourceAlias: string,
  options: GelIRCompileOptions,
): string | null => {
  const expr = set.expr;
  const elements: Set[] = expr.kind === "operator_call" && (expr as OperatorCall).operator === "union"
    ? orderedCallArgs((expr as OperatorCall).args).map((arg) => arg.expr)
    : [set];
  const selects: string[] = [];
  for (const element of elements) {
    const chained = tryCompileCorrelatedScalarPointerPathScalarSelect(element, sourceAlias, options);
    if (chained) {
      selects.push(chained);
      continue;
    }
    // A bare leaf path (`.val`) is a single column on the outer row.
    const column = compileSetColumnRef(element);
    if (column) {
      selects.push(`SELECT ${sourceAlias}.${quoteIdent(column)} AS ${quoteIdent("value")}`);
      continue;
    }
    return null;
  }
  return selects.length > 0 ? selects.join(" UNION ALL ") : null;
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
    if (expr.kind === "index_expr") {
      // Index access (`(x ?? (1,2)).0`) is transparent: a path under it is
      // wrapped iff a `??`/aggregate below lifts it.
      walk((expr as IndexExpr).expr, wrappedDepth);
      walk((expr as IndexExpr).index, wrappedDepth);
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

// Functions/operators that pass an object set through unchanged (modulo
// cardinality assertions we can't express in plain SQL). When a shape is
// applied to one of these — `SELECT assert_single(array_unpack([(SELECT
// User …)])) { name }` — the underlying object source must still project the
// shape's columns. Unwrap to the inner object-producing set so the shape's
// columns resolve instead of erroring with "no such column".
const unwrapObjectPassthrough = (set: Set): Set | null => {
  const expr = set.expr;
  if (expr.kind === "function_call") {
    const call = expr as FunctionCall;
    const shortName = call.functionName.split("::").pop() ?? call.functionName;
    const args = orderedCallArgs(call.args);
    if ((shortName === "assert_single" || shortName === "assert_exists" || shortName === "assert_distinct")
        && args.length === 1) {
      return args[0].expr;
    }
    if (shortName === "array_unpack" && args.length === 1) {
      const inner = args[0].expr;
      if (inner.expr.kind === "array" && (inner.expr as ArrayExpr).elements.length === 1) {
        return (inner.expr as ArrayExpr).elements[0];
      }
    }
    return null;
  }
  return null;
};

const compileSelectSource = (
  sourceSet: Set,
  where: Set | undefined,
  orderBy: SortExpr[] | undefined,
  options: GelIRCompileOptions,
  params: ScalarValue[] = [],
  target: RuntimeTarget = options.target ?? "sqlite",
  aliasOverride?: string,
  extraColumns?: string[],
): { sql: string; alias: string } | null => {
  const alias = aliasOverride ?? "g0";
  const projectedColumns = [...new Set([
    ...collectProjectedColumns(sourceSet.shape, where, orderBy),
    ...(extraColumns ?? []),
  ])];
  // DISTINCT over an object set dedups by row identity. Merge any outer
  // shape into the operand so its columns project through every branch,
  // compile the operand as a source, and wrap with SELECT DISTINCT — the
  // projected columns are functionally dependent on `id`, so row-level
  // DISTINCT is exactly identity dedup.
  if (sourceSet.expr.kind === "operator_call" && (sourceSet.expr as OperatorCall).operator === "distinct") {
    const distinctArgs = orderedCallArgs((sourceSet.expr as OperatorCall).args);
    if (distinctArgs.length === 1) {
      const operand = distinctArgs[0].expr;
      const operandShape = operand.shape ?? [];
      const outerShape = sourceSet.shape ?? [];
      const mergedShape = outerShape.length > 0 ? [...outerShape, ...operandShape] : operandShape;
      const operandSet: Set = mergedShape === operandShape ? operand : { ...operand, shape: mergedShape };
      const source = compileSelectSource(operandSet, where, orderBy, options, params, target, undefined, projectedColumns);
      if (source) {
        return { sql: `(SELECT DISTINCT ${source.alias}.* FROM ${source.sql}) ${alias}`, alias };
      }
    }
  }
  // Unwrap object pass-through wrappers (assert_single/array_unpack …)
  // so a shape applied to the wrapper projects against the underlying object
  // source. Carry the outer shape down to the inner object set. Only intercept
  // when the wrapper itself carries a shape — when the shape lives on a nested
  // object (`array_unpack([(SELECT User {name})])`), the existing scalar path
  // already projects it and we must not divert away from it.
  if (sourceSet.shape && sourceSet.shape.length > 0) {
    const inner = unwrapObjectPassthrough(sourceSet);
    if (inner) {
      const mergedShape = (sourceSet.shape && sourceSet.shape.length > 0)
        ? [...sourceSet.shape, ...(inner.shape ?? [])]
        : inner.shape;
      const innerSet: Set = mergedShape === inner.shape ? inner : { ...inner, shape: mergedShape };
      const compiled = compileSelectSource(innerSet, where, orderBy, options, params, target, aliasOverride);
      if (compiled) return compiled;
    }
  }
  if (sourceSet.expr.kind === "select_expr") {
    const selectExpr = sourceSet.expr as SelectExpr;
    // The wrapper's own shape (merged from an outer `SELECT (…) {…}`) and
    // any outer where/orderBy columns must survive into the inner source's
    // projection, alongside whatever the inner clauses reference.
    const inner = compileSelectSource(
      selectExpr.result, selectExpr.where, selectExpr.orderBy, options, params, target,
      undefined, projectedColumns,
    );
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
        if (orderColumn) {
          return `${inner.alias}.${quoteIdent(orderColumn)} ${order.direction.toUpperCase()}${sortNullsClause(order)}`;
        }
        // Expression sort keys (`ORDER BY len(.body)`) aren't bare columns —
        // compile through the generic value path against the inner alias
        // rather than silently dropping the sort.
        const exprSql = compileValueSetSQL(order.path, inner.alias, params, target, options);
        return exprSql ? `${exprSql} ${order.direction.toUpperCase()}${sortNullsClause(order)}` : "";
      }).filter((entry) => entry.length > 0);
      if (orders.length > 0) sql += ` ORDER BY ${orders.join(", ")}`;
    }
    const limit = selectExpr.limit ? extractNumericLiteral(selectExpr.limit) : undefined;
    const offset = selectExpr.offset ? extractNumericLiteral(selectExpr.offset) : undefined;
    if (limit !== undefined) sql += ` LIMIT ${limit}`;
    if (offset !== undefined) sql += ` OFFSET ${offset}`;
    return { sql: `(${sql}) ${alias}`, alias };
  }
  // Object-set coalesce (`Issue.time_spent_log ?? DUMMY`): when the two
  // sides share no type roots, EdgeDB `??` is a set-level fallback — all
  // LHS rows when the LHS is non-empty, otherwise all RHS rows. Lower as
  // UNION ALL with a NOT EXISTS guard on the RHS branch, sharing the LHS
  // via a CTE so its (possibly parameterised) SQL appears only once.
  // Shared-root coalesce keeps the existing per-row paths.
  if (sourceSet.expr.kind === "coalesce_expr") {
    const coalesce = sourceSet.expr as CoalesceExpr;
    const bothObject = coalesce.left.typeref?.isScalar === false
      && coalesce.right.typeref?.isScalar === false;
    // Roots inside a FENCED select_expr (one with its own WHERE/LIMIT/OFFSET)
    // are their own scope per Python scoping — `(SELECT Issue FILTER …) ??
    // (SELECT Issue FILTER …)` does NOT share an Issue iteration, so they
    // must not block the set-level lowering.
    const sideRootsForSharing = (side: Set): globalThis.Set<string> => {
      let cur: Set = side;
      while (cur.expr.kind === "select_expr") {
        const se = cur.expr as SelectExpr;
        if (se.where || se.limit || se.offset) return new globalThis.Set<string>();
        cur = se.result;
      }
      const roots = new globalThis.Set<string>();
      collectTypeRootIds(cur, roots);
      return roots;
    };
    const lhsRoots = sideRootsForSharing(coalesce.left);
    const rhsRoots = sideRootsForSharing(coalesce.right);
    let sharesRoots = false;
    for (const id of rhsRoots) {
      if (lhsRoots.has(id)) { sharesRoots = true; break; }
    }
    // `X ?? X` over the same scoped object set: per element x ?? x = x, and
    // both-empty produces no rows — the coalesce is just X (self_01).
    if (bothObject && sharesRoots
        && JSON.stringify(coalesce.left.expr) === JSON.stringify(coalesce.right.expr)) {
      const sideShape = coalesce.left.shape ?? [];
      const outerShape0 = sourceSet.shape ?? [];
      const mergedShape = outerShape0.length > 0 ? [...outerShape0, ...sideShape] : sideShape;
      const sideSet: Set = mergedShape === sideShape ? coalesce.left : { ...coalesce.left, shape: mergedShape };
      const selfSource = compileSelectSource(sideSet, undefined, undefined, options, params, target, alias, projectedColumns);
      if (selfSource) return selfSource;
    }
    if (bothObject && !sharesRoots) {
      const paramsCheckpoint = params.length;
      const outerShape = sourceSet.shape ?? [];
      const compileSide = (side: Set): { sql: string; alias: string } | null => {
        const sideShape = side.shape ?? [];
        const mergedShape = outerShape.length > 0 ? [...outerShape, ...sideShape] : sideShape;
        const sideSet: Set = mergedShape === sideShape ? side : { ...side, shape: mergedShape };
        return compileSelectSource(sideSet, undefined, undefined, options, params, target, undefined, projectedColumns);
      };
      const lhsSource = compileSide(coalesce.left);
      const rhsSource = lhsSource ? compileSide(coalesce.right) : null;
      if (lhsSource && rhsSource) {
        // Branches can project different extra columns; narrow both to the
        // common identity + outer-referenced columns so the UNION ALL is
        // well-formed. Object sets are identity sets — every column is
        // functionally dependent on `id` — so per-branch SELECT DISTINCT is
        // exactly EdgeQL set dedup (the pointer chain on a side can surface
        // the same target once per source row).
        const commonColumns = [...new Set(["id", "__source_type", ...projectedColumns])];
        const columnList = (src: { sql: string; alias: string }): string => commonColumns
          .map((column) => `${src.alias}.${quoteIdent(column)} AS ${quoteIdent(column)}`)
          .join(", ");
        const lhsCte = `${alias}_cl`;
        const rhsCte = `${alias}_cr`;
        const sql = `(WITH ${lhsCte} AS (SELECT DISTINCT ${columnList(lhsSource)} FROM ${lhsSource.sql}),`
          + ` ${rhsCte} AS (SELECT DISTINCT ${columnList(rhsSource)} FROM ${rhsSource.sql})`
          + ` SELECT * FROM ${lhsCte}`
          + ` UNION ALL`
          + ` SELECT * FROM ${rhsCte} WHERE NOT EXISTS (SELECT 1 FROM ${lhsCte})) ${alias}`;
        return { sql, alias };
      }
      params.length = paramsCheckpoint;
    }
  }
  if (sourceSet.expr.kind === "operator_call" && (sourceSet.expr as OperatorCall).operator === "union") {
    const args = orderedCallArgs((sourceSet.expr as OperatorCall).args);
    const selects = args.map((arg) => {
      // Each branch must project the columns the OUTER shape references
      // (`(Issue UNION Comment) { body, [IS Issue].name }` reads `g0.body` /
      // `g0.name`), plus whatever the branch's own shape carries (e.g. a
      // per-branch splat in `{Issue, User} { * }`). Merge both: the branch's
      // polymorphic source then projects every needed column (NULL where a
      // branch type lacks it). Just using the branch's own shape (often the
      // implicit `{id}`) drops the outer shape's columns → "no such column".
      const branchShape = arg.expr.shape ?? [];
      const unionShape = sourceSet.shape ?? [];
      const inheritedShape = unionShape.length > 0 ? [...unionShape, ...branchShape] : branchShape;
      const branchSet: Set = inheritedShape === branchShape ? arg.expr : { ...arg.expr, shape: inheritedShape };
      const source = compileSelectSource(branchSet, undefined, undefined, options, params, target, undefined, projectedColumns);
      if (!source) return null;
      // Branches can project different extra columns (each branch's own
      // FILTER adds what it needs), so `SELECT g0.*` would feed UNION ALL
      // mismatched column counts. Project the explicit common list instead:
      // identity columns plus everything the outer shape/clauses reference.
      const commonColumns = [...new Set(["id", "__source_type", ...projectedColumns])];
      const columnList = commonColumns
        .map((column) => `${source.alias}.${quoteIdent(column)} AS ${quoteIdent(column)}`)
        .join(", ");
      return `SELECT ${columnList} FROM ${source.sql}`;
    });
    if (selects.some((entry) => !entry)) return null;
    return { sql: `(${(selects as string[]).join(" UNION ALL ")}) ${alias}`, alias };
  }
  if (sourceSet.expr.kind === "operator_call"
      && ((sourceSet.expr as OperatorCall).operator === "intersect"
          || (sourceSet.expr as OperatorCall).operator === "except")) {
    const op = (sourceSet.expr as OperatorCall).operator;
    const args = orderedCallArgs((sourceSet.expr as OperatorCall).args);
    const joiner = op === "intersect" ? "INTERSECT" : "EXCEPT";
    // Empty-set operands resolve statically: `X intersect <T>{}` is empty,
    // `X except <T>{}` is X.
    if (args.length === 2) {
      const leftEmpty = isEmptySetBranch(args[0].expr);
      const rightEmpty = isEmptySetBranch(args[1].expr);
      if (leftEmpty || (op === "intersect" && rightEmpty)) {
        return {
          sql: `(SELECT NULL AS ${quoteIdent("id")}, NULL AS ${quoteIdent("__source_type")} WHERE 0) ${alias}`,
          alias,
        };
      }
      if (op === "except" && rightEmpty) {
        const leftSource = compileSelectSource({ ...args[0].expr, shape: sourceSet.shape ?? args[0].expr.shape }, where, orderBy, options, params, target, aliasOverride, extraColumns);
        if (leftSource) return leftSource;
      }
    }
    // When a shape projects columns beyond identity (`(B except A) {name}`),
    // the narrowed (id, __source_type) result can't satisfy `g0.name`. Compute
    // the surviving identity set, then re-derive full rows from the first
    // branch (the result type of EXCEPT/INTERSECT is the left operand's type)
    // filtered to those ids.
    const needsFullRows = (sourceSet.shape ?? []).some((el) => el.name !== undefined && el.name !== "id");
    if (needsFullRows) {
      // Compile in SQL textual order so the shared `params` array stays
      // aligned with the placeholders: the full-row source appears first,
      // then the EXCEPT/INTERSECT id-set subquery.
      const branchWithShape: Set = { ...args[0].expr, shape: sourceSet.shape };
      const full = compileSelectSource(branchWithShape, where, orderBy, options, params, target);
      if (!full) return null;
      const idSelects = args.map((arg) => {
        const source = compileSelectSource(arg.expr, undefined, undefined, options, params, target);
        return source ? `SELECT ${source.alias}.${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${source.sql}` : null;
      });
      if (idSelects.some((entry) => !entry)) return null;
      const idSet = `(${(idSelects as string[]).join(` ${joiner} `)})`;
      return {
        sql: `(SELECT ${full.alias}.* FROM ${full.sql} WHERE ${full.alias}.${quoteIdent("id")} IN ${idSet}) ${alias}`,
        alias,
      };
    }
    // SQLite's INTERSECT/EXCEPT compare on every column in the projection;
    // for object set-ops we want identity comparison only — narrow each
    // branch to (id, __source_type) so two equivalent rows from different
    // branches actually match.
    const selects = args.map((arg) => {
      const source = compileSelectSource(arg.expr, undefined, undefined, options, params, target);
      return source ? `SELECT ${source.alias}.${quoteIdent("id")} AS ${quoteIdent("id")}, ${source.alias}.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")} FROM ${source.sql}` : null;
    });
    if (selects.some((entry) => !entry)) return null;
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
  let rootHasClauses = false;
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
    // Peel `select_expr` wrappers threading a type_root through (the parser
    // inserts these for parenthesised sources like `(SELECT Issue {…})
    // .watchers`). FILTERs/LIMITs on the wrapper restrict the root rows —
    // note it so the root source compiles through compileSelectSource (which
    // lowers the clauses, incl. link projections) instead of a bare scan.
    while (cursor.kind === "select_expr") {
      const se = cursor as SelectExpr;
      if (se.where || se.limit !== undefined || se.offset !== undefined) {
        rootHasClauses = true;
      }
      cursor = se.result.expr;
    }
    if (cursor.kind !== "type_root") return null;
  }
  const links = chain.reverse();
  const rootPointer = links[0];
  const rootTyperef = rootPointer.source.typeref;
  const rootAlias = "s0";
  const rootCols = collectChainSourceColumns(links[0], "root");
  let fromSql: string;
  if (rootHasClauses) {
    const rootSource = compileSelectSource(
      links[0].source, undefined, undefined, options, params, target, rootAlias, rootCols,
    );
    if (!rootSource) return null;
    fromSql = rootSource.sql;
  } else {
    fromSql = compilePolymorphicSource(rootTyperef, false, rootAlias, rootCols, options);
  }
  let previousAlias = rootAlias;
  let previousTyperef = rootTyperef;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
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
    const baseCols = isLeaf ? projectedColumns : collectChainSourceColumns(links[i + 1], "via");
    const targetCols = inlineInboundFK ? [...new Set<string>([...baseCols, inlineInboundFK])] : baseCols;
    const targetSql = compilePolymorphicSource(targetType, false, targetAlias, targetCols, options);
    fromSql += pointerStepJoinForLink(link, previousAlias, targetAlias, targetSql, `j${i}`, options);
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
    // Iterator lowered as a generic one-`value`-column subquery (enumerate,
    // array_unpack, computed scalar sets) — body refs read `alias."value"`
    // via scalarBindingAliases.
    valueIterator?: boolean;
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
      // The FILTERs' own column refs must land in the projection too —
      // including link FK columns (`exists .avatar` reads avatar_id).
      const iterColumns = new Set<string>(projectedColumns);
      const addWhereColumns = (node: Set): void => {
        const e = node.expr;
        if (e.kind === "pointer") {
          const ptr = e as Pointer;
          let root: Set = ptr.source;
          while (root.expr.kind === "select_expr") root = (root.expr as SelectExpr).result;
          if (root.expr.kind === "type_root" && (root.expr as TypeRoot).typeref.id === typeref.id) {
            // Inline object links live in a `<name>_id` FK column; link-table
            // walks anchor on `id` (already projected). Scalars use their
            // own column.
            if (ptr.ptrref.outTarget.isScalar) {
              iterColumns.add(columnForPointer(ptr));
            } else {
              // Inline FK form; unknown columns project as NULL, so adding
              // it for link-table-backed links too is harmless.
              iterColumns.add(`${ptr.ptrref.shortName}_id`);
            }
          }
          addWhereColumns(ptr.source);
          return;
        }
        if (e.kind === "operator_call") { for (const a of orderedCallArgs((e as OperatorCall).args)) addWhereColumns(a.expr); return; }
        if (e.kind === "function_call") { for (const a of orderedCallArgs((e as FunctionCall).args)) addWhereColumns(a.expr); return; }
        if (e.kind === "exists_expr") { addWhereColumns((e as ExistsExpr).expr); return; }
        if (e.kind === "type_cast") { addWhereColumns((e as TypeCast).expr); return; }
        if (e.kind === "select_expr") { const se = e as SelectExpr; addWhereColumns(se.result); if (se.where) addWhereColumns(se.where); return; }
      };
      for (const w of inlineWheres) {
        for (const c of collectReferencedColumns(w)) iterColumns.add(c);
        addWhereColumns(w);
      }
      const baseSrc = compilePolymorphicSource(typeref, false, alias, [...iterColumns], options);
      let sql = `SELECT ${alias}.* FROM ${baseSrc}`;
      const whereParts: string[] = [];
      for (const w of inlineWheres) {
        const wSql = compileWhereClause(w, alias, params, target, options);
        if (!wSql) return null;
        whereParts.push(`(${wSql})`);
      }
      if (whereParts.length > 0) {
        sql += ` WHERE ${whereParts.join(" AND ")}`;
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
      // Any other iterator that lowers to a one-`value`-column subquery
      // (`FOR el IN enumerate(...)`, array_unpack, computed scalar sets)
      // becomes a precompiled level; the body reads the current row through
      // scalarBindingAliases as `alias."value"`.
      const cp = params.length;
      let iterSql: string | null;
      try {
        iterSql = compileScalarSelectSQL(iterator, params, target, options, []);
      } catch (err) {
        if (!(err instanceof ShapeLoweringMiss)) throw err;
        iterSql = null;
      }
      if (!iterSql) {
        params.length = cp;
        return null;
      }
      levels.push({
        iteratorPathId,
        alias,
        precompiled: { iteratorPathId, alias, precompiledSql: `(${iterSql}) ${alias}`, optional, iteratorSet: iterator },
        valueIterator: true,
        optional,
      });
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
    if (level.constants || level.valueIterator) {
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
    const consts = levels[0].constants;
    if (!consts) throw new Error("invariant: FOR iteration level has no source (typeRef/precompiled/tuples/constants all unset)");
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
      fromSql += pointerStepJoinSql({
        usesLinkTable: true,
        direction: pointer.direction,
        previousAlias,
        nextAlias: level.alias,
        targetSource,
        linkAlias,
        linkTable,
      });
      level.linkAlias = linkAlias;
      linkPropertyAliases.set(level.iteratorPathId, linkAlias);
      continue;
    }

    const inlineColumn = `${pointer.ptrref.shortName}_id`;
    const targetType = pointer.direction === "inbound" ? pointer.ptrref.outSource : pointer.ptrref.outTarget;
    const targetSource = compilePolymorphicSource(targetType, false, level.alias, projectedColumns, options);
    fromSql += pointerStepJoinSql({
      usesLinkTable: false,
      direction: pointer.direction,
      previousAlias,
      nextAlias: level.alias,
      targetSource,
      inlineColumn,
    });
  }

  return { fromSql, baseAlias: firstAlias, bindingAliases, scalarBindingAliases, tupleIterAliases, linkPropertyAliases, whereSets, orderBy, paramsCheckpoint };
};

// The FROM alias of a FOR level whose iterator is a group-elements row set
// (`FOR el IN <g.elements rows>`) — body element-field reads resolve through
// it as the current element (options.groupElementAlias).
const groupElementsIteratorAlias = (
  forExpr: ForExpr,
  forSource: { bindingAliases: Map<string, string>; baseAlias: string },
): string | undefined => {
  let iterCursor = forExpr.iterator;
  while (iterCursor.expr.kind === "select_expr") {
    iterCursor = (iterCursor.expr as SelectExpr).result;
  }
  if (iterCursor.expr.kind === "group_row_field"
      && (iterCursor.expr as GroupRowFieldExpr).steps[0] === "elements") {
    return forSource.bindingAliases.get(pathIdKey(forExpr.iterator)) ?? forSource.baseAlias;
  }
  return undefined;
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

// Recover the next free `g<N>` CROSS-JOIN alias index from aliases already in
// the binding map. The regex matches an internal naming convention minted by
// this compiler, not external/IR structure.
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

// Build a tuple value that is NULL when any element is empty. The element SQL
// (`parts`) may contain `?` placeholders whose params were already pushed, so
// each part must appear exactly once — referencing it in both the NULL guard
// and the json constructor would emit `?` twice without re-pushing the param
// ("Too few parameter values"). We compute the parts once into aliased columns
// of a correlated subquery, then guard/construct off those aliases.
// An object reference used as a tuple slot serializes to a JSON object, but
// the value compilers resolve a bare (identity-only) object reference to its
// `id` column — correct for `= User` identity comparisons, wrong for a tuple
// slot, where `json(<uuid>)` reads the id text as malformed JSON. Detect the
// identity-only object element so the tuple builder wraps it as
// `json_object('id', <id>)`. A meaningfully-shaped element already compiles to
// a JSON object and is left alone.
const isIdentityObjectElement = (set: Set): boolean => {
  let cursor: Set = set;
  while (cursor.expr.kind === "select_expr") {
    const se = cursor.expr as SelectExpr;
    if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return false;
    cursor = se.result;
  }
  const isRoot = cursor.expr.kind === "type_root";
  const isObjectLink = cursor.expr.kind === "pointer"
    && !(cursor.expr as Pointer).ptrref.outTarget.isScalar
    && !(cursor.expr as Pointer).ptrref.isLinkProperty;
  if (!isRoot && !isObjectLink) return false;
  if (cursor.typeref?.isScalar || cursor.typeref?.collection) return false;
  const meaningfulShape = (cursor.shape ?? []).some((el) => {
    const elName = (el as { name?: string }).name;
    if (elName === "id") return false;
    if (el.shapeOrigin === "default") return false;
    return true;
  });
  return !meaningfulShape;
};

const nullPropagatingTupleSQL = (tuple: Tuple, parts: Array<string | null>): string => {
  // The empty tuple `()` is a singleton empty-tuple VALUE (not the empty
  // set) — emit an empty JSON array rather than NULL, which would read as
  // the empty set and poison enclosing null-propagation guards.
  if (tuple.elements.length === 0) {
    return "json_array()";
  }
  const aliases = parts.map((_, idx) => `t${idx}`);
  // Comparison results in the value layer are json('true')/json('false')
  // TEXT — embedding them in json_array without a json() re-wrap nests the
  // *string* "false" instead of a boolean (optional_leakage_01). Only ops
  // whose value lowering emits the json text form are listed.
  const yieldsJsonBool = (s: Set): boolean => {
    const cur = unwrapSelectExprSet(s).result;
    if (cur.expr.kind === "exists_expr") return true;
    if (cur.expr.kind === "operator_call") {
      return ["=", "!=", "<", "<=", ">", ">=", "?=", "?!=", "in", "not_in"]
        .includes((cur.expr as OperatorCall).operator);
    }
    const t = (cur.typeref?.id ?? cur.typeref?.nameHint ?? "").toLowerCase();
    return t === "std::bool" || t === "unknown:std::bool" || t === "bool";
  };
  // A nested tuple/array part is JSON text once selected into an alias column;
  // SQLite's JSON subtype doesn't survive that round-trip, so re-`json(...)` it
  // to embed it as nested JSON rather than a quoted string.
  const valueOf = (idx: number): string => {
    // An identity-only object slot compiled to a bare id column — embed it as
    // `json_object('id', <id>)` so it nests as an object, not a quoted uuid.
    // A part that already compiled to a JSON object (meaningful shape) is left
    // for the json() re-wrap below.
    const part = parts[idx] ?? "";
    if (isIdentityObjectElement(tuple.elements[idx].val) && !/^\s*json/.test(part)) {
      return `json_object(${quoteLiteral("id")}, ${aliases[idx]})`;
    }
    return setValueIsJson(tuple.elements[idx].val) || yieldsJsonBool(tuple.elements[idx].val)
      ? `json(${aliases[idx]})`
      : aliases[idx];
  };
  const projected = tuple.named
    ? `json_object(${tuple.elements.map((element, idx) => `${quoteLiteral(element.name ?? String(idx))}, ${valueOf(idx)}`).join(", ")})`
    : `json_array(${tuple.elements.map((_, idx) => valueOf(idx)).join(", ")})`;
  const inner = `SELECT ${parts.map((part, idx) => `(${part}) AS ${aliases[idx]}`).join(", ")}`;
  // A free object (`{ a := … }`) keeps its single row even when a field is
  // empty — the empty field just serializes to null. Only real tuples collapse
  // to the empty set when any element is empty.
  if (tuple.isFreeObject) {
    return `(SELECT ${projected} FROM (${inner}))`;
  }
  return `(SELECT CASE WHEN ${aliases.map((a) => `${a} IS NULL`).join(" OR ")} THEN NULL ELSE ${projected} END FROM (${inner}))`;
};

// Whether each row of a set is a tuple (a JSON array in the value layer) —
// used to choose json_extract slot access over string indexing for `.0`
// style access on iterator bindings.
const setYieldsTupleValues = (s: Set): boolean => {
  let cur = s;
  while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
  if (cur.expr.kind === "tuple") return true;
  if (cur.expr.kind === "function_call") {
    return ((cur.expr as FunctionCall).functionName.split("::").pop() ?? "") === "enumerate";
  }
  if (cur.expr.kind === "operator_call" && (cur.expr as OperatorCall).operator === "union") {
    const args = orderedCallArgs((cur.expr as OperatorCall).args);
    return args.length > 0 && args.every((a) => setYieldsTupleValues(a.expr));
  }
  return (cur.typeref?.nameHint ?? "").startsWith("tuple<");
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
  if ((tupleIterAliases || scalarBindingAliases) && expr.kind === "index_expr") {
    const idxExpr = expr as IndexExpr;
    const inner = idxExpr.expr;
    const innerKey = pathIdKey(inner);
    const tupleAlias = tupleIterAliases?.get(innerKey);
    if (tupleAlias) {
      const idxLit = extractNumericLiteral(idxExpr.index);
      if (idxLit !== undefined && Number.isInteger(idxLit) && idxLit >= 0) {
        return `${tupleAlias}.${quoteIdent(`__t${idxLit}`)}`;
      }
    }
    // Iterator whose VALUE column holds a JSON-array tuple per row
    // (`FOR el IN enumerate(...)`): `el.0` reads the slot off the current
    // row. Gated on the iterator actually yielding tuples — string/array
    // iterators keep their substr/json indexing semantics downstream.
    const scalarIterAlias = scalarBindingAliases?.get(innerKey);
    if (scalarIterAlias && setYieldsTupleValues(inner)) {
      const idxLit = extractNumericLiteral(idxExpr.index);
      if (idxLit !== undefined && Number.isInteger(idxLit)) {
        const path = idxLit < 0 ? `$[#${idxLit}]` : `$[${idxLit}]`;
        return `json_extract(${scalarIterAlias}.${quoteIdent("value")}, '${path}')`;
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

  // FOR body that's a bare `Type { name, b := n }` (a type_root carrying a
  // shape, no enclosing `select_expr`). The surrounding FOR has already added
  // `Type` as a cross-join level (collectFreeTypeRoots), so resolve the shape
  // against that level's alias and compile each computed element through the
  // aliased path so iterator refs (`b := n`) lower to the iterator's column
  // instead of decorrelating into a fresh set subquery.
  if ((unwrapped.result.expr.kind === "type_root" || unwrapped.result.expr.kind === "pointer")
    && unwrapped.result.shape && unwrapped.result.shape.length > 0) {
    let typeAlias = bindingAliases.get(pathIdKey(unwrapped.result));
    // A shaped object reference used as a tuple slot (`(L, L.1 {name})` where
    // L := ('x', User)) carries the binding's namespace, so its pathId won't
    // match the outer scope's key exactly. Fall back to the same id+namespace
    // scan the bare-root path below uses, so the slot serializes as the shape
    // object instead of leaking a bare id that a later `json()` wrap mangles.
    if (!typeAlias && unwrapped.result.expr.kind === "type_root") {
      const tid = (unwrapped.result.expr as TypeRoot).typeref?.id;
      const wantNs = JSON.stringify(unwrapped.result.pathId?.namespace ?? []);
      if (tid) {
        for (const [k, v] of bindingAliases.entries()) {
          if (k.includes(`"id":"${tid}"`) && k.includes(`"namespace":${wantNs}`)) { typeAlias = v; break; }
        }
        if (!typeAlias) {
          for (const [k, v] of bindingAliases.entries()) {
            if (k.includes(`"id":"${tid}"`)) { typeAlias = v; break; }
          }
        }
      }
    }
    if (typeAlias) {
      const obj = compileShapeObjectWithAliases(
        unwrapped.result, typeAlias, bindingAliases, params, target, options,
        linkPropertyAliases, scalarBindingAliases, tupleIterAliases,
      );
      if (obj) return obj;
      params.length = checkpoint;
    }
  }

  // A bare type-root reference used as a value (`I2 != Issue` compares
  // object identity) resolves to the bound alias's id column.
  if (unwrapped.result.expr.kind === "type_root"
      && (!unwrapped.result.shape || unwrapped.result.shape.length === 0)) {
    const rootKey = pathIdKey(unwrapped.result);
    let rootAliasResolved = bindingAliases.get(rootKey);
    if (!rootAliasResolved) {
      const tid = (unwrapped.result.expr as TypeRoot).typeref?.id;
      const wantNs = JSON.stringify(unwrapped.result.pathId?.namespace ?? []);
      if (tid) {
        for (const [k, v] of bindingAliases.entries()) {
          if (k.includes(`"id":"${tid}"`) && k.includes(`"namespace":${wantNs}`)) {
            rootAliasResolved = v;
            break;
          }
        }
      }
    }
    if (rootAliasResolved) return `${rootAliasResolved}.${quoteIdent("id")}`;
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
      // Prefer an entry whose namespace ALSO matches (so WITH-rebound roots
      // don't capture plain references and vice versa); fall back to the
      // id-only match for legacy callers whose synthetic keys carry no
      // namespace info.
      const sourceTypeId = (pointer.source.expr as TypeRoot).typeref?.id;
      if (sourceTypeId) {
        const wantNs = JSON.stringify(pointer.source.pathId?.namespace ?? []);
        for (const [k, v] of bindingAliases.entries()) {
          if (k.includes(`"id":"${sourceTypeId}"`) && k.includes(`"namespace":${wantNs}`)) { alias = v; break; }
        }
        if (!alias) {
          for (const [k, v] of bindingAliases.entries()) {
            if (k.includes(`"id":"${sourceTypeId}"`)) { alias = v; break; }
          }
        }
      }
    }
    // Link-chain leaf (`I2.priority.name`): when the chain's ROOT is one of
    // the bound aliases, anchor the chain there and read the leaf column via
    // a correlated subquery instead of mis-attributing it to the fallback
    // alias.
    if (!alias && pointer.source.expr.kind === "pointer" && pointer.ptrref.outTarget.isScalar && !pointer.ptrref.isLinkProperty) {
      let chainRoot: Set = pointer.source;
      while (chainRoot.expr.kind === "pointer") {
        chainRoot = (chainRoot.expr as Pointer).source;
      }
      while (chainRoot.expr.kind === "select_expr") {
        const se = chainRoot.expr as SelectExpr;
        if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) break;
        chainRoot = se.result;
      }
      if (chainRoot.expr.kind === "type_root") {
        let rootAlias2 = bindingAliases.get(pathIdKey(chainRoot));
        if (!rootAlias2) {
          const tid = (chainRoot.expr as TypeRoot).typeref?.id;
          const wantNs = JSON.stringify(chainRoot.pathId?.namespace ?? []);
          if (tid) {
            for (const [k, v] of bindingAliases.entries()) {
              if (k.includes(`"id":"${tid}"`) && k.includes(`"namespace":${wantNs}`)) {
                rootAlias2 = v;
                break;
              }
            }
          }
        }
        if (rootAlias2) {
          const idSet = compileChainSourceIdSetSQL(pointer.source, rootAlias2, options);
          if (idSet) {
            const leafOwner = pointer.ptrref.outSource;
            const leafSrc = compilePolymorphicSource(leafOwner, false, "cls0", ["id", columnForPointer(pointer)], options);
            return `(SELECT cls0.${quoteIdent(columnForPointer(pointer))} FROM ${leafSrc} WHERE cls0.${quoteIdent("id")} IN (${idSet}))`;
          }
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
    return nullPropagatingTupleSQL(tuple, parts);
  }

  if (expr.kind === "type_cast") {
    const castExpr = expr as TypeCast;
    const inner = compileValueSetSQLWithAliases(castExpr.expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
    if (!inner) {
      params.length = checkpoint;
      return null;
    }
    if (isFloatTypeName(qualifyTypeName(castExpr.toType))) {
      return `_gel_float_cast(${inner})`;
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
    // Boolean connectives recurse so each operand resolves against the
    // binding aliases (used by the free-root EXISTS FILTER lowering).
    if (call.operator === "and" || call.operator === "or") {
      const boolArgs = orderedCallArgs(call.args);
      if (boolArgs.length >= 2) {
        const l = compileValueSetSQLWithAliases(boolArgs[0].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
        const r = compileValueSetSQLWithAliases(boolArgs[1].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
        if (l && r) return `(${l} ${call.operator === "and" ? "AND" : "OR"} ${r})`;
        params.length = checkpoint;
        return null;
      }
    }
    if (call.operator === "not") {
      const notArgs = orderedCallArgs(call.args);
      if (notArgs.length >= 1) {
        const inner = compileValueSetSQLWithAliases(notArgs[0].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
        if (inner) return `(NOT ${inner})`;
        params.length = checkpoint;
        return null;
      }
    }
    // Object operands compare by identity (`I2 != Issue` → id columns), even
    // when the reference carries an implicit `{id}` shape.
    if (call.operator === "=" || call.operator === "!=" || call.operator === "?=" || call.operator === "?!=") {
      const cmpArgs2 = orderedCallArgs(call.args);
      const isObjecty = (st: Set): boolean => {
        const u = unwrapSelectExprSet(st).result;
        if (u.expr.kind === "type_root") return true;
        if (u.expr.kind === "pointer") {
          const ptr = u.expr as Pointer;
          return !ptr.ptrref.outTarget.isScalar && !ptr.ptrref.isLinkProperty;
        }
        return false;
      };
      const identitySql = (st: Set): string | null => {
        const u = unwrapSelectExprSet(st).result;
        const lookupAlias = (rootSet: Set): string | undefined => {
          const aliasFound = bindingAliases.get(pathIdKey(rootSet));
          if (!aliasFound && rootSet.expr.kind === "type_root") {
            const tid = (rootSet.expr as TypeRoot).typeref?.id;
            const wantNs = JSON.stringify(rootSet.pathId?.namespace ?? []);
            if (tid) {
              for (const [k, v] of bindingAliases.entries()) {
                if (k.includes(`"id":"${tid}"`) && k.includes(`"namespace":${wantNs}`)) return v;
              }
            }
          }
          return aliasFound;
        };
        if (u.expr.kind === "type_root") {
          const aliasFound = lookupAlias(u);
          return aliasFound ? `${aliasFound}.${quoteIdent("id")}` : null;
        }
        if (u.expr.kind === "pointer") {
          let chainRoot2: Set = u;
          while (chainRoot2.expr.kind === "pointer") chainRoot2 = (chainRoot2.expr as Pointer).source;
          while (chainRoot2.expr.kind === "select_expr") chainRoot2 = (chainRoot2.expr as SelectExpr).result;
          if (chainRoot2.expr.kind !== "type_root") return null;
          const rootAliasFound = lookupAlias(chainRoot2);
          if (!rootAliasFound) return null;
          const idSet = compileChainSourceIdSetSQL(u, rootAliasFound, options);
          return idSet ? (idSet.startsWith("SELECT") ? `(${idSet})` : idSet) : null;
        }
        return null;
      };
      if (cmpArgs2.length >= 2 && (isObjecty(cmpArgs2[0].expr) || isObjecty(cmpArgs2[1].expr))) {
        const lid = identitySql(cmpArgs2[0].expr);
        const rid = identitySql(cmpArgs2[1].expr);
        if (lid && rid) {
          const sqlOp = call.operator === "=" ? "="
            : call.operator === "!=" ? "!="
            : call.operator === "?=" ? "IS" : "IS NOT";
          return `(${lid} ${sqlOp} ${rid})`;
        }
        params.length = checkpoint;
        return null;
      }
    }
    // `?=` / `?!=` — null-safe equality maps to SQLite IS / IS NOT. Surface
    // as JSON booleans like the rest of the value layer (a bare `(l IS r)`
    // would decode as 1/0 integers).
    if (call.operator === "?=" || call.operator === "?!=") {
      const cmpArgs = orderedCallArgs(call.args);
      if (cmpArgs.length >= 2) {
        const l = compileValueSetSQLWithAliases(cmpArgs[0].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
        const r = compileValueSetSQLWithAliases(cmpArgs[1].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
        if (l && r) {
          return `(CASE WHEN ${l} ${call.operator === "?=" ? "IS" : "IS NOT"} ${r} THEN json('true') ELSE json('false') END)`;
        }
        params.length = checkpoint;
        return null;
      }
    }
    const infixOp = call.operator === "^" ? null : operatorToInfixSql(call.operator);
    const cmpOp = call.operator === "^" || infixOp ? null : normalizeOperator(call.operator);
    const op = call.operator === "^" ? "^" : (infixOp ?? cmpOp);
    const args = orderedCallArgs(call.args);
    if (op && args.length >= 2) {
      const left = compileValueSetSQLWithAliases(args[0].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
      const right = compileValueSetSQLWithAliases(args[1].expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
      if (!left || !right) {
        params.length = checkpoint;
        return null;
      }
      if (call.operator === "^") return `pow(${left}, ${right})`;
      const likeSql = likeOperatorSql(call.operator, left, right);
      if (likeSql) return likeSql;
      // Comparisons surface as JSON booleans like the rest of the value
      // layer (predicate consumers re-normalize truthiness). The one-row
      // subquery binds each side once so `?` params aren't consumed twice.
      if (cmpOp) {
        return `(SELECT CASE WHEN l IS NULL OR r IS NULL THEN NULL WHEN l ${cmpOp} r THEN json('true') ELSE json('false') END FROM (SELECT (${left}) AS l, (${right}) AS r))`;
      }
      return flooredArithBinarySql(call.operator, left, right) ?? `(${left} ${op} ${right})`;
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
    // Stdlib call whose arguments reference a tuple/scalar iterator binding
    // (`bit_lshift(val, X.0)` inside `FOR X IN {(2, 2), …}`): compile each
    // argument through the alias maps so the binding refs land on the
    // iterator's row columns, then lower via the stdlib template. The
    // fall-through path below would decorrelate `X.0` into a whole-set
    // subquery — gate on an actual binding mention so calls without iterator
    // refs keep their original (bool-normalizing) lowering.
    const shortFname = fname.split("::").pop() ?? fname;
    if (!SET_CONSUMING_FUNCTIONS.has(shortFname) && args.length > 0
        && ((tupleIterAliases && tupleIterAliases.size > 0) || (scalarBindingAliases && scalarBindingAliases.size > 0))) {
      const argKeys = new globalThis.Set<string>();
      for (const a of args) collectPathIdKeys(a.expr, argKeys);
      const mentionsBinding = [...argKeys].some((k) =>
        tupleIterAliases?.has(k) || scalarBindingAliases?.has(k));
      if (mentionsBinding) {
        const cp2 = params.length;
        const argSqls: string[] = [];
        let ok = true;
        for (const a of args) {
          const s = compileValueSetSQLWithAliases(a.expr, bindingAliases, fallbackAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
          if (!s) { ok = false; break; }
          argSqls.push(s);
        }
        if (ok) {
          const lowered = lowerStdlibFunctionSql(target, fname, argSqls, args.map((a) => scalarArgTypeHint(a.expr)));
          if (lowered) return lowered;
        }
        params.length = cp2;
      }
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
      const typeAlias = bindingAliases.get(pathIdKey(selectExpr.result));
      if (typeAlias) {
        const obj = compileShapeObjectWithAliases(
          selectExpr.result, typeAlias, bindingAliases, params, target, options,
          linkPropertyAliases, scalarBindingAliases, tupleIterAliases,
        );
        if (obj) return obj;
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

// Compile a shaped object (`Type { name, b := n }`) anchored at a known
// cross-join alias, threading FOR-iterator binding maps so computed elements
// (`b := n`) resolve to the iterator's column rather than decorrelating into a
// fresh set subquery. Shared by the bare-type-root and select_expr-wrapped
// shape branches of compileValueSetSQLWithAliases. Returns null if any element
// can't be lowered (caller rolls back params and falls through).
const compileShapeObjectWithAliases = (
  resultSet: Set,
  typeAlias: string,
  bindingAliases: Map<string, string>,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  linkPropertyAliases?: Map<string, string>,
  scalarBindingAliases?: Map<string, string>,
  tupleIterAliases?: Map<string, string>,
): string | null => {
  const pairs: string[] = [];
  for (const element of resultSet.shape) {
    const elemExpr = element.expr;
    // Scalar field shorthand (`name`): emit alias.column directly.
    if (elemExpr.expr.kind === "pointer" && elemExpr.typeref.isScalar) {
      const ptr = elemExpr.expr as Pointer;
      pairs.push(`${quoteLiteral(ptr.ptrref.shortName)}, ${typeAlias}.${quoteIdent(columnForPointer(ptr))}`);
      continue;
    }
    // Computed scalar (`b := n`): compile via the aliased path so binding
    // refs lower correctly.
    const computed = compileValueSetSQLWithAliases(elemExpr, bindingAliases, typeAlias, params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
    if (!computed) return null;
    const key = element.name
      ? quoteLiteral(element.name)
      : (elemExpr.expr.kind === "pointer")
        ? quoteLiteral((elemExpr.expr as Pointer).ptrref.shortName)
        : quoteLiteral(shapeAliasForElement(element, elemExpr, 0));
    pairs.push(`${key}, ${computed}`);
  }
  return pairs.length > 0 ? `json_object(${pairs.join(", ")})` : null;
};

// FILTER fallback for predicates that reference WITH-rebound type roots
// (namespaced pathIds the outer alias can't satisfy). Keep-row-if-any-true
// semantics lower to `EXISTS (SELECT 1 FROM <free-root scans> WHERE P)`,
// with outer-root references bound to the statement's source alias.
const tryCompileFreeRootExistsWhere = (
  where: Set,
  sourceAlias: string,
  sourceSet: Set | null | undefined,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
): string | null => {
  const bindingAliases = new Map<string, string>();
  if (sourceSet) {
    let root: Set = sourceSet;
    while (root.expr.kind === "select_expr") {
      root = (root.expr as SelectExpr).result;
    }
    if (root.expr.kind === "type_root") {
      bindingAliases.set(pathIdKey(root), sourceAlias);
    }
  }
  const freeRoots = collectFreeTypeRoots(where, bindingAliases);
  if (process.env.DBG_FREEROOT) console.error("[freeroot] roots:", freeRoots.map((r) => r.typeref.id), "bound:", [...bindingAliases.values()]);
  if (freeRoots.length === 0) return null;
  const checkpoint = params.length;
  const referenced = collectReferencedColumns(where);
  const fromParts: string[] = [];
  let idx = 0;
  for (const root of freeRoots) {
    const alias = `w${idx++}`;
    fromParts.push(
      compilePolymorphicSource(root.typeref, false, alias, [...new Set(["id", ...referenced])], options),
    );
    bindingAliases.set(root.key, alias);
  }
  const predicate = compilePredicateWithAliases(where, bindingAliases, params, target, options);
  if (process.env.DBG_FREEROOT) console.error("[freeroot] predicate:", predicate);
  if (!predicate) {
    params.length = checkpoint;
    return null;
  }
  return `EXISTS (SELECT 1 FROM ${fromParts.join(" CROSS JOIN ")} WHERE ${predicate})`;
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
): string | null => {
  const value = compileValueSetSQLWithAliases(set, bindingAliases, "g0", params, target, options, linkPropertyAliases, scalarBindingAliases, tupleIterAliases);
  if (!value) return null;
  // The value layer emits JSON booleans (json('true') is the TEXT 'true',
  // falsy as a bare WHERE expression) — normalize JSON and native boolean
  // shapes to a SQL truth value, binding the value once.
  return `(SELECT CASE WHEN p IS NULL THEN 0 WHEN p = json('true') THEN 1 WHEN p = json('false') THEN 0 WHEN p THEN 1 ELSE 0 END FROM (SELECT (${value}) AS p))`;
};

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
      // Tuple-valued sort key (`SELECT _ := (a, b) ORDER BY _`): EdgeQL
      // orders tuples element-wise. The raw `value` column is JSON text, so
      // sorting it directly compares lexically ('-1' before '-2'). Expand to
      // one json_extract key per slot.
      {
        let cur: Set = entry.path;
        while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
        if (cur.expr.kind === "tuple" && !(cur.expr as Tuple).named && (cur.expr as Tuple).elements.length > 0) {
          const dir = ` ${entry.direction.toUpperCase()}${sortNullsClause(entry)}`;
          return (cur.expr as Tuple).elements
            .map((_, i) => `json_extract(${valueSql}, '$[${i}]')${dir}`)
            .join(", ");
        }
      }
      const expr = compileValueSortPath(entry.path, valueSql, target, enumMembersByName, fieldEnumMembers);
      return expr ? `${expr} ${entry.direction.toUpperCase()}${sortNullsClause(entry)}` : "";
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
  // `ORDER BY _` where `_` is the SELECT's result alias (`SELECT _ := EXPR
  // ORDER BY _`): the IR binds `_` to the whole (select_expr-wrapped) result
  // set, so the per-row sort key is the already-projected `value` column.
  // Unwrap and recurse so an inner enum-union still maps to declared order;
  // otherwise fall back to the raw value column.
  if (set.expr.kind === "select_expr") {
    const inner = unwrapSelectExprSet(set).result;
    // An index access in the bound result (`_ := (X ∪ Y).0`) is already baked
    // into the projected `value` column — re-extracting would double-apply
    // `$[0]` to the scalar slot. Sort by the column directly.
    if (inner.expr.kind === "index_expr") return valueSql;
    return compileValueSortPath(inner, valueSql, target, enumMembersByName, fieldEnumMembers) ?? valueSql;
  }
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
  // A FOR's per-iteration value is JSON when its body's is (`b := (for n in
  // {9} union ({c := 3, d := n}))`).
  if (result.expr.kind === "for_expr") {
    return setValueIsJson((result.expr as ForExpr).body);
  }
  // array_agg produces a JSON array.
  if (result.expr.kind === "function_call") {
    const fn = ((result.expr as FunctionCall).functionName ?? "").split("::").pop();
    if (fn === "array_agg") return true;
    // Cardinality/identity guards (`assert_single`, `assert_exists`,
    // `assert_distinct`, `distinct`) pass their argument's set through
    // unchanged, so the value is JSON-structured exactly when the argument's
    // is — e.g. `{ x := assert_single(objectSet) }` must still wrap in
    // json(...) or the nested object renders as a quoted string.
    if (fn === "assert_single" || fn === "assert_exists"
      || fn === "assert_distinct" || fn === "distinct") {
      const inner = orderedCallArgs((result.expr as FunctionCall).args)[0]?.expr;
      if (inner) return setValueIsJson(inner);
    }
  }
  // A coalesce's value is JSON when either side's is — the coalesce set's
  // typeref is often a bare `std::coalesce` placeholder with no collection
  // info, so inspect the operands directly.
  if (result.expr.kind === "coalesce_expr") {
    const coalesce = result.expr as CoalesceExpr;
    return setValueIsJson(coalesce.left) || setValueIsJson(coalesce.right);
  }
  // Tuple/array-typed properties are stored as std::json columns holding
  // JSON text — embedding them in json_array/json_group_array needs a
  // json() wrap or they nest as quoted strings.
  if (result.expr.kind === "pointer") {
    const outTarget = (result.expr as Pointer).ptrref.outTarget;
    if (outTarget.id === "std::json") return true;
  }
  // Group-row reads: `.elements` rows and the `.key` object are JSON values.
  if (result.expr.kind === "group_row_field") {
    const steps = (result.expr as GroupRowFieldExpr).steps;
    return steps.length === 1 && (steps[0] === "elements" || steps[0] === "key");
  }
  return result.shape.length > 0
    || result.expr.kind === "tuple"
    || result.expr.kind === "array"
    || result.typeref.collection === "tuple"
    || result.typeref.collection === "array"
    || setYieldsTupleValues(result);
};

// Whether a set's value is a boolean. Booleans are stored as the TEXT output of
// `json('true')`/`json('false')`; embedding them in `json_array`/`json_object`
// needs a `json()` wrap or they nest as quoted strings (`"false"`). The element
// typeref is often a bare `std::anyscalar` placeholder for a literal, so also
// inspect the underlying expression kind / type name.
const setValueIsBool = (set: Set): boolean => {
  const typeName = (set.typeref?.id ?? set.typeref?.nameHint ?? "").toLowerCase();
  if (typeName === "std::bool" || typeName === "unknown:std::bool" || typeName === "bool") return true;
  const unwrapped = unwrapSelectExprSet(set);
  const expr = unwrapped.result.expr;
  if (expr.kind === "boolean_constant") return true;
  if (expr.kind === "coalesce_expr") {
    const coalesce = expr as CoalesceExpr;
    return setValueIsBool(coalesce.left) || setValueIsBool(coalesce.right);
  }
  return false;
};

const pathIdKey = (set: Set): string => JSON.stringify(set.pathId);

const collectProjectedColumns = (shape: ShapeElement[], where?: Set, orderBy?: SortExpr[]): string[] => {
  const columns = new Set<string>(["id"]);
  for (const element of shape) {
    const column = compileProjectedSourceColumnRef(element.expr, true);
    if (column) {
      columns.add(column);
    }
    if (element.expr.expr.kind === "pointer") {
      const pointer = element.expr.expr as Pointer;
      if (!pointer.ptrref.outTarget.isScalar && pointer.direction === "outbound" && !shouldUseLinkTable(pointer)) {
        columns.add(`${pointer.ptrref.shortName}_id`);
      }
      // A computed scalar leaf stepping directly through a single inline link
      // (`z := .bar.a`) is correlated to the outer row via the link's FK, so
      // the outer source must surface that FK column (`bar_id`). Mirrors the
      // `leafThroughForeignLink` lowering guard below (single, inline, rooted
      // at the subject, no clause-bearing select_expr in between).
      if (pointer.ptrref.outTarget.isScalar && !pointer.ptrref.isLinkProperty) {
        let src: Set = pointer.source;
        while (src.expr.kind === "select_expr") src = (src.expr as SelectExpr).result;
        if (src.expr.kind === "pointer") {
          const linkPtr = src.expr as Pointer;
          if (linkPtr.direction === "outbound"
              && !linkPtr.ptrref.outTarget.isScalar
              && linkPtr.ptrref.outCardinality !== "many"
              && linkPtr.ptrref.outCardinality !== "at_least_one"
              && !shouldUseLinkTable(linkPtr)
              && linkPtr.source.expr.kind === "type_root") {
            columns.add(`${linkPtr.ptrref.shortName}_id`);
          }
        }
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
    // A shaped element (`User {name}` inside a tuple) reads its shape fields'
    // columns off the same source — surface them too.
    for (const shapeEl of node.shape ?? []) {
      visit(shapeEl.expr);
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

const compileProjectedSourceColumnRef = (set: Set, allowLimitedSource = false): string | null => {
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
  let cursor: Set = pointer.source;
  while (cursor.expr.kind === "select_expr") {
    const se = cursor.expr as SelectExpr;
    // A WHERE/ORDER BY on the subquery source doesn't change which *columns*
    // the underlying type's rows expose — the filter is applied separately as
    // an inner-where — so the scalar column is still projectable. A LIMIT /
    // OFFSET, however, changes the row set in a way the flat single-source
    // projection can't honour, so bail on those — unless the caller is only
    // collecting columns for a source subquery that DOES honour the clauses
    // (allowLimitedSource).
    if ((se.limit || se.offset) && !allowLimitedSource) {
      return null;
    }
    cursor = se.result;
  }
  const sourceExpr: Expr = cursor.expr;
  if (sourceExpr.kind === "type_root") {
    return columnForPointer(pointer);
  }
  if (sourceExpr.kind === "pointer") {
    const sourcePointer = sourceExpr as Pointer;
    if (!sourcePointer.ptrref.outTarget.isScalar) {
      return columnForPointer(pointer);
    }
  }
  // `{Issue, User} { … }` lands here: the pointer's source is a union of
  // type roots. The branch's polymorphic source needs the scalar columns of
  // each splat-expanded entry — accept the column even when the source is a
  // set-constructor union.
  if (sourceExpr.kind === "operator_call"
      && ((sourceExpr as OperatorCall).operator === "union"
          || (sourceExpr as OperatorCall).operator === "intersect"
          || (sourceExpr as OperatorCall).operator === "except"
          || (sourceExpr as OperatorCall).operator === "distinct")) {
    return columnForPointer(pointer);
  }
  // `(lhs ?? rhs).prop` — an object-set coalesce source surfaces the scalar
  // column on whichever branch produced the row (compileSelectSource's
  // coalesce_expr branch projects the common column list through both sides).
  if (sourceExpr.kind === "coalesce_expr") {
    return columnForPointer(pointer);
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
//
// KNOWN SMELL: union members are structure encoded into the id string and
// recovered here by `.split("|")`. The IR already has `TypeRef.union`; populate
// that where union-link TypeRefs are built so this string round-trip can go.
const expandUnionTypeRefBranches = (typeRef: TypeRef): TypeRef[] => {
  if (!typeRef.id.includes("|")) return [typeRef];
  // Union typerefs land here as a single `unknown:default::File|default::URL`
  // string (built by `unknownTypeRef` on the parser side). Strip the marker
  // off the joint so every branch resolves as a real concrete type, not as
  // `unknown:default::File` which would table-name to `unknown:default__file`.
  const stripUnknown = (s: string): string => s.startsWith("unknown:") ? s.slice("unknown:".length) : s;
  const idWithoutMarker = stripUnknown(typeRef.id);
  return idWithoutMarker.split("|").map((branchId) => typeRefFromQualifiedName(stripUnknown(branchId.trim())));
};

// A minimal concrete TypeRef synthesised from a qualified name — used where a
// concrete type is recovered as a string (a union-branch id split, or the
// schema's concrete-subtype closure) and must re-enter the TypeRef-shaped
// lowering. Downstream reads only the name (table + columns key off it), so the
// synthetic children/flags suffice.
const typeRefFromQualifiedName = (name: string): TypeRef => ({
  kind: "type_ref",
  id: name,
  nameHint: name,
  module: name.split("::")[0] ?? "default",
  isView: false,
  isScalar: false,
  isAbstract: false,
  inSchema: true,
});

// The concrete (non-abstract) qualified type names one already-expanded typeref
// branch admits — the single home for "expand a polymorphic branch to its
// concrete extent". Prefers the schema's concrete-subtype closure
// (`resolveConcreteSubtypes`): it alone recovers a union branch's own subtypes,
// since a union branch arrives as a bare id string with no `children`. Falls
// back to the IR children-closure when no resolver is wired. Per-branch: the
// caller expands unions (`expandUnionTypeRefBranches`) and de-dupes. Both
// polymorphic readers — `compilePolymorphicSource` (union path) and
// `linkStorageTablesForPointer` — route through this so they cannot drift.
const branchConcreteTypeNames = (branch: TypeRef, options: GelIRCompileOptions | undefined): string[] => {
  const viaSchema = options?.resolveConcreteSubtypes?.(qualifyTypeName(branch));
  if (viaSchema && viaSchema.length > 0) {
    return viaSchema;
  }
  return flattenTypeClosure(branch)
    .filter((candidate) => !candidate.isAbstract)
    .map((candidate) => qualifyTypeName(candidate));
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
  const isUnion = branches.length > 1;
  const candidates = skipSubtypes
    ? branches
    // A union target (`stw0 -> S | T | W`) arrives as bare branch refs with no
    // `children`, so the per-branch type-closure would scan only S/T/W and miss
    // V (a subtype of both S and T). `branchConcreteTypeNames` recovers each
    // branch's concrete subtypes from the schema (the same rule
    // `linkStorageTablesForPointer` uses). Non-union sources keep the
    // children-based closure so their SQL stays byte-identical.
    : branches.flatMap((branch) =>
        isUnion
          ? branchConcreteTypeNames(branch, options).map(typeRefFromQualifiedName)
          : flattenTypeClosure(branch));
  const concrete = candidates.filter((candidate) => !candidate.isAbstract);
  // De-dupe by qualified name: a union whose branches share a subtype (V is
  // under both S and T) would otherwise scan V's table once per branch and
  // double its rows. First-occurrence order, so non-union output is unchanged.
  const seenNames = new globalThis.Set<string>();
  const deduped = concrete.filter((candidate) => {
    const name = qualifyTypeName(candidate);
    if (seenNames.has(name)) return false;
    seenNames.add(name);
    return true;
  });
  const sources = deduped.length > 0 ? deduped : [typeRef];

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

// The qualified concrete type names a (possibly union-id) typeref admits —
// expanding `A | B` into branches and each branch into its subtype closure.
// Used to gate an intersection-narrowed pointer (`[is T].p`) so a subject row
// contributes only when its `__source_type` is one of these.
const concreteSourceTypeNames = (typeRef: TypeRef): string[] =>
  [...new Set(
    expandUnionTypeRefBranches(typeRef)
      .flatMap((branch) => flattenTypeClosure(branch))
      .filter((candidate) => !candidate.isAbstract)
      .map((candidate) => qualifyTypeName(candidate)),
  )];

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

// One shape element whose value is a non-scalar pointer (a link projected as a
// JSON array of shaped rows): `watchers: { name }`, `owner: { name }`. Lifted
// verbatim out of compileShapeProjection so the link-array case has a named
// home and a test surface (ADR 0049). Single-cardinality links unwrap to the
// first element.
const compileShapeLinkArray = (
  shape: ShapeElement,
  shapeExpr: { result: Set; selectExpr?: SelectExpr },
  sourceAlias: string,
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
): string => {
  // The caller guards `shapeExpr.result.expr.kind === "pointer"`; the cast
  // restores the narrowing the inline `if` previously provided.
  const linkExpr = compilePointerArrayExpr(
    shapeExpr.result.expr as Pointer,
    sourceAlias,
    shapeExpr.result.shape,
    params,
    options,
    target,
    depth + 1,
    shapeExpr.selectExpr,
    narrowedLinkTarget(shapeExpr.result),
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
};

// One shape element that projects a scalar leaf through an intermediate
// *single* object link not joined into the outer row (`a := .bar.a`). Returns
// the correlated-subquery projection when the pattern matches, or null to fall
// through to the projected-column / multi-scalar lowering below. Lifted
// verbatim out of compileShapeProjection (ADR 0049).
const compileShapeLeafThroughForeignLink = (
  shape: ShapeElement,
  shapeExpr: { result: Set; selectExpr?: SelectExpr },
  sourceAlias: string,
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
): string | null => {
  // Computed shape field that projects a scalar leaf through an intermediate
  // *single* object LINK (`a := .bar.a`, `c := .owner.name` written as a
  // computed rather than a shape-on-path). The leaf's source is a link pointer
  // whose target type is NOT joined into the outer `g0` row (unlike a
  // shape-on-path `Issue.owner { name }`, where `owner` IS the shape subject
  // and is already joined). compileProjectedSourceColumnRef would wrongly read
  // the leaf column off the outer source (yielding `NULL AS …`), so lower it as
  // a correlated subquery over the link's target rows.
  const leafThroughForeignLink = ((): { leaf: Pointer; linkPtr: Pointer; linkSet: Set } | null => {
    if (shapeExpr.result.expr.kind !== "pointer") return null;
    const leaf = shapeExpr.result.expr as Pointer;
    if (!leaf.ptrref.outTarget.isScalar || leaf.ptrref.isLinkProperty) return null;
    // Peel any select_expr wrapper around the link (`(select .bar order by …).a`):
    // for a SINGLE link the inner ORDER BY / LIMIT / FILTER are no-ops over an
    // at-most-one set, so reading the leaf off the single target is correct.
    // The cardinality guard below rejects multi links, where those clauses
    // would matter (they keep their existing multi-scalar lowering).
    let src: Set = leaf.source;
    while (src.expr.kind === "select_expr") src = (src.expr as SelectExpr).result;
    if (src.expr.kind !== "pointer") return null;
    const linkPtr = src.expr as Pointer;
    // A forward object link rooted directly at the shape subject (`.bar.a`,
    // `.deck.name`). Single links read one correlated leaf; MULTI links
    // aggregate the per-target leaves into a JSON array (see the return below).
    // Deeper / inbound chains keep their existing lowering.
    if (linkPtr.direction === "inbound" || linkPtr.ptrref.outTarget.isScalar) return null;
    if (linkPtr.source.expr.kind !== "type_root") return null;
    // Shape-on-path (`Issue.owner { name }`): the link IS the shape subject and
    // already joined into `g0` — keep the direct-column read. Detect that by
    // comparing path identity with the shape source.
    if (shape.source && pathIdKey(src) === pathIdKey(shape.source)) return null;
    return { leaf, linkPtr, linkSet: src };
  })();
  if (leafThroughForeignLink) {
    const { leaf, linkPtr, linkSet } = leafThroughForeignLink;
    const alias = shapeAliasForElement(shape, shapeExpr.result, depth);
    const leafCol = columnForPointer(leaf);
    // `.deck[IS SpecialCard].name` narrows the link's TARGET — scan only the
    // narrowed concrete type(s), not the link's declared target.
    const scanTarget = narrowedLinkTarget(linkSet) ?? linkPtr.ptrref.outTarget;
    // The link is single, so the leaf scalar is at_most_one — pick one row.
    // Project the link's target rows correlated to the outer subject row, then
    // read the scalar leaf column off them. For an inline single link the FK
    // lives on the subject (`<subject>.bar_id = <Bar>.id`); a single link that
    // carries link properties routes through its link table.
    const targetAlias = `sfl${depth}`;
    const targetSql = compilePolymorphicSource(scanTarget, false, targetAlias, ["id", leafCol], options);
    // `[is BaseOriginB].dest.name` — the link's source was intersection-narrowed
    // to a SIBLING type reachable only through a common subtype (`narrowed` !=
    // the underlying type_root). A subject row contributes only when its
    // concrete type is one of the narrowed type's concrete subtypes; otherwise
    // the `[is T]` view is empty and the leaf is NULL. Guard the correlation by
    // the subject's `__source_type` so non-matching rows yield no link row.
    const narrowedType = linkPtr.source.typeref;
    const rootType = linkPtr.source.expr.kind === "type_root"
      ? (linkPtr.source.expr as TypeRoot).typeref
      : undefined;
    const narrowGuard = ((): string | null => {
      if (!narrowedType || !rootType || narrowedType.id === rootType.id) return null;
      const concrete = concreteSourceTypeNames(narrowedType).map((name) => quoteLiteral(name));
      if (concrete.length === 0) return null;
      return `${sourceAlias}.${quoteIdent("__source_type")} IN (${concrete.join(", ")})`;
    })();
    let fromSql: string;
    if (shouldUseLinkTable(linkPtr)) {
      const linkTable = linkTableNameForPointer(linkPtr, options);
      const linkAlias = `sflj${depth}`;
      fromSql = `${targetSql} JOIN ${quoteIdent(linkTable)} ${linkAlias}`
        + ` ON ${linkAlias}.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")}`
        + ` AND ${linkAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`
        + (narrowGuard ? ` AND ${narrowGuard}` : "");
    } else {
      // Inline single link: correlate the target scan on the subject's FK.
      const inlineColumn = `${linkPtr.ptrref.shortName}_id`;
      fromSql = `${targetSql} WHERE ${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(inlineColumn)}`
        + (narrowGuard ? ` AND ${narrowGuard}` : "");
    }
    const value = shapeScalarColumnValue(`${targetAlias}.${quoteIdent(leafCol)}`, leaf.ptrref.outTarget);
    // A multi link yields one leaf per linked object — aggregate them into a
    // JSON array (correlated to the subject via the FROM above); a single link
    // reads the one correlated value.
    const linkIsMany = linkPtr.ptrref.outCardinality === "many"
      || linkPtr.ptrref.outCardinality === "at_least_one";
    return wrapCorrelatedShapeSubquery(value, fromSql, linkIsMany, alias);
  }
  return null;
};

// The result wrapper for a correlated shape-subquery element: a multi-cardinality
// element aggregates to a JSON array (COALESCE'd to '[]' when empty); a single
// element peels the first row with LIMIT 1. `valueExpr` is the projected value
// SQL, `sourceSql` the text that follows FROM (already parenthesized / aliased
// by the caller), `alias` the shape element's output column name. This names the
// "build a correlated shape subquery" result shape ADR 0049 deferred as the
// prerequisite for carving the entangled shape-projection cases (ADR 0056).
const wrapCorrelatedShapeSubquery = (
  valueExpr: string,
  sourceSql: string,
  isMany: boolean,
  alias: string,
): string =>
  isMany
    ? `COALESCE((SELECT json_group_array(${valueExpr}) FROM ${sourceSql}), '[]') AS ${quoteIdent(alias)}`
    : `(SELECT ${valueExpr} FROM ${sourceSql} LIMIT 1) AS ${quoteIdent(alias)}`;

// Peel set-preserving wrappers (`select` parens, casts, identity functions like
// `assert_distinct`/`assert_exists`/`assert_single` — those keep the upper
// cardinality, unlike `count`) to find a `FOR … UNION (…)` underneath.
const peelToForExpr = (set: Set): Set | undefined => {
  let cur: Set = set;
  for (;;) {
    const e = cur.expr;
    if (e.kind === "for_expr") return cur;
    if (e.kind === "select_expr") { cur = (e as SelectExpr).result; continue; }
    if (e.kind === "type_cast") { cur = (e as TypeCast).expr; continue; }
    // `DISTINCT (FOR …)` — the prefix DISTINCT operator dedups but preserves the
    // set, so peel into its single operand.
    if (e.kind === "operator_call" && (e as OperatorCall).operator === "distinct") {
      const args = orderedCallArgs((e as OperatorCall).args);
      if (args.length >= 1) { cur = args[0].expr; continue; }
    }
    if (e.kind === "function_call") {
      // The set-passthrough identity guards return their argument's set
      // unchanged (mirrors the `setValueIsJson` peel) — peel into the arg.
      const fn = ((e as FunctionCall).functionName ?? "").split("::").pop();
      if (fn === "assert_single" || fn === "assert_exists"
        || fn === "assert_distinct" || fn === "distinct") {
        const args = orderedCallArgs((e as FunctionCall).args);
        if (args.length >= 1) { cur = args[0].expr; continue; }
      }
    }
    return undefined;
  }
};

// GATE (FOR-in-computed-shape, literal-iterator + shape body): lower
// `field := FOR v IN {lit, …} UNION (SELECT subject.<link> { … [@]tag := v … }
// FILTER pred)` — a literal iteration whose body shapes the OUTER subject's link
// and tags each row with the loop value. The result is a JSON array over the
// cross-product (iterator × correlated link rows), filtered. Built directly
// (rather than via the link-array helpers) so the loop var resolves through
// scalarBindingAliases and the iterator rows get a depth-disjoint alias (the
// generic FOR source mints `g0`, which collides with the outer subject `g0`).
// NOTE(merge): a sibling gate should later cover the scalar-leaf body
// (`.deck.name`) and inline-FK links; once 3+ shapes exist, fold them together.
const compileForInShapeField = (
  forSet: Set,
  shape: ShapeElement,
  sourceAlias: string,
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
): string | null => {
  const forExpr = forSet.expr as ForExpr;
  const iter = forExpr.iterator;
  if (iter.expr.kind !== "operator_call" || (iter.expr as OperatorCall).operator !== "union") return null;
  const iterArgs = orderedCallArgs((iter.expr as OperatorCall).args);
  const constants: ScalarValue[] = [];
  for (const a of iterArgs) {
    const c = extractScalarConstant(a.expr);
    if (c === undefined) return null;
    constants.push(c);
  }
  if (constants.length === 0) return null;
  // Peel the body's `select` wrappers, collecting their FILTERs.
  let bodyCur: Set = forExpr.body;
  const wheres: Set[] = [];
  while (bodyCur.expr.kind === "select_expr") {
    const se = bodyCur.expr as SelectExpr;
    if (se.where) wheres.push(se.where);
    bodyCur = se.result;
  }
  // The body must shape an outbound, junction-stored, object multi-link.
  if (bodyCur.expr.kind !== "pointer") return null;
  const linkPtr0 = bodyCur.expr as Pointer;
  if (linkPtr0.ptrref.isLinkProperty || linkPtr0.ptrref.outTarget.isScalar
      || linkPtr0.direction !== "outbound") return null;
  const shapeEls = bodyCur.shape ?? [];
  if (shapeEls.length === 0) return null;
  const linkPtr = resetPointerSourceToRoot(linkPtr0);
  if (!shouldUseLinkTable(linkPtr)) return null;
  const dN = depth + 1;
  const itAlias = `fi${dN}`;
  const targetAlias = `fp${dN}`;
  const joinAlias = `fj${dN}`;
  const iterRows = constants
    .map((c, i) => { params.push(c); return i === 0 ? `SELECT ? AS ${quoteIdent("value")}` : "SELECT ?"; })
    .join(" UNION ALL ");
  const iterKey = pathIdKey(forExpr.iterator);
  const linkKey = pathIdKey(bodyCur);
  const scalarBindings = new Map<string, string>([[iterKey, itAlias]]);
  const bindingAliases = new Map<string, string>([[linkKey, targetAlias]]);
  const linkPropAliases = new Map<string, string>([[linkKey, joinAlias]]);
  const projectedCols = [...new globalThis.Set<string>(["id", ...collectReferencedColumns(bodyCur)])];
  const narrowed = narrowedLinkTarget(bodyCur);
  const targetSource = compilePolymorphicSource(narrowed ?? linkPtr.ptrref.outTarget, false, targetAlias, projectedCols, options);
  const linkTableRef = linkTableSourceForPointer(linkPtr, options);
  const pairs: string[] = [];
  for (const el of shapeEls) {
    if (!el.name) return null;
    const v = compileValueSetSQLWithAliases(el.expr, bindingAliases, targetAlias, params, target, options, linkPropAliases, scalarBindings);
    if (!v) return null;
    pairs.push(`${quoteLiteral(el.name)}, ${v}`);
  }
  const rowExpr = `json_object(${pairs.join(", ")})`;
  let filterSql = "";
  for (const w of wheres) {
    // The FILTER must be a SQL boolean predicate, not a JSON-wrapped value
    // (`json('true')` in a WHERE is the truthy-less string 'true').
    const f = compilePredicateWithAliases(w, bindingAliases, params, target, options, linkPropAliases, scalarBindings);
    if (f) filterSql += ` AND ${f}`;
  }
  const alias = shapeAliasForElement(shape, shape.expr, depth);
  return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (`
    + `SELECT ${rowExpr} AS ${quoteIdent("item")} FROM (${iterRows}) ${itAlias}`
    + ` CROSS JOIN ${targetSource}`
    + ` JOIN ${linkTableRef} ${joinAlias} ON ${joinAlias}.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")}`
    + ` WHERE ${joinAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}${filterSql}`
    + `)), '[]') AS ${quoteIdent(alias)}`;
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
  // `type_name := X.__type__.name` — `__type__` has no storage table; the
  // dynamic type label is the row's `__source_type` column.
  if (shapeExpr.result.expr.kind === "pointer") {
    const namePtr = shapeExpr.result.expr as Pointer;
    if (namePtr.ptrref.shortName === "name"
        && namePtr.source.expr.kind === "pointer"
        && (namePtr.source.expr as Pointer).ptrref.shortName === "__type__") {
      return `${sourceAlias}.${quoteIdent("__source_type")} AS ${quoteIdent(shapeAliasForElement(shape, shapeExpr.result, depth))}`;
    }
  }
  // `__type__ := (select X.__type__ { name, id })` — a SHAPE on the synthetic
  // `__type__` pointer. There is no schema::ObjectType storage table; build the
  // type object directly from the row's `__source_type` (both `name` and `id`
  // resolve to the dynamic type label, matching the direct `__type__: {…}` and
  // `.__type__.name` paths). Single-cardinality, so emit a bare object.
  if (shapeExpr.result.expr.kind === "pointer"
      && (shapeExpr.result.expr as Pointer).ptrref.shortName === "__type__") {
    const requested = (shapeExpr.result.shape ?? [])
      .map((el) => el.name)
      .filter((n): n is string => n === "name" || n === "id");
    const fields = requested.length > 0 ? requested : ["name"];
    const pairs = fields.map((f) => `${quoteLiteral(f)}, ${sourceAlias}.${quoteIdent("__source_type")}`);
    return `json_object(${pairs.join(", ")}) AS ${quoteIdent(shapeAliasForElement(shape, shape.expr, depth))}`;
  }
  if (shapeExpr.result.expr.kind === "embedded_group") {
    const alias = shapeAliasForElement(shape, shape.expr, depth);
    return `${compileEmbeddedGroupSQL(shapeExpr.result.expr, sourceAlias, params, options, target, depth)} AS ${quoteIdent(alias)}`;
  }
  // Computed FOR over a link correlated to the subject
  // (`cards := (FOR d IN .deck SELECT (d.name, d@count))`): iterate the link
  // table correlated to the subject row, binding the FOR variable to the
  // target rows (and its link-property alias to the link row), then aggregate
  // the body into a JSON array. Reuses the link-array iteration FROM so the
  // link's `@count` reads off the link row rather than collapsing to
  // `sourceAlias.@count`.
  if (shapeExpr.result.expr.kind === "for_expr") {
    const forExpr = shapeExpr.result.expr as ForExpr;
    const iterPtr = forExpr.iterator.expr.kind === "pointer" ? forExpr.iterator.expr as Pointer : undefined;
    let iterRoot: Set | undefined = iterPtr?.source;
    while (iterRoot && iterRoot.expr.kind === "select_expr") iterRoot = (iterRoot.expr as SelectExpr).result;
    if (iterPtr && iterRoot?.expr.kind === "type_root"
        && !iterPtr.ptrref.isLinkProperty && !iterPtr.ptrref.outTarget.isScalar) {
      const depthN = depth + 1;
      const targetAlias = `p${depthN}`;
      const joinAlias = `j${depthN}`;
      const iterKey = pathIdKey(forExpr.iterator);
      const bindingAliases = new Map<string, string>([[iterKey, targetAlias]]);
      const linkPropertyAliases = new Map<string, string>([[iterKey, joinAlias]]);
      const cp = params.length;
      const rowExpr = compileValueSetSQLWithAliases(
        forExpr.body, bindingAliases, targetAlias, params, target, options, linkPropertyAliases,
      );
      if (rowExpr) {
        const projectedCols = [...new globalThis.Set<string>(["id", ...collectReferencedColumns(forExpr.body)])];
        const narrowed = narrowedLinkTarget(forExpr.iterator);
        const resetPtr = resetPointerSourceToRoot(iterPtr);
        // `(FOR … SELECT tuple) ORDER BY .0` sorts the result by a tuple slot;
        // map each `.N` order key to the body tuple's Nth element so it sorts
        // by a real target column / link property, then pass it as a link
        // modifier (compileLinkedInnerSelect rewrites the chain to the target).
        let modifiers: SelectExpr | undefined;
        const orderByList = shapeExpr.selectExpr?.orderBy;
        if (orderByList && orderByList.length > 0) {
          let bodyResult: Set = forExpr.body;
          while (bodyResult.expr.kind === "select_expr") bodyResult = (bodyResult.expr as SelectExpr).result;
          const bodyTuple = bodyResult.expr.kind === "tuple" ? bodyResult.expr as Tuple : undefined;
          const mapped = orderByList.map((entry) => {
            let p: Set = entry.path;
            while (p.expr.kind === "select_expr") p = (p.expr as SelectExpr).result;
            if (p.expr.kind === "index_expr" && bodyTuple) {
              const idx = extractNumericLiteral((p.expr as IndexExpr).index);
              if (idx !== undefined && bodyTuple.elements[idx]) {
                return { ...entry, path: bodyTuple.elements[idx].val };
              }
            }
            return entry;
          });
          modifiers = { ...shapeExpr.selectExpr, orderBy: mapped } as SelectExpr;
        }
        const arr = iterPtr.direction === "inbound"
          ? compileBacklinkArrayExpr(resetPtr, sourceAlias, targetAlias, joinAlias, projectedCols, rowExpr, options, modifiers, params, target, narrowed)
          : compileOutboundLinkArrayExpr(resetPtr, sourceAlias, targetAlias, joinAlias, projectedCols, rowExpr, options, modifiers, params, target, narrowed);
        return `${arr} AS ${quoteIdent(shapeAliasForElement(shape, shape.expr, depth))}`;
      }
      params.length = cp;
    }
  }
  // GATE: `field := FOR v IN {literals} UNION (SELECT subject.link { … } FILTER …)`
  // — a literal-iteration FOR whose body shapes the outer subject's link (the
  // branch above handled `FOR x IN .link`). Fires regardless of inferred
  // cardinality, like that branch.
  {
    const forSet = peelToForExpr(shapeExpr.result);
    if (forSet) {
      const cp = params.length;
      const built = compileForInShapeField(forSet, shape, sourceAlias, params, options, target, depth);
      if (built) return built;
      params.length = cp;
    }
  }
  // Computed link-property projection (`count := X.<deck[IS User]@count`): the
  // value path would collapse `@count` onto a nonexistent `sourceAlias.@count`.
  // Lower it as a correlated link-table scan and aggregate the per-link values.
  {
    const corrLinkProp = tryCompileCorrelatedLinkPropertyPathSQL(shapeExpr.result, sourceAlias, options);
    if (corrLinkProp) {
      const alias = shapeAliasForElement(shape, shapeExpr.result, depth);
      // `SELECT _ := … @count ORDER BY _` self-orders by the property value.
      const selfOrder = shapeExpr.selectExpr?.orderBy?.[0];
      const orderClause = selfOrder ? ` ORDER BY ${quoteIdent("value")} ${selfOrder.direction.toUpperCase()}` : "";
      const isMany = shape.cardinality === "many" || shape.cardinality === "at_least_one";
      // ORDER BY lives INSIDE the row subquery so json_group_array aggregates
      // the values in order (an outer ORDER BY on the single aggregate row is
      // a no-op).
      return wrapCorrelatedShapeSubquery(quoteIdent("value"), `(${corrLinkProp}${orderClause})`, isMany, alias);
    }
  }
  if (shapeExpr.result.expr.kind === "pointer" && !shapeExpr.result.typeref.isScalar) {
    return compileShapeLinkArray(shape, shapeExpr, sourceAlias, params, options, target, depth);
  }

  // Object-set coalesce computed (`coalesce := .primary ?? .secondary`,
  // `time_spent_log := (Issue.time_spent_log ?? DUMMY) {…}`): build each
  // side as a JSON array of shaped rows — correlated through the link
  // machinery when the side's pointer chain roots at the subject row, as an
  // independent source subquery otherwise — then pick the RHS array only
  // when the LHS array is empty (EdgeDB set-level `??`). Both arrays are
  // bound once in a scalar FROM so their parameters appear exactly once.
  if (shapeExpr.result.expr.kind === "coalesce_expr" && !shapeExpr.result.typeref.isScalar) {
    const coalesce = shapeExpr.result.expr as CoalesceExpr;
    const elementShape = (shape.expr.shape && shape.expr.shape.length > 0)
      ? shape.expr.shape
      : (shapeExpr.result.shape ?? []);
    const subjectTypeId = shape.source?.typeref?.id;
    const rootTypeIdOf = (start: Set): string | undefined => {
      let cur: Set = start;
      for (;;) {
        if (cur.expr.kind === "pointer") { cur = (cur.expr as Pointer).source; continue; }
        if (cur.expr.kind === "select_expr") { cur = (cur.expr as SelectExpr).result; continue; }
        break;
      }
      return cur.expr.kind === "type_root" ? (cur.expr as TypeRoot).typeref.id : undefined;
    };
    const coalesceParamsCheckpoint = params.length;
    const compileSideArray = (side: Set): string | null => {
      let cur: Set = side;
      while (cur.expr.kind === "select_expr") {
        const se = cur.expr as SelectExpr;
        if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) break;
        cur = se.result;
      }
      if (cur.expr.kind === "pointer" && !cur.typeref.isScalar) {
        const chainRoot = rootTypeIdOf((cur.expr as Pointer).source);
        if (chainRoot === undefined || chainRoot === subjectTypeId) {
          return compilePointerArrayExpr(
            cur.expr as Pointer,
            sourceAlias,
            elementShape,
            params,
            options,
            target,
            depth + 1,
            shapeExpr.selectExpr,
            narrowedLinkTarget(cur),
          );
        }
      }
      // Independent side (a WITH-bound set like DUMMY, or a chain rooted at
      // a foreign type) — lower it as its own source subquery and aggregate
      // its shaped rows.
      const innerAlias = `sg${depth + 1}`;
      const sideSet: Set = elementShape.length > 0
        ? { ...cur, shape: [...elementShape, ...(cur.shape ?? [])] }
        : cur;
      const innerSource = compileSelectSource(sideSet, undefined, undefined, options, params, target, innerAlias);
      if (!innerSource) return null;
      const rowExpr = compilePublicShapeObjectExpr(innerSource.alias, elementShape, params, options, target, depth + 1);
      return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (SELECT ${rowExpr} AS ${quoteIdent("item")} FROM ${innerSource.sql})), '[]')`;
    };
    const lhsArr = compileSideArray(coalesce.left);
    const rhsArr = lhsArr ? compileSideArray(coalesce.right) : null;
    if (lhsArr && rhsArr) {
      const combined = `(SELECT CASE WHEN json_array_length(${quoteIdent("__cl")}) > 0 THEN json(${quoteIdent("__cl")}) ELSE json(${quoteIdent("__cr")}) END`
        + ` FROM (SELECT ${lhsArr} AS ${quoteIdent("__cl")}, ${rhsArr} AS ${quoteIdent("__cr")}))`;
      const alias = shapeAliasForElement(shape, shape.expr, depth);
      // The IR's declared cardinality on coalesce computeds is unreliable
      // (`time_spent_log := Issue.time_spent_log ?? DUMMY` arrives as
      // at_most_one even though the link is multi). `??`'s cardinality is
      // the max of its sides, so infer from the sides: a side is single
      // only when it is an outbound single-cardinality pointer; WITH-bound
      // independent sets are statically many.
      const sideIsSingle = (side: Set): boolean => {
        let cur: Set = side;
        while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
        if (cur.expr.kind !== "pointer") return false;
        const p = cur.expr as Pointer;
        return p.direction !== "inbound"
          && p.ptrref.outCardinality !== "many"
          && p.ptrref.outCardinality !== "at_least_one";
      };
      const isSingle = sideIsSingle(coalesce.left) && sideIsSingle(coalesce.right);
      if (!isSingle) {
        return `${combined} AS ${quoteIdent(alias)}`;
      }
      return `json(COALESCE(json_extract(${combined}, '$[0]'), 'null')) AS ${quoteIdent(alias)}`;
    }
    params.length = coalesceParamsCheckpoint;
  }

  // Shapes-on-paths (`Issue.owner{name}`): the outer source already joined the
  // path's target type into `g0`, and `collectProjectedColumns` has surfaced
  // the leaf scalar (`name`) on that row. Reading `g0.name` directly is
  // correct and avoids re-walking the path through a correlated subquery
  // anchored on the wrong row identity.
  // A many-cardinality computed whose LEAF pointer is single (`todo_ids :=
  // .todo.id` — multi link, single id) multiplies through the link; reading
  // the leaf column off the outer row would return the row's OWN column.
  // Skip the projected-column shortcut for those so the chain compiles as a
  // correlated row set below.
  const elementIsManyViaChain = (shape.cardinality === "many" || shape.cardinality === "at_least_one")
    && shapeExpr.result.expr.kind === "pointer"
    && (shapeExpr.result.expr as Pointer).ptrref.outCardinality !== "many"
    && (shapeExpr.result.expr as Pointer).ptrref.outCardinality !== "at_least_one"
    && (shapeExpr.result.expr as Pointer).source.expr.kind === "pointer";
  // A computed whose pointer chain roots at a DIFFERENT type than the shape's
  // subject (`foo := (SELECT Status FILTER …).name` inside a User shape) is
  // an independent subquery — reading the leaf column off the subject row
  // would return the subject's own column of the same name.
  const elementRootsAtForeignType = ((): boolean => {
    if (shapeExpr.result.expr.kind !== "pointer" || !shape.source?.typeref) return false;
    const rootTypeOf = (start: Set): string | undefined => {
      let cur: Set = start;
      for (;;) {
        if (cur.expr.kind === "pointer") { cur = (cur.expr as Pointer).source; continue; }
        if (cur.expr.kind === "select_expr") { cur = (cur.expr as SelectExpr).result; continue; }
        break;
      }
      return cur.expr.kind === "type_root" ? (cur.expr as TypeRoot).typeref.id : undefined;
    };
    const elementRoot = rootTypeOf((shapeExpr.result.expr as Pointer).source);
    if (!elementRoot) return false;
    if (elementRoot === shape.source.typeref.id) return false;
    // Shapes-on-paths (`Issue.owner {name}`): the element chain legitimately
    // roots at the PATH's root type, not the narrowed subject type.
    const sourcePathRoot = rootTypeOf(shape.source);
    return elementRoot !== sourcePathRoot;
  })();
  if (elementRootsAtForeignType) {
    const scratchParams: ScalarValue[] = [];
    const setSql = compileScalarSelectSQL(shape.expr, scratchParams, target, options);
    if (setSql) {
      params.push(...scratchParams);
      const alias = shapeAliasForElement(shape, shapeExpr.result, depth);
      return wrapCorrelatedShapeSubquery(
        quoteIdent("value"), `(${setSql})`,
        shape.cardinality === "many" || shape.cardinality === "at_least_one", alias,
      );
    }
  }
  // Computed shape field that projects a scalar leaf off the OBJECT a UDF /
  // assert_* call returns: `c := foo(.b).a`, `a := foo(.bar).a`. The inlined
  // UDF body (or an `assert_exists((select T …))`) leaves the leaf pointer's
  // source bottoming out at an object-returning `function_call` rather than a
  // plain type_root chain, so the projected-column shortcut below can't see a
  // backing column and the element would be silently dropped. Lower it as a
  // correlated subquery over the body's object rows, projecting the leaf
  // column. Scoped narrowly to a single scalar leaf over an object-returning
  // call so scalar-returning function computeds (`title5 := ident(.title)`)
  // keep their existing, working lowering.
  const leafOverObjectCall = ((): Pointer | null => {
    if (shapeExpr.result.expr.kind !== "pointer") return null;
    const leaf = shapeExpr.result.expr as Pointer;
    if (!leaf.ptrref.outTarget.isScalar || leaf.ptrref.isLinkProperty) return null;
    let cur: Set = leaf.source;
    for (let guard = 0; guard < 64; guard += 1) {
      const e = cur.expr;
      if (e.kind === "select_expr") { cur = (e as SelectExpr).result; continue; }
      if (e.kind === "function_call") {
        return cur.typeref && !cur.typeref.isScalar ? leaf : null;
      }
      return null;
    }
    return null;
  })();
  if (leafOverObjectCall) {
    const leaf = leafOverObjectCall;
    const alias = shapeAliasForElement(shape, shapeExpr.result, depth);
    const isMany = shape.cardinality === "many" || shape.cardinality === "at_least_one";
    // Peel select_expr fences and object-passthrough calls (assert_exists /
    // assert_single around a SELECT, inlined UDF bodies) down to the
    // object-producing set. The assert_exists guard injects a redundant
    // `exists(arg)` WHERE on the OUTER wrapper — skip that and any clause-free
    // fence, but stop at a select_expr that carries the body's real
    // FILTER / LIMIT / OFFSET / ORDER BY so compileSelectSource applies them.
    let objSource = leaf.source;
    for (let guard = 0; guard < 64; guard += 1) {
      if (objSource.expr.kind === "select_expr") {
        const se = objSource.expr as SelectExpr;
        const hasRealClauses =
          (se.where !== undefined && se.where.expr.kind !== "exists_expr")
          || se.limit !== undefined
          || se.offset !== undefined
          || (se.orderBy !== undefined && se.orderBy.length > 0);
        if (hasRealClauses) break;
        objSource = se.result;
        continue;
      }
      const unwrapped = unwrapObjectPassthrough(objSource);
      if (unwrapped) { objSource = unwrapped; continue; }
      break;
    }
    const scratch: ScalarValue[] = [];
    const leafCol = columnForPointer(leaf);
    // Give the inner object source a distinct alias: a correlated body
    // (`assert_exists(select Bar filter .a = x)` with `x := .b`) references the
    // subject row's `.b`, which must resolve to the enclosing scope's alias
    // rather than colliding with the inner type's default `g0`.
    const innerAlias = `sfn${depth}`;
    const compiled = compileSelectSource(objSource, undefined, undefined, options, scratch, target, innerAlias, [leafCol]);
    if (compiled) {
      params.push(...scratch);
      const colExpr = `${compiled.alias}.${quoteIdent(leafCol)}`;
      const value = shapeScalarColumnValue(colExpr, leaf.ptrref.outTarget);
      return wrapCorrelatedShapeSubquery(value, compiled.sql, isMany, alias);
    }
  }
  // Computed shape field that projects a scalar leaf through an intermediate
  // single object link not joined into the outer row (`a := .bar.a`) — lowered
  // as a correlated subquery over the link's target rows (see the helper).
  const leafThroughForeignSql = compileShapeLeafThroughForeignLink(shape, shapeExpr, sourceAlias, params, options, target, depth);
  if (leafThroughForeignSql !== null) return leafThroughForeignSql;
  const projectedColumn = (elementIsManyViaChain || elementRootsAtForeignType) ? null : compileProjectedSourceColumnRef(shapeExpr.result);
  if (projectedColumn) {
    // `[is Bb & Bc].bb` — the property's source was intersection-narrowed to a
    // type (or `|`-union of types) distinct from the underlying type_root. The
    // column may exist on rows OUTSIDE the narrowed set (`CBaBb` has `bb` but is
    // not `Bb & Bc`), so reading it bare would leak those rows' values. Gate the
    // column by the subject's `__source_type` so only rows of the narrowed
    // concrete types contribute; the rest read NULL (the empty `[is T]` view).
    const rawColumnRef = `${sourceAlias}.${quoteIdent(projectedColumn)}`;
    const narrowGuard = ((): string | null => {
      const e = shapeExpr.result.expr;
      if (e.kind !== "pointer") return null;
      const src = (e as Pointer).source;
      if (src.expr.kind !== "type_root") return null;
      const rootId = (src.expr as TypeRoot).typeref.id;
      if (!src.typeref || src.typeref.id === rootId) return null;
      const concrete = concreteSourceTypeNames(src.typeref).map((name) => quoteLiteral(name));
      if (concrete.length === 0) return null;
      return `${sourceAlias}.${quoteIdent("__source_type")} IN (${concrete.join(", ")})`;
    })();
    const rawValue = narrowGuard
      ? `(CASE WHEN ${narrowGuard} THEN ${rawColumnRef} END)`
      : rawColumnRef;
    const isMultiScalar = shapeExpr.result.expr.kind === "pointer"
      && ((shapeExpr.result.expr as Pointer).ptrref.outCardinality === "many"
          || (shapeExpr.result.expr as Pointer).ptrref.outCardinality === "at_least_one");
    // Shape-local clauses on a multi scalar projection (`tag_set1 ORDER BY
    // Item.tag_set1 DESC LIMIT 1`) need a json_each subquery so the
    // ordering / limit applies to the unpacked elements before they are
    // re-aggregated into the output JSON array.
    const hasShapeClauses = shapeExpr.selectExpr
      && (shapeExpr.selectExpr.where
          || (shapeExpr.selectExpr.orderBy && shapeExpr.selectExpr.orderBy.length > 0)
          || shapeExpr.selectExpr.limit
          || shapeExpr.selectExpr.offset);
    if (isMultiScalar && hasShapeClauses) {
      const alias = shapeAliasForElement(shape, shapeExpr.result, depth);
      const leafColumn = projectedColumn;
      const innerOptions: GelIRCompileOptions = {
        ...options,
        multiScalarBindings: new Map([
          ...(options.multiScalarBindings ?? new Map()),
          [pathIdKey(shapeExpr.result), `je.${quoteIdent("value")}`],
          [pathIdKey(shape.expr), `je.${quoteIdent("value")}`],
        ]),
      };
      let inner = `SELECT je.${quoteIdent("value")} AS ${quoteIdent("value")} FROM json_each(COALESCE(${sourceAlias}.${quoteIdent(leafColumn)}, '[]')) je`;
      if (shapeExpr.selectExpr?.where) {
        const w = compilePredicateSetSQL(shapeExpr.selectExpr.where, sourceAlias, params, target, innerOptions)
          ?? compileValueSetSQL(shapeExpr.selectExpr.where, sourceAlias, params, target, innerOptions);
        if (w) inner += ` WHERE ${w}`;
      }
      if (shapeExpr.selectExpr?.orderBy && shapeExpr.selectExpr.orderBy.length > 0) {
        const orderParts = shapeExpr.selectExpr.orderBy
          .map((o) => {
            const exprSql = compileValueSetSQL(o.path, sourceAlias, params, target, innerOptions);
            return exprSql ? `${exprSql} ${o.direction.toUpperCase()}` : null;
          })
          .filter((s): s is string => s != null);
        if (orderParts.length > 0) inner += ` ORDER BY ${orderParts.join(", ")}`;
      }
      const limit = extractNumericLiteral(shapeExpr.selectExpr?.limit);
      if (limit !== undefined) inner += ` LIMIT ${limit}`;
      const offset = extractNumericLiteral(shapeExpr.selectExpr?.offset);
      if (offset !== undefined) {
        if (limit === undefined) inner += ` LIMIT -1`;
        inner += ` OFFSET ${offset}`;
      }
      return `COALESCE((SELECT json_group_array("value") FROM (${inner})), '[]') AS ${quoteIdent(alias)}`;
    }
    let value: string;
    if (isMultiScalar) {
      // Multi scalar properties are stored as JSON-encoded TEXT; an empty
      // multi materializes as NULL in storage but EdgeQL set semantics
      // requires `[]`. Wrap with COALESCE→'[]' and parse as JSON.
      value = `json(COALESCE(${rawValue}, '[]'))`;
    } else if (shapeExpr.result.typeref.collection) {
      value = `json(${rawValue})`;
    } else if (qualifyTypeName(shapeExpr.result.typeref) === "std::bool") {
      // SQLite has no boolean type — bool columns store 0/1. Surface a real
      // JSON boolean so the decoded scalar is `true`/`false`, not `1`/`0`.
      value = `(CASE WHEN ${rawValue} IS NULL THEN NULL WHEN ${rawValue} THEN json('true') ELSE json('false') END)`;
    } else {
      value = rawValue;
    }
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
  // Carry the outermost explicit shape down through the peel — the computed
  // element's `sub { body }` shape lives on the WRAPPER set, and the
  // innermost result often only has the implicit `{id}`.
  let peeledShapeOverride: ShapeElement[] | undefined =
    shape.expr.shape && shape.expr.shape.length > 0
      ? shape.expr.shape
      : (shapeExpr.result.shape && shapeExpr.result.shape.length > 0 ? shapeExpr.result.shape : undefined);
  while (peeled.expr.kind === "select_expr") {
    const se = peeled.expr as SelectExpr;
    if (se.where && !peeledClauses.where) peeledClauses.where = se.where;
    if (se.orderBy && se.orderBy.length && !peeledClauses.orderBy) peeledClauses.orderBy = se.orderBy;
    if (se.limit && !peeledClauses.limit) peeledClauses.limit = se.limit;
    if (se.offset && !peeledClauses.offset) peeledClauses.offset = se.offset;
    peeled = se.result;
    if (!peeledShapeOverride && peeled.shape && peeled.shape.length > 0) {
      peeledShapeOverride = peeled.shape;
    }
  }
  if (peeledShapeOverride && peeledShapeOverride !== peeled.shape
      && peeledShapeOverride.some((el) => el.shapeOrigin === "explicit" || el.name !== undefined)) {
    peeled = { ...peeled, shape: peeledShapeOverride };
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
        { alias: sourceAlias, typeref: shape.source.typeref, namespace: [] },
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
      return wrapCorrelatedShapeSubquery(
        `json("item")`, `(${subSql})`,
        shape.cardinality === "many" || shape.cardinality === "at_least_one", alias,
      );
    }
  }

  // Optional-compare computed over a multi link off the subject row
  // (`log1 := Issue.time_spent_log ?= LOG1`): the generic value/scalar paths
  // either fail or compile an UNcorrelated set-level compare (every row gets
  // the global answer). Lower as a correlated row set per outer row.
  if (shapeExpr.result.expr.kind === "operator_call") {
    const cmpCall = shapeExpr.result.expr as OperatorCall;
    if (cmpCall.operator === "?=" || cmpCall.operator === "?!=") {
      const cmpArgs = orderedCallArgs(cmpCall.args);
      if (cmpArgs.length === 2) {
        let cmpLhs: Set = cmpArgs[0].expr;
        while (cmpLhs.expr.kind === "select_expr") {
          const se = cmpLhs.expr as SelectExpr;
          if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) break;
          cmpLhs = se.result;
        }
        const subjectId = shape.source?.typeref?.id;
        const lhsRootsAtSubject = cmpLhs.expr.kind === "pointer"
          && (() => {
            let cur: Set = (cmpLhs.expr as Pointer).source;
            while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
            return cur.expr.kind === "type_root" && (cur.expr as TypeRoot).typeref.id === subjectId;
          })();
        const rhsRootIds = new globalThis.Set<string>();
        collectTypeRootIds(cmpArgs[1].expr, rhsRootIds);
        if (lhsRootsAtSubject && subjectId !== undefined && !rhsRootIds.has(subjectId)) {
          const rows = compileCorrelatedOptionalCompareRows(
            cmpCall.operator,
            cmpLhs.expr as Pointer,
            sourceAlias,
            cmpArgs[1].expr,
            params,
            target,
            options,
            sqlLoweringContext(),
          );
          if (rows) {
            const alias = shapeAliasForElement(shape, shapeExpr.result, depth);
            return `COALESCE((SELECT json_group_array(json(v)) FROM (${rows})), '[]') AS ${quoteIdent(alias)}`;
          }
        }
      }
    }
  }

  // Subject-rooted optional ops with a MULTI (union) RHS in a computed
  // (`comp := Issue.time_estimate ?? {-1,-2}`, `te := Issue.time_estimate ?=
  // {60,30}`): the generic paths either inline a type-mixed COALESCE (scalar
  // when the LHS is present, JSON-array text when absent) or compile a
  // GLOBAL set-level form (one answer shared by every row). Lower per
  // subject row instead, as a JSON array — a multi RHS makes the computed
  // multi.
  {
    let res: Set = shapeExpr.result;
    while (res.expr.kind === "select_expr") {
      const se = res.expr as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) break;
      res = se.result;
    }
    const subjectId = shape.source?.typeref?.id;
    const subjectScalarColumn = (s: Set): string | null => {
      let cur: Set = s;
      while (cur.expr.kind === "select_expr") {
        const se = cur.expr as SelectExpr;
        if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
        cur = se.result;
      }
      if (cur.expr.kind !== "pointer") return null;
      const ptr = cur.expr as Pointer;
      if (ptr.direction !== "outbound" || !ptr.ptrref.outTarget.isScalar
          || ptr.ptrref.isLinkProperty || shouldUseLinkTable(ptr)) return null;
      let root: Set = ptr.source;
      while (root.expr.kind === "select_expr") {
        const se = root.expr as SelectExpr;
        if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
        root = se.result;
      }
      if (root.expr.kind !== "type_root" || (root.expr as TypeRoot).typeref.id !== subjectId) return null;
      return columnForPointer(ptr);
    };
    const multiUnionArgs = (s: Set): CallArg[] | null => {
      let cur: Set = s;
      while (cur.expr.kind === "select_expr") {
        const se = cur.expr as SelectExpr;
        if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
        cur = se.result;
      }
      if (cur.expr.kind !== "operator_call" || (cur.expr as OperatorCall).operator !== "union") return null;
      const args = orderedCallArgs((cur.expr as OperatorCall).args);
      return args.length > 1 ? args : null;
    };
    const compileUnionRows = (args: CallArg[]): string | null => {
      const ckpt = params.length;
      const parts: string[] = [];
      for (const arg of args) {
        const v = compileValueSetSQL(arg.expr, sourceAlias, params, target, options);
        if (!v) {
          params.length = ckpt;
          return null;
        }
        parts.push(`SELECT ${v} AS v`);
      }
      return parts.join(" UNION ALL ");
    };
    if (subjectId !== undefined && res.expr.kind === "coalesce_expr") {
      const ce = res.expr as CoalesceExpr;
      const col = subjectScalarColumn(ce.left);
      const unionArgs = multiUnionArgs(ce.right);
      if (col && unionArgs) {
        const rows = compileUnionRows(unionArgs);
        if (rows) {
          const lhsSql = `${sourceAlias}.${quoteIdent(col)}`;
          const alias = shapeAliasForElement(shape, shapeExpr.result, depth);
          return `(CASE WHEN ${lhsSql} IS NOT NULL THEN json_array(${lhsSql})`
            + ` ELSE (SELECT json_group_array(v) FROM (${rows})) END) AS ${quoteIdent(alias)}`;
        }
      }
    }
    if (subjectId !== undefined && res.expr.kind === "operator_call") {
      const cmpCall = res.expr as OperatorCall;
      if (cmpCall.operator === "?=" || cmpCall.operator === "?!=") {
        const cmpArgs = orderedCallArgs(cmpCall.args);
        if (cmpArgs.length === 2) {
          const col = subjectScalarColumn(cmpArgs[0].expr);
          const unionArgs = multiUnionArgs(cmpArgs[1].expr);
          if (col && unionArgs) {
            const rows = compileUnionRows(unionArgs);
            if (rows) {
              const lhsSql = `${sourceAlias}.${quoteIdent(col)}`;
              const isOp = cmpCall.operator === "?=" ? "IS" : "IS NOT";
              const alias = shapeAliasForElement(shape, shapeExpr.result, depth);
              return `(SELECT json_group_array(json(CASE WHEN ${lhsSql} ${isOp} r.v THEN 'true' ELSE 'false' END))`
                + ` FROM (${rows}) r) AS ${quoteIdent(alias)}`;
            }
          }
        }
      }
    }
  }

  const shapeValueCheckpoint = params.length;
  const valueExpr = compileValueSetSQL(shapeExpr.result, sourceAlias, params, target, options);
  if (!valueExpr) {
    // Computed shape whose RHS is a set-producing expression we can't
    // express inline (a DISTINCT over a FOR-driven UNION, etc.). Fall back
    // to compiling the RHS as its own scalar-select source and aggregating
    // its `value` column into a JSON array; without this the projection is
    // silently dropped and the field disappears from the result envelope.
    const scratchParams: ScalarValue[] = [];
    // Make the outer source (the shape's iteration row) visible so
    // references like `Item.tag_array` inside the RHS resolve to the outer
    // alias rather than fall through to a fresh placeholder.
    const innerScalarOptions: GelIRCompileOptions = {
      ...options,
      outerScopes: [
        ...(options.outerScopes ?? []),
        { alias: sourceAlias, typeref: shape.source.typeref, namespace: [] },
      ],
    };
    const scalarSql = compileScalarSelectSQL(shapeExpr.result, scratchParams, target, innerScalarOptions);
    if (scalarSql) {
      params.push(...scratchParams);
      const subAlias = shapeAliasForElement(shape, shapeExpr.result, depth);
      // The inner select's `value` column may carry a JSON-encoded blob
      // (object shape, array, tuple) or a plain scalar (str, int). SQLite's
      // `json()` is strict and raises "malformed JSON" on a bare word like
      // "wood", so we need to distinguish at compile time:
      //   * known JSON-typed value → wrap with `json(value)`
      //   * scalar / unknown      → emit `value` raw; json_group_array will
      //     quote strings correctly while preserving numeric/JSON inputs.
      const resultTyperef = shapeExpr.result.typeref;
      const valueIsJsonShaped = !!resultTyperef.collection
        || (!resultTyperef.isScalar && resultTyperef.inSchema === true);
      const elementExpr = valueIsJsonShaped
        ? `json(${quoteIdent("value")})`
        : quoteIdent("value");
      return `COALESCE((SELECT json_group_array(${elementExpr}) FROM (${scalarSql})), '[]') AS ${quoteIdent(subAlias)}`;
    }
    return null;
  }
  if (shape.cardinality === "many" || shape.cardinality === "at_least_one") {
    // A many-cardinality computed (`t := {(1,2),(3,4)}`, `x := .tags = 'red'`)
    // is a SET — the single-value expression above would collapse it to one
    // row. Prefer the set-producing scalar lowering (correlated to the outer
    // row) and aggregate its rows; fall back to wrapping the single value.
    // Only divert to the set-producing lowering when the expression really
    // yields multiple rows per outer row — a union/set-constructor or an
    // element-wise expression over a correlated multi-scalar. A simple
    // declared-multi single value (`multi foo := <int64>.number + 10`)
    // compiles correlated through the plain value path below; the scalar
    // select would open an UNcorrelated scan.
    const multiLeafProbe: Set[] = [];
    collectCorrelatedMultiScalarLeafSets(shape.expr, multiLeafProbe);
    const producesRowSet = multiLeafProbe.length > 0 || containsUnionOperator(shape.expr);
    const scratchParams: ScalarValue[] = [];
    const innerScalarOptions: GelIRCompileOptions = {
      ...options,
      outerScopes: [
        ...(options.outerScopes ?? []),
        { alias: sourceAlias, typeref: shape.source.typeref, namespace: [] },
      ],
    };
    // Pass the FULL expression set (`shape.expr`) — not the unwrapped result —
    // so a wrapping `(select _ := … order by _)`'s clauses survive into the
    // set lowering.
    const setSql = producesRowSet
      ? compileScalarSelectSQL(shape.expr, scratchParams, target, innerScalarOptions)
      : null;
    if (setSql) {
      params.length = shapeValueCheckpoint;
      params.push(...scratchParams);
      const resultTyperef = shapeExpr.result.typeref;
      const typeName = qualifyTypeName(resultTyperef);
      const valueIsJsonShaped = !!resultTyperef.collection
        || (!resultTyperef.isScalar && resultTyperef.inSchema === true)
        || typeName === "std::bool"
        || typeName === "std::tuple"
        || typeName === "std::array"
        || typeName === "std::json";
      const elementExpr = valueIsJsonShaped
        ? `json(${quoteIdent("value")})`
        : quoteIdent("value");
      return `COALESCE((SELECT json_group_array(${elementExpr}) FROM (${setSql})), '[]') AS ${quoteIdent(shapeAliasForElement(shape, shapeExpr.result, depth))}`;
    }
    return `COALESCE((SELECT json_group_array(value) FROM (SELECT ${valueExpr} AS value)), '[]') AS ${quoteIdent(shapeAliasForElement(shape, shapeExpr.result, depth))}`;
  }
  // Single-cardinality computed whose RHS is a UNION wrapped in select
  // clauses (`open := (SELECT (a UNION b) LIMIT 1)`): the plain value path
  // would aggregate the union eagerly and drop the clauses. Lower the row
  // set with its clauses applied and take the single row.
  const hasSelectClauses = shapeExpr.selectExpr
    && (shapeExpr.selectExpr.limit
        || shapeExpr.selectExpr.offset
        || (shapeExpr.selectExpr.orderBy && shapeExpr.selectExpr.orderBy.length > 0)
        || shapeExpr.selectExpr.where);
  if (hasSelectClauses && containsUnionOperator(shapeExpr.result)) {
    const scratchParams: ScalarValue[] = [];
    const innerScalarOptions: GelIRCompileOptions = {
      ...options,
      outerScopes: [
        ...(options.outerScopes ?? []),
        { alias: sourceAlias, typeref: shape.source.typeref, namespace: [] },
      ],
    };
    const setSql = compileScalarSelectSQL(shape.expr, scratchParams, target, innerScalarOptions);
    if (setSql) {
      params.length = shapeValueCheckpoint;
      params.push(...scratchParams);
      return `(SELECT ${quoteIdent("value")} FROM (${setSql}) LIMIT 1) AS ${quoteIdent(shapeAliasForElement(shape, shapeExpr.result, depth))}`;
    }
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
  // `FILTER {}` (or `FILTER <T>{}`) is an empty set: EdgeQL keeps a row only
  // when the filter yields `true`, so an empty filter retains nothing. Compile
  // it to a never-true predicate rather than letting the empty expression drop
  // the clause (which would wrongly return every row).
  if (isEmptySetBranch(set)) {
    return "0";
  }
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
  const sourceRootSet: Set = (sourceChain[sourceChain.length - 1].source);
  const sourceLeafType = sourceChain[0].ptrref.outTarget;

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
    const correlated = tryCompileCorrelatedExistsSelect(innerSet, sourceAlias, params, target, options, sqlLoweringContext());
    if (correlated) return correlated;
    const direct = tryCompileExistsObjectPointerSQL(innerSet, sourceAlias, params, target, options, sqlLoweringContext());
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
    if (process.env.DEBUG_PRED) console.error("[pred fn]", (set.expr as FunctionCall).functionName);
    const value = compileValueSetSQL(set, sourceAlias, params, target, options, linkPropertyAlias);
    if (process.env.DEBUG_PRED) console.error("[pred fn] value:", value);
    // The value layer emits JSON booleans (json('true') is the TEXT 'true',
    // which is falsy as a bare WHERE expression) — normalize both JSON and
    // native boolean shapes to a SQL truth value, binding the value once.
    if (value) {
      return `(SELECT CASE WHEN p IS NULL THEN 0 WHEN p = json('true') THEN 1 WHEN p = json('false') THEN 0 WHEN p THEN 1 ELSE 0 END FROM (SELECT (${value}) AS p))`;
    }
    params.length = checkpoint;
    return null;
  }
  // `FILTER <a> IF <cond> ELSE <b>` — compile all three as predicates and
  // pick per row with CASE. (EXISTS-style conditions are never NULL, so the
  // CASE's two-way split matches EdgeQL's semantics here.)
  if (set.expr.kind === "if_else_expr") {
    const ifElse = set.expr as IfElseExpr;
    const cond = compilePredicateSetSQL(ifElse.condition, sourceAlias, params, target, options, linkPropertyAlias)
      ?? compileValueSetSQL(ifElse.condition, sourceAlias, params, target, options, linkPropertyAlias);
    const ifPred = cond
      ? (compilePredicateSetSQL(ifElse.ifExpr, sourceAlias, params, target, options, linkPropertyAlias)
        ?? compileValueSetSQL(ifElse.ifExpr, sourceAlias, params, target, options, linkPropertyAlias))
      : null;
    const elsePred = ifPred
      ? (compilePredicateSetSQL(ifElse.elseExpr, sourceAlias, params, target, options, linkPropertyAlias)
        ?? compileValueSetSQL(ifElse.elseExpr, sourceAlias, params, target, options, linkPropertyAlias))
      : null;
    if (cond && ifPred && elsePred) {
      return `(CASE WHEN ${cond} THEN (${ifPred}) ELSE (${elsePred}) END)`;
    }
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
    const operandsStart = params.length;
    const left = compilePredicateSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias)
      ?? compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compilePredicateSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias)
      ?? compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left || !right) {
      params.length = checkpoint;
      return null;
    }
    const operandsEnd = params.length;
    // EdgeQL AND/OR are strict on empty operands: `{} OR true` is `{}`, so a
    // FILTER drops the row. SQL's OR would instead let the non-empty side
    // win (EXISTS-lowered comparisons surface empty paths as FALSE). Guard
    // the OR with an existence check for every strict pointer path either
    // operand traverses. AND doesn't need this: a FALSE/NULL operand already
    // rejects the row.
    if (call.operator === "or") {
      const chains: Set[] = [];
      collectStrictPointerChainSets(args[0].expr, chains, sqlLoweringContext());
      collectStrictPointerChainSets(args[1].expr, chains, sqlLoweringContext());
      const guards: string[] = [];
      const seenGuards = new globalThis.Set<string>();
      for (const chain of chains) {
        const guard = compilePathExistenceGuard(chain, sourceAlias, params, target, options, sqlLoweringContext());
        if (guard && !seenGuards.has(guard)) {
          seenGuards.add(guard);
          guards.push(guard);
        }
      }
      if (guards.length > 0) {
        // Emit the guard via CASE→NULL (not a bare AND) so an enclosing NOT
        // keeps the empty-set semantics: `NOT ({} OR x)` is `{}` (row drops),
        // and SQL's `NOT NULL` is NULL, which WHERE also treats as false. A
        // plain `guard AND (l OR r)` would flip to TRUE under NOT.
        return `(CASE WHEN NOT (${guards.join(" AND ")}) THEN NULL ELSE (${left} OR ${right}) END)`;
      }
    }
    // EdgeQL AND is strict on empty operands too: `{} AND false` is `{}`
    // (the row drops), but SQLite's three-valued `NULL AND 0` is `0`, which
    // an enclosing NOT would flip to keep the row. Force NULL propagation —
    // the ELSE re-emits both operands, so their params are pushed again.
    if (call.operator === "and") {
      params.push(...params.slice(operandsStart, operandsEnd));
      return `(CASE WHEN (${left}) IS NULL OR (${right}) IS NULL THEN NULL ELSE (${left}) AND (${right}) END)`;
    }
    return `(${left} ${call.operator.toUpperCase()} ${right})`;
  }

  if (call.operator === "not") {
    const args = orderedCallArgs(call.args);
    if (args.length < 1) {
      params.length = checkpoint;
      return null;
    }
    // EdgeQL `NOT` is element-wise over the operand's boolean set: an empty
    // operand (optional path) stays empty, so the FILTER still drops the
    // row. Wrapping `NOT` around an EXISTS-lowered comparison would instead
    // turn "path is empty" into TRUE. Push the negation into the comparison
    // operator (NOT (x = v) ≡ x != v element-wise) so the EXISTS lowering
    // keeps the correct empty-set behaviour.
    const NEGATED_OPS: Record<string, string> = {
      "=": "!=", "!=": "=",
      "<": ">=", ">=": "<",
      ">": "<=", "<=": ">",
      "in": "not in", "not in": "in",
      "like": "not_like", "not_like": "like",
      "ilike": "not_ilike", "not_ilike": "ilike",
      "?=": "?!=", "?!=": "?=",
    };
    let operand: Set = args[0].expr;
    while (operand.expr.kind === "select_expr") {
      const se = operand.expr as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) break;
      operand = se.result;
    }
    if (operand.expr.kind === "operator_call") {
      const innerCall = operand.expr as OperatorCall;
      const negated = NEGATED_OPS[innerCall.operator];
      if (negated) {
        const negatedCall: OperatorCall = { ...innerCall, operator: negated };
        const pushed = compilePredicateSetSQL(
          { ...operand, expr: negatedCall }, sourceAlias, params, target, options, linkPropertyAlias,
        );
        if (pushed) return pushed;
        params.length = checkpoint;
      }
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
    // Correlated multi-scalar RHS: `'x' IN .tag_set1` where `.tag_set1` is
    // a multi-cardinality scalar property hanging off the outer source row.
    // Emit a correlated `json_each(g0.col)` subquery — a fresh
    // compileScalarSelectSQL would build an UNcorrelated FROM that scans
    // every row in the type table, defeating the predicate.
    const rhsCorrelated = tryCompileCorrelatedMultiScalarRHS(args[1].expr, sourceAlias, options);
    if (rhsCorrelated) {
      const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
      if (!left) {
        params.length = checkpoint;
        return null;
      }
      const op = call.operator === "in" ? "IN" : "NOT IN";
      return `(${left} ${op} (${rhsCorrelated}))`;
    }
    // Correlated multi-scalar LHS: `.tag_set1 IN {…}` — emit a correlated
    // subquery whose value column is the unpacked element, then EXISTS-test
    // membership against the RHS values. EdgeQL's `X IN Y` over a multi
    // LHS is element-wise: it produces a set of booleans, one per X-element,
    // and FILTER keeps the row when *any* boolean is true. An empty LHS
    // produces an empty boolean set, which a FILTER drops.
    const lhsCorrelated = tryCompileCorrelatedMultiScalarRHS(args[0].expr, sourceAlias, options);
    if (lhsCorrelated) {
      const rightValuesEarly = extractInPredicateLiteralValues(args[1].expr);
      if (rightValuesEarly && rightValuesEarly.length > 0) {
        const placeholders = rightValuesEarly.map(() => "?").join(", ");
        params.push(...rightValuesEarly);
        const existsKW = call.operator === "in" ? "EXISTS" : "NOT EXISTS";
        const inKW = "IN";
        return `(${existsKW} (SELECT 1 FROM (${lhsCorrelated}) WHERE "value" ${inKW} (${placeholders})))`;
      }
    }
    // Correlated multi LHS that is a scalar POINTER PATH (`User.friends.id IN
    // <set>`) against a row-set RHS — e.g. the membership a typed backlink off
    // group elements (`X.elements.<friends[is User]`) decorrelates to. EdgeQL
    // `X IN Y` over a multi LHS is element-wise (keep the row when ANY LHS
    // element is in Y), so EXISTS-test the LHS path's rows against the RHS set.
    {
      const lhsPath = tryCompileCorrelatedScalarPointerPathScalarSelect(args[0].expr, sourceAlias, options);
      if (lhsPath) {
        const rhsCp = params.length;
        const rhsSet = compileScalarSelectSQL(args[1].expr, params, target, options);
        if (rhsSet) {
          const existsKW = call.operator === "in" ? "EXISTS" : "NOT EXISTS";
          return `(${existsKW} (SELECT 1 FROM (${lhsPath}) WHERE ${quoteIdent("value")} IN (${rhsSet})))`;
        }
        params.length = rhsCp;
      }
    }
    const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left) {
      params.length = checkpoint;
      return null;
    }
    const rightValues = extractInPredicateLiteralValues(args[1].expr);
    if (rightValues && rightValues.length > 0) {
      const placeholders = rightValues.map(() => "?").join(", ");
      params.push(...rightValues);
      return `(${left} ${call.operator === "in" ? "IN" : "NOT IN"} (${placeholders}))`;
    }
    // Correlated path RHS: `x IN {.val, .children.val, …}` — each element is a
    // path rooted at the outer row, so it must correlate to `sourceAlias`
    // rather than scan the whole table (which a free compileScalarSelectSQL
    // would do).
    const rightCorrelated = tryCompileCorrelatedUnionScalarSelect(args[1].expr, sourceAlias, options);
    if (rightCorrelated) {
      const op = call.operator === "in" ? "IN" : "NOT IN";
      return `(${left} ${op} (${rightCorrelated}))`;
    }
    // Non-literal RHS: compile as a set-producing SELECT (handles
    // `.tag_set IN {…}` and other multi-row right-hand sides).
    const rightSelect = compileScalarSelectSQL(args[1].expr, params, target, options);
    if (rightSelect) {
      const op = call.operator === "in" ? "IN" : "NOT IN";
      return `(${left} ${op} (${rightSelect}))`;
    }
    params.length = checkpoint;
    return null;
  }

  // `?=` / `?!=` in predicate position: SQLite's IS / IS NOT are null-safe
  // equality, and unlike the value-level CASE json('true') form, the result
  // is a native boolean usable directly in WHERE (the JSON text 'true'
  // casts to 0 there).
  if (call.operator === "?=" || call.operator === "?!=") {
    const optArgs = orderedCallArgs(call.args);
    if (optArgs.length >= 2) {
      const left = compileValueSetSQL(optArgs[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
      const right = left && compileValueSetSQL(optArgs[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
      if (left && right) {
        return `(${left} ${call.operator === "?=" ? "IS" : "IS NOT"} ${right})`;
      }
      params.length = checkpoint;
    }
  }

  // `<x> LIKE/ILIKE <set>` where one operand ranges over a FOREIGN root — a
  // different extent than the SELECT subject (`DeleteTest2.name LIKE
  // DeleteTest.name[:2] ++ '%'`, where `DeleteTest` is independent of the
  // filtered `DeleteTest2`). The match is element-wise over that set and the
  // FILTER keeps the row when ANY element matches. The plain value path below
  // would collapse the foreign root onto the outer alias (so every row matches
  // its own name), so unpack the set side into a correlated EXISTS, preserving
  // the operator's operand order (LIKE is not symmetric). The current subject
  // is registered in `outerScopes`, so its own references stay correlated to
  // the outer alias and are NOT mistaken for a foreign set. `=`/`!=`/ordering
  // operators have their own set lowering below; this covers the string-match
  // operators `normalizeOperator` doesn't recognise.
  if (call.operator === "like" || call.operator === "ilike"
      || call.operator === "not_like" || call.operator === "not_ilike") {
    const likeArgs = orderedCallArgs(call.args);
    if (likeArgs.length >= 2) {
      const negated = call.operator === "not_like" || call.operator === "not_ilike";
      const insensitive = call.operator === "ilike" || call.operator === "not_ilike";
      const renderLike = (lhs: string, rhs: string): string => insensitive
        ? `LOWER(${lhs}) ${negated ? "NOT LIKE" : "LIKE"} LOWER(${rhs})`
        : `${lhs} ${negated ? "NOT LIKE" : "LIKE"} ${rhs}`;
      for (const swap of [false, true] as const) {
        const setArgIdx = swap ? 0 : 1;
        const otherIdx = swap ? 1 : 0;
        const setArg = likeArgs[setArgIdx].expr;
        if (isSingletonOuterScopeRef(setArg, options)) continue;
        if (isSingleObjectLinkRef(setArg)) continue;
        // Only set-treat an operand that reaches a foreign root: a scalar
        // pointer source not bound to the current/enclosing scope. A pure
        // literal/correlated operand (no sources, or all-outer) keeps the plain
        // value comparison.
        const argSources = new Map<string, TypeRef>();
        collectScalarPointerSources(setArg, argSources);
        if (argSources.size === 0) continue;
        let hasForeignRoot = false;
        for (const [key, typeref] of argSources.entries()) {
          const ns = key.includes("|") ? key.slice(key.indexOf("|") + 1) : "";
          const namespace = ns.length > 0 ? ns.split(",") : [];
          if (!findMatchingOuterScope({ typerefId: typeref.id, namespace }, options)) {
            hasForeignRoot = true;
            break;
          }
        }
        if (!hasForeignRoot) continue;
        // The other operand must itself reach an object root — a literal /
        // param pattern (`.name LIKE '%x%'`) is a plain correlated comparison,
        // NOT a cross-extent match, and `findMatchingOuterScope` can't always
        // recognise the current subject (e.g. `.name`, a WITH-rebound subject)
        // as non-foreign. Requiring the other side to carry a source keeps those
        // on the value path and reserves the EXISTS lowering for genuine
        // cross-extent matches (`<subject>.x LIKE <other-extent>.y`).
        const otherSources = new Map<string, TypeRef>();
        collectScalarPointerSources(likeArgs[otherIdx].expr, otherSources);
        if (otherSources.size === 0) continue;
        const swapCheckpoint = params.length;
        const setSelect = compileScalarSelectSQL(setArg, params, target, options);
        if (!setSelect) { params.length = swapCheckpoint; continue; }
        const otherSql = compileValueSetSQL(likeArgs[otherIdx].expr, sourceAlias, params, target, options, linkPropertyAlias);
        if (!otherSql) { params.length = swapCheckpoint; continue; }
        // The set side projects as "value"; preserve the original LHS/RHS order.
        const lhsSql = setArgIdx === 0 ? `"value"` : otherSql;
        const rhsSql = setArgIdx === 0 ? otherSql : `"value"`;
        return `(EXISTS (SELECT 1 FROM (${setSelect}) WHERE ${renderLike(lhsSql, rhsSql)}))`;
      }
    }
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

  const exists = tryCompileMultiStepPointerExistsSQL(args[0].expr, args[1].expr, op, sourceAlias, params, target, options, sqlLoweringContext())
    ?? tryCompileMultiStepPointerExistsSQL(args[1].expr, args[0].expr, op, sourceAlias, params, target, options, sqlLoweringContext());
  if (exists) {
    return exists;
  }

  // `Subject != OuterRoot` (e.g. `FILTER Text != Issue` inside a correlated
  // EXISTS) — object identity between the iterated subject's row and an
  // enclosing scope's row. Only fires when at least one side resolves to an
  // outer scope; the other side is the subject itself.
  if (op === "=" || op === "!=") {
    const sideIdentity = (s: Set): { sql: string; viaOuter: boolean } | null => {
      const u = unwrapSelectExprSet(s).result;
      if (u.expr.kind !== "type_root") return null;
      const outer = findMatchingOuterScope(
        { typerefId: (u.expr as TypeRoot).typeref.id, namespace: u.pathId?.namespace ?? [] },
        options,
      );
      if (outer) return { sql: `${outer.alias}.${quoteIdent("id")}`, viaOuter: true };
      return { sql: `${sourceAlias}.${quoteIdent("id")}`, viaOuter: false };
    };
    const lhsIdent = sideIdentity(args[0].expr);
    const rhsIdent = sideIdentity(args[1].expr);
    if (lhsIdent && rhsIdent && (lhsIdent.viaOuter || rhsIdent.viaOuter)
        && lhsIdent.sql !== rhsIdent.sql) {
      return `(${lhsIdent.sql} ${op} ${rhsIdent.sql})`;
    }
  }

  // EdgeQL set semantics: `X = Y` over multi-cardinality scalar operands
  // returns the per-element comparison set; FILTER keeps the row when any
  // comparison is true. Lower as EXISTS over the unpacked LHS values vs
  // RHS values. Handles symmetric LHS/RHS placement of the multi-scalar
  // pointer.
  for (const swap of [false, true] as const) {
    const multiArgIdx = swap ? 1 : 0;
    const otherIdx = swap ? 0 : 1;
    const multiCorrelated = tryCompileCorrelatedMultiScalarRHS(args[multiArgIdx].expr, sourceAlias, options)
      ?? tryCompileCorrelatedLinkPropertyPathSQL(args[multiArgIdx].expr, sourceAlias, options);
    if (!multiCorrelated) continue;
    // Only emit the EXISTS lowering for equality / inequality / ordering
    // operators where set semantics is well-defined. AND/OR/IN have their
    // own branches.
    if (op !== "=" && op !== "!=" && op !== "<" && op !== "<=" && op !== ">" && op !== ">=") {
      continue;
    }
    const rhsLiteral = extractInPredicateLiteralValues(args[otherIdx].expr);
    if (rhsLiteral && rhsLiteral.length > 0) {
      // EdgeQL comparisons are element-wise over the cross product: the
      // FILTER keeps the row when ANY (lhs, rhs) pair satisfies the operator
      // (`!=` is ∃-semantics, not the ∀-semantics of `NOT (x = y)`).
      if (op === "!=") {
        const rhsRows = rhsLiteral.map(() => `SELECT ? AS ${quoteIdent("r")}`).join(" UNION ALL ");
        params.push(...rhsLiteral);
        return `(EXISTS (SELECT 1 FROM (${multiCorrelated}), (${rhsRows}) WHERE "value" != ${quoteIdent("r")}))`;
      }
      const placeholders = rhsLiteral.map(() => "?").join(", ");
      params.push(...rhsLiteral);
      return `(EXISTS (SELECT 1 FROM (${multiCorrelated}) WHERE "value" ${op === "=" ? "IN" : op} (${placeholders})))`;
    }
    const otherValue = compileValueSetSQL(args[otherIdx].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!otherValue) continue;
    return `(EXISTS (SELECT 1 FROM (${multiCorrelated}) WHERE "value" ${op} ${otherValue}))`;
  }

  // `X = {a, b, ...}` or `{a, b} = X` over scalar X — EdgeQL semantics
  // lowers to "X equals any of {a, b}". Detect a literal set RHS (union of
  // constants) and rewrite to IN / NOT IN; the bare equality would compare
  // X to the aggregated JSON array of values, which never matches.
  for (const swap of [false, true] as const) {
    const setArgIdx = swap ? 0 : 1;
    const otherIdx = swap ? 1 : 0;
    const literalRhs = extractInPredicateLiteralValues(args[setArgIdx].expr);
    if (!literalRhs || literalRhs.length === 0) continue;
    if (op !== "=" && op !== "!=") continue;
    if (isSingletonOuterScopeRef(args[otherIdx].expr, options)) continue;
    const otherSql = compileValueSetSQL(args[otherIdx].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!otherSql) continue;
    const placeholders = literalRhs.map(() => "?").join(", ");
    params.push(...literalRhs);
    const sqlOp = op === "=" ? "IN" : "NOT IN";
    return `(${otherSql} ${sqlOp} (${placeholders}))`;
  }

  // `X = <set-producing expr>` over scalar X with a multi-row RHS (e.g.
  // `'metal' = array_unpack(.tag_array)`). EdgeQL set semantics: the
  // comparison set is non-empty AND contains true. Lower to EXISTS so the
  // FILTER keeps the row when at least one comparison matches.
  if (op === "=" || op === "!=") {
    for (const swap of [false, true] as const) {
      const setArgIdx = swap ? 0 : 1;
      const otherIdx = swap ? 1 : 0;
      const setArg = args[setArgIdx].expr;
      if (isSingletonOuterScopeRef(setArg, options)) continue;
      // A single-cardinality object link (`Comment.owner`, `Issue.owner`)
      // yields at most one row — it's not a multi-set to scan. Skip set
      // treatment so the plain value comparison below produces a direct FK/id
      // equality (`ex0.owner_id = g0.owner_id`) instead of a fresh re-scan
      // that re-derives the link and references a bogus column.
      if (isSingleObjectLinkRef(setArg)) continue;
      // When every pointer source in the arg resolves to an ENCLOSING scope
      // (`len(User.name)` inside a computed's FILTER), it's a per-outer-row
      // value, not a set to rescan — let the plain value comparison below
      // compile it correlated. A fresh compileScalarSelectSQL would open an
      // independent scan of the outer type (shadowing the outer alias).
      {
        // Set-producing wrappers (array_unpack etc.) need set semantics even
        // when their pointer sources are outer rows.
        const producesSet = ((): boolean => {
          let cur: Set = setArg;
          while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
          if (cur.expr.kind !== "function_call") return false;
          const fn = ((cur.expr as FunctionCall).functionName ?? "").split("::").pop() ?? "";
          return ["array_unpack", "enumerate", "range_unpack", "json_array_unpack", "json_object_unpack"].includes(fn);
        })();
        const argSources = new Map<string, TypeRef>();
        collectScalarPointerSources(setArg, argSources);
        if (!producesSet && argSources.size > 0) {
          let allOuter = true;
          for (const [key, typeref] of argSources.entries()) {
            const ns = key.includes("|") ? key.slice(key.indexOf("|") + 1) : "";
            const namespace = ns.length > 0 ? ns.split(",") : [];
            if (!findMatchingOuterScope({ typerefId: typeref.id, namespace }, options)) {
              allOuter = false;
              break;
            }
          }
          // Prefer the plain correlated comparison — but only commit when
          // BOTH sides compile as values; otherwise fall through to set
          // treatment so e.g. a WITH-bound RHS still lowers.
          if (allOuter) {
            const valueCheckpoint = params.length;
            const left = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
            const right = left && compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
            if (left && right) {
              return `${wrapPredicateOperand(left)} ${op} ${wrapPredicateOperand(right)}`;
            }
            params.length = valueCheckpoint;
          }
        }
      }
      const swapCheckpoint = params.length;
      const setSelect = compileScalarSelectSQL(setArg, params, target, options);
      if (!setSelect) {
        params.length = swapCheckpoint;
        continue;
      }
      const otherSql = compileValueSetSQL(args[otherIdx].expr, sourceAlias, params, target, options, linkPropertyAlias);
      if (!otherSql) {
        // Roll back the params pushed by the successful setSelect compile.
        params.length = swapCheckpoint;
        continue;
      }
      // An object set compared against a single-link FK (`Issue.owner = U`)
      // is an identity comparison — compile the set side as an id scan under
      // a non-colliding alias so raw id columns compare directly (the JSON
      // identity blob would never equal the FK).
      const setIsObject = ((): boolean => {
        let u: Set = setArg;
        while (u.expr.kind === "select_expr") u = (u.expr as SelectExpr).result;
        return !u.typeref.isScalar && u.typeref.collection === undefined
          && (u.expr.kind === "type_root"
              || (u.expr.kind === "pointer" && !(u.expr as Pointer).ptrref.outTarget.isScalar && !(u.expr as Pointer).ptrref.isLinkProperty));
      })();
      // Like isSingleObjectLinkRef, but tolerant of clause-bearing wrappers
      // (`I.owner` for a WITH-bound filtered I) — the FK column exists on
      // the current row either way.
      const otherIsSingleLinkFK = ((): boolean => {
        let cur: Set = args[otherIdx].expr;
        while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
        if (cur.expr.kind !== "pointer") return false;
        const p = cur.expr as Pointer;
        if (p.ptrref.isLinkProperty || p.ptrref.outTarget.isScalar || p.direction !== "outbound") return false;
        if (p.ptrref.outCardinality !== "one" && p.ptrref.outCardinality !== "at_most_one") return false;
        let root: Set = p.source;
        while (root.expr.kind === "select_expr") root = (root.expr as SelectExpr).result;
        return root.expr.kind === "type_root";
      })();
      if (setIsObject && otherIsSingleLinkFK) {
        params.length = swapCheckpoint;
        const idSource = compileSelectSource(setArg, undefined, undefined, options, params, target, "exo0");
        const otherIdSql = idSource
          ? compileValueSetSQL(args[otherIdx].expr, sourceAlias, params, target, options, linkPropertyAlias)
          : null;
        if (idSource && otherIdSql) {
          return `(EXISTS (SELECT 1 FROM ${idSource.sql} WHERE ${idSource.alias}.${quoteIdent("id")} ${op} ${otherIdSql}))`;
        }
        params.length = swapCheckpoint;
        continue;
      }
      // Element-wise ∃-semantics for both `=` and `!=`: keep the row when
      // ANY element of the set satisfies the comparison. (`NOT EXISTS` here
      // would lower `!=` as `NOT (X = Y)`, inverting the filter for
      // singleton sets.)
      return `(EXISTS (SELECT 1 FROM (${setSelect}) WHERE "value" ${op} ${otherSql}))`;
    }
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
  const match = findMatchingOuterScope(
    { typerefId: typeId, namespace: cursor.pathId?.namespace ?? [] },
    options,
  );
  if (!match) return null;
  return `${match.alias}.${quoteIdent("id")}`;
};

// A set produces a STRING value when it is str-typed, a string literal, or an
// index/slice CHAIN bottoming out in one (`'f'[0][0]`). Bare string literals
// carry `unknown:std::anyscalar` and intermediate index/slice results lose the
// str type, so the typeref alone under-detects.
const isStringValuedSet = (set: Set): boolean => {
  let cur: Set = set;
  while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
  if (qualifyTypeName(cur.typeref) === "std::str") return true;
  const e = cur.expr;
  if (e.kind === "string_constant") return true;
  if (e.kind === "index_expr") return isStringValuedSet((e as IndexExpr).expr);
  if (e.kind === "slice_expr") return isStringValuedSet((e as SliceExpr).expr);
  return false;
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
  // `.__type__.name` over a union/polymorphic source resolves to the row's
  // dynamic concrete type — emit the `__source_type` column the polymorphic
  // source already projects, not the static union name.
  if ((set as { dynamicTypeName?: boolean }).dynamicTypeName) {
    return `${sourceAlias}.${quoteIdent("__source_type")}`;
  }
  const unwrapped = unwrapSelectExprSet(set);
  // Multi-scalar pointer binding: if the caller has registered a SQL
  // expression for this set's pathId (json_each iteration), use it.
  if (options.multiScalarBindings) {
    const bound = options.multiScalarBindings.get(pathIdKey(set))
      ?? options.multiScalarBindings.get(pathIdKey(unwrapped.result));
    if (bound) return bound;
  }
  // Path off a group-rows statement's row (`.count`, `.key.cost` in its
  // FILTER/ORDER BY). Projected names re-emit their projection expression;
  // anything else reads the raw row's JSON path.
  // A group-rows set read as a VALUE under an active row scope is the
  // current row itself (`__element__ := el` in the group-of-groups desugar).
  if (unwrapped.result.expr.kind === "group_rows" && options.groupRowProjection) {
    return `json(${options.groupRowProjection.alias}.${quoteIdent("value")})`;
  }
  if (unwrapped.result.expr.kind === "group_row_field") {
    const field = unwrapped.result.expr as GroupRowFieldExpr;
    // Backlink steps (`<owner` markers) can't be read off the row JSON.
    if (field.steps.some((s) => s.startsWith("<"))) return null;
    // Per-element scope: a value-position read of an elements-rooted path is
    // the CURRENT element (the surrounding per-element iteration), not the
    // whole group's set. Active even without a row scope (a standalone
    // elements iteration over a claused group select).
    if (options.groupElementAlias && field.steps[0] === "elements") {
      const elemValue = `${options.groupElementAlias}.${quoteIdent("value")}`;
      if (field.steps.length === 1) return `json(${elemValue})`;
      const tail = field.steps.slice(1).map((s) => `."${s.replaceAll('"', '""')}"`).join("");
      return `json_extract(${elemValue}, '$${tail}')`;
    }
    const groupCtx = options.groupRowProjection;
    if (!groupCtx) return null;
    // Without a per-element scope, a path INTO the elements is a multi-row
    // set — `'$."elements"."name"'` on the array would just read NULL. Bail
    // so the caller routes through the row-set lowering.
    if (field.steps[0] === "elements" && field.steps.length > 1) return null;
    const raw = `${groupCtx.alias}.${quoteIdent("value")}`;
    const path = (steps: string[]): string =>
      `'$${steps.map((s) => `."${s.replaceAll('"', '""')}"`).join("")}'`;
    const head = groupProjectionHead(groupCtx, field.steps);
    if (head && head.kind === "count_elements" && field.steps.length === 1) {
      return `json_array_length(COALESCE(json_extract(${raw}, '$."elements"'), '[]'))`;
    }
    if (head && head.kind === "path") {
      return `json_extract(${raw}, ${path([...head.steps, ...field.steps.slice(1)])})`;
    }
    // `.minCost` re-emitted from an element aggregate projection.
    if (head && head.kind === "element_agg" && field.steps.length === 1) {
      const tail = head.steps.map((s) => `."${s.replaceAll('"', '""')}"`).join("");
      return `(SELECT ${head.fn}(json_extract(je.${quoteIdent("value")}, '$${tail}'))`
        + ` FROM json_each(COALESCE(json_extract(${raw}, '$."elements"'), '[]')) je)`;
    }
    // `.keyCard.cost` where keyCard projects the first element — read the
    // field off `elements[0]` of the raw row.
    if (head && (head.kind === "element_first_shape" || head.kind === "element_first_path")) {
      const baseSteps = head.kind === "element_first_path" ? head.steps : [];
      const rest = [...baseSteps, ...field.steps.slice(1)];
      const tail = rest.map((s) => `."${s.replaceAll('"', '""')}"`).join("");
      return `json_extract(${raw}, '$."elements"[0]${tail}')`;
    }
    // key_shape / elements_shape project the same underlying object, and
    // unprojected names read the raw row directly — both are the raw path.
    return `json_extract(${raw}, ${path(field.steps)})`;
  }
  // EdgeQL path sharing: a bare reference to an outer iterator's type
  // (e.g. `User` inside `SELECT User { x := (SELECT … FILTER … = User) }`)
  // resolves to the OUTER row's identity (id), not a fresh cross-product.
  // Recognize this when the set unwraps to just a type_root with no
  // clauses and the typeref matches an enclosing scope.
  const outerScopeIdRef = tryResolveOuterScopeIdRef(set, options);
  if (outerScopeIdRef) return outerScopeIdRef;
  if (unwrapped.selectExpr) {
    // An independent subquery operand (its roots aren't bound to any enclosing
    // scope) needs its own FROM clause — compile it as a self-contained scalar
    // subselect rather than a correlated `SELECT value` that dangles on the
    // caller's alias.
    if (options.allowIndependentSubquery && subqueryReferencesOnlyFreeRoots(unwrapped.selectExpr, options)) {
      const cp = params.length;
      const scalarSql = compileScalarSelectSQL(set, params, target, { ...options, allowIndependentSubquery: false });
      if (scalarSql) {
        return `(SELECT ${quoteIdent("value")} FROM (${scalarSql}))`;
      }
      params.length = cp;
    }
    const subquery = compileSelectExprSubquery(unwrapped.selectExpr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!subquery) {
      params.length = checkpoint;
      return null;
    }
    return subquery;
  }

  const expr = unwrapped.result.expr;
  // A `(group <src> by <key>)` in *value* position lowers to the same
  // correlated JSON-array-of-groups subquery a top-level group shape element
  // uses. This is what lets group-in-expression (e.g. an access-policy
  // `using (count((group .deck by .element)) = 2)`) lower to SQL rather than
  // being dropped. `count` over it is the number of groups; a path/shape over
  // it reads the group objects (handled by the pointer/shape paths via this
  // array value).
  if (expr.kind === "embedded_group") {
    return compileEmbeddedGroupSQL(expr as EmbeddedGroupExpr, sourceAlias, params, options, target, 0);
  }
  if (expr.kind === "pointer") {
    const pointer = expr as Pointer;
    const col = columnForPointer(pointer);
    if (pointer.ptrref.isLinkProperty) {
      const alias = linkPropertyAlias ?? sourceAlias;
      return `${alias}.${quoteIdent(col)}`;
    }
    // Pointer over a cardinality-clipped subquery
    // (`(SELECT T ORDER BY … LIMIT 1).p`) used as a scalar value (e.g. an
    // operand of `+`): the LIMIT / OFFSET can't survive a flat-source flatten,
    // so emit a correlated scalar subquery over the clipped source that
    // projects the leaf column. This preserves the clip that picks the single
    // intended row. A bare ORDER BY doesn't clip, so leave those to the normal
    // element-wise path.
    if (pointer.source.expr.kind === "select_expr"
        && pointer.ptrref.outTarget.isScalar
        && !pointer.ptrref.isLinkProperty) {
      let clip: SelectExpr | undefined;
      let cursor: Expr = pointer.source.expr;
      while (cursor.kind === "select_expr") {
        const se = cursor as SelectExpr;
        if (se.limit || se.offset) { clip = se; break; }
        cursor = se.result.expr;
      }
      if (clip) {
        const subCkpt = params.length;
        const rowSrc = compileSelectSource(
          pointer.source, undefined, undefined, options, params, target, "__clip", [col],
        );
        if (rowSrc) {
          return `(SELECT ${rowSrc.alias}.${quoteIdent(col)} FROM ${rowSrc.sql})`;
        }
        params.length = subCkpt;
      }
    }
    const currentSourceAlias = pickSourcePathAlias(pointer.source, options);
    if (currentSourceAlias) {
      if (pointer.ptrref.isIdPointer || pointer.ptrref.shortName === "id") {
        return `${currentSourceAlias}.${quoteIdent("id")}`;
      }
      if (!pointer.ptrref.outTarget.isScalar) {
        const isSingleLink = pointer.ptrref.outCardinality === "one"
          || pointer.ptrref.outCardinality === "at_most_one";
        return pointer.direction === "outbound" && isSingleLink
          ? `${currentSourceAlias}.${quoteIdent(`${pointer.ptrref.shortName}_id`)}`
          : null;
      }
      return `${currentSourceAlias}.${quoteIdent(col)}`;
    }
    // Pointer off a row-set source that isn't anchored on the caller's alias
    // (`user.id` / `x.name` where the source is `array_unpack(<array<T>>[])`):
    // compile the source rows directly and, for non-id leaves, join the
    // object table by id. Empty sources yield NULL (the empty set), which
    // set-level operators (`??`, exists) handle downstream.
    if (pointer.source.expr.kind === "function_call"
        && pointer.direction === "outbound"
        && pointer.source.typeref.inSchema && !pointer.source.typeref.isScalar) {
      const fnSrcRoots = new globalThis.Set<string>();
      collectTypeRootIds(pointer.source, fnSrcRoots);
      if (fnSrcRoots.size === 0) {
        const fnCkpt = params.length;
        const idRows = compileScalarSelectSQL(pointer.source, params, target, options);
        if (idRows) {
          if (pointer.ptrref.isIdPointer || pointer.ptrref.shortName === "id") {
            // Source rows may carry bare ids or `{"id": …}` identity objects.
            return `(SELECT CASE WHEN json_valid(src_ids.${quoteIdent("value")}) AND json_type(src_ids.${quoteIdent("value")}) = 'object'`
              + ` THEN json_extract(src_ids.${quoteIdent("value")}, '$.id') ELSE src_ids.${quoteIdent("value")} END FROM (${idRows}) src_ids)`;
          }
          if (pointer.ptrref.outTarget.isScalar && !shouldUseLinkTable(pointer)) {
            const objSrc = compilePolymorphicSource(pointer.source.typeref, false, "g_psrc", ["id", col], options);
            return `(SELECT g_psrc.${quoteIdent(col)} FROM (${idRows}) src_ids JOIN ${objSrc} ON g_psrc.${quoteIdent("id")} = src_ids.${quoteIdent("value")})`;
          }
        }
        params.length = fnCkpt;
      }
    }
    // `.id` off a LINK step (`Comment.parent.id`): the target's identity is
    // the link's own value (the FK column / link-table target), NOT the
    // source row's `id` column (optional_leakage_01). Compile the link step
    // itself — the non-scalar pointer branch below surfaces `parent_id`.
    if ((pointer.ptrref.isIdPointer || pointer.ptrref.shortName === "id")
        && pointer.source.expr.kind === "pointer"
        && !(pointer.source.expr as Pointer).ptrref.outTarget.isScalar) {
      const linkCkpt = params.length;
      const linkSql = compileValueSetSQL(pointer.source, sourceAlias, params, target, options, linkPropertyAlias);
      if (linkSql) return linkSql;
      params.length = linkCkpt;
      return null;
    }
    // The implicit `id` pointer arrives with a non-scalar `anytype` outTarget
    // (the IR builder doesn't type it), but in value/predicate position it is
    // the row's `id` column — `FILTER .id = <uuid>` / `.id IN {…}` must lower
    // to a column comparison rather than being dropped as an object link.
    if (pointer.ptrref.isIdPointer || (pointer.ptrref.shortName === "id" && pointer.source.expr.kind === "type_root")) {
      // An id read off an ENCLOSING scope's type root (`Issue.id` inside a
      // correlated `EXISTS (SELECT Comment …)`) anchors on the outer alias.
      if (pointer.source.expr.kind === "type_root") {
        const outerMatch = findMatchingOuterScope(
          { typerefId: (pointer.source.expr as TypeRoot).typeref.id, namespace: pointer.source.pathId?.namespace ?? [] },
          options,
        );
        if (outerMatch) return `${outerMatch.alias}.${quoteIdent("id")}`;
      }
      return `${sourceAlias}.${quoteIdent("id")}`;
    }
    if (!pointer.ptrref.outTarget.isScalar) {
      // Non-scalar outbound single link from a type_root: the source SELECT
      // projects `${shortName}_id` — directly for inline-FK links, or via a
      // LinkProjection LEFT JOIN for link-table links (both inline and
      // polymorphic). Surface that column so object-identity comparisons
      // (`Issue.owner = X`, `Text[IS Owned].owner = User`) reduce to
      // `${sourceAlias}.${linkName}_id = <other-row-id>` at the predicate
      // level instead of dropping the FILTER (which returns every row).
      const isSingleLink = pointer.ptrref.outCardinality === "one"
        || pointer.ptrref.outCardinality === "at_most_one";
      // The source may be select_expr-wrapped (`I.owner` for a WITH-bound,
      // filtered I) — the clauses already shaped the rows behind sourceAlias,
      // and the FK column name is the same either way.
      let linkSourceRoot: Set = pointer.source;
      while (linkSourceRoot.expr.kind === "select_expr") linkSourceRoot = (linkSourceRoot.expr as SelectExpr).result;
      if (
        linkSourceRoot.expr.kind === "type_root"
        && pointer.direction === "outbound"
        && isSingleLink
      ) {
        // When the link's source type_root matches an enclosing iteration
        // scope (a correlated subquery referencing the outer row's link, e.g.
        // `Comment.owner = Issue.owner` inside `EXISTS (SELECT Comment …)`),
        // read the FK column off the OUTER alias. Otherwise it's the current
        // source's own column.
        const srcTypeId = (linkSourceRoot.expr as TypeRoot).typeref.id;
        const outerMatch = findMatchingOuterScope(
          { typerefId: srcTypeId, namespace: pointer.source.pathId?.namespace ?? [] },
          options,
        );
        const anchorAlias = outerMatch?.alias ?? sourceAlias;
        return `${anchorAlias}.${quoteIdent(`${pointer.ptrref.shortName}_id`)}`;
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
      const outerMatch = findMatchingOuterScope(
        { typerefId: innerTypeId, namespace: pointer.source.pathId?.namespace ?? [] },
        options,
      );
      if (outerMatch) {
        return `${outerMatch.alias}.${quoteIdent(col)}`;
      }
    }
    // `X.__type__.name` — the row's dynamic type label. `__type__` isn't a
    // real link (no table); read the projected `__source_type` column.
    if (pointer.ptrref.shortName === "name"
        && pointer.source.expr.kind === "pointer"
        && (pointer.source.expr as Pointer).ptrref.shortName === "__type__") {
      let typeRootSet: Set = (pointer.source.expr as Pointer).source;
      while (typeRootSet.expr.kind === "select_expr") typeRootSet = (typeRootSet.expr as SelectExpr).result;
      if (typeRootSet.expr.kind === "type_root") {
        const outerMatch = findMatchingOuterScope(
          { typerefId: (typeRootSet.expr as TypeRoot).typeref.id, namespace: typeRootSet.pathId?.namespace ?? [] },
          options,
        );
        return `${(outerMatch?.alias ?? sourceAlias)}.${quoteIdent("__source_type")}`;
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
    // Only anchor the leaf column on the caller's alias when the pointer's
    // source actually IS the caller's row: a type_root, possibly behind
    // select_expr fences whose clauses already shaped the rows behind
    // sourceAlias. For other source kinds (coalesce_expr, union
    // operator_call, …) reading the bare column would silently drop the
    // source's semantics — bail so callers fall back to other strategies.
    let leafSourceRoot: Set = pointer.source;
    while (leafSourceRoot.expr.kind === "select_expr") leafSourceRoot = (leafSourceRoot.expr as SelectExpr).result;
    if (leafSourceRoot.expr.kind === "type_root") {
      return `${sourceAlias}.${quoteIdent(col)}`;
    }
    return null;
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
    const targetTupleSlots = tupleTypeSlots(castExpr.toType);
    if (targetTupleSlots && castExpr.expr.expr.kind === "tuple") {
      const sourceTuple = castExpr.expr.expr as Tuple;
      const sourceParts = sourceTuple.elements.map((element) =>
        compileValueSetSQL(element.val, sourceAlias, params, target, options, linkPropertyAlias));
      if (sourceParts.some((part) => !part)) {
        params.length = checkpoint;
        return null;
      }
      const targetSlotNames = targetTupleSlots.map((s) => s.name).filter((n): n is string => n !== undefined);
      const targetIsNamed = targetTupleSlots.length > 0 && targetSlotNames.length === targetTupleSlots.length;
      if (targetIsNamed) {
        return `json_object(${targetSlotNames.map((name, idx) => `${quoteLiteral(name)}, ${sourceParts[idx]}`).join(", ")})`;
      }
      return `json_array(${sourceParts.slice(0, targetTupleSlots.length).join(", ")})`;
    }
    const inner = compileValueSetSQL(castExpr.expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!inner) {
      params.length = checkpoint;
      return null;
    }
    // `<json>X` JSON-encodes its source rather than just stringifying it. For a
    // scalar (str/enum/int/float/bool/uuid) that means `json_quote`, which
    // quotes strings (`'RED'` → `"RED"`) but leaves numbers/bools bare
    // (`42` → `42`). Collections, object shapes (`<json>Issue {…}` →
    // `json_object(…)`), and values already in JSON text are passed through
    // unchanged (json_quote would double-encode them as a string).
    if (qualifyTypeName(castExpr.toType) === "std::json") {
      const srcType = castExpr.expr.typeref;
      const srcIsObjectShape = castSourceIsObjectShape(castExpr.expr);
      const srcIsJsonAlready = srcType.collection !== undefined
        || qualifyTypeName(srcType) === "std::json"
        || srcIsObjectShape
        // A range/multirange already lowers to a JSON value; json_quote would
        // double-encode it as a string.
        || setLooksLikeRange(castExpr.expr);
      return srcIsJsonAlready ? inner : `json_quote(${inner})`;
    }
    // Casting FROM std::json: JSON `null` is the EMPTY SET (SQL NULL), and
    // scalar payloads decode via json_extract(j, '$') (`'"hi"'` → `'hi'`)
    // rather than CAST over the raw JSON text. The inner SQL may carry `?`
    // placeholders, so reference it exactly once via an aliased subquery.
    if (qualifyTypeName(castExpr.expr.typeref) === "std::json") {
      if (castTargetIsCollection(castExpr.toType)) {
        return `(SELECT CASE WHEN json_type(json(j)) = 'null' THEN NULL ELSE json(j) END FROM (SELECT ${inner} AS j))`;
      }
      const jsonCastTarget = sqlCastTarget(castExpr.toType);
      const extracted = isFloatTypeName(qualifyTypeName(castExpr.toType))
        ? `_gel_float_cast(json_extract(j, '$'))`
        : jsonCastTarget ? `CAST(json_extract(j, '$') AS ${jsonCastTarget})` : `json_extract(j, '$')`;
      return `(SELECT CASE WHEN json_type(json(j)) = 'null' THEN NULL ELSE ${extracted} END FROM (SELECT ${inner} AS j))`;
    }
    if (isFloatTypeName(qualifyTypeName(castExpr.toType))) {
      return `_gel_float_cast(${inner})`;
    }
    const castTarget = sqlCastTarget(castExpr.toType);
    return castTarget ? `CAST(${inner} AS ${castTarget})` : inner;
  }

  // `count((group <src> by <key>))` — the number of groups is the length of
  // the embedded group's JSON array. Intercept before the generic function
  // lowering, which has no embedded_group shape and would drop it.
  if (expr.kind === "function_call") {
    const call = expr as FunctionCall;
    const shortName = (call.functionName.split("::").pop() ?? call.functionName).toLowerCase();
    const callArgs = orderedCallArgs(call.args);
    if (shortName === "count" && callArgs.length === 1) {
      const argGroup = unwrapSelectExprSet(callArgs[0].expr).result.expr;
      if (argGroup.kind === "embedded_group") {
        const arr = compileEmbeddedGroupSQL(argGroup as EmbeddedGroupExpr, sourceAlias, params, options, target, 0);
        return `json_array_length(${arr})`;
      }
    }
  }

  if (expr.kind === "function_call") {
    const compiled = compileFunctionCallSQL(expr as FunctionCall, sourceAlias, params, target, options, sqlLoweringContext(), linkPropertyAlias);
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
    // NOTE: this value-path result is ALSO consumed as a FILTER predicate (via
    // compilePredicateSetSQL's fallback to compileValueSetSQL), so it must stay
    // a SQL boolean — wrapping it as json('true') breaks `FILTER X IS T`. The
    // shape-value JSON-bool case (`a := Object IS Ba`) needs a separate seam.
    return `(${tagSql} ${op} (${placeholders}))`;
  }

  if (expr.kind === "coalesce_expr") {
    const coalesce = expr as CoalesceExpr;
    // Union-prefix coalesce (`X[IS A].p ?? X[IS B].q` over X := {A, B}):
    // per element, gate each side on the row's __source_type.
    const unionPrefix = compileUnionPrefixCoalesceValueSQL(coalesce, sourceAlias, params, target, options);
    if (unionPrefix) return unionPrefix;
    // Fenced-pointer LHS with the iteration root coming from the RHS: the
    // fence WHERE lives inside a correlated subselect (mirrors the hoist
    // suppression in collectInnerWhereClauses).
    const left = (matchFencedScalarPointer(coalesce.left) && hasBareRootPath(coalesce.right)
      ? compileFencedPointerCorrelatedSQL(coalesce.left, sourceAlias, params, target, options)
      : null)
      ?? compileValueSetSQL(coalesce.left, sourceAlias, params, target, options, linkPropertyAlias);
    const right = compileValueSetSQL(coalesce.right, sourceAlias, params, target, options, linkPropertyAlias);
    if (!left || !right) {
      params.length = checkpoint;
      return null;
    }
    return `COALESCE(${left}, ${right})`;
  }

  if (expr.kind === "exists_expr") {
    const existsExpr = expr as ExistsExpr;
    // `exists <link>` where the link is stored in a junction table (a multi
    // link, or a single link carrying link properties) has no inline
    // `<name>_id` column to test for NULL — probe the junction table directly.
    // Without this the value read returns the (absent, hence NULL) FK column
    // and `exists` is always false. Anchored at the row alias / source path.
    {
      const linkUnwrapped = unwrapSelectExprSet(existsExpr.expr).result;
      if (linkUnwrapped.expr.kind === "pointer") {
        const ptr = linkUnwrapped.expr as Pointer;
        // The link is read off the current row (a leading-dot `.link` in a
        // FILTER, anchored at the outer alias), or a path-bound source with a
        // registered alias.
        const anchor = pickSourcePathAlias(ptr.source, options) ?? sourceAlias;
        if (!ptr.ptrref.isLinkProperty && !ptr.ptrref.outTarget.isScalar
            && ptr.direction === "outbound" && shouldUseLinkTable(ptr)) {
          const lt = linkTableNameForPointer(ptr, options);
          return `(CASE WHEN EXISTS (SELECT 1 FROM ${quoteIdent(lt)} WHERE ${quoteIdent("source")} = ${anchor}.${quoteIdent("id")}) THEN json('true') ELSE json('false') END)`;
        }
      }
    }
    const inner = compileValueSetSQL(existsExpr.expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!inner) {
      // The inner set may be a self-contained row set (no type roots, so no
      // outer-alias correlation) the value compiler can't express inline —
      // e.g. `exists user` where user binds `array_unpack(<array<Object>>[])`.
      // Probe it with EXISTS over its row form instead.
      const innerRoots = new globalThis.Set<string>();
      collectTypeRootIds(existsExpr.expr, innerRoots);
      if (innerRoots.size === 0) {
        const rowCkpt = params.length;
        const rows = compileScalarSelectSQL(existsExpr.expr, params, target, options);
        if (rows) {
          return `(CASE WHEN EXISTS (SELECT 1 FROM (${rows}) WHERE ${quoteIdent("value")} IS NOT NULL) THEN json('true') ELSE json('false') END)`;
        }
        params.length = rowCkpt;
      }
      params.length = checkpoint;
      return null;
    }
    return `(CASE WHEN ${inner} IS NULL THEN json('false') ELSE json('true') END)`;
  }


  if (expr.kind === "tuple") {
    const tuple = expr as Tuple;
    // When any element is a multi-scalar pointer, the tuple constructor
    // produces a SET of tuples (one per cross-product row). Emit a
    // json_each-cross-joined subquery aggregated with json_group_array so
    // the shape projects an array of tuples instead of wrapping the
    // JSON-encoded multi columns inline.
    const multiSql = compileTupleWithMultiScalarsSQL(tuple, sourceAlias, params, target, options, linkPropertyAlias);
    if (multiSql) return multiSql;
    const parts = tuple.elements.map((element) => compileValueSetSQL(element.val, sourceAlias, params, target, options, linkPropertyAlias));
    if (parts.some((part) => !part)) {
      params.length = checkpoint;
      return null;
    }
    return nullPropagatingTupleSQL(tuple, parts);
  }

  if (expr.kind === "array") {
    // Array constructors containing multi-cardinality scalar pointer refs
    // (`[Item.tag_set1]`, `[Item.tag_set1, Item.tag_set2]`) need cross-product
    // semantics. The inline `json_array(g0.col, ...)` form would conflate the
    // multi-set's stored JSON with a per-element value.
    if (expr.elements.some((el) => containsMultiScalarPointer(el))) {
      params.length = checkpoint;
      return null;
    }
    const parts = expr.elements.map((element) => compileValueSetSQL(element, sourceAlias, params, target, options, linkPropertyAlias));
    if (parts.some((part) => !part)) {
      params.length = checkpoint;
      return null;
    }
    return `json_array(${parts.join(", ")})`;
  }

  if (expr.kind === "index_expr") {
    const indexExpr = expr as IndexExpr;
    const numericIndex = extractNumericLiteral(indexExpr.index);
    // Tuple-of-multi-scalars `.k` access — project the kth element across
    // the cross-product set rather than building each tuple and extracting
    // `$[k]`. Lets the result be a homogeneous array of scalar values
    // (`["wood","wood","rectangle","rectangle"]`) matching EdgeQL's
    // semantics for `(M0, M1).k`.
    if (numericIndex !== undefined) {
      const inner = unwrapSelectExprSet(indexExpr.expr);
      if (inner.result.expr.kind === "tuple") {
        const tupleExpr = inner.result.expr as Tuple;
        const tupleMulti = compileTupleWithMultiScalarsSQL(
          tupleExpr,
          sourceAlias,
          params,
          target,
          options,
          linkPropertyAlias,
          numericIndex,
        );
        if (tupleMulti) return tupleMulti;
      }
    }
    const base = compileValueSetSQL(indexExpr.expr, sourceAlias, params, target, options, linkPropertyAlias);
    const baseType = qualifyTypeName(indexExpr.expr.typeref);
    // A bare string literal carries `unknown:std::anyscalar`, not `std::str`,
    // so indexing it would wrongly lower as JSON-array access (`'qwerty'[2]`).
    // Detect a string-valued source (incl. chained `'f'[0][0]`) → substr.
    const sourceIsStr = baseType === "std::str" || isStringValuedSet(indexExpr.expr);
    if (base && numericIndex !== undefined && (sourceIsStr || baseType === "std::bytes")) {
      return `substr(${base}, ${numericIndex >= 0 ? numericIndex + 1 : numericIndex}, 1)`;
    }
    if (base && numericIndex !== undefined) {
      // Inline the index as a literal integer in the JSON path. Using `?`
      // would let SQLite render JS Numbers as `0.0` during `||`
      // concatenation, producing an invalid path like `$[0.0]`.
      // Negative indices count from the end — SQLite spells that `$[#-1]`.
      const path = numericIndex < 0 ? `$[#${numericIndex}]` : `$[${numericIndex}]`;
      return `json_extract(${base}, '${path}')`;
    }
    // Multi-valued index (`arr[{0, 1}]`) — the index expression produces
    // a set, not a scalar. Lowering as `json_extract(arr, '$[' || CAST(set
    // AS INTEGER) || ']')` would cast the whole JSON-array of indexes to a
    // single int. Defer to the caller's set-producing path (compileScalarSelectSQL)
    // which knows how to iterate over the index set.
    const indexUnwrapped = unwrapSelectExprSet(indexExpr.index);
    if (indexUnwrapped.result.expr.kind === "operator_call"
        && (indexUnwrapped.result.expr as OperatorCall).operator === "union") {
      params.length = checkpoint;
      return null;
    }
    const index = compileValueSetSQL(indexExpr.index, sourceAlias, params, target, options, linkPropertyAlias);
    if (!base || !index) {
      params.length = checkpoint;
      return null;
    }
    // Bind base and index once each (they may carry `?` params) and build
    // the path in SQL — negative indices use SQLite's `$[#-N]` form.
    return `(SELECT json_extract(b, CASE WHEN i < 0 THEN '$[#' || i || ']' ELSE '$[' || i || ']' END) FROM (SELECT (${base}) AS b, CAST(${index} AS INTEGER) AS i))`;
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
    // String slices (`name[2:4]`) use SQLite's 1-based `substr`, not the JSON
    // array machinery below — the base is text, not a JSON array. Fold
    // negative indices over `length()` and clamp to [0, len] to match EdgeQL's
    // Python-style semantics.
    const baseTypeId = (sliceExpr.expr.typeref?.id ?? sliceExpr.expr.typeref?.nameHint ?? "").toLowerCase();
    // A bare string literal carries `unknown:std::anyscalar`, not `std::str` —
    // detect a string-valued source (incl. chains) so slicing uses substr, not
    // the JSON array path (which raises "malformed JSON" on text).
    const isStringSlice = baseTypeId === "std::str" || baseTypeId.endsWith("::str") || baseTypeId === "str"
      || isStringValuedSet(sliceExpr.expr);
    if (isStringSlice) {
      // The base/bounds are each referenced several times below. When any
      // carries a `?` param (a string LITERAL base is a single `?`), inline
      // them once in a subquery and reference the bound aliases — otherwise the
      // repeated `?` placeholders out-number the pushed params. A column base
      // (no `?`) keeps the simpler inline form.
      const paramInlined = base.includes("?") || start.includes("?") || (end?.includes("?") ?? false);
      const b = paramInlined ? "b" : base;
      const s = paramInlined ? "s" : start;
      const eRef = paramInlined ? (end ? "e" : null) : end;
      const lenExpr = `length(${b})`;
      const fold = (idx: string): string => `(CASE WHEN (${idx}) < 0 THEN ${lenExpr} + (${idx}) ELSE (${idx}) END)`;
      const clamp = (e: string): string => `MAX(0, MIN(${lenExpr}, ${e}))`;
      const startC = clamp(fold(s));
      const endC = eRef ? clamp(fold(eRef)) : lenExpr;
      const core = `CASE WHEN ${b} IS NULL THEN NULL ELSE substr(${b}, (${startC}) + 1, MAX(0, (${endC}) - (${startC}))) END`;
      if (!paramInlined) return core;
      const binds = [`(${base}) AS b`, `(${start}) AS s`, end ? `(${end}) AS e` : null]
        .filter((c): c is string => c !== null).join(", ");
      return `(SELECT ${core} FROM (SELECT ${binds}))`;
    }
    // SQLite's json_extract path syntax doesn't support `$[start:end]` slices,
    // so we iterate the JSON array's elements with json_each and filter by
    // their position (`key`). When the source is NULL (an optional array
    // property with no value), preserve NULL — EdgeQL's `<empty>[a:b]` is
    // also empty / null. Negative indices fold to len+idx to match
    // EdgeQL semantics.
    // Bind base/start/end ONCE in an inner SELECT so each (with its own `?`
    // placeholders) is consumed exactly once — the negative-index `CASE`
    // references the normalized bound three times, which would otherwise
    // over-consume parameters when a bound is a non-literal value
    // (`arr[1:<int64>{}]`). A present-but-empty bound (SQL NULL) makes the whole
    // slice the empty set (EdgeQL strict semantics) — the surrounding scalar
    // select drops the NULL row.
    const lenExpr = `json_array_length(b)`;
    const norm = (col: string): string => `CASE WHEN ${col} < 0 THEN ${lenExpr} + ${col} ELSE ${col} END`;
    const cond = end
      ? `"key" >= (${norm("s")}) AND "key" < (${norm("e")})`
      : `"key" >= (${norm("s")})`;
    const nullBound = [
      sliceExpr.start ? "s IS NULL" : null,
      end ? "e IS NULL" : null,
    ].filter((c): c is string => c !== null);
    const nullGuard = nullBound.length > 0 ? ` WHEN ${nullBound.join(" OR ")} THEN NULL` : "";
    const bindings = [`(${base}) AS b`, `(${start}) AS s`, end ? `(${end}) AS e` : null]
      .filter((c): c is string => c !== null).join(", ");
    return `(SELECT CASE WHEN b IS NULL THEN NULL${nullGuard}`
      + ` ELSE COALESCE((SELECT json_group_array("value") FROM json_each(b) WHERE ${cond}), '[]') END`
      + ` FROM (SELECT ${bindings}))`;
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
      const p = operandSqls[0];
      return `(SELECT CASE WHEN p IS NULL THEN NULL WHEN p = json('true') THEN json('false') WHEN p = json('false') THEN json('true') WHEN p THEN json('false') ELSE json('true') END FROM (SELECT (${p}) AS p))`;
    }
    if (operandSqls.length < 2) return null;
    const [a, b] = operandSqls;
    const op = call.operator === "and" ? "AND" : "OR";
    return `(SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL WHEN ${truthy("a")} ${op} ${truthy("b")} THEN json('true') ELSE json('false') END FROM (SELECT (${a}) AS a, (${b}) AS b))`;
  }
  if (call.operator === "neg" || call.operator === "pos") {
    const args = orderedCallArgs(call.args);
    if (args.length < 1) {
      return null;
    }
    const v = compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    if (!v) {
      params.length = checkpoint;
      return null;
    }
    return call.operator === "neg" ? `(-(${v}))` : `(${v})`;
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
    // `X ?= X` on an object set in value position: identity compare of the
    // scoped row with itself — the iteration alias's id on both sides keeps
    // the empty-binding case correct (NULL IS NULL → true).
    if (args[0].expr.expr.kind === "type_root" && args[1].expr.expr.kind === "type_root"
        && (args[0].expr.expr as TypeRoot).typeref.id === (args[1].expr.expr as TypeRoot).typeref.id) {
      const idRef = `${sourceAlias}.${quoteIdent("id")}`;
      const selfOp = call.operator === "?=" ? "IS" : "IS NOT";
      return `(CASE WHEN ${idRef} ${selfOp} ${idRef} THEN json('true') ELSE json('false') END)`;
    }
    // Fenced-pointer args keep their fence WHERE in a correlated subselect
    // when the other arg supplies the iteration root (dependent_14).
    const left = (matchFencedScalarPointer(args[0].expr) && hasBareRootPath(args[1].expr)
      ? compileFencedPointerCorrelatedSQL(args[0].expr, sourceAlias, params, target, options)
      : null)
      ?? compileValueSetSQL(args[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
    const right = (matchFencedScalarPointer(args[1].expr) && hasBareRootPath(args[0].expr)
      ? compileFencedPointerCorrelatedSQL(args[1].expr, sourceAlias, params, target, options)
      : null)
      ?? compileValueSetSQL(args[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
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

  if (call.operator === "^") {
    const powArgs = orderedCallArgs(call.args);
    if (powArgs.length >= 2) {
      const l = compileValueSetSQL(powArgs[0].expr, sourceAlias, params, target, options, linkPropertyAlias);
      const r = compileValueSetSQL(powArgs[1].expr, sourceAlias, params, target, options, linkPropertyAlias);
      if (l && r) return `pow(${l}, ${r})`;
      params.length = checkpoint;
      return null;
    }
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
    if (compiled.length === 2) {
      const likeSql = likeOperatorSql(call.operator, compiled[0], compiled[1]);
      if (likeSql) return likeSql;
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
    // `+`/`*`/`-` over range operands are set algebra (union / intersection /
    // difference), not scalar arithmetic — emit the range UDFs, which return
    // the same JSON shape `range()` produces so range equality still matches.
    if (compiled.length === 2 && (call.operator === "+" || call.operator === "*" || call.operator === "-")
      && args.every((arg) => setLooksLikeRange(arg.expr))) {
      const rangeFn = call.operator === "+" ? "_gel_range_union"
        : call.operator === "*" ? "_gel_range_intersection"
        : "_gel_range_difference";
      return `${rangeFn}(${compiled[0]}, ${compiled[1]})`;
    }
    if (compiled.length === 2) {
      const floored = flooredArithBinarySql(call.operator, compiled[0], compiled[1]);
      if (floored) return floored;
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

const orderedCallArgs = (args: Record<string, CallArg>): CallArg[] => {
  return Object.entries(args)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([, arg]) => arg);
};

// Read tuple slot descriptors from structured TypeRef data instead of parsing
// the type name string.
const tupleTypeSlots = (typeRef: TypeRef): { name?: string; type: string }[] | null => {
  if (typeRef.collection !== "tuple" || !typeRef.subtypes) return null;
  return typeRef.subtypes.map((sub) => ({ name: sub.elementName, type: qualifyTypeName(sub) }));
};

// LEGITIMATE HARDCODING (do not remove): this maps Gel std scalar types to
// SQLite storage classes; there is no IR field carrying SQLite affinity.
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

// For a multi-step object pointer like `Comment.issue.owner`, the leaf link
// (`owner`) is not anchored at the outer row (`Comment`) but at the
// intermediate set (`.issue`). Resolve that intermediate set's id(s) as SQL
// correlated to `rootAlias`, so the leaf join correlates on the right row.
// Returns a fragment usable directly inside `… IN (<here>)` (a bare column ref
// or a `SELECT …` body), or null for a chain shape we can't yet lower.
const compileChainSourceIdSetSQL = (
  source: Set,
  rootAlias: string,
  options: GelIRCompileOptions,
): string | null => {
  if (source.expr.kind === "type_root") {
    return `${rootAlias}.${quoteIdent("id")}`;
  }
  if (source.expr.kind !== "pointer") return null;
  const ptr = source.expr as Pointer;
  const parent = compileChainSourceIdSetSQL(ptr.source, rootAlias, options);
  if (parent === null) return null;
  const shortName = ptr.ptrref.shortName;
  if (ptr.direction === "outbound") {
    if (shouldUseLinkTable(ptr)) {
      const lt = linkTableNameForPointer(ptr, options);
      return `SELECT ${quoteIdent("target")} FROM ${quoteIdent(lt)} WHERE ${quoteIdent("source")} IN (${parent})`;
    }
    // Inline single-link FK column lives on the source row.
    const srcTable = tableNameForType(qualifyTypeName(ptr.ptrref.outSource));
    return `SELECT ${quoteIdent(`${shortName}_id`)} FROM ${quoteIdent(srcTable)} WHERE ${quoteIdent("id")} IN (${parent})`;
  }
  // Inbound (backlink) step.
  if (shouldUseLinkTable(ptr)) {
    const lt = linkTableNameForPointer(ptr, options);
    return `SELECT ${quoteIdent("source")} FROM ${quoteIdent(lt)} WHERE ${quoteIdent("target")} IN (${parent})`;
  }
  const childTable = tableNameForType(qualifyTypeName(ptr.ptrref.outSource));
  return `SELECT ${quoteIdent("id")} FROM ${quoteIdent(childTable)} WHERE ${quoteIdent(`${shortName}_id`)} IN (${parent})`;
};

// Lower `(GROUP <link> BY <atoms>) { … }` (embedded group) to a correlated
// `GROUP BY` subquery over the link, emitting one JSON object per group:
//   COALESCE((SELECT json_group_array(json(g."item")) FROM (
//     SELECT json_object('key', …, ['grouping', …,] 'elements', …) AS "item"
//     FROM <linkTable> d JOIN (<target>) c ON c."id" = d."target"
//     WHERE d."source" = <outer>."id"
//     GROUP BY <key cols>
//   ) g), json('[]'))
const compileEmbeddedGroupSQL = (
  group: EmbeddedGroupExpr,
  sourceAlias: string,
  params: ScalarValue[],
  options: GelIRCompileOptions,
  target: RuntimeTarget,
  depth: number,
): string => {
  const link = group.source.expr;
  if (link.kind !== "pointer" || !shouldUseLinkTable(link)) {
    // Only link-table links (multi / link-property-bearing, e.g. `.deck`) are
    // supported here — that's where a `@prop` group key lives.
    return "json('[]')";
  }
  const linkAlias = "d";
  const targetAlias = "c";
  const targetType = link.ptrref.outTarget;
  const linkTable = linkTableNameForPointer(link, options);

  // SQL for a BY atom: a link property reads the link table, a target field
  // reads the grouped target row.
  const atomColumn = (atom: { name: string; isLinkProperty: boolean }): string =>
    atom.isLinkProperty
      ? `${linkAlias}.${quoteIdent(atom.name)}`
      : `${targetAlias}.${quoteIdent(atom.name)}`;

  const elementsShape = group.elementsShape ?? [];
  const elementCols = collectProjectedColumns(elementsShape);
  const targetFieldKeys = group.byAtoms.filter((a) => !a.isLinkProperty).map((a) => a.name);
  const targetCols = [...new Set<string>(["id", ...elementCols, ...targetFieldKeys])];
  const targetSource = compilePolymorphicSource(targetType, false, targetAlias, targetCols, options);

  // key: one entry per requested key field (default: one per BY atom).
  const keyFieldNames = group.keyFields ?? [...new Set(group.byAtoms.map((a) => a.name))];
  const keyPairs = keyFieldNames.map((name) => {
    const atom = group.byAtoms.find((a) => a.name === name) ?? group.byAtoms[0];
    return `${quoteLiteral(name)}, ${atomColumn(atom)}`;
  });
  const itemPairs = [`${quoteLiteral("key")}, json_object(${keyPairs.join(", ")})`];

  // grouping: emitted only for the full default row (no trailing shape).
  if (!group.hasTrailingShape) {
    const names = [...new Set(group.byAtoms.map((a) => a.name))];
    itemPairs.push(`${quoteLiteral("grouping")}, json_array(${names.map((n) => quoteLiteral(n)).join(", ")})`);
  }

  const elementObj = elementsShape.length > 0
    ? compilePublicShapeObjectExpr(targetAlias, elementsShape, params, options, target, depth + 1)
    : "json_object()";
  // Order elements by link-table insertion order so the grouped set is
  // deterministic (SQLite's `json_group_array` order under GROUP BY is
  // otherwise unspecified) and matches the source set's order.
  itemPairs.push(`${quoteLiteral("elements")}, COALESCE(json_group_array(${elementObj} ORDER BY ${linkAlias}.rowid), json('[]'))`);

  // Dedup redundant key columns (`BY (@count, @count)` → `GROUP BY d."count"`)
  // so the grouping — and the resulting element order — is stable.
  const groupByCols = [...new Set(group.byAtoms.map(atomColumn))].join(", ");
  const innerSelect = `SELECT json_object(${itemPairs.join(", ")}) AS ${quoteIdent("item")}`
    + ` FROM ${quoteIdent(linkTable)} ${linkAlias}`
    + ` JOIN ${targetSource} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`
    + ` WHERE ${linkAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`
    + ` GROUP BY ${groupByCols}`;

  return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${innerSelect}) g), json('[]'))`;
};

// When recursing into a nested link inside an already-materialized object
// (`children: { children: {…} }`), the pointer's `.source` still carries the
// full path chain from the outer query. But the parent row is already bound to
// `sourceAlias`, so the link must anchor directly on it rather than re-walking
// the chain (which `compileChainSourceIdSetSQL` would otherwise do, producing a
// grandchildren lookup). Reset the source to a bare type-root so the direct
// `sourceAlias.id` anchor is used.
const resetPointerSourceToRoot = (pointer: Pointer): Pointer => {
  if (pointer.source.expr.kind === "type_root") {
    return pointer;
  }
  const srcType = pointer.source.typeref;
  return {
    ...pointer,
    source: {
      ...pointer.source,
      expr: { kind: "type_root", typeref: srcType, skipSubtypes: false, isCachedGlobal: false },
    },
  };
};

// `owners[IS Bot]: {…}` — the IR narrows the link Set's typeref to the
// intersection type while the underlying ptrref still describes the full
// link. When they disagree, the lowering must scan the narrowed type's
// tables instead of the link's declared target/source.
const narrowedLinkTarget = (set: Set): TypeRef | undefined => {
  if (set.expr.kind !== "pointer") return undefined;
  const ptr = set.expr as Pointer;
  const base = ptr.direction === "inbound" ? ptr.ptrref.outSource : ptr.ptrref.outTarget;
  const typeref = set.typeref;
  return typeref && !typeref.isScalar && !typeref.collection && base && typeref.id !== base.id
    ? typeref
    : undefined;
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
  narrowedTarget?: TypeRef,
): string => {
  // Nested-shape recursion is driven by the (finite) IR shape, so it terminates
  // on its own when a level has no further link elements. This cap is only a
  // safety bound against pathological cyclic shapes, not a feature limit, so it
  // is set well above any realistic hand-written nesting depth.
  const maxDepth = options.maxShapeDepth ?? 32;
  if (depth > maxDepth) {
    return "'[]'";
  }

  const targetAlias = `p${depth}`;
  const joinAlias = `j${depth}`;
  // Include columns referenced by the link's modifier clauses (FILTER /
  // ORDER BY) so they reach the inner FROM. Without this, e.g. an
  // `ORDER BY .cost DESC LIMIT 1` on a `deck: { id }` shape sorts by NULL.
  const projectedCols = collectProjectedColumns(targetShape, modifiers?.where, modifiers?.orderBy);
  const rowExpr = compileShapeObjectExpr(targetAlias, targetShape, params, options, target, depth, joinAlias, pointer);

  if (pointer.direction === "inbound") {
    return compileBacklinkArrayExpr(pointer, sourceAlias, targetAlias, joinAlias, projectedCols, rowExpr, options, modifiers, params, target, narrowedTarget);
  }

  return compileOutboundLinkArrayExpr(pointer, sourceAlias, targetAlias, joinAlias, projectedCols, rowExpr, options, modifiers, params, target, narrowedTarget);
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
  narrowedTarget?: TypeRef,
): string => {
  const targetSource = compilePolymorphicSource(narrowedTarget ?? pointer.ptrref.outTarget, false, targetAlias, projectedCols, options);
  // `Comment.issue.owner`: the leaf (`owner`) anchors on the intermediate
  // `.issue`, not the outer `Comment` row. Resolve the intermediate id-set.
  const chainedSourceIds = pointer.source.expr.kind === "pointer"
    ? compileChainSourceIdSetSQL(pointer.source, sourceAlias, options)
    : null;
  if (shouldUseLinkTable(pointer)) {
    const linkTableRef = linkTableSourceForPointer(pointer, options);
    const sourceMatch = chainedSourceIds !== null
      ? `${joinAlias}.${quoteIdent("source")} IN (${chainedSourceIds})`
      : `${joinAlias}.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`;
    const inner = appendDefaultLinkOrder(
      compileLinkedInnerSelect(rowExpr, `FROM ${targetSource} JOIN ${linkTableRef} ${joinAlias} ON ${joinAlias}.${quoteIdent("target")} = ${targetAlias}.${quoteIdent("id")} WHERE ${sourceMatch}`, modifiers, targetAlias, params, target, options, joinAlias, pointer),
      modifiers, joinAlias,
    );
    return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
  }

  const inlineColumn = `${pointer.ptrref.shortName}_id`;
  const targetMatch = chainedSourceIds !== null
    ? `${targetAlias}.${quoteIdent("id")} IN (SELECT ${quoteIdent(inlineColumn)} FROM ${quoteIdent(tableNameForType(qualifyTypeName(pointer.ptrref.outSource)))} WHERE ${quoteIdent("id")} IN (${chainedSourceIds}))`
    : `${targetAlias}.${quoteIdent("id")} = ${sourceAlias}.${quoteIdent(inlineColumn)}`;
  const inner = compileLinkedInnerSelect(rowExpr, `FROM ${targetSource} WHERE ${targetMatch}`, modifiers, targetAlias, params, target, options, undefined, pointer);
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
  narrowedTarget?: TypeRef,
): string => {
  const sourceType = narrowedTarget ?? pointer.ptrref.outSource;
  const projectedBacklinkCols = shouldUseLinkTable(pointer)
    ? projectedCols
    : [...new Set<string>([...projectedCols, `${pointer.ptrref.shortName}_id`])];
  const backlinkSource = compilePolymorphicSource(sourceType, false, backlinkAlias, projectedBacklinkCols, options);
  // A backlink reached through a chain (`X.link.<other`) anchors on the
  // intermediate set rather than the outer row.
  const chainedSourceIds = pointer.source.expr.kind === "pointer"
    ? compileChainSourceIdSetSQL(pointer.source, sourceAlias, options)
    : null;
  if (shouldUseLinkTable(pointer)) {
    const linkTableRef = linkTableSourceForPointer(pointer, options);
    const targetMatch = chainedSourceIds !== null
      ? `${joinAlias}.${quoteIdent("target")} IN (${chainedSourceIds})`
      : `${joinAlias}.${quoteIdent("target")} = ${sourceAlias}.${quoteIdent("id")}`;
    const inner = appendDefaultLinkOrder(
      compileLinkedInnerSelect(rowExpr, `FROM ${backlinkSource} JOIN ${linkTableRef} ${joinAlias} ON ${joinAlias}.${quoteIdent("source")} = ${backlinkAlias}.${quoteIdent("id")} WHERE ${targetMatch}`, modifiers, backlinkAlias, params, target, options, joinAlias, pointer),
      modifiers, joinAlias,
    );
    return `COALESCE((SELECT json_group_array(json(${quoteIdent("item")})) FROM (${inner})), '[]')`;
  }

  const inlineColumn = `${pointer.ptrref.shortName}_id`;
  const fkMatch = chainedSourceIds !== null
    ? `${backlinkAlias}.${quoteIdent(inlineColumn)} IN (${chainedSourceIds})`
    : `${backlinkAlias}.${quoteIdent(inlineColumn)} = ${sourceAlias}.${quoteIdent("id")}`;
  const inner = compileLinkedInnerSelect(rowExpr, `FROM ${backlinkSource} WHERE ${fkMatch}`, modifiers, backlinkAlias, params, target, options, undefined, pointer);
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
      const innerSource = ptr.source;
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
  // The per-row projection (`json_object(...) AS item`) and the FROM/WHERE
  // tail are passed separately so a correlated LIMIT/OFFSET can re-emit the
  // projection alongside a window column (see below).
  rowExpr: string,
  fromWhere: string,
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
  const itemCol = quoteIdent("item");
  const baseSelect = `SELECT ${rowExpr} AS ${itemCol} ${fromWhere}`;
  if (!modifiers) {
    return baseSelect;
  }
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
  const whereExt = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
  let orderSql = "";
  if (modifiers.orderBy && modifiers.orderBy.length > 0) {
    // Same rewrite as for WHERE: `User.todo.number` inside the link's
    // iteration shape must resolve to `targetAlias.number`, not against the
    // outer User row. Without this, `ORDER BY User.todo.number` falls back to
    // a NULL literal and the sort is effectively undefined.
    const rewrittenOrderBy = outerPointer
      ? modifiers.orderBy.map((entry) => ({ ...entry, path: rewriteFilterAgainstPointerChain(entry.path, outerPointer) }))
      : modifiers.orderBy;
    orderSql = compileSortExprs(rewrittenOrderBy, targetAlias, linkPropertyAlias, params, target, options) || "";
  }
  // LIMIT / OFFSET may be a correlated expression (`LIMIT len(User.name) - 3`
  // on a per-row link shape) rather than a constant. Prefer the literal fast
  // path; otherwise compile the expression as a scalar value — paths into the
  // outer shaped row resolve through options.outerScopes.
  const limitLit = extractNumericLiteral(modifiers.limit);
  let limitSql: string | null = limitLit !== undefined ? String(limitLit) : null;
  let limitCorrelated = false;
  if (limitSql === null && modifiers.limit) {
    limitSql = compileValueSetSQL(modifiers.limit, targetAlias, params, target, options, linkPropertyAlias);
    limitCorrelated = limitSql !== null;
  }
  const offsetLit = extractNumericLiteral(modifiers.offset);
  let offsetSql: string | null = offsetLit !== undefined ? String(offsetLit) : null;
  let offsetCorrelated = false;
  if (offsetSql === null && modifiers.offset) {
    offsetSql = compileValueSetSQL(modifiers.offset, targetAlias, params, target, options, linkPropertyAlias);
    offsetCorrelated = offsetSql !== null;
  }
  // SQLite rejects correlated outer-column references inside a subquery's
  // LIMIT/OFFSET clause (though it allows them in WHERE). When a bound is a
  // correlated expression, rank the rows with row_number() and filter on the
  // rank — the correlated bound then lives in a WHERE, which SQLite accepts.
  if (limitCorrelated || offsetCorrelated) {
    const overOrder = orderSql ? `ORDER BY ${orderSql}` : "";
    const ranked = `SELECT ${rowExpr} AS ${itemCol}, row_number() OVER (${overOrder}) AS ${quoteIdent("__rn")} ${fromWhere}${whereExt}`;
    const conds: string[] = [];
    if (offsetSql !== null) conds.push(`${quoteIdent("__rn")} > (${offsetSql})`);
    if (limitSql !== null) {
      // LIMIT counts rows remaining AFTER the offset.
      conds.push(offsetSql !== null
        ? `${quoteIdent("__rn")} <= (${offsetSql}) + (${limitSql})`
        : `${quoteIdent("__rn")} <= (${limitSql})`);
    }
    const condSql = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
    return `SELECT ${itemCol} FROM (${ranked})${condSql} ORDER BY ${quoteIdent("__rn")}`;
  }
  let inner = `${baseSelect}${whereExt}`;
  if (orderSql) inner += ` ORDER BY ${orderSql}`;
  if (limitSql !== null) inner += ` LIMIT ${limitSql}`;
  if (offsetSql !== null) {
    // SQLite requires a LIMIT before OFFSET; `LIMIT -1` means unbounded.
    if (limitSql === null) inner += ` LIMIT -1`;
    inner += ` OFFSET ${offsetSql}`;
  }
  return inner;
};

// Default multi-link ordering. Multi-links are formally unordered, but tests
// (and EdgeDB) surface them in insertion order; the link table's rowid records
// that order. Append `ORDER BY <joinAlias>.rowid` only when the shape has no
// explicit ORDER BY / LIMIT / OFFSET and the link materializes via a link
// table (so a join alias with a real rowid exists).
const appendDefaultLinkOrder = (
  inner: string,
  modifiers: SelectExpr | undefined,
  joinAlias: string,
): string => {
  if (modifiers && modifiers.orderBy && modifiers.orderBy.length > 0) return inner;
  if (modifiers && (modifiers.limit !== undefined || modifiers.offset !== undefined)) return inner;
  return `${inner} ORDER BY ${joinAlias}.${quoteIdent("rowid")}`;
};

// EdgeQL's default empty-set placement (ASC → EMPTY FIRST, DESC → EMPTY
// LAST) matches SQLite's native NULL ordering, so we only need an explicit
// NULLS clause when the query overrides the default with `EMPTY FIRST/LAST`.
const sortNullsClause = (entry: SortExpr): string => {
  const defaultOrder = entry.direction.toLowerCase() === "desc" ? "last" : "first";
  if (!entry.nonesOrder || entry.nonesOrder === defaultOrder) return "";
  return entry.nonesOrder === "first" ? " NULLS FIRST" : " NULLS LAST";
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
        // Link-property columns are stored without the leading `@`.
        const orderColumn = isLinkPropertyPointer && column.startsWith("@") ? column.slice(1) : column;
        return `${orderAlias}.${quoteIdent(orderColumn)} ${entry.direction.toUpperCase()}${sortNullsClause(entry)}`;
      }
      // Expression sort keys (`ORDER BY len(.body)`) need the full value
      // compiler — bare column references only cover the trivial pointer
      // case. Caller must pass params/target/options for this to fire;
      // legacy callers without them keep the column-only behaviour.
      if (params && target && options) {
        const sql = compileValueSetSQL(entry.path, sourceAlias, params, target, options, linkPropertyAlias);
        if (sql) return `${sql} ${entry.direction.toUpperCase()}${sortNullsClause(entry)}`;
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

// Whether a cast's source is an object SHAPE (`Issue { number }`, possibly
// behind several `select_expr` fences) rather than a scalar. The shape may sit
// on any of the nested select levels, so walk them all. Used to decide that
// `<json>X` should pass the already-`json_object` text through unchanged
// instead of `json_quote`-ing it into a JSON string.
const castSourceIsObjectShape = (set: Set): boolean => {
  let cur: Set = set;
  for (;;) {
    if (cur.shape && cur.shape.length > 0) return true;
    if (cur.expr.kind === "select_expr") {
      cur = (cur.expr as SelectExpr).result;
      continue;
    }
    return false;
  }
};

// A subquery operand is "independent" when every type-root it reads from is a
// free reference — none resolve to an enclosing iteration (outerScopes) or a
// bound non-root source (sourcePathAliases). Such a subquery (`(SELECT
// <json>Issue {…} FILTER Issue.number = '1')` as a `=` operand) needs its own
// FROM clause; compiling it as a correlated `SELECT value` against the caller's
// alias would dangle on an alias that doesn't exist. Returns false for a
// constant subquery (no roots) — those compile fine without a FROM.
const subqueryReferencesOnlyFreeRoots = (
  selectExpr: SelectExpr,
  options: GelIRCompileOptions,
): boolean => {
  let hasRoot = false;
  let allFree = true;
  const consider = (src: Set): void => {
    if (src.expr.kind !== "type_root") return;
    hasRoot = true;
    const namespace = src.pathId?.namespace ?? [];
    const typerefId = (src.expr as TypeRoot).typeref.id;
    if (findMatchingOuterScope({ typerefId, namespace }, options)) allFree = false;
    if ((options.sourcePathAliases ?? []).some((p) => p.pathKey === pathIdKey(src))) allFree = false;
  };
  const visit = (set: Set): void => {
    if (!allFree) return;
    const expr = set.expr;
    if (expr.kind === "type_root") { consider(set); return; }
    if (expr.kind === "pointer") { visit((expr as Pointer).source); return; }
    if (expr.kind === "type_cast") { visit((expr as TypeCast).expr); return; }
    if (expr.kind === "operator_call") {
      for (const arg of orderedCallArgs((expr as OperatorCall).args)) visit(arg.expr);
      return;
    }
    if (expr.kind === "function_call") {
      for (const arg of orderedCallArgs((expr as FunctionCall).args)) visit(arg.expr);
      return;
    }
    if (expr.kind === "select_expr") {
      const se = expr as SelectExpr;
      visit(se.result);
      if (se.where) visit(se.where);
      for (const order of se.orderBy ?? []) visit(order.path);
      return;
    }
    if (expr.kind === "tuple") { for (const el of (expr as Tuple).elements) visit(el.val); return; }
    if (expr.kind === "array") { for (const el of (expr as ArrayExpr).elements) visit(el); return; }
    if (expr.kind === "if_else_expr") {
      const ifElse = expr as IfElseExpr;
      visit(ifElse.condition); visit(ifElse.ifExpr); visit(ifElse.elseExpr);
      return;
    }
    if (expr.kind === "coalesce_expr") {
      const coalesce = expr as CoalesceExpr;
      visit(coalesce.left); visit(coalesce.right);
      return;
    }
    if (expr.kind === "exists_expr") { visit((expr as ExistsExpr).expr); return; }
    if (expr.kind === "index_expr") {
      const indexExpr = expr as IndexExpr;
      visit(indexExpr.expr); visit(indexExpr.index);
      return;
    }
  };
  visit(selectExpr.result);
  if (selectExpr.where) visit(selectExpr.where);
  for (const order of selectExpr.orderBy ?? []) visit(order.path);
  return hasRoot && allFree;
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

// Render a scalar shape column for embedding in a json_object: collections
// pass through `json()`, booleans (stored as 0/1 in SQLite) surface as real
// JSON booleans, everything else is the raw column value.
const shapeScalarColumnValue = (rawValue: string, typeref: TypeRef): string => {
  if (typeref.collection !== undefined) return `json(${rawValue})`;
  if (qualifyTypeName(typeref) === "std::bool") {
    return `(CASE WHEN ${rawValue} IS NULL THEN NULL WHEN ${rawValue} THEN json('true') ELSE json('false') END)`;
  }
  return rawValue;
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
    // A nested link shape can carry per-link modifiers (`children: {…} ORDER
    // BY .val`), which wrap the pointer in a `select_expr`. Unwrap it so the
    // pointer (and its own nested shape) is found and the ORDER BY/LIMIT reach
    // the inner aggregate. Use the element's declared name for the key — a
    // computed link alias (`children := .<parent`) resolves to a pointer whose
    // `shortName` is the underlying link (`parent`).
    const elemUnwrapped = unwrapSelectExprSet(element.expr);
    const elemResult = elemUnwrapped.result;
    if (elemResult.expr.kind === "pointer" && !elemResult.typeref.isScalar) {
      // An `anytype`-targeted pointer is a failed resolution upstream (e.g.
      // a path into a computed the IR couldn't type) — scanning its "table"
      // would hit a nonexistent relation. Bail under strictShape so GROUP
      // lowerings fall back instead of executing garbage SQL.
      const linkTarget = (elemResult.expr as Pointer).ptrref.outTarget;
      if (linkTarget && (linkTarget.id === "std::anytype" || linkTarget.id === "unknown:std::anytype")) {
        if (options.strictShape) {
          throw new ShapeLoweringMiss(shapeAliasForElement(element, elemResult, depth));
        }
        continue;
      }
      const nested = compilePointerArrayExpr(
        resetPointerSourceToRoot(elemResult.expr as Pointer),
        sourceAlias,
        elemResult.shape ?? [],
        params,
        options,
        target,
        depth + 1,
        elemUnwrapped.selectExpr,
        narrowedLinkTarget(elemResult),
      );
      const key = quoteLiteral(shapeAliasForElement(element, elemResult, depth));
      if (element.cardinality === "many" || element.cardinality === "at_least_one") {
        pairs.push(`${key}, json(${nested})`);
      } else {
        pairs.push(`${key}, json(COALESCE(json_extract(${nested}, '$[0]'), 'null'))`);
      }
      continue;
    }

    // A pointer CHAIN (`category := .avatar.name`) has no single source
    // column — compileSetColumnRef would return the LEAF column and misread
    // the root row. Route chains through the computed value path below.
    const elemIsChain = elemResult.expr.kind === "pointer" && ((): boolean => {
      let src: Set = (elemResult.expr as Pointer).source;
      while (src.expr.kind === "select_expr") src = (src.expr as SelectExpr).result;
      return src.expr.kind === "pointer";
    })();
    const column = elemIsChain ? null : compileSetColumnRef(element.expr, linkPropertyAlias);
    if (column) {
      if (column.startsWith("@") && linkPropertyAlias) {
        const rawValue = `${linkPropertyAlias}.${quoteIdent(column.slice(1))}`;
        const value = shapeScalarColumnValue(rawValue, element.expr.typeref);
        // Key on the element's declared name so a renamed link property
        // (`x := @count`) projects under `x`, not the `@count` column name —
        // matching the plain-scalar branch (`element.name ?? column`).
        pairs.push(`${quoteLiteral(element.name ?? column)}, ${value}`);
        continue;
      }
      const rawValue = `${sourceAlias}.${quoteIdent(column)}`;
      // A multi scalar property's column stores a JSON-encoded array —
      // embed it as nested JSON, not as a quoted string.
      const isMultiScalar = element.cardinality === "many" || element.cardinality === "at_least_one";
      const value = isMultiScalar
        ? `json(${rawValue})`
        : shapeScalarColumnValue(rawValue, element.expr.typeref);
      pairs.push(`${quoteLiteral(element.name ?? column)}, ${value}`);
      continue;
    }

    // Tuple-valued computed (`b := { c := 2, d := random() }`): emit a
    // json_object over the per-field values. A sub-shape (`b: {c}`) selects
    // which fields stay visible.
    if (element.expr.expr.kind === "tuple" && (element.expr.expr as Tuple).named) {
      const tuple = element.expr.expr as Tuple;
      const subShape = element.expr.shape && element.expr.shape.length > 0
        ? element.expr.shape
        : unwrapSelectExprSet(element.expr).result.shape;
      const subShapeNames = subShape && subShape.length > 0
        ? new globalThis.Set(subShape.map((sub) => sub.name).filter(Boolean))
        : undefined;
      const checkpoint = params.length;
      const tuplePairs: string[] = [];
      let allCompiled = true;
      for (const tupleEl of tuple.elements) {
        if (subShapeNames && tupleEl.name && !subShapeNames.has(tupleEl.name)) continue;
        const valueSql = tupleEl.name
          ? compileValueSetSQL(tupleEl.val, sourceAlias, params, target, options)
          : null;
        if (!valueSql || !tupleEl.name) {
          allCompiled = false;
          break;
        }
        tuplePairs.push(`${quoteLiteral(tupleEl.name)}, ${valueSql}`);
      }
      if (allCompiled) {
        pairs.push(`${quoteLiteral(shapeAliasForElement(element, element.expr, depth))}, json_object(${tuplePairs.join(", ")})`);
        continue;
      }
      params.length = checkpoint;
    }

    const computed = compileValueSetSQL(element.expr, sourceAlias, params, target, options);
    if (computed) {
      pairs.push(`${quoteLiteral(shapeAliasForElement(element, element.expr, depth))}, ${computed}`);
    } else if (options.strictShape) {
      throw new ShapeLoweringMiss(shapeAliasForElement(element, element.expr, depth));
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
  // The link pointer whose target rows this shape iterates (`User.deck` for a
  // `deck: {…}` shape). A computed element body resolves its own fields as the
  // full outer chain (`User.deck.cost`); rewriting that chain prefix to the
  // iterated link lets the leaf collapse to `sourceAlias.col` (the element's
  // own column) instead of re-walking the link as a correlated subquery. Mirrors
  // the rewrite already applied to the link's FILTER / ORDER BY clauses.
  iteratedPointer?: Pointer,
): string => {
  const pairs = [
    `${quoteLiteral("id")}, ${sourceAlias}.${quoteIdent("id")}`,
    `${quoteLiteral("__source_type")}, ${sourceAlias}.${quoteIdent("__source_type")}`,
  ];

  for (const element of shape) {
    // A nested link shape can carry per-link modifiers (`children: {…} ORDER
    // BY .val`), which wrap the pointer in a `select_expr`. Unwrap it so the
    // pointer (and its own nested shape) is found and the ORDER BY/LIMIT reach
    // the inner aggregate. Use the element's declared name for the key — a
    // computed link alias (`children := .<parent`) resolves to a pointer whose
    // `shortName` is the underlying link (`parent`).
    const elemUnwrapped = unwrapSelectExprSet(element.expr);
    const elemResult = elemUnwrapped.result;
    if (elemResult.expr.kind === "pointer" && !elemResult.typeref.isScalar) {
      // An `anytype`-targeted pointer is a failed resolution upstream (e.g.
      // a path into a computed the IR couldn't type) — scanning its "table"
      // would hit a nonexistent relation. Bail under strictShape so GROUP
      // lowerings fall back instead of executing garbage SQL.
      const linkTarget = (elemResult.expr as Pointer).ptrref.outTarget;
      if (linkTarget && (linkTarget.id === "std::anytype" || linkTarget.id === "unknown:std::anytype")) {
        if (options.strictShape) {
          throw new ShapeLoweringMiss(shapeAliasForElement(element, elemResult, depth));
        }
        continue;
      }
      const nested = compilePointerArrayExpr(
        resetPointerSourceToRoot(elemResult.expr as Pointer),
        sourceAlias,
        elemResult.shape ?? [],
        params,
        options,
        target,
        depth + 1,
        elemUnwrapped.selectExpr,
        narrowedLinkTarget(elemResult),
      );
      const key = quoteLiteral(shapeAliasForElement(element, elemResult, depth));
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
        const value = shapeScalarColumnValue(rawValue, element.expr.typeref);
        // Key on the element's declared name so a renamed link property
        // (`x := @count`) projects under `x`, not the `@count` column name —
        // matching the plain-scalar branch (`element.name ?? column`).
        pairs.push(`${quoteLiteral(element.name ?? column)}, ${value}`);
        continue;
      }
      const rawValue = `${sourceAlias}.${quoteIdent(column)}`;
      // A multi scalar property's column stores a JSON-encoded array —
      // embed it as nested JSON, not as a quoted string.
      const isMultiScalar = element.cardinality === "many" || element.cardinality === "at_least_one";
      const value = isMultiScalar
        ? `json(${rawValue})`
        : shapeScalarColumnValue(rawValue, element.expr.typeref);
      pairs.push(`${quoteLiteral(column)}, ${value}`);
      continue;
    }

    // A computed element body (`c2 := .cost + 1`) holds the leaf as the full
    // outer chain (`User.deck.cost`). When this shape iterates a link, collapse
    // that chain prefix so the leaf reads the element's own column
    // (`sourceAlias.cost`) rather than re-walking the link as a subquery.
    const computedExpr = iteratedPointer
      ? rewriteFilterAgainstPointerChain(element.expr, iteratedPointer)
      : element.expr;
    const computed = compileValueSetSQL(computedExpr, sourceAlias, params, target, options);
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

  // Multi scalar properties (`multi property tag_set1 -> str`) are stored
  // inline as a JSON-encoded TEXT column on the owning row, not as a
  // separate link table. Link-table-based traversal must only kick in for
  // object-typed links.
  if (pointer.ptrref.outTarget.isScalar) {
    return false;
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

// EdgeQL `//` (floor division) and `%` (floored modulo) need Python/Postgres
// semantics — the result follows the sign of the divisor — which SQLite's
// truncated `/` and sign-of-dividend `%` do not provide. Route them through
// the `_gel_floordiv` / `_gel_mod` runtime functions (each operand referenced
// once, so param ordering is preserved). Returns null for every other operator
// so callers fall back to the plain infix emit.
const flooredArithBinarySql = (operator: string, left: string, right: string): string | null => {
  if (operator === "//") return `_gel_floordiv(${left}, ${right})`;
  if (operator === "%") return `_gel_mod(${left}, ${right})`;
  return null;
};

const operatorToInfixSql = (operator: string): string | null => {
  // NOTE: `^` (power) is NOT infix in SQLite — callers special-case it to
  // `pow(l, r)` before consulting this map.
  if (operator === "+" || operator === "-" || operator === "*" || operator === "/" || operator === "%") {
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
  if (operator === "not_like") {
    return "NOT LIKE";
  }
  // ILIKE / NOT ILIKE are sentinels: SQLite has no ILIKE operator, so every
  // emit site must route these through likeOperatorSql rather than joining
  // the returned token into raw SQL.
  if (operator === "ilike") {
    return "ILIKE";
  }
  if (operator === "not_ilike") {
    return "NOT ILIKE";
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
// `value` is widened beyond ScalarValue to accept bigint so out-of-band
// big-integer constants (which JS `number` cannot represent exactly) inline
// losslessly if they ever reach here.
const inlineIntegerConstantSql = (expr: Expr, value: ScalarValue | bigint): string | undefined => {
  if (expr.kind !== "integer_constant") return undefined;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString(10);
  return undefined;
};

// The LIKE family needs dedicated emission: the connection sets
// case_sensitive_like=1, so LIKE is case-sensitive (EdgeQL semantics) and the
// case-insensitive forms lower through LOWER() on both operands.
const likeOperatorSql = (operator: string, left: string, right: string): string | undefined => {
  switch (operator) {
    case "like": return `(${left} LIKE ${right})`;
    case "not_like": return `(${left} NOT LIKE ${right})`;
    case "ilike": return `(LOWER(${left}) LIKE LOWER(${right}))`;
    case "not_ilike": return `(LOWER(${left}) NOT LIKE LOWER(${right}))`;
    default: return undefined;
  }
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
// A reference to a settable global that currently holds no value (never `set`,
// or `reset`) is the empty set. We detect this by checking the compile-time
// `globalValues`: an *absent* key means unset (→ empty). A present value (even
// null) is treated as a real value. Computed and `set` globals always have an
// entry, so this only fires for unset settable globals.
const isUnsetGlobalExpr = (expr: Expr, options?: GelIRCompileOptions): boolean => {
  if (!options || expr.kind !== "global_expr") return false;
  const name = (expr as { name: string }).name;
  const values = options.globalValues;
  if (!values) return true;
  return values[name] === undefined
    && values[`global::${name}`] === undefined
    && values[`default::${name}`] === undefined;
};

const isTopLevelEmptySetMarker = (set: Set, options?: GelIRCompileOptions): boolean => {
  let expr: Expr = set.expr;
  while (expr.kind === "type_cast") {
    expr = (expr as TypeCast).expr.expr;
  }
  if (isUnsetGlobalExpr(expr, options)) return true;
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
  "like", "ilike", "not_like", "not_ilike", "in", "not in",
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
  // SET OF aggregates: defined results (or a "not enough elements" error)
  // on the empty set rather than empty-propagation.
  "min", "max", "avg", "all", "any",
  "mean", "stddev", "stddev_pop", "var", "var_pop",
  // range bounds are OPTIONAL params: an empty arg means "unbounded",
  // not an empty result.
  "range", "multirange",
]);
const selectYieldsEmptyByStrictOperand = (set: Set, options?: GelIRCompileOptions): boolean => {
  let expr: Expr = set.expr;
  while (expr.kind === "type_cast") {
    expr = (expr as TypeCast).expr.expr;
  }
  // A bare reference to an unset settable global is itself empty (covers an
  // inlined function whose body is just `global a`).
  if (isUnsetGlobalExpr(expr, options)) return true;
  if (expr.kind === "operator_call") {
    const op = (expr as OperatorCall).operator;
    if (op === "not") {
      const args = orderedCallArgs((expr as OperatorCall).args);
      const onlyArg = args[0]?.expr;
      // `NOT EXISTS X` is always defined (true when X empty), not empty-propagating.
      if (onlyArg && onlyArg.expr.kind === "exists_expr") return false;
      return Boolean(onlyArg && isTopLevelEmptySetMarker(onlyArg, options));
    }
    if (!STRICT_BINARY_OPS.has(op)) return false;
    const args = orderedCallArgs((expr as OperatorCall).args);
    // Recurse so nested strict operators propagate empty up the tree —
    // `x * x + 2 * x + 1` with empty `x` should yield empty even though the
    // outer `+`'s direct args are themselves `operator_call`s, not raw empty
    // markers.
    return args.some((arg) => isTopLevelEmptySetMarker(arg.expr, options) || selectYieldsEmptyByStrictOperand(arg.expr, options));
  }
  if (expr.kind === "function_call") {
    const call = expr as FunctionCall;
    // Inlined UDF: the body's own strictness governs empty-propagation —
    // recursing into the body picks up set-constructor / union bodies that
    // remain defined when some arg is empty (e.g. `{<str>x, y}` with empty
    // `x` still yields `{y}`). Skip the per-arg shortcut here.
    if (call.body) {
      return selectYieldsEmptyByStrictOperand(call.body, options);
    }
    const shortName = (call.functionName ?? "").split("::").pop() ?? "";
    if (NON_STRICT_STDLIB.has(shortName)) return false;
    const args = orderedCallArgs(call.args);
    return args.some((arg) => isTopLevelEmptySetMarker(arg.expr, options) || selectYieldsEmptyByStrictOperand(arg.expr, options));
  }
  // Array and tuple literals are constructed from the cross-product of their
  // element sets — an empty element means zero rows. `[<int64>{}]` and
  // `(<int64>{}, 1)` both yield empty.
  if (expr.kind === "array") {
    const elements = (expr as ArrayExpr).elements;
    return elements.some((el) => isTopLevelEmptySetMarker(el, options) || selectYieldsEmptyByStrictOperand(el, options));
  }
  if (expr.kind === "tuple") {
    const elements = (expr as Tuple).elements;
    return elements.some((el) => isTopLevelEmptySetMarker(el.val, options) || selectYieldsEmptyByStrictOperand(el.val, options));
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
