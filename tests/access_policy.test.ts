import { describe, expect, it } from "vitest";
import {
  appliesToOperation,
  enforceInsertPolicies,
  evaluateCondition,
  evaluatePoliciesForOperation,
  hasPermission,
  resolveGlobalValue,
} from "../src/runtime/access_policy.js";
import type { SecurityContext } from "../src/runtime/engine.js";
import type { AccessPolicyCondition, AccessPolicyDef, TypeDef } from "../src/types.js";

const ctx = (over: Partial<SecurityContext> = {}): SecurityContext => ({ ...over });

const policy = (over: Partial<AccessPolicyDef>): AccessPolicyDef =>
  ({
    name: "p",
    effect: "allow",
    operations: ["all"],
    condition: { kind: "always", value: true },
    ...over,
  }) as AccessPolicyDef;

const typeWith = (policies: AccessPolicyDef[]): TypeDef =>
  ({ name: "User", module: "default", fields: [], accessPolicies: policies }) as unknown as TypeDef;

describe("hasPermission", () => {
  it("grants everything to a superuser", () => {
    expect(hasPermission(ctx({ isSuperuser: true }), "anything")).toBe(true);
  });
  it("checks the context permission set otherwise", () => {
    expect(hasPermission(ctx({ permissions: ["a"] }), "a")).toBe(true);
    expect(hasPermission(ctx({ permissions: ["a"] }), "b")).toBe(false);
  });
});

describe("resolveGlobalValue", () => {
  it("resolves a declared global by exact name", () => {
    expect(resolveGlobalValue(ctx({ globals: { "default::current": "u1" } }), "default::current")).toBe("u1");
  });
  it("falls back from a qualified query name to a short global key", () => {
    expect(resolveGlobalValue(ctx({ globals: { current: "u1" } }), "default::current")).toBe("u1");
  });
  it("treats a ::perm:: name as a permission probe", () => {
    expect(resolveGlobalValue(ctx({ permissions: ["sys::perm::x"] }), "sys::perm::x")).toBe(true);
  });
  it("is undefined for an unknown name with no matching permission", () => {
    expect(resolveGlobalValue(ctx(), "nope")).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  it("evaluates literal and field conditions", () => {
    expect(evaluateCondition({ kind: "always", value: false }, {}, ctx())).toBe(false);
    expect(evaluateCondition({ kind: "field_eq_literal", field: "n", value: 5 }, { n: 5 }, ctx())).toBe(true);
    expect(evaluateCondition({ kind: "field_eq_literal", field: "n", value: 5 }, { n: 6 }, ctx())).toBe(false);
  });
  it("matches a field against a global", () => {
    const c = ctx({ globals: { user: "u1" } });
    expect(evaluateCondition({ kind: "field_eq_global", field: "owner", global: "user" }, { owner: "u1" }, c)).toBe(true);
    expect(evaluateCondition({ kind: "field_eq_global", field: "owner", global: "user" }, { owner: "u2" }, c)).toBe(false);
  });
  it("conjoins clauses with `and`", () => {
    const cond: AccessPolicyCondition = { kind: "and", clauses: [{ kind: "always", value: true }, { kind: "field_eq_literal", field: "n", value: 1 }] };
    expect(evaluateCondition(cond, { n: 1 }, ctx())).toBe(true);
    expect(evaluateCondition(cond, { n: 2 }, ctx())).toBe(false);
  });
});

describe("appliesToOperation", () => {
  it("`all` covers every operation", () => {
    expect(appliesToOperation(policy({ operations: ["all"] }), "delete")).toBe(true);
  });
  it("an `update` policy covers update_read and update_write", () => {
    expect(appliesToOperation(policy({ operations: ["update_read"] }), "update_read")).toBe(true);
    expect(appliesToOperation(policy({ operations: ["insert"] }), "update_write")).toBe(false);
  });
});

describe("evaluatePoliciesForOperation", () => {
  const opts = { failOnDeny: false };
  it("passes when there are no policies, or the caller is a superuser", () => {
    expect(evaluatePoliciesForOperation(typeWith([]), "select", {}, ctx(), opts)).toBe(true);
    expect(evaluatePoliciesForOperation(typeWith([policy({ effect: "deny" })]), "select", {}, ctx({ isSuperuser: true }), opts)).toBe(true);
  });
  it("denies when no relevant policy applies", () => {
    expect(evaluatePoliciesForOperation(typeWith([policy({ operations: ["insert"] })]), "select", {}, ctx(), opts)).toBe(false);
  });
  it("requires an allow to match and lets a deny veto it", () => {
    const allowOwner = policy({ effect: "allow", operations: ["select"], condition: { kind: "field_eq_global", field: "owner", global: "u" } });
    const denyHidden = policy({ name: "hide", effect: "deny", operations: ["select"], condition: { kind: "field_eq_literal", field: "hidden", value: true } });
    const c = ctx({ globals: { u: "u1" } });
    const t = typeWith([allowOwner, denyHidden]);
    expect(evaluatePoliciesForOperation(t, "select", { owner: "u1", hidden: false }, c, opts)).toBe(true); // allowed, not denied
    expect(evaluatePoliciesForOperation(t, "select", { owner: "u1", hidden: true }, c, opts)).toBe(false); // deny vetoes
    expect(evaluatePoliciesForOperation(t, "select", { owner: "u2", hidden: false }, c, opts)).toBe(false); // no allow matches
  });
});

describe("enforceInsertPolicies", () => {
  it("throws when the insert is not allowed", () => {
    const t = typeWith([policy({ effect: "allow", operations: ["insert"], condition: { kind: "always", value: false } })]);
    expect(() => enforceInsertPolicies(t, {}, ctx(), 1, 1)).toThrow(/access policy violation on insert/);
  });
  it("passes a permitted insert", () => {
    const t = typeWith([policy({ effect: "allow", operations: ["insert"], condition: { kind: "always", value: true } })]);
    expect(() => enforceInsertPolicies(t, {}, ctx(), 1, 1)).not.toThrow();
  });
});
