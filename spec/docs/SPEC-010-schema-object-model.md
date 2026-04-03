# SPEC-010: Schema Object Model

Status: Draft
Owners: Schema Team
Last Updated: 2026-04-02

## Purpose

Define invariants and responsibilities for the immutable schema model and schema object representation.

## Scope

- Schema immutability, object identity, and lookup semantics.
- Core object families: types, pointers, functions, constraints, modules.

## Non-Goals

- DDL parser grammar details.
- Migration CLI UX.

## Requirements

- R1: Schema updates produce new schema states without mutating prior instances.
- R2: Schema object access requires explicit schema context where applicable.
- R3: Object naming and module scoping must be deterministic.

## Behavior and Flows

- Object graph is represented through schema objects and references.
- Reads traverse schema snapshots; writes are expressed as deltas.
- Name resolution is performed using module-aware identifiers.

## Traceability

- Code:
  - `edb/schema/schema.py`
  - `edb/schema/objects.py`
  - `edb/schema/name.py`
  - `edb/schema/modules.py`
- Tests:
  - `tests/test_schema.py`
  - `tests/test_schema_syntax.py`

## Implementation References

| Claim | Source lines |
|---|---|
| Schema is modeled as explicit schema class hierarchy | `edb/schema/schema.py:123`, `edb/schema/schema.py:704`, `edb/schema/schema.py:1650` |
| Updates create replaced schema state rather than mutating in place | `edb/schema/schema.py:739`, `edb/schema/schema.py:1002`, `edb/schema/schema.py:1199` |
| Object metadata/name access is schema-contextual | `edb/schema/objects.py:1043`, `edb/schema/objects.py:1164`, `edb/schema/objects.py:1253` |
| Deterministic module-qualified naming is first-class | `edb/schema/name.py:79`, `edb/schema/name.py:132`, `edb/schema/name.py:161` |
| Module-level constraints are validated in commands | `edb/schema/modules.py:42`, `edb/schema/modules.py:76`, `edb/schema/modules.py:90` |

## Open Questions

- Q1: Should schema snapshot serialization guarantees be formalized here or in a dedicated spec?

## Change Log

- 2026-04-02: Initial draft.
