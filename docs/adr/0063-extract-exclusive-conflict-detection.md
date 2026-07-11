# 0063 — Extract exclusive-conflict detection (emitter-style)

## Status
Accepted and IMPLEMENTED. Behaviour-neutral (verified by failing-name diff
against pristine HEAD on `edgeql_insert` + `edgeql_update`). Continues the carve
of the write executor begun in ADRs 0037 / 0039 / 0046.

## Context

`runWriteWithAccessPolicies` (`engine.ts`, ~580 lines) was declared "irreducible
mutation mechanics" once access-policy, default-resolution, and the INSERT row
emitter were carved out. But the `UNLESS CONFLICT` machinery — ~270 lines across
six functions — remained dissolved into the executor and was reachable *only* by
performing a full INSERT against a real DB:

- `exclusiveChecksFor` — enumerate the exclusive constraints reachable from a
  type (field-level, multi, type-level tuple, inherited, `except`, the id PK);
- `findExclusiveConflictId` — probe the DB for a clashing row;
- `conflictIsAgainstSameStatementRow` — the same-statement-clash guard;
- `parseExclusivityViolation` — recover the violated property from a SQLite
  UNIQUE error;
- `insertValueIsVolatile` — the volatile-conflict-target guard;
- plus the shared helpers `typeAncestorsOf` / `constraintIsExclusiveLike` /
  `tablesSharingFieldConstraint` / `exceptColumnFrom`.

It is a deep module: a small interface over a lot of constraint-kind behaviour,
with no cycle back to the engine. The deletion test passes — `exclusiveChecksFor`
alone has three callers (the write executor, the WITH-DML-chain exclusivity
snapshot, and the same-statement guard), so the rule genuinely concentrates
complexity rather than moving a closure.

## Decision

Lift the cluster into **`src/runtime/conflict_detection.ts`**, shaped
**emitter-style** ("plan + run", the interface chosen with the user):

- `exclusiveChecksFor(schema, type, targetFields?)` — pure given the schema.
- `planExclusiveConflictProbe(check, values)` — the **pure emitter**: decides
  what to probe, or `null` when a covered value is absent (an empty set cannot
  clash). This is the new test surface.
- `runExclusiveConflictProbe(db, plan)` — the thin DB step: it adaptively reads
  `PRAGMA table_info` to gate on which tables/columns exist, then runs the probe.
  Byte-for-byte the old `findExclusiveConflictId`.
- `parseExclusivityViolation`, `conflictIsAgainstSameStatementRow` (its arg
  narrowed from `SecurityContext` to `statementInsertedIds: Set<string>`),
  `insertValueIsVolatile`.

The write executor's one probe site becomes
`const plan = planExclusiveConflictProbe(...); const found = plan ? runExclusiveConflictProbe(db, plan) : undefined;`.

**Why plan + run, not a pure SQL emitter** (the alternative considered): the
probe is not a fixed SQL string — it reads `PRAGMA table_info` at run time to
skip tables/columns that don't exist in the physical layout. So the pure half is
the *plan* (which tables/columns/values, the casefold flag, the multi-set
items), and the DB-coupled half is the introspection-gated execution. The plan
is the part every constraint kind crosses, and it tests without a DB.

**Ownership.** The module owns the exclusivity primitives. `engine.ts`'s
WITH-DML-chain exclusivity snapshot also uses `exclusiveChecksFor` /
`typeAncestorsOf` / `constraintIsExclusiveLike`, so those are exported and engine
imports them back — one-directional (this module imports nothing from engine), no
cycle. (The agent review's "only imports quoteIdent + schema types" undersold
this: the helpers are shared with the snapshot machinery, so the right move is
single-ownership-with-import-back, not duplication.)

## Test surface

`tests/conflict_detection.test.ts` (13 tests) exercises, with **no INSERT and no
DB**: `exclusiveChecksFor` over a schema (field / multi / type-level / inherited
/ id PK / ON-target restriction), `planExclusiveConflictProbe` (single, multi,
null-guards, casefold, scalar→1-item), `parseExclusivityViolation` (shared /
direct / `_id`-strip / non-UNIQUE), and `insertValueIsVolatile`.

## Consequences

- The write executor shrinks; conflict logic gets a name and an interface.
- The async write path (ADR 0060) can now reuse the pure `exclusiveChecksFor` /
  `planExclusiveConflictProbe`; only `runExclusiveConflictProbe` (sync DB probe)
  needs the generator-decolor treatment to go async.
- **Known imprecision, deferred:** `planExclusiveConflictProbe`'s `values` param
  is typed `Record<string, ScalarValue | undefined>`, but a multi-property's
  value is the multi-SET array, which the executor supplies through that slot via
  an `as unknown as ScalarValue` cast (pre-existing). Widening the type to
  `ScalarValue | ScalarValue[] | undefined` (removing the cast) is a follow-up.
- Behaviour-neutral: `edgeql_insert` (39 pre-existing failures, names unchanged)
  and `edgeql_update` failing-name sets are byte-identical to pristine HEAD;
  `tsc --noEmit` is clean; the 13 new unit tests pass.
