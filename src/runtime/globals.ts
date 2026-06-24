// Session globals & query parameters — the per-connection (schema-snapshot-
// scoped) lifecycle of EdgeQL globals (`create global`, `set global`,
// `reset global`) and the normalization of client-supplied query variables.
// Lifted verbatim out of engine.ts (architecture review round 10 / ADR 0054)
// so the global-value WeakMap and its compute-once-cache-default / merge-into-
// context rules have one testable home. The engine capabilities these reach
// back into — the SQL-precompute probe (ADR 0012) and security-context
// normalization — are injected via `GlobalsDeps`, so the module imports no
// engine runtime (no-cycle discipline; the shared TYPES come type-only).
import type { ConfigureStatement, DDLStatement, FreeObjectExpr, SelectExprStatement, Statement } from "../edgeql/ast.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import type { ScalarValue } from "../types.js";
import type { CompileContext } from "../compiler/service.js";
import type { SQLiteDatabase } from "./database.js";
import type { QueryVariables, SecurityContext } from "./engine.js";

// The engine capabilities the globals lifecycle injects rather than imports.
export interface GlobalsDeps {
  tryRunSingleSqlRows(
    db: SQLiteDatabase,
    schema: SchemaSnapshot,
    stmtAst: Statement,
    context: SecurityContext,
    compileContext?: CompileContext,
  ): unknown[] | undefined;
  normalizeSecurityContext(context: SecurityContext): SecurityContext;
  DEFAULT_SECURITY_CONTEXT: SecurityContext;
}

const isScalarValue = (value: unknown): value is ScalarValue =>
  value === null || typeof value === "string" || typeof value === "number"
  || typeof value === "boolean" || typeof value === "bigint";

// Per-connection (schema-snapshot-scoped) values for session globals,
// keyed by the global's unqualified name. Computed globals cache their
// once-evaluated default here; settable globals store their `set` value
// (absent ⇒ empty set). Merged into `context.globals` before each compile.
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
const evaluateGlobalExpr = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: FreeObjectExpr,
  context: SecurityContext,
  deps: GlobalsDeps,
): ScalarValue | undefined => {
  const { tryRunSingleSqlRows } = deps;
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
export const applyCreateGlobalDDL = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: DDLStatement,
  defaultModule: string,
  deps: GlobalsDeps,
): void => {
  const { normalizeSecurityContext, DEFAULT_SECURITY_CONTEXT } = deps;
  const name = ast.name;
  // `create global mod::a` carries the module in the qualified name; otherwise
  // it lives in the statement's WITH-module or the script default module.
  const qualified = name.includes("::") ? name : `${ast.withModule ?? defaultModule}::${name}`;
  const [moduleName, shortName] = qualified.split("::");
  schema.addGlobal({ module: moduleName, name: shortName, exprText: ast.value ? "<computed>" : undefined });
  const values = globalValuesFor(schema);
  if (ast.value) {
    const evaluated = evaluateGlobalExpr(db, schema, ast.value, normalizeSecurityContext(DEFAULT_SECURITY_CONTEXT), deps);
    if (evaluated === undefined) values.delete(shortName);
    else values.set(shortName, evaluated);
  } else {
    // Settable global: empty until a `set global` assigns it.
    values.delete(shortName);
  }
};

// Applies `SET GLOBAL <name> := <expr>` / `RESET GLOBAL <name>` to the
// connection's per-schema global state.
export const applySessionGlobal = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: ConfigureStatement,
  context: SecurityContext,
  deps: GlobalsDeps,
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
  const evaluated = evaluateGlobalExpr(db, schema, ast.value, context, deps);
  if (evaluated === undefined) values.delete(name);
  else values.set(name, evaluated);
};

// Merges the per-schema session-global values into a context's `globals` map.
// Caller-supplied globals win over stored defaults (so explicit query-time
// globals can still override). Returns a new context; the original is unchanged.
export const withSessionGlobals = (schema: SchemaSnapshot, context: SecurityContext): SecurityContext => {
  const stored = globalValuesBySchema.get(schema);
  if (!stored || stored.size === 0) return context;
  const merged: Record<string, ScalarValue> = {};
  for (const [k, v] of stored) merged[k] = v;
  return { ...context, globals: { ...merged, ...(context.globals ?? {}) } };
};

// Normalizes client-supplied query variables (positional array or named
// object) into the engine's flat param map; objects/arrays are JSON-encoded,
// booleans become 1/0, null/undefined become null.
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

export const normalizeQueryVariables = (variables: QueryVariables): Record<string, ScalarValue> => {
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
