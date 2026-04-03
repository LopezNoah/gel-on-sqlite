# SPEC-PARITY: Access Policies (`datamodel/access_policies.rst`)

Status: Draft
Owners: sqlite-ts Core Team
Last Updated: 2026-04-02

## Purpose

Define one-for-one parity targets for `datamodel/access_policies.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [ ] S1: `Global variables` parity is implemented and covered by tests.
- [ ] S2: `Defining policies` parity is implemented and covered by tests.
- [ ] S3: `Policy types` parity is implemented and covered by tests.
- [ ] S4: `Resolution order` parity is implemented and covered by tests.
- [ ] S5: `Interaction between policies` parity is implemented and covered by tests.
- [ ] S6: `Custom error messages` parity is implemented and covered by tests.
- [ ] S7: `Disabling policies` parity is implemented and covered by tests.
- [ ] S8: `More examples` parity is implemented and covered by tests.
- [ ] S9: `Super constraints` parity is implemented and covered by tests.
- [ ] S10: `Declaring access policies` parity is implemented and covered by tests.
- [ ] S11: `Syntax` parity is implemented and covered by tests.
- [ ] S12: `DDL commands` parity is implemented and covered by tests.
- [ ] S13: `Create access policy` parity is implemented and covered by tests.
- [ ] S14: `Alter access policy` parity is implemented and covered by tests.
- [ ] S15: `Drop access policy` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/access_policies.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/access_policies.rst`
- sqlite-ts implementation:
  - `sqlite-ts/` (to be linked as work lands)
- sqlite-ts tests:
  - `sqlite-ts/tests/` (to be linked as work lands)

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-02: Initial parity checklist generated from source headings.
