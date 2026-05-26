import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { compileToIR } from "../src/compiler/semantic.js";
import { expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
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
  return compileToIR(schema, expandSchemaAliasesInStatement(stmt, schema));
};

describe("TestEdgeQLTypeInference", () => {
  let schema: SchemaSnapshot;

  beforeAll(() => {
    schema = loadSchema();
  });

  it("test_edgeql_ir_type_inference_00", () => {
    const ir = compileQuery(schema, `SELECT Card { name }`);
    const typeName = (ir as { sourceType?: string }).sourceType
      ?? (ir as { typeRef?: { name: string } }).typeRef?.name;
    expect(typeName).toBe("default::Card");
  });

  // The Python test reaches into the top-level shape and checks
  // `el.typeref.real_material_type.name_hint` for the named field. The
  // sqlite-ts IR shape elements don't yet carry a typeRef per element, so
  // this assertion isn't implementable without extending the IR. Skipped as
  // parity tracker.
  it.skip("test_edgeql_ir_type_inference_01 [unconverted: shape-element typeref not populated]", () => {
    const ir = compileQuery(schema, `SELECT Card { name }`);
    const shape = (ir as { shape?: Array<{ name: string; typeRef?: { name?: string } }> }).shape ?? [];
    const nameField = shape.find((el) => el.name === "name");
    expect(nameField?.typeRef?.name).toBe("std::str");
  });

  // UNION between two object types should produce a derived union type
  // (`__derived__::(default:Card | default:User)` in upstream). sqlite-ts
  // currently lowers `SELECT A UNION B` to a generic `select_expr` without
  // computing a union typeref.
  it.skip("test_edgeql_ir_type_inference_02 [unconverted: union typeref synthesis not implemented]", () => {
    const ir = compileQuery(schema, `SELECT Card UNION User`);
    const typeName = (ir as { typeRef?: { name: string } }).typeRef?.name;
    expect(typeName).toBe("__derived__::(default:Card | default:User)");
  });

  it.skip("test_edgeql_ir_type_inference_03 [unconverted: set literal {A, B} typeref synthesis not implemented]", () => {
    const ir = compileQuery(schema, `SELECT {Card, User}`);
    const typeName = (ir as { typeRef?: { name: string } }).typeRef?.name;
    expect(typeName).toBe("__derived__::(default:Card | default:User)");
  });

  it.skip("test_edgeql_ir_type_inference_04 [unconverted: if/else typeref synthesis not implemented]", () => {
    const ir = compileQuery(schema, `SELECT Card if true else User`);
    const typeName = (ir as { typeRef?: { name: string } }).typeRef?.name;
    expect(typeName).toBe("__derived__::(default:Card | default:User)");
  });

  it.skip("test_edgeql_ir_type_inference_05 [unconverted: coalesce typeref synthesis not implemented]", () => {
    const ir = compileQuery(schema, `SELECT Card ?? User`);
    const typeName = (ir as { typeRef?: { name: string } }).typeRef?.name;
    expect(typeName).toBe("__derived__::(default:Card | default:User)");
  });
});
