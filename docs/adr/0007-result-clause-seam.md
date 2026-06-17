# Extract the runtime evaluator's result-clause helpers; defer the ORDER BY comparator unification

The architecture review's round-2 candidate #2 found that the **Runtime evaluator** (`src/runtime/engine.ts`) re-inlined "given a set of rows/values, apply ORDER BY → LIMIT/OFFSET → DISTINCT" across ~5 sites, and that DISTINCT specifically existed in three forms: a JSON-value dedup (the `distinct` operator), an inline id-set dedup (path cross-product collapse), and the standalone `dedupeRowsById` (fieldless `count(.link)`). The careful enum-aware multi-key comparator existed in only one site, so the others could drift from EdgeQL ordering/NULL semantics. The friction was **locality** — the dedup and slice rules had no single home and the seam was untestable (every assertion went through executed rows).

**Decision (done):** Add `src/runtime/result_clauses.ts` — three pure, comparator-free helpers that are the mechanically-identical pieces:

- `dedupeRowsById(rows)` — id-bearing object rows deduped by `.id`, first-seen order; non-id items pass through (moved verbatim out of `engine.ts`).
- `distinctValues(values)` — structural (JSON) value dedup for scalar/tuple/array sets.
- `applyLimitOffset(rows, limit, offset?)` — the LIMIT/OFFSET slice arithmetic.

The five sites now route through them: the path cross-product dedup calls `dedupeRowsById` (the guard already guarantees all items are id-bearing, so the result is identical); the `distinct` case calls `distinctValues`; the `select_expr` field-access, `select_expr_subquery`, and DML-chain (`applyChainSubqueryClauses`) slice sites call `applyLimitOffset`. The module is pinned by `tests/result_clauses.test.ts` (8 unit tests) — the seam is now a real test surface, the win the candidate-#1 inspection seam established for the compiler (`docs/adr/0002`).

**Decision (scoped out, deliberately):** the **ORDER BY comparators are NOT unified.** They are genuinely context-specific:

- `select_expr` field-access sorts by `localeCompare` on a single clause field (`engine.ts` ~3074).
- `select_expr_subquery` sorts enum-aware by evaluating `orderByClause.expr` through `evalExpr` per row, with a per-row environment (`engine.ts` ~3184).
- the DML chain sorts an **id-set** by a SQL-fetched key column, then `reverse()`s for `desc` (`engine.ts` ~4260).
- `executeSelectOverMutation` re-orders by a captured id **rank** map.

Folding these into one `applyResultClauses(rows, clauses, schema)` comparator would have to reconcile four different inputs (shaped rows vs id-sets vs rank maps) and four comparison strategies, and the runtime evaluator is **partial-conformance** — a behaviour change here surfaces as a wrong row, not a type error. The risk outweighs the locality gain. The dedup/slice extraction captures the safe, identical pieces; the comparators stay where their context lives.

**Verification.** Behaviour-neutral: the runtime-evaluator + DML slice (`select`/`insert`/`coalesce`/`functions`/`for`/`group` + the deterministic inspect goldens, 1399 tests) ran `330 failed / 1066 passed` both before and after — the +1 seen on one run reproduced as 330 on re-run, i.e. the suite's known order-flakiness, not a regression. The extracted helpers are provably content-equivalent: `dedupeRowsById` is moved verbatim, `distinctValues` is the identical filter body, and `applyLimitOffset` returns the same elements (it differs only by returning a fresh array in the previously-no-op case). 0 type errors; 8 new unit tests green.

**Consequences.** Dedup and slice have one home and one test surface; "the three DISTINCTs" the review flagged are now two named functions (id-identity vs structural value) plus the reused mover. A future change to slice or dedup semantics happens in `result_clauses.ts`, guarded by its unit tests.

**Why record it:** a future reader will see `result_clauses.ts` own dedup + slice but **not** ORDER BY, and will be tempted to "finish" it by pulling the four comparators into one `applyResultClauses`. That unification is scoped out here with reason — the comparators read incompatible inputs and the evaluator is partial-conformance, so a comparator merge must be its own behaviour-gated change, not folded in silently.
