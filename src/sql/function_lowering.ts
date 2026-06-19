import { quoteIdent, quoteLiteral } from "../codegen/sql.js";
import type {
  CallArg,
  FunctionCall,
  OperatorCall,
  Pointer,
  SelectExpr,
  Set,
  ShapeElement,
  SortExpr,
  Tuple,
  TypeCast,
  TypeRef,
  TypeRoot,
} from "../ir/gel_ir.js";
import type { RuntimeTarget } from "../runtime/target.js";
import type { ScalarValue } from "../types.js";
import type { GelIRCompileOptions } from "./compiler_types.js";
import { lowerStdlibFunctionSql } from "./stdlib_lowering.js";

// Functions returning `optional T` where a SQL NULL means "no value" — at a
// top-level scalar select that's the EMPTY SET (zero rows), not a NULL row.
// `range_get_upper`/`range_get_lower` return {} for an unbounded bound.
export const EMPTY_ON_NULL_FUNCTIONS = new Set<string>([
  "range_get_upper", "range_get_lower",
]);

export const SET_CONSUMING_FUNCTIONS = new Set<string>([
  "count", "sum", "min", "max", "avg", "all", "any", "array_agg", "enumerate",
  "mean", "stddev", "stddev_pop", "var", "var_pop",
  "assert_distinct", "assert_single", "assert_exists", "assert",
  "array_unpack", "range_unpack", "array_join", "array_get",
]);

// Stdlib functions that return std::bool — their IR typeref is usually the
// uninferred `std::anytype`, so the value layer consults this list to decide
// when to JSON-encode the boolean result.
const BOOL_RETURNING_STDLIB = new Set<string>([
  "contains", "re_test", "range_is_empty", "range_is_inclusive_upper",
  "range_is_inclusive_lower", "overlaps", "strictly_above", "strictly_below",
  "bounded_above", "bounded_below", "adjacent",
]);

// The SQL compiler's PRIVATE internal seam: the gel_ir_compiler primitives that
// the function- and group-lowering sub-modules call back into. There is exactly
// one adapter (gel_ir_compiler builds it), so this is NOT a public/swappable
// extension point — it is an explicit, named cut of one algorithm across files,
// kept here so the cross-file calls are typed rather than implicit.
export interface SqlLoweringContext {
  compileValueSetSQL(
    set: Set,
    sourceAlias: string,
    params: ScalarValue[],
    target: RuntimeTarget,
    options: GelIRCompileOptions,
    linkPropertyAlias?: string,
  ): string | null;
  compileScalarSelectSQL(
    sourceSet: Set,
    params: ScalarValue[],
    target: RuntimeTarget,
    options: GelIRCompileOptions,
    outerWheres?: Set[],
  ): string | null;
  compileSelectSource(
    sourceSet: Set,
    where: Set | undefined,
    orderBy: SortExpr[] | undefined,
    options: GelIRCompileOptions,
    params?: ScalarValue[],
    target?: RuntimeTarget,
    aliasOverride?: string,
    extraColumns?: string[],
  ): { sql: string; alias: string } | null;
  compileWhereClause(
    where: Set,
    sourceAlias: string,
    params: ScalarValue[],
    target: RuntimeTarget,
    options: GelIRCompileOptions,
    linkPropertyAlias?: string,
  ): string | null;
  compilePolymorphicSource(
    typeRef: TypeRef,
    skipSubtypes: boolean,
    alias: string,
    projectedColumns: string[],
    options: GelIRCompileOptions,
  ): string;
  compileForExprSource(
    sourceSet: Set,
    projectedColumns: string[],
    options: GelIRCompileOptions,
    params?: ScalarValue[],
    target?: RuntimeTarget,
  ): { fromSql: string; bindingAliases: Map<string, string> } | null;
  compilePointerArrayExpr(
    pointer: Pointer,
    sourceAlias: string,
    targetShape: ShapeElement[],
    params: ScalarValue[],
    options: GelIRCompileOptions,
    target: RuntimeTarget,
    depth: number,
    modifiers?: SelectExpr,
    narrowedTarget?: TypeRef,
  ): string;
  tryCompileCorrelatedScalarPointerPathScalarSelect(
    set: Set,
    sourceAlias: string,
    options: GelIRCompileOptions,
  ): string | null;
  collectForExprProjectedColumns(sourceSet: Set, where?: Set, orderBy?: SortExpr[]): string[];
  collectFreeTypeRoots(bodySet: Set, bindingAliases: Map<string, string>, outerWhere?: Set): Array<{ key: string; typeref: TypeRef }>;
  countAliases(bindingAliases: Map<string, string>): number;
  innermostForExprBody(sourceSet: Set): Set;
  isTopLevelEmptySetMarker(set: Set, options?: GelIRCompileOptions): boolean;
  pickSourcePathAlias(set: Set, options: GelIRCompileOptions): string | null;
  resetPointerSourceToRoot(pointer: Pointer): Pointer;
  narrowedLinkTarget(set: Set): TypeRef | undefined;
  setValueIsJson(set: Set): boolean;
  unwrapSelectExprSet(set: Set): { result: Set; selectExpr?: SelectExpr };
  qualifyTypeName(typeRef: TypeRef): string;
  // Group-lowering primitives (consumed by group_lowering.ts):
  compilePredicateSetSQL(
    set: Set,
    sourceAlias: string,
    params: ScalarValue[],
    target: RuntimeTarget,
    options: GelIRCompileOptions,
    linkPropertyAlias?: string,
  ): string | null;
  extractNumericLiteral(set: Set | undefined): number | undefined;
  orderedCallArgs(args: Record<string, CallArg>): CallArg[];
}

const orderedCallArgs = (args: Record<string, CallArg>): CallArg[] => {
  return Object.entries(args)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([, arg]) => arg);
};

// Static scalar type hint for a call argument — used by width-sensitive
// stdlib lowerings (bit_lshift/bit_rshift/bit_count pick 16/32/64-bit
// behaviour from the first operand's type). Casts report their target type,
// and nested bit_* calls inherit the width of their own first argument
// (their IR typeref is often the unresolved `std::anytype`).
export const scalarArgTypeHint = (set: Set): string | undefined => {
  let cur = set;
  while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
  if (cur.expr.kind === "type_cast") {
    return (cur.expr as TypeCast).toType.nameHint ?? cur.typeref.nameHint;
  }
  // Collection-typed properties report `std::json` storage in their nameHint;
  // surface the structural `array<…>` marker so polymorphic templates (len)
  // can dispatch on the logical collection kind.
  if (cur.typeref.collection === "array") return `array<${cur.typeref.nameHint ?? ""}>`;
  const hint = cur.typeref.nameHint;
  if (hint && /::int(16|32|64)$/.test(hint)) return hint;
  if (cur.expr.kind === "function_call") {
    const inner = cur.expr as FunctionCall;
    if ((inner.functionName.split("::").pop() ?? "").startsWith("bit_")) {
      const first = orderedCallArgs(inner.args)[0];
      if (first) return scalarArgTypeHint(first.expr);
    }
  }
  return hint;
};

// True when a set's value is a range (a `range(...)` constructor or a
// range-typed expression) — used to pick range semantics for the overloaded
// `contains` and friends.
export const setLooksLikeRange = (set: Set): boolean => {
  let cur = set;
  while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
  if (cur.expr.kind === "function_call") {
    const fn = ((cur.expr as FunctionCall).functionName.split("::").pop()) ?? "";
    if (fn === "range" || fn === "multirange") return true;
  }
  // Range set algebra (`+`/`*`/`-` over range operands) again yields a range,
  // so a chained op (`r1 - r2 - r3`) — whose left operand is itself such an
  // operator_call — is still a range.
  if (cur.expr.kind === "operator_call") {
    const op = cur.expr as OperatorCall;
    if (op.operator === "+" || op.operator === "*" || op.operator === "-") {
      const operands = Object.values(op.args);
      if (operands.length === 2 && operands.every((a) => setLooksLikeRange(a.expr))) return true;
    }
  }
  const hint = cur.typeref?.nameHint ?? "";
  return hint.startsWith("range<") || hint.startsWith("std::range");
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
export const compileCountOfSetSQL = (
  set: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const expr = set.expr;

  if (expr.kind === "type_root") {
    const root = expr as TypeRoot;
    // The root is already scoped by the enclosing per-row iteration — the
    // SET OF arg sees the scoped singleton, not the whole table.
    if (options.scopedAggRoot && root.typeref.id === options.scopedAggRoot.typerefId) {
      return `(CASE WHEN ${options.scopedAggRoot.alias}.${quoteIdent("id")} IS NULL THEN 0 ELSE 1 END)`;
    }
    const fromSql = deps.compilePolymorphicSource(root.typeref, root.skipSubtypes, "g_agg", ["id"], options);
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
      const factor = compileCountOfSetSQL(element.val, params, target, options, deps);
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
      return compileCountOfSetSQL(selectExpr.result, params, target, options, deps);
    }
    // First try the scalar-select compile, which knows how to lower
    // multi-scalar pointer iterations (`SELECT _ := Item.tag_set1 FILTER _ IN ...`)
    // into a json_each-based SELECT. compileSelectSource only works for
    // object sources, so without this fallback the count returns null and
    // gets dropped, leaving SQL with an invalid bare `count(...)`.
    {
      const cp = params.length;
      const scalarSql = deps.compileScalarSelectSQL(set, params, target, options);
      if (scalarSql) {
        return `(SELECT count(*) FROM (${scalarSql}))`;
      }
      params.length = cp;
    }
    const checkpoint = params.length;
    const compiledSource = deps.compileSelectSource(selectExpr.result, selectExpr.where, selectExpr.orderBy, options, params, target);
    if (compiledSource) {
      let sql = `SELECT count(*) AS ${quoteIdent("value")} FROM ${compiledSource.sql}`;
      if (selectExpr.where) {
        const whereSql = deps.compileWhereClause(selectExpr.where, compiledSource.alias, params, target, options);
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
          ? deps.compileValueSetSQL(selectExpr.limit, compiledSource.alias, params, target, options)
          : null;
        const offsetSql = selectExpr.offset
          ? deps.compileValueSetSQL(selectExpr.offset, compiledSource.alias, params, target, options)
          : null;
        if ((selectExpr.limit && !limitSql) || (selectExpr.offset && !offsetSql)) {
          params.length = checkpoint;
          return null;
        }
        let inner = `SELECT 1 FROM ${compiledSource.sql}`;
        if (selectExpr.where) {
          const innerWhereSql = deps.compileWhereClause(selectExpr.where, compiledSource.alias, params, target, options);
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
    const scalarSql = deps.compileScalarSelectSQL(set, params, target, options);
    if (scalarSql) {
      return `(SELECT count(*) FROM (${scalarSql}))`;
    }
    params.length = checkpoint;
    // Non-scalar pointer (link traversal like `User.friends`): scalar compile
    // bails because the target isn't a scalar. Build the link-traversal
    // FROM clause directly and count its rows.
    const compiledSource = deps.compileSelectSource(set, undefined, undefined, options, params, target);
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
    // Counting iterations only works when the body is one row per
    // iteration — a group-row chain body (`z := g.elements.name`) is a SET
    // per iteration, so route through the row-set lowering below instead.
    const bodyIsGroupRowChain = ((): boolean => {
      let cur = deps.innermostForExprBody(set);
      while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
      return cur.expr.kind === "group_row_field" || cur.expr.kind === "group_rows";
    })();
    const projectedColumns = deps.collectForExprProjectedColumns(set);
    const forSource = bodyIsGroupRowChain ? null : deps.compileForExprSource(set, projectedColumns, options, params, target);
    if (forSource) {
      // Add cross joins for free type roots in the body, matching how the
      // outer FOR path builds its FROM clause.
      const bodySet = deps.innermostForExprBody(set);
      const freeRoots = deps.collectFreeTypeRoots(bodySet, forSource.bindingAliases);
      let nextIdx = deps.countAliases(forSource.bindingAliases);
      for (const root of freeRoots) {
        const alias = `g${nextIdx++}`;
        const joinSql = deps.compilePolymorphicSource(root.typeref, false, alias, projectedColumns, options);
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
  // row, so they count as 1.) Group-row element paths (`count(g.elements)`)
  // lower to a correlated row set the same way.
  if (expr.kind === "operator_call" || expr.kind === "group_row_field" || expr.kind === "group_rows" || expr.kind === "for_expr") {
    const checkpoint = params.length;
    const scalarSql = deps.compileScalarSelectSQL(set, params, target, options);
    if (scalarSql) {
      return `(SELECT count(*) FROM (${scalarSql}))`;
    }
    params.length = checkpoint;
  }

  return null;
};

export const compileFunctionCallSQL = (
  call: FunctionCall,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
  linkPropertyAlias?: string,
): string | null => {
  const checkpoint = params.length;

  // `array_get(arr, {0, 1})` — multi-valued index returns a set, not a
  // single value. compileValueSetSQL would produce `json_extract(arr, '$['
  // || (subquery returning json_group_array of indices) || ']')` which
  // raises "bad JSON path". Bail to null so the caller routes through
  // compileScalarSelectSQL (which has a multi-index handler).
  {
    const sn = call.functionName.split("::").pop() ?? "";
    if (sn === "array_get") {
      const argList = orderedCallArgs(call.args);
      if (argList.length >= 2) {
        const idxUnwrapped = deps.unwrapSelectExprSet(argList[1].expr);
        if (idxUnwrapped.result.expr.kind === "operator_call"
            && (idxUnwrapped.result.expr as OperatorCall).operator === "union") {
          return null;
        }
      }
    }
  }
  void checkpoint;

  // Aggregates whose argument is a set: lower to `(SELECT agg(value) FROM (<set-sql>))`.
  // count() has its own dedicated lowering that handles type_root, tuple
  // cross-products, and select_expr modifiers; sum/min/max/avg/array_agg all
  // share the generic "compile the arg as a scalar value set, then wrap in
  // the SQL aggregate" shape.
  const shortName = call.functionName.split("::").pop() ?? "";
  const STAT_AGG_SQL: Record<string, string> = {
    mean: "_gel_mean", stddev: "_gel_stddev", stddev_pop: "_gel_stddev_pop",
    var: "_gel_var", var_pop: "_gel_var_pop",
  };
  const aggregateOfType = ["count", "min", "max", "sum", "avg", "array_agg", "all", "any"].includes(shortName)
    || shortName in STAT_AGG_SQL;
  if (aggregateOfType) {
    const argList = orderedCallArgs(call.args);
    // Empty-set short-circuit: EdgeQL aggregates over the empty set have
    // defined identities. Without this, e.g. `array_agg(<int64>{})` would
    // compile to `json_group_array` over a single-row `SELECT NULL` and
    // produce `[null]` instead of the correct `[]`.
    if (argList.length === 1 && deps.isTopLevelEmptySetMarker(argList[0].expr)) {
      if (shortName === "count") return "0";
      if (shortName === "sum") return "0";
      if (shortName === "array_agg") return "json('[]')";
      if (shortName === "all") return "json('true')";
      if (shortName === "any") return "json('false')";
      if (shortName === "min" || shortName === "max" || shortName === "avg") return "NULL";
      // Statistical aggregates raise "not enough elements" on the empty set —
      // run the aggregate over zero rows so its finalizer throws.
      if (shortName in STAT_AGG_SQL) {
        return `(SELECT ${STAT_AGG_SQL[shortName]}(${quoteIdent("value")}) FROM (SELECT NULL AS ${quoteIdent("value")} WHERE 0))`;
      }
    }
    if (shortName === "count" && argList.length === 1) {
      // Correlated count over a link/backlink anchored at the current row
      // (`count(.owners)` in a shape): count the same correlated row set the
      // link shape projection uses. compileCountOfSetSQL below compiles the
      // pointer as a free-standing set, which would count every link in the
      // table for every row.
      const countArg = deps.unwrapSelectExprSet(argList[0].expr);
      const hasClauses = countArg.selectExpr
        && (countArg.selectExpr.where || countArg.selectExpr.limit || countArg.selectExpr.offset);
      const countPtrAnchorsRow = (): boolean => {
        if (countArg.result.expr.kind !== "pointer" || countArg.result.typeref.isScalar) return false;
        let ptrSource: Set = (countArg.result.expr as Pointer).source;
        while (ptrSource.expr.kind === "select_expr") {
          const se = ptrSource.expr as SelectExpr;
          // A filtered/clamped source (`(SELECT User FILTER …).<owner`)
          // is its own row set, not the current row — counting it as a
          // correlated link would reference an alias that doesn't exist.
          if (se.where || se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) return false;
          ptrSource = se.result;
        }
        return ptrSource.expr.kind === "type_root" || deps.pickSourcePathAlias(ptrSource, options) !== null;
      };
      if (!hasClauses && countPtrAnchorsRow()) {
        const arr = deps.compilePointerArrayExpr(
          deps.resetPointerSourceToRoot(countArg.result.expr as Pointer),
          sourceAlias,
          [],
          params,
          options,
          target,
          1,
          undefined,
          deps.narrowedLinkTarget(countArg.result),
        );
        return `json_array_length(${arr})`;
      }
      const countSql = compileCountOfSetSQL(argList[0].expr, params, target, options, deps);
      if (countSql) {
        return countSql;
      }
      params.length = checkpoint;
    }
    if (argList.length === 1 && argList[0].expr.expr.kind === "type_root") {
      const root = argList[0].expr.expr as TypeRoot;
      const fromSql = deps.compilePolymorphicSource(root.typeref, root.skipSubtypes, "g_agg", ["id"], options);
      if (shortName === "count") {
        return `(SELECT count(*) FROM ${fromSql})`;
      }
      // `array_agg(User)` — aggregate the rows' identity objects.
      if (shortName === "array_agg") {
        return `(SELECT COALESCE(json_group_array(json_object(${quoteLiteral("id")}, g_agg.${quoteIdent("id")})), '[]') FROM ${fromSql})`;
      }
      // sum/min/max/avg over a bare type_root have no value column, so they
      // would aggregate over `id` which isn't useful — fall through to null
      // so the caller can reject the query.
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
      const correlated = deps.tryCompileCorrelatedScalarPointerPathScalarSelect(pathSet, sourceAlias, options);
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
          : shortName in STAT_AGG_SQL
            ? `${STAT_AGG_SQL[shortName]}(${quoteIdent("value")})`
            : shortName === "sum"
              // EdgeQL `sum` has identity 0 over the (runtime-)empty set;
              // SQL `sum` over zero rows is NULL.
              ? `IFNULL(sum(${quoteIdent("value")}), 0)`
              : `${shortName}(${quoteIdent("value")})`;
        return `(SELECT ${sqlAgg} FROM (${inner}))`;
      }
      const innerCheckpoint = params.length;
      const scalarSql = deps.compileScalarSelectSQL(argList[0].expr, params, target, options);
      if (scalarSql) {
        if (shortName === "all") {
          return `(SELECT IFNULL(min(${quoteIdent("value")}), json('true')) FROM (${scalarSql}) WHERE ${quoteIdent("value")} IS NOT NULL)`;
        }
        if (shortName === "any") {
          return `(SELECT IFNULL(max(${quoteIdent("value")}), json('false')) FROM (${scalarSql}) WHERE ${quoteIdent("value")} IS NOT NULL)`;
        }
        const sqlAgg = shortName === "array_agg"
          ? `json_group_array(${deps.setValueIsJson(argList[0].expr) ? `json(${quoteIdent("value")})` : quoteIdent("value")})`
          : shortName in STAT_AGG_SQL
            ? `${STAT_AGG_SQL[shortName]}(${quoteIdent("value")})`
            : shortName === "sum"
              // EdgeQL `sum` identity is 0 over the runtime-empty set.
              ? `IFNULL(sum(${quoteIdent("value")}), 0)`
              : `${shortName}(${quoteIdent("value")})`;
        return `(SELECT ${sqlAgg} FROM (${scalarSql}))`;
      }
      params.length = innerCheckpoint;
    }
  }

  // `to_duration(hours := …, minutes := …, …)` — named-only params reach the
  // IR keyed by name; compile each named slot in declaration order so SQL
  // text order matches the params array.
  if (shortName === "to_duration") {
    const slots = ["hours", "minutes", "seconds", "microseconds"];
    const pieces: string[] = [];
    let ok = true;
    for (const slot of slots) {
      const ca = (call.args as Record<string, CallArg | undefined>)[slot];
      if (!ca) { pieces.push("0"); continue; }
      const v = deps.compileValueSetSQL(ca.expr, sourceAlias, params, target, options, linkPropertyAlias);
      if (!v) { ok = false; break; }
      pieces.push(v);
    }
    if (ok) return `_gel_to_duration(${pieces.join(", ")})`;
    params.length = checkpoint;
  }

  const args = orderedCallArgs(call.args)
    .map((arg) => deps.compileValueSetSQL(arg.expr, sourceAlias, params, target, options, linkPropertyAlias));
  if (args.some((arg) => !arg)) {
    params.length = checkpoint;
    return null;
  }

  // `contains(array, element)` is element containment, not the substring
  // test the string template performs — branch on the arg's type here where
  // the typeref is visible (templates only see SQL strings).
  if (shortName === "contains" && args.length === 2) {
    const callArgList = orderedCallArgs(call.args);
    if (callArgList[0].expr.typeref?.collection === "array") {
      return `(CASE WHEN EXISTS (SELECT 1 FROM json_each(${args[0]}) WHERE ${quoteIdent("value")} = ${args[1]}) THEN json('true') ELSE json('false') END)`;
    }
    if (setLooksLikeRange(callArgList[0].expr)) {
      return `(CASE _gel_range_contains(${args[0]}, ${args[1]}) WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE NULL END)`;
    }
  }

  // `range(lower, upper, named only inc_lower, inc_upper)` — integer-typed
  // bounds produce a discrete range (canonicalized to [lower, upper) like
  // Postgres). `inc_lower`/`inc_upper` are NAMED-ONLY parameters, so map each
  // argument to its `_gel_range` slot by its `call.args` key rather than by
  // sorted position — otherwise `inc_upper := true` on its own lands in the
  // `inc_lower` slot and the upper bound is wrongly read as exclusive.
  if (shortName === "range" && args.length >= 1 && args.length <= 4) {
    // `args` is parallel to the key-sorted `orderedCallArgs`, so recover the
    // key→SQL mapping by zipping the same sort back together.
    const sqlByKey: Record<string, string> = {};
    Object.keys(call.args)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .forEach((key, i) => { sqlByKey[key] = args[i] as string; });
    // Discrete range types canonicalize to inclusive-lower / exclusive-upper
    // (like Postgres `int4range`/`daterange`): the integer families and
    // `cal::local_date` (dates step by whole days). `datetime`/`local_datetime`
    // are continuous and keep their bounds verbatim.
    const isDiscreteTypeHint = (hint: string): boolean =>
      hint.endsWith("::int16") || hint.endsWith("::int32") || hint.endsWith("::int64")
      || hint.endsWith("::local_date");
    const exprIsIntLiteral = (s: Set): boolean => {
      let cur = s;
      while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
      return cur.expr.kind === "integer_constant";
    };
    const discrete = (["0", "1"] as const).some((key) => {
      const arg = call.args[key];
      if (!arg) return false;
      const hint = scalarArgTypeHint(arg.expr);
      return (hint !== undefined && isDiscreteTypeHint(hint)) || exprIsIntLiteral(arg.expr);
    });
    const lower = sqlByKey["0"] ?? "NULL";
    const upper = sqlByKey["1"] ?? "NULL";
    const incLower = sqlByKey["inc_lower"] ?? "NULL";
    const incUpper = sqlByKey["inc_upper"] ?? "NULL";
    return `_gel_range(${lower}, ${upper}, ${incLower}, ${incUpper}, ${discrete ? 1 : 0})`;
  }

  const lowered = lowerStdlibFunctionSql(
    target,
    call.functionName,
    args as string[],
    orderedCallArgs(call.args).map((arg) => scalarArgTypeHint(arg.expr)),
  );
  if (lowered) {
    // Bool-returning stdlib functions surface native SQL booleans (0/1) from
    // their templates; the value layer expects JSON booleans (the same shape
    // operator comparisons emit). Normalize once here — the predicate path
    // re-normalizes truthiness on its side. The one-row subquery binds the
    // lowered expression once so its `?` params aren't consumed twice.
    // (call.typeref is often `std::anytype` — stdlib return types aren't
    // inferred — so consult the explicit name list as well.)
    if (deps.qualifyTypeName(call.typeref) === "std::bool" || BOOL_RETURNING_STDLIB.has(shortName)) {
      return `(SELECT CASE WHEN p IS NULL THEN NULL WHEN p = json('true') THEN json('true') WHEN p = json('false') THEN json('false') WHEN p THEN json('true') ELSE json('false') END FROM (SELECT (${lowered}) AS p))`;
    }
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
    const bodySql = deps.compileValueSetSQL(call.body, sourceAlias, params, target, options, linkPropertyAlias);
    if (bodySql) {
      return bodySql;
    }
    params.length = checkpoint;
  }
  return null;
};
