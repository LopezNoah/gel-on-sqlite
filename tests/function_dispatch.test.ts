import { describe, expect, it } from "vitest";
import {
  executeFunctionCall,
  inferStaticArgType,
  resolveUserFunctionOverload,
  type FunctionDispatchDeps,
} from "../src/runtime/function_dispatch.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { FunctionDef } from "../src/types.js";
import type { FunctionCallArgExpr } from "../src/edgeql/ast.js";

// Drives function-call dispatch (ADR 0055) through its injected
// `FunctionDispatchDeps` seam with stubs — no DB, no compiler. Overload
// resolution and static-arg-type inference are pure; the stdlib-count path is
// shown routing through the injected cardinality counter.

const lit = (value: unknown): FunctionCallArgExpr =>
  ({ kind: "literal", value }) as unknown as FunctionCallArgExpr;

const fnDef = (over: Partial<FunctionDef> & { params: unknown[] }): FunctionDef =>
  ({ module: "default", name: "foo", volatility: "Immutable", returnSetOf: false, ...over }) as unknown as FunctionDef;

const schemaWith = (fns: FunctionDef[]): SchemaSnapshot =>
  ({ listFunctions: () => fns }) as unknown as SchemaSnapshot;

const deps = (over: Partial<FunctionDispatchDeps> = {}): FunctionDispatchDeps => ({
  executeQuery: () => ({ rows: [] }) as never,
  countRuntimeSetCardinality: () => 0,
  ...over,
});

describe("inferStaticArgType", () => {
  it("types scalar literals (int64 / float64 / str / bool)", () => {
    const s = {} as unknown as SchemaSnapshot;
    expect(inferStaticArgType(lit(7), s, "default")).toBe("int64");
    expect(inferStaticArgType(lit(1.5), s, "default")).toBe("float64");
    expect(inferStaticArgType(lit("x"), s, "default")).toBe("str");
    expect(inferStaticArgType(lit(true), s, "default")).toBe("bool");
  });
});

describe("resolveUserFunctionOverload", () => {
  const fooStr = fnDef({ params: [{ name: "x", type: "str" }] });
  const fooInt = fnDef({ params: [{ name: "x", type: "int64" }] });

  it("picks the overload whose param type matches the runtime arg", () => {
    const schema = schemaWith([fooStr, fooInt]);
    expect(resolveUserFunctionOverload(schema, "default", "foo", [42])).toBe(fooInt);
    expect(resolveUserFunctionOverload(schema, "default", "foo", ["hi"])).toBe(fooStr);
  });

  it("returns undefined when no overload by that name exists", () => {
    expect(resolveUserFunctionOverload(schemaWith([fooStr]), "default", "bar", [1])).toBeUndefined();
  });
});

describe("executeFunctionCall — stdlib dispatch", () => {
  it("routes std::count through the injected cardinality counter", () => {
    const schema = schemaWith([]);
    const out = executeFunctionCall(
      schema, {} as never, {} as never, "std::count", [{ kind: "set", values: [1, 2, 3] }],
      deps({ countRuntimeSetCardinality: (v) => (v as { values: unknown[] }).values.length }),
    );
    expect(out).toBe(3);
  });
});
