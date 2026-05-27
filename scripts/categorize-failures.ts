// Classify every failing test by which Unsupported categories its body
// touches. Reads vitest output from --reporter=verbose and the test files
// under tests/. Prints the breakdown, focusing on tests that touch NONE
// of the known architectural patterns — those are the "tractable" failures.
import fs from "node:fs";
import path from "node:path";
import { categorizeUnsupportedQuery, type UnsupportedCategory } from "../src/diagnostics/unsupported.js";

const outputPath = process.argv[2] ?? "/tmp/after_tag2.txt";
const text = fs.readFileSync(outputPath, "utf8");

interface Failing {
  file: string;
  testName: string;
  body: string;
  categories: UnsupportedCategory[];
}

const fileBodies = new Map<string, string>();
const loadFile = (p: string): string => {
  const cached = fileBodies.get(p);
  if (cached !== undefined) return cached;
  const body = fs.readFileSync(p, "utf8");
  fileBodies.set(p, body);
  return body;
};

const extractTestBody = (fileBody: string, testName: string): string => {
  const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`it(?:\\.[a-z]+)?\\s*\\(\\s*["'\`]${escapedName}["'\`]`, "m");
  const m = re.exec(fileBody);
  if (!m) return "";
  const start = m.index;
  // Take ~80 lines or until next top-level `it(`.
  const slice = fileBody.slice(start, start + 8000);
  const nextIt = slice.slice(60).search(/\n\s{0,4}it(?:\.[a-z]+)?\s*\(/);
  return nextIt > 0 ? slice.slice(0, nextIt + 60) : slice;
};

const failing: Failing[] = [];
const failureLineRe = /^\s*×\s+(tests\/[^\s]+\.test\.ts)\s*>\s*[^>]+>\s*(.+?)(?:\s+\d+ms)?$/gm;
let mm: RegExpExecArray | null;
while ((mm = failureLineRe.exec(text)) !== null) {
  const [, file, testName] = mm;
  try {
    const fp = path.resolve(process.cwd(), file);
    const fb = loadFile(fp);
    const body = extractTestBody(fb, testName);
    const cats = categorizeUnsupportedQuery(body);
    failing.push({ file, testName, body, categories: cats });
  } catch {
    /* skip */
  }
}

const byCategory = new Map<string, number>();
const untouched: Failing[] = [];
for (const f of failing) {
  if (f.categories.length === 0) {
    untouched.push(f);
    continue;
  }
  for (const c of f.categories) {
    byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
  }
}

console.log(`Total failing tests examined: ${failing.length}`);
console.log(`\nTests touching at least one Unsupported category:`);
const sortedCats = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
for (const [c, n] of sortedCats) {
  console.log(`  ${c.padEnd(20)} ${n}`);
}
console.log(`\nTests touching NO Unsupported category: ${untouched.length}`);

const byFile = new Map<string, number>();
for (const f of untouched) {
  byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
}
console.log(`\nUntouched failures by file:`);
for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${file.padEnd(50)} ${n}`);
}

// Show sample test names per file (the "clean" failures we want to chip
// away at).
console.log(`\nSample untouched failures per top file (10 each):`);
const samplesByFile = new Map<string, string[]>();
for (const f of untouched) {
  const arr = samplesByFile.get(f.file) ?? [];
  if (arr.length < 10) arr.push(f.testName);
  samplesByFile.set(f.file, arr);
}
for (const [file, names] of [...samplesByFile.entries()].sort((a, b) => (byFile.get(b[0])! - byFile.get(a[0])!)).slice(0, 8)) {
  console.log(`\n  ${file} (${byFile.get(file)}):`);
  for (const n of names) console.log(`    ${n}`);
}
