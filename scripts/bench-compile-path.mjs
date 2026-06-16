/* eslint-disable */
// Measures per-test / per-query overheads that the test harness pays:
//   1. cloneSchemaSnapshot   (deep clone+freeze whole schema, every beforeEach)
//   2. computeSchemaFingerprint (first query of every test: fresh clone misses WeakMap)
//   3. compile MISS path  (unique query)
//   4. compile HIT path   (repeated query)
//
// Run: npx tsx scripts/bench-compile-path.mjs [iter]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ITER = parseInt(process.argv[2] ?? "2000", 10);

const { openSQLite, materializeSchema } = await import(path.join(ROOT, "src/runtime/database.ts"));
const { ensureGelSchemaTables, serializeSchemaToGelTables, serializeSchemaToInstdata } = await import(path.join(ROOT, "src/schema/gel_persistence.ts"));
const { executeQuery, executeScript } = await import(path.join(ROOT, "src/runtime/engine.ts"));
const { schemaSnapshotFromDeclarative } = await import(path.join(ROOT, "src/schema/uiSchema.ts"));
const { parseDeclarativeSchema } = await import(path.join(ROOT, "src/schema/sdl_adapter.ts"));
const { parseEdgeQL } = await import(path.join(ROOT, "src/edgeql/parser.ts"));
const { getCompilerService, buildCompileCacheKey } = await import(path.join(ROOT, "src/compiler/service.ts"));
const { SchemaSnapshot } = await import(path.join(ROOT, "src/schema/schema.ts"));

const loadSchema = (name) => fs.readFileSync(path.join(ROOT, "tests", "schemas", `${name}.esdl`), "utf8");
const loadSetup = (name) => fs.readFileSync(path.join(ROOT, "tests", "schemas", `${name}.edgeql`), "utf8");

const cloneDeep = (schema) =>
  new SchemaSnapshot(schema.listTypes(), schema.listFunctions(), schema.listAliases(), schema.listScalarTypes());
const cloneShared = (schema) => SchemaSnapshot.cloneShared(schema);
const cloneSchemaSnapshot = cloneShared;

const buildSchema = (schemaName) => {
  const decl = parseDeclarativeSchema(loadSchema(schemaName), { legacySyntaxCompat: true });
  return schemaSnapshotFromDeclarative(decl);
};

const time = (label, n, fn) => {
  for (let i = 0; i < 50; i++) fn(i); // warm
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const t1 = performance.now();
  const perOp = (t1 - t0) / n;
  console.log(`  ${label.padEnd(46)} ${perOp.toFixed(4)} ms/op   (${n} ops, ${(t1 - t0).toFixed(0)}ms)`);
  return perOp;
};

for (const schemaName of ["cards", "advtypes"]) {
  const base = buildSchema(schemaName);
  const nTypes = base.listTypes().length;
  console.log(`\n=== schema "${schemaName}" (${nTypes} types) ===`);

  // 1. clone — paid in every beforeEach. Compare old deep clone vs new shared.
  time("cloneDeep   (OLD: deep clone+freeze)", ITER, () => cloneDeep(base));
  time("cloneShared (NEW: share frozen defs)", ITER, () => cloneShared(base));

  // 2. per-test first query: key built on a FRESH clone. OLD deep clone misses
  //    the fingerprint cache (recompute); NEW shared clone inherits it.
  const stmt = parseEdgeQL("SELECT 1");
  time("buildKey w/ FRESH cloneDeep   (OLD)", ITER, () =>
    buildCompileCacheKey(cloneDeep(base), stmt));
  time("buildKey w/ FRESH cloneShared (NEW)", ITER, () =>
    buildCompileCacheKey(cloneShared(base), stmt));
}

// 3+4. compile hit/miss on cards via the real engine path
console.log(`\n=== compile hit/miss (cards, real executeQuery) ===`);
const { db } = openSQLite(":memory:");
const cards = buildSchema("cards");
materializeSchema(db, cards);
ensureGelSchemaTables(db);
serializeSchemaToGelTables(db, cards);
serializeSchemaToInstdata(db, cards);
executeScript(db, cards, loadSetup("cards_setup"), undefined, { defaultModule: "default" });

const svc = getCompilerService();
// HIT path: same query repeatedly
const before = svc.stats();
time("HIT: SELECT Card { name } (repeat)", ITER, () =>
  executeQuery(db, cards, "SELECT Card { name }"));
// MISS path: unique query each iter (vary a literal). Fewer iters; each is a real compile.
const MISS_N = Math.min(ITER, 1500);
time("MISS: SELECT Card{name} FILTER .cost=$N (unique)", MISS_N, (i) =>
  executeQuery(db, cards, `SELECT Card { name } FILTER .cost = ${i % 100000}`));
const after = svc.stats();
console.log(`  cache stats: hits=${after.hits - before.hits} misses=${after.misses - before.misses} size=${after.size}`);
