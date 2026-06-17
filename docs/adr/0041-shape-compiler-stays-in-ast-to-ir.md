# Shape compilation stays in ast_to_ir (no clean shape_compiler module)

A round-6 architecture review proposed extracting a `shape_compiler.ts` module — `compileShape` (the ~863-line shape loop) plus its nested closures (`expandSplatEntries`, `withShapeModifiers`, `compileLinkPropertyExpr`) and the scattered shape validators (`validateComputedShapeElement`, `inferComputedShapeIsMany`, `validateSplatTypeIntersections`). Like the `pointer_nav` proposal (ADR 0040), the boundary does not hold on implementation.

**Finding (the same false positive as ADR 0040, stronger):** `compileShape` is **mutually recursive with the expression compiler** and depends on the shared TypeRef-resolution layer:

- `compileShape` → `compileFreeObjectExpr` (4 calls) — computed shape elements (`foo := <expr>`) are arbitrary expressions;
- `compileFreeObjectExpr` → `compileShape` (2 calls) — expressions contain shaped subqueries (`SELECT X { … }`);
- `compileShape` also calls `resolvePointerRef` (7), `extendPathSet` (12), `resolveTypeRef` (5), `resolveBacklinkPointerRef`, `extendPathSetDirectional`, and `compileInsertValue`.

The expression↔shape mutual recursion is intrinsic to EdgeQL's grammar (a shape contains computed expressions; an expression contains shaped subqueries), so `compileShape` cannot be separated from `compileFreeObjectExpr`. Moving `compileShape` to its own module would import `compileFreeObjectExpr` (and the navigation layer) from `ast_to_ir.ts` while `ast_to_ir.ts` imports `compileShape` back — a runtime cycle, against this project's no-cycle discipline (ADRs 0034/0036/0037/0038/0039 are all one-directional), and a cycle through the builder's hot core rather than a leaf.

**Decision (done):** keep shape compilation in `ast_to_ir.ts`. `ast_to_ir.ts` is one mutually-recursive builder — statement → expression → shape → computed expression → shape → … all sharing the TypeRef-resolution vocabulary — and `compileShape`/`compileFreeObjectExpr`/the resolution layer are nodes in that single recursion, not separable modules. Splitting along the proposed seam would create a cycle, not a deeper module.

**Scoped note:** the shape **validators** (`validateComputedShapeElement`, `inferComputedShapeIsMany`, `validateSplatTypeIntersections`) looked like candidate leaf extractions, but they too consult the navigation layer (`resolvePointerRef`/`resolveTypeRef`) and are only meaningful mid-shape-compile, so they share the same fate. The genuinely-pure, value-returning inference that *could* be pulled out of this file already was — `ast_inference.ts` (ADR 0038).

**Why record it:** the review carded `shape_compiler` as its own candidate; a future review will re-suggest it. The reason it cannot be a clean module is structural and worth stating once: shape and expression compilation are mutually recursive in `ast_to_ir.ts`. If that file is ever split, it splits as a whole builder (statement/expression/shape/resolution together), not into `shape_compiler` + `expr_compiler` + `pointer_nav` — those seams do not exist in EdgeQL's grammar.
