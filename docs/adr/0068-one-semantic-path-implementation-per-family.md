# One semantic path implementation per migrated family

## Status

Accepted as a migration constraint.

## Context

Path expressions can currently travel through two semantic ladders: the direct AST-to-Live-IR path compiler and the AST-to-qlast adapter plus qlast path compiler, with deferral back to the direct compiler. The routes duplicate orchestration while representing different amounts of meaning. In particular, the adapter can flatten compound type intersections, shape-carrying bindings can defer, and existing parity coverage does not compare carried shapes, PathIds, or binding facts.

This makes fallback appear safe even when one route has already discarded facts needed by the other. It also gives path semantics two places to evolve. ADRs 0040 and 0041 still apply: pointer navigation, shape compilation, and the shared type-resolution vocabulary are mutually recursive parts of the AST-to-Live-IR builder and must not be extracted behind a false module seam.

## Decision

Each migrated path family will have exactly one semantic implementation. The other route must either adapt losslessly into that implementation or stop at an explicit unsupported frontier before performing semantic interpretation. It must not partially interpret a path and then silently fall back to a second implementation.

This ADR does not choose the direct compiler or the qlast compiler as the universal destination in advance. Ownership is decided per path family after its required meaning can be represented losslessly. Until a family migrates, its existing route may remain; once migrated and covered, the redundant semantic branch is deleted.

Shared resolution vocabulary remains in the AST-to-Live-IR builder. The goal is to remove duplicate orchestration, not to create a separate pointer-navigation or shape-compilation module.

## Consequences

- Migration proceeds by path family, with an explicit boundary between migrated and unmigrated cases.
- Parity tests must compare semantic facts required downstream, including compound type structure, PathIds, carried shapes, and binding identity where applicable, rather than only successful compilation or coarse IR shape.
- An adapter that cannot preserve a required fact must report the family as unsupported instead of flattening the fact and relying on fallback.
- Fixes to a migrated path family have one semantic home, and completion is demonstrated by deleting its second interpretation branch.
- The final balance between direct and qlast-backed families remains an outcome of the migration rather than an assumption of this decision.

## Considered options

- Keeping two implementations behind parity tests was rejected because the current representations do not expose enough shared facts for those tests to prove semantic equivalence.
- Choosing qlast as the universal authority immediately was rejected because its adapter is not yet lossless for all path families.
- Choosing the direct compiler as the universal authority immediately was rejected because that would preclude useful qlast migration without evidence that every qlast family should be abandoned.
- Extracting shared pointer or shape semantics into new modules was rejected by the mutual-recursion findings in ADRs 0040 and 0041.
