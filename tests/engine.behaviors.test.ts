import { afterEach, describe, expect, it, assert } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { gelSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

describe("executeQuery runtime behaviors", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("implements trigger actions for insert/update/delete events", () => {
    const declarative = gelSchema`
      module default {
        type Log {
          required action: str;
          target_name: str;
          change: str;
        }
        type User {
          required name: str;
          trigger log_insert after insert for each do (
            insert Log { action := 'insert', target_name := __new__.name }
          );
          trigger log_update after update for each when (__old__.name != __new__.name) do (
            insert Log { action := 'update', target_name := __new__.name, change := __old__.name }
          );
          trigger log_delete after delete for each do (
            insert Log { action := 'delete', target_name := __old__.name }
          );
        }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::User { name := 'Alice' };");
    executeQuery(runtime.db, schema, "update default::User filter name = 'Alice' set { name := 'Alicia' };");
    executeQuery(runtime.db, schema, "delete default::User filter name = 'Alicia';");

    const logs = executeQuery(runtime.db, schema, "select default::Log { action, target_name, change } order by action asc;");
    expect(logs.kind).toBe("select");
    expect(logs.rows).toEqual([
      { action: "delete", target_name: "Alicia", change: null },
      { action: "insert", target_name: "Alice", change: null },
      { action: "update", target_name: "Alicia", change: "Alice" },
    ]);
  });

  it("implements mutation rewrites backed by SQLite triggers", () => {
    const declarative = gelSchema`
      module default {
        type Post {
          required title: str;
          modified: datetime {
            rewrite insert, update using (datetime_of_statement());
          };
        }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::Post { title := 'Draft' };");
    const first = executeQuery(runtime.db, schema, "select default::Post { id, title, modified };");
    expect(first.kind).toBe("select");
    expect(typeof first.rows?.[0]?.modified).toBe("string");

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

    executeQuery(runtime.db, schema, "update default::Post filter title = 'Draft' set { title := 'Final' };");
    const second = executeQuery(runtime.db, schema, "select default::Post { title, modified } filter title = 'Final';");
    expect(second.kind).toBe("select");
    assert.notEqual(second.rows?.[0]?.modified as string, first.rows?.[0]?.modified as string);
    expect(typeof second.rows?.[0]?.modified).toBe("string");
  });

  it("enforces access policies and permissions for select/write operations", () => {
    const declarative = gelSchema`
      module default {
        type BlogPost {
          required title: str;
          required author_id: uuid;
          access policy author_can_select
            allow select
            using (.author_id = global current_user);
          access policy author_can_write
            allow insert, update read, update write, delete
            using (global sys::perm::data_modification and .author_id = global current_user);
          access policy locked_posts_cannot_delete
            deny delete
            using (.title = 'LOCKED');
        }
        type Secret {
          required payload: str;
          access policy only_can_read_secret_permission
            allow select
            using (global default::can_read_secret);
        }
      }
    `;
    const schema = schemaSnapshotFromDeclarative(declarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::BlogPost { title := 'Mine', author_id := 'u1' };");
    executeQuery(runtime.db, schema, "insert default::BlogPost { title := 'Other', author_id := 'u2' };");
    executeQuery(runtime.db, schema, "insert default::BlogPost { title := 'LOCKED', author_id := 'u1' };");
    executeQuery(runtime.db, schema, "insert default::Secret { payload := 'x' };");

    const userContext = {
      isSuperuser: false,
      permissions: ["sys::perm::data_modification"],
      globals: { current_user: "u1" as const },
    };

    const visible = executeQuery(runtime.db, schema, "select default::BlogPost { title, author_id } order by title asc;", userContext);
    expect(visible.kind).toBe("select");
    expect(visible.rows).toEqual([
      { title: "LOCKED", author_id: "u1" },
      { title: "Mine", author_id: "u1" },
    ]);

    expect(() =>
      executeQuery(
        runtime!.db,
        schema,
        "update default::BlogPost filter title = 'Other' set { title := 'ShouldFail' };",
        userContext,
      ),
    ).toThrow(/Access policy violation/);

    expect(() => executeQuery(runtime!.db, schema, "delete default::BlogPost filter title = 'LOCKED';", userContext)).toThrow();

    expect(() =>
      executeQuery(
        runtime!.db,
        schema,
        "insert default::BlogPost { title := 'NoPerm', author_id := 'u1' };",
        { isSuperuser: false, permissions: [], globals: { current_user: "u1" } },
      ),
    ).toThrow(/data_modification/);

    const noSecretPerm = executeQuery(
      runtime.db,
      schema,
      "select default::Secret { payload };",
      { isSuperuser: false, permissions: ["sys::perm::data_modification"], globals: {} },
    );
    expect(noSecretPerm.rows).toEqual([]);

    const withSecretPerm = executeQuery(
      runtime.db,
      schema,
      "select default::Secret { payload };",
      {
        isSuperuser: false,
        permissions: ["sys::perm::data_modification", "default::can_read_secret"],
        globals: {},
      },
    );
    expect(withSecretPerm.rows).toEqual([{ payload: "x" }]);
  });
});
