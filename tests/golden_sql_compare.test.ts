import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeAll } from "vitest";
import {
  gelFactsOf,
  inspect,
} from "../src/compiler/inspect.js";
import { loadSchema as loadSchemaSnapshot } from "../src/schema/load.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";
import { QueryHarness, type HarnessOptions } from "./utils.js";

const ROOT_DIR = new URL("../", import.meta.url).pathname;
const GOLDENS_DIR = path.join(ROOT_DIR, "goldens/gel-compiler-facts");
const OUT_DIR = new URL("../test-comparison/golden-sql/", import.meta.url).pathname;

interface ManifestCase {
  case_index: number;
  class: string;
  output: string;
  source: string;
  test: string;
  status?: string;
  error?: { message: string; type: string };
}

interface Manifest {
  cases: ManifestCase[];
}

interface GoldenFile {
  ok: boolean;
  query: string;
  schema_file: string;
  postgres_sql?: string;
  source_test: { file: string; class: string; test: string; case_index: number };
  inference?: { cardinality: string; multiplicity: string; volatility: string };
}

function loadManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_DIR, "manifest.json"), "utf8"));
}

function loadGolden(relativePath: string): GoldenFile | null {
  // relativePath is like "goldens/gel-compiler-facts/edgeql_select/..." from manifest
  // We need to resolve it relative to ROOT_DIR
  const fullPath = path.join(ROOT_DIR, relativePath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    return null;
  }
}

// Schema cache: maps the resolved schema/setup source to SchemaSnapshot.
const schemaCache = new Map<string, SchemaSnapshot>();

const harnessOptionsCache = new Map<string, HarnessOptions | null>();

function parseHarnessOptions(sourceGroup: string, className: string): HarnessOptions | null {
  const cacheKey = `${sourceGroup}:${className}`;
  if (harnessOptionsCache.has(cacheKey)) return harnessOptionsCache.get(cacheKey)!;

  const candidates = [
    path.join(ROOT_DIR, "tests", `${sourceGroup}.test.ts`),
    sourceGroup.startsWith("edgeql_")
      ? path.join(ROOT_DIR, "tests", `${sourceGroup.slice("edgeql_".length)}.test.ts`)
      : "",
  ].filter(Boolean);

  const testFile = candidates.find((p) => fs.existsSync(p));
  if (!testFile) {
    harnessOptionsCache.set(cacheKey, null);
    return null;
  }

  const source = fs.readFileSync(testFile, "utf8");
  const classIdx = source.indexOf(`describe("${className}"`);
  const searchFrom = classIdx >= 0 ? classIdx : 0;
  const createIdx = source.indexOf("QueryHarness.create({", searchFrom);
  if (createIdx < 0) {
    harnessOptionsCache.set(cacheKey, null);
    return null;
  }

  const bodyStart = source.indexOf("{", createIdx);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  if (bodyEnd < 0) {
    harnessOptionsCache.set(cacheKey, null);
    return null;
  }

  const body = source.slice(bodyStart + 1, bodyEnd);
  const options: HarnessOptions = {};
  const schema = body.match(/\bschema:\s*"([^"]+)"/)?.[1];
  const setup = body.match(/\bsetup:\s*"([^"]+)"/)?.[1];
  if (schema) options.schema = schema;
  if (setup) options.setup = setup;

  const extraModulesText = body.match(/\bextraModules:\s*\{([^}]+)\}/s)?.[1];
  if (extraModulesText) {
    options.extraModules = {};
    for (const match of extraModulesText.matchAll(/([A-Za-z_][A-Za-z0-9_]*):\s*"([^"]+)"/g)) {
      options.extraModules[match[1]] = match[2];
    }
  }

  const extraSetupsText = body.match(/\bextraSetups:\s*\[([^\]]+)\]/s)?.[1];
  if (extraSetupsText) {
    options.extraSetups = [];
    for (const match of extraSetupsText.matchAll(/\{\s*module:\s*"([^"]+)",\s*setup:\s*"([^"]+)"\s*\}/g)) {
      options.extraSetups.push({ module: match[1], setup: match[2] });
    }
  }

  harnessOptionsCache.set(cacheKey, options);
  return options;
}

function inferHarnessOptionsFromSchemaFiles(sourceGroup: string): HarnessOptions | null {
  const cacheKey = `${sourceGroup}:<schema-files>`;
  if (harnessOptionsCache.has(cacheKey)) return harnessOptionsCache.get(cacheKey)!;

  const schemaDir = path.join(ROOT_DIR, "tests", "schemas");
  const candidates = [`${sourceGroup}_default`, sourceGroup];
  for (const schemaName of candidates) {
    if (!fs.existsSync(path.join(schemaDir, `${schemaName}.esdl`))) continue;
    const options: HarnessOptions = { schema: schemaName };
    const setupName = `${sourceGroup}_setup`;
    if (fs.existsSync(path.join(schemaDir, `${setupName}.edgeql`))) {
      options.setup = setupName;
    }
    harnessOptionsCache.set(cacheKey, options);
    return options;
  }

  harnessOptionsCache.set(cacheKey, null);
  return null;
}

function stripHashComments(source: string): string {
  let out = "";
  let inComment = false;
  for (const ch of source) {
    if (inComment) {
      if (ch === "\n") {
        inComment = false;
        out += ch;
      }
      continue;
    }
    if (ch === "#") {
      inComment = true;
      continue;
    }
    out += ch;
  }
  return out;
}

function hasExplicitModuleDeclaration(source: string): boolean {
  return stripHashComments(source).trimStart().startsWith("module ");
}

function inferredModuleNameFromSchema(schemaName: string): string {
  const idx = schemaName.lastIndexOf("_");
  if (idx < 0) return "default";
  return schemaName.slice(idx + 1).toLowerCase().split("_").join("::");
}

function wrapModule(moduleName: string, source: string): string {
  const cleanSource = stripHashComments(source);
  if (hasExplicitModuleDeclaration(cleanSource)) return cleanSource;
  return `module ${moduleName} {\n${cleanSource}\n}`;
}

function buildSchemaSourceFromFiles(schemaFiles: string[]): string | null {
  const parts: string[] = [];
  for (const schemaFile of schemaFiles) {
    if (!schemaFile || schemaFile === "empty") continue;
    const fullPath = path.join(ROOT_DIR, schemaFile);
    if (!fs.existsSync(fullPath)) return null;
    const schemaName = path.basename(schemaFile, ".esdl");
    parts.push(wrapModule(inferredModuleNameFromSchema(schemaName), fs.readFileSync(fullPath, "utf8")));
  }
  return parts.join("\n\n");
}

function loadSchemaFromGoldenFiles(schemaFile: string): SchemaSnapshot | null {
  const key = `golden:${schemaFile}`;
  if (schemaCache.has(key)) return schemaCache.get(key)!;
  const source = buildSchemaSourceFromFiles(schemaFile.split(";"));
  if (source === null) return null;
  try {
    const snap = loadSchemaSnapshot(source, { legacySyntaxCompat: true });
    schemaCache.set(key, snap);
    return snap;
  } catch {
    return null;
  }
}

async function loadSchemaForCase(
  sourceGroup: string,
  className: string,
  schemaFile: string,
): Promise<SchemaSnapshot | null> {
  async function schemaFromHarnessOptions(options: HarnessOptions, keyPrefix: string): Promise<SchemaSnapshot | null> {
    const key = `${keyPrefix}:${JSON.stringify(options)}`;
    if (schemaCache.has(key)) return schemaCache.get(key)!;
    try {
      const harness = await QueryHarness.create(options);
      schemaCache.set(key, harness.schema);
      return harness.schema;
    } catch {
      if (!options.setup && !options.extraSetups) return null;
      const schemaOnly = { ...options };
      delete schemaOnly.setup;
      delete schemaOnly.extraSetups;
      const schemaOnlyKey = `${keyPrefix}:schema-only:${JSON.stringify(schemaOnly)}`;
      if (schemaCache.has(schemaOnlyKey)) return schemaCache.get(schemaOnlyKey)!;
      try {
        const harness = await QueryHarness.create(schemaOnly);
        schemaCache.set(schemaOnlyKey, harness.schema);
        return harness.schema;
      } catch {
        return null;
      }
    }
  }

  const harnessOptions = parseHarnessOptions(sourceGroup, className);
  if (harnessOptions) {
    const schema = await schemaFromHarnessOptions(harnessOptions, "harness");
    if (schema) return schema;
  }

  const inferredOptions = inferHarnessOptionsFromSchemaFiles(sourceGroup);
  if (inferredOptions) {
    const schema = await schemaFromHarnessOptions(inferredOptions, "inferred");
    if (schema) return schema;
  }

  if (!schemaFile || schemaFile === "empty") {
    const key = "empty";
    if (schemaCache.has(key)) return schemaCache.get(key)!;
    const snap = loadSchemaSnapshot("", { legacySyntaxCompat: true });
    schemaCache.set(key, snap);
    return snap;
  }

  return loadSchemaFromGoldenFiles(schemaFile);
}

// Known PostgreSQL-specific patterns that differ from SQLite
const PG_PATTERNS = [
  { pattern: /\bLATERAL\b/i, note: "LATERAL JOIN (PostgreSQL)" },
  { pattern: /\bROW\(/i, note: "ROW constructor (PostgreSQL)" },
  { pattern: /\bANY\(/i, note: "ANY() (PostgreSQL)" },
  { pattern: /\bILIKE\b/i, note: "ILIKE (PostgreSQL)" },
  { pattern: /\bGENERATE_SERIES\b/i, note: "generate_series (PostgreSQL)" },
  { pattern: /\bUNNEST\b/i, note: "UNNEST (PostgreSQL)" },
  { pattern: /\bSTRING_AGG\b/i, note: "string_agg (PostgreSQL)" },
  { pattern: /\bARRAY_AGG\b/i, note: "array_agg (PostgreSQL)" },
  { pattern: /\bjson_build_object\b/i, note: "json_build_object (PostgreSQL)" },
  { pattern: /\bjson_agg\b/i, note: "json_agg (PostgreSQL)" },
  { pattern: /\bjsonb_/i, note: "jsonb (PostgreSQL)" },
  { pattern: /\bCROSS JOIN LATERAL\b/i, note: "CROSS JOIN LATERAL (PostgreSQL)" },
  { pattern: /\bJOIN LATERAL\b/i, note: "JOIN LATERAL (PostgreSQL)" },
  { pattern: /\b@> /i, note: "@> containment (PostgreSQL)" },
  { pattern: /\b<@ /i, note: "<@ containment (PostgreSQL)" },
];

function detectPgFeatures(sql: string): string[] {
  return PG_PATTERNS.filter(p => p.pattern.test(sql)).map(p => p.note);
}

// Normalize SQL for comparison: strip volatile parts
function normalizeSql(sql: string): string {
  return sql
    .replace(/<pg\.\w+ at 0x[0-9a-f]+>/g, "<pg.Node>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
    .replace(/\s+/g, " ")
    .trim();
}

// Group manifest cases by source_group -> test_name
interface GroupedCase {
  caseIndex: number;
  goldenPath: string;
  query: string | null;
  postgresSql: string | null;
  sqliteSql: string | null;
  compileError: string | null;
  pgFeatures: string[];
  sqlMatch: boolean | null;
}

describe("golden postgres_sql vs sqlite_sql comparison", () => {
  let manifest: Manifest;
  let allResults: Map<string, GroupedCase[]>; // source_group -> cases

  beforeAll(async () => {
    manifest = loadManifest();
    allResults = new Map();

    // Filter to cases that have postgres_sql
    const casesWithSql = manifest.cases.filter(c => {
      if (c.status === "error" || c.error) return false;
      const golden = loadGolden(c.output);
      return golden?.ok && golden?.postgres_sql;
    });

    console.log(`Comparing ${casesWithSql.length} golden cases with postgres_sql...`);

    let processed = 0;
    for (const mc of casesWithSql) {
      const golden = loadGolden(mc.output);
      if (!golden || !golden.postgres_sql) continue;

      // Extract source_group from output path
      const parts = mc.output.split("/");
      const sourceGroup = parts[2];

      const schemaFile = golden.schema_file;
      const schema = await loadSchemaForCase(sourceGroup, mc.class, schemaFile);

      let sqliteSql: string | null = null;
      let compileError: string | null = null;

      if (schema) {
        try {
          const result = inspect(schema, golden.query);
          if (result.ok) {
            const facts = gelFactsOf(result, { schemaFile, sourceTest: golden.source_test });
            if (facts.ok) {
              sqliteSql = facts.sqlite_sql;
            } else {
              compileError = `gelFactsOf failed`;
            }
          } else {
            compileError = result.error?.message || `compile failed (phase: ${result.error?.phase})`;
          }
        } catch (e: any) {
          compileError = e.message || String(e);
        }
      } else {
        const schemaFiles = schemaFile.split(";").filter((f) => f && f !== "empty");
        const missing = schemaFiles.some((f) => !fs.existsSync(path.join(ROOT_DIR, f)));
        compileError = missing
          ? `schema not found: ${schemaFile}`
          : `schema failed to load: ${schemaFile}`;
      }

      const pgFeatures = detectPgFeatures(golden.postgres_sql);
      let sqlMatch: boolean | null = null;
      if (sqliteSql) {
        sqlMatch = normalizeSql(sqliteSql) === normalizeSql(golden.postgres_sql);
      }

      const caseResult: GroupedCase = {
        caseIndex: mc.case_index,
        goldenPath: mc.output,
        query: golden.query,
        postgresSql: golden.postgres_sql,
        sqliteSql,
        compileError,
        pgFeatures,
        sqlMatch,
      };

      if (!allResults.has(sourceGroup)) allResults.set(sourceGroup, []);
      allResults.get(sourceGroup)!.push(caseResult);

      processed++;
      if (processed % 500 === 0) console.log(`  ...${processed}/${casesWithSql.length}`);
    }

    console.log(`Processed ${processed} cases across ${allResults.size} source groups`);
  }, 120_000);

  it("generate golden comparison markdown", () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    let totalCompared = 0;
    let totalMatched = 0;
    let totalMismatched = 0;
    let totalCompileFailed = 0;
    let totalSchemaMissing = 0;

    // Build index
    let indexMd = `# Golden SQL Comparison (Postgres vs SQLite)\n\n`;
    indexMd += `> Generated: ${new Date().toISOString()}\n\n`;
    indexMd += `> **Note:** PostgreSQL SQL and SQLite SQL are dialectally different.\n`;
    indexMd += `> Differences like LATERAL JOINs, ROW constructors, ARRAY_AGG,\n`;
    indexMd += `> jsonb operations, etc. are expected and noted.\n\n`;

    const summaryRows: [string, number, number, number, number, number][] = [];

    for (const [sourceGroup, cases] of [...allResults.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const matched = cases.filter(c => c.sqlMatch === true).length;
      const mismatched = cases.filter(c => c.sqlMatch === false).length;
      const compileFailed = cases.filter(c => c.compileError && !c.compileError.includes("schema not found")).length;
      const schemaMissing = cases.filter(c => c.compileError?.includes("schema not found")).length;

      totalCompared += cases.length;
      totalMatched += matched;
      totalMismatched += mismatched;
      totalCompileFailed += compileFailed;
      totalSchemaMissing += schemaMissing;

      // Per-file report
      let md = `# ${sourceGroup}\n\n`;
      md += `## Stats\n\n`;
      md += `| Metric | Count |\n`;
      md += `|--------|-------|\n`;
      md += `| Total goldens | ${cases.length} |\n`;
      md += `| SQL identical | ${matched} |\n`;
      md += `| SQL different | ${mismatched} |\n`;
      md += `| Compile failed | ${compileFailed} |\n`;
      md += `| Schema missing | ${schemaMissing} |\n`;
      md += `\n`;

      // Sort by test name then case index
      cases.sort((a, b) => {
        const aName = a.query || "";
        const bName = b.query || "";
        return aName.localeCompare(bName) || a.caseIndex - b.caseIndex;
      });

      md += `## Cases\n\n`;

      for (const c of cases) {
        const status = c.sqlMatch === true ? "MATCH" : c.sqlMatch === false ? "DIFF" : c.compileError ? "ERROR" : "UNKNOWN";
        const statusEmoji = status === "MATCH" ? "✅" : status === "DIFF" ? "❌" : "⚠️";

        md += `### Case ${c.caseIndex} ${statusEmoji}\n\n`;
        if (c.query) {
          md += `**Query:**\n\`\`\`edgeql\n${c.query}\n\`\`\`\n\n`;
        }

        if (c.compileError) {
          md += `**Error:** \`${c.compileError}\`\n\n`;
        }

        if (c.pgFeatures.length > 0) {
          md += `**PostgreSQL-specific features:** ${c.pgFeatures.join(", ")}\n\n`;
        }

        if (c.postgresSql && c.sqliteSql) {
          md += `<details>\n<summary>PostgreSQL SQL (golden)</summary>\n\n`;
          md += `\`\`\`sql\n${c.postgresSql}\n\`\`\`\n\n</details>\n\n`;

          md += `<details>\n<summary>SQLite SQL (sqlite-ts)</summary>\n\n`;
          md += `\`\`\`sql\n${c.sqliteSql}\n\`\`\`\n\n</details>\n\n`;
        } else if (c.postgresSql) {
          md += `**PostgreSQL SQL (golden):**\n\`\`\`sql\n${c.postgresSql}\n\`\`\`\n\n`;
        }

        md += `---\n\n`;
      }

      const fileMdName = `${sourceGroup}.md`;
      fs.writeFileSync(path.join(OUT_DIR, fileMdName), md);
      console.log(`  → ${fileMdName} (${cases.length} cases, ${matched} match, ${mismatched} diff)`);

      summaryRows.push([sourceGroup, cases.length, matched, mismatched, compileFailed, schemaMissing]);
    }

    // Add summary before per-file table
    indexMd += `## Summary\n\n`;
    indexMd += `**Totals:** ${totalCompared} goldens, ${totalMatched} identical SQL, ${totalMismatched} different SQL, ${totalCompileFailed} compile failures, ${totalSchemaMissing} missing schemas\n\n`;

    indexMd += `## Per-File Summary\n\n`;
    indexMd += `| File | Total | Match | Diff | Compile Fail | Schema Missing |\n`;
    indexMd += `|------|-------|-------|------|-------------|----------------|\n`;
    for (const [name, total, matched, mismatched, compileFailed, schemaMissing] of summaryRows) {
      indexMd += `| [${name}](./${name}.md) | ${total} | ${matched} | ${mismatched} | ${compileFailed} | ${schemaMissing} |\n`;
    }

    fs.writeFileSync(path.join(OUT_DIR, "index.md"), indexMd);
    console.log("  → index.md");

    // Summary assertion
    console.log(`\nGolden SQL comparison complete:`);
    console.log(`  Total: ${totalCompared}`);
    console.log(`  Matched: ${totalMatched}`);
    console.log(`  Different: ${totalMismatched}`);
    console.log(`  Compile failed: ${totalCompileFailed}`);
    console.log(`  Schema missing: ${totalSchemaMissing}`);
  });
});
