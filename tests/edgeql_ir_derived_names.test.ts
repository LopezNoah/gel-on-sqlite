import { describe, expect, it } from "vitest";
import {
  AliasGenerator,
  derivedExprName,
  derivedPointerName,
  deriveViewTypeName,
  getSpecializedName,
  mangleName,
  pointerFullName,
} from "../src/ir/derived_names.js";
import { PathId } from "../src/ir/pathid.js";

// All expected strings below are copied verbatim from the Gel compiler-fact
// goldens (goldens/gel-compiler-facts/edgeql_select/...) so this file pins
// byte-for-byte parity with how Gel mints synthetic PathId names.

describe("name mangling (edb/schema/name.py)", () => {
  it("mangle_name: '::'->'|', '@'->'&', escapes existing '|'/'&'", () => {
    expect(mangleName("default::User")).toBe("default|User");
    expect(mangleName("__::name")).toBe("__|name");
    // Round-tripping a view type name through a qualifier (note '|'->'||',
    // '@'->'&', '::'->'|'). From test_edgeql_select_computable_33.
    expect(mangleName("__derived__::default|User@view~1")).toBe(
      "__derived__|default||User&view~1",
    );
  });

  it("get_specialized_name: mangle(base)@mangle(quals...)", () => {
    expect(getSpecializedName("__::name", "default::User")).toBe(
      "__|name@default|User",
    );
  });
});

describe("pointer full-names (debug PathId rendering)", () => {
  // From test_edgeql_select_computable_33 path_ids[].
  it("renders a schema pointer's fully-qualified name", () => {
    expect(pointerFullName("default", "name", "default::User")).toBe(
      "default::__|name@default|User",
    );
    expect(pointerFullName("default", "id", "default::Issue")).toBe(
      "default::__|id@default|Issue",
    );
  });

  it("renders a computed pointer rooted in a view type", () => {
    expect(
      pointerFullName("__derived__", "todo_ids", "__derived__::default|User@view~1"),
    ).toBe("__derived__::__|todo_ids@__derived__|default||User&view~1");
  });

  it("derivedPointerName is the __derived__-module shorthand", () => {
    expect(
      derivedPointerName("todo_ids", "__derived__::default|User@view~1"),
    ).toBe("__derived__::__|todo_ids@__derived__|default||User&view~1");
  });
});

describe("derived type/expr names", () => {
  it("derivedExprName wraps an alias in the __derived__ module", () => {
    expect(derivedExprName("expr~3")).toBe("__derived__::expr~3");
  });

  it("deriveViewTypeName specializes a base type with a view alias", () => {
    // From test_edgeql_select_computable_33: SELECT User { ... } result type.
    expect(deriveViewTypeName("default::User", "view~1")).toBe(
      "__derived__::default|User@view~1",
    );
  });
});

describe("AliasGenerator (edb/common/compiler.py)", () => {
  it("mints monotonic per-hint serials", () => {
    const aliases = new AliasGenerator();
    expect(aliases.get("expr")).toBe("expr~1");
    expect(aliases.get("expr")).toBe("expr~2");
    // 'view' has its own independent counter.
    expect(aliases.get("view")).toBe("view~1");
    expect(aliases.get("expr")).toBe("expr~3");
    expect(aliases.get("view")).toBe("view~2");
  });

  it("re-bases a hint that already carries a trailing serial", () => {
    const aliases = new AliasGenerator();
    expect(aliases.get("expr~7")).toBe("expr~1");
    expect(aliases.get("expr")).toBe("expr~2");
  });

  it("defaults an empty hint to 'v'", () => {
    const aliases = new AliasGenerator();
    expect(aliases.get()).toBe("v~1");
    expect(aliases.get("")).toBe("v~2");
  });

  it("does not strip a bare trailing '~' or non-numeric suffix", () => {
    const aliases = new AliasGenerator();
    expect(aliases.get("foo~")).toBe("foo~~1");
    expect(aliases.get("foo~bar")).toBe("foo~bar~1");
  });
});

describe("PathId.fromDerived", () => {
  it("builds a synthetic derived-expression root", () => {
    // From test_edgeql_select_is_01: SELECT 5 IS int64 → (__derived__::expr~N).
    const pid = PathId.fromDerived(derivedExprName("expr~3"));
    expect(pid.toString()).toBe("(__derived__::expr~3)");
  });

  it("integrates with the alias generator", () => {
    const aliases = new AliasGenerator();
    const pid = PathId.fromDerived(derivedExprName(aliases.get("expr")));
    expect(pid.toString()).toBe("(__derived__::expr~1)");
  });
});
