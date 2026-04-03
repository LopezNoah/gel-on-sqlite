# SPEC-054: Studio Lib Transplant, Tailwind Conversion, and sqlite-ts Adapter

Status: Draft
Owners: sqlite-ts maintainers
Last Updated: 2026-04-02

## Purpose

Define a concrete migration plan to achieve near full parity with `gel-ui-main` Studio tabs by:

1. Moving required Gel Studio/UI code into `sqlite-ts/ui/src/lib`.
2. Converting the imported SCSS-driven UI to Tailwind-based styling.
3. Building a sqlite-ts adapter layer so transplanted Studio logic runs against sqlite-ts HTTP endpoints.

This spec establishes an implementation sequence that allows fast parity gains while keeping the Astro app maintainable.

## Scope

- In scope:
  - Transplanting required code for `dashboard`, `queryEditor`, `dataview`, `perfStats`, and `schema` from `gel-ui-main` into `sqlite-ts/ui/src/lib`.
  - Bringing over required state/router contracts used by `databasePage/index.tsx` and tab specs.
  - Introducing package dependencies used by transplanted code when not available in current Astro UI.
  - Building a sqlite-ts adapter for query execution, schema loading, and trace/step rendering.
  - Converting imported SCSS module styling to Tailwind classes over phased milestones.

- In scope (supporting work):
  - Alias and module-resolution setup so `src/lib` code is importable without workspace package indirection.
  - A compatibility layer for features that exist in Gel runtime but not in sqlite-ts backend.

## Non-Goals

- Out of scope:
  - Full parity for tabs not requested (`auth`, `ai`, `graphql`, `repl` as separate tab).
  - Perfect one-pass replacement of all SCSS with Tailwind at transplant time.
  - Reproducing Gel server-side capabilities that sqlite-ts does not implement (role/branch administration, full protocol feature set).
  - Maintaining strict source-level synchronization with upstream `gel-ui-main` after import.

## Current Baseline

- `sqlite-ts/ui` runs Astro + React + Tailwind.
- A local `databasePage`-style tab spec structure is already present in `sqlite-ts/ui/src/components/studio`.
- Backend contract currently available to UI:
  - `POST /query` (with optional `includeSteps`)
  - `GET /schema`
  - `GET /schema/source`
  - `POST /schema/plan`
  - `POST /schema/apply`

## Target Architecture

### A. Source Layout in Astro UI

New layout under `sqlite-ts/ui/src/lib`:

- `src/lib/gel/common/*` (imported/adapted from `gel-ui-main/shared/common`)
- `src/lib/gel/codeEditor/*`
- `src/lib/gel/inspector/*`
- `src/lib/gel/schemaGraph/*`
- `src/lib/gel/studio/*`
  - `components/databasePage/*`
  - `hooks/dbRoute.ts`
  - `state/*`
  - `tabs/dashboard/*`
  - `tabs/queryEditor/*`
  - `tabs/dataview/*`
  - `tabs/perfStats/*`
  - `tabs/schema/*`
- `src/lib/sqliteAdapter/*`
  - `connection.ts`
  - `schema.ts`
  - `query.ts`
  - `errors.ts`
  - `capabilities.ts`

### B. Import Strategy

- Replace `@edgedb/*` imports with local aliases rooted in `src/lib/gel/*`.
- Keep file structure close to upstream during first transplant to minimize breakage.
- Defer heavy refactors until after functionality is passing.

### C. UI Composition

- `StudioApp` should mount a `DatabasePageContent` contract driven by `DatabaseTabSpec[]` (upstream pattern).
- Each requested tab should expose a spec object with `path`, `label`, `usesSessionState`, and `element`.

## Dependency Plan

The Astro UI will require a controlled expansion of dependencies used by transplanted code.

### Required Third-Party Packages (initial expectation)

- State and model:
  - `mobx`
  - `mobx-keystone`
  - `mobx-react-lite`
- Error boundary and forms/utilities (as required by selected tabs):
  - `react-error-boundary`
  - `react-window`
  - `@types/react-window`
- Editor and language utilities (query/schema tabs):
  - `@codemirror/state`
  - `@codemirror/view`
  - `@codemirror/language`
  - `@codemirror/commands`
  - `@codemirror/autocomplete`
  - `@codemirror/lint`
  - `@codemirror/lang-sql`
  - `@codemirror/lang-json`
  - `@replit/codemirror-indentation-markers`
- Data/schema helpers used by imported components:
  - `fuzzysort`
  - `idb`
- Styling/runtime support:
  - `sass` (temporary bridge until full Tailwind conversion)

Note: package list may be reduced or expanded during implementation as exact imports are verified per tab.

## sqlite-ts Adapter Requirements

### R1: Query Adapter

- Provide a query interface expected by transplanted tab state.
- Map query calls to `POST /query` with sqlite-ts request/response normalization.
- Support `includeSteps` and preserve step artifacts (`ast`, `ir`, `sql`, `compiler`, `sqlTrail`, `overlays`).

### R2: Schema Adapter

- Provide schema fetch and shape normalization from `GET /schema` and `GET /schema/source`.
- Supply data in a shape consumable by transplanted schema/dataview modules.

### R3: Schema Mutation Adapter

- Implement plan/apply flows via `POST /schema/plan` and `POST /schema/apply`.
- Normalize migration plan and SQL payloads to tab expectations.

### R4: Capability Model

- Expose feature flags for unsupported Gel-only capabilities.
- Tabs must gracefully disable or hide unsupported actions instead of throwing runtime errors.

### R5: Error Normalization

- Normalize sqlite-ts errors into a consistent UI error model for editor/dataview/perf views.

## Tailwind Conversion Strategy

Use a three-stage approach to avoid blocking parity:

### Stage 1: Functional Import Bridge

- Temporarily allow SCSS modules for imported components.
- Focus on behavior parity and adapter correctness.

### Stage 2: Token Mapping

- Create a Tailwind token map that mirrors key visual variables from Gel Studio:
  - surfaces, borders, text tiers, accent, error, spacing, radius, shadows.
- Replace shared primitives first (button, input, panel, tabs), then tab-specific styles.

### Stage 3: Tab-by-Tab SCSS Elimination

- Convert requested tabs in order:
  1. `dashboard`
  2. `queryEditor`
  3. `dataview`
  4. `perfStats`
  5. `schema`
- Remove SCSS files only when visual and interaction parity checks pass.

## Implementation Phases

### Phase 0: Workspace + Tooling

- Add required npm packages.
- Configure aliases for `src/lib/gel/*` in TS/Astro/Vite.
- Enable temporary SCSS module support.
- Add migration guard docs in `ui/README` for local development.

### Phase 1: Lib Transplant Skeleton

- Copy minimal required upstream directories into `src/lib/gel/*`.
- Rewrite import paths from `@edgedb/*` to local alias paths.
- Keep module/file names close to upstream for easier diff tracking.

### Phase 2: sqlite Adapter

- Implement adapter services for query/schema/plan/apply.
- Replace upstream connection calls with adapter calls.
- Add unit tests for adapter normalization and error mapping.

### Phase 3: DatabasePage + Tabs Integration

- Wire transplanted `databasePage` and tab specs into Astro `StudioApp`.
- Enable requested tabs with graceful fallback for unsupported actions.

### Phase 4: Tailwind Conversion

- Convert shared primitives first, then each requested tab.
- Keep visual parity snapshots and behavior checks per tab.

### Phase 5: Hardening

- Remove dead bridge code.
- Document any intentional deviations from Gel behavior.
- Finalize acceptance checklist.

## Acceptance Criteria

- A1: `databasePage` orchestration is spec-driven via tab specs and matches upstream flow semantics.
- A2: Requested tabs render and function against sqlite-ts backend without runtime crashes.
- A3: Query editor shows result and step outputs from sqlite-ts traces.
- A4: Dataview supports type selection, filtering, sorting, and nested object traversal.
- A5: Schema tab supports text/inspection workflow with plan/apply via adapter.
- A6: Perf stats tab operates with sqlite-ts-compatible data source (real or declared fallback model).
- A7: Tailwind-based styling reaches visual near-parity for all requested tabs.

## Risks and Mitigations

- Risk: Upstream state assumptions tied to Gel internals.
  - Mitigation: Adapter boundary + explicit capability flags.
- Risk: Large SCSS surface slows Tailwind conversion.
  - Mitigation: staged bridge with shared token conversion first.
- Risk: Dependency bloat in Astro app.
  - Mitigation: strict package audit after each phase; remove unused dependencies.
- Risk: Import churn during vendoring.
  - Mitigation: keep directory structure close to upstream and script path rewrites.

## Traceability

- Upstream source references:
  - `gel-ui-main/shared/studio/components/databasePage/index.tsx`
  - `gel-ui-main/shared/studio/tabs/dashboard/*`
  - `gel-ui-main/shared/studio/tabs/queryEditor/*`
  - `gel-ui-main/shared/studio/tabs/dataview/*`
  - `gel-ui-main/shared/studio/tabs/perfStats/*`
  - `gel-ui-main/shared/studio/tabs/schema/*`
- sqlite-ts integration points:
  - `sqlite-ts/src/http/server.ts`
  - `sqlite-ts/ui/src/components/studio/*`
  - `sqlite-ts/ui/src/lib/sqliteAdapter/*` (new)

## Open Questions

- Q1: Should SCSS bridging be allowed until 100% Tailwind conversion, or only during Phases 1-3?
- Q2: Should `queryEditor` SQL mode remain visible but disabled, or be hidden until supported in sqlite-ts?
- Q3: For perf stats, should we build a backend endpoint now or keep history-derived client stats as interim behavior?

## Change Log

- 2026-04-02: Initial draft for `src/lib` transplant + Tailwind conversion + sqlite adapter plan.
