/**
 * codegen/sql.ts
 *
 * Consumes a SchemaSnapshot (list of TypeDef) and produces executable
 * SQLite DDL that mirrors the patterns from migrations.ts buildCreateTypeSteps.
 *
 * Generates:
 *   - __gel_global_ids table
 *   - Main object tables with inline columns (id, scalar fields, singleton link _id columns)
 *   - Multi-property tables (source TEXT, target TYPE)
 *   - Link junction tables (source TEXT, target TEXT, ...property columns)
 *   - Global-ID INSERT/DELETE triggers on every object table
 *   - Mutation-rewrite triggers (onInsert / onUpdate)
 *   - Custom triggers
 *   - Indexes
 *
 * Naming conventions match runtime/engine.ts exactly:
 *   - tableNameForType(qn)  → qn.replaceAll("::","__").toLowerCase()
 *   - inline link column     → {link}_id
 *   - link junction table    → {parent_table}__{link_name}
 *   - multi-property table   → {parent_table}__{field_name}
 */

import type {
  FieldDef,
  LinkDef,
  MutationRewriteExpr,
  ScalarValue,
  TriggerDef,
  TriggerInsertAction,
  TriggerValueExpr,
} from "../types.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { scalarToSqlType } from "../schema/scalar.js";
import { qualifiedTypeName, usesLinkTable } from "../schema/schema.js";

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

export const tableNameForType = (qualifiedName: string): string =>
  qualifiedName.replaceAll("::", "__").toLowerCase();

export const quoteIdent = (ident: string): string =>
  `"${ident.replaceAll('"', '""')}"`;

export const quoteLiteral = (value: ScalarValue): string => {
  if (value === null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
};

// LEGITIMATE REGEX (do not remove): sanitizes an arbitrary table name into a
// safe SQL identifier for a generated trigger name. This is output-side
// identifier construction, not parsing structure out of a string.
const triggerName = (table: string, suffix: string): string =>
  `${table.replaceAll(/[^A-Za-z0-9_]/g, "_")}__${suffix}`;

// ---------------------------------------------------------------------------
// Inheritance-aware field/link/computed collection
// (inheritance-aware collection over a SchemaSnapshot)
// ---------------------------------------------------------------------------

const dedupeByName = <T extends { name: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
};

export const collectFields = (
  typeName: string,
  schema: SchemaSnapshot,
  includeInherited: boolean,
  seen = new Set<string>(),
): FieldDef[] => {
  if (seen.has(typeName)) return [];
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) return [];

  const inherited = includeInherited
    ? (typeDef.extends ?? []).flatMap((baseName) =>
        collectFields(baseName, schema, true, seen),
      )
    : [];

  return dedupeByName([...typeDef.fields, ...inherited]);
};

export const collectLinks = (
  typeName: string,
  schema: SchemaSnapshot,
  includeInherited: boolean,
  seen = new Set<string>(),
): LinkDef[] => {
  if (seen.has(typeName)) return [];
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) return [];

  const inherited = includeInherited
    ? (typeDef.extends ?? []).flatMap((baseName) =>
        collectLinks(baseName, schema, true, seen),
      )
    : [];

  return dedupeByName([...(typeDef.links ?? []), ...inherited]);
};

// ---------------------------------------------------------------------------
// Storage strategy helpers
// ---------------------------------------------------------------------------

/** Whether a link is stored in a separate junction table vs. inline column.
 *  Re-exported from the schema core — the rule's single home (see schema.ts). */
export { usesLinkTable } from "../schema/schema.js";

/** The inline column name for a singleton link (e.g. "owner_id"). */
export const inlineColumnName = (link: LinkDef): string => `${link.name}_id`;

/** The junction-table name for a multi-link. */
export const linkTableName = (parentQualifiedName: string, link: LinkDef): string =>
  `${tableNameForType(parentQualifiedName)}__${link.name.toLowerCase()}`;

/** The multi-value property table name. */
export const multiPropertyTableName = (
  parentQualifiedName: string,
  field: FieldDef,
): string =>
  `${tableNameForType(parentQualifiedName)}__${field.name.toLowerCase()}`;

// ---------------------------------------------------------------------------
// SQL expression / trigger helpers (mirroring migrations.ts)
// ---------------------------------------------------------------------------

export const rewriteExprToSQL = (
  expr: MutationRewriteExpr,
  phase: "insert" | "update",
): string => {
  switch (expr.kind) {
    case "datetime_of_statement":
      return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    case "literal":
      return quoteLiteral(expr.value);
    case "subject_field":
      return `NEW.${quoteIdent(expr.field)}`;
    case "old_field":
      if (phase === "insert")
        throw new Error("Cannot reference __old__ in insert rewrite");
      return `OLD.${quoteIdent(expr.field)}`;
    default:
      return "NULL";
  }
};

export const triggerExprToSQL = (
  expr: TriggerValueExpr,
  event: TriggerDef["event"],
): string => {
  if (expr.kind === "literal") return quoteLiteral(expr.value);
  if (expr.kind === "new_field") {
    if (event === "delete")
      throw new Error("Cannot reference __new__ in delete trigger");
    return `NEW.${quoteIdent(expr.field)}`;
  }
  if (event === "insert")
    throw new Error("Cannot reference __old__ in insert trigger");
  return `OLD.${quoteIdent(expr.field)}`;
};

export const compileTriggerWhenClause = (
  when: TriggerDef["when"] | undefined,
  event: TriggerDef["event"],
): string => {
  if (!when || when.kind === "always") return "";
  if (when.kind === "field_changed" && event === "update")
    return ` WHEN OLD.${quoteIdent(when.field)} IS NOT NEW.${quoteIdent(when.field)}`;
  return "";
};

export const compileTriggerActionSQL = (
  sourceQualifiedName: string,
  action: TriggerInsertAction,
  event: TriggerDef["event"],
): string => {
  const targetTypeName = action.targetType.includes("::")
    ? action.targetType
    : `default::${action.targetType}`;

  const entries = Object.entries(action.values);
  if (entries.length === 0) {
    return `INSERT INTO ${quoteIdent(tableNameForType(targetTypeName))} DEFAULT VALUES;`;
  }

  const columns = entries.map(([field]) => quoteIdent(field)).join(", ");
  const values = entries.map(([, expr]) => triggerExprToSQL(expr, event)).join(", ");
  return `INSERT INTO ${quoteIdent(tableNameForType(targetTypeName))} (${columns}) VALUES (${values});`;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate the full DDL SQL string for the given SchemaSnapshot.
 *
 * The output is a sequence of CREATE statements (separated by semicolons and
 * newlines) that mirrors what `buildCreateTypeSteps` in migrations.ts produces.
 */
export const renderSchemaSQL = (schema: SchemaSnapshot): string => {
  const lines: string[] = [];
  const types = schema.listTypes();
  const concreteTypes = types.filter((t) => !t.abstract);

  // 1. Global ID registry table
  lines.push(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent("__gel_global_ids")} (${quoteIdent("id")} TEXT PRIMARY KEY, ${quoteIdent("type_name")} TEXT NOT NULL)`,
  );

  // 2. Object tables + triggers + auxiliary tables
  for (const typeDef of concreteTypes) {
    const qualifiedName = qualifiedTypeName(typeDef);
    const table = tableNameForType(qualifiedName);

    // Collect all fields and links (including inherited)
    const allFields = collectFields(qualifiedName, schema, true);
    const allLinks = collectLinks(qualifiedName, schema, true);

    // Build columns for main table
    const columns: string[] = [
      `${quoteIdent("id")} TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16))))`,
    ];

    for (const field of allFields) {
      if (field.multi) continue; // multi-property → separate table
      // Skip auto-generated inline link _id fields — we add those from links below
      if (field.name.endsWith("_id") && allLinks.some((l) => `${l.name}_id` === field.name)) continue;
      const sqlType = scalarToSqlType(field.type);
      let colDef = `${quoteIdent(field.name)} ${sqlType}`;
      if (field.required) colDef += " NOT NULL";
      if (field.hasDefault && field.defaultExpr?.kind === "literal") {
        colDef += ` DEFAULT ${quoteLiteral(field.defaultExpr.value)}`;
      }
      columns.push(colDef);
    }

    // Inline link columns (singleton links without properties)
    for (const link of allLinks) {
      if (usesLinkTable(link)) continue;
      const isPolymorphic = link.targetType.includes("|");
      // Look up the auto-generated _id field for required/hasDefault properties
      const idField = allFields.find((f) => f.name === `${link.name}_id`);
      let colDef = `${quoteIdent(inlineColumnName(link))} TEXT`;
      if (idField?.required) colDef += " NOT NULL";
      if (!isPolymorphic) {
        const targetQualified = link.targetType.includes("::")
          ? link.targetType
          : `default::${link.targetType}`;
        colDef += ` REFERENCES ${quoteIdent(tableNameForType(targetQualified))}(${quoteIdent("id")})`;
      }
      columns.push(colDef);
    }

    // CREATE main table
    lines.push(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (${columns.join(", ")})`,
    );

    // Exclusive-constraint indexes: any field tagged with `constraint exclusive`
    // becomes a UNIQUE index in SQLite. This makes EdgeQL's "violates
    // exclusivity constraint" error surface as a real SQLite UNIQUE failure
    // at INSERT/UPDATE time, rather than silently allowing duplicates.
    // (Cross-type exclusivity — Person + DerivedPerson sharing a constraint —
    // is *not* enforced here; that needs cross-table coordination.)
    for (const field of allFields) {
      if (field.multi) continue;
      if (field.name.endsWith("_id") && allLinks.some((l) => `${l.name}_id` === field.name)) continue;
      const fieldConstraints = (field as { constraints?: Array<{ name: string }> }).constraints ?? [];
      const isExclusive = fieldConstraints.some((c) =>
        c.name === "std::exclusive" || c.name === "exclusive"
      );
      if (isExclusive) {
        lines.push(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`${table}__uniq_${field.name}`)} ON ${quoteIdent(table)} (${quoteIdent(field.name)})`,
        );
      }
    }

    // Global ID insert trigger
    lines.push(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, "gid_insert"))} AFTER INSERT ON ${quoteIdent(table)} BEGIN INSERT INTO ${quoteIdent("__gel_global_ids")} (${quoteIdent("id")}, ${quoteIdent("type_name")}) VALUES (NEW.${quoteIdent("id")}, ${quoteLiteral(table)}); END`,
    );

    // Global ID delete trigger
    lines.push(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, "gid_delete"))} AFTER DELETE ON ${quoteIdent(table)} BEGIN DELETE FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = OLD.${quoteIdent("id")}; END`,
    );

    // Multi-value property tables
    for (const field of allFields) {
      if (!field.multi) continue;
      const mt = multiPropertyTableName(qualifiedName, field);
      const sqlType = scalarToSqlType(field.type);
      lines.push(
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(mt)} (${quoteIdent("source")} TEXT NOT NULL, ${quoteIdent("target")} ${sqlType} NOT NULL)`,
      );
    }

    // Link junction tables (multi links or links with properties)
    for (const link of allLinks) {
      if (!usesLinkTable(link)) continue;
      const lt = linkTableName(qualifiedName, link);
      const linkColumns = [
        `${quoteIdent("source")} TEXT NOT NULL`,
        `${quoteIdent("target")} TEXT NOT NULL`,
      ];
      if (link.properties) {
        for (const prop of link.properties) {
          const propSqlType = scalarToSqlType(prop.type);
          let colDef = `${quoteIdent(prop.name)} ${propSqlType}`;
          if (prop.required) colDef += " NOT NULL";
          linkColumns.push(colDef);
        }
      }
      linkColumns.push(`PRIMARY KEY (${quoteIdent("source")}, ${quoteIdent("target")})`);
      lines.push(
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(lt)} (${linkColumns.join(", ")})`,
      );
    }

    // Mutation-rewrite triggers
    const mutationRewrites = typeDef.mutationRewrites ?? [];
    for (const rewrite of mutationRewrites) {
      if (rewrite.onInsert) {
        lines.push(
          `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, `rewrite_insert_${rewrite.field}`))} AFTER INSERT ON ${quoteIdent(table)} BEGIN UPDATE ${quoteIdent(table)} SET ${quoteIdent(rewrite.field)} = ${rewriteExprToSQL(rewrite.onInsert, "insert")} WHERE ${quoteIdent("id")} = NEW.${quoteIdent("id")}; END`,
        );
      }
      if (rewrite.onUpdate) {
        lines.push(
          `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, `rewrite_update_${rewrite.field}`))} AFTER UPDATE ON ${quoteIdent(table)} BEGIN UPDATE ${quoteIdent(table)} SET ${quoteIdent(rewrite.field)} = ${rewriteExprToSQL(rewrite.onUpdate, "update")} WHERE ${quoteIdent("id")} = NEW.${quoteIdent("id")}; END`,
        );
      }
    }

    // Custom triggers
    const triggers = typeDef.triggers ?? [];
    for (const trigger of triggers) {
      const whenClause = compileTriggerWhenClause(trigger.when, trigger.event);
      const actions = trigger.actions
        .map((action) => compileTriggerActionSQL(qualifiedName, action, trigger.event))
        .join(" ");
      if (actions.length === 0) continue;
      lines.push(
        `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, `custom_${trigger.name}`))} AFTER ${trigger.event.toUpperCase()} ON ${quoteIdent(table)}${whenClause} BEGIN ${actions} END`,
      );
    }

    // Indexes
    const indexes = typeDef.indexes ?? [];
    for (const idx of indexes) {
      lines.push(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}__idx_${idx.expr.replaceAll(/[^A-Za-z0-9_]/g, "_")}`)} ON ${quoteIdent(table)} (${quoteIdent(idx.expr)})`,
      );
    }
  }

  return lines.join(";\n") + ";";
};

/**
 * Execute the generated DDL against a RuntimeDatabaseAdapter.
 * Splits statements on semicolons and runs each non-empty statement.
 */
export const applySchemaSQL = (
  db: { prepare: (sql: string) => { run: (...params: ScalarValue[]) => { changes: number } } },
  schema: SchemaSnapshot,
): void => {
  const sql = renderSchemaSQL(schema);
  // Split on semicolons followed by optional whitespace and newlines
  for (const stmt of sql.split(";\n")) {
    const trimmed = stmt.trim();
    if (trimmed.length === 0) continue;
    // Ensure the statement ends with a semicolon for execution
    const finalStmt = trimmed.endsWith(";") ? trimmed : trimmed + ";";
    db.prepare(finalStmt).run();
  }
};
