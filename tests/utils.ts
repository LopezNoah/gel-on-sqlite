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
import { Client } from "../src/client/index.js";
import type { QueryVariables } from "../src/runtime/engine.js";
// import { parseDeclarativeSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import { SchemaSnapshot } from "../src/schema/schema.js";
import { expect } from "vitest";
import { loadSchema } from "../src/schema/load.js";
import { expectLike } from "./python_query_test_helpers.js";

// Each test gets its own snapshot so test-time DDL (create function/type/…)
// doesn't leak across tests. `cloneShared` makes that cheap: it shares the
// source's deeply-frozen definition objects and only gives the clone fresh Map
// containers (DDL replaces whole entries, so the shared frozen defs are never
// mutated) plus the inherited content fingerprint — so the per-test clone no
// longer deep-copies every type or re-hashes the schema.
const cloneSchemaSnapshot = (schema: SchemaSnapshot): SchemaSnapshot =>
  SchemaSnapshot.cloneShared(schema);

export interface HarnessOptions {
  schema?: string;      // Name of .esdl file in tests/schemas/
  setup?: string;       // Name of .edgeql file in tests/schemas/
  dbFile?: string;      // Optional SQLite file path for inspection
  resetDbFile?: boolean;
  reuseExistingDb?: boolean;
  runSetupOnReuse?: boolean;
  // Additional schemas loaded as named modules alongside `schema`.
  // Each `{ moduleName: schemaFileBaseName }` wraps the .esdl content in
  // `module <moduleName> { … }` so its types are addressable as `module::Type`.
  extraModules?: Record<string, string>;
  // Optional setup scripts run inside named modules after the primary setup.
  extraSetups?: Array<{ module: string; setup: string }>;
  // When true, subsequent script()/query() calls flag the engine to enforce
  // user-DDL restrictions (generic types, USING SQL, SET OF params,
  // CREATE INFIX OPERATOR, CREATE CAST, CREATE PSEUDO TYPE,
  // extending cfg::ConfigObject). Mirrors upstream's
  // `INTERNAL_TESTMODE = False` on `TestEdgeQLUserDDL`. The read-only
  // stdlib-module guard is always enforced regardless of this flag.
  strictUserDDL?: boolean;
  // Transaction isolation level. Mirrors upstream's `TRANSACTION_ISOLATION`
  // test-class attribute (e.g. `TestRepeatableReadInsert`): under
  // "repeatable_read" the engine rejects INSERT/UPDATE that would rely on a
  // cross-table exclusive-constraint check. Defaults to serializable.
  isolation?: "serializable" | "repeatable_read";
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

function loadSchemaSource(schemaDir: string, schemaName: string, extraModules?: Record<string, string>): string {
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

  for (const [moduleName, fileName] of Object.entries(extraModules ?? {})) {
    parts.push({ fileName, moduleName });
  }

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

function snapshotCacheKey(
  schema: string | undefined,
  setup: string | undefined,
  extraModules?: Record<string, string>,
  extraSetups?: Array<{ module: string; setup: string }>,
): string {
  const extras = extraModules ? JSON.stringify(extraModules) : "";
  const extraSetupsStr = extraSetups ? JSON.stringify(extraSetups) : "";
  return `${schema ?? "<none>"}|${setup ?? "<none>"}|${extras}|${extraSetupsStr}`;
}

export class QueryHarness {
  db: any;
  schema: any;
  private readonly defaultModule: string;
  // The harness runs every query through the public Client facade (in raw
  // mode: the conformance suite's expected values were ported verbatim from
  // the Python suite's JSON-ish shapes, so the result codec is bypassed).
  // This keeps the conformance tests exercising the same pipeline
  // application code uses via `createClient`.
  private readonly client: Client;

  private constructor(db: any, schema: any, defaultModule = "default") {
    this.db = db;
    this.schema = schema;
    this.defaultModule = defaultModule;
    this.client = Client.fromParts(db, schema, {
      defaultModule,
      rawResults: true,
    });
  }

  /**
   * Toggle user-DDL strict enforcement on subsequent script()/query() calls.
   * Test classes that mirror upstream's `INTERNAL_TESTMODE = False` (e.g.
   * `TestEdgeQLUserDDL`) call this after `create({})` so the engine
   * rejects generic types, USING SQL bodies, etc.
   */
  setStrictUserDDL(value: boolean): void {
    this.client.setSecurityContext(value ? { strictUserDDL: true } : undefined);
  }

  // Apply create-time security options (currently the transaction isolation
  // level) to the underlying client. Called from `create` for both the snapshot
  // fast path and the slow path.
  private applyHarnessOptions(options: HarnessOptions): void {
    if (options.isolation) {
      this.client.setSecurityContext({ isolation: options.isolation });
    }
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
      if (fast) {
        fast.applyHarnessOptions(options);
        return fast;
      }
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
        schemaSource = loadSchemaSource(schemaDir, options.schema, options.extraModules);
      }

      snapshot = loadSchema(schemaSource, { legacySyntaxCompat: true });
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

    if (shouldRunSetup && options.extraSetups) {
      for (const extra of options.extraSetups) {
        const p = path.join(__dirname, "schemas", `${extra.setup}.edgeql`);
        const rawSource = fs.readFileSync(p, "utf-8");
        harness.script(`SET MODULE ${extra.module};\n${rawSource}`);
      }
    }

    harness.applyHarnessOptions(options);
    return harness;
  }

  /**
   * Snapshot-cached construction. Returns null if the runtime cannot serialize
   * (e.g. better-sqlite3 native binding unavailable), so the caller falls
   * back to the slow path.
   */
  private static tryCreateFromSnapshot(options: HarnessOptions): QueryHarness | null {
    const key = snapshotCacheKey(options.schema, options.setup, options.extraModules, options.extraSetups);
    const cached = snapshotCache.get(key);
    const fallbackModule = options.schema
      ? defaultModuleForSchema(path.join(__dirname, "schemas"), options.schema)
      : "default";

    if (cached) {
      const { db } = openSQLite(cached.buffer);
      return new QueryHarness(db, cloneSchemaSnapshot(cached.schema), cached.fallbackModule);
    }

    const { db } = openSQLite(":memory:");
    if (typeof db.serialize !== "function") {
      db.close();
      return null;
    }

    let schemaSource = "";
    if (options.schema) {
      const schemaDir = path.join(__dirname, "schemas");
      schemaSource = loadSchemaSource(schemaDir, options.schema, options.extraModules);
    }
    const schema = loadSchema(schemaSource, { legacySyntaxCompat: true });
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

    if (options.extraSetups) {
      for (const extra of options.extraSetups) {
        const p = path.join(__dirname, "schemas", `${extra.setup}.edgeql`);
        const rawSource = fs.readFileSync(p, "utf-8");
        harness.script(`SET MODULE ${extra.module};\n${rawSource}`);
      }
    }

    // Clone the schema before stashing it: the harness keeps the live
    // instance (so test-time DDL like `create function` mutates the
    // test's own snapshot), and the cache keeps an unmodified copy that
    // future `create({})` calls can clone from. Without the clone the
    // cache holds the same reference the test then mutates, leaking
    // UDFs / aliases between tests that share the empty cache key.
    snapshotCache.set(key, {
      schema: cloneSchemaSnapshot(schema),
      buffer: db.serialize(),
      fallbackModule,
    });

    return harness;
  }

  query(q: string, variables?: QueryVariables) {
    return this.client.querySyncEnvelope(q, variables);
  }

  /**
   * Execute a multi-statement script (semicolon-separated)
   */
  script(s: string, variables?: QueryVariables) {
    return this.client.scriptSyncEnvelope(s, variables);
  }

  /**
   * Direct port of EdgeDB's assert_query_result — uses `expectLike` so
   * matching is "expected keys must be present and equal" rather than strict
   * structural equality. This mirrors Python's `assert_data_shape` semantics:
   * the test author lists the fields they care about, extra fields in the
   * actual row are not a failure. Switch to `expect(...).toEqual(expected)`
   * locally if you need strict matching for a particular case.
   */
  assertQueryResult(q: string, expected: any) {
    const result = this.query(q);
    const normalized =
      result && typeof result === "object" && "rows" in result
        ? (result as { rows: unknown }).rows
        : result;
    expectLike(normalized, expected);
  }

  /**
   * Simulates the 'Dump/Restore' or 'Branch' behavior
   */
  clone() {
    return new QueryHarness(this.db, this.schema, this.defaultModule);
  }
}
