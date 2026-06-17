import { describe, expect, it } from "vitest";
import type { ComputedExpr, FreeObjectExpr } from "../src/edgeql/ast.js";
import { coIteratedBinding, findBindingRoot } from "../src/runtime/co_iteration.js";

const ref = (name: string) => ({ kind: "binding_ref", name }) as unknown as FreeObjectExpr;
const field = (expr: unknown) => ({ kind: "field_access", expr }) as unknown as FreeObjectExpr;
const cast = (expr: unknown) => ({ kind: "cast", expr }) as unknown as FreeObjectExpr;
const lit = (value: unknown) => ({ kind: "literal", value }) as unknown as FreeObjectExpr;

describe("findBindingRoot", () => {
  it("returns a binding reference's name", () => {
    expect(findBindingRoot(ref("x"))).toBe("x");
  });

  it("walks field/index/cast wrappers down to the binding root", () => {
    expect(findBindingRoot(field(ref("I")))).toBe("I");
    expect(findBindingRoot(cast(field(ref("I"))))).toBe("I");
  });

  it("returns null when not rooted in a binding", () => {
    expect(findBindingRoot(lit(1))).toBeNull();
    expect(findBindingRoot(field(lit(1)))).toBeNull();
  });
});

describe("coIteratedBinding", () => {
  const envWith = (entries: Record<string, unknown>): Map<string, unknown> => new Map(Object.entries(entries));

  it("detects two operands walking the same set-valued binding", () => {
    const env = envWith({ x: [1, 2, 3] });
    expect(coIteratedBinding(ref("x"), ref("x"), env)).toEqual({ root: "x", rows: [1, 2, 3] });
    // through wrappers too: `I.a ?!= I.b`
    expect(coIteratedBinding(field(ref("I")), field(ref("I")), envWith({ I: [{ id: "1" }] })))
      .toEqual({ root: "I", rows: [{ id: "1" }] });
  });

  it("returns null when the roots differ", () => {
    expect(coIteratedBinding(ref("x"), ref("y"), envWith({ x: [1], y: [2] }))).toBeNull();
  });

  it("returns null when the binding is not bound to a set (no co-iteration)", () => {
    expect(coIteratedBinding(ref("x"), ref("x"), envWith({ x: 5 }))).toBeNull();
  });

  it("returns null when the binding is absent from the environment", () => {
    expect(coIteratedBinding(ref("x"), ref("x"), envWith({}))).toBeNull();
  });

  it("returns null when an operand is not binding-rooted", () => {
    expect(coIteratedBinding(lit(1), ref("x"), envWith({ x: [1] }))).toBeNull();
  });
});
