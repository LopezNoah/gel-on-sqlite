import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery, executeQueryWithTrace } from "../src/runtime/engine.js";
import { SchemaSnapshot } from "../src/schema/schema.js";
import { gelSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

describe("executeQuery select parity", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-034.R9][SPEC-034.R10] resolves computed fields and backlinks", () => {
    const declarative = gelSchema`
      module default {
        type User {
          required name: str;
          manager -> User;
        }
        type Comment {
          required body: str;
          required author -> User;
        }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::User { name := 'Noah' };");
    executeQuery(runtime.db, schema, "insert default::User { name := 'Ari' };");

    const userRows = executeQuery(runtime.db, schema, "select default::User { id, name } order by name asc;").rows as Array<{
      id: string;
      name: string;
    }>;
    const ariId = userRows.find((row) => row.name === "Ari")?.id;
    const noahId = userRows.find((row) => row.name === "Noah")?.id;
    if (!ariId || !noahId) {
      throw new Error("expected seeded users");
    }

    runtime.db.prepare('UPDATE "default__user" SET "manager_id" = ? WHERE "id" = ?').run(ariId, noahId);

    executeQuery(runtime.db, schema, `insert default::Comment { body := 'First', author_id := '${noahId}' };`);
    executeQuery(runtime.db, schema, `insert default::Comment { body := 'Second', author_id := '${noahId}' };`);
    executeQuery(runtime.db, schema, `insert default::Comment { body := 'Third', author_id := '${ariId}' };`);

    const result = executeQuery(
      runtime.db,
      schema,
      "select default::User { id, nick := .name, comments := .<author[is default::Comment] } order by name asc;",
    );

    expect(result.kind).toBe("select");
    expect(result.rows).toEqual([
      {
        id: expect.any(String),
        nick: "Ari",
        comments: [{ id: expect.any(String), __type__: "default::Comment" }],
      },
      {
        id: expect.any(String),
        nick: "Noah",
        comments: [
          { id: expect.any(String), __type__: "default::Comment" },
          { id: expect.any(String), __type__: "default::Comment" },
        ],
      },
    ]);

    const nested = executeQuery(
      runtime.db,
      schema,
      "select default::User { name, profile := .__type__, manager { name, manager_only := [is default::User].name } filter name = 'Ari' order by name asc limit 1 } order by name asc;",
    );
    expect(nested.kind).toBe("select");
    expect(nested.rows).toEqual([
      {
        name: "Ari",
        profile: { name: "default::User" },
        manager: [],
      },
      {
        name: "Noah",
        profile: { name: "default::User" },
        manager: [{ name: "Ari", manager_only: "Ari" }],
      },
    ]);

    const nestedTrace = executeQueryWithTrace(
      runtime.db,
      schema,
      "select default::User { id, comments := .<author[is default::Comment], manager { name } } order by name asc;",
    );
    expect(nestedTrace.sql.loweringMode).toBe("single_statement");
    expect(nestedTrace.sql.sql).toContain("json_group_array");
    expect(nestedTrace.sqlTrail).toHaveLength(1);
  });

  it("[SPEC-034.R6] expands splats in runtime shaping", () => {
    const declarative = gelSchema`
      module default {
        abstract type Person { required name: str; }
        type Hero extending Person {
          secret_identity: str;
          multi villains -> Villain;
        }
        type Villain extending Person {
          secret_identity: str;
        }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Villain { name := 'Electro', secret_identity := null };");
    executeQuery(
      runtime.db,
      schema,
      "insert default::Hero { name := 'Spider-Man', secret_identity := 'Peter Parker', villains := (select default::Villain filter .name = 'Electro') };",
    );

    const result = executeQuery(runtime.db, schema, "select default::Hero { ** };");
    expect(result.kind).toBe("select");
    expect(result.rows).toEqual([
      {
        id: expect.any(String),
        name: "Spider-Man",
        secret_identity: "Peter Parker",
        villains: [
          {
            id: expect.any(String),
            name: "Electro",
            secret_identity: null,
          },
        ],
      },
    ]);
  });

  it("[SPEC-034.S8] filters by known backlinks", () => {
    const declarative = gelSchema`
        module default {
          type User { required name: str; }
          type Comment {
            required body: str;
            required author -> User;
          }
        }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::User { name := 'Ari' };");
    executeQuery(runtime.db, schema, "insert default::User { name := 'Noah' };");
    const users = executeQuery(runtime.db, schema, "select default::User { id, name } order by name asc;").rows as Array<{
      id: string;
      name: string;
    }>;
    const ariId = users.find((u) => u.name === "Ari")?.id;
    const noahId = users.find((u) => u.name === "Noah")?.id;
    if (!ariId || !noahId) {
      throw new Error("expected users");
    }

    executeQuery(runtime.db, schema, `insert default::Comment { body := 'for ari', author_id := '${ariId}' };`);
    executeQuery(runtime.db, schema, `insert default::Comment { body := 'for noah', author_id := '${noahId}' };`);
    const comments = executeQuery(runtime.db, schema, "select default::Comment { id, body } order by body asc;").rows as Array<{
      id: string;
      body: string;
    }>;
    const ariCommentId = comments.find((c) => c.body === "for ari")?.id;
    if (!ariCommentId) {
      throw new Error("expected comment id");
    }

    const result = executeQuery(
      runtime.db,
      schema,
      `select default::User { name } filter .<author[is default::Comment] = '${ariCommentId}' order by name asc;`,
    );
    expect(result.kind).toBe("select");
    expect(result.rows).toEqual([{ name: "Ari" }]);

    const inverse = executeQuery(
      runtime.db,
      schema,
      `select default::User { name } filter .<author[is default::Comment] != '${ariCommentId}' order by name asc;`,
    );
    expect(inverse.kind).toBe("select");
    expect(inverse.rows).toEqual([{ name: "Noah" }]);
  });

  it("[SPEC-034.S20] returns singleton free objects with mixed expression values", () => {
    const declarative = gelSchema`
        module default {
          type Hero { required name: str; }
        }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Spider-Man' };");
    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Iron Man' };");

    const result = executeQuery(
      runtime.db,
      schema,
      "select { my_string := 'This is a string', my_number := 42, several_numbers := {1, 2, 3}, all_heroes := default::Hero { name } order by name asc };",
    );

    expect(result.kind).toBe("select");
    expect(result.rows).toEqual([
      {
        my_string: "This is a string",
        my_number: 42,
        several_numbers: [1, 2, 3],
        all_heroes: [{ name: "Iron Man" }, { name: "Spider-Man" }],
      },
    ]);
  });

  it("[SPEC-034.S16] materializes polymorphic link sets targeting abstract supertypes", () => {
    const declarative = gelSchema`
        module default {
          abstract type Person { required name: str; }
          type Hero extending Person { secret_identity: str; }
          type Villain extending Person { nemesis_note: str; }
          type Movie { required title: str; multi characters -> Person; }
        }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Iron Man', secret_identity := 'Tony Stark' };");
    executeQuery(runtime.db, schema, "insert default::Villain { name := 'Obadiah Stane', nemesis_note := 'Rival' };");
    executeQuery(
      runtime.db,
      schema,
      "insert default::Movie { title := 'Iron Man', characters := {(select default::Hero filter .name = 'Iron Man'), (select default::Villain filter .name = 'Obadiah Stane')} };",
    );

    const result = executeQuery(
      runtime.db,
      schema,
      "select default::Movie { title, characters { name, kind := .__type__ } } filter .title = 'Iron Man';",
    );

    expect(result.kind).toBe("select");
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]?.title).toBe("Iron Man");
    expect(result.rows?.[0]?.characters).toEqual(
      expect.arrayContaining([
        { name: "Iron Man", kind: { name: "default::Hero" } },
        { name: "Obadiah Stane", kind: { name: "default::Villain" } },
      ]),
    );
  });

  it("[SPEC-034.S18] filters polymorphic links by subtype", () => {
    const declarative = gelSchema`
        module default {
          abstract type Person { required name: str; }
          type Hero extending Person { secret_identity: str; }
          type Villain extending Person { nemesis_note: str; }
          type Movie { required title: str; multi characters -> Person; }
        }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Iron Man', secret_identity := 'Tony Stark' };");
    executeQuery(runtime.db, schema, "insert default::Villain { name := 'Obadiah Stane' };");
    executeQuery(
      runtime.db,
      schema,
      "insert default::Movie { title := 'Iron Man', characters := {(select default::Hero filter .name = 'Iron Man'), (select default::Villain filter .name = 'Obadiah Stane')} };",
    );

    const result = executeQuery(
      runtime.db,
      schema,
      "select default::Movie { title, characters[is default::Hero] { name, secret_identity } } filter .title = 'Iron Man';",
    );

    expect(result.kind).toBe("select");
    expect(result.rows).toEqual([
      {
        title: "Iron Man",
        characters: [{ name: "Iron Man", secret_identity: "Tony Stark" }],
      },
    ]);
  });

  it("[SPEC-034.S7] applies nested filters with correct scope", () => {
    const declarative = gelSchema`
        module default {
          type Hero {
            required name: str;
            multi villains -> Villain;
          }
          type Villain { required name: str; }
        }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Villain { name := 'Doc Ock' };");
    executeQuery(runtime.db, schema, "insert default::Villain { name := 'Green Goblin' };");
    executeQuery(runtime.db, schema, "insert default::Villain { name := 'Sandman' };");
    executeQuery(
      runtime.db,
      schema,
      "insert default::Hero { name := 'Spider-Man', villains := {(select default::Villain filter .name = 'Doc Ock'), (select default::Villain filter .name = 'Green Goblin')} };",
    );
    executeQuery(
      runtime.db,
      schema,
      "insert default::Hero { name := 'Iron Man', villains := (select default::Villain filter .name = 'Sandman') };",
    );

    const result = executeQuery(
      runtime.db,
      schema,
      "select default::Hero { name, villains { name } filter .name like '%O%' } filter .name ilike '%man' order by name asc;",
    );

    expect(result.kind).toBe("select");
    expect(result.rows).toHaveLength(2);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        { name: "Iron Man", villains: [] },
        {
          name: "Spider-Man",
          villains: expect.arrayContaining([{ name: "Doc Ock" }, { name: "Green Goblin" }]),
        },
      ]),
    );
  });

  it("[SPEC-034.S14] executes computed subqueries in shapes", () => {
    const declarative = gelSchema`
        module default {
          type Hero { required name: str; }
          type Villain { required name: str; }
        }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Iron Man' };");
    executeQuery(runtime.db, schema, "insert default::Hero { name := 'Spider-Man' };");
    executeQuery(runtime.db, schema, "insert default::Villain { name := 'Doc Ock' };");

    const result = executeQuery(
      runtime.db,
      schema,
      "select default::Villain { name, top_hero := (select default::Hero { name } order by name asc limit 1) } order by name asc;",
    );

    expect(result.kind).toBe("select");
    expect(result.rows).toEqual([
      {
        name: "Doc Ock",
        top_hero: [{ name: "Iron Man" }],
      },
    ]);
  });

  it("adds regression coverage for polymorphic selects across inherited object types", () => {
    const declarative = gelSchema`
       module default {
         type Content { required name: str; }
         type Post extending Content { body: str; }
       }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Content { name := 'Base' };");
    executeQuery(runtime.db, schema, "insert default::Post { name := 'Child', body := 'hello' };");

    const result = executeQuery(runtime.db, schema, "select default::Content { id, name, t := .__type__ } order by name asc;");
    expect(result.kind).toBe("select");
    expect(result.rows).toEqual([
      { id: expect.any(String), name: "Base", t: { name: "default::Content" } },
      { id: expect.any(String), name: "Child", t: { name: "default::Post" } },
    ]);
  });
});
