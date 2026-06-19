import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectorFor, schemaFromSdl } from "../src/compiler/inspect.js";

// Pins the two shape-projection cases lifted out of compileShapeProjection into
// named helpers (ADR 0049): the link-array case (`compileShapeLinkArray`) and
// the leaf-through-foreign-link case (`compileShapeLeafThroughForeignLink`).
// Driven through the public compile-inspection seam (ADR 0002) — the canonical
// SQL is the test surface, so a change to either case's lowering surfaces here
// as a named failure rather than only as a deep golden diff.

const inspector = inspectorFor(
  schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8")),
);
const sql = (q: string): string => {
  const r = inspector.inspect(q);
  if (!r.ok) throw new Error(`did not compile: ${r.error?.code} ${r.error?.message}`);
  return r.sql();
};

describe("compileShapeLinkArray — link projected as a JSON array of shaped rows", () => {
  it("aggregates a multi link with json_group_array over its junction table", () => {
    const out = sql("SELECT Issue { watchers: { name } }");
    expect(out).toContain('json_group_array(json("item"))');
    expect(out).toContain('"default__issue__watchers"');
    expect(out).toContain('AS "watchers"');
  });

  it("unwraps a single link to its first element", () => {
    const out = sql("SELECT Issue { owner: { name } }");
    // single-cardinality links surface as `owner: {…}`, not `owner: [{…}]`.
    expect(out).toContain("json(COALESCE(json_extract(");
    expect(out).toContain("'$[0]'), 'null')) AS \"owner\"");
  });
});

describe("compileShapeLeafThroughForeignLink — scalar leaf through a single object link", () => {
  it("lowers `a := .link.scalar` as a correlated LIMIT 1 subquery, not a bare column", () => {
    const out = sql("SELECT Issue { owner_name := .owner.name }");
    // A correlated single-row read of the leaf off the link's target rows…
    expect(out).toContain('LIMIT 1) AS "owner_name"');
    expect(out).toContain('"default__issue__owner"');
    // …NOT the wrong projected-column read off the subject row.
    expect(out).not.toContain('a0."owner_name"');
  });
});
