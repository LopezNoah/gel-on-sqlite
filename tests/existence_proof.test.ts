import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectorFor, schemaFromSdl } from "../src/compiler/inspect.js";

// Pins the path-existence algebra lifted out of gel_ir_compiler.ts into
// src/sql/existence_proof.ts (ADR 0052): the single- and multi-step EXISTS
// lowering (tryCompileExistsObjectPointerSQL / buildAnchoredObjectChainJoin)
// and the correlated existential subquery (tryCompileCorrelatedExistsSelect).
// Driven through the public compile-inspection seam (ADR 0002) — the canonical
// SQL is the test surface, so a change to the existence lowering surfaces here
// as a named failure rather than only as a deep golden diff.

const inspector = inspectorFor(
  schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8")),
);
const sql = (q: string): string => {
  const r = inspector.inspect(q);
  if (!r.ok) throw new Error(`did not compile: ${r.error?.code} ${r.error?.message}`);
  return r.sql();
};

describe("tryCompileExistsObjectPointerSQL — single-link EXISTS", () => {
  it("outbound link-table link anchors the EXISTS on the junction `source`", () => {
    const out = sql("SELECT Issue FILTER EXISTS Issue.watchers");
    expect(out).toContain('EXISTS (SELECT 1 FROM "default__issue__watchers"');
    expect(out).toContain('"source" = a0."id")');
  });

  it("backlink (`<owner`) anchors the EXISTS on the junction `target`", () => {
    const out = sql("SELECT User FILTER EXISTS User.<owner[IS Issue]");
    expect(out).toContain('EXISTS (SELECT 1 FROM "default__issue__owner"');
    expect(out).toContain('"target" = a0."id")');
  });
});

describe("tryCompileCorrelatedExistsSelect — correlated existential subquery", () => {
  it("joins the chain anchored on the outer row and applies the inner filter", () => {
    const out = sql("SELECT User FILTER EXISTS (SELECT User.<owner[IS Issue] FILTER .name = 'x')");
    // buildAnchoredObjectChainJoin anchors `_lj0` on the outer row's id…
    expect(out).toContain('_lj0."target" = a0."id"');
    // …and the rewritten leaf filter runs against the chain's leaf alias.
    expect(out).toContain('(_ex0."name" IN (?))');
  });
});

describe("buildAnchoredObjectChainJoin — multi-step EXISTS chain", () => {
  it("chains junction joins level by level inside one EXISTS", () => {
    const out = sql("SELECT Issue FILTER EXISTS Issue.owner.<owner[IS Issue]");
    expect(out).toContain('JOIN "default__issue__owner" _lj1 ON _lj1."target" = _ex0."id"');
    expect(out).toContain('_lj0."source" = a0."id"');
  });
});
