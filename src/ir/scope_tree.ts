// Scope-tree FACTORING AUTHORITY — the queries the backend consults to decide
// whether two path references factor (zip / correlate) or stay independent
// (cross product), over the POPULATED scope tree that
// `scope_builder.buildScopeTreeFromAst` attaches to a Statement. A faithful
// (lightweight) port of the relevant slice of Gel's `edb/ir/scopetree.py`.
//
// THE FACTORING VERDICT HAS ONE CONCEPTUAL HOME, two entry points by arg shape:
//   - `tupleSharedPrefixCorrelated` (scope_builder.ts) — the AST tuple verdict,
//     stamped onto the count argument Set by ast_to_ir (`sharedPrefixCorrelated`)
//     and read by the SQL count lowering;
//   - `countArgIsFactored` (here) — the single-scalar-property count signal
//     (`isWithBinding`), the narrow live gate;
//   - `analyzeTreeFactoring` (here) — the `find_factorable_nodes` port over the
//     populated tree. It REPRODUCES the same verdict (pinned in
//     scope_builder.test.ts) and is the convergence target: ADR 0061 layer 3
//     would route the two direct signals above through it, leaving one mechanism.
//
// WHY THERE IS NO IR-DERIVED ANALYSIS HERE
// ----------------------------------------
// An earlier `buildScopeAnalysis` built a scope tree from the FINISHED Live IR.
// It was removed: by the time `ast_to_ir` has inlined `WITH`, the factoring
// fence is ERASED — `count((Card.x, Card.y))` (correlated) and the factored
// alias-view form compile to BYTE-IDENTICAL IR (same path keys, no surviving
// namespace / `isWithBinding` residue; see function_lowering.ts). So an
// IR-derived tree structurally CANNOT separate factored from correlated — the
// fences only survive in the AST, which is why the authority is built there
// (scope_builder.ts) and queried here. (See the ADR for the prune.)

import type { PathId, ScopeTreeNode } from "./gel_ir.js";

/** Canonical path key — byte-identical to relation.ts `pathIdKeyOf` and the
 *  backend's `pathIdKey`, so the scope tree shares keys with the path registry.
 *  Re-used by scope_builder.ts (the population pass). */
export const pathIdKey = (p: PathId): string => JSON.stringify(p);

/**
 * The factoring-fence signal the COUNT lowering acts on — exact home for the
 * decision that was inline in `compileCountOfSetSQL` (ADR 0059). `count(<single
 * scalar prop>)` written inline in a shape correlates to the enclosing row
 * (per-row 0/1); the SAME expression factored into a `WITH a := …` counts the
 * whole set. After WITH-inlining the only surviving difference is the
 * `isWithBinding` mark stamped on the count argument — so this is the one fact
 * the count lowering consults to tell the two apart.
 *
 * Deliberately NARROW (only `isWithBinding`) so routing the live count gate
 * through this is byte-for-byte behaviour-neutral. The broader fence semantics
 * live structurally in the populated tree and are queried via
 * [[analyzeTreeFactoring]] — the convergence target when the count gate grows
 * to consult the tree directly (ADR 0061 layer 3).
 */
export const countArgIsFactored = (set: object): boolean =>
  Boolean((set as { isWithBinding?: unknown }).isWithBinding);

// ---------------------------------------------------------------------------
// Factoring-query authority (Phase 1 layer 3) — a port of Gel's
// `find_factorable_nodes` (edb/ir/scopetree.py:936) over a POPULATED scope tree
// (the one `scope_builder.buildScopeTreeFromAst` attaches to a Statement). Gel:
// two path references factor (zip / correlate) at the deepest common ancestor
// that holds both as descendants with AT MOST ONE fence between them; otherwise
// they are independent (cross product). The populated tree already encodes the
// view-computable split via per-occurrence namespaces (layer 2), so two factored
// references land in sibling nodes and never share their object prefix.
//
// `Set`-shaped consumers (Gel's `shouldFactorTogether(leftSet, rightSet)`) work
// off these tree-node queries once each Set is mapped to its scope-tree leaf.

const buildParentMap = (root: ScopeTreeNode): Map<ScopeTreeNode, ScopeTreeNode> => {
  const parent = new Map<ScopeTreeNode, ScopeTreeNode>();
  const rec = (n: ScopeTreeNode): void => {
    for (const c of n.children) {
      parent.set(c, n);
      rec(c);
    }
  };
  rec(root);
  return parent;
};

export interface TreeFactoring {
  /** Deepest path-leaf nodes (path nodes with no path-node children). */
  pathLeaves(): ScopeTreeNode[];
  /** The deepest common ancestor of `a` and `b` that is a PATH node — the prefix
   *  at which they would factor — or null if they only meet at a fence/branch. */
  sharedFactorPrefix(a: ScopeTreeNode, b: ScopeTreeNode): ScopeTreeNode | null;
  /** Whether `a` and `b` factor together at their IMMEDIATE object prefix: they
   *  share their direct path parent (so e.g. a tuple of them ZIPS rather than
   *  crosses). False when a view-computable split (layer 2) put them in sibling
   *  prefixes, or when a fence separates them. */
  shouldFactorTogether(a: ScopeTreeNode, b: ScopeTreeNode): boolean;
  /** Whether a fence lies between `a`/`b` and their shared factor prefix. */
  isAcrossFactoringFence(a: ScopeTreeNode, b: ScopeTreeNode): boolean;
}

export const analyzeTreeFactoring = (root: ScopeTreeNode): TreeFactoring => {
  const parent = buildParentMap(root);

  const ancestors = (n: ScopeTreeNode): ScopeTreeNode[] => {
    const chain: ScopeTreeNode[] = [];
    let cur: ScopeTreeNode | undefined = n;
    while (cur) {
      chain.push(cur);
      cur = parent.get(cur);
    }
    return chain; // self .. root
  };

  const lca = (a: ScopeTreeNode, b: ScopeTreeNode): ScopeTreeNode | null => {
    const bs = new Set(ancestors(b));
    for (const n of ancestors(a)) if (bs.has(n)) return n;
    return null;
  };

  // Number of fence nodes strictly between `node` and `stop` (exclusive of both).
  const fencesBetween = (node: ScopeTreeNode, stop: ScopeTreeNode): number => {
    let count = 0;
    let cur = parent.get(node);
    while (cur && cur !== stop) {
      if (cur.fenced) count += 1;
      cur = parent.get(cur);
    }
    return count;
  };

  return {
    pathLeaves() {
      const leaves: ScopeTreeNode[] = [];
      const visit = (n: ScopeTreeNode): void => {
        const hasPathChild = n.children.some((c) => c.pathId !== undefined);
        if (n.pathId !== undefined && !hasPathChild) leaves.push(n);
        n.children.forEach(visit);
      };
      visit(root);
      return leaves;
    },

    sharedFactorPrefix(a, b) {
      let cur: ScopeTreeNode | undefined = lca(a, b) ?? undefined;
      while (cur && cur.pathId === undefined) cur = parent.get(cur);
      return cur && cur.pathId !== undefined ? cur : null;
    },

    shouldFactorTogether(a, b) {
      const pa = parent.get(a);
      const pb = parent.get(b);
      return pa !== undefined && pa === pb && pa.pathId !== undefined;
    },

    isAcrossFactoringFence(a, b) {
      const anc = lca(a, b);
      if (!anc) return true;
      return fencesBetween(a, anc) + fencesBetween(b, anc) > 1;
    },
  };
};
