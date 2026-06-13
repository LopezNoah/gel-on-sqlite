// Generic insert-schema probe. Usage:
//   npx tsx scripts/insprobe2.ts '<query>'            -> run single query, show SQL+rows
//   SETUP='...edgeql...' npx tsx scripts/insprobe2.ts '<query>'
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
const schemaFile = process.env.SCHEMA ?? "insert.esdl";
const decl = parseDeclarativeSchema(wrap("default", read(schemaFile)), { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);
const { db } = openSQLite();
materializeSchema(db, schema);
if (process.env.SETUP) {
  executeScript(db, schema, process.env.SETUP, undefined, { defaultModule: "default" });
}
const q = process.argv[2] ?? "select 1";
const args = process.env.ARGS ? JSON.parse(process.env.ARGS) : {};
try {
  const t = executeQueryWithTrace(db, schema, q, args);
  const trace = t.traces?.[0] ?? t;
  console.log("SQL:", (trace.sql?.sql ?? "").slice(0, 2000));
  console.log("ROWS:", JSON.stringify(trace.result?.rows, null, 1)?.slice(0, Number(process.env.ROWS_MAX ?? 3000)));
} catch (e: any) {
  console.log("ERROR:", e?.message);
  console.log(e?.stack?.split("\n").slice(0, 6).join("\n"));
}
