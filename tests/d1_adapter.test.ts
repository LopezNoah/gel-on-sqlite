import { beforeAll, describe, expect, it } from "vitest";

import { toAsyncAdapter } from "../src/runtime/adapter.js";
import { executeManyAsync, executeSelectAsync } from "../src/runtime/async_query.js";
import { createD1Adapter, type D1DatabaseLike } from "../src/runtime/d1_adapter.js";
import { materializeSchema, openSQLite } from "../src/runtime/database.js";
import { createDOSqlAdapter, type SqlStorageLike } from "../src/runtime/do_adapter.js";
import { executeQuery } from "../src/runtime/engine.js";
import { AppError } from "../src/errors.js";
import {
  ensureGelSchemaTables,
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
} from "../src/schema/gel_persistence.js";
import { loadSchema } from "../src/schema/load.js";
import type { ScalarValue } from "../src/types.js";

const SDL = `
abstract type Named {
  required name: str;
}
type Person extending Named {
  age: int64;
}
`;

type SyncDb = ReturnType<typeof openSQLite>["db"];

// A configurable fake D1: records bound params, can reject booleans (as real
// D1 does), can fail a statement, and optionally exposes a native batch.
const makeFakeD1 = (
  db: SyncDb,
  opts: { rejectBooleans?: boolean; failWith?: string; withBatch?: boolean } = {},
): { d1: D1DatabaseLike; bound: ScalarValue[][]; batchCalls: number } => {
  const bound: ScalarValue[][] = [];
  const state = { batchCalls: 0 };
  const prepare = (sql: string) => {
    let params: ScalarValue[] = [];
    const stmt = {
      bind(...values: ScalarValue[]) {
        if (opts.rejectBooleans && values.some((v) => typeof v === "boolean")) {
          throw new Error("D1_TYPE_ERROR: Type 'boolean' not supported");
        }
        params = values;
        bound.push(values);
        return stmt;
      },
      async all<T = Record<string, unknown>>() {
        if (opts.failWith) throw new Error(opts.failWith);
        return { results: db.prepare(sql).all(...params) as T[] };
      },
      async run() {
        return { meta: { changes: db.prepare(sql).run(...params).changes } };
      },
    };
    return stmt;
  };
  const d1: D1DatabaseLike = {
    prepare,
    async exec(sql: string) {
      db.exec?.(sql);
    },
    ...(opts.withBatch
      ? {
          async batch(statements) {
            state.batchCalls += 1;
            return Promise.all(statements.map((s) => s.all()));
          },
        }
      : {}),
  };
  return { d1, get bound() { return bound; }, get batchCalls() { return state.batchCalls; } };
};

// A fake Durable Objects SqlStorage backed by the sync sqlite db.
const makeFakeDO = (db: SyncDb): SqlStorageLike => ({
  exec<T = Record<string, unknown>>(query: string, ...bindings: ScalarValue[]) {
    try {
      const rows = db.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows, rowsWritten: 0 };
    } catch {
      const r = db.prepare(query).run(...bindings);
      return { toArray: () => [] as T[], rowsWritten: r.changes };
    }
  },
});

describe("D1/DO adapter improvements", () => {
  let db: SyncDb;
  let schema: ReturnType<typeof loadSchema>;

  beforeAll(() => {
    ({ db } = openSQLite(":memory:"));
    schema = loadSchema(SDL, { legacySyntaxCompat: true });
    materializeSchema(db, schema);
    ensureGelSchemaTables(db);
    serializeSchemaToGelTables(db, schema);
    serializeSchemaToInstdata(db, schema);
    for (const [name, age] of [["Alice", 30], ["Bob", 25], ["Carol", 41]] as const) {
      executeQuery(db, schema, `insert default::Person { name := '${name}', age := ${age} };`);
    }
  });

  it("normalizes boolean params to 1/0 before binding (D1 rejects raw booleans)", async () => {
    const fake = makeFakeD1(db, { rejectBooleans: true });
    const adapter = createD1Adapter(fake.d1);
    // Without normalization this throws (fake D1 rejects booleans).
    const rows = await adapter.prepare("SELECT ? AS v").all(true as unknown as ScalarValue);
    expect(rows).toEqual([{ v: 1 }]);
    expect(fake.bound.at(-1)).toEqual([1]);
  });

  it("maps a missing-custom-function error to AppError with a clear hint", async () => {
    const fake = makeFakeD1(db, { failWith: "no such function: _gel_ceil" });
    const adapter = createD1Adapter(fake.d1);
    let caught: unknown;
    try {
      await adapter.prepare("SELECT _gel_ceil(1)").all();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("E_SQL");
    expect((caught as AppError).hint).toContain("custom function");
  });

  it("executeManyAsync uses the native batch in one round-trip when available", async () => {
    const fake = makeFakeD1(db, { withBatch: true });
    const adapter = createD1Adapter(fake.d1);
    const results = await executeManyAsync(adapter, schema, [
      "select count(default::Person);",
      "select default::Person { name } order by .name;",
    ]);
    expect(fake.batchCalls).toBe(1);
    expect(results[0].rows).toEqual(executeQuery(db, schema, "select count(default::Person);").rows);
    expect(results[1].rows).toEqual(
      executeQuery(db, schema, "select default::Person { name } order by .name;").rows,
    );
  });

  it("executeManyAsync falls back to sequential reads without a native batch", async () => {
    const fake = makeFakeD1(db, { withBatch: false });
    const adapter = createD1Adapter(fake.d1);
    expect(adapter.batch).toBeUndefined();
    const results = await executeManyAsync(adapter, schema, [
      "select count(default::Person);",
    ]);
    expect(results[0].rows).toEqual([3]);
  });

  it("executeManyAsync rejects the whole call if any query is unsupported", async () => {
    const adapter = toAsyncAdapter(db);
    await expect(
      executeManyAsync(adapter, schema, [
        "select count(default::Person);",
        "insert default::Person { name := 'X' };",
      ]),
    ).rejects.toThrow();
  });

  it("the Durable Objects adapter runs reads identically to the sync engine", async () => {
    const adapter = createDOSqlAdapter(makeFakeDO(db));
    expect(adapter.target).toBe("d1");
    const q = "select default::Person { name, age } order by .name;";
    const viaDO = await executeSelectAsync(adapter, schema, q);
    expect(viaDO.rows).toEqual(executeQuery(db, schema, q).rows);
  });

  it("the DO adapter supports batched reads via executeManyAsync", async () => {
    const adapter = createDOSqlAdapter(makeFakeDO(db));
    const [count, people] = await executeManyAsync(adapter, schema, [
      "select count(default::Person);",
      "select default::Person { name } order by .name;",
    ]);
    expect(count.rows).toEqual([3]);
    expect(people.rows).toEqual(
      executeQuery(db, schema, "select default::Person { name } order by .name;").rows,
    );
  });
});
