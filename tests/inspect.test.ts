import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizeSql,
  gelFactsOf,
  inspect,
  inspectorFor,
  schemaFromSdl,
  type GelFactsOk,
  type Inspector,
} from "../src/compiler/inspect.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";

const fixture = (name: string): SchemaSnapshot =>
  schemaFromSdl(fs.readFileSync(new URL(`./schemas/${name}.esdl`, import.meta.url), "utf8"));

interface SelectGolden {
  query: string;
  schema_file: string;
  source_test: {
    file: string;
    class: string;
    test: string;
    case_index: number;
  };
  inference: {
    cardinality: string;
    multiplicity: string;
    volatility: string;
  };
}

const selectGolden = (name: string): SelectGolden =>
  JSON.parse(
    fs.readFileSync(
      new URL(
        `../goldens/gel-compiler-facts/edgeql_select/TestEdgeQLSelect/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

const inspectGolden = (name: string): GelFactsOk => {
  const golden = selectGolden(name);
  const gelFacts = gelFactsOf(inspect(fixture("issues"), golden.query), {
    schemaFile: golden.schema_file,
    sourceTest: golden.source_test,
  });

  expect(gelFacts.ok).toBe(true);
  if (!gelFacts.ok) throw new Error(`expected ${name} to compile`);
  expect(gelFacts.query).toBe(golden.query);
  expect(gelFacts.schema_file).toBe(golden.schema_file);
  expect(gelFacts.source_test).toEqual(golden.source_test);
  expect(gelFacts.inference).toMatchObject({
    cardinality: golden.inference.cardinality,
    multiplicity: golden.inference.multiplicity,
    volatility: golden.inference.volatility,
  });
  return gelFacts;
};

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

  it("normalizes underscore-prefixed projection aliases (_pb, _pl_0)", () => {
    const sql = `FROM "t" _pb LEFT JOIN "l" _pl_0 ON _pl_0."s" = _pb."id"`;
    expect(canonicalizeSql(sql)).toBe(`FROM "t" a0 LEFT JOIN "l" a1 ON a1."s" = a0."id"`);
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

describe("Gel-shaped compile facts projection", () => {
  it("exposes inference, path ids, scope tree, and sqlite SQL for the tracer-bullet query", () => {
    const r = inspect(fixture("issues"), `SELECT Issue.owner{name} ORDER BY Issue.owner.name;`);
    const gelFacts = gelFactsOf(r, { schemaFile: "tests/schemas/issues.esdl" });

    expect(gelFacts.ok).toBe(true);
    if (!gelFacts.ok) throw new Error("expected query to compile");
    expect(gelFacts.schema_file).toBe("tests/schemas/issues.esdl");
    expect(gelFacts.inference).toEqual({
      cardinality: "MANY",
      multiplicity: "UNIQUE",
      stype: "default::User",
      volatility: "Stable",
    });
    expect(gelFacts.ir_kind_tree.kind).toBe("SelectStmt");
    expect(gelFacts.path_ids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expr: "Pointer",
          node: "Set",
          owner: "result",
          path_id: "(default::Issue).>(default::__|owner@default|Issue)[IS default::User]@",
          type: "default::User",
        }),
        expect.objectContaining({
          expr: "TypeRoot",
          node: "Set",
          owner: "source",
          path_id: "(default::Issue)",
          type: "default::Issue",
        }),
        expect.objectContaining({
          expr: "Pointer",
          node: "Set",
          owner: "shape",
          path_id:
            "(default::Issue).>(default::__|owner@default|Issue)[IS default::User]" +
            ".>(default::__|name@default|User)[IS std::str]@",
          type: "std::str",
        }),
      ]),
    );
    expect(gelFacts.scope_tree).toContain('"FENCE uid:');
    expect(gelFacts.scope_tree).toContain("(Issue.owner.name)");
    expect(gelFacts.sqlite_sql).toContain('ORDER BY a0."name" ASC');
  });

  it("covers a real order-by golden with a multi-step sort path", () => {
    const gelFacts = inspectGolden("test_edgeql_select_order_01__001");

    expect(gelFacts.ir_kind_tree.kind).toBe("SelectStmt");
    expect(gelFacts.path_ids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expr: "Pointer",
          owner: "path",
          path_id:
            "(default::Issue).>(default::__|priority@default|Issue)[IS default::Priority]" +
            ".>(default::__|name@default|Priority)[IS std::str]@",
          type: "std::str",
        }),
        expect.objectContaining({
          expr: "Pointer",
          owner: "shape",
          path_id: "(default::Issue).>(default::__|name@default|Issue)[IS std::str]@",
          type: "std::str",
        }),
      ]),
    );
    expect(gelFacts.sqlite_sql).toContain('ORDER BY (SELECT cp1."name"');
    expect(gelFacts.sqlite_sql).toContain('a0."name" ASC');
  });

  it("covers a real backlink-and-type-intersection golden", () => {
    const gelFacts = inspectGolden("test_edgeql_select_unique_01__001");

    expect(gelFacts.path_ids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expr: "Pointer",
          owner: "result",
          path_id:
            "(default::Issue).>(default::__|watchers@default|Issue)[IS default::User]" +
            ".>(default::__|owner@default|Issue)[IS default::Issue]@",
          type: "default::Issue",
        }),
        expect.objectContaining({
          expr: "Pointer",
          owner: "shape",
          path_id:
            "(default::Issue).>(default::__|watchers@default|Issue)[IS default::User]" +
            ".>(default::__|owner@default|Issue)[IS default::Issue]" +
            ".>(default::__|name@default|Issue)[IS std::str]@",
          type: "std::str",
        }),
      ]),
    );
    expect(gelFacts.scope_tree).toContain("BRANCH uid:");
    expect(gelFacts.sqlite_sql).toContain('JOIN "default__issue__watchers"');
    expect(gelFacts.sqlite_sql).toContain('JOIN "default__issue__owner"');
  });

  it("covers a real computed-shape golden that projects a nested path", () => {
    const gelFacts = inspectGolden("test_edgeql_select_computable_33__001");

    expect(gelFacts.inference.cardinality).toBe("AT_MOST_ONE");
    expect(gelFacts.path_ids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expr: "Pointer",
          owner: "shape",
          path_id:
            "(default::User).>(default::__|todo@default|User)[IS default::Issue]" +
            ".>(default::__|id@default|Issue)[IS std::uuid]@",
          type: "std::uuid",
        }),
        expect.objectContaining({
          expr: "OperatorCall",
          owner: "where",
          path_id: "(filter:=)",
          type: "std::bool",
        }),
      ]),
    );
    expect(gelFacts.sqlite_sql).toContain("json_group_array");
    expect(gelFacts.sqlite_sql).toContain('WHERE (EXISTS (SELECT 1 FROM (SELECT ? AS "value")');
  });

  it("covers a real nested link-property shape golden", () => {
    const gelFacts = inspectGolden("test_edgeql_select_linkproperty_03__001");

    expect(gelFacts.path_ids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expr: "SelectExpr",
          owner: "shape",
          path_id: "(default::User).>(default::__|todo@default|User)[IS default::Issue]@",
          type: "default::Issue",
        }),
        expect.objectContaining({
          expr: "Pointer",
          owner: "shape",
          path_id:
            "(default::User).>(default::__|todo@default|User)[IS default::Issue]" +
            "@(default::__|&rank@default|Issue)[IS std::int64]@",
          type: "std::int64",
        }),
      ]),
    );
    expect(gelFacts.sqlite_sql).toContain("'@rank'");
    expect(gelFacts.sqlite_sql).toContain('ORDER BY a1."number" ASC NULLS LAST');
  });

  it("covers a real coalesce golden with both optional branches", () => {
    const gelFacts = inspectGolden("test_edgeql_select_coalesce_01__001");

    expect(gelFacts.path_ids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expr: "CoalesceExpr",
          owner: "shape",
          path_id: "(std::coalesce)",
          type: "std::str",
        }),
        expect.objectContaining({
          owner: "left",
          path_id:
            "(default::Issue).>(default::__|priority@default|Issue)[IS default::Priority]" +
            ".>(default::__|name@default|Priority)[IS std::str]@",
        }),
        expect.objectContaining({
          owner: "right",
          path_id:
            "(default::Issue).>(default::__|status@default|Issue)[IS default::Status]" +
            ".>(default::__|name@default|Status)[IS std::str]@",
        }),
      ]),
    );
    expect(gelFacts.sqlite_sql).toContain("COALESCE((SELECT");
    expect(gelFacts.sqlite_sql).toContain('ORDER BY a0."number" ASC');
  });
});
