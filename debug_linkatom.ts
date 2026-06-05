import fs from "node:fs";
import { parseEdgeQL } from "./src/edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "./src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import { compileGelIRToSQL } from "./src/sql/gel_ir_compiler.js";

const source = fs.readFileSync("./tests/schemas/issues.esdl", "utf8");
const wrapped = source.trimStart().startsWith("module ") ? source : `module default {\n${source}\n}`;
const decl = parseDeclarativeSchema(wrapped, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

const q = `
SELECT
    User {
        todo := DISTINCT (
            FOR entry IN {("1", 10), ("1", 10)}
            UNION (
                SELECT Issue {
                    @rank := entry.1
                } FILTER
                    .number = entry.0
            )
        )
    }
FILTER
    .name = "Elvis"
`;

const ast: any = parseEdgeQL(q);
const stmt = Array.isArray(ast) ? ast[0] : ast;
const expanded = expandSchemaAliasesInStatement(stmt, schema);
const ir: any = compileASTToGelIR(expanded, { schema });
const result = compileGelIRToSQL(ir, { schema, target: "sqlite" });
console.log("SQL:");
console.log(result.sql);
console.log("Params:", result.params);
