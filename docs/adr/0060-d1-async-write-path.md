# D1 async writes, and why the synchronous engine is the seam

## Status

Accepted (decision: defer). D1 stays **read-only**; Durable Objects, the
file-backed client, and the new browser/WASM client all do **reads + writes**.

## Context

The query engine is synchronous. `executeQuery` and, underneath it, the write
executor `runWriteWithAccessPolicies` (engine.ts, ~578 lines) call
`db.prepare(...).all()/.run()` directly and *interleave* those calls with
in-process computation. For a write the interleaving is intrinsic and
data-dependent — you cannot pre-fetch what the next read will be:

- `applyPendingInsertDefaults` runs `evalSelect` / `evalFunctionCall`, compiling
  and executing SELECTs in the middle of building the row;
- `nextSequenceValue(db, …)` reads and increments a sequence row per column;
- `resolveInsertTargets(db, …)` queries to resolve inline-link targets;
- `UNLESS CONFLICT` probes exclusive constraints;
- `onTargetDelete` scans inbound links and conditionally cascades;
- access policies re-query the just-written state, then a read-back `SELECT`
  produces the `RETURNING` shape.

Three execution environments, two storage shapes:

| Backend | Storage API | Can run the sync engine? |
| --- | --- | --- |
| better-sqlite3 (Node, file) | synchronous | yes — full reads + writes |
| Durable Object (`ctx.storage.sql`) | **synchronous** | yes — full reads + writes |
| Browser (sql.js / WASM) | **synchronous** | yes — full reads + writes |
| **Cloudflare D1** | **asynchronous** | **reads only** |

The read path already ships for D1 ("await at the edge", `executeSelectAsync`):
a lowered SELECT is compile → one SQL string → one awaited `.all()` → decode,
so only the single round-trip is async and the engine core stays uncolored.
Writes have no such single seam.

A D1 Worker also has **no synchronous SQLite** available — only the async
binding. Shipping an in-Worker WASM SQLite as a sync mirror would require
hydrating the working set, but the writes' reads are data-dependent, so "the
working set" is unbounded (whole tables). That path is rejected.

## Decision

Do **not** add a D1 async write path yet, and do **not** ship an unsound
shortcut to fake one. Specifically rejected:

- **Reusing `buildInsertRowSql` directly** — it consumes *already-resolved*
  column values; the resolution (defaults/sequences/link targets) is exactly the
  interleaved-read work, so this reimplements the hard part.
- **A "simple INSERT/UPDATE/DELETE" fast path** that runs the precompiled SQL and
  skips the interleaved checks — that silently drops defaults, sequences,
  exclusive/UNLESS-CONFLICT handling, on-target-delete, and access policies.
  Skipping a constraint is **data corruption**, not a feature gap.

D1 remains read-only. Writers use Durable Objects (synchronous, full engine) or
provision off-band (`gel migrate`/`push` against a file, ship the SQLite to D1).

## The only sound way forward: decolor the write core

To run the write executor on an async backend without divergence, the engine's
DB-access seam must become non-blocking *without forking the logic*. Two shapes:

1. **Generator decolor.** Rewrite `runWriteWithAccessPolicies` and its helpers as
   generators that `yield { sql, params, kind }` and resume via `.next(rows)`. A
   sync driver (Node/DO/WASM) runs them with zero overhead; an async driver
   (D1) awaits each yield. One code path, two drivers — no divergence. Cost:
   touching a large, hot, shared file and keeping the 3000+ synchronous
   conformance tests byte-identical.

2. **Effect.** Model DB access as an `Effect`; the synchronous runtime executes
   it inline, a D1 runtime executes it against the async binding. This also gets
   typed errors and transaction/savepoint scoping (which the DML path already
   needs), at the cost of adopting Effect across the runtime. Reasonable **if we
   move the broader codebase to Effect** — over-heavy for the DB seam alone.

Either is a dedicated effort, not a same-turn add. The generator decolor is the
lower-commitment option; Effect is the right call only as part of a wider move.
This ADR records the seam so whichever we pick starts from the same analysis.

## Consequences

- The generated typed query client is already `Promise`-shaped, so it runs
  unchanged on every backend; on D1 it is read-only until this is done.
- Until then, "D1 + writes" = provision elsewhere and ship the DB, or use
  Durable Objects. See `src/client/{d1,do,wasm}.ts` and `docs/migrations-cli.md`.
