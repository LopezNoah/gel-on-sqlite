# SPEC-PARITY: Insert (`edgeql/insert.rst`)

Status: Implemented
Owners: sqlite-ts Core Team
Last Updated: 2026-04-03

## Purpose

Define one-for-one parity targets for `edgeql/insert.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [x] S1: `Basic usage` parity is implemented and covered by tests.
- [x] S2: `Inserting links` parity is implemented and covered by tests.
- [x] S3: `Nested inserts` parity is implemented and covered by tests.
- [x] S4: `With block` parity is implemented and covered by tests.
- [x] S5: `Conflicts` parity is implemented and covered by tests.
- [x] S6: `Upserts` parity is implemented and covered by tests.
- [x] S7: `Suppressing failures` parity is implemented and covered by tests.
- [x] S8: `Bulk inserts` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `edgeql/insert.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/edgeql/insert.rst`
- sqlite-ts implementation:
  - `sqlite-ts/src/edgeql/ast.ts`
  - `sqlite-ts/src/edgeql/parser.ts`
  - `sqlite-ts/src/edgeql/tokenizer.ts`
  - `sqlite-ts/src/compiler/semantic.ts`
  - `sqlite-ts/src/runtime/engine.ts`
- sqlite-ts tests:
  - `sqlite-ts/tests/engine.insert-parity.test.ts`
  - `sqlite-ts/tests/engine.select-parity.test.ts`

## SQLite Notes

- Link insertion supports assignment from id literals, binding refs, `select` subqueries, nested `insert` subqueries, and set literals.
- Conflict handling supports `unless conflict`, `unless conflict on .field`, and `else (update ...)`; `else (select ...)` is accepted and treated as a no-op fallback in sqlite-ts DML return mode.
- Bulk insert parity is implemented through sqlite-ts batch/script execution patterns rather than `for ... union` syntax.

## Change Log

- 2026-04-03: Implemented S1-S8 parity targets with parser/runtime coverage and insert-link/nested-insert/conflict handling.
- 2026-04-02: Initial parity checklist generated from source headings.
