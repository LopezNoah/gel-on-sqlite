import { describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { buildScopeTreeFromAst } from "../src/ir/scope_builder.js";
import { analyzeTreeFactoring } from "../src/ir/scope_tree.js";
import type { ScopeTreeNode } from "../src/ir/gel_ir.js";

// Phase 1: the scope tree is POPULATED (not the old empty stub) with fences +
// path nodes walked from the AST.
//   layer 1 - prefix fusing: `(Card.name, Card.cost)` share a `Card` node.
//   layer 2 - the correlated-vs-factored discriminator: a path through an inline
//     alias-shape view computable (`U.cards`) gets a fresh per-occurrence
//     namespace, so repeated traversals SPLIT into siblings (factored), while
//     schema pointers / direct extents FUSE (correlated). See docs/adr/0061.

const treeOf = (q: string): ScopeTreeNode => {
  const ast = parseEdgeQL(q) as unknown;
  const stmt = Array.isArray(ast) ? ast[0] : ast;
  return buildScopeTreeFromAst(stmt);
};

// node name = its segment chain, IGNORING the view namespace (so the two
// `U.cards@vnsN` siblings both read as "U.cards").
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

// How many distinct nodes carry this segment chain. A CORRELATED prefix appears
// once (refs fuse); a FACTORED one appears once per occurrence (refs split).
const countByName = (n: ScopeTreeNode, name: string): number => {
  let total = seg(n) === name ? 1 : 0;
  for (const c of n.children) total += countByName(c, name);
  return total;
};

describe("scope_builder (Phase 1)", () => {
  it("populates a real tree (not the empty stub)", () => {
    const root = treeOf("SELECT count((Card.name, Card.cost))");
    expect(root.fenced).toBe(true); // statement boundary is a fence
    expect(root.children.length).toBeGreaterThan(0); // not the empty stub
  });

  // --- layer 1: prefix fusing ---

  it("CORRELATED: Card.name and Card.cost fuse at a single Card node", () => {
    const root = treeOf("SELECT count((Card.name, Card.cost))");
    expect(countByName(root, "Card")).toBe(1);
    const card = find(root, "Card")!;
    expect(card.children.map(seg).sort()).toEqual(["Card.cost", "Card.name"]);
  });

  it("CORRELATED: a schema-computed link (Card.owners) still fuses", () => {
    // `owners := .<deck[IS User]` is computed but is a SCHEMA pointer, not an
    // inline view computable, so its refs correlate (cf. scope_computables_08).
    const root = treeOf("SELECT count((Card.owners.name, Card.owners.deck_cost))");
    expect(countByName(root, "Card.owners")).toBe(1);
    const owners = find(root, "Card.owners")!;
    expect(owners.children.map(seg).sort()).toEqual([
      "Card.owners.deck_cost",
      "Card.owners.name",
    ]);
  });

  // --- layer 2: the factoring discriminator ---

  it("FACTORED: a WITH-alias view computable (U.cards) splits per occurrence", () => {
    const root = treeOf(
      "WITH U := User { cards := Card }, SELECT count((U.cards.name, U.cards.cost))",
    );
    // The binding body lives under its own fence.
    expect(find(root, "User")).toBeDefined();
    expect(root.children.some((c) => c.fenced)).toBe(true);
    // `cards` is an inline `:=` view computable -> the two U.cards refs do NOT
    // fuse: there are two distinct U.cards nodes (factored), while their alias
    // prefix `U` still fuses (correlated/visible).
    expect(countByName(root, "U")).toBe(1);
    expect(countByName(root, "U.cards")).toBe(2);
  });

  it("FACTORED: a computed link (cards := .deck) also splits", () => {
    const root = treeOf(
      "WITH U := User { cards := .deck }, SELECT count((U.cards.name, U.cards.cost))",
    );
    expect(countByName(root, "U.cards")).toBe(2);
  });

  it("FACTORED at the computable only: U.deck (real link) fuses, U.deck.a (computable) splits", () => {
    const root = treeOf(
      "WITH U := (SELECT User { deck: {name, a := Award} }), " +
        "SELECT count((U.deck.a.name, U.deck.a.id, U.deck.name))",
    );
    // `deck` is a real link projection (no `:=`) -> fuses; `a := Award` is a view
    // computable -> the two U.deck.a refs split.
    expect(countByName(root, "U.deck")).toBe(1);
    expect(countByName(root, "U.deck.a")).toBe(2);
  });

  it("does not throw on non-select statements", () => {
    expect(() => treeOf("INSERT Card { name := 'x', element := 'Fire', cost := 1 }")).not.toThrow();
  });
});

// Phase 1 layer 3: the factoring-query authority (find_factorable_nodes port).
describe("scope_tree factoring authority", () => {
  // Verdict for a tuple-count-style query: do all scalar path leaves share an
  // immediate object prefix (CORRELATED -> zip) or not (FACTORED -> product)?
  const verdict = (q: string): "correlated" | "factored" | "n/a" => {
    const root = treeOf(q);
    const f = analyzeTreeFactoring(root);
    const leaves = f.pathLeaves().filter((n) => (n.pathId?.steps?.length ?? 0) >= 2);
    if (leaves.length < 2) return "n/a";
    return leaves.every((l) => f.shouldFactorTogether(leaves[0]!, l)) ? "correlated" : "factored";
  };

  it("CORRELATED: direct extent tuple count zips", () => {
    expect(verdict("SELECT count((Card.name, Card.cost))")).toBe("correlated");
  });

  it("CORRELATED: schema-computed link prefix zips", () => {
    expect(verdict("SELECT count((Card.owners.name, Card.owners.cost))")).toBe("correlated");
  });

  it("FACTORED: alias-view computable tuple count crosses (07b)", () => {
    expect(
      verdict("WITH U := User { cards := Card }, SELECT count((U.cards.name, U.cards.cost))"),
    ).toBe("factored");
  });

  it("FACTORED: alias-view computable via .deck crosses (07a)", () => {
    expect(
      verdict("WITH U := User { cards := .deck }, SELECT count((U.cards.name, U.cards.cost))"),
    ).toBe("factored");
  });

  it("FACTORED: nested alias-view computable crosses (11a)", () => {
    expect(
      verdict(
        "WITH U := (SELECT User { deck: {name, a := Award} }), " +
          "SELECT count((U.deck.a.name, U.deck.a.id, U.deck.name))",
      ),
    ).toBe("factored");
  });
});
