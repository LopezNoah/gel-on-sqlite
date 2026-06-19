import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaFromSdl } from "../src/compiler/inspect.js";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import { populateSchemaIntrospection, schemaIntrospectionTypeDefs } from "../src/schema/schema_introspection.js";
import { tableNameForType } from "../src/codegen/sql.js";

// schemaIntrospectionTypeDefs (the meta-type catalog) and
// populateSchemaIntrospection (which fills the schema::* tables so `SELECT
// schema::ObjectType { name }` works) were dark — exercised only when an
// introspection query happened to run. These tests pin the catalog and the
// population (ADR 0050).

const schema = schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"));
const objTable = tableNameForType("schema::ObjectType");

describe("schemaIntrospectionTypeDefs — the meta-type catalog", () => {
  it("exposes the core introspection meta-types", () => {
    const names = new Set(schemaIntrospectionTypeDefs().map((t) => t.name));
    for (const expected of ["ObjectType", "Property", "Link", "Pointer", "ScalarType", "Function", "Type"]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("is a factory — each call returns a fresh, equal catalog (no shared mutable state)", () => {
    const a = schemaIntrospectionTypeDefs();
    const b = schemaIntrospectionTypeDefs();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("populateSchemaIntrospection — fills schema::ObjectType from a snapshot", () => {
  const userTypeNames = schema
    .listTypes()
    .filter((t) => (t.module ?? "default") === "default")
    .map((t) => `default::${t.name}`)
    .sort();

  const objectTypeRows = (db: ReturnType<typeof openSQLite>["db"]): string[] =>
    (db.prepare(`SELECT name FROM ${quote(objTable)} ORDER BY name`).all() as Array<{ name: string }>)
      .map((r) => r.name);

  it("writes a row for every user object type", () => {
    const { db } = openSQLite(":memory:");
    materializeSchema(db, schema);
    populateSchemaIntrospection(db, schema);
    const rows = objectTypeRows(db);
    expect(rows).toEqual(userTypeNames);
    expect(rows).toContain("default::User");
    expect(rows).toContain("default::Issue");
  });

  it("is idempotent — re-populating clears then rewrites, no duplicate rows", () => {
    const { db } = openSQLite(":memory:");
    materializeSchema(db, schema);
    populateSchemaIntrospection(db, schema);
    const first = objectTypeRows(db);
    populateSchemaIntrospection(db, schema);
    expect(objectTypeRows(db)).toEqual(first);
  });
});

function quote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
