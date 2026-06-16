/* eslint-disable */
// Isolates the compile MISS path: clears the compile cache each iteration so
// every call does a full AST->gelIR->SQL lowering (incl. per-compile resolver
// construction). Used to measure resolver-memoization changes.
// Run: npx tsx scripts/bench-miss.mjs [iter]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ITER = parseInt(process.argv[2] ?? "4000", 10);

const { schemaSnapshotFromDeclarative } = await import(path.join(ROOT, "src/schema/uiSchema.ts"));
const { parseDeclarativeSchema } = await import(path.join(ROOT, "src/schema/sdl_adapter.ts"));
const { parseEdgeQL } = await import(path.join(ROOT, "src/edgeql/parser.ts"));
const { getCompilerService } = await import(path.join(ROOT, "src/compiler/service.ts"));

const loadSchema = (name) => fs.readFileSync(path.join(ROOT, "tests", "schemas", `${name}.esdl`), "utf8");
const buildSchema = (name) => schemaSnapshotFromDeclarative(parseDeclarativeSchema(loadSchema(name), { legacySyntaxCompat: true }));

const time = (label, n, fn) => {
  for (let i = 0; i < 50; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const t1 = performance.now();
  console.log(`  ${label.padEnd(40)} ${((t1 - t0) / n).toFixed(4)} ms/op   (${(t1 - t0).toFixed(0)}ms)`);
};

const svc = getCompilerService();

for (const [schemaName, query] of [
  ["enums", "SELECT Foo { color } FILTER .color = <color_enum_t>'GREEN'"],
  ["cards", "SELECT Card { name } FILTER .cost > 2"],
]) {
  const schema = buildSchema(schemaName);
  const stmt = parseEdgeQL(query);
  console.log(`\n=== ${schemaName}: ${query} ===`);
  // MISS: clear the cache each iteration -> full compile every time.
  time("compile MISS (full lowering)", ITER, () => { svc.clear(); svc.compile(schema, stmt); });
  // HIT: warm once, then repeat -> measures clone-to-return only.
  svc.clear(); svc.compile(schema, stmt);
  time("compile HIT  (cached)", ITER, () => svc.compile(schema, stmt));
}
