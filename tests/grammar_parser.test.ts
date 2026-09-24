import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CompilerService } from "../src/compiler/service.js";
import { schemaFromSdl } from "../src/compiler/inspect.js";
import { parseEdgeQLGrammar, parseEdgeQLGrammarScript } from "../src/edgeql/grammar_parser.js";
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
  "SELECT 1 IF true ELSE 2;",
  "SELECT if true then 1 else 2;",
  "SELECT 1 IF false ELSE 2 IF true ELSE 3;",
  "SELECT User.name[0];",
  "SELECT $1;",
  "SELECT <str>$foo;",
  "SELECT User.name LIKE 'A%';",
  "SELECT NOT true AND false;",
  "SELECT len('hello');",
  "SELECT std::len('hello');",
  "SELECT len('abc', 2 + 1);",
  "SELECT User;",
  "SELECT User.name;",
  "SELECT User.__type__;",
  "SELECT __subject__;",
  "SELECT .name;",
  "SELECT User {name};",
  "SELECT User {name, age} FILTER .name = 'alice';",
  "SELECT User {};",
  "SELECT User {name,};",
  "SELECT User {friends: {name, age}, nick := .name};",
  "SELECT User {nick := 'hi', score := .age + 1};",
  "SELECT User {count := count(.friends)};",
  "SELECT (User {name});",
  "SELECT User {name} ORDER BY .name;",
  "SELECT User {name} FILTER .name = 'a' ORDER BY .name DESC LIMIT 3;",
  "SELECT User {name} OFFSET 2 LIMIT 5;",
  "SELECT User ORDER BY .name;",
  "SELECT User LIMIT 3;",
  "SELECT foo ORDER BY .name;",
  "SELECT scores ORDER BY scores.name;",
  "SELECT expert_map ORDER BY expert_map;",
  "SELECT {foo := (SELECT User {name} ORDER BY .name)};",
  "SELECT 2 LIMIT 5;",
  "SELECT 2 ORDER BY 1;",
  "SELECT foo;",
  "SELECT DISTINCT User;",
  "SELECT (SELECT User);",
  "SELECT (SELECT User {name});",
  "SELECT (WITH x := 1 SELECT x);",
  "SELECT (SELECT 1 + 2);",
  "SELECT count((SELECT User FILTER .name = 'A'));",
  "SELECT (SELECT User ORDER BY .name LIMIT 1).name;",
  "WITH x := (SELECT User {name}) SELECT x;",
  "SELECT EXISTS User;",
  "SELECT <str>{};",
  "SELECT {};",
  "SELECT {1, 2, 3};",
  "SELECT sum({1.1, 2.2, 3});",
  "SELECT {User, Issue};",
  "SELECT {a := 1, b := 2};",
  "SELECT {a := 1,};",
  "SELECT [1, 2, 3];",
  "SELECT [];",
  "WITH x := {1, 2} SELECT x;",
  "WITH x := <int64>{} SELECT array_agg(x);",
  "SELECT Issue {number, related_to: {time_estimate}} ORDER BY Issue.number;",
  "SELECT Review.<reviews[IS Movie];",
  "SELECT Review.<reviews[IS Movie].title;",
  "SELECT Movie[IS Film];",
  "SELECT Movie[IS Film].title;",
  "SELECT Movie.reviews@rating;",
  "SELECT 'qwerty'[2:4];",
  "SELECT <bytes>b'xy';",
  "SELECT Movie {reviews: {@rating}};",
  "SELECT Movie {reviews: {@rating := 3}};",
  "SELECT (1, 'a');",
  "SELECT (1,);",
  "SELECT ();",
  "SELECT (name := 'foo', val := 42);",
  "GROUP Issue BY .status;",
  "GROUP Issue {name} BY .status;",
  "WITH MODULE default SELECT User;",
  "WITH MODULE default GROUP User BY .name;",
  "WITH MODULE cards, G := (GROUP Card BY .element) SELECT G {key};",
  "WITH snapshots := cards::Card GROUP snapshots {} BY .element;",
  "SELECT (GROUP cards::Card {name} BY .element) FILTER .key.element != 'Air';",
  "CREATE TYPE Foo { CREATE REQUIRED PROPERTY name -> std::str { CREATE CONSTRAINT exclusive; }; CREATE MULTI LINK tags -> Tag; };",
  "CREATE TYPE Foo { CREATE PROPERTY a -> str; CREATE CONSTRAINT exclusive ON (.a); };",
  "ALTER TYPE Foo { CREATE CONSTRAINT exclusive ON (.name); };",
  "ALTER TYPE Foo ALTER PROPERTY status SET default := 'active';",
  "ALTER TYPE Foo;",
  "CREATE FUNCTION test::add_one(x: int64) -> int64 USING EdgeQL $$ SELECT x + 1 $$;",
  "CONFIGURE SESSION SET test_setting := true;",
  "CONFIGURE SESSION RESET test_setting;",
  "CONFIGURE SESSION INSERT test_setting { value := 'on' };",
  "SET GLOBAL test::foo := 10;",
  "RESET GLOBAL test::foo;",
  "SELECT User FILTER .age >= 18;",
  "WITH x := 2 SELECT x + 1;",
  "WITH x := 2, y := 3 SELECT x + y;",
  "WITH temp := foo(1) SELECT temp.a;",
  "SELECT call38(C38);",
  "WITH P := Person {name} SELECT P.name;",
  "WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok);",
  "\n  SELECT 1 + 2;",
  "INSERT User { name := 'Alice', age := 30 };",
  "INSERT User {name := 'Alice', age := 1 + 2};",
  "INSERT User {name := <str>$name};",
  "INSERT User {friends := Other};",
  "INSERT User {friends := (SELECT Other)};",
  "INSERT User {name := 'Alice'} UNLESS CONFLICT;",
  "INSERT Person {name := 'Alice'} UNLESS CONFLICT ON (.name);",
  "INSERT Person {name := 'Alice'} UNLESS CONFLICT ON (.name, .age);",
  "INSERT T {name := {'baz', 'bar'}} UNLESS CONFLICT;",
  "INSERT Person {id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff', name := 'test'} UNLESS CONFLICT;",
  "DELETE User;",
  "DELETE User FILTER .name = 'Alice';",
  "DELETE (SELECT User FILTER .name = 'Alice');",
  "DELETE (SELECT User FILTER User.name = 'Alice');",
  "UPDATE User SET {name := 'x'};",
  "UPDATE User FILTER .name = 'a' SET {name := 'b'};",
  "FOR x IN {1,2} UNION (SELECT x);",
  "FOR x IN {1,2} UNION x + 1;",
  "FOR x IN {1,2} SELECT x + 1;",
  "FOR User IN User SELECT User.name;",
  "WITH N := (FOR n IN {8,9} SELECT n) GROUP {a := 1, b := N} BY .a;",
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
    expect(() => parseEdgeQLGrammar("SELECT User GROUP BY .name;")).toThrow();
  });

  it("parses multiple statements with accurate source positions", () => {
    const script = "SELECT 'a;b';\n\nINSERT User {name := 'x;y'}; SELECT 1 + 2";
    expect(parseEdgeQLGrammarScript(script)).toEqual(parseEdgeQLScript(script));
  });

  it("accepts empty statements and does not split on delimiters inside a shape", () => {
    const script = ";; SELECT User {name, friends: {name}};;; SELECT 1;";
    expect(parseEdgeQLGrammarScript(script)).toEqual(parseEdgeQLScript(script));
  });

  it.each([
    "SELECT 1 + 2 * 3;",
    "SELECT Issue {name} FILTER .number = '1';",
    "WITH x := 2 SELECT x + 1;",
    "INSERT User { name := 'created' };",
    "UPDATE User FILTER .name = 'a' SET {name := 'b'};",
    "DELETE User FILTER .name = 'a';",
  ])("compiles equivalent SQL from the grammar-backed AST: %s", (query) => {
    const schema = schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"));
    const compiler = new CompilerService();
    const grammarSql = compiler.compile(schema, parseEdgeQLGrammar(query)).sql;
    const handwrittenSql = compiler.compile(schema, parseEdgeQLScript(query)[0]).sql;
    expect(grammarSql).toEqual(handwrittenSql);
  });
});
