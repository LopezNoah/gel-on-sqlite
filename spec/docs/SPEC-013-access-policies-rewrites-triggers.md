# SPEC-013: Access Policies, Rewrites, and Triggers

Status: Draft
Owners: Schema and Compiler Teams
Last Updated: 2026-04-02

## Purpose

Specify behavioral contracts for policy enforcement, rewrite processing, and trigger execution.

## Scope

- Policy semantics during query compilation.
- Rewrite and trigger integration points.

## Non-Goals

- Policy authoring UX.
- Auditing storage and external observability integrations.

## Requirements

- R1: Access policies must be applied consistently for equivalent query shapes.
- R2: Rewrites must preserve declared semantics while transforming expressions.
- R3: Trigger behavior must execute in deterministic ordering where defined.

## Behavior and Flows

- Policy analysis occurs during semantic compilation.
- Rewrites alter query representation before backend lowering.
- Triggers register and fire during relevant data mutation operations.

## Traceability

- Code:
  - `edb/schema/policies.py`
  - `edb/schema/rewrites.py`
  - `edb/schema/triggers.py`
  - `edb/edgeql/compiler/policies.py`
  - `edb/edgeql/compiler/triggers.py`
- Tests:
  - `tests/test_edgeql_policies.py`
  - `tests/test_edgeql_rewrites.py`
  - `tests/test_edgeql_triggers.py`

## Implementation References

| Claim | Source lines |
|---|---|
| Access policy schema model and commands are explicit | `edb/schema/policies.py:45`, `edb/schema/policies.py:284`, `edb/schema/policies.py:452` |
| Policy filters are compiled into DML flows | `edb/edgeql/compiler/policies.py:75`, `edb/edgeql/compiler/policies.py:528`, `edb/edgeql/compiler/policies.py:569` |
| Rewrite model and schema commands are explicit | `edb/schema/rewrites.py:43`, `edb/schema/rewrites.py:368`, `edb/schema/rewrites.py:467` |
| Rewrite compilation occurs in view generation pipeline | `edb/edgeql/compiler/viewgen.py:592`, `edb/edgeql/compiler/viewgen.py:1061`, `edb/edgeql/compiler/viewgen.py:1204` |
| Trigger model and compile/runtime phases are explicit | `edb/schema/triggers.py:43`, `edb/schema/triggers.py:283`, `edb/edgeql/compiler/triggers.py:55`, `edb/edgeql/compiler/triggers.py:209` |

## Open Questions

- Q1: Should policy and rewrite explainability output be standardized in this spec set?

## Change Log

- 2026-04-02: Initial draft.
