// Guarded integration test against a REAL local Cloudflare D1 (miniflare, via
// the wrangler CLI). Skips automatically when `wrangler` isn't installed, so
// CI without it stays green; runs the full path when it is.
//
// Replaces the manual smoke/d1_smoke.ts script: provisions local D1 from the
// engine's own materialized schema+data, then drives the real async code
// (loadSchemaAsync, executeSelectAsync, executeManyAsync) against local D1 via
// a wrangler-CLI-backed adapter and diffs against the sync engine.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { AsyncRuntimeDatabaseAdapter } from "../src/runtime/adapter.js";
import { executeManyAsync, executeSelectAsync } from "../src/runtime/async_query.js";
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

const SMOKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "smoke");
const DB_NAME = "smoke";

const wranglerAvailable = (() => {
  try {
    execFileSync("wrangler", ["--version"], { stdio: "ignore" });
    return fs.existsSync(path.join(SMOKE_DIR, "wrangler.toml"));
  } catch {
    return false;
  }
})();

const SDL = `
abstract type Named {
  required name: str;
}
type Person extending Named {
  age: int64;
}
`;

const wrangler = (args: string[]): string =>
  execFileSync("wrangler", ["d1", "execute", DB_NAME, "--local", ...args], {
    cwd: SMOKE_DIR,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });

const sqlLiteral = (v: ScalarValue): string => {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${v.replaceAll("'", "''")}'`;
};

const inlineParams = (sql: string, params: ScalarValue[]): string => {
  let i = 0;
  return sql.replace(/\?/g, () => sqlLiteral(params[i++]));
};

// A real (CLI-backed) async D1 adapter, so production async code runs unchanged
// against local D1. No `batch` → executeManyAsync exercises its sequential path.
const wranglerD1Adapter: AsyncRuntimeDatabaseAdapter = {
  target: "d1",
  prepare: (sql: string) => ({
    all: async (...params: ScalarValue[]) => {
      const out = wrangler(["--json", "--command", inlineParams(sql, params)]);
      const parsed = JSON.parse(out) as Array<{ results?: Record<string, unknown>[] }>;
      return parsed[0]?.results ?? [];
    },
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
    lines.push(`DROP TABLE IF EXISTS "${name}";`, `${sql};`);
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => sqlLiteral(row[c] as ScalarValue)).join(", ");
      lines.push(
        `INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals});`,
      );
    }
  }
  return lines.join("\n");
};

describe.skipIf(!wranglerAvailable)("real local D1 integration", () => {
  let db: ReturnType<typeof openSQLite>["db"];
  let schema: ReturnType<typeof loadSchema>;

  beforeAll(() => {
    const dbFile = path.join(SMOKE_DIR, "seed.sqlite");
    fs.rmSync(dbFile, { force: true });
    ({ db } = openSQLite(dbFile));
    schema = loadSchema(SDL, { legacySyntaxCompat: true });
    materializeSchema(db, schema);
    ensureGelSchemaTables(db);
    serializeSchemaToGelTables(db, schema);
    serializeSchemaToInstdata(db, schema);
    for (const [name, age] of [["Alice", 30], ["Bob", 25], ["Carol", 41]] as const) {
      executeQuery(db, schema, `insert default::Person { name := '${name}', age := ${age} };`);
    }
    fs.writeFileSync(path.join(SMOKE_DIR, "seed.sql"), dumpSqlite(db));
    wrangler(["--file", "seed.sql"]);
  }, 60_000);

  it("loadSchemaAsync reconstructs the schema from real D1", async () => {
    const loaded = await loadSchemaAsync(wranglerD1Adapter);
    expect(loaded.listTypes().map((t) => t.name)).toEqual(
      expect.arrayContaining(["Named", "Person"]),
    );
  }, 30_000);

  it("executeSelectAsync matches the sync engine on real D1", async () => {
    const asyncSchema = await loadSchemaAsync(wranglerD1Adapter);
    for (const q of [
      "select default::Person { name, age } order by .name;",
      "select count(default::Person);",
      "select default::Person { name } filter .age > 26 order by .name;",
      // Math functions: the sync engine computes these via the `_gel_*` custom
      // functions; on real D1 they lower to native SQLite math. Both must agree.
      "select math::sqrt(16.0);",
      "select math::cos(0.0);",
      "select math::ln(1.0);",
      // math::mean lowers to native `avg` on D1 (no `_gel_mean`).
      "select math::mean({2.0, 4.0, 6.0});",
    ]) {
      const actual = (await executeSelectAsync(wranglerD1Adapter, asyncSchema, q)).rows;
      expect(actual).toEqual(executeQuery(db, schema, q).rows);
    }
  }, 60_000);
});
