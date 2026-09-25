// Relation + PathRegistry — a `pathctx`-style relational planner (BEACHHEAD).
//
// This module is a prototype of the central path/range-var machinery that Gel's
// PostgreSQL backend has (edb/pgsql/compiler/{pathctx,relctx,relgen}.py) and that
// sqlite-ts currently lacks. Today the SQL backend answers "what SQL expression
// represents this EdgeQL path here?" through structurally-distinct lowering
// paths (see src/sql/gel_ir_compiler.ts). Before this module became authoritative,
// the three generic routes were:
//
//   1. "is this pointer a column on the current iteration row?"   -> structural
//        (compileProjectedSourceColumnRef -- no context lookup)
//   2. "is this fresh type reference an enclosing iteration?"     -> a scope stack
//        (findMatchingOuterScope, matched by typeref.id + namespace)
//   3. "is this exact path already bound to an alias/expression?"  -> path maps
//        (pickSourcePathAlias, matched by pathIdKey)
//
// Correlation bugs were historically fixed by adding another knob to
// `GelIRCompileOptions`. Relation now folds all three generic questions
// into one operation -- `Relation.getPathVar(pathKey, aspect)` -- backed by a
// mutable relation tree that supports *recursive column injection*: a parent can
// ask a child subquery to expose a path it did not originally project, then pull
// it up through the range var. That is the one capability string-concatenation
// emission cannot offer (the text is already serialized), and it is what makes
// shared-prefix correlation and outer-scope correlation fall out of one lookup
// instead of N special cases.
//
// The path registry remains the authority for which range variable supplies a
// path/aspect (ADR 0064). SQL lowering now stores typed expressions and serializes
// the relation tree through the SQL AST. Existing compiler call sites still use
// the explicit string adapters while their expression families migrate (ADR
// 0069); those fragments do not receive structural scope validation.

import type { PathId, Set as IRSet, TypeRef } from "../ir/gel_ir.js";
import type { ScalarValue } from "../types.js";
import { sql, sqlBinding, type SqlBinding, type SqlExpr, type SqlSelect } from "./sql_ast.js";
import { renderSqlAst, renderSqlExpr } from "./sql_ast_renderer.js";

// Matches the one-liner replicated in engine.ts / schema_materialize.ts / etc.
const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

/**
 * The "view" of a path requested, mirroring Gel's PathAspect (edb/pgsql/
 * compiler/enums.py). sqlite-ts already makes these distinctions, but across
 * separate code paths (scalar-value SQL vs JSON materialization vs id reads)
 * rather than as one parameter. We model the three that the backend actually
 * needs today. `source` identifies the range-variable alias that provides a
 * row path; unlike value/identity it is intentionally an alias, not a column.
 * `iterator` identifies the current expression produced by json_each.
 */
export type Aspect = "value" | "serialized" | "identity" | "source" | "iterator";

/**
 * Canonical path key -- byte-identical to the backend's
 * `pathIdKey(set) = JSON.stringify(set.pathId)` (gel_ir_compiler.ts), so a
 * registry built from live IR matches the canonical keys used throughout SQL
 * lowering.
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
 * A FROM entry. Prefer `table` or a child `relation`; `sourceSql` is the explicit
 * legacy-source adapter for SQL still assembled by another lowering. A child
 * Relation stays structured so the parent can recursively inject exports before
 * the SQL AST is rendered.
 */
export interface RangeVarInput {
  alias: string;
  binding?: SqlBinding;
  sourceSql?: string;
  table?: { name: string; columns?: readonly string[] };
  /** Exported columns for a legacy source, when its projection is known. */
  columns?: readonly string[];
  relation?: Relation;
  join?: {
    kind: Exclude<JoinKind, "base">;
    on?: string;
    onExpr?: SqlExpr;
  };
  params?: ScalarValue[];
}

export interface RangeVar extends RangeVarInput {
  binding: SqlBinding;
}

interface OutputColumn {
  alias: string;
  expr: SqlExpr;
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
  readonly whereConjuncts: SqlExpr[] = [];
  private readonly outputColumns: OutputColumn[] = [];

  // The registry: pathKey -> aspect -> SQL expression visible IN this relation.
  // Mirrors Gel's `path_namespace` (edb/pgsql/ast.py): "what SQL expression
  // represents this path here?".
  private readonly outputs = new Map<string, Map<Aspect, SqlExpr>>();
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
  // Current-row scopes explicitly visible to SET OF aggregate arguments.
  // Kept separate because a free extent inside an inlined function must not
  // become correlated merely because its caller has a same-type source scope.
  private readonly aggregateScopes = new Map<string, string>();

  constructor(readonly parent?: Relation) {}

  // ---- building -----------------------------------------------------------

  addRangeVar(input: RangeVarInput): RangeVar {
    if (!input.relation && !input.table && input.sourceSql === undefined) {
      throw new Error(
        `Range variable '${input.alias}' requires a table, relation, or legacy source`,
      );
    }
    const rv: RangeVar = { ...input, binding: input.binding ?? sqlBinding(input.alias) };
    this.fromSources.push(rv);
    return rv;
  }

  addWhere(sqlText: string, params: ScalarValue[] = []): void {
    this.addWhereExpr(sql.legacyExpr(sqlText, "Relation.addWhere legacy predicate", params));
  }

  addWhereExpr(expr: SqlExpr): void {
    this.whereConjuncts.push(expr);
  }

  /** Register the SQL expression for a path/aspect visible in this relation. */
  registerPath(pathKey: string, aspect: Aspect, sqlExpr: string): void {
    this.registerPathExpr(
      pathKey,
      aspect,
      sql.legacyExpr(sqlExpr, "Relation.registerPath legacy expression"),
    );
  }

  registerPathExpr(pathKey: string, aspect: Aspect, expr: SqlExpr): void {
    let m = this.outputs.get(pathKey);
    if (!m) {
      m = new Map();
      this.outputs.set(pathKey, m);
    }
    m.set(aspect, expr);
  }

  /** Register a type-root range var so fresh references correlate (question 2). */
  registerScope(scopeKey: string, alias: string): void {
    this.scopes.set(scopeKey, alias);
  }

  /** Register a current-row scope that SET OF aggregate arguments may consume. */
  registerAggregateScope(scopeKey: string, alias: string): void {
    this.registerScope(scopeKey, alias);
    this.aggregateScopes.set(scopeKey, alias);
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
    this.addOutputExpr(alias, sql.legacyExpr(expr, "Relation.addOutput legacy projection"));
  }

  addOutputExpr(alias: string, expr: SqlExpr): void {
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
   * Equivalent to the former innermost-scope lookup: the last local registration
   * wins, followed by parent traversal across nesting.
   */
  correlateScope(scopeKey: string): string | null {
    return this.scopes.get(scopeKey) ?? this.parent?.correlateScope(scopeKey) ?? null;
  }

  /** Resolve an explicitly aggregate-visible scope introduced here. */
  correlateAggregateScope(scopeKey: string): string | null {
    return this.aggregateScopes.get(scopeKey) ?? null;
  }

  /** Whether an alias is supplied by this relation or an enclosing relation. */
  hasAlias(alias: string): boolean {
    if (this.fromSources.some((rv) => rv.alias === alias)) return true;
    if ([...this.scopes.values()].includes(alias)) return true;
    for (const aspects of this.outputs.values()) {
      const source = aspects.get("source");
      if (source && renderSqlExpr(source).sql === alias) return true;
    }
    return this.parent?.hasAlias(alias) ?? false;
  }

  /** Like getPathVar but returns null instead of throwing. */
  tryGetPathVar(pathKey: string, aspect: Aspect): string | null {
    const expr = this.tryGetPathExpr(pathKey, aspect);
    if (expr === null) return null;
    const rendered = renderSqlExpr(expr);
    if (rendered.params.length > 0) {
      throw new Error("A parameterized path expression must be consumed as a SqlExpr");
    }
    return rendered.sql;
  }

  tryGetPathExpr(pathKey: string, aspect: Aspect): SqlExpr | null {
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
      const inner = child.tryGetPathExpr(pathKey, aspect);
      if (inner !== null) {
        const exposed = child.expose(pathKey, aspect, inner);
        const ref = sql.column(rv.binding, exposed);
        this.registerPathExpr(pathKey, aspect, ref); // memoize: don't re-inject
        return ref;
      }
    }

    // (3 across nesting) correlate to an enclosing relation.
    if (this.parent) return this.parent.tryGetPathExpr(pathKey, aspect);
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

  getPathExpr(pathKey: string, aspect: Aspect): SqlExpr {
    const expr = this.tryGetPathExpr(pathKey, aspect);
    if (expr === null) throw new PathNotResolvable(pathKey, aspect);
    return expr;
  }

  /**
   * Ensure this relation projects `pathKey`/`aspect` as an output column and
   * return that column's output alias. Idempotent: a path injected twice reuses
   * the same column. This is the "inject a column the subquery didn't originally
   * expose" half of recursive column injection.
   */
  private expose(pathKey: string, aspect: Aspect, expr: SqlExpr): string {
    const existing = this.outputs.get(pathKey)?.get(aspect);
    const existingRendered = existing ? renderSqlExpr(existing) : undefined;
    const exprRendered = renderSqlExpr(expr);
    const sameRenderedExpr = (candidate: SqlExpr): boolean => {
      const rendered = renderSqlExpr(candidate);
      return (
        rendered.sql === exprRendered.sql &&
        rendered.params.length === exprRendered.params.length &&
        rendered.params.every((value, index) => Object.is(value, exprRendered.params[index]))
      );
    };
    const already = this.outputColumns.find((c) => sameRenderedExpr(c.expr));
    if (already) return already.alias;
    const registered = existingRendered
      ? this.outputColumns.find(
          (c) =>
            quoteIdent(c.alias) === existingRendered.sql && existingRendered.params.length === 0,
        )
      : undefined;
    if (registered) return registered.alias;
    const name = `__inj${injectionCounter}`;
    injectionCounter += 1;
    this.outputColumns.push({ alias: name, expr });
    // Within this relation the path is now readable as its own output alias.
    this.registerPathExpr(
      pathKey,
      aspect,
      sql.legacyExpr(quoteIdent(name), "Relation injected output alias"),
    );
    return name;
  }

  // ---- serialization (once, at the boundary) ------------------------------

  /** Build the structured SELECT representation, retaining legacy leaves explicitly. */
  toSqlAst(): SqlSelect {
    const from = this.fromSources.map((rv, index) => {
      const source = rv.relation
        ? sql.derived(rv.relation.toSqlAst(), rv.binding)
        : rv.table
          ? sql.table(rv.table.name, rv.binding, rv.table.columns)
          : sql.legacySource(
              rv.sourceSql ?? "",
              rv.binding,
              "Relation range source is still emitted by legacy SQL lowering",
              rv.params,
              rv.columns,
            );
      if (index === 0) return { source };
      const join = rv.join;
      if (!join || join.kind === "cross") return { source, join: { kind: "cross" as const } };
      return {
        source,
        join: {
          kind: join.kind,
          on:
            join.onExpr ??
            sql.legacyExpr(join.on ?? "", "Relation join predicate is still emitted as SQL text"),
        },
      };
    });
    const projections =
      this.outputColumns.length > 0
        ? this.outputColumns.map(({ alias, expr }) => ({ expr, alias }))
        : [{ expr: sql.star() }];
    const where = this.whereConjuncts.reduce<SqlExpr | undefined>(
      (acc, expr) => (acc ? sql.binary("AND", acc, expr) : expr),
      undefined,
    );
    return sql.select({ projections, from, where });
  }

  /** Serialize the structured relation to SQL and parameters in render order. */
  toSql(): { sql: string; params: ScalarValue[] } {
    return renderSqlAst(this.toSqlAst());
  }
}
