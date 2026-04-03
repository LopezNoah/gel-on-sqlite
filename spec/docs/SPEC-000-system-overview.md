# SPEC-000: System Overview

Status: Draft
Owners: Core EDB Team
Last Updated: 2026-04-02

## Purpose

Define the high-level boundaries and major subsystems in `edb/` to anchor all other specs.

## Scope

- Top-level architecture: schema, EdgeQL frontend, IR, PostgreSQL backend, server.
- Shared support components: protocol, GraphQL, language server, stdlib.

## Non-Goals

- Detailed algorithm design for individual compiler passes.
- Deployment and packaging details outside `edb/`.

## Requirements

- R1: The architecture definition maps each subsystem to concrete directories.
- R2: End-to-end flow from query input to backend SQL output is documented.
- R3: Each subsystem has at least one traceability link to current tests.

## Behavior and Flows

- Query path: server protocol -> EdgeQL parser/compiler -> IR -> pgsql compiler -> SQL execution.
- Schema path: SDL/DDL -> schema delta ops -> updated immutable schema model.
- Support paths: GraphQL translation and language server consume frontend primitives.

## Traceability

- Code:
  - `edb/schema/`
  - `edb/edgeql/`
  - `edb/ir/`
  - `edb/pgsql/`
  - `edb/server/`
- Tests:
  - `tests/test_server_compiler.py`
  - `tests/test_protocol.py`
  - `tests/test_schema.py`

## Open Questions

- Q1: Should architecture ownership be encoded per directory in this spec set?

## Change Log

- 2026-04-02: Initial draft.
