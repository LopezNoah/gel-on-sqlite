import fs from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CompilerService } from "../src/compiler/service.js";
import { schemaFromSdl } from "../src/compiler/inspect.js";
import { tableNameForType } from "../src/codegen/sql.js";
import { parseEdgeQLGrammar, parseEdgeQLGrammarScript } from "../src/edgeql/grammar_parser.js";
import {
  parseGelGrammarScript,
  parseGelGrammarStatement,
} from "../src/edgeql/gel_lr_ast_reducer.js";
import { parseEdgeQLScript } from "../src/edgeql/parser.js";
import { extractSuiteQueries } from "../scripts/grammar-query-corpus.js";
import {
  acceptsGelGrammarBlock,
  parseGelGrammarCST,
  type GelCSTNode,
} from "../src/edgeql/gel_lr_parser.js";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";

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
  `SELECT '\\'"\\\\\\'\\""\\\\x\\\\u';`,
  `SELECT "'\\"\\\\\\'\\"\\\\x\\\\u";`,
  'SELECT "1 + 1 = \\(1 + 1)";',
  'SELECT "a \\(1) b \\(2)c";',
  "SELECT 1 = 2 OR 3 = 4;",
  "SELECT 1 IF true ELSE 2;",
  "if true then 10 else 11",
  "SELECT if true then 1 else 2;",
  "SELECT 1 IF false ELSE 2 IF true ELSE 3;",
  "SELECT User.name[0];",
  "SELECT $1;",
  "SELECT <str>$foo;",
  "SELECT <optional int64>$0;",
  "SELECT <required int64>$x;",
  "SELECT User.name LIKE 'A%';",
  "SELECT NOT true AND false;",
  "SELECT len('hello');",
  "SELECT std::len('hello');",
  "SELECT len('abc', 2 + 1);",
  "SELECT call1('-', suffix := 's1');",
  "SELECT call1('-', prefix := 'p1', suffix := lower('S1'),);",
  "SELECT call1(empty := 42);",
  "SELECT User;",
  "SELECT User.name;",
  "SELECT User.__type__;",
  "SELECT __subject__;",
  "SELECT .name;",
  "SELECT User {name};",
  "SELECT User {name, age} FILTER .name = 'alice';",
  "SELECT User {};",
  "SELECT User {*};",
  "SELECT User {name,};",
  "SELECT Issue {multi te := .time_estimate};",
  "SELECT User {required};",
  "SELECT User {friends: {name, age}, nick := .name};",
  "SELECT User {friends: {name} ORDER BY .name};",
  "SELECT User {friends: {name} FILTER .name != 'x'};",
  "SELECT User {nick := 'hi', score := .age + 1};",
  "SELECT User {count := count(.friends)};",
  "SELECT (User {name});",
  "SELECT User {name} ORDER BY .name;",
  "SELECT User {name} FILTER .name = 'a' ORDER BY .name DESC LIMIT 3;",
  "SELECT User {name} OFFSET 2 LIMIT 5;",
  "SELECT User {number} ORDER BY User.number OFFSET (SELECT count(Status));",
  "SELECT User {number} ORDER BY User.number LIMIT (SELECT count(Status) + 1);",
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
  "SELECT (WITH x := 1, FOR y IN {1, 2} UNION y);",
  "SELECT (SELECT 1 + 2);",
  "SELECT count((SELECT User FILTER .name = 'A'));",
  "SELECT (SELECT User ORDER BY .name LIMIT 1).name;",
  "WITH x := (SELECT User {name}) SELECT x;",
  "SELECT EXISTS User;",
  "SELECT <str>{};",
  "SELECT call21(<array<str>>[]);",
  "SELECT <Named & Owned>{};",
  "SELECT foo(<File | URL>{});",
  "WITH x := array_unpack(<array<Issue>>[]) SELECT x.name ?= x.body;",
  "SELECT {};",
  "SELECT {1, 2, 3};",
  "SELECT sum({1.1, 2.2, 3});",
  "SELECT {User, Issue};",
  "SELECT {a := 1, b := 2};",
  "SELECT {required user := 1};",
  "SELECT {a := 1,};",
  "SELECT [1, 2, 3];",
  "SELECT [];",
  "SELECT array_agg('x' ORDER BY 'x');",
  "WITH x := {1, 2} SELECT x;",
  "WITH x := <int64>{} SELECT array_agg(x);",
  "SELECT Issue {number, related_to: {time_estimate}} ORDER BY Issue.number;",
  "SELECT Issue { number, related_to *1 } FILTER Issue.number = '2';",
  "SELECT Person {name, tag, sub: Person IS DerivedPerson} ORDER BY .name",
  "SELECT Review.<reviews[IS Movie];",
  "SELECT Review.<reviews[IS Movie].title;",
  "SELECT Movie[IS Film];",
  "SELECT Movie[IS Film].title;",
  "SELECT Movie[IS Film & Entity];",
  "SELECT Movie[IS (Film | Entity)];",
  "SELECT Object IS Ba;",
  "SELECT Object IS NOT (Ba | Bb);",
  "SELECT {x := 1} IS (TYPEOF Issue.references | Object);",
  "SELECT Object[IS Ba | Bb | Bc] {tn := .__type__.name, a := Object IS Ba, b := Object IS Bb, c := Object IS Bc};",
  "SELECT CBaBb {tn := .__type__.name, ba, bb} ORDER BY .ba;",
  "SELECT CBaBb[IS CBbBc] {tn := .__type__.name, ba, bb, bc} ORDER BY .ba EMPTY LAST;",
  "SELECT User ORDER BY .name DESC EMPTY FIRST;",
  "SELECT Object[IS (Ba | Bb)][IS (Ba | Bc)] {tn := .__type__.name, [IS Ba].ba, [IS Bb].bb, [IS Bc].bc} ORDER BY .ba EMPTY LAST;",
  "SELECT (SELECT User {name} ORDER BY .name EMPTY LAST);",
  "SELECT (SELECT User {name} ORDER BY .name EMPTY LAST THEN .id EMPTY FIRST);",
  "SELECT [IS Film & Entity];",
  "SELECT Ba { [IS Bb].bb };",
  "SELECT Ba { [IS Bb & Bc].bb };",
  "SELECT Ba { [IS Bb | Bc].bb };",
  "SELECT Ba[IS Bb & Bc] {ba};",
  "SELECT Ba[IS Bb | Bc] {ba};",
  "SELECT A.<l_a[IS S | T] {name} ORDER BY .name;",
  "SELECT A.<l_a[IS S & T] {name} ORDER BY .name;",
  "SELECT W {w_of := .<w[IS X] {name}} FILTER .name = 'www' ORDER BY .name;",
  "SELECT W {w_of := .<w[IS S | T] {name}};",
  "SELECT (FOR x IN Ba UNION (x[IS Bb])) {tn := .__type__.name, ba, bb, [IS Bc].bc};",
  "SELECT (DISTINCT {Ba, Bb}) {tn := .__type__.name, [IS Ba].ba, [IS Bb].bb, [IS Bc].bc} ORDER BY .ba EMPTY LAST THEN .bb EMPTY LAST THEN .bc EMPTY LAST;",
  "SELECT Object[IS (Ba | Bb)][IS (Ba | Bc)] {tn := .__type__.name, [IS Ba].ba, [IS Bb].bb, [IS Bc].bc} ORDER BY .ba EMPTY LAST THEN .bb EMPTY LAST THEN .bc EMPTY LAST;",
  "SELECT Object[IS (Ba | Bb) & (Ba | Bc)] {tn := .__type__.name, [IS Ba].ba, [IS Bb].bb, [IS Bc].bc} ORDER BY .ba EMPTY LAST THEN .bb EMPTY LAST THEN .bc EMPTY LAST;",
  "SELECT (INTROSPECT TYPEOF sum({1, 2, 3})).name;",
  "SELECT (INTROSPECT TYPEOF sum({<int32>1, 2, 3})).name;",
  "SELECT (INTROSPECT TYPEOF sum({<float32>1, 2, 3})).name;",
  "SELECT (INTROSPECT TYPEOF -9223372036854775808).name;",
  "SELECT (INTROSPECT TYPEOF <int64>$0).name;",
  "SELECT schema::Pointer {name};",
  "WITH MODULE schema SELECT Type {name};",
  "SELECT (INTROSPECT std::float64).name;",
  "SELECT (INTROSPECT (tuple<int64>)).name;",
  "WITH A := {1.0, 2.0} SELECT (INTROSPECT TYPEOF A).name;",
  "SELECT Movie.reviews@rating;",
  "SELECT 'qwerty'[2:4];",
  "SELECT <bytes>b'xy';",
  "SELECT Movie {reviews: {@rating}};",
  "SELECT Movie {reviews: {@rating := 3}};",
  "SELECT (1, 'a');",
  "SELECT (1,);",
  "SELECT ();",
  "SELECT (name := 'foo', val := 42);",
  "SELECT call31((a := 1001, b := 1002)).1;",
  "SELECT (1, 'x') ORDER BY .0;",
  "SELECT <tuple<str, int64, int64>>scores ORDER BY .0;",
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
  "SELECT User FILTER .name NOT LIKE '%x';",
  "SELECT FireCard {name} FILTER FireCard IN DaveCard ORDER BY FireCard.name;",
  "WITH x := 2 SELECT x + 1;",
  "WITH x := 2, y := 3 SELECT x + y;",
  "WITH Scorpion := (SELECT Person FILTER .name = 'Scorpion'), SubZero := (SELECT Person FILTER .name = 'Sub-Zero'), SELECT fight(Scorpion, SubZero);",
  "WITH val := <int16>1234, FOR X IN {(2, 2), (10, 10)} SELECT bit_lshift(bit_lshift(val, X.0), X.1) = bit_lshift(val, X.0 + X.1);",
  "SELECT _ := (1, 2) ORDER BY _;",
  "SELECT _ := DETACHED {x := (SELECT User)};",
  "WITH My_Z := (SELECT Z FILTER .name = 'zzz') SELECT _ := My_Z.stw0[IS R].name ORDER BY _;",
  "WITH X := (SELECT _ := {1, 2, 3} FILTER _ < 0) SELECT call5(1, b := X);",
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
  "INSERT Person {name := 'Alice'} UNLESS CONFLICT ON (.name) ELSE (SELECT Person);",
  "INSERT Person {name := 'Alice'} UNLESS CONFLICT ON (.name) ELSE (UPDATE Person SET {name := 'existing'});",
  "INSERT Y { l := (INSERT X { n := <str>$n } UNLESS CONFLICT ON (.n) ELSE (X)) } UNLESS CONFLICT ON (.l);",
  "DELETE User;",
  "DELETE User FILTER .name = 'Alice';",
  "DELETE (SELECT User FILTER .name = 'Alice');",
  "DELETE (SELECT User FILTER User.name = 'Alice');",
  "UPDATE User SET {name := 'x'};",
  "UPDATE User FILTER .name = 'a' SET {name := 'b'};",
  "FOR x IN {1,2} UNION (SELECT x);",
  "FOR x IN {1,2} UNION x + 1;",
  "FOR x IN {1,2} SELECT x + 1;",
  "FOR x IN {1, 2} FOR OPTIONAL y IN {3, 4} SELECT x + y;",
  "FOR User IN User SELECT User.name;",
  "SELECT (FOR u IN .<deck[IS User] SELECT (u.name, u@count)) ORDER BY .0;",
  "WITH N := (FOR n IN {8,9} SELECT n) GROUP {a := 1, b := N} BY .a;",
];

// Captured from Gel's parser through scripts/grammar-spike.py's strict
// AST bridge. These are independent of parseEdgeQLScript (the differential
// comparison below only checks compatibility with sqlite-ts's legacy parser).
const gelAstGoldens: Array<{ query: string; ast: unknown }> = [
  {
    query: "SELECT 1 + 2 * 3;",
    ast: {
      kind: "select_expr",
      expr: {
        kind: "math",
        op: "+",
        left: { kind: "literal", value: 1, numericKind: "integer" },
        right: {
          kind: "math",
          op: "*",
          left: { kind: "literal", value: 2, numericKind: "integer" },
          right: { kind: "literal", value: 3, numericKind: "integer" },
        },
      },
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT call1('-', suffix := 's1');",
    ast: {
      kind: "select_expr",
      expr: {
        kind: "function_call",
        call: {
          name: "call1",
          args: [
            { kind: "expr", expr: { kind: "literal", value: "-" } },
            {
              kind: "named_arg",
              name: "suffix",
              arg: {
                kind: "expr",
                expr: { kind: "literal", value: "s1" },
              },
            },
          ],
        },
      },
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT (INTROSPECT TYPEOF sum({1, 2, 3})).name;",
    ast: {
      kind: "select_expr",
      expr: {
        kind: "field_access",
        expr: {
          kind: "introspect_typeof",
          expr: {
            kind: "function_call",
            call: {
              name: "sum",
              args: [{ kind: "expr", expr: { kind: "set_literal", values: [1, 2, 3] } }],
            },
          },
          typeofForm: true,
        },
        field: "name",
        optional: false,
      },
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT (INTROSPECT std::float64).name;",
    ast: {
      kind: "select_expr",
      expr: {
        kind: "field_access",
        expr: {
          kind: "introspect_typeof",
          expr: { kind: "binding_ref", name: "std::float64" },
          typeofForm: false,
        },
        field: "name",
        optional: false,
      },
      pos: { line: 1, column: 1 },
    },
  },
  {
    query:
      "INSERT Y { l := (INSERT X { n := <str>$n } UNLESS CONFLICT ON (.n) ELSE (X)) } UNLESS CONFLICT ON (.l);",
    ast: {
      kind: "insert",
      typeName: "Y",
      values: {
        l: {
          kind: "expr",
          expr: {
            kind: "mutation_expr",
            statement: {
              kind: "insert",
              typeName: "X",
              values: {
                n: {
                  kind: "expr",
                  expr: {
                    kind: "cast",
                    castType: "str",
                    expr: { kind: "parameter", name: "n" },
                  },
                },
              },
              conflict: {
                onField: "n",
                else: {
                  kind: "select",
                  typeName: "X",
                  shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
                  clauses: {},
                },
              },
              pos: { line: 1, column: 18 },
            },
          },
        },
      },
      conflict: { onField: "l" },
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT User {name};",
    ast: {
      kind: "select",
      typeName: "User",
      shape: [{ kind: "field", name: "name", operation: "assign", origin: "explicit" }],
      fields: ["name"],
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT User {name, age} FILTER .name = 'alice';",
    ast: {
      kind: "select",
      typeName: "User",
      shape: [
        { kind: "field", name: "name", operation: "assign", origin: "explicit" },
        { kind: "field", name: "age", operation: "assign", origin: "explicit" },
      ],
      fields: ["name", "age"],
      filter: {
        kind: "predicate",
        target: { kind: "field", field: "name" },
        op: "=",
        value: "alice",
      },
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT Ba { [IS Bb].bb };",
    ast: {
      kind: "select",
      typeName: "Ba",
      shape: [
        {
          kind: "computed",
          name: "bb",
          expr: {
            kind: "polymorphic_field_ref",
            sourceType: "Bb",
            sourceTypeExpr: { kind: "type_name", name: "Bb" },
            field: "bb",
          },
          operation: "assign",
          origin: "explicit",
        },
      ],
      fields: [],
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT Ba { [IS Bb & Bc].bb };",
    ast: {
      kind: "select",
      typeName: "Ba",
      shape: [
        {
          kind: "computed",
          name: "bb",
          expr: {
            kind: "polymorphic_field_ref",
            sourceType: "",
            sourceTypeExpr: {
              kind: "type_intersection",
              left: { kind: "type_name", name: "Bb" },
              right: { kind: "type_name", name: "Bc" },
            },
            field: "bb",
          },
          operation: "assign",
          origin: "explicit",
        },
      ],
      fields: [],
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT Ba { [IS Bb | Bc].bb };",
    ast: {
      kind: "select",
      typeName: "Ba",
      shape: [
        {
          kind: "computed",
          name: "bb",
          expr: {
            kind: "polymorphic_field_ref",
            sourceType: "",
            sourceTypeExpr: {
              kind: "type_union",
              left: { kind: "type_name", name: "Bb" },
              right: { kind: "type_name", name: "Bc" },
            },
            field: "bb",
          },
          operation: "assign",
          origin: "explicit",
        },
      ],
      fields: [],
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT Ba[IS Bb & Bc] {ba};",
    ast: {
      kind: "select",
      typeName: "Ba",
      typeFilterExprs: [
        {
          kind: "type_intersection",
          left: { kind: "type_name", name: "Bb" },
          right: { kind: "type_name", name: "Bc" },
        },
      ],
      shape: [{ kind: "field", name: "ba", operation: "assign", origin: "explicit" }],
      fields: ["ba"],
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT Ba[IS Bb | Bc] {ba};",
    ast: {
      kind: "select",
      typeName: "Ba",
      typeFilterExprs: [
        {
          kind: "type_union",
          left: { kind: "type_name", name: "Bb" },
          right: { kind: "type_name", name: "Bc" },
        },
      ],
      shape: [{ kind: "field", name: "ba", operation: "assign", origin: "explicit" }],
      fields: ["ba"],
      pos: { line: 1, column: 1 },
    },
  },
  {
    query: "SELECT Object[IS (Ba | Bb)] { [IS Ba].ba };",
    ast: {
      kind: "select",
      typeName: "Object",
      typeFilterExprs: [
        {
          kind: "type_union",
          left: { kind: "type_name", name: "Ba" },
          right: { kind: "type_name", name: "Bb" },
        },
      ],
      shape: [
        {
          kind: "computed",
          name: "ba",
          expr: {
            kind: "polymorphic_field_ref",
            sourceType: "Ba",
            sourceTypeExpr: { kind: "type_name", name: "Ba" },
            field: "ba",
          },
          operation: "assign",
          origin: "explicit",
        },
      ],
      fields: [],
      pos: { line: 1, column: 1 },
    },
  },
];

describe("grammar-backed SELECT parser", () => {
  it.each([
    "SELECT 1 + 2 * 3;",
    "SELECT (Foo.baz ?? ((1, 2), 'huh')).0.1;",
    "SELECT User {friends: {name} FILTER .name != 'x'};",
    "SELECT User {friends: {name} ORDER BY .name};",
    "SELECT array_agg('x' ORDER BY 'x');",
    "WITH val := <int16>1234, FOR X IN {(2, 2), (10, 10)} SELECT X.0 + X.1;",
    'SELECT "1 + 1 = \\(1 + 1)";',
  ])("recognizes syntax from the generated Gel LR table: %s", (query) => {
    expect(acceptsGelGrammarBlock(query)).toBe(true);
  });

  it.each(["SELECT 1 +;", "1 + 2;"])(
    "rejects malformed or non-EdgeQL blocks with Gel tables: %s",
    (query) => {
      expect(acceptsGelGrammarBlock(query)).toBe(false);
    },
  );

  it("retains Gel production names and spans in the generated CST", () => {
    const cst = parseGelGrammarCST("SELECT 1 + 2 * 3;");
    expect(cst).toMatchObject({
      kind: "production",
      name: ["EdgeQLGrammar", "reduce_STARTBLOCK_EdgeQLBlock_EOI"],
    });
    const reductions: string[] = [];
    const visit = (node: GelCSTNode): void => {
      if (node.kind === "production") {
        reductions.push(node.name[1]);
        node.args.forEach(visit);
      }
    };
    if (cst) visit(cst);
    expect(reductions).toContain("reduce_Expr_PLUS_Expr");
  });

  it.each([
    ["SELECT 1;", 1],
    ["SELECT 1 + 2 * 3;", 7],
    ["SELECT (1 + 2) * 3;", 9],
    ["SELECT 1 < 2;", 1],
    ["SELECT true AND false;", 0],
  ] as const)("reduces and executes a Gel-generated scalar AST: %s", (query, expected) => {
    const statement = parseGelGrammarStatement(query);
    const artifact = new CompilerService().compile(schemaFromSdl(""), statement);
    const database = new Database(":memory:");
    try {
      expect(database.prepare(artifact.sql.sql).all(...artifact.sql.params)).toEqual([
        { value: expected },
      ]);
    } finally {
      database.close();
    }
  });

  it("does not silently reduce unsupported generated blocks or expression forms", () => {
    expect(() => parseGelGrammarStatement("SELECT 1; SELECT 2;")).toThrow(
      /simple SELECT statements only/,
    );
    expect(parseGelGrammarStatement("SELECT User {friends: {name}};")).toMatchObject({
      kind: "select",
      shape: [{ kind: "link", name: "friends", shape: [{ kind: "field", name: "name" }] }],
    });
    expect(() => parseGelGrammarStatement("SELECT User {*};")).toThrow(/missing its field name/);
    expect(parseGelGrammarStatement("SELECT 1 ORDER BY 1;")).toMatchObject({
      kind: "select_expr",
      orderBy: { expr: { kind: "literal", value: 1 }, direction: "asc" },
    });
  });

  it("reduces aliases and SELECT filter, sort, and pagination clauses", () => {
    expect(
      parseGelGrammarStatement(
        "SELECT result := User {name} FILTER .name = 'Ada' ORDER BY .name DESC EMPTY FIRST THEN .id OFFSET 2 LIMIT 3;",
      ),
    ).toMatchObject({
      kind: "select",
      typeName: "default::User",
      resultAlias: "result",
      shape: [{ kind: "field", name: "name" }],
      filter: {
        kind: "predicate",
        target: { kind: "field", field: "name" },
        op: "=",
        value: "Ada",
      },
      orderBy: {
        field: "name",
        direction: "desc",
        nullsPosition: "first",
        then: { field: "id", direction: "asc" },
      },
      offset: 2,
      limit: 3,
    });
  });

  it("reduces multiple generated SELECT statements with source positions", () => {
    const statements = parseGelGrammarScript("SELECT 1; SELECT 2;");
    expect(statements.map((statement) => statement.kind)).toEqual(["select_expr", "select_expr"]);
    expect(statements.map((statement) => statement.pos.column)).toEqual([1, 11]);
    expect(parseGelGrammarScript(";;;")).toEqual([]);
  });

  it.each([
    "SELECT User {friends: {name}};",
    "SELECT User {friends: {name} FILTER .name != 'x' ORDER BY .name};",
    "SELECT result := User {name} FILTER .name = 'Ada' ORDER BY .name DESC EMPTY FIRST THEN .id OFFSET 2 LIMIT 3;",
    "SELECT 1 ORDER BY 1 DESC;",
    "SELECT User OFFSET 2;",
  ])("matches the production working AST for a reduced slice: %s", (query) => {
    expect(parseGelGrammarStatement(query, "")).toEqual(parseEdgeQLGrammar(query));
  });

  it("applies an explicit default module to generated object subjects", () => {
    const query = "SELECT User {name};";
    expect(parseGelGrammarStatement(query, "app")).toMatchObject({ typeName: "app::User" });
  });

  it("reduces a generated object-shape query and executes its projected field", () => {
    const schema = schemaFromSdl("type Foo { required name: str; }");
    const { db } = openSQLite(":memory:");
    try {
      materializeSchema(db, schema);
      const table = tableNameForType("default::Foo");
      const insert = db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`);
      insert.run("foo-1", "Ada");
      insert.run("foo-2", "Bea");

      const shaped = parseGelGrammarStatement("SELECT Foo {name} FILTER .name = 'Ada';");
      const shapedArtifact = new CompilerService().compile(schema, shaped);
      const shapedRows = db
        .prepare(shapedArtifact.sql.sql)
        .all(...shapedArtifact.sql.params) as Array<{ name: string }>;
      expect(shapedRows.map((row) => row.name)).toEqual(["Ada"]);

      const path = parseGelGrammarStatement("SELECT Foo.name;");
      const pathArtifact = new CompilerService().compile(schema, path);
      const pathRows = db.prepare(pathArtifact.sql.sql).all(...pathArtifact.sql.params) as Array<{
        value: string;
      }>;
      expect(pathRows.map((row) => row.value)).toEqual(["Ada", "Bea"]);
    } finally {
      db.close();
    }
  });

  it("executes generated object SELECT aliases with filter, sort, and pagination", () => {
    const schema = schemaFromSdl("type Foo { required name: str; }");
    const { db } = openSQLite(":memory:");
    try {
      materializeSchema(db, schema);
      const table = tableNameForType("default::Foo");
      const insert = db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`);
      insert.run("foo-a", "Ada");
      insert.run("foo-b", "Bea");
      insert.run("foo-c", "Cleo");

      const statement = parseGelGrammarStatement(
        "SELECT result := Foo {name} FILTER .name != 'Ada' ORDER BY .name DESC OFFSET 0 LIMIT 1;",
      );
      const artifact = new CompilerService().compile(schema, statement);
      const rows = db.prepare(artifact.sql.sql).all(...artifact.sql.params) as Array<{
        name: string;
      }>;
      expect(rows.map((row) => row.name)).toEqual(["Cleo"]);
    } finally {
      db.close();
    }
  });

  it("compiles generated nested link shapes with their own clauses", () => {
    const schema = schemaFromSdl("type Foo { required name: str; multi friends: Foo; }");
    const statement = parseGelGrammarStatement(
      "SELECT Foo {friends: {name} FILTER .name != 'Ada' ORDER BY .name LIMIT 2};",
    );
    const artifact = new CompilerService().compile(schema, statement);
    expect(artifact.sql.sql.trim()).not.toBe("");
  });

  it("reads link properties from each concrete link table in a union path", () => {
    const schema = schemaFromSdl(`
      type Tgt;
      type Bar { link l: Tgt { property x: str; } }
      type Foo { link l: Tgt { property x: str; } }
      type Baz { link fubar: Bar | Foo; }
    `);
    const statement = parseEdgeQLGrammar("SELECT Baz.fubar.l@x;");
    const artifact = new CompilerService().compile(schema, statement);

    expect(artifact.sql.sql).toContain('"default__bar__l"');
    expect(artifact.sql.sql).toContain('"default__foo__l"');
    expect(artifact.sql.sql).not.toContain('"default__bar|default__foo__l"');
  });

  it("lowers schema-computed link properties as expressions", () => {
    const schema = schemaFromSdl(
      fs.readFileSync(new URL("./schemas/cards.esdl", import.meta.url), "utf8"),
    );
    const statement = parseEdgeQLGrammar(
      "SELECT User {name, deck: {name, @total_cost} ORDER BY .name} FILTER .name = 'Alice';",
    );
    const artifact = new CompilerService().compile(schema, statement);

    expect(artifact.sql.sql).toContain('j1."count" * p1."cost"');
    expect(artifact.sql.sql).not.toContain('j1."total_cost"');
  });

  it.each(gelAstGoldens)("matches Gel AST golden for $query", ({ query, ast }) => {
    expect(parseEdgeQLGrammar(query)).toEqual(ast);
  });

  it.each(queries)("accepts suite query syntax for %s", (query) => {
    expect(() => parseEdgeQLGrammar(query)).not.toThrow();
  });

  it("preserves a top-level result alias used by ORDER BY", () => {
    expect(parseEdgeQLGrammar("SELECT _ := (1, 2) ORDER BY _;")).toMatchObject({
      kind: "select_expr",
      resultAlias: "_",
      orderBy: { expr: { kind: "binding_ref", name: "_" } },
    });
  });

  it("parses DETACHED free-object expressions", () => {
    expect(parseEdgeQLGrammar("SELECT _ := DETACHED {x := (SELECT User)};")).toMatchObject({
      kind: "select_expr",
      expr: { kind: "free_object_constructor", detached: true },
    });
  });

  it("preserves shape cardinality modifiers", () => {
    expect(parseEdgeQLGrammar("SELECT Issue {multi te := .time_estimate};")).toMatchObject({
      kind: "select",
      shape: [{ kind: "computed", name: "te", cardinality: "many" }],
    });
  });

  it("reduces link-property filters and backlink link-property targets", () => {
    expect(
      parseEdgeQLGrammar(
        "SELECT User {deck: {name, cost, @count} FILTER .cost = @count ORDER BY @count DESC};",
      ),
    ).toMatchObject({
      kind: "select",
      shape: [
        {
          kind: "link",
          name: "deck",
          clauses: {
            filter: {
              kind: "predicate",
              target: { kind: "field", field: "cost" },
              op: "=",
              value: { kind: "field_ref", field: "@count" },
            },
          },
        },
      ],
    });

    expect(parseEdgeQLGrammar("SELECT Card FILTER Card.<deck[IS User]@count = 1;")).toMatchObject({
      kind: "select",
      filter: {
        kind: "predicate",
        target: {
          kind: "backlink_property",
          link: "deck",
          sourceType: "User",
          property: "count",
        },
        op: "=",
        value: 1,
      },
    });

    expect(
      parseEdgeQLGrammar("SELECT Card FILTER .<deck[IS User]@count = 1 AND .element != 'Fire';"),
    ).toMatchObject({
      kind: "select",
      filter: {
        kind: "and",
        left: {
          kind: "predicate",
          target: { kind: "backlink_property", link: "deck", property: "count" },
          op: "=",
          value: 1,
        },
        right: {
          kind: "predicate",
          target: { kind: "field", field: "element" },
          op: "!=",
          value: "Fire",
        },
      },
    });

    expect(parseEdgeQLGrammar("SELECT Card FILTER .cost IN .<deck[IS User]@count;")).toMatchObject({
      kind: "select",
      filter: {
        kind: "in_predicate",
        target: { kind: "field", field: "cost" },
        op: "in",
        values: {
          kind: "backlink_property_ref",
          link: "deck",
          sourceType: "User",
          property: "count",
        },
      },
    });

    expect(parseEdgeQLGrammar("SELECT Card FILTER NOT .<deck[IS User]@count = 1;")).toMatchObject({
      kind: "select",
      filter: {
        kind: "not",
        expr: {
          kind: "predicate",
          target: { kind: "backlink_property", link: "deck", property: "count" },
          op: "=",
          value: 1,
        },
      },
    });
  });

  it("resolves link-property paths from bindings in FOR expressions", () => {
    expect(
      parseEdgeQLGrammar(
        "SELECT (FOR Card IN Card FOR owner IN Card.owners SELECT (Card.name, owner.name, owner@count));",
      ),
    ).toMatchObject({
      kind: "select_expr",
      expr: {
        kind: "for_expr",
        body: {
          kind: "for_expr",
          iterator: {
            kind: "field_access",
            expr: { kind: "binding_ref", name: "Card" },
            field: "owners",
          },
          body: {
            kind: "tuple",
            values: [
              {
                kind: "field_access",
                expr: { kind: "binding_ref", name: "Card" },
                field: "name",
              },
              {
                kind: "field_access",
                expr: { kind: "binding_ref", name: "owner" },
                field: "name",
              },
              {
                kind: "field_access",
                expr: { kind: "binding_ref", name: "owner" },
                field: "@count",
              },
            ],
          },
        },
      },
    });
  });

  it("parses link-property assignments on nested INSERT values", () => {
    expect(parseEdgeQLGrammar('INSERT Bar {l := (INSERT Tgt2 { @x := "test" })};')).toMatchObject({
      kind: "insert",
      values: {
        l: {
          kind: "expr",
          expr: {
            kind: "mutation_expr",
            statement: {
              kind: "insert",
              values: { "@x": "test" },
            },
          },
        },
      },
    });
  });

  it("preserves modifiers on free-object fields", () => {
    expect(parseEdgeQLGrammar("SELECT {required user := 1};")).toMatchObject({
      kind: "select_free",
      entries: [{ name: "user", required: true }],
    });
  });

  it("parses legacy recursive links and colon-computed shape expressions", () => {
    const recursive = parseEdgeQLGrammar(
      "SELECT Issue { number, related_to *1 } FILTER Issue.number = '2';",
    );
    expect(recursive).toMatchObject({
      kind: "select",
      shape: [
        { kind: "field", name: "number" },
        { kind: "field", name: "related_to", recursionDepth: 1 },
      ],
    });

    const typed = parseEdgeQLGrammar(
      "SELECT Person {name, tag, sub: Person IS DerivedPerson} ORDER BY .name",
    );
    expect(typed).toMatchObject({
      kind: "select",
      shape: [
        { kind: "field", name: "name" },
        { kind: "field", name: "tag" },
        { kind: "computed", name: "sub", expr: { kind: "select_expr", expr: { kind: "is_type" } } },
      ],
    });
  });

  it.each([
    "SELECT Issue { number, related_to *1 } FILTER Issue.number = '2';",
    "SELECT Person {name, tag, sub: Person IS DerivedPerson} ORDER BY .name",
  ])("keeps local compatibility syntax in the production parser: %s", (query) => {
    expect(() => parseEdgeQLScript(query)).not.toThrow();
  });

  it.each([
    "SELECT 1 +;",
    "SELECT User {name,,};",
    "SELECT (1 + 2;",
    "1 + 2;",
    "SELECT Movie[IS Film &];",
    "SELECT call1(suffix := 's1', 1);",
    "SELECT call1(suffix := 's1', suffix := 's2');",
    "INSERT Person {name := 'Alice'} UNLESS CONFLICT ELSE (Person);",
    "SELECT User ORDER BY .name EMPTY MIDDLE;",
    "SELECT Issue {related_to *5};",
    "SELECT INTROSPECT;",
    "SELECT INTROSPECT TYPEOF;",
    "SELECT 1e999;",
    "SELECT 1e-324;",
    "SELECT 111111111111111111111111;",
    "SELECT 1; SELECT 2;",
  ])("rejects malformed syntax: %s", (query) => {
    expect(() => parseEdgeQLGrammar(query)).toThrow();
  });

  it("rejects unsupported syntax rather than silently delegating to the old parser", () => {
    expect(() => parseEdgeQLGrammar("CREATE TYPE Foo { BLARG; }; ")).toThrow();
    expect(() => parseEdgeQLGrammar("SELECT User GROUP BY .name;")).toThrow();
  });

  it("parses multiple statements with accurate source positions", () => {
    const script = "SELECT 'a;b';\n\nINSERT User {name := 'x;y'}; SELECT 1 + 2";
    const statements = parseEdgeQLGrammarScript(script);
    expect(statements.map((statement) => statement.kind)).toEqual([
      "select_expr",
      "insert",
      "select_expr",
    ]);
    expect(statements.map((statement) => statement.pos.line)).toEqual([1, 3, 3]);
    expect(statements[2]!.pos.column).toBeGreaterThan(statements[1]!.pos.column);
  });

  it("accepts empty statements and does not split on delimiters inside a shape", () => {
    const script = ";; SELECT User {name, friends: {name}};;; SELECT 1;";
    const statements = parseEdgeQLGrammarScript(script);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.kind).toBe("select");
    expect(statements[1]!.kind).toBe("select_expr");
  });

  it.each([
    "SELECT 1 + 2 * 3;",
    "SELECT Issue {name} FILTER .number = '1';",
    "WITH x := 2 SELECT x + 1;",
    "INSERT User { name := 'created' };",
    "UPDATE User FILTER .name = 'a' SET {name := 'b'};",
    "DELETE User FILTER .name = 'a';",
  ])("compiles a grammar-backed query: %s", (query) => {
    const schema = schemaFromSdl(
      fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"),
    );
    const compiler = new CompilerService();
    const artifact = compiler.compile(schema, parseEdgeQLGrammar(query));
    expect(artifact.sql.sql.trim()).not.toBe("");
  });

  it("lowers a grammar-backed GROUP over a WITH/FOR binding to SQLite", () => {
    const schema = schemaFromSdl(
      fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"),
    );
    const query = "WITH N := (FOR n IN {8,9} SELECT n) GROUP {a := 1, b := N} BY .a;";
    const artifact = new CompilerService().compile(schema, parseEdgeQLGrammar(query));

    expect(artifact.sql.loweringMode).toBe("single_statement");
    const database = new Database(":memory:");
    try {
      const row = database.prepare(artifact.sql.sql).get(...artifact.sql.params) as {
        value: string;
      };
      expect(JSON.parse(row.value)).toEqual({
        key: { a: 1 },
        grouping: ["a"],
        elements: [{ a: 1, b: [8, 9] }],
      });
    } finally {
      database.close();
    }
  });

  it("materializes a grammar-backed object WITH binding before SQLite GROUP lowering", () => {
    const schema = schemaFromSdl(
      fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"),
    );
    const query = "WITH I := Issue GROUP I {name} BY .name;";
    const artifact = new CompilerService().compile(schema, parseEdgeQLGrammar(query));

    expect(artifact.sql.loweringMode).toBe("single_statement");
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE default__issue (id TEXT, number TEXT, name TEXT)");
      const insert = database.prepare("INSERT INTO default__issue VALUES (?, ?, ?)");
      insert.run("issue-1", "1", "same");
      insert.run("issue-2", "2", "same");
      insert.run("issue-3", "3", "other");

      const rows = database.prepare(artifact.sql.sql).all(...artifact.sql.params) as Array<{
        value: string;
      }>;
      expect(rows.map((row) => JSON.parse(row.value))).toEqual([
        {
          key: { name: "other" },
          grouping: ["name"],
          elements: [{ id: "issue-3", name: "other" }],
        },
        {
          key: { name: "same" },
          grouping: ["name"],
          elements: [
            { id: "issue-1", name: "same" },
            { id: "issue-2", name: "same" },
          ],
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("accepts every literal success query in the EdgeQL conformance suite", () => {
    const { queries } = extractSuiteQueries();
    const failures: string[] = [];
    for (const { file, query } of queries) {
      try {
        parseEdgeQLGrammarScript(query);
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
        failures.push(`${file}: ${message}: ${query.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
