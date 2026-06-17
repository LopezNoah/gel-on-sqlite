# Pointer navigation stays in ast_to_ir (no clean pointer_nav module)

A round-6 architecture review proposed extracting a `pointer_nav.ts` module — `resolvePointerRef` + `resolveBacklinkPointerRef` + `extendPathSet`/`extendPathSetDirectional` + their schema-walk helpers — as a deep module with a small interface (`resolvePointerRef(ctx, source, field) → PointerRef`). On implementation the boundary does not hold.

**Finding (a false positive, like ADRs 0024/0025):** `resolvePointerRef`'s transitive dependency closure is essentially the whole **TypeRef/schema-resolution layer** at the top of `ast_to_ir.ts`, not an isolated cluster:

- `resolvePointerRef` → `getResolvedSchemaType`, `resolveTypeRef`, `pointerRefFromField`, `pointerRefFromLink`, `idPointerRef`, `isUniversalObjectRefName`, `listSchemaTypeDefs`, `typeRefFromTypeDef`, `qualifyTypeNameOf`, `resolveBacklinkPointerRef`;
- `resolveTypeRef` → `getSchemaType`, `typeRefFromTypeDef`, `universalObjectTypeRef`, `parseTupleStructuredTypeRef`, `unknownTypeRef`, `BUILTIN_SCALAR_NAMES`, `qualifyTypeName`;
- `parseTupleStructuredTypeRef` → `scalarTypeRef`, recursive `resolveTypeRef`, `coerceArgToNamedTupleType`; and the sibling `resolveSubjectTypeRef` → `resolveBinding`.

That closure is ~20 interleaved helper functions (spread through `ast_to_ir.ts:322–1186`, interspersed with unrelated builder helpers), and the primitives are used **pervasively** across the builder — `resolveTypeRef` at 48 sites, `resolvePointerRef` at 40, `extendPathSet` at 27, `getResolvedSchemaType` at 13. They are the IR builder's shared vocabulary for turning names/refs into the IR's `TypeRef`/`PointerRef` types.

Consequently there is **no cycle-free, small-interface subset to extract**:

- Moving only `resolvePointerRef` + `resolveBacklinkPointerRef` (the "deep" pieces) forces importing ~9 primitives back from `ast_to_ir.ts` — a runtime import cycle (`ast_to_ir ↔ pointer_nav`), against this project's established no-cycle discipline (cf. ADRs 0034/0036/0037/0038/0039, all kept one-directional).
- Moving the whole ~20-function layer is cycle-free (one-directional, `ast_to_ir` imports it back) but is a ~750-line file relocation with a ~20-export interface — a reorg that buys locality and an import-for-tests surface, not the small-interface *depth* the review imagined. The interface stays wide because the callers genuinely use the whole vocabulary.

**Decision (done):** keep the pointer-navigation / TypeRef-resolution layer in `ast_to_ir.ts`. It is not a shallow pass-through hiding behind a small interface; it is the builder's shared resolution vocabulary, and `resolvePointerRef` already *is* deep against its 40 call sites (those callers don't reimplement the schema walk). Relocating it would not change that — it would only move the layer and widen a module boundary.

**Why record it:** the review's top recommendation was this extraction; a future review will re-surface it unless the entanglement is on record. The pointer-resolution logic is inseparable from the shared TypeRef-resolution layer (`resolveTypeRef` → tuple/scalar/universal/binding resolution), so a `pointer_nav` module is either a runtime cycle or a wide-interface file-reorg — neither a depth gain. If `ast_to_ir.ts` is ever split, this whole layer moves as one unit (a navigation/resolution file), not as a carved-out `pointer_nav`. The genuinely testable seams in this area were captured elsewhere: `TypeMemberResolver` (inheritance/overload, ADR 0036) and `ast_inference` (AST-shape inference, ADR 0038).
