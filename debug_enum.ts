import fs from "node:fs";
import path from "node:path";
import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import { executeQuery, executeScript } from "./src/runtime/engine.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";

async function main() {
  const dbFile = "./tests/.artifacts/enums_debug.sqlite";
  try { fs.unlinkSync(dbFile); } catch {}
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const schemaPath = "./tests/schemas/enums.esdl";
  const schemaSrc = `module default {\n${fs.readFileSync(schemaPath, "utf-8")}\n}`;
  const schema = parseDeclarativeSchema(schemaSrc, { legacySyntaxCompat: true });
  const ctx = openSQLite({ filename: dbFile });
  await materializeSchema(ctx, schema, { activeModule: "default" });

  const queries = [
    `SELECT <color_enum_t>{'RED', 'GREEN', 'BLUE'};`,
    `SELECT color_enum_t.GREEN;`,
    `SELECT default::color_enum_t.BLUE;`,
    `WITH x := default::color_enum_t.RED SELECT x;`,
    `SELECT <json><color_enum_t>'RED';`,
    `SELECT <color_enum_t><json>'RED';`,
  ];
  for (const q of queries) {
    console.log("\n===", q);
    try {
      const res = executeQuery(ctx, q, { schema, activeModule: "default" });
      console.log("rows:", JSON.stringify(res.rows));
      console.log("trace:", JSON.stringify(res.trace?.executionPath ?? res.trace));
    } catch (e: any) {
      console.log("ERROR:", e.message);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
