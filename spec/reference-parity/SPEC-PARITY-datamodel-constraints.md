# SPEC-PARITY: Constraints (`datamodel/constraints.rst`)

Status: Draft
Owners: sqlite-ts Core Team
Last Updated: 2026-04-02

## Purpose

Define one-for-one parity targets for `datamodel/constraints.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [ ] S1: `Standard constraints` parity is implemented and covered by tests.
- [ ] S2: `Constraints on properties` parity is implemented and covered by tests.
- [ ] S3: `Constraints on object types` parity is implemented and covered by tests.
- [ ] S4: `Abstract constraints` parity is implemented and covered by tests.
- [ ] S5: `Computed constraints` parity is implemented and covered by tests.
- [ ] S6: `Composite constraints` parity is implemented and covered by tests.
- [ ] S7: `Partial constraints` parity is implemented and covered by tests.
- [ ] S8: `Constraints on links` parity is implemented and covered by tests.
- [ ] S9: `Link property constraints` parity is implemented and covered by tests.
- [ ] S10: `Link's "@source" and "@target"` parity is implemented and covered by tests.
- [ ] S11: `Constraints on custom scalars` parity is implemented and covered by tests.
- [ ] S12: `Constraints and inheritance` parity is implemented and covered by tests.
- [ ] S13: `Declaring constraints` parity is implemented and covered by tests.
- [ ] S14: `Syntax` parity is implemented and covered by tests.
- [ ] S15: `Description` parity is implemented and covered by tests.
- [ ] S16: `DDL commands` parity is implemented and covered by tests.
- [ ] S17: `Create abstract constraint` parity is implemented and covered by tests.
- [ ] S18: `Parameters` parity is implemented and covered by tests.
- [ ] S19: `Example` parity is implemented and covered by tests.
- [ ] S20: `Alter abstract constraint` parity is implemented and covered by tests.
- [ ] S21: `Drop abstract constraint` parity is implemented and covered by tests.
- [ ] S22: `Create constraint` parity is implemented and covered by tests.
- [ ] S23: `Alter constraint` parity is implemented and covered by tests.
- [ ] S24: `Drop constraint` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/constraints.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/constraints.rst`
- sqlite-ts implementation:
  - `sqlite-ts/` (to be linked as work lands)
- sqlite-ts tests:
  - `sqlite-ts/tests/` (to be linked as work lands)

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-02: Initial parity checklist generated from source headings.
