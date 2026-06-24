import { describe, expect, it } from "vitest";
import {
  applySessionGlobal,
  normalizeQueryVariables,
  withSessionGlobals,
  type GlobalsDeps,
} from "../src/runtime/globals.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { SecurityContext } from "../src/runtime/engine.js";
import type { ConfigureStatement } from "../src/edgeql/ast.js";

// Drives the session-globals lifecycle (ADR 0054) directly through its injected
// `GlobalsDeps` seam with stubs — no DB, no compiler — so the WeakMap lifecycle
// (set → merge-into-context → reset) and query-variable normalization have a
// focused test surface.

const ctx = (globals: Record<string, unknown> = {}): SecurityContext =>
  ({ globals }) as unknown as SecurityContext;

// `evaluateGlobalExpr` lowers `set global x := <expr>` to a SELECT and reads the
// lone scalar row off `tryRunSingleSqlRows`; the stub returns one fixed value.
const deps = (row: unknown): GlobalsDeps => ({
  tryRunSingleSqlRows: () => [row],
  normalizeSecurityContext: (c) => c,
  DEFAULT_SECURITY_CONTEXT: ctx(),
});

const setGlobal = (target: string, value: unknown): ConfigureStatement =>
  ({ target, operation: "set", value: { kind: "literal", value } }) as unknown as ConfigureStatement;
const resetGlobal = (target: string): ConfigureStatement =>
  ({ target, operation: "reset" }) as unknown as ConfigureStatement;

describe("session globals lifecycle", () => {
  it("set stores the evaluated scalar and withSessionGlobals merges it into context", () => {
    const schema = {} as unknown as SchemaSnapshot;
    applySessionGlobal({} as never, schema, setGlobal("default::cur", 42), ctx(), deps(42));
    expect(withSessionGlobals(schema, ctx()).globals).toEqual({ cur: 42 });
  });

  it("reset clears the stored value (read falls back to empty)", () => {
    const schema = {} as unknown as SchemaSnapshot;
    applySessionGlobal({} as never, schema, setGlobal("cur", 7), ctx(), deps(7));
    applySessionGlobal({} as never, schema, resetGlobal("cur"), ctx(), deps(7));
    const c = ctx();
    // Nothing stored ⇒ withSessionGlobals returns the original context untouched.
    expect(withSessionGlobals(schema, c)).toBe(c);
    expect(c.globals).toEqual({});
  });

  it("caller-supplied globals win over stored values", () => {
    const schema = {} as unknown as SchemaSnapshot;
    applySessionGlobal({} as never, schema, setGlobal("cur", 1), ctx(), deps(1));
    expect(withSessionGlobals(schema, ctx({ cur: 99 })).globals).toEqual({ cur: 99 });
  });
});

describe("normalizeQueryVariables", () => {
  it("maps a positional array to index-keyed params", () => {
    expect(normalizeQueryVariables(["a", 2, true])).toEqual({ "0": "a", "1": 2, "2": 1 });
  });

  it("maps a named object, JSON-encoding nested values and nulling undefined", () => {
    expect(normalizeQueryVariables({ name: "x", flag: false, obj: { a: 1 }, n: null }))
      .toEqual({ name: "x", flag: 0, obj: '{"a":1}', n: null });
  });
});
