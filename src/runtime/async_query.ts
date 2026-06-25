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
import type { AsyncRuntimeDatabaseAdapter } from "./adapter.js";
import { gelSelectDecodeOptions, gelStatementSourceType } from "./gel_select_decode.js";
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

export const executeSelectAsync = async (
  db: AsyncRuntimeDatabaseAdapter,
  schema: SchemaSnapshot,
  query: string,
  context: AsyncQueryContext = {},
): Promise<AsyncQueryResult> => {
  const ast = parseEdgeQL(query);
  if (NON_READ_KINDS.has(ast.kind)) {
    throw new AsyncUnsupportedError(
      `async path supports single-statement reads; got '${ast.kind}'`,
    );
  }

  const compiled = getCompilerService().compile(schema, ast, {
    globals: context.globals,
    params: context.params,
    target: db.target,
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

  const rows = (await db
    .prepare(compiled.sql.sql)
    .all(...compiled.sql.params)) as Record<string, unknown>[];
  const out = materializeGelSQLRows(rows, gelSelectDecodeOptions(compiled.gelIr));
  return { kind: "select", rows: out };
};
