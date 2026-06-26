import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectorFor, schemaFromSdl } from "../src/compiler/inspect.js";
import { serializePathId } from "../src/ir/pathid_format.js";
import type { PathId } from "../src/ir/gel_ir.js";

// Live-IR PathIds vs the Gel compiler-fact goldens. This is the tracer-bullet
// slice (ADR-pending): prove the whole seam end-to-end — per-compile
// AliasGenerator → derived-expr minting in `ast_to_ir` → `serializePathId` →
// byte-for-byte match against a real golden — on the simplest derived-expr
// query before widening to object/pointer/view paths.

const inspector = inspectorFor(
  schemaFromSdl(fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8")),
);

interface GoldenPathId {
  expr: string;
  node: string;
  owner: string;
  path_id: string;
  type: string;
}

const loadGolden = (name: string): { query: string; path_ids: GoldenPathId[] } =>
  JSON.parse(
    fs.readFileSync(
      new URL(
        `../goldens/gel-compiler-facts/edgeql_select/TestEdgeQLSelect/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

const goldenPathId = (golden: { path_ids: GoldenPathId[] }, exprName: string): string => {
  const match = golden.path_ids.find((entry) => entry.expr === exprName);
  if (!match) throw new Error(`golden has no path_id for expr ${exprName}`);
  return match.path_id;
};

/** Collect every live-IR `Set` node (pre-order) as {exprKind, serialized pathId}. */
const collectSets = (root: unknown): { exprKind: string; pathId: string }[] => {
  const out: { exprKind: string; pathId: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.kind === "set") {
      const expr = obj.expr as { kind?: string } | undefined;
      out.push({
        exprKind: typeof expr?.kind === "string" ? expr.kind : "",
        pathId: serializePathId(obj.pathId as PathId),
      });
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(root);
  return out;
};

const compile = (query: string): unknown => {
  const r = inspector.inspect(query);
  if (!r.ok || !r.artifact) {
    throw new Error(`did not compile: ${r.error?.code} ${r.error?.message}`);
  }
  return r.artifact.gelIr;
};

describe("PathId Gel parity — derived expression sets", () => {
  it("SELECT 5 IS int64 mints expr~1 (constant) and expr~2 (type-check)", () => {
    const golden = loadGolden("test_edgeql_select_is_01__001");
    const sets = collectSets(compile(golden.query));

    const byExpr = (kind: string): string => {
      const match = sets.find((s) => s.exprKind === kind);
      if (!match) throw new Error(`no Set with expr.kind=${kind}; got ${JSON.stringify(sets)}`);
      return match.pathId;
    };

    // The constant `5` and the `IS` result are both anonymous expression sets.
    // Gel: IntegerConstant → expr~1, TypeCheckOp → expr~2.
    expect(byExpr("integer_constant")).toBe(goldenPathId(golden, "IntegerConstant"));
    expect(byExpr("type_check_op")).toBe(goldenPathId(golden, "TypeCheckOp"));

    // Pin the literal values too, independent of the golden lookup.
    expect(byExpr("integer_constant")).toBe("(__derived__::expr~1)");
    expect(byExpr("type_check_op")).toBe("(__derived__::expr~2)");

    // KNOWN DIVERGENCE: Gel wraps the SelectStmt in a third Set (expr~3); in
    // the live IR the select_stmt IS the Statement (no wrapping Set), so there
    // is no expr~3 counterpart yet. Tracked for the statement-level wiring step.
    expect(sets.some((s) => s.pathId === "(__derived__::expr~3)")).toBe(false);
  });

  it("a fresh compile restarts the expr serial (counter is per-compile)", () => {
    const sets = collectSets(compile("SELECT 5 IS int64;"));
    expect(sets.map((s) => s.pathId).sort()).toEqual([
      "(__derived__::expr~1)",
      "(__derived__::expr~2)",
    ]);
  });
});

/** Every live-IR Set's pathId, rendered with Gel's debug (full mangled pointer
 *  name) form — the form the compiler-fact goldens print. */
const collectDebugPathIds = (root: unknown): string[] => {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.kind === "set" && obj.pathId) {
      out.push(serializePathId(obj.pathId as PathId, { debug: true }));
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(root);
  return out;
};

// The live IR marks pointer-traversal sets as `isPointerPath` (a load-bearing
// concreteness flag read by optional_comparison.ts), so they serialize with a
// trailing `@`. Gel's shape/result sets use the target-path form (no `@`). We
// compare the path *name*, so normalize that one representation difference.
const stripPtr = (s: string): string => (s.endsWith("@") ? s.slice(0, -1) : s);

describe("PathId Gel parity — object & pointer paths (computable_33)", () => {
  const golden = loadGolden("test_edgeql_select_computable_33__001");
  const live = new Set(collectDebugPathIds(compile(golden.query)).map(stripPtr));
  const goldenPaths = golden.path_ids.map((p) => p.path_id);
  const schemaPaths = goldenPaths.filter((p) => !p.includes("__derived__"));
  const derivedPaths = goldenPaths.filter((p) => p.includes("__derived__"));

  it("reproduces the object root and real (multi-step, mangled) pointer paths byte-for-byte", () => {
    // These are the golden's pure-schema path_ids; the debug serializer emits
    // the exact Gel fully-qualified pointer names (`default::__|name@default|User`)
    // and chains `.todo.id` across two steps.
    expect(live.has("(default::User)")).toBe(true);
    expect(live.has("(default::User).>(default::__|name@default|User)[IS std::str]")).toBe(true);
    expect(live.has("(default::User).>(default::__|todo@default|User)[IS default::Issue]")).toBe(true);
    expect(
      live.has(
        "(default::User).>(default::__|todo@default|User)[IS default::Issue]" +
          ".>(default::__|id@default|Issue)[IS std::uuid]",
      ),
    ).toBe(true);
  });

  it("KNOWN GAP: the implicit `id` shape element is not materialized as its own set", () => {
    const idPath = "(default::User).>(default::__|id@default|User)[IS std::uuid]";
    expect(schemaPaths).toContain(idPath); // the golden has it…
    expect(live.has(idPath)).toBe(false); // …the live IR does not (yet).
  });

  it("KNOWN GAP: computed `todo_ids` is inlined, so the @view~1 derived names never appear", () => {
    // Gel keeps `todo_ids := .todo.id` as a derived pointer on a view type,
    // whose name carries `&view~1`. The live IR inlines the computed body to a
    // plain `.todo.id` chain, erasing the view boundary — so none of the
    // golden's `__derived__`/`view~` path_ids are produced.
    expect(derivedPaths.some((p) => p.includes("view~"))).toBe(true); // golden has them
    for (const d of derivedPaths) expect(live.has(d)).toBe(false); // live IR has none
  });
});
