import type { GroupRowProjection, Pointer, Set, TypeRef } from "../ir/gel_ir.js";
import type { RuntimeTarget } from "../runtime/target.js";
import type { ScalarValue } from "../types.js";

// A pointer chain ending in a scalar (or, for object-identity existence
// checks, an object) leaf: the root set, the leaf pointer, the intermediate
// links, and the narrowed scan type for each link. Shared by the SQL compiler
// and the path-existence lowering module (existence_proof.ts).
export type ScalarPointerPath = {
  root: Set;
  leaf: Pointer;
  links: Pointer[];
  // The narrowed scan type for each link in `links` (same order): the wrapping
  // set's typeref, which a `[IS T]` intersection replaces with the narrowed
  // type. `effectiveStepType` reads this so the narrowing falls out of the
  // id-equijoin against the link's targets.
  linkTargets: TypeRef[];
};

export interface GelIRSQLArtifact {
  sql: string;
  params: ScalarValue[];
  loweringMode: "single_statement" | "fallback_multi_query";
  // INSERT artifacts only: each assigned column with its compiled SQL value
  // expression and that expression's own parameter slice. Lets the runtime
  // mutation executor splice individual SQL-lowered assignments (function
  // calls, subselects, FOR bodies) into the INSERT it builds from the
  // runtime plan, instead of requiring every value to be a static scalar.
  insertColumns?: Array<{ column: string; sql: string; params: ScalarValue[] }>;
}

/**
 * The SQL gate: did this artifact compile to exactly one runnable SQL statement?
 * Single source of truth for the SQL-vs-runtime-evaluator decision — both the
 * engine's dispatch and the compile-inspection seam (src/compiler/inspect.ts)
 * consume this instead of re-deriving the predicate. Replaces the
 * `loweringMode !== "single_statement" || sql.length === 0` check that was
 * previously copy-pasted across the engine (architecture review candidate #2).
 */
export const lowersToSingleSql = (artifact: GelIRSQLArtifact): boolean =>
  artifact.loweringMode === "single_statement" && artifact.sql.length > 0;

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
  // The qualified names of every CONCRETE type assignable to `typeName`
  // (itself if concrete, plus all concrete subtypes). A union typeref reaches
  // the SQL layer as a bare `A | B` id string whose branch refs carry no
  // `children`, so its own type-closure misses subtypes; this schema-backed
  // resolver recovers them — needed to find every physical link-storage table
  // a polymorphic read must union over.
  resolveConcreteSubtypes?: (typeName: string) => string[];
  maxShapeDepth?: number;
  target?: RuntimeTarget;
  parameterValues?: Record<string, ScalarValue>;
  globalValues?: Record<string, ScalarValue>;
  // Stack of enclosing iteration scopes available to inner subqueries.
  // EdgeQL's path-sharing semantics: a fresh `User` reference inside a
  // shape projection on `User` refers to the OUTER iterator's current row,
  // not a cross-product of all Users. The IR doesn't capture this binding
  // (the inner reference is a fresh type_root with its own path), so the
  // SQL compiler matches by typeref id and path namespace here when resolving
  // path references. Most-recent (innermost) scopes take precedence.
  outerScopes?: ReadonlyArray<{ alias: string; typeref: TypeRef; namespace?: string[] }>;
  // Current row sources that are not bare type roots (for example a set-union
  // source) are matched by path id so `.name` in FILTER/ORDER BY reads the
  // row currently being shaped instead of recompiling the full source set.
  sourcePathAliases?: ReadonlyArray<{ pathKey: string; alias: string }>;
  // When a multi-scalar pointer is being iterated via `json_each(col) je`,
  // the helper binds the iteration's pathId(s) to the SQL expression that
  // evaluates the json_each value column (`je."value"`). compileValueSetSQL
  // looks this up before falling back to the column-read path so references
  // to the bound set resolve to the unpacked element instead of the raw
  // JSON-encoded column text.
  multiScalarBindings?: ReadonlyMap<string, string>;
  // Shape elements that fail to lower are normally skipped (the runtime
  // decoder fills them in for plain SELECTs). Lowerings that re-aggregate the
  // shape JSON wholesale (GROUP) can't tolerate a lossy projection — with
  // this flag a failed element throws ShapeLoweringMiss so the caller can
  // fall back instead of emitting rows with missing fields.
  strictShape?: boolean;
  // Active group-rows statement context for clause compilation: resolves
  // group_row_field paths against this alias's JSON `value`, re-emitting
  // projected names' expressions (see compileGroupRowsStatementSQL).
  groupRowProjection?: { alias: string; projections: ReadonlyMap<string, GroupRowProjection> };
  // Per-element scope inside a FOR-over-group body (`U {…}` where
  // U := g.elements): a json_each alias over the current group's elements.
  // VALUE-position `elements`-rooted group_row_field paths read the CURRENT
  // element through it; set-position reads (aggregate args) keep the
  // whole-group semantics via groupRowProjection.
  groupElementAlias?: string;
  // The current per-row iteration root, made visible to SET OF (aggregate)
  // args: EdgeQL paths inside SET OF args still use already-scoped outer
  // paths, so `Publication.title ?= <str>count(Publication)` counts the
  // SCOPED singleton (0 when the LEFT-JOINed row is NULL, else 1) rather
  // than the whole table (set_of_nonempty_01).
  scopedAggRoot?: { alias: string; typerefId: string };
  // Set only when the enclosing scalar select has NO bound row source (e.g.
  // `(SELECT <json>Issue {…} FILTER …) = to_json(…)` — the comparison's
  // operands contribute no outer iteration). With no enclosing row, a
  // free-rooted subquery operand cannot be path-sharing-correlated with a
  // sibling, so it is safe to compile as a self-contained scalar subselect
  // with its own FROM. Left unset (path-sharing semantics apply) when a row
  // source exists, so `Issue.number ++ (SELECT Issue.number)` stays correlated.
  allowIndependentSubquery?: boolean;
  // Set when compiling a LIMIT/OFFSET expression, which in EdgeQL is a SIBLING
  // scope to the SELECT body: it is evaluated once for the whole query and
  // cannot correlate to the per-row subject alias. A for_expr over an object
  // iterator inside it (`F.deck_cost` where `F := (SELECT User FILTER …)`)
  // must therefore materialize its own iterator source rather than dangling on
  // the unbound subject alias `g0`.
  siblingScopeLimitOffset?: boolean;
}

// See GelIRCompileOptions.strictShape.
export class ShapeLoweringMiss extends Error {
  constructor(elementName: string) {
    super(`shape element '${elementName}' does not lower to SQL`);
  }
}
