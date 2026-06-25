import { describe, expect, it } from "vitest";

import { lowerStdlibFunctionSql } from "../src/sql/stdlib_lowering.js";

// On D1 / Durable Objects (target "d1", no custom functions) the domain-checked
// math functions lower to native SQLite math; on the better-sqlite3 target
// ("sqlite") they keep the `_gel_*` form that enforces Gel's exact domain-error
// semantics for the conformance suite.
describe("native math lowering for custom-function-less targets", () => {
  const cases: Array<{ fn: string; args: string[]; d1: string; sqlite: string }> = [
    { fn: "math::sin", args: ["x"], d1: "sin(x)", sqlite: "_gel_sin(x)" },
    { fn: "math::cos", args: ["x"], d1: "cos(x)", sqlite: "_gel_cos(x)" },
    { fn: "math::tan", args: ["x"], d1: "tan(x)", sqlite: "_gel_tan(x)" },
    { fn: "math::acos", args: ["x"], d1: "acos(x)", sqlite: "_gel_acos(x)" },
    { fn: "math::asin", args: ["x"], d1: "asin(x)", sqlite: "_gel_asin(x)" },
    { fn: "math::ln", args: ["x"], d1: "ln(x)", sqlite: "_gel_ln(x)" },
    { fn: "math::lg", args: ["x"], d1: "log(x)", sqlite: "_gel_lg(x)" },
    { fn: "math::log", args: ["x", "b"], d1: "log(b, x)", sqlite: "_gel_log(x, b)" },
    { fn: "math::exp", args: ["x"], d1: "exp(x)", sqlite: "_gel_exp(x)" },
    { fn: "math::sqrt", args: ["x"], d1: "sqrt(x)", sqlite: "_gel_sqrt(x)" },
    { fn: "math::cot", args: ["x"], d1: "(1.0 / tan(x))", sqlite: "_gel_cot(x)" },
  ];

  for (const { fn, args, d1, sqlite } of cases) {
    it(`${fn}: d1 → native, sqlite → _gel_`, () => {
      expect(lowerStdlibFunctionSql("d1", fn, args)).toBe(d1);
      expect(lowerStdlibFunctionSql("sqlite", fn, args)).toBe(sqlite);
    });
  }

  it("functions already native (abs/ceil/atan) are unchanged on both targets", () => {
    for (const fn of ["math::abs", "math::ceil", "math::atan"]) {
      const native = lowerStdlibFunctionSql("sqlite", fn, ["x"]);
      expect(native).not.toContain("_gel_");
      expect(lowerStdlibFunctionSql("d1", fn, ["x"])).toBe(native);
    }
  });

  it("std::round → native round on d1 (1- and 2-arg), _gel_round on sqlite", () => {
    expect(lowerStdlibFunctionSql("d1", "std::round", ["x"])).toBe("round(x)");
    expect(lowerStdlibFunctionSql("d1", "std::round", ["x", "2"])).toBe("round(x, 2)");
    expect(lowerStdlibFunctionSql("sqlite", "std::round", ["x"])).toContain("_gel_round");
  });

  it("datetime extractors + truncate → native strftime on d1, _gel_* on sqlite", () => {
    for (const fn of ["std::datetime_get", "cal::date_get", "cal::time_get", "std::datetime_truncate"]) {
      const d1 = lowerStdlibFunctionSql("d1", fn, ["dt", "'year'"]) ?? "";
      expect(d1).toContain("strftime");
      expect(d1).not.toContain("_gel_");
      expect(lowerStdlibFunctionSql("sqlite", fn, ["dt", "'year'"])).toContain("_gel_");
    }
  });

  it("bit_xor/lshift/rshift → native on d1, _gel_* on sqlite (bit_count stays _gel_)", () => {
    expect(lowerStdlibFunctionSql("d1", "std::bit_xor", ["a", "b"])).toContain("(x | y) - (x & y)");
    expect(lowerStdlibFunctionSql("d1", "std::bit_lshift", ["a", "b"])).toBe("(a << b)");
    expect(lowerStdlibFunctionSql("d1", "std::bit_rshift", ["a", "b"])).toBe("(a >> b)");
    for (const fn of ["std::bit_xor", "std::bit_lshift", "std::bit_rshift"]) {
      expect(lowerStdlibFunctionSql("sqlite", fn, ["a", "b"])).toContain("_gel_");
    }
    // bit_count has no native popcount → _gel_ on both.
    expect(lowerStdlibFunctionSql("d1", "std::bit_count", ["a"])).toContain("_gel_");
  });
});
