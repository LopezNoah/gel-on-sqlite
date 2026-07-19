# Relation is the path-resolution authority for migrated lowering slices

## Status

Accepted and implemented.

## Decision

SQL-lowering constructs register ambient row paths when range variables are introduced and resolve them through `Relation`. The former `outerScopes`, `sourcePathAliases`, `multiScalarBindings`, and `scopedAggRoot` compile-option channels have been removed. Exact rows use the `source` aspect, json_each elements use `iterator`, object identity uses `identity`, and fresh type references correlate through type-plus-namespace scope keys.

`Relation` owns path provider and aspect resolution only. Correlation permission and factoring remain with the AST-built scope tree and the surviving ADR-0059/0061 facts: finished Live IR cannot recover a factoring fence erased by WITH-inlining, so successful path resolution must never be treated as permission to factor.

The migration proceeded through filtered `select_expr`, scoped aggregate arguments, ordinary SELECT/FILTER/ORDER sources, nested shapes, correlated `EXISTS`, FOR anchoring, independent-subquery classification, and multi-scalar iteration. A single-source scalar operator explicitly registers its current row as aggregate-visible in a child Relation, and SET OF aggregate arguments consume only that local role. Ordinary and enclosing source scopes remain path-resolvable but are not aggregate-visible, so a free `count(Type)` inside an inlined function still counts the full extent.

FOR tuple slots, link properties, and GROUP row projections retain construct-local lowering maps or semantic projection metadata. They do not flow through `GelIRCompileOptions` as generic row-path authorities and do not compete with Relation for ambient source, identity, or iterator resolution.
