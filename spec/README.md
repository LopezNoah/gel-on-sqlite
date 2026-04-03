# sqlite-ts Spec Workspace

This folder is the sqlite-ts-local spec workspace.

## Why this exists

- Keep spec work close to the TypeScript + SQLite implementation.
- Keep upstream and sqlite-ts specs collocated in this single `spec/` folder.
- Allow sqlite-ts specific planning/checklists without touching backend-specific assumptions in every upstream spec.

## Current layout

- `TASKS.md` - sqlite-ts implementation checklist.
- `SPEC-034-select-query-reference.md` - sqlite-ts reference contract for `select.rst` semantics (shapes, computeds, backlinks, polymorphism).
- `SPEC-035-single-statement-shape-lowering.md` - implemented SQL-side nested shape/backlink JSON aggregation lowering to reduce runtime multi-query expansion.
- `SPEC-041-compiler-interface-and-caching.md` - compiler service request/response contract, deterministic cache keys, and trace-visible cache metadata.
- `SPEC-052-ui-schema-management-and-studio-parity.md` - Astro UI parity roadmap for schema editing/apply, type/link exploration, query suggestions, and data-browser traversal.
- `SPEC-054-studio-lib-transplant-tailwind-and-sqlite-adapter.md` - plan for importing Gel Studio code into `ui/src/lib`, adding required dependencies, converting to Tailwind, and bridging to sqlite-ts APIs.
- `SPEC-015-schema-pointer-metadata.md` - sqlite-ts metadata contract for computed fields/backlinks and upstream Gel alignment.
- `SPEC-014-schema-storage-and-polymorphism.md` - detailed PostgreSQL storage/polymorphism reference with line-level evidence.
- `reference-parity/` - one-to-one parity specs generated from `docs/reference/datamodel/**/*.rst` and `docs/reference/edgeql/**/*.rst` for sqlite-ts feature tracking.
- `UPSTREAM-README.md` - preserved upstream spec workspace README from `edb/spec`.

## Migration plan

- Phase 1: Keep upstream mirror content synchronized directly in `sqlite-ts/spec`.
- Phase 2: Copy/adapt target specs into `sqlite-ts/spec/` as sqlite-specific specs become active.
- Phase 3: Mark each sqlite-ts spec with source evidence and deviation notes from PostgreSQL behavior.
