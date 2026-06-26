import { describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { loadSchema } from "../src/schema/load.js";
import { resolveSchemaModelForCompile } from "../src/codegen/schema_loader.js";
import { AliasGenerator } from "../src/ir/derived_names.js";
import { compileFreeObjectExpr, qlastPathDeps } from "../src/compiler/ast_to_ir.js";
import type { IRCompileContext } from "../src/compiler/ast_to_ir.js";
import { compilePathQlast } from "../src/compiler/qlast_setgen.js";
import { astPathExprToQlast } from "../src/compiler/ast_to_qlast.js";
import type { FreeObjectExpr } from "../src/edgeql/ast.js";
import type { Pointer, Set as IRSet } from "../src/ir/gel_ir.js";

// Differential parity harness for the qlast path-compilation migration.
//
// For each real EdgeQL query: parse it (ast.ts), find the outermost path-shaped
// expression, run BOTH the live compiler (`compileFreeObjectExpr`, the oracle)
// and the migrated path: `astPathExprToQlast` (strangler bridge) →
// `compilePathQlast` (qlast-consuming port). Compare the *path signature* of the
// two IR `Set`s — the ordered (pointer, direction, result-type) chain down to
// the root. This ignores incidental differences (shape, pathId minting, binding
// flags) and isolates whether the same PATH was built.
//
// Each corpus entry declares its expected status, turning this into a living
// frontier map. As the bridge + port grow, entries flip from a gap to "match".

const schema = loadSchema(
  `module default {
    type Movie {
      required title: str;
      multi reviews: Review {
        rating: int64;
      }
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

const PATH_KINDS = new Set([
  "field_access",
  "path",
  "path_chain",
  "path_steps",
  "binding_ref",
  "backlink_path",
  "select",
]);

// Outermost (pre-order first) path-shaped node in the parsed statement.
const findPathExpr = (root: unknown): FreeObjectExpr | null => {
  let found: FreeObjectExpr | null = null;
  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as { kind?: unknown };
    if (typeof node.kind === "string" && PATH_KINDS.has(node.kind)) {
      found = value as FreeObjectExpr;
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  return found;
};

// The ordered pointer chain from root to tip — the essence of "which path".
const pathSig = (set: IRSet): string => {
  const chain: string[] = [];
  let cur: IRSet | undefined = set;
  while (cur && cur.expr && cur.expr.kind === "pointer") {
    const ptr = cur.expr as Pointer;
    chain.unshift(`ptr:${ptr.ptrref.shortName}:${ptr.direction}:${cur.typeref.id}`);
    cur = ptr.source;
  }
  if (cur) chain.unshift(`base:${cur.expr.kind}:${cur.typeref.id}`);
  return chain.join(" / ");
};

type Status = "match" | "diverge" | "adapter-null" | "no-path-expr" | `ported-threw:${string}` | "baseline-threw";

const parityStatus = (query: string): Status => {
  const ast = parseEdgeQL(query);
  const stmt = Array.isArray(ast) ? ast[0] : ast;
  const pathExpr = findPathExpr(stmt);
  if (!pathExpr) return "no-path-expr";

  const qlPath = astPathExprToQlast(pathExpr);
  if (!qlPath) return "adapter-null";

  let ported: IRSet;
  try {
    ported = compilePathQlast(qlPath, makeCtx(), qlastPathDeps);
  } catch (error) {
    return `ported-threw:${(error as Error).message.split(" (")[0]}`;
  }

  let baseline: IRSet;
  try {
    baseline = compileFreeObjectExpr(pathExpr, makeCtx());
  } catch {
    return "baseline-threw";
  }

  return pathSig(ported) === pathSig(baseline) ? "match" : "diverge";
};

// The frontier map (statuses are OBSERVED, not aspirational). "match" = the
// migrated path reproduces the live compiler's path signature on real parser
// output. "adapter-null" = a path form the bridge doesn't yet convert (caller
// falls back to the live compiler) — promote to "match" once bridged + ported.
//
// Also observed, documented here rather than pinned as a brittle assertion:
//   SELECT Movie.nonexistent  → compilePathQlast raises (Gel-style
//   InvalidReferenceError), while the live baseline silently degrades to the
//   root set. A real latent divergence in the baseline's error handling.
const CORPUS: { query: string; expect: Status }[] = [
  // ── at parity: bare-type root, forward links, chains, [IS T] narrowing ──
  { query: "SELECT Movie.title", expect: "match" },
  { query: "SELECT Movie.reviews", expect: "match" },
  { query: "SELECT Movie.reviews.body", expect: "match" },
  { query: "SELECT Film.title", expect: "match" },
  { query: "SELECT Movie[IS Film]", expect: "match" },
  { query: "SELECT Movie[IS Film].title", expect: "match" },
  { query: "SELECT Review.<reviews[IS Movie]", expect: "match" },
  { query: "SELECT Movie.reviews@rating", expect: "match" }, // link property — now ported
  // ── deferred frontier (bridge returns null; live compiler still handles) ──
  { query: "SELECT Movie { title }", expect: "adapter-null" }, // shaped select, not a pure path
  { query: "SELECT Review.<reviews[IS Movie].title", expect: "adapter-null" }, // backlink+access (parsed as for_expr)
];

describe("qlast path parity: bridge + compilePathQlast vs live compiler", () => {
  for (const { query, expect: expected } of CORPUS) {
    it(`${query}  →  ${expected}`, () => {
      expect(parityStatus(query)).toBe(expected);
    });
  }
});

// The gate itself: with GEL_QLAST_PATHS=1, compileFreeObjectExpr routes path
// expressions through compilePathQlast. Proves that routing is behaviour-neutral
// — the routed IR's path signature equals the legacy compiler's.
describe("gate GEL_QLAST_PATHS=1 routes paths and preserves behaviour", () => {
  const ROUTED = [
    "SELECT Movie.title",
    "SELECT Movie.reviews.body",
    "SELECT Movie[IS Film].title",
    "SELECT Movie.reviews@rating",
  ];
  for (const query of ROUTED) {
    it(`routed == legacy: ${query}`, () => {
      const ast = parseEdgeQL(query);
      const stmt = Array.isArray(ast) ? ast[0] : ast;
      const pathExpr = findPathExpr(stmt);
      expect(pathExpr).toBeTruthy();

      const legacy = compileFreeObjectExpr(pathExpr!, makeCtx());
      const prev = process.env.GEL_QLAST_PATHS;
      process.env.GEL_QLAST_PATHS = "1";
      try {
        const routed = compileFreeObjectExpr(pathExpr!, makeCtx());
        expect(pathSig(routed)).toBe(pathSig(legacy));
      } finally {
        if (prev === undefined) delete process.env.GEL_QLAST_PATHS;
        else process.env.GEL_QLAST_PATHS = prev;
      }
    });
  }
});
