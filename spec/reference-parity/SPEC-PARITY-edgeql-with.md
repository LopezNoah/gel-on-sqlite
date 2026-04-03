# SPEC-PARITY: With (`edgeql/with.rst`)

Status: Implemented
Owners: sqlite-ts Core Team
Last Updated: 2026-04-03

## Purpose

Define one-for-one parity targets for `edgeql/with.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [x] S1: `Subqueries` parity is implemented and covered by tests.
- [x] S2: `Query parameters` parity is implemented and covered by tests.
- [x] S3: `Module alias` parity is implemented and covered by tests.
- [x] S4: `Module selection` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `edgeql/with.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/edgeql/with.rst`
- sqlite-ts implementation:
  - `sqlite-ts/src/edgeql/ast.ts`
  - `sqlite-ts/src/edgeql/parser.ts`
  - `sqlite-ts/src/edgeql/tokenizer.ts`
  - `sqlite-ts/src/compiler/semantic.ts`
  - `sqlite-ts/src/compiler/service.ts`
  - `sqlite-ts/src/runtime/engine.ts`
- sqlite-ts tests:
  - `sqlite-ts/tests/parser.test.ts`
  - `sqlite-ts/tests/semantic.test.ts`
  - `sqlite-ts/tests/engine.test.ts`

## SQLite Notes

- `with` subquery aliasing is implemented as a source alias that lowers into the aliased `select` source type and clause chain (filter/order/limit/offset) before outer clause application.
- Query parameters use sqlite-ts runtime globals: `<type>$name` in a `with` binding resolves against `SecurityContext.globals` at execution.
- Module alias resolution supports `with <alias> as module <module_name>` in type references (`alias::Type`) with std fallback (`std::<module_name>`) when needed.
- Module selection supports `with module <module_name>` for short type names with std fallback when the top-level module is absent.

## Change Log

- 2026-04-03: Completed parity for S1-S4 and linked concrete implementation/test coverage.
- 2026-04-02: Initial parity checklist generated from source headings.
