// Color-free DB access for the write path.
//
// The problem (ADR 0060): the write executor interleaves DB reads and writes
// with in-process logic, and the reads are data-dependent — you can't pre-fetch
// them. The engine is synchronous; D1 is async. Coloring the whole write core
// `async` would add a promise per DB hop on the synchronous backends (Node, DO,
// WASM) and force every caller to await.
//
// Instead, write logic is expressed as a GENERATOR that `yield`s a DB request
// and resumes with its result. The logic never knows whether it runs sync or
// async — it is "uncolored". Two drivers run the exact same generator:
//
//   * runDbEffectSync  — pulls each request, executes it synchronously, feeds
//                        the result straight back. Zero promises, zero added
//                        latency: the better-sqlite3 / DO / WASM path.
//   * runDbEffectAsync — awaits each request before resuming: the D1 path.
//
// One implementation, two drivers → no divergence between the sync and async
// write paths (the failure mode a hand-written async insert would risk).

import type { AsyncRuntimeStatement, RuntimeStatement } from "./adapter.js";
import type { ScalarValue } from "../types.js";

export type DbRows = Record<string, unknown>[];
export type DbChanges = { changes: number };
export type DbResult = DbRows | DbChanges;

/** A row-returning read (`prepare(sql).all(...params)`). */
export interface DbAllOp {
  readonly kind: "all";
  readonly sql: string;
  readonly params: ScalarValue[];
}

/** A write / statement (`prepare(sql).run(...params)`). */
export interface DbRunOp {
  readonly kind: "run";
  readonly sql: string;
  readonly params: ScalarValue[];
}

export type DbOp = DbAllOp | DbRunOp;

/**
 * A DB effect: a generator that yields `DbOp`s, is resumed with each op's
 * `DbResult`, and finally returns `T`. Write logic is written as `DbEffect<…>`
 * and delegates to other effects with `yield*`.
 */
export type DbEffect<T> = Generator<DbOp, T, DbResult>;

/** Run a read; returns its rows. Use as `const rows = yield* dbAll(sql, ...p)`. */
export function* dbAll(sql: string, ...params: ScalarValue[]): DbEffect<DbRows> {
  return (yield { kind: "all", sql, params }) as DbRows;
}

/** Run a statement; returns `{ changes }`. Use as `yield* dbRun(sql, ...p)`. */
export function* dbRun(sql: string, ...params: ScalarValue[]): DbEffect<DbChanges> {
  return (yield { kind: "run", sql, params }) as DbChanges;
}

export type SyncDbExec = (op: DbOp) => DbResult;
export type AsyncDbExec = (op: DbOp) => Promise<DbResult>;

// A failed DB op is injected back INTO the generator via `.throw()`, so the
// write logic's own `try/catch/finally` runs (e.g. ROLLBACK on a constraint
// violation) under both drivers. If the generator rethrows, it propagates out
// — after its `finally` blocks have run.

/** Drive a DB effect synchronously (better-sqlite3 / Durable Object / WASM). */
export const runDbEffectSync = <T>(effect: DbEffect<T>, exec: SyncDbExec): T => {
  let step = effect.next();
  while (!step.done) {
    let result: DbResult;
    try {
      result = exec(step.value);
    } catch (err) {
      // Inject the failure into the generator (outside this try) so its own
      // catch/finally runs; an uncaught rethrow propagates out of the driver.
      step = effect.throw(err);
      continue;
    }
    step = effect.next(result);
  }
  return step.value;
};

/** Drive a DB effect asynchronously (Cloudflare D1). */
export const runDbEffectAsync = async <T>(effect: DbEffect<T>, exec: AsyncDbExec): Promise<T> => {
  let step = effect.next();
  while (!step.done) {
    let result: DbResult;
    try {
      result = await exec(step.value);
    } catch (err) {
      step = effect.throw(err);
      continue;
    }
    step = effect.next(result);
  }
  return step.value;
};

/** A sync executor over anything with `prepare(sql) → { all, run }`. */
export const syncDbExec = (db: { prepare: (sql: string) => RuntimeStatement }): SyncDbExec =>
  (op) =>
    op.kind === "all" ? db.prepare(op.sql).all(...op.params) : db.prepare(op.sql).run(...op.params);

/** An async executor over anything with async `prepare(sql) → { all, run }`
 *  (the D1 / DO async adapters). */
export const asyncDbExec = (db: { prepare: (sql: string) => AsyncRuntimeStatement }): AsyncDbExec =>
  async (op) =>
    op.kind === "all"
      ? await db.prepare(op.sql).all(...op.params)
      : await db.prepare(op.sql).run(...op.params);
