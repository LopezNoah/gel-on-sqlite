import { describe, expect, it } from "vitest";

import { parseEdgeQL, parseEdgeQLScript } from "../src/edgeql/parser.js";

describe("parseEdgeQL", () => {
  it("[SPEC-020.R1] parses a select with filter, ordering, and pagination", () => {
    const ast = parseEdgeQL("select default::User { id, name } filter id = 1 order by name desc offset 10 limit 5;");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.typeName).toBe("default::User");
    expect(ast.shape).toEqual([
      { kind: "field", name: "id" },
      { kind: "field", name: "name" },
    ]);
    expect(ast.fields).toEqual(["id", "name"]);
    expect(ast.filter).toEqual({ kind: "predicate", target: { kind: "field", field: "id" }, op: "=", value: 1 });
    expect(ast.orderBy).toEqual({ field: "name", direction: "desc" });
    expect(ast.limit).toBe(5);
    expect(ast.offset).toBe(10);
  });

  it("[SPEC-034.S1] parses object selection without an explicit shape", () => {
    const ast = parseEdgeQL("select default::User filter id = 'u1' order by id asc limit 1;");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.shape).toEqual([{ kind: "field", name: "id" }]);
    expect(ast.fields).toEqual(["id"]);
    expect(ast.filter).toEqual({ kind: "predicate", target: { kind: "field", field: "id" }, op: "=", value: "u1" });
    expect(ast.orderBy).toEqual({ field: "id", direction: "asc" });
    expect(ast.limit).toBe(1);
  });

  it("[SPEC-034.S21] parses with-block aliases and filter binding refs", () => {
    const ast = parseEdgeQL("with hero_name := 'Iron Man' select default::Hero { secret_identity } filter .name = hero_name;");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.with).toEqual([{ name: "hero_name", value: { kind: "literal", value: "Iron Man" } }]);
    expect(ast.filter).toEqual({
      kind: "predicate",
      target: { kind: "field", field: "name" },
      op: "=",
      value: { kind: "binding_ref", name: "hero_name" },
    });
  });

  it("[SPEC-034.S5] parses filter operators (!=, like, ilike)", () => {
    const notEq = parseEdgeQL("select default::User { id } filter .name != 'Ari';");
    const like = parseEdgeQL("select default::User { id } filter .name like '%ri%';");
    const ilike = parseEdgeQL("select default::User { id } filter default::User.name ilike '%RI%';");
    if (notEq.kind !== "select" || like.kind !== "select" || ilike.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(notEq.filter).toEqual({ kind: "predicate", target: { kind: "field", field: "name" }, op: "!=", value: "Ari" });
    expect(like.filter).toEqual({ kind: "predicate", target: { kind: "field", field: "name" }, op: "like", value: "%ri%" });
    expect(ilike.filter).toEqual({ kind: "predicate", target: { kind: "field", field: "name" }, op: "ilike", value: "%RI%" });
  });

  it("[SPEC-020.R1] parses update and delete statements", () => {
    const update = parseEdgeQL("update default::User filter id = 1 set { name := 'Ari', active := true };");
    if (update.kind !== "update") {
      throw new Error("expected update AST");
    }

    expect(update.filter).toEqual({ kind: "predicate", target: { kind: "field", field: "id" }, op: "=", value: 1 });
    expect(update.values).toEqual({ name: "Ari", active: true });

    const del = parseEdgeQL("delete default::User filter id = 1;");
    if (del.kind !== "delete") {
      throw new Error("expected delete AST");
    }

    expect(del.filter).toEqual({ kind: "predicate", target: { kind: "field", field: "id" }, op: "=", value: 1 });
  });

  it("[SPEC-PARITY-INSERT.S2][SPEC-PARITY-INSERT.S3] parses insert link subqueries and nested inserts", () => {
    const ast = parseEdgeQL(
      "insert default::Villain { name := 'The Mandarin', nemesis := (insert default::Hero { name := 'Shang-Chi' }) };",
    );
    if (ast.kind !== "insert") {
      throw new Error("expected insert AST");
    }

    expect(ast.values).toEqual({
      name: "The Mandarin",
      nemesis: {
        kind: "insert",
        typeName: "default::Hero",
        values: {
          name: "Shang-Chi",
        },
      },
    });
  });

  it("[SPEC-PARITY-INSERT.S5][SPEC-PARITY-INSERT.S6][SPEC-PARITY-INSERT.S7] parses insert conflict clauses", () => {
    const ast = parseEdgeQL(
      "insert default::Movie { title := 'Eternals', release_year := 2021 } unless conflict on .title else (update default::Movie set { release_year := 2022 });",
    );
    if (ast.kind !== "insert") {
      throw new Error("expected insert AST");
    }

    expect(ast.conflict).toEqual({
      onField: "title",
      else: {
        kind: "update",
        typeName: "default::Movie",
        values: {
          release_year: 2022,
        },
      },
    });
  });

  it("[SPEC-020.R2] reports syntax location", () => {
    expect(() => parseEdgeQL("select default::User { id name };")).toThrow(/Expected ',' between shape entries/);
  });

  it("[SPEC-034.R9][SPEC-034.R10] parses computed fields and backlinks", () => {
    const ast = parseEdgeQL(
      "select default::User { name, nick := .name, role := 'reader', comments := .<author[is default::Comment] };",
    );
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.shape).toEqual([
      { kind: "field", name: "name" },
      { kind: "computed", name: "nick", expr: { kind: "field_ref", field: "name" } },
      { kind: "computed", name: "role", expr: { kind: "literal", value: "reader" } },
      {
        kind: "backlink",
        name: "comments",
        expr: { link: "author", sourceType: "default::Comment" },
      },
    ]);
  });

  it("[SPEC-034.R6][SPEC-034.R8] parses nested link shapes with link-level clauses", () => {
    const ast = parseEdgeQL(
      "select default::User { name, manager[is default::User] { id, nick := .name } filter name = 'Ari' order by name asc limit 1 } order by name asc;",
    );
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.shape).toEqual([
      { kind: "field", name: "name" },
      {
        kind: "link",
        name: "manager",
        typeFilter: "default::User",
        shape: [
          { kind: "field", name: "id" },
          { kind: "computed", name: "nick", expr: { kind: "field_ref", field: "name" } },
        ],
        clauses: {
          filter: { kind: "predicate", target: { kind: "field", field: "name" }, op: "=", value: "Ari" },
          orderBy: { field: "name", direction: "asc" },
          limit: 1,
        },
      },
    ]);
  });

  it("[SPEC-034.S8] parses known-backlink filters", () => {
    const ast = parseEdgeQL("select default::Villain { name } filter .<characters[is default::Movie] = 'movie-1';");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.filter).toEqual({
      kind: "predicate",
      target: { kind: "backlink", link: "characters", sourceType: "default::Movie" },
      op: "=",
      value: "movie-1",
    });
  });

  it("[SPEC-034.S5] parses boolean filter expressions", () => {
    const ast = parseEdgeQL(
      "select default::User { id, name } filter (.name like '%a%') and not (.active = false) or .id = 'fixed';",
    );
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.filter).toEqual({
      kind: "or",
      left: {
        kind: "and",
        left: {
          kind: "predicate",
          target: { kind: "field", field: "name" },
          op: "like",
          value: "%a%",
        },
        right: {
          kind: "not",
          expr: {
            kind: "predicate",
            target: { kind: "field", field: "active" },
            op: "=",
            value: false,
          },
        },
      },
      right: {
        kind: "predicate",
        target: { kind: "field", field: "id" },
        op: "=",
        value: "fixed",
      },
    });
  });

  it("[SPEC-034.S20] parses free-object top-level select", () => {
    const ast = parseEdgeQL("select { my_string := 'hello', my_number := 42, nums := {1, 2, 3}, heroes := default::Hero { name } }; ");
    if (ast.kind !== "select_free") {
      throw new Error("expected free-object AST");
    }

    expect(ast.entries).toEqual([
      { name: "my_string", expr: { kind: "literal", value: "hello" } },
      { name: "my_number", expr: { kind: "literal", value: 42 } },
      { name: "nums", expr: { kind: "set_literal", values: [1, 2, 3] } },
      {
        name: "heroes",
        expr: {
          kind: "select",
          typeName: "default::Hero",
          shape: [{ kind: "field", name: "name" }],
          clauses: {},
        },
      },
    ]);
  });

  it("[SPEC-PARITY-DATAMODEL-FUNCTIONS.S1] parses function-call expressions", () => {
    const ast = parseEdgeQL("select default::User { name, shout := exclamation(.name) }; ");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.shape).toEqual([
      { kind: "field", name: "name" },
      {
        kind: "computed",
        name: "shout",
        expr: {
          kind: "function_call",
          call: {
            name: "exclamation",
            args: [{ kind: "field_ref", field: "name" }],
          },
        },
      },
    ]);
  });

  it("parses nested function-call arguments and negative number literals", () => {
    const ast = parseEdgeQL("select { value := math::exp(math::ln(-1)) }; ");
    if (ast.kind !== "select_free") {
      throw new Error("expected free-object AST");
    }

    expect(ast.entries).toEqual([
      {
        name: "value",
        expr: {
          kind: "function_call",
          call: {
            name: "math::exp",
            args: [
              {
                kind: "function_call",
                call: {
                  name: "math::ln",
                  args: [{ kind: "literal", value: -1 }],
                },
              },
            ],
          },
        },
      },
    ]);
  });

  it("[SPEC-034.S18] parses polymorphic link type filters", () => {
    const ast = parseEdgeQL("select default::Movie { characters[is default::Hero] { secret_identity } }; ");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.shape).toEqual([
      {
        kind: "link",
        name: "characters",
        typeFilter: "default::Hero",
        shape: [{ kind: "field", name: "secret_identity" }],
        clauses: {},
      },
    ]);
  });

  it("[SPEC-034.S14] parses computed subquery expressions", () => {
    const ast = parseEdgeQL(
      "select default::Villain { name, heroes := (select default::Hero { name } order by name asc limit 1) };",
    );
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.shape).toEqual([
      { kind: "field", name: "name" },
      {
        kind: "computed",
        name: "heroes",
        expr: {
          kind: "subquery",
          typeName: "default::Hero",
          shape: [{ kind: "field", name: "name" }],
          clauses: { orderBy: { field: "name", direction: "asc" }, limit: 1 },
        },
      },
    ]);
  });

  it("[SPEC-PARITY-WITH.S1] parses with-block subquery aliases", () => {
    const ast = parseEdgeQL("with active_users := (select default::User filter .active = true) select active_users { id, name };");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.with).toEqual([
      {
        name: "active_users",
        value: {
          kind: "subquery",
          query: {
            kind: "select",
            typeName: "default::User",
            shape: [{ kind: "field", name: "id" }],
            clauses: {
              filter: { kind: "predicate", target: { kind: "field", field: "active" }, op: "=", value: true },
            },
          },
        },
      },
    ]);
  });

  it("[SPEC-PARITY-WITH.S2] parses typed query parameters in with blocks", () => {
    const ast = parseEdgeQL("with user_id := <uuid>$user_id select default::User { name } filter .id = user_id;");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.with).toEqual([
      {
        name: "user_id",
        value: {
          kind: "parameter",
          name: "user_id",
          castType: "uuid",
        },
      },
    ]);
  });

  it("[SPEC-PARITY-WITH.S3][SPEC-PARITY-WITH.S4] parses module alias and module selection declarations", () => {
    const ast = parseEdgeQL("with module analytics, d as module default select d::User { id }; ");
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.withModule).toBe("analytics");
    expect(ast.withModuleAliases).toEqual([{ alias: "d", module: "default" }]);
    expect(ast.typeName).toBe("d::User");
  });

  it("[SPEC-034.R6] parses splat shape entries", () => {
    const ast = parseEdgeQL(
      "select default::Person { *, **, default::Hero.*, [is default::Hero].** } order by id asc;",
    );
    if (ast.kind !== "select") {
      throw new Error("expected select AST");
    }

    expect(ast.shape).toEqual([
      { kind: "splat", depth: 1 },
      { kind: "splat", depth: 2 },
      { kind: "splat", depth: 1, sourceType: "default::Hero" },
      { kind: "splat", depth: 2, sourceType: "default::Hero", intersection: true },
    ]);
  });

  it("[SPEC-033.R1] parses multi-statement query units", () => {
    const statements = parseEdgeQLScript(
      "insert default::User { name := 'Ari' }; select default::User { id, name } filter name = 'Ari';",
    );
    expect(statements).toHaveLength(2);
    expect(statements[0].kind).toBe("insert");
    expect(statements[1].kind).toBe("select");
  });
});
