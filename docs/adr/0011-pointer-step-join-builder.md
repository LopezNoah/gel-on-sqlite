# Extract the pointer-step JOIN builder (one home for the four join shapes)

The round-3 architecture review's candidate #2 found that lowering a pointer chain to SQL — joining each step's target rows onto the previous step's alias — was re-derived inline across ~9 lowering functions in `src/sql/gel_ir_compiler.ts`. There are exactly four shapes (junction-table vs inline-`<name>_id`-FK, each × inbound/outbound), and every site spelled all four out, differing only in alias names (`p`/`pj`, `cp`/`cpj`, `j`, `oej`/`lj`, `_lj`). ~800 lines of shallow spread: change the join rule and you hunt for every copy.

**Decision (done):** Add `src/sql/pointer_join.ts` exporting `pointerStepJoinSql(step)` — the single definition of a non-terminal pointer step's JOIN fragment (leading-space-prefixed, byte-for-byte equal to the inline form). It takes what varies with context — `direction`, `previousAlias`, `nextAlias`, the already-compiled `targetSource` (a polymorphic-source subquery or a plain `"table" alias`), and either `{linkAlias, linkTable}` or `{inlineColumn}` — and emits the four shapes:

```
junction outbound:  JOIN <link> lj ON lj.source = prev.id  JOIN <target> nx ON nx.id = lj.target
junction inbound:   JOIN <link> lj ON lj.target = prev.id  JOIN <target> nx ON nx.id = lj.source
inline   outbound:  JOIN <target> nx ON nx.id = prev.<fk>
inline   inbound:   JOIN <target> nx ON nx.<fk> = prev.id
```

It depends only on `quoteIdent` (a leaf in `codegen/sql.ts`), so there is no lowering cycle and no need for the `SqlLoweringContext` deps table — it is a pure string builder with a real unit-test surface (`tests/pointer_join.test.ts`, 5 tests pinning the four shapes plus the "non-inbound ⇒ outbound" defaulting the call sites rely on).

**Nine call sites now route through it:**
- Six byte-identical full loops — `tryCompileScalarPointerPathSelectSQL`, `tryCompileLinkPropertyPathSelectSQL` (non-terminal step), the reversed-links json_each path, `buildCorrelatedScalarPointerPath`, the chain-join FROM builder, and the FOR-level join builder — each had its 24-line `if (linkTable) {inbound/outbound} else {inbound/outbound}` replaced by one `pointerStepJoinSql({…})` call.
- Three first-step-correlation idioms (`oej`, `lj`, `_lj`) seed the FROM with the first junction-and-target join and correlate to the previous alias via a `WHERE`, then append subsequent steps. These were restructured from `if (inbound) { if (!fromSql) … else … }` to `if (!fromSql) { seed } else { pointerStepJoinSql(…) }` — behaviour-identical (the four direction×position combinations produce the same SQL), with only the non-first wiring now routed and the genuinely-different first-step seed left inline.

**Decision (scoped out, deliberately):** the **first-step seeds, single-link correlated subqueries, and `anchorWhere` constructions** are NOT folded into the builder. They are a different idiom — correlation expressed as a `WHERE` term on a seed FROM (e.g. `buildCorrelatedScalarPointerPath`'s root anchor, the `compileLinkedInnerSelect` backlink subqueries, the `EXISTS (… WHERE lt.source = src.id)` membership checks) — not the iterative "append a JOIN onto the previous alias" wiring `pointerStepJoinSql` owns. Forcing them through it would mean a second, differently-shaped entry point; they stay where their context lives. (Same discipline as ADR 0007's comparator scope-out.) The **alias-minting** and **pointer-path extractor** frictions the review also noted are separate candidates, not this one.

**Verification.** Behaviour-neutral. The join-heavy + Canonical-SQL slice (`select` / `linkprops` / `linkatoms` / `advtypes` / `for` / `group` / `insert` / `inspect` / `inspect_corpus`, 1110 tests) ran `285 failed / 822 passed / 3 skipped` both before and after — the failures are the pre-existing partial-conformance baseline; zero new failures. Crucially `inspect_corpus` (the Canonical SQL goldens) is unchanged, so the lowered SQL is byte-identical modulo alias canonicalization — the strongest available evidence that the extraction changed no output. 0 type errors. 5 new unit tests green.

**Consequences.** The four pointer-step join shapes have one home and one test surface. A change to how a step joins (a new storage kind, a NULL-safety fix, a dialect difference) happens in `pointer_join.ts`, guarded by its unit tests, instead of in nine places that can drift. The aliases and target-source construction — the parts that legitimately vary — stay with each caller.

**Why record it:** a future reader will find `pointerStepJoinSql` consumed by nine functions but several junction joins still inline (the first-step seeds, the correlated-subquery membership checks). That is intentional — those are a different idiom (WHERE-correlation, not per-step JOIN append), scoped out here with reason; only the iterative non-terminal wiring was unified.
