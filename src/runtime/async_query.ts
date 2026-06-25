// Tier-1 async read path: "await at the edge".
//
// The lowered SELECT path is structurally simple — compile (pure, sync) → one
// SQL statement → decode (pure, sync). The only thing that has to be async is
// the single round-trip to the database. This entry point reuses the existing
// sync compile pipeline untouched and awaits that one `.all()`, so the engine
// core stays uncolored and this module bundles for workerd (it imports nothing
// that reaches `better-sqlite3`).
//
// Anything that isn't a single-statement object/scalar read — mutations, the
// interpreter fallback (multi-query lowering), access-policy-bearing reads —
// throws `AsyncUnsupportedError`. Those need the interleaved core (Tier 2) and
// are deliberately out of scope here, surfaced loudly rather than mishandled.

import { getCompilerService } from "../compiler/service.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { lowersToSingleSql } from "../sql/compiler_types.js";
import type { ScalarValue } from "../types.js";
import type { AsyncRuntimeDatabaseAdapter, BatchStatement } from "./adapter.js";
import {
  gelSelectDecodeOptions,
  gelStatementSourceType,
  type GelSelectDecodeOptions,
} from "./gel_select_decode.js";
import { materializeGelSQLRows } from "./row_codec.js";

export class AsyncUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncUnsupportedError";
  }
}

export interface AsyncQueryContext {
  globals?: Record<string, ScalarValue>;
  params?: Record<string, ScalarValue>;
}

export interface AsyncQueryResult {
  kind: "select";
  rows: unknown[];
}

// Top-level statement kinds that are not single-statement reads. SELECT (and
// WITH-prefixed SELECT) fall through to the compiler, whose guards below catch
// anything that still can't run on this path.
const NON_READ_KINDS = new Set([
  "insert",
  "update",
  "delete",
  "ddl",
  "configure",
  "describe",
  "explain",
  "for",
]);

const typeHasAccessPolicies = (schema: SchemaSnapshot, qualifiedName: string): boolean =>
  (schema.getType(qualifiedName)?.accessPolicies?.length ?? 0) > 0;

// A read that passed every async-path guard: the single SQL statement to run
// plus how to decode its rows.
interface CompiledRead {
  sql: string;
  params: ScalarValue[];
  decode: GelSelectDecodeOptions;
}

// Parse + compile a single read and apply all the async-path guards (non-read
// kinds, mutations, interpreter fallback, access policies). Throws
// `AsyncUnsupportedError` for anything the async path can't run. Compilation is
// pure/sync and DB-free, so this works the same for one query or a batch.
const compileReadOrThrow = (
  schema: SchemaSnapshot,
  query: string,
  target: AsyncRuntimeDatabaseAdapter["target"],
  context: AsyncQueryContext,
): CompiledRead => {
  const ast = parseEdgeQL(query);
  if (NON_READ_KINDS.has(ast.kind)) {
    throw new AsyncUnsupportedError(
      `async path supports single-statement reads; got '${ast.kind}'`,
    );
  }

  const compiled = getCompilerService().compile(schema, ast, {
    globals: context.globals,
    params: context.params,
    target,
  });

  if (compiled.ir !== undefined) {
    throw new AsyncUnsupportedError("async path does not support mutations (DML)");
  }
  if (!lowersToSingleSql(compiled.sql)) {
    throw new AsyncUnsupportedError(
      "query requires the interpreter fallback (multi-query lowering), not yet supported on the async path",
    );
  }

  // Access policies are evaluated per row via re-queries in the sync engine;
  // until the async path can do the same (Tier 2), refuse rather than return
  // unfiltered rows. Guards the root source type; link-target policies are a
  // known gap recorded with the Tier-1 scope.
  const sourceType = gelStatementSourceType(compiled.gelIr);
  if (sourceType && typeHasAccessPolicies(schema, sourceType)) {
    throw new AsyncUnsupportedError(
      `access policies on '${sourceType}' are not yet enforced on the async path`,
    );
  }

  return {
    sql: compiled.sql.sql,
    params: compiled.sql.params,
    decode: gelSelectDecodeOptions(compiled.gelIr),
  };
};

export const executeSelectAsync = async (
  db: AsyncRuntimeDatabaseAdapter,
  schema: SchemaSnapshot,
  query: string,
  context: AsyncQueryContext = {},
): Promise<AsyncQueryResult> => {
  const read = compileReadOrThrow(schema, query, db.target, context);
  const rows = (await db.prepare(read.sql).all(...read.params)) as Record<string, unknown>[];
  return { kind: "select", rows: materializeGelSQLRows(rows, read.decode) };
};

// Run several reads together. When the backend exposes `batch` (D1's single
// round-trip), all statements go in one trip; otherwise they run sequentially.
// Each query is compiled and guarded independently, so one unsupported query
// rejects the whole call before any I/O.
export const executeManyAsync = async (
  db: AsyncRuntimeDatabaseAdapter,
  schema: SchemaSnapshot,
  queries: string[],
  context: AsyncQueryContext = {},
): Promise<AsyncQueryResult[]> => {
  const reads = queries.map((q) => compileReadOrThrow(schema, q, db.target, context));

  const rowsPerQuery: Record<string, unknown>[][] = db.batch
    ? ((await db.batch(
        reads.map((r): BatchStatement => ({ sql: r.sql, params: r.params })),
      )) as Record<string, unknown>[][])
    : await Promise.all(
        reads.map(
          async (r) => (await db.prepare(r.sql).all(...r.params)) as Record<string, unknown>[],
        ),
      );

  return reads.map((r, i) => ({
    kind: "select" as const,
    rows: materializeGelSQLRows(rowsPerQuery[i], r.decode),
  }));
};
