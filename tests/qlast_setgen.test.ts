import { describe, expect, it } from "vitest";
import { loadSchema } from "../src/schema/load.js";
import { resolveSchemaModelForCompile } from "../src/codegen/schema_loader.js";
import { AliasGenerator } from "../src/ir/derived_names.js";
import { serializePathId } from "../src/ir/pathid_format.js";
import { compilePathQlast } from "../src/compiler/qlast_setgen.js";
import type { IRCompileContext } from "../src/compiler/ast_to_ir.js";
import type { Pointer, TypeRoot } from "../src/ir/gel_ir.js";
import type {
  ObjectRef,
  Path,
  Ptr,
  TypeIntersection,
  TypeName,
} from "../src/edgeql/qlast.js";

// Tracer bullet for the qlast-based AST→IR port: drive `compilePathQlast`
// (a faithful port of Gel's setgen.py `compile_path`) directly with hand-built
// qlast `Path` nodes, against a real SchemaSnapshot + Live IR. Proves the
// transcription produces well-formed IR `Set`s. See src/compiler/qlast_setgen.ts.

const schema = loadSchema(
  `module default {
    type Movie {
      required title: str;
      multi reviews: Review;
    }
    type Film extending Movie;
    type Review {
      required body: str;
    }
  }`,
  { legacySyntaxCompat: true },
);

const makeCtx = (): IRCompileContext => ({
  module: "default",
  schema,
  schemaModel: resolveSchemaModelForCompile({ schema }),
  nextScopeId: 2,
  params: new Map(),
  globals: new Map(),
  bindingScopes: [new Map()],
  aliases: new AliasGenerator(),
});

// ── qlast node-literal builders ──
const objectRef = (name: string, module?: string): ObjectRef => ({
  __kind__: "ObjectRef",
  name,
  ...(module ? { module } : {}),
});
const ptr = (name: string, direction?: string): Ptr => ({
  __kind__: "Ptr",
  name,
  ...(direction ? { direction } : {}),
});
const typeName = (name: string): TypeName => ({
  __kind__: "TypeName",
  maintype: objectRef(name),
});
const typeIntersection = (name: string): TypeIntersection => ({
  __kind__: "TypeIntersection",
  type: typeName(name),
});
const path = (steps: Path["steps"], partial = false): Path => ({
  __kind__: "Path",
  steps,
  partial,
  allow_factoring: false,
});

describe("compilePathQlast (qlast → Live IR tracer bullet)", () => {
  it("builds a type-root Set for a bare object reference", () => {
    const set = compilePathQlast(path([objectRef("Movie")]), makeCtx());
    expect(set.kind).toBe("set");
    expect(set.expr.kind).toBe("type_root");
    expect((set.expr as TypeRoot).typeref.nameHint).toContain("Movie");
    expect(set.typeref.nameHint).toContain("Movie");
  });

  it("builds a pointer Set for `Movie.title`", () => {
    const set = compilePathQlast(path([objectRef("Movie"), ptr("title")]), makeCtx());
    expect(set.expr.kind).toBe("pointer");
    const p = set.expr as Pointer;
    expect(p.ptrref.shortName).toBe("title");
    expect(p.direction).toBe("outbound");
    expect(p.source.expr.kind).toBe("type_root");
    expect(set.typeref.isScalar).toBe(true);
    expect(set.pathId.isPointerPath).toBe(true);
  });

  it("chains pointer steps for `Movie.reviews.body`", () => {
    const set = compilePathQlast(
      path([objectRef("Movie"), ptr("reviews"), ptr("body")]),
      makeCtx(),
    );
    expect(set.expr.kind).toBe("pointer");
    const body = set.expr as Pointer;
    expect(body.ptrref.shortName).toBe("body");
    const reviews = body.source.expr as Pointer;
    expect(reviews.ptrref.shortName).toBe("reviews");

    const serialized = serializePathId(set.pathId);
    expect(serialized).toContain("reviews");
    expect(serialized).toContain("body");
  });

  it("narrows on `Movie[is Film]`", () => {
    const set = compilePathQlast(
      path([objectRef("Movie"), typeIntersection("Film")]),
      makeCtx(),
    );
    expect(set.typeref.nameHint).toContain("Film");
  });

  it("resolves a partial path `.title` against the bound subject", () => {
    const ctx = makeCtx();
    // Seed `__subject__` as a Movie extent — what a shape/FILTER context binds.
    const movie = compilePathQlast(path([objectRef("Movie")]), ctx);
    ctx.bindingScopes[ctx.bindingScopes.length - 1]!.set("__subject__", movie);

    const set = compilePathQlast(path([ptr("title")], true), ctx);
    expect(set.expr.kind).toBe("pointer");
    expect((set.expr as Pointer).ptrref.shortName).toBe("title");
  });

  it("rejects an unknown pointer", () => {
    expect(() =>
      compilePathQlast(path([objectRef("Movie"), ptr("nope")]), makeCtx()),
    ).toThrow(/unknown pointer 'nope'/);
  });

  it("marks link-property steps as DEFERRED (honest gap, not a silent bug)", () => {
    expect(() =>
      compilePathQlast(
        path([objectRef("Movie"), ptr("reviews"), ptr("@rating")]),
        makeCtx(),
      ),
    ).toThrow(/DEFERRED: link-property/);
  });
});
