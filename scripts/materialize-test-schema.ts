import fs from "node:fs";
import path from "node:path";
import { openSQLite, materializeSchema } from "../src/runtime/database.js";
import { parseDeclarativeSchema } from "../src/schema/declarative.js";
import { schemaSnapshotFromDeclarative } from "../src/schema/uiSchema.js";

const inferredModuleNameFromSchema = (schemaName: string): string => {
  const idx = schemaName.lastIndexOf("_");
  if (idx < 0) {
    return "default";
  }
  return schemaName.slice(idx + 1).toLowerCase().replace(/_/g, "::");
};

const hasExplicitModuleDeclaration = (source: string): boolean => {
  const withoutComments = source.replace(/^\s*#.*$/gm, "");
  return withoutComments.trimStart().startsWith("module ");
};

const wrapModule = (moduleName: string, source: string): string => {
  if (hasExplicitModuleDeclaration(source)) {
    return source;
  }
  return `module ${moduleName} {\n${source}\n}`;
};

const loadSchemaSource = (schemaDir: string, schemaName: string): string => {
  const parts: Array<{ fileName: string; moduleName: string }> = [];
  const primaryModule = inferredModuleNameFromSchema(schemaName);
  const idx = schemaName.lastIndexOf("_");

  if (idx > 0) {
    const baseName = schemaName.slice(0, idx);
    const defaultName = `${baseName}_default`;
    if (defaultName !== schemaName) {
      const defaultPath = path.join(schemaDir, `${defaultName}.esdl`);
      if (fs.existsSync(defaultPath)) {
        parts.push({ fileName: defaultName, moduleName: "default" });
      }
    }
  }

  parts.push({ fileName: schemaName, moduleName: primaryModule });

  return parts
    .map(({ fileName, moduleName }) => {
      const p = path.join(schemaDir, `${fileName}.esdl`);
      const src = fs.readFileSync(p, "utf-8");
      return wrapModule(moduleName, src);
    })
    .join("\n\n");
};

const schemaName = process.argv[2] ?? "dump01_test";
const outputFile = process.argv[3] ?? "tests/.artifacts/dump01.sqlite";

const schemaDir = path.join(process.cwd(), "tests", "schemas");
const schemaSource = loadSchemaSource(schemaDir, schemaName);
const declarative = parseDeclarativeSchema(schemaSource);
const snapshot = schemaSnapshotFromDeclarative(declarative);

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
if (fs.existsSync(outputFile)) {
  fs.unlinkSync(outputFile);
}

const runtime = openSQLite(outputFile);
materializeSchema(runtime.db, snapshot);
runtime.close();

process.stdout.write(`Wrote SQLite schema DB to ${outputFile}\n`);
