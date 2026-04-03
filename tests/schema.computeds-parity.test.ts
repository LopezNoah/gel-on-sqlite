import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { gelSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative, typeDefsFromDeclarative } from "../src/schema/uiSchema.js";

describe("datamodel parity: computeds", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-PARITY-DATAMODEL-COMPUTEDS.S1][SPEC-PARITY-DATAMODEL-COMPUTEDS.S2] supports leading-dot/__source__ refs and infers non-required computeds", () => {
    const schema = gelSchema`
      module default {
        type Person {
          first_name: str;
          first_a := .first_name;
          first_b := __source__.first_name;
        }
      }
    `;

    const person = typeDefsFromDeclarative(schema).find((typeDef) => typeDef.name === "Person");
    expect(person?.computeds).toEqual([
      {
        kind: "property",
        name: "first_a",
        required: false,
        multi: false,
        annotations: undefined,
        expr: { kind: "field_ref", field: "first_name" },
      },
      {
        kind: "property",
        name: "first_b",
        required: false,
        multi: false,
        annotations: undefined,
        expr: { kind: "field_ref", field: "first_name" },
      },
    ]);

    expect(() =>
      gelSchema`
        module default {
          type InvalidPerson {
            first_name: str;
            required first_upper := .first_name;
          }
        }
      `,
    ).toThrow(/cannot be declared required/);
  });

  it("[SPEC-PARITY-DATAMODEL-COMPUTEDS.S3] evaluates common computed-property use cases", () => {
    const declarative = gelSchema`
      module default {
        type Person {
          first_name: str;
          last_name: str;
          full_name := .first_name ++ ' ' ++ .last_name;
        }
      }
    `;

    const schema = schemaSnapshotFromDeclarative(declarative);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Person { first_name := 'Ada', last_name := 'Lovelace' }; ");
    const result = executeQuery(runtime.db, schema, "select default::Person { full_name };");
    expect(result.rows).toEqual([{ full_name: "Ada Lovelace" }]);
  });

  it("[SPEC-PARITY-DATAMODEL-COMPUTEDS.S4] supports computed links with embedded filtering", () => {
    const declarative = gelSchema`
      module default {
        type Person {
          name: str;
          is_active: bool;
        }

        type Club {
          name: str;
          multi members -> Person;
          multi active_members := (select .members filter .is_active = true);
        }
      }
    `;

    const schema = schemaSnapshotFromDeclarative(declarative);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Person { name := 'Ari', is_active := true }; ");
    executeQuery(runtime.db, schema, "insert default::Person { name := 'Bea', is_active := false }; ");
    const people = executeQuery(runtime.db, schema, "select default::Person { id, name } order by name asc;").rows ?? [];
    const ariId = people[0]?.id;
    const beaId = people[1]?.id;
    if (typeof ariId !== "string" || typeof beaId !== "string") {
      throw new Error("expected seeded person ids");
    }

    executeQuery(runtime.db, schema, `insert default::Club { name := 'Chess', members := { '${ariId}', '${beaId}' } };`);
    const clubs = executeQuery(runtime.db, schema, "select default::Club { active_members };").rows ?? [];
    const active = Array.isArray(clubs[0]?.active_members) ? clubs[0]?.active_members : [];
    expect(active).toHaveLength(1);
  });

  it("[SPEC-PARITY-DATAMODEL-COMPUTEDS.S5] supports backlink computeds", () => {
    const declarative = gelSchema`
      module default {
        type BlogPost {
          title: str;
          author -> User;
        }

        type User {
          name: str;
          multi blog_posts := .<author[is BlogPost];
        }
      }
    `;

    const schema = schemaSnapshotFromDeclarative(declarative);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::User { name := 'Noah' }; ");
    const userId = (executeQuery(runtime.db, schema, "select default::User { id };").rows ?? [])[0]?.id;
    if (typeof userId !== "string") {
      throw new Error("expected user id");
    }

    executeQuery(runtime.db, schema, `insert default::BlogPost { title := 'Hello', author_id := '${userId}' };`);
    const users = executeQuery(runtime.db, schema, "select default::User { blog_posts };").rows ?? [];
    expect(Array.isArray(users[0]?.blog_posts) ? users[0]?.blog_posts.length : 0).toBe(1);
  });
});
