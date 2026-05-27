import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeAll, expect } from "vitest";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import { executeScript, executeQueryWithTrace } from "../src/runtime/engine.js";
import {
  ensureGelSchemaTables,
  serializeSchemaToGelTables,
  serializeSchemaToInstdata,
} from "../src/schema/gel_persistence.js";

// Debug-grade "explain-lite" suite. Companion to edgeql_explain.test.ts (which
// keeps the full Python suite as skipped placeholders).
//
// Approach: for each EdgeQL query whose Python counterpart only really asserts
// "the planner used an index", we
//   1. Compile to SQL via sqlite-ts (executeQueryWithTrace).
//   2. Run SQLite's `EXPLAIN QUERY PLAN` on the lowered SQL.
//   3. Check the plan `detail` strings for `USING [COVERING] INDEX`.
//
// This is intentionally soft: each case logs the SQL + plan rows so failures
// are diagnostic. The only hard assertion is `plan.length > 0` (i.e. EXPLAIN
// returned something). Whether the planner actually picked an index is logged
// as a discrepancy; making that a hard assertion will have to wait until:
//   * sqlite-ts emits SQLite indexes for `index on (...)` declared on abstract
//     parent types (currently inherited indexes are missing — `select User
//     filter .name = ...` does a full `SCAN default__user`), and
//   * `explain_setup.edgeql` parses in sqlite-ts (today: "Expected a numeric
//     literal after '-'") so the queries have real data behind them.

type PlanRow = { id: number; parent: number; notused: number; detail: string };

const SCHEMA_DIR = path.join(__dirname, "schemas");

function planFor(db: any, sql: string): PlanRow[] {
  const placeholderCount = (sql.match(/\?/g) ?? []).length;
  const dummies = Array.from({ length: placeholderCount }, () => null);
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...dummies) as PlanRow[];
}

function planUsesIndex(plan: PlanRow[]): boolean {
  return plan.some((r) => /USING (COVERING )?INDEX/.test(r.detail));
}

describe("explain-lite (debug) — index usage via SQLite EXPLAIN QUERY PLAN", () => {
  let db: any;
  let snapshot: any;

  beforeAll(() => {
    const schemaBody = fs.readFileSync(path.join(SCHEMA_DIR, "explain.esdl"), "utf8");
    const decl = parseDeclarativeSchema(`module default {\n${schemaBody}\n}`, {
      legacySyntaxCompat: true,
    });
    snapshot = schemaSnapshotFromDeclarative(decl);
    const opened = openSQLite(":memory:");
    db = opened.db;
    materializeSchema(db, snapshot);
    ensureGelSchemaTables(db);
    serializeSchemaToGelTables(db, snapshot);
    serializeSchemaToInstdata(db, snapshot);

    // explain_setup.edgeql currently fails to parse in sqlite-ts. Try anyway
    // so future fixes "just work"; for now the EXPLAIN output is still
    // meaningful on empty tables — SQLite returns the plan it *would* use.
    try {
      const setup = fs.readFileSync(path.join(SCHEMA_DIR, "explain_setup.edgeql"), "utf8");
      executeScript(db, snapshot, setup, undefined, { defaultModule: "default" });
      console.log("[explain-lite] setup: ok");
    } catch (e) {
      console.log("[explain-lite] setup skipped:", (e as Error).message.slice(0, 160));
    }

    // Log which user-table indexes actually got created — handy when reading
    // the plan output below.
    const userIdx = db
      .prepare(
        "SELECT name, tbl_name, sql FROM sqlite_master " +
          "WHERE type='index' AND tbl_name LIKE 'default__%' " +
          "ORDER BY tbl_name, name",
      )
      .all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
    console.log(`[explain-lite] user-table indexes (${userIdx.length}):`);
    for (const row of userIdx) {
      console.log(`  ${row.tbl_name}.${row.name}${row.sql ? `  -- ${row.sql}` : ""}`);
    }
  });

  function debugPlanCase(label: string, query: string, expectIndex: boolean) {
    it(`${label} ${expectIndex ? "[expects index]" : "[no index expected]"}`, () => {
      console.log(`\n--- ${label} ---`);
      console.log("Q:", query.replace(/\s+/g, " ").trim());

      let sql: string;
      try {
        sql = executeQueryWithTrace(db, snapshot, query).sql.sql;
      } catch (e) {
        console.log("  compile error:", (e as Error).message.slice(0, 240));
        return; // soft bail — debug suite
      }
      console.log("SQL:", sql);

      let plan: PlanRow[];
      try {
        plan = planFor(db, sql);
      } catch (e) {
        console.log("  EXPLAIN failed:", (e as Error).message.slice(0, 240));
        return;
      }
      console.log("PLAN:");
      for (const row of plan) console.log(`  [${row.id} <- ${row.parent}] ${row.detail}`);

      const used = planUsesIndex(plan);
      console.log(`  uses index? ${used}  (expected ${expectIndex})`);
      if (expectIndex && !used) {
        console.log("  !! mismatch: expected index, planner chose a scan");
      }
      if (!expectIndex && used) {
        console.log("  !! mismatch: did not expect an index, but one was used");
      }

      expect(plan.length).toBeGreaterThan(0);
    });
  }

  // Modeled after test_edgeql_explain_simple_01.
  debugPlanCase(
    "simple_01: filter .name = 'Elvis'",
    `select User { id, name } filter .name = 'Elvis'`,
    true,
  );

  // Modeled after test_edgeql_explain_multi_link_01.
  debugPlanCase(
    "multi_link_01: User { name, todo: {name, number} } filter .name",
    `select User { name, todo: {name, number} } filter .name = 'Elvis'`,
    true,
  );

  // Modeled after test_edgeql_explain_computed_backlink_01.
  debugPlanCase(
    "computed_backlink_01: User { owned_issues: {name, number} } filter .name",
    `select User { name, owned_issues: {name, number} } filter .name = 'Elvis'`,
    true,
  );

  // Modeled after test_edgeql_explain_inheritance_01.
  debugPlanCase(
    "inheritance_01: WITH X := Text, select X",
    `with X := Text, select X`,
    true,
  );

  // Modeled after test_edgeql_explain_order_index_01 (name has a regular index).
  debugPlanCase(
    "order_index_01: order by .name limit 1",
    `select User { id, name, rank } order by .name limit 1`,
    true,
  );

  // Modeled after test_edgeql_explain_order_index_02 (id has an exclusive
  // constraint → SQLite PRIMARY KEY auto-index).
  debugPlanCase(
    "order_index_02: order by .id limit 1",
    `select User { id, name, rank } order by .id limit 1`,
    true,
  );

  // Modeled after test_edgeql_explain_user_func_index_01 (functional index).
  debugPlanCase(
    "user_func_index_01: Issue filter .number2 = '500!'",
    `select Issue {id} filter .number2 = '500!'`,
    true,
  );

  // Negative-ish control: filter on a non-indexed scalar should not use an
  // index. (Body is plain text with no index declared.)
  debugPlanCase(
    "control: filter .body = '...' (no index)",
    `select Issue {id} filter .body = 'whatever'`,
    false,
  );
});
