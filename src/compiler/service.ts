import { createHash } from "node:crypto";

import "../codegen/generated/schema_model.js";

import type { FreeObjectExpr, Statement } from "../edgeql/ast.js";
import type { Statement as GelIRStatement } from "../ir/gel_ir.js";
import type { IRStatement, OverlayIR } from "../ir/model.js";
import type { RuntimeTarget } from "../runtime/target.js";
import { qualifiedTypeName, type SchemaSnapshot } from "../schema/schema.js";
import type { SQLArtifact } from "../sql/compiler.js";
import { compileToSQL } from "../sql/compiler.js";
import { compileGelIRToSQL, type GelIRSQLArtifact } from "../sql/gel_ir_compiler.js";
import type { ScalarValue } from "../types.js";
import { compileToIR } from "./semantic.js";
import type { GeneratedSchema } from "../codegen/schema.js";
import { compileASTToGelIR, isGelIRCompatibleStatement } from "./ast_to_ir.js";

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
  gelIr?: GelIRStatement;
  usesGelIrSql: boolean;
  sql: SQLArtifact;
  cache: CompilerCacheMeta;
}

export interface CompileContext {
  overlays?: OverlayIR[];
  params?: Record<string, ScalarValue>;
  globals?: Record<string, ScalarValue>;
  target?: RuntimeTarget;
  schemaModel?: GeneratedSchema;
  schemaModelName?: string;
  experimentalGelIRSqlLowering?: boolean;
}

interface CachedCompile {
  ir: IRStatement;
  gelIr?: GelIRStatement;
  usesGelIrSql: boolean;
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
        gelIr: cloneValue(cached.gelIr),
        usesGelIrSql: cached.usesGelIrSql,
        sql: cloneValue(cached.sql),
        cache: {
          key,
          status: "hit",
          stats: this.stats(),
        },
      };
    }

    this.misses += 1;
    const ir = compileToIR(schema, statement, {
      overlays: context.overlays,
      globals: context.globals,
      schemaModel: context.schemaModel,
      schemaModelName: context.schemaModelName,
    });
    const { sql, gelIr, usesGelIrSql } = compileSqlWithStranglerFig(schema, statement, ir, context);
    this.cache.set(key, {
      ir: cloneValue(ir),
      gelIr: cloneValue(gelIr),
      usesGelIrSql,
      sql: cloneValue(sql),
    });

    return {
      ir,
      gelIr,
      usesGelIrSql,
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
  const paramsFingerprint = stableJson(context.params ?? {});
  const targetFingerprint = context.target ?? "sqlite";
  const gelIrSqlLoweringFingerprint = String(resolveGelIrSqlLoweringEnabled(context));

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
    .update(gelIrSqlLoweringFingerprint)
    .digest("hex");
};

const compileSqlWithStranglerFig = (
  schema: SchemaSnapshot,
  statement: Statement,
  ir: IRStatement,
  context: CompileContext,
): { sql: SQLArtifact; gelIr?: GelIRStatement; usesGelIrSql: boolean } => {
  if (statement.kind === "select" || statement.kind === "select_free"
    || ir.kind === "select" || ir.kind === "select_free"
    || (statement.kind === "select_expr" && freeExprContainsMutation(statement.expr))) {
    return {
      sql: compileToSQL(ir, { target: context.target ?? "sqlite", parameterValues: context.params, globalValues: context.globals }),
      usesGelIrSql: false,
    };
  }

  if (!isGelIRCompatibleStatement(statement)) {
    throw new Error(`Statement kind '${statement.kind}' is not supported by GEL IR SQL lowering`);
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
  }) as SQLArtifact & GelIRSQLArtifact;

  return {
    gelIr,
    usesGelIrSql: true,
    sql,
  };
};

const resolveGelIrSqlLoweringEnabled = (context: CompileContext): boolean => {
  // Kept for compile cache key stability; lowering is always on.
  void context;
  return true;
};

const freeExprContainsMutation = (expr: FreeObjectExpr): boolean => {
  if (expr.kind === "mutation_expr") return true;
  if (expr.kind === "set_expr" || expr.kind === "tuple" || expr.kind === "array_literal_expr") {
    return expr.values.some(freeExprContainsMutation);
  }
  if (expr.kind === "free_object_constructor") {
    return expr.entries.some((entry) => freeExprContainsMutation(entry.expr));
  }
  if (expr.kind === "shape_projection") {
    return freeExprContainsMutation(expr.expr);
  }
  if (expr.kind === "select_expr_subquery") {
    return freeExprContainsMutation(expr.expr)
      || Boolean(expr.filter && freeExprContainsMutation(expr.filter))
      || Boolean(expr.orderBy && freeExprContainsMutation(expr.orderBy.expr));
  }
  if (expr.kind === "for_expr") {
    return freeExprContainsMutation(expr.iterator)
      || freeExprContainsMutation(expr.body)
      || Boolean(expr.filter && freeExprContainsMutation(expr.filter))
      || Boolean(expr.orderBy && freeExprContainsMutation(expr.orderBy.expr));
  }
  if (expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "exists" || expr.kind === "field_access" || expr.kind === "index_access" || expr.kind === "slice_access" || expr.kind === "is_type" || expr.kind === "not" || expr.kind === "unary") {
    return freeExprContainsMutation(expr.expr);
  }
  if (expr.kind === "compare" || expr.kind === "math" || expr.kind === "logical" || expr.kind === "coalesce" || expr.kind === "and" || expr.kind === "or") {
    return freeExprContainsMutation(expr.left) || freeExprContainsMutation(expr.right);
  }
  if (expr.kind === "if_else") {
    return freeExprContainsMutation(expr.thenExpr)
      || freeExprContainsMutation(expr.condition)
      || freeExprContainsMutation(expr.elseExpr);
  }
  if (expr.kind === "concat") {
    return expr.parts.some(freeExprContainsMutation);
  }
  if (expr.kind === "function_call") {
    return expr.call.args.some((arg) => arg.kind === "expr" && freeExprContainsMutation(arg.expr));
  }
  return false;
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
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, entryValue] of entries) {
      out[key] = sortValue(entryValue);
    }
    return out;
  }

  return value;
};

const cloneValue = <T>(value: T): T => {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
};
