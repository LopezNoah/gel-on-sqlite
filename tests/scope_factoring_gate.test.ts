import { beforeEach, describe, it } from "vitest";
import { QueryHarness } from "./utils.js";
import { assertQueryResult, unorderedSet } from "./python_query_test_helpers.js";

// Phase 1 layer 3 (end-to-end): the count gate routes the shared-prefix tuple
// collapse through the scope-tree factoring authority (ADR 0061). A CORRELATED
// prefix zips (count = prefix rows); a FACTORED alias-view prefix stays the
// cartesian product.
describe("scope-tree factoring drives count((tuple))", () => {
  let h: QueryHarness;
  beforeEach(async () => {
    h = await QueryHarness.create({ schema: "cards", setup: "cards_setup" });
  });

  it("CORRELATED: count((Card.name, Card.cost)) zips over Card", () => {
    // Both leaves zip over the same Card extent -> one row per card (9), NOT the
    // 9x9 product the per-element count would give.
    assertQueryResult(h, "SELECT count((Card.name, Card.cost));", [9]);
  });

  it("FACTORED: count((U.cards.name, U.cards.cost)) crosses (alias-view computable)", () => {
    // `cards := Card` is an inline alias-view computable: the two U.cards refs do
    // NOT correlate, so the tuple is the cartesian product (9x9 = 81).
    assertQueryResult(
      h,
      "WITH U := User { cards := Card }, SELECT count((U.cards.name, U.cards.cost));",
      [81],
    );
  });

  it("deduplicates pointer targets before projecting equal scalar values", () => {
    assertQueryResult(
      h,
      "SELECT User.deck.cost ORDER BY _;",
      unorderedSet([1, 1, 1, 2, 2, 3, 3, 4, 5]),
    );
    assertQueryResult(h, "SELECT count(User.deck.cost);", [9]);
    assertQueryResult(h, "SELECT sum(User.deck.cost);", [22]);
    assertQueryResult(h, "SELECT DISTINCT User.deck.cost;", unorderedSet([1, 2, 3, 4, 5]));
  });

  it("distinguishes edge rows, target identities, and equal scalar values", async () => {
    const identityHarness = await QueryHarness.create({ schema: "cards" });
    identityHarness.script(`
      INSERT Card { name := 'Identity A', element := 'Test', cost := 99 };
      INSERT Card { name := 'Identity B', element := 'Test', cost := 99 };
      INSERT User {
        name := 'Identity source 1',
        deck := (SELECT Card FILTER .name = 'Identity A'),
      };
      INSERT User {
        name := 'Identity source 2',
        deck := (SELECT Card FILTER .name = 'Identity A'),
      };
      INSERT User {
        name := 'Identity source 3',
        deck := (SELECT Card FILTER .name = 'Identity B'),
      };
    `);
    assertQueryResult(identityHarness, "SELECT User.deck.cost;", unorderedSet([99, 99]));
    assertQueryResult(identityHarness, "SELECT count(User.deck.cost);", [2]);
    assertQueryResult(identityHarness, "SELECT DISTINCT User.deck.cost;", [99]);
  });

  it("preserves owner cardinality for a computed count", () => {
    assertQueryResult(
      h,
      "WITH U := User { deck_count := count(.deck) }, SELECT count(U.deck_count);",
      [4],
    );
    assertQueryResult(
      h,
      "WITH U := (SELECT User { deck_count := count(.deck) } FILTER .name = 'Alice'), SELECT count(U.deck_count);",
      [1],
    );
  });

  it("deduplicates each pointer factor before tuple count", () => {
    assertQueryResult(h, "SELECT count((Card.owners.name, Card.owners.id));", [16]);
  });

  it("counts a computed aggregate leaf once per correlated pointer target", () => {
    assertQueryResult(h, "SELECT count((Card.owners.name, Card.owners.deck_cost));", [16]);
  });
});
