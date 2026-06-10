import fs from "node:fs";
import path from "node:path";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import { executeScript, executeQueryWithTrace } from "../src/runtime/engine.js";

const dir = path.join(import.meta.dirname, "../tests/schemas");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const strip = (s: string) => s.replace(/#[^\n]*/g, "");
const wrap = (m: string, s: string) => strip(s).trimStart().startsWith("module ") ? strip(s) : `module ${m} {\n${strip(s)}\n}`;
const decl = parseDeclarativeSchema(wrap("cards", read("cards.esdl")), { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);
const { db } = openSQLite();
materializeSchema(db, schema);
executeScript(db, schema, `
SET MODULE cards;
INSERT Card { name := 'F1', element := 'Fire', cost := 1 };
INSERT Card { name := 'W1', element := 'Water', cost := 2 };
INSERT Card { name := 'W2', element := 'Water', cost := 3 };
INSERT User { name := 'Zed', deck := (SELECT Card FILTER .element != 'Fire') };
INSERT User { name := 'Yan', deck := (SELECT Card FILTER .element = 'Fire') };
`, undefined, { defaultModule: "cards" });
for (const q of [
  "select cards::Card { name } filter .element != 'Fire'",
  "select cards::User { name, deck: { name } }",
]) {
  const t: any = executeQueryWithTrace(db, schema, q, {});
  console.log(q, "=>", JSON.stringify(t.traces?.[0]?.result?.rows ?? t.result?.rows));
}
