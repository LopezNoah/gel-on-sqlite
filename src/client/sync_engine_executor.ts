// Build a QueryExecutor over a SYNCHRONOUS RuntimeDatabaseAdapter by running the
// full engine (reads AND writes). Shared by the backends whose storage is
// synchronous — Durable Objects (`createDOSqlSyncAdapter`) and the browser/WASM
// client (`createSqlJsAdapter`) — so a mutation sent through `query()` actually
// executes. (D1 is async and read-only; it does NOT use this path.)
//
// Bundle-safe for workerd/browser: engine.ts is native-free and the codec is
// pure. Importing this pulls the full engine, so the lean async D1 client
// (client/d1.ts) deliberately does not.

import type { RuntimeDatabaseAdapter } from "../runtime/adapter.js";
import { executeQuery, type QueryVariables } from "../runtime/engine.js";
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

type EngineDb = Parameters<typeof executeQuery>[0];
type PersistenceDb = Parameters<typeof deserializeSchemaFromInstdata>[0];

export const connectSyncEngine = (
  adapter: RuntimeDatabaseAdapter,
  options: ExecutorOptions = {},
): QueryExecutor => {
  const opts = resolveExecutorOptions(options);
  const persistenceDb = adapter as unknown as PersistenceDb;
  const schema =
    deserializeSchemaFromInstdata(persistenceDb) ?? deserializeSchemaFromGelTables(persistenceDb);
  if (!schema) {
    throw new Error("database has no serialized sqlite-ts schema; provision it (run migrations) first");
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
