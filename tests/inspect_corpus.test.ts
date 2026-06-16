import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { inspect, schemaFromSdl } from "../src/compiler/inspect.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";

// Characterization net for the compile pipeline. Each query is run through the
// compile-inspection seam and its Compile facts are snapshotted. The point is
// NOT that these values are "correct" — it's that they are STABLE: candidate #2
// unifies the SQL-vs-runtime decision, and any query whose `lowersToSingleSql`
// or `loweringMode` shifts will show as a one-line diff in the .snap file.
// Heavy on the SQL/runtime boundary (free objects, FOR, GROUP, aggregates, DML).

const issues = (): SchemaSnapshot =>
  schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"));

const CORPUS: string[] = [
  // plain selects & shapes
  `SELECT Issue`,
  `SELECT Issue { name, number }`,
  `SELECT Issue { name, owner: { name } }`,
  `SELECT Issue { watchers: { name } }`,
  `SELECT Issue.name`,
  `SELECT Issue.owner.name`,
  `SELECT Issue { num := .num_watchers }`,
  // clauses
  `SELECT Issue { name } FILTER .number = '1'`,
  `SELECT Issue { name } ORDER BY .number`,
  `SELECT Issue { name } LIMIT 3`,
  `SELECT Issue { name } OFFSET 2 LIMIT 3`,
  `SELECT Issue FILTER EXISTS .priority`,
  `SELECT Issue FILTER .name IN {'a', 'b'}`,
  `SELECT DISTINCT Issue.status.name`,
  // aggregates / functions
  `SELECT count(Issue)`,
  `SELECT sum(Issue.time_estimate)`,
  `SELECT count(Issue.watchers)`,
  `SELECT max(Issue.number)`,
  // scalar expressions
  `SELECT 1 + 2`,
  `SELECT len('hello')`,
  `SELECT {1, 2, 3}`,
  `SELECT (1, 'a')`,
  `SELECT [1, 2, 3]`,
  `SELECT <str>42`,
  `SELECT 'a' ++ 'b'`,
  // coalesce
  `SELECT Issue FILTER (.time_estimate ?? 0) > 0`,
  // free objects (some lower to SQL, some don't — that's the honest fact)
  `SELECT { a := 1, b := {2,3,4} }`,
  `SELECT { x := Issue.name }`,
  `SELECT { n := count(Issue) }`,
  // FOR (runtime-evaluator territory)
  `FOR x IN {1, 2, 3} UNION (SELECT x)`,
  `FOR n IN {1, 2} UNION (SELECT Issue { name } FILTER .number = <issue_num_t>n)`,
  // GROUP
  `GROUP Issue BY .status`,
  `GROUP Issue { name } BY .status`,
  // WITH / detached
  `WITH x := Issue SELECT x { name }`,
  `SELECT DETACHED Issue { name }`,
  // user-defined functions (inlined)
  `SELECT ident('hi')`,
  `SELECT opt_test(1, 'x')`,
  // DML (produces a DML IR; SELECT path facts still meaningful)
  `INSERT Status { name := 'New' }`,
  `UPDATE Issue FILTER .number = '1' SET { name := 'x' }`,
  `DELETE Issue FILTER .number = '1'`,
  // known reject — characterizes the error as a value
  `SELECT ThisTypeDoesNotExist`,
];

describe("compile-facts characterization corpus (issues schema)", () => {
  it("compile facts are stable across the corpus", () => {
    const schema = issues();
    const snapshot: Record<string, unknown> = {};
    for (const query of CORPUS) {
      const r = inspect(schema, query);
      snapshot[query] = r.ok
        ? {
            kind: r.facts!.statementKind,
            loweringMode: r.facts!.loweringMode,
            lowersToSingleSql: r.facts!.lowersToSingleSql,
            params: r.facts!.paramCount,
          }
        : { error: r.error!.code };
    }
    expect(snapshot).toMatchSnapshot();
  });
});

describe("canonical-SQL characterization (issues schema)", () => {
  const FOCUSED = [
    `SELECT Issue { name }`,
    `SELECT Issue { name } FILTER .number = '1'`,
    `SELECT Issue { name, owner: { name } }`,
    `SELECT count(Issue)`,
    `GROUP Issue { name } BY .status`,
    `SELECT { a := 1, b := {2,3,4} }`,
  ];

  it("canonical SQL is stable for representative queries", () => {
    const schema = issues();
    const sqlByQuery: Record<string, string> = {};
    for (const query of FOCUSED) {
      sqlByQuery[query] = inspect(schema, query).sql();
    }
    expect(sqlByQuery).toMatchSnapshot();
  });
});
