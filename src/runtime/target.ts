import { AppError } from "../errors.js";

export type RuntimeTarget = "sqlite" | "d1";

// NOTE: the per-target "which stdlib functions lower to SQL" gate used to live
// here (`BASE_SQL_NATIVE_STDLIB_LOWERING` + `targetCapabilities` +
// `canLowerStdlibFunctionToSql`). It was a name-set that hand-shadowed the SQL
// template map in `sql/stdlib_lowering.ts` and drifted from it. That decision
// now has one home: a function lowers to SQL iff it has a `sql` slot in
// `stdlib/registry.ts`. See `docs/adr/0043`.

const D1_ALLOWED_SQLITE_FUNCTIONS = new Set([
  "abs", "changes", "char", "coalesce", "concat", "concat_ws", "format", "glob", "hex", "ifnull", "iif", "instr",
  "last_insert_rowid", "length", "like", "likelihood", "likely", "load_extension", "lower", "ltrim", "max_scalar",
  "min_scalar", "nullif", "octet_length", "printf", "quote", "random", "randomblob", "replace", "round", "rtrim",
  "sign", "soundex", "substr", "substring", "total_changes", "trim", "typeof", "unhex", "unicode", "unlikely",
  "upper", "zeroblob", "date", "time", "datetime", "julianday", "unixepoch", "strftime", "timediff", "current_date",
  "current_time", "current_timestamp", "avg", "count", "group_concat", "max", "min", "string_agg", "sum", "total",
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value",
  "nth_value", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "ceil", "cos", "cosh", "degrees", "exp",
  "floor", "ln", "log", "log2", "mod", "pi", "pow", "radians", "sin", "sinh", "sqrt", "tan", "tanh", "trunc",
  "json", "json_array", "json_array_length", "json_extract", "json_insert", "json_object", "json_patch", "json_remove",
  "json_replace", "json_set", "json_type", "json_valid", "json_quote", "json_group_array", "json_group_object", "json_each",
  "json_tree", "match", "highlight", "bm25", "snippet", "sqlite_rename_column", "sqlite_rename_table", "sqlite_rename_test",
  "sqlite_drop_column", "sqlite_rename_quotefix",
]);

const SQL_KEYWORDS_WITH_PARENS = new Set([
  "in", "values", "select", "from", "where", "and", "or", "not", "exists", "between", "is", "null", "case", "when",
  "then", "else", "end", "cast", "over", "partition", "order", "by", "limit", "offset", "join", "left", "right",
  "inner", "outer", "on", "as", "distinct", "insert", "into", "update", "set", "delete", "create", "table", "if",
  "begin", "commit", "rollback", "primary", "key", "default", "constraint",
]);

const extractSqlFunctions = (sql: string): string[] => {
  const found = new Set<string>();
  const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const fn = match[1].toLowerCase();
    const prefix = sql.slice(0, match.index).trimEnd();
    const prevMatch = prefix.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    const prevToken = prevMatch?.[1]?.toLowerCase();
    if (SQL_KEYWORDS_WITH_PARENS.has(fn)) {
      continue;
    }
    if (prevToken && (prevToken === "into" || prevToken === "table" || prevToken === "update" || prevToken === "from" || prevToken === "join")) {
      continue;
    }
    found.add(fn);
  }
  return [...found.values()];
};

export const assertTargetSqlCompatibility = (sql: string, target: RuntimeTarget): void => {
  if (target !== "d1") {
    return;
  }

  const funcs = extractSqlFunctions(sql);
  const disallowed = funcs.filter((fn) => !D1_ALLOWED_SQLITE_FUNCTIONS.has(fn));
  if (disallowed.length === 0) {
    return;
  }

  throw new AppError(
    "E_SQL",
    `SQL uses functions not allowed by D1: ${disallowed.join(", ")}`,
    1,
    1,
  );
};
