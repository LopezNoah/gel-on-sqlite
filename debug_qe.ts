import fs from "node:fs";
import path from "node:path";
import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { executeScript, executeQueryWithTrace } from "./src/runtime/engine.js";
import { ensureGelSchemaTables, serializeSchemaToGelTables, serializeSchemaToInstdata } from "./src/schema/gel_persistence.js";

const cwd = "/Users/noahlopez/Development/Github/gel/sqlite-ts";
const schemaBody = fs.readFileSync(path.join(cwd, "tests/schemas/issues.esdl"), "utf8");
const decl = parseDeclarativeSchema(`module default {\n${schemaBody}\n}`, { legacySyntaxCompat: true });
const snapshot = schemaSnapshotFromDeclarative(decl);
const { db } = openSQLite(":memory:");
materializeSchema(db, snapshot);
ensureGelSchemaTables(db);
serializeSchemaToGelTables(db, snapshot);
serializeSchemaToInstdata(db, snapshot);
executeScript(db, snapshot, fs.readFileSync(path.join(cwd, "tests/schemas/issues_coalesce_setup.edgeql"), "utf8"), undefined, { defaultModule: "default" });

const queries = [
  `SELECT (SELECT Issue FILTER Issue.status.name = 'Open').time_estimate ?= <int64>{};`,
  `WITH I := (SELECT Issue FILTER Issue.status.name = 'Open') SELECT I.time_estimate ?!= <int64>{};`,
  `WITH I := (SELECT Issue FILTER Issue.status.name = 'Open') SELECT I.time_estimate ?!= 60;`,
];

for (const q of queries) {
  console.log("=== Q:", q);
  const trace = executeQueryWithTrace(db, snapshot, q);
  console.log("SQL:", trace.sql.sql);
  console.log("Result:", trace.result);
  console.log("---");
}
