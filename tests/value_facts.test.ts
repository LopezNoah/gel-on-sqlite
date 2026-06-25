import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { inspect, schemaFromSdl } from "../src/compiler/inspect.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { Set as IRSet, IndexExpr, SelectExpr, SliceExpr } from "../src/ir/gel_ir.js";
import {
  isBytesValued,
  isStrValued,
  qualifiedTypeRefName,
  valueFactsOf,
  type ValueFacts,
} from "../src/ir/value_facts.js";

// First-party tests for the value-kind seam (src/ir/value_facts.ts, ADR 0057).
// These are NOT ported from the upstream EdgeQL suite — they pin the *fact*
// SQL lowering consults ("what kind of value is this?") directly, per the
// failure group it was extracted for (the string/bytes index-slice cluster:
// test_edgeql_expr_string_01, _string_09/10/11, _bytes_op_02/03, select_slice_*).
//
// They cross the same compile-inspection seam the golden tests do, so a fact
// here is true of the IR as actually built.

const issues = (): SchemaSnapshot =>
  schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"));

const factsOf = (schema: SchemaSnapshot, query: string): ValueFacts => {
  const r = inspect(schema, query);
  if (!r.ok || !r.facts) throw new Error(`did not compile: ${query} (${r.error?.code} ${r.error?.message})`);
  return r.facts.valueFacts;
};

const resultSetOf = (schema: SchemaSnapshot, query: string): IRSet => {
  const r = inspect(schema, query);
  if (!r.ok || !r.artifact) throw new Error(`did not compile: ${query} (${r.error?.code} ${r.error?.message})`);
  return r.artifact.gelIr.expr;
};

describe("valueFactsOf — string/bytes index & slice failure group", () => {
  const schema = issues();

  // The cluster's defining trap: a bare string literal carries
  // `unknown:std::anyscalar`, and index/slice chains lose the str type — so a
  // typeref-only check under-detects "this is a string", routing it through the
  // JSON-array idiom. The seam answers the kind correctly regardless.
  it.each([
    ["SELECT 'qwerty'", "std::str"],
    ["SELECT 'qwerty'[2]", "std::str"],
    ["SELECT 'qwerty'[-2]", "std::str"],
    ["SELECT 'qwerty'[2:4]", "std::str"],
    ["SELECT 'qwerty'[<int16>2]", "std::str"], // typed-int index (the regression this increment fixed)
    ["SELECT 'qwerty'[0][0]", "std::str"], // chained index
    ["SELECT 'qwerty'[2:][0]", "std::str"], // slice then index
  ])("%s is a std::str scalar", (query, typeName) => {
    const f = factsOf(schema, query);
    expect(f.category).toBe("scalar");
    expect(f.typeName).toBe(typeName);
    expect(isStrValued(resultSetOf(schema, query))).toBe(true);
    expect(isBytesValued(resultSetOf(schema, query))).toBe(false);
  });

  it.each([
    ["SELECT <bytes>b'xy'"],
    ["SELECT (<bytes>b'xy')[1]"],
    ["SELECT (<bytes>b'xy')[0:1]"],
  ])("%s is a std::bytes scalar", (query) => {
    const f = factsOf(schema, query);
    expect(f.category).toBe("scalar");
    expect(f.typeName).toBe("std::bytes");
    expect(isBytesValued(resultSetOf(schema, query))).toBe(true);
    expect(isStrValued(resultSetOf(schema, query))).toBe(false);
  });

  // A real str-typed pointer path (not a literal) is also detected.
  it("a str-typed pointer path is a std::str scalar", () => {
    expect(factsOf(schema, "SELECT Issue.name")).toEqual({ category: "scalar", typeName: "std::str" });
  });
});

describe("valueFactsOf — category coverage", () => {
  const schema = issues();

  it("numeric / bool literals are scalars (category is authoritative even when the typeref is anyscalar)", () => {
    expect(factsOf(schema, "SELECT 1").category).toBe("scalar");
    expect(factsOf(schema, "SELECT 1.5").category).toBe("scalar");
    expect(factsOf(schema, "SELECT true").category).toBe("scalar");
    // a cast pins the concrete scalar type
    expect(factsOf(schema, "SELECT <int64>1")).toEqual({ category: "scalar", typeName: "std::int64" });
  });

  it("array and tuple literals are collections", () => {
    expect(factsOf(schema, "SELECT [1, 2, 3]").collection).toBe("array");
    expect(factsOf(schema, "SELECT (1, 'a')").collection).toBe("tuple");
  });

  it("object sets are objects with their qualified type name", () => {
    expect(factsOf(schema, "SELECT Issue")).toEqual({ category: "object", typeName: "default::Issue" });
  });
});

describe("qualifiedTypeRefName", () => {
  it("uses nameHint verbatim when already qualified", () => {
    expect(qualifiedTypeRefName({ kind: "type_ref", id: "x", nameHint: "std::str", module: "std", isView: false, isScalar: true, isAbstract: false })).toBe("std::str");
  });
  it("joins module + nameHint when the hint is bare", () => {
    expect(qualifiedTypeRefName({ kind: "type_ref", id: "x", nameHint: "Issue", module: "default", isView: false, isScalar: false, isAbstract: false })).toBe("default::Issue");
  });
});

// Regression guard: isStrValued must remain behaviorally identical to the
// inline `isStringValuedSet` it replaced in gel_ir_compiler.ts (ADR 0057).
// This re-creates the deleted helper faithfully and asserts agreement on a
// corpus, so a future change to valueFactsOf that drifts str-detection fails
// here rather than silently in SQL lowering.
describe("isStrValued parity with the retired isStringValuedSet", () => {
  const schema = issues();

  const legacyIsStringValuedSet = (set: IRSet): boolean => {
    let cur: IRSet = set;
    while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
    if (qualifiedTypeRefName(cur.typeref) === "std::str") return true;
    const e = cur.expr;
    if (e.kind === "string_constant") return true;
    if (e.kind === "index_expr") return legacyIsStringValuedSet((e as IndexExpr).expr);
    if (e.kind === "slice_expr") return legacyIsStringValuedSet((e as SliceExpr).expr);
    return false;
  };

  it.each([
    "SELECT 'qwerty'",
    "SELECT 'qwerty'[2]",
    "SELECT 'qwerty'[2:4]",
    "SELECT 'qwerty'[0][0]",
    "SELECT Issue.name",
    "SELECT Issue.name[0]",
    "SELECT 1",
    "SELECT [1, 2, 3]",
    "SELECT Issue",
    "SELECT <bytes>b'xy'",
  ])("agrees on %s", (query) => {
    const set = resultSetOf(schema, query);
    expect(isStrValued(set)).toBe(legacyIsStringValuedSet(set));
  });
});
