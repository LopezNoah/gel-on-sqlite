// Cloudflare D1 backend for the async runtime seam.
//
// D1 exposes a SQL-only, async, binding-based API (no synchronous access, no
// custom-function registration). This adapter maps that surface onto
// `AsyncRuntimeDatabaseAdapter` so the async read path (`executeSelectAsync`)
// can run unchanged against D1 in a Worker. It deliberately imports nothing
// from the native engine / better-sqlite3 so it stays bundle-safe for workerd.
//
// The D1 types are declared structurally (a minimal `D1DatabaseLike`) rather
// than depending on `@cloudflare/workers-types`, so this module has zero
// runtime dependencies. A real `env.DB` satisfies the interface.

import type { AsyncRuntimeDatabaseAdapter, AsyncRuntimeStatement } from "./adapter.js";
import type { ScalarValue } from "../types.js";

export interface D1PreparedStatementLike {
  bind(...values: ScalarValue[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  exec(sql: string): Promise<unknown>;
}

// D1's `.bind()` is a no-op when there are no params, but calling it with zero
// arguments is also legal; we skip it so a parameterless statement reuses the
// prepared statement directly.
const boundStatement = (
  d1: D1DatabaseLike,
  sql: string,
  params: ScalarValue[],
): D1PreparedStatementLike => {
  const stmt = d1.prepare(sql);
  return params.length > 0 ? stmt.bind(...params) : stmt;
};

export const createD1Adapter = (d1: D1DatabaseLike): AsyncRuntimeDatabaseAdapter => ({
  target: "d1",
  prepare: (sql: string): AsyncRuntimeStatement => ({
    all: async (...params: ScalarValue[]) => {
      const result = await boundStatement(d1, sql, params).all();
      return result.results ?? [];
    },
    run: async (...params: ScalarValue[]) => {
      const result = await boundStatement(d1, sql, params).run();
      return { changes: result.meta?.changes ?? 0 };
    },
  }),
  // D1 connections are bindings with no lifecycle to release.
  close: async () => {},
  // D1 has no PRAGMA surface; intentionally omitted (the field is optional).
  exec: async (sql: string) => {
    await d1.exec(sql);
  },
});
