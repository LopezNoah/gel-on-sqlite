// ── SQL execution tracing ────────────────────────────────────────────────
// Many queries (writes, select-over-mutation, WITH-bound DML chains) fan out
// into several SQL statements, but the trace would otherwise surface only the
// final/primary artifact. We record *every* statement actually run against the
// backend — in order, params included — so `QueryExecutionTrace.sqlTrail`
// reflects the complete sequence (BEGIN/COMMIT, reads, writes). The recorder
// is installed once per db by wrapping `prepare`; it only collects while a
// sink is active (set for the duration of one `executeQueryWithTrace` call).
// NOTE: this hooks the synchronous better-sqlite3 `run`/`all`/`get`. An async
// backend (e.g. Cloudflare D1) would need the same capture at its await
// boundary instead.
//
// The active sink is module-private state owned here: callers install the
// recorder with `installSqlTrace` and scope a sink with `runWithSqlSink`,
// rather than reaching into a shared global.
import type { GelIRSQLArtifact as SQLArtifact } from "../sql/gel_ir_compiler.js";
import type { SQLiteDatabase } from "./database.js";
import type { ScalarValue } from "../types.js";

const SQL_TRACE_INSTALLED = Symbol.for("gel.sqlTraceInstalled");
let activeSqlSink: SQLArtifact[] | null = null;

// Wrap `db.prepare` (once per db) so every executed statement is recorded into
// the active sink, if any. No-op when re-called on an already-instrumented db.
export const installSqlTrace = (db: SQLiteDatabase): void => {
  const marked = db as unknown as Record<symbol, unknown>;
  if (marked[SQL_TRACE_INSTALLED]) {
    return;
  }
  marked[SQL_TRACE_INSTALLED] = true;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    // Fast path: when no trace sink is active (the normal query path doesn't
    // record a SQL trail), hand back the statement unwrapped. This avoids
    // allocating the recording closures and reassigning run/all/get on every
    // prepared statement — pure overhead when nothing consumes the trail.
    if (!activeSqlSink) {
      return stmt;
    }
    const record = (params: ScalarValue[]): void => {
      if (activeSqlSink) {
        activeSqlSink.push({ sql, params: [...params], loweringMode: "single_statement" });
      }
    };
    const origRun = stmt.run.bind(stmt);
    const origAll = stmt.all.bind(stmt);
    stmt.run = (...params: ScalarValue[]) => { record(params); return origRun(...params); };
    stmt.all = (...params: ScalarValue[]) => { record(params); return origAll(...params); };
    const maybeGet = (stmt as { get?: (...p: ScalarValue[]) => unknown }).get;
    if (maybeGet) {
      const origGet = maybeGet.bind(stmt);
      (stmt as { get?: (...p: ScalarValue[]) => unknown }).get = (...params: ScalarValue[]) => { record(params); return origGet(...params); };
    }
    return stmt;
  };
};

// Run `fn` with `sink` as the active trace sink, restoring the previous sink on
// exit. Nesting is supported (each scope restores its predecessor), so nested
// executeQueryWithTrace calls each report their own SQL sequence.
export const runWithSqlSink = <T>(sink: SQLArtifact[], fn: () => T): T => {
  const previousSink = activeSqlSink;
  activeSqlSink = sink;
  try {
    return fn();
  } finally {
    activeSqlSink = previousSink;
  }
};
