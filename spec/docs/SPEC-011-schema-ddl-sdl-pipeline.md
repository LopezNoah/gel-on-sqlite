# SPEC-011: Schema DDL and SDL Pipeline

Status: Draft
Owners: Schema and EdgeQL Teams
Last Updated: 2026-04-02

## Purpose

Specify how SDL and DDL descriptions are analyzed and transformed into executable schema change operations.

## Scope

- Translation pipeline from declarative schema text to delta operations.
- Validation and error behavior in schema change planning.

## Non-Goals

- Full syntax listing for SDL and DDL grammar.
- Migration conflict resolution policy.

## Requirements

- R1: SDL descriptions must be transformable into semantically equivalent DDL operations.
- R2: Pipeline must reject invalid or ambiguous schema changes with actionable errors.
- R3: Delta operations must preserve schema integrity invariants.

## Behavior and Flows

- Parse and trace schema declarations.
- Convert declarations to internal operations.
- Apply operations against schema snapshots.

## Traceability

- Code:
  - `edb/edgeql/declarative.py`
  - `edb/edgeql/tracer.py`
  - `edb/schema/ddl.py`
  - `edb/schema/delta.py`
- Tests:
  - `tests/test_edgeql_ddl.py`
  - `tests/test_schema.py`

## Implementation References

| Claim | Source lines |
|---|---|
| SDL is transformed into ordered DDL operations | `edb/edgeql/declarative.py:364`, `edb/edgeql/declarative.py:468` |
| Layout and dependency tracing feed pipeline ordering | `edb/edgeql/declarative.py:418`, `edb/edgeql/declarative.py:448`, `edb/edgeql/declarative.py:814` |
| Name/object tracing is explicit in tracer model | `edb/edgeql/tracer.py:178`, `edb/edgeql/tracer.py:239`, `edb/edgeql/tracer.py:406` |
| DDL script application and SDL application are explicit schema entry points | `edb/schema/ddl.py:464`, `edb/schema/ddl.py:600`, `edb/schema/ddl.py:660` |
| Delta command application is the execution substrate | `edb/schema/delta.py:966`, `edb/schema/delta.py:982`, `edb/schema/delta.py:4692` |

## Open Questions

- Q1: Should compatibility constraints for future SDL versions be encoded as explicit requirements?

## Change Log

- 2026-04-02: Initial draft.
