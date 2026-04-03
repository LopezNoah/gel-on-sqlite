# SPEC-PARITY: Links (`datamodel/links.rst`)

Status: Draft
Owners: sqlite-ts Core Team
Last Updated: 2026-04-02

## Purpose

Define one-for-one parity targets for `datamodel/links.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [ ] S1: `Links are directional` parity is implemented and covered by tests.
- [ ] S2: `Link cardinality` parity is implemented and covered by tests.
- [ ] S3: `Required links` parity is implemented and covered by tests.
- [ ] S4: `Exclusive constraints` parity is implemented and covered by tests.
- [ ] S5: `Backlinks` parity is implemented and covered by tests.
- [ ] S6: `Default values` parity is implemented and covered by tests.
- [ ] S7: `Modeling relations` parity is implemented and covered by tests.
- [ ] S8: `Many-to-one` parity is implemented and covered by tests.
- [ ] S9: `One-to-many` parity is implemented and covered by tests.
- [ ] S10: `One-to-one` parity is implemented and covered by tests.
- [ ] S11: `Many-to-many` parity is implemented and covered by tests.
- [ ] S12: `Link properties` parity is implemented and covered by tests.
- [ ] S13: `Inserting and updating link properties` parity is implemented and covered by tests.
- [ ] S14: `Querying link properties` parity is implemented and covered by tests.
- [ ] S15: `Deletion policies` parity is implemented and covered by tests.
- [ ] S16: `Target deletion` parity is implemented and covered by tests.
- [ ] S17: `Source deletion` parity is implemented and covered by tests.
- [ ] S18: `Polymorphic links` parity is implemented and covered by tests.
- [ ] S19: `Abstract links` parity is implemented and covered by tests.
- [ ] S20: `Overloading` parity is implemented and covered by tests.
- [ ] S21: `Declaring links` parity is implemented and covered by tests.
- [ ] S22: `Syntax` parity is implemented and covered by tests.
- [ ] S23: `DDL commands` parity is implemented and covered by tests.
- [ ] S24: `Create link` parity is implemented and covered by tests.
- [ ] S25: `Description` parity is implemented and covered by tests.
- [ ] S26: `Parameters` parity is implemented and covered by tests.
- [ ] S27: `Examples` parity is implemented and covered by tests.
- [ ] S28: `Alter link` parity is implemented and covered by tests.
- [ ] S29: `Drop link` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/links.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/links.rst`
- sqlite-ts implementation:
  - `sqlite-ts/` (to be linked as work lands)
- sqlite-ts tests:
  - `sqlite-ts/tests/` (to be linked as work lands)

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-02: Initial parity checklist generated from source headings.
