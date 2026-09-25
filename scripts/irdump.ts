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
const wrap = (m: string, s: string) =>
  strip(s).trimStart().startsWith("module ") ? strip(s) : `module ${m} {\n${strip(s)}\n}`;
const decl = parseDeclarativeSchema(
  wrap("default", read("issues.esdl")) + "\n\n" + wrap("cards", read("cards.esdl")),
  { legacySyntaxCompat: true },
);
const schema = schemaSnapshotFromDeclarative(decl);

const q = process.argv[2] ?? "select 1";
const stmt = parseEdgeQL(q);
const compiled = getCompilerService().compile(schema, stmt, {});
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
const g = asRecord(compiled.gelIr);
console.log(
  "gelIr kind:",
  g?.kind,
  "| byFieldNames:",
  g?.byFieldNames,
  "| hidden:",
  g?.hiddenByFields,
);

const describeSet = (value: unknown, depth: number): void => {
  const s = asRecord(value);
  if (!s || depth > 8) return;
  const expr = asRecord(s.expr);
  const typeref = asRecord(s.typeref);
  const shape = Array.isArray(s.shape) ? s.shape : [];
  const pad = "  ".repeat(depth);
  console.log(
    `${pad}expr.kind=${expr?.kind} typeref=${typeref?.name ?? typeref?.id ?? "?"} shape=[${shape
      .map((value) => {
        const element = asRecord(value);
        const elementExpr = asRecord(element?.expr);
        const nestedExpr = asRecord(elementExpr?.expr);
        return element?.name ?? nestedExpr?.kind;
      })
      .join(", ")}]`,
  );
  if (expr?.kind === "select_expr") describeSet(expr.result, depth + 1);
  if (expr?.kind === "for_expr") {
    console.log(`${pad}for body:`);
    describeSet(expr.body ?? expr.union, depth + 1);
  }
  if (expr?.kind === "group_rows") {
    const g2 = expr;
    console.log(
      `${pad}group_rows unlowerable=${g2.unlowerable} byAtoms=${JSON.stringify(g2.group?.byAtoms)} proj=${JSON.stringify(g2.projection)}`,
    );
    describeSet(g2.group?.subject, depth + 1);
  }
};
const subject = g?.subject ?? g?.result ?? g?.expr;
console.log("subject/result:");
describeSet(subject, 1);
const subjectShape = asRecord(subject)?.shape;
for (const value of Array.isArray(subjectShape) ? subjectShape : []) {
  const el = asRecord(value);
  const expr = asRecord(el?.expr);
  console.log(
    "top shape el:",
    el?.name,
    "| expr.kind:",
    asRecord(expr?.expr)?.kind,
    "| card:",
    el?.cardinality,
    "| target shape:",
    (Array.isArray(expr?.shape) ? expr.shape : []).map((entry) => asRecord(entry)?.name).join(","),
  );
}
