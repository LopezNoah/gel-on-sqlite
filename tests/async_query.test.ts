import { beforeAll, describe, expect, it } from "vitest";

import { toAsyncAdapter } from "../src/runtime/adapter.js";
import { AsyncUnsupportedError, executeSelectAsync } from "../src/runtime/async_query.js";
import { loadSchemaAsync } from "../src/runtime/async_schema.js";
import { createD1Adapter, type D1DatabaseLike } from "../src/runtime/d1_adapter.js";
import { materializeSchema, openSQLite } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
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

// A minimal in-memory stand-in for Cloudflare's D1Database, backed by the sync
// better-sqlite3 adapter. Proves createD1Adapter translates the D1 shape
// (prepare → bind → all/run) without needing a real Worker.
const fakeD1 = (db: ReturnType<typeof openSQLite>["db"]): D1DatabaseLike => ({
  prepare(sql: string) {
    let bound: ScalarValue[] = [];
    const stmt: ReturnType<D1DatabaseLike["prepare"]> = {
      bind(...values: ScalarValue[]) {
        bound = values;
        return stmt;
      },
      async all<T = Record<string, unknown>>() {
        return { results: db.prepare(sql).all(...bound) as T[] };
      },
      async run() {
        const r = db.prepare(sql).run(...bound);
        return { meta: { changes: r.changes } };
      },
    };
    return stmt;
  },
  async exec(sql: string) {
    db.exec?.(sql);
  },
});

describe("executeSelectAsync (Tier 1: await-at-edge)", () => {
  let db: ReturnType<typeof openSQLite>["db"];
  let schema: ReturnType<typeof loadSchema>;

  beforeAll(() => {
    ({ db } = openSQLite(":memory:"));
    schema = loadSchema(SDL, { legacySyntaxCompat: true });
    materializeSchema(db, schema);
    ensureGelSchemaTables(db);
    serializeSchemaToGelTables(db, schema);
    serializeSchemaToInstdata(db, schema);
    executeQuery(db, schema, "insert default::Person { name := 'Alice', age := 30 };");
    executeQuery(db, schema, "insert default::Person { name := 'Bob', age := 25 };");
    executeQuery(db, schema, "insert default::Person { name := 'Carol', age := 41 };");
  });

  // The core Tier-1 guarantee: the async path returns byte-identical rows to
  // the sync engine for every query that lowers to a single SQL statement.
  const equivalentQueries = [
    "select default::Person { name, age } order by .name;",
    "select default::Person { name } filter .age > 26 order by .name;",
    "select default::Person.name order by default::Person.name;",
    "select count(default::Person);",
    "select default::Person { name, age } order by .age desc limit 2;",
  ];

  for (const q of equivalentQueries) {
    it(`matches the sync engine: ${q}`, async () => {
      const sync = executeQuery(db, schema, q);
      const asyncRes = await executeSelectAsync(toAsyncAdapter(db), schema, q);
      expect(asyncRes.rows).toEqual(sync.rows);
    });
  }

  it("runs identically through the D1 adapter shape", async () => {
    const q = "select default::Person { name, age } order by .name;";
    const sync = executeQuery(db, schema, q);
    const viaD1 = await executeSelectAsync(createD1Adapter(fakeD1(db)), schema, q);
    expect(viaD1.rows).toEqual(sync.rows);
  });

  it("loadSchemaAsync reconstructs a functionally-equivalent schema", async () => {
    const loaded = await loadSchemaAsync(toAsyncAdapter(db));
    expect(loaded.listTypes().map((t) => t.name).sort()).toEqual(
      schema.listTypes().map((t) => t.name).sort(),
    );
    // End-to-end: a query run against the async-loaded schema returns the same
    // rows as the same query against the original in-memory snapshot.
    const q = "select default::Person { name, age } order by .name;";
    const fromLoaded = await executeSelectAsync(toAsyncAdapter(db), loaded, q);
    const fromOriginal = executeQuery(db, schema, q);
    expect(fromLoaded.rows).toEqual(fromOriginal.rows);
  });

  it("rejects mutations with AsyncUnsupportedError", async () => {
    await expect(
      executeSelectAsync(toAsyncAdapter(db), schema, "insert default::Person { name := 'X' };"),
    ).rejects.toBeInstanceOf(AsyncUnsupportedError);
  });

  it("rejects DDL with AsyncUnsupportedError", async () => {
    await expect(
      executeSelectAsync(toAsyncAdapter(db), schema, "create type default::Foo;"),
    ).rejects.toBeInstanceOf(AsyncUnsupportedError);
  });
});
