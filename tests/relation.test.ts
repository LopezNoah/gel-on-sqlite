import { beforeEach, describe, expect, it } from "vitest";
import {
  PathNotResolvable,
  Relation,
  pathIdKeyOf,
  resetInjectionCounter,
  scopeKeyOf,
} from "../src/sql/relation.js";

// Beachhead tests for the pathctx-style Relation/PathRegistry (src/sql/relation.ts).
//
// Each test maps to a correlation pattern the SQL backend hand-threads today via
// GelIRCompileOptions knobs (see failing-query-groups.md). The point is to show
// that ONE operation — Relation.getPathVar(pathKey, aspect) — answers the three
// structurally-distinct correlation questions that are three separate code paths
// in gel_ir_compiler.ts, and that recursive column injection (impossible with
// string emission) falls out of the mutable relation tree.

beforeEach(() => resetInjectionCounter());

describe("PathRegistry — question (1): column on the current iteration row", () => {
  it("a registered path resolves to its range-var column", () => {
    const r = new Relation();
    r.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    r.registerPath("Card.name", "value", 'g0."name"');

    expect(r.getPathVar("Card.name", "value")).toBe('g0."name"');
  });

  it("serializes to a single runnable SELECT", () => {
    const r = new Relation();
    r.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    r.addOutput("name", 'g0."name"');
    expect(r.toSql().sql).toBe('SELECT g0."name" AS "name" FROM "default__card" g0');
  });
});

describe("PathRegistry — shared-prefix correlation (scope_computables_08)", () => {
  // `count((Card.owners.name, Card.owners.deck_cost))` — both tuple elements
  // share the `Card.owners` prefix. Today the shared-prefix correlation is
  // dropped (engine emits a degenerate `SELECT NULL AS "id"`). With a registry,
  // the prefix is registered ONCE and both leaves resolve through the same range
  // var, so they stay zipped instead of forming a cross product.
  it("two leaves sharing a prefix resolve through ONE range var", () => {
    const r = new Relation();
    r.addRangeVar({ alias: "a0", sourceSql: '"default__card"' });
    // Card.owners := .<deck[IS User] — registered once as a joined range var.
    r.addRangeVar({
      alias: "a1",
      sourceSql: '"default__user"',
      join: { kind: "inner", on: 'a1."id" = lj."source"' },
    });
    r.registerPath("Card.owners", "identity", 'a1."id"');
    r.registerPath("Card.owners.name", "value", 'a1."name"');
    r.registerPath("Card.owners.deck_cost", "value", "/* sum(...) correlated to a1 */");

    // Both leaves point at the SAME owners alias a1 — they are zipped, not crossed.
    expect(r.getPathVar("Card.owners.name", "value")).toContain("a1.");
    expect(r.getPathVar("Card.owners.deck_cost", "value")).toContain("a1");
    expect(r.getPathVar("Card.owners", "identity")).toBe('a1."id"');
  });
});

describe("PathRegistry — recursive column injection (#5, the string-emission gap)", () => {
  // A parent needs a path the child subquery did not originally project. With a
  // mutable relation the parent makes the child EXPOSE it, then pulls it through
  // the range var. String concatenation cannot do this — the subquery text is
  // already serialized by the time the parent discovers it needs the column.
  it("parent injects a column into a child subquery and references it", () => {
    const child = new Relation();
    child.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    child.registerPath("Card.cost", "value", 'g0."cost"');
    // child only projects id at first:
    child.addOutput("id", 'g0."id"');

    const parent = new Relation();
    parent.addRangeVar({ alias: "sub", sourceSql: "", relation: child });

    // Parent needs Card.cost, which child can compute but did not expose.
    const ref = parent.getPathVar("Card.cost", "value");
    expect(ref).toBe('sub."__inj0"');

    // The child subquery now projects the injected column.
    expect(child.toSql().sql).toContain('g0."cost" AS "__inj0"');
    // And the parent serializes the child as a subquery range var.
    expect(parent.toSql().sql).toMatch(/FROM \(SELECT .* FROM "default__card" g0\) sub/);
  });

  it("injecting the same path twice reuses one column (idempotent)", () => {
    const child = new Relation();
    child.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    child.registerPath("Card.cost", "value", 'g0."cost"');
    const parent = new Relation();
    parent.addRangeVar({ alias: "sub", sourceSql: "", relation: child });

    const a = parent.getPathVar("Card.cost", "value");
    const b = parent.getPathVar("Card.cost", "value");
    expect(a).toBe(b);
    // Only one injected column exists.
    expect(child.toSql().sql.match(/__inj0/g)?.length).toBe(1);
    expect(child.toSql().sql).not.toContain("__inj1");
  });
});

describe("PathRegistry — question (2)/(3): correlation to an enclosing scope", () => {
  it("an inner relation correlates a path up to its parent's range var", () => {
    // SELECT Card { foo := (SELECT ... FILTER ... = Card.name) } — the inner
    // subquery's fresh Card.name resolves to the OUTER row's column.
    const outer = new Relation();
    outer.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    outer.registerPath("Card.name", "value", 'g0."name"');

    const inner = new Relation(outer);
    inner.addRangeVar({ alias: "g1", sourceSql: '"default__award"' });

    // Inner has no Card source of its own → correlates to the parent.
    expect(inner.getPathVar("Card.name", "value")).toBe('g0."name"');
  });

  it("correlateScope resolves a fresh type-root reference outward by typeref+namespace", () => {
    const outer = new Relation();
    outer.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    const cardScope = scopeKeyOf({ id: "uuid-card" }, []);
    outer.registerScope(cardScope, "g0");

    const inner = new Relation(outer);
    expect(inner.correlateScope(cardScope)).toBe("g0");
    expect(inner.correlateScope(scopeKeyOf({ id: "uuid-user" }, []))).toBeNull();
  });

  it("throws PathNotResolvable when no scope can produce the path", () => {
    const r = new Relation();
    r.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    expect(() => r.getPathVar("User.email", "value")).toThrow(PathNotResolvable);
  });
});

describe("PathRegistry — aspects (one path, multiple views)", () => {
  it("value / serialized / identity of the same path resolve independently", () => {
    const r = new Relation();
    r.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    r.registerPath("Card", "identity", 'g0."id"');
    r.registerPath("Card", "value", 'g0."id"');
    r.registerPath("Card", "serialized", "json_object('id', g0.\"id\", 'name', g0.\"name\")");

    expect(r.getPathVar("Card", "identity")).toBe('g0."id"');
    expect(r.getPathVar("Card", "serialized")).toContain("json_object");
    // a missing aspect is not silently the value aspect:
    expect(r.tryGetPathVar("Card", "serialized")).not.toBe(r.getPathVar("Card", "identity"));
  });
});

describe("path keys match the backend's pathIdKey", () => {
  it("pathIdKeyOf is JSON.stringify of the IR PathId (same as gel_ir_compiler.pathIdKey)", () => {
    const pathId = {
      kind: "path_id" as const,
      namespace: [],
      isPointerPath: true,
      steps: [],
    };
    expect(pathIdKeyOf(pathId)).toBe(JSON.stringify(pathId));
  });
});
