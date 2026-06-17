import { createHash } from "node:crypto";

import "../codegen/generated/schema_model.js";

import type { Statement } from "../edgeql/ast.js";
import { AppError } from "../errors.js";
import type { Set as GelIRSet, Statement as GelIRStatement, TypeRef as GelIRTypeRef } from "../ir/gel_ir.js";
import type { IRStatement, OverlayIR } from "../ir/model.js";
import type { RuntimeTarget } from "../runtime/target.js";
import { stableJson, type SchemaSnapshot } from "../schema/schema.js";
import { makeLinkStorageOwnerResolver, makeTypeStorageColumnsResolver } from "../schema/physical_layout.js";
import { compileGelIRToSQL, type GelIRSQLArtifact } from "../sql/gel_ir_compiler.js";
import type { ScalarValue } from "../types.js";
import { compileDmlToIR } from "./dml_lowering.js";
import type { GeneratedSchema } from "../codegen/schema.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement, isGelIRCompatibleStatement } from "./ast_to_ir.js";

export interface CompilerCacheStats {
  hits: number;
  misses: number;
  size: number;
}

export interface CompilerCacheMeta {
  key: string;
  status: "hit" | "miss";
  stats: CompilerCacheStats;
}

export interface CompileArtifact {
  // The DML IR — defined only for insert/update/delete (consumed by the
  // engine's write path). For SELECT / GROUP the engine routes on
  // `statement.kind` and executes off `gelIr` + `sql`, so no legacy IR is built.
  ir: IRStatement | undefined;
  gelIr: GelIRStatement;
  sql: GelIRSQLArtifact;
  cache: CompilerCacheMeta;
}

export interface CompileContext {
  overlays?: OverlayIR[];
  params?: Record<string, ScalarValue>;
  globals?: Record<string, ScalarValue>;
  target?: RuntimeTarget;
  schemaModel?: GeneratedSchema;
  schemaModelName?: string;
  // Set when the connection ran `CONFIGURE SESSION SET allow_user_specified_id
  // := true`; lets an INSERT assign an explicit `id` instead of rejecting it.
  allowUserSpecifiedId?: boolean;
}

interface CachedCompile {
  ir: IRStatement | undefined;
  gelIr: GelIRStatement;
  sql: GelIRSQLArtifact;
}

export class CompilerService {
  private readonly cache = new Map<string, CachedCompile>();
  private hits = 0;
  private misses = 0;

  compile(schema: SchemaSnapshot, rawStatement: Statement, context: CompileContext = {}): CompileArtifact {
    // Expand schema-alias references once before lowering into IR.
    const statement = expandSchemaAliasesInStatement(rawStatement, schema);
    const key = buildCompileCacheKey(schema, statement, context);
    const cached = this.cache.get(key);

    if (cached) {
      this.hits += 1;
      return {
        ir: cloneValue(cached.ir),
        gelIr: cached.gelIr, // frozen + shared (see freezeShared) — never mutated
        sql: cloneValue(cached.sql),
        cache: {
          key,
          status: "hit",
          stats: this.stats(),
        },
      };
    }

    this.misses += 1;
    // `SELECT (GROUP X BY Y) [{…}] [FILTER …]` (group_expr in expression
    // position) lowers through the gelIR pipeline like everything else — the
    // group compiles to a `group_rows` set (see compileGroupExprSet) and the
    // statement compiler emits a real artifact for the projections/clauses
    // it supports, or an empty fallback artifact otherwise. These statements
    // were never exercised in this pipeline before, so any compile error
    // degrades to the fallback artifact and the engine's runtime grouper
    // (preEvaluateGroupBindings) keeps handling the statement.
    const isSelectExprWrappingGroup =
      statement.kind === "select_expr" && selectExprContainsGroup(statement);
    let sql: GelIRSQLArtifact;
    let gelIr: GelIRStatement;
    try {
      const compiled = compileSqlFromGelIR(schema, statement, context);
      sql = compiled.sql;
      gelIr = compiled.gelIr;
    } catch (err) {
      if (!isSelectExprWrappingGroup) throw err;
      sql = { sql: "", params: [], loweringMode: "fallback_multi_query" } as GelIRSQLArtifact;
      gelIr = { kind: "statement", expr: { kind: "set", expr: { kind: "type_root", typeref: { kind: "type_ref", id: "schema::Type", isScalar: false } }, pathId: { kind: "path_id", namespace: [], isPointerPath: false, steps: [] }, typeref: { kind: "type_ref", id: "schema::Type", isScalar: false }, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false } } as unknown as GelIRStatement;
    }
    // Mutations compile through the standalone DML lowering (the runtime
    // mutation plan — the DML IR the engine's write path consumes). Every other
    // statement — SELECT and GROUP alike — runs entirely off the gelIR SQL
    // artifact; the engine routes on `statement.kind` and never reads a legacy
    // IR for them, so none is produced. Groups that don't lower to SQL raise
    // E_UNSUPPORTED (see the group dispatch in engine.ts). DML lowering errors
    // (validation) propagate as before.
    const ir: IRStatement | undefined =
      statement.kind === "insert" || statement.kind === "update" || statement.kind === "delete"
        ? compileDmlToIR(schema, statement, { globals: context.globals, allowUserSpecifiedId: context.allowUserSpecifiedId })
        : undefined;
    const sharedGelIr = freezeShared(gelIr);
    this.cache.set(key, {
      ir: cloneValue(ir),
      gelIr: sharedGelIr,
      sql: cloneValue(sql),
    });

    return {
      ir,
      gelIr: sharedGelIr,
      sql,
      cache: {
        key,
        status: "miss",
        stats: this.stats(),
      },
    };
  }

  stats(): CompilerCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

let defaultCompilerService: CompilerService | undefined;

export const getCompilerService = (): CompilerService => {
  if (!defaultCompilerService) {
    defaultCompilerService = new CompilerService();
  }

  return defaultCompilerService;
};

export const buildCompileCacheKey = (schema: SchemaSnapshot, statement: Statement, context: CompileContext = {}): string => {
  // Memoized on the snapshot instance (and inherited by clones), so this is a
  // cache hit for every query on an unchanged schema — see contentFingerprint.
  const schemaFingerprint = schema.contentFingerprint();
  // A parsed statement always has deterministic key order (same query text →
  // same parse path → same object shape), so plain JSON.stringify is a stable
  // fingerprint here — no need for the recursive key-sorting stableJson, which
  // was ~10x slower and dominated this function. (Runtime-built objects like
  // globals/params below still use stableJson: their key order can vary.) The
  // key only affects cache hit/miss, never correctness — distinct ASTs still
  // produce distinct strings.
  const statementFingerprint = JSON.stringify(statement);
  const overlaysFingerprint = stableJson((context.overlays ?? []).map((overlay) => ({
    table: overlay.table,
    sourcePathId: overlay.sourcePathId,
    operation: overlay.operation,
    policyPhase: overlay.policyPhase,
    rewritePhase: overlay.rewritePhase,
  })));
  const globalsFingerprint = stableJson(context.globals ?? {});
  const paramsFingerprint = stableJson(context.params ?? {});
  const targetFingerprint = context.target ?? "sqlite";
  return createHash("sha256")
    .update(schemaFingerprint)
    .update("|")
    .update(statementFingerprint)
    .update("|")
    .update(overlaysFingerprint)
    .update("|")
    .update(globalsFingerprint)
    .update("|")
    .update(paramsFingerprint)
    .update("|")
    .update(targetFingerprint)
    .update("|")
    .update(context.allowUserSpecifiedId ? "uid" : "")
    .digest("hex");
};

const compileSqlFromGelIR = (
  schema: SchemaSnapshot,
  statement: Statement,
  context: CompileContext,
): { sql: GelIRSQLArtifact; gelIr: GelIRStatement } => {
  if (!isGelIRCompatibleStatement(statement)) {
    throw new AppError("E_UNSUPPORTED", `Statement kind '${statement.kind}' is not supported by GEL IR SQL lowering`);
  }

  const gelIr = compileASTToGelIR(statement, {
    module: statement.withModule,
    schema,
    schemaModel: context.schemaModel,
    schemaModelName: context.schemaModelName,
  });

  const sql = compileGelIRToSQL(gelIr as never, {
    target: context.target ?? "sqlite",
    parameterValues: context.params,
    globalValues: context.globals,
    resolveTypeColumns: makeTypeStorageColumnsResolver(schema),
    resolveLinkStorageType: makeLinkStorageOwnerResolver(schema),
    resolveEnumMembers: (typeName: string) => {
      const scalar = schema.listScalarTypes().find((s) => `${s.module}::${s.name}` === typeName);
      return scalar?.enumValues && scalar.enumValues.length > 0 ? scalar.enumValues : undefined;
    },
    resolveFieldEnumMembers: (typeName: string, fieldName: string) => {
      const typeDef = schema.getType(typeName);
      const field = typeDef?.fields.find((f) => f.name === fieldName);
      if (!field) return undefined;
      const enumName = field.enumTypeName ?? field.targetTypeName;
      if (!enumName) return undefined;
      const scalar = schema.listScalarTypes().find((s) => `${s.module}::${s.name}` === enumName);
      return scalar?.enumValues && scalar.enumValues.length > 0 ? scalar.enumValues : undefined;
    },
  });

  return {
    gelIr,
    sql,
  };
};

// Detect a `group_expr` anywhere inside a select_expr statement — directly in
// the result expression (under any chain of shape_projection / subquery /
// field-access wrappers) or inside a WITH binding's value. The SQL lowering has
// no model for group_expr in expression position, so such a statement degrades
// to a fallback artifact and the engine runs it through the runtime grouper
// (preEvaluateGroupBindings in engine.ts).
const nodeContainsGroup = (node: unknown, seen: Set<unknown>): boolean => {
  if (!node || typeof node !== "object") return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if ((node as { kind?: unknown }).kind === "group_expr") return true;
  if (Array.isArray(node)) {
    return node.some((item) => nodeContainsGroup(item, seen));
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (value && typeof value === "object" && nodeContainsGroup(value, seen)) {
      return true;
    }
  }
  return false;
};

const selectExprContainsGroup = (
  statement: Extract<Statement, { kind: "select_expr" }>,
): boolean => {
  const seen = new Set<unknown>();
  if (nodeContainsGroup(statement.expr, seen)) return true;
  for (const binding of statement.with ?? []) {
    if (nodeContainsGroup(binding.value, seen)) return true;
  }
  return false;
};

// The compiler cache hands out a private deep copy of each artifact (consumers
// mutate the IR during execution, so the cached copy must stay pristine).
// `structuredClone` is ~6.5x faster than the previous `JSON.parse(JSON.stringify)`
// round-trip on these IR trees, and cloning was 70-80% of total query time.
// Semantics are equivalent for this plain-data IR (no functions/symbols/cycles).
const cloneValue = <T>(value: T): T => {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  return structuredClone(value);
};

// The gelIR tree is the largest artifact (~100KB for a nested shape; ~96% of
// the per-query clone cost). Unlike `ir`/`sql`, no execution path mutates it —
// it's read-only input to runGelSelectSQL / the runtime evaluators (verified by
// deep-freezing it and running the whole suite: zero mutation throws). So we
// freeze it once and share the single frozen instance across cache hits instead
// of cloning it per query. Freezing keeps the read-only contract enforced: any
// future code that tries to mutate it throws loudly rather than silently
// corrupting the cache.
const freezeShared = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    freezeShared((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
};
