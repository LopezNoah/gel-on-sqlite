# SPEC-070: Testing Strategy and Traceability

Status: Draft
Owners: QA and Core Teams
Last Updated: 2026-04-02

## Purpose

Define how specs map to automated tests and how coverage is tracked for spec-driven development.

## Scope

- Traceability model from requirements to tests.
- Test layer responsibilities (unit, integration, protocol, end-to-end).

## Non-Goals

- CI provider configuration details.
- Performance benchmark suite design.

## Requirements

- R1: Each active spec requirement must map to at least one automated test or a tracked gap.
- R2: New feature work must update both spec requirements and corresponding tests.
- R3: Traceability updates must be part of review acceptance criteria.

## Behavior and Flows

- Track requirement IDs in spec files.
- Link to authoritative tests under `tests/`.
- Record missing coverage in open questions or follow-up tasks.

## Traceability

- Code:
  - `edb/spec/`
  - `tests/`
- Tests:
  - `tests/test_sourcecode.py`
  - `tests/test_docs.py`
  - Broad coverage across `tests/test_*.py`

## Implementation References

| Claim | Source lines |
|---|---|
| Specs are authored with explicit process and traceability guidance | `edb/spec/README.md:7`, `edb/spec/README.md:9`, `edb/spec/README.md:17` |
| Source-code quality checks are enforced in test suite | `tests/test_sourcecode.py:39`, `tests/test_sourcecode.py:56`, `tests/test_sourcecode.py:77` |
| Documentation checks are part of automated test coverage | `tests/test_docs.py:121`, `tests/test_docs.py:440`, `tests/test_docs.py:600` |

## Open Questions

- Q1: Should traceability be machine-readable (for example YAML tables) in a future phase?

## Change Log

- 2026-04-02: Initial draft.
