import { describe, expect, it } from "vitest";
import { openSQLite } from "../src/runtime/database.js";
import {
  asyncDbExec,
  dbAll,
  dbRun,
  runDbEffectAsync,
  runDbEffectSync,
  syncDbExec,
  type DbEffect,
} from "../src/runtime/db_effect.js";

type Db = ReturnType<typeof openSQLite>["db"];

const freshDb = (): Db => {
  const { db } = openSQLite(":memory:");
  db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").run();
  return db;
};

// An async exec backed by the same sync db — proves the async DRIVER awaits and
// resumes correctly, independent of the generator.
const awaitedExec = (db: Db) => {
  const sync = syncDbExec(db);
  return asyncDbExec({
    prepare: (sql) => ({
      all: async (...p) => sync({ kind: "all", sql, params: p }) as Record<string, unknown>[],
      run: async (...p) => sync({ kind: "run", sql, params: p }) as { changes: number },
    }),
  });
};

// One uncolored generator. Inserts a row, reads the count back.
function* insertAndCount(name: string): DbEffect<number> {
  yield* dbRun("INSERT INTO t (name) VALUES (?)", name);
  const rows = yield* dbAll("SELECT count(*) AS c FROM t");
  return Number(rows[0].c);
}

// The hard case: the SECOND write depends on the result of a READ — the exact
// data-dependent interleave the engine's write executor needs. Cannot be
// pre-fetched or batched.
function* upsertFirstOrMore(): DbEffect<string> {
  const rows = yield* dbAll("SELECT count(*) AS c FROM t");
  const isFirst = Number(rows[0].c) === 0;
  yield* dbRun("INSERT INTO t (name) VALUES (?)", isFirst ? "first" : "more");
  const all = yield* dbAll("SELECT name FROM t ORDER BY id");
  return all.map((r) => String(r.name)).join(",");
}

describe("db_effect — uncolored write core, two drivers", () => {
  it("runs the SAME generator sync and async with identical results", async () => {
    const syncResult = runDbEffectSync(insertAndCount("a"), syncDbExec(freshDb()));
    const asyncResult = await runDbEffectAsync(insertAndCount("a"), awaitedExec(freshDb()));
    expect(syncResult).toBe(1);
    expect(asyncResult).toBe(1);
  });

  it("the sync driver is genuinely synchronous (returns a value, not a Promise)", () => {
    const out = runDbEffectSync(insertAndCount("a"), syncDbExec(freshDb()));
    expect(out).not.toBeInstanceOf(Promise);
    expect(out).toBe(1);
  });

  it("handles read→decide→write interleaving identically under both drivers", async () => {
    // empty db: first write takes the 'first' branch
    expect(runDbEffectSync(upsertFirstOrMore(), syncDbExec(freshDb()))).toBe("first");
    expect(await runDbEffectAsync(upsertFirstOrMore(), awaitedExec(freshDb()))).toBe("first");

    // second call on a non-empty db takes the 'more' branch — same under both
    const sdb = freshDb();
    runDbEffectSync(upsertFirstOrMore(), syncDbExec(sdb));
    expect(runDbEffectSync(upsertFirstOrMore(), syncDbExec(sdb))).toBe("first,more");

    const adb = freshDb();
    await runDbEffectAsync(upsertFirstOrMore(), awaitedExec(adb));
    expect(await runDbEffectAsync(upsertFirstOrMore(), awaitedExec(adb))).toBe("first,more");
  });
});

// A failing DB op must surface inside the generator so the write logic's own
// catch/finally runs (the ROLLBACK-on-error the write executor depends on).
function* failingWriteWithFinally(log: string[]): DbEffect<void> {
  try {
    yield* dbRun("INSERT INTO t (id, name) VALUES (1, 'a')");
    yield* dbRun("INSERT INTO t (id, name) VALUES (1, 'b')"); // PK conflict → exec throws
  } finally {
    log.push("finally-ran");
  }
}

function* catchAndRecover(): DbEffect<string> {
  try {
    yield* dbRun("INSERT INTO t (id, name) VALUES (1, 'a')");
    yield* dbRun("INSERT INTO t (id, name) VALUES (1, 'b')"); // throws
    return "no-error";
  } catch {
    const rows = yield* dbAll("SELECT count(*) AS c FROM t");
    return `recovered:${rows[0].c}`;
  }
}

describe("db_effect — error propagation into the generator", () => {
  it("runs finally and rethrows when a DB op fails (sync)", () => {
    const log: string[] = [];
    expect(() => runDbEffectSync(failingWriteWithFinally(log), syncDbExec(freshDb()))).toThrow();
    expect(log).toEqual(["finally-ran"]);
  });

  it("runs finally and rejects when a DB op fails (async)", async () => {
    const log: string[] = [];
    await expect(runDbEffectAsync(failingWriteWithFinally(log), awaitedExec(freshDb()))).rejects.toThrow();
    expect(log).toEqual(["finally-ran"]);
  });

  it("lets the generator catch the failure and keep yielding, identically under both drivers", async () => {
    expect(runDbEffectSync(catchAndRecover(), syncDbExec(freshDb()))).toBe("recovered:1");
    expect(await runDbEffectAsync(catchAndRecover(), awaitedExec(freshDb()))).toBe("recovered:1");
  });
});
