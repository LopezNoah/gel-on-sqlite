import fs from "node:fs";
import path from "node:path";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import {
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
  ensureGelSchemaTables,
  deserializeSchemaFromInstdata,
  deserializeSchemaFromGelTables,
} from "../src/schema/gel_persistence.js";
import { executeQuery, executeScript } from "../src/runtime/engine.js";
// import { parseDeclarativeSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import { expect } from "vitest";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";

export interface HarnessOptions {
  schema?: string;      // Name of .esdl file in tests/schemas/
  setup?: string;       // Name of .edgeql file in tests/schemas/
  dbFile?: string;      // Optional SQLite file path for inspection
  resetDbFile?: boolean;
  reuseExistingDb?: boolean;
  runSetupOnReuse?: boolean;
}

function inferredModuleNameFromSchema(schemaName: string): string {
  const idx = schemaName.lastIndexOf("_");
  if (idx < 0) {
    return "default";
  }
  return schemaName.slice(idx + 1).toLowerCase().split("_").join("::");
}

function stripHashComments(source: string): string {
  let output = "";
  let inComment = false;
  for (const ch of source) {
    if (inComment) {
      if (ch === "\n") {
        inComment = false;
        output += ch;
      }
      continue;
    }
    if (ch === "#") {
      inComment = true;
      continue;
    }
    output += ch;
  }
  return output;
}

function hasExplicitModuleDeclaration(source: string): boolean {
  const withoutComments = stripHashComments(source);
  return withoutComments.trimStart().startsWith("module ");
}

function wrapModule(moduleName: string, source: string): string {
  const cleanSource = stripHashComments(source);
  if (hasExplicitModuleDeclaration(cleanSource)) {
    return cleanSource;
  }
  return `module ${moduleName} {\n${cleanSource}\n}`;
}

function loadSchemaSource(schemaDir: string, schemaName: string): string {
  const parts: Array<{ fileName: string; moduleName: string }> = [];
  const primaryModule = inferredModuleNameFromSchema(schemaName);
  const idx = schemaName.lastIndexOf("_");

  if (idx > 0) {
    const baseName = schemaName.slice(0, idx);
    const defaultName = `${baseName}_default`;
    if (defaultName !== schemaName) {
      const defaultPath = path.join(schemaDir, `${defaultName}.esdl`);
      if (fs.existsSync(defaultPath)) {
        parts.push({ fileName: defaultName, moduleName: "default" });
      }
    }
  }

  parts.push({ fileName: schemaName, moduleName: primaryModule });

  return parts
    .map(({ fileName, moduleName }) => {
      const p = path.join(schemaDir, `${fileName}.esdl`);
      const src = fs.readFileSync(p, "utf-8");
      return wrapModule(moduleName, src);
    })
    .join("\n\n");
}

function defaultModuleForSchema(schemaDir: string, schemaName: string): string {
  const idx = schemaName.lastIndexOf("_");
  if (idx <= 0) {
    return inferredModuleNameFromSchema(schemaName);
  }

  const defaultPath = path.join(schemaDir, `${schemaName.slice(0, idx)}_default.esdl`);
  return fs.existsSync(defaultPath) ? "default" : inferredModuleNameFromSchema(schemaName);
}

interface CachedSnapshot {
  schema: ReturnType<typeof schemaSnapshotFromDeclarative>;
  buffer: Buffer;
  fallbackModule: string;
}

const snapshotCache = new Map<string, CachedSnapshot>();

function snapshotCacheKey(schema: string | undefined, setup: string | undefined): string {
  return `${schema ?? "<none>"}|${setup ?? "<none>"}`;
}

export class QueryHarness {
  db: any;
  schema: any;
  private readonly defaultModule: string;

  private constructor(db: any, schema: any, defaultModule = "default") {
    this.db = db;
    this.schema = schema;
    this.defaultModule = defaultModule;
  }

  /**
   * Factory method to create a fresh test database with schema/data.
   *
   * Fast path (no `dbFile` provided): the schema is parsed and the setup script
   * is run **once per (schema, setup) pair** per process. The fully-populated
   * in-memory DB is captured as a Buffer via better-sqlite3 `serialize()` and
   * subsequent calls open a fresh DB from that Buffer. This mirrors the
   * snapshot/restore pattern used by `experimental_interpreter.py` in the
   * Python testbase.
   *
   * Slow path (`dbFile` provided, or running on the node:sqlite fallback):
   * falls back to building everything from scratch — useful for debugging
   * since the resulting `.sqlite` file can be inspected directly.
   */
  static async create(options: HarnessOptions): Promise<QueryHarness> {
    if (!options.dbFile) {
      const fast = QueryHarness.tryCreateFromSnapshot(options);
      if (fast) return fast;
    }

    const dbFile = options.dbFile ?? ":memory:";
    const hadExistingDbFile = Boolean(options.dbFile) && fs.existsSync(dbFile);
    if (options.dbFile) {
      fs.mkdirSync(path.dirname(options.dbFile), { recursive: true });
      if (options.resetDbFile !== false && fs.existsSync(options.dbFile)) {
        fs.unlinkSync(options.dbFile);
      }
    }

    const { db } = openSQLite(dbFile);
    const shouldReuseExistingDb = Boolean(options.dbFile)
      && options.resetDbFile === false
      && options.reuseExistingDb === true
      && hadExistingDbFile;

    let snapshot = null as ReturnType<typeof schemaSnapshotFromDeclarative> | null;

    if (shouldReuseExistingDb) {
      snapshot = deserializeSchemaFromInstdata(db) ?? deserializeSchemaFromGelTables(db);
    }

    if (!snapshot) {
      let schemaSource = "";
      if (options.schema) {
        const schemaDir = path.join(__dirname, "schemas");
        schemaSource = loadSchemaSource(schemaDir, options.schema);
      }

      const decl = parseDeclarativeSchema(schemaSource, { legacySyntaxCompat: true },);
      snapshot = schemaSnapshotFromDeclarative(decl);
      materializeSchema(db, snapshot);
      ensureGelSchemaTables(db);
      serializeSchemaToGelTables(db, snapshot);
      serializeSchemaToInstdata(db, snapshot);
    }

    const fallbackModule = options.schema
      ? defaultModuleForSchema(path.join(__dirname, "schemas"), options.schema)
      : "default";
    const harness = new QueryHarness(db, snapshot, fallbackModule);

    const shouldRunSetup = Boolean(options.setup)
      && (!shouldReuseExistingDb || options.runSetupOnReuse === true);

    if (shouldRunSetup && options.setup) {
      const p = path.join(__dirname, "schemas", `${options.setup}.edgeql`);
      const rawSource = fs.readFileSync(p, "utf-8");
      harness.script(rawSource);
    }

    return harness;
  }

  /**
   * Snapshot-cached construction. Returns null if the runtime cannot serialize
   * (e.g. better-sqlite3 native binding unavailable), so the caller falls
   * back to the slow path.
   */
  private static tryCreateFromSnapshot(options: HarnessOptions): QueryHarness | null {
    const key = snapshotCacheKey(options.schema, options.setup);
    const cached = snapshotCache.get(key);
    const fallbackModule = options.schema
      ? defaultModuleForSchema(path.join(__dirname, "schemas"), options.schema)
      : "default";

    if (cached) {
      const { db } = openSQLite(cached.buffer);
      return new QueryHarness(db, cached.schema, cached.fallbackModule);
    }

    const { db } = openSQLite(":memory:");
    if (typeof db.serialize !== "function") {
      db.close();
      return null;
    }

    let schemaSource = "";
    if (options.schema) {
      const schemaDir = path.join(__dirname, "schemas");
      schemaSource = loadSchemaSource(schemaDir, options.schema);
    }
    const decl = parseDeclarativeSchema(schemaSource, { legacySyntaxCompat: true });
    const schema = schemaSnapshotFromDeclarative(decl);
    materializeSchema(db, schema);
    ensureGelSchemaTables(db);
    serializeSchemaToGelTables(db, schema);
    serializeSchemaToInstdata(db, schema);

    const harness = new QueryHarness(db, schema, fallbackModule);

    if (options.setup) {
      const p = path.join(__dirname, "schemas", `${options.setup}.edgeql`);
      const rawSource = fs.readFileSync(p, "utf-8");
      harness.script(rawSource);
    }

    snapshotCache.set(key, {
      schema,
      buffer: db.serialize(),
      fallbackModule,
    });

    return harness;
  }

  query(q: string) {
    return executeQuery(this.db, this.schema, q);
  }

  /**
   * Execute a multi-statement script (semicolon-separated)
   */
  script(s: string) {
    return executeScript(this.db, this.schema, s, undefined, { defaultModule: this.defaultModule });
  }

  /**
   * Direct port of EdgeDB's assert_query_result
   */
  assertQueryResult(q: string, expected: any) {
    const result = this.query(q);
    const normalized =
      result && typeof result === "object" && "rows" in result
        ? (result as { rows: unknown }).rows
        : result;
    expect(normalized).toEqual(expected);
  }

  /**
   * Simulates the 'Dump/Restore' or 'Branch' behavior
   */
  clone() {
    return new QueryHarness(this.db, this.schema, this.defaultModule);
  }
}
