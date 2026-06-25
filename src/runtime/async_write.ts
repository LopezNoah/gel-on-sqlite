// Tier-2 async WRITE path — runs the decolored write core on an async backend
// (Cloudflare D1) via the async DB-effect driver. The SAME generator
// (deleteWriteEffect) the synchronous engine runs, driven with awaits here.
//
// DELETE is the first decolored op. Guards mirror the async read path: reject
// anything the effect can't faithfully run async — non-delete kinds, and
// access-policy-bearing targets (policy enforcement recursively runs the query
// engine, which isn't decolored). D1 has no interactive transactions, so a
// plain delete is atomic (one statement) while an on-target-delete cascade runs
// sequentially (non-atomic) — see docs/adr/0060.

import { getCompilerService } from "../compiler/service.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import type { AsyncRuntimeDatabaseAdapter } from "./adapter.js";
import { AsyncUnsupportedError, type AsyncQueryContext } from "./async_query.js";
import { asyncDbExec, runDbEffectAsync } from "./db_effect.js";
import { deleteWriteEffect, typeDefForTable } from "./engine.js";

export interface AsyncWriteResult {
  kind: "delete";
  rows: Record<string, unknown>[];
}

export const executeDeleteAsync = async (
  db: AsyncRuntimeDatabaseAdapter,
  schema: SchemaSnapshot,
  query: string,
  context: AsyncQueryContext = {},
): Promise<AsyncWriteResult> => {
  const ast = parseEdgeQL(query);
  if (ast.kind !== "delete") {
    throw new AsyncUnsupportedError(`executeDeleteAsync supports delete; got '${ast.kind}'`);
  }

  const compiled = getCompilerService().compile(schema, ast, {
    globals: context.globals,
    params: context.params,
    target: db.target,
  });
  const ir = compiled.ir;
  if (!ir || ir.kind !== "delete") {
    throw new AsyncUnsupportedError("async write path: statement did not compile to a delete");
  }

  const subjectType = typeDefForTable(schema, ir.table);
  if (!subjectType) {
    throw new AsyncUnsupportedError(`async write path: unknown delete target '${ir.table}'`);
  }
  if ((subjectType.accessPolicies?.length ?? 0) > 0) {
    throw new AsyncUnsupportedError(
      `access policies on '${ir.table}' are not yet enforced on the async write path`,
    );
  }

  const result = await runDbEffectAsync(
    // Policies are guarded out above, so the enforce callback is a no-op.
    deleteWriteEffect(schema, ir, compiled.sql, subjectType, ast.pos, () => {}),
    asyncDbExec(db),
  );
  return { kind: "delete", rows: result.rows ?? [] };
};
