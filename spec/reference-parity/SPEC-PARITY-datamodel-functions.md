# SPEC-PARITY: Functions (`datamodel/functions.rst`)

Status: Implemented
Owners: sqlite-ts Core Team
Last Updated: 2026-04-03

## Purpose

Define one-for-one parity targets for `datamodel/functions.rst` so sqlite-ts can match Gel's documented feature set.

## Scope

- Implement the observable behavior documented on this page.
- Preserve section-level semantics in parser, compiler, runtime, and tests as applicable.
- Record sqlite-specific deviations explicitly instead of silently diverging.

## Non-Goals

- Adding features not described in this source page.
- Finalizing internal implementation details before architecture review.

## Section-by-Section Parity Checklist

- [x] S1: `User-defined Functions` parity is implemented and covered by tests.
- [x] S2: `Sets as arguments` parity is implemented and covered by tests.
- [x] S3: `Modifying Functions` parity is implemented and covered by tests.
- [x] S4: `Declaring functions` parity is implemented and covered by tests.
- [x] S5: `Syntax` parity is implemented and covered by tests.
- [x] S6: `Description` parity is implemented and covered by tests.
- [x] S7: `DDL commands` parity is implemented and covered by tests.
- [x] S8: `Create function` parity is implemented and covered by tests.
- [x] S9: `Parameters` parity is implemented and covered by tests.
- [x] S10: `Examples` parity is implemented and covered by tests.
- [x] S11: `Alter function` parity is implemented and covered by tests.
- [x] S12: `Subcommands` parity is implemented and covered by tests.
- [x] S13: `Example` parity is implemented and covered by tests.
- [x] S14: `Drop function` parity is implemented and covered by tests.

## Requirements

- R1: sqlite-ts SHALL parse and/or execute constructs required by `datamodel/functions.rst` with equivalent user-visible behavior.
- R2: sqlite-ts SHALL include automated coverage for every section item in the parity checklist.
- R3: Any intentional SQLite divergence SHALL be documented with rationale and tracked follow-up work.

## Traceability

- Upstream docs:
  - `docs/reference/datamodel/functions.rst`
- sqlite-ts implementation:
  - `sqlite-ts/src/schema/declarative.ts`
  - `sqlite-ts/src/schema/uiSchema.ts`
  - `sqlite-ts/src/schema/schema.ts`
  - `sqlite-ts/src/types.ts`
  - `sqlite-ts/src/edgeql/ast.ts`
  - `sqlite-ts/src/edgeql/parser.ts`
  - `sqlite-ts/src/compiler/semantic.ts`
  - `sqlite-ts/src/ir/model.ts`
  - `sqlite-ts/src/runtime/engine.ts`
  - `sqlite-ts/src/sql/compiler.ts`
- sqlite-ts tests:
  - `sqlite-ts/tests/schema.functions-parity.test.ts`
  - `sqlite-ts/tests/schema_declarative.test.ts`
  - `sqlite-ts/tests/parser.test.ts`

## SQLite Notes

- sqlite-ts supports SDL and DDL-style function declarations in declarative schema source (`function`, `create function`, `alter function`, `drop function`) and materializes function metadata in the runtime schema snapshot.
- Function calls are supported in free-object expressions and computed shape expressions.
- Function arguments supplied as set literals are applied element-wise for expression-backed function bodies.
- Modifying function volatility is enforced at call time for single-cardinality argument requirements.
- Function body support is intentionally narrowed to:
  - expression bodies using parameter references, scalar literals, and concatenation (`++`), and
  - query bodies written in supported sqlite-ts EdgeQL subset.
- Full Gel function expression surface (arbitrary expression evaluation, full type system/operator coverage, and complete DDL execution semantics through the query engine) remains intentionally narrowed in sqlite-ts.

## Open Questions

- Q1: Which sections require exact behavior parity vs. documented SQLite-only approximation?
- Q2: What minimum test matrix proves parity for this page end-to-end?

## Change Log

- 2026-04-03: Implemented S1-S14 with declarative function DDL support, function invocation support, runtime execution, and parity coverage tests.
- 2026-04-02: Initial parity checklist generated from source headings.
