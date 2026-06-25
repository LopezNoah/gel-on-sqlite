# A param-ownership seam (src/sql/sql_fragment.ts)

The SQL compiler threads parameters through a single shared, mutated
`params: ScalarValue[]` array: each `compile*` call PUSHES its `?`-bound values
and returns a SQL string whose `?` placeholders correspond positionally to those
pushes. The convention has one sharp edge — it assumes each returned fragment's
SQL is emitted EXACTLY ONCE. Reference a fragment more than once and its `?`
out-number the pushed values ("too few parameter values"); compile one and then
drop it without resetting and the reverse happens ("too many"). The string
index/slice fix worked around this inline with a `base.includes("?")` check
(the `paramInlined` hack) — counting `?` to guess ownership.

**Decision (done): name the param-double-counting-safe idiom.**
`src/sql/sql_fragment.ts` exports `bindOperandsOnce(operands, body)` — emit
`body` against operands each bound ONCE in a one-row subquery
(`(SELECT <body> FROM (SELECT (<sql>) AS <alias>, …))`), so an operand whose SQL
carries `?` is evaluated (and its params consumed) exactly once no matter how
many times `body` references its alias. The seven sites that had open-coded this
exact subquery now route through it (gel_ir_compiler.ts: the value-level
comparison, boolean-truthy normalization ×2, NOT-normalization, boolean binary
op, and the `??`/`?=` comparison; function_lowering.ts: the bool-returning
stdlib normalization). Byte-identical — `bindOperandsOnce` reproduces the prior
string verbatim (verified by the deterministic `inspect_corpus` goldens and the
full suite). The module also defines `SqlFragment { sql, params }` as the
foundation type for the deferred fuller model below. +5 first-party tests pin
the param-accounting invariant (one operand → one `?`, regardless of alias
reuse).

**Scoped out, deliberately:**
- **The full ownership conversion** — every `compile*` returning an owned
  `{ sql, params }` fragment instead of mutating a shared array — is a
  ~67-function change with hundreds of call sites, where any inconsistency is a
  silent param-count bug. Too large/risky for one increment; `SqlFragment` is
  laid down as its target shape, and this helper is the safe first slice.
- **The slice lowering's conditional `.includes("?")` wrap** stays. It binds
  *conditionally* (inline when no `?`, wrap when present) to keep column-base
  slice SQL unwrapped; `bindOperandsOnce` always wraps, so converting it would
  change goldens. The two `CAST(<idx> AS INTEGER) AS i` index binders likewise
  use a variant bind form and are left as-is.

**On the param-count test failures.** The failing suite does throw
`"too many/few parameter values"` (e.g. `to_str_02`–`07`, `ref_outer_03/04`,
`update_basic_06/07`). Investigated: these are NOT standalone param-ownership
bugs that this seam fixes. They are symptoms of *other* incomplete machinery —
`to_str(<datetime>, fmt)` is unimplemented and falls back to `CAST(? AS TEXT)`,
leaking the dropped format arg's param; the `functions_inline` cases are
entangled with UDF-DML inlining; `ref_outer_*` is the correlation cluster. So
this increment is **prevention + consolidation**, not a test-fixing lever — as
expected when this path was chosen over fixing a feature cluster. (A future
discipline where fallbacks reset the params they speculatively pushed would turn
those crashes into clean rejections/results; that builds on this seam.)

**Verification.** `tsc --noEmit` clean; the three touched files lint clean;
byte-identical SQL on spot-checked queries; full suite 0 regressions by
name-level diff vs the 783-fail baseline (the only delta is the known-flaky
`functions_inline_*_link_02`).

**Why record it.** Param ownership was carded as a major direction
(SQL fragments owning `{sql, params}`). What is tractable and safe *now* is the
consumption-safety idiom, given one home; the full ownership rewrite is recorded
here as the deferred remainder so a future reviewer knows the seam exists and
what it does and does not yet cover.

**Sibling note (the correlation direction).** The source-identity/correlation
direction was explored in the same effort and deferred: its genuine fix is
preserving binding-scope identity through WITH/rebinding inlining (post-inlining,
a factored `count(Card.name)` and an inline one are byte-identical in the IR, so
SQL cannot tell 9 from 1) — a foundational change to the hot builder path, out
of scope here. Recorded in project memory, not as an ADR, since no code decision
landed.
