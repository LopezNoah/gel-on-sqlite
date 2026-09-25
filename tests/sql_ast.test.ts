import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { sql, sqlBinding } from "../src/sql/sql_ast.js";
import { renderSqlAst, SqlAstValidationError, validateSqlAst } from "../src/sql/sql_ast_renderer.js";

describe("scoped SQL AST", () => {
  it("renders and executes a structured SELECT with render-order parameters", () => {
    const users = sqlBinding("u");
    const scores = sqlBinding("s");
    const query = sql.select({
      projections: [
        { expr: sql.parameter("projected"), alias: "marker" },
        { expr: sql.column(users, "name"), alias: "name" },
      ],
      from: [
        { source: sql.table("users", users, ["id", "name"]) },
        {
          source: sql.table("scores", scores, ["user_id", "score"]),
          join: {
            kind: "inner",
            on: sql.binary("=", sql.column(scores, "user_id"), sql.column(users, "id")),
          },
        },
      ],
      where: sql.binary(">", sql.column(scores, "score"), sql.parameter(10)),
      orderBy: [{ expr: sql.column(users, "name"), direction: "ASC" }],
    });

    const rendered = renderSqlAst(query);
    expect(rendered).toEqual({
      sql: 'SELECT ? AS "marker", "u"."name" AS "name" FROM "users" "u" JOIN "scores" "s" ON ("s"."user_id" = "u"."id") WHERE ("s"."score" > ?) ORDER BY "u"."name" ASC',
      params: ["projected", 10],
    });

    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE users (id INTEGER, name TEXT); CREATE TABLE scores (user_id INTEGER, score INTEGER);");
      db.exec("INSERT INTO users VALUES (1, 'Ada'), (2, 'Grace'); INSERT INTO scores VALUES (1, 11), (2, 9);");
      expect(db.prepare(rendered.sql).all(...rendered.params)).toEqual([
        { marker: "projected", name: "Ada" },
      ]);
    } finally {
      db.close();
    }
  });

  it("checks column scope and derived-table exports", () => {
    const outside = sqlBinding("outside");
    expect(() =>
      validateSqlAst(
        sql.select({
          projections: [{ expr: sql.column(outside, "id"), alias: "id" }],
        }),
      ),
    ).toThrowError(/outside its scope/);

    const childBinding = sqlBinding("child");
    const missingExport = sqlBinding("missing_export");
    const child = sql.select({
      projections: [{ expr: sql.literal(1), alias: "id" }],
    });
    expect(() =>
      validateSqlAst(
        sql.select({
          projections: [{ expr: sql.column(missingExport, "name"), alias: "name" }],
          from: [{ source: sql.derived(child, missingExport) }],
        }),
      ),
    ).toThrowError(/not exported/);

    // A binding's printable alias does not make it interchangeable with another
    // range variable, even when that other variable uses the same SQL alias.
    expect(() =>
      validateSqlAst(
        sql.select({
          projections: [{ expr: sql.column(childBinding, "id"), alias: "id" }],
          from: [{ source: sql.derived(child, missingExport) }],
        }),
      ),
    ).toThrowError(/outside its scope/);
  });

  it("allows a correlated scalar subquery to reference an enclosing binding", () => {
    const users = sqlBinding("u");
    const scores = sqlBinding("s");
    const scoreQuery = sql.select({
      projections: [{ expr: sql.column(scores, "score"), alias: "score" }],
      from: [{ source: sql.table("scores", scores, ["user_id", "score"]) }],
      where: sql.binary("=", sql.column(scores, "user_id"), sql.column(users, "id")),
    });
    const query = sql.select({
      projections: [
        { expr: sql.column(users, "name"), alias: "name" },
        { expr: sql.scalarSubquery(scoreQuery), alias: "score" },
      ],
      from: [{ source: sql.table("users", users, ["id", "name"]) }],
    });

    expect(renderSqlAst(query).sql).toContain('"s"."user_id" = "u"."id"');
  });

  it("collects parameters in emitted order through derived sources and joins", () => {
    const source = sqlBinding("src");
    const joined = sqlBinding("j");
    const inner = sql.select({
      projections: [{ expr: sql.parameter("from"), alias: "value" }],
    });
    const query = sql.select({
      projections: [{ expr: sql.parameter("select"), alias: "value" }],
      from: [
        { source: sql.derived(inner, source) },
        {
          source: sql.table("other", joined, ["id"]),
          join: { kind: "inner", on: sql.binary("=", sql.column(joined, "id"), sql.parameter("on")) },
        },
      ],
      where: sql.binary("=", sql.column(source, "value"), sql.parameter("where")),
      limit: sql.parameter(1),
    });

    expect(renderSqlAst(query).params).toEqual(["select", "from", "on", "where", 1]);
  });

  it("reports invalid join structure and SQL function names", () => {
    const first = sqlBinding("first");
    expect(() =>
      renderSqlAst(
        sql.select({
          projections: [{ expr: sql.literal(1), alias: "v" }],
          from: [{ source: sql.table("t", first), join: { kind: "inner", on: sql.literal(true) } }],
        }),
      ),
    ).toThrow(SqlAstValidationError);

    expect(() =>
      renderSqlAst(
        sql.select({
          projections: [{ expr: sql.call("sum); DROP TABLE t;--", sql.literal(1)), alias: "v" }],
        }),
      ),
    ).toThrowError(/Invalid SQL function name/);
  });
});
