# SPEC-042: Binary Protocol Contract

Status: Draft
Owners: Protocol Team
Last Updated: 2026-04-02

## Purpose

Define protocol-level contracts for request decoding, execution dispatch, and response encoding.

## Scope

- Binary protocol message handling.
- Error and status propagation through protocol boundaries.

## Non-Goals

- Driver-specific client retry behavior.
- HTTP API behavior.

## Requirements

- R1: Protocol handlers must validate message structure before execution.
- R2: Execution and type metadata must be serialized consistently.
- R3: Protocol errors must return well-classified error information.

## Behavior and Flows

- Decode message frames.
- Route requests to execution path.
- Encode success and failure responses with metadata.

## Traceability

- Code:
  - `edb/server/protocol/protocol.pyx`
  - `edb/server/protocol/frontend.pyx`
  - `edb/server/protocol/execute.pyx`
- Tests:
  - `tests/test_protocol.py`
  - `tests/test_server_proto.py`

## Open Questions

- Q1: Which backward compatibility guarantees should be required for protocol evolution?

## Change Log

- 2026-04-02: Initial draft.
