# 0061 — Shared-prefix tuple `count` is a factoring decision; the fence is lost at IR inlining

## Status
Accepted and IMPLEMENTED. Phase 0 (gate disabled) → Phase 1 layer 1 (scope-tree
population) → layer 2 (view-namespace discriminator) → layer 3 (factoring-query
authority + count-gate wiring). The shared-prefix tuple-count collapse is now
sound: it fires for CORRELATED prefixes and declines for FACTORED ones.

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
   - **layer 2 (DONE):** the per-occurrence view namespace — alias/view-shape
     computables compile DETACHED with a fresh `path_id_namespace`
     (`context.py:768`, `stmtctx.py:143`), so repeated `U.cards` don't fuse
     (product) while schema pointers (even computed `owners`) fuse (correlate).
     Reproduced in the walker: a path step traversing an inline alias-shape view
     computable (a `:=`-defined shape element of a WITH binding's body) opens a
     fresh per-occurrence namespace, carried by that step and below. Verified on
     the tree: `(Card.name,Card.cost)` and `(Card.owners.name,Card.owners.deck_cost)`
     fuse (correlated); `(U.cards.name,U.cards.cost)` split into sibling
     `U.cards@vns1`/`@vns2` (factored), and in `U.deck.a.*` only the computable
     `a` splits while the real link `deck` fuses. Behaviour-neutral (scopeTree
     still unconsumed — nothing on the execution path reads it).
2. **Factoring-query authority** in `src/ir/scope_tree.ts` — **DONE**:
   `analyzeTreeFactoring(root)` ports `find_factorable_nodes` over the populated
   tree → `sharedFactorPrefix` / `shouldFactorTogether` / `isAcrossFactoringFence`
   + `pathLeaves`.
3. **Wire the count gate through it** — **DONE**, resolving the PathId question:
   the AST walker can't know the lowered PathId because WITH-inlining erases the
   alias spelling (07b→`Card`, 07a→`User.deck`, 07c→global `Card`), so we DON'T
   make the walker emit real PathIds. Instead the verdict is computed from the
   AST + the WITH-binding shapes (`scope_builder.tupleSharedPrefixCorrelated`,
   which reuses the binding-aware segment logic) and STAMPED on the tuple's Live
   IR Set as `sharedPrefixCorrelated` during `ast_to_ir`'s tuple compilation
   (`ctx.bindingAst` carries the binding value ASTs). The count gate
   (`tryCompileSharedPrefixTupleCount`) fires only when that stamp is `true`.
   Result: `count((Card.name,Card.cost))` now zips to `9` (was the product `81`);
   factored `count((U.cards.name,U.cards.cost))` stays `81`. Full suite: zero
   regressions, zero test-flips (the fix has no prior test). Cases the gate still
   can't reach are unchanged and orthogonal: `08` (`deck_cost` lowers as a
   computed aggregate `sum(...)`, not a scalar pointer leaf, so the structural
   matcher skips it), `07a`/`07c` (pre-existing failures from computed-link /
   filtered-binding lowering, not factoring).

## Collapse is restricted to type-root prefixes (soundness)

The collapse counts the shared prefix's SQL rows, which equals the correlated
tuple count ONLY for a **type-root extent** (e.g. `Card` — no path dedup). A
pointer-chain prefix is unsafe: EdgeQL deduplicates such paths by object
identity, so counting raw join rows over-counts. Measured:
`count((Card.owners.name, Card.owners.id))` zips to **22** where the dedup-aware
answer is smaller. So the gate requires `shared.expr.kind === "type_root"`;
pointer-chain prefixes revert to the product path. `count((Card.name,Card.cost))`
still collapses to `9`. (A dedup-aware collapse for pointer prefixes is future
work.)

## Known-deeper failures this does NOT fix (diagnosed)

These need core path/binding-lowering changes, orthogonal to factoring:

- **`scope_computables_08`** `count((Card.owners.name, Card.owners.deck_cost))`
  → want 16. `deck_cost` lowers as `sum(...)` (not a scalar pointer leaf), and a
  collapse over `Card.owners` gives 22 anyway (backlink dedup). Blocked on
  backlink path-dedup semantics, not the gate.
- **`scope_computables_07a`** `WITH U := User{cards:=.deck}; count((U.cards.name,
  U.cards.cost))` → want 81, gets 45. Root cause: `tryCompileScalarPointerPathSelectSQL`
  (gel_ir_compiler.ts) emits `SELECT DISTINCT <leaf>` — dedups by scalar VALUE
  (`cost`→5) instead of by the leaf's OWNING OBJECT (`card`→9). The DISTINCT is
  load-bearing for multi-link scalar paths; the fix (dedup by owning object)
  touches all of them and needs full-suite validation.
- **`scope_computables_07c`** filtered `WITH U := (SELECT User{...} FILTER
  .name="Phil")` → want 0, gets 81. Root cause: `U.cards` lowers to
  `count(*) FROM (all cards)` with NO reference to `U` — the binding's
  filter/correlation is erased; the computable `cards := Card` is evaluated
  globally. A binding-correlation rework.

## Consequences

- Correct-but-untested behaviour change is *deferred*: plain
  `count((Card.name, Card.cost))` currently returns the product (`81`) where Gel
  returns the correlated `9`. Phase 3 fixes this, so Phase 3 needs a full-suite
  regression pass (other tests may lean on today's product semantics).
- Until Phase 1 lands, the scope-tree authority cannot be wired live — querying a
  reconstructed tree gives wrong answers for the inlined cases (it would re-enable
  the 07b regression).
