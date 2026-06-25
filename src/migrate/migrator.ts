// Core migration engine for the CLI — the glue that turns the existing schema
// diff/apply primitives into Drizzle/Prisma-style verbs.
//
// Two independent flows share these helpers:
//   * push   — stateless: diff the schema files against the schema recorded in
//              the live DB (gel_instdata key `schema_sdl`) and apply directly.
//   * generate + migrate — versioned: `generate` writes migration files off a
//              snapshot baseline; `migrate` applies pending files by re-deriving
//              each plan from consecutive snapshots (checksum-verified).
//
// Either flow, after touching the physical schema, MUST refresh the persisted
// snapshot (gel_* tables + gel_instdata + schema__* introspection) because the
// engine loads its schema from there at query time — raw DDL alone leaves it
// stale. See src/client/index.ts (deserializeSchemaFromInstdata ?? ...GelTables).

import type { DeclarativeSchema } from "../schema/declarative.js";
import { loadSchema } from "../schema/load.js";
import {
  applyMigrationPlanWithOptions,
  calculateMigrationChecksum,
  planSchemaMigration,
  renderMigrationSQL,
  renderSchemaSQL,
  type MigrationPlan,
} from "../schema/migrations.js";
import { parseDeclarativeSchema } from "../schema/sdl_adapter.js";
import {
  ensureGelSchemaTables,
  hasGelSchemaTables,
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
} from "../schema/gel_persistence.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { materializeSchema } from "../runtime/schema_materialize.js";
import type { SQLiteDatabase } from "../runtime/database.js";
import {
  nextSeq,
  readJournal,
  readSnapshotSource,
  writeMigration,
} from "./migration_files.js";

/** gel_instdata key holding the SDL source of the last-applied schema. */
const SDL_KEY = "schema_sdl";

const GLOBAL_IDS_DDL =
  `CREATE TABLE IF NOT EXISTS "__gel_global_ids" ("id" TEXT PRIMARY KEY, "type_name" TEXT NOT NULL)`;
const MIGRATION_HISTORY_DDL =
  `CREATE TABLE IF NOT EXISTS "__gel_migration_history" ("migration_id" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "applied_at" TEXT NOT NULL)`;

const EMPTY_SCHEMA: DeclarativeSchema = { modules: [], types: [] };

const parseSdl = (source: string): DeclarativeSchema =>
  source.trim() === "" ? EMPTY_SCHEMA : parseDeclarativeSchema(source, { legacySyntaxCompat: true });

const snapshotOf = (source: string): SchemaSnapshot => loadSchema(source, { legacySyntaxCompat: true });

// `planSchemaMigration` always re-emits idempotent `CREATE TABLE IF NOT EXISTS`
// steps, so a non-empty plan does NOT mean the schema changed. The reliable
// signal is whether the full-schema DDL differs — that captures new types, new
// columns, and drops while ignoring the idempotent re-creates.
const schemaChanged = (fromSource: string, toSource: string): boolean =>
  renderSchemaSQL(parseSdl(fromSource)) !== renderSchemaSQL(parseSdl(toSource));

// ---------------------------------------------------------------------------
// Persisted-state helpers
// ---------------------------------------------------------------------------

/** The SDL source of the schema currently applied to `db`, or null if none. */
export const loadAppliedSource = (db: SQLiteDatabase): string | null => {
  if (!hasGelSchemaTables(db)) return null;
  const row = db.prepare(`SELECT data FROM gel_instdata WHERE key = ?`).all(SDL_KEY)[0] as
    | { data?: string }
    | undefined;
  return row?.data ?? null;
};

const storeAppliedSource = (db: SQLiteDatabase, source: string): void => {
  ensureGelSchemaTables(db);
  const existing = db.prepare(`SELECT data FROM gel_instdata WHERE key = ?`).all(SDL_KEY)[0] as
    | { data?: string }
    | undefined;
  if (existing) {
    db.prepare(`UPDATE gel_instdata SET data = ? WHERE key = ?`).run(source, SDL_KEY);
  } else {
    db.prepare(`INSERT INTO gel_instdata (key, data) VALUES (?, ?)`).run(SDL_KEY, source);
  }
};

/**
 * Re-write every persisted representation the engine reads its schema from.
 * `materializeSchema` is idempotent (CREATE ... IF NOT EXISTS) and additionally
 * builds the schema__* introspection scaffolding before populating it, so it is
 * the single safe call that covers physical tables + introspection; the gel_*
 * meta tables + instdata blob are layered on top.
 */
const refreshPersistedSchema = (db: SQLiteDatabase, snapshot: SchemaSnapshot): void => {
  materializeSchema(db, snapshot);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);
};

/** A DB is "initialized" once it carries a recorded schema baseline we can diff. */
export const isInitialized = (db: SQLiteDatabase): boolean =>
  hasGelSchemaTables(db) && loadAppliedSource(db) !== null;

// ---------------------------------------------------------------------------
// Diff / status
// ---------------------------------------------------------------------------

export interface DiffResult {
  currentSource: string;
  plan: MigrationPlan;
  hasChanges: boolean;
  sql: string;
}

export const diffAgainstApplied = (db: SQLiteDatabase, targetSource: string): DiffResult => {
  const currentSource = loadAppliedSource(db) ?? "";
  const plan = planSchemaMigration(parseSdl(currentSource), parseSdl(targetSource));
  return {
    currentSource,
    plan,
    hasChanges: schemaChanged(currentSource, targetSource),
    sql: renderMigrationSQL(plan),
  };
};

/** Read-only: what would `push` do? (No writes.) */
export const status = (db: SQLiteDatabase, targetSource: string): DiffResult =>
  diffAgainstApplied(db, targetSource);

// ---------------------------------------------------------------------------
// push (stateless)
// ---------------------------------------------------------------------------

export type PushStatus = "created" | "applied" | "in-sync";

export interface PushResult {
  status: PushStatus;
  stepCount: number;
  sql: string;
}

export const push = (db: SQLiteDatabase, targetSource: string): PushResult => {
  if (!isInitialized(db)) {
    // First run (or adopting an externally-created DB): build from scratch.
    // refreshPersistedSchema is CREATE ... IF NOT EXISTS throughout, so running
    // it over an existing physical schema is safe.
    refreshPersistedSchema(db, snapshotOf(targetSource));
    storeAppliedSource(db, targetSource);
    return { status: "created", stepCount: 0, sql: "" };
  }

  const { plan, hasChanges, sql } = diffAgainstApplied(db, targetSource);
  if (!hasChanges) return { status: "in-sync", stepCount: 0, sql: "" };

  applyMigrationPlanWithOptions(db, plan, {});
  refreshPersistedSchema(db, snapshotOf(targetSource));
  storeAppliedSource(db, targetSource);
  return { status: "applied", stepCount: plan.steps.length, sql };
};

// ---------------------------------------------------------------------------
// generate (versioned, file-producing, no DB writes)
// ---------------------------------------------------------------------------

export type GenerateStatus = "generated" | "no-changes";

export interface GenerateResult {
  status: GenerateStatus;
  id?: string;
  sqlFile?: string;
  stepCount: number;
  sql: string;
}

export const generate = (
  migrationsDir: string,
  targetSource: string,
  name = "migration",
): GenerateResult => {
  const journal = readJournal(migrationsDir);
  const last = journal.entries[journal.entries.length - 1];
  const baselineSource = last ? readSnapshotSource(migrationsDir, last.idx) : "";
  if (!schemaChanged(baselineSource, targetSource)) return { status: "no-changes", stepCount: 0, sql: "" };
  const plan = planSchemaMigration(parseSdl(baselineSource), parseSdl(targetSource));

  const idx = nextSeq(journal);
  const checksum = calculateMigrationChecksum(plan);
  const sql = renderMigrationSQL(plan);
  const { id, sqlFile } = writeMigration(migrationsDir, {
    idx,
    name,
    checksum,
    sql,
    snapshotSource: targetSource,
  });
  return { status: "generated", id, sqlFile, stepCount: plan.steps.length, sql };
};

// ---------------------------------------------------------------------------
// migrate (apply pending migration files)
// ---------------------------------------------------------------------------

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

const ensureSystemTables = (db: SQLiteDatabase): void => {
  db.prepare(GLOBAL_IDS_DDL).run();
  ensureGelSchemaTables(db);
  db.prepare(MIGRATION_HISTORY_DDL).run();
};

const appliedMigrationIds = (db: SQLiteDatabase): Set<string> => {
  const rows = db.prepare(`SELECT migration_id FROM "__gel_migration_history"`).all() as Array<{
    migration_id: string;
  }>;
  return new Set(rows.map((r) => r.migration_id));
};

export const migrate = (db: SQLiteDatabase, migrationsDir: string): MigrateResult => {
  ensureSystemTables(db);
  const journal = readJournal(migrationsDir);
  const applied = appliedMigrationIds(db);

  const newlyApplied: string[] = [];
  let alreadyApplied = 0;
  let prevSource = "";
  let lastSource = loadAppliedSource(db) ?? "";

  for (const entry of journal.entries) {
    const thisSource = readSnapshotSource(migrationsDir, entry.idx);
    if (applied.has(entry.id)) {
      alreadyApplied++;
      prevSource = thisSource;
      lastSource = thisSource;
      continue;
    }
    // Re-derive the plan from consecutive snapshots; expectChecksum pins it to
    // exactly what `generate` recorded.
    const plan = planSchemaMigration(parseSdl(prevSource), parseSdl(thisSource));
    applyMigrationPlanWithOptions(db, plan, { migrationId: entry.id, expectChecksum: entry.checksum });
    newlyApplied.push(entry.id);
    prevSource = thisSource;
    lastSource = thisSource;
  }

  if (newlyApplied.length > 0) {
    refreshPersistedSchema(db, snapshotOf(lastSource));
    storeAppliedSource(db, lastSource);
  }
  return { applied: newlyApplied, alreadyApplied };
};
