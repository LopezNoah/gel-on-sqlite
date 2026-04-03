import { describe, expect, it } from "vitest";

import { compileToIR } from "../src/compiler/semantic.js";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { SchemaSnapshot } from "../src/schema/schema.js";
import { compileToSQL } from "../src/sql/compiler.js";

const schema = new SchemaSnapshot([
  {
    module: "default",
    name: "User",
    fields: [
      { name: "name", type: "str", required: true },
    ],
  },
]);

describe("query lifecycle", () => {
  it("[SPEC-001.R1][SPEC-001.R2] lowers AST to deterministic SQL", () => {
    const ast = parseEdgeQL("select default::User { id, name } filter name = 'Kai' order by name asc offset 1 limit 2;");
    const ir = compileToIR(schema, ast);
    const sql = compileToSQL(ir);

    expect(sql).toEqual({
      sql: 'SELECT t0."__source_type" AS "__source_type", t0."id" AS "id", t0."name" AS "name" FROM (SELECT \'default::User\' AS "__source_type", "id" AS "id", "name" AS "name" FROM "default__user") t0 WHERE t0."name" = ? ORDER BY t0."name" ASC LIMIT ? OFFSET ?',
      params: ["Kai", 2, 1],
      loweringMode: "single_statement",
    });
  });

  it("[SPEC-001.R2] lowers update and delete through IR to SQL", () => {
    const updateSQL = compileToSQL(
      compileToIR(schema, parseEdgeQL("update default::User filter id = '0000000000000000' set { name := 'Kai' };")),
    );
    expect(updateSQL).toEqual({
      sql: 'UPDATE "default__user" SET "name" = ? WHERE "id" = ?',
      params: ["Kai", "0000000000000000"],
      loweringMode: "single_statement",
    });

    const deleteSQL = compileToSQL(
      compileToIR(schema, parseEdgeQL("delete default::User filter id = '0000000000000000';")),
    );
    expect(deleteSQL).toEqual({
      sql: 'DELETE FROM "default__user" WHERE "id" = ?',
      params: ["0000000000000000"],
      loweringMode: "single_statement",
    });
  });
});
