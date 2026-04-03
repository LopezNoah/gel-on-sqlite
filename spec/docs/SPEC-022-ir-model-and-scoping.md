# SPEC-022: IR Model and Scoping

Status: Implemented
Owners: IR Team
Last Updated: 2026-04-02

## Purpose

Define structural and scoping invariants for IR and associated scope tree.

## Scope

- IR AST structure and reference discipline.
- Scope tree behavior and binding semantics.

## Non-Goals

- SQL AST behavior.
- Wire protocol serialization.

## Requirements

- R1: IR must contain explicit schema-derived references where needed, not direct schema objects.
- R2: Scope tree must correctly model binding visibility for compiled sets.
- R3: Path identifiers must be stable within a compile unit.

## Behavior and Flows

- IR nodes represent compiled semantic intent.
- Scope tree tracks where sets are introduced and referenced.
- Path id machinery identifies and disambiguates set lineage.
- sqlite-ts emits deterministic `pathId` values per compile unit and embeds a per-select `scopeTree` in IR.
- sqlite-ts IR nodes carry schema-derived references (`typeRef`, table/link metadata) instead of runtime schema object pointers.

## Traceability

- Code:
  - `edb/ir/ast.py`
  - `edb/ir/scopetree.py`
  - `edb/ir/pathid.py`
- Tests:
  - `tests/test_edgeql_ir_scopetree.py`
  - `tests/test_edgeql_ir_pathid.py`

## Open Questions

- Q1: Should IR validation hooks be required post-compile for all query classes?

## Change Log

- 2026-04-02: Initial draft.
- 2026-04-02: Implemented sqlite-ts path-id allocation, scope-tree emission, and schema-reference IR fields.
