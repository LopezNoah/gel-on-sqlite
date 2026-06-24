# Extract function-call dispatch into runtime/function_dispatch.ts

The round-10 review's candidate #3 ("worth exploring", with the caution *"verify
the dep set stays at ~3 before committing, or the seam reaches too deep"*):
engine.ts held the runtime function-call machinery — stdlib lookup, user-function
overload resolution (`resolveUserFunctionOverload` + `inferStaticArgType` /
`runtimeArgTypeName` / `paramAcceptsArgType`), argument binding (`bindFunctionArgs`),
and the two UDF body forms (`evaluateExprBody` / `evaluateFunctionExpr`, and the
`with`-prefixed SELECT run through the engine), all reachable only end-to-end.

**Finding (the dep set is small — this one extracts cleanly):** the overload /
binding / expr-eval functions are pure (schema reads + local helpers only). The
one entry point with engine coupling, `executeFunctionCall`, reaches just two
non-pure capabilities: `executeQuery` (running a UDF's SELECT body — the engine
entry point) and `countRuntimeSetCardinality` (for `std::count`). The small pure
helpers it also used — `literalToEdgeQL`, `isRecordRow`, `runtimeArgTypeName` —
are cluster-only, so they moved in rather than being injected.

**Decision (done):** lift the cluster into `src/runtime/function_dispatch.ts`,
injecting the two engine capabilities via a `FunctionDispatchDeps` record (the
evaluator/ADR 0044, globals/ADR 0054 idiom). `resolveStdlibFunction` /
`executeStdlibFunction` / `AppError` are pure imports; shared types come
type-only from engine.ts. `executeFunctionCall` takes `deps` (placed before its
optional `staticArgTypes` to satisfy TS) and destructures at the top, so the
body is byte-identical. Three exports — `executeFunctionCall`,
`resolveUserFunctionOverload`, `inferStaticArgType` (the latter two are pure and
already injected into the runtime evaluator, which now receives them unchanged;
`executeFunctionCall` is wrapped at the evaluator-deps site to supply
`fnDispatchDeps()`). The engine supplies the deps via a lazy `fnDispatchDeps()`
factory (TDZ, as with `globalsDeps`). Two orphaned engine imports
(`executeStdlibFunction`, `FunctionExprDef`) were removed.

**Scoped out, deliberately:** the AST-level **inline**-DML-UDF expansion helpers
(`callArgToExpr`, `trivialUdfBodyExpr`, `buildUdfParamSubstitutions`,
`substituteParamRefs`) are a *different* concern — rewriting the AST to splice a
DML-bodied UDF call inline (`expandInlineDmlFunctionCalls`), not runtime
dispatch — and stay in engine.ts. The review's "UDF dispatch" framing lumped
them together; they are not part of this seam.

**Verification.** Behaviour-neutral: `tsc --noEmit` clean, `eslint` clean
(0 errors). The canonical-SQL goldens (`tests/inspect.test.ts`,
`tests/inspect_corpus.test.ts`) pass. Against a stashed committed-`2b465c9`
baseline, `edgeql_functions` is identical run-for-run (142f/204p, the stdlib +
UDF corpus). `edgeql_functions_inline` differs by one test between runs, but the
**same current code varies 72–74 failures run-to-run**, and a name-level diff
showed the only varying tests are `insert_link_02` / `update_link_02` — the
documented-flaky pair, not a regression. New unit surface:
`tests/function_dispatch.test.ts` (4 tests) drives literal static-typing,
overload selection by runtime arg type, and the `std::count` → injected-counter
path with stubs — no DB, no compiler.

**Consequences.** Function-call dispatch and overload resolution have a focused,
stub-driveable home; the evaluator's two previously-injected engine references
(`executeFunctionCall`, `resolveUserFunctionOverload`) now resolve to a named
module. engine.ts sheds ~400 lines (11.2k → 10.8k). Like ADR 0054 and unlike
ADRs 0051/0052, the carded cleanness held — the dep set is two, exactly the kind
of small seam the review said to confirm before committing.
