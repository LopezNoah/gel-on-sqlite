import { describe, expect, it } from "vitest";
import {
  STDLIB_FUNCTIONS,
  getStdlibEntry,
  getStdlibSqlTemplate,
  executeStdlibFunction,
  resolveStdlibFunction,
  tryResolveStdlibFunction,
  stdlibFunctionLowersToSql,
} from "../src/stdlib/registry.js";

// The registry is the single home for the standard library: each function is
// described once, with up to three slots (meta / sql / runtime). These tests
// are its interface — they pin the unification so the SQL and runtime adapters
// can't silently drift apart again. See docs/adr/0043.

describe("stdlib registry — structure", () => {
  it("has a unique name per entry", () => {
    const names = STDLIB_FUNCTIONS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry carries at least one slot", () => {
    for (const entry of STDLIB_FUNCTIONS) {
      expect(Boolean(entry.meta || entry.sql || entry.runtime)).toBe(true);
    }
  });

  it("every name is module-qualified", () => {
    for (const entry of STDLIB_FUNCTIONS) {
      expect(entry.name).toMatch(/^(std|math|cal)::/);
    }
  });

  it("meta arities are well-formed", () => {
    for (const entry of STDLIB_FUNCTIONS) {
      if (!entry.meta) continue;
      expect(entry.meta.minArgs).toBeLessThanOrEqual(entry.meta.maxArgs);
      expect(entry.meta.minArgs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("stdlib registry — SQL lowerability is the sql slot", () => {
  it("lowersToSql iff a sql slot exists", () => {
    for (const entry of STDLIB_FUNCTIONS) {
      expect(stdlibFunctionLowersToSql(entry.name)).toBe(Boolean(entry.sql));
    }
  });

  // The exact set the old BASE_SQL_NATIVE_STDLIB_LOWERING gate (+ the
  // UNREGISTERED_BUT_SUPPORTED patch-set) allowed. Pinning it guards against
  // accidentally dropping or adding a SQL-lowerable function during the merge.
  it("matches the historical SQL-lowerable set", () => {
    const expected = [
      "math::abs", "math::ceil", "math::floor", "math::exp", "math::sqrt",
      "math::ln", "math::lg", "math::log", "math::pi", "math::e",
      "math::acos", "math::asin", "math::atan", "math::atan2", "math::cos",
      "math::cot", "math::sin", "math::tan",
      "std::assert", "std::assert_single", "std::assert_exists",
      "std::array_fill", "std::array_set", "std::array_insert", "std::duration_get",
      "std::datetime_current", "std::datetime_of_transaction", "std::datetime_of_statement",
      "std::to_str", "std::to_json", "std::json_get", "std::len", "std::count",
      "std::max", "std::min", "std::str_lower", "std::str_upper", "std::str_title",
      "std::str_trim", "std::str_trim_start", "std::str_trim_end", "std::str_ltrim", "std::str_rtrim",
      "std::str_pad_start", "std::str_pad_end", "std::str_lpad", "std::str_rpad", "std::str_repeat",
      "std::str_reverse", "std::str_split", "std::str_replace", "std::array_replace",
      "std::to_int16", "std::to_int32", "std::to_int64", "std::to_float32",
      "std::to_float64", "std::to_bigint", "std::to_decimal",
      "std::to_datetime", "cal::to_local_datetime", "cal::to_local_date", "cal::to_local_time",
      "cal::duration_normalize_hours", "cal::duration_normalize_days",
      "std::overlaps", "std::adjacent", "std::strictly_below", "std::strictly_above",
      "std::bounded_above", "std::bounded_below", "std::range_is_empty",
      "std::range_is_inclusive_lower", "std::range_is_inclusive_upper",
      "std::range_get_lower", "std::range_get_upper", "std::multirange",
      "std::datetime_get", "std::datetime_truncate", "std::round", "std::find",
      "std::contains", "std::array_join", "std::random",
      "std::uuid_generate_v1mc", "std::uuid_generate_v4", "std::array_get",
      "std::bit_and", "std::bit_or", "std::bit_xor", "std::bit_not",
      "std::bit_lshift", "std::bit_rshift", "std::bit_count",
      // template names the old gate forgot (the UNREGISTERED_BUT_SUPPORTED patch)
      "cal::time_get", "cal::date_get", "std::duration_truncate",
      "std::duration_to_seconds", "std::re_test", "std::re_match", "std::re_replace",
    ].sort();
    const actual = STDLIB_FUNCTIONS.filter((e) => e.sql).map((e) => e.name).sort();
    expect(actual).toEqual(expected);
  });

  it("a sql template renders for a representative function", () => {
    const tmpl = getStdlibSqlTemplate("std::str_upper");
    expect(tmpl?.(["x"])).toBe("_gel_str_upper(x)");
    expect(getStdlibSqlTemplate("std::array_unpack")).toBeUndefined(); // runtime-only
  });
});

describe("stdlib registry — metadata resolution", () => {
  it("arity-gates resolveStdlibFunction", () => {
    expect(resolveStdlibFunction("std::array_get", 2)?.name).toBe("std::array_get");
    expect(resolveStdlibFunction("std::array_get", 1)).toBeUndefined();
    expect(resolveStdlibFunction("std::array_get", 4)).toBeUndefined();
  });

  it("carries inference facts through resolution", () => {
    expect(resolveStdlibFunction("std::array_get", 2)?.returnOptional).toBe(true);
    expect(resolveStdlibFunction("std::random", 0)?.volatility).toBe("volatile");
  });

  it("does not resolve sql-only functions (no meta slot)", () => {
    expect(getStdlibEntry("std::bit_and")?.sql).toBeDefined();
    expect(resolveStdlibFunction("std::bit_and", 2)).toBeUndefined();
  });

  it("tryResolve falls back across std/math/cal modules", () => {
    expect(tryResolveStdlibFunction("abs", 1, "default")?.name).toBe("math::abs");
    expect(tryResolveStdlibFunction("default::len", 1, "default")?.name).toBe("std::len");
  });
});

describe("stdlib registry — runtime dispatch", () => {
  it("evaluates a representative scalar function", () => {
    expect(executeStdlibFunction("math::abs", [-3])).toBe(3);
    expect(executeStdlibFunction("std::str_upper", ["abc"])).toBe("ABC");
  });

  it("shares the unpack body across range_unpack and array_unpack", () => {
    expect(executeStdlibFunction("std::array_unpack", [{ kind: "array", values: [1, 2] }])).toEqual([1, 2]);
    expect(executeStdlibFunction("std::range_unpack", [{ kind: "array", values: [1, 2] }])).toEqual([1, 2]);
  });

  it("returns undefined for an unknown or sql-only function", () => {
    expect(executeStdlibFunction("std::not_a_function", [])).toBeUndefined();
    expect(executeStdlibFunction("std::bit_and", [1, 2])).toBeUndefined();
  });
});
