// Cloudflare D1 backend for the async runtime seam.
//
// D1 exposes a SQL-only, async, binding-based API (no synchronous access, no
// custom-function registration). This adapter maps that surface onto
// `AsyncRuntimeDatabaseAdapter` so the async read path (`executeSelectAsync`)
// runs unchanged against D1 in a Worker. It deliberately imports nothing from
// the native engine / better-sqlite3 so it stays bundle-safe for workerd.
//
// The D1 types are declared structurally (a minimal `D1DatabaseLike`) rather
// than depending on `@cloudflare/workers-types`, so this module has zero
// runtime dependencies. A real `env.DB` satisfies the interface.

import type { ScalarValue } from "../types.js";
import type {
  AsyncRuntimeDatabaseAdapter,
  AsyncRuntimeStatement,
  BatchStatement,
} from "./adapter.js";
import { normalizeBindParams, wrapBackendError } from "./async_backend_util.js";

export interface D1PreparedStatementLike {
  bind(...values: ScalarValue[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  exec(sql: string): Promise<unknown>;
  // Optional: D1's multi-statement batch (one round-trip, implicit transaction).
  batch?(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<{ results?: Record<string, unknown>[] }>>;
}

// D1's `.bind()` is a no-op with no params, but calling it with zero arguments
// is also legal; we skip it so a parameterless statement reuses the prepared
// statement directly. Params are normalized for D1's stricter binding.
const bound = (
  d1: D1DatabaseLike,
  sql: string,
  params: ScalarValue[],
): D1PreparedStatementLike => {
  const stmt = d1.prepare(sql);
  const normalized = normalizeBindParams(params);
  return normalized.length > 0 ? stmt.bind(...normalized) : stmt;
};

export const createD1Adapter = (d1: D1DatabaseLike): AsyncRuntimeDatabaseAdapter => ({
  target: "d1",
  prepare: (sql: string): AsyncRuntimeStatement => ({
    all: async (...params: ScalarValue[]) => {
      try {
        const result = await bound(d1, sql, params).all();
        return result.results ?? [];
      } catch (err) {
        throw wrapBackendError("d1", err);
      }
    },
    run: async (...params: ScalarValue[]) => {
      try {
        const result = await bound(d1, sql, params).run();
        return { changes: result.meta?.changes ?? 0 };
      } catch (err) {
        throw wrapBackendError("d1", err);
      }
    },
  }),
  // Run several statements in a single D1 round-trip (network hop). Falls back
  // is handled by the caller when this is absent; here we forward to D1's
  // native batch when the binding supports it.
  batch: d1.batch
    ? async (statements: BatchStatement[]) => {
        try {
          const prepared = statements.map((s) => bound(d1, s.sql, s.params));
          const results = await d1.batch!(prepared);
          return results.map((r) => r.results ?? []);
        } catch (err) {
          throw wrapBackendError("d1", err);
        }
      }
    : undefined,
  // D1 connections are bindings with no lifecycle to release.
  close: async () => {},
  // D1 has no PRAGMA surface; intentionally omitted (the field is optional).
  exec: async (sql: string) => {
    try {
      await d1.exec(sql);
    } catch (err) {
      throw wrapBackendError("d1", err);
    }
  },
});
