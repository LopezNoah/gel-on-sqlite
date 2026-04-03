# SPEC-050: GraphQL Translation Layer

Status: Draft
Owners: API and Compiler Teams
Last Updated: 2026-04-02

## Purpose

Define translation and execution contracts for GraphQL support in `edb/graphql/`.

## Scope

- GraphQL parse and translation to internal query representation.
- Type mapping and error behavior.

## Non-Goals

- GraphQL client tooling guidance.
- Subscription protocol details outside current implementation.

## Requirements

- R1: Supported GraphQL inputs must translate deterministically to executable internal representation.
- R2: Translation must preserve schema-driven type and field semantics.
- R3: Translation and execution errors must map to clear API diagnostics.

## Behavior and Flows

- Parse GraphQL payload and validate against schema model.
- Translate into internal representation.
- Execute through server query path and shape response.

## Traceability

- Code:
  - `edb/graphql/compiler.py`
  - `edb/graphql/translator.py`
  - `edb/graphql/types.py`
- Tests:
  - `tests/test_http_graphql_query.py`
  - `tests/test_http_graphql_mutation.py`
  - `tests/test_http_graphql_schema.py`

## Open Questions

- Q1: Which parts of GraphQL behavior should be declared stable API guarantees?

## Change Log

- 2026-04-02: Initial draft.
