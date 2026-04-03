# SPEC-PARITY: Object Types (`datamodel/objects.rst`)

Status: Draft
Owners: sqlite-ts Core Team
Last Updated: 2026-04-02

## Purpose

Define one-for-one parity targets for `datamodel/objects.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [ ] S1: `Properties` parity is implemented and covered by tests.
- [ ] S2: `Links` parity is implemented and covered by tests.
- [ ] S3: `Abstract types` parity is implemented and covered by tests.
- [ ] S4: `Inheritance` parity is implemented and covered by tests.
- [ ] S5: `Multiple Inheritance` parity is implemented and covered by tests.
- [ ] S6: `Defining object types` parity is implemented and covered by tests.
- [ ] S7: `Syntax` parity is implemented and covered by tests.
- [ ] S8: `Description` parity is implemented and covered by tests.
- [ ] S9: `DDL commands` parity is implemented and covered by tests.
- [ ] S10: `Create type` parity is implemented and covered by tests.
- [ ] S11: `Parameters` parity is implemented and covered by tests.
- [ ] S12: `Example` parity is implemented and covered by tests.
- [ ] S13: `Alter type` parity is implemented and covered by tests.
- [ ] S14: `Drop type` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/objects.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/objects.rst`
- sqlite-ts implementation:
  - `sqlite-ts/` (to be linked as work lands)
- sqlite-ts tests:
  - `sqlite-ts/tests/` (to be linked as work lands)

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-02: Initial parity checklist generated from source headings.
