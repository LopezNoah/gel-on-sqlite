// Scope-tree POPULATION (Phase 1).
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
// LAYER 2 - the correlated-vs-factored discriminator. EdgeQL factors (zips) two
// path references at their longest common prefix UNLESS that prefix is reached
// through a factored view. Gel realizes this by compiling an alias/view-shape
// computable in a DETACHED context that mints a FRESH `path_id_namespace` per
// occurrence (edb/edgeql/compiler/context.py:768, stmtctx.py:143): two refs to
// `U.cards` get different namespaces -> don't fuse -> cross-product (factored).
// Schema pointers - even computed ones like `owners := .<deck[IS User]` - share
// the namespace -> fuse -> correlated. We reproduce that here: a path step that
// traverses an inline alias-shape view computable (a `:=`-defined shape element
// of a WITH binding's body) gets a fresh per-occurrence namespace, so repeated
// traversals split into sibling nodes.
//
// Invoked additively (like `inferStatementVolatility`) and STRICTLY
// behaviour-neutral: nothing on the execution path reads `Statement.scopeTree`.
// Path identities are STRUCTURAL signatures (segment names + view namespaces),
// sufficient for prefix fusing / factoring; resolving them to real IR PathIds is
// layer 3 (the find_factorable_nodes wiring), deferred (see ADR 0061).

import type { ScopeTreeNode, PathId } from "./gel_ir.js";
import { pathIdKey } from "./scope_tree.js";

interface BuildState {
  nextId: number;
  nextNs: number;
  // Guard against revisiting shared AST sub-objects (the AST is a tree but refs
  // can alias) so the generic recursion can never loop or blow the stack.
  seen: WeakSet<object>;
}

// Visible WITH/alias bindings: name -> its body's top-level shape elements (used
// to decide whether a traversed field is an inline view computable).
type AstObject = Record<string, unknown>;
type Bindings = Map<string, { shape: unknown[] }>;

const asAstObject = (value: unknown): AstObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as AstObject)
    : undefined;

// One path segment: its name and whether it traverses an inline view computable
// (and therefore opens a fresh per-occurrence namespace).
interface Seg {
  name: string;
  computable: boolean;
}

const newNode = (state: BuildState, init: Partial<ScopeTreeNode>): ScopeTreeNode => {
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

// A structural path identity: synthetic PathId whose steps key off segment names
// and whose namespace carries any view namespace. JSON.stringify (the backend's
// `pathIdKey`) over this gives a stable fusing key.
const sigToPathId = (names: string[], ns: string[]): PathId => ({
  kind: "path_id",
  namespace: ns,
  isPointerPath: names.length > 1,
  steps: names.map((name) => ({
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

// Attach a path (a list of segments) under `scope`, nesting by prefix and fusing
// existing prefix nodes - mirrors scopetree.py `attach_path`. The first segment
// that traverses an inline view computable opens a FRESH namespace for this
// occurrence; that namespace is carried by it and every segment below, so two
// occurrences of the same view path split into sibling nodes (factored), while
// the prefix above the computable still fuses (visible/correlated).
const attachPath = (scope: ScopeTreeNode, segs: Seg[], state: BuildState): void => {
  if (segs.length === 0) return;
  let parent = scope;
  let ns: string[] = [];
  for (let i = 0; i < segs.length; i += 1) {
    if (segs[i].computable && ns.length === 0) {
      state.nextNs += 1;
      ns = [`vns${state.nextNs}`];
    }
    const prefixId = sigToPathId(
      segs.slice(0, i + 1).map((s) => s.name),
      ns,
    );
    const key = pathIdKey(prefixId);
    let child = parent.children.find((c) => c.pathId !== undefined && pathIdKey(c.pathId) === key);
    if (!child) {
      child = newNode(state, { pathId: prefixId, namespaces: [...ns] });
      parent.children.push(child);
    }
    parent = child;
  }
};

const aliasShapeOf = (value: unknown): unknown[] => {
  const node = asAstObject(value);
  if (!node) return [];
  if (Array.isArray(node.shape)) return node.shape;
  const query = asAstObject(node.query);
  if (query && Array.isArray(query.shape)) return query.shape;
  if (node.expr) return aliasShapeOf(node.expr);
  return [];
};

// Flatten a `field_access` chain (and simple path heads) into a head expr + the
// trailing field names. Returns null for a non-path expr.
const flattenPath = (value: unknown): { head: AstObject; fields: string[] } | null => {
  const e = asAstObject(value);
  if (!e) return null;
  switch (e.kind) {
    case "field_access": {
      const inner = flattenPath(e.expr);
      if (typeof e.field !== "string") return null;
      if (inner) return { head: inner.head, fields: [...inner.fields, e.field] };
      const head = asAstObject(e.expr);
      return head ? { head, fields: [e.field] } : null;
    }
    case "binding_ref":
    case "select":
      return { head: e, fields: [] };
    case "path": {
      if (typeof e.head !== "string") return null;
      return {
        head: { kind: "object_head", name: e.head },
        fields: typeof e.tail === "string" ? [e.tail] : [],
      };
    }
    case "path_chain": {
      const parts = Array.isArray(e.parts) ? e.parts : [];
      const [head, ...tail] = parts;
      return typeof head === "string"
        ? {
            head: { kind: "object_head", name: head },
            fields: tail.filter((part): part is string => typeof part === "string"),
          }
        : null;
    }
    default:
      return null;
  }
};

// Resolve a path-ish expr to segments, marking inline view-computable steps.
// Returns null when the expr is not a simple path (so the walker recurses).
const pathSegments = (e: unknown, bindings: Bindings): Seg[] | null => {
  const flat = flattenPath(e);
  if (!flat) return null;
  const head = flat.head;

  let baseName: string | undefined;
  let shapeCursor: unknown[] | null = null;
  if (head.kind === "binding_ref" || head.kind === "object_head") {
    if (typeof head.name !== "string") return null;
    baseName = head.name;
    shapeCursor = bindings.get(head.name)?.shape ?? null;
  } else if (head.kind === "select") {
    if (typeof head.typeName !== "string") return null;
    baseName = head.typeName; // a direct extent - no view shape to track
  } else {
    return null; // head is a sub-expression; let the walker recurse into it
  }
  if (!baseName) return null;

  const segs: Seg[] = [{ name: baseName, computable: false }];
  for (const field of flat.fields) {
    let computable = false;
    if (shapeCursor) {
      const el = shapeCursor.map(asAstObject).find((item) => item?.name === field);
      // A `:=`-defined shape element (has `expr`) is a view computable; a plain
      // projected link (`deck: { ... }`) has a sub-shape but no `expr`.
      if (el && el.expr != null) computable = true;
      const query = asAstObject(el?.query);
      const nestedShape = el?.shape ?? query?.shape;
      shapeCursor = Array.isArray(nestedShape) ? nestedShape : null;
    }
    segs.push({ name: field, computable });
  }
  return segs;
};

// Expr kinds that introduce a fenced sub-scope (a SET OF / subquery boundary).
const FENCE_KINDS = new Set(["select", "exists"]);

// Recursively walk an AST expr, attaching paths and fences under `scope`.
const walkExpr = (
  value: unknown,
  scope: ScopeTreeNode,
  state: BuildState,
  bindings: Bindings,
): void => {
  const e = asAstObject(value);
  if (!e) return;
  if (state.seen.has(e)) return;
  state.seen.add(e);

  // Path-ish expr: attach it (fusing prefixes, splitting view computables) and
  // stop - its internals are the path chain, already captured.
  const segs = pathSegments(e, bindings);
  if (segs) {
    attachPath(scope, segs, state);
    return;
  }

  if (e.kind === "for_expr") {
    walkExpr(e.iterator, scope, state, bindings);
    const body = attachBranch(scope, state);
    if (typeof e.variable === "string")
      attachPath(body, [{ name: e.variable, computable: false }], state);
    walkExpr(e.body, body, state, bindings);
    return;
  }

  // A real subquery / EXISTS is a fence.
  const childScope =
    typeof e.kind === "string" && FENCE_KINDS.has(e.kind) ? attachFence(scope, state) : scope;

  // WITH bindings (on a `select_expr`/`select`): each binding body is a detached
  // fenced scope; register the binding's shape so later references can tell an
  // inline view computable from a schema pointer.
  let childBindings = bindings;
  if (Array.isArray(e.with) && e.with.length > 0) {
    childBindings = new Map(bindings);
    for (const value of e.with) {
      const binding = asAstObject(value);
      if (binding && typeof binding.name === "string") {
        childBindings.set(binding.name, { shape: aliasShapeOf(binding.value) });
      }
    }
    for (const value of e.with) {
      const binding = asAstObject(value);
      if (!binding) continue;
      const bScope = attachFence(childScope, state);
      walkExpr(binding.value, bScope, state, childBindings);
    }
  }
  if (e.kind === "subquery" && e.query) {
    walkExpr(e.query, childScope, state, childBindings);
    return;
  }

  // Recurse into every child expr/array generically so paths nested in
  // unmodelled expr kinds still get attached.
  for (const [k, v] of Object.entries(e)) {
    if (k === "with" || k === "span" || k === "pos") continue;
    if (Array.isArray(v)) v.forEach((c) => walkExpr(c, childScope, state, childBindings));
    else if (asAstObject(v)) walkExpr(v, childScope, state, childBindings);
  }
};

// Decide, for a tuple of path expressions (e.g. a `count((a, b, ...))` arg),
// whether its elements share a CORRELATED immediate object prefix (the tuple
// ZIPS - count = prefix rows) or are FACTORED (cross product). This is the
// layer-3 factoring verdict applied directly to the AST tuple + the WITH
// bindings in scope, where alias/view boundaries are still visible (the Live IR
// has erased them - see ADR 0061). Returns null when the rule does not apply
// (not all elements are simple equal-depth shared-prefix paths) so the caller
// falls back to the product path.
export const tupleSharedPrefixCorrelated = (
  elementAsts: unknown[],
  astBindings: Map<string, unknown>,
): boolean | null => {
  if (elementAsts.length < 2) return null;
  const bindings: Bindings = new Map();
  for (const [name, value] of astBindings) bindings.set(name, { shape: aliasShapeOf(value) });
  const segLists = elementAsts.map((e) => pathSegments(e, bindings));
  if (segLists.some((s) => s === null)) return null;
  const sl = segLists as Seg[][];
  const depth = sl[0].length;
  if (depth < 2) return null; // need at least <prefix>.<leaf>
  const prefixLen = depth - 1;
  for (const s of sl) {
    if (s.length !== depth) return false; // different depth -> not a shared immediate prefix
    for (let i = 0; i < prefixLen; i += 1) {
      if (s[i].name !== sl[0][i].name) return false; // independent prefixes
      if (s[i].computable) return false; // view computable in the shared prefix -> factored
    }
  }
  return true;
};

// Build a populated scope tree from an EdgeQL statement AST. The root is a fence
// (the statement boundary), mirroring Gel. Purely structural; behaviour-neutral.
export const buildScopeTreeFromAst = (statement: unknown): ScopeTreeNode => {
  const state: BuildState = { nextId: 1, nextNs: 0, seen: new WeakSet<object>() };
  const root = newNode(state, { fenced: true });
  walkExpr(statement, root, state, new Map());
  return root;
};
