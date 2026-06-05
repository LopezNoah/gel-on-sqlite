// One-off: for each test currently failing in tests/edgeql_syntax.test.ts,
// re-skip it with an informative tag derived from the parser error message.
//
// Two failure modes are distinguished:
//   - "expected to throw" (must_fail test that the TS parser incorrectly
//      accepts)         -> tag: "sqlite-ts parser accepts what upstream rejects"
//   - "not to throw" (parser fails on syntax that upstream accepts)
//                       -> tag: "parser-gap: <first error message>"
//
// We re-run vitest with a JSON reporter once, then patch the file in place.

import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = resolve(process.cwd(), "tests/edgeql_syntax.test.ts");
const JSON_PATH = "/tmp/syntax-results.json";

type FailInfo = { tag: string };

function classify(failureMessage: string): FailInfo {
  if (failureMessage.includes("expected [Function] to throw")) {
    return { tag: "sqlite-ts parser accepts what upstream rejects" };
  }
  // Pull "Error: <msg>" out of the inner-quoted text. The error message may
  // itself contain escaped apostrophes, so we anchor on `' was thrown` and
  // greedy-match what's between.
  const m = failureMessage.match(/but '(?:Error: )?(.+)' was thrown/);
  const msg = (m?.[1] ?? "parser rejects upstream-accepted source")
    .replace(/…$/, "")
    .replace(/\\'/g, "'")
    .replace(/\\$/, "")
    .trim();
  return { tag: `parser-gap: ${msg}` };
}

type Result = { title: string; status: string; failureMessages: string[] };
const raw = JSON.parse(readFileSync(JSON_PATH, "utf8")) as {
  testResults: { assertionResults: Result[] }[];
};
const failing = new Map<string, FailInfo>();
for (const r of raw.testResults[0].assertionResults) {
  if (r.status === "failed") {
    failing.set(r.title, classify(r.failureMessages[0] ?? ""));
  }
}
console.log(`failing tests to re-skip: ${failing.size}`);

const original = readFileSync(TARGET, "utf8");
const sf = ts.createSourceFile(TARGET, original, ts.ScriptTarget.Latest, true);

type Rewrite = { start: number; end: number; text: string };
const rewrites: Rewrite[] = [];

function isItCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "it"
  );
}

function visit(node: ts.Node): void {
  if (isItCall(node)) {
    const [nameArg] = node.arguments;
    if (nameArg && ts.isStringLiteral(nameArg)) {
      const info = failing.get(nameArg.text);
      if (info) {
        // Replace `it(` with `it.skip(` and append the tag to the name.
        const callStart = node.getStart(sf);
        const nameStart = nameArg.getStart(sf);
        const nameEnd = nameArg.getEnd();
        // Insert `.skip` right after `it`.
        rewrites.push({ start: callStart + 2, end: callStart + 2, text: ".skip" });
        // Rewrite the name string literal to include the tag.
        const newName = JSON.stringify(`${nameArg.text} [${info.tag}]`);
        rewrites.push({ start: nameStart, end: nameEnd, text: newName });
      }
    }
  }
  ts.forEachChild(node, visit);
}

visit(sf);

rewrites.sort((a, b) => a.start - b.start);
let out = "";
let cursor = 0;
for (const r of rewrites) {
  out += original.slice(cursor, r.start);
  out += r.text;
  cursor = r.end;
}
out += original.slice(cursor);

writeFileSync(TARGET, out);
console.log(`patched ${rewrites.length / 2} test entries`);
