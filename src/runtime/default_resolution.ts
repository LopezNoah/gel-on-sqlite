// INSERT default-value resolution — fill the columns an INSERT left pending
// because the planner couldn't lower their `default :=` to the literal/
// function-call IR. Five kinds: a literal default, a function-call default, a
// general SQL-evaluated default (`default := (SELECT count(T))`), a
// `__source__`-referencing default (`default := __source__.a + 1`, substituted
// with the row's assigned values), and a snapshot-memoized default (one
// evaluation reused across a FOR loop's rows).
//
// This was a ~97-line closure inside the 660-line write executor
// `runWriteWithAccessPolicies`, reachable only by running an INSERT. It is
// lifted out behind a small injected-deps interface so each default kind is
// directly testable: the engine services it needs (compile+run a SELECT,
// evaluate a function call, recognise a pending sentinel) are passed in, which
// also keeps the dependency one-directional (no engine import cycle). See
// docs/adr/0039.
import type { ScalarValue, TypeDef } from "../types.js";
import type { Statement } from "../edgeql/ast.js";
import type { RuntimeFunctionArg } from "../stdlib/functions.js";
import { AppError, tryResult } from "../errors.js";
import { parseEdgeQL } from "../edgeql/parser.js";

export interface InsertDefaultDeps {
  // The type being inserted — its `fields` carry the default specs.
  subjectType: TypeDef;
  // Per-statement memo for snapshot-valued defaults: a FOR loop inserting N
  // rows evaluates `default := (SELECT count(T))` once against the pre-statement
  // snapshot and reuses it. Undefined for standalone INSERTs.
  snapshotDefaultCache?: Map<string, ScalarValue>;
  // Compile + run a SELECT statement against the current state, returning its
  // rows, or undefined when it doesn't lower to a single SQL statement.
  // Injected (wraps the compiler service + runtime target + the SQL read path)
  // to avoid an import cycle with engine.ts.
  evalSelect: (stmt: Statement) => unknown[] | undefined;
  // Evaluate a function-call default body (`default := std::datetime_current()`).
  evalFunctionCall: (name: string, args: RuntimeFunctionArg[]) => unknown;
  // True when a `__source__.<field>` value is statically known — i.e. not
  // undefined and not one of the engine's pending-insert sentinels.
  isResolvedSourceValue: (value: ScalarValue | undefined) => boolean;
  // True when an already-present column value is the engine's rewrite-pending
  // sentinel — such a column still needs its default resolved here. (The engine
  // owns the sentinel's canonical definition.)
  isPendingRewriteValue: (value: ScalarValue) => boolean;
}

const isScalarValue = (value: unknown): value is ScalarValue =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

// Fill `values` in place for every field whose default the planner left pending.
export const applyPendingInsertDefaults = (
  values: Record<string, ScalarValue>,
  deps: InsertDefaultDeps,
): void => {
  const { subjectType, snapshotDefaultCache } = deps;
  for (const field of subjectType.fields) {
    if (!field.hasDefault) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, field.name)
      && !deps.isPendingRewriteValue(values[field.name])) {
      continue;
    }

    const defaultExpr = field.defaultExpr;
    if (!defaultExpr) {
      // Expression defaults that don't fit the literal/function-call IR
      // (`default := __source__.a + 1`) — evaluate the declared text via a
      // one-off SQL SELECT with `__source__.<f>` references substituted by
      // the row's assigned values.
      const text = field.defaultExprText;
      if (text && text.includes("__source__")) {
        const substituteSourceRefs = (node: unknown): unknown => {
          if (Array.isArray(node)) return node.map(substituteSourceRefs);
          if (node === null || typeof node !== "object") return node;
          const n = node as Record<string, unknown> & { kind?: string };
          if (n.kind === "field_access"
              && typeof n.field === "string"
              && n.expr && typeof n.expr === "object"
              && ((n.expr as { kind?: string }).kind === "global_ref" || (n.expr as { kind?: string }).kind === "binding_ref")
              && (n.expr as { name?: string }).name === "__source__") {
            const sourceValue = values[n.field];
            if (!deps.isResolvedSourceValue(sourceValue)) {
              throw new AppError("E_UNSUPPORTED", `__source__.${n.field} is not statically known`);
            }
            return { kind: "literal", value: sourceValue };
          }
          const out: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(n)) out[key] = substituteSourceRefs(value);
          return out;
        };
        // captureAll: a default we can't evaluate just stays pending (the
        // column is omitted, matching "no computable default").
        const attempt = tryResult(() => {
          const parsed = parseEdgeQL(`SELECT (${text})`);
          const stmt = substituteSourceRefs(Array.isArray(parsed) ? parsed[0] : parsed) as Statement;
          return deps.evalSelect(stmt);
        }, { captureAll: true });
        if (attempt.ok && attempt.value !== undefined && attempt.value.length === 1 && isScalarValue(attempt.value[0])) {
          values[field.name] = attempt.value[0] as ScalarValue;
        }
      } else if (text) {
        // A general expression-valued default that didn't fit the
        // literal/function-call IR (`default := (SELECT count(T))`,
        // `default := ((SELECT T ORDER BY .n DESC LIMIT 1).n + 1)`).
        // Evaluate it via a one-off SQL SELECT against the *current* (pre-
        // insert) state — the new row isn't written yet, so the default sees
        // exactly the snapshot it should. Within one statement (FOR loop) the
        // snapshot is fixed, so memoize the first evaluation per field and
        // reuse it for every row. `captureAll` keeps the column pending if it
        // can't lower (matching "no computable default").
        if (snapshotDefaultCache?.has(field.name)) {
          values[field.name] = snapshotDefaultCache.get(field.name) as ScalarValue;
        } else {
          const attempt = tryResult(() => {
            const parsed = parseEdgeQL(`SELECT (${text})`);
            const stmt = (Array.isArray(parsed) ? parsed[0] : parsed) as Statement;
            return deps.evalSelect(stmt);
          }, { captureAll: true });
          if (attempt.ok && attempt.value !== undefined && attempt.value.length === 1 && isScalarValue(attempt.value[0])) {
            values[field.name] = attempt.value[0] as ScalarValue;
            snapshotDefaultCache?.set(field.name, attempt.value[0] as ScalarValue);
          }
        }
      }
      continue;
    }

    if (defaultExpr.kind === "literal") {
      values[field.name] = defaultExpr.value;
      continue;
    }

    const evaluated = deps.evalFunctionCall(defaultExpr.name, defaultExpr.args as RuntimeFunctionArg[]);
    if (isScalarValue(evaluated)) {
      values[field.name] = evaluated;
      continue;
    }

    if (Array.isArray(evaluated) && evaluated.length > 0 && isScalarValue(evaluated[0])) {
      values[field.name] = evaluated[0] as ScalarValue;
    }
  }
};
