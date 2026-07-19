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

// SQLite statements are reusable, but preparing them is comparatively costly
// for the small repeated queries the runtime issues. Keep this cache owned by
// one connection so statements never cross connection or lifecycle boundaries.
export const cacheStatements = <TStatement>(
  prepare: (sql: string) => TStatement,
  capacity = 256,
): ((sql: string) => TStatement) => {
  const statements = new Map<string, TStatement>();
  return (sql: string): TStatement => {
    const cached = statements.get(sql);
    if (cached !== undefined) {
      statements.delete(sql);
      statements.set(sql, cached);
      return cached;
    }

    const statement = prepare(sql);
    statements.set(sql, statement);
    if (statements.size > capacity) {
      const oldest = statements.keys().next().value;
      if (oldest !== undefined) statements.delete(oldest);
    }
    return statement;
  };
};

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
