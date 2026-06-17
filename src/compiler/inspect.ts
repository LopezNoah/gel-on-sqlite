// Compile inspection — the seam that runs the compile pipeline (parse → Live IR
// → SQL artifact) WITHOUT executing against SQLite, and projects a stable set of
// facts for tests and dev tooling. See CONTEXT.md ("Compile inspection",
// "Compile facts", "Canonical SQL") and the architecture review (candidate #1).
//
// This module is purely additive: it reads the existing CompilerService and adds
// no behaviour to the production path. It reports the honest, artifact-derived
// `lowersToSingleSql` fact via the shared `lowersToSingleSql` helper in
// compiler_types.ts — the same SQL gate the engine's dispatch consumes (candidate
// #2 unified that predicate; see docs/adr/0003). It also reports the 3-way
// `strategy` fact (sql / runtime / reject) via `classifyExecutionStrategy` — the
// same classifier the engine dispatches on (docs/adr/0004), so the inspector's
// verdict matches what the engine actually does.

import type { Statement } from "../edgeql/ast.js";
import { parseEdgeQLScript } from "../edgeql/parser.js";
import { lowersToSingleSql, type GelIRSQLArtifact } from "../sql/compiler_types.js";
import { classifyExecutionStrategy, type ExecutionStrategy } from "./execution_strategy.js";
import { parseDeclarativeSchema } from "../schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../schema/uiSchema.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { getCompilerService, type CompileArtifact, type CompileContext } from "./service.js";

/** The node-kind skeleton of the Live IR — ids, names, and literals stripped, so
 *  it asserts expression *structure*, not content, and is stable under value or
 *  parameter changes. */
export interface IRNodeKind {
  kind: string;
  children: IRNodeKind[];
}

/** The always-on facts. A pure projection of the CompileArtifact + AST. Every
 *  field is true of the artifact as compiled — no heuristics, nothing that can
 *  lie. These are the stable test surface that guards lowering refactors. */
export interface CompileFacts {
  /** AST statement.kind — the routing discriminator (select / group / insert …). */
  statementKind: string;
  loweringMode: GelIRSQLArtifact["loweringMode"];
  /** The engine's SQL gate, verbatim: did this compile to one runnable statement?
   *  This is exactly the predicate engine.ts checks to decide SQL-vs-runtime. */
  lowersToSingleSql: boolean;
  /** How the engine runs this query: "sql" (off the artifact), "runtime" (the
   *  runtime evaluator / write path), or "reject" (E_UNSUPPORTED). Computed via
   *  the same classifier the engine dispatches on — guaranteed to match. */
  strategy: ExecutionStrategy;
  /** Distinct positional placeholders bound in the SQL artifact. */
  paramCount: number;
  /** Coarse structural signatures, counted off the canonical SQL. */
  subqueryCount: number;
  cteCount: number;
  /** Node-kind skeleton of the Live IR (gelIr). */
  irKindTree: IRNodeKind;
}

export interface InspectError {
  phase: "parse" | "compile";
  code: string;
  message: string;
}

/** The whole inspection result. NEVER throws on a query problem — parse and
 *  compile failures are captured into `error` with `ok:false`, so a golden test
 *  can assert "this rejects with code X" as a first-class fact and a CLI can
 *  print the failure instead of crashing. `ast` survives a compile error (it
 *  parsed), so tooling can still dump the tree of a query that won't lower. */
export interface Inspection {
  ok: boolean;
  query: string;
  ast?: Statement;
  facts?: CompileFacts;
  artifact?: CompileArtifact;
  error?: InspectError;
  /** Canonical (alias- and whitespace-normalized) SQL. "" when !ok or no SQL.
   *  Pure function of the artifact; never recompiles. */
  sql(): string;
}

/** A reusable inspector bound to one schema (+ optional context). Bind once per
 *  test file, then call with just a query — no hidden global, no magic default. */
export interface Inspector {
  inspect(query: string): Inspection;
  /** Terse common path: returns the facts, or THROWS if the query doesn't
   *  compile. Use `inspect(q).ok` when asserting a rejection. */
  facts(query: string): CompileFacts;
}

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown }).code;
  return typeof c === "string" ? c : "E_ERROR";
};

/** Run parse → compile for one statement against `schema`, capturing failures. */
export function inspect(
  schema: SchemaSnapshot,
  query: string,
  context: CompileContext = {},
): Inspection {
  const fail = (error: InspectError, ast?: Statement): Inspection => ({
    ok: false,
    query,
    ast,
    error,
    sql: () => "",
  });

  let statements: Statement[];
  try {
    statements = parseEdgeQLScript(query);
  } catch (e) {
    return fail({ phase: "parse", code: codeOf(e), message: (e as Error).message });
  }
  if (statements.length !== 1) {
    return fail({
      phase: "parse",
      code: "E_MULTI",
      message: `inspect takes exactly one statement; got ${statements.length}`,
    });
  }
  const ast = statements[0];

  let artifact: CompileArtifact;
  try {
    artifact = getCompilerService().compile(schema, ast, context);
  } catch (e) {
    return fail({ phase: "compile", code: codeOf(e), message: (e as Error).message }, ast);
  }

  const canonical = canonicalizeSql(artifact.sql.sql);
  const facts: CompileFacts = {
    statementKind: ast.kind,
    loweringMode: artifact.sql.loweringMode,
    lowersToSingleSql: lowersToSingleSql(artifact.sql),
    strategy: classifyExecutionStrategy(ast, artifact.sql, schema),
    paramCount: artifact.sql.params.length,
    subqueryCount: countMatches(canonical, /\(\s*select\b/gi),
    cteCount: countMatches(canonical, /\bwith\b/gi),
    irKindTree: irKindTree(artifact.gelIr),
  };

  return {
    ok: true,
    query,
    ast,
    facts,
    artifact,
    sql: () => canonical,
  };
}

/** Bind an inspector to a schema. */
export function inspectorFor(schema: SchemaSnapshot, context: CompileContext = {}): Inspector {
  return {
    inspect: (query) => inspect(schema, query, context),
    facts: (query) => {
      const r = inspect(schema, query, context);
      if (!r.ok || !r.facts) {
        throw new Error(
          `inspect.facts(): query did not compile [${r.error?.code}] ${r.error?.message}\n  query: ${query}`,
        );
      }
      return r.facts;
    },
  };
}

/** Pure convenience for adapters: build a SchemaSnapshot from SDL source. The
 *  fixture-file reading (the local-substitutable dependency) stays in the
 *  adapters; this is just the in-process parse. */
export function schemaFromSdl(source: string, module = "default"): SchemaSnapshot {
  const decl = parseDeclarativeSchema(`module ${module} {\n${source}\n}`, {
    legacySyntaxCompat: true,
  });
  return schemaSnapshotFromDeclarative(decl);
}

// ---------------------------------------------------------------------------
// Canonical SQL — rename generated aliases to stable positional tokens (by
// first appearance) and collapse whitespace, so a golden only changes when the
// lowering actually changes, not when an unrelated alias counter shifts.
// ---------------------------------------------------------------------------

// Generated, unquoted alias families emitted by the SQL lowering. Real columns
// and table names are always quoted ("..."), so matching bare lowercase tokens
// is safe. The `_[a-z]+(?:_\d+)?` arm covers projection bases / link joins
// (`_pb`, `_pl_0`, …); the rest cover source/pointer/join/tuple/group aliases.
const GENERATED_ALIAS =
  /\b(?:g\d+|p\d+|j\d+|tuple_\d+|grp_src|g_agg|grp\d+|agg\d+|scope\d+|_[a-z]+(?:_\d+)?)\b/g;

export function canonicalizeSql(sql: string): string {
  if (!sql) return "";
  const rename = new Map<string, string>();
  const renamed = sql.replace(GENERATED_ALIAS, (m) => {
    let token = rename.get(m);
    if (token === undefined) {
      token = `a${rename.size}`;
      rename.set(m, token);
    }
    return token;
  });
  return renamed.replace(/\s+/g, " ").trim();
}

const countMatches = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

// ---------------------------------------------------------------------------
// IR node-kind skeleton.
// ---------------------------------------------------------------------------

// Type plumbing carries no expression structure and bloats the skeleton; skip it.
const SKIP_KEYS = new Set(["typeref", "pathId", "schema", "ptrref", "stype"]);

function irKindTree(node: unknown): IRNodeKind {
  const root = collectNode(node);
  return root ?? { kind: "statement", children: [] };
}

function collectNode(value: unknown): IRNodeKind | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const children: IRNodeKind[] = [];
  for (const [key, v] of Object.entries(obj)) {
    if (key === "kind" || SKIP_KEYS.has(key)) continue;
    gather(v, children);
  }
  const kind = typeof obj.kind === "string" ? obj.kind : null;
  if (kind === null) return children.length ? { kind: "_group", children } : null;
  return { kind, children };
}

function gather(value: unknown, into: IRNodeKind[]): void {
  if (Array.isArray(value)) {
    for (const item of value) gather(item, into);
    return;
  }
  const node = collectNode(value);
  if (node) into.push(node);
}
