import { describe, expect, it } from "vitest";
import { bindOperandsOnce } from "../src/sql/sql_fragment.js";

// First-party tests for the param-ownership seam (src/sql/sql_fragment.ts,
// ADR 0058). bindOperandsOnce is what makes "reference an operand more than
// once" safe under the shared-mutated-params convention: each operand's SQL
// (whose `?` params were pushed exactly once at compile time) is emitted once,
// bound to an alias, and the body refers to the alias — so the `?` count never
// diverges from the pushed-param count ("too many"/"too few parameter values").

describe("bindOperandsOnce", () => {
  it("binds a single operand once and references it by alias in the body", () => {
    expect(bindOperandsOnce([{ alias: "p", sql: "?" }], "CASE WHEN p IS NULL THEN 0 ELSE 1 END")).toBe(
      "(SELECT CASE WHEN p IS NULL THEN 0 ELSE 1 END FROM (SELECT (?) AS p))",
    );
  });

  it("binds multiple operands once each, preserving order", () => {
    expect(
      bindOperandsOnce([{ alias: "l", sql: "?" }, { alias: "r", sql: "?" }], "l = r"),
    ).toBe("(SELECT l = r FROM (SELECT (?) AS l, (?) AS r))");
  });

  // The whole point: an operand referenced N times in the body still contributes
  // exactly ONE `?` to the emitted SQL — matching the single param pushed for it.
  it("keeps the `?` count equal to the operand count no matter how often the body uses an alias", () => {
    const sql = bindOperandsOnce(
      [{ alias: "b", sql: "?" }],
      "substr(b, 1, length(b)) || substr(b, 1, length(b))", // alias `b` used 4×
    );
    const placeholderCount = (sql.match(/\?/g) ?? []).length;
    expect(placeholderCount).toBe(1); // one operand → one `?`, not four
  });

  it("inlining the operand SQL directly (the bug it prevents) would double-count its `?`", () => {
    // Demonstrates the failure mode bindOperandsOnce avoids: splicing the raw
    // operand SQL into a body that references it twice yields two `?` for one
    // pushed param ("too few parameter values").
    const naive = `${"?"} = ${"?"}`; // a single operand inlined twice
    expect((naive.match(/\?/g) ?? []).length).toBe(2);
    const safe = bindOperandsOnce([{ alias: "x", sql: "?" }], "x = x");
    expect((safe.match(/\?/g) ?? []).length).toBe(1);
  });

  it("wraps a multi-character operand expression in parens before aliasing", () => {
    expect(bindOperandsOnce([{ alias: "v", sql: "a0.col + ?" }], "v")).toBe(
      "(SELECT v FROM (SELECT (a0.col + ?) AS v))",
    );
  });
});
