// Cloudflare D1 query executor — lets the generated typed query client run
// against a D1 binding (which is not a better-sqlite3 file, so `createClient`
// can't drive it).
//
// READS + WRITES: D1 is async, so the engine's write executor runs via the
// decolored DB-effect (see runtime/async_write.ts). Supported: SELECT, DELETE,
// scalar UPDATE, and scalar INSERT. Still rejected with AsyncUnsupportedError:
// access-policy-bearing types, link / multi-property assignments, UNLESS
// CONFLICT, sequence- or query-defaulted inserts, and nested inserts (these run
// db-direct in the sync engine and aren't decolored). Provision the schema
// off-band (`gel migrate` against a local file, then ship the SQLite to D1); the
// schema is read from the gel_instdata snapshot.
//
// Bundle-safe for workerd (no better-sqlite3 in the import closure). Import from
// "client/d1.js" directly, NOT from "client/index.js" (which pulls the native
// driver via the file-backed Client).

import { parseEdgeQL } from "../edgeql/parser.js";
import { type AsyncQueryContext, executeSelectAsync } from "../runtime/async_query.js";
import { executeDeleteAsync, executeInsertAsync, executeUpdateAsync } from "../runtime/async_write.js";
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
 * Connect a typed-query executor to a Cloudflare D1 database (reads + deletes).
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
    const ctx: AsyncQueryContext = { params: args as AsyncQueryContext["params"] };
    const kind = parseEdgeQL(query).kind;
    const rows =
      kind === "delete"
        ? (await executeDeleteAsync(adapter, schema, query, ctx)).rows
        : kind === "update"
          ? (await executeUpdateAsync(adapter, schema, query, ctx)).rows
          : kind === "insert"
            ? (await executeInsertAsync(adapter, schema, query, ctx)).rows
            : (await executeSelectAsync(adapter, schema, query, ctx)).rows;
    return decodeRows(schema, query, rows, opts);
  });
};
