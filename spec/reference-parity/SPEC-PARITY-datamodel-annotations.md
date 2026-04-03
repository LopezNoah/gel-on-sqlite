# SPEC-PARITY: Annotations (`datamodel/annotations.rst`)

Status: Implemented
Owners: sqlite-ts Core Team
Last Updated: 2026-04-03

## Purpose

Define one-for-one parity targets for `datamodel/annotations.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [x] S1: `Standard annotations` parity is implemented and covered by tests.
- [x] S2: `User-defined annotations` parity is implemented and covered by tests.
- [x] S3: `Declaring annotations` parity is implemented and covered by tests.
- [x] S4: `Syntax` parity is implemented and covered by tests.
- [x] S5: `Description` parity is implemented and covered by tests.
- [x] S6: `DDL commands` parity is implemented and covered by tests.
- [x] S7: `Create abstract annotation` parity is implemented and covered by tests.
- [x] S8: `Example` parity is implemented and covered by tests.
- [x] S9: `Alter abstract annotation` parity is implemented and covered by tests.
- [x] S10: `Parameters` parity is implemented and covered by tests.
- [x] S11: `Drop abstract annotation` parity is implemented and covered by tests.
- [x] S12: `Create annotation` parity is implemented and covered by tests.
- [x] S13: `Alter annotation` parity is implemented and covered by tests.
- [x] S14: `Drop annotation` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/annotations.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/annotations.rst`
- sqlite-ts implementation:
  - `sqlite-ts/src/schema/declarative.ts`
  - `sqlite-ts/src/schema/uiSchema.ts`
  - `sqlite-ts/src/schema/schema.ts`
  - `sqlite-ts/src/types.ts`
  - `sqlite-ts/src/compiler/semantic.ts`
- sqlite-ts tests:
  - `sqlite-ts/tests/schema_declarative.test.ts`
  - `sqlite-ts/tests/schema.annotations-inheritance-parity.test.ts`

## SQLite Notes

- sqlite-ts supports SDL-style abstract annotation declarations and concrete annotation declarations on object types and pointers.
- sqlite-ts supports `annotation`, `create annotation`, `alter annotation`, and `drop annotation` mutation forms inside SDL declaration blocks.
- sqlite-ts models `alter/drop abstract annotation` parity through declarative schema evolution (plan/apply migration diff) rather than a full top-level EdgeQL DDL command surface.
- Annotation values are string-only, and standard annotation names normalize to `std::title`, `std::description`, and `std::deprecated`.

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-03: Implemented S1-S14 with parser/schema/runtime-readiness coverage and annotation mutation forms.
- 2026-04-02: Initial parity checklist generated from source headings.
