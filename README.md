# sqlite-ts — an EdgeQL query engine on SQLite

A from-scratch TypeScript reimplementation of Gel/EdgeDB's EdgeQL query engine, targeting
**SQLite** instead of Postgres. Because SQLite is embedded, there's no client/server split — the
full **parse → compile → SQL → execute** path runs in one process. You hand it EdgeQL text; it
hands you back rows.

## Understanding the codebase

Start here, in order:

- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — how a query flows through the code, end to
  end, with the real entry-point functions and a "trace a query yourself" guide. **Read this first.**
- **[`CONTEXT.md`](CONTEXT.md)** — the glossary: precise definitions of the project's vocabulary
  (Live IR, scope tree, polymorphic source, …).
- **[`docs/adr/`](docs/adr/)** — decision records explaining *why* modules are shaped the way they
  are (numbered in the order decisions were made).

The pipeline in one picture:

```
EdgeQL text → tokenize → parse → AST → compile to Live IR → lower to SQL → execute → rows
              tokenizer   parser        ast_to_ir            gel_ir_compiler  engine
```

The two functions to know: **`CompilerService.compile`** (`src/compiler/service.ts`) wraps
compilation; **`executeQuery`** (`src/runtime/engine.ts`) drives the whole thing.

## Quick start

```bash
npm install
npm test            # run the vitest suite
npm run dev         # start the HTTP server + playground on http://localhost:4000
npm run build       # type-check / compile with tsc
```

## Inspect what a query compiles to

`bin/inspect.ts` dumps any stage of the pipeline for a query — your definitive
"what does this do?" tool, no AI required:

```bash
npx tsx bin/inspect.ts ast   "SELECT Issue { name }" --schema issues   # parsed AST
npx tsx bin/inspect.ts raw   "SELECT Issue { name }" --schema issues   # full Live IR
npx tsx bin/inspect.ts ir    "SELECT Issue { name }" --schema issues   # IR node-kind skeleton
npx tsx bin/inspect.ts sql   "SELECT Issue { name }" --schema issues   # emitted SQLite SQL
npx tsx bin/inspect.ts facts "SELECT Issue { name }" --schema issues   # strategy, param/CTE counts
```

`--schema NAME` loads `tests/schemas/NAME.esdl` (e.g. `issues`, `cards`, `advtypes`).

## Schema & migration CLI

`bin/gel.ts` (also `npm run gel -- <command>`) is a Drizzle/Prisma-style CLI over `.esdl`/`.gel`
schema files:

```
gel push        Diff schema files against the DB and apply directly (no migration files)
gel status      Show pending schema changes; exits 1 if any
gel generate    Write a migration file for the current schema delta
gel migrate     Apply pending migration files to the DB
gel codegen     Generate typed TS query functions from .edgeql files

Options:
  --schema <dir>      schema directory      (default: dbschema)
  --db <file>         sqlite database file  (default: $SQLITE_FILE or local.db)
  --migrations <dir>  migrations directory  (default: <schema>/migrations)
  --queries <dir>     .edgeql directory     (codegen; default: queries)
  --out <file>        codegen output        (codegen; default: <queries>/queries.ts)
```

## Component map

| Stage / concern | Code |
|---|---|
| Tokenizer + recursive-descent parser | `src/edgeql/tokenizer.ts`, `src/edgeql/parser.ts`, `src/edgeql/ast.ts` |
| AST → Live IR (+ inference, scope tree) | `src/compiler/ast_to_ir.ts`, `src/compiler/inference.ts`, `src/ir/gel_ir.ts` |
| Compile facade (cache + DML lowering) | `src/compiler/service.ts`, `src/compiler/dml_lowering.ts` |
| Live IR → SQLite SQL | `src/sql/gel_ir_compiler.ts` (+ helpers in `src/sql/`) |
| Execution routing | `src/compiler/execution_strategy.ts` |
| Runtime engine + TS interpreter | `src/runtime/engine.ts`, `src/runtime/evaluator.ts` |
| Backends (SQLite / D1 / Durable Objects / WASM) | `src/runtime/database.ts`, `d1_adapter.ts`, `do_adapter.ts`, `wasm_adapter.ts` |
| Immutable schema model | `src/schema/schema.ts` |
| SDL parsing (separate front end) | `src/schema/sdl_adapter.ts`, `src/schema/schema_tokenizer.ts`, `src/schema/load.ts` |
| Migrations (plan + render SQL) | `src/schema/migrations.ts` |
| Schema persistence / introspection | `src/schema/gel_persistence.ts`, `src/schema/schema_introspection.ts` |
| Standard library | `src/stdlib/registry.ts` |
| Public client API | `src/client/index.ts` |
| Code generation (typed client + DDL) | `src/codegen/` |
| HTTP server + playground | `src/http/server.ts` |
| Compile-inspection seam (used by tests + `bin/inspect.ts`) | `src/compiler/inspect.ts` |

## Declarative schema example

```ts
import { GEL_REFERENCE_SCHEMA } from "./src/schema/gel_schema.js";
import { renderSchemaSQL } from "./src/schema/migrations.js";

// GEL_REFERENCE_SCHEMA is a DeclarativeSchema, so use migrations.ts's renderSchemaSQL.
// (codegen/sql.ts also exports a renderSchemaSQL — that one takes a SchemaSnapshot.)
const ddl = renderSchemaSQL(GEL_REFERENCE_SCHEMA);
console.log(ddl);
```

## HTTP server

`npm run dev` starts `src/http/server.ts` on `http://localhost:4000`. API endpoints:

- `POST /query` — run a query
- `GET /schema` — runtime types (fields + links)
- `GET /schema/source` — current declarative schema source
- `POST /schema/plan` — dry-run migration planning + generated SQL preview
- `POST /schema/apply` — apply declarative schema source; returns updated types + migration plan
- `GET /health` — health check

`GET /` serves the browser playground (editable queries, AST/IR/SQL/result inspection) **only
when the UI has been built** into `dist` — otherwise it returns a minimal fallback. The richer
schema explorer and its routes (e.g. `/types`) are client-side routes of the separate Astro UI
(see "Frontend" below).

Example query body:

```json
{ "query": "insert default::User { name := 'Noah', email := 'noah@example.com' };", "includeSteps": true }
```

Note: object `id` values are generated by SQLite/runtime and cannot be set in `insert`/`update`
(unless `CONFIGURE SESSION SET allow_user_specified_id := true`).

## Converting Python query tests

```bash
npm run test:convert-py -- ../tests/test_edgeql_for.py
```

Writes `tests/<python_file_without_test_>.test.ts`. Unsupported constructs become skipped tests
with an `[unconverted: ...]` suffix; `--strict` fails on the first unsupported construct.

## Frontend (playground UI)

The richer Astro UI is a **separate package** at `../gel-ui-main` (not in this directory). The
`ui:*` and `dev:all` npm scripts expect it linked at `./ui`; the built-in playground served at
`GET /` by `npm run dev` works without it.
</content>
