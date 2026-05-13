import fs from "node:fs";
import path from "node:path";

import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import { executeScript } from "../src/runtime/engine.js";
import { ensureGelSchemaTables, serializeSchemaToGelTables, serializeSchemaToInstdata } from "../src/schema/gel_persistence.js";
import { parseDeclarativeSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

const cwd = process.cwd();
const schemaPath = path.join(cwd, "tests/schemas/cards.esdl");
const setupPath = path.join(cwd, "tests/schemas/cards_setup.edgeql");

const schemaBody = fs.readFileSync(schemaPath, "utf8");
const schemaSource = schemaBody.trimStart().startsWith("module ")
  ? schemaBody
  : `module default {\n${schemaBody}\n}`;

const decl = parseDeclarativeSchema(schemaSource, { parserEngine: "new_sdl", legacySyntaxCompat: true });
const snapshot = schemaSnapshotFromDeclarative(decl);
const { db } = openSQLite(":memory:");

materializeSchema(db, snapshot);
ensureGelSchemaTables(db);
serializeSchemaToGelTables(db, snapshot);
serializeSchemaToInstdata(db, snapshot);

const setupSource = fs.readFileSync(setupPath, "utf8");
const setupWithoutComments = setupSource.replace(/^\s*#.*$/gm, "");
const setupStatements = setupWithoutComments.split(";").map((statement) => statement.trim()).filter(Boolean);

for (let idx = 0; idx < setupStatements.length; idx += 1) {
  const statement = `${setupStatements[idx]};`;
  try {
    executeScript(db, snapshot, statement, undefined, { defaultModule: "default" });
  } catch (error) {
    console.log(`FAILED statement #${idx + 1}`);
    console.log(statement);
    console.error(error);
    process.exit(1);
  }
}

console.log("setup completed");
