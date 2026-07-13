#!/usr/bin/env node
/**
 * compare-test-goldens.mjs
 *
 * Runs the full vitest suite once with verbose output, parses the results,
 * and produces markdown comparison reports grouped by test file.
 * Output goes into `test-comparison/` at the repo root.
 *
 * Usage:  node scripts/compare-test-goldens.mjs
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = path.join(ROOT, "test-comparison");

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 1. Run tests once with verbose ─────────────────────────────────────────
console.log("Running full test suite (verbose) …");
let raw;
try {
  raw = execSync("npx vitest run --reporter verbose 2>&1", {
    cwd: ROOT,
    maxBuffer: 50 * 1024 * 1024,
    encoding: "utf8",
  });
} catch (err) {
  raw = (err.stdout || "") + (err.stderr || "");
}
fs.writeFileSync(path.join(OUT_DIR, "_raw_output.txt"), raw);
console.log(`  Captured ${(raw.length / 1024 / 1024).toFixed(1)} MB of output`);

// ── 2. Split output into two sections ──────────────────────────────────────
const lines = raw.split("\n");

// Find the separator between the test-result list and the failure detail blocks
const separatorIdx = lines.findIndex((l) => /^⎯⎯⎯⎯⎯⎯ Failed Tests \d+ ⎯⎯⎯⎯⎯⎯/.test(l));

const listSection = separatorIdx >= 0 ? lines.slice(0, separatorIdx) : lines;
const detailSection = separatorIdx >= 0 ? lines.slice(separatorIdx) : [];

// ── 3. Parse the summary lines (they appear at the very end of the output) ──
const summaryLine = lines.find((l) => /^\s*Test Files\s/.test(l));
const testsLine = lines.find((l) => /^\s*Tests\s/.test(l));

function parseSummary(line) {
  if (!line) return {};
  const r = {};
  for (const m of line.matchAll(/(\d+)\s+(failed|passed|skipped|todo)/g)) {
    r[m[2]] = parseInt(m[1], 10);
  }
  return r;
}

const fileSummary = parseSummary(summaryLine);
const testSummary = parseSummary(testsLine);

// ── 4. Parse per-file counts from ✓/× lines ────────────────────────────────
// Format: " ✓ tests/foo.test.ts > Describe > test_name"
//         " × tests/foo.test.ts > Describe > test_name"
//         "   → error summary"

/** @type {Map<string, {fileTotal: number, filePassed: number, fileFailed: number,
 *    fileSkipped: number, tests: {name: string, errorLine: string}[]}>} */
const fileData = new Map();

function ensureFile(fname) {
  if (!fileData.has(fname)) {
    fileData.set(fname, { fileTotal: 0, filePassed: 0, fileFailed: 0, fileSkipped: 0, tests: [] });
  }
  return fileData.get(fname);
}

for (let i = 0; i < listSection.length; i++) {
  const line = listSection[i];

  // ✓ line = passed test
  const passMatch = line.match(/^\s*✓\s+(tests\/\S+\.test\.ts)\s*>\s*(.*)/);
  if (passMatch) {
    const fd = ensureFile(passMatch[1]);
    fd.filePassed++;
    fd.fileTotal++;
    continue;
  }

  // × line = failed test
  const failMatch = line.match(/^\s*×\s+(tests\/\S+\.test\.ts)\s*>\s*(.*)/);
  if (failMatch) {
    const fd = ensureFile(failMatch[1]);
    fd.fileFailed++;
    fd.fileTotal++;
    // Next line may be "  → error message"
    const nextLine = listSection[i + 1];
    const errorLine = nextLine?.match(/^\s*→\s*(.*)/)?.[1]?.trim() || "";
    fd.tests.push({ name: failMatch[2].trim(), errorLine });
    continue;
  }

  // ○ line = skipped test
  const skipMatch = line.match(/^\s*○\s+(tests\/\S+\.test\.ts)\s*>\s*(.*)/);
  if (skipMatch) {
    const fd = ensureFile(skipMatch[1]);
    fd.fileSkipped++;
    fd.fileTotal++;
    continue;
  }
}

// ── 5. Parse FAIL detail blocks (full diffs) ───────────────────────────────
// Format after the separator:
//   FAIL  tests/foo.test.ts > Describe > test_name
//   <error message and diff>
//   ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
//   Serialized Error: ...
//   ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[N/M]⎯

/** @type {Map<string, Map<string, string>>} */
const failDetails = new Map();

let curFile = null;
let curTest = null;
let detailBuf = [];

function flushDetail() {
  if (curFile && curTest && detailBuf.length) {
    if (!failDetails.has(curFile)) failDetails.set(curFile, new Map());
    failDetails.get(curFile).set(curTest, detailBuf.join("\n").trim());
  }
  detailBuf = [];
}

for (let i = 0; i < detailSection.length; i++) {
  const line = detailSection[i];

  const failMatch = line.match(/^\s*FAIL\s+(tests\/\S+\.test\.ts)\s*>\s*(.*)/);
  if (failMatch) {
    flushDetail();
    curFile = failMatch[1];
    curTest = failMatch[2].trim();
    detailBuf = [];
    continue;
  }

  // End-of-block separator
  if (/^⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯/.test(line)) {
    flushDetail();
    curFile = null;
    curTest = null;
    continue;
  }

  if (curFile && curTest) {
    detailBuf.push(line);
  }
}
flushDetail();

// ── 6. Sort files ──────────────────────────────────────────────────────────
const failingFiles = [...fileData.entries()]
  .filter(([, fd]) => fd.fileFailed > 0)
  .map(([f]) => f)
  .sort();

const passingFiles = [...fileData.entries()]
  .filter(([, fd]) => fd.fileFailed === 0 && fd.fileTotal > 0)
  .map(([f]) => f)
  .sort();

// ── 7. Generate markdown ───────────────────────────────────────────────────
console.log("Generating markdown reports …");

const totalFailed = testSummary.failed ?? 0;
const totalPassed = testSummary.passed ?? 0;
const totalSkipped = (testSummary.skipped ?? 0) + (testSummary.todo ?? 0);
const totalTests = totalFailed + totalPassed + totalSkipped;
const filesFailed = fileSummary.failed ?? 0;
const filesPassed = fileSummary.passed ?? 0;
const filesTotal = filesFailed + filesPassed + (fileSummary.skipped ?? 0);

// ── index.md ────────────────────────────────────────────────────────────────
let idx = `# Test Comparison Report\n\n`;
idx += `> Generated: ${new Date().toISOString()}\n\n`;
idx += `## Summary\n\n`;
idx += `| Metric | Count |\n`;
idx += `|--------|-------|\n`;
idx += `| Total test files | ${filesTotal} |\n`;
idx += `| Passed files | ${filesPassed} |\n`;
idx += `| Failed files | ${filesFailed} |\n`;
idx += `| Total tests | ${totalTests} |\n`;
idx += `| Passed tests | ${totalPassed} |\n`;
idx += `| Failed tests | ${totalFailed} |\n`;
idx += `| Skipped tests | ${totalSkipped} |\n`;
idx += `\n`;

// Failures-by-file table
idx += `## Failures by File\n\n`;
idx += `| File | Total | Passed | Failed | Skipped | Pass Rate |\n`;
idx += `|------|-------|--------|--------|---------|----------|\n`;
for (const fname of failingFiles) {
  const fd = fileData.get(fname);
  const short = fname.replace("tests/", "");
  const link = short.replace(".test.ts", ".md");
  const rate = fd.fileTotal > 0 ? ((fd.filePassed / fd.fileTotal) * 100).toFixed(1) + "%" : "—";
  idx += `| [${short}](./${link}) | ${fd.fileTotal} | ${fd.filePassed} | ${fd.fileFailed} | ${fd.fileSkipped} | ${rate} |\n`;
}
for (const fname of passingFiles) {
  const fd = fileData.get(fname);
  const short = fname.replace("tests/", "");
  idx += `| ${short} | ${fd.fileTotal} | ${fd.filePassed} | ${fd.fileFailed} | ${fd.fileSkipped} | 100% |\n`;
}
idx += `\n`;

// Error categories (from the one-line summaries)
idx += `## Failure Categories\n\n`;
const categories = new Map();
for (const fname of failingFiles) {
  const fd = fileData.get(fname);
  const short = fname.replace("tests/", "");
  for (const t of fd.tests) {
    const msg = t.errorLine || "Unknown error";
    let cat;
    if (msg.includes("AppError:")) {
      cat = msg.replace(/^AppError:\s*/, "").trim();
    } else if (msg.includes("AssertionError:") || msg.includes("AssertionError:")) {
      cat = msg.replace(/^Assertion(Error)?:\s*/, "").trim();
    } else if (msg.includes("TypeError:")) {
      cat = msg.replace(/^TypeError:\s*/, "").trim();
    } else if (msg.includes("expected") || msg.includes("deeply equal")) {
      cat = msg;
    } else {
      cat = msg;
    }
    if (cat.length > 120) cat = cat.slice(0, 117) + "…";
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(`${short} > ${t.name}`);
  }
}

const sortedCats = [...categories.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [cat, tests] of sortedCats) {
  idx += `### ${cat}\n\n`;
  idx += `**${tests.length} test(s)**\n\n`;
  for (const t of tests) {
    idx += `- \`${t}\`\n`;
  }
  idx += `\n`;
}

fs.writeFileSync(path.join(OUT_DIR, "index.md"), idx);
console.log("  → index.md");

// ── Per-file reports ────────────────────────────────────────────────────────
for (const fname of failingFiles) {
  const fd = fileData.get(fname);
  const short = fname.replace("tests/", "");
  const mdName = short.replace(".test.ts", ".md");

  let md = `# ${short}\n\n`;
  md += `## Stats\n\n`;
  md += `| Metric | Count |\n`;
  md += `|--------|-------|\n`;
  md += `| Total | ${fd.fileTotal} |\n`;
  md += `| Passed | ${fd.filePassed} |\n`;
  md += `| Failed | ${fd.fileFailed} |\n`;
  md += `| Skipped | ${fd.fileSkipped} |\n`;
  const rate = fd.fileTotal > 0 ? ((fd.filePassed / fd.fileTotal) * 100).toFixed(1) + "%" : "—";
  md += `| Pass Rate | ${rate} |\n`;
  md += `\n`;

  md += `## Failing Tests (${fd.tests.length})\n\n`;

  for (const t of fd.tests) {
    md += `### ${t.name}\n\n`;

    // Error summary line
    if (t.errorLine) {
      md += `> **${t.errorLine}**\n\n`;
    }

    // Full detail from the FAIL block
    const detail = failDetails.get(fname)?.get(t.name);
    if (detail) {
      md += "```\n" + detail + "\n```\n\n";
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, mdName), md);
  console.log(`  → ${mdName}`);
}

console.log(`\nDone! Reports in ${OUT_DIR}/`);
