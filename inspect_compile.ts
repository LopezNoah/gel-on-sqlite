import fs from "node:fs";
import { parseEdgeQL } from "./src/edgeql/parser.js";
import { compileToIR } from "./src/compiler/semantic.js";
import { expandSchemaAliasesInStatement } from "./src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";

const source = fs.readFileSync("./tests/schemas/cards.esdl", "utf8");
const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

const queries = [
  `SELECT User.deck FILTER User.name`,
  `SELECT User.deck FILTER User.deck@count`,
  `SELECT User.deck { foo := User }`,
];
for (const q of queries) {
  console.log("\n==== Query:", q);
  try {
    const ast: any = parseEdgeQL(q);
    const stmt = Array.isArray(ast) ? ast[0] : ast;
    const expanded = expandSchemaAliasesInStatement(stmt, schema);
    const ir = compileToIR(schema, expanded);
    console.log("Compiled OK");
    console.log(JSON.stringify(ir, null, 2).slice(0, 2000));
  } catch (e: any) {
    console.log("Error:", e.message);
  }
}
