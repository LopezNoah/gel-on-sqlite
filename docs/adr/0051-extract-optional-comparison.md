# Extract the set-level nullable-operator algebra into optional_comparison.ts

A round-10 architecture review carded `gel_ir_compiler.ts` (13.8k lines, the
largest module and the least directly tested) as having cohesive *leaf*
algebras buried in it with no name and no test surface. The set-level
nullable-operator lowering is one: EdgeQL's `??` set-level coalesce and
`?=` / `?!=` optional comparison, which lower by distributing nullability
across union branches (empty-side fallbacks, shared-LCP iteration, a
correlated multi-link probe). It lived as four module-private arrows —
`tryCompileSetLevelCoalesceSQL`, `describeSetLevelSide`,
`compileCorrelatedOptionalCompareRows`, `tryCompileSetLevelOptionalCompareSQL`
(~600 lines) — plus the `SetLevelSideDescriptor` type, exercised only
end-to-end.

**Finding (the candidate over-claimed cleanness — verify before extracting):**
the four functions are *not* a free-standing leaf. They are mutually recursive
with the value/predicate/source dispatchers (`compileValueSetSQL`,
`compilePredicateSetSQL`, `compileSelectSource`, `compilePolymorphicSource`,
`compileScalarSelectSQL`) and reach ~9 pure collectors/helpers
(`collectTypeRootIds`, `collectScalarPointerSources`, `collectInnerWhereClauses`,
`collectReferencedColumns`, `referencesUnboundAlias`, `shouldUseLinkTable`,
`linkTableNameForPointer`, `columnForPointer`, `collectPathIdKeys`, `pathIdKey`).
A direct import of those would form a module cycle, against the no-cycle
discipline (ADRs 0034/0036/0038/0039).

**Decision (done):** lift the cluster into `src/sql/optional_comparison.ts`,
reaching back through the **existing** `SqlLoweringContext` seam (ADR 0006) —
the same indirection `function_lowering.ts` / `group_lowering.ts` already use to
live as separate modules despite calling the dispatchers. The five dispatchers
were already on the context; the ten pure helpers were added to it (the context
is already a documented grab-bag of dispatchers *and* helpers, so this is the
established idiom, not a new mechanism). The helper *definitions* did not move,
so no other call site changed and no transitive dep-closure had to be chased.
Each moved function takes `deps: SqlLoweringContext` as its last parameter and
**destructures it at the top**, so the bodies are byte-identical to the inline
originals; the only body edits are the three intra-cluster `describeSetLevelSide`
calls, which now thread `deps`. The four external call sites in
`gel_ir_compiler.ts` pass `sqlLoweringContext()`.

**The cost, recorded honestly:** the seam is wide — the consuming module reaches
~14 back-edges (5 dispatchers + 9 helpers), comparable to the runtime
evaluator's 16 (ADR 0044), and it grows the shared `SqlLoweringContext` from 22
to 32 members. The caller-facing interface stays small and deep
(`(expr, params, target, options, [outerWheres], deps) → string | null`); the
back-edges are the implementation's coupling, not the interface. This is the
upper end of what the codebase has accepted for an extraction — recorded so a
future reviewer weighs the locality/test-surface win against the wide seam
rather than assuming it was free.

**Verification.** Behaviour-neutral, proven directly: `tsc --noEmit` clean,
`eslint` clean on all three changed files. The canonical-SQL goldens
(`tests/inspect.test.ts`, `tests/inspect_corpus.test.ts`) pass — no emitted SQL
changed. The heavy operator suites are byte-identical to a stashed-HEAD
baseline: `edgeql_coalesce` (all pass), and `edgeql_expressions` +
`edgeql_scope` produced an identical `246 failed / 256 passed` before and after;
`edgeql_filter`'s 4 pre-existing failures are unchanged. New unit surface:
`tests/optional_comparison.test.ts` (3 tests) pins the `??` UNION-ALL fallback
shape and the `?=` / `?!=` `IS` / json-boolean / empty-fallback shapes through
the inspect seam.

**Consequences.** The nullable-operator algebra has a named home and a named
test surface; a change to its lowering now fails `optional_comparison.test.ts`
by name. `gel_ir_compiler.ts` sheds ~700 lines. The twin path-existence cluster
is extracted the same way in ADR 0052.

**Why record it.** The review carded this as a "clean byte-identical mechanical
lift depending only on a few pure helpers." It is not — it is mutually
recursive with the dispatchers and needs a 14-edge injected seam. The lift is
still worthwhile (locality + a test surface for the least-tested giant) but a
future reviewer should know the cleanness was over-claimed and the seam is at
the wide end, not re-discover it.
