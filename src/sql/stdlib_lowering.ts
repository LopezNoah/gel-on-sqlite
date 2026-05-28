import { canLowerStdlibFunctionToSql, type RuntimeTarget } from "../runtime/target.js";

export type StdlibSqlTemplate = (args: string[]) => string | null;

const normalizeDateTimeSQLInput = (dateExpr: string): string =>
  `replace(replace(CAST(${dateExpr} AS TEXT), 'T', ' '), 'Z', '')`;

const STDLIB_SQL_TEMPLATES = new Map<string, StdlibSqlTemplate>([
  ["math::abs", (argSql) => argSql[0] ? `abs(${argSql[0]})` : null],
  ["math::ceil", (argSql) => argSql[0] ? `ceil(${argSql[0]})` : null],
  ["math::floor", (argSql) => argSql[0] ? `floor(${argSql[0]})` : null],
  ["math::exp", (argSql) => argSql[0] ? `exp(${argSql[0]})` : null],
  ["math::ln", (argSql) => argSql[0] ? `ln(${argSql[0]})` : null],
  ["math::lg", (argSql) => argSql[0] ? `log(${argSql[0]})` : null],
  ["math::log", (argSql) => argSql[0] && argSql[1] ? `(ln(${argSql[0]}) / ln(${argSql[1]}))` : null],
  ["math::pi", () => "pi()"],
  ["math::e", () => "exp(1.0)"],
  ["math::acos", (argSql) => argSql[0] ? `acos(${argSql[0]})` : null],
  ["math::asin", (argSql) => argSql[0] ? `asin(${argSql[0]})` : null],
  ["math::atan", (argSql) => argSql[0] ? `atan(${argSql[0]})` : null],
  ["math::atan2", (argSql) => argSql[0] && argSql[1] ? `atan2(${argSql[0]}, ${argSql[1]})` : null],
  ["math::cos", (argSql) => argSql[0] ? `cos(${argSql[0]})` : null],
  ["math::cot", (argSql) => argSql[0] ? `(1.0 / tan(${argSql[0]}))` : null],
  ["math::sin", (argSql) => argSql[0] ? `sin(${argSql[0]})` : null],
  ["math::tan", (argSql) => argSql[0] ? `tan(${argSql[0]})` : null],
  ["std::datetime_current", () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ["std::datetime_of_transaction", () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ["std::datetime_of_statement", () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ["std::to_str", (argSql) => argSql[0] ? `CAST(${argSql[0]} AS TEXT)` : null],
  ["std::len", (argSql) => argSql[0] ? `length(COALESCE(CAST(${argSql[0]} AS TEXT), ''))` : null],
  ["std::count", (argSql) => argSql[0] ? `count(${argSql[0]})` : null],
  ["std::max", (argSql) => argSql[0] ? `max(${argSql[0]})` : null],
  ["std::min", (argSql) => argSql[0] ? `min(${argSql[0]})` : null],
  ["std::str_lower", (argSql) => argSql[0] ? `lower(COALESCE(CAST(${argSql[0]} AS TEXT), ''))` : null],
  ["std::str_upper", (argSql) => argSql[0] ? `upper(COALESCE(CAST(${argSql[0]} AS TEXT), ''))` : null],
  // SQLite's round() rounds half-to-even at the boundary, matching EdgeQL.
  ["std::round", (argSql) => {
    if (!argSql[0]) return null;
    if (argSql[1]) return `round(${argSql[0]}, ${argSql[1]})`;
    return `round(${argSql[0]})`;
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
  ["std::datetime_get", (argSql) => {
    if (!argSql[0] || !argSql[1]) {
      return null;
    }
    const firstExpr = `LOWER(CAST(${argSql[0]} AS TEXT))`;
    const secondExpr = `LOWER(CAST(${argSql[1]} AS TEXT))`;
    const partExpr = `CASE WHEN ${firstExpr} IN ('year', 'month', 'day', 'hour', 'minute', 'second', 'epochseconds') THEN ${firstExpr} ELSE ${secondExpr} END`;
    const dateExpr = normalizeDateTimeSQLInput(`CASE WHEN ${firstExpr} IN ('year', 'month', 'day', 'hour', 'minute', 'second', 'epochseconds') THEN ${argSql[1]} ELSE ${argSql[0]} END`);
    return `CASE ${partExpr} WHEN 'year' THEN CAST(strftime('%Y', ${dateExpr}) AS INTEGER) WHEN 'month' THEN CAST(strftime('%m', ${dateExpr}) AS INTEGER) WHEN 'day' THEN CAST(strftime('%d', ${dateExpr}) AS INTEGER) WHEN 'hour' THEN CAST(strftime('%H', ${dateExpr}) AS INTEGER) WHEN 'minute' THEN CAST(strftime('%M', ${dateExpr}) AS INTEGER) WHEN 'second' THEN CAST(strftime('%S', ${dateExpr}) AS INTEGER) WHEN 'epochseconds' THEN CAST(strftime('%s', ${dateExpr}) AS INTEGER) ELSE NULL END`;
  }],
  ["std::datetime_truncate", (argSql) => {
    if (!argSql[0] || !argSql[1]) {
      return null;
    }
    const firstExpr = `LOWER(CAST(${argSql[0]} AS TEXT))`;
    const secondExpr = `LOWER(CAST(${argSql[1]} AS TEXT))`;
    const partExpr = `CASE WHEN ${firstExpr} IN ('year', 'month', 'day', 'hour', 'minute', 'second') THEN ${firstExpr} ELSE ${secondExpr} END`;
    const dateExpr = normalizeDateTimeSQLInput(`CASE WHEN ${firstExpr} IN ('year', 'month', 'day', 'hour', 'minute', 'second') THEN ${argSql[1]} ELSE ${argSql[0]} END`);
    return `CASE ${partExpr} WHEN 'year' THEN strftime('%Y-01-01T00:00:00.000Z', ${dateExpr}) WHEN 'month' THEN strftime('%Y-%m-01T00:00:00.000Z', ${dateExpr}) WHEN 'day' THEN strftime('%Y-%m-%dT00:00:00.000Z', ${dateExpr}) WHEN 'hour' THEN strftime('%Y-%m-%dT%H:00:00.000Z', ${dateExpr}) WHEN 'minute' THEN strftime('%Y-%m-%dT%H:%M:00.000Z', ${dateExpr}) WHEN 'second' THEN strftime('%Y-%m-%dT%H:%M:%S.000Z', ${dateExpr}) ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${dateExpr}) END`;
  }],
]);

const UNREGISTERED_BUT_SUPPORTED = new Set<string>([
  "std::datetime_get",
  "std::datetime_truncate",
]);

export const canLowerStdlibFunctionSql = (target: RuntimeTarget, functionName: string): boolean =>
  canLowerStdlibFunctionToSql(target, functionName) || UNREGISTERED_BUT_SUPPORTED.has(functionName);

export const lowerStdlibFunctionSql = (
  target: RuntimeTarget,
  functionName: string,
  args: string[],
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
      const result = template(args);
      if (result) return result;
    }
  }
  return null;
};
