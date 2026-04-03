# SPEC-051: Language Server Behavior

Status: Draft
Owners: Tooling Team
Last Updated: 2026-04-02

## Purpose

Specify expected behavior for language server capabilities powered by `edb/language_server/`.

## Scope

- Parsing and project model integration for editor features.
- Completion and definition behavior contracts.

## Non-Goals

- Editor plugin packaging.
- UI rendering details in client editors.

## Requirements

- R1: Language server must provide deterministic results for equivalent project state.
- R2: Completion and definition responses must be schema- and context-aware.
- R3: Parse errors must be recoverable enough to support incremental tooling workflows.

## Behavior and Flows

- Build project context.
- Parse source text and map symbols.
- Produce LSP-style completion and definition responses.

## Traceability

- Code:
  - `edb/language_server/server.py`
  - `edb/language_server/parsing.py`
  - `edb/language_server/completion.py`
  - `edb/language_server/definition.py`
- Tests:
  - `tests/test_language_server.py`

## Open Questions

- Q1: Should performance budgets for completion latency be codified here?

## Change Log

- 2026-04-02: Initial draft.
