import { getCompilerService, type CompileContext, type CompilerCacheMeta } from "../compiler/service.js";
import { validateParsedStatement } from "../compiler/ast_to_ir.js";
import { PENDING_INSERT_SEQUENCE_VALUE, PENDING_INSERT_SQL_EXPR_VALUE, rewriteDunderDefaults, validateDeleteStatement } from "../compiler/dml_lowering.js";
import { AppError, asAppError, isQueryFailure, tryProbe, tryResult } from "../errors.js";
import { decorateErrorWithUnsupportedTag } from "../diagnostics/unsupported.js";
import { parseEdgeQL, parseEdgeQLScript, type ParseEdgeQLOptions } from "../edgeql/parser.js";
import { offsetToLineCol, tokenize, type Token } from "../edgeql/tokenizer.js";
import type { BacklinkExpr, ClauseChain, ComputedExpr, ConfigureStatement, DDLStatement, DeleteStatement, FilterExpr, FilterValue, ForStatement, FreeObjectExpr, FunctionCallArgExpr, FunctionCallExpr, InsertStatement, InsertValue, OrderExpr, OrderExprChain, PathStep, SelectExprStatement, SelectStatement, ShapeElement, Statement, TypeExpr, UpdateStatement, WithBinding, WithBindingValue, WithModuleAlias } from "../edgeql/ast.js";
import type { RuntimeDatabaseAdapter } from "./adapter.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import type { GelIRSQLArtifact as SQLArtifact } from "../sql/gel_ir_compiler.js";
import { lowersToSingleSql } from "../sql/compiler_types.js";
import { classifyExecutionStrategy, selectExprNeedsRuntime } from "../compiler/execution_strategy.js";
import { executeStdlibFunction, resolveStdlibFunction, type RuntimeFunctionArg } from "../stdlib/functions.js";
import { assertTargetSqlCompatibility, type RuntimeTarget } from "./target.js";
import type { ShapeElement as GelIRShapeElement, Set as GelIRSet, Statement as GelIRStatement, TypeRef as GelIRTypeRef } from "../ir/gel_ir.js";
import type { InsertIR, InsertLinkDefaultIR, InsertLinkPropertyIR, IRStatement, OverlayIR, UpdateIR, UpdateLinkAssignmentIR } from "../ir/model.js";
import type { AccessPolicyCondition, AccessPolicyDef, ComputedLinkPropertyExpr, ConstraintDef, FieldDef, FieldDefaultExpr, FunctionDef, FunctionExprDef, FunctionVolatility, LinkPropertyDef, ScalarType, ScalarValue, TypeDef } from "../types.js";
import { cloneTypeDef, fieldSequenceName, normalizeLinkTargetNames, qualifiedTypeName, usesLinkTable } from "../schema/schema.js";
import { resolveLinkStorageOwner } from "../schema/physical_layout.js";
import { materializeGelSQLRows, normalizeGelSQLValue } from "./row_codec.js";
import { coIteratedBinding } from "./co_iteration.js";
import { runSelectExprEvaluation } from "./evaluator.js";
import { buildInsertRowSql } from "./dml_sql.js";
import {
  enforceDeletePolicies,
  enforceInsertPolicies,
  enforceUpdateReadPolicies,
  enforceUpdateWritePolicies,
  evaluatePoliciesForOperation,
  hasPermission,
  type PolicyExprEvaluator,
} from "./access_policy.js";
import {
  bindingSelectShape,
  computedElementReferencedField,
  computedExprIsMulti,
  inferArrayValuedType,
  insertValueHasUnscopedPartialPath,
  literalStdTypeName,
  unwrapSubqueryWrappers,
} from "../compiler/ast_inference.js";
import { applyPendingInsertDefaults } from "./default_resolution.js";
import { parseDeclarativeSchema } from "../schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../schema/uiSchema.js";
import { linkTableName, tableNameForType } from "../codegen/sql.js";
import { populateSchemaIntrospection } from "../schema/schema_introspection.js";
import { materializeSchema, type SQLiteDatabase } from "../runtime/database.js";
import { validateScriptUserDDL, validateUserDDLStatement } from "./ddl.js";
import { installSqlTrace, runWithSqlSink } from "./sql_trace_sink.js";
import type { ExclusiveConstraintSpec } from "../edgeql/ddl_body.js";
import { applyLimitOffset, dedupeRowsById, distinctValues } from "./result_clauses.js";


export interface QueryResult {
  kind: "select" | "insert" | "update" | "delete";
  rows?: unknown[];
  changes?: number;
}

// Embedded `SELECT (DELETE …)` (and `(DELETE …).a`, `WITH t := (DELETE …)`):
// the outer SELECT must project the deleted rows' values, but those rows no
// longer exist once the DELETE runs. When this queue is non-null, the DML
// chain executor captures the rows' ids without physically removing them and
// defers the actual row removal as closures here; the top-level query executor
// flushes the queue *after* the outer SELECT has read the (still-live) rows.
// Null outside an embedded-delete-in-select context, so plain `DELETE T` and
// multi-mutation chains keep their immediate, in-line delete semantics.
let deferredChainDeletes: Array<() => void> | null = null;

export interface QueryExecutionTrace {
  ast: Statement;
  // The DML IR for mutations; undefined for SELECT / GROUP, which execute off
  // the gelIR SQL artifact and carry no legacy IR.
  ir: IRStatement | undefined;
  sql: SQLArtifact;
  compiler: CompilerCacheMeta;
  sqlTrail: SQLArtifact[];
  overlays: OverlayIR[];
  result: QueryResult;
}

export interface QueryUnitTrace {
  traces: QueryExecutionTrace[];
  result: QueryResult;
}

export interface SecurityContext {
  roleName?: string;
  isSuperuser?: boolean;
  permissions?: string[];
  globals?: Record<string, ScalarValue>;
  // Query parameter values for `$0`, `$name`, etc. Keyed by parameter name
  // (the part after `$`). Threaded into the SQL compiler so positional/named
  // EdgeQL parameters bind their `?` placeholders to these values.
  params?: Record<string, ScalarValue>;
  runtimeTarget?: RuntimeTarget;
  // Mirrors upstream's `INTERNAL_TESTMODE = False` test-class setting:
  // when true, the engine enforces user-DDL restrictions (no generic
  // types, no USING SQL bodies, no SET OF params, no CREATE INFIX
  // OPERATOR / CREATE CAST / CREATE PSEUDO TYPE, no extending
  // cfg::ConfigObject, ...). When false (the default, matching
  // INTERNAL_TESTMODE = True), only safety checks like the read-only
  // stdlib-module guard are applied. Read-only is always enforced.
  strictUserDDL?: boolean;
  // Object ids inserted during the current top-level statement. A bare/ON
  // UNLESS CONFLICT must NOT suppress a clash against a row created earlier in
  // the *same* statement (WITH-bound sibling inserts, FOR-bound duplicates) —
  // Gel surfaces those as a hard exclusivity error. The conflict pre-check
  // ignores any matching id found in this set, letting the insert proceed and
  // trip the constraint. Reset at each top-level statement boundary.
  statementInsertedIds?: Set<string>;
}

const DEFAULT_SECURITY_CONTEXT: SecurityContext = {
  roleName: "default",
  isSuperuser: false,
  permissions: ["sys::perm::data_modification"],
  globals: {},
  runtimeTarget: "sqlite",
};

const countRuntimeSetCardinality = (value: unknown): number => {
  const values = typeof value === "object" && value !== null && "kind" in value
    && ((value as { kind?: unknown }).kind === "set" || (value as { kind?: unknown }).kind === "array")
    ? (value as { values?: unknown[] }).values ?? []
    : Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];

  const seenObjectIds = new Set<string>();
  let count = 0;
  for (const item of values) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === "string") {
        if (seenObjectIds.has(id)) {
          continue;
        }
        seenObjectIds.add(id);
      }
    }
    count += 1;
  }
  return count;
};

const evaluateRuntimeAggregate = (functionName: string, values: unknown[]): unknown => {
  const normalized = functionName.toLowerCase().split("::").at(-1) ?? functionName.toLowerCase();
  if (normalized === "count") {
    return countRuntimeSetCardinality(values);
  }
  const numbers = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (normalized === "sum") {
    return numbers.reduce((total, value) => total + value, 0);
  }
  if (numbers.length === 0) {
    return null;
  }
  if (normalized === "min") {
    return Math.min(...numbers);
  }
  if (normalized === "max") {
    return Math.max(...numbers);
  }
  if (normalized === "avg" || normalized === "mean") {
    return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  }
  return null;
};

const normalizeRuntimeFloat = (value: number): number => (
  Number.isFinite(value) ? Number(value.toPrecision(15)) : value
);


const runtimeExprAliases = new WeakMap<SchemaSnapshot, Map<string, string>>();

// Per-connection (schema-snapshot-scoped) session configuration set via
// `CONFIGURE SESSION SET …`. The harness/client reuses one SchemaSnapshot per
// connection across separate script()/query() calls, so keying the session
// state on the snapshot makes `CONFIGURE SESSION SET allow_user_specified_id
// := true` persist for the INSERTs that follow it on the same connection.
// The only knob sqlite-ts honors is `allow_user_specified_id`, which lets an
// INSERT assign an explicit `id` (test_edgeql_insert_explicit_id_*).
interface SessionConfig {
  allowUserSpecifiedId?: boolean;
}
const sessionConfigBySchema = new WeakMap<SchemaSnapshot, SessionConfig>();

const allowUserSpecifiedId = (schema: SchemaSnapshot): boolean =>
  sessionConfigBySchema.get(schema)?.allowUserSpecifiedId === true;

// Applies a `CONFIGURE … SET/RESET …` statement to the connection's session
// config. Only `allow_user_specified_id` is meaningful; everything else stays
// a no-op (sqlite-ts has no analogue for the other config knobs).
const applySessionConfigure = (schema: SchemaSnapshot, ast: ConfigureStatement): void => {
  if (ast.target !== "allow_user_specified_id") return;
  let config = sessionConfigBySchema.get(schema);
  if (!config) {
    config = {};
    sessionConfigBySchema.set(schema, config);
  }
  if (ast.operation === "reset") {
    config.allowUserSpecifiedId = false;
    return;
  }
  const value = ast.value;
  config.allowUserSpecifiedId =
    value !== undefined && value !== null && (value as { kind?: string }).kind === "literal"
      ? (value as { value?: unknown }).value === true
      : false;
};

// Per-connection (schema-snapshot-scoped) values for session globals. Two
// sources populate it, keyed by the global's unqualified name (matching how
// `global a` / `global_expr` reference globals):
//   • computed globals (`create global a := <expr>`) — their default is
//     evaluated once at CREATE time and stored here (they always read back as
//     that default).
//   • settable globals — `set global a := <expr>` stores the value; `reset
//     global a` (or never-set) leaves it absent, so reads yield the empty set.
// The stored value is merged into `context.globals` before each compile so the
// `global_expr` SQL lowering (which reads `globalValues[name]`) sees it.
//
// EMPTY_GLOBAL marks a global that exists but currently holds the empty set
// (distinct from "never declared"). We don't actually need to store it — an
// absent key already lowers to NULL/empty — so the map only ever holds present
// scalar values.
const globalValuesBySchema = new WeakMap<SchemaSnapshot, Map<string, ScalarValue>>();

const globalValuesFor = (schema: SchemaSnapshot): Map<string, ScalarValue> => {
  let map = globalValuesBySchema.get(schema);
  if (!map) {
    map = new Map<string, ScalarValue>();
    globalValuesBySchema.set(schema, map);
  }
  return map;
};

// Evaluates a global's expression (default or `set` value) to a single scalar
// by compiling it as `select (<expr>)` and running it. EdgeQL globals are
// single-or-empty, so we return the lone scalar row, or `undefined` when the
// expression yields the empty set (caller treats that as "no value"). Object /
// non-scalar results aren't valid global values; they return undefined too.

// The shared home for the "can this statement run as one SQL statement? if so
// use it, else fall back to the runtime evaluator" probe. Compiles `stmtAst`
// and, when it lowers to a single SQL statement, runs it and returns the rows;
// otherwise `undefined`. Query problems (unsupported lowering, etc.) fall back
// to `undefined`; engine defects (TypeError, …) propagate via `tryProbe`
// instead of being swallowed by a bare `catch`.
const tryRunSingleSqlRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  stmtAst: Statement,
  context: SecurityContext,
  compileContext?: CompileContext,
): unknown[] | undefined =>
  tryProbe(() => {
    const compiled = getCompilerService().compile(schema, stmtAst, compileContext);
    if (!lowersToSingleSql(compiled.sql)) return undefined;
    return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
  });

const evaluateGlobalExpr = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: FreeObjectExpr,
  context: SecurityContext,
): ScalarValue | undefined => {
  const stmtAst = {
    kind: "select_expr",
    expr,
    pos: { line: 1, column: 1 },
  } as unknown as SelectExprStatement;
  const rows = tryRunSingleSqlRows(db, schema, stmtAst as unknown as Statement, context, { globals: context.globals });
  if (!rows || rows.length === 0) return undefined;
  const first = rows[0];
  return first === null || isScalarValue(first) ? (first as ScalarValue) : undefined;
};

// Applies `CREATE GLOBAL <name> [:= <expr>]`. Registers the global on the
// schema and, for computed globals (those with a default), evaluates and caches
// the default value. Settable globals start absent (empty set until `set`).
const applyCreateGlobalDDL = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: DDLStatement,
  defaultModule: string,
): void => {
  const name = ast.name;
  // `create global mod::a` carries the module in the qualified name; otherwise
  // it lives in the statement's WITH-module or the script default module.
  const qualified = name.includes("::") ? name : `${ast.withModule ?? defaultModule}::${name}`;
  const [moduleName, shortName] = qualified.split("::");
  schema.addGlobal({ module: moduleName, name: shortName, exprText: ast.value ? "<computed>" : undefined });
  const values = globalValuesFor(schema);
  if (ast.value) {
    const evaluated = evaluateGlobalExpr(db, schema, ast.value, normalizeSecurityContext(DEFAULT_SECURITY_CONTEXT));
    if (evaluated === undefined) values.delete(shortName);
    else values.set(shortName, evaluated);
  } else {
    // Settable global: empty until a `set global` assigns it.
    values.delete(shortName);
  }
};

// Applies `SET GLOBAL <name> := <expr>` / `RESET GLOBAL <name>` to the
// connection's per-schema global state.
const applySessionGlobal = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: ConfigureStatement,
  context: SecurityContext,
): void => {
  const name = ast.target.includes("::") ? ast.target.split("::").at(-1)! : ast.target;
  const values = globalValuesFor(schema);
  if (ast.operation === "reset") {
    values.delete(name);
    return;
  }
  if (!ast.value) {
    values.delete(name);
    return;
  }
  const evaluated = evaluateGlobalExpr(db, schema, ast.value, context);
  if (evaluated === undefined) values.delete(name);
  else values.set(name, evaluated);
};

// Merges the per-schema session-global values into a context's `globals` map.
// Caller-supplied globals win over stored defaults (so explicit query-time
// globals can still override). Returns a new context; the original is unchanged.
const withSessionGlobals = (schema: SchemaSnapshot, context: SecurityContext): SecurityContext => {
  const stored = globalValuesBySchema.get(schema);
  if (!stored || stored.size === 0) return context;
  const merged: Record<string, ScalarValue> = {};
  for (const [k, v] of stored) merged[k] = v;
  return { ...context, globals: { ...merged, ...(context.globals ?? {}) } };
};

// Lists every alias known for a schema — both schema::Alias entries
// registered via schema.addAlias (typed aliases with shapes) and runtime
// expr aliases stashed in the WeakMap above (scalar/tuple-set CREATE ALIAS
// forms). Used by schema-introspection population so `SELECT schema::Type
// FILTER .name LIKE '%my_alias%'` finds aliases of either flavor.
//
// Returns alias names *and* synthetic shape-type names. EdgeDB exposes an
// alias whose body is `SELECT Card { ... }` as two entries: the alias
// itself (`default::best_card`) AND a synthetic projection type derived
// from the source (`default::__best_card__Card`). Both appear in
// `schema::Type` introspection.
export const listAllRuntimeAliasNames = (schema: SchemaSnapshot): string[] => {
  const names = new Set<string>();
  const addAliasShapeTypeName = (aliasModule: string, aliasName: string, sourceType: string): void => {
    const parts = sourceType.split("::");
    const baseName = parts[parts.length - 1];
    names.add(`${aliasModule}::__${aliasName}__${baseName}`);
  };

  for (const alias of schema.listAliases()) {
    names.add(`${alias.module}::${alias.name}`);
    if (alias.sourceType) {
      addAliasShapeTypeName(alias.module, alias.name, alias.sourceType);
    }
  }
  const typedAliases = runtimeTypedAliases.get(schema);
  if (typedAliases) {
    for (const alias of typedAliases.values()) {
      names.add(`${alias.moduleName}::${alias.aliasName}`);
      if (alias.hasShape && alias.sourceType) {
        addAliasShapeTypeName(alias.moduleName, alias.aliasName, alias.sourceType);
      }
    }
  }
  const exprAliases = runtimeExprAliases.get(schema);
  if (exprAliases) {
    for (const key of exprAliases.keys()) {
      // Keys may be qualified (`mod::name`) or just bare names; normalize to
      // `default::name` for unqualified entries so introspection rows always
      // have a fully qualified name.
      names.add(key.includes("::") ? key : `default::${key}`);
    }
  }
  return [...names];
};

type RuntimeTypedAliasDef = {
  aliasName: string;
  moduleName: string;
  sourceType: string;
  filter?: {
    field: string;
    op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike" | "not_like" | "not_ilike";
    value: ScalarValue;
  };
  filterValues?: {
    field: string;
    values: ScalarValue[];
  };
  limit?: number;
  hasShape?: boolean;
  computedProperties?: Array<{
    name: string;
    kind: "tuple" | "array";
    fields: string[];
  }>;
  computedExistsProperties?: Array<{
    name: string;
    correlated: boolean;
    backlinkLink: string;
    targetType: string;
    field: string;
    value: ScalarValue;
  }>;
  linkOverrides: Array<{
    name: string;
    backlinkLink: string;
    targetType: string;
    computedFields: Array<{
      name: string;
      sourceField: string;
      functionName: "str_upper";
    }>;
  }>;
};

const runtimeTypedAliases = new WeakMap<SchemaSnapshot, Map<string, RuntimeTypedAliasDef>>();

const getRuntimeExprAliasMap = (schema: SchemaSnapshot): Map<string, string> => {
  const existing = runtimeExprAliases.get(schema);
  if (existing) {
    return existing;
  }

  const created = new Map<string, string>();
  runtimeExprAliases.set(schema, created);
  return created;
};

const getRuntimeTypedAliasMap = (schema: SchemaSnapshot): Map<string, RuntimeTypedAliasDef> => {
  const existing = runtimeTypedAliases.get(schema);
  if (existing) {
    return existing;
  }

  const created = new Map<string, RuntimeTypedAliasDef>();
  runtimeTypedAliases.set(schema, created);
  return created;
};

const qualifyRuntimeTypeName = (name: string, moduleName = "default"): string =>
  name.includes("::") ? name : `${moduleName}::${name}`;

const likeMatch = (value: unknown, pattern: unknown, caseInsensitive: boolean): boolean => {
  if (typeof value !== "string" || typeof pattern !== "string") return false;
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      regex += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
      continue;
    }
    if (ch === "%") {
      regex += ".*";
      continue;
    }
    if (ch === "_") {
      regex += ".";
      continue;
    }
    regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex, caseInsensitive ? "is" : "s").test(value);
};

const stripRuntimeAliasOuterParens = (input: string): string => {
  const trimmed = input.trim();
  if (!(trimmed.startsWith("(") && trimmed.endsWith(")"))) {
    return trimmed;
  }

  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0 && i < trimmed.length - 1) {
        return trimmed;
      }
    }
  }

  return trimmed.slice(1, -1).trim();
};

const parseRuntimeTypedAliasDef = (
  aliasName: string,
  exprBody: string,
  moduleName = "default",
): RuntimeTypedAliasDef | undefined => {
  const normalized = stripRuntimeAliasOuterParens(exprBody.replace(/^[ \t]*#.*$/gm, "").trim());
  const compact = normalized.replace(/\s+/g, " ").trim();

  const match = /^SELECT\s+([A-Za-z_][\w:]*)\s*\{\s*([A-Za-z_][\w]*)\s*:=\s*\(\s*SELECT\s+([A-Za-z_][\w:]*)\s*\.\s*<\s*([A-Za-z_][\w]*)\s*\[\s*IS\s+([A-Za-z_][\w:]*)\s*\]\s*\{\s*([A-Za-z_][\w]*)\s*:=\s*str_upper\s*\(\s*\.\s*([A-Za-z_][\w]*)\s*\)\s*\}\s*\)\s*\}\s*FILTER\s+([A-Za-z_][\w:]*)\s*\.\s*([A-Za-z_][\w]*)\s+LIKE\s+'([^']+)'\s*$/i.exec(compact);
  if (!match) {
    return undefined;
  }

  const [
    ,
    sourceType,
    linkName,
    backlinkSourceType,
    backlinkLink,
    targetType,
    computedFieldName,
    computedSourceField,
    filterSourceType,
    filterField,
    filterValue,
  ] = match;

  const qualifiedSourceType = qualifyRuntimeTypeName(sourceType, moduleName);
  const qualifiedBacklinkSourceType = qualifyRuntimeTypeName(backlinkSourceType, moduleName);
  const qualifiedFilterSourceType = qualifyRuntimeTypeName(filterSourceType, moduleName);

  if (qualifiedSourceType !== qualifiedBacklinkSourceType || qualifiedSourceType !== qualifiedFilterSourceType) {
    return undefined;
  }

  return {
    aliasName,
    moduleName,
    sourceType: qualifiedSourceType,
    filter: {
      field: filterField,
      op: "like",
      value: filterValue,
    },
    linkOverrides: [
      {
        name: linkName,
        backlinkLink,
        targetType: qualifyRuntimeTypeName(targetType, moduleName),
        computedFields: [
          {
            name: computedFieldName,
            sourceField: computedSourceField,
            functionName: "str_upper",
          },
        ],
      },
    ],
  };
};

const parseRuntimeAliasComputedProperties = (exprText: string): RuntimeTypedAliasDef["computedProperties"] => {
  const compact = exprText.replace(/^[ \t]*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const properties: NonNullable<RuntimeTypedAliasDef["computedProperties"]> = [];
  const tuplePattern = /\b([A-Za-z_][\w]*)\s*:=\s*\(([^)]*)\)/g;
  for (const match of compact.matchAll(tuplePattern)) {
    const fields = [...match[2].matchAll(/\.([A-Za-z_][\w]*)/g)].map((fieldMatch) => fieldMatch[1]);
    if (fields.length > 0) {
      properties.push({ name: match[1], kind: "tuple", fields });
    }
  }
  const arrayPattern = /\b([A-Za-z_][\w]*)\s*:=\s*\[([^\]]*)\]/g;
  for (const match of compact.matchAll(arrayPattern)) {
    const fields = [...match[2].matchAll(/\.([A-Za-z_][\w]*)/g)].map((fieldMatch) => fieldMatch[1]);
    if (fields.length > 0) {
      properties.push({ name: match[1], kind: "array", fields });
    }
  }
  return properties.length > 0 ? properties : undefined;
};

const parseRuntimeAliasComputedExistsProperties = (
  exprText: string,
  moduleName: string,
): RuntimeTypedAliasDef["computedExistsProperties"] => {
  const compact = exprText.replace(/^[ \t]*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const properties: NonNullable<RuntimeTypedAliasDef["computedExistsProperties"]> = [];
  const existsPattern = /\b([A-Za-z_][\w]*)\s*:=\s*EXISTS\s*\(\s*SELECT\s+((?:[A-Za-z_][\w:]*)?)\s*\.\s*<\s*([A-Za-z_][\w]*)\s*\[\s*IS\s+([A-Za-z_][\w:]*)\s*\]\s*\.\s*([A-Za-z_][\w]*)\s*=\s*'([^']+)'\s*\)/gi;
  for (const match of compact.matchAll(existsPattern)) {
    properties.push({
      name: match[1],
      correlated: match[2].length === 0,
      backlinkLink: match[3],
      targetType: qualifyRuntimeTypeName(match[4], moduleName),
      field: match[5],
      value: match[6],
    });
  }
  return properties.length > 0 ? properties : undefined;
};

const parseRuntimeAliasLinkOverrides = (exprText: string, moduleName: string): RuntimeTypedAliasDef["linkOverrides"] => {
  const compact = exprText.replace(/^[ \t]*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const overrides: RuntimeTypedAliasDef["linkOverrides"] = [];
  const linkPattern = /\b([A-Za-z_][\w]*)\s*:=\s*\(?\s*(?:SELECT\s+)?[A-Za-z_][\w:]*\s*\.\s*<\s*([A-Za-z_][\w]*)\s*\[\s*IS\s+([A-Za-z_][\w:]*)\s*\]\s*\{([^}]*)\}/gi;
  for (const match of compact.matchAll(linkPattern)) {
    const computedFields = [...match[4].matchAll(/\b([A-Za-z_][\w]*)\s*:=\s*str_upper\s*\(\s*\.\s*([A-Za-z_][\w]*)\s*\)/gi)]
      .map((fieldMatch) => ({
        name: fieldMatch[1],
        sourceField: fieldMatch[2],
        functionName: "str_upper" as const,
      }));
    overrides.push({
      name: match[1],
      backlinkLink: match[2],
      targetType: qualifyRuntimeTypeName(match[3], moduleName),
      computedFields,
    });
  }
  return overrides;
};

const splitTopLevelScriptStatements = (script: string): string[] => {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let dollarMarker: string | undefined;

  const dollarQuoteAt = (idx: number): string | undefined => {
    if (script[idx] !== "$") return undefined;
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(idx));
    return match?.[0];
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (dollarMarker) {
      if (script.startsWith(dollarMarker, i)) {
        i += dollarMarker.length - 1;
        dollarMarker = undefined;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    const marker = dollarQuoteAt(i);
    if (marker) {
      dollarMarker = marker;
      i += marker.length - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === ";" && depth === 0) {
      const piece = script.slice(start, i).trim();
      if (piece) statements.push(piece);
      start = i + 1;
    }
  }

  const tail = script.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
};

const dynamicQualifiedNameParts = (rawName: string, defaultModule = "default"): { module: string; name: string; qualified: string } => {
  const name = rawName.trim();
  if (name.includes("::")) {
    const parts = name.split("::");
    const shortName = parts.pop() ?? name;
    const module = parts.join("::") || defaultModule;
    return { module, name: shortName, qualified: `${module}::${shortName}` };
  }
  return { module: defaultModule, name, qualified: `${defaultModule}::${name}` };
};

// Strip a leading whitespace-delimited keyword (case-insensitive) from a type
// expression. Returns the input unchanged when the keyword isn't present.
const stripLeadingTypeKeyword = (input: string, keyword: string): string => {
  const lowered = input.toLowerCase();
  if (!lowered.startsWith(keyword.toLowerCase())) return input;
  const after = input.slice(keyword.length);
  // Require at least one whitespace character following the keyword so we
  // don't accidentally strip a real prefix (e.g. `optionalX`).
  if (after.length === 0 || (after[0] !== " " && after[0] !== "\t" && after[0] !== "\n" && after[0] !== "\r")) {
    return input;
  }
  return after.trimStart();
};

const normalizeDynamicTypeName = (rawType: string, defaultModule = "default"): string => {
  let typeName = rawType.trim();
  if (typeName.endsWith(";")) typeName = typeName.slice(0, -1).trimEnd();
  typeName = stripLeadingTypeKeyword(typeName, "optional");
  // `set of` is two words; peel them in order so a stray `set` keyword by
  // itself doesn't get treated as part of a type name.
  const afterSet = stripLeadingTypeKeyword(typeName, "set");
  if (afterSet !== typeName) {
    const afterOf = stripLeadingTypeKeyword(afterSet, "of");
    typeName = afterOf !== afterSet ? afterOf : typeName;
  }
  typeName = typeName.trim();
  const lower = typeName.toLowerCase();
  if (lower.startsWith("std::")) return typeName;
  if (["str", "bool", "json", "uuid", "bytes"].includes(lower)) return `std::${lower}`;
  if (["int", "int16", "int32", "int64", "bigint"].includes(lower)) return "std::int64";
  if (["float", "float32", "float64", "decimal"].includes(lower)) return "std::float64";
  if (lower.startsWith("array<") || lower.startsWith("tuple<")) return typeName;
  return typeName.includes("::") ? typeName : `${defaultModule}::${typeName}`;
};

const SCALAR_INT_NAMES = new globalThis.Set(["int", "int16", "int32", "int64", "bigint"]);
const SCALAR_FLOAT_NAMES = new globalThis.Set(["float", "float32", "float64", "decimal"]);

const dynamicScalarFromType = (rawType: string): { type: ScalarType; collection?: FieldDef["collection"] } => {
  const typeName = stripLeadingTypeKeyword(rawType.trim(), "optional").trim();
  const lower = typeName.toLowerCase();
  if (lower.startsWith("tuple<") || lower.startsWith("std::tuple<")) return { type: "json", collection: { kind: "tuple" } };
  if (lower.startsWith("array<") || lower.startsWith("std::array<")) return { type: "json", collection: { kind: "array" } };
  if (lower.endsWith("str")) return { type: "str" };
  if (lower.endsWith("bool")) return { type: "bool" };
  if (lower.endsWith("json")) return { type: "json" };
  if (lower.endsWith("uuid")) return { type: "uuid" };
  // Strip the `std::` prefix so an unqualified name like `int64` and the
  // canonical `std::int64` both fall through to the same scalar-name set.
  const bare = lower.startsWith("std::") ? lower.slice("std::".length) : lower;
  if (SCALAR_INT_NAMES.has(bare)) return { type: "int" };
  if (SCALAR_FLOAT_NAMES.has(bare)) return { type: "float" };
  return { type: "str" };
};

const evaluateDefaultExprToScalar = (expr: string): ScalarValue | undefined => {
  const trimmed = expr.trim().replace(/;$/, "").trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith("'") && trimmed.endsWith("'"))
      || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+(?:e-?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  return undefined;
};

const applyParsedFunctionDDL = (schema: SchemaSnapshot, ast: DDLStatement, defaultModule = "default"): void => {
  if (!ast.functionDecl) return;
  const { module, name } = dynamicQualifiedNameParts(ast.name, defaultModule);
  const params = ast.functionDecl.params.map((param) => {
    const defaultValue = param.defaultExpr !== undefined ? evaluateDefaultExprToScalar(param.defaultExpr) : undefined;
    const hasDefaultExpr = param.defaultExpr !== undefined;
    return {
      name: param.name,
      type: normalizeDynamicTypeName(param.type, defaultModule),
      optional: Boolean(param.optional) || Boolean(param.namedOnly) || hasDefaultExpr,
      variadic: param.variadic || undefined,
      namedOnly: param.namedOnly || undefined,
      setOf: param.setOf || undefined,
      default: defaultValue,
      // Preserve the raw default text so the inliner can substitute
      // non-scalar defaults (array/tuple literals) that don't reduce to a
      // ScalarValue. Only retained when no scalar reduction was available.
      defaultExpr: hasDefaultExpr && defaultValue === undefined
        ? param.defaultExpr
        : undefined,
    };
  });
  const bodyQuery = ast.functionDecl.body.query.trim();
  // Normalize the parsed `SET volatility := ...` category (e.g. the trailing
  // `schema::Volatility.Modifying` segment) onto the function definition.
  // Modifying functions enforce singleton-cardinality on their arguments.
  let volatility: FunctionVolatility | undefined;
  switch ((ast.functionDecl.volatility ?? "").toLowerCase()) {
    case "immutable": volatility = "Immutable"; break;
    case "stable": volatility = "Stable"; break;
    case "volatile": volatility = "Volatile"; break;
    case "modifying": volatility = "Modifying"; break;
    default: volatility = undefined;
  }
  schema.addFunction({
    module,
    name,
    params,
    returnType: normalizeDynamicTypeName(ast.functionDecl.returnType, defaultModule),
    returnOptional: ast.functionDecl.returnOptional,
    returnSetOf: ast.functionDecl.returnSetOf,
    volatility,
    body: {
      kind: "query",
      language: "edgeql",
      query: /^select\b/i.test(bodyQuery) ? bodyQuery : `SELECT ${bodyQuery}`,
    },
  });
};

// The CREATE/ALTER TYPE string shadow-parser that used to live here
// (`parseMemberHeader` / `parseExclusiveConstraintEntry` / the token-walker /
// `parseAlterTypeStatement`, and `parseCreateTypeHeader` in ddl.ts) was retired:
// the EdgeQL parser now parses DDL bodies onto the AST (`createTypeBody` /
// `alterTypeOps`) and the runtime reads them. See docs/adr/0027, 0030, 0031.

// Extract single-field references from a type-level constraint `on` expression
// (e.g. `(.name)` → ["name"]). Tuple constraints over multiple fields are not
// enforced by the runtime, so they yield no refs and are dropped.
const exclusiveConstraintFieldRefs = (onExpr: string | undefined): string[] => {
  if (onExpr === undefined) return [];
  const refs = [...onExpr.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  return [...new Set(refs)];
};


// If `exprText` is a bare scalar literal (`'foo'`, `"foo"`, `42`, `true`),
// return the structured literal default; otherwise undefined (the text-only
// default path handles general expressions like `'a=' ++ .b`).
const literalDefaultFromText = (exprText: string): FieldDefaultExpr | undefined => {
  const t = exprText.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith("\"") && t.endsWith("\""))) {
    return { kind: "literal", value: t.slice(1, -1) };
  }
  if (/^-?\d+$/.test(t)) return { kind: "literal", value: Number(t) };
  if (/^-?\d+\.\d+$/.test(t)) return { kind: "literal", value: Number(t) };
  if (t === "true" || t === "false") return { kind: "literal", value: t === "true" };
  return undefined;
};

// Normalize the raw operation phrases the DDL body parser collected for a
// `CREATE ACCESS POLICY` into the `AccessPolicyOperation[]` the runtime
// enforces. `update` (bare) covers both read and write; an empty list defaults
// to `all` (matching EdgeQL's "FOR ALL" implied default).
const normalizeAccessPolicyOperations = (raw: readonly string[]): AccessPolicyDef["operations"] => {
  if (raw.length === 0 || raw.includes("all")) return ["all"];
  const out: AccessPolicyDef["operations"] = [];
  for (const part of raw) {
    if (part === "select" || part === "insert" || part === "delete") out.push(part);
    else if (part === "update read") out.push("update_read");
    else if (part === "update write") out.push("update_write");
    else if (part === "update") out.push("update_read", "update_write");
  }
  return out.length > 0 ? out : ["all"];
};

// Apply the operations parsed from a top-level `ALTER TYPE …` statement to the
// schema in place. Returns true when the statement was a (recognised) ALTER
// TYPE, so the caller re-materialises and clears the compiler cache.
const applyAlterTypeDDL = (schema: SchemaSnapshot, ast: DDLStatement, defaultModule = "default"): boolean => {
  // Read the structured ALTER ops off the DDL AST node (docs/adr/0031, 0032).
  if (ast.action !== "alter" || ast.objectKind !== "type") return false;
  const ops = ast.alterTypeOps ?? [];
  if (ops.length === 0) return false;
  // Honor a `with module <m>` prefix on the statement (e.g.
  // `with module cards alter type User { … }`) when qualifying the target.
  const { module, name } = dynamicQualifiedNameParts(ast.name, ast.withModule ?? defaultModule);
  const stored = schema.getType(`${module}::${name}`);
  if (!stored) return false;
  // Schema reads return frozen, shared definitions; this routine mutates the
  // type in place before writing it back via addType, so work on a clone.
  const typeDef = cloneTypeDef(stored);

  let mutated = false;
  for (const op of ops) {
    if (op.kind === "set_default") {
      const literal = literalDefaultFromText(op.exprText);
      if (op.pointerPath.length === 1) {
        const field = typeDef.fields.find((f) => f.name === op.pointerPath[0]);
        if (field) {
          field.hasDefault = true;
          field.defaultExprText = op.exprText;
          field.defaultExpr = literal;
          mutated = true;
        }
      } else if (op.pointerPath.length === 2) {
        const link = (typeDef.links ?? []).find((l) => l.name === op.pointerPath[0]);
        const linkProp = link?.properties?.find((p) => p.name === op.pointerPath[1]);
        if (linkProp) {
          linkProp.hasDefault = true;
          linkProp.defaultExprText = op.exprText;
          linkProp.defaultExpr = literal;
          mutated = true;
        }
      }
    } else if (op.kind === "create_constraint") {
      const refs = exclusiveConstraintFieldRefs(op.constraint.onExpr);
      if (refs.length > 0) {
        typeDef.typeConstraints = [
          ...(typeDef.typeConstraints ?? []),
          {
            name: "std::exclusive",
            exprText: op.constraint.onExpr ?? "",
            fieldRefs: refs,
            delegated: op.constraint.delegated || undefined,
            exceptExpr: op.constraint.exceptExpr,
          },
        ];
        mutated = true;
      }
    } else if (op.kind === "drop_constraint") {
      const before = typeDef.typeConstraints?.length ?? 0;
      typeDef.typeConstraints = (typeDef.typeConstraints ?? []).filter((c) => {
        // Drop the matching exclusive constraint (same on/except expression).
        const sameOn = (c.exprText ?? "").replace(/\s+/g, "") === (op.constraint.onExpr ?? "").replace(/\s+/g, "");
        const sameExcept = (c.exceptExpr ?? "").replace(/\s+/g, "") === (op.constraint.exceptExpr ?? "").replace(/\s+/g, "");
        return !(c.name === "std::exclusive" && sameOn && sameExcept);
      });
      if ((typeDef.typeConstraints?.length ?? 0) !== before) mutated = true;
    } else if (op.kind === "create_access_policy") {
      // The USING predicate flows through verbatim as `usingExprText`; it is
      // parsed and lowered to SQL at enforcement time (scoped to the subject),
      // not pattern-matched here.
      const policy: AccessPolicyDef = {
        name: op.name,
        effect: op.effect,
        operations: normalizeAccessPolicyOperations(op.operations),
        usingExprText: op.usingExprText,
        condition: { kind: "always", value: true },
      };
      const nextPolicies = [...(typeDef.accessPolicies ?? [])];
      const existing = nextPolicies.findIndex((candidate) => candidate.name === policy.name);
      if (existing >= 0) nextPolicies.splice(existing, 1, policy);
      else nextPolicies.push(policy);
      typeDef.accessPolicies = nextPolicies;
      mutated = true;
    }
  }

  if (mutated) schema.addType(typeDef);
  return mutated;
};

// Validate bare-SDL type declarations (`type Hello { … }`, as opposed to the
// imperative `create type`) for illegal default expressions: a property
// `default :=` may not reference a multi property or any link of the same type
// (test_edgeql_insert_default_09). Bare SDL otherwise isn't executable here, so
// this purely surfaces the schema-validation diagnostics EdgeQL raises.
const validateBareSdlDefaults = (script: string): void => {
  const looksLikeBareSdl = splitTopLevelScriptStatements(script).some((stmt) => {
    const t = stmt.trim();
    return /^(?:abstract\s+)?type\s+[A-Za-z_]/i.test(t) && t.includes("{");
  });
  if (!looksLikeBareSdl) return;

  // Parse the whole script as a declarative module. tryResult swallows parse
  // failures (the statement may not be valid bare SDL — then there's nothing to
  // validate and the normal pipeline reports the real error).
  const parsed = tryResult(() => {
    const decl = parseDeclarativeSchema(`module default {\n${script}\n}`, { legacySyntaxCompat: true });
    return schemaSnapshotFromDeclarative(decl);
  }, { captureAll: true });
  if (!parsed.ok || parsed.value === undefined) return;
  const sdlSchema = parsed.value;

  for (const typeDef of sdlSchema.listTypes()) {
    const multiProps = new Set(typeDef.fields.filter((f) => f.multi).map((f) => f.name));
    const linkNames = new Set((typeDef.links ?? []).map((l) => l.name));
    for (const field of typeDef.fields) {
      if (!field.hasDefault || !field.defaultExprText) continue;
      const refs = [...field.defaultExprText.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
      // A reference to a link (single or multi) is rejected first — the
      // canonical message names links even when wrapped in `count(.world)`.
      if (refs.some((r) => linkNames.has(r))) {
        throw new AppError("E_SEMANTIC", "default expression cannot refer to links", 1, 1);
      }
      if (refs.some((r) => multiProps.has(r))) {
        throw new AppError("E_SEMANTIC", "default expression cannot refer to multi properties", 1, 1);
      }
    }
  }
};

// Map the structured exclusive-constraint specs from `parseCreateTypeBody` to
// the `ConstraintDef[]` the runtime's exclusivity machinery consumes (or
// undefined when none), mirroring the old `collectExclusiveConstraintSpecs`.
const exclusiveConstraintDefs = (specs: readonly ExclusiveConstraintSpec[]): ConstraintDef[] | undefined => {
  if (specs.length === 0) return undefined;
  return specs.map((s) => ({
    name: "std::exclusive",
    annotations: [],
    delegated: s.delegated || undefined,
    onExpr: s.onExpr,
    exceptExpr: s.exceptExpr,
  }));
};

const registerDynamicTypeDDL = (schema: SchemaSnapshot, ast: DDLStatement, defaultModule = "default"): boolean => {
  // Register off the DDL AST node the pre-pass already parsed — the parser
  // produced the structured `createTypeBody` (docs/adr/0029, 0030, 0032).
  if (ast.action !== "create" || ast.objectKind !== "type") return false;
  const rawName = ast.name;
  const extendsRaw = ast.extendsList;
  const isAbstract = ast.modifiers?.includes("abstract") ?? false;
  const { module, name } = dynamicQualifiedNameParts(rawName, defaultModule);
  const fields: FieldDef[] = [];
  const links: NonNullable<TypeDef["links"]> = [];
  const computeds: NonNullable<TypeDef["computeds"]> = [];
  const typeConstraints: NonNullable<TypeDef["typeConstraints"]> = [];
  const extendsList = extendsRaw
    ? extendsRaw.map((entry) => normalizeDynamicTypeName(entry, module)).filter((entry) => entry.length > 0)
    : undefined;

  // Inherit fields and links from base types so subtypes (`CREATE TYPE Baz
  // EXTENDING Bar`) carry the parent shape forward. This mirrors the
  // schema-loader behaviour for declarative schemas; without it,
  // `INSERT Baz { name := … }` would fail to resolve `name`.
  if (extendsList) {
    for (const baseName of extendsList) {
      const baseType = schema.getType(baseName);
      if (!baseType) continue;
      for (const field of baseType.fields) {
        const existing = fields.find((f) => f.name === field.name);
        if (!existing) {
          fields.push({ ...field });
        } else if (field.constraints && field.constraints.length > 0) {
          // The same field inherited from multiple bases (`Baz EXTENDING Foo,
          // Bar` where both declare `name`): merge constraints so an exclusive
          // constraint declared on ANY base is enforced on the subtype, not
          // dropped because an unconstrained base was visited first.
          existing.constraints = [...(existing.constraints ?? []), ...field.constraints];
        }
      }
      for (const link of baseType.links ?? []) {
        if (!links.some((l) => l.name === link.name)) links.push({ ...link });
      }
    }
  }

  // The `CREATE TYPE` body is parsed into structured members by
  // `parseCreateTypeBody` (src/edgeql/ddl_body.ts); this loop converts those
  // members to the runtime's TypeDef shape (scalar resolution, FK synthesis,
  // exclusivity). See docs/adr/0027.
  for (const member of ast.createTypeBody ?? []) {
    if (member.kind === "property") {
      const scalar = dynamicScalarFromType(member.targetType);
      const constraints = exclusiveConstraintDefs(member.constraints);
      const defaultText = member.defaultText;
      fields.push({
        name: member.name,
        type: scalar.type,
        required: member.required,
        multi: member.multi,
        collection: scalar.collection,
        constraints,
        hasDefault: defaultText !== undefined || undefined,
        defaultExprText: defaultText,
        defaultExpr: defaultText !== undefined ? literalDefaultFromText(defaultText) : undefined,
      });
      continue;
    }
    if (member.kind === "link") {
      // Inline link-property declarations (`CREATE LINK x { CREATE PROPERTY a: int64 }`)
      // become the link's properties; a link with properties OR `multi` is
      // stored in a `<owner>__<link>` junction table rather than an inline FK.
      const linkProperties: LinkPropertyDef[] = member.properties.map((p) => {
        const propScalar = dynamicScalarFromType(p.targetType);
        return { name: p.name, type: propScalar.type, required: p.required, collection: propScalar.collection };
      });
      const linkConstraints = exclusiveConstraintDefs(member.constraints);
      links.push({
        name: member.name,
        targetType: normalizeDynamicTypeName(member.targetType, module),
        multi: member.multi,
        properties: linkProperties.length > 0 ? linkProperties : undefined,
        constraints: linkConstraints,
      });
      if (!member.multi && linkProperties.length === 0) {
        // Carry an exclusive constraint declared on the link down to the
        // synthetic FK column so the same-table UNIQUE index / shared
        // exclusivity machinery enforces it (links are unique on their target).
        fields.push({ name: `${member.name}_id`, type: "uuid", isLinkColumn: true, constraints: linkConstraints });
      }
      continue;
    }
    if (member.kind === "computed_link") {
      // A computed link alias (`CREATE LINK foo := <expr>`) isn't materialised
      // as a column — record the declaration so backlink resolution can flag
      // `.<foo` without an `[IS T]` filter (the EdgeQL error names the type).
      computeds.push({ kind: "link", name: member.name, expr: { kind: "select_type", typeName: rawName, exprText: member.exprText } });
      continue;
    }
    if (member.kind === "alter_pointer") {
      // `ALTER PROPERTY|LINK <name> { CREATE CONSTRAINT exclusive … }` adds an
      // exclusive constraint to a (usually inherited) pointer without
      // redeclaring it (e.g. `CREATE TYPE Bar EXTENDING Foo { ALTER PROPERTY
      // name { CREATE CONSTRAINT exclusive } }`).
      const constraints = exclusiveConstraintDefs(member.constraints);
      if (constraints) {
        if (member.pointerKind === "property") {
          const existing = fields.find((f) => f.name === member.name);
          if (existing) {
            existing.constraints = [...(existing.constraints ?? []), ...constraints];
          } else {
            // Inherited field not yet materialised on this type's field list —
            // record a bare field carrying just the constraint so the
            // exclusivity collector can pick it up.
            fields.push({ name: member.name, type: "str", constraints });
          }
        } else {
          const existingLink = links.find((l) => l.name === member.name);
          if (existingLink) {
            existingLink.constraints = [...(existingLink.constraints ?? []), ...constraints];
          }
          const fkField = fields.find((f) => f.name === `${member.name}_id`);
          if (fkField) {
            fkField.constraints = [...(fkField.constraints ?? []), ...constraints];
          }
        }
      }
      continue;
    }
    // Type-level `CREATE CONSTRAINT exclusive [ON (.field)] [EXCEPT (...)]`.
    const refs = exclusiveConstraintFieldRefs(member.onExpr);
    if (refs.length > 0) {
      typeConstraints.push({
        name: "std::exclusive",
        exprText: member.onExpr ?? "",
        fieldRefs: refs,
        delegated: member.delegated || undefined,
        exceptExpr: member.exceptExpr,
      });
    }
  }

  schema.addType({
    module,
    name,
    abstract: isAbstract || undefined,
    ddlSynthesized: true,
    fields,
    links: links.length ? links : undefined,
    computeds: computeds.length ? computeds : undefined,
    typeConstraints: typeConstraints.length ? typeConstraints : undefined,
    extends: extendsList,
  });
  return true;
};


const maybeRegisterDynamicDDLScript = (db: SQLiteDatabase, schema: SchemaSnapshot, script: string, defaultModule = "default"): boolean => {
  // Parse the script once and drive the CREATE TYPE / ALTER TYPE / CREATE
  // FUTURE pre-registration off the DDL AST nodes — the parser already produced
  // `createTypeBody` / `alterTypeOps`. A parse failure means there's nothing to
  // pre-register; the main execution path reports the real error. See
  // docs/adr/0032.
  const parsed = tryResult(() => parseEdgeQLScript(script));
  if (!parsed.ok) return false;
  let registeredType = false;
  for (const stmt of parsed.value) {
    if (stmt.kind !== "ddl") continue;
    registeredType = registerDynamicTypeDDL(schema, stmt, defaultModule) || registeredType;
    registeredType = applyAlterTypeDDL(schema, stmt, defaultModule) || registeredType;
    if (stmt.action === "create" && stmt.objectKind === "future") {
      schema.setFutureFlag(stmt.name, true);
      registeredType = true;
    }
  }
  if (registeredType) {
    materializeSchema(db, schema);
    getCompilerService().clear();
  }
  return registeredType;
};

const maybeHandleAliasDDLScript = (schema: SchemaSnapshot, script: string): boolean => {
  const trimmed = script.trim().replace(/;\s*$/, "");
  if (!trimmed) {
    return false;
  }

  const statements = script
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  if (statements.length > 1) {
    let handledAny = false;
    for (const statement of statements) {
      if (!maybeHandleAliasDDLScript(schema, `${statement};`)) {
        return false;
      }
      handledAny = true;
    }
    return handledAny;
  }

  if (/^set\s+module\s+/i.test(trimmed)) {
    return true;
  }

  // `CREATE GLOBAL` is handled by the per-statement executor (it registers the
  // global and evaluates computed defaults), so let it fall through rather than
  // treating it as a handled no-op here. `type`/`module` remain no-ops.
  if (/^create\s+(?:type|module)\b/i.test(trimmed) || /^drop\s+(?:type|global|module)\b/i.test(trimmed)) {
    return true;
  }

  const createMatch = /^create\s+alias\s+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)\s*:=\s*([\s\S]*)$/i.exec(trimmed);
  if (createMatch) {
    const [, rawAliasName, exprBody] = createMatch;
    const aliasModuleName = rawAliasName.includes("::") ? rawAliasName.split("::").slice(0, -1).join("::") : "default";
    const aliasName = rawAliasName.split("::").at(-1) ?? rawAliasName;
    const aliasKey = rawAliasName.includes("::") ? rawAliasName : aliasName;
    // Register the alias on the schema only when its body parses as a SELECT
    // statement (the form expandSchemaAliasesInStatement knows how to inline).
    // Other forms (`SELECT { (name := ...), ... }` free-object sets, scalar
    // expressions) stay on the runtime-expr-alias path so we don't shadow
    // their existing handling.
    const trimmedExprBody = exprBody.trim().replace(/;\s*$/, "");
    let probeBody = trimmedExprBody;
    while (probeBody.startsWith("(") && probeBody.endsWith(")")) {
      const inner = probeBody.slice(1, -1).trim();
      let depth = 0;
      let balanced = true;
      for (const ch of inner) {
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth < 0) { balanced = false; break; }
        }
      }
      if (!balanced || depth !== 0) break;
      probeBody = inner;
    }
    let schemaRegistrable = false;
    for (const candidate of [probeBody, `SELECT ${probeBody}`]) {
      try {
        const probe = parseEdgeQL(candidate);
        if (probe.kind === "select"
          && probe.typeName
          && (probe.shape?.some((el) => "name" in el && el.name !== "id" && (el as { origin?: string }).origin !== "default")
            || probe.filter)) {
          schemaRegistrable = true;
          break;
        }
      } catch (e) {
        // Probe: try the next candidate form only on genuine parse
        // failures; engine bugs must not be masked here.
        if (!isQueryFailure(e)) throw e;
      }
    }
    if (schemaRegistrable) {
      schema.addAlias({
        module: aliasModuleName,
        name: aliasName,
        exprText: exprBody.trim(),
      });
    }
    const typedAliases = getRuntimeTypedAliasMap(schema);
    const typedAlias = parseRuntimeTypedAliasDef(aliasName, exprBody, aliasModuleName);
    if (typedAlias) {
      typedAliases.set(aliasKey, typedAlias);
      const aliases = getRuntimeExprAliasMap(schema);
      aliases.delete(aliasKey);
      return true;
    }

    const normalizedExprBody = stripRuntimeAliasOuterParens(exprBody.trim());
    const genericTypedAlias = /^select\s+([A-Za-z_][\w:]*)\s*\{/i.exec(normalizedExprBody);
    if (genericTypedAlias) {
      typedAliases.set(aliasKey, {
        aliasName,
        moduleName: aliasModuleName,
        sourceType: qualifyRuntimeTypeName(genericTypedAlias[1], aliasModuleName),
        hasShape: true,
        limit: Number(/\blimit\s+(\d+)/i.exec(normalizedExprBody)?.[1] ?? "0") || undefined,
        computedProperties: parseRuntimeAliasComputedProperties(normalizedExprBody),
        computedExistsProperties: parseRuntimeAliasComputedExistsProperties(normalizedExprBody, aliasModuleName),
        linkOverrides: parseRuntimeAliasLinkOverrides(normalizedExprBody, aliasModuleName),
      });
      const aliases = getRuntimeExprAliasMap(schema);
      aliases.delete(aliasKey);
      return true;
    }

    const aliases = getRuntimeExprAliasMap(schema);
    const selectSetMatch = /^select\s+(\{[\s\S]*\})$/i.exec(normalizedExprBody);
    aliases.set(aliasKey, selectSetMatch ? selectSetMatch[1] : `(${normalizedExprBody})`);
    typedAliases.delete(aliasKey);
    return true;
  }

  const dropMatch = /^drop\s+alias\s+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)$/i.exec(trimmed);
  if (dropMatch) {
    const [, rawAliasName] = dropMatch;
    const aliasName = rawAliasName.split("::").at(-1) ?? rawAliasName;
    const aliasModule = rawAliasName.includes("::") ? rawAliasName.split("::").slice(0, -1).join("::") : "default";
    const aliasKey = rawAliasName.includes("::") ? rawAliasName : aliasName;
    schema.removeAlias(`${aliasModule}::${aliasName}`);
    const aliases = getRuntimeExprAliasMap(schema);
    aliases.delete(aliasKey);
    aliases.delete(aliasName);
    const typedAliases = getRuntimeTypedAliasMap(schema);
    typedAliases.delete(aliasKey);
    typedAliases.delete(aliasName);
    return true;
  }

  return false;
};

const injectRuntimeAliasBinding = (schema: SchemaSnapshot, query: string): string => {
  const aliases = runtimeExprAliases.get(schema);
  if (!aliases || aliases.size === 0) {
    return query;
  }

  const trimmed = query.trim();
  if (!/^select\s+/i.test(trimmed) || /^with\s+/i.test(trimmed)) {
    return query;
  }

  // For each expr-alias referenced in the query, inject a WITH binding so
  // the normal pipeline resolves `aliasName` and `aliasName.field` paths
  // against the alias's stored expression.
  const bindings: string[] = [];
  for (const [aliasName, expr] of aliases.entries()) {
    const referenced = new RegExp(`\\b${aliasName}\\b`).test(trimmed);
    if (referenced) {
      bindings.push(`${aliasName} := ${expr}`);
    }
  }
  if (bindings.length === 0) {
    return query;
  }
  return `WITH ${bindings.join(", ")} ${trimmed}`;
};

const runtimeAliasLikeMatches = (value: unknown, pattern: string): boolean => {
  if (typeof value !== "string") {
    return false;
  }

  if (pattern.includes("%")) {
    if (pattern.startsWith("%") && pattern.endsWith("%") && pattern.length >= 2) {
      return value.includes(pattern.slice(1, -1));
    }
    if (pattern.endsWith("%")) {
      return value.startsWith(pattern.slice(0, -1));
    }
    if (pattern.startsWith("%")) {
      return value.endsWith(pattern.slice(1));
    }
    const [left, right] = pattern.split("%", 2);
    return value.startsWith(left) && value.endsWith(right ?? "");
  }

  return value === pattern;
};

const runtimeAliasPredicateMatches = (
  value: unknown,
  op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike" | "not_like" | "not_ilike",
  expected: ScalarValue,
): boolean => {
  if (op === "=") {
    return value === expected;
  }
  if (op === "!=") {
    return value !== expected;
  }
  if (typeof expected !== "string") {
    const left = typeof value === "number" ? value : Number(value);
    const right = typeof expected === "number" ? expected : Number(expected);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      if (op === "<") return left < right;
      if (op === "<=") return left <= right;
      if (op === ">") return left > right;
      if (op === ">=") return left >= right;
    }
    return false;
  }
  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    if (typeof value !== "string") {
      return false;
    }
    if (op === "<") return value < expected;
    if (op === "<=") return value <= expected;
    if (op === ">") return value > expected;
    return value >= expected;
  }
  if (op === "?=") {
    return value === null || value === undefined || value === expected;
  }
  if (op === "?!=") {
    return value === null || value === undefined || value !== expected;
  }
  const caseInsensitive = op === "ilike" || op === "not_ilike";
  const left = caseInsensitive && typeof value === "string" ? value.toLowerCase() : value;
  const right = caseInsensitive ? expected.toLowerCase() : expected;
  const matched = runtimeAliasLikeMatches(left, right);
  return op === "not_like" || op === "not_ilike" ? !matched : matched;
};

const readRuntimeTypedAliasSourceRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  alias: RuntimeTypedAliasDef,
): Array<Record<string, unknown> & { __source_type: string }> => {
  const sourceTypes = schema.listConcreteTypesAssignableTo(alias.sourceType);
  const rows: Array<Record<string, unknown> & { __source_type: string }> = [];

  for (const sourceType of sourceTypes) {
    const sourceTypeName = qualifiedTypeName(sourceType);
    const table = tableNameForType(sourceTypeName);
    const selected = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[];
    for (const row of selected) {
      const filterValues = alias.filterValues;
      if (
        filterValues
        && !filterValues.values.some((value) => runtimeAliasPredicateMatches(row[filterValues.field], "=", value))
      ) {
        continue;
      }
      if (!alias.filterValues && alias.filter && !runtimeAliasPredicateMatches(row[alias.filter.field], alias.filter.op, alias.filter.value)) {
        continue;
      }
      rows.push({ ...row, __source_type: sourceTypeName });
    }
  }

  return rows;
};


// The Runtime evaluator implementation now lives in `runtime/evaluator.ts`,
// behind the injected `SelectExprEvaluatorDeps` seam. This wrapper supplies the
// engine-internal capabilities it reaches back into (built lazily so the
// closed-over module functions are all initialised by call time). See ADR 0044.
const tryRuntimeSelectExprEvaluationAst = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Extract<Statement, { kind: "select_expr" }>,
  context: SecurityContext,
): QueryResult | undefined =>
  runSelectExprEvaluation(db, schema, ast, context, selectExprEvaluatorDeps());

const qualifiedRuntimeAliasName = (name: string): string => name.includes("::") ? name : `default::${name}`;

const findRuntimeLinkDef = (
  schema: SchemaSnapshot,
  typeName: string,
  linkName: string,
  seen = new Set<string>(),
): { ownerType: TypeDef; link: NonNullable<TypeDef["links"]>[number] } | undefined => {
  if (seen.has(typeName)) {
    return undefined;
  }
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) {
    return undefined;
  }

  const direct = (typeDef.links ?? []).find((link) => link.name === linkName);
  if (direct) {
    return { ownerType: typeDef, link: direct };
  }

  for (const baseName of typeDef.extends ?? []) {
    const inherited = findRuntimeLinkDef(schema, baseName, linkName, seen);
    if (inherited) {
      return inherited;
    }
  }

  return undefined;
};

const resolveRuntimeStoredTypeName = (schema: SchemaSnapshot, storedTypeName: string): string => {
  if (storedTypeName.includes("::")) {
    return storedTypeName;
  }

  const normalized = storedTypeName.toLowerCase();
  for (const typeDef of schema.listTypes()) {
    const qualified = qualifiedTypeName(typeDef);
    if (tableNameForType(qualified) === normalized) {
      return qualified;
    }
  }

  return storedTypeName;
};

const findRuntimeComputedMulti = (
  schema: SchemaSnapshot,
  typeName: string,
  computedName: string,
  seen = new Set<string>(),
): boolean | undefined => {
  if (seen.has(typeName)) {
    return undefined;
  }
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) {
    return undefined;
  }

  const direct = (typeDef.computeds ?? []).find((c) => c.name === computedName);
  if (direct) {
    return Boolean(direct.multi);
  }

  for (const baseName of typeDef.extends ?? []) {
    const inherited = findRuntimeComputedMulti(schema, baseName, computedName, seen);
    if (inherited !== undefined) {
      return inherited;
    }
  }

  return undefined;
};

const resolvedRuntimeTarget = (context: SecurityContext, db: RuntimeDatabaseAdapter): RuntimeTarget =>
  context.runtimeTarget ?? db.target ?? "sqlite";

type ParsedRuntimeRow = Record<string, unknown> & { id?: unknown; __source_type?: unknown };

type ParsedRuntimeEnv = {
  row?: ParsedRuntimeRow;
  rowType?: string;
  bindings: Map<string, ParsedRuntimeRow[]>;
  outerRows?: Array<{ row: ParsedRuntimeRow; rowType?: string }>;
  iterationPath?: { typeName: string; steps: string[] };
  iterationSource?: FreeObjectExpr;
};

const withInnerRow = (
  env: ParsedRuntimeEnv,
  row: ParsedRuntimeRow,
  rowType: string | undefined,
  extra: Partial<ParsedRuntimeEnv> = {},
): ParsedRuntimeEnv => {
  const outerRows = env.row
    ? [...(env.outerRows ?? []), { row: env.row, rowType: env.rowType }]
    : env.outerRows;
  return { ...env, ...extra, row, rowType, outerRows };
};

const RESTRICTED_LINK_PROPERTY_NAMES: Record<string, string> = {
  target: "@target may only be used in index and constraint definitions",
  source: "@source may only be used in index and constraint definitions",
};

const validateRestrictedLinkPropertyTokens = (query: string): void => {
  // Probe: untokenizable queries fail later with the real parse error;
  // this pre-pass only needs to inspect valid token streams.
  const tokenized = tryResult(() => tokenize(query));
  if (!tokenized.ok) return;
  const tokens: Token[] = tokenized.value;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (token.kind !== "at") continue;
    const next = tokens[i + 1];
    if (!next || (next.kind !== "identifier" && !next.kind.startsWith("kw_"))) continue;
    const message = RESTRICTED_LINK_PROPERTY_NAMES[next.lexeme];
    if (message) {
      // Resolve line/column from the token's byte offset against the original
      // query — Token no longer carries line/column directly.
      const pos = offsetToLineCol(token.offset, query);
      throw new AppError("E_SEMANTIC", message, pos.line, pos.column);
    }
  }
};

// A *multi-level* FOR statement whose body ultimately performs an INSERT —
// either a bare nested FOR (`FOR a … FOR b … INSERT`) or the expression-position
// UNION form (`FOR a … UNION (FOR b … UNION (INSERT …))`, which parses as a
// select_expr wrapping a nested `for_expr` chain). These need the script unit
// path's FOR-INSERT expansion to flatten every loop level.
//
// Single-level FOR-INSERTs (`FOR x … INSERT`, `FOR x … UNION (INSERT …)`) are
// already routed/handled elsewhere — this only flags the additional nesting so
// the single-level UNION form keeps its existing (working) execution path.
const forStatementYieldsInsert = (forAst: ForStatement): boolean => {
  const body = forAst.body;
  if (body.kind === "insert") return true;
  if (body.kind === "for") return true;
  if (body.kind === "select_expr") {
    // Only a *nested* for_expr (FOR-within-FOR) needs rerouting; a bare
    // `select_expr{ mutation_expr insert }` is the single-level UNION form
    // handled by the existing peel + path.
    let cur: FreeObjectExpr = body.expr;
    if ((cur as { kind?: string }).kind === "select_expr_subquery") {
      cur = (cur as unknown as { expr: FreeObjectExpr }).expr;
    }
    if ((cur as { kind?: string }).kind !== "for_expr") return false;
    // Confirm the nested chain bottoms out in an INSERT.
    const chainEndsInInsert = (node: FreeObjectExpr): boolean => {
      let n: FreeObjectExpr = node;
      if ((n as { kind?: string }).kind === "select_expr_subquery") {
        n = (n as unknown as { expr: FreeObjectExpr }).expr;
      }
      if ((n as { kind?: string }).kind === "mutation_expr") {
        return (n as unknown as { statement: Statement }).statement.kind === "insert";
      }
      if ((n as { kind?: string }).kind === "for_expr") {
        return chainEndsInInsert((n as unknown as { body: FreeObjectExpr }).body);
      }
      return false;
    };
    return chainEndsInInsert((cur as unknown as { body: FreeObjectExpr }).body);
  }
  return false;
};

// EdgeQL query parameters supplied at execution time. A positional tuple/array
// (`variables=(True,)` upstream) binds `$0`, `$1`, … by index; a record binds
// named parameters (`$name`). Values may be JS arrays/objects for collection
// parameters (`<array<int64>>$0`), which bind as JSON strings to match how the
// SQL compiler unpacks them (`json_each`).
export type QueryVariables = readonly unknown[] | Record<string, unknown>;

// Collection/composite parameter values lower to a single SQLite `?` bound to
// the JSON encoding the array/json operators expect; scalars pass through
// unchanged (booleans → 0/1, the form the cast-over-parameter SQL consumes).
const normalizeQueryVariableValue = (value: unknown): ScalarValue => {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value as ScalarValue;
};

const normalizeQueryVariables = (variables: QueryVariables): Record<string, ScalarValue> => {
  const params: Record<string, ScalarValue> = {};
  if (Array.isArray(variables)) {
    variables.forEach((value, index) => {
      params[String(index)] = normalizeQueryVariableValue(value);
    });
  } else {
    for (const [name, value] of Object.entries(variables as Record<string, unknown>)) {
      params[name] = normalizeQueryVariableValue(value);
    }
  }
  return params;
};

// Two DML entry points that DIVERGE — keep mutation semantics in sync across
// both. `executeQuery` (client `query()` / test `h.query`) runs a single
// statement through `executeQueryWithTraceImpl`; `executeScript` (client
// `script()` / test `h.script`) runs the multi-statement loop in
// `executeQueryUnitWithTrace`. The two paths handle DELETE/UPDATE targets,
// SELECT-over-mutation, and WITH-DML chains with separate (and historically
// drifting) code, so a delete/update behaviour can be correct on one path and
// wrong on the other. When touching DML execution, exercise BOTH — note that
// `assertQueryResult` in the conformance tests uses the QUERY path while a bare
// `h.script(...)` uses the SCRIPT path.
export const executeQuery = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
  variables?: QueryVariables,
): QueryResult => {
  if (variables !== undefined) {
    securityContext = { ...securityContext, params: normalizeQueryVariables(variables) };
  }
  // SELECTs execute the gelIR SQL artifact; INSERT/UPDATE/DELETE compile
  // through ast_to_ir (SQL artifact) plus dml_lowering (runtime mutation
  // plan: link-table writes, defaults, conflict handling still run here in
  // the engine). GROUP is the remaining interpreter surface: it tries the
  // SQL artifact first and falls back to runGroupIR/preEvaluateGroupBindings
  // for shapes compileGroupStmtToSQL can't lower yet. FOR-INSERT still
  // routes through the unit path so the script harness can surface the
  // unsupported-lowering error uniformly; FOR-SELECT goes through the
  // normal compile pipeline.
  const rewrittenQuery = injectRuntimeAliasBinding(schema, query);
  validateRestrictedLinkPropertyTokens(rewrittenQuery);
  // A multi-statement string passed to the single-query entry point
  // (`insert …; select (…) {…}`) runs as an implicit script returning the
  // final statement's result — mirroring the protocol's query() semantics.
  const scriptStatements = tryResult(() => parseEdgeQLScript(rewrittenQuery), { captureAll: true });
  if (scriptStatements.ok && scriptStatements.value.length > 1) {
    return executeScript(db, schema, rewrittenQuery, securityContext);
  }
  const parsedQuery = parseEdgeQL(rewrittenQuery);
  // Reject user-DDL targeting read-only modules (std/schema/cfg/sys/...)
  // before any execution side-effects. Mirrors `validateScriptUserDDL` for
  // the single-statement entry point.
  validateUserDDLStatement(parsedQuery, securityContext.strictUserDDL ?? false);
  // A single DDL statement (`create type …`, `alter type …`) needs the same
  // schema pre-pass the multi-statement script path runs — otherwise the
  // dynamic CREATE/ALTER TYPE registration never fires and the statement
  // reaches GEL-IR lowering as an unsupported `ddl`.
  if (parsedQuery.kind === "ddl") {
    return executeScript(db, schema, rewrittenQuery, securityContext);
  }
  if (parsedQuery.kind === "for" && forStatementYieldsInsert(parsedQuery)) {
    const script = rewrittenQuery.trim().endsWith(";") ? rewrittenQuery : `${rewrittenQuery};`;
    return executeQueryUnitWithTrace(db, schema, script, securityContext).result;
  }
  // Reuse the AST parsed above instead of re-parsing inside the trace impl, and
  // skip SQL-trail recording — this entry point only returns `.result`.
  return executeQueryWithTrace(db, schema, rewrittenQuery, securityContext, parsedQuery, false).result;
};

export const executeScript = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  script: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
  parserOptions: ParseEdgeQLOptions = {},
  variables?: QueryVariables,
): QueryResult => {
  if (variables !== undefined) {
    securityContext = { ...securityContext, params: normalizeQueryVariables(variables) };
  }
  // Reject user-DDL targeting read-only modules before any pre-pass /
  // registration runs. Otherwise `CREATE TYPE std::Foo` would be silently
  // registered by `maybeRegisterDynamicDDLScript` before per-statement
  // validation in `executeQueryUnitWithTrace` ever sees it.
  validateScriptUserDDL(script, parserOptions, securityContext.strictUserDDL ?? false);
  validateBareSdlDefaults(script);
  maybeRegisterDynamicDDLScript(db, schema, script);
  if (maybeHandleAliasDDLScript(schema, script)) {
    // Alias state changed; refresh the schema::* introspection rows so
    // SELECT schema::Type FILTER .name = 'newAlias' picks them up. Both
    // typed (schema.addAlias) and runtime expr aliases (runtimeExprAliases
    // WeakMap) must be included — listAllRuntimeAliasNames merges both.
    populateSchemaIntrospection(db, schema, listAllRuntimeAliasNames(schema), runtimeExprAliases.get(schema));
    return { kind: "insert", changes: 0 };
  }
  return executeQueryUnitWithTrace(db, schema, script, securityContext, parserOptions).result;
};

// ── WITH-bound DML subquery chains ───────────────────────────────────────
// `WITH T := (SELECT …), TC := (UPDATE … SET {…}) UPDATE T SET {link := TC}`
// — a statement whose WITH bindings include object sets and DML subqueries
// that reference each other and feed the final mutation's link targets. The
// model-IR write path can't resolve those, so evaluate the bindings in order
// (executing DML bindings, materializing each result as an id-set), then run
// the final mutation with binding references resolved to those ids. Object-set
// values are resolved to concrete id-sets here; the actual writes still go
// through the normal write path (one `.id = <uuid>` mutation per affected row,
// with link targets rewritten to a by-id SELECT).

type ObjectSet = { typeName: string; ids: string[] };
type DmlChainEnv = Map<string, ObjectSet>;

// When `FOR x IN <set> UNION (INSERT T …)` is desugared into one INSERT
// statement per iteration, all the children share a single snapshot for
// snapshot-valued expression defaults (`default := (SELECT count(T))`) so the
// default is evaluated once and reused for every row — matching upstream's
// "deterministic, same for all" semantics. The shared cache is keyed by each
// child statement object here and consulted at the write site.
const forInsertSnapshotDefaultCaches = new WeakMap<object, Map<string, ScalarValue>>();

const qualifyChainType = (name: string, defaultModule: string): string =>
  name.includes("::") ? name : `${defaultModule}::${name}`;

// References to already-executed chain bindings (`x.name`, `note := new`)
// can't resolve in a standalone compile — rewrite them to by-id SELECTs over
// the captured object sets so every value still lowers to SQL.
// Find a type that every type in `types` is a subtype of (their nearest common
// ancestor). Walks the first type's ancestor chain until all others are
// assignable to a candidate; falls back to the first type when they share no
// ancestor. Used to type the result of a conditional whose branches insert
// related types (`if … then InsertTest else DerivedTest`).
const commonAncestorType = (schema: SchemaSnapshot, types: string[]): string => {
  const distinct = [...new Set(types.filter((t) => t.length > 0))];
  if (distinct.length === 0) return "";
  if (distinct.length === 1) return distinct[0];
  let candidate: string | undefined = distinct[0];
  const seen = new Set<string>();
  while (candidate && !seen.has(candidate)) {
    seen.add(candidate);
    if (distinct.every((t) => schema.isTypeSubtypeOf(t, candidate as string))) return candidate;
    const def = schema.getType(candidate);
    candidate = def?.extends?.find((b) => schema.getType(b));
  }
  return distinct[0];
};

const chainByIdSelect = (bound: ObjectSet): Record<string, unknown> => ({
  kind: "select",
  typeName: bound.typeName,
  shape: [{ kind: "field", name: "id" }],
  clauses: {
    filter: {
      kind: "in_predicate",
      target: { kind: "field", field: "id" },
      op: "in",
      values: { kind: "set_literal", values: bound.ids },
    },
  },
});

// Forward outer (non-DML) WITH bindings onto every mutation statement nested
// inside a binding value / expression, so the mutation can resolve them when
// it compiles standalone (`WITH x := "!", y := (WITH name := x ++ …,
// INSERT …)` — the inner INSERT needs `x`). Inner statements' own bindings
// come later in the list, so they shadow same-named outer ones.
const attachWithToNestedMutations = <T>(node: T, extras: WithBinding[]): T => {
  if (extras.length === 0) return node;
  const walk = (cur: unknown): unknown => {
    if (Array.isArray(cur)) return cur.map(walk);
    if (cur === null || typeof cur !== "object") return cur;
    const n = cur as Record<string, unknown> & { kind?: string; statement?: unknown };
    if ((n.kind === "mutation_expr" || n.kind === "subquery_statement") && n.statement && typeof n.statement === "object") {
      const st = n.statement as { with?: WithBinding[] };
      return { ...n, statement: { ...st, with: [...extras, ...(st.with ?? [])] } };
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) {
      out[key] = walk(value);
    }
    return out;
  };
  return walk(node) as T;
};

// Bind a FOR loop variable into the loop body before it's resolved as an
// object set. Inside a nested mutation statement the value is supplied as a
// WITH binding (so `INSERT T { p := v }` resolves `v` through the mutation's
// own compile, where property values are raw scalars, not literal nodes).
// Everywhere else — `if v % 2 = 0` conditions, scalar expressions — the
// `binding_ref`/bare path to `v` is substituted with a literal expression node
// so the surrounding expression compiles standalone. Descent stops at a nested
// FOR that rebinds the same variable (its own binding shadows ours).
const bindLoopVarInForBody = (node: unknown, name: string, value: ScalarValue): unknown => {
  const varBinding = { name, value: { kind: "literal", value } } as WithBinding;
  const walk = (cur: unknown): unknown => {
    if (Array.isArray(cur)) return cur.map(walk);
    if (cur === null || typeof cur !== "object") return cur;
    const n = cur as Record<string, unknown> & { kind?: string; statement?: unknown; variable?: unknown };
    if (n.kind === "binding_ref" && n.name === name) return { kind: "literal", value };
    if (n.kind === "path" && n.head === name && n.tail === undefined) return { kind: "literal", value };
    if (n.kind === "for_expr" && n.variable === name) return cur;
    if ((n.kind === "mutation_expr" || n.kind === "subquery_statement") && n.statement && typeof n.statement === "object") {
      const st = n.statement as { with?: WithBinding[] };
      return { ...n, statement: { ...st, with: [varBinding, ...(st.with ?? [])] } };
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(n)) out[key] = walk(v);
    return out;
  };
  return walk(node);
};

// Evaluate a scalar WITH-binding expression exactly once through a one-off
// SQL SELECT (with the given sibling bindings in scope). Returns a literal /
// empty-set binding value, or undefined when the expression doesn't evaluate
// to a single scalar (callers leave the original binding in place).
const evaluateScalarBindingViaSQL = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: FreeObjectExpr,
  withBindings: WithBinding[],
  context: SecurityContext,
  pos: { line: number; column: number },
): WithBindingValue | undefined => {
  const stmtAst = {
    kind: "select_expr",
    expr,
    with: withBindings.length > 0 ? [...withBindings] : undefined,
    pos,
  } as unknown as Statement;
  // captureAll: any compile/run failure just means "leave the binding for
  // the downstream compile to handle".
  const attempt = tryResult(() => {
    const compiled = getCompilerService().compile(schema, stmtAst, { globals: context.globals, params: context.params, target: resolvedRuntimeTarget(context, db) });
    if (!lowersToSingleSql(compiled.sql)) return undefined;
    return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
  }, { captureAll: true });
  if (!attempt.ok || attempt.value === undefined) return undefined;
  const rows = attempt.value;
  if (rows.length === 0) return { kind: "set_literal", values: [] } as WithBindingValue;
  if (rows.length === 1 && (rows[0] === null || typeof rows[0] === "string" || typeof rows[0] === "number" || typeof rows[0] === "boolean")) {
    return { kind: "literal", value: rows[0] as ScalarValue } as WithBindingValue;
  }
  return undefined;
};

// A WITH binding bound to a free-object constructor with scalar entries
// (`WITH free := { name := <str>random() }`) is materialized once by EdgeQL: a
// reference like `free.name` resolves to the SAME value everywhere, even if the
// entry expression is volatile. Without capture, each `free.name` use inlines
// the entry expression and a volatile `random()` diverges between sites. Detect
// such bindings, evaluate each referenced entry once via SQL, and substitute
// the `free.<entry>` path references with the captured literal. Returns the
// statement unchanged when there's nothing to capture.
const captureFreeObjectScalarBindings = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  context: SecurityContext,
): Statement => {
  const withBindings = (ast as { with?: WithBinding[] }).with ?? [];
  if (withBindings.length === 0) return ast;
  // Collect free-object bindings whose entries are scalar (non-mutation) exprs.
  const freeObjectEntries = new Map<string, Map<string, FreeObjectExpr>>();
  for (const binding of withBindings) {
    const value = binding.value as { kind?: string; expr?: { kind?: string; entries?: Array<{ name?: string; expr?: FreeObjectExpr }> } };
    if (value.kind !== "subquery_expr") continue;
    const ctor = value.expr;
    if (ctor?.kind !== "free_object_constructor" || !Array.isArray(ctor.entries)) continue;
    if (bindingValueContainsMutation(binding.value)) continue;
    const entryMap = new Map<string, FreeObjectExpr>();
    let ok = true;
    for (const entry of ctor.entries) {
      if (typeof entry.name !== "string" || !entry.expr) { ok = false; break; }
      entryMap.set(entry.name, entry.expr);
    }
    if (ok && entryMap.size > 0) freeObjectEntries.set(binding.name, entryMap);
  }
  if (freeObjectEntries.size === 0) return ast;

  // Determine which `<binding>.<entry>` references actually appear, so we only
  // evaluate (and capture) the entries that are read.
  const referenced = new Map<string, Set<string>>();
  const noteRef = (head: string, field: string): void => {
    if (!freeObjectEntries.has(head)) return;
    if (!freeObjectEntries.get(head)!.has(field)) return;
    if (!referenced.has(head)) referenced.set(head, new globalThis.Set());
    referenced.get(head)!.add(field);
  };
  const scan = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(scan); return; }
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, unknown> & { kind?: string };
    if (n.kind === "path" && typeof n.head === "string" && typeof n.tail === "string") {
      noteRef(n.head, n.tail);
    }
    if (n.kind === "field_access"
      && typeof n.field === "string"
      && (n.expr as { kind?: string; name?: string })?.kind === "binding_ref") {
      noteRef((n.expr as { name: string }).name, n.field);
    }
    for (const v of Object.values(n)) scan(v);
  };
  scan(ast);
  if (referenced.size === 0) return ast;

  // Evaluate each referenced entry once and record the captured literal.
  const captured = new Map<string, Map<string, ScalarValue | null>>();
  for (const [head, fields] of referenced) {
    const entryMap = freeObjectEntries.get(head)!;
    const fieldValues = new Map<string, ScalarValue | null>();
    for (const field of fields) {
      const evaluated = evaluateScalarBindingViaSQL(db, schema, entryMap.get(field)!, [], context, ast.pos);
      if (evaluated === undefined || evaluated.kind !== "literal") { fieldValues.clear(); break; }
      fieldValues.set(field, evaluated.value);
    }
    if (fieldValues.size > 0) captured.set(head, fieldValues);
  }
  if (captured.size === 0) return ast;

  // Substitute the captured `<binding>.<entry>` references with literals.
  const substitute = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(substitute);
    if (node === null || typeof node !== "object") return node;
    const n = node as Record<string, unknown> & { kind?: string };
    if (n.kind === "path" && typeof n.head === "string" && typeof n.tail === "string") {
      const fields = captured.get(n.head);
      if (fields?.has(n.tail)) return { kind: "literal", value: fields.get(n.tail) };
    }
    if (n.kind === "field_access"
      && typeof n.field === "string"
      && (n.expr as { kind?: string; name?: string })?.kind === "binding_ref") {
      const head = (n.expr as { name: string }).name;
      const fields = captured.get(head);
      if (fields?.has(n.field)) return { kind: "literal", value: fields.get(n.field as string) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) out[k] = substitute(v);
    return out;
  };
  // Substitute references everywhere except the WITH binding values themselves
  // (a binding may legitimately read another). The captured bindings stay in
  // WITH (harmless if now unreferenced); only the read sites are replaced.
  const withClause = (ast as { with?: WithBinding[] }).with;
  const substituted = substitute({ ...ast, with: undefined }) as Statement;
  return { ...substituted, with: withClause } as Statement;
};

// Evaluate an `if`-condition expression to the full ordered set of scalar rows
// it produces (EdgeQL `if` is element-wise over the condition set). Returns []
// on an empty set or any compile/run failure. Used by the SELECT-with-DML
// pre-pass so a conditional only runs the taken branch's DML per element.
const evaluateConditionRowsViaSQL = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: FreeObjectExpr,
  withBindings: WithBinding[],
  context: SecurityContext,
  pos: { line: number; column: number },
): unknown[] => {
  const stmtAst = {
    kind: "select_expr",
    expr,
    with: withBindings.length > 0 ? [...withBindings] : undefined,
    pos,
  } as unknown as Statement;
  const attempt = tryResult(() => {
    const compiled = getCompilerService().compile(schema, stmtAst, { globals: context.globals, params: context.params, target: resolvedRuntimeTarget(context, db) });
    if (!lowersToSingleSql(compiled.sql)) return undefined;
    return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
  }, { captureAll: true });
  return attempt.ok && Array.isArray(attempt.value) ? attempt.value : [];
};

const rewriteEnvRefsInNode = (node: unknown, env: DmlChainEnv): unknown => {
  const envObjectSet = (name: unknown): ObjectSet | undefined => {
    if (typeof name !== "string") return undefined;
    const bound = env.get(name);
    return bound && bound.typeName !== "" ? bound : undefined;
  };
  const rewrite = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(rewrite);
    if (current === null || typeof current !== "object") return current;
    const n = current as Record<string, unknown> & { kind?: string };
    if (n.kind === "path") {
      const bound = envObjectSet(n.head);
      if (bound) {
        const ptrSteps = ((n.steps as Array<{ kind?: string; name?: string }> | undefined) ?? [])
          .filter((step) => step.kind === "ptr" && typeof step.name === "string");
        const steps = ptrSteps.length > 0 ? ptrSteps : (typeof n.tail === "string" ? [{ kind: "ptr", name: n.tail }] : []);
        let expr: unknown = { kind: "select_expr_subquery", expr: chainByIdSelect(bound) };
        for (const step of steps) {
          expr = { kind: "field_access", expr, field: step.name, optional: false };
        }
        return expr;
      }
    }
    if (n.kind === "binding_ref") {
      const bound = envObjectSet(n.name);
      if (bound) {
        return chainByIdSelect(bound);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) {
      out[key] = rewrite(value);
    }
    return out;
  };
  return rewrite(node);
};

// One link hop over a set of source ids → the target id-set and its type.
// Handles inline single links (`parent` → `parent_id` column), multi links
// (link table), and computed backlinks (`children := .<parent`, `parent :=
// .<children`) in either storage form.
const traverseLinkIds = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  typeName: string,
  ids: string[],
  linkName: string,
): ObjectSet => {
  const td = schema.getType(typeName);
  const placeholders = ids.map(() => "?").join(", ");
  const realLink = (td?.links ?? []).find((link) => link.name === linkName);
  if (realLink && td) {
    const targetType = qualifyChainType(realLink.targetType, typeName.split("::")[0] ?? "default");
    if (usesLinkTable(realLink)) {
      const lt = linkTableName(qualifiedTypeName(resolveLinkStorageOwner(schema, td, realLink)), realLink);
      const rows = ids.length
        ? db.prepare(`SELECT DISTINCT ${quoteIdent("target")} AS t FROM ${quoteIdent(lt)} WHERE ${quoteIdent("source")} IN (${placeholders})`).all(...ids) as { t?: unknown }[]
        : [];
      return { typeName: targetType, ids: rows.map((r) => String(r.t)) };
    }
    const col = `${linkName}_id`;
    const rows = ids.length
      ? db.prepare(`SELECT DISTINCT ${quoteIdent(col)} AS t FROM ${quoteIdent(tableNameForType(typeName))} WHERE ${quoteIdent("id")} IN (${placeholders})`).all(...ids) as { t?: unknown }[]
      : [];
    return { typeName: targetType, ids: rows.map((r) => r.t).filter((t): t is string => typeof t === "string") };
  }
  const computed = (td?.computeds ?? []).find(
    (c) => c.kind === "link" && c.name === linkName && (c as { expr?: { kind?: string } }).expr?.kind === "backlink",
  ) as { expr?: { link?: string; sourceType?: string } } | undefined;
  if (computed?.expr?.link) {
    const backLink = computed.expr.link;
    const srcType = qualifyChainType(computed.expr.sourceType ?? typeName, typeName.split("::")[0] ?? "default");
    const srcTd = schema.getType(srcType);
    const backReal = (srcTd?.links ?? []).find((link) => link.name === backLink);
    if (backReal && srcTd && usesLinkTable(backReal)) {
      const lt = linkTableName(qualifiedTypeName(resolveLinkStorageOwner(schema, srcTd, backReal)), backReal);
      const rows = ids.length
        ? db.prepare(`SELECT DISTINCT ${quoteIdent("source")} AS s FROM ${quoteIdent(lt)} WHERE ${quoteIdent("target")} IN (${placeholders})`).all(...ids) as { s?: unknown }[]
        : [];
      return { typeName: srcType, ids: rows.map((r) => String(r.s)) };
    }
    const col = `${backLink}_id`;
    const rows = ids.length
      ? db.prepare(`SELECT DISTINCT ${quoteIdent("id")} AS s FROM ${quoteIdent(tableNameForType(srcType))} WHERE ${quoteIdent(col)} IN (${placeholders})`).all(...ids) as { s?: unknown }[]
      : [];
    return { typeName: srcType, ids: rows.map((r) => String(r.s)) };
  }
  return { typeName, ids: [] };
};

// Apply a select_expr_subquery wrapper's ORDER BY / LIMIT / OFFSET to a base
// id-set (`(SELECT T.children ORDER BY .val LIMIT 1)`). FILTER on the wrapper
// is not handled here (callers fall back).
const applyChainSubqueryClauses = (
  db: SQLiteDatabase,
  base: ObjectSet,
  node: { orderBy?: unknown; limit?: number; offset?: number },
): ObjectSet => {
  let ids = base.ids;
  const orderBy = node.orderBy as { field?: string; expr?: { field?: string }; direction?: "asc" | "desc" } | undefined;
  const orderField = orderBy?.field ?? orderBy?.expr?.field;
  if (orderField && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db.prepare(
      `SELECT ${quoteIdent("id")} AS id, ${quoteIdent(orderField)} AS k FROM ${quoteIdent(tableNameForType(base.typeName))} WHERE ${quoteIdent("id")} IN (${placeholders})`,
    ).all(...ids) as { id?: unknown; k?: unknown }[];
    rows.sort((a, b) => {
      const ka = a.k as string | number, kb = b.k as string | number;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    if (orderBy?.direction === "desc") rows.reverse();
    ids = rows.map((r) => String(r.id));
  }
  ids = applyLimitOffset(ids, node.limit, node.offset);
  return { typeName: base.typeName, ids };
};

// Resolve an object-set value/expression (a SET link value, a binding, a path,
// or a subquery) to a concrete id-set, given the current binding environment
// and the row being updated (for `.`-relative paths like `.parent.parent`).
const resolveObjectSet = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  node: unknown,
  env: DmlChainEnv,
  current: ObjectSet | undefined,
  context: SecurityContext,
  defaultModule: string,
): ObjectSet => {
  if (node === null || typeof node !== "object") {
    return { typeName: current?.typeName ?? "", ids: [] };
  }
  const n = node as { kind?: string; [k: string]: unknown };
  switch (n.kind) {
    case "set_expr":
    case "set": {
      const values = (n.values as unknown[]) ?? [];
      let typeName = current?.typeName ?? "";
      const acc: string[] = [];
      for (const el of values) {
        const r = resolveObjectSet(db, schema, el, env, current, context, defaultModule);
        if (r.typeName) typeName = r.typeName;
        acc.push(...r.ids);
      }
      return { typeName, ids: [...new Set(acc)] };
    }
    case "expr":
    case "subquery_expr":
    case "distinct":
    case "shape_projection":
      return resolveObjectSet(db, schema, n.expr, env, current, context, defaultModule);
    case "cast": {
      // `<Bar>{}` — an empty-set cast to an object type. The inner set is empty
      // (no ids), but the cast names the type, so propagate it so an enclosing
      // `if … else <Bar>{}` knows the result's type even on the empty branch.
      const inner = resolveObjectSet(db, schema, n.expr, env, current, context, defaultModule);
      if (inner.ids.length === 0 && typeof n.castType === "string") {
        const qn = qualifyChainType(n.castType, defaultModule);
        if (schema.getType(qn)) return { typeName: qn, ids: [] };
      }
      return inner;
    }
    case "function_call": {
      // Set-identity guards (`assert_distinct`, `assert_single`,
      // `assert_exists`, `distinct`) don't change membership — resolve their
      // argument set directly.
      const call = n.call as { name?: string; args?: unknown[] } | undefined;
      const fnName = (call?.name ?? "").split("::").pop();
      if (call?.args?.length && ["assert_distinct", "assert_single", "assert_exists", "distinct"].includes(fnName ?? "")) {
        return resolveObjectSet(db, schema, call.args[0], env, current, context, defaultModule);
      }
      return { typeName: current?.typeName ?? "", ids: [] };
    }
    case "subquery_statement":
      return executeDmlChainStatement(db, schema, n.statement as Statement, env, current, context, defaultModule);
    case "mutation_expr":
      return executeDmlChainStatement(db, schema, n.statement as Statement, env, current, context, defaultModule);
    case "coalesce": {
      // Upsert-by-coalesce: `(SELECT …) ?? (INSERT …)` — the right side (and
      // its mutation) only runs when the left side is empty.
      const left = resolveObjectSet(db, schema, n.left, env, current, context, defaultModule);
      if (left.ids.length > 0) return left;
      return resolveObjectSet(db, schema, n.right, env, current, context, defaultModule);
    }
    case "if_else": {
      // `if <cond> then (DML) else (DML)` — element-wise over the condition
      // set; only the taken branch per condition element runs. (A FOR loop
      // variable referenced by the condition is substituted in as a literal by
      // the for_expr case before this point, so the condition compiles
      // standalone.)
      const condRows = evaluateConditionRowsViaSQL(db, schema, n.condition as FreeObjectExpr, [], context, { line: 0, column: 0 });
      let typeName = "";
      const ids: string[] = [];
      for (const condRow of condRows) {
        const taken = condRow === true || condRow === 1 ? n.thenExpr : n.elseExpr;
        if (!taken) continue;
        const result = resolveObjectSet(db, schema, taken, env, current, context, defaultModule);
        if (result.typeName) typeName = result.typeName;
        ids.push(...result.ids);
      }
      return { typeName, ids };
    }
    case "for_expr": {
      // `FOR v IN <iter> UNION (<body>)` — run the body once per scalar iterator
      // value with `v` bound. The iterator may be a literal set or any scalar
      // expression (`array_unpack(<array<int64>>$0)`); the body may be a bare
      // mutation, a coalesce, or a conditional. The loop value is bound two
      // ways for the body: as a WITH binding attached to nested mutations (so
      // an inserted property `l2 := v` resolves through the mutation's own
      // compile), and substituted as a literal into condition/non-mutation
      // expressions (so an `if v % 2 = 0` condition compiles standalone).
      const iterator = n.iterator as { kind?: string; values?: unknown[] } | undefined;
      const variable = n.variable as string | undefined;
      const body = n.body;
      if (!variable || !body) {
        return { typeName: current?.typeName ?? "", ids: [] };
      }
      let iterValues: unknown[];
      if (iterator?.kind === "set_literal") {
        iterValues = iterator.values ?? [];
      } else {
        iterValues = evaluateConditionRowsViaSQL(db, schema, n.iterator as FreeObjectExpr, [], context, { line: 0, column: 0 });
      }
      let typeName = "";
      const ids: string[] = [];
      for (const iterValue of iterValues) {
        if (iterValue !== null && !isScalarValue(iterValue)) {
          return { typeName: current?.typeName ?? "", ids: [] };
        }
        const boundBody = bindLoopVarInForBody(body, variable, iterValue as ScalarValue);
        const result = resolveObjectSet(db, schema, boundBody, env, current, context, defaultModule);
        if (result.typeName) typeName = result.typeName;
        ids.push(...result.ids);
      }
      return { typeName, ids };
    }
    case "binding_ref": {
      const bound = env.get(n.name as string);
      if (bound) return bound;
      const qn = qualifyChainType(n.name as string, defaultModule);
      if (schema.getType(qn)) {
        const rows = db.prepare(`SELECT ${quoteIdent("id")} AS id FROM ${quoteIdent(tableNameForType(qn))}`).all() as { id?: unknown }[];
        return { typeName: qn, ids: rows.map((r) => String(r.id)) };
      }
      return { typeName: "", ids: [] };
    }
    case "current_item":
      return current ?? { typeName: "", ids: [] };
    case "field_access": {
      const base = resolveObjectSet(db, schema, n.expr, env, current, context, defaultModule);
      return traverseLinkIds(db, schema, base.typeName, base.ids, n.field as string);
    }
    case "path": {
      const base = resolveObjectSet(db, schema, { kind: "binding_ref", name: n.head }, env, current, context, defaultModule);
      return n.tail ? traverseLinkIds(db, schema, base.typeName, base.ids, n.tail as string) : base;
    }
    case "path_chain": {
      const parts = n.parts as string[];
      let cur = resolveObjectSet(db, schema, { kind: "binding_ref", name: parts[0] }, env, current, context, defaultModule);
      for (let i = 1; i < parts.length; i += 1) {
        cur = traverseLinkIds(db, schema, cur.typeName, cur.ids, parts[i]);
      }
      return cur;
    }
    case "select_expr_subquery": {
      // `(WITH name := …, INSERT …)` — the subquery's WITH bindings live on
      // its clauses, not on the wrapped statement. Merge them onto the
      // mutation so its values can resolve them when it executes.
      {
        const innerBindings = (n.clauses as { _withBindings?: WithBinding[] } | undefined)?._withBindings;
        const innerExpr = n.expr as { kind?: string; statement?: Statement } | undefined;
        if (innerBindings && innerBindings.length > 0 && innerExpr?.kind === "mutation_expr" && innerExpr.statement) {
          const stmt = innerExpr.statement as Statement & { with?: WithBinding[] };
          // Inner bindings come last so they shadow same-named outer ones.
          const merged = { ...stmt, with: [...(stmt.with ?? []), ...innerBindings] } as Statement;
          return executeDmlChainStatement(db, schema, merged, env, current, context, defaultModule);
        }
      }
      let result = resolveObjectSet(db, schema, n.expr, env, current, context, defaultModule);
      // `SELECT _ := X FILTER _ != Y` / `_ = Y` — element-wise set difference /
      // intersection against another object set. The alias (`_`) on one side
      // marks the iterated element; the other side resolves to the id-set to
      // exclude/keep.
      const filter = n.filter as { kind?: string; op?: string; left?: { kind?: string; name?: string }; right?: { kind?: string; name?: string } } | undefined;
      if (filter?.kind === "compare" && (filter.op === "!=" || filter.op === "=")) {
        const alias = (n.alias as string | undefined) ?? "_";
        const isAliasRef = (x: { kind?: string; name?: string } | undefined): boolean =>
          !!x && x.kind === "binding_ref" && (x.name === alias || x.name === "_");
        const otherSide = isAliasRef(filter.left) ? filter.right : isAliasRef(filter.right) ? filter.left : undefined;
        if (otherSide) {
          const other = resolveObjectSet(db, schema, otherSide, env, current, context, defaultModule);
          const otherSet = new globalThis.Set(other.ids);
          result = {
            typeName: result.typeName,
            ids: filter.op === "!=" ? result.ids.filter((id) => !otherSet.has(id)) : result.ids.filter((id) => otherSet.has(id)),
          };
        }
      }
      return applyChainSubqueryClauses(db, result, n as { orderBy?: unknown; limit?: number; offset?: number });
    }
    case "select": {
      const rows = executeSelectExprRows(
        db,
        schema,
        { kind: "select", typeName: n.typeName as string, shape: (n.shape as ShapeElement[]) ?? [], clauses: (n.clauses as Record<string, unknown>) ?? {} } as unknown as Extract<InsertValue, { kind: "select" }>,
        context,
      );
      return {
        typeName: qualifyChainType(n.typeName as string, defaultModule),
        ids: rows.map((r) => r.id).filter((id): id is string => typeof id === "string"),
      };
    }
    default:
      return { typeName: current?.typeName ?? "", ids: [] };
  }
};

// Execute one DML statement within a chain, resolving its target set and link
// values against `env`, and return the affected rows as an id-set. Writes go
// through the normal write path, one `.id = <uuid>` mutation per row, with
// each SET link value rewritten to a by-id SELECT (or empty set).
// Resolve the concrete type that physically stores a given id within a
// (possibly abstract) base type's hierarchy. Multi-table inheritance stores
// each concrete type in its own table, so a per-id UPDATE/DELETE must target
// the table the row actually lives in — not the base type's table (which may
// be empty / a different type). Returns the base type's name as a fallback.
const concreteTypeNameForId = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  baseTypeName: string,
  id: string,
): string => {
  const rowExists = (typeDef: TypeDef): boolean => {
    const table = tableNameForType(qualifiedTypeName(typeDef));
    const row = tryResult(() =>
      db.prepare(`SELECT 1 FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} = ? LIMIT 1`).all(id)[0],
    );
    return row.ok && row.value !== undefined;
  };
  const checked = new Set<string>();
  const concretes = schema.listConcreteTypesAssignableTo(baseTypeName);
  for (const typeDef of concretes) {
    checked.add(qualifiedTypeName(typeDef));
    if (rowExists(typeDef)) {
      return qualifiedTypeName(typeDef);
    }
  }
  // The id may belong to a sibling not assignable to `baseTypeName` — a
  // heterogeneous union (`(SELECT A) UNION (SELECT B)`) resolves to one
  // branch's type yet carries ids of both. Fall back to scanning every other
  // concrete type so each row is re-targeted at the table that actually holds
  // it (ids are globally unique, so the first match is authoritative).
  for (const typeDef of schema.listTypes()) {
    if (typeDef.abstract || checked.has(qualifiedTypeName(typeDef))) continue;
    if (rowExists(typeDef)) {
      return qualifiedTypeName(typeDef);
    }
  }
  return baseTypeName;
};

const executeDmlChainStatement = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  stmt: Statement,
  env: DmlChainEnv,
  outerCurrent: ObjectSet | undefined,
  context: SecurityContext,
  defaultModule: string,
): ObjectSet => {
  if (stmt.kind !== "update" && stmt.kind !== "delete" && stmt.kind !== "insert") {
    return { typeName: "", ids: [] };
  }
  const compilerService = getCompilerService();
  const runtimeTarget = resolvedRuntimeTarget(context, db);

  if (stmt.kind === "insert") {
    let rewritten = env.size > 0
      ? ({ ...stmt, values: rewriteEnvRefsInNode(stmt.values, env) } as typeof stmt)
      : stmt;
    const capturedWith: WithBinding[] = [];
    let withChanged = false;
    for (const binding of (rewritten as { with?: WithBinding[] }).with ?? []) {
      if (binding.value.kind === "subquery_expr" && !bindingValueContainsMutation(binding.value)) {
        const expr = env.size > 0
          ? rewriteEnvRefsInNode(binding.value.expr, env) as FreeObjectExpr
          : binding.value.expr;
        const evaluated = evaluateScalarBindingViaSQL(db, schema, expr, capturedWith, context, stmt.pos);
        if (evaluated !== undefined) {
          capturedWith.push({ name: binding.name, value: evaluated } as WithBinding);
          withChanged = true;
          continue;
        }
      }
      capturedWith.push(binding);
    }
    if (withChanged) {
      rewritten = { ...rewritten, with: capturedWith } as typeof stmt;
    }
    const compiled = compilerService.compile(schema, rewritten, { globals: context.globals, params: context.params, target: runtimeTarget });
    const subjectType = typeDefForTable(schema, (compiled.ir as { table?: string }).table ?? "");
    if (!subjectType) return { typeName: "", ids: [] };
    const writeResult = runWriteWithAccessPolicies(db, schema, rewritten, compiled.ir, compiled.sql, subjectType, context);
    return {
      typeName: qualifiedTypeName(subjectType),
      ids: (writeResult.rows ?? []).map((r) => (r as { id?: unknown }).id).filter((id): id is string => typeof id === "string"),
    };
  }

  // Resolve the target id-set: an explicit sub-select target, a binding-named
  // subject, or a bare type + FILTER.
  const stmtAny = stmt as unknown as { target?: unknown; typeName: string; filter?: FilterExpr; values?: Record<string, unknown>; operations?: Record<string, string> };
  let target: ObjectSet;
  const envTarget = env.get(stmtAny.typeName);
  if (stmtAny.target) {
    target = resolveObjectSet(db, schema, stmtAny.target, env, outerCurrent, context, defaultModule);
  } else if (envTarget) {
    target = envTarget;
  } else {
    // Carry the statement's own WITH bindings (e.g. a FOR loop variable bound
    // as a literal) into the synthetic target SELECT so the FILTER expression
    // (`.l2 = n`) can resolve them — otherwise an unbound name resolves as a
    // (non-existent) type.
    const targetWith = (stmt as { with?: WithBinding[] }).with;
    const rows = executeSelectExprRows(
      db,
      schema,
      { kind: "select", typeName: stmtAny.typeName, shape: [{ kind: "field", name: "id" }], clauses: { filter: stmtAny.filter, _withBindings: targetWith } } as unknown as Extract<InsertValue, { kind: "select" }>,
      context,
    );
    target = { typeName: qualifyChainType(stmtAny.typeName, defaultModule), ids: rows.map((r) => r.id).filter((id): id is string => typeof id === "string") };
  }

  if (stmt.kind === "delete") {
    for (const id of target.ids) {
      // A heterogeneous union (`(SELECT A …) UNION (SELECT B …)`) resolves to a
      // single ObjectSet typed at the common ancestor (possibly abstract), so
      // re-target each row at the concrete type that physically stores it —
      // deleting from the (abstract/base) ancestor table would miss the row.
      const concreteType = concreteTypeNameForId(db, schema, target.typeName, id);
      const perId = { kind: "delete", typeName: concreteType, filter: { kind: "predicate", target: { kind: "field", field: "id" }, op: "=", value: id }, pos: { line: 1, column: 1 } } as unknown as DeleteStatement;
      const runDelete = (): void => {
        const c = compilerService.compile(schema, perId, { globals: context.globals, params: context.params, target: runtimeTarget });
        const st = typeDefForTable(schema, (c.ir as { table?: string }).table ?? "");
        if (st) runWriteWithAccessPolicies(db, schema, perId, c.ir, c.sql, st, context);
      };
      // In an embedded-delete-in-select context (`SELECT (DELETE …)`), defer the
      // physical removal so the enclosing SELECT can still read the rows it is
      // about to return; otherwise delete immediately as before.
      if (deferredChainDeletes !== null) {
        deferredChainDeletes.push(runDelete);
      } else {
        runDelete();
      }
    }
    return target;
  }

  // UPDATE: per affected row, rewrite each SET link value to a by-id SELECT
  // (or empty set) resolved against env + the current row.
  for (const id of target.ids) {
    const concreteType = concreteTypeNameForId(db, schema, target.typeName, id);
    const current: ObjectSet = { typeName: concreteType, ids: [id] };
    // Link names of the concrete type — only link assignments are resolved
    // to object-set by-id selects. Scalar property assignments (e.g. `name :=
    // 'Madeline Hatch'`) must pass through unchanged (with env refs rewritten),
    // otherwise resolveObjectSet would coerce them to an empty set → NULL.
    const concreteDef = schema.getType(concreteType);
    const linkNames = new Set((concreteDef?.links ?? []).map((l) => l.name));
    const values: Record<string, unknown> = {};
    const operations: Record<string, string> = {};
    for (const [link, raw] of Object.entries(stmtAny.values ?? {})) {
      operations[link] = stmtAny.operations?.[link] ?? "assign";
      if (!linkNames.has(link)) {
        // Scalar property: keep the original value expression, rewriting any
        // chain-binding references to literals/by-id selects.
        values[link] = env.size > 0 ? rewriteEnvRefsInNode(raw, env) : raw;
        continue;
      }
      const resolved = resolveObjectSet(db, schema, raw, env, current, context, defaultModule);
      values[link] = resolved.ids.length === 0
        ? { kind: "set", values: [] }
        : {
            kind: "select",
            typeName: resolved.typeName,
            shape: [{ kind: "field", name: "id" }],
            clauses: { filter: { kind: "in_predicate", target: { kind: "field", field: "id" }, op: "in", values: { kind: "set_literal", values: resolved.ids } } },
          };
    }
    const perId = {
      kind: "update",
      typeName: concreteType,
      // Preserve the statement's WITH bindings + module so scalar property
      // assignments that reference them (`SET {name := name}`) still resolve.
      with: (stmt as { with?: WithBinding[] }).with,
      withModule: (stmt as { withModule?: string }).withModule,
      withModuleAliases: (stmt as { withModuleAliases?: unknown }).withModuleAliases,
      filter: { kind: "predicate", target: { kind: "field", field: "id" }, op: "=", value: id },
      values,
      operations,
      pos: { line: 1, column: 1 },
    } as unknown as UpdateStatement;
    const c = compilerService.compile(schema, perId, { globals: context.globals, params: context.params, target: runtimeTarget });
    const st = typeDefForTable(schema, (c.ir as { table?: string }).table ?? "");
    if (st) runWriteWithAccessPolicies(db, schema, perId, c.ir, c.sql, st, context);
  }
  return target;
};

// Detect a top-level UPDATE/DELETE/INSERT whose WITH bindings form a DML chain
// (a binding is a DML subquery, or the subject/a SET value references a
// binding). Returns the statement when it should run through the chain
// executor, else null.
// A DML statement bound in WITH can hide behind expression wrappers
// (`x := (WITH … INSERT …)` parses as subquery_expr → select_expr_subquery →
// mutation_expr). Detect it through those fences.
const bindingValueContainsMutation = (value: WithBindingValue): boolean => {
  if (value.kind === "subquery_statement") return true;
  if (value.kind !== "subquery_expr") return false;
  const walk = (expr: FreeObjectExpr | undefined): boolean => {
    if (!expr) return false;
    if (expr.kind === "mutation_expr") return true;
    if (expr.kind === "select_expr_subquery" || expr.kind === "distinct" || expr.kind === "shape_projection") {
      return walk((expr as { expr: FreeObjectExpr }).expr);
    }
    if (expr.kind === "coalesce") {
      const pair = expr as unknown as { left?: FreeObjectExpr; right?: FreeObjectExpr };
      return walk(pair.left) || walk(pair.right);
    }
    // `t := (if <cond> then (DML) else (DML)/<T>{})` — DML may hide in either
    // arm; resolveObjectSet's if_else case runs only the taken branch.
    if (expr.kind === "if_else") {
      const ie = expr as unknown as { thenExpr?: FreeObjectExpr; elseExpr?: FreeObjectExpr };
      return walk(ie.thenExpr) || walk(ie.elseExpr);
    }
    if (expr.kind === "set_expr" || expr.kind === "tuple") {
      return (expr as { values: FreeObjectExpr[] }).values.some((v) => walk(v));
    }
    if (expr.kind === "for_expr") {
      return walk((expr as unknown as { body?: FreeObjectExpr }).body);
    }
    if (expr.kind === "function_call") {
      const call = (expr as { call?: { args?: Array<{ kind?: string; expr?: FreeObjectExpr }> } }).call;
      return (call?.args ?? []).some((arg) => arg.kind === "expr" && walk(arg.expr));
    }
    return false;
  };
  return walk(value.expr);
};

// True when a binding/expr contains a `mutation_expr` that sits *inside* a
// tuple element (`x := { ((INSERT A), "bar") }`) rather than being the
// object set itself (`x := (INSERT A)` / `x := { (INSERT A), (INSERT B) }`).
// A mutation inside a tuple can't be collapsed to an object set — the tuple's
// scalar members and shape must survive — so it needs leaf substitution.
const mutationNestedInTuple = (node: unknown): boolean => {
  const walk = (cur: unknown, insideTuple: boolean): boolean => {
    if (Array.isArray(cur)) return cur.some((c) => walk(c, insideTuple));
    if (cur === null || typeof cur !== "object") return false;
    const n = cur as Record<string, unknown> & { kind?: string };
    if (n.kind === "mutation_expr") return insideTuple;
    // A shape projection over a mutation (`(INSERT A){ @lp := … }`) is handled
    // by the link-assignment machinery — don't treat it as a bare tuple leaf.
    if (n.kind === "shape_projection") return false;
    const nowInsideTuple = insideTuple || n.kind === "tuple" || n.kind === "named_tuple";
    return Object.entries(n).some(([key, value]) =>
      key === "kind" ? false : walk(value, nowInsideTuple));
  };
  return walk(node, false);
};

// Execute every `mutation_expr` leaf in a binding/expr subtree and replace it
// in place with a by-id SELECT, leaving the surrounding tuple/set structure
// intact. Used for DML-valued tuple elements (`x := { ((INSERT A), "bar") }`)
// so the remainder lowers to plain SQL.
const substituteMutationLeaves = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  node: unknown,
  env: DmlChainEnv,
  context: SecurityContext,
  defaultModule: string,
  passthrough: WithBinding[],
): unknown => {
  const walk = (cur: unknown): unknown => {
    if (Array.isArray(cur)) return cur.map(walk);
    if (cur === null || typeof cur !== "object") return cur;
    const n = cur as Record<string, unknown> & { kind?: string; statement?: Statement };
    if (n.kind === "mutation_expr" && n.statement) {
      const resolved = resolveObjectSet(
        db, schema,
        attachWithToNestedMutations(n, passthrough),
        env, undefined, context, defaultModule,
      );
      return { kind: "select_expr_subquery", expr: chainByIdSelect(resolved) };
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) out[key] = walk(value);
    return out;
  };
  return walk(node);
};

const isWithDmlChain = (ast: Statement): ast is UpdateStatement | DeleteStatement | InsertStatement => {
  if (ast.kind !== "update" && ast.kind !== "delete" && ast.kind !== "insert") return false;
  const withBindings = (ast as { with?: WithBinding[] }).with ?? [];
  if (withBindings.length === 0) return false;
  // Only engage when a binding is a DML subquery, the subject names a binding,
  // or the UPDATE/DELETE target is a binding ref (`WITH X := (… UNION …) DELETE
  // X`) — plain scalar/SELECT WITH bindings keep their existing path. The
  // target-binding case routes a heterogeneous-union delete through the chain
  // executor, which resolves the binding to ids and deletes each by its
  // concrete type; the polymorphic-type expansion can't (the binding name is
  // not a type).
  const hasDmlBinding = withBindings.some((b) => bindingValueContainsMutation(b.value));
  const subjectIsBinding = withBindings.some((b) => b.name === (ast as { typeName?: string }).typeName);
  const target = (ast as { target?: { kind?: string; name?: string } }).target;
  const targetIsBinding = target?.kind === "binding_ref"
    && withBindings.some((b) => b.name === target.name);
  return hasDmlBinding || subjectIsBinding || targetIsBinding;
};

const executeWithDmlChain = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: UpdateStatement | DeleteStatement | InsertStatement,
  context: SecurityContext,
): QueryExecutionTrace => {
  const result = runDmlChain(db, schema, ast, context);
  const emptyArtifact: SQLArtifact = { sql: "", params: [], loweringMode: "single_statement" };
  return {
    ast,
    ir: undefined,
    sql: emptyArtifact,
    compiler: { key: "with-dml-chain", status: "miss", stats: { hits: 0, misses: 0, size: 0 } },
    sqlTrail: [],
    overlays: [],
    result: { kind: ast.kind as QueryResult["kind"], changes: result.ids.length },
  };
};

// Core of the WITH-DML chain executor: evaluate the bindings, run the final
// statement, and return the affected rows as an id-set.
const runDmlChain = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: UpdateStatement | DeleteStatement | InsertStatement,
  context: SecurityContext,
): ObjectSet => {
  const defaultModule = (ast as { withModule?: string }).withModule ?? "default";
  const env: DmlChainEnv = new Map();
  // Snapshot exclusive values before any chain DML runs, so a value freed by
  // one statement and re-used by a sibling surfaces as the exclusivity conflict
  // EdgeQL's single-snapshot semantics require (see captureExclusiveSnapshot).
  // Only meaningful when the chain mutates from more than one statement.
  const chainDmlCount = ((ast as { with?: WithBinding[] }).with ?? [])
    .filter((b) => bindingValueContainsMutation(b.value)).length
    + ((ast.kind === "insert" || ast.kind === "update" || ast.kind === "delete") ? 1 : 0);
  const chainTypeNames = chainDmlCount >= 2 ? collectChainTypeNames(ast, defaultModule) : undefined;
  const exclusiveSnapshot = chainTypeNames ? captureExclusiveSnapshot(db, schema, chainTypeNames) : undefined;
  // Evaluate WITH bindings in declaration order; DML bindings execute (and
  // mutate) as they're evaluated. Scalar/non-DML bindings declared earlier are
  // forwarded onto each DML binding's statement so its values can resolve
  // them when it compiles standalone (`WITH x := "!", y := (WITH name := x ++
  // …, INSERT …)` — the inner INSERT needs `x`).
  const passthroughWith: WithBinding[] = [];
  const replacedBindings = new Map<string, WithBinding>();
  // A scalar binding that reads from an executed DML binding (`y := x.name ++
  // <str>random()`) must be computed exactly once and shared by every
  // reference (EdgeQL materializes WITH bindings). Evaluate it through a
  // one-off SQL SELECT with the env references rewritten to by-id selects,
  // then forward the captured value as a literal binding.
  const tryEvaluateScalarBinding = (expr: FreeObjectExpr): WithBindingValue | undefined =>
    evaluateScalarBindingViaSQL(db, schema, expr, passthroughWith, context, ast.pos);
  for (const binding of (ast as { with?: WithBinding[] }).with ?? []) {
    if (bindingValueContainsMutation(binding.value)) {
      env.set(binding.name, resolveObjectSet(db, schema, attachWithToNestedMutations(binding.value, passthroughWith), env, undefined, context, defaultModule));
      continue;
    }
    env.set(binding.name, resolveObjectSet(db, schema, binding.value, env, undefined, context, defaultModule));
    if (binding.value.kind === "subquery_expr") {
      // Materialize a scalar WITH binding to a single literal so every
      // reference shares ONE value. This matters in two cases:
      //  - the binding reads an executed DML binding (`y := x.name ++ …`), and
      //  - the binding is purely volatile (`x := <str>random()`): without
      //    capture, the compiler inlines `random()` at each use site and the
      //    references diverge (`x ++ a` vs `x ++ b` get different randoms).
      // Evaluate against the env-rewritten expression so DML refs resolve;
      // capture only when it collapses to a single literal.
      const rewrittenExpr = rewriteEnvRefsInNode(binding.value.expr, env) as FreeObjectExpr;
      const evaluated = tryEvaluateScalarBinding(rewrittenExpr);
      if (evaluated !== undefined && evaluated.kind === "literal") {
        const replacement = { name: binding.name, value: evaluated } as WithBinding;
        passthroughWith.push(replacement);
        replacedBindings.set(binding.name, replacement);
        continue;
      }
    }
    passthroughWith.push(binding);
  }
  // The final statement compiles standalone — bindings that were captured to
  // literals above must shadow their originals there too.
  const finalAst = replacedBindings.size > 0
    ? ({
        ...ast,
        with: ((ast as { with?: WithBinding[] }).with ?? []).map((binding) => replacedBindings.get(binding.name) ?? binding),
      } as typeof ast)
    : ast;
  const chainResult = executeDmlChainStatement(db, schema, finalAst, env, undefined, context, defaultModule);
  if (exclusiveSnapshot && chainTypeNames) {
    validateExclusiveSnapshot(db, schema, chainTypeNames, exclusiveSnapshot, ast.pos);
  }
  return chainResult;
};

// Mutations nested inside DML value expressions (`INSERT A { x := (INSERT C
// { x := 2 }).x }`): execute the inner mutation first and substitute a by-id
// SELECT, so the enclosing statement's values lower to plain SQL. Top-level
// link targets of kind "insert" are untouched — the write path executes those
// natively.
const preExecuteMutationExprsInDmlValues = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  context: SecurityContext,
): Statement => {
  if (ast.kind !== "insert" && ast.kind !== "update") return ast;
  const values = (ast as { values?: Record<string, unknown> }).values;
  if (!values) return ast;
  const containsMutationExpr = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(containsMutationExpr);
    if (node === null || typeof node !== "object") return false;
    const k = (node as { kind?: unknown }).kind;
    // A bare nested INSERT/UPDATE/DELETE statement (e.g. a `for`-value body, or
    // a `for` value itself) is DML even without a `mutation_expr` wrapper.
    if (k === "mutation_expr" || k === "insert" || k === "update" || k === "delete") return true;
    return Object.values(node as object).some(containsMutationExpr);
  };
  if (!containsMutationExpr(values)) return ast;
  const defaultModule = (ast as { withModule?: string }).withModule ?? "default";

  // Suppress eager nested-DML execution when the *outer* INSERT will be
  // suppressed by UNLESS CONFLICT. Without this, `INSERT Person { note :=
  // (INSERT Note …) } UNLESS CONFLICT` would run the nested `INSERT Note` even
  // on the conflicting second run (so count(Note) doubles). When the outer
  // INSERT conflicts and the ELSE (if any) doesn't re-run the values, the
  // nested mutations must not execute. We detect the conflict statically by
  // resolving the conflict-target value and probing the table; on a hit, the
  // nested-DML link values are replaced with an empty set so nothing runs and
  // the (suppressed) outer INSERT writes nothing anyway.
  if (ast.kind === "insert" && ast.conflict) {
    const qualified = qualifyRuntimeTypeName(ast.typeName, defaultModule);
    const subjectType = schema.getType(qualified) ?? schema.getType(ast.typeName);
    // A plain UNLESS CONFLICT (or UNLESS CONFLICT ON with a SELECT/empty ELSE)
    // never re-runs the inserted values; UNLESS CONFLICT ON … ELSE (UPDATE …)
    // also leaves the nested INSERTs of the conflicting branch unused.
    if (subjectType) {
      const conflictField = resolveConflictField(ast as InsertStatement, subjectType);
      if (conflictField) {
        const resolveBinding = makeBindingResolver(ast, context, ast.pos.line, ast.pos.column);
        const rawValue = ast.values[conflictField];
        const staticValue = rawValue !== undefined
          ? tryResult(() => scalarFromInsertValue(rawValue, resolveBinding, ast.pos.line, ast.pos.column))
          : undefined;
        if (staticValue?.ok) {
          const table = tableNameForType(qualified);
          const existingId = findConflictRowId(db, table, conflictField, staticValue.value);
          if (existingId) {
            // Outer insert conflicts → drop every nested mutation in the
            // values so none of them execute. Empty the assignment value.
            const emptied: Record<string, unknown> = {};
            for (const [field, value] of Object.entries(values)) {
              emptied[field] = containsMutationExpr(value)
                ? { kind: "set", values: [] }
                : value;
            }
            return { ...ast, values: emptied } as Statement;
          }
        }
      }
    }
  }

  const env: DmlChainEnv = new Map();
  // The outer statement's scalar bindings are shared between the enclosing
  // statement and the nested mutations — a volatile binding (`x :=
  // <str>random()`) must capture ONE value for both. Evaluate each scalar
  // binding once and substitute the literal everywhere.
  const outerWith: WithBinding[] = [];
  let withChanged = false;
  for (const binding of (ast as { with?: WithBinding[] }).with ?? []) {
    if (binding.value.kind === "subquery_expr" && !bindingValueContainsMutation(binding.value)) {
      const evaluated = evaluateScalarBindingViaSQL(db, schema, binding.value.expr, outerWith, context, ast.pos);
      if (evaluated !== undefined) {
        outerWith.push({ name: binding.name, value: evaluated } as WithBinding);
        withChanged = true;
        continue;
      }
    }
    outerWith.push(binding);
  }
  // A nested `INSERT Target { …, @prop := … }` used as a link value carries
  // link-property assignments (`@comment`, `@note`) that belong to the
  // ENCLOSING link, not the target type. Split those `@`-fields out of the
  // inner insert's values and return them as computed shape elements so the
  // (already supported) `(<insert>) { @prop := … }` shape-projection path
  // applies them as link properties on the assignment. Returns undefined when
  // the inner insert has no link-property fields.
  const extractLinkPropShapeElements = (
    stmt: Statement & { values?: Record<string, unknown> },
  ): ShapeElement[] | undefined => {
    const innerValues = stmt.values;
    if (!innerValues) return undefined;
    const linkPropElements: ShapeElement[] = [];
    for (const key of Object.keys(innerValues)) {
      if (!key.startsWith("@")) continue;
      const raw = innerValues[key];
      // Insert values store the assignment either as a raw literal (`'c'`) or
      // wrapped as `{ kind: "expr", expr: … }`. Normalise to a shape-element
      // computed expression.
      const expr = (raw !== null && typeof raw === "object" && (raw as { kind?: string }).kind === "expr")
        ? (raw as { expr: unknown }).expr
        : { kind: "literal", value: raw };
      linkPropElements.push({
        kind: "computed",
        name: key,
        expr: expr as ShapeElement extends { expr: infer E } ? E : never,
        operation: "assign",
        origin: "explicit",
      } as ShapeElement);
      delete innerValues[key];
    }
    return linkPropElements.length > 0 ? linkPropElements : undefined;
  };
  const runNestedObjectSet = (stmt: Statement & { with?: WithBinding[] }, extraWith: WithBinding[]): ObjectSet => {
    const mergedWith = [...outerWith, ...extraWith, ...(stmt.with ?? [])];
    const merged = mergedWith.length > 0 ? ({ ...stmt, with: mergedWith } as Statement) : (stmt as Statement);
    return executeDmlChainStatement(db, schema, merged, env, undefined, context, defaultModule);
  };
  const runNested = (stmt: Statement & { with?: WithBinding[] }, extraWith: WithBinding[]): unknown => {
    const resolved = runNestedObjectSet(stmt, extraWith);
    return { kind: "select_expr_subquery", expr: chainByIdSelect(resolved) };
  };
  const resolveDeleteWithoutDeleting = (stmt: Statement & { with?: WithBinding[] }, extraWith: WithBinding[]): ObjectSet => {
    const previousDeferredDeletes = deferredChainDeletes;
    deferredChainDeletes = [];
    try {
      return runNestedObjectSet(stmt, extraWith);
    } finally {
      deferredChainDeletes = previousDeferredDeletes;
    }
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const n = node as Record<string, unknown> & { kind?: string; statement?: Statement };
    // `(WITH y := …, INSERT …)` — the subquery's WITH bindings live on its
    // clauses, not the wrapped statement; merge them on before executing.
    if (n.kind === "select_expr_subquery") {
      const innerBindings = (n.clauses as { _withBindings?: WithBinding[] } | undefined)?._withBindings ?? [];
      const innerExpr = n.expr as { kind?: string; statement?: Statement } | undefined;
      if (innerExpr?.kind === "mutation_expr" && innerExpr.statement) {
        return runNested(innerExpr.statement as Statement & { with?: WithBinding[] }, innerBindings);
      }
    }
    if (n.kind === "mutation_expr" && n.statement) {
      return runNested(n.statement as Statement & { with?: WithBinding[] }, []);
    }
    // A shape projection over a mutation (`x := (INSERT X {…}){ @a := 2 }`)
    // assigns link properties — the native link-assignment machinery handles
    // the nested insert itself, so leave the subtree untouched.
    if (n.kind === "shape_projection") {
      return n;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) out[key] = walk(value);
    return out;
  };
  // A whole-value mutation (`note := (WITH … INSERT Note {…})`) replaces the
  // assignment with a plain by-id select so the link machinery resolves it
  // natively; mutations nested deeper in an expression substitute in place.
  // `link := (FOR v IN {…} UNION (INSERT T {…}))` — a FOR-INSERT as a link
  // value. Expand to concrete per-iteration INSERTs, run them, and replace the
  // value with a by-id SELECT over the inserted ids so the link assignment
  // lowers natively. Accepts the bare `for` statement and the
  // `for_expr`-wrapped forms a select/expr may carry.
  const runForInsertValue = (node: unknown): unknown | undefined => {
    let forStmt: ForStatement | undefined;
    const n = node as { kind?: string; expr?: unknown };
    if (n?.kind === "for") {
      forStmt = node as ForStatement;
    } else {
      let inner = (n?.kind === "expr" ? n.expr : node) as { kind?: string; expr?: unknown } | undefined;
      if (inner?.kind === "select_expr_subquery") inner = inner.expr as { kind?: string };
      if (inner?.kind === "for_expr") {
        const f = forExprChainToForStatement(inner as never, ast.pos);
        if (f) forStmt = f;
      }
    }
    if (!forStmt) return undefined;
    const withForOuter = { ...forStmt, with: [...outerWith, ...((forStmt as { with?: WithBinding[] }).with ?? [])] } as ForStatement;
    const inserts = expandForInsertStatements(withForOuter, schema, db, context, []);
    if (inserts === undefined) return undefined;
    const ids: string[] = [];
    let typeName = "";
    // Per-iteration `@prop := …` assignments inside a FOR-INSERT link value
    // (`subordinates := (FOR x IN {…} INSERT Subordinate { @comment := x.1 })`)
    // belong to the enclosing link. After expansion the `@`-fields carry a
    // concrete value for each iteration; hoist them out (so the inner insert
    // compiles against the target type only) and pair each with the inserted
    // id so the by-id selects re-attach them as link properties.
    const perTargetLinkProps: Array<{ id: string; props: Record<string, ScalarValue> }> = [];
    let anyLinkProps = false;
    for (const ins of inserts) {
      const insVals = (ins as { values?: Record<string, unknown> }).values;
      const hoisted: Record<string, ScalarValue> = {};
      if (insVals) {
        for (const key of Object.keys(insVals)) {
          if (!key.startsWith("@")) continue;
          const raw = insVals[key];
          const body = (raw !== null && typeof raw === "object" && (raw as { kind?: string }).kind === "expr")
            ? (raw as { expr: unknown }).expr
            : raw;
          const lit = (body !== null && typeof body === "object" && (body as { kind?: string }).kind === "literal")
            ? (body as { value: unknown }).value
            : body;
          const scalar = coerceUnknownToScalar(lit);
          if (scalar !== undefined) {
            hoisted[key] = scalar;
            anyLinkProps = true;
          }
          delete insVals[key];
        }
      }
      const resolved = executeDmlChainStatement(db, schema, ins as Statement, env, undefined, context, defaultModule);
      if (resolved.typeName) typeName = resolved.typeName;
      ids.push(...resolved.ids);
      for (const id of resolved.ids) perTargetLinkProps.push({ id, props: hoisted });
    }
    if (!anyLinkProps) {
      return chainByIdSelect({ typeName, ids });
    }
    // Build a set of per-target by-id selects, each carrying its captured
    // link-property literals as `@`-shape computeds. The `kind: "select"`
    // resolution path reads those `@`-columns off the rows — the same path
    // that handles `subordinates := (SELECT Sub { @comment := … })`.
    return {
      kind: "set",
      values: perTargetLinkProps.map(({ id, props }) => ({
        kind: "select",
        typeName,
        shape: Object.entries(props).map(([name, value]) => ({
          kind: "computed",
          name,
          expr: { kind: "literal", value },
          operation: "assign",
          origin: "explicit",
        })),
        clauses: {
          filter: {
            kind: "in_predicate",
            target: { kind: "field", field: "id" },
            op: "in",
            values: { kind: "set_literal", values: [id] },
          },
        },
      })),
    };
  };

  const qualifiedSubject = ast.kind === "insert" || ast.kind === "update"
    ? qualifyRuntimeTypeName(ast.typeName, defaultModule)
    : "";
  const subjectType = qualifiedSubject ? schema.getType(qualifiedSubject) ?? schema.getType((ast as { typeName?: string }).typeName ?? "") : undefined;
  const linkNames = new Set((subjectType?.links ?? []).map((link) => link.name));

  const rewriteValue = (field: string, value: unknown): unknown => {
    const forReplaced = runForInsertValue(value);
    if (forReplaced !== undefined) return forReplaced;
    if (value !== null && typeof value === "object" && (value as { kind?: string }).kind === "expr") {
      let inner = (value as { expr?: unknown }).expr as (Record<string, unknown> & { kind?: string }) | undefined;
      let innerBindings: WithBinding[] = [];
      if (inner?.kind === "select_expr_subquery") {
        innerBindings = (inner.clauses as { _withBindings?: WithBinding[] } | undefined)?._withBindings ?? [];
        inner = inner.expr as Record<string, unknown> & { kind?: string };
      }
      if (inner?.kind === "mutation_expr" && inner.statement) {
        const innerStmt = inner.statement as Statement & { with?: WithBinding[]; values?: Record<string, unknown> };
        if (innerStmt.kind === "delete" && linkNames.has(field)) {
          const resolved = resolveDeleteWithoutDeleting(innerStmt, innerBindings);
          if (resolved.ids.length > 0) {
            throw new AppError(
              "E_SEMANTIC",
              `deletion of ${resolved.typeName} object is prohibited by link target policy`,
              ast.pos.line,
              ast.pos.column,
            );
          }
          return chainByIdSelect(resolved);
        }
        // Hoist `@prop` link-property assignments out of the nested insert so
        // the inner INSERT compiles against only the target type's own fields;
        // re-attach them as a shape projection over the by-id select so the
        // link-assignment path applies them as link properties.
        const linkPropElements = innerStmt.kind === "insert" ? extractLinkPropShapeElements(innerStmt) : undefined;
        const replaced = runNested(innerStmt, innerBindings) as { expr: Record<string, unknown> & { shape?: ShapeElement[] } };
        if (linkPropElements) {
          const sel = replaced.expr;
          replaced.expr = { ...sel, shape: [...(sel.shape ?? []), ...linkPropElements] };
        }
        return replaced.expr;
      }
    }
    return walk(value);
  };
  const newValues: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    newValues[field] = rewriteValue(field, value);
  }
  return {
    ...ast,
    values: newValues,
    ...(withChanged ? { with: outerWith } : null),
  } as Statement;
};

// EdgeQL forbids mutations (INSERT/UPDATE/DELETE) inside a shape's computed
// expression, and inside a free-object constructor that isn't the trivial,
// top-level, exposed result. Such a mutation must be factored into a top-level
// WITH binding. The pre-execution passes below would otherwise *silently run*
// such mutations (via the generic by-id-select substitution), so we reject them
// here first. We only flag mutations written inline as `mutation_expr` — nested
// DML in INSERT/UPDATE *value* shapes uses the distinct `InsertValue` AST and is
// legitimate, so it is never reached by this walk.
const exprTreeContainsInlineMutation = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(exprTreeContainsInlineMutation);
  if (node === null || typeof node !== "object") return false;
  if ((node as { kind?: unknown }).kind === "mutation_expr") return true;
  return Object.values(node as Record<string, unknown>).some(exprTreeContainsInlineMutation);
};

const validateNoMutationInShapeComputeds = (node: unknown, inTopLevelExposedFreeObject: boolean): void => {
  if (Array.isArray(node)) {
    for (const item of node) validateNoMutationInShapeComputeds(item, false);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const n = node as Record<string, unknown> & { kind?: string };

  // A shape applied to any expression: DML in a computed (`c := (INSERT …)`)
  // element is rejected. Link-property computeds (`@x`) keep the same rule.
  if (n.kind === "shape_projection" && Array.isArray((n as { shape?: unknown }).shape)) {
    const shape = (n as { shape: Array<Record<string, unknown>> }).shape;
    for (const el of shape) {
      if (el && el.kind === "computed" && exprTreeContainsInlineMutation(el.expr)) {
        throw new AppError(
          "E_SEMANTIC",
          "mutations are invalid in a shape's computed expression",
          1, 1,
        );
      }
    }
  }

  // A free-object *constructor* (expression form, e.g. bound in WITH or nested)
  // is not the trivial top-level exposed free object, so inline DML in its
  // entries is rejected.
  if (n.kind === "free_object_constructor" && Array.isArray((n as { entries?: unknown }).entries)) {
    if (!inTopLevelExposedFreeObject) {
      const entries = (n as { entries: Array<Record<string, unknown>> }).entries;
      for (const entry of entries) {
        if (entry && exprTreeContainsInlineMutation(entry.expr)) {
          throw new AppError(
            "E_SEMANTIC",
            "mutations are invalid in a shape's computed expression",
            1, 1,
          );
        }
      }
    }
  }

  for (const value of Object.values(n)) {
    validateNoMutationInShapeComputeds(value, false);
  }
};

// Entry point: a `select { … }` whose entries are the exposed top-level result
// allows trivial inline DML (handled by the dedicated free-object path), so its
// entries are NOT treated as a forbidden free-object constructor. Any other
// statement validates from the top with no exposed-free-object allowance.
const validateMutationPlacement = (ast: Statement): void => {
  if (ast.kind === "select_free") {
    // Top-level exposed free object: entry-level inline DML is allowed, but a
    // *shape* nested deeper inside an entry still rejects DML in its computed.
    for (const entry of (ast as unknown as { entries: Array<{ expr: unknown }> }).entries) {
      validateNoMutationInShapeComputeds(entry.expr, false);
    }
    return;
  }
  validateNoMutationInShapeComputeds(ast, false);
};

// SELECT statements (incl. free-object selects) whose WITH bindings or
// free-object entries contain DML: execute the mutations up front (in
// declaration order, honoring upsert-by-coalesce), then rewrite each executed
// binding/entry to a by-id SELECT so the remaining statement lowers to SQL
// like any other read.
const preExecuteDmlBindings = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  context: SecurityContext,
): Statement => {
  if (ast.kind !== "select" && ast.kind !== "select_expr" && ast.kind !== "select_free" && ast.kind !== "for") return ast;
  const withBindings = (ast as { with?: WithBinding[] }).with ?? [];
  const entries = ast.kind === "select_free"
    ? ((ast as unknown as { entries?: Array<{ name: string; expr: FreeObjectExpr }> }).entries ?? [])
    : [];
  const entryHasMutation = (expr: FreeObjectExpr): boolean =>
    bindingValueContainsMutation({ kind: "subquery_expr", expr } as WithBindingValue);
  const hasDmlBinding = withBindings.some((binding) => bindingValueContainsMutation(binding.value));
  const hasDmlEntry = entries.some((entry) => entryHasMutation(entry.expr));
  if (!hasDmlBinding && !hasDmlEntry) return ast;

  const defaultModule = (ast as { withModule?: string }).withModule ?? "default";
  // Single-snapshot exclusivity: when two or more DML statements run in one
  // query (via WITH bindings or free-object entries), a value freed by one and
  // re-used by a sibling is a conflict (cross_type_conflict_07a/07b/08a/12,
  // and_delete_01). Snapshot the exclusive values before any of them run.
  const dmlBindingCount = withBindings.filter((b) => bindingValueContainsMutation(b.value)).length
    + entries.filter((e) => entryHasMutation(e.expr)).length;
  const chainTypeNames = dmlBindingCount >= 2 ? collectChainTypeNames(ast, defaultModule) : undefined;
  const exclusiveSnapshot = chainTypeNames ? captureExclusiveSnapshot(db, schema, chainTypeNames) : undefined;
  const env: DmlChainEnv = new Map();
  const newWith: WithBinding[] = [];
  const passthrough: WithBinding[] = [];
  for (const binding of withBindings) {
    if (!bindingValueContainsMutation(binding.value)) {
      newWith.push(binding);
      passthrough.push(binding);
      continue;
    }
    // DML nested inside a tuple element keeps the surrounding tuple/set shape:
    // substitute each mutation leaf with a by-id SELECT and re-bind the value
    // as a plain subquery so the rest lowers to SQL.
    if (binding.value.kind === "subquery_expr"
        && mutationNestedInTuple((binding.value as { expr?: unknown }).expr)) {
      const newExpr = substituteMutationLeaves(
        db, schema,
        (binding.value as { expr: unknown }).expr,
        env, context, defaultModule, passthrough,
      );
      newWith.push({ name: binding.name, value: { kind: "subquery_expr", expr: newExpr } } as WithBinding);
      passthrough.push(binding);
      continue;
    }
    const resolved = resolveObjectSet(
      db,
      schema,
      attachWithToNestedMutations(binding.value, passthrough),
      env,
      undefined,
      context,
      defaultModule,
    );
    env.set(binding.name, resolved);
    // An empty result with no resolved type (`t := (if false then (DELETE …)
    // else <T>{})` — the taken empty branch contributes no type) can't form a
    // by-id SELECT (it would emit an unnamed table). Bind it to an empty set so
    // the outer `t.a` / `t` projects nothing.
    if (resolved.typeName === "" && resolved.ids.length === 0) {
      newWith.push({ name: binding.name, value: { kind: "subquery_expr", expr: { kind: "set_literal", values: [] } } } as unknown as WithBinding);
      continue;
    }
    const select = chainByIdSelect(resolved) as { typeName: string; shape: ShapeElement[]; clauses: unknown };
    // A FOR statement iterating over this binding needs the value to keep its
    // object typing (so the loop variable binds as an object, not a bare id).
    // The `subquery_expr → select_expr_subquery → select` form preserves it,
    // mirroring a plain `noobs := (select T)` binding; other statements keep
    // the lighter `{kind:"subquery"}` form they already rely on.
    const bindingValue = ast.kind === "for"
      ? { kind: "subquery_expr", expr: { kind: "select_expr_subquery", expr: chainByIdSelect(resolved) } }
      : { kind: "subquery", query: { typeName: select.typeName, shape: select.shape, clauses: select.clauses } };
    newWith.push({ name: binding.name, value: bindingValue } as WithBinding);
  }

  const rewriteEntryExpr = (expr: FreeObjectExpr): FreeObjectExpr => {
    if (entryHasMutation(expr)) {
      // `obj := (INSERT T {…}) { name, l2 }` — a shape over the mutation.
      // Resolve the mutation, then re-project the inserted rows through the
      // requested shape (instead of an id-only select).
      const projShape = (expr as { kind?: string; shape?: ShapeElement[] }).kind === "shape_projection"
        ? (expr as { shape?: ShapeElement[] }).shape
        : undefined;
      const resolved = resolveObjectSet(
        db,
        schema,
        attachWithToNestedMutations({ kind: "subquery_expr", expr } as WithBindingValue, passthrough),
        env,
        undefined,
        context,
        defaultModule,
      );
      const byId = chainByIdSelect(resolved) as { typeName: string; shape: ShapeElement[]; clauses: unknown };
      if (projShape && projShape.length > 0) {
        byId.shape = projShape;
      }
      return { kind: "select_expr_subquery", expr: byId } as unknown as FreeObjectExpr;
    }
    return rewriteEnvRefsInNode(expr, env) as FreeObjectExpr;
  };

  // For a plain SELECT whose body references a DML-bound singleton
  // (`WITH I := (INSERT …) SELECT T FILTER T.num > I.l2`), the binding's value
  // can't be threaded as a WITH subquery into the filter — the SQL compiler
  // mis-resolves `I.l2` against the outer extent. Rewrite those references to
  // field accesses over the inserted object's by-id select and drop the
  // (now-unused) DML bindings from the WITH so the SELECT lowers cleanly.
  if (ast.kind === "select" || ast.kind === "select_expr") {
    // Only bindings resolved into `env` (a whole-statement DML binding, e.g.
    // `I := (INSERT …)`) can be rewritten to literals here. DML nested inside a
    // tuple/set binding (`noobs := {((insert …), "bar")}`) is kept as a
    // rewritten subquery binding by the loop above and must NOT be dropped.
    const dmlBoundNames = new Set(
      withBindings
        .filter((b) => bindingValueContainsMutation(b.value))
        .map((b) => b.name)
        .filter((name) => {
          const bound = env.get(name);
          return bound !== undefined && bound.typeName !== "";
        }),
    );
    if (dmlBoundNames.size > 0) {
      // Read a scalar property off a DML-bound singleton (`I.l2`) from its
      // table so the SELECT body can compare against the concrete inserted
      // value. EdgeQL materializes the WITH binding, so the singleton's value
      // is fixed for the whole statement — emitting a literal is faithful.
      const boundFieldScalar = (root: unknown, field: string): { ok: boolean; value: ScalarValue | null } | undefined => {
        if (typeof root !== "string") return undefined;
        const bound = env.get(root);
        if (!bound || bound.typeName === "" || bound.ids.length !== 1) return undefined;
        try {
          const rows = db.prepare(
            `SELECT ${quoteIdent(field)} AS v FROM ${quoteIdent(tableNameForType(bound.typeName))} WHERE ${quoteIdent("id")} = ?`,
          ).all(bound.ids[0]) as Array<{ v?: unknown }>;
          if (rows.length !== 1) return undefined;
          const v = rows[0].v;
          if (v === null || v === undefined) return { ok: true, value: null };
          return { ok: true, value: v as ScalarValue };
        } catch {
          return undefined;
        }
      };
      // Resolve a node that references a DML-bound singleton's scalar field
      // (`field_ref{root,field}` or `path` head). Returns the captured scalar
      // (or null) when it resolves, otherwise undefined.
      const resolveBoundRef = (nn: Record<string, unknown> & { kind?: string }): { value: ScalarValue | null } | undefined => {
        if (nn.kind === "field_ref" && typeof nn.field === "string" && dmlBoundNames.has(nn.root as string)) {
          const r = boundFieldScalar(nn.root, nn.field as string);
          if (r) return { value: r.value };
        }
        if (nn.kind === "path" && dmlBoundNames.has(nn.head as string)) {
          const steps = (nn.steps as Array<{ kind?: string; name?: string }> | undefined) ?? [];
          const ptrSteps = steps.filter((s) => s.kind === "ptr" && typeof s.name === "string");
          const field = ptrSteps.length === 1 ? ptrSteps[0].name : (typeof nn.tail === "string" ? nn.tail : undefined);
          if (field) {
            const r = boundFieldScalar(nn.head, field as string);
            if (r) return { value: r.value };
          }
        }
        return undefined;
      };
      // `inExpr` distinguishes general expression contexts (which want a
      // `{kind:"literal"}` node) from predicate `value` positions (which store
      // the raw scalar directly).
      const rewriteBody = (node: unknown, asExpr = true): unknown => {
        if (Array.isArray(node)) return node.map((item) => rewriteBody(item, asExpr));
        if (node === null || typeof node !== "object") return node;
        const nn = node as Record<string, unknown> & { kind?: string };
        const resolved = resolveBoundRef(nn);
        if (resolved) {
          return asExpr ? { kind: "literal", value: resolved.value } : resolved.value;
        }
        // A predicate's `value`/`values` positions store raw scalars, not
        // expression nodes — rewrite a bound-ref there to the raw scalar.
        if (nn.kind === "predicate" || nn.kind === "in_predicate") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(nn)) {
            out[k] = (k === "value" || k === "values") ? rewriteBody(v, false) : rewriteBody(v, true);
          }
          return out;
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(nn)) out[k] = rewriteBody(v, asExpr);
        return out;
      };
      // Only the scalar-comparison clauses (FILTER / ORDER BY / pagination) hit
      // the mis-resolution bug, and only those need the captured literal. Shape
      // and body expressions keep referencing the (retained) WITH binding so
      // their object cardinality / projection stay intact.
      const sel = ast as unknown as Record<string, unknown>;
      const rewrittenFields: Record<string, unknown> = {};
      let touched = false;
      for (const key of ["filter", "orderBy", "limit", "offset"]) {
        if (sel[key] !== undefined) {
          const rewritten = rewriteBody(sel[key]);
          rewrittenFields[key] = rewritten;
          if (JSON.stringify(rewritten) !== JSON.stringify(sel[key])) touched = true;
        }
      }
      // A select_expr body that references a DML-bound object (`SELECT (select
      // I)`, `SELECT {I}`) — rewrite those references to the inserted object's
      // by-id select so the projection keeps its id/shape. Shape computeds are
      // left to the retained WITH binding (preserving singleton cardinality).
      if (ast.kind === "select_expr" && sel.expr !== undefined) {
        const rewrittenExpr = rewriteEnvRefsInNode(sel.expr, env);
        if (JSON.stringify(rewrittenExpr) !== JSON.stringify(sel.expr)) {
          rewrittenFields.expr = rewrittenExpr;
          touched = true;
        }
      }
      if (touched) {
        // The chain's DML has all executed by this point; run the single-
        // snapshot exclusivity validation before returning the rewritten SELECT
        // (the multi-property cross-type conflict in 07b is only caught here —
        // there is no materialised unique index to trip during the INSERT).
        if (exclusiveSnapshot && chainTypeNames) {
          validateExclusiveSnapshot(db, schema, chainTypeNames, exclusiveSnapshot, ast.pos);
        }
        return { ...ast, ...rewrittenFields, with: newWith.length > 0 ? newWith : undefined } as Statement;
      }
    }
  }

  const out = { ...ast, with: newWith.length > 0 ? newWith : undefined } as Statement;
  if (ast.kind === "select_free") {
    (out as unknown as { entries: Array<{ name: string; expr: FreeObjectExpr }> }).entries =
      entries.map((entry) => ({ ...entry, expr: rewriteEntryExpr(entry.expr) }));
  }
  // A FOR statement's body carries a copy of the enclosing WITH bindings (the
  // parser scopes them into the body). The DML in those bindings was already
  // executed once above — replace the body's same-named bindings with the
  // rewritten by-id versions so the mutation doesn't re-run and the body
  // lowers to plain SQL.
  if (ast.kind === "for") {
    const body = (ast as ForStatement).body as { with?: WithBinding[] } | undefined;
    const bodyWith = body?.with;
    if (bodyWith && bodyWith.some((b) => withBindings.some((o) => o.name === b.name && bindingValueContainsMutation(o.value)))) {
      const rewrittenByName = new Map(newWith.map((b) => [b.name, b]));
      const newBodyWith = bodyWith.map((b) => rewrittenByName.get(b.name) ?? b);
      (out as ForStatement).body = { ...(body as object), with: newBodyWith } as ForStatement["body"];
    }
  }
  if (exclusiveSnapshot && chainTypeNames) {
    validateExclusiveSnapshot(db, schema, chainTypeNames, exclusiveSnapshot, ast.pos);
  }
  return out;
};

// `SELECT (INSERT …).num`, `SELECT ((INSERT …).num, …)`, etc. — a DML
// statement embedded inside the body expression of a top-level SELECT (not as
// a WITH binding and not as the direct `(DML){shape}` source, which the
// dedicated handler below covers). Execute each embedded mutation once and
// substitute a by-id SELECT, so the remaining expression lowers to plain SQL.
// A no-op when no embedded mutation is present.
const preExecuteMutationExprsInSelectExpr = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  context: SecurityContext,
): Statement => {
  if (ast.kind !== "select_expr" && ast.kind !== "select") return ast;
  const expr = (ast as { expr?: unknown }).expr;
  if (!expr || typeof expr !== "object") return ast;
  // `(DML){shape}` and bare `(DML)` are handled by executeSelectOverMutation /
  // the WITH-DML chain — leave those for the dedicated paths.
  const exprKind = (expr as { kind?: string }).kind;
  if (exprKind === "shape_projection"
      && (expr as { expr?: { kind?: string } }).expr?.kind === "mutation_expr") {
    return ast;
  }
  if (exprKind === "mutation_expr") return ast;

  const containsMutationExpr = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(containsMutationExpr);
    if (node === null || typeof node !== "object") return false;
    if ((node as { kind?: unknown }).kind === "mutation_expr") return true;
    return Object.values(node).some(containsMutationExpr);
  };
  if (!containsMutationExpr(expr)) return ast;

  const defaultModule = (ast as { withModule?: string }).withModule ?? "default";
  const env: DmlChainEnv = new Map();
  const passthrough: WithBinding[] = (ast as { with?: WithBinding[] }).with ?? [];
  // Upsert-by-coalesce: `SELECT (SELECT …) ?? (INSERT …)`. The `??` is
  // short-circuiting — the right INSERT only runs when the left is empty — so
  // it can't be walked leaf-by-leaf (that would always insert). Resolve the
  // whole coalesce as an object set (resolveObjectSet honors the short-circuit)
  // and replace the entire expression with a by-id SELECT. Also covers a shape
  // projected over the coalesce (`(… ?? (INSERT …)) { … }`).
  const coalesceNode = exprKind === "shape_projection" ? (expr as { expr?: unknown }).expr : expr;
  // Scalar coalesce (`(insert …).a ?? 99`, `99 ?? (insert …).a`): the result is
  // a scalar (not an object set), and `??` short-circuits — the right side (and
  // any DML it carries) runs only when the left side is empty. The object-set
  // coalesce path below would mis-handle the `.a` projection / scalar literal,
  // so detect the scalar shape here and honor the short-circuit explicitly.
  if (coalesceNode && typeof coalesceNode === "object"
      && (coalesceNode as { kind?: string }).kind === "coalesce"
      && containsMutationExpr(coalesceNode)
      && exprKind !== "shape_projection") {
    const cn = coalesceNode as { left?: unknown; right?: unknown };
    const peelCo = (node: unknown): unknown => {
      const x = node as { kind?: string; expr?: unknown } | undefined;
      if (x && (x.kind === "expr" || x.kind === "subquery_expr" || x.kind === "distinct")) return peelCo(x.expr);
      return node;
    };
    const isScalarShape = (node: unknown): boolean => {
      const x = peelCo(node) as { kind?: string } | undefined;
      return !!x && (x.kind === "field_access" || x.kind === "literal" || x.kind === "op"
        || x.kind === "binary_op" || x.kind === "unary_op");
    };
    if (isScalarShape(cn.left) || isScalarShape(cn.right)) {
      const pos = (ast as { pos?: { line: number; column: number } }).pos ?? { line: 0, column: 0 };
      const leftHasDml = containsMutationExpr(cn.left);
      if (leftHasDml) {
        // Left runs unconditionally (it's the left operand). Execute its DML via
        // walk; the result is non-empty (the insert yields a value), so it wins
        // and the right side never runs.
        const leftExpr = walk(cn.left);
        const leftRows = evaluateConditionRowsViaSQL(db, schema, leftExpr as FreeObjectExpr, passthrough, context, pos);
        if (leftRows.length > 0) return { ...ast, expr: leftExpr } as Statement;
        // Left turned out empty: now the right side (with its DML) runs.
        return { ...ast, expr: walk(cn.right) } as Statement;
      }
      // Only the right side carries DML. Evaluate the (DML-free) left's
      // cardinality; if non-empty the right never runs (its DML is skipped).
      const leftRows = evaluateConditionRowsViaSQL(db, schema, cn.left as FreeObjectExpr, passthrough, context, pos);
      if (leftRows.length > 0) return { ...ast, expr: cn.left } as Statement;
      return { ...ast, expr: walk(cn.right) } as Statement;
    }
  }
  // Coalesce of two tuples (`(<select>, true) ?? (<insert>, false)`): the `??`
  // short-circuits on the WHOLE left tuple — non-empty when its object element
  // is non-empty. Evaluate the left object element; if present, the result is
  // the left tuple (nothing on the right runs). Otherwise run the right tuple
  // (executing its mutation). Each object element becomes a by-id select and
  // each scalar element keeps its literal, so the tuple lowers to plain SQL.
  if (coalesceNode && typeof coalesceNode === "object"
      && (coalesceNode as { kind?: string }).kind === "coalesce"
      && containsMutationExpr(coalesceNode)
      && exprKind !== "shape_projection") {
    const cn = coalesceNode as { left?: unknown; right?: unknown };
    const asTuple = (node: unknown): unknown[] | undefined => {
      const t = node as { kind?: string; values?: unknown[] } | undefined;
      return t?.kind === "tuple" && Array.isArray(t.values) ? t.values : undefined;
    };
    const leftTuple = asTuple(cn.left);
    const rightTuple = asTuple(cn.right);
    if (leftTuple && rightTuple && leftTuple.length === rightTuple.length) {
      // The object element is the one that resolves to an object set; scalars
      // (literals) pass through. Build the result tuple element-by-element.
      const peel = (node: unknown): unknown => {
        const n = node as { kind?: string; expr?: unknown } | undefined;
        return n?.kind === "expr" ? n.expr : node;
      };
      const isObjectElement = (node: unknown): boolean => {
        const n = peel(node) as { kind?: string } | undefined;
        return n?.kind === "select_expr_subquery" || n?.kind === "select"
          || n?.kind === "mutation_expr" || n?.kind === "binding_ref";
      };
      // Resolve the left tuple's object element to decide the branch.
      const leftObjIdx = leftTuple.findIndex(isObjectElement);
      if (leftObjIdx >= 0) {
        const leftObj = resolveObjectSet(
          db, schema, attachWithToNestedMutations(peel(leftTuple[leftObjIdx]), passthrough),
          env, undefined, context, defaultModule,
        );
        const chosen = leftObj.ids.length > 0 ? leftTuple : rightTuple;
        const resultElements = chosen.map((el) => {
          if (isObjectElement(el)) {
            const resolved = (chosen === leftTuple && chosen.indexOf(el) === leftObjIdx)
              ? leftObj
              : resolveObjectSet(db, schema, attachWithToNestedMutations(peel(el), passthrough), env, undefined, context, defaultModule);
            return { kind: "select_expr_subquery", expr: chainByIdSelect(resolved) };
          }
          return peel(el);
        });
        return { ...ast, expr: { kind: "tuple", values: resultElements } } as Statement;
      }
    }
  }
  if (coalesceNode && typeof coalesceNode === "object"
      && (coalesceNode as { kind?: string }).kind === "coalesce"
      && containsMutationExpr(coalesceNode)
      && exprKind !== "shape_projection"
      && coalesceIsScalar(coalesceNode)) {
    const cn = coalesceNode as { left?: unknown; right?: unknown };
    const pos = (ast as { pos?: { line: number; column: number } }).pos ?? { line: 0, column: 0 };
    // Scalar `??` whose operand is `(DELETE …).a` (a scalar set, not an object
    // set): `??` short-circuits on the left's emptiness, which resolveObjectSet
    // can't model. Walk the left (running any embedded delete, substituting its
    // captured values), then evaluate it: if non-empty, use those values and
    // leave the right unevaluated; otherwise walk + use the right. This keeps
    // the right's DML from running when the left is non-empty.
    const leftExpr = containsMutationExpr(cn.left) ? walk(cn.left) : cn.left;
    const leftRows = evaluateConditionRowsViaSQL(
      db, schema, { ...ast, expr: leftExpr } as unknown as FreeObjectExpr, passthrough, context, pos,
    );
    if (leftRows.length > 0) {
      return { ...ast, expr: { kind: "set_literal", values: leftRows } } as Statement;
    }
    return { ...ast, expr: walk(cn.right) } as Statement;
  }
  if (coalesceNode && typeof coalesceNode === "object"
      && (coalesceNode as { kind?: string }).kind === "coalesce"
      && containsMutationExpr(coalesceNode)) {
    const resolved = resolveObjectSet(
      db,
      schema,
      attachWithToNestedMutations(coalesceNode, passthrough),
      env,
      undefined,
      context,
      defaultModule,
    );
    const byId = { kind: "select_expr_subquery", expr: chainByIdSelect(resolved) };
    if (exprKind === "shape_projection") {
      return { ...ast, expr: { ...(expr as object), expr: byId } } as Statement;
    }
    return { ...ast, expr: byId } as Statement;
  }
  // Declared as a hoisted function so the scalar-coalesce/if_else short-circuit
  // handlers above (which run before this point textually) can call it.
  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const n = node as Record<string, unknown> & { kind?: string; statement?: Statement };
    // `FOR v IN {…} UNION (INSERT/UPDATE/DELETE …)` — resolve the whole loop as
    // an object set (resolveObjectSet's for_expr case binds `v` per iteration)
    // rather than descending into the inner mutation, which would run it once
    // with `v` unbound (tests _06, _17, _20b, self_01).
    if (n.kind === "for_expr" && containsMutationExpr(n)) {
      // Scalar-bodied loop (`FOR z IN {0,1} UNION ((DELETE …).a)`): the body
      // yields scalars, which resolveObjectSet (object-set only) can't collapse.
      // Run each iteration's body through `walk` (executing its delete once per
      // iteration, in order, and substituting the captured `.a` values) and
      // union the per-iteration scalar rows into one literal set.
      const forBody = (n as { body?: unknown }).body;
      if (forBody && !exprIsObjectValued(forBody)) {
        const iterator = (n as { iterator?: { kind?: string; values?: unknown[] } }).iterator;
        const variable = (n as { variable?: string }).variable;
        const pos = (ast as { pos?: { line: number; column: number } }).pos ?? { line: 0, column: 0 };
        let iterValues: unknown[];
        if (iterator?.kind === "set_literal") {
          iterValues = iterator.values ?? [];
        } else {
          iterValues = evaluateConditionRowsViaSQL(db, schema, iterator as FreeObjectExpr, passthrough, context, pos);
        }
        const allRows: unknown[] = [];
        for (const iterValue of iterValues) {
          const boundBody = variable && (iterValue === null || isScalarValue(iterValue))
            ? bindLoopVarInForBody(forBody, variable, iterValue as ScalarValue)
            : forBody;
          const rows = evaluateConditionRowsViaSQL(
            db, schema, { ...ast, expr: walk(boundBody) } as unknown as FreeObjectExpr, passthrough, context, pos,
          );
          allRows.push(...rows);
          // A FOR loop sees each prior iteration's deletes: flush the deferred
          // removals now (the rows this iteration projected are already read)
          // so a later iteration's `.a <= x` filter no longer matches them.
          if (deferredChainDeletes !== null && deferredChainDeletes.length > 0) {
            const queued = deferredChainDeletes;
            deferredChainDeletes = [];
            for (const run of queued) run();
          }
        }
        return { kind: "set_literal", values: allRows };
      }
      // Object-valued loop: resolveObjectSet's for_expr case evaluates the
      // iterator (`{x, x+1, x+2}`) with no bindings in scope, so an outer-FOR
      // loop variable bound as a scalar-literal WITH binding (from
      // executeForWithDmlBodyExpr) would be unresolved. Substitute those literal
      // bindings into the for node first so the iterator resolves the loop value.
      let forNode: unknown = n;
      for (const b of passthrough) {
        const bv = b.value as { kind?: string; value?: ScalarValue };
        if (bv.kind === "literal" && (bv.value === null || isScalarValue(bv.value))) {
          forNode = bindLoopVarInForBody(forNode, b.name, bv.value as ScalarValue);
        }
      }
      const resolved = resolveObjectSet(
        db,
        schema,
        attachWithToNestedMutations(forNode, passthrough),
        env,
        undefined,
        context,
        defaultModule,
      );
      return { kind: "select_expr_subquery", expr: chainByIdSelect(resolved) };
    }
    // `if <cond> then (INSERT …) else (INSERT …)` — the branches are mutually
    // exclusive per condition element, so only the taken branch's DML may run.
    // Walking leaf-by-leaf would execute BOTH inserts. EdgeQL evaluates `if`
    // element-wise over the condition set: each condition element emits the
    // then-branch (true) or else-branch (false), so a multi-element condition
    // (`array_unpack(<array<bool>>$0)`) runs each branch once per matching
    // element. An empty condition set yields no rows.
    if (n.kind === "if_else" && containsMutationExpr(n)) {
      const pos = (ast as { pos?: { line: number; column: number } }).pos ?? { line: 0, column: 0 };
      const condRows = evaluateConditionRowsViaSQL(db, schema, n.condition as FreeObjectExpr, passthrough, context, pos);
      // Scalar-result conditional (`if <cond> then (DELETE/INSERT …).a else 99`):
      // the branches yield scalars, not object sets, so resolveObjectSet can't
      // collapse them. Walk only the taken branch per condition element (the
      // recursive walk runs that branch's embedded DML and substitutes the
      // captured values); the non-taken branch — and its DML — is skipped.
      const thenIsObject = n.thenExpr ? exprIsObjectValued(n.thenExpr) : false;
      const elseIsObject = n.elseExpr ? exprIsObjectValued(n.elseExpr) : false;
      if (!thenIsObject && !elseIsObject) {
        const parts: unknown[] = [];
        for (const condRow of condRows) {
          const taken = condRow === true || condRow === 1 ? n.thenExpr : n.elseExpr;
          if (!taken) continue;
          parts.push(walk(taken));
        }
        if (parts.length === 0) return { kind: "set_literal", values: [] };
        return parts.length === 1 ? parts[0] : { kind: "set_expr", values: parts };
      }
      const branchIds: string[] = [];
      const branchTypes: string[] = [];
      for (const condRow of condRows) {
        const taken = condRow === true || condRow === 1 ? n.thenExpr : n.elseExpr;
        if (!taken) continue;
        const resolved = resolveObjectSet(
          db,
          schema,
          attachWithToNestedMutations(taken, passthrough),
          env,
          undefined,
          context,
          defaultModule,
        );
        if (resolved.typeName) branchTypes.push(resolved.typeName);
        branchIds.push(...resolved.ids);
      }
      // A branch that produced no objects (`else {}`, an all-false condition)
      // contributes nothing — the whole conditional is the empty set.
      if (branchIds.length === 0) return { kind: "set_literal", values: [] };
      // The two branches may produce different (related) types — e.g.
      // `then InsertTest else DerivedTest`. The result set's type is their
      // common ancestor, so the by-id read sees every inserted object.
      return { kind: "select_expr_subquery", expr: chainByIdSelect({ typeName: commonAncestorType(schema, branchTypes), ids: branchIds }) };
    }
    if (n.kind === "mutation_expr" && n.statement) {
      const mutationKind = (n.statement as { kind?: string }).kind;
      const resolved = resolveObjectSet(
        db,
        schema,
        attachWithToNestedMutations(n, passthrough),
        env,
        undefined,
        context,
        defaultModule,
      );
      // A DELETE removes its rows, so a by-id SELECT would normally find
      // nothing. When the removal is deferred (embedded-delete-in-select), the
      // rows are still live, so project them by id like UPDATE/INSERT — this
      // lets the outer SELECT read `(delete …).a`, the bare object set, or a
      // shape over the deleted rows. When *not* deferred, fall back to the
      // captured-ids literal so `count((delete T))` / `exists (delete T)` still
      // see the right cardinality after the rows are gone.
      if (mutationKind === "delete") {
        if (deferredChainDeletes !== null) {
          return { kind: "select_expr_subquery", expr: chainByIdSelect(resolved) };
        }
        return { kind: "set_literal", values: resolved.ids };
      }
      return { kind: "select_expr_subquery", expr: chainByIdSelect(resolved) };
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) out[key] = walk(value);
    return out;
  }
  // When a SELECT contains more than one mutation sub-expression
  // (`select { (insert …), (insert …) }`), the siblings execute sequentially
  // and each individual write commits on its own. If a later sibling violates a
  // constraint, the earlier (already-committed) writes — and any shared-table
  // trigger rows they produced — would leak. EdgeQL treats the whole statement
  // atomically, so wrap the sequence in a savepoint and undo every sibling when
  // any one of them fails.
  const mutationCount = countMutationExprs(expr);
  if (mutationCount < 2) {
    return { ...ast, expr: walk(expr) } as Statement;
  }
  // Two or more sibling mutations run in one query against a single read
  // snapshot: a value freed by one and re-used by another is a conflict
  // (and_delete_01: `SELECT ((DELETE T …), (INSERT T …))`). Snapshot the
  // exclusive values before any sibling runs and re-validate after.
  const chainTypeNames = collectChainTypeNames(ast, defaultModule);
  const exclusiveSnapshot = captureExclusiveSnapshot(db, schema, chainTypeNames);
  const savepoint = "gel_select_mut";
  db.prepare(`SAVEPOINT ${savepoint}`).run();
  try {
    const rewritten = { ...ast, expr: walk(expr) } as Statement;
    validateExclusiveSnapshot(db, schema, chainTypeNames, exclusiveSnapshot, ast.pos);
    db.prepare(`RELEASE ${savepoint}`).run();
    return rewritten;
  } catch (err) {
    db.prepare(`ROLLBACK TO ${savepoint}`).run();
    db.prepare(`RELEASE ${savepoint}`).run();
    throw err;
  }
};

// True when an expression resolves to an object set (a bare mutation, a nested
// select/binding) rather than a scalar like `(DELETE …).a`. Wrappers are
// peeled; control-flow nodes (FOR/if/??) recurse into their body/branches/
// operands so that `FOR z … UNION ((DELETE …).a)` is recognised as scalar even
// though a FOR over a bare mutation is object-valued. Used to route embedded-
// delete projections away from the object-set resolver when they are scalar.
const exprIsObjectValued = (node: unknown): boolean => {
  let cur = node as { kind?: string; expr?: unknown } | undefined;
  while (cur && (cur.kind === "expr" || cur.kind === "distinct" || cur.kind === "shape_projection")) {
    cur = cur.expr as { kind?: string; expr?: unknown } | undefined;
  }
  const k = cur?.kind;
  if (k === "for_expr") return exprIsObjectValued((cur as { body?: unknown }).body);
  if (k === "if_else") {
    const ie = cur as { thenExpr?: unknown; elseExpr?: unknown };
    return exprIsObjectValued(ie.thenExpr) || exprIsObjectValued(ie.elseExpr);
  }
  if (k === "coalesce") {
    const cn = cur as { left?: unknown; right?: unknown };
    return exprIsObjectValued(cn.left) || exprIsObjectValued(cn.right);
  }
  return k === "mutation_expr" || k === "subquery_statement"
    || k === "binding_ref" || k === "select" || k === "select_expr_subquery";
};

// A `??` is scalar-valued when neither operand resolves to an object set.
const coalesceIsScalar = (coalesceNode: unknown): boolean => {
  const cn = coalesceNode as { left?: unknown; right?: unknown };
  return !exprIsObjectValued(cn.left) && !exprIsObjectValued(cn.right);
};

// Count mutation_expr nodes anywhere in a tree (used to decide whether a
// SELECT body needs an atomic savepoint around its sibling mutations).
const countMutationExprs = (node: unknown): number => {
  if (Array.isArray(node)) return node.reduce<number>((acc, v) => acc + countMutationExprs(v), 0);
  if (node === null || typeof node !== "object") return 0;
  let count = (node as { kind?: unknown }).kind === "mutation_expr" ? 1 : 0;
  for (const value of Object.values(node)) count += countMutationExprs(value);
  return count;
};

// `SELECT (UPDATE/INSERT/DELETE …) { shape }` — a DML statement used as the
// source of a SELECT. The parser nests it as
// `select_expr → shape_projection → mutation_expr`. There's no single SQL
// statement that mutates and re-projects, so detect the pattern here and run
// it as: capture the affected rows' ids, run the mutation, then run a plain
// shaped SELECT restricted to those ids. Returns null for any other shape.
interface SelectOverMutation {
  mutation: InsertStatement | UpdateStatement | DeleteStatement;
  shape: ShapeElement[];
  orderBy?: OrderExprChain;
}

// The implicit shape an object-valued expression gets when no shape is written
// (`SELECT (DELETE T)` returns each object's id, like a bare `SELECT T`).
const ID_ONLY_SHAPE: ShapeElement[] = [
  { kind: "field", name: "id", operation: "assign", origin: "explicit" } as unknown as ShapeElement,
];

const detectSelectOverMutation = (ast: Statement): SelectOverMutation | null => {
  if (ast.kind !== "select_expr") return null;
  const expr = ast.expr;
  if (!expr) return null;
  // `SELECT (DML) { shape }` — the parser nests it as
  // `select_expr → shape_projection → mutation_expr`.
  if (expr.kind === "shape_projection") {
    const inner = expr.expr;
    if (!inner || inner.kind !== "mutation_expr") return null;
    return { mutation: inner.statement, shape: expr.shape, orderBy: ast.orderBy };
  }
  // Bare `SELECT (DML)` — no explicit shape, so the affected objects project
  // through the implicit id-only shape. Without this the statement compiles to
  // a NULL-placeholder SELECT (the SQL stage can't mutate-and-return) and yields
  // a spurious `[null]` row instead of the affected objects.
  if (expr.kind === "mutation_expr") {
    return { mutation: expr.statement, shape: ID_ONLY_SHAPE, orderBy: ast.orderBy };
  }
  return null;
};

const executeSelectOverMutation = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  ast: Statement,
  parts: SelectOverMutation,
  context: SecurityContext,
  runtimeTarget: RuntimeTarget,
  compilerService: ReturnType<typeof getCompilerService>,
): QueryExecutionTrace => {
  const { shape, orderBy } = parts;
  // The outer SELECT's WITH bindings are in scope for the mutation's values —
  // merge them on (the mutation's own bindings shadow same-named outer ones).
  const outerWith = (ast as { with?: WithBinding[] }).with ?? [];
  const mutation = outerWith.length > 0
    ? ({
        ...parts.mutation,
        with: [...outerWith, ...((parts.mutation as { with?: WithBinding[] }).with ?? [])],
        withModule: (parts.mutation as { withModule?: string }).withModule ?? (ast as { withModule?: string }).withModule,
      } as typeof parts.mutation)
    : parts.mutation;
  const typeName = mutation.typeName;
  const idShapeElement: ShapeElement = {
    kind: "field",
    name: "id",
    operation: "assign",
    origin: "explicit",
  } as unknown as ShapeElement;

  const runShapedSelect = (filter: FilterExpr | undefined, selectShape: ShapeElement[], order?: OrderExprChain): { rows: unknown[]; sql: SQLArtifact } => {
    const selectAst: SelectStatement = {
      kind: "select",
      typeName,
      shape: selectShape,
      fields: [],
      filter,
      orderBy: order as SelectStatement["orderBy"],
      pos: ast.pos,
    };
    const compiled = compilerService.compile(schema, selectAst, { globals: context.globals, params: context.params, target: runtimeTarget });
    const rows = runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
    return { rows, sql: compiled.sql };
  };

  const emptyArtifact: SQLArtifact = { sql: "", params: [], loweringMode: "single_statement" };
  // Assigned by the write step below; read by `projectAffected` (for its empty
  // fallback artifact) and the returned trace. Hoisted so the closure and the
  // DELETE pre-capture can reference it before the write runs.
  let lastCompiled: ReturnType<typeof compilerService.compile> | undefined;
  // Project a set of affected-row ids through the requested shape, reordering
  // to the capture order when there's no explicit ORDER BY (the `id IN (…)`
  // re-projection has no pinned row order otherwise). The requested shape may
  // omit `id`, so project it alongside for the sort; result comparison ignores
  // the extra key. Used after the write for INSERT/UPDATE (rows survive) and
  // *before* the write for DELETE (rows are about to be removed).
  const projectAffected = (ids: string[]): { rows: unknown[]; sql: SQLArtifact } => {
    if (ids.length === 0) return { rows: [], sql: lastCompiled?.sql ?? emptyArtifact };
    const reorder = !orderBy && ids.length > 1;
    const shapeHasId = shape.some((el) => (el as { name?: string }).name === "id");
    const projectShape = reorder && !shapeHasId ? [...shape, idShapeElement] : shape;
    const idFilter: FilterExpr = {
      kind: "in_predicate",
      target: { kind: "field", field: "id" },
      op: "in",
      values: { kind: "set_literal", values: ids },
    } as unknown as FilterExpr;
    const out = runShapedSelect(idFilter, projectShape, orderBy);
    if (reorder && out.rows.length > 1) {
      const rank = new Map(ids.map((id, i) => [id, i] as const));
      out.rows = [...out.rows].sort((a, b) => {
        const ra = rank.get((a as Record<string, unknown>)?.id as string) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get((b as Record<string, unknown>)?.id as string) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb;
      });
    }
    return out;
  };

  // `DELETE (SELECT T FILTER f)` / `UPDATE (SELECT T FILTER f) SET …` carries
  // the row predicate on the target subquery, not the statement's own `filter`.
  // Peel the target's select wrappers to recover that filter so the capture
  // below selects only the rows the mutation actually touches (otherwise it
  // captures — and the per-id loop deletes — every row of the type).
  const targetSubqueryFilter = (target: FreeObjectExpr | undefined): FilterExpr | undefined => {
    let cur = target;
    while (cur) {
      if (cur.kind === "select_expr_subquery" || cur.kind === "distinct") {
        cur = (cur as { expr: FreeObjectExpr }).expr;
        continue;
      }
      if (cur.kind === "select") return cur.clauses?.filter as FilterExpr | undefined;
      break;
    }
    return undefined;
  };

  // 1. Capture the ids the mutation will touch. For UPDATE/DELETE the rows are
  //    identified by the statement's own filter (ids are stable across the
  //    write); INSERT is captured after the write instead.
  let affectedIds: string[] = [];
  if (mutation.kind === "update" || mutation.kind === "delete") {
    const captureFilter = mutation.filter ?? targetSubqueryFilter(mutation.target);
    const idRows = runShapedSelect(captureFilter, [idShapeElement]);
    affectedIds = idRows.rows
      .map((row) => (row && typeof row === "object" ? (row as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string");
  }

  // DELETE physically removes the rows, so capture their shaped projection
  // *now*, before the write — afterward there's nothing to read. `SELECT
  // (DELETE T) { shape }` returns the deleted objects' data as it was.
  const deletedProjection = mutation.kind === "delete" ? projectAffected(affectedIds) : undefined;

  // 2. Run the mutation. For UPDATE/DELETE we re-issue it once per captured id
  //    with a `.id = <uuid>` filter: this pins the write to exactly the rows
  //    we re-project and sidesteps the runtime write path's single-`=`-
  //    predicate restriction (so `UPDATE … FILTER .val IN {…}` works here).
  //    Compiling the original (possibly multi-predicate) mutation just to read
  //    its subject type would hit that restriction, so resolve the type from
  //    its name instead.
  const qualifiedSubject = typeName.includes("::") ? typeName : `default::${typeName}`;
  const subjectType = schema.getType(qualifiedSubject) ?? schema.getType(typeName);
  if (!subjectType) {
    throw new AppError("E_SEMANTIC", `Unknown type '${typeName}'`, ast.pos.line, ast.pos.column);
  }
  if (mutation.kind === "insert") {
    if (isWithDmlChain(mutation)) {
      // DML bindings (or a binding-named subject) — run through the chain
      // executor so the bindings execute once and resolve by id.
      affectedIds = runDmlChain(db, schema, mutation, context).ids;
    } else {
      // Nested mutations in the INSERT's values (`note := (INSERT Note …)`)
      // execute up front — but when the *outer* INSERT will be suppressed by
      // UNLESS CONFLICT, this pass detects the conflict and drops the nested
      // DML so it doesn't run (dependent_15/17/21/23/25).
      const preparedMutation = preExecuteMutationExprsInDmlValues(db, schema, mutation, context) as typeof mutation;
      lastCompiled = compilerService.compile(schema, preparedMutation, { globals: context.globals, params: context.params, target: runtimeTarget });
      const writeResult0 = runWriteWithAccessPolicies(db, schema, preparedMutation, lastCompiled.ir, lastCompiled.sql, subjectType, context);
      affectedIds = (writeResult0.rows ?? [])
        .map((row) => (row && typeof row === "object" ? (row as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string");
    }
  } else {
    for (const id of affectedIds) {
      // Re-target the per-id mutation at the concrete type that physically
      // stores the row (multi-table inheritance): the base type's table may
      // not contain it, so an UPDATE/DELETE against the base would no-op.
      const concreteType = concreteTypeNameForId(db, schema, qualifiedSubject, id);
      const perIdSubjectType = schema.getType(concreteType) ?? subjectType;
      const perId = {
        ...mutation,
        typeName: concreteType,
        target: undefined,
        filter: { kind: "predicate", target: { kind: "field", field: "id" }, op: "=", value: id },
      } as InsertStatement | UpdateStatement | DeleteStatement;
      lastCompiled = compilerService.compile(schema, perId, { globals: context.globals, params: context.params, target: runtimeTarget });
      runWriteWithAccessPolicies(db, schema, perId, lastCompiled.ir, lastCompiled.sql, perIdSubjectType, context);
    }
  }

  // 3. Re-project the affected rows through the requested shape. DELETE was
  //    captured before the write (`deletedProjection`); INSERT/UPDATE rows
  //    survive and are read back here by id.
  const projected = mutation.kind === "delete"
    ? (deletedProjection ?? { rows: [], sql: emptyArtifact })
    : projectAffected(affectedIds);

  return {
    ast,
    ir: lastCompiled?.ir,
    sql: projected.sql,
    compiler: lastCompiled?.cache ?? { key: "select-over-mutation", status: "miss", stats: { hits: 0, misses: 0, size: 0 } },
    sqlTrail: lastCompiled ? [lastCompiled.sql, projected.sql] : [projected.sql],
    overlays: lastCompiled ? extractOverlays(lastCompiled.ir) : [],
    result: { kind: "select", rows: projected.rows },
  };
};

export const executeQueryWithTrace = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
  // When the caller has already parsed `query` (e.g. executeQuery parses it to
  // detect DDL/FOR-INSERT routing), it threads the AST through here so the
  // impl skips a redundant re-parse. Must be the AST of this exact `query`
  // string; injectRuntimeAliasBinding is idempotent, so an alias-injected
  // query parsed once upstream matches what the impl would re-parse.
  presetAst?: Statement,
  // The live `sqlTrail` (actual executed SQL, including nested/runtime SQL) is
  // only consumed by explain/debug paths. The normal query() path discards the
  // trace and keeps only `.result`, so it passes false to skip the per-query
  // sink setup and the prepared-statement wrapping (see installSqlTrace's fast
  // path). The impl still populates a static `sqlTrail` from the artifact, so
  // callers that read it without recording get the compiled (not live) trail.
  recordSqlTrail = true,
): QueryExecutionTrace => {
  if (!recordSqlTrail) {
    return executeQueryWithTraceImpl(db, schema, query, securityContext, presetAst);
  }
  // Record the full ordered sequence of SQL statements executed for this
  // query and surface it as `sqlTrail`. Nested executeQueryWithTrace calls
  // get their own sink (restored on exit), so each reports its own sequence.
  installSqlTrace(db);
  const sink: SQLArtifact[] = [];
  return runWithSqlSink(sink, () => {
    const trace = executeQueryWithTraceImpl(db, schema, query, securityContext, presetAst);
    if (sink.length > 0) {
      trace.sqlTrail = [...sink];
    }
    return trace;
  });
};

// ---------------------------------------------------------------------------
// Inline expansion of DML-bodied user functions.
//
// A user function whose body performs a mutation (`create function foo(x: int64)
// using ((insert Bar { a := x }))`) can't lower through the SQL inliner — the
// engine executes mutations from the AST, not the SQL compiler. We expand such
// calls at the AST level: parse the function body, substitute each parameter
// with its call-site argument expression, and splice the result in place of the
// `function_call` node. `select foo(1).a` becomes `select (insert Bar{a:=1}).a`,
// which the embedded-mutation paths (preExecuteMutationExprsInSelectExpr,
// WITH-DML chains, FOR-over-INSERT, …) already handle. Select-bodied UDFs are
// left untouched so the SQL inliner keeps lowering them to plain SQL.
// ---------------------------------------------------------------------------

// A parsed AST subtree contains a mutation when it carries a mutation_expr or a
// bare insert/update/delete statement node.
const astNodeContainsMutation = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(astNodeContainsMutation);
  if (!node || typeof node !== "object") return false;
  const k = (node as { kind?: string }).kind;
  if (k === "mutation_expr" || k === "insert" || k === "update" || k === "delete") return true;
  return Object.values(node as object).some(astNodeContainsMutation);
};

const cloneAstNode = <T>(node: T): T => JSON.parse(JSON.stringify(node)) as T;

// Parse a UDF body and return its inner expression when it is a clause-free
// `SELECT <expr>` wrapper (the form applyParsedFunctionDDL stores). A body with
// its own WITH bindings is hoisted onto a `select_expr_subquery` envelope (the
// same shape the parser emits for `(WITH … INSERT …)`) so the embedded-DML
// machinery resolves the bindings at the call site. ORDER BY isn't peelable.
const trivialUdfBodyExpr = (fn: FunctionDef): FreeObjectExpr | undefined => {
  if (fn.body.kind !== "query") return undefined;
  let parsed: Statement | Statement[];
  try {
    parsed = parseEdgeQL(fn.body.query);
  } catch {
    // The DDL pre-pass prepends `SELECT ` to a UDF body, which produces invalid
    // syntax when the body itself begins with WITH/FOR/INSERT/… (`SELECT with …
    // insert …`). Retry with that prefix stripped so such bodies still parse.
    const stripped = fn.body.query.replace(/^\s*select\s+/i, "");
    if (stripped === fn.body.query) return undefined;
    try {
      parsed = parseEdgeQL(stripped);
    } catch {
      return undefined;
    }
  }
  const stmt = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!stmt) return undefined;
  // A bare top-level INSERT/UPDATE/DELETE body (possibly with WITH bindings):
  // wrap it as a mutation_expr inside a subquery envelope carrying the WITH.
  if (stmt.kind === "insert" || stmt.kind === "update" || stmt.kind === "delete") {
    const withBindings = (stmt as { with?: WithBinding[] }).with;
    const mutation = { ...(stmt as object), with: undefined } as Statement;
    const mutExpr = { kind: "mutation_expr", statement: mutation } as unknown as FreeObjectExpr;
    if (withBindings && withBindings.length > 0) {
      return { kind: "select_expr_subquery", expr: mutExpr, clauses: { _withBindings: withBindings } } as unknown as FreeObjectExpr;
    }
    return mutExpr;
  }
  if (stmt.kind !== "select_expr") return undefined;
  const se = stmt as SelectExprStatement;
  if (se.orderBy) return undefined;
  // `WITH … SELECT <expr>` body: carry the bindings onto a subquery envelope.
  if (se.with && se.with.length > 0) {
    return { kind: "select_expr_subquery", expr: se.expr, clauses: { _withBindings: se.with } } as unknown as FreeObjectExpr;
  }
  return se.expr;
};

// The FreeObjectExpr carried by a call-site argument envelope.
const callArgToExpr = (arg: FunctionCallArgExpr): FreeObjectExpr | undefined => {
  switch (arg.kind) {
    case "expr":
      return arg.expr;
    case "named_arg":
      return callArgToExpr(arg.arg);
    case "function_call":
      return { kind: "function_call", call: arg.call } as unknown as FreeObjectExpr;
    default:
      // parameter / literal / array_literal forms are valid in expr position.
      return arg as unknown as FreeObjectExpr;
  }
};

const parseDefaultExprAst = (text: string): FreeObjectExpr | undefined => {
  try {
    const parsed = parseEdgeQL(/^select\b/i.test(text.trim()) ? text : `SELECT ${text}`);
    const stmt = Array.isArray(parsed) ? parsed[0] : parsed;
    if (stmt && stmt.kind === "select_expr") return (stmt as SelectExprStatement).expr;
  } catch {
    // fall through
  }
  return undefined;
};

// Map each function parameter to the call-site expression that fills it
// (positional / named / default / optional-empty / variadic-packed). Returns
// undefined when a required parameter is left unfilled (can't expand).
const buildUdfParamSubstitutions = (
  fn: FunctionDef,
  args: FunctionCallArgExpr[],
): Map<string, FreeObjectExpr> | undefined => {
  const positional: FunctionCallArgExpr[] = [];
  const named = new Map<string, FunctionCallArgExpr>();
  for (const a of args) {
    if (a && (a as { kind?: string }).kind === "named_arg") {
      named.set((a as { name: string }).name, (a as { arg: FunctionCallArgExpr }).arg);
    } else {
      positional.push(a);
    }
  }
  const subs = new Map<string, FreeObjectExpr>();
  let cursor = 0;
  for (const param of fn.params) {
    if (param.variadic) {
      const packed = positional
        .slice(cursor)
        .map((a) => callArgToExpr(a))
        .filter((e): e is FreeObjectExpr => e !== undefined);
      cursor = positional.length;
      subs.set(param.name, { kind: "array_literal_expr", values: packed } as unknown as FreeObjectExpr);
      continue;
    }
    let chosen: FreeObjectExpr | undefined;
    if (!param.namedOnly && cursor < positional.length) {
      chosen = callArgToExpr(positional[cursor]);
      cursor += 1;
    } else if (named.has(param.name)) {
      chosen = callArgToExpr(named.get(param.name)!);
    } else if (param.default !== undefined) {
      chosen = { kind: "literal", value: param.default } as unknown as FreeObjectExpr;
    } else if (param.defaultExpr !== undefined) {
      chosen = parseDefaultExprAst(param.defaultExpr);
    } else if (param.optional) {
      chosen = { kind: "set_literal", values: [] } as unknown as FreeObjectExpr;
    } else {
      return undefined;
    }
    if (chosen === undefined) return undefined;
    subs.set(param.name, chosen);
  }
  return subs;
};

// Deep-clone an AST subtree, replacing each `binding_ref` that names a
// substituted parameter with a fresh clone of that parameter's argument.
const substituteParamRefs = (node: unknown, subs: Map<string, FreeObjectExpr>): unknown => {
  if (Array.isArray(node)) return node.map((n) => substituteParamRefs(n, subs));
  if (!node || typeof node !== "object") return node;
  if ((node as { kind?: string }).kind === "binding_ref") {
    const name = (node as { name?: string }).name;
    if (name !== undefined && subs.has(name)) return cloneAstNode(subs.get(name)!);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as object)) out[k] = substituteParamRefs(v, subs);
  return out;
};

const expandInlineDmlFunctionCalls = (
  schema: SchemaSnapshot,
  ast: Statement,
  defaultModule: string,
): Statement => {
  let changed = false;
  // Resolve a call to its DML-bodied UDF, returning the (unsubstituted) body.
  const resolveDmlUdfBody = (call: FunctionCallExpr): { fn: FunctionDef; body: FreeObjectExpr } | undefined => {
    const divider = call.name.lastIndexOf("::");
    const moduleName = divider >= 0 ? call.name.slice(0, divider) : defaultModule;
    const shortName = divider >= 0 ? call.name.slice(divider + 2) : call.name;
    if (moduleName === "std" || moduleName === "math" || moduleName === "cal") return undefined;
    const positionalCount = call.args.filter((a) => (a as { kind?: string }).kind !== "named_arg").length;
    const fn = schema.findFunction(moduleName, shortName, positionalCount);
    if (!fn) return undefined;
    const body = trivialUdfBodyExpr(fn);
    if (!body) return undefined;
    return { fn, body };
  };
  // Does a UDF body *ultimately* perform DML — directly, or transitively
  // through a call to another DML-bodied UDF (`foo` body is `inner(x)`)?
  const bodyIsDml = (body: FreeObjectExpr, seen: globalThis.Set<string>, depth: number): boolean => {
    if (astNodeContainsMutation(body)) return true;
    if (depth > 64) return false;
    let found = false;
    const walk = (node: unknown): void => {
      if (found || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if ((node as { kind?: string }).kind === "function_call" && (node as { call?: FunctionCallExpr }).call) {
        const inner = resolveDmlUdfBody((node as { call: FunctionCallExpr }).call);
        if (inner && !seen.has(inner.fn.name)) {
          seen.add(inner.fn.name);
          if (bodyIsDml(inner.body, seen, depth + 1)) { found = true; return; }
        }
      }
      for (const v of Object.values(node as object)) walk(v);
    };
    walk(body);
    return found;
  };
  const tryExpandCall = (call: FunctionCallExpr, depth: number): FreeObjectExpr | undefined => {
    if (depth > 64) return undefined;
    const resolved = resolveDmlUdfBody(call);
    if (!resolved) return undefined;
    const { fn, body: bodyExpr } = resolved;
    // Only DML-bodied functions are expanded here (directly or via a nested
    // DML-UDF call); select-bodied UDFs lower through the SQL inliner.
    if (!bodyIsDml(bodyExpr, new globalThis.Set<string>([fn.name]), 0)) return undefined;
    const subs = buildUdfParamSubstitutions(fn, call.args);
    if (!subs) return undefined;
    const substituted = substituteParamRefs(cloneAstNode(bodyExpr), subs) as FreeObjectExpr;
    // A wrapper UDF whose body is itself a DML-UDF call (`foo := inner(x)`,
    // inner does the DML) carries no mutation node directly — expand the calls
    // nested in the (param-substituted) body first so the wrapper's DML
    // surfaces. Only then decide whether this is a DML-bodied function;
    // pure-SELECT bodies are left for the SQL inliner.
    const expandedBody = expand(substituted, depth + 1) as FreeObjectExpr;
    if (!astNodeContainsMutation(expandedBody)) return undefined;
    return expandedBody;
  };
  const expand = (node: unknown, depth: number): unknown => {
    if (Array.isArray(node)) return node.map((n) => expand(n, depth));
    if (!node || typeof node !== "object") return node;
    if ((node as { kind?: string }).kind === "function_call" && (node as { call?: FunctionCallExpr }).call) {
      const replacement = tryExpandCall((node as { call: FunctionCallExpr }).call, depth);
      if (replacement !== undefined) {
        changed = true;
        // Recurse into the spliced body so nested DML-UDF calls expand too.
        return expand(replacement, depth + 1);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as object)) out[k] = expand(v, depth);
    return out;
  };
  const result = expand(ast, 0) as Statement;
  if (changed) {
    // The parser stores literal insert/update value assignments as raw scalars
    // (`a := 1` → `values.a = 1`), but parameter substitution produces a
    // `{kind:"literal", …}` node in that slot. The DML value resolver handles
    // raw scalars and complex expressions but not a bare literal node, so
    // unwrap those back to the raw scalar the parser would have emitted.
    normalizeDmlLiteralValues(result);
  }
  return changed ? result : ast;
};

// A bare `{kind:"literal", value:V}` node sitting where the parser emits a raw
// scalar (insert/update value assignments, filter predicate comparison values).
// Parameter substitution produces such nodes; the DML resolver handles raw
// scalars and complex expressions but not the bare literal node, so unwrap it.
const unwrapBareLiteral = (v: unknown): unknown =>
  v && typeof v === "object" && (v as { kind?: string }).kind === "literal" && "value" in (v as object)
    ? (v as { value: unknown }).value
    : v;

const normalizeDmlLiteralValues = (node: unknown): void => {
  if (Array.isArray(node)) {
    node.forEach(normalizeDmlLiteralValues);
    return;
  }
  if (!node || typeof node !== "object") return;
  const kind = (node as { kind?: string }).kind;
  if ((kind === "insert" || kind === "update") && (node as { values?: unknown }).values
      && typeof (node as { values: unknown }).values === "object") {
    const vals = (node as { values: Record<string, unknown> }).values;
    for (const key of Object.keys(vals)) {
      vals[key] = unwrapBareLiteral(vals[key]);
    }
  }
  // `FILTER .a <= 1` stores the comparison value as a raw scalar; a substituted
  // parameter leaves a bare literal node there, which the predicate resolver
  // can't compare. Unwrap it (complex predicate values keep their node form).
  if (kind === "predicate" && "value" in (node as object)) {
    (node as { value: unknown }).value = unwrapBareLiteral((node as { value: unknown }).value);
  }
  for (const v of Object.values(node as object)) normalizeDmlLiteralValues(v);
};

const executeQueryWithTraceImpl = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
  presetAst?: Statement,
): QueryExecutionTrace => {
  // Declared outside the try so the finally can flush deferred deletes (see
  // statementEmbedsDeleteInSelect). Set true only when this call owns the queue.
  let ownsDeferredDeletes = false;
  try {
    query = injectRuntimeAliasBinding(schema, query);
    // Merge any session globals stored on this schema (from prior CREATE/SET
    // GLOBAL on the same connection) into the context before compiling.
    const context = withSessionGlobals(schema, normalizeSecurityContext(securityContext));
    const runtimeTarget = resolvedRuntimeTarget(context, db);
    const compilerService = getCompilerService();
    let ast = presetAst ?? parseEdgeQL(query);
    if (ast.kind === "configure") {
      // `SET/RESET GLOBAL …` issued via `.query()` updates the session global
      // state directly.
      if (ast.isSessionGlobal) {
        applySessionGlobal(db, schema, ast, context);
        return {
          ast,
          ir: undefined,
          sql: { sql: "", params: [], loweringMode: "single_statement" } as SQLArtifact,
          compiler: { key: "set-global-noop", status: "miss", stats: { hits: 0, misses: 0, size: 0 } },
          sqlTrail: [],
          overlays: [],
          result: { kind: "insert", changes: 0 },
        };
      }
      // CONFIGURE has no SQLite analogue — return an empty insert-like result
      // so callers that fire it from `.query()` don't have to pre-filter or
      // catch the compile-time "Statement kind 'configure' requires
      // typeName" raised by the strict typed-mutation pipeline.
      applySessionConfigure(schema, ast);
      return {
        ast,
        ir: undefined,
        sql: { sql: "", params: [], loweringMode: "single_statement" } as SQLArtifact,
        compiler: { key: "configure-noop", status: "miss", stats: { hits: 0, misses: 0, size: 0 } },
        sqlTrail: [],
        overlays: [],
        result: { kind: "insert", changes: 0 },
      };
    }
    // Expand calls to DML-bodied user functions (`select foo(1)` where foo's
    // body is `(insert Bar{a:=x})`) into the spliced body before routing, so
    // the embedded-mutation execution paths see the mutation directly.
    ast = expandInlineDmlFunctionCalls(schema, ast, ast.withModule ?? "default");
    // Single sweep for all the embedded-DML / mutation handling below. Each of
    // those passes (statementEmbedsDeleteInSelect, validateMutationPlacement,
    // preExecute*, detectSelectOverMutation, isWithDmlChain) is a no-op unless
    // the statement contains a mutation, and each previously re-walked the whole
    // AST to discover that. Detect it once here — after inline-DML expansion,
    // which is the only step that can introduce a mutation — and gate them on
    // the result. The intervening group/dunder/free-object rewrites never add
    // mutations, so this flag stays valid for the passes that follow them.
    const astHasMutation = astNodeContainsMutation(ast);
    // `SELECT (DELETE …)` / `WITH t := (DELETE …) …`: the deleted rows must stay
    // readable until the enclosing SELECT projects them. Activate the deferred-
    // delete queue (the DML chain executor will queue removals instead of running
    // them inline) and flush it after the result is built. Only the outermost
    // such statement owns the queue — nested executeQueryWithTrace calls inherit
    // it. Plain `DELETE T` and embedded INSERT/UPDATE are unaffected.
    ownsDeferredDeletes = deferredChainDeletes === null
      && astHasMutation
      && statementEmbedsDeleteInSelect(ast);
    if (ownsDeferredDeletes) {
      deferredChainDeletes = [];
    }
    context.statementInsertedIds = new Set<string>();
    validateParsedStatement(ast, { schema, module: ast.withModule });
    preValidateStatementAst(schema, ast, allowUserSpecifiedId(schema));
    const statementType = statementTypeOf(ast);
    enforceBuiltinPermissions(context, statementType, ast.pos.line, ast.pos.column);
    // Fully-constant subscripts (`select "abc"[1]`, `select [1,2,3][0:9]`)
    // are evaluated directly — see tryEvalConstantSubscriptStatement.
    {
      const constRows = tryEvalConstantSubscriptStatement(ast);
      if (constRows !== undefined) {
        return {
          ast,
          ir: undefined,
          sql: { sql: "", params: [], loweringMode: "single_statement" } as SQLArtifact,
          compiler: { key: "const-subscript", status: "miss", stats: { hits: 0, misses: 0, size: 0 } },
          sqlTrail: [],
          overlays: [],
          result: { kind: "select", rows: constRows },
        };
      }
    }
    // `assert_exists(...)`/`array_agg(...)[i]` pointer steps over an empty /
    // out-of-bounds inner set must raise instead of returning empty rows.
    enforceRootSetAssertions(db, schema, ast, context, runtimeTarget);
    // `FOR v IN <iter> UNION (<value-expr with embedded INSERT/…>)` — body is
    // an expression carrying DML (a tuple, shaped select, nested FOR). Run each
    // iteration's embedded DML and concatenate the produced rows. Skipped for
    // GROUP iterators (handled below) and bare-INSERT bodies (FOR-INSERT path).
    if (ast.kind === "for"
        && ast.body.kind === "select_expr"
        && !unwrapGroupIteratorExpr(ast.iteratorExpr)
        && nodeContainsMutationExpr(ast.body.expr)) {
      const rows = executeForWithDmlBodyExpr(db, schema, ast, context, []);
      if (rows !== undefined) {
        return {
          ast,
          ir: undefined,
          sql: { sql: "", params: [], loweringMode: "single_statement" } as SQLArtifact,
          compiler: { key: "for-dml-body", status: "miss", stats: { hits: 0, misses: 0, size: 0 } },
          sqlTrail: [],
          overlays: [],
          result: { kind: "select", rows },
        };
      }
    }
    // `FOR g IN (GROUP …) UNION (…body…)` — when the group-rows iterator and
    // per-row body lower fully to SQL, the generic path below runs that
    // artifact. Only bodies the SQL stage can't express route through the
    // runtime FOR-group executor.
    if (ast.kind === "for" && unwrapGroupIteratorExpr(ast.iteratorExpr) && ast.body.kind === "select_expr") {
      const probe = compilerService.compile(schema, ast, { globals: context.globals, params: context.params, target: runtimeTarget });
      const sqlIsComplete = lowersToSingleSql(probe.sql);
      if (!sqlIsComplete) {
        const traces: QueryExecutionTrace[] = [];
        executeForLoop(db, schema, ast, context, runtimeTarget, compilerService, [], traces);
        if (traces.length > 0) return traces[0];
      }
    }
    // `WITH g := (GROUP …) SELECT g { … }` — a GROUP bound in WITH can't lower
    // to SQL, so pre-evaluate it into literal rows; the outer statement then
    // projects over those rows. A no-op for statements with no group binding.
    ast = preEvaluateGroupBindings(db, schema, ast, context);
    // `__default__` references resolve against the assigned pointer's
    // declared default before anything compiles.
    ast = rewriteDunderDefaults(schema, ast);
    // A volatile free-object WITH binding (`WITH free := { name :=
    // <str>random() }`) must materialize once — capture before inlining.
    ast = captureFreeObjectScalarBindings(db, schema, ast, context);
    if (astHasMutation) {
      // Reject mutations placed in a shape's computed expression / non-exposed
      // free object before the pre-execution passes silently run them.
      validateMutationPlacement(ast);
      // DML inside WITH bindings / free-object entries executes up front; the
      // statement then compiles as a plain read over the captured ids.
      ast = preExecuteDmlBindings(db, schema, ast, context);
      ast = preExecuteMutationExprsInDmlValues(db, schema, ast, context);
      ast = preExecuteMutationExprsInSelectExpr(db, schema, ast, context);
    }
    const selectOverMutation = astHasMutation ? detectSelectOverMutation(ast) : undefined;
    if (selectOverMutation) {
      return executeSelectOverMutation(db, schema, query, ast, selectOverMutation, context, runtimeTarget, compilerService);
    }
    if (astHasMutation && isWithDmlChain(ast)) {
      return executeWithDmlChain(db, schema, ast, context);
    }
    const compiled = compilerService.compile(schema, ast, { globals: context.globals, params: context.params, target: runtimeTarget, allowUserSpecifiedId: allowUserSpecifiedId(schema) });
    const ir = compiled.ir;
    const subjectType = ir && (ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete")
      ? typeDefForTable(schema, ir.table)
      : undefined;
    if (ir && (ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete") && !subjectType) {
      const astTypeName = "typeName" in ast ? ast.typeName : "<unknown>";
      throw new AppError("E_SEMANTIC", `Unknown type '${astTypeName}'`, ast.pos.line, ast.pos.column);
    }
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const sqlTrail: SQLArtifact[] = [sqlArtifact];

    let result: QueryResult;
    if (ir && (ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete")) {
      if (!subjectType) {
        throw new Error("invariant: write IR reached execution without a resolved subject type");
      }
      const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context);

      result = {
        kind: ir.kind,
        changes: writeResult.changes,
        rows: writeResult.rows,
      };
    } else {
      // SELECT / SELECT-expr / SELECT-free / GROUP / FOR all execute off the
      // gelIR SQL artifact via runGelSelectSQL. select_free and top-level GROUP
      // require a complete single-statement lowering — the legacy runtime
      // grouper has been retired, so an incomplete lowering is unsupported.
      if (ast.kind === "select_free" && classifyExecutionStrategy(ast, sqlArtifact, schema) === "reject") {
        throw new AppError(
          "E_UNSUPPORTED",
          "select_free requires SQL lowering; runtime fallback disabled",
          ast.pos.line,
          ast.pos.column,
        );
      }
      if (ast.kind === "group" && classifyExecutionStrategy(ast, sqlArtifact, schema) === "reject") {
        throw new AppError("E_UNSUPPORTED", "GROUP statement could not be lowered to SQL", ast.pos.line, ast.pos.column);
      }
      result = {
        kind: "select",
        rows: runGelSelectSQL(db, schema, compiled.gelIr, context, sqlArtifact),
      };
    }

    return {
      ast,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: extractOverlays(ir),
      result,
    };
  } catch (err) {
    throw asAppError(decorateErrorWithUnsupportedTag(err, query));
  } finally {
    if (ownsDeferredDeletes) {
      const queued = deferredChainDeletes ?? [];
      deferredChainDeletes = null;
      // Flush the deferred row removals now that the SELECT has read its rows.
      for (const run of queued) run();
    }
  }
};

// A select/for statement embeds a DELETE-in-select when it carries a
// `mutation_expr` whose statement is a delete somewhere in its body (but is not
// itself a bare top-level DELETE — those keep immediate semantics).
const statementEmbedsDeleteInSelect = (ast: Statement): boolean => {
  // A top-level `FOR … UNION (SELECT (DELETE …))` is intentionally excluded: the
  // FOR executor runs each iteration body as its own nested SELECT, and that
  // nested SELECT owns (and flushes) the deferral. Letting the FOR own the queue
  // instead would defer every iteration's delete to the very end, so a later
  // iteration would re-see — and re-delete — rows an earlier one already removed.
  if (ast.kind !== "select" && ast.kind !== "select_expr" && ast.kind !== "select_free") {
    return false;
  }
  // The DELETE shows up as a `mutation_expr` (`SELECT (DELETE …)`) or a
  // `subquery_statement` (`WITH t := (DELETE …)`), each wrapping a delete
  // statement. Either form means the outer SELECT needs the rows kept alive.
  const containsDeleteMutationExpr = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(containsDeleteMutationExpr);
    if (node === null || typeof node !== "object") return false;
    const n = node as { kind?: string; statement?: { kind?: string } };
    if ((n.kind === "mutation_expr" || n.kind === "subquery_statement")
        && n.statement?.kind === "delete") {
      return true;
    }
    return Object.values(node).some(containsDeleteMutationExpr);
  };
  return containsDeleteMutationExpr(ast);
};

const extractTargetTypeExpr = (target: FreeObjectExpr): TypeExpr | undefined => {
  if (target.kind === "distinct") {
    return extractTargetTypeExpr(target.expr);
  }
  if (target.kind === "shape_projection") {
    return extractTargetTypeExpr(target.expr);
  }
  if (target.kind === "is_type" && target.typeExpr) {
    const inner = extractTargetTypeExpr(target.expr);
    if (!inner) return undefined;
    return { kind: "type_intersection", left: inner, right: target.typeExpr };
  }
  if (target.kind === "set_expr") {
    if (target.values.length === 0) return undefined;
    const exprs: TypeExpr[] = [];
    for (const value of target.values) {
      const inner = extractTargetTypeExpr(value);
      if (!inner) return undefined;
      exprs.push(inner);
    }
    return exprs.reduce((acc, next) => ({ kind: "type_union", left: acc, right: next }));
  }
  if (target.kind === "binding_ref") {
    return { kind: "type_name", name: target.name };
  }
  if (target.kind === "select") {
    const hasOnlyDefaultId = !target.shape
      || target.shape.length === 0
      || target.shape.every((el) => el.kind === "field" && el.name === "id" && (el as { origin?: string }).origin === "default");
    if (hasOnlyDefaultId) {
      return { kind: "type_name", name: target.typeName };
    }
    return undefined;
  }
  if (target.kind === "path_steps") {
    const head = target.steps[0];
    if (!head || head.kind !== "object_ref") return undefined;
    let current: TypeExpr = { kind: "type_name", name: head.name };
    for (const step of target.steps.slice(1)) {
      if (step.kind !== "type_intersection" || !step.typeExpr) return undefined;
      current = { kind: "type_intersection", left: current, right: step.typeExpr };
    }
    return current;
  }
  return undefined;
};

const concreteTypeNamesForTypeExprAtRuntime = (
  schema: SchemaSnapshot,
  expr: TypeExpr,
  moduleName = "default",
): string[] => {
  const qualify = (n: string): string => (n.includes("::") ? n : `${moduleName}::${n}`);
  const visit = (node: TypeExpr): string[] => {
    if (node.kind === "type_name") {
      const qualified = qualify(node.name);
      if (qualified === "default::Object" || qualified === "std::Object") {
        return schema.listTypes()
          .filter((typeDef) => !typeDef.abstract)
          .map((typeDef) => qualifiedTypeName(typeDef));
      }
      return schema.concreteTypeNamesUnder(qualified);
    }
    const left = new Set(visit(node.left));
    const right = new Set(visit(node.right));
    if (node.kind === "type_union") {
      return [...new Set([...left, ...right])];
    }
    return [...left].filter((name) => right.has(name));
  };
  return [...new Set(visit(expr))];
};

const expandPolymorphicMutation = (
  schema: SchemaSnapshot,
  ast: UpdateStatement | DeleteStatement,
): Array<UpdateStatement | DeleteStatement> | undefined => {
  const target = ast.target;
  if (!target) {
    const moduleName = ast.withModule ?? "default";
    const qualified = ast.typeName.includes("::") ? ast.typeName : `${moduleName}::${ast.typeName}`;
    if (qualified === "default::Object" || qualified === "std::Object") {
      const concretes = schema.listTypes()
        .filter((typeDef) => !typeDef.abstract)
        .map((typeDef) => qualifiedTypeName(typeDef));
      return concretes.map((typeName) => ({ ...ast, typeName }));
    }
    // A plain `UPDATE/DELETE <BaseType>` over a type with concrete descendants
    // stored in their own tables (multi-table inheritance): fan the mutation
    // out to every concrete type in the hierarchy. Without this the base-table
    // statement misses rows that physically live in subtype tables (and skips
    // their exclusivity triggers). When the subject is itself the only concrete
    // type, leave it untouched (no expansion needed).
    const concretes = schema.concreteTypeNamesUnder(qualified);
    if (concretes.length === 0) {
      return undefined;
    }
    if (concretes.length === 1 && concretes[0] === qualified) {
      return undefined;
    }
    return concretes.map((typeName) => ({ ...ast, typeName }));
  }
  const typeExpr = extractTargetTypeExpr(target);
  if (!typeExpr) {
    return undefined;
  }
  const concretes = concreteTypeNamesForTypeExprAtRuntime(schema, typeExpr, ast.withModule ?? "default");
  if (concretes.length === 0) {
    return [];
  }
  return concretes.map((typeName) => ({ ...ast, typeName, target: undefined }));
};

// Convert an expression-position `for_expr` chain that ends in an INSERT
// (`FOR b … (INSERT …)`, possibly nested and/or wrapped in select_expr/UNION)
// into a nested FOR statement so the FOR-INSERT expander can lower it. Returns
// undefined when the chain doesn't bottom out in an INSERT.
const forExprChainToForStatement = (
  node: FreeObjectExpr,
  pos: ForStatement["pos"],
): ForStatement | undefined => {
  // Peel a select_expr / select_expr_subquery wrapper down to the inner expr.
  let cur: FreeObjectExpr = node;
  if ((cur as { kind?: string }).kind === "select_expr_subquery") {
    cur = (cur as unknown as { expr: FreeObjectExpr }).expr;
  }
  if ((cur as { kind?: string }).kind !== "for_expr") return undefined;
  const forExpr = cur as unknown as { variable: string; iterator: FreeObjectExpr; optional?: boolean; body: FreeObjectExpr };
  let bodyExpr: FreeObjectExpr = forExpr.body;
  if ((bodyExpr as { kind?: string }).kind === "select_expr_subquery") {
    bodyExpr = (bodyExpr as unknown as { expr: FreeObjectExpr }).expr;
  }
  let innerBody: ForStatement["body"];
  if ((bodyExpr as { kind?: string }).kind === "mutation_expr"
    && (bodyExpr as unknown as { statement: Statement }).statement.kind === "insert") {
    innerBody = (bodyExpr as unknown as { statement: InsertStatement }).statement;
  } else {
    const nested = forExprChainToForStatement(bodyExpr, pos);
    if (!nested) return undefined;
    innerBody = nested;
  }
  return {
    kind: "for",
    variable: forExpr.variable,
    optional: forExpr.optional ?? false,
    iteratorExpr: forExpr.iterator,
    body: innerBody,
    pos,
  };
};

// Monotonic id tagging each batch of INSERTs produced from one FOR-INSERT, so
// their per-statement traces can be merged back into the single set the FOR
// expression yields.
let forInsertGroupCounter = 0;

// Recursively expand `FOR v IN <iter> ( … INSERT … )` — including nested FORs
// (`FOR a … FOR b … INSERT`) and object-set iterators (`FOR Q IN (SELECT T{…})
// INSERT … Q.field …`) — into a flat list of concrete INSERT statements, one
// per element of the (cartesian) iteration. Each loop variable is bound as a
// WITH literal on every leaf INSERT so the body's references (`a`, `Q.field`,
// `a ++ b`) resolve through the normal IR/SQL pipeline. Returns undefined when
// any iterator level can't be materialised up front (caller falls back to the
// unsupported-FOR error path).
//
// `accumWith` carries the loop-variable bindings established by enclosing FOR
// levels so a leaf INSERT sees every variable in scope.
const expandForInsertStatements = (
  forAst: ForStatement,
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  accumWith: WithBinding[] = [],
): InsertStatement[] | undefined => {
  let body = forAst.body;
  // FOR-level WITH bindings (other than the loop variable) flow onto each leaf.
  // A scalar binding is materialized to a single literal up front so a volatile
  // expression (`WITH x := <str>random() FOR y IN … (… tag2 := x)`) captures
  // ONE value shared by every iteration — otherwise each cloned leaf re-inlines
  // `random()` and the per-row values diverge. Evaluate each in the scope of
  // the bindings before it (plus accumulated enclosing-loop literals).
  const rawForWith = ((forAst as { with?: WithBinding[] }).with ?? [])
    .filter((binding) => binding.name !== forAst.variable);
  const forStatementWith: WithBinding[] = [];
  for (const binding of rawForWith) {
    if (binding.value.kind === "subquery_expr" && !bindingValueContainsMutation(binding.value)) {
      const evaluated = evaluateScalarBindingViaSQL(
        db, schema, binding.value.expr, [...accumWith, ...forStatementWith], context, forAst.pos,
      );
      if (evaluated !== undefined && evaluated.kind === "literal") {
        forStatementWith.push({ name: binding.name, value: evaluated } as WithBinding);
        continue;
      }
    }
    forStatementWith.push(binding);
  }

  // `array_unpack([<object-set>])` iterates the object set — unwrap it to the
  // inner object select so the object-iterator path handles it.
  const unwrapArrayUnpackObjectIterator = (
    iter: ForStatement["iteratorExpr"],
  ): ForStatement["iteratorExpr"] | undefined => {
    const n = iter as { kind?: string; call?: { name?: string; args?: Array<{ kind?: string; expr?: unknown }> } };
    if (n.kind !== "function_call") return undefined;
    if ((n.call?.name ?? "").split("::").pop() !== "array_unpack") return undefined;
    const arg = n.call?.args?.[0];
    const arr = arg?.kind === "expr" ? (arg.expr as { kind?: string; values?: unknown[] }) : undefined;
    if (arr?.kind !== "array_literal_expr" || arr.values?.length !== 1) return undefined;
    const el = arr.values[0] as { kind?: string };
    if (el?.kind === "select") return el as ForStatement["iteratorExpr"];
    return undefined;
  };

  // `array_unpack([(<object-set>,)])` — a single-element array whose element is
  // a 1-tuple wrapping an object select. The loop variable `t` is that 1-tuple,
  // so body references read `t.0.field` / `t.0`. Unwrap to the inner object
  // select and rewrite `t.0` → `t` so the object-iterator path applies, binding
  // the loop variable directly to each iterated object.
  const unwrapArrayUnpackSingleTupleObjectIterator = (
    iter: ForStatement["iteratorExpr"],
  ): ForStatement["iteratorExpr"] | undefined => {
    const n = iter as { kind?: string; call?: { name?: string; args?: Array<{ kind?: string; expr?: unknown }> } };
    if (n.kind !== "function_call") return undefined;
    if ((n.call?.name ?? "").split("::").pop() !== "array_unpack") return undefined;
    const arg = n.call?.args?.[0];
    const arr = arg?.kind === "expr" ? (arg.expr as { kind?: string; values?: unknown[] }) : undefined;
    if (arr?.kind !== "array_literal_expr" || arr.values?.length !== 1) return undefined;
    const tup = arr.values[0] as { kind?: string; values?: unknown[] };
    if (tup?.kind !== "tuple" || tup.values?.length !== 1) return undefined;
    const el = tup.values[0] as { kind?: string };
    if (el?.kind === "select" || el?.kind === "select_expr_subquery") {
      return el as ForStatement["iteratorExpr"];
    }
    return undefined;
  };
  // Collapse `<var>.0` (the only element of a 1-tuple loop variable) to a bare
  // reference to `<var>` so downstream field-access substitution treats the
  // object as the loop variable itself.
  const collapseTupleZeroRefs = (node: unknown, varName: string): unknown => {
    if (Array.isArray(node)) return node.map((item) => collapseTupleZeroRefs(item, varName));
    if (node === null || typeof node !== "object") return node;
    const n = node as Record<string, unknown> & { kind?: string };
    if (n.kind === "index_access"
      && n.index === 0
      && (n.expr as { kind?: string; name?: string })?.kind === "binding_ref"
      && (n.expr as { name?: string }).name === varName) {
      return { kind: "binding_ref", name: varName };
    }
    if (n.kind === "path" && n.head === varName && Array.isArray(n.steps)) {
      // `t.0.name` may parse as a path with steps; drop a leading "0" step.
      const steps = n.steps as unknown[];
      if (steps.length > 0 && (steps[0] as { name?: string })?.name === "0") {
        return { ...n, steps: steps.slice(1) };
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) out[k] = collapseTupleZeroRefs(v, varName);
    return out;
  };
  {
    const tupleObjIterator = unwrapArrayUnpackSingleTupleObjectIterator(forAst.iteratorExpr);
    if (tupleObjIterator) {
      forAst = {
        ...forAst,
        iteratorExpr: tupleObjIterator,
        body: collapseTupleZeroRefs(forAst.body, forAst.variable) as ForStatement["body"],
      };
      body = forAst.body;
    }
  }

  // Object-set iterator: materialise the rows (augmented with every field the
  // body reads off the loop variable) and bind those fields per element.
  const referencedFields = collectBindingRefFields(body, forAst.variable);
  // `{ (SELECT …) }` — a single-element set wrapping an object select iterates
  // that object set; unwrap to the inner select.
  const unwrapSingletonSetObjectIterator = (
    iter: ForStatement["iteratorExpr"],
  ): ForStatement["iteratorExpr"] | undefined => {
    const n = iter as { kind?: string; values?: Array<{ kind?: string }> };
    if (n.kind !== "set_expr" || n.values?.length !== 1) return undefined;
    const el = n.values[0];
    if (el?.kind === "select" || el?.kind === "select_expr_subquery") {
      return el as ForStatement["iteratorExpr"];
    }
    return undefined;
  };

  const normalizedObjIterator = forAst.iteratorExpr.kind === "select_expr_subquery"
      || forAst.iteratorExpr.kind === "select"
    ? forAst.iteratorExpr
    : unwrapArrayUnpackObjectIterator(forAst.iteratorExpr)
      ?? unwrapSingletonSetObjectIterator(forAst.iteratorExpr);
  if (normalizedObjIterator) {
    forAst = { ...forAst, iteratorExpr: normalizedObjIterator };
  }
  if (forAst.iteratorExpr.kind === "select_expr_subquery" || forAst.iteratorExpr.kind === "select") {
    const objectRows = evaluateForObjectIteratorRows(
      forAst.iteratorExpr, referencedFields, schema, db, context,
    );
    if (objectRows === undefined) return undefined;
    // `FOR optional Q IN (<empty>) …` yields a single null iteration; the body
    // can't read any field off the (absent) Q, so emit one row's worth of
    // inserts with no substitution.
    const effectiveRows: (Record<string, unknown> | null)[] = objectRows.length === 0 && forAst.optional
      ? [null]
      : objectRows;
    // The iterator's object type — used to bind a by-id object WITH binding for
    // bare loop-variable references (`subject := x`, not just `x.field`).
    const iterSel = (forAst.iteratorExpr.kind === "select_expr_subquery"
      ? (forAst.iteratorExpr as { expr?: { typeName?: string } }).expr
      : forAst.iteratorExpr) as { typeName?: string } | undefined;
    const iterTypeName = iterSel?.typeName;
    const out: InsertStatement[] = [];
    for (const row of effectiveRows) {
      // Bind `var.field` references to row values by substituting the
      // field_access nodes with literals, and bind the loop variable itself to
      // a by-id object SELECT so bare `var` references (e.g. as a link target)
      // resolve to the iterated object.
      const substituted = row === null
        ? body
        : substituteBindingRefFields(body, forAst.variable, row) as ForStatement["body"];
      const objBinding: WithBinding[] = row !== null && typeof row.id === "string" && iterTypeName
        ? [{
            name: forAst.variable,
            value: { kind: "subquery_expr", expr: { kind: "select_expr_subquery", expr: chainByIdSelect({ typeName: iterTypeName, ids: [row.id as string] }) } },
          } as WithBinding]
        : [];
      const expanded = expandBodyToInserts(substituted, schema, db, context, [...accumWith, ...forStatementWith, ...objBinding]);
      if (expanded === undefined) return undefined;
      out.push(...expanded);
    }
    return out;
  }

  // Tuple-set iterator: `FOR x IN {('a','1'), ('b','2')} INSERT … { c := x.0,
  // @p := x.1 }`. Each iteration binds the tuple element accesses (`x.0`,
  // `x.1`) to literals from one tuple. The scalar path below can't handle these
  // (tuples aren't scalar values), so evaluate each tuple's elements and
  // substitute the loop variable's index accesses directly.
  const tupleIterRows = evaluateForTupleIteratorRows(forAst.iteratorExpr, schema, db, context);
  if (tupleIterRows !== undefined) {
    const out: InsertStatement[] = [];
    for (const tuple of tupleIterRows) {
      const substituted = substituteTupleIndexRefs(body, forAst.variable, tuple) as ForStatement["body"];
      const expanded = expandBodyToInserts(substituted, schema, db, context, [...accumWith, ...forStatementWith]);
      if (expanded === undefined) return undefined;
      out.push(...expanded);
    }
    return out;
  }

  // Scalar iterator: one iteration per value, binding the variable as a WITH
  // literal. `evaluateForIteratorValues` materialises set literals, concats,
  // function calls, and SQL-lowerable selects.
  //
  // A nested FOR's iterator may reference enclosing loop variables
  // (`FOR a … FOR b IN {a ++ "c"} …`); those arrive as `accumWith` literal
  // bindings, so evaluate the iterator via SQL with them (plus the FOR's own
  // WITH) in scope rather than the standalone evaluator.
  let iterValues: unknown[];
  if (accumWith.length > 0) {
    const sqlValues = evaluateForScalarIteratorViaSql(forAst, schema, db, context, accumWith);
    iterValues = sqlValues ?? [];
  } else {
    try {
      iterValues = forAst.iteratorExpr.kind === "set_literal"
        ? forAst.iteratorExpr.values
        : evaluateForIteratorValues(forAst.iteratorExpr, schema, db, context);
    } catch {
      iterValues = [];
    }
    // Iterators referencing the FOR's own WITH bindings (`WITH raw := …, FOR
    // item IN json_array_unpack(raw)`) can't be materialised by the standalone
    // evaluator — compile a one-off SELECT with those bindings in scope.
    if (!iterValues.every((v) => v === null || isScalarValue(v))
      || (iterValues.length === 0 && ((forAst as { with?: WithBinding[] }).with?.length ?? 0) > 0)) {
      const sqlValues = evaluateForScalarIteratorViaSql(forAst, schema, db, context);
      if (sqlValues !== undefined) iterValues = sqlValues;
    }
  }
  // Object rows leaking through evaluateForIteratorValues aren't scalar-bindable.
  if (!iterValues.every((v) => v === null || isScalarValue(v))) return undefined;
  const effectiveValues: (ScalarValue | null)[] = iterValues.length === 0 && forAst.optional
    ? [null]
    : (iterValues as (ScalarValue | null)[]);
  const out: InsertStatement[] = [];
  for (const value of effectiveValues) {
    // For a direct INSERT body, substitute any top-level `name := <var>` with
    // the literal value (matching the legacy desugar) so the written value is
    // concrete — UNLESS CONFLICT detection and constraint checks then compare
    // the actual value, and no loop-variable WITH binding is needed. Deeper
    // references (`name := <var> ++ "x"`) still need the WITH binding.
    const directlySubstitutable = body.kind === "insert" && value !== null && isScalarValue(value);
    const substitutedBody = directlySubstitutable
      ? substituteTopLevelInsertVarRefs(body as InsertStatement, forAst.variable, value)
      : body;
    const varBinding: WithBinding[] = value !== null && isScalarValue(value)
      ? [{ name: forAst.variable, value: { kind: "literal", value } }]
      : [];
    const expanded = expandBodyToInserts(substitutedBody, schema, db, context, [...accumWith, ...forStatementWith, ...varBinding]);
    if (expanded === undefined) return undefined;
    out.push(...expanded);
  }
  return out;
};

// Replace `field := <var>` insert values (where the value is exactly the loop
// variable binding ref) with the concrete literal. Mirrors the legacy scalar
// FOR-INSERT desugar so the written value is materialised, not a binding ref.
const substituteTopLevelInsertVarRefs = (
  insert: InsertStatement,
  varName: string,
  value: ScalarValue,
): InsertStatement => {
  const values: Record<string, InsertValue> = {};
  for (const [key, v] of Object.entries(insert.values)) {
    if (typeof v === "object" && v !== null && "kind" in v
      && (v as { kind?: unknown }).kind === "binding_ref"
      && (v as { name?: unknown }).name === varName) {
      values[key] = value as unknown as InsertValue;
    } else {
      values[key] = v;
    }
  }
  return { ...insert, values };
};

// Evaluate a FOR iterator that yields scalars by compiling it as a one-off
// SELECT with the FOR's own WITH bindings in scope (`WITH raw := …, FOR item IN
// json_array_unpack(raw)`). Returns the scalar row values, or undefined if the
// iterator can't be lowered to a single SQL statement or yields non-scalars.
const evaluateForScalarIteratorViaSql = (
  forAst: ForStatement,
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  extraWith: WithBinding[] = [],
): (ScalarValue | null)[] | undefined => {
  // Enclosing-loop bindings (extraWith) precede the FOR's own WITH so the
  // iterator can resolve outer variables (`FOR a … FOR b IN {a ++ "c"}`).
  const mergedWith = [...extraWith, ...((forAst as { with?: WithBinding[] }).with ?? [])];
  const stmtAst = {
    kind: "select_expr",
    expr: forAst.iteratorExpr,
    with: mergedWith.length > 0 ? mergedWith : undefined,
    withModule: forAst.withModule,
    pos: forAst.pos,
  } as unknown as Statement;
  const rows = tryRunSingleSqlRows(db, schema, stmtAst, context, { globals: context.globals, params: context.params });
  if (!rows) return undefined;
  const mapped = rows.map((row) => (row !== null && typeof row === "object" ? JSON.stringify(row) : row));
  return mapped.every((row) => row === null || isScalarValue(row)) ? (mapped as (ScalarValue | null)[]) : undefined;
};

// Expand a FOR body (an INSERT leaf or a nested FOR) into concrete INSERTs,
// threading the accumulated loop-variable WITH bindings onto the leaf.
const expandBodyToInserts = (
  body: ForStatement["body"],
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  accumWith: WithBinding[],
): InsertStatement[] | undefined => {
  if (body.kind === "for") {
    return expandForInsertStatements(body, schema, db, context, accumWith);
  }
  if (body.kind === "insert") {
    // The loop-variable bindings precede the body's own bindings (which may
    // reference them; ast_to_ir resolves bindings in declaration order).
    const ownWith = (body.with ?? []).filter((b) => !accumWith.some((a) => a.name === b.name));
    const mergedWith = [...accumWith, ...ownWith];
    return [{ ...body, with: mergedWith.length > 0 ? mergedWith : undefined }];
  }
  return undefined;
};

// Field names referenced as `<var>.<field>` anywhere in a FOR body.
const collectBindingRefFields = (node: unknown, varName: string, acc = new globalThis.Set<string>()): string[] => {
  const walk = (cur: unknown): void => {
    if (Array.isArray(cur)) { cur.forEach(walk); return; }
    if (cur === null || typeof cur !== "object") return;
    const n = cur as Record<string, unknown> & { kind?: string };
    if (n.kind === "field_access"
      && typeof n.field === "string"
      && (n.expr as { kind?: string; name?: string })?.kind === "binding_ref"
      && (n.expr as { name?: string }).name === varName) {
      acc.add(n.field);
    }
    // `t.name` references off an object loop variable also parse as a `path`
    // node (head = variable, tail = field) inside INSERT/expression values.
    if (n.kind === "path" && n.head === varName && typeof n.tail === "string") {
      acc.add(n.tail);
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(node);
  return [...acc];
};

// Replace every `<var>.<field>` field-access in a node with a literal of the
// corresponding value from `row`.
const substituteBindingRefFields = (node: unknown, varName: string, row: Record<string, unknown>): unknown => {
  if (Array.isArray(node)) return node.map((item) => substituteBindingRefFields(item, varName, row));
  if (node === null || typeof node !== "object") return node;
  const n = node as Record<string, unknown> & { kind?: string };
  if (n.kind === "field_access"
    && typeof n.field === "string"
    && (n.expr as { kind?: string; name?: string })?.kind === "binding_ref"
    && (n.expr as { name?: string }).name === varName) {
    return { kind: "literal", value: row[n.field as string] ?? null };
  }
  // `t.name` written as a `path` node (head = loop variable, tail = field).
  if (n.kind === "path" && n.head === varName && typeof n.tail === "string") {
    return { kind: "literal", value: row[n.tail as string] ?? null };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) out[k] = substituteBindingRefFields(v, varName, row);
  return out;
};

// Push a loop-variable WITH binding (`sub := (select … by id)`) onto every
// nested `select_expr_subquery`'s own WITH clause, so a body whose nested
// selects are compiled standalone (the runtime coalesce evaluator does this)
// can still resolve bare references to the loop variable. Nested mutations are
// left untouched — those resolve the loop variable through the binding the
// caller threads onto the statement directly.
const attachLoopVarToNestedSelects = (node: unknown, binding: WithBinding): unknown => {
  if (Array.isArray(node)) return node.map((item) => attachLoopVarToNestedSelects(item, binding));
  if (node === null || typeof node !== "object") return node;
  const n = node as Record<string, unknown> & { kind?: string };
  if (n.kind === "insert" || n.kind === "update" || n.kind === "delete" || n.kind === "mutation_expr") {
    return n;
  }
  if (n.kind === "select_expr_subquery") {
    const inner = n.expr as { kind?: string; clauses?: { _withBindings?: WithBinding[] } } | undefined;
    if (inner?.kind === "select") {
      const clauses = (inner.clauses ?? {}) as Record<string, unknown> & { _withBindings?: WithBinding[] };
      const existing = clauses._withBindings ?? [];
      if (!existing.some((b) => b.name === binding.name)) {
        // Recurse into the inner select's clauses (filter etc.) first, then
        // attach the binding at this level — without recursing into the binding
        // value itself (which would re-attach forever).
        const recursedInner = attachLoopVarToNestedSelects(inner, binding) as typeof inner & { clauses?: Record<string, unknown> & { _withBindings?: WithBinding[] } };
        const recursedClauses = (recursedInner.clauses ?? {}) as Record<string, unknown> & { _withBindings?: WithBinding[] };
        return { ...n, expr: { ...recursedInner, clauses: { ...recursedClauses, _withBindings: [binding, ...(recursedClauses._withBindings ?? [])] } } };
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) out[k] = attachLoopVarToNestedSelects(v, binding);
  return out;
};

// A FOR iterator written as a set of tuple literals (`{('a','1'), ('b','2')}`).
// Returns one scalar-element array per tuple, or undefined when the iterator
// isn't a set of (constant-foldable) tuples — leaving the scalar/object paths
// to handle it.
const evaluateForTupleIteratorRows = (
  iteratorExpr: ForStatement["iteratorExpr"],
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
): ScalarValue[][] | undefined => {
  const n = iteratorExpr as { kind?: string; values?: unknown[] };
  if (n.kind !== "set_expr" || !Array.isArray(n.values) || n.values.length === 0) return undefined;
  const peelExpr = (node: unknown): unknown =>
    (node !== null && typeof node === "object" && (node as { kind?: string }).kind === "expr")
      ? (node as { expr: unknown }).expr
      : node;
  const rows: ScalarValue[][] = [];
  for (const raw of n.values) {
    const el = peelExpr(raw) as { kind?: string; values?: unknown[] };
    if (el?.kind !== "tuple" || !Array.isArray(el.values)) return undefined;
    const elements: ScalarValue[] = [];
    for (const member of el.values) {
      const body = peelExpr(member) as { kind?: string; value?: unknown };
      if (body?.kind === "literal") {
        const scalar = coerceUnknownToScalar(body.value);
        if (scalar === undefined) return undefined;
        elements.push(scalar);
        continue;
      }
      // Non-literal tuple member (`(x, a ++ "c")`) — evaluate via SQL.
      const evaluated = evaluateScalarBindingViaSQL(db, schema, member as never, [], context, { line: 1, column: 1 });
      if (evaluated === undefined || evaluated.kind !== "literal") return undefined;
      const scalar = coerceUnknownToScalar((evaluated as { value: unknown }).value);
      if (scalar === undefined) return undefined;
      elements.push(scalar);
    }
    rows.push(elements);
  }
  return rows;
};

// Substitute the loop variable's tuple-element accesses (`x.0`, `x.1` —
// `index_access` over a `binding_ref`/`path`) with literals from one tuple.
const substituteTupleIndexRefs = (node: unknown, varName: string, tuple: ScalarValue[]): unknown => {
  if (Array.isArray(node)) return node.map((item) => substituteTupleIndexRefs(item, varName, tuple));
  if (node === null || typeof node !== "object") return node;
  const n = node as Record<string, unknown> & { kind?: string };
  if (n.kind === "index_access"
    && typeof n.index === "number"
    && (n.expr as { kind?: string; name?: string })?.kind === "binding_ref"
    && (n.expr as { name?: string }).name === varName) {
    return { kind: "literal", value: tuple[n.index as number] ?? null };
  }
  // `x.0` parsed as a path with a numeric tail step.
  if (n.kind === "path" && n.head === varName && typeof n.tail === "string" && /^\d+$/.test(n.tail)) {
    return { kind: "literal", value: tuple[Number(n.tail)] ?? null };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) out[k] = substituteTupleIndexRefs(v, varName, tuple);
  return out;
};

// Materialise an object-set FOR iterator as rows carrying every field the body
// reads off the loop variable. Returns undefined if the augmented SELECT can't
// be lowered to SQL.
const evaluateForObjectIteratorRows = (
  iteratorExpr: ForStatement["iteratorExpr"],
  fields: string[],
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
): Record<string, unknown>[] | undefined => {
  // Peel a select_expr_subquery wrapper down to its inner select, preserving
  // the subquery's filter/order/pagination on the select's clauses.
  let sel = iteratorExpr as Record<string, unknown> & { kind?: string };
  let extraWith: WithBinding[] | undefined;
  if (sel.kind === "select_expr_subquery") {
    const sub = sel as unknown as { expr: Record<string, unknown> & { kind?: string }; filter?: unknown; orderBy?: unknown; limit?: unknown; offset?: unknown; clauses?: { _withBindings?: WithBinding[] } };
    extraWith = sub.clauses?._withBindings;
    sel = sub.expr;
  }
  if (sel.kind !== "select" || typeof sel.typeName !== "string") return undefined;
  // The AST `select` expr stores its FILTER/ORDER BY/pagination on `clauses`,
  // not as top-level SelectStatement fields — flatten them so the compiled
  // SELECT keeps the iterator's filter (otherwise it scans the whole extent).
  const selExpr = sel as unknown as { typeName: string; shape?: ShapeElement[]; clauses?: ClauseChain };
  const clauses: ClauseChain = selExpr.clauses ?? {};
  // Build a shape that includes id plus every read field (schema or computed).
  const shape: ShapeElement[] = [...(selExpr.shape ?? [])];
  const haveField = (name: string): boolean =>
    shape.some((e) => (e.kind === "field" && e.name === name) || (e.kind === "computed" && (e as { name?: string }).name === name));
  if (!haveField("id")) shape.unshift({ kind: "field", name: "id" } as ShapeElement);
  for (const f of fields) {
    if (!haveField(f)) shape.push({ kind: "field", name: f } as ShapeElement);
  }
  const augmented: SelectStatement = {
    kind: "select",
    typeName: selExpr.typeName,
    shape,
    fields: fieldsFromShape(shape),
    filter: clauses.filter,
    orderBy: clauses.orderBy,
    limit: clauses.limit,
    offset: clauses.offset,
    limitExpr: clauses.limitExpr,
    offsetExpr: clauses.offsetExpr,
    with: extraWith ?? clauses._withBindings,
    withModule: clauses._withModule,
    withModuleAliases: clauses._withModuleAliases,
    pos: { line: 1, column: 1 },
  };
  try {
    const compiled = getCompilerService().compile(schema, augmented as unknown as Statement, { globals: context.globals, params: context.params });
    if (!lowersToSingleSql(compiled.sql)) return undefined;
    const rows = runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
    return rows.map((r) => (r !== null && typeof r === "object" ? r as Record<string, unknown> : { __scalar: r }));
  } catch {
    return undefined;
  }
};

export const executeQueryUnitWithTrace = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  script: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
  parserOptions: ParseEdgeQLOptions = {},
): QueryUnitTrace => {
  try {
    // Validate user-DDL accessibility before the pre-pass so read-only
    // module targets (`CREATE TYPE std::Foo`, …) never get registered.
    validateScriptUserDDL(script, parserOptions, securityContext.strictUserDDL ?? false);
    maybeRegisterDynamicDDLScript(db, schema, script);
    // Seed the context with session globals stored on this schema (from prior
    // script() calls on the same connection); statements in this script may add
    // more, refreshing `context.globals` as they run.
    const context = withSessionGlobals(schema, normalizeSecurityContext(securityContext));
    const runtimeTarget = resolvedRuntimeTarget(context, db);
    const compilerService = getCompilerService();
    const statements = parseEdgeQLScript(script, parserOptions);
    if (statements.length === 0) {
      throw new Error("No statements to execute");
    }

    const overlays: OverlayIR[] = [];
    const traces: QueryExecutionTrace[] = [];

    const expanded: Statement[] = [];
    for (const rawAst of statements) {
      // `SELECT (INSERT T { … })` / `SELECT (DELETE T)` / `SELECT (UPDATE T …)`
      // — the parser wraps mutations used as expressions in a `select_expr`
      // around either a bare `mutation_expr` or a `select_expr_subquery` of
      // one (when there are inner WITH bindings). The new SQL pipeline
      // treats this as a pure SELECT and never executes the mutation; unwrap
      // both shapes so the INSERT/DELETE/UPDATE flows through the regular
      // mutation handler that actually persists rows. WITH bindings on the
      // outer SELECT and the inner subquery are merged onto the mutation so
      // its values can resolve them.
      let ast: Statement = rawAst;
      const peelInnerMutation = (
        outer: Extract<Statement, { kind: "select_expr" }>,
      ): Statement | null => {
        // Statement-level `select_expr` never carries limit/offset/filter —
        // the parser folds pagination and filters into the inner
        // `select_expr_subquery` (checked below); only `orderBy` lives on
        // the statement itself.
        if (outer.filter !== undefined || outer.orderBy !== undefined) {
          return null;
        }
        let inner: FreeObjectExpr = outer.expr;
        const innerWith: WithBinding[] = [];
        if (inner.kind === "select_expr_subquery"
          && inner.filter === undefined
          && inner.orderBy === undefined
          && inner.limit === undefined
          && inner.offset === undefined
        ) {
          if (inner.clauses?._withBindings) {
            innerWith.push(...inner.clauses._withBindings);
          }
          inner = inner.expr;
        }
        if (inner.kind !== "mutation_expr") return null;
        const mutation = inner.statement;
        if (mutation.kind !== "insert" && mutation.kind !== "update" && mutation.kind !== "delete") {
          return null;
        }
        const mergedWith = [...(outer.with ?? []), ...innerWith, ...(mutation.with ?? [])];
        return {
          ...mutation,
          with: mergedWith.length > 0 ? mergedWith : undefined,
          withModule: mutation.withModule ?? outer.withModule,
          withModuleAliases: mutation.withModuleAliases ?? outer.withModuleAliases,
        } as Statement;
      };
      if (rawAst.kind === "select_expr") {
        const peeled = peelInnerMutation(rawAst);
        if (peeled) ast = peeled;
      }
      if (ast.kind === "delete") {
        // Validate the target before expansion: `expandPolymorphicMutation`
        // fans the delete out to concrete subtypes (and drops branches with no
        // runtime type), which would otherwise discard an invalid target — a
        // free-object binding, or `schema::Object` inside a set — so the error
        // never fires on the script path.
        validateDeleteStatement(schema, ast);
      }
      if ((ast.kind === "delete" || ast.kind === "update") && !isWithDmlChain(ast)) {
        // A target-binding chain (`WITH X := (… UNION …) DELETE X`) is handled
        // by the WITH-DML chain executor below; expanding it here would drop it
        // (the binding name resolves to no concrete type).
        const expansion = expandPolymorphicMutation(schema, ast);
        if (expansion) {
          expanded.push(...expansion);
          continue;
        }
      }
      expanded.push(ast);
    }

    // Indexed iteration so we can splice FOR-INSERT desugar results in place
    // (instead of appending at the end). Statement ordering matters: a later
    // INSERT may reference rows produced by an earlier FOR-INSERT, so the
    // expanded children must run *before* whatever followed the FOR.
    // Peel `FOR y IN … UNION (SELECT (INSERT …))` / `FOR y IN … UNION
    // (WITH … INSERT …)` down to the bare INSERT so the existing FOR-INSERT
    // desugar can run. Body WITH bindings are forwarded to the INSERT's
    // own WITH so they resolve at the same scope.
    for (let stmtIdx = 0; stmtIdx < expanded.length; stmtIdx += 1) {
      const ast = expanded[stmtIdx];
      if (ast.kind === "for" && ast.body.kind === "select_expr") {
        const outer = ast.body;
        // Statement-level `select_expr` never carries limit/offset/filter —
        // the parser folds those into the inner `select_expr_subquery`
        // (checked below); only `orderBy` lives on the statement itself.
        if (outer.orderBy === undefined) {
          let bodyExpr: FreeObjectExpr = outer.expr;
          const innerWith: WithBinding[] = [];
          if (bodyExpr.kind === "select_expr_subquery"
            && bodyExpr.filter === undefined
            && bodyExpr.orderBy === undefined
            && bodyExpr.limit === undefined
            && bodyExpr.offset === undefined
          ) {
            if (bodyExpr.clauses?._withBindings) {
              innerWith.push(...bodyExpr.clauses._withBindings);
            }
            bodyExpr = bodyExpr.expr;
          }
          if (bodyExpr.kind === "mutation_expr" && bodyExpr.statement.kind === "insert") {
            const mutation = bodyExpr.statement;
            const mergedWith = [...(outer.with ?? []), ...innerWith, ...(mutation.with ?? [])];
            expanded[stmtIdx] = {
              ...ast,
              body: {
                ...mutation,
                with: mergedWith.length > 0 ? mergedWith : undefined,
                withModule: mutation.withModule ?? outer.withModule,
                withModuleAliases: mutation.withModuleAliases ?? outer.withModuleAliases,
              },
            } as Statement;
          } else if (bodyExpr.kind === "for_expr") {
            // Nested FOR-INSERT written as `FOR a … FOR b … INSERT` or
            // `FOR a … UNION (FOR b … UNION (INSERT …))` — both parse as a
            // top-level FOR whose body is a (select_expr-wrapped) `for_expr`
            // chain ending in an `INSERT`. Rebuild that chain as nested FOR
            // statements so the FOR-INSERT expander handles every level.
            const nestedForBody = forExprChainToForStatement(bodyExpr, ast.pos);
            if (nestedForBody) {
              const mergedWith = [...(ast.with ?? []), ...innerWith];
              expanded[stmtIdx] = {
                ...ast,
                with: mergedWith.length > 0 ? mergedWith : undefined,
                body: nestedForBody,
              } as Statement;
            }
          }
        }
      }
    }
    for (let stmtIdx = 0; stmtIdx < expanded.length; stmtIdx += 1) {
      let rawUnitAst = expanded[stmtIdx];
      // DML bound in a FOR's WITH executes once for the whole statement —
      // rewrite those bindings to by-id selects before the per-value desugar
      // clones the body.
      if (rawUnitAst.kind === "for" && ((rawUnitAst as { with?: WithBinding[] }).with ?? []).some((binding) => bindingValueContainsMutation(binding.value))) {
        rawUnitAst = preExecuteDmlBindings(db, schema, rawUnitAst, context) as typeof rawUnitAst;
        expanded[stmtIdx] = rawUnitAst;
      }
      let ast = rawUnitAst;
      // A FOR-INSERT child (desugared below) carries a snapshot cache shared by
      // all its siblings so snapshot-valued expression defaults resolve once.
      const unitSnapshotDefaultCache = forInsertSnapshotDefaultCaches.get(rawUnitAst);
      if (rawUnitAst.kind === "for"
        && (rawUnitAst.body.kind === "insert" || rawUnitAst.body.kind === "for")) {
        // Desugar `FOR v IN <iter> ( … INSERT … )` — including nested FORs and
        // object-set iterators — into one cleanly-lowered INSERT per element of
        // the (cartesian) iteration. Each loop variable is bound as a WITH
        // literal / its read fields substituted, so the body resolves through
        // the normal IR/SQL pipeline.
        const children = expandForInsertStatements(rawUnitAst, schema, db, context);
        if (children !== undefined) {
          // Tag every child of this one FOR-INSERT so the per-statement traces
          // can be merged back into the single set the FOR expression yields
          // (`FOR … INSERT …` returns the set of all inserted objects).
          const groupId = forInsertGroupCounter++;
          for (const child of children) (child as { __forGroup?: number }).__forGroup = groupId;
          // All children of one FOR share a snapshot for snapshot-valued
          // expression defaults (so `default := (SELECT count(T))` is computed
          // once against the pre-statement state and reused for every row).
          const sharedDefaultCache = new Map<string, ScalarValue>();
          for (const child of children) {
            forInsertSnapshotDefaultCaches.set(child, sharedDefaultCache);
          }
          expanded.splice(stmtIdx, 1, ...children);
          stmtIdx -= 1; // re-enter the new first child on the next loop step
          continue;
        }
      }
      if (ast.kind === "for") {
        // Non-INSERT FOR statements (e.g. `FOR x IN T UNION (x.name, T.name)`)
        // are lowered as SELECTs through `compileASTToGelIR`. Surface the
        // remaining unsupported FOR-body shapes with a uniform error.
        if (ast.body.kind !== "select_expr" && ast.body.kind !== "select") {
          throw new AppError(
            "E_UNSUPPORTED",
            "FOR requires SQL lowering; runtime fallback disabled",
            ast.pos.line,
            ast.pos.column,
          );
        }
      }
      if (ast.kind === "ddl") {
        if (ast.action === "create" && ast.objectKind === "function" && ast.functionDecl) {
          applyParsedFunctionDDL(schema, ast, parserOptions.defaultModule ?? "default");
          populateSchemaIntrospection(db, schema, listAllRuntimeAliasNames(schema), runtimeExprAliases.get(schema));
          compilerService.clear();
        } else if (ast.action === "create" && ast.objectKind === "global") {
          // Register the global and (for computed globals) cache its default
          // value, then refresh the context so later statements read it.
          applyCreateGlobalDDL(db, schema, ast, parserOptions.defaultModule ?? "default");
          context.globals = withSessionGlobals(schema, context).globals;
          compilerService.clear();
        }
        continue;
      }
      if (ast.kind === "configure") {
        // `SET GLOBAL <name> := …` / `RESET GLOBAL <name>` assign or clear a
        // session global; store the value and refresh the context.
        if (ast.isSessionGlobal) {
          applySessionGlobal(db, schema, ast, context);
          context.globals = withSessionGlobals(schema, context).globals;
          continue;
        }
        // Session/instance/database CONFIGURE statements (e.g. `CONFIGURE
        // SESSION SET allow_user_specified_id := true`) have no SQLite
        // analogue. The only knob sqlite-ts honors is allow_user_specified_id
        // (recorded on the connection's session config so the INSERTs that
        // follow may assign an explicit `id`); everything else is a no-op so
        // scripts that use CONFIGURE for upstream parity still run their DML.
        applySessionConfigure(schema, ast);
        continue;
      }
      if (ast.kind === "describe") {
        // The parser routes session-management passthrough statements that have
        // no SQLite analogue — `SET GLOBAL <name> := …`, `SET ALIAS …`,
        // `DESCRIBE …` — to a describe placeholder. They carry no executable IR,
        // so treat them as no-ops here rather than failing GEL-IR lowering. This
        // keeps multi-statement scripts that toggle a global for upstream parity
        // (e.g. `set global break := true`) running their subsequent DML.
        continue;
      }

      // Fresh per-statement insert tracker so same-statement conflicts aren't
      // suppressed by UNLESS CONFLICT (see SecurityContext.statementInsertedIds).
      context.statementInsertedIds = new Set<string>();
      validateParsedStatement(ast, { schema, module: ast.withModule });
      preValidateStatementAst(schema, ast, allowUserSpecifiedId(schema));
      // Reject mutations placed in a shape's computed expression / non-exposed
      // free object before the pre-execution passes silently run them.
      validateMutationPlacement(ast);
      const statementType = statementTypeOf(ast);
      enforceBuiltinPermissions(context, statementType, ast.pos.line, ast.pos.column);
      // `__default__` references resolve against the assigned pointer's
      // declared default before anything compiles.
      ast = rewriteDunderDefaults(schema, ast);
      // A volatile free-object WITH binding (`WITH free := { name :=
      // <str>random() }`) must materialize once — capture its referenced scalar
      // entries before the values inline (and re-evaluate) the expression.
      ast = captureFreeObjectScalarBindings(db, schema, ast, context);
      ast = preExecuteMutationExprsInDmlValues(db, schema, ast, context);
      // WITH-bound DML subquery chains (`WITH x := (INSERT …) INSERT … x.name …`)
      // — same handling as the single-query path: execute the bindings in
      // order and resolve references against the captured id-sets.
      if (isWithDmlChain(ast)) {
        traces.push(executeWithDmlChain(db, schema, ast, context));
        continue;
      }
      // DML inside WITH bindings / free-object entries executes up front; the
      // statement then compiles as a plain read over the captured ids.
      ast = preExecuteDmlBindings(db, schema, ast, context);
      // DML embedded in a SELECT's body expression (`select (INSERT …).num`,
      // `select (SELECT …) ?? (INSERT …)`) — execute the mutation(s) and
      // substitute by-id selects, same as the single-query path.
      ast = preExecuteMutationExprsInSelectExpr(db, schema, ast, context);
      // `SELECT (DML …) { shape }` — run the mutation then re-project its rows.
      {
        const selectOverMutation = detectSelectOverMutation(ast);
        if (selectOverMutation) {
          traces.push(executeSelectOverMutation(db, schema, script, ast, selectOverMutation, context, runtimeTarget, compilerService));
          continue;
        }
      }
      // Fully-constant subscripts (`select "abc"[1]`, `select [1,2,3][0:9]`)
      // are evaluated directly — see tryEvalConstantSubscriptStatement.
      {
        const constRows = tryEvalConstantSubscriptStatement(ast);
        if (constRows !== undefined) {
          traces.push({
            ast,
            ir: undefined,
            sql: { sql: "", params: [], loweringMode: "single_statement" } as SQLArtifact,
            compiler: { key: "const-subscript", status: "miss", stats: { hits: 0, misses: 0, size: 0 } },
            sqlTrail: [],
            overlays: [],
            result: { kind: "select", rows: constRows },
          });
          continue;
        }
      }
      // (Removed legacy silent-skip for INSERT-with-unknown-type-and-no-shape.
      // It was masking real errors like `INSERT Object;` /
      // `INSERT std::FreeObject;` / `INSERT InsertTest;` — fall through to
      // compilation and let the IR pass raise the right diagnostic instead.)

      const compiled = compilerService.compile(schema, ast, { overlays, globals: context.globals, params: context.params, target: runtimeTarget, allowUserSpecifiedId: allowUserSpecifiedId(schema) });
      const ir = compiled.ir;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const subjectType = ir && (ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete")
        ? typeDefForTable(schema, ir.table)
        : undefined;
      if (ir && (ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete") && !subjectType) {
        const astTypeName = "typeName" in ast ? ast.typeName : "<unknown>";
        throw new AppError("E_SEMANTIC", `Unknown type '${astTypeName}'`, ast.pos.line, ast.pos.column);
      }

      let result: QueryResult;
      if (ir && (ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete")) {
        if (!subjectType) {
          throw new Error("invariant: write IR reached execution without a resolved subject type");
        }
        const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context, unitSnapshotDefaultCache);
        result = { kind: ir.kind, changes: writeResult.changes, rows: writeResult.rows };
      } else if (ast.kind === "group") {
        throw new AppError(
          "E_UNSUPPORTED",
          "GROUP requires SQL lowering; runtime fallback disabled",
          ast.pos.line,
          ast.pos.column,
        );
      } else {
        // SELECT / SELECT-expr / SELECT-free / FOR execute off the gelIR SQL
        // artifact. select_free requires a complete single-statement lowering.
        if (ast.kind === "select_free" && classifyExecutionStrategy(ast, sqlArtifact, schema) === "reject") {
          throw new AppError(
            "E_UNSUPPORTED",
            "select_free requires SQL lowering; runtime fallback disabled",
            ast.pos.line,
            ast.pos.column,
          );
        }
        result = { kind: "select", rows: runGelSelectSQL(db, schema, compiled.gelIr, context, sqlArtifact) };
      }

      const currentOverlays = extractOverlays(ir);
      if (ast.kind !== "select" && ast.kind !== "select_free") {
        overlays.push(...currentOverlays);
      }

      traces.push({
        ast,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
        result,
      });
    }

    // Collapse the per-INSERT traces produced from one FOR-INSERT into a single
    // trace whose result is the set of every inserted object — that's what the
    // `FOR … INSERT …` expression returns.
    const mergedTraces: QueryExecutionTrace[] = [];
    for (let i = 0; i < traces.length; i += 1) {
      const groupId = (traces[i].ast as { __forGroup?: number }).__forGroup;
      if (groupId === undefined) {
        mergedTraces.push(traces[i]);
        continue;
      }
      const groupRows: unknown[] = [];
      let changes = 0;
      let j = i;
      // UNLESS CONFLICT inserts have value-dependent results (conflict → empty
      // / ELSE branch) that this engine doesn't yet fully detect cross-type;
      // don't aggregate those — keep the legacy single-trace result so their
      // observable behaviour is unchanged.
      let hasConflict = false;
      for (; j < traces.length && (traces[j].ast as { __forGroup?: number }).__forGroup === groupId; j += 1) {
        const r = traces[j].result as { rows?: unknown[]; changes?: number };
        if ((traces[j].ast as { conflict?: unknown }).conflict !== undefined) hasConflict = true;
        if (Array.isArray(r.rows)) groupRows.push(...r.rows);
        changes += r.changes ?? 0;
      }
      mergedTraces.push(hasConflict
        ? traces[j - 1]
        : {
            ...traces[j - 1],
            result: { kind: "insert", changes, rows: groupRows },
          });
      i = j - 1;
    }

    return {
      traces: mergedTraces,
      result: mergedTraces.length > 0 ? mergedTraces[mergedTraces.length - 1].result : { kind: "insert", changes: 0 },
    };
  } catch (err) {
    throw asAppError(decorateErrorWithUnsupportedTag(err, script));
  }
};

const substituteBindingInFreeObjectExpr = (
  expr: FreeObjectExpr,
  variable: string,
  value: ScalarValue,
): FreeObjectExpr => {
  const rec = (e: FreeObjectExpr): FreeObjectExpr => substituteBindingInFreeObjectExpr(e, variable, value);
  switch (expr.kind) {
    case "binding_ref":
      return expr.name === variable ? { kind: "literal", value } : expr;
    case "field_access":
      return { ...expr, expr: rec(expr.expr) };
    case "index_access":
      return { ...expr, expr: rec(expr.expr) };
    case "compare":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "math":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "logical":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "and":
    case "or":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "not":
    case "unary":
    case "exists":
    case "distinct":
    case "cast":
      return { ...expr, expr: rec(expr.expr) };
    case "concat":
      return { ...expr, parts: expr.parts.map((p) => rec(p)) };
    case "tuple":
      return { ...expr, values: expr.values.map((v) => rec(v)) };
    case "if_else":
      return { ...expr, thenExpr: rec(expr.thenExpr), condition: rec(expr.condition), elseExpr: rec(expr.elseExpr) };
    case "coalesce":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    default:
      return expr;
  }
};

const substituteBindingInASTFilter = (
  filter: FilterExpr,
  variable: string,
  value: ScalarValue,
): FilterExpr => {
  if (filter.kind === "predicate") {
    const fv = filter.value;
    if (typeof fv === "object" && fv !== null && "kind" in fv && fv.kind === "binding_ref" && fv.name === variable) {
      return { ...filter, value };
    }
    return filter;
  }
  if (filter.kind === "and" || filter.kind === "or") {
    return {
      ...filter,
      left: substituteBindingInASTFilter(filter.left, variable, value),
      right: substituteBindingInASTFilter(filter.right, variable, value),
    };
  }
  if (filter.kind === "not") {
    return {
      ...filter,
      expr: substituteBindingInASTFilter(filter.expr, variable, value),
    };
  }
  if (filter.kind === "free_expr") {
    return { ...filter, expr: substituteBindingInFreeObjectExpr(filter.expr, variable, value) };
  }
  return filter;
};

// Convert a JS value materialised at runtime (e.g. a row from runGroupIR)
// back into a FreeObjectExpr AST so it can be inlined as a synthetic WITH
// binding value. Objects become free_object_constructor, arrays become
// set_expr of nested constructors/literals, scalars become literal nodes.
const jsValueToFreeObjectExpr = (
  value: unknown,
): FreeObjectExpr => {
  if (value === null || value === undefined) {
    return { kind: "literal", value: null };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", value: value as ScalarValue };
  }
  if (typeof value === "bigint") {
    return { kind: "literal", value: Number(value) };
  }
  if (Array.isArray(value)) {
    return { kind: "set_expr", values: value.map(jsValueToFreeObjectExpr) };
  }
  if (typeof value === "object") {
    return {
      kind: "free_object_constructor",
      entries: Object.entries(value as Record<string, unknown>).map(([name, val]) => ({
        name,
        expr: jsValueToFreeObjectExpr(val),
      })),
    };
  }
  return { kind: "literal", value: null };
};

// Run a compiled GROUP statement: prefer the lowered single-statement SQL
// (compileGroupStmtToSQL), falling back to the runtime grouper for the
// features the SQL stage doesn't lower. Group rows from both paths share the
// `{ key, grouping, elements }` row contract.
const runCompiledGroup = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  compiled: { ir: IRStatement | undefined; sql: SQLArtifact; gelIr?: unknown },
  context: SecurityContext,
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  if (lowersToSingleSql(compiled.sql)) {
    return runGelSelectSQL(
      db,
      schema,
      compiled.gelIr as Parameters<typeof runGelSelectSQL>[2],
      context,
      compiled.sql,
    ) as Record<string, unknown>[];
  }
  throw new AppError("E_UNSUPPORTED", "GROUP statement could not be lowered to SQL");
};

// Walk an AST and pre-evaluate any WITH binding whose value is a GROUP.
// Returns the rewritten AST (with the GROUP results inlined) or the original
// when nothing needed pre-evaluation.
const preEvaluateGroupBindings = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  context: SecurityContext,
): Statement => {
  if (!ast.with || ast.with.length === 0) return ast;
  const isGroupBindingValue = (value: WithBinding["value"]): boolean =>
    value.kind === "subquery_expr"
    && (value.expr.kind === "group_expr"
      || (value.expr.kind === "select_expr_subquery" && value.expr.expr.kind === "group_expr"));
  if (!ast.with.some((binding) => isGroupBindingValue(binding.value))) return ast;
  // The gelIR pipeline lowers WITH-bound groups directly (group_rows in
  // compileGroupExprSet); pre-evaluating into literal AST rows is only the
  // fallback for statements it can't lower. The compile is cached, so the
  // engine's own compile of the unchanged AST reuses it.
  try {
    const compiled = getCompilerService().compile(schema, ast, {
      globals: context.globals, params: context.params,
      target: resolvedRuntimeTarget(context, db),
    });
    if (lowersToSingleSql(compiled.sql)) {
      return ast;
    }
  } catch (e) {
    // Fall through to pre-evaluation on compile failure. The compile
    // pipeline signals unsupported/unlowerable statements with AppErrors
    // (E_UNSUPPORTED/E_SEMANTIC/...); anything else is a bug — rethrow.
    if (!isQueryFailure(e)) throw e;
  }
  let rewrote = false;
  const newWith = ast.with.map((binding) => {
    const value = binding.value;
    let groupExpr: Extract<FreeObjectExpr, { kind: "group_expr" }> | undefined;
    if (value.kind === "subquery_expr") {
      if (value.expr.kind === "group_expr") {
        groupExpr = value.expr;
      } else if (value.expr.kind === "select_expr_subquery" && value.expr.expr.kind === "group_expr") {
        groupExpr = value.expr.expr;
      }
    }
    if (!groupExpr) return binding;
    const groupStatement: Extract<Statement, { kind: "group" }> = {
      kind: "group",
      source: groupExpr.source,
      using: groupExpr.using,
      by: groupExpr.by,
      // Exclude the binding being evaluated — it refers to *this* group, so
      // threading it into the group's own WITH makes its source resolve to the
      // self-referential alias ('Unknown type g') instead of the real source.
      with: ast.with?.filter((b) => b.name !== binding.name),
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      pos: ast.pos,
    };
    try {
      const compiled = getCompilerService().compile(schema, groupStatement, {
        globals: context.globals, params: context.params,
        target: resolvedRuntimeTarget(context, db),
      });
      if (groupStatement.kind !== "group") return binding;
      const rows = runCompiledGroup(db, schema, compiled, context, []);
      rewrote = true;
      return {
        name: binding.name,
        value: {
          kind: "subquery_expr" as const,
          expr: { kind: "set_expr" as const, values: rows.map(jsValueToFreeObjectExpr) },
        },
      };
    } catch (e) {
      // Groups the IR pipeline can't compile/run keep their original
      // binding and are handled downstream; only query failures (tagged
      // AppErrors) may be swallowed — anything else is an engine bug.
      if (!isQueryFailure(e)) throw e;
      return binding;
    }
  });
  if (!rewrote) return ast;
  return { ...ast, with: newWith };
};

const unwrapGroupIteratorExpr = (
  expr: FreeObjectExpr,
): Extract<FreeObjectExpr, { kind: "group_expr" }> | undefined => {
  let cursor: FreeObjectExpr = expr;
  if (cursor.kind === "select_expr_subquery") {
    cursor = cursor.expr;
  }
  if (cursor.kind === "group_expr") {
    return cursor;
  }
  return undefined;
};

// Does an AST subtree contain a `mutation_expr` anywhere?
const nodeContainsMutationExpr = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(nodeContainsMutationExpr);
  if (node === null || typeof node !== "object") return false;
  if ((node as { kind?: unknown }).kind === "mutation_expr") return true;
  return Object.values(node).some(nodeContainsMutationExpr);
};

// `FOR v IN <scalar-iter> UNION (<expr containing INSERT/UPDATE/DELETE>)` where
// the body is a value expression (a tuple, a shaped select, a nested FOR, …)
// rather than a bare INSERT. Each iteration must run its embedded DML once and
// thread the produced object(s) into the surrounding expression. We bind the
// loop variable as a WITH literal and run the body through the ordinary
// single-statement pipeline (which executes embedded DML via
// preExecuteMutationExprsInSelectExpr / DML bindings), then concatenate the
// per-iteration rows. Nested FORs recurse. Returns undefined when the body
// can't be handled this way (no embedded DML, non-scalar iterator).
const executeForWithDmlBodyExpr = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: ForStatement,
  context: SecurityContext,
  accumWith: WithBinding[],
): unknown[] | undefined => {
  const body = ast.body;
  // Only handle bodies that are value expressions carrying embedded DML.
  if (body.kind !== "select_expr") return undefined;
  if (!nodeContainsMutationExpr(body.expr)) return undefined;

  // Object-set iterator (`FOR x IN {Subordinate, Subordinate} UNION ((x {…}),
  // (INSERT … subject := x)))`): materialise the iterated objects (with the
  // fields the body reads off `x`), then run the body once per object with `x`
  // bound to a by-id select (so `subject := x` resolves) and its read fields
  // substituted as literals. The embedded INSERT runs through the standard path
  // each iteration; the tuple/shape is returned alongside. The FOR iterates
  // each set element separately (`{T, T}` yields each extent twice).
  const isObjectIterator = ast.iteratorExpr.kind === "select_expr_subquery"
    || ast.iteratorExpr.kind === "select"
    || ast.iteratorExpr.kind === "set_expr";
  if (accumWith.length === 0 && isObjectIterator) {
    const setVals = ast.iteratorExpr.kind === "set_expr"
      ? (ast.iteratorExpr as { values: Array<{ kind?: string }> }).values
      : [ast.iteratorExpr as { kind?: string }];
    const allObjectSelects = setVals.length > 0
      && setVals.every((v) => v?.kind === "select" || v?.kind === "select_expr_subquery");
    if (allObjectSelects) {
      const referencedFields = collectBindingRefFields(body.expr, ast.variable);
      const forStatementWith0 = ((ast as { with?: WithBinding[] }).with ?? [])
        .filter((b) => b.name !== ast.variable);
      const out: unknown[] = [];
      for (const selNode of setVals) {
        const rows = evaluateForObjectIteratorRows(
          selNode as ForStatement["iteratorExpr"], referencedFields, schema, db, context,
        );
        if (rows === undefined) return undefined;
        const iterSel = (selNode as { kind?: string; expr?: { typeName?: string }; typeName?: string });
        const iterTypeName = iterSel.kind === "select_expr_subquery" ? iterSel.expr?.typeName : iterSel.typeName;
        for (const row of rows) {
          let substituted = substituteBindingRefFields(body.expr, ast.variable, row);
          const objBinding: WithBinding[] = typeof row.id === "string" && iterTypeName
            ? [{
                name: ast.variable,
                value: { kind: "subquery_expr", expr: { kind: "select_expr_subquery", expr: chainByIdSelect({ typeName: iterTypeName, ids: [row.id as string] }) } },
              } as WithBinding]
            : [];
          // A coalesce / nested select inside the body reads the loop variable
          // by name (`.subject = sub`); the runtime coalesce evaluator compiles
          // those nested selects standalone (without the outer WITH), so push
          // the loop-variable binding onto each nested select's own WITH clause.
          if (objBinding.length > 0) {
            substituted = attachLoopVarToNestedSelects(substituted, objBinding[0]);
          }
          const iterWith = [...forStatementWith0, ...objBinding];
          const bodyStmt: Statement = {
            kind: "select_expr",
            expr: substituted as FreeObjectExpr,
            orderBy: body.orderBy,
            with: iterWith.length > 0 ? iterWith : undefined,
            withModule: ast.withModule,
            withModuleAliases: ast.withModuleAliases,
            pos: ast.pos,
          } as unknown as Statement;
          const trace = executeQueryWithTraceImpl(db, schema, "", context, bodyStmt);
          if (trace.result.kind === "select" && trace.result.rows) out.push(...trace.result.rows);
        }
      }
      return out;
    }
  }

  // Scalar iterator values, evaluated with any enclosing loop bindings in
  // scope (so a nested FOR's iterator may reference outer variables).
  let iterValues: unknown[];
  if (accumWith.length > 0) {
    const viaSql = evaluateForScalarIteratorViaSql(ast, schema, db, context, accumWith);
    iterValues = viaSql ?? [];
  } else {
    try {
      iterValues = ast.iteratorExpr.kind === "set_literal"
        ? ast.iteratorExpr.values
        : evaluateForIteratorValues(ast.iteratorExpr, schema, db, context);
    } catch {
      iterValues = [];
    }
  }
  if (!iterValues.every((v) => v === null || isScalarValue(v))) return undefined;
  const effective: (ScalarValue | null)[] = iterValues.length === 0 && ast.optional
    ? [null]
    : (iterValues as (ScalarValue | null)[]);

  const forStatementWith = ((ast as { with?: WithBinding[] }).with ?? [])
    .filter((b) => b.name !== ast.variable);

  const out: unknown[] = [];
  for (const value of effective) {
    const varBinding: WithBinding[] = value !== null && isScalarValue(value)
      ? [{ name: ast.variable, value: { kind: "literal", value } } as WithBinding]
      : [];
    const iterWith = [...accumWith, ...forStatementWith, ...varBinding];

    // A nested FOR (`FOR a … UNION (FOR b … UNION (…INSERT…))`) recurses with
    // the accumulated bindings; its body's inner FOR is wrapped in select_expr.
    const innerForExpr = body.expr.kind === "for_expr" ? body.expr : undefined;
    if (innerForExpr) {
      const innerForAst: ForStatement = {
        kind: "for",
        variable: innerForExpr.variable,
        iteratorExpr: innerForExpr.iterator as ForStatement["iteratorExpr"],
        optional: innerForExpr.optional ?? false,
        body: { kind: "select_expr", expr: innerForExpr.body } as ForStatement["body"],
        withModule: ast.withModule,
        withModuleAliases: ast.withModuleAliases,
        pos: ast.pos,
      } as ForStatement;
      const innerRows = executeForWithDmlBodyExpr(db, schema, innerForAst, context, iterWith);
      if (innerRows === undefined) return undefined;
      out.push(...innerRows);
      continue;
    }

    // Run the body once with the loop variable(s) bound as literals. The body
    // is a select_expr whose embedded DML executes through the standard path.
    const bodyStmt: Statement = {
      kind: "select_expr",
      expr: body.expr,
      orderBy: body.orderBy,
      with: iterWith.length > 0 ? iterWith : undefined,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      pos: ast.pos,
    } as unknown as Statement;
    const trace = executeQueryWithTraceImpl(db, schema, "", context, bodyStmt);
    if (trace.result.kind === "select" && trace.result.rows) {
      out.push(...trace.result.rows);
    }
  }
  return out;
};

const executeForLoop = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: ForStatement,
  context: SecurityContext,
  runtimeTarget: RuntimeTarget,
  compilerService: ReturnType<typeof getCompilerService>,
  overlays: OverlayIR[],
  traces: QueryExecutionTrace[],
): void => {
  const iteratorExpr = ast.iteratorExpr;
  const body = ast.body;

  // `FOR g IN (GROUP …) UNION (…body…)` — run the GROUP, then evaluate the
  // body once per group row with `g` bound to that row. Also accept the iterator
  // wrapped in a no-op SELECT subquery (`FOR g IN (SELECT (GROUP …)) UNION …`).
  const groupIterator = unwrapGroupIteratorExpr(iteratorExpr);
  if (groupIterator && body.kind === "select_expr") {
    const groupStatement = {
      kind: "group" as const,
      source: groupIterator.source,
      using: groupIterator.using,
      by: groupIterator.by,
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      pos: ast.pos,
    };
    const compiled = compilerService.compile(schema, groupStatement, {
      overlays,
      globals: context.globals, params: context.params,
      target: runtimeTarget,
    });
    const ir = compiled.ir;
    const sqlArtifact = compiled.sql;
    const sqlTrail: SQLArtifact[] = [sqlArtifact];
    const groupRows = groupStatement.kind === "group"
      ? runCompiledGroup(db, schema, compiled, context, sqlTrail)
      : [];
    const outputRows = groupRows.flatMap((groupRow): unknown[] => {
      const bindings = new Map<string, unknown>([[ast.variable, groupRow]]);
      const result = evalGroupRowExpr(body.expr, groupRow, bindings, { db, schema });
      // A body that produces a SET (array) — e.g. `FOR g IN GROUP … UNION (…)`
      // bodies or nested FOR — unwinds into one output row per item. A scalar
      // body (`UNION count(…)`) yields that scalar directly: the result set is
      // a set of scalars, matching how the SQL path materialises a bare `value`
      // column rather than wrapping it in `{ value: … }`.
      if (Array.isArray(result)) {
        return result;
      }
      if (result === null || result === undefined) {
        return [];
      }
      return [result];
    });
    traces.push({
      ast,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: extractOverlays(ir),
      result: { kind: "select", rows: outputRows },
    });
    return;
  }

  if (body.kind === "insert") {
    let iteratorValues = evaluateForIteratorValues(iteratorExpr, schema, db, context);
    if (ast.optional && iteratorValues.length === 0) {
      iteratorValues = [null];
    }
    const insertedRows: Record<string, unknown>[] = [];
    let lastTraceFields: Omit<QueryExecutionTrace, "result"> | undefined;
    // Shared across all iterations so snapshot-valued expression defaults
    // (`default := (SELECT count(T))`) are evaluated once against the
    // pre-statement state and reused for every inserted row.
    const snapshotDefaultCache = new Map<string, ScalarValue>();
    for (const value of iteratorValues) {
      const insertValues: Record<string, InsertValue> = {};
      for (const [key, v] of Object.entries(body.values)) {
        if (typeof v === "object" && v !== null && "kind" in v && v.kind === "binding_ref" && v.name === ast.variable) {
          insertValues[key] = value as InsertValue;
        } else {
          insertValues[key] = v;
        }
      }

      const insertAst: InsertStatement = {
        ...body,
        with: isScalarValue(value)
          ? [
              ...(body.with ?? []).filter((binding) => binding.name !== ast.variable),
              { name: ast.variable, value: { kind: "literal", value } },
            ]
          : body.with,
        values: insertValues,
      };

      const subjectTypeName = insertAst.typeName.includes("::")
        ? insertAst.typeName
        : `${insertAst.withModule ?? ast.withModule ?? "default"}::${insertAst.typeName}`;
      const subjectType = schema.getType(subjectTypeName);
      if (!subjectType) {
        throw new AppError("E_SEMANTIC", `Unknown type '${insertAst.typeName}'`, ast.pos.line, ast.pos.column);
      }

      const compiled = compilerService.compile(schema, insertAst, { overlays, globals: context.globals, params: context.params, target: runtimeTarget });
      const ir = compiled.ir;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const writeResult = runWriteWithAccessPolicies(db, schema, insertAst, ir, sqlArtifact, subjectType, context, snapshotDefaultCache);

      const currentOverlays = extractOverlays(ir);
      if (ir) {
        overlays.push(...currentOverlays);
      }

      for (let i = 0; i < writeResult.changes; i += 1) {
        insertedRows.push({});
      }

      lastTraceFields = {
        ast: insertAst,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
      };
    }
    if (lastTraceFields) {
      traces.push({
        ...lastTraceFields,
        result: { kind: "select", rows: insertedRows },
      });
    }
    return;
  }

  if (body.kind === "select_expr") {
    const syntheticAst: SelectExprStatement = {
      kind: "select_expr",
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      expr: {
        kind: "for_expr",
        variable: ast.variable,
        iterator: iteratorExpr,
        body: body.expr,
        optional: ast.optional,
      },
      orderBy: body.orderBy,
      pos: ast.pos,
    };

    // The compile-to-SQL path can't lower bodies that need the AST runtime
    // (UDF calls, alias subqueries with link-property shapes, etc.) — it
    // emits stub SQL that returns a single NULL row. Try the AST evaluator
    // first; it iterates per-binding in JS and routes UDF calls through
    // executeFunctionCall. `tryRuntimeSelectExprEvaluationAst` returns
    // undefined when the body doesn't need runtime eval, so plain FOR loops
    // still fall through to the SQL path below.
    const compiled = compilerService.compile(schema, syntheticAst, { overlays, globals: context.globals, params: context.params, target: runtimeTarget });
    const ir = compiled.ir;
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const sqlTrail: SQLArtifact[] = [sqlArtifact];

    // A FOR over GROUP rows lowers fully to SQL (group_rows iterator +
    // per-row body) — when that artifact is complete, it wins over the AST
    // evaluator, which doesn't model group rows.
    const iteratesGroupRows = iteratorExpr.kind === "group_expr"
      || (iteratorExpr.kind === "select_expr_subquery" && iteratorExpr.expr.kind === "group_expr");
    const sqlIsComplete = lowersToSingleSql(sqlArtifact);
    const runtimeResult = iteratesGroupRows && sqlIsComplete
      ? undefined
      : tryRuntimeSelectExprEvaluationAst(db, schema, syntheticAst, context);

    const rows = runtimeResult?.kind === "select"
      ? runtimeResult.rows
      : syntheticAst.kind === "select_expr"
        ? runGelSelectSQL(db, schema, compiled.gelIr, context, sqlArtifact)
        : [];

    const currentOverlays = extractOverlays(ir);
    traces.push({
      ast: syntheticAst,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: currentOverlays,
      result: { kind: "select", rows },
    });
    return;
  }

  if (body.kind === "select_free") {
    const syntheticAst: SelectExprStatement = {
      kind: "select_expr",
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      expr: {
        kind: "for_expr",
        variable: ast.variable,
        iterator: iteratorExpr,
        body: {
          kind: "select_expr_subquery",
          alias: undefined,
          expr: {
            kind: "set_expr",
            values: body.entries.map((entry) => ({
              kind: "select_expr_subquery",
              alias: entry.name,
              expr: entry.expr,
            })),
          },
        },
        optional: ast.optional,
      },
      pos: ast.pos,
    };

    const compiled = compilerService.compile(schema, syntheticAst, { overlays, globals: context.globals, params: context.params, target: runtimeTarget });
    const ir = compiled.ir;
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const sqlTrail: SQLArtifact[] = [sqlArtifact];

    const rows = syntheticAst.kind === "select_expr"
      ? runGelSelectSQL(db, schema, compiled.gelIr, context, sqlArtifact)
      : [];

    const currentOverlays = extractOverlays(ir);
    traces.push({
      ast: syntheticAst,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: currentOverlays,
      result: { kind: "select", rows },
    });
    return;
  }

  {
    // A nested-FOR body that reaches here (rather than the INSERT-expansion
    // path) isn't a SELECT-producing body this runtime fallback can bind.
    if (body.kind === "for") {
      throw new AppError(
        "E_UNSUPPORTED",
        "FOR requires SQL lowering; runtime fallback disabled",
        ast.pos.line,
        ast.pos.column,
      );
    }
    const selectBody = body;
    let iteratorValues = evaluateForIteratorValues(iteratorExpr, schema, db, context);
    if (ast.optional && iteratorValues.length === 0) {
      iteratorValues = [null];
    }
    const allRows: Record<string, unknown>[] = [];
    for (const value of iteratorValues) {
      const selectAst = bindSelectAstVariable(selectBody, ast.variable, value);

      const compiled = compilerService.compile(schema, selectAst, { overlays, globals: context.globals, params: context.params, target: runtimeTarget });
      const ir = compiled.ir;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const rows = runGelSelectSQL(db, schema, compiled.gelIr, context, sqlArtifact) as Record<string, unknown>[];
      allRows.push(...rows);

      const currentOverlays = extractOverlays(ir);
      overlays.push(...currentOverlays);

      traces.push({
        ast: selectAst,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
        result: { kind: "select" as const, rows: allRows },
      });
    }
  }
};

const evaluateForIteratorValues = (
  expr: ForStatement["iteratorExpr"],
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
): unknown[] => {
  if (expr.kind === "literal") {
    return [expr.value];
  }

  if (expr.kind === "set_literal") {
    return expr.values;
  }

  if (expr.kind === "select") {
    const shape = expr.shape.length > 0 ? [...expr.shape] : [{ kind: "field", name: "id" } as const];
    const hasId = shape.some((element) => element.kind === "field" && element.name === "id");
    if (!hasId) {
      shape.unshift({ kind: "field", name: "id" });
    }

    const selectAst: SelectStatement = {
      kind: "select",
      typeName: expr.typeName,
      shape,
      fields: fieldsFromShape(shape),
      filter: expr.clauses.filter,
      orderBy: expr.clauses.orderBy,
      limit: expr.clauses.limit,
      offset: expr.clauses.offset,
      with: expr.clauses._withBindings,
      withModule: expr.clauses._withModule,
      withModuleAliases: expr.clauses._withModuleAliases,
      pos: { line: 1, column: 1 },
    };

    const compiler = getCompilerService();
    const compiled = compiler.compile(schema, selectAst, { globals: context.globals, params: context.params, target: resolvedRuntimeTarget(context, db) });
    assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
    if (compiled.ir !== undefined) {
      return [];
    }

    return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
  }

  if (expr.kind === "mutation_expr") {
    return executeMutationBinding(db, schema, expr.statement, context);
  }

  if (expr.kind === "distinct") {
    const values = evaluateForIteratorValues(expr.expr as ForStatement["iteratorExpr"], schema, db, context);
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of values) {
      const key = JSON.stringify(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  if (expr.kind === "function_call") {
    const args: RuntimeFunctionArg[] = expr.call.args.map((arg) => {
      if (arg.kind === "literal") return arg.value;
      if (arg.kind === "set_literal") return { kind: "array", values: arg.values };
      if (arg.kind === "array_literal") return { kind: "array", values: arg.values };
      // Walk into nested `kind: "expr"` wrappers that the parser inserts
      // around an argument expression — e.g. `enumerate({…})` wraps the set
      // literal in `{kind: "expr", expr: set_literal(...)}` rather than
      // surfacing `kind: "set_literal"` directly.
      if (arg.kind === "expr" && (arg as { kind: "expr"; expr: FreeObjectExpr }).expr) {
        const inner = (arg as { kind: "expr"; expr: FreeObjectExpr }).expr;
        if (inner.kind === "set_literal") return { kind: "array", values: inner.values };
        if (inner.kind === "literal") return inner.value;
      }
      return null;
    });
    const qualifiedName = expr.call.name.includes("::")
      ? expr.call.name
      : `default::${expr.call.name}`;
    const fnResult = executeFunctionCall(schema, db, context, qualifiedName, args);
    return Array.isArray(fnResult) ? fnResult : [fnResult];
  }

  if (expr.kind === "concat") {
    let results: unknown[] = [""];
    for (const part of expr.parts) {
      const partValues = evaluateForIteratorValues(part as ForStatement["iteratorExpr"], schema, db, context);
      const next: unknown[] = [];
      for (const left of results) {
        for (const right of partValues) {
          if (typeof left === "string" && typeof right === "string") {
            next.push(left + right);
          } else if (left === null || left === undefined) {
            next.push(right);
          } else if (right === null || right === undefined) {
            next.push(left);
          } else {
            next.push(`${left}${right}`);
          }
        }
      }
      results = next;
    }
    return results.length > 0 ? results : [null];
  }

  if (expr.kind === "set_expr") {
    // Each value contributes its set of evaluations; flatten them into the
    // FOR iterator output. Used by `FOR y in {<str>random(), …}` and
    // similar set-comprehension iterators.
    const out: unknown[] = [];
    for (const value of (expr as { values: FreeObjectExpr[] }).values) {
      out.push(...evaluateForIteratorValues(value as ForStatement["iteratorExpr"], schema, db, context));
    }
    return out;
  }

  if (expr.kind === "cast") {
    const inner = evaluateForIteratorValues((expr as { expr: FreeObjectExpr }).expr as ForStatement["iteratorExpr"], schema, db, context);
    const stripModule = (t: string): string => t.startsWith("std::") ? t.slice(5) : t;
    const target = stripModule((expr as { castType?: string }).castType ?? "").toLowerCase();
    return inner.map((value) => {
      if (value === null || value === undefined) return value;
      if (target === "str") return String(value);
      if (target === "int16" || target === "int32" || target === "int64") {
        const n = typeof value === "number" ? Math.trunc(value) : Number(value as number);
        return Number.isFinite(n) ? n : value;
      }
      if (target === "float32" || target === "float64") {
        return typeof value === "number" ? value : Number(value as number);
      }
      if (target === "bool") return Boolean(value);
      return value;
    });
  }

  return [null];
};

/**
 * Tries to evaluate a FOR iterator expression to a flat list of scalar values.
 * Returns `undefined` when the iterator isn't reducible to scalars at this
 * stage (e.g. it depends on object selects whose ids haven't been allocated
 * yet). Used by the top-level FOR-INSERT desugar so iterators like
 * `{'A','B'} ++ {'1','2'}` lower through the normal IR/SQL pipeline.
 */
const tryEvaluateScalarIteratorValues = (
  expr: ForStatement["iteratorExpr"],
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
): unknown[] | undefined => {
  switch (expr.kind) {
    case "literal":
    case "set_literal":
    case "set_expr":
    case "concat":
    case "function_call":
    case "distinct":
    case "cast":
      break;
    default:
      return undefined;
  }
  let values: unknown[];
  try {
    values = evaluateForIteratorValues(expr, schema, db, context);
  } catch (e) {
    // Probe: iterators the interpreter can't reduce here go through the
    // normal pipeline instead; only query failures (tagged AppErrors) may
    // be swallowed — anything else is an engine bug.
    if (!isQueryFailure(e)) throw e;
    return undefined;
  }
  for (const value of values) {
    if (value !== null && !isScalarValue(value as unknown)) {
      return undefined;
    }
  }
  return values;
};

const bindSelectAstVariable = (
  body: SelectStatement,
  variable: string,
  value: unknown,
): SelectStatement => {
  // Tuple iter values (e.g. each row of `enumerate({…})` arrives as
  // `[index, item]`). Substitute `v.0` / `v.1` etc. with the corresponding
  // tuple element BEFORE the scalar coercion below collapses the array to a
  // JSON string. Without this, link-property shape entries like
  // `@list_order := v.0` lose the tuple-index resolution.
  if (Array.isArray(value)) {
    const rewriteShape = (shape: SelectStatement["shape"]): SelectStatement["shape"] =>
      shape.map((entry) => {
        if (entry.kind === "computed") {
          return { ...entry, expr: substituteTupleIndexAccess(entry.expr, variable, value) };
        }
        return entry;
      });
    const rewriteFilter = (f: FilterExpr): FilterExpr => {
      if (f.kind === "free_expr") {
        return { ...f, expr: substituteTupleIndexAccess(f.expr, variable, value) };
      }
      if (f.kind === "and" || f.kind === "or") {
        return { ...f, left: rewriteFilter(f.left), right: rewriteFilter(f.right) };
      }
      if (f.kind === "not") {
        return { ...f, expr: rewriteFilter(f.expr) };
      }
      return f;
    };
    return {
      ...body,
      shape: rewriteShape(body.shape),
      filter: body.filter === undefined ? undefined : rewriteFilter(body.filter),
    };
  }

  const scalar = coerceUnknownToScalar(value);
  if (!scalar) {
    return {
      ...body,
      filter: body.filter,
    };
  }

  const existing = (body.with ?? []).filter((binding) => binding.name !== variable);
  return {
    ...body,
    with: [...existing, { name: variable, value: { kind: "literal", value: scalar } }],
    filter: body.filter ? substituteBindingInASTFilter(body.filter, variable, scalar) : undefined,
  };
};

// Walk a FreeObjectExpr replacing `index_access(binding_ref(variable), N)`
// with the Nth element of `tuple`. Also replaces a bare `binding_ref(variable)`
// reference with a literal JSON dump of the tuple so callers that bind a
// non-tuple-index reference still get a usable scalar.
// Overloaded: shape-computed entries pass a `ComputedExpr` (whose
// `select_expr` wrapper carries the FreeObjectExpr to rewrite); filters pass
// a bare `FreeObjectExpr`. Kinds outside the handled cases pass through
// unchanged either way.
function substituteTupleIndexAccess(
  expr: FreeObjectExpr,
  variable: string,
  tuple: unknown[],
): FreeObjectExpr;
function substituteTupleIndexAccess(
  expr: ComputedExpr,
  variable: string,
  tuple: unknown[],
): ComputedExpr;
function substituteTupleIndexAccess(
  expr: FreeObjectExpr | ComputedExpr,
  variable: string,
  tuple: unknown[],
): FreeObjectExpr | ComputedExpr {
  const literalOf = (value: unknown): FreeObjectExpr => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { kind: "literal", value };
    }
    if (value === null || value === undefined) {
      return { kind: "literal", value: null };
    }
    // Fall back to a JSON string for nested compound values — keeps the
    // existing scalar-coercion semantics for things outside `v.0`/`v.1`.
    return { kind: "literal", value: JSON.stringify(value) };
  };
  const rec = (e: FreeObjectExpr): FreeObjectExpr => substituteTupleIndexAccess(e, variable, tuple);
  switch (expr.kind) {
    case "index_access":
      if (expr.expr.kind === "binding_ref" && expr.expr.name === variable && typeof expr.index === "number") {
        return literalOf(tuple[expr.index]);
      }
      return { ...expr, expr: rec(expr.expr) };
    case "field_access":
      return { ...expr, expr: rec(expr.expr) };
    case "binding_ref":
      return expr.name === variable ? literalOf(tuple) : expr;
    case "compare":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "math":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "logical":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "and":
    case "or":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "not":
    case "unary":
    case "exists":
    case "distinct":
    case "cast":
      return { ...expr, expr: rec(expr.expr) };
    case "concat":
      return { ...expr, parts: expr.parts.map(rec) };
    case "tuple":
      return { ...expr, values: expr.values.map(rec) };
    case "if_else":
      return { ...expr, thenExpr: rec(expr.thenExpr), condition: rec(expr.condition), elseExpr: rec(expr.elseExpr) };
    case "coalesce":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "select_expr":
    case "select_expr_subquery":
      return { ...expr, expr: rec(expr.expr) };
    default:
      return expr;
  }
}

const ensureSelectAstHasId = (ast: SelectStatement): SelectStatement => {
  const hasId = ast.shape.some((element) => element.kind === "field" && element.name === "id");
  if (hasId) {
    return ast;
  }

  const shape = [{ kind: "field", name: "id" } as const, ...ast.shape];
  const fields = ast.fields.includes("id") ? ast.fields : ["id", ...ast.fields];
  return {
    ...ast,
    shape,
    fields,
  };
};

const coerceUnknownToScalar = (value: unknown): ScalarValue | undefined => {
  if (isScalarValue(value)) {
    return value;
  }

  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    try {
      return JSON.stringify(value);
    } catch {
      // JSON.stringify only throws for circular/BigInt-bearing structures —
      // by this function's contract those are "not coercible" (undefined).
      return undefined;
    }
  }

  return undefined;
};

// Evaluates a select_expr shape-entry value (a FreeObjectExpr in the AST)
// against the current row. Only handles the polymorphic path pattern
// `[is T].field[.subfield…]` rooted at the implicit subject — used by
// computed shape entries like `x := [is OtherType].dest.name`. Anything
// outside that pattern returns null so the caller can supply its own
// fallback.
// Sentinel marker for an empty set during free-expression evaluation. In
// EdgeQL semantics, `{}` and a NULL-valued field are both empty sets.
const SHAPE_EMPTY_SET = Symbol("empty_set");

const flattenShapeValues = (value: unknown): unknown[] => {
  if (value === SHAPE_EMPTY_SET) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenShapeValues(item));
  }
  return [value];
};

const evaluateFreeExprForShape = (
  expr: FreeObjectExpr,
  row: Record<string, unknown>,
  resolveCurrentField?: (field: string) => unknown,
  evalFunctionCall?: (functionName: string, args: RuntimeFunctionArg[]) => unknown,
): unknown => {
  const rec = (e: FreeObjectExpr): unknown => evaluateFreeExprForShape(e, row, resolveCurrentField, evalFunctionCall);
  if (expr.kind === "literal") {
    return expr.value;
  }
  if (expr.kind === "field_access") {
    if (!expr.expr || (expr.expr.kind !== "select" && expr.expr.kind !== "current_item" && expr.expr.kind !== "binding_ref")) {
      // Nested field accesses (e.g. Issue.x.y) are not supported here yet.
      return undefined;
    }
    const resolved = resolveCurrentField?.(expr.field);
    if (resolved !== undefined) {
      return resolved === null ? SHAPE_EMPTY_SET : resolved;
    }
    const value = row[expr.field];
    if (value === undefined || value === null) return SHAPE_EMPTY_SET;
    return value;
  }
  if (expr.kind === "function_call") {
    if (!evalFunctionCall) return undefined;
    const argValues: RuntimeFunctionArg[] = [];
    for (const arg of expr.call.args) {
      if (arg.kind === "literal") {
        argValues.push(arg.value);
        continue;
      }
      if (arg.kind === "set_literal") {
        argValues.push({ kind: "set", values: [...arg.values] });
        continue;
      }
      if (arg.kind === "array_literal") {
        argValues.push({ kind: "array", values: [...arg.values] });
        continue;
      }
      if (arg.kind === "expr") {
        const v = rec(arg.expr);
        if (v === undefined) return undefined;
        const flat = flattenShapeValues(v);
        if (flat.length === 0) {
          // EdgeQL: applying a function to an empty set produces an empty set.
          // Surface that as SHAPE_EMPTY_SET upstream.
          return SHAPE_EMPTY_SET;
        }
        argValues.push(flat.length === 1 ? flat[0] as ScalarValue : { kind: "array", values: flat as ScalarValue[] });
        continue;
      }
      if (arg.kind === "function_call") {
        const v = rec({ kind: "function_call", call: arg.call });
        if (v === undefined) return undefined;
        argValues.push(v as ScalarValue);
        continue;
      }
      return undefined;
    }
    // Function names in the AST are usually unqualified (`str_upper`). The
    // stdlib defines them under `std::`; resolve there first, then fall back
    // to `default::` for user-defined functions.
    const rawName = expr.call.name;
    const candidateName = rawName.includes("::")
      ? rawName
      : (resolveStdlibFunction(`std::${rawName}`, argValues.length) ? `std::${rawName}` : `default::${rawName}`);
    return evalFunctionCall(candidateName, argValues);
  }
  if (expr.kind === "unary") {
    const inner = rec(expr.expr);
    if (inner === undefined) return undefined;
    const values = flattenShapeValues(inner);
    if (values.length === 0) return SHAPE_EMPTY_SET;
    const apply = (v: unknown): unknown => {
      if (typeof v !== "number" && typeof v !== "boolean" && typeof v !== "bigint") return null;
      if (expr.op === "neg") return -(v as number);
      if (expr.op === "not") return !(v as boolean);
      return null;
    };
    const out = values.map(apply);
    return out.length === 1 ? out[0] : out;
  }
  if (expr.kind === "math") {
    const left = rec(expr.left);
    const right = rec(expr.right);
    if (left === undefined || right === undefined) return undefined;
    const ls = flattenShapeValues(left);
    const rs = flattenShapeValues(right);
    if (ls.length === 0 || rs.length === 0) return SHAPE_EMPTY_SET;
    const op = expr.op;
    const apply = (a: unknown, b: unknown): unknown => {
      const an = Number(a);
      const bn = Number(b);
      if (!Number.isFinite(an) || !Number.isFinite(bn)) return null;
      if (op === "+") return an + bn;
      if (op === "-") return an - bn;
      if (op === "*") return an * bn;
      if (op === "/") return an / bn;
      if (op === "//") return Math.floor(an / bn);
      if (op === "%") return an % bn;
      if (op === "^") return Math.pow(an, bn);
      return null;
    };
    const out: unknown[] = [];
    for (const l of ls) {
      for (const r of rs) {
        out.push(apply(l, r));
      }
    }
    return out.length === 1 ? out[0] : out;
  }
  if (expr.kind === "cast") {
    return rec(expr.expr);
  }
  if (expr.kind === "select_expr_subquery") {
    return rec(expr.expr);
  }
  if (expr.kind === "set_expr") {
    const out: unknown[] = [];
    for (const value of expr.values) {
      const v = rec(value);
      if (v === undefined) return undefined;
      out.push(...flattenShapeValues(v));
    }
    return out;
  }
  if (expr.kind === "set_literal") {
    return [...expr.values];
  }
  if (expr.kind === "coalesce") {
    const left = rec(expr.left);
    if (left === undefined) return undefined;
    const ls = flattenShapeValues(left);
    if (ls.length > 0) {
      return ls.length === 1 ? ls[0] : ls;
    }
    const right = rec(expr.right);
    if (right === undefined) return undefined;
    const rs = flattenShapeValues(right);
    return rs.length === 1 ? rs[0] : rs;
  }
  if (expr.kind === "compare") {
    const left = rec(expr.left);
    const right = rec(expr.right);
    if (left === undefined || right === undefined) return undefined;
    const ls = flattenShapeValues(left);
    const rs = flattenShapeValues(right);
    if (expr.op === "?=" || expr.op === "?!=") {
      // ?= and ?!= are OPTIONAL over both sides — empty values participate.
      // Use {null} as the implicit singleton when a side is empty, so a
      // non-empty side still produces a cardinality matching its element count.
      const leftItems = ls.length === 0 ? [null] : ls;
      const rightItems = rs.length === 0 ? [null] : rs;
      const out: boolean[] = [];
      for (const l of leftItems) {
        for (const r of rightItems) {
          const lEmpty = l === null && ls.length === 0;
          const rEmpty = r === null && rs.length === 0;
          const eq = lEmpty && rEmpty ? true : lEmpty || rEmpty ? false : l === r;
          out.push(expr.op === "?=" ? eq : !eq);
        }
      }
      return out.length === 1 ? out[0] : out;
    } else if (ls.length === 0 || rs.length === 0) {
      return SHAPE_EMPTY_SET;
    }
    const cmpOne = (a: unknown, b: unknown): boolean => {
      switch (expr.op) {
        case "=": return a === b;
        case "!=": return a !== b;
        case "<": return (a as number) < (b as number);
        case "<=": return (a as number) <= (b as number);
        case ">": return (a as number) > (b as number);
        case ">=": return (a as number) >= (b as number);
        default: return false;
      }
    };
    const out: boolean[] = [];
    for (const l of ls) {
      for (const r of rs) {
        out.push(cmpOne(l, r));
      }
    }
    return out.length === 1 ? out[0] : out;
  }
  if (expr.kind === "if_else") {
    const cond = rec(expr.condition);
    if (cond === undefined) return undefined;
    const cs = flattenShapeValues(cond);
    if (cs.length === 0) return SHAPE_EMPTY_SET;
    if (cs[0]) {
      return rec(expr.thenExpr);
    }
    return rec(expr.elseExpr);
  }
  if (expr.kind === "tuple" || expr.kind === "array_literal_expr") {
    // EdgeQL tuple and array literals are SINGLE values made of their slots.
    // Evaluate each slot scalarly (taking the first element if the slot is a
    // singleton set) and pack into a JS array; an empty slot makes the whole
    // value empty.
    const slots: unknown[] = [];
    for (const value of expr.values) {
      const v = rec(value);
      if (v === undefined) return undefined;
      const flat = flattenShapeValues(v);
      if (flat.length === 0) return SHAPE_EMPTY_SET;
      slots.push(flat.length === 1 ? flat[0] : flat[0]);
    }
    return slots;
  }
  return undefined;
};

// Load source rows that link to `targetId` via a backlink_path. Returns
// Resolve a backlink (`subject.<link[is Source]`) for a single materialised
// object row: scan the schema for every type that declares `link`, then read
// the rows whose `link` points back at `subject.id` (via link table or inline
// `<link>_id` FK). When `sourceType` is given, restrict to its concrete
// closure. Shared by the main interpreter's `backlink_path` case and the GROUP
// row interpreter so both resolve `.<owner` the same structured way (no string
// path re-parsing).
const resolveBacklinkRowsForSubject = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  subject: unknown,
  link: string,
  sourceType?: string,
): Record<string, unknown>[] => {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return [];
  const r = subject as Record<string, unknown>;
  // Only `id` is required to walk a backlink — we scan every type that declares
  // the link below, so the subject's own `__source_type` is not needed. (Rows
  // materialised by the GROUP runtime's parsed-select path carry `id` but may
  // omit `__source_type`.)
  if (typeof r.id !== "string") return [];
  const filterSource = sourceType ? qualifyRuntimeTypeName(sourceType) : undefined;
  const out: Record<string, unknown>[] = [];
  // A link declared on a base type and overloaded on a subtype (e.g. `owner`
  // on `Owned`, overloaded on `Issue`) is reached once via the base candidate
  // and again via the subtype candidate. Each source object is a single set
  // element, so dedupe by concrete (type, id) to avoid double-counting.
  const seen = new globalThis.Set<string>();
  const pushUnique = (concreteName: string, row: Record<string, unknown>): void => {
    const key = JSON.stringify([concreteName, String(row.id)]);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };
  for (const candidate of schema.listTypes()) {
    const candidateName = qualifiedTypeName(candidate);
    if (filterSource && !schema.concreteTypeNamesUnder(filterSource).includes(candidateName)) continue;
    const linkDef = findRuntimeLinkDef(schema, candidateName, link);
    if (!linkDef) continue;
    const usesTable = usesLinkTable(linkDef.link);
    if (usesTable) {
      const owner = resolveLinkStorageOwner(schema, candidate, linkDef.link);
      const linkTable = linkTableName(qualifiedTypeName(owner), linkDef.link);
      for (const concrete of schema.listConcreteTypesAssignableTo(candidateName)) {
        const concreteName = qualifiedTypeName(concrete);
        const concreteTable = tableNameForType(concreteName);
        const rows = db.prepare(
          `SELECT s.*, j.* FROM ${quoteIdent(concreteTable)} s JOIN ${quoteIdent(linkTable)} j ON j.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE j.${quoteIdent("target")} = ?`
        ).all(r.id) as Record<string, unknown>[];
        for (const linkRow of rows) {
          const merged: Record<string, unknown> = { ...linkRow, __source_type: concreteName };
          for (const property of linkDef.link.properties ?? []) {
            merged[`@${property.name}`] = linkRow[property.name] ?? null;
          }
          pushUnique(concreteName, merged);
        }
      }
    } else {
      for (const concrete of schema.listConcreteTypesAssignableTo(candidateName)) {
        const concreteName = qualifiedTypeName(concrete);
        const concreteTable = tableNameForType(concreteName);
        const rows = db.prepare(`SELECT * FROM ${quoteIdent(concreteTable)} WHERE ${quoteIdent(`${linkDef.link.name}_id`)} = ?`).all(r.id) as Record<string, unknown>[];
        for (const linkRow of rows) {
          pushUnique(concreteName, { ...linkRow, __source_type: concreteName });
        }
      }
    }
  }
  return out;
};

// the polymorphic concrete rows plus their owning type name, mirroring how
// EdgeQL's `<linkName[IS Source]` walks the schema closure.
const collectBacklinkSourceRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  body: { kind: "backlink_path"; link: string; sourceType?: string },
  targetId: string,
): Array<{ row: Record<string, unknown>; typeName: string }> => {
  const sourceTypeHint = body.sourceType;
  if (!sourceTypeHint) return [];
  const sourceTypeQualified = sourceTypeHint.includes("::") ? sourceTypeHint : `default::${sourceTypeHint}`;
  const concreteSourceTypes = schema.listConcreteTypesAssignableTo(sourceTypeQualified);
  const sourceRows: Array<{ row: Record<string, unknown>; typeName: string }> = [];
  for (const sourceType of concreteSourceTypes) {
    const link = (sourceType.links ?? []).find((candidate) => candidate.name === body.link);
    if (!link) continue;
    const sourceTable = tableNameForType(qualifiedTypeName(sourceType));
    if (usesLinkTable(link)) {
      const owner = resolveLinkStorageOwner(schema, sourceType, link);
      const linkTable = linkTableName(qualifiedTypeName(owner), link);
      const linkRows = db
        .prepare(`SELECT s.* FROM ${quoteIdent(sourceTable)} s JOIN ${quoteIdent(linkTable)} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`)
        .all(targetId) as Record<string, unknown>[];
      for (const r of linkRows) {
        sourceRows.push({ row: r, typeName: qualifiedTypeName(sourceType) });
      }
      continue;
    }
    const inlineColumn = `${link.name}_id`;
    const inlineRows = db
      .prepare(`SELECT * FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent(inlineColumn)} = ?`)
      .all(targetId) as Record<string, unknown>[];
    for (const r of inlineRows) {
      sourceRows.push({ row: r, typeName: qualifiedTypeName(sourceType) });
    }
  }
  return sourceRows;
};

// Resolve a backlink subquery embedded in a computed shape element.
// Recognises two AST shapes:
//   1. `select_expr → shape_projection → for_expr → backlink_path` —
//      `target.<linkName[IS Source] { shape }`. Returns the projected rows.
//   2. `select_expr → exists → select_expr_subquery → compare(field_access(
//      for_expr(backlink_path), field), op, literal)` — the form EdgeQL
//      emits for `EXISTS (target.<linkName[IS Source].field = 'value')`.
//      Returns true if any source row's field compares true against the
//      literal. (This is what `owned_by_alice := EXISTS(...)` parses to.)
// Returns undefined when the expression doesn't match either pattern.
const tryEvaluateBacklinkShapeExpr = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: FreeObjectExpr,
  row: Record<string, unknown>,
): unknown | undefined => {
  // Peel the wrappers down to the for_expr we recognise.
  let cursor: FreeObjectExpr = expr;
  let projectedShape: ShapeElement[] | undefined;
  // `shapeEl.expr` can be a ComputedExpr's `select_expr` wrapper at runtime
  // (the static type FreeObjectExpr doesn't include it); peel it through.
  if ((cursor as { kind: string }).kind === "select_expr") {
    cursor = (cursor as unknown as { expr: FreeObjectExpr }).expr;
  }

  // EXISTS over a backlink-derived set. EdgeQL's `EXISTS X` is the
  // cardinality test |X| > 0. When X is `Card.<deck[IS User].name = 'Alice'`,
  // the set's cardinality equals the backlink set's cardinality (one
  // comparison result per source row, assuming the projected field is
  // non-null), so EXISTS reduces to "does any source row link back to this
  // target". Matches the form `select_expr → exists → select_expr_subquery
  // → compare(field_access(for_expr(backlink_path), field), op, literal)`.
  if (cursor.kind === "exists") {
    const targetId = row.id;
    if (typeof targetId !== "string") return false;
    let inner: FreeObjectExpr = cursor.expr;
    if (inner.kind === "select_expr_subquery") inner = inner.expr;
    if (inner.kind !== "compare") return undefined;
    const lhs = inner.left;
    if (lhs.kind !== "field_access") return undefined;
    const fieldExpr = lhs.expr;
    if (fieldExpr.kind !== "for_expr") return undefined;
    const backlinkBody = fieldExpr.body;
    if (!backlinkBody || backlinkBody.kind !== "backlink_path") return undefined;
    const sourceRows = collectBacklinkSourceRows(db, schema, backlinkBody, targetId);
    // A source row contributes a non-empty comparison iff its projected
    // field value is non-null; null operands in EdgeQL `=` evaluate to the
    // empty set rather than a boolean, so they don't increase cardinality.
    return sourceRows.some((entry) => entry.row[lhs.field] !== null && entry.row[lhs.field] !== undefined);
  }

  if (cursor.kind === "shape_projection") {
    projectedShape = cursor.shape;
    cursor = cursor.expr;
  }
  if (cursor.kind !== "for_expr") {
    return undefined;
  }
  const body = cursor.body;
  if (!body || body.kind !== "backlink_path") {
    return undefined;
  }
  const sourceTypeHint = body.sourceType;
  if (!sourceTypeHint) {
    return undefined;
  }
  const targetId = row.id;
  if (typeof targetId !== "string") {
    return [];
  }

  const sourceTypeQualified = sourceTypeHint.includes("::") ? sourceTypeHint : `default::${sourceTypeHint}`;
  const sourceTypeDef = schema.getType(sourceTypeQualified);
  if (!sourceTypeDef) {
    return [];
  }

  const sourceRows = collectBacklinkSourceRows(db, schema, body, targetId);

  if (projectedShape === undefined || projectedShape.length === 0) {
    // No projected shape — return the raw rows.
    return sourceRows.map((entry) => entry.row);
  }
  const finalShape = projectedShape;

  // Apply the projected shape to each found source row. Field references read
  // from the row directly; computed shape elements recurse through this
  // evaluator so nested computeds (`name_upper := str_upper(.name)`) work.
  const projected = sourceRows.map((entry) => {
    const out: Record<string, unknown> = {};
    for (const shapeEl of finalShape) {
      if (shapeEl.kind === "field") {
        out[shapeEl.name] = entry.row[shapeEl.name] ?? null;
        continue;
      }
      if (shapeEl.kind === "computed") {
        const value = evaluateSelectExprShapeEntry(db, schema, shapeEl.expr as unknown as FreeObjectExpr, entry.row, entry.typeName);
        out[shapeEl.name] = value;
        continue;
      }
      if (shapeEl.kind === "link" || shapeEl.kind === "backlink") {
        // Nested link/backlink projections inside the inner shape — beyond
        // the scope of this helper; leave them undefined for now.
        out[shapeEl.name] = null;
      }
    }
    return out;
  });
  return projected;
};

const evaluateSelectExprShapeEntry = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: FreeObjectExpr,
  row: Record<string, unknown>,
  sourceType: string,
): unknown => {
  const resolveCurrentField = (field: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      return materializeFieldValue(schema, sourceType, field, row[field]);
    }

    if (typeof row.id !== "string") {
      return undefined;
    }

    const sourceRow = readRowById(db, tableNameForType(sourceType), row.id) ?? row;
    if (findFieldDef(schema, sourceType, field)) {
      return materializeFieldValue(schema, sourceType, field, sourceRow[field]);
    }

    const resolvedLink = findRuntimeLinkDef(schema, sourceType, field);
    if (!resolvedLink) {
      return undefined;
    }

    const linkDef = resolvedLink.link;
    const loadTargetById = (targetId: unknown): Record<string, unknown> | null => {
      if (typeof targetId !== "string") {
        return null;
      }
      const targetType = db
        .prepare(`SELECT ${quoteIdent("type_name")} AS ${quoteIdent("type_name")} FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = ?`)
        .all(targetId)[0] as { type_name?: unknown } | undefined;
      const fallbackTarget = normalizeLinkTargetNames(linkDef.targetType, schema.getType(sourceType)?.module ?? "default")[0];
      const targetTypeName = typeof targetType?.type_name === "string"
        ? resolveRuntimeStoredTypeName(schema, targetType.type_name)
        : fallbackTarget;
      if (!targetTypeName) {
        return null;
      }
      const loaded = readRowById(db, tableNameForType(targetTypeName), targetId);
      return loaded ? { ...loaded, __source_type: targetTypeName } : null;
    };

    if (usesLinkTable(linkDef)) {
      const owner = resolveLinkStorageOwner(schema, schema.getType(sourceType) ?? { module: sourceType.split("::").slice(0, -1).join("::"), name: sourceType.split("::").at(-1) ?? sourceType, fields: [] }, linkDef);
      const linkTable = linkTableName(qualifiedTypeName(owner), linkDef);
      const linkRows = db.prepare(`SELECT ${quoteIdent("target")} FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).all(row.id) as Array<{ target?: unknown }>;
      return linkRows.map((linkRow) => loadTargetById(linkRow.target)).filter((target): target is Record<string, unknown> => target !== null);
    }

    return loadTargetById(sourceRow[`${linkDef.name}_id`]);
  };

  // Computed shape elements whose expression is a backlink subquery
  // (`winner := Award.<awards[IS User] { name }`) parse as
  // select_expr → shape_projection → for_expr → backlink_path. The general
  // free-expr evaluator can't follow inbound paths, so we resolve them here:
  // for the current row, find source rows where the named link points at
  // row.id, then apply the projected shape to each.
  const backlinkResult = tryEvaluateBacklinkShapeExpr(db, schema, expr, row);
  if (backlinkResult !== undefined) {
    return backlinkResult;
  }

  // First try the general free-expression evaluator. If it returns undefined,
  // we don't know how to evaluate this; fall back to the legacy
  // path-steps/type-intersection handler below.
  const general = evaluateFreeExprForShape(expr, row, resolveCurrentField, (functionName, args) =>
    executeFunctionCall(schema, db, DEFAULT_SECURITY_CONTEXT, functionName, args));
  if (general !== undefined) {
    if (general === SHAPE_EMPTY_SET) return null;
    return general;
  }
  if (expr.kind !== "path_steps" || !expr.partial) return null;
  const steps = expr.steps;
  const head = steps[0];
  if (!head || head.kind !== "type_intersection") return null;

  const typeExpr = head.typeExpr ?? (head.typeName ? { kind: "type_name" as const, name: head.typeName } : undefined);
  if (!typeExpr) return null;

  const concreteMatches = (typeName: string, t: TypeExpr): boolean => {
    if (t.kind === "type_name") {
      const qualified = t.name.includes("::") ? t.name : `default::${t.name}`;
      if (qualified === "default::Object" || qualified === "std::Object") return true;
      return schema.concreteTypeNamesUnder(qualified).includes(typeName);
    }
    if (t.kind === "type_union") {
      return concreteMatches(typeName, t.left) || concreteMatches(typeName, t.right);
    }
    return concreteMatches(typeName, t.left) && concreteMatches(typeName, t.right);
  };

  if (!concreteMatches(sourceType, typeExpr)) return null;

  let current: unknown = row;
  for (let i = 1; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.kind !== "ptr") return null;
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    const currentRow = current as Record<string, unknown>;
    // Inline single links are stored as `<name>_id` columns; properties keep
    // their bare name. Try both so this works for either.
    const raw = currentRow[step.name] ?? currentRow[`${step.name}_id`];
    if (raw === undefined || raw === null) return null;

    if (i === steps.length - 1) {
      return raw;
    }

    if (typeof raw !== "string") return null;
    const globalType = db
      .prepare(`SELECT ${quoteIdent("type_name")} AS ${quoteIdent("type_name")} FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = ?`)
      .all(raw)[0] as { type_name?: unknown } | undefined;
    if (!globalType || typeof globalType.type_name !== "string") return null;
    const currentTypeName = resolveRuntimeStoredTypeName(schema, globalType.type_name);
    const table = currentTypeName.replaceAll("::", "__").toLowerCase();
    const next = db.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} = ?`).all(raw)[0] as Record<string, unknown> | undefined;
    if (!next) return null;
    current = next;
  }

  return current;
};

const materializeFieldValue = (
  schema: SchemaSnapshot,
  sourceType: string,
  fieldName: string,
  value: unknown,
): unknown => {
  const field = findFieldDef(schema, sourceType, fieldName);
  if (!field) {
    return value;
  }

      if (field.multi) {
    if (value === null || value === undefined) {
      return [];
    }
    if (typeof value !== "string") {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (e) {
      // Multi-property values are stored JSON-encoded; a non-JSON string
      // is corrupt stored data and must not silently decode as empty.
      throw new AppError(
        "E_RUNTIME",
        `corrupt stored value for multi property '${fieldName}' on ${sourceType}: not valid JSON: ${JSON.stringify(value.slice(0, 80))}`,
        { cause: e },
      );
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Preserve the on-disk insertion order — multi-property values are
    // stored as a JSON array in their write order, and EdgeQL's `multi
    // property` semantics expose them in that order unless an explicit
    // `ORDER BY` reshapes them in the shape clause.
    return parsed.map((item) => coerceScalarForOutput(field.type, item));
  }

  if (field.collection && typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        // Collection (array/tuple) values are stored JSON-encoded; a
        // bracket-delimited string that fails to parse is corrupt stored
        // data, not a string to pass through as-is.
        throw new AppError(
          "E_RUNTIME",
          `corrupt stored value for ${field.collection.kind} field '${fieldName}' on ${sourceType}: not valid JSON: ${JSON.stringify(trimmed.slice(0, 80))}`,
          { cause: e },
        );
      }
      if (field.collection.kind === "array") {
        return Array.isArray(parsed) ? parsed : [];
      }

      if (field.collection.kind === "tuple") {
        if (Array.isArray(parsed) && field.collection.elementNames && field.collection.elementNames.length === parsed.length) {
          return Object.fromEntries(field.collection.elementNames.map((name, idx) => [name, parsed[idx]]));
        }
        return parsed;
      }
    }
  }

  return coerceScalarForOutput(field.type, value);
};

const evaluateComputedLinkPropertyExpr = (
  expr: ComputedLinkPropertyExpr,
  targetRow: Record<string, unknown>,
  linkProperties: Record<string, unknown>,
): unknown => {
  if (expr.kind === "literal") {
    return expr.value;
  }

  if (expr.kind === "field_ref") {
    return targetRow[expr.name] ?? null;
  }

  if (expr.kind === "link_property_ref") {
    return linkProperties[`@${expr.name}`] ?? linkProperties[expr.name] ?? null;
  }

  const left = evaluateComputedLinkPropertyExpr(expr.left, targetRow, linkProperties);
  if (expr.op === "??") {
    return left ?? evaluateComputedLinkPropertyExpr(expr.right, targetRow, linkProperties);
  }

  const right = evaluateComputedLinkPropertyExpr(expr.right, targetRow, linkProperties);
  if (expr.op === "++") {
    return `${left ?? ""}${right ?? ""}`;
  }
  if (expr.op === "+") {
    return Number(left) + Number(right);
  }
  if (expr.op === "-") {
    return Number(left) - Number(right);
  }
  if (expr.op === "*") {
    return Number(left) * Number(right);
  }
  return Number(left) / Number(right);
};

const findFieldDef = (
  schema: SchemaSnapshot,
  typeName: string,
  fieldName: string,
  seen = new Set<string>(),
): TypeDef["fields"][number] | undefined => {
  if (seen.has(typeName)) {
    return undefined;
  }
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) {
    return undefined;
  }

  const direct = typeDef.fields.find((field) => field.name === fieldName);
  if (direct) {
    return direct;
  }

  for (const baseName of typeDef.extends ?? []) {
    const inherited = findFieldDef(schema, baseName, fieldName, seen);
    if (inherited) {
      return inherited;
    }
  }

  return undefined;
};

const coerceScalarForOutput = (type: ScalarType, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }

  if (type === "json" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (e) {
      // json-typed values are stored as JSON text; anything unparseable is
      // corrupt stored data, not a string to pass through as-is.
      throw new AppError(
        "E_RUNTIME",
        `corrupt stored json value: not valid JSON: ${JSON.stringify(value.slice(0, 80))}`,
        { cause: e },
      );
    }
  }

  if (type === "bool") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      if (value === "1" || value.toLowerCase() === "true") {
        return true;
      }
      if (value === "0" || value.toLowerCase() === "false") {
        return false;
      }
    }
  }

  return value;
};

// DB context threaded through group-row field/expr evaluation (backlink steps
// resolve against the DB per element).
interface GroupRowCtx {
  db: SQLiteDatabase;
  schema: SchemaSnapshot;
}

// Advance one path step over `current`. When `current` is an array (a set —
// e.g. `g.elements`), the step is mapped over every element and the results
// are flattened one level (EdgeQL set semantics: `g.elements.name` is the set
// of all names). A leading `<` marks a backlink step which is resolved against
// the DB for each (object) element.
const stepGroupRowField = (
  current: unknown,
  step: string,
  ctx?: GroupRowCtx,
): unknown => {
  if (current == null) return null;
  if (Array.isArray(current)) {
    const out: unknown[] = [];
    for (const item of current) {
      const stepped = stepGroupRowField(item, step, ctx);
      if (stepped == null) continue;
      if (Array.isArray(stepped)) out.push(...stepped);
      else out.push(stepped);
    }
    return out;
  }
  // Backlink step, e.g. `<owner` or `<awards[is User]`.
  if (step.startsWith("<")) {
    if (!ctx) return null;
    const linkBody = parseBacklinkStep(step);
    if (!linkBody) return null;
    if (typeof current !== "object") return null;
    const id = (current as Record<string, unknown>).id;
    if (typeof id !== "string") return null;
    const sources = collectBacklinkSourceRows(ctx.db, ctx.schema, linkBody, id);
    return sources.map((s) => s.row);
  }
  if (typeof current !== "object") return null;
  return (current as Record<string, unknown>)[step] ?? null;
};

// Parse a backlink path step like `<owner` or `<awards[is User]` into the
// backlink_path body understood by collectBacklinkSourceRows.
const parseBacklinkStep = (
  step: string,
): { kind: "backlink_path"; link: string; sourceType?: string } | undefined => {
  const m = /^<([A-Za-z_][\w]*)(?:\s*\[\s*is\s+([\w:]+)\s*\])?$/.exec(step);
  if (!m) return undefined;
  return { kind: "backlink_path", link: m[1], sourceType: m[2] };
};

// Convert a parsed PathStep into the string step name understood by
// stepGroupRowField. Inbound (backlink) `ptr` steps become `<link[is Type]`.
const pathStepToFieldName = (step: PathStep): string | undefined => {
  if (step.kind === "object_ref") return step.name;
  if (step.kind === "ptr") {
    if (step.direction === "inbound") {
      return step.typeFilter ? `<${step.name}[is ${step.typeFilter}]` : `<${step.name}`;
    }
    return step.name;
  }
  return undefined;
};

const evalGroupRowExpr = (
  expr: FreeObjectExpr,
  row: Record<string, unknown>,
  bindings?: ReadonlyMap<string, unknown>,
  ctx?: GroupRowCtx,
): unknown => {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "current_item":
      return row;
    case "binding_ref": {
      if (bindings && bindings.has(expr.name)) {
        return bindings.get(expr.name);
      }
      return null;
    }
    case "path": {
      // `head.tail…` where head is a binding (e.g. `g.elements`). The parser
      // populates `steps` with the full path *including* the head object_ref
      // (`[object_ref g, ptr elements, …]`); when present, walk those (skipping
      // the head ref, already resolved via the binding) rather than also
      // consuming `tail`, which would double-step and walk off into null.
      let current: unknown = bindings?.get(expr.head);
      const steps = expr.steps ?? [];
      if (steps.length > 0) {
        for (const step of steps) {
          if (step.kind === "object_ref") continue;
          const name = pathStepToFieldName(step);
          if (name === undefined) continue;
          current = stepGroupRowField(current, name, ctx);
        }
      } else {
        current = stepGroupRowField(current, expr.tail, ctx);
      }
      return current;
    }
    case "path_chain": {
      let current: unknown = bindings?.get(expr.parts[0]);
      for (let i = 1; i < expr.parts.length; i += 1) {
        current = stepGroupRowField(current, expr.parts[i], ctx);
      }
      for (const step of expr.steps ?? []) {
        const name = pathStepToFieldName(step);
        if (name === undefined) continue;
        current = stepGroupRowField(current, name, ctx);
      }
      return current;
    }
    case "field_access": {
      const target = evalGroupRowExpr(expr.expr, row, bindings, ctx);
      return stepGroupRowField(target, expr.field, ctx);
    }
    case "select_expr_subquery":
    case "distinct":
      return evalGroupRowExpr(expr.expr, row, bindings, ctx);
    case "shape_projection": {
      const base = evalGroupRowExpr(expr.expr, row, bindings, ctx);
      if (Array.isArray(base)) {
        return base.map((item) => projectShape(item, expr.shape, bindings, ctx));
      }
      if (base == null || typeof base !== "object") {
        return null;
      }
      return projectShape(base, expr.shape, bindings, ctx);
    }
    case "free_object_constructor": {
      const out: Record<string, unknown> = {};
      for (const entry of expr.entries) {
        out[entry.name] = evalGroupRowExpr(entry.expr, row, bindings, ctx);
      }
      return out;
    }
    case "compare":
    case "logical": {
      const left = evalGroupRowExpr(expr.left, row, bindings, ctx);
      const right = evalGroupRowExpr(expr.right, row, bindings, ctx);
      return applyComparisonOp(expr.op, left, right);
    }
    case "unary": {
      const inner = evalGroupRowExpr(expr.expr, row, bindings, ctx);
      if (expr.op === "not") return !inner;
      if (expr.op === "neg") return -Number(inner);
      return null;
    }
    case "math": {
      const left = Number(evalGroupRowExpr(expr.left, row, bindings, ctx) ?? 0);
      const right = Number(evalGroupRowExpr(expr.right, row, bindings, ctx) ?? 0);
      switch (expr.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return right === 0 ? null : normalizeRuntimeFloat(left / right);
        case "%": return right === 0 ? null : left % right;
        default: return null;
      }
    }
    case "concat": {
      // `++` over sets is the cartesian set-concat: `{a,b} ++ {"!","?"}` →
      // `{"a!","a?","b!","b?"}`. Evaluate each part, expand singletons to
      // 1-element lists, and string-concat the cartesian product.
      const partLists = expr.parts.map((part) => {
        const value = evalGroupRowExpr(part, row, bindings, ctx);
        return Array.isArray(value) ? value : value == null ? [] : [value];
      });
      let acc: unknown[] = [""];
      for (const list of partLists) {
        const next: unknown[] = [];
        for (const prefix of acc) {
          for (const item of list) {
            next.push(`${String(prefix)}${String(item)}`);
          }
        }
        acc = next;
      }
      return acc;
    }
    case "for_expr": {
      // Bind the inner loop var per item, eval body per item, flatten results.
      const iterator = evalGroupRowExpr(expr.iterator, row, bindings, ctx);
      const items = Array.isArray(iterator) ? iterator : iterator == null ? [] : [iterator];
      const out: unknown[] = [];
      for (const item of items) {
        const innerBindings = new Map<string, unknown>(bindings ?? []);
        innerBindings.set(expr.variable, item);
        // A backlink body (`g.elements.<owner` desugars to
        // `for x in g.elements union x.<owner`) reads its subject from
        // `__current__`; bind it to the per-iteration item.
        innerBindings.set("__current__", item);
        const bodyValue = evalGroupRowExpr(expr.body, row, innerBindings, ctx);
        if (bodyValue == null) continue;
        if (Array.isArray(bodyValue)) out.push(...bodyValue);
        else out.push(bodyValue);
      }
      return out;
    }
    case "function_call":
      return evalGroupRowFunctionCall(expr.call, row, bindings, ctx);
    case "backlink_path": {
      // `subject.<link[is Source]` — resolve against the DB for the current
      // subject (the innermost FOR item, else this group row).
      if (!ctx) return [];
      const subject = bindings?.get("__current__") ?? row;
      return resolveBacklinkRowsForSubject(ctx.db, ctx.schema, subject, expr.link, expr.sourceType);
    }
    case "cast": {
      const value = evalGroupRowExpr(expr.expr, row, bindings, ctx);
      return value;
    }
    case "if_else": {
      const cond = evalGroupRowExpr(expr.condition, row, bindings, ctx);
      return cond
        ? evalGroupRowExpr(expr.thenExpr, row, bindings, ctx)
        : evalGroupRowExpr(expr.elseExpr, row, bindings, ctx);
    }
    case "tuple":
      return expr.values.map((value) => evalGroupRowExpr(value, row, bindings, ctx));
    default:
      return null;
  }
};

const projectShape = (
  base: unknown,
  shape: ShapeElement[],
  bindings?: ReadonlyMap<string, unknown>,
  ctx?: GroupRowCtx,
): unknown => {
  if (base == null || typeof base !== "object" || Array.isArray(base)) {
    return null;
  }
  const baseRow = base as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const element of shape) {
    if (element.kind === "field") {
      projected[element.name] = baseRow[element.name] ?? null;
      continue;
    }
    if (element.kind === "computed") {
      projected[element.name] = evalGroupRowComputed(element.expr, baseRow, bindings, ctx);
      continue;
    }
    if (element.kind === "link" || element.kind === "backlink") {
      const linkValue = baseRow[element.name];
      const linkShape = element.shape;
      if (!linkShape) {
        projected[element.name] = linkValue ?? null;
        continue;
      }
      if (Array.isArray(linkValue)) {
        projected[element.name] = linkValue.map((item) => projectShape(item, linkShape, bindings, ctx));
      } else if (linkValue && typeof linkValue === "object") {
        projected[element.name] = projectShape(linkValue, linkShape, bindings, ctx);
      } else {
        projected[element.name] = null;
      }
      continue;
    }
  }
  return projected;
};

const evalGroupRowComputed = (
  expr: ComputedExpr | BacklinkExpr,
  row: Record<string, unknown>,
  bindings?: ReadonlyMap<string, unknown>,
  ctx?: GroupRowCtx,
): unknown => {
  if (!("kind" in expr)) {
    return null;
  }
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "field_ref":
      return row[expr.field] ?? null;
    case "select_expr":
      return evalGroupRowExpr(expr.expr, row, bindings, ctx);
    case "function_call":
      return evalGroupRowFunctionCall(expr.call, row, bindings, ctx);
    case "binding_ref":
      return bindings?.get(expr.name) ?? null;
    default:
      return null;
  }
};

const evalGroupRowFunctionCall = (
  call: FunctionCallExpr,
  row: Record<string, unknown>,
  bindings?: ReadonlyMap<string, unknown>,
  ctx?: GroupRowCtx,
): unknown => {
  const args = call.args.map((arg) => {
    if (arg.kind === "expr") {
      return evalGroupRowExpr(arg.expr, row, bindings, ctx);
    }
    if (arg.kind === "literal") {
      return arg.value;
    }
    return null;
  });

  const nameParts = call.name.split("::");
  const name = nameParts[nameParts.length - 1];

  if (name === "count") {
    const value = args[0];
    if (Array.isArray(value)) return value.length;
    if (value == null) return 0;
    return 1;
  }
  if (name === "sum") {
    const rawArg = args[0];
    if (typeof rawArg === "string") {
      throw new AppError("E_SEMANTIC", `function "sum(arg0: std::str)" does not exist`, 1, 1);
    }
    if (Array.isArray(rawArg) && rawArg.some((v) => typeof v === "string")) {
      throw new AppError("E_SEMANTIC", `function "sum(arg0: std::str)" does not exist`, 1, 1);
    }
    const list = asNumericList(rawArg);
    return list.reduce((acc, v) => acc + v, 0);
  }
  if (name === "min") {
    const list = asNumericList(args[0]);
    return list.length === 0 ? null : Math.min(...list);
  }
  if (name === "max") {
    const list = asNumericList(args[0]);
    return list.length === 0 ? null : Math.max(...list);
  }
  if (name === "mean" || name === "avg") {
    const list = asNumericList(args[0]);
    return list.length === 0 ? null : list.reduce((a, v) => a + v, 0) / list.length;
  }
  if (name === "array_agg") {
    const value = args[0];
    if (Array.isArray(value)) return [...value];
    return value == null ? [] : [value];
  }
  if (name === "str_lower") return typeof args[0] === "string" ? args[0].toLowerCase() : null;
  if (name === "str_upper") return typeof args[0] === "string" ? args[0].toUpperCase() : null;
  if (name === "len") {
    if (typeof args[0] === "string") return args[0].length;
    if (Array.isArray(args[0])) return args[0].length;
    return 0;
  }
  return null;
};

const asNumericList = (value: unknown): number[] => {
  if (Array.isArray(value)) {
    return value.filter((v) => v != null).map((v) => Number(v));
  }
  if (value == null) return [];
  return [Number(value)];
};

const applyComparisonOp = (op: string, left: unknown, right: unknown): unknown => {
  switch (op) {
    case "=": return canonicalCompareEqual(left, right);
    case "!=": return !canonicalCompareEqual(left, right);
    case "<": return Number(left) < Number(right);
    case ">": return Number(left) > Number(right);
    case "<=": return Number(left) <= Number(right);
    case ">=": return Number(left) >= Number(right);
    case "and": return Boolean(left) && Boolean(right);
    case "or": return Boolean(left) || Boolean(right);
    default: return null;
  }
};

const canonicalCompareEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left == null || right == null) return left == right;
  if (typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
};

const compareScalar = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const aStr = String(a);
  const bStr = String(b);
  if (aStr < bStr) return -1;
  if (aStr > bStr) return 1;
  return 0;
};

const runGelSelectSQL = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  statement: GelIRStatement,
  context: SecurityContext,
  sqlArtifact: SQLArtifact,
  options: { keepInternalId?: boolean } = {},
): unknown[] => {
  const rows = db.prepare(sqlArtifact.sql).all(...sqlArtifact.params) as Record<string, unknown>[];
  const visibleRows = rows.filter((row) => evaluateGelSelectPolicies(schema, db, statement, row, context));
  return materializeGelSQLRows(visibleRows, {
    keepInternalId: options.keepInternalId ?? gelStatementProjectsId(statement),
    scalarResultIsStr: gelStatementScalarResultIsStr(statement),
  });
};

// A top-level `std::str` scalar select projects its `value` column through
// `json_quote(...)` (see scalarResultValueSQL in the SQL compiler) so that a
// str whose contents look like JSON (e.g. "[1,2]" or "true") round-trips
// safely. Detect that case so the decoder can JSON.parse the quoted form back
// to the plain string. `std::json` scalars are *not* quoted — their value
// column already holds raw JSON text and must be preserved verbatim.
const gelStatementScalarResultIsStr = (statement: GelIRStatement): boolean => {
  const typeref = unwrapGelSelectResultSet(statement.expr).typeref;
  if (!typeref) return false;
  // Inference-derived typerefs (`unknown:std::str`) don't set isScalar —
  // match on the qualified name alone; nothing non-scalar is named std::str.
  return qualifiedGelTypeName(typeref) === "std::str";
};

const evaluateGelSelectPolicies = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  statement: GelIRStatement,
  row: Record<string, unknown>,
  context: SecurityContext,
): boolean => {
  const sourceType = typeof row.__source_type === "string"
    ? row.__source_type
    : gelStatementSourceType(statement);
  if (!sourceType) return true;
  const typeDef = schema.getType(sourceType);
  return typeDef ? evaluateSelectPolicies(schema, db, typeDef, row, context) : true;
};

// materializeGelSQLRows / normalizeGelSQLValue moved to ./row_codec.ts (ADR 0013).

const gelStatementProjectsId = (statement: GelIRStatement): boolean =>
  topLevelGelShape(statement).some((element) => gelShapeElementName(element) === "id");

const gelStatementSourceType = (statement: GelIRStatement): string | undefined => {
  const set = unwrapGelSelectResultSet(statement.expr);
  const typeref = set.typeref;
  if (!typeref || typeref.isScalar) return undefined;
  return qualifiedGelTypeName(typeref);
};

const topLevelGelShape = (statement: GelIRStatement): GelIRShapeElement[] =>
  unwrapGelSelectResultSet(statement.expr).shape ?? [];

const unwrapGelSelectResultSet = (set: GelIRSet): GelIRSet => {
  let current = set;
  while (current.expr.kind === "select_expr") {
    const result = (current.expr as { result?: GelIRSet }).result;
    if (!result) break;
    current = result;
  }
  return current;
};

const gelShapeElementName = (element: GelIRShapeElement): string | undefined => {
  if (element.name) return element.name;
  if (element.targetPtr?.shortName) return element.targetPtr.shortName;
  const expr = element.expr.expr as { ptrref?: { shortName?: string } };
  return expr.ptrref?.shortName;
};

const qualifiedGelTypeName = (typeref: GelIRTypeRef): string =>
  typeref.nameHint.includes("::") ? typeref.nameHint : `${typeref.module}::${typeref.nameHint}`;

const inferStaticArgType = (
  arg: FunctionCallArgExpr,
  schema: SchemaSnapshot,
  defaultModule: string,
  implicitType?: string,
): string | undefined => {
  const fromExpr = (expr: FreeObjectExpr | undefined): string | undefined => {
    if (!expr || typeof expr !== "object") return undefined;
    if (expr.kind === "cast") return expr.castType;
    if (expr.kind === "literal") {
      const v = expr.value;
      if (typeof v === "boolean") return "bool";
      if (typeof v === "number") return Number.isInteger(v) ? "int64" : "float64";
      if (typeof v === "string") return "str";
      return undefined;
    }
    if (expr.kind === "field_access") {
      // Walk down to the source select to learn the row type, then look up
      // the field's declared type in the schema. Also handle `.field` syntax
      // (current_item) by falling back to the caller-supplied implicit type.
      let inner: FreeObjectExpr = expr.expr;
      while (inner.kind === "field_access" || inner.kind === "cast"
        || inner.kind === "select_expr_subquery"
        || (inner as { kind: string }).kind === "select_expr") {
        inner = (inner as unknown as { expr: FreeObjectExpr }).expr;
      }
      let typeName: string | undefined;
      if (inner.kind === "select") {
        typeName = inner.typeName.includes("::") ? inner.typeName : `${defaultModule}::${inner.typeName}`;
      } else if (inner.kind === "current_item" && implicitType) {
        typeName = implicitType.includes("::") ? implicitType : `${defaultModule}::${implicitType}`;
      }
      if (!typeName) return undefined;
      const typeDef = schema.getType(typeName);
      if (!typeDef) return undefined;
      const field = typeDef.fields.find((f) => f.name === expr.field);
      return field?.type;
    }
    if (expr.kind === "select") {
      const typeName = expr.typeName.includes("::") ? expr.typeName : `${defaultModule}::${expr.typeName}`;
      return typeName;
    }
    return undefined;
  };
  if (arg.kind === "expr") return fromExpr(arg.expr);
  if (arg.kind === "literal") {
    if (typeof arg.value === "boolean") return "bool";
    if (typeof arg.value === "number") return Number.isInteger(arg.value) ? "int64" : "float64";
    if (typeof arg.value === "string") return "str";
  }
  return undefined;
};

const runtimeArgTypeName = (arg: RuntimeFunctionArg | undefined): string | "empty" | "unknown" => {
  if (arg === null || arg === undefined) return "empty";
  if (typeof arg === "object" && arg !== null && "kind" in arg) {
    if (arg.kind === "array") return "array";
    // A "set" arg with no values is an empty set (e.g. `<str>{}`); we treat
    // it as type-flexible so OPTIONAL overloads match.
    if (arg.values.length === 0) return "empty";
    return runtimeArgTypeName(arg.values[0] as RuntimeFunctionArg);
  }
  if (typeof arg === "boolean") return "bool";
  if (typeof arg === "number") return Number.isInteger(arg) ? "int64" : "float64";
  if (typeof arg === "string") return "str";
  return "unknown";
};

const paramAcceptsArgType = (paramType: string, argType: string | "empty" | "unknown"): number => {
  // Returns a score: -1 = no match, 0 = optional-empty (low), 1 = compatible,
  // 2 = exact-ish. Used to rank overloads when multiple share name + arity.
  if (argType === "empty") return 0;
  if (argType === "unknown") return 1;
  const normalize = (t: string): string => {
    const idx = t.lastIndexOf("::");
    let s = idx >= 0 ? t.slice(idx + 2) : t;
    // Collection types come parameterized (e.g. `array<int64>`) on params
    // but as bare kind ("array", "tuple") on runtime values — collapse.
    const collMatch = /^(array|tuple|set)\s*<.*>$/.exec(s);
    if (collMatch) s = collMatch[1];
    // FieldDef.type stores short scalar names ("int", "float"); function
    // params store EdgeQL canonical names ("int64", "float64"). Normalize
    // both to the long form so they compare equal.
    if (s === "int") return "int64";
    if (s === "int16" || s === "int32") return "int64";
    if (s === "float") return "float64";
    if (s === "float32") return "float64";
    return s;
  };
  const p = normalize(paramType);
  const a = normalize(argType);
  if (p === a) return 2;
  if (p === "float64" && a === "int64") return 1;
  if (p === "anytype" || p === "anyscalar") return 1;
  return -1;
};

const resolveUserFunctionOverload = (
  schema: SchemaSnapshot,
  moduleName: string,
  fnName: string,
  args: RuntimeFunctionArg[],
  staticTypes?: (string | undefined)[],
): FunctionDef | undefined => {
  let best: { fn: FunctionDef; score: number } | undefined;
  // Track the runtime-empty positions separately so a non-optional param
  // still disqualifies the variant — the static type is only used to break
  // ties between OPTIONAL overloads when the runtime value is empty.
  const runtimeTypes = args.map(runtimeArgTypeName);
  for (const fn of schema.listFunctions()) {
    if (fn.module !== moduleName || fn.name !== fnName) continue;
    const requiredCount = fn.params.filter((p) => !p.optional && p.default === undefined && !p.variadic).length;
    const accepts = args.length >= requiredCount
      && (fn.params.some((p) => p.variadic) || args.length <= fn.params.length);
    if (!accepts) continue;
    let score = 0;
    let viable = true;
    for (let i = 0; i < fn.params.length; i++) {
      const param = fn.params[i];
      const runtimeType = i < runtimeTypes.length ? runtimeTypes[i] : "empty";
      if (runtimeType === "empty" && !param.optional && param.default === undefined) {
        viable = false;
        break;
      }
      // For type-match scoring use the static type when runtime is empty —
      // both `optional int64` and `optional str` accept empty at runtime, so
      // we'd otherwise tie.
      const typeForScore = (runtimeType === "empty" || runtimeType === "unknown")
        ? (staticTypes?.[i] ?? runtimeType)
        : runtimeType;
      const paramScore = paramAcceptsArgType(param.type, typeForScore);
      if (paramScore < 0 && typeForScore !== "empty" && typeForScore !== "unknown") {
        viable = false;
        break;
      }
      score += Math.max(paramScore, 0);
    }
    if (!viable) continue;
    if (!best || score > best.score) {
      best = { fn, score };
    }
  }
  return best?.fn;
};

const executeFunctionCall = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  qualifiedName: string,
  args: RuntimeFunctionArg[],
  staticArgTypes?: (string | undefined)[],
): unknown => {
  // A bareword EdgeQL call (`range(1, 5)`) in a script whose default module
  // is `default` arrives here as `default::range`. The stdlib registry keys
  // by the canonical module (`std::`, `math::`, `cal::`), so a literal
  // lookup of `default::range` misses. Re-resolve under the stdlib modules
  // first when the qualified form doesn't exist there directly.
  let resolvedName = qualifiedName;
  let builtin = resolveStdlibFunction(qualifiedName, args.length);
  if (!builtin) {
    const qualifiedParts = qualifiedName.split("::");
    const shortName = qualifiedParts[qualifiedParts.length - 1];
    for (const prefix of ["std", "math", "cal"]) {
      const candidate = `${prefix}::${shortName}`;
      const hit = resolveStdlibFunction(candidate, args.length);
      if (hit) {
        builtin = hit;
        resolvedName = candidate;
        break;
      }
    }
  }
  if (builtin) {
    if (resolvedName === "std::count") {
      return countRuntimeSetCardinality(args[0]);
    }
    return executeStdlibFunction(resolvedName, args);
  }

  const divider = qualifiedName.lastIndexOf("::");
  const moduleName = divider >= 0 ? qualifiedName.slice(0, divider) : "default";
  const fnName = divider >= 0 ? qualifiedName.slice(divider + 2) : qualifiedName;
  const fn = resolveUserFunctionOverload(schema, moduleName, fnName, args, staticArgTypes);
  if (!fn) {
    // If the function exists under this name (any signature) but no overload
    // matches the given args, that's a short-circuit, not an error: a call
    // with an empty set for a NON-optional parameter produces an empty
    // result in EdgeQL (the call simply isn't made for that iteration).
    const anyByName = schema.listFunctions().some((f) => f.module === moduleName && f.name === fnName);
    if (anyByName) return null;
    throw new AppError("E_SEMANTIC", `Unknown function '${qualifiedName}'`, 1, 1);
  }

  const bindings = bindFunctionArgs(fn, args);
  if (fn.volatility === "Modifying") {
    for (const param of fn.params) {
      const value = bindings.get(param.name);
      if (value === undefined || value === null) {
        if (!param.optional) {
          throw new AppError(
            "E_SEMANTIC",
            "possibly an empty set passed as non-optional argument into modifying function",
            1,
            1,
          );
        }
        continue;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) {
          if (!param.optional) {
            throw new AppError(
                "E_SEMANTIC",
              "possibly an empty set passed as non-optional argument into modifying function",
              1,
              1,
            );
          }
          continue;
        }

        if (value.length === 1) {
          continue;
        }
        throw new AppError("E_SEMANTIC", "possibly more than one element passed into modifying function", 1, 1);
      }
    }
  }

  if (fn.body.kind === "expr") {
    return evaluateExprBody(fn, bindings);
  }

  const withPrefix = fn.params
    .map((param) => `${param.name} := ${literalToEdgeQL(bindings.get(param.name) ?? null)}`)
    .join(", ");
  const query = withPrefix.length > 0 ? `with ${withPrefix} ${fn.body.query}` : fn.body.query;
  const result = executeQuery(db, schema, query, context);
  if (result.rows) {
    if (!fn.returnSetOf) {
      if (result.rows.length === 0) {
        return null;
      }
      const firstRow = result.rows[0];
      if (result.rows.length === 1 && isRecordRow(firstRow) && Object.keys(firstRow).length === 1) {
        return Object.values(firstRow)[0];
      }
      if (result.rows.length === 1) {
        return firstRow ?? null;
      }
    }
    const firstRow = result.rows[0];
    if (result.rows.length === 1 && isRecordRow(firstRow) && Object.keys(firstRow).length === 1) {
      return Object.values(firstRow)[0];
    }
    return result.rows;
  }
  return result.changes ?? 0;
};

const bindFunctionArgs = (fn: FunctionDef, args: RuntimeFunctionArg[]): Map<string, ScalarValue | ScalarValue[] | null> => {
  const out = new Map<string, ScalarValue | ScalarValue[] | null>();
  let cursor = 0;
  for (const param of fn.params) {
    if (param.variadic) {
      const variadicValues: ScalarValue[] = [];
      while (cursor < args.length) {
        const next = args[cursor];
        cursor += 1;
        if (typeof next === "object" && next !== null && "kind" in next && next.kind === "array") {
          variadicValues.push(...next.values);
        } else if (typeof next === "object" && next !== null && "kind" in next && next.kind === "set") {
          variadicValues.push(...next.values);
        } else {
          variadicValues.push(next as ScalarValue);
        }
      }
      out.set(param.name, variadicValues);
      continue;
    }

    const raw = cursor < args.length ? args[cursor] : undefined;
    if (raw !== undefined) {
      cursor += 1;
    }

    if (raw === undefined) {
      if (param.default !== undefined) {
        out.set(param.name, param.default);
        continue;
      }
      if (param.optional) {
        out.set(param.name, null);
        continue;
      }
      throw new AppError("E_SEMANTIC", `Missing required function argument '${param.name}'`, 1, 1);
    }

    if (typeof raw === "object" && raw !== null && "kind" in raw) {
      if (raw.kind === "array") {
        out.set(param.name, raw.values);
      } else {
        out.set(param.name, raw.values);
      }
      continue;
    }

    out.set(param.name, raw);
  }

  return out;
};

const evaluateExprBody = (
  fn: FunctionDef,
  bindings: Map<string, ScalarValue | ScalarValue[] | null>,
): ScalarValue | ScalarValue[] => {
  if (fn.body.kind !== "expr") {
    return null;
  }

  return evaluateFunctionExpr(fn.body.expr, bindings);
};

const evaluateFunctionExpr = (
  expr: FunctionExprDef,
  bindings: Map<string, ScalarValue | ScalarValue[] | null>,
): ScalarValue | ScalarValue[] => {
  if (expr.kind === "param_ref") {
    return (bindings.get(expr.name) ?? null) as ScalarValue | ScalarValue[];
  }

  if (expr.kind === "literal") {
    return expr.value;
  }

  const evaluatedParts = expr.parts.map((part) => {
    if (part.kind === "param_ref") {
      return bindings.get(part.name) ?? null;
    }
    return part.value;
  });

  const maxLen = evaluatedParts.reduce<number>((acc, part) => (Array.isArray(part) ? Math.max(acc, part.length) : acc), 1);
  if (maxLen <= 1) {
    return evaluatedParts
      .map((part) => (Array.isArray(part) ? part[0] : part))
      .map((value) => (value === null || value === undefined ? "" : String(value)))
      .join("");
  }

  return Array.from({ length: maxLen }).map((_, index) =>
    evaluatedParts
      .map((part) => (Array.isArray(part) ? part[index] : part))
      .map((value) => (value === null || value === undefined ? "" : String(value)))
      .join(""),
  );
};

const literalToEdgeQL = (value: ScalarValue | ScalarValue[] | null): string => {
  if (Array.isArray(value)) {
    return `{${value.map((item) => literalToEdgeQL(item)).join(", ")}}`;
  }

  if (value === null || value === undefined) {
    return "<str>{}";
  }

  if (typeof value === "string") {
    return `'${value.replaceAll("'", "\\'")}'`;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
};

const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

const isScalarValue = (value: unknown): value is ScalarValue =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const isRecordRow = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const rowSourceType = (row: Record<string, unknown>, fallbackType: string): string => {
  const type = row.__source_type;
  return typeof type === "string" ? type : fallbackType;
};

const extractOverlays = (ir: IRStatement | undefined): OverlayIR[] => {
  // The IR is the DML IR (insert/update/delete) or undefined for
  // SELECT / GROUP / FOR, which execute off the Live IR's SQL artifact.
  if (!ir) return [];
  return ir.overlays;
};

const PENDING_INLINE_LINK_VALUE = "__gel_pending_inline_link__";
const PENDING_INSERT_REWRITE_VALUE = "__gel_pending_insert_rewrite__";

// Render a scalar as an EdgeQL literal for substitution into a default
// expression (`.f` → the row's actual value).
const scalarToEdgeQLLiteral = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  return undefined;
};

// Resolve property defaults that reference sibling properties of the same row.
// EdgeQL evaluates such defaults against the inserted object, so they must run
// after the row exists. We read the written row, then iteratively evaluate each
// defaulted property whose `.sibling` references are all already known — given
// values or previously-resolved defaults — substituting each `.name` with the
// row's literal value and evaluating the expression via a one-off SQL SELECT.
// Resolved values are written back with an UPDATE. (test_edgeql_insert_default_07/08)
const resolveSiblingReferencingDefaults = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  subjectType: TypeDef,
  table: string,
  rowId: string,
  ast: InsertStatement,
  context: SecurityContext,
): void => {
  // Candidate fields: have a sibling-referencing default and were NOT given an
  // explicit value in this INSERT (those keep the user value).
  const givenFields = new Set(Object.keys(ast.values ?? {}));
  const candidates = subjectType.fields.filter((f) =>
    f.hasDefault
    && !givenFields.has(f.name)
    && typeof f.defaultExprText === "string"
    && /(?:^|[^A-Za-z0-9_.])\.[A-Za-z_]/.test(f.defaultExprText),
  );
  if (candidates.length === 0) return;

  const rows = db
    .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} = ? LIMIT 1`)
    .all(rowId) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return;

  // Known = columns whose value is settled. Start with everything currently in
  // the row (given values + SQL-computed values + NULLs); candidates are
  // re-resolved below. A column counts as "resolved" once we've evaluated it.
  const resolved = new Set<string>(givenFields);
  const pending = new Map(candidates.map((f) => [f.name, f] as const));
  const updates: Record<string, ScalarValue> = {};

  const referencedFields = (text: string): string[] =>
    [...text.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);

  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const [name, field] of [...pending]) {
      const refs = referencedFields(field.defaultExprText!);
      // All referenced siblings must be resolvable: either a non-candidate
      // column (its current row value is final) or an already-resolved candidate.
      const ready = refs.every((r) => !pending.has(r) || resolved.has(r));
      if (!ready) continue;
      // Substitute each `.name` with the (current or freshly-resolved) value.
      let exprText = field.defaultExprText!;
      let substitutable = true;
      exprText = exprText.replaceAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g, (_m, ref: string) => {
        const value = ref in updates ? updates[ref] : row[ref];
        const lit = scalarToEdgeQLLiteral(value);
        if (lit === undefined) { substitutable = false; return _m; }
        return lit;
      });
      if (!substitutable) { pending.delete(name); continue; }
      const attempt = tryResult(() => {
        const parsed = parseEdgeQL(`SELECT (${exprText})`);
        const stmt = (Array.isArray(parsed) ? parsed[0] : parsed) as Statement;
        const compiled = getCompilerService().compile(schema, stmt, { globals: context.globals, target: resolvedRuntimeTarget(context, db) });
        if (!lowersToSingleSql(compiled.sql)) return undefined;
        return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
      }, { captureAll: true });
      if (attempt.ok && attempt.value !== undefined && attempt.value.length === 1 && isScalarValue(attempt.value[0])) {
        updates[name] = attempt.value[0] as ScalarValue;
        resolved.add(name);
      }
      pending.delete(name);
      progressed = true;
    }
  }

  const cols = Object.keys(updates);
  if (cols.length === 0) return;
  const setClause = cols.map((c) => `${quoteIdent(c)} = ?`).join(", ");
  db.prepare(`UPDATE ${quoteIdent(table)} SET ${setClause} WHERE ${quoteIdent("id")} = ?`)
    .run(...cols.map((c) => updates[c]), rowId);
};

// Allocate the next value for a named sequence (a user scalar type extending
// `sequence`). Values persist in a counter table so they keep climbing across
// statements and never reuse a value after deletes — matching Gel's sequence
// semantics. The atomic `UPSERT … RETURNING` increments and reads in one step.
const sequenceTableReady = new WeakSet<SQLiteDatabase>();
const nextSequenceValue = (db: SQLiteDatabase, sequenceName: string): number => {
  if (!sequenceTableReady.has(db)) {
    db.prepare(
      "CREATE TABLE IF NOT EXISTS __gel_sequences (seq_name TEXT PRIMARY KEY NOT NULL, last_value INTEGER NOT NULL)",
    ).run();
    sequenceTableReady.add(db);
  }
  const rows = db
    .prepare(
      "INSERT INTO __gel_sequences (seq_name, last_value) VALUES (?, 1) "
      + "ON CONFLICT(seq_name) DO UPDATE SET last_value = last_value + 1 RETURNING last_value",
    )
    .all(sequenceName) as Array<{ last_value?: unknown }>;
  const value = rows[0]?.last_value;
  return typeof value === "number" ? value : 1;
};

const assignableTargetTablesForTargets = (
  schema: SchemaSnapshot,
  targetTypeNames: string[],
): Set<string> => {
  const tables = new Set<string>();
  for (const targetTypeName of targetTypeNames) {
    const assignable = schema.listConcreteTypesAssignableTo(targetTypeName);
    if (assignable.length > 0) {
      for (const candidate of assignable) {
        tables.add(tableNameForType(qualifiedTypeName(candidate)));
      }
      continue;
    }

    tables.add(tableNameForType(targetTypeName));
  }

  return tables;
};

const validateLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: IRStatement,
  ast: Statement,
): void => {
  if (ir.kind !== "insert" && ir.kind !== "update") {
    return;
  }

  const typeDef = schema.listTypes().find((candidate) => tableNameForType(qualifiedTypeName(candidate)) === ir.table);
  if (!typeDef) {
    return;
  }

  for (const link of typeDef.links ?? []) {
    if (link.multi) {
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    if (!(inlineColumn in ir.values)) {
      continue;
    }

    const assignedId = ir.values[inlineColumn];
    if (assignedId === null) {
      continue;
    }
    if (assignedId === PENDING_INLINE_LINK_VALUE) {
      continue;
    }
    if (typeof assignedId !== "string") {
      throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': expected string`, ast.pos.line, ast.pos.column);
    }

    const row = db
      .prepare('SELECT "type_name" AS "type_name" FROM "__gel_global_ids" WHERE "id" = ?')
      .all(assignedId)[0] as { type_name?: unknown } | undefined;

    if (!row || typeof row.type_name !== "string") {
      throw new AppError(
        "E_SEMANTIC",
        `Invalid id for link '${link.name}': '${assignedId}' does not reference an existing object`,
        ast.pos.line,
        ast.pos.column,
      );
    }

    const targetTypeNames = normalizeLinkTargetNames(link.targetType, typeDef.module ?? "default");
    const expectedTargetTables = assignableTargetTablesForTargets(schema, targetTypeNames);
    if (!expectedTargetTables.has(row.type_name)) {
      const expected = [...expectedTargetTables].sort().join(" or ");
      throw new AppError(
        "E_SEMANTIC",
        `Invalid id for link '${link.name}': expected '${expected}', got '${row.type_name}'`,
        ast.pos.line,
        ast.pos.column,
      );
    }
  }
};

const fieldsFromShape = (shape: SelectStatement["shape"]): string[] => {
  const fields = new Set<string>(["id"]);
  for (const element of shape) {
    if (element.kind === "field") {
      fields.add(element.name);
    }
  }
  return [...fields];
};

const typeDefForTable = (schema: SchemaSnapshot, table: string): TypeDef | undefined =>
  schema.listTypes().find((candidate) => tableNameForType(qualifiedTypeName(candidate)) === table);

const typeDefForInsertIR = (schema: SchemaSnapshot, table: string): TypeDef | undefined =>
  typeDefForTable(schema, table);

// Translate SQLite's "UNIQUE constraint failed: <table>.<col>" into the Gel
// exclusivity-constraint vocabulary. Cross-type/inherited exclusive
// constraints are enforced through shared bookkeeping tables named
// `__gel_excl__<owner>__col__<prop>` (see materializeExclusivity in
// database.ts); same-type constraints trip a normal `<table>.<col>` index.
const parseExclusivityViolation = (
  message: string,
): { property: string; crossType: boolean } | undefined => {
  if (!message.includes("UNIQUE constraint failed")) return undefined;
  // Shared cross-type tables are named `__gel_excl__<owner>__col__<prop>`,
  // and their unique index appends `__excl__<prop>`. SQLite reports either the
  // `<table>.v` column (plain index) or the index name (expression index), so
  // recover the property as the segment after the last `__col__`, stopping at
  // `__excl__`, `.`, or end-of-string.
  const shared = /__col__([A-Za-z0-9_]+?)(?:__excl__|\.|$)/.exec(message);
  if (shared) {
    return { property: shared[1], crossType: true };
  }
  const direct = /UNIQUE constraint failed: [^.]+\.([A-Za-z0-9_]+)/.exec(message);
  if (direct) {
    const col = direct[1];
    const property = col.endsWith("_id") ? col.slice(0, -3) : col;
    return { property, crossType: false };
  }
  return undefined;
};

// Map a write error to EdgeQL's exclusivity-constraint diagnostic. A UNIQUE
// failure (same-table index or shared cross-type bookkeeping table, including
// the `id` PRIMARY KEY) becomes "<prop> violates exclusivity constraint";
// anything else is returned unchanged so the original error still propagates.
const translateExclusivityWriteError = (writeErr: unknown, line: number, column: number): unknown => {
  const message = String((writeErr as Error)?.message ?? writeErr);
  if (/(?:UNIQUE|PRIMARY KEY) constraint failed:.*\.id\b/.test(message)) {
    return new AppError("E_VALIDATION", "id violates exclusivity constraint", line, column);
  }
  const exclusivity = parseExclusivityViolation(message);
  if (exclusivity) {
    return new AppError("E_VALIDATION", `${exclusivity.property} violates exclusivity constraint`, line, column);
  }
  return writeErr;
};

// ── WITH-DML chain exclusivity snapshot ──────────────────────────────────
// EdgeQL runs every DML statement in a single query against ONE read snapshot,
// and validates exclusive constraints against that snapshot. A value occupied
// by some row at the start of the statement is therefore "reserved" for the
// whole statement: a sibling that frees it (UPDATE renames it away, DELETE
// removes the row) and then re-uses it in another statement is a conflict —
// even though the live row count after both run would be consistent
// (cross_type_conflict_07a/07b/08a/12, and_delete_01).
//
// We model this by snapshotting `exclusiveValue → ownerId` for every exclusive
// check covering the chain's subject types at chain start, then re-reading it
// at chain end. If any exclusive value is held by a DIFFERENT row at the end
// than at the start, some statement re-used a reserved value → conflict.
type ExclusiveSnapshot = Array<{ property: string; valueToId: Map<string, string>; valueToIds?: Map<string, Set<string>> }>;

const snapshotKeyForValue = (value: unknown): string => JSON.stringify(value);

const captureExclusiveSnapshotInternal = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  typeNames: Iterable<string>,
  trackAllIds: boolean,
): ExclusiveSnapshot => {
  const out: ExclusiveSnapshot = [];
  const seenCheckKeys = new Set<string>();
  for (const typeName of typeNames) {
    const typeDef = schema.getType(typeName);
    if (!typeDef) continue;
    for (const check of exclusiveChecksFor(schema, typeDef, undefined)) {
      // The implicit id PK never participates in value-reuse conflicts.
      if (check.fields.length === 1 && check.fields[0] === "id") continue;
      const checkKey = `${check.fields.slice().sort().join(",")}|${[...check.tables].sort().join(",")}|${check.multiProp ?? ""}`;
      if (seenCheckKeys.has(checkKey)) continue;
      seenCheckKeys.add(checkKey);
      const valueToId = new Map<string, string>();
      const valueToIds = trackAllIds ? new Map<string, Set<string>>() : undefined;
      const record = (key: string, id: string): void => {
        valueToId.set(key, id);
        if (valueToIds) {
          const set = valueToIds.get(key) ?? new Set<string>();
          set.add(id);
          valueToIds.set(key, set);
        }
      };
      if (check.multiProp) {
        // Multi scalar properties store their set as a JSON array in the data
        // table's column; expand each element to (value → owner id).
        const col = check.multiProp;
        for (const tbl of check.tables) {
          const cols = (db.prepare(`PRAGMA table_info(${quoteIdent(tbl)})`).all() as Array<{ name: string }>).map((c) => c.name);
          if (!cols.includes(col)) continue;
          const rows = db.prepare(
            `SELECT ${quoteIdent("id")} AS ${quoteIdent("id")}, ${quoteIdent(col)} AS ${quoteIdent("v")} FROM ${quoteIdent(tbl)}`,
          ).all() as Array<{ id?: unknown; v?: unknown }>;
          for (const row of rows) {
            if (typeof row.id !== "string" || row.v === null || row.v === undefined) continue;
            let elements: unknown[];
            if (typeof row.v === "string") {
              try {
                const parsed = JSON.parse(row.v);
                elements = Array.isArray(parsed) ? parsed : [parsed];
              } catch {
                elements = [row.v];
              }
            } else {
              elements = [row.v];
            }
            for (const el of elements) record(snapshotKeyForValue(el), row.id);
          }
        }
      } else {
        for (const tbl of check.tables) {
          const cols = (db.prepare(`PRAGMA table_info(${quoteIdent(tbl)})`).all() as Array<{ name: string }>).map((c) => c.name);
          if (!check.columns.every((c) => cols.includes(c))) continue;
          const hasExcept = check.exceptColumn !== undefined && cols.includes(check.exceptColumn);
          const selectCols = [...check.columns, ...(hasExcept ? [check.exceptColumn!] : [])].map((c) => quoteIdent(c)).join(", ");
          const rows = db.prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")}, ${selectCols} FROM ${quoteIdent(tbl)}`).all() as Array<Record<string, unknown>>;
          for (const row of rows) {
            if (typeof row.id !== "string") continue;
            // `except (.flag)` — rows with a truthy flag are exempt.
            if (hasExcept && (row[check.exceptColumn!] === 1 || row[check.exceptColumn!] === true)) continue;
            const vals = check.columns.map((c) => (check.lower && typeof row[c] === "string" ? (row[c] as string).toLowerCase() : row[c]));
            if (vals.some((v) => v === null || v === undefined)) continue;
            record(snapshotKeyForValue(vals), row.id);
          }
        }
      }
      // Single-property constraints report the property name; multi-field
      // (type-level tuple) constraints report the SHORT name of the type that
      // declares the constraint (EdgeQL: "Person2a violates exclusivity
      // constraint"). Find the topmost ancestor carrying the same tuple
      // constraint so an inherited constraint reports the declaring type.
      let property = check.fields.join(",");
      if (check.fields.length > 1) {
        const wanted = [...check.fields].sort().join(",");
        const declaresTuple = (t: TypeDef): boolean =>
          (t.typeConstraints ?? []).some((tc) => {
            if (!constraintIsExclusiveLike(tc)) return false;
            const refs = (tc.fieldRefs.length > 0
              ? tc.fieldRefs
              : [...(tc.exprText ?? "").matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
            return [...new Set(refs)].sort().join(",") === wanted;
          });
        let owner: TypeDef | undefined = declaresTuple(typeDef) ? typeDef : undefined;
        for (const anc of typeAncestorsOf(schema, typeDef)) {
          if (declaresTuple(anc)) owner = anc;
        }
        if (owner) {
          const qn = qualifiedTypeName(owner);
          property = qn.includes("::") ? qn.split("::").pop()! : qn;
        }
      }
      out.push({ property, valueToId, valueToIds });
    }
  }
  return out;
};

const captureExclusiveSnapshot = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  typeNames: Iterable<string>,
): ExclusiveSnapshot => captureExclusiveSnapshotInternal(db, schema, typeNames, false);

// Re-capture the same exclusive values and throw if any value is now held by a
// different row than it was at chain start (a reserved value was re-used).
const validateExclusiveSnapshot = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  typeNames: Iterable<string>,
  before: ExclusiveSnapshot,
  pos: { line: number; column: number },
): void => {
  const after = captureExclusiveSnapshotMulti(db, schema, typeNames);
  // Multiple snapshot entries can share a property label (an inherited
  // type-level constraint captured once per concrete type). Merge by property
  // so the value→ids sets are unioned rather than overwritten.
  const beforeByProp = new Map<string, Map<string, string>>();
  for (const e of before) {
    const m = beforeByProp.get(e.property) ?? new Map<string, string>();
    for (const [k, v] of e.valueToId) m.set(k, v);
    beforeByProp.set(e.property, m);
  }
  const afterByProp = new Map<string, Map<string, Set<string>>>();
  for (const e of after) {
    const m = afterByProp.get(e.property) ?? new Map<string, Set<string>>();
    for (const [k, ids] of e.valueToIds) {
      const set = m.get(k) ?? new Set<string>();
      for (const id of ids) set.add(id);
      m.set(k, set);
    }
    afterByProp.set(e.property, m);
  }
  for (const [property, afterMap] of afterByProp) {
    const beforeMap = beforeByProp.get(property);
    for (const [valueKey, afterIds] of afterMap) {
      // (a) An exclusive value now held by more than one row — two siblings
      // collided on the same (possibly new) value (07a/08a tuple constraints
      // that have no materialised DB index to catch the clash directly).
      if (afterIds.size > 1) {
        throw new AppError("E_VALIDATION", `${property} violates exclusivity constraint`, pos.line, pos.column);
      }
      // (b) A value occupied at snapshot start now held by a DIFFERENT row: a
      // sibling freed a reserved value and another re-used it.
      const beforeId = beforeMap?.get(valueKey);
      const afterId = [...afterIds][0];
      if (beforeId !== undefined && afterId !== undefined && afterId !== beforeId) {
        throw new AppError("E_VALIDATION", `${property} violates exclusivity constraint`, pos.line, pos.column);
      }
    }
  }
};

// Same as captureExclusiveSnapshot but keeps every owner id per value so the
// end-of-chain validator can detect a value held by two distinct rows.
const captureExclusiveSnapshotMulti = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  typeNames: Iterable<string>,
): Array<{ property: string; valueToIds: Map<string, Set<string>> }> => {
  const base = captureExclusiveSnapshotInternal(db, schema, typeNames, true);
  return base.map((e) => ({ property: e.property, valueToIds: e.valueToIds! }));
};

// Collect every type name referenced by a DML chain AST (subject + WITH-bound
// DML subqueries) so the snapshot only covers relevant tables.
const collectChainTypeNames = (ast: Statement, defaultModule: string): Set<string> => {
  const names = new Set<string>();
  const add = (raw: unknown): void => {
    if (typeof raw === "string" && raw.length > 0) names.add(qualifyChainType(raw, defaultModule));
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, unknown> & { kind?: string; typeName?: unknown };
    if ((n.kind === "insert" || n.kind === "update" || n.kind === "delete" || n.kind === "mutation_expr")) {
      add(n.typeName);
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "kind") continue;
      walk(v);
    }
  };
  walk(ast);
  return names;
};

const resolveConflictField = (ast: InsertStatement, typeDef: TypeDef): string | undefined => {
  if (ast.conflict?.onField) {
    return ast.conflict.onField;
  }

  for (const candidate of ["name", "title"]) {
    if (typeDef.fields.some((field) => field.name === candidate) && candidate in ast.values) {
      return candidate;
    }
  }

  return undefined;
};

const scalarFromInsertValue = (
  value: InsertValue,
  resolveBinding: (name: string) => ScalarValue,
  line: number,
  column: number,
): ScalarValue => {
  if (isScalarValue(value)) {
    return value;
  }

  if (value.kind === "binding_ref") {
    return resolveBinding(value.name);
  }

  throw new AppError("E_SEMANTIC", `Expected scalar value, got '${value.kind}'`, line, column);
};

const findConflictRowId = (
  db: SQLiteDatabase,
  table: string,
  field: string,
  value: ScalarValue,
): string | undefined => {
  const row = db
    .prepare(`SELECT "id" AS "id" FROM ${quoteIdent(table)} WHERE ${quoteIdent(field)} = ? LIMIT 1`)
    .all(value)[0] as { id?: unknown } | undefined;
  return typeof row?.id === "string" ? row.id : undefined;
};

// A single exclusive constraint reachable from an INSERT's type, normalized so
// the conflict checker can both decide whether the inserted values clash with
// an existing row and recover that row's id.
interface ExclusiveCheck {
  // The own-type fields the constraint covers (`["name"]`, `["first","bff"]`).
  fields: string[];
  // Storage columns to compare in each participating table (link → `<l>_id`).
  columns: string[];
  // Case-insensitive (`exclusive on (str_lower(__subject__))`).
  lower: boolean;
  // For a multi property the values live in a `<table>__<prop>` link table.
  multiProp?: string;
  // Concrete tables the constraint spans (this type + any type sharing it via
  // inheritance), so a parent/child clash is detected (test _18a/_18b).
  tables: string[];
  // True when the constraint is owned by a *parent* type rather than declared
  // on the inserted type itself — UNLESS CONFLICT … ELSE is rejected then
  // (test _20a), and a bare/derived conflict is still suppressed (_18b).
  fromParent: boolean;
  // `exclusive … except (.flag)` — rows whose `<flag>` column is truthy are
  // exempt from the constraint (test except_constraint_02).
  exceptColumn?: string;
}

// Parse `except (.flag)` → the bare flag column name.
const exceptColumnFrom = (exceptExpr?: string): string | undefined => {
  if (!exceptExpr) return undefined;
  const m = /\(?\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\)?/.exec(exceptExpr);
  return m ? m[1] : undefined;
};

const typeAncestorsOf = (schema: SchemaSnapshot, typeDef: TypeDef): TypeDef[] => {
  const seen = new Set<string>();
  const out: TypeDef[] = [];
  const visit = (name: string): void => {
    const t = schema.getType(name);
    if (!t || seen.has(qualifiedTypeName(t))) return;
    seen.add(qualifiedTypeName(t));
    out.push(t);
    for (const base of t.extends ?? []) visit(base);
  };
  for (const base of typeDef.extends ?? []) visit(base);
  return out;
};

const constraintIsExclusiveLike = (c: { name: string }): boolean =>
  c.name === "std::exclusive" || c.name === "exclusive";

// All concrete tables that share `field`'s exclusive constraint with `typeDef`
// — the declaring type's whole subtree (so a Person/DerivedPerson name clash is
// caught), mirroring materializeExclusivity's shared bookkeeping table.
const tablesSharingFieldConstraint = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  ownerName: string,
): string[] => {
  const tables = new Set<string>();
  for (const concrete of schema.listConcreteTypesAssignableTo(ownerName)) {
    tables.add(tableNameForType(qualifiedTypeName(concrete)));
  }
  tables.add(tableNameForType(qualifiedTypeName(typeDef)));
  return [...tables];
};

// Enumerate the exclusive constraints to test for an INSERT under UNLESS
// CONFLICT. `targetFields` restricts the set to those that exactly cover the
// `ON (...)` target; a bare UNLESS CONFLICT (undefined) tests every exclusive
// constraint reachable from the type.
const exclusiveChecksFor = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  targetFields: string[] | undefined,
): ExclusiveCheck[] => {
  const checks: ExclusiveCheck[] = [];
  const ancestors = typeAncestorsOf(schema, typeDef);

  const linkColumn = (name: string): { column: string; isLink: boolean } => {
    const link = (typeDef.links ?? []).find((l) => l.name === name);
    return link ? { column: `${name}_id`, isLink: true } : { column: name, isLink: false };
  };

  // ── Field-level single-property exclusive constraints ──
  for (const field of typeDef.fields) {
    if (field.name === "id") continue;
    const constraints = (field as { constraints?: Array<{ name: string; delegated?: boolean; onExpr?: string; exceptExpr?: string }> }).constraints ?? [];
    const excl = constraints.find(constraintIsExclusiveLike);
    if (!excl) continue;
    // Locate the topmost ancestor declaring the same field constraint to find
    // the shared-table owner + whether it's inherited.
    let owner = typeDef;
    for (const anc of ancestors) {
      const ancField = anc.fields.find((f) => f.name === field.name) as { constraints?: Array<{ name: string }> } | undefined;
      if (ancField?.constraints?.some(constraintIsExclusiveLike)) owner = anc;
    }
    const lower = excl.onExpr !== undefined && /str_lower\s*\(\s*__subject__\s*\)/.test(excl.onExpr);
    checks.push({
      fields: [field.name],
      columns: [field.name],
      lower,
      multiProp: (field as { multi?: boolean }).multi ? field.name : undefined,
      tables: tablesSharingFieldConstraint(schema, typeDef, qualifiedTypeName(owner)),
      fromParent: qualifiedTypeName(owner) !== qualifiedTypeName(typeDef),
      exceptColumn: exceptColumnFrom(excl.exceptExpr),
    });
  }

  // ── Type-level exclusive constraints (single- or multi-field tuples) ──
  // Recover the field references a type-level constraint covers. Most carry an
  // explicit `fieldRefs`, but the `(__subject__.first, __subject__.last)` form
  // leaves it empty — derive the names from the expression text instead.
  const fieldRefsOf = (tc: { fieldRefs: string[]; exprText?: string }): string[] => {
    if (tc.fieldRefs.length > 0) return tc.fieldRefs;
    const text = tc.exprText ?? "";
    const refs: string[] = [];
    const re = /(?:__subject__|)\s*\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) refs.push(m[1]);
    return refs;
  };

  const collectTypeConstraints = (t: TypeDef, parent: boolean): void => {
    for (const tc of t.typeConstraints ?? []) {
      if (!constraintIsExclusiveLike(tc)) continue;
      const fields = fieldRefsOf(tc);
      if (fields.length === 0) continue;
      const columns = fields.map((f) => linkColumn(f).column);
      const lower = /str_lower\s*\(\s*__subject__\s*\)/.test(tc.exprText ?? "");
      const tables = new Set<string>();
      for (const concrete of schema.listConcreteTypesAssignableTo(qualifiedTypeName(t))) {
        tables.add(tableNameForType(qualifiedTypeName(concrete)));
      }
      tables.add(tableNameForType(qualifiedTypeName(typeDef)));
      checks.push({ fields, columns, lower, tables: [...tables], fromParent: parent, exceptColumn: exceptColumnFrom((tc as { exceptExpr?: string }).exceptExpr) });
    }
  };
  collectTypeConstraints(typeDef, false);
  for (const anc of ancestors) collectTypeConstraints(anc, true);

  // The implicit `id` PRIMARY KEY is exclusive on every type. It only matters
  // under `allow_user_specified_id` (otherwise ids are server-generated and
  // never clash) — included so `UNLESS CONFLICT ON (.id)` / bare UNLESS
  // CONFLICT can suppress an explicit-id duplicate (test explicit_id_05).
  checks.push({
    fields: ["id"],
    columns: ["id"],
    lower: false,
    tables: [tableNameForType(qualifiedTypeName(typeDef))],
    fromParent: false,
  });

  if (targetFields === undefined) return checks;
  const want = JSON.stringify([...targetFields].sort());
  return checks.filter((c) => JSON.stringify([...c.fields].sort()) === want);
};

// Given an exclusive check and the resolved storage-column values the INSERT is
// about to write, find an existing row that already holds those values. Returns
// its id, or undefined when there is no clash. Multi-property checks scan the
// link table for any overlapping value.
const findExclusiveConflictId = (
  db: SQLiteDatabase,
  check: ExclusiveCheck,
  values: Record<string, ScalarValue | undefined>,
): string | undefined => {
  // A null value for any covered column means "no value" — exclusive
  // constraints ignore empty sets, so there can be no conflict.
  if (check.multiProp) {
    const raw = values[check.multiProp];
    const items: ScalarValue[] = Array.isArray(raw) ? raw as ScalarValue[] : raw === undefined || raw === null ? [] : [raw];
    if (items.length === 0) return undefined;
    for (const tbl of check.tables) {
      const linkTbl = `${tbl}__${check.multiProp.toLowerCase()}`;
      const exists = (db.prepare(`PRAGMA table_info(${quoteIdent(linkTbl)})`).all() as Array<{ name: string }>);
      if (exists.length === 0) continue;
      const valueCol = exists.some((c) => c.name === "value") ? "value" : exists.some((c) => c.name === "target") ? "target" : undefined;
      const srcCol = exists.some((c) => c.name === "source") ? "source" : "src";
      if (!valueCol) continue;
      const placeholders = items.map(() => "?").join(", ");
      const row = db
        .prepare(`SELECT ${quoteIdent(srcCol)} AS ${quoteIdent("id")} FROM ${quoteIdent(linkTbl)} WHERE ${quoteIdent(valueCol)} IN (${placeholders}) LIMIT 1`)
        .all(...items)[0] as { id?: unknown } | undefined;
      if (typeof row?.id === "string") return row.id;
    }
    return undefined;
  }

  const colValues = check.columns.map((col) => values[col]);
  if (colValues.some((v) => v === undefined || v === null)) return undefined;
  for (const tbl of check.tables) {
    const cols = (db.prepare(`PRAGMA table_info(${quoteIdent(tbl)})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!check.columns.every((c) => cols.includes(c))) continue;
    const wheres = check.columns
      .map((col) => (check.lower ? `lower(${quoteIdent(col)}) = lower(?)` : `${quoteIdent(col)} = ?`))
      .join(" AND ");
    const row = db
      .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(tbl)} WHERE ${wheres} LIMIT 1`)
      .all(...colValues as ScalarValue[])[0] as { id?: unknown } | undefined;
    if (typeof row?.id === "string") return row.id;
  }
  return undefined;
};

// Recursively scan an INSERT value expression for volatile function calls
// (`random`, `datetime_current`, …) so UNLESS CONFLICT ON can reject a volatile
// conflict target (test _16b).
// Resolve a (possibly multi) INSERT value to the flat list of scalar values it
// produces — used for multi-property conflict targets (`name := {'a','b'}`).
const insertValueToScalarSet = (
  value: InsertValue | undefined,
  ast: Statement,
  context: SecurityContext,
  line: number,
  column: number,
): ScalarValue[] => {
  if (value === undefined || value === null) return [];
  if (isScalarValue(value)) return [value];
  const v = value as { kind?: string; values?: unknown[]; value?: unknown; name?: string };
  if (v.kind === "set_literal" || v.kind === "set") {
    const items = (v.values ?? []) as InsertValue[];
    return items.flatMap((item) => insertValueToScalarSet(item, ast, context, line, column));
  }
  if (v.kind === "literal" && isScalarValue(v.value)) return [v.value as ScalarValue];
  if (v.kind === "binding_ref" && typeof v.name === "string") {
    const resolve = makeBindingResolver(ast, context, line, column);
    const resolved = resolve(v.name);
    return Array.isArray(resolved) ? resolved as ScalarValue[] : [resolved];
  }
  // A single scalar wrapped in an expr node.
  return [scalarFromInsertValue(value, makeBindingResolver(ast, context, line, column), line, column)];
};

// After a UNIQUE write failure under UNLESS CONFLICT, decide whether the clash
// is against a row inserted earlier in the *same* statement (which must surface
// as an error, not be suppressed). Scans every exclusive check covering the
// violated property and reports true when the only conflicting existing row was
// inserted this statement.
const conflictIsAgainstSameStatementRow = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  subjectType: TypeDef,
  violatedProperty: string,
  context: SecurityContext,
): boolean => {
  const stmtIds = context.statementInsertedIds;
  if (!stmtIds || stmtIds.size === 0) return false;
  const checks = exclusiveChecksFor(schema, subjectType, undefined)
    .filter((c) => c.fields.includes(violatedProperty));
  for (const check of checks) {
    for (const tbl of check.tables) {
      const cols = (db.prepare(`PRAGMA table_info(${quoteIdent(tbl)})`).all() as Array<{ name: string }>).map((c) => c.name);
      if (check.multiProp) continue;
      if (!check.columns.every((c) => cols.includes(c))) continue;
      const rows = db.prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(tbl)}`).all() as Array<{ id?: unknown }>;
      for (const row of rows) {
        if (typeof row.id === "string" && stmtIds.has(row.id)) return true;
      }
    }
  }
  return false;
};

const VOLATILE_FUNCTION_NAMES = new Set(["random", "datetime_current", "datetime_of_transaction", "uuid_generate_v1mc", "uuid_generate_v4", "sequence_next"]);
const insertValueIsVolatile = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(insertValueIsVolatile);
  if (node === null || typeof node !== "object") return false;
  const n = node as Record<string, unknown> & { kind?: string; name?: unknown; call?: { name?: unknown } };
  const fnName = typeof n.name === "string" ? n.name : typeof n.call?.name === "string" ? n.call.name : undefined;
  if ((n.kind === "function_call" || n.kind === "func_call" || n.kind === "call") && fnName) {
    const short = fnName.includes("::") ? fnName.split("::").pop()! : fnName;
    if (VOLATILE_FUNCTION_NAMES.has(short)) return true;
  }
  for (const value of Object.values(n)) {
    if (insertValueIsVolatile(value)) return true;
  }
  return false;
};

const makeBindingResolver = (
  ast: Statement,
  context: SecurityContext,
  line: number,
  column: number,
): ((name: string) => ScalarValue) => {
  const bindings = new Map((ast.with ?? []).map((binding) => [binding.name, binding.value] as const));
  const cache = new Map<string, ScalarValue>();
  const pending = new Set<string>();

  const resolve = (name: string): ScalarValue => {
    if (cache.has(name)) {
      return cache.get(name) as ScalarValue;
    }
    if (pending.has(name)) {
      throw new AppError("E_SEMANTIC", `Cyclic with binding '${name}'`, line, column);
    }

    const binding = bindings.get(name);
    if (!binding) {
      throw new AppError("E_SEMANTIC", `Unknown with binding '${name}'`, line, column);
    }

    pending.add(name);
    let value: ScalarValue;
    if (binding.kind === "literal") {
      value = binding.value;
    } else if (binding.kind === "binding_ref") {
      value = resolve(binding.name);
    } else if (binding.kind === "parameter") {
      const globals = context.globals ?? {};
      if (!Object.prototype.hasOwnProperty.call(globals, binding.name)) {
        throw new AppError("E_SEMANTIC", `Unknown query parameter '$${binding.name}'`, line, column);
      }
      value = globals[binding.name] as ScalarValue;
    } else {
      throw new AppError("E_SEMANTIC", `With binding '${name}' is a subquery and cannot be scalar`, line, column);
    }

    pending.delete(name);
    cache.set(name, value);
    return value;
  };

  return resolve;
};

const executeSelectExprRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: Extract<InsertValue, { kind: "select" }>,
  context: SecurityContext,
): Record<string, unknown>[] => {
  const shape = expr.shape.length > 0 ? [...expr.shape] : [{ kind: "field", name: "id" } as const];
  const hasId = shape.some((element) => element.kind === "field" && element.name === "id");
  if (!hasId) {
    shape.unshift({ kind: "field", name: "id" });
  }
  const ast: SelectStatement = {
    kind: "select",
    with: expr.clauses._withBindings,
    withModule: expr.clauses._withModule,
    withModuleAliases: expr.clauses._withModuleAliases,
    typeName: expr.typeName,
    shape,
    fields: fieldsFromShape(shape),
    filter: expr.clauses.filter,
    orderBy: expr.clauses.orderBy,
    limit: expr.clauses.limit,
    offset: expr.clauses.offset,
    pos: { line: 1, column: 1 },
  };

  const compiler = getCompilerService();
  const compiled = compiler.compile(schema, ast, { globals: context.globals, params: context.params });
  assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
  if (compiled.ir !== undefined) {
    return [];
  }
  return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql, { keepInternalId: true })
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
};

const statementTypeOf = (statement: Statement): "select" | "insert" | "update" | "delete" => {
  if (statement.kind === "for") {
    return statement.body.kind === "insert" ? "insert" : "select";
  }
  if (statement.kind === "select" || statement.kind === "insert" || statement.kind === "update" || statement.kind === "delete") {
    return statement.kind;
  }
  return "select";
};

const normalizeSecurityContext = (context: SecurityContext): SecurityContext => {
  return {
    roleName: context.roleName ?? DEFAULT_SECURITY_CONTEXT.roleName,
    isSuperuser: context.isSuperuser ?? DEFAULT_SECURITY_CONTEXT.isSuperuser,
    permissions: context.permissions ? [...context.permissions] : [...(DEFAULT_SECURITY_CONTEXT.permissions ?? [])],
    globals: { ...(DEFAULT_SECURITY_CONTEXT.globals ?? {}), ...(context.globals ?? {}) },
    params: context.params ? { ...context.params } : undefined,
    runtimeTarget: context.runtimeTarget ?? DEFAULT_SECURITY_CONTEXT.runtimeTarget,
    strictUserDDL: context.strictUserDDL ?? DEFAULT_SECURITY_CONTEXT.strictUserDDL,
  };
};

const enforceBuiltinPermissions = (
  context: SecurityContext,
  statementType: "select" | "insert" | "update" | "delete",
  line: number,
  column: number,
): void => {
  if (context.isSuperuser) {
    return;
  }

  if (statementType === "insert" || statementType === "update" || statementType === "delete") {
    if (!hasPermission(context, "sys::perm::data_modification")) {
      throw new AppError(
        "E_RUNTIME",
        "Permission denied: 'sys::perm::data_modification' is required for data modification statements",
        line,
        column,
      );
    }
  }
};

// Evaluate an access policy's `USING (...)` predicate for one subject object by
// running it through the full pipeline (parse → AST → IR → SQL): we project the
// predicate as a computed shape element on the subject's type, filtered to the
// subject's id, and read back the boolean. Inside the shape the implicit source
// is the subject, so leading-dot paths (`.deck`, `.vals`) and the group/count
// machinery lower as a correlated subquery — exactly the top-level group shape
// path, no regex and no special-cased condition kinds.
//
// Policy predicates are themselves evaluated WITHOUT applying access policies
// (an elevated context), mirroring Gel — otherwise a SELECT policy on the same
// type would recurse.
const evaluatePolicyUsingExpr = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  context: SecurityContext,
  typeDef: TypeDef,
  subjectId: string,
  usingExprText: string,
): boolean => {
  const qname = qualifiedTypeName(typeDef);
  const moduleName = typeDef.module ?? (qname.includes("::") ? qname.slice(0, qname.lastIndexOf("::")) : "default");
  const shortName = qname.includes("::") ? qname.slice(qname.lastIndexOf("::") + 2) : qname;
  // subjectId is a DB-generated UUID (hex + dashes), safe to inline as an
  // EdgeQL uuid literal.
  const query = `with module ${moduleName}\n`
    + `select ${shortName} { __ap_check := (${usingExprText}) } filter .id = <uuid>'${subjectId}'`;
  const elevated: SecurityContext = { ...context, isSuperuser: true };
  const probe = tryResult(
    () => executeQueryWithTraceImpl(db, schema, query, elevated),
    { captureAll: true },
  );
  if (!probe.ok || probe.value.result.kind !== "select" || !Array.isArray(probe.value.result.rows)) {
    return false;
  }
  const row = probe.value.result.rows[0] as Record<string, unknown> | undefined;
  return row?.__ap_check === true;
};

// Build the `evalUsingExpr` injection access_policy.ts uses to resolve a
// predicate-bearing policy against a concrete subject row (keyed by id).
const policyExprEvaluator = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  context: SecurityContext,
  subjectType: TypeDef,
): PolicyExprEvaluator => (policy, row) => {
  const id = row.id;
  if (typeof id !== "string" || policy.usingExprText === undefined) return false;
  return evaluatePolicyUsingExpr(db, schema, context, subjectType, id, policy.usingExprText);
};

const runWriteWithAccessPolicies = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  ir: IRStatement | undefined,
  sqlArtifact: SQLArtifact,
  subjectType: TypeDef,
  context: SecurityContext,
  // Per-statement memo for snapshot-valued expression defaults. A FOR loop that
  // inserts N rows shares one cache so a `default := (SELECT count(T))`-style
  // default is evaluated ONCE against the pre-statement snapshot and reused for
  // every row (matching upstream "deterministic, same for all"). Separate
  // top-level INSERT statements each pass their own (or none), so the snapshot
  // advances between statements.
  snapshotDefaultCache?: Map<string, ScalarValue>,
): { changes: number; rows?: Record<string, unknown>[] } => {
  // The write path is only reached for insert/update/delete, for which the
  // compiler always produces a DML IR. Assert it so the rest of the body can
  // treat `ir` as present.
  if (!ir) {
    throw new AppError("E_RUNTIME", "invariant: write path requires a DML IR");
  }
  validateLinkAssignments(db, schema, ir, ast);

  if (ast.kind === "update") {
    const readonlyFields = new Set(subjectType.fields.filter((field) => field.readonly).map((field) => field.name));
    const readonlyLinks = new Set((subjectType.links ?? []).filter((link) => link.readonly).map((link) => link.name));
    for (const fieldName of Object.keys(ast.values)) {
      if (readonlyFields.has(fieldName) || readonlyLinks.has(fieldName)) {
        throw new AppError("E_SEMANTIC", `cannot update read-only pointer '${fieldName}'`, ast.pos.line, ast.pos.column);
      }
    }
  }

  const applyOnTargetDeletePolicies = (targetType: TypeDef, targetIds: string[], astPos: { line: number; column: number }): void => {
    if (targetIds.length === 0) {
      return;
    }

    const targetQualifiedName = qualifiedTypeName(targetType);

    const linkTargetsType = (link: NonNullable<TypeDef["links"]>[number], sourceModule: string): boolean => {
      const targets = normalizeLinkTargetNames(link.targetType, sourceModule);
      return targets.some((target) => {
        if (target === targetQualifiedName) {
          return true;
        }
        return schema.concreteTypeNamesUnder(target).includes(targetQualifiedName);
      });
    };

    for (const sourceType of schema.listTypes()) {
      const sourceQualifiedName = qualifiedTypeName(sourceType);
      const sourceTable = tableNameForType(sourceQualifiedName);
      const sourceModule = sourceType.module ?? "default";

      for (const link of sourceType.links ?? []) {
        if (!link.onTargetDelete || !linkTargetsType(link, sourceModule)) {
          continue;
        }

        const sourceIds = new Set<string>();

        if (usesLinkTable(link)) {
          const linkTable = linkTableName(qualifiedTypeName(resolveLinkStorageOwner(schema, sourceType, link)), link);
          const placeholders = targetIds.map(() => "?").join(", ");
          const rows = db
            .prepare(`SELECT ${quoteIdent("source")} AS ${quoteIdent("source")} FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("target")} IN (${placeholders})`)
            .all(...targetIds) as Array<{ source?: unknown }>;
          for (const row of rows) {
            if (typeof row.source === "string") {
              sourceIds.add(row.source);
            }
          }
        } else {
          const inlineColumn = `${link.name}_id`;
          const placeholders = targetIds.map(() => "?").join(", ");
          const rows = db
            .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent(inlineColumn)} IN (${placeholders})`)
            .all(...targetIds) as Array<{ id?: unknown }>;
          for (const row of rows) {
            if (typeof row.id === "string") {
              sourceIds.add(row.id);
            }
          }
        }

        if (sourceIds.size === 0) {
          continue;
        }

        if (link.onTargetDelete === "restrict" || link.onTargetDelete === "deferred_restrict") {
          throw new AppError(
            "E_SEMANTIC",
            `deletion of '${targetQualifiedName}' is restricted by link '${sourceQualifiedName}.${link.name}'`,
            astPos.line,
            astPos.column,
          );
        }

        if (link.onTargetDelete === "delete_source") {
          const sourceIdList = [...sourceIds];
          const placeholders = sourceIdList.map(() => "?").join(", ");
          db.prepare(`DELETE FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent("id")} IN (${placeholders})`).run(...sourceIdList);
        }
      }
    }
  };

  // Nest safely inside a client-managed transaction (Client.transaction):
  // SQLite forbids BEGIN-in-BEGIN, so fall back to a savepoint when a
  // transaction is already open on this connection. The db wrapper doesn't
  // expose `inTransaction`, so probe by attempting the BEGIN.
  let dmlUsesSavepoint = false;
  try {
    db.prepare("BEGIN").run();
  } catch (txErr) {
    if (!String((txErr as Error).message ?? txErr).includes("within a transaction")) {
      throw txErr;
    }
    dmlUsesSavepoint = true;
    db.prepare("SAVEPOINT gel_dml").run();
  }
  try {
    if (ir.kind === "insert") {
      const insertValues: Record<string, ScalarValue> = { ...ir.values };
      applyPendingInsertDefaults(insertValues, {
        subjectType,
        snapshotDefaultCache,
        evalSelect: (stmt) => {
          const compiled = getCompilerService().compile(schema, stmt, { globals: context.globals, params: context.params, target: resolvedRuntimeTarget(context, db) });
          if (!lowersToSingleSql(compiled.sql)) return undefined;
          return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
        },
        evalFunctionCall: (name, args) => executeFunctionCall(schema, db, context, name, args),
        isResolvedSourceValue: (v) =>
          v !== undefined && v !== PENDING_INSERT_REWRITE_VALUE && v !== PENDING_INLINE_LINK_VALUE && v !== PENDING_INSERT_SQL_EXPR_VALUE,
        isPendingRewriteValue: (v) => v === PENDING_INSERT_REWRITE_VALUE,
      });

      // Fill sequence-backed properties left pending by the planner with the
      // sequence's next value (a fresh allocation per inserted row).
      for (const field of subjectType.fields) {
        if (insertValues[field.name] !== PENDING_INSERT_SEQUENCE_VALUE) continue;
        const sequenceName = fieldSequenceName(schema, field);
        if (sequenceName === undefined) continue;
        insertValues[field.name] = nextSequenceValue(db, sequenceName);
      }

      if (ast.kind === "insert") {
        for (const link of subjectType.links ?? []) {
          if (usesLinkTable(link)) {
            continue;
          }
          if (!Object.prototype.hasOwnProperty.call(ast.values, link.name)) {
            continue;
          }

          const inlineColumn = `${link.name}_id`;
          const targets = resolveInsertTargets(db, schema, ast.values[link.name], context, ast);
          insertValues[inlineColumn] = targets[0]?.id ?? null;
        }
      }

      const normalizedEntries = Object.entries(insertValues).filter(([column, value]) => {
        if (column === "id") {
          // Auto-generated ids never reach ir.values (the SQLite column default
          // produces them). An `id` entry is therefore only present when the
          // INSERT supplied an explicit id under allow_user_specified_id — keep
          // that so it's written instead of generating a fresh uuid.
          return typeof value === "string" && value.length > 0;
        }
        if (value === PENDING_INLINE_LINK_VALUE || value === PENDING_INSERT_REWRITE_VALUE) {
          return false;
        }
        return true;
      });

      // The final column set is known only now — after defaults, sequences,
      // and inline-link targets resolve — so the INSERT row SQL is emitted at
      // write time by the pure builder in runtime/dml_sql.ts. See docs/adr/0046.
      const builtInsert = buildInsertRowSql(ir.table, normalizedEntries, sqlArtifact.insertColumns ?? [], ast.pos);
      sqlArtifact.sql = builtInsert.sql;
      sqlArtifact.params = builtInsert.params;
      // The compiled SQL expressions for planner-deferred columns, reused by
      // the UNLESS CONFLICT resolved-value probe further below.
      const sqlExprByColumn = new Map((sqlArtifact.insertColumns ?? []).map((entry) => [entry.column, entry]));

      // Access-policy enforcement runs AFTER the row + its links are written
      // (see below), so a `USING (...)` predicate over the inserted object's
      // links (e.g. `count((group .deck by .element)) = 2`) can read the just
      // -written state; a violation throws and the enclosing savepoint rolls
      // the insert back. Predicate-free policies are also checked there.

      // Validate an explicit `UNLESS CONFLICT ON .prop` target: the property
      // must exist on the inserted type and carry exactly one exclusive
      // constraint (mirroring the Gel compiler's checks). Skip for
      // DDL-synthesized types, whose constraint metadata isn't fully tracked
      // (the runtime CREATE TYPE pre-pass drops `CREATE CONSTRAINT`), to avoid
      // false positives.
      const ddlTracked = subjectType.ddlSynthesized
        || (subjectType.extends ?? []).some((b) => schema.getType(b)?.ddlSynthesized);
      if (!ddlTracked && ast.kind === "insert" && ast.conflict?.onField !== undefined
          && ast.conflict.onFields === undefined && ast.conflict.onField !== "id") {
        const onProp = ast.conflict.onField;
        const fieldDef = subjectType.fields.find((f) => f.name === onProp);
        if (!fieldDef) {
          throw new AppError(
            "E_SEMANTIC",
            "UNLESS CONFLICT argument must be a property of the type being inserted",
            ast.pos.line,
            ast.pos.column,
          );
        }
        const fieldExclusive = ((fieldDef as { constraints?: Array<{ name: string }> }).constraints ?? []).some(
          (c) => c.name === "std::exclusive" || c.name === "exclusive",
        );
        const typeExclusive = (subjectType.typeConstraints ?? []).some(
          (c) => (c.name === "std::exclusive" || c.name === "exclusive") && c.fieldRefs.length === 1 && c.fieldRefs[0] === onProp,
        );
        if (!fieldExclusive && !typeExclusive) {
          throw new AppError(
            "E_SEMANTIC",
            "UNLESS CONFLICT property must have a single exclusive constraint",
            ast.pos.line,
            ast.pos.column,
          );
        }
      }

      // A volatile conflict-target value (`name := <str>math::floor(random()*2)`
      // ON (.name)) can't be reconciled with an existing row — reject it
      // (test _16b). Only applies when an explicit ON target names the field.
      if (!ddlTracked && ast.kind === "insert" && ast.conflict) {
        const onTargetFields = ast.conflict.onFields ?? (ast.conflict.onField !== undefined ? [ast.conflict.onField] : undefined);
        if (onTargetFields) {
          for (const targetField of onTargetFields) {
            if (insertValueIsVolatile(ast.values[targetField])) {
              throw new AppError(
                "E_SEMANTIC",
                "INSERT UNLESS CONFLICT ON does not support volatile properties",
                ast.pos.line,
                ast.pos.column,
              );
            }
          }
        }
      }

      if (ast.kind === "insert" && ast.conflict && !ddlTracked) {
        // Conflict target → the exclusive constraints to test. An explicit
        // `ON (...)` restricts to the constraint over exactly those fields; a
        // bare UNLESS CONFLICT tests every exclusive constraint on the type.
        const targetFields = ast.conflict.onFields ?? (ast.conflict.onField !== undefined ? [ast.conflict.onField] : undefined);
        const checks = exclusiveChecksFor(schema, subjectType, targetFields);

        if (checks.length > 0) {
          // `UNLESS CONFLICT … ELSE` is illegal when the matched constraint is
          // inherited from a parent type AND the ELSE branch reads the inserted
          // (child) type itself: the conflicting row may be a parent-only row
          // the child-typed ELSE can't see (test _20a). An ELSE that targets
          // the parent type is fine — it correctly reaches that row (test
          // _20b: `ELSE (UPDATE Person …)` while inserting DerivedPerson).
          if (ast.conflict.else && checks.some((c) => c.fromParent)) {
            const elseType = qualifyChainType(ast.conflict.else.typeName, ast.withModule ?? "default");
            const insertedType = qualifiedTypeName(subjectType);
            if (elseType === insertedType) {
              throw new AppError(
                "E_SEMANTIC",
                "UNLESS CONFLICT can not use ELSE when constraint is from a parent type",
                ast.pos.line,
                ast.pos.column,
              );
            }
          }

          // Resolve the own-table storage values the insert is about to write
          // for every column the checks reference (literals from insertValues,
          // SQL-deferred columns evaluated once).
          const neededColumns = new Set<string>();
          for (const c of checks) {
            for (const col of c.columns) neededColumns.add(col);
            if (c.multiProp) neededColumns.add(c.multiProp);
          }
          const resolvedColumnValues: Record<string, ScalarValue | undefined> = {};
          for (const col of neededColumns) {
            // Multi-property: the raw insert value is the (possibly multi)
            // set of values, not an own-table column.
            if (checks.some((c) => c.multiProp === col)) {
              const rawMulti = ast.values[col];
              const attempt = tryResult(() => insertValueToScalarSet(rawMulti, ast, context, ast.pos.line, ast.pos.column), { captureAll: true });
              resolvedColumnValues[col] = attempt.ok ? attempt.value as unknown as ScalarValue : undefined;
              continue;
            }
            if (Object.prototype.hasOwnProperty.call(insertValues, col)
                && insertValues[col] !== PENDING_INSERT_SQL_EXPR_VALUE
                && insertValues[col] !== PENDING_INLINE_LINK_VALUE
                && insertValues[col] !== PENDING_INSERT_REWRITE_VALUE
                && isScalarValue(insertValues[col])) {
              resolvedColumnValues[col] = insertValues[col];
              continue;
            }
            const compiledColumn = sqlExprByColumn.get(col);
            if (compiledColumn) {
              const attempt = tryResult(() => {
                const row = db.prepare(`SELECT ${compiledColumn.sql} AS ${quoteIdent("v")}`).all(...compiledColumn.params)[0] as { v?: unknown } | undefined;
                return row && isScalarValue(row.v) ? row.v : undefined;
              }, { captureAll: true });
              resolvedColumnValues[col] = attempt.ok ? attempt.value : undefined;
            }
          }

          let existingId: string | undefined;
          for (const check of checks) {
            const found = findExclusiveConflictId(db, check, resolvedColumnValues);
            // Ignore a clash against a row inserted earlier in this same
            // statement — that must surface as a hard error, not be suppressed
            // (tests cross_type_conflict_08/09, self_01/02/03).
            if (found && !context.statementInsertedIds?.has(found)) {
              existingId = found;
              break;
            }
          }

          if (existingId) {
            if (ast.conflict.else?.kind === "update") {
              // Run the ELSE UPDATE as a real DML statement scoped to the
              // conflicting row so its SET expressions (`'super ' ++ .tag`,
              // `<str>$0`, WITH-binding refs) evaluate correctly.
              const elseUpdate: UpdateStatement = {
                kind: "update",
                with: (ast as { with?: WithBinding[] }).with,
                withModule: (ast as { withModule?: string }).withModule,
                withModuleAliases: (ast as { withModuleAliases?: WithModuleAlias[] }).withModuleAliases,
                typeName: ast.conflict.else.typeName,
                filter: { kind: "predicate", target: { kind: "field", field: "id" }, op: "=", value: existingId } as unknown as UpdateStatement["filter"],
                values: ast.conflict.else.values,
                operations: ast.conflict.else.operations,
                pos: ast.pos,
              } as unknown as UpdateStatement;
              db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
              executeDmlChainStatement(db, schema, elseUpdate, new Map(), undefined, context, ast.withModule ?? "default");
              return { changes: 1, rows: [{ id: existingId, __tid__: existingId, __tname__: qualifiedTypeName(subjectType), __source_type: qualifiedTypeName(subjectType) }] };
            }

            db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
            // ELSE <expr> yields the conflicting row; plain UNLESS CONFLICT
            // yields the empty set (an empty rows array so the result reads
            // as `[]`, e.g. test_edgeql_insert_explicit_id_05).
            return ast.conflict.else
              ? { changes: 0, rows: [{ id: existingId, __tid__: existingId, __tname__: qualifiedTypeName(subjectType), __source_type: qualifiedTypeName(subjectType) }] }
              : { changes: 0, rows: [] };
          }
        }
      }

      let writeResult: { changes: number };
      try {
        writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
      } catch (writeErr) {
        const exclusivity = parseExclusivityViolation(String((writeErr as Error).message ?? writeErr));
        // UNLESS CONFLICT (without ELSE) suppresses conflicts the static
        // pre-check above couldn't resolve — the UNIQUE failure IS the
        // conflict, so the insert quietly does nothing. Plain UNLESS CONFLICT
        // (no ON target) only covers conflicts on the inserted type itself; a
        // shared cross-type constraint clash still surfaces as an error.
        if (ast.kind === "insert" && ast.conflict && !ast.conflict.else && exclusivity) {
          // A `UNLESS CONFLICT ON (...)` target only suppresses clashes on the
          // properties it names — a conflict on a *different* exclusive
          // constraint still surfaces (test _22: `ON (.foo)` does not swallow a
          // `bar` violation). A bare UNLESS CONFLICT covers any same-type
          // constraint but not a shared cross-type one.
          const onTargetFields = ast.conflict.onFields ?? (ast.conflict.onField !== undefined ? [ast.conflict.onField] : undefined);
          // This catch path only fires for conflicts the pre-check above did
          // NOT resolve. For a fully-tracked schema that means the clashing row
          // did not exist before this statement — i.e. a same-statement
          // cross-type conflict, which Gel surfaces as an error (tests
          // cross_type_conflict_08/09). Pre-existing cross-type clashes are
          // already suppressed by the pre-check. DDL-synthesized types skip the
          // pre-check, so the shared cross-type bookkeeping table is the only
          // signal — keep suppressing those (test _22's Baz C/D/E).
          // A clash against a row inserted earlier in this same statement is a
          // hard error, never suppressed (tests self_01/02/03,
          // cross_type_conflict_08/09). The conflicting value lives in the
          // shared/own exclusivity table keyed by the violated property; if the
          // only matching row was inserted this statement, refuse suppression.
          const sameStatement = conflictIsAgainstSameStatementRow(db, schema, subjectType, exclusivity.property, context);
          const suppress = !sameStatement && (onTargetFields !== undefined
            ? onTargetFields.includes(exclusivity.property)
            : (!exclusivity.crossType || ddlTracked));
          if (suppress) {
            db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
            return { changes: 0, rows: [] };
          }
        }
        // A plain UNIQUE failure with no parsed exclusivity metadata still
        // suppresses under UNLESS CONFLICT (no ELSE), unless the clash is
        // against a same-statement row.
        if (ast.kind === "insert" && ast.conflict && !ast.conflict.else && !exclusivity
            && String((writeErr as Error).message ?? writeErr).includes("UNIQUE constraint failed")) {
          db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
          return { changes: 0, rows: [] };
        }
        // An explicit id that duplicates an existing object fails the id
        // PRIMARY KEY (same table) or the `__gel_global_ids` PRIMARY KEY (a
        // different type sharing the id space — the AFTER INSERT trigger writes
        // every new id there). Both surface as a SQLite UNIQUE/PRIMARY KEY
        // failure on an `id` column; map them to EdgeQL's exclusivity wording
        // (test_edgeql_insert_explicit_id_02 / _03).
        const writeErrMessage = String((writeErr as Error).message ?? writeErr);
        if (/(?:UNIQUE|PRIMARY KEY) constraint failed:.*\.id\b/.test(writeErrMessage)) {
          throw new AppError(
            "E_VALIDATION",
            "id violates exclusivity constraint",
            ast.pos.line,
            ast.pos.column,
          );
        }
        if (exclusivity) {
          throw new AppError(
            "E_VALIDATION",
            `${exclusivity.property} violates exclusivity constraint`,
            ast.pos.line,
            ast.pos.column,
          );
        }
        // A SQL-lowered assignment that evaluates to the empty set inserts
        // NULL; the schema's NOT NULL constraint then fires. Surface it with
        // EdgeQL's required-pointer wording instead of SQLite's.
        const match = /NOT NULL constraint failed: [^.]+\.(\S+)/.exec(String((writeErr as Error).message ?? writeErr));
        if (match) {
          const column = match[1];
          const linkName = column.endsWith("_id") ? column.slice(0, -3) : undefined;
          const isLink = linkName !== undefined && (subjectType.links ?? []).some((link) => link.name === linkName);
          throw new AppError(
            "E_VALIDATION",
            `missing value for required ${isLink ? "link" : "property"} '${isLink ? linkName : column}' of object type '${qualifiedTypeName(subjectType)}'`,
            ast.pos.line,
            ast.pos.column,
          );
        }
        throw writeErr;
      }

      let insertedId: string | undefined;
      if (ast.kind === "insert") {
        const inserted = db
          .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(ir.table)} ORDER BY rowid DESC LIMIT 1`)
          .all()[0] as { id?: unknown } | undefined;
        if (typeof inserted?.id === "string") {
          insertedId = inserted.id;
          context.statementInsertedIds?.add(inserted.id);
          const postInsertIR = {
            ...ir,
            linkAssignments: ir.linkAssignments?.filter((assignment) => assignment.storage !== "inline"),
          };
          applyInsertLinkAssignments(db, schema, postInsertIR, ast, inserted.id, context);
        }
        // Property defaults that reference sibling properties (`default := .f`,
        // `default := 'a=' ++ .b`) can't be resolved before the row exists —
        // the referenced values may themselves be SQL-computed (`f := random()`)
        // or other defaults. Resolve them against the written row now, in
        // dependency order, then patch the row (test_edgeql_insert_default_07/08).
        if (typeof inserted?.id === "string") {
          resolveSiblingReferencingDefaults(db, schema, subjectType, ir.table, inserted.id, ast, context);
        }
      }

      if (typeof insertedId === "string") {
        const insertedRow = readRowById(db, ir.table, insertedId) ?? { id: insertedId };
        enforceInsertPolicies(
          subjectType,
          insertedRow,
          context,
          ast.pos.line,
          ast.pos.column,
          policyExprEvaluator(db, schema, context, subjectType),
        );
      }

      db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
      // Expose the same type-metadata columns a SELECT/DELETE returning row
      // carries (`__tid__`, `__tname__`, `__source_type`) so a bare INSERT's
      // free shape behaves like any object set — clients/tooling that inspect
      // the object's type (test_edgeql_insert_returning_02) see them, while
      // result comparison ignores extra keys.
      const insertMeta = ast.kind === "insert"
        ? { __tid__: insertedId, __tname__: qualifiedTypeName(subjectType), __source_type: qualifiedTypeName(subjectType) }
        : {};
      return { changes: writeResult.changes, rows: insertedId !== undefined ? [{ id: insertedId, ...insertMeta }] : undefined };
    }

    if (ir.kind === "update") {
      const preRows = ast.kind === "update"
        ? readTargetRowsForAssignableTypes(db, schema, subjectType, ir.filter)
        : readTargetRowsForFilter(db, ir.table, ir.filter);
      enforceUpdateReadPolicies(subjectType, preRows, context, ast.pos.line, ast.pos.column, policyExprEvaluator(db, schema, context, subjectType));
      // When an UPDATE assigns only links (or `SET {}`), the column-level base
      // statement degrades to a no-op self-assignment (`SET "id" = g0_w."id"`).
      // Skip running it — the real work happens in applyUpdateLinkAssignments,
      // and the matched-row count is just the pre-read row count.
      const baseIsNoop = /SET "id" = g0_w\."id" (?:FROM|WHERE)/.test(sqlArtifact.sql);
      let writeResult: { changes: number };
      if (baseIsNoop) {
        writeResult = { changes: preRows.length };
      } else {
        try {
          writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
        } catch (writeErr) {
          // An UPDATE that drives a value into an existing exclusive value trips
          // a UNIQUE failure (same-table index or shared cross-type table).
          // Translate it to EdgeQL's exclusivity wording before it propagates.
          throw translateExclusivityWriteError(writeErr, ast.pos.line, ast.pos.column);
        }
      }
      if (ast.kind === "update") {
        applyUpdateMultiScalarProps(
          db,
          schema,
          subjectType,
          ir,
          ast,
          preRows.map((row) => String(row.id)),
          ast.pos,
        );
        applyUpdateLinkAssignments(
          db,
          schema,
          ir,
          ast,
          preRows.map((row) => String(row.id)),
          context,
        );
      }
      const updatedRows = preRows.length > 0 ? readRowsByIds(db, ir.table, preRows.map((row) => String(row.id))) : [];
      enforceUpdateWritePolicies(subjectType, updatedRows, context, ast.pos.line, ast.pos.column, policyExprEvaluator(db, schema, context, subjectType));
      db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
      return { changes: writeResult.changes };
    }

    if (ir.kind === "delete") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      enforceDeletePolicies(subjectType, preRows, context, ast.pos.line, ast.pos.column, policyExprEvaluator(db, schema, context, subjectType));
      applyOnTargetDeletePolicies(subjectType, preRows.map((row) => String(row.id)), ast.pos);
      if (/\bRETURNING\b/i.test(sqlArtifact.sql)) {
        const rows = db.prepare(sqlArtifact.sql).all(...sqlArtifact.params) as Record<string, unknown>[];
        db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
        return { changes: rows.length, rows };
      }
      const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
      db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
      return { changes: writeResult.changes };
    }

    const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
    db.prepare(dmlUsesSavepoint ? "RELEASE gel_dml" : "COMMIT").run();
    return { changes: writeResult.changes };
  } catch (err) {
    if (dmlUsesSavepoint) {
      db.prepare("ROLLBACK TO gel_dml").run();
      db.prepare("RELEASE gel_dml").run();
    } else {
      db.prepare("ROLLBACK").run();
    }
    throw err;
  }
};

const executeMutationBinding = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  statement: Statement,
  context: SecurityContext,
): Record<string, unknown>[] => {
  if (statement.kind !== "update" && statement.kind !== "insert" && statement.kind !== "delete") {
    return [];
  }

  const compilerService = getCompilerService();
  const runtimeTarget = resolvedRuntimeTarget(context, db);

  const expanded: Statement[] = (statement.kind === "update" || statement.kind === "delete")
    ? (expandPolymorphicMutation(schema, statement) ?? [statement])
    : [statement];

  const collected: Record<string, unknown>[] = [];

  for (const ast of expanded) {
    const compiled = compilerService.compile(schema, ast, { globals: context.globals, params: context.params, target: runtimeTarget });
    const ir = compiled.ir;
    if (!ir || (ir.kind !== "update" && ir.kind !== "insert" && ir.kind !== "delete")) {
      continue;
    }
    const subjectType = typeDefForTable(schema, ir.table);
    if (!subjectType) {
      continue;
    }
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const concreteName = qualifiedTypeName(subjectType);

    if (ir.kind === "update") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      const targetIds = preRows.map((row) => String(row.id));
      runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context);
      const postRows = readRowsByIds(db, ir.table, targetIds);
      for (const row of postRows) {
        collected.push({ ...row, __source_type: concreteName });
      }
      continue;
    }

    if (ir.kind === "delete") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context);
      const deletedRows = writeResult.rows ?? preRows;
      for (const row of deletedRows) {
        collected.push({ ...row, __source_type: concreteName });
      }
      continue;
    }

    runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context);
    const inserted = db
      .prepare(`SELECT * FROM ${quoteIdent(ir.table)} ORDER BY rowid DESC LIMIT 1`)
      .all()[0] as Record<string, unknown> | undefined;
    if (inserted) {
      collected.push({ ...inserted, __source_type: concreteName });
    }
  }

  return collected;
};

const executeNestedInsert = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: Extract<InsertValue, { kind: "insert" }>,
  context: SecurityContext,
  parentAst?: Pick<InsertStatement, "with" | "withModule" | "withModuleAliases">,
): string[] => {
  const ast: InsertStatement = {
    kind: "insert",
    with: parentAst?.with,
    withModule: parentAst?.withModule,
    withModuleAliases: parentAst?.withModuleAliases,
    typeName: expr.typeName,
    values: expr.values,
    // Preserve an UNLESS CONFLICT clause so a nested upsert
    // (`link := (INSERT T {…} UNLESS CONFLICT … ELSE …)`) resolves through the
    // conflict-aware write path (test unless_conflict_08).
    conflict: (expr as { conflict?: InsertStatement["conflict"] }).conflict,
    pos: { line: 1, column: 1 },
  };

  const compiler = getCompilerService();
  const compiled = compiler.compile(schema, ast, { globals: context.globals, params: context.params });
  assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
  if (!compiled.ir || compiled.ir.kind !== "insert") {
    return [];
  }

  const typeDef = typeDefForInsertIR(schema, compiled.ir.table);
  if (!typeDef) {
    return [];
  }

  // When the nested insert carries an UNLESS CONFLICT clause, delegate to the
  // conflict-aware write path so a clash is suppressed / resolved via ELSE
  // rather than tripping the constraint.
  if (ast.conflict) {
    const writeResult = runWriteWithAccessPolicies(db, schema, ast, compiled.ir, compiled.sql, typeDef, context);
    return (writeResult.rows ?? [])
      .map((row) => (row as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");
  }

  // Predicate-free policies (structured `condition`) are checked pre-write
  // here; this nested-binding path has no savepoint to roll back a post-write
  // rejection, and `USING (...)` predicates over the written object are
  // enforced by the main write path (runWriteWithAccessPolicies).
  enforceInsertPolicies(typeDef, compiled.ir.values, context, 1, 1);
  db.prepare(compiled.sql.sql).run(...compiled.sql.params);
  const inserted = db
    .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(compiled.ir.table)} ORDER BY rowid DESC LIMIT 1`)
    .all()[0] as { id?: unknown } | undefined;
  if (typeof inserted?.id !== "string") {
    return [];
  }

  applyInsertLinkAssignments(db, schema, compiled.ir, ast, inserted.id, context);
  return [inserted.id];
};

type LinkTargetAssignment = {
  id: string;
  properties: Record<string, ScalarValue>;
};

// Compile a link-value projection (`(<select-or-subselect>) { @prop := … }`,
// possibly with non-literal/volatile linkprop bodies) as a standalone SELECT
// and read each `@`-prefixed column off the resulting rows. This is the
// fully-SQL resolution path for link values whose link properties can't be
// resolved by the literal pattern-match in the caller. Returns undefined when
// the projection doesn't compile to a single SELECT (so the caller can fall
// back to its other handling).
const resolveLinkValueViaSelectSQL = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  projection: { kind: "shape_projection"; expr: FreeObjectExpr; shape: ShapeElement[] },
  context: SecurityContext,
  ast: InsertStatement,
): LinkTargetAssignment[] | undefined => {
  const hasLinkPropShape = projection.shape.some(
    (el) => el.kind === "computed" && el.name.startsWith("@"),
  );
  if (!hasLinkPropShape) return undefined;
  // Drop nested INSERT/UPDATE/DELETE targets — those are written by the
  // mutation machinery, not a read-only SELECT compile.
  const containsMutation = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(containsMutation);
    if (node === null || typeof node !== "object") return false;
    const k = (node as { kind?: unknown }).kind;
    if (k === "mutation_expr" || k === "insert" || k === "update" || k === "delete") return true;
    return Object.values(node as object).some(containsMutation);
  };
  if (containsMutation(projection.expr)) return undefined;
  const stmtAst = {
    kind: "select_expr",
    expr: projection,
    with: ast.with,
    withModule: ast.withModule,
    withModuleAliases: ast.withModuleAliases,
    pos: ast.pos,
  } as unknown as Statement;
  const attempt = tryResult(() => {
    const compiled = getCompilerService().compile(schema, stmtAst, { globals: context.globals, params: context.params, target: resolvedRuntimeTarget(context, db) });
    if (!lowersToSingleSql(compiled.sql)) return undefined;
    if (compiled.ir !== undefined) return undefined;
    return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql, { keepInternalId: true })
      .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
  }, { captureAll: true });
  if (!attempt.ok || attempt.value === undefined) return undefined;
  return attempt.value
    .map((row) => {
      if (typeof row.id !== "string") return undefined;
      const properties: Record<string, ScalarValue> = {};
      for (const [key, raw] of Object.entries(row)) {
        if (!key.startsWith("@")) continue;
        const scalar = coerceUnknownToScalar(raw);
        if (scalar === undefined) continue;
        properties[key] = scalar;
      }
      return { id: row.id, properties };
    })
    .filter((entry): entry is LinkTargetAssignment => !!entry);
};

const resolveInsertTargets = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  value: InsertValue,
  context: SecurityContext,
  ast: InsertStatement,
): LinkTargetAssignment[] => {
  const resolveBinding = makeBindingResolver(ast, context, ast.pos.line, ast.pos.column);

  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return typeof value === "string" ? [{ id: value, properties: {} }] : [];
  }

  const valueAsRecord = value as Record<string, unknown> & { kind?: string };
  const resolveIdentityFunctionTargets = (node: unknown): LinkTargetAssignment[] | undefined => {
    if (node === null || typeof node !== "object") return undefined;
    const n = node as { kind?: string; call?: { name?: string; args?: unknown[] } };
    if (n.kind !== "function_call") return undefined;
    const fnName = (n.call?.name ?? "").split("::").pop();
    if (!fnName || !["assert_distinct", "assert_single", "assert_exists", "distinct"].includes(fnName)) {
      return undefined;
    }
    const arg = n.call?.args?.[0];
    if (arg === undefined) return [];
    return resolveInsertTargets(db, schema, arg as InsertValue, context, ast);
  };

  const directIdentityTargets = resolveIdentityFunctionTargets(value);
  if (directIdentityTargets !== undefined) return directIdentityTargets;

  if (valueAsRecord.kind === "set_expr") {
    return ((valueAsRecord.values as InsertValue[] | undefined) ?? [])
      .flatMap((item) => resolveInsertTargets(db, schema, item, context, ast));
  }

  if (valueAsRecord.kind === "select_expr_subquery") {
    const unwrapped = valueAsRecord.expr as (FreeObjectExpr | undefined);
    if (unwrapped && typeof unwrapped === "object") {
      const identityTargets = resolveIdentityFunctionTargets(unwrapped);
      if (identityTargets !== undefined) return identityTargets;
      if ((unwrapped as { kind?: string }).kind === "set_expr") {
        return (((unwrapped as { values?: InsertValue[] }).values) ?? [])
          .flatMap((item) => resolveInsertTargets(db, schema, item, context, ast));
      }
      if (unwrapped.kind === "shape_projection") {
        return resolveInsertTargets(db, schema, { kind: "expr", expr: unwrapped } as InsertValue, context, ast);
      }
      if (unwrapped.kind === "select") {
        return resolveInsertTargets(db, schema, unwrapped as unknown as Extract<InsertValue, { kind: "select" }>, context, ast);
      }
    }
  }

  if (value.kind === "binding_ref") {
    const withValue = (ast.with ?? []).find((binding) => binding.name === value.name)?.value;
    // Expression bindings (`sub := <Subordinate>{}`, `sub := (SELECT … ++ …)`)
    // — evaluate the expression once via SQL and link the returned objects.
    if (withValue && withValue.kind === "subquery_expr") {
      const stmtAst = {
        kind: "select_expr",
        expr: withValue.expr,
        with: (ast.with ?? []).filter((binding) => binding.name !== value.name),
        pos: ast.pos,
      } as unknown as Statement;
      // captureAll: bindings that don't evaluate to object rows just yield no
      // link targets.
      const attempt = tryResult(() => {
        const compiled = getCompilerService().compile(schema, stmtAst, { globals: context.globals, params: context.params, target: resolvedRuntimeTarget(context, db) });
        if (!lowersToSingleSql(compiled.sql)) return undefined;
        return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
      }, { captureAll: true });
      if (attempt.ok && attempt.value !== undefined) {
        return attempt.value
          .map((row) => (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
            ? { id: (row as { id: string }).id, properties: {} }
            : undefined))
          .filter((entry): entry is LinkTargetAssignment => !!entry);
      }
      return [];
    }
    if (withValue && withValue.kind === "subquery") {
      const rows = executeSelectExprRows(db, schema, withValue.query as Extract<InsertValue, { kind: "select" }>, context);
      return rows
        .map((row) => {
          if (typeof row.id !== "string") {
            return undefined;
          }

          const properties: Record<string, ScalarValue> = {};
          for (const [key, raw] of Object.entries(row)) {
            if (!key.startsWith("@")) {
              continue;
            }

            const scalar = coerceUnknownToScalar(raw);
            if (scalar === undefined) {
              continue;
            }
            properties[key] = scalar;
          }

          return { id: row.id, properties };
        })
        .filter((entry): entry is LinkTargetAssignment => !!entry);
    }

    // Bare type name as a link target (`l_a := A`) — resolve to all rows of
    // that type (and its concrete subtypes).
    const qualifiedName = value.name.includes("::") ? value.name : `default::${value.name}`;
    const typeDefByName = schema.getType(qualifiedName);
    if (typeDefByName) {
      const concretes = schema.listConcreteTypesAssignableTo(qualifiedName);
      const tables = concretes.length > 0
        ? concretes.map((concrete) => qualifiedTypeName(concrete))
        : [qualifiedName];
      const collected: LinkTargetAssignment[] = [];
      for (const typeName of tables) {
        const table = typeName.replaceAll("::", "__").toLowerCase();
        const rows = db.prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(table)}`).all() as { id?: unknown }[];
        for (const row of rows) {
          if (typeof row.id === "string") {
            collected.push({ id: row.id, properties: {} });
          }
        }
      }
      return collected;
    }

    const scalar = resolveBinding(value.name);
    return typeof scalar === "string" ? [{ id: scalar, properties: {} }] : [];
  }

  if (value.kind === "select") {
    const scopedSelect = {
      ...value,
      clauses: {
        ...value.clauses,
        _withBindings: value.clauses._withBindings ?? ast.with,
        _withModule: value.clauses._withModule ?? ast.withModule,
        _withModuleAliases: value.clauses._withModuleAliases ?? ast.withModuleAliases,
      },
    };
    const rows = executeSelectExprRows(db, schema, scopedSelect, context);
    return rows
      .map((row) => {
        if (typeof row.id !== "string") {
          return undefined;
        }

        const properties: Record<string, ScalarValue> = {};
        for (const [key, raw] of Object.entries(row)) {
          if (!key.startsWith("@")) {
            continue;
          }

          const scalar = coerceUnknownToScalar(raw);
          if (scalar === undefined) {
            continue;
          }
          properties[key] = scalar;
        }

        return { id: row.id, properties };
      })
      .filter((entry): entry is LinkTargetAssignment => !!entry);
  }

  if (value.kind === "insert") {
    return executeNestedInsert(db, schema, value, context, ast).map((id) => ({ id, properties: {} }));
  }

  // `(insert T { … }){ @a := 2 }` and bare expression wrappers around an
  // insert/select arrive as `{ kind: "expr", expr: shape_projection(...) }`.
  // Pull the inner mutation/select target id and merge `@`-prefixed shape
  // entries into the link's per-target properties so link-table writes pick
  // them up.
  if (value.kind === "expr") {
    const inner = (value as { kind: "expr"; expr: FreeObjectExpr }).expr;
    const identityTargets = resolveIdentityFunctionTargets(inner);
    if (identityTargets !== undefined) return identityTargets;
    if ((inner as { kind?: string }).kind === "set_expr") {
      return (((inner as { values?: InsertValue[] }).values) ?? [])
        .flatMap((item) => resolveInsertTargets(db, schema, item, context, ast));
    }
    // `link := (INSERT T {…} UNLESS CONFLICT …)` — a bare nested mutation
    // (no shape projection). Run it and link the resulting (inserted or
    // conflict-resolved) row id (test unless_conflict_08).
    if (inner.kind === "mutation_expr") {
      const stmt = (inner as { kind: "mutation_expr"; statement: Statement }).statement;
      if (stmt.kind === "insert") {
        return executeNestedInsert(db, schema, stmt as Extract<InsertValue, { kind: "insert" }>, context, ast)
          .map((id) => ({ id, properties: {} }));
      }
    }
    if (inner.kind === "shape_projection") {
      const projection = inner as { kind: "shape_projection"; expr: FreeObjectExpr; shape: ShapeElement[] };
      const innerExpr = projection.expr;
      let targets: LinkTargetAssignment[] = [];
      if (innerExpr.kind === "mutation_expr") {
        const stmt = (innerExpr as { kind: "mutation_expr"; statement: Statement }).statement;
        if (stmt.kind === "insert") {
          targets = executeNestedInsert(db, schema, stmt as Extract<InsertValue, { kind: "insert" }>, context, ast)
            .map((id) => ({ id, properties: {} }));
        }
      } else if (innerExpr.kind === "select") {
        targets = resolveInsertTargets(db, schema, innerExpr as Extract<InsertValue, { kind: "select" }>, context, ast);
      }
      // Apply the shape's `@`-prefixed assignments as link-property values
      // on every resolved target.
      const properties: Record<string, ScalarValue> = {};
      for (const el of projection.shape) {
        if (el.kind !== "computed") continue;
        if (!el.name.startsWith("@")) continue;
        const exprBody = (el.expr as { kind: string }).kind === "select_expr"
          ? (el.expr as { kind: "select_expr"; expr: FreeObjectExpr }).expr
          : el.expr;
        if ((exprBody as { kind: string }).kind === "literal") {
          const litVal = (exprBody as { kind: "literal"; value: ScalarValue }).value;
          properties[el.name] = litVal;
        }
      }
      // Linkprop bodies that aren't plain literals (`@comment :=
      // <str>uuid_generate_v1mc()`, `@comment := array_join(['a'] ++ [], '')`)
      // and link targets wrapped in further subselects (`(SELECT (SELECT Sub
      // LIMIT 1) { @comment := … })`) can't be resolved by the literal/inner
      // pattern-match above. Compile the whole projection as a SELECT and read
      // the `@`-prefixed columns off the resulting rows — the canonical,
      // fully-SQL path that handles arbitrary linkprop expressions per target.
      const projectionRows = resolveLinkValueViaSelectSQL(db, schema, projection, context, ast);
      if (projectionRows !== undefined) return projectionRows;
      if (Object.keys(properties).length > 0) {
        return targets.map((t) => ({ id: t.id, properties: { ...t.properties, ...properties } }));
      }
      return targets;
    }
    // A link value wrapped in `select_expr_subquery` — unwrap and resolve the
    // inner expression (which may itself be a linkprop shape projection or a
    // plain select).
    if (inner.kind === "select_expr_subquery") {
      const unwrapped = (inner as { expr: FreeObjectExpr }).expr;
      if (unwrapped.kind === "shape_projection") {
        return resolveInsertTargets(db, schema, { kind: "expr", expr: unwrapped } as InsertValue, context, ast);
      }
      if (unwrapped.kind === "select") {
        return resolveInsertTargets(db, schema, unwrapped as unknown as Extract<InsertValue, { kind: "select" }>, context, ast);
      }
    }
  }

  if (value.kind === "set") {
    return value.values.flatMap((item) => resolveInsertTargets(db, schema, item, context, ast));
  }

  if (value.kind === "for") {
    const iteratorValues = evaluateForIteratorValues(value.iteratorExpr, schema, db, context);
    const rows: LinkTargetAssignment[] = [];

    for (const iterValue of iteratorValues) {
      if (value.body.kind === "select") {
        const selectAst = ensureSelectAstHasId(bindSelectAstVariable(value.body, value.variable, iterValue));
        const compiler = getCompilerService();
        const compiled = compiler.compile(schema, selectAst, { globals: context.globals, params: context.params });
        assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
        if (compiled.ir !== undefined) {
          continue;
        }

        const selectedRows = runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql, { keepInternalId: true })
          .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
        for (const row of selectedRows) {
          if (typeof row.id !== "string") {
            continue;
          }
          const properties: Record<string, ScalarValue> = {};
          for (const [key, raw] of Object.entries(row)) {
            if (!key.startsWith("@")) {
              continue;
            }

            const scalar = coerceUnknownToScalar(raw);
            if (scalar === undefined) {
              continue;
            }
            properties[key] = scalar;
          }
          rows.push({ id: row.id, properties });
        }
      } else if (value.body.kind === "insert") {
        const replacedValues: Record<string, InsertValue> = {};
        for (const [field, insertValue] of Object.entries(value.body.values)) {
          if (typeof insertValue === "object" && insertValue !== null && "kind" in insertValue && insertValue.kind === "binding_ref" && insertValue.name === value.variable) {
            const scalar = coerceUnknownToScalar(iterValue);
            replacedValues[field] = scalar ?? insertValue;
          } else {
            replacedValues[field] = insertValue;
          }
        }

        const nestedIds = executeNestedInsert(db, schema, { kind: "insert", typeName: value.body.typeName, values: replacedValues }, context, ast);
        rows.push(...nestedIds.map((id) => ({ id, properties: {} })));
      }
    }

    return rows;
  }

  // A tuple-set `FOR x IN {(…), (…)} UNION (SELECT Target { @prop := x.0 }
  // FILTER … x.1)` used as a link value (possibly wrapped in
  // `DISTINCT(…)`/`expr`/`for_expr`). Each iteration substitutes the tuple
  // element accesses (`x.0`, `x.1`) into the select — including the `@`-shape
  // and FILTER — runs it, and reads the per-row `@`-columns as link properties.
  const tupleForRows = resolveTupleForUnionSelectLinkValue(db, schema, value, context, ast);
  if (tupleForRows !== undefined) return tupleForRows;

  // Generic fallback: an object-returning expression that none of the
  // structured cases above match — `assert_exists((select T …))`,
  // `assert_single(…)`, a parameter-substituted call, or a bare
  // `select_expr_subquery`/`expr` wrapper. Compile it as a standalone SELECT
  // (threading the outer WITH bindings) and read the resulting object ids.
  if (value.kind === "function_call" || value.kind === "expr") {
    const innerExpr = value.kind === "expr"
      ? (value as { expr: FreeObjectExpr }).expr
      : ({ kind: "function_call", call: (value as { call: FunctionCallExpr }).call } as unknown as FreeObjectExpr);
    const stmtAst = {
      kind: "select_expr",
      expr: innerExpr,
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      pos: ast.pos,
    } as unknown as Statement;
    const attempt = tryResult(() => {
      const compiled = getCompilerService().compile(schema, stmtAst, { globals: context.globals, params: context.params, target: resolvedRuntimeTarget(context, db) });
      if (!lowersToSingleSql(compiled.sql)) return undefined;
      return runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql, { keepInternalId: true })
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
    }, { captureAll: true });
    if (attempt.ok && attempt.value !== undefined) {
      return attempt.value
        .map((row) => (typeof (row as { id?: unknown }).id === "string"
          ? { id: (row as { id: string }).id, properties: {} }
          : undefined))
        .filter((entry): entry is LinkTargetAssignment => !!entry);
    }
  }

  return [];
};

// Unwrap `expr`/`distinct`/`for_expr`/`for` to a ForStatement whose iterator is
// a set of tuple literals and whose body is a SELECT, then resolve each
// iteration's targets (with `x.N` substituted) and read its `@`-columns.
const resolveTupleForUnionSelectLinkValue = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  value: InsertValue,
  context: SecurityContext,
  ast: InsertStatement,
): LinkTargetAssignment[] | undefined => {
  let node: unknown = value;
  for (let i = 0; i < 6 && node !== null && typeof node === "object"; i++) {
    const k = (node as { kind?: string }).kind;
    if (k === "expr" || k === "distinct" || k === "select_expr_subquery") {
      node = (node as { expr: unknown }).expr;
      continue;
    }
    break;
  }
  const n = node as { kind?: string } | null;
  let forVariable: string | undefined;
  let forIterator: ForStatement["iteratorExpr"] | undefined;
  let forBody: unknown;
  if (n?.kind === "for") {
    const f = node as ForStatement;
    forVariable = f.variable;
    forIterator = f.iteratorExpr;
    forBody = f.body;
  } else if (n?.kind === "for_expr") {
    // `for_expr` carries a SELECT body (unlike forExprChainToForStatement,
    // which only accepts INSERT bodies) — read its parts directly.
    const fe = node as unknown as { variable: string; iterator: ForStatement["iteratorExpr"]; body: unknown };
    forVariable = fe.variable;
    forIterator = fe.iterator;
    forBody = fe.body;
  }
  if (forVariable === undefined || forIterator === undefined) return undefined;
  const tupleRows = evaluateForTupleIteratorRows(forIterator, schema, db, context);
  if (tupleRows === undefined) return undefined;
  const forStmt = { variable: forVariable } as { variable: string };
  // Peel a select_expr_subquery body down to the inner select.
  let body: unknown = forBody;
  if ((body as { kind?: string })?.kind === "select_expr_subquery") {
    body = (body as { expr: unknown }).expr;
  }
  if ((body as { kind?: string })?.kind !== "select") return undefined;
  const out: LinkTargetAssignment[] = [];
  const seen = new globalThis.Set<string>();
  for (const tuple of tupleRows) {
    const substituted = substituteTupleIndexRefs(body, forStmt.variable, tuple) as Extract<InsertValue, { kind: "select" }>;
    const scoped = {
      ...substituted,
      clauses: {
        ...substituted.clauses,
        _withBindings: substituted.clauses._withBindings ?? ast.with,
        _withModule: substituted.clauses._withModule ?? ast.withModule,
        _withModuleAliases: substituted.clauses._withModuleAliases ?? ast.withModuleAliases,
      },
    };
    const selRows = executeSelectExprRows(db, schema, scoped, context);
    for (const row of selRows) {
      if (typeof row.id !== "string" || seen.has(row.id)) continue;
      seen.add(row.id);
      const properties: Record<string, ScalarValue> = {};
      for (const [key, raw] of Object.entries(row)) {
        if (!key.startsWith("@")) continue;
        const scalar = coerceUnknownToScalar(raw);
        if (scalar === undefined) continue;
        properties[key] = scalar;
      }
      out.push({ id: row.id, properties });
    }
  }
  return out;
};

const defaultLinkPropertyValueIR = (
  property: InsertLinkPropertyIR,
  db?: SQLiteDatabase,
  schema?: SchemaSnapshot,
  context?: SecurityContext,
): ScalarValue => {
  if (!property.hasDefault) return null;
  // Schema-supplied literal default (e.g. `rank: int64 { default := 42 }`).
  // The IR carries the resolved scalar so we can stamp it here without
  // re-evaluating the EdgeQL expression.
  if (property.defaultValue !== undefined) return property.defaultValue;
  // Computed default (e.g. `default := <int64>round(10 * random())`): evaluate
  // the expression text through the engine at insert time.
  if (property.defaultExprText && db && schema) {
    try {
      const result = executeQuery(db, schema, `SELECT ${property.defaultExprText}`, context);
      const value = result.rows?.[0];
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value as ScalarValue;
      }
    } catch { /* fall through to null */ }
  }
  return null;
};

// Resolves the `__gel_global_ids` type for each id with a single batched
// SELECT, then enforces the assignable-target-table set for the link.
// Replaces the per-id validation loop with one round trip per link.
const validateLinkTargetIds = (
  db: SQLiteDatabase,
  linkName: string,
  targetIds: string[],
  expectedTargetTables: ReadonlyArray<string>,
  pos: { line: number; column: number },
): void => {
  if (targetIds.length === 0) return;
  const placeholders = targetIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT "id" AS "id", "type_name" AS "type_name" FROM "__gel_global_ids" WHERE "id" IN (${placeholders})`)
    .all(...targetIds) as Array<{ id?: unknown; type_name?: unknown }>;
  const typeById = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.id === "string" && typeof row.type_name === "string") {
      typeById.set(row.id, row.type_name);
    }
  }
  const allowed = new Set(expectedTargetTables);
  for (const targetId of targetIds) {
    const typeName = typeById.get(targetId);
    if (typeName === undefined) {
      throw new AppError("E_SEMANTIC", `Invalid id for link '${linkName}': '${targetId}' does not reference an existing object`, pos.line, pos.column);
    }
    if (!allowed.has(typeName)) {
      const expected = [...allowed].sort().join(" or ");
      throw new AppError("E_SEMANTIC", `Invalid id for link '${linkName}': expected '${expected}', got '${typeName}'`, pos.line, pos.column);
    }
  }
};

const writeLinkTableRows = (
  db: SQLiteDatabase,
  linkTable: string,
  propertyColumns: ReadonlyArray<string>,
  properties: ReadonlyArray<InsertLinkPropertyIR>,
  sourceId: string,
  assignments: ReadonlyArray<{ id: string; properties: Record<string, ScalarValue> }>,
  schema?: SchemaSnapshot,
  context?: SecurityContext,
): void => {
  if (assignments.length === 0) return;
  const columns = ["source", "target", ...propertyColumns];
  const propertyByName = new Map(properties.map((p) => [p.name, p] as const));
  const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
  const sql = `INSERT INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES ${assignments.map(() => rowPlaceholders).join(", ")}`;
  const params: ScalarValue[] = [];
  for (const assignment of assignments) {
    params.push(sourceId, assignment.id);
    for (const column of propertyColumns) {
      const explicit = assignment.properties[`@${column}`];
      if (explicit !== undefined) {
        params.push(explicit);
      } else {
        const property = propertyByName.get(column);
        params.push(property ? defaultLinkPropertyValueIR(property, db, schema, context) : null);
      }
    }
  }
  db.prepare(sql).run(...params);
};

const resolveDefaultLinkTargets = (
  db: SQLiteDatabase,
  spec: InsertLinkDefaultIR,
  schema?: SchemaSnapshot,
  context?: SecurityContext,
): Array<{ id: string; properties: Record<string, ScalarValue> }> => {
  // INSERT-valued link default (`default := (INSERT T { … })`): run the nested
  // insert (which itself fills any further chained defaults) and link the row.
  if (spec.insertExprText && schema && context) {
    const ast = parseEdgeQL(spec.insertExprText);
    let node: unknown = Array.isArray(ast) ? ast[0] : ast;
    // A parenthesized `(INSERT …)` parses as select_expr → mutation_expr →
    // statement; unwrap those wrappers down to the bare insert statement.
    while (node && typeof node === "object") {
      const kind = (node as { kind?: string }).kind;
      if (kind === "select_expr") node = (node as { expr?: unknown }).expr;
      else if (kind === "mutation_expr") node = (node as { statement?: unknown }).statement;
      else break;
    }
    if (node && (node as { kind?: string }).kind === "insert") {
      const ids = executeNestedInsert(db, schema, node as Extract<InsertValue, { kind: "insert" }>, context);
      return ids.map((id) => ({ id, properties: {} }));
    }
    return [];
  }
  if (spec.defaultTargetValues.length > 0 && spec.lookupColumn) {
    const results: Array<{ id: string; properties: Record<string, ScalarValue> }> = [];
    for (const targetValue of spec.defaultTargetValues) {
      const row = db
        .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(spec.targetTable)} WHERE ${quoteIdent(spec.lookupColumn)} = ? LIMIT 1`)
        .all(targetValue)[0] as { id?: unknown } | undefined;
      if (typeof row?.id === "string") {
        results.push({ id: row.id, properties: {} });
      }
    }
    return results;
  }
  const first = db
    .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(spec.targetTable)} ORDER BY rowid ASC LIMIT 1`)
    .all()[0] as { id?: unknown } | undefined;
  return typeof first?.id === "string" ? [{ id: first.id, properties: {} }] : [];
};

const applyInsertLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: InsertIR,
  ast: InsertStatement,
  sourceId: string,
  context: SecurityContext,
): void => {
  for (const assignment of ir.linkAssignments ?? []) {
    const targetAssignments = resolveInsertTargets(db, schema, assignment.target, context, ast);
    const targetIds = targetAssignments.map((entry) => entry.id);
    validateLinkTargetIds(db, assignment.linkName, targetIds, assignment.expectedTargetTables, ast.pos);

    if (assignment.storage === "table") {
      if (!assignment.linkTable) throw new Error("invariant: table-storage link assignment missing linkTable");
      writeLinkTableRows(
        db,
        assignment.linkTable,
        assignment.propertyColumns ?? [],
        assignment.properties ?? [],
        sourceId,
        targetAssignments,
        schema,
        context,
      );
      continue;
    }

    if (!assignment.inlineColumn) throw new Error("invariant: inline-storage link assignment missing inlineColumn");
    const inlineTarget = targetIds[0] ?? null;
    db.prepare(`UPDATE ${quoteIdent(assignment.ownerTable)} SET ${quoteIdent(assignment.inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(inlineTarget, sourceId);
  }

  for (const spec of ir.linkDefaults ?? []) {
    const targets = resolveDefaultLinkTargets(db, spec, schema, context);
    if (targets.length === 0) continue;

    if (spec.storage === "table") {
      if (!spec.linkTable) throw new Error("invariant: table-storage link default missing linkTable");
      writeLinkTableRows(
        db,
        spec.linkTable,
        spec.propertyColumns ?? [],
        spec.properties ?? [],
        sourceId,
        targets,
        schema,
        context,
      );
      continue;
    }

    if (!spec.inlineColumn) throw new Error("invariant: inline-storage link default missing inlineColumn");
    db.prepare(`UPDATE ${quoteIdent(spec.ownerTable)} SET ${quoteIdent(spec.inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(targets[0]?.id ?? null, sourceId);
  }
};

const writeUpdateLinkTableRows = (
  db: SQLiteDatabase,
  spec: UpdateLinkAssignmentIR,
  sourceId: string,
  targets: ReadonlyArray<{ id: string; properties: Record<string, ScalarValue> }>,
): void => {
  if (targets.length === 0) return;
  if (!spec.linkTable) throw new Error("invariant: table-storage update link assignment missing linkTable");
  const propertyColumns = spec.propertyColumns ?? [];
  const columns = ["source", "target", ...propertyColumns];
  const propertyByName = new Map((spec.properties ?? []).map((p) => [p.name, p] as const));
  const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
  const verb = spec.operation === "append" ? "INSERT OR IGNORE" : "INSERT";
  const sql = `${verb} INTO ${quoteIdent(spec.linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES ${targets.map(() => rowPlaceholders).join(", ")}`;
  const params: ScalarValue[] = [];
  for (const target of targets) {
    params.push(sourceId, target.id);
    for (const column of propertyColumns) {
      const explicit = target.properties[`@${column}`];
      if (explicit !== undefined) {
        params.push(explicit);
      } else {
        const property = propertyByName.get(column);
        params.push(property ? defaultLinkPropertyValueIR(property) : null);
      }
    }
  }
  db.prepare(sql).run(...params);
};

// Apply multi (set-valued) scalar property assignments on UPDATE. These live in
// `ir.values` as a JSON-array string (the new set), but the base SQL UPDATE
// skips multi-cardinality columns, and the `:=`/`+=`/`-=` operation isn't
// folded into that encoded value. We read each matched row's current JSON
// array, apply the operation, and write the merged array back to the column.
// The materialised exclusivity AFTER-UPDATE triggers re-mirror the column into
// the shared excl table, so a duplicate value surfaces as a UNIQUE failure that
// we translate to EdgeQL's exclusivity wording.
const applyUpdateMultiScalarProps = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  subjectType: TypeDef,
  ir: UpdateIR,
  ast: UpdateStatement,
  sourceIds: string[],
  pos: { line: number; column: number },
): void => {
  if (sourceIds.length === 0) return;
  const operations = (ast as { operations?: Record<string, string> }).operations ?? {};
  // Collect multi scalar fields the UPDATE assigns. Links are handled
  // separately by applyUpdateLinkAssignments; we only touch scalar columns
  // declared `multi property`.
  const multiFields: Array<{ name: string; type: string }> = [];
  for (const field of subjectType.fields) {
    if (!(field as { multi?: boolean }).multi) continue;
    if (!Object.prototype.hasOwnProperty.call(ir.values, field.name)) continue;
    const encoded = ir.values[field.name];
    if (typeof encoded !== "string") continue;
    multiFields.push({ name: field.name, type: (field as { type?: string }).type ?? "str" });
  }
  if (multiFields.length === 0) return;

  for (const sourceId of sourceIds) {
    for (const field of multiFields) {
      const encoded = ir.values[field.name] as string;
      let assigned: unknown[];
      try {
        const parsed = JSON.parse(encoded);
        assigned = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        assigned = [];
      }
      const op = operations[field.name] ?? "assign";
      let next: unknown[];
      if (op === "assign") {
        next = assigned;
      } else {
        const currentRaw = db
          .prepare(`SELECT ${quoteIdent(field.name)} AS ${quoteIdent("v")} FROM ${quoteIdent(ir.table)} WHERE ${quoteIdent("id")} = ?`)
          .all(sourceId)[0] as { v?: unknown } | undefined;
        let current: unknown[] = [];
        if (typeof currentRaw?.v === "string" && currentRaw.v.length > 0) {
          try {
            const parsed = JSON.parse(currentRaw.v);
            current = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            current = [];
          }
        }
        if (op === "append") {
          // EdgeQL `+=` is a set union; multi scalar properties are sets, so
          // appending an already-present value is a no-op (no duplicates).
          const seen = new Set(current.map((v) => JSON.stringify(v)));
          next = [...current];
          for (const v of assigned) {
            const key = JSON.stringify(v);
            if (!seen.has(key)) {
              seen.add(key);
              next.push(v);
            }
          }
        } else if (op === "subtract") {
          const remove = new Set(assigned.map((v) => JSON.stringify(v)));
          next = current.filter((v) => !remove.has(JSON.stringify(v)));
        } else {
          next = assigned;
        }
      }
      try {
        db.prepare(`UPDATE ${quoteIdent(ir.table)} SET ${quoteIdent(field.name)} = ? WHERE ${quoteIdent("id")} = ?`)
          .run(JSON.stringify(next), sourceId);
      } catch (writeErr) {
        throw translateExclusivityWriteError(writeErr, pos.line, pos.column);
      }
    }
  }
};

const applyUpdateLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: UpdateIR,
  ast: UpdateStatement,
  sourceIds: string[],
  context: SecurityContext,
): void => {
  if (sourceIds.length === 0) return;

  for (const spec of ir.linkAssignments ?? []) {
    // resolveInsertTargets needs an InsertStatement shell to thread the
    // outer WITH bindings through subqueries; build a minimal one from the
    // UPDATE's preserved bindings.
    const fauxInsertAst: InsertStatement = {
      kind: "insert",
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      typeName: ast.typeName,
      values: {},
      pos: ast.pos,
    };

    const targetAssignments = resolveInsertTargets(db, schema, spec.target, context, fauxInsertAst);
    const targetIds = targetAssignments.map((assignment) => assignment.id);
    validateLinkTargetIds(db, spec.linkName, targetIds, spec.expectedTargetTables, ast.pos);

    if (spec.storage === "table") {
      const linkTable = spec.linkTable;
      if (!linkTable) throw new Error("invariant: table-storage update link assignment missing linkTable");
      for (const sourceId of sourceIds) {
        if (spec.operation === "assign") {
          db.prepare(`DELETE FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).run(sourceId);
        }
        if (spec.operation === "subtract") {
          if (targetIds.length > 0) {
            const placeholders = targetIds.map(() => "?").join(", ");
            db.prepare(`DELETE FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ? AND ${quoteIdent("target")} IN (${placeholders})`)
              .run(sourceId, ...targetIds);
          }
          continue;
        }
        writeUpdateLinkTableRows(db, spec, sourceId, targetAssignments);
      }
      continue;
    }

    const inlineColumn = spec.inlineColumn;
    if (!inlineColumn) throw new Error("invariant: inline-storage update link assignment missing inlineColumn");
    const inlineTarget = targetIds[0] ?? null;
    if (spec.operation === "subtract") {
      const placeholders = sourceIds.map(() => "?").join(", ");
      db.prepare(`UPDATE ${quoteIdent(spec.ownerTable)} SET ${quoteIdent(inlineColumn)} = NULL WHERE ${quoteIdent("id")} IN (${placeholders}) AND ${quoteIdent(inlineColumn)} = ?`)
        .run(...sourceIds, inlineTarget);
      continue;
    }

    const placeholders = sourceIds.map(() => "?").join(", ");
    db.prepare(`UPDATE ${quoteIdent(spec.ownerTable)} SET ${quoteIdent(inlineColumn)} = ? WHERE ${quoteIdent("id")} IN (${placeholders})`)
      .run(inlineTarget, ...sourceIds);
  }
};

const evaluateSelectPolicies = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  typeDef: TypeDef,
  row: Record<string, unknown>,
  context: SecurityContext,
): boolean => {
  const id = row.id;
  if (typeof id !== "string") {
    return true;
  }

  const sourceType = rowSourceType(row, qualifiedTypeName(typeDef));
  const sourceTypeDef = schema.getType(sourceType) ?? typeDef;
  const policies = sourceTypeDef.accessPolicies ?? [];
  if (policies.length === 0 || context.isSuperuser) {
    return true;
  }

  // The SQL projection already carries every column the policy conditions
  // reference (see selectedColumns wiring in semantic.ts), so we can evaluate
  // policies directly on the in-memory row without firing another SELECT.
  // If a policy unexpectedly references a column we didn't project, fall back
  // to re-reading the full row.
  const conditionNeedsAbsentColumn = (condition: AccessPolicyCondition): boolean => {
    if (condition.kind === "field_eq_global" || condition.kind === "field_eq_literal") {
      return !(condition.field in row);
    }
    if (condition.kind === "and") {
      return condition.clauses.some(conditionNeedsAbsentColumn);
    }
    return false;
  };
  const needsFullRow = policies.some((p) => conditionNeedsAbsentColumn(p.condition));
  let rowForEval: Record<string, unknown> = row;
  if (needsFullRow) {
    const sourceTable = tableNameForType(sourceType);
    const fullRow = readRowById(db, sourceTable, id);
    if (!fullRow) {
      return false;
    }
    rowForEval = fullRow;
  }

  return evaluatePoliciesForOperation(sourceTypeDef, "select", rowForEval, context, {
    failOnDeny: false,
    evalUsingExpr: policyExprEvaluator(db, schema, context, sourceTypeDef),
  });
};

const readTargetRowsForFilter = (
  db: SQLiteDatabase,
  table: string,
  filter: { column: string; value: ScalarValue } | undefined,
): Record<string, unknown>[] => {
  let sql = `SELECT * FROM ${quoteIdent(table)}`;
  const params: ScalarValue[] = [];
  if (filter) {
    sql += ` WHERE ${quoteIdent(filter.column)} = ?`;
    params.push(filter.value);
  }

  return db.prepare(sql).all(...params);
};

const readTargetRowsForAssignableTypes = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  filter: { column: string; value: ScalarValue } | undefined,
): Record<string, unknown>[] => {
  const rows: Record<string, unknown>[] = [];
  const baseTypeName = qualifiedTypeName(typeDef);
  const concreteTypes = schema.listConcreteTypesAssignableTo(baseTypeName);

  for (const concreteType of concreteTypes) {
    const concreteName = qualifiedTypeName(concreteType);
    const table = tableNameForType(concreteName);
    const tableRows = readTargetRowsForFilter(db, table, filter);
    for (const row of tableRows) {
      rows.push({ ...row, __source_type: concreteName });
    }
  }

  return rows;
};

const readRowsByIds = (db: SQLiteDatabase, table: string, ids: string[]): Record<string, unknown>[] => {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} IN (${placeholders})`;
  return db.prepare(sql).all(...ids);
};

const readRowById = (db: SQLiteDatabase, table: string, id: string): Record<string, unknown> | null => {
  const row = db
    .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} = ?`)
    .all(id)[0];
  return row ?? null;
};

// ═══════════════════════════════════════════════════════════════════════════
// AST pre-validation (EdgeDB parity diagnostics)
//
// The GelIR→SQL pipeline doesn't surface several semantic errors the
// reference implementation raises (illegal type unions over computed
// pointers, single/multi mismatches, invalid property references on
// primitives, …). These checks run on the parsed AST right after
// `validateParsedStatement` so invalid queries fail with the reference
// error message instead of silently compiling.
// ═══════════════════════════════════════════════════════════════════════════

interface AstPreValidationCtx {
  schema: SchemaSnapshot;
  module: string;
  bindings: Map<string, WithBindingValue>;
  // Mirrors the session config: when true, an INSERT may assign `id`.
  allowUserSpecifiedId?: boolean;
}

function preValidationFail(message: string): never {
  throw new AppError("E_SEMANTIC", message, 1, 1);
}

function qualifyAstTypeName(name: string, module: string): string {
  return name.includes("::") ? name : `${module}::${name}`;
}

function lookupAstObjectType(ctx: AstPreValidationCtx, name: string): TypeDef | undefined {
  return ctx.schema.getType(qualifyAstTypeName(name, ctx.module))
    ?? ctx.schema.getType(name)
    ?? ctx.schema.getType(`default::${name}`);
}

type AstPointerInfo =
  | { kind: "field"; field: FieldDef; owner: TypeDef }
  | { kind: "link"; link: NonNullable<TypeDef["links"]>[number]; owner: TypeDef };

// Resolve a pointer (property or link) on a type, walking `extends`.
function findAstPointer(ctx: AstPreValidationCtx, typeDef: TypeDef, name: string): AstPointerInfo | undefined {
  const queue: TypeDef[] = [typeDef];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const qname = qualifiedTypeName(current);
    if (seen.has(qname)) continue;
    seen.add(qname);
    const field = current.fields.find((f) => f.name === name && !f.isLinkColumn);
    if (field) return { kind: "field", field, owner: current };
    const link = current.links?.find((l) => l.name === name);
    if (link) return { kind: "link", link, owner: current };
    for (const base of current.extends ?? []) {
      const baseDef = lookupAstObjectType(ctx, base);
      if (baseDef) queue.push(baseDef);
    }
  }
  return undefined;
}

const STD_SCALAR_NAME_BY_TYPE: Record<string, string> = {
  str: "std::str",
  int: "std::int64",
  float: "std::float64",
  bool: "std::bool",
  uuid: "std::uuid",
  datetime: "std::datetime",
  json: "std::json",
  bytes: "std::bytes",
  decimal: "std::decimal",
  bigint: "std::bigint",
};

function declaredScalarTypeName(field: FieldDef): string {
  return field.targetTypeName ?? field.enumTypeName ?? STD_SCALAR_NAME_BY_TYPE[field.type] ?? `std::${field.type}`;
}

// Names of standard-library scalar/object types that, when written bare in a
// cast (`<datetime>`, `<Object>`), live in the `std` module. Used to qualify
// the cast target so it can be compared to a declared pointer type.
const STD_CAST_TYPE_NAMES = new Set([
  "str", "int16", "int32", "int64", "float32", "float64", "bool", "uuid",
  "datetime", "duration", "json", "bytes", "decimal", "bigint", "Object",
  "BaseObject", "FreeObject", "cal::local_date", "cal::local_time",
  "cal::local_datetime", "cal::relative_duration", "cal::date_duration",
]);

// True when `name` resolves to a registered expression alias of any flavor
// (schema alias, runtime typed alias, or runtime expr alias) rather than an
// object type. Used to reject `INSERT <alias>` (test_edgeql_insert_alias).
function isExpressionAliasName(ctx: AstPreValidationCtx, name: string): boolean {
  const qualified = qualifyAstTypeName(name, ctx.module);
  const bare = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
  if (ctx.schema.getAlias(qualified) || ctx.schema.getAlias(name)) return true;
  const typed = getRuntimeTypedAliasMap(ctx.schema);
  if (typed.has(qualified) || typed.has(name) || typed.has(bare)) return true;
  const expr = getRuntimeExprAliasMap(ctx.schema);
  if (expr.has(qualified) || expr.has(name) || expr.has(bare)) return true;
  return false;
}

// Best-effort qualification of a cast target type name written in an INSERT
// shape value (`<datetime>{}`, `<Object>{}`). Returns a module-qualified name
// when possible so it can be reported and compared against a declared type.
function qualifyCastTypeName(ctx: AstPreValidationCtx, castType: string): string {
  if (castType.includes("::")) return castType;
  if (STD_CAST_TYPE_NAMES.has(castType)) return `std::${castType}`;
  // A user-defined object type referenced bare in the cast.
  const obj = lookupAstObjectType(ctx, castType);
  if (obj) return qualifiedTypeName(obj);
  return `std::${castType}`;
}

// Generic recursive walk over every object node carrying a string `kind`.
function walkAstForValidation(node: unknown, visit: (n: Record<string, unknown> & { kind: string }) => void, seen: Set<unknown> = new Set()): void {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walkAstForValidation(item, visit, seen);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.kind === "string") {
    visit(record as Record<string, unknown> & { kind: string });
  }
  for (const value of Object.values(record)) {
    walkAstForValidation(value, visit, seen);
  }
}

// ── union-branch pointer info (setops_14/15, banned_free_shape_01) ─────────

interface UnionBranchInfo {
  computed: Set<string>;
  typeName?: string;
  bindingName?: string;
}

function unionBranchInfo(ctx: AstPreValidationCtx, value: unknown, depth = 0): UnionBranchInfo | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const node = value as Record<string, unknown> & { kind?: string };
  switch (node.kind) {
    case "select": {
      const computed = new Set<string>();
      for (const el of (node.shape as ShapeElement[] | undefined) ?? []) {
        if (el.kind === "computed") computed.add(el.name);
      }
      return { computed, typeName: node.typeName as string | undefined };
    }
    case "free_object_constructor": {
      if (node.tupleLike) return undefined;
      const computed = new Set<string>();
      for (const entry of (node.entries as Array<{ name: string }> | undefined) ?? []) {
        computed.add(entry.name);
      }
      return { computed };
    }
    case "shape_projection": {
      const inner = unionBranchInfo(ctx, node.expr, depth + 1);
      const computed = new Set<string>(inner?.computed ?? []);
      for (const el of (node.shape as ShapeElement[] | undefined) ?? []) {
        if (el.kind === "computed") computed.add(el.name);
      }
      return { computed, typeName: inner?.typeName };
    }
    case "binding_ref": {
      const binding = ctx.bindings.get(node.name as string);
      if (!binding) return undefined;
      const info = bindingUnionBranchInfo(ctx, binding, depth + 1);
      if (info) info.bindingName = node.name as string;
      return info;
    }
    case "cast": {
      const castType = node.castType as string | undefined;
      if (castType && lookupAstObjectType(ctx, castType)) {
        return { computed: new Set(), typeName: castType };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function bindingUnionBranchInfo(ctx: AstPreValidationCtx, binding: WithBindingValue, depth: number): UnionBranchInfo | undefined {
  switch (binding.kind) {
    case "subquery": {
      const computed = new Set<string>();
      for (const el of binding.query.shape ?? []) {
        if (el.kind === "computed") computed.add(el.name);
      }
      return { computed, typeName: binding.query.typeName };
    }
    case "subquery_expr":
      return unionBranchInfo(ctx, unwrapSubqueryWrappers(binding.expr), depth);
    case "subquery_statement":
      return unionBranchInfo(ctx, binding.statement, depth);
    default:
      return undefined;
  }
}

function branchHasSchemaPointer(ctx: AstPreValidationCtx, info: UnionBranchInfo, name: string): boolean {
  if (!info.typeName) return false;
  const typeDef = lookupAstObjectType(ctx, info.typeName);
  if (!typeDef) return false;
  return findAstPointer(ctx, typeDef, name) !== undefined;
}

// `SELECT { Issue{number := 'foo'}, Issue }` — a union may not mix a shape
// computed pointer with another version of the same pointer.
function checkUnionComputedPointerMix(ctx: AstPreValidationCtx, values: unknown[]): void {
  if (values.length < 2) return;
  const infos = values.map((v) => unionBranchInfo(ctx, unwrapSubqueryWrappers(v)));
  for (let i = 0; i < infos.length; i += 1) {
    const info = infos[i];
    if (!info) continue;
    for (const name of info.computed) {
      for (let j = 0; j < infos.length; j += 1) {
        if (j === i) continue;
        const other = infos[j];
        if (!other) continue;
        // The same WITH binding unioned with itself is a single view type —
        // no pointer mixing happens.
        if (info.bindingName !== undefined && info.bindingName === other.bindingName) continue;
        if (other.computed.has(name) || branchHasSchemaPointer(ctx, other, name)) {
          preValidationFail(
            `it is illegal to create a type union that causes a computed property '${name}' to mix with other versions of the same property '${name}'`,
          );
        }
      }
    }
  }
}

// `(Issue UNION <Named>{}).number` — a pointer accessed on a union must
// exist on every branch of the union.
function checkUnionFieldAccess(ctx: AstPreValidationCtx, setValues: unknown[], field: string): void {
  if (setValues.length < 2) return;
  if (field === "id" || field === "__type__" || field.startsWith("@")) return;
  const branches: Array<{ typeDef: TypeDef; computed: Set<string> }> = [];
  for (const value of setValues) {
    const info = unionBranchInfo(ctx, unwrapSubqueryWrappers(value));
    if (!info || !info.typeName) return; // unresolvable branch — skip the check
    const typeDef = lookupAstObjectType(ctx, info.typeName);
    if (!typeDef) return;
    branches.push({ typeDef, computed: info.computed });
  }
  for (const branch of branches) {
    if (branch.computed.has(field)) continue;
    if (findAstPointer(ctx, branch.typeDef, field)) continue;
    preValidationFail(`object type '${qualifiedTypeName(branch.typeDef)}' has no link or property '${field}'`);
  }
}

// ── computed pointer checks (computable_17 / computable_34) ────────────────

// Whether a computed expression is statically known to produce more than one
// element (a set literal / UNION with several branches).
// `SELECT V { single foo := .foo }` where V's `foo` is a multi computed.
function checkSingleDeclaredComputeds(ctx: AstPreValidationCtx, shape: ShapeElement[], sourceShape: ShapeElement[] | undefined): void {
  if (!sourceShape) return;
  for (const el of shape) {
    if (el.kind !== "computed") continue;
    const cardinality = (el as { cardinality?: string }).cardinality;
    if (cardinality !== "one") continue;
    const referenced = computedElementReferencedField(el.expr);
    if (!referenced) continue;
    const source = sourceShape.find((s) => s.kind === "computed" && s.name === referenced) as Extract<ShapeElement, { kind: "computed" }> | undefined;
    if (!source) continue;
    if ((source as { multi?: boolean }).multi || computedExprIsMulti(source.expr)) {
      preValidationFail(
        `possibly more than one element returned by an expression for a computed property '${el.name}' declared as 'single'`,
      );
    }
  }
}

// Resolve a `current_item`-rooted field-access chain to its final pointer,
// starting at `subjectType`. Returns undefined when any step is unknown.
function resolveCurrentItemPathPointer(ctx: AstPreValidationCtx, expr: unknown, subjectType: TypeDef): AstPointerInfo | undefined {
  const fields: string[] = [];
  let current = expr as Record<string, unknown> & { kind?: string };
  let guard = 0;
  while (current && typeof current === "object" && current.kind === "field_access" && guard < 12) {
    fields.unshift(current.field as string);
    current = current.expr as Record<string, unknown> & { kind?: string };
    guard += 1;
  }
  if (!current || current.kind !== "current_item" || fields.length === 0) return undefined;
  let typeDef: TypeDef = subjectType;
  let pointer: AstPointerInfo | undefined;
  for (const field of fields) {
    pointer = findAstPointer(ctx, typeDef, field);
    if (!pointer) return undefined;
    if (pointer.kind === "link") {
      const target = lookupAstObjectType(ctx, pointer.link.targetType.split("|")[0]);
      if (!target) return pointer;
      typeDef = target;
    } else {
      typeDef = undefined as unknown as TypeDef;
    }
    if (!typeDef && field !== fields[fields.length - 1]) return undefined;
  }
  return pointer;
}

// `foo := .owner.todo UNION .owner.todo` — a computed link must be a
// provably distinct set; a UNION of link paths is not.
function checkComputedLinkUnions(ctx: AstPreValidationCtx, typeName: string, shape: ShapeElement[]): void {
  const subjectType = lookupAstObjectType(ctx, typeName);
  if (!subjectType) return;
  for (const el of shape) {
    if (el.kind !== "computed") continue;
    let expr: unknown = el.expr;
    const wrapper = expr as Record<string, unknown> & { kind?: string };
    if (wrapper?.kind === "select_expr" || wrapper?.kind === "select_expr_subquery") expr = wrapper.expr;
    const setNode = expr as Record<string, unknown> & { kind?: string };
    if (setNode?.kind !== "set_expr") continue;
    const values = (setNode.values as unknown[]) ?? [];
    if (values.length < 2) continue;
    const allLinkPaths = values.every((value) => {
      const pointer = resolveCurrentItemPathPointer(ctx, value, subjectType);
      return pointer?.kind === "link";
    });
    if (allLinkPaths) {
      preValidationFail(`possibly not a distinct set returned by an expression for a computed link '${el.name}'`);
    }
  }
}

// ── scalar path misuse (type_03 / partial_06 / precedence_02) ──────────────

// Resolve `field_access(select T, f)` (a `T.f` path) to the property def.
function scalarPathProperty(ctx: AstPreValidationCtx, node: unknown): FieldDef | undefined {
  const access = node as Record<string, unknown> & { kind?: string };
  if (!access || access.kind !== "field_access") return undefined;
  const base = access.expr as Record<string, unknown> & { kind?: string };
  if (!base || base.kind !== "select" || typeof base.typeName !== "string") return undefined;
  const typeDef = lookupAstObjectType(ctx, base.typeName as string);
  if (!typeDef) return undefined;
  const pointer = findAstPointer(ctx, typeDef, access.field as string);
  if (pointer?.kind !== "field") return undefined;
  if (pointer.field.collection) return undefined;
  return pointer.field;
}

function exprContainsPartialPathRef(node: unknown): boolean {
  let found = false;
  walkAstForValidation(node, (n) => {
    if (n.kind === "current_item" || n.kind === "field_ref") found = true;
  });
  return found;
}

// ── function call signature checks (func_06 / func_08) ─────────────────────

function functionCallArgLiteral(ctx: AstPreValidationCtx, arg: FunctionCallArgExpr): { value: ScalarValue; numericKind?: string } | undefined {
  if (arg.kind === "literal") return { value: arg.value };
  if (arg.kind === "expr") {
    const inner = arg.expr as Record<string, unknown> & { kind?: string };
    if (inner?.kind === "literal") {
      return { value: inner.value as ScalarValue, numericKind: inner.numericKind as string | undefined };
    }
    if (inner?.kind === "binding_ref") {
      return bindingLiteralValue(ctx, inner.name as string);
    }
    return undefined;
  }
  if (arg.kind === "binding_ref") return bindingLiteralValue(ctx, arg.name);
  return undefined;
}

function bindingLiteralValue(ctx: AstPreValidationCtx, name: string): { value: ScalarValue } | undefined {
  const binding = ctx.bindings.get(name);
  if (!binding) return undefined;
  if (binding.kind === "literal") return { value: binding.value };
  if (binding.kind === "subquery_expr") {
    const inner = binding.expr as Record<string, unknown> & { kind?: string };
    if (inner?.kind === "literal") return { value: inner.value as ScalarValue };
  }
  return undefined;
}

function checkFunctionCallSignatures(ctx: AstPreValidationCtx, call: FunctionCallExpr): void {
  const callNameParts = call.name.split("::");
  const leaf = callNameParts[callNameParts.length - 1];

  // `sum` only accepts numeric arguments. The SQL pipeline silently coerces
  // strings, so reject the statically-known-string case here.
  if (leaf === "sum" && call.args.length === 1) {
    const literal = functionCallArgLiteral(ctx, call.args[0]);
    if (literal && typeof literal.value === "string") {
      preValidationFail(`function "sum(arg0: std::str)" does not exist`);
    }
  }

  // Schema (user-declared) functions: validate literal argument types against
  // the declared parameter types — the reference raises "function … does not
  // exist" when no overload matches.
  const moduleName = call.name.includes("::") ? call.name.slice(0, call.name.lastIndexOf("::")) : ctx.module;
  const fnDef = ctx.schema.findFunction(moduleName, leaf, call.args.length)
    ?? (moduleName === "default" ? undefined : ctx.schema.findFunction("default", leaf, call.args.length));
  if (!fnDef) return;
  for (let i = 0; i < call.args.length; i += 1) {
    const arg = call.args[i];
    if (arg.kind === "named_arg") continue;
    const param = fnDef.params[Math.min(i, fnDef.params.length - 1)];
    if (!param) continue;
    const paramIsVariadicTail = param.variadic && i >= fnDef.params.length - 1;
    if (i >= fnDef.params.length && !paramIsVariadicTail) continue;
    const paramType = param.type.replace(/^std::/, "");
    const literal = functionCallArgLiteral(ctx, arg);
    if (!literal) continue;
    const argType = literalStdTypeName(literal);
    if (!argType) continue;
    const isStrParam = paramType === "str";
    const isNumericArg = argType === "std::int64" || argType === "std::float64";
    if (isStrParam && isNumericArg) {
      const renderedArgs = call.args.map((_, idx) => `arg${idx}: ${literalStdTypeName(functionCallArgLiteral(ctx, call.args[idx]) ?? { value: "" }) ?? "std::str"}`).join(", ");
      preValidationFail(`function "${leaf}(${renderedArgs})" does not exist`);
    }
  }
}

// ── statement-level static pre-validation ──────────────────────────────────

function preValidateStatementAst(schema: SchemaSnapshot, statement: Statement, allowUserSpecifiedId = false): void {
  const module = (statement as { withModule?: string }).withModule ?? "default";
  const bindings = new Map<string, WithBindingValue>();
  for (const binding of (statement as { with?: WithBinding[] }).with ?? []) {
    bindings.set(binding.name, binding.value);
  }
  const ctx: AstPreValidationCtx = { schema, module, bindings, allowUserSpecifiedId };

  // `SELECT T.scalarProp FILTER .x …` — partial paths can't be resolved
  // against a primitive subject. (Checked before the generic walk so the
  // error reports the *declared* scalar type, e.g. a custom scalar.)
  if (statement.kind === "select_expr") {
    const wrapper = (statement as { expr?: unknown }).expr as Record<string, unknown> & { kind?: string };
    if (wrapper?.kind === "select_expr_subquery" && wrapper.filter) {
      const prop = scalarPathProperty(ctx, wrapper.expr);
      if (prop && exprContainsPartialPathRef(wrapper.filter)) {
        preValidationFail(`invalid property reference on an expression of primitive type '${declaredScalarTypeName(prop)}'`);
      }
    }
  }

  walkAstForValidation(statement, (node) => {
    switch (node.kind) {
      case "set_expr": {
        const values = (node.values as unknown[]) ?? [];
        checkUnionComputedPointerMix(ctx, values);
        break;
      }
      case "field_access": {
        const base = node.expr as Record<string, unknown> & { kind?: string };
        if (base?.kind === "set_expr") {
          checkUnionFieldAccess(ctx, (base.values as unknown[]) ?? [], node.field as string);
        }
        // `User.name.__type__` — property reference on a primitive.
        if (node.field === "__type__" && scalarPathProperty(ctx, base)) {
          preValidationFail("invalid property reference on an expression of primitive type");
        }
        break;
      }
      case "index_access": {
        // `Issue.time_estimate[0]` — index indirection on a non-indexable scalar.
        const prop = scalarPathProperty(ctx, node.expr);
        if (prop && (prop.type === "int" || prop.type === "bool")) {
          const label = prop.type === "int" ? "std::int64" : "std::bool";
          preValidationFail(`index indirection cannot be applied to scalar type '${label}'`);
        }
        break;
      }
      case "distinct": {
        const inner = node.expr as Record<string, unknown> & { kind?: string };
        if (inner?.kind === "free_object_constructor" && !inner.tupleLike) {
          preValidationFail("cannot use DISTINCT on free shape");
        }
        break;
      }
      case "polymorphic_field_ref": {
        if (node.field === "id") {
          preValidationFail("cannot access property 'id' on a polymorphic shape element");
        }
        break;
      }
      case "function_call": {
        const call = (node.call ?? node) as unknown as FunctionCallExpr;
        if (call && typeof call.name === "string" && Array.isArray(call.args)) {
          checkFunctionCallSignatures(ctx, call);
        }
        break;
      }
      case "select": {
        const typeName = node.typeName as string | undefined;
        const shape = node.shape as ShapeElement[] | undefined;
        if (typeName && shape) {
          checkComputedLinkUnions(ctx, typeName, shape);
        }
        break;
      }
      case "shape_projection": {
        const base = node.expr as Record<string, unknown> & { kind?: string };
        if (base?.kind === "binding_ref") {
          const info = ctx.bindings.get(base.name as string);
          const sourceShape = bindingSelectShape(info);
          checkSingleDeclaredComputeds(ctx, (node.shape as ShapeElement[]) ?? [], sourceShape);
        }
        break;
      }
      case "insert": {
        const typeName = node.typeName as string | undefined;
        const values = (node.values as Record<string, unknown> | undefined) ?? undefined;
        if (typeName && values) {
          checkInsertStatementAst(ctx, typeName, values);
        }
        break;
      }
      case "tuple": {
        checkCorrelatedDmlInTuple(ctx, (node.values as unknown[]) ?? []);
        break;
      }
      default:
        break;
    }
  });
}

// Standard-library modules whose object types cannot be the subject of an
// INSERT (test_edgeql_insert_fail_07: `INSERT schema::Migration {…}`).
const INSERT_STD_MODULES = new Set(["std", "schema", "sys", "cfg", "ext"]);

// Static checks for an INSERT statement's subject type and shape values that
// don't depend on row data: assigning to computed/server-generated pointers,
// inserting std-lib types, and assigning a provably-multi expression to a
// single link. (All additive — fall through silently when unknown.)
function checkInsertStatementAst(
  ctx: AstPreValidationCtx,
  typeName: string,
  values: Record<string, unknown>,
): void {
  // `INSERT schema::Migration {…}` — std-lib types are not insertable.
  const qualified = qualifyAstTypeName(typeName, ctx.module);
  const moduleName = qualified.includes("::") ? qualified.slice(0, qualified.lastIndexOf("::")) : ctx.module;
  const leafName = qualified.slice(qualified.lastIndexOf("::") + 2);
  // `std::FreeObject` has its own diagnostic (test_edgeql_insert_free_obj);
  // leave it to the downstream check rather than the generic std-lib message.
  if (INSERT_STD_MODULES.has(moduleName) && leafName !== "FreeObject") {
    preValidationFail("insert standard library type");
  }

  // `INSERT Foo` where `Foo` is an expression alias, not an object type
  // (test_edgeql_insert_alias). Aliases of every flavor (schema-registered,
  // runtime typed, runtime expr) are rejected — you can't insert into a view.
  if (!lookupAstObjectType(ctx, typeName) && isExpressionAliasName(ctx, typeName)) {
    preValidationFail(`cannot insert into expression alias '${qualified}'`);
  }

  const typeDef = lookupAstObjectType(ctx, typeName);

  for (const field of Object.keys(values)) {
    // `id` is server-generated; assigning it requires the
    // `allow_user_specified_id` config (test_edgeql_insert_explicit_id_00).
    // With that config on, the explicit id is allowed through to lowering.
    if (field === "id" && !ctx.allowUserSpecifiedId) {
      preValidationFail("cannot assign to property 'id'");
    }
    // `__type__` is a system link that names the object's type and can't be
    // written (test_edgeql_insert_specified_type).
    if (field === "__type__") {
      preValidationFail("cannot assign to link '__type__'");
    }
  }

  if (!typeDef) return;

  for (const [field, value] of Object.entries(values)) {
    // `name := .name` — a partial path (`.foo`) directly in an INSERT shape
    // value has no enclosing path scope to resolve against
    // (test_edgeql_insert_fail_06).
    if (insertValueHasUnscopedPartialPath(value)) {
      preValidationFail("could not resolve partial path");
    }

    // Assigning a computed pointer is prohibited — computeds derive their
    // value from an expression (test_edgeql_insert_fail_03).
    const computed = (typeDef.computeds ?? []).find((c) => c.name === field);
    if (computed) {
      preValidationFail(
        `modification of computed property '${field}' of object type '${qualifiedTypeName(typeDef)}' is prohibited`,
      );
    }

    // A provably-multi expression assigned to a `single` link.
    const link = (typeDef.links ?? []).find((l) => l.name === field);
    if (link && !link.multi && insertValueProvablyMulti(ctx, value)) {
      preValidationFail(
        `possibly more than one element returned by an expression for a link '${field}' declared as 'single'`,
      );
    }

    // An explicitly-cast empty set (`<datetime>{}`, `<Object>{}`) whose cast
    // target type doesn't match the declared pointer type
    // (test_edgeql_insert_empty_02/05). Resolve the pointer via inheritance so
    // derived types are covered.
    checkEmptyCastTargetType(ctx, typeDef, field, value);

    // Empty/array-typed scalar assignments to a scalar property
    // (test_edgeql_insert_empty_array_01/02/03): a bare `[]` has indeterminate
    // type, and an array/element type that disagrees with the declared
    // property type is an invalid target.
    checkArrayValuedScalarTarget(ctx, typeDef, field, value);

    // A link value carrying a link-property computed body of indeterminate
    // type — `subordinates := (SELECT Sub { @comment := [] })`
    // (test_edgeql_insert_empty_array_04). The scalar guard above only sees
    // top-level shape fields, so reach into the link value's own shape and
    // reject any `@prop := <indeterminate>` linkprop body.
    checkIndeterminateLinkPropTarget(value);

    // A link value that references the (non-detached) extent of the type being
    // inserted — `INSERT SelfRef { ref := SelfRef }` and SELECT/WITH variants
    // (test_edgeql_insert_selfref_01/02/03). DETACHED breaks the correlation
    // and is permitted (selfref_04).
    if (link && insertValueIsSelfReference(ctx, value, qualifiedTypeName(typeDef))) {
      preValidationFail("self-referencing INSERTs are not allowed");
    }
  }
}

// True when `value` references the bare extent of `selfTypeName` (the type
// being inserted) without DETACHED — directly (`SelfRef`), via an inline
// SELECT (`SELECT SelfRef …`), or via a WITH binding (`WITH X := SelfRef
// SELECT X …`). FILTER/ORDER/LIMIT clauses don't matter: any live reference
// to the same extent during its own INSERT is disallowed.
function insertValueIsSelfReference(ctx: AstPreValidationCtx, value: unknown, selfTypeName: string): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown> & { kind?: string };

  // Bare extent reference: `ref := SelfRef`.
  if (node.kind === "binding_ref" && typeof node.name === "string" && !ctx.bindings.has(node.name)) {
    const def = lookupAstObjectType(ctx, node.name);
    return def !== undefined && qualifiedTypeName(def) === selfTypeName;
  }

  // Inline SELECT: `(SELECT SelfRef …)` or `(WITH X := SelfRef SELECT X …)`.
  if (node.kind === "select" && typeof node.typeName === "string") {
    if (node.detached === true) return false;
    const clauses = (node.clauses as Record<string, unknown> | undefined) ?? {};
    const withBindings = (clauses._withBindings as Array<{ name: string; value: unknown }> | undefined) ?? [];
    // Resolve the select subject through any local WITH binding.
    let subject = node.typeName as string;
    for (const b of withBindings) {
      if (b.name === subject) {
        const bv = b.value as Record<string, unknown> & { kind?: string };
        if (bv?.kind === "binding_ref" && typeof bv.name === "string") subject = bv.name;
        else if (bv?.kind === "select" && typeof bv.typeName === "string") subject = bv.typeName as string;
        break;
      }
    }
    const def = lookupAstObjectType(ctx, subject);
    return def !== undefined && qualifiedTypeName(def) === selfTypeName;
  }

  return false;
}

// Type descriptor inferred for an INSERT-shape scalar value expression.
// Reject a link-property computed body whose value type is indeterminate —
// `subordinates := (SELECT Sub { @comment := [] })`
// (test_edgeql_insert_empty_array_04). A bare empty array `[]` in a linkprop
// body has no element type and must error rather than silently writing an
// empty value. The shape parser folds `@comment := []` to a literal carrying
// the JSON text `"[]"`, so recognise both that and the `array_literal` form.
function checkIndeterminateLinkPropTarget(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown> & { kind?: string };

  // Unwrap the shapes a link value can take to reach the `@`-prefixed shape
  // elements: `select`/`shape_projection`/`expr`/`select_expr_subquery`.
  let shape: unknown[] | undefined;
  if (node.kind === "select" && Array.isArray(node.shape)) shape = node.shape as unknown[];
  else if (node.kind === "shape_projection" && Array.isArray(node.shape)) shape = node.shape as unknown[];
  else if (node.kind === "expr") return checkIndeterminateLinkPropTarget(node.expr);
  else if (node.kind === "select_expr" || node.kind === "select_expr_subquery") return checkIndeterminateLinkPropTarget(node.expr);

  if (!shape) return;
  for (const raw of shape) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as Record<string, unknown> & { kind?: string; name?: string };
    if (el.kind !== "computed" || typeof el.name !== "string" || !el.name.startsWith("@")) continue;
    const body = el.expr as Record<string, unknown> & { kind?: string } | undefined;
    if (!body) continue;
    const isEmptyArrayLiteral = body.kind === "array_literal"
      && Array.isArray(body.values) && (body.values as unknown[]).length === 0;
    const isFoldedEmptyArray = body.kind === "literal" && body.value === "[]";
    if (isEmptyArrayLiteral || isFoldedEmptyArray) {
      preValidationFail("expression returns value of indeterminate type");
    }
  }
}

// Reject array-valued or indeterminate assignments to a scalar property.
function checkArrayValuedScalarTarget(
  ctx: AstPreValidationCtx,
  typeDef: TypeDef,
  field: string,
  value: unknown,
): void {
  const inferred = inferArrayValuedType(value);
  if (!inferred) return;

  const pointer = findAstPointer(ctx, typeDef, field);
  // Only meaningful for scalar properties (links can't take arrays/scalars).
  if (!pointer || pointer.kind !== "field") return;
  // Collection-typed properties (declared `array<...>`) legitimately take
  // array values — leave those to downstream handling.
  if (pointer.field.collection) return;

  if (inferred.kind === "indeterminate") {
    preValidationFail("expression returns value of indeterminate type");
  }

  const declared = declaredScalarTypeName(pointer.field);
  const actual = inferred.kind === "array" ? `array<${inferred.element}>` : inferred.name;
  if (actual !== declared) {
    preValidationFail(
      `invalid target for property '${field}' of object type ` +
      `'${qualifiedTypeName(typeDef)}': '${actual}' (expecting '${declared}')`,
    );
  }
}

// Reject an `<T>{}` assignment whose cast target `T` is incompatible with the
// declared property/link type. Empty sets without a cast are fine (they unify
// with any type); only an explicit, mismatched cast is an error.
function checkEmptyCastTargetType(
  ctx: AstPreValidationCtx,
  typeDef: TypeDef,
  field: string,
  value: unknown,
): void {
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown> & { kind?: string };
  if (node.kind !== "set" || typeof node.castType !== "string") return;
  if (((node.values as unknown[] | undefined)?.length ?? 0) !== 0) return;

  const pointer = findAstPointer(ctx, typeDef, field);
  if (!pointer) return;

  const castName = qualifyCastTypeName(ctx, node.castType);

  if (pointer.kind === "field") {
    const declared = declaredScalarTypeName(pointer.field);
    if (castName !== declared) {
      preValidationFail(
        `invalid target for property '${field}' of object type ` +
        `'${qualifiedTypeName(typeDef)}': '${castName}' (expecting '${declared}')`,
      );
    }
  } else {
    // Link: the cast target must be assignable to the link's declared target.
    const declared = qualifyAstTypeName(pointer.link.targetType, ctx.module);
    if (castName === declared) return;
    const castObj = lookupAstObjectType(ctx, node.castType);
    const declaredObj = ctx.schema.getType(declared);
    const compatible =
      castObj && declaredObj &&
      ctx.schema.concreteTypeNamesUnder(declared).includes(qualifiedTypeName(castObj));
    if (!compatible) {
      preValidationFail(
        `invalid target for link '${field}' of object type ` +
        `'${qualifiedTypeName(typeDef)}': '${castName}' (expecting '${declared}')`,
      );
    }
  }
}

// A SELECT tuple `(S, (INSERT … ref-to-S))` correlates its elements: a DML
// statement in one element may not reference (or insert into) a set that also
// appears as a bare extent in a sibling element. Detect that and reject with
// EdgeQL's "cannot reference correlated set" wording
// (test_edgeql_insert_correlated_bad_01/02/03, for_bad_*).
function checkCorrelatedDmlInTuple(ctx: AstPreValidationCtx, elements: unknown[]): void {
  // Bare object-type extents referenced as tuple elements (`Subordinate`,
  // `Person` — a whole-set SELECT with no narrowing clauses).
  const correlated = new Set<string>();
  for (const el of elements) {
    const name = bareObjectExtentName(ctx, el);
    if (name) correlated.add(name);
  }
  if (correlated.size === 0) return;

  for (const el of elements) {
    const dml = unwrapToInsert(el);
    if (!dml) continue;
    const referenced = insertReferencesCorrelatedSet(ctx, dml.insert, dml.forIterators, correlated);
    if (referenced) {
      preValidationFail(`cannot reference correlated set '${referenced}' here`);
    }
  }
}

// Resolve a tuple element that is a plain reference to an object type's full
// extent (no FILTER/LIMIT/OFFSET/ORDER), returning the type name.
function bareObjectExtentName(ctx: AstPreValidationCtx, value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown> & { kind?: string };
  if (node.kind === "select" && typeof node.typeName === "string") {
    const clauses = (node.clauses as Record<string, unknown> | undefined) ?? {};
    if (clauses.filter !== undefined || clauses.limit !== undefined || clauses.offset !== undefined || clauses.order !== undefined) {
      return undefined;
    }
    const qn = qualifyAstTypeName(node.typeName as string, ctx.module);
    if (lookupAstObjectType(ctx, node.typeName as string)) return qn.slice(qn.lastIndexOf("::") + 2);
  }
  if (node.kind === "binding_ref" && typeof node.name === "string" && !ctx.bindings.has(node.name)) {
    if (lookupAstObjectType(ctx, node.name as string)) return node.name as string;
  }
  return undefined;
}

// Peel `mutation_expr` / `select` / `for_expr` wrappers off a tuple element to
// reach an INSERT, recording any FOR iterators encountered en route (their
// iterated sets count as correlated references too).
function unwrapToInsert(value: unknown, iterators: unknown[] = [], depth = 0): { insert: Record<string, unknown>; forIterators: unknown[] } | undefined {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const node = value as Record<string, unknown> & { kind?: string };
  if (node.kind === "insert") return { insert: node, forIterators: iterators };
  if (node.kind === "mutation_expr") return unwrapToInsert(node.statement, iterators, depth + 1);
  if (node.kind === "select" || node.kind === "select_expr" || node.kind === "select_expr_subquery" || node.kind === "subquery_expr") {
    return unwrapToInsert(node.expr ?? node.statement, iterators, depth + 1);
  }
  if (node.kind === "for_expr" || node.kind === "for") {
    return unwrapToInsert(node.body, [...iterators, node.iterator], depth + 1);
  }
  // A nested tuple (`SELECT (20, (FOR y … INSERT …))`) — descend into each
  // element until an INSERT surfaces, carrying the accumulated FOR iterators.
  if (node.kind === "tuple" && Array.isArray(node.values)) {
    for (const el of node.values) {
      const found = unwrapToInsert(el, iterators, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

// Does an INSERT (possibly within FOR scopes) reference a correlated set name?
function insertReferencesCorrelatedSet(
  ctx: AstPreValidationCtx,
  insert: Record<string, unknown>,
  forIterators: unknown[],
  correlated: Set<string>,
): string | undefined {
  // Inserting into a type that is itself a correlated extent (bad_03).
  const subject = insert.typeName as string | undefined;
  if (subject && correlated.has(subject)) return subject;

  // A FOR loop iterating over a correlated extent (for_bad_*).
  for (const it of forIterators) {
    const name = bareObjectExtentName(ctx, it);
    if (name && correlated.has(name)) return name;
  }

  // A shape value referencing the correlated set by name (bad_01/02).
  let hit: string | undefined;
  walkAstForValidation(insert.values, (n) => {
    if (hit) return;
    if (n.kind === "binding_ref" && typeof n.name === "string" && correlated.has(n.name) && !ctx.bindings.has(n.name)) {
      hit = n.name;
    }
  });
  return hit;
}

// True when an INSERT shape value references a partial path (`.foo`, an AST
// `current_item`) in its own scope, i.e. not nested inside a sub-query that
// would supply the path's source. Such a path has nothing to resolve against.
// True when an INSERT shape value is provably a multi set (more than one
// element). Conservative: only forms we can prove multi return true; anything
// uncertain returns false so well-formed single assignments aren't rejected.
function insertValueProvablyMulti(ctx: AstPreValidationCtx, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown> & { kind?: string };

  // A bare reference to an object type (`sub := Subordinate`) is a multi set
  // unless the name is a WITH/FOR-bound (necessarily single-or-known) variable.
  if (node.kind === "binding_ref") {
    const name = node.name as string;
    if (ctx.bindings.has(name)) return false;
    return lookupAstObjectType(ctx, name) !== undefined;
  }

  // `subject := (SELECT T FILTER …)` — a filtered select over an object type
  // is multi unless it is constrained to at most one element (a `LIMIT 1`, or
  // an equality filter on an exclusive single property).
  if (node.kind === "select" && typeof node.typeName === "string") {
    const clauses = (node.clauses as Record<string, unknown> | undefined) ?? {};
    if (clauses.filter === undefined) return false; // unfiltered: leave to runtime
    if (clauses.limit !== undefined) return false; // LIMIT may pin to one
    return !selectFilterGuaranteesSingle(ctx, node.typeName as string, clauses.filter);
  }

  return false;
}

// Does a SELECT's FILTER guarantee at most one row? True only for an equality
// predicate on an exclusive-constrained single property of the subject type.
function selectFilterGuaranteesSingle(ctx: AstPreValidationCtx, typeName: string, filter: unknown): boolean {
  const pred = filter as Record<string, unknown> & { kind?: string };
  if (!pred || pred.kind !== "predicate" || pred.op !== "=") return false;
  const target = pred.target as Record<string, unknown> & { kind?: string };
  if (!target || target.kind !== "field" || typeof target.field !== "string") return false;
  const typeDef = lookupAstObjectType(ctx, typeName);
  if (!typeDef) return false;
  const fieldDef = (typeDef.fields ?? []).find((f) => f.name === target.field && !f.isLinkColumn);
  if (!fieldDef || fieldDef.multi) return false;
  return (fieldDef.constraints ?? []).some((c) => c.name === "std::exclusive" || c.name === "exclusive");
}

// ── constant index/slice evaluation (bigint_index_01/02/03) ────────────────
//
// `select <literal>[<literal index or slice>]` — the SQL lowering for string
// and JSON subscripting is incomplete (and 64-bit indexes overflow SQLite's
// int32 binding), so evaluate fully-constant subscripts here. Out-of-bounds
// constant indexes raise the reference error.

type ConstSubscriptBase =
  | { category: "array"; items: unknown[] }
  | { category: "string"; chars: string[] }
  | { category: "JSON"; items: unknown[] };

function constSubscriptBase(expr: unknown): ConstSubscriptBase | undefined {
  const node = expr as Record<string, unknown> & { kind?: string };
  if (!node || typeof node !== "object") return undefined;
  if (node.kind === "literal" && typeof node.value === "string") {
    return { category: "string", chars: Array.from(node.value as string) };
  }
  if (node.kind === "array_literal_expr") {
    const values = (node.values as Array<Record<string, unknown> & { kind?: string }>) ?? [];
    if (!values.every((v) => v?.kind === "literal")) return undefined;
    return { category: "array", items: values.map((v) => v.value) };
  }
  if (node.kind === "array_literal") {
    return { category: "array", items: [...((node.values as unknown[]) ?? [])] };
  }
  if (node.kind === "function_call") {
    const call = node.call as FunctionCallExpr | undefined;
    const leaf = call?.name?.includes("::") ? call.name.split("::").pop() : call?.name;
    if (leaf === "to_json" && call?.args.length === 1) {
      const arg = call.args[0];
      let raw: unknown;
      if (arg.kind === "literal") raw = arg.value;
      else if (arg.kind === "expr") {
        const inner = arg.expr as Record<string, unknown> & { kind?: string };
        if (inner?.kind === "literal") raw = inner.value;
      }
      if (typeof raw !== "string") return undefined;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return { category: "JSON", items: parsed };
      } catch {
        // Probe on user input: `to_json('<not json>')` is not a constant
        // subscript base; the normal pipeline reports the invalid JSON.
        return undefined;
      }
    }
  }
  return undefined;
}

function constSubscriptIndexValue(node: Record<string, unknown>): number | undefined {
  const indexExpr = node.indexExpr as Record<string, unknown> & { kind?: string } | undefined;
  if (indexExpr) {
    if (indexExpr.kind === "set_literal") {
      const values = (indexExpr.values as unknown[]) ?? [];
      if (values.length === 1 && typeof values[0] === "number" && Number.isInteger(values[0])) {
        return values[0] as number;
      }
      return undefined;
    }
    if (indexExpr.kind === "literal" && typeof indexExpr.value === "number" && Number.isInteger(indexExpr.value)) {
      return indexExpr.value as number;
    }
    return undefined;
  }
  return typeof node.index === "number" && Number.isInteger(node.index) ? (node.index as number) : undefined;
}

// Returns the rows for a constant subscript statement, or undefined when the
// statement isn't a fully-constant subscript.
function tryEvalConstantSubscriptStatement(statement: Statement): unknown[] | undefined {
  if (statement.kind !== "select_expr") return undefined;
  if ((statement as { with?: unknown[] }).with?.length) return undefined;
  const expr = (statement as { expr?: unknown }).expr as Record<string, unknown> & { kind?: string };
  if (!expr || (expr.kind !== "index_access" && expr.kind !== "slice_access")) return undefined;
  const base = constSubscriptBase(expr.expr);
  if (!base) return undefined;
  const length = base.category === "string" ? base.chars.length : base.items.length;

  if (expr.kind === "index_access") {
    const index = constSubscriptIndexValue(expr);
    if (index === undefined) return undefined;
    const normalized = index < 0 ? length + index : index;
    if (normalized < 0 || normalized >= length) {
      preValidationFail(`${base.category} index ${index} is out of bounds`);
    }
    return [base.category === "string" ? base.chars[normalized] : base.items[normalized]];
  }

  const clamp = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const adjusted = value < 0 ? length + value : value;
    return Math.max(0, Math.min(length, adjusted));
  };
  if (typeof expr.startExpr === "object" && expr.startExpr !== null) return undefined;
  if (typeof expr.endExpr === "object" && expr.endExpr !== null) return undefined;
  const start = clamp(expr.start as number | undefined, 0);
  const end = clamp(expr.end as number | undefined, length);
  const sliceEnd = Math.max(start, end);
  if (base.category === "string") {
    return [base.chars.slice(start, sliceEnd).join("")];
  }
  return [base.items.slice(start, sliceEnd)];
}

// ── runtime assert checks (assert_fail_object_computed_01) ─────────────────
//
// `SELECT assert_exists(<set>).ptr` and `SELECT array_agg(<set>)[i].ptr` —
// the SQL lowering of a pointer step over these calls silently drops empty /
// out-of-bounds results, so evaluate the inner set's cardinality up front.

function unwrapRootPointerSteps(expr: unknown): { node: Record<string, unknown> & { kind: string }; crossedPointer: boolean } | undefined {
  let current = expr as Record<string, unknown> & { kind?: string };
  let crossedPointer = false;
  let guard = 0;
  while (current && typeof current === "object" && guard < 10) {
    if (current.kind === "field_access" || current.kind === "shape_projection") {
      crossedPointer = crossedPointer || current.kind === "field_access";
      current = current.expr as Record<string, unknown> & { kind?: string };
      guard += 1;
      continue;
    }
    if (current.kind === "select_expr_subquery" && !current.filter && !current.orderBy) {
      current = current.expr as Record<string, unknown> & { kind?: string };
      guard += 1;
      continue;
    }
    break;
  }
  if (!current || typeof current.kind !== "string") return undefined;
  return { node: current as Record<string, unknown> & { kind: string }, crossedPointer };
}

function functionCallLeafName(call: FunctionCallExpr | undefined): string | undefined {
  if (!call || typeof call.name !== "string") return undefined;
  return call.name.includes("::") ? call.name.split("::").pop() : call.name;
}

function countFunctionArgRows(
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  statement: Statement,
  arg: FunctionCallArgExpr,
  context: SecurityContext,
  runtimeTarget: RuntimeTarget,
): number | undefined {
  if (arg.kind !== "expr") return undefined;
  const innerStatement = {
    kind: "select_expr",
    expr: arg.expr,
    with: (statement as { with?: WithBinding[] }).with,
    withModule: (statement as { withModule?: string }).withModule,
    pos: (statement as { pos?: { line: number; column: number } }).pos ?? { line: 1, column: 1 },
  } as unknown as Statement;
  try {
    const compiled = getCompilerService().compile(schema, innerStatement, { globals: context.globals, params: context.params, target: runtimeTarget });
    if (!lowersToSingleSql(compiled.sql)) return undefined;
    const rows = runGelSelectSQL(db, schema, compiled.gelIr, context, compiled.sql);
    return rows.length;
  } catch (e) {
    // Args the IR pipeline can't compile/run aren't countable here; the
    // assertion check is skipped for them. Only query failures (tagged
    // AppErrors) may be swallowed — anything else is an engine bug.
    if (!isQueryFailure(e)) throw e;
    return undefined;
  }
}

function enforceRootSetAssertions(
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  statement: Statement,
  context: SecurityContext,
  runtimeTarget: RuntimeTarget,
): void {
  if (statement.kind !== "select_expr") return;
  const unwrapped = unwrapRootPointerSteps((statement as { expr?: unknown }).expr);
  if (!unwrapped || !unwrapped.crossedPointer) return;
  const { node } = unwrapped;

  if (node.kind === "function_call") {
    const call = node.call as FunctionCallExpr | undefined;
    if (call && functionCallLeafName(call) === "assert_exists" && call.args.length >= 1) {
      const count = countFunctionArgRows(db, schema, statement, call.args[0], context, runtimeTarget);
      if (count === 0) {
        throw new AppError("E_SEMANTIC", "assert_exists violation", 1, 1);
      }
    }
    return;
  }

  if (node.kind === "index_access") {
    const base = node.expr as Record<string, unknown> & { kind?: string };
    if (base?.kind !== "function_call") return;
    const call = base.call as FunctionCallExpr | undefined;
    if (!call || functionCallLeafName(call) !== "array_agg" || call.args.length !== 1) return;
    const index = constSubscriptIndexValue(node);
    if (index === undefined) return;
    const count = countFunctionArgRows(db, schema, statement, call.args[0], context, runtimeTarget);
    if (count === undefined) return;
    const normalized = index < 0 ? count + index : index;
    if (normalized < 0 || normalized >= count) {
      throw new AppError("E_SEMANTIC", `array index ${index} is out of bounds`, 1, 1);
    }
  }
}


// The capability seam the Runtime evaluator (runtime/evaluator.ts) reaches back
// into. A function (not a const literal) so it is hoisted for the wrapper above
// and only reads the closed-over module functions when called  after load, so
// none are in their temporal dead zone. The type is derived by `typeof`, so the
// evaluator deps parameter can never drift from what is actually passed.
function selectExprEvaluatorDeps() {
  return {
    evaluateRuntimeAggregate,
    executeFunctionCall,
    executeMutationBinding,
    findFieldDef,
    findRuntimeLinkDef,
    inferStaticArgType,
    likeMatch,
    materializeFieldValue,
    normalizeRuntimeFloat,
    qualifiedRuntimeAliasName,
    qualifyRuntimeTypeName,
    quoteIdent,
    readRuntimeTypedAliasSourceRows,
    resolveBacklinkRowsForSubject,
    resolveUserFunctionOverload,
    runtimeAliasPredicateMatches,
  };
}
export type SelectExprEvaluatorDeps = ReturnType<typeof selectExprEvaluatorDeps>;
