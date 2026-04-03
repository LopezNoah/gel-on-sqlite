# SPEC-035: Single-Statement Shape Lowering and Aggregation Strategy

Status: Implemented
Owners: sqlite-ts Compiler and Runtime
Last Updated: 2026-04-02

## Purpose

Define a sqlite-ts plan to lower nested shapes, backlinks, and multi links into a single SQL statement (or tightly bounded statement set) so query execution avoids runtime N+1 follow-up queries and more closely matches Gel's PostgreSQL compiler strategy.

## Scope

- SQL lowering strategy for nested link shapes and backlinks.
- Aggregation strategy for multi results (array or JSON aggregation in SQLite).
- Runtime materialization contract when SQL returns pre-aggregated nested payloads.
- Traceability to Gel compiler areas that currently implement equivalent shape packing/aggregation behavior.

## Non-Goals

- Immediate implementation in sqlite-ts.
- Full binary protocol parity.
- Query planner cost optimization beyond deterministic lowering correctness.

## Requirements

- R1: sqlite-ts MUST provide a lowering path that can compile nested shape queries without per-row runtime follow-up SQL queries.
- R2: Multi nested fields/backlinks MUST be aggregated deterministically in SQL (stable ordering where requested).
- R3: Link-level `filter`, `order by`, `offset`, and `limit` semantics MUST remain equivalent after aggregation lowering.
- R4: Lowering MUST preserve shape cardinality semantics (singleton vs multi) and empty-collection behavior.
- R5: sqlite-ts MUST document and test any deliberate deviations from Gel behavior in nested aggregation output format.
- R6: SQL trace output MUST expose all generated statements when fallback multi-query execution is used.

## Behavior and Flows

- Compiler selects a shape-lowering mode:
  - `single_statement` (preferred): nested/link/backlink data produced via correlated subqueries/joins and SQL aggregation.
  - `fallback_multi_query` (compatibility): existing runtime expansion path for unsupported forms.
- For `single_statement`, lowering emits target-specific aggregation expressions:
  - SQLite JSON1-style (`json_group_array`, `json_object`) and/or deterministic scalar packing for nested rows.
  - explicit ordering subqueries when nested order is requested.
- Runtime materializer decodes aggregated payloads once per top-level row and applies final shape mapping.
- Trace output includes primary SQL plus any fallback statements.

## Gel Reference Anchors

The following Gel compiler areas are the upstream reference for shape compilation and SQL-side packing/aggregation behavior:

- `edb/pgsql/compiler/shapecomp.py` (`compile_shape`) - shape element compilation and subquery wrapping for non-singleton/complex shape elements.
- `edb/pgsql/compiler/relctx.py` (`set_to_array`) - SQL-side deterministic array aggregation/coalesce behavior for multi paths.
- `edb/pgsql/compiler/relgen.py` (`set_as_subquery`, set relation generation pipeline) - relation-level set compilation and subquery orchestration.
- `edb/pgsql/compiler/output.py` (`output_as_value`, serialization helpers) - output packing/serialization strategy for compiled values and tuples.

## sqlite-ts Current Status (2026-04-02)

- Select lowering emits single-statement SQL for nested links and backlinks using SQLite JSON aggregation (`json_group_array` + `json_object`) and correlated subqueries.
- Runtime materialization now consumes aggregated payload columns for nested collections and backlinks, avoiding per-row follow-up SQL in supported forms.
- SQL trace keeps `primary` + `trail`; with single-statement lowering enabled, nested shape queries keep `trail` bounded to one statement unless explicit fallback paths are used.

## Traceability

- sqlite-ts target code:
  - `sqlite-ts/src/compiler/semantic.ts`
  - `sqlite-ts/src/sql/compiler.ts`
  - `sqlite-ts/src/runtime/engine.ts`
  - `sqlite-ts/src/http/server.ts`
- sqlite-ts planned tests:
  - `sqlite-ts/tests/engine.test.ts`
  - `sqlite-ts/tests/http.test.ts`
  - `sqlite-ts/tests/lifecycle.test.ts`

## Open Questions

- Q1: Which deeply polymorphic or future computed forms should intentionally force `fallback_multi_query` once they are added?
- Q2: Should sqlite-ts introduce shape payload schema/version tags to support future protocol evolution without cache invalidation coupling?

## Change Log

- 2026-04-02: Initial draft created to track single-statement nested shape/backlink aggregation parity work.
- 2026-04-02: Implemented single-statement JSON aggregation lowering for nested links/backlinks and runtime payload decoding.
