# SPEC-080: EdgeQL Keyword and Tokenizer Parity

Status: Draft
Owners: sqlite-ts EdgeQL Frontend
Last Updated: 2026-04-09

## Purpose

Define the sqlite-ts parity contract for EdgeQL keyword classification and tokenization behavior based on upstream `edb/edgeql-parser`, so parsing and diagnostics remain stable as language coverage expands.

## Scope

- Keyword inventories and classification parity (`reserved`, `future reserved`, `partial reserved`, `unreserved`, and combined multi-word keywords).
- Tokenization parity for operators, literals, identifiers, keyword tokens, and source position spans.
- Validation/normalization parity for token values, keyword combining, token remapping, and EOF behavior.
- Error contract parity for syntax/token errors with location and actionable hints.

## Non-Goals

- Full parser grammar parity (covered in parse entrypoint spec).
- Full semantic compilation parity (covered in semantic compilation specs).
- Binary serialization compatibility with upstream Rust token payloads.

## Requirements

- R1: sqlite-ts MUST keep keyword classes equivalent to upstream `keywords.rs` categories, including combined keywords.
- R2: sqlite-ts MUST classify reserved vs unreserved keywords deterministically and expose lookup behavior used by parser and diagnostics.
- R3: sqlite-ts tokenizer MUST emit stable token kinds and lexemes for punctuation, operators, identifiers, literals, and grammar start tokens.
- R4: sqlite-ts tokenizer MUST preserve source location metadata (line, column, and/or byte offsets) suitable for parser and error reporting.
- R5: sqlite-ts normalization pass MUST support multi-word keyword folding (`named only`, `set annotation`, `set type`, `extension package`, `order by`) and token remapping semantics.
- R6: sqlite-ts literal parsing MUST validate and normalize token values for strings, numbers, bytes, parameters, and substitutions with deterministic failure behavior.
- R7: Tokenizer/normalizer errors MUST include a stable error code, message, and precise source location.
- R8: sqlite-ts MUST include golden parity tests for keyword tables and tokenizer outputs against curated upstream-aligned fixtures.

## Behavior and Flows

- Input EdgeQL text is scanned into token stream with raw token kinds and spans.
- Validation/normalization transforms raw tokens by parsing literal values, combining multi-word keywords, and remapping token variants.
- A terminal EOF token is appended for parser entrypoint consumption.
- Keyword lookup APIs serve both scanner and parser-level logic.
- Error flow short-circuits at first unrecoverable lexical/validation error and returns deterministic diagnostics.

## Required Project Structure (sqlite-ts)

```text
sqlite-ts/
  src/
    edgeql/
      ast.ts                              # existing
      parser.ts                           # existing
      tokenizer.ts                        # existing, parity-expanded
      keywords.ts                         # new: keyword sets + lookup API
      tokenKinds.ts                       # new: token kind enum/constants
      tokenizer_normalize.ts              # new: literal parsing + keyword combining + remap + eof
      position.ts                         # new: offset/line/column helpers
      diagnostics.ts                      # new or shared: edgeql lexical/parser diagnostic helpers
  tests/
    edgeql.keywords.test.ts               # new: class parity and lookup behavior
    edgeql.tokenizer.parity.test.ts       # new: token stream parity fixtures
    edgeql.tokenizer.errors.test.ts       # new: lexical/validation error parity
  spec/
    docs/
      SPEC-080-edgeql-keyword-tokenizer-parity.md
```

## Upstream-to-sqlite-ts Mapping

| Upstream file | sqlite-ts target | Responsibility |
|---|---|---|
| `edb/edgeql-parser/src/keywords.rs` | `sqlite-ts/src/edgeql/keywords.ts` | Keyword category tables and lookup/classification helpers |
| `edb/edgeql-parser/src/tokenizer.rs` | `sqlite-ts/src/edgeql/tokenizer.ts` | Scanner and raw token emission |
| `edb/edgeql-parser/src/validation.rs` | `sqlite-ts/src/edgeql/tokenizer_normalize.ts` | Value parsing, multi-word keyword folding, remap, EOF |
| `edb/edgeql-parser/src/position.rs` | `sqlite-ts/src/edgeql/position.ts` | Span and source-point conversion helpers |
| `edb/edgeql/parser/grammar/keywords.py` | `sqlite-ts/src/edgeql/keywords.ts` | Parser-facing keyword typing and token-name mapping |

## Milestones

- M1: Introduce `keywords.ts` and `tokenKinds.ts`; add parity tests for keyword classes.
- M2: Split tokenizer into scan + normalize stages matching upstream responsibilities.
- M3: Add literal parsing parity and multi-word keyword folding.
- M4: Add location fidelity checks and deterministic error snapshots.
- M5: Enforce fixture-based parity checks in CI.

## Traceability

- Upstream code:
  - `edb/edgeql-parser/src/keywords.rs`
  - `edb/edgeql-parser/src/tokenizer.rs`
  - `edb/edgeql-parser/src/validation.rs`
  - `edb/edgeql-parser/src/position.rs`
  - `edb/edgeql/parser/grammar/keywords.py`
- sqlite-ts code (target):
  - `sqlite-ts/src/edgeql/tokenizer.ts`
  - `sqlite-ts/src/edgeql/keywords.ts`
  - `sqlite-ts/src/edgeql/tokenizer_normalize.ts`
  - `sqlite-ts/src/edgeql/position.ts`
- sqlite-ts tests (target):
  - `sqlite-ts/tests/edgeql.keywords.test.ts`
  - `sqlite-ts/tests/edgeql.tokenizer.parity.test.ts`
  - `sqlite-ts/tests/edgeql.tokenizer.errors.test.ts`

## Implementation References

| Claim | Source lines |
|---|---|
| Upstream defines separate keyword classes and combined keywords | `edb/edgeql-parser/src/keywords.rs:3`, `edb/edgeql-parser/src/keywords.rs:117`, `edb/edgeql-parser/src/keywords.rs:119`, `edb/edgeql-parser/src/keywords.rs:152`, `edb/edgeql-parser/src/keywords.rs:211` |
| Upstream keyword lookup and classification helpers are explicit | `edb/edgeql-parser/src/keywords.rs:219`, `edb/edgeql-parser/src/keywords.rs:226`, `edb/edgeql-parser/src/keywords.rs:239` |
| Upstream tokenizer emits typed token kinds with spans and values | `edb/edgeql-parser/src/tokenizer.rs:17`, `edb/edgeql-parser/src/tokenizer.rs:29`, `edb/edgeql-parser/src/tokenizer.rs:73`, `edb/edgeql-parser/src/tokenizer.rs:149`, `edb/edgeql-parser/src/tokenizer.rs:174` |
| Upstream validator performs multi-word keyword folding and kind remapping | `edb/edgeql-parser/src/validation.rs:11`, `edb/edgeql-parser/src/validation.rs:35`, `edb/edgeql-parser/src/validation.rs:87`, `edb/edgeql-parser/src/validation.rs:220` |
| Upstream parser-facing keyword typing comes from grammar keywords module | `edb/edgeql/parser/grammar/keywords.py:31`, `edb/edgeql/parser/grammar/keywords.py:33`, `edb/edgeql/parser/grammar/keywords.py:66` |

## Open Questions

- Q1: Should sqlite-ts generate `keywords.ts` from upstream files automatically, or maintain a checked-in manually curated table with parity tests?
- Q2: Should sqlite-ts store token position as UTF-16 columns, byte offsets, or both for best compatibility with diagnostics and editor tooling?

## Change Log

- 2026-04-09: Initial draft for keyword and tokenizer parity contract with required file structure and upstream mapping.
