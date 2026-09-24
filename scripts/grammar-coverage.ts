// Run from sqlite-ts: npx tsx scripts/grammar-coverage.ts
// Heuristic sample of literal queries in ported integration tests. This is a
// coverage indicator, not a proof of Gel syntax parity or executable semantics.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseEdgeQLGrammar } from "../src/edgeql/grammar_parser.js";
import { parseEdgeQLScript } from "../src/edgeql/parser.js";

const tests = fileURLToPath(new URL("../tests/", import.meta.url));
const stats = new Map<string, { seen: number; accepted: number; equivalent: number; mismatched: number; examples: string[]; mismatchExamples: string[] }>();
let total = 0;
let skipped = 0;
for (const file of readdirSync(tests).filter((name) => /^edgeql_.*\.test\.ts$/.test(name))) {
  const text = readFileSync(join(tests, file), "utf8");
  const pattern = /(?:assertQueryResult|queryRows|querySingle)\s*\(\s*h\s*,\s*`([\s\S]*?)`/g;
  for (const match of text.matchAll(pattern)) {
    const query = match[1].trim();
    if (query.includes("${")) { skipped++; continue; }
    let original: unknown;
    try {
      const statements = parseEdgeQLScript(query);
      if (statements.length !== 1) { skipped++; continue; }
      original = statements[0];
    } catch {
      skipped++;
      continue;
    }
    total++;
    const kind = /^\s*(\w+)/.exec(query)?.[1].toUpperCase() ?? "OTHER";
    const stat = stats.get(kind) ?? { seen: 0, accepted: 0, equivalent: 0, mismatched: 0, examples: [], mismatchExamples: [] };
    stat.seen++;
    try {
      const parsed = parseEdgeQLGrammar(query);
      stat.accepted++;
      if (isDeepStrictEqual(
        JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(original)),
      )) stat.equivalent++;
      else {
        stat.mismatched++;
        if (stat.mismatchExamples.length < 3) stat.mismatchExamples.push(query.replace(/\s+/g, " ").slice(0, 110));
      }
    } catch {
      if (stat.examples.length < 3) stat.examples.push(query.replace(/\s+/g, " ").slice(0, 110));
    }
    stats.set(kind, stat);
  }
}
console.log(`Extracted ${total} single-statement queries accepted by sqlite-ts; skipped ${skipped} interpolated, multi-statement or rejected examples.`);
const totals = [...stats.values()].reduce((sum, stat) => ({
  parsed: sum.parsed + stat.accepted,
  equivalent: sum.equivalent + stat.equivalent,
  mismatched: sum.mismatched + stat.mismatched,
}), { parsed: 0, equivalent: 0, mismatched: 0 });
console.log(`Grammar: ${totals.parsed}/${total} parsed; ${totals.equivalent}/${total} AST-equal (${(totals.equivalent / total * 100).toFixed(1)}%); ${totals.mismatched} AST-different.`);
for (const [kind, stat] of [...stats].sort((a, b) => b[1].seen - a[1].seen)) {
  console.log(`${kind.padEnd(12)} ${stat.equivalent}/${stat.seen} AST-equal, ${stat.mismatched} AST-different, ${stat.accepted} parsed${stat.examples.length ? `; gaps: ${stat.examples.join(" | ")}` : ""}`);
  if (stat.mismatchExamples.length) console.log(`             AST differences: ${stat.mismatchExamples.join(" | ")}`);
}
