# First-class identity for object `WITH` bindings

## Status

Accepted.

Object-valued `WITH` bindings will retain first-class semantic identity in the Live IR instead of collapsing to a type root and asking SQL lowering to reconstruct their source iteration. The first increment covers object `SELECT` bindings, including carried shapes and `FILTER`/`ORDER BY`/`LIMIT`/`OFFSET`; physical materialization remains a SQL-lowering choice. References use an opaque compile-local binding identity, while the AST-built Scope-tree remains the factoring authority and `Relation` remains the path-resolution authority.

## Consequences

- `bindingAst` and object-binding shape reconstruction are temporary transport mechanisms, not part of the destination.
- A recognized object `WITH` binding must not fall back to lossy type-root inlining when its source clauses or carried members cannot be represented.
- Nested bindings and shadowing receive distinct identities; names are lexical lookup keys only.
- Runtime-generated object captures use the same Live IR meaning as ordinary object `WITH` bindings.
- The first implementation preserves the existing correlated `9` versus factored `81` behavior and adds behavioral coverage for filtered bindings.
- Scalar, tuple, array, `FOR`, `GROUP`, and free-object bindings remain on their existing paths until a later decision.

## Considered options

- Rich binding provenance on every `Set` was rejected as too broad for the first increment.
- Rebuilding binding scope from finished Live IR was rejected because WITH-inlining has already erased non-binding fences (ADR 0062).
- Extracting pointer navigation or shape compilation was rejected because those proposed seams are mutually recursive with the AST-to-Live-IR builder (ADRs 0040 and 0041).
