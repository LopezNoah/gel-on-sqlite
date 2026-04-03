# SPEC-001: End-to-End Query Lifecycle

Status: Draft
Owners: Compiler and Server Teams
Last Updated: 2026-04-02

## Purpose

Specify the lifecycle of a query through parsing, compilation, execution planning, and protocol response.

## Scope

- Query handling from protocol receive to protocol encode.
- Error propagation across compiler and server layers.

## Non-Goals

- Internal PostgreSQL planner behavior.
- Client driver retry logic.

## Requirements

- R1: Query text must be parsed into EdgeQL AST before semantic compilation.
- R2: Semantic compile output must lower through IR to SQL before execution.
- R3: User-visible errors must preserve meaningful context and classification.

## Behavior and Flows

- Receive query in `edb/server/protocol/`.
- Compile via `edb/server/compiler/` and `edb/edgeql/compiler/`.
- Lower IR in `edb/pgsql/compiler/` and return encoded result.

## Traceability

- Code:
  - `edb/server/protocol/execute.pyx`
  - `edb/server/compiler/compiler.py`
  - `edb/edgeql/compiler/`
  - `edb/pgsql/compiler/`
- Tests:
  - `tests/test_protocol.py`
  - `tests/test_server_compiler.py`
  - `tests/test_edgeql_sql_codegen.py`

## Implementation References

| Claim | Source lines |
|---|---|
| Protocol layer parses and executes compiled units | `edb/server/protocol/execute.pyx:75`, `edb/server/protocol/execute.pyx:212`, `edb/server/protocol/execute.pyx:258` |
| Compiler pipeline parses EdgeQL source then compiles | `edb/server/compiler/compiler.py:438`, `edb/server/compiler/compiler.py:612`, `edb/server/compiler/compiler.py:2715` |
| Semantic statement compilation dispatches by query kind | `edb/edgeql/compiler/stmt.py:100`, `edb/edgeql/compiler/stmt.py:440`, `edb/edgeql/compiler/stmt.py:712` |
| IR lowers into backend SQL statement forms | `edb/pgsql/compiler/stmt.py:43`, `edb/pgsql/compiler/stmt.py:150`, `edb/pgsql/compiler/stmt.py:207` |
| Runtime propagates backend and protocol error paths | `edb/server/protocol/execute.pyx:441`, `edb/server/protocol/execute.pyx:835` |

## Open Questions

- Q1: Which boundaries should enforce canonical error code translation?

## Change Log

- 2026-04-02: Initial draft.
