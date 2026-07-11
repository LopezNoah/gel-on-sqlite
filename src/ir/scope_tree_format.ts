// Serialize a scope tree (`gel_ir.ts` ScopeTreeNode) to Gel's canonical
// `scopetree.py` debug pformat — the FENCE/BRANCH tree with uid / namespace /
// flag annotations, e.g.
//
//   "FENCE": {
//       "FENCE uid:6 ns~2": {
//           "(Card)": {
//               "(Card.cost)",
//               "(Card.name)"
//           }
//       }
//   }
//
// This is the scope-tree sibling of `pathid_format.ts` (which mirrors
// `pathid.py:pformat_internal`). It gives the populated `Statement.scopeTree` a
// canonical, golden-pinnable serialization instead of the bespoke structural
// assertions in `scope_builder.test.ts`, and a debug surface for the
// correlated-vs-factored analysis.
//
// FAITHFULNESS — mirrors `scopetree.py` `ScopeTreeNode.pdebugformat` (the tree
// recursion) + `debugname` (the per-node label):
//   - a node with no path id is `FENCE` (fenced) or `BRANCH`, `+ " [OPT]"` when
//     optional;  a path node renders its path id;
//   - the label then appends `uid:N`, the node's `namespaces`, `no-factor`
//     (factoringFence) and `group` (isGroup), space-joined — exactly Gel's order.
//   - a node with children renders `"<label>": { <indented children> }`; a leaf
//     renders just `"<label>"`.
// sqlite-ts's ScopeTreeNode models every `debugname` part EXCEPT Gel's
// `unnest_fence` (`no-unnest`), which sqlite-ts does not track.
//
// PATH IDS — rendered through `serializePathId` (the `pathid_format.ts`
// authority) when they are real live-IR paths. The AST-populated tree currently
// carries STRUCTURAL `sig:` path ids (segment names, no pointer steps — see
// `scope_builder.ts`), rendered here as their dotted segment chain. As real
// PathIds land in the tree (the Gel-parity naming work), the real-path branch
// renders Gel-faithful names for free, with no change here.

import type { PathId, ScopeTreeNode } from "./gel_ir.js";
import { serializePathId } from "./pathid_format.js";

/** The AST scope builder mints synthetic `sig:<name>` path ids (no pointer
 *  steps); real live-IR paths never do. */
const isSyntheticPathId = (pathId: PathId): boolean =>
  (pathId.steps[0]?.type.id ?? "").startsWith("sig:");

const namespacePrefix = (pathId: PathId): string =>
  pathId.namespace.length > 0 ? `${[...pathId.namespace].sort().join("@")}@@` : "";

/** Render a node's path id: the dotted segment chain for the AST tree's
 *  synthetic `sig:` ids, else the canonical `pathid_format` rendering. */
const formatNodePathId = (pathId: PathId): string => {
  if (isSyntheticPathId(pathId)) {
    const segs = pathId.steps.map((s) => s.type.nameHint ?? s.type.id).join(".");
    return `${namespacePrefix(pathId)}(${segs})`;
  }
  return serializePathId(pathId);
};

/** A node's label — mirrors `scopetree.py` `ScopeTreeNode.debugname`. The node's
 *  own `namespaces` are appended only for FENCE/BRANCH nodes; a path node carries
 *  its namespace on the path id itself (the `ns@@` prefix), as in Gel, so
 *  appending it again would double-print. */
const debugName = (node: ScopeTreeNode): string => {
  const base =
    node.pathId === undefined ? (node.fenced ? "FENCE" : "BRANCH") : formatNodePathId(node.pathId);
  const parts = [`${base}${node.optional ? " [OPT]" : ""}`];
  if (node.uniqueId) parts.push(`uid:${node.uniqueId}`);
  if (node.pathId === undefined && node.namespaces.length > 0) {
    parts.push(node.namespaces.join(","));
  }
  if (node.factoringFence) parts.push("no-factor");
  if (node.isGroup) parts.push("group");
  return parts.join(" ");
};

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/**
 * Serialize a scope tree to Gel's `pdebugformat`. Stable and deterministic:
 * children render in tree order, so a golden changes only when the tree shape
 * changes.
 */
export const formatScopeTree = (node: ScopeTreeNode): string => {
  const name = `"${debugName(node)}"`;
  const childFormats = node.children.map(formatScopeTree).filter((s) => s.length > 0);
  if (childFormats.length > 0) {
    return `${name}: {\n${indent(childFormats.join(",\n"))}\n}`;
  }
  return name;
};
