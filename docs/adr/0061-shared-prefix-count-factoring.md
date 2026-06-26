# 0061 — Shared-prefix tuple `count` is a factoring decision; the fence is lost at IR inlining

## Status
Accepted. Phase 0 (gate disabled) + Phase 1 layer 1 (scope-tree population,
structural) done. Phase 1 layer 2 (view-namespace discriminator) and Phase 1
layer 3 (factoring-query authority + wiring) proposed.

## Context

`count((S.a, S.b, …))` where every tuple element is a single-valued scalar
pointer off the same object set `S` can be lowered two ways:

- **Correlated (zip):** the references to `S` are the *same* iteration, so the
  tuple has one row per `S` and `count = |S|`.
- **Factored (cross):** the references to `S` are *independent* iterations, so
  the tuple is the cartesian product and `count = |S.a| × |S.b| × …`.

EdgeQL distinguishes these by **scope factoring**: two path references factor
(correlate) at their longest common prefix that is visible across *at most one
fence*. A prefix reached through a factored `WITH`/computable sits behind a
fence, so it does **not** correlate.

```edgeql
# correlated — Card is the bound extent, name/cost zip            -> 9
SELECT count((Card.name, Card.cost));

# factored — U is a WITH binding; the two U.cards are independent  -> 81
WITH U := User { cards := Card }
SELECT count((U.cards.name, U.cards.cost));
```

(`edgeql_scope` tests `computables_07a/07b/07c`, `08`.)

The WIP `tryCompileSharedPrefixTupleCount` (introduced with the Relation
pointer-chain source, commit `117c0b3`) collapsed the shared prefix
**unconditionally**, which is correct for the correlated case but regresses the
factored case (07b: 81 → 9). This ADR records why it cannot be salvaged by any
post-IR gate today, and what the real fix is.

## Finding (empirically verified)

The factored and correlated forms compile to **byte-identical IR**. Probing the
full count-argument subtree for both queries:

- leaf `pathId` keys: **identical**
- source `pathId` keys: **identical** (`U.cards.name` inlines to a bare
  `Card` type-root, exactly like plain `Card.name`)
- `namespace`: empty for both
- `isWithBinding` / `isFactoringProtected` / any binding residue: **absent** on
  every set in the subtree (the ADR 0059 mark is stamped only on a *direct*
  scalar count argument, never in the tuple/nested case)
- `views` / `viewShapes`: empty for both
- `Statement.scopeTree`: an **empty stub** — `ast_to_ir.ts` sets
  `scopeTree: createRootScope()` and never populates it

So the factoring fence is **destroyed during `ast_to_ir` WITH-inlining**. No
analysis that runs after the IR is built — neither the `Relation` path resolver
nor a reconstructed `buildScopeAnalysis` tree — can recover it. The Relation
answers *"can I resolve this prefix once?"* (yes); it cannot answer *"is
correlating it here semantically allowed?"* — and right now nothing can.

## How Gel does it

Gel builds its scope tree **during** `ast_to_ir`, attaching paths and fences at
each scope boundary *before* inlining can erase anything, then queries it:

- `attach_path()` / `attach_fence()` — `edb/ir/scopetree.py:405`
- `find_visible()` / `is_visible()` — `:800`
- `find_factorable_nodes()` — `:936`: "search up the tree for an ancestor with
  `path_id` as a descendant such that *at most one* of self and that descendant
  are fenced." That descendant is factorable; the ancestor is the factoring
  point.

sqlite-ts has neither half: the tree is never populated, and the factoring query
does not exist.

## Decision

**Phase 0 (this change):** disable the collapse. `tryCompileSharedPrefixTupleCount`
keeps its structural detection as the live seam but ends at a soundness gate that
returns `null`, so the lowering falls back to the product path — exactly the
pre-Relation behaviour (07b restored to 81, zero regression). Keep the Relation
pointer-chain `compileSelectSourceRelation` (it is the path-resolution layer and
is already exercised by detached-EXISTS via `existence_proof.ts`).

## Plan (Gel-aligned)

1. **Populate the scope tree** — port `attach_path` / `attach_fence` so WITH
   bindings, sub-`SELECT`s, `FOR` bodies and `EXISTS` install fence + path nodes.
   **DONE (layer 1)** as `src/ir/scope_builder.ts` (`buildScopeTreeFromAst`),
   invoked additively in `compileASTToGelIR` like `inferStatementVolatility`.
   Implemented as an AST walk rather than threaded through the mutually-recursive
   builder (cf. ADR 0040/0041): the AST still carries the pre-inlining structure,
   and an additive pass is strictly behaviour-neutral (full suite unchanged:
   747 fail / 3512 pass before and after). Path identities are STRUCTURAL
   signatures (segment names) — enough for prefix fusing/visibility; real IR
   PathIds come with layer 3 wiring. `Statement.scopeTree` is no longer the
   `createRootScope()` stub.
   - **layer 2 (TODO):** the per-occurrence view namespace — alias/view-shape
     computables compile DETACHED with a fresh `path_id_namespace`
     (`context.py:768`, `stmtctx.py:143`), so repeated `U.cards` don't fuse
     (product) while schema pointers (even computed `owners`) fuse (correlate).
     This is the discriminator the count gate needs; mint it in the walker.
2. **Factoring-query authority** in `src/ir/scope_tree.ts` — port
   `find_factorable_nodes` and expose `shouldFactorTogether(a, b)`,
   `sharedFactorPrefix(elements)`, `isAcrossFactoringFence(a, b)`.
3. **Wire the count gate (and Relation) through it** — replace the Phase 0
   soundness gate with a factoring-authority query (needs layers 1+2's tree to
   carry real PathIds so IR leaves map to scope nodes).

## Consequences

- Correct-but-untested behaviour change is *deferred*: plain
  `count((Card.name, Card.cost))` currently returns the product (`81`) where Gel
  returns the correlated `9`. Phase 3 fixes this, so Phase 3 needs a full-suite
  regression pass (other tests may lean on today's product semantics).
- Until Phase 1 lands, the scope-tree authority cannot be wired live — querying a
  reconstructed tree gives wrong answers for the inlined cases (it would re-enable
  the 07b regression).
