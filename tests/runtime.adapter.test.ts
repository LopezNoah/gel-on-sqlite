import { afterEach, describe, expect, it } from "vitest";

import { openSQLite, openSQLiteAsync, type SQLiteRuntime } from "../src/runtime/database.js";
import { toAsyncAdapter } from "../src/runtime/adapter.js";

describe("runtime adapter", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("wraps sync adapters for async execution", async () => {
    runtime = openSQLite(":memory:");
    const asyncDb = toAsyncAdapter(runtime.db);

    const rows = await asyncDb.prepare("SELECT 7 AS value").all();
    expect(rows).toEqual([{ value: 7 }]);
    expect(asyncDb.target).toBe("sqlite");
  });

  it("opens sqlite runtime with async adapter facade", async () => {
    const asyncRuntime = await openSQLiteAsync(":memory:");
    const rows = await asyncRuntime.db.prepare("SELECT 11 AS value").all();

    expect(rows).toEqual([{ value: 11 }]);
    await asyncRuntime.close();
  });
});
