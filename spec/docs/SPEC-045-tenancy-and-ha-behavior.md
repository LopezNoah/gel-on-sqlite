# SPEC-045: Tenancy and High Availability Behavior

Status: Draft
Owners: Server Operations Team
Last Updated: 2026-04-02

## Purpose

Specify tenancy boundaries and HA behavior guarantees in server runtime.

## Scope

- Tenant isolation contracts.
- HA and failover interaction at server level.

## Non-Goals

- Cloud control-plane orchestration.
- Storage replication internals.

## Requirements

- R1: Tenant context separation must be enforced across request handling.
- R2: HA state transitions must preserve consistency guarantees.
- R3: Failure scenarios must define recovery or safe-degradation behavior.

## Behavior and Flows

- Runtime resolves tenant for incoming request.
- HA subsystem tracks backend availability.
- Routing and session behavior adapt to role changes and failures.

## Traceability

- Code:
  - `edb/server/tenant.py`
  - `edb/server/ha/`
  - `edb/server/multitenant.py`
  - `edb/server/pgcluster.py`
- Tests:
  - `tests/test_backend_ha.py`
  - `tests/test_server_concurrency.py`

## Open Questions

- Q1: Should explicit tenant SLA targets be represented in this repository spec set?

## Change Log

- 2026-04-02: Initial draft.
