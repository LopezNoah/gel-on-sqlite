import { createHash } from "node:crypto";

import type { Statement } from "../edgeql/ast.js";
import type { IRStatement, OverlayIR } from "../ir/model.js";
import type { RuntimeTarget } from "../runtime/target.js";
import { qualifiedTypeName, type SchemaSnapshot } from "../schema/schema.js";
import { compileToSQL, type SQLArtifact } from "../sql/compiler.js";
import type { ScalarValue } from "../types.js";
import { compileToIR } from "./semantic.js";

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
  sql: SQLArtifact;
  cache: CompilerCacheMeta;
}

export interface CompileContext {
  overlays?: OverlayIR[];
  globals?: Record<string, ScalarValue>;
  target?: RuntimeTarget;
}

interface CachedCompile {
  ir: IRStatement;
  sql: SQLArtifact;
}

export class CompilerService {
  private readonly cache = new Map<string, CachedCompile>();
  private hits = 0;
  private misses = 0;

  compile(schema: SchemaSnapshot, statement: Statement, context: CompileContext = {}): CompileArtifact {
    const key = buildCompileCacheKey(schema, statement, context);
    const cached = this.cache.get(key);

    if (cached) {
      this.hits += 1;
      return {
        ir: cloneValue(cached.ir),
        sql: cloneValue(cached.sql),
        cache: {
          key,
          status: "hit",
          stats: this.stats(),
        },
      };
    }

    this.misses += 1;
    const ir = compileToIR(schema, statement, { overlays: context.overlays, globals: context.globals });
    const sql = compileToSQL(ir, { target: context.target });
    this.cache.set(key, {
      ir: cloneValue(ir),
      sql: cloneValue(sql),
    });

    return {
      ir,
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
  const statementFingerprint = stableJson(statement);
  const overlaysFingerprint = stableJson((context.overlays ?? []).map((overlay) => ({
    table: overlay.table,
    sourcePathId: overlay.sourcePathId,
    operation: overlay.operation,
    policyPhase: overlay.policyPhase,
    rewritePhase: overlay.rewritePhase,
  })));
  const globalsFingerprint = stableJson(context.globals ?? {});
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
    .update(targetFingerprint)
    .digest("hex");
};

const fingerprintSchema = (schema: SchemaSnapshot): string => {
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

  return stableJson(types);
};

const stableJson = (value: unknown): string => JSON.stringify(sortValue(value));

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  return value;
};

const cloneValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
