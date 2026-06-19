import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { schemaFromSdl } from "../src/compiler/inspect.js";
import { validateStatementAst, type AstValidationDeps } from "../src/runtime/ast_validation.js";

// The AST pre-validation cluster (ADR 0048) lifted out of engine.ts. Its whole
// point is that the interface is now the test surface: each `check*` rule is
// drivable with a parsed Statement + a SchemaSnapshot, no SQLite and no query
// execution. The injected `AstValidationDeps` (the engine's runtime-alias
// registries) are faked here — the seam the extraction introduced.

const schema = schemaFromSdl(
  fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"),
);

// No registered runtime aliases — the common case.
const noAliases: AstValidationDeps = {
  runtimeTypedAliasMap: () => new Map(),
  runtimeExprAliasMap: () => new Map(),
};

const validate = (q: string, deps: AstValidationDeps = noAliases, allowUserSpecifiedId = false) =>
  validateStatementAst(schema, parseEdgeQL(q), deps, allowUserSpecifiedId);

describe("validateStatementAst — INSERT checks", () => {
  it("rejects inserting a standard-library type", () => {
    expect(() => validate("INSERT schema::Migration { name := 'x' }")).toThrow(/insert standard library type/);
  });

  it("rejects assigning the server-generated id without allow_user_specified_id", () => {
    expect(() => validate("INSERT Status { id := <uuid>'a', name := 'x' }")).toThrow(/cannot assign to property 'id'/);
  });

  it("permits an explicit id when allow_user_specified_id is on", () => {
    expect(() => validate("INSERT Status { id := <uuid>'a', name := 'x' }", noAliases, true)).not.toThrow();
  });

  it("rejects assigning the __type__ link", () => {
    expect(() => validate("INSERT Status { __type__ := 'x', name := 'y' }")).toThrow(/cannot assign to link '__type__'/);
  });

  it("rejects modification of a computed property", () => {
    expect(() => validate("INSERT Publication { title := 'x', title1 := 'y' }"))
      .toThrow(/modification of computed property 'title1'/);
  });

  it("accepts a well-formed INSERT", () => {
    expect(() => validate("INSERT Status { name := 'x' }")).not.toThrow();
  });
});

describe("validateStatementAst — injected alias seam", () => {
  it("rejects INSERT into a name the runtime expr-alias registry reports", () => {
    // The deps are the seam: with the fake registry reporting `MyAlias`, the
    // validator rejects it as a view — no engine, no alias registration code.
    const withAlias: AstValidationDeps = {
      runtimeTypedAliasMap: () => new Map(),
      runtimeExprAliasMap: () => new Map([["default::MyAlias", "SELECT 1"]]),
    };
    expect(() => validate("INSERT MyAlias { x := 1 }", withAlias))
      .toThrow(/cannot insert into expression alias/);
  });

  it("does not treat the name as an alias when the registry is empty", () => {
    // Same query, empty registry — the alias check does not fire (it falls
    // through to other handling; not the alias diagnostic).
    expect(() => validate("INSERT MyAlias { x := 1 }", noAliases))
      .not.toThrow(/cannot insert into expression alias/);
  });
});

describe("validateStatementAst — function-call signatures", () => {
  it("rejects sum() of a statically-known string", () => {
    expect(() => validate("SELECT sum('x')")).toThrow(/function "sum\(arg0: std::str\)" does not exist/);
  });
});
