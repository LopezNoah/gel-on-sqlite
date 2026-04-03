# SPEC-021: EdgeQL Semantic Compilation

Status: Draft
Owners: EdgeQL Compiler Team
Last Updated: 2026-04-02

## Purpose

Specify semantics and contracts for lowering EdgeQL AST to IR.

## Scope

- Name resolution, type resolution, and expression compilation.
- Statement-level compilation behavior.

## Non-Goals

- SQL generation details.
- Runtime execution engine details.

## Requirements

- R1: Compilation must preserve query semantics from AST into IR.
- R2: Type and pointer resolution must use schema context deterministically.
- R3: Compilation errors must identify semantic issue class and location.

## Behavior and Flows

- Dispatch handlers compile AST fragments.
- Context carries scopes, schema state, and options.
- Output is IR plus supporting context artifacts.

## Traceability

- Code:
  - `edb/edgeql/compiler/dispatch.py`
  - `edb/edgeql/compiler/context.py`
  - `edb/edgeql/compiler/expr.py`
  - `edb/edgeql/compiler/stmt.py`
- Tests:
  - `tests/test_edgeql_expressions.py`
  - `tests/test_edgeql_select.py`
  - `tests/test_edgeql_insert.py`

## Implementation References

| Claim | Source lines |
|---|---|
| Semantic compile is dispatch-driven from AST node type | `edb/edgeql/compiler/dispatch.py:31`, `edb/edgeql/compiler/dispatch.py:32` |
| Compiler context carries schema, scope tree, and tracked refs | `edb/edgeql/compiler/context.py:167`, `edb/edgeql/compiler/context.py:170`, `edb/edgeql/compiler/context.py:257`, `edb/edgeql/compiler/context.py:563` |
| Expression compilation emits semantic errors and typed lowering | `edb/edgeql/compiler/expr.py:79`, `edb/edgeql/compiler/expr.py:318`, `edb/edgeql/compiler/expr.py:766` |
| Statement-level semantic compilation covers select/insert/update/delete | `edb/edgeql/compiler/stmt.py:100`, `edb/edgeql/compiler/stmt.py:440`, `edb/edgeql/compiler/stmt.py:597`, `edb/edgeql/compiler/stmt.py:712` |

## Open Questions

- Q1: Should semantic warnings become first-class outputs in this phase?

## Change Log

- 2026-04-02: Initial draft.
