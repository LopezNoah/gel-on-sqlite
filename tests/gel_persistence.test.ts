import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaFromSdl } from "../src/compiler/inspect.js";
import { openSQLite } from "../src/runtime/database.js";
import {
  ensureGelSchemaTables,
  serializeSchemaToGelTables,
  deserializeSchemaFromGelTables,
  serializeSchemaToInstdata,
  deserializeSchemaFromInstdata,
} from "../src/schema/gel_persistence.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";

// The read side of schema persistence (the gel_* table decoder) is pinned by
// gel_table_decoder.test.ts (ADR 0034); the write side — the serializers — was
// dark, exercised only as test setup. These round-trip tests give the
// serializers a test surface and pin read/write SYMMETRY: a snapshot serialized
// then deserialized must come back equal on its core schema shape (ADR 0050).
//
// Two storage details are deliberately NOT compared: an inline single link's
// `<link>_id` FK column (which the snapshot synthesizes and the round-trip
// re-derives as a plain column) and the stored-vs-computed distinction for some
// computed properties. The projection below normalizes both — it compares
// property NAMES (fields ∪ computeds, minus FK columns), type names, the
// abstract flag, link targets/cardinality, and function arity, which are the
// dimensions the serializers are contracted to preserve.

const orig = schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"));

interface TypeShape {
  name: string;
  abstract: boolean;
  props: string[];
  links: string[];
}

const projectTypes = (s: SchemaSnapshot): TypeShape[] =>
  s
    .listTypes()
    .map((t) => {
      const linkCols = new Set((t.links ?? []).map((l) => `${l.name}_id`));
      const props = [
        ...(t.fields ?? [])
          .filter((f) => !f.isLinkColumn && !linkCols.has(f.name))
          .map((f) => f.name),
        ...(t.computeds ?? []).map((c) => c.name),
      ];
      return {
        name: `${t.module ?? "default"}::${t.name}`,
        abstract: Boolean(t.abstract),
        props: [...new Set(props)].sort(),
        links: (t.links ?? [])
          .map((l) => `${l.name}->${l.targetType ?? "?"}${l.multi ? "[multi]" : ""}`)
          .sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

const projectFns = (s: SchemaSnapshot): string[] =>
  s.listFunctions().map((f) => `${f.name}/${(f.params ?? []).length}`).sort();

const roundTrip = (
  serialize: (db: ReturnType<typeof openSQLite>["db"], s: SchemaSnapshot) => void,
  deserialize: (db: ReturnType<typeof openSQLite>["db"]) => SchemaSnapshot | null,
): SchemaSnapshot => {
  const { db } = openSQLite(":memory:");
  ensureGelSchemaTables(db);
  serialize(db, orig);
  const back = deserialize(db);
  if (!back) throw new Error("deserialize returned null");
  return back;
};

describe("gel_* tables round-trip (serializeSchemaToGelTables ↔ deserializeSchemaFromGelTables)", () => {
  const back = roundTrip(serializeSchemaToGelTables, deserializeSchemaFromGelTables);

  it("preserves the type set, abstract flags, properties, and links", () => {
    expect(projectTypes(back)).toEqual(projectTypes(orig));
  });

  it("preserves the function set", () => {
    expect(projectFns(back)).toEqual(projectFns(orig));
  });
});

describe("instdata blob round-trip (serializeSchemaToInstdata ↔ deserializeSchemaFromInstdata)", () => {
  const back = roundTrip(serializeSchemaToInstdata, deserializeSchemaFromInstdata);

  it("preserves the type set, abstract flags, properties, and links", () => {
    expect(projectTypes(back)).toEqual(projectTypes(orig));
  });

  it("preserves the function set", () => {
    expect(projectFns(back)).toEqual(projectFns(orig));
  });
});

describe("serializer details that must survive the round trip", () => {
  it("keeps a multi link multi and an abstract type abstract (gel tables)", () => {
    const back = roundTrip(serializeSchemaToGelTables, deserializeSchemaFromGelTables);
    const issue = back.getType("default::Issue");
    expect(issue?.links?.find((l) => l.name === "watchers")?.multi).toBe(true);
    expect(back.getType("default::Named")?.abstract).toBe(true);
  });

  it("returns null from the gel-table decoder when nothing was serialized", () => {
    const { db } = openSQLite(":memory:");
    ensureGelSchemaTables(db);
    expect(deserializeSchemaFromGelTables(db)).toBeNull();
  });
});
