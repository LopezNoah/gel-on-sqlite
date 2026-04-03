# SPEC-040: Server Runtime Architecture

Status: Draft
Owners: Server Team
Last Updated: 2026-04-02

## Purpose

Define core runtime responsibilities and boundaries for the server package.

## Scope

- Process lifecycle, request handling, and internal service boundaries.
- Core integration points: compiler pool, protocol, config, and tenant management.

## Non-Goals

- OS-level service manager behavior.
- External deployment topology.

## Requirements

- R1: Runtime must provide stable request processing pipeline boundaries.
- R2: Compiler and protocol integration points must be explicit and traceable.
- R3: Runtime error handling must preserve service safety and diagnostics.

## Behavior and Flows

- Bootstraps server settings and runtime components.
- Accepts requests through protocol handlers.
- Delegates compilation and execution to compiler and backend connectors.

## Traceability

- Code:
  - `edb/server/main.py`
  - `edb/server/server.py`
  - `edb/server/tenant.py`
  - `edb/server/compiler_pool/`
- Tests:
  - `tests/test_server_ops.py`
  - `tests/test_server_unit.py`
  - `tests/test_server_concurrency.py`

## Implementation References

| Claim | Source lines |
|---|---|
| Runtime bootstrap/start lifecycle is in main server entrypoints | `edb/server/main.py:192`, `edb/server/main.py:461`, `edb/server/main.py:793` |
| Core server object defines protocol and compiler-pool integration | `edb/server/server.py:104`, `edb/server/server.py:627`, `edb/server/server.py:740` |
| Tenant boundary owns schema parse and compiler-pool interactions | `edb/server/tenant.py:106`, `edb/server/tenant.py:558`, `edb/server/tenant.py:1304`, `edb/server/tenant.py:1556` |

## Open Questions

- Q1: Should runtime state machine diagrams be added to this spec in a follow-up?

## Change Log

- 2026-04-02: Initial draft.
