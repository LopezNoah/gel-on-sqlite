// Real local-D1 smoke test.
//
// Proves the Tier-1 async path end-to-end against an actual Cloudflare D1
// (miniflare's local D1, driven through the real `wrangler` CLI) — not a fake:
//
//   1. Materialize schema + data with the engine into a local sqlite file.
//   2. Dump it to SQL and load it into local D1 via `wrangler d1 execute`.
//   3. Drive the *real* async code (`loadSchemaAsync`, `executeSelectAsync`)
//      through an AsyncRuntimeDatabaseAdapter that executes against local D1 by
//      shelling out to `wrangler d1 execute --json`.
//   4. Assert the rows match the synchronous engine for the same queries.
//
// Run:  node_modules/.bin/tsx smoke/d1_smoke.ts
// (requires a global `wrangler`; uses local D1 only, no network/login.)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AsyncRuntimeDatabaseAdapter } from "../src/runtime/adapter.js";
import { executeSelectAsync } from "../src/runtime/async_query.js";
import { loadSchemaAsync } from "../src/runtime/async_schema.js";
import { materializeSchema, openSQLite } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import {
  ensureGelSchemaTables,
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
} from "../src/schema/gel_persistence.js";
import { loadSchema } from "../src/schema/load.js";
import type { ScalarValue } from "../src/types.js";

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DB_NAME = "smoke";
const SDL = `
abstract type Named {
  required name: str;
}
type Person extending Named {
  age: int64;
}
`;

const QUERIES = [
  "select default::Person { name, age } order by .name;",
  "select default::Person.name order by default::Person.name;",
  "select count(default::Person);",
  "select default::Person { name } filter .age > 26 order by .name;",
];

// --- helpers ---------------------------------------------------------------

const wrangler = (args: string[], input?: string): string =>
  execFileSync("wrangler", ["d1", "execute", DB_NAME, "--local", ...args], {
    cwd: SMOKE_DIR,
    encoding: "utf8",
    input,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });

const d1QueryRaw = (sql: string): Record<string, unknown>[] => {
  const out = wrangler(["--json", "--command", sql]);
  const parsed = JSON.parse(out) as Array<{ results?: Record<string, unknown>[] }>;
  return parsed[0]?.results ?? [];
};

const sqlLiteral = (v: ScalarValue): string => {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${v.replaceAll("'", "''")}'`;
};

// Sequential `?` substitution. Adequate for this smoke fixture (the compiled
// SQL uses `?` only for real params); a Worker uses bound params and needs no
// inlining at all.
const inlineParams = (sql: string, params: ScalarValue[]): string => {
  let i = 0;
  return sql.replace(/\?/g, () => sqlLiteral(params[i++]));
};

// A real (CLI-backed) async D1 adapter, so the production async code runs
// unchanged against local D1.
const wranglerD1Adapter: AsyncRuntimeDatabaseAdapter = {
  target: "d1",
  prepare: (sql: string) => ({
    all: async (...params: ScalarValue[]) => d1QueryRaw(inlineParams(sql, params)),
    run: async (...params: ScalarValue[]) => {
      wrangler(["--command", inlineParams(sql, params)]);
      return { changes: 0 };
    },
  }),
  close: async () => {},
};

const dumpSqlite = (db: ReturnType<typeof openSQLite>["db"]): string => {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string; sql: string }>;
  const lines: string[] = ["PRAGMA defer_foreign_keys = true;"];
  for (const { name, sql } of tables) {
    lines.push(`DROP TABLE IF EXISTS "${name}";`);
    lines.push(`${sql};`);
    const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => sqlLiteral(row[c] as ScalarValue)).join(", ");
      lines.push(`INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals});`);
    }
  }
  return lines.join("\n");
};

// --- run -------------------------------------------------------------------

const main = async (): Promise<void> => {
  // 1. Engine-materialize schema + data into a local sqlite file.
  const dbFile = path.join(SMOKE_DIR, "seed.sqlite");
  fs.rmSync(dbFile, { force: true });
  const { db } = openSQLite(dbFile);
  const schema = loadSchema(SDL, { legacySyntaxCompat: true });
  materializeSchema(db, schema);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, schema);
  serializeSchemaToInstdata(db, schema);
  for (const [name, age] of [["Alice", 30], ["Bob", 25], ["Carol", 41]] as const) {
    executeQuery(db, schema, `insert default::Person { name := '${name}', age := ${age} };`);
  }

  // 2. Dump → load into local D1.
  const dump = dumpSqlite(db);
  const dumpFile = path.join(SMOKE_DIR, "seed.sql");
  fs.writeFileSync(dumpFile, dump);
  console.log(`provisioning local D1 from ${path.basename(dumpFile)} (${dump.split("\n").length} stmts)…`);
  wrangler(["--file", "seed.sql"]);

  // 3. Load schema async from real D1, then run each query through the real
  //    async path and compare to the sync engine.
  const asyncSchema = await loadSchemaAsync(wranglerD1Adapter);
  console.log(`loadSchemaAsync via real D1 → types: ${asyncSchema.listTypes().map((t) => t.name).join(", ")}`);

  let failures = 0;
  for (const q of QUERIES) {
    const expected = executeQuery(db, schema, q).rows;
    const actual = (await executeSelectAsync(wranglerD1Adapter, asyncSchema, q)).rows;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? "✓" : "✗"} ${q}`);
    if (!ok) {
      failures += 1;
      console.log(`    expected: ${JSON.stringify(expected)}`);
      console.log(`    actual:   ${JSON.stringify(actual)}`);
    }
  }

  db.close();
  if (failures > 0) {
    console.error(`\n${failures}/${QUERIES.length} queries diverged on real D1`);
    process.exit(1);
  }
  console.log(`\nall ${QUERIES.length} queries match the sync engine on real local D1 ✓`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
