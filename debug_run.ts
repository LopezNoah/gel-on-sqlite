import fs from "node:fs";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import { executeQuery, executeScript } from "./src/runtime/engine.js";

// Try the issues schema
const source = fs.readFileSync("./tests/schemas/issues.esdl", "utf8");
const setupPath = "./tests/schemas/issues_setup.edgeql";
const setup = fs.existsSync(setupPath) ? fs.readFileSync(setupPath, "utf8") : "";

const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

const { db } = openSQLite();
materializeSchema(db, schema);
if (setup) executeScript(db, schema, setup, undefined, { defaultModule: "default" });

const q = `select Issue { * } filter .number = "1";`;

console.log("Query:", q);
try {
  const r = executeQuery(db, schema, q, {});
  console.log("Result:", JSON.stringify(r, null, 2));
} catch (e: any) {
  console.log("Error:", e.message);
}
