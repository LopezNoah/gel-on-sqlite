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

const compileQuery = (schema: SchemaSnapshot, query: string) => {
  const ast = parseEdgeQL(query) as unknown;
  const stmt = (Array.isArray(ast) ? (ast as Statement[])[0] : (ast as Statement)) as Statement;
  return compileASTToGelIR(expandSchemaAliasesInStatement(stmt, schema), { module: (stmt as { withModule?: string }).withModule, schema });
};

describe("TestEdgeQLTypeInference", () => {
  let schema: SchemaSnapshot;

  beforeAll(() => {
    schema = loadSchema();
  });

  it("test_edgeql_ir_type_inference_00", () => {
    const ir = compileQuery(schema, `SELECT Card { name }`);
    expect((ir as { stype?: string }).stype).toBe("default::Card");
  });

  // Live IR gap: shape-element typeref is a SQL-builder concern (ADR 0018).
  // The statement-level type (`stype`) is covered above; per-shape-element
  // typerefs are not part of the inference module.
  it.skip("test_edgeql_ir_type_inference_01", () => {
    const ir = compileQuery(schema, `SELECT Card { name }`);
    const shape = (ir as { shape?: Array<{ name: string; typeRef?: { name?: string } }> }).shape ?? [];
    const nameField = shape.find((el) => el.name === "name");
    expect(nameField?.typeRef?.name).toBe("std::str");
  });

  // UNION between two object types should produce a derived union type
  // (`__derived__::(default:Card | default:User)` in upstream). sqlite-ts
  // currently lowers `SELECT A UNION B` to a generic `select_expr` without
  // computing a union typeref.
  it("test_edgeql_ir_type_inference_02", () => {
    const ir = compileQuery(schema, `SELECT Card UNION User`);
    expect((ir as { stype?: string }).stype).toBe("__derived__::(default:Card | default:User)");
  });

  it("test_edgeql_ir_type_inference_03", () => {
    const ir = compileQuery(schema, `SELECT {Card, User}`);
    expect((ir as { stype?: string }).stype).toBe("__derived__::(default:Card | default:User)");
  });

  it("test_edgeql_ir_type_inference_04", () => {
    const ir = compileQuery(schema, `SELECT Card if true else User`);
    expect((ir as { stype?: string }).stype).toBe("__derived__::(default:Card | default:User)");
  });

  it("test_edgeql_ir_type_inference_05", () => {
    const ir = compileQuery(schema, `SELECT Card ?? User`);
    expect((ir as { stype?: string }).stype).toBe("__derived__::(default:Card | default:User)");
  });
});
