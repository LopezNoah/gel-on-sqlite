import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const tests = fileURLToPath(new URL("../tests/", import.meta.url));
const helpers = new Set(["assertQueryResult", "queryRows", "querySingle"]);

export interface SuiteQuery {
  file: string;
  query: string;
}

export function extractSuiteQueries(): { queries: SuiteQuery[]; skippedInterpolated: number } {
  const queries: SuiteQuery[] = [];
  let skippedInterpolated = 0;
  for (const file of readdirSync(tests).filter((name) => /^edgeql_.*\.test\.ts$/.test(name))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(tests, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : "";
        if (helpers.has(callee) && node.arguments.length >= 2) {
          const queryArg = node.arguments[1];
          if (ts.isNoSubstitutionTemplateLiteral(queryArg) || ts.isStringLiteral(queryArg)) {
            queries.push({ file, query: queryArg.text.trim() });
          } else if (ts.isTemplateExpression(queryArg)) {
            skippedInterpolated++;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { queries, skippedInterpolated };
}
