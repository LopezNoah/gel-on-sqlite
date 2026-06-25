// Cloudflare D1 query executor — lets the generated typed query client run
// against a D1 binding (which is not a better-sqlite3 file, so `createClient`
// can't drive it).
//
// READ-ONLY: D1 is an async binding and writes need the interleaved Tier-2 write
// path, so mutations throw AsyncUnsupportedError. Provision the schema + data
// off-band (`gel migrate` against a local file, then ship the SQLite to D1); the
// schema is read from the database's gel_instdata snapshot.
//
// Bundle-safe for workerd (no better-sqlite3 in the import closure). Import from
// "client/d1.js" directly, NOT from "client/index.js" (which pulls the native
// driver via the file-backed Client).

import { type AsyncQueryContext, executeSelectAsync } from "../runtime/async_query.js";
import { loadSchemaAsync } from "../runtime/async_schema.js";
import { createD1Adapter, type D1DatabaseLike } from "../runtime/d1_adapter.js";
import {
  buildExecutor,
  decodeRows,
  resolveExecutorOptions,
  type ExecutorOptions,
  type QueryExecutor,
} from "./executor.js";

export type { D1DatabaseLike };

/**
 * Connect a typed-query executor to a Cloudflare D1 database (read-only).
 * Pass the returned executor straight to a `gel codegen` function.
 */
export const connectD1 = async (
  d1: D1DatabaseLike,
  options: ExecutorOptions = {},
): Promise<QueryExecutor> => {
  const opts = resolveExecutorOptions(options);
  const adapter = createD1Adapter(d1);
  const schema = await loadSchemaAsync(adapter);
  return buildExecutor(async (query, args) => {
    const { rows } = await executeSelectAsync(adapter, schema, query, {
      params: args as AsyncQueryContext["params"],
    });
    return decodeRows(schema, query, rows, opts);
  });
};
