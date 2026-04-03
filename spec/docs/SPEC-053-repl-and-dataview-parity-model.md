# SPEC-053: REPL and Data Explorer Parity Model (gel-ui-main -> sqlite-ts)

Status: In Progress
Owners: sqlite-ts UI + Runtime Team
Last Updated: 2026-04-02

## Purpose

Define a near 1:1 behavioral model for REPL and Data Explorer parity with `gel-ui-main`, while keeping sqlite-ts implementation first-party (no Studio package imports).

## Reference Sources (gel-ui-main)

- REPL shell, prompt, history virtualization, run behavior:
  - `gel-ui-main/shared/studio/tabs/repl/index.tsx`
  - `gel-ui-main/shared/studio/tabs/repl/repl.module.scss`
- REPL statement/run heuristics and prompt gutter:
  - `gel-ui-main/shared/studio/tabs/repl/state/utils.ts`
- REPL slash command contract:
  - `gel-ui-main/shared/studio/tabs/repl/state/commands.ts`
- REPL state/history/cache model:
  - `gel-ui-main/shared/studio/tabs/repl/state/index.ts`
  - `gel-ui-main/shared/studio/idbStore/index.ts`
- Data Explorer shell/header/filter interactions:
  - `gel-ui-main/shared/studio/tabs/dataview/index.tsx`
  - `gel-ui-main/shared/studio/tabs/dataview/dataview.module.scss`
- Data grid shape and editor affordances:
  - `gel-ui-main/shared/studio/tabs/dataview/dataInspector.tsx`
  - `gel-ui-main/shared/studio/tabs/dataview/dataInspector.module.scss`
- Completion model used by Studio editor:
  - `gel-ui-main/shared/codeEditor/completions.ts`

## sqlite-ts Scope

- Parity target UI entrypoints:
  - `sqlite-ts/ui/src/pages/index.astro` (REPL + Data Explorer)
  - `sqlite-ts/ui/src/styles/global.css` (theme + component parity tokens)
- Runtime contracts consumed by REPL/Data Explorer:
  - `sqlite-ts/src/http/server.ts` (`/query`, `/schema`)

## REPL Interaction Model

### Input and execution

- R1: REPL accepts EdgeQL-like text input.
- R2: `Ctrl/Cmd+Enter` executes current input immediately.
- R3: `Enter` executes when either:
  - input is a slash command (`\...`), or
  - statement ends with `;` (Studio uses parse-aware `isEndOfStatement`; sqlite-ts uses semicolon heuristic in Astro for now).
- R4: `Shift+Enter` inserts newline.

### Prompt and mode

- R5: Prompt format is `<db>[<mode>]>` style (`sqlite-ts[edgeql]>` in local UI).
- R6: Language mode starts as EdgeQL.
- R7: SQL mode command is recognized but currently returns unsupported unless runtime SQL REPL path is added.

### Slash command behavior

- R8: Command family mirrors Studio REPL contract shape:
  - `\help`, `\h`, `\?`
  - list-style commands (`\l`, `\ls`, `\lt`)
  - `\set language edgeql|sql`
  - `\edgeql`, `\sql`
  - `\clear`, `\retro`
- R9: Unknown command returns explicit REPL command error.

### History model

- R10: Every query/command run creates a history item with:
  - language, query text, timestamp, status/error, and output summary.
- R11: History is persisted to browser storage in sqlite-ts UI.
- R12: Future parity step: migrate to IndexedDB model similar to Studio (`replHistory` and result payload cache).

## How suggestions work (what users can type)

Studio completion behavior is grammar-aware and schema-aware (`shared/codeEditor/completions.ts`):

- C1: After root keywords (`select`, `insert`, `update`, `delete`), suggest object types.
- C2: Inside shape braces (`{ ... }`), suggest properties and links for the selected object type.
- C3: Link suggestions insert object-shape stubs (for example `link_name: {}` style).
- C4: Completion source is schema metadata, not static string lists.
- C5: Studio uses parse tree context to validate where completion is legal.

sqlite-ts Astro parity implementation follows the same principle with a lighter parser strategy:

- C6: Root completions combine keywords + `/schema` type names.
- C7: Dot/shape context completions resolve against selected type or inferred root type.
- C8: Field/link suggestions include lightweight metadata labels (`type`, `link -> target`).
- C9: Keyboard behavior mirrors Studio editor expectations:
  - `Ctrl/Cmd+Space` open completions
  - arrow up/down navigate
  - `Tab` apply completion

## Data Explorer parity model

### Shell and controls

- D1: Data Explorer appears as a dedicated panel beside REPL.
- D2: Header includes object type selector, refresh, open type, filter toggle, row count.
- D3: Filter panel uses editor-like multiline input and explicit Apply/Clear/Disable actions.

### Grid behavior

- D4: Data renders as table/grid with sticky headers.
- D5: Header shows field name plus type metadata (property type or link target hint).
- D6: Sort toggles per column (asc/desc).
- D7: Row index column is always shown.
- D8: Object/list cells are drillable (nested stack with back navigation), aligned with Studio nested inspector flow.

## Theme parity model

- T1: sqlite-ts UI uses tokenized light/dark palette mapped to Studio neutral scale (`Grey*`) and accent system.
- T2: Theme toggle is first-party UI state persisted locally.
- T3: Retro mode remains REPL-specific visual state, matching Studio's terminal-like mode intent.

## Known parity gaps

- G1: No full CodeMirror/Lezer parser embedding in sqlite-ts Astro REPL yet.
- G2: No Studio-grade virtualized data grid with pinned columns/subtype headers/edit transactions.
- G3: No server-side result codec caching and lazy result decoding as in Studio.
- G4: SQL REPL execution mode is not active in sqlite-ts runtime path.

## Next steps

- N1: Move REPL parsing/completion logic into dedicated UI modules with parser-backed context checks.
- N2: Add IndexedDB-backed history/result cache mirroring Studio store contracts.
- N3: Add editable Data Explorer row operations and review/commit workflow parity.
- N4: Add parser-based `isEndOfStatement` equivalent for multiline correctness.
