import fs from "node:fs";
import path from "node:path";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import { serializeSchemaToGelTables, serializeSchemaToInstdata, ensureGelSchemaTables } from "../src/schema/gel_persistence.js";
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

function stripHashComments(source: string): string {
  return source.replace(/^\s*#.*$/gm, "");
}

function hasExplicitModuleDeclaration(source: string): boolean {
  const withoutComments = source.replace(/^\s*#.*$/gm, "");
  return withoutComments.trimStart().startsWith("module ");
}

function wrapModule(moduleName: string, source: string): string {
  const cleanSource = stripHashComments(source);
  if (hasExplicitModuleDeclaration(cleanSource)) {
    return cleanSource;
  }
  return `module ${moduleName} {\n${cleanSource}\n}`;
}

function qualifyUnqualifiedTypes(source: string, moduleName: string): string {
  return source
    .replace(/\b(INSERT|UPDATE|DELETE)\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\b/gi, (_match, keyword: string, typeName: string) => {
      if (typeName.includes("::")) return _match;
      return `${keyword} ${moduleName}::${typeName}`;
    })
    .replace(/\bSELECT\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*(?=[\{<\s]|$)/gi, (_match, typeName: string) => {
      if (typeName.includes("::") || ["MODULE", "DETACHED", "DISTINCT", "count", "array_agg", "array_join", "str_lower"].includes(typeName)) return _match;
      return `SELECT ${moduleName}::${typeName}`;
    })
    .replace(/\bFILTER\s+\.__type__\.name\s*=\s*'([A-Za-z_]\w*)'/gi, (_match, typeName: string) => {
      if (typeName.includes("::")) return _match;
      return `FILTER .__type__.name = '${moduleName}::${typeName}'`;
    });
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
    ensureGelSchemaTables(db);
    serializeSchemaToGelTables(db, snapshot);
    serializeSchemaToInstdata(db, snapshot);

    const harness = new QueryHarness(db, snapshot);

    if (options.setup) {
      const p = path.join(__dirname, "schemas", `${options.setup}.edgeql`);
      const rawSource = stripHashComments(fs.readFileSync(p, "utf-8"));

      const setModuleMatch = rawSource.match(/^\s*SET\s+MODULE\s+([A-Za-z_][\w:]*);/im);
      const currentModule = setModuleMatch ? setModuleMatch[1] : null;

      const setupSource = rawSource.replace(/^\s*SET\s+MODULE\s+[^;]+;\s*$/gim, "");

      let setupQueries = setupSource
        .split(/;\s*$/m)
        .filter(s => s.trim().length > 0);

      for (const q of setupQueries) {
        const qualified = currentModule ? qualifyUnqualifiedTypes(q, currentModule) : q;
        harness.script(qualified + ";");
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
