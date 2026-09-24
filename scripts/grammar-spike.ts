// Run from sqlite-ts: npx tsx scripts/grammar-spike.ts
// Uses Gel's actual Rust+Python grammar pipeline as a syntax oracle, then
// compares the deliberately small Python AST bridge with our working AST.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseEdgeQLScript } from "../src/edgeql/parser.js";
import { parseEdgeQLGrammar } from "../src/edgeql/grammar_parser.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.GEL_PYTHON ?? resolve(root, ".venv/bin/python");
const bridge = fileURLToPath(new URL("./grammar-spike.py", import.meta.url));

const cases: { source: string; gel: boolean; local: boolean; mapped?: boolean }[] = [
  { source: "SELECT 1 + 2 * 3;", gel: true, local: true, mapped: true },
  { source: "SELECT (1 + 2) * 3;", gel: true, local: true, mapped: true },
  { source: "SELECT 3.5 / 2;", gel: true, local: true, mapped: true },
  { source: "SELECT User {name};", gel: true, local: true, mapped: true },
  { source: "SELECT User {name, age} FILTER .name = 'alice';", gel: true, local: true, mapped: true },
  { source: "SELECT User.name;", gel: true, local: true }, // outside the bridge's AST slice
  { source: "SELECT Пример;", gel: true, local: true },
  { source: String.raw`SELECT b'1\t\n1' + b"2\x00";`, gel: true, local: true },
  // sqlite-ts currently consumes these permissively; Gel rejects their syntax.
  { source: "CREATE TYPE Foo { BLARG; };", gel: false, local: true },
  { source: "DESCRIBE nonsense;", gel: false, local: true },
  { source: "SELECT 1 +;", gel: false, local: false },
  { source: "SELECT User {name,,};", gel: false, local: false },
  { source: "1 + 2;", gel: false, local: false }, // parseEdgeQL itself allows bare expressions
  { source: "SELECT 02;", gel: false, local: false },
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
  "SELECT len('hello');",
  "SELECT std::len('hello');",
  "SELECT User.name;",
  "SELECT User {name, age} FILTER .name = 'alice';",
  "WITH x := 2 SELECT x + 1;",
  "WITH x := 2, y := 3 SELECT x + y;",
  "SELECT (1 + 2;",
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
if (verdicts.length !== cases.length + grammarCases.length) throw new Error("Incorrect verdict count");

let mapped = 0;
let different = 0;
let unexpected = 0;
for (const [i, { source, gel: expectGel, local: expectLocal, mapped: expectMapped }] of cases.entries()) {
  const gel = verdicts[i]!;
  let local: unknown;
  let localAccepted = true;
  try {
    local = parseEdgeQLScript(source)[0];
  } catch {
    localAccepted = false;
  }
  // The Python bridge uses JSON; sqlite-ts may have optional keys with
  // undefined values that disappear when transported through JSON.
  const localJson = local === undefined ? undefined : JSON.parse(JSON.stringify(local)) as unknown;
  const sameAst = gel.ast !== undefined && isDeepStrictEqual(gel.ast, localJson);
  if (sameAst) mapped++;
  if (gel.accepted !== localAccepted || (gel.ast !== undefined && !sameAst)) different++;
  if (gel.accepted !== expectGel || localAccepted !== expectLocal
      || (expectMapped === true && !sameAst) || (!expectMapped && gel.ast !== undefined)) {
    unexpected++;
  }
  console.log(`${gel.accepted === localAccepted ? "=" : "!"} ${source}`);
  console.log(`  Gel: ${gel.accepted ? gel.ast !== undefined ? sameAst ? "mapped AST matches" : "mapped AST DIFFERS" : `accepted (unmapped: ${gel.unmapped})` : `rejected (${gel.error})`}`);
  console.log(`  sqlite-ts: ${localAccepted ? "accepted" : "rejected"}`);
  if (gel.ast !== undefined && !sameAst) {
    console.log(`  Gel AST: ${JSON.stringify(gel.ast)}`);
    console.log(`  sqlite-ts AST: ${JSON.stringify(local)}`);
  }
}
console.log(`\n${mapped} mapped AST matches; ${different} differences; ${unexpected} unexpected; ${cases.length} cases`);
let grammarMatches = 0;
for (const [i, source] of grammarCases.entries()) {
  const gel = verdicts[cases.length + i]!;
  let grammarAst: unknown;
  try {
    grammarAst = parseEdgeQLGrammar(source);
  } catch {
    // Only compare accept/reject here; the Python bridge has a narrower AST slice.
  }
  const sameAst = grammarAst !== undefined && isDeepStrictEqual(
    JSON.parse(JSON.stringify(grammarAst)), JSON.parse(JSON.stringify(parseEdgeQLScript(source)[0])),
  );
  if (gel.accepted === (grammarAst !== undefined) && (grammarAst === undefined || sameAst)) grammarMatches++;
  else {
    unexpected++;
    console.log(`TS grammar mismatch: ${source} (Gel ${gel.accepted ? "accepts" : "rejects"}, TS ${grammarAst !== undefined ? "accepts" : "rejects"}, AST ${sameAst ? "matches" : "differs"})`);
  }
}
console.log(`TS grammar: ${grammarMatches}/${grammarCases.length} Gel syntax + sqlite-ts AST matches`);
if (unexpected) process.exitCode = 1;
