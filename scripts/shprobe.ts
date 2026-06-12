// Print shape-element typerefs vs ptrref targets for a query (cards schema).
import fs from "node:fs";
import path from "node:path";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { getCompilerService } from "../src/compiler/service.js";

const dir = path.join(import.meta.dirname, "../tests/schemas");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const strip = (s: string) => s.replace(/#[^\n]*/g, "");
const decl = parseDeclarativeSchema(`module default {\n${strip(read("cards.esdl"))}\n}`, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);
const ast = parseEdgeQL(process.argv[2] ?? "select 1");
const stmt = Array.isArray(ast) ? ast[0] : ast;
const compiled = getCompilerService().compile(schema, stmt, {});
const g = compiled.gelIr;
const subject = g?.subject ?? g?.expr;
for (const el of subject?.shape ?? []) {
  const e = el.expr;
  console.log("el:", el.name,
    "| set.typeref:", e?.typeref?.id ?? e?.typeref?.name,
    "| expr.kind:", e?.expr?.kind,
    "| ptr.outTarget:", e?.expr?.ptrref?.outTarget?.id,
    "| ptr.outSource:", e?.expr?.ptrref?.outSource?.id,
    "| dir:", e?.expr?.direction);
}
