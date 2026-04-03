# SPEC-030: PostgreSQL Compiler Architecture

Status: Draft
Owners: PostgreSQL Backend Team
Last Updated: 2026-04-02

## Purpose

Capture structural contracts and key concepts for IR-to-SQL compilation.

## Scope

- Compiler phases, context objects, and relation variable concepts.
- Path variable and output variable behavior.

## Non-Goals

- PostgreSQL optimizer internals.
- Physical storage semantics.

## Requirements

- R1: IR set compilation must support deferred column injection.
- R2: Path and output variable lookup must be consistent with relation scope.
- R3: Compiler artifacts must support downstream SQL code generation.

## Behavior and Flows

- Compile query structure first.
- Inject required columns recursively during path resolution.
- Maintain compiler context with relation and alias state.

## Traceability

- Code:
  - `edb/pgsql/compiler/ARCHITECTURE.md`
  - `edb/pgsql/compiler/pathctx.py`
  - `edb/pgsql/compiler/relctx.py`
  - `edb/pgsql/compiler/relgen.py`
- Tests:
  - `tests/test_edgeql_sql_codegen.py`
  - `tests/test_sql_query.py`

## Open Questions

- Q1: Should we codify a stable extension point model for new backend passes?

## Change Log

- 2026-04-02: Initial draft.
