import type { RuntimeTarget } from "./target.js";
import type { ScalarValue } from "../types.js";

export interface RuntimeStatement {
  all: (...params: ScalarValue[]) => Record<string, unknown>[];
  run: (...params: ScalarValue[]) => { changes: number };
}

export interface AsyncRuntimeStatement {
  all: (...params: ScalarValue[]) => Promise<Record<string, unknown>[]>;
  run: (...params: ScalarValue[]) => Promise<{ changes: number }>;
}

// One statement (SQL + positional params) for a batched async execution.
export interface BatchStatement {
  sql: string;
  params: ScalarValue[];
}

export interface RuntimeDatabaseAdapter {
  target: RuntimeTarget;
  prepare: (sql: string) => RuntimeStatement;
  close: () => void;
  pragma?: (value: string) => unknown;
  exec?: (sql: string) => void;
}

export interface AsyncRuntimeDatabaseAdapter {
  target: RuntimeTarget;
  prepare: (sql: string) => AsyncRuntimeStatement;
  close: () => Promise<void>;
  pragma?: (value: string) => Promise<unknown>;
  exec?: (sql: string) => Promise<void>;
  // Run several read statements together. Backends with a native batch (D1's
  // single round-trip) implement it; callers that need batching fall back to
  // sequential `prepare().all()` when this is absent.
  batch?: (statements: BatchStatement[]) => Promise<Record<string, unknown>[][]>;
}

export interface RuntimeInstance<TAdapter extends RuntimeDatabaseAdapter = RuntimeDatabaseAdapter> {
  db: TAdapter;
  close: () => void;
}

export interface AsyncRuntimeInstance<TAdapter extends AsyncRuntimeDatabaseAdapter = AsyncRuntimeDatabaseAdapter> {
  db: TAdapter;
  close: () => Promise<void>;
}

export const toAsyncAdapter = (adapter: RuntimeDatabaseAdapter): AsyncRuntimeDatabaseAdapter => ({
  target: adapter.target,
  prepare: (sql) => {
    const stmt = adapter.prepare(sql);
    return {
      all: async (...params) => stmt.all(...params),
      run: async (...params) => stmt.run(...params),
    };
  },
  // A sync adapter has no native batch; emulate it sequentially so callers can
  // rely on `batch` being present here (used in tests and the sequential path).
  batch: async (statements) =>
    statements.map((s) => adapter.prepare(s.sql).all(...s.params)),
  close: async () => {
    adapter.close();
  },
  pragma: adapter.pragma
    ? async (value) => adapter.pragma?.(value)
    : undefined,
  exec: adapter.exec
    ? async (sql) => {
      adapter.exec?.(sql);
    }
    : undefined,
});
