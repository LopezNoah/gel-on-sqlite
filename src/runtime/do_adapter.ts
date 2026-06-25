// Durable Objects SQL storage backend for the async runtime seam.
//
// A DO's `ctx.storage.sql` is a SQLite database co-located with the object.
// Unlike D1 it is SYNCHRONOUS (`sql.exec()` returns a cursor immediately) and
// it is full SQLite — but, like D1, it cannot register custom JS functions, so
// the same `_gel_*` constraint applies. This adapter presents the sync DO API
// through the async `AsyncRuntimeDatabaseAdapter` so it reuses the exact same
// read path (`executeSelectAsync`, `loadSchemaAsync`) as D1, with no extra
// code. Bundle-safe for workerd: imports nothing native.
//
// NOTE: because DO SQL is synchronous, a DO could in principle run the *full*
// synchronous engine (writes included) directly — see the project notes on
// making engine.ts bundle-safe. This adapter covers the read path that works
// today; the sync-engine-on-DO path is a larger follow-up.
//
// The DO type is declared structurally so this module needs no
// `@cloudflare/workers-types`. `ctx.storage.sql` satisfies `SqlStorageLike`.

import type { ScalarValue } from "../types.js";
import type {
  AsyncRuntimeDatabaseAdapter,
  AsyncRuntimeStatement,
  BatchStatement,
} from "./adapter.js";
import { normalizeBindParams, wrapBackendError } from "./async_backend_util.js";

export interface SqlStorageCursorLike<T = Record<string, unknown>> {
  toArray(): T[];
  // Number of rows written by the statement (cursor field on the real API).
  rowsWritten?: number;
}

export interface SqlStorageLike {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: ScalarValue[]
  ): SqlStorageCursorLike<T>;
}

const run = (sql: SqlStorageLike, query: string, params: ScalarValue[]) =>
  sql.exec(query, ...normalizeBindParams(params));

export const createDOSqlAdapter = (sql: SqlStorageLike): AsyncRuntimeDatabaseAdapter => ({
  // DO SQL cannot host custom functions, so the D1 compatibility rules apply
  // (the conservative, safe choice — a dedicated "do" target could allow more
  // of DO's native SQLite built-ins later).
  target: "d1",
  prepare: (query: string): AsyncRuntimeStatement => ({
    all: async (...params: ScalarValue[]) => {
      try {
        return run(sql, query, params).toArray();
      } catch (err) {
        throw wrapBackendError("durable-object", err);
      }
    },
    run: async (...params: ScalarValue[]) => {
      try {
        const cursor = run(sql, query, params);
        // Consume the cursor so the statement actually executes, then report
        // rows written.
        cursor.toArray();
        return { changes: cursor.rowsWritten ?? 0 };
      } catch (err) {
        throw wrapBackendError("durable-object", err);
      }
    },
  }),
  // DO SQL has no network round-trip, so "batch" is just sequential local
  // execution (already atomic within the object's storage).
  batch: async (statements: BatchStatement[]) => {
    try {
      return statements.map((s) => run(sql, s.sql, s.params).toArray());
    } catch (err) {
      throw wrapBackendError("durable-object", err);
    }
  },
  close: async () => {},
  exec: async (query: string) => {
    try {
      sql.exec(query);
    } catch (err) {
      throw wrapBackendError("durable-object", err);
    }
  },
});
