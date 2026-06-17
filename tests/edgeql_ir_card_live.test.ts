// Cardinality inference parity for the LIVE IR (`compileASTToGelIR`), the
// counterpart to `edgeql_ir_card_inference.test.ts` (which pins the oracle).
// A representative spread of the statement-level cases; the full 121-case
// statement-level set was verified at parity via a probe during the port (see
// ADR 0016). Shape-element cardinality (`shape[].cardinality`) is the SQL
// builder's concern, not this inference module's, and is covered elsewhere.
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { Statement } from "../src/edgeql/ast.js";

type Cardinality = "one" | "many" | "at_most_one" | "at_least_one" | "empty" | "unknown";

const loadSchema = (): SchemaSnapshot => {
  const source = fs.readFileSync(new URL("./schemas/cards_ir_inference.esdl", import.meta.url), "utf8");
  const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
  return schemaSnapshotFromDeclarative(decl);
};

const expectCard = (schema: SchemaSnapshot, source: string, expected: Cardinality): void => {
  const ast = parseEdgeQL(source) as unknown;
  const stmt = (Array.isArray(ast) ? (ast as Statement[])[0] : (ast as Statement)) as Statement;
  const ir = compileASTToGelIR(expandSchemaAliasesInStatement(stmt, schema), {
    module: (stmt as { withModule?: string }).withModule,
    schema,
  });
  expect((ir as { cardinality?: Cardinality }).cardinality).toBe(expected);
};

describe("TestEdgeQLCardinalityInference (Live IR)", () => {
  let schema: SchemaSnapshot;
  beforeAll(() => {
    schema = loadSchema();
  });

  it("object set is many", () => expectCard(schema, `SELECT Card`, "many"));
  it("exclusive-field FILTER is at_most_one", () => expectCard(schema, `SELECT Card FILTER Card.name = 'Djinn'`, "at_most_one"));
  it("exclusive FILTER (reversed operands)", () => expectCard(schema, `SELECT Card FILTER 'Djinn' = Card.name`, "at_most_one"));
  it("AND with exclusive pin is at_most_one", () => expectCard(schema, `SELECT Card FILTER 'foo' = 'foo' AND 'Djinn' = Card.name`, "at_most_one"));
  it("OR does not pin (many)", () => expectCard(schema, `SELECT Card FILTER 'foo' = 'foo' OR 'Djinn' = Card.name`, "many"));
  it("LIMIT 1 is at_most_one", () => expectCard(schema, `SELECT Card LIMIT 1`, "at_most_one"));
  it("literal is one", () => expectCard(schema, `SELECT 1`, "one"));
  it("set literal is at_least_one", () => expectCard(schema, `SELECT {1, 2, 3}`, "at_least_one"));
  it("array_agg collapses to one", () => expectCard(schema, `SELECT array_agg(Card.cost)`, "one"));
  it("arithmetic on singletons is one", () => expectCard(schema, `SELECT 1 + 2`, "one"));
  it("arithmetic with a many operand is many", () => expectCard(schema, `SELECT 1 + Card.cost`, "many"));
  it("coalesce of singletons is one", () => expectCard(schema, `SELECT (SELECT Card LIMIT 1).cost ?? 99`, "one"));
  it("compound exclusive constraint pins at_most_one", () => expectCard(schema, `SELECT Person FILTER .first = "Phil" AND .last = "Emarg"`, "at_most_one"));
  it("partial compound key is many", () => expectCard(schema, `SELECT Person FILTER .first = "Phil"`, "many"));
  it("single exclusive property is at_most_one", () => expectCard(schema, `SELECT Person FILTER .email = "test@example.com"`, "at_most_one"));
  it("FILTER false is at_most_one for a singleton", () => expectCard(schema, `SELECT 1 FILTER false`, "at_most_one"));
  it("tuple of singletons is one", () => expectCard(schema, `SELECT (1, 'a')`, "one"));
  it("tuple with a many element is many", () => expectCard(schema, `SELECT (1, Card.name)`, "many"));
  it("free object is one", () => expectCard(schema, `SELECT {a := 42}`, "one"));
  it("FOR over a set is at_least_one", () => expectCard(schema, `FOR x IN {0, 1} UNION {a := x}`, "at_least_one"));
  it("len of a singleton is one", () => expectCard(schema, `SELECT len("foo")`, "one"));
  it("len of an empty-able arg is at_most_one", () => expectCard(schema, `SELECT len(<str>{})`, "at_most_one"));
  it("max aggregate is at_most_one", () => expectCard(schema, `SELECT max(Person.p)`, "at_most_one"));
  it("assert_single is at_most_one", () => expectCard(schema, `SELECT assert_single(Person.p)`, "at_most_one"));
});
