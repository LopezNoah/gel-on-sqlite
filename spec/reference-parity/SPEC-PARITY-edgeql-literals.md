# SPEC-PARITY: Literals (`edgeql/literals.rst`)

Status: Draft
Owners: sqlite-ts Core Team
Last Updated: 2026-04-02

## Purpose

Define one-for-one parity targets for `edgeql/literals.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [ ] S1: `Strings` parity is implemented and covered by tests.
- [ ] S2: `Booleans` parity is implemented and covered by tests.
- [ ] S3: `Numbers` parity is implemented and covered by tests.
- [ ] S4: `UUID` parity is implemented and covered by tests.
- [ ] S5: `Enums` parity is implemented and covered by tests.
- [ ] S6: `Dates and times` parity is implemented and covered by tests.
- [ ] S7: `Durations` parity is implemented and covered by tests.
- [ ] S8: `Exact durations` parity is implemented and covered by tests.
- [ ] S9: `Relative durations` parity is implemented and covered by tests.
- [ ] S10: `Date durations` parity is implemented and covered by tests.
- [ ] S11: `Ranges` parity is implemented and covered by tests.
- [ ] S12: `Bytes` parity is implemented and covered by tests.
- [ ] S13: `Arrays` parity is implemented and covered by tests.
- [ ] S14: `Tuples` parity is implemented and covered by tests.
- [ ] S15: `Indexing tuples` parity is implemented and covered by tests.
- [ ] S16: `JSON` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `edgeql/literals.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/edgeql/literals.rst`
- sqlite-ts implementation:
  - `sqlite-ts/` (to be linked as work lands)
- sqlite-ts tests:
  - `sqlite-ts/tests/` (to be linked as work lands)

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-02: Initial parity checklist generated from source headings.
