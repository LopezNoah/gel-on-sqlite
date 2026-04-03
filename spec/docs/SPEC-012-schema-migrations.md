# SPEC-012: Schema Migrations

Status: Draft
Owners: Schema Team
Last Updated: 2026-04-02

## Purpose

Define lifecycle and invariants for migration objects and migration application behavior.

## Scope

- Migration object representation.
- Ordering, application, and consistency constraints.

## Non-Goals

- UI workflow for migration authoring.
- Cross-repository migration distribution.

## Requirements

- R1: Migration application order must be deterministic.
- R2: Applying a migration must result in a valid schema snapshot.
- R3: Migration metadata must support reproducibility and traceability.

## Behavior and Flows

- Migration nodes describe schema delta history.
- Apply sequence computes next schema from prior schema plus delta.
- Validation prevents inconsistent lineage.

## Traceability

- Code:
  - `edb/schema/migrations.py`
  - `edb/schema/delta.py`
- Tests:
  - `tests/test_edgeql_data_migration.py`
  - `tests/test_schema.py`

## Implementation References

| Claim | Source lines |
|---|---|
| Migration object type and command contexts are explicit | `edb/schema/migrations.py:43`, `edb/schema/migrations.py:76`, `edb/schema/migrations.py:80` |
| Migration application flows through command apply hooks | `edb/schema/migrations.py:208`, `edb/schema/migrations.py:228`, `edb/schema/migrations.py:241` |
| Deterministic migration ordering helper exists | `edb/schema/migrations.py:290` |
| General delta apply sequencing enforces command order | `edb/schema/delta.py:966`, `edb/schema/delta.py:973`, `edb/schema/delta.py:982` |

## Open Questions

- Q1: Should rollback semantics be specified at this layer or at operational tooling layer?

## Change Log

- 2026-04-02: Initial draft.
