// Durable Object SQL-storage query executor — lets the generated typed query
// client run against `ctx.storage.sql`.
//
// DO storage is SYNCHRONOUS, so the full sync engine runs — SELECT, GROUP, the
// interpreter fallback, AND writes (INSERT/UPDATE/DELETE). The async Executor
// surface wraps those sync calls (a mutation sent through `query()` executes and
// returns its rows). The schema is read from the DO database's persisted
// snapshot.
//
// Bundle-safe for workerd (engine.ts is native-free). Import from "client/do.js"
// directly, NOT from "client/index.js".

import { executeQuery, type QueryVariables } from "../runtime/engine.js";
import { createDOSqlSyncAdapter, type SqlStorageLike } from "../runtime/do_adapter.js";
import {
  deserializeSchemaFromGelTables,
  deserializeSchemaFromInstdata,
} from "../schema/gel_persistence.js";
import {
  buildExecutor,
  decodeRows,
  resolveExecutorOptions,
  type ExecutorOptions,
  type QueryExecutor,
} from "./executor.js";

export type { SqlStorageLike };

// `executeQuery`/`deserializeSchema*` type their db as `SQLiteDatabase`, but at
// runtime touch only `prepare()`/`target`, which the DO sync adapter provides.
// Cast through their own parameter types so no native database value-import is
// needed (keeps this module bundle-safe).
type EngineDb = Parameters<typeof executeQuery>[0];
type PersistenceDb = Parameters<typeof deserializeSchemaFromInstdata>[0];

/**
 * Connect a typed-query executor to Durable Object SQL storage (reads + writes).
 * Pass the returned executor straight to a `gel codegen` function.
 */
export const connectDO = (sql: SqlStorageLike, options: ExecutorOptions = {}): QueryExecutor => {
  const opts = resolveExecutorOptions(options);
  const adapter = createDOSqlSyncAdapter(sql);
  const persistenceDb = adapter as unknown as PersistenceDb;
  const schema =
    deserializeSchemaFromInstdata(persistenceDb) ?? deserializeSchemaFromGelTables(persistenceDb);
  if (!schema) {
    throw new Error(
      "Durable Object SQL storage has no serialized sqlite-ts schema; provision it (run migrations) first",
    );
  }
  return buildExecutor(async (query, args) => {
    const envelope = executeQuery(
      adapter as unknown as EngineDb,
      schema,
      query,
      undefined,
      args as QueryVariables,
    );
    return decodeRows(schema, query, envelope.rows ?? [], opts);
  });
};
