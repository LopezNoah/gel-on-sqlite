import { describe, expect, it } from "vitest";

import { assertTargetSqlCompatibility, canLowerStdlibFunctionToSql } from "../src/runtime/target.js";

describe("runtime target SQL compatibility", () => {
  it("allows D1-allowed SQLite functions", () => {
    expect(() => assertTargetSqlCompatibility("SELECT abs(-1), sqrt(9), json_extract('{\"a\":1}', '$.a');", "d1")).not.toThrow();
  });

  it("rejects SQL functions not in D1 allowlist", () => {
    expect(() => assertTargetSqlCompatibility("SELECT made_up_fn(1);", "d1")).toThrow(
      /not allowed by D1: made_up_fn/,
    );
  });

  it("does not treat SQL keywords as function calls", () => {
    expect(() => assertTargetSqlCompatibility("INSERT INTO t (id) VALUES (1);", "d1")).not.toThrow();
  });

  it("reports sql-native stdlib lowering capabilities by target", () => {
    expect(canLowerStdlibFunctionToSql("sqlite", "math::abs")).toBe(true);
    expect(canLowerStdlibFunctionToSql("d1", "std::to_str")).toBe(true);
    expect(canLowerStdlibFunctionToSql("d1", "math::mean")).toBe(false);
  });
});
