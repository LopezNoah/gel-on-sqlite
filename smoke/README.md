# D1 smoke test (Tier 1)

Validates the async read path against a **real** local Cloudflare D1 (miniflare,
driven by the `wrangler` CLI — no network or login required).

## What it proves

- D1 executes the engine's emitted SQL **and** the persisted `gel_*` schema DDL
  identically to better-sqlite3.
- `loadSchemaAsync` reconstructs the schema by reading the `gel_instdata` blob
  through the async adapter.
- `executeSelectAsync` returns rows matching the synchronous engine.

## Run

```bash
node_modules/.bin/tsx smoke/d1_smoke.ts
```

This: materializes a tiny schema + data with the engine into `seed.sqlite`,
dumps it to `seed.sql`, loads it into local D1 (`wrangler d1 execute smoke
--local --file seed.sql`), then runs `loadSchemaAsync` + `executeSelectAsync`
against local D1 (via a CLI-backed adapter) and diffs every query against the
sync engine. Exit code is non-zero on any divergence.

## Worker (`worker.ts`)

The same path, packaged as a Worker using `createD1Adapter(env.DB)`:

```bash
# 1. provision local D1 (see d1_smoke.ts for building seed.sql)
wrangler d1 execute smoke --local --file seed.sql
# 2. serve
wrangler dev
# 3. query
curl 'http://localhost:8787/?q=select default::Person { name, age } order by .name;'
```

## Notes / known limits

- **`nodejs_compat` is required** — the compiler's cache key uses `node:crypto`.
  (A later pass can swap it for Web Crypto to drop the flag.)
- **Bundling for `wrangler dev`/`deploy`**: the source uses `.js` import
  specifiers that resolve to `.ts` files. `wrangler dev` against `worker.ts`
  works with wrangler's esbuild; for `deploy`, build the project to `dist/`
  first and point `main` there if esbuild can't resolve the extensions.
- **Tier-1 scope**: reads that lower to a single SQL statement. Mutations, the
  interpreter-fallback (multi-query) path, access-policy reads, scripts, and
  `FOR` return 400 (`AsyncUnsupportedError`). Those need the Tier-2 interleaved
  core.
- `seed.sqlite`, `seed.sql`, and `.wrangler/` are git-ignored.
