import { afterEach, describe, expect, it } from "vitest";

import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery, executeQueryWithTrace } from "../src/runtime/engine.js";
import { gelSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

describe("stdlib: math and datetime", () => {
  let runtime: SQLiteRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("evaluates core math functions", () => {
    const schema = schemaSnapshotFromDeclarative(gelSchema`module default {}`);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const rows = executeQuery(
      runtime.db,
      schema,
      "select { abs := math::abs(-1), ceil := math::ceil(1.1), floor := math::floor(-1.1), lnexp := math::exp(math::ln(100)), mean := math::mean({1, 3, 5}), stddev := math::stddev({1, 3, 5}), var := math::var({1, 3, 5}), pi := math::pi(), e := math::e(), sin0 := math::sin(0), cos0 := math::cos(0), tan0 := math::tan(0), cot45 := math::cot(0.7853981633974483) };",
    ).rows;

    const row = rows?.[0] ?? {};
    expect(row.abs).toBe(1);
    expect(row.ceil).toBe(2);
    expect(row.floor).toBe(-2);
    expect(Number(row.lnexp)).toBeCloseTo(100, 8);
    expect(row.mean).toBe(3);
    expect(Number(row.stddev)).toBeCloseTo(2, 8);
    expect(Number(row.var)).toBeCloseTo(4, 8);
    expect(Number(row.pi)).toBeCloseTo(Math.PI, 12);
    expect(Number(row.e)).toBeCloseTo(Math.E, 12);
    expect(Number(row.sin0)).toBeCloseTo(0, 12);
    expect(Number(row.cos0)).toBeCloseTo(1, 12);
    expect(Number(row.tan0)).toBeCloseTo(0, 12);
    expect(Number(row.cot45)).toBeCloseTo(1, 8);
  });

  it("evaluates datetime scalar helper functions", () => {
    const schema = schemaSnapshotFromDeclarative(gelSchema`module default {}`);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const rows = executeQuery(
      runtime.db,
      schema,
      "select { now := std::datetime_current(), stmt := std::datetime_of_statement(), tx := std::datetime_of_transaction(), normalized := std::to_datetime('2024-01-02T03:04:05Z'), year := std::datetime_get('2024-01-02T03:04:05Z', 'year'), month := std::datetime_get('2024-01-02T03:04:05Z', 'month'), day := std::datetime_get('2024-01-02T03:04:05Z', 'day'), truncated := std::datetime_truncate('day', '2024-01-02T03:04:05Z'), as_str := std::to_str('2024-01-02T03:04:05Z') };",
    ).rows;

    const row = rows?.[0] ?? {};
    expect(typeof row.now).toBe("string");
    expect(typeof row.stmt).toBe("string");
    expect(typeof row.tx).toBe("string");
    expect(row.normalized).toBe("2024-01-02T03:04:05.000Z");
    expect(row.year).toBe(2024);
    expect(row.month).toBe(1);
    expect(row.day).toBe(2);
    expect(row.truncated).toBe("2024-01-02T00:00:00.000Z");
    expect(row.as_str).toBe("2024-01-02T03:04:05Z");
  });

  it("evaluates local temporal and duration helpers", () => {
    const schema = schemaSnapshotFromDeclarative(gelSchema`module default {}`);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const rows = executeQuery(
      runtime.db,
      schema,
      "select { local_dt := cal::to_local_datetime('2024-02-03T04:05:06'), local_d := cal::to_local_date('2024-02-03'), local_t := cal::to_local_time('04:05:06'), dur := std::to_duration('PT49H125M9S'), date_year := cal::date_get('2024-02-03', 'year'), time_minute := cal::time_get('04:05:06', 'minute'), dur_hours := std::duration_get('PT49H125M9S', 'hours'), dur_trunc_hours := std::duration_truncate('hours', 'PT49H125M9S'), dur_norm_hours := cal::duration_normalize_hours('PT49H125M9S'), dur_norm_days := cal::duration_normalize_days('PT49H125M9S') };",
    ).rows;

    const row = rows?.[0] ?? {};
    expect(row.local_dt).toBe("2024-02-03T04:05:06");
    expect(row.local_d).toBe("2024-02-03");
    expect(row.local_t).toBe("04:05:06");
    expect(row.dur).toBe("PT49H125M9S");
    expect(row.date_year).toBe(2024);
    expect(row.time_minute).toBe(5);
    expect(row.dur_hours).toBe(49);
    expect(row.dur_trunc_hours).toBe("PT49H");
    expect(row.dur_norm_hours).toBe("PT51H5M9S");
    expect(row.dur_norm_days).toBe("P2DT1H125M9S");
  });

  it("lowers applicable stdlib function calls into SQL projections", () => {
    const schema = schemaSnapshotFromDeclarative(gelSchema`
      module default {
        type Metric {
          required value: float;
        }
      }
    `);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);
    executeQuery(runtime.db, schema, "insert default::Metric { value := -42.5 };");

    const trace = executeQueryWithTrace(
      runtime.db,
      schema,
      "select default::Metric { normalized := math::abs(.value), text_value := std::to_str(.value), now := std::datetime_current() };",
      { runtimeTarget: "d1" },
    );

    expect(trace.sql.loweringMode).toBe("single_statement");
    expect(trace.sql.sql.toLowerCase()).toContain("abs(");
    expect(trace.sql.sql.toLowerCase()).toContain("strftime('%y-%m-%d");
    expect(trace.sql.sql.toLowerCase()).toContain("cast(");
    expect(trace.result.rows?.[0]).toEqual({ normalized: 42.5, text_value: "-42.5", now: expect.any(String) });
  });

  it("keeps non-lowerable stdlib calls on runtime fallback", () => {
    const schema = schemaSnapshotFromDeclarative(gelSchema`
      module default {
        type Metric {
          required value: float;
        }
      }
    `);
    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);
    executeQuery(runtime.db, schema, "insert default::Metric { value := 1.0 };");

    const trace = executeQueryWithTrace(
      runtime.db,
      schema,
      "select default::Metric { avg := math::mean({1, 3, 5}) };",
      { runtimeTarget: "d1" },
    );

    expect(trace.sql.loweringMode).toBe("fallback_multi_query");
    expect(trace.result.rows?.[0]).toEqual({ avg: 3 });
  });
});
