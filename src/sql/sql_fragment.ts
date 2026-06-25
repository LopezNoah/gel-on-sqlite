// SQL-fragment composition helpers — the param-ownership seam (ADR 0058).
//
// The SQL compiler threads parameters through a single shared, mutated
// `params: ScalarValue[]` array: each `compile*` call PUSHES its `?`-bound
// values onto it and returns a SQL string whose `?` placeholders correspond,
// positionally, to those pushes. That convention has one sharp edge: it assumes
// each returned fragment's SQL is emitted EXACTLY ONCE. The moment a fragment is
// referenced more than once in the output SQL, its `?` placeholders out-number
// the values that were pushed for it ("too few parameter values"); drop it and
// the reverse happens ("too many").
//
// The robust answer is a one-row subquery that binds each operand to a stable
// alias and references the alias in the body, so an operand whose SQL carries
// `?` is emitted (and its params consumed) exactly once no matter how many times
// the body refers to it. That idiom was copy-pasted across ~7 sites; this is its
// single home.
//
// NOTE: this is the *consumption-safety* half of the param-ownership story.
// The fuller model — every `compile*` returning an owned `{ sql, params }`
// fragment instead of mutating a shared array — is a ~67-function change and is
// deliberately deferred (ADR 0058); `SqlFragment` is defined here as that
// foundation. The operands passed to `bindOperandsOnce` already had their params
// pushed when they were compiled, so this helper is a pure string transform.

import type { ScalarValue } from "../types.js";

/**
 * A self-describing SQL fragment that owns its parameter values, rather than
 * relying on positional correspondence with a shared, mutated params array.
 * The target shape for the deferred full param-ownership conversion (ADR 0058).
 */
export interface SqlFragment {
  sql: string;
  params: ScalarValue[];
}

/** One operand to bind once: its SQL expression and the alias the body uses. */
export interface BoundOperand {
  alias: string;
  /** The operand's already-compiled SQL (its params were pushed at compile time). */
  sql: string;
}

/**
 * Emit `body` against operands each bound ONCE in a one-row subquery, so an
 * operand whose SQL carries `?` placeholders is evaluated (and its params
 * consumed) exactly once regardless of how many times `body` references its
 * alias:
 *
 *   bindOperandsOnce([{alias:"l", sql:left}, {alias:"r", sql:right}],
 *     "CASE WHEN l IS NULL OR r IS NULL THEN NULL WHEN l = r THEN json('true') ELSE json('false') END")
 *   // (SELECT CASE … END FROM (SELECT (<left>) AS l, (<right>) AS r))
 *
 * `body` must reference only the operand aliases (not the raw SQL). The single
 * home for the param-double-counting-safe operand-binding idiom (ADR 0058).
 */
export const bindOperandsOnce = (operands: ReadonlyArray<BoundOperand>, body: string): string => {
  const binds = operands.map((operand) => `(${operand.sql}) AS ${operand.alias}`).join(", ");
  return `(SELECT ${body} FROM (SELECT ${binds}))`;
};
