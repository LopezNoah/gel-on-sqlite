import { afterEach, describe, expect, it } from "vitest";

import { openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { MigrationSession } from "../src/schema/migration_session.js";

const INITIAL_SCHEMA = `module default {}`;

const EVOLVED_SCHEMA = `module default {
  type User {
    required name: str;
    email: str;
  }

  type Project {
    required name: str;
    required owner -> User;
  }
}`;

describe("migration session parity", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-PARITY-MIGRATIONS.S1][SPEC-PARITY-MIGRATIONS.S3][SPEC-PARITY-MIGRATIONS.S6][SPEC-PARITY-MIGRATIONS.S12][SPEC-PARITY-MIGRATIONS.S13][SPEC-PARITY-MIGRATIONS.S14] supports start/populate/describe/commit flow", () => {
    runtime = openSQLite(":memory:");
    const session = new MigrationSession(runtime.db, { initialSchemaSource: INITIAL_SCHEMA });

    const started = session.startMigration({
      migrationId: "0001_initial_upgrade",
      targetSchemaSource: EVOLVED_SCHEMA,
    });
    expect(started.steps.length).toBeGreaterThan(0);

    const populated = session.populateMigration();
    expect(populated.steps.length).toBe(started.steps.length);

    const ddl = session.describeCurrentMigration("ddl");
    expect(typeof ddl).toBe("string");
    expect(String(ddl)).toContain("create object table for default::Project");

    const committed = session.commitMigration({ migrationId: "0001_initial_upgrade" });
    expect(committed.migrationId).toBe("0001_initial_upgrade");
    expect(committed.stepCount).toBeGreaterThan(0);

    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("default__project");
  });

  it("[SPEC-PARITY-MIGRATIONS.S7][SPEC-PARITY-MIGRATIONS.S8][SPEC-PARITY-MIGRATIONS.S9][SPEC-PARITY-MIGRATIONS.S10][SPEC-PARITY-MIGRATIONS.S11] handles migration parameters, description, create and abort", () => {
    runtime = openSQLite(":memory:");
    const session = new MigrationSession(runtime.db, { initialSchemaSource: INITIAL_SCHEMA });
    session.startMigration({ targetSchemaSource: EVOLVED_SCHEMA });

    session.setDescription("Bootstrap schema with Project");
    expect(session.getState().activeMigrationDescription).toBe("Bootstrap schema with Project");

    const created = session.createMigration("0001_bootstrap");
    expect(created.migrationId).toBe("0001_bootstrap");
    expect(created.sql).toContain("default::Project");

    session.abortMigration();
    expect(session.getState().hasActiveMigration).toBe(false);
  });

  it("[SPEC-PARITY-MIGRATIONS.S15] resets schema to initial", () => {
    runtime = openSQLite(":memory:");
    const session = new MigrationSession(runtime.db, { initialSchemaSource: INITIAL_SCHEMA });

    session.applyAutomaticMigration({
      migrationId: "0001_initial_upgrade",
      targetSchemaSource: EVOLVED_SCHEMA,
    });

    const reset = session.resetSchemaToInitial("0002_reset");
    expect(reset.migrationId).toBe("0002_reset");
    expect(session.getState().currentSchemaSource).toBe(INITIAL_SCHEMA);

    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("default__project");
  });

  it("[SPEC-PARITY-MIGRATIONS.S16][SPEC-PARITY-MIGRATIONS.S17][SPEC-PARITY-MIGRATIONS.S18][SPEC-PARITY-MIGRATIONS.S19][SPEC-PARITY-MIGRATIONS.S20][SPEC-PARITY-MIGRATIONS.S21][SPEC-PARITY-MIGRATIONS.S22] supports rewrite/savepoint/rollback flow", () => {
    runtime = openSQLite(":memory:");
    const session = new MigrationSession(runtime.db, { initialSchemaSource: INITIAL_SCHEMA });
    session.startMigration({ targetSchemaSource: EVOLVED_SCHEMA, migrationId: "0001_rewrite" });

    session.startMigrationRewrite();
    session.declareSavepoint("base");
    session.applyMigrationRewriteDDL({
      description: "custom post-step",
      sql: "CREATE TABLE IF NOT EXISTS \"custom_table\" (\"id\" TEXT PRIMARY KEY)",
    });
    session.declareSavepoint("after_custom");
    session.rollbackToSavepoint("base");
    session.releaseSavepoint("base");
    session.rollback();

    session.startMigrationRewrite();
    session.applyMigrationRewriteDDL({
      description: "custom post-step",
      sql: "CREATE TABLE IF NOT EXISTS \"custom_table\" (\"id\" TEXT PRIMARY KEY)",
    });
    session.commitMigrationRewrite();
    session.commitMigration({ migrationId: "0001_rewrite" });

    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("custom_table");
  });

  it("[SPEC-PARITY-MIGRATIONS.S2][SPEC-PARITY-MIGRATIONS.S4][SPEC-PARITY-MIGRATIONS.S5] executes migration command-line style commands", () => {
    runtime = openSQLite(":memory:");
    const session = new MigrationSession(runtime.db, { initialSchemaSource: INITIAL_SCHEMA });

    session.executeMigrationCommand(`START MIGRATION TO '${EVOLVED_SCHEMA}';`);
    session.executeMigrationCommand("SET MIGRATION DESCRIPTION 'cli flow';");
    const ddl = session.executeMigrationCommand("DESCRIBE CURRENT MIGRATION AS DDL;");
    expect(String(ddl)).toContain("default::Project");
    session.executeMigrationCommand("COMMIT MIGRATION;");

    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("default__project");
  });
});
