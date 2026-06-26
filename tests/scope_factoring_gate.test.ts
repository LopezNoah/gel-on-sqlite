import { beforeEach, describe, it } from "vitest";
import { QueryHarness } from "./utils.js";
import { assertQueryResult } from "./python_query_test_helpers.js";

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
});
