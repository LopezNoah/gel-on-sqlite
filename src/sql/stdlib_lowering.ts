import { canLowerStdlibFunctionToSql, type RuntimeTarget } from "../runtime/target.js";

export type StdlibSqlTemplate = (args: string[], argTypes?: (string | undefined)[]) => string | null;

// EdgeQL's bit_* family is overloaded per integer type and wraps results to
// the operand's width. The width comes from the first argument's static type
// hint; unknown/unresolved types default to 64-bit (the int64 overload).
const bitWidthOf = (typeHint: string | undefined): number => {
  if (typeHint && typeHint.endsWith("int16")) return 16;
  if (typeHint && typeHint.endsWith("int32")) return 32;
  return 64;
};

const STDLIB_SQL_TEMPLATES = new Map<string, StdlibSqlTemplate>([
  ["math::abs", (argSql) => argSql[0] ? `abs(${argSql[0]})` : null],
  ["math::ceil", (argSql) => argSql[0] ? `ceil(${argSql[0]})` : null],
  ["math::floor", (argSql) => argSql[0] ? `floor(${argSql[0]})` : null],
  ["math::exp", (argSql) => argSql[0] ? `_gel_exp(${argSql[0]})` : null],
  ["math::sqrt", (argSql) => argSql[0] ? `_gel_sqrt(${argSql[0]})` : null],
  ["math::ln", (argSql) => argSql[0] ? `_gel_ln(${argSql[0]})` : null],
  ["math::lg", (argSql) => argSql[0] ? `_gel_lg(${argSql[0]})` : null],
  ["math::log", (argSql) => argSql[0] && argSql[1] ? `_gel_log(${argSql[0]}, ${argSql[1]})` : null],
  ["math::pi", () => "pi()"],
  ["math::e", () => "exp(1.0)"],
  // `std::assert(cond)` / `std::assert(cond, message := …)` — route through
  // the `_gel_assert` custom function so falsy conditions raise an error
  // instead of returning NULL through the SQL fallback.
  ["std::assert", (argSql) => {
    if (!argSql[0]) return null;
    if (argSql[1]) return `_gel_assert(${argSql[0]}, ${argSql[1]})`;
    return `_gel_assert(${argSql[0]})`;
  }],
  ["std::assert_single", (argSql) => {
    if (!argSql[0]) return null;
    if (argSql[1]) return `_gel_assert_single(${argSql[0]}, ${argSql[1]})`;
    return `_gel_assert_single(${argSql[0]})`;
  }],
  ["std::assert_exists", (argSql) => argSql[0] ? `_gel_assert_exists(${argSql[0]})` : null],
  // `re_test(pattern, str)` / `re_match(pattern, str)` / `re_replace(...)` —
  // SQLite has no built-in REGEXP, so we lower to the JS-backed `_gel_re_*`
  // SQLite functions registered in openSQLite().
  ["std::re_test", (argSql) => argSql[0] && argSql[1]
    ? `(_gel_re_test(${argSql[0]}, ${argSql[1]}) = 1)`
    : null],
  ["std::re_match", (argSql) => argSql[0] && argSql[1]
    ? `_gel_re_match_first(${argSql[0]}, ${argSql[1]})`
    : null],
  ["std::re_replace", (argSql) => {
    if (!argSql[0] || !argSql[1] || !argSql[2]) return null;
    if (argSql[3]) return `_gel_re_replace(${argSql[0]}, ${argSql[1]}, ${argSql[2]}, ${argSql[3]})`;
    return `_gel_re_replace(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`;
  }],
  ["std::array_set", (argSql) => argSql[0] && argSql[1] && argSql[2]
    ? `_gel_array_set(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`
    : null],
  ["std::array_insert", (argSql) => argSql[0] && argSql[1] && argSql[2]
    ? `_gel_array_insert(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`
    : null],
  ["std::duration_get", (argSql) => argSql[0] && argSql[1]
    ? `_gel_duration_get(${argSql[0]}, ${argSql[1]})`
    : null],
  // Trig functions use the `_gel_*` custom SQLite functions registered in
  // openSQLite() — those wrappers raise "input is out of range" for inputs
  // SQLite's built-in trig would silently return NULL / Infinity for.
  ["math::acos", (argSql) => argSql[0] ? `_gel_acos(${argSql[0]})` : null],
  ["math::asin", (argSql) => argSql[0] ? `_gel_asin(${argSql[0]})` : null],
  ["math::atan", (argSql) => argSql[0] ? `atan(${argSql[0]})` : null],
  ["math::atan2", (argSql) => argSql[0] && argSql[1] ? `atan2(${argSql[0]}, ${argSql[1]})` : null],
  ["math::cos", (argSql) => argSql[0] ? `_gel_cos(${argSql[0]})` : null],
  ["math::cot", (argSql) => argSql[0] ? `_gel_cot(${argSql[0]})` : null],
  ["math::sin", (argSql) => argSql[0] ? `_gel_sin(${argSql[0]})` : null],
  ["math::tan", (argSql) => argSql[0] ? `_gel_tan(${argSql[0]})` : null],
  // `std::random()` — float in [0, 1). SQLite's `random()` returns a
  // signed 64-bit integer; shift+normalise to the [0, 1) range. Use
  // `random() / 9223372036854775808.0` (max abs value + 1) which yields
  // values in (-1, 1), then halve+shift to [0, 1).
  ["std::random", () => "((CAST(random() AS REAL) / 18446744073709551616.0) + 0.5)"],
  // `std::array_get(arr, idx [, default])` — returns the element at `idx`,
  // or `default` (or empty set / NULL) when out of range. Negative indices
  // count from the end. SQLite's json_extract returns NULL for invalid
  // paths, which serializes back as `{}` and matches the EdgeQL empty-set
  // expectation in our test harness.
  ["std::array_get", (argSql) => {
    if (!argSql[0] || !argSql[1]) return null;
    // Bind the array and index once each in a correlated subquery: the
    // negative-index branch reuses the array, and re-emitting an argument that
    // carries `?` placeholders would bind too few params. Keep the projection
    // order (array, index, default) identical to the push order so positional
    // params still line up.
    const inner = `SELECT ${argSql[0]} AS a, ${argSql[1]} AS i${argSql[2] ? `, ${argSql[2]} AS d` : ""}`;
    const idx = `CASE WHEN i < 0 THEN json_array_length(a) + i ELSE i END`;
    const lookup = `json_extract(a, '$[' || (${idx}) || ']')`;
    const body = argSql[2] ? `IFNULL(${lookup}, d)` : lookup;
    return `(SELECT ${body} FROM (${inner}))`;
  }],
  // Bitwise functions. AND/OR/NOT sign-extend cleanly from any width to
  // 64-bit (the ops are homomorphic under sign extension), so SQLite's
  // native operators suffice. XOR has no SQLite operator and the shifts /
  // popcount are width-sensitive — those go through `_gel_bit_*` UDFs.
  ["std::bit_and", (argSql) => argSql[0] && argSql[1] ? `(${argSql[0]} & ${argSql[1]})` : null],
  ["std::bit_or", (argSql) => argSql[0] && argSql[1] ? `(${argSql[0]} | ${argSql[1]})` : null],
  ["std::bit_not", (argSql) => argSql[0] ? `(~(${argSql[0]}))` : null],
  ["std::bit_xor", (argSql) => argSql[0] && argSql[1] ? `_gel_bit_xor(${argSql[0]}, ${argSql[1]})` : null],
  ["std::bit_lshift", (argSql, argTypes) => argSql[0] && argSql[1]
    ? `_gel_bit_lshift(${argSql[0]}, ${argSql[1]}, ${bitWidthOf(argTypes?.[0])})`
    : null],
  ["std::bit_rshift", (argSql, argTypes) => argSql[0] && argSql[1]
    ? `_gel_bit_rshift(${argSql[0]}, ${argSql[1]}, ${bitWidthOf(argTypes?.[0])})`
    : null],
  ["std::bit_count", (argSql, argTypes) => argSql[0]
    ? `_gel_bit_count(${argSql[0]}, ${bitWidthOf(argTypes?.[0])})`
    : null],
  ["std::datetime_current", () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ["std::datetime_of_transaction", () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ["std::datetime_of_statement", () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ["std::to_str", (argSql) => argSql[0] ? `CAST(${argSql[0]} AS TEXT)` : null],
  // `to_json(s)` parses the string as JSON; SQLite's json() validates and
  // minifies, raising on malformed input like EdgeQL does.
  ["std::to_json", (argSql) => argSql[0] ? `json(${argSql[0]})` : null],
  // `json_get(j, p1, p2, …)` walks the path and yields the element as json
  // (empty set — NULL — when missing). Path segments are arbitrary exprs, so
  // build the json_extract path string by concatenation.
  ["std::json_get", (argSql) => {
    if (!argSql[0] || argSql.length < 2 || argSql.slice(1).some((a) => !a)) return null;
    const path = argSql.slice(1).map((a) => ` || '."' || ${a} || '"'`).join("");
    return `json_extract(${argSql[0]}, '$'${path})`;
  }],
  ["std::len", (argSql) => argSql[0] ? `length(COALESCE(CAST(${argSql[0]} AS TEXT), ''))` : null],
  ["std::count", (argSql) => argSql[0] ? `count(${argSql[0]})` : null],
  ["std::max", (argSql) => argSql[0] ? `max(${argSql[0]})` : null],
  ["std::min", (argSql) => argSql[0] ? `min(${argSql[0]})` : null],
  ["std::str_lower", (argSql) => argSql[0] ? `lower(COALESCE(CAST(${argSql[0]} AS TEXT), ''))` : null],
  ["std::str_upper", (argSql) => argSql[0] ? `upper(COALESCE(CAST(${argSql[0]} AS TEXT), ''))` : null],
  // str_trim family: SQLite's trim(x, y) trims any character in y from both
  // ends (ltrim/rtrim for one side), matching EdgeQL's optional `trim` arg.
  ["std::str_trim", (argSql) => argSql[0]
    ? (argSql[1] ? `trim(${argSql[0]}, ${argSql[1]})` : `trim(${argSql[0]})`)
    : null],
  ["std::str_trim_start", (argSql) => argSql[0]
    ? (argSql[1] ? `ltrim(${argSql[0]}, ${argSql[1]})` : `ltrim(${argSql[0]})`)
    : null],
  ["std::str_trim_end", (argSql) => argSql[0]
    ? (argSql[1] ? `rtrim(${argSql[0]}, ${argSql[1]})` : `rtrim(${argSql[0]})`)
    : null],
  ["std::str_pad_start", (argSql) => argSql[0] && argSql[1]
    ? `_gel_str_pad_start(${argSql[0]}, ${argSql[1]}${argSql[2] ? `, ${argSql[2]}` : ""})`
    : null],
  ["std::str_pad_end", (argSql) => argSql[0] && argSql[1]
    ? `_gel_str_pad_end(${argSql[0]}, ${argSql[1]}${argSql[2] ? `, ${argSql[2]}` : ""})`
    : null],
  ["std::str_repeat", (argSql) => argSql[0] && argSql[1] ? `_gel_str_repeat(${argSql[0]}, ${argSql[1]})` : null],
  ["std::str_reverse", (argSql) => argSql[0] ? `_gel_str_reverse(${argSql[0]})` : null],
  ["std::str_split", (argSql) => argSql[0] && argSql[1] ? `_gel_str_split(${argSql[0]}, ${argSql[1]})` : null],
  ["std::str_replace", (argSql) => argSql[0] && argSql[1] && argSql[2]
    ? `replace(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`
    : null],
  ["std::array_replace", (argSql) => argSql[0] && argSql[1] && argSql[2]
    ? `_gel_array_replace(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`
    : null],
  ["std::to_int16", (argSql) => argSql[0] ? `_gel_to_int16(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null],
  ["std::to_int32", (argSql) => argSql[0] ? `_gel_to_int32(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null],
  ["std::to_int64", (argSql) => argSql[0] ? `_gel_to_int64(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null],
  ["std::to_float32", (argSql) => argSql[0] ? `_gel_to_float32(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null],
  ["std::to_float64", (argSql) => argSql[0] ? `_gel_to_float64(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null],
  ["std::to_bigint", (argSql) => argSql[0] ? `_gel_to_bigint(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null],
  ["std::to_decimal", (argSql) => argSql[0] ? `_gel_to_decimal(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null],
  // Range predicates/accessors — ranges are JSON objects produced by
  // `_gel_range` (constructed in compileFunctionCallSQL, which knows the
  // bound types). Boolean results are JSON-encoded by the caller.
  ["std::overlaps", (argSql) => argSql[0] && argSql[1] ? `_gel_range_overlaps(${argSql[0]}, ${argSql[1]})` : null],
  ["std::adjacent", (argSql) => argSql[0] && argSql[1] ? `_gel_range_adjacent(${argSql[0]}, ${argSql[1]})` : null],
  ["std::strictly_below", (argSql) => argSql[0] && argSql[1] ? `_gel_range_strictly_below(${argSql[0]}, ${argSql[1]})` : null],
  ["std::strictly_above", (argSql) => argSql[0] && argSql[1] ? `_gel_range_strictly_above(${argSql[0]}, ${argSql[1]})` : null],
  ["std::bounded_above", (argSql) => argSql[0] && argSql[1] ? `_gel_range_bounded_above(${argSql[0]}, ${argSql[1]})` : null],
  ["std::bounded_below", (argSql) => argSql[0] && argSql[1] ? `_gel_range_bounded_below(${argSql[0]}, ${argSql[1]})` : null],
  ["std::range_is_empty", (argSql) => argSql[0] ? `_gel_range_is_empty(${argSql[0]})` : null],
  ["std::range_is_inclusive_lower", (argSql) => argSql[0] ? `_gel_range_is_inclusive_lower(${argSql[0]})` : null],
  ["std::range_is_inclusive_upper", (argSql) => argSql[0] ? `_gel_range_is_inclusive_upper(${argSql[0]})` : null],
  ["std::range_get_lower", (argSql) => argSql[0] ? `_gel_range_get_lower(${argSql[0]})` : null],
  ["std::range_get_upper", (argSql) => argSql[0] ? `_gel_range_get_upper(${argSql[0]})` : null],
  ["std::multirange", (argSql) => argSql[0] ? `_gel_multirange(${argSql[0]})` : null],
  // EdgeQL round: float64 is half-to-even, decimal/bigint half-away-from-zero
  // (Postgres float8 vs numeric). The mode comes from the arg's static type.
  ["std::round", (argSql, argTypes) => {
    if (!argSql[0]) return null;
    const t = argTypes?.[0] ?? "";
    const mode = t.endsWith("decimal") || t.endsWith("bigint") ? "'away'" : "'even'";
    if (argSql[1]) return `_gel_round(${argSql[0]}, ${argSql[1]}, ${mode})`;
    return `_gel_round(${argSql[0]}, 0, ${mode})`;
  }],
  // `find(haystack, needle)` returns 0-based position or -1 if not found.
  // SQLite's instr returns 1-based, 0 if not found — translate accordingly.
  ["std::find", (argSql) => {
    if (!argSql[0] || !argSql[1]) return null;
    return `(instr(CAST(${argSql[0]} AS TEXT), CAST(${argSql[1]} AS TEXT)) - 1)`;
  }],
  // `contains(haystack, needle)` for strings: true if instr > 0.
  ["std::contains", (argSql) => {
    if (!argSql[0] || !argSql[1]) return null;
    return `(instr(CAST(${argSql[0]} AS TEXT), CAST(${argSql[1]} AS TEXT)) > 0)`;
  }],
  // array_join(arr, sep): walk the array via json_each and join the values.
  // Wraps the array in a CTE so the array placeholder appears in the SQL
  // BEFORE the separator placeholder — keeping ? positions aligned with the
  // params array (which receives arg0 before arg1).
  ["std::array_join", (argSql) => {
    if (!argSql[0] || !argSql[1]) return null;
    return `(WITH __aj(__arr) AS (VALUES (${argSql[0]})) SELECT COALESCE(group_concat(value, ${argSql[1]}), '') FROM __aj, json_each(__aj.__arr))`;
  }],
  ["std::datetime_get", (argSql) => argSql[0] && argSql[1]
    ? `_gel_datetime_get(${argSql[0]}, ${argSql[1]})`
    : null],
  ["std::datetime_truncate", (argSql) => argSql[0] && argSql[1]
    ? `_gel_datetime_truncate(${argSql[0]}, ${argSql[1]})`
    : null],
  ["cal::time_get", (argSql) => argSql[0] && argSql[1]
    ? `_gel_time_get(${argSql[0]}, ${argSql[1]})`
    : null],
  ["cal::date_get", (argSql) => argSql[0] && argSql[1]
    ? `_gel_date_get(${argSql[0]}, ${argSql[1]})`
    : null],
  ["std::duration_truncate", (argSql) => argSql[0] && argSql[1]
    ? `_gel_duration_truncate(${argSql[0]}, ${argSql[1]})`
    : null],
  ["std::duration_to_seconds", (argSql) => argSql[0]
    ? `_gel_duration_to_seconds(${argSql[0]})`
    : null],
]);

const UNREGISTERED_BUT_SUPPORTED = new Set<string>([
  "std::datetime_get",
  "std::datetime_truncate",
  "cal::time_get",
  "cal::date_get",
  "std::duration_truncate",
  "std::duration_to_seconds",
  "std::re_test",
  "std::re_match",
  "std::re_replace",
]);

export const canLowerStdlibFunctionSql = (target: RuntimeTarget, functionName: string): boolean =>
  canLowerStdlibFunctionToSql(target, functionName) || UNREGISTERED_BUT_SUPPORTED.has(functionName);

export const lowerStdlibFunctionSql = (
  target: RuntimeTarget,
  functionName: string,
  args: string[],
  argTypes?: (string | undefined)[],
): string | null => {
  // Unqualified names (e.g. `len`, `count`) reach us when the AST→IR
  // pass doesn't qualify the function. Try the standard module prefixes
  // before giving up — matches tryResolveStdlibFunction in stdlib/functions.
  const candidates = functionName.includes("::")
    ? [functionName]
    : [`std::${functionName}`, `math::${functionName}`, `cal::${functionName}`];
  for (const candidate of candidates) {
    if (!canLowerStdlibFunctionSql(target, candidate)) continue;
    const template = STDLIB_SQL_TEMPLATES.get(candidate);
    if (template) {
      const result = template(args, argTypes);
      if (result) return result;
    }
  }
  return null;
};
