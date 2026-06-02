import { getCompilerService, type CompilerCacheMeta } from "../compiler/service.js";
import { validateParsedStatement } from "../compiler/ast_to_ir.js";
import { AppError, asAppError } from "../errors.js";
import { decorateErrorWithUnsupportedTag } from "../diagnostics/unsupported.js";
import { parseEdgeQL, parseEdgeQLScript, type ParseEdgeQLOptions } from "../edgeql/parser.js";
import { offsetToLineCol, tokenize, type Token } from "../edgeql/tokenizer.js";
import type { BacklinkExpr, ComputedExpr, DDLStatement, DeleteStatement, FilterExpr, FilterValue, ForStatement, FreeObjectExpr, FunctionCallArgExpr, FunctionCallExpr, InsertStatement, InsertValue, OrderExpr, OrderExprChain, PathStep, SelectExprStatement, SelectStatement, ShapeElement, Statement, TypeExpr, UpdateStatement, WithBinding, WithBindingValue } from "../edgeql/ast.js";
import type { RuntimeDatabaseAdapter } from "./adapter.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { compileToSQL, computedValueAlias, shapePayloadAlias, type SQLArtifact } from "../sql/compiler.js";
import { executeStdlibFunction, resolveStdlibFunction, type RuntimeFunctionArg } from "../stdlib/functions.js";
import { assertTargetSqlCompatibility, type RuntimeTarget } from "./target.js";
import type { GroupIR, InsertIR, InsertLinkDefaultIR, InsertLinkPropertyIR, IRStatement, OverlayIR, SelectIR, SelectShapeElementIR, UpdateIR, UpdateLinkAssignmentIR } from "../ir/model.js";
import type { AccessPolicyCondition, AccessPolicyDef, ComputedLinkPropertyExpr, FieldDef, FunctionDef, FunctionExprDef, ScalarType, ScalarValue, TypeDef } from "../types.js";
import { qualifiedTypeName } from "../schema/schema.js";
import { populateSchemaIntrospection } from "../schema/schema_introspection.js";
import { materializeSchema, type SQLiteDatabase } from "../runtime/database.js";


export interface QueryResult {
  kind: "select" | "insert" | "update" | "delete";
  rows?: unknown[];
  changes?: number;
}

export interface QueryExecutionTrace {
  ast: Statement;
  ir: IRStatement;
  sql: SQLArtifact;
  compiler: CompilerCacheMeta;
  sqlTrail: SQLArtifact[];
  overlays: OverlayIR[];
  result: QueryResult;
}

export interface QueryUnitTrace {
  traces: QueryExecutionTrace[];
  result: QueryResult;
}

export interface SecurityContext {
  roleName?: string;
  isSuperuser?: boolean;
  permissions?: string[];
  globals?: Record<string, ScalarValue>;
  runtimeTarget?: RuntimeTarget;
}

const DEFAULT_SECURITY_CONTEXT: SecurityContext = {
  roleName: "default",
  isSuperuser: true,
  permissions: ["sys::perm::data_modification"],
  globals: {},
  runtimeTarget: "sqlite",
};

const countRuntimeSetCardinality = (value: unknown): number => {
  const values = typeof value === "object" && value !== null && "kind" in value
    && ((value as { kind?: unknown }).kind === "set" || (value as { kind?: unknown }).kind === "array")
    ? (value as { values?: unknown[] }).values ?? []
    : Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];

  const seenObjectIds = new Set<string>();
  let count = 0;
  for (const item of values) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === "string") {
        if (seenObjectIds.has(id)) {
          continue;
        }
        seenObjectIds.add(id);
      }
    }
    count += 1;
  }
  return count;
};

const evaluateRuntimeAggregate = (functionName: string, values: unknown[]): unknown => {
  const normalized = functionName.toLowerCase().split("::").at(-1) ?? functionName.toLowerCase();
  if (normalized === "count") {
    return countRuntimeSetCardinality(values);
  }
  const numbers = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (normalized === "sum") {
    return numbers.reduce((total, value) => total + value, 0);
  }
  if (numbers.length === 0) {
    return null;
  }
  if (normalized === "min") {
    return Math.min(...numbers);
  }
  if (normalized === "max") {
    return Math.max(...numbers);
  }
  if (normalized === "avg" || normalized === "mean") {
    return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  }
  return null;
};

const normalizeRuntimeFloat = (value: number): number => (
  Number.isFinite(value) ? Number(value.toPrecision(15)) : value
);

const runtimeExprAliases = new WeakMap<SchemaSnapshot, Map<string, string>>();

// Lists every alias known for a schema — both schema::Alias entries
// registered via schema.addAlias (typed aliases with shapes) and runtime
// expr aliases stashed in the WeakMap above (scalar/tuple-set CREATE ALIAS
// forms). Used by schema-introspection population so `SELECT schema::Type
// FILTER .name LIKE '%my_alias%'` finds aliases of either flavor.
//
// Returns alias names *and* synthetic shape-type names. EdgeDB exposes an
// alias whose body is `SELECT Card { ... }` as two entries: the alias
// itself (`default::best_card`) AND a synthetic projection type derived
// from the source (`default::__best_card__Card`). Both appear in
// `schema::Type` introspection.
export const listAllRuntimeAliasNames = (schema: SchemaSnapshot): string[] => {
  const names = new Set<string>();
  const addAliasShapeTypeName = (aliasModule: string, aliasName: string, sourceType: string): void => {
    const baseName = sourceType.includes("::") ? sourceType.split("::").pop()! : sourceType;
    names.add(`${aliasModule}::__${aliasName}__${baseName}`);
  };

  for (const alias of schema.listAliases()) {
    names.add(`${alias.module}::${alias.name}`);
    if (alias.sourceType) {
      addAliasShapeTypeName(alias.module, alias.name, alias.sourceType);
    }
  }
  const typedAliases = runtimeTypedAliases.get(schema);
  if (typedAliases) {
    for (const alias of typedAliases.values()) {
      names.add(`${alias.moduleName}::${alias.aliasName}`);
      if (alias.hasShape && alias.sourceType) {
        addAliasShapeTypeName(alias.moduleName, alias.aliasName, alias.sourceType);
      }
    }
  }
  const exprAliases = runtimeExprAliases.get(schema);
  if (exprAliases) {
    for (const key of exprAliases.keys()) {
      // Keys may be qualified (`mod::name`) or just bare names; normalize to
      // `default::name` for unqualified entries so introspection rows always
      // have a fully qualified name.
      names.add(key.includes("::") ? key : `default::${key}`);
    }
  }
  return [...names];
};

type RuntimeTypedAliasDef = {
  aliasName: string;
  moduleName: string;
  sourceType: string;
  filter?: {
    field: string;
    op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
    value: ScalarValue;
  };
  filterValues?: {
    field: string;
    values: ScalarValue[];
  };
  limit?: number;
  hasShape?: boolean;
  computedProperties?: Array<{
    name: string;
    kind: "tuple" | "array";
    fields: string[];
  }>;
  computedExistsProperties?: Array<{
    name: string;
    correlated: boolean;
    backlinkLink: string;
    targetType: string;
    field: string;
    value: ScalarValue;
  }>;
  linkOverrides: Array<{
    name: string;
    backlinkLink: string;
    targetType: string;
    computedFields: Array<{
      name: string;
      sourceField: string;
      functionName: "str_upper";
    }>;
  }>;
};

const runtimeTypedAliases = new WeakMap<SchemaSnapshot, Map<string, RuntimeTypedAliasDef>>();

const getRuntimeExprAliasMap = (schema: SchemaSnapshot): Map<string, string> => {
  const existing = runtimeExprAliases.get(schema);
  if (existing) {
    return existing;
  }

  const created = new Map<string, string>();
  runtimeExprAliases.set(schema, created);
  return created;
};

const getRuntimeTypedAliasMap = (schema: SchemaSnapshot): Map<string, RuntimeTypedAliasDef> => {
  const existing = runtimeTypedAliases.get(schema);
  if (existing) {
    return existing;
  }

  const created = new Map<string, RuntimeTypedAliasDef>();
  runtimeTypedAliases.set(schema, created);
  return created;
};

const qualifyRuntimeTypeName = (name: string, moduleName = "default"): string =>
  name.includes("::") ? name : `${moduleName}::${name}`;

const likeMatch = (value: unknown, pattern: unknown, caseInsensitive: boolean): boolean => {
  if (typeof value !== "string" || typeof pattern !== "string") return false;
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      regex += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
      continue;
    }
    if (ch === "%") {
      regex += ".*";
      continue;
    }
    if (ch === "_") {
      regex += ".";
      continue;
    }
    regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex, caseInsensitive ? "is" : "s").test(value);
};

const stripRuntimeAliasOuterParens = (input: string): string => {
  const trimmed = input.trim();
  if (!(trimmed.startsWith("(") && trimmed.endsWith(")"))) {
    return trimmed;
  }

  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0 && i < trimmed.length - 1) {
        return trimmed;
      }
    }
  }

  return trimmed.slice(1, -1).trim();
};

const parseRuntimeTypedAliasDef = (
  aliasName: string,
  exprBody: string,
  moduleName = "default",
): RuntimeTypedAliasDef | undefined => {
  const normalized = stripRuntimeAliasOuterParens(exprBody.replace(/^[ \t]*#.*$/gm, "").trim());
  const compact = normalized.replace(/\s+/g, " ").trim();

  const match = /^SELECT\s+([A-Za-z_][\w:]*)\s*\{\s*([A-Za-z_][\w]*)\s*:=\s*\(\s*SELECT\s+([A-Za-z_][\w:]*)\s*\.\s*<\s*([A-Za-z_][\w]*)\s*\[\s*IS\s+([A-Za-z_][\w:]*)\s*\]\s*\{\s*([A-Za-z_][\w]*)\s*:=\s*str_upper\s*\(\s*\.\s*([A-Za-z_][\w]*)\s*\)\s*\}\s*\)\s*\}\s*FILTER\s+([A-Za-z_][\w:]*)\s*\.\s*([A-Za-z_][\w]*)\s+LIKE\s+'([^']+)'\s*$/i.exec(compact);
  if (!match) {
    return undefined;
  }

  const [
    ,
    sourceType,
    linkName,
    backlinkSourceType,
    backlinkLink,
    targetType,
    computedFieldName,
    computedSourceField,
    filterSourceType,
    filterField,
    filterValue,
  ] = match;

  const qualifiedSourceType = qualifyRuntimeTypeName(sourceType, moduleName);
  const qualifiedBacklinkSourceType = qualifyRuntimeTypeName(backlinkSourceType, moduleName);
  const qualifiedFilterSourceType = qualifyRuntimeTypeName(filterSourceType, moduleName);

  if (qualifiedSourceType !== qualifiedBacklinkSourceType || qualifiedSourceType !== qualifiedFilterSourceType) {
    return undefined;
  }

  return {
    aliasName,
    moduleName,
    sourceType: qualifiedSourceType,
    filter: {
      field: filterField,
      op: "like",
      value: filterValue,
    },
    linkOverrides: [
      {
        name: linkName,
        backlinkLink,
        targetType: qualifyRuntimeTypeName(targetType, moduleName),
        computedFields: [
          {
            name: computedFieldName,
            sourceField: computedSourceField,
            functionName: "str_upper",
          },
        ],
      },
    ],
  };
};

const parseRuntimeAliasComputedProperties = (exprText: string): RuntimeTypedAliasDef["computedProperties"] => {
  const compact = exprText.replace(/^[ \t]*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const properties: NonNullable<RuntimeTypedAliasDef["computedProperties"]> = [];
  const tuplePattern = /\b([A-Za-z_][\w]*)\s*:=\s*\(([^)]*)\)/g;
  for (const match of compact.matchAll(tuplePattern)) {
    const fields = [...match[2].matchAll(/\.([A-Za-z_][\w]*)/g)].map((fieldMatch) => fieldMatch[1]);
    if (fields.length > 0) {
      properties.push({ name: match[1], kind: "tuple", fields });
    }
  }
  const arrayPattern = /\b([A-Za-z_][\w]*)\s*:=\s*\[([^\]]*)\]/g;
  for (const match of compact.matchAll(arrayPattern)) {
    const fields = [...match[2].matchAll(/\.([A-Za-z_][\w]*)/g)].map((fieldMatch) => fieldMatch[1]);
    if (fields.length > 0) {
      properties.push({ name: match[1], kind: "array", fields });
    }
  }
  return properties.length > 0 ? properties : undefined;
};

const parseRuntimeAliasComputedExistsProperties = (
  exprText: string,
  moduleName: string,
): RuntimeTypedAliasDef["computedExistsProperties"] => {
  const compact = exprText.replace(/^[ \t]*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const properties: NonNullable<RuntimeTypedAliasDef["computedExistsProperties"]> = [];
  const existsPattern = /\b([A-Za-z_][\w]*)\s*:=\s*EXISTS\s*\(\s*SELECT\s+((?:[A-Za-z_][\w:]*)?)\s*\.\s*<\s*([A-Za-z_][\w]*)\s*\[\s*IS\s+([A-Za-z_][\w:]*)\s*\]\s*\.\s*([A-Za-z_][\w]*)\s*=\s*'([^']+)'\s*\)/gi;
  for (const match of compact.matchAll(existsPattern)) {
    properties.push({
      name: match[1],
      correlated: match[2].length === 0,
      backlinkLink: match[3],
      targetType: qualifyRuntimeTypeName(match[4], moduleName),
      field: match[5],
      value: match[6],
    });
  }
  return properties.length > 0 ? properties : undefined;
};

const parseRuntimeAliasLinkOverrides = (exprText: string, moduleName: string): RuntimeTypedAliasDef["linkOverrides"] => {
  const compact = exprText.replace(/^[ \t]*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const overrides: RuntimeTypedAliasDef["linkOverrides"] = [];
  const linkPattern = /\b([A-Za-z_][\w]*)\s*:=\s*\(?\s*(?:SELECT\s+)?[A-Za-z_][\w:]*\s*\.\s*<\s*([A-Za-z_][\w]*)\s*\[\s*IS\s+([A-Za-z_][\w:]*)\s*\]\s*\{([^}]*)\}/gi;
  for (const match of compact.matchAll(linkPattern)) {
    const computedFields = [...match[4].matchAll(/\b([A-Za-z_][\w]*)\s*:=\s*str_upper\s*\(\s*\.\s*([A-Za-z_][\w]*)\s*\)/gi)]
      .map((fieldMatch) => ({
        name: fieldMatch[1],
        sourceField: fieldMatch[2],
        functionName: "str_upper" as const,
      }));
    overrides.push({
      name: match[1],
      backlinkLink: match[2],
      targetType: qualifyRuntimeTypeName(match[3], moduleName),
      computedFields,
    });
  }
  return overrides;
};

const splitTopLevelScriptStatements = (script: string): string[] => {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let dollarMarker: string | undefined;

  const dollarQuoteAt = (idx: number): string | undefined => {
    if (script[idx] !== "$") return undefined;
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(idx));
    return match?.[0];
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i]!;
    if (dollarMarker) {
      if (script.startsWith(dollarMarker, i)) {
        i += dollarMarker.length - 1;
        dollarMarker = undefined;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    const marker = dollarQuoteAt(i);
    if (marker) {
      dollarMarker = marker;
      i += marker.length - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === ";" && depth === 0) {
      const piece = script.slice(start, i).trim();
      if (piece) statements.push(piece);
      start = i + 1;
    }
  }

  const tail = script.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
};

const dynamicQualifiedNameParts = (rawName: string, defaultModule = "default"): { module: string; name: string; qualified: string } => {
  const name = rawName.trim();
  if (name.includes("::")) {
    const parts = name.split("::");
    const shortName = parts.pop() ?? name;
    const module = parts.join("::") || defaultModule;
    return { module, name: shortName, qualified: `${module}::${shortName}` };
  }
  return { module: defaultModule, name, qualified: `${defaultModule}::${name}` };
};

const normalizeDynamicTypeName = (rawType: string, defaultModule = "default"): string => {
  let typeName = rawType.trim().replace(/;$/, "");
  typeName = typeName.replace(/^optional\s+/i, "").replace(/^set\s+of\s+/i, "").trim();
  const lower = typeName.toLowerCase();
  if (lower.startsWith("std::")) return typeName;
  if (["str", "bool", "json", "uuid", "bytes"].includes(lower)) return `std::${lower}`;
  if (["int", "int16", "int32", "int64", "bigint"].includes(lower)) return "std::int64";
  if (["float", "float32", "float64", "decimal"].includes(lower)) return "std::float64";
  if (lower.startsWith("array<") || lower.startsWith("tuple<")) return typeName;
  return typeName.includes("::") ? typeName : `${defaultModule}::${typeName}`;
};

const dynamicScalarFromType = (rawType: string): { type: ScalarType; collection?: FieldDef["collection"] } => {
  const typeName = rawType.trim().replace(/^optional\s+/i, "").trim();
  const lower = typeName.toLowerCase();
  if (lower.startsWith("tuple<") || lower.startsWith("std::tuple<")) return { type: "json", collection: { kind: "tuple" } };
  if (lower.startsWith("array<") || lower.startsWith("std::array<")) return { type: "json", collection: { kind: "array" } };
  if (lower.endsWith("str")) return { type: "str" };
  if (lower.endsWith("bool")) return { type: "bool" };
  if (lower.endsWith("json")) return { type: "json" };
  if (lower.endsWith("uuid")) return { type: "uuid" };
  if (/int(?:16|32|64)?$|bigint$/.test(lower)) return { type: "int" };
  if (/float(?:32|64)?$|decimal$/.test(lower)) return { type: "float" };
  return { type: "str" };
};

const evaluateDefaultExprToScalar = (expr: string): ScalarValue | undefined => {
  const trimmed = expr.trim().replace(/;$/, "").trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith("'") && trimmed.endsWith("'"))
      || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+(?:e-?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  return undefined;
};

const applyParsedFunctionDDL = (schema: SchemaSnapshot, ast: DDLStatement, defaultModule = "default"): void => {
  if (!ast.functionDecl) return;
  const { module, name } = dynamicQualifiedNameParts(ast.name, defaultModule);
  const params = ast.functionDecl.params.map((param) => {
    const defaultValue = param.defaultExpr !== undefined ? evaluateDefaultExprToScalar(param.defaultExpr) : undefined;
    const hasDefaultExpr = param.defaultExpr !== undefined;
    return {
      name: param.name,
      type: normalizeDynamicTypeName(param.type, defaultModule),
      optional: Boolean(param.optional) || Boolean(param.namedOnly) || hasDefaultExpr,
      variadic: param.variadic || undefined,
      namedOnly: param.namedOnly || undefined,
      setOf: param.setOf || undefined,
      default: defaultValue,
    };
  });
  const bodyQuery = ast.functionDecl.body.query.trim();
  schema.addFunction({
    module,
    name,
    params,
    returnType: normalizeDynamicTypeName(ast.functionDecl.returnType, defaultModule),
    returnOptional: ast.functionDecl.returnOptional,
    returnSetOf: ast.functionDecl.returnSetOf,
    body: {
      kind: "query",
      language: "edgeql",
      query: /^select\b/i.test(bodyQuery) ? bodyQuery : `SELECT ${bodyQuery}`,
    },
  });
};

const registerDynamicTypeDDL = (schema: SchemaSnapshot, statement: string, defaultModule = "default"): boolean => {
  const match = /^create\s+type\s+([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)?)\s*(?:\{([\s\S]*)\})?\s*$/i.exec(statement.trim());
  if (!match) return false;
  const [, rawName, rawBody] = match;
  const { module, name } = dynamicQualifiedNameParts(rawName, defaultModule);
  const fields: FieldDef[] = [];
  const links: NonNullable<TypeDef["links"]> = [];

  for (const entry of splitTopLevelScriptStatements(rawBody ?? "")) {
    const property = /^create\s+((?:(?:required|optional|multi|single)\s+)*)property\s+([A-Za-z_][\w]*)\s*->\s*([\s\S]+)$/i.exec(entry);
    if (property) {
      const [, modifiers, fieldName, rawType] = property;
      const scalar = dynamicScalarFromType(rawType);
      fields.push({
        name: fieldName,
        type: scalar.type,
        required: /\brequired\b/i.test(modifiers),
        multi: /\bmulti\b/i.test(modifiers),
        collection: scalar.collection,
      });
      continue;
    }

    const link = /^create\s+((?:(?:required|optional|multi|single)\s+)*)link\s+([A-Za-z_][\w]*)\s*(?:->|:)\s*([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)?)$/i.exec(entry);
    if (link) {
      const [, modifiers, linkName, rawTarget] = link;
      const multi = /\bmulti\b/i.test(modifiers);
      links.push({
        name: linkName,
        targetType: normalizeDynamicTypeName(rawTarget, module),
        multi,
      });
      if (!multi) {
        fields.push({ name: `${linkName}_id`, type: "uuid" });
      }
    }
  }

  schema.addType({
    module,
    name,
    fields,
    links: links.length ? links : undefined,
  });
  return true;
};

// Pre-pass for CREATE TYPE only. CREATE FUNCTION goes through the proper
// parser → AST → runtime path (see `applyParsedFunctionDDL`).
const maybeRegisterDynamicDDLScript = (db: SQLiteDatabase, schema: SchemaSnapshot, script: string, defaultModule = "default"): boolean => {
  let registeredType = false;
  for (const statement of splitTopLevelScriptStatements(script)) {
    registeredType = registerDynamicTypeDDL(schema, statement, defaultModule) || registeredType;
  }
  if (registeredType) {
    materializeSchema(db, schema);
    getCompilerService().clear();
  }
  return registeredType;
};

const maybeHandleAliasDDLScript = (schema: SchemaSnapshot, script: string): boolean => {
  const trimmed = script.trim().replace(/;\s*$/, "");
  if (!trimmed) {
    return false;
  }

  const statements = script
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  if (statements.length > 1) {
    let handledAny = false;
    for (const statement of statements) {
      if (!maybeHandleAliasDDLScript(schema, `${statement};`)) {
        return false;
      }
      handledAny = true;
    }
    return handledAny;
  }

  if (/^set\s+module\s+/i.test(trimmed)) {
    return true;
  }

  if (/^create\s+(?:type|global|module)\b/i.test(trimmed) || /^drop\s+(?:type|global|module)\b/i.test(trimmed)) {
    return true;
  }

  const createMatch = /^create\s+alias\s+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)\s*:=\s*([\s\S]*)$/i.exec(trimmed);
  if (createMatch) {
    const [, rawAliasName, exprBody] = createMatch;
    const aliasModuleName = rawAliasName.includes("::") ? rawAliasName.split("::").slice(0, -1).join("::") : "default";
    const aliasName = rawAliasName.split("::").at(-1) ?? rawAliasName;
    const aliasKey = rawAliasName.includes("::") ? rawAliasName : aliasName;
    // Register the alias on the schema only when its body parses as a SELECT
    // statement (the form expandSchemaAliasesInStatement knows how to inline).
    // Other forms (`SELECT { (name := ...), ... }` free-object sets, scalar
    // expressions) stay on the runtime-expr-alias path so we don't shadow
    // their existing handling.
    const trimmedExprBody = exprBody.trim().replace(/;\s*$/, "");
    let probeBody = trimmedExprBody;
    while (probeBody.startsWith("(") && probeBody.endsWith(")")) {
      const inner = probeBody.slice(1, -1).trim();
      let depth = 0;
      let balanced = true;
      for (const ch of inner) {
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth < 0) { balanced = false; break; }
        }
      }
      if (!balanced || depth !== 0) break;
      probeBody = inner;
    }
    let schemaRegistrable = false;
    for (const candidate of [probeBody, `SELECT ${probeBody}`]) {
      try {
        const probe = parseEdgeQL(candidate);
        if (probe.kind === "select"
          && probe.typeName
          && (probe.shape?.some((el) => "name" in el && el.name !== "id" && (el as { origin?: string }).origin !== "default")
            || probe.filter)) {
          schemaRegistrable = true;
          break;
        }
      } catch {
        // try next form
      }
    }
    if (schemaRegistrable) {
      schema.addAlias({
        module: aliasModuleName,
        name: aliasName,
        exprText: exprBody.trim(),
      });
    }
    const typedAliases = getRuntimeTypedAliasMap(schema);
    const typedAlias = parseRuntimeTypedAliasDef(aliasName, exprBody, aliasModuleName);
    if (typedAlias) {
      typedAliases.set(aliasKey, typedAlias);
      const aliases = getRuntimeExprAliasMap(schema);
      aliases.delete(aliasKey);
      return true;
    }

    const normalizedExprBody = stripRuntimeAliasOuterParens(exprBody.trim());
    const genericTypedAlias = /^select\s+([A-Za-z_][\w:]*)\s*\{/i.exec(normalizedExprBody);
    if (genericTypedAlias) {
      typedAliases.set(aliasKey, {
        aliasName,
        moduleName: aliasModuleName,
        sourceType: qualifyRuntimeTypeName(genericTypedAlias[1], aliasModuleName),
        hasShape: true,
        limit: Number(/\blimit\s+(\d+)/i.exec(normalizedExprBody)?.[1] ?? "0") || undefined,
        computedProperties: parseRuntimeAliasComputedProperties(normalizedExprBody),
        computedExistsProperties: parseRuntimeAliasComputedExistsProperties(normalizedExprBody, aliasModuleName),
        linkOverrides: parseRuntimeAliasLinkOverrides(normalizedExprBody, aliasModuleName),
      });
      const aliases = getRuntimeExprAliasMap(schema);
      aliases.delete(aliasKey);
      return true;
    }

    const aliases = getRuntimeExprAliasMap(schema);
    const selectSetMatch = /^select\s+(\{[\s\S]*\})$/i.exec(normalizedExprBody);
    aliases.set(aliasKey, selectSetMatch ? selectSetMatch[1] : `(${normalizedExprBody})`);
    typedAliases.delete(aliasKey);
    return true;
  }

  const dropMatch = /^drop\s+alias\s+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)$/i.exec(trimmed);
  if (dropMatch) {
    const [, rawAliasName] = dropMatch;
    const aliasName = rawAliasName.split("::").at(-1) ?? rawAliasName;
    const aliasModule = rawAliasName.includes("::") ? rawAliasName.split("::").slice(0, -1).join("::") : "default";
    const aliasKey = rawAliasName.includes("::") ? rawAliasName : aliasName;
    schema.removeAlias(`${aliasModule}::${aliasName}`);
    const aliases = getRuntimeExprAliasMap(schema);
    aliases.delete(aliasKey);
    aliases.delete(aliasName);
    const typedAliases = getRuntimeTypedAliasMap(schema);
    typedAliases.delete(aliasKey);
    typedAliases.delete(aliasName);
    return true;
  }

  return false;
};

const injectRuntimeAliasBinding = (schema: SchemaSnapshot, query: string): string => {
  const aliases = runtimeExprAliases.get(schema);
  if (!aliases || aliases.size === 0) {
    return query;
  }

  const trimmed = query.trim();
  if (!/^select\s+/i.test(trimmed) || /^with\s+/i.test(trimmed)) {
    return query;
  }

  // For each expr-alias referenced in the query, inject a WITH binding so
  // the normal pipeline resolves `aliasName` and `aliasName.field` paths
  // against the alias's stored expression.
  const bindings: string[] = [];
  for (const [aliasName, expr] of aliases.entries()) {
    const referenced = new RegExp(`\\b${aliasName}\\b`).test(trimmed);
    if (referenced) {
      bindings.push(`${aliasName} := ${expr}`);
    }
  }
  if (bindings.length === 0) {
    return query;
  }
  return `WITH ${bindings.join(", ")} ${trimmed}`;
};

const runtimeAliasLikeMatches = (value: unknown, pattern: string): boolean => {
  if (typeof value !== "string") {
    return false;
  }

  if (pattern.includes("%")) {
    if (pattern.startsWith("%") && pattern.endsWith("%") && pattern.length >= 2) {
      return value.includes(pattern.slice(1, -1));
    }
    if (pattern.endsWith("%")) {
      return value.startsWith(pattern.slice(0, -1));
    }
    if (pattern.startsWith("%")) {
      return value.endsWith(pattern.slice(1));
    }
    const [left, right] = pattern.split("%", 2);
    return value.startsWith(left) && value.endsWith(right ?? "");
  }

  return value === pattern;
};

const runtimeAliasPredicateMatches = (
  value: unknown,
  op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike",
  expected: ScalarValue,
): boolean => {
  if (op === "=") {
    return value === expected;
  }
  if (op === "!=") {
    return value !== expected;
  }
  if (typeof expected !== "string") {
    const left = typeof value === "number" ? value : Number(value);
    const right = typeof expected === "number" ? expected : Number(expected);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      if (op === "<") return left < right;
      if (op === "<=") return left <= right;
      if (op === ">") return left > right;
      if (op === ">=") return left >= right;
    }
    return false;
  }
  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    if (typeof value !== "string") {
      return false;
    }
    if (op === "<") return value < expected;
    if (op === "<=") return value <= expected;
    if (op === ">") return value > expected;
    return value >= expected;
  }
  if (op === "?=") {
    return value === null || value === undefined || value === expected;
  }
  if (op === "?!=") {
    return value === null || value === undefined || value !== expected;
  }
  const left = op === "ilike" && typeof value === "string" ? value.toLowerCase() : value;
  const right = op === "ilike" ? expected.toLowerCase() : expected;
  return runtimeAliasLikeMatches(left, right);
};

const readRuntimeTypedAliasSourceRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  alias: RuntimeTypedAliasDef,
): Array<Record<string, unknown> & { __source_type: string }> => {
  const sourceTypes = schema.listConcreteTypesAssignableTo(alias.sourceType);
  const rows: Array<Record<string, unknown> & { __source_type: string }> = [];

  for (const sourceType of sourceTypes) {
    const sourceTypeName = qualifiedTypeName(sourceType);
    const table = tableNameForType(sourceTypeName);
    const selected = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[];
    for (const row of selected) {
      if (
        alias.filterValues
        && !alias.filterValues.values.some((value) => runtimeAliasPredicateMatches(row[alias.filterValues!.field], "=", value))
      ) {
        continue;
      }
      if (!alias.filterValues && alias.filter && !runtimeAliasPredicateMatches(row[alias.filter.field], alias.filter.op, alias.filter.value)) {
        continue;
      }
      rows.push({ ...row, __source_type: sourceTypeName });
    }
  }

  return rows;
};


const tryRuntimeSelectExprEvaluation = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  context: SecurityContext,
): QueryResult | undefined => {
  let ast: Statement;
  try {
    ast = parseEdgeQL(query);
  } catch {
    return undefined;
  }

  if (ast.kind !== "select_expr") {
    return undefined;
  }

  const exprContainsMutation = (expr: FreeObjectExpr): boolean => {
    if (expr.kind === "mutation_expr") return true;
    if (expr.kind === "set_expr" || expr.kind === "tuple" || expr.kind === "array_literal_expr") return expr.values.some(exprContainsMutation);
    if (expr.kind === "free_object_constructor") return expr.entries.some((entry) => exprContainsMutation(entry.expr));
    if (expr.kind === "shape_projection" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "exists" || expr.kind === "field_access" || expr.kind === "index_access" || expr.kind === "slice_access" || expr.kind === "is_type" || expr.kind === "unary" || expr.kind === "select_expr_subquery") return exprContainsMutation((expr as { expr: FreeObjectExpr }).expr);
    if (expr.kind === "compare" || expr.kind === "math" || expr.kind === "logical" || expr.kind === "coalesce" || expr.kind === "and" || expr.kind === "or") return exprContainsMutation(expr.left) || exprContainsMutation(expr.right);
    if (expr.kind === "if_else") return exprContainsMutation(expr.condition) || exprContainsMutation(expr.thenExpr) || exprContainsMutation(expr.elseExpr);
    if (expr.kind === "concat") return expr.parts.some(exprContainsMutation);
    if (expr.kind === "function_call") return expr.call.args.some((arg) => arg.kind === "expr" && exprContainsMutation(arg.expr));
    return false;
  };

  if (exprContainsMutation(ast.expr)) {
    return undefined;
  }

  // Defer to the GROUP-aware preprocessing in `executeQuery` when any WITH
  // binding holds a GROUP — the parsed-runtime evaluator can't resolve
  // synthetic group rows against `binding_ref` directly, so let
  // `preEvaluateGroupBindings` inline them first.
  if (ast.with?.some((binding) =>
    binding.value.kind === "subquery_expr"
    && (binding.value.expr.kind === "group_expr"
      || (binding.value.expr.kind === "select_expr_subquery"
        && binding.value.expr.expr.kind === "group_expr"))
  )) {
    return undefined;
  }

  return tryRuntimeSelectExprEvaluationAst(db, schema, ast, context);
};

const tryRuntimeSelectExprEvaluationAst = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Extract<Statement, { kind: "select_expr" }>,
  context: SecurityContext,
): QueryResult | undefined => {
  type EvalEnv = Map<string, unknown>;

  const needsRuntimeEval = (expr: FreeObjectExpr): boolean => {
    switch (expr.kind) {
      case "binding_ref": {
        const alias = schema.getAlias(qualifiedRuntimeAliasName(expr.name));
        return Boolean(alias?.exprText && !alias.values && !alias.sourceType);
      }
      case "function_call": {
        const shortName = expr.call.name.split("::").at(-1) ?? expr.call.name;
        const argWrapsShapedSelect = expr.call.args.some((arg) => arg.kind === "expr"
          && arg.expr.kind === "select_expr_subquery"
          && arg.expr.expr.kind === "select"
          && Array.isArray(arg.expr.expr.shape)
          && arg.expr.expr.shape.length > 1);
        if (argWrapsShapedSelect && (shortName === "assert_exists" || shortName === "assert_single" || shortName === "assert_distinct")) {
          return false;
        }
        return Boolean(schema.findFunction(ast.withModule ?? "default", shortName, expr.call.args.length))
          || ["array_unpack", "range_unpack", "range", "max", "assert_exists", "assert_single", "enumerate"].includes(shortName)
          || expr.call.args.some((arg) => arg.kind === "expr" ? needsRuntimeEval(arg.expr) : arg.kind === "function_call" ? needsRuntimeEval({ kind: "function_call", call: arg.call }) : arg.kind === "binding_ref" ? needsRuntimeEval({ kind: "binding_ref", name: arg.name }) : false);
      }
      case "for_expr":
        return true;
      case "field_access":
        return needsRuntimeEval(expr.expr);
      case "distinct":
      case "exists":
        return needsRuntimeEval(expr.expr);
      case "cast":
        return needsRuntimeEval(expr.expr);
      case "select": {
        const alias = schema.getAlias(qualifiedRuntimeAliasName(expr.typeName));
        return Boolean(alias?.values);
      }
      case "select_expr_subquery":
        if (expr.expr.kind === "shape_projection") return false;
        return Boolean(expr.orderBy) || needsRuntimeEval(expr.expr);
      case "set_expr":
      case "tuple":
        return expr.values.some((value) => needsRuntimeEval(value));
      case "math":
      case "compare":
      case "and":
      case "or":
        return needsRuntimeEval(expr.left) || needsRuntimeEval(expr.right);
      case "not":
        return needsRuntimeEval(expr.expr);
      case "if_else":
        return needsRuntimeEval(expr.thenExpr) || needsRuntimeEval(expr.condition) || needsRuntimeEval(expr.elseExpr);
      case "shape_projection":
        return needsRuntimeEval(expr.expr);
      case "index_access":
      case "is_type":
        return needsRuntimeEval(expr.expr);
      case "concat":
        // A concat containing a user-defined function call must take the
        // runtime path so the per-source-row LCP iteration handles the
        // function correctly (OPTIONAL parameters etc.).
        return expr.parts.some((part) => needsRuntimeEval(part));
      default:
        return false;
    }
  };

  const isEnumScalarTypeDef = (typeName: string | undefined): boolean => {
    if (!typeName) return false;
    const qualified = typeName.includes("::") ? typeName : qualifiedRuntimeAliasName(typeName);
    const typeDef = schema.getType(qualified) ?? schema.getType(typeName);
    if (!typeDef) return false;
    const first = typeDef.fields[0];
    return typeDef.fields.length === 1
      && first?.name === "__enum__"
      && Boolean(first?.enumValues?.length);
  };

  const bindingNeedsRuntime = (binding: WithBinding): boolean => {
    const value = binding.value;
    if (value.kind === "enum_path") return false;
    if (value.kind === "path") return !isEnumScalarTypeDef(value.head);
    if (value.kind === "path_chain") return !isEnumScalarTypeDef(value.parts?.[0]);
    if (value.kind === "binding_ref") return !isEnumScalarTypeDef(value.name);
    if (value.kind === "subquery") {
      // Defer only when the subquery has no link-property shape, AND the outer
      // query doesn't access link properties on a shape-redefined link.
      const computedHasForExpr = (expr: ComputedExpr | FreeObjectExpr | WithBindingValue | undefined): boolean => {
        if (!expr || typeof expr !== "object") return false;
        if (expr.kind === "for_expr") return true;
        if (expr.kind === "select_expr" || expr.kind === "subquery_expr" || expr.kind === "select_expr_subquery") {
          return computedHasForExpr(expr.expr);
        }
        return false;
      };
      const shapeHasForExpr = (shape: ShapeElement[] | undefined): boolean => Boolean(
        shape?.some((el) => el.kind === "computed" && computedHasForExpr(el.expr)),
      );
      if (shapeHasForExpr(value.query.shape)) return true;
      const shapeHasLinkProperty = (shape: ShapeElement[] | undefined): boolean => Boolean(
        shape?.some((el) => (el.kind === "computed" || el.kind === "field") && el.name.startsWith("@")
          || (el.kind === "link" && shapeHasLinkProperty(el.shape))
          || (el.kind === "computed" && el.expr.kind === "select_expr" && el.expr.expr.kind === "select_expr_subquery"
              && (() => {
                let inner: FreeObjectExpr = el.expr.expr;
                while (inner && inner.kind === "select_expr_subquery") inner = inner.expr;
                if (inner?.kind === "select") return shapeHasLinkProperty(inner.shape);
                return false;
              })())
        ),
      );
      if (shapeHasLinkProperty(value.query.shape)) return true;
      // Check the outer ast for link-property access on this binding name.
      const outerNeedsLinkProps = (expr: FreeObjectExpr): boolean => {
        if (!expr || typeof expr !== "object") return false;
        if (expr.kind === "shape_projection") {
          if (shapeHasLinkProperty(expr.shape)) return true;
          return outerNeedsLinkProps(expr.expr);
        }
        if (
          expr.kind === "distinct"
          || expr.kind === "cast"
          || expr.kind === "field_access"
          || expr.kind === "index_access"
          || expr.kind === "slice_access"
          || expr.kind === "exists"
          || expr.kind === "not"
          || expr.kind === "unary"
          || expr.kind === "is_type"
          || expr.kind === "select_expr_subquery"
        ) {
          return outerNeedsLinkProps(expr.expr);
        }
        return false;
      };
      if (outerNeedsLinkProps(ast.expr)) return true;
      return false;
    }
    // Defer to the regular compile path for raw path-based subqueries; the
    // runtime fallback below cannot traverse link junctions on plain paths.
    if (value.kind === "subquery_expr") {
      // Only defer when the inner is a pure field_access chain (no shape).
      let inner: FreeObjectExpr = value.expr;
      while (inner.kind === "select_expr_subquery") {
        inner = inner.expr;
      }
      if (inner.kind === "field_access") return false;
    }
    return true;
  };

  const withRequiresRuntime = (ast.with ?? []).some(bindingNeedsRuntime);
  if (!withRequiresRuntime && !needsRuntimeEval(ast.expr)) {
    return undefined;
  }

  const evalFilterValue = (value: FilterValue, env: EvalEnv): unknown => {
    if (typeof value === "object" && value !== null && "kind" in value) {
      if (value.kind === "binding_ref") {
        return env.get(value.name) ?? null;
      }
      if (value.kind === "field_ref") {
        return env.get(value.field) ?? null;
      }
      if (value.kind === "set_literal") {
        return value.values;
      }
    }
    return value;
  };

  const resolveFieldPathValue = (
    row: Record<string, unknown>,
    typeName: string | undefined,
    fieldPath: string,
  ): unknown => {
    if (!fieldPath.includes(".")) {
      return row[fieldPath];
    }
    if (!typeName) {
      return undefined;
    }
    const parts = fieldPath.split(".");
    let currentRows: Record<string, unknown>[] = [row];
    let currentType = typeName;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const linkName = parts[i];
      const nextRows: Record<string, unknown>[] = [];
      for (const r of currentRows) {
        const linkDef = findRuntimeLinkDef(schema, currentType, linkName);
        if (!linkDef) {
          return undefined;
        }
        const sourceType = schema.getType(currentType);
        if (!sourceType) return undefined;
        const targetTypeNames = normalizeLinkTargetNames(linkDef.link.targetType, sourceType.module ?? "default");
        const targetTypes = targetTypeNames.flatMap((name) => schema.listConcreteTypesAssignableTo(name));
        if (linkDef.link.multi || (linkDef.link.properties?.length ?? 0) > 0) {
          const owner = resolveLinkStorageOwner(schema, sourceType, linkDef.link);
          const linkTable = `${tableNameForType(qualifiedTypeName(owner))}__${linkDef.link.name.toLowerCase()}`;
          const linkRows = db.prepare(`SELECT ${quoteIdent("target")} FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).all(r.id as string) as Array<{ target?: unknown }>;
          for (const linkRow of linkRows) {
            if (typeof linkRow.target !== "string") continue;
            for (const targetType of targetTypes) {
              const targetTable = tableNameForType(qualifiedTypeName(targetType));
              const fetched = db.prepare(`SELECT * FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent("id")} = ?`).all(linkRow.target) as Record<string, unknown>[];
              for (const t of fetched) {
                nextRows.push(t);
              }
            }
          }
          currentType = qualifiedTypeName(targetTypes[0] ?? sourceType);
        } else {
          const targetId = r[`${linkDef.link.name}_id`];
          if (typeof targetId !== "string") continue;
          for (const targetType of targetTypes) {
            const targetTable = tableNameForType(qualifiedTypeName(targetType));
            const fetched = db.prepare(`SELECT * FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent("id")} = ?`).all(targetId) as Record<string, unknown>[];
            for (const t of fetched) {
              nextRows.push(t);
            }
          }
          currentType = qualifiedTypeName(targetTypes[0] ?? sourceType);
        }
      }
      currentRows = nextRows;
      if (currentRows.length === 0) return undefined;
    }
    const tail = parts[parts.length - 1];
    if (currentRows.length === 1) {
      return currentRows[0][tail];
    }
    return currentRows.map((r) => r[tail]);
  };

  const evalFilter = (row: Record<string, unknown>, filter: SelectStatement["filter"], env: EvalEnv, sourceTypeName?: string): boolean => {
    if (!filter) {
      return true;
    }
    if (filter.kind === "and") {
      return evalFilter(row, filter.left, env, sourceTypeName) && evalFilter(row, filter.right, env, sourceTypeName);
    }
    if (filter.kind === "or") {
      return evalFilter(row, filter.left, env, sourceTypeName) || evalFilter(row, filter.right, env, sourceTypeName);
    }
    if (filter.kind === "not") {
      return !evalFilter(row, filter.expr, env, sourceTypeName);
    }
    if (filter.kind === "free_expr") {
      const childEnv = new Map(env);
      childEnv.set("__current__", row);
      const value = evalExpr(filter.expr, childEnv);
      return Array.isArray(value) ? value.some(Boolean) : Boolean(value);
    }
    if (filter.target.kind !== "field") {
      return true;
    }
    const left = resolveFieldPathValue(row, sourceTypeName, filter.target.field);
    if (filter.kind === "in_predicate") {
      const values = filter.values.kind === "set_literal" ? filter.values.values : [];
      const hasValue = values.some((value) => value === left);
      return filter.op === "not_in" ? !hasValue : hasValue;
    }
    const right = evalFilterValue(filter.value, env);
    if (Array.isArray(left)) {
      return left.some((item) => runtimeAliasPredicateMatches(item, filter.op, right as ScalarValue));
    }
    return runtimeAliasPredicateMatches(left, filter.op, right as ScalarValue);
  };

  const evalComputedExpr = (computed: ComputedExpr, row: Record<string, unknown>, env: EvalEnv): unknown => {
    if (computed.kind === "literal") return computed.value;
    if (computed.kind === "field_ref") return row[computed.field] ?? null;
    if (computed.kind === "type_name") {
      return typeof row.__source_type === "string" ? row.__source_type : null;
    }
    if (computed.kind === "select_expr") {
      const childEnv = new Map(env);
      childEnv.set("__current__", row);
      return evalExpr(computed.expr, childEnv);
    }
    if (computed.kind === "binding_ref") {
      const bound = env.get(computed.name);
      if (bound === undefined) return null;
      if (Array.isArray(bound) && bound.length === 1) return bound[0];
      return bound;
    }
    // Other expression kinds (function_call, coalesce, math, …) — bind
    // `__current__` to the source row and delegate to the generic evaluator.
    // Without this, e.g. `Issue { z := opt_test(true, .time_estimate) }`
    // returns null for `z` because the function_call kind falls through to
    // the null default below.
    {
      const childEnv = new Map(env);
      childEnv.set("__current__", row);
      const result = evalExpr(computed as FreeObjectExpr, childEnv);
      if (result === undefined) return null;
      return result;
    }
  };

  const exprIsTupleValue = (expr: FreeObjectExpr | ComputedExpr): boolean => {
    if (expr.kind === "tuple") return true;
    if (expr.kind === "select_expr") return exprIsTupleValue(expr.expr);
    if (expr.kind === "coalesce") return exprIsTupleValue(expr.left) || exprIsTupleValue(expr.right);
    if (expr.kind === "field_access" && expr.expr.kind === "select") {
      const typeName = qualifyRuntimeTypeName(expr.expr.typeName, expr.expr.clauses._withModule ?? ast.withModule ?? "default");
      return findFieldDef(schema, typeName, expr.field)?.collection?.kind === "tuple";
    }
    return false;
  };

  const materializeShapeOnRow = (row: Record<string, unknown>, typeName: string, shape: ShapeElement[], env: EvalEnv): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const childEnv = new Map(env);
    childEnv.set("__source__", row);
    childEnv.set("__current__", row);
    childEnv.set(typeName.split("::").at(-1) ?? typeName, row);
    for (const element of shape) {
      if (element.kind === "field") {
        out[element.name] = row[element.name] ?? null;
        continue;
      }
      if (element.kind === "computed") {
        out[element.name] = evalComputedExpr(element.expr, row, childEnv);
        continue;
      }
    }
    return out;
  };

  const evalExpr = (expr: FreeObjectExpr | ComputedExpr, env: EvalEnv): unknown => {
    switch (expr.kind) {
      case "literal":
        return expr.value;
      case "field_ref": {
        const current = env.get("__current__");
        if (current && typeof current === "object" && !Array.isArray(current)) {
          return (current as Record<string, unknown>)[expr.field] ?? null;
        }
        return env.get(expr.field) ?? null;
      }
      case "select_expr":
        return evalExpr(expr.expr, env);
      case "subquery":
        return evalExpr({ kind: "select", typeName: expr.typeName, shape: expr.shape, clauses: expr.clauses }, env);
      case "type_intersection":
        return evalExpr({ kind: "is_type", expr: expr.expr, typeName: expr.sourceType, typeExpr: expr.sourceTypeExpr }, env);
      case "field_suffix_math":
        return null;
      case "global_ref":
        return context.globals?.[expr.name] ?? null;
      case "set_literal":
        return [...expr.values];
      case "set_expr":
        return expr.values.flatMap((value) => {
          const evaluated = evalExpr(value, env);
          return Array.isArray(evaluated) && !exprIsTupleValue(value) && value.kind !== "array_literal_expr" ? evaluated : [evaluated];
        });
      case "array_literal_expr":
        {
          const evaluated = expr.values.map((value) => ({
            source: value,
            value: evalExpr(value, env),
          })).map((entry) => ({
            ...entry,
            setLike: Array.isArray(entry.value) && !exprIsTupleValue(entry.source) && entry.source.kind !== "array_literal_expr",
          }));
          if (!evaluated.some((entry) => entry.setLike)) return evaluated.map((entry) => entry.value);
          const sets = evaluated.map((entry) => {
            if (!entry.setLike) return [entry.value];
            return [...(entry.value as unknown[])].sort((a, b) => String(a).localeCompare(String(b)));
          });
          return sets.reduce<unknown[][]>(
            (rows, items) => rows.flatMap((row) => items.map((item) => [...row, item])),
            [[]],
          );
        }
      case "unary": {
        const value = evalExpr(expr.expr, env);
        const apply = (item: unknown): ScalarValue => {
          if (expr.op === "not") return !(item);
          return -Number(item);
        };
        return Array.isArray(value) ? value.map(apply) : apply(value);
      }
      case "binding_ref": {
        if (env.has(expr.name)) {
          return env.get(expr.name);
        }
        if (schema.getType(qualifyRuntimeTypeName(expr.name))) {
          return evalExpr({
            kind: "select",
            typeName: expr.name,
            shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }],
            clauses: {},
          }, env);
        }
        const alias = schema.getAlias(qualifiedRuntimeAliasName(expr.name));
        if (alias?.values) {
          return [...alias.values];
        }
        if (alias?.exprText) {
          const aliasAst = parseEdgeQL(`select ${alias.exprText.replace(/;\s*$/, "")}`);
          if (aliasAst.kind === "select_expr") {
            return evalExpr(aliasAst.expr, env);
          }
        }
        return null;
      }
      case "path": {
        const value = env.get(expr.head);
        if (value === undefined && schema.getType(qualifyRuntimeTypeName(expr.head))) {
          return evalExpr({
            kind: "field_access",
            expr: { kind: "select", typeName: expr.head, shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }], clauses: {} },
            field: expr.tail,
            optional: false,
          }, env);
        }
        if (Array.isArray(value)) {
          const nextEnv = new Map(env);
          nextEnv.set("__path_tmp", value);
          return evalExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__path_tmp" }, field: expr.tail, optional: false }, nextEnv);
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(row, expr.tail)) {
            return row[expr.tail] ?? null;
          }
          const nextEnv = new Map(env);
          nextEnv.set("__path_tmp", value);
          return evalExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__path_tmp" }, field: expr.tail, optional: false }, nextEnv);
        }
        return null;
      }
      case "current_item": {
        return env.get("__current__") ?? null;
      }
      case "backlink_path": {
        const row = env.get("__current__");
        if (!row || typeof row !== "object" || Array.isArray(row)) return [];
        const r = row as Record<string, unknown>;
        const sourceTypeName = typeof r.__source_type === "string" ? r.__source_type : undefined;
        if (!sourceTypeName || typeof r.id !== "string") return [];
        const filterSource = expr.sourceType ? qualifyRuntimeTypeName(expr.sourceType) : undefined;
        const out: Record<string, unknown>[] = [];
        for (const candidate of schema.listTypes()) {
          const candidateName = qualifiedTypeName(candidate);
          if (filterSource && !schema.listConcreteTypesAssignableTo(filterSource).some((t) => qualifiedTypeName(t) === candidateName)) continue;
          const linkDef = findRuntimeLinkDef(schema, candidateName, expr.link);
          if (!linkDef) continue;
          const usesTable = Boolean(linkDef.link.multi) || (linkDef.link.properties?.length ?? 0) > 0;
          if (usesTable) {
            const owner = resolveLinkStorageOwner(schema, candidate, linkDef.link);
            const ownerTable = tableNameForType(qualifiedTypeName(owner));
            const linkTable = `${ownerTable}__${linkDef.link.name.toLowerCase()}`;
            for (const concrete of schema.listConcreteTypesAssignableTo(candidateName)) {
              const concreteName = qualifiedTypeName(concrete);
              const concreteTable = tableNameForType(concreteName);
              const rows = db.prepare(
                `SELECT s.*, j.* FROM ${quoteIdent(concreteTable)} s JOIN ${quoteIdent(linkTable)} j ON j.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE j.${quoteIdent("target")} = ?`
              ).all(r.id) as Record<string, unknown>[];
              for (const linkRow of rows) {
                const merged: Record<string, unknown> = { ...linkRow, __source_type: concreteName };
                for (const property of linkDef.link.properties ?? []) {
                  merged[`@${property.name}`] = linkRow[property.name] ?? null;
                }
                out.push(merged);
              }
            }
          } else {
            for (const concrete of schema.listConcreteTypesAssignableTo(candidateName)) {
              const concreteName = qualifiedTypeName(concrete);
              const concreteTable = tableNameForType(concreteName);
              const rows = db.prepare(`SELECT * FROM ${quoteIdent(concreteTable)} WHERE ${quoteIdent(`${linkDef.link.name}_id`)} = ?`).all(r.id) as Record<string, unknown>[];
              for (const linkRow of rows) {
                out.push({ ...linkRow, __source_type: concreteName });
              }
            }
          }
        }
        return out;
      }
      case "tuple": {
        const bindingPath = (value: FreeObjectExpr): { name: string; path: number[] } | undefined => {
          if (value.kind === "binding_ref") return { name: value.name, path: [] };
          if (value.kind === "index_access") {
            const inner = bindingPath(value.expr);
            return inner ? { name: inner.name, path: [...inner.path, value.index] } : undefined;
          }
          return undefined;
        };
        const bindingPaths = expr.values.map(bindingPath);
        const firstBinding = bindingPaths[0]?.name;
        if (firstBinding && bindingPaths.every((path) => path?.name === firstBinding)) {
          const readPath = (value: unknown, path: number[]): unknown => {
            let current = value;
            for (const index of path) {
              if (!Array.isArray(current)) return null;
              current = current[index] ?? null;
            }
            return current;
          };
          const bound = evalExpr({ kind: "binding_ref", name: firstBinding }, env);
          const items = Array.isArray(bound) ? bound : [bound];
          return items.map((item) => bindingPaths.map((path) => readPath(item, path?.path ?? [])));
        }

        // Longest-common-prefix iteration: when every slot threads through the
        // same plain `select` source, iterate per source row rather than
        // cartesian-producting each slot independently.
        const findSelectScope = (e: FreeObjectExpr): string | null => {
          if (!e || typeof e !== "object") return null;
          if (e.kind === "select") {
            // Only treat the bare `Issue`-style select as an LCP scope, not
            // a filtered subquery — those scope to a distinct subset.
            const hasClauses = e.clauses?.filter || e.clauses?.orderBy
              || e.clauses?.limit !== undefined || e.clauses?.offset !== undefined;
            if (hasClauses) return null;
            return e.typeName;
          }
          if (e.kind === "field_access") return findSelectScope(e.expr);
          if (e.kind === "coalesce" || e.kind === "compare" || e.kind === "math" || e.kind === "and" || e.kind === "or") {
            return findSelectScope(e.left) ?? findSelectScope(e.right);
          }
          if (e.kind === "select_expr_subquery") return findSelectScope(e.expr);
          if (e.kind === "cast" || e.kind === "not" || e.kind === "distinct" || e.kind === "exists") {
            return findSelectScope(e.expr);
          }
          if (e.kind === "tuple" || e.kind === "set_expr" || e.kind === "array_literal_expr") {
            for (const v of e.values) {
              const s = findSelectScope(v);
              if (s) return s;
            }
            return null;
          }
          return null;
        };

        const slotScopes = expr.values.map(findSelectScope);
        const firstScope = slotScopes.find((s) => s !== null);
        const sharesScope = Boolean(firstScope)
          && slotScopes.every((s) => s === null || s === firstScope);
        if (firstScope && sharesScope) {
          const sourceRows = evalExpr({
            kind: "select",
            typeName: firstScope,
            shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }],
            clauses: {},
          }, env);
          const rows = Array.isArray(sourceRows)
            ? sourceRows
            : sourceRows === null || sourceRows === undefined ? [] : [sourceRows];
          if (rows.length > 0) {
            const allRows: unknown[][] = [];
            for (const sourceRow of rows) {
              const rowEnv = new Map(env);
              rowEnv.set("__current__", sourceRow);
              rowEnv.set(firstScope.split("::").at(-1) ?? firstScope, sourceRow);
              const slotEvaluated = expr.values.map((value) => ({
                value: evalExpr(value, rowEnv),
                tupleLike: exprIsTupleValue(value) || value.kind === "array_literal_expr",
              }));
              // Empty slot (null / empty multi-set) suppresses the whole row:
              // tuple cardinality is the product of slot cardinalities, so any
              // zero gives 0 rows. NULL on a property is the empty set in
              // EdgeQL semantics.
              const sets = slotEvaluated.map((entry) => {
                if (entry.value === null || entry.value === undefined) return [];
                if (Array.isArray(entry.value) && !entry.tupleLike) return entry.value;
                return [entry.value];
              });
              const expanded = sets.reduce<unknown[][]>(
                (acc, items) => acc.flatMap((row) => items.map((item) => [...row, item])),
                [[]],
              );
              allRows.push(...expanded);
            }
            return allRows;
          }
        }

        const evaluated = expr.values.map((value) => ({
          value: evalExpr(value, env),
          tupleLike: exprIsTupleValue(value) || value.kind === "array_literal_expr",
        }));
        const anyArray = evaluated.some((entry) => Array.isArray(entry.value) && !entry.tupleLike);
        if (!anyArray) return evaluated.map((entry) => entry.value);
        const sets = evaluated.map((entry) => Array.isArray(entry.value) && !entry.tupleLike ? entry.value : [entry.value]);
        return sets.reduce<unknown[][]>(
          (rows, items) => rows.flatMap((row) => items.map((item) => [...row, item])),
          [[]],
        );
      }
      case "path_steps": {
        const first = expr.steps[0];
        if (!first) return [];
        let value: unknown;
        let rest: PathStep[];
        if (first.kind === "object_ref") {
          value = env.has(first.name)
            ? env.get(first.name)
            : evalExpr({ kind: "select", typeName: first.name, shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }], clauses: {} }, env);
          rest = expr.steps.slice(1);
        } else {
          value = env.get("__current__") ?? null;
          rest = expr.steps;
        }
        const matchesType = (row: unknown, typeExpr: TypeExpr): boolean => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return false;
          const sourceType = (row as Record<string, unknown>).__source_type;
          if (typeof sourceType !== "string") return false;
          const matchName = (name: string): boolean => {
            const qualified = qualifyRuntimeTypeName(name);
            return sourceType === qualified || schema.listConcreteTypesAssignableTo(qualified).some((candidate) => qualifiedTypeName(candidate) === sourceType);
          };
          if (typeExpr.kind === "type_name") return matchName(typeExpr.name);
          if (typeExpr.kind === "type_union") return matchesType(row, typeExpr.left) || matchesType(row, typeExpr.right);
          return matchesType(row, typeExpr.left) && matchesType(row, typeExpr.right);
        };
        for (const step of rest) {
          if (step.kind === "type_intersection") {
            const typeExpr = step.typeExpr ?? { kind: "type_name" as const, name: step.typeName };
            const items = Array.isArray(value) ? value : [value];
            value = items.filter((item) => matchesType(item, typeExpr));
            continue;
          }
          if (step.kind === "ptr") {
            const nextEnv = new Map(env);
            nextEnv.set("__path_tmp", value);
            value = evalExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__path_tmp" }, field: step.name, optional: step.optional }, nextEnv);
          }
        }
        return value;
      }
      case "index_access": {
        const value = evalExpr(expr.expr, env);
        const rawIndex = expr.indexExpr ? evalExpr(expr.indexExpr, env) : expr.index;
        const indexPath = Array.isArray(rawIndex) ? rawIndex.filter((item): item is number => Number.isInteger(item)) : Number.isInteger(rawIndex) ? [rawIndex as number] : [];
        // The reference EdgeQL diagnostic uses a category prefix specific to the
        // source kind: "array index", "string index", or "JSON index".
        const indexErrorCategory = (item: unknown): string => {
          if (typeof item === "string") return "string";
          if (expr.expr.kind === "function_call" && (expr.expr.call.name === "to_json" || expr.expr.call.name.endsWith("::to_json"))) return "JSON";
          if (Array.isArray(item)) return "array";
          return "array";
        };
        const checkBounds = (item: unknown, index: number): void => {
          const length = typeof item === "string" || Array.isArray(item) ? item.length : 0;
          if (index >= length || index < -length) {
            throw new AppError(
              "E_RUNTIME",
              `${indexErrorCategory(item)} index ${index} is out of bounds`,
              ast.pos?.line ?? 0,
              ast.pos?.column ?? 0,
            );
          }
        };
        const readIndex = (item: unknown): unknown => {
          let current = item;
          for (const index of indexPath) {
            if (typeof current === "string") {
              checkBounds(current, index);
              current = current[index < 0 ? current.length + index : index] ?? null;
            } else if (Array.isArray(current)) {
              checkBounds(current, index);
              current = current[index < 0 ? current.length + index : index] ?? null;
            } else {
              return null;
            }
          }
          return current;
        };
        const readOneIndex = (item: unknown, index: number): unknown => {
          const prior = indexPath.splice(0, indexPath.length, index);
          const result = readIndex(item);
          indexPath.splice(0, indexPath.length, ...prior);
          return result;
        };
        if (typeof value === "string") {
          return readIndex(value);
        }
        if (Array.isArray(value)) {
          if (indexPath.length > 1) {
            return indexPath.flatMap((index) => {
              const item = readOneIndex(value, index);
              return Array.isArray(item) && expr.expr.kind === "array_literal_expr" ? item : item == null ? [] : [item];
            });
          }
          if (value.length > 0 && Array.isArray(value[0])) {
            const sourceIsSetOfTuples = expr.expr.kind === "tuple"
              && expr.expr.values.some((slot) => {
                const slotValue = evalExpr(slot, env);
                return Array.isArray(slotValue) && !exprIsTupleValue(slot) && slot.kind !== "array_literal_expr";
              });
            if (sourceIsSetOfTuples) {
              return value.map((tup) => Array.isArray(tup) ? readIndex(tup) : tup);
            }
            // `array_literal_expr[N]` is array indexing: the source IS an
            // array (single value), and the result is its Nth element — even
            // if that element is itself a tuple/array. Distinguish from a
            // set-of-tuples expression where `.N` would project per-row.
            if (expr.expr.kind === "array_literal_expr") return readIndex(value);
            return (exprIsTupleValue(expr.expr) || expr.expr.kind === "index_access") ? readIndex(value) : value.map((tup) => Array.isArray(tup) ? readIndex(tup) : tup);
          }
          // For scalar arrays the discriminator is the source IR kind:
          //   - `binding_ref`, `current_item`, `index_access` carry a SINGLE
          //     value (a tuple slot, or a single string/number) — `[N]` is
          //     slot/char access on that single value.
          //   - `path_steps`, `field_access` (over a select) produce a SET —
          //     `[N]` applies element-wise (e.g. `X.name[0]` → first char of
          //     each name).
          if (expr.expr.kind === "binding_ref"
            || expr.expr.kind === "current_item"
            || expr.expr.kind === "index_access") {
            return readIndex(value);
          }
          return value.map(readIndex);
        }
        return null;
      }
      case "slice_access": {
        const value = evalExpr(expr.expr, env);
        const startValue = expr.startExpr ? evalExpr(expr.startExpr, env) : expr.start;
        const endValue = expr.endExpr ? evalExpr(expr.endExpr, env) : expr.end;
        const starts = Array.isArray(startValue) ? startValue.filter((item): item is number => Number.isInteger(item)) : [startValue].filter((item): item is number => Number.isInteger(item));
        const ends = Array.isArray(endValue) ? endValue.filter((item): item is number => Number.isInteger(item)) : [endValue].filter((item): item is number => Number.isInteger(item));
        const sliceOne = (source: unknown, start: number | undefined, end: number | undefined): unknown => {
          if (!Array.isArray(source) && typeof source !== "string") return null;
          return source.slice(start, end);
        };
        if (starts.length > 0) {
          return starts.map((start) => sliceOne(value, start, ends[0])).filter((item) => item !== null);
        }
        return sliceOne(value, undefined, ends[0]);
      }
      case "field_access": {
        const value = evalExpr(expr.expr, env);
        const fieldName = expr.field;
        const readOne = (item: unknown): unknown => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return null;
          }
          const row = item as Record<string, unknown>;
          const sourceTypeName = typeof row.__source_type === "string" ? row.__source_type : undefined;
          if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
            return sourceTypeName ? materializeFieldValue(schema, sourceTypeName, fieldName, row[fieldName]) : row[fieldName] ?? null;
          }
          if (sourceTypeName && !fieldName.startsWith("@") && typeof row.id === "string") {
            const linkDef = findRuntimeLinkDef(schema, sourceTypeName, fieldName);
            if (linkDef) {
              const usesTable = Boolean(linkDef.link.multi) || (linkDef.link.properties?.length ?? 0) > 0;
              const sourceType = schema.getType(sourceTypeName);
              if (usesTable && sourceType) {
                const owner = resolveLinkStorageOwner(schema, sourceType, linkDef.link);
                const ownerTable = tableNameForType(qualifiedTypeName(owner));
                const linkTable = `${ownerTable}__${linkDef.link.name.toLowerCase()}`;
                const targetTypeNames = normalizeLinkTargetNames(linkDef.link.targetType, sourceType.module ?? "default");
                const candidates = targetTypeNames.flatMap((targetTypeName) => {
                  const concrete = schema.listConcreteTypesAssignableTo(targetTypeName);
                  if (concrete.length > 0) return concrete;
                  const direct = schema.getType(targetTypeName);
                  return direct ? [direct] : [];
                });
                const targets: Record<string, unknown>[] = [];
                for (const concrete of candidates) {
                  const concreteName = qualifiedTypeName(concrete);
                  const concreteTable = tableNameForType(concreteName);
                  const rows = db.prepare(
                    `SELECT t.*, j.* FROM ${quoteIdent(concreteTable)} t JOIN ${quoteIdent(linkTable)} j ON j.${quoteIdent("target")} = t.${quoteIdent("id")} WHERE j.${quoteIdent("source")} = ?`
                  ).all(row.id) as Record<string, unknown>[];
                  for (const linkRow of rows) {
                    const merged: Record<string, unknown> = { ...linkRow, __source_type: concreteName };
                    for (const property of linkDef.link.properties ?? []) {
                      merged[`@${property.name}`] = linkRow[property.name] ?? null;
                    }
                    targets.push(merged);
                  }
                }
                return targets;
              }
              const inlineColumn = `${linkDef.link.name}_id`;
              if (Object.prototype.hasOwnProperty.call(row, inlineColumn)) {
                const targetId = row[inlineColumn];
                if (typeof targetId !== "string") return null;
                const targetTypeName = qualifyRuntimeTypeName(linkDef.link.targetType);
                const targetTable = tableNameForType(targetTypeName);
                const loaded = db.prepare(`SELECT * FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent("id")} = ?`).all(targetId)[0] as Record<string, unknown> | undefined;
                return loaded ? { ...loaded, __source_type: targetTypeName } : null;
              }
            }
          }
          const computed = sourceTypeName
            ? schema.getType(sourceTypeName)?.computeds?.find((candidate) => candidate.kind === "property" && candidate.name === fieldName)
            : undefined;
          if (computed?.kind === "property" && computed.expr.kind === "literal") {
            return computed.expr.value;
          }
          if (computed?.kind === "property" && computed.expr.kind === "set_literal") {
            return [...computed.expr.values];
          }
          if (computed?.kind === "property" && computed.expr.kind === "link_aggregate") {
            const aggregateExpr = computed.expr;
            const sourceEnv = new Map(env);
            sourceEnv.set("__computed_source__", row);
            const linked = evalExpr({
              kind: "field_access",
              expr: { kind: "binding_ref", name: "__computed_source__" },
              field: aggregateExpr.link,
              optional: false,
            }, sourceEnv);
            const linkItems = Array.isArray(linked)
              ? linked
              : linked === null || linked === undefined ? [] : [linked];
            const values = linkItems.flatMap((item) => {
              const linkEnv = new Map(env);
              linkEnv.set("__computed_link__", item);
              const value = evalExpr({
                kind: "field_access",
                expr: { kind: "binding_ref", name: "__computed_link__" },
                field: aggregateExpr.field,
                optional: false,
              }, linkEnv);
              return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
            });
            return evaluateRuntimeAggregate(aggregateExpr.functionName, values);
          }
          return null;
        };
        if (Array.isArray(value)) {
          const out: unknown[] = [];
          for (const item of value) {
            const result = readOne(item);
            if (Array.isArray(result)) out.push(...result);
            else if (result !== null && result !== undefined) out.push(result);
          }
          // EdgeQL paths return DISTINCT objects (by id). When the result
          // items are all id-bearing rows, dedupe so cross-product joins
          // collapse to set semantics.
          if (out.length > 1
            && out.every((item) => item && typeof item === "object" && !Array.isArray(item)
              && typeof (item as { id?: unknown }).id === "string")) {
            const seen = new Set<string>();
            const deduped: unknown[] = [];
            for (const item of out) {
              const id = (item as { id: string }).id;
              if (seen.has(id)) continue;
              seen.add(id);
              deduped.push(item);
            }
            return deduped;
          }
          return out;
        }
        return readOne(value);
      }
      case "function_call": {
        const qualifiedName = expr.call.name.includes("::")
          ? expr.call.name
          : resolveStdlibFunction(`std::${expr.call.name}`, expr.call.args.length)
            ? `std::${expr.call.name}`
            : `${ast.withModule ?? "default"}::${expr.call.name}`;
        const args = expr.call.args.map((arg): RuntimeFunctionArg => {
          if (arg.kind === "expr") {
            const value = evalExpr(arg.expr, env);
            // An `array_literal_expr` produces a SINGLE array value (not a
            // set), and a `tuple` produces a single tuple value — preserve
            // that distinction so user-function overload resolution can
            // accept `array<int64>` / tuple parameter types correctly.
            if (Array.isArray(value)) {
              if (arg.expr.kind === "array_literal_expr") return { kind: "array", values: value as ScalarValue[] };
              return { kind: "set", values: value as ScalarValue[] };
            }
            return value as ScalarValue;
          }
          if (arg.kind === "literal") return arg.value;
          if (arg.kind === "set_literal") return { kind: "set", values: [...arg.values] };
          if (arg.kind === "array_literal") return { kind: "array", values: [...arg.values] };
          if (arg.kind === "binding_ref") {
            const value = evalExpr({ kind: "binding_ref", name: arg.name }, env);
            return Array.isArray(value) ? { kind: "set", values: value as ScalarValue[] } : value as ScalarValue;
          }
          if (arg.kind === "function_call") {
            const value = evalExpr({ kind: "function_call", call: arg.call }, env);
            return Array.isArray(value) ? { kind: "set", values: value as ScalarValue[] } : value as ScalarValue;
          }
          if (arg.kind === "field_ref") {
            return env.get(arg.field) as ScalarValue ?? null;
          }
          return null;
        });
        // Static type hints from the AST disambiguate overloaded calls when
        // a runtime arg is empty (so its type can't be inferred from value
        // alone). E.g. `opt_test(false, Issue.time_estimate)` — when an Issue
        // has no time_estimate the runtime sees `null`, but the static type
        // is `int64`, which picks the right overload's body.
        const staticTypes = expr.call.args.map((arg) => inferStaticArgType(arg, schema, ast.withModule ?? "default"));
        // EdgeQL empty-set propagation: when a UDF exists by name+arity but
        // no overload accepts the runtime args because some non-OPTIONAL
        // parameter received an empty set, the whole call evaluates to an
        // empty set (not scalar null, which the top-level set wrapping
        // would otherwise turn into a one-row `[null]` result).
        const dividerIdx = qualifiedName.lastIndexOf("::");
        const fnModule = dividerIdx >= 0 ? qualifiedName.slice(0, dividerIdx) : (ast.withModule ?? "default");
        const fnName = dividerIdx >= 0 ? qualifiedName.slice(dividerIdx + 2) : qualifiedName;
        const anyEmpty = args.some((arg) => {
          if (arg === null || arg === undefined) return true;
          return typeof arg === "object" && "kind" in arg && arg.kind === "set" && arg.values.length === 0;
        });
        if (anyEmpty && schema.listFunctions().some((f) => f.module === fnModule && f.name === fnName)) {
          if (!resolveUserFunctionOverload(schema, fnModule, fnName, args, staticTypes)) {
            return [];
          }
        }
        return executeFunctionCall(schema, db, context, qualifiedName, args, staticTypes);
      }
      case "for_expr": {
        const iteratorValue = evalExpr(expr.iterator, env);
        const iteratorItems = Array.isArray(iteratorValue)
          ? iteratorValue
          : iteratorValue === null || iteratorValue === undefined
            ? []
            : [iteratorValue];
        const isSetProducing = (body: FreeObjectExpr): boolean => {
          if (body.kind === "select_expr_subquery") {
            if ((body.filter || body.orderBy || body.limit !== undefined || body.offset !== undefined)
              && !exprIsTupleValue(body.expr)) {
              return true;
            }
            return isSetProducing(body.expr);
          }
          if (body.kind === "select") return true;
          if (body.kind === "for_expr") return true;
          if (body.kind === "set_expr") return true;
          if (body.kind === "distinct") return isSetProducing(body.expr);
          if (body.kind === "field_access") return true;
          if (body.kind === "path_steps") return true;
          return false;
        };
        const flatten = isSetProducing(expr.body);
        return iteratorItems.flatMap((item) => {
          const nextEnv = new Map(env);
          nextEnv.set(expr.variable, item);
          const bodyValue = evalExpr(expr.body, nextEnv);
          if (!flatten) {
            return bodyValue === null || bodyValue === undefined ? [] : [bodyValue];
          }
          return Array.isArray(bodyValue) ? bodyValue : bodyValue === null || bodyValue === undefined ? [] : [bodyValue];
        });
      }
      case "free_object_constructor": {
        const record: Record<string, unknown> = {};
        for (const entry of expr.entries) {
          record[entry.name] = evalExpr(entry.expr, env);
        }
        return record;
      }
      case "math": {
        const applyMath = (l: unknown, r: unknown): number | null => {
          const ln = Number(l);
          const rn = Number(r);
          switch (expr.op) {
            case "+": return ln + rn;
            case "-": return ln - rn;
            case "*": return ln * rn;
            case "/": return normalizeRuntimeFloat(ln / rn);
            case "//": return Math.floor(ln / rn);
            case "%": return ln % rn;
            case "^": return Math.pow(ln, rn);
            default: return null;
          }
        };
        // EdgeQL co-iteration: when both sides walk a binding currently
        // bound to a set (e.g. `WITH x := {1,2,3} SELECT x * x`), the two
        // references must iterate in lockstep — `x * x` produces three
        // values (1, 4, 9), not nine. Without this, evaluating each side
        // independently yields the full Cartesian product. (The `compare`
        // case below has a similar shortcut for `?=`/`?!=`.)
        const findBindingRoot = (e: FreeObjectExpr | ComputedExpr): string | null => {
          if (!e || typeof e !== "object") return null;
          if (e.kind === "binding_ref") return e.name;
          if (e.kind === "field_access") return findBindingRoot(e.expr);
          if (e.kind === "index_access") return findBindingRoot(e.expr);
          if (e.kind === "cast") return findBindingRoot(e.expr);
          return null;
        };
        const leftRoot = findBindingRoot(expr.left);
        const rightRoot = findBindingRoot(expr.right);
        if (leftRoot && leftRoot === rightRoot && env.has(leftRoot)) {
          const bound = env.get(leftRoot);
          if (Array.isArray(bound)) {
            const rows: number[] = [];
            for (const row of bound) {
              const rowEnv: EvalEnv = new Map(env);
              rowEnv.set(leftRoot, row);
              const l = evalExpr(expr.left, rowEnv);
              const r = evalExpr(expr.right, rowEnv);
              const value = applyMath(
                Array.isArray(l) ? l[0] : l,
                Array.isArray(r) ? r[0] : r,
              );
              if (value !== null) rows.push(value);
            }
            return rows;
          }
        }
        const leftValue = evalExpr(expr.left, env);
        const rightValue = evalExpr(expr.right, env);
        const leftIsSet = Array.isArray(leftValue);
        const rightIsSet = Array.isArray(rightValue);
        if (!leftIsSet && !rightIsSet) {
          return applyMath(leftValue, rightValue);
        }
        const leftItems = leftIsSet ? leftValue : [leftValue];
        const rightItems = rightIsSet ? rightValue : [rightValue];
        const out: unknown[] = [];
        for (const l of leftItems) {
          for (const r of rightItems) {
            out.push(applyMath(l, r));
          }
        }
        return out;
      }
      case "compare": {
        // LCP iteration for `?=`/`?!=`: when both sides walk through paths
        // rooted in the same WITH binding (a multi-row set), iterate per
        // row of that binding so the two sides co-iterate rather than being
        // evaluated as independent global sets. Example:
        //   WITH I := (SELECT Issue FILTER …)
        //   SELECT I.time_estimate ?!= I.time_spent_log.spent_time
        // must produce |I| booleans, one per row, not a single global value.
        if (expr.op === "?=" || expr.op === "?!=") {
          const findBindingRoot = (e: FreeObjectExpr | ComputedExpr): string | null => {
            if (!e || typeof e !== "object") return null;
            if (e.kind === "binding_ref") return e.name;
            if (e.kind === "field_access") return findBindingRoot(e.expr);
            if (e.kind === "index_access") return findBindingRoot(e.expr);
            if (e.kind === "cast") return findBindingRoot(e.expr);
            return null;
          };
          const leftRoot = findBindingRoot(expr.left);
          const rightRoot = findBindingRoot(expr.right);
          if (leftRoot && leftRoot === rightRoot && env.has(leftRoot)) {
            const bound = env.get(leftRoot);
            if (Array.isArray(bound) && bound.length > 0) {
              const lcpIsEmpty = (v: unknown): boolean =>
                v === null || v === undefined || (Array.isArray(v) && v.length === 0);
              const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
                && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
              const out: boolean[] = [];
              for (const row of bound) {
                const subEnv = new Map(env);
                subEnv.set(leftRoot, [row]);
                const lv = evalExpr(expr.left, subEnv);
                const rv = evalExpr(expr.right, subEnv);
                const lEmpty = lcpIsEmpty(lv);
                const rEmpty = lcpIsEmpty(rv);
                if (lEmpty && rEmpty) {
                  out.push(expr.op === "?=");
                  continue;
                }
                if (lEmpty) {
                  const rItems = Array.isArray(rv) ? rv : [rv];
                  const v = expr.op === "?!=";
                  for (let i = 0; i < rItems.length; i++) out.push(v);
                  continue;
                }
                if (rEmpty) {
                  const lItems = Array.isArray(lv) ? lv : [lv];
                  const v = expr.op === "?!=";
                  for (let i = 0; i < lItems.length; i++) out.push(v);
                  continue;
                }
                const lItems = Array.isArray(lv) ? lv : [lv];
                const rItems = Array.isArray(rv) ? rv : [rv];
                for (const l of lItems) {
                  for (const r of rItems) {
                    const eq = comparable(l) === comparable(r);
                    out.push(expr.op === "?=" ? eq : !eq);
                  }
                }
              }
              return out;
            }
          }
        }

        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        const isEmpty = (v: unknown): boolean =>
          v === null || v === undefined || (Array.isArray(v) && v.length === 0);
        if (expr.op === "?=" || expr.op === "?!=") {
          const leftEmpty = isEmpty(left);
          const rightEmpty = isEmpty(right);
          if (leftEmpty && rightEmpty) return expr.op === "?=";
          if (leftEmpty) {
            // LHS empty, RHS has N elements → produce N booleans
            // (?= empty vs present = false; ?!= empty vs present = true).
            const rItems = Array.isArray(right) ? right : [right];
            const value = expr.op === "?!=";
            return Array.isArray(right) ? rItems.map(() => value) : value;
          }
          if (rightEmpty) {
            // Symmetric: RHS empty, LHS has N elements.
            const lItems = Array.isArray(left) ? left : [left];
            const value = expr.op === "?!=";
            return Array.isArray(left) ? lItems.map(() => value) : value;
          }
          const lItems = Array.isArray(left) ? left : [left];
          const rItems = Array.isArray(right) ? right : [right];
          // Compare by id for object rows so distinct JS instances of the
          // same row equate; fall back to value equality for scalars.
          const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
            && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
          const out: boolean[] = [];
          for (const l of lItems) {
            for (const r of rItems) {
              const eq = comparable(l) === comparable(r);
              out.push(expr.op === "?=" ? eq : !eq);
            }
          }
          return (Array.isArray(left) || Array.isArray(right)) ? out : out[0] ?? false;
        }
        const compareOne = (l: unknown, r: unknown): boolean => {
          if (expr.op === "=") return l === r;
          if (expr.op === "!=") return l !== r;
          if (expr.op === ">") return Number(l) > Number(r);
          if (expr.op === "<") return Number(l) < Number(r);
          if (expr.op === ">=") return Number(l) >= Number(r);
          if (expr.op === "<=") return Number(l) <= Number(r);
          if (expr.op === "like" || expr.op === "ilike") {
            return likeMatch(l, r, expr.op === "ilike");
          }
          return false;
        };
        const leftIsSet = Array.isArray(left);
        const rightIsSet = Array.isArray(right);
        // EdgeQL: any binary op with an empty-set operand produces empty set.
        if ((leftIsSet && (left as unknown[]).length === 0)
          || (rightIsSet && (right as unknown[]).length === 0)) {
          return [];
        }
        if (!leftIsSet && !rightIsSet) {
          return compareOne(left, right);
        }
        const leftItems = leftIsSet ? left : [left];
        const rightItems = rightIsSet ? right : [right];
        const out: boolean[] = [];
        for (const l of leftItems) {
          for (const r of rightItems) {
            out.push(compareOne(l, r));
          }
        }
        return out;
      }
      case "in_expr": {
        // `x IN set_of_y` — true iff `x` equals any element of the set
        // produced by evaluating `right`. EdgeQL semantics: scalar IN
        // empty-set is false (not empty). When `left` is itself set-valued,
        // emit one boolean per `left` element.
        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        const rightItems = Array.isArray(right) ? right : right === null || right === undefined ? [] : [right];
        const leftIsSet = Array.isArray(left);
        const leftItems = leftIsSet ? left : [left];
        const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
          && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
        const checkOne = (item: unknown): boolean => {
          const target = comparable(item);
          const has = rightItems.some((candidate) => comparable(candidate) === target);
          return expr.op === "not_in" ? !has : has;
        };
        if (!leftIsSet) {
          return checkOne(left);
        }
        return leftItems.map(checkOne);
      }
      case "and": {
        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        if (!Array.isArray(left) && !Array.isArray(right)) {
          return Boolean(left) && Boolean(right);
        }
        const leftItems = Array.isArray(left) ? left : [left];
        const rightItems = Array.isArray(right) ? right : [right];
        return leftItems.flatMap((l) => rightItems.map((r) => Boolean(l) && Boolean(r)));
      }
      case "or": {
        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        if (!Array.isArray(left) && !Array.isArray(right)) {
          return Boolean(left) || Boolean(right);
        }
        const leftItems = Array.isArray(left) ? left : [left];
        const rightItems = Array.isArray(right) ? right : [right];
        return leftItems.flatMap((l) => rightItems.map((r) => Boolean(l) || Boolean(r)));
      }
      case "not":
        return !(evalExpr(expr.expr, env));
      case "coalesce": {
        // LCP iteration: when both sides root in the same WITH binding (e.g.
        // `WITH X := {Priority, Status} SELECT X[IS Priority].name ??
        //  X[IS Status].name`), iterate per row of X so each element gets
        // its own LHS/RHS choice — rather than evaluating LHS globally,
        // finding it non-empty (the Priorities), and returning just those.
        const findBindingRoot = (e: FreeObjectExpr | ComputedExpr): string | null => {
          if (!e || typeof e !== "object") return null;
          if (e.kind === "binding_ref") return e.name;
          if (e.kind === "field_access") return findBindingRoot(e.expr);
          if (e.kind === "index_access") return findBindingRoot(e.expr);
          if (e.kind === "cast") return findBindingRoot(e.expr);
          if (e.kind === "path_steps") {
            const first = e.steps[0];
            return first?.kind === "object_ref" ? first.name : null;
          }
          return null;
        };
        const leftRoot = findBindingRoot(expr.left);
        const rightRoot = findBindingRoot(expr.right);
        if (leftRoot && leftRoot === rightRoot && env.has(leftRoot)) {
          const bound = env.get(leftRoot);
          if (Array.isArray(bound) && bound.length > 0) {
            const out: unknown[] = [];
            for (const row of bound) {
              const subEnv = new Map(env);
              subEnv.set(leftRoot, [row]);
              const lv = evalExpr(expr.left, subEnv);
              const lEmpty = lv === null || lv === undefined
                || (Array.isArray(lv) && lv.length === 0);
              const branch = lEmpty ? evalExpr(expr.right, subEnv) : lv;
              if (branch === null || branch === undefined) continue;
              if (Array.isArray(branch)) {
                for (const item of branch) {
                  if (item !== null && item !== undefined) out.push(item);
                }
              } else {
                out.push(branch);
              }
            }
            return out;
          }
        }
        const left = evalExpr(expr.left, env);
        const isEmpty = left === null
          || left === undefined
          || (Array.isArray(left) && left.length === 0);
        if (!isEmpty) return left;
        return evalExpr(expr.right, env);
      }
      case "concat": {
        // Longest-common-prefix iteration for `++`: when every part threads
        // through the same `select` source, evaluate per-source-row and
        // concatenate within that row. When LCP does NOT apply we return
        // undefined so the caller falls back to the legacy cross-product
        // handler.
        const findScope = (e: FreeObjectExpr): string | null => {
          if (!e || typeof e !== "object") return null;
          if (e.kind === "select") {
            const hasClauses = e.clauses?.filter || e.clauses?.orderBy
              || e.clauses?.limit !== undefined || e.clauses?.offset !== undefined;
            if (hasClauses) return null;
            return e.typeName;
          }
          if (e.kind === "field_access") return findScope(e.expr);
          if (e.kind === "cast") return findScope(e.expr);
          if (e.kind === "select_expr_subquery") return findScope(e.expr);
          if (e.kind === "coalesce") return findScope(e.left) ?? findScope(e.right);
          if (e.kind === "concat") {
            for (const p of e.parts) { const s = findScope(p); if (s) return s; }
            return null;
          }
          if (e.kind === "function_call") {
            // The function's scope is the shared scope of its non-literal
            // args. Literals contribute no scope. Mixed scopes disqualify
            // (return null) so the caller falls back to cross-product.
            let scope: string | null = null;
            for (const arg of e.call.args) {
              if (arg.kind !== "expr") continue;
              const s = findScope(arg.expr);
              if (s === null) continue;
              if (scope === null) scope = s;
              else if (scope !== s) return null;
            }
            return scope;
          }
          return null;
        };
        const partScopes = expr.parts.map(findScope);
        // Require EVERY part to have the same non-null scope. A null in any
        // part means we can't determine its source (e.g. it's a filtered
        // subquery), so falling back to the cartesian path is safer than
        // picking the wrong scope.
        const firstScope = partScopes[0];
        const sharesScope = firstScope !== null
          && partScopes.every((s) => s === firstScope);
        if (firstScope && sharesScope && !env.has(firstScope) && !env.has("__current__")) {
          const sourceRows = evalExpr({
            kind: "select",
            typeName: firstScope,
            shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }],
            clauses: {},
          }, env);
          const rows = Array.isArray(sourceRows)
            ? sourceRows
            : sourceRows === null || sourceRows === undefined ? [] : [sourceRows];
          if (rows.length > 0) {
            const out: unknown[] = [];
            for (const sourceRow of rows) {
              const rowEnv = new Map(env);
              rowEnv.set("__current__", sourceRow);
              rowEnv.set(firstScope.split("::").at(-1) ?? firstScope, sourceRow);
              let accums: string[] = [""];
              let suppressed = false;
              for (const part of expr.parts) {
                const partValue = evalExpr(part, rowEnv);
                const partItems = Array.isArray(partValue) ? partValue : [partValue];
                if (partItems.length === 0) { suppressed = true; break; }
                const next: string[] = [];
                for (const left of accums) {
                  for (const right of partItems) {
                    if (right === null || right === undefined) { suppressed = true; break; }
                    next.push(`${left}${String(right)}`);
                  }
                  if (suppressed) break;
                }
                if (suppressed) break;
                accums = next;
              }
              if (!suppressed) out.push(...accums);
            }
            return out;
          }
        }
        return undefined;
      }
      case "select": {
        const envValue = env.get(expr.typeName);
        if (envValue !== undefined) {
          if (Array.isArray(envValue)) return envValue;
          if (typeof envValue === "object" && envValue !== null) return envValue;
        }
        const alias = schema.getAlias(qualifiedRuntimeAliasName(expr.typeName));
        if (alias?.values) {
          return [...alias.values];
        }
        const sourceType = qualifyRuntimeTypeName(expr.typeName);
        let rows = readRuntimeTypedAliasSourceRows(db, schema, {
          aliasName: "__expr__",
          moduleName: sourceType.split("::")[0] ?? "default",
          sourceType,
          linkOverrides: [],
        });
        rows = rows.filter((row) => evalFilter(row, expr.clauses.filter, env, sourceType));
        if (expr.clauses.orderBy) {
          const direction = expr.clauses.orderBy.direction === "desc" ? -1 : 1;
          rows.sort((a, b) => String(a[expr.clauses.orderBy!.field] ?? "").localeCompare(String(b[expr.clauses.orderBy!.field] ?? "")) * direction);
        }
        if (expr.clauses.limit !== undefined) {
          rows = rows.slice(0, expr.clauses.limit);
        }
        if (expr.shape && expr.shape.some((el) => el.kind === "computed" || (el.kind === "field" && el.origin !== "default"))) {
          return rows.map((row) => materializeShapeOnRow(row, sourceType, expr.shape, env));
        }
        return rows;
      }
      case "cast": {
        const value = evalExpr(expr.expr, env);
        if (expr.castType === "str") {
          // `<str>{}` is empty in EdgeQL; preserve null so downstream
          // concat/?? sees emptiness rather than an empty string. For
          // arrays we map per-element so nulls propagate per-row.
          if (value === null || value === undefined) return null;
          if (Array.isArray(value)) {
            return value.map((item) => (item === null || item === undefined ? null : String(item)));
          }
          return String(value);
        }
        return value;
      }
      case "is_type": {
        const value = evalExpr(expr.expr, env);
        const typeDef = schema.getType(qualifyRuntimeTypeName(expr.typeName));
        const enumValues = typeDef?.fields.flatMap((field) => field.enumValues ?? []) ?? [];
        const checkOne = (item: unknown) => enumValues.length > 0 && typeof item === "string" && enumValues.includes(item);
        if (enumValues.length === 0) {
          const qualified = qualifyRuntimeTypeName(expr.typeName);
          const items = Array.isArray(value) ? value : [value];
          // Scalar IS type check: applies when item is a primitive value.
          const scalarTypeCheck = (item: unknown): boolean | undefined => {
            if (item === null || item === undefined) return undefined;
            if (typeof item === "object") return undefined;
            const last = expr.typeName.split("::").at(-1) ?? expr.typeName;
            const isInt = typeof item === "number" && Number.isInteger(item);
            const isFloat = typeof item === "number" && !Number.isInteger(item);
            const isStr = typeof item === "string";
            const isBool = typeof item === "boolean";
            switch (last) {
              case "anyscalar": return true;
              case "anytype": return true;
              case "anyreal": return typeof item === "number";
              case "anyint": return isInt;
              case "anyfloat": return isFloat;
              case "int64":
                return isInt;
              case "int16":
              case "int32":
                // Without static type info, can't distinguish int16/32 from int64.
                // EdgeQL `IS int16/int32` checks the static type, which defaults
                // to int64 for literals and field values.
                return false;
              case "float64":
                return isFloat;
              case "float32":
                return false;
              case "decimal":
              case "bigint":
                return false;
              case "str":
                return isStr;
              case "bool":
                return isBool;
              case "Object":
              case "BaseObject":
                return false;
              default:
                return undefined;
            }
          };
          // If all items are primitives, this is a scalar IS check — return boolean(s).
          if (items.length > 0 && items.every((item) => item !== null && item !== undefined && typeof item !== "object")) {
            const results = items.map((item) => scalarTypeCheck(item) ?? false);
            return Array.isArray(value) ? results : results[0];
          }
          return items.filter((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return false;
            const sourceType = (item as Record<string, unknown>).__source_type;
            return typeof sourceType === "string"
              && (sourceType === qualified || schema.listConcreteTypesAssignableTo(qualified).some((candidate) => qualifiedTypeName(candidate) === sourceType));
          });
        }
        return Array.isArray(value) ? value.map(checkOne) : checkOne(value);
      }
      case "select_expr_subquery": {
        const value = evalExpr(expr.expr, env);
        if (value === undefined) {
          return undefined;
        }
        if (!expr.orderBy && !expr.filter && expr.limit === undefined && expr.offset === undefined) {
          return value;
        }
        let rows = Array.isArray(value) ? [...value] : [value];
        if (expr.filter) {
          rows = rows.filter((item) => {
            const childEnv = new Map(env);
            if (expr.alias) childEnv.set(expr.alias, item);
            childEnv.set("__current__", item as Record<string, unknown>);
            const result = evalExpr(expr.filter!, childEnv);
            return Array.isArray(result) ? result.some(Boolean) : Boolean(result);
          });
        }
        if (expr.orderBy) {
          const enumOrder = enumOrderForRows(rows);
          const direction = expr.orderBy.direction === "desc" ? -1 : 1;
          rows.sort((a, b) => {
            const leftEnv = new Map(env);
            const rightEnv = new Map(env);
            if (expr.alias) {
              leftEnv.set(expr.alias, a);
              rightEnv.set(expr.alias, b);
            }
            leftEnv.set("__current__", a as Record<string, unknown>);
            rightEnv.set("__current__", b as Record<string, unknown>);
            const left = evalExpr(expr.orderBy!.expr, leftEnv);
            const right = evalExpr(expr.orderBy!.expr, rightEnv);
            const leftEnumIndex = typeof left === "string" ? enumOrder?.get(left) : undefined;
            const rightEnumIndex = typeof right === "string" ? enumOrder?.get(right) : undefined;
            if (leftEnumIndex !== undefined && rightEnumIndex !== undefined && leftEnumIndex !== rightEnumIndex) {
              return (leftEnumIndex < rightEnumIndex ? -1 : 1) * direction;
            }
            return String(left ?? "").localeCompare(String(right ?? "")) * direction;
          });
        }
        if (expr.limit !== undefined || expr.offset !== undefined) {
          const offset = expr.offset ?? 0;
          rows = expr.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + expr.limit);
        }
        return rows;
      }
      case "distinct": {
        const value = evalExpr(expr.expr, env);
        if (!Array.isArray(value)) return value;
        const seen = new Set<string>();
        return value.filter((item) => {
          const key = JSON.stringify(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      case "type_name": {
        const current = env.get("__current__");
        if (current && typeof current === "object" && !Array.isArray(current)) {
          const sourceType = (current as Record<string, unknown>).__source_type;
          if (typeof sourceType === "string") {
            return sourceType;
          }
        }
        return null;
      }
      case "polymorphic_field_ref": {
        const current = env.get("__current__");
        if (!current || typeof current !== "object" || Array.isArray(current)) {
          return null;
        }
        const row = current as Record<string, unknown>;
        const rowSourceType = typeof row.__source_type === "string" ? row.__source_type : undefined;
        if (!rowSourceType) {
          return null;
        }
        const sourceTypeQualified = qualifyRuntimeTypeName(expr.sourceType);
        const concretes = schema.listConcreteTypesAssignableTo(sourceTypeQualified).map((typeDef) => qualifiedTypeName(typeDef));
        const matches = rowSourceType === sourceTypeQualified || concretes.includes(rowSourceType);
        if (!matches) {
          return null;
        }
        return row[expr.field] ?? null;
      }
      case "shape_projection": {
        const exprAsPath = (e: FreeObjectExpr | undefined): string | undefined => {
          if (!e || typeof e !== "object") return undefined;
          if (e.kind === "field_access") {
            const inner = exprAsPath(e.expr);
            return inner ? `${inner}.${e.field}` : undefined;
          }
          if (e.kind === "index_access") {
            const inner = exprAsPath(e.expr);
            return inner ? `${inner}[${e.index}]` : undefined;
          }
          if (e.kind === "binding_ref") return `:${e.name}`;
          if (e.kind === "current_item") return ":__current__";
          return undefined;
        };
        const baseAsTupleIteration = (e: FreeObjectExpr): { tuplesPath: FreeObjectExpr; index: number } | undefined => {
          if (e.kind === "index_access") {
            return { tuplesPath: e.expr, index: e.index };
          }
          return undefined;
        };
        const tupleIter = baseAsTupleIteration(expr.expr);
        if (tupleIter) {
          const stripBindingsToCurrent = (e: FreeObjectExpr | undefined): FreeObjectExpr | undefined => {
            if (!e || typeof e !== "object") return e;
            if (e.kind === "binding_ref" && env.get(e.name) !== undefined) {
              return { kind: "current_item" } as FreeObjectExpr;
            }
            if (e.kind === "field_access") return { ...e, expr: stripBindingsToCurrent(e.expr) as FreeObjectExpr };
            if (e.kind === "index_access") return { ...e, expr: stripBindingsToCurrent(e.expr) as FreeObjectExpr };
            return e;
          };
          const tuplePathExpr = stripBindingsToCurrent(tupleIter.tuplesPath) as FreeObjectExpr;
          const tupleBasePath = exprAsPath(tuplePathExpr);
          const tuples = evalExpr(tupleIter.tuplesPath, env);
          const tupleList: unknown[] = Array.isArray(tuples) ? tuples : tuples == null ? [] : [tuples];
          const onlyTupleRows = tupleList.length > 0 && tupleList.every((t) => Array.isArray(t));
          if (onlyTupleRows && tupleBasePath) {
            const out: Record<string, unknown>[] = [];
            for (const tuple of tupleList as unknown[][]) {
              const subjectValue = tuple[tupleIter.index];
              if (!subjectValue || typeof subjectValue !== "object" || Array.isArray(subjectValue)) continue;
              const subjectRow = subjectValue as Record<string, unknown>;
              const childEnv = new Map(env);
              childEnv.set("__current__", subjectRow);
              const projected: Record<string, unknown> = { ...subjectRow };
              for (const element of expr.shape) {
                if (element.kind === "field") {
                  projected[element.name] = subjectRow[element.name] ?? null;
                } else if (element.kind === "computed") {
                  if (element.expr.kind === "field_ref") {
                    projected[element.name] = subjectRow[element.expr.field] ?? null;
                  } else {
                    const unwrappedExpr = element.expr.kind === "select_expr"
                      ? element.expr.expr
                      : element.expr as FreeObjectExpr;
                    const normalizedElemExpr = stripBindingsToCurrent(unwrappedExpr) as FreeObjectExpr;
                    const elemPath = exprAsPath(normalizedElemExpr);
                    const tupleIndexMatch = elemPath && elemPath.startsWith(`${tupleBasePath}[`) && elemPath.endsWith("]")
                      ? Number(elemPath.slice(tupleBasePath.length + 1, -1))
                      : undefined;
                    if (tupleIndexMatch !== undefined && !Number.isNaN(tupleIndexMatch)) {
                      projected[element.name] = tuple[tupleIndexMatch] ?? null;
                    } else {
                      projected[element.name] = evalExpr(element.expr as FreeObjectExpr, childEnv);
                    }
                  }
                }
              }
              out.push(projected);
            }
            return out;
          }
        }
        const value = evalExpr(expr.expr, env);
        let items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
        // EdgeQL paths return DISTINCT objects (by id). When the shape source
        // is a field_access path (e.g. `Issue.owner`), dedupe the items so the
        // projected shape isn't multiplied by the join's source cardinality.
        if (expr.expr.kind === "field_access"
          && items.length > 1
          && items.every((item) => item && typeof item === "object" && !Array.isArray(item)
            && typeof (item as { id?: unknown }).id === "string")) {
          const seen = new Set<string>();
          const deduped: unknown[] = [];
          for (const item of items) {
            const id = (item as { id: string }).id;
            if (seen.has(id)) continue;
            seen.add(id);
            deduped.push(item);
          }
          items = deduped;
        }
        // If the shape source is a WITH binding (e.g. `SELECT X { ... }` with
        // `WITH X := {...}`), rebind that name per row so the computed shape
        // sees the current row through the original binding name. Without this,
        // `X[IS …].name` in `foo := X[IS Priority].name ?? X[IS Status].name`
        // reads the entire binding for every row.
        const shapeBindingName = expr.expr.kind === "binding_ref" && env.has(expr.expr.name)
          ? expr.expr.name
          : undefined;
        const projectOne = (item: unknown): Record<string, unknown> => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return {};
          const row = item as Record<string, unknown>;
          const childEnv = new Map(env);
          childEnv.set("__current__", row);
          if (shapeBindingName) {
            childEnv.set(shapeBindingName, [row]);
          }
          const out: Record<string, unknown> = { ...row };
          for (const element of expr.shape) {
            if (element.kind === "field") {
              out[element.name] = row[element.name] ?? null;
            } else if (element.kind === "computed") {
              if (element.expr.kind === "field_ref") {
                out[element.name] = row[element.expr.field] ?? null;
              } else {
                const computedValue = evalExpr(element.expr as FreeObjectExpr, childEnv);
                // Single-cardinality computed properties (no `multi` prefix)
                // unwrap a singleton set produced by per-row LCP iteration
                // (e.g. `foo := X[IS T].name ?? X[IS U].name` evaluates to a
                // 1-element array per X; EdgeQL exposes it as a scalar).
                // Tuple/array values keep their array shape — they're single
                // values structurally — but a set wrapper around them is
                // still unwrapped.
                if (!element.multi && Array.isArray(computedValue) && computedValue.length <= 1) {
                  out[element.name] = computedValue.length === 0 ? null : computedValue[0];
                } else if (element.multi && !Array.isArray(computedValue)) {
                  // Explicit `multi` cardinality wraps a scalar into a singleton
                  // array (matches `assert_query_result`'s expectation).
                  out[element.name] = computedValue == null ? [] : [computedValue];
                } else {
                  out[element.name] = computedValue;
                }
              }
            } else if (element.kind === "link") {
              const linkValue = row[element.name];
              const linkItems = Array.isArray(linkValue) ? linkValue : linkValue == null ? [] : [linkValue];
              const projected = linkItems.map((linkItem) => {
                if (!linkItem || typeof linkItem !== "object" || Array.isArray(linkItem)) return null;
                const linkRow = linkItem as Record<string, unknown>;
                const inner: Record<string, unknown> = {};
                for (const innerEl of element.shape) {
                  if (innerEl.kind === "field") {
                    inner[innerEl.name] = linkRow[innerEl.name] ?? null;
                  } else if (innerEl.kind === "computed") {
                    if (innerEl.expr.kind === "field_ref") {
                      inner[innerEl.name] = linkRow[innerEl.expr.field] ?? null;
                    } else {
                      const linkChildEnv = new Map(childEnv);
                      linkChildEnv.set("__current__", linkRow);
                      inner[innerEl.name] = evalExpr(innerEl.expr as FreeObjectExpr, linkChildEnv);
                    }
                  }
                }
                return inner;
              }).filter((entry): entry is Record<string, unknown> => entry !== null);
              const wantsMulti = Array.isArray(linkValue) && linkValue.length > 1;
              out[element.name] = wantsMulti ? projected : (projected[0] ?? null);
            }
          }
          return out;
        };
        return Array.isArray(value) ? items.map(projectOne) : projectOne(value);
      }
      default:
        return undefined;
    }
  };

  const enumOrderForRows = (rows: unknown[]): Map<string, number> | undefined => {
    if (!rows.every((item) => typeof item === "string")) {
      return undefined;
    }
    const values = rows as string[];
    for (const typeDef of schema.listTypes()) {
      const enumValues = typeDef.fields.flatMap((field) => field.enumValues ?? []);
      if (enumValues.length > 0 && values.every((value) => enumValues.includes(value))) {
        return new Map(enumValues.map((value, index) => [value, index] as const));
      }
    }
    return undefined;
  };

  const enumOrderForCast = (castType: string): Map<string, number> | undefined => {
    const typeDef = schema.getType(qualifyRuntimeTypeName(castType));
    const values = typeDef?.fields.flatMap((field) => field.enumValues ?? []) ?? [];
    return values.length > 0 ? new Map(values.map((value, index) => [value, index] as const)) : undefined;
  };

  const initialEnv = new Map<string, unknown>();
  const evalWithBindingValue = (value: WithBindingValue, env: EvalEnv): unknown => {
    switch (value.kind) {
      case "literal":
        return value.value;
      case "set_literal":
      case "array_literal":
        return [...value.values];
      case "binding_ref":
        return evalExpr({ kind: "binding_ref", name: value.name }, env);
      case "parameter":
        return context.globals?.[value.name] ?? null;
      case "subquery":
        return evalExpr({ kind: "select", typeName: value.query.typeName, shape: value.query.shape, clauses: value.query.clauses }, env);
      case "subquery_statement":
        return executeMutationBinding(db, schema, value.statement, context);
      case "subquery_expr": {
        let innerSelectExpr: FreeObjectExpr = value.expr;
        while (innerSelectExpr.kind === "select_expr_subquery") {
          innerSelectExpr = innerSelectExpr.expr;
        }
        if (innerSelectExpr.kind === "select") {
          const projected = evalExpr(value.expr, env);
          const base = evalExpr({
            ...innerSelectExpr,
            shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
          }, env);
          const baseItems = Array.isArray(base) ? base : base === null || base === undefined ? [] : [base];
          const projectedItems = Array.isArray(projected) ? projected : projected === null || projected === undefined ? [] : [projected];
          return projectedItems.map((item, index) => {
            const baseItem = baseItems[index];
            return baseItem && typeof baseItem === "object" && !Array.isArray(baseItem)
              && item && typeof item === "object" && !Array.isArray(item)
              ? { ...(baseItem as Record<string, unknown>), ...(item as Record<string, unknown>) }
              : item;
          });
        }
        if (value.expr.kind === "shape_projection") {
          const base = evalExpr(value.expr.expr, env);
          const projected = evalExpr(value.expr, env);
          const baseItems = Array.isArray(base) ? base : base === null || base === undefined ? [] : [base];
          const projectedItems = Array.isArray(projected) ? projected : projected === null || projected === undefined ? [] : [projected];
          return projectedItems.map((item, index) => {
            const baseItem = baseItems[index];
            return baseItem && typeof baseItem === "object" && !Array.isArray(baseItem)
              && item && typeof item === "object" && !Array.isArray(item)
              ? { ...(baseItem as Record<string, unknown>), ...(item as Record<string, unknown>) }
              : item;
          });
        }
        return evalExpr(value.expr, env);
      }
      case "enum_path":
        return value.member;
      case "path":
        return evalExpr({ kind: "path", head: value.head, tail: value.tail, steps: value.steps }, env);
      case "path_chain":
        return evalExpr({ kind: "path_chain", parts: value.parts, steps: value.steps }, env);
      case "backlink_path":
        return evalExpr({ kind: "backlink_path", link: value.link, sourceType: value.sourceType, sourceTypeExpr: value.sourceTypeExpr }, env);
    }
  };
  for (const binding of ast.with ?? []) {
    initialEnv.set(binding.name, evalWithBindingValue(binding.value, initialEnv));
  }

  const value = evalExpr(ast.expr, initialEnv);
  if (value === undefined) {
    return undefined;
  }
  const projectToShape = (item: unknown, shape: ShapeElement[]): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const element of shape) {
      if ("name" in element) {
        out[element.name] = row[element.name] ?? null;
      }
    }
    return out;
  };
  const finalShape = ast.expr.kind === "shape_projection"
    ? ast.expr.shape
    : ast.expr.kind === "select_expr_subquery" && ast.expr.expr.kind === "shape_projection"
      ? ast.expr.expr.shape
      : undefined;
  const currentBinding = ast.expr.kind === "binding_ref"
    ? ast.expr.name
    : ast.expr.kind === "select_expr_subquery" && ast.expr.alias
      ? ast.expr.alias
      : undefined;
  const topIsArrayAgg = ast.expr.kind === "function_call"
    && ((ast.expr.call.name.includes("::") ? ast.expr.call.name.split("::").at(-1) : ast.expr.call.name)?.toLowerCase() === "array_agg");
  const rows = Array.isArray(value) ? (topIsArrayAgg ? [value] : value) : [value];
  if (ast.orderBy) {
    type OrderKey = { expr: FreeObjectExpr; direction: number; enumOrder?: Map<string, number> };
    const orderKeys: OrderKey[] = [];
    let cursor: typeof ast.orderBy | undefined = ast.orderBy;
    while (cursor) {
      orderKeys.push({
        expr: cursor.expr,
        direction: cursor.direction === "desc" ? -1 : 1,
        enumOrder: cursor.expr.kind === "cast"
          ? enumOrderForCast(cursor.expr.castType)
          : cursor.expr.kind === "binding_ref"
            ? enumOrderForRows(rows)
            : undefined,
      });
      cursor = cursor.then;
    }

    rows.sort((a, b) => {
      const leftEnv = new Map(initialEnv);
      const rightEnv = new Map(initialEnv);
      if (currentBinding) {
        leftEnv.set(currentBinding, a);
        rightEnv.set(currentBinding, b);
      }
      leftEnv.set("__current__", a as Record<string, unknown>);
      rightEnv.set("__current__", b as Record<string, unknown>);
      for (const key of orderKeys) {
        const tupleBindingIndex = key.expr.kind === "binding_ref"
          && ast.expr.kind === "tuple"
          && ast.expr.values[0]?.kind === "binding_ref"
          && ast.expr.values[0].name === key.expr.name
          ? 0
          : undefined;
        const left = tupleBindingIndex !== undefined && Array.isArray(a) ? a[tupleBindingIndex] : evalExpr(key.expr, leftEnv);
        const right = tupleBindingIndex !== undefined && Array.isArray(b) ? b[tupleBindingIndex] : evalExpr(key.expr, rightEnv);
        const leftEnumIndex = typeof left === "string" ? key.enumOrder?.get(left) : undefined;
        const rightEnumIndex = typeof right === "string" ? key.enumOrder?.get(right) : undefined;
        if (leftEnumIndex !== undefined && rightEnumIndex !== undefined && leftEnumIndex !== rightEnumIndex) {
          return (leftEnumIndex < rightEnumIndex ? -1 : 1) * key.direction;
        }
        if (typeof left === "number" && typeof right === "number") {
          if (left !== right) {
            return (left < right ? -1 : 1) * key.direction;
          }
          continue;
        }
        const cmp = String(left ?? "").localeCompare(String(right ?? ""));
        if (cmp !== 0) {
          return cmp * key.direction;
        }
      }
      return 0;
    });
  }
  const finalRows = finalShape ? rows.map((row) => projectToShape(row, finalShape)) : rows;
  return {
    kind: "select",
    rows: finalRows,
  };
};

// Schema-introspection bypass helpers (parser-driven).
//
// The `trySchema*` / `tryRuntime*` helpers below pattern-match a small set of
// schema-introspection query shapes and serve them from in-memory snapshots
// because the IR/SQL path doesn't fully lower them yet. They used to inspect
// the raw query string with regex; these helpers parse the query once via
// `parseEdgeQL` and traverse the AST instead, so whitespace, comments, casing
// and quoting variations all flow through the real tokenizer.

const tryParseStatement = (query: string): Statement | undefined => {
  try {
    return parseEdgeQL(query);
  } catch {
    return undefined;
  }
};

const tryTokenize = (query: string): Token[] | undefined => {
  try {
    return tokenize(query);
  } catch {
    return undefined;
  }
};

// True when `tokens` contain a `module::typeName` sequence (case-insensitive on
// the names — kept lowercase by the tokenizer's `lower` field).
const tokensIncludeQualifiedName = (
  tokens: readonly Token[] | undefined,
  module: string,
  typeName: string,
): boolean => {
  if (!tokens) return false;
  const m = module.toLowerCase();
  const t = typeName.toLowerCase();
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (
      tokens[i]!.lower === m
      && tokens[i + 1]!.kind === "coloncolon"
      && tokens[i + 2]!.lower === t
    ) {
      return true;
    }
  }
  return false;
};

// True when `tokens` contain a `WITH MODULE <module>` clause followed (anywhere
// later) by a bare `SELECT <typeName>` mention.
const tokensIncludeWithModuleSelect = (
  tokens: readonly Token[] | undefined,
  module: string,
  typeName: string,
): boolean => {
  if (!tokens) return false;
  const m = module.toLowerCase();
  const t = typeName.toLowerCase();
  let withSchemaAt = -1;
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind === "kw_with"
      && tokens[i + 1]!.kind === "kw_module"
      && tokens[i + 2]!.lower === m
    ) {
      withSchemaAt = i + 3;
      break;
    }
  }
  if (withSchemaAt < 0) return false;
  for (let i = withSchemaAt; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind === "kw_select" && tokens[i + 1]!.lower === t) {
      return true;
    }
  }
  return false;
};

// True when `tokens` contain a SELECT immediately followed by the given
// punctuation kind (`lbracket` for array literals, `lparen` for tuple /
// parenthesized expressions).
const tokensHaveSelectFollowedBy = (
  tokens: readonly Token[] | undefined,
  followKind: Token["kind"],
): boolean => {
  if (!tokens) return false;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind === "kw_select" && tokens[i + 1]!.kind === followKind) {
      return true;
    }
  }
  return false;
};

// True when `tokens` contain `<TARGET [IS module::typeName]` — i.e. a backlink
// with a target-side type intersection on a specific schema:: type.
const tokensIncludeBacklinkTargetIntersection = (
  tokens: readonly Token[] | undefined,
  module: string,
  typeName: string,
): boolean => {
  if (!tokens) return false;
  const m = module.toLowerCase();
  const t = typeName.toLowerCase();
  for (let i = 0; i + 6 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind === "backward_link"
      && tokens[i + 1]!.lower === "target"
      && tokens[i + 2]!.kind === "lbracket"
      && tokens[i + 3]!.kind === "kw_is"
      && tokens[i + 4]!.lower === m
      && tokens[i + 5]!.kind === "coloncolon"
      && tokens[i + 6]!.lower === t
    ) {
      return true;
    }
  }
  return false;
};

// True when `tokens` contain `[IS module::typeName]` for any of the listed
// type names.
const tokensIncludeTypeIntersection = (
  tokens: readonly Token[] | undefined,
  module: string,
  typeNames: readonly string[],
): boolean => {
  if (!tokens) return false;
  const m = module.toLowerCase();
  const targets = new Set(typeNames.map((n) => n.toLowerCase()));
  for (let i = 0; i + 5 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind === "lbracket"
      && tokens[i + 1]!.kind === "kw_is"
      && tokens[i + 2]!.lower === m
      && tokens[i + 3]!.kind === "coloncolon"
      && targets.has(tokens[i + 4]!.lower)
      && tokens[i + 5]!.kind === "rbracket"
    ) {
      return true;
    }
  }
  return false;
};

// True when `tokens` contain the given identifier as a standalone word, not
// chained off another name (e.g. ignores `mod::Function` when searching for
// `Function`, but matches a bare `Function`).
const tokensContainBareWord = (
  tokens: readonly Token[] | undefined,
  word: string,
): boolean => {
  if (!tokens) return false;
  const lower = word.toLowerCase();
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]!.lower !== lower) continue;
    const prev = tokens[i - 1];
    if (prev && (prev.kind === "coloncolon" || prev.kind === "dot" || prev.kind === "at")) {
      continue;
    }
    return true;
  }
  return false;
};

const tokensIncludeWithModule = (
  tokens: readonly Token[] | undefined,
  moduleName: string,
): boolean => {
  if (!tokens) return false;
  const m = moduleName.toLowerCase();
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind === "kw_with"
      && tokens[i + 1]!.kind === "kw_module"
      && tokens[i + 2]!.lower === m
    ) {
      return true;
    }
  }
  return false;
};

// True when the token stream contains an `@<name>` reference. Used by the
// schema bypass to spot link-property projections (e.g. `@value`,
// `@target`).
const tokensIncludeAtIdentifier = (
  tokens: readonly Token[] | undefined,
  name: string,
): boolean => {
  if (!tokens) return false;
  const lower = name.toLowerCase();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind === "at" && tokens[i + 1]!.lower === lower) return true;
  }
  return false;
};

// Match a `.a.b.c` dot-path starting at `tokens[from]`. Returns the index of
// the last consumed path token (so callers can resume scanning after it), or
// -1 if the path doesn't match.
const matchDotPath = (
  tokens: readonly Token[],
  from: number,
  path: readonly string[],
): number => {
  if (path.length === 0) return -1;
  let i = from;
  for (let step = 0; step < path.length; step += 1) {
    if (tokens[i]?.kind !== "dot") return -1;
    if (tokens[i + 1]?.lower !== path[step]!.toLowerCase()) return -1;
    i += 2;
  }
  return i - 1;
};

// True when `tokens` contain `<kw_exists> .<a>.<b>...` anywhere.
const tokensIncludeExistsPath = (
  tokens: readonly Token[] | undefined,
  path: readonly string[],
): boolean => {
  if (!tokens) return false;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind !== "kw_exists") continue;
    if (matchDotPath(tokens, i + 1, path) >= 0) return true;
  }
  return false;
};

// True when `tokens` contain `<kw_filter> ... <kw_exists> .<path>`. Matches
// the same shape as `EXISTS .path` but only when it sits inside a FILTER
// clause — the schema bypass uses this to distinguish top-level filters from
// EXISTS occurrences inside shape expressions.
const tokensIncludeFilterExistsPath = (
  tokens: readonly Token[] | undefined,
  path: readonly string[],
): boolean => {
  if (!tokens) return false;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]!.kind !== "kw_filter") continue;
    for (let j = i + 1; j + 1 < tokens.length; j += 1) {
      if (tokens[j]!.kind !== "kw_exists") continue;
      if (matchDotPath(tokens, j + 1, path) >= 0) return true;
    }
  }
  return false;
};

// True when `tokens` contain `ORDER BY .<field>`.
const tokensIncludeOrderByDotField = (
  tokens: readonly Token[] | undefined,
  field: string,
): boolean => {
  if (!tokens) return false;
  const lower = field.toLowerCase();
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind === "kw_order"
      && tokens[i + 1]!.kind === "kw_by"
      && tokens[i + 2]!.kind === "dot"
      && tokens[i + 3]!.lower === lower
    ) {
      return true;
    }
  }
  return false;
};

// True when `tokens` contain `'<literal>' IN .<path>` — used to detect the
// `FILTER 'std::title' IN .properties.annotations.name` shape the parser
// can't represent as a structured FilterExpr.
const tokensIncludeStringInDotPath = (
  tokens: readonly Token[] | undefined,
  literal: string,
  path: readonly string[],
): boolean => {
  if (!tokens) return false;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind !== "string") continue;
    if (decodeStringLexeme(tokens[i]!.lexeme) !== literal) continue;
    if (tokens[i + 1]!.kind !== "kw_in") continue;
    if (matchDotPath(tokens, i + 2, path) >= 0) return true;
  }
  return false;
};

// Quoted-string literal lexemes carry their surrounding quotes. Strip them so
// callers can compare against the user-facing value. Handles the common
// `'...'` and `"..."` cases EdgeQL emits — bytes / interpolated literals
// don't appear in the bypass paths.
const decodeStringLexeme = (lexeme: string): string => {
  if (lexeme.length >= 2) {
    const first = lexeme[0]!;
    const last = lexeme[lexeme.length - 1]!;
    if ((first === "'" && last === "'") || (first === "\"" && last === "\"")) {
      return lexeme.slice(1, -1).replace(/\\(['"\\])/g, "$1");
    }
  }
  return lexeme;
};

// Find `.<field> LIKE '<literal>'` and return the literal.
const extractDotFieldLikeLiteral = (
  tokens: readonly Token[] | undefined,
  field: string,
): string | undefined => {
  if (!tokens) return undefined;
  const lower = field.toLowerCase();
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind === "dot"
      && tokens[i + 1]!.lower === lower
      && tokens[i + 2]!.kind === "kw_like"
      && tokens[i + 3]!.kind === "string"
    ) {
      return decodeStringLexeme(tokens[i + 3]!.lexeme);
    }
  }
  return undefined;
};

// Collect every `.<field> = '<literal>'` literal in the token stream.
const extractDotFieldEqualsLiterals = (
  tokens: readonly Token[] | undefined,
  field: string,
): string[] => {
  if (!tokens) return [];
  const lower = field.toLowerCase();
  const out: string[] = [];
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind === "dot"
      && tokens[i + 1]!.lower === lower
      && tokens[i + 2]!.kind === "equals"
      && tokens[i + 3]!.kind === "string"
    ) {
      out.push(decodeStringLexeme(tokens[i + 3]!.lexeme));
    }
  }
  return out;
};

// Match `FILTER .name IN { 'a', 'b', ... }` and return the literal strings.
const extractFilterNameInSetLiterals = (
  tokens: readonly Token[] | undefined,
): string[] | undefined => {
  if (!tokens) return undefined;
  for (let i = 0; i + 4 < tokens.length; i += 1) {
    if (tokens[i]!.kind !== "kw_filter") continue;
    if (tokens[i + 1]!.kind !== "dot") continue;
    if (tokens[i + 2]!.lower !== "name") continue;
    if (tokens[i + 3]!.kind !== "kw_in") continue;
    if (tokens[i + 4]!.kind !== "lbrace") continue;
    const out: string[] = [];
    let depth = 1;
    for (let j = i + 5; j < tokens.length; j += 1) {
      const tk = tokens[j]!;
      if (tk.kind === "lbrace") depth += 1;
      else if (tk.kind === "rbrace") {
        depth -= 1;
        if (depth === 0) return out;
      } else if (depth === 1 && tk.kind === "string") {
        out.push(decodeStringLexeme(tk.lexeme));
      }
    }
    return out;
  }
  return undefined;
};

const isSelectOfSchemaType = (
  stmt: Statement | undefined,
  shortName: string | readonly string[],
): SelectStatement | undefined => {
  if (!stmt || stmt.kind !== "select") return undefined;
  const names = typeof shortName === "string" ? [shortName] : shortName;
  for (const name of names) {
    if (stmt.typeName === `schema::${name}`) return stmt;
    if (stmt.withModule === "schema" && stmt.typeName === name) return stmt;
  }
  return undefined;
};

const walkFilterLeaves = (filter: FilterExpr | undefined, visit: (leaf: FilterExpr) => void): void => {
  if (!filter) return;
  if (filter.kind === "and" || filter.kind === "or") {
    walkFilterLeaves(filter.left, visit);
    walkFilterLeaves(filter.right, visit);
    return;
  }
  if (filter.kind === "not") {
    walkFilterLeaves(filter.expr, visit);
    return;
  }
  visit(filter);
};

const filterFieldEqualsLiteral = (
  filter: FilterExpr | undefined,
  field: string,
): string | undefined => {
  let result: string | undefined;
  walkFilterLeaves(filter, (leaf) => {
    if (result !== undefined) return;
    if (leaf.kind !== "predicate") return;
    if (leaf.op !== "=") return;
    if (leaf.target.kind !== "field" || leaf.target.field !== field) return;
    if (typeof leaf.value === "string") result = leaf.value;
  });
  return result;
};

const orderByIsField = (
  orderBy: OrderExpr | undefined,
  field: string,
): boolean => {
  if (!orderBy) return false;
  if (orderBy.expr) return false;
  return orderBy.field === field || orderBy.field === `.${field}`;
};

const findShapeElementByName = (
  shape: ShapeElement[] | undefined,
  name: string,
): ShapeElement | undefined => {
  if (!shape) return undefined;
  for (const el of shape) {
    if (el.kind === "splat") continue;
    if (el.name === name) return el;
  }
  return undefined;
};

const shapeFieldHasShape = (
  el: ShapeElement | undefined,
): ShapeElement[] | undefined => {
  if (!el) return undefined;
  if (el.kind === "link" && el.shape) return el.shape;
  if (el.kind === "backlink" && el.shape) return el.shape;
  if (el.kind === "computed" && el.expr.kind === "subquery") return el.expr.shape;
  return undefined;
};

const shapeFieldClauses = (
  el: ShapeElement | undefined,
):
  | {
      where?: FreeObjectExpr;
      orderBy?: OrderExpr[];
      filter?: FilterExpr;
      offset?: number;
      limit?: number;
    }
  | undefined => {
  if (!el) return undefined;
  if (el.kind === "link") {
    return { where: el.where, orderBy: el.orderBy, filter: el.clauses?.filter };
  }
  if (el.kind === "backlink") {
    return { where: el.where, orderBy: el.orderBy };
  }
  if (el.kind === "computed" && el.expr.kind === "subquery") {
    return {
      where: el.where,
      orderBy: el.orderBy,
      filter: el.expr.clauses?.filter,
    };
  }
  return { where: el.where, orderBy: el.orderBy };
};

const subShapeFieldEqualsLiteral = (
  el: ShapeElement | undefined,
  field: string,
): string | undefined => {
  const clauses = shapeFieldClauses(el);
  if (!clauses) return undefined;
  return filterFieldEqualsLiteral(clauses.filter, field);
};

const tryRuntimeTypedAliasSchemaLinkIntrospection = (
  schema: SchemaSnapshot,
  query: string,
): QueryResult | undefined => {
  const typedAliases = runtimeTypedAliases.get(schema);
  if (!typedAliases || typedAliases.size === 0) {
    return undefined;
  }

  // Token-level gate: the bypass is only meaningful for queries that select
  // schema::ObjectType. Parsing is comparatively expensive, so skip queries
  // that can't possibly be a hit.
  const tokens = tryTokenize(query);
  const looksLikeObjectTypeSelect = tokensIncludeQualifiedName(tokens, "schema", "ObjectType")
    || tokensIncludeWithModuleSelect(tokens, "schema", "ObjectType");
  if (!looksLikeObjectTypeSelect) {
    return undefined;
  }

  const stmt = isSelectOfSchemaType(tryParseStatement(query), "ObjectType");
  if (!stmt) return undefined;

  const qualifiedAliasName = filterFieldEqualsLiteral(stmt.filter, "name");
  if (!qualifiedAliasName) return undefined;

  const linksField = findShapeElementByName(stmt.shape, "links");
  const linkName = subShapeFieldEqualsLiteral(linksField, "name");
  if (!linkName) return undefined;

  const linkSubShape = shapeFieldHasShape(linksField);
  const pointersField = findShapeElementByName(linkSubShape, "pointers");
  const pointerName = subShapeFieldEqualsLiteral(pointersField, "name");
  if (!pointerName) return undefined;

  const aliasDef = [...typedAliases.values()].find((alias) => `${alias.moduleName}::${alias.aliasName}` === qualifiedAliasName);
  if (!aliasDef) {
    return undefined;
  }

  const linkOverride = aliasDef.linkOverrides.find((link) => link.name === linkName);
  if (!linkOverride || !linkOverride.computedFields.some((field) => field.name === pointerName)) {
    return undefined;
  }

  return {
    kind: "select",
    rows: [
      {
        target: {
          name: `${aliasDef.moduleName}::__${aliasDef.aliasName}__${linkOverride.name}`,
          pointers: [{ name: pointerName }],
        },
      },
    ],
  };
};

const qualifiedRuntimeAliasName = (name: string): string => name.includes("::") ? name : `default::${name}`;

const runtimeSchemaAliasTypeNames = (schema: SchemaSnapshot): string[] => {
  const names = new Set<string>();
  for (const alias of schema.listAliases()) {
    names.add(`${alias.module}::${alias.name}`);
  }

  const exprAliases = runtimeExprAliases.get(schema);
  if (exprAliases) {
    for (const aliasName of exprAliases.keys()) {
      names.add(qualifiedRuntimeAliasName(aliasName));
    }
  }

  const typedAliases = runtimeTypedAliases.get(schema);
  if (typedAliases) {
    for (const alias of typedAliases.values()) {
      names.add(`${alias.moduleName}::${alias.aliasName}`);
      if (alias.hasShape || (alias.computedProperties?.length ?? 0) > 0 || alias.linkOverrides.length > 0) {
        names.add(`${alias.moduleName}::__${alias.aliasName}__${alias.sourceType.split("::").at(-1) ?? alias.sourceType}`);
      }
    }
  }

  return [...names];
};

// Walk every FilterExpr embedded anywhere in a parsed Statement (the top-level
// filter plus filters on shape sub-clauses) and apply `visit`. Used by the
// schema bypasses below to locate `.name = '...'` / `.name LIKE '...'`
// regardless of which sub-shape they sit on.
const walkStatementFilters = (
  stmt: Statement | undefined,
  visit: (filter: FilterExpr) => void,
): void => {
  if (!stmt || stmt.kind !== "select") return;
  if (stmt.filter) visit(stmt.filter);
  const visitShape = (shape: ShapeElement[] | undefined): void => {
    if (!shape) return;
    for (const el of shape) {
      if (el.kind === "link") {
        if (el.clauses?.filter) visit(el.clauses.filter);
        visitShape(el.shape);
        continue;
      }
      if (el.kind === "computed" && el.expr.kind === "subquery") {
        if (el.expr.clauses?.filter) visit(el.expr.clauses.filter);
        visitShape(el.expr.shape);
      }
    }
  };
  visitShape(stmt.shape);
};

const collectAllFilterPredicates = (stmt: Statement | undefined): FilterExpr[] => {
  const out: FilterExpr[] = [];
  walkStatementFilters(stmt, (filter) => {
    walkFilterLeaves(filter, (leaf) => out.push(leaf));
  });
  return out;
};

const findAnyFilterFieldLike = (
  stmt: Statement | undefined,
  field: string,
): { op: "like" | "ilike"; pattern: string } | undefined => {
  for (const leaf of collectAllFilterPredicates(stmt)) {
    if (leaf.kind !== "predicate") continue;
    if (leaf.op !== "like" && leaf.op !== "ilike") continue;
    if (leaf.target.kind !== "field" || leaf.target.field !== field) continue;
    if (typeof leaf.value === "string") return { op: leaf.op, pattern: leaf.value };
  }
  return undefined;
};

const findAnyFilterFieldEqualsLiteral = (
  stmt: Statement | undefined,
  field: string,
): string | undefined => {
  for (const leaf of collectAllFilterPredicates(stmt)) {
    if (leaf.kind !== "predicate") continue;
    if (leaf.op !== "=") continue;
    if (leaf.target.kind !== "field" || leaf.target.field !== field) continue;
    if (typeof leaf.value === "string") return leaf.value;
  }
  return undefined;
};

const statementHasOrderByField = (
  stmt: Statement | undefined,
  field: string,
): boolean => {
  if (!stmt || stmt.kind !== "select") return false;
  let cur: OrderExpr | undefined = stmt.orderBy;
  while (cur) {
    if (orderByIsField(cur, field)) return true;
    cur = cur.then;
  }
  return false;
};

const trySchemaTypeQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const tokens = tryTokenize(query);
  const mentionsSchemaType = tokensIncludeQualifiedName(tokens, "schema", "Type")
    || tokensIncludeWithModuleSelect(tokens, "schema", "Type");
  if (!mentionsSchemaType) {
    return undefined;
  }

  // Phase 1 of real schema introspection registers `schema::Type` and
  // populates `schema__type` from SchemaSnapshot + runtime alias maps, so
  // simple `SELECT schema::Type { name } FILTER .name (ilike|=) '...'`
  // queries flow through the principled SELECT pipeline. Skip the bypass
  // for those shapes and let the IR/SQL path serve them. Complex shapes
  // still need bypass coverage: array/tuple cross-products with empty
  // `Type.name` slots (`[A, (SELECT Type FILTER .name='n/a').name]`) and
  // backlinks through schema::Pointer / type intersections on
  // schema::Range / schema::MultiRange — Phase 2/3 retires the rest.
  const hasNonSimpleArrayShape = tokensHaveSelectFollowedBy(tokens, "lbracket")
    || tokensHaveSelectFollowedBy(tokens, "lparen");
  const hasSchemaPointerBacklink = tokensIncludeBacklinkTargetIntersection(tokens, "schema", "Pointer");
  const hasComplexTypeIntersection = tokensIncludeTypeIntersection(tokens, "schema", ["Range", "MultiRange"]);
  const isSimpleTypeQuery = !hasNonSimpleArrayShape
    && !hasSchemaPointerBacklink
    && !hasComplexTypeIntersection;
  if (isSimpleTypeQuery) {
    return undefined;
  }

  const parsed = tryParseStatement(query);
  const like = findAnyFilterFieldLike(parsed, "name");
  const equalsName = findAnyFilterFieldEqualsLiteral(parsed, "name");
  const orderByName = statementHasOrderByField(parsed, "name");

  let rows = runtimeSchemaAliasTypeNames(schema).map((name) => ({ name }));
  if (like) {
    rows = rows.filter((row) => {
      const rowName = like.op === "ilike" ? row.name.toLowerCase() : row.name;
      const matchPattern = like.op === "ilike" ? like.pattern.toLowerCase() : like.pattern;
      return runtimeAliasLikeMatches(rowName, matchPattern);
    });
  }
  if (equalsName) {
    rows = rows.filter((row) => row.name === equalsName);
  }
  if (orderByName) {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    kind: "select",
    rows,
  };
};

const scalarTypeNameForRuntimeValue = (value: string): string => {
  // Tokenize the literal-bearing fragment so quoting, sign, and exponent
  // forms are recognised by the same lexer the rest of the engine uses.
  const tokens = tryTokenize(value.trim());
  if (!tokens || tokens.length === 0) return "std::str";
  const first = tokens[0]!;
  if (first.kind === "string") return "std::str";
  if (first.kind === "kw_true" || first.kind === "kw_false") return "std::bool";
  if (first.kind === "number") {
    return first.lexeme.includes(".") || first.lexeme.toLowerCase().includes("e")
      ? "std::float64"
      : "std::int64";
  }
  if (first.kind === "minus" && tokens.length > 1 && tokens[1]!.kind === "number") {
    return tokens[1]!.lexeme.includes(".") || tokens[1]!.lexeme.toLowerCase().includes("e")
      ? "std::float64"
      : "std::int64";
  }
  return "std::str";
};

// Split a parenthesised tuple expression like `(1, 'foo', true)` (already
// stored in alias-expression text form) into its top-level element strings.
// The tokenizer respects nested parens / quoted strings, so we walk tokens
// instead of `String.prototype.split(",")` to avoid splitting on commas inside
// nested constructs.
const splitParenthesisedTupleElements = (expr: string): string[] | undefined => {
  const tokens = tryTokenize(expr.trim());
  if (!tokens || tokens.length < 3) return undefined;
  // Trim the trailing eof token so we operate on real syntax.
  const lastIdx = tokens[tokens.length - 1]!.kind === "eof"
    ? tokens.length - 2
    : tokens.length - 1;
  if (lastIdx < 1) return undefined;
  if (tokens[0]!.kind !== "lparen" || tokens[lastIdx]!.kind !== "rparen") {
    return undefined;
  }

  const elements: string[] = [];
  let depth = 0;
  let elementStart = tokens[1]!.offset;
  for (let i = 1; i < lastIdx; i += 1) {
    const tk = tokens[i]!;
    if (tk.kind === "lparen" || tk.kind === "lbrace" || tk.kind === "lbracket") depth += 1;
    else if (tk.kind === "rparen" || tk.kind === "rbrace" || tk.kind === "rbracket") depth -= 1;
    else if (tk.kind === "comma" && depth === 0) {
      const slice = expr.slice(elementStart, tk.offset).trim();
      if (slice.length > 0) elements.push(slice);
      elementStart = tokens[i + 1]!.offset;
    }
  }
  const tail = expr.slice(elementStart, tokens[lastIdx]!.offset).trim();
  if (tail.length > 0) elements.push(tail);
  return elements;
};

const trySchemaTupleQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const tokens = tryTokenize(query);
  const isTupleQuery = tokensIncludeQualifiedName(tokens, "schema", "Tuple")
    || tokensIncludeWithModuleSelect(tokens, "schema", "Tuple");
  if (!isTupleQuery) {
    return undefined;
  }

  const parsed = tryParseStatement(query);
  const qualifiedName = findAnyFilterFieldEqualsLiteral(parsed, "name");
  if (!qualifiedName) {
    return undefined;
  }

  const aliases = runtimeExprAliases.get(schema);
  const expr = aliases?.get(qualifiedName) ?? aliases?.get(qualifiedName.split("::").at(-1) ?? qualifiedName);
  if (!expr) {
    return { kind: "select", rows: [] };
  }
  const elements = splitParenthesisedTupleElements(expr);
  if (!elements) {
    return { kind: "select", rows: [] };
  }

  const elementTypes = elements.map((part) => ({ name: scalarTypeNameForRuntimeValue(part) }));

  return {
    kind: "select",
    rows: [{ name: qualifiedName, element_types: elementTypes }],
  };
};

const findRuntimeLinkDef = (
  schema: SchemaSnapshot,
  typeName: string,
  linkName: string,
  seen = new Set<string>(),
): { ownerType: TypeDef; link: NonNullable<TypeDef["links"]>[number] } | undefined => {
  if (seen.has(typeName)) {
    return undefined;
  }
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) {
    return undefined;
  }

  const direct = (typeDef.links ?? []).find((link) => link.name === linkName);
  if (direct) {
    return { ownerType: typeDef, link: direct };
  }

  for (const baseName of typeDef.extends ?? []) {
    const inherited = findRuntimeLinkDef(schema, baseName, linkName, seen);
    if (inherited) {
      return inherited;
    }
  }

  return undefined;
};

const resolveRuntimeStoredTypeName = (schema: SchemaSnapshot, storedTypeName: string): string => {
  if (storedTypeName.includes("::")) {
    return storedTypeName;
  }

  const normalized = storedTypeName.toLowerCase();
  for (const typeDef of schema.listTypes()) {
    const qualified = qualifiedTypeName(typeDef);
    if (tableNameForType(qualified) === normalized) {
      return qualified;
    }
  }

  return storedTypeName;
};

const findRuntimeComputedMulti = (
  schema: SchemaSnapshot,
  typeName: string,
  computedName: string,
  seen = new Set<string>(),
): boolean | undefined => {
  if (seen.has(typeName)) {
    return undefined;
  }
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) {
    return undefined;
  }

  const direct = (typeDef.computeds ?? []).find((c) => c.name === computedName);
  if (direct) {
    return Boolean(direct.multi);
  }

  for (const baseName of typeDef.extends ?? []) {
    const inherited = findRuntimeComputedMulti(schema, baseName, computedName, seen);
    if (inherited !== undefined) {
      return inherited;
    }
  }

  return undefined;
};

const resolvedRuntimeTarget = (context: SecurityContext, db: RuntimeDatabaseAdapter): RuntimeTarget =>
  context.runtimeTarget ?? db.target ?? "sqlite";

type ParsedRuntimeRow = Record<string, unknown> & { id?: unknown; __source_type?: unknown };

type ParsedRuntimeEnv = {
  row?: ParsedRuntimeRow;
  rowType?: string;
  bindings: Map<string, ParsedRuntimeRow[]>;
  outerRows?: Array<{ row: ParsedRuntimeRow; rowType?: string }>;
  iterationPath?: { typeName: string; steps: string[] };
  iterationSource?: FreeObjectExpr;
};

const withInnerRow = (
  env: ParsedRuntimeEnv,
  row: ParsedRuntimeRow,
  rowType: string | undefined,
  extra: Partial<ParsedRuntimeEnv> = {},
): ParsedRuntimeEnv => {
  const outerRows = env.row
    ? [...(env.outerRows ?? []), { row: env.row, rowType: env.rowType }]
    : env.outerRows;
  return { ...env, ...extra, row, rowType, outerRows };
};

const tryEvaluateParsedRuntimeSelect = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  statement: Statement,
  context: SecurityContext,
): QueryResult | undefined => {
  if (statement.kind !== "select") {
    return undefined;
  }

  const qualifyType = (name: string): string => qualifyRuntimeTypeName(name, statement.withModule ?? "default");
  const selectedSchemaAlias = schema.getAlias(qualifyType(statement.typeName));
  const selectedAliasStatement = (() => {
    if (!selectedSchemaAlias?.exprText) {
      return undefined;
    }
    const exprText = stripRuntimeAliasOuterParens(selectedSchemaAlias.exprText.replace(/;\s*$/, "").trim());
    if (!/^select\b/i.test(exprText)) {
      return undefined;
    }
    try {
      const parsed = parseEdgeQL(exprText);
      return parsed.kind === "select" ? parsed : undefined;
    } catch {
      return undefined;
    }
  })();
  const selectedAliasNeedsParsedRuntime = Boolean(selectedAliasStatement?.shape.some((element) => element.kind === "link" && (
    Boolean(element.clauses.filter)
    || Boolean(element.clauses.orderBy)
    || element.clauses.limit !== undefined
    || element.clauses.offset !== undefined
  )));

  const bindingNeedsParsedRuntime = (value: WithBindingValue): boolean => value.kind === "subquery_statement"
    || value.kind === "backlink_path"
    || value.kind === "path"
    || value.kind === "path_chain"
    || (value.kind === "subquery" && shapeNeedsParsedRuntime(value.query.shape));
  // EdgeQL `sum(.link.field)` over a multi link compiles to a `link_aggregate`
  // IR entry that lowers to a correlated SUM subquery in the parent SELECT.
  // Routing this through the parsed runtime would fire one SQL per row — let
  // the IR/SQL path take it instead.
  const isLinkAggregateFunctionCall = (expr: Extract<ComputedExpr, { kind: "function_call" }>): boolean => {
    if (expr.call.name !== "sum" && expr.call.name !== "std::sum") return false;
    if (expr.call.args.length !== 1) return false;
    const arg = expr.call.args[0]!;
    if (arg.kind !== "expr") return false;
    const outer = arg.expr;
    if (outer.kind !== "field_access" || outer.field.startsWith("@")) return false;
    const inner = outer.expr;
    return inner.kind === "field_access"
      && inner.expr.kind === "current_item"
      && !inner.field.startsWith("@");
  };
  const functionCallNeedsParsedRuntime = (expr: Extract<ComputedExpr, { kind: "function_call" }>): boolean => {
    if (isLinkAggregateFunctionCall(expr)) return false;
    return expr.call.args.some((arg) => arg.kind === "expr" || (arg.kind === "function_call" && functionCallNeedsParsedRuntime({ kind: "function_call", call: arg.call })));
  };
  const selectExprNeedsParsedRuntime = (expr: Extract<ComputedExpr, { kind: "select_expr" }>): boolean => {
    if (expr.clauses?._withBindings && expr.clauses._withBindings.length > 0) return true;
    if (expr.clauses?.orderBy || expr.clauses?.limit !== undefined || expr.clauses?.offset !== undefined) return true;
    const needsParsedRuntime = (inner: FreeObjectExpr): boolean => {
      if (inner.kind === "shape_projection") return true;
      if (inner.kind === "select_expr_subquery" || inner.kind === "select") return true;
      if (inner.kind === "for_expr") return true;
      if (inner.kind === "exists") return true;
      if (inner.kind === "distinct") return true;
      if (inner.kind === "function_call") return true;
      // A binding_ref means the expression depends on a WITH-introduced
      // binding; the parsed runtime resolves bindings, the IR/SQL path
      // here doesn't, so route it through the parsed runtime.
      if (inner.kind === "binding_ref") return true;
      // Field access patterns that the IR/SQL path can't handle without
      // per-row evaluation:
      //   * A two-or-more deep chain (`Issue.status.name`) — link traversal.
      //   * Access on a `select_expr_subquery` source (`(SELECT X).field`).
      //   * Multi-property reference inside a tuple/array literal — the SQL
      //     path emits `json_array(t.col)` which wraps the JSON-encoded
      //     multi value as one element instead of iterating. EdgeQL needs
      //     cartesian-product semantics here.
      // A simple `current_item.field` / `Issue.field` (depth 1, source is the
      // subject) stays on the SQL path.
      if (inner.kind === "field_access") {
        if (inner.expr.kind === "field_access") return true;
        if (inner.expr.kind === "select_expr_subquery") return true;
        // Subject-scoped reference to a multi property — only needs the
        // parsed runtime when the access participates in tuple/array
        // construction (handled below); a bare `.tag_set1` shape element
        // stays on SQL via the existing materializer.
      }
      if (inner.kind === "tuple" || inner.kind === "set_expr" || inner.kind === "array_literal_expr") {
        // EdgeQL cartesian semantics: a multi-property reference inside a
        // tuple/array constructor expands across each element. The SQL
        // lowering emits `json_array(t.col)` which doesn't expand — route
        // such constructions through the parsed runtime.
        const isMultiFieldAccess = (e: FreeObjectExpr): boolean => {
          if (e.kind !== "field_access") return false;
          if (e.field.startsWith("@")) return false;
          const subjectRoot = e.expr.kind === "current_item"
            || (e.expr.kind === "select"
              && (e.expr.typeName === statement.typeName
                || e.expr.typeName === statement.typeName.split("::").at(-1)))
            || (e.expr.kind === "binding_ref"
              && (e.expr.name === statement.typeName
                || e.expr.name === statement.typeName.split("::").at(-1)));
          if (!subjectRoot) return false;
          const typeName = qualifyRuntimeTypeName(statement.typeName, statement.withModule ?? "default");
          const fieldDef = findFieldDef(schema, typeName, e.field);
          return Boolean(fieldDef?.multi);
        };
        if (inner.kind === "tuple" || inner.kind === "array_literal_expr" || inner.values.some(isMultiFieldAccess)) return true;
        return inner.values.some((value) => needsParsedRuntime(value));
      }
      if (inner.kind === "index_access" || inner.kind === "slice_access") return true;
      if (inner.kind === "concat") return inner.parts.some((part) => needsParsedRuntime(part));
      if (inner.kind === "cast") {
        return needsParsedRuntime(inner.expr);
      }
      // compare/math/and/or: only route to parsed runtime when a sub-expr
      // demands it (e.g. contains a binding_ref) — they're fine in the IR
      // path otherwise.
      if (inner.kind === "compare" || inner.kind === "math" || inner.kind === "and" || inner.kind === "or") {
        return needsParsedRuntime(inner.left) || needsParsedRuntime(inner.right);
      }
      if (inner.kind === "not") return needsParsedRuntime(inner.expr);
      if (inner.kind === "if_else") return needsParsedRuntime(inner.thenExpr) || needsParsedRuntime(inner.condition) || needsParsedRuntime(inner.elseExpr);
      if (inner.kind === "coalesce") return needsParsedRuntime(inner.left) || needsParsedRuntime(inner.right);
      return false;
    };
    if (needsParsedRuntime(expr.expr)) return true;
    return false;
  };
  const computedNeedsParsedRuntime = (expr: ComputedExpr): boolean => (expr.kind === "select_expr" && selectExprNeedsParsedRuntime(expr))
    || (expr.kind === "function_call" && functionCallNeedsParsedRuntime(expr))
    || expr.kind === "subquery";
  function shapeNeedsParsedRuntime(shape: ShapeElement[]): boolean {
    return shape.some((element) => {
      if (element.kind === "field") {
        // Shape modifiers on a (multi-)property field — `tags ORDER BY ...
        // LIMIT N`, `tags FILTER ...` — are applied by the parsed-runtime
        // materializer; the SQL path doesn't reach into the JSON-encoded
        // multi value.
        return Boolean(element.where)
          || Boolean(element.orderBy && element.orderBy.length > 0)
          || element.limit !== undefined
          || element.offset !== undefined;
      }
      if (element.kind === "computed") {
        return computedNeedsParsedRuntime(element.expr);
      }
      if (element.kind === "link") {
        // Inline FILTER / ORDER BY / LIMIT / OFFSET on a forward link shape
        // is lowered by the SQL path: the IR carries the link's clauses on
        // the SelectShapeElementIR, and sql/compiler emits them as
        // WHERE / ORDER BY / LIMIT on the correlated subquery. When the
        // SELECT subject is an alias, the link names in this shape can be
        // computeds defined in the alias body (e.g.
        // `owners := SELECT Type.<link[IS T] {...}`), which the SQL path
        // doesn't apply per-link clauses to — keep those on the parsed
        // runtime.
        if (selectedSchemaAlias) {
          return Boolean(element.clauses.filter)
            || Boolean(element.clauses.orderBy)
            || element.clauses.limit !== undefined
            || element.clauses.offset !== undefined
            || shapeNeedsParsedRuntime(element.shape);
        }
        return shapeNeedsParsedRuntime(element.shape);
      }
      if (element.kind === "backlink") {
        // Inline backlink shape elements (`name := X.<link[IS T] {...}`) are
        // lowered by the SQL path via compileBacklinkArrayExpr, which emits
        // the unioned source select with ORDER BY / LIMIT / OFFSET and the
        // JSON-aggregated shape. Alias subjects keep the old behaviour
        // because their resolved sources can include computeds the SQL
        // path doesn't yet apply per-link clauses to.
        //
        // Known SQL-path gaps that the parsed runtime was papering over:
        //  - resolveBacklinkSources doesn't resolve inherited polymorphic
        //    backlinks (e.g. `Card.<deck[IS Bot]` where Bot inherits `deck`
        //    from User). Affected tests are listed in the case-#1/#2 notes
        //    rather than being kept on the interpreter path.
        //  - compileBacklinkArrayExpr doesn't apply `element.filter`.
        if (selectedSchemaAlias) {
          return Boolean(element.shape);
        }
        return element.shape ? shapeNeedsParsedRuntime(element.shape) : false;
      }
      return false;
    });
  }

  // True when the expression chains through a link (e.g. `Issue.priority.name`).
  // Such paths can be empty per source row, and EdgeQL semantics require empty
  // propagation through comparisons / AND / OR / NOT — which the SQL path
  // can't express, so we route through the parsed runtime evaluator.
  const accessesOptionalPath = (expr: FreeObjectExpr): boolean => {
    if (!expr) return false;
    if (expr.kind === "field_access") {
      // A chain of two or more dotted accesses (e.g. `.priority.name`) crosses
      // at least one link boundary, so the result may be empty.
      let depth = 0;
      let cursor: FreeObjectExpr = expr;
      while (cursor.kind === "field_access") {
        depth += 1;
        cursor = cursor.expr;
      }
      return depth >= 2;
    }
    return false;
  };
  // Helpers used by the lowering checks below. The shape we detect mirrors
  // the `arrayAggOnSubjectMulti` pattern in semantic.ts: an `array_agg`
  // around a subject-scoped field_access, optionally ordered by the same
  // field. The subject root may surface as `current_item`, `select{Subject}`,
  // or a binding_ref (depending on how the user wrote `Item.tag_set1` vs
  // `.tag_set1`). We match the field/base pair structurally rather than
  // resolving the subject type — semantic.ts validates the multi-ness.
  const subjectScopedField = (e: FreeObjectExpr): string | undefined => {
    if (e.kind !== "field_access") return undefined;
    if (e.field.startsWith("@")) return undefined;
    if (e.expr.kind === "current_item") return e.field;
    if (e.expr.kind === "select") return e.field;
    if (e.expr.kind === "binding_ref") return e.field;
    return undefined;
  };
  const isArrayAggOfCurrentItemMulti = (e: FreeObjectExpr): boolean => {
    if (e.kind !== "function_call") return false;
    if (e.call.name !== "array_agg" && e.call.name !== "std::array_agg") return false;
    if (e.call.args.length !== 1) return false;
    const arg = e.call.args[0];
    if (arg.kind !== "expr") return false;
    const inner = arg.expr;
    if (inner.kind !== "select_expr_subquery") return false;
    if (inner.filter || inner.limit !== undefined || inner.offset !== undefined) return false;
    const srcField = subjectScopedField(inner.expr);
    if (srcField === undefined) return false;
    if (inner.orderBy) {
      const orderField = subjectScopedField(inner.orderBy.expr);
      if (orderField !== srcField) return false;
    }
    return true;
  };
  const isArrayLiteralOfScalars = (e: FreeObjectExpr): boolean =>
    e.kind === "array_literal_expr"
    && e.values.every((v) => v.kind === "literal");
  // `count(.multi)` / `count((SELECT _ := .multi FILTER _ IN/op …))` is
  // lowered to `multi_field_count` SQL via `compileMultiFieldElementFilter`.
  const isLoweredCountOfMulti = (e: FreeObjectExpr): boolean => {
    if (e.kind !== "function_call") return false;
    if (e.call.name !== "count" && e.call.name !== "std::count") return false;
    if (e.call.args.length !== 1) return false;
    const arg = e.call.args[0];
    if (arg.kind !== "expr") return false;
    const inner = arg.expr;
    if (subjectScopedField(inner) !== undefined) return true;
    if (inner.kind !== "select_expr_subquery") return false;
    if (inner.limit !== undefined || inner.offset !== undefined || inner.orderBy) return false;
    if (subjectScopedField(inner.expr) === undefined) return false;
    if (!inner.filter) return true;
    const f = inner.filter;
    const alias = inner.alias;
    const isAliasRef = (x: FreeObjectExpr): boolean =>
      alias !== undefined && x.kind === "binding_ref" && x.name === alias;
    if (f.kind === "in_expr" && isAliasRef(f.left)
      && (f.right.kind === "literal" || f.right.kind === "set_literal")) return true;
    if (f.kind === "compare" && (f.op === "=" || f.op === "!=" || f.op === "<" || f.op === "<=" || f.op === ">" || f.op === ">=")
      && (isAliasRef(f.left) || isAliasRef(f.right))) return true;
    return false;
  };

  const freeExprNeedsParsedRuntime = (expr: FreeObjectExpr, inNot = false): boolean => {
    if (expr.kind === "for_expr") return true;
    if (expr.kind === "is_type") return true;
    // `array_agg(.multi ORDER BY .multi) = array_agg(...) / [literal]` is
    // lowered to SQL via `multi_field_array_agg` — don't route those compares
    // (or their function_call children) to the parsed runtime.
    if (expr.kind === "compare" && (expr.op === "=" || expr.op === "!=")) {
      const leftAgg = isArrayAggOfCurrentItemMulti(expr.left);
      const rightAgg = isArrayAggOfCurrentItemMulti(expr.right);
      if (leftAgg && rightAgg) return false;
      if (leftAgg && isArrayLiteralOfScalars(expr.right)) return false;
      if (rightAgg && isArrayLiteralOfScalars(expr.left)) return false;
    }
    // Lowered `count(.multi)` / `count((SELECT _ := .multi FILTER …))` —
    // compared against a literal scalar these compile to a plain SQL
    // `expr_compare` with the `multi_field_count` ScalarExpr, so don't
    // drag them back into the parsed-runtime path.
    if (expr.kind === "compare") {
      const leftCount = isLoweredCountOfMulti(expr.left);
      const rightCount = isLoweredCountOfMulti(expr.right);
      const isScalarLiteral = (e: FreeObjectExpr): boolean =>
        e.kind === "literal"
        && (typeof e.value === "number" || typeof e.value === "string"
          || typeof e.value === "boolean" || e.value === null);
      if ((leftCount && isScalarLiteral(expr.right))
        || (rightCount && isScalarLiteral(expr.left))) {
        return false;
      }
    }
    if (expr.kind === "function_call") return true;
    // `x IN <free_expr>` keeps the runtime path when the SQL filter
    // compiler can't recognise either side as a multi-property literal /
    // current-item field. `compileFreeExprFilter` handles the lowered
    // patterns directly; anything else (e.g. `'a' IN (SELECT ...)`) still
    // needs the AST evaluator.
    if (expr.kind === "in_expr") {
      const isMultiFieldAccess = (e: FreeObjectExpr): boolean =>
        e.kind === "field_access" && e.expr.kind === "current_item" && !e.field.startsWith("@");
      const isLiteralOrSet = (e: FreeObjectExpr): boolean =>
        e.kind === "literal" || e.kind === "set_literal";
      const handled = (isMultiFieldAccess(expr.left) && isLiteralOrSet(expr.right))
        || (isMultiFieldAccess(expr.right) && isLiteralOrSet(expr.left));
      if (!handled) return true;
    }
    // Compares with set/array literals still route to the runtime when the
    // SQL lowering can't pattern-match the field side. Patterns covered in
    // semantic.ts:
    //   * `.multi = {…}` / `.multi = X` → `multi_field_in`
    //   * `.array = [literal]` → `field` IR with JSON-stringified value
    //   * `array_agg(.multi ORDER BY .multi) = array_agg(...) / [literal]`
    //     → `expr_compare` with `multi_field_array_agg` ScalarExprIR
    if (expr.kind === "compare"
      && (expr.left.kind === "set_literal" || expr.right.kind === "set_literal"
        || expr.left.kind === "array_literal_expr" || expr.right.kind === "array_literal_expr")) {
      const isCurrentItemField = (e: FreeObjectExpr): boolean =>
        e.kind === "field_access" && e.expr.kind === "current_item" && !e.field.startsWith("@");
      const isArrayAggCall = (e: FreeObjectExpr): boolean =>
        e.kind === "function_call"
        && (e.call.name === "array_agg" || e.call.name === "std::array_agg");
      const setLiteralSide = expr.left.kind === "set_literal" ? expr.left : expr.right.kind === "set_literal" ? expr.right : undefined;
      const arrayLiteralSide = expr.left.kind === "array_literal_expr" ? expr.left : expr.right.kind === "array_literal_expr" ? expr.right : undefined;
      const setLiteralIsAllScalars = !setLiteralSide || setLiteralSide.values.every((v) =>
        typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null);
      const arrayLiteralIsAllScalars = !arrayLiteralSide || arrayLiteralSide.values.every((v) => v.kind === "literal");
      const handledSide = isCurrentItemField(expr.left) || isCurrentItemField(expr.right)
        || isArrayAggCall(expr.left) || isArrayAggCall(expr.right);
      const lowered = handledSide
        && (expr.op === "=" || expr.op === "!=")
        && setLiteralIsAllScalars
        && arrayLiteralIsAllScalars;
      if (!lowered) return true;
    }
    // EdgeQL: `NOT {}` evaluates to `{}` (empty propagation), so a row
    // whose optional path is empty is excluded by `FILTER NOT (...)`. The
    // SQL `NOT EXISTS` returns TRUE for empty, which would include those
    // rows — so a compare-with-optional-path underneath a NOT stays on the
    // parsed runtime. Outside a NOT, the SQL EXISTS matches EdgeQL for
    // AND/OR/single-compare with single-link multi-step paths.
    //
    // `?=`/`?!=` keeps the parsed runtime regardless of NOT context: the
    // EdgeQL coalescing-compare returns `true` when both sides are empty
    // and `false` when one side is empty, which the SQL EXISTS lowering
    // doesn't express for multi-step paths.
    //
    // Known gap: `any(<compare>)` is parsed as a bare `free_expr` whose
    // top-level expr is a compare — the `any()` wrapper is consumed. With
    // this narrowing, those filters route to SQL, which then bails on
    // multi-link traversals (e.g. `any(.children.children.val = '0')`).
    if (expr.kind === "compare"
      && (expr.op === "?=" || expr.op === "?!=" || inNot)
      && (accessesOptionalPath(expr.left) || accessesOptionalPath(expr.right))) return true;
    if (expr.kind === "exists") return freeExprNeedsParsedRuntime(expr.expr, inNot) || expr.expr.kind === "field_access" || expr.expr.kind === "select_expr_subquery" || expr.expr.kind === "path_steps";
    if (expr.kind === "path_steps") {
      return expr.steps.some((step) => step.kind === "ptr" && step.direction === "inbound");
    }
    if (expr.kind === "select_expr_subquery") return freeExprNeedsParsedRuntime(expr.expr, inNot) || (expr.filter ? freeExprNeedsParsedRuntime(expr.filter, inNot) : false);
    if (expr.kind === "not") return freeExprNeedsParsedRuntime(expr.expr, !inNot);
    if (expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "unary" || expr.kind === "shape_projection") {
      return freeExprNeedsParsedRuntime(expr.expr, inNot);
    }
    if (expr.kind === "and" || expr.kind === "or" || expr.kind === "logical" || expr.kind === "compare" || expr.kind === "math" || expr.kind === "coalesce") {
      return freeExprNeedsParsedRuntime(expr.left, inNot) || freeExprNeedsParsedRuntime(expr.right, inNot);
    }
    if (expr.kind === "if_else") {
      return freeExprNeedsParsedRuntime(expr.condition, inNot) || freeExprNeedsParsedRuntime(expr.thenExpr, inNot) || freeExprNeedsParsedRuntime(expr.elseExpr, inNot);
    }
    if (expr.kind === "field_access" || expr.kind === "index_access" || expr.kind === "slice_access") {
      return freeExprNeedsParsedRuntime(expr.expr, inNot);
    }
    if (expr.kind === "concat") return expr.parts.some((part) => freeExprNeedsParsedRuntime(part, inNot));
    if (expr.kind === "tuple" || expr.kind === "set_expr" || expr.kind === "array_literal_expr") {
      return expr.values.some((value) => freeExprNeedsParsedRuntime(value, inNot));
    }
    return false;
  };
  // True when at least one branch of this filter targets a path that traverses
  // a link (i.e. could be empty per-row). Such filters require EdgeQL set
  // semantics that the SQL path can't express. Combined with AND/OR/NOT
  // empty-propagation, we route the whole filter through the parsed runtime.
  const isMultiField = (fieldName: string): boolean => {
    if (fieldName.includes(".")) return false;
    const subjectQualified = qualifyType(statement.typeName);
    const subjectType = schema.getType(subjectQualified);
    if (!subjectType) return false;
    const field = subjectType.fields.find((f) => f.name === fieldName);
    return Boolean(field?.multi);
  };
  const filterTouchesOptionalPath = (filter: SelectStatement["filter"]): boolean => {
    if (!filter) return false;
    if (filter.kind === "and" || filter.kind === "or") {
      return filterTouchesOptionalPath(filter.left) || filterTouchesOptionalPath(filter.right);
    }
    if (filter.kind === "not") return filterTouchesOptionalPath(filter.expr);
    if (filter.kind === "predicate" && filter.target.kind === "field" && filter.target.field.includes(".")) {
      return true;
    }
    if (filter.kind === "in_predicate" && filter.target.kind === "field" && filter.target.field.includes(".")) {
      return true;
    }
    return false;
  };
  // FILTER `.shape_computed_name op X` — the SQL path doesn't know about
  // shape-defined computeds (they're projected after rows are selected),
  // so route through the parsed runtime which can evaluate them on demand.
  const shapeComputedNames = new Set<string>(
    statement.shape
      .filter((element) => element.kind === "computed")
      .map((element) => (element as { name: string }).name),
  );
  // Guard against infinite recursion when a shape computed's body refers to
  // an outer field that this same evaluator interprets as the computed
  // itself (`(SELECT Item).computed_link` patterns surface as nested
  // shape-computed dispatches on the same name).
  const shapeComputedInProgress = new Set<string>();
  const exprReferencesShapeComputed = (expr: FreeObjectExpr): boolean => {
    if (expr.kind === "field_access"
      && expr.expr.kind === "current_item"
      && !expr.field.startsWith("@")
      && shapeComputedNames.has(expr.field)) {
      return true;
    }
    if (expr.kind === "path"
      && shapeComputedNames.has(expr.tail)) {
      return true;
    }
    if ("expr" in expr && expr.expr) {
      const inner = expr.expr as FreeObjectExpr;
      if (typeof inner === "object" && inner !== null && "kind" in inner) {
        if (exprReferencesShapeComputed(inner)) return true;
      }
    }
    if ("left" in expr && "right" in expr) {
      if (exprReferencesShapeComputed(expr.left as FreeObjectExpr)
        || exprReferencesShapeComputed(expr.right as FreeObjectExpr)) {
        return true;
      }
    }
    if (expr.kind === "function_call") {
      for (const arg of expr.call.args) {
        if (arg.kind === "expr" && exprReferencesShapeComputed(arg.expr)) return true;
      }
    }
    if (expr.kind === "tuple" || expr.kind === "set_expr" || expr.kind === "array_literal_expr") {
      return expr.values.some((v) => exprReferencesShapeComputed(v));
    }
    if (expr.kind === "concat") return expr.parts.some((p) => exprReferencesShapeComputed(p));
    return false;
  };
  const filterTargetsShapeComputed = (filter: SelectStatement["filter"]): boolean => {
    if (!filter) return false;
    if (filter.kind === "and" || filter.kind === "or") {
      return filterTargetsShapeComputed(filter.left) || filterTargetsShapeComputed(filter.right);
    }
    if (filter.kind === "not") return filterTargetsShapeComputed(filter.expr);
    if ((filter.kind === "predicate" || filter.kind === "in_predicate")
      && filter.target.kind === "field"
      && !filter.target.field.includes(".")
      && shapeComputedNames.has(filter.target.field)) {
      return true;
    }
    if (filter.kind === "free_expr") {
      return exprReferencesShapeComputed(filter.expr);
    }
    return false;
  };
  // `.multi_property = <single literal>` reaches into the JSON-encoded set
  // on the row. The SQL `field` lowering compares the raw JSON string
  // against a scalar (never matches), so route those through the parsed
  // runtime. The `in_predicate` form is lowered to `multi_field_in` IR.
  const filterTouchesMultiProperty = (filter: SelectStatement["filter"]): boolean => {
    if (!filter) return false;
    if (filter.kind === "and" || filter.kind === "or") {
      return filterTouchesMultiProperty(filter.left) || filterTouchesMultiProperty(filter.right);
    }
    if (filter.kind === "not") return filterTouchesMultiProperty(filter.expr);
    if (filter.kind === "predicate" && filter.target.kind === "field") {
      return isMultiField(filter.target.field);
    }
    return false;
  };
  const filterContainsBoolOp = (filter: SelectStatement["filter"]): boolean => {
    if (!filter) return false;
    if (filter.kind === "and" || filter.kind === "or" || filter.kind === "not") return true;
    return false;
  };
  const filterNeedsParsedRuntime = (filter: SelectStatement["filter"], inNot = false): boolean => {
    if (!filter) return false;
    if (filterTouchesMultiProperty(filter)) return true;
    if (filterTargetsShapeComputed(filter)) return true;
    // EdgeQL: a multi-clause filter with dotted-path predicates needs
    // EdgeQL set semantics (empty propagation) that the SQL path can't
    // express. Route the whole filter through the parsed runtime.
    if (filterContainsBoolOp(filter) && filterTouchesOptionalPath(filter)) {
      return true;
    }
    if (filter.kind === "and" || filter.kind === "or") {
      return filterNeedsParsedRuntime(filter.left, inNot) || filterNeedsParsedRuntime(filter.right, inNot);
    }
    if (filter.kind === "not") return filterNeedsParsedRuntime(filter.expr, !inNot);
    if (filter.kind === "free_expr") return freeExprNeedsParsedRuntime(filter.expr, inNot);
    return false;
  };

  // ORDER BY with an expression form (e.g. `len(.body)`) can't be lowered to
  // SQL — the semantic stage drops it from the IR. Route through the parsed
  // runtime so we can sort per-row instead. The `count(.multi)` /
  // `count((SELECT _ := .multi FILTER …))` patterns are lowered to SQL in
  // `compileShapeScalarValueSQL`, so leave those on the SQL path.
  const orderByNeedsParsedRuntime = (orderBy: SelectStatement["orderBy"]): boolean => {
    if (!orderBy) return false;
    if (orderBy.expr) {
      if (!isLoweredCountOfMulti(orderBy.expr)) return true;
    }
    return orderByNeedsParsedRuntime(orderBy.then);
  };
  if (
    !selectedAliasNeedsParsedRuntime
    && !shapeNeedsParsedRuntime(statement.shape)
    && !statement.with?.some((binding) => bindingNeedsParsedRuntime(binding.value))
    && !filterNeedsParsedRuntime(statement.filter)
    && !orderByNeedsParsedRuntime(statement.orderBy)
  ) {
    return undefined;
  }

  const validateBacklinkLinkProperties = (shape: ShapeElement[]): void => {
    for (const element of shape) {
      if (element.kind === "backlink") {
        if (!element.expr.sourceType && element.shape) {
          for (const inner of element.shape) {
            const requestedLinkProperty = inner.kind === "field" && inner.name.startsWith("@")
              ? inner.name.slice(1)
              : inner.kind === "computed" && inner.name.startsWith("@")
                ? inner.name.slice(1)
                : undefined;
            if (requestedLinkProperty) {
              throw new AppError("E_SEMANTIC", `link '${element.expr.link}' has no property '${requestedLinkProperty}'`, 1, 1);
            }
          }
        }
        if (element.shape) {
          validateBacklinkLinkProperties(element.shape);
        }
      } else if (element.kind === "link") {
        validateBacklinkLinkProperties(element.shape);
      }
    }
  };
  validateBacklinkLinkProperties(statement.shape);

  const concreteRowsForType = (typeName: string): ParsedRuntimeRow[] => {
    const qualified = qualifyType(typeName);
    if (qualified === "default::Object" || qualified === "std::Object") {
      return schema.listTypes()
        .filter((typeDef) => !typeDef.abstract)
        .flatMap((typeDef) => {
          const sourceType = qualifiedTypeName(typeDef);
          const table = tableNameForType(sourceType);
          return (db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[])
            .map((row) => ({ ...row, __source_type: sourceType }));
        });
    }
    const concreteTypes = schema.listConcreteTypesAssignableTo(qualified);
    if (concreteTypes.length === 0) {
      return [];
    }
    return concreteTypes.flatMap((typeDef) => {
      const sourceType = qualifiedTypeName(typeDef);
      const table = tableNameForType(sourceType);
      return (db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[])
        .map((row) => ({ ...row, __source_type: sourceType }));
    });
  };

  const rowTypeName = (row: ParsedRuntimeRow, fallback?: string): string => {
    const stored = row.__source_type;
    return typeof stored === "string" ? stored : fallback ?? "default::Object";
  };

  const unqualifiedRuntimeTypeName = (typeName: string | undefined): string | undefined =>
    typeName?.split("::").at(-1);

  const readPresentFieldValues = (rows: unknown[], field: string): unknown[] | undefined => {
    if (!rows.every((row) => isRecordRow(row) && Object.prototype.hasOwnProperty.call(row, field))) {
      return undefined;
    }
    return rows.flatMap((row) => {
      const value = (row as ParsedRuntimeRow)[field];
      if (Array.isArray(value)) return value;
      return value === null || value === undefined ? [] : [value];
    });
  };

  const concreteNamesForTypeExpr = (expr: TypeExpr): string[] => {
    if (expr.kind === "type_name") {
      const qualified = qualifyType(expr.name);
      if (qualified === "default::Object" || qualified === "std::Object") {
        return schema.listTypes().filter((typeDef) => !typeDef.abstract).map((typeDef) => qualifiedTypeName(typeDef));
      }
      return schema.listConcreteTypesAssignableTo(qualified).map((typeDef) => qualifiedTypeName(typeDef));
    }

    const left = new Set(concreteNamesForTypeExpr(expr.left));
    const right = new Set(concreteNamesForTypeExpr(expr.right));
    if (expr.kind === "type_union") {
      return [...new Set([...left, ...right])];
    }
    return [...left].filter((name) => right.has(name));
  };

  const rowMatchesTypeExpr = (row: ParsedRuntimeRow, fallbackType: string | undefined, expr: TypeExpr): boolean => {
    const rowType = rowTypeName(row, fallbackType);
    return concreteNamesForTypeExpr(expr).includes(rowType);
  };

  const scopedRowsForTypeName = (typeName: string, env: ParsedRuntimeEnv): ParsedRuntimeRow[] | undefined => {
    const qualified = qualifyType(typeName);
    if (!schema.getType(qualified)) {
      return undefined;
    }
    const matches = (row: ParsedRuntimeRow, fallbackType?: string): boolean => {
      const rowType = rowTypeName(row, fallbackType);
      return rowType === qualified
        || schema.listConcreteTypesAssignableTo(qualified).some((typeDef) => qualifiedTypeName(typeDef) === rowType);
    };

    if (env.row && matches(env.row, env.rowType)) {
      return [env.row];
    }
    if (env.outerRows) {
      for (let i = env.outerRows.length - 1; i >= 0; i -= 1) {
        const outer = env.outerRows[i]!;
        if (matches(outer.row, outer.rowType)) {
          return [outer.row];
        }
      }
    }
    return undefined;
  };

  const concreteTypeForRow = (baseTypeName: string, rowId: unknown): string => {
    if (typeof rowId !== "string") {
      return baseTypeName;
    }
    for (const candidate of schema.listConcreteTypesAssignableTo(baseTypeName)) {
      const candidateName = qualifiedTypeName(candidate);
      if (candidateName === baseTypeName) {
        continue;
      }
      const exists = db.prepare(`SELECT 1 FROM ${quoteIdent(tableNameForType(candidateName))} WHERE ${quoteIdent("id")} = ? LIMIT 1`).all(rowId).length > 0;
      if (exists) {
        return candidateName;
      }
    }
    for (const candidate of schema.listTypes()) {
      const candidateName = qualifiedTypeName(candidate);
      if (candidateName === baseTypeName) {
        continue;
      }
      const exists = db.prepare(`SELECT 1 FROM ${quoteIdent(tableNameForType(candidateName))} WHERE ${quoteIdent("id")} = ? LIMIT 1`).all(rowId).length > 0;
      if (exists) {
        return candidateName;
      }
    }
    return baseTypeName;
  };

  const countForwardLink = (row: ParsedRuntimeRow, typeName: string, linkName: string): number => {
    const resolved = findRuntimeLinkDef(schema, typeName, linkName);
    const sourceType = schema.getType(typeName);
    if (!resolved || !sourceType || typeof row.id !== "string") {
      return 0;
    }
    if (resolved.link.multi || (resolved.link.properties?.length ?? 0) > 0) {
      const owner = resolveLinkStorageOwner(schema, sourceType, resolved.link);
      const linkTable = `${tableNameForType(qualifiedTypeName(owner))}__${resolved.link.name.toLowerCase()}`;
      const result = db.prepare(`SELECT COUNT(DISTINCT ${quoteIdent("target")}) AS ${quoteIdent("count")} FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).all(row.id)[0] as { count?: unknown } | undefined;
      return Number(result?.count ?? 0);
    }
    return row[`${resolved.link.name}_id`] === null || row[`${resolved.link.name}_id`] === undefined ? 0 : 1;
  };

  const readForwardLink = (row: ParsedRuntimeRow, typeName: string, linkName: string): ParsedRuntimeRow[] => {
    const resolved = findRuntimeLinkDef(schema, typeName, linkName);
    if (!resolved || typeof row.id !== "string") {
      const typeDef = schema.getType(typeName);
      const computedLink = typeDef?.computeds?.find((computed) => computed.kind === "link" && computed.name === linkName);
      if (computedLink?.kind === "link" && computedLink.expr.kind === "backlink") {
        return readBacklink(row, rowTypeName(row, typeName), computedLink.expr.link, computedLink.expr.sourceType);
      }
      return [];
    }
    const sourceType = schema.getType(typeName);
    if (!sourceType) {
      return [];
    }
    const targetTypeNames = normalizeLinkTargetNames(resolved.link.targetType, sourceType.module ?? "default");
    const targetTypes = targetTypeNames.flatMap((targetTypeName) => schema.listConcreteTypesAssignableTo(targetTypeName));
    const readTargetTable = (targetType: TypeDef, targetIds: string[]): ParsedRuntimeRow[] => {
      if (targetIds.length === 0) {
        return [];
      }
      const placeholders = targetIds.map(() => "?").join(", ");
      const targetName = qualifiedTypeName(targetType);
      const rows = db.prepare(`SELECT * FROM ${quoteIdent(tableNameForType(targetName))} WHERE ${quoteIdent("id")} IN (${placeholders})`).all(...targetIds) as Record<string, unknown>[];
      return rows.map((targetRow) => ({ ...targetRow, __source_type: concreteTypeForRow(targetName, targetRow.id) }));
    };

    if (resolved.link.multi || (resolved.link.properties?.length ?? 0) > 0) {
      const owner = resolveLinkStorageOwner(schema, sourceType, resolved.link);
      const linkTable = `${tableNameForType(qualifiedTypeName(owner))}__${resolved.link.name.toLowerCase()}`;
      const linkRows = db.prepare(`SELECT * FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).all(row.id) as Array<Record<string, unknown> & { target?: unknown }>;
      const targetIds = linkRows.map((linkRow) => linkRow.target).filter((target): target is string => typeof target === "string");
      const rows = targetTypes.flatMap((targetType) => readTargetTable(targetType, targetIds));
      const propsByTarget = new Map<string, Record<string, unknown>>();
      for (const linkRow of linkRows) {
        if (typeof linkRow.target !== "string") continue;
        const props: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(linkRow)) {
          if (key !== "source" && key !== "target") {
            props[`@${key}`] = value ?? null;
          }
        }
        propsByTarget.set(linkRow.target, props);
      }
      return [...new Map(rows.map((targetRow) => {
        const properties = typeof targetRow.id === "string" ? propsByTarget.get(targetRow.id) ?? {} : {};
        const computedProperties = Object.fromEntries((resolved.link.computedProperties ?? []).map((property) => [
          `@${property.name}`,
          evaluateComputedLinkPropertyExpr(property.computedExpr, targetRow, properties),
        ]));
        return [String(targetRow.id), { ...targetRow, ...properties, ...computedProperties }] as const;
      })).values()];
    }

    const targetId = row[`${resolved.link.name}_id`];
    if (typeof targetId !== "string") {
      return [];
    }
    const rows = targetTypes.flatMap((targetType) => readTargetTable(targetType, [targetId]));
    return [...new Map(rows.map((targetRow) => [String(targetRow.id), targetRow] as const)).values()];
  };

  const readBacklink = (row: ParsedRuntimeRow, targetTypeName: string, linkName: string, sourceTypeFilter?: string, sourceTypeExpr?: TypeExpr): ParsedRuntimeRow[] => {
    if (typeof row.id !== "string") {
      return [];
    }
    const sourceTypes = sourceTypeExpr
      ? concreteNamesForTypeExpr(sourceTypeExpr).flatMap((name) => {
          const typeDef = schema.getType(name);
          return typeDef ? [typeDef] : [];
        })
      : sourceTypeFilter
        ? schema.listConcreteTypesAssignableTo(qualifyType(sourceTypeFilter))
        : schema.listTypes();
    const out: ParsedRuntimeRow[] = [];
    for (const sourceType of sourceTypes) {
      const sourceName = qualifiedTypeName(sourceType);
      const resolved = findRuntimeLinkDef(schema, sourceName, linkName);
      if (!resolved) {
        continue;
      }
      const targetTypeNames = normalizeLinkTargetNames(resolved.link.targetType, sourceType.module ?? "default");
      const canTarget = targetTypeNames.some((candidate) => candidate === targetTypeName || schema.listConcreteTypesAssignableTo(candidate).some((typeDef) => qualifiedTypeName(typeDef) === targetTypeName));
      if (!canTarget) {
        continue;
      }
      const sourceTable = tableNameForType(sourceName);
      const rows = resolved.link.multi || (resolved.link.properties?.length ?? 0) > 0
        ? (() => {
            const owner = resolveLinkStorageOwner(schema, sourceType, resolved.link);
            const linkTable = `${tableNameForType(qualifiedTypeName(owner))}__${resolved.link.name.toLowerCase()}`;
            const joined = db.prepare(`SELECT s.*, l.* FROM ${quoteIdent(sourceTable)} s JOIN ${quoteIdent(linkTable)} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`).all(row.id) as Record<string, unknown>[];
            return joined.map((joinedRow) => {
              const withProps: Record<string, unknown> = { ...joinedRow };
              for (const property of resolved.link.properties ?? []) {
                withProps[`@${property.name}`] = joinedRow[property.name] ?? null;
              }
              for (const [key, value] of Object.entries(joinedRow)) {
                if (key !== "source" && key !== "target" && !key.startsWith("__") && !Object.prototype.hasOwnProperty.call(withProps, `@${key}`)) {
                  withProps[`@${key}`] = value ?? null;
                }
              }
              return withProps;
            });
          })()
        : db.prepare(`SELECT * FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent(`${resolved.link.name}_id`)} = ?`).all(row.id) as Record<string, unknown>[];
      for (const sourceRow of rows) {
        out.push({ ...sourceRow, __source_type: concreteTypeForRow(sourceName, sourceRow.id) });
      }
    }
    return [...new Map(out.map((sourceRow) => [String(sourceRow.id), sourceRow] as const)).values()];
  };

  const evalBindings = (bindings: WithBinding[] | undefined, env: ParsedRuntimeEnv): Map<string, ParsedRuntimeRow[]> => {
    const next = new Map(env.bindings);
    for (const binding of bindings ?? []) {
      next.set(binding.name, evalBinding(binding.value, { ...env, bindings: next }));
      if (bindingValueProducesUnorderedScalarSet(binding.value)) {
        next.set(unorderedBindingKey(binding.name), []);
      } else {
        next.delete(unorderedBindingKey(binding.name));
      }
    }
    return next;
  };

  const unorderedBindingKey = (name: string): string => `__gel_unordered_binding__:${name}`;

  const bindingValueProducesUnorderedScalarSet = (value: WithBindingValue): boolean =>
    value.kind === "subquery_expr" && freeExprProducesUnorderedScalarSet(value.expr);

  const freeExprProducesUnorderedScalarSet = (expr: FreeObjectExpr): boolean => {
    if (expr.kind === "for_expr") return freeExprIsScalarSetBody(expr.body);
    if (expr.kind === "select_expr_subquery") return freeExprProducesUnorderedScalarSet(expr.expr);
    return false;
  };

  const freeExprIsScalarSetBody = (expr: FreeObjectExpr): boolean => {
    if (expr.kind === "binding_ref" || expr.kind === "literal" || expr.kind === "concat" || expr.kind === "tuple" || expr.kind === "cast") {
      return true;
    }
    if (expr.kind === "for_expr") return freeExprIsScalarSetBody(expr.body);
    if (expr.kind === "select_expr_subquery") return freeExprIsScalarSetBody(expr.expr);
    if (expr.kind === "distinct") return freeExprIsScalarSetBody(expr.expr);
    return false;
  };

  const evalBinding = (value: WithBindingValue, env: ParsedRuntimeEnv): ParsedRuntimeRow[] => {
    if (value.kind === "subquery_statement") {
      const rows = executeMutationBinding(db, schema, value.statement, context);
      return rows.map((r) => ({ ...r, __source_type: qualifyType(value.statement.typeName ?? "Object") }));
    }
    if (value.kind === "subquery") {
      return evalSelect(value.query.typeName, value.query.shape, value.query.clauses, env);
    }
    if (value.kind === "subquery_expr") {
      // Collect any clauses (orderBy/filter/limit/offset) carried on the
      // select_expr_subquery wrapper(s) so we can apply them after evaluating
      // the underlying SELECT. The parser stores LIMIT/ORDER BY on the
      // wrapper, not the SELECT statement itself, so naive unwrapping loses
      // those constraints.
      type WrapperClauses = {
        filter?: FreeObjectExpr;
        orderBy?: { expr: FreeObjectExpr; direction: "asc" | "desc"; nullsPosition?: "first" | "last" };
        limit?: number;
        offset?: number;
        alias?: string;
      };
      let inner: FreeObjectExpr = value.expr;
      const wrappers: WrapperClauses[] = [];
      while (inner.kind === "select_expr_subquery") {
        if (inner.filter || inner.orderBy || inner.limit !== undefined || inner.offset !== undefined) {
          wrappers.push({
            filter: inner.filter,
            orderBy: inner.orderBy as WrapperClauses["orderBy"],
            limit: inner.limit,
            offset: inner.offset,
            alias: inner.alias,
          });
        }
        inner = inner.expr;
      }
      if (inner.kind === "select") {
        let rows = evalSelect(inner.typeName, inner.shape, inner.clauses, env);
        for (let i = wrappers.length - 1; i >= 0; i -= 1) {
          const w = wrappers[i]!;
          if (w.filter) {
            const filter = w.filter;
            rows = rows.filter((row) => {
              const itemEnv = withInnerRow(env, row, rowTypeName(row, env.rowType));
              const fv = evalFreeExpr(filter, itemEnv);
              return Array.isArray(fv) ? fv.some(Boolean) : Boolean(fv);
            });
          }
          if (w.orderBy) {
            const orderBy = w.orderBy;
            rows = [...rows].sort((a, b) => compareByExprOrder(orderBy, a, b, env, w.alias));
          }
          const offset = w.offset ?? 0;
          if (w.limit !== undefined || offset > 0) {
            rows = w.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + w.limit);
          }
        }
        return rows;
      }
      const evaluated = evalFreeExpr(value.expr, env);
      if (Array.isArray(evaluated)) {
        return evaluated.flatMap((item): ParsedRuntimeRow[] => {
          if (isRecordRow(item)) return [item];
          return isScalarValue(item) || item === null ? [{ __scalar: item as ScalarValue }] : [];
        });
      }
      if (isScalarValue(evaluated) || evaluated === null) {
        return [{ __scalar: evaluated as ScalarValue }];
      }
      return isRecordRow(evaluated) ? [evaluated] : [];
    }
    if (value.kind === "binding_ref") {
      const qualifiedName = qualifyType(value.name);
      if (schema.getType(qualifiedName)) {
        const scopedRows = scopedRowsForTypeName(value.name, env);
        if (scopedRows) {
          return scopedRows;
        }
        return concreteRowsForType(value.name);
      }
    }
    if (value.kind === "backlink_path") {
      const row = env.row;
      const rowType = row ? rowTypeName(row, qualifyType(value.head)) : undefined;
      return row && rowType ? readBacklink(row, rowType, value.link, value.sourceType, value.sourceTypeExpr) : [];
    }
    if (value.kind === "path" && env.bindings.has(value.head)) {
      return env.bindings.get(value.head)!.map((row) => ({ __count: countForwardLink(row, rowTypeName(row), value.tail) }));
    }
    if (value.kind === "path") {
      const qualifiedHead = qualifyType(value.head);
      if (schema.getType(qualifiedHead)) {
        return concreteRowsForType(value.head).flatMap((row) => readForwardLink(row, rowTypeName(row, qualifiedHead), value.tail));
      }
    }
    if (value.kind === "path_chain" && value.parts.at(-2) === "__type__" && value.parts.at(-1) === "name" && env.row) {
      const baseType = rowTypeName(env.row, env.rowType);
      return [{ __scalar: concreteTypeForRow(baseType, env.row.id) }];
    }
    return [];
  };

  const extractIterationPath = (expr: FreeObjectExpr): { typeName: string; steps: string[] } | undefined => {
    if (expr.kind === "shape_projection") return extractIterationPath(expr.expr);
    if (expr.kind === "select_expr_subquery") return extractIterationPath(expr.expr);
    if (expr.kind === "distinct") return extractIterationPath(expr.expr);
    if (expr.kind === "for_expr") return extractIterationPath(expr.body);
    if (expr.kind === "field_access") {
      const inner = extractIterationPath(expr.expr);
      if (!inner) return undefined;
      return { typeName: inner.typeName, steps: [...inner.steps, expr.field] };
    }
    if (expr.kind === "select") {
      return { typeName: expr.typeName, steps: [] };
    }
    if (expr.kind === "path_steps") {
      const first = expr.steps[0];
      if (!first || first.kind !== "object_ref") return undefined;
      const steps: string[] = [];
      for (const step of expr.steps.slice(1)) {
        if (step.kind === "ptr" && step.direction !== "inbound") {
          steps.push(step.name);
        } else {
          return undefined;
        }
      }
      return { typeName: first.name, steps };
    }
    return undefined;
  };

  const extractCurrentItemIterationPath = (expr: FreeObjectExpr, env: ParsedRuntimeEnv): { typeName: string; steps: string[] } | undefined => {
    if (!env.rowType && !env.row) return undefined;
    if (expr.kind === "shape_projection") return extractCurrentItemIterationPath(expr.expr, env);
    if (expr.kind === "select_expr_subquery") return extractCurrentItemIterationPath(expr.expr, env);
    if (expr.kind === "distinct") return extractCurrentItemIterationPath(expr.expr, env);
    if (expr.kind === "for_expr") return extractCurrentItemIterationPath(expr.body, env);
    if (expr.kind === "field_access") {
      const inner = extractCurrentItemIterationPath(expr.expr, env);
      if (!inner) return undefined;
      return { typeName: inner.typeName, steps: [...inner.steps, expr.field] };
    }
    if (expr.kind === "current_item") {
      return { typeName: unqualifiedRuntimeTypeName(env.rowType ?? (env.row ? rowTypeName(env.row) : undefined)) ?? "Object", steps: [] };
    }
    return undefined;
  };

  const freeExprStructurallyEqual = (left: FreeObjectExpr | undefined, right: FreeObjectExpr | undefined): boolean => {
    if (!left || !right) return left === right;
    if (left.kind !== right.kind) return false;
    if (left.kind === "path_steps" && right.kind === "path_steps") {
      if (left.steps.length !== right.steps.length) return false;
      for (let i = 0; i < left.steps.length; i += 1) {
        const ls = left.steps[i]!;
        const rs = right.steps[i]!;
        if (ls.kind !== rs.kind) return false;
        if (ls.kind === "object_ref" && rs.kind === "object_ref") {
          if (ls.name !== rs.name) return false;
          continue;
        }
        if (ls.kind === "ptr" && rs.kind === "ptr") {
          if (ls.name !== rs.name || ls.direction !== rs.direction) return false;
          if ((ls.typeFilter ?? "") !== (rs.typeFilter ?? "")) return false;
          continue;
        }
        if (ls.kind === "type_intersection" && rs.kind === "type_intersection") {
          if ((ls.typeName ?? "") !== (rs.typeName ?? "")) return false;
          continue;
        }
        return false;
      }
      return true;
    }
    if (left.kind === "binding_ref" && right.kind === "binding_ref") {
      return left.name === right.name;
    }
    if (left.kind === "field_access" && right.kind === "field_access") {
      return left.field === right.field && freeExprStructurallyEqual(left.expr, right.expr);
    }
    if (left.kind === "backlink_path" && right.kind === "backlink_path") {
      return left.link === right.link && (left.sourceType ?? "") === (right.sourceType ?? "");
    }
    if (left.kind === "for_expr" && right.kind === "for_expr") {
      return freeExprStructurallyEqual(left.iterator, right.iterator) && freeExprStructurallyEqual(left.body, right.body);
    }
    if (left.kind === "select" && right.kind === "select") {
      return left.typeName === right.typeName;
    }
    return false;
  };

  const innerExprProducesMultiSet = (expr: FreeObjectExpr): boolean => {
    if (expr.kind === "tuple" || expr.kind === "array_literal_expr" || expr.kind === "slice_access") return true;
    if (expr.kind === "index_access") return innerExprProducesMultiSet(expr.expr);
    if (expr.kind === "field_access") {
      // Field access on a type scope where the field is a multi link
      // (e.g. `Issue.time_spent_log`) or multi property (`Item.tag_set1`)
      // produces a multi-set. Detect that explicitly so downstream callers
      // don't unwrap a single-element result back to a scalar.
      if (expr.expr.kind === "select") {
        const typeName = qualifyRuntimeTypeName(expr.expr.typeName, statement.withModule ?? "default");
        const linkDef = findRuntimeLinkDef(schema, typeName, expr.field);
        if (linkDef?.link.multi) return true;
        const fieldDef = findFieldDef(schema, typeName, expr.field);
        if (fieldDef?.multi) return true;
      }
      if (expr.expr.kind === "current_item") {
        // The current_item's source type isn't known here; the caller's
        // context already established it's the outer subject — fall through
        // and treat as recursive.
      }
      return innerExprProducesMultiSet(expr.expr);
    }
    if (expr.kind === "select_expr_subquery") {
      if (expr.limit !== undefined) return false;
      return innerExprProducesMultiSet(expr.expr);
    }
    if (expr.kind === "for_expr") return true;
    if (expr.kind === "backlink_path") return true;
    if (expr.kind === "set_expr") return true;
    if (expr.kind === "distinct") return innerExprProducesMultiSet(expr.expr);
    if (expr.kind === "shape_projection") return innerExprProducesMultiSet(expr.expr);
    // `array_unpack(...)` / `range_unpack(...)` produce a set of array
    // elements — single-element results must stay wrapped in an array.
    if (expr.kind === "function_call"
      && (expr.call.name === "array_unpack" || expr.call.name === "std::array_unpack"
        || expr.call.name === "range_unpack" || expr.call.name === "std::range_unpack")) {
      return true;
    }
    // Comparisons (?=, ?!=, =, !=, etc.) inherit multi-ness from their
    // operands — `multi ?= scalar` produces N booleans.
    if (expr.kind === "compare") {
      return innerExprProducesMultiSet(expr.left) || innerExprProducesMultiSet(expr.right);
    }
    if (expr.kind === "coalesce") {
      return innerExprProducesMultiSet(expr.left) || innerExprProducesMultiSet(expr.right);
    }
    return false;
  };

  function compareByExprOrder(orderBy: OrderExprChain, a: unknown, b: unknown, env: ParsedRuntimeEnv, alias?: string): number {
    const evalSortValue = (item: unknown): unknown => {
      if (
        Array.isArray(item)
        && orderBy.expr.kind === "index_access"
        && orderBy.expr.expr.kind === "current_item"
      ) {
        return item[orderBy.expr.index] ?? null;
      }

      const bindings = new Map(env.bindings);
      if (alias) {
        bindings.set(alias, [isRecordRow(item) ? item : { __scalar: item as ScalarValue }]);
      }
      const itemEnv = isRecordRow(item)
        ? withInnerRow(env, item, rowTypeName(item, env.rowType), { bindings })
        : { ...env, bindings };
      return evalFreeExpr(orderBy.expr, itemEnv);
    };
    const left = evalSortValue(a);
    const right = evalSortValue(b);
    const leftScalar = Array.isArray(left) && left.length === 1 ? left[0] : left;
    const rightScalar = Array.isArray(right) && right.length === 1 ? right[0] : right;
    const direction = orderBy.direction === "desc" ? -1 : 1;
    const comparison = typeof leftScalar === "number" && typeof rightScalar === "number"
      ? leftScalar === rightScalar ? 0 : leftScalar < rightScalar ? -1 : 1
      : String(leftScalar ?? "").localeCompare(String(rightScalar ?? ""));
    if (comparison !== 0) {
      return comparison * direction;
    }
    return orderBy.then ? compareByExprOrder(orderBy.then, a, b, env, alias) : 0;
  }

  const evalFreeExpr = (expr: FreeObjectExpr, env: ParsedRuntimeEnv): unknown => {
    if (expr.kind === "literal") {
      return expr.value;
    }
    if (expr.kind === "set_literal") {
      return [...expr.values];
    }
    if (expr.kind === "set_expr") {
      return expr.values.flatMap((value) => {
        const evaluated = evalFreeExpr(value, env);
        if (value.kind === "tuple") {
          if (Array.isArray(evaluated) && evaluated.every(Array.isArray)) {
            return evaluated;
          }
          return [evaluated];
        }
        return Array.isArray(evaluated) ? evaluated : [evaluated];
      });
    }
    if (expr.kind === "path_steps") {
      const first = expr.steps[0];
      if (!first || first.kind !== "object_ref") return [];
      const qualifiedFirst = qualifyType(first.name);
      const matchesType = (typeQualified: string | undefined): boolean => {
        if (!typeQualified) return false;
        if (typeQualified === qualifiedFirst) return true;
        return schema.listConcreteTypesAssignableTo(qualifiedFirst).some((t) => qualifiedTypeName(t) === typeQualified);
      };

      if (env.iterationSource && env.row && freeExprStructurallyEqual(expr, env.iterationSource)) {
        return env.row;
      }

      if (env.iterationPath && env.row && env.iterationPath.typeName === first.name) {
        const ptrSteps = expr.steps.slice(1);
        const ptrNames: string[] = [];
        for (const step of ptrSteps) {
          if (step.kind === "ptr" && step.direction !== "inbound") {
            ptrNames.push(step.name);
          } else {
            break;
          }
        }
        const iterSteps = env.iterationPath.steps;
        if (ptrNames.length >= iterSteps.length
          && iterSteps.every((s, i) => s === ptrNames[i])) {
          let current: ParsedRuntimeRow[] = [env.row as ParsedRuntimeRow];
          let currentType = rowTypeName(env.row, env.rowType);
          const remainingSteps = ptrSteps.slice(iterSteps.length);
          let followedInboundPointer = false;
          for (let stepIndex = 0; stepIndex < remainingSteps.length; stepIndex += 1) {
            const step = remainingSteps[stepIndex]!;
            if (step.kind === "type_intersection" && step.typeExpr) {
              const typeExpr = step.typeExpr;
              current = current.filter((row) => rowMatchesTypeExpr(row, currentType, typeExpr));
              continue;
            }
            if (step.kind === "type_intersection") {
              const typeExpr: TypeExpr = { kind: "type_name", name: step.typeName };
              current = current.filter((row) => rowMatchesTypeExpr(row, currentType, typeExpr));
              currentType = qualifyType(step.typeName);
              continue;
            }
            if (step.kind === "ptr") {
              if (step.direction !== "inbound" && stepIndex === remainingSteps.length - 1) {
                const fieldValues = readPresentFieldValues(current, step.name);
                if (fieldValues) return fieldValues;
              }
              if (step.direction === "inbound") followedInboundPointer = true;
              current = current.flatMap((row) => step.direction === "inbound"
                ? readBacklink(row, rowTypeName(row, currentType), step.name, step.typeFilter, step.typeFilterExpr)
                : readForwardLink(row, rowTypeName(row, currentType), step.name));
            }
          }
          if (remainingSteps.length === 0) {
            return current[0] ?? null;
          }
          if (followedInboundPointer) {
            return [...new Map(current.map((row) => [typeof row.id === "string" ? row.id : JSON.stringify(row), row] as const)).values()];
          }
          // If the last step is a scalar pointer, the readForwardLink path returns rows wrapping the scalar.
          // Defer to the existing tail unwrapping below by falling through.
          if (current.length === 1) return current[0];
          return current;
        }
      }

      const rowTypeQualified = env.row ? rowTypeName(env.row, env.rowType) : undefined;
      let scopedRow: ParsedRuntimeRow | undefined;
      if (env.row && matchesType(rowTypeQualified)) {
        scopedRow = env.row as ParsedRuntimeRow;
      } else if (env.outerRows) {
        for (let i = env.outerRows.length - 1; i >= 0; i -= 1) {
          const outer = env.outerRows[i];
          if (matchesType(rowTypeName(outer.row, outer.rowType))) {
            scopedRow = outer.row;
            break;
          }
        }
      }
      let current = env.bindings.get(first.name)
        ?? (scopedRow ? [scopedRow] : concreteRowsForType(first.name));
      let currentType = qualifiedFirst;
      let followedInboundPointer = false;
      const pathSteps = expr.steps.slice(1);
      for (let stepIndex = 0; stepIndex < pathSteps.length; stepIndex += 1) {
        const step = pathSteps[stepIndex]!;
        if (step.kind === "type_intersection" && step.typeExpr) {
          const typeExpr = step.typeExpr;
          current = current.filter((row) => rowMatchesTypeExpr(row, currentType, typeExpr));
          continue;
        }
        if (step.kind === "type_intersection") {
          const typeExpr: TypeExpr = { kind: "type_name", name: step.typeName };
          current = current.filter((row) => rowMatchesTypeExpr(row, currentType, typeExpr));
          currentType = qualifyType(step.typeName);
          continue;
        }
        if (step.kind === "ptr") {
          if (step.direction !== "inbound" && stepIndex === pathSteps.length - 1) {
            const fieldValues = readPresentFieldValues(current, step.name);
            if (fieldValues) return fieldValues;
          }
          if (step.direction === "inbound") {
            followedInboundPointer = true;
          }
          current = current.flatMap((row) => step.direction === "inbound"
            ? readBacklink(row, rowTypeName(row, currentType), step.name, step.typeFilter, step.typeFilterExpr)
            : readForwardLink(row, rowTypeName(row, currentType), step.name));
        }
      }
      if (followedInboundPointer) {
        return [...new Map(current.map((row) => [typeof row.id === "string" ? row.id : JSON.stringify(row), row] as const)).values()];
      }
      return current;
    }
    if (expr.kind === "distinct") {
      const value = evalFreeExpr(expr.expr, env);
      if (!Array.isArray(value)) return value;
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of value) {
        const key = item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string"
          ? `id:${String((item as Record<string, unknown>).id)}`
          : JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(item);
        }
      }
      return out;
    }
    if (expr.kind === "binding_ref") {
      const bound = env.bindings.get(expr.name);
      if (!bound) {
        return [];
      }
      if (bound.every((row) => Object.prototype.hasOwnProperty.call(row, "__scalar"))) {
        const values = bound.map((row) => row.__scalar);
        return values.length === 1 ? values[0] : values;
      }
      return bound;
    }
    if (expr.kind === "path" && env.bindings.has(expr.head)) {
      const values = env.bindings.get(expr.head)!.map((row) => row[expr.tail] ?? null);
      return values.length === 1 ? values[0] : values;
    }
    if (expr.kind === "current_item") {
      return env.row ?? null;
    }
    if (expr.kind === "select") {
      const bound = env.bindings.get(expr.typeName);
      if (bound && !schema.getType(qualifyType(expr.typeName))) {
        const boundType = qualifyType(expr.typeName);
        let rows = bound.filter((row) => evalFilter(row, rowTypeName(row, boundType), expr.clauses.filter, { ...env, row, rowType: rowTypeName(row, boundType) }));
        if (expr.clauses.orderBy?.field) {
          rows = [...rows].sort((a, b) => compareRowsByOrder(a, b, expr.clauses.orderBy!));
        }
        if (expr.clauses.offset !== undefined) rows = rows.slice(expr.clauses.offset);
        if (expr.clauses.limit !== undefined) rows = rows.slice(0, expr.clauses.limit);
        const explicitShape = expr.shape.filter((element) => !(element.kind === "field" && element.name === "id" && element.origin === "default"));
        if (explicitShape.length === 0) return rows;
        return rows.map((row) => {
          const rowBindings = new Map(env.bindings);
          rowBindings.set(expr.typeName, [row]);
          return materialize(row, rowTypeName(row, boundType), explicitShape, { ...env, bindings: rowBindings, row, rowType: rowTypeName(row, boundType) });
        });
      }
      if (bound) {
        if (expr.clauses.filter) {
          const qualifiedType = qualifyType(expr.typeName);
          const passes = bound.filter((row) => evalFilter(row, rowTypeName(row, qualifiedType), expr.clauses.filter, env));
          return passes;
        }
        return bound;
      }
      if (env.outerRows && expr.typeName === statement.typeName) {
        const qualifiedType = qualifyType(expr.typeName);
        const assignable = new Set(schema.listConcreteTypesAssignableTo(qualifiedType).map((typeDef) => qualifiedTypeName(typeDef)));
        for (let i = env.outerRows.length - 1; i >= 0; i -= 1) {
          const outer = env.outerRows[i]!;
          const outerType = rowTypeName(outer.row, outer.rowType);
          if (outerType !== qualifiedType && !assignable.has(outerType)) continue;
          if (expr.clauses.filter) {
            const passes = evalFilter(outer.row, outerType, expr.clauses.filter, { ...env, row: outer.row, rowType: outerType });
            return passes ? outer.row : [];
          }
          return outer.row;
        }
      }
      if (env.row) {
        const qualifiedType = qualifyType(expr.typeName);
        const rowType = rowTypeName(env.row, env.rowType);
        const assignable = new Set(schema.listConcreteTypesAssignableTo(qualifiedType).map((typeDef) => qualifiedTypeName(typeDef)));
        if (rowType === qualifiedType || assignable.has(rowType)) {
          if (expr.clauses.filter) {
            const passes = evalFilter(env.row, rowType, expr.clauses.filter, env);
            return passes ? env.row : [];
          }
          return env.row;
        }
      }
      if (env.outerRows) {
        const qualifiedType = qualifyType(expr.typeName);
        const assignable = new Set(schema.listConcreteTypesAssignableTo(qualifiedType).map((typeDef) => qualifiedTypeName(typeDef)));
        for (let i = env.outerRows.length - 1; i >= 0; i -= 1) {
          const outer = env.outerRows[i]!;
          const outerType = rowTypeName(outer.row, outer.rowType);
          if (outerType !== qualifiedType && !assignable.has(outerType)) {
            continue;
          }
          if (expr.clauses.filter) {
            const passes = evalFilter(outer.row, outerType, expr.clauses.filter, { ...env, row: outer.row, rowType: outerType });
            return passes ? outer.row : [];
          }
          return outer.row;
        }
      }
      return evalSelect(expr.typeName, expr.shape, expr.clauses, env).map((row) => materialize(row, rowTypeName(row, qualifyType(expr.typeName)), expr.shape, env));
    }
    if (expr.kind === "exists") {
      const value = evalFreeExpr(expr.expr, env);
      if (Array.isArray(value)) return value.length > 0;
      return value !== null && value !== undefined;
    }
    if (expr.kind === "backlink_path") {
      return env.row ? readBacklink(env.row, rowTypeName(env.row, env.rowType), expr.link, expr.sourceType, expr.sourceTypeExpr) : [];
    }
    if (expr.kind === "field_access") {
      // Multi-properties, arrays, and tuples are all stored as JSON text in
      // the row. Materialize them so set semantics (`IN`, `count(...)`,
      // element-wise `=`, …) see the actual elements rather than the raw
      // JSON string. `set_11`-style `array_agg(...) = array_agg(...)` over
      // empty sets is a known regression; tests that depend on raw JSON-
      // string equality from non-materialized field reads need a different
      // path to pass once `array_agg` returns a true single-value array.
      const readStoredField = (row: ParsedRuntimeRow, sourceType: string): unknown => {
        const raw = row[expr.field] ?? null;
        return materializeFieldValue(schema, sourceType, expr.field, raw);
      };
      if (env.iterationPath && env.row) {
        const innerPath = extractIterationPath(expr.expr);
        if (
          innerPath
          && innerPath.typeName === env.iterationPath.typeName
          && innerPath.steps.length === env.iterationPath.steps.length
          && innerPath.steps.every((s, i) => s === env.iterationPath!.steps[i])
        ) {
          const row = env.row as ParsedRuntimeRow;
          if (Object.prototype.hasOwnProperty.call(row, expr.field)) return readStoredField(row, rowTypeName(row, env.rowType));
          const sourceType = rowTypeName(row, env.rowType);
          const linked = readForwardLink(row, sourceType, expr.field);
          return linked.length > 0 ? linked : null;
        }
      }
      const base = evalFreeExpr(expr.expr, env);
      const read = (item: unknown): unknown => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const row = item as ParsedRuntimeRow;
        const sourceType = rowTypeName(row, env.rowType);
        if (Object.prototype.hasOwnProperty.call(row, expr.field)) return readStoredField(row, sourceType);
        const linked = readForwardLink(row, sourceType, expr.field);
        if (linked.length > 0) {
          return linked;
        }
        const computed = schema.getType(sourceType)?.computeds?.find((candidate) => candidate.kind === "property" && candidate.name === expr.field);
        if (computed?.kind === "property" && computed.expr.kind === "literal") {
          return computed.expr.value;
        }
        if (computed?.kind === "property" && computed.expr.kind === "set_literal") {
          return [...computed.expr.values];
        }
        if (computed?.kind === "property" && computed.expr.kind === "link_aggregate") {
          const aggregateExpr = computed.expr;
          const linkRows = readForwardLink(row, sourceType, aggregateExpr.link);
          const fieldValues = readPresentFieldValues(linkRows, aggregateExpr.field) ?? linkRows.flatMap((linkRow) => {
            const value = readForwardLink(linkRow, rowTypeName(linkRow), aggregateExpr.field);
            return value.length > 0 ? value : [];
          });
          return evaluateRuntimeAggregate(aggregateExpr.functionName, fieldValues);
        }
        // Shape-level computed (e.g. `unique := count(...)` declared in
        // the outer SELECT shape) referenced from within a FILTER. The
        // computed value isn't on the row yet — evaluate the shape
        // element's expression against the current row on demand.
        const shapeComputed = statement.shape.find((element) =>
          element.kind === "computed" && element.name === expr.field);
        if (shapeComputed && shapeComputed.kind === "computed"
          && !shapeComputedInProgress.has(expr.field)) {
          // Bind the subject type name so the shape expression's
          // `Item.tag_set1` resolves to *this* row's tag_set1.
          const innerBindings = new Map(env.bindings);
          innerBindings.set(statement.typeName, [row]);
          const shortType = statement.typeName.includes("::")
            ? statement.typeName.split("::").at(-1)
            : undefined;
          if (shortType) innerBindings.set(shortType, [row]);
          const innerEnv = withInnerRow(env, row, rowTypeName(row, env.rowType), { bindings: innerBindings });
          shapeComputedInProgress.add(expr.field);
          try {
            return evalComputed(shapeComputed.expr, innerEnv, Boolean(shapeComputed.multi));
          } finally {
            shapeComputedInProgress.delete(expr.field);
          }
        }
        return null;
      };
      if (Array.isArray(base)) {
        if (base.length === 1 && isRecordRow(base[0])) {
          const sourceType = rowTypeName(base[0], env.rowType);
          const field = findFieldDef(schema, sourceType, expr.field);
          const link = findRuntimeLinkDef(schema, sourceType, expr.field);
          if (!field?.multi && !link?.link.multi) {
            return read(base[0]);
          }
        }
        return base.flatMap((item) => {
          const value = read(item);
          return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
        });
      }
      return read(base);
    }
    if (expr.kind === "for_expr") {
      if (env.iterationSource && env.row && freeExprStructurallyEqual(expr, env.iterationSource)) {
        return env.row;
      }
      const iterator = evalFreeExpr(expr.iterator, env);
      let items = Array.isArray(iterator) ? iterator : [iterator];
      if (expr.optional && items.length === 0) {
        items = [null];
      }
      let mapped = items.flatMap((item) => {
        const bindings = new Map(env.bindings);
        let scopedEnv = env;
        if (isRecordRow(item)) {
          bindings.set(expr.variable, [item]);
          const itemType = rowTypeName(item, env.rowType);
          scopedEnv = { ...env, row: item, rowType: itemType, bindings };
        } else {
          bindings.set(expr.variable, [{ __scalar: item }]);
          scopedEnv = { ...env, bindings };
        }
        const value = evalFreeExpr(expr.body, scopedEnv);
        let bodyItems = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
        if (expr.filter) {
          const iterationPath = extractIterationPath(expr.body) ?? extractCurrentItemIterationPath(expr.body, scopedEnv);
          bodyItems = bodyItems.filter((bodyItem) => {
            const bodyEnv = isRecordRow(bodyItem)
              ? withInnerRow(scopedEnv, bodyItem, rowTypeName(bodyItem, scopedEnv.rowType), { iterationPath })
              : scopedEnv;
            const filterValue = evalFreeExpr(expr.filter!, bodyEnv);
            return Array.isArray(filterValue) ? filterValue.some(Boolean) : Boolean(filterValue);
          });
        }
        return bodyItems;
      });
      if (expr.orderBy) {
        mapped = [...mapped].sort((a, b) => compareByExprOrder(expr.orderBy!, a, b, env));
      }
      if (expr.offset !== undefined || expr.limit !== undefined) {
        const offset = expr.offset ?? 0;
        mapped = expr.limit === undefined ? mapped.slice(offset) : mapped.slice(offset, offset + expr.limit);
      }
      if (expr.body.kind === "backlink_path") {
        return [...new Map(mapped
          .filter(isRecordRow)
          .map((row) => [typeof row.id === "string" ? row.id : JSON.stringify(row), row] as const))
          .values()];
      }
      return mapped;
    }
    if (expr.kind === "is_type") {
      const typeExpr = expr.typeExpr ?? { kind: "type_name" as const, name: expr.typeName };
      const value = evalFreeExpr(expr.expr, env);
      if (Array.isArray(value)) {
        return value.filter((item) => isRecordRow(item) && rowMatchesTypeExpr(item, env.rowType, typeExpr));
      }
      if (isRecordRow(value)) {
        return rowMatchesTypeExpr(value, env.rowType, typeExpr) ? value : [];
      }
      return false;
    }
    const exprIsArrayField = (value: FreeObjectExpr): boolean => {
      if (value.kind !== "field_access") return false;
      const base = evalFreeExpr(value.expr, env);
      const baseRow = Array.isArray(base) ? base[0] : base;
      const sourceType = isRecordRow(baseRow) ? rowTypeName(baseRow, env.rowType) : env.rowType;
      return Boolean(sourceType && findFieldDef(schema, sourceType, value.field)?.collection?.kind === "array");
    };
    const exprProducesSet = (value: FreeObjectExpr): boolean => {
      if (value.kind === "tuple" || value.kind === "array_literal_expr" || value.kind === "set_expr" || value.kind === "for_expr" || value.kind === "backlink_path") return true;
      if (value.kind === "index_access" || value.kind === "slice_access") return exprProducesSet(value.expr);
      if (value.kind !== "field_access") return false;
      const base = evalFreeExpr(value.expr, env);
      const baseRow = Array.isArray(base) ? base[0] : base;
      const sourceType = isRecordRow(baseRow) ? rowTypeName(baseRow, env.rowType) : env.rowType;
      if (!sourceType) return false;
      const field = findFieldDef(schema, sourceType, value.field);
      if (field?.multi) return true;
      const link = findRuntimeLinkDef(schema, sourceType, value.field);
      return Boolean(link?.link.multi);
    };
    if (expr.kind === "array_literal_expr") {
      const evaluated = expr.values.map((value) => ({ expr: value, value: evalFreeExpr(value, env) }));
      const sets = evaluated.map((entry) => Array.isArray(entry.value) && exprProducesSet(entry.expr) && !exprIsArrayField(entry.expr) ? entry.value : [entry.value]);
      if (!sets.some((items) => items.length !== 1)) {
        return evaluated.map((entry) => entry.value);
      }
      return sets.reduce<unknown[][]>(
        (rows, items) => rows.flatMap((row) => items.map((item) => [...row, item])),
        [[]],
      );
    }
    if (expr.kind === "compare") {
      const left = evalFreeExpr(expr.left, env);
      const right = evalFreeExpr(expr.right, env);
      const isEmpty = (v: unknown): boolean => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
      const leftItems = Array.isArray(left) ? left : [left];
      const rightItems = Array.isArray(right) ? right : [right];
      const comparable = (value: unknown): unknown => isRecordRow(value) && typeof value.id === "string" ? value.id : value;
      if (expr.op === "?=" || expr.op === "?!=") {
        const leftEmpty = isEmpty(left);
        const rightEmpty = isEmpty(right);
        if (leftEmpty && rightEmpty) return expr.op === "?=";
        if (leftEmpty) {
          // LHS empty, RHS has N elements — produce N booleans matching
          // the non-empty side's cardinality (?= => false, ?!= => true).
          const v = expr.op === "?!=";
          return Array.isArray(right) ? rightItems.map(() => v) : v;
        }
        if (rightEmpty) {
          const v = expr.op === "?!=";
          return Array.isArray(left) ? leftItems.map(() => v) : v;
        }
        // Both non-empty: element-wise (cartesian) comparison, returning a
        // boolean per pair so multi-link ?= scalar yields N booleans.
        const out: boolean[] = [];
        for (const l of leftItems) {
          for (const r of rightItems) {
            const eq = comparable(l) === comparable(r);
            out.push(expr.op === "?=" ? eq : !eq);
          }
        }
        return (Array.isArray(left) || Array.isArray(right)) ? out : out[0] ?? false;
      }
      // EdgeQL set semantics: a comparison with an empty operand yields
      // empty (null in this evaluator).  `?=` / `?!=` above already short-
      // circuit on emptiness; the regular operators must propagate.
      if (isEmpty(left) || isEmpty(right)) return null;
      return leftItems.some((leftItem) => rightItems.some((rightItem) => {
        const comparableLeft = comparable(leftItem);
        const comparableRight = comparable(rightItem);
        if (expr.op === "=") return comparableLeft === comparableRight;
        if (expr.op === "!=") return comparableLeft !== comparableRight;
        // String operands compare lexicographically; everything else
        // promotes to Number (matches EdgeQL int/float ordering).
        if (typeof leftItem === "string" && typeof rightItem === "string") {
          const cmp = leftItem.localeCompare(rightItem);
          if (expr.op === ">") return cmp > 0;
          if (expr.op === ">=") return cmp >= 0;
          if (expr.op === "<=") return cmp <= 0;
          return cmp < 0;
        }
        if (expr.op === ">") return Number(leftItem) > Number(rightItem);
        if (expr.op === ">=") return Number(leftItem) >= Number(rightItem);
        if (expr.op === "<=") return Number(leftItem) <= Number(rightItem);
        return Number(leftItem) < Number(rightItem);
      }));
    }
    if (expr.kind === "in_expr") {
      // `x IN set_y` / `x NOT IN set_y`: true iff `x` equals any element of
      // the set produced by `right`. EdgeQL set semantics: when `left` is
      // multi, emit one boolean per element so the surrounding filter
      // expands to per-element matches.
      //
      // Multi-property fields are stored as JSON-text in the row and
      // field_access returns them raw to keep array/tuple equality working.
      // For the RHS of `IN`, that text needs to be parsed into the actual
      // set of elements; otherwise `'plastic' IN .tag_set1` checks against
      // the literal string `'["plastic","round"]'`.
      const materializeMultiSet = (e: FreeObjectExpr, value: unknown): unknown => {
        if (typeof value !== "string") return value;
        if (e.kind !== "field_access") return value;
        const row = env.row as ParsedRuntimeRow | undefined;
        const sourceType = row ? rowTypeName(row, env.rowType) : env.rowType;
        if (!sourceType) return value;
        const field = findFieldDef(schema, sourceType, e.field);
        if (!field?.multi) return value;
        return materializeFieldValue(schema, sourceType, e.field, value);
      };
      const left = evalFreeExpr(expr.left, env);
      const right = materializeMultiSet(expr.right, evalFreeExpr(expr.right, env));
      const rightItems = Array.isArray(right) ? right : right === null || right === undefined ? [] : [right];
      const comparable = (value: unknown): unknown => isRecordRow(value) && typeof value.id === "string" ? value.id : value;
      const leftIsSet = Array.isArray(left);
      const leftItems = leftIsSet ? left : [left];
      const checkOne = (item: unknown): boolean => {
        const target = comparable(item);
        const has = rightItems.some((candidate) => comparable(candidate) === target);
        return expr.op === "not_in" ? !has : has;
      };
      if (!leftIsSet) {
        return checkOne(left);
      }
      return leftItems.map(checkOne);
    }
    if (expr.kind === "and") {
      return Boolean(evalFreeExpr(expr.left, env)) && Boolean(evalFreeExpr(expr.right, env));
    }
    if (expr.kind === "or") {
      return Boolean(evalFreeExpr(expr.left, env)) || Boolean(evalFreeExpr(expr.right, env));
    }
    if (expr.kind === "not") {
      return !(evalFreeExpr(expr.expr, env));
    }
    if (expr.kind === "logical") {
      const left = Boolean(evalFreeExpr(expr.left, env));
      const right = Boolean(evalFreeExpr(expr.right, env));
      return expr.op === "and" ? (left && right) : (left || right);
    }
    if (expr.kind === "unary") {
      const inner = evalFreeExpr(expr.expr, env);
      const scalar = Array.isArray(inner) && inner.length === 1 ? inner[0] : inner;
      if (expr.op === "not") return !scalar;
      if (expr.op === "neg") return -Number(scalar);
      return null;
    }
    if (expr.kind === "math") {
      const left = evalFreeExpr(expr.left, env);
      const right = evalFreeExpr(expr.right, env);
      const leftNum = Number(Array.isArray(left) ? left[0] : left);
      const rightNum = Number(Array.isArray(right) ? right[0] : right);
      switch (expr.op) {
        case "+": return leftNum + rightNum;
        case "-": return leftNum - rightNum;
        case "*": return leftNum * rightNum;
        case "/": return normalizeRuntimeFloat(leftNum / rightNum);
        case "//": return Math.floor(leftNum / rightNum);
        case "%": return leftNum % rightNum;
        case "^": return Math.pow(leftNum, rightNum);
        default: return null;
      }
    }
    if (expr.kind === "if_else") {
      const cond = evalFreeExpr(expr.condition, env);
      const scalarCond = Array.isArray(cond) && cond.length === 1 ? cond[0] : cond;
      return scalarCond ? evalFreeExpr(expr.thenExpr, env) : evalFreeExpr(expr.elseExpr, env);
    }
    if (expr.kind === "tuple") {
      const values = expr.values.map((value) => evalFreeExpr(value, env));
      if (!values.some((value) => Array.isArray(value))) {
        return values;
      }
      return values.reduce<unknown[][]>(
        (rows, value) => {
          const items = Array.isArray(value) ? value : [value];
          return rows.flatMap((row) => items.map((item) => [...row, item]));
        },
        [[]],
      );
    }
    if (expr.kind === "free_object_constructor") {
      return Object.fromEntries(expr.entries.map((entry) => [entry.name, evalFreeExpr(entry.expr, env)]));
    }
    if (expr.kind === "cast") {
      const value = evalFreeExpr(expr.expr, env);
      if (expr.castType === "str" || expr.castType === "std::str") {
        return Array.isArray(value)
          ? value.map((item) => String(item ?? ""))
          : String(value ?? "");
      }
      return value;
    }
    if (expr.kind === "concat") {
      let results: unknown[] = [""];
      for (const part of expr.parts) {
        const partValue = evalFreeExpr(part, env);
        const partItems = Array.isArray(partValue) ? partValue : [partValue];
        if (partItems.length === 0) {
          return [];
        }
        const next: unknown[] = [];
        for (const left of results) {
          for (const right of partItems) {
            if (right === null || right === undefined) {
              continue;
            }
            next.push(`${left as string}${String(right)}`);
          }
        }
        results = next;
      }
      return results;
    }
    if (expr.kind === "index_access") {
      const rawIndex = expr.indexExpr ? evalFreeExpr(expr.indexExpr, env) : expr.index;
      const indexes = Array.isArray(rawIndex) ? rawIndex.filter((item): item is number => Number.isInteger(item)) : Number.isInteger(rawIndex) ? [rawIndex as number] : [];
      const firstIndex = indexes[0] ?? 0;
      if (expr.expr.kind === "binding_ref") {
        const bound = env.bindings.get(expr.expr.name);
        const tupleValue = bound?.length === 1 && Object.prototype.hasOwnProperty.call(bound[0]!, "__scalar")
          ? bound[0]!.__scalar
          : undefined;
        if (Array.isArray(tupleValue)) {
          return tupleValue[firstIndex] ?? null;
        }
      }
      const base = evalFreeExpr(expr.expr, env);
      const readIndex = (item: unknown, index = firstIndex): unknown => {
        if (typeof item === "string") {
          return item[index] ?? null;
        }
        if (Array.isArray(item)) {
          return item[index] ?? null;
        }
        return null;
      };
      if (indexes.length > 1) {
        const values = Array.isArray(base) && !exprIsArrayField(expr.expr)
          ? base.flatMap((item) => indexes.map((index) => readIndex(item, index)).filter((value) => value !== null && value !== undefined))
          : indexes.map((index) => readIndex(base, index)).filter((value) => value !== null && value !== undefined);
        return values.sort((a, b) => String(a).localeCompare(String(b)));
      }
      // A field_access into a shape-defined tuple computed (`.n1.0` where
      // `n1 := (a, b)`) returns the tuple as a single array — index_access
      // should yield the element at `index`, not strindex into each
      // sub-string. Detect that pattern via the shape declaration.
      const computedExprIsTuple = (e: ComputedExpr | FreeObjectExpr): boolean => {
        if (e.kind === "tuple") return true;
        if (e.kind === "select_expr") return computedExprIsTuple(e.expr);
        return false;
      };
      if (expr.expr.kind === "field_access"
        && expr.expr.expr.kind === "current_item"
        && !expr.expr.field.startsWith("@")) {
        const shapeElem = statement.shape.find((element) =>
          element.kind === "computed" && element.name === (expr.expr as { field: string }).field);
        if (shapeElem && shapeElem.kind === "computed" && computedExprIsTuple(shapeElem.expr)) {
          return Array.isArray(base) ? (base[firstIndex] ?? null) : null;
        }
      }
      if (Array.isArray(base)) {
        if (base.length === 0 && (expr.expr.kind === "array_literal_expr" || expr.expr.kind === "tuple")) return [];
        if (expr.expr.kind === "tuple" && !(base.length > 0 && Array.isArray(base[0]))) {
          return readIndex(base);
        }
        if (exprIsArrayField(expr.expr) || expr.expr.kind === "array_literal_expr" && !(base.length > 0 && Array.isArray(base[0]))) {
          return readIndex(base);
        }
        return base
          .map((item) => readIndex(item))
          .filter((value) => value !== null && value !== undefined)
          .sort((a, b) => String(a).localeCompare(String(b)));
      }
      return readIndex(base);
    }
    if (expr.kind === "slice_access") {
      const base = evalFreeExpr(expr.expr, env);
      const rawStart = expr.startExpr ? evalFreeExpr(expr.startExpr, env) : expr.start;
      const rawEnd = expr.endExpr ? evalFreeExpr(expr.endExpr, env) : expr.end;
      const starts = Array.isArray(rawStart) ? rawStart.filter((item): item is number => Number.isInteger(item)) : rawStart === undefined ? [undefined] : Number.isInteger(rawStart) ? [rawStart as number] : [undefined];
      const end = Array.isArray(rawEnd) ? rawEnd.find((item): item is number => Number.isInteger(item)) : Number.isInteger(rawEnd) ? rawEnd as number : undefined;
      const sliceOne = (item: unknown, start: number | undefined): unknown => Array.isArray(item) || typeof item === "string" ? item.slice(start, end) : null;
      const compareSlices = (a: unknown, b: unknown): number => {
        const alen = Array.isArray(a) || typeof a === "string" ? a.length : 0;
        const blen = Array.isArray(b) || typeof b === "string" ? b.length : 0;
        if (alen !== blen) return alen - blen;
        return JSON.stringify(a).localeCompare(JSON.stringify(b));
      };
      if (Array.isArray(base) && !exprIsArrayField(expr.expr)) {
        return base.flatMap((item) => starts.map((start) => sliceOne(item, start)).filter((value) => value !== null))
          .sort(compareSlices);
      }
      const values = starts.map((start) => sliceOne(base, start)).filter((value) => value !== null);
      if (starts.length > 1) return values.sort(compareSlices);
      return values[0] ?? null;
    }
    if (expr.kind === "coalesce") {
      const left = evalFreeExpr(expr.left, env);
      const isEmpty = left === null
        || left === undefined
        || (Array.isArray(left) && left.length === 0);
      return isEmpty ? evalFreeExpr(expr.right, env) : left;
    }
    if (expr.kind === "shape_projection") {
      const base = evalFreeExpr(expr.expr, env);
      const project = (item: unknown): unknown => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const row = item as ParsedRuntimeRow;
        return materialize(row, rowTypeName(row, env.rowType), expr.shape, { ...env, row, rowType: rowTypeName(row, env.rowType) });
      };
      return Array.isArray(base)
        ? base.map(project).filter((item) => item !== null)
        : project(base);
    }
    if (expr.kind === "select_expr_subquery") {
      const subqueryEnv = expr.clauses?._withBindings
        ? { ...env, bindings: evalBindings(expr.clauses._withBindings, env) }
        : env;
      if (expr.expr.kind === "shape_projection" && (expr.filter || expr.orderBy)) {
        const projection = expr.expr;
        let value = evalFreeExpr(projection.expr, subqueryEnv);
        if (Array.isArray(value)) {
          let items = [...value];
          if (expr.filter) {
            const iterationPath = extractIterationPath(projection.expr) ?? extractCurrentItemIterationPath(projection.expr, subqueryEnv);
            items = items.filter((item) => {
              const bindings = new Map(subqueryEnv.bindings);
              if (expr.alias && isRecordRow(item)) {
                bindings.set(expr.alias, [item]);
              }
              const itemEnv = isRecordRow(item)
                ? withInnerRow(subqueryEnv, item, rowTypeName(item, subqueryEnv.rowType), { bindings, iterationPath })
                : { ...subqueryEnv, bindings };
              const filterValue = evalFreeExpr(expr.filter!, itemEnv);
              return Array.isArray(filterValue) ? filterValue.some(Boolean) : Boolean(filterValue);
            });
          }
          if (expr.orderBy) {
            items.sort((a, b) => compareByExprOrder(expr.orderBy!, a, b, subqueryEnv, expr.alias));
          }
          const offset = expr.offset ?? 0;
          items = expr.limit === undefined ? items.slice(offset) : items.slice(offset, offset + expr.limit);
          value = items.map((item) => {
            if (!isRecordRow(item)) return null;
            return materialize(item, rowTypeName(item, subqueryEnv.rowType), projection.shape, { ...subqueryEnv, row: item, rowType: rowTypeName(item, subqueryEnv.rowType) });
          }).filter((item) => item !== null);
        }
        return value;
      }
      let value = evalFreeExpr(expr.expr, subqueryEnv);
      if (Array.isArray(value)) {
        let items = [...value];
        if (expr.filter) {
          const iterationPath = extractIterationPath(expr.expr) ?? extractCurrentItemIterationPath(expr.expr, subqueryEnv);
          const iterationSource = expr.expr;
          // EdgeQL `SELECT <binding> FILTER ...` rebinds the iteration name to
          // the current element inside the FILTER (and ORDER BY) — without
          // this, `(SELECT I2 FILTER I2 != Item)` evaluates I2 as the full
          // bound set even when iterating a single I2.
          const iterationBindingName = expr.expr.kind === "binding_ref" ? expr.expr.name : undefined;
          items = items.filter((item) => {
            const bindings = new Map(subqueryEnv.bindings);
            if (expr.alias) {
              // EdgeQL `SELECT _ := <set>` binds `_` to *each* element of
              // the iterated set; for scalar elements the binding shows up
              // in the filter expression's evaluator as a singleton-array
              // binding ref.
              if (isRecordRow(item)) {
                bindings.set(expr.alias, [item]);
              } else {
                bindings.set(expr.alias, [{ __scalar: item } as ParsedRuntimeRow]);
              }
            }
            if (iterationBindingName !== undefined && isRecordRow(item)) {
              bindings.set(iterationBindingName, [item]);
            }
            const itemEnv = isRecordRow(item)
              ? withInnerRow(subqueryEnv, item, rowTypeName(item, subqueryEnv.rowType), { bindings, iterationPath, iterationSource })
              : { ...subqueryEnv, bindings, iterationSource };
            const filterValue = evalFreeExpr(expr.filter!, itemEnv);
            return Array.isArray(filterValue) ? filterValue.some(Boolean) : Boolean(filterValue);
          });
        }
        if (expr.orderBy) {
          // EdgeQL `SELECT X ORDER BY X` (and the equivalent `array_agg(X
          // ORDER BY X)` form) sorts by the iteration variable itself. When
          // the orderBy expression is structurally identical to the
          // iteration source, compare items directly — the generic
          // `compareByExprOrder` would otherwise re-evaluate the source on
          // every item and return the same set, leaving items unordered.
          const orderBy = expr.orderBy;
          if (freeExprStructurallyEqual(orderBy.expr, expr.expr)) {
            const direction = orderBy.direction === "desc" ? -1 : 1;
            items.sort((a, b) => {
              const cmp = typeof a === "number" && typeof b === "number"
                ? a === b ? 0 : a < b ? -1 : 1
                : String(a ?? "").localeCompare(String(b ?? ""));
              return cmp * direction;
            });
          } else {
            items.sort((a, b) => compareByExprOrder(orderBy, a, b, subqueryEnv, expr.alias));
          }
        }
        const offset = expr.offset ?? 0;
        items = expr.limit === undefined ? items.slice(offset) : items.slice(offset, offset + expr.limit);
        // FOR-loop iteration counting needs `{}` placeholder rows when the
        // binding is being enumerated for cardinality (e.g. inside a body
        // that doesn't read the row's columns). When a downstream
        // expression *does* read a column on the result (`(SELECT I2 FILTER
        // …).tag_set1`), we need to keep the original row data. Detect the
        // column-access case via the filter expression — if the filter
        // produced cross-row references (which our `iterationBindingName`
        // bound to the iterated row), preserve the data; otherwise drop to
        // empty placeholders so legacy expr_objects-style FOR/array_agg
        // tests stay happy.
        if (expr.expr.kind === "binding_ref" && items.every(isRecordRow)
          && !expr.filter) {
          value = items.map(() => ({}));
          return value;
        }
        value = items;
      }
      return value;
    }
    if (expr.kind === "function_call") {
      const name = expr.call.name.includes("::") ? expr.call.name : `std::${expr.call.name}`;
      const normalized = name.toLowerCase();
      if (name === "std::count") {
        const arg = expr.call.args[0];
        if (arg?.kind === "field_ref" && env.row) {
          return countForwardLink(env.row, rowTypeName(env.row, env.rowType), arg.field);
        }
        if (arg?.kind === "binding_ref") {
          const bound = env.bindings.get(arg.name);
          if (bound?.every((row) => Object.prototype.hasOwnProperty.call(row, "__count"))) {
            return bound.reduce((total, row) => total + Number(row.__count ?? 0), 0);
          }
        }
        const value = arg ? evalFunctionArg(arg, env) : [];
        return countRuntimeSetCardinality(value);
      }
      if (normalized === "std::assert_distinct"
        || normalized === "std::assert_exists"
        || normalized === "std::assert_single") {
        const arg = expr.call.args[0];
        const value = arg ? evalFunctionArg(arg, env) : [];
        if (normalized === "std::assert_exists") {
          const isEmpty = Array.isArray(value) ? value.length === 0 : value == null;
          if (isEmpty) {
            throw new AppError("E_SEMANTIC", "assert_exists violation", 1, 1);
          }
        }
        return value;
      }
      // `assert(cond)` / `assert(cond, message := …)`: raise on false.
      if (normalized === "std::assert") {
        const condArg = expr.call.args[0];
        const cond = condArg ? evalFunctionArg(condArg, env) : null;
        const truthy = cond === true || cond === 1
          || (Array.isArray(cond) && cond.length > 0 && (cond[0] === true || cond[0] === 1));
        if (!truthy) {
          const messageArg = expr.call.args[1];
          let message = "assertion failed";
          if (messageArg) {
            const m = evalFunctionArg(messageArg, env);
            const flat = Array.isArray(m) ? m[0] : m;
            if (typeof flat === "string" && flat) message = flat;
          }
          throw new AppError("E_SEMANTIC", message, 1, 1);
        }
        return cond;
      }
      // Fallback: route to stdlib function dispatch.
      const stdlibDef = resolveStdlibFunction(name, expr.call.args.length);
      if (stdlibDef) {
        const args = expr.call.args.map((arg): RuntimeFunctionArg => {
          const value = evalFunctionArg(arg, env);
          if (Array.isArray(value)) return { kind: "set", values: value as ScalarValue[] };
          return value as ScalarValue;
        });
        return executeStdlibFunction(name, args) as unknown;
      }
    }
    return null;
  };

  const evalFunctionArg = (arg: FunctionCallArgExpr, env: ParsedRuntimeEnv): unknown => {
    if (arg.kind === "binding_ref") {
      return env.bindings.get(arg.name) ?? [];
    }
    if (arg.kind === "field_ref") {
      const row = env.row;
      return row ? readForwardLink(row, rowTypeName(row, env.rowType), arg.field) : [];
    }
    if (arg.kind === "expr") {
      return evalFreeExpr(arg.expr, env);
    }
    if (arg.kind === "literal") {
      return arg.value;
    }
    return [];
  };

  const functionArgReferencesUnorderedBinding = (arg: FunctionCallArgExpr, env: ParsedRuntimeEnv): boolean => {
    if (arg.kind === "binding_ref") return env.bindings.has(unorderedBindingKey(arg.name));
    if (arg.kind === "expr") return exprReferencesUnorderedBinding(arg.expr, env);
    if (arg.kind === "function_call") return arg.call.args.some((inner) => functionArgReferencesUnorderedBinding(inner, env));
    return false;
  };

  function exprReferencesUnorderedBinding(expr: FreeObjectExpr, env: ParsedRuntimeEnv): boolean {
    if (expr.kind === "binding_ref") return env.bindings.has(unorderedBindingKey(expr.name));
    if (expr.kind === "tuple" || expr.kind === "set_expr" || expr.kind === "array_literal_expr") {
      return expr.values.some((value) => exprReferencesUnorderedBinding(value, env));
    }
    if (expr.kind === "concat") return expr.parts.some((part) => exprReferencesUnorderedBinding(part, env));
    if (expr.kind === "function_call") return expr.call.args.some((arg) => functionArgReferencesUnorderedBinding(arg, env));
    if (expr.kind === "select_expr_subquery" || expr.kind === "distinct" || expr.kind === "exists" || expr.kind === "cast" || expr.kind === "field_access" || expr.kind === "index_access" || expr.kind === "slice_access" || expr.kind === "is_type" || expr.kind === "not" || expr.kind === "unary") {
      return exprReferencesUnorderedBinding(expr.expr, env);
    }
    if (expr.kind === "for_expr") {
      return exprReferencesUnorderedBinding(expr.iterator, env) || exprReferencesUnorderedBinding(expr.body, env) || (expr.filter ? exprReferencesUnorderedBinding(expr.filter, env) : false);
    }
    if (expr.kind === "compare" || expr.kind === "math" || expr.kind === "logical" || expr.kind === "and" || expr.kind === "or" || expr.kind === "coalesce") {
      return exprReferencesUnorderedBinding(expr.left, env) || exprReferencesUnorderedBinding(expr.right, env);
    }
    if (expr.kind === "if_else") {
      return exprReferencesUnorderedBinding(expr.thenExpr, env) || exprReferencesUnorderedBinding(expr.condition, env) || exprReferencesUnorderedBinding(expr.elseExpr, env);
    }
    if (expr.kind === "shape_projection") return exprReferencesUnorderedBinding(expr.expr, env);
    if (expr.kind === "free_object_constructor") return expr.entries.some((entry) => exprReferencesUnorderedBinding(entry.expr, env));
    return false;
  }

  const computedReferencesUnorderedBinding = (expr: ComputedExpr, env: ParsedRuntimeEnv): boolean => {
    if (expr.kind === "select_expr") return exprReferencesUnorderedBinding(expr.expr, env);
    if (expr.kind === "function_call") return expr.call.args.some((arg) => functionArgReferencesUnorderedBinding(arg, env));
    return false;
  };

  const evalComputed = (expr: ComputedExpr, env: ParsedRuntimeEnv, multi = false): unknown => {
    if (expr.kind === "function_call") {
      const name = expr.call.name.includes("::") ? expr.call.name : `std::${expr.call.name}`;
      const normalizedName = name.toLowerCase();
      if (normalizedName === "std::exists") {
        const value = expr.call.args[0] ? evalFunctionArg(expr.call.args[0], env) : [];
        return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
      }
      if (normalizedName === "std::any") {
        const value = expr.call.args[0] ? evalFunctionArg(expr.call.args[0], env) : [];
        return Array.isArray(value) ? value.some(Boolean) : Boolean(value);
      }
      if (name === "std::count") {
        if (expr.call.args[0]?.kind === "field_ref" && env.row) {
          return countForwardLink(env.row, rowTypeName(env.row, env.rowType), expr.call.args[0].field);
        }
        if (expr.call.args[0]?.kind === "binding_ref") {
          const bound = env.bindings.get(expr.call.args[0].name);
          if (bound?.every((row) => Object.prototype.hasOwnProperty.call(row, "__count"))) {
            return bound.reduce((total, row) => total + Number(row.__count ?? 0), 0);
          }
        }
        const value = expr.call.args[0] ? evalFunctionArg(expr.call.args[0], env) : [];
        return countRuntimeSetCardinality(value);
      }
      if (normalizedName === "std::assert_distinct"
        || normalizedName === "std::assert_exists"
        || normalizedName === "std::assert_single") {
        const value = expr.call.args[0] ? evalFunctionArg(expr.call.args[0], env) : [];
        if (normalizedName === "std::assert_exists") {
          const isEmpty = Array.isArray(value) ? value.length === 0 : value == null;
          if (isEmpty) {
            throw new AppError("E_SEMANTIC", "assert_exists violation", 1, 1);
          }
        }
        return value;
      }
      // Fall through for user-defined / unhandled functions: evaluate args
      // and delegate to executeFunctionCall (which performs overload
      // resolution and runs the function body). Without this, a shape like
      // `Issue { z := opt_test(true, .time_estimate) }` returns z=null
      // because we'd hit the unconditional `return null` at the bottom.
      const userQualifiedName = expr.call.name.includes("::")
        ? expr.call.name
        : resolveStdlibFunction(`std::${expr.call.name}`, expr.call.args.length)
          ? `std::${expr.call.name}`
          : `default::${expr.call.name}`;
      const userArgs = expr.call.args.map((arg): RuntimeFunctionArg => {
        const value = evalFunctionArg(arg, env);
        if (Array.isArray(value)) return { kind: "set", values: value as ScalarValue[] };
        return value as ScalarValue;
      });
      const userStaticTypes = expr.call.args.map((arg) =>
        inferStaticArgType(arg, schema, statement.withModule ?? "default", env.rowType));
      return executeFunctionCall(schema, db, context, userQualifiedName, userArgs, userStaticTypes);
    }
    if (expr.kind === "select_expr") {
      const bindings = evalBindings(expr.clauses._withBindings, env);
      let value = evalFreeExpr(expr.expr, { ...env, bindings });
      if (Array.isArray(value)) {
        let items = value;
        if (expr.clauses.orderBy) {
          const field = expr.clauses.orderBy.field.split(".").at(-1) ?? expr.clauses.orderBy.field;
          const direction = expr.clauses.orderBy.direction === "desc" ? -1 : 1;
          items = [...items].sort((a, b) => {
            const left = a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>)[field] : a;
            const right = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>)[field] : b;
            return String(left ?? "").localeCompare(String(right ?? "")) * direction;
          });
        }
        if (expr.clauses.offset !== undefined) {
          items = items.slice(expr.clauses.offset);
        }
        if (expr.clauses.limit !== undefined) {
          items = items.slice(0, expr.clauses.limit);
        }
        value = items;
      }
      if (multi) return Array.isArray(value) ? value : [value];
      if (expr.expr.kind === "array_literal_expr" || expr.expr.kind === "slice_access") return value;
      if (!Array.isArray(value)) return value;
      const innerProducesSet = expr.clauses?.limit === undefined && innerExprProducesMultiSet(expr.expr);
      if (innerProducesSet) return value;
      return value.length === 1 ? value[0] : value;
    }
    if (expr.kind === "subquery") {
      const rows = evalSelect(expr.typeName, expr.shape, expr.clauses, env).map((row) => projectShapeOutput(row, expr.shape));
      return multi ? rows : rows.length === 1 ? rows[0] : rows;
    }
    if (expr.kind === "type_name") {
      return env.row ? rowTypeName(env.row, env.rowType) : null;
    }
    if (expr.kind === "literal") {
      return expr.value;
    }
    if (expr.kind === "field_ref") {
      if (!env.row) {
        return null;
      }
      if (Object.prototype.hasOwnProperty.call(env.row, expr.field)) {
        return materializeFieldValue(schema, rowTypeName(env.row, env.rowType), expr.field, env.row[expr.field]);
      }
      const rows = readForwardLink(env.row, rowTypeName(env.row, env.rowType), expr.field);
      return multi ? rows : rows.length === 1 ? rows[0] : rows;
    }
    if (expr.kind === "binding_ref") {
      const bound = env.bindings.get(expr.name);
      if (!bound) return null;
      if (bound.every((row) => Object.prototype.hasOwnProperty.call(row, "__scalar"))) {
        const values = bound.map((row) => row.__scalar);
        return values.length === 1 ? values[0] : values;
      }
      return bound.length === 1 ? bound[0] : bound;
    }
    return null;
  };

  const compareRowsByOrder = (a: ParsedRuntimeRow, b: ParsedRuntimeRow, orderBy: OrderExpr, env?: ParsedRuntimeEnv): number => {
    let left: unknown;
    let right: unknown;
    if (orderBy.expr) {
      // Expression form: evaluate per row (e.g. `len(.body)`).
      const baseEnv = env ?? { bindings: new Map() };
      const aEnv: ParsedRuntimeEnv = { ...baseEnv, row: a, rowType: rowTypeName(a) };
      const bEnv: ParsedRuntimeEnv = { ...baseEnv, row: b, rowType: rowTypeName(b) };
      const aVal = evalFreeExpr(orderBy.expr, aEnv);
      const bVal = evalFreeExpr(orderBy.expr, bEnv);
      left = Array.isArray(aVal) ? aVal[0] : aVal;
      right = Array.isArray(bVal) ? bVal[0] : bVal;
    } else {
      const field = orderBy.field.replace(/^\./, "").replace(/^@/, "@").split(".").at(-1) ?? orderBy.field;
      left = a[field];
      right = b[field];
    }
    const direction = orderBy.direction === "desc" ? -1 : 1;
    const comparison = typeof left === "number" && typeof right === "number"
      ? left === right ? 0 : left < right ? -1 : 1
      : String(left ?? "").localeCompare(String(right ?? ""));
    if (comparison !== 0) {
      return comparison * direction;
    }
    return orderBy.then ? compareRowsByOrder(a, b, orderBy.then, env) : 0;
  };

  const materialize = (row: ParsedRuntimeRow, typeName: string, shape: ShapeElement[], env: ParsedRuntimeEnv): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const fieldTypeName = rowTypeName(row, typeName);
    const qualifiedFieldType = fieldTypeName.includes("::") ? fieldTypeName : qualifyRuntimeTypeName(fieldTypeName);
    const fieldTypeDef = schema.getType(qualifiedFieldType);
    const fieldByName = new Map<string, { multi?: boolean }>();
    if (fieldTypeDef) {
      for (const f of fieldTypeDef.fields) fieldByName.set(f.name, f);
    }
    for (const element of shape) {
      if (element.kind === "field") {
        const fieldDef = fieldByName.get(element.name);
        let value = materializeFieldValue(schema, qualifiedFieldType, element.name, row[element.name] ?? null);
        // Multi-cardinality scalar properties (`multi tags: str`) are stored
        // as JSON-encoded strings; decode them into arrays for output.
        if (fieldDef?.multi && typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) value = parsed;
          } catch {
            // leave as-is; falls through to caller
          }
        } else if (fieldDef?.multi && value === null) {
          value = [];
        }
        // Shape modifiers on multi-property scalars:
        //   tags FILTER tags > 'p' ORDER BY tags DESC LIMIT 1 OFFSET 0
        // applies element-wise on the decoded JS array. The `where` clause
        // and ordering reference the per-element value as a path through
        // the subject (`Item.tag_set1`), so we expose the element as
        // `__current__` and as the subject's tail field while evaluating.
        if (fieldDef?.multi && Array.isArray(value)) {
          // Evaluate per-element. Inside the modifiers, `Item.tag_set1` /
          // `.tag_set1` must refer to *the current element*, not the full
          // multi-property set; we re-encode the field as a single-element
          // JSON array so the materializer-driven readStoredField yields
          // `[item]`, and clamp the iteration to that one element.
          const subjectAlias = typeName.split("::").at(-1) ?? typeName;
          const subjectBinding = typeName;
          const elementEnv = { ...env, row, rowType: typeName } as ParsedRuntimeEnv;
          const evalElement = (item: unknown, expr: FreeObjectExpr): unknown => {
            const itemRow: ParsedRuntimeRow = {
              ...row,
              [element.name]: JSON.stringify([item]),
              __scalar: item,
            } as ParsedRuntimeRow;
            const itemBindings = new Map(elementEnv.bindings);
            itemBindings.set(subjectAlias, [itemRow]);
            if (subjectBinding !== subjectAlias) {
              itemBindings.set(subjectBinding, [itemRow]);
            }
            const itemEnv: ParsedRuntimeEnv = { ...elementEnv, row: itemRow, bindings: itemBindings };
            return evalFreeExpr(expr, itemEnv);
          };
          if (element.where) {
            const whereExpr = element.where;
            value = (value as unknown[]).filter((item) => {
              const result = evalElement(item, whereExpr);
              if (Array.isArray(result)) return result.some(Boolean);
              return Boolean(result);
            });
          }
          if (element.orderBy && element.orderBy.length > 0) {
            const orderClauses = element.orderBy;
            value = [...(value as unknown[])].sort((a, b) => {
              for (const clause of orderClauses) {
                const orderExpr = clause.expr;
                const av = orderExpr ? evalElement(a, orderExpr) : a;
                const bv = orderExpr ? evalElement(b, orderExpr) : b;
                const aScalar = Array.isArray(av) ? av[0] : av;
                const bScalar = Array.isArray(bv) ? bv[0] : bv;
                const direction = clause.direction === "desc" ? -1 : 1;
                let cmp: number;
                if (typeof aScalar === "number" && typeof bScalar === "number") {
                  cmp = aScalar === bScalar ? 0 : aScalar < bScalar ? -1 : 1;
                } else {
                  cmp = String(aScalar ?? "").localeCompare(String(bScalar ?? ""));
                }
                if (cmp !== 0) return cmp * direction;
              }
              return 0;
            });
          }
          if (element.offset !== undefined) {
            value = (value as unknown[]).slice(element.offset);
          }
          if (element.limit !== undefined) {
            value = (value as unknown[]).slice(0, element.limit);
          }
        }
        out[element.name] = value;
      } else if (element.kind === "computed") {
        const computedEnv = withInnerRow(env, row, typeName);
        const isMulti = Boolean(element.multi) || element.cardinality === "many";
        let value = evalComputed(element.expr, computedEnv, isMulti);
        // A computed shape whose expression is structurally an empty set
        // (`<X>{}` or `{}`) should expose `null` in single cardinality, not
        // the empty array.
        const isStructurallyEmptyExpr = (e: ComputedExpr | FreeObjectExpr): boolean => {
          if (e.kind === "set_literal") return e.values.length === 0;
          if (e.kind === "cast") return isStructurallyEmptyExpr(e.expr);
          if (e.kind === "select_expr") return isStructurallyEmptyExpr(e.expr);
          return false;
        };
        if (!isMulti && isStructurallyEmptyExpr(element.expr) && Array.isArray(value) && value.length === 0) {
          value = null;
        }
        // Explicit `single` cardinality: unwrap a singleton array. Without an
        // explicit modifier we leave the value alone — other evaluators rely
        // on the array shape.
        if (element.cardinality === "one" && Array.isArray(value) && value.length <= 1) {
          value = value.length === 0 ? null : value[0];
        }
        // Explicit `multi` cardinality: wrap a single scalar into a 1-element
        // array. Null becomes []; arrays pass through.
        if (isMulti && !Array.isArray(value)) {
          value = value == null ? [] : [value];
        }
        out[element.name] = Array.isArray(value) && computedReferencesUnorderedBinding(element.expr, computedEnv)
          ? { __kind: "set", items: value }
          : value;
      } else if (element.kind === "backlink") {
        const rows = readBacklink(row, rowTypeName(row, typeName), element.expr.link, element.expr.sourceType);
        out[element.name] = element.shape
          ? rows.map((child) => materialize(child, rowTypeName(child), element.shape!, { ...env, row: child, rowType: rowTypeName(child) }))
          : rows;
      } else if (element.kind === "link") {
        const resolvedLink = findRuntimeLinkDef(schema, rowTypeName(row, typeName), element.name)
          ?? findRuntimeLinkDef(schema, typeName, element.name);
        const computedMulti = findRuntimeComputedMulti(schema, rowTypeName(row, typeName), element.name)
          ?? findRuntimeComputedMulti(schema, typeName, element.name);
        const existing = row[element.name];
        const isMulti = Array.isArray(existing) || (resolvedLink ? Boolean(resolvedLink.link.multi) : Boolean(computedMulti));
        let rows = Array.isArray(existing)
          ? existing as ParsedRuntimeRow[]
          : readForwardLink(row, rowTypeName(row, typeName), element.name);
        rows = rows.filter((child) => evalFilter(child, rowTypeName(child), element.clauses.filter, { ...env, row: child, rowType: rowTypeName(child) }));
        if (element.clauses.orderBy?.field) {
          rows = [...rows].sort((a, b) => compareRowsByOrder(a, b, element.clauses.orderBy!));
        }
        if (element.clauses.offset !== undefined) {
          rows = rows.slice(element.clauses.offset);
        }
        if (element.clauses.limit !== undefined) {
          rows = rows.slice(0, element.clauses.limit);
        }
        const materialized = rows.map((child) => materialize(child, rowTypeName(child), element.shape, { ...env, row: child, rowType: rowTypeName(child) }));
        out[element.name] = isMulti ? materialized : (materialized[0] ?? null);
      }
    }
    return out;
  };

  const projectShapeOutput = (row: Record<string, unknown>, shape: ShapeElement[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const element of shape) {
      if (element.kind === "field" || element.kind === "computed" || element.kind === "link" || element.kind === "backlink") {
        out[element.name] = row[element.name];
      }
    }
    return out;
  };

  // EdgeQL evaluates filters as set-of-booleans with cross-product semantics:
  // empty propagates through AND/OR/NOT, so e.g. `{} OR true` is empty (not
  // true). To preserve that, evalFilterTri returns "empty" alongside the
  // booleans; the top-level `evalFilter` wraps it and treats "empty" as
  // no-match.
  const evalFilterTri = (row: ParsedRuntimeRow, typeName: string, filter: SelectStatement["filter"] | undefined, env: ParsedRuntimeEnv): true | false | "empty" => {
    if (!filter) {
      return true;
    }
    if (filter.kind === "and") {
      const l = evalFilterTri(row, typeName, filter.left, env);
      const r = evalFilterTri(row, typeName, filter.right, env);
      if (l === "empty" || r === "empty") return "empty";
      return l && r;
    }
    if (filter.kind === "or") {
      const l = evalFilterTri(row, typeName, filter.left, env);
      const r = evalFilterTri(row, typeName, filter.right, env);
      if (l === "empty" || r === "empty") return "empty";
      return l || r;
    }
    if (filter.kind === "not") {
      const inner = evalFilterTri(row, typeName, filter.expr, env);
      if (inner === "empty") return "empty";
      return !inner;
    }
    if (filter.kind === "free_expr") {
      const filterEnv = env.row === row ? env : withInnerRow(env, row, typeName);
      const value = evalFreeExpr(filter.expr, filterEnv);
      if (Array.isArray(value)) {
        // For EXISTS-style free expressions the answer is a boolean about
        // cardinality, not a value. Only treat empty as "empty" when the
        // expression itself is a value comparison (= != etc.) that should
        // propagate empties.
        if (value.length === 0) {
          if (filter.expr.kind === "compare") return "empty";
          return false;
        }
        return value.some(Boolean);
      }
      return Boolean(value);
    }
    if (filter.target.kind === "backlink_property") {
      if (filter.kind === "in_predicate") {
        return true;
      }
      const rows = readBacklink(row, typeName, filter.target.link, filter.target.sourceType);
      const propertyKey = `@${filter.target.property}`;
      for (const candidate of rows) {
        const candidateValue = candidate[propertyKey];
        if (Array.isArray(candidateValue)) {
          for (const v of candidateValue) {
            if (runtimeAliasPredicateMatches(v, filter.op, filter.value as ScalarValue)) return true;
          }
        } else if (runtimeAliasPredicateMatches(candidateValue, filter.op, filter.value as ScalarValue)) {
          return true;
        }
      }
      return false;
    }
    if (filter.target.kind !== "field") return true;
    if (filter.kind === "in_predicate") {
      // Handled below via the dedicated `in_predicate` branch.
    } else if (filter.op === "=" && filter.value === true) {
      const value = row[filter.target.field];
      if (Array.isArray(value)) return value.length > 0;
      return value !== null && value !== undefined;
    }
    const unwrapBoundScalar = (value: unknown): unknown => {
      if (value && typeof value === "object" && !Array.isArray(value) && "__scalar" in (value as Record<string, unknown>)) {
        return (value as Record<string, unknown>).__scalar;
      }
      return value;
    };
    const expected = filter.kind === "in_predicate"
      ? undefined
      : typeof filter.value === "object" && filter.value !== null && "kind" in filter.value
        ? filter.value.kind === "field_ref"
          ? row[filter.value.field]
          : filter.value.kind === "binding_ref"
            ? unwrapBoundScalar(env.bindings.get(filter.value.name)?.[0])
            : filter.value.kind === "set_literal"
              ? filter.value.values
              : filter.value
        : filter.value;
    // Resolve dotted path targets like `priority.name` by walking links.
    const resolveDottedFieldValue = (target: ParsedRuntimeRow, path: string): unknown => {
      if (path === "__type__.name") return rowTypeName(target, typeName);
      const parts = path.split(".");
      let current: unknown = target;
      let currentTypeName: string = rowTypeName(target, typeName);
      for (let i = 0; i < parts.length; i += 1) {
        const segment = parts[i];
        if (current === null || current === undefined) return [];
        if (Array.isArray(current)) {
          // Flat-map remaining segments per element.
          const tail = parts.slice(i).join(".");
          const collected: unknown[] = [];
          for (const item of current) {
            if (item === null || item === undefined) continue;
            const value = resolveDottedFieldValue(item as ParsedRuntimeRow, tail);
            if (Array.isArray(value)) collected.push(...value);
            else if (value !== null && value !== undefined) collected.push(value);
          }
          return collected;
        }
        if (typeof current !== "object") return null;
        const row = current as ParsedRuntimeRow;
        if (Object.prototype.hasOwnProperty.call(row, segment)) {
          const value = row[segment];
          if (i === parts.length - 1) return value ?? null;
          current = value;
          continue;
        }
        // Try as a link.
        const linked = readForwardLink(row, currentTypeName, segment);
        if (linked.length === 0) return [];
        if (i === parts.length - 1) return linked;
        if (linked.length === 1) {
          current = linked[0];
          currentTypeName = rowTypeName(linked[0] as ParsedRuntimeRow, currentTypeName);
          continue;
        }
        // Multi: flat-map.
        const tail = parts.slice(i + 1).join(".");
        const collected: unknown[] = [];
        for (const item of linked) {
          const value = resolveDottedFieldValue(item as ParsedRuntimeRow, tail);
          if (Array.isArray(value)) collected.push(...value);
          else if (value !== null && value !== undefined) collected.push(value);
        }
        return collected;
      }
      return current;
    };
    if (filter.kind === "in_predicate") {
      const values = filter.values.kind === "set_literal" ? filter.values.values : undefined;
      if (!values) return true;
      const target = filter.target.field;
      let actualIn = target === "__type__.name"
        ? rowTypeName(row, typeName)
        : target.includes(".")
          ? resolveDottedFieldValue(row, target)
          : row[target];
      // Multi-properties are stored as JSON-text; parse into the actual
      // element set so the `Array.isArray` branch below applies.
      if (!target.includes(".") && typeof actualIn === "string") {
        const fieldDef = schema.getType(qualifyType(typeName))?.fields.find((f) => f.name === target);
        if (fieldDef?.multi) {
          actualIn = materializeFieldValue(schema, qualifyType(typeName), target, actualIn);
        }
      }
      if (!target.includes(".") && actualIn === null) {
        const fieldDef = schema.getType(qualifyType(typeName))?.fields.find((f) => f.name === target);
        if (fieldDef?.multi) {
          actualIn = [];
        }
      }
      // EdgeQL set semantics: an empty operand propagates as empty so the
      // surrounding AND/OR/NOT can short-circuit to "no match" for this row.
      if (Array.isArray(actualIn)) {
        if (actualIn.length === 0) return "empty";
        const anyMatch = actualIn.some((v) => values.includes(v as ScalarValue));
        return filter.op === "not_in" ? !anyMatch : anyMatch;
      }
      if (actualIn === null || actualIn === undefined) return "empty";
      const hasValue = values.includes(actualIn as ScalarValue);
      return filter.op === "not_in" ? !hasValue : hasValue;
    }
    let actual = filter.target.field === "__type__.name"
      ? rowTypeName(row, typeName)
      : filter.target.field.includes(".")
        ? resolveDottedFieldValue(row, filter.target.field)
        : row[filter.target.field];
    // `.shape_computed > X` — the row doesn't carry the shape-level
    // computed yet, so evaluate the outer SELECT's computed expression on
    // demand. Matches the field_access shape-computed path in evalFreeExpr.
    if ((actual === undefined || actual === null)
      && filter.target.kind === "field"
      && !filter.target.field.includes(".")
      && filter.target.field !== "__type__.name") {
      const targetField = filter.target.field;
      const shapeComputed = statement.shape.find((element) =>
        element.kind === "computed" && element.name === targetField);
      if (shapeComputed && shapeComputed.kind === "computed"
        && !shapeComputedInProgress.has(filter.target.field)) {
        // Bind the subject type name to the current row so references like
        // `Item.tag_set1` inside the computed body resolve to *this* row.
        const innerBindings = new Map(env.bindings);
        innerBindings.set(typeName, [row]);
        const shortType = typeName.includes("::") ? typeName.split("::").at(-1) : undefined;
        if (shortType) innerBindings.set(shortType, [row]);
        const innerEnv = withInnerRow(env, row, typeName, { bindings: innerBindings });
        shapeComputedInProgress.add(filter.target.field);
        try {
          actual = evalComputed(shapeComputed.expr, innerEnv, Boolean(shapeComputed.multi));
        } finally {
          shapeComputedInProgress.delete(filter.target.field);
        }
      }
    }
    if (Array.isArray(expected)) {
      return filter.op === "=" ? expected.includes(actual as ScalarValue) : !expected.includes(actual as ScalarValue);
    }
    // EdgeQL: comparison with an empty operand yields empty (i.e. no match).
    if (Array.isArray(actual)) {
      if (actual.length === 0) return "empty";
      return actual.some((v) => runtimeAliasPredicateMatches(v, filter.op, expected as ScalarValue));
    }
    return runtimeAliasPredicateMatches(actual, filter.op, expected as ScalarValue);
  };

  // Top-level wrapper: empty result counts as "no match" (false) for filters.
  const evalFilter = (row: ParsedRuntimeRow, typeName: string, filter: SelectStatement["filter"] | undefined, env: ParsedRuntimeEnv): boolean => {
    const result = evalFilterTri(row, typeName, filter, env);
    return result === true;
  };

  const evalSelect = (typeName: string, shape: ShapeElement[], clauses: SelectStatement["filter"] extends never ? never : { filter?: SelectStatement["filter"]; orderBy?: SelectStatement["orderBy"]; limit?: SelectStatement["limit"]; offset?: SelectStatement["offset"]; _withBindings?: WithBinding[] }, env: ParsedRuntimeEnv): ParsedRuntimeRow[] => {
    const bindings = evalBindings(clauses._withBindings, env);
    const source = bindings.get(typeName)
      ?? (typeName === statement.typeName && selectedAliasStatement
        ? evalSelect(selectedAliasStatement.typeName, selectedAliasStatement.shape, {
            filter: selectedAliasStatement.filter,
            orderBy: selectedAliasStatement.orderBy,
            limit: selectedAliasStatement.limit,
            offset: selectedAliasStatement.offset,
          }, env)
        : concreteRowsForType(typeName));
    const qualified = schema.getType(qualifyType(typeName)) ? qualifyType(typeName) : typeName;
    let rows = source.filter((row) => evalFilter(row, rowTypeName(row, qualified), clauses.filter, { ...env, bindings }));
    if (clauses.orderBy?.field) {
      // Tag the env with an iteration path so a free expression like
      // `len(Text.body)` resolves `Text.body` against the current row, not
      // the global Text set.
      const sortEnv: ParsedRuntimeEnv = { ...env, bindings, iterationPath: { typeName, steps: [] } };
      rows = [...rows].sort((a, b) => compareRowsByOrder(a, b, clauses.orderBy!, sortEnv));
    }
    if (clauses.offset !== undefined) rows = rows.slice(clauses.offset);
    if (clauses.limit !== undefined) rows = rows.slice(0, clauses.limit);
    return rows.map((row) => {
      const rowBindings = new Map(bindings);
      rowBindings.set(typeName, [row]);
      return { ...row, ...materialize(row, rowTypeName(row, qualified), shape, { ...env, bindings: rowBindings }), id: row.id, __source_type: rowTypeName(row, qualified) };
    });
  };

  const env: ParsedRuntimeEnv = { bindings: evalBindings(statement.with, { bindings: new Map() }) };
  const rows = evalSelect(statement.typeName, statement.shape, {
    filter: statement.filter,
    orderBy: statement.orderBy,
    limit: statement.limit,
    offset: statement.offset,
  }, env).map((row) => projectShapeOutput(row, statement.shape));
  return { kind: "select", rows };
};

type IntrospectionAnnotation = {
  name: string;
  "@value": string;
};

type IntrospectionConstraintParam = {
  name: string;
  "@value": string;
};

type IntrospectionConstraint = {
  name: string;
  delegated: boolean;
  params: IntrospectionConstraintParam[];
  annotations: IntrospectionAnnotation[];
};

type IntrospectionProperty = {
  name: string;
  target?: { name: string };
  annotations: IntrospectionAnnotation[];
  constraints: IntrospectionConstraint[];
};

type IntrospectionLinkProperty = {
  name: string;
  annotations: IntrospectionAnnotation[];
};

type IntrospectionLink = {
  name: string;
  annotations: IntrospectionAnnotation[];
  properties: IntrospectionLinkProperty[];
};

type IntrospectionType = {
  name: string;
  annotations: IntrospectionAnnotation[];
  indexes: Array<{ expr: string }>;
  bases: Array<{ name: string; "@index": number }>;
  ancestors: Array<{ name: string; "@index": number }>;
  properties: IntrospectionProperty[];
  links: IntrospectionLink[];
  pointersHaveAnnotations: boolean;
};

const buildIntrospectionType = (schema: SchemaSnapshot, typeDef: TypeDef): IntrospectionType => {
  const moduleName = typeDef.module ?? "default";
  const qualifiedName = `${moduleName}::${typeDef.name}`;

  const collectAncestors = (bases: string[]): Array<{ name: string; "@index": number }> => {
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const base of bases) {
      if (seen.has(base)) {
        continue;
      }
      seen.add(base);
      ordered.push(base);
    }

    const visitParents = (typeName: string): void => {
      const baseType = schema.getType(typeName);
      for (const parent of baseType?.extends ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          ordered.push(parent);
        }
        visitParents(parent);
      }
    };

    for (const base of bases) {
      visitParents(base);
    }

    for (const root of ["std::Object", "std::BaseObject"]) {
      if (!seen.has(root)) {
        seen.add(root);
        ordered.push(root);
      }
    }

    return ordered.map((name, index) => ({ name, "@index": index }));
  };

  const mapConstraint = (constraint: NonNullable<FieldDef["constraints"]>[number]): IntrospectionConstraint => ({
    name: constraint.name,
    delegated: typeDef.abstract ? Boolean(constraint.delegated) : false,
    params: (constraint.params ?? []).map((param) => ({
      name: param.name,
      "@value": String(param.value),
    })),
    annotations: (constraint.annotations ?? []).map((annotation) => ({
      name: annotation.name,
      "@value": annotation.value,
    })),
  });

  const properties: IntrospectionProperty[] = [
    {
      name: "id",
      annotations: [],
      constraints: [{ name: "std::exclusive", delegated: false, params: [], annotations: [] }],
    },
    ...typeDef.fields.map((field) => ({
      name: field.name,
      target: field.targetTypeName ? { name: field.targetTypeName } : undefined,
      annotations: (field.annotations ?? []).map((annotation) => ({
        name: annotation.name,
        "@value": annotation.value,
      })),
      constraints: (field.constraints ?? []).map((constraint) => mapConstraint(constraint)),
    })),
  ];

  const links: IntrospectionLink[] = (typeDef.links ?? []).map((link) => ({
    name: link.name,
    annotations: (link.annotations ?? []).map((annotation) => ({
      name: annotation.name,
      "@value": annotation.value,
    })),
    properties: (link.properties ?? []).map((property) => ({
      name: property.name,
      annotations: (property.annotations ?? []).map((annotation) => ({
        name: annotation.name,
        "@value": annotation.value,
      })),
    })),
  }));

  const pointersHaveAnnotations =
    properties.some((property) => property.name !== "id" && property.annotations.length > 0)
    || links.some((link) => link.annotations.length > 0);

  return {
    name: qualifiedName,
    annotations: (typeDef.annotations ?? []).map((annotation) => ({
      name: annotation.name,
      "@value": annotation.value,
    })),
    indexes: (typeDef.indexes ?? []).map((index) => ({ expr: index.expr })),
    bases: (typeDef.extends ?? []).map((name, index) => ({ name, "@index": index })),
    ancestors: collectAncestors(typeDef.extends ?? []),
    properties,
    links,
    pointersHaveAnnotations,
  };
};

type TopLevelBlock = {
  content: string;
  after: string;
};

// Walk a token stream and find the first matching pair of braces, returning
// the byte span of their content. `start` is exclusive of the opening brace,
// `end` is exclusive of the closing brace; both are byte offsets into the
// original source the tokens were produced from.
const findMatchingBraceContent = (
  tokens: readonly Token[],
  openIndex: number,
  source: string,
): { contentStart: number; contentEnd: number; afterStart: number } | undefined => {
  if (tokens[openIndex]?.kind !== "lbrace") return undefined;
  let depth = 1;
  for (let i = openIndex + 1; i < tokens.length; i += 1) {
    const tk = tokens[i]!;
    if (tk.kind === "lbrace") depth += 1;
    else if (tk.kind === "rbrace") {
      depth -= 1;
      if (depth === 0) {
        const next = tokens[i + 1];
        return {
          contentStart: tokens[openIndex]!.offset + 1,
          contentEnd: tk.offset,
          afterStart: next ? next.offset : source.length,
        };
      }
    }
  }
  return undefined;
};

const extractObjectTypeShape = (query: string): string | undefined => {
  const tokens = tryTokenize(query);
  if (!tokens) return undefined;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.lower !== "objecttype") continue;
    if (tokens[i + 1]!.kind !== "lbrace") continue;
    const span = findMatchingBraceContent(tokens, i + 1, query);
    if (!span) return undefined;
    return query.slice(span.contentStart, span.contentEnd);
  }
  return undefined;
};

// Find a `<key>: { ... }` block at brace-depth 0 of `source`, scanning the
// tokenized source so whitespace, comments, and string literals are handled
// uniformly with the rest of the engine. Returns the inner content and the
// trailing text (for downstream FILTER / ORDER BY inspection).
const extractTopLevelBlock = (source: string, key: string): TopLevelBlock | undefined => {
  const tokens = tryTokenize(source);
  if (!tokens) return undefined;
  const lowerKey = key.toLowerCase();
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tk = tokens[i]!;
    if (tk.kind === "lbrace") {
      depth += 1;
      continue;
    }
    if (tk.kind === "rbrace") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (tk.lower !== lowerKey) continue;
    // Block keys must not chain off another name (e.g. skip `foo.<key>` or
    // `mod::<key>` references).
    const prev = tokens[i - 1];
    if (prev && (prev.kind === "dot" || prev.kind === "coloncolon" || prev.kind === "at")) {
      continue;
    }
    if (tokens[i + 1]?.kind !== "colon") continue;
    if (tokens[i + 2]?.kind !== "lbrace") continue;
    const span = findMatchingBraceContent(tokens, i + 2, source);
    if (!span) return undefined;
    return {
      content: source.slice(span.contentStart, span.contentEnd),
      after: source.slice(span.afterStart),
    };
  }
  return undefined;
};

const hasTopLevelIdentifier = (source: string, identifier: string): boolean => {
  const tokens = tryTokenize(source);
  if (!tokens) return false;
  const lowered = identifier.toLowerCase();
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tk = tokens[i]!;
    if (tk.kind === "lbrace") {
      depth += 1;
      continue;
    }
    if (tk.kind === "rbrace") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (tk.lower === lowered) return true;
  }
  return false;
};

const RESTRICTED_LINK_PROPERTY_NAMES: Record<string, string> = {
  target: "@target may only be used in index and constraint definitions",
  source: "@source may only be used in index and constraint definitions",
};

const validateRestrictedLinkPropertyTokens = (query: string): void => {
  let tokens: Token[];
  try {
    tokens = tokenize(query);
  } catch {
    return;
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (token.kind !== "at") continue;
    const next = tokens[i + 1];
    if (!next || (next.kind !== "identifier" && !next.kind.startsWith("kw_"))) continue;
    const message = RESTRICTED_LINK_PROPERTY_NAMES[next.lexeme];
    if (message) {
      // Resolve line/column from the token's byte offset against the original
      // query — Token no longer carries line/column directly.
      const pos = offsetToLineCol(token.offset, query);
      throw new AppError("E_SEMANTIC", message, pos.line, pos.column);
    }
  }
};

const trySchemaObjectTypeQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const tokens = tryTokenize(query);
  if (!tokens) return undefined;
  const isObjectTypeQuery = tokensContainBareWord(tokens, "ObjectType");
  const isFunctionQuery = tokensContainBareWord(tokens, "Function");
  const isScalarTypeQuery = tokensContainBareWord(tokens, "ScalarType");
  if (!isObjectTypeQuery && !isFunctionQuery && !isScalarTypeQuery) {
    return undefined;
  }

  const looksLikeSchemaModule = tokensIncludeWithModule(tokens, "schema")
    || tokensIncludeQualifiedName(tokens, "schema", "ObjectType")
    || tokensIncludeQualifiedName(tokens, "schema", "Function")
    || tokensIncludeQualifiedName(tokens, "schema", "ScalarType");
  if (!looksLikeSchemaModule) {
    return undefined;
  }

  if (isFunctionQuery) {
    return trySchemaFunctionQuery(schema, query);
  }

  if (isScalarTypeQuery) {
    return trySchemaScalarTypeQuery(schema, query);
  }

  if (!isObjectTypeQuery) {
    return undefined;
  }

  const shape = extractObjectTypeShape(query);
  if (!shape) {
    return undefined;
  }

  const typeAnnotationsBlock = extractTopLevelBlock(shape, "annotations");
  const propertiesBlock = extractTopLevelBlock(shape, "properties");
  const linksBlock = extractTopLevelBlock(shape, "links");
  const indexesBlock = extractTopLevelBlock(shape, "indexes");
  const basesBlock = extractTopLevelBlock(shape, "bases");
  const ancestorsBlock = extractTopLevelBlock(shape, "ancestors");

  const propertyAnnotationsBlock = propertiesBlock ? extractTopLevelBlock(propertiesBlock.content, "annotations") : undefined;
  const propertyTargetBlock = propertiesBlock ? extractTopLevelBlock(propertiesBlock.content, "target") : undefined;
  const constraintsBlock = propertiesBlock ? extractTopLevelBlock(propertiesBlock.content, "constraints") : undefined;
  const constraintAnnotationsBlock = constraintsBlock ? extractTopLevelBlock(constraintsBlock.content, "annotations") : undefined;
  const constraintParamsBlock = constraintsBlock ? extractTopLevelBlock(constraintsBlock.content, "params") : undefined;

  const linkAnnotationsBlock = linksBlock ? extractTopLevelBlock(linksBlock.content, "annotations") : undefined;
  const linkPropertiesBlock = linksBlock ? extractTopLevelBlock(linksBlock.content, "properties") : undefined;
  const linkPropertyAnnotationsBlock = linkPropertiesBlock
    ? extractTopLevelBlock(linkPropertiesBlock.content, "annotations")
    : undefined;

  const includeTypeAnnotations = !!typeAnnotationsBlock;
  const includeProperties = !!propertiesBlock;
  const includeIndexes = !!indexesBlock;
  const includeBases = !!basesBlock;
  const includeAncestors = !!ancestorsBlock;
  const includePropertyAnnotations = !!propertyAnnotationsBlock;
  const includePropertyTarget = !!propertyTargetBlock;
  const includeConstraints = !!constraintsBlock;
  const includeConstraintNameRaw = constraintsBlock ? hasTopLevelIdentifier(constraintsBlock.content, "name") : false;
  const includeConstraintDelegated = constraintsBlock ? hasTopLevelIdentifier(constraintsBlock.content, "delegated") : false;
  const includeConstraintParams = !!constraintParamsBlock;
  const includeConstraintAnnotations = !!constraintAnnotationsBlock;
  const includeConstraintName = includeConstraintNameRaw && !includeConstraintAnnotations;
  const includeLinks = !!linksBlock;
  const includeLinkAnnotations = !!linkAnnotationsBlock;
  const includeLinkProperties = !!linkPropertiesBlock;
  const includeLinkPropertyAnnotations = !!linkPropertyAnnotationsBlock;
  const includeIndexExpr = indexesBlock ? hasTopLevelIdentifier(indexesBlock.content, "expr") : false;

  const includeAnnotationValue = tokensIncludeAtIdentifier(tokens, "value");
  const filterExistsAnnotations = tokensIncludeFilterExistsPath(tokens, ["annotations"]);
  const filterExistsPointersAnnotations = tokensIncludeExistsPath(tokens, ["pointers", "annotations"]);
  const filterExistsIndexes = tokensIncludeExistsPath(tokens, ["indexes"]);
  const typeOrderByName = tokensIncludeOrderByDotField(tokens, "name");
  const typeAnnotationOrderByName = typeAnnotationsBlock
    ? tokensIncludeOrderByDotField(tryTokenize(typeAnnotationsBlock.after), "name")
    : false;
  const propertiesAfterTokens = propertiesBlock ? tryTokenize(propertiesBlock.after) : undefined;
  const filterObjectPropertiesExistsAnnotations = propertiesAfterTokens
    ? tokensIncludeFilterExistsPath(propertiesAfterTokens, ["annotations"])
    : false;
  const filterObjectPropertiesExistsConstraints = propertiesAfterTokens
    ? tokensIncludeFilterExistsPath(propertiesAfterTokens, ["constraints"])
    : false;
  const propertyNameSetTokens = propertiesAfterTokens
    ? extractFilterNameInSetLiterals(propertiesAfterTokens)
    : undefined;
  const propertyNameSet = propertyNameSetTokens
    ? new Set(propertyNameSetTokens)
    : undefined;
  const propertiesOrderByName = propertiesAfterTokens
    ? tokensIncludeOrderByDotField(propertiesAfterTokens, "name")
    : false;
  const linksAfterTokens = linksBlock ? tryTokenize(linksBlock.after) : undefined;
  const filterObjectLinksExistsAnnotations = linksAfterTokens
    ? tokensIncludeFilterExistsPath(linksAfterTokens, ["annotations"])
    : false;
  const linksOrderByName = linksAfterTokens
    ? tokensIncludeOrderByDotField(linksAfterTokens, "name")
    : false;
  const filterLinksHavingTitleOnLinkProperties = linksAfterTokens
    ? tokensIncludeStringInDotPath(linksAfterTokens, "std::title", ["properties", "annotations", "name"])
    : false;
  const linkPropertiesAfterTokens = linkPropertiesBlock ? tryTokenize(linkPropertiesBlock.after) : undefined;
  const filterLinkPropertiesExistsAnnotations = linkPropertiesAfterTokens
    ? tokensIncludeFilterExistsPath(linkPropertiesAfterTokens, ["annotations"])
    : false;
  const linkPropertiesOrderByName = linkPropertiesAfterTokens
    ? tokensIncludeOrderByDotField(linkPropertiesAfterTokens, "name")
    : false;

  const likePattern = extractDotFieldLikeLiteral(tokens, "name");
  const equalsNames = new Set(extractDotFieldEqualsLiterals(tokens, "name"));

  const rows = schema.listTypes().map((typeDef) => {
    const introspectionType = buildIntrospectionType(schema, typeDef);
    const row: Record<string, unknown> = {
      name: introspectionType.name,
    };

    if (includeTypeAnnotations) {
      const annotations = introspectionType.annotations.map((annotation) => ({
        name: annotation.name,
        ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
      }));
      if (typeAnnotationOrderByName) {
        annotations.sort((a, b) => a.name.localeCompare(b.name));
      }
      row.annotations = annotations;
    }

    if (includeIndexes) {
      row.indexes = introspectionType.indexes.map((index) => ({
        ...(includeIndexExpr ? { expr: index.expr } : {}),
      }));
    }

    if (includeBases) {
      row.bases = introspectionType.bases.map((base) => ({
        name: base.name,
        "@index": base["@index"],
      }));
    }

    if (includeAncestors) {
      row.ancestors = introspectionType.ancestors.map((ancestor) => ({
        name: ancestor.name,
        "@index": ancestor["@index"],
      }));
    }

    if (includeProperties) {
      let properties = introspectionType.properties.slice();
      if (filterObjectPropertiesExistsAnnotations) {
        properties = properties.filter((property) => property.annotations.length > 0);
      }
      if (filterObjectPropertiesExistsConstraints) {
        properties = properties.filter((property) => property.constraints.length > 0);
      }
      if (propertyNameSet) {
        properties = properties.filter((property) => propertyNameSet.has(property.name));
      }
      if (propertiesOrderByName) {
        properties.sort((a, b) => a.name.localeCompare(b.name));
      }

      row.properties = properties.map((property) => {
        const out: Record<string, unknown> = { name: property.name };
        if (includePropertyAnnotations) {
          out.annotations = property.annotations.map((annotation) => ({
            name: annotation.name,
            ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
          }));
        }
        if (includePropertyTarget && property.target) {
          out.target = { name: property.target.name };
        }
        if (includeConstraints) {
          const projectedConstraints =
            includeConstraintAnnotations && !includeConstraintName && !includeConstraintDelegated && !includeConstraintParams
              ? property.constraints.filter((constraint) =>
                  constraint.annotations.length > 0 || constraint.name === "std::exclusive")
              : property.constraints;

          out.constraints = projectedConstraints.map((constraint) => ({
            ...(includeConstraintName ? { name: constraint.name } : {}),
            ...(includeConstraintDelegated ? { delegated: constraint.delegated } : {}),
            ...(includeConstraintParams
              ? {
                  params: constraint.params
                    .filter((param) => param.name !== "__subject__")
                    .map((param) => ({ name: param.name, "@value": param["@value"] })),
                }
              : {}),
            ...(includeConstraintAnnotations
              ? {
                  annotations: constraint.annotations.map((annotation) => ({
                    name: annotation.name,
                    ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
                  })),
                }
              : {}),
          }));
        }
        return out;
      });
    }

    if (includeLinks) {
      let links = introspectionType.links.slice();
      if (filterObjectLinksExistsAnnotations) {
        links = links.filter((link) => link.annotations.length > 0);
      }

      let projectedLinks = links.map((link) => {
        const out: Record<string, unknown> = { name: link.name };
        if (includeLinkAnnotations) {
          out.annotations = link.annotations.map((annotation) => ({
            name: annotation.name,
            ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
          }));
        }

        if (includeLinkProperties) {
          let linkProperties = link.properties.slice();
          if (filterLinkPropertiesExistsAnnotations) {
            linkProperties = linkProperties.filter((property) => property.annotations.length > 0);
          }
          if (linkPropertiesOrderByName) {
            linkProperties.sort((a, b) => a.name.localeCompare(b.name));
          }
          out.properties = linkProperties.map((property) => ({
            name: property.name,
            ...(includeLinkPropertyAnnotations
              ? {
                  annotations: property.annotations.map((annotation) => ({
                    name: annotation.name,
                    ...(includeAnnotationValue ? { "@value": annotation["@value"] } : {}),
                  })),
                }
              : {}),
          }));
        }

        return out;
      });

      if (filterLinksHavingTitleOnLinkProperties) {
        projectedLinks = projectedLinks.filter((link) => {
          const properties = (link.properties as Array<{ annotations?: Array<{ name: string }> }> | undefined) ?? [];
          return properties.some((property) =>
            (property.annotations ?? []).some((annotation) => annotation.name === "std::title"));
        });
      }

      if (linksOrderByName) {
        projectedLinks.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }

      row.links = projectedLinks;
    }

    return { row, introspectionType };
  });

  const filtered = rows.filter(({ row, introspectionType }) => {
    const rowName = typeof row.name === "string" ? row.name : String(row.name);

    if (filterExistsAnnotations) {
      if (introspectionType.annotations.length === 0) {
        return false;
      }
    }

    if (filterExistsPointersAnnotations) {
      if (!introspectionType.pointersHaveAnnotations) {
        return false;
      }
    }

    if (filterExistsIndexes) {
      if (introspectionType.indexes.length === 0) {
        return false;
      }
    }

    if (likePattern) {
      if (likePattern.endsWith("%")) {
        const prefix = likePattern.slice(0, -1);
        return rowName.startsWith(prefix);
      }
      return rowName === likePattern;
    }

    if (equalsNames.size > 0 && !equalsNames.has(rowName)) {
      return false;
    }

    return true;
  });

  if (typeOrderByName) {
    filtered.sort((a, b) => String(a.row.name).localeCompare(String(b.row.name)));
  }

  return {
    kind: "select",
    rows: filtered.map((entry) => entry.row),
  };
};

const trySchemaFunctionQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const tokens = tryTokenize(query);
  const includeAnnotations = !!extractTopLevelBlock(query, "annotations");
  const includeAnnotationValue = tokensIncludeAtIdentifier(tokens, "value");
  const includeVolatility = tokensContainBareWord(tokens, "volatility");
  const filterExistsAnnotations = tokensIncludeFilterExistsPath(tokens, ["annotations"]);
  const likePattern = extractDotFieldLikeLiteral(tokens, "name");
  const orderByName = tokensIncludeOrderByDotField(tokens, "name");

  let rows = schema.listFunctions().map((fn) => {
    const row: Record<string, unknown> = {
      name: `${fn.module}::${fn.name}`,
    };
    if (includeAnnotations) {
      row.annotations = (fn.annotations ?? []).map((annotation) => ({
        name: annotation.name,
        ...(includeAnnotationValue ? { "@value": annotation.value } : {}),
      }));
    }
    if (includeVolatility) {
      row.vol = fn.volatility ?? null;
    }
    return row;
  });

  rows = rows.filter((row) => {
    const rowName = String(row.name);
    if (filterExistsAnnotations) {
      const annotations = (row.annotations as unknown[] | undefined) ?? [];
      if (annotations.length === 0) {
        return false;
      }
    }

    if (likePattern) {
      if (likePattern.endsWith("%")) {
        const prefix = likePattern.slice(0, -1);
        if (!rowName.startsWith(prefix)) {
          return false;
        }
      } else if (rowName !== likePattern) {
        return false;
      }
    }

    return true;
  });

  if (orderByName) {
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  return {
    kind: "select",
    rows,
  };
};

const scalarAncestorsForDeclaration = (
  schema: SchemaSnapshot,
  scalarName: string,
  baseTypeName: string | undefined,
  enumValues: string[] | undefined,
  seen = new Set<string>(),
): string[] => {
  if (seen.has(scalarName)) {
    return [];
  }
  seen.add(scalarName);

  if (enumValues && enumValues.length > 0) {
    return ["std::anyenum", "std::anyscalar"];
  }

  const base = (baseTypeName ?? "str").trim();
  const lower = base.includes("::") ? base.split("::").at(-1)!.toLowerCase() : base.toLowerCase();

  if (lower === "anyenum") {
    return ["std::anyenum", "std::anyscalar"];
  }
  if (lower === "str" || lower === "bytes") {
    return ["std::str", "std::anyscalar"];
  }
  if (lower === "int" || lower === "int64") {
    return ["std::int64", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  }
  if (lower === "int32") {
    return ["std::int32", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  }
  if (lower === "int16") {
    return ["std::int16", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  }
  if (lower === "bool") {
    return ["std::bool", "std::anyscalar"];
  }

  const qualifiedBase = base.includes("::") ? base : `${scalarName.split("::")[0]}::${base}`;
  const baseDecl = schema.getScalarType(qualifiedBase);
  if (baseDecl) {
    return [qualifiedBase, ...scalarAncestorsForDeclaration(schema, qualifiedBase, baseDecl.baseTypeName, baseDecl.enumValues, seen)];
  }

  return [qualifiedBase, "std::anyscalar"];
};

const trySchemaScalarTypeQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const tokens = tryTokenize(query);
  const includeAncestors = !!extractTopLevelBlock(query, "ancestors");
  const includeConstraints = !!extractTopLevelBlock(query, "constraints");
  const includeConstraintParams = !!extractTopLevelBlock(query, "params");
  const likePattern = extractDotFieldLikeLiteral(tokens, "name");
  const orderByName = tokensIncludeOrderByDotField(tokens, "name");

  let rows = schema.listScalarTypes().map((scalarType) => {
    const qualifiedName = `${scalarType.module}::${scalarType.name}`;
    const row: Record<string, unknown> = {
      name: qualifiedName,
    };

    if (includeAncestors) {
      row.ancestors = scalarAncestorsForDeclaration(
        schema,
        qualifiedName,
        scalarType.baseTypeName,
        scalarType.enumValues,
      ).map((ancestor) => ({ name: ancestor }));
    }

    if (includeConstraints) {
      row.constraints = (scalarType.constraints ?? []).map((constraint) => ({
        name: constraint.name,
        ...(includeConstraintParams
          ? {
              params: (constraint.params ?? [])
                .filter((param) => param.name !== "__subject__")
                .map((param) => ({ name: param.name, "@value": String(param.value) })),
            }
          : {}),
      }));
    }

    return row;
  });

  if (likePattern) {
    rows = rows.filter((row) => {
      const rowName = String(row.name);
      if (likePattern.endsWith("%")) {
        return rowName.startsWith(likePattern.slice(0, -1));
      }
      return rowName === likePattern;
    });
  }

  if (orderByName) {
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  return {
    kind: "select",
    rows,
  };
};

const SCHEMA_INTROSPECTION_SELECT_TYPES = new Set([
  "Annotation",
  "Constraint",
  "ConstraintParam",
  "Function",
  "FunctionParam",
  "Index",
  "Link",
  "ObjectType",
  "Pointer",
  "Property",
  "ScalarType",
  "Tuple",
  "TupleElement",
  "Type",
]);

const isSchemaIntrospectionSelect = (statement: Statement): boolean => {
  if (statement.kind !== "select") {
    return false;
  }
  const typeName = statement.typeName.includes("::")
    ? statement.typeName.split("::").at(-1) ?? statement.typeName
    : statement.typeName;
  return SCHEMA_INTROSPECTION_SELECT_TYPES.has(typeName)
    && (statement.withModule === "schema" || statement.typeName.startsWith("schema::"));
};

const selectHasSetDerivedComputedShape = (statement: Statement): boolean => {
  const exprNeedsSetSemantics = (expr: FreeObjectExpr | ComputedExpr): boolean => {
    if (expr.kind === "array_literal_expr" || expr.kind === "tuple" || expr.kind === "index_access" || expr.kind === "slice_access") return true;
    if (expr.kind === "select_expr") return exprNeedsSetSemantics(expr.expr);
    if (expr.kind === "function_call") {
      return expr.call.args.some((arg) => arg.kind === "expr" && exprNeedsSetSemantics(arg.expr));
    }
    if (expr.kind === "field_access" || expr.kind === "select_expr_subquery" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "exists" || expr.kind === "not" || expr.kind === "unary" || expr.kind === "shape_projection") {
      return exprNeedsSetSemantics(expr.expr);
    }
    if (expr.kind === "set_expr") return expr.values.some(exprNeedsSetSemantics);
    if (expr.kind === "compare" || expr.kind === "in_expr" || expr.kind === "math" || expr.kind === "logical" || expr.kind === "and" || expr.kind === "or" || expr.kind === "coalesce") {
      return exprNeedsSetSemantics(expr.left) || exprNeedsSetSemantics(expr.right);
    }
    if (expr.kind === "if_else") return exprNeedsSetSemantics(expr.condition) || exprNeedsSetSemantics(expr.thenExpr) || exprNeedsSetSemantics(expr.elseExpr);
    return false;
  };
  const shapeNeedsSetSemantics = (shape: ShapeElement[]): boolean => shape.some((element) => {
    if (element.kind === "computed") return exprNeedsSetSemantics(element.expr);
    if ((element.kind === "link" || element.kind === "backlink") && element.shape) return shapeNeedsSetSemantics(element.shape);
    return false;
  });
  return statement.kind === "select" && shapeNeedsSetSemantics(statement.shape);
};

const schemaObjectTypeQueryNeedsRuntimeBypass = (query: string): boolean => {
  const tokens = tryTokenize(query);
  if (!tokens) return false;
  const isObjectTypeQuery = tokensIncludeWithModuleSelect(tokens, "schema", "ObjectType")
    || tokensIncludeQualifiedName(tokens, "schema", "ObjectType");
  if (!isObjectTypeQuery) return false;
  // Pattern 1: `IN .properties.annotations.name` (a backlink-style filter).
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind !== "kw_in") continue;
    if (matchDotPath(tokens, i + 1, ["properties", "annotations", "name"]) >= 0) return true;
  }
  // Pattern 2: `constraints: { ... annotations: ... }` nested shape.
  const constraintsBlock = extractTopLevelBlock(query, "constraints");
  if (constraintsBlock && extractTopLevelBlock(constraintsBlock.content, "annotations")) {
    return true;
  }
  return false;
};

export const executeQuery = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
): QueryResult => {
  // Runtime fallbacks (tryRuntime*, trySchema*, tryEvaluateParsedRuntimeSelect,
  // preEvaluateGroupBindings, etc.) have been disabled. Everything must lower
  // through the compile pipeline. FOR-INSERT still routes through the unit
  // path so the script harness can surface the unsupported-lowering error
  // uniformly; FOR-SELECT goes through the normal compile pipeline.
  const rewrittenQuery = injectRuntimeAliasBinding(schema, query);
  validateRestrictedLinkPropertyTokens(rewrittenQuery);
  const parsedQuery = parseEdgeQL(rewrittenQuery);
  if (parsedQuery.kind === "for" && parsedQuery.body.kind === "insert") {
    const script = rewrittenQuery.trim().endsWith(";") ? rewrittenQuery : `${rewrittenQuery};`;
    return executeQueryUnitWithTrace(db, schema, script, securityContext).result;
  }
  return executeQueryWithTrace(db, schema, rewrittenQuery, securityContext).result;
};

export const executeScript = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  script: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
  parserOptions: ParseEdgeQLOptions = {},
): QueryResult => {
  maybeRegisterDynamicDDLScript(db, schema, script);
  if (maybeHandleAliasDDLScript(schema, script)) {
    // Alias state changed; refresh the schema::* introspection rows so
    // SELECT schema::Type FILTER .name = 'newAlias' picks them up. Both
    // typed (schema.addAlias) and runtime expr aliases (runtimeExprAliases
    // WeakMap) must be included — listAllRuntimeAliasNames merges both.
    populateSchemaIntrospection(db, schema, listAllRuntimeAliasNames(schema), runtimeExprAliases.get(schema));
    return { kind: "insert", changes: 0 };
  }
  return executeQueryUnitWithTrace(db, schema, script, securityContext, parserOptions).result;
};

export const executeQueryWithTrace = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
): QueryExecutionTrace => {
  try {
    query = injectRuntimeAliasBinding(schema, query);
    const context = normalizeSecurityContext(securityContext);
    const runtimeTarget = resolvedRuntimeTarget(context, db);
    const compilerService = getCompilerService();
    const ast = parseEdgeQL(query);
    if (ast.kind === "configure") {
      // CONFIGURE has no SQLite analogue — return an empty insert-like result
      // so callers that fire it from `.query()` don't have to pre-filter or
      // catch the compile-time "Statement kind 'configure' requires
      // typeName" raised by the strict typed-mutation pipeline.
      return {
        ast,
        ir: { kind: "select", rows: [] } as unknown as IRStatement,
        sql: { sql: "", params: [], loweringMode: "single_statement" } as SQLArtifact,
        compiler: { key: "configure-noop", status: "miss", stats: { hits: 0, misses: 0, size: 0 } },
        sqlTrail: [],
        overlays: [],
        result: { kind: "insert", changes: 0 },
      };
    }
    validateParsedStatement(ast, { schema, module: ast.withModule });
    const statementType = statementTypeOf(ast);
    enforceBuiltinPermissions(context, statementType, ast.pos.line, ast.pos.column);
    const compiled = compilerService.compile(schema, ast, { globals: context.globals, target: runtimeTarget });
    const ir = compiled.ir;
    const subjectType = ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete"
      ? typeDefForTable(schema, ir.table)
      : undefined;
    if ((ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete") && !subjectType) {
      const astTypeName = "typeName" in ast ? ast.typeName : "<unknown>";
      throw new AppError("E_SEMANTIC", `Unknown type '${astTypeName}'`, ast.pos.line, ast.pos.column);
    }
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const sqlTrail: SQLArtifact[] = [sqlArtifact];

    let result: QueryResult;
    if (ir.kind === "select") {
      result = {
        kind: "select",
        rows: runSelectIR(db, schema, ir, context, sqlArtifact, sqlTrail),
      };
    } else if (ir.kind === "select_free") {
      if (sqlArtifact.loweringMode !== "single_statement") {
        throw new AppError(
          "E_UNSUPPORTED",
          "select_free requires SQL lowering; runtime fallback disabled",
          ast.pos.line,
          ast.pos.column,
        );
      }
      result = {
        kind: "select",
        rows: runSelectFreeSQL(db, sqlArtifact),
      };
    } else if (ir.kind === "select_expr") {
      result = {
        kind: "select",
        rows: runGelSelectExprSQL(db, sqlArtifact),
      };
    } else if (ir.kind === "group") {
      throw new AppError(
        "E_UNSUPPORTED",
        "GROUP requires SQL lowering; runtime fallback disabled",
        ast.pos.line,
        ast.pos.column,
      );
    } else {
      const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType!, context);

      result = {
        kind: ir.kind,
        changes: writeResult.changes,
        rows: writeResult.rows,
      };
    }

    return {
      ast,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: extractOverlays(ir),
      result,
    };
  } catch (err) {
    throw asAppError(decorateErrorWithUnsupportedTag(err, query));
  }
};

const extractTargetTypeExpr = (target: FreeObjectExpr): TypeExpr | undefined => {
  if (target.kind === "distinct") {
    return extractTargetTypeExpr(target.expr);
  }
  if (target.kind === "shape_projection") {
    return extractTargetTypeExpr(target.expr);
  }
  if (target.kind === "is_type" && target.typeExpr) {
    const inner = extractTargetTypeExpr(target.expr);
    if (!inner) return undefined;
    return { kind: "type_intersection", left: inner, right: target.typeExpr };
  }
  if (target.kind === "set_expr") {
    if (target.values.length === 0) return undefined;
    const exprs: TypeExpr[] = [];
    for (const value of target.values) {
      const inner = extractTargetTypeExpr(value);
      if (!inner) return undefined;
      exprs.push(inner);
    }
    return exprs.reduce((acc, next) => ({ kind: "type_union", left: acc, right: next }));
  }
  if (target.kind === "binding_ref") {
    return { kind: "type_name", name: target.name };
  }
  if (target.kind === "select") {
    const hasOnlyDefaultId = !target.shape
      || target.shape.length === 0
      || target.shape.every((el) => el.kind === "field" && el.name === "id" && (el as { origin?: string }).origin === "default");
    if (hasOnlyDefaultId) {
      return { kind: "type_name", name: target.typeName };
    }
    return undefined;
  }
  if (target.kind === "path_steps") {
    const head = target.steps[0];
    if (!head || head.kind !== "object_ref") return undefined;
    let current: TypeExpr = { kind: "type_name", name: head.name };
    for (const step of target.steps.slice(1)) {
      if (step.kind !== "type_intersection" || !step.typeExpr) return undefined;
      current = { kind: "type_intersection", left: current, right: step.typeExpr };
    }
    return current;
  }
  return undefined;
};

const concreteTypeNamesForTypeExprAtRuntime = (
  schema: SchemaSnapshot,
  expr: TypeExpr,
  moduleName = "default",
): string[] => {
  const qualify = (n: string): string => (n.includes("::") ? n : `${moduleName}::${n}`);
  const visit = (node: TypeExpr): string[] => {
    if (node.kind === "type_name") {
      const qualified = qualify(node.name);
      if (qualified === "default::Object" || qualified === "std::Object") {
        return schema.listTypes()
          .filter((typeDef) => !typeDef.abstract)
          .map((typeDef) => qualifiedTypeName(typeDef));
      }
      return schema.listConcreteTypesAssignableTo(qualified).map((typeDef) => qualifiedTypeName(typeDef));
    }
    const left = new Set(visit(node.left));
    const right = new Set(visit(node.right));
    if (node.kind === "type_union") {
      return [...new Set([...left, ...right])];
    }
    return [...left].filter((name) => right.has(name));
  };
  return [...new Set(visit(expr))];
};

const expandPolymorphicMutation = (
  schema: SchemaSnapshot,
  ast: UpdateStatement | DeleteStatement,
): Array<UpdateStatement | DeleteStatement> | undefined => {
  const target = ast.target;
  if (!target) {
    const qualified = ast.typeName.includes("::") ? ast.typeName : `default::${ast.typeName}`;
    if (qualified !== "default::Object" && qualified !== "std::Object") {
      return undefined;
    }
    const concretes = schema.listTypes()
      .filter((typeDef) => !typeDef.abstract)
      .map((typeDef) => qualifiedTypeName(typeDef));
    return concretes.map((typeName) => ({ ...ast, typeName }));
  }
  const typeExpr = extractTargetTypeExpr(target);
  if (!typeExpr) {
    return undefined;
  }
  const concretes = concreteTypeNamesForTypeExprAtRuntime(schema, typeExpr, ast.withModule ?? "default");
  if (concretes.length === 0) {
    return [];
  }
  return concretes.map((typeName) => ({ ...ast, typeName, target: undefined }));
};

export const executeQueryUnitWithTrace = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  script: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
  parserOptions: ParseEdgeQLOptions = {},
): QueryUnitTrace => {
  try {
    maybeRegisterDynamicDDLScript(db, schema, script);
    const context = normalizeSecurityContext(securityContext);
    const runtimeTarget = resolvedRuntimeTarget(context, db);
    const compilerService = getCompilerService();
    const statements = parseEdgeQLScript(script, parserOptions);
    if (statements.length === 0) {
      throw new Error("No statements to execute");
    }

    const overlays: OverlayIR[] = [];
    const traces: QueryExecutionTrace[] = [];

    const expanded: Statement[] = [];
    for (const ast of statements) {
      if (ast.kind === "delete" || ast.kind === "update") {
        const expansion = expandPolymorphicMutation(schema, ast);
        if (expansion) {
          expanded.push(...expansion);
          continue;
        }
      }
      expanded.push(ast);
    }

    for (const ast of expanded) {
      if (ast.kind === "for" && ast.body.kind === "insert"
        && ast.iteratorExpr.kind === "set_literal") {
        // AST-level desugar of `FOR x IN {literals…} UNION (INSERT T { … })`:
        // emit one cleanly-lowered INSERT per literal with the iter binding
        // substituted in. No expression evaluation happens here — only
        // symbolic substitution of `binding_ref(x)` with the literal value.
        const iterValues = ast.iteratorExpr.values;
        const effectiveValues: (ScalarValue | null)[] = iterValues.length === 0 && ast.optional
          ? [null]
          : (iterValues as (ScalarValue | null)[]);
        for (const value of effectiveValues) {
          const insertValues: Record<string, InsertValue> = {};
          for (const [key, v] of Object.entries(ast.body.values)) {
            if (typeof v === "object" && v !== null && "kind" in v
              && (v as { kind?: unknown }).kind === "binding_ref"
              && (v as { name?: unknown }).name === ast.variable) {
              insertValues[key] = value as InsertValue;
            } else {
              insertValues[key] = v;
            }
          }
          const insertAst: InsertStatement = {
            ...ast.body,
            with: value !== null && isScalarValue(value)
              ? [
                  ...(ast.body.with ?? []).filter((binding) => binding.name !== ast.variable),
                  { name: ast.variable, value: { kind: "literal", value } },
                ]
              : ast.body.with,
            values: insertValues,
          };
          expanded.push(insertAst);
        }
        continue;
      }
      if (ast.kind === "for") {
        // Non-INSERT FOR statements (e.g. `FOR x IN T UNION (x.name, T.name)`)
        // are lowered as SELECTs through `compileASTToGelIR`. Surface the
        // remaining unsupported FOR-body shapes with a uniform error.
        if (ast.body.kind !== "select_expr" && ast.body.kind !== "select") {
          throw new AppError(
            "E_UNSUPPORTED",
            "FOR requires SQL lowering; runtime fallback disabled",
            ast.pos.line,
            ast.pos.column,
          );
        }
      }
      if (ast.kind === "ddl") {
        if (ast.action === "create" && ast.objectKind === "function" && ast.functionDecl) {
          applyParsedFunctionDDL(schema, ast, parserOptions.defaultModule ?? "default");
          populateSchemaIntrospection(db, schema, listAllRuntimeAliasNames(schema), runtimeExprAliases.get(schema));
          compilerService.clear();
        }
        continue;
      }
      if (ast.kind === "configure") {
        // Session/instance/database CONFIGURE statements (e.g. `CONFIGURE
        // SESSION SET allow_user_specified_id := true`) don't have a SQLite
        // analogue — sqlite-ts has no equivalent session-config knobs to
        // mutate. Treat them as no-ops so scripts that use them for parity
        // with upstream still execute their following DML.
        continue;
      }

      validateParsedStatement(ast, { schema, module: ast.withModule });
      const statementType = statementTypeOf(ast);
      enforceBuiltinPermissions(context, statementType, ast.pos.line, ast.pos.column);
      const astSubjectType = ast.kind === "insert" || ast.kind === "update" || ast.kind === "delete"
        ? schema.getType(ast.typeName)
        : undefined;
      // (Removed legacy silent-skip for INSERT-with-unknown-type-and-no-shape.
      // It was masking real errors like `INSERT Object;` /
      // `INSERT std::FreeObject;` / `INSERT InsertTest;` — fall through to
      // compilation and let the IR pass raise the right diagnostic instead.)

      const compiled = compilerService.compile(schema, ast, { overlays, globals: context.globals, target: runtimeTarget });
      const ir = compiled.ir;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const subjectType = ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete"
        ? typeDefForTable(schema, ir.table)
        : undefined;
      if ((ir.kind === "insert" || ir.kind === "update" || ir.kind === "delete") && !subjectType) {
        const astTypeName = "typeName" in ast ? ast.typeName : "<unknown>";
        throw new AppError("E_SEMANTIC", `Unknown type '${astTypeName}'`, ast.pos.line, ast.pos.column);
      }

      let result: QueryResult;
      if (ir.kind === "select") {
        result = { kind: "select", rows: runSelectIR(db, schema, ir, context, sqlArtifact, sqlTrail) };
      } else if (ir.kind === "select_free") {
        if (sqlArtifact.loweringMode !== "single_statement") {
          throw new AppError(
            "E_UNSUPPORTED",
            "select_free requires SQL lowering; runtime fallback disabled",
            ast.pos.line,
            ast.pos.column,
          );
        }
        result = { kind: "select", rows: runSelectFreeSQL(db, sqlArtifact) };
      } else if (ir.kind === "select_expr") {
        result = {
          kind: "select",
          rows: runGelSelectExprSQL(db, sqlArtifact),
        };
      } else if (ir.kind === "group") {
        throw new AppError(
          "E_UNSUPPORTED",
          "GROUP requires SQL lowering; runtime fallback disabled",
          ast.pos.line,
          ast.pos.column,
        );
      } else {
        const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType!, context);
        result = { kind: ir.kind, changes: writeResult.changes, rows: writeResult.rows };
      }

      const currentOverlays = extractOverlays(ir);
      if (ir.kind !== "select" && ir.kind !== "select_free") {
        overlays.push(...currentOverlays);
      }

      traces.push({
        ast,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
        result,
      });
    }

    return {
      traces,
      result: traces.length > 0 ? traces[traces.length - 1].result : { kind: "insert", changes: 0 },
    };
  } catch (err) {
    throw asAppError(decorateErrorWithUnsupportedTag(err, script));
  }
};

const substituteBindingInFreeObjectExpr = (
  expr: FreeObjectExpr,
  variable: string,
  value: ScalarValue,
): FreeObjectExpr => {
  const rec = (e: FreeObjectExpr): FreeObjectExpr => substituteBindingInFreeObjectExpr(e, variable, value);
  switch (expr.kind) {
    case "binding_ref":
      return expr.name === variable ? { kind: "literal", value } : expr;
    case "field_access":
      return { ...expr, expr: rec(expr.expr) };
    case "index_access":
      return { ...expr, expr: rec(expr.expr) };
    case "compare":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "math":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "logical":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "and":
    case "or":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "not":
    case "unary":
    case "exists":
    case "distinct":
    case "cast":
      return { ...expr, expr: rec(expr.expr) };
    case "concat":
      return { ...expr, parts: expr.parts.map((p) => rec(p)) };
    case "tuple":
      return { ...expr, values: expr.values.map((v) => rec(v)) };
    case "if_else":
      return { ...expr, thenExpr: rec(expr.thenExpr), condition: rec(expr.condition), elseExpr: rec(expr.elseExpr) };
    case "coalesce":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    default:
      return expr;
  }
};

const substituteBindingInASTFilter = (
  filter: FilterExpr,
  variable: string,
  value: ScalarValue,
): FilterExpr => {
  if (filter.kind === "predicate") {
    const fv = filter.value;
    if (typeof fv === "object" && fv !== null && "kind" in fv && fv.kind === "binding_ref" && fv.name === variable) {
      return { ...filter, value };
    }
    return filter;
  }
  if (filter.kind === "and" || filter.kind === "or") {
    return {
      ...filter,
      left: substituteBindingInASTFilter(filter.left, variable, value),
      right: substituteBindingInASTFilter(filter.right, variable, value),
    };
  }
  if (filter.kind === "not") {
    return {
      ...filter,
      expr: substituteBindingInASTFilter(filter.expr, variable, value),
    };
  }
  if (filter.kind === "free_expr") {
    return { ...filter, expr: substituteBindingInFreeObjectExpr(filter.expr, variable, value) };
  }
  return filter;
};

// Convert a JS value materialised at runtime (e.g. a row from runGroupIR)
// back into a FreeObjectExpr AST so it can be inlined as a synthetic WITH
// binding value. Objects become free_object_constructor, arrays become
// set_expr of nested constructors/literals, scalars become literal nodes.
const jsValueToFreeObjectExpr = (
  value: unknown,
): FreeObjectExpr => {
  if (value === null || value === undefined) {
    return { kind: "literal", value: null };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", value: value as ScalarValue };
  }
  if (typeof value === "bigint") {
    return { kind: "literal", value: Number(value) };
  }
  if (Array.isArray(value)) {
    return { kind: "set_expr", values: value.map(jsValueToFreeObjectExpr) };
  }
  if (typeof value === "object") {
    return {
      kind: "free_object_constructor",
      entries: Object.entries(value as Record<string, unknown>).map(([name, val]) => ({
        name,
        expr: jsValueToFreeObjectExpr(val),
      })),
    };
  }
  return { kind: "literal", value: null };
};

// Walk an AST and pre-evaluate any WITH binding whose value is a GROUP.
// Returns the rewritten AST (with the GROUP results inlined) or the original
// when nothing needed pre-evaluation.
const preEvaluateGroupBindings = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  context: SecurityContext,
): Statement => {
  if (!ast.with || ast.with.length === 0) return ast;
  let rewrote = false;
  const newWith = ast.with.map((binding) => {
    const value = binding.value;
    let groupExpr: Extract<FreeObjectExpr, { kind: "group_expr" }> | undefined;
    if (value.kind === "subquery_expr") {
      if (value.expr.kind === "group_expr") {
        groupExpr = value.expr;
      } else if (value.expr.kind === "select_expr_subquery" && value.expr.expr.kind === "group_expr") {
        groupExpr = value.expr.expr;
      }
    }
    if (!groupExpr) return binding;
    const groupStatement: Extract<Statement, { kind: "group" }> = {
      kind: "group",
      source: groupExpr.source,
      using: groupExpr.using,
      by: groupExpr.by,
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      pos: ast.pos,
    };
    try {
      const compiled = getCompilerService().compile(schema, groupStatement, {
        globals: context.globals,
        target: resolvedRuntimeTarget(context, db),
      });
      if (compiled.ir.kind !== "group") return binding;
      const rows = runGroupIR(db, schema, compiled.ir, context, []);
      rewrote = true;
      return {
        name: binding.name,
        value: {
          kind: "subquery_expr" as const,
          expr: { kind: "set_expr" as const, values: rows.map(jsValueToFreeObjectExpr) },
        },
      };
    } catch {
      return binding;
    }
  });
  if (!rewrote) return ast;
  return { ...ast, with: newWith };
};

const unwrapGroupIteratorExpr = (
  expr: FreeObjectExpr,
): Extract<FreeObjectExpr, { kind: "group_expr" }> | undefined => {
  let cursor: FreeObjectExpr = expr;
  if (cursor.kind === "select_expr_subquery") {
    cursor = cursor.expr;
  }
  if (cursor.kind === "group_expr") {
    return cursor;
  }
  return undefined;
};

const executeForLoop = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: ForStatement,
  context: SecurityContext,
  runtimeTarget: RuntimeTarget,
  compilerService: ReturnType<typeof getCompilerService>,
  overlays: OverlayIR[],
  traces: QueryExecutionTrace[],
): void => {
  const iteratorExpr = ast.iteratorExpr;
  const body = ast.body;

  // `FOR g IN (GROUP …) UNION (…body…)` — run the GROUP, then evaluate the
  // body once per group row with `g` bound to that row. Also accept the iterator
  // wrapped in a no-op SELECT subquery (`FOR g IN (SELECT (GROUP …)) UNION …`).
  const groupIterator = unwrapGroupIteratorExpr(iteratorExpr);
  if (groupIterator && body.kind === "select_expr") {
    const groupStatement = {
      kind: "group" as const,
      source: groupIterator.source,
      using: groupIterator.using,
      by: groupIterator.by,
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      pos: ast.pos,
    };
    const compiled = compilerService.compile(schema, groupStatement, {
      overlays,
      globals: context.globals,
      target: runtimeTarget,
    });
    const ir = compiled.ir;
    const sqlArtifact = compiled.sql;
    const sqlTrail: SQLArtifact[] = [sqlArtifact];
    const groupRows = ir.kind === "group"
      ? runGroupIR(db, schema, ir, context, sqlTrail)
      : [];
    const outputRows = groupRows.map((groupRow) => {
      const bindings = new Map<string, unknown>([[ast.variable, groupRow]]);
      const result = evalGroupRowExpr(body.expr, groupRow, bindings);
      if (result && typeof result === "object" && !Array.isArray(result)) {
        return result as Record<string, unknown>;
      }
      return { value: result };
    });
    traces.push({
      ast,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: extractOverlays(ir),
      result: { kind: "select", rows: outputRows },
    });
    return;
  }

  if (body.kind === "insert") {
    let iteratorValues = evaluateForIteratorValues(iteratorExpr, schema, db, context);
    if (ast.optional && iteratorValues.length === 0) {
      iteratorValues = [null];
    }
    const insertedRows: Record<string, unknown>[] = [];
    let lastTraceFields: Omit<QueryExecutionTrace, "result"> | undefined;
    for (const value of iteratorValues) {
      const insertValues: Record<string, InsertValue> = {};
      for (const [key, v] of Object.entries(body.values)) {
        if (typeof v === "object" && v !== null && "kind" in v && v.kind === "binding_ref" && v.name === ast.variable) {
          insertValues[key] = value as InsertValue;
        } else {
          insertValues[key] = v;
        }
      }

      const insertAst: InsertStatement = {
        ...body,
        with: isScalarValue(value)
          ? [
              ...(body.with ?? []).filter((binding) => binding.name !== ast.variable),
              { name: ast.variable, value: { kind: "literal", value } },
            ]
          : body.with,
        values: insertValues,
      };

      const subjectTypeName = insertAst.typeName.includes("::")
        ? insertAst.typeName
        : `${insertAst.withModule ?? ast.withModule ?? "default"}::${insertAst.typeName}`;
      const subjectType = schema.getType(subjectTypeName);
      if (!subjectType) {
        throw new AppError("E_SEMANTIC", `Unknown type '${insertAst.typeName}'`, ast.pos.line, ast.pos.column);
      }

      const compiled = compilerService.compile(schema, insertAst, { overlays, globals: context.globals, target: runtimeTarget });
      const ir = compiled.ir;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const writeResult = runWriteWithAccessPolicies(db, schema, insertAst, ir, sqlArtifact, subjectType, context);

      const currentOverlays = extractOverlays(ir);
      if (ir.kind !== "select" && ir.kind !== "select_free" && ir.kind !== "select_expr") {
        overlays.push(...currentOverlays);
      }

      for (let i = 0; i < writeResult.changes; i += 1) {
        insertedRows.push({});
      }

      lastTraceFields = {
        ast: insertAst,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
      };
    }
    if (lastTraceFields) {
      traces.push({
        ...lastTraceFields,
        result: { kind: "select", rows: insertedRows },
      });
    }
    return;
  }

  if (body.kind === "select_expr") {
    const syntheticAst: SelectExprStatement = {
      kind: "select_expr",
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      expr: {
        kind: "for_expr",
        variable: ast.variable,
        iterator: iteratorExpr,
        body: body.expr,
        optional: ast.optional,
      },
      orderBy: body.orderBy,
      pos: ast.pos,
    };

    // The compile-to-SQL path can't lower bodies that need the AST runtime
    // (UDF calls, alias subqueries with link-property shapes, etc.) — it
    // emits stub SQL that returns a single NULL row. Try the AST evaluator
    // first; it iterates per-binding in JS and routes UDF calls through
    // executeFunctionCall. `tryRuntimeSelectExprEvaluationAst` returns
    // undefined when the body doesn't need runtime eval, so plain FOR loops
    // still fall through to the SQL path below.
    const runtimeResult = tryRuntimeSelectExprEvaluationAst(db, schema, syntheticAst, context);

    const compiled = compilerService.compile(schema, syntheticAst, { overlays, globals: context.globals, target: runtimeTarget });
    const ir = compiled.ir;
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const sqlTrail: SQLArtifact[] = [sqlArtifact];

    const rows = runtimeResult?.kind === "select"
      ? runtimeResult.rows
      : ir.kind === "select_expr"
        ? runGelSelectExprSQL(db, sqlArtifact)
        : [];

    const currentOverlays = extractOverlays(ir);
    traces.push({
      ast: syntheticAst,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: currentOverlays,
      result: { kind: "select", rows },
    });
    return;
  }

  if (body.kind === "select_free") {
    const syntheticAst: SelectExprStatement = {
      kind: "select_expr",
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      expr: {
        kind: "for_expr",
        variable: ast.variable,
        iterator: iteratorExpr,
        body: {
          kind: "select_expr_subquery",
          alias: undefined,
          expr: {
            kind: "set_expr",
            values: body.entries.map((entry) => ({
              kind: "select_expr_subquery",
              alias: entry.name,
              expr: entry.expr,
            })),
          },
        },
        optional: ast.optional,
      },
      pos: ast.pos,
    };

    const compiled = compilerService.compile(schema, syntheticAst, { overlays, globals: context.globals, target: runtimeTarget });
    const ir = compiled.ir;
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const sqlTrail: SQLArtifact[] = [sqlArtifact];

    const rows = ir.kind === "select_expr"
      ? runGelSelectExprSQL(db, sqlArtifact)
      : [];

    const currentOverlays = extractOverlays(ir);
    traces.push({
      ast: syntheticAst,
      ir,
      sql: sqlArtifact,
      compiler: compiled.cache,
      sqlTrail,
      overlays: currentOverlays,
      result: { kind: "select", rows },
    });
    return;
  }

  {
    let iteratorValues = evaluateForIteratorValues(iteratorExpr, schema, db, context);
    if (ast.optional && iteratorValues.length === 0) {
      iteratorValues = [null];
    }
    const allRows: Record<string, unknown>[] = [];
    for (const value of iteratorValues) {
      const selectAst = bindSelectAstVariable(body, ast.variable, value);

      const compiled = compilerService.compile(schema, selectAst, { overlays, globals: context.globals, target: runtimeTarget });
      const ir = compiled.ir as SelectIR;
      const sqlArtifact = compiled.sql;
      assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
      const sqlTrail: SQLArtifact[] = [sqlArtifact];

      const rows = runSelectIR(db, schema, ir, context, sqlArtifact, sqlTrail);
      allRows.push(...rows);

      const currentOverlays = extractOverlays(ir);
      overlays.push(...currentOverlays);

      traces.push({
        ast: selectAst,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
        result: { kind: "select" as const, rows: allRows },
      });
    }
  }
};

const evaluateForIteratorValues = (
  expr: ForStatement["iteratorExpr"],
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
): unknown[] => {
  if (expr.kind === "literal") {
    return [expr.value];
  }

  if (expr.kind === "set_literal") {
    return expr.values;
  }

  if (expr.kind === "select") {
    const shape = expr.shape.length > 0 ? [...expr.shape] : [{ kind: "field", name: "id" } as const];
    const hasId = shape.some((element) => element.kind === "field" && element.name === "id");
    if (!hasId) {
      shape.unshift({ kind: "field", name: "id" });
    }

    const selectAst: SelectStatement = {
      kind: "select",
      typeName: expr.typeName,
      shape,
      fields: fieldsFromShape(shape),
      filter: expr.clauses.filter,
      orderBy: expr.clauses.orderBy,
      limit: expr.clauses.limit,
      offset: expr.clauses.offset,
      with: expr.clauses._withBindings,
      withModule: expr.clauses._withModule,
      withModuleAliases: expr.clauses._withModuleAliases,
      pos: { line: 1, column: 1 },
    };

    const compiler = getCompilerService();
    const compiled = compiler.compile(schema, selectAst, { globals: context.globals, target: resolvedRuntimeTarget(context, db) });
    assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
    if (compiled.ir.kind !== "select") {
      return [];
    }

    return runSelectIR(db, schema, compiled.ir, context, compiled.sql, []);
  }

  if (expr.kind === "mutation_expr") {
    return executeMutationBinding(db, schema, expr.statement, context);
  }

  if (expr.kind === "distinct") {
    const values = evaluateForIteratorValues(expr.expr as ForStatement["iteratorExpr"], schema, db, context);
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of values) {
      const key = JSON.stringify(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  if (expr.kind === "function_call") {
    const args: RuntimeFunctionArg[] = expr.call.args.map((arg) => {
      if (arg.kind === "literal") return arg.value;
      if (arg.kind === "set_literal") return { kind: "array", values: arg.values };
      if (arg.kind === "array_literal") return { kind: "array", values: arg.values };
      return null;
    });
    const qualifiedName = expr.call.name.includes("::")
      ? expr.call.name
      : `default::${expr.call.name}`;
    const fnResult = executeFunctionCall(schema, db, context, qualifiedName, args);
    return Array.isArray(fnResult) ? fnResult : [fnResult];
  }

  if (expr.kind === "concat") {
    let results: unknown[] = [""];
    for (const part of expr.parts) {
      const partValues = evaluateForIteratorValues(part as ForStatement["iteratorExpr"], schema, db, context);
      const next: unknown[] = [];
      for (const left of results) {
        for (const right of partValues) {
          if (typeof left === "string" && typeof right === "string") {
            next.push(left + right);
          } else if (left === null || left === undefined) {
            next.push(right);
          } else if (right === null || right === undefined) {
            next.push(left);
          } else {
            next.push(`${left}${right}`);
          }
        }
      }
      results = next;
    }
    return results.length > 0 ? results : [null];
  }

  return [null];
};

const bindSelectAstVariable = (
  body: SelectStatement,
  variable: string,
  value: unknown,
): SelectStatement => {
  const scalar = coerceUnknownToScalar(value);
  if (!scalar) {
    return {
      ...body,
      filter: body.filter,
    };
  }

  const existing = (body.with ?? []).filter((binding) => binding.name !== variable);
  return {
    ...body,
    with: [...existing, { name: variable, value: { kind: "literal", value: scalar } }],
    filter: body.filter ? substituteBindingInASTFilter(body.filter, variable, scalar) : undefined,
  };
};

const ensureSelectAstHasId = (ast: SelectStatement): SelectStatement => {
  const hasId = ast.shape.some((element) => element.kind === "field" && element.name === "id");
  if (hasId) {
    return ast;
  }

  const shape = [{ kind: "field", name: "id" } as const, ...ast.shape];
  const fields = ast.fields.includes("id") ? ast.fields : ["id", ...ast.fields];
  return {
    ...ast,
    shape,
    fields,
  };
};

const coerceUnknownToScalar = (value: unknown): ScalarValue | undefined => {
  if (isScalarValue(value)) {
    return value;
  }

  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
};

// Evaluates a select_expr shape-entry value (a FreeObjectExpr in the AST)
// against the current row. Only handles the polymorphic path pattern
// `[is T].field[.subfield…]` rooted at the implicit subject — used by
// computed shape entries like `x := [is OtherType].dest.name`. Anything
// outside that pattern returns null so the caller can supply its own
// fallback.
// Sentinel marker for an empty set during free-expression evaluation. In
// EdgeQL semantics, `{}` and a NULL-valued field are both empty sets.
const SHAPE_EMPTY_SET = Symbol("empty_set");

// Whether the FreeObjectExpr can produce more than one value (set semantics).
// Used to decide if the shape's evaluator output should be wrapped as an array.
const exprIsPotentiallyMulti = (expr: FreeObjectExpr): boolean => {
  if (expr.kind === "set_expr") return expr.values.length > 1 || expr.values.some(exprIsPotentiallyMulti);
  if (expr.kind === "coalesce") return exprIsPotentiallyMulti(expr.left) || exprIsPotentiallyMulti(expr.right);
  if (expr.kind === "if_else") return exprIsPotentiallyMulti(expr.thenExpr) || exprIsPotentiallyMulti(expr.elseExpr);
  if (expr.kind === "cast" || expr.kind === "unary" || expr.kind === "select_expr_subquery") return exprIsPotentiallyMulti(expr.expr);
  if (expr.kind === "math" || expr.kind === "compare") return exprIsPotentiallyMulti(expr.left) || exprIsPotentiallyMulti(expr.right);
  return false;
};

const flattenShapeValues = (value: unknown): unknown[] => {
  if (value === SHAPE_EMPTY_SET) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenShapeValues(item));
  }
  return [value];
};

const evaluateFreeExprForShape = (
  expr: FreeObjectExpr,
  row: Record<string, unknown>,
  resolveCurrentField?: (field: string) => unknown,
  evalFunctionCall?: (functionName: string, args: RuntimeFunctionArg[]) => unknown,
): unknown => {
  const rec = (e: FreeObjectExpr): unknown => evaluateFreeExprForShape(e, row, resolveCurrentField, evalFunctionCall);
  if (expr.kind === "literal") {
    return expr.value;
  }
  if (expr.kind === "field_access") {
    if (!expr.expr || (expr.expr.kind !== "select" && expr.expr.kind !== "current_item" && expr.expr.kind !== "binding_ref")) {
      // Nested field accesses (e.g. Issue.x.y) are not supported here yet.
      return undefined;
    }
    const resolved = resolveCurrentField?.(expr.field);
    if (resolved !== undefined) {
      return resolved === null ? SHAPE_EMPTY_SET : resolved;
    }
    const value = row[expr.field];
    if (value === undefined || value === null) return SHAPE_EMPTY_SET;
    return value;
  }
  if (expr.kind === "function_call") {
    if (!evalFunctionCall) return undefined;
    const argValues: RuntimeFunctionArg[] = [];
    for (const arg of expr.call.args) {
      if (arg.kind === "literal") {
        argValues.push(arg.value);
        continue;
      }
      if (arg.kind === "set_literal") {
        argValues.push({ kind: "set", values: [...arg.values] });
        continue;
      }
      if (arg.kind === "array_literal") {
        argValues.push({ kind: "array", values: [...arg.values] });
        continue;
      }
      if (arg.kind === "expr") {
        const v = rec(arg.expr);
        if (v === undefined) return undefined;
        const flat = flattenShapeValues(v);
        if (flat.length === 0) {
          // EdgeQL: applying a function to an empty set produces an empty set.
          // Surface that as SHAPE_EMPTY_SET upstream.
          return SHAPE_EMPTY_SET;
        }
        argValues.push(flat.length === 1 ? flat[0] as ScalarValue : { kind: "array", values: flat as ScalarValue[] });
        continue;
      }
      if (arg.kind === "function_call") {
        const v = rec({ kind: "function_call", call: arg.call });
        if (v === undefined) return undefined;
        argValues.push(v as ScalarValue);
        continue;
      }
      return undefined;
    }
    // Function names in the AST are usually unqualified (`str_upper`). The
    // stdlib defines them under `std::`; resolve there first, then fall back
    // to `default::` for user-defined functions.
    const rawName = expr.call.name;
    const candidateName = rawName.includes("::")
      ? rawName
      : (resolveStdlibFunction(`std::${rawName}`, argValues.length) ? `std::${rawName}` : `default::${rawName}`);
    return evalFunctionCall(candidateName, argValues);
  }
  if (expr.kind === "unary") {
    const inner = rec(expr.expr);
    if (inner === undefined) return undefined;
    const values = flattenShapeValues(inner);
    if (values.length === 0) return SHAPE_EMPTY_SET;
    const apply = (v: unknown): unknown => {
      if (typeof v !== "number" && typeof v !== "boolean" && typeof v !== "bigint") return null;
      if (expr.op === "neg") return -(v as number);
      if (expr.op === "not") return !(v as boolean);
      return null;
    };
    const out = values.map(apply);
    return out.length === 1 ? out[0] : out;
  }
  if (expr.kind === "math") {
    const left = rec(expr.left);
    const right = rec(expr.right);
    if (left === undefined || right === undefined) return undefined;
    const ls = flattenShapeValues(left);
    const rs = flattenShapeValues(right);
    if (ls.length === 0 || rs.length === 0) return SHAPE_EMPTY_SET;
    const op = expr.op;
    const apply = (a: unknown, b: unknown): unknown => {
      const an = Number(a);
      const bn = Number(b);
      if (!Number.isFinite(an) || !Number.isFinite(bn)) return null;
      if (op === "+") return an + bn;
      if (op === "-") return an - bn;
      if (op === "*") return an * bn;
      if (op === "/") return an / bn;
      if (op === "//") return Math.floor(an / bn);
      if (op === "%") return an % bn;
      if (op === "^") return Math.pow(an, bn);
      return null;
    };
    const out: unknown[] = [];
    for (const l of ls) {
      for (const r of rs) {
        out.push(apply(l, r));
      }
    }
    return out.length === 1 ? out[0] : out;
  }
  if (expr.kind === "cast") {
    return rec(expr.expr);
  }
  if (expr.kind === "select_expr_subquery") {
    return rec(expr.expr);
  }
  if (expr.kind === "set_expr") {
    const out: unknown[] = [];
    for (const value of expr.values) {
      const v = rec(value);
      if (v === undefined) return undefined;
      out.push(...flattenShapeValues(v));
    }
    return out;
  }
  if (expr.kind === "set_literal") {
    return [...expr.values];
  }
  if (expr.kind === "coalesce") {
    const left = rec(expr.left);
    if (left === undefined) return undefined;
    const ls = flattenShapeValues(left);
    if (ls.length > 0) {
      return ls.length === 1 ? ls[0] : ls;
    }
    const right = rec(expr.right);
    if (right === undefined) return undefined;
    const rs = flattenShapeValues(right);
    return rs.length === 1 ? rs[0] : rs;
  }
  if (expr.kind === "compare") {
    const left = rec(expr.left);
    const right = rec(expr.right);
    if (left === undefined || right === undefined) return undefined;
    const ls = flattenShapeValues(left);
    const rs = flattenShapeValues(right);
    if (expr.op === "?=" || expr.op === "?!=") {
      // ?= and ?!= are OPTIONAL over both sides — empty values participate.
      // Use {null} as the implicit singleton when a side is empty, so a
      // non-empty side still produces a cardinality matching its element count.
      const leftItems = ls.length === 0 ? [null] : ls;
      const rightItems = rs.length === 0 ? [null] : rs;
      const out: boolean[] = [];
      for (const l of leftItems) {
        for (const r of rightItems) {
          const lEmpty = l === null && ls.length === 0;
          const rEmpty = r === null && rs.length === 0;
          const eq = lEmpty && rEmpty ? true : lEmpty || rEmpty ? false : l === r;
          out.push(expr.op === "?=" ? eq : !eq);
        }
      }
      return out.length === 1 ? out[0] : out;
    } else if (ls.length === 0 || rs.length === 0) {
      return SHAPE_EMPTY_SET;
    }
    const cmpOne = (a: unknown, b: unknown): boolean => {
      switch (expr.op) {
        case "=": return a === b;
        case "!=": return a !== b;
        case "<": return (a as number) < (b as number);
        case "<=": return (a as number) <= (b as number);
        case ">": return (a as number) > (b as number);
        case ">=": return (a as number) >= (b as number);
        default: return false;
      }
    };
    const out: boolean[] = [];
    for (const l of ls) {
      for (const r of rs) {
        out.push(cmpOne(l, r));
      }
    }
    return out.length === 1 ? out[0] : out;
  }
  if (expr.kind === "if_else") {
    const cond = rec(expr.condition);
    if (cond === undefined) return undefined;
    const cs = flattenShapeValues(cond);
    if (cs.length === 0) return SHAPE_EMPTY_SET;
    if (cs[0]) {
      return rec(expr.thenExpr);
    }
    return rec(expr.elseExpr);
  }
  if (expr.kind === "tuple" || expr.kind === "array_literal_expr") {
    // EdgeQL tuple and array literals are SINGLE values made of their slots.
    // Evaluate each slot scalarly (taking the first element if the slot is a
    // singleton set) and pack into a JS array; an empty slot makes the whole
    // value empty.
    const slots: unknown[] = [];
    for (const value of expr.values) {
      const v = rec(value);
      if (v === undefined) return undefined;
      const flat = flattenShapeValues(v);
      if (flat.length === 0) return SHAPE_EMPTY_SET;
      slots.push(flat.length === 1 ? flat[0] : flat[0]);
    }
    return slots;
  }
  return undefined;
};

// Load source rows that link to `targetId` via a backlink_path. Returns
// the polymorphic concrete rows plus their owning type name, mirroring how
// EdgeQL's `<linkName[IS Source]` walks the schema closure.
const collectBacklinkSourceRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  body: { kind: "backlink_path"; link: string; sourceType?: string },
  targetId: string,
): Array<{ row: Record<string, unknown>; typeName: string }> => {
  const sourceTypeHint = body.sourceType;
  if (!sourceTypeHint) return [];
  const sourceTypeQualified = sourceTypeHint.includes("::") ? sourceTypeHint : `default::${sourceTypeHint}`;
  const concreteSourceTypes = schema.listConcreteTypesAssignableTo(sourceTypeQualified);
  const sourceRows: Array<{ row: Record<string, unknown>; typeName: string }> = [];
  for (const sourceType of concreteSourceTypes) {
    const link = (sourceType.links ?? []).find((candidate) => candidate.name === body.link);
    if (!link) continue;
    const sourceTable = tableNameForType(qualifiedTypeName(sourceType));
    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    if (usesLinkTable) {
      const owner = resolveLinkStorageOwner(schema, sourceType, link);
      const linkTable = `${tableNameForType(qualifiedTypeName(owner))}__${link.name.toLowerCase()}`;
      const linkRows = db
        .prepare(`SELECT s.* FROM ${quoteIdent(sourceTable)} s JOIN ${quoteIdent(linkTable)} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`)
        .all(targetId) as Record<string, unknown>[];
      for (const r of linkRows) {
        sourceRows.push({ row: r, typeName: qualifiedTypeName(sourceType) });
      }
      continue;
    }
    const inlineColumn = `${link.name}_id`;
    const inlineRows = db
      .prepare(`SELECT * FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent(inlineColumn)} = ?`)
      .all(targetId) as Record<string, unknown>[];
    for (const r of inlineRows) {
      sourceRows.push({ row: r, typeName: qualifiedTypeName(sourceType) });
    }
  }
  return sourceRows;
};

// Resolve a backlink subquery embedded in a computed shape element.
// Recognises two AST shapes:
//   1. `select_expr → shape_projection → for_expr → backlink_path` —
//      `target.<linkName[IS Source] { shape }`. Returns the projected rows.
//   2. `select_expr → exists → select_expr_subquery → compare(field_access(
//      for_expr(backlink_path), field), op, literal)` — the form EdgeQL
//      emits for `EXISTS (target.<linkName[IS Source].field = 'value')`.
//      Returns true if any source row's field compares true against the
//      literal. (This is what `owned_by_alice := EXISTS(...)` parses to.)
// Returns undefined when the expression doesn't match either pattern.
const tryEvaluateBacklinkShapeExpr = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: FreeObjectExpr,
  row: Record<string, unknown>,
): unknown | undefined => {
  // Peel the wrappers down to the for_expr we recognise.
  let cursor: FreeObjectExpr = expr;
  let projectedShape: ShapeElement[] | undefined;
  // `shapeEl.expr` can be a ComputedExpr's `select_expr` wrapper at runtime
  // (the static type FreeObjectExpr doesn't include it); peel it through.
  if ((cursor as { kind: string }).kind === "select_expr") {
    cursor = (cursor as unknown as { expr: FreeObjectExpr }).expr;
  }

  // EXISTS over a backlink-derived set. EdgeQL's `EXISTS X` is the
  // cardinality test |X| > 0. When X is `Card.<deck[IS User].name = 'Alice'`,
  // the set's cardinality equals the backlink set's cardinality (one
  // comparison result per source row, assuming the projected field is
  // non-null), so EXISTS reduces to "does any source row link back to this
  // target". Matches the form `select_expr → exists → select_expr_subquery
  // → compare(field_access(for_expr(backlink_path), field), op, literal)`.
  if (cursor.kind === "exists") {
    const targetId = row.id;
    if (typeof targetId !== "string") return false;
    let inner: FreeObjectExpr = cursor.expr;
    if (inner.kind === "select_expr_subquery") inner = inner.expr;
    if (inner.kind !== "compare") return undefined;
    const lhs = inner.left;
    if (lhs.kind !== "field_access") return undefined;
    const fieldExpr = lhs.expr;
    if (fieldExpr.kind !== "for_expr") return undefined;
    const backlinkBody = fieldExpr.body;
    if (!backlinkBody || backlinkBody.kind !== "backlink_path") return undefined;
    const sourceRows = collectBacklinkSourceRows(db, schema, backlinkBody, targetId);
    // A source row contributes a non-empty comparison iff its projected
    // field value is non-null; null operands in EdgeQL `=` evaluate to the
    // empty set rather than a boolean, so they don't increase cardinality.
    return sourceRows.some((entry) => entry.row[lhs.field] !== null && entry.row[lhs.field] !== undefined);
  }

  if (cursor.kind === "shape_projection") {
    projectedShape = cursor.shape;
    cursor = cursor.expr;
  }
  if (cursor.kind !== "for_expr") {
    return undefined;
  }
  const body = cursor.body;
  if (!body || body.kind !== "backlink_path") {
    return undefined;
  }
  const sourceTypeHint = body.sourceType;
  if (!sourceTypeHint) {
    return undefined;
  }
  const targetId = row.id;
  if (typeof targetId !== "string") {
    return [];
  }

  const sourceTypeQualified = sourceTypeHint.includes("::") ? sourceTypeHint : `default::${sourceTypeHint}`;
  const sourceTypeDef = schema.getType(sourceTypeQualified);
  if (!sourceTypeDef) {
    return [];
  }

  const sourceRows = collectBacklinkSourceRows(db, schema, body, targetId);

  if (projectedShape === undefined || projectedShape.length === 0) {
    // No projected shape — return the raw rows.
    return sourceRows.map((entry) => entry.row);
  }

  // Apply the projected shape to each found source row. Field references read
  // from the row directly; computed shape elements recurse through this
  // evaluator so nested computeds (`name_upper := str_upper(.name)`) work.
  const projected = sourceRows.map((entry) => {
    const out: Record<string, unknown> = {};
    for (const shapeEl of projectedShape!) {
      if (shapeEl.kind === "field") {
        out[shapeEl.name] = entry.row[shapeEl.name] ?? null;
        continue;
      }
      if (shapeEl.kind === "computed") {
        const value = evaluateSelectExprShapeEntry(db, schema, shapeEl.expr as unknown as FreeObjectExpr, entry.row, entry.typeName);
        out[shapeEl.name] = value;
        continue;
      }
      if (shapeEl.kind === "link" || shapeEl.kind === "backlink") {
        // Nested link/backlink projections inside the inner shape — beyond
        // the scope of this helper; leave them undefined for now.
        out[shapeEl.name] = null;
      }
    }
    return out;
  });
  return projected;
};

const evaluateSelectExprShapeEntry = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: FreeObjectExpr,
  row: Record<string, unknown>,
  sourceType: string,
): unknown => {
  const resolveCurrentField = (field: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      return materializeFieldValue(schema, sourceType, field, row[field]);
    }

    if (typeof row.id !== "string") {
      return undefined;
    }

    const sourceRow = readRowById(db, tableNameForType(sourceType), row.id) ?? row;
    if (findFieldDef(schema, sourceType, field)) {
      return materializeFieldValue(schema, sourceType, field, sourceRow[field]);
    }

    const resolvedLink = findRuntimeLinkDef(schema, sourceType, field);
    if (!resolvedLink) {
      return undefined;
    }

    const linkDef = resolvedLink.link;
    const loadTargetById = (targetId: unknown): Record<string, unknown> | null => {
      if (typeof targetId !== "string") {
        return null;
      }
      const targetType = db
        .prepare(`SELECT ${quoteIdent("type_name")} AS ${quoteIdent("type_name")} FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = ?`)
        .all(targetId)[0] as { type_name?: unknown } | undefined;
      const fallbackTarget = normalizeLinkTargetNames(linkDef.targetType, schema.getType(sourceType)?.module ?? "default")[0];
      const targetTypeName = typeof targetType?.type_name === "string"
        ? resolveRuntimeStoredTypeName(schema, targetType.type_name)
        : fallbackTarget;
      if (!targetTypeName) {
        return null;
      }
      const loaded = readRowById(db, tableNameForType(targetTypeName), targetId);
      return loaded ? { ...loaded, __source_type: targetTypeName } : null;
    };

    if (linkDef.multi || (linkDef.properties?.length ?? 0) > 0) {
      const owner = resolveLinkStorageOwner(schema, schema.getType(sourceType) ?? { module: sourceType.split("::").slice(0, -1).join("::"), name: sourceType.split("::").at(-1) ?? sourceType, fields: [] }, linkDef);
      const linkTable = `${tableNameForType(qualifiedTypeName(owner))}__${linkDef.name.toLowerCase()}`;
      const linkRows = db.prepare(`SELECT ${quoteIdent("target")} FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).all(row.id) as Array<{ target?: unknown }>;
      return linkRows.map((linkRow) => loadTargetById(linkRow.target)).filter((target): target is Record<string, unknown> => target !== null);
    }

    return loadTargetById(sourceRow[`${linkDef.name}_id`]);
  };

  // Computed shape elements whose expression is a backlink subquery
  // (`winner := Award.<awards[IS User] { name }`) parse as
  // select_expr → shape_projection → for_expr → backlink_path. The general
  // free-expr evaluator can't follow inbound paths, so we resolve them here:
  // for the current row, find source rows where the named link points at
  // row.id, then apply the projected shape to each.
  const backlinkResult = tryEvaluateBacklinkShapeExpr(db, schema, expr, row);
  if (backlinkResult !== undefined) {
    return backlinkResult;
  }

  // First try the general free-expression evaluator. If it returns undefined,
  // we don't know how to evaluate this; fall back to the legacy
  // path-steps/type-intersection handler below.
  const general = evaluateFreeExprForShape(expr, row, resolveCurrentField, (functionName, args) =>
    executeFunctionCall(schema, db, DEFAULT_SECURITY_CONTEXT, functionName, args));
  if (general !== undefined) {
    if (general === SHAPE_EMPTY_SET) return null;
    return general;
  }
  if (expr.kind !== "path_steps" || !expr.partial) return null;
  const steps = expr.steps;
  const head = steps[0];
  if (!head || head.kind !== "type_intersection") return null;

  const typeExpr = head.typeExpr ?? (head.typeName ? { kind: "type_name" as const, name: head.typeName } : undefined);
  if (!typeExpr) return null;

  const concreteMatches = (typeName: string, t: TypeExpr): boolean => {
    if (t.kind === "type_name") {
      const qualified = t.name.includes("::") ? t.name : `default::${t.name}`;
      if (qualified === "default::Object" || qualified === "std::Object") return true;
      return schema
        .listConcreteTypesAssignableTo(qualified)
        .some((candidate) => qualifiedTypeName(candidate) === typeName);
    }
    if (t.kind === "type_union") {
      return concreteMatches(typeName, t.left) || concreteMatches(typeName, t.right);
    }
    return concreteMatches(typeName, t.left) && concreteMatches(typeName, t.right);
  };

  if (!concreteMatches(sourceType, typeExpr)) return null;

  let current: unknown = row;
  for (let i = 1; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.kind !== "ptr") return null;
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    const currentRow = current as Record<string, unknown>;
    // Inline single links are stored as `<name>_id` columns; properties keep
    // their bare name. Try both so this works for either.
    const raw = currentRow[step.name] ?? currentRow[`${step.name}_id`];
    if (raw === undefined || raw === null) return null;

    if (i === steps.length - 1) {
      return raw;
    }

    if (typeof raw !== "string") return null;
    const globalType = db
      .prepare(`SELECT ${quoteIdent("type_name")} AS ${quoteIdent("type_name")} FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = ?`)
      .all(raw)[0] as { type_name?: unknown } | undefined;
    if (!globalType || typeof globalType.type_name !== "string") return null;
    const currentTypeName = resolveRuntimeStoredTypeName(schema, globalType.type_name);
    const table = currentTypeName.replaceAll("::", "__").toLowerCase();
    const next = db.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} = ?`).all(raw)[0] as Record<string, unknown> | undefined;
    if (!next) return null;
    current = next;
  }

  return current;
};

const freeExprHasCollectionDerivation = (expr: FreeObjectExpr): boolean => {
  if (expr.kind === "array_literal_expr" || expr.kind === "tuple" || expr.kind === "index_access" || expr.kind === "slice_access" || expr.kind === "function_call") return true;
  if (expr.kind === "field_access" || expr.kind === "select_expr_subquery" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "exists" || expr.kind === "not" || expr.kind === "unary" || expr.kind === "shape_projection") return freeExprHasCollectionDerivation(expr.expr);
  if (expr.kind === "set_expr") return expr.values.some(freeExprHasCollectionDerivation);
  if (expr.kind === "compare" || expr.kind === "in_expr" || expr.kind === "math" || expr.kind === "logical" || expr.kind === "and" || expr.kind === "or" || expr.kind === "coalesce") return freeExprHasCollectionDerivation(expr.left) || freeExprHasCollectionDerivation(expr.right);
  if (expr.kind === "if_else") return freeExprHasCollectionDerivation(expr.condition) || freeExprHasCollectionDerivation(expr.thenExpr) || freeExprHasCollectionDerivation(expr.elseExpr);
  if (expr.kind === "concat") return expr.parts.some(freeExprHasCollectionDerivation);
  return false;
};

const materializeSelectRow = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  context: SecurityContext,
  shape: SelectShapeElementIR[],
  row: Record<string, unknown>,
  sourceType: string,
  sqlTrail: SQLArtifact[],
): Record<string, unknown> => {
  const output: Record<string, unknown> = {};

  for (const element of shape) {
    if (element.kind === "field") {
      output[element.name] = materializeFieldValue(schema, sourceType, element.column, row[element.column]);
      continue;
    }

    if (element.kind === "computed") {
      if (element.expr.kind === "field_ref") {
        output[element.name] = materializeFieldValue(schema, sourceType, element.expr.column, row[element.expr.column]);
      } else if (element.expr.kind === "literal") {
        output[element.name] = element.expr.value;
      } else if (element.expr.kind === "set_literal") {
        // EdgeQL exposes an empty set in a single-cardinality computed shape
        // slot as `null`, not as an empty array. The IR doesn't carry
        // cardinality here so we use the simpler heuristic: empty → null.
        output[element.name] = element.expr.values.length === 0 ? null : [...element.expr.values];
      } else if (element.expr.kind === "polymorphic_field_ref") {
        const concretes = element.expr.concreteSourceTypes && element.expr.concreteSourceTypes.length > 0
          ? element.expr.concreteSourceTypes
          : [element.expr.sourceType];
        output[element.name] = concretes.includes(sourceType)
          ? materializeFieldValue(schema, sourceType, element.expr.column, row[element.expr.column])
          : null;
      } else if (element.expr.kind === "type_name") {
        output[element.name] = sourceType;
      } else if (element.expr.kind === "is_type") {
        output[element.name] = element.expr.concreteSourceTypes.includes(sourceType);
      } else if (element.expr.kind === "subquery") {
        // When the SQL compiler has folded this shape entry into the outer
        // SELECT (via `compileShapeSubquerySQL`), the row already carries the
        // materialised value — read it instead of firing a per-row query.
        const loweredAlias = computedValueAlias(element.pathId);
        if (Object.prototype.hasOwnProperty.call(row, loweredAlias)) {
          const raw = row[loweredAlias];
          if (raw === null || raw === undefined) {
            output[element.name] = null;
          } else if (typeof raw === "string"
            && (raw === "true" || raw === "false" || raw === "null"
              || raw.startsWith("[") || raw.startsWith("{"))) {
            try {
              output[element.name] = JSON.parse(raw);
            } catch {
              output[element.name] = raw;
            }
          } else {
            output[element.name] = raw;
          }
          continue;
        }
        const nestedSql = compileToSQL(element.expr.query, { target: resolvedRuntimeTarget(context, db) });
        assertTargetSqlCompatibility(nestedSql.sql, resolvedRuntimeTarget(context, db));
        sqlTrail.push(nestedSql);
        output[element.name] = runSelectIR(db, schema, element.expr.query, context, nestedSql, sqlTrail);
      } else if (element.expr.kind === "concat") {
        output[element.name] = element.expr.parts
          .map((part) => (part.kind === "field_ref" ? row[part.column] : part.value))
          .map((value) => (value === null || value === undefined ? "" : String(value)))
          .join("");
      } else if (element.expr.kind === "function_call") {
        const loweredAlias = computedValueAlias(element.pathId);
        if (Object.prototype.hasOwnProperty.call(row, loweredAlias)) {
          output[element.name] = row[loweredAlias];
          continue;
        }
        throw new AppError(
          "E_UNSUPPORTED",
          `function_call '${element.expr.functionName}' in shape requires SQL lowering; runtime fallback disabled`,
          1,
          1,
        );
      } else if (element.expr.kind === "link_aggregate") {
        // The aggregate is folded into the outer SELECT by sql/compiler's
        // compileLinkAggregateExpr — the row always carries the lowered value.
        output[element.name] = row[computedValueAlias(element.pathId)];
      } else if (element.expr.kind === "field_suffix_math") {
        const raw = row[element.expr.field];
        const asText = raw === null || raw === undefined ? "" : String(raw);
        const index = asText.length - element.expr.fromEnd;
        const digit = index >= 0 ? Number(asText[index]) : Number.NaN;
        if (!Number.isFinite(digit)) {
          output[element.name] = null;
        } else if (element.expr.op === "negate") {
          output[element.name] = -digit;
        } else {
          output[element.name] = (element.expr.constant ?? 0) - digit;
        }
      } else if (element.expr.kind === "select_expr") {
        const loweredAlias = computedValueAlias(element.pathId);
        if (Object.prototype.hasOwnProperty.call(row, loweredAlias)) {
          const raw = row[loweredAlias];
          if (raw === null || raw === undefined) {
            output[element.name] = null;
          } else if (typeof raw === "string"
            && (raw === "true" || raw === "false" || raw === "null"
              || raw.startsWith("[") || raw.startsWith("{"))) {
            try {
              output[element.name] = JSON.parse(raw);
            } catch {
              output[element.name] = raw;
            }
          } else {
            output[element.name] = raw;
          }
          continue;
        }
        throw new AppError(
          "E_UNSUPPORTED",
          `select_expr computed shape '${element.name}' requires SQL lowering; runtime fallback disabled`,
          1,
          1,
        );
      } else {
        output[element.name] = { name: sourceType };
      }
      continue;
    }

    if (element.kind === "link") {
      // Effective cardinality on this shape entry: the link's declared multi
      // flag *plus* any narrowing introduced by an inner FILTER on an
      // exclusive property (e.g. `watchers: { … } FILTER .name = 'Yury'`).
      // Cardinality inference at IR-build time records the result on
      // `inference.cardinality` — when it's "one" / "at_most_one" / "empty"
      // we unwrap the JSON array to a single object (or null) so callers
      // see a scalar, not a one-element list.
      const inferredAtMostOne = element.inference?.cardinality === "one"
        || element.inference?.cardinality === "at_most_one"
        || element.inference?.cardinality === "empty";
      const treatAsMulti = element.relation.multi && !inferredAtMostOne;
      if (element.sourceTypeFilter && element.sourceTypeFilter !== sourceType) {
        output[element.name] = treatAsMulti ? [] : null;
        continue;
      }

      // sql/compiler unconditionally emits link payloads via
      // compileLinkArrayExpr, so the JSON-aggregated set is always present
      // on the row.
      const payload = parsePayloadArray(row[shapePayloadAlias(element.pathId)]) ?? [];
      output[element.name] = treatAsMulti ? payload : (payload[0] ?? null);
      continue;
    }

    // A backlink whose `multi` is explicitly `false` is at-most-one — unwrap
    // the result array (zero rows → null, one row → the object). Default
    // (undefined) preserves the existing multi semantics for callers that
    // haven't been updated to set the flag.
    const isSingleBacklink = element.multi === false;
    const unwrapSingle = (rows: unknown[]): unknown => rows.length === 0 ? null : rows[0];

    // sql/compiler's compileBacklinkArrayExpr emits json_group_array(json_object(…))
    // with the full nested shape already materialised, so the payload is
    // always present and fully shaped on the row.
    const payload = parsePayloadArray(row[shapePayloadAlias(element.pathId)]) ?? [];
    output[element.name] = isSingleBacklink ? unwrapSingle(payload) : payload;
  }

  return output;
};

const materializeFieldValue = (
  schema: SchemaSnapshot,
  sourceType: string,
  fieldName: string,
  value: unknown,
): unknown => {
  const field = findFieldDef(schema, sourceType, fieldName);
  if (!field) {
    return value;
  }

      if (field.multi) {
    if (value === null || value === undefined) {
      return [];
    }
    if (typeof value !== "string") {
      return [];
    }

    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((item) => coerceScalarForOutput(field.type, item)).sort((a, b) => String(a).localeCompare(String(b)));
    } catch {
      return [];
    }
  }

  if (field.collection && typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (field.collection.kind === "array") {
          return Array.isArray(parsed) ? parsed : [];
        }

        if (field.collection.kind === "tuple") {
          if (Array.isArray(parsed) && field.collection.elementNames && field.collection.elementNames.length === parsed.length) {
            return Object.fromEntries(field.collection.elementNames.map((name, idx) => [name, parsed[idx]]));
          }
          return parsed;
        }
      } catch {
        return value;
      }
    }
  }

  return coerceScalarForOutput(field.type, value);
};

const evaluateComputedLinkPropertyExpr = (
  expr: ComputedLinkPropertyExpr,
  targetRow: Record<string, unknown>,
  linkProperties: Record<string, unknown>,
): unknown => {
  if (expr.kind === "literal") {
    return expr.value;
  }

  if (expr.kind === "field_ref") {
    return targetRow[expr.name] ?? null;
  }

  if (expr.kind === "link_property_ref") {
    return linkProperties[`@${expr.name}`] ?? linkProperties[expr.name] ?? null;
  }

  const left = evaluateComputedLinkPropertyExpr(expr.left, targetRow, linkProperties);
  if (expr.op === "??") {
    return left ?? evaluateComputedLinkPropertyExpr(expr.right, targetRow, linkProperties);
  }

  const right = evaluateComputedLinkPropertyExpr(expr.right, targetRow, linkProperties);
  if (expr.op === "++") {
    return `${left ?? ""}${right ?? ""}`;
  }
  if (expr.op === "+") {
    return Number(left) + Number(right);
  }
  if (expr.op === "-") {
    return Number(left) - Number(right);
  }
  if (expr.op === "*") {
    return Number(left) * Number(right);
  }
  return Number(left) / Number(right);
};

const findFieldDef = (
  schema: SchemaSnapshot,
  typeName: string,
  fieldName: string,
  seen = new Set<string>(),
): TypeDef["fields"][number] | undefined => {
  if (seen.has(typeName)) {
    return undefined;
  }
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) {
    return undefined;
  }

  const direct = typeDef.fields.find((field) => field.name === fieldName);
  if (direct) {
    return direct;
  }

  for (const baseName of typeDef.extends ?? []) {
    const inherited = findFieldDef(schema, baseName, fieldName, seen);
    if (inherited) {
      return inherited;
    }
  }

  return undefined;
};

const linkDefsEquivalent = (a: NonNullable<TypeDef["links"]>[number], b: NonNullable<TypeDef["links"]>[number]): boolean => {
  if (a.name !== b.name) {
    return false;
  }
  if ((a.targetType ?? "") !== (b.targetType ?? "")) {
    return false;
  }
  if (Boolean(a.multi) !== Boolean(b.multi)) {
    return false;
  }

  const aProps = a.properties ?? [];
  const bProps = b.properties ?? [];
  if (aProps.length !== bProps.length) {
    return false;
  }
  for (let i = 0; i < aProps.length; i += 1) {
    const ap = aProps[i];
    const bp = bProps[i];
    if (!bp || ap.name !== bp.name || ap.type !== bp.type) {
      return false;
    }
  }

  return true;
};

const resolveLinkStorageOwner = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  link: NonNullable<TypeDef["links"]>[number],
): TypeDef => {
  if (link.overloaded) {
    return typeDef;
  }

  let owner = typeDef;
  let current = typeDef;

  while ((current.extends ?? []).length > 0) {
    const nextBaseName = current.extends?.[0];
    if (!nextBaseName) {
      break;
    }

    const baseType = schema.getType(nextBaseName);
    if (!baseType) {
      break;
    }

    const baseLink = (baseType.links ?? []).find((candidate) => candidate.name === link.name);
    if (!baseLink || baseLink.overloaded || !linkDefsEquivalent(link, baseLink)) {
      break;
    }

    owner = baseType;
    current = baseType;
  }

  return owner;
};

const coerceScalarForOutput = (type: ScalarType, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }

  if (type === "json" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  if (type === "bool") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      if (value === "1" || value.toLowerCase() === "true") {
        return true;
      }
      if (value === "0" || value.toLowerCase() === "false") {
        return false;
      }
    }
  }

  return value;
};

const runSelectIR = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: SelectIR,
  context: SecurityContext,
  sqlArtifact: SQLArtifact,
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  const subjectType = schema.getType(ir.sourceType);
  const isUniversalRoot = ir.sourceType === "std::Object" || ir.sourceType === "default::Object";
  if (!subjectType && !isUniversalRoot) {
    throw new AppError("E_SEMANTIC", `Unknown type '${ir.sourceType}'`, 1, 1);
  }

  const stmt = db.prepare(sqlArtifact.sql);
  const rows = stmt.all(...sqlArtifact.params);
  // Access policies are evaluated on the already-returned rows. Every column
  // the policy conditions read is projected by sql/compiler (see
  // selectedColumns wiring in semantic.ts), so this is a pure in-memory
  // filter — no per-row SQL fires.
  const visibleRows = subjectType
    ? rows.filter((row) => evaluateSelectPolicies(schema, db, subjectType, row, context))
    : rows;
  return visibleRows.map((row) => materializeSelectRow(db, schema, context, ir.shape, row, rowSourceType(row, ir.sourceType), sqlTrail));
};

const runSelectFreeSQL = (
  db: SQLiteDatabase,
  sqlArtifact: SQLArtifact,
): Record<string, unknown>[] => db.prepare(sqlArtifact.sql).all(...sqlArtifact.params) as Record<string, unknown>[];

const runGroupIR = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: GroupIR,
  context: SecurityContext,
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  // HACK (not using SQL): GROUP source rows are gathered by trying
  // tryRuntimeSelectExprEvaluationAst → tryEvaluateParsedRuntimeSelect →
  // compile+runSelectIR/runGelSelectExprSQL, then grouped in TS below.
  // GROUP should be a first-class IR/SQL operation.
  let rows: Record<string, unknown>[] = [];
  const tryExpr = ir.source.kind === "select_expr"
    ? tryRuntimeSelectExprEvaluationAst(db, schema, ir.source, context)
    : undefined;
  if (tryExpr && tryExpr.kind === "select" && tryExpr.rows) {
    rows = tryExpr.rows as Record<string, unknown>[];
  } else {
    const tryParsed = ir.source.kind === "select"
      ? tryEvaluateParsedRuntimeSelect(db, schema, ir.source, context)
      : undefined;
    if (tryParsed && tryParsed.kind === "select" && tryParsed.rows) {
      rows = tryParsed.rows as Record<string, unknown>[];
    } else {
      try {
        const sourceCompiled = getCompilerService().compile(schema, ir.source, {
          globals: context.globals,
          target: resolvedRuntimeTarget(context, db),
        });
        if (sourceCompiled.ir.kind === "select") {
          sqlTrail.push(sourceCompiled.sql);
          rows = runSelectIR(db, schema, sourceCompiled.ir, context, sourceCompiled.sql, sqlTrail);
        } else if (sourceCompiled.ir.kind === "select_expr") {
          sqlTrail.push(sourceCompiled.sql);
          const exprRows = runGelSelectExprSQL(db, sourceCompiled.sql);
          rows = exprRows.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
        }
      } catch {
        // Source couldn't be lowered — leave rows empty so the caller surfaces
        // an empty group result instead of a hard error.
      }
    }
  }

  const hidden = new Set(ir.hiddenByFields);

  const stripElement = (row: Record<string, unknown>): Record<string, unknown> => {
    const element: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(row)) {
      if (hidden.has(name)) continue;
      element[name] = value;
    }
    return element;
  };

  // Each grouping set produces its own set of partitions; we concatenate the
  // result rows from all sets. A row in a partition for set `{a}` has its
  // other key fields (e.g. `b`) set to NULL, and `grouping: ["a"]`.
  let groupRows: Record<string, unknown>[] = [];
  for (const set of ir.groupingSets) {
    const partitions = new Map<string, { key: Record<string, unknown>; elements: Record<string, unknown>[] }>();
    for (const row of rows) {
      const key: Record<string, unknown> = {};
      for (const atom of ir.byAtoms) {
        key[atom] = set.includes(atom) ? (row[atom] ?? null) : null;
      }
      const keyStr = JSON.stringify(key);
      let bucket = partitions.get(keyStr);
      if (!bucket) {
        bucket = { key, elements: [] };
        partitions.set(keyStr, bucket);
      }
      bucket.elements.push(stripElement(row));
    }
    for (const bucket of partitions.values()) {
      groupRows.push({
        key: bucket.key,
        elements: bucket.elements,
        grouping: [...set],
      });
    }
  }

  // Shape projection runs first: filter / order / limit on `SELECT (GROUP …) { shape }`
  // reference the projected field names, not the raw `{key, elements}` row.
  if (ir.postShape) {
    groupRows = groupRows.map((row) => {
      const projected: Record<string, unknown> = {};
      for (const element of ir.postShape!) {
        if (element.kind === "field") {
          projected[element.name] = row[element.name] ?? null;
          continue;
        }
        if (element.kind === "computed") {
          projected[element.name] = evalGroupRowComputed(element.expr, row);
          continue;
        }
      }
      return projected;
    });
  }

  if (ir.postFilter) {
    groupRows = groupRows.filter((row) => Boolean(evalGroupRowExpr(ir.postFilter!, row)));
  }

  if (ir.postOrderBy) {
    const orderBy = ir.postOrderBy;
    groupRows = [...groupRows].sort((a, b) => compareByOrderChain(a, b, orderBy));
  }

  if (typeof ir.postOffset === "number") {
    groupRows = groupRows.slice(ir.postOffset);
  }
  if (typeof ir.postLimit === "number") {
    groupRows = groupRows.slice(0, ir.postLimit);
  }

  return groupRows;
};

const evalGroupRowExpr = (
  expr: FreeObjectExpr,
  row: Record<string, unknown>,
  bindings?: ReadonlyMap<string, unknown>,
): unknown => {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "current_item":
      return row;
    case "binding_ref": {
      if (bindings && bindings.has(expr.name)) {
        return bindings.get(expr.name);
      }
      return null;
    }
    case "path": {
      const head = bindings?.get(expr.head);
      if (head == null || typeof head !== "object") {
        return null;
      }
      return (head as Record<string, unknown>)[expr.tail] ?? null;
    }
    case "path_chain": {
      let current: unknown = bindings?.get(expr.parts[0]!);
      for (let i = 1; i < expr.parts.length; i += 1) {
        if (current == null || typeof current !== "object") {
          return null;
        }
        current = (current as Record<string, unknown>)[expr.parts[i]!] ?? null;
      }
      return current;
    }
    case "field_access": {
      const target = evalGroupRowExpr(expr.expr, row, bindings);
      if (target == null || typeof target !== "object") {
        return null;
      }
      return (target as Record<string, unknown>)[expr.field] ?? null;
    }
    case "select_expr_subquery":
    case "distinct":
      return evalGroupRowExpr(expr.expr, row, bindings);
    case "shape_projection": {
      const base = evalGroupRowExpr(expr.expr, row, bindings);
      if (Array.isArray(base)) {
        return base.map((item) => projectShape(item, expr.shape, bindings));
      }
      if (base == null || typeof base !== "object") {
        return null;
      }
      return projectShape(base, expr.shape, bindings);
    }
    case "free_object_constructor": {
      const out: Record<string, unknown> = {};
      for (const entry of expr.entries) {
        out[entry.name] = evalGroupRowExpr(entry.expr, row, bindings);
      }
      return out;
    }
    case "compare":
    case "logical": {
      const left = evalGroupRowExpr(expr.left, row, bindings);
      const right = evalGroupRowExpr(expr.right, row, bindings);
      return applyComparisonOp(expr.op, left, right);
    }
    case "unary": {
      const inner = evalGroupRowExpr(expr.expr, row, bindings);
      if (expr.op === "not") return !inner;
      if (expr.op === "neg") return -Number(inner);
      return null;
    }
    case "math": {
      const left = Number(evalGroupRowExpr(expr.left, row, bindings) ?? 0);
      const right = Number(evalGroupRowExpr(expr.right, row, bindings) ?? 0);
      switch (expr.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return right === 0 ? null : normalizeRuntimeFloat(left / right);
        case "%": return right === 0 ? null : left % right;
        default: return null;
      }
    }
    case "function_call":
      return evalGroupRowFunctionCall(expr.call, row, bindings);
    case "cast": {
      const value = evalGroupRowExpr(expr.expr, row, bindings);
      return value;
    }
    case "if_else": {
      const cond = evalGroupRowExpr(expr.condition, row, bindings);
      return cond
        ? evalGroupRowExpr(expr.thenExpr, row, bindings)
        : evalGroupRowExpr(expr.elseExpr, row, bindings);
    }
    case "tuple":
      return expr.values.map((value) => evalGroupRowExpr(value, row, bindings));
    default:
      return null;
  }
};

const projectShape = (
  base: unknown,
  shape: ShapeElement[],
  bindings?: ReadonlyMap<string, unknown>,
): unknown => {
  if (base == null || typeof base !== "object" || Array.isArray(base)) {
    return null;
  }
  const baseRow = base as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const element of shape) {
    if (element.kind === "field") {
      projected[element.name] = baseRow[element.name] ?? null;
      continue;
    }
    if (element.kind === "computed") {
      projected[element.name] = evalGroupRowComputed(element.expr, baseRow, bindings);
      continue;
    }
    if (element.kind === "link" || element.kind === "backlink") {
      const linkValue = baseRow[element.name];
      const linkShape = element.shape;
      if (!linkShape) {
        projected[element.name] = linkValue ?? null;
        continue;
      }
      if (Array.isArray(linkValue)) {
        projected[element.name] = linkValue.map((item) => projectShape(item, linkShape, bindings));
      } else if (linkValue && typeof linkValue === "object") {
        projected[element.name] = projectShape(linkValue, linkShape, bindings);
      } else {
        projected[element.name] = null;
      }
      continue;
    }
  }
  return projected;
};

const evalGroupRowComputed = (
  expr: ComputedExpr | BacklinkExpr,
  row: Record<string, unknown>,
  bindings?: ReadonlyMap<string, unknown>,
): unknown => {
  if (!("kind" in expr)) {
    return null;
  }
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "field_ref":
      return row[expr.field] ?? null;
    case "select_expr":
      return evalGroupRowExpr(expr.expr, row, bindings);
    case "function_call":
      return evalGroupRowFunctionCall(expr.call, row, bindings);
    case "binding_ref":
      return bindings?.get(expr.name) ?? null;
    default:
      return null;
  }
};

const evalGroupRowFunctionCall = (
  call: FunctionCallExpr,
  row: Record<string, unknown>,
  bindings?: ReadonlyMap<string, unknown>,
): unknown => {
  const args = call.args.map((arg) => {
    if (arg.kind === "expr") {
      return evalGroupRowExpr(arg.expr, row, bindings);
    }
    if (arg.kind === "literal") {
      return arg.value;
    }
    return null;
  });

  const name = call.name.split("::").pop()!;

  if (name === "count") {
    const value = args[0];
    if (Array.isArray(value)) return value.length;
    if (value == null) return 0;
    return 1;
  }
  if (name === "sum") {
    const rawArg = args[0];
    if (typeof rawArg === "string") {
      throw new AppError("E_SEMANTIC", `function "sum(arg0: std::str)" does not exist`, 1, 1);
    }
    if (Array.isArray(rawArg) && rawArg.some((v) => typeof v === "string")) {
      throw new AppError("E_SEMANTIC", `function "sum(arg0: std::str)" does not exist`, 1, 1);
    }
    const list = asNumericList(rawArg);
    return list.reduce((acc, v) => acc + v, 0);
  }
  if (name === "min") {
    const list = asNumericList(args[0]);
    return list.length === 0 ? null : Math.min(...list);
  }
  if (name === "max") {
    const list = asNumericList(args[0]);
    return list.length === 0 ? null : Math.max(...list);
  }
  if (name === "mean" || name === "avg") {
    const list = asNumericList(args[0]);
    return list.length === 0 ? null : list.reduce((a, v) => a + v, 0) / list.length;
  }
  if (name === "array_agg") {
    const value = args[0];
    if (Array.isArray(value)) return [...value];
    return value == null ? [] : [value];
  }
  if (name === "str_lower") return typeof args[0] === "string" ? args[0].toLowerCase() : null;
  if (name === "str_upper") return typeof args[0] === "string" ? args[0].toUpperCase() : null;
  if (name === "len") {
    if (typeof args[0] === "string") return args[0].length;
    if (Array.isArray(args[0])) return args[0].length;
    return 0;
  }
  return null;
};

const asNumericList = (value: unknown): number[] => {
  if (Array.isArray(value)) {
    return value.filter((v) => v != null).map((v) => Number(v));
  }
  if (value == null) return [];
  return [Number(value)];
};

const applyComparisonOp = (op: string, left: unknown, right: unknown): unknown => {
  switch (op) {
    case "=": return canonicalCompareEqual(left, right);
    case "!=": return !canonicalCompareEqual(left, right);
    case "<": return Number(left) < Number(right);
    case ">": return Number(left) > Number(right);
    case "<=": return Number(left) <= Number(right);
    case ">=": return Number(left) >= Number(right);
    case "and": return Boolean(left) && Boolean(right);
    case "or": return Boolean(left) || Boolean(right);
    default: return null;
  }
};

const canonicalCompareEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left == null || right == null) return left == right;
  if (typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
};

const compareByOrderChain = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  chain: OrderExprChain,
): number => {
  const aValue = evalGroupRowExpr(chain.expr, a);
  const bValue = evalGroupRowExpr(chain.expr, b);
  let cmp = compareScalar(aValue, bValue);
  if (cmp === 0 && chain.then) {
    return compareByOrderChain(a, b, chain.then);
  }
  if (chain.direction === "desc") cmp = -cmp;
  return cmp;
};

const compareScalar = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const aStr = String(a);
  const bStr = String(b);
  if (aStr < bStr) return -1;
  if (aStr > bStr) return 1;
  return 0;
};

const materializeFreeObjectRow = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  entries: Extract<IRStatement, { kind: "select_free" }>["entries"],
  context: SecurityContext,
  sqlTrail: SQLArtifact[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};

  for (const entry of entries) {
    if (entry.kind === "literal") {
      out[entry.name] = entry.value;
      continue;
    }

    if (entry.kind === "set_literal") {
      out[entry.name] = [...entry.values];
      continue;
    }

    if (entry.kind === "function_call") {
      out[entry.name] = executeFunctionCall(
        schema,
        db,
        context,
        entry.functionName,
        entry.args.map((arg): RuntimeFunctionArg => {
          const resolveFreeFunctionArg = (value: typeof arg): RuntimeFunctionArg => {
            if (value.kind === "set_literal") {
              return { kind: "set" as const, values: [...value.values] };
            }
            if (value.kind === "array_literal") {
              return { kind: "array" as const, values: [...value.values] };
            }
            if (value.kind === "binding_ref") {
              return context.globals?.[value.name] ?? null;
            }
            if (value.kind === "function_call") {
              return executeFunctionCall(
                schema,
                db,
                context,
                value.functionName,
                value.args.map((nested) => resolveFreeFunctionArg(nested)),
              ) as RuntimeFunctionArg;
            }
            return value.value;
          };

          return resolveFreeFunctionArg(arg);
        }),
      );
      continue;
    }

    if (entry.kind === "select") {
      const nestedSql = compileToSQL(entry.query, { target: resolvedRuntimeTarget(context, db) });
      assertTargetSqlCompatibility(nestedSql.sql, resolvedRuntimeTarget(context, db));
      sqlTrail.push(nestedSql);
      out[entry.name] = runSelectIR(db, schema, entry.query, context, nestedSql, sqlTrail);
      continue;
    }
  }

  return out;
};

const runGelSelectExprSQL = (db: SQLiteDatabase, sqlArtifact: SQLArtifact): unknown[] => {
  const rows = db.prepare(sqlArtifact.sql).all(...sqlArtifact.params) as Record<string, unknown>[];
  return rows.map((row) => {
    // Scalar select: the SQL projects a single `value` column. Parse JSON-
    // shaped strings ("true"/"false"/"null"/"[…]"/"{…}") so the test layer
    // sees a structured value.
    if (Object.prototype.hasOwnProperty.call(row, "value")) {
      const value = row.value;
      if (typeof value !== "string") {
        return value ?? null;
      }
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    // Shape select: GEL-IR emits id, __source_type, plus shape columns. Drop
    // the engine-internal slots and return an object whose keys match the
    // requested shape. Parse any JSON-shaped string columns (link payloads
    // come back as json_group_array strings).
    const out: Record<string, unknown> = {};
    let hasShapeColumn = false;
    for (const key of Object.keys(row)) {
      if (key === "id" || key === "__source_type") continue;
      hasShapeColumn = true;
      const v = row[key];
      if (typeof v === "string"
        && (v === "true" || v === "false" || v === "null"
          || v.startsWith("[") || v.startsWith("{"))) {
        try {
          out[key] = JSON.parse(v);
        } catch {
          out[key] = v;
        }
      } else {
        out[key] = v;
      }
    }
    // No shape columns AND every internal slot is NULL ⇒ the GEL-IR fallback
    // `SELECT NULL AS id, NULL AS …` path. Surface as null in that case so
    // consumers see "no data" rather than an empty object. When the row has
    // a real id (object identity) but no shape columns yet, return `{}` —
    // some callers (free-object constructors, default-shape selects)
    // legitimately produce shapeless rows.
    if (!hasShapeColumn) {
      const allNull = Object.keys(row).every((k) => row[k] === null || row[k] === undefined);
      if (allNull) return null;
    }
    return out;
  });
};

const inferStaticArgType = (
  arg: FunctionCallArgExpr,
  schema: SchemaSnapshot,
  defaultModule: string,
  implicitType?: string,
): string | undefined => {
  const fromExpr = (expr: FreeObjectExpr | undefined): string | undefined => {
    if (!expr || typeof expr !== "object") return undefined;
    if (expr.kind === "cast") return expr.castType;
    if (expr.kind === "literal") {
      const v = expr.value;
      if (typeof v === "boolean") return "bool";
      if (typeof v === "number") return Number.isInteger(v) ? "int64" : "float64";
      if (typeof v === "string") return "str";
      return undefined;
    }
    if (expr.kind === "field_access") {
      // Walk down to the source select to learn the row type, then look up
      // the field's declared type in the schema. Also handle `.field` syntax
      // (current_item) by falling back to the caller-supplied implicit type.
      let inner: FreeObjectExpr = expr.expr;
      while (inner.kind === "field_access" || inner.kind === "cast"
        || inner.kind === "select_expr_subquery"
        || (inner as { kind: string }).kind === "select_expr") {
        inner = (inner as unknown as { expr: FreeObjectExpr }).expr;
      }
      let typeName: string | undefined;
      if (inner.kind === "select") {
        typeName = inner.typeName.includes("::") ? inner.typeName : `${defaultModule}::${inner.typeName}`;
      } else if (inner.kind === "current_item" && implicitType) {
        typeName = implicitType.includes("::") ? implicitType : `${defaultModule}::${implicitType}`;
      }
      if (!typeName) return undefined;
      const typeDef = schema.getType(typeName);
      if (!typeDef) return undefined;
      const field = typeDef.fields.find((f) => f.name === expr.field);
      return field?.type;
    }
    if (expr.kind === "select") {
      const typeName = expr.typeName.includes("::") ? expr.typeName : `${defaultModule}::${expr.typeName}`;
      return typeName;
    }
    return undefined;
  };
  if (arg.kind === "expr") return fromExpr(arg.expr);
  if (arg.kind === "literal") {
    if (typeof arg.value === "boolean") return "bool";
    if (typeof arg.value === "number") return Number.isInteger(arg.value) ? "int64" : "float64";
    if (typeof arg.value === "string") return "str";
  }
  return undefined;
};

const runtimeArgTypeName = (arg: RuntimeFunctionArg | undefined): string | "empty" | "unknown" => {
  if (arg === null || arg === undefined) return "empty";
  if (typeof arg === "object" && arg !== null && "kind" in arg) {
    if (arg.kind === "array") return "array";
    // A "set" arg with no values is an empty set (e.g. `<str>{}`); we treat
    // it as type-flexible so OPTIONAL overloads match.
    if (arg.values.length === 0) return "empty";
    return runtimeArgTypeName(arg.values[0] as RuntimeFunctionArg);
  }
  if (typeof arg === "boolean") return "bool";
  if (typeof arg === "number") return Number.isInteger(arg) ? "int64" : "float64";
  if (typeof arg === "string") return "str";
  return "unknown";
};

const paramAcceptsArgType = (paramType: string, argType: string | "empty" | "unknown"): number => {
  // Returns a score: -1 = no match, 0 = optional-empty (low), 1 = compatible,
  // 2 = exact-ish. Used to rank overloads when multiple share name + arity.
  if (argType === "empty") return 0;
  if (argType === "unknown") return 1;
  const normalize = (t: string): string => {
    const idx = t.lastIndexOf("::");
    let s = idx >= 0 ? t.slice(idx + 2) : t;
    // Collection types come parameterized (e.g. `array<int64>`) on params
    // but as bare kind ("array", "tuple") on runtime values — collapse.
    const collMatch = /^(array|tuple|set)\s*<.*>$/.exec(s);
    if (collMatch) s = collMatch[1];
    // FieldDef.type stores short scalar names ("int", "float"); function
    // params store EdgeQL canonical names ("int64", "float64"). Normalize
    // both to the long form so they compare equal.
    if (s === "int") return "int64";
    if (s === "int16" || s === "int32") return "int64";
    if (s === "float") return "float64";
    if (s === "float32") return "float64";
    return s;
  };
  const p = normalize(paramType);
  const a = normalize(argType);
  if (p === a) return 2;
  if (p === "float64" && a === "int64") return 1;
  if (p === "anytype" || p === "anyscalar") return 1;
  return -1;
};

const resolveUserFunctionOverload = (
  schema: SchemaSnapshot,
  moduleName: string,
  fnName: string,
  args: RuntimeFunctionArg[],
  staticTypes?: (string | undefined)[],
): FunctionDef | undefined => {
  let best: { fn: FunctionDef; score: number } | undefined;
  // Track the runtime-empty positions separately so a non-optional param
  // still disqualifies the variant — the static type is only used to break
  // ties between OPTIONAL overloads when the runtime value is empty.
  const runtimeTypes = args.map(runtimeArgTypeName);
  for (const fn of schema.listFunctions()) {
    if (fn.module !== moduleName || fn.name !== fnName) continue;
    const requiredCount = fn.params.filter((p) => !p.optional && p.default === undefined && !p.variadic).length;
    const accepts = args.length >= requiredCount
      && (fn.params.some((p) => p.variadic) || args.length <= fn.params.length);
    if (!accepts) continue;
    let score = 0;
    let viable = true;
    for (let i = 0; i < fn.params.length; i++) {
      const param = fn.params[i];
      const runtimeType = i < runtimeTypes.length ? runtimeTypes[i] : "empty";
      if (runtimeType === "empty" && !param.optional && param.default === undefined) {
        viable = false;
        break;
      }
      // For type-match scoring use the static type when runtime is empty —
      // both `optional int64` and `optional str` accept empty at runtime, so
      // we'd otherwise tie.
      const typeForScore = (runtimeType === "empty" || runtimeType === "unknown")
        ? (staticTypes?.[i] ?? runtimeType)
        : runtimeType;
      const paramScore = paramAcceptsArgType(param.type, typeForScore);
      if (paramScore < 0 && typeForScore !== "empty" && typeForScore !== "unknown") {
        viable = false;
        break;
      }
      score += Math.max(paramScore, 0);
    }
    if (!viable) continue;
    if (!best || score > best.score) {
      best = { fn, score };
    }
  }
  return best?.fn;
};

const executeFunctionCall = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  qualifiedName: string,
  args: RuntimeFunctionArg[],
  staticArgTypes?: (string | undefined)[],
): unknown => {
  // A bareword EdgeQL call (`range(1, 5)`) in a script whose default module
  // is `default` arrives here as `default::range`. The stdlib registry keys
  // by the canonical module (`std::`, `math::`, `cal::`), so a literal
  // lookup of `default::range` misses. Re-resolve under the stdlib modules
  // first when the qualified form doesn't exist there directly.
  let resolvedName = qualifiedName;
  let builtin = resolveStdlibFunction(qualifiedName, args.length);
  if (!builtin) {
    const shortName = qualifiedName.includes("::") ? qualifiedName.split("::").pop()! : qualifiedName;
    for (const prefix of ["std", "math", "cal"]) {
      const candidate = `${prefix}::${shortName}`;
      const hit = resolveStdlibFunction(candidate, args.length);
      if (hit) {
        builtin = hit;
        resolvedName = candidate;
        break;
      }
    }
  }
  if (builtin) {
    if (resolvedName === "std::count") {
      return countRuntimeSetCardinality(args[0]);
    }
    return executeStdlibFunction(resolvedName, args);
  }

  const divider = qualifiedName.lastIndexOf("::");
  const moduleName = divider >= 0 ? qualifiedName.slice(0, divider) : "default";
  const fnName = divider >= 0 ? qualifiedName.slice(divider + 2) : qualifiedName;
  const fn = resolveUserFunctionOverload(schema, moduleName, fnName, args, staticArgTypes);
  if (!fn) {
    // If the function exists under this name (any signature) but no overload
    // matches the given args, that's a short-circuit, not an error: a call
    // with an empty set for a NON-optional parameter produces an empty
    // result in EdgeQL (the call simply isn't made for that iteration).
    const anyByName = schema.listFunctions().some((f) => f.module === moduleName && f.name === fnName);
    if (anyByName) return null;
    throw new AppError("E_SEMANTIC", `Unknown function '${qualifiedName}'`, 1, 1);
  }

  const bindings = bindFunctionArgs(fn, args);
  if (fn.volatility === "Modifying") {
    for (const param of fn.params) {
      const value = bindings.get(param.name);
      if (value === undefined || value === null) {
        if (!param.optional) {
          throw new AppError(
            "E_SEMANTIC",
            "possibly an empty set passed as non-optional argument into modifying function",
            1,
            1,
          );
        }
        continue;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) {
          if (!param.optional) {
            throw new AppError(
                "E_SEMANTIC",
              "possibly an empty set passed as non-optional argument into modifying function",
              1,
              1,
            );
          }
          continue;
        }

        if (value.length === 1) {
          continue;
        }
        throw new AppError("E_SEMANTIC", "possibly more than one element passed into modifying function", 1, 1);
      }
    }
  }

  if (fn.body.kind === "expr") {
    return evaluateExprBody(fn, bindings);
  }

  const withPrefix = fn.params
    .map((param) => `${param.name} := ${literalToEdgeQL(bindings.get(param.name) ?? null)}`)
    .join(", ");
  const query = withPrefix.length > 0 ? `with ${withPrefix} ${fn.body.query}` : fn.body.query;
  const result = executeQuery(db, schema, query, context);
  if (result.rows) {
    if (!fn.returnSetOf) {
      if (result.rows.length === 0) {
        return null;
      }
      const firstRow = result.rows[0];
      if (result.rows.length === 1 && isRecordRow(firstRow) && Object.keys(firstRow).length === 1) {
        return Object.values(firstRow)[0];
      }
      if (result.rows.length === 1) {
        return firstRow ?? null;
      }
    }
    const firstRow = result.rows[0];
    if (result.rows.length === 1 && isRecordRow(firstRow) && Object.keys(firstRow).length === 1) {
      return Object.values(firstRow)[0];
    }
    return result.rows;
  }
  return result.changes ?? 0;
};

const bindFunctionArgs = (fn: FunctionDef, args: RuntimeFunctionArg[]): Map<string, ScalarValue | ScalarValue[] | null> => {
  const out = new Map<string, ScalarValue | ScalarValue[] | null>();
  let cursor = 0;
  for (const param of fn.params) {
    if (param.variadic) {
      const variadicValues: ScalarValue[] = [];
      while (cursor < args.length) {
        const next = args[cursor];
        cursor += 1;
        if (typeof next === "object" && next !== null && "kind" in next && next.kind === "array") {
          variadicValues.push(...next.values);
        } else if (typeof next === "object" && next !== null && "kind" in next && next.kind === "set") {
          variadicValues.push(...next.values);
        } else {
          variadicValues.push(next as ScalarValue);
        }
      }
      out.set(param.name, variadicValues);
      continue;
    }

    const raw = cursor < args.length ? args[cursor] : undefined;
    if (raw !== undefined) {
      cursor += 1;
    }

    if (raw === undefined) {
      if (param.default !== undefined) {
        out.set(param.name, param.default);
        continue;
      }
      if (param.optional) {
        out.set(param.name, null);
        continue;
      }
      throw new AppError("E_SEMANTIC", `Missing required function argument '${param.name}'`, 1, 1);
    }

    if (typeof raw === "object" && raw !== null && "kind" in raw) {
      if (raw.kind === "array") {
        out.set(param.name, raw.values);
      } else {
        out.set(param.name, raw.values);
      }
      continue;
    }

    out.set(param.name, raw);
  }

  return out;
};

const evaluateExprBody = (
  fn: FunctionDef,
  bindings: Map<string, ScalarValue | ScalarValue[] | null>,
): ScalarValue | ScalarValue[] => {
  if (fn.body.kind !== "expr") {
    return null;
  }

  return evaluateFunctionExpr(fn.body.expr, bindings);
};

const evaluateFunctionExpr = (
  expr: FunctionExprDef,
  bindings: Map<string, ScalarValue | ScalarValue[] | null>,
): ScalarValue | ScalarValue[] => {
  if (expr.kind === "param_ref") {
    return (bindings.get(expr.name) ?? null) as ScalarValue | ScalarValue[];
  }

  if (expr.kind === "literal") {
    return expr.value;
  }

  const evaluatedParts = expr.parts.map((part) => {
    if (part.kind === "param_ref") {
      return bindings.get(part.name) ?? null;
    }
    return part.value;
  });

  const maxLen = evaluatedParts.reduce<number>((acc, part) => (Array.isArray(part) ? Math.max(acc, part.length) : acc), 1);
  if (maxLen <= 1) {
    return evaluatedParts
      .map((part) => (Array.isArray(part) ? part[0] : part))
      .map((value) => (value === null || value === undefined ? "" : String(value)))
      .join("");
  }

  return Array.from({ length: maxLen }).map((_, index) =>
    evaluatedParts
      .map((part) => (Array.isArray(part) ? part[index] : part))
      .map((value) => (value === null || value === undefined ? "" : String(value)))
      .join(""),
  );
};

const literalToEdgeQL = (value: ScalarValue | ScalarValue[] | null): string => {
  if (Array.isArray(value)) {
    return `{${value.map((item) => literalToEdgeQL(item)).join(", ")}}`;
  }

  if (value === null || value === undefined) {
    return "<str>{}";
  }

  if (typeof value === "string") {
    return `'${value.replaceAll("'", "\\'")}'`;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
};
/*
const resolveLinks = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  context: SecurityContext,
  row: Record<string, unknown>,
  relation: LinkRelationIR,
  typeFilter: string | undefined,
  nested: {
    columns: string[];
    shape: SelectShapeElementIR[];
    filter?: FilterExprIR;
    orderBy?: OrderByIR<string>;
    limit?: number;
    offset?: number;
  },
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  const collectScalarExprColumnsLocal = (
    expr: ScalarExprIR,
  ): string[] => {
    if (expr.kind === "column") return expr.column.startsWith("@") ? [] : [expr.column];
    if (expr.kind === "literal") return [];
    if (expr.kind === "neg") return collectScalarExprColumnsLocal(expr.expr);
    if (expr.kind === "index_access") return collectScalarExprColumnsLocal(expr.value);
    return [...collectScalarExprColumnsLocal(expr.left), ...collectScalarExprColumnsLocal(expr.right)];
  };
  const collectFilterColumns = (filter: FilterExprIR | undefined): string[] => {
    if (!filter) {
      return [];
    }
    if (filter.kind === "field") {
      return filter.column.startsWith("@") ? [] : [filter.column];
    }
    if (filter.kind === "field_in") {
      return filter.column.startsWith("@") ? [] : [filter.column];
    }
    if (filter.kind === "field_compare") {
      return [filter.leftColumn, filter.rightColumn].filter((column) => !column.startsWith("@"));
    }
    if (filter.kind === "expr_compare") {
      return [...collectScalarExprColumnsLocal(filter.left), ...collectScalarExprColumnsLocal(filter.right)];
    }
    if (filter.kind === "not") {
      return collectFilterColumns(filter.expr);
    }
    if (filter.kind === "and" || filter.kind === "or") {
      return [...collectFilterColumns(filter.left), ...collectFilterColumns(filter.right)];
    }
    return [];
  };

  const linkPropertyColumns = new Set(relation.propertyColumns ?? []);
  const computedLinkPropertyByName = new Map((relation.computedProperties ?? []).map((property) => [property.name, property] as const));
  const linkPropertyName = (column: string): string | undefined => {
    const property = column.startsWith("@") ? column.slice(1) : column;
    return linkPropertyColumns.has(property) ? property : undefined;
  };
  const collectFilterLinkProperties = (filter: FilterExprIR | undefined): string[] => {
    if (!filter) {
      return [];
    }
    if (filter.kind === "field") {
      const property = linkPropertyName(filter.column);
      return property ? [property] : [];
    }
    if (filter.kind === "field_in") {
      const property = linkPropertyName(filter.column);
      return property ? [property] : [];
    }
    if (filter.kind === "field_compare") {
      return [filter.leftColumn, filter.rightColumn].flatMap((column) => {
        const property = linkPropertyName(column);
        return property ? [property] : [];
      });
    }
    if (filter.kind === "not") {
      return collectFilterLinkProperties(filter.expr);
    }
    if (filter.kind === "and" || filter.kind === "or") {
      return [...collectFilterLinkProperties(filter.left), ...collectFilterLinkProperties(filter.right)];
    }
    return [];
  };
  const collectShapeLinkProperties = (shape: SelectShapeElementIR[]): string[] => shape.flatMap((element) => {
    if (element.kind === "computed") {
      if (element.expr.kind === "field_ref") {
        const property = linkPropertyName(element.expr.column);
        return property ? [property] : [];
      }
      if (element.expr.kind === "literal" && element.name.startsWith("@")) {
        const property = linkPropertyName(element.name);
        return property ? [property] : [];
      }
      if (element.expr.kind === "concat") {
        return element.expr.parts.flatMap((part) => {
          if (part.kind !== "field_ref") {
            return [];
          }
          const property = linkPropertyName(part.column);
          return property ? [property] : [];
        });
      }
    }
    return [];
  });
  const collectComputedExprTargetColumns = (expr: ComputedLinkPropertyExpr): string[] => {
    if (expr.kind === "field_ref") {
      return [expr.name];
    }
    if (expr.kind === "binary_op") {
      return [...collectComputedExprTargetColumns(expr.left), ...collectComputedExprTargetColumns(expr.right)];
    }
    return [];
  };
  const collectComputedExprLinkProperties = (expr: ComputedLinkPropertyExpr): string[] => {
    if (expr.kind === "link_property_ref") {
      return [expr.name];
    }
    if (expr.kind === "binary_op") {
      return [...collectComputedExprLinkProperties(expr.left), ...collectComputedExprLinkProperties(expr.right)];
    }
    return [];
  };
  const requestedComputedLinkProperties = nested.shape.flatMap((element) => {
    if (element.kind !== "computed" || element.expr.kind !== "field_ref" || !element.expr.column.startsWith("@")) {
      return [];
    }
    const property = computedLinkPropertyByName.get(element.expr.column.slice(1));
    return property ? [property] : [];
  });

  const params: ScalarValue[] = [];
  const linkPropertySelectColumns = relation.storage === "table"
    ? [...new Set([
        ...collectShapeLinkProperties(nested.shape),
        ...requestedComputedLinkProperties.flatMap((property) => collectComputedExprLinkProperties(property.computedExpr)),
        ...collectFilterLinkProperties(nested.filter),
        ...(nested.orderBy ? (() => {
          const property = linkPropertyName(nested.orderBy.value);
          return property ? [property] : [];
        })() : []),
      ])]
    : [];
  const requiredColumns = [
    ...nested.columns,
    ...requestedComputedLinkProperties.flatMap((property) => collectComputedExprTargetColumns(property.computedExpr)),
    ...(nested.orderBy ? [nested.orderBy.value] : []),
    ...collectFilterColumns(nested.filter),
  ].filter((column) => !linkPropertyName(column));
  const targetSource = compilePolymorphicTargetSource(db, relation, "t", requiredColumns);
  let sql: string;

  if (relation.storage === "inline") {
    const targetId = row[relation.inlineColumn!];
    if (!isScalarValue(targetId) || targetId === null) {
      return [];
    }

    const selected = [
      `t.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}`,
      ...nested.columns.map((column) => `t.${quoteIdent(column)} AS ${quoteIdent(column)}`),
    ];
    sql = `SELECT ${selected.join(", ")} FROM ${targetSource} WHERE t.${quoteIdent("id")} = ?`;
    params.push(targetId);
  } else {
    const sourceId = row.id;
    if (!isScalarValue(sourceId) || sourceId === null) {
      return [];
    }

    const selected = [
      `t.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}`,
      ...nested.columns
        .filter((column) => !linkPropertyName(column))
        .map((column) => `t.${quoteIdent(column)} AS ${quoteIdent(column)}`),
      ...requestedComputedLinkProperties
        .flatMap((property) => collectComputedExprTargetColumns(property.computedExpr))
        .filter((column) => !nested.columns.includes(column))
        .map((column) => `t.${quoteIdent(column)} AS ${quoteIdent(column)}`),
      ...linkPropertySelectColumns.flatMap((column) => {
        const aliases = [`l.${quoteIdent(column)} AS ${quoteIdent(`@${column}`)}`];
        if (nested.orderBy?.value === column) {
          aliases.push(`l.${quoteIdent(column)} AS ${quoteIdent(column)}`);
        }
        return aliases;
      }),
    ];
    sql = `SELECT ${selected.join(", ")} FROM ${targetSource} JOIN ${linkJunctionFromSql(relation, "l")} ON l.${quoteIdent("target")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("source")} = ?`;
    params.push(sourceId);
  }

  if (nested.filter) {
    sql += ` AND ${compileNestedFilterExprSQL(nested.filter, params, relation.storage === "table" ? "l" : undefined)}`;
  }

  if (nested.orderBy) {
    const orderProperty = relation.storage === "table" ? linkPropertyName(nested.orderBy.value) : undefined;
    const orderExpr = orderProperty ? `l.${quoteIdent(orderProperty)}` : quoteIdent(nested.orderBy.value);
    sql += ` ORDER BY ${orderExpr} ${nested.orderBy.direction.toUpperCase()}`;
  }

  if (nested.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(nested.limit);
  }

  if (nested.offset !== undefined) {
    sql += " OFFSET ?";
    params.push(nested.offset);
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  sqlTrail.push({ sql, params: [...params], loweringMode: "fallback_multi_query" });
  return rows.map((item) => {
    const computedProperties = Object.fromEntries(requestedComputedLinkProperties.map((property) => [
      `@${property.name}`,
      evaluateComputedLinkPropertyExpr(property.computedExpr, item, item),
    ]));
    return materializeSelectRow(db, schema, context, nested.shape, { ...item, ...computedProperties }, rowSourceType(item, relation.targetType), sqlTrail);
  });
};
/*
const resolveBacklinks = (
  db: SQLiteDatabase,
  sources: BacklinkSourceIR[],
  targetId: ScalarValue,
  sqlTrail: SQLArtifact[],
): Array<{ id: unknown; __type__: string }> => {
  const seen = new Set<string>();
  const out: Array<{ id: unknown; __type__: string }> = [];

  for (const source of sources) {
    let rows: Array<{ id: unknown }>;
    if (source.storage === "inline") {
      const sql = `SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(source.table)} WHERE ${quoteIdent(source.inlineColumn!)} = ?`;
      sqlTrail.push({ sql, params: [targetId], loweringMode: "fallback_multi_query" });
      rows = db.prepare(sql).all(targetId) as Array<{ id: unknown }>;
    } else {
      const sql = `SELECT s.${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(source.table)} s JOIN ${quoteIdent(source.linkTable!)} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`;
      sqlTrail.push({ sql, params: [targetId], loweringMode: "fallback_multi_query" });
      rows = db.prepare(sql).all(targetId) as Array<{ id: unknown }>;
    }

    for (const row of rows) {
      const key = `${source.sourceType}:${String(row.id)}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      out.push({
        id: row.id,
        __type__: source.sourceType,
      });
    }
  }

  return out;
};

const resolveBacklinkObjects = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  context: SecurityContext,
  sources: BacklinkSourceIR[],
  targetId: ScalarValue,
  nested: {
    columns: string[];
    shape: SelectShapeElementIR[];
    filter?: FilterExprIR;
    orderBy?: OrderByIR<string>;
    limit?: number;
    offset?: number;
  },
  sqlTrail: SQLArtifact[],
): Record<string, unknown>[] => {
  const rows: Array<Record<string, unknown> & { __source_type: string }> = [];
  const seen = new Set<string>();

  for (const source of sources) {
    const params: ScalarValue[] = [targetId];
    const sourceLinkPropertyColumns = new Set(source.propertyColumns ?? []);
    const sourceLinkPropertyName = (column: string): string | undefined => {
      const property = column.startsWith("@") ? column.slice(1) : column;
      return sourceLinkPropertyColumns.has(property) ? property : undefined;
    };
    const collectFilterSourceLinkProperties = (filter: FilterExprIR | undefined): string[] => {
      if (!filter) {
        return [];
      }
      if (filter.kind === "field") {
        const property = sourceLinkPropertyName(filter.column);
        return property ? [property] : [];
      }
      if (filter.kind === "field_in") {
        const property = sourceLinkPropertyName(filter.column);
        return property ? [property] : [];
      }
      if (filter.kind === "field_compare") {
        return [filter.leftColumn, filter.rightColumn].flatMap((column) => {
          const property = sourceLinkPropertyName(column);
          return property ? [property] : [];
        });
      }
      if (filter.kind === "not") {
        return collectFilterSourceLinkProperties(filter.expr);
      }
      if (filter.kind === "and" || filter.kind === "or") {
        return [...collectFilterSourceLinkProperties(filter.left), ...collectFilterSourceLinkProperties(filter.right)];
      }
      return [];
    };
    const collectShapeSourceLinkProperties = (shape: SelectShapeElementIR[]): string[] => shape.flatMap((element) => {
      if (element.kind === "computed") {
        if (element.expr.kind === "field_ref") {
          const property = sourceLinkPropertyName(element.expr.column);
          return property ? [property] : [];
        }
        if (element.expr.kind === "literal" && element.name.startsWith("@")) {
          const property = sourceLinkPropertyName(element.name);
          return property ? [property] : [];
        }
        if (element.expr.kind === "concat") {
          return element.expr.parts.flatMap((part) => {
            if (part.kind !== "field_ref") {
              return [];
            }
            const property = sourceLinkPropertyName(part.column);
            return property ? [property] : [];
          });
        }
      }
      return [];
    });
    const sourceLinkPropertySelectColumns = source.storage === "table"
      ? [...new Set([
          ...collectShapeSourceLinkProperties(nested.shape),
          ...collectFilterSourceLinkProperties(nested.filter),
          ...(nested.orderBy ? (() => {
            const property = sourceLinkPropertyName(nested.orderBy.value);
            return property ? [property] : [];
          })() : []),
        ])]
      : [];
    const queryColumns = nested.columns.includes("id") ? nested.columns : ["id", ...nested.columns];
    const targetQueryColumns = queryColumns.filter((column) => !sourceLinkPropertyName(column));
    const projected = queryColumns
      .filter((column) => !sourceLinkPropertyName(column))
      .map((column) => `t.${quoteIdent(column)} AS ${quoteIdent(column)}`)
      .join(", ");
    const sourceTypeSelectDefault = `'${source.sourceType.replaceAll("'", "''")}' AS ${quoteIdent("__source_type")}`;

    const sourceTables = schema
      .listConcreteTypesAssignableTo(source.sourceType)
      .map((candidate) => {
        const typeName = qualifiedTypeName(candidate);
        return {
          typeName,
          table: tableNameForType(typeName),
        };
      });

    const queryColumnsWithId = [...new Set(["id", ...targetQueryColumns])];
    const polymorphicSource = sourceTables.length > 0
      ? (() => {
          const selects = sourceTables.map((entry) => {
            const tableInfo = db.prepare(`PRAGMA table_info(${quoteIdent(entry.table)})`).all() as Array<{ name?: unknown }>;
            const available = new Set(tableInfo.map((column) => String(column.name)).filter((name) => name.length > 0));
            const projected = queryColumnsWithId
              .map((column) =>
                available.has(column)
                  ? `${quoteIdent(column)} AS ${quoteIdent(column)}`
                  : `NULL AS ${quoteIdent(column)}`)
              .join(", ");
            return `SELECT '${entry.typeName.replaceAll("'", "''")}' AS ${quoteIdent("__source_type")}, ${projected} FROM ${quoteIdent(entry.table)}`;
          });
          return `(${selects.join(" UNION ALL ")}) t`;
        })()
      : `${quoteIdent(source.table)} t`;
    const sourceTypeSelect = sourceTables.length > 0
      ? `t.${quoteIdent("__source_type")} AS ${quoteIdent("__source_type")}`
      : sourceTypeSelectDefault;
    const linkPropertyProjected = sourceLinkPropertySelectColumns.flatMap((column) => {
      const aliases = [`l.${quoteIdent(column)} AS ${quoteIdent(`@${column}`)}`];
      if (nested.orderBy?.value === column) {
        aliases.push(`l.${quoteIdent(column)} AS ${quoteIdent(column)}`);
      }
      return aliases;
    });
    const selectedParts = [
      sourceTypeSelect,
      ...(projected.length > 0 ? [projected] : []),
      ...(source.storage === "table" ? linkPropertyProjected : []),
    ];
    const selected = selectedParts.join(", ");

    let sql = source.storage === "inline"
      ? `SELECT ${selected} FROM ${polymorphicSource} WHERE t.${quoteIdent(source.inlineColumn!)} = ?`
      : `SELECT ${selected} FROM ${polymorphicSource} JOIN ${quoteIdent(source.linkTable!)} l ON l.${quoteIdent("source")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`;

    if (nested.filter) {
      sql += ` AND ${compileNestedFilterExprSQL(nested.filter, params, source.storage === "table" ? "l" : undefined)}`;
    }

    if (nested.orderBy && source.storage === "table") {
      const orderProperty = sourceLinkPropertyName(nested.orderBy.value);
      if (orderProperty) {
        sql += ` ORDER BY l.${quoteIdent(orderProperty)} ${nested.orderBy.direction.toUpperCase()}`;
      }
    }

    sqlTrail.push({ sql, params: [...params], loweringMode: "fallback_multi_query" });
    const sourceRows = db.prepare(sql).all(...params) as Array<Record<string, unknown> & { __source_type?: unknown }>;

    for (const row of sourceRows) {
      const rowType = String(row.__source_type ?? source.sourceType);
      const key = `${rowType}:${String(row.id)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({ ...row, __source_type: rowType });
    }
  }

  if (nested.orderBy) {
    const direction = nested.orderBy.direction === "desc" ? -1 : 1;
    const orderColumn = nested.orderBy.value;
    rows.sort((a, b) => {
      const left = a[orderColumn] as ScalarValue | undefined;
      const right = b[orderColumn] as ScalarValue | undefined;
      if (left === right) {
        return 0;
      }
      if (left === undefined || left === null) {
        return -1 * direction;
      }
      if (right === undefined || right === null) {
        return 1 * direction;
      }
      if (left < right) {
        return -1 * direction;
      }
      if (left > right) {
        return 1 * direction;
      }
      return 0;
    });
  }

  const offset = nested.offset ?? 0;
  const sliced = nested.limit === undefined
    ? rows.slice(offset)
    : rows.slice(offset, offset + nested.limit);

  return sliced.map((item) => materializeSelectRow(db, schema, context, nested.shape, item, rowSourceType(item, item.__source_type), sqlTrail));
};
*/

const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;
/*
const linkJunctionFromSql = (
  relation: { linkTable?: string; linkTables?: Array<{ table: string }>; propertyColumns?: string[] },
  alias: string,
): string => {
  const tables = relation.linkTables && relation.linkTables.length > 0
    ? relation.linkTables.map((entry) => entry.table)
    : relation.linkTable
      ? [relation.linkTable]
      : [];
  if (tables.length === 0) {
    throw new AppError("E_SQL", "Missing link table metadata");
  }
  if (tables.length === 1) {
    return `${quoteIdent(tables[0]!)} ${alias}`;
  }
  const projection = ["source", "target", ...(relation.propertyColumns ?? [])]
    .map((column) => quoteIdent(column))
    .join(", ");
  const parts = tables.map((table) => `SELECT ${projection}, rowid AS ${quoteIdent("rowid")} FROM ${quoteIdent(table)}`);
  return `(${parts.join(" UNION ALL ")}) ${alias}`;
};
*/

/*
const compilePolymorphicTargetSource = (
  db: SQLiteDatabase,
  relation: LinkRelationIR,
  alias: string,
  requiredColumns: string[],
): string => {
  const targets = relation.targetTables.length > 0
    ? relation.targetTables
    : [{ name: relation.targetType, table: relation.targetTable }];

  const columns = [...new Set(["id", ...requiredColumns.filter((column) => column !== "__source_type")])];
  const tableColumns = new Map<string, Set<string>>();
  for (const target of targets) {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(target.table)})`).all() as Array<{ name?: unknown }>;
    tableColumns.set(
      target.table,
      new Set(rows.map((row) => String(row.name)).filter((name) => name.length > 0)),
    );
  }

  const renderSelect = (target: (typeof targets)[number]): string => {
    const available = tableColumns.get(target.table) ?? new Set<string>();
    const projectedColumns = columns
      .map((column) =>
        available.has(column)
          ? `${quoteIdent(column)} AS ${quoteIdent(column)}`
          : `NULL AS ${quoteIdent(column)}`)
      .join(", ");
    return `SELECT '${target.name.replaceAll("'", "''")}' AS ${quoteIdent("__source_type")}, ${projectedColumns} FROM ${quoteIdent(target.table)}`;
  };

  if (targets.length === 1) {
    return `(${renderSelect(targets[0])}) ${alias}`;
  }

  const selects = targets.map((target) => renderSelect(target));
  return `(${selects.join(" UNION ALL ")}) ${alias}`;
};
*/

const isScalarValue = (value: unknown): value is ScalarValue =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const isRecordRow = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parsePayloadArray = (value: unknown): unknown[] | null => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    function decodeNested(input: unknown[]): unknown[];
    function decodeNested(input: unknown): unknown;
    function decodeNested(input: unknown): unknown {
      if (typeof input === "string") {
        const trimmed = input.trim();
        if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
          try {
            return decodeNested(JSON.parse(trimmed));
          } catch {
            return input;
          }
        }
        return input;
      }

      if (Array.isArray(input)) {
        return input.map((entry) => decodeNested(entry));
      }

      if (input && typeof input === "object") {
        return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, decodeNested(entry)]));
      }

      return input;
    }

    return decodeNested(parsed);
  } catch {
    return null;
  }
};

const rowSourceType = (row: Record<string, unknown>, fallbackType: string): string => {
  const type = row.__source_type;
  return typeof type === "string" ? type : fallbackType;
};

const extractOverlays = (ir: IRStatement): OverlayIR[] => {
  if (ir.kind === "select") {
    return ir.appliedOverlays;
  }

  if (ir.kind === "select_free") {
    return [];
  }

  if (ir.kind === "select_expr") {
    return [];
  }

  if (ir.kind === "group") {
    return [];
  }

  return ir.overlays;
};

const tableNameForType = (qualifiedName: string): string => qualifiedName.replaceAll("::", "__").toLowerCase();
const PENDING_INLINE_LINK_VALUE = "__gel_pending_inline_link__";
const PENDING_INSERT_REWRITE_VALUE = "__gel_pending_insert_rewrite__";

const normalizeLinkTargetNames = (targetType: string, moduleName: string): string[] =>
  targetType
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.includes("::") ? part : `${moduleName}::${part}`));

const assignableTargetTablesForTargets = (
  schema: SchemaSnapshot,
  targetTypeNames: string[],
): Set<string> => {
  const tables = new Set<string>();
  for (const targetTypeName of targetTypeNames) {
    const assignable = schema.listConcreteTypesAssignableTo(targetTypeName);
    if (assignable.length > 0) {
      for (const candidate of assignable) {
        tables.add(tableNameForType(qualifiedTypeName(candidate)));
      }
      continue;
    }

    tables.add(tableNameForType(targetTypeName));
  }

  return tables;
};

const validateLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: IRStatement,
  ast: Statement,
): void => {
  if (ir.kind !== "insert" && ir.kind !== "update") {
    return;
  }

  const typeDef = schema.listTypes().find((candidate) => tableNameForType(qualifiedTypeName(candidate)) === ir.table);
  if (!typeDef) {
    return;
  }

  for (const link of typeDef.links ?? []) {
    if (link.multi) {
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    if (!(inlineColumn in ir.values)) {
      continue;
    }

    const assignedId = ir.values[inlineColumn];
    if (assignedId === null) {
      continue;
    }
    if (assignedId === PENDING_INLINE_LINK_VALUE) {
      continue;
    }
    if (typeof assignedId !== "string") {
      throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': expected string`, ast.pos.line, ast.pos.column);
    }

    const row = db
      .prepare('SELECT "type_name" AS "type_name" FROM "__gel_global_ids" WHERE "id" = ?')
      .all(assignedId)[0] as { type_name?: unknown } | undefined;

    if (!row || typeof row.type_name !== "string") {
      throw new AppError(
        "E_SEMANTIC",
        `Invalid id for link '${link.name}': '${assignedId}' does not reference an existing object`,
        ast.pos.line,
        ast.pos.column,
      );
    }

    const targetTypeNames = normalizeLinkTargetNames(link.targetType, typeDef.module ?? "default");
    const expectedTargetTables = assignableTargetTablesForTargets(schema, targetTypeNames);
    if (!expectedTargetTables.has(row.type_name)) {
      const expected = [...expectedTargetTables].sort().join(" or ");
      throw new AppError(
        "E_SEMANTIC",
        `Invalid id for link '${link.name}': expected '${expected}', got '${row.type_name}'`,
        ast.pos.line,
        ast.pos.column,
      );
    }
  }
};

const fieldsFromShape = (shape: SelectStatement["shape"]): string[] => {
  const fields = new Set<string>(["id"]);
  for (const element of shape) {
    if (element.kind === "field") {
      fields.add(element.name);
    }
  }
  return [...fields];
};

const typeDefForTable = (schema: SchemaSnapshot, table: string): TypeDef | undefined =>
  schema.listTypes().find((candidate) => tableNameForType(qualifiedTypeName(candidate)) === table);

const typeDefForInsertIR = (schema: SchemaSnapshot, table: string): TypeDef | undefined =>
  typeDefForTable(schema, table);

const resolveConflictField = (ast: InsertStatement, typeDef: TypeDef): string | undefined => {
  if (ast.conflict?.onField) {
    return ast.conflict.onField;
  }

  for (const candidate of ["name", "title"]) {
    if (typeDef.fields.some((field) => field.name === candidate) && candidate in ast.values) {
      return candidate;
    }
  }

  return undefined;
};

const scalarFromInsertValue = (
  value: InsertValue,
  resolveBinding: (name: string) => ScalarValue,
  line: number,
  column: number,
): ScalarValue => {
  if (isScalarValue(value)) {
    return value;
  }

  if (value.kind === "binding_ref") {
    return resolveBinding(value.name);
  }

  throw new AppError("E_SEMANTIC", `Expected scalar value, got '${value.kind}'`, line, column);
};

const findConflictRowId = (
  db: SQLiteDatabase,
  table: string,
  field: string,
  value: ScalarValue,
): string | undefined => {
  const row = db
    .prepare(`SELECT "id" AS "id" FROM ${quoteIdent(table)} WHERE ${quoteIdent(field)} = ? LIMIT 1`)
    .all(value)[0] as { id?: unknown } | undefined;
  return typeof row?.id === "string" ? row.id : undefined;
};

const makeBindingResolver = (
  ast: Statement,
  context: SecurityContext,
  line: number,
  column: number,
): ((name: string) => ScalarValue) => {
  const bindings = new Map((ast.with ?? []).map((binding) => [binding.name, binding.value] as const));
  const cache = new Map<string, ScalarValue>();
  const pending = new Set<string>();

  const resolve = (name: string): ScalarValue => {
    if (cache.has(name)) {
      return cache.get(name) as ScalarValue;
    }
    if (pending.has(name)) {
      throw new AppError("E_SEMANTIC", `Cyclic with binding '${name}'`, line, column);
    }

    const binding = bindings.get(name);
    if (!binding) {
      throw new AppError("E_SEMANTIC", `Unknown with binding '${name}'`, line, column);
    }

    pending.add(name);
    let value: ScalarValue;
    if (binding.kind === "literal") {
      value = binding.value;
    } else if (binding.kind === "binding_ref") {
      value = resolve(binding.name);
    } else if (binding.kind === "parameter") {
      const globals = context.globals ?? {};
      if (!Object.prototype.hasOwnProperty.call(globals, binding.name)) {
        throw new AppError("E_SEMANTIC", `Unknown query parameter '$${binding.name}'`, line, column);
      }
      value = globals[binding.name] as ScalarValue;
    } else {
      throw new AppError("E_SEMANTIC", `With binding '${name}' is a subquery and cannot be scalar`, line, column);
    }

    pending.delete(name);
    cache.set(name, value);
    return value;
  };

  return resolve;
};

const executeSelectExprRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: Extract<InsertValue, { kind: "select" }>,
  context: SecurityContext,
): Record<string, unknown>[] => {
  const shape = expr.shape.length > 0 ? [...expr.shape] : [{ kind: "field", name: "id" } as const];
  const hasId = shape.some((element) => element.kind === "field" && element.name === "id");
  if (!hasId) {
    shape.unshift({ kind: "field", name: "id" });
  }
  const ast: SelectStatement = {
    kind: "select",
    with: expr.clauses._withBindings,
    withModule: expr.clauses._withModule,
    withModuleAliases: expr.clauses._withModuleAliases,
    typeName: expr.typeName,
    shape,
    fields: fieldsFromShape(shape),
    filter: expr.clauses.filter,
    orderBy: expr.clauses.orderBy,
    limit: expr.clauses.limit,
    offset: expr.clauses.offset,
    pos: { line: 1, column: 1 },
  };

  const compiler = getCompilerService();
  const compiled = compiler.compile(schema, ast, { globals: context.globals });
  assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
  if (compiled.ir.kind !== "select") {
    return [];
  }
  return runSelectIR(db, schema, compiled.ir, context, compiled.sql, []);
};

const statementTypeOf = (statement: Statement): "select" | "insert" | "update" | "delete" => {
  if (statement.kind === "for") {
    return statement.body.kind === "insert" ? "insert" : "select";
  }
  if (statement.kind === "select" || statement.kind === "insert" || statement.kind === "update" || statement.kind === "delete") {
    return statement.kind;
  }
  return "select";
};

const normalizeSecurityContext = (context: SecurityContext): SecurityContext => {
  return {
    roleName: context.roleName ?? DEFAULT_SECURITY_CONTEXT.roleName,
    isSuperuser: context.isSuperuser ?? DEFAULT_SECURITY_CONTEXT.isSuperuser,
    permissions: context.permissions ? [...context.permissions] : [...(DEFAULT_SECURITY_CONTEXT.permissions ?? [])],
    globals: { ...(DEFAULT_SECURITY_CONTEXT.globals ?? {}), ...(context.globals ?? {}) },
    runtimeTarget: context.runtimeTarget ?? DEFAULT_SECURITY_CONTEXT.runtimeTarget,
  };
};

const enforceBuiltinPermissions = (
  context: SecurityContext,
  statementType: "select" | "insert" | "update" | "delete",
  line: number,
  column: number,
): void => {
  if (context.isSuperuser) {
    return;
  }

  if (statementType === "insert" || statementType === "update" || statementType === "delete") {
    if (!hasPermission(context, "sys::perm::data_modification")) {
      throw new AppError(
        "E_RUNTIME",
        "Permission denied: 'sys::perm::data_modification' is required for data modification statements",
        line,
        column,
      );
    }
  }
};

const hasPermission = (context: SecurityContext, permissionName: string): boolean => {
  if (context.isSuperuser) {
    return true;
  }

  return new Set(context.permissions ?? []).has(permissionName);
};

const runWriteWithAccessPolicies = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Statement,
  ir: IRStatement,
  sqlArtifact: SQLArtifact,
  subjectType: TypeDef,
  context: SecurityContext,
): { changes: number; rows?: Record<string, unknown>[] } => {
  validateLinkAssignments(db, schema, ir, ast);

  if (ast.kind === "update") {
    const readonlyFields = new Set(subjectType.fields.filter((field) => field.readonly).map((field) => field.name));
    const readonlyLinks = new Set((subjectType.links ?? []).filter((link) => link.readonly).map((link) => link.name));
    for (const fieldName of Object.keys(ast.values)) {
      if (readonlyFields.has(fieldName) || readonlyLinks.has(fieldName)) {
        throw new AppError("E_SEMANTIC", `cannot update read-only pointer '${fieldName}'`, ast.pos.line, ast.pos.column);
      }
    }
  }

  const applyPendingInsertDefaults = (values: Record<string, ScalarValue>): void => {
    for (const field of subjectType.fields) {
      if (!field.hasDefault) {
        continue;
      }
      if (values[field.name] !== PENDING_INSERT_REWRITE_VALUE) {
        continue;
      }

      const defaultExpr = field.defaultExpr;
      if (!defaultExpr) {
        continue;
      }

      if (defaultExpr.kind === "literal") {
        values[field.name] = defaultExpr.value;
        continue;
      }

      const evaluated = executeFunctionCall(schema, db, context, defaultExpr.name, defaultExpr.args as RuntimeFunctionArg[]);
      if (isScalarValue(evaluated)) {
        values[field.name] = evaluated;
        continue;
      }

      if (Array.isArray(evaluated) && evaluated.length > 0 && isScalarValue(evaluated[0])) {
        values[field.name] = evaluated[0] as ScalarValue;
      }
    }
  };

  const applyOnTargetDeletePolicies = (targetType: TypeDef, targetIds: string[], astPos: { line: number; column: number }): void => {
    if (targetIds.length === 0) {
      return;
    }

    const targetQualifiedName = qualifiedTypeName(targetType);

    const linkTargetsType = (link: NonNullable<TypeDef["links"]>[number], sourceModule: string): boolean => {
      const targets = normalizeLinkTargetNames(link.targetType, sourceModule);
      return targets.some((target) => {
        if (target === targetQualifiedName) {
          return true;
        }
        return schema.listConcreteTypesAssignableTo(target).some((candidate) => qualifiedTypeName(candidate) === targetQualifiedName);
      });
    };

    for (const sourceType of schema.listTypes()) {
      const sourceQualifiedName = qualifiedTypeName(sourceType);
      const sourceTable = tableNameForType(sourceQualifiedName);
      const sourceModule = sourceType.module ?? "default";

      for (const link of sourceType.links ?? []) {
        if (!link.onTargetDelete || !linkTargetsType(link, sourceModule)) {
          continue;
        }

        const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
        const sourceIds = new Set<string>();

        if (usesLinkTable) {
          const linkTable = `${sourceTable}__${link.name.toLowerCase()}`;
          const placeholders = targetIds.map(() => "?").join(", ");
          const rows = db
            .prepare(`SELECT ${quoteIdent("source")} AS ${quoteIdent("source")} FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("target")} IN (${placeholders})`)
            .all(...targetIds) as Array<{ source?: unknown }>;
          for (const row of rows) {
            if (typeof row.source === "string") {
              sourceIds.add(row.source);
            }
          }
        } else {
          const inlineColumn = `${link.name}_id`;
          const placeholders = targetIds.map(() => "?").join(", ");
          const rows = db
            .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent(inlineColumn)} IN (${placeholders})`)
            .all(...targetIds) as Array<{ id?: unknown }>;
          for (const row of rows) {
            if (typeof row.id === "string") {
              sourceIds.add(row.id);
            }
          }
        }

        if (sourceIds.size === 0) {
          continue;
        }

        if (link.onTargetDelete === "restrict" || link.onTargetDelete === "deferred_restrict") {
          throw new AppError(
            "E_SEMANTIC",
            `deletion of '${targetQualifiedName}' is restricted by link '${sourceQualifiedName}.${link.name}'`,
            astPos.line,
            astPos.column,
          );
        }

        if (link.onTargetDelete === "delete_source") {
          const sourceIdList = [...sourceIds];
          const placeholders = sourceIdList.map(() => "?").join(", ");
          db.prepare(`DELETE FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent("id")} IN (${placeholders})`).run(...sourceIdList);
        }
      }
    }
  };

  db.prepare("BEGIN").run();
  try {
    if (ir.kind === "insert") {
      const insertValues: Record<string, ScalarValue> = { ...ir.values };
      applyPendingInsertDefaults(insertValues);

      if (ast.kind === "insert") {
        for (const link of subjectType.links ?? []) {
          if (link.multi || (link.properties?.length ?? 0) > 0) {
            continue;
          }
          if (!Object.prototype.hasOwnProperty.call(ast.values, link.name)) {
            continue;
          }

          const inlineColumn = `${link.name}_id`;
          const targets = resolveInsertTargets(db, schema, ast.values[link.name]!, context, ast);
          insertValues[inlineColumn] = targets[0]?.id ?? null;
        }
      }

      const normalizedEntries = Object.entries(insertValues).filter(([column, value]) => {
        if (column === "id") {
          return false;
        }
        if (value === PENDING_INLINE_LINK_VALUE || value === PENDING_INSERT_REWRITE_VALUE) {
          return false;
        }
        return true;
      });

      if (normalizedEntries.length === 0) {
        sqlArtifact.sql = `INSERT INTO ${quoteIdent(ir.table)} DEFAULT VALUES`;
        sqlArtifact.params = [];
      } else {
        const columns = normalizedEntries.map(([column]) => column);
        const params = normalizedEntries.map(([, value]) => (typeof value === "boolean" ? (value ? 1 : 0) : value));
        sqlArtifact.sql = `INSERT INTO ${quoteIdent(ir.table)} (${columns.map((column) => quoteIdent(column)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
        sqlArtifact.params = params;
      }

      enforceInsertPolicies(subjectType, insertValues, context, ast.pos.line, ast.pos.column);

      if (ast.kind === "insert" && ast.conflict) {
        const conflictField = resolveConflictField(ast, subjectType);
        if (conflictField) {
          const resolveBinding = makeBindingResolver(ast, context, ast.pos.line, ast.pos.column);
          const rawValue = ast.values[conflictField];
          if (rawValue !== undefined) {
            const conflictValue = scalarFromInsertValue(rawValue, resolveBinding, ast.pos.line, ast.pos.column);
            const existingId = findConflictRowId(db, ir.table, conflictField, conflictValue);
            if (existingId) {
              if (ast.conflict.else?.kind === "update") {
                const updates = Object.entries(ast.conflict.else.values);
                if (updates.length > 0) {
                  const sql = `UPDATE ${quoteIdent(ir.table)} SET ${updates
                    .map(([key]) => `${quoteIdent(key)} = ?`)
                    .join(", ")} WHERE ${quoteIdent("id")} = ?`;
                  const params = updates.map(([, value]) => value);
                  params.push(existingId);
                  const writeResult = db.prepare(sql).run(...params);
                  db.prepare("COMMIT").run();
                  return { changes: writeResult.changes };
                }
              }

              db.prepare("COMMIT").run();
              return { changes: 0 };
            }
          }
        }
      }

      const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);

      if (ast.kind === "insert") {
        const inserted = db
          .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(ir.table)} ORDER BY rowid DESC LIMIT 1`)
          .all()[0] as { id?: unknown } | undefined;
        if (typeof inserted?.id === "string") {
          const postInsertIR = {
            ...ir,
            linkAssignments: ir.linkAssignments?.filter((assignment) => assignment.storage !== "inline"),
          };
          applyInsertLinkAssignments(db, schema, postInsertIR, ast, inserted.id, context);
        }
      }

      db.prepare("COMMIT").run();
      return { changes: writeResult.changes };
    }

    if (ir.kind === "update") {
      const preRows = ast.kind === "update"
        ? readTargetRowsForAssignableTypes(db, schema, subjectType, ir.filter)
        : readTargetRowsForFilter(db, ir.table, ir.filter);
      enforceUpdateReadPolicies(subjectType, preRows, context, ast.pos.line, ast.pos.column);
      const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
      if (ast.kind === "update") {
        applyUpdateLinkAssignments(
          db,
          schema,
          ir,
          ast,
          preRows.map((row) => String(row.id)),
          context,
        );
      }
      const updatedRows = preRows.length > 0 ? readRowsByIds(db, ir.table, preRows.map((row) => String(row.id))) : [];
      enforceUpdateWritePolicies(subjectType, updatedRows, context, ast.pos.line, ast.pos.column);
      db.prepare("COMMIT").run();
      return { changes: writeResult.changes };
    }

    if (ir.kind === "delete") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      enforceDeletePolicies(subjectType, preRows, context, ast.pos.line, ast.pos.column);
      applyOnTargetDeletePolicies(subjectType, preRows.map((row) => String(row.id)), ast.pos);
      if (/\bRETURNING\b/i.test(sqlArtifact.sql)) {
        const rows = db.prepare(sqlArtifact.sql).all(...sqlArtifact.params) as Record<string, unknown>[];
        db.prepare("COMMIT").run();
        return { changes: rows.length, rows };
      }
      const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
      db.prepare("COMMIT").run();
      return { changes: writeResult.changes };
    }

    const writeResult = db.prepare(sqlArtifact.sql).run(...sqlArtifact.params);
    db.prepare("COMMIT").run();
    return { changes: writeResult.changes };
  } catch (err) {
    db.prepare("ROLLBACK").run();
    throw err;
  }
};

const executeMutationBinding = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  statement: Statement,
  context: SecurityContext,
): Record<string, unknown>[] => {
  if (statement.kind !== "update" && statement.kind !== "insert" && statement.kind !== "delete") {
    return [];
  }

  const compilerService = getCompilerService();
  const runtimeTarget = resolvedRuntimeTarget(context, db);

  const expanded: Statement[] = (statement.kind === "update" || statement.kind === "delete")
    ? (expandPolymorphicMutation(schema, statement) ?? [statement])
    : [statement];

  const collected: Record<string, unknown>[] = [];

  for (const ast of expanded) {
    const compiled = compilerService.compile(schema, ast, { globals: context.globals, target: runtimeTarget });
    const ir = compiled.ir;
    if (ir.kind !== "update" && ir.kind !== "insert" && ir.kind !== "delete") {
      continue;
    }
    const subjectType = typeDefForTable(schema, ir.table);
    if (!subjectType) {
      continue;
    }
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const concreteName = qualifiedTypeName(subjectType);

    if (ir.kind === "update") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      const targetIds = preRows.map((row) => String(row.id));
      runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context);
      const postRows = readRowsByIds(db, ir.table, targetIds);
      for (const row of postRows) {
        collected.push({ ...row, __source_type: concreteName });
      }
      continue;
    }

    if (ir.kind === "delete") {
      const preRows = readTargetRowsForFilter(db, ir.table, ir.filter);
      const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context);
      const deletedRows = writeResult.rows ?? preRows;
      for (const row of deletedRows) {
        collected.push({ ...row, __source_type: concreteName });
      }
      continue;
    }

    runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context);
    const inserted = db
      .prepare(`SELECT * FROM ${quoteIdent(ir.table)} ORDER BY rowid DESC LIMIT 1`)
      .all()[0] as Record<string, unknown> | undefined;
    if (inserted) {
      collected.push({ ...inserted, __source_type: concreteName });
    }
  }

  return collected;
};

const executeNestedInsert = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  expr: Extract<InsertValue, { kind: "insert" }>,
  context: SecurityContext,
  parentAst?: Pick<InsertStatement, "with" | "withModule" | "withModuleAliases">,
): string[] => {
  const ast: InsertStatement = {
    kind: "insert",
    with: parentAst?.with,
    withModule: parentAst?.withModule,
    withModuleAliases: parentAst?.withModuleAliases,
    typeName: expr.typeName,
    values: expr.values,
    pos: { line: 1, column: 1 },
  };

  const compiler = getCompilerService();
  const compiled = compiler.compile(schema, ast, { globals: context.globals });
  assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
  if (compiled.ir.kind !== "insert") {
    return [];
  }

  const typeDef = typeDefForInsertIR(schema, compiled.ir.table);
  if (!typeDef) {
    return [];
  }

  enforceInsertPolicies(typeDef, compiled.ir.values, context, 1, 1);
  db.prepare(compiled.sql.sql).run(...compiled.sql.params);
  const inserted = db
    .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(compiled.ir.table)} ORDER BY rowid DESC LIMIT 1`)
    .all()[0] as { id?: unknown } | undefined;
  if (typeof inserted?.id !== "string") {
    return [];
  }

  applyInsertLinkAssignments(db, schema, compiled.ir, ast, inserted.id, context);
  return [inserted.id];
};

type LinkTargetAssignment = {
  id: string;
  properties: Record<string, ScalarValue>;
};

const resolveInsertTargets = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  value: InsertValue,
  context: SecurityContext,
  ast: InsertStatement,
): LinkTargetAssignment[] => {
  const resolveBinding = makeBindingResolver(ast, context, ast.pos.line, ast.pos.column);

  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return typeof value === "string" ? [{ id: value, properties: {} }] : [];
  }

  if (value.kind === "binding_ref") {
    const withValue = (ast.with ?? []).find((binding) => binding.name === value.name)?.value;
    if (withValue && withValue.kind === "subquery") {
      const rows = executeSelectExprRows(db, schema, withValue.query as Extract<InsertValue, { kind: "select" }>, context);
      return rows
        .map((row) => {
          if (typeof row.id !== "string") {
            return undefined;
          }

          const properties: Record<string, ScalarValue> = {};
          for (const [key, raw] of Object.entries(row)) {
            if (!key.startsWith("@")) {
              continue;
            }

            const scalar = coerceUnknownToScalar(raw);
            if (scalar === undefined) {
              continue;
            }
            properties[key] = scalar;
          }

          return { id: row.id, properties };
        })
        .filter((entry): entry is LinkTargetAssignment => !!entry);
    }

    // Bare type name as a link target (`l_a := A`) — resolve to all rows of
    // that type (and its concrete subtypes).
    const qualifiedName = value.name.includes("::") ? value.name : `default::${value.name}`;
    const typeDefByName = schema.getType(qualifiedName);
    if (typeDefByName) {
      const concretes = schema.listConcreteTypesAssignableTo(qualifiedName);
      const tables = concretes.length > 0
        ? concretes.map((concrete) => qualifiedTypeName(concrete))
        : [qualifiedName];
      const collected: LinkTargetAssignment[] = [];
      for (const typeName of tables) {
        const table = typeName.replaceAll("::", "__").toLowerCase();
        const rows = db.prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(table)}`).all() as { id?: unknown }[];
        for (const row of rows) {
          if (typeof row.id === "string") {
            collected.push({ id: row.id, properties: {} });
          }
        }
      }
      return collected;
    }

    const scalar = resolveBinding(value.name);
    return typeof scalar === "string" ? [{ id: scalar, properties: {} }] : [];
  }

  if (value.kind === "select") {
    const scopedSelect = {
      ...value,
      clauses: {
        ...value.clauses,
        _withBindings: value.clauses._withBindings ?? ast.with,
        _withModule: value.clauses._withModule ?? ast.withModule,
        _withModuleAliases: value.clauses._withModuleAliases ?? ast.withModuleAliases,
      },
    };
    const rows = executeSelectExprRows(db, schema, scopedSelect, context);
    return rows
      .map((row) => {
        if (typeof row.id !== "string") {
          return undefined;
        }

        const properties: Record<string, ScalarValue> = {};
        for (const [key, raw] of Object.entries(row)) {
          if (!key.startsWith("@")) {
            continue;
          }

          const scalar = coerceUnknownToScalar(raw);
          if (scalar === undefined) {
            continue;
          }
          properties[key] = scalar;
        }

        return { id: row.id, properties };
      })
      .filter((entry): entry is LinkTargetAssignment => !!entry);
  }

  if (value.kind === "insert") {
    return executeNestedInsert(db, schema, value, context, ast).map((id) => ({ id, properties: {} }));
  }

  if (value.kind === "set") {
    return value.values.flatMap((item) => resolveInsertTargets(db, schema, item, context, ast));
  }

  if (value.kind === "for") {
    const iteratorValues = evaluateForIteratorValues(value.iteratorExpr, schema, db, context);
    const rows: LinkTargetAssignment[] = [];

    for (const iterValue of iteratorValues) {
      if (value.body.kind === "select") {
        const selectAst = ensureSelectAstHasId(bindSelectAstVariable(value.body, value.variable, iterValue));
        const compiler = getCompilerService();
        const compiled = compiler.compile(schema, selectAst, { globals: context.globals });
        assertTargetSqlCompatibility(compiled.sql.sql, resolvedRuntimeTarget(context, db));
        if (compiled.ir.kind !== "select") {
          continue;
        }

        const selectedRows = runSelectIR(db, schema, compiled.ir, context, compiled.sql, []);
        for (const row of selectedRows) {
          if (typeof row.id !== "string") {
            continue;
          }
          const properties: Record<string, ScalarValue> = {};
          for (const [key, raw] of Object.entries(row)) {
            if (!key.startsWith("@")) {
              continue;
            }

            const scalar = coerceUnknownToScalar(raw);
            if (scalar === undefined) {
              continue;
            }
            properties[key] = scalar;
          }
          rows.push({ id: row.id, properties });
        }
      } else if (value.body.kind === "insert") {
        const replacedValues: Record<string, InsertValue> = {};
        for (const [field, insertValue] of Object.entries(value.body.values)) {
          if (typeof insertValue === "object" && insertValue !== null && "kind" in insertValue && insertValue.kind === "binding_ref" && insertValue.name === value.variable) {
            const scalar = coerceUnknownToScalar(iterValue);
            replacedValues[field] = scalar ?? insertValue;
          } else {
            replacedValues[field] = insertValue;
          }
        }

        const nestedIds = executeNestedInsert(db, schema, { kind: "insert", typeName: value.body.typeName, values: replacedValues }, context, ast);
        rows.push(...nestedIds.map((id) => ({ id, properties: {} })));
      }
    }

    return rows;
  }

  return [];
};

const defaultLinkPropertyValueIR = (property: InsertLinkPropertyIR): ScalarValue => {
  if (!property.hasDefault) return null;
  if (property.type === "int" || property.type === "float") {
    return Math.round(Math.random() * 10);
  }
  return null;
};

// Resolves the `__gel_global_ids` type for each id with a single batched
// SELECT, then enforces the assignable-target-table set for the link.
// Replaces the per-id validation loop with one round trip per link.
const validateLinkTargetIds = (
  db: SQLiteDatabase,
  linkName: string,
  targetIds: string[],
  expectedTargetTables: ReadonlyArray<string>,
  pos: { line: number; column: number },
): void => {
  if (targetIds.length === 0) return;
  const placeholders = targetIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT "id" AS "id", "type_name" AS "type_name" FROM "__gel_global_ids" WHERE "id" IN (${placeholders})`)
    .all(...targetIds) as Array<{ id?: unknown; type_name?: unknown }>;
  const typeById = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.id === "string" && typeof row.type_name === "string") {
      typeById.set(row.id, row.type_name);
    }
  }
  const allowed = new Set(expectedTargetTables);
  for (const targetId of targetIds) {
    const typeName = typeById.get(targetId);
    if (typeName === undefined) {
      throw new AppError("E_SEMANTIC", `Invalid id for link '${linkName}': '${targetId}' does not reference an existing object`, pos.line, pos.column);
    }
    if (!allowed.has(typeName)) {
      const expected = [...allowed].sort().join(" or ");
      throw new AppError("E_SEMANTIC", `Invalid id for link '${linkName}': expected '${expected}', got '${typeName}'`, pos.line, pos.column);
    }
  }
};

const writeLinkTableRows = (
  db: SQLiteDatabase,
  linkTable: string,
  propertyColumns: ReadonlyArray<string>,
  properties: ReadonlyArray<InsertLinkPropertyIR>,
  sourceId: string,
  assignments: ReadonlyArray<{ id: string; properties: Record<string, ScalarValue> }>,
): void => {
  if (assignments.length === 0) return;
  const columns = ["source", "target", ...propertyColumns];
  const propertyByName = new Map(properties.map((p) => [p.name, p] as const));
  const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
  const sql = `INSERT INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES ${assignments.map(() => rowPlaceholders).join(", ")}`;
  const params: ScalarValue[] = [];
  for (const assignment of assignments) {
    params.push(sourceId, assignment.id);
    for (const column of propertyColumns) {
      const explicit = assignment.properties[`@${column}`];
      if (explicit !== undefined) {
        params.push(explicit);
      } else {
        const property = propertyByName.get(column);
        params.push(property ? defaultLinkPropertyValueIR(property) : null);
      }
    }
  }
  db.prepare(sql).run(...params);
};

const resolveDefaultLinkTargets = (
  db: SQLiteDatabase,
  spec: InsertLinkDefaultIR,
): Array<{ id: string; properties: Record<string, ScalarValue> }> => {
  if (spec.defaultTargetValues.length > 0 && spec.lookupColumn) {
    const results: Array<{ id: string; properties: Record<string, ScalarValue> }> = [];
    for (const targetValue of spec.defaultTargetValues) {
      const row = db
        .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(spec.targetTable)} WHERE ${quoteIdent(spec.lookupColumn)} = ? LIMIT 1`)
        .all(targetValue)[0] as { id?: unknown } | undefined;
      if (typeof row?.id === "string") {
        results.push({ id: row.id, properties: {} });
      }
    }
    return results;
  }
  const first = db
    .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(spec.targetTable)} ORDER BY rowid ASC LIMIT 1`)
    .all()[0] as { id?: unknown } | undefined;
  return typeof first?.id === "string" ? [{ id: first.id, properties: {} }] : [];
};

const applyInsertLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: InsertIR,
  ast: InsertStatement,
  sourceId: string,
  context: SecurityContext,
): void => {
  for (const assignment of ir.linkAssignments ?? []) {
    const targetAssignments = resolveInsertTargets(db, schema, assignment.target, context, ast);
    const targetIds = targetAssignments.map((entry) => entry.id);
    validateLinkTargetIds(db, assignment.linkName, targetIds, assignment.expectedTargetTables, ast.pos);

    if (assignment.storage === "table") {
      writeLinkTableRows(
        db,
        assignment.linkTable!,
        assignment.propertyColumns ?? [],
        assignment.properties ?? [],
        sourceId,
        targetAssignments,
      );
      continue;
    }

    const inlineTarget = targetIds[0] ?? null;
    db.prepare(`UPDATE ${quoteIdent(assignment.ownerTable)} SET ${quoteIdent(assignment.inlineColumn!)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(inlineTarget, sourceId);
  }

  for (const spec of ir.linkDefaults ?? []) {
    const targets = resolveDefaultLinkTargets(db, spec);
    if (targets.length === 0) continue;

    if (spec.storage === "table") {
      writeLinkTableRows(
        db,
        spec.linkTable!,
        spec.propertyColumns ?? [],
        spec.properties ?? [],
        sourceId,
        targets,
      );
      continue;
    }

    db.prepare(`UPDATE ${quoteIdent(spec.ownerTable)} SET ${quoteIdent(spec.inlineColumn!)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(targets[0]?.id ?? null, sourceId);
  }
};

const writeUpdateLinkTableRows = (
  db: SQLiteDatabase,
  spec: UpdateLinkAssignmentIR,
  sourceId: string,
  targets: ReadonlyArray<{ id: string; properties: Record<string, ScalarValue> }>,
): void => {
  if (targets.length === 0) return;
  const propertyColumns = spec.propertyColumns ?? [];
  const columns = ["source", "target", ...propertyColumns];
  const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
  const verb = spec.operation === "append" ? "INSERT OR IGNORE" : "INSERT";
  const sql = `${verb} INTO ${quoteIdent(spec.linkTable!)} (${columns.map(quoteIdent).join(", ")}) VALUES ${targets.map(() => rowPlaceholders).join(", ")}`;
  const params: ScalarValue[] = [];
  for (const target of targets) {
    params.push(sourceId, target.id);
    for (const column of propertyColumns) {
      params.push(target.properties[`@${column}`] ?? null);
    }
  }
  db.prepare(sql).run(...params);
};

const applyUpdateLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: UpdateIR,
  ast: UpdateStatement,
  sourceIds: string[],
  context: SecurityContext,
): void => {
  if (sourceIds.length === 0) return;

  for (const spec of ir.linkAssignments ?? []) {
    // resolveInsertTargets needs an InsertStatement shell to thread the
    // outer WITH bindings through subqueries; build a minimal one from the
    // UPDATE's preserved bindings.
    const fauxInsertAst: InsertStatement = {
      kind: "insert",
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      typeName: ast.typeName,
      values: {},
      pos: ast.pos,
    };

    const targetAssignments = resolveInsertTargets(db, schema, spec.target, context, fauxInsertAst);
    const targetIds = targetAssignments.map((assignment) => assignment.id);
    validateLinkTargetIds(db, spec.linkName, targetIds, spec.expectedTargetTables, ast.pos);

    if (spec.storage === "table") {
      for (const sourceId of sourceIds) {
        if (spec.operation === "assign") {
          db.prepare(`DELETE FROM ${quoteIdent(spec.linkTable!)} WHERE ${quoteIdent("source")} = ?`).run(sourceId);
        }
        if (spec.operation === "subtract") {
          if (targetIds.length > 0) {
            const placeholders = targetIds.map(() => "?").join(", ");
            db.prepare(`DELETE FROM ${quoteIdent(spec.linkTable!)} WHERE ${quoteIdent("source")} = ? AND ${quoteIdent("target")} IN (${placeholders})`)
              .run(sourceId, ...targetIds);
          }
          continue;
        }
        writeUpdateLinkTableRows(db, spec, sourceId, targetAssignments);
      }
      continue;
    }

    const inlineTarget = targetIds[0] ?? null;
    if (spec.operation === "subtract") {
      const placeholders = sourceIds.map(() => "?").join(", ");
      db.prepare(`UPDATE ${quoteIdent(spec.ownerTable)} SET ${quoteIdent(spec.inlineColumn!)} = NULL WHERE ${quoteIdent("id")} IN (${placeholders}) AND ${quoteIdent(spec.inlineColumn!)} = ?`)
        .run(...sourceIds, inlineTarget);
      continue;
    }

    const placeholders = sourceIds.map(() => "?").join(", ");
    db.prepare(`UPDATE ${quoteIdent(spec.ownerTable)} SET ${quoteIdent(spec.inlineColumn!)} = ? WHERE ${quoteIdent("id")} IN (${placeholders})`)
      .run(inlineTarget, ...sourceIds);
  }
};

const evaluateSelectPolicies = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  typeDef: TypeDef,
  row: Record<string, unknown>,
  context: SecurityContext,
): boolean => {
  const id = row.id;
  if (typeof id !== "string") {
    return true;
  }

  const sourceType = rowSourceType(row, qualifiedTypeName(typeDef));
  const sourceTypeDef = schema.getType(sourceType) ?? typeDef;
  const policies = sourceTypeDef.accessPolicies ?? [];
  if (policies.length === 0 || context.isSuperuser) {
    return true;
  }

  // The SQL projection already carries every column the policy conditions
  // reference (see selectedColumns wiring in semantic.ts), so we can evaluate
  // policies directly on the in-memory row without firing another SELECT.
  // If a policy unexpectedly references a column we didn't project, fall back
  // to re-reading the full row.
  const conditionNeedsAbsentColumn = (condition: AccessPolicyCondition): boolean => {
    if (condition.kind === "field_eq_global" || condition.kind === "field_eq_literal") {
      return !(condition.field in row);
    }
    if (condition.kind === "and") {
      return condition.clauses.some(conditionNeedsAbsentColumn);
    }
    return false;
  };
  const needsFullRow = policies.some((p) => conditionNeedsAbsentColumn(p.condition));
  let rowForEval: Record<string, unknown> = row;
  if (needsFullRow) {
    const sourceTable = tableNameForType(sourceType);
    const fullRow = readRowById(db, sourceTable, id);
    if (!fullRow) {
      return false;
    }
    rowForEval = fullRow;
  }

  return evaluatePoliciesForOperation(sourceTypeDef, "select", rowForEval, context, { failOnDeny: false });
};

const enforceInsertPolicies = (
  typeDef: TypeDef,
  values: Record<string, ScalarValue>,
  context: SecurityContext,
  line: number,
  column: number,
): void => {
  const row: Record<string, unknown> = { ...values };
  const ok = evaluatePoliciesForOperation(typeDef, "insert", row, context, { failOnDeny: true });
  if (!ok) {
    throw new AppError("E_RUNTIME", `Access policy violation on insert of ${qualifiedTypeName(typeDef)}`, line, column);
  }
};

const enforceUpdateReadPolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "update_read", row, context, { failOnDeny: true });
    if (!ok) {
      throw new AppError("E_RUNTIME", `Access policy violation on update read of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};

const enforceUpdateWritePolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "update_write", row, context, { failOnDeny: true });
    if (!ok) {
      throw new AppError("E_RUNTIME", `Access policy violation on update write of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};

const enforceDeletePolicies = (
  typeDef: TypeDef,
  rows: Record<string, unknown>[],
  context: SecurityContext,
  line: number,
  column: number,
): void => {
  for (const row of rows) {
    const ok = evaluatePoliciesForOperation(typeDef, "delete", row, context, { failOnDeny: true });
    if (!ok) {
      throw new AppError("E_RUNTIME", `Access policy violation on delete of ${qualifiedTypeName(typeDef)}`, line, column);
    }
  }
};

const evaluatePoliciesForOperation = (
  typeDef: TypeDef,
  operation: "select" | "insert" | "update_read" | "update_write" | "delete",
  row: Record<string, unknown>,
  context: SecurityContext,
  options: { failOnDeny: boolean },
): boolean => {
  const policies = typeDef.accessPolicies ?? [];
  if (policies.length === 0 || context.isSuperuser) {
    return true;
  }

  const relevant = policies.filter((policy) => appliesToOperation(policy, operation));
  if (relevant.length === 0) {
    return false;
  }

  const allows = relevant.filter((policy) => policy.effect === "allow");
  const denies = relevant.filter((policy) => policy.effect === "deny");
  const allowed = allows.some((policy) => evaluateCondition(policy.condition, row, context));
  if (!allowed) {
    return false;
  }

  for (const deny of denies) {
    if (evaluateCondition(deny.condition, row, context)) {
      if (options.failOnDeny) {
        throw new Error(deny.errmessage ?? `Denied by policy '${deny.name}'`);
      }
      return false;
    }
  }

  return true;
};

const appliesToOperation = (
  policy: AccessPolicyDef,
  operation: "select" | "insert" | "update_read" | "update_write" | "delete",
): boolean => {
  if (policy.operations.includes("all")) {
    return true;
  }

  if (operation === "update_read" || operation === "update_write") {
    return policy.operations.includes(operation) || policy.operations.includes("all");
  }

  return policy.operations.includes(operation);
};

const evaluateCondition = (
  condition: AccessPolicyCondition,
  row: Record<string, unknown>,
  context: SecurityContext,
): boolean => {
  switch (condition.kind) {
    case "always":
      return condition.value;
    case "global": {
      const globalValue = resolveGlobalValue(context, condition.name);
      if (typeof globalValue === "boolean") {
        return globalValue;
      }
      return globalValue !== null && globalValue !== undefined;
    }
    case "field_eq_global": {
      const globalValue = resolveGlobalValue(context, condition.global);
      return row[condition.field] === globalValue;
    }
    case "field_eq_literal":
      return row[condition.field] === condition.value;
    case "and":
      return condition.clauses.every((clause) => evaluateCondition(clause, row, context));
    default:
      return false;
  }
};

const resolveGlobalValue = (context: SecurityContext, name: string): ScalarValue | undefined => {
  if ((name.startsWith("sys::perm::") || name.startsWith("cfg::perm::") || name.includes("::perm::")) && !name.startsWith("global ")) {
    return hasPermission(context, name);
  }

  if (Object.prototype.hasOwnProperty.call(context.globals ?? {}, name)) {
    return context.globals?.[name];
  }

  if (name.includes("::")) {
    const shortName = name.split("::").at(-1);
    if (shortName && Object.prototype.hasOwnProperty.call(context.globals ?? {}, shortName)) {
      return context.globals?.[shortName];
    }
  }

  if (hasPermission(context, name)) {
    return true;
  }

  return undefined;
};

const readTargetRowsForFilter = (
  db: SQLiteDatabase,
  table: string,
  filter: { column: string; value: ScalarValue } | undefined,
): Record<string, unknown>[] => {
  let sql = `SELECT * FROM ${quoteIdent(table)}`;
  const params: ScalarValue[] = [];
  if (filter) {
    sql += ` WHERE ${quoteIdent(filter.column)} = ?`;
    params.push(filter.value);
  }

  return db.prepare(sql).all(...params);
};

const readTargetRowsForAssignableTypes = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  filter: { column: string; value: ScalarValue } | undefined,
): Record<string, unknown>[] => {
  const rows: Record<string, unknown>[] = [];
  const baseTypeName = qualifiedTypeName(typeDef);
  const concreteTypes = schema.listConcreteTypesAssignableTo(baseTypeName);

  for (const concreteType of concreteTypes) {
    const concreteName = qualifiedTypeName(concreteType);
    const table = tableNameForType(concreteName);
    const tableRows = readTargetRowsForFilter(db, table, filter);
    for (const row of tableRows) {
      rows.push({ ...row, __source_type: concreteName });
    }
  }

  return rows;
};

const readRowsByIds = (db: SQLiteDatabase, table: string, ids: string[]): Record<string, unknown>[] => {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} IN (${placeholders})`;
  return db.prepare(sql).all(...ids);
};

const readRowById = (db: SQLiteDatabase, table: string, id: string): Record<string, unknown> | null => {
  const row = db
    .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent("id")} = ?`)
    .all(id)[0];
  return row ?? null;
};
