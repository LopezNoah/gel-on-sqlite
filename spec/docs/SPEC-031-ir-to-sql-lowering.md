# SPEC-031: IR to SQL Lowering

Status: Draft
Owners: PostgreSQL Backend Team
Last Updated: 2026-04-02

## Purpose

Specify transformation contracts from IR nodes into SQL AST structures.

## Scope

- Statement and expression lowering.
- Context propagation required for lowering correctness.

## Non-Goals

- SQL string rendering details.
- PostgreSQL runtime tuning.

## Requirements

- R1: Lowering must preserve semantic equivalence with input IR.
- R2: Lowering must produce SQL AST accepted by code generation layer.
- R3: Unsupported IR forms must fail with explicit diagnostics.

## Behavior and Flows

- Dispatch lowers statements and expressions into SQL AST nodes.
- Shape and grouping logic integrates during lowering.
- Output metadata for protocol shaping is retained.

## Traceability

- Code:
  - `edb/pgsql/compiler/dispatch.py`
  - `edb/pgsql/compiler/stmt.py`
  - `edb/pgsql/compiler/expr.py`
  - `edb/pgsql/compiler/shapecomp.py`
- Tests:
  - `tests/test_edgeql_sql_codegen.py`
  - `tests/test_sql_dml.py`

## Implementation References

| Claim | Source lines |
|---|---|
| SQL lowering entrypoint is dispatch-based | `edb/pgsql/compiler/dispatch.py:32` |
| Statement lowering maps IR select/insert/update/delete into SQL AST | `edb/pgsql/compiler/stmt.py:43`, `edb/pgsql/compiler/stmt.py:150`, `edb/pgsql/compiler/stmt.py:178`, `edb/pgsql/compiler/stmt.py:207` |
| Expression lowering maps IR expression forms into SQL expressions | `edb/pgsql/compiler/expr.py:52`, `edb/pgsql/compiler/expr.py:463`, `edb/pgsql/compiler/expr.py:764` |
| Shape lowering helper is explicit and integrated with statement lowering | `edb/pgsql/compiler/shapecomp.py:43`, `edb/pgsql/compiler/shapecomp.py:109` |

## Open Questions

- Q1: Should lowering enforce a normalized SQL AST form for all output queries?

## Change Log

- 2026-04-02: Initial draft.
