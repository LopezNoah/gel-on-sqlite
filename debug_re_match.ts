import fs from "node:fs";
import { parseEdgeQL } from "./src/edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "./src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { compileGelIRToSQL } from "./src/sql/gel_ir_compiler.js";

const source = fs.readFileSync("./tests/schemas/inventory.esdl", "utf8");
const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

const queries = [
  `SELECT Item {
      name,
      re := re_match(Item.tag_set1, Item.tag_set2),
  }
  FILTER .name IN {'chair', 'table'}
  ORDER BY .name;`,
];
for (const q of queries) {
  console.log("\n==== Query:", q);
  try {
    const ast: any = parseEdgeQL(q);
    const stmt = Array.isArray(ast) ? ast[0] : ast;
    const expanded = expandSchemaAliasesInStatement(stmt, schema);
    const ir = compileASTToGelIR(expanded, { schema });
    // Locate the function_call subtree
    const findFc = (n: any): any => {
      if (!n || typeof n !== "object") return undefined;
      if (n.kind === "function_call") return n;
      for (const k of Object.keys(n)) {
        const v = (n as any)[k];
        if (Array.isArray(v)) {
          for (const e of v) {
            const r = findFc(e);
            if (r) return r;
          }
        } else if (typeof v === "object") {
          const r = findFc(v);
          if (r) return r;
        }
      }
      return undefined;
    };
    const fc = findFc(ir);
    console.log("---- function_call subtree ----");
    console.log(JSON.stringify(fc, null, 2));
    console.log("\n---- SQL ----");
    const sql = compileGelIRToSQL(ir, { target: "sqlite", schema });
    console.log(JSON.stringify(sql, null, 2));
  } catch (e: any) {
    console.log("Error:", e.message);
    console.log(e.stack);
  }
}
