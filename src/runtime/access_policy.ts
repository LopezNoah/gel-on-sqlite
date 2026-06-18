// Access-policy enforcement — the one home for "does this security context pass
// the access policies declared on this type for this operation?". The policy
// rules (allow-any-then-deny-veto, per-operation applicability, condition
// evaluation, global/permission resolution) used to be a coherent but scattered
// cluster of bare functions inside the 13k-line `engine.ts`; they are collected
// here behind a small interface so the enforcement contract has a test surface
// independent of executing a full mutation.
//
// The *read*-time check (`evaluateSelectPolicies`) stays in `engine.ts`: it
// needs the shared row helpers (`rowSourceType`, `readRowById`) and the SQL
// read path, and it delegates the actual decision to `evaluatePoliciesForOperation`
// here. See docs/adr/0037.
import type { AccessPolicyCondition, AccessPolicyDef, ScalarValue, TypeDef } from "../types.js";
import type { SecurityContext } from "./engine.js";
import { qualifiedTypeName } from "../schema/schema.js";
import { AppError } from "../errors.js";

// True when the context carries `permissionName` (superusers carry every
// permission). The data-modification guard and policy `global`/permission
// conditions both consult this.
export const hasPermission = (context: SecurityContext, permissionName: string): boolean => {
  if (context.isSuperuser) {
    return true;
  }

  return new Set(context.permissions ?? []).has(permissionName);
};

// Resolve a policy condition's `global`/permission reference against the
// context: a permission name → a boolean, a declared global → its value
// (matched by full or short name), else a permission probe, else undefined.
export const resolveGlobalValue = (context: SecurityContext, name: string): ScalarValue | undefined => {
  if ((name.startsWith("sys::perm::") || name.startsWith("cfg::perm::") || name.includes("::perm::")) && !name.startsWith("global ")) {
    return hasPermission(context, name);
  }

  if (Object.prototype.hasOwnProperty.call(context.globals ?? {}, name)) {
    return context.globals?.[name];
  }

  if (name.includes("::")) {
    const shortName = name.split("::").at(-1);
    if (shortName && Object.prototype.hasOwnProperty.call(context.globals ?? {}, shortName)) {
      return context.globals?.[shortName];
    }
  }

  if (hasPermission(context, name)) {
    return true;
  }

  return undefined;
};

// Evaluate one policy condition against an in-memory row + the context.
export const evaluateCondition = (
  condition: AccessPolicyCondition,
  row: Record<string, unknown>,
  context: SecurityContext,
): boolean => {
  switch (condition.kind) {
    case "always":
      return condition.value;
    case "global": {
      const globalValue = resolveGlobalValue(context, condition.name);
      if (typeof globalValue === "boolean") {
        return globalValue;
      }
      return globalValue !== null && globalValue !== undefined;
    }
    case "field_eq_global": {
      const globalValue = resolveGlobalValue(context, condition.global);
      return row[condition.field] === globalValue;
    }
    case "field_eq_literal":
      return row[condition.field] === condition.value;
    case "and":
      return condition.clauses.every((clause) => evaluateCondition(clause, row, context));
    default:
      return false;
  }
};

// Whether a policy governs `operation`. `update_read`/`update_write` are both
// covered by an `update` policy (and by `all`).
export const appliesToOperation = (
  policy: AccessPolicyDef,
  operation: "select" | "insert" | "update_read" | "update_write" | "delete",
): boolean => {
  if (policy.operations.includes("all")) {
    return true;
  }

  if (operation === "update_read" || operation === "update_write") {
    return policy.operations.includes(operation) || policy.operations.includes("all");
  }

  return policy.operations.includes(operation);
};

// Evaluate a single policy against the row. A policy carrying a `USING (...)`
// predicate (`usingExprText`) is evaluated through the SQL pipeline via the
// injected `evalUsingExpr` (the engine scopes it to the subject and lowers it
// to SQL); without that injection it has no statically-known truth value, so a
// predicate-bearing policy is treated as not-satisfied. Predicate-free policies
// fall back to the structured `condition`.
const evalPolicyAgainstRow = (
  policy: AccessPolicyDef,
  row: Record<string, unknown>,
  context: SecurityContext,
  evalUsingExpr?: PolicyExprEvaluator,
): boolean => {
  if (policy.usingExprText !== undefined) {
    return evalUsingExpr ? evalUsingExpr(policy, row) : false;
  }
  return evaluateCondition(policy.condition, row, context);
};

// Resolves a policy's `USING (...)` predicate for a concrete subject row by
// lowering it to SQL (injected by the engine, which owns the DB/schema).
export type PolicyExprEvaluator = (policy: AccessPolicyDef, row: Record<string, unknown>) => boolean;

// The core decision: a row passes iff some `allow` policy's condition holds and
// no `deny` policy's condition holds. No relevant policy → deny (false). With
// `failOnDeny`, a matched deny throws its message instead of returning false.
export const evaluatePoliciesForOperation = (
  typeDef: TypeDef,
  operation: "select" | "insert" | "update_read" | "update_write" | "delete",
  row: Record<string, unknown>,
  context: SecurityContext,
  options: { failOnDeny: boolean; evalUsingExpr?: PolicyExprEvaluator },
): boolean => {
  const policies = typeDef.accessPolicies ?? [];
  if (policies.length === 0 || context.isSuperuser) {
    return true;
  }

  const relevant = policies.filter((policy) => appliesToOperation(policy, operation));
  if (relevant.length === 0) {
    return false;
  }

  const allows = relevant.filter((policy) => policy.effect === "allow");
  const denies = relevant.filter((policy) => policy.effect === "deny");
  const allowed = allows.some((policy) => evalPolicyAgainstRow(policy, row, context, options.evalUsingExpr));
  if (!allowed) {
    return false;
  }

  for (const deny of denies) {
    if (evalPolicyAgainstRow(deny, row, context, options.evalUsingExpr)) {
      if (options.failOnDeny) {
        throw new Error(deny.errmessage ?? `Denied by policy '${deny.name}'`);
      }
      return false;
    }
  }

  return true;
};

export const enforceInsertPolicies = (
  typeDef: TypeDef,
  values: Record<string, unknown>,
  context: SecurityContext,
  line: number,
  column: number,
  evalUsingExpr?: PolicyExprEvaluator,
): void => {
  const row: Record<string, unknown> = { ...values };
  const ok = evaluatePoliciesForOperation(typeDef, "insert", row, context, { failOnDeny: true, evalUsingExpr });
  if (!ok) {
    throw new AppError("E_RUNTIME", `access policy violation on insert of ${qualifiedTypeName(typeDef)}`, line, column);
  }
};

export const enforceUpdateReadPolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
  evalUsingExpr?: PolicyExprEvaluator,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "update_read", row, context, { failOnDeny: true, evalUsingExpr });
    if (!ok) {
      throw new AppError("E_RUNTIME", `access policy violation on update read of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};

export const enforceUpdateWritePolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
  evalUsingExpr?: PolicyExprEvaluator,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "update_write", row, context, { failOnDeny: true, evalUsingExpr });
    if (!ok) {
      throw new AppError("E_RUNTIME", `access policy violation on update write of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};

export const enforceDeletePolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
  evalUsingExpr?: PolicyExprEvaluator,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "delete", row, context, { failOnDeny: true, evalUsingExpr });
    if (!ok) {
      throw new AppError("E_RUNTIME", `access policy violation on delete of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};
