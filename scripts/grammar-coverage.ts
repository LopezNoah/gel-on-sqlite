// Run from sqlite-ts: npx tsx scripts/grammar-coverage.ts
// Static preflight for literal queries passed to conformance assertion helpers.
import { parseEdgeQLGrammarScript } from "../src/edgeql/grammar_parser.js";
import { extractSuiteQueries } from "./grammar-query-corpus.js";

const stats = new Map<string, { seen: number; accepted: number; examples: string[] }>();
const gaps = new Map<string, { count: number; examples: string[] }>();
const corpus = extractSuiteQueries();
const total = corpus.queries.length;
for (const { query } of corpus.queries) {
  const kind = /^\s*(\w+)/.exec(query)?.[1].toUpperCase() ?? "OTHER";
  const stat = stats.get(kind) ?? { seen: 0, accepted: 0, examples: [] };
  stat.seen++;
  try {
    parseEdgeQLGrammarScript(query);
    stat.accepted++;
  } catch (error) {
    if (stat.examples.length < 3) stat.examples.push(query.replace(/\s+/g, " ").slice(0, 110));
    const message =
      error instanceof Error ? error.message.split("\n", 1)[0] : "Unknown parser error";
    const signature = message
      .replace(/but found --> .*? <--/g, "but found <token>")
      .replace(/Unsupported token '[^']*'/g, "Unsupported token <lexeme>")
      .replace(
        /Redundant input, expecting EOF but found: .*/g,
        "Redundant input after parsed expression",
      );
    const gap = gaps.get(signature) ?? { count: 0, examples: [] };
    gap.count++;
    if (gap.examples.length < 2) gap.examples.push(query.replace(/\s+/g, " ").slice(0, 150));
    gaps.set(signature, gap);
  }
  stats.set(kind, stat);
}
const accepted = [...stats.values()].reduce((sum, stat) => sum + stat.accepted, 0);
console.log(
  `Extracted ${total} expected-success queries from conformance assertion helpers; skipped ${corpus.skippedInterpolated} interpolated templates.`,
);
console.log(
  `Grammar parser accepted ${accepted}/${total} extracted query inputs (${((accepted / total) * 100).toFixed(1)}%).`,
);
for (const [kind, stat] of [...stats].sort((a, b) => b[1].seen - a[1].seen)) {
  console.log(
    `${kind.padEnd(12)} ${stat.accepted}/${stat.seen} parsed${stat.examples.length ? `; gaps: ${stat.examples.join(" | ")}` : ""}`,
  );
}
console.log("Most frequent parser-gap signatures:");
for (const [signature, gap] of [...gaps].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
  console.log(`${String(gap.count).padStart(5)} ${signature}; e.g. ${gap.examples.join(" | ")}`);
}
