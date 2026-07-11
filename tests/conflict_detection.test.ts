import { describe, expect, it } from "vitest";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import type { ScalarValue } from "../src/types.js";
import {
  type ExclusiveCheck,
  exclusiveChecksFor,
  insertValueIsVolatile,
  parseExclusivityViolation,
  planExclusiveConflictProbe,
} from "../src/runtime/conflict_detection.js";

// The deepening payoff (ADR 0063): every constraint kind and the conflict-probe
// plan are now exercised through the module's interface — no INSERT, no DB.
// Previously this logic was only reachable by performing a full write.

const SDL = `module default {
  type Account {
    required property email -> str { constraint exclusive; }
    multi property handle -> str { constraint exclusive; }
    property first -> str;
    property last -> str;
    constraint exclusive on ((.first, .last));
  }
  type PremiumAccount extending Account;
}`;

const loadSchema = (): SchemaSnapshot =>
  schemaSnapshotFromDeclarative(parseDeclarativeSchema(SDL, { legacySyntaxCompat: true }));

describe("conflict_detection — parseExclusivityViolation", () => {
  it("recovers the property from a shared cross-type bookkeeping table", () => {
    expect(
      parseExclusivityViolation("UNIQUE constraint failed: __gel_excl__default__Account__col__email__excl__email"),
    ).toEqual({ property: "email", crossType: true });
  });

  it("recovers the property from a direct same-table index, stripping _id", () => {
    expect(parseExclusivityViolation("UNIQUE constraint failed: t_account.email")).toEqual({
      property: "email",
      crossType: false,
    });
    expect(parseExclusivityViolation("UNIQUE constraint failed: t_post.author_id")).toEqual({
      property: "author",
      crossType: false,
    });
  });

  it("returns undefined for a non-UNIQUE error", () => {
    expect(parseExclusivityViolation("no such table: t_account")).toBeUndefined();
  });
});

describe("conflict_detection — insertValueIsVolatile", () => {
  it("flags a volatile function call, qualified or bare, however nested", () => {
    expect(insertValueIsVolatile({ kind: "function_call", name: "random" })).toBe(true);
    expect(insertValueIsVolatile({ kind: "call", name: "std::random" })).toBe(true);
    expect(insertValueIsVolatile({ kind: "binary", left: { kind: "func_call", name: "datetime_current" } })).toBe(true);
    expect(insertValueIsVolatile([{ kind: "literal", value: 1 }, { kind: "call", name: "uuid_generate_v4" }])).toBe(true);
  });

  it("does not flag a non-volatile expression", () => {
    expect(insertValueIsVolatile({ kind: "call", name: "str_upper", args: [{ kind: "literal", value: "x" }] })).toBe(false);
    expect(insertValueIsVolatile({ kind: "literal", value: 42 })).toBe(false);
  });
});

describe("conflict_detection — planExclusiveConflictProbe (the pure emitter)", () => {
  const single: ExclusiveCheck = { fields: ["email"], columns: ["email"], lower: false, tables: ["t_account"], fromParent: false };
  const multi: ExclusiveCheck = { fields: ["handle"], columns: ["handle"], lower: false, multiProp: "handle", tables: ["t_account"], fromParent: false };

  it("plans a single-column probe with the resolved value", () => {
    expect(planExclusiveConflictProbe(single, { email: "a@b.com" })).toEqual({
      kind: "single",
      tables: ["t_account"],
      columns: ["email"],
      lower: false,
      values: ["a@b.com"],
    });
  });

  it("declines (null) when a covered value is absent — empty sets cannot clash", () => {
    expect(planExclusiveConflictProbe(single, { email: undefined })).toBeNull();
    expect(planExclusiveConflictProbe(single, { email: null as unknown as undefined })).toBeNull();
  });

  it("preserves the case-insensitive flag", () => {
    expect(planExclusiveConflictProbe({ ...single, lower: true }, { email: "A@B.com" })).toMatchObject({ lower: true });
  });

  // A multi-property's resolved value is the multi-SET (an array); the write
  // executor supplies it through the `ScalarValue` slot via a cast, so the test
  // mirrors that here.
  const multiSet = (items: ScalarValue[]): ScalarValue => items as unknown as ScalarValue;

  it("plans a multi-property probe over the link table, normalizing a scalar to a 1-item list", () => {
    expect(planExclusiveConflictProbe(multi, { handle: multiSet(["x", "y"]) })).toEqual({
      kind: "multi",
      tables: ["t_account"],
      multiProp: "handle",
      items: ["x", "y"],
    });
    expect(planExclusiveConflictProbe(multi, { handle: "solo" })).toMatchObject({ items: ["solo"] });
  });

  it("declines an empty multi set", () => {
    expect(planExclusiveConflictProbe(multi, { handle: multiSet([]) })).toBeNull();
  });
});

describe("conflict_detection — exclusiveChecksFor (every constraint kind, no DB)", () => {
  it("enumerates field-level, multi, type-level and the implicit id PK", () => {
    const schema = loadSchema();
    const account = schema.getType("default::Account")!;
    const checks = exclusiveChecksFor(schema, account, undefined);

    expect(checks.some((c) => c.fields.length === 1 && c.fields[0] === "email" && !c.multiProp)).toBe(true);
    expect(checks.some((c) => c.multiProp === "handle")).toBe(true);
    expect(checks.some((c) => c.fields.length === 2 && c.fields.includes("first") && c.fields.includes("last"))).toBe(true);
    expect(checks.some((c) => c.fields.length === 1 && c.fields[0] === "id")).toBe(true);
  });

  it("restricts to the ON-target constraint when targetFields is given", () => {
    const schema = loadSchema();
    const account = schema.getType("default::Account")!;
    const onEmail = exclusiveChecksFor(schema, account, ["email"]);
    expect(onEmail.every((c) => c.fields.length === 1 && c.fields[0] === "email")).toBe(true);
    expect(onEmail.length).toBeGreaterThan(0);
  });

  it("marks an inherited constraint as fromParent on the subtype", () => {
    const schema = loadSchema();
    const premium = schema.getType("default::PremiumAccount")!;
    const checks = exclusiveChecksFor(schema, premium, undefined);
    const emailCheck = checks.find((c) => c.fields.length === 1 && c.fields[0] === "email");
    expect(emailCheck?.fromParent).toBe(true);
  });
});
