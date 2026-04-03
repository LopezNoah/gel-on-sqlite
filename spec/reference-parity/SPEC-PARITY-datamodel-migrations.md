# SPEC-PARITY: Migrations (`datamodel/migrations.rst`)

Status: In Progress
Owners: sqlite-ts Core Team
Last Updated: 2026-04-03

## Purpose

Define one-for-one parity targets for `datamodel/migrations.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [x] S1: `The migrations flow` parity is implemented and covered by tests.
- [x] S2: `Command line tools` parity is implemented and covered by tests.
- [x] S3: `Automatic migrations` parity is implemented and covered by tests.
- [x] S4: `Data definition language (DDL)` parity is implemented and covered by tests.
- [x] S5: `Migration DDL commands` parity is implemented and covered by tests.
- [x] S6: `Start migration` parity is implemented and covered by tests.
- [x] S7: `Parameters` parity is implemented and covered by tests.
- [x] S8: `Description` parity is implemented and covered by tests.
- [x] S9: `Example` parity is implemented and covered by tests.
- [x] S10: `create migration` parity is implemented and covered by tests.
- [x] S11: `Abort migration` parity is implemented and covered by tests.
- [x] S12: `Populate migration` parity is implemented and covered by tests.
- [x] S13: `Describe current migration` parity is implemented and covered by tests.
- [x] S14: `Commit migration` parity is implemented and covered by tests.
- [x] S15: `Reset schema to initial` parity is implemented and covered by tests.
- [x] S16: `Migration rewrites DDL commands` parity is implemented and covered by tests.
- [x] S17: `Start migration rewrite` parity is implemented and covered by tests.
- [x] S18: `Declare savepoint` parity is implemented and covered by tests.
- [x] S19: `Release savepoint` parity is implemented and covered by tests.
- [x] S20: `Rollback to savepoint` parity is implemented and covered by tests.
- [x] S21: `Rollback` parity is implemented and covered by tests.
- [x] S22: `Commit migration rewrite` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/migrations.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/migrations.rst`
- sqlite-ts implementation:
  - `sqlite-ts/src/schema/migration_session.ts`
  - `sqlite-ts/src/schema/migrations.ts`
- sqlite-ts tests:
  - `sqlite-ts/tests/schema.migration-session-parity.test.ts`
  - `sqlite-ts/tests/schema_migrations.test.ts`

## SQLite Divergences

- `START MIGRATION TO ...` command parsing is implemented via quoted schema text (`START MIGRATION TO '<SDL>'`) instead of full upstream block syntax.
- Migration rewrite DDL is implemented as explicit SQL step append operations (`applyMigrationRewriteDDL`) rather than full general DDL re-authoring.
- Command-line behavior is modeled as in-process command execution (`executeMigrationCommand`) rather than an external CLI tool contract.

## Open Questions

- Q1: Should block-form `START MIGRATION TO { ... }` parsing be added for closer syntax parity?
- Q2: Should rewrite DDL accept structured AST commands (instead of raw SQL step append) in a follow-up?

## Change Log

- 2026-04-02: Initial parity checklist generated from source headings.
- 2026-04-03: Added migration session manager, command execution surface, rewrite/savepoint controls, and parity tests.
