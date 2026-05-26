import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileToIR } from "../src/compiler/semantic.js";
import { expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { Statement } from "../src/edgeql/ast.js";

type Volatility = "immutable" | "stable" | "volatile" | "modifying";

const loadSchema = (): SchemaSnapshot => {
  const source = fs.readFileSync(new URL("./schemas/cards.esdl", import.meta.url), "utf8");
  const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
  return schemaSnapshotFromDeclarative(decl);
};

const compileQuery = (schema: SchemaSnapshot, query: string) => {
  const ast = parseEdgeQL(query) as unknown;
  const stmt = (Array.isArray(ast) ? (ast as Statement[])[0] : (ast as Statement)) as Statement;
  return compileToIR(schema, expandSchemaAliasesInStatement(stmt, schema));
};

const expectVolatility = (
  schema: SchemaSnapshot,
  source: string,
  expected: Volatility,
): void => {
  const ir = compileQuery(schema, source);
  const inference = (ir as { inference?: { volatility?: Volatility } }).inference;
  expect(inference?.volatility).toBe(expected);
};

// The Python suite checks `ir.volatility` directly on the top-level statement
// IR for every query. sqlite-ts only computes an `inference` field on
// `SelectIR`/mutation IRs, not on the `select_expr` IRs produced for arbitrary
// expressions, and full volatility propagation through bindings / filters /
// order-by / limit / offset isn't implemented yet. These cases are kept here
// as parity placeholders.

describe("TestEdgeQLVolatilityInference", () => {
  let schema: SchemaSnapshot;

  beforeAll(() => {
    schema = loadSchema();
  });

  it.skip("test_edgeql_ir_volatility_inference_00 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `SELECT Card`, "stable");
  });

  it.skip("test_edgeql_ir_volatility_inference_01 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `
      WITH
        foo := random()
      SELECT
        foo
    `, "volatile");
  });

  it.skip("test_edgeql_ir_volatility_inference_02 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `
      SELECT
        Card
      FILTER
        random() > 0.9
    `, "volatile");
  });

  it.skip("test_edgeql_ir_volatility_inference_03 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `
      SELECT
        Card
      ORDER BY
        random()
    `, "volatile");
  });

  it.skip("test_edgeql_ir_volatility_inference_04 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `
      SELECT
        Card
      LIMIT
        <int64>random()
    `, "volatile");
  });

  it.skip("test_edgeql_ir_volatility_inference_05 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `
      SELECT
        Card
      OFFSET
        <int64>random()
    `, "volatile");
  });

  it.skip("test_edgeql_ir_volatility_inference_06 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `
      INSERT
        Card {
          name := 'foo',
          element := 'fire',
          cost := 1,
        }
    `, "modifying");
  });

  it.skip("test_edgeql_ir_volatility_inference_07 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `
      UPDATE
        Card
      SET {
        name := 'foo',
      }
    `, "modifying");
  });

  it.skip("test_edgeql_ir_volatility_inference_08 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `
      DELETE
        Card
    `, "modifying");
  });

  it.skip("test_edgeql_ir_volatility_inference_09 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `with X := 1 select X`, "immutable");
  });

  it.skip("test_edgeql_ir_volatility_inference_10 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `with X := User select X`, "stable");
  });

  it.skip("test_edgeql_ir_volatility_inference_11 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `with X := random() select X`, "volatile");
  });

  it.skip("test_edgeql_ir_volatility_inference_12 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `select AliasOne`, "immutable");
  });

  it.skip("test_edgeql_ir_volatility_inference_13 [unconverted: globals + volatility inference not implemented]", () => {
    expectVolatility(schema, `select global GlobalOne`, "stable");
  });

  it.skip("test_edgeql_ir_volatility_inference_14 [unconverted: volatility inference not implemented]", () => {
    expectVolatility(schema, `select AirCard`, "stable");
  });

  it.skip("test_edgeql_ir_volatility_inference_15 [unconverted: globals + volatility inference not implemented]", () => {
    expectVolatility(schema, `select global HighestCost`, "stable");
  });

  it.skip("test_edgeql_ir_volatility_inference_16 [unconverted: globals + volatility inference not implemented]", () => {
    expectVolatility(schema, `select global CardsWithText`, "stable");
  });
});
