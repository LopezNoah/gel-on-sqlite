import { describe, expect, it } from "vitest";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import {
  planSchemaMigration,
  renderMigrationSQL,
  renderSchemaSQL,
  calculateMigrationChecksum,
} from "../src/schema/migrations.js";
import type { DeclarativeSchema } from "../src/schema/declarative.js";

// The schema-diff + SQL-emission path (planSchemaMigration and its renderers)
// is pure over DeclarativeSchema but was exercised only end-to-end. These tests
// pin the diff cases directly: create, no-op, add-property, drop-type, and the
// determinism of the migration checksum (ADR 0050).

const parse = (sdl: string): DeclarativeSchema => parseDeclarativeSchema(sdl, { legacySyntaxCompat: true });
const EMPTY: DeclarativeSchema = { modules: [], types: [] };

const base = parse(`module default {
  type Widget {
    required name: str;
    count: int64;
  }
}`);

const withColor = parse(`module default {
  type Widget {
    required name: str;
    count: int64;
    color: str;
  }
}`);

const twoTypes = parse(`module default {
  type Widget {
    required name: str;
    count: int64;
  }
  type Gadget {
    required label: str;
  }
}`);

describe("renderSchemaSQL / planSchemaMigration — create", () => {
  it("emits CREATE TABLE for a concrete type and the global id registry", () => {
    const sql = renderSchemaSQL(base);
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain('"default__widget"');
    expect(sql).toContain('"__gel_global_ids"');
  });

  it("plans a create when a type is new (empty → base)", () => {
    const sql = renderMigrationSQL(planSchemaMigration(EMPTY, base));
    expect(sql).toContain('"default__widget"');
    expect(sql).not.toContain("DROP TABLE");
  });
});

describe("planSchemaMigration — diff", () => {
  it("is a no-op for an unchanged schema (no ADD COLUMN / DROP)", () => {
    const sql = renderMigrationSQL(planSchemaMigration(base, base));
    expect(sql).not.toMatch(/ADD COLUMN/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it("emits ADD COLUMN when a property is added", () => {
    const sql = renderMigrationSQL(planSchemaMigration(base, withColor));
    expect(sql).toMatch(/ADD COLUMN/i);
    expect(sql).toContain('"color"');
  });

  it("emits a drop step when a type is removed", () => {
    const sql = renderMigrationSQL(planSchemaMigration(twoTypes, base));
    expect(sql).toMatch(/DROP TABLE/i);
    expect(sql).toContain("gadget");
  });
});

describe("calculateMigrationChecksum", () => {
  it("is deterministic for the same plan", () => {
    const a = calculateMigrationChecksum(planSchemaMigration(EMPTY, base));
    const b = calculateMigrationChecksum(planSchemaMigration(EMPTY, base));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the plan changes", () => {
    const a = calculateMigrationChecksum(planSchemaMigration(EMPTY, base));
    const b = calculateMigrationChecksum(planSchemaMigration(EMPTY, withColor));
    expect(a).not.toBe(b);
  });
});
