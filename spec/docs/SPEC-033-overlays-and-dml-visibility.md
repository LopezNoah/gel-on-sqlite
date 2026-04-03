# SPEC-033: Overlays and DML Visibility

Status: Implemented
Owners: PostgreSQL Backend Team
Last Updated: 2026-04-02

## Purpose

Specify overlay semantics used to model data visibility around DML in a single query context.

## Scope

- Overlay operations (`union`, `exclude`, `replace`) and use cases.
- Interaction with DML, policies, and rewrites.

## Non-Goals

- Full transaction isolation behavior in PostgreSQL.
- MVCC implementation details.

## Requirements

- R1: Overlay application must compensate for same-query DML visibility limitations.
- R2: Overlay operation semantics must be explicit and stable.
- R3: Overlay interactions with policy and rewrite paths must be deterministic.

## Behavior and Flows

- Compiler registers overlays per path id.
- Data reads route through overlay relation where present.
- Overlay operation chosen by mutation semantics.
- sqlite-ts maps DML to deterministic overlay operations (`insert -> union`, `update -> replace`, `delete -> exclude`).
- sqlite-ts query-unit execution propagates collected overlays into subsequent statement compilation.
- HTTP trace output exposes overlays for each executed statement for deterministic debugging.

## Traceability

- Code:
  - `edb/pgsql/compiler/ARCHITECTURE.md`
  - `edb/pgsql/compiler/dml.py`
  - `edb/pgsql/compiler/relctx.py`
- Tests:
  - `tests/test_sql_dml.py`
  - `tests/test_edgeql_insert.py`
  - `tests/test_edgeql_update.py`
  - `tests/test_edgeql_delete.py`

## Open Questions

- Q1: Should overlay debugging hooks be mandatory in explain output?

## Change Log

- 2026-04-02: Initial draft.
- 2026-04-02: Implemented sqlite-ts overlay IR metadata, query-unit propagation, and trace exposure.
