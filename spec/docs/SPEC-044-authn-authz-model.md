# SPEC-044: Authentication and Authorization Model

Status: Draft
Owners: Security and Server Teams
Last Updated: 2026-04-02

## Purpose

Define identity, authentication, and authorization behavior across protocol and server layers.

## Scope

- Authentication entry points and identity verification.
- Authorization enforcement at request and query boundaries.

## Non-Goals

- External identity provider setup guides.
- Secret management infrastructure outside repository scope.

## Requirements

- R1: Authentication flow must reliably establish request identity context.
- R2: Authorization checks must apply consistently to protected operations.
- R3: Auth failures must avoid leaking sensitive internal details.

## Behavior and Flows

- Authenticate through protocol and auth extension handlers.
- Attach identity context to execution path.
- Enforce permissions and policy gates before sensitive operations.

## Traceability

- Code:
  - `edb/server/auth.py`
  - `edb/server/protocol/auth/`
  - `edb/server/protocol/auth_ext/`
  - `edb/schema/permissions.py`
- Tests:
  - `tests/test_server_auth.py`
  - `tests/test_http_auth.py`
  - `tests/test_http_ext_auth.py`

## Open Questions

- Q1: Should threat model assumptions be embedded directly in this spec?

## Change Log

- 2026-04-02: Initial draft.
