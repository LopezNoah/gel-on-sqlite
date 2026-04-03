# SPEC-020: EdgeQL AST and Parser

Status: Draft
Owners: EdgeQL Frontend Team
Last Updated: 2026-04-02

## Purpose

Define parser and AST guarantees for EdgeQL text to frontend representation.

## Scope

- AST shape and parser output constraints.
- Grammar responsibilities and parser error contracts.

## Non-Goals

- End-user language tutorial coverage.
- Query optimization.

## Requirements

- R1: Valid EdgeQL input must produce a valid AST compatible with semantic compiler expectations.
- R2: Syntax errors must include location and actionable diagnostics.
- R3: Tokenization and quoting semantics must remain consistent across parse modes.

## Behavior and Flows

- Tokenize query text and parse via grammar modules.
- Produce typed AST nodes in `ast.py`.
- Surface parser errors with source spans.

## Traceability

- Code:
  - `edb/edgeql/ast.py`
  - `edb/edgeql/tokenizer.py`
  - `edb/edgeql/parser/grammar/`
- Tests:
  - `tests/test_edgeql_syntax.py`

## Implementation References

| Claim | Source lines |
|---|---|
| AST base nodes retain source span support | `edb/edgeql/ast.py:87`, `edb/edgeql/ast.py:91`, `edb/edgeql/ast.py:479` |
| Tokenization path is explicit and parser-backed | `edb/edgeql/tokenizer.py:47`, `edb/edgeql/tokenizer.py:191`, `edb/edgeql/tokenizer.py:192` |
| Normalization/token cache path is part of tokenization contract | `edb/edgeql/tokenizer.py:110`, `edb/edgeql/tokenizer.py:141`, `edb/edgeql/tokenizer.py:142` |
| Grammar token inventory and keywords are centrally defined | `edb/edgeql/parser/grammar/tokens.py:295`, `edb/edgeql/parser/grammar/tokens.py:304` |

## Open Questions

- Q1: Which AST compatibility guarantees should be versioned for downstream tooling?

## Change Log

- 2026-04-02: Initial draft.
