// Result-clause helpers for the Runtime evaluator.
//
// These are the mechanically-identical, comparator-free pieces of "given a set
// of rows/values, apply DISTINCT and LIMIT/OFFSET" that were re-inlined across
// engine.ts. Pulling them behind one interface gives the runtime evaluator a
// real test surface (see tests/result_clauses.test.ts) and one home for the
// dedup/slice rules.
//
// Deliberately NOT here: the ORDER BY comparators. They are context-specific —
// a field `localeCompare`, an enum-aware comparison evaluated through `evalExpr`,
// and an id-set rank sort — and unifying them would change ordering behaviour in
// the partial-conformance evaluator. That unification is scoped out with reason
// in docs/adr/0007.

/** Dedupe id-bearing object rows by `.id`, preserving first-seen order. Items
 *  that are not id-bearing objects pass through unchanged. Mirrors the SQL
 *  `COUNT(DISTINCT target)` / EdgeQL path set semantics (objects are distinct by
 *  identity). */
export const dedupeRowsById = (rows: unknown[]): unknown[] => {
  const seen = new Set<string>();
  return rows.filter((item) => {
    const id =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as { id?: unknown }).id
        : undefined;
    if (typeof id !== "string") return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/** EdgeQL `DISTINCT` over a scalar/value set: dedupe by structural (JSON) value,
 *  preserving first-seen order. Used for sets whose elements are not id-bearing
 *  objects (scalars, tuples, arrays). */
export const distinctValues = (values: unknown[]): unknown[] => {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Apply LIMIT/OFFSET to an already-ordered set. `offset` defaults to 0; an
 *  `undefined` limit means "through the end". Returns a new array. */
export const applyLimitOffset = <T>(
  rows: T[],
  limit: number | undefined,
  offset = 0,
): T[] => (limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit));
