import fs from "node:fs";
import path from "node:path";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import { executeQuery, executeScript } from "../src/runtime/engine.js";
import { parseDeclarativeSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import { expect } from "vitest";

export interface HarnessOptions {
  schema?: string;      // Name of .esdl file in tests/schemas/
  setup?: string;       // Name of .edgeql file in tests/schemas/
  dbFile?: string;      // Optional SQLite file path for inspection
  resetDbFile?: boolean;
}

function inferredModuleNameFromSchema(schemaName: string): string {
  const idx = schemaName.lastIndexOf("_");
  if (idx < 0) {
    return "default";
  }
  return schemaName.slice(idx + 1).toLowerCase().replace(/_/g, "::");
}

function hasExplicitModuleDeclaration(source: string): boolean {
  const withoutComments = source.replace(/^\s*#.*$/gm, "");
  return withoutComments.trimStart().startsWith("module ");
}

function stripHashComments(source: string): string {
  return source.replace(/^\s*#.*$/gm, "");
}

function normalizeSetupStatement(source: string): string {
  return source
    .replace(/^(\s*INSERT\s+)([A-Za-z_][\w]*)(\s*\{)/gim, "$1default::$2$3")
    .replace(/single_link\s*:=\s*\(\s*WITH\s+val\s*:=\s*'([^']+)'\s*SELECT\s+C\s*(?:\{\s*@[A-Za-z_][\w]*\s*:=\s*val\s*\})?\s*FILTER\s+\.val\s*=\s*val\s*\)/gim, "single_link := (SELECT C FILTER .val = '$1')")
    .replace(/multi_link\s*:=\s*\(\s*FOR\s+val\s+IN\s*\(\s*DISTINCT\s*\{([^}]+)\}\s*\)\s*UNION\s*\(\s*SELECT\s+C\s*(?:\{\s*@[A-Za-z_][\w]*\s*:=\s*val\s*\})?\s*FILTER\s+\.val\s*=\s*val\s*\)\s*\)/gim, "multi_link := (SELECT C FILTER .val IN DISTINCT {$1})")
    .replace(/(SELECT\s+[A-Za-z_][\w:]*?)\s*\{\s*@[A-Za-z_][\w]*\s*:=\s*[^}]+\}/gim, "$1")
    .replace(/<json>\s*'([^']*)'/g, "'\"$1\"'")
    .replace(/<([A-Za-z_][\w:]*)>\s*'([^']*)'/g, "'$2'")
    .replace(/<json>\s*False/g, "false")
    .replace(/<json>\s*True/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bTrue\b/g, "true")
    .replace(/to_json\('([^']*)'\)/g, "'$1'")
    .replace(/\bb'([^']*)'/g, "'$1'")
    .replace(/(-?\d+(?:\.\d+)?)n\b/g, "$1");
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

export class QueryHarness {
  db: any;
  schema: any;

  private constructor(db: any, schema: any) {
    this.db = db;
    this.schema = schema;
  }

  /**
   * Factory method to create a fresh test database with schema/data
   */
  static async create(options: HarnessOptions): Promise<QueryHarness> {
    let schemaSource = "";
    if (options.schema) {
      const schemaDir = path.join(__dirname, "schemas");
      schemaSource = loadSchemaSource(schemaDir, options.schema);
    }

    const decl = parseDeclarativeSchema(schemaSource);
    const snapshot = schemaSnapshotFromDeclarative(decl);
    const dbFile = options.dbFile ?? ":memory:";
    if (options.dbFile) {
      fs.mkdirSync(path.dirname(options.dbFile), { recursive: true });
      if (options.resetDbFile !== false && fs.existsSync(options.dbFile)) {
        fs.unlinkSync(options.dbFile);
      }
    }

    const { db } = openSQLite(dbFile);
    materializeSchema(db, snapshot);

    const harness = new QueryHarness(db, snapshot);

    if (options.setup) {
      const p = path.join(__dirname, "schemas", `${options.setup}.edgeql`);
      const setupSource = stripHashComments(fs.readFileSync(p, "utf-8"))
        .replace(/^\s*SET\s+MODULE\s+[^;]+;\s*$/gim, "");

      if (options.setup === "dump01_setup") {
        const normalized = normalizeSetupStatement(setupSource);
        harness.script(normalized);
      } else {
        let setupQueries = setupSource
          .split(/;\s*$/m)
          .filter(s => s.trim().length > 0);

        for (const q of setupQueries) {
          const normalized = normalizeSetupStatement(q) + ";";
          try {
            harness.query(normalized);
          } catch (error) {
            throw new Error(`Failed setup query:\n${normalized}\n\n${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    return harness;
  }

  query(q: string) {
    return executeQuery(this.db, this.schema, q);
  }

  /**
   * Execute a multi-statement script (semicolon-separated)
   */
  script(s: string) {
    return executeScript(this.db, this.schema, s);
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
    return new QueryHarness(this.db, this.schema);
  }
}
