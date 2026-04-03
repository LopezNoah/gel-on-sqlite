# SPEC-015: Pointer Metadata for Computeds and Backlinks

Status: Draft
Owners: sqlite-ts Schema + Compiler Team
Last Updated: 2026-04-02

## Purpose

Define the metadata contract needed to represent computed pointers and backlink resolution inputs in sqlite-ts, aligned with Gel's schema-driven pointer model.

## Scope

- Metadata required to resolve shape-level computed fields and backlinks.
- Mapping between logical pointer metadata and physical SQLite storage conventions.
- Upstream Gel metadata references that sqlite-ts should mirror semantically.

## Non-Goals

- Full catalog persistence implementation in sqlite-ts.
- Policy/rewrites metadata and all migration history metadata.

## Requirements

- R1: sqlite-ts MUST represent forward link metadata per object type, including link name, target type, and storage mode hints.
- R2: sqlite-ts MUST resolve backlinks from metadata rather than from ad-hoc table-name guesses alone.
- R3: Computed shape elements MUST carry expression metadata in AST/IR until runtime materialization.
- R4: Metadata representation MUST be deterministic and clone-safe across immutable schema snapshots.
- R5: sqlite-ts MUST document divergence from Gel's persistent schema catalog whenever it stores equivalent metadata in-memory only.
- R6: Object `id` values MUST be server/database generated and enforced as globally unique across object tables.

## Upstream Gel Metadata (Observed)

- Gel schema pointer objects in Python expose computable/expr attributes used to model computed pointers (see `edb/schema/pointers.py`, especially pointer fields and computable parsing/validation paths).
- Gel metadata ties logical pointers to storage and introspection mapping (`edb/pgsql/types.py`, `edb/pgsql/metaschema.py`).
- Practical implication: backlinks and computeds are schema-metadata driven features in Gel, not parser-only rewrites.

## sqlite-ts Current Model

- Metadata is currently in-memory:
  - `TypeDef.links[]` stores link name, target type, and optional multi flag.
  - `SelectStatement.shape[]` stores computed/backlink entries in AST.
  - `SelectIR.shape[]` stores compiled computed/backlink plans plus resolved backlink source storage descriptors.
- No persistent SQLite metadata catalog table exists yet for pointer definitions.
- sqlite-ts maintains a global ID registry table (`__gel_global_ids`) with insert/delete triggers on object tables to enforce cross-type ID uniqueness.

## Conceptual Data Model

```text
SchemaSnapshot
  -> TypeDef(name, module)
       -> fields[]
       -> links[]
            - name
            - targetType
            - multi?

Select AST shape
  -> computed(name, expr)
  -> backlink(name, link, sourceType?)

Select IR shape
  -> computed(name, field_ref|literal)
  -> backlink(name, sources[])
       source = {sourceType, table, storage, inlineColumn?|linkTable?}
```

## Storage/Resolution Diagram

```text
Forward pointer metadata (TypeDef.links)
      |
      v
Backlink semantic resolution (. <link[is Type])
      |
      +--> inline storage source      -> source_table.<link>_id = target.id
      |
      `--> table storage source       -> source__link.target = target.id
```

## Traceability

- sqlite-ts code:
  - `sqlite-ts/src/types.ts`
  - `sqlite-ts/src/schema/schema.ts`
  - `sqlite-ts/src/compiler/semantic.ts`
  - `sqlite-ts/src/ir/model.ts`
  - `sqlite-ts/src/runtime/engine.ts`
- upstream Gel references:
  - `edb/schema/pointers.py`
  - `edb/pgsql/types.py`
  - `edb/pgsql/metaschema.py`

## Open Questions

- Q1: Should sqlite-ts persist pointer metadata in SQLite tables (for offline schema introspection and migration replay parity)?
- Q2: Should computed schema links be represented explicitly in `TypeDef` or as a separate expression catalog?

## Change Log

- 2026-04-02: Initial draft describing metadata needed for computed fields/backlinks and upstream Gel alignment.
