# SPEC-052: UI Schema Management and Studio Parity (Astro)

Status: In Progress
Owners: sqlite-ts UI + Runtime Team
Last Updated: 2026-04-02

## Purpose

Define the sqlite-ts UI parity roadmap for Gel UI structure/language, starting with in-browser schema exploration and schema editing/migration apply from the Astro frontend.

## Scope

- Astro UI shell and interaction model aligned to Gel UI visual language.
- Runtime schema introspection endpoints used by UI (`/schema`, `/schema/source`).
- Runtime schema apply endpoint (`/schema/apply`) for declarative schema edits.
- Type/object/link inspection experience in the Astro UI.

## Non-Goals

- Full 1:1 feature parity with all Gel UI Studio tabs in this milestone.
- Rich code editor migration (CodeMirror embedding) in this first schema-management slice.
- AuthN/AuthZ posture for schema mutation endpoints (tracked by `SPEC-044`).

## Requirements

- R1: sqlite-ts MUST expose schema source text to the frontend in a stable JSON response contract.
- R2: sqlite-ts MUST accept declarative schema source updates from the frontend and apply migrations against current runtime state.
- R3: sqlite-ts MUST return updated types and migration plan metadata after schema apply.
- R4: Astro UI MUST allow editing schema source and applying changes without leaving the UI.
- R5: Astro UI MUST display concrete types with field/link metadata (including link targets and multiplicity hints).
- R6: sqlite-ts MUST preserve query endpoint compatibility while schema-management endpoints are added.
- R7: sqlite-ts MUST document known parity gaps vs Gel UI Studio and map next chunks.
- R8: sqlite-ts MUST provide a dry-run schema planning path that returns migration steps and rendered SQL without mutating runtime schema.

## Gel UI Visual/Structural References

- Shell and navigation structure:
  - `gel-ui-main/web/src/app.tsx`
  - `gel-ui-main/web/src/components/header/index.tsx`
  - `gel-ui-main/web/src/components/main/index.tsx`
- Database/instance orientation:
  - `gel-ui-main/web/src/components/databasePage/index.tsx`
  - `gel-ui-main/web/src/components/instancePage/index.tsx`
- Studio tab ergonomics and REPL/editor layout:
  - `gel-ui-main/shared/studio/tabs/repl/index.tsx`
  - `gel-ui-main/shared/studio/tabs/repl/repl.module.scss`

## sqlite-ts Chunk Plan

- Chunk 1 (this change):
  - Add schema source read/apply HTTP endpoints.
  - Add Astro Schema page with source editor + type/link explorer.
- Chunk 2:
  - Add richer schema graph/list interactions (type filtering, module grouping, field/link badges).
  - Add dry-run migration plan + SQL preview endpoint and UI flow.
  - Add query/editor page integration with schema selection context.
- Chunk 3:
  - Add Studio-like data browser affordances for object rows and link traversal. (Implemented)
  - Add UI state persistence for editor/source drafts. (Implemented)
  - Add query editor keyword/type/field suggestion assistance for REPL-like ergonomics. (Implemented)

## Current sqlite-ts Notes

- Runtime currently maps declarative schema to runtime `TypeDef` shape and SQLite storage through migration planner/apply.
- Link property and multi-property semantics are partially represented in storage/migration but UI parity for editing/inspection remains incremental.
- Schema mutation endpoints are currently unauthenticated and intended for local development use.

## Traceability

- sqlite-ts code:
  - `sqlite-ts/src/http/server.ts`
  - `sqlite-ts/src/schema/uiSchema.ts`
  - `sqlite-ts/src/index.ts`
  - `sqlite-ts/ui/src/pages/types.astro`
- sqlite-ts tests:
  - `sqlite-ts/tests/http.test.ts`

## Open Questions

- Q1: Should schema apply support preview/dry-run mode before mutating SQLite state?
- Q2: Should schema apply be rejected while queries are in-flight in long-lived server mode?

## Change Log

- 2026-04-02: Initial spec for schema-management parity slice in Astro UI.
- 2026-04-02: Added dry-run schema plan + SQL preview and schema-aware query context chunk.
- 2026-04-02: Added schema graph panel, query-side data browser traversal, local schema draft history (undo/redo/restore), and query keyword/type/field suggestions.
