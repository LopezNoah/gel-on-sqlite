// Coarse categorization of EdgeQL queries by which architectural gap they
// likely hit. Used to decorate errors with `[Unsupported:Category]` tags so
// failing tests can be grouped/grep'd in `npm test` output. Detection is
// pattern-based on the source query — it's intentionally over-broad: a
// match means "this query *touches* the area," not "the test fails for
// this reason." Categories are returned in the order they're checked.

export type UnsupportedCategory =
  | "GROUP"
  | "UDF"
  | "Range"
  | "Decimal"
  | "Bigint"
  | "Bitwise"
  | "Detached"
  | "PolymorphicShape"
  | "LinkProperty"
  | "BankerRound";

interface CategoryRule {
  category: UnsupportedCategory;
  test: RegExp;
}

const RULES: CategoryRule[] = [
  // `CREATE FUNCTION` blocks user-defined function inlining (no UDF subsystem).
  { category: "UDF", test: /\bCREATE\s+FUNCTION\b/i },
  // `GROUP T BY .field` — strict IR/SQL compile has no GROUP lowering; runs
  // through `runGroupIR` runtime fallback. ~half of GROUP queries currently
  // produce wrong results.
  { category: "GROUP", test: /\bGROUP\s+[A-Za-z_]/ },
  // `multirange(...)` always unsupported. `range(...)` is partly OK in
  // isolation but range comparisons/contains/unpack are not.
  { category: "Range", test: /\b(?:multirange|range_unpack|range_contains|range_get_lower|range_get_upper)\s*\(/i },
  { category: "Range", test: /\bmultirange\b|\brange\s*::/i },
  // `<decimal>` cast: SQLite has no native decimal precision.
  { category: "Decimal", test: /<\s*decimal\s*>/i },
  // Bigint literals (`42n`, `1.5n`) — no native 64+ bit integer arithmetic.
  { category: "Bigint", test: /\b\d+(?:\.\d+)?n\b/ },
  // Width-aware bitwise operators (int16/int32/int64 overflow semantics).
  { category: "Bitwise", test: /\bbit_(and|or|xor|not|lshift|rshift)\s*\(/i },
  // DETACHED breaks LCP correlation — needs separate iteration scope.
  { category: "Detached", test: /\bDETACHED\s+/i },
  // `[IS T].field` inside a UNION shape needs polymorphic dispatch.
  { category: "PolymorphicShape", test: /\bUNION[\s\S]{0,200}\[IS\s/i },
  // `@prop` link-property access in shapes/projections.
  { category: "LinkProperty", test: /[\s,{(]@[A-Za-z_]/ },
];

export const categorizeUnsupportedQuery = (query: string): UnsupportedCategory[] => {
  const out: UnsupportedCategory[] = [];
  const seen = new Set<UnsupportedCategory>();
  for (const rule of RULES) {
    if (seen.has(rule.category)) continue;
    if (rule.test.test(query)) {
      out.push(rule.category);
      seen.add(rule.category);
    }
  }
  return out;
};

// Format an `[Unsupported:A,B]` tag string, or empty if the query touches no
// known unsupported area. Used to prefix error messages.
export const unsupportedTagFor = (query: string): string => {
  const cats = categorizeUnsupportedQuery(query);
  if (cats.length === 0) return "";
  return `[Unsupported:${cats.join(",")}] `;
};

// Decorate an error with the unsupported-tag prefix in front of its message.
// No-op if no categories match. Preserves error type and stack.
export const decorateErrorWithUnsupportedTag = (error: unknown, query: string): unknown => {
  const tag = unsupportedTagFor(query);
  if (!tag || !(error instanceof Error)) return error;
  if (error.message.startsWith("[Unsupported:")) return error; // already tagged
  error.message = `${tag}${error.message}`;
  return error;
};
