# EDB Spec Index

This folder is the starting point for spec-driven development in `edb/`.

## How to Use These Specs

- Start new work by linking a change to one or more SPEC files.
- Update requirements in SPEC first, then implement code.
- Keep each requirement testable and traceable to `tests/`.
- Keep status current (`Draft`, `Active`, `Implemented`, `Deprecated`).

## Authoring Rules

- Use `edb/spec/_templates/SPEC_TEMPLATE.md` for new specs.
- Requirement IDs use `R<number>` and should be stable over time.
- Keep scope explicit; add non-goals to avoid accidental expansion.
- Add code and test traceability for every major requirement.

## Current Specs

- `SPEC-000-system-overview.md`
- `SPEC-001-end-to-end-query-lifecycle.md`
- `SPEC-010-schema-object-model.md`
- `SPEC-011-schema-ddl-sdl-pipeline.md`
- `SPEC-012-schema-migrations.md`
- `SPEC-013-access-policies-rewrites-triggers.md`
- `SPEC-014-schema-storage-and-polymorphism.md`
- `SPEC-020-edgeql-ast-parser.md`
- `SPEC-021-edgeql-semantic-compilation.md`
- `SPEC-022-ir-model-and-scoping.md`
- `SPEC-023-cardinality-multiplicity-volatility.md`
- `SPEC-030-pgsql-compiler-architecture.md`
- `SPEC-031-ir-to-sql-lowering.md`
- `SPEC-032-sql-codegen-and-shapes.md`
- `SPEC-033-overlays-and-dml-visibility.md`
- `SPEC-040-server-runtime-architecture.md`
- `SPEC-041-compiler-interface-and-caching.md`
- `SPEC-042-binary-protocol-contract.md`
- `SPEC-043-http-api-surface.md`
- `SPEC-044-authn-authz-model.md`
- `SPEC-045-tenancy-and-ha-behavior.md`
- `SPEC-050-graphql-translation-layer.md`
- `SPEC-051-language-server-behavior.md`
- `SPEC-060-stdlib-and-builtins.md`
- `SPEC-070-testing-strategy-and-traceability.md`
