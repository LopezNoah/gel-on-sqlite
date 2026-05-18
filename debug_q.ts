import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import {
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
  ensureGelSchemaTables,
} from "./src/schema/gel_persistence.js";
import { executeQuery, executeScript } from "./src/runtime/engine.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const cardsPath = path.join("./tests/schemas", "cards.esdl");
  const schemaSource = `module default {\n${fs.readFileSync(cardsPath, "utf-8")}\n}\n`;
  const decl = parseDeclarativeSchema(schemaSource, { legacySyntaxCompat: true });
  const snapshot = schemaSnapshotFromDeclarative(decl);
  const { db } = openSQLite(":memory:");
  materializeSchema(db, snapshot);
  ensureGelSchemaTables(db);
  serializeSchemaToGelTables(db, snapshot);
  serializeSchemaToInstdata(db, snapshot);
  const setupPath = path.join("./tests/schemas", "cards_setup.edgeql");
  executeScript(db, snapshot, fs.readFileSync(setupPath, "utf-8"), undefined, { defaultModule: "default" });
  const q = process.argv[2];
  try {
    const result = executeQuery(db, snapshot, q);
    console.log(JSON.stringify(result));
  } catch (e: any) {
    console.log("ERROR:", e.message);
  }
}
main().catch(console.error);
