import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { SchemaSnapshot } from "../src/schema/schema.js";

describe("executeQuery insert parity", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-PARITY-INSERT.S1] supports basic insert usage and rejects abstract targets", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "Person",
        abstract: true,
        fields: [{ name: "name", type: "str", required: true }],
      },
      {
        module: "default",
        name: "Hero",
        extends: ["default::Person"],
        fields: [
          { name: "name", type: "str", required: true },
          { name: "secret_identity", type: "str" },
        ],
      },
    ]);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);
    const db = runtime.db;

    const basic = executeQuery(db, schema, "insert default::Hero { name := 'Spider-Man' };");
    expect(basic.kind).toBe("insert");
    expect(basic.changes).toBe(1);

    const rows = executeQuery(db, schema, "select default::Hero { name, secret_identity };");
    expect(rows.rows).toEqual([{ name: "Spider-Man", secret_identity: null }]);

    expect(() => executeQuery(db, schema, "insert default::Person { name := 'Nobody' };"))
      .toThrow(/cannot insert into abstract object type/);
  });

  it("[SPEC-PARITY-INSERT.S2][SPEC-PARITY-INSERT.S3][SPEC-PARITY-INSERT.S4] supports link inserts, nested inserts, and with blocks", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "Hero",
        fields: [
          { name: "name", type: "str", required: true },
          { name: "secret_identity", type: "str" },
        ],
        links: [{ name: "villains", targetType: "default::Villain", multi: true }],
      },
      {
        module: "default",
        name: "Villain",
        fields: [
          { name: "name", type: "str", required: true },
          { name: "nemesis_id", type: "uuid" },
        ],
        links: [{ name: "nemesis", targetType: "default::Hero" }],
      },
      {
        module: "default",
        name: "Movie",
        fields: [{ name: "title", type: "str", required: true }],
        links: [{ name: "characters", targetType: "default::Hero", multi: true }],
      },
    ]);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Black Widow', secret_identity := 'Natasha' };");

    executeQuery(
      runtime.db,
      schema,
      "insert default::Villain { name := 'Dreykov', nemesis := (select default::Hero filter .name = 'Black Widow') };",
    );

    executeQuery(
      runtime.db,
      schema,
      "insert default::Hero { name := 'Yelena Belova', villains := {(select default::Villain filter .name = 'Dreykov')} };",
    );

    executeQuery(
      runtime.db,
      schema,
      "insert default::Villain { name := 'The Mandarin', nemesis := (insert default::Hero { name := 'Shang-Chi', secret_identity := 'Shaun' }) };",
    );

    executeQuery(
      runtime.db,
      schema,
      "with black_widow := (select default::Hero filter .name = 'Black Widow') insert default::Movie { title := 'Black Widow', characters := { black_widow, (select default::Hero filter .name = 'Yelena Belova') } };",
    );

    const movie = executeQuery(runtime.db, schema, "select default::Movie { title, characters { name } } filter .title = 'Black Widow';");
    expect(movie.rows?.[0]?.title).toBe("Black Widow");
    expect(movie.rows?.[0]?.characters).toEqual(
      expect.arrayContaining([{ name: "Black Widow" }, { name: "Yelena Belova" }]),
    );
  });

  it("[SPEC-PARITY-INSERT.S5][SPEC-PARITY-INSERT.S6][SPEC-PARITY-INSERT.S7] supports conflict handling and upsert style updates", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "Movie",
        fields: [
          { name: "title", type: "str", required: true },
          { name: "release_year", type: "int", required: true },
        ],
      },
      {
        module: "default",
        name: "Hero",
        fields: [{ name: "name", type: "str", required: true }],
      },
    ]);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Movie { title := 'Eternals', release_year := 2021 };");

    const suppress = executeQuery(
      runtime.db,
      schema,
      "insert default::Movie { title := 'Eternals', release_year := 2022 } unless conflict on .title;",
    );
    expect(suppress.kind).toBe("insert");
    expect(suppress.changes).toBe(0);

    const upsert = executeQuery(
      runtime.db,
      schema,
      "with title := 'Eternals', release_year := 2023 insert default::Movie { title := title, release_year := release_year } unless conflict on .title else (update default::Movie set { release_year := 2023 });",
    );
    expect(upsert.kind).toBe("insert");
    expect(upsert.changes).toBe(1);

    const updated = executeQuery(runtime.db, schema, "select default::Movie { title, release_year } filter .title = 'Eternals';");
    expect(updated.rows).toEqual([{ title: "Eternals", release_year: 2023 }]);

    executeQuery(runtime.db, schema, "insert default::Hero { name := 'The Wasp' };");
    const suppressedNoOn = executeQuery(runtime.db, schema, "insert default::Hero { name := 'The Wasp' } unless conflict;");
    expect(suppressedNoOn.kind).toBe("insert");
    expect(suppressedNoOn.changes).toBe(0);
  });

  it("[SPEC-PARITY-INSERT.S8] supports bulk-like insert batches through scripts", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "Hero",
        fields: [{ name: "name", type: "str", required: true }],
      },
    ]);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Sersi' };");
    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Ikaris' };");
    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Thena' };");

    const rows = executeQuery(runtime.db, schema, "select default::Hero { name } order by name asc;");
    expect(rows.rows).toEqual([{ name: "Ikaris" }, { name: "Sersi" }, { name: "Thena" }]);
  });
});
