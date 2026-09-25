// Run from sqlite-ts: npx tsx scripts/grammar-spike.ts
// Uses Gel's actual Rust+Python grammar pipeline as a syntax oracle, then
// compares the deliberately small Python AST bridge with the grammar parser.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseEdgeQLGrammar } from "../src/edgeql/grammar_parser.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.GEL_PYTHON ?? resolve(root, ".venv/bin/python");
const bridge = fileURLToPath(new URL("./grammar-spike.py", import.meta.url));

const cases: { source: string; gel: boolean; mapped?: boolean }[] = [
  { source: "SELECT 1 + 2 * 3;", gel: true, mapped: true },
  { source: "SELECT (1 + 2) * 3;", gel: true, mapped: true },
  { source: "SELECT 3.5 / 2;", gel: true, mapped: true },
  { source: "SELECT call1('-', suffix := 's1');", gel: true, mapped: true },
  { source: "SELECT (INTROSPECT TYPEOF sum({1, 2, 3})).name;", gel: true, mapped: true },
  { source: "SELECT (INTROSPECT std::float64).name;", gel: true, mapped: true },
  {
    source:
      "INSERT Y { l := (INSERT X { n := <str>$n } UNLESS CONFLICT ON (.n) ELSE (X)) } UNLESS CONFLICT ON (.l);",
    gel: true,
    mapped: true,
  },
  { source: "SELECT User {name};", gel: true, mapped: true },
  { source: "SELECT User {name, age} FILTER .name = 'alice';", gel: true, mapped: true },
  { source: "SELECT Ba { [IS Bb].bb };", gel: true, mapped: true },
  { source: "SELECT Ba { [IS Bb & Bc].bb };", gel: true, mapped: true },
  { source: "SELECT Ba { [IS Bb | Bc].bb };", gel: true, mapped: true },
  { source: "SELECT Object[IS (Ba | Bb)] { [IS Ba].ba };", gel: true, mapped: true },
  { source: "SELECT Ba[IS Bb & Bc] {ba};", gel: true, mapped: true },
  { source: "SELECT Ba[IS Bb | Bc] {ba};", gel: true, mapped: true },
  { source: "SELECT User.name;", gel: true }, // outside the bridge's AST slice
  { source: "SELECT Пример;", gel: true },
  { source: String.raw`SELECT b'1\t\n1' + b"2\x00";`, gel: true },
  { source: "CREATE TYPE Foo { BLARG; };", gel: false },
  { source: "DESCRIBE nonsense;", gel: false },
  { source: "SELECT call1(suffix := 's1', 1);", gel: false },
  { source: "SELECT call1(suffix := 's1', suffix := 's2');", gel: false },
  { source: "INSERT Person {name := 'Alice'} UNLESS CONFLICT ELSE (Person);", gel: false },
  { source: "SELECT 1 +;", gel: false },
  { source: "SELECT User {name,,};", gel: false },
  { source: "1 + 2;", gel: false },
  { source: "SELECT 02;", gel: false },
];
// The TypeScript grammar's larger slice. Gel remains an offline oracle; the
// runtime and the working-AST mapping are both TypeScript.
const grammarCases = [
  "SELECT -2 ^ 2;",
  "SELECT 2 ^ 3 ^ 2;",
  "SELECT 1 ?? 2 + 3;",
  "SELECT 1 ?? 2 ?? 3;",
  "SELECT 1 = 2 OR 3 = 4;",
  "SELECT 'a' ++ 'b';",
  'SELECT "1 + 1 = \\(1 + 1)";',
  "SELECT len('hello');",
  "SELECT std::len('hello');",
  "SELECT (INTROSPECT TYPEOF sum({1, 2, 3})).name;",
  "SELECT (INTROSPECT TYPEOF sum({<int32>1, 2, 3})).name;",
  "SELECT (INTROSPECT TYPEOF sum({<float32>1, 2, 3})).name;",
  "SELECT (INTROSPECT TYPEOF -9223372036854775808).name;",
  "SELECT (INTROSPECT TYPEOF <int64>$0).name;",
  "SELECT (INTROSPECT std::float64).name;",
  "SELECT (INTROSPECT (tuple<int64>)).name;",
  "SELECT call31((a := 1001, b := 1002)).1;",
  "SELECT call21(<array<str>>[]);",
  "SELECT <Named & Owned>{};",
  "SELECT foo(<File | URL>{});",
  "SELECT <optional int64>$0;",
  "SELECT <required int64>$x;",
  "SELECT (1, 'x') ORDER BY .0;",
  "SELECT _ := (1, 2) ORDER BY _;",
  "SELECT _ := DETACHED {x := (SELECT User)};",
  "WITH Scorpion := (SELECT Person FILTER .name = 'Scorpion'), SubZero := (SELECT Person FILTER .name = 'Sub-Zero'), SELECT fight(Scorpion, SubZero);",
  "WITH val := <int16>1234, FOR X IN {(2, 2), (10, 10)} SELECT bit_lshift(bit_lshift(val, X.0), X.1) = bit_lshift(val, X.0 + X.1);",
  "SELECT call1('-', suffix := lower('S1'),);",
  "SELECT call1(empty := 42);",
  "INSERT Y { l := (INSERT X { n := <str>$n } UNLESS CONFLICT ON (.n) ELSE (X)) } UNLESS CONFLICT ON (.l);",
  "SELECT call1(suffix := 's1', 1);",
  "SELECT call1(suffix := 's1', suffix := 's2');",
  "INSERT Person {name := 'Alice'} UNLESS CONFLICT ELSE (Person);",
  "SELECT User.name;",
  "SELECT schema::Pointer {name};",
  "WITH MODULE schema SELECT Type {name};",
  "SELECT User {name, age} FILTER .name = 'alice';",
  "SELECT User {*};",
  "SELECT User {number} ORDER BY User.number OFFSET (SELECT count(Status));",
  "SELECT User {friends: {name} ORDER BY .name};",
  "SELECT User {friends: {name} FILTER .name != 'x'};",
  "SELECT User FILTER .name NOT LIKE '%x';",
  "SELECT FireCard {name} FILTER FireCard IN DaveCard ORDER BY FireCard.name;",
  "WITH x := 2 SELECT x + 1;",
  "WITH x := 2, y := 3 SELECT x + y;",
  "SELECT (1 + 2;",
  "SELECT User {friends: {name}, nick := .name} ORDER BY .name;",
  "SELECT CBaBb[IS CBbBc] {tn := .__type__.name, ba, bb, bc} ORDER BY .ba EMPTY LAST;",
  "SELECT Object[IS (Ba | Bb)][IS (Ba | Bc)] {tn := .__type__.name, [IS Ba].ba, [IS Bb].bb, [IS Bc].bc} ORDER BY .ba EMPTY LAST;",
  "SELECT (SELECT User {name} ORDER BY .name EMPTY LAST THEN .id EMPTY FIRST);",
  "SELECT (DISTINCT {Ba, Bb}) {tn := .__type__.name, [IS Ba].ba, [IS Bb].bb, [IS Bc].bc} ORDER BY .ba EMPTY LAST THEN .bb EMPTY LAST THEN .bc EMPTY LAST;",
  "SELECT Object[IS (Ba | Bb)][IS (Ba | Bc)] {tn := .__type__.name, [IS Ba].ba, [IS Bb].bb, [IS Bc].bc} ORDER BY .ba EMPTY LAST THEN .bb EMPTY LAST THEN .bc EMPTY LAST;",
  "SELECT Object[IS (Ba | Bb) & (Ba | Bc)] {tn := .__type__.name, [IS Ba].ba, [IS Bb].bb, [IS Bc].bc} ORDER BY .ba EMPTY LAST THEN .bb EMPTY LAST THEN .bc EMPTY LAST;",
  "SELECT A.<l_a[IS S | T] {name} ORDER BY .name;",
  "SELECT A.<l_a[IS S & T] {name} ORDER BY .name;",
  "SELECT Object IS Ba;",
  "SELECT Object IS NOT (Ba | Bb);",
  "SELECT {x := 1} IS (TYPEOF Issue.references | Object);",
  "SELECT Object[IS Ba | Bb | Bc] {tn := .__type__.name, a := Object IS Ba, b := Object IS Bb, c := Object IS Bc};",
  "SELECT W {w_of := .<w[IS X] {name}} FILTER .name = 'www' ORDER BY .name;",
  "SELECT W {w_of := .<w[IS S | T] {name}};",
  "SELECT (FOR x IN Ba UNION (x[IS Bb])) {tn := .__type__.name, ba, bb, [IS Bc].bc};",
  "SELECT {a := 1, b := 2};",
  "SELECT {required user := 1};",
  "SELECT {1.1, 2.2};",
  "SELECT [1, 2, 3];",
  "SELECT array_agg('x' ORDER BY 'x');",
  "SELECT DISTINCT User;",
  "SELECT EXISTS User;",
  "SELECT <str>$foo;",
  "SELECT 1 IF true ELSE 2;",
  "if true then 10 else 11",
  "SELECT (SELECT User {name});",
  "SELECT (WITH x := 1, FOR y IN {1, 2} UNION y);",
  "INSERT User {name := 'Alice'} UNLESS CONFLICT ON (.name);",
  "UPDATE User FILTER .name = 'a' SET {name := 'b'};",
  "DELETE User FILTER .name = 'a';",
  "FOR x IN {1, 2} UNION (SELECT x);",
  "FOR x IN {1, 2} FOR OPTIONAL y IN {3, 4} SELECT x + y;",
  "SELECT (FOR u IN .<deck[IS User] SELECT (u.name, u@count)) ORDER BY .0;",
];

type Verdict = { accepted: boolean; ast?: unknown; unmapped?: string; error?: string };
const run = spawnSync(python, [bridge], {
  cwd: root,
  encoding: "utf8",
  input: JSON.stringify([...cases.map(({ source }) => source), ...grammarCases]),
  env: { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(":") },
});
if (run.error || run.status !== 0) {
  throw new Error(`Gel parser failed: ${run.error ?? run.stderr}`);
}
const verdicts = JSON.parse(run.stdout) as Verdict[];
if (verdicts.length !== cases.length + grammarCases.length)
  throw new Error("Incorrect verdict count");

let mapped = 0;
let different = 0;
let unexpected = 0;
for (const [i, { source, gel: expectGel, mapped: expectMapped }] of cases.entries()) {
  const gel = verdicts[i];
  let grammarAst: unknown;
  try {
    grammarAst = parseEdgeQLGrammar(source);
  } catch {
    // A thrown grammar error is the parser's rejection verdict.
  }
  const grammarAccepted = grammarAst !== undefined;
  // The Python bridge uses JSON; optional AST keys with undefined values
  // disappear during transport.
  const grammarJson =
    grammarAst === undefined ? undefined : (JSON.parse(JSON.stringify(grammarAst)) as unknown);
  const sameAst = gel.ast !== undefined && isDeepStrictEqual(gel.ast, grammarJson);
  if (sameAst) mapped++;
  if (gel.accepted !== grammarAccepted || (gel.ast !== undefined && !sameAst)) different++;
  if (
    gel.accepted !== expectGel ||
    grammarAccepted !== expectGel ||
    (expectMapped === true && !sameAst) ||
    (!expectMapped && gel.ast !== undefined)
  ) {
    unexpected++;
  }
  console.log(`${gel.accepted === grammarAccepted ? "=" : "!"} ${source}`);
  console.log(
    `  Gel: ${gel.accepted ? (gel.ast !== undefined ? (sameAst ? "mapped AST matches" : "mapped AST DIFFERS") : `accepted (AST subset unmapped: ${gel.unmapped})`) : `rejected (${gel.error})`}`,
  );
  console.log(`  grammar parser: ${grammarAccepted ? "accepted" : "rejected"}`);
  if (gel.ast !== undefined && !sameAst) {
    console.log(`  Gel AST: ${JSON.stringify(gel.ast)}`);
    console.log(`  grammar AST: ${JSON.stringify(grammarAst)}`);
  }
}
console.log(
  `\n${mapped} Gel AST mappings match; ${different} Gel/parser differences; ${unexpected} unexpected; ${cases.length} cases`,
);
let grammarMatches = 0;
for (const [i, source] of grammarCases.entries()) {
  const gel = verdicts[cases.length + i];
  let grammarAccepted = true;
  try {
    parseEdgeQLGrammar(source);
  } catch {
    grammarAccepted = false;
  }
  if (gel.accepted === grammarAccepted) grammarMatches++;
  else {
    unexpected++;
    console.log(
      `TS grammar mismatch: ${source} (Gel ${gel.accepted ? "accepts" : "rejects"}, TS ${grammarAccepted ? "accepts" : "rejects"})`,
    );
  }
}
console.log(
  `TS grammar: ${grammarMatches}/${grammarCases.length} Gel syntax acceptance verdicts match`,
);
if (unexpected) process.exitCode = 1;
