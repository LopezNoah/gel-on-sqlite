// Scope-tree planning authority — a faithful (lightweight) port of Gel's
// `edb/ir/scopetree.py`, derived from the finished Live IR.
//
// WHY THIS EXISTS
// ---------------
// sqlite-ts answers "what SQL expression represents this EdgeQL path here, and
// is it correlated to an enclosing iteration or independent?" with scattered,
// hand-threaded knobs (GelIRCompileOptions.outerScopes / sourcePathAliases /
// multiScalarBindings, plus inline markers like `isWithBinding`). Gel answers
// the same question from ONE structure: the scope tree. A path is *visible* at
// a point iff some ancestor scope already binds it; two references to a shared
// prefix *factor* (zip / correlate) iff that prefix is visible across at most
// one fence between them. This module builds that tree from the IR `Set` tree
// and exposes the two queries the backend needs (`isVisible`, shared-prefix
// factoring), so correlation decisions can consult a single authority instead
// of N special cases.
//
// FAITHFULNESS / SCOPE
// --------------------
// We build the tree POST-IR (from `Statement.expr`) rather than during
// ast_to_ir, because the IR already carries the fence signals we need:
//   - a function/operator argument with `paramTypemod === "set_of"` is a SET OF
//     boundary (scopetree.py: `fenced`);  `"optional"` marks an optional branch.
//   - a sub-`select_expr` is a fenced subquery; a `for_expr` introduces a
//     binding scope whose iterator is visible in the body.
// Path references (`type_root` / `pointer` chains) are attached as nested path
// nodes, MERGED by path id, so two leaves that share a prefix share that
// prefix's node — which is exactly the structural fact that distinguishes
// `count((A.x, A.y))` (shared prefix A) from `count((A.x, B.y))` (independent).
//
// This module is PURELY ADDITIVE: building it has no effect on lowering until a
// caller consults it. `expressions stay strings` design from relation.ts holds —
// this is structure only, no SQL.

import type {
  Set as IRSet,
  Expr,
  PathId,
  ScopeTreeNode,
  CallArg,
  Tuple,
  ArrayExpr,
  SelectExpr,
  ForExpr,
  TypeCast,
  IfElseExpr,
  ExistsExpr,
} from "./gel_ir.js";

/** Canonical path key — byte-identical to relation.ts `pathIdKeyOf` and the
 *  backend's `pathIdKey`, so the scope tree shares keys with the path registry. */
export const pathIdKey = (p: PathId): string => JSON.stringify(p);

// An expr kind whose Set has a `.source` prefix Set (a path step).
const PATH_STEP_KINDS = new Set([
  "pointer",
  "type_intersection_pointer",
  "tuple_indirection_pointer",
]);

const isPathStep = (e: Expr): e is Expr & { source: IRSet } =>
  PATH_STEP_KINDS.has(e.kind);

/** The result of building a scope tree: the populated root plus the ephemeral
 *  parent index (kept OUT of the serializable `ScopeTreeNode` so the IR stays
 *  acyclic / JSON-safe), and a path-key → nodes index. */
export interface ScopeAnalysis {
  root: ScopeTreeNode;
  parentOf(node: ScopeTreeNode): ScopeTreeNode | undefined;
  /** Every node (branch or path) carrying this exact path id. */
  nodesForPath(key: string): ScopeTreeNode[];

  /**
   * Is `pathId` visible from `fromNode` — i.e. does `fromNode` or any of its
   * ancestors (or their direct children) already bind it? Mirrors scopetree.py
   * `is_visible` / `find_visible`. Factoring fences do NOT hide a path for
   * visibility; they only constrain factoring (see `sharedFactorPrefix`).
   */
  isVisible(fromNode: ScopeTreeNode, pathId: PathId): boolean;

  /**
   * The deepest path id that two path-leaf nodes share as a common ancestor in
   * the tree — the prefix at which they would factor (zip / correlate). Returns
   * null when they share no path prefix (independent → cross product). This is
   * the structural discriminator for tuples/aggregates over a shared prefix.
   */
  sharedFactorPrefix(a: ScopeTreeNode, b: ScopeTreeNode): PathId | null;

  /** All path-leaf nodes (deepest path nodes) at or below `node`. */
  pathLeavesUnder(node: ScopeTreeNode): ScopeTreeNode[];
}

class Builder {
  private uid = 1;
  readonly parent = new Map<ScopeTreeNode, ScopeTreeNode>();
  // visited Set objects guard against shared sub-objects (shapeSource, etc.)
  // causing infinite recursion; the IR is a tree but refs can alias.
  private readonly walked = new WeakSet<object>();

  private node(init: Partial<ScopeTreeNode>, parent?: ScopeTreeNode): ScopeTreeNode {
    const n: ScopeTreeNode = {
      kind: "scope_tree_node",
      uniqueId: (this.uid += 1),
      children: [],
      namespaces: [],
      fenced: false,
      optional: false,
      ...init,
    };
    if (parent) {
      parent.children.push(n);
      this.parent.set(n, parent);
    }
    return n;
  }

  build(rootSet: IRSet): ScopeTreeNode {
    const root = this.node({ fenced: true }); // the statement itself is a fence
    this.walk(rootSet, root);
    return root;
  }

  /** Ensure a child path node for `pathId` under `parent`, MERGING by path key
   *  so two references that share a prefix share that prefix's node. */
  private ensurePathNode(parent: ScopeTreeNode, pathId: PathId): ScopeTreeNode {
    const key = pathIdKey(pathId);
    const existing = parent.children.find((c) => c.pathId && pathIdKey(c.pathId) === key);
    if (existing) return existing;
    return this.node({ pathId, namespaces: [...(pathId.namespace ?? [])] }, parent);
  }

  /** Attach a path Set as nested path nodes (merging by path key), returning the
   *  leaf path node. Non-path bases (subqueries, calls under a `.foo`) are
   *  fence-walked at the current scope and the path is rooted there. */
  private attachPath(scope: ScopeTreeNode, set: IRSet): ScopeTreeNode {
    const e = set.expr;
    let parent: ScopeTreeNode = scope;
    if (isPathStep(e)) {
      const src = e.source;
      if (isPathStep(src.expr) || src.expr.kind === "type_root") {
        parent = this.attachPath(scope, src);
      } else {
        this.walk(src, scope); // base is a computed expr → walk it for fences
        parent = scope;
      }
    }
    if (!set.pathId) return parent;
    const child = this.ensurePathNode(parent, set.pathId);
    // Also walk a computed pointer's body for fences inside it.
    if (e.kind === "pointer" && (e as { expr?: Expr }).expr) {
      this.walkExpr((e as { expr: Expr }).expr, child);
    }
    return child;
  }

  private walk(set: IRSet, scope: ScopeTreeNode): void {
    if (this.walked.has(set)) return;
    this.walked.add(set);
    this.walkExpr(set.expr, scope, set);
    // A shape (`Card { foo := … }`) is evaluated per row of `set`: its computed
    // elements can correlate to the row's own path. Walk them in a child scope
    // where the set's path is visible.
    const shape = (set as { shape?: Array<{ expr?: IRSet }> }).shape;
    if (shape && shape.length > 0) {
      const shapeScope = this.node({}, scope);
      if (set.pathId) this.ensurePathNode(shapeScope, set.pathId);
      for (const el of shape) {
        if (el.expr) this.walk(el.expr, shapeScope);
      }
    }
  }

  private walkExpr(e: Expr, scope: ScopeTreeNode, owningSet?: IRSet): void {
    switch (e.kind) {
      case "type_root":
        if (owningSet) this.attachPath(scope, owningSet);
        return;

      case "pointer":
      case "type_intersection_pointer":
      case "tuple_indirection_pointer":
        if (owningSet) this.attachPath(scope, owningSet);
        return;

      case "function_call":
      case "operator_call": {
        const call = e as { args: Record<string, CallArg>; body?: IRSet };
        for (const arg of Object.values(call.args)) {
          // A SET OF argument (Gel `fenced`) OR an argument the IR builder
          // marked as a factored binding (`isWithBinding` / `isFactoringProtected`,
          // see ADR 0059) introduces a fence. The factored-binding mark is a
          // FACTORING fence: it records "count the whole set, do not correlate to
          // an enclosing row" — the one fact that, post WITH-inlining, the
          // lexical IR no longer carries (the inline and factored forms are
          // otherwise byte-identical). Folding it into the tree here is what lets
          // the scope tree reproduce the inline-vs-factored decision.
          const factored = isFactoredBinding(arg.expr);
          if (arg.paramTypemod === "set_of" || factored) {
            this.walk(arg.expr, this.node({ fenced: true, factoringFence: factored }, scope));
          } else if (arg.paramTypemod === "optional") {
            this.walk(arg.expr, this.node({ optional: true }, scope));
          } else {
            this.walk(arg.expr, scope);
          }
        }
        if (call.body) this.walk(call.body, scope);
        return;
      }

      case "tuple":
        for (const el of (e as Tuple).elements) this.walk(el.val, scope);
        return;

      case "array":
        for (const el of (e as ArrayExpr).elements) this.walk(el, scope);
        return;

      case "select_expr": {
        const sel = e as SelectExpr;
        // A real subquery is a fence; an implicit wrapper reuses the scope so it
        // does not introduce a spurious boundary.
        const sub = sel.implicitWrapper ? scope : this.node({ fenced: true }, scope);
        this.walk(sel.result, sub);
        if (sel.where) this.walk(sel.where, sub);
        for (const o of sel.orderBy ?? []) this.walk(o.path, sub);
        if (sel.limit) this.walk(sel.limit, sub);
        if (sel.offset) this.walk(sel.offset, sub);
        return;
      }

      case "for_expr": {
        const f = e as ForExpr;
        this.walk(f.iterator, scope); // iterator is evaluated in the outer scope
        const body = this.node({}, scope); // FOR body is a child binding scope
        this.attachPath(body, f.iterator); // iterator visible inside the body
        this.walk(f.body, body);
        if (f.where) this.walk(f.where, body);
        for (const o of f.orderBy ?? []) this.walk(o.path, body);
        if (f.limit) this.walk(f.limit, body);
        if (f.offset) this.walk(f.offset, body);
        return;
      }

      case "if_else_expr": {
        const ie = e as IfElseExpr;
        this.walk(ie.condition, scope);
        this.walk(ie.ifExpr, scope);
        this.walk(ie.elseExpr, scope);
        return;
      }

      case "exists_expr":
        // EXISTS is a SET OF context → fenced.
        this.walk((e as ExistsExpr).expr, this.node({ fenced: true }, scope));
        return;

      case "type_cast":
        this.walk((e as TypeCast).expr, scope);
        return;

      default:
        // Best-effort: recurse into any directly-contained Sets so paths nested
        // inside an unmodelled expr kind still get attached at this scope.
        for (const child of directChildSets(e)) this.walk(child, scope);
    }
  }
}

/** Shallow scan for `{kind:"set"}` values directly held by an expr (in its own
 *  fields or one level of arrays / `{val|expr}` wrappers). Conservative — used
 *  only as the fallback for expr kinds the walker does not model explicitly. */
function directChildSets(e: Expr): IRSet[] {
  const out: IRSet[] = [];
  const consider = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    const o = v as { kind?: unknown; val?: unknown; expr?: unknown };
    if (o.kind === "set") {
      out.push(v as IRSet);
    } else if (o.val && (o.val as { kind?: unknown }).kind === "set") {
      out.push(o.val as IRSet);
    } else if (o.expr && (o.expr as { kind?: unknown }).kind === "set") {
      out.push(o.expr as IRSet);
    }
  };
  for (const v of Object.values(e as unknown as Record<string, unknown>)) {
    if (Array.isArray(v)) v.forEach(consider);
    else consider(v);
  }
  return out;
}

/** Whether a Set was marked by the IR builder as a FACTORED binding — a count
 *  argument pulled out of a `WITH a := …` (ADR 0059) or otherwise protected from
 *  prefix factoring. These flags are the post-inlining residue of a factoring
 *  fence (see the function-call case in the builder). Broader than the live
 *  `countArgIsFactored` signal: it also honours `isFactoringProtected` so the
 *  TREE models the full fence even where the count lowering does not yet act on
 *  it. */
function isFactoredBinding(set: IRSet): boolean {
  const s = set as { isWithBinding?: unknown; isFactoringProtected?: boolean };
  return s.isWithBinding === true || s.isWithBinding === "with" || s.isFactoringProtected === true;
}

/**
 * The factoring-fence signal the COUNT lowering acts on — exact home for the
 * decision that was inline in `compileCountOfSetSQL` (ADR 0059). `count(<single
 * scalar prop>)` written inline in a shape correlates to the enclosing row
 * (per-row 0/1); the SAME expression factored into a `WITH a := …` counts the
 * whole set. After WITH-inlining the only surviving difference is the
 * `isWithBinding` mark stamped on the count argument — so this is the one fact
 * the scope tree (and the SQL backend) consult to tell the two apart.
 *
 * Deliberately NARROW (only `isWithBinding`) so routing the live count gate
 * through this is byte-for-byte behaviour-neutral; the tree's `isFactoredBinding`
 * carries the broader fence semantics for when the lowering grows to use them.
 */
export const countArgIsFactored = (set: object): boolean =>
  Boolean((set as { isWithBinding?: unknown }).isWithBinding);

/** Build the scope tree + analysis for an IR root Set (a statement's `expr`). */
export function buildScopeAnalysis(rootSet: IRSet): ScopeAnalysis {
  const b = new Builder();
  const root = b.build(rootSet);

  const byPath = new Map<string, ScopeTreeNode[]>();
  const indexNode = (n: ScopeTreeNode): void => {
    if (n.pathId) {
      const k = pathIdKey(n.pathId);
      const bucket = byPath.get(k);
      if (bucket) bucket.push(n);
      else byPath.set(k, [n]);
    }
    n.children.forEach(indexNode);
  };
  indexNode(root);

  const ancestors = (n: ScopeTreeNode): ScopeTreeNode[] => {
    const chain: ScopeTreeNode[] = [];
    let cur: ScopeTreeNode | undefined = n;
    while (cur) {
      chain.push(cur);
      cur = b.parent.get(cur);
    }
    return chain;
  };

  return {
    root,
    parentOf: (n) => b.parent.get(n),
    nodesForPath: (k) => byPath.get(k) ?? [],

    isVisible(fromNode, pathId) {
      const key = pathIdKey(pathId);
      for (const anc of ancestors(fromNode)) {
        if (anc.pathId && pathIdKey(anc.pathId) === key) return true;
        if (anc.children.some((c) => c.pathId && pathIdKey(c.pathId) === key)) return true;
      }
      return false;
    },

    sharedFactorPrefix(a, b2) {
      const ca = ancestors(a).reverse(); // root → a
      const cb = ancestors(b2).reverse(); // root → b
      let shared: ScopeTreeNode | null = null;
      const n = Math.min(ca.length, cb.length);
      for (let i = 0; i < n; i += 1) {
        if (ca[i] !== cb[i]) break;
        if (ca[i].pathId) shared = ca[i];
      }
      return shared?.pathId ?? null;
    },

    pathLeavesUnder(node) {
      const leaves: ScopeTreeNode[] = [];
      const visit = (n: ScopeTreeNode): void => {
        const pathChildren = n.children.filter((c) => c.pathId);
        if (n.pathId && pathChildren.length === 0) leaves.push(n);
        n.children.forEach(visit);
      };
      visit(node);
      return leaves;
    },
  };
}
