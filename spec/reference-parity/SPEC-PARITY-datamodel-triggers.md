# SPEC-PARITY: Triggers (`datamodel/triggers.rst`)

Status: Draft
Owners: sqlite-ts Core Team
Last Updated: 2026-04-02

## Purpose

Define one-for-one parity targets for `datamodel/triggers.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [ ] S1: `Important notes` parity is implemented and covered by tests.
- [ ] S2: `Consider using mutation rewrites` parity is implemented and covered by tests.
- [ ] S3: `Unified trigger query execution` parity is implemented and covered by tests.
- [ ] S4: `Multi-stage trigger execution` parity is implemented and covered by tests.
- [ ] S5: `Data visibility` parity is implemented and covered by tests.
- [ ] S6: `Example: audit log` parity is implemented and covered by tests.
- [ ] S7: `Example: validation` parity is implemented and covered by tests.
- [ ] S8: `Example: logging` parity is implemented and covered by tests.
- [ ] S9: `Declaring triggers` parity is implemented and covered by tests.
- [ ] S10: `Syntax` parity is implemented and covered by tests.
- [ ] S11: `Description` parity is implemented and covered by tests.
- [ ] S12: `DDL commands` parity is implemented and covered by tests.
- [ ] S13: `Create trigger` parity is implemented and covered by tests.
- [ ] S14: `Parameters` parity is implemented and covered by tests.
- [ ] S15: `Example` parity is implemented and covered by tests.
- [ ] S16: `Drop trigger` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/triggers.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/triggers.rst`
- sqlite-ts implementation:
  - `sqlite-ts/` (to be linked as work lands)
- sqlite-ts tests:
  - `sqlite-ts/tests/` (to be linked as work lands)

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-02: Initial parity checklist generated from source headings.
