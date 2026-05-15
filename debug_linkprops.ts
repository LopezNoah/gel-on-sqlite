import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import {
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
  ensureGelSchemaTables,
} from "./src/schema/gel_persistence.js";
import { executeQueryWithTrace, executeScript, executeQuery } from "./src/runtime/engine.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { parseEdgeQL } from "./src/edgeql/parser.js";
import { getCompilerService } from "./src/compiler/service.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const schemaDir = "./tests/schemas";
  const cardsPath = path.join(schemaDir, "cards.esdl");
  const schemaSource = `module default {\n${fs.readFileSync(cardsPath, "utf-8")}\n}\n`;

  const decl = parseDeclarativeSchema(schemaSource, { legacySyntaxCompat: true });
  const snapshot = schemaSnapshotFromDeclarative(decl);
  const { db } = openSQLite(":memory:");
  materializeSchema(db, snapshot);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);

  const setupPath = path.join(schemaDir, "cards_setup.edgeql");
  if (fs.existsSync(setupPath)) {
    executeScript(db, snapshot, fs.readFileSync(setupPath, "utf-8"), undefined, { defaultModule: "default" });
  }

  const queries = process.argv.slice(2);

  const svc = getCompilerService();
  for (const q of queries) {
    console.log("\n========================");
    console.log("Query:", q);
    console.log("========================");
    try {
      const ast = parseEdgeQL(q);
      console.log("AST:", JSON.stringify(ast, null, 2).slice(0, 3000));
      console.log("AST kind:", ast.kind);
      const compiled = svc.compile(snapshot, ast);
      console.log("IR.kind:", compiled.ir.kind);
      console.log("usesGelIrSql:", compiled.usesGelIrSql);
      console.log("loweringMode:", (compiled.sql as any).loweringMode);
      console.log("SQL:");
      console.log(compiled.sql.sql);
      const trace = executeQueryWithTrace(db, snapshot, q);
      console.log("Result rows (trace):", JSON.stringify(trace.result));
      const eq = executeQuery(db, snapshot, q);
      console.log("Result rows (executeQuery):", JSON.stringify(eq));
    } catch (e: any) {
      console.error("Error:", e.message);
      if (e.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
