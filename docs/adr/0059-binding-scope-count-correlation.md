# Binding-scope correlation for count-of-property

A `count(<single scalar property>)` means two different things depending on the
scope it is written in:

- **Inline in a computed shape** — `SELECT Card { foo := count(Card.name) }` —
  the `Card` inside the count is the *enclosing row*. The count is therefore
  per-row: `0` or `1` on that row's single `name`. (`test_edgeql_scope_nested_05`.)
- **Factored into a `WITH` binding** — `WITH a := count({Card.name})
  SELECT Card { a := a }` — the binding is computed once over the *whole set*,
  so the count is the total number of names (9 in the cards fixture).
  (`test_edgeql_scope_with_03`.)

**The wall.** After the IR builder inlines the `WITH` binding into its reference
site, the two are *byte-identical* in the IR: same `function_call`/`pointer`
node kinds, same `Card`+`name` path, empty `pathId.namespace`, no flags. SQL
lowering keys correlation on `(typeref.id, namespace)` via
`findMatchingOuterScope` — and on that key the two count arguments are
indistinguishable. So a naive "correlate the count argument" fix gets
`nested_05` right (1) but regresses `with_03` (1 instead of 9), and the inverse
default — never correlate — has them swapped. The distinguishing fact (which
scope the path was bound in) is *erased by inlining*.

**Decision (done): stamp the factored count's argument, gate correlation on it.**
This reuses the existing "detached WITH binding" convention — the IR builder
already marks subquery (`select_expr`) bindings `isWithBinding` so the SQL layer
"suppresses outer-scope capture of their internals" (`existence_proof.ts`).
`count(...)` bindings (a `function_call`, neither `select_expr` nor `type_root`)
fell through both existing markers. We extend the mark to them:

- `withBindings` (ast_to_ir.ts): a `count(...)` WITH binding now stamps
  `isWithBinding` on its **argument** Set(s) — the node `compileCountOfSetSQL`
  receives. The mark survives inlining and is the *only* thing distinguishing a
  factored count from an inline one.
- `compileCountOfSetSQL` pointer case (function_lowering.ts): for a count whose
  argument is **not** `isWithBinding`, a single-valued outbound scalar property
  off an enclosing scope lowers to the correlated `CASE WHEN <alias>."col" IS
  NULL THEN 0 ELSE 1 END`. The raw column comes from a new
  `correlatedDirectScalarPropertyLeaf` helper (gel_ir_compiler.ts, exposed on
  `SqlLoweringContext`) — *raw*, not json-quoted, so the `IS NULL` test reads
  the column directly. A factored count carries the mark, skips this branch, and
  falls through to the existing full-set `count(*)` scan.

**Why a mark and not a namespace tag.** The principled alternative — give the
binding's internal paths a distinct `with:` namespace so `findMatchingOuterScope`
declines the match for free — is read by *every* correlation call site, a broad
blast radius on the hot mutually-recursive builder (and a naive earlier attempt
at this cluster regressed). `isWithBinding` is **inert** everywhere except the
one new gate: the existing reader (`existence_proof.ts`) only consults it behind
a `type_root` guard a `function_call` count argument never reaches. So this
fixes `nested_05` with a change that provably cannot move any other test on
structure — confirmed by the regression gate below.

**Scoped out, deliberately.** Only the single-valued *direct* scalar property
case is correlated (the anchor shape). Multi-valued links (`count(Card.owners)`),
chained scalar paths, and other set-aggregates (`sum`/`array_agg`/…) keep their
current lowering — the mark is stamped for `count` only. Generalizing the
correlation (and promoting the mark toward the full `with:`-namespace scope model)
is the larger continuation; this is the surgical, verifiable first slice.

**Verification.** `tsc --noEmit` clean. `test_edgeql_scope_nested_05` flips to
passing; `test_edgeql_scope_with_03` stays passing; the scope suite goes 94→93
fail with **zero** new scope failures. Full-suite name-level diff vs the
772-name baseline: the only persistent delta is `nested_05` (fixed). The
`functions_inline_*_link_02` tests that also appear are pre-existing flaky noise
— demonstrated to fail in/out across identical-code runs *and* on the stashed
clean baseline, and unreachable by this change (no count construct). +4
first-party tests (`tests/count_correlation.test.ts`) pin both sides of the
distinction through the compile-inspection seam.
