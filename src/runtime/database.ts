import BetterSQLite3 from "better-sqlite3";
import { createRequire } from "node:module";

import type { SchemaSnapshot } from "../schema/schema.js";
import { qualifiedTypeName } from "../schema/schema.js";
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
}

export interface SQLiteRuntime extends RuntimeInstance<SQLiteDatabase> {}

export const openSQLite = (file = ":memory:"): SQLiteRuntime => {
  try {
    const db = new BetterSQLite3(file);
    db.pragma("journal_mode = WAL");

    return {
      db: {
        prepare: (sql) => {
          const stmt = db.prepare(sql);
          return {
            all: (...params) => stmt.all(...params) as Record<string, unknown>[],
            run: (...params) => {
              const result = stmt.run(...params);
              return { changes: result.changes };
            },
          };
        },
        close: () => db.close(),
        target: "sqlite",
        pragma: (value) => db.pragma(value),
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

    const rawDb = new sqliteModule.DatabaseSync(file);
    rawDb.exec("PRAGMA journal_mode = WAL");

    const db: SQLiteDatabase = {
      prepare: (sql) => {
        const stmt = rawDb.prepare(sql) as {
          all: (...params: unknown[]) => unknown;
          run: (...params: unknown[]) => unknown;
        };

        return {
          all: (...params) => stmt.all(...params) as Record<string, unknown>[],
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
        .map((f) => `${quoteIdent(f.name)} ${f.multi ? "TEXT" : columnType(f.type)}${f.required ? " NOT NULL" : ""}`),
    ];
    const ddl = `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (${fieldSQL.join(", ")})`;
    db.prepare(ddl).run();

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
