import fs from "node:fs";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import { executeQuery, executeScript } from "./src/runtime/engine.js";

const source = fs.readFileSync("./tests/schemas/inventory.esdl", "utf8");
const setup = fs.readFileSync("./tests/schemas/inventory_setup.edgeql", "utf8");

const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

const { db } = openSQLite();
materializeSchema(db, schema);
executeScript(db, schema, setup, undefined, { defaultModule: "default" });

const q = `SELECT Item {
    name,
    re := re_match(Item.tag_set1, Item.tag_set2),
}
FILTER .name IN {'chair', 'table'}
ORDER BY .name;`;

console.log("Query:", q);
const r = executeQuery(db, schema, q, {});
console.log("Result:", JSON.stringify(r, null, 2));

const r2 = executeQuery(db, schema, `SELECT Item { name, tag_set1, tag_set2 } FILTER .name IN {'table', 'chair'} ORDER BY .name;`, {});
console.log("\nRaw tags:", JSON.stringify(r2, null, 2));

// Inspect raw row
const r3 = (db as any).prepare("SELECT name, tag_set1, tag_set2 FROM default__item WHERE name IN ('table', 'chair') ORDER BY name").all();
console.log("\nRaw SQL:", JSON.stringify(r3, null, 2));
