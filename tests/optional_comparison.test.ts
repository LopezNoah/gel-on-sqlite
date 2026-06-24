import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectorFor, schemaFromSdl } from "../src/compiler/inspect.js";

// Pins the set-level nullable-operator algebra lifted out of gel_ir_compiler.ts
// into src/sql/optional_comparison.ts (ADR 0051): the `??` set-level coalesce
// (tryCompileSetLevelCoalesceSQL) and the `?=` / `?!=` optional comparison
// (tryCompileSetLevelOptionalCompareSQL). Driven through the public
// compile-inspection seam (ADR 0002) — the canonical SQL is the test surface,
// so a change to either lowering surfaces here as a named failure rather than
// only as a deep golden diff.

const inspector = inspectorFor(
  schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8")),
);
const sql = (q: string): string => {
  const r = inspector.inspect(q);
  if (!r.ok) throw new Error(`did not compile: ${r.error?.code} ${r.error?.message}`);
  return r.sql();
};

describe("tryCompileSetLevelCoalesceSQL — set-level `??`", () => {
  it("emits the LHS-non-null branch UNION ALL the empty-LHS fallback over RHS", () => {
    const out = sql("SELECT Issue.time_estimate ?? -1");
    // LHS rows: only the non-null pointer values.
    expect(out).toContain('a0."time_estimate" IS NOT NULL');
    // Fallback: RHS singleton, emitted only when the LHS path is empty.
    expect(out).toContain("UNION ALL");
    expect(out).toContain('SELECT -1 AS "value"');
    expect(out).toContain('NOT EXISTS (SELECT 1 FROM');
  });
});

describe("tryCompileSetLevelOptionalCompareSQL — set-level `?=` / `?!=`", () => {
  it("`?=` compares with `IS`, json-booleans, and a both-empty TRUE fallback", () => {
    const out = sql("SELECT Issue.time_estimate ?= 60");
    expect(out).toContain("(CASE WHEN lhs_q.v IS ? THEN json('true') ELSE json('false') END)");
    // Empty LHS → both sides empty → `?=` yields a single TRUE row.
    expect(out).toContain("SELECT json('false') AS \"value\" WHERE NOT EXISTS (SELECT 1 FROM lhs_q)");
  });

  it("`?!=` negates the comparison and flips the empty fallback to TRUE", () => {
    const out = sql("SELECT Issue.time_estimate ?!= 60");
    expect(out).toContain("(CASE WHEN lhs_q.v IS NOT ? THEN json('true') ELSE json('false') END)");
    expect(out).toContain("SELECT json('true') AS \"value\" WHERE NOT EXISTS (SELECT 1 FROM lhs_q)");
  });
});
