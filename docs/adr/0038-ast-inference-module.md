# Split pure AST inference out of the validation cluster

The AST pre-validation cluster in `engine.ts` (`preValidateStatementAst` and ~40 `check*`/infer helpers, all top-level functions) mixed two kinds of helper: **validators** that throw on a malformed statement (`checkArrayValuedScalarTarget`, `checkUnionFieldAccess`, …) and **inferers** that return a fact about an AST fragment (a type, a cardinality, a shape). Because the inferers had no home of their own, the only way to exercise one was to feed a whole statement to the validator and observe whether it threw — e.g. `inferArrayValuedType([1,2,3])` could not be checked directly, only via an INSERT that tripped `checkArrayValuedScalarTarget`.

**Decision (done):** add `src/compiler/ast_inference.ts` for the inferers that are **pure** — no schema, no `AstPreValidationCtx`, no throwing, a fact inferred purely from AST shape:

- `inferArrayValuedType` (+ its private `inferArrayElementType` / `literalScalarName`) — array/concat/`array_unpack` element-type inference;
- `literalStdTypeName` — std scalar name from a literal's value + numeric-kind hint;
- `computedExprIsMulti` / `computedElementReferencedField` — computed-body cardinality and referenced field;
- `unwrapSubqueryWrappers` / `bindingSelectShape` — subquery peeling and the shape a WITH binding selects;
- `insertValueHasUnscopedPartialPath` — unscoped partial-path detection in an INSERT shape.

`engine.ts` imports the seven it calls; `literalScalarName`/`inferArrayElementType` stay module-private (only the array trio uses them). `engine.ts` drops 148 lines. The validators stay where they are and call the inferers.

**Scoped out, deliberately:** the **ctx-bound inferers** (`unionBranchInfo`, `bindingUnionBranchInfo`, `scalarPathProperty`, `functionCallArgLiteral`, `resolveCurrentItemPathPointer`, `insertValueProvablyMulti`, `selectFilterGuaranteesSingle`) **stay in `engine.ts`**. They depend on `AstPreValidationCtx` — the validator's own context bundling schema, module, bindings, and the lookup helpers (`lookupAstObjectType`, `findAstPointer`). Moving them would relocate that whole context, not a pure leaf. `exprContainsPartialPathRef` also stays: it is a thin wrapper over the validator's generic `walkAstForValidation`. The split is the pure inferers only.

**Verification.** Behaviour-neutral by construction — every function moved verbatim (the array trio kept its mutual recursion; the only edits are the `function`→`const` form and the import). The validation-heavy slice (`insert`/`select`/`delete`/`advtypes`/`calls`, 879 tests) ran `236 failed / 640 passed / 3 skipped` both before and after, with identical per-file failure counts. `tsc` clean, lint clean. New test surface: `tests/ast_inference.test.ts` (18 unit tests) drives each inferer directly against AST fragments — array/empty/concat/`array_unpack`/`expr`-wrapper element typing, literal-to-std mapping, multi detection, referenced-field peeling, subquery unwrap, binding shape, and unscoped-partial-path detection — none of which previously had isolated coverage.

**Consequences.** AST inference is a value-returning, directly-testable module; validation stays a throwing pass that consumes it. A new inference rule (a new array form, a new literal kind) is added and tested in `ast_inference.ts` without constructing a statement that trips a validator.

**Why record it:** a future reader will see ctx-bound inferers (`unionBranchInfo`, `scalarPathProperty`) still in `engine.ts` and may want to "finish" the move. They depend on `AstPreValidationCtx` (schema + bindings + lookups) — the validator's context, not a pure leaf. The boundary is pure-vs-ctx-bound, drawn deliberately here.
