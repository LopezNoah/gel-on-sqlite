/* eslint-disable */
// Benchmark script targeting the runtime HACK markers:
//   L7768 link_aggregate N+1
//   L7867 nested-link payload N+1
//   L7903 backlink N+1
//   L8161 access-policy TS filter
//   L10791 ORDER BY in TS
//
// Run with: npx tsx scripts/bench-hacks.mjs [iterations]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ITER = parseInt(process.argv[2] ?? "200", 10);

const { openSQLite, materializeSchema } = await import(path.join(ROOT, "src/runtime/database.ts"));
const { ensureGelSchemaTables, serializeSchemaToGelTables, serializeSchemaToInstdata } = await import(path.join(ROOT, "src/schema/gel_persistence.ts"));
const { executeQuery, executeScript } = await import(path.join(ROOT, "src/runtime/engine.ts"));
const { schemaSnapshotFromDeclarative } = await import(path.join(ROOT, "src/schema/uiSchema.ts"));
const { parseDeclarativeSchema } = await import(path.join(ROOT, "src/schema/sdl_adapter.ts"));

const loadSchema = (name) =>
  fs.readFileSync(path.join(ROOT, "tests", "schemas", `${name}.esdl`), "utf8");
const loadSetup = (name) =>
  fs.readFileSync(path.join(ROOT, "tests", "schemas", `${name}.edgeql`), "utf8");

const makeHarness = (schemaName, setupName) => {
  const { db } = openSQLite(":memory:");
  const decl = parseDeclarativeSchema(loadSchema(schemaName), { legacySyntaxCompat: true });
  const schema = schemaSnapshotFromDeclarative(decl);
  materializeSchema(db, schema);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, schema);
  serializeSchemaToInstdata(db, schema);
  executeScript(db, schema, loadSetup(setupName), undefined, { defaultModule: "default" });
  return { db, schema };
};

const instrument = (db) => {
  let count = 0;
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => { count += 1; return orig(sql); };
  return {
    reset: () => { count = 0; },
    count: () => count,
  };
};

const bench = ({ label, harness, query, iter = ITER }) => {
  // Warm + sanity-check.
  const first = executeQuery(harness.db, harness.schema, query);
  const rows = first.rows ?? [];

  const instr = instrument(harness.db);
  instr.reset();
  const t0 = performance.now();
  for (let i = 0; i < iter; i += 1) {
    executeQuery(harness.db, harness.schema, query);
  }
  const t1 = performance.now();
  const ms = t1 - t0;
  const prepares = instr.count();
  return {
    label,
    iter,
    ms: +ms.toFixed(1),
    msPerQuery: +(ms / iter).toFixed(3),
    preparesPerQuery: +(prepares / iter).toFixed(2),
    rows: rows.length,
  };
};

const fmt = (r) =>
  `  ${r.label.padEnd(42)}  iter=${String(r.iter).padStart(4)}  ${String(r.ms).padStart(8)}ms  ${String(r.msPerQuery).padStart(7)}ms/q  prep/q=${String(r.preparesPerQuery).padStart(6)}  rows=${r.rows}`;

console.log(`Benchmark (iterations per query: ${ITER})`);
console.log("============================================================");

const results = [];

// --- cards (links / backlinks / aggregates / ORDER BY) ---
const cards = makeHarness("cards", "cards_setup");

results.push(bench({
  label: "L7867 nested multi-link {deck: {…}}",
  harness: cards,
  query: `SELECT User { name, deck: { name, cost } }`,
}));

results.push(bench({
  label: "L7903 backlink {owners: {…}}",
  harness: cards,
  query: `SELECT Card { name, owners: { name } }`,
}));

results.push(bench({
  label: "L7768 link_aggregate sum(.deck.cost)",
  harness: cards,
  query: `SELECT User { name, deck_cost := sum(.deck.cost) }`,
}));

results.push(bench({
  label: "L10791 select_expr ORDER BY",
  harness: cards,
  query: `SELECT Card.cost ORDER BY Card.cost DESC`,
}));

results.push(bench({
  label: "(control) SELECT Card { name }",
  harness: cards,
  query: `SELECT Card { name }`,
}));

// L8161 (access-policy) is covered by the existing edgeql_select policy
// tests; the SDL adapter in this branch doesn't parse `access policy ...`
// inline, so we can't easily exercise it from this script.

for (const r of results) console.log(fmt(r));
console.log("============================================================");
console.log("Notes: prepares/query > 1 indicates per-row SQL fan-out (N+1).");
