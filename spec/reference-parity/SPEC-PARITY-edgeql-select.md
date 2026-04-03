# SPEC-PARITY: Select (`edgeql/select.rst`)

Status: Draft
Owners: sqlite-ts Core Team
Last Updated: 2026-04-02

## Purpose

Define one-for-one parity targets for `edgeql/select.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [x] S1: `Selecting objects` parity is implemented and covered by tests.
- [x] S2: `Shapes` parity is implemented and covered by tests.
- [x] S3: `Nested shapes` parity is implemented and covered by tests.
- [x] S4: `Splats` parity is implemented and covered by tests.
- [x] S5: `Filtering` parity is implemented and covered by tests.
- [x] S6: `Filtering by ID` parity is implemented and covered by tests.
- [x] S7: `Nested filters` parity is implemented and covered by tests.
- [x] S8: `Filtering on a known backlink` parity is implemented and covered by tests.
- [x] S9: `Filtering, ordering, and limiting of links` parity is implemented and covered by tests.
- [x] S10: `Ordering` parity is implemented and covered by tests.
- [x] S11: `Pagination` parity is implemented and covered by tests.
- [x] S12: `Computed fields` parity is implemented and covered by tests.
- [x] S13: `Backlinks` parity is implemented and covered by tests.
- [x] S14: `Subqueries` parity is implemented and covered by tests.
- [x] S15: `Polymorphic queries` parity is implemented and covered by tests.
- [x] S16: `Polymorphic sets` parity is implemented and covered by tests.
- [x] S17: `Polymorphic fields` parity is implemented and covered by tests.
- [x] S18: `Filtering polymorphic links` parity is implemented and covered by tests.
- [x] S19: `Accessing types in polymorphic queries` parity is implemented and covered by tests.
- [x] S20: `Free objects` parity is implemented and covered by tests.
- [x] S21: `With block` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `edgeql/select.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/edgeql/select.rst`
- sqlite-ts implementation:
  - `sqlite-ts/` (to be linked as work lands)
- sqlite-ts tests:
  - `sqlite-ts/tests/` (to be linked as work lands)

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Audit Notes (2026-04-03)

- Remaining unchecked areas are intentional gaps: general boolean filtering semantics (S5), nested/backlink filters (S7-S8), subqueries (S14), full polymorphic set semantics and polymorphic link filtering breadth (S16, S18), and free objects (S20).
- Remaining unchecked areas are intentional gaps: none for `edgeql/select.rst` sections covered in this parity checklist.
- Current implementation now includes default object selection without explicit shape (`select Type`) returning `id`, plus splat expansion variants, nested link clause chains, computed fields, backlinks, `with`-block scalar aliasing in select filters, and base polymorphic projection/type metadata behavior.
- Filter parity has been expanded with `!=`, `like`, and `ilike` operators for top-level and nested link filter clauses, including scoped `.field` and qualified `Type.field` references.
- Known-backlink filter parity now includes `. <link[is Type] = '<source-id>'` and `!=` forms for object selection, and free-object singleton projections (`select { ... }`) with literal, literal-set, and nested object-select entries.
- Polymorphic-set parity now includes abstract-link target expansion by querying all concrete subtype tables in both SQL single-statement lowering and runtime fallback path traversal.
- Polymorphic-link filtering parity now includes subtype-filtered link projections (`link[is Type]`) with semantic compatibility checks and narrowed target-table expansion.
- Filtering parity now includes boolean expression trees in `filter` clauses (`and`, `or`, `not`, parentheses) with deterministic AST/IR lowering and SQL predicate composition.
- Nested-filter parity now includes independent scoped filter evaluation on nested links (including boolean operators and pattern operators) alongside outer filters.
- Subquery parity now includes computed subquery projections in shapes via parenthesized inline select expressions (executed via fallback multi-query materialization when needed).

## Change Log

- 2026-04-02: Initial parity checklist generated from source headings.
