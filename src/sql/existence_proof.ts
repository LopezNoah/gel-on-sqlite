// Path-existence lowering — the SQL algebra for proving an EdgeQL pointer path
// exists: object-identity comparisons (`<chain> = Outer`), multi-step EXISTS
// chains, correlated existential subqueries (`EXISTS (SELECT T FILTER …)`),
// existence guards over strict boolean operands, and the anchored object-chain
// JOIN builder they share. A self-contained ~680-line concern lifted verbatim
// out of gel_ir_compiler.ts so it has a name and a test surface (architecture
// review round 10 / ADR 0052). The functions are mutually recursive with the
// value/predicate/source dispatchers, so they reach those — and a handful of
// pure pointer/path collectors — through the injected `SqlLoweringContext`
// seam (ADR 0006), keeping the no-cycle discipline. Bodies are byte-identical
// to the originals; each destructures `deps` at the top.
import { quoteIdent } from "../codegen/sql.js";
import { pointerStepJoinSql } from "./pointer_join.js";
import type { RuntimeTarget } from "../runtime/target.js";
import type { ScalarValue } from "../types.js";
import type { GelIRCompileOptions, ScalarPointerPath } from "./compiler_types.js";
import type { SqlLoweringContext } from "./function_lowering.js";
import type {
  Expr,
  FunctionCall,
  OperatorCall,
  Pointer,
  SelectExpr,
  Set,
  TypeCast,
  TypeRef,
  TypeRoot,
} from "../ir/gel_ir.js";

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
  deps: SqlLoweringContext,
): string | null => {
  const { shouldUseLinkTable, compilePolymorphicSource, linkTableNameForPointer } = deps;
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
      if (!fromSql) {
        // First step has no prior FROM: seed it with the junction-and-target
        // join and correlate to the previous alias via WHERE.
        if (link.direction === "inbound") {
          fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource}`
            + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`);
        } else {
          fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource}`
            + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`);
        }
      } else {
        fromSql += pointerStepJoinSql({
          usesLinkTable: true,
          direction: link.direction,
          previousAlias,
          nextAlias,
          targetSource,
          linkAlias,
          linkTable,
        });
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (!fromSql) {
        fromSql = targetSource;
        whereSqls.push(link.direction === "inbound"
          ? `${nextAlias}.${quoteIdent(inlineColumn)} = ${previousAlias}.${quoteIdent("id")}`
          : `${nextAlias}.${quoteIdent("id")} = ${previousAlias}.${quoteIdent(inlineColumn)}`);
      } else {
        fromSql += pointerStepJoinSql({
          usesLinkTable: false,
          direction: link.direction,
          previousAlias,
          nextAlias,
          targetSource,
          inlineColumn,
        });
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
  const chainSetTyperefs: TypeRef[] = [];
  let cursor: Set = set;
  while (cursor.expr.kind === "pointer") {
    const pointer = cursor.expr as Pointer;
    if (pointer.ptrref.isLinkProperty) return null;
    chain.push(pointer);
    chainSetTyperefs.push(cursor.typeref);
    cursor = pointer.source;
  }

  let rootExpr: Expr = cursor.expr;
  while (rootExpr.kind === "select_expr") {
    rootExpr = (rootExpr as SelectExpr).result.expr;
  }
  if (rootExpr.kind !== "type_root" || chain.length === 0) {
    return null;
  }

  const leaf = chain[0];
  if (leaf.ptrref.outTarget.isScalar) return null;

  const links = chain.slice(1).reverse();
  if (links.some((link) => link.ptrref.outTarget.isScalar || link.ptrref.isLinkProperty)) {
    return null;
  }
  const linkTargets = chainSetTyperefs.slice(1).reverse();

  return { root: cursor, leaf, links, linkTargets };
};

export const tryCompileMultiStepPointerExistsSQL = (
  leftSet: Set,
  rightSet: Set,
  op: "=" | "!=" | "<" | "<=" | ">" | ">=",
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const {
    extractScalarPointerPath, compileValueSetSQL, pointerPathAliasColumns,
    isTrulyPolymorphicTypeRef, compilePolymorphicSource, shouldUseLinkTable,
    linkTableNameForPointer, columnForPointer,
  } = deps;
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
  // Re-check the op so TS narrows it to the identity-comparison subset that
  // `objectPath` being non-null already implies.
  if (objectPath && (op === "=" || op === "!=")) {
    const chainHasBacklink = [...objectPath.links, objectPath.leaf]
      .some((link) => link.direction === "inbound");
    const rightTypeRef = (rightSet.expr as TypeRoot).typeref;
    if (chainHasBacklink
        && (rightTypeRef.id === objectPath.leaf.ptrref.outTarget.id || rightTypeRef.id === objectPath.root.typeref.id)) {
      return tryCompileObjectIdentityExistsSQL(objectPath, op, sourceAlias, params, options, deps);
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
    const targetSource = compilePolymorphicSource(targetType, false, nextAlias, aliasColumns[index + 1], options);
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
      if (!fromSql) {
        // First step has no prior FROM: seed it with the junction-and-target
        // join and correlate to the previous alias via WHERE.
        if (link.direction === "inbound") {
          fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource}`
            + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("target")} = ${previousAlias}.${quoteIdent("id")}`);
        } else {
          fromSql = `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource}`
            + ` ON ${nextAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("source")} = ${previousAlias}.${quoteIdent("id")}`);
        }
      } else {
        fromSql += pointerStepJoinSql({
          usesLinkTable: true,
          direction: link.direction,
          previousAlias,
          nextAlias,
          targetSource,
          linkAlias,
          linkTable,
        });
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
  // All-single chains (`Issue.priority.name`) yield at most one value, so a
  // scalar subquery comparison gives correct three-valued logic: an empty
  // chain produces NULL, which propagates through NOT/AND/OR per EdgeQL's
  // empty-set semantics (the EXISTS form would collapse empty to false and
  // make `NOT (NOT x = 'a' AND …)` keep rows whose x is empty).
  const allSingleChain = [...path.links, path.leaf].every((link) =>
    link.direction === "outbound"
    && (link.ptrref.outCardinality === "one" || link.ptrref.outCardinality === "at_most_one"));
  if (allSingleChain) {
    const joinWhere = whereSqls.length > 0 ? ` WHERE ${whereSqls.join(" AND ")}` : "";
    return `((SELECT ${leafCol} FROM ${fromSql}${joinWhere}) ${op} ${rightSql})`;
  }
  whereSqls.push(`${leafCol} ${op} ${rightSql}`);
  return `EXISTS (SELECT 1 FROM ${fromSql} WHERE ${whereSqls.join(" AND ")})`;
};

// `EXISTS Issue.priority` / `EXISTS Issue.<owner[IS Comment]` /
// `EXISTS Issue.priority.id` / `EXISTS Issue.owner.<owner[IS Comment]`: lower
// a pointer-(chain-)to-object/scalar expression to a direct SQL existence
// check anchored on `sourceAlias`. Returns null when the inner Set isn't a
// recognised pointer chain.
// `EXISTS (SELECT Type FILTER <correlated predicate>)` — a correlated
// existential subquery. Compile it as `EXISTS (SELECT 1 FROM <Type source>
// WHERE <predicate>)` with the outer row exposed as an iteration scope so
// object-identity comparisons against the outer row (`Comment.owner =
// Issue.owner`, `Comment.issue = Issue`) reduce to FK/id column equality.
// Returns null for shapes it can't handle (LIMIT/OFFSET/ORDER BY, non-type
// roots, an empty filter) so the caller can fall back.
// Deep-rewrite a filter Set, replacing every reference to the bound chain
// (identified by its pathId) with a synthetic type_root of the chain's leaf
// type. After the rewrite, `I.time_estimate` (where `I := User.<owner[IS
// Issue]`) compiles like `Issue.time_estimate` against the chain's leaf-level
// alias.
const rewriteChainRefsToTypeRoot = (node: unknown, chainKey: string, leafType: TypeRef, deps: SqlLoweringContext): unknown => {
  const { pathIdKey } = deps;
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const r = rewriteChainRefsToTypeRoot(item, chainKey, leafType, deps);
      if (r !== item) changed = true;
      return r;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (obj.kind === "set" && pathIdKey(obj as unknown as Set) === chainKey) {
    return {
      ...obj,
      expr: { kind: "type_root", typeref: leafType, skipSubtypes: false, isCachedGlobal: false },
    };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key === "pathId" || key === "typeref" || key === "ptrref" || key === "span") {
      next[key] = obj[key];
      continue;
    }
    const r = rewriteChainRefsToTypeRoot(obj[key], chainKey, leafType, deps);
    if (r !== obj[key]) changed = true;
    next[key] = r;
  }
  return changed ? next : node;
};

// `EXISTS (SELECT I := Outer.<link[IS T] FILTER <pred on I>)` — a correlated
// existential over an object-link chain rooted at the OUTER row. Joins the
// chain anchored at `sourceAlias`, rewrites chain references in the filter to
// the leaf level, and compiles the filter against the leaf alias.
const tryCompileCorrelatedExistsChainSelect = (
  chainSet: Set,
  wheres: Set[],
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const {
    pathIdKey, collectProjectedColumns, collectTypeRootIds,
    compilePredicateSetSQL, compileValueSetSQL,
  } = deps;
  const chain: Pointer[] = [];
  let walk: Set = chainSet;
  while (walk.expr.kind === "pointer") {
    const ptr = walk.expr as Pointer;
    if (ptr.ptrref.isLinkProperty || ptr.ptrref.outTarget.isScalar) return null;
    chain.push(ptr);
    walk = ptr.source;
  }
  if (walk.expr.kind !== "type_root") return null;
  const links = chain.reverse();
  const leafType = chainSet.typeref;
  const rootType = (walk.expr as TypeRoot).typeref;
  // Same-type chains (`Issue.related_to`) would make outer-scope anchoring
  // ambiguous between root and leaf; leave those to other lowerings.
  if (rootType.id === leafType.id) return null;
  const chainKey = pathIdKey(chainSet);
  const rewrittenWheres = wheres.map((w) => rewriteChainRefsToTypeRoot(w, chainKey, leafType, deps) as Set);
  const leafColumns = [...new globalThis.Set(
    rewrittenWheres.flatMap((w) => collectProjectedColumns([], w)),
  )];
  const built = buildAnchoredObjectChainJoin(links, sourceAlias, options, deps, leafColumns, leafType);
  if (!built) return null;
  const outerIds = new globalThis.Set<string>();
  for (const w of rewrittenWheres) collectTypeRootIds(w, outerIds);
  outerIds.delete(leafType.id);
  const innerOptions: GelIRCompileOptions = {
    ...options,
    outerScopes: [
      ...(options.outerScopes ?? []),
      ...[...outerIds].map((id) => ({
        alias: sourceAlias,
        typeref: { kind: "type_ref" as const, id, nameHint: id, isScalar: false } as TypeRef,
        namespace: [] as string[],
      })),
    ],
  };
  const checkpoint = params.length;
  const whereSqls = [...built.whereSqls];
  for (const w of rewrittenWheres) {
    const ws = compilePredicateSetSQL(w, built.leafAlias, params, target, innerOptions)
      ?? compileValueSetSQL(w, built.leafAlias, params, target, innerOptions);
    if (!ws) {
      params.length = checkpoint;
      return null;
    }
    whereSqls.push(ws);
  }
  return `EXISTS (SELECT 1 FROM ${built.fromSql} WHERE ${whereSqls.join(" AND ")})`;
};

export const tryCompileCorrelatedExistsSelect = (
  set: Set,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const {
    collectTypeRootIds, compileSelectSource, compilePredicateSetSQL, compileValueSetSQL,
  } = deps;
  let cursor: Set = set;
  const wheres: Set[] = [];
  while (cursor.expr.kind === "select_expr") {
    const se = cursor.expr as SelectExpr;
    if (se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) return null;
    if (se.where) wheres.push(se.where);
    cursor = se.result;
  }
  if (cursor.expr.kind === "pointer" && wheres.length > 0) {
    return tryCompileCorrelatedExistsChainSelect(cursor, wheres, sourceAlias, params, target, options, deps);
  }
  if (cursor.expr.kind !== "type_root" || wheres.length === 0) return null;
  const innerType = (cursor.expr as TypeRoot).typeref;
  // Outer scope: every type_root referenced in the filter that isn't the inner
  // type belongs to an enclosing row, anchored at `sourceAlias`.
  const outerIds = new globalThis.Set<string>();
  for (const w of wheres) collectTypeRootIds(w, outerIds);
  outerIds.delete(innerType.id);
  const innerAlias = "ex0";
  const innerOptions: GelIRCompileOptions = {
    ...options,
    outerScopes: [
      // A WITH-bound subquery (`sub := (SELECT Issue …)`, marked
      // isWithBinding by the IR builder) is DETACHED: an enclosing scope of
      // the same type must not capture its inner references. Inline
      // subqueries keep the outer capture (EdgeQL common-prefix sharing).
      ...(options.outerScopes ?? []).filter((scope) =>
        scope.typeref.id !== innerType.id
        || !((set as { isWithBinding?: boolean }).isWithBinding
          || (set.pathId?.namespace ?? []).some((ns) => ns.startsWith("with:")))),
      ...[...outerIds].map((id) => ({
        alias: sourceAlias,
        typeref: { kind: "type_ref" as const, id, nameHint: id, isScalar: false } as TypeRef,
        namespace: [] as string[],
      })),
    ],
  };
  const checkpoint = params.length;
  const innerSource = compileSelectSource(cursor, wheres[0], undefined, innerOptions, params, target, innerAlias);
  if (!innerSource) {
    params.length = checkpoint;
    return null;
  }
  const whereSqls: string[] = [];
  for (const w of wheres) {
    const ws = compilePredicateSetSQL(w, innerSource.alias, params, target, innerOptions)
      ?? compileValueSetSQL(w, innerSource.alias, params, target, innerOptions);
    if (!ws) {
      params.length = checkpoint;
      return null;
    }
    whereSqls.push(ws);
  }
  return `EXISTS (SELECT 1 FROM ${innerSource.sql} WHERE ${whereSqls.join(" AND ")})`;
};

// Collect pointer-chain Sets inside a strict boolean expression whose
// emptiness makes the whole expression empty (EdgeQL strict-operator
// semantics). Used to build existence guards for OR operands. Stops at
// non-strict constructs — EXISTS, ??, ?=/?!=, aggregates — whose value is
// defined even when the inner path is empty.
export const collectStrictPointerChainSets = (set: Set, out: Set[], deps: SqlLoweringContext): void => {
  const { orderedCallArgs, NON_STRICT_STDLIB } = deps;
  const expr = set.expr;
  if (!expr) return;
  if (expr.kind === "pointer") {
    let cursor: Set = set;
    while (cursor.expr.kind === "pointer") {
      cursor = (cursor.expr as Pointer).source;
    }
    while (cursor.expr.kind === "select_expr") {
      const se = cursor.expr as SelectExpr;
      if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return;
      cursor = se.result;
    }
    if (cursor.expr.kind === "type_root") out.push(set);
    return;
  }
  if (expr.kind === "select_expr") {
    const se = expr as SelectExpr;
    if (se.limit || se.offset) return;
    collectStrictPointerChainSets(se.result, out, deps);
    return;
  }
  if (expr.kind === "type_cast") {
    collectStrictPointerChainSets((expr as TypeCast).expr, out, deps);
    return;
  }
  if (expr.kind === "exists_expr") return;
  if (expr.kind === "operator_call") {
    const oc = expr as OperatorCall;
    if (oc.operator === "??" || oc.operator === "?=" || oc.operator === "?!=" || oc.operator === "exists") return;
    for (const arg of orderedCallArgs(oc.args)) collectStrictPointerChainSets(arg.expr, out, deps);
    return;
  }
  if (expr.kind === "function_call") {
    const fc = expr as FunctionCall;
    const shortName = (fc.functionName ?? "").split("::").pop() ?? "";
    if (NON_STRICT_STDLIB.has(shortName)) return;
    for (const arg of orderedCallArgs(fc.args)) collectStrictPointerChainSets(arg.expr, out, deps);
    return;
  }
};

// SQL predicate asserting that the given pointer-chain Set (rooted at the
// outer source row) is non-empty. Object-link chains reuse the EXISTS
// lowering; a direct single scalar pointer becomes a NULL check on its
// column. Returns null when no sound guard can be built (multi scalars,
// link properties, computed pointers) — callers treat that as "no guard".
export const compilePathExistenceGuard = (
  chain: Set,
  sourceAlias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const { columnForPointer } = deps;
  const viaExists = tryCompileExistsObjectPointerSQL(chain, sourceAlias, params, target, options, deps);
  if (viaExists) return viaExists;
  if (chain.expr.kind !== "pointer") return null;
  const leaf = chain.expr as Pointer;
  if (!leaf.ptrref.outTarget.isScalar || leaf.ptrref.isLinkProperty) return null;
  if (leaf.ptrref.outCardinality === "many" || leaf.ptrref.outCardinality === "at_least_one") return null;
  let cursor: Set = leaf.source;
  while (cursor.expr.kind === "select_expr") {
    const se = cursor.expr as SelectExpr;
    if (se.where || (se.orderBy && se.orderBy.length > 0) || se.limit || se.offset) return null;
    cursor = se.result;
  }
  if (cursor.expr.kind !== "type_root") return null;
  return `${sourceAlias}.${quoteIdent(columnForPointer(leaf))} IS NOT NULL`;
};

export const tryCompileExistsObjectPointerSQL = (
  set: Set,
  sourceAlias: string,
  _params: ScalarValue[],
  _target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const { shouldUseLinkTable, linkTableNameForPointer, compilePolymorphicSource } = deps;
  // Unwrap `(SELECT Issue.<…)`-style subquery wrappers so `EXISTS (SELECT
  // foo)` works the same as `EXISTS foo`. Wrappers that carry a FILTER (or
  // LIMIT/OFFSET) change the existence test — stripping them silently drops
  // the filter, so bail out and let a correlated lowering handle it.
  let inner = set;
  while (inner.expr.kind === "select_expr") {
    const se = inner.expr as SelectExpr;
    if (se.where || se.limit || se.offset) return null;
    inner = se.result;
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
    const pointer = links[0];
    if (shouldUseLinkTable(pointer)) {
      const linkTable = linkTableNameForPointer(pointer, options);
      const sideAnchor = pointer.direction === "inbound" ? "target" : "source";
      return `EXISTS (SELECT 1 FROM ${quoteIdent(linkTable)} _ex WHERE _ex.${quoteIdent(sideAnchor)} = ${sourceAlias}.${quoteIdent("id")})`;
    }
    if (pointer.direction === "inbound") {
      // The referencing type may have concrete subtypes living in their own
      // tables — scan the polymorphic union, not just the base table.
      const targetType = pointer.ptrref.outSource;
      const inlineColumn = `${pointer.ptrref.shortName}_id`;
      const targetSource = compilePolymorphicSource(targetType, false, "_ex", ["id", inlineColumn], options);
      return `EXISTS (SELECT 1 FROM ${targetSource} WHERE _ex.${quoteIdent(inlineColumn)} = ${sourceAlias}.${quoteIdent("id")})`;
    }
    const inlineColumn = `${pointer.ptrref.shortName}_id`;
    return `${sourceAlias}.${quoteIdent(inlineColumn)} IS NOT NULL`;
  }

  // Multi-step: build a chain of joins inside a single EXISTS, anchored
  // against the outer row's id via the first link. Every level scans the
  // polymorphic union of its type (`Card` must include `SpecialCard` rows)
  // — a single-table scan silently drops subtype rows from the chain.
  const built = buildAnchoredObjectChainJoin(links, sourceAlias, options, deps);
  if (!built) return null;
  return `EXISTS (SELECT 1 FROM ${built.fromSql} WHERE ${built.whereSqls.join(" AND ")})`;
};

// Build a FROM clause joining an object-link pointer chain anchored at
// `sourceAlias` (the outer row), returning the FROM SQL, the anchor WHERE
// predicates, and the alias of the chain's leaf level. `leafColumns` adds
// extra projected columns to the leaf level (for filter predicates that read
// the leaf's scalar fields); `leafTypeOverride` narrows the leaf scan to a
// `[IS T]`-intersected type instead of the link's declared target.
const buildAnchoredObjectChainJoin = (
  links: Pointer[],
  sourceAlias: string,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
  leafColumns: string[] = [],
  leafTypeOverride?: TypeRef,
): { fromSql: string; whereSqls: string[]; leafAlias: string } | null => {
  const { shouldUseLinkTable, linkTableNameForPointer, compilePolymorphicSource } = deps;
  let fromSql = "";
  const whereSqls: string[] = [];
  let prevAlias = sourceAlias;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const isLeaf = i === links.length - 1;
    const declaredTarget = link.direction === "inbound" ? link.ptrref.outSource : link.ptrref.outTarget;
    const targetType = isLeaf && leafTypeOverride ? leafTypeOverride : declaredTarget;
    const targetAlias = `_ex${i}`;
    const cols = new globalThis.Set<string>(["id"]);
    // Inline inbound link reads its FK column off this level's row; an
    // inline outbound NEXT link reads its FK off this level too.
    if (!shouldUseLinkTable(link) && link.direction === "inbound") {
      cols.add(`${link.ptrref.shortName}_id`);
    }
    const nextLink = links[i + 1];
    if (nextLink && !shouldUseLinkTable(nextLink) && nextLink.direction === "outbound") {
      cols.add(`${nextLink.ptrref.shortName}_id`);
    }
    if (isLeaf) for (const col of leafColumns) cols.add(col);
    const targetSource = compilePolymorphicSource(targetType, false, targetAlias, [...cols], options);
    if (shouldUseLinkTable(link)) {
      const linkTable = linkTableNameForPointer(link, options);
      const linkAlias = `_lj${i}`;
      if (i === 0) {
        // First step has no prior FROM: seed it with the junction-and-target
        // join and correlate to the previous alias via WHERE.
        if (link.direction === "inbound") {
          fromSql += `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("source")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("target")} = ${prevAlias}.${quoteIdent("id")}`);
        } else {
          fromSql += `${quoteIdent(linkTable)} ${linkAlias} JOIN ${targetSource} ON ${targetAlias}.${quoteIdent("id")} = ${linkAlias}.${quoteIdent("target")}`;
          whereSqls.push(`${linkAlias}.${quoteIdent("source")} = ${prevAlias}.${quoteIdent("id")}`);
        }
      } else {
        fromSql += pointerStepJoinSql({
          usesLinkTable: true,
          direction: link.direction,
          previousAlias: prevAlias,
          nextAlias: targetAlias,
          targetSource,
          linkAlias,
          linkTable,
        });
      }
    } else {
      const inlineColumn = `${link.ptrref.shortName}_id`;
      if (i === 0) {
        fromSql += targetSource;
        whereSqls.push(link.direction === "inbound"
          ? `${targetAlias}.${quoteIdent(inlineColumn)} = ${prevAlias}.${quoteIdent("id")}`
          : `${targetAlias}.${quoteIdent("id")} = ${prevAlias}.${quoteIdent(inlineColumn)}`);
      } else {
        fromSql += pointerStepJoinSql({
          usesLinkTable: false,
          direction: link.direction,
          previousAlias: prevAlias,
          nextAlias: targetAlias,
          targetSource,
          inlineColumn,
        });
      }
    }
    prevAlias = targetAlias;
  }
  if (!fromSql) return null;
  return { fromSql, whereSqls, leafAlias: prevAlias };
};
