# SPEC-043: HTTP API Surface

Status: Draft
Owners: Server and API Teams
Last Updated: 2026-04-02

## Purpose

Specify behavior of HTTP-exposed endpoints and extension paths.

## Scope

- Query and extension HTTP endpoints.
- Request validation and response contract behavior.
- sqlite-ts browser playground endpoint for interactive query debugging.

## Non-Goals

- Browser SDK ergonomics.
- CDN and edge caching strategy.

## Requirements

- R1: HTTP endpoints must enforce request validation and clear error semantics.
- R2: Endpoint behavior must map to server execution semantics consistently.
- R3: Extension endpoints must define isolation and compatibility boundaries.

## Behavior and Flows

- Parse and validate HTTP request payload.
- Delegate query or extension execution.
- Return typed response body with error metadata when needed.
- When query tracing is requested (`includeSteps: true`), return AST, IR, and SQL artifacts alongside query result.
- Serve browser playground UI at `/` with editable sample queries and rendered execution steps.

## Traceability

- Code:
  - `edb/server/http.py`
  - `edb/server/protocol/system_api.py`
  - `edb/server/protocol/edgeql_ext.pyx`
  - `edb/server/protocol/ui_ext.pyx`
- Tests:
  - `tests/test_http.py`
  - `tests/test_http_edgeql.py`
  - `tests/test_http_graphql_query.py`

## Implementation References

| Claim | Source lines |
|---|---|
| System API request routing and status/error shaping are explicit | `edb/server/protocol/system_api.py:37`, `edb/server/protocol/system_api.py:83`, `edb/server/protocol/system_api.py:118`, `edb/server/protocol/system_api.py:126` |
| EdgeQL HTTP extension validates payload and returns structured JSON errors | `edb/server/protocol/edgeql_ext.pyx:67`, `edb/server/protocol/edgeql_ext.pyx:115`, `edb/server/protocol/edgeql_ext.pyx:132`, `edb/server/protocol/edgeql_ext.pyx:153` |
| UI extension path has explicit HTTP status/content handling | `edb/server/protocol/ui_ext.pyx:68`, `edb/server/protocol/ui_ext.pyx:76`, `edb/server/protocol/ui_ext.pyx:85` |

## Open Questions

- Q1: Should extension endpoint versioning be formalized with explicit deprecation windows?

## Change Log

- 2026-04-02: Initial draft.
- 2026-04-02: Added sqlite-ts playground and query step tracing behavior notes.
