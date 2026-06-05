// One-off: rewrite `it.skip("... [unconverted: EdgeQL codegen / source round-trip not implemented]", ...)`
// blocks in tests/edgeql_syntax.test.ts into active parse-only assertions:
//   it("name", () => { expect(() => tryParse(SOURCE)).not.toThrow(); })
//
// Leaves the 12 "parser accepts what upstream rejects" and 3 "context-sensitive"
// skips alone, since their original Python form was a must_fail (parser-error)
// test — turning them into not.toThrow() would lock in a known-buggy acceptance.

import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = resolve(process.cwd(), "tests/edgeql_syntax.test.ts");
const TAG = "[unconverted: EdgeQL codegen / source round-trip not implemented]";

const original = readFileSync(TARGET, "utf8");
const sf = ts.createSourceFile(TARGET, original, ts.ScriptTarget.Latest, true);

type Rewrite = { start: number; end: number; text: string };
const rewrites: Rewrite[] = [];

function isItSkipCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const e = node.expression;
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "it" &&
    e.name.text === "skip"
  );
}

function findSourceTemplate(body: ts.Block): ts.Expression | null {
  for (const stmt of body.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === "_source" && decl.initializer) {
        return decl.initializer;
      }
    }
  }
  return null;
}

function visit(node: ts.Node): void {
  if (isItSkipCall(node)) {
    const [nameArg, fnArg] = node.arguments;
    if (
      nameArg &&
      ts.isStringLiteral(nameArg) &&
      nameArg.text.includes(TAG) &&
      fnArg &&
      ts.isArrowFunction(fnArg) &&
      ts.isBlock(fnArg.body)
    ) {
      const cleanName = nameArg.text.replace(` ${TAG}`, "").trim();
      const srcExpr = findSourceTemplate(fnArg.body);
      if (srcExpr) {
        const srcText = original.slice(srcExpr.getStart(sf), srcExpr.getEnd());
        const indent = " ".repeat(node.getStart(sf) - node.getStart(sf) + 2); // 2 spaces inside it()
        const callStart = node.getStart(sf);
        const callEnd = node.getEnd();
        const outer = " ".repeat(callStart - sf.getLineStarts()[sf.getLineAndCharacterOfPosition(callStart).line]);
        const inner = outer + "  ";
        const newText =
          `it(${JSON.stringify(cleanName)}, () => {\n` +
          `${inner}expect(() => tryParse(${srcText})).not.toThrow();\n` +
          `${outer}})`;
        rewrites.push({ start: callStart, end: callEnd, text: newText });
        void indent;
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
console.log(`rewrote ${rewrites.length} skipped tests in ${TARGET}`);
