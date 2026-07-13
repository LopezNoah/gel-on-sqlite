import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { openSQLite } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { deserializeSchemaFromInstdata } from "../src/schema/gel_persistence.js";
import { Client } from "../src/client/index.js";
import { push } from "../src/migrate/migrator.js";
import { connectWasm, provisionWasm } from "../src/client/wasm.js";

const SCHEMA = `module default {
  type Person {
    required name: str;
    age: int64;
  }
}`;

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (file) => path.resolve("node_modules/sql.js/dist", file) });
});

// Provision a fresh WASM db with the schema (push runs over any adapter).
const provision = (db: Database): void => {
  provisionWasm(db, SCHEMA);
};

describe("WASM (sql.js) — full engine in the browser, reads + writes", () => {
  it("provisions the schema and runs reads, writes, and params against real WASM", async () => {
    const db = new SQL.Database();
    provision(db);
    const client = connectWasm(db);

    // Writes work because sql.js is synchronous (the full engine runs).
    await client.query("insert default::Person { name := 'Alice', age := 30 };");
    await client.query("insert default::Person { name := 'Bob', age := 25 };");

    const names = (await client.query<{ name: string }>("select default::Person { name } order by .name;"))
      .map((r) => r.name);
    expect(names).toEqual(["Alice", "Bob"]);

    const count = await client.queryRequiredSingle<number>("select count(default::Person);");
    expect(count).toBe(2);

    const byName = await client.querySingle<{ name: string; age: number }>(
      "select default::Person { name, age } filter .name = <str>$name;",
      { name: "Alice" },
    );
    expect(byName).toEqual({ name: "Alice", age: 30 });
    db.close();
  });

  it("persists across export() → new Database(bytes) (IndexedDB/OPFS round-trip)", async () => {
    const db = new SQL.Database();
    provision(db);
    await connectWasm(db).query("insert default::Person { name := 'Carol', age := 41 };");
    const bytes = db.export();
    db.close();

    // Reopen from the exported bytes — the data and schema survive.
    const reopened = new SQL.Database(bytes);
    const count = await connectWasm(reopened).queryRequiredSingle<number>("select count(default::Person);");
    expect(count).toBe(1);
    const carol = await connectWasm(reopened).querySingle<{ name: string }>(
      "select default::Person { name } filter .name = <str>$n;",
      { n: "Carol" },
    );
    expect(carol).toEqual({ name: "Carol" });
    reopened.close();
  });

  it("produces output identical to the file-backed Client", async () => {
    // WASM side.
    const wdb = new SQL.Database();
    provision(wdb);
    const wclient = connectWasm(wdb);
    await wclient.query("insert default::Person { name := 'Alice', age := 30 };");
    await wclient.query("insert default::Person { name := 'Bob', age := 25 };");
    const q = "select default::Person { name, age } order by .name;";
    const viaWasm = await wclient.query(q);

    // better-sqlite3 side, same schema + data.
    const { db } = openSQLite(":memory:");
    push(db, SCHEMA);
    const schema = deserializeSchemaFromInstdata(db)!;
    executeQuery(db, schema, "insert default::Person { name := 'Alice', age := 30 };");
    executeQuery(db, schema, "insert default::Person { name := 'Bob', age := 25 };");
    const viaClient = await Client.fromParts(db, schema).query(q);

    expect(viaWasm).toEqual(viaClient);
    wdb.close();
  });
});
