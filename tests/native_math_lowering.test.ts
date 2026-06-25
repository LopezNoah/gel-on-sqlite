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
});
