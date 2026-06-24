# Extract the path-existence algebra into existence_proof.ts

The twin of ADR 0051. The round-10 review's top candidate: `gel_ir_compiler.ts`
held a coherent ~680-line sub-algebra for proving an EdgeQL pointer path exists
— object-identity comparisons (`<chain> = Outer`), multi-step `EXISTS` chains,
correlated existential subqueries (`EXISTS (SELECT T FILTER …)`), existence
guards over strict boolean operands, and the anchored object-chain JOIN builder
they share — as ten module-private functions, exercised only end-to-end.

**Finding (same as ADR 0051 — verify before extracting):** the cluster is not a
free-standing leaf. `compilePredicateSetSQL` / `compileOperatorValueSQL` *call*
the existence functions, and the existence functions call
`compilePredicateSetSQL` / `compileValueSetSQL` / `compileSelectSource` /
`compilePolymorphicSource` back — mutual recursion. They also reach ~10 pure
pointer/path collectors. A direct import would form a module cycle.

**Decision (done):** lift the ten functions into `src/sql/existence_proof.ts`,
reaching the dispatchers and helpers through the existing `SqlLoweringContext`
seam (ADR 0006), exactly as ADR 0051 did. Five functions are exported (the
external entry points: `tryCompileMultiStepPointerExistsSQL`,
`tryCompileCorrelatedExistsSelect`, `collectStrictPointerChainSets`,
`compilePathExistenceGuard`, `tryCompileExistsObjectPointerSQL`); five are
module-internal (`tryCompileObjectIdentityExistsSQL`, `extractObjectPointerPath`,
`rewriteChainRefsToTypeRoot`, `tryCompileCorrelatedExistsChainSelect`,
`buildAnchoredObjectChainJoin`). `extractObjectPointerPath` is genuinely pure
(no deps); the other nine take `deps: SqlLoweringContext` and destructure it at
the top, so the bodies are byte-identical; the only body edits thread `deps`
through the intra-cluster calls. The `ScalarPointerPath` type moved to its
proper home `compiler_types.ts` (the shared SQL-compiler-types leaf, alongside
`GelIRCompileOptions`), so both `gel_ir_compiler.ts` and `existence_proof.ts`
import it without a back-reference to the giant. Five more pure helpers
(`extractScalarPointerPath`, `pointerPathAliasColumns`, `isTrulyPolymorphicTypeRef`,
`collectProjectedColumns`, the `NON_STRICT_STDLIB` set) joined the context;
`pointerStepJoinSql` / `quoteIdent` are pure leaf imports. Seven external call
sites in `gel_ir_compiler.ts` pass `sqlLoweringContext()`.

**The cost, recorded honestly:** combined with ADR 0051, the shared
`SqlLoweringContext` now carries 37 members (was 22). The caller-facing
interface of each existence entry point stays small and deep
(`(args, sourceAlias, params, target, options, deps) → string | null`); the
back-edges are the implementation's coupling. As in ADR 0051 this is the upper
end of what the codebase accepts, recorded so the locality/test-surface win is
weighed against the wide seam.

**Verification.** Behaviour-neutral, proven directly: `tsc --noEmit` clean,
`eslint` clean on all four changed files. The canonical-SQL goldens
(`tests/inspect.test.ts`, `tests/inspect_corpus.test.ts`) pass — no emitted SQL
changed. The EXISTS-exercising suites are byte-identical to a stashed
committed-`6aa041b` baseline: `edgeql_filter` / `edgeql_advtypes` /
`edgeql_linkprops` / `edgeql_select` / `edgeql_expressions` / `edgeql_scope`
together produced an identical `410 failed / 664 passed / 3 skipped` before and
after. New unit surface: `tests/existence_proof.test.ts` (4 tests) pins the
single-link `source`/`target` anchoring, the correlated subquery's
outer-row-anchored chain join + rewritten leaf filter, and the multi-step chain
join, through the inspect seam.

**Consequences.** The path-existence algebra has a named home and a named test
surface; a change to its lowering now fails `existence_proof.test.ts` by name.
`gel_ir_compiler.ts` sheds ~680 lines (13.8k → 12.5k across ADRs 0051+0052).

**Why record it.** The review carded this as the cleanest, highest-leverage
deepening. The leverage is real, but the cleanness was over-claimed: the cluster
is mutually recursive with the predicate/value dispatchers and needs a wide
injected seam, not a trivial move. A future reviewer should know the seam is at
the wide end before treating further `gel_ir_compiler.ts` clusters as free
lifts.
