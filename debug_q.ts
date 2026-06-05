import fs from "node:fs";
import { parseEdgeQL } from "./src/edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "./src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { compileGelIRToSQL } from "./src/sql/gel_ir_compiler.js";
import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import { executeQuery, executeScript } from "./src/runtime/engine.js";
import { ensureGelSchemaTables, serializeSchemaToGelTables, serializeSchemaToInstdata } from "./src/schema/gel_persistence.js";

const source = fs.readFileSync("./tests/schemas/inventory.esdl", "utf8");
const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

const query = process.argv[2] ?? "";
const flags = new Set(process.argv.slice(3));

if (flags.has("--ast") || flags.has("--ir") || flags.has("--sql")) {
  try {
    const ast: any = parseEdgeQL(query);
    const stmt = Array.isArray(ast) ? ast[0] : ast;
    const expanded = expandSchemaAliasesInStatement(stmt, schema);
    if (flags.has("--ast")) console.log("--- AST ---\n" + JSON.stringify(stmt, null, 2));
    const ir = compileASTToGelIR(expanded, { schema });
    if (flags.has("--ir")) console.log("--- IR ---\n" + JSON.stringify(ir, null, 2));
    if (flags.has("--sql")) {
      const sql = compileGelIRToSQL(ir as never, {
        target: "sqlite",
        resolveTypeColumns: () => undefined,
        resolveLinkStorageType: () => undefined,
        resolveEnumMembers: () => undefined,
        resolveFieldEnumMembers: () => undefined,
      });
      console.log("--- SQL ---\n" + sql.sql);
    }
  } catch (e: any) {
    console.error("Compile:", e.message);
  }
}

if (flags.has("--run")) {
  try {
    const { db } = openSQLite(":memory:");
    materializeSchema(db, schema);
    ensureGelSchemaTables(db);
    serializeSchemaToGelTables(db, schema);
    serializeSchemaToInstdata(db, schema);
    const setup = fs.readFileSync("./tests/schemas/inventory_setup.edgeql", "utf8");
    executeScript(db, schema, setup);
    const r = executeQuery(db, schema, query);
    console.log("--- RESULT ---\n" + JSON.stringify(r, null, 2));
  } catch (e: any) {
    console.error("Run:", e.message);
  }
}
