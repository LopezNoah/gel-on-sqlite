# SPEC-041: Compiler Interface and Caching

Status: Implemented
Owners: Server Compiler Team
Last Updated: 2026-04-02

## Purpose

Specify contract between server runtime and compiler services, including cache behavior.

## Scope

- Compiler request/response interfaces.
- Caching expectations for compiled artifacts.

## Non-Goals

- Cache backend implementation tuning.
- Cross-version cache migration policy.

## Requirements

- R1: Compiler interface must define stable input and output payload semantics.
- R2: Cache keys must include all semantic compilation inputs required for correctness.
- R3: Cache misses and invalidations must degrade safely and observably.

## Behavior and Flows

- Runtime parses EdgeQL into AST.
- Compiler service receives `{schema, statement, overlays}` compile context and performs deterministic cache-key derivation.
- Cache lookup occurs before semantic compile/SQL lower; on hit, cached IR+SQL is returned.
- On miss, compiler service runs semantic compile + SQL lower, then stores artifact under cache key.
- Compiler metadata (`status`, `key`, `stats`) is attached to query traces and HTTP `includeSteps` responses for observability.

## Traceability

- sqlite-ts code:
  - `sqlite-ts/src/compiler/service.ts`
  - `sqlite-ts/src/runtime/engine.ts`
  - `sqlite-ts/src/http/server.ts`
- sqlite-ts tests:
  - `sqlite-ts/tests/engine.test.ts`
  - `sqlite-ts/tests/http.test.ts`

## sqlite-ts Notes

- Cache keys include schema fingerprint, normalized AST payload, and overlay context to preserve semantic correctness for query-unit scoped compilation.
- Cache misses are safe by design (recompile path), and cache status is observable through trace payloads.
- Cache backend is in-memory map for now; external/shared cache remains future work.

## Open Questions

- Q1: Should sqlite-ts persist cache counters and key metadata to a metrics sink when running as a long-lived server process?

## Change Log

- 2026-04-02: Initial draft.
- 2026-04-02: Implemented compiler service contract, deterministic cache keys, and trace-visible cache metadata.
