import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery, executeQueryWithTrace } from "../src/runtime/engine.js";
import { gelSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

describe("SQL compiler: union-target links", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("lowers inline union-target link payloads into the root SQL statement", () => {
    const schema = schemaSnapshotFromDeclarative(gelSchema`
      module default {
        type User {
          required name: str;
        }

        type Organization {
          required name: str;
        }

        type Issue {
          required title: str;
          owner: User | Organization;
        }
      }
    `);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    executeQuery(runtime.db, schema, "insert default::User { name := 'Ada' };");
    executeQuery(runtime.db, schema, "insert default::Organization { name := 'Gel' };");
    executeQuery(runtime.db, schema, "insert default::Issue { title := 'user-owned', owner := (select default::User filter .name = 'Ada') };");
    executeQuery(runtime.db, schema, "insert default::Issue { title := 'org-owned', owner := (select default::Organization filter .name = 'Gel') };");

    const trace = executeQueryWithTrace(
      runtime.db,
      schema,
      "select default::Issue { title, owner: { name, type_name := .__type__.name } } order by .title;",
    );

    expect(trace.sql.loweringMode).toBe("single_statement");
    expect(trace.sql.sql).toContain("UNION ALL");
    expect(trace.sqlTrail.filter((entry) => entry.loweringMode === "fallback_multi_query")).toHaveLength(0);
    expect(trace.result.rows).toEqual([
      { title: "org-owned", owner: { name: "Gel", type_name: "default::Organization" } },
      { title: "user-owned", owner: { name: "Ada", type_name: "default::User" } },
    ]);
  });
});
