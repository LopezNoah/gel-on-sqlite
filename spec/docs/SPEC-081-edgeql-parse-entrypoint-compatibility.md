# SPEC-081: EdgeQL Parse Entrypoint Compatibility

Status: Draft
Owners: sqlite-ts EdgeQL Frontend
Last Updated: 2026-04-09

## Purpose

Define sqlite-ts compatibility requirements for parser entrypoints and grammar start modes, matching upstream EdgeQL parse behavior for query fragments, scripts, and SDL/DDL surfaces.

## Scope

- Public parse entrypoint API compatibility (`parse_fragment`, `parse_query`, `parse_block`, `parse_sdl`, migration/extension body helpers).
- Grammar start-token compatibility (`STARTFRAGMENT`, `STARTBLOCK`, `STARTMIGRATION`, `STARTEXTENSION`, `STARTSDLDOCUMENT`).
- CST-to-AST conversion contract and parser error reporting behavior.
- Parse-time module alias handling and expression-to-query wrapping behavior.

## Non-Goals

- Full grammar parity for every EdgeQL construct in one milestone.
- IR compilation and semantic inference behavior.
- Runtime execution or SQL lowering behavior.

## Requirements

- R1: sqlite-ts MUST expose explicit parse entrypoints for fragment, query, block/script, and SDL document parsing.
- R2: sqlite-ts parse entrypoints MUST distinguish grammar start modes equivalent to upstream start tokens and route parsing accordingly.
- R3: sqlite-ts query entrypoint MUST wrap bare expressions into query form when required by downstream compiler contracts.
- R4: sqlite-ts parse APIs MUST support module alias injection/normalization consistent with parse-query/script use cases.
- R5: sqlite-ts parser MUST return structured diagnostics with message, location, optional hint, and optional details.
- R6: sqlite-ts parse block/script mode MUST preserve statement boundaries and support semicolon-terminated and trailing-semicolon forms.
- R7: sqlite-ts SDL parse mode MUST return a schema-declaration AST root compatible with declarative schema planning.
- R8: sqlite-ts MUST include compatibility tests that assert parse mode behavior and error surface parity by entrypoint.

## Behavior and Flows

- Caller selects entrypoint (`parseFragment`, `parseQuery`, `parseBlock`, `parseSDL`, optional migration/extension-body helpers).
- Entrypoint selects grammar mode/start token and passes normalized token stream to parser.
- Parser returns CST and errors; CST is reduced into typed AST nodes.
- `parseQuery` wraps non-query expressions into a query AST node.
- Optional module aliases are applied to command/query AST nodes before returning.
- On parser errors, sqlite-ts surfaces deterministic syntax diagnostics with source positions.

## Required Project Structure (sqlite-ts)

```text
sqlite-ts/
  src/
    edgeql/
      ast.ts                              # existing
      tokenizer.ts                        # existing
      parser.ts                           # existing (internal parser engine)
      parse_entrypoints.ts                # new: public parse API surface and mode routing
      parse_modes.ts                      # new: start-token/entrypoint mode constants
      cst.ts                              # new: optional CST node model for debug/trace parity
      parser_errors.ts                    # new: parser diagnostic shaping and error heuristics
      grammar/
        index.ts                          # new: grammar wiring exports
        start.ts                          # new: top-level grammar start rules/modes
        statements.ts                     # new: statement grammar split
        ddl.ts                            # new: DDL grammar subset
        sdl.ts                            # new: SDL grammar subset
        tokens.ts                         # new: grammar token definitions
  tests/
    edgeql.parse.entrypoints.test.ts      # new: mode-by-mode entrypoint behavior
    edgeql.parse.errors.test.ts           # new: parse error structure and location checks
    edgeql.parse.sdl.test.ts              # new: SDL start-mode behavior
  spec/
    docs/
      SPEC-081-edgeql-parse-entrypoint-compatibility.md
```

## Upstream-to-sqlite-ts Mapping

| Upstream file | sqlite-ts target | Responsibility |
|---|---|---|
| `edb/edgeql/parser/__init__.py` | `sqlite-ts/src/edgeql/parse_entrypoints.ts` | Public parse entrypoints and alias handling |
| `edb/edgeql/parser/grammar/start.py` | `sqlite-ts/src/edgeql/grammar/start.ts` | Grammar start rules and entrypoint routing |
| `edb/edgeql/parser/grammar/tokens.py` | `sqlite-ts/src/edgeql/grammar/tokens.ts` | Grammar token classes and start-token definitions |
| `edb/edgeql-parser/src/tokenizer.rs` | `sqlite-ts/src/edgeql/tokenizer.ts` | Scanner/token stream for parser input |
| `edb/edgeql-parser/src/parser/mod.rs` | `sqlite-ts/src/edgeql/parser.ts` and `sqlite-ts/src/edgeql/cst.ts` | Parse engine behavior and CST model |
| `edb/edgeql-parser/src/parser/spec.rs` | `sqlite-ts/src/edgeql/parse_modes.ts` (and grammar artifacts) | Parse-table/start-mode representation strategy |

## API Contract (sqlite-ts Target)

- `parseFragment(source: string, options?): ExprAst`
- `parseQuery(source: string, options?): QueryAst`
- `parseBlock(source: string, options?): CommandAst[]`
- `parseSDL(source: string, options?): SchemaAst`
- `parseMigrationBody(source: string, options?): MigrationBodyAst`
- `parseExtensionPackageBody(source: string, options?): ExtensionPackageBodyAst`

Options contract should include:

- `filename?: string`
- `moduleAliases?: Record<string | "", string>`
- `errorMode?: "first" | "all"`

## Milestones

- M1: Introduce `parse_entrypoints.ts` and explicit parse mode constants.
- M2: Split parser API by start mode and add query-expression wrapping.
- M3: Add SDL mode root compatibility and script block boundary tests.
- M4: Add parser error-shaping helpers and deterministic diagnostics tests.
- M5: Add migration/extension-body helper compatibility wrappers.

## Traceability

- Upstream code:
  - `edb/edgeql/parser/__init__.py`
  - `edb/edgeql/parser/grammar/start.py`
  - `edb/edgeql/parser/grammar/tokens.py`
  - `edb/edgeql-parser/src/parser/mod.rs`
  - `edb/edgeql-parser/src/parser/spec.rs`
- sqlite-ts code (target):
  - `sqlite-ts/src/edgeql/parser.ts`
  - `sqlite-ts/src/edgeql/parse_entrypoints.ts`
  - `sqlite-ts/src/edgeql/parse_modes.ts`
  - `sqlite-ts/src/edgeql/grammar/start.ts`
  - `sqlite-ts/src/edgeql/grammar/tokens.ts`
- sqlite-ts tests (target):
  - `sqlite-ts/tests/edgeql.parse.entrypoints.test.ts`
  - `sqlite-ts/tests/edgeql.parse.errors.test.ts`
  - `sqlite-ts/tests/edgeql.parse.sdl.test.ts`

## Implementation References

| Claim | Source lines |
|---|---|
| Upstream parse entrypoints expose fragment/query/block/migration/extension/sdl parse APIs | `edb/edgeql/parser/__init__.py:51`, `edb/edgeql/parser/__init__.py:60`, `edb/edgeql/parser/__init__.py:80`, `edb/edgeql/parser/__init__.py:92`, `edb/edgeql/parser/__init__.py:103`, `edb/edgeql/parser/__init__.py:114` |
| Upstream parse query wraps bare expression into select query | `edb/edgeql/parser/__init__.py:70`, `edb/edgeql/parser/__init__.py:72` |
| Upstream parse applies module aliases to command AST nodes | `edb/edgeql/parser/__init__.py:37`, `edb/edgeql/parser/__init__.py:74`, `edb/edgeql/parser/__init__.py:86` |
| Grammar start tokens route parser to subgrammars | `edb/edgeql/parser/grammar/start.py:35`, `edb/edgeql/parser/grammar/start.py:44`, `edb/edgeql/parser/grammar/start.py:49`, `edb/edgeql/parser/grammar/start.py:64` |
| Start tokens are explicitly defined in grammar token inventory | `edb/edgeql/parser/grammar/tokens.py:50`, `edb/edgeql/parser/grammar/tokens.py:54`, `edb/edgeql/parser/grammar/tokens.py:58`, `edb/edgeql/parser/grammar/tokens.py:62`, `edb/edgeql/parser/grammar/tokens.py:66` |
| Upstream parser engine produces CST plus recoverable parse errors | `edb/edgeql-parser/src/parser/mod.rs:34`, `edb/edgeql-parser/src/parser/mod.rs:75`, `edb/edgeql-parser/src/parser/mod.rs:217`, `edb/edgeql-parser/src/parser/mod.rs:218` |

## Open Questions

- Q1: Should sqlite-ts preserve CST as a first-class public debug artifact, or keep CST internal and expose AST-only APIs?
- Q2: Should sqlite-ts initially surface only first parse error (upstream default behavior) or support optional multi-error output immediately?

## Change Log

- 2026-04-09: Initial draft for parse entrypoint compatibility, including required sqlite-ts file structure and API contract.
