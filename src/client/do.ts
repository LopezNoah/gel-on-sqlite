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

import { createDOSqlSyncAdapter, type SqlStorageLike } from "../runtime/do_adapter.js";
import { connectSyncEngine } from "./sync_engine_executor.js";
import type { ExecutorOptions, QueryExecutor } from "./executor.js";

export type { SqlStorageLike };

/**
 * Connect a typed-query executor to Durable Object SQL storage (reads + writes).
 * Pass the returned executor straight to a `gel codegen` function.
 */
export const connectDO = (sql: SqlStorageLike, options: ExecutorOptions = {}): QueryExecutor =>
  connectSyncEngine(createDOSqlSyncAdapter(sql), options);
