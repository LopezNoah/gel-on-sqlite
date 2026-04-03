import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { SchemaSnapshot } from "../src/schema/schema.js";

describe("executeQuery with blocks", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-034.S21] executes select queries prefixed with with blocks", () => {
    // EdgeQL schema:
    // module default {
    //   type Hero {
    //     required name: str;
    //     secret_identity: str;
    //   }
    // }
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "Hero",
        fields: [
          { name: "name", type: "str", required: true },
          { name: "secret_identity", type: "str" },
        ],
      },
    ]);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Iron Man', secret_identity := 'Tony Stark' };");
    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Spider-Man', secret_identity := 'Peter Parker' };");

    const result = executeQuery(
      runtime.db,
      schema,
      "with hero_name := 'Iron Man' select default::Hero { secret_identity } filter .name = hero_name;",
    );

    expect(result.kind).toBe("select");
    expect(result.rows).toEqual([{ secret_identity: "Tony Stark" }]);
  });

  it("[SPEC-PARITY-WITH.S1][SPEC-PARITY-WITH.S2][SPEC-PARITY-WITH.S3][SPEC-PARITY-WITH.S4] executes extended with-block semantics", () => {
    // EdgeQL schema:
    // module default {
    //   type User {
    //     required name: str;
    //     active: bool;
    //   }
    // }
    // module analytics {
    //   type User { required name: str; }
    // }
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [
          { name: "name", type: "str", required: true },
          { name: "active", type: "bool" },
        ],
      },
      {
        module: "analytics",
        name: "User",
        fields: [{ name: "name", type: "str", required: true }],
      },
    ]);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::User { name := 'Ari', active := true }; ");
    executeQuery(runtime.db, schema, "insert default::User { name := 'Noah', active := false }; ");
    executeQuery(runtime.db, schema, "insert analytics::User { name := 'Analyst' }; ");

    const subqueryAlias = executeQuery(
      runtime.db,
      schema,
      "with active_users := (select default::User filter .active = true) select active_users { name } order by name asc;",
    );
    expect(subqueryAlias.kind).toBe("select");
    expect(subqueryAlias.rows).toEqual([{ name: "Ari" }]);

    const parameterized = executeQuery(
      runtime.db,
      schema,
      "with user_name := <str>$user_name select default::User { name } filter .name = user_name;",
      { globals: { user_name: "Noah" } },
    );
    expect(parameterized.kind).toBe("select");
    expect(parameterized.rows).toEqual([{ name: "Noah" }]);

    const moduleAlias = executeQuery(runtime.db, schema, "with d as module default select d::User { name } order by name asc;");
    expect(moduleAlias.kind).toBe("select");
    expect(moduleAlias.rows).toEqual([{ name: "Ari" }, { name: "Noah" }]);

    const moduleSelection = executeQuery(runtime.db, schema, "with module analytics select User { name }; ");
    expect(moduleSelection.kind).toBe("select");
    expect(moduleSelection.rows).toEqual([{ name: "Analyst" }]);

    const temporalCast = executeQuery(
      runtime.db,
      schema,
      "with when := <datetime>$when select { year := std::datetime_get(when, 'year') };",
      { globals: { when: "2024-02-03T04:05:06Z" } },
    );
    expect(temporalCast.kind).toBe("select");
    expect(temporalCast.rows).toEqual([{ year: 2024 }]);

    const localDateCast = executeQuery(
      runtime.db,
      schema,
      "with d := <local_date>$d select { day := cal::date_get(d, 'day') };",
      { globals: { d: "2024-02-03" } },
    );
    expect(localDateCast.kind).toBe("select");
    expect(localDateCast.rows).toEqual([{ day: 3 }]);

    expect(() =>
      executeQuery(
        runtime!.db,
        schema,
        "with d := <local_date>$d select { day := cal::date_get(d, 'day') };",
        { globals: { d: "2024-02-31" } },
      )).toThrow(/Cannot cast \$d to local_date/);
  });
});
