import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenize, tokenizeToStream } from "../src/edgeql/tokenizer.js";
import { parseEdgeQL, parseEdgeQLScript } from "../src/edgeql/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const shortQuery = "SELECT User { name, email, friends: { name } } FILTER .name = 'Alice' ORDER BY .name LIMIT 10";

const mediumQuery = `
WITH module default
SELECT Issue {
  number,
  name,
  body,
  owner: { name },
  watchers: { name },
  status: { name },
  priority: { name },
  references: { name, __type__: { name } },
  related_to: { name, status: { name } },
  due_date,
  time_estimate,
  time_spent_log: { spent_time, owner: { name } },
}
FILTER .status.name = 'Open' AND .priority.name IN {'High', 'Critical'}
ORDER BY .time_estimate DESC THEN .due_date ASC EMPTY FIRST
LIMIT 50
`.trim();

const cardsSdlPath = resolve(__dirname, "..", "tests", "schemas", "cards.esdl");
const issuesSdlPath = resolve(__dirname, "..", "tests", "schemas", "issues.esdl");

const cardsSdl = readFileSync(cardsSdlPath, "utf8");
const issuesSdl = readFileSync(issuesSdlPath, "utf8");

const longSdl = `
${cardsSdl}

${issuesSdl}
`.trim();

const longEdgeQLScript = [
  "SELECT 1;",
  "SELECT User { name, email };",
  shortQuery + ";",
  mediumQuery + ";",
  "INSERT User { name := 'Alice', email := 'a@example.com' };",
  "UPDATE User FILTER .name = 'Alice' SET { email := 'a2@example.com' };",
  "DELETE User FILTER .name = 'Bob';",
  "FOR x IN { 1, 2, 3 } UNION (SELECT x * 2);",
  "WITH names := { 'a', 'b', 'c' } SELECT names ORDER BY names;",
  mediumQuery + ";",
].join("\n");

interface BenchResult {
  name: string;
  inputBytes: number;
  tokenCount: number;
  iters: number;
  totalMs: number;
  perOpUs: number;
  opsPerSec: number;
}

const formatNumber = (n: number, digits = 2): string => {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(digits);
};

const bench = (name: string, input: string, op: () => unknown, targetMs = 1500, minIters = 5): BenchResult => {
  for (let i = 0; i < 3; i += 1) op();

  let iters = 0;
  const start = process.hrtime.bigint();
  const deadline = start + BigInt(targetMs) * 1_000_000n;
  let now = start;
  while (now < deadline || iters < minIters) {
    op();
    iters += 1;
    now = process.hrtime.bigint();
  }
  const totalNs = Number(now - start);
  const totalMs = totalNs / 1_000_000;
  const perOpUs = totalNs / iters / 1_000;
  const opsPerSec = (iters / totalNs) * 1_000_000_000;

  let tokenCount: number;
  try {
    tokenCount = tokenize(input).length;
  } catch {
    tokenCount = -1;
  }

  return {
    name,
    inputBytes: input.length,
    tokenCount,
    iters,
    totalMs,
    perOpUs,
    opsPerSec,
  };
};

const printRow = (r: BenchResult): void => {
  const cols = [
    r.name.padEnd(36),
    formatNumber(r.inputBytes).padStart(8),
    formatNumber(r.tokenCount).padStart(8),
    formatNumber(r.iters).padStart(8),
    formatNumber(r.perOpUs).padStart(10),
    formatNumber(r.opsPerSec, 0).padStart(12),
  ];
  console.log(cols.join("  "));
};

const printHeader = (): void => {
  const cols = [
    "name".padEnd(36),
    "bytes".padStart(8),
    "tokens".padStart(8),
    "iters".padStart(8),
    "us/op".padStart(10),
    "ops/sec".padStart(12),
  ];
  console.log(cols.join("  "));
  console.log("-".repeat(cols.join("  ").length));
};

const main = (): void => {
  const label = process.argv[2] ?? "run";
  console.log(`\n== sqlite-ts tokenizer/parser bench (${label}) ==\n`);
  console.log(`node ${process.version} | ${process.platform}/${process.arch}\n`);

  printHeader();

  const results: BenchResult[] = [];

  results.push(bench("tokenize(shortQuery)", shortQuery, () => tokenize(shortQuery)));
  results.push(bench("tokenize(mediumQuery)", mediumQuery, () => tokenize(mediumQuery)));
  results.push(bench("tokenize(cardsSdl)", cardsSdl, () => tokenize(cardsSdl)));
  results.push(bench("tokenize(longSdl)", longSdl, () => tokenize(longSdl)));
  results.push(bench("tokenize(longEdgeQLScript)", longEdgeQLScript, () => tokenize(longEdgeQLScript)));

  if (typeof tokenizeToStream === "function") {
    results.push(bench("tokenizeToStream(shortQuery)", shortQuery, () => tokenizeToStream(shortQuery)));
    results.push(bench("tokenizeToStream(mediumQuery)", mediumQuery, () => tokenizeToStream(mediumQuery)));
    results.push(bench("tokenizeToStream(cardsSdl)", cardsSdl, () => tokenizeToStream(cardsSdl)));
    results.push(bench("tokenizeToStream(longSdl)", longSdl, () => tokenizeToStream(longSdl)));
    results.push(bench("tokenizeToStream(longEdgeQLScript)", longEdgeQLScript, () => tokenizeToStream(longEdgeQLScript)));
  }

  results.push(bench("parseEdgeQL(shortQuery)", shortQuery, () => parseEdgeQL(shortQuery)));
  results.push(bench("parseEdgeQL(mediumQuery)", mediumQuery, () => parseEdgeQL(mediumQuery)));
  results.push(bench("parseEdgeQLScript(longEdgeQLScript)", longEdgeQLScript, () => parseEdgeQLScript(longEdgeQLScript)));

  for (const r of results) printRow(r);

  console.log("\nJSON:");
  console.log(JSON.stringify({ label, node: process.version, results }, null, 2));
};

main();
