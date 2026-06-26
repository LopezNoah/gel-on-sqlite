// Set-level nullable-operator lowering — the SQL algebra for EdgeQL's
// set-level `??` coalesce and `?=` / `?!=` optional comparison. These operators
// lower by distributing nullability across union branches (empty-side fallbacks,
// shared-LCP iteration, correlated multi-link probes), a self-contained ~600-line
// concern lifted verbatim out of gel_ir_compiler.ts so it has a name and a test
// surface (architecture review round 10 / ADR 0051). The functions are mutually
// recursive with the value/predicate/source dispatchers, so they reach those —
// and a handful of pure collectors — through the injected `SqlLoweringContext`
// seam (ADR 0006), keeping the no-cycle discipline. Bodies are byte-identical to
// the originals; each destructures `deps` at the top.
import { quoteIdent } from "../codegen/sql.js";
import type { RuntimeTarget } from "../runtime/target.js";
import type { ScalarValue } from "../types.js";
import type { GelIRCompileOptions } from "./compiler_types.js";
import type { SqlLoweringContext } from "./function_lowering.js";
import type {
  BaseConstant,
  CoalesceExpr,
  OperatorCall,
  Pointer,
  SelectExpr,
  Set,
  TypeCast,
  TypeRef,
} from "../ir/gel_ir.js";

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
  deps: SqlLoweringContext,
): SetLevelSideDescriptor | null => {
  const {
    compileSelectSource, collectScalarPointerSources, collectInnerWhereClauses,
    compileValueSetSQL, collectReferencedColumns, compilePolymorphicSource,
    compilePredicateSetSQL, orderedCallArgs,
  } = deps;
  const expr = set.expr;

  if (expr.kind === "type_cast") {
    const inner = (expr as TypeCast).expr;
    const innerExprKind = inner.expr.kind;
    if ((innerExprKind === "string_constant" || innerExprKind === "integer_constant"
      || innerExprKind === "float_constant" || innerExprKind === "boolean_constant")
      && (inner.expr as BaseConstant).value === null) {
      return { kind: "always-empty" };
    }
    return describeSetLevelSide(inner, params, target, options, deps);
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

  // Object-typed side (`Issue.time_spent_log`, a WITH-bound `LOG1`): EdgeDB
  // `?=`/`?!=` on objects compares by identity, so describe the set as a
  // subquery of its row ids. compileSelectSource handles select_expr
  // wrappers (WITH bindings carry their FILTER inline), pointer chains, and
  // type roots uniformly.
  if (set.typeref && set.typeref.isScalar === false && !set.typeref.collection
      && (expr.kind === "pointer" || expr.kind === "select_expr" || expr.kind === "type_root")) {
    const paramsCheckpoint = params.length;
    const source = compileSelectSource(set, undefined, undefined, options, params, target, "oc0");
    if (source) {
      return {
        kind: "subquery",
        selectSQL: `SELECT ${source.alias}.${quoteIdent("id")} AS v FROM ${source.sql}`,
        valueColumn: "v",
      };
    }
    params.length = paramsCheckpoint;
    return null;
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

// Correlated set-level `?=` / `?!=` whose LHS is a multi link hanging off
// the outer iteration row (`log1 := Issue.time_spent_log ?= LOG1` inside an
// Issue shape). Emits a row set (column `v`, text 'true'/'false') per outer
// row: one row per LHS×RHS element pair, with the standard optional-compare
// empty fallbacks (an empty side acts as a single absent value). The LHS
// link probe is parameterless so repeating it is safe; the RHS lives in a
// CTE so its parameters appear exactly once.
export const compileCorrelatedOptionalCompareRows = (
  op: "?=" | "?!=",
  lhsPointer: Pointer,
  sourceAlias: string,
  rhs: Set,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const { shouldUseLinkTable, linkTableNameForPointer } = deps;
  if (lhsPointer.direction !== "outbound"
      || lhsPointer.ptrref.outTarget.isScalar
      || !shouldUseLinkTable(lhsPointer)) {
    return null;
  }
  const paramsCheckpoint = params.length;
  const rhsDesc = describeSetLevelSide(rhs, params, target, options, deps);
  if (!rhsDesc || rhsDesc.kind !== "subquery") {
    params.length = paramsCheckpoint;
    return null;
  }
  const linkTable = quoteIdent(linkTableNameForPointer(lhsPointer, options));
  const lhsRows = `SELECT lt.${quoteIdent("target")} AS v FROM ${linkTable} lt WHERE lt.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")}`;
  const lhsExists = `EXISTS (SELECT 1 FROM ${linkTable} lt WHERE lt.${quoteIdent("source")} = ${sourceAlias}.${quoteIdent("id")})`;
  const cmp = op === "?="
    ? `CASE WHEN lhs_r.v IS rhs_r.${rhsDesc.valueColumn} THEN 'true' ELSE 'false' END`
    : `CASE WHEN lhs_r.v IS NOT rhs_r.${rhsDesc.valueColumn} THEN 'true' ELSE 'false' END`;
  const oneEmpty = op === "?=" ? "'false'" : "'true'";
  const bothEmpty = op === "?=" ? "'true'" : "'false'";
  return `WITH rhs_r AS (${rhsDesc.selectSQL})`
    + ` SELECT ${cmp} AS v FROM (${lhsRows}) lhs_r CROSS JOIN rhs_r`
    + ` UNION ALL SELECT ${oneEmpty} AS v FROM rhs_r WHERE NOT ${lhsExists}`
    + ` UNION ALL SELECT ${oneEmpty} AS v FROM (${lhsRows}) lhs_r WHERE NOT EXISTS (SELECT 1 FROM rhs_r)`
    + ` UNION ALL SELECT ${bothEmpty} AS v WHERE NOT ${lhsExists} AND NOT EXISTS (SELECT 1 FROM rhs_r)`;
};

// When LHS and RHS of `??` share no LCP (no common type_root), EdgeDB
// semantics says: empty LHS → return RHS as a singleton; non-empty LHS →
// return LHS values (NULL-valued pointer leaves are excluded from the set).
// Emits SQL of the form:
//   SELECT lhs AS value FROM src WHERE inner_filter AND lhs IS NOT NULL
//   UNION ALL
//   SELECT rhs AS value WHERE NOT EXISTS (SELECT 1 FROM src WHERE inner_filter AND lhs IS NOT NULL)
// Returns null if the pattern doesn't match.
export const tryCompileSetLevelCoalesceSQL = (
  coalesce: CoalesceExpr,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  // Outer FILTER clauses (`SELECT lhs ?? rhs FILTER pred`). They iterate
  // with the same binding as the LHS: applied per LHS row in the LHS branch,
  // and evaluated once against an all-NULL LHS binding in the empty-LHS
  // fallback branch. The NOT EXISTS probe stays filter-free — it tests
  // emptiness of the LHS *path*, not of the filtered result.
  outerWheres: Set[] = [],
  deps: SqlLoweringContext,
): string | null => {
  const {
    collectTypeRootIds, pathIdKey, orderedCallArgs, collectScalarPointerSources,
    collectInnerWhereClauses, compileValueSetSQL, collectReferencedColumns,
    compilePolymorphicSource, compilePredicateSetSQL, referencesUnboundAlias,
    compileScalarSelectSQL,
  } = deps;
  // Only BARE (unfenced) roots establish a common scoped path: a fenced
  // `(SELECT Issue FILTER …)` prefix contributes no factorable root, so
  // `(SELECT Issue FILTER …).te ?? {Issue.te, -1}` still has set-level
  // semantics (dependent_09).
  const lhsRoots = new globalThis.Set<string>();
  const rhsRoots = new globalThis.Set<string>();
  collectTypeRootIds(coalesce.left, lhsRoots, true);
  collectTypeRootIds(coalesce.right, rhsRoots, true);
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

  // Unwrap a top-level select_expr fence on the LHS
  // (`(SELECT expr FILTER …) ?? rhs`). collectScalarPointerSources only
  // unwraps select_expr while walking a pointer's source, so a top-level
  // fence would leave lhsFrom null while compileValueSetSQL still emits
  // g0-anchored SQL. The fence's WHERE must apply both to the LHS rows and
  // to the NOT EXISTS probe, so collect it into the LHS WHERE clauses.
  let lhsSet = coalesce.left;
  const lhsFenceWheres: Set[] = [];
  while (lhsSet.expr.kind === "select_expr") {
    const se = lhsSet.expr as SelectExpr;
    // Unwrapping would silently drop ORDER BY / LIMIT / OFFSET — stop.
    if ((se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) break;
    if (se.where) lhsFenceWheres.push(se.where);
    lhsSet = se.result;
  }

  const lhsSources = new Map<string, TypeRef>();
  collectScalarPointerSources(lhsSet, lhsSources);
  if (lhsSources.size > 1) return null;
  const lhsTypeRef = lhsSources.size === 1 ? lhsSources.values().next().value : undefined;
  const lhsWheres = [...lhsFenceWheres, ...collectInnerWhereClauses(lhsSet)];

  const paramsStart = params.length;
  const lhsSql = compileValueSetSQL(lhsSet, "g0", params, target, options);
  if (!lhsSql) {
    params.length = paramsStart;
    return null;
  }
  const projectedColumns = [...new globalThis.Set([
    "id",
    ...collectReferencedColumns(lhsSet),
    ...lhsFenceWheres.flatMap((w) => collectReferencedColumns(w)),
  ])];
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

  // Compile the outer FILTER clauses against the same g0 binding as the LHS.
  const outerStart = params.length;
  const outerParts: string[] = [];
  for (const w of outerWheres) {
    const compiled = compilePredicateSetSQL(w, "g0", params, target, options)
      ?? compileValueSetSQL(w, "g0", params, target, options);
    if (!compiled) {
      params.length = paramsStart;
      return null;
    }
    outerParts.push(compiled);
  }
  const outerWhereSql = outerParts.join(" AND ");
  const outerParams = params.slice(outerStart);
  // In the fallback branch there is no g0 row — bind g0 to a single all-NULL
  // stub row so the filter evaluates against an empty LHS binding.
  let fallbackOuterFrom = "";
  if (outerWhereSql && outerWhereSql.includes("g0.")) {
    const stubCols = [...new globalThis.Set([
      "id",
      ...outerWheres.flatMap((w) => collectReferencedColumns(w)),
    ])];
    fallbackOuterFrom = ` CROSS JOIN (SELECT ${stubCols.map((c) => `NULL AS ${quoteIdent(c)}`).join(", ")}) g0`;
  }
  const fallbackOuterWhere = outerWhereSql ? `${outerWhereSql} AND ` : "";

  // Shared-LCP shared-path shortcut: `X ?? {X, …}`. When LHS produces rows,
  // the LHS-identical RHS arg is redundant; but when LHS is empty, the
  // remaining RHS union args must still be emitted as fallback rows.
  if (lhsAppearsInRhsUnion) {
    if (!lhsFrom) {
      params.length = paramsStart;
      return null;
    }
    const shortcutLhsKey = pathIdKey(coalesce.left);
    const shortcutUnionArgs = orderedCallArgs((rhsExprForShortcut as OperatorCall).args);
    const remainderArgs = shortcutUnionArgs.filter((arg) => pathIdKey(arg.expr) !== shortcutLhsKey);
    if (remainderArgs.length === 0) {
      // RHS is exactly {X} — the fallback adds nothing; WHERE appears once,
      // and its params are already in `params`.
      return `SELECT ${lhsSql} AS ${quoteIdent("value")} FROM ${lhsFrom} WHERE ${lhsWhereSql}${outerWhereSql ? ` AND ${outerWhereSql}` : ""}`;
    }
    const remainderSqls: string[] = [];
    for (const arg of remainderArgs) {
      const argRoots = new globalThis.Set<string>();
      collectTypeRootIds(arg.expr, argRoots);
      if (argRoots.size > 0) {
        // Fallback rows are emitted FROM-less; source-anchored args would
        // reference an unbound alias — bail to other strategies.
        params.length = paramsStart;
        return null;
      }
      const argSql = compileValueSetSQL(arg.expr, "g0", params, target, options);
      if (!argSql) {
        params.length = paramsStart;
        return null;
      }
      remainderSqls.push(argSql);
    }
    const fallbackRowsSql = remainderSqls
      .map((value) => `SELECT ${value} AS ${quoteIdent("value")}`)
      .join(" UNION ALL ");
    params.push(...outerParams);
    params.push(...whereParams);
    return `SELECT ${lhsSql} AS ${quoteIdent("value")} FROM ${lhsFrom} WHERE ${lhsWhereSql}${outerWhereSql ? ` AND ${outerWhereSql}` : ""}`
      + ` UNION ALL `
      + `SELECT ${quoteIdent("value")} FROM (${fallbackRowsSql})${fallbackOuterFrom} WHERE ${fallbackOuterWhere}NOT EXISTS (SELECT 1 FROM ${lhsFrom} WHERE ${lhsWhereSql})`;
  }

  // If RHS is a set built via `union`, expand each element as its own fallback
  // row so `?? {-1, -2}` yields the two values, not a single JSON array.
  const rhsExpr = coalesce.right.expr;
  let rhsRowsSql: string | null = null;
  if (rhsExpr.kind === "operator_call" && (rhsExpr as OperatorCall).operator === "union") {
    const unionArgs = orderedCallArgs((rhsExpr as OperatorCall).args);
    const unionCheckpoint = params.length;
    const elementParts: string[] = [];
    let unionOk = true;
    for (const arg of unionArgs) {
      const argCheckpoint = params.length;
      const elSql = compileValueSetSQL(arg.expr, "g0", params, target, options);
      if (elSql && !referencesUnboundAlias(elSql, "g0", options)) {
        elementParts.push(`SELECT ${elSql} AS ${quoteIdent("value")}`);
        continue;
      }
      // Source-anchored arg (`?? {Issue.time_estimate, -1}` with an empty
      // LHS): the fallback rows have no g0 binding, so compile the arg as a
      // self-contained row set instead.
      params.length = argCheckpoint;
      const argRows = compileScalarSelectSQL(arg.expr, params, target, options);
      if (!argRows) {
        unionOk = false;
        break;
      }
      elementParts.push(`SELECT ${quoteIdent("value")} FROM (${argRows}) WHERE ${quoteIdent("value")} IS NOT NULL`);
    }
    if (unionOk) {
      rhsRowsSql = elementParts.join(" UNION ALL ");
    } else {
      params.length = unionCheckpoint;
    }
  }

  if (!rhsRowsSql) {
    const rhsValueCheckpoint = params.length;
    const rhsSql = compileValueSetSQL(coalesce.right, "g0", params, target, options);
    if (rhsSql && !referencesUnboundAlias(rhsSql, "g0", options)) {
      rhsRowsSql = `SELECT ${rhsSql} AS ${quoteIdent("value")}`;
    } else {
      // Set-producing RHS (`?? [User]`, `?? Type.ptr`) — one fallback row
      // per element, via the row-set compiler.
      params.length = rhsValueCheckpoint;
      rhsRowsSql = compileScalarSelectSQL(coalesce.right, params, target, options);
      if (!rhsRowsSql) {
        params.length = paramsStart;
        return null;
      }
    }
  }

  // The fallback rows are emitted without a g0 binding in scope — a
  // g0-anchored RHS would reference an unbound alias.
  if (referencesUnboundAlias(rhsRowsSql, "g0", options)) {
    params.length = paramsStart;
    return null;
  }

  if (lhsFrom) {
    params.push(...outerParams);
    params.push(...whereParams);
    return `SELECT ${lhsSql} AS ${quoteIdent("value")} FROM ${lhsFrom} WHERE ${lhsWhereSql}${outerWhereSql ? ` AND ${outerWhereSql}` : ""}`
      + ` UNION ALL `
      + `SELECT ${quoteIdent("value")} FROM (${rhsRowsSql})${fallbackOuterFrom} WHERE ${fallbackOuterWhere}NOT EXISTS (SELECT 1 FROM ${lhsFrom} WHERE ${lhsWhereSql})`;
  }

  // LHS has no polymorphic source — it's a literal/parameter/scalar
  // expression whose lhsSql may itself carry placeholders. Wrap it in a
  // CTE so lhsSql appears only once. The `IS NOT NULL` check is moved
  // outside the CTE (testing the projected `value` column) so we don't
  // need to repeat lhsSql, and the empty-LHS fallback can detect via
  // `NOT EXISTS … WHERE value IS NOT NULL`.
  // No lhsFrom: the CTE has no FROM, so a g0-anchored LHS (e.g. a type-root
  // value whose sources weren't collected) would reference an unbound alias.
  if (referencesUnboundAlias(lhsSql, "g0", options)) {
    params.length = paramsStart;
    return null;
  }
  // The CTE form has no g0 binding to attach outer FILTER clauses to — let
  // the generic FROM-based emit carry them instead.
  if (outerWheres.length > 0) {
    params.length = paramsStart;
    return null;
  }
  const innerWhereSqlNoNullCheck = whereParts.slice(0, -1).join(" AND ");
  const cteWhereClause = innerWhereSqlNoNullCheck ? ` WHERE ${innerWhereSqlNoNullCheck}` : "";
  return `WITH lhs_q AS (SELECT ${lhsSql} AS ${quoteIdent("value")}${cteWhereClause})`
    + ` SELECT ${quoteIdent("value")} FROM lhs_q WHERE ${quoteIdent("value")} IS NOT NULL`
    + ` UNION ALL `
    + `SELECT ${quoteIdent("value")} FROM (${rhsRowsSql}) WHERE NOT EXISTS (SELECT 1 FROM lhs_q WHERE ${quoteIdent("value")} IS NOT NULL)`;
};

export const tryCompileSetLevelOptionalCompareSQL = (
  call: OperatorCall,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  // Outer FILTER clauses. Only the shared-LCP branch (which iterates a g0
  // source) can attach them; the other branches bail so the generic emit
  // carries the filter.
  outerWheres: Set[] = [],
  deps: SqlLoweringContext,
): string | null => {
  const {
    orderedCallArgs, collectTypeRootIds, pathIdKey, collectPathIdKeys,
    compileSelectSource, collectScalarPointerSources, collectReferencedColumns,
    compilePolymorphicSource, compileValueSetSQL, collectInnerWhereClauses,
    compilePredicateSetSQL, shouldUseLinkTable, columnForPointer,
    compileScalarSelectSQL, referencesUnboundAlias,
  } = deps;
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
    // Synthetic pathIds (`cast:str`, `fn:count`, …) are NOT identities —
    // `<str>Publication.id` and `<str>count(Publication)` share the same
    // degenerate `cast:str` pathId without being the same path (set_of_03).
    const isConcretePath = (s: Set): boolean => {
      const pid = s.pathId as { isPointerPath?: boolean; steps?: { type?: { inSchema?: boolean } }[] } | undefined;
      if (!pid) return false;
      if (pid.isPointerPath) return true;
      return pid.steps?.[0]?.type?.inSchema === true;
    };
    // For a synthetic-key side, fall back to structural containment: the
    // other side must literally embed a structurally identical copy
    // (`((I.te,).0,).0 ?= (I.te,).0`).
    // Compare expr structure ignoring `pathId`: a pathId is set *identity*, not
    // structure, and a synthetic set (constant, …) carries a unique
    // `__derived__::expr~N` id, so two structurally-identical occurrences (the
    // two `{I.te} = 0` copies in dependent_20) have different ids. Strip them so
    // the structural match still holds.
    const exprStructure = (expr: unknown): string =>
      JSON.stringify(expr, (key, value) => (key === "pathId" ? undefined : value));
    const containsStructuralCopy = (haystack: Set, needle: Set): boolean => {
      const needleJson = exprStructure(needle.expr);
      let found = false;
      const walk = (o: unknown, depth: number): void => {
        if (found || !o || typeof o !== "object" || depth > 24) return;
        const obj = o as { kind?: string; expr?: unknown };
        if (obj.kind === "set" && obj.expr && exprStructure(obj.expr) === needleJson) {
          found = true;
          return;
        }
        for (const v of Object.values(obj)) {
          if (v && typeof v === "object") walk(v, depth + 1);
        }
      };
      walk(haystack, 0);
      return found;
    };
    // Does one side's path appear within the other? A CONCRETE path (object /
    // pointer — a real schema path id) is matched by path-id identity. A
    // SYNTHETIC side (constant, operator/cast result) has a unique
    // `__derived__::expr~N` id per occurrence, so identity would never match two
    // structurally-equal copies — match those structurally (pathId-agnostic)
    // instead. Previously both arms also required a path-id-key hit, which only
    // held because synthetic sets used to share a degenerate placeholder id.
    const lhsKey = pathIdKey(lhs);
    const rhsKey = pathIdKey(rhs);
    const rhsKeys = new globalThis.Set<string>();
    collectPathIdKeys(rhs, rhsKeys);
    const lhsKeys = new globalThis.Set<string>();
    collectPathIdKeys(lhs, lhsKeys);
    const lhsAppearsInRhs = isConcretePath(lhs)
      ? rhsKeys.has(lhsKey)
      : containsStructuralCopy(rhs, lhs);
    const rhsAppearsInLhs = isConcretePath(rhs)
      ? lhsKeys.has(rhsKey)
      : containsStructuralCopy(lhs, rhs);
    if (!lhsAppearsInRhs && !rhsAppearsInLhs) return null;

    // `X ?= X` / `X ?!= X` on an OBJECT set: identity compare of each
    // element with itself — TRUE per row for ?= (FALSE for ?!=), and the
    // both-empty fallback carries the same value (set_of_12, self compare).
    if (lhsKey === rhsKey
        && JSON.stringify(lhs.expr) === JSON.stringify(rhs.expr)
        && lhs.typeref && lhs.typeref.isScalar === false && !lhs.typeref.collection) {
      const selfCkpt = params.length;
      const src = compileSelectSource(lhs, undefined, undefined, options, params, target, "oc_self");
      if (src) {
        const srcParams = params.slice(selfCkpt);
        const val = op === "?=" ? "json('true')" : "json('false')";
        params.push(...srcParams);
        return `SELECT ${val} AS ${quoteIdent("value")} FROM ${src.sql}`
          + ` UNION ALL SELECT ${val} AS ${quoteIdent("value")} WHERE NOT EXISTS (SELECT 1 FROM ${src.sql})`;
      }
      params.length = selfCkpt;
    }

    const lcp = lhsAppearsInRhs ? lhs : rhs;
    const sources = new Map<string, TypeRef>();
    collectScalarPointerSources(lcp, sources);
    if (sources.size !== 1) return null;
    const typeRef = sources.values().next().value;
    if (!typeRef) return null;
    const refs: string[] = ["id"];
    for (const c of collectReferencedColumns(lhs)) refs.push(c);
    for (const c of collectReferencedColumns(rhs)) refs.push(c);
    const projectedColumns = Array.from(new globalThis.Set(refs));
    const sourceSql = compilePolymorphicSource(typeRef, false, "g0", projectedColumns, options);
    const ckpt = params.length;
    const lhsSql = compileValueSetSQL(lhs, "g0", params, target, options);
    const rhsSql = compileValueSetSQL(rhs, "g0", params, target, options);
    const lcpStart = params.length;
    const lcpSql = compileValueSetSQL(lcp, "g0", params, target, options);
    if (!lhsSql || !rhsSql || !lcpSql) {
      params.length = ckpt;
      return null;
    }
    // The LCP's own fence WHEREs (`I := (SELECT Issue FILTER …) … I.te ?=
    // I.te * 2`) restrict the iteration — without them the scan ranges over
    // the whole type (dependent_20).
    const innerStart = params.length;
    const innerParts: string[] = [];
    for (const w of collectInnerWhereClauses(lcp)) {
      const compiled = compilePredicateSetSQL(w, "g0", params, target, options)
        ?? compileValueSetSQL(w, "g0", params, target, options);
      if (!compiled) {
        params.length = ckpt;
        return null;
      }
      innerParts.push(compiled);
    }
    const iterParams = params.slice(lcpStart, innerStart).concat(params.slice(innerStart));
    const iterWhereSql = [`${lcpSql} IS NOT NULL`, ...innerParts].join(" AND ");
    const compareSqlExpr = (op === "?=")
      ? `(CASE WHEN ${lhsSql} IS ${rhsSql} THEN json('true') ELSE json('false') END)`
      : `(CASE WHEN ${lhsSql} IS NOT ${rhsSql} THEN json('true') ELSE json('false') END)`;
    const outerParts: string[] = [];
    for (const w of outerWheres) {
      const compiled = compilePredicateSetSQL(w, "g0", params, target, options)
        ?? compileValueSetSQL(w, "g0", params, target, options);
      if (!compiled) {
        params.length = ckpt;
        return null;
      }
      outerParts.push(compiled);
    }
    const outerSql = outerParts.length > 0 ? ` AND ${outerParts.join(" AND ")}` : "";
    const mainSql = `SELECT ${compareSqlExpr} AS ${quoteIdent("value")} FROM ${sourceSql} WHERE ${iterWhereSql}${outerSql}`;
    if (outerParts.length > 0) {
      // With an outer FILTER, the empty-iteration fallback row's filter
      // semantics are ambiguous here — keep the pre-existing no-fallback form.
      return mainSql;
    }
    // Empty iteration (the LCP set has no values): both sides are empty,
    // so `?=` yields one TRUE row and `?!=` one FALSE row.
    const emptyVal = op === "?=" ? "json('true')" : "json('false')";
    params.push(...iterParams);
    return `${mainSql} UNION ALL SELECT ${emptyVal} AS ${quoteIdent("value")} WHERE NOT EXISTS (SELECT 1 FROM ${sourceSql} WHERE ${iterWhereSql})`;
  }

  // The remaining branches have no per-row source binding to attach outer
  // FILTER clauses to — let the generic FROM-based emit carry them.
  if (outerWheres.length > 0) return null;

  // Both sides are scalar-pointer leaves off the SAME single source set
  // (`x.name ?= x.body` where x binds `array_unpack(<array<Issue>>[])`):
  // iterate the source rows once, project both leaves per row, and emit the
  // empty-source fallback (both sides empty → `?=` true / `?!=` false).
  // Gated to sources with no type roots — type-root-anchored paths take the
  // shared-LCP branch above or the generic anchor strategies downstream.
  if (lhs.expr.kind === "pointer" && rhs.expr.kind === "pointer") {
    const lhsPtr = lhs.expr as Pointer;
    const rhsPtr = rhs.expr as Pointer;
    const srcRoots = new globalThis.Set<string>();
    collectTypeRootIds(lhsPtr.source, srcRoots);
    const sourceTyperef = lhsPtr.source.typeref;
    if (srcRoots.size === 0
        && JSON.stringify(lhsPtr.source) === JSON.stringify(rhsPtr.source)
        && lhsPtr.direction === "outbound" && rhsPtr.direction === "outbound"
        && lhsPtr.ptrref.outTarget.isScalar && rhsPtr.ptrref.outTarget.isScalar
        && !lhsPtr.ptrref.isLinkProperty && !rhsPtr.ptrref.isLinkProperty
        && !shouldUseLinkTable(lhsPtr) && !shouldUseLinkTable(rhsPtr)
        && sourceTyperef.inSchema && !sourceTyperef.isScalar) {
      const ckpt = params.length;
      const idRows = compileScalarSelectSQL(lhsPtr.source, params, target, options);
      if (idRows) {
        const lhsColumn = columnForPointer(lhsPtr);
        const rhsColumn = columnForPointer(rhsPtr);
        const projected = [...new globalThis.Set(["id", lhsColumn, rhsColumn])];
        const objSrc = compilePolymorphicSource(sourceTyperef, false, "g_osrc", projected, options);
        const cmp = op === "?="
          ? `CASE WHEN l IS r THEN json('true') ELSE json('false') END`
          : `CASE WHEN l IS NOT r THEN json('true') ELSE json('false') END`;
        const emptyVal = op === "?=" ? "json('true')" : "json('false')";
        return `WITH osrc AS (SELECT g_osrc.${quoteIdent(lhsColumn)} AS l, g_osrc.${quoteIdent(rhsColumn)} AS r`
          + ` FROM (${idRows}) src_ids JOIN ${objSrc} ON g_osrc.${quoteIdent("id")} = src_ids.${quoteIdent("value")})`
          + ` SELECT ${cmp} AS ${quoteIdent("value")} FROM osrc`
          + ` UNION ALL SELECT ${emptyVal} AS ${quoteIdent("value")} WHERE NOT EXISTS (SELECT 1 FROM osrc)`;
      }
      params.length = ckpt;
    }
  }

  const paramsStart = params.length;
  // When the structural descriptor doesn't recognise a side (a cast of an
  // aggregate, `<int64>I2.number * 30`, …), fall back to compiling it as a
  // self-contained row set — the sides share no roots here, so whole-set
  // cross-product semantics are exactly right (dependent_16/17, set_of_03).
  const describeOrRows = (side: Set): SetLevelSideDescriptor | null => {
    const d = describeSetLevelSide(side, params, target, options, deps);
    if (d) return d;
    const ckpt = params.length;
    const rows = compileScalarSelectSQL(side, params, target, options);
    if (rows && !referencesUnboundAlias(rows, "g0", options)) {
      return {
        kind: "subquery",
        selectSQL: `SELECT ${quoteIdent("value")} AS v FROM (${rows}) WHERE ${quoteIdent("value")} IS NOT NULL`,
        valueColumn: "v",
      };
    }
    params.length = ckpt;
    return null;
  };
  const lhsDesc = describeOrRows(lhs);
  if (!lhsDesc) { params.length = paramsStart; return null; }
  const rhsDesc = describeOrRows(rhs);
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
    // One-empty fallbacks: one row per element of the non-empty side;
    // both-empty: a single row (?= true / ?!= false).
    elementWise = `SELECT ${compareSql(`lhs_q.${lhsDesc.valueColumn}`, `rhs_q.${rhsDesc.valueColumn}`)} AS ${quoteIdent("value")} FROM lhs_q CROSS JOIN rhs_q`;
    const fallbackBool = (op === "?=") ? "json('false')" : "json('true')";
    const bothEmptyBool = (op === "?=") ? "json('true')" : "json('false')";
    fallback = `SELECT ${fallbackBool} AS ${quoteIdent("value")} FROM rhs_q WHERE NOT EXISTS (SELECT 1 FROM lhs_q)`
      + ` UNION ALL SELECT ${fallbackBool} AS ${quoteIdent("value")} FROM lhs_q WHERE NOT EXISTS (SELECT 1 FROM rhs_q)`
      + ` UNION ALL SELECT ${bothEmptyBool} AS ${quoteIdent("value")} WHERE NOT EXISTS (SELECT 1 FROM lhs_q) AND NOT EXISTS (SELECT 1 FROM rhs_q)`;
  } else {
    const rhsValueExpr = rhsDesc.kind === "always-empty"
      ? "NULL"
      : rhsDesc.valueSQL;
    elementWise = `SELECT ${compareSql(`lhs_q.${lhsDesc.valueColumn}`, rhsValueExpr)} AS ${quoteIdent("value")} FROM lhs_q`;
    fallback = `SELECT ${emptyCaseTrue ? "json('true')" : "json('false')"} AS ${quoteIdent("value")} WHERE NOT EXISTS (SELECT 1 FROM lhs_q)`;
  }

  return `WITH ${cteDefs.join(", ")} ${elementWise} UNION ALL ${fallback}`;
};
