import { describe, expect, it } from "vitest";
import {
  GelTableDecoder,
  parseComputedLinkExpr,
  parseComputedPropertyExpr,
  parseRewriteExpr,
  parseScalarValueFromMetadata,
  type DecoderRow,
} from "../src/schema/gel_table_decoder.js";
import type { FunctionMetadata } from "../src/schema/gel_metadata_schemas.js";

// A minimal `gel_schema` row index for the decoder to resolve type ids against.
const idToRow = new Map<string, DecoderRow>([
  ["type_default__User", { kind: "ObjectType", name: "User", name__internal: "default::User" }],
  ["scalar_int64", { kind: "ScalarType", name: "int64", name__internal: "std::int64" }],
]);

describe("GelTableDecoder.scalarType", () => {
  const dec = new GelTableDecoder(idToRow);

  it("defaults a missing target to str", () => {
    expect(dec.scalarType(undefined)).toBe("str");
  });

  it("reads the base name out of a scalar_* id without touching the index", () => {
    expect(dec.scalarType("scalar_int64")).toBe("int64");
    expect(dec.scalarType("scalar_str")).toBe("str");
  });

  it("resolves a non-scalar id through the row index by name", () => {
    expect(dec.scalarType("type_default__User")).toBe("User");
  });

  it("falls back to str for an unknown id", () => {
    expect(dec.scalarType("type_missing")).toBe("str");
  });
});

describe("GelTableDecoder.targetType", () => {
  const dec = new GelTableDecoder(idToRow);

  it("defaults a missing target to std::str", () => {
    expect(dec.targetType(undefined)).toBe("std::str");
  });

  it("resolves an id to its qualified name__internal", () => {
    expect(dec.targetType("type_default__User")).toBe("default::User");
  });

  it("returns an unknown id verbatim", () => {
    expect(dec.targetType("type_missing")).toBe("type_missing");
  });
});

describe("GelTableDecoder.typeName", () => {
  const dec = new GelTableDecoder(idToRow);

  it("defaults a missing id to std::str", () => {
    expect(dec.typeName(undefined)).toBe("std::str");
  });

  it("strips the scalar_ prefix", () => {
    expect(dec.typeName("scalar_int64")).toBe("int64");
  });

  it("resolves an object id to its qualified name", () => {
    expect(dec.typeName("type_default__User")).toBe("default::User");
  });

  it("returns an unknown id verbatim", () => {
    expect(dec.typeName("type_missing")).toBe("type_missing");
  });
});

describe("GelTableDecoder.functionParams", () => {
  const dec = new GelTableDecoder(idToRow);

  it("maps the empty/absent param list to []", () => {
    expect(dec.functionParams(undefined)).toEqual([]);
    expect(dec.functionParams([])).toEqual([]);
  });

  it("maps kinds, typemods and JSON defaults", () => {
    const params: NonNullable<FunctionMetadata["params"]> = [
      { name: "a", type_id: "scalar_int64", kind: "PositionalParam", typemod: "SingletonType", default: "7" },
      { name: "b", type_id: "type_default__User", kind: "VariadicParam", typemod: "SetOfType" },
      { name: "c", type_id: "scalar_str", kind: "NamedOnlyParam", typemod: "OptionalType" },
    ];
    expect(dec.functionParams(params)).toEqual([
      { name: "a", type: "int64", optional: false, setOf: false, variadic: false, namedOnly: false, default: 7 },
      { name: "b", type: "default::User", optional: false, setOf: true, variadic: true, namedOnly: false, default: undefined },
      { name: "c", type: "str", optional: true, setOf: false, variadic: false, namedOnly: true, default: undefined },
    ]);
  });
});

describe("parseComputedPropertyExpr", () => {
  it("recognises a sum(.link.field) aggregate", () => {
    expect(parseComputedPropertyExpr("sum(.items.price)")).toEqual({
      kind: "link_aggregate",
      functionName: "sum",
      link: "items",
      field: "price",
    });
  });

  it("reads a leading-dot field reference", () => {
    expect(parseComputedPropertyExpr(".name")).toEqual({ kind: "field_ref", field: "name" });
  });

  it("treats a bare string as a literal", () => {
    expect(parseComputedPropertyExpr("hello")).toEqual({ kind: "literal", value: "hello" });
  });
});

describe("parseComputedLinkExpr", () => {
  it("reads a typed backlink", () => {
    expect(parseComputedLinkExpr(".<owner[is default::Item]")).toEqual({
      kind: "backlink",
      link: "owner",
      sourceType: "default::Item",
    });
  });

  it("reads an untyped backlink", () => {
    expect(parseComputedLinkExpr(".<children")).toEqual({ kind: "backlink", link: "children", sourceType: undefined });
  });

  it("reads a forward link reference", () => {
    expect(parseComputedLinkExpr(".owner")).toEqual({ kind: "link_ref", link: "owner" });
  });
});

describe("parseRewriteExpr", () => {
  it("reads the statement-clock builtin", () => {
    expect(parseRewriteExpr("datetime_of_statement()")).toEqual({ kind: "datetime_of_statement" });
  });

  it("reads __old__ and subject field references", () => {
    expect(parseRewriteExpr("__old__.count")).toEqual({ kind: "old_field", field: "count" });
    expect(parseRewriteExpr(".count")).toEqual({ kind: "subject_field", field: "count" });
  });

  it("reads a JSON literal", () => {
    expect(parseRewriteExpr("42")).toEqual({ kind: "literal", value: 42 });
  });

  it("throws on corrupt (non-JSON) metadata rather than silently dropping it", () => {
    expect(() => parseRewriteExpr("not json")).toThrow(/corrupt rewrite expression/);
  });
});

describe("parseScalarValueFromMetadata", () => {
  it("maps nullish to undefined", () => {
    expect(parseScalarValueFromMetadata(undefined)).toBeUndefined();
    expect(parseScalarValueFromMetadata(null)).toBeUndefined();
  });

  it("JSON-decodes stored values", () => {
    expect(parseScalarValueFromMetadata('"hi"')).toBe("hi");
    expect(parseScalarValueFromMetadata("42")).toBe(42);
    expect(parseScalarValueFromMetadata("true")).toBe(true);
  });

  it("throws on corrupt (non-JSON) metadata", () => {
    expect(() => parseScalarValueFromMetadata("not json")).toThrow(/corrupt scalar value/);
  });
});
