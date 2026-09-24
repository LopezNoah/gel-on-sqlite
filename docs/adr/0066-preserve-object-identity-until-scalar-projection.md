# Preserve object identity until scalar projection

## Status

Accepted and implemented.

## Context

A pointer traversal can produce several physical rows for the same target object, while distinct target objects can project the same scalar value. The current SQL lowering handles this inconsistently: `SELECT DISTINCT` over a projected scalar collapses equal values from different objects, but removing that `DISTINCT` exposes duplicate rows when several edges reach the same object. Scalar, object, aggregate, predicate, and shape consumers therefore reconstruct identity and multiplicity independently.

This is the identity-deduplication problem deferred by ADR 0061. ADR 0064 already makes `Relation` the authority for resolving path providers and aspects, but deliberately does not make it the authority for factoring or object-set semantics.

## Decision

Pointer-row lowering will own traversal and deduplication by target object identity. A migrated lowering slice must establish the logical object set before projecting scalar values from it. Consumers must not use `DISTINCT` on the projected scalar as a substitute for object identity, and they must not receive raw edge multiplicity and reconstruct object identity themselves.

`Relation` remains the path-resolution authority, and the AST-built scope tree remains the factoring authority. This decision deepens pointer-row lowering; it does not move either of those responsibilities.

The migration will proceed one locally substitutable lowering slice at a time. Each slice must replace and delete its consumer-specific identity workaround rather than add another parallel identity signal.

The initial implementation completes the deferred ADR 0061 cases. Object pointer sources without edge-dependent link-property projections now deduplicate their projected target rows in pointer lowering, and scalar pointer paths project from rows deduplicated by target `id`. The former `binding:`-namespace multiplicity branch and scalar-value `DISTINCT` fallback have been deleted. Direct and correlated aggregate paths consume those identity-bearing scalar rows, while explicit EdgeQL `DISTINCT` remains a later value-level operation. Link-property-bearing rows retain edge identity and remain a separate migration slice.

Inlined computed aggregate properties retain their owning object source in Live IR. This is cardinality provenance, not a second identity authority: SQL lowering obtains the owner rows from the same identity-preserving pointer source. It allows the factored tuple fallback for `count((Card.owners.name, Card.owners.deck_cost))` to count four owner rows per factor and return `16`, while the AST-built scope tree remains the sole factoring authority.

## Consequences

- Multiple edges that reach one target object contribute that object once.
- Distinct target objects that project equal scalar values retain one projected value per object.
- Aggregates, predicates, and shapes consume the same identity-preserving row semantics as direct selection as their slices migrate.
- Tests must distinguish edge multiplicity, object identity, and projected scalar equality. The minimal regression case is three edges reaching two target identities whose scalar values are equal: the result contains two scalar rows, not one or three.
- Physical row shape and SQL strategy remain implementation details of pointer-row lowering; this ADR requires the semantic ordering of deduplication and projection, not one universal SQL form.
- ADR 0061's pointer-prefix and computed-aggregate regressions are covered alongside the existing `9` versus `81` factoring tests.

## Considered options

- Deduplicating projected scalar values was rejected because equal values do not imply equal object identity.
- Returning every traversed edge row was rejected because repeated edges to one target do not create additional objects in an EdgeQL object set.
- Letting each consumer reconstruct identity was rejected because it duplicates one semantic rule across selection, aggregation, predicates, and shapes.
