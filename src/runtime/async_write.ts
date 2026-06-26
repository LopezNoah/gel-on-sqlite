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
import type { InsertStatement } from "../edgeql/ast.js";
import { deleteWriteEffect, insertScalarWriteEffect, typeDefForTable, updateWriteEffect } from "./engine.js";

export interface AsyncWriteResult {
  kind: "delete" | "update" | "insert";
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

const NOOP = (): void => {};

export const executeUpdateAsync = async (
  db: AsyncRuntimeDatabaseAdapter,
  schema: SchemaSnapshot,
  query: string,
  context: AsyncQueryContext = {},
): Promise<AsyncWriteResult> => {
  const ast = parseEdgeQL(query);
  if (ast.kind !== "update") {
    throw new AsyncUnsupportedError(`executeUpdateAsync supports update; got '${ast.kind}'`);
  }

  const compiled = getCompilerService().compile(schema, ast, {
    globals: context.globals,
    params: context.params,
    target: db.target,
  });
  const ir = compiled.ir;
  if (!ir || ir.kind !== "update") {
    throw new AsyncUnsupportedError("async write path: statement did not compile to an update");
  }

  const subjectType = typeDefForTable(schema, ir.table);
  if (!subjectType) {
    throw new AsyncUnsupportedError(`async write path: unknown update target '${ir.table}'`);
  }
  if ((subjectType.accessPolicies?.length ?? 0) > 0) {
    throw new AsyncUnsupportedError(
      `access policies on '${ir.table}' are not yet enforced on the async write path`,
    );
  }
  // Link assignments and multi-property assignments run db-direct (and links can
  // nest INSERTs, which aren't decolored yet) — reject them so the no-op
  // callbacks below stay correct. Scalar-only updates are fully supported.
  if ((ir.linkAssignments?.length ?? 0) > 0) {
    throw new AsyncUnsupportedError("link assignments in UPDATE are not yet supported on the async write path");
  }
  const assignsMultiProp = subjectType.fields.some(
    (f) => (f as { multi?: boolean }).multi && Object.prototype.hasOwnProperty.call(ir.values, f.name),
  );
  if (assignsMultiProp) {
    throw new AsyncUnsupportedError("multi-property assignments in UPDATE are not yet supported on the async write path");
  }

  await runDbEffectAsync(
    updateWriteEffect(schema, ir, compiled.sql, subjectType, ast.pos, true, NOOP, NOOP, NOOP),
    asyncDbExec(db),
  );
  // A bare UPDATE returns its match count, not rows (mirrors the sync engine,
  // whose Client surfaces `rows ?? []`). Use `select (update ...)` for rows.
  return { kind: "update", rows: [] };
};

export const executeInsertAsync = async (
  db: AsyncRuntimeDatabaseAdapter,
  schema: SchemaSnapshot,
  query: string,
  context: AsyncQueryContext = {},
): Promise<AsyncWriteResult> => {
  const ast = parseEdgeQL(query);
  if (ast.kind !== "insert") {
    throw new AsyncUnsupportedError(`executeInsertAsync supports insert; got '${ast.kind}'`);
  }
  const insertAst = ast as InsertStatement;

  const compiled = getCompilerService().compile(schema, ast, {
    globals: context.globals,
    params: context.params,
    target: db.target,
  });
  const ir = compiled.ir;
  if (!ir || ir.kind !== "insert") {
    throw new AsyncUnsupportedError("async write path: statement did not compile to an insert");
  }

  const subjectType = typeDefForTable(schema, ir.table);
  if (!subjectType) {
    throw new AsyncUnsupportedError(`async write path: unknown insert target '${ir.table}'`);
  }
  if ((subjectType.accessPolicies?.length ?? 0) > 0) {
    throw new AsyncUnsupportedError(`access policies on '${ir.table}' are not yet enforced on the async write path`);
  }
  if (insertAst.conflict) {
    throw new AsyncUnsupportedError("INSERT ... UNLESS CONFLICT is not yet supported on the async write path");
  }
  // Reject any link or multi-property assignment — those run db-direct in the
  // sync branch (links can nest INSERTs); the scalar effect handles neither.
  const assignedKeys = Object.keys(insertAst.values ?? {});
  if ((subjectType.links ?? []).some((link) => assignedKeys.includes(link.name))) {
    throw new AsyncUnsupportedError("link assignments in INSERT are not yet supported on the async write path");
  }
  if (subjectType.fields.some((f) => (f as { multi?: boolean }).multi && assignedKeys.includes(f.name))) {
    throw new AsyncUnsupportedError("multi-property assignments in INSERT are not yet supported on the async write path");
  }

  // insertScalarWriteEffect throws AsyncUnsupportedError from inside if a default
  // needs a query/function or a sequence — surfaced here before any write.
  const result = await runDbEffectAsync(
    insertScalarWriteEffect(schema, ir, compiled.sql, subjectType, ast),
    asyncDbExec(db),
  );
  return { kind: "insert", rows: result.rows ?? [] };
};
