import { createHash } from "node:crypto";

import "../codegen/generated/schema_model.js";

import type { Statement } from "../edgeql/ast.js";
import { AppError } from "../errors.js";
import type { Set as GelIRSet, Statement as GelIRStatement, TypeRef as GelIRTypeRef } from "../ir/gel_ir.js";
import type { IRStatement, OverlayIR } from "../ir/model.js";
import type { RuntimeTarget } from "../runtime/target.js";
import { qualifiedTypeName, type SchemaSnapshot } from "../schema/schema.js";
import { compileGelIRToSQL, type GelIRSQLArtifact } from "../sql/gel_ir_compiler.js";
import type { ScalarValue } from "../types.js";
import { compileToIR } from "./semantic.js";
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
  ir: IRStatement;
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
  ir: IRStatement;
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
        gelIr: cloneValue(cached.gelIr),
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
    // degrades to the fallback artifact and the runtime grouper (via the
    // legacy IR below) keeps handling the statement.
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
    let ir: ReturnType<typeof traceIRFromGelIR>;
    try {
      // Mutations compile through the standalone DML lowering (runtime
      // mutation plan) — the legacy semantic.ts pipeline is group-only now.
      // Keep this after compileSqlFromGelIR so gelIR compile errors retain
      // precedence over plan validation errors, matching the legacy order.
      ir = statement.kind === "insert" || statement.kind === "update" || statement.kind === "delete"
        ? compileDmlToIR(schema, statement, { globals: context.globals, allowUserSpecifiedId: context.allowUserSpecifiedId })
        : needsLegacyRuntimeIR(statement)
          ? compileToIR(schema, statement, {
              overlays: context.overlays,
              globals: context.globals,
              schemaModel: context.schemaModel,
              schemaModelName: context.schemaModelName,
            })
          : traceIRFromGelIR(statement, gelIr);
    } catch (err) {
      // The legacy pipeline can't model some group statements the gelIR
      // pipeline lowers fully (e.g. chained group-rows bindings). When the
      // SQL artifact is complete, the engine executes it directly and only
      // reads the IR's kind — synthesize it from the gelIR instead of
      // failing the whole compile. Scoped to group-wrapping selects: for
      // everything else (DML validation in particular) the legacy error is
      // the intended behavior.
      if (isSelectExprWrappingGroup && sql.loweringMode === "single_statement" && sql.sql.length > 0) {
        ir = traceIRFromGelIR(statement, gelIr);
      } else {
        throw err;
      }
    }
    this.cache.set(key, {
      ir: cloneValue(ir),
      gelIr: cloneValue(gelIr),
      sql: cloneValue(sql),
    });

    return {
      ir,
      gelIr,
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
  const schemaFingerprint = fingerprintSchema(schema);
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

const makeTypeColumnsResolver = (schema: SchemaSnapshot): (typeName: string) => Set<string> | undefined => {
  const cache = new Map<string, Set<string>>();
  // An inline single link (no link properties) stores a `<link>_id` FK column,
  // which the schema also lists as a field on the declaring type. A subtype can
  // override the link's storage (e.g. overloading it with properties → link
  // table), so that subtype's table has NO such column even though it inherits
  // the base's field list. Walking subtype→base with first-seen-wins on link
  // names lets the most-derived definition decide: when a link resolves to
  // non-inline storage, its `<link>_id` FK is excluded from the inherited
  // fields, so the polymorphic source projects NULL there instead of
  // referencing a missing column.
  const collect = (
    qualifiedName: string,
    accumulator: Set<string>,
    seen: Set<string>,
    seenLinks: Set<string>,
    excludeFKs: Set<string>,
  ): void => {
    if (seen.has(qualifiedName)) return;
    seen.add(qualifiedName);
    const typeDef = schema.getType(qualifiedName);
    if (!typeDef) return;
    // Resolve link storage first so FK-field exclusions are known before we
    // add (possibly inherited) fields.
    for (const link of typeDef.links ?? []) {
      if (seenLinks.has(link.name)) continue;
      seenLinks.add(link.name);
      const fkColumn = `${link.name}_id`;
      if (!link.multi && (link.properties?.length ?? 0) === 0) {
        accumulator.add(fkColumn);
      } else {
        excludeFKs.add(fkColumn);
      }
    }
    for (const field of typeDef.fields ?? []) {
      if (!excludeFKs.has(field.name)) {
        accumulator.add(field.name);
      }
    }
    for (const baseName of typeDef.extends ?? []) {
      collect(baseName, accumulator, seen, seenLinks, excludeFKs);
    }
  };
  return (typeName: string): Set<string> | undefined => {
    const existing = cache.get(typeName);
    if (existing) return existing;
    const columns = new Set<string>(["id"]);
    collect(typeName, columns, new Set<string>(), new Set<string>(), new Set<string>());
    if (columns.size === 1 && !schema.getType(typeName)) {
      return undefined;
    }
    cache.set(typeName, columns);
    return columns;
  };
};

// Mirror of the runtime's `resolveLinkStorageOwner`: inherited link tables
// live on the most-base type where the link is defined (e.g. `Owned.owner`
// stays in `default__owned__owner`, not in each subtype's own table).
const makeLinkStorageTypeResolver = (schema: SchemaSnapshot): (sourceTypeName: string, linkName: string) => string | undefined => {
  const cache = new Map<string, string>();
  return (sourceTypeName: string, linkName: string): string | undefined => {
    const key = `${sourceTypeName}|${linkName}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const typeDef = schema.getType(sourceTypeName);
    if (!typeDef) return undefined;
    const link = (typeDef.links ?? []).find((l) => l.name === linkName);
    if (!link) return undefined;
    if (link.overloaded) {
      cache.set(key, sourceTypeName);
      return sourceTypeName;
    }
    let ownerName = sourceTypeName;
    let current: typeof typeDef | undefined = typeDef;
    while (current && (current.extends ?? []).length > 0) {
      const nextBaseName = current.extends?.[0];
      if (!nextBaseName) break;
      const baseType = schema.getType(nextBaseName);
      if (!baseType) break;
      const baseLink = (baseType.links ?? []).find((l) => l.name === linkName);
      if (!baseLink || baseLink.overloaded) break;
      ownerName = nextBaseName.includes("::") ? nextBaseName : `${baseType.module ?? "default"}::${baseType.name}`;
      current = baseType;
    }
    cache.set(key, ownerName);
    return ownerName;
  };
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
    resolveTypeColumns: makeTypeColumnsResolver(schema),
    resolveLinkStorageType: makeLinkStorageTypeResolver(schema),
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

const needsLegacyRuntimeIR = (statement: Statement): boolean => {
  if (statement.kind === "group") {
    return true;
  }
  // `SELECT (GROUP X BY Y) [FILTER … ORDER BY …]` — peelGroupExprFromSelectExpr
  // in compileToIR rewrites this to a GroupIR; routing it through the legacy
  // IR builder is the only way the runtime grouper (runGroupIR) gets a
  // GroupIR for this AST shape.
  if (statement.kind === "select_expr") {
    return selectExprContainsGroup(statement);
  }
  return false;
};

// Detect a `group_expr` anywhere inside a select_expr statement — directly in
// the result expression (under any chain of shape_projection / subquery /
// field-access wrappers) or inside a WITH binding's value. Any such statement
// must route through the legacy semantic.ts pipeline (compileToIR), whose
// peelGroupExprFromSelectExpr lowers the GROUP to a runtime GroupIR; the GelIR
// pipeline has no model for group_expr in expression position.
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

const traceIRFromGelIR = (statement: Statement, gelIr: GelIRStatement): IRStatement => {
  if (statement.kind === "select") {
    const sourceSet = unwrapGelSelectResultSet(gelIr.expr);
    const sourceType = sourceSet.typeref && !sourceSet.typeref.isScalar
      ? qualifiedGelTypeName(sourceSet.typeref)
      : "std::Object";
    return {
      kind: "select",
      sourceType,
      table: tableNameForGelType(sourceType),
      columns: ["id"],
      shape: [],
      filter: undefined,
      orderBy: undefined,
      limit: undefined,
      offset: undefined,
      pathId: { id: sourceType, steps: [] },
      scopeTree: { id: "trace", children: [] },
      appliedOverlays: [],
    } as unknown as IRStatement;
  }

  if (statement.kind === "select_free") {
    return {
      kind: "select_free",
      entries: [],
      pathId: { id: "select_free", steps: [] },
      scopeTree: { id: "trace", children: [] },
    } as unknown as IRStatement;
  }

  return {
    kind: "select_expr",
    entries: [],
    pathId: { id: "select_expr", steps: [] },
    scopeTree: { id: "trace", children: [] },
  } as unknown as IRStatement;
};

const unwrapGelSelectResultSet = (set: GelIRSet): GelIRSet => {
  let current = set;
  while (current.expr.kind === "select_expr") {
    const result = (current.expr as { result?: GelIRSet }).result;
    if (!result) break;
    current = result;
  }
  return current;
};

const qualifiedGelTypeName = (typeref: GelIRTypeRef): string =>
  typeref.nameHint.includes("::") ? typeref.nameHint : `${typeref.module}::${typeref.nameHint}`;

const tableNameForGelType = (qualifiedName: string): string => qualifiedName.replaceAll("::", "__").toLowerCase();

// The schema fingerprint feeds the compile-cache key and is identical for
// every query run against an unchanged schema, yet recomputing it (normalize
// every type/link/function/global, then stableJson) was ~46% of a simple
// query's cost. Memoize it per snapshot instance, invalidating only when the
// snapshot's mutationVersion changes (i.e. after DDL). A WeakMap keeps this
// from pinning snapshots in memory.
const schemaFingerprintCache = new WeakMap<SchemaSnapshot, { version: number; fingerprint: string }>();

const fingerprintSchema = (schema: SchemaSnapshot): string => {
  const cached = schemaFingerprintCache.get(schema);
  if (cached && cached.version === schema.mutationVersion) {
    return cached.fingerprint;
  }
  const fingerprint = computeSchemaFingerprint(schema);
  schemaFingerprintCache.set(schema, { version: schema.mutationVersion, fingerprint });
  return fingerprint;
};

const computeSchemaFingerprint = (schema: SchemaSnapshot): string => {
  const types = schema
    .listTypes()
    .map((typeDef) => ({
      name: qualifiedTypeName(typeDef),
      fields: typeDef.fields
        .map((field) => ({
          name: field.name,
          type: field.type,
          required: Boolean(field.required),
          multi: Boolean(field.multi),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      links: (typeDef.links ?? [])
        .map((link) => ({
          name: link.name,
          targetType: link.targetType,
          multi: Boolean(link.multi),
          properties: (link.properties ?? []).map((property) => ({
            name: property.name,
            type: property.type,
            required: Boolean(property.required),
          })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      mutationRewrites: (typeDef.mutationRewrites ?? [])
        .map((rewrite) => ({
          field: rewrite.field,
          onInsert: rewrite.onInsert,
          onUpdate: rewrite.onUpdate,
        }))
        .sort((a, b) => a.field.localeCompare(b.field)),
      triggers: (typeDef.triggers ?? [])
        .map((trigger) => ({
          name: trigger.name,
          event: trigger.event,
          scope: trigger.scope ?? "each",
          when: trigger.when,
          actions: trigger.actions,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      accessPolicies: (typeDef.accessPolicies ?? [])
        .map((policy) => ({
          name: policy.name,
          effect: policy.effect,
          operations: [...policy.operations].sort(),
          condition: policy.condition,
          errmessage: policy.errmessage,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Functions participate in the cache key: an inlined UDF's body is spliced
  // into the compiled SQL, so two schemas that share types but define a
  // different `foo` (e.g. across tests that each `CREATE FUNCTION foo …`) must
  // not collide on the same cached artifact. Include signature + body.
  const functions = schema
    .listFunctions()
    .map((fn) => ({
      module: fn.module,
      name: fn.name,
      params: fn.params.map((p) => ({ name: p.name, type: p.type, optional: Boolean(p.optional), variadic: Boolean(p.variadic), setOf: Boolean(p.setOf), default: p.default })),
      returnType: fn.returnType,
      returnOptional: Boolean(fn.returnOptional),
      returnSetOf: Boolean(fn.returnSetOf),
      body: fn.body,
    }))
    .sort((a, b) => `${a.module}::${a.name}`.localeCompare(`${b.module}::${b.name}`));

  // Globals likewise: a computed global's default text (or its very existence
  // as a settable global) affects how `global x` lowers.
  const globals = schema
    .listGlobals()
    .map((g) => ({ module: g.module, name: g.name, exprText: g.exprText }))
    .sort((a, b) => `${a.module}::${a.name}`.localeCompare(`${b.module}::${b.name}`));

  return stableJson({ types, functions, globals });
};

const stableJson = (value: unknown): string => JSON.stringify(sortValue(value));

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, entryValue] of entries) {
      out[key] = sortValue(entryValue);
    }
    return out;
  }

  return value;
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
