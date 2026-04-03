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
