import { describe, expect, it } from "vitest";
import {
  bindingSelectShape,
  computedElementReferencedField,
  computedExprIsMulti,
  inferArrayValuedType,
  insertValueHasUnscopedPartialPath,
  literalStdTypeName,
  unwrapSubqueryWrappers,
} from "../src/compiler/ast_inference.js";
import type { WithBindingValue } from "../src/edgeql/ast.js";

const lit = (value: unknown, numericKind?: string) => ({ kind: "literal", value, ...(numericKind ? { numericKind } : {}) });

describe("inferArrayValuedType", () => {
  it("infers the element type of a non-empty array literal", () => {
    expect(inferArrayValuedType({ kind: "array_literal", values: [lit(1)] })).toEqual({ kind: "array", element: "std::int64" });
    expect(inferArrayValuedType({ kind: "array_literal", values: [lit("x")] })).toEqual({ kind: "array", element: "std::str" });
  });
  it("treats a bare empty array as indeterminate", () => {
    expect(inferArrayValuedType({ kind: "array_literal", values: [] })).toEqual({ kind: "indeterminate" });
  });
  it("takes the element type from a non-empty operand of a ++ concat", () => {
    expect(inferArrayValuedType({
      kind: "concat",
      parts: [{ kind: "array_literal", values: [] }, { kind: "array_literal", values: [lit(1)] }],
    })).toEqual({ kind: "array", element: "std::int64" });
  });
  it("unwraps array_unpack(...) to a scalar", () => {
    expect(inferArrayValuedType({
      kind: "function_call",
      name: "array_unpack",
      args: [{ kind: "array_literal", values: [lit("a")] }],
    })).toEqual({ kind: "scalar", name: "std::str" });
  });
  it("peels an `expr` wrapper", () => {
    expect(inferArrayValuedType({ kind: "expr", expr: { kind: "array_literal", values: [lit(true)] } }))
      .toEqual({ kind: "array", element: "std::bool" });
  });
  it("is undefined for a non-array form", () => {
    expect(inferArrayValuedType(lit(5))).toBeUndefined();
    expect(inferArrayValuedType(null)).toBeUndefined();
  });
});

describe("literalStdTypeName", () => {
  it("maps JS values to std scalar names", () => {
    expect(literalStdTypeName({ value: "x" })).toBe("std::str");
    expect(literalStdTypeName({ value: true })).toBe("std::bool");
    expect(literalStdTypeName({ value: 3 })).toBe("std::int64");
    expect(literalStdTypeName({ value: 3, numericKind: "float" })).toBe("std::float64");
    expect(literalStdTypeName({ value: 3.5 })).toBe("std::float64"); // non-integer ⇒ float
    expect(literalStdTypeName({ value: null as never })).toBeUndefined();
  });
});

describe("computedExprIsMulti", () => {
  it("is true for a >1 set literal/expr, peeling select wrappers", () => {
    expect(computedExprIsMulti({ kind: "set_literal", values: [1, 2] })).toBe(true);
    expect(computedExprIsMulti({ kind: "set_literal", values: [1] })).toBe(false);
    expect(computedExprIsMulti({ kind: "select_expr", expr: { kind: "set_expr", values: [1, 2, 3] } })).toBe(true);
  });
  it("is false for a non-set form", () => {
    expect(computedExprIsMulti({ kind: "field_ref", field: "a" })).toBe(false);
  });
});

describe("computedElementReferencedField", () => {
  it("reads the field a computed references, through wrappers and current-item", () => {
    expect(computedElementReferencedField({ kind: "field_ref", field: "name" })).toBe("name");
    expect(computedElementReferencedField({ kind: "select_expr", expr: { kind: "field_ref", field: "n" } })).toBe("n");
    expect(computedElementReferencedField({ kind: "field_access", field: "x", expr: { kind: "current_item" } })).toBe("x");
  });
  it("is undefined when no single field is referenced", () => {
    expect(computedElementReferencedField({ kind: "literal", value: 1 })).toBeUndefined();
  });
});

describe("unwrapSubqueryWrappers", () => {
  it("peels subquery wrappers to the inner node", () => {
    const inner = { kind: "select", shape: [] };
    expect(unwrapSubqueryWrappers({ kind: "subquery_expr", expr: { kind: "select_expr_subquery", expr: inner } })).toBe(inner);
  });
  it("returns a non-wrapper node unchanged", () => {
    const node = { kind: "field_ref", field: "a" };
    expect(unwrapSubqueryWrappers(node)).toBe(node);
  });
});

describe("bindingSelectShape", () => {
  it("returns undefined for an absent binding", () => {
    expect(bindingSelectShape(undefined)).toBeUndefined();
  });
  it("reads the shape from a subquery_expr binding", () => {
    const binding = { kind: "subquery_expr", expr: { kind: "select", shape: [{ kind: "field", name: "a" }] } } as unknown as WithBindingValue;
    expect(bindingSelectShape(binding)).toEqual([{ kind: "field", name: "a" }]);
  });
});

describe("insertValueHasUnscopedPartialPath", () => {
  it("is true for a bare current-item reference", () => {
    expect(insertValueHasUnscopedPartialPath({ kind: "current_item" })).toBe(true);
    expect(insertValueHasUnscopedPartialPath({ kind: "tuple", items: [{ kind: "current_item" }] })).toBe(true);
  });
  it("does not descend into a nested query scope", () => {
    expect(insertValueHasUnscopedPartialPath({ kind: "select", shape: [{ kind: "current_item" }] })).toBe(false);
  });
  it("is false for a value with no partial path", () => {
    expect(insertValueHasUnscopedPartialPath({ kind: "literal", value: 1 })).toBe(false);
  });
});
