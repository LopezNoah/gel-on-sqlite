import { describe, expect, it } from "vitest";

import { compileToIR } from "../src/compiler/semantic.js";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { AppError } from "../src/errors.js";
import { SchemaSnapshot } from "../src/schema/schema.js";

const schema = new SchemaSnapshot([
  {
    module: "default",
    name: "User",
    fields: [
      { name: "name", type: "str", required: true },
      { name: "active", type: "bool" },
      { name: "meta", type: "json" },
      { name: "manager_id", type: "uuid" },
    ],
    links: [{ name: "manager", targetType: "default::User" }],
  },
  {
    module: "default",
    name: "Comment",
    fields: [
      { name: "body", type: "str", required: true },
      { name: "author_id", type: "uuid", required: true },
    ],
    links: [{ name: "author", targetType: "default::User" }],
  },
  {
    module: "analytics",
    name: "User",
    fields: [{ name: "name", type: "str", required: true }],
  },
  {
    module: "default",
    name: "Person",
    abstract: true,
    fields: [{ name: "name", type: "str", required: true }],
  },
  {
    module: "default",
    name: "Hero",
    extends: ["default::Person"],
    fields: [
      { name: "name", type: "str", required: true },
      { name: "secret_identity", type: "str" },
    ],
    links: [{ name: "villains", targetType: "default::Villain", multi: true }],
  },
  {
    module: "default",
    name: "Villain",
    extends: ["default::Person"],
    fields: [
      { name: "name", type: "str", required: true },
      { name: "rank", type: "int" },
    ],
    links: [{ name: "nemesis", targetType: "default::Hero" }],
  },
  {
    module: "default",
    name: "Movie",
    fields: [{ name: "title", type: "str", required: true }],
    links: [{ name: "characters", targetType: "default::Person", multi: true }],
  },
]);

describe("semantic compiler", () => {
  it("[SPEC-021.R3][SPEC-001.R3] returns classified semantic errors with location", () => {
    const ast = parseEdgeQL("insert default::User {};");

    let error: unknown;
    try {
      compileToIR(schema, ast);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("E_SEMANTIC");
    expect(appError.message).toContain("Missing required field 'name'");
    expect(appError.line).toBe(1);
    expect(appError.column).toBe(1);
  });

  it("[SPEC-021.R2] rejects scalar type mismatches", () => {
    const ast = parseEdgeQL("insert default::User { active := 1, name := 'Ari' };");
    expect(() => compileToIR(schema, ast)).toThrow(/Type mismatch for 'active': expected bool/);
  });

  it("[SPEC-PARITY-INSERT.S1] rejects inserts into abstract types", () => {
    const ast = parseEdgeQL("insert default::Person { name := 'Nope' }; ");
    expect(() => compileToIR(schema, ast)).toThrow(/cannot insert into abstract object type/);
  });

  it("[SPEC-021.R2] validates bool/json payload types", () => {
    const badBool = parseEdgeQL("update default::User filter name = 'Ari' set { active := 1 };");
    expect(() => compileToIR(schema, badBool)).toThrow(/Type mismatch for 'active': expected bool/);

    const badJson = parseEdgeQL("update default::User filter name = 'Ari' set { meta := 'not json' };");
    expect(() => compileToIR(schema, badJson)).toThrow(/Type mismatch for 'meta': expected json/);
  });

  it("[SPEC-034.R9][SPEC-034.R10] compiles computed fields and backlinks into shape IR", () => {
    const ast = parseEdgeQL("select default::User { id, nick := .name, comments := .<author[is default::Comment] };");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.columns).toEqual(["id", "name"]);
    expect(ir.pathId).toMatch(/^p\d+$/);
    expect(ir.typeRef).toEqual({ name: "default::User", table: "default__user" });
    expect(ir.scopeTree.pathId).toBe(ir.pathId);
    expect(ir.inference).toEqual({ cardinality: "many", multiplicity: "unique", volatility: "immutable" });
    expect(ir.shape).toHaveLength(3);
    expect(ir.shape[0]).toEqual(expect.objectContaining({ kind: "field", name: "id", column: "id" }));
    expect(ir.shape[1]).toEqual(
      expect.objectContaining({ kind: "computed", name: "nick", expr: { kind: "field_ref", column: "name" } }),
    );
    expect(ir.shape[2]).toEqual(
      expect.objectContaining({
        kind: "backlink",
        name: "comments",
        sources: [
          {
            sourceType: "default::Comment",
            table: "default__comment",
            storage: "inline",
            inlineColumn: "author_id",
          },
        ],
      }),
    );
  });

  it("[SPEC-034.R17] rejects unknown backlinks", () => {
    const ast = parseEdgeQL("select default::User { broken := .<owner };");
    expect(() => compileToIR(schema, ast)).toThrow(/Unknown backlink '.<owner'/);
  });

  it("[SPEC-034.R6][SPEC-034.R7][SPEC-034.R8] compiles nested links with scoped clauses", () => {
    const ast = parseEdgeQL(
      "select default::User { name, manager { id, manager_name := .name } filter name = 'Ari' order by name asc limit 1 };",
    );
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.shape).toHaveLength(2);
    expect(ir.shape[0]).toEqual(expect.objectContaining({ kind: "field", name: "name", column: "name" }));
    expect(ir.shape[1]).toEqual(
      expect.objectContaining({
        kind: "link",
        name: "manager",
        relation: {
          sourceType: "default::User",
          targetType: "default::User",
          targetTable: "default__user",
          targetTables: [{ name: "default::User", table: "default__user" }],
          storage: "inline",
          inlineColumn: "manager_id",
          linkTable: undefined,
        },
        typeFilter: undefined,
        columns: ["id", "name"],
        filter: { kind: "field", column: "name", op: "=", value: "Ari" },
        orderBy: { column: "name", direction: "asc" },
        limit: 1,
        offset: undefined,
        inference: { cardinality: "at_most_one", multiplicity: "unique", volatility: "immutable" },
      }),
    );
  });

  it("[SPEC-023.R1][SPEC-023.R2][SPEC-023.R3] propagates deterministic inference metadata", () => {
    const ast = parseEdgeQL("select default::User { id, name } filter id = 'fixed' limit 1;");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.inference).toEqual({ cardinality: "at_most_one", multiplicity: "unique", volatility: "immutable" });
  });

  it("[SPEC-022.R2][SPEC-022.R3] emits stable path ids and scope tree", () => {
    const ast = parseEdgeQL("select default::User { id, manager { id } }; ");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.pathId).toBe("p0");
    expect(ir.scopeTree.pathId).toBe("p0");
    expect(ir.scopeTree.children.length).toBeGreaterThan(0);
    expect(ir.shape.every((element) => element.pathId.startsWith("p0."))).toBe(true);
  });

  it("[SPEC-034.R6] expands splats into fields and one-level links", () => {
    const ast = parseEdgeQL("select default::Person { name, [is default::Hero].** };");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.shape).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "field", name: "name", column: "name" }),
        expect.objectContaining({
          kind: "computed",
          name: "id",
          expr: { kind: "polymorphic_field_ref", sourceType: "default::Hero", column: "id" },
        }),
        expect.objectContaining({
          kind: "computed",
          name: "secret_identity",
          expr: { kind: "polymorphic_field_ref", sourceType: "default::Hero", column: "secret_identity" },
        }),
        expect.objectContaining({
          kind: "link",
          name: "villains",
          sourceTypeFilter: "default::Hero",
        }),
      ]),
    );
  });

  it("[SPEC-034.S21] resolves with-block aliases in select filters", () => {
    const ast = parseEdgeQL("with user_name := 'Ari' select default::User { id, name } filter .name = user_name;");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.filter).toEqual({ kind: "field", column: "name", op: "=", value: "Ari" });
  });

  it("[SPEC-PARITY-WITH.S1] resolves with-block subquery aliases as select sources", () => {
    const ast = parseEdgeQL(
      "with active_users := (select default::User filter .active = true) select active_users { id, name } order by name asc;",
    );
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.typeRef).toEqual({ name: "default::User", table: "default__user" });
    expect(ir.filter).toEqual({ kind: "field", column: "active", op: "=", value: true });
    expect(ir.orderBy).toEqual({ column: "name", direction: "asc" });
  });

  it("[SPEC-PARITY-WITH.S2] resolves with query parameters from compile globals", () => {
    const ast = parseEdgeQL("with user_name := <str>$user_name select default::User { id } filter .name = user_name;");
    const ir = compileToIR(schema, ast, { globals: { user_name: "Ari" } });
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.filter).toEqual({ kind: "field", column: "name", op: "=", value: "Ari" });
  });

  it("[SPEC-PARITY-WITH.S3] resolves module aliases in type references", () => {
    const ast = parseEdgeQL("with d as module default select d::User { id }; ");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.typeRef).toEqual({ name: "default::User", table: "default__user" });
  });

  it("[SPEC-PARITY-WITH.S4] applies with module as active module for short names", () => {
    const ast = parseEdgeQL("with module analytics select User { name }; ");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.typeRef).toEqual({ name: "analytics::User", table: "analytics__user" });
  });

  it("[SPEC-034.S5] compiles filter operators into IR", () => {
    const ast = parseEdgeQL("select default::User { id, name } filter .name ilike '%ari%';");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.filter).toEqual({ kind: "field", column: "name", op: "ilike", value: "%ari%" });
  });

  it("[SPEC-034.S5] compiles boolean filter trees", () => {
    const ast = parseEdgeQL(
      "select default::User { id, name } filter (.name like '%a%') and not (.active = false) or .id = 'fixed';",
    );
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.filter).toEqual({
      kind: "or",
      left: {
        kind: "and",
        left: { kind: "field", column: "name", op: "like", value: "%a%" },
        right: {
          kind: "not",
          expr: { kind: "field", column: "active", op: "=", value: false },
        },
      },
      right: { kind: "field", column: "id", op: "=", value: "fixed" },
    });
  });

  it("[SPEC-034.R17] rejects like/ilike on non-str fields", () => {
    const ast = parseEdgeQL("select default::User { id } filter .active like '%t%';");
    expect(() => compileToIR(schema, ast)).toThrow(/requires str field/);
  });

  it("[SPEC-034.R17] rejects unknown with-block aliases", () => {
    const ast = parseEdgeQL("with user_name := 'Ari' select default::User { id } filter .name = missing_alias;");
    expect(() => compileToIR(schema, ast)).toThrow(/Unknown with binding 'missing_alias'/);
  });

  it("[SPEC-034.S8] compiles known-backlink filters into IR sources", () => {
    const ast = parseEdgeQL("select default::User { id, name } filter .<author[is default::Comment] = 'comment-1';");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.filter).toEqual({
      kind: "backlink",
      op: "=",
      value: "comment-1",
      sources: [
        {
          sourceType: "default::Comment",
          table: "default__comment",
          storage: "inline",
          inlineColumn: "author_id",
        },
      ],
    });
  });

  it("[SPEC-034.S20] compiles free-object selects with nested select entries", () => {
    const ast = parseEdgeQL("select { answer := 42, users := default::User { id, name } order by name asc }; ");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select_free") {
      throw new Error("expected free-object IR");
    }

    expect(ir.entries).toEqual([
      { kind: "literal", name: "answer", value: 42 },
      {
        kind: "select",
        name: "users",
        query: expect.objectContaining({ kind: "select", orderBy: { column: "name", direction: "asc" } }),
      },
    ]);
  });

  it("[SPEC-034.S16] resolves polymorphic target tables for abstract link targets", () => {
    const ast = parseEdgeQL("select default::Movie { title, characters { name } };");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    const characters = ir.shape.find((entry) => entry.kind === "link" && entry.name === "characters");
    expect(characters).toEqual(
      expect.objectContaining({
        kind: "link",
        relation: expect.objectContaining({
          targetType: "default::Person",
          targetTables: [
            { name: "default::Hero", table: "default__hero" },
            { name: "default::Villain", table: "default__villain" },
          ],
        }),
      }),
    );
  });

  it("[SPEC-034.S18] narrows polymorphic link targets by subtype filter", () => {
    const ast = parseEdgeQL("select default::Movie { characters[is default::Hero] { secret_identity } }; ");
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    const characters = ir.shape.find((entry) => entry.kind === "link" && entry.name === "characters");
    expect(characters).toEqual(
      expect.objectContaining({
        kind: "link",
        typeFilter: "default::Hero",
        relation: expect.objectContaining({
          targetType: "default::Hero",
          targetTables: [{ name: "default::Hero", table: "default__hero" }],
        }),
        shape: [expect.objectContaining({ kind: "field", name: "secret_identity" })],
      }),
    );
  });

  it("[SPEC-034.S7] compiles nested filters with scoped fields", () => {
    const ast = parseEdgeQL(
      "select default::Hero { name, villains { name } filter .name like '%O%' } filter .name ilike '%man';",
    );
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    const villains = ir.shape.find((entry) => entry.kind === "link" && entry.name === "villains");
    expect(ir.filter).toEqual({ kind: "field", column: "name", op: "ilike", value: "%man" });
    expect(villains).toEqual(
      expect.objectContaining({
        kind: "link",
        filter: { kind: "field", column: "name", op: "like", value: "%O%" },
      }),
    );
  });

  it("[SPEC-034.S14] compiles computed subquery expressions", () => {
    const ast = parseEdgeQL(
      "select default::Villain { name, heroes := (select default::Hero { name } order by name asc limit 1) };",
    );
    const ir = compileToIR(schema, ast);
    if (ir.kind !== "select") {
      throw new Error("expected select IR");
    }

    expect(ir.shape).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "computed", name: "heroes", expr: expect.objectContaining({ kind: "subquery" }) }),
      ]),
    );
  });

  it("[SPEC-033.R2][SPEC-033.R3] emits deterministic overlay operations for DML", () => {
    const insert = compileToIR(schema, parseEdgeQL("insert default::User { name := 'Ari' };"));
    const update = compileToIR(schema, parseEdgeQL("update default::User filter name = 'Ari' set { name := 'Aria' };"));
    const del = compileToIR(schema, parseEdgeQL("delete default::User filter name = 'Aria';"));

    if (insert.kind !== "insert" || update.kind !== "update" || del.kind !== "delete") {
      throw new Error("expected DML IR");
    }

    expect(insert.overlays[0].operation).toBe("union");
    expect(update.overlays[0].operation).toBe("replace");
    expect(del.overlays[0].operation).toBe("exclude");
    expect(insert.overlays[0].policyPhase).toBe("none");
    expect(update.overlays[0].rewritePhase).toBe("none");
  });

  it("[SPEC-021.R2] rejects manual id assignment", () => {
    const insert = parseEdgeQL("insert default::User { id := 'manual', name := 'Ari' };");
    expect(() => compileToIR(schema, insert)).toThrow(/'id' is server-generated and cannot be assigned/);

    const update = parseEdgeQL("update default::User filter name = 'Ari' set { id := 'manual' };");
    expect(() => compileToIR(schema, update)).toThrow(/'id' is server-generated and cannot be assigned/);
  });
});
