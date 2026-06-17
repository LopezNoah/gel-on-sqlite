import { describe, expect, it } from "vitest";
import { AppError, tryProbe } from "../src/errors.js";

describe("tryProbe", () => {
  it("returns the value on success", () => {
    expect(tryProbe(() => 42)).toBe(42);
  });

  it("falls back to undefined on a query failure (E_UNSUPPORTED / E_SEMANTIC / …)", () => {
    expect(tryProbe(() => { throw new AppError("E_UNSUPPORTED", "not lowerable"); })).toBeUndefined();
    expect(tryProbe(() => { throw new AppError("E_SEMANTIC", "unknown type"); })).toBeUndefined();
  });

  it("rethrows engine defects instead of swallowing them", () => {
    expect(() => tryProbe(() => { throw new TypeError("cannot read 'x' of undefined"); })).toThrow(TypeError);
  });

  it("rethrows non-query AppErrors (E_RUNTIME / E_SQL are real failures, not 'try another path')", () => {
    expect(() => tryProbe(() => { throw new AppError("E_RUNTIME", "boom"); })).toThrow(AppError);
  });
});
