# Schema & migration CLI (`gel`)

A Drizzle/Prisma-style workflow for keeping the SQLite database in sync with your
`.esdl`/`.gel` schema files, plus typed-client codegen from `.edgeql` queries.

Run via the npm script (`npm run gel -- <command>`) or directly
(`npx tsx bin/gel.ts <command>`).

## Layout (conventions, all overridable with flags)

```
dbschema/                 # --schema (default: dbschema)
  main.esdl               # one or many .esdl/.gel files (Drizzle-style split)
  models/*.esdl           # nested dirs are scanned too
  migrations/             # --migrations (default: <schema>/migrations)
    0001_init.sql         # generated DDL (human-readable)
    meta/_journal.json    # ordered migration index (id + checksum)
    meta/0001.snapshot.esdl
queries/                  # --queries (default: queries)
  getUser.edgeql
local.db                  # --db (default: $SQLITE_FILE or local.db)
```

All schema files are concatenated (sorted by path) into one SDL source before
diffing — the file split is purely an authoring convenience.

## Commands

| Command | What it does | Analogue |
| --- | --- | --- |
| `gel push` | Diff schema files against the live DB and apply directly. No files. | `drizzle-kit push` / `prisma db push` |
| `gel status` | Print pending schema changes; exit code 1 if any (CI-friendly). | `drizzle-kit check` |
| `gel generate [name]` | Write a migration file for the current delta (name positional or `--name`). No DB writes. | `drizzle-kit generate` / `prisma migrate dev --create-only` |
| `gel migrate` | Apply pending migration files to the DB (idempotent, tracked). | `drizzle-kit migrate` / `prisma migrate deploy` |
| `gel codegen` | Generate typed TS functions from `.edgeql` files. | `@edgedb/generate` / Prisma Client |

Pick **one** of the two schema-sync styles per database:

- **Prototyping:** `gel push` (stateless — reads the schema recorded in the DB).
- **Versioned:** `gel generate` to author committed migrations, `gel migrate`
  to apply them. Applied migrations are recorded in `__gel_migration_history`
  and verified by checksum, so re-running `migrate` only applies new ones.

Both refresh the persisted schema snapshot (`gel_instdata` + `gel_*` tables +
`schema__*` introspection) after touching the physical schema, so the query
engine always sees the current schema.

## Typed query client

```
gel codegen --schema dbschema --queries queries --out queries/queries.gen.ts
```

Each `.edgeql` file becomes an exported function with a typed params object and
result type, inferred by compiling the query against the schema:

```ts
export type GetUserParams = { id: string };
export type GetUserResult = { name: string; age?: number } | null;
export function getUser(client: QueryRunner, params: GetUserParams): GetUserResult { ... }
```

Pass any object with a `.query(edgeql, args)` method (the sqlite-ts `Client`).

### Running the generated client on Cloudflare

`createClient()` is better-sqlite3-only (a real file). For D1/DO — which aren't
files — use the bundle-safe executor wrappers; the generated functions accept
them unchanged (they're `Promise`-shaped already):

```ts
// Durable Object (synchronous SQL storage): full engine, reads + writes.
import { connectDO } from "sqlite-ts/client/do";
const client = connectDO(ctx.storage.sql);
await createPerson(client, { name: "Ada" });   // a generated mutation works on DO
const people = await allPeople(client);

// D1 (async binding): READ-ONLY today (writes need the async write path).
import { connectD1 } from "sqlite-ts/client/d1";
const client = await connectD1(env.DB);
const people = await allPeople(client);
```

```ts
// Browser / WASM (sql.js): synchronous, so full engine — reads + writes.
import initSqlJs from "sql.js";
import { createSqlJsAdapter, connectWasm } from "sqlite-ts/client/wasm";
import { push } from "sqlite-ts/migrate/migrator"; // provisioning (dev) only

const SQL = await initSqlJs({ locateFile: (f) => `/sql-wasm.wasm` });
const db = new SQL.Database(savedBytes /* from IndexedDB */ ?? undefined);
if (!savedBytes) push(createSqlJsAdapter(db), SDL); // or load a DB exported elsewhere
const client = connectWasm(db);
await createPerson(client, { name: "Ada" });        // writes work in the browser
const people = await allPeople(client);
localStorage.setItem("db", /* persist */ db.export());
```

Import from `client/d1` / `client/do` / `client/wasm` directly (not
`client/index`, which pulls the native driver). All wrappers apply the same row
codec as `Client`, so the generated result types are accurate on every backend.
Provision the schema first (`gel migrate`/`push` against a local file, then ship
the SQLite to D1; run migrations against DO storage; or `push` in-browser /
load an exported DB for WASM).

### Backend support matrix

| Backend | Storage | Reads | Writes | Custom `_gel_*` fns |
| --- | --- | --- | --- | --- |
| better-sqlite3 (`Client`) | sync, native | ✓ | ✓ | ✓ (full fidelity) |
| Durable Object (`connectDO`) | sync | ✓ | ✓ | native-lowered subset |
| Browser / WASM (`connectWasm`) | sync (sql.js) | ✓ | ✓ | native-lowered subset |
| Cloudflare D1 (`connectD1`) | async | ✓ | ✗ (read-only) | native-lowered subset |

D1 writes are deferred — see `docs/adr/0060`. The native-lowered subset (math,
datetime, bitwise, stddev, floored `//`/`%`) covers ~94% of the conformance
suite; `_gel_*`-only features (regex, ranges, some casts) need the better-sqlite3
backend until those impls are lifted into a bundle-safe module.

## Known limitations

The schema diff currently covers: object types, single/multi properties, links
(inline + link tables), link properties, `exclusive` (UNIQUE) constraints,
triggers, and **single-property type/required changes** (applied as a
data-preserving shadow-column conversion: add new-typed column → `CAST` existing
values → drop old → rename). It does **not** yet diff:

- access policies, general constraints, non-unique indexes, computed
  properties/links — changes to these are **not detected** by `push`/`generate`;
- structural property changes (single ↔ multi, property ↔ link) still drop and
  re-add the storage (the data in that member is not carried over);
- migrations are applied **synchronously** (better-sqlite3). For Cloudflare D1,
  provision off-band (`gel migrate` against a local file, then ship the SQL).
  `createClient()` is better-sqlite3-only; D1/DO use the async adapters
  (`createD1Adapter` / `createDOSqlSyncAdapter`) directly.

Codegen result typing degrades to `unknown` (with a warning) for polymorphic
unions — add `__typename__` to the query to discriminate — and for shapes the
inferencer leaves with unknown cardinality.
