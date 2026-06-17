import { AppError } from "../errors.js";
import { quoteIdent } from "../codegen/sql.js";
import { PENDING_INSERT_SQL_EXPR_VALUE } from "../compiler/dml_lowering.js";
import type { ScalarValue } from "../types.js";

// Write-time DML SQL emission.
//
// UPDATE and DELETE compile to SQL ahead of time (the DML IR → `sqlArtifact.sql`
// via dml_lowering + the SQL compiler); the write executor just runs that
// string. INSERT can't: its final column set is known only at write time, once
// defaults, sequences, and inline-link targets have resolved. So the INSERT row
// SQL is emitted here — the one pure, write-time piece of DML SQL emission,
// lifted out of the 578-line `runWriteWithAccessPolicies` so it has a name and a
// test surface, separate from the procedural mutation mechanics (policies,
// UNLESS CONFLICT, sequences, link writes). See docs/adr/0046.

/** A column whose value the planner deferred to a compiled SQL expression
 * (function call, subquery, path into a WITH binding, …), carrying its own
 * parameter slice. Matches `GelIRSQLArtifact.insertColumns`. */
export interface InsertColumnSql {
  column: string;
  sql: string;
  params: ScalarValue[];
}

export interface BuiltDmlSql {
  sql: string;
  params: ScalarValue[];
}

/**
 * Emit the INSERT row SQL from the resolved column→value `entries`.
 *
 * `entries` must already be normalized by the caller (id-handling and the
 * pending inline-link / rewrite sentinels filtered out) — only
 * `PENDING_INSERT_SQL_EXPR_VALUE` is handled here, by splicing the matching
 * compiled expression from `insertColumns`. An empty `entries` list yields
 * `INSERT INTO <t> DEFAULT VALUES`. `pos` locates the error a missing compiled
 * column raises.
 */
export const buildInsertRowSql = (
  table: string,
  entries: Array<[string, ScalarValue]>,
  insertColumns: InsertColumnSql[],
  pos: { line: number; column: number },
): BuiltDmlSql => {
  // Assignments the plan deferred to SQL (function calls, subqueries,
  // paths into WITH bindings, …) splice in the gelIR artifact's compiled
  // column expression — each carries its own parameter slice.
  const sqlExprByColumn = new Map(insertColumns.map((entry) => [entry.column, entry]));

  if (entries.length === 0) {
    return { sql: `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`, params: [] };
  }

  const columns: string[] = [];
  const valueExprs: string[] = [];
  const params: ScalarValue[] = [];
  for (const [column, value] of entries) {
    if (value === PENDING_INSERT_SQL_EXPR_VALUE) {
      const compiled = sqlExprByColumn.get(column);
      if (!compiled) {
        throw new AppError(
          "E_UNSUPPORTED",
          `INSERT assignment for '${column}' requires SQL lowering; runtime fallback disabled`,
          pos.line,
          pos.column,
        );
      }
      columns.push(column);
      valueExprs.push(compiled.sql);
      params.push(...compiled.params);
      continue;
    }
    columns.push(column);
    valueExprs.push("?");
    params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  return {
    sql: `INSERT INTO ${quoteIdent(table)} (${columns.map((column) => quoteIdent(column)).join(", ")}) VALUES (${valueExprs.join(", ")})`,
    params,
  };
};
