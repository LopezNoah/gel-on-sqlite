// Microbenchmark for tokenize + parseEdgeQL.
//
// Usage: tsx scripts/bench-parser.ts [--iters N] [--warmup N] [--corpus inline|tests]
//
// Reports median ms/op, ops/sec, and MB/s for tokenize-only and
// tokenize+parse across a representative corpus of EdgeQL queries.

import { performance } from "node:perf_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { tokenize } from "../src/edgeql/tokenizer.js";
import { parseEdgeQL, parseEdgeQLScript } from "../src/edgeql/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const INLINE_CORPUS: string[] = [
  // Tiny
  `SELECT 1;`,
  `SELECT User { name } FILTER .name = 'alice';`,
  `SELECT Issue.owner { name } ORDER BY Issue.owner.name;`,
  // Medium
  `
    SELECT Issue {
      number,
      aliased_number := Issue.number,
      total_time_spent := (
        SELECT sum(Issue.time_spent_log.spent_time)
      )
    }
    FILTER Issue.number = '1';
  `,
  `
    SELECT User { name }
    FILTER
      any((
        for issue in User.<owner[IS Issue]
        select issue.time_estimate > 9000
        AND
        issue.due_date = <datetime>'2020-01-15T00:00:00+00:00'
      ))
    ORDER BY User.name;
  `,
  // Larger nested
  `
    SELECT User{name}
    FILTER
      EXISTS (
        SELECT
          I := User.<owner[IS Issue]
        FILTER
          NOT (
            NOT (
              EXISTS I.time_estimate AND
              I.time_estimate > 9000
            ) OR
            NOT (
              EXISTS I.due_date
              AND I.due_date =
                <datetime>'2020-01-15T00:00:00+00:00'
            )
          )
      )
    ORDER BY User.name;
  `,
  // Insert
  `
    INSERT Issue {
      number := '1',
      name := 'first issue',
      body := 'first body',
      owner := (SELECT User FILTER .name = 'Elvis'),
      watchers := (SELECT User FILTER .name = 'Yury'),
      status := (SELECT Status FILTER .name = 'Open'),
      priority := (SELECT Priority FILTER .name = 'High'),
      time_estimate := 3000,
    };
  `,
  // Update
  `
    UPDATE Issue
    FILTER .number = '1'
    SET {
      name := 'updated name',
      body := 'updated body',
      watchers += (SELECT User FILTER .name = 'Elvis'),
    };
  `,
  // For
  `
    FOR x IN {1, 2, 3, 4, 5}
    UNION (
      SELECT User { name, score := x * 10 }
      FILTER .name = 'Elvis'
    );
  `,
  // Group
  `
    GROUP Issue
    USING b := .status.name
    BY b;
  `,
  // Heavy expression
  `
    SELECT (
      a := 1 + 2 * 3 - 4 / 2 + 5 % 3,
      b := 'hello' ++ ' ' ++ 'world',
      c := <int64>'42' + count(User{name, friends: {name, score := 1}}),
      d := array_agg((SELECT User { name } ORDER BY .name LIMIT 5)),
      e := (1, 'a', true, [1,2,3], <json>'{"k":"v"}'),
    );
  `,
];

const formatNum = (n: number, digits = 3): string => n.toFixed(digits);

interface BenchResult {
  label: string;
  median: number;
  mean: number;
  min: number;
  ops: number;
  inputBytes: number;
}

const time = (fn: () => void): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

const runBench = (
  label: string,
  corpus: string[],
  fn: (input: string) => void,
  iters: number,
  warmup: number,
): BenchResult => {
  const totalBytes = corpus.reduce((acc, s) => acc + Buffer.byteLength(s, "utf8"), 0);

  // Warmup
  for (let w = 0; w < warmup; w += 1) {
    for (const q of corpus) fn(q);
  }

  const samples: number[] = [];
  for (let it = 0; it < iters; it += 1) {
    const t = time(() => {
      for (const q of corpus) fn(q);
    });
    samples.push(t);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const min = samples[0]!;
  return {
    label,
    median,
    mean,
    min,
    ops: corpus.length,
    inputBytes: totalBytes,
  };
};

const printResult = (r: BenchResult): void => {
  const opsPerSec = (r.ops / r.median) * 1000;
  const mbPerSec = (r.inputBytes / 1_048_576 / r.median) * 1000;
  const usPerOp = (r.median / r.ops) * 1000;
  console.log(
    `  ${r.label.padEnd(28)} median=${formatNum(r.median, 3)}ms  min=${formatNum(r.min, 3)}ms  ` +
      `mean=${formatNum(r.mean, 3)}ms  ${formatNum(opsPerSec, 1).padStart(9)} ops/s  ` +
      `${formatNum(mbPerSec, 2).padStart(7)} MB/s  ${formatNum(usPerOp, 2).padStart(7)} µs/op`,
  );
};

const loadTestCorpus = (): string[] => {
  // Pull queries embedded as backtick template literals from test files.
  // Heuristic: find calls like `assertQueryResult(h,\n    \`...\``,
  // capture the backtick string. Good-enough for benchmarking.
  const testsDir = join(__dirname, "..", "tests");
  const files = readdirSync(testsDir)
    .filter((f) => f.startsWith("edgeql_") && f.endsWith(".test.ts"));
  const queries: string[] = [];
  const re = /assertQueryResult\s*\(\s*h\s*,\s*`([\s\S]*?)`/g;
  for (const f of files) {
    const src = readFileSync(join(testsDir, f), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const q = m[1]!.trim();
      // Skip ones with ${...} interpolations (they'd fail to parse).
      if (q.includes("${")) continue;
      if (q.length < 5) continue;
      queries.push(q);
    }
  }
  return queries;
};

const main = (): void => {
  const args = process.argv.slice(2);
  let iters = 50;
  let warmup = 10;
  let corpusName: "inline" | "tests" = "tests";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--iters") {
      iters = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === "--warmup") {
      warmup = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === "--corpus") {
      corpusName = args[i + 1] as "inline" | "tests";
      i += 1;
    }
  }

  const corpus = corpusName === "inline" ? INLINE_CORPUS : loadTestCorpus();
  if (corpus.length === 0) {
    console.error("Empty corpus");
    process.exit(1);
  }

  const totalBytes = corpus.reduce((acc, s) => acc + Buffer.byteLength(s, "utf8"), 0);
  console.log(
    `Corpus: ${corpusName} (${corpus.length} queries, ${formatNum(totalBytes / 1024, 1)} KB total)`,
  );
  console.log(`Iters: ${iters}, warmup: ${warmup}\n`);

  // Pre-tokenize once to find any malformed queries to skip.
  const goodCorpus: string[] = [];
  let skipped = 0;
  for (const q of corpus) {
    try {
      tokenize(q);
      parseEdgeQL(q);
      goodCorpus.push(q);
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) console.log(`Skipped ${skipped} queries that failed to parse`);

  const tokResult = runBench("tokenize", goodCorpus, (q) => { tokenize(q); }, iters, warmup);
  const parseResult = runBench("tokenize+parse", goodCorpus, (q) => { parseEdgeQL(q); }, iters, warmup);

  printResult(tokResult);
  printResult(parseResult);

  const parseOnly = parseResult.median - tokResult.median;
  console.log(
    `\n  parse-only delta: ${formatNum(parseOnly, 3)}ms (${formatNum((parseOnly / parseResult.median) * 100, 1)}% of total)`,
  );

  // Script-mode bench: stitch many queries into a single ;-separated input.
  // Exercises parseEdgeQLScript, which previously re-tokenized each piece.
  const scriptInputs: string[] = [];
  const chunkSize = 25;
  for (let s = 0; s < goodCorpus.length; s += chunkSize) {
    const chunk = goodCorpus.slice(s, s + chunkSize);
    // Strip any existing trailing semicolons from pieces so we control termination.
    scriptInputs.push(chunk.map((q) => q.replace(/;\s*$/, "")).join(";\n") + ";\n");
  }
  console.log(`\n  script mode: ${scriptInputs.length} scripts averaging ${formatNum(goodCorpus.length / scriptInputs.length, 1)} stmts each`);
  const scriptResult = runBench("parseEdgeQLScript", scriptInputs, (s) => { parseEdgeQLScript(s); }, iters, warmup);
  printResult(scriptResult);
};

main();
