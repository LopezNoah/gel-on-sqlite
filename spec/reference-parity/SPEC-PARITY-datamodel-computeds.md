# SPEC-PARITY: Computeds (`datamodel/computeds.rst`)

Status: Implemented
Owners: sqlite-ts Core Team
Last Updated: 2026-04-03

## Purpose

Define one-for-one parity targets for `datamodel/computeds.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [x] S1: `Leading dot notation` parity is implemented and covered by tests.
- [x] S2: `Type and cardinality inference` parity is implemented and covered by tests.
- [x] S3: `Common use cases` parity is implemented and covered by tests.
- [x] S4: `Filtering` parity is implemented and covered by tests.
- [x] S5: `Backlinks` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/computeds.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/computeds.rst`
- sqlite-ts implementation:
  - `sqlite-ts/src/schema/declarative.ts`
  - `sqlite-ts/src/schema/uiSchema.ts`
  - `sqlite-ts/src/types.ts`
  - `sqlite-ts/src/compiler/semantic.ts`
  - `sqlite-ts/src/ir/model.ts`
  - `sqlite-ts/src/sql/compiler.ts`
  - `sqlite-ts/src/runtime/engine.ts`
  - `sqlite-ts/src/schema/migrations.ts`
- sqlite-ts tests:
  - `sqlite-ts/tests/schema.computeds-parity.test.ts`

## SQLite Notes

- Schema-defined computed declarations are supported via SDL `name := <expr>;` with `.<field>` / `__source__.<field>` references, string concatenation (`++`), filtered-link select wrappers, and backlink expressions.
- Computed properties are non-persisted and evaluated at query time.
- Computed links are non-persisted and resolved from existing forward links or backlink traversal at query time.
- sqlite-ts enforces non-required computed declarations (`required` computeds are rejected).
- Full arbitrary EdgeQL expression coverage for schema-level computed declarations remains intentionally narrowed to sqlite-ts supported expression forms.

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-03: Implemented S1-S5 with parser/schema/compiler/runtime support and dedicated parity tests.
- 2026-04-02: Initial parity checklist generated from source headings.
