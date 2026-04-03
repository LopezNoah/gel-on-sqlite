# Reference Parity Gap Matrix

Status: Draft
Owners: sqlite-ts Core Team
Last Updated: 2026-04-02

## Purpose

Map each generated reference parity SPEC to existing sqlite-ts specs and highlight likely coverage gaps.

## Method

- Input set: `sqlite-ts/spec/reference-parity/SPEC-PARITY-*.md` (51 files).
- Mapping basis: source doc path (`docs/reference/datamodel/...` and `docs/reference/edgeql/...`).
- Coverage signal: checkboxes in `sqlite-ts/spec/TASKS.md` for mapped `SPEC-XXX` IDs.
- Interpretation: this is heuristic planning output, not proof of behavioral parity.

## Status Summary

- `likely-covered`: 25
- `partial-gap`: 24
- `needs-review`: 2

## Matrix

| Source .rst | Parity spec | Mapped sqlite-ts specs | Status | Notes |
|---|---|---|---|---|
| `docs/reference/datamodel/access_policies.rst` | `SPEC-PARITY-datamodel-access-policies.md` | `SPEC-013`, `SPEC-044` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/aliases.rst` | `SPEC-PARITY-datamodel-aliases.md` | `SPEC-010`, `SPEC-011`, `SPEC-021` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/annotations.rst` | `SPEC-PARITY-datamodel-annotations.md` | `SPEC-010`, `SPEC-011` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/branches.rst` | `SPEC-PARITY-datamodel-branches.md` | `SPEC-045` | `needs-review` | Mapped specs not present in TASKS status lines. |
| `docs/reference/datamodel/comparison.rst` | `SPEC-PARITY-datamodel-comparison.md` | `SPEC-000` | `needs-review` | Mapped specs not present in TASKS status lines. |
| `docs/reference/datamodel/computeds.rst` | `SPEC-PARITY-datamodel-computeds.md` | `SPEC-010`, `SPEC-011`, `SPEC-015`, `SPEC-034` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/constraints.rst` | `SPEC-PARITY-datamodel-constraints.md` | `SPEC-010`, `SPEC-011`, `SPEC-012`, `SPEC-013` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/extensions.rst` | `SPEC-PARITY-datamodel-extensions.md` | `SPEC-010`, `SPEC-011`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/functions.rst` | `SPEC-PARITY-datamodel-functions.md` | `SPEC-010`, `SPEC-011`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/future.rst` | `SPEC-PARITY-datamodel-future.md` | `SPEC-010`, `SPEC-011` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/globals.rst` | `SPEC-PARITY-datamodel-globals.md` | `SPEC-010`, `SPEC-011`, `SPEC-021` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/index.rst` | `SPEC-PARITY-datamodel-index.md` | `SPEC-010`, `SPEC-011`, `SPEC-012`, `SPEC-014` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/indexes.rst` | `SPEC-PARITY-datamodel-indexes.md` | `SPEC-010`, `SPEC-011`, `SPEC-012` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/inheritance.rst` | `SPEC-PARITY-datamodel-inheritance.md` | `SPEC-010`, `SPEC-011`, `SPEC-014` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/introspection/casts.rst` | `SPEC-PARITY-datamodel-introspection-casts.md` | `SPEC-010`, `SPEC-021`, `SPEC-052`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/introspection/colltypes.rst` | `SPEC-PARITY-datamodel-introspection-colltypes.md` | `SPEC-010`, `SPEC-021`, `SPEC-052` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/introspection/constraints.rst` | `SPEC-PARITY-datamodel-introspection-constraints.md` | `SPEC-010`, `SPEC-021`, `SPEC-052` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/introspection/functions.rst` | `SPEC-PARITY-datamodel-introspection-functions.md` | `SPEC-010`, `SPEC-021`, `SPEC-052`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/introspection/index.rst` | `SPEC-PARITY-datamodel-introspection-index.md` | `SPEC-010`, `SPEC-021`, `SPEC-052` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/introspection/indexes.rst` | `SPEC-PARITY-datamodel-introspection-indexes.md` | `SPEC-010`, `SPEC-021`, `SPEC-052` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/introspection/mutation_rewrites.rst` | `SPEC-PARITY-datamodel-introspection-mutation-rewrites.md` | `SPEC-010`, `SPEC-013`, `SPEC-021`, `SPEC-052` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/introspection/objects.rst` | `SPEC-PARITY-datamodel-introspection-objects.md` | `SPEC-010`, `SPEC-021`, `SPEC-052` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/introspection/operators.rst` | `SPEC-PARITY-datamodel-introspection-operators.md` | `SPEC-010`, `SPEC-021`, `SPEC-052`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/introspection/scalars.rst` | `SPEC-PARITY-datamodel-introspection-scalars.md` | `SPEC-010`, `SPEC-021`, `SPEC-052`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/introspection/triggers.rst` | `SPEC-PARITY-datamodel-introspection-triggers.md` | `SPEC-010`, `SPEC-013`, `SPEC-021`, `SPEC-052` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/linkprops.rst` | `SPEC-PARITY-datamodel-linkprops.md` | `SPEC-010`, `SPEC-011`, `SPEC-014`, `SPEC-015` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/links.rst` | `SPEC-PARITY-datamodel-links.md` | `SPEC-010`, `SPEC-011`, `SPEC-014`, `SPEC-015` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/migrations.rst` | `SPEC-PARITY-datamodel-migrations.md` | `SPEC-011`, `SPEC-012` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/modules.rst` | `SPEC-PARITY-datamodel-modules.md` | `SPEC-010`, `SPEC-011` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/mutation_rewrites.rst` | `SPEC-PARITY-datamodel-mutation-rewrites.md` | `SPEC-013` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/objects.rst` | `SPEC-PARITY-datamodel-objects.md` | `SPEC-010`, `SPEC-011`, `SPEC-014` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/permissions.rst` | `SPEC-PARITY-datamodel-permissions.md` | `SPEC-013`, `SPEC-044` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/datamodel/primitives.rst` | `SPEC-PARITY-datamodel-primitives.md` | `SPEC-010`, `SPEC-011`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/properties.rst` | `SPEC-PARITY-datamodel-properties.md` | `SPEC-010`, `SPEC-011`, `SPEC-014`, `SPEC-015` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/datamodel/triggers.rst` | `SPEC-PARITY-datamodel-triggers.md` | `SPEC-013` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/edgeql/analyze.rst` | `SPEC-PARITY-edgeql-analyze.md` | `SPEC-020`, `SPEC-021`, `SPEC-041` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/edgeql/delete.rst` | `SPEC-PARITY-edgeql-delete.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-031`, `SPEC-032`, `SPEC-033` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/for.rst` | `SPEC-PARITY-edgeql-for.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-031`, `SPEC-032` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/group.rst` | `SPEC-PARITY-edgeql-group.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-031`, `SPEC-032` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/index.rst` | `SPEC-PARITY-edgeql-index.md` | `SPEC-020`, `SPEC-021`, `SPEC-023`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/insert.rst` | `SPEC-PARITY-edgeql-insert.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-031`, `SPEC-032`, `SPEC-033` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/literals.rst` | `SPEC-PARITY-edgeql-literals.md` | `SPEC-020`, `SPEC-021`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/parameters.rst` | `SPEC-PARITY-edgeql-parameters.md` | `SPEC-020`, `SPEC-021`, `SPEC-041`, `SPEC-043` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/edgeql/path_resolution.rst` | `SPEC-PARITY-edgeql-path-resolution.md` | `SPEC-021`, `SPEC-022`, `SPEC-023` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/edgeql/paths.rst` | `SPEC-PARITY-edgeql-paths.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-023` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/edgeql/select.rst` | `SPEC-PARITY-edgeql-select.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-023`, `SPEC-031`, `SPEC-032`, `SPEC-034`, `SPEC-035` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/sets.rst` | `SPEC-PARITY-edgeql-sets.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-023` | `likely-covered` | Mapped specs marked complete in TASKS. |
| `docs/reference/edgeql/transactions.rst` | `SPEC-PARITY-edgeql-transactions.md` | `SPEC-040`, `SPEC-042` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/types.rst` | `SPEC-PARITY-edgeql-types.md` | `SPEC-020`, `SPEC-021`, `SPEC-060` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/update.rst` | `SPEC-PARITY-edgeql-update.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-031`, `SPEC-032`, `SPEC-033` | `partial-gap` | Mapped specs are split across complete and pending items. |
| `docs/reference/edgeql/with.rst` | `SPEC-PARITY-edgeql-with.md` | `SPEC-020`, `SPEC-021`, `SPEC-022`, `SPEC-023`, `SPEC-034` | `likely-covered` | Mapped specs marked complete in TASKS. |
