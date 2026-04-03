import { afterEach, describe, expect, it } from "vitest";

import { openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { gelSchema } from "../src/schema/declarative.js";
import {
  applyMigrationPlan,
  applyMigrationPlanWithOptions,
  calculateMigrationChecksum,
  planSchemaMigration,
  renderMigrationSQL,
  renderSchemaSQL,
} from "../src/schema/migrations.js";

describe("schema migrations", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-012.R1][SPEC-012.R2] plans and applies schema creation SQL", () => {
    const schema = gelSchema`
      module default {
        abstract type Content {
          required title: str;
          multi tags: str;
        }

        type User {
          required name: str;
          multi authored -> Content {
            role: str;
            created_at: datetime;
          };
        }

        type Post extending Content {
          required author -> User;
          body: str;
        }
      }
    `;

    const plan = planSchemaMigration({ modules: [], types: [] }, schema);
    const sql = renderMigrationSQL(plan);

    console.log("\n[schema_migrations/create] declarative schema:");
    console.log(JSON.stringify(schema, null, 2));
    console.log("[schema_migrations/create] migration plan:");
    console.log(JSON.stringify(plan, null, 2));
    console.log("[schema_migrations/create] rendered SQL:\n" + sql);

    expect(sql).toContain("create object table for default::User");
    expect(sql).toContain("create object table for default::Post");
    expect(sql).toContain("create link table for default::User.authored");
    expect(sql).not.toContain("default::Content");

    runtime = openSQLite(":memory:");
    applyMigrationPlan(runtime.db, plan);

    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    console.log("[schema_migrations/create] sqlite tables:");
    console.log(JSON.stringify(tables, null, 2));

    expect(tables.map((t) => t.name)).toEqual([
      "__gel_global_ids",
      "__gel_migration_history",
      "default__post",
      "default__user",
      "default__user__authored",
    ]);
  });

  it("[SPEC-011.R3][SPEC-012.R3] renders deterministic migration when schema evolves", () => {
    const v1 = gelSchema`
      module default {
        type User {
          required name: str;
        }
      }
    `;

    const v2 = gelSchema`
      module default {
        type User {
          required name: str;
          email: str;
          multi tags: str;
        }

        type AuditLog {
          required actor -> User;
          required action: str;
        }
      }
    `;

    const plan = planSchemaMigration(v1, v2);
    const sql = renderMigrationSQL(plan);

    console.log("\n[schema_migrations/diff] from schema (v1):");
    console.log(JSON.stringify(v1, null, 2));
    console.log("[schema_migrations/diff] to schema (v2):");
    console.log(JSON.stringify(v2, null, 2));
    console.log("[schema_migrations/diff] migration plan:");
    console.log(JSON.stringify(plan, null, 2));
    console.log("[schema_migrations/diff] rendered SQL:\n" + sql);

    expect(sql).toContain("add property default::User.email");
    expect(sql).toContain("create multi property table default::User.tags");
    expect(sql).toContain("create object table for default::AuditLog");

    const fullSchemaSQL = renderSchemaSQL(v2);
    console.log("[schema_migrations/diff] full schema SQL from v2:\n" + fullSchemaSQL);
    expect(fullSchemaSQL).toContain("default__auditlog");
  });

  it("persists migration history and validates checksums", () => {
    const schema = gelSchema`
      module default {
        type User {
          required name: str;
        }
      }
    `;

    const plan = planSchemaMigration({ modules: [], types: [] }, schema);
    const checksum = calculateMigrationChecksum(plan);

    runtime = openSQLite(":memory:");
    applyMigrationPlanWithOptions(runtime.db, plan, {
      migrationId: "0001_init",
      expectChecksum: checksum,
    });

    const history = runtime.db
      .prepare('SELECT "migration_id", "checksum" FROM "__gel_migration_history" ORDER BY "migration_id"')
      .all() as Array<{ migration_id: string; checksum: string }>;
    expect(history).toEqual([{ migration_id: "0001_init", checksum }]);

    applyMigrationPlanWithOptions(runtime.db, plan, {
      migrationId: "0001_init",
      expectChecksum: checksum,
    });

    const historyAfterNoop = runtime.db
      .prepare('SELECT "migration_id", "checksum" FROM "__gel_migration_history" ORDER BY "migration_id"')
      .all() as Array<{ migration_id: string; checksum: string }>;
    expect(historyAfterNoop).toEqual([{ migration_id: "0001_init", checksum }]);

    expect(() =>
      applyMigrationPlanWithOptions(runtime!.db, plan, {
        migrationId: "0001_init",
        expectChecksum: "bad-checksum",
      }),
    ).toThrow(/Migration checksum mismatch/);
  });

  it("adds regression coverage for create/alter/drop object types and pointer changes", () => {
    const v1 = gelSchema`
      module default {
        type User {
          required name: str;
          email: str;
          manager -> User;
          multi tags: str;
        }

        type Project {
          required name: str;
          required owner -> User;
        }
      }
    `;

    const v2 = gelSchema`
      module default {
        type User {
          required name: str;
          required email -> User;
          multi manager -> User;
          tags: str;
          required phone: str;
        }

        type AuditLog {
          required actor -> User;
          required action: str;
        }
      }
    `;

    const plan = planSchemaMigration(v1, v2);
    const sql = renderMigrationSQL(plan);
    expect(sql).toContain("create object table for default::AuditLog");
    expect(sql).toContain("drop object table for default::Project");
    expect(sql).toContain("drop property default::User.email");
    expect(sql).toContain("add link column default::User.email");
    expect(sql).toContain("drop link column default::User.manager");
    expect(sql).toContain("create link table default::User.manager");
    expect(sql).toContain("drop multi property table default::User.tags");
    expect(sql).toContain("add property default::User.tags");

    runtime = openSQLite(":memory:");
    applyMigrationPlan(runtime.db, planSchemaMigration({ modules: [], types: [] }, v1));
    applyMigrationPlanWithOptions(runtime.db, plan, { migrationId: "0002_pointer_rewrite" });

    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("default__auditlog");
    expect(tables.map((t) => t.name)).not.toContain("default__project");
    expect(tables.map((t) => t.name)).toContain("default__user__manager");
    expect(tables.map((t) => t.name)).not.toContain("default__user__tags");
  });

  it("renders SQL for mutation rewrite and custom trigger declarations", () => {
    const schema = gelSchema`
      module default {
        type Log {
          required action: str;
          target_name: str;
        }

        type User {
          required name: str;
          modified: datetime {
            rewrite insert, update using (datetime_of_statement());
          };

          trigger log_update after update for each
          when (__old__.name != __new__.name)
          do (insert Log {
            action := 'update',
            target_name := __new__.name
          });
        }
      }
    `;

    const plan = planSchemaMigration({ modules: [], types: [] }, schema);
    const sql = renderMigrationSQL(plan);
    expect(sql).toContain("rewrite_insert_modified");
    expect(sql).toContain("rewrite_update_modified");
    expect(sql).toContain("custom_log_update");
  });
});
