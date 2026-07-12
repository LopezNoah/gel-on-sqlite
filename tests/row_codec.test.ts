import { describe, expect, it } from "vitest";
import { materializeGelSQLRows, normalizeGelSQLValue } from "../src/runtime/row_codec.js";

describe("normalizeGelSQLValue", () => {
  it("passes non-strings through, coalescing nullish to null", () => {
    expect(normalizeGelSQLValue(42)).toBe(42);
    expect(normalizeGelSQLValue(true)).toBe(true);
    expect(normalizeGelSQLValue(null)).toBeNull();
    expect(normalizeGelSQLValue(undefined)).toBeNull();
  });

  it("parses JSON-shaped strings (containers and literals)", () => {
    expect(normalizeGelSQLValue("[1,2]")).toEqual([1, 2]);
    expect(normalizeGelSQLValue('{"a":1}')).toEqual({ a: 1 });
    expect(normalizeGelSQLValue("true")).toBe(true);
    expect(normalizeGelSQLValue("null")).toBeNull();
  });

  it("leaves plain strings untouched", () => {
    expect(normalizeGelSQLValue("hello")).toBe("hello");
    expect(normalizeGelSQLValue("42")).toBe("42");
  });

  // The load-bearing fallback: type-blind decode guesses "looks like JSON", so a
  // str that merely starts with `[`/`{` but is not JSON must survive verbatim.
  it("falls back to the raw string when a JSON-looking value is not JSON", () => {
    expect(normalizeGelSQLValue("[draft")).toBe("[draft");
    expect(normalizeGelSQLValue("{not json")).toBe("{not json");
  });
});

describe("materializeGelSQLRows", () => {
  it("decodes a scalar set (single `value` column)", () => {
    expect(materializeGelSQLRows([{ value: "[1,2]" }, { value: 3 }], { keepInternalId: false }))
      .toEqual([[1, 2], 3]);
  });

  it("keeps JSON-looking text verbatim for std::str results, unwrapping only quoted JSON strings", () => {
    expect(materializeGelSQLRows([{ value: "[1]" }], { keepInternalId: false, scalarResultIsStr: true }))
      .toEqual(["[1]"]);
    expect(materializeGelSQLRows([{ value: '"hi"' }], { keepInternalId: false, scalarResultIsStr: true }))
      .toEqual(["hi"]);
  });

  it("decodes native SQLite booleans for std::bool scalar results", () => {
    expect(materializeGelSQLRows([{ value: 1 }, { value: 0 }], { keepInternalId: false, scalarResultIsBool: true }))
      .toEqual([true, false]);
  });

  it("decodes an object set, dropping internal columns unless keepInternalId", () => {
    const row = { id: "u1", name: "Bob", tags: '["a","b"]', __source_type: "default::User", __tid__: "x" };
    expect(materializeGelSQLRows([row], { keepInternalId: false })).toEqual([{ name: "Bob", tags: ["a", "b"] }]);
    expect(materializeGelSQLRows([row], { keepInternalId: true })).toEqual([{ id: "u1", name: "Bob", tags: ["a", "b"] }]);
  });

  it("keeps an object row whose shape columns are all null (they are still shape columns)", () => {
    expect(materializeGelSQLRows([{ name: null, age: null }], { keepInternalId: false }))
      .toEqual([{ name: null, age: null }]);
  });

  it("materializes a column-less row (only internal columns, all null) to null", () => {
    // hasShapeColumn stays false (id is dropped, __source_type is internal),
    // and every original value is null → the empty-object-link case.
    expect(materializeGelSQLRows([{ id: null, __source_type: null }], { keepInternalId: false }))
      .toEqual([null]);
  });
});
