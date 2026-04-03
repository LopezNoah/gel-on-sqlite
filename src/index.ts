import { createHttpServer } from "./http/server.js";
import { materializeSchema, openSQLite } from "./runtime/database.js";
import { executeQuery, executeQueryWithTrace } from "./runtime/engine.js";
import { parseDeclarativeSchema } from "./schema/declarative.js";
import { applyMigrationPlan, planSchemaMigration, renderMigrationSQL } from "./schema/migrations.js";
import { SchemaSnapshot } from "./schema/schema.js";
import { schemaSnapshotFromDeclarative } from "./schema/uiSchema.js";
import type { TypeDef } from "./types.js";

const baseTypes: TypeDef[] = [
  {
    module: "default",
    name: "User",
    fields: [
      { name: "name", type: "str", required: true },
      { name: "email", type: "str", required: true },
    ],
  },
  {
    module: "default",
    name: "Project",
    fields: [
      { name: "name", type: "str", required: true },
      { name: "owner_id", type: "uuid", required: true },
    ],
    links: [{ name: "owner", targetType: "default::User" }],
  },
];

const initialSchemaSource = `module default {
  type User {
    required name: str;
    required email: str;
  }

  type Project {
    required name: str;
    required owner -> User;
  }
}`;

let schemaSource = initialSchemaSource;
let declarativeSchema = parseDeclarativeSchema(schemaSource);
let schema = schemaSnapshotFromDeclarative(declarativeSchema);

if (schema.listTypes().length === 0) {
  schema = new SchemaSnapshot(baseTypes);
}

const runtime = openSQLite(process.env.SQLITE_FILE ?? ":memory:");
materializeSchema(runtime.db, schema);

const app = createHttpServer({
  schema,
  getSchema: () => schema,
  getSchemaSource: () => schemaSource,
  execute: (query) => executeQuery(runtime.db, schema, query),
  executeWithTrace: (query) => executeQueryWithTrace(runtime.db, schema, query),
  applySchemaSource: (source) => {
    const nextDeclarative = parseDeclarativeSchema(source);
    const migrationPlan = planSchemaMigration(declarativeSchema, nextDeclarative);
    applyMigrationPlan(runtime.db, migrationPlan);

    declarativeSchema = nextDeclarative;
    schema = schemaSnapshotFromDeclarative(nextDeclarative);
    schemaSource = source;

    return {
      schema,
      source: schemaSource,
      migrationPlan,
      migrationSql: renderMigrationSQL(migrationPlan),
    };
  },
  planSchemaSource: (source) => {
    const nextDeclarative = parseDeclarativeSchema(source);
    const migrationPlan = planSchemaMigration(declarativeSchema, nextDeclarative);

    return {
      source,
      migrationPlan,
      migrationSql: renderMigrationSQL(migrationPlan),
    };
  },
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`sqlite-spec-rebuild listening on ${port}`);
});
