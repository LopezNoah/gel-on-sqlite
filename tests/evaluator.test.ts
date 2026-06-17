import { describe, expect, it } from "vitest";
import { openSQLite } from "../src/runtime/database.js";
import { loadSchema } from "../src/schema/load.js";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { runSelectExprEvaluation } from "../src/runtime/evaluator.js";
import type { SelectExprEvaluatorDeps } from "../src/runtime/engine.js";
import type { SecurityContext } from "../src/runtime/engine.js";
import type { Statement } from "../src/edgeql/ast.js";

// The Runtime evaluator used to be a closure buried in engine.ts, reachable
// only end-to-end through executeQuery. Now it is `runSelectExprEvaluation`
// with an explicit `SelectExprEvaluatorDeps` seam, so it can be driven directly
// — these tests cross that one interface. See docs/adr/0044.

const schema = loadSchema(`module default {
  type User {
    required name: str;
  }
}`, { legacySyntaxCompat: true });

const ctx: SecurityContext = {};

// All 16 engine capabilities the evaluator can reach back into, stubbed to
// throw. A free-object / literal / set evaluation must touch none of them —
// the interpreter's own cases (literal, set_literal, free_object_constructor,
// math) are self-contained. If a future change makes such a query call into
// the engine, this surfaces it loudly instead of silently.
const throwingDeps = (): SelectExprEvaluatorDeps => {
  const trap = (name: string) => () => {
    throw new Error(`evaluator unexpectedly called engine dep: ${name}`);
  };
  return {
    evaluateRuntimeAggregate: trap("evaluateRuntimeAggregate"),
    executeFunctionCall: trap("executeFunctionCall"),
    executeMutationBinding: trap("executeMutationBinding"),
    findFieldDef: trap("findFieldDef"),
    findRuntimeLinkDef: trap("findRuntimeLinkDef"),
    inferStaticArgType: trap("inferStaticArgType"),
    likeMatch: trap("likeMatch"),
    materializeFieldValue: trap("materializeFieldValue"),
    normalizeRuntimeFloat: trap("normalizeRuntimeFloat"),
    qualifiedRuntimeAliasName: trap("qualifiedRuntimeAliasName"),
    qualifyRuntimeTypeName: trap("qualifyRuntimeTypeName"),
    quoteIdent: trap("quoteIdent"),
    readRuntimeTypedAliasSourceRows: trap("readRuntimeTypedAliasSourceRows"),
    resolveBacklinkRowsForSubject: trap("resolveBacklinkRowsForSubject"),
    resolveUserFunctionOverload: trap("resolveUserFunctionOverload"),
    runtimeAliasPredicateMatches: trap("runtimeAliasPredicateMatches"),
  } as unknown as SelectExprEvaluatorDeps;
};

const selectExpr = (query: string): Extract<Statement, { kind: "select_expr" }> => {
  const stmt = parseEdgeQL(query);
  if (stmt.kind !== "select_expr") {
    throw new Error(`expected select_expr, got ${stmt.kind}`);
  }
  return stmt;
};

describe("runSelectExprEvaluation — direct seam", () => {
  it("evaluates a FOR iteration in isolation, calling no engine deps", () => {
    const { db } = openSQLite(":memory:");
    // A select_expr wrapping FOR needs the runtime; iterating a literal set and
    // yielding the binding touches only the interpreter's own cases.
    const ast = selectExpr("SELECT (FOR x IN {1, 2, 3} UNION (x))");
    const result = runSelectExprEvaluation(db, schema, ast, ctx, throwingDeps());
    expect(result?.kind).toBe("select");
    const flat = (result?.rows ?? []).flat();
    expect(flat).toEqual([1, 2, 3]);
  });

  it("returns undefined for a select_expr the SQL path owns (the routing gate)", () => {
    const { db } = openSQLite(":memory:");
    // A bare scalar select needs no runtime evaluation, so the evaluator
    // declines (selectExprNeedsRuntime === false) and the engine runs SQL.
    const ast = selectExpr("SELECT 1 + 1");
    const result = runSelectExprEvaluation(db, schema, ast, ctx, throwingDeps());
    expect(result).toBeUndefined();
  });
});
