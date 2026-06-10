// Dump the compiled gelIR for a query against the test issues+cards schema.
// Usage: npx tsx scripts/irdump.ts '<edgeql>'
import fs from "node:fs";
import path from "node:path";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { getCompilerService } from "../src/compiler/service.js";

const dir = path.join(import.meta.dirname, "../tests/schemas");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const strip = (s: string) => s.replace(/#[^\n]*/g, "");
const wrap = (m: string, s: string) => strip(s).trimStart().startsWith("module ") ? strip(s) : `module ${m} {\n${strip(s)}\n}`;
const decl = parseDeclarativeSchema(wrap("default", read("issues.esdl")) + "\n\n" + wrap("cards", read("cards.esdl")), { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

const q = process.argv[2] ?? "select 1";
const ast: any = parseEdgeQL(q);
const stmt = Array.isArray(ast) ? ast[0] : ast;
const compiled: any = getCompilerService().compile(schema, stmt, {} as any);
const g = compiled.gelIr;
console.log("gelIr kind:", g?.kind, "| byFieldNames:", g?.byFieldNames, "| hidden:", g?.hiddenByFields);

const describeSet = (s: any, depth: number): void => {
  if (!s || depth > 8) return;
  const pad = "  ".repeat(depth);
  console.log(`${pad}expr.kind=${s.expr?.kind} typeref=${s.typeref?.name ?? s.typeref?.id ?? "?"} shape=[${(s.shape ?? []).map((e: any) => e.name ?? e?.expr?.expr?.kind).join(", ")}]`);
  if (s.expr?.kind === "select_expr") describeSet(s.expr.result, depth + 1);
  if (s.expr?.kind === "for_expr") { console.log(`${pad}for body:`); describeSet(s.expr.body ?? s.expr.union, depth + 1); }
  if (s.expr?.kind === "group_rows") { const g2 = s.expr; console.log(`${pad}group_rows unlowerable=${g2.unlowerable} byAtoms=${JSON.stringify(g2.group?.byAtoms)} proj=${JSON.stringify(g2.projection)}`); describeSet(g2.group?.subject, depth + 1); }
};
const subject = g?.subject ?? g?.result ?? g?.expr;
console.log("subject/result:");
describeSet(subject, 1);
for (const el of subject?.shape ?? []) {
  console.log("top shape el:", el.name, "| expr.kind:", el.expr?.expr?.kind, "| card:", el.cardinality, "| target shape:", (el.expr?.shape ?? []).map((e: any) => e.name).join(","));
}
