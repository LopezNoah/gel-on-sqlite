import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectorFor, schemaFromSdl } from "../src/compiler/inspect.js";

const inspector = inspectorFor(
  schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8")),
);
const aggregateInspector = inspectorFor(
  schemaFromSdl("type Publication { property title: str; }"),
);

const sql = (query: string, selectedInspector = inspector): string => {
  const result = selectedInspector.inspect(query);
  if (!result.ok) throw new Error(`did not compile: ${result.error?.code} ${result.error?.message}`);
  return result.sql();
};

describe("Relation-backed path resolution", () => {
  it("filters a type-root source against its registered range var", () => {
    const out = sql("SELECT (SELECT Issue FILTER .number = '1') { number }");

    expect(out).toContain('WHERE ');
    expect(out).toContain('a0."number"');
    expect(out).not.toContain("__correlated_root");
  });

  it("filters a pointer-chain source against its leaf range var", () => {
    const out = sql("SELECT (SELECT Issue.owner FILTER .name = 'Elvis') { name }");

    expect(out).toContain('WHERE (a0."name" IN (?))');
    expect(out).toContain('JOIN "default__issue__owner"');
  });

  it("resolves a SET OF aggregate argument against the current Relation scope", () => {
    const out = sql(
      "SELECT Publication.title ?= <str>count(Publication)",
      aggregateInspector,
    );

    expect(out).toContain('CASE WHEN a0."id" IS NULL THEN 0 ELSE 1 END');
    expect(out).not.toContain('count(*) FROM "default__publication"');
  });

  it("preserves namespaces when correlating aggregate arguments", () => {
    const out = sql(
      "WITH P := Publication SELECT P.title ?= <str>count(P)",
      aggregateInspector,
    );

    expect(out).toContain('CASE WHEN a0."id" IS NULL THEN 0 ELSE 1 END');
    expect(out).not.toContain('count(*) FROM "default__publication"');
  });

  it("preserves delimiters inside aggregate path namespaces", () => {
    const out = sql(
      "WITH `P,Q` := Publication SELECT `P,Q`.title ?= <str>count(`P,Q`)",
      aggregateInspector,
    );

    expect(out).toContain('CASE WHEN a0."id" IS NULL THEN 0 ELSE 1 END');
  });
});
