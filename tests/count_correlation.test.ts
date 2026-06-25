import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectorFor, schemaFromSdl } from "../src/compiler/inspect.js";

// First-party tests for the binding-scope-correlation seam (ADR 0059).
//
// `count(<single scalar property>)` is PER-ROW when written INLINE in a computed
// shape — `Card { foo := count(Card.name) }` correlates `Card` to the enclosing
// row, so the count is 0/1 on that row's single property. The SAME expression
// pulled out into a FACTORED `WITH a := count({Card.name})` counts the WHOLE set
// instead. After WITH-binding inlining the two IRs are otherwise byte-identical
// (same node kind, empty namespace, no flags), so SQL lowering cannot tell 1
// from 9 on structure alone. The IR builder stamps the factored count's
// argument with `isWithBinding`; the count lowering reads that mark to decide
// whether to correlate. Driven through the compile-inspection seam (ADR 0002):
// the canonical SQL is the test surface, so a change to either side surfaces
// here as a named failure rather than only as a deep golden diff.

const inspector = inspectorFor(
  schemaFromSdl(fs.readFileSync(new URL("./schemas/cards.esdl", import.meta.url), "utf8")),
);
const sql = (q: string): string => {
  const r = inspector.inspect(q);
  if (!r.ok) throw new Error(`did not compile: ${r.error?.code} ${r.error?.message}`);
  return r.sql();
};

const CORRELATED_PROPERTY_COUNT = 'CASE WHEN a0."name" IS NULL THEN 0 ELSE 1 END';

describe("count-of-property correlation (ADR 0059)", () => {
  it("inline `count(Card.name)` in a shape correlates per-row (CASE 0/1)", () => {
    const out = sql("SELECT Card { foo := <str>count(Card.name) }");
    // Correlated to the shape row: a 0/1 test on the single property, NOT a
    // full-table count(*).
    expect(out).toContain(CORRELATED_PROPERTY_COUNT);
    expect(out).not.toContain("count(*)");
  });

  it("factored `WITH a := count({Card.name})` counts the whole set (full scan)", () => {
    const out = sql("WITH a := count({Card.name}) SELECT Card { a := a }");
    // NOT correlated: the factored binding counts every Card's name — a
    // full-set count(*), not the per-row 0/1 form.
    expect(out).toContain("count(*)");
    expect(out).not.toContain(CORRELATED_PROPERTY_COUNT);
  });

  it("the two forms produce DIFFERENT count SQL despite identical post-inlining IR", () => {
    const inline = sql("SELECT Card { foo := <str>count(Card.name) }");
    const factored = sql("WITH a := count({Card.name}) SELECT Card { a := a }");
    // The whole point of the seam: same written `count(Card.name)`, different
    // scope, different SQL.
    expect(inline.includes(CORRELATED_PROPERTY_COUNT)).toBe(true);
    expect(factored.includes(CORRELATED_PROPERTY_COUNT)).toBe(false);
  });

  it("inline count over a multi-valued LINK does not take the single-property branch", () => {
    // `count(Card.owners)` is a link traversal (multi), not a single scalar
    // property — it must NOT be lowered to the 0/1 correlated-property CASE.
    const out = sql("SELECT Card { n := count(Card.owners) }");
    expect(out).not.toContain(CORRELATED_PROPERTY_COUNT);
  });
});
