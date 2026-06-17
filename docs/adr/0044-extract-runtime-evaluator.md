# Lift the Runtime evaluator into its own module behind a deps seam

`tryRuntimeSelectExprEvaluationAst` — the TypeScript interpreter for the `select_expr` constructs that don't lower to SQL (free objects, FOR iteration, runtime aliases, inlined UDFs) — was a **1,680-line closure** inside `engine.ts`, wrapping a nested **1,314-line, 62-case `evalExpr`**. It had no interface of its own: the only way to exercise it was end-to-end through `executeQuery` (parse + schema + live SQLite). Every prior round flagged it; `docs/adr/0014` shipped the co-iteration helper as "a first safe slice; the full `evalExpr` extraction is deferred," and rounds 4–5 deferred it again. The reason was always the same — `evalExpr` closes over engine state and reaches back into engine machinery (function execution, link traversal, row reads), so a naive move wouldn't compile and a rewrite would risk behaviour.

**Decision (done):** the interpreter lives in `src/runtime/evaluator.ts` as

```ts
runSelectExprEvaluation(db, schema, ast, context, deps): QueryResult | undefined
```

The 16 engine capabilities it reaches back into are passed in through an explicit `SelectExprEvaluatorDeps` seam rather than captured by closure: `evaluateRuntimeAggregate`, `executeFunctionCall`, `executeMutationBinding`, `findFieldDef`, `findRuntimeLinkDef`, `inferStaticArgType`, `likeMatch`, `materializeFieldValue`, `normalizeRuntimeFloat`, `qualifiedRuntimeAliasName`, `qualifyRuntimeTypeName`, `quoteIdent`, `readRuntimeTypedAliasSourceRows`, `resolveBacklinkRowsForSubject`, `resolveUserFunctionOverload`, `runtimeAliasPredicateMatches`. The interpreter body itself is **byte-identical** to the original closure — the deps are destructured into the same local names the body always used (`const { … } = deps;`), so not one line of the 1,680-line implementation changed. Everything else it uses (`coIteratedBinding`, `applyLimitOffset`, `qualifiedTypeName`, the AST types, …) it imports directly from the same modules `engine.ts` did.

`engine.ts` keeps a thin wrapper of the original name that supplies the deps, and shrinks by 1,641 lines:

```ts
const tryRuntimeSelectExprEvaluationAst = (db, schema, ast, context) =>
  runSelectExprEvaluation(db, schema, ast, context, selectExprEvaluatorDeps());
```

Two details make this safe and drift-proof:

- **Lazy deps, hoisted factory.** `selectExprEvaluatorDeps()` is a `function` (hoisted, so the wrapper above can call it) whose body reads the 16 module functions only when *called* — at query time, after module load — so none are touched in their temporal dead zone, even though most are defined hundreds of lines *after* the wrapper. A `const` object literal at the wrapper site would throw `Cannot access 'executeFunctionCall' before initialization` at load.
- **`typeof`-derived deps type.** `export type SelectExprEvaluatorDeps = ReturnType<typeof selectExprEvaluatorDeps>` — the evaluator's `deps` parameter type is *derived from the object actually passed*, so the seam can never drift from the wiring. `evaluator.ts` imports that type from `engine.ts`; the cycle is **type-only** (erased at runtime), and the single runtime edge is `engine → evaluator`.

**The seam is real — two adapters.** Production wiring (the engine wrapper) is one; `tests/evaluator.test.ts` is the other, driving `runSelectExprEvaluation` directly with a fresh `:memory:` db and **stub deps that throw if called**. A FOR-iteration query (`SELECT (FOR x IN {1,2,3} UNION (x))`) evaluates to `[1,2,3]` touching none of the 16, proving the interpreter's own cases run in isolation; a bare `SELECT 1 + 1` returns `undefined`, exercising the routing gate (`selectExprNeedsRuntime`) without the engine.

**Scoped out, deliberately.** The 16 back-edges are *not* removed — the evaluator genuinely needs engine capabilities (UDF execution with overload resolution and inlining, link-junction traversal, typed-alias row reads). Injecting them makes the coupling **explicit** instead of hidden in closure capture; eliminating it would mean lowering those constructs to SQL, which is the fundamental-limit territory of `docs/adr/0004` (free objects, general UDFs, mutation-bodied FOR), not a refactor. The 62-case `evalExpr` is also not further decomposed here — that is a separate, behaviour-gated effort; this change is a pure relocation behind a seam.

**Verification.** `tsc` clean — which on its own proves dep-completeness (every identifier in the moved body resolves to an import, a dep, or a local; nothing fell through to a global) and that the `ReturnType<typeof>` deps type matches the destructure. Full suite (~4,075 cases) diffed against the pre-change baseline: failing-set total unchanged (964 = 964); the two deltas (`insert_iterator_03`, `insert_dependent_03`) are both the suite's documented order-flakiness (the former fails ~3-of-4 isolated runs on the unmodified baseline), not regressions.

**Gotcha worth recording.** The original source uses a literal **NUL byte** (`\0`) as a separator inside three template literals (`` `${concreteName}\0${String(row.id)}` ``, `.join("\0")`). BSD `awk` truncates lines at NUL, so the first splice silently corrupted those three lines (all in the part of `engine.ts` that stayed). The move was redone with a byte-preserving (`latin1`) Node splice. Any future mechanical slicing of these files must be NUL-safe — verify with a forced `diff -a` of the untouched regions, not `awk`/`sed`.

**Why record it:** a future reader will find a `selectExprEvaluatorDeps()` factory near the bottom of `engine.ts`, a thin wrapper far from it, and `evaluator.ts` type-importing from `engine.ts`. The factory is lazy-and-hoisted on purpose (TDZ), the type is `typeof`-derived on purpose (anti-drift), and the type cycle is intentional and harmless (erased). The deps are a coupling surface to keep *visible*, not to grow — adding one means the evaluator reaches deeper into the engine, which is the signal to ask whether that construct should lower to SQL instead.
