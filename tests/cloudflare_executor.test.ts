import { describe, expect, it } from "vitest";
import { openSQLite } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { AsyncUnsupportedError } from "../src/runtime/async_query.js";
import { type D1DatabaseLike } from "../src/runtime/d1_adapter.js";
import { type SqlStorageLike } from "../src/runtime/do_adapter.js";
import { deserializeSchemaFromInstdata } from "../src/schema/gel_persistence.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { ScalarValue } from "../src/types.js";
import { Client } from "../src/client/index.js";
import { connectD1 } from "../src/client/d1.js";
import { connectDO } from "../src/client/do.js";
import { push } from "../src/migrate/migrator.js";

const SCHEMA = `module default {
  type Person {
    required name: str;
    age: int64;
  }
}`;

type SyncDb = ReturnType<typeof openSQLite>["db"];

// A DB provisioned exactly as `gel push` would leave it (schema snapshot in
// gel_instdata + physical tables), seeded with two people.
const makeDb = (): { db: SyncDb; schema: SchemaSnapshot } => {
  const { db } = openSQLite(":memory:");
  push(db, SCHEMA);
  const schema = deserializeSchemaFromInstdata(db);
  if (!schema) throw new Error("no schema");
  executeQuery(db, schema, "insert default::Person { name := 'Alice', age := 30 };");
  executeQuery(db, schema, "insert default::Person { name := 'Bob', age := 25 };");
  return { db, schema };
};

// Fake DO SqlStorage over the sync db (mirrors tests/d1_adapter.test.ts).
const makeFakeDO = (db: SyncDb): SqlStorageLike => ({
  exec<T = Record<string, unknown>>(query: string, ...bindings: ScalarValue[]) {
    try {
      const rows = db.prepare(query).all(...bindings) as T[]; // eager: lets write statements fall through
      return { toArray: () => rows, rowsWritten: 0 };
    } catch {
      const r = db.prepare(query).run(...bindings);
      return { toArray: () => [] as T[], rowsWritten: r.changes };
    }
  },
});

// Fake D1 over the sync db.
const makeFakeD1 = (db: SyncDb): D1DatabaseLike => ({
  prepare(sql: string) {
    let params: ScalarValue[] = [];
    const stmt = {
      bind(...values: ScalarValue[]) {
        params = values;
        return stmt;
      },
      async all<T = Record<string, unknown>>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
      async run() {
        return { meta: { changes: db.prepare(sql).run(...params).changes } };
      },
    };
    return stmt;
  },
  async exec(sql: string) {
    db.exec?.(sql);
  },
});

describe("connectDO — Durable Object executor (reads + writes)", () => {
  it("runs reads, single, and parameterized queries", async () => {
    const { db } = makeDb();
    const client = connectDO(makeFakeDO(db));

    const all = await client.query<{ name: string }>("select default::Person { name } order by .name;");
    expect(all.map((r) => r.name)).toEqual(["Alice", "Bob"]);

    const count = await client.queryRequiredSingle<number>("select count(default::Person);");
    expect(count).toBe(2);

    const byName = await client.querySingle<{ name: string; age: number }>(
      "select default::Person { name, age } filter .name = <str>$name;",
      { name: "Alice" },
    );
    expect(byName).toEqual({ name: "Alice", age: 30 });
  });

  it("executes writes through query() (DO storage is synchronous)", async () => {
    const { db } = makeDb();
    const client = connectDO(makeFakeDO(db));

    await client.query("insert default::Person { name := 'Zoe', age := 99 };");
    const count = await client.queryRequiredSingle<number>("select count(default::Person);");
    expect(count).toBe(3);
  });

  it("returns output identical to the file-backed Client", async () => {
    const { db, schema } = makeDb();
    const q = "select default::Person { name, age } order by .name;";
    const viaDO = await connectDO(makeFakeDO(db)).query(q);
    const viaClient = await Client.fromParts(db, schema).query(q);
    expect(viaDO).toEqual(viaClient);
  });
});

describe("connectD1 — D1 executor (reads + deletes)", () => {
  it("runs reads and parameterized queries", async () => {
    const { db } = makeDb();
    const client = await connectD1(makeFakeD1(db));

    const all = await client.query<{ name: string }>("select default::Person { name } order by .name;");
    expect(all.map((r) => r.name)).toEqual(["Alice", "Bob"]);

    const byName = await client.querySingle<{ name: string; age: number }>(
      "select default::Person { name, age } filter .name = <str>$name;",
      { name: "Bob" },
    );
    expect(byName).toEqual({ name: "Bob", age: 25 });
  });

  it("executes a DELETE via the decolored async write path", async () => {
    const { db } = makeDb();
    const client = await connectD1(makeFakeD1(db));

    await client.query("delete default::Person filter .name = <str>$name;", { name: "Alice" });

    const remaining = await client.query<{ name: string }>("select default::Person { name } order by .name;");
    expect(remaining.map((r) => r.name)).toEqual(["Bob"]);
  });

  it("executes a scalar UPDATE via the decolored async write path", async () => {
    const { db } = makeDb();
    const client = await connectD1(makeFakeD1(db));

    await client.query("update default::Person filter .name = 'Bob' set { age := 99 };");

    const bob = await client.querySingle<{ name: string; age: number }>(
      "select default::Person { name, age } filter .name = <str>$name;",
      { name: "Bob" },
    );
    expect(bob).toEqual({ name: "Bob", age: 99 });
  });

  it("still rejects INSERT (not yet decolored)", async () => {
    const { db } = makeDb();
    const client = await connectD1(makeFakeD1(db));
    await expect(
      client.query("insert default::Person { name := 'Nope', age := 1 };"),
    ).rejects.toBeInstanceOf(AsyncUnsupportedError);
  });

  it("returns output identical to the file-backed Client", async () => {
    const { db, schema } = makeDb();
    const q = "select default::Person { name, age } order by .name;";
    const viaD1 = await (await connectD1(makeFakeD1(db))).query(q);
    const viaClient = await Client.fromParts(db, schema).query(q);
    expect(viaD1).toEqual(viaClient);
  });
});
