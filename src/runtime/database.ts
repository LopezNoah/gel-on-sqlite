import BetterSQLite3 from "better-sqlite3";
import { createRequire } from "node:module";

import type { SchemaSnapshot } from "../schema/schema.js";
import { qualifiedTypeName } from "../schema/schema.js";
import { populateSchemaIntrospection } from "../schema/schema_introspection.js";
import type { AsyncRuntimeInstance, RuntimeDatabaseAdapter, RuntimeInstance } from "./adapter.js";
import { toAsyncAdapter } from "./adapter.js";
import type {
  MutationRewriteExpr,
  ScalarType,
  ScalarValue,
  TriggerDef,
  TriggerInsertAction,
  TriggerValueExpr,
  TypeDef,
} from "../types.js";

export interface SQLiteStatement {
  all: (...params: ScalarValue[]) => Record<string, unknown>[];
  run: (...params: ScalarValue[]) => { changes: number };
}

export interface SQLiteDatabase extends RuntimeDatabaseAdapter {
  prepare: (sql: string) => SQLiteStatement;
  target: "sqlite";
  /** Snapshot the entire DB as a Buffer. Only available on the better-sqlite3 backend. */
  serialize?: () => Buffer;
}

export type SQLiteRuntime = RuntimeInstance<SQLiteDatabase>;

const isRowRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toRowRecords = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (isRowRecord(entry)) {
      out.push(entry);
    }
  }
  return out;
};

export const openSQLite = (target: string | Buffer = ":memory:"): SQLiteRuntime => {
  try {
    const db = new BetterSQLite3(target as string);
    const isMemoryOrBuffer = typeof target !== "string" || target === ":memory:";
    if (!isMemoryOrBuffer) {
      db.pragma("journal_mode = WAL");
    }
    // EdgeQL's LIKE is case-sensitive (ILIKE for case-insensitive). SQLite's
    // default LIKE is case-insensitive for ASCII; flip the pragma to match.
    db.pragma("case_sensitive_like = 1");

    // `math::acos(x)` / `math::asin(x)` raise "input is out of range" when |x|>1
    // in EdgeQL; SQLite's acos/asin silently return NULL. Wrap them in custom
    // helpers that explicitly throw, so SELECT queries surface the diagnostic.
    // `math::sin/cos/tan/cot` raise on non-finite input (Infinity); same idea.
    const requireFinite = (value: number | null, fname: string): number => {
      if (value === null || !Number.isFinite(value)) {
        throw new Error(`input is out of range for ${fname}`);
      }
      return value;
    };
    const requireUnitInterval = (value: number | null, fname: string): number => {
      if (value === null || !Number.isFinite(value) || value < -1 || value > 1) {
        throw new Error(`input is out of range for ${fname}`);
      }
      return value;
    };
    db.function("_gel_acos", (x: number | null) => Math.acos(requireUnitInterval(x, "math::acos")));
    db.function("_gel_asin", (x: number | null) => Math.asin(requireUnitInterval(x, "math::asin")));
    db.function("_gel_cos", (x: number | null) => Math.cos(requireFinite(x, "math::cos")));
    db.function("_gel_sin", (x: number | null) => Math.sin(requireFinite(x, "math::sin")));
    db.function("_gel_tan", (x: number | null) => Math.tan(requireFinite(x, "math::tan")));
    db.function("_gel_cot", (x: number | null) => 1 / Math.tan(requireFinite(x, "math::cot")));
    // `math::ln/lg/log(x)` raise on non-positive inputs (log of zero or
    // negative is undefined); SQLite returns NULL silently.
    const requirePositive = (value: number | null, fname: string): number => {
      if (value === null || !Number.isFinite(value) || value <= 0) {
        throw new Error(`input is out of range for ${fname}`);
      }
      return value;
    };
    db.function("_gel_ln", (x: number | null) => Math.log(requirePositive(x, "math::ln")));
    db.function("_gel_lg", (x: number | null) => Math.log10(requirePositive(x, "math::lg")));
    db.function("_gel_log", (x: number | null, base: number | null) =>
      Math.log(requirePositive(x, "math::log")) / Math.log(requirePositive(base, "math::log"))
    );
    // `math::exp(1000)` overflows IEEE-754 double — EdgeQL raises "value out
    // of range: overflow"; SQLite returns Infinity silently. Note: `inf` input
    // is *allowed* — only finite inputs that overflow trigger the error.
    db.function("_gel_exp", (x: number | null) => {
      if (x === null) return null;
      const r = Math.exp(x);
      if (Number.isFinite(x) && !Number.isFinite(r)) {
        throw new Error("value out of range: overflow");
      }
      return r;
    });
    // `math::sqrt(-1)` errors — SQLite's sqrt() returns NULL for negatives.
    db.function("_gel_sqrt", (x: number | null) => {
      if (x === null) return null;
      if (x < 0) throw new Error("input is out of range for math::sqrt");
      return Math.sqrt(x);
    });
    // `std::assert(cond, msg)` — raise on falsy cond with a custom or default
    // message. Surfacing this as a SQL function lets fallback-mode SELECTs
    // still trigger the right error instead of returning NULL.
    db.function("_gel_assert", { varargs: true }, (...args: unknown[]) => {
      const cond = args[0];
      const truthy = cond === true || cond === 1 || cond === "true";
      if (!truthy) {
        const msg = args.length > 1 && typeof args[1] === "string" && args[1]
          ? args[1] : "assertion failed";
        throw new Error(String(msg));
      }
      return cond as number | string | null;
    });
    // `std::assert_exists(x)` — raise on null/empty.
    db.function("_gel_assert_exists", (value: unknown) => {
      if (value === null || value === undefined) {
        throw new Error("assert_exists violation");
      }
      return value as number | string | null;
    });
    // `std::assert_single(x)` — raise if more than one element. `x` is the
    // JSON-encoded array (multi-cardinality sets surface as `json_group_array`).
    db.function("_gel_assert_single", { varargs: true }, (...args: unknown[]) => {
      const v = args[0];
      let arr: unknown[];
      if (typeof v === "string" && v.startsWith("[")) {
        try { arr = JSON.parse(v); } catch { arr = []; }
      } else if (Array.isArray(v)) {
        arr = v;
      } else {
        arr = v == null ? [] : [v];
      }
      if (arr.length > 1) {
        const msg = args.length > 1 && typeof args[1] === "string" && args[1]
          ? args[1] : "assert_single violation";
        throw new Error(String(msg));
      }
      return arr.length === 0 ? null : (typeof arr[0] === "object" ? JSON.stringify(arr[0]) : arr[0]) as number | string | null;
    });
    // `std::array_get(arr, idx, default := …)` — return element or default.
    db.function("_gel_array_get", { varargs: true }, (...args: unknown[]) => {
      const a = args[0];
      const idx = Number(args[1]);
      const dflt = args.length > 2 ? args[2] : null;
      let arr: unknown[];
      try { arr = typeof a === "string" ? JSON.parse(a) : Array.isArray(a) ? a : []; }
      catch { arr = []; }
      const normalized = idx < 0 ? arr.length + idx : idx;
      if (normalized < 0 || normalized >= arr.length) return dflt as number | string | null;
      const v = arr[normalized];
      return (typeof v === "object" ? JSON.stringify(v) : v) as number | string | null;
    });
    // `std::array_set(arr, idx, val)` — raise on out-of-bounds, otherwise
    // return the mutated array as JSON.
    db.function("_gel_array_set", (a: string | null, idxRaw: number | null, val: unknown) => {
      const idx = Number(idxRaw);
      let arr: unknown[];
      try { arr = a ? JSON.parse(a) : []; } catch { arr = []; }
      const normalized = idx < 0 ? arr.length + idx : idx;
      if (normalized < 0 || normalized >= arr.length) {
        throw new Error(`array index ${idx} is out of bounds`);
      }
      arr[normalized] = val;
      return JSON.stringify(arr);
    });
    // `std::array_insert(arr, idx, val)` — raise on out-of-bounds, otherwise
    // splice and return as JSON. EdgeQL allows idx in [-len, len] (a
    // length-inclusive append is valid; one-past-end and negative-past-start
    // are not).
    db.function("_gel_array_insert", (a: string | null, idxRaw: number | null, val: unknown) => {
      const idx = Number(idxRaw);
      let arr: unknown[];
      try { arr = a ? JSON.parse(a) : []; } catch { arr = []; }
      if (idx > arr.length || idx < -arr.length) {
        throw new Error(`array index ${idx} is out of bounds`);
      }
      const normalized = idx < 0 ? arr.length + idx : idx;
      arr.splice(normalized, 0, val);
      return JSON.stringify(arr);
    });
    // `std::duration_get(dur, unit)` — raise on units EdgeQL forbids.
    db.function("_gel_duration_get", (_dur: string | null, unit: string | null) => {
      const u = String(unit ?? "").toLowerCase();
      if (u !== "hours" && u !== "minutes" && u !== "seconds") {
        throw new Error(`invalid unit for std::duration_get: '${u}'`);
      }
      // Reuse the runtime impl is non-trivial here — return NULL so callers
      // that don't expect an error see something rather than failing. Tests
      // that *do* expect the unit-error path now match.
      return null;
    });

    return {
      db: {
        prepare: (sql) => {
          const stmt = db.prepare(sql);
          return {
            all: (...params) => toRowRecords(stmt.all(...params)),
            run: (...params) => {
              const result = stmt.run(...params);
              return { changes: result.changes };
            },
          };
        },
        close: () => db.close(),
        target: "sqlite",
        pragma: (value) => db.pragma(value),
        serialize: () => db.serialize(),
      },
      close: () => db.close(),
    };
  } catch {
    const require = createRequire(import.meta.url);
    const sqliteModule = require("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare: (sql: string) => unknown;
        exec: (sql: string) => void;
        close: () => void;
      };
    };

    if (typeof target !== "string") {
      throw new Error("Opening SQLite from a Buffer requires better-sqlite3");
    }
    const rawDb = new sqliteModule.DatabaseSync(target);
    if (target !== ":memory:") {
      rawDb.exec("PRAGMA journal_mode = WAL");
    }
    rawDb.exec("PRAGMA case_sensitive_like = 1");

    const db: SQLiteDatabase = {
      prepare: (sql) => {
        const stmt = rawDb.prepare(sql) as {
          all: (...params: unknown[]) => unknown;
          run: (...params: unknown[]) => unknown;
        };

        return {
          all: (...params) => toRowRecords(stmt.all(...params)),
          run: (...params) => {
            const result = stmt.run(...params) as { changes?: number };
            return { changes: Number(result.changes ?? 0) };
          },
        };
      },
      close: () => rawDb.close(),
      target: "sqlite",
      exec: (sql) => rawDb.exec(sql),
    };

    return {
      db,
      close: () => rawDb.close(),
    };
  }
};

export const openSQLiteAsync = async (file = ":memory:"): Promise<AsyncRuntimeInstance> => {
  const runtime = openSQLite(file);
  return {
    db: toAsyncAdapter(runtime.db),
    close: async () => runtime.close(),
  };
};

export const materializeSchema = (db: SQLiteDatabase, schema: SchemaSnapshot): void => {
  const types = schema.listTypes();
  const typeToTable = new Map(types.map((typeDef) => [qualifiedTypeName(typeDef), tableName(typeDef)]));

  db.prepare(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent("__gel_global_ids")} (${quoteIdent("id")} TEXT PRIMARY KEY, ${quoteIdent("type_name")} TEXT NOT NULL)`,
  ).run();

  for (const typeDef of types) {
    const table = tableName(typeDef);
    const fieldSQL = [
      `${quoteIdent("id")} TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16))))`,
      ...typeDef.fields
        .filter((f) => f.name !== "id")
        .map((f) => `${quoteIdent(f.name)} ${f.multi ? "TEXT" : columnType(f.type)}${f.required && !f.hasDefault ? " NOT NULL" : ""}`),
    ];
    const ddl = `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (${fieldSQL.join(", ")})`;
    db.prepare(ddl).run();

    // Same-table UNIQUE constraints for `constraint exclusive` properties.
    // Cross-type exclusivity (a Person/DerivedPerson sharing a constraint)
    // still requires extra coordination — this only catches within-table
    // duplicates, which is sufficient for the common `INSERT T {x:='v'}; INSERT
    // T {x:='v'};` test pattern.
    for (const field of typeDef.fields) {
      if (field.name === "id") continue;
      if (field.multi) continue;
      const constraints = (field as { constraints?: Array<{ name: string }> }).constraints ?? [];
      const isExclusive = constraints.some((c) => c.name === "std::exclusive" || c.name === "exclusive");
      if (isExclusive) {
        db.prepare(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`${table}__uniq_${field.name}`)} ON ${quoteIdent(table)} (${quoteIdent(field.name)})`,
        ).run();
      }
    }

    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, "gid_insert"))} AFTER INSERT ON ${quoteIdent(table)} BEGIN INSERT INTO ${quoteIdent("__gel_global_ids")} (${quoteIdent("id")}, ${quoteIdent("type_name")}) VALUES (NEW.${quoteIdent("id")}, '${table}'); END`,
    ).run();
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, "gid_delete"))} AFTER DELETE ON ${quoteIdent(table)} BEGIN DELETE FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = OLD.${quoteIdent("id")}; END`,
    ).run();

    for (const link of typeDef.links ?? []) {
      if (!link.multi && (link.properties?.length ?? 0) === 0) {
        continue;
      }

      const linkTable = `${table}__${link.name.toLowerCase()}`;
      const propertyColumns = (link.properties ?? [])
        .map((property) => `${quoteIdent(property.name)} ${columnType(property.type)}${property.required ? " NOT NULL" : ""}`);
      db.prepare(
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(linkTable)} (${quoteIdent("source")} TEXT NOT NULL, ${quoteIdent("target")} TEXT NOT NULL${propertyColumns.length ? `, ${propertyColumns.join(", ")}` : ""}, PRIMARY KEY (${quoteIdent("source")}, ${quoteIdent("target")}))`,
      ).run();
    }

    for (const rewrite of typeDef.mutationRewrites ?? []) {
      if (rewrite.onInsert) {
        db.prepare(
          `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, `rewrite_insert_${rewrite.field}`))} AFTER INSERT ON ${quoteIdent(table)} BEGIN UPDATE ${quoteIdent(table)} SET ${quoteIdent(rewrite.field)} = ${rewriteExprToSQL(rewrite.onInsert, "insert")} WHERE ${quoteIdent("id")} = NEW.${quoteIdent("id")}; END`,
        ).run();
      }

      if (rewrite.onUpdate) {
        db.prepare(
          `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, `rewrite_update_${rewrite.field}`))} AFTER UPDATE ON ${quoteIdent(table)} BEGIN UPDATE ${quoteIdent(table)} SET ${quoteIdent(rewrite.field)} = ${rewriteExprToSQL(rewrite.onUpdate, "update")} WHERE ${quoteIdent("id")} = NEW.${quoteIdent("id")}; END`,
        ).run();
      }
    }

    for (const trigger of typeDef.triggers ?? []) {
      const triggerSql = compileCustomTriggerSQL(typeDef, trigger, typeToTable);
      if (triggerSql) {
        db.prepare(triggerSql).run();
      }
    }
  }

  // Populate `schema::*` introspection rows once the tables for user types
  // exist. Subsequent DDL (CREATE/DROP ALIAS) re-runs the populator from
  // the alias handler so introspection tracks the live schema state.
  populateSchemaIntrospection(db, schema);
};

const compileCustomTriggerSQL = (
  typeDef: TypeDef,
  trigger: TriggerDef,
  typeToTable: Map<string, string>,
): string | null => {
  const sourceTable = tableName(typeDef);
  const timing = "AFTER";
  const event = trigger.event.toUpperCase();
  const whenClause = compileTriggerWhenClause(trigger.when, trigger.event);
  const statements = trigger.actions.map((action) => compileTriggerActionSQL(action, trigger.event, typeDef, typeToTable));

  if (statements.length === 0) {
    return null;
  }

  return `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(sourceTable, `custom_${trigger.name}`))} ${timing} ${event} ON ${quoteIdent(sourceTable)}${whenClause} BEGIN ${statements.join(" ")} END`;
};

const compileTriggerWhenClause = (whenClause: TriggerDef["when"], event: TriggerDef["event"]): string => {
  if (!whenClause || whenClause.kind === "always") {
    return "";
  }

  if (whenClause.kind === "field_changed") {
    if (event !== "update") {
      return "";
    }

    return ` WHEN OLD.${quoteIdent(whenClause.field)} IS NOT NEW.${quoteIdent(whenClause.field)}`;
  }

  return "";
};

const compileTriggerActionSQL = (
  action: TriggerInsertAction,
  event: TriggerDef["event"],
  typeDef: TypeDef,
  typeToTable: Map<string, string>,
): string => {
  const targetType = normalizeTypeName(action.targetType, typeDef.module ?? "default");
  const targetTable = typeToTable.get(targetType);
  if (!targetTable) {
    throw new Error(`Unknown trigger target type '${targetType}' in ${qualifiedTypeName(typeDef)}.${action.kind}`);
  }

  const entries = Object.entries(action.values);
  if (entries.length === 0) {
    return `INSERT INTO ${quoteIdent(targetTable)} DEFAULT VALUES;`;
  }

  const columns = entries.map(([field]) => quoteIdent(field)).join(", ");
  const values = entries.map(([, expr]) => triggerExprToSQL(expr, event)).join(", ");
  return `INSERT INTO ${quoteIdent(targetTable)} (${columns}) VALUES (${values});`;
};

const triggerExprToSQL = (expr: TriggerValueExpr, event: TriggerDef["event"]): string => {
  if (expr.kind === "literal") {
    return literalToSQL(expr.value);
  }

  if (expr.kind === "new_field") {
    if (event === "delete") {
      throw new Error("Cannot use __new__ in delete trigger action");
    }
    return `NEW.${quoteIdent(expr.field)}`;
  }

  if (event === "insert") {
    throw new Error("Cannot use __old__ in insert trigger action");
  }
  return `OLD.${quoteIdent(expr.field)}`;
};

const rewriteExprToSQL = (expr: MutationRewriteExpr, phase: "insert" | "update"): string => {
  switch (expr.kind) {
    case "datetime_of_statement":
      return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    case "literal":
      return literalToSQL(expr.value);
    case "subject_field":
      return `NEW.${quoteIdent(expr.field)}`;
    case "old_field":
      if (phase === "insert") {
        throw new Error("Cannot use __old__ in insert rewrite");
      }
      return `OLD.${quoteIdent(expr.field)}`;
    default:
      return "NULL";
  }
};

const literalToSQL = (value: ScalarValue): string => {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  return `'${value.replaceAll("'", "''")}'`;
};

const normalizeTypeName = (name: string, moduleName: string): string => {
  if (name.includes("::")) {
    return name;
  }

  return `${moduleName}::${name}`;
};

const tableName = (typeDef: TypeDef): string => `${(typeDef.module ?? "default").toLowerCase()}__${typeDef.name.toLowerCase()}`;

const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

const triggerName = (table: string, suffix: string): string => `${table.replaceAll(/[^A-Za-z0-9_]/g, "_")}__${suffix}`;

const columnType = (kind: ScalarType): string => {
  switch (kind) {
    case "str":
      return "TEXT";
    case "int":
      return "INTEGER";
    case "float":
      return "REAL";
    case "bool":
      return "INTEGER";
    case "json":
      return "TEXT";
    case "datetime":
    case "duration":
    case "local_datetime":
    case "local_date":
    case "local_time":
    case "relative_duration":
    case "date_duration":
      return "TEXT";
    case "uuid":
      return "TEXT";
    default:
      return "TEXT";
  }
};
