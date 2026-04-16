import { describe, expect, it } from "vitest";
import { openSQLite } from "../src/runtime/database.js";
import { SchemaSnapshot } from "../src/schema/schema.js";
import {
  deserializeSchemaFromGelTables,
  deserializeSchemaFromInstdata,
  ensureGelSchemaTables,
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
} from "../src/schema/gel_persistence.js";
import type { TypeDef } from "../src/types.js";

describe("gel persistence", () => {
  it("round trips a simple schema", () => {
    const runtime = openSQLite();
    ensureGelSchemaTables(runtime.db);

    const typeDef: TypeDef = {
      module: "default",
      name: "Foo",
      fields: [{ name: "name", type: "str", required: true }],
    };

    const snapshot = new SchemaSnapshot([typeDef]);

    serializeSchemaToGelTables(runtime.db, snapshot);
    serializeSchemaToInstdata(runtime.db, snapshot);

    const fromGel = deserializeSchemaFromGelTables(runtime.db);
    const fromCache = deserializeSchemaFromInstdata(runtime.db);

    expect(fromGel?.listTypes().map((type) => type.name)).toEqual(["Foo"]);
    expect(fromCache?.listTypes().map((type) => type.name)).toEqual(["Foo"]);

    runtime.close();
  });
});
