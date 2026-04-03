# SPEC-PARITY: Inheritance (`datamodel/inheritance.rst`)

Status: Implemented
Owners: sqlite-ts Core Team
Last Updated: 2026-04-03

## Purpose

Define one-for-one parity targets for `datamodel/inheritance.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [x] S1: `Object types` parity is implemented and covered by tests.
- [x] S2: `Multiple Inheritance` parity is implemented and covered by tests.
- [x] S3: `Overloading` parity is implemented and covered by tests.
- [x] S4: `Properties` parity is implemented and covered by tests.
- [x] S5: `Links` parity is implemented and covered by tests.
- [x] S6: `Constraints` parity is implemented and covered by tests.
- [x] S7: `Annotations` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/inheritance.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/inheritance.rst`
- sqlite-ts implementation:
  - `sqlite-ts/src/schema/declarative.ts`
  - `sqlite-ts/src/schema/uiSchema.ts`
  - `sqlite-ts/src/schema/schema.ts`
  - `sqlite-ts/src/compiler/semantic.ts`
  - `sqlite-ts/src/types.ts`
- sqlite-ts tests:
  - `sqlite-ts/tests/schema.annotations-inheritance-parity.test.ts`
  - `sqlite-ts/tests/semantic.test.ts`
  - `sqlite-ts/tests/engine.query-basics.test.ts`

## SQLite Notes

- sqlite-ts resolves inherited properties/links into concrete type storage projections during declarative-to-runtime schema conversion.
- Multiple inheritance is supported for member aggregation with deterministic conflict handling.
- Overloads are explicit: redefining an inherited member requires `overloaded`, and overloaded links must narrow to a subtype target.
- Inheritable annotations propagate across inherited object types and overloaded members.
- Constraint inheritance parity is provided via sqlite-ts existing pointer/validation subset; full Gel abstract constraint semantics remain intentionally narrowed to current sqlite-ts constraint capabilities.

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-03: Implemented S1-S7 with inherited member flattening, explicit overload checks, and inheritable annotation propagation.
- 2026-04-02: Initial parity checklist generated from source headings.
