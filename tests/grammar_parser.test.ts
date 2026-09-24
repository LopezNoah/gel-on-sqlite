import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CompilerService } from "../src/compiler/service.js";
import { schemaFromSdl } from "../src/compiler/inspect.js";
import { parseEdgeQLGrammar } from "../src/edgeql/grammar_parser.js";
import { parseEdgeQLScript } from "../src/edgeql/parser.js";

// This tests the *working AST* seam, not just syntax acceptance: the same
// compiler should be able to consume the grammar-backed result.
const queries = [
  "SELECT 1 + 2 * 3;",
  "SELECT (1 + 2) * 3;",
  "SELECT -2 ^ 2;",
  "SELECT 2 ^ 3 ^ 2;",
  "SELECT 1 ?? 2 + 3;",
  "SELECT 1 ?? 2 ?? 3;",
  "SELECT 10 // 3 + 2 % 3;",
  "SELECT 'a' ++ 'b' ++ 'c';",
  "SELECT 1 = 2 OR 3 = 4;",
  "SELECT NOT true AND false;",
  "SELECT len('hello');",
  "SELECT std::len('hello');",
  "SELECT len('abc', 2 + 1);",
  "SELECT User;",
  "SELECT User.name;",
  "SELECT .name;",
  "SELECT User {name};",
  "SELECT User {name, age} FILTER .name = 'alice';",
  "SELECT User FILTER .age >= 18;",
  "WITH x := 2 SELECT x + 1;",
  "WITH x := 2, y := 3 SELECT x + y;",
  "\n  SELECT 1 + 2;",
];

describe("grammar-backed SELECT parser", () => {
  it.each(queries)("emits the working AST for %s", (query) => {
    expect(parseEdgeQLGrammar(query)).toEqual(parseEdgeQLScript(query)[0]);
  });

  it.each([
    "SELECT 1 +;", "SELECT User {name,,};", "SELECT (1 + 2;", "1 + 2;",
    "SELECT 1e999;", "SELECT 1e-324;", "SELECT 111111111111111111111111;",
    "SELECT 1; SELECT 2;",
  ])(
    "rejects malformed syntax: %s", (query) => {
      expect(() => parseEdgeQLGrammar(query)).toThrow();
    },
  );

  it("rejects unsupported syntax rather than silently delegating to the old parser", () => {
    expect(() => parseEdgeQLGrammar("CREATE TYPE Foo { BLARG; }; ")).toThrow();
    expect(() => parseEdgeQLGrammar("SELECT User ORDER BY .name;")).toThrow();
  });

  it.each([
    "SELECT 1 + 2 * 3;",
    "SELECT Issue {name} FILTER .number = '1';",
    "WITH x := 2 SELECT x + 1;",
  ])("compiles equivalent SQL from the grammar-backed AST: %s", (query) => {
    const schema = schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"));
    const compiler = new CompilerService();
    const grammarSql = compiler.compile(schema, parseEdgeQLGrammar(query)).sql;
    const handwrittenSql = compiler.compile(schema, parseEdgeQLScript(query)[0]).sql;
    expect(grammarSql).toEqual(handwrittenSql);
  });
});
