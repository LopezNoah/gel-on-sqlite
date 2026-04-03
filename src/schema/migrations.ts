import type { RuntimeDatabaseAdapter } from "../runtime/adapter.js";
import { createHash } from "node:crypto";
import type { MutationRewriteExpr, ScalarType, ScalarValue, TriggerDef, TriggerInsertAction, TriggerValueExpr } from "../types.js";
import type { DeclarativeSchema, LinkMember, ObjectTypeDeclaration, PropertyMember, TypeMember } from "./declarative.js";

export interface MigrationStep {
  description: string;
  sql: string;
}

export interface MigrationPlan {
  steps: MigrationStep[];
}

export interface MigrationApplyOptions {
  migrationId?: string;
  expectChecksum?: string;
}

export const planSchemaMigration = (fromSchema: DeclarativeSchema, toSchema: DeclarativeSchema): MigrationPlan => {
  const steps: MigrationStep[] = [
    {
      description: "create global id registry table",
      sql: `CREATE TABLE IF NOT EXISTS ${quoteIdent("__gel_global_ids")} (${quoteIdent("id")} TEXT PRIMARY KEY, ${quoteIdent("type_name")} TEXT NOT NULL)`,
    },
  ];

  const fromTypes = indexTypes(fromSchema);
  const toTypes = indexTypes(toSchema);

  for (const [typeName, toType] of [...toTypes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (toType.abstract) {
      continue;
    }

    const fromType = fromTypes.get(typeName);
    if (!fromType || fromType.abstract) {
      steps.push(...buildCreateTypeSteps(toType, toTypes));
      continue;
    }

    steps.push(...buildAlterTypeSteps(fromType, toType, toTypes));
  }

  for (const [typeName, fromType] of [...fromTypes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (toTypes.has(typeName) || fromType.abstract) {
      continue;
    }

    steps.push(...buildDropTypeSteps(fromType));
  }

  return { steps };
};

export const renderMigrationSQL = (plan: MigrationPlan): string =>
  plan.steps
    .map((step, index) => `-- step ${index + 1}: ${step.description}\n${step.sql};`)
    .join("\n\n");

export const renderSchemaSQL = (schema: DeclarativeSchema): string => {
  const plan = planSchemaMigration({ modules: [], types: [] }, schema);
  return renderMigrationSQL(plan);
};

export const applyMigrationPlan = (db: RuntimeDatabaseAdapter, plan: MigrationPlan): void => {
  applyMigrationPlanWithOptions(db, plan, {});
};

export const calculateMigrationChecksum = (plan: MigrationPlan): string =>
  createHash("sha256").update(renderMigrationSQL(plan)).digest("hex");

export const applyMigrationPlanWithOptions = (
  db: RuntimeDatabaseAdapter,
  plan: MigrationPlan,
  options: MigrationApplyOptions,
): void => {
  ensureMigrationHistoryTable(db);
  const checksum = calculateMigrationChecksum(plan);
  if (options.expectChecksum && options.expectChecksum !== checksum) {
    throw new Error(`Migration checksum mismatch: expected ${options.expectChecksum}, got ${checksum}`);
  }

  const migrationId = options.migrationId ?? `auto:${checksum}`;
  const existing = db
    .prepare(
      `SELECT ${quoteIdent("checksum")} AS ${quoteIdent("checksum")} FROM ${quoteIdent("__gel_migration_history")} WHERE ${quoteIdent("migration_id")} = ?`,
    )
    .all(migrationId)[0] as { checksum?: unknown } | undefined;

  if (existing) {
    if (typeof existing.checksum !== "string" || existing.checksum !== checksum) {
      throw new Error(`Migration '${migrationId}' checksum mismatch against applied history`);
    }
    return;
  }

  db.prepare("BEGIN").run();
  try {
    for (const step of plan.steps) {
      db.prepare(step.sql).run();
    }
    db.prepare(
      `INSERT INTO ${quoteIdent("__gel_migration_history")} (${quoteIdent("migration_id")}, ${quoteIdent("checksum")}, ${quoteIdent("applied_at")}) VALUES (?, ?, datetime('now'))`,
    ).run(migrationId, checksum);
    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    throw err;
  }
};

const ensureMigrationHistoryTable = (db: RuntimeDatabaseAdapter): void => {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent("__gel_migration_history")} (${quoteIdent("migration_id")} TEXT PRIMARY KEY, ${quoteIdent("checksum")} TEXT NOT NULL, ${quoteIdent("applied_at")} TEXT NOT NULL)`,
  ).run();
};

const buildCreateTypeSteps = (
  typeDecl: ObjectTypeDeclaration,
  allTypes: Map<string, ObjectTypeDeclaration>,
): MigrationStep[] => {
  const steps: MigrationStep[] = [];
  const table = tableName(typeDecl);

  const columns = [quoteIdent("id") + " TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16))))"];
  for (const member of typeDecl.members) {
    if (member.kind === "computed") {
      continue;
    }

    if (member.kind === "property" && !member.multi) {
      columns.push(`${quoteIdent(member.name)} ${sqlType(member.scalar)}${member.required ? " NOT NULL" : ""}`);
      continue;
    }

    if (member.kind === "link" && !member.multi && member.properties.length === 0) {
      columns.push(`${quoteIdent(`${member.name}_id`)} TEXT${member.required ? " NOT NULL" : ""}`);
    }
  }

  steps.push({
    description: `create object table for ${qualifiedTypeName(typeDecl)}`,
    sql: `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (${columns.join(", ")})`,
  });

  steps.push({
    description: `create global id insert trigger for ${qualifiedTypeName(typeDecl)}`,
    sql: `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, "gid_insert"))} AFTER INSERT ON ${quoteIdent(table)} BEGIN INSERT INTO ${quoteIdent("__gel_global_ids")} (${quoteIdent("id")}, ${quoteIdent("type_name")}) VALUES (NEW.${quoteIdent("id")}, '${table}'); END`,
  });

  steps.push({
    description: `create global id delete trigger for ${qualifiedTypeName(typeDecl)}`,
    sql: `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, "gid_delete"))} AFTER DELETE ON ${quoteIdent(table)} BEGIN DELETE FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = OLD.${quoteIdent("id")}; END`,
  });

  for (const member of typeDecl.members) {
    if (member.kind === "computed") {
      continue;
    }

    if (member.kind === "property" && member.multi) {
      const mt = multiPropertyTable(typeDecl, member);
      steps.push({
        description: `create multi property table for ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `CREATE TABLE IF NOT EXISTS ${quoteIdent(mt)} (${quoteIdent("source")} TEXT NOT NULL, ${quoteIdent("target")} ${sqlType(member.scalar)} NOT NULL)`,
      });
      continue;
    }

    if (member.kind === "link" && (member.multi || member.properties.length > 0)) {
      const lt = linkTable(typeDecl, member);
      const linkColumns = [`${quoteIdent("source")} TEXT NOT NULL`, `${quoteIdent("target")} TEXT NOT NULL`];
      for (const property of member.properties) {
        linkColumns.push(
          `${quoteIdent(property.name)} ${sqlType(property.scalar)}${property.required ? " NOT NULL" : ""}`,
        );
      }

      steps.push({
        description: `create link table for ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `CREATE TABLE IF NOT EXISTS ${quoteIdent(lt)} (${linkColumns.join(", ")})`,
      });
    }
  }

  steps.push(...buildBehaviorCreateSteps(typeDecl, allTypes));

  return steps;
};

const buildAlterTypeSteps = (
  fromType: ObjectTypeDeclaration,
  toType: ObjectTypeDeclaration,
  allTypes: Map<string, ObjectTypeDeclaration>,
): MigrationStep[] => {
  const steps: MigrationStep[] = [];
  const fromMembers = new Map(fromType.members.map((member) => [member.name, member]));
  const toMembers = new Map(toType.members.map((member) => [member.name, member]));

  for (const member of toType.members) {
    if (member.kind === "computed") {
      continue;
    }

    const existing = fromMembers.get(member.name);
    if (existing && areMembersStorageCompatible(existing, member)) {
      continue;
    }

    if (existing && !areMembersStorageCompatible(existing, member)) {
      steps.push(...buildDropMemberStorageSteps(toType, existing));
    }

    if (member.kind === "property" && !member.multi) {
      steps.push({
        description: `add property ${qualifiedTypeName(toType)}.${member.name}`,
        sql: `ALTER TABLE ${quoteIdent(tableName(toType))} ADD COLUMN ${quoteIdent(member.name)} ${sqlType(member.scalar)}${member.required ? " NOT NULL DEFAULT ''" : ""}`,
      });
      continue;
    }

    if (member.kind === "link" && !member.multi && member.properties.length === 0) {
      steps.push({
        description: `add link column ${qualifiedTypeName(toType)}.${member.name}`,
        sql: `ALTER TABLE ${quoteIdent(tableName(toType))} ADD COLUMN ${quoteIdent(`${member.name}_id`)} TEXT${member.required ? " NOT NULL DEFAULT ''" : ""}`,
      });
      continue;
    }

    if (member.kind === "property" && member.multi) {
      const mt = multiPropertyTable(toType, member);
      steps.push({
        description: `create multi property table ${qualifiedTypeName(toType)}.${member.name}`,
        sql: `CREATE TABLE IF NOT EXISTS ${quoteIdent(mt)} (${quoteIdent("source")} TEXT NOT NULL, ${quoteIdent("target")} ${sqlType(member.scalar)} NOT NULL)`,
      });
      continue;
    }

    if (member.kind === "link") {
      const lt = linkTable(toType, member);
      const linkColumns = [`${quoteIdent("source")} TEXT NOT NULL`, `${quoteIdent("target")} TEXT NOT NULL`];
      for (const property of member.properties) {
        linkColumns.push(
          `${quoteIdent(property.name)} ${sqlType(property.scalar)}${property.required ? " NOT NULL" : ""}`,
        );
      }

      steps.push({
        description: `create link table ${qualifiedTypeName(toType)}.${member.name}`,
        sql: `CREATE TABLE IF NOT EXISTS ${quoteIdent(lt)} (${linkColumns.join(", ")})`,
      });
    }
  }

  for (const member of fromType.members) {
    if (toMembers.has(member.name)) {
      continue;
    }

    if (member.kind === "computed") {
      continue;
    }

    steps.push(...buildDropMemberStorageSteps(toType, member));
  }

  if (serializeBehavior(fromType) !== serializeBehavior(toType)) {
    steps.push(...buildBehaviorDropSteps(fromType));
    steps.push(...buildBehaviorCreateSteps(toType, allTypes));
  }

  return steps;
};

const buildDropTypeSteps = (typeDecl: ObjectTypeDeclaration): MigrationStep[] => {
  const steps: MigrationStep[] = [];
  const table = tableName(typeDecl);

  for (const member of typeDecl.members) {
    if (member.kind === "computed") {
      continue;
    }

    if (member.kind === "property" && member.multi) {
      const mt = multiPropertyTable(typeDecl, member);
      steps.push({
        description: `drop multi property table for ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `DROP TABLE IF EXISTS ${quoteIdent(mt)}`,
      });
      continue;
    }

    if (member.kind === "link" && (member.multi || member.properties.length > 0)) {
      const lt = linkTable(typeDecl, member);
      steps.push({
        description: `drop link table for ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `DROP TABLE IF EXISTS ${quoteIdent(lt)}`,
      });
    }
  }

  steps.push(...buildBehaviorDropSteps(typeDecl));

  steps.push({
    description: `drop global id insert trigger for ${qualifiedTypeName(typeDecl)}`,
    sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(table, "gid_insert"))}`,
  });
  steps.push({
    description: `drop global id delete trigger for ${qualifiedTypeName(typeDecl)}`,
    sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(table, "gid_delete"))}`,
  });
  steps.push({
    description: `drop object table for ${qualifiedTypeName(typeDecl)}`,
    sql: `DROP TABLE IF EXISTS ${quoteIdent(table)}`,
  });

  return steps;
};

const buildDropMemberStorageSteps = (typeDecl: ObjectTypeDeclaration, member: TypeMember): MigrationStep[] => {
  if (member.kind === "computed") {
    return [];
  }

  if (member.kind === "property" && !member.multi) {
    return [
      {
        description: `drop property ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `ALTER TABLE ${quoteIdent(tableName(typeDecl))} DROP COLUMN ${quoteIdent(member.name)}`,
      },
    ];
  }

  if (member.kind === "link" && !member.multi && member.properties.length === 0) {
    return [
      {
        description: `drop link column ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `ALTER TABLE ${quoteIdent(tableName(typeDecl))} DROP COLUMN ${quoteIdent(`${member.name}_id`)}`,
      },
    ];
  }

  if (member.kind === "property") {
    return [
      {
        description: `drop multi property table ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `DROP TABLE IF EXISTS ${quoteIdent(multiPropertyTable(typeDecl, member))}`,
      },
    ];
  }

  return [
    {
      description: `drop link table ${qualifiedTypeName(typeDecl)}.${member.name}`,
      sql: `DROP TABLE IF EXISTS ${quoteIdent(linkTable(typeDecl, member))}`,
    },
  ];
};

const buildBehaviorCreateSteps = (
  typeDecl: ObjectTypeDeclaration,
  allTypes: Map<string, ObjectTypeDeclaration>,
): MigrationStep[] => {
  const steps: MigrationStep[] = [];
  const table = tableName(typeDecl);

  for (const member of typeDecl.members) {
    if (member.kind !== "property") {
      continue;
    }

    if (member.rewrite?.onInsert) {
      steps.push({
        description: `create mutation rewrite insert trigger for ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, `rewrite_insert_${member.name}`))} AFTER INSERT ON ${quoteIdent(table)} BEGIN UPDATE ${quoteIdent(table)} SET ${quoteIdent(member.name)} = ${rewriteExprToSQL(member.rewrite.onInsert, "insert")} WHERE ${quoteIdent("id")} = NEW.${quoteIdent("id")}; END`,
      });
    }

    if (member.rewrite?.onUpdate) {
      steps.push({
        description: `create mutation rewrite update trigger for ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(table, `rewrite_update_${member.name}`))} AFTER UPDATE ON ${quoteIdent(table)} BEGIN UPDATE ${quoteIdent(table)} SET ${quoteIdent(member.name)} = ${rewriteExprToSQL(member.rewrite.onUpdate, "update")} WHERE ${quoteIdent("id")} = NEW.${quoteIdent("id")}; END`,
      });
    }
  }

  for (const trigger of typeDecl.triggers) {
    const sql = compileCustomTriggerSQL(typeDecl, trigger, allTypes);
    if (!sql) {
      continue;
    }

    steps.push({
      description: `create custom trigger ${qualifiedTypeName(typeDecl)}.${trigger.name}`,
      sql,
    });
  }

  return steps;
};

const buildBehaviorDropSteps = (typeDecl: ObjectTypeDeclaration): MigrationStep[] => {
  const steps: MigrationStep[] = [];
  const table = tableName(typeDecl);

  for (const member of typeDecl.members) {
    if (member.kind !== "property") {
      continue;
    }

    if (member.rewrite?.onInsert) {
      steps.push({
        description: `drop mutation rewrite insert trigger for ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(table, `rewrite_insert_${member.name}`))}`,
      });
    }

    if (member.rewrite?.onUpdate) {
      steps.push({
        description: `drop mutation rewrite update trigger for ${qualifiedTypeName(typeDecl)}.${member.name}`,
        sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(table, `rewrite_update_${member.name}`))}`,
      });
    }
  }

  for (const trigger of typeDecl.triggers) {
    steps.push({
      description: `drop custom trigger ${qualifiedTypeName(typeDecl)}.${trigger.name}`,
      sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(table, `custom_${trigger.name}`))}`,
    });
  }

  return steps;
};

const compileCustomTriggerSQL = (
  typeDecl: ObjectTypeDeclaration,
  trigger: TriggerDef,
  allTypes: Map<string, ObjectTypeDeclaration>,
): string | null => {
  const sourceTable = tableName(typeDecl);
  const whenClause = compileTriggerWhenClause(trigger.when, trigger.event);
  const actions = trigger.actions.map((action) => compileTriggerActionSQL(typeDecl, action, trigger.event, allTypes));
  if (actions.length === 0) {
    return null;
  }

  return `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(sourceTable, `custom_${trigger.name}`))} AFTER ${trigger.event.toUpperCase()} ON ${quoteIdent(sourceTable)}${whenClause} BEGIN ${actions.join(" ")} END`;
};

const compileTriggerWhenClause = (whenClause: TriggerDef["when"], event: TriggerDef["event"]): string => {
  if (!whenClause || whenClause.kind === "always") {
    return "";
  }

  if (whenClause.kind === "field_changed" && event === "update") {
    return ` WHEN OLD.${quoteIdent(whenClause.field)} IS NOT NEW.${quoteIdent(whenClause.field)}`;
  }

  return "";
};

const compileTriggerActionSQL = (
  typeDecl: ObjectTypeDeclaration,
  action: TriggerInsertAction,
  event: TriggerDef["event"],
  allTypes: Map<string, ObjectTypeDeclaration>,
): string => {
  const targetTypeName = normalizeTypeName(typeDecl.module, action.targetType);
  const targetType = allTypes.get(targetTypeName);
  if (!targetType) {
    throw new Error(`Unknown trigger target type '${targetTypeName}' in ${qualifiedTypeName(typeDecl)}.${action.kind}`);
  }

  const entries = Object.entries(action.values);
  if (entries.length === 0) {
    return `INSERT INTO ${quoteIdent(tableName(targetType))} DEFAULT VALUES;`;
  }

  const columns = entries.map(([field]) => quoteIdent(field)).join(", ");
  const values = entries.map(([, expr]) => triggerExprToSQL(expr, event)).join(", ");
  return `INSERT INTO ${quoteIdent(tableName(targetType))} (${columns}) VALUES (${values});`;
};

const triggerExprToSQL = (expr: TriggerValueExpr, event: TriggerDef["event"]): string => {
  if (expr.kind === "literal") {
    return literalToSQL(expr.value);
  }

  if (expr.kind === "new_field") {
    if (event === "delete") {
      throw new Error("Cannot reference __new__ in delete trigger");
    }
    return `NEW.${quoteIdent(expr.field)}`;
  }

  if (event === "insert") {
    throw new Error("Cannot reference __old__ in insert trigger");
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
        throw new Error("Cannot reference __old__ in insert rewrite");
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

const areMembersStorageCompatible = (from: TypeMember, to: TypeMember): boolean => {
  if (from.kind === "computed" || to.kind === "computed") {
    return from.kind === to.kind;
  }

  if (from.kind !== to.kind) {
    return false;
  }

  if (from.kind === "property" && to.kind === "property") {
    return from.multi === to.multi && from.scalar === to.scalar && from.required === to.required;
  }

  if (from.kind === "link" && to.kind === "link") {
    return (
      from.multi === to.multi &&
      from.target === to.target &&
      from.required === to.required &&
      JSON.stringify(from.properties) === JSON.stringify(to.properties)
    );
  }

  return false;
};

const serializeBehavior = (typeDecl: ObjectTypeDeclaration): string =>
  JSON.stringify({
    members: typeDecl.members.map((member) =>
      member.kind === "property"
        ? {
            kind: member.kind,
            name: member.name,
            rewrite: member.rewrite,
          }
        : {
            kind: member.kind,
            name: member.name,
          },
    ),
    triggers: typeDecl.triggers,
  });

const indexTypes = (schema: DeclarativeSchema): Map<string, ObjectTypeDeclaration> => {
  const map = new Map<string, ObjectTypeDeclaration>();
  for (const typeDecl of schema.types) {
    map.set(qualifiedTypeName(typeDecl), typeDecl);
  }

  return map;
};

const qualifiedTypeName = (typeDecl: ObjectTypeDeclaration): string => `${typeDecl.module}::${typeDecl.name}`;

const tableName = (typeDecl: ObjectTypeDeclaration): string =>
  `${typeDecl.module.toLowerCase()}__${typeDecl.name.toLowerCase()}`;

const multiPropertyTable = (typeDecl: ObjectTypeDeclaration, member: PropertyMember): string =>
  `${tableName(typeDecl)}__${member.name.toLowerCase()}`;

const linkTable = (typeDecl: ObjectTypeDeclaration, member: LinkMember): string =>
  `${tableName(typeDecl)}__${member.name.toLowerCase()}`;

const normalizeTypeName = (moduleName: string, name: string): string => (name.includes("::") ? name : `${moduleName}::${name}`);

const triggerName = (table: string, suffix: string): string => `${table.replaceAll(/[^A-Za-z0-9_]/g, "_")}__${suffix}`;

const sqlType = (scalar: ScalarType): string => {
  switch (scalar) {
    case "str":
    case "json":
    case "datetime":
    case "uuid":
      return "TEXT";
    case "int":
      return "INTEGER";
    case "float":
      return "REAL";
    case "bool":
      return "INTEGER";
    default:
      return "TEXT";
  }
};

const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;
