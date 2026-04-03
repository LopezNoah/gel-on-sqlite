import express from "express";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { asAppError } from "../errors.js";
import { executeQuery, type QueryExecutionTrace } from "../runtime/engine.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { renderDeclarativeSchemaFromSnapshot } from "../schema/uiSchema.js";

const querySchema = z.object({
  query: z.string().min(1),
  includeSteps: z.boolean().optional(),
});

const schemaApplyRequestSchema = z.object({
  source: z.string().min(1),
});

const schemaPlanRequestSchema = z.object({
  source: z.string().min(1),
});

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const projectRootPath = path.resolve(currentDirPath, "..", "..");

export const createHttpServer = (deps: {
  schema: SchemaSnapshot;
  execute: (query: string) => ReturnType<typeof executeQuery>;
  executeWithTrace?: (query: string) => QueryExecutionTrace;
  getSchema?: () => SchemaSnapshot;
  getSchemaSource?: () => string;
  applySchemaSource?: (source: string) => {
    schema: SchemaSnapshot;
    source: string;
    migrationPlan?: unknown;
    migrationSql?: string;
  };
  planSchemaSource?: (source: string) => {
    source: string;
    migrationPlan: unknown;
    migrationSql: string;
  };
}) => {
  const app = express();
  app.use(express.json());

  const uiDistPath = path.resolve(projectRootPath, "ui", "dist");
  const hasBuiltUi = existsSync(path.join(uiDistPath, "index.html"));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/query", (req, res) => {
    const parsed = querySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: {
          code: "E_VALIDATION",
          message: parsed.error.issues[0]?.message ?? "Invalid request body",
        },
      });
      return;
    }

    try {
      if (parsed.data.includeSteps) {
        const trace = deps.executeWithTrace
          ? deps.executeWithTrace(parsed.data.query)
          : {
              ast: null,
              ir: null,
              sql: null,
              compiler: null,
              sqlTrail: [],
              overlays: [],
              result: deps.execute(parsed.data.query),
            };

        res.json({
          ok: true,
          data: trace.result,
          steps: {
              ast: trace.ast,
              ir: trace.ir,
              sql: trace.sql,
              compiler: trace.compiler,
              sqlTrail: trace.sqlTrail,
              overlays: trace.overlays,
            },
        });
        return;
      }

      const result = deps.execute(parsed.data.query);
      res.json({ ok: true, data: result });
    } catch (err) {
      const appError = asAppError(err);
      const status = appError.code === "E_RUNTIME" ? 500 : 400;
      res.status(status).json({
        ok: false,
        error: {
          code: appError.code,
          message: appError.message,
          line: appError.line,
          column: appError.column,
        },
      });
    }
  });

  app.get("/schema", (_req, res) => {
    const currentSchema = deps.getSchema ? deps.getSchema() : deps.schema;
    res.json({
      ok: true,
      data: currentSchema.listTypes(),
    });
  });

  app.get("/schema/source", (_req, res) => {
    const currentSchema = deps.getSchema ? deps.getSchema() : deps.schema;
    const source = deps.getSchemaSource
      ? deps.getSchemaSource()
      : renderDeclarativeSchemaFromSnapshot(currentSchema);

    res.json({
      ok: true,
      data: {
        source,
      },
    });
  });

  app.post("/schema/apply", (req, res) => {
    const parsed = schemaApplyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: {
          code: "E_VALIDATION",
          message: parsed.error.issues[0]?.message ?? "Invalid request body",
        },
      });
      return;
    }

    if (!deps.applySchemaSource) {
      res.status(501).json({
        ok: false,
        error: {
          code: "E_RUNTIME",
          message: "Schema apply is not enabled for this server instance",
        },
      });
      return;
    }

    try {
      const applied = deps.applySchemaSource(parsed.data.source);
      res.json({
        ok: true,
        data: {
          source: applied.source,
          types: applied.schema.listTypes(),
          migrationPlan: applied.migrationPlan ?? null,
        },
      });
    } catch (err) {
      const appError = asAppError(err);
      const status = appError.code === "E_RUNTIME" ? 500 : 400;
      res.status(status).json({
        ok: false,
        error: {
          code: appError.code,
          message: appError.message,
          line: appError.line,
          column: appError.column,
        },
      });
    }
  });

  app.post("/schema/plan", (req, res) => {
    const parsed = schemaPlanRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: {
          code: "E_VALIDATION",
          message: parsed.error.issues[0]?.message ?? "Invalid request body",
        },
      });
      return;
    }

    if (!deps.planSchemaSource) {
      res.status(501).json({
        ok: false,
        error: {
          code: "E_RUNTIME",
          message: "Schema planning is not enabled for this server instance",
        },
      });
      return;
    }

    try {
      const planned = deps.planSchemaSource(parsed.data.source);
      res.json({
        ok: true,
        data: {
          source: planned.source,
          migrationPlan: planned.migrationPlan,
          migrationSql: planned.migrationSql,
        },
      });
    } catch (err) {
      const appError = asAppError(err);
      const status = appError.code === "E_RUNTIME" ? 500 : 400;
      res.status(status).json({
        ok: false,
        error: {
          code: appError.code,
          message: appError.message,
          line: appError.line,
          column: appError.column,
        },
      });
    }
  });

  if (hasBuiltUi) {
    app.use(express.static(uiDistPath));
    app.get("/", (_req, res) => {
      res.sendFile(path.join(uiDistPath, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.type("html").send(buildFallbackPlaygroundHtml());
    });
  }

  return app;
};

const buildFallbackPlaygroundHtml = (): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>sqlite-ts Query Playground</title>
  <style>
    body { margin: 0; font: 16px/1.4 sans-serif; background: #f3f4f6; color: #1f2937; }
    main { max-width: 960px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 8px; }
    p { margin: 0 0 16px; color: #4b5563; }
    pre {
      background: #111827;
      color: #f9fafb;
      padding: 12px;
      border-radius: 8px;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <main>
    <h1>sqlite-ts Query Playground</h1>
    <p>The Astro UI is not built yet. Build it with <code>npm run ui:build</code>.</p>
    <pre id="output">(query results will render in the Astro UI after build)</pre>
  </main>
</body>
</html>`;
