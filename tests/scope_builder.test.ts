import { describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { buildScopeTreeFromAst } from "../src/ir/scope_builder.js";
import type { ScopeTreeNode } from "../src/ir/gel_ir.js";

// Phase-1 layer-1 foundation: the scope tree is POPULATED (not the old empty
// stub) with fences + prefix-fused path nodes walked from the AST. These pin the
// structural shape; the correlated-vs-factored namespace discriminator (layer 2)
// is deferred (see docs/adr/0061).

const treeOf = (q: string): ScopeTreeNode => {
  const ast = parseEdgeQL(q) as unknown;
  const stmt = Array.isArray(ast) ? ast[0] : ast;
  return buildScopeTreeFromAst(stmt);
};

const seg = (n: ScopeTreeNode): string =>
  (n.pathId?.steps ?? []).map((s) => (s.type as { nameHint?: string })?.nameHint ?? "?").join(".");

const find = (n: ScopeTreeNode, name: string): ScopeTreeNode | undefined => {
  if (seg(n) === name) return n;
  for (const c of n.children) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
};

describe("scope_builder (Phase 1, layer 1)", () => {
  it("populates a real tree (not the empty stub)", () => {
    const root = treeOf("SELECT count((Card.name, Card.cost))");
    expect(root.fenced).toBe(true); // statement boundary is a fence
    expect(root.children.length).toBeGreaterThan(0); // not the empty stub
  });

  it("fuses a shared prefix: Card.name and Card.cost share one Card node", () => {
    const root = treeOf("SELECT count((Card.name, Card.cost))");
    const card = find(root, "Card");
    expect(card).toBeDefined();
    const leaves = card!.children.map(seg).sort();
    expect(leaves).toEqual(["Card.cost", "Card.name"]);
  });

  it("fuses a pointer-chain prefix: Card.owners.{name,deck_cost} share Card.owners", () => {
    const root = treeOf("SELECT count((Card.owners.name, Card.owners.deck_cost))");
    const owners = find(root, "Card.owners");
    expect(owners).toBeDefined();
    expect(owners!.children.map(seg).sort()).toEqual([
      "Card.owners.deck_cost",
      "Card.owners.name",
    ]);
  });

  it("a WITH-binding body is a fenced sub-scope", () => {
    const root = treeOf(
      "WITH U := User { cards := Card }, SELECT count((U.cards.name, U.cards.cost))",
    );
    // The binding body (User { ... }) lives under its own fence node.
    const userNode = find(root, "User");
    expect(userNode).toBeDefined();
    const fenceChildren = root.children.filter((c) => c.fenced);
    expect(fenceChildren.length).toBeGreaterThan(0);
    // The U references still fuse structurally at U.cards (layer 1); the
    // per-occurrence namespace that splits them (factored vs correlated) is layer 2.
    const uCards = find(root, "U.cards");
    expect(uCards).toBeDefined();
    expect(uCards!.children.map(seg).sort()).toEqual([
      "U.cards.cost",
      "U.cards.name",
    ]);
  });

  it("does not throw on non-select statements", () => {
    expect(() => treeOf("INSERT Card { name := 'x', element := 'Fire', cost := 1 }")).not.toThrow();
  });
});
