import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { CompilerService } from "../src/compiler/service.js";
import { expandSchemaAliasesInStatement } from "../src/compiler/ast_to_ir.js";
import type { Statement } from "../src/edgeql/ast.js";
import { parseEdgeQL, parseEdgeQLScript } from "../src/edgeql/parser.js";
import { offsetToLineCol, tokenizeWithStarts } from "../src/edgeql/tokenizer.js";
import type { Token } from "../src/edgeql/tokenizer.js";
import type { Statement as GelIRStatement } from "../src/ir/gel_ir.js";
import type { IRStatement } from "../src/ir/model.js";
import { SchemaSnapshot } from "../src/schema/schema.js";
import { parseDeclarativeSchema } from "../src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";
import type { GelIRSQLArtifact } from "../src/sql/gel_ir_compiler.js";
import type { RuntimeTarget } from "../src/runtime/target.js";

export type DebugToken = Token & {
  line: number;
  column: number;
};

export interface PipelineDebugOutput {
  query: string;
  schema?: {
    path: string;
    typeCount: number;
    loadedFiles?: string[];
  };
  setup?: {
    path: string;
    statementCount: number;
  };
  ok: boolean;
  stages: PipelineStageStatus[];
  diagnostics: PipelineDiagnostic[];
  tokens?: DebugToken[];
  ast?: Statement;
  expandedAst?: Statement;
  ir?: IRStatement;
  gelIr?: GelIRStatement;
  sql?: GelIRSQLArtifact;
}

export type PipelineStageName = "schema" | "setup" | "tokenizer" | "parser" | "ast_expand" | "ir" | "sql";

export interface PipelineStageStatus {
  name: PipelineStageName;
  status: "ok" | "failed" | "skipped";
  summary?: string;
}

export interface PipelineDiagnostic {
  stage: PipelineStageName;
  category: "schema" | "setup" | "query" | "compiler" | "sql" | "internal";
  severity: "error";
  message: string;
  code?: string;
  line?: number;
  column?: number;
  likelyCause: "schema_or_fixture" | "setup" | "query" | "compiler" | "sql" | "internal";
  hint: string;
}

export interface ReadDebugSchemaResult {
  snapshot: SchemaSnapshot;
  meta?: PipelineDebugOutput["schema"];
}

export interface BuildPipelineReportOptions {
  query: string;
  schemaInput?: string;
  setupInput?: string;
  target: RuntimeTarget;
}

export const readDebugSchema = (schemaInput: string | undefined): ReadDebugSchemaResult => {
  if (!schemaInput) {
    return { snapshot: new SchemaSnapshot() };
  }

  const schemaSource = loadDebugSchemaSource(schemaInput);
  const declarative = parseDeclarativeSchema(schemaSource.source, { legacySyntaxCompat: true });
  const snapshot = schemaSnapshotFromDeclarative(declarative);
  return {
    snapshot,
    meta: {
      path: schemaSource.label,
      typeCount: snapshot.listTypes().length,
      loadedFiles: schemaSource.loadedFiles,
    },
  };
};

export const readDebugSetup = (setupInput: string | undefined): PipelineDebugOutput["setup"] | undefined => {
  if (!setupInput) {
    return undefined;
  }

  const setupPath = resolveSetupInput(setupInput);
  const source = readFileSync(setupPath, "utf8");
  const statements = parseEdgeQLScript(source);
  return {
    path: setupPath,
    statementCount: statements.length,
  };
};

export const buildPipelineDebugReport = (options: BuildPipelineReportOptions): PipelineDebugOutput => {
  const stages: PipelineStageStatus[] = [];
  const diagnostics: PipelineDiagnostic[] = [];
  const output: PipelineDebugOutput = {
    query: options.query,
    ok: false,
    stages,
    diagnostics,
  };

  let schema = new SchemaSnapshot();
  let canContinue = true;

  try {
    const schemaResult = readDebugSchema(options.schemaInput);
    schema = schemaResult.snapshot;
    output.schema = schemaResult.meta;
    stages.push({ name: "schema", status: "ok", summary: schemaResult.meta ? `Loaded ${schemaResult.meta.typeCount} types` : "Using empty schema" });
  } catch (err) {
    stages.push({ name: "schema", status: "failed" });
    diagnostics.push(toDiagnostic(err, "schema", "schema"));
    canContinue = false;
  }

  if (options.setupInput) {
    try {
      output.setup = readDebugSetup(options.setupInput);
      stages.push({ name: "setup", status: "ok", summary: output.setup ? `Parsed ${output.setup.statementCount} setup statements` : undefined });
    } catch (err) {
      stages.push({ name: "setup", status: "failed" });
      diagnostics.push(toDiagnostic(err, "setup", "setup"));
      // Setup is not executed by this debugger. Keep compiling the query so the
      // user can see whether the query itself is also broken.
    }
  } else {
    stages.push({ name: "setup", status: "skipped", summary: "No setup file provided" });
  }

  if (!canContinue) {
    skipRemainingStages(stages, "tokenizer");
    return output;
  }

  let ast: Statement | undefined;
  try {
    const tokenized = tokenizeWithStarts(options.query);
    output.tokens = tokenized.tokens.map((token) => {
      const pos = offsetToLineCol(token.offset, tokenized.lineStarts);
      return {
        ...token,
        line: pos.line,
        column: pos.column,
      };
    });
    stages.push({ name: "tokenizer", status: "ok", summary: `${output.tokens.length} tokens` });
  } catch (err) {
    stages.push({ name: "tokenizer", status: "failed" });
    diagnostics.push(toDiagnostic(err, "tokenizer", "query"));
    skipRemainingStages(stages, "parser");
    return output;
  }

  try {
    ast = parseEdgeQL(options.query);
    output.ast = ast;
    stages.push({ name: "parser", status: "ok", summary: ast.kind });
  } catch (err) {
    stages.push({ name: "parser", status: "failed" });
    diagnostics.push(toDiagnostic(err, "parser", "query"));
    skipRemainingStages(stages, "ast_expand");
    return output;
  }

  try {
    output.expandedAst = expandSchemaAliasesInStatement(ast, schema);
    stages.push({ name: "ast_expand", status: "ok" });
  } catch (err) {
    stages.push({ name: "ast_expand", status: "failed" });
    diagnostics.push(toDiagnostic(err, "ast_expand", "compiler"));
    skipRemainingStages(stages, "ir");
    return output;
  }

  try {
    const compiled = new CompilerService().compile(schema, ast, { target: options.target });
    output.ir = compiled.ir;
    output.gelIr = compiled.gelIr;
    output.sql = compiled.sql;
    stages.push({ name: "ir", status: "ok", summary: compiled.ir.kind });
    stages.push({ name: "sql", status: "ok", summary: compiled.sql.loweringMode });
    output.ok = true;
  } catch (err) {
    stages.push({ name: "ir", status: "failed" });
    stages.push({ name: "sql", status: "skipped" });
    diagnostics.push(toDiagnostic(err, "ir", "compiler"));
  }

  return output;
};

export const buildPipelineDebugOutput = (
  query: string,
  schema: SchemaSnapshot,
  target: RuntimeTarget,
  schemaFile?: string,
): PipelineDebugOutput => {
  const tokenized = tokenizeWithStarts(query);
  const tokens = tokenized.tokens.map((token) => {
    const pos = offsetToLineCol(token.offset, tokenized.lineStarts);
    return {
      ...token,
      line: pos.line,
      column: pos.column,
    };
  });
  const ast = parseEdgeQL(query);
  const expandedAst = expandSchemaAliasesInStatement(ast, schema);
  const compiled = new CompilerService().compile(schema, ast, { target });

  return {
    query,
    schema: schemaFile
      ? {
          path: schemaFile,
          typeCount: schema.listTypes().length,
        }
      : undefined,
    ok: true,
    stages: [
      { name: "schema", status: "ok" },
      { name: "setup", status: "skipped" },
      { name: "tokenizer", status: "ok" },
      { name: "parser", status: "ok" },
      { name: "ast_expand", status: "ok" },
      { name: "ir", status: "ok" },
      { name: "sql", status: "ok" },
    ],
    diagnostics: [],
    tokens,
    ast,
    expandedAst,
    ir: compiled.ir,
    gelIr: compiled.gelIr,
    sql: compiled.sql,
  };
};

interface DebugSchemaSource {
  source: string;
  label: string;
  loadedFiles: string[];
}

const loadDebugSchemaSource = (schemaInput: string): DebugSchemaSource => {
  if (isSchemaFilePath(schemaInput)) {
    const raw = readFileSync(schemaInput, "utf8");
    return {
      source: shouldWrapDefaultModule(schemaInput, raw)
        ? `module default {\n${raw}\n}`
        : raw,
      label: schemaInput,
      loadedFiles: [schemaInput],
    };
  }

  const fixturePath = join("tests", "schemas", `${schemaInput}.esdl`);
  if (!existsSync(fixturePath)) {
    throw new Error(`Schema '${schemaInput}' was not found as a file or tests/schemas fixture.`);
  }

  const parts: Array<{ fileName: string; moduleName: string }> = [];
  const idx = schemaInput.lastIndexOf("_");
  if (idx > 0) {
    const defaultName = `${schemaInput.slice(0, idx)}_default`;
    const defaultPath = join("tests", "schemas", `${defaultName}.esdl`);
    if (existsSync(defaultPath) && defaultName !== schemaInput) {
      parts.push({ fileName: defaultName, moduleName: "default" });
    }
  }
  parts.push({ fileName: schemaInput, moduleName: inferredModuleNameFromSchema(schemaInput) });

  const loadedFiles: string[] = [];
  const source = parts
    .map(({ fileName, moduleName }) => {
      const p = join("tests", "schemas", `${fileName}.esdl`);
      loadedFiles.push(p);
      return wrapModule(moduleName, readFileSync(p, "utf8"));
    })
    .join("\n\n");

  return {
    source,
    label: `fixture:${schemaInput}`,
    loadedFiles,
  };
};

const isSchemaFilePath = (schemaInput: string): boolean => (
  existsSync(schemaInput) || schemaInput.endsWith(".esdl") || schemaInput.includes("/")
);

const resolveSetupInput = (setupInput: string): string => {
  if (existsSync(setupInput) || setupInput.endsWith(".edgeql") || setupInput.includes("/")) {
    return setupInput;
  }
  const fixturePath = join("tests", "schemas", `${setupInput}.edgeql`);
  if (existsSync(fixturePath)) {
    return fixturePath;
  }
  throw new Error(`Setup '${setupInput}' was not found as a file or tests/schemas fixture.`);
};

const inferredModuleNameFromSchema = (schemaName: string): string => {
  const idx = schemaName.lastIndexOf("_");
  if (idx < 0) {
    return "default";
  }
  return schemaName.slice(idx + 1).toLowerCase().split("_").join("::");
};

const wrapModule = (moduleName: string, source: string): string => {
  const cleanSource = stripHashComments(source);
  if (hasExplicitModuleDeclaration(cleanSource)) {
    return cleanSource;
  }
  return `module ${moduleName} {\n${cleanSource}\n}`;
};

const stripHashComments = (source: string): string => {
  let output = "";
  let inComment = false;
  for (const ch of source) {
    if (inComment) {
      if (ch === "\n") {
        inComment = false;
        output += ch;
      }
      continue;
    }
    if (ch === "#") {
      inComment = true;
      continue;
    }
    output += ch;
  }
  return output;
};

const hasExplicitModuleDeclaration = (source: string): boolean => source.trimStart().startsWith("module ");

const skipRemainingStages = (stages: PipelineStageStatus[], first: PipelineStageName): void => {
  const order: PipelineStageName[] = ["tokenizer", "parser", "ast_expand", "ir", "sql"];
  const start = order.indexOf(first);
  for (const stage of order.slice(start)) {
    stages.push({ name: stage, status: "skipped" });
  }
};

const toDiagnostic = (
  err: unknown,
  stage: PipelineStageName,
  category: PipelineDiagnostic["category"],
): PipelineDiagnostic => {
  const errorLike = err && typeof err === "object" ? err as { message?: unknown; code?: unknown; line?: unknown; column?: unknown } : undefined;
  const message = typeof errorLike?.message === "string" ? errorLike.message : String(err);
  const likelyCause = likelyCauseFor(stage, category, message);
  return {
    stage,
    category,
    severity: "error",
    message,
    code: typeof errorLike?.code === "string" ? errorLike.code : undefined,
    line: typeof errorLike?.line === "number" ? errorLike.line : undefined,
    column: typeof errorLike?.column === "number" ? errorLike.column : undefined,
    likelyCause,
    hint: hintFor(stage, likelyCause),
  };
};

const likelyCauseFor = (
  stage: PipelineStageName,
  category: PipelineDiagnostic["category"],
  message: string,
): PipelineDiagnostic["likelyCause"] => {
  if (stage === "schema") return "schema_or_fixture";
  if (stage === "setup") return "setup";
  if (category === "query" || stage === "tokenizer" || stage === "parser") return "query";
  if (category === "sql") return "sql";
  const lower = message.toLowerCase();
  if (lower.includes("unknown type") || lower.includes("unknown function") || lower.includes("no such")
    || lower.includes("does not exist") || lower.includes("not found") || lower.includes("cannot resolve")) {
    return "schema_or_fixture";
  }
  return "compiler";
};

const hintFor = (stage: PipelineStageName, likelyCause: PipelineDiagnostic["likelyCause"]): string => {
  if (likelyCause === "schema_or_fixture") {
    return "Check the schema input. For converted tests, use a fixture name like dump01_test so companion files such as dump01_default.esdl are loaded with the same module mapping as QueryHarness.";
  }
  if (likelyCause === "setup") {
    return "Check the setup input. The debugger parse-checks setup files but does not execute them; use a fixture name like dump01_setup or a .edgeql path.";
  }
  if (likelyCause === "query") {
    return "The query failed before semantic compilation. Check syntax, tokenization, and the reported line/column.";
  }
  if (likelyCause === "sql") {
    return "The query reached SQL lowering and failed there. Inspect IR and the compiler message.";
  }
  if (stage === "ir" || stage === "ast_expand") {
    return "The query parsed, but semantic compilation failed. This is usually an unsupported construct, a missing schema object, or a query/schema mismatch.";
  }
  return "Inspect the previous successful stage and the error message.";
};

const shouldWrapDefaultModule = (schemaFile: string, source: string): boolean => {
  if (extname(schemaFile) !== ".esdl") {
    return false;
  }
  return !/\bmodule\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(source);
};
