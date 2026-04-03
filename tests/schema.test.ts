import { describe, expect, it } from "vitest";

import { SchemaSnapshot } from "../src/schema/schema.js";

describe("SchemaSnapshot", () => {
  it("[SPEC-010.R1] applies deltas immutably", () => {
    const before = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "email", type: "str", required: true }],
      },
    ]);

    const after = before.applyDelta({
      addFields: [
        {
          typeName: "default::User",
          field: { name: "name", type: "str", required: true },
        },
      ],
    });

    const oldFields = before.getType("default::User")?.fields.map((f) => f.name);
    const newFields = after.getType("default::User")?.fields.map((f) => f.name);

    expect(oldFields).toEqual(["email"]);
    expect(newFields).toEqual(["email", "name"]);
  });

  it("[SPEC-010.R3] resolves deterministic module-qualified names", () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [{ name: "email", type: "str", required: true }],
      },
      {
        module: "audit",
        name: "User",
        fields: [{ name: "email", type: "str", required: true }],
      },
    ]);

    expect(schema.getType("default::User")?.module).toBe("default");
    expect(schema.getType("audit::User")?.module).toBe("audit");
  });
});
