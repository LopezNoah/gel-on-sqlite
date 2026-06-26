// Scope-tree POPULATION (Phase 1, layer 1 - structural foundation).
//
// Gel builds its scope tree DURING ast_to_ir (`attach_path`/`attach_fence`,
// edb/ir/scopetree.py:405) so fences survive before inlining erases them; the
// tree is then queried for correlation/factoring decisions
// (`find_factorable_nodes`, :936). sqlite-ts left `Statement.scopeTree` an empty
// stub (`createRootScope()`), so by lowering time the factoring fences are gone
// (see docs/adr/0061).
//
// This module populates that stub by walking the *AST* - which still carries the
// pre-inlining structure (WITH aliases, sub-SELECTs, FOR bodies, EXISTS are all
// explicit) - and attaching:
//   - a FENCE node per scope boundary (sub-SELECT / FOR body / WITH binding /
//     EXISTS), mirroring `attach_fence`;
//   - a PATH node per path reference, nesting by prefix and FUSING shared
//     prefixes (mirroring `attach_path`), so `(Card.name, Card.cost)` share a
//     `Card` node.
//
// It is invoked additively (like `inferStatementVolatility`) and is STRICTLY
// behaviour-neutral: nothing on the execution path reads `Statement.scopeTree`,
// so this only decorates the IR. Path identities here are STRUCTURAL signatures
// (segment names), sufficient for prefix fusing and visibility; resolving them to
// real IR PathIds - and the per-occurrence view namespace that distinguishes a
// FACTORED alias-view traversal from a CORRELATED one (the `U.cards` vs `Card`
// case) - is layer 2, deferred (see ADR 0061).

import type { ScopeTreeNode, PathId } from "./gel_ir.js";
import { pathIdKey } from "./scope_tree.js";

interface BuildState {
  nextId: number;
  // Guard against revisiting shared AST sub-objects (the AST is a tree but refs
  // can alias) so the generic recursion can never loop or blow the stack.
  seen: WeakSet<object>;
}

const newNode = (
  state: BuildState,
  init: Partial<ScopeTreeNode>,
): ScopeTreeNode => {
  state.nextId += 1;
  return {
    kind: "scope_tree_node",
    uniqueId: state.nextId,
    children: [],
    namespaces: [],
    fenced: false,
    optional: false,
    ...init,
  };
};

const attachFence = (parent: ScopeTreeNode, state: BuildState): ScopeTreeNode => {
  const node = newNode(state, { fenced: true });
  parent.children.push(node);
  return node;
};

const attachBranch = (parent: ScopeTreeNode, state: BuildState): ScopeTreeNode => {
  const node = newNode(state, {});
  parent.children.push(node);
  return node;
};

// A structural path identity: synthetic PathId whose steps key off segment
// names. JSON.stringify (the backend's `pathIdKey`) over this gives a stable
// fusing key, so two references to the same path share a node.
const sigToPathId = (segments: string[]): PathId => ({
  kind: "path_id",
  namespace: [],
  isPointerPath: segments.length > 1,
  steps: segments.map((name) => ({
    type: {
      kind: "type_ref",
      id: `sig:${name}`,
      nameHint: name,
      module: "",
      isView: false,
      isScalar: false,
      isAbstract: false,
      inSchema: false,
      children: [],
    },
  })) as PathId["steps"],
});

// Attach a path (given as a segment signature) under `scope`, nesting by prefix
// and fusing existing prefix nodes - mirrors scopetree.py `attach_path`.
const attachPath = (scope: ScopeTreeNode, segments: string[], state: BuildState): void => {
  if (segments.length === 0) return;
  let parent = scope;
  for (let i = 0; i < segments.length; i += 1) {
    const prefixId = sigToPathId(segments.slice(0, i + 1));
    const key = pathIdKey(prefixId);
    let child = parent.children.find(
      (c) => c.pathId !== undefined && pathIdKey(c.pathId) === key,
    );
    if (!child) {
      child = newNode(state, { pathId: prefixId });
      parent.children.push(child);
    }
    parent = child;
  }
};

// Best-effort segment signature for an AST path-ish expr (`field_access`,
// `binding_ref`, `path`, `path_chain`). Returns null when the expr is not a
// simple path (e.g. its head is a sub-expression we should recurse into).
const pathSignature = (e: any): string[] | null => {
  if (!e || typeof e !== "object") return null;
  switch (e.kind) {
    case "binding_ref":
      return e.name ? [e.name] : null;
    case "field_access": {
      const base = pathSignature(e.expr);
      if (!base) {
        // `(SELECT Card).name`: head is itself an extent - seed from its type.
        const headType = e.expr?.kind === "select" ? e.expr.typeName : undefined;
        return headType && e.field ? [headType, e.field] : null;
      }
      return e.field ? [...base, e.field] : base;
    }
    case "path":
      return e.head ? [e.head, ...(e.tail ? [e.tail] : [])] : null;
    case "path_chain":
      return Array.isArray(e.parts) && e.parts.length ? [...e.parts] : null;
    case "select":
      return e.typeName ? [e.typeName] : null;
    default:
      return null;
  }
};

// Expr kinds that introduce a fenced sub-scope (a SET OF / subquery boundary).
const FENCE_KINDS = new Set(["select", "exists"]);

// Recursively walk an AST expr, attaching paths and fences under `scope`.
const walkExpr = (e: any, scope: ScopeTreeNode, state: BuildState): void => {
  if (!e || typeof e !== "object") return;
  if (state.seen.has(e)) return;
  state.seen.add(e);

  // Path-ish expr: attach it (fusing prefixes) and stop - its internals are the
  // path chain, already captured by the signature.
  const sig = pathSignature(e);
  if (sig) {
    attachPath(scope, sig, state);
    return;
  }

  if (e.kind === "for_expr") {
    // Iterator evaluated in the enclosing scope; body in a child branch where
    // the iterator is visible.
    walkExpr(e.iterator, scope, state);
    const body = attachBranch(scope, state);
    if (e.variable) attachPath(body, [e.variable], state);
    walkExpr(e.body, body, state);
    return;
  }

  // A real subquery / EXISTS is a fence.
  const childScope = FENCE_KINDS.has(e.kind) ? attachFence(scope, state) : scope;

  // WITH bindings (on a `select_expr`/`select`): each binding body is a detached
  // fenced scope.
  if (Array.isArray(e.with)) {
    for (const binding of e.with) {
      const bScope = attachFence(childScope, state);
      walkExpr(binding?.value, bScope, state);
    }
  }
  if (e.kind === "subquery" && e.query) {
    walkExpr(e.query, childScope, state);
    return;
  }

  // Recurse into every child expr/array generically so paths nested in
  // unmodelled expr kinds still get attached.
  for (const [k, v] of Object.entries(e)) {
    if (k === "with" || k === "span" || k === "pos") continue;
    if (Array.isArray(v)) v.forEach((c) => walkExpr(c, childScope, state));
    else if (v && typeof v === "object") walkExpr(v, childScope, state);
  }
};

// Build a populated scope tree from an EdgeQL statement AST. The root is a fence
// (the statement boundary), mirroring Gel. Purely structural; behaviour-neutral.
export const buildScopeTreeFromAst = (statement: any): ScopeTreeNode => {
  const state: BuildState = { nextId: 1, seen: new WeakSet<object>() };
  const root = newNode(state, { fenced: true });
  walkExpr(statement, root, state);
  return root;
};
