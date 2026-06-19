# Extract the AST pre-validation cluster into ast_validation.ts

The round-9 review's candidate #1 found the **AST pre-validation cluster** —
`preValidateStatementAst` plus ~10 throwing `check*` helpers, the
`AstPreValidationCtx`, and their pointer/type-lookup support (`findAstPointer`,
`lookupAstObjectType`, `unionBranchInfo`, `checkInsertStatementAst`,
`checkCorrelatedDmlInTuple`, …) — living as a ~920-line block inside the
12k-line `engine.ts` with **no seam**. The only way to exercise a validator was
to execute a whole query, so a wrong diagnostic surfaced as an integration
failure, not a named rule. This is precisely the half ADR 0038 deferred: 0038
carved the **pure, value-returning** inferers into `ast_inference.ts` and
explicitly left the **throwing validators** in `engine.ts`. This finishes the
pair.

**Decision (done):** Add `src/runtime/ast_validation.ts` exporting
`validateStatementAst(schema, statement, deps, allowUserSpecifiedId)`. The
validator bodies are **byte-identical** to the closure that lived in
`engine.ts`. The only engine state the cluster reached back into — the
runtime-alias registries read by `getRuntimeTypedAliasMap` /
`getRuntimeExprAliasMap` (WeakMap-backed, populated when runtime aliases are
registered) — is **injected** behind a small `AstValidationDeps` record
(`runtimeTypedAliasMap` / `runtimeExprAliasMap`, both probed only for
membership), so the module stays a one-directional dependency with no engine
import cycle. `engine.ts` keeps a thin wrapper `preValidateStatementAst` that
supplies a hoisted `astValidationDeps` const, leaving the two call sites
(`executeQuery` / the script path) unchanged. `preValidationFail` is exported
and re-imported by `engine.ts` for the one **const-subscript** site (a separate
concern, `bigint_index_*`) that reused the helper. `engine.ts` shed ~904 lines.

**Verification.** `tsc --noEmit` clean. Behaviour-neutral: the
validator-exercising slice (`edgeql_insert` / `edgeql_expr_aliases` /
`edgeql_scope`) ran **167 distinct failing test names identically** before and
after — captured by stashing the two files back to HEAD and diffing the failure
sets (empty diff). The failures are the pre-existing partial-conformance
baseline; zero new failures. `tests/ast_validation.test.ts` (9 tests) pins
representative validators (std-lib-type INSERT, explicit `id` with/without
`allow_user_specified_id`, `__type__` assignment, computed-property
modification, a well-formed INSERT, `sum()` of a string) **and** the injected
seam — the alias-rejection now runs against a fake expr-alias registry, no
engine and no alias-registration code.

**Consequences.** The pre-validation cluster has one home and a test surface;
the ~10 `check*` rules are drivable with a parsed `Statement` + a
`SchemaSnapshot`, no SQLite, no execution. The injected `AstValidationDeps` set
is the visible coupling to engine state — growing it is the cue that a validator
is reaching deeper into the runtime, the same signal ADR 0044's 16 evaluator
back-edges established.

**Why record it.** A future reader will find `validateStatementAst` owning the
throwing checks while `ast_inference.ts` owns the pure inferers and may wonder
why they are two modules. The split is deliberate (ADR 0038): pure
value-returning inference (read by AST pre-validation) vs throwing validators
(which raise the reference diagnostics) — now each with its own module and test,
rather than one re-suggesting the other's merge.
