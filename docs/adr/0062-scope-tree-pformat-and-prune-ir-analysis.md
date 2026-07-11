# 0062 — Scope-tree pformat serializer; prune the IR-derived scope analysis

## Status
Accepted and IMPLEMENTED. Behaviour-neutral. Follows ADR 0061 (the scope-tree
factoring work) and mirrors the `pathid_format.ts` precedent.

## Context

The scope cluster had accumulated three things that look alike but are not:

1. **`buildScopeTreeFromAst`** (`scope_builder.ts`) — the **live, populated**
   tree, walked from the AST so the factoring fences survive WITH-inlining
   (ADR 0061). Pinned by `scope_builder.test.ts`. Plus `tupleSharedPrefixCorrelated`
   (the live tuple verdict) and `countArgIsFactored` (the live single-pointer
   count signal).
2. **`analyzeTreeFactoring`** (`scope_tree.ts`) — the `find_factorable_nodes`
   port that queries the *populated* tree. Test-pinned (`scope_builder.test.ts`)
   as reproducing the live verdict; the convergence target for ADR 0061 layer 3.
3. **`buildScopeAnalysis` + `ScopeAnalysis`** (`scope_tree.ts`) — a second tree
   builder, this one over the **finished Live IR**. **Zero callers.**

Two frictions:

- **The dead builder is the *wrong half*.** ADR 0061 established that the
  factoring fence is erased during `ast_to_ir` WITH-inlining — the factored and
  correlated forms compile to byte-identical IR. So a tree built from the IR
  (`buildScopeAnalysis`) is *structurally incapable* of separating factored from
  correlated; the fences only survive in the AST. It is not merely unused, it
  could never have worked for its stated purpose. It also duplicated
  `analyzeTreeFactoring`'s method names (`sharedFactorPrefix`, `pathLeavesUnder`)
  with a different return type, so a reader met two overlapping query interfaces.

- **The tree had no canonical serialization.** PathIds are pinned against Gel's
  `pathid.py:pformat_internal` via `pathid_format.ts` + `edgeql_ir_pathid.test.ts`.
  The scope tree — a faithful port of `edb/ir/scopetree.py`, whose canonical
  debug form is the `FENCE`/`uid`/`ns~N` tree — had only a bespoke
  `countByName`/`seg` walk in `scope_builder.test.ts` as its test surface.

## Decision

1. **Add `src/ir/scope_tree_format.ts`** — `formatScopeTree(node)`, the
   scope-tree sibling of `pathid_format.ts`. It mirrors `scopetree.py`'s
   `pdebugformat` (tree recursion) + `debugname` (per-node label: FENCE/BRANCH or
   the path id, then `uid:N`, namespaces, `no-factor`, `group`). Path ids route
   through `serializePathId` (the `pathid_format.ts` authority) for real live-IR
   paths; the populated tree's structural `sig:` ids render as their dotted
   segment chain. sqlite-ts models every `debugname` part except Gel's
   `unnest_fence` (`no-unnest`), which it does not track. Pinned by
   `tests/scope_tree_format.test.ts`, which makes the ADR-0061 discriminator a
   one-line assertion: a CORRELATED prefix names `(Card)` once; a FACTORED one
   names `U.cards` twice (`vns1`/`vns2`).

2. **Prune `buildScopeAnalysis` + `ScopeAnalysis`** (and their exclusive helpers:
   the `Builder` class, `isPathStep`/`PATH_STEP_KINDS`, `directChildSets`,
   `isFactoredBinding`). `scope_tree.ts` drops 487 → 154 lines. The remaining
   query interface is the single `TreeFactoring` (`analyzeTreeFactoring`); the
   overlapping `ScopeAnalysis` is gone. `pathIdKey` and `countArgIsFactored`
   (the live external imports) are unchanged.

3. **Name the one factoring-verdict home in docs.** `scope_tree.ts`'s header now
   states the verdict's single conceptual home and its two entry points by
   argument shape (`tupleSharedPrefixCorrelated` for tuples, `countArgIsFactored`
   for single-pointer counts) plus the convergence target (`analyzeTreeFactoring`).
   A re-export was rejected: `scope_builder.ts` imports `pathIdKey` from
   `scope_tree.ts`, so re-exporting `tupleSharedPrefixCorrelated` the other way
   would create an import cycle. The consolidation is therefore documentation +
   co-location, not a moved symbol.

## Faithfulness gap (intentional, recorded)

The populated tree carries STRUCTURAL `sig:` path ids (segment chains, no
derived names), so a node renders as `(Card.name)`, not Gel's
`(default::Card).>name[IS std::str]`. The FENCE/BRANCH **shape** matches Gel; the
derived **names** do not yet. Real names land when the tree is wired with real
PathIds (the Gel-parity naming work + ADR 0061 layer-3 convergence) — at which
point `scope_tree_format.ts` renders them through `serializePathId` with no
change here. The golden test pins sqlite-ts's *own* output, not a 1:1 match
against Gel's `scopetree.py` goldens; the latter is the layer-3 milestone.

## Consequences

- `isFactoringProtected` (stamped at `ast_to_ir.ts:8044`) loses its only reader
  (`isFactoredBinding`). The stamp is now inert — written, never read. Left in
  place: removing it touches the mutually-recursive `ast_to_ir` builder, and it
  is the broader fence signal layer-3 convergence will likely re-consume.
- The scope tree gains a real test surface (serialization goldens) and a debug
  tool, replacing bespoke structural assertions.
- Zero behaviour change: the prune removed only unreachable code; all 18 scope
  tests (`scope_builder`, `scope_factoring_gate`, `scope_tree_format`) pass.
