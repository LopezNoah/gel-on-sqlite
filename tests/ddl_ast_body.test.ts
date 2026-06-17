import { describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import type { DDLStatement } from "../src/edgeql/ast.js";

const ddl = (q: string): DDLStatement => parseEdgeQL(q) as DDLStatement;

describe("parseDDL — CREATE TYPE body on the AST (Stage D1b)", () => {
  it("populates createTypeBody with structured members", () => {
    const stmt = ddl(
      "CREATE TYPE Foo { CREATE REQUIRED PROPERTY name -> std::str { CREATE CONSTRAINT exclusive; }; CREATE MULTI LINK tags -> Tag; };",
    );
    expect(stmt.kind).toBe("ddl");
    expect(stmt.objectKind).toBe("type");
    const body = stmt.createTypeBody;
    expect(body).toHaveLength(2);
    expect(body?.[0]).toMatchObject({
      kind: "property",
      name: "name",
      targetType: "std::str",
      required: true,
      constraints: [{ delegated: false }],
    });
    expect(body?.[1]).toMatchObject({ kind: "link", name: "tags", targetType: "Tag", multi: true });
  });

  it("is undefined for a body-less CREATE TYPE", () => {
    expect(ddl("CREATE TYPE Empty;").createTypeBody).toBeUndefined();
  });

  it("captures a type-level exclusive constraint", () => {
    const body = ddl("CREATE TYPE Foo { CREATE PROPERTY a -> str; CREATE CONSTRAINT exclusive ON (.a); };").createTypeBody;
    expect(body?.map((e) => e.kind)).toEqual(["property", "type_exclusive_constraint"]);
  });

  it("CREATE TYPE has no alterTypeOps", () => {
    expect(ddl("CREATE TYPE Foo { CREATE PROPERTY x -> str; };").alterTypeOps).toBeUndefined();
  });
});

describe("parseDDL — ALTER TYPE ops on the AST (Stage D1d)", () => {
  it("populates alterTypeOps for a braced ALTER TYPE", () => {
    const stmt = ddl("ALTER TYPE Foo { CREATE CONSTRAINT exclusive ON (.name); };");
    expect(stmt.createTypeBody).toBeUndefined();
    expect(stmt.alterTypeOps).toEqual([
      { kind: "create_constraint", constraint: { delegated: false, onExpr: ".name", exceptExpr: undefined } },
    ]);
  });

  it("populates alterTypeOps for a chained ALTER TYPE", () => {
    expect(ddl("ALTER TYPE Foo ALTER PROPERTY status SET default := 'active';").alterTypeOps).toEqual([
      { kind: "set_default", pointerPath: ["status"], exprText: "'active'" },
    ]);
  });

  it("is undefined for a no-op ALTER TYPE", () => {
    expect(ddl("ALTER TYPE Foo;").alterTypeOps).toBeUndefined();
  });
});
