import { afterEach, describe, expect, it } from "vitest";

import { getCompilerService } from "../src/compiler/service.js";
import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery, executeQueryUnitWithTrace, executeQueryWithTrace } from "../src/runtime/engine.js";
import { SchemaSnapshot } from "../src/schema/schema.js";
import { gelSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

describe("executeQuery basics", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-040.R1] inserts, updates, deletes, and selects rows", () => {
    const declarative = gelSchema`
      module default {
        type User {
          required name: str;
          active: bool;
        }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const insertResult = executeQuery(runtime.db, schema, "insert default::User { name := 'Noah', active := true };");
    expect(insertResult.kind).toBe("insert");
    expect(insertResult.changes).toBe(1);

    executeQuery(runtime.db, schema, "insert default::User { name := 'Ari', active := false };");
    executeQuery(runtime.db, schema, "insert default::User { name := 'Kai', active := false };");

    const updateResult = executeQuery(runtime.db, schema, "update default::User filter name = 'Ari' set { name := 'Aria' };");
    expect(updateResult.kind).toBe("update");
    expect(updateResult.changes).toBe(1);

    const deleteResult = executeQuery(runtime.db, schema, "delete default::User filter name = 'Noah';");
    expect(deleteResult.kind).toBe("delete");
    expect(deleteResult.changes).toBe(1);

    const selectResult = executeQuery(
      runtime.db,
      schema,
      "select default::User { id, name } order by name desc offset 0 limit 1;",
    );
    expect(selectResult.kind).toBe("select");
    expect(selectResult.rows).toEqual([{ id: expect.any(String), name: "Kai" }]);

    const defaultShape = executeQuery(runtime.db, schema, "select default::User order by id asc limit 1;");
    expect(defaultShape.kind).toBe("select");
    expect(defaultShape.rows).toEqual([{ id: expect.any(String) }]);

    const filterOps = executeQuery(runtime.db, schema, "select default::User { name } filter .name ilike '%ar%' order by name asc;");
    expect(filterOps.kind).toBe("select");
    expect(filterOps.rows).toEqual([{ name: "Aria" }]);

    const booleanFilter = executeQuery(
      runtime.db,
      schema,
      "select default::User { name } filter (.name like '%a%') and not (.name = 'Aria') or .name = 'Kai' order by name asc;",
    );
    expect(booleanFilter.kind).toBe("select");
    expect(booleanFilter.rows).toEqual([{ name: "Kai" }]);
  });

  it("[SPEC-034.R19] enforces globally unique generated ids across tables", () => {
    const declarative = gelSchema`
      module default {
        type User { required name: str; }
        type Project { required name: str; }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    runtime.db.prepare('INSERT INTO "default__user" ("id", "name") VALUES (?, ?)').run("shared-id", "Ari");
    expect(() => runtime!.db.prepare('INSERT INTO "default__project" ("id", "name") VALUES (?, ?)').run("shared-id", "Infra")).toThrow();
  });

  it("[SPEC-033.R1] applies overlay context across query unit statements", () => {
    const declarative = gelSchema`
      module default {
        type User { required name: str; }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const unit = executeQueryUnitWithTrace(
      runtime.db,
      schema,
      "insert default::User { name := 'Ari' }; select default::User { id, name } filter name = 'Ari';",
    );

    expect(unit.traces).toHaveLength(2);
    expect(unit.traces[0].overlays[0].operation).toBe("union");
    expect(unit.traces[1].overlays[0].operation).toBe("union");
    expect(unit.result.kind).toBe("select");
    expect(unit.result.rows).toEqual([{ id: expect.any(String), name: "Ari" }]);
  });

  it("rejects link ids that do not match existing target object type", () => {
    const declarative = gelSchema`
      module default {
        type User { required name: str; }
        type Project {
          required name: str;
          required owner -> User;
        }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);
    const db = runtime.db;

    executeQuery(db, schema, "insert default::User { name := 'Ari' };");
    const userId = (executeQuery(db, schema, "select default::User { id, name } filter name = 'Ari';").rows ?? [])[0]?.id;
    if (typeof userId !== "string") {
      throw new Error("expected seeded user id");
    }

    executeQuery(db, schema, `insert default::Project { name := 'Alpha', owner_id := '${userId}' };`);
    const projectId = (executeQuery(db, schema, "select default::Project { id, name } filter name = 'Alpha';").rows ?? [])[0]?.id;
    if (typeof projectId !== "string") {
      throw new Error("expected seeded project id");
    }

    expect(() =>
      executeQuery(db, schema, "insert default::Project { name := 'Broken', owner_id := 'missing-id' };"),
    ).toThrow(/does not reference an existing object/);

    expect(() =>
      executeQuery(db, schema, `insert default::Project { name := 'WrongType', owner_id := '${projectId}' };`),
    ).toThrow(/expected 'default__user', got 'default__project'/);
  });

  it("[SPEC-041.R1][SPEC-041.R2][SPEC-041.R3] caches compiled artifacts with deterministic keys", () => {
    getCompilerService().clear();
    const declarative = gelSchema`
      module default {
        type User { required name: str; }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const query = "select default::User { id, name } order by name asc;";
    const first = executeQueryWithTrace(runtime.db, schema, query);
    const second = executeQueryWithTrace(runtime.db, schema, query);

    expect(first.compiler.status).toBe("miss");
    expect(second.compiler.status).toBe("hit");
    expect(first.compiler.key).toBe(second.compiler.key);
    expect(second.compiler.stats.hits).toBeGreaterThanOrEqual(1);
    expect(second.compiler.stats.size).toBeGreaterThanOrEqual(1);
  });
});
