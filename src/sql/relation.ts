// Relation + PathRegistry — a `pathctx`-style relational planner (BEACHHEAD).
//
// This module is a prototype of the central path/range-var machinery that Gel's
// PostgreSQL backend has (edb/pgsql/compiler/{pathctx,relctx,relgen}.py) and that
// sqlite-ts currently lacks. Today the SQL backend answers "what SQL expression
// represents this EdgeQL path here?" in THREE structurally-distinct, hand-threaded
// places (see src/sql/gel_ir_compiler.ts):
//
//   1. "is this pointer a column on the current iteration row?"   -> structural
//        (compileProjectedSourceColumnRef -- no context lookup)
//   2. "is this fresh type reference an enclosing iteration?"     -> `outerScopes`
//        (findMatchingOuterScope, matched by typeref.id + namespace)
//   3. "is this exact path already bound to an alias?"            -> `sourcePathAliases`
//        / `multiScalarBindings` (pickSourcePathAlias, matched by pathIdKey)
//
// Each new correlation bug has historically been fixed by adding another knob to
// `GelIRCompileOptions` (outerScopes, sourcePathAliases, multiScalarBindings,
// scopedAggRoot, groupRowProjection, ...). This module folds all three questions
// into one operation -- `Relation.getPathVar(pathKey, aspect)` -- backed by a
// mutable relation tree that supports *recursive column injection*: a parent can
// ask a child subquery to expose a path it did not originally project, then pull
// it up through the range var. That is the one capability string-concatenation
// emission cannot offer (the text is already serialized), and it is what makes
// shared-prefix correlation and outer-scope correlation fall out of one lookup
// instead of N special cases.
//
// Design choice: expressions stay strings. We do NOT model a SQL *expression*
// AST -- Gel only has pgast because Postgres forced it, and the expression AST is
// the low-value / high-cost part. The leverage is the mutable *relation* + the
// path registry; relations are objects, expressions remain SQL text, and a
// relation serializes to {sql, params} exactly once at its boundary.

import type { PathId, Set as IRSet, TypeRef } from "../ir/gel_ir.js";
import type { ScalarValue } from "../types.js";

// Matches the one-liner replicated in engine.ts / schema_materialize.ts / etc.
const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

/**
 * The "view" of a path requested, mirroring Gel's PathAspect (edb/pgsql/
 * compiler/enums.py). sqlite-ts already makes these distinctions, but across
 * separate code paths (scalar-value SQL vs JSON materialization vs id reads)
 * rather than as one parameter. We model the three that the backend actually
 * needs today; SOURCE/ITERATOR are deferred until a routed construct needs them.
 */
export type Aspect = "value" | "serialized" | "identity";

/**
 * Canonical path key -- byte-identical to the backend's
 * `pathIdKey(set) = JSON.stringify(set.pathId)` (gel_ir_compiler.ts), so a
 * registry built from live IR matches the same keys `sourcePathAliases` /
 * `multiScalarBindings` use today.
 */
export const pathKeyOf = (set: IRSet): string => JSON.stringify(set.pathId);
export const pathIdKeyOf = (pathId: PathId): string => JSON.stringify(pathId);

/**
 * Scope key for question (2): a *fresh* reference to a type root that is an
 * enclosing iteration. The backend matches these by `typeref.id` + ordered
 * namespace (findMatchingOuterScope / namespacesEqual). JSON-encoded so two
 * distinct (id, namespace) pairs can never collide into one key -- matching the
 * "JSON.stringify keys" rule adopted in ADR 0047.
 */
export const scopeKeyOf = (typeref: Pick<TypeRef, "id">, namespace: readonly string[]): string =>
  JSON.stringify([typeref.id, ...namespace]);

export class PathNotResolvable extends Error {
  constructor(
    readonly pathKey: string,
    readonly aspect: Aspect,
  ) {
    super(`path not resolvable in this relation or any enclosing scope: ${pathKey} [${aspect}]`);
  }
}

export type JoinKind = "base" | "cross" | "inner" | "left";

/**
 * A FROM entry. `sourceSql` is either a base table name (`"default__card"`) or a
 * parenthesizable subquery; when the source is itself a built Relation, pass it
 * as `relation` so the parent can inject columns into it (recursive column
 * injection). `params` are the source's own bound values, spliced in FROM order.
 */
export interface RangeVar {
  alias: string;
  sourceSql: string;
  relation?: Relation;
  join?: { kind: Exclude<JoinKind, "base">; on: string };
  params?: ScalarValue[];
}

interface OutputColumn {
  alias: string;
  expr: string;
}

let injectionCounter = 0;
// Deterministic-per-process injected-column naming. Reset by tests via
// resetInjectionCounter() so output is stable; the real backend renames aliases
// to canonical form (bin/inspect.ts) anyway, so the exact name never leaks.
export const resetInjectionCounter = (): void => {
  injectionCounter = 0;
};

/**
 * A mutable SQL relation: FROM sources, WHERE conjuncts, an output projection,
 * and a path registry. `parent` links it into the scope tree so unresolved paths
 * correlate outward (questions 2/3 across nesting). Serializes to {sql, params}
 * once, via toSql().
 */
export class Relation {
  readonly fromSources: RangeVar[] = [];
  readonly whereConjuncts: { sql: string; params: ScalarValue[] }[] = [];
  private readonly outputColumns: OutputColumn[] = [];

  // The registry: pathKey -> aspect -> SQL expression visible IN this relation.
  // Mirrors Gel's `path_namespace` (edb/pgsql/ast.py): "what SQL expression
  // represents this path here?".
  private readonly outputs = new Map<string, Map<Aspect, string>>();
  // Gel's `path_rvar_map` (edb/pgsql/ast.py): which FROM range var PROVIDES a
  // given (path, aspect) — distinct from `outputs` (the expression visible here)
  // and from a child relation's own outputs (the column it exposes outside
  // itself). When a path is registered to an rvar backed by a child Relation,
  // getPathVar injects into THAT child directly instead of scanning every FROM
  // source (which is what the backend does via put_path_rvar / include_rvar).
  private readonly rvars = new Map<string, Map<Aspect, RangeVar>>();
  // Question (2): scopeKey (typeref.id + namespace) -> range-var alias, for a
  // fresh reference to an enclosing type-root iteration.
  private readonly scopes = new Map<string, string>();

  constructor(readonly parent?: Relation) {}

  // ---- building -----------------------------------------------------------

  addRangeVar(rv: RangeVar): RangeVar {
    this.fromSources.push(rv);
    return rv;
  }

  addWhere(sql: string, params: ScalarValue[] = []): void {
    this.whereConjuncts.push({ sql, params });
  }

  /** Register the SQL expression for a path/aspect visible in this relation. */
  registerPath(pathKey: string, aspect: Aspect, sqlExpr: string): void {
    let m = this.outputs.get(pathKey);
    if (!m) {
      m = new Map();
      this.outputs.set(pathKey, m);
    }
    m.set(aspect, sqlExpr);
  }

  /** Register a type-root range var so fresh references correlate (question 2). */
  registerScope(scopeKey: string, alias: string): void {
    this.scopes.set(scopeKey, alias);
  }

  /**
   * Record which range var PROVIDES `pathKey`/`aspect` (Gel's put_path_rvar).
   * Lets getPathVar resolve the path by going straight to that range var's
   * relation instead of scanning every FROM source.
   */
  registerPathRvar(pathKey: string, aspect: Aspect, rv: RangeVar): void {
    let m = this.rvars.get(pathKey);
    if (!m) {
      m = new Map();
      this.rvars.set(pathKey, m);
    }
    m.set(aspect, rv);
  }

  /** The range var registered as providing `pathKey`/`aspect`, or null. */
  getPathRvar(pathKey: string, aspect: Aspect): RangeVar | null {
    return this.rvars.get(pathKey)?.get(aspect) ?? null;
  }

  /** Add an explicit output column (e.g. the SELECT projection). */
  addOutput(alias: string, expr: string): void {
    if (!this.outputColumns.some((c) => c.alias === alias)) {
      this.outputColumns.push({ alias, expr });
    }
  }

  // ---- resolution (the single operation that replaces the 3 code paths) ----

  /**
   * Resolve a fresh type-root reference to an enclosing iteration's alias
   * (question 2). Local first, then outward through the scope tree. Returns null
   * if no enclosing scope ranges over that type+namespace.
   *
   * Equivalent to the backend's findMatchingOuterScope: its reverse-find over
   * `options.outerScopes` (innermost wins) corresponds to Map-overwrite here
   * (the last registration for a key wins), and to parent-before-deeper-parent
   * traversal across nesting.
   */
  correlateScope(scopeKey: string): string | null {
    return this.scopes.get(scopeKey) ?? this.parent?.correlateScope(scopeKey) ?? null;
  }

  /** Like getPathVar but returns null instead of throwing. */
  tryGetPathVar(pathKey: string, aspect: Aspect): string | null {
    // (1) already visible here.
    const local = this.outputs.get(pathKey)?.get(aspect);
    if (local !== undefined) return local;

    // (recursive column injection) a child subquery can compute it -- make it
    // expose the path as an output column, then reference it through the range
    // var. This is the capability string emission cannot provide.
    //
    // Gel's path_rvar_map: when we KNOW which range var provides the path, go
    // straight to that child rather than scanning every FROM source. Falls back
    // to a scan for relations whose paths aren't registered to an rvar yet.
    const mapped = this.getPathRvar(pathKey, aspect);
    const candidates = mapped?.relation ? [mapped] : this.fromSources;
    for (const rv of candidates) {
      const child = rv.relation;
      if (!child) continue;
      const inner = child.tryGetPathVar(pathKey, aspect);
      if (inner !== null) {
        const exposed = child.expose(pathKey, aspect, inner);
        const ref = `${rv.alias}.${quoteIdent(exposed)}`;
        this.registerPath(pathKey, aspect, ref); // memoize: don't re-inject
        return ref;
      }
    }

    // (3 across nesting) correlate to an enclosing relation.
    if (this.parent) return this.parent.tryGetPathVar(pathKey, aspect);
    return null;
  }

  /**
   * The central question, fused: "what SQL expression represents this path,
   * in this aspect, here?" Throws PathNotResolvable if no source here, no child
   * subquery, and no enclosing scope can produce it.
   */
  getPathVar(pathKey: string, aspect: Aspect): string {
    const r = this.tryGetPathVar(pathKey, aspect);
    if (r === null) throw new PathNotResolvable(pathKey, aspect);
    return r;
  }

  /**
   * Ensure this relation projects `pathKey`/`aspect` as an output column and
   * return that column's output alias. Idempotent: a path injected twice reuses
   * the same column. This is the "inject a column the subquery didn't originally
   * expose" half of recursive column injection.
   */
  private expose(pathKey: string, aspect: Aspect, expr: string): string {
    const existing = this.outputs.get(pathKey)?.get(aspect);
    const already = this.outputColumns.find(
      (c) => c.expr === expr || quoteIdent(c.alias) === existing,
    );
    if (already) return already.alias;
    const name = `__inj${injectionCounter}`;
    injectionCounter += 1;
    this.outputColumns.push({ alias: name, expr });
    // Within this relation the path is now readable as its own output alias.
    this.registerPath(pathKey, aspect, quoteIdent(name));
    return name;
  }

  // ---- serialization (once, at the boundary) ------------------------------

  /** Serialize to a single SQL string + params (FROM order, then WHERE order). */
  toSql(): { sql: string; params: ScalarValue[] } {
    const params: ScalarValue[] = [];

    const fromParts: string[] = [];
    this.fromSources.forEach((rv, i) => {
      const src = rv.relation ? `(${this.serializeChild(rv.relation, params)})` : rv.sourceSql;
      if (!rv.relation && rv.params) params.push(...rv.params);
      const entry = `${src} ${rv.alias}`;
      if (i === 0) {
        fromParts.push(entry);
      } else if (!rv.join || rv.join.kind === "cross") {
        fromParts.push(`CROSS JOIN ${entry}`);
      } else {
        const kw = rv.join.kind === "left" ? "LEFT JOIN" : "JOIN";
        fromParts.push(`${kw} ${entry} ON ${rv.join.on}`);
      }
    });

    const cols =
      this.outputColumns.length > 0
        ? this.outputColumns.map((c) => `${c.expr} AS ${quoteIdent(c.alias)}`).join(", ")
        : "*";

    let sql = `SELECT ${cols}`;
    if (fromParts.length > 0) sql += ` FROM ${fromParts.join(" ")}`;

    if (this.whereConjuncts.length > 0) {
      const where = this.whereConjuncts
        .map((c) => {
          params.push(...c.params);
          return c.sql;
        })
        .join(" AND ");
      sql += ` WHERE ${where}`;
    }
    return { sql, params };
  }

  private serializeChild(child: Relation, params: ScalarValue[]): string {
    const { sql, params: childParams } = child.toSql();
    params.push(...childParams);
    return sql;
  }
}
