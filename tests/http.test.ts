import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpServer } from "../src/http/server.js";
import { materializeSchema, openSQLite, type SQLiteRuntime } from "../src/runtime/database.js";
import { executeQuery, executeQueryWithTrace } from "../src/runtime/engine.js";
import { parseDeclarativeSchema } from "../src/schema/declarative.js";
import { applyMigrationPlan, planSchemaMigration, renderMigrationSQL } from "../src/schema/migrations.js";
import { SchemaSnapshot } from "../src/schema/schema.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

describe("HTTP API", () => {
  let runtime: SQLiteRuntime | undefined;
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = undefined;
    }
    runtime?.close();
    runtime = undefined;
  });

  it("[SPEC-043.R1][SPEC-043.R2] validates payload and executes query", async () => {
    const schema = new SchemaSnapshot([
      {
        module: "default",
        name: "User",
        fields: [
          { name: "name", type: "str", required: true },
          { name: "active", type: "bool" },
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
    ]);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, schema);

    const app = createHttpServer({
      schema,
      execute: (query) => executeQuery(runtime!.db, schema, query),
      executeWithTrace: (query) => executeQueryWithTrace(runtime!.db, schema, query),
    });

    const server = await new Promise<import("node:http").Server>((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });

    closeServer = async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      });
    };

    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const badPayload = await postJson(baseUrl, "/query", { wrong: true });
    expect(badPayload.status).toBe(400);
    expect(badPayload.body.ok).toBe(false);

    const homepage = await fetch(`${baseUrl}/`);
    expect(homepage.status).toBe(200);
    const homepageText = await homepage.text();
    expect(
      homepageText.includes("sqlite-ts Query Playground") || homepageText.includes("sqlite-ts Studio REPL"),
    ).toBe(true);

    const schemaSource = await fetch(`${baseUrl}/schema/source`);
    expect(schemaSource.status).toBe(200);
    const schemaSourceBody = (await schemaSource.json()) as {
      ok: boolean;
      data: { source: string };
    };
    expect(schemaSourceBody.ok).toBe(true);
    expect(schemaSourceBody.data.source).toContain("type User");

    const insertResponse = await postJson(baseUrl, "/query", {
      query: "insert default::User { name := 'Ari', active := true };",
    });
    expect(insertResponse.status).toBe(200);
    expect(insertResponse.body.ok).toBe(true);

    const updateResponse = await postJson(baseUrl, "/query", {
      query: "update default::User filter name = 'Ari' set { name := 'Aria' };",
    });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data.kind).toBe("update");

    const selectResponse = await postJson(baseUrl, "/query", {
      query: "select default::User { id, name } filter name = 'Aria' order by name asc offset 0 limit 10;",
    });
    expect(selectResponse.status).toBe(200);

    expect(selectResponse.body.data.rows).toEqual([{ id: expect.any(String), name: "Aria" }]);

    const tracedSelect = await postJson(baseUrl, "/query", {
      query: "select default::User { id, name } filter name = 'Aria' order by name asc offset 0 limit 10;",
      includeSteps: true,
    });

    expect(tracedSelect.status).toBe(200);
    expect(tracedSelect.body.steps.ast.kind).toBe("select");
    expect(tracedSelect.body.steps.ir.kind).toBe("select");
    expect(tracedSelect.body.steps.sql.sql).toContain("SELECT");
    expect(tracedSelect.body.steps.sqlTrail.length).toBeGreaterThan(0);
    expect(tracedSelect.body.steps.compiler.status).toMatch(/hit|miss/);
    expect(typeof tracedSelect.body.steps.compiler.key).toBe("string");
    expect(Array.isArray(tracedSelect.body.steps.overlays)).toBe(true);

    const badProject = await postJson(baseUrl, "/query", {
      query: "insert default::Project { name := 'Broken', owner_id := 'missing-id' };",
    });
    expect(badProject.status).toBe(400);
    expect(badProject.body.error.message).toMatch(/does not reference an existing object/);
  });

  it("[SPEC-052.R1][SPEC-052.R2][SPEC-052.R3] plans and applies schema updates via HTTP", async () => {
    const initialSource = `module default {
  type User {
    required name: str;
    required email: str;
  }
}`;

    let currentSource = initialSource;
    let currentDeclarative = parseDeclarativeSchema(initialSource);
    let currentSchema = schemaSnapshotFromDeclarative(currentDeclarative);

    runtime = openSQLite(":memory:");
    materializeSchema(runtime.db, currentSchema);

    const app = createHttpServer({
      schema: currentSchema,
      getSchema: () => currentSchema,
      getSchemaSource: () => currentSource,
      execute: (query) => executeQuery(runtime!.db, currentSchema, query),
      executeWithTrace: (query) => executeQueryWithTrace(runtime!.db, currentSchema, query),
      planSchemaSource: (source) => {
        const nextDeclarative = parseDeclarativeSchema(source);
        const plan = planSchemaMigration(currentDeclarative, nextDeclarative);

        return {
          source,
          migrationPlan: plan,
          migrationSql: renderMigrationSQL(plan),
        };
      },
      applySchemaSource: (source) => {
        const nextDeclarative = parseDeclarativeSchema(source);
        const plan = planSchemaMigration(currentDeclarative, nextDeclarative);
        applyMigrationPlan(runtime!.db, plan);

        currentDeclarative = nextDeclarative;
        currentSchema = schemaSnapshotFromDeclarative(nextDeclarative);
        currentSource = source;

        return {
          schema: currentSchema,
          source: currentSource,
          migrationPlan: plan,
          migrationSql: renderMigrationSQL(plan),
        };
      },
    });

    const server = await new Promise<import("node:http").Server>((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });

    closeServer = async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    };

    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const schemaBefore = await fetch(`${baseUrl}/schema/source`);
    expect(schemaBefore.status).toBe(200);
    const schemaBeforeBody = (await schemaBefore.json()) as { data: { source: string } };
    expect(schemaBeforeBody.data.source).toContain("type User");

    const updatedSource = `module default {
  type User {
    required name: str;
    required email: str;
  }

  type Project {
    required name: str;
    required owner -> User;
  }
}`;

    const planResponse = await postJson(baseUrl, "/schema/plan", {
      source: updatedSource,
    });

    expect(planResponse.status).toBe(200);
    expect(planResponse.body.ok).toBe(true);
    expect(planResponse.body.data.migrationSql).toContain("CREATE TABLE");

    const preApplyInsertProject = await postJson(baseUrl, "/query", {
      query: "insert default::Project { name := 'Should Fail' };",
    });
    expect(preApplyInsertProject.status).toBe(400);

    const applyResponse = await postJson(baseUrl, "/schema/apply", {
      source: updatedSource,
    });

    expect(applyResponse.status).toBe(200);
    expect(applyResponse.body.ok).toBe(true);
    expect(applyResponse.body.data.types.some((t: { name: string }) => t.name === "Project")).toBe(true);
    expect(applyResponse.body.data.migrationPlan.steps.length).toBeGreaterThan(0);

    const insertUser = await postJson(baseUrl, "/query", {
      query: "insert default::User { name := 'Noah', email := 'noah@example.com' };",
    });
    expect(insertUser.status).toBe(200);

    const userRows = await postJson(baseUrl, "/query", {
      query: "select default::User { id, name } filter email = 'noah@example.com';",
    });
    const userId = userRows.body.data.rows[0].id as string;

    const insertProject = await postJson(baseUrl, "/query", {
      query: `insert default::Project { name := 'Studio Parity', owner_id := '${userId}' };`,
    });
    expect(insertProject.status).toBe(200);

    const projectRows = await postJson(baseUrl, "/query", {
      query: "select default::Project { name, owner { name } } filter name = 'Studio Parity';",
    });

    expect(projectRows.status).toBe(200);
    expect(projectRows.body.data.rows).toEqual([
      {
        name: "Studio Parity",
        owner: [
          {
            name: "Noah",
          },
        ],
      },
    ]);
  });
});

const postJson = async (
  baseUrl: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: (await response.json()) as any,
  };
};
