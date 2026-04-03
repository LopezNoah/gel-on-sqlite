# SPEC-032: SQL Codegen and Result Shapes

Status: Draft
Owners: PostgreSQL Backend and Server Compiler Teams
Last Updated: 2026-04-02

## Purpose

Define contracts for SQL string generation and compatibility with expected result shapes.

## Scope

- SQL AST to SQL text generation.
- Shape expectations between backend compiler and server compiler boundary.

## Non-Goals

- Query formatting style for humans.
- Network-level response encoding.

## Requirements

- R1: SQL code generation must be deterministic for equivalent SQL AST input.
- R2: Generated SQL must preserve shape semantics required by protocol layer.
- R3: Codegen errors must identify offending SQL AST context.

## Behavior and Flows

- SQL AST built by compiler is rendered to executable SQL text.
- Shape metadata is carried through compiler interfaces.
- Server compiler maps SQL output to protocol expectations.

## Traceability

- Code:
  - `edb/pgsql/codegen.py`
  - `edb/pgsql/ast.py`
  - `edb/server/compiler/sql.py`
  - `edb/server/compiler/sertypes.py`
- Tests:
  - `tests/test_edgeql_sql_codegen.py`
  - `tests/test_server_param_conversions.py`

## Implementation References

| Claim | Source lines |
|---|---|
| SQL AST rendering to text is centralized in codegen | `edb/pgsql/codegen.py:85`, `edb/pgsql/codegen.py:272`, `edb/pgsql/codegen.py:435`, `edb/pgsql/codegen.py:546` |
| SQL AST node types cover core statement families | `edb/pgsql/ast.py:664`, `edb/pgsql/ast.py:674`, `edb/pgsql/ast.py:686`, `edb/pgsql/ast.py:693` |
| Server compiler SQL path keeps generated SQL and query units | `edb/server/compiler/sql.py:69`, `edb/server/compiler/sql.py:234`, `edb/server/compiler/sql.py:240` |
| Shape/type descriptor semantics are encoded in sertypes | `edb/server/compiler/sertypes.py:91`, `edb/server/compiler/sertypes.py:509`, `edb/server/compiler/sertypes.py:598` |

## Open Questions

- Q1: Should SQL generation options be constrained by a formal compatibility matrix?

## Change Log

- 2026-04-02: Initial draft.
