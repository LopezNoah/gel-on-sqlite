import { describe, expect, it } from "vitest";
import { parseCreateTypeBody, type CreateTypeBodyEntry } from "../src/runtime/ddl_body.js";

// Parse one body and return the single entry (asserts exactly one).
const one = (body: string): CreateTypeBodyEntry => {
  const entries = parseCreateTypeBody(body);
  expect(entries).toHaveLength(1);
  return entries[0];
};

describe("parseCreateTypeBody — properties", () => {
  it("plain property with qualified target", () => {
    expect(one("CREATE PROPERTY name -> std::str;")).toEqual({
      kind: "property",
      name: "name",
      targetType: "std::str",
      required: false,
      multi: false,
      constraints: [],
      defaultText: undefined,
    });
  });

  it("required + multi modifiers", () => {
    const e = one("CREATE REQUIRED MULTI PROPERTY tags -> std::str;");
    expect(e).toMatchObject({ kind: "property", name: "tags", required: true, multi: true });
  });

  it("colon separator is accepted", () => {
    expect(one("CREATE PROPERTY n: int64;")).toMatchObject({ kind: "property", targetType: "int64" });
  });

  it("collection target type is preserved verbatim", () => {
    expect(one("CREATE PROPERTY coords -> tuple<float64, float64>;")).toMatchObject({
      kind: "property",
      targetType: "tuple<float64, float64>",
    });
  });

  it("inline exclusive constraint", () => {
    expect(one("CREATE PROPERTY email -> std::str { CREATE CONSTRAINT exclusive; };")).toMatchObject({
      kind: "property",
      name: "email",
      constraints: [{ delegated: false, onExpr: undefined, exceptExpr: undefined }],
    });
  });

  // PARITY NOTE: the EdgeQL tokenizer emits `DELEGATED` as `kw_unreserved`,
  // not `identifier`, so the prior token-walker (which checked for an
  // `identifier`) never detected `delegated` and dropped the whole constraint.
  // This port reproduces that exactly — a latent gap preserved for behaviour
  // neutrality; closing it (accept kw_unreserved) would be a separate,
  // behaviour-changing fix because dropped exclusive constraints would start
  // being enforced. See docs/adr/0026.
  it("inline delegated exclusive constraint is dropped (parity)", () => {
    expect(one("CREATE PROPERTY x -> str { CREATE DELEGATED CONSTRAINT exclusive; };")).toMatchObject({
      kind: "property",
      constraints: [],
    });
  });

  it("SET default := text", () => {
    expect(one("CREATE PROPERTY status -> str { SET default := 'active'; };")).toMatchObject({
      kind: "property",
      defaultText: "'active'",
    });
  });

  it("bare default := text (no SET)", () => {
    expect(one("CREATE PROPERTY n -> int64 { default := 0; };")).toMatchObject({
      kind: "property",
      defaultText: "0",
    });
  });

  it("non-exclusive constraints are dropped", () => {
    expect(one("CREATE PROPERTY s -> str { CREATE CONSTRAINT max_len_value(10); };")).toMatchObject({
      kind: "property",
      constraints: [],
    });
  });
});

describe("parseCreateTypeBody — links", () => {
  it("stored link via arrow", () => {
    expect(one("CREATE LINK owner -> User;")).toEqual({
      kind: "link",
      name: "owner",
      targetType: "User",
      required: false,
      multi: false,
      properties: [],
      constraints: [],
    });
  });

  it("stored link via colon", () => {
    expect(one("CREATE LINK owner: User;")).toMatchObject({ kind: "link", targetType: "User" });
  });

  it("multi link", () => {
    expect(one("CREATE MULTI LINK friends -> User;")).toMatchObject({ kind: "link", multi: true });
  });

  it("link with link-properties", () => {
    expect(one("CREATE MULTI LINK cards -> Card { CREATE PROPERTY count -> int64; CREATE REQUIRED PROPERTY note -> str; };")).toMatchObject({
      kind: "link",
      name: "cards",
      properties: [
        { name: "count", targetType: "int64", required: false, multi: false },
        { name: "note", targetType: "str", required: true, multi: false },
      ],
    });
  });

  it("link with exclusive constraint", () => {
    expect(one("CREATE LINK owner -> User { CREATE CONSTRAINT exclusive; };")).toMatchObject({
      kind: "link",
      constraints: [{ delegated: false }],
    });
  });

  it("computed link alias preserves expr text", () => {
    expect(one("CREATE LINK best := (SELECT .friends LIMIT 1);")).toEqual({
      kind: "computed_link",
      name: "best",
      exprText: "(SELECT .friends LIMIT 1)",
    });
  });
});

describe("parseCreateTypeBody — ALTER + type-level constraints", () => {
  it("ALTER PROPERTY adding an exclusive constraint", () => {
    expect(one("ALTER PROPERTY name { CREATE CONSTRAINT exclusive; };")).toEqual({
      kind: "alter_pointer",
      pointerKind: "property",
      name: "name",
      constraints: [{ delegated: false, onExpr: undefined, exceptExpr: undefined }],
    });
  });

  it("ALTER LINK with a delegated exclusive constraint drops it (parity, see note above)", () => {
    // The delegated constraint is dropped, so no constraints remain and no
    // alter_pointer entry is emitted.
    expect(parseCreateTypeBody("ALTER LINK owner { CREATE DELEGATED CONSTRAINT exclusive; };")).toEqual([]);
  });

  it("ALTER without a body produces no entry", () => {
    expect(parseCreateTypeBody("ALTER PROPERTY name;")).toEqual([]);
  });

  it("type-level exclusive ON (.field)", () => {
    expect(one("CREATE CONSTRAINT exclusive ON (.name);")).toEqual({
      kind: "type_exclusive_constraint",
      delegated: false,
      onExpr: ".name",
      exceptExpr: undefined,
    });
  });

  it("type-level exclusive ON + EXCEPT", () => {
    expect(one("CREATE CONSTRAINT exclusive ON (.email) EXCEPT (.deleted);")).toMatchObject({
      kind: "type_exclusive_constraint",
      onExpr: ".email",
      exceptExpr: ".deleted",
    });
  });

  it("type-level exclusive with std:: qualifier", () => {
    expect(one("CREATE CONSTRAINT std::exclusive ON (.name);")).toMatchObject({
      kind: "type_exclusive_constraint",
      onExpr: ".name",
    });
  });

  it("delegated type-level exclusive is dropped (parity, see note above)", () => {
    expect(parseCreateTypeBody("CREATE DELEGATED CONSTRAINT exclusive ON (.code);")).toEqual([]);
  });
});

describe("parseCreateTypeBody — multi-member bodies", () => {
  it("parses several members in declaration order, dropping unknowns", () => {
    const body = `
      CREATE REQUIRED PROPERTY name -> std::str { CREATE CONSTRAINT exclusive; };
      CREATE PROPERTY age -> int64;
      CREATE MULTI LINK friends -> User;
      CREATE CONSTRAINT exclusive ON (.name);
      CREATE ANNOTATION title := 'X';
    `;
    const entries = parseCreateTypeBody(body);
    expect(entries.map((e) => e.kind)).toEqual([
      "property",
      "property",
      "link",
      "type_exclusive_constraint",
    ]);
  });

  it("empty body yields no entries", () => {
    expect(parseCreateTypeBody("")).toEqual([]);
    expect(parseCreateTypeBody("   ")).toEqual([]);
  });
});
