// Browser / WASM query executor — runs Gel-on-SQLite against sql.js.
//
// sql.js is synchronous, so this drives the FULL engine (reads + writes), just
// like Durable Objects. Pass the returned executor straight to a `gel codegen`
// function; mutations sent through it execute.
//
// Provisioning (creating the schema + data) happens with the normal migrator —
// `push`/`migrate` work over any adapter, including this one:
//
//   import initSqlJs from "sql.js";
//   import { createSqlJsAdapter, connectWasm } from "sqlite-ts/client/wasm";
//   import { push } from "sqlite-ts/migrate/migrator";   // dev/provisioning only
//
//   const SQL = await initSqlJs({ locateFile: (f) => `/sql-wasm.wasm` });
//   const db = new SQL.Database(savedBytes /* or empty */);
//   push(createSqlJsAdapter(db), SDL);        // or load a DB exported elsewhere
//   const client = connectWasm(db);
//   const people = await allPeople(client);
//   await createPerson(client, { name: "Ada" });
//   const bytes = db.export();                // persist to IndexedDB/OPFS/file
//
// Bundle-safe for the browser (no better-sqlite3 in the import closure). Import
// from "client/wasm.js" directly, NOT "client/index.js".

import { createSqlJsAdapter, type SqlJsDatabaseLike } from "../runtime/wasm_adapter.js";
import { connectSyncEngine } from "./sync_engine_executor.js";
import type { ExecutorOptions, QueryExecutor } from "./executor.js";

export { createSqlJsAdapter };
export type { SqlJsDatabaseLike };

/**
 * Connect a typed-query executor to a sql.js database (reads + writes). The
 * database must already carry a serialized sqlite-ts schema (provision it with
 * `push`/`migrate`, or load a DB exported from another backend).
 */
export const connectWasm = (db: SqlJsDatabaseLike, options: ExecutorOptions = {}): QueryExecutor =>
  connectSyncEngine(createSqlJsAdapter(db), options);
