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
  executeScript(db, snapshot, fs.readFileSync(path.join("./tests/schemas", "cards_setup.edgeql"), "utf-8"), undefined, { defaultModule: "default" });

  // Run via tryRuntimeSelectExprEvaluation path
  const q = `with X1 := (Card { z := (for d in .<deck[IS User] union (d, d@count))}), X2 := X1 { owners2 := assert_distinct(.z.0 { count := X1.z.1 }) }, select X2 { name, owners2: {name, count} order BY .name } filter .name = 'Dwarf';`;
  try {
    const result = executeQuery(db, snapshot, q);
    console.log(JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log("ERROR:", e.message);
  }
}
main().catch(console.error);
