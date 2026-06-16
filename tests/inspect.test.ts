import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizeSql,
  inspect,
  inspectorFor,
  schemaFromSdl,
  type Inspector,
} from "../src/compiler/inspect.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";

const fixture = (name: string): SchemaSnapshot =>
  schemaFromSdl(fs.readFileSync(new URL(`./schemas/${name}.esdl`, import.meta.url), "utf8"));

describe("canonicalizeSql", () => {
  it("renames generated aliases to stable positional tokens by first appearance", () => {
    const sql = `SELECT g0."id" FROM t g0 JOIN x p1 ON p1.s = g0.id WHERE g0.n = ?`;
    expect(canonicalizeSql(sql)).toBe(
      `SELECT a0."id" FROM t a0 JOIN x a1 ON a1.s = a0.id WHERE a0.n = ?`,
    );
  });

  it("is stable under a counter shift — same structure canonicalizes identically", () => {
    const a = canonicalizeSql(`SELECT g0.x FROM t g0`);
    const b = canonicalizeSql(`SELECT g7.x FROM t g7`);
    expect(a).toBe(b);
  });

  it("collapses whitespace", () => {
    expect(canonicalizeSql("SELECT   1\n  FROM   t")).toBe("SELECT 1 FROM t");
  });
});

describe("compile facts (issues schema)", () => {
  let q: Inspector;
  beforeAll(() => {
    q = inspectorFor(fixture("issues"));
  });

  it("a filtered select lowers to one SQL statement and binds one param", () => {
    expect(q.facts(`SELECT Issue { name } FILTER .number = '1'`)).toMatchObject({
      statementKind: "select",
      loweringMode: "single_statement",
      lowersToSingleSql: true,
      paramCount: 1,
    });
  });

  it("a free-object select lowers to SQL — the honest fact, not a 'free objects are runtime' guess", () => {
    const facts = q.facts(`SELECT { a := 1, b := {2,3,4} }`);
    expect(facts.statementKind).toBe("select_free");
    expect(facts.lowersToSingleSql).toBe(true);
    expect(facts.paramCount).toBe(0);
  });

  it("a GROUP lowers to one SQL statement", () => {
    expect(q.facts(`GROUP Issue { name } BY .status`)).toMatchObject({
      statementKind: "group",
      lowersToSingleSql: true,
    });
  });

  it("the IR node-kind tree is rooted at the select statement", () => {
    const facts = q.facts(`SELECT Issue { name }`);
    expect(facts.irKindTree.kind).toBe("select_stmt");
    expect(facts.irKindTree.children.length).toBeGreaterThan(0);
  });
});

describe("compile facts: errors are values, not crashes", () => {
  let schema: SchemaSnapshot;
  beforeAll(() => {
    schema = fixture("issues");
  });

  it("a multi-statement input is rejected with E_MULTI, never silently truncated", () => {
    const r = inspect(schema, `SELECT Issue; SELECT User`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ phase: "parse", code: "E_MULTI" });
  });

  it("a query that does not compile returns ok:false but keeps the parsed AST", () => {
    const r = inspect(schema, `SELECT ThisTypeDoesNotExist`);
    expect(r.ok).toBe(false);
    expect(r.ast).toBeDefined();
    expect(r.sql()).toBe("");
  });
});

describe("canonical SQL crosses the same seam as the CLI", () => {
  it("strips generated aliases from a real artifact", () => {
    const r = inspect(fixture("issues"), `SELECT Issue { name } FILTER .number = '1'`);
    expect(r.ok).toBe(true);
    const sql = r.sql();
    expect(sql).toContain("a0");
    expect(sql).not.toMatch(/\bg0\b/);
  });
});
