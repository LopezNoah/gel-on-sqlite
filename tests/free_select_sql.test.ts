import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQueryWithTrace } from "../src/runtime/engine.js";
import { gelSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

describe("free object select SQL lowering", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("lowers simple free object selects into SQL projections", () => {
    const schema = schemaSnapshotFromDeclarative(gelSchema`module default {}`);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const trace = executeQueryWithTrace(
      runtime.db,
      schema,
      "select { x := 1, label := 'gel' ++ 'sql', abs := math::abs(-7), as_str := <str>'42' };",
      { runtimeTarget: "d1" },
    );

    expect(trace.sql.loweringMode).toBe("single_statement");
    expect(trace.sql.sql).toBe('SELECT ? AS "x", (COALESCE(CAST(? AS TEXT), \'\') || COALESCE(CAST(? AS TEXT), \'\')) AS "label", abs(?) AS "abs", CAST(? AS TEXT) AS "as_str"');
    expect(trace.result.rows?.[0]).toEqual({ x: 1, label: "gelsql", abs: 7, as_str: "42" });
  });

  it("keeps non-scalar free object selects on runtime fallback", () => {
    const schema = schemaSnapshotFromDeclarative(gelSchema`module default {}`);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const trace = executeQueryWithTrace(
      runtime.db,
      schema,
      "select { xs := {1, 2, 3} };",
      { runtimeTarget: "d1" },
    );

    expect(trace.sql.loweringMode).toBe("fallback_multi_query");
    expect(trace.result.rows?.[0]).toEqual({ xs: [1, 2, 3] });
  });
});
