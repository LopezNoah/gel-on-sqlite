// Exclusive-conflict detection — the `UNLESS CONFLICT` machinery, lifted out of
// the write executor `runWriteWithAccessPolicies` (continuing the carve of
// access_policy.ts / default_resolution.ts / dml_sql.ts — ADRs 0037/0039/0046).
//
// THE SHAPE (emitter-style, "plan + run"):
//   - `exclusiveChecksFor(schema, type, targetFields?)` enumerates the exclusive
//     constraints reachable from an INSERT's type — PURE given the schema.
//   - `planExclusiveConflictProbe(check, values)` is the PURE emitter: given the
//     storage values the INSERT is about to write, it decides what to probe (or
//     `null` when a covered value is empty, so no conflict is possible).
//   - `runExclusiveConflictProbe(db, plan)` is the thin DB step: it adaptively
//     reads `PRAGMA table_info` to gate on which tables/columns exist, then runs
//     the probe. (The introspection is why this can't be a pure SQL string —
//     ADR 0063.)
// The planner is the test surface every constraint kind crosses without a DB
// write; the runner replays it byte-identically to the old `findExclusiveConflictId`.
//
// OWNERSHIP: schema/exclusive_constraints.ts owns the shared schema facts;
// this module owns conflict planning/running and conflict-specific checks.
// `engine.ts`'s WITH-DML-chain snapshot imports `exclusiveChecksFor` plus the
// re-exported schema helpers — one-directional, with no engine cycle. Pinned by
// `tests/conflict_detection.test.ts`.

import type { SchemaSnapshot } from "../schema/schema.js";
import { qualifiedTypeName } from "../schema/schema.js";
import type { ScalarValue, TypeDef } from "../types.js";
import { quoteIdent, tableNameForType } from "../codegen/sql.js";
import type { SQLiteDatabase } from "./database.js";
import { exclusiveConstraintFactsForType } from "../schema/exclusive_constraints.js";

export { constraintIsExclusiveLike, typeAncestorsOf } from "../schema/exclusive_constraints.js";

// Parse a SQLite UNIQUE-failure message back to the violated EdgeQL property.
const SHARED_COL_RE = /__col__([A-Za-z0-9_]+?)(?:__excl__|\.|$)/;
const DIRECT_COL_RE = /UNIQUE constraint failed: [^.]+\.([A-Za-z0-9_]+)/;
export const parseExclusivityViolation = (
  message: string,
): { property: string; crossType: boolean } | undefined => {
  if (!message.includes("UNIQUE constraint failed")) return undefined;
  // Shared cross-type tables are named `__gel_excl__<owner>__col__<prop>`,
  // and their unique index appends `__excl__<prop>`. SQLite reports either the
  // `<table>.v` column (plain index) or the index name (expression index), so
  // recover the property as the segment after the last `__col__`, stopping at
  // `__excl__`, `.`, or end-of-string.
  const shared = SHARED_COL_RE.exec(message);
  if (shared) {
    return { property: shared[1], crossType: true };
  }
  const direct = DIRECT_COL_RE.exec(message);
  if (direct) {
    const col = direct[1];
    const property = col.endsWith("_id") ? col.slice(0, -3) : col;
    return { property, crossType: false };
  }
  return undefined;
};

// A single exclusive constraint reachable from an INSERT's type, normalized so
// the conflict checker can both decide whether the inserted values clash with
// an existing row and recover that row's id.
export interface ExclusiveCheck {
  // The own-type fields the constraint covers (`["name"]`, `["first","bff"]`).
  fields: string[];
  // Storage columns to compare in each participating table (link → `<l>_id`).
  columns: string[];
  // Case-insensitive (`exclusive on (str_lower(__subject__))`).
  lower: boolean;
  // For a multi property the values live in a `<table>__<prop>` link table.
  multiProp?: string;
  // Concrete tables the constraint spans (this type + any type sharing it via
  // inheritance), so a parent/child clash is detected (test _18a/_18b).
  tables: string[];
  // True when the constraint is owned by a *parent* type rather than declared
  // on the inserted type itself — UNLESS CONFLICT … ELSE is rejected then
  // (test _20a), and a bare/derived conflict is still suppressed (_18b).
  fromParent: boolean;
  // `exclusive … except (.flag)` — rows whose `<flag>` column is truthy are
  // exempt from the constraint (test except_constraint_02).
  exceptColumn?: string;
}

// Enumerate the exclusive constraints to test for an INSERT under UNLESS
// CONFLICT. `targetFields` restricts the set to those that exactly cover the
// `ON (...)` target; a bare UNLESS CONFLICT (undefined) tests every exclusive
// constraint reachable from the type.
export const exclusiveChecksFor = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  targetFields: string[] | undefined,
): ExclusiveCheck[] => {
  const checks: ExclusiveCheck[] = exclusiveConstraintFactsForType(schema, typeDef)
    .filter((fact) => !fact.fields.includes("id"))
    .map((fact) => ({
      fields: fact.fields,
      columns: fact.columns,
      lower: fact.lower,
      multiProp: fact.multiProp,
      tables: fact.typeNames.map(tableNameForType),
      fromParent: fact.fromParent,
      exceptColumn: fact.exceptField,
    }));

  // The implicit `id` PRIMARY KEY is exclusive on every type. It only matters
  // under `allow_user_specified_id` (otherwise ids are server-generated and
  // never clash) — included so `UNLESS CONFLICT ON (.id)` / bare UNLESS
  // CONFLICT can suppress an explicit-id duplicate (test explicit_id_05).
  checks.push({
    fields: ["id"],
    columns: ["id"],
    lower: false,
    tables: [tableNameForType(qualifiedTypeName(typeDef))],
    fromParent: false,
  });

  if (targetFields === undefined) return checks;
  const want = JSON.stringify([...targetFields].sort());
  return checks.filter((c) => JSON.stringify([...c.fields].sort()) === want);
};

// What an exclusive check would probe for the values an INSERT is about to
// write — the PURE emitter half of conflict detection. `null` means no probe is
// possible (a covered value is absent; exclusive constraints ignore empty sets).
export type ConflictProbePlan =
  | { kind: "single"; tables: string[]; columns: string[]; lower: boolean; values: ScalarValue[] }
  | { kind: "multi"; tables: string[]; multiProp: string; items: ScalarValue[] };

export const planExclusiveConflictProbe = (
  check: ExclusiveCheck,
  values: Record<string, ScalarValue | undefined>,
): ConflictProbePlan | null => {
  if (check.multiProp) {
    const raw = values[check.multiProp];
    const items: ScalarValue[] = Array.isArray(raw)
      ? (raw as ScalarValue[])
      : raw === undefined || raw === null
        ? []
        : [raw];
    if (items.length === 0) return null;
    return { kind: "multi", tables: check.tables, multiProp: check.multiProp, items };
  }
  const colValues = check.columns.map((col) => values[col]);
  if (colValues.some((v) => v === undefined || v === null)) return null;
  return {
    kind: "single",
    tables: check.tables,
    columns: check.columns,
    lower: check.lower,
    values: colValues as ScalarValue[],
  };
};

// The thin DB step: replay a probe plan, gating on which tables/columns exist
// (PRAGMA table_info), and return the id of an existing clashing row. Byte-for-
// byte the old `findExclusiveConflictId` probe.
export const runExclusiveConflictProbe = (
  db: SQLiteDatabase,
  plan: ConflictProbePlan,
): string | undefined => {
  if (plan.kind === "multi") {
    for (const tbl of plan.tables) {
      const linkTbl = `${tbl}__${plan.multiProp.toLowerCase()}`;
      const exists = db.prepare(`PRAGMA table_info(${quoteIdent(linkTbl)})`).all() as Array<{
        name: string;
      }>;
      if (exists.length === 0) continue;
      const valueCol = exists.some((c) => c.name === "value")
        ? "value"
        : exists.some((c) => c.name === "target")
          ? "target"
          : undefined;
      const srcCol = exists.some((c) => c.name === "source") ? "source" : "src";
      if (!valueCol) continue;
      const placeholders = plan.items.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT ${quoteIdent(srcCol)} AS ${quoteIdent("id")} FROM ${quoteIdent(linkTbl)} WHERE ${quoteIdent(valueCol)} IN (${placeholders}) LIMIT 1`,
        )
        .all(...plan.items)[0] as { id?: unknown } | undefined;
      if (typeof row?.id === "string") return row.id;
    }
    return undefined;
  }

  for (const tbl of plan.tables) {
    const cols = (
      db.prepare(`PRAGMA table_info(${quoteIdent(tbl)})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!plan.columns.every((c) => cols.includes(c))) continue;
    const wheres = plan.columns
      .map((col) =>
        plan.lower ? `lower(${quoteIdent(col)}) = lower(?)` : `${quoteIdent(col)} = ?`,
      )
      .join(" AND ");
    const row = db
      .prepare(
        `SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(tbl)} WHERE ${wheres} LIMIT 1`,
      )
      .all(...(plan.values as ScalarValue[]))[0] as { id?: unknown } | undefined;
    if (typeof row?.id === "string") return row.id;
  }
  return undefined;
};

// After a UNIQUE write failure under UNLESS CONFLICT, decide whether the clash
// is against a row inserted earlier in the *same* statement (which must surface
// as an error, not be suppressed). Scans every exclusive check covering the
// violated property and reports true when the only conflicting existing row was
// inserted this statement.
export const conflictIsAgainstSameStatementRow = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  subjectType: TypeDef,
  violatedProperty: string,
  statementInsertedIds: Set<string> | undefined,
): boolean => {
  if (!statementInsertedIds || statementInsertedIds.size === 0) return false;
  const checks = exclusiveChecksFor(schema, subjectType, undefined).filter((c) =>
    c.fields.includes(violatedProperty),
  );
  for (const check of checks) {
    for (const tbl of check.tables) {
      const cols = (
        db.prepare(`PRAGMA table_info(${quoteIdent(tbl)})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (check.multiProp) continue;
      if (!check.columns.every((c) => cols.includes(c))) continue;
      const rows = db
        .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(tbl)}`)
        .all() as Array<{ id?: unknown }>;
      for (const row of rows) {
        if (typeof row.id === "string" && statementInsertedIds.has(row.id)) return true;
      }
    }
  }
  return false;
};

// Recursively scan an INSERT value expression for volatile function calls
// (`random`, `datetime_current`, …) so UNLESS CONFLICT ON can reject a volatile
// conflict target (test _16b).
const VOLATILE_FUNCTION_NAMES = new Set([
  "random",
  "datetime_current",
  "datetime_of_transaction",
  "uuid_generate_v1mc",
  "uuid_generate_v4",
  "sequence_next",
]);
export const insertValueIsVolatile = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(insertValueIsVolatile);
  if (node === null || typeof node !== "object") return false;
  const n = node as Record<string, unknown> & {
    kind?: string;
    name?: unknown;
    call?: { name?: unknown };
  };
  const fnName =
    typeof n.name === "string"
      ? n.name
      : typeof n.call?.name === "string"
        ? n.call.name
        : undefined;
  if ((n.kind === "function_call" || n.kind === "func_call" || n.kind === "call") && fnName) {
    const short = fnName.includes("::") ? (fnName.split("::").pop() ?? fnName) : fnName;
    if (VOLATILE_FUNCTION_NAMES.has(short)) return true;
  }
  for (const value of Object.values(n)) {
    if (insertValueIsVolatile(value)) return true;
  }
  return false;
};
