import { describe, expect, it } from "vitest";
import { buildInsertRowSql } from "../src/runtime/dml_sql.js";
import { PENDING_INSERT_SQL_EXPR_VALUE } from "../src/compiler/dml_lowering.js";
import type { ScalarValue } from "../src/types.js";

// The write-time INSERT row emitter, lifted out of runWriteWithAccessPolicies
// so it has a name and a direct test surface (docs/adr/0046). Pure: column →
// value entries in, { sql, params } out.

const pos = { line: 1, column: 1 };

describe("buildInsertRowSql", () => {
  it("emits DEFAULT VALUES for no columns", () => {
    const built = buildInsertRowSql("default::User", [], [], pos);
    expect(built.sql).toBe(`INSERT INTO "default::User" DEFAULT VALUES`);
    expect(built.params).toEqual([]);
  });

  it("emits quoted columns with positional params, in order", () => {
    const built = buildInsertRowSql(
      "default::User",
      [["name", "ada"], ["age", 36]] as Array<[string, ScalarValue]>,
      [],
      pos,
    );
    expect(built.sql).toBe(`INSERT INTO "default::User" ("name", "age") VALUES (?, ?)`);
    expect(built.params).toEqual(["ada", 36]);
  });

  it("coerces booleans to 1/0 in params", () => {
    const built = buildInsertRowSql(
      "T",
      [["active", true], ["archived", false]] as Array<[string, ScalarValue]>,
      [],
      pos,
    );
    expect(built.params).toEqual([1, 0]);
  });

  it("splices a compiled SQL expression and its params for a deferred column", () => {
    const built = buildInsertRowSql(
      "T",
      [["name", "ada"], ["slug", PENDING_INSERT_SQL_EXPR_VALUE as ScalarValue]] as Array<[string, ScalarValue]>,
      [{ column: "slug", sql: "lower(?)", params: ["ADA"] }],
      pos,
    );
    expect(built.sql).toBe(`INSERT INTO "T" ("name", "slug") VALUES (?, lower(?))`);
    // positional params keep emission order: the literal "ada", then the
    // compiled expression's own param slice.
    expect(built.params).toEqual(["ada", "ADA"]);
  });

  it("throws E_UNSUPPORTED when a deferred column has no compiled expression", () => {
    expect(() =>
      buildInsertRowSql(
        "T",
        [["slug", PENDING_INSERT_SQL_EXPR_VALUE as ScalarValue]] as Array<[string, ScalarValue]>,
        [],
        pos,
      ),
    ).toThrowError(/requires SQL lowering/);
  });
});
