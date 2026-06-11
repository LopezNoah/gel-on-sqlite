// Tests for the gel-js-compatible Client facade (src/client). These cover
// the public API contract documented for the gel-js driver: cardinality
// methods, the result codec's value types, JSON variants, and transactions.
import { beforeAll, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  Client,
  Duration,
  NoDataError,
  ResultCardinalityMismatchError,
} from "../src/client/index.js";

let h: QueryHarness;
let client: Client;

beforeAll(async () => {
  h = await QueryHarness.create({ schema: "issues", setup: "issues_setup" });
  client = Client.fromParts(h.db, h.schema);
});

describe("Client cardinality contracts", () => {
  it("query always returns an array", async () => {
    expect(await client.query<number>("select 2 + 2;")).toEqual([4]);
    expect(await client.query<number>("select <int64>{};")).toEqual([]);
    expect(await client.query<number>("select {1, 2, 3};")).toEqual([1, 2, 3]);
  });

  it("querySingle returns zero-or-one", async () => {
    expect(await client.querySingle<number>("select 2 + 2;")).toBe(4);
    expect(await client.querySingle<number>("select <int64>{};")).toBeNull();
    await expect(client.querySingle("select {1, 2, 3};")).rejects.toThrow(
      ResultCardinalityMismatchError,
    );
  });

  it("queryRequiredSingle returns exactly-one", async () => {
    expect(await client.queryRequiredSingle<number>("select 2 + 2;")).toBe(4);
    await expect(client.queryRequiredSingle("select <int64>{};")).rejects.toThrow(NoDataError);
    await expect(client.queryRequiredSingle("select {1, 2, 3};")).rejects.toThrow(
      ResultCardinalityMismatchError,
    );
  });

  it("queryRequired returns one-or-more", async () => {
    expect(await client.queryRequired<number>("select {1, 2, 3};")).toEqual([1, 2, 3]);
    await expect(client.queryRequired("select <int64>{};")).rejects.toThrow(
      ResultCardinalityMismatchError,
    );
  });
});

describe("Client result codec", () => {
  it("decodes datetime to Date", async () => {
    const value = await client.queryRequiredSingle<Date>(
      'select <datetime>"2021-01-01T00:00:00Z";',
    );
    expect(value).toBeInstanceOf(Date);
    expect(value.toISOString()).toBe("2021-01-01T00:00:00.000Z");
  });

  it("decodes uuid to the dashed string form", async () => {
    const ids = await client.query<string>("select User.id;");
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("decodes duration to a Duration instance", async () => {
    const value = await client.queryRequiredSingle<Duration>("select <duration>'2 hours';");
    expect(value).toBeInstanceOf(Duration);
    expect(value.toString()).toBe("PT2H");
  });

  it("strips engine-internal columns from objects", async () => {
    const rows = await client.query<Record<string, unknown>>("select User { name };");
    for (const row of rows) {
      expect(row).not.toHaveProperty("__source_type");
      expect(row).not.toHaveProperty("__tid__");
      expect(row).not.toHaveProperty("__tname__");
    }
  });

  it("returns identity objects with dashed ids for bare object selects", async () => {
    const rows = await client.query<{ id: string }>("select User;");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-/);
      expect(row).not.toHaveProperty("__source_type");
    }
  });

  it("queryJSON serializes the decoded result", async () => {
    expect(await client.queryJSON("select {1, 2, 3};")).toBe("[1,2,3]");
    expect(await client.querySingleJSON("select <int64>{};")).toBe("null");
  });
});

describe("Client transactions", () => {
  it("commits on success and rolls back on error", async () => {
    const before = await client.queryRequiredSingle<number>("select count(Issue);");

    await client.transaction(async (tx) => {
      await tx.execute(`
        insert Issue {
          name := "tx commit probe",
          number := "9001",
          body := "b",
          owner := (select User filter .name = 'Elvis'),
          status := (select Status filter .name = 'Open'),
        };`);
    });
    expect(await client.queryRequiredSingle<number>("select count(Issue);")).toBe(before + 1);

    await expect(
      client.transaction(async (tx) => {
        await tx.execute(`
          insert Issue {
            name := "tx rollback probe",
            number := "9002",
            body := "b",
            owner := (select User filter .name = 'Elvis'),
            status := (select Status filter .name = 'Open'),
          };`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await client.queryRequiredSingle<number>("select count(Issue);")).toBe(before + 1);
  });
});

describe("raw mode (harness pipeline)", () => {
  it("bypasses the codec", async () => {
    const raw = Client.fromParts(h.db, h.schema, { rawResults: true });
    const value = await raw.queryRequiredSingle<string>(
      'select <datetime>"2021-01-01T00:00:00Z";',
    );
    expect(typeof value).toBe("string");
  });
});
