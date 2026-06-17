// Multiplicity inference parity for the LIVE IR (`compileASTToGelIR`), the
// counterpart to `edgeql_ir_mult_inference.test.ts` (which pins the oracle).
// A representative spread; the full statement-level set reached 99/102 at
// parity via a probe during the port (the 3 misses are 2 error-detection cases
// — non-additive, like scope-tree — and one deep nested-shape edge case). See
// ADR 0017. Multiplicity: `empty | unique | duplicate | unknown`.
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { Statement } from "../src/edgeql/ast.js";

type Multiplicity = "empty" | "unique" | "duplicate" | "unknown";

const loadSchema = (): SchemaSnapshot => {
  const source = fs.readFileSync(new URL("./schemas/cards_ir_inference.esdl", import.meta.url), "utf8");
  const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
  return schemaSnapshotFromDeclarative(decl);
};

const expectMult = (schema: SchemaSnapshot, source: string, expected: Multiplicity): void => {
  const ast = parseEdgeQL(source) as unknown;
  const stmt = (Array.isArray(ast) ? (ast as Statement[])[0] : (ast as Statement)) as Statement;
  const ir = compileASTToGelIR(expandSchemaAliasesInStatement(stmt, schema), {
    module: (stmt as { withModule?: string }).withModule,
    schema,
  });
  expect((ir as { multiplicity?: Multiplicity }).multiplicity).toBe(expected);
};

describe("TestEdgeQLMultiplicityInference (Live IR)", () => {
  let schema: SchemaSnapshot;
  beforeAll(() => {
    schema = loadSchema();
  });

  it("object set is unique", () => expectMult(schema, `SELECT Card`, "unique"));
  it("id projection is unique", () => expectMult(schema, `SELECT Card.id`, "unique"));
  it("exclusive property is unique", () => expectMult(schema, `SELECT User.name`, "unique"));
  it("computed many-valued is duplicate", () => expectMult(schema, `SELECT User.deck_cost`, "duplicate"));
  it("literal is unique", () => expectMult(schema, `SELECT 1`, "unique"));
  it("distinct set literal is unique", () => expectMult(schema, `SELECT {1, 2}`, "unique"));
  it("set literal with repeats is duplicate", () => expectMult(schema, `SELECT {1, 1}`, "duplicate"));
  it("non-exclusive property is duplicate", () => expectMult(schema, `SELECT Card.cost`, "duplicate"));
  it("union of object sets is unique", () => expectMult(schema, `SELECT {Card, User}`, "unique"));
  it("arithmetic of singletons is unique", () => expectMult(schema, `SELECT 1 + 2`, "unique"));
  it("0 * set collapses to duplicate", () => expectMult(schema, `SELECT 0 * {2, 3}`, "duplicate"));
  it("cartesian sum is duplicate", () => expectMult(schema, `SELECT {1, 2} + {2, 3}`, "duplicate"));
  it("concat with one many-prop is unique when other is constant", () => expectMult(schema, `SELECT 'pre_' ++ Card.name`, "unique"));
  it("concat of two many-props is duplicate", () => expectMult(schema, `SELECT User.name ++ Card.name`, "duplicate"));
  it("tuple is unique", () => expectMult(schema, `SELECT (1, Card.name)`, "unique"));
  it("array is unique", () => expectMult(schema, `SELECT ['card', Card.name]`, "unique"));
  it("to_str of singleton is unique", () => expectMult(schema, `SELECT to_str(1)`, "unique"));
  it("array_unpack is duplicate", () => expectMult(schema, `SELECT array_unpack(str_split(<str>Card.id, ''))`, "duplicate"));
  it("count aggregate is unique", () => expectMult(schema, `SELECT count(Card)`, "unique"));
});
