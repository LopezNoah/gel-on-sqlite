# SPEC-023: Cardinality, Multiplicity, and Volatility Inference

Status: Implemented
Owners: EdgeQL Compiler Team
Last Updated: 2026-04-02

## Purpose

Specify inference guarantees for cardinality, multiplicity, and volatility analysis.

## Scope

- Inference inputs, outputs, and consistency constraints.
- Error behavior for unsupported or contradictory inference states.

## Non-Goals

- Cost estimation and planner heuristics.
- Full formal proof of inference algorithm.

## Requirements

- R1: Inference results must be deterministic for equivalent query and schema inputs.
- R2: Inference outcomes must be consumable by downstream compilation phases.
- R3: Contradictions in inference assumptions must be surfaced as compile-time errors.

## Behavior and Flows

- Inference modules process compiled expressions and context.
- Results feed normalization, shaping, and backend lowering decisions.
- Diagnostics include enough context for debugging.
- sqlite-ts emits inference metadata on select IR (`cardinality`, `multiplicity`, `volatility`) for downstream runtime/lowering consumers.
- Contradictory inference inputs (for example, invalid pagination bounds discovered during semantic analysis) surface as `E_SEMANTIC` compile-time errors.

## Traceability

- Code:
  - `edb/edgeql/compiler/inference/cardinality.py`
  - `edb/edgeql/compiler/inference/multiplicity.py`
  - `edb/edgeql/compiler/inference/volatility.py`
- Tests:
  - `tests/test_edgeql_ir_card_inference.py`
  - `tests/test_edgeql_ir_mult_inference.py`
  - `tests/test_edgeql_ir_volatility_inference.py`

## Open Questions

- Q1: Should a stable debug format for inference traces be standardized?

## Change Log

- 2026-04-02: Initial draft.
- 2026-04-02: Marked implemented in sqlite-ts with deterministic select inference metadata propagation.
