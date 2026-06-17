# One home for the pointer-chain alias scheme (and why a stateful minter was rejected)

The round-4 review's candidate #2 — "one home for SQL alias-minting" — flagged that generated SQL aliases (`p`/`pj`/`cp`/`j`/`lj`/`sg`/`tuple_n`/`g0`/…) are produced across ~20 sites in `gel_ir_compiler.ts` with no single rule, and proposed a stateful `nextAlias(prefix)` minter carried on the lowering context, so collision-safety becomes one invariant. Investigation refuted the strong form and found one clean, safe slice.

**Why the stateful global minter was rejected.** Two facts make an opaque per-compile counter unsafe here:

- **Well-known single-scope anchors referenced by literal.** `"g0"` (the group-source row alias) is hardcoded ~50× across the group lowering; `"j0"`, `"t0"`, `"p0"` similarly anchor their scopes. These are not minted tokens — they are fixed names that many independent functions reference by string literal within one query scope. Minting them to counter values would break every literal reference.
- **Structural, threaded indices.** The indexed families (`p${index+1}`, `cp${i+1}`, `sg${depth+1}`, …) derive the alias from a step index / join depth off a hardcoded base, and aliases are threaded across compile stages via `options.outerScopes` / `options.sourcePathAliases`. An opaque monotonic counter would change every alias string and desynchronise the index arithmetic.

A global minter would therefore rewrite ~50 literal anchors plus every index-arithmetic chain, changing essentially all alias strings — a large behaviour-risky change that the Canonical SQL canonicalization alone cannot make safe (it normalises *generated* aliases by first appearance, but cannot rescue a literal-referenced anchor that no longer matches). The promised "collision-safety as one invariant" is not deliverable without that rewrite, and today's scheme already avoids collisions via scoping. Rejected.

**Decision (done):** Extract the one genuinely-duplicated, byte-identical slice — the **pointer-chain alias scheme** — into `src/sql/pointer_join.ts`, the existing home of pointer-step lowering (ADR 0011 unified the JOIN *shape* there but left the alias *naming* re-spelled at each site; this is its naming sibling):

- `POINTER_ROOT_ALIAS = "p0"` — the FROM-seed alias.
- `pointerStepTargetAlias(stepIndex) = `p${stepIndex + 1}`` — the joined target rows for step `i`.
- `pointerStepLinkAlias(stepIndex) = `pj${stepIndex}`` — the junction alias for step `i`.

The three pointer-path lowerings that each spelled this scheme inline — the scalar pointer path, its correlated variant, and the reversed-links link-property path — now route through the helpers (9 literal sites across the 3 functions). The helpers are pure (depend on nothing) and extend the existing unit-test surface (`tests/pointer_join.test.ts`, +3 tests pinning the scheme, its agreement with the join-builder fixture's `p0`/`p1`/`pj0`, and cross-step non-collision).

**Decision (scoped out, deliberately):**
- The **well-known scope-anchor aliases** (`g0` / `j0` / `t0` / the `p0` *concept* outside the pointer chain) stay inline — they are stable single-scope constants referenced by literal, not a minted family; consolidating ~50 `g0` literals into a constant is churn that *moves* strings without concentrating real complexity (the deletion test: nothing reappears across callers, because there is no per-caller logic — just the same literal).
- The **single-use indexed families** (`cp`/`cpj`, `oe`/`oej`, `lt`/`lj`, `sg`/`sfn`/`sfl`, `tuple_`/`__t`/`__je`/`__arr`/`__e`, `m`, `r_`, `u`, `gfe`, `_pl_`, `_ex`, `_lj`) stay inline — each appears at one site, so a formatter would *move* the string, not concentrate it (same discipline as ADR 0011's first-step-seed scope-out and ADR 0007's comparator scope-out).

**Verification.** Byte-identical by construction — the helpers return the exact strings the call sites built (`POINTER_ROOT_ALIAS === "p0"`, `pointerStepTargetAlias(i) === `p${i+1}``, `pointerStepLinkAlias(i) === `pj${i}``). The Canonical SQL goldens (`inspect_corpus`) and `inspect` stay green (21 tests with the new unit tests). The pointer-heavy behavioural slice (`select` / `linkprops` / `linkatoms` / `advtypes`, 580 tests) ran `204 failed / 373 passed / 3 skipped` **identically** before and after (the failures are the pre-existing partial-conformance baseline). 0 type errors. The new `pointer_join.test.ts` block (8 tests total) is green.

**Consequences.** The pointer-chain alias scheme has one home and one test surface, completing the alias half of ADR 0011 (the JOIN shape and the alias naming now both live in `pointer_join.ts`). A change to the scheme — a new prefix, a dialect-specific rename, a uniqueness fix — happens in one place that the three lowerings share, guarded by its unit tests, instead of three sites that had to agree by inspection.

**Why record it:** a future reader will see the round-4 review name "one home for alias-minting" and find only the pointer-chain scheme consolidated, with `g0` still inline ~50× and a dozen indexed families untouched. That is intentional — the stateful global minter is unsafe here (literal-referenced anchors + structural/threaded indices), and the inline single-use families and scope anchors are *moves*, not *concentrations*. Only the triplicated pointer-chain scheme was a real, safe deepening; the rest is scoped out here with reason so it isn't re-suggested as missed work.
