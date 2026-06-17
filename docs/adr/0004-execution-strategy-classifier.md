# Complete the execution-strategy classifier (candidate #2)

ADR 0003 unified the SQL gate (`lowersToSingleSql`) but left the rest of candidate #2 open: the engine's `needsRuntimeEval`/`bindingNeedsRuntime` AST walk still lived privately in `engine.ts`, and there was no single verdict on how a statement runs. This completes it.

**Decision (done):** Add `src/compiler/execution_strategy.ts` with two exports:

- `selectExprNeedsRuntime(ast, schema)` — the engine's runtime-eval predicate, **moved verbatim** out of `tryRuntimeSelectExprEvaluationAst` (150 lines of `needsRuntimeEval` + `isEnumScalarTypeDef` + `bindingNeedsRuntime`), parameterised on the `select_expr` AST and the schema. The engine's runtime entry is now `if (!selectExprNeedsRuntime(ast, schema)) return undefined;` — same predicate, one definition.
- `classifyExecutionStrategy(ast, artifact, schema) → "sql" | "runtime" | "reject"` — the single verdict. `sql`: executes off the SQL artifact. `runtime`: runtime evaluator / write path. `reject`: the engine raises `E_UNSUPPORTED`.

The engine **dispatches on the classifier**: its two `select_free` reject throws and its `group` reject throw now fire on `classifyExecutionStrategy(...) === "reject"` (each equivalent by construction to the condition it replaced). The Compile inspection seam reports the verdict as its `strategy` Compile fact (the deferred half of ADR 0002), computed by the *same* function — so the engine and the inspector cannot disagree.

**A subtlety the goldens caught.** The first classifier drafted `select_expr`-that-doesn't-lower as `reject`. The corpus snapshot immediately flagged `SELECT count(Issue.watchers)` as `reject` — but the engine does **not** reject a non-lowering `select_expr`; it still runs `runGelSelectSQL` on the (incomplete) artifact. Only `select_free` (mode check) and `group` genuinely reject. Corrected: `strategy` is *which path the engine takes*, distinct from `lowersToSingleSql` (*whether the lowering was clean*) — a `select_expr` can be `lowersToSingleSql: false` yet `strategy: "sql"`. This is exactly the "a strategy fact that lies is worse than none" risk ADR 0002 named, caught by the candidate-#1 test seam before it shipped.

**Verification.** Behaviour-neutral: the 9-file gate-heavy behavioural sample went from `611 failed / 1369 passed` (baseline) to `610 / 1370` — one *fewer* failure, **zero new failures** (the conformance corpus is partial; the delta is within the suite's known order-flakiness and is not a regression). 0 type errors. The classifier's three branches are pinned by 7 deterministic unit tests (`tests/execution_strategy.test.ts`, synthetic artifacts) plus the corpus `strategy` snapshot.

**Consequences.** Candidate #2 is complete: the SQL-vs-runtime decision has one home (`execution_strategy.ts`), consumed by the engine and the inspector. The runtime-eval predicate is no longer a 150-line closure buried in a 15k-line file. Future changes to "how does this run?" happen in one module, guarded by the unit tests and the corpus snapshot.

**Why record it:** a future reader will find `selectExprNeedsRuntime` in a compiler module and the engine importing it — this documents that the move was a verbatim extraction (not a reimplementation), that the engine deliberately dispatches on the classifier at its reject sites, and why `strategy` and `lowersToSingleSql` are intentionally different facts.
