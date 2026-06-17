// Type inference parity for the LIVE IR (`compileASTToGelIR`), the counterpart
// to `edgeql_ir_type_inference.test.ts` (which pins the oracle). Asserts the
// statement-level `stype`: the base object type for a plain select, and the
// derived union `__derived__::(modA:A | modB:B)` when the top-level expression
// composes multiple object types (UNION / set literal / IF-ELSE / ??). The
// oracle test's shape-element typeref case (`Card { name }` → name: std::str)
// is the SQL builder's concern, not this inference module's. See ADR 0018.
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { Statement } from "../src/edgeql/ast.js";

const loadSchema = (): SchemaSnapshot => {
  const source = fs.readFileSync(new URL("./schemas/cards_ir_inference.esdl", import.meta.url), "utf8");
  const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
  return schemaSnapshotFromDeclarative(decl);
};

const expectType = (schema: SchemaSnapshot, source: string, expected: string): void => {
  const ast = parseEdgeQL(source) as unknown;
  const stmt = (Array.isArray(ast) ? (ast as Statement[])[0] : (ast as Statement)) as Statement;
  const ir = compileASTToGelIR(expandSchemaAliasesInStatement(stmt, schema), {
    module: (stmt as { withModule?: string }).withModule,
    schema,
  });
  expect((ir as { stype?: string }).stype).toBe(expected);
};

describe("TestEdgeQLTypeInference (Live IR)", () => {
  let schema: SchemaSnapshot;
  beforeAll(() => {
    schema = loadSchema();
  });

  it("00 plain object select is its type", () => expectType(schema, `SELECT Card { name }`, "default::Card"));
  it("02 UNION of two object types is a derived union", () => expectType(schema, `SELECT Card UNION User`, "__derived__::(default:Card | default:User)"));
  it("03 set literal of two object types is a derived union", () => expectType(schema, `SELECT {Card, User}`, "__derived__::(default:Card | default:User)"));
  it("04 IF-ELSE branches of two object types is a derived union", () => expectType(schema, `SELECT Card if true else User`, "__derived__::(default:Card | default:User)"));
  it("05 coalesce of two object types is a derived union", () => expectType(schema, `SELECT Card ?? User`, "__derived__::(default:Card | default:User)"));
});
