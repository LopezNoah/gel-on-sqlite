import fs from "node:fs";
import path from "node:path";
import { openSQLite, materializeSchema } from "./src/runtime/database.js";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";
import {
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
  ensureGelSchemaTables,
} from "./src/schema/gel_persistence.js";
import { executeScript } from "./src/runtime/engine.js";
import { parseEdgeQL } from "./src/edgeql/parser.js";
import { compileToIR } from "./src/compiler/semantic.js";

const source = fs.readFileSync(path.join(process.cwd(), "tests/schemas/advtypes.esdl"), "utf8");
const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);
const { db } = openSQLite(":memory:");
materializeSchema(db, schema);
ensureGelSchemaTables(db);
serializeSchemaToGelTables(db, schema);
serializeSchemaToInstdata(db, schema);

executeScript(db, schema, `
  INSERT CBa {ba := 'cba0'};
  INSERT CBaBb {ba := 'cba2', bb := 2};
  INSERT CBaBbBc {ba := 'cba8', bb := 8, bc := 8.5};
`);

// Try the synthetic wrapped form that executeForLoop generates
const synthetic: any = {
  kind: "select_expr",
  expr: {
    kind: "for_expr",
    variable: "x",
    iterator: {
      kind: "select",
      typeName: "Ba",
      shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
      clauses: {},
    },
    body: {
      kind: "shape_projection",
      expr: {
        kind: "path_steps",
        steps: [
          { kind: "object_ref", name: "x" },
          { kind: "type_intersection", typeName: "Bb", typeExpr: { kind: "type_name", name: "Bb" } },
        ],
        partial: undefined,
      },
      shape: [
        { kind: "computed", name: "tn", expr: { kind: "type_name" }, operation: "assign", origin: "explicit" },
        { kind: "field", name: "ba", operation: "assign", origin: "explicit" },
        { kind: "field", name: "bb", operation: "assign", origin: "explicit" },
        {
          kind: "computed",
          name: "bc",
          expr: { kind: "polymorphic_field_ref", sourceType: "Bc", sourceTypeExpr: { kind: "type_name", name: "Bc" }, field: "bc" },
          operation: "assign",
          origin: "explicit",
        },
      ],
    },
  },
  orderBy: undefined,
  pos: { line: 1, column: 1 },
};

const ir = compileToIR(schema, synthetic);
console.log("--- IR ---");
console.dir(ir, { depth: 20 });
