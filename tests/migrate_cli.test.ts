import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSQLite } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { deserializeSchemaFromInstdata } from "../src/schema/gel_persistence.js";
import {
  diffAgainstApplied,
  generate,
  loadAppliedSource,
  migrate,
  push,
  status,
} from "../src/migrate/migrator.js";

const SCHEMA_V1 = `module default {
  type Person {
    required name: str;
    age: int64;
  }
}`;

const SCHEMA_V2 = `module default {
  type Person {
    required name: str;
    age: int64;
    email: str;
  }
}`;

type DB = ReturnType<typeof openSQLite>["db"];

// Run a query the way an application would: load the schema FROM the database
// (not the in-memory snapshot the migrator built). This is what proves the
// snapshot was refreshed — a stale snapshot would fail or return the old shape.
const queryViaDb = (db: DB, q: string): unknown => {
  const schema = deserializeSchemaFromInstdata(db);
  if (!schema) throw new Error("no persisted schema in DB");
  return executeQuery(db, schema, q);
};

const mkMigrationsDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "gel-mig-"));

describe("migrator — push (stateless)", () => {
  it("creates the schema on first push and the engine can query it from the DB", () => {
    const { db } = openSQLite(":memory:");
    const res = push(db, SCHEMA_V1);
    expect(res.status).toBe("created");
    expect(loadAppliedSource(db)).toBe(SCHEMA_V1);

    queryViaDb(db, "insert default::Person { name := 'Alice', age := 30 };");
    const rows = JSON.stringify(queryViaDb(db, "select default::Person { name, age };"));
    expect(rows).toContain("Alice");
  });

  it("is a no-op when the schema is unchanged", () => {
    const { db } = openSQLite(":memory:");
    push(db, SCHEMA_V1);
    const again = push(db, SCHEMA_V1);
    expect(again.status).toBe("in-sync");
    expect(again.stepCount).toBe(0);
  });

  it("applies an incremental change (ADD COLUMN) and the new field is queryable", () => {
    const { db } = openSQLite(":memory:");
    push(db, SCHEMA_V1);
    queryViaDb(db, "insert default::Person { name := 'Bob', age := 25 };");

    const res = push(db, SCHEMA_V2);
    expect(res.status).toBe("applied");
    expect(res.stepCount).toBeGreaterThan(0);
    expect(res.sql.toUpperCase()).toContain("ADD COLUMN");
    expect(loadAppliedSource(db)).toBe(SCHEMA_V2);

    queryViaDb(db, "update default::Person filter .name = 'Bob' set { email := 'bob@x.io' };");
    const rows = JSON.stringify(queryViaDb(db, "select default::Person { name, email };"));
    expect(rows).toContain("bob@x.io");
  });

  it("preserves and converts column data on a property type change", () => {
    const { db } = openSQLite(":memory:");
    push(db, `module default { type Person { required name: str; age: int64; } }`);
    queryViaDb(db, "insert default::Person { name := 'Alice', age := 30 };");

    const res = push(db, `module default { type Person { required name: str; age: str; } }`);
    expect(res.status).toBe("applied");
    // The data-preserving path: shadow column + CAST, not a destructive re-add.
    expect(res.sql.toUpperCase()).toContain("CAST");
    expect(res.sql.toUpperCase()).toContain("RENAME COLUMN");

    const env = queryViaDb(db, "select default::Person { name, age };") as { rows?: Array<Record<string, unknown>> };
    const out = env.rows ?? [];
    expect(out).toHaveLength(1);
    // The value survived the migration and is now the string "30" (not lost).
    expect(out[0].age).toBe("30");
    expect(out[0].name).toBe("Alice");
  });
});

describe("migrator — status (dry run)", () => {
  it("reports no changes when in sync and pending changes otherwise", () => {
    const { db } = openSQLite(":memory:");
    push(db, SCHEMA_V1);

    expect(status(db, SCHEMA_V1).hasChanges).toBe(false);

    const pending = status(db, SCHEMA_V2);
    expect(pending.hasChanges).toBe(true);
    expect(pending.sql.toUpperCase()).toContain("ADD COLUMN");

    // status must not have mutated anything.
    expect(diffAgainstApplied(db, SCHEMA_V1).hasChanges).toBe(false);
  });
});

describe("migrator — generate + migrate (versioned)", () => {
  it("generates files, applies them to a fresh DB, and is idempotent", () => {
    const dir = mkMigrationsDir();

    const g1 = generate(dir, SCHEMA_V1, "init");
    expect(g1.status).toBe("generated");
    expect(g1.id).toMatch(/^0001_init$/);
    expect(fs.existsSync(path.join(dir, "0001_init.sql"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "meta", "_journal.json"))).toBe(true);

    // Generating again with no schema change produces nothing.
    expect(generate(dir, SCHEMA_V1, "noop").status).toBe("no-changes");

    // A second migration for the V2 delta.
    const g2 = generate(dir, SCHEMA_V2, "add_email");
    expect(g2.status).toBe("generated");
    expect(g2.id).toMatch(/^0002_add_email$/);

    // Apply to a brand-new DB.
    const { db } = openSQLite(":memory:");
    const m1 = migrate(db, dir);
    expect(m1.applied).toEqual(["0001_init", "0002_add_email"]);

    queryViaDb(db, "insert default::Person { name := 'Carol', age := 41, email := 'c@x.io' };");
    const rows = JSON.stringify(queryViaDb(db, "select default::Person { name, email };"));
    expect(rows).toContain("c@x.io");

    // Re-running migrate applies nothing new.
    const m2 = migrate(db, dir);
    expect(m2.applied).toEqual([]);
    expect(m2.alreadyApplied).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
