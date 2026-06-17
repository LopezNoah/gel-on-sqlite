# Live-IR multiplicity inference (and a shared inference engine)

Continuing candidate 6 (Live-IR inference parity → retire the `semantic.ts` oracle, ADR 0001). After volatility (0015) and cardinality (0016), this ports **multiplicity** (`empty | unique | duplicate | unknown`).

**The gap (measured).** The oracle's `edgeql_ir_mult_inference.test.ts` adapted to read the Live IR's top-level `.multiplicity` passed **0/102** — the Live IR hardcoded `defaultMultiplicity`. All 102 are statement-level (no shape-element multiplicity assertions).

**Decision (done):**

1. **Refactor for reuse.** Cardinality's per-call closure (helpers parameterised on `statement`/`schema`/`activeModule`) was lifted into a shared `makeInferenceEngine(statement, schema, activeModule)` factory in `src/compiler/inference.ts`. `inferStatementCardinality` is now a thin wrapper over `engine.statementCardinality()`. The cardinality helper bodies are unchanged — behaviour preserved (verified: `edgeql_ir_card_live` and the card oracle test stay green).
2. **Port multiplicity into the engine:** `fieldMultiplicityOnType`, `inferUnionMultiplicity`, `objectTypesOverlap`, `inferAstMultiplicity` (the full expression switch), the binding-shape lookup, and the statement-level derivation — including the oracle's `FOR` DISTINCT_UNION rule. Multiplicity reuses cardinality (e.g. an empty cardinality forces empty multiplicity), which is why they now share one engine. `inferStatementMultiplicity` wraps `engine.statementMultiplicity()`.
3. **Wire** into `compileASTToGelIR` inside the same guarded `try/catch` that sets volatility and cardinality, setting `Statement.multiplicity`.

Result: **99/102** (probe 0 → 99). A focused `tests/edgeql_ir_mult_live.test.ts` (19 representative cases) locks it in.

**Why this is safe (additive + guarded).** `multiplicity` is read **0×** by the SQL lowering and runtime — purely additive, cannot change query results; the call is guarded so a pathological AST keeps the default. Confirmed: the exercising slice (`select`/`insert`/`functions`/`expressions`/`group`) is `508 failed / 1098 passed` both before and after — **identical**, zero new. 0 type errors. The other dimensions are not regressed by the shared-engine refactor: card-live (24), volatility-live (17), and all three oracle tests (card 176, volatility 17, mult 102) stay green.

**Decision (scoped out, with reason):** the **3 non-parity cases**: two (`error_01`/`error_02`) assert the compile *throws* on a multiplicity-violation shape — error-detection, not a value, the same non-additive class as scope-tree, handled separately; one (`#70`) is a deep nested double-computed tuple-index over a backlink (`X1 { z := (.<deck[IS User],) } … .z.0`) needing full nested-shape resolution — a rare edge case. Statement-level additive-reachable parity is 100/102; 99 reached.

**Consequences.** Three of five inference dimensions (volatility, cardinality, multiplicity) are ported and share one engine in `inference.ts`. Remaining for oracle deletion: **type** (6 cases) and **scope-tree** (6 error-detection cases — note `checkScopeTreeViolations` already exists as a standalone module; wiring it into the Live IR is the plan, gated on no over-rejection).

**Why record it:** a future reader will see `makeInferenceEngine` hosting both cardinality and multiplicity and may wonder why they share a closure — multiplicity inference genuinely depends on cardinality results, so they share the per-call schema/binding context rather than recomputing it. The shared engine is deliberate, not accidental coupling.
