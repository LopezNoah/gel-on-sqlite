// GROUP-lowering probe: compile + run a query against the test issues+cards
// schema and print the SQL artifact, lowering mode, and result rows.
// Usage: npx tsx scripts/gdbg.ts '<edgeql>' [--rows-only]
// (Standalone harness clone — tests/utils.ts imports vitest, unusable here.)
import fs from "node:fs";
import path from "node:path";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import { executeScript, executeQueryWithTrace } from "../src/runtime/engine.js";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { getCompilerService } from "../src/compiler/service.js";

const q = process.argv[2] ?? "select 1";
const rowsOnly = process.argv.includes("--rows-only");

const dir = path.join(import.meta.dirname, "../tests/schemas");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (s: string) => s.replace(/#[^\n]*/g, "");
const wrap = (mod: string, src: string) => {
  const clean = stripComments(src);
  return clean.trimStart().startsWith("module ") ? clean : `module ${mod} {\n${clean}\n}`;
};

const source = wrap("default", read("issues.esdl")) + "\n\n" + wrap("cards", read("cards.esdl"));
const decl = parseDeclarativeSchema(source, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);
const { db } = openSQLite();
materializeSchema(db, schema);
executeScript(db, schema, read("issues_setup.edgeql"), undefined, { defaultModule: "default" });
executeScript(db, schema, `SET MODULE cards;\n` + read("cards_setup.edgeql"), undefined, { defaultModule: "default" });

if (!rowsOnly) {
  try {
    const ast: any = parseEdgeQL(q);
    const stmt = Array.isArray(ast) ? ast[0] : ast;
    const compiled = getCompilerService().compile(schema, stmt, {} as any);
    console.log("LOWERING:", compiled.sql.loweringMode);
    console.log("SQL:\n" + (compiled.sql.sql || "(empty — runtime fallback)"));
    console.log("PARAMS:", JSON.stringify(compiled.sql.params ?? null));
    console.log("IR KIND:", compiled.ir?.kind, "| GELIR KIND:", (compiled as any).gelIr?.kind);
  } catch (e: any) {
    console.log("COMPILE ERR:", e.message);
  }
}

try {
  const t: any = executeQueryWithTrace(db, schema, q, {});
  const trace = t.traces?.[0] ?? t;
  console.log("ROWS:", JSON.stringify(trace.result?.rows, null, 1)?.slice(0, 3000));
} catch (e: any) {
  console.log("RUN ERR:", e.message);
}

if (process.argv.includes("--twice")) {
  try {
    const t2: any = executeQueryWithTrace(db, schema, q, {});
    const trace2 = t2.traces?.[0] ?? t2;
    console.log("ROWS2:", JSON.stringify(trace2.result?.rows)?.slice(0, 200));
  } catch (e: any) {
    console.log("RUN2 ERR:", e.message);
  }
}
