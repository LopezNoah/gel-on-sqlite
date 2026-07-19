// Schema materialization + DDL generation, extracted from database.ts (ADR:
// D1/DO async work) so the query engine can import it WITHOUT pulling in the
// better-sqlite3 native driver. That lets the full synchronous engine bundle
// for workerd — e.g. running inside a Durable Object, whose SQL storage API is
// synchronous. This module is pure DDL/SQL string building over a
// prepare().run() surface; it touches no native module. database.ts re-exports
// materializeSchema for existing callers.

import { AppError } from "../errors.js";
import { normalizeTypeName, qualifiedTypeName, usesLinkTable } from "../schema/schema.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { populateSchemaIntrospection } from "../schema/schema_introspection.js";
import type {
  MutationRewriteExpr,
  ScalarType,
  ScalarValue,
  TriggerDef,
  TriggerInsertAction,
  TriggerValueExpr,
  TypeDef,
} from "../types.js";
import type { SQLiteDatabase } from "./database.js";

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

    // Same-table UNIQUE indexes for `constraint exclusive` properties. These
    // catch within-table duplicates directly (and keep the query planner's
    // ordering behaviour stable for indexed columns); cross-type/inherited
    // exclusivity is layered on top by materializeExclusivity below. The index
    // is skipped for constraints with an `on (<expr>)` or `except (...)`
    // clause, which the shared-table mechanism handles instead.
    for (const field of typeDef.fields) {
      if (field.name === "id" || field.multi) continue;
      const constraints = (field as { constraints?: Array<{ name: string; onExpr?: string; exceptExpr?: string }> }).constraints ?? [];
      const excl = constraints.find((c) => c.name === "std::exclusive" || c.name === "exclusive");
      if (excl && excl.onExpr === undefined && excl.exceptExpr === undefined) {
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
      if (!usesLinkTable(link)) {
        continue;
      }

      const linkTable = `${table}__${link.name.toLowerCase()}`;
      const propertyColumns = (link.properties ?? [])
        .map((property) => `${quoteIdent(property.name)} ${columnType(property.type)}${property.required ? " NOT NULL" : ""}`);
      db.prepare(
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(linkTable)} (${quoteIdent("source")} TEXT NOT NULL, ${quoteIdent("target")} TEXT NOT NULL${propertyColumns.length ? `, ${propertyColumns.join(", ")}` : ""}, PRIMARY KEY (${quoteIdent("source")}, ${quoteIdent("target")}))`,
      ).run();
      db.prepare(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${linkTable}__target_source`)} ON ${quoteIdent(linkTable)} (${quoteIdent("target")}, ${quoteIdent("source")})`,
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

  // Exclusivity enforcement (single-property `constraint exclusive`,
  // including cross-type/inherited constraints and `… except (.flag)`).
  // Done after every table exists so cross-type shared tables can be wired.
  materializeExclusivity(db, schema);

  // Populate `schema::*` introspection rows once the tables for user types
  // exist. Subsequent DDL (CREATE/DROP ALIAS) re-runs the populator from
  // the alias handler so introspection tracks the live schema state.
  populateSchemaIntrospection(db, schema);
};

// ── Exclusivity constraint enforcement ──────────────────────────────────────
//
// Gel exclusive constraints are enforced across an entire inheritance
// hierarchy: a `constraint exclusive` declared on a base type forbids
// duplicate values among the base AND every descendant type, even though each
// type lives in its own SQLite table. To enforce that purely in SQL we build,
// for each constraint "group" (the topmost type that owns the constraint +
// the property it covers), a shared bookkeeping table with a UNIQUE index and
// AFTER INSERT/UPDATE/DELETE triggers on every participating type's table that
// mirror the property value into the shared table. A duplicate then trips the
// shared UNIQUE index regardless of which concrete type wrote the row.
//
// The shared table's UNIQUE index name embeds the property name as
// `…__excl__<prop>` so the runtime can translate the SQLite "UNIQUE constraint
// failed" error into Gel's "<prop> violates exclusivity constraint" wording.

interface ExclusiveGroup {
  ownerKey: string; // qualified name of the topmost owner type
  field: string; // property name carrying the constraint
  tables: string[]; // participating type tables
  exceptField?: string; // `except (.flag)` — rows where flag is true are exempt
  lower?: boolean; // `on (str_lower(__subject__))` — index lower(value)
  multi?: boolean; // multi-property: column holds a JSON array; each element must be unique
}

const constraintIsExclusive = (c: { name?: string }): boolean =>
  c.name === "std::exclusive" || c.name === "exclusive";

const typeAncestors = (schema: SchemaSnapshot, typeDef: TypeDef): TypeDef[] => {
  const seen = new Set<string>();
  const out: TypeDef[] = [];
  const visit = (td: TypeDef): void => {
    for (const baseName of td.extends ?? []) {
      const base = schema.getType(baseName);
      if (!base) continue;
      const key = qualifiedTypeName(base);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(base);
      visit(base);
    }
  };
  visit(typeDef);
  return out;
};

const collectExclusiveGroups = (schema: SchemaSnapshot): ExclusiveGroup[] => {
  const types = schema.listTypes();
  const groups = new Map<string, ExclusiveGroup>();

  // Parse `except (.flag)` → the bare field name (we only support a single
  // own-field reference). Returns undefined when the form is unsupported.
  const exceptFieldFrom = (exceptExpr?: string): string | undefined => {
    if (!exceptExpr) return undefined;
    const m = /^\(?\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\)?$/.exec(exceptExpr);
    return m ? m[1] : undefined;
  };
  // `on (str_lower(__subject__))` → case-insensitive uniqueness on the column.
  const isLowerExpr = (onExpr?: string): boolean =>
    onExpr !== undefined && /str_lower\s*\(\s*__subject__\s*\)/.test(onExpr);

  const addParticipant = (
    keyOwner: TypeDef,
    field: string,
    member: TypeDef,
    opts: { exceptField?: string; lower?: boolean; multi?: boolean },
  ): void => {
    const key = `${qualifiedTypeName(keyOwner)}|${field}`;
    let group = groups.get(key);
    if (!group) {
      group = { ownerKey: key, field, tables: [], exceptField: opts.exceptField, lower: opts.lower, multi: opts.multi };
      groups.set(key, group);
    }
    const tbl = tableName(member);
    if (!group.tables.includes(tbl)) group.tables.push(tbl);
  };

  for (const typeDef of types) {
    if (typeDef.abstract) continue;

    // ── Field-level `constraint exclusive` (incl. `on (str_lower(...))`) ──
    for (const field of typeDef.fields) {
      if (field.name === "id") continue;
      const constraints = (field as { constraints?: Array<{ name: string; delegated?: boolean; onExpr?: string; exceptExpr?: string }> }).constraints ?? [];
      const excl = constraints.find(constraintIsExclusive);
      if (!excl) continue;
      // Delegated constraints are enforced per-type only — the same-table
      // UNIQUE index in materializeSchema already covers them, so no shared
      // cross-type bookkeeping is needed (and adding it would be incorrect).
      if (excl.delegated === true) continue;
      let owner = typeDef;
      for (const anc of typeAncestors(schema, typeDef)) {
        const ancField = anc.fields.find((f) => f.name === field.name) as { constraints?: Array<{ name: string }> } | undefined;
        if (ancField?.constraints?.some(constraintIsExclusive)) owner = anc;
      }
      addParticipant(owner, field.name, typeDef, {
        exceptField: exceptFieldFrom(excl.exceptExpr),
        lower: isLowerExpr(excl.onExpr),
        // A `multi property` with `constraint exclusive` requires every element
        // (across the whole type hierarchy) to be unique. The column stores a
        // JSON array, so the shared-table mirror must expand its elements.
        multi: field.multi === true,
      });
    }

    // ── Type-level single-field `constraint exclusive on (.field) [except …]` ──
    // (e.g. ExceptTest's `exclusive on (.name) except (.deleted)`). A type-level
    // constraint applies to the declaring type AND all of its descendants, so
    // we register every concrete type whose lineage carries the constraint.
    // Tuple constraints (fieldRefs.length > 1) are not handled here.
    const lineageTypeConstraint = (
      field: string,
    ): { exceptExpr?: string; exprText: string } | undefined => {
      const own = (typeDef.typeConstraints ?? []).find(
        (c) => constraintIsExclusive(c) && !c.delegated && c.fieldRefs.length === 1 && c.fieldRefs[0] === field,
      );
      if (own) return own;
      for (const anc of typeAncestors(schema, typeDef)) {
        const inherited = (anc.typeConstraints ?? []).find(
          (c) => constraintIsExclusive(c) && !c.delegated && c.fieldRefs.length === 1 && c.fieldRefs[0] === field,
        );
        if (inherited) return inherited;
      }
      return undefined;
    };
    // Candidate fields: those referenced by any single-field type constraint in
    // this type's lineage.
    const candidateFields = new Set<string>();
    for (const tc of typeDef.typeConstraints ?? []) {
      if (constraintIsExclusive(tc) && !tc.delegated && tc.fieldRefs.length === 1) candidateFields.add(tc.fieldRefs[0]);
    }
    for (const anc of typeAncestors(schema, typeDef)) {
      for (const tc of anc.typeConstraints ?? []) {
        if (constraintIsExclusive(tc) && !tc.delegated && tc.fieldRefs.length === 1) candidateFields.add(tc.fieldRefs[0]);
      }
    }
    for (const field of candidateFields) {
      const tc = lineageTypeConstraint(field);
      if (!tc) continue;
      const fieldDef = typeDef.fields.find((f) => f.name === field) as { multi?: boolean } | undefined;
      if (!fieldDef || fieldDef.multi) continue;
      // Owner: topmost ancestor declaring the same single-field type constraint
      // (or this type itself).
      let owner = typeDef;
      for (const anc of typeAncestors(schema, typeDef)) {
        if ((anc.typeConstraints ?? []).some((c) => constraintIsExclusive(c) && !c.delegated && c.fieldRefs.length === 1 && c.fieldRefs[0] === field)) {
          owner = anc;
        }
      }
      addParticipant(owner, field, typeDef, {
        exceptField: exceptFieldFrom(tc.exceptExpr),
        lower: isLowerExpr(tc.exprText),
      });
    }
  }
  return [...groups.values()];
};

// Drop any exclusivity triggers/indexes/tables that no longer correspond to a
// live constraint group (after an `ALTER TYPE … DROP CONSTRAINT`). Without
// this, the additive `CREATE … IF NOT EXISTS` machinery would keep enforcing a
// dropped constraint. `liveGroupIds` holds the sanitized owner-key ids of the
// groups that should remain.
const dropStaleExclusivityArtifacts = (db: SQLiteDatabase, liveGroupIds: Set<string>): void => {
  const isLiveShared = (name: string): boolean =>
    [...liveGroupIds].some((id) => name.startsWith(`__gel_excl__${id}__col__`));
  // Only our own exclusivity artifacts: shared tables/indexes are prefixed
  // `__gel_excl__`, and the per-table mirror triggers contain `__excl_ins__` /
  // `__excl_upd__` / `__excl_del__`. This deliberately excludes the same-table
  // UNIQUE indexes SQLite auto-creates for plain unique constraints (which
  // can't be dropped directly).
  const objects = db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name LIKE '__gel_excl__%' "
      + "OR name LIKE '%__excl_ins__%' OR name LIKE '%__excl_upd__%' OR name LIKE '%__excl_del__%'",
    )
    .all() as Array<{ type: string; name: string }>;
  for (const obj of objects) {
    // Mirror triggers are named `<tbl>__excl_(ins|upd|del)__<groupId>`;
    // shared tables and their indexes embed `__gel_excl__<groupId>__col__`.
    const groupIdMatch = /__excl_(?:ins|upd|del)__(.+)$/.exec(obj.name);
    const live = groupIdMatch ? liveGroupIds.has(groupIdMatch[1]) : isLiveShared(obj.name);
    if (live) continue;
    if (obj.type === "trigger") db.prepare(`DROP TRIGGER IF EXISTS ${quoteIdent(obj.name)}`).run();
    else if (obj.type === "index") db.prepare(`DROP INDEX IF EXISTS ${quoteIdent(obj.name)}`).run();
    else if (obj.type === "table") db.prepare(`DROP TABLE IF EXISTS ${quoteIdent(obj.name)}`).run();
  }
};

const materializeExclusivity = (db: SQLiteDatabase, schema: SchemaSnapshot): void => {
  const groups = collectExclusiveGroups(schema);
  const liveGroupIds = new Set(
    groups
      .filter((g) => g.tables.length > 0 && !(g.tables.length === 1 && !g.lower && !g.exceptField && !g.multi))
      .map((g) => g.ownerKey.replaceAll(/[^A-Za-z0-9_]/g, "_")),
  );
  dropStaleExclusivityArtifacts(db, liveGroupIds);
  for (const group of groups) {
    if (group.tables.length === 0) continue;
    // Multi-property exclusivity is never covered by a same-table index (the
    // column stores a JSON array), so it always needs the shared-table machinery
    // — even for a single participating table.
    if (group.multi) {
      materializeMultiExclusivity(db, group);
      continue;
    }
    // A single-table group with a plain value constraint is already fully
    // enforced by the same-table UNIQUE index created in materializeSchema, so
    // skip the shared-table/trigger machinery (it would only add overhead and
    // perturb table enumeration). `lower`/`except` groups still need it because
    // those don't get a direct same-table index.
    if (group.tables.length === 1 && !group.lower && !group.exceptField) continue;
    const groupId = group.ownerKey.replaceAll(/[^A-Za-z0-9_]/g, "_");
    // The property name is embedded after the `__col__` marker so the runtime
    // can recover it from SQLite's "UNIQUE constraint failed: <table>.v" text.
    const sharedTable = `__gel_excl__${groupId}__col__${group.field}`;
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(sharedTable)} (${quoteIdent("src")} TEXT PRIMARY KEY, ${quoteIdent("v")} TEXT)`,
    ).run();
    // UNIQUE index name carries `__excl__<prop>` so error translation can
    // recover the property name. `lower` constraints index lower(v).
    const indexCol = group.lower ? `lower(${quoteIdent("v")})` : quoteIdent("v");
    const whereClause = group.exceptField
      ? ` WHERE ${quoteIdent("ex")} IS NOT 1`
      : "";
    if (group.exceptField) {
      // need the except flag in the shared table for the partial index
      const cols = (db.prepare(`PRAGMA table_info(${quoteIdent(sharedTable)})`).all() as Array<{ name: string }>).map((r) => r.name);
      if (!cols.includes("ex")) {
        db.prepare(`ALTER TABLE ${quoteIdent(sharedTable)} ADD COLUMN ${quoteIdent("ex")} INTEGER`).run();
      }
    }
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`${sharedTable}__excl__${group.field}`)} ON ${quoteIdent(sharedTable)} (${indexCol})${whereClause}`,
    ).run();

    for (const tbl of group.tables) {
      const col = quoteIdent(group.field);
      const exVal = group.exceptField ? `NEW.${quoteIdent(group.exceptField)}` : "NULL";
      const exCols = group.exceptField ? `, ${quoteIdent("ex")}` : "";
      const exNew = group.exceptField ? `, ${exVal}` : "";
      // INSERT trigger: mirror non-null values into the shared table.
      db.prepare(
        `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(tbl, `excl_ins__${groupId}`))} ` +
          `AFTER INSERT ON ${quoteIdent(tbl)} WHEN NEW.${col} IS NOT NULL BEGIN ` +
          `INSERT INTO ${quoteIdent(sharedTable)} (${quoteIdent("src")}, ${quoteIdent("v")}${exCols}) ` +
          `VALUES (NEW.${quoteIdent("id")}, NEW.${col}${exNew}); END`,
      ).run();
      // UPDATE trigger: keep the mirror in sync (re-trips UNIQUE on conflict).
      db.prepare(
        `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(tbl, `excl_upd__${groupId}`))} ` +
          `AFTER UPDATE ON ${quoteIdent(tbl)} BEGIN ` +
          `DELETE FROM ${quoteIdent(sharedTable)} WHERE ${quoteIdent("src")} = NEW.${quoteIdent("id")}; ` +
          `INSERT INTO ${quoteIdent(sharedTable)} (${quoteIdent("src")}, ${quoteIdent("v")}${exCols}) ` +
          `SELECT NEW.${quoteIdent("id")}, NEW.${col}${exNew} WHERE NEW.${col} IS NOT NULL; END`,
      ).run();
      // DELETE trigger: drop the mirror row.
      db.prepare(
        `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(tbl, `excl_del__${groupId}`))} ` +
          `AFTER DELETE ON ${quoteIdent(tbl)} BEGIN ` +
          `DELETE FROM ${quoteIdent(sharedTable)} WHERE ${quoteIdent("src")} = OLD.${quoteIdent("id")}; END`,
      ).run();

      // Backfill the shared table from rows that already exist (the triggers
      // only fire on future writes). When the constraint was (re)created over
      // data that already violates it — e.g. `ALTER TYPE … CREATE CONSTRAINT`
      // after duplicates were inserted while it was dropped — the UNIQUE index
      // trips here; surface it as EdgeQL's exclusivity error rather than the
      // raw SQLite message. Rows already mirrored (src present) are skipped so
      // re-materialize over unchanged data is idempotent.
      const exSelect = group.exceptField ? `, t.${quoteIdent(group.exceptField)}` : "";
      try {
        db.prepare(
          `INSERT INTO ${quoteIdent(sharedTable)} (${quoteIdent("src")}, ${quoteIdent("v")}${exCols}) ` +
            `SELECT t.${quoteIdent("id")}, t.${col}${exSelect} FROM ${quoteIdent(tbl)} AS t ` +
            `WHERE t.${col} IS NOT NULL AND t.${quoteIdent("id")} NOT IN (SELECT ${quoteIdent("src")} FROM ${quoteIdent(sharedTable)})`,
        ).run();
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        if (/UNIQUE constraint failed/.test(msg)) {
          throw new AppError("E_VALIDATION", `${group.field} violates exclusivity constraint`, 1, 1);
        }
        throw err;
      }
    }
  }
};

// Multi-property exclusivity. A `multi property p { constraint exclusive }`
// stores its values as a JSON array in the same-table column `p`. Each element
// must be globally unique across the whole type hierarchy that shares the
// constraint. We mirror every element into a shared table keyed by
// `(src, v)` and enforce a UNIQUE index on `v` — so two rows (in any
// participating type) holding the same element collide. The triggers use
// `json_each` to expand/sync the array on insert/update/delete.
const materializeMultiExclusivity = (db: SQLiteDatabase, group: ExclusiveGroup): void => {
  const groupId = group.ownerKey.replaceAll(/[^A-Za-z0-9_]/g, "_");
  const sharedTable = `__gel_excl__${groupId}__col__${group.field}`;
  const col = quoteIdent(group.field);
  db.prepare(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(sharedTable)} (` +
      `${quoteIdent("src")} TEXT, ${quoteIdent("v")} TEXT, ` +
      `PRIMARY KEY (${quoteIdent("src")}, ${quoteIdent("v")}))`,
  ).run();
  // UNIQUE index name carries `__excl__<prop>` so error translation recovers
  // the property name from SQLite's "UNIQUE constraint failed" text.
  db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`${sharedTable}__excl__${group.field}`)} ON ${quoteIdent(sharedTable)} (${quoteIdent("v")})`,
  ).run();
  // Expand a JSON array column into (src, value) rows. `json_each` over a NULL
  // or empty array yields no rows, so nothing is mirrored when the prop is unset.
  const insertElems = (idExpr: string): string =>
    `INSERT INTO ${quoteIdent(sharedTable)} (${quoteIdent("src")}, ${quoteIdent("v")}) ` +
    `SELECT ${idExpr}, je.value FROM json_each(NEW.${col}) AS je WHERE NEW.${col} IS NOT NULL;`;
  for (const tbl of group.tables) {
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(tbl, `excl_ins__${groupId}`))} ` +
        `AFTER INSERT ON ${quoteIdent(tbl)} BEGIN ` +
        insertElems(`NEW.${quoteIdent("id")}`) +
        ` END`,
    ).run();
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(tbl, `excl_upd__${groupId}`))} ` +
        `AFTER UPDATE ON ${quoteIdent(tbl)} BEGIN ` +
        `DELETE FROM ${quoteIdent(sharedTable)} WHERE ${quoteIdent("src")} = NEW.${quoteIdent("id")}; ` +
        insertElems(`NEW.${quoteIdent("id")}`) +
        ` END`,
    ).run();
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(tbl, `excl_del__${groupId}`))} ` +
        `AFTER DELETE ON ${quoteIdent(tbl)} BEGIN ` +
        `DELETE FROM ${quoteIdent(sharedTable)} WHERE ${quoteIdent("src")} = OLD.${quoteIdent("id")}; END`,
    ).run();
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
    throw new AppError("E_SEMANTIC", `Unknown trigger target type '${targetType}' in ${qualifiedTypeName(typeDef)}.${action.kind}`);
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
      throw new AppError("E_SEMANTIC", "Cannot use __new__ in delete trigger action");
    }
    return `NEW.${quoteIdent(expr.field)}`;
  }

  if (event === "insert") {
    throw new AppError("E_SEMANTIC", "Cannot use __old__ in insert trigger action");
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
        throw new AppError("E_SEMANTIC", "Cannot use __old__ in insert rewrite");
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
