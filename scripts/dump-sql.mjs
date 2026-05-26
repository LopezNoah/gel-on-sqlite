/* eslint-disable */
// Dumps the SQL emitted for the queries the HACK-removal work targeted, plus a
// synthetic access-policy demo showing how policy condition columns are now
// projected so the runtime evaluates policies off the SELECT row rather than
// firing one `readRowById` per row.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { schemaSnapshotFromDeclarative } = await import(path.join(ROOT, "src/schema/uiSchema.ts"));
const { parseDeclarativeSchema } = await import(path.join(ROOT, "src/schema/sdl_adapter.ts"));
const { parseEdgeQL } = await import(path.join(ROOT, "src/edgeql/parser.ts"));
const { compileToIR } = await import(path.join(ROOT, "src/compiler/semantic.ts"));
const { compileToSQL } = await import(path.join(ROOT, "src/sql/compiler.ts"));

const loadSchema = (name) =>
  fs.readFileSync(path.join(ROOT, "tests", "schemas", `${name}.esdl`), "utf8");

const buildSchema = (name) => {
  const decl = parseDeclarativeSchema(loadSchema(name), { legacySyntaxCompat: true });
  return { decl, schema: schemaSnapshotFromDeclarative(decl) };
};

const formatSql = (sql) => {
  // Light pretty-print: break before major SQL keywords so the structure is
  // readable in the terminal without dragging in a real formatter.
  const keywords = ["FROM", "WHERE", "ORDER BY", "GROUP BY", "LIMIT", "OFFSET", "UNION ALL", "JOIN"];
  let out = sql;
  for (const kw of keywords) {
    out = out.split(` ${kw} `).join(`\n  ${kw} `);
  }
  return out;
};

const dumpQuery = (label, schema, edgeql, note) => {
  const ast = parseEdgeQL(edgeql);
  const ir = compileToIR(schema, ast);
  const artifact = compileToSQL(ir);
  console.log("─".repeat(78));
  console.log(`Query: ${label}`);
  console.log(`EdgeQL: ${edgeql}`);
  console.log(`IR kind: ${ir.kind}`);
  console.log(`loweringMode: ${artifact.loweringMode}`);
  console.log("SQL:");
  console.log(formatSql(artifact.sql));
  if (artifact.params.length > 0) {
    console.log(`Params: ${JSON.stringify(artifact.params)}`);
  }
  if (note) {
    console.log(`Note: ${note}`);
  }
  console.log("");
};

// ─── The four link-shape / aggregate / ORDER BY queries ──────────────────────
const { schema: cards } = buildSchema("cards");

dumpQuery(
  "L7867 nested multi-link {deck: {name, cost}}",
  cards,
  `SELECT User { name, deck: { name, cost } }`,
);

dumpQuery(
  "L7903 backlink {owners: {name}}",
  cards,
  `SELECT Card { name, owners: { name } }`,
);

dumpQuery(
  "L7768 link_aggregate sum(.deck.cost)",
  cards,
  `SELECT User { name, deck_cost := sum(.deck.cost) }`,
);

dumpQuery(
  "L10791 select_expr ORDER BY",
  cards,
  `SELECT Card.cost ORDER BY Card.cost DESC`,
  "select_expr IR is evaluated row-by-row by materializeSelectExprRows; the\n"
  + "top-level compileToSQL emits a placeholder. The L10791 win lives in the\n"
  + "runtime: when ORDER BY matches the SELECT entry, the row values ARE the\n"
  + "sort keys, so engine.ts sorts the JS array directly instead of re-evaluating\n"
  + "the IR per row.",
);

// ─── Access-policy projection (synthetic — SDL adapter doesn't parse `access
// policy ...` inline, so we attach the policy directly to the declarative
// schema and rebuild the snapshot). ─────────────────────────────────────────
console.log("─".repeat(78));
console.log("L8161 access-policy projection (synthetic — schema mutated to add policy)");

const { decl: cardsDecl } = buildSchema("cards");
const cardDecl = cardsDecl.types.find((t) => t.kind === "object" && t.name === "Card");
if (!cardDecl) throw new Error("expected Card in cards schema");

// Pick a query whose shape doesn't request the policy field, so the
// projection difference is visible.
const policyQuery = `SELECT Card { name }`;

// Without the policy
const baselineSnapshot = schemaSnapshotFromDeclarative(cardsDecl);
const baselineIR = compileToIR(baselineSnapshot, parseEdgeQL(policyQuery));
const baselineSql = compileToSQL(baselineIR);

console.log(`\nEdgeQL: ${policyQuery}`);
console.log("\nNo access policy:");
console.log(`  IR columns: ${JSON.stringify(baselineIR.columns)}`);
console.log("  SQL:");
console.log(formatSql(baselineSql.sql).split("\n").map((l) => "    " + l).join("\n"));

// With a policy referencing two fields the shape DOESN'T ask for (`element`,
// `cost`) plus a literal — exercises all three condition kinds.
cardDecl.accessPolicies = [
  {
    name: "fire_cheap_only",
    effect: "allow",
    operations: ["select"],
    condition: {
      kind: "and",
      clauses: [
        { kind: "field_eq_global", field: "element", global: "current_element" },
        { kind: "field_eq_literal", field: "cost", value: 1 },
      ],
    },
  },
];

const policySnapshot = schemaSnapshotFromDeclarative(cardsDecl);
const policyIR = compileToIR(policySnapshot, parseEdgeQL(policyQuery));
const policySql = compileToSQL(policyIR);

console.log("\nWith policy `allow select using (.element = global current_element and .cost = 1)`:");
console.log(`  IR columns: ${JSON.stringify(policyIR.columns)}  ← element & cost added`);
console.log("  SQL:");
console.log(formatSql(policySql.sql).split("\n").map((l) => "    " + l).join("\n"));
console.log("");
console.log("`element` and `cost` are projected into the SELECT even though the user only");
console.log("asked for `{name}` — semantic.ts walks every policy condition and adds the");
console.log("referenced fields to the IR's `columns` set. The runtime's evaluateSelectPolicies");
console.log("then reads the predicate values directly off the SQL row, skipping the per-row");
console.log("`readRowById` fallback that was the L8161 N+1.");
