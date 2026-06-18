import { describe, expect, it } from "vitest";
import { loadSchema } from "../src/schema/load.js";
import { evalTypeNarrowing, type NarrowingEnv, type TypeNarrowingDeps, type TypeNarrowingExpr } from "../src/runtime/type_narrowing.js";
import type { FreeObjectExpr } from "../src/edgeql/ast.js";

// Runtime `[IS T]` narrowing used to be four cases buried in the 39-case
// `evalExpr` closure, reachable only end-to-end through executeQuery. It now
// has its own interface (`evalTypeNarrowing`) with an explicit deps seam, so it
// can be driven directly with a stub `evalExpr` and a real schema — no DB, no
// full evaluator. See docs/adr/0014 (the rest of the decomposition stays
// deferred). The narrowing keys off `concreteTypeNamesUnder`, the same
// concrete-type closure the SQL path uses.

const schema = loadSchema(`module default {
  abstract type Animal { required name: str; }
  type Dog extending Animal {}
  type Cat extending Animal {}
  type Plant { required name: str; }
}`, { legacySyntaxCompat: true });

// evalExpr is stubbed to return a fixed operand: the narrowing logic under test
// never depends on *how* the operand is produced, only on its `__source_type`.
const depsFor = (operand: unknown): TypeNarrowingDeps => ({
  evalExpr: () => operand,
  schema,
  qualifyRuntimeTypeName: (name) => (name.includes("::") ? name : `default::${name}`),
});

const placeholder = { kind: "literal", value: 0 } as unknown as FreeObjectExpr;
const dogRow = { __source_type: "default::Dog", name: "Rex" };
const envWith = (current: unknown): NarrowingEnv => new Map<string, unknown>([["__current__", current]]);

describe("evalTypeNarrowing — direct seam", () => {
  it("is_type keeps a row whose __source_type is under the (abstract) target", () => {
    const expr = { kind: "is_type", expr: placeholder, typeName: "Animal" } as TypeNarrowingExpr;
    expect(evalTypeNarrowing(expr, new Map(), depsFor(dogRow))).toEqual([dogRow]);
  });

  it("is_type drops a row whose concrete type is not under the target", () => {
    const expr = { kind: "is_type", expr: placeholder, typeName: "Cat" } as TypeNarrowingExpr;
    expect(evalTypeNarrowing(expr, new Map(), depsFor(dogRow))).toEqual([]);
  });

  it("is_type does a scalar type test for primitive operands", () => {
    const isInt = { kind: "is_type", expr: placeholder, typeName: "int64" } as TypeNarrowingExpr;
    const isStr = { kind: "is_type", expr: placeholder, typeName: "str" } as TypeNarrowingExpr;
    expect(evalTypeNarrowing(isInt, new Map(), depsFor(42))).toBe(true);
    expect(evalTypeNarrowing(isStr, new Map(), depsFor(42))).toBe(false);
  });

  it("type_intersection is the same check as is_type over the operand", () => {
    const hit = { kind: "type_intersection", sourceType: "Animal", expr: placeholder } as TypeNarrowingExpr;
    const miss = { kind: "type_intersection", sourceType: "Plant", expr: placeholder } as TypeNarrowingExpr;
    expect(evalTypeNarrowing(hit, new Map(), depsFor(dogRow))).toEqual([dogRow]);
    expect(evalTypeNarrowing(miss, new Map(), depsFor(dogRow))).toEqual([]);
  });

  it("type_name reads the discriminator off the current row", () => {
    const expr = { kind: "type_name" } as TypeNarrowingExpr;
    expect(evalTypeNarrowing(expr, envWith(dogRow), depsFor(undefined))).toBe("default::Dog");
    expect(evalTypeNarrowing(expr, envWith(42), depsFor(undefined))).toBeNull();
  });

  it("polymorphic_field_ref returns the field only when the row matches the source type", () => {
    const underBase = { kind: "polymorphic_field_ref", sourceType: "Animal", field: "name" } as TypeNarrowingExpr;
    const underOther = { kind: "polymorphic_field_ref", sourceType: "Plant", field: "name" } as TypeNarrowingExpr;
    expect(evalTypeNarrowing(underBase, envWith(dogRow), depsFor(undefined))).toBe("Rex");
    expect(evalTypeNarrowing(underOther, envWith(dogRow), depsFor(undefined))).toBeNull();
  });
});
