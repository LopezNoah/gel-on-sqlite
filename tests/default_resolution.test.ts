import { describe, expect, it, vi } from "vitest";
import { applyPendingInsertDefaults, type InsertDefaultDeps } from "../src/runtime/default_resolution.js";
import type { ScalarValue, TypeDef } from "../src/types.js";

const REWRITE = "__gel_pending_insert_rewrite__";

// A subjectType carrying just the field default specs the resolver reads.
const typeWithFields = (fields: unknown[]): TypeDef =>
  ({ name: "T", module: "default", fields }) as unknown as TypeDef;

const baseDeps = (over: Partial<InsertDefaultDeps>): InsertDefaultDeps => ({
  subjectType: typeWithFields([]),
  evalSelect: () => undefined,
  evalFunctionCall: () => undefined,
  isResolvedSourceValue: (v) => v !== undefined && v !== REWRITE,
  isPendingRewriteValue: (v) => v === REWRITE,
  ...over,
});

describe("applyPendingInsertDefaults", () => {
  it("fills a literal default", () => {
    const values: Record<string, ScalarValue> = {};
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "n", hasDefault: true, defaultExpr: { kind: "literal", value: 7 } }]),
    }));
    expect(values.n).toBe(7);
  });

  it("fills a function-call default via the injected evaluator", () => {
    const values: Record<string, ScalarValue> = {};
    const evalFunctionCall = vi.fn(() => "now");
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "ts", hasDefault: true, defaultExpr: { kind: "function_call", name: "std::datetime_current", args: [] } }]),
      evalFunctionCall,
    }));
    expect(values.ts).toBe("now");
    expect(evalFunctionCall).toHaveBeenCalledWith("std::datetime_current", []);
  });

  it("fills a SQL-text default from the single scalar row evalSelect returns", () => {
    const values: Record<string, ScalarValue> = {};
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "c", hasDefault: true, defaultExprText: "(SELECT count(T))" }]),
      evalSelect: () => [42],
    }));
    expect(values.c).toBe(42);
  });

  it("leaves a SQL-text default pending when evalSelect can't lower it", () => {
    const values: Record<string, ScalarValue> = {};
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "c", hasDefault: true, defaultExprText: "(SELECT count(T))" }]),
      evalSelect: () => undefined,
    }));
    expect("c" in values).toBe(false);
  });

  it("reuses the snapshot-memoized value and does not re-evaluate", () => {
    const values: Record<string, ScalarValue> = {};
    const cache = new Map<string, ScalarValue>([["c", 99]]);
    const evalSelect = vi.fn(() => [1]);
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "c", hasDefault: true, defaultExprText: "(SELECT count(T))" }]),
      snapshotDefaultCache: cache,
      evalSelect,
    }));
    expect(values.c).toBe(99);
    expect(evalSelect).not.toHaveBeenCalled();
  });

  it("memoizes the first evaluation into the snapshot cache", () => {
    const values: Record<string, ScalarValue> = {};
    const cache = new Map<string, ScalarValue>();
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "c", hasDefault: true, defaultExprText: "(SELECT count(T))" }]),
      snapshotDefaultCache: cache,
      evalSelect: () => [5],
    }));
    expect(values.c).toBe(5);
    expect(cache.get("c")).toBe(5);
  });

  it("skips a field that already carries a concrete value", () => {
    const values: Record<string, ScalarValue> = { n: 1 };
    const evalFunctionCall = vi.fn(() => 999);
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "n", hasDefault: true, defaultExpr: { kind: "function_call", name: "f", args: [] } }]),
      evalFunctionCall,
    }));
    expect(values.n).toBe(1);
    expect(evalFunctionCall).not.toHaveBeenCalled();
  });

  it("re-resolves a column still holding the rewrite-pending sentinel", () => {
    const values: Record<string, ScalarValue> = { n: REWRITE };
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "n", hasDefault: true, defaultExpr: { kind: "literal", value: 3 } }]),
    }));
    expect(values.n).toBe(3);
  });

  it("leaves a __source__ default pending when the referenced field is unresolved", () => {
    const values: Record<string, ScalarValue> = { a: REWRITE };
    applyPendingInsertDefaults(values, baseDeps({
      subjectType: typeWithFields([{ name: "b", hasDefault: true, defaultExprText: "__source__.a + 1" }]),
      // evalSelect would run, but substituteSourceRefs throws first (a is unresolved)
      evalSelect: () => [123],
    }));
    expect("b" in values).toBe(false);
  });
});
