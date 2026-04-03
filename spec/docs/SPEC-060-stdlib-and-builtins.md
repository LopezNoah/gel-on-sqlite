# SPEC-060: Standard Library and Builtins

Status: Draft
Owners: Language and Schema Teams
Last Updated: 2026-04-02

## Purpose

Define contracts for standard library definitions and builtin schema objects.

## Scope

- Core library modules in `edb/lib/`.
- Compatibility expectations for builtin objects consumed by compiler and runtime.

## Non-Goals

- User-defined extension libraries.
- External package distribution workflow.

## Requirements

- R1: Builtin schema definitions must be loadable and internally consistent.
- R2: Standard library object signatures must remain compatible with compiler assumptions.
- R3: Changes to builtins must include traceable test coverage updates.

## Behavior and Flows

- Load and validate stdlib definitions.
- Expose builtin objects to schema and compiler phases.
- Consume builtin signatures during compilation and execution.

## Traceability

- Code:
  - `edb/lib/schema.edgeql`
  - `edb/lib/std/`
  - `edb/schema/std.py`
- Tests:
  - `tests/test_edgeql_functions.py`
  - `tests/test_edgeql_datatypes.py`
  - `tests/test_schema.py`

## Open Questions

- Q1: Should builtin compatibility levels be versioned independently from server releases?

## Change Log

- 2026-04-02: Initial draft.
