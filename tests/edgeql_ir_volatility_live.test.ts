// Volatility inference parity for the LIVE IR (`compileASTToGelIR`), the
// counterpart to `edgeql_ir_volatility_inference.test.ts` (which pins the
// `semantic.ts` oracle). When the Live IR reaches parity on every inference
// dimension, the oracle can be deleted (the ADR 0001 follow-up); this file is
// the volatility down-payment — see ADR 0015. Same cases as the oracle suite.
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
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

const expectVolatility = (schema: SchemaSnapshot, source: string, expected: Volatility): void => {
  const ast = parseEdgeQL(source) as unknown;
  const stmt = (Array.isArray(ast) ? (ast as Statement[])[0] : (ast as Statement)) as Statement;
  const ir = compileASTToGelIR(expandSchemaAliasesInStatement(stmt, schema), {
    module: (stmt as { withModule?: string }).withModule,
    schema,
  });
  expect((ir as { volatility?: Volatility }).volatility).toBe(expected);
};

describe("TestEdgeQLVolatilityInference (Live IR)", () => {
  let schema: SchemaSnapshot;
  beforeAll(() => {
    schema = loadSchema();
  });

  it("00 object set is stable", () => expectVolatility(schema, `SELECT Card`, "stable"));
  it("01 volatile WITH binding", () => expectVolatility(schema, `WITH foo := random() SELECT foo`, "volatile"));
  it("02 volatile FILTER", () => expectVolatility(schema, `SELECT Card FILTER random() > 0.9`, "volatile"));
  it("03 volatile ORDER BY", () => expectVolatility(schema, `SELECT Card ORDER BY random()`, "volatile"));
  it("04 volatile LIMIT", () => expectVolatility(schema, `SELECT Card LIMIT <int64>random()`, "volatile"));
  it("05 volatile OFFSET", () => expectVolatility(schema, `SELECT Card OFFSET <int64>random()`, "volatile"));
  it("06 INSERT is modifying", () => expectVolatility(schema, `INSERT Card { name := 'foo', element := 'fire', cost := 1 }`, "modifying"));
  it("07 UPDATE is modifying", () => expectVolatility(schema, `UPDATE Card SET { name := 'foo' }`, "modifying"));
  it("08 DELETE is modifying", () => expectVolatility(schema, `DELETE Card`, "modifying"));
  it("09 literal binding is immutable", () => expectVolatility(schema, `with X := 1 select X`, "immutable"));
  it("10 object binding is stable", () => expectVolatility(schema, `with X := User select X`, "stable"));
  it("11 volatile binding", () => expectVolatility(schema, `with X := random() select X`, "volatile"));
  it("12 immutable alias", () => expectVolatility(schema, `select AliasOne`, "immutable"));
  it("13 global is stable", () => expectVolatility(schema, `select global GlobalOne`, "stable"));
  it("14 alias of object is stable", () => expectVolatility(schema, `select AirCard`, "stable"));
  it("15 computed global is stable", () => expectVolatility(schema, `select global HighestCost`, "stable"));
  it("16 computed global (set) is stable", () => expectVolatility(schema, `select global CardsWithText`, "stable"));
});
