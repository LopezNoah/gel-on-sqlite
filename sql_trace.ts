// SQL execution tracer — a permanent debug tool.
//
// Prints the full, ordered sequence of SQL statements (params inlined) that the
// engine actually sends to SQLite for a given EdgeQL query, including the reads
// it issues to resolve WITH-bound DML chains / select-over-mutation, the
// BEGIN/COMMIT boundaries, and every write. This is the same sequence now
// surfaced on `QueryExecutionTrace.sqlTrail`; this tool just pretty-prints it
// and labels each statement by verb.
//
// Usage:
//   npx tsx sql_trace.ts                       # run the built-in tree examples
//   npx tsx sql_trace.ts update_08             # run one built-in example
//   npx tsx sql_trace.ts --schema=tree "SELECT Tree { val } FILTER .val = '0'"
//
// --schema=<name> loads tests/schemas/<name>.esdl and, if present,
// tests/schemas/<name>_setup.edgeql.

import fs from "node:fs";
import path from "node:path";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import { executeScript, executeQuery } from "./src/runtime/engine.js";
import type { SQLiteDatabase } from "./src/runtime/database.js";
import type { SchemaSnapshot } from "./src/schema/schema.js";

const SCHEMA_DIR = "./tests/schemas";

const loadSchema = (name: string): SchemaSnapshot => {
  const src = fs.readFileSync(path.join(SCHEMA_DIR, `${name}.esdl`), "utf8");
  const decl = parseDeclarativeSchema(`module default {\n${src}\n}`, { legacySyntaxCompat: true });
  return schemaSnapshotFromDeclarative(decl);
};

const freshDb = (name: string, schema: SchemaSnapshot): SQLiteDatabase => {
  const { db } = openSQLite();
  materializeSchema(db, schema);
  const setupPath = path.join(SCHEMA_DIR, `${name}_setup.edgeql`);
  if (fs.existsSync(setupPath)) {
    executeScript(db, schema, fs.readFileSync(setupPath, "utf8"), undefined, { defaultModule: "default" });
  }
  return db;
};

// Inline `?` params for readability.
const inline = (sql: string, params: unknown[]): string => {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const p = params[i++];
    return typeof p === "string" ? `'${p}'` : p === null || p === undefined ? "null" : String(p);
  });
};

// Capture every prepared-statement execution against this db, in order.
const traceQuery = (db: SQLiteDatabase, schema: SchemaSnapshot, query: string): string[] => {
  const log: string[] = [];
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    const verb = sql.trim().split(/\s+/)[0]!.toUpperCase();
    const rec = (params: unknown[]): void => { log.push(`[${verb}] ${inline(sql, params)}`); };
    const run = stmt.run.bind(stmt);
    const all = stmt.all.bind(stmt);
    stmt.run = (...p: unknown[]) => { rec(p); return run(...(p as never[])); };
    stmt.all = (...p: unknown[]) => { rec(p); return all(...(p as never[])); };
    return stmt;
  };
  try {
    executeQuery(db, schema, query, {});
  } catch (e) {
    log.push(`ERROR: ${(e as Error).message}`);
  } finally {
    db.prepare = origPrepare;
  }
  return log;
};

const print = (title: string, query: string, log: string[]): void => {
  console.log(`\n================ ${title} ================`);
  console.log(query.replace(/\s+/g, " ").trim());
  console.log("---- SQL sequence ----");
  log.forEach((l, i) => console.log(`${String(i + 1).padStart(2)}. ${l}`));
};

const EXAMPLES: Record<string, { schema: string; query: string }> = {
  update_05: { schema: "tree", query: `WITH T00 := (SELECT Tree FILTER .val = '00'), TC := (UPDATE (SELECT T00.children ORDER BY .val LIMIT 1) SET {parent := T00.parent}), UPDATE T00 SET {parent := TC};` },
  update_07: { schema: "tree", query: `WITH TP := (SELECT Tree FILTER .val = '000').parent, T000 := (UPDATE Tree FILTER .val = '000' SET {parent := .parent.parent}) UPDATE TP SET {parent := T000};` },
  update_08: { schema: "tree", query: `WITH T000 := (SELECT Eert FILTER .val = '000'), TP := (UPDATE (SELECT T000.parent) SET {children := (SELECT _ := .children FILTER _ != T000)}), TPP := (UPDATE (SELECT TP.parent) SET {children := (SELECT _ := assert_distinct({.children, T000}) FILTER _ != TP)}) UPDATE (SELECT _ := TPP.children FILTER _ = T000) SET {children := assert_distinct({.children, TP})};` },
  update_09: { schema: "tree", query: `select (update Tree filter .val = "00" set { }) { children: {val} }` },
  update_10: { schema: "tree", query: `select ( update Tree filter .val IN {"0", "00"} set { parent := {} } ) { val, children: {val} order by .val } order by .val;` },
};

const args = process.argv.slice(2);
const schemaArg = args.find((a) => a.startsWith("--schema="))?.slice("--schema=".length);
const rest = args.filter((a) => !a.startsWith("--"));

if (schemaArg && rest.length > 0) {
  const schema = loadSchema(schemaArg);
  const query = rest.join(" ");
  print(`${schemaArg}: custom`, query, traceQuery(freshDb(schemaArg, schema), schema, query));
} else {
  const only = rest[0];
  for (const [name, ex] of Object.entries(EXAMPLES)) {
    if (only && name !== only) continue;
    const schema = loadSchema(ex.schema);
    print(name, ex.query, traceQuery(freshDb(ex.schema, schema), schema, ex.query));
  }
}
