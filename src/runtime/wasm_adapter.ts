// sql.js (WASM SQLite) → RuntimeDatabaseAdapter.
//
// sql.js compiles SQLite to WASM with a SYNCHRONOUS API, so — exactly like a
// Durable Object's `ctx.storage.sql` — the full synchronous engine runs against
// it, reads AND writes. That makes Gel-on-SQLite usable in the browser (or any
// WASM host) with no async/Tier-2 work.
//
// sql.js can't host the engine's `_gel_*` custom functions (they're registered
// only on the better-sqlite3 backend), so this uses `target: "d1"` — the
// native-SQL lowering, the same conservative choice as the DO adapter. Full
// `_gel_*` fidelity in the browser would need those impls lifted into a
// bundle-safe module and registered via sql.js `create_function` (future work;
// see docs/adr/0060).
//
// The sql.js surface is declared structurally so this module needs no value
// import of `sql.js` (the host supplies the Database) and stays bundle-safe.

import type { RuntimeDatabaseAdapter, RuntimeStatement } from "./adapter.js";
import { normalizeBindParams } from "./async_backend_util.js";
import type { ScalarValue } from "../types.js";

/** sql.js bind value type (its `SqlValue`) — narrower than the engine's
 *  `ScalarValue` (no `boolean`/`bigint`); params are normalized to this before
 *  binding. Declared here so a real sql.js `Database` is assignable with no cast
 *  on the caller's side. */
export type SqlJsValue = number | string | Uint8Array | null;

/** The slice of a sql.js `Statement` this adapter uses. */
export interface SqlJsStatementLike {
  bind(values?: SqlJsValue[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
}

/** The slice of a sql.js `Database` this adapter uses. */
export interface SqlJsDatabaseLike {
  prepare(sql: string): SqlJsStatementLike;
  run(sql: string): unknown;
  getRowsModified(): number;
  close(): void;
}

export const createSqlJsAdapter = (db: SqlJsDatabaseLike): RuntimeDatabaseAdapter => ({
  target: "d1",
  prepare: (sql: string): RuntimeStatement => ({
    all: (...params: ScalarValue[]) => {
      const stmt = db.prepare(sql);
      try {
        if (params.length > 0) stmt.bind(normalizeBindParams(params) as SqlJsValue[]);
        const rows: Record<string, unknown>[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
    run: (...params: ScalarValue[]) => {
      const stmt = db.prepare(sql);
      try {
        if (params.length > 0) stmt.bind(normalizeBindParams(params) as SqlJsValue[]);
        stmt.step(); // executes the statement
        return { changes: db.getRowsModified() };
      } finally {
        stmt.free();
      }
    },
  }),
  // Multi-statement DDL (sql.js `run` executes every statement in the string).
  exec: (sql: string) => {
    db.run(sql);
  },
  close: () => db.close(),
});
