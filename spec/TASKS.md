# sqlite-ts Spec Task Checklist

This checklist tracks implementation status for the TypeScript + SQLite rebuild against `spec/*.md` requirements.

## Completed

- [x] SPEC-001: Parse -> semantic compile -> IR -> SQL -> execute lifecycle baseline.
- [x] SPEC-010: Immutable schema snapshots and delta application.
- [x] SPEC-020: Parser/tokenizer with syntax location diagnostics.
- [x] SPEC-021: Semantic compile baseline with typed error classification and scalar validation.
- [x] SPEC-031/032: Deterministic SQL generation for select/insert/update/delete with filter/order/pagination.
- [x] SPEC-040: Runtime execution pipeline in-process for SQLite backend.
- [x] SPEC-043: HTTP query endpoint validation and error response contract.
- [x] SPEC-070: Requirement-to-test traceability map and automated test guard.

## In Progress / Next

- [x] SPEC-011: Schema declaration pipeline baseline with Gel-like templated declarations.
- [x] SPEC-012: Migration planning and SQLite migration apply baseline.
- [x] SPEC-013: Access policy, mutation rewrite, and trigger semantics adaptation for SQLite execution model.
- [x] SPEC-022: Rich IR model for path scoping and shape composition.
- [x] SPEC-023: Cardinality/multiplicity/volatility propagation in compiler stages.
- [x] SPEC-034: Select semantics parity milestone (nested shapes, link-level clauses, and polymorphic field projections enabled; deeper polymorphic set semantics remain tracked in spec notes).
- [x] SPEC-035: Single-statement nested shape/backlink SQL aggregation lowering (with JSON aggregation payload materialization and deterministic SQL traces).
- [x] SPEC-033: Overlay-like visibility semantics for DML in single-statement execution contexts.
- [x] SPEC-041: Compiler interface caching and deterministic cache keys.
- [ ] SPEC-042: Binary protocol contract adaptation or explicit non-goal decision for sqlite-ts.
- [x] SPEC-044: AuthN/AuthZ baseline for HTTP/runtime security context with permission and policy enforcement.
- [ ] SPEC-050: GraphQL translation layer (or formal deferred scope decision).
- [x] SPEC-052: Astro UI schema management + Studio parity roadmap (schema editor + type/link explorer).
- [ ] SPEC-054: Studio `src/lib` transplant + Tailwind conversion + sqlite-ts adapter execution plan.

## Detailed Tasks for Schema Declaration + Migrations

- [x] Add a first-party schema declaration format for sqlite-ts object types, links, and properties.
- [x] Support abstract object type declaration and inheritance graph validation.
- [x] Define concrete storage mapping rules for abstract/polymorphic types in SQLite.
- [x] Build migration diff planner: previous snapshot -> next snapshot operations.
- [x] Build migration applier: transactional DDL/DML steps for SQLite.
- [x] Persist migration history table and checksum validation.
- [x] Add regression tests for create/alter/drop object type and pointer changes.
- [x] Add regression tests for polymorphic selects across inherited object types.

## Notes

- Abstract/polymorphic PostgreSQL behavior and `UNION ALL` verification are documented in `spec/SPEC-014-schema-storage-and-polymorphism.md`.
- sqlite-ts adaptation work should preserve logical contracts from the upstream specs while explicitly documenting backend deviations where SQLite cannot mirror PostgreSQL behavior.
