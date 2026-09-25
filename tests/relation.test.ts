import { beforeEach, describe, expect, it } from "vitest";
import {
  PathNotResolvable,
  Relation,
  pathIdKeyOf,
  resetInjectionCounter,
  scopeKeyOf,
} from "../src/sql/relation.js";
import { sql, sqlBinding } from "../src/sql/sql_ast.js";
import Database from "better-sqlite3";

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
    expect(r.toSql().sql).toBe('SELECT g0."name" AS "name" FROM "default__card" "g0"');
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
    expect(ref).toBe('"sub"."__inj0"');

    // The child subquery now projects the injected column.
    expect(child.toSql().sql).toContain('g0."cost" AS "__inj0"');
    // And the parent serializes the child as a subquery range var.
    expect(parent.toSql().sql).toMatch(/FROM \(SELECT .* FROM "default__card" "g0"\) "sub"/);
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

describe("path_rvar_map — which range var provides a path (Gel pgast.path_rvar_map)", () => {
  it("registerPathRvar / getPathRvar round-trips", () => {
    const r = new Relation();
    const rv = r.addRangeVar({ alias: "a1", sourceSql: '"default__user"' });
    r.registerPathRvar("Card.owners", "value", rv);
    expect(r.getPathRvar("Card.owners", "value")).toBe(rv);
    expect(r.getPathRvar("Card.owners", "identity")).toBeNull();
    expect(r.getPathRvar("Card.name", "value")).toBeNull();
  });

  it("getPathVar injects into the rvar registered for the path, not a sibling that could also provide it", () => {
    // Two child subqueries can both compute Card.cost. Without an rvar map,
    // getPathVar would scan and inject into the FIRST (`s0`). With the map, it
    // resolves through the registered provider (`s1`) — Gel's put_path_rvar.
    const childA = new Relation();
    childA.addRangeVar({ alias: "g0", sourceSql: '"default__card"' });
    childA.registerPath("Card.cost", "value", 'g0."cost"');
    const childB = new Relation();
    childB.addRangeVar({ alias: "g1", sourceSql: '"default__card"' });
    childB.registerPath("Card.cost", "value", 'g1."cost"');

    const parent = new Relation();
    parent.addRangeVar({ alias: "s0", sourceSql: "", relation: childA });
    const rvB = parent.addRangeVar({ alias: "s1", sourceSql: "", relation: childB });
    parent.registerPathRvar("Card.cost", "value", rvB);

    expect(parent.getPathVar("Card.cost", "value")).toBe('"s1"."__inj0"');
    // The chosen provider exposed the column; the sibling was left untouched.
    expect(childB.toSql().sql).toContain('g1."cost" AS "__inj0"');
    expect(childA.toSql().sql).not.toContain("__inj0");
  });
});

describe("Relation SQL AST lowering", () => {
  it("owns projection, legacy source, and predicate parameters in SQL order", () => {
    const relation = new Relation();
    const source = relation.addRangeVar({
      alias: "s",
      sourceSql: '(SELECT ? AS "value")',
      columns: ["value"],
      params: ["from"],
    });
    relation.addOutputExpr("label", sql.parameter("select"));
    relation.addWhereExpr(
      sql.binary(">", sql.call("length", sql.column(source.binding, "value")), sql.parameter(0)),
    );

    const built = relation.toSql();
    expect(built).toEqual({
      sql: 'SELECT ? AS "label" FROM (SELECT ? AS "value") "s" WHERE (length("s"."value") > ?)',
      params: ["select", "from", 0],
    });

    const db = new Database(":memory:");
    try {
      expect(db.prepare(built.sql).all(...built.params)).toEqual([{ label: "select" }]);
    } finally {
      db.close();
    }
  });

  it("renders and executes link-property projections through a junction-table join", () => {
    const relation = new Relation();
    const user = relation.addRangeVar({
      alias: "u",
      table: { name: "users", columns: ["id", "name"] },
    });
    const deckBinding = sqlBinding("d");
    const deck = relation.addRangeVar({
      alias: "d",
      binding: deckBinding,
      table: { name: "user_deck", columns: ["source", "target", "count"] },
      join: {
        kind: "inner",
        onExpr: sql.binary("=", sql.column(deckBinding, "source"), sql.column(user.binding, "id")),
      },
    });
    const cardBinding = sqlBinding("c");
    const card = relation.addRangeVar({
      alias: "c",
      binding: cardBinding,
      table: { name: "cards", columns: ["id", "name"] },
      join: {
        kind: "inner",
        onExpr: sql.binary("=", sql.column(cardBinding, "id"), sql.column(deck.binding, "target")),
      },
    });
    relation.addOutputExpr("user", sql.column(user.binding, "name"));
    relation.addOutputExpr("card", sql.column(card.binding, "name"));
    relation.addOutputExpr("@count", sql.column(deck.binding, "count"));
    relation.addWhereExpr(sql.binary(">=", sql.column(deck.binding, "count"), sql.parameter(2)));

    const built = relation.toSql();
    expect(built.params).toEqual([2]);

    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE users (id INTEGER, name TEXT); CREATE TABLE user_deck (source INTEGER, target INTEGER, count INTEGER); CREATE TABLE cards (id INTEGER, name TEXT);",
      );
      db.exec(
        "INSERT INTO users VALUES (1, 'Ada'); INSERT INTO cards VALUES (10, 'Dragon'), (11, 'Imp'); INSERT INTO user_deck VALUES (1, 10, 3), (1, 11, 1);",
      );
      expect(db.prepare(built.sql).all(...built.params)).toEqual([
        { user: "Ada", card: "Dragon", "@count": 3 },
      ]);
    } finally {
      db.close();
    }
  });

  it("recursively injects a typed path as a derived-table export", () => {
    const child = new Relation();
    const row = child.addRangeVar({
      alias: "c",
      table: { name: "cards", columns: ["id", "cost"] },
    });
    child.registerPathExpr("Card.cost", "value", sql.column(row.binding, "cost"));
    child.addOutputExpr("id", sql.column(row.binding, "id"));

    const parent = new Relation();
    const source = parent.addRangeVar({ alias: "src", sourceSql: "", relation: child });
    parent.addOutputExpr("cost", parent.getPathExpr("Card.cost", "value"));

    const built = parent.toSql();
    expect(built.sql).toContain('"src"."__inj0" AS "cost"');
    expect(built.sql).toContain('"c"."cost" AS "__inj0"');

    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE cards (id INTEGER, cost INTEGER); INSERT INTO cards VALUES (1, 5), (2, 9);",
      );
      expect(db.prepare(built.sql).all(...built.params)).toEqual([{ cost: 5 }, { cost: 9 }]);
    } finally {
      db.close();
    }
  });
});

describe("PathRegistry — question (2)/(3): correlation to an enclosing scope", () => {
  it("a child's own scope SHADOWS a parent scope of the same key (detached subquery)", () => {
    // The structural fact select_subqueries_04 relies on: `EXISTS (SELECT Issue
    // FILTER Issue.number = …)` where `sub` is WITH-bound. The inner `Issue`
    // must read the inner range var (ex0), NOT the outer one (g0) that the
    // inlined path id still points at. Local registration wins over the parent.
    const outer = new Relation();
    const issueScope = scopeKeyOf({ id: "uuid-issue" }, []);
    outer.registerScope(issueScope, "g0");

    const inner = new Relation(outer);
    inner.registerScope(issueScope, "ex0");

    expect(inner.correlateScope(issueScope)).toBe("ex0"); // inner shadows outer
    expect(outer.correlateScope(issueScope)).toBe("g0"); // outer still resolves itself
  });

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

  it("aggregate scope lookup ignores ordinary and enclosing source scopes", () => {
    const outer = new Relation();
    const cardScope = scopeKeyOf({ id: "uuid-card" }, []);
    outer.registerScope(cardScope, "g0");

    const inner = new Relation(outer);
    expect(inner.correlateScope(cardScope)).toBe("g0");
    expect(inner.correlateAggregateScope(cardScope)).toBeNull();

    inner.registerAggregateScope(cardScope, "g1");
    expect(inner.correlateAggregateScope(cardScope)).toBe("g1");
    expect(inner.correlateScope(cardScope)).toBe("g1");
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

  it("keeps row providers and iterator values as distinct aspects", () => {
    const outer = new Relation();
    outer.registerPath("Item.tags", "source", "g0");

    const inner = new Relation(outer);
    inner.registerPath("Item.tags", "iterator", 'je."value"');

    expect(inner.getPathVar("Item.tags", "source")).toBe("g0");
    expect(inner.getPathVar("Item.tags", "iterator")).toBe('je."value"');
    expect(inner.hasAlias("g0")).toBe(true);
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
