import { describe, expect, it } from "vitest";
import { applyLimitOffset, dedupeRowsById, distinctValues } from "../src/runtime/result_clauses.js";

describe("result_clauses — dedupeRowsById", () => {
  it("dedupes id-bearing rows by id, first-seen order", () => {
    const rows = [{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "a", n: 3 }];
    expect(dedupeRowsById(rows)).toEqual([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
  });

  it("passes through items that are not id-bearing objects", () => {
    const rows = [1, "x", { id: "a" }, { id: "a" }, null];
    expect(dedupeRowsById(rows)).toEqual([1, "x", { id: "a" }, null]);
  });
});

describe("result_clauses — distinctValues", () => {
  it("dedupes scalars by value", () => {
    expect(distinctValues([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
  });

  it("dedupes structurally-equal arrays/tuples", () => {
    expect(distinctValues([[1, 2], [1, 2], [3]])).toEqual([[1, 2], [3]]);
  });
});

describe("result_clauses — applyLimitOffset", () => {
  const xs = [0, 1, 2, 3, 4];
  it("returns a full copy when limit is undefined and offset is 0", () => {
    expect(applyLimitOffset(xs, undefined)).toEqual([0, 1, 2, 3, 4]);
  });
  it("applies limit from the start", () => {
    expect(applyLimitOffset(xs, 2)).toEqual([0, 1]);
  });
  it("applies offset with an open end", () => {
    expect(applyLimitOffset(xs, undefined, 2)).toEqual([2, 3, 4]);
  });
  it("applies offset + limit together", () => {
    expect(applyLimitOffset(xs, 2, 1)).toEqual([1, 2]);
  });
});
