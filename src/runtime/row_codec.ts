// The one home for decoding a Gel-SQL result row into an EdgeQL value. The SQL
// pipeline projects scalars as a single `value` column and objects as a column
// per shape element; collection/tuple/object values are stored as JSON text.
// These two pure functions turn that wire shape back into JS values and are the
// final step of the SQL read path (consumed by `runGelSelectSQL` in
// `engine.ts`). Extracted from `engine.ts` so the decode has a home and a unit
// test surface (`tests/row_codec.test.ts`) instead of being reachable only by
// asserting executed rows — see docs/adr/0013.
//
// Note on the `try/JSON.parse/catch` fallback: `normalizeGelSQLValue` is
// type-blind — it does not know a column's declared type, so it guesses "looks
// like JSON → parse it". A `str` value that merely starts with `[`/`{` (e.g.
// `"[draft]"`) fails the parse and must fall back to the raw string. The catch
// is therefore load-bearing, NOT a swallowed bug: a malformed value here is an
// expected non-JSON string, not corrupt data. (Distinct from the SQL-precompute
// probe in `errors.ts`, where defects DO propagate — ADR 0012.)

// Decode one column value: non-strings pass through (null-coalesced); a string
// that looks like a JSON literal/container is parsed, falling back to the raw
// string when it is not actually JSON (a plain `str` that looks JSON-ish).
export const normalizeGelSQLValue = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value ?? null;
  }
  if (value === "true" || value === "false" || value === "null" || value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

// Decode a set of Gel-SQL result rows. A single `value` column is a scalar set;
// any other shape is an object set (internal id/type columns dropped unless
// `keepInternalId`). `scalarResultIsStr` keeps JSON-looking plain text verbatim
// for statically-`std::str` results (only quoted JSON strings are unwrapped).
// An all-null object row materializes to `null` (the empty object link case).
// Sentinel marking a scalar row whose value is SQL NULL — EdgeQL has no scalar
// `null`, so such a row represents the empty set and is dropped from the result
// (e.g. `array_get(arr, out_of_range)` and `max(<int64>{})` yield `{}`, not
// `{null}`). Object rows keep their existing all-null → `null` mapping.
const DROP_SCALAR_NULL = Symbol("drop-scalar-null");

export const materializeGelSQLRows = (
  rows: Record<string, unknown>[],
  options: { keepInternalId: boolean; scalarResultIsStr?: boolean },
): unknown[] => rows.map((row) => {
  const keys = Object.keys(row);
  // Scalar select: Gel SQL projects a single `value` column. Parse JSON-shaped
  // strings while preserving plain numeric strings produced by text casts.
  if (keys.length === 1 && Object.prototype.hasOwnProperty.call(row, "value")) {
    if (row.value === null || row.value === undefined) {
      return DROP_SCALAR_NULL;
    }
    if (options.scalarResultIsStr && typeof row.value === "string") {
      if (row.value.startsWith("\"")) {
        try {
          return JSON.parse(row.value);
        } catch {
          return row.value;
        }
      }
      // The statement's static type is std::str — keep JSON-looking plain
      // text (`'false'`, `'[1]'`) verbatim instead of JSON.parsing it.
      return row.value;
    }
    return normalizeGelSQLValue(row.value);
  }

  const out: Record<string, unknown> = {};
  let hasShapeColumn = false;
  for (const key of keys) {
    if (key === "__source_type" || key === "__tid__" || key === "__tname__") continue;
    if (key === "id" && !options.keepInternalId) continue;
    hasShapeColumn = true;
    out[key] = normalizeGelSQLValue(row[key]);
  }

  if (!hasShapeColumn) {
    const allNull = keys.every((key) => row[key] === null || row[key] === undefined);
    if (allNull) return null;
  }
  return out;
}).filter((value) => value !== DROP_SCALAR_NULL);
