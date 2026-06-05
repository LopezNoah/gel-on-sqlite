import fs from "node:fs";
import path from "node:path";
import { parseEdgeQL } from "./src/edgeql/parser.js";
import { compileToIR } from "./src/compiler/semantic.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "./src/compiler/ast_to_ir.js";
import { compileGelIRToSQL } from "./src/sql/gel_ir_compiler.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import { executeQuery, executeScript } from "./src/runtime/engine.js";
import {
  ensureGelSchemaTables,
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
} from "./src/schema/gel_persistence.js";

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
  return stripHashComments(source).trimStart().startsWith("module ");
}
function wrapModule(moduleName: string, source: string): string {
  const cleanSource = stripHashComments(source);
  if (hasExplicitModuleDeclaration(cleanSource)) return cleanSource;
  return `module ${moduleName} {\n${cleanSource}\n}`;
}

const schemaDir = path.join(process.cwd(), "tests", "schemas");
const issuesSrc = wrapModule("default", fs.readFileSync(path.join(schemaDir, "issues.esdl"), "utf8"));
const cardsSrc = wrapModule("cards", fs.readFileSync(path.join(schemaDir, "cards.esdl"), "utf8"));
const combined = `${issuesSrc}\n\n${cardsSrc}`;
const decl = parseDeclarativeSchema(combined, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

const { db } = openSQLite(":memory:");
materializeSchema(db, schema);
ensureGelSchemaTables(db);
serializeSchemaToGelTables(db, schema);
serializeSchemaToInstdata(db, schema);
executeScript(db, schema, fs.readFileSync(path.join(schemaDir, "issues_setup.edgeql"), "utf8"));
executeScript(db, schema, fs.readFileSync(path.join(schemaDir, "cards_setup.edgeql"), "utf8"), undefined, {
  defaultModule: "cards",
} as never);

const query = process.argv[2] ?? "";
const flags = new Set(process.argv.slice(3));

if (flags.has("--ast") || flags.has("--legacyir") || flags.has("--gelir") || flags.has("--sql")) {
  const ast: any = parseEdgeQL(query);
  const stmt = Array.isArray(ast) ? ast[0] : ast;
  if (flags.has("--ast")) console.log("--- AST ---\n" + JSON.stringify(stmt, null, 2));
  if (flags.has("--legacyir")) {
    try {
      const ir = compileToIR(schema, stmt, {});
      console.log("--- LEGACY IR ---\n" + JSON.stringify(ir, null, 2));
    } catch (e: any) {
      console.error("LegacyIR:", e.stack ?? e.message);
    }
  }
  if (flags.has("--gelir") || flags.has("--sql")) {
    try {
      const expanded = expandSchemaAliasesInStatement(stmt, schema);
      const gel = compileASTToGelIR(expanded, { schema });
      if (flags.has("--gelir")) console.log("--- GELIR ---\n" + JSON.stringify(gel, null, 2));
      if (flags.has("--sql")) {
        const sql = compileGelIRToSQL(gel as never, {
          target: "sqlite",
          resolveTypeColumns: () => undefined,
          resolveLinkStorageType: () => undefined,
          resolveEnumMembers: () => undefined,
          resolveFieldEnumMembers: () => undefined,
        });
        console.log("--- SQL ---\n" + sql.sql);
      }
    } catch (e: any) {
      console.error("GelIR/SQL:", e.stack ?? e.message);
    }
  }
}

if (flags.has("--run")) {
  try {
    const r = executeQuery(db, schema, query);
    console.log("--- RESULT ---\n" + JSON.stringify(r, null, 2));
  } catch (e: any) {
    console.error("Run:", e.stack ?? e.message);
  }
}
