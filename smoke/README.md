# D1 / Durable Objects worker (Tier 1)

Runs the async read path against a Cloudflare backend. `worker.ts` is a
deployable example over **D1**; the same adapters also work against **Durable
Objects** SQL storage.

## What's verified

- D1 executes the engine's emitted SQL **and** the persisted `gel_*` schema DDL
  identically to better-sqlite3.
- `loadSchemaAsync` reconstructs the schema from the `gel_instdata` blob through
  the async adapter.
- `executeSelectAsync` / `executeManyAsync` return rows matching the sync engine.

## Tests

- `tests/d1_adapter.test.ts` — fast unit tests (param normalization, error
  mapping, batch, the Durable Objects adapter), always run.
- `tests/d1_integration.test.ts` — **real local D1** via the `wrangler` CLI;
  auto-skips when `wrangler` isn't installed. Provisions local D1 from the
  engine's materialized schema+data and diffs every query against the sync
  engine.

## Worker

`worker.ts` packages the path as a Worker using `createD1Adapter(env.DB)`:

```bash
# 1. provision local D1 from a dump (see d1_integration.test.ts: dumpSqlite)
wrangler d1 execute smoke --local --file seed.sql
# 2. serve (runs `node build-worker.mjs` first, per wrangler.toml [build])
wrangler dev
# 3. query
curl 'http://localhost:8799/?q=select default::Person { name, age } order by .name;'
```

### Durable Objects: the FULL sync engine (incl. writes)

DO SQL storage is **synchronous**, so a DO can run the complete engine
(`executeQuery` — SELECT, GROUP, interpreter fallback, **and** INSERT/UPDATE/
DELETE) with no async path at all. This works because `engine.ts` is now
bundle-safe (the native driver was split into `database.ts`; `materializeSchema`
lives in `schema_materialize.ts`). See `do_worker.ts`:

```ts
import { createDOSqlSyncAdapter } from "../src/runtime/do_adapter.js";
import { executeQuery } from "../src/runtime/engine.js";
import { deserializeSchemaFromInstdata } from "../src/schema/gel_persistence.js";

export class GelDurableObject {
  constructor(private ctx: DurableObjectState) {}
  async fetch(req: Request) {
    const db = createDOSqlSyncAdapter(this.ctx.storage.sql) as unknown as SQLiteDatabase;
    const schema = deserializeSchemaFromInstdata(db)!;
    const q = new URL(req.url).searchParams.get("q")!;
    const result = executeQuery(db, schema, q); // reads AND writes
    return Response.json(result.rows ?? { changes: result.changes });
  }
}
```

(D1, being async, stays read-only Tier-1 via `createDOSqlAdapter`/
`executeSelectAsync` — see above. DO can't host custom `_gel_*` functions
either, so those queries are still unsupported on both.)

## Bundling

`build-worker.mjs` (esbuild) bundles `worker.ts` → `dist/worker.js`: a `.js`→`.ts`
resolve plugin handles the codebase's NodeNext specifiers, and a tiny `process`
shim neutralizes dev-only `process.env.DBG_*` reads. Result is self-contained
(~173 KB gzip) and needs **no `nodejs_compat` flag** — verified by
`wrangler deploy --dry-run` and a live `wrangler dev` run.

## Notes / known limits

- **Tier-1 scope**: reads that lower to a single SQL statement. Mutations, the
  interpreter-fallback (multi-query) path, access-policy reads, scripts, and
  `FOR` return a clean `AsyncUnsupportedError`. Those need the Tier-2 interleaved
  core.
- DO SQL is synchronous, so a DO could in principle run the *full* sync engine
  (writes included) — pending a bundle-safe `engine.ts`. A larger follow-up.
- `dist/`, `seed.sqlite`, `seed.sql`, and `.wrangler/` are git-ignored.
