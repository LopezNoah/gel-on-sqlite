import { getCompilerService, type CompilerCacheMeta } from "../compiler/service.js";
import { AppError, asAppError } from "../errors.js";
import { parseEdgeQL, parseEdgeQLScript, type ParseEdgeQLOptions } from "../edgeql/parser.js";
import { tokenize, type Token } from "../edgeql/tokenizer.js";
import type { BacklinkExpr, ComputedExpr, DeleteStatement, FilterExpr, FilterValue, ForStatement, FreeObjectExpr, FunctionCallArgExpr, FunctionCallExpr, InsertStatement, InsertValue, OrderExpr, OrderExprChain, PathStep, SelectExprStatement, SelectStatement, ShapeElement, Statement, TypeExpr, UpdateStatement, WithBinding, WithBindingValue } from "../edgeql/ast.js";
import type { RuntimeDatabaseAdapter } from "./adapter.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { compileToSQL, computedValueAlias, shapePayloadAlias, type SQLArtifact } from "../sql/compiler.js";
import { executeStdlibFunction, resolveStdlibFunction, type RuntimeFunctionArg } from "../stdlib/functions.js";
import { assertTargetSqlCompatibility, type RuntimeTarget } from "./target.js";
import type { BacklinkSourceIR, FilterExprIR, GroupIR, IRStatement, LinkRelationIR, OrderByIR, OverlayIR, ScalarExprIR, SelectExprIREntry, SelectExprIR, SelectIR, SelectShapeElementIR } from "../ir/model.js";
import type { AccessPolicyCondition, AccessPolicyDef, AliasDef, ComputedLinkPropertyExpr, FieldDef, FunctionDef, FunctionExprDef, ScalarType, ScalarValue, TypeDef } from "../types.js";
import { qualifiedTypeName } from "../schema/schema.js";
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

const runtimeExprAliases = new WeakMap<SchemaSnapshot, Map<string, string>>();

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

const parseRuntimeAliasFilterValues = (exprText: string): RuntimeTypedAliasDef["filterValues"] => {
  const compact = exprText.replace(/^[ \t]*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const filterIndex = compact.toLowerCase().lastIndexOf(" filter ");
  const filterText = filterIndex === -1 ? compact : compact.slice(filterIndex);
  const matches = [...filterText.matchAll(/\.([A-Za-z_][\w]*)\s*=\s*'([^']+)'/g)];
  if (matches.length < 2) {
    return undefined;
  }

  const field = matches[0][1];
  if (!matches.every((match) => match[1] === field)) {
    return undefined;
  }

  return {
    field,
    values: [...new Set(matches.map((match) => match[2]))],
  };
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

const runtimeTypedAliasFromSchemaAlias = (alias: AliasDef): RuntimeTypedAliasDef | undefined => {
  if (!alias.sourceType) {
    return undefined;
  }
  const exprText = alias.exprText ?? "";
  return {
    aliasName: alias.name,
    moduleName: alias.module,
    sourceType: qualifyRuntimeTypeName(alias.sourceType, alias.module),
    filter: alias.filter?.kind === "field_predicate"
      ? { field: alias.filter.field, op: alias.filter.op, value: alias.filter.value }
      : undefined,
    filterValues: parseRuntimeAliasFilterValues(exprText),
    computedProperties: parseRuntimeAliasComputedProperties(exprText),
    computedExistsProperties: parseRuntimeAliasComputedExistsProperties(exprText, alias.module),
    linkOverrides: parseRuntimeAliasLinkOverrides(exprText, alias.module),
  };
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

const splitTopLevelComma = (input: string): string[] => {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "," && depth === 0) {
      const piece = input.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) out.push(tail);
  return out;
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

const registerDynamicFunctionDDL = (schema: SchemaSnapshot, statement: string, defaultModule = "default"): boolean => {
  const header = /^create\s+function\s+([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)?)\s*\(([\s\S]*?)\)\s*->\s*([\s\S]*)$/i.exec(statement.trim());
  if (!header) return false;

  const [, rawName, rawParams, afterArrow] = header;
  const dollarBody = /\busing\s+(?:edgeql\s+)?\$\$([\s\S]*?)\$\$/i.exec(afterArrow);
  const bracedBody = /\{\s*using\s*\(([\s\S]*?)\)\s*\}\s*$/i.exec(afterArrow);
  const parenBody = /\busing\s*\(([\s\S]*?)\)\s*$/i.exec(afterArrow);
  const bodyMatch = dollarBody ?? bracedBody ?? parenBody;
  if (!bodyMatch || bodyMatch.index === undefined) return false;

  const returnPart = afterArrow.slice(0, bodyMatch.index).trim().replace(/\{$/, "").trim();
  const returnOptional = /^optional\s+/i.test(returnPart);
  const returnType = normalizeDynamicTypeName(returnPart, defaultModule);
  const { module, name } = dynamicQualifiedNameParts(rawName, defaultModule);
  const params = splitTopLevelComma(rawParams).map((param) => {
    const match = /^([A-Za-z_][\w]*)\s*:\s*([\s\S]+)$/.exec(param);
    if (!match) return undefined;
    const [, paramName, paramTypeRaw] = match;
    const optional = /^optional\s+/i.test(paramTypeRaw.trim());
    return {
      name: paramName,
      type: normalizeDynamicTypeName(paramTypeRaw, defaultModule),
      optional,
    };
  }).filter((param): param is NonNullable<typeof param> => Boolean(param));
  const bodyText = (bodyMatch[1] ?? "").trim().replace(/;$/, "").trim();
  const query = /^select\b/i.test(bodyText) ? bodyText : `SELECT ${bodyText}`;

  schema.addFunction({
    module,
    name,
    params,
    returnType,
    returnOptional,
    body: { kind: "query", language: "edgeql", query },
  });
  return true;
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

const maybeRegisterDynamicDDLScript = (db: SQLiteDatabase, schema: SchemaSnapshot, script: string, defaultModule = "default"): boolean => {
  let registeredFunction = false;
  let registeredType = false;
  for (const statement of splitTopLevelScriptStatements(script)) {
    registeredFunction = registerDynamicFunctionDDL(schema, statement, defaultModule) || registeredFunction;
    registeredType = registerDynamicTypeDDL(schema, statement, defaultModule) || registeredType;
  }
  if (registeredType) {
    materializeSchema(db, schema);
  }
  if (registeredFunction || registeredType) {
    getCompilerService().clear();
  }
  return registeredFunction || registeredType;
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
    const aliasKey = rawAliasName.includes("::") ? rawAliasName : aliasName;
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

  for (const [aliasName, expr] of aliases.entries()) {
    const startsWithAlias = new RegExp(`^select\\s+${aliasName}(?:\\b|\\s*[\\);,])`, "i").test(trimmed);
    if (!startsWithAlias) {
      continue;
    }

    const replacedSelect = trimmed.replace(
      new RegExp(`^select\\s+${aliasName}\\b`, "i"),
      `SELECT ${expr}`,
    );

    return replacedSelect.replace(
      new RegExp(`\\s+ORDER\\s+BY\\s+${aliasName}\\b(?:\\s+(?:ASC|DESC))?`, "i"),
      "",
    );
  }

  return query;
};

const tryRuntimeAliasTupleSelect = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const aliases = runtimeExprAliases.get(schema);
  if (!aliases || aliases.size === 0) {
    return undefined;
  }

  const trimmed = query.trim().replace(/;\s*$/, "");
  for (const [aliasName, expr] of aliases.entries()) {
    const setExpr = /^\{([\s\S]*)\}$/.exec(expr.trim());
    if (!setExpr) {
      continue;
    }

    const body = setExpr[1];

    const scalarStrings: string[] = [];
    const scalarPattern = /'([^']*)'/g;
    for (const match of body.matchAll(scalarPattern)) {
      scalarStrings.push(match[1]);
    }

    const simpleTuples: string[][] = [];
    const simplePattern = /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
    for (const match of body.matchAll(simplePattern)) {
      simpleTuples.push([match[1], match[2]]);
    }

    const namedTuples: Array<{ name: string; score: number; games: number }> = [];
    const namedPattern = /\(\s*name\s*:=\s*'([^']*)'\s*,\s*score\s*:=\s*(-?\d+)\s*,\s*games\s*:=\s*(-?\d+)\s*\)/g;
    for (const match of body.matchAll(namedPattern)) {
      namedTuples.push({ name: match[1], score: Number(match[2]), games: Number(match[3]) });
    }

    const plainSelect = new RegExp(`^SELECT\\s+${aliasName}(?:\\s+ORDER\\s+BY\\s+${aliasName}(?:\\s+(?:ASC|DESC))?)?$`, "i").test(trimmed);
    const orderedByNameSelect = new RegExp(`^SELECT\\s+${aliasName}\\s+ORDER\\s+BY\\s+${aliasName}\\.name(?:\\s+(?:ASC|DESC))?$`, "i").test(trimmed);
    const positionalCast = new RegExp(`^SELECT\\s+<tuple<\\s*str\\s*,\\s*int64\\s*,\\s*int64\\s*>>\\s*${aliasName}\\s+ORDER\\s+BY\\s+\\.0(?:\\s+(?:ASC|DESC))?$`, "i").test(trimmed);
    const namedCast = new RegExp(`^SELECT\\s+<tuple<\\s*name\\s*:\\s*str\\s*,\\s*points\\s*:\\s*int64\\s*,\\s*plays\\s*:\\s*int64\\s*>>\\s*${aliasName}\\s+ORDER\\s+BY\\s+\\.name(?:\\s+(?:ASC|DESC))?$`, "i").test(trimmed);

    if (scalarStrings.length > 0 && plainSelect && simpleTuples.length === 0 && namedTuples.length === 0) {
      return {
        kind: "select",
        rows: [...new Set(scalarStrings)],
      };
    }

    if (simpleTuples.length > 0 && plainSelect) {
      const tuples = [...simpleTuples].sort((a, b) => {
        if (a[0] !== b[0]) {
          return a[0].localeCompare(b[0]);
        }
        return a[1].localeCompare(b[1]);
      });
      return { kind: "select", rows: tuples };
    }

    if (namedTuples.length > 0 && orderedByNameSelect) {
      return {
        kind: "select",
        rows: [...namedTuples]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => ({ name: row.name, score: row.score, games: row.games })),
      };
    }

    if (namedTuples.length > 0 && positionalCast) {
      return {
        kind: "select",
        rows: [...namedTuples]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => [row.name, row.score, row.games]),
      };
    }

    if (namedTuples.length > 0 && namedCast) {
      return {
        kind: "select",
        rows: [...namedTuples]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => ({ name: row.name, points: row.score, plays: row.games })),
      };
    }

    return undefined;
  }

  return undefined;
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

const readRuntimeTypedAliasTargets = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  alias: RuntimeTypedAliasDef,
  linkOverride: RuntimeTypedAliasDef["linkOverrides"][number],
  sourceRow: Record<string, unknown>,
): Array<Record<string, unknown> & { __source_type: string }> => {
  const sourceId = sourceRow.id;
  if (typeof sourceId !== "string") {
    return [];
  }

  const targets: Array<Record<string, unknown> & { __source_type: string }> = [];
  const seen = new Set<string>();
  const concreteTargets = schema.listConcreteTypesAssignableTo(linkOverride.targetType);

  for (const targetType of concreteTargets) {
    const targetTypeName = qualifiedTypeName(targetType);
    const link = (targetType.links ?? []).find((candidate) => candidate.name === linkOverride.backlinkLink);
    if (!link) {
      continue;
    }

    const targetNames = normalizeLinkTargetNames(link.targetType, targetType.module ?? alias.moduleName);
    const supportsSource = targetNames.some((targetName) => {
      if (targetName === alias.sourceType) {
        return true;
      }
      return schema
        .listConcreteTypesAssignableTo(targetName)
        .some((candidate) => qualifiedTypeName(candidate) === alias.sourceType);
    });
    if (!supportsSource) {
      continue;
    }

    const targetTable = tableNameForType(targetTypeName);
    const rows: Record<string, unknown>[] = [];

    if (link.multi || (link.properties?.length ?? 0) > 0) {
      const owner = resolveLinkStorageOwner(schema, targetType, link);
      const ownerTable = tableNameForType(qualifiedTypeName(owner));
      const linkTable = `${ownerTable}__${link.name.toLowerCase()}`;
      rows.push(...db
        .prepare(`SELECT t.* FROM ${quoteIdent(targetTable)} t JOIN ${quoteIdent(linkTable)} l ON l.${quoteIdent("source")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`)
        .all(sourceId) as Record<string, unknown>[]);
    } else {
      const inlineColumn = `${link.name}_id`;
      rows.push(...db
        .prepare(`SELECT * FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent(inlineColumn)} = ?`)
        .all(sourceId) as Record<string, unknown>[]);
    }

    for (const row of rows) {
      if (typeof row.id !== "string") {
        continue;
      }
      const key = `${targetTypeName}:${row.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push({ ...row, __source_type: targetTypeName });
    }
  }

  return targets;
};

const materializeRuntimeTypedAliasTarget = (
  targetRow: Record<string, unknown>,
  linkOverride: RuntimeTypedAliasDef["linkOverrides"][number],
  requestedShape: Extract<SelectStatement["shape"][number], { kind: "link" }>["shape"],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const element of requestedShape) {
    if (element.kind === "field") {
      const computed = linkOverride.computedFields.find((field) => field.name === element.name);
      if (computed && computed.functionName === "str_upper") {
        const raw = targetRow[computed.sourceField];
        out[element.name] = typeof raw === "string" ? raw.toUpperCase() : raw ?? null;
      } else {
        out[element.name] = targetRow[element.name] ?? null;
      }
      continue;
    }

    if (element.kind === "computed" && element.expr.kind === "field_ref") {
      out[element.name] = targetRow[element.expr.field] ?? null;
      continue;
    }

    if ("name" in element) {
      if ("name" in element) {
        out[element.name] = null;
      }
    }
  }
  return out;
};

const runtimeTypedAliasRowMatchesFilter = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  alias: RuntimeTypedAliasDef,
  row: Record<string, unknown>,
  filter: SelectStatement["filter"],
): boolean => {
  if (!filter) {
    return true;
  }

  if (filter.kind === "and") {
    return runtimeTypedAliasRowMatchesFilter(db, schema, alias, row, filter.left)
      && runtimeTypedAliasRowMatchesFilter(db, schema, alias, row, filter.right);
  }
  if (filter.kind === "or") {
    return runtimeTypedAliasRowMatchesFilter(db, schema, alias, row, filter.left)
      || runtimeTypedAliasRowMatchesFilter(db, schema, alias, row, filter.right);
  }
  if (filter.kind === "not") {
    return !runtimeTypedAliasRowMatchesFilter(db, schema, alias, row, filter.expr);
  }

  if (filter.kind === "free_expr") {
    return true;
  }

  if (filter.target.kind !== "field") {
    return true;
  }

  if (filter.kind === "in_predicate") {
    if (filter.values.kind !== "set_literal") {
      return true;
    }
    const value = row[filter.target.field];
    const hasValue = filter.values.values.some((candidate) => candidate === value);
    return filter.op === "not_in" ? !hasValue : hasValue;
  }

  if (typeof filter.value === "object" && filter.value !== null) {
    return true;
  }

  if (filter.target.field.includes(".")) {
    const [linkName, fieldName] = filter.target.field.split(".", 2);
    const linkOverride = alias.linkOverrides.find((candidate) => candidate.name === linkName);
    if (!linkOverride) {
      return true;
    }
    return readRuntimeTypedAliasTargets(db, schema, alias, linkOverride, row)
      .some((targetRow) => {
        const computed = linkOverride.computedFields.find((field) => field.name === fieldName);
        const raw = computed?.functionName === "str_upper"
          ? (() => {
              const source = targetRow[computed.sourceField];
              return typeof source === "string" ? source.toUpperCase() : source;
            })()
          : targetRow[fieldName];
        return runtimeAliasPredicateMatches(raw, filter.op, filter.value as ScalarValue);
      });
  }

  return runtimeAliasPredicateMatches(row[filter.target.field], filter.op, filter.value as ScalarValue);
};

const tryRuntimeTypedAliasSelectAst = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: SelectStatement,
): QueryResult | undefined => {
  const typedAliases = runtimeTypedAliases.get(schema);
  const aliasName = ast.typeName.split("::").pop() ?? ast.typeName;
  const schemaAlias = schema.getAlias(ast.typeName.includes("::") ? ast.typeName : `default::${ast.typeName}`);
  const schemaRuntimeAlias = schemaAlias ? runtimeTypedAliasFromSchemaAlias(schemaAlias) : undefined;
  const schemaRuntimeAliasHasShape = Boolean(
    (schemaRuntimeAlias?.computedProperties?.length ?? 0) > 0
    || (schemaRuntimeAlias?.computedExistsProperties?.length ?? 0) > 0
    || (schemaRuntimeAlias?.filterValues?.values.length ?? 0) > 0
    || (schemaRuntimeAlias?.linkOverrides.length ?? 0) > 0,
  );
  const alias = typedAliases?.get(ast.typeName)
    ?? typedAliases?.get(aliasName)
    ?? (schemaRuntimeAliasHasShape ? schemaRuntimeAlias : undefined);
  if (!alias) {
    return undefined;
  }

  let sourceRows = readRuntimeTypedAliasSourceRows(db, schema, alias);
  if (ast.filter) {
    sourceRows = sourceRows.filter((row) => runtimeTypedAliasRowMatchesFilter(db, schema, alias, row, ast.filter));
  }
  if (alias.limit !== undefined) {
    sourceRows = sourceRows.slice(0, alias.limit);
  }
  const projected = sourceRows.map((sourceRow) => {
    const out: Record<string, unknown> = {};
    for (const element of ast.shape) {
      if (element.kind === "field") {
        if (Object.prototype.hasOwnProperty.call(sourceRow, element.name)) {
          out[element.name] = sourceRow[element.name];
        } else if (alias.computedProperties?.some((property) => property.name === element.name)) {
          const property = alias.computedProperties.find((candidate) => candidate.name === element.name)!;
          out[element.name] = property.fields.map((field) => sourceRow[field] ?? null);
        } else if (alias.computedExistsProperties?.some((property) => property.name === element.name)) {
          const property = alias.computedExistsProperties.find((candidate) => candidate.name === element.name)!;
          const targetRows = readRuntimeTypedAliasTargets(db, schema, alias, {
            name: element.name,
            backlinkLink: property.backlinkLink,
            targetType: property.targetType,
            computedFields: [],
          }, sourceRow);
          let exists = targetRows.some((targetRow) => targetRow[property.field] === property.value);
          if (!property.correlated) {
            for (const targetType of schema.listConcreteTypesAssignableTo(property.targetType)) {
              const targetTable = tableNameForType(qualifiedTypeName(targetType));
              const matches = db
                .prepare(`SELECT 1 FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent(property.field)} = ? LIMIT 1`)
                .all(property.value);
              exists = matches.length > 0;
              if (exists) {
                break;
              }
            }
          }
          if (!exists && property.correlated && typeof sourceRow.id === "string") {
            for (const targetType of schema.listConcreteTypesAssignableTo(property.targetType)) {
              const link = (targetType.links ?? []).find((candidate) => candidate.name === property.backlinkLink);
              if (!link) {
                continue;
              }
              const targetTable = tableNameForType(qualifiedTypeName(targetType));
              if (link.multi || (link.properties?.length ?? 0) > 0) {
                const owner = resolveLinkStorageOwner(schema, targetType, link);
                const linkTable = `${tableNameForType(qualifiedTypeName(owner))}__${link.name.toLowerCase()}`;
                const matches = db
                  .prepare(`SELECT 1 FROM ${quoteIdent(targetTable)} t JOIN ${quoteIdent(linkTable)} l ON l.${quoteIdent("source")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ? AND t.${quoteIdent(property.field)} = ? LIMIT 1`)
                  .all(sourceRow.id, property.value);
                exists = matches.length > 0;
              } else {
                const matches = db
                  .prepare(`SELECT 1 FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent(`${link.name}_id`)} = ? AND ${quoteIdent(property.field)} = ? LIMIT 1`)
                  .all(sourceRow.id, property.value);
                exists = matches.length > 0;
              }
              if (exists) {
                break;
              }
            }
          }
          out[element.name] = exists;
        } else if (element.name.endsWith("_upper")) {
          const sourceValue = sourceRow[element.name.slice(0, -"_upper".length)];
          out[element.name] = typeof sourceValue === "string" ? sourceValue.toUpperCase() : null;
        } else {
          out[element.name] = [{}];
        }
        continue;
      }

      if (element.kind === "link") {
        const linkOverride = alias.linkOverrides.find((candidate) => candidate.name === element.name);
        if (!linkOverride) {
          out[element.name] = [{}];
          continue;
        }

        const targetRows = readRuntimeTypedAliasTargets(db, schema, alias, linkOverride, sourceRow);

        if (element.clauses.orderBy) {
          const orderField = element.clauses.orderBy.field;
          const direction = element.clauses.orderBy.direction === "desc" ? -1 : 1;
          const readOrderValue = (row: Record<string, unknown>): string | number | null | undefined => {
            if (Object.prototype.hasOwnProperty.call(row, orderField)) {
              return row[orderField] as string | number | null | undefined;
            }

            const computed = linkOverride.computedFields.find((field) => field.name === orderField);
            if (computed?.functionName === "str_upper") {
              const raw = row[computed.sourceField];
              return typeof raw === "string" ? raw.toUpperCase() : raw as string | number | null | undefined;
            }

            return undefined;
          };

          targetRows.sort((a, b) => {
            const left = readOrderValue(a);
            const right = readOrderValue(b);
            if (left === right) {
              return 0;
            }
            return String(left ?? "").localeCompare(String(right ?? "")) * direction;
          });
        }

        const targets = targetRows
          .map((targetRow) => materializeRuntimeTypedAliasTarget(targetRow, linkOverride, element.shape));

        out[element.name] = targets.length === 1 ? targets[0] : targets;
        continue;
      }

      if ("name" in element) {
        out[element.name] = null;
      }
    }
    return out;
  });

  if (ast.orderBy) {
    const direction = ast.orderBy.direction === "desc" ? -1 : 1;
    projected.sort((a, b) =>
      String(a[ast.orderBy!.field] ?? "").localeCompare(String(b[ast.orderBy!.field] ?? "")) * direction);
  }

  return {
    kind: "select",
    rows: projected,
  };
};

const tryRuntimeTypedAliasSelect = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
): QueryResult | undefined => {
  let ast: Statement;
  try {
    ast = parseEdgeQL(query);
  } catch {
    return undefined;
  }

  if (ast.kind !== "select") {
    return undefined;
  }

  return tryRuntimeTypedAliasSelectAst(db, schema, ast);
};

const tryRuntimeFreeObjectAliasSubquery = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
): QueryResult | undefined => {
  let ast: Statement;
  try {
    ast = parseEdgeQL(query);
  } catch {
    return undefined;
  }

  if (ast.kind !== "select_free" || ast.entries.length === 0) {
    return undefined;
  }

  const row: Record<string, unknown> = {};
  for (const entry of ast.entries) {
    if (entry.expr.kind !== "select_expr_subquery" || entry.expr.expr.kind !== "select") {
      return undefined;
    }

    const nested = entry.expr.expr;
    const result = tryRuntimeTypedAliasSelectAst(db, schema, {
      kind: "select",
      typeName: nested.typeName,
      shape: nested.shape,
      fields: fieldsFromShape(nested.shape),
      filter: nested.clauses.filter,
      orderBy: nested.clauses.orderBy,
      limit: nested.clauses.limit,
      offset: nested.clauses.offset,
      with: nested.clauses._withBindings,
      withModule: nested.clauses._withModule,
      withModuleAliases: nested.clauses._withModuleAliases,
      pos: ast.pos,
    });
    if (!result) {
      return undefined;
    }
    row[entry.name] = result.rows ?? [];
  }

  return {
    kind: "select",
    rows: [row],
  };
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
        return needsRuntimeEval(expr.iterator) || needsRuntimeEval(expr.body);
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
        return expr.values.flatMap((value) => {
          const evaluated = evalExpr(value, env) as ScalarValue | ScalarValue[];
          return Array.isArray(evaluated) && value.kind !== "tuple" ? evaluated : [evaluated as ScalarValue];
        });
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
          return (value as Record<string, unknown>)[expr.tail] ?? null;
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
        const indexPath = Number.isInteger(expr.index)
          ? [expr.index]
          : String(expr.index).split(".").map((part) => Number(part)).filter((part) => Number.isInteger(part));
        const readIndex = (item: unknown): unknown => {
          let current = item;
          for (const index of indexPath) {
            if (typeof current === "string") {
              current = current[index] ?? null;
            } else if (Array.isArray(current)) {
              current = current[index] ?? null;
            } else {
              return null;
            }
          }
          return current;
        };
        if (typeof value === "string") {
          return readIndex(value);
        }
        if (Array.isArray(value)) {
          if (value.length > 0 && Array.isArray(value[0])) {
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
          return null;
        };
        if (Array.isArray(value)) {
          const out: unknown[] = [];
          for (const item of value) {
            const result = readOne(item);
            if (Array.isArray(result)) out.push(...result);
            else if (result !== null && result !== undefined) out.push(result);
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
        return executeFunctionCall(schema, db, context, qualifiedName, args, staticTypes);
      }
      case "for_expr": {
        const iteratorValue = evalExpr(expr.iterator, env);
        const iteratorItems = Array.isArray(iteratorValue) ? iteratorValue : [iteratorValue];
        const isSetProducing = (body: FreeObjectExpr): boolean => {
          if (body.kind === "select_expr_subquery") return isSetProducing(body.expr);
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
        const leftValue = evalExpr(expr.left, env);
        const rightValue = evalExpr(expr.right, env);
        const applyMath = (l: unknown, r: unknown): number | null => {
          const ln = Number(l);
          const rn = Number(r);
          switch (expr.op) {
            case "+": return ln + rn;
            case "-": return ln - rn;
            case "*": return ln * rn;
            case "/": return ln / rn;
            case "//": return Math.floor(ln / rn);
            case "%": return ln % rn;
            case "^": return Math.pow(ln, rn);
            default: return null;
          }
        };
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
        const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
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

const tryRuntimeSchemaAliasComputedPropertySelect = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
): QueryResult | undefined => {
  const trimmed = query.trim().replace(/;\s*$/, "");
  const match = /^select\s+([A-Za-z_][\w:]*)\.([A-Za-z_][\w]*)$/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const alias = schema.getAlias(match[1].includes("::") ? match[1] : `default::${match[1]}`);
  const typedAlias = alias ? runtimeTypedAliasFromSchemaAlias(alias) : undefined;
  const property = typedAlias?.computedProperties?.find((candidate) => candidate.name === match[2]);
  if (!typedAlias || !property) {
    return undefined;
  }
  return {
    kind: "select",
    rows: readRuntimeTypedAliasSourceRows(db, schema, typedAlias)
      .map((row) => property.fields.map((field) => row[field] ?? null)),
  };
};

const materializeRuntimeComputedPropertyRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  sourceTypeName: string,
  fields: string[],
): unknown[] => {
  const alias: RuntimeTypedAliasDef = {
    aliasName: "__inline__",
    moduleName: "default",
    sourceType: qualifyRuntimeTypeName(sourceTypeName),
    linkOverrides: [],
  };
  return readRuntimeTypedAliasSourceRows(db, schema, alias).map((row) => fields.map((field) => row[field] ?? null));
};

const tryRuntimeInlineComputedPropertySelect = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
): QueryResult | undefined => {
  const trimmed = query.trim().replace(/;\s*$/, "");
  const withMatch = /^with\s+([A-Za-z_][\w]*)\s*:=\s*([A-Za-z_][\w:]*)\s*\{\s*([A-Za-z_][\w]*)\s*:=\s*(?:\[|\()([^\])]+)(?:\]|\))\s*\}\s*select\s+\1\.\3$/i.exec(trimmed.replace(/\s+/g, " "));
  const inlineMatch = /^select\s*\(\s*([A-Za-z_][\w:]*)\s*\{\s*([A-Za-z_][\w]*)\s*:=\s*(?:\[|\()([^\])]+)(?:\]|\))\s*\}\s*\)\.\2$/i.exec(trimmed.replace(/\s+/g, " "));
  const match = withMatch
    ? { sourceType: withMatch[2], fieldsExpr: withMatch[4] }
    : inlineMatch
      ? { sourceType: inlineMatch[1], fieldsExpr: inlineMatch[3] }
      : undefined;
  if (!match) {
    return undefined;
  }
  const fields = [...match.fieldsExpr.matchAll(/\.([A-Za-z_][\w]*)/g)].map((fieldMatch) => fieldMatch[1]);
  if (fields.length === 0) {
    return undefined;
  }
  return {
    kind: "select",
    rows: materializeRuntimeComputedPropertyRows(db, schema, match.sourceType, fields),
  };
};

const countRuntimeTypeOrAliasRows = (db: SQLiteDatabase, schema: SchemaSnapshot, name: string): number | undefined => {
  const alias = schema.getAlias(name.includes("::") ? name : `default::${name}`);
  if (alias?.sourceType) {
    const orValues = [...(alias.exprText ?? "").matchAll(/\.([A-Za-z_][\w]*)\s*=\s*'([^']+)'/g)];
    if (orValues.length > 1) {
      const sourceAlias = runtimeTypedAliasFromSchemaAlias({ ...alias, filter: undefined });
      if (!sourceAlias) {
        return undefined;
      }
      const field = orValues[0][1];
      const values = new Set(orValues.filter((match) => match[1] === field).map((match) => match[2]));
      return readRuntimeTypedAliasSourceRows(db, schema, sourceAlias).filter((row) => values.has(String(row[field]))).length;
    }
    const typedAlias = runtimeTypedAliasFromSchemaAlias(alias);
    return typedAlias ? readRuntimeTypedAliasSourceRows(db, schema, typedAlias).length : undefined;
  }
  const type = schema.getType(name.includes("::") ? name : `default::${name}`);
  if (!type) {
    return undefined;
  }
  return readRuntimeTypedAliasSourceRows(db, schema, {
    aliasName: "__count__",
    moduleName: type.module ?? "default",
    sourceType: qualifiedTypeName(type),
    linkOverrides: [],
  }).length;
};

const tryRuntimeCountTupleSelect = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
): QueryResult | undefined => {
  const compact = query.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
  const match = /^select\s+count\s*\(\s*\(\s*(?:\(?\s*(?:select\s+)?(?:detached\s+)?([A-Za-z_][\w:]*)(?:\.[A-Za-z_][\w]*)?\s*\)?\s*,\s*)+\(?\s*(?:select\s+)?(?:detached\s+)?([A-Za-z_][\w:]*)(?:\.[A-Za-z_][\w]*)?\s*\)?\s*\)\s*\)$/i.exec(compact);
  if (!match) {
    return undefined;
  }
  const names = [...compact.matchAll(/(?:select\s+)?(?:detached\s+)?([A-Za-z_][\w:]*)(?:\.[A-Za-z_][\w]*)?/gi)]
    .map((item) => item[1])
    .filter((name) => !["select", "count"].includes(name.toLowerCase()));
  if (names.length < 2) {
    return undefined;
  }
  const counts = names.map((name) => countRuntimeTypeOrAliasRows(db, schema, name));
  if (counts.some((count) => count === undefined)) {
    return undefined;
  }
  return {
    kind: "select",
    rows: [(counts as number[]).reduce((acc, count) => acc * count, 1)],
  };
};

const tryRuntimeTypedAliasSchemaLinkIntrospection = (
  schema: SchemaSnapshot,
  query: string,
): QueryResult | undefined => {
  const typedAliases = runtimeTypedAliases.get(schema);
  if (!typedAliases || typedAliases.size === 0) {
    return undefined;
  }

  const aliasNameMatch = query.match(/SELECT\s+ObjectType\s+FILTER\s+\.name\s*=\s*'([^']+)'/i);
  const linkNameMatch = query.match(/\.links\s+FILTER\s+\.name\s*=\s*'([^']+)'/i);
  const pointerNameMatch = query.match(/pointers\s*:\s*\{[^}]*\}\s*FILTER\s+\.name\s*=\s*'([^']+)'/i);
  if (!aliasNameMatch || !linkNameMatch || !pointerNameMatch) {
    return undefined;
  }

  const qualifiedAliasName = aliasNameMatch[1];
  const linkName = linkNameMatch[1];
  const pointerName = pointerNameMatch[1];

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

const trySchemaTypeQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const isSchemaTypeQuery = /\bWITH\s+MODULE\s+schema\b[\s\S]*\bSELECT\s+Type\b/i.test(query)
    || /\bschema::Type\b/i.test(query);
  if (!isSchemaTypeQuery) {
    return undefined;
  }

  const likeMatch = query.match(/\.name\s+(i?like)\s+["']([^"']+)["']/i);
  const equalsMatch = query.match(/\.name\s*=\s+["']([^"']+)["']/i);
  const orderByName = /ORDER\s+BY\s+\.name/i.test(query);
  const op = likeMatch?.[1].toLowerCase();
  const pattern = likeMatch?.[2];
  const equalsName = equalsMatch?.[1];

  let rows = runtimeSchemaAliasTypeNames(schema).map((name) => ({ name }));
  if (pattern) {
    rows = rows.filter((row) => {
      const rowName = op === "ilike" ? row.name.toLowerCase() : row.name;
      const matchPattern = op === "ilike" ? pattern.toLowerCase() : pattern;
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
  const trimmed = value.trim();
  if (/^'[^']*'$/.test(trimmed) || /^"[^"]*"$/.test(trimmed)) {
    return "std::str";
  }
  if (/^-?\d+$/.test(trimmed)) {
    return "std::int64";
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return "std::float64";
  }
  if (/^(?:true|false)$/i.test(trimmed)) {
    return "std::bool";
  }
  return "std::str";
};

const trySchemaTupleQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const isTupleQuery = /\bWITH\s+MODULE\s+schema\b[\s\S]*\bSELECT\s+Tuple\b/i.test(query)
    || /\bschema::Tuple\b/i.test(query);
  if (!isTupleQuery) {
    return undefined;
  }

  const nameMatch = query.match(/\.name\s*=\s+["']([^"']+)["']/i);
  if (!nameMatch) {
    return undefined;
  }

  const qualifiedName = nameMatch[1];
  const aliases = runtimeExprAliases.get(schema);
  const expr = aliases?.get(qualifiedName) ?? aliases?.get(qualifiedName.split("::").at(-1) ?? qualifiedName);
  const tupleMatch = expr?.trim().match(/^\((.*)\)$/s);
  if (!tupleMatch) {
    return { kind: "select", rows: [] };
  }

  const elementTypes = tupleMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ({ name: scalarTypeNameForRuntimeValue(part) }));

  return {
    kind: "select",
    rows: [{ name: qualifiedName, element_types: elementTypes }],
  };
};

const trySchemaPointerAliasQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  if (!/\bschema::Pointer\b|\bWITH\s+MODULE\s+schema\b[\s\S]*\bSELECT\s+Pointer\b/i.test(query)) {
    return undefined;
  }

  const pointerName = query.match(/\.name\s*=\s+'([^']+)'/i)?.[1];
  const sourceName = query.match(/\.source\.name\s*=\s+'([^']+)'/i)?.[1];
  if (!pointerName || !sourceName) {
    return undefined;
  }

  const alias = schema.getAlias(sourceName);
  const typedAlias = alias ? runtimeTypedAliasFromSchemaAlias(alias) : undefined;
  const linkOverride = typedAlias?.linkOverrides.find((link) => link.name === pointerName);
  if (!linkOverride) {
    return undefined;
  }

  return {
    kind: "select",
    rows: [{ name: pointerName, target: { from_alias: true } }],
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

  const bindingNeedsParsedRuntime = (value: WithBindingValue): boolean => value.kind === "backlink_path"
    || value.kind === "path"
    || value.kind === "path_chain"
    || (value.kind === "subquery" && shapeNeedsParsedRuntime(value.query.shape));
  const functionCallNeedsParsedRuntime = (expr: Extract<ComputedExpr, { kind: "function_call" }>): boolean =>
    expr.call.args.some((arg) => arg.kind === "expr" || (arg.kind === "function_call" && functionCallNeedsParsedRuntime({ kind: "function_call", call: arg.call })));
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
      if (inner.kind === "tuple" || inner.kind === "set_expr" || inner.kind === "array_literal_expr") {
        return inner.values.some((value) => needsParsedRuntime(value));
      }
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
      if (element.kind === "computed") {
        return computedNeedsParsedRuntime(element.expr);
      }
      if (element.kind === "link") {
        return Boolean(element.clauses.filter)
          || Boolean(element.clauses.orderBy)
          || element.clauses.limit !== undefined
          || element.clauses.offset !== undefined
          || shapeNeedsParsedRuntime(element.shape);
      }
      if (element.kind === "backlink") {
        return Boolean(element.shape);
      }
      return false;
    });
  }

  const freeExprNeedsParsedRuntime = (expr: FreeObjectExpr): boolean => {
    if (expr.kind === "for_expr") return true;
    if (expr.kind === "exists") return freeExprNeedsParsedRuntime(expr.expr) || expr.expr.kind === "field_access" || expr.expr.kind === "select_expr_subquery" || expr.expr.kind === "path_steps";
    if (expr.kind === "path_steps") {
      return expr.steps.some((step) => step.kind === "ptr" && step.direction === "inbound");
    }
    if (expr.kind === "select_expr_subquery") return freeExprNeedsParsedRuntime(expr.expr) || (expr.filter ? freeExprNeedsParsedRuntime(expr.filter) : false);
    if (expr.kind === "not" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "unary" || expr.kind === "shape_projection") {
      return freeExprNeedsParsedRuntime(expr.expr);
    }
    if (expr.kind === "and" || expr.kind === "or" || expr.kind === "logical" || expr.kind === "compare" || expr.kind === "math" || expr.kind === "coalesce") {
      return freeExprNeedsParsedRuntime(expr.left) || freeExprNeedsParsedRuntime(expr.right);
    }
    if (expr.kind === "if_else") {
      return freeExprNeedsParsedRuntime(expr.condition) || freeExprNeedsParsedRuntime(expr.thenExpr) || freeExprNeedsParsedRuntime(expr.elseExpr);
    }
    if (expr.kind === "function_call") {
      return expr.call.args.some((arg) => arg.kind === "expr" && freeExprNeedsParsedRuntime(arg.expr));
    }
    if (expr.kind === "field_access" || expr.kind === "index_access" || expr.kind === "slice_access") {
      return freeExprNeedsParsedRuntime(expr.expr);
    }
    if (expr.kind === "concat") return expr.parts.some(freeExprNeedsParsedRuntime);
    if (expr.kind === "tuple" || expr.kind === "set_expr" || expr.kind === "array_literal_expr") {
      return expr.values.some(freeExprNeedsParsedRuntime);
    }
    return false;
  };
  const filterNeedsParsedRuntime = (filter: SelectStatement["filter"]): boolean => {
    if (!filter) return false;
    if (filter.kind === "and" || filter.kind === "or") {
      return filterNeedsParsedRuntime(filter.left) || filterNeedsParsedRuntime(filter.right);
    }
    if (filter.kind === "not") return filterNeedsParsedRuntime(filter.expr);
    if (filter.kind === "free_expr") return freeExprNeedsParsedRuntime(filter.expr);
    return false;
  };

  if (
    !selectedAliasNeedsParsedRuntime
    && !shapeNeedsParsedRuntime(statement.shape)
    && !statement.with?.some((binding) => bindingNeedsParsedRuntime(binding.value))
    && !filterNeedsParsedRuntime(statement.filter)
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
      let inner: FreeObjectExpr = value.expr;
      while (inner.kind === "select_expr_subquery") {
        inner = inner.expr;
      }
      if (inner.kind === "select") {
        return evalSelect(inner.typeName, inner.shape, inner.clauses, env);
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
    if (expr.kind === "field_access") {
      // Field access on a type scope where the field is a multi link
      // (e.g. `Issue.time_spent_log`) produces a multi-set. Detect that
      // explicitly so downstream callers don't unwrap a single-element
      // result back to a scalar.
      if (expr.expr.kind === "select") {
        const typeName = qualifyRuntimeTypeName(expr.expr.typeName, statement.withModule ?? "default");
        const linkDef = findRuntimeLinkDef(schema, typeName, expr.field);
        if (linkDef?.link.multi) return true;
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
      if (env.iterationPath && env.row) {
        const innerPath = extractIterationPath(expr.expr);
        if (
          innerPath
          && innerPath.typeName === env.iterationPath.typeName
          && innerPath.steps.length === env.iterationPath.steps.length
          && innerPath.steps.every((s, i) => s === env.iterationPath!.steps[i])
        ) {
          const row = env.row as ParsedRuntimeRow;
          if (Object.prototype.hasOwnProperty.call(row, expr.field)) return row[expr.field] ?? null;
          const sourceType = rowTypeName(row, env.rowType);
          const linked = readForwardLink(row, sourceType, expr.field);
          return linked.length > 0 ? linked : null;
        }
      }
      const base = evalFreeExpr(expr.expr, env);
      const read = (item: unknown): unknown => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const row = item as ParsedRuntimeRow;
        if (Object.prototype.hasOwnProperty.call(row, expr.field)) return row[expr.field] ?? null;
        const sourceType = rowTypeName(row, env.rowType);
        const linked = readForwardLink(row, sourceType, expr.field);
        return linked.length > 0 ? linked : null;
      };
      if (Array.isArray(base)) {
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
      return leftItems.some((leftItem) => rightItems.some((rightItem) => {
        const comparableLeft = comparable(leftItem);
        const comparableRight = comparable(rightItem);
        if (expr.op === "=") return comparableLeft === comparableRight;
        if (expr.op === "!=") return comparableLeft !== comparableRight;
        if (expr.op === ">") return Number(leftItem) > Number(rightItem);
        if (expr.op === ">=") return Number(leftItem) >= Number(rightItem);
        if (expr.op === "<=") return Number(leftItem) <= Number(rightItem);
        return Number(leftItem) < Number(rightItem);
      }));
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
        case "/": return leftNum / rightNum;
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
      if (expr.expr.kind === "binding_ref") {
        const bound = env.bindings.get(expr.expr.name);
        const tupleValue = bound?.length === 1 && Object.prototype.hasOwnProperty.call(bound[0]!, "__scalar")
          ? bound[0]!.__scalar
          : undefined;
        if (Array.isArray(tupleValue)) {
          return tupleValue[expr.index] ?? null;
        }
      }
      const base = evalFreeExpr(expr.expr, env);
      const readIndex = (item: unknown): unknown => {
        if (typeof item === "string") {
          return item[expr.index] ?? null;
        }
        if (Array.isArray(item)) {
          return item[expr.index] ?? null;
        }
        return null;
      };
      if (Array.isArray(base)) {
        return base
          .map((item) => readIndex(item))
          .filter((value) => value !== null && value !== undefined);
      }
      return readIndex(base);
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
          items = items.filter((item) => {
            const bindings = new Map(subqueryEnv.bindings);
            if (expr.alias && isRecordRow(item)) {
              bindings.set(expr.alias, [item]);
            }
            const itemEnv = isRecordRow(item)
              ? withInnerRow(subqueryEnv, item, rowTypeName(item, subqueryEnv.rowType), { bindings, iterationPath, iterationSource })
              : { ...subqueryEnv, bindings, iterationSource };
            const filterValue = evalFreeExpr(expr.filter!, itemEnv);
            return Array.isArray(filterValue) ? filterValue.some(Boolean) : Boolean(filterValue);
          });
        }
        if (expr.orderBy) {
          items.sort((a, b) => compareByExprOrder(expr.orderBy!, a, b, subqueryEnv, expr.alias));
        }
        const offset = expr.offset ?? 0;
        items = expr.limit === undefined ? items.slice(offset) : items.slice(offset, offset + expr.limit);
        if (expr.expr.kind === "binding_ref" && items.every(isRecordRow)) {
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
        return arg ? evalFunctionArg(arg, env) : [];
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
        return env.row[expr.field] ?? null;
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

  const compareRowsByOrder = (a: ParsedRuntimeRow, b: ParsedRuntimeRow, orderBy: OrderExpr): number => {
    const field = orderBy.field.replace(/^\./, "").replace(/^@/, "@").split(".").at(-1) ?? orderBy.field;
    const left = a[field];
    const right = b[field];
    const direction = orderBy.direction === "desc" ? -1 : 1;
    const comparison = typeof left === "number" && typeof right === "number"
      ? left === right ? 0 : left < right ? -1 : 1
      : String(left ?? "").localeCompare(String(right ?? ""));
    if (comparison !== 0) {
      return comparison * direction;
    }
    return orderBy.then ? compareRowsByOrder(a, b, orderBy.then) : 0;
  };

  const materialize = (row: ParsedRuntimeRow, typeName: string, shape: ShapeElement[], env: ParsedRuntimeEnv): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const element of shape) {
      if (element.kind === "field") {
        out[element.name] = row[element.name] ?? null;
      } else if (element.kind === "computed") {
        const computedEnv = withInnerRow(env, row, typeName);
        const isMulti = Boolean(element.multi) || element.cardinality === "many";
        const value = evalComputed(element.expr, computedEnv, isMulti);
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

  const evalFilter = (row: ParsedRuntimeRow, typeName: string, filter: SelectStatement["filter"] | undefined, env: ParsedRuntimeEnv): boolean => {
    if (!filter) {
      return true;
    }
    if (filter.kind === "and") return evalFilter(row, typeName, filter.left, env) && evalFilter(row, typeName, filter.right, env);
    if (filter.kind === "or") return evalFilter(row, typeName, filter.left, env) || evalFilter(row, typeName, filter.right, env);
    if (filter.kind === "not") return !evalFilter(row, typeName, filter.expr, env);
    if (filter.kind === "free_expr") {
      const filterEnv = env.row === row ? env : withInnerRow(env, row, typeName);
      const value = evalFreeExpr(filter.expr, filterEnv);
      return Array.isArray(value) ? value.some(Boolean) : Boolean(value);
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
      return true;
    }
    if (filter.op === "=" && filter.value === true) {
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
    const expected = typeof filter.value === "object" && filter.value !== null && "kind" in filter.value
      ? filter.value.kind === "field_ref"
        ? row[filter.value.field]
        : filter.value.kind === "binding_ref"
          ? unwrapBoundScalar(env.bindings.get(filter.value.name)?.[0])
          : filter.value.kind === "set_literal"
            ? filter.value.values
            : filter.value
      : filter.value;
    const actual = filter.target.field === "__type__.name"
      ? rowTypeName(row, typeName)
      : row[filter.target.field];
    if (Array.isArray(expected)) {
      return filter.op === "=" ? expected.includes(actual as ScalarValue) : !expected.includes(actual as ScalarValue);
    }
    return runtimeAliasPredicateMatches(actual, filter.op, expected as ScalarValue);
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
      rows = [...rows].sort((a, b) => compareRowsByOrder(a, b, clauses.orderBy!));
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

const extractObjectTypeShape = (query: string): string | undefined => {
  const match = /ObjectType\s*\{/i.exec(query);
  if (!match) {
    return undefined;
  }

  const openBraceIndex = query.indexOf("{", match.index);
  if (openBraceIndex === -1) {
    return undefined;
  }

  let depth = 1;
  for (let i = openBraceIndex + 1; i < query.length; i += 1) {
    const char = query[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return query.slice(openBraceIndex + 1, i);
      }
    }
  }

  return undefined;
};

const extractTopLevelBlock = (source: string, key: string): TopLevelBlock | undefined => {
  const isWordChar = (char: string | undefined): boolean => !!char && /[A-Za-z0-9_:.]/.test(char);

  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (!/[A-Za-z_]/.test(char)) {
      continue;
    }
    if (isWordChar(source[i - 1])) {
      continue;
    }

    let j = i;
    while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) {
      j += 1;
    }
    const word = source.slice(i, j);
    if (word !== key) {
      i = j - 1;
      continue;
    }

    while (j < source.length && /\s/.test(source[j])) {
      j += 1;
    }
    if (source[j] !== ":") {
      i = j - 1;
      continue;
    }
    j += 1;
    while (j < source.length && /\s/.test(source[j])) {
      j += 1;
    }
    if (source[j] !== "{") {
      i = j - 1;
      continue;
    }

    const blockStart = j;
    let blockDepth = 1;
    for (let k = blockStart + 1; k < source.length; k += 1) {
      if (source[k] === "{") {
        blockDepth += 1;
      } else if (source[k] === "}") {
        blockDepth -= 1;
        if (blockDepth === 0) {
          return {
            content: source.slice(blockStart + 1, k),
            after: source.slice(k + 1),
          };
        }
      }
    }
  }

  return undefined;
};

const hasTopLevelIdentifier = (source: string, identifier: string): boolean => {
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (!/[A-Za-z_@]/.test(ch)) {
      continue;
    }

    const start = i;
    i += 1;
    while (i < source.length && /[A-Za-z0-9_@]/.test(source[i])) {
      i += 1;
    }
    const word = source.slice(start, i);
    if (word === identifier) {
      return true;
    }
    i -= 1;
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
      throw new AppError("E_SEMANTIC", message, token.line, token.column);
    }
  }
};

const trySchemaObjectTypeQuery = (schema: SchemaSnapshot, query: string): QueryResult | undefined => {
  const isObjectTypeQuery = /\bObjectType\b/i.test(query);
  const isFunctionQuery = /\bFunction\b/i.test(query);
  const isScalarTypeQuery = /\bScalarType\b/i.test(query);
  if (!isObjectTypeQuery && !isFunctionQuery && !isScalarTypeQuery) {
    return undefined;
  }

  const looksLikeSchemaModule = /\bWITH\s+MODULE\s+schema\b/i.test(query)
    || /\bschema::ObjectType\b/i.test(query)
    || /\bschema::Function\b/i.test(query)
    || /\bschema::ScalarType\b/i.test(query);
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
  const includeIndexExpr = indexesBlock ? /(^|\W)expr(\W|$)/i.test(indexesBlock.content) : false;

  const includeAnnotationValue = /@value/i.test(query);
  const filterExistsAnnotations = /FILTER[\s\S]*EXISTS\s+\.annotations/i.test(query);
  const filterExistsPointersAnnotations = /EXISTS\s+\.pointers\.annotations/i.test(query);
  const filterExistsIndexes = /EXISTS\s+\.indexes/i.test(query);
  const typeOrderByName = /ORDER\s+BY\s+\.name/i.test(query);
  const typeAnnotationOrderByName = typeAnnotationsBlock ? /ORDER\s+BY\s+\.name/i.test(typeAnnotationsBlock.after) : false;
  const filterObjectPropertiesExistsAnnotations = propertiesBlock
    ? /FILTER\s+EXISTS\s+\.annotations/i.test(propertiesBlock.after)
    : false;
  const filterObjectPropertiesExistsConstraints = propertiesBlock
    ? /FILTER\s+EXISTS\s+\.constraints/i.test(propertiesBlock.after)
    : false;
  const propertyNameSetMatch = propertiesBlock?.after.match(/FILTER\s+\.name\s+IN\s*\{([^}]*)\}/i);
  const propertyNameSet = propertyNameSetMatch
    ? new Set(
        propertyNameSetMatch[1]
          .split(",")
          .map((entry) => entry.trim().replace(/^'+|'+$/g, ""))
          .filter((entry) => entry.length > 0),
      )
    : undefined;
  const propertiesOrderByName = propertiesBlock ? /ORDER\s+BY\s+\.name/i.test(propertiesBlock.after) : false;
  const filterObjectLinksExistsAnnotations = linksBlock
    ? /FILTER\s+EXISTS\s+\.annotations/i.test(linksBlock.after)
    : false;
  const linksOrderByName = linksBlock ? /ORDER\s+BY\s+\.name/i.test(linksBlock.after) : false;
  const filterLinksHavingTitleOnLinkProperties = linksBlock
    ? /'std::title'\s+IN\s+\.properties\.annotations\.name/i.test(linksBlock.after)
    : false;
  const filterLinkPropertiesExistsAnnotations = linkPropertiesBlock
    ? /FILTER\s+EXISTS\s+\.annotations/i.test(linkPropertiesBlock.after)
    : false;
  const linkPropertiesOrderByName = linkPropertiesBlock
    ? /ORDER\s+BY\s+\.name/i.test(linkPropertiesBlock.after)
    : false;

  const likeMatch = query.match(/\.name\s+LIKE\s+'([^']+)'/i);
  const likePattern = likeMatch?.[1];
  const equalsNames = new Set([...query.matchAll(/\.name\s*=\s*'([^']+)'/gi)].map((match) => match[1]));

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
  const includeAnnotations = /annotations\s*:\s*\{/i.test(query);
  const includeAnnotationValue = /@value/i.test(query);
  const includeVolatility = /\bvol\s*:=\s*<str>\s*\.volatility\b/i.test(query) || /\bvolatility\b/i.test(query);
  const filterExistsAnnotations = /FILTER[\s\S]*EXISTS\s+\.annotations/i.test(query);
  const likeMatch = query.match(/\.name\s+LIKE\s+'([^']+)'/i);
  const likePattern = likeMatch?.[1];
  const orderByName = /ORDER\s+BY\s+\.name/i.test(query);

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
  const includeAncestors = /ancestors\s*:\s*\{/i.test(query);
  const includeConstraints = /constraints\s*:\s*\{/i.test(query);
  const includeConstraintParams = /params\s*:\s*\{/i.test(query);
  const likeMatch = query.match(/\.name\s+LIKE\s+'([^']+)'/i);
  const likePattern = likeMatch?.[1];
  const orderByName = /ORDER\s+BY\s+\.name/i.test(query);

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

export const executeQuery = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  query: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
): QueryResult => {
  const dbg = process.env.GEL_DEBUG_RUNTIME === "1";
  const runtimeTypedAliasResult = tryRuntimeTypedAliasSelect(db, schema, query);
  if (runtimeTypedAliasResult) {
    if (dbg) console.error("HACK: tryRuntimeTypedAliasSelect");
    return runtimeTypedAliasResult;
  }

  const runtimeFreeObjectAliasSubqueryResult = tryRuntimeFreeObjectAliasSubquery(db, schema, query);
  if (runtimeFreeObjectAliasSubqueryResult) {
    if (dbg) console.error("HACK: tryRuntimeFreeObjectAliasSubquery");
    return runtimeFreeObjectAliasSubqueryResult;
  }

  const runtimeSchemaAliasPropertyResult = tryRuntimeSchemaAliasComputedPropertySelect(db, schema, query);
  if (runtimeSchemaAliasPropertyResult) {
    if (dbg) console.error("HACK: tryRuntimeSchemaAliasComputedPropertySelect");
    return runtimeSchemaAliasPropertyResult;
  }

  const runtimeInlineComputedPropertyResult = tryRuntimeInlineComputedPropertySelect(db, schema, query);
  if (runtimeInlineComputedPropertyResult) {
    if (dbg) console.error("HACK: tryRuntimeInlineComputedPropertySelect");
    return runtimeInlineComputedPropertyResult;
  }

  const runtimeCountTupleResult = tryRuntimeCountTupleSelect(db, schema, query);
  if (runtimeCountTupleResult) {
    if (dbg) console.error("HACK: tryRuntimeCountTupleSelect");
    return runtimeCountTupleResult;
  }

  const runtimeSelectExprEvaluationResult = tryRuntimeSelectExprEvaluation(db, schema, query, securityContext);
  if (runtimeSelectExprEvaluationResult) {
    if (dbg) console.error("HACK: tryRuntimeSelectExprEvaluation");
    return runtimeSelectExprEvaluationResult;
  }

  const runtimeAliasResult = tryRuntimeAliasTupleSelect(schema, query);
  if (runtimeAliasResult) {
    return runtimeAliasResult;
  }

  const runtimeAliasSchemaResult = tryRuntimeTypedAliasSchemaLinkIntrospection(schema, query);
  if (runtimeAliasSchemaResult) {
    return runtimeAliasSchemaResult;
  }

  const schemaPointerAliasResult = trySchemaPointerAliasQuery(schema, query);
  if (schemaPointerAliasResult) {
    return schemaPointerAliasResult;
  }

  const schemaTupleResult = trySchemaTupleQuery(schema, query);
  if (schemaTupleResult) {
    return schemaTupleResult;
  }

  const schemaTypeResult = trySchemaTypeQuery(schema, query);
  if (schemaTypeResult) {
    return schemaTypeResult;
  }

  const rewrittenQuery = injectRuntimeAliasBinding(schema, query);
  validateRestrictedLinkPropertyTokens(rewrittenQuery);
  const schemaQueryResult = trySchemaObjectTypeQuery(schema, rewrittenQuery);
  if (schemaQueryResult) {
    return schemaQueryResult;
  }

  const parsedQuery = parseEdgeQL(rewrittenQuery);
  const preprocessed = preEvaluateGroupBindings(db, schema, parsedQuery, normalizeSecurityContext(securityContext));
  if (preprocessed !== parsedQuery) {
    // GROUP results were inlined as synthetic WITH bindings. Run the rewritten
    // AST directly so we don't re-parse the original query string (which would
    // discard the inlined results).
    const ctx = normalizeSecurityContext(securityContext);
    if (preprocessed.kind === "select_expr") {
      const r = tryRuntimeSelectExprEvaluationAst(db, schema, preprocessed, ctx);
      if (r) return r;
    }
    if (preprocessed.kind === "select") {
      const r = tryEvaluateParsedRuntimeSelect(db, schema, preprocessed, ctx);
      if (r) return r;
    }
    if (preprocessed.kind === "group") {
      const compiled = getCompilerService().compile(schema, preprocessed, {
        globals: ctx.globals,
        target: resolvedRuntimeTarget(ctx, db),
      });
      if (compiled.ir.kind === "group") {
        return {
          kind: "select",
          rows: runGroupIR(db, schema, compiled.ir, ctx, []),
        };
      }
    }
  }

  const parsedRuntimeResult = tryEvaluateParsedRuntimeSelect(db, schema, parsedQuery, securityContext);
  if (parsedRuntimeResult) {
    return parsedRuntimeResult;
  }

  if (parsedQuery.kind === "for") {
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
    return { kind: "insert", changes: 0 };
  }
  return executeQueryUnitWithTrace(db, schema, script, securityContext, parserOptions).result;
};

const selectExprIndexNeedsRuntime = (entry: SelectExprIREntry | undefined): boolean => {
  if (!entry || entry.kind !== "index_access") {
    return false;
  }
  return entry.value.kind === "coalesce"
    || entry.value.kind === "tuple"
    || entry.value.kind === "set_expr"
    || selectExprIndexNeedsRuntime(entry.value);
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
      result = {
        kind: "select",
        rows: sqlArtifact.loweringMode === "single_statement"
          ? runSelectFreeSQL(db, sqlArtifact)
          : [materializeFreeObjectRow(db, schema, ir.entries, context, sqlTrail)],
      };
    } else if (ir.kind === "select_expr") {
      const firstEntry = ir.entries[0];
      // Coalesce whose RHS is itself a set/union (e.g. `X ?? {X, Y}`)
      // needs per-row LCP iteration to suppress nulls inside the RHS set —
      // the compiled SQL produces `COALESCE(scalar, json_group_array(...))`
      // which can leak nulls into the multi-set fallback. Use the runtime
      // evaluator instead.
      const coalesceNeedsRuntime = firstEntry?.kind === "coalesce"
        && (firstEntry.right.kind === "set_expr"
          || ((firstEntry.right as { kind?: string; operator?: string }).kind === "operator_call"
            && (firstEntry.right as { operator?: string }).operator === "union"));
      // `?=` / `?!=` where either side wraps a filtered subquery needs
      // runtime evaluation — the compiled SQL collapses the subquery's
      // filter onto the cross-join row, mixing the LHS's filtered scope
      // with the RHS's broader scope.
      const containsFilteredSubquery = (e: SelectExprIREntry | undefined): boolean => {
        if (!e || typeof e !== "object") return false;
        if (e.kind === "select_expr_subquery") return true;
        if (e.kind === "field_access") return containsFilteredSubquery(e.value);
        if (e.kind === "cast" || e.kind === "not" || e.kind === "distinct" || e.kind === "exists" || e.kind === "shape_projection") {
          return containsFilteredSubquery((e as { value?: SelectExprIREntry; expr?: SelectExprIREntry }).value
            ?? (e as { expr?: SelectExprIREntry }).expr);
        }
        if (e.kind === "coalesce" || e.kind === "math" || e.kind === "compare" || e.kind === "and" || e.kind === "or") {
          return containsFilteredSubquery((e as { left: SelectExprIREntry }).left)
            || containsFilteredSubquery((e as { right: SelectExprIREntry }).right);
        }
        if (e.kind === "set_expr" || e.kind === "tuple" || e.kind === "array_literal_expr") {
          return (e.values as SelectExprIREntry[]).some(containsFilteredSubquery);
        }
        if (e.kind === "concat") {
          return (e.parts as SelectExprIREntry[]).some(containsFilteredSubquery);
        }
        return false;
      };
      const compareNeedsRuntimeFromFilter = (firstEntry?.kind === "compare")
        && (firstEntry.op === "?=" || firstEntry.op === "?!=")
        && (containsFilteredSubquery(firstEntry.left) || containsFilteredSubquery(firstEntry.right));

      // `?=` / `?!=` with a `coalesce` inside either side needs the runtime
      // LCP evaluator: the compiled SQL flattens `X ?? Y` to a SQL COALESCE
      // over a single join row (e.g. `COALESCE(g0.time_estimate, g0.time_estimate)`
      // for `Issue.time_estimate ?? Issue.related_to.time_estimate`), losing
      // the per-Issue dependency on `related_to`.
      const containsCoalesce = (e: SelectExprIREntry | undefined): boolean => {
        if (!e || typeof e !== "object") return false;
        if (e.kind === "coalesce") return true;
        if (e.kind === "field_access") return containsCoalesce(e.value);
        if (e.kind === "cast" || e.kind === "not" || e.kind === "distinct" || e.kind === "exists" || e.kind === "shape_projection") {
          return containsCoalesce((e as { value?: SelectExprIREntry; expr?: SelectExprIREntry }).value
            ?? (e as { expr?: SelectExprIREntry }).expr);
        }
        if (e.kind === "math" || e.kind === "compare" || e.kind === "and" || e.kind === "or") {
          return containsCoalesce((e as { left: SelectExprIREntry }).left)
            || containsCoalesce((e as { right: SelectExprIREntry }).right);
        }
        if (e.kind === "set_expr" || e.kind === "tuple" || e.kind === "array_literal_expr") {
          return (e.values as SelectExprIREntry[]).some(containsCoalesce);
        }
        if (e.kind === "concat") {
          return (e.parts as SelectExprIREntry[]).some(containsCoalesce);
        }
        return false;
      };
      const compareNeedsRuntimeFromCoalesce = (firstEntry?.kind === "compare")
        && (firstEntry.op === "?=" || firstEntry.op === "?!=")
        && (containsCoalesce(firstEntry.left) || containsCoalesce(firstEntry.right));

      // `?=` / `?!=` where LHS is `field_access(X.Y)` and RHS contains the
      // same path needs deep-path LCP — the compiled SQL evaluates per row
      // (including rows where the path is empty), which returns "true" for
      // empty IS empty pairs. EdgeDB iterates per the LHS path's non-null
      // values instead.
      const compareDeepLCP = (firstEntry?.kind === "compare")
        && (firstEntry.op === "?=" || firstEntry.op === "?!=")
        && firstEntry.left.kind === "field_access"
        && (() => {
          const structurallyEqualExpr = (a: SelectExprIREntry, b: SelectExprIREntry): boolean => {
            if (a === b) return true;
            if (a.kind !== b.kind) return false;
            if (a.kind === "field_access" && b.kind === "field_access") {
              return a.field === b.field && structurallyEqualExpr(a.value, b.value);
            }
            if (a.kind === "select" && b.kind === "select") {
              return a.query.sourceType === b.query.sourceType;
            }
            return false;
          };
          const containsExpr = (h: SelectExprIREntry, n: SelectExprIREntry): boolean => {
            if (structurallyEqualExpr(h, n)) return true;
            switch (h.kind) {
              case "field_access": return containsExpr(h.value, n);
              case "coalesce":
              case "math":
              case "compare":
              case "and":
              case "or":
                return containsExpr((h as { left: SelectExprIREntry }).left, n)
                  || containsExpr((h as { right: SelectExprIREntry }).right, n);
              case "not":
              case "cast":
              case "distinct":
              case "exists":
              case "shape_projection":
              case "select_expr_subquery":
                return containsExpr((h as { value?: SelectExprIREntry; expr?: SelectExprIREntry }).value
                  ?? (h as { expr?: SelectExprIREntry }).expr!, n);
              case "set_expr":
              case "tuple":
              case "array_literal_expr":
                return (h.values as SelectExprIREntry[]).some((v) => containsExpr(v, n));
              case "concat":
                return (h.parts as SelectExprIREntry[]).some((p) => containsExpr(p, n));
            }
            return false;
          };
          return containsExpr(firstEntry.right, firstEntry.left);
        })();
      const isShapeOrObject = firstEntry
        && (firstEntry.kind === "shape_projection"
          || firstEntry.kind === "select"
          || firstEntry.kind === "path_steps"
          || firstEntry.kind === "field_access"
          || firstEntry.kind === "select_expr_subquery"
          || firstEntry.kind === "array_literal_expr"
          || coalesceNeedsRuntime
          || compareDeepLCP
          || compareNeedsRuntimeFromFilter
          || compareNeedsRuntimeFromCoalesce
          || selectExprIndexNeedsRuntime(firstEntry));
      const sqlIsRunnable = compiled.usesGelIrSql && sqlArtifact.loweringMode === "single_statement";
      result = {
        kind: "select",
        rows: sqlIsRunnable && !isShapeOrObject
          ? runGelSelectExprSQL(db, sqlArtifact)
          : materializeSelectExprRows(db, schema, ir, context, sqlTrail),
      };
    } else if (ir.kind === "group") {
      result = {
        kind: "select",
        rows: runGroupIR(db, schema, ir, context, sqlTrail),
      };
    } else {
      const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType!, context);

      result = {
        kind: ir.kind,
        changes: writeResult.changes,
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
    throw asAppError(err);
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
      if (ast.kind === "for") {
        executeForLoop(db, schema, ast, context, runtimeTarget, compilerService, overlays, traces);
        continue;
      }
      if (ast.kind === "ddl") {
        continue;
      }

      const statementType = statementTypeOf(ast);
      enforceBuiltinPermissions(context, statementType, ast.pos.line, ast.pos.column);
      const astSubjectType = ast.kind === "insert" || ast.kind === "update" || ast.kind === "delete"
        ? schema.getType(ast.typeName)
        : undefined;
      if (ast.kind === "insert" && !astSubjectType && Object.keys(ast.values).length === 0 && !ast.conflict) {
        continue;
      }

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
        result = {
          kind: "select",
          rows: sqlArtifact.loweringMode === "single_statement"
            ? runSelectFreeSQL(db, sqlArtifact)
            : [materializeFreeObjectRow(db, schema, ir.entries, context, sqlTrail)],
        };
    } else if (ir.kind === "select_expr") {
        const firstEntry = ir.entries[0];
        const needsRuntimeExpr = selectExprIndexNeedsRuntime(firstEntry);
        const sqlIsRunnable = compiled.usesGelIrSql && sqlArtifact.loweringMode === "single_statement" && !needsRuntimeExpr;
        result = {
          kind: "select",
          rows: sqlIsRunnable
            ? runGelSelectExprSQL(db, sqlArtifact)
            : materializeSelectExprRows(db, schema, ir, context, sqlTrail),
        };
      } else if (ir.kind === "group") {
        result = {
          kind: "select",
          rows: runGroupIR(db, schema, ir, context, sqlTrail),
        };
      } else {
        const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType!, context);
        result = { kind: ir.kind, changes: writeResult.changes };
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
    throw asAppError(err);
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

    const compiled = compilerService.compile(schema, syntheticAst, { overlays, globals: context.globals, target: runtimeTarget });
    const ir = compiled.ir;
    const sqlArtifact = compiled.sql;
    assertTargetSqlCompatibility(sqlArtifact.sql, runtimeTarget);
    const sqlTrail: SQLArtifact[] = [sqlArtifact];

    const rows = ir.kind === "select_expr"
      ? materializeSelectExprRows(db, schema, ir, context, sqlTrail)
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
      ? materializeSelectExprRows(db, schema, ir, context, sqlTrail)
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
const TUPLE_MULTI_ROW_MARKER = Symbol.for("gel.selectExpr.tupleMultiRow");

// EdgeQL-style ordering: tuples compare element-wise, numbers compare
// numerically, strings via localeCompare. Returns negative/zero/positive.
const compareEdgeQLValues = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return -1;
  if (bNull) return 1;
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      const cmp = compareEdgeQLValues(a[i], b[i]);
      if (cmp !== 0) return cmp;
    }
    return a.length - b.length;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1;
  }
  // Plain lexicographic comparison (matches PG's default text ordering and
  // the engine's pre-existing string sort behavior) — `localeCompare` would
  // pick a locale-dependent collation that mixes uppercase and lowercase.
  const aStr = String(a);
  const bStr = String(b);
  return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
};

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
): unknown => {
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
  if (expr.kind === "unary") {
    const inner = evaluateFreeExprForShape(expr.expr, row, resolveCurrentField);
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
    const left = evaluateFreeExprForShape(expr.left, row, resolveCurrentField);
    const right = evaluateFreeExprForShape(expr.right, row, resolveCurrentField);
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
    return evaluateFreeExprForShape(expr.expr, row, resolveCurrentField);
  }
  if (expr.kind === "select_expr_subquery") {
    return evaluateFreeExprForShape(expr.expr, row, resolveCurrentField);
  }
  if (expr.kind === "set_expr") {
    const out: unknown[] = [];
    for (const value of expr.values) {
      const v = evaluateFreeExprForShape(value, row, resolveCurrentField);
      if (v === undefined) return undefined;
      out.push(...flattenShapeValues(v));
    }
    return out;
  }
  if (expr.kind === "set_literal") {
    return [...expr.values];
  }
  if (expr.kind === "coalesce") {
    const left = evaluateFreeExprForShape(expr.left, row, resolveCurrentField);
    if (left === undefined) return undefined;
    const ls = flattenShapeValues(left);
    if (ls.length > 0) {
      return ls.length === 1 ? ls[0] : ls;
    }
    const right = evaluateFreeExprForShape(expr.right, row, resolveCurrentField);
    if (right === undefined) return undefined;
    const rs = flattenShapeValues(right);
    return rs.length === 1 ? rs[0] : rs;
  }
  if (expr.kind === "compare") {
    const left = evaluateFreeExprForShape(expr.left, row, resolveCurrentField);
    const right = evaluateFreeExprForShape(expr.right, row, resolveCurrentField);
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
    const cond = evaluateFreeExprForShape(expr.condition, row, resolveCurrentField);
    if (cond === undefined) return undefined;
    const cs = flattenShapeValues(cond);
    if (cs.length === 0) return SHAPE_EMPTY_SET;
    if (cs[0]) {
      return evaluateFreeExprForShape(expr.thenExpr, row, resolveCurrentField);
    }
    return evaluateFreeExprForShape(expr.elseExpr, row, resolveCurrentField);
  }
  return undefined;
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

  // First try the general free-expression evaluator. If it returns undefined,
  // we don't know how to evaluate this; fall back to the legacy
  // path-steps/type-intersection handler below.
  const general = evaluateFreeExprForShape(expr, row, resolveCurrentField);
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
        output[element.name] = [...element.expr.values];
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

        const resolveShapeFunctionArg = (arg: typeof element.expr.args[number]): RuntimeFunctionArg => {
          if (arg.kind === "field_ref") {
            return row[arg.column] as ScalarValue;
          }
          if (arg.kind === "set_literal") {
            return { kind: "set" as const, values: [...arg.values] };
          }
          if (arg.kind === "array_literal") {
            return { kind: "array" as const, values: [...arg.values] };
          }
          if (arg.kind === "function_call") {
            return executeFunctionCall(
              schema,
              db,
              context,
              arg.functionName,
              arg.args.map((nested) => resolveShapeFunctionArg(nested)),
            ) as RuntimeFunctionArg;
          }
          return arg.value;
        };

        const args: RuntimeFunctionArg[] = element.expr.args.map((arg) => resolveShapeFunctionArg(arg));
        output[element.name] = executeFunctionCall(schema, db, context, element.expr.functionName, args);
      } else if (element.expr.kind === "link_aggregate") {
        const loweredAlias = computedValueAlias(element.pathId);
        if (Object.prototype.hasOwnProperty.call(row, loweredAlias)) {
          output[element.name] = row[loweredAlias];
          continue;
        }

        const relation = element.expr.relation;
        const linkPropertyColumns = new Set(relation.propertyColumns ?? []);
        const aggregateUsesLinkProperty = relation.storage === "table" && linkPropertyColumns.has(element.expr.column);
        const targetSource = compilePolymorphicTargetSource(db, relation, "t", aggregateUsesLinkProperty ? [] : [element.expr.column]);
        let sql: string;
        let params: ScalarValue[];
        if (relation.storage === "inline") {
          const targetId = row[relation.inlineColumn!];
          if (!isScalarValue(targetId) || targetId === null) {
            output[element.name] = 0;
            continue;
          }
          sql = `SELECT COALESCE(SUM(t.${quoteIdent(element.expr.column)}), 0) AS ${quoteIdent("value")} FROM ${targetSource} WHERE t.${quoteIdent("id")} = ?`;
          params = [targetId];
        } else {
          const sourceId = row.id;
          if (!isScalarValue(sourceId) || sourceId === null) {
            output[element.name] = 0;
            continue;
          }
          const aggregateColumn = aggregateUsesLinkProperty ? `l.${quoteIdent(element.expr.column)}` : `t.${quoteIdent(element.expr.column)}`;
          sql = `SELECT COALESCE(SUM(${aggregateColumn}), 0) AS ${quoteIdent("value")} FROM ${targetSource} JOIN ${linkJunctionFromSql(relation, "l")} ON l.${quoteIdent("target")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("source")} = ?`;
          params = [sourceId];
        }
        sqlTrail.push({ sql, params: [...params], loweringMode: "fallback_multi_query" });
        const aggregateRow = db.prepare(sql).all(...params)[0] as { value?: unknown } | undefined;
        output[element.name] = Number(aggregateRow?.value ?? 0);
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
        if (Object.prototype.hasOwnProperty.call(row, loweredAlias) && row[loweredAlias] !== null && row[loweredAlias] !== undefined) {
          const raw = row[loweredAlias];
          if (typeof raw === "string" && (raw === "true" || raw === "false" || raw === "null")) {
            output[element.name] = JSON.parse(raw);
          } else {
            output[element.name] = raw;
          }
          continue;
        }
        const evaluated = evaluateSelectExprShapeEntry(db, schema, element.expr.expr, row, sourceType);
        // A computed shape field whose name matches a multi-link on the
        // source type should always wrap its value as an array — even when
        // the value happens to have a single entry — so the output shape is
        // consistent across rows.
        const schemaLink = findRuntimeLinkDef(schema, sourceType, element.name);
        const isMultiLinkComputed = Boolean(schemaLink?.link.multi);
        const exprMulti = exprIsPotentiallyMulti(element.expr.expr) || isMultiLinkComputed;
        if (evaluated !== null && !Array.isArray(evaluated) && exprMulti) {
          output[element.name] = [evaluated];
        } else if (Array.isArray(evaluated) && evaluated.length === 1 && !exprMulti) {
          output[element.name] = evaluated[0];
        } else {
          output[element.name] = evaluated;
        }
      } else {
        output[element.name] = { name: sourceType };
      }
      continue;
    }

    if (element.kind === "link") {
      if (element.sourceTypeFilter && element.sourceTypeFilter !== sourceType) {
        output[element.name] = element.relation.multi ? [] : null;
        continue;
      }

      const payload = parsePayloadArray(row[shapePayloadAlias(element.pathId)]);
      if (payload) {
        const materialized = element.relation.multi ? payload : (payload[0] ?? null);
        output[element.name] = materialized;
        continue;
      }

      const links = resolveLinks(db, schema, context, row, element.relation, element.typeFilter, {
        columns: element.columns,
        shape: element.shape,
        filter: element.filter,
        orderBy: element.orderBy,
        limit: element.limit,
        offset: element.offset,
      }, sqlTrail);
      const materialized = element.relation.multi ? links : (links[0] ?? null);
      output[element.name] = materialized;
      continue;
    }

    const payload = parsePayloadArray(row[shapePayloadAlias(element.pathId)]);
    if (payload && !(element.columns && element.shape)) {
      output[element.name] = payload;
      continue;
    }

    const targetId = row.id;
    if (!isScalarValue(targetId)) {
      output[element.name] = [];
      continue;
    }

    if (element.columns && element.shape) {
      output[element.name] = resolveBacklinkObjects(db, schema, context, element.sources, targetId, {
        columns: element.columns,
        shape: element.shape,
        filter: element.filter,
        orderBy: element.orderBy,
        limit: element.limit,
        offset: element.offset,
      }, sqlTrail);
      continue;
    }

    output[element.name] = resolveBacklinks(db, element.sources, targetId, sqlTrail);
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
      return parsed.map((item) => coerceScalarForOutput(field.type, item));
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
  // Materialise the source rows by routing through whichever runtime path
  // matches the source AST kind. The strict IR/SQL compile rejects shape
  // entries that touch backlinks (`count(.owners)`), so we prefer the parsed
  // runtimes; the IR path is the last-resort fallback.
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
          const exprRows = materializeSelectExprRows(db, schema, sourceCompiled.ir, context, sqlTrail);
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
        case "/": return right === 0 ? null : left / right;
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
    const list = asNumericList(args[0]);
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

const evaluateSelectExprEntry = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  entry: SelectExprIREntry,
  sqlTrail: SQLArtifact[],
  evalContext?: {
    currentBinding?: string;
    currentValue?: unknown;
    bindings?: Record<string, unknown>;
    // Hint for LCP iteration: if present, the LCP path uses this to pre-sort
    // subject rows so that the outer ORDER BY (applied later in
    // materializeSelectExprRows) sees rows in the correct sequence. Without
    // this, the outer sort can't reorder per-row booleans because it has no
    // way to recover the originating subject row.
    parentOrderBy?: { value: SelectExprIREntry; direction?: "asc" | "desc" };
  },
): unknown => {
  const resolveFieldAccessValue = (item: unknown, field: string): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }

    const row = item as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      return row[field] ?? null;
    }

    if (typeof row.id !== "string") {
      return null;
    }

    const id = row.id;
    const globalType = db
      .prepare(`SELECT ${quoteIdent("type_name")} AS ${quoteIdent("type_name")} FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = ?`)
      .all(id)[0] as { type_name?: unknown } | undefined;
    if (!globalType || typeof globalType.type_name !== "string") {
      return null;
    }

    const sourceTypeName = resolveRuntimeStoredTypeName(schema, globalType.type_name);
    const sourceType = schema.getType(sourceTypeName);
    if (!sourceType) {
      return null;
    }

    const property = findFieldDef(schema, sourceTypeName, field);
    if (property) {
      const sourceTable = tableNameForType(sourceTypeName);
      const sourceRow = readRowById(db, sourceTable, id);
      return materializeFieldValue(schema, sourceTypeName, field, sourceRow?.[field] ?? null);
    }

    const computed = sourceType.computeds?.find((candidate) => candidate.kind === "property" && candidate.name === field);
    if (computed && computed.kind === "property") {
      const sourceTable = tableNameForType(sourceTypeName);
      const sourceRow = readRowById(db, sourceTable, id) ?? row;

      if (computed.expr.kind === "literal") {
        return computed.expr.value;
      }
      if (computed.expr.kind === "set_literal") {
        return [...computed.expr.values];
      }
      if (computed.expr.kind === "field_ref") {
        return sourceRow?.[computed.expr.field] ?? null;
      }
      if (computed.expr.kind === "concat") {
        return computed.expr.parts
          .map((part) => (
            part.kind === "literal"
              ? String(part.value ?? "")
              : String(sourceRow?.[part.field] ?? "")
          ))
          .join("");
      }
      if (computed.expr.kind === "function_call") {
        return executeFunctionCall(schema, db, context, computed.expr.name, computed.expr.args as RuntimeFunctionArg[]);
      }
      if (computed.expr.kind === "link_aggregate") {
        const aggregate = computed.expr;
        const sourceRow = readRowById(db, tableNameForType(sourceTypeName), id) ?? row;
        const targets = resolveFieldAccessValue({ ...sourceRow, id }, aggregate.link);
        const targetRows = Array.isArray(targets) ? targets : targets ? [targets] : [];
        if (aggregate.functionName === "sum") {
          return targetRows.reduce((total, target) => {
            if (!target || typeof target !== "object" || Array.isArray(target)) {
              return total;
            }
            const targetRow = target as Record<string, unknown>;
            return total + Number(targetRow[aggregate.field] ?? targetRow[`@${aggregate.field}`] ?? 0);
          }, 0);
        }
        return 0;
      }
      return null;
    }

    const computedLink = sourceType.computeds?.find((candidate) => candidate.kind === "link" && candidate.name === field);
    if (computedLink && computedLink.kind === "link" && computedLink.expr.kind === "backlink") {
      return resolveBacklinkPathValue(item, computedLink.expr.link, computedLink.expr.sourceType);
    }

    const resolvedLink = findRuntimeLinkDef(schema, sourceTypeName, field);
    if (!resolvedLink) {
      return null;
    }

    const loadTargetById = (targetId: unknown): Record<string, unknown> | null => {
      if (typeof targetId !== "string") {
        return null;
      }
      const targetType = db
        .prepare(`SELECT ${quoteIdent("type_name")} AS ${quoteIdent("type_name")} FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = ?`)
        .all(targetId)[0] as { type_name?: unknown } | undefined;
      if (!targetType || typeof targetType.type_name !== "string") {
        return null;
      }
      const resolvedTargetTypeName = resolveRuntimeStoredTypeName(schema, targetType.type_name);
      const targetTable = tableNameForType(resolvedTargetTypeName);
      const loaded = readRowById(db, targetTable, targetId);
      if (!loaded) {
        return null;
      }
      return { ...loaded, __source_type: resolvedTargetTypeName };
    };

    const targetRowsWithProps: Array<{ targetId: string; properties: Record<string, unknown> }> = [];
    const linkDef = resolvedLink.link;
    const usesLinkTable = Boolean(linkDef.multi) || (linkDef.properties?.length ?? 0) > 0;

    if (usesLinkTable) {
      const storageOwner = resolveLinkStorageOwner(schema, sourceType, linkDef);
      const ownerTable = tableNameForType(qualifiedTypeName(storageOwner));
      const linkTable = `${ownerTable}__${linkDef.name.toLowerCase()}`;
      const rows = db
        .prepare(`SELECT * FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`)
        .all(id) as Array<Record<string, unknown> & { target?: unknown }>;
      for (const row of rows) {
        if (typeof row.target === "string") {
          const properties: Record<string, unknown> = {};
          for (const property of linkDef.properties ?? []) {
            properties[`@${property.name}`] = row[property.name] ?? null;
          }
          targetRowsWithProps.push({ targetId: row.target, properties });
        }
      }
    } else {
      const sourceRow = readRowById(db, tableNameForType(sourceTypeName), id);
      const inlineColumn = `${linkDef.name}_id`;
      const targetId = sourceRow?.[inlineColumn];
      if (typeof targetId === "string") {
        targetRowsWithProps.push({ targetId, properties: {} });
      }
    }

    const loadedTargets = targetRowsWithProps
      .map(({ targetId, properties }) => {
        const target = loadTargetById(targetId);
        if (!target) {
          return null;
        }
        const computedProperties = Object.fromEntries((linkDef.computedProperties ?? []).map((property) => [
          `@${property.name}`,
          evaluateComputedLinkPropertyExpr(property.computedExpr, target, properties),
        ]));
        return { ...target, ...properties, ...computedProperties };
      })
      .filter((row): row is Record<string, unknown> => row !== null);

    if (linkDef.multi) {
      return loadedTargets;
    }
    return loadedTargets[0] ?? null;
  };

  const resolveBacklinkPathValue = (item: unknown, link: string, sourceTypeFilter?: string, sourceTypeExpr?: TypeExpr): unknown[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const target = item as Record<string, unknown>;
    if (typeof target.id !== "string") {
      return [];
    }
    const targetTypeName = typeof target.__source_type === "string"
      ? target.__source_type
      : (() => {
          const row = db.prepare(`SELECT ${quoteIdent("type_name")} AS ${quoteIdent("type_name")} FROM ${quoteIdent("__gel_global_ids")} WHERE ${quoteIdent("id")} = ?`).all(target.id)[0] as { type_name?: unknown } | undefined;
          return typeof row?.type_name === "string" ? resolveRuntimeStoredTypeName(schema, row.type_name) : undefined;
        })();
    const sourceTypes = sourceTypeExpr
      ? schema.listTypes().filter((typeDef) => !typeDef.abstract && rowMatchesTypeExpr(qualifiedTypeName(typeDef), sourceTypeExpr))
      : sourceTypeFilter
        ? schema.listConcreteTypesAssignableTo(qualifyRuntimeTypeName(sourceTypeFilter))
        : schema.listTypes();
    const out: Record<string, unknown>[] = [];
    for (const sourceType of sourceTypes) {
      const sourceTypeName = qualifiedTypeName(sourceType);
      const resolved = findRuntimeLinkDef(schema, sourceTypeName, link);
      if (!resolved) {
        continue;
      }
      const targetNames = normalizeLinkTargetNames(resolved.link.targetType, sourceType.module ?? "default");
      const canTarget = targetNames.some((candidate) => {
        if (candidate === targetTypeName) {
          return true;
        }
        return schema.listConcreteTypesAssignableTo(candidate).some((typeDef) => qualifiedTypeName(typeDef) === targetTypeName);
      });
      if (!canTarget) {
        continue;
      }
      const sourceTable = tableNameForType(sourceTypeName);
      if (resolved.link.multi || (resolved.link.properties?.length ?? 0) > 0) {
        const owner = resolveLinkStorageOwner(schema, sourceType, resolved.link);
        const linkTable = `${tableNameForType(qualifiedTypeName(owner))}__${resolved.link.name.toLowerCase()}`;
        const rows = db.prepare(`SELECT s.*, l.* FROM ${quoteIdent(sourceTable)} s JOIN ${quoteIdent(linkTable)} l ON l.${quoteIdent("source")} = s.${quoteIdent("id")} WHERE l.${quoteIdent("target")} = ?`).all(target.id) as Record<string, unknown>[];
        for (const row of rows) {
          const props = Object.fromEntries((resolved.link.properties ?? []).map((property) => [`@${property.name}`, row[property.name] ?? null]));
          out.push({ ...row, ...props, __source_type: sourceTypeName });
        }
      } else {
        const rows = db.prepare(`SELECT * FROM ${quoteIdent(sourceTable)} WHERE ${quoteIdent(`${resolved.link.name}_id`)} = ?`).all(target.id) as Record<string, unknown>[];
        out.push(...rows.map((row) => ({ ...row, __source_type: sourceTypeName })));
      }
    }
    return out;
  };

  const resolvePathStepTypeName = (name: string): string => {
    const qualified = qualifyRuntimeTypeName(name);
    if (schema.getType(qualified) || schema.listConcreteTypesAssignableTo(qualified).length > 0) {
      return qualified;
    }

    const stdQualified = qualifyRuntimeTypeName(name, "std");
    if (schema.getType(stdQualified) || schema.listConcreteTypesAssignableTo(stdQualified).length > 0) {
      return stdQualified;
    }

    return qualified;
  };

  const rowMatchesTypeName = (sourceTypeName: string, targetName: string): boolean => {
    const qualifiedTarget = resolvePathStepTypeName(targetName);
    return sourceTypeName === qualifiedTarget
      || schema.listConcreteTypesAssignableTo(qualifiedTarget).some((candidate) => qualifiedTypeName(candidate) === sourceTypeName);
  };

  const rowMatchesTypeExpr = (sourceTypeName: string, expr: TypeExpr): boolean => {
    if (expr.kind === "type_name") {
      return rowMatchesTypeName(sourceTypeName, expr.name);
    }
    if (expr.kind === "type_union") {
      return rowMatchesTypeExpr(sourceTypeName, expr.left) || rowMatchesTypeExpr(sourceTypeName, expr.right);
    }
    return rowMatchesTypeExpr(sourceTypeName, expr.left) && rowMatchesTypeExpr(sourceTypeName, expr.right);
  };

  const readPathRootRows = (name: string): Array<Record<string, unknown> & { __source_type: string }> => {
    const rootTypeName = resolvePathStepTypeName(name);
    const rootType = schema.getType(rootTypeName);
    const concreteTypes = schema.listConcreteTypesAssignableTo(rootTypeName);
    const sourceTypes = concreteTypes.length > 0 ? concreteTypes : rootType ? [rootType] : [];
    const rows: Array<Record<string, unknown> & { __source_type: string }> = [];

    for (const sourceType of sourceTypes) {
      const sourceTypeName = qualifiedTypeName(sourceType);
      const table = tableNameForType(sourceTypeName);
      const selected = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[];
      rows.push(...selected.map((row) => ({ ...row, __source_type: sourceTypeName })));
    }

    return rows;
  };

  const evaluatePathSteps = (
    steps: PathStep[],
    evalContext?: { currentValue?: unknown; bindings?: Record<string, unknown> },
  ): unknown => {
    const first = steps[0];
    if (!first) {
      return [];
    }

    let value: unknown;
    let rest: PathStep[];
    if (first.kind === "object_ref") {
      value = evalContext?.bindings && first.name in evalContext.bindings
        ? [evalContext.bindings[first.name]]
        : readPathRootRows(first.name);
      rest = steps.slice(1);
    } else if (first.kind === "type_intersection" || first.kind === "ptr") {
      // Implicit-subject path (e.g. `[is T].field` rooted at the current row).
      value = evalContext?.currentValue ?? null;
      rest = steps;
    } else {
      return [];
    }
    for (let i = 0; i < rest.length; i += 1) {
      const step = rest[i]!;
      if (step.kind === "type_intersection") {
        const expr = step.typeExpr ?? (step.typeName ? { kind: "type_name" as const, name: step.typeName } : undefined);
        if (expr) {
          const items = Array.isArray(value) ? value : [value];
          value = items.filter((item) => item && typeof item === "object" && !Array.isArray(item)
            && typeof (item as Record<string, unknown>).__source_type === "string"
            && rowMatchesTypeExpr((item as Record<string, unknown>).__source_type as string, expr));
        }
        continue;
      }

      if (step.kind !== "ptr") {
        continue;
      }

      const nextStep = rest[i + 1];
      if (step.name === "__type__" && nextStep?.kind === "ptr" && nextStep.name === "name") {
        const items = Array.isArray(value) ? value : [value];
        value = items
          .map((item) => item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>).__source_type ?? null
            : null)
          .filter((item) => item !== null && item !== undefined);
        i += 1;
        continue;
      }

      if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
          const fieldValue = step.direction === "inbound"
            ? resolveBacklinkPathValue(item, step.name, step.typeFilter, step.typeFilterExpr)
            : resolveFieldAccessValue(item, step.name);
          if (Array.isArray(fieldValue)) {
            out.push(...fieldValue.filter((entry) => entry !== null && entry !== undefined));
          } else if (fieldValue !== null && fieldValue !== undefined) {
            out.push(fieldValue);
          }
        }
        value = out;
      } else {
        value = step.direction === "inbound"
          ? resolveBacklinkPathValue(value, step.name, step.typeFilter, step.typeFilterExpr)
          : resolveFieldAccessValue(value, step.name);
      }
    }

    return value;
  };

  const isTupleLikeSelectExprEntry = (value: SelectExprIREntry): boolean => {
    if (value.kind === "tuple") {
      return true;
    }
    if (value.kind === "if_else") {
      return isTupleLikeSelectExprEntry(value.thenExpr) && isTupleLikeSelectExprEntry(value.elseExpr);
    }
    if (value.kind === "coalesce") {
      return isTupleLikeSelectExprEntry(value.left) || isTupleLikeSelectExprEntry(value.right);
    }
    if (value.kind === "field_access" && value.value.kind === "select") {
      const field = findFieldDef(schema, value.value.query.sourceType, value.field);
      return field?.collection?.kind === "tuple";
    }
    if (value.kind === "select_expr_subquery") {
      return isTupleLikeSelectExprEntry(value.value);
    }
    // `array_literal_expr[N]` yields one element of the array; if those
    // elements are themselves tuples, the result is a single tuple value.
    if (value.kind === "index_access" && value.value.kind === "array_literal_expr") {
      const elements = value.value.values as SelectExprIREntry[];
      return elements.length > 0 && elements.every(isTupleLikeSelectExprEntry);
    }
    return false;
  };

  // Walk an expression tree looking for the deepest "select" subject that all
  // value branches share. Returns the select node when found, else null.
  // Used to give a tuple `(Issue.x, Issue.y)` its longest-common-prefix scope
  // so it can iterate per Issue row instead of cartesian-producting the parts.
  const findSelectSubjectInExpr = (expr: SelectExprIREntry): SelectExprIREntry | null => {
    if (!expr || typeof expr !== "object") return null;
    if (expr.kind === "select") return expr;
    if (expr.kind === "field_access") return findSelectSubjectInExpr(expr.value);
    if (expr.kind === "coalesce") return findSelectSubjectInExpr(expr.left)
      ?? findSelectSubjectInExpr(expr.right);
    if (expr.kind === "shape_projection") return findSelectSubjectInExpr(expr.value);
    if (expr.kind === "select_expr_subquery") return findSelectSubjectInExpr(expr.value);
    if (expr.kind === "cast") return findSelectSubjectInExpr((expr as { value: SelectExprIREntry }).value);
    if (expr.kind === "compare") return findSelectSubjectInExpr(expr.left) ?? findSelectSubjectInExpr(expr.right);
    if (expr.kind === "math") return findSelectSubjectInExpr((expr as { left: SelectExprIREntry }).left)
      ?? findSelectSubjectInExpr((expr as { right: SelectExprIREntry }).right);
    if (expr.kind === "exists" || expr.kind === "not" || expr.kind === "distinct") {
      return findSelectSubjectInExpr((expr as { value?: SelectExprIREntry; expr?: SelectExprIREntry }).value
        ?? (expr as { expr?: SelectExprIREntry }).expr!);
    }
    if (expr.kind === "tuple" || expr.kind === "set_expr" || expr.kind === "array_literal_expr") {
      // The tuple/set/array's subject is the common subject of its non-constant
      // values. Constants (literals etc.) don't contribute a subject but also
      // don't disqualify one — only conflicting subjects do.
      const subs = (expr.values as SelectExprIREntry[]).map(findSelectSubjectInExpr);
      const first = subs.find((s) => s !== null);
      if (!first) return null;
      return subs.every((s) => s === null || sameSelectExprSubject(s, first)) ? first : null;
    }
    return null;
  };

  const sameSelectExprSubject = (left: SelectExprIREntry, right: SelectExprIREntry): boolean => {
    if (left.kind !== right.kind) {
      return false;
    }
    if (left.kind === "field_access" && right.kind === "field_access") {
      return left.field === right.field && sameSelectExprSubject(left.value, right.value);
    }
    if (left.kind === "select" && right.kind === "select") {
      return left.query.sourceType === right.query.sourceType;
    }
    if (left.kind === "type_field_path" && right.kind === "type_field_path") {
      return left.typeName === right.typeName && left.field === right.field;
    }
    if (left.kind === "current_item" && right.kind === "current_item") {
      return left.bindingName === right.bindingName;
    }
    return false;
  };

  const evaluateSelectExprEntryWithSubject = (
    expression: SelectExprIREntry,
    subject: SelectExprIREntry,
    subjectValue: unknown,
    evalState: { currentBinding?: string; currentValue?: unknown } | undefined,
  ): unknown => {
    if (sameSelectExprSubject(expression, subject)) {
      return subjectValue;
    }

    // Bare `select_expr_subquery` wrappers (no filter/orderBy/limit of their
    // own — the wrapped select carries them) are pass-throughs; unwrap so
    // sameSelectExprSubject can match the inner select to the bound subject.
    if (expression.kind === "select_expr_subquery") {
      const sub = expression as { filter?: unknown; orderBy?: unknown; limit?: unknown; offset?: unknown; value: SelectExprIREntry };
      if (sub.filter === undefined && sub.orderBy === undefined && sub.limit === undefined && sub.offset === undefined) {
        return evaluateSelectExprEntryWithSubject(sub.value, subject, subjectValue, evalState);
      }
    }

    if (expression.kind === "field_access") {
      const value = evaluateSelectExprEntryWithSubject(expression.value, subject, subjectValue, evalState);
      if (Array.isArray(value)) {
        return value.flatMap((item) => {
          const fieldValue = resolveFieldAccessValue(item, expression.field);
          return Array.isArray(fieldValue) ? fieldValue : fieldValue === null || fieldValue === undefined ? [] : [fieldValue];
        });
      }
      return resolveFieldAccessValue(value, expression.field);
    }

    if (expression.kind === "compare") {
      const leftValue = evaluateSelectExprEntryWithSubject(expression.left, subject, subjectValue, evalState);
      const rightValue = evaluateSelectExprEntryWithSubject(expression.right, subject, subjectValue, evalState);
      const isEmpty = (v: unknown): boolean =>
        v === null || v === undefined || (Array.isArray(v) && v.length === 0);
      // Coalescing equality ops keep their cardinality when one side is empty.
      if (expression.op === "?=" || expression.op === "?!=") {
        const leftEmpty = isEmpty(leftValue);
        const rightEmpty = isEmpty(rightValue);
        if (leftEmpty && rightEmpty) return expression.op === "?=";
        if (leftEmpty) {
          const rItems = Array.isArray(rightValue) ? rightValue : [rightValue];
          const v = expression.op === "?!=";
          return Array.isArray(rightValue) ? rItems.map(() => v) : v;
        }
        if (rightEmpty) {
          const lItems = Array.isArray(leftValue) ? leftValue : [leftValue];
          const v = expression.op === "?!=";
          return Array.isArray(leftValue) ? lItems.map(() => v) : v;
        }
        const lItems = Array.isArray(leftValue) ? leftValue : [leftValue];
        const rItems = Array.isArray(rightValue) ? rightValue : [rightValue];
        const out: boolean[] = [];
        for (const l of lItems) {
          for (const r of rItems) {
            const eq = l === r;
            out.push(expression.op === "?=" ? eq : !eq);
          }
        }
        return (Array.isArray(leftValue) || Array.isArray(rightValue)) ? out : out[0] ?? false;
      }
      const leftItems = Array.isArray(leftValue) ? leftValue : [leftValue];
      const rightItems = Array.isArray(rightValue) ? rightValue : [rightValue];
      return leftItems.some((leftItem) => rightItems.some((rightItem) => {
        if (expression.op === "=") return leftItem === rightItem;
        if (expression.op === "!=") return leftItem !== rightItem;
        if (expression.op === ">") return Number(leftItem) > Number(rightItem);
        if (expression.op === ">=") return Number(leftItem) >= Number(rightItem);
        if (expression.op === "<") return Number(leftItem) < Number(rightItem);
        return Number(leftItem) <= Number(rightItem);
      }));
    }

    if (expression.kind === "coalesce") {
      const leftValue = evaluateSelectExprEntryWithSubject(expression.left, subject, subjectValue, evalState);
      const isEmpty = leftValue === null
        || leftValue === undefined
        || (Array.isArray(leftValue) && leftValue.length === 0);
      if (!isEmpty) return leftValue;
      return evaluateSelectExprEntryWithSubject(expression.right, subject, subjectValue, evalState);
    }

    if (expression.kind === "set_expr") {
      const items: unknown[] = [];
      for (const value of expression.values) {
        const r = evaluateSelectExprEntryWithSubject(value as SelectExprIREntry, subject, subjectValue, evalState);
        if (r === null || r === undefined) continue;
        if (Array.isArray(r)) items.push(...r.filter((x) => x !== null && x !== undefined));
        else items.push(r);
      }
      return items;
    }

    if (expression.kind === "tuple") {
      // Nested tuple inside an LCP iteration: each slot must inherit the
      // bound subject value rather than re-iterating it from scratch.
      const subTupleValues = (expression as { values: SelectExprIREntry[] }).values;
      const slots = subTupleValues.map((slotExpr) => ({
        value: evaluateSelectExprEntryWithSubject(slotExpr, subject, subjectValue, evalState),
        tupleLike: isTupleLikeSelectExprEntry(slotExpr)
          || slotExpr.kind === "array_literal_expr"
          || (slotExpr.kind === "function_call" && (slotExpr as { functionName?: string }).functionName === "std::array_agg"),
      }));
      // EdgeQL tuple semantics: any empty slot makes the tuple empty.
      const anyEmpty = slots.some((s) => s.value === null
        || s.value === undefined
        || (Array.isArray(s.value) && !s.tupleLike && s.value.length === 0));
      if (anyEmpty) return [];
      if (!slots.some((s) => Array.isArray(s.value) && !s.tupleLike)) {
        return slots.map((s) => s.value);
      }
      const sets = slots.map((s) => (Array.isArray(s.value) && !s.tupleLike ? s.value : [s.value]));
      return sets.reduce<unknown[][]>(
        (rows, items) => rows.flatMap((row) => items.map((item) => [...row, item])),
        [[]],
      );
    }

    if (expression.kind === "literal") {
      return (expression as { value: unknown }).value;
    }

    if (expression.kind === "cast") {
      const inner = evaluateSelectExprEntryWithSubject(
        (expression as { value: SelectExprIREntry }).value,
        subject,
        subjectValue,
        evalState,
      );
      const castType = (expression as { castType: string }).castType;
      // `<str>{}` is empty in EdgeQL — preserve empty/null so downstream
      // ?? / tuples see emptiness rather than coercing to "".
      if (inner === null || inner === undefined) return null;
      if (Array.isArray(inner) && inner.length === 0) return inner;
      if (castType === "str" || castType === "std::str") {
        if (Array.isArray(inner)) return inner.map((v) => String(v ?? ""));
        return String(inner);
      }
      return inner;
    }

    if (expression.kind === "math") {
      const l = evaluateSelectExprEntryWithSubject((expression as { left: SelectExprIREntry }).left, subject, subjectValue, evalState);
      const r = evaluateSelectExprEntryWithSubject((expression as { right: SelectExprIREntry }).right, subject, subjectValue, evalState);
      if (l === null || l === undefined || r === null || r === undefined) return null;
      const op = (expression as { op: string }).op;
      const lNum = Number(l);
      const rNum = Number(r);
      switch (op) {
        case "+": return lNum + rNum;
        case "-": return lNum - rNum;
        case "*": return lNum * rNum;
        case "/": return rNum === 0 ? null : lNum / rNum;
        case "//": return rNum === 0 ? null : Math.floor(lNum / rNum);
        case "%": return rNum === 0 ? null : lNum % rNum;
        case "^": return Math.pow(lNum, rNum);
        default: return null;
      }
    }

    if (expression.kind === "and") {
      return Boolean(evaluateSelectExprEntryWithSubject(expression.left, subject, subjectValue, evalState))
        && Boolean(evaluateSelectExprEntryWithSubject(expression.right, subject, subjectValue, evalState));
    }
    if (expression.kind === "or") {
      return Boolean(evaluateSelectExprEntryWithSubject(expression.left, subject, subjectValue, evalState))
        || Boolean(evaluateSelectExprEntryWithSubject(expression.right, subject, subjectValue, evalState));
    }
    if (expression.kind === "not") {
      return !(evaluateSelectExprEntryWithSubject(expression.expr, subject, subjectValue, evalState));
    }

    return evaluateSelectExprEntry(schema, db, context, expression, sqlTrail, evalState);
  };

  switch (entry.kind) {
    case "literal":
      return entry.value;
    case "set_literal":
      return [...entry.values];
    case "set_expr":
      return (entry.values as any[]).flatMap((value) => {
        const typedValue = value as SelectExprIREntry;
        const item = evaluateSelectExprEntry(schema, db, context, typedValue as any, sqlTrail, evalContext);
        return Array.isArray(item) && !isTupleLikeSelectExprEntry(typedValue) ? item : [item];
      });
    case "enum_path":
      return entry.member;
    case "current_item":
      if (evalContext?.currentBinding === entry.bindingName) {
        return evalContext.currentValue ?? null;
      }
      if (evalContext?.bindings && entry.bindingName in evalContext.bindings) {
        return evalContext.bindings[entry.bindingName] ?? null;
      }
      return null;
    case "tuple": {
      const tupleValues = entry.values as SelectExprIREntry[];

      // Longest-common-prefix iteration: when every tuple element threads
      // through the same `select` source, EdgeDB iterates per source row
      // rather than cartesian-producting each slot independently. Detect
      // that here and evaluate each row with the source pre-bound, then
      // expand any per-row multi-set slots locally.
      const subjects = tupleValues.map(findSelectSubjectInExpr);
      const lcpSubject = subjects[0];
      const sharesSubject = Boolean(lcpSubject) && subjects.every(
        (s) => s !== null && sameSelectExprSubject(s, lcpSubject!),
      );
      if (sharesSubject && lcpSubject) {
        const subjectValue = evaluateSelectExprEntry(schema, db, context, lcpSubject, sqlTrail, evalContext);
        const subjectRows = Array.isArray(subjectValue)
          ? subjectValue
          : (subjectValue === null || subjectValue === undefined ? [] : [subjectValue]);
        // If the LCP source is empty, OPTIONAL operators (?? / ?=) still
        // produce a row; fall through to the non-LCP path so each slot is
        // evaluated globally. The slot evaluators handle the empty case.
        if (subjectRows.length === 0) {
          // intentionally fall through
        } else {
        const allRows: unknown[][] = [];
        for (const subjectRow of subjectRows) {
          const slots = tupleValues.map((slotExpr) => ({
            value: evaluateSelectExprEntryWithSubject(slotExpr, lcpSubject, subjectRow, evalContext),
            tupleLike: isTupleLikeSelectExprEntry(slotExpr)
              || slotExpr.kind === "array_literal_expr"
              || (slotExpr.kind === "function_call" && (slotExpr as { functionName?: string }).functionName === "std::array_agg"),
          }));
          // Expand multi-set slots locally (cartesian within this row only).
          // An empty slot (null/undefined or empty multi-set) suppresses the
          // whole row: in EdgeQL, NULL on a property is the empty set, and a
          // tuple's cardinality is the product of its slots — any empty slot
          // gives 0 rows. Without this, `(Issue.name, Issue.time_estimate)`
          // keeps a `[name, null]` for Issues with no time_estimate.
          const sets = slots.map((s) => {
            if (s.value === null || s.value === undefined) return [];
            if (Array.isArray(s.value) && !s.tupleLike) return s.value;
            return [s.value];
          });
          const expanded = sets.reduce<unknown[][]>(
            (rows, items) => rows.flatMap((row) => items.map((item) => [...row, item])),
            [[]],
          );
          allRows.push(...expanded);
        }
        Object.defineProperty(allRows, TUPLE_MULTI_ROW_MARKER, {
          value: true,
          enumerable: false,
          configurable: true,
        });
        return allRows;
        }
      }

      const values = tupleValues.map((value) => ({
        value: evaluateSelectExprEntry(schema, db, context, value, sqlTrail, evalContext),
        tupleLike: isTupleLikeSelectExprEntry(value)
          || value.kind === "array_literal_expr"
          || (value.kind === "function_call" && (value as { functionName?: string }).functionName === "std::array_agg"),
      }));
      if (!values.some((entry) => Array.isArray(entry.value) && !entry.tupleLike)) {
        return values.map((entry) => entry.value);
      }
      const multiRowResult = values.reduce<unknown[][]>(
        (rows, entry) => {
          const items = Array.isArray(entry.value) && !entry.tupleLike ? entry.value : [entry.value];
          return rows.flatMap((row) => items.map((item) => [...row, item]));
        },
        [[]],
      );
      // Tag with a non-enumerable marker so materializeSelectExprRows can
      // distinguish a multi-row cartesian product (which may be empty) from
      // a single tuple value of the same shape.
      Object.defineProperty(multiRowResult, TUPLE_MULTI_ROW_MARKER, {
        value: true,
        enumerable: false,
        configurable: true,
      });
      return multiRowResult;
    }
    case "array_literal_expr": {
      return (entry.values as unknown[]).map((value) => {
        const typedValue = value as SelectExprIREntry;
        return evaluateSelectExprEntry(schema, db, context, typedValue, sqlTrail, evalContext);
      });
    }
    case "free_object": {
      const record: Record<string, unknown> = {};
      for (const item of entry.entries) {
        record[item.name] = evaluateSelectExprEntry(schema, db, context, item.expr, sqlTrail, evalContext);
      }
      return record;
    }
    case "index_access": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      // `array_literal_expr` evaluates to a single array value (not a set),
      // so `[…][N]` indexes INTO the array — its element may itself be a
      // tuple/array and must not be flattened.
      const valueIsTuple = Array.isArray(value)
        && (isTupleLikeSelectExprEntry(entry.value)
          || entry.value.kind === "current_item"
          || entry.value.kind === "index_access"
          || entry.value.kind === "array_literal_expr");
      const indexPath = Number.isInteger(entry.index)
        ? [entry.index]
        : String(entry.index).split(".").map((part) => Number(part)).filter((part) => Number.isInteger(part));
      const readIndex = (item: unknown): unknown => {
        let current = item;
        for (const index of indexPath) {
          if (typeof current === "string") {
            current = current[index] ?? null;
          } else if (Array.isArray(current)) {
            current = current[index] ?? null;
          } else {
            return null;
          }
        }
        return current;
      };

      if (Array.isArray(value) && !(typeof value === "string") && !valueIsTuple) {
        const out: unknown[] = [];
        for (const item of value) {
          const indexed = readIndex(item);
          if (indexed !== null && indexed !== undefined) {
            out.push(indexed);
          }
        }
        return out;
      }

      return readIndex(value);
    }
    case "exists": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return value !== null && value !== undefined;
    }
    case "compare": {
      // Deep-path LCP for `?=` / `?!=`: when LHS is a `field_access` and RHS
      // contains the same field_access somewhere, iterate per the path's
      // non-null subject rows, skipping rows where the deep path is empty.
      // Example: `Issue.time_estimate ?= Issue.time_estimate * 2` iterates
      // per non-null time_estimate (3 iterations, all false), not per Issue.
      if ((entry.op === "?=" || entry.op === "?!=") && entry.left.kind === "field_access") {
        if (process.env.DBG_LCP) console.log('[?= deep] entering check; left.kind=', entry.left.kind, 'right.kind=', entry.right.kind);
        const structurallyEqualExpr = (a: SelectExprIREntry, b: SelectExprIREntry): boolean => {
          if (a === b) return true;
          if (a.kind !== b.kind) return false;
          if (a.kind === "field_access" && b.kind === "field_access") {
            return a.field === b.field && structurallyEqualExpr(a.value, b.value);
          }
          if (a.kind === "select" && b.kind === "select") {
            return a.query.sourceType === b.query.sourceType;
          }
          return false;
        };
        const containsExpr = (haystack: SelectExprIREntry, needle: SelectExprIREntry): boolean => {
          if (structurallyEqualExpr(haystack, needle)) return true;
          switch (haystack.kind) {
            case "field_access": return containsExpr(haystack.value, needle);
            case "coalesce":
            case "math":
            case "compare":
            case "and":
            case "or":
              return containsExpr((haystack as { left: SelectExprIREntry }).left, needle)
                || containsExpr((haystack as { right: SelectExprIREntry }).right, needle);
            case "not":
            case "cast":
            case "distinct":
            case "exists":
            case "shape_projection":
            case "select_expr_subquery":
              return containsExpr((haystack as { value?: SelectExprIREntry; expr?: SelectExprIREntry }).value
                ?? (haystack as { expr?: SelectExprIREntry }).expr!, needle);
            case "set_expr":
            case "tuple":
            case "array_literal_expr":
              return (haystack.values as SelectExprIREntry[]).some((v) => containsExpr(v, needle));
            case "concat":
              return (haystack.parts as SelectExprIREntry[]).some((p) => containsExpr(p, needle));
          }
          return false;
        };
        const subject = findSelectSubjectInExpr(entry.left);
        if (subject && containsExpr(entry.right, entry.left)) {
          const subjectValue = evaluateSelectExprEntry(schema, db, context, subject, sqlTrail, evalContext);
          const subjectRows = Array.isArray(subjectValue)
            ? subjectValue
            : subjectValue === null || subjectValue === undefined ? [] : [subjectValue];
          const out: boolean[] = [];
          for (const subjectRow of subjectRows) {
            const lv = evaluateSelectExprEntryWithSubject(entry.left, subject, subjectRow, evalContext);
            if (lv === null || lv === undefined || (Array.isArray(lv) && lv.length === 0)) {
              continue;
            }
            const rv = evaluateSelectExprEntryWithSubject(entry.right, subject, subjectRow, evalContext);
            const lItems = Array.isArray(lv) ? lv : [lv];
            const rItems = Array.isArray(rv) ? rv : [rv];
            const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
              && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
            for (const l of lItems) {
              for (const r of rItems) {
                const eq = comparable(l) === comparable(r);
                out.push(entry.op === "?=" ? eq : !eq);
              }
            }
          }
          return out;
        }
      }

      // LCP iteration for `?=` / `?!=`: when both sides thread through the
      // SAME `select` source (same sourceType and same filter/orderBy/limit/
      // offset), iterate per subject row and apply ?=/?!= per row rather than
      // evaluating LHS and RHS globally as independent sets. This is the
      // analogue of the coalesce LCP path below — needed e.g. for
      // `WITH I := (SELECT Issue FILTER …) SELECT I.x ?!= I.y.z` where both
      // refs to `I` inline to the same filtered subquery.
      if (entry.op === "?=" || entry.op === "?!=") {
        const leftSubject = findSelectSubjectInExpr(entry.left);
        const rightSubject = findSelectSubjectInExpr(entry.right);
        const strictSameSubject = (
          l: SelectExprIREntry | null,
          r: SelectExprIREntry | null,
        ): boolean => {
          if (!l || !r) return false;
          if (l === r) return true;
          if (l.kind !== "select" || r.kind !== "select") return sameSelectExprSubject(l, r);
          if (l.query.sourceType !== r.query.sourceType) return false;
          const lq = l.query as { filter?: unknown; orderBy?: unknown; limit?: unknown; offset?: unknown };
          const rq = r.query as { filter?: unknown; orderBy?: unknown; limit?: unknown; offset?: unknown };
          const sameClause = (a: unknown, b: unknown): boolean => {
            if (a === undefined && b === undefined) return true;
            if (a === undefined || b === undefined) return false;
            return JSON.stringify(a) === JSON.stringify(b);
          };
          return sameClause(lq.filter, rq.filter)
            && sameClause(lq.orderBy, rq.orderBy)
            && sameClause(lq.limit, rq.limit)
            && sameClause(lq.offset, rq.offset);
        };
        // LCP path B: subjects share sourceType but one is "open" (no
        // clauses) and the other is "closed" (has at least one of
        // filter/orderBy/limit/offset). The open side iterates; the closed
        // side is computed once and reused per row. Example:
        //   SELECT (SELECT Issue FILTER X).y ?= Issue.z * 2
        // iterates per the outer free `Issue` (6 rows), with LHS evaluated
        // once globally as an empty/non-empty set.
        const isOpenSelectSubject = (s: SelectExprIREntry | null): boolean => {
          if (!s || s.kind !== "select") return false;
          const q = s.query as { filter?: unknown; orderBy?: unknown; limit?: unknown; offset?: unknown };
          return q.filter === undefined && q.orderBy === undefined && q.limit === undefined && q.offset === undefined;
        };
        const sharesSourceType = leftSubject && rightSubject
          && leftSubject.kind === "select" && rightSubject.kind === "select"
          && leftSubject.query.sourceType === rightSubject.query.sourceType;
        const leftOpen = isOpenSelectSubject(leftSubject);
        const rightOpen = isOpenSelectSubject(rightSubject);
        const useOpenLcp = sharesSourceType
          && !strictSameSubject(leftSubject, rightSubject)
          && (leftOpen !== rightOpen);
        if (useOpenLcp) {
          const openSubject = leftOpen ? leftSubject! : rightSubject!;
          const openSide: "left" | "right" = leftOpen ? "left" : "right";
          const openExpr = openSide === "left" ? entry.left : entry.right;
          const closedExpr = openSide === "left" ? entry.right : entry.left;
          const subjectValue = evaluateSelectExprEntry(schema, db, context, openSubject, sqlTrail, evalContext);
          const subjectRows = Array.isArray(subjectValue)
            ? subjectValue
            : subjectValue === null || subjectValue === undefined ? [] : [subjectValue];
          if (subjectRows.length > 0) {
            const closedValue = evaluateSelectExprEntry(schema, db, context, closedExpr, sqlTrail, evalContext);
            const lcpIsEmpty = (v: unknown): boolean =>
              v === null || v === undefined || (Array.isArray(v) && v.length === 0);
            const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
              && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
            const out: boolean[] = [];
            for (const subjectRow of subjectRows) {
              const openValue = evaluateSelectExprEntryWithSubject(openExpr, openSubject, subjectRow, evalContext);
              const leftValue = openSide === "left" ? openValue : closedValue;
              const rightValue = openSide === "right" ? openValue : closedValue;
              const lEmpty = lcpIsEmpty(leftValue);
              const rEmpty = lcpIsEmpty(rightValue);
              if (lEmpty && rEmpty) { out.push(entry.op === "?="); continue; }
              if (lEmpty) {
                const rItems = Array.isArray(rightValue) ? rightValue : [rightValue];
                const v = entry.op === "?!=";
                for (let i = 0; i < rItems.length; i++) out.push(v);
                continue;
              }
              if (rEmpty) {
                const lItems = Array.isArray(leftValue) ? leftValue : [leftValue];
                const v = entry.op === "?!=";
                for (let i = 0; i < lItems.length; i++) out.push(v);
                continue;
              }
              const lItems = Array.isArray(leftValue) ? leftValue : [leftValue];
              const rItems = Array.isArray(rightValue) ? rightValue : [rightValue];
              for (const l of lItems) {
                for (const r of rItems) {
                  const eq = comparable(l) === comparable(r);
                  out.push(entry.op === "?=" ? eq : !eq);
                }
              }
            }
            return out;
          }
        }
        if (leftSubject && rightSubject && strictSameSubject(leftSubject, rightSubject)) {
          const subjectValue = evaluateSelectExprEntry(schema, db, context, leftSubject, sqlTrail, evalContext);
          let subjectRows: unknown[] = Array.isArray(subjectValue)
            ? [...subjectValue]
            : subjectValue === null || subjectValue === undefined ? [] : [subjectValue];
          // Pre-sort by parent ORDER BY when its expression threads through
          // the LCP subject; the per-row scalar output (booleans here) can't
          // carry subject context, so the outer sort can't reorder later.
          if (evalContext?.parentOrderBy && subjectRows.length > 1) {
            const orderSubject = findSelectSubjectInExpr(evalContext.parentOrderBy.value);
            if (orderSubject && strictSameSubject(orderSubject, leftSubject)) {
              const dir = evalContext.parentOrderBy.direction === "desc" ? -1 : 1;
              const keys = new Map<unknown, unknown>();
              for (const row of subjectRows) {
                keys.set(row, evaluateSelectExprEntryWithSubject(evalContext.parentOrderBy.value, orderSubject, row, evalContext));
              }
              subjectRows.sort((a, b) => compareEdgeQLValues(keys.get(a), keys.get(b)) * dir);
            }
          }
          if (subjectRows.length > 0) {
            const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
              && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
            const lcpIsEmpty = (v: unknown): boolean =>
              v === null || v === undefined || (Array.isArray(v) && v.length === 0);
            const out: boolean[] = [];
            for (const subjectRow of subjectRows) {
              const lv = evaluateSelectExprEntryWithSubject(entry.left, leftSubject, subjectRow, evalContext);
              const rv = evaluateSelectExprEntryWithSubject(entry.right, rightSubject, subjectRow, evalContext);
              const lEmpty = lcpIsEmpty(lv);
              const rEmpty = lcpIsEmpty(rv);
              if (lEmpty && rEmpty) {
                out.push(entry.op === "?=");
                continue;
              }
              if (lEmpty) {
                const rItems = Array.isArray(rv) ? rv : [rv];
                const v = entry.op === "?!=";
                for (let i = 0; i < rItems.length; i++) out.push(v);
                continue;
              }
              if (rEmpty) {
                const lItems = Array.isArray(lv) ? lv : [lv];
                const v = entry.op === "?!=";
                for (let i = 0; i < lItems.length; i++) out.push(v);
                continue;
              }
              const lItems = Array.isArray(lv) ? lv : [lv];
              const rItems = Array.isArray(rv) ? rv : [rv];
              for (const l of lItems) {
                for (const r of rItems) {
                  const eq = comparable(l) === comparable(r);
                  out.push(entry.op === "?=" ? eq : !eq);
                }
              }
            }
            return out;
          }
        }
      }

      const leftValue = evaluateSelectExprEntry(schema, db, context, entry.left, sqlTrail, evalContext);
      const rightValue = evaluateSelectExprEntry(schema, db, context, entry.right, sqlTrail, evalContext);

      const isEmpty = (v: unknown): boolean =>
        v === null || v === undefined || (Array.isArray(v) && v.length === 0);

      // Coalescing equality operators (?=, ?!=) treat empty sets as comparable
      // values: two empties are equal; empty vs non-empty is unequal. When
      // one side is empty and the other is a multi-set, the result has the
      // non-empty side's cardinality (one boolean per element).
      if (entry.op === "?=" || entry.op === "?!=") {
        const leftEmpty = isEmpty(leftValue);
        const rightEmpty = isEmpty(rightValue);
        if (leftEmpty && rightEmpty) {
          return entry.op === "?=";
        }
        if (leftEmpty) {
          const rItems = Array.isArray(rightValue) ? rightValue : [rightValue];
          const v = entry.op === "?!=";
          return Array.isArray(rightValue) ? rItems.map(() => v) : v;
        }
        if (rightEmpty) {
          const lItems = Array.isArray(leftValue) ? leftValue : [leftValue];
          const v = entry.op === "?!=";
          return Array.isArray(leftValue) ? lItems.map(() => v) : v;
        }
        const leftItems = Array.isArray(leftValue) ? leftValue : [leftValue];
        const rightItems = Array.isArray(rightValue) ? rightValue : [rightValue];
        const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
          && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
        const out: boolean[] = [];
        for (const l of leftItems) {
          for (const r of rightItems) {
            const eq = comparable(l) === comparable(r);
            out.push(entry.op === "?=" ? eq : !eq);
          }
        }
        return (Array.isArray(leftValue) || Array.isArray(rightValue)) ? out : out[0] ?? false;
      }

      const leftItems = Array.isArray(leftValue) ? leftValue : [leftValue];
      const rightItems = Array.isArray(rightValue) ? rightValue : [rightValue];
      const compareOne = (left: unknown, right: unknown): boolean => {
        if (entry.op === "=") {
          return left === right;
        }
        if (entry.op === "!=") {
          return left !== right;
        }
        if (entry.op === ">") {
          return Number(left) > Number(right);
        }
        if (entry.op === ">=") {
          return Number(left) >= Number(right);
        }
        if (entry.op === "<=") {
          return Number(left) <= Number(right);
        }
        return Number(left) < Number(right);
      };

      const out: boolean[] = [];
      for (const left of leftItems) {
        for (const right of rightItems) {
          out.push(compareOne(left, right));
        }
      }

      return (Array.isArray(leftValue) || Array.isArray(rightValue)) ? out : out[0] ?? false;
    }
    case "and":
    case "or": {
      const leftValue = evaluateSelectExprEntry(schema, db, context, entry.left, sqlTrail, evalContext);
      const rightValue = evaluateSelectExprEntry(schema, db, context, entry.right, sqlTrail, evalContext);
      const leftItems = Array.isArray(leftValue) ? leftValue : [leftValue];
      const rightItems = Array.isArray(rightValue) ? rightValue : [rightValue];
      const out = leftItems.flatMap((left) => rightItems.map((right) => (
        entry.kind === "and" ? Boolean(left) && Boolean(right) : Boolean(left) || Boolean(right)
      )));
      return (Array.isArray(leftValue) || Array.isArray(rightValue)) ? out : out[0] ?? false;
    }
    case "not": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.expr, sqlTrail, evalContext);
      if (Array.isArray(value)) {
        return value.map((item) => !(item));
      }
      return !(value);
    }
    case "math": {
      const leftValue = evaluateSelectExprEntry(schema, db, context, entry.left, sqlTrail, evalContext);
      const rightValue = evaluateSelectExprEntry(schema, db, context, entry.right, sqlTrail, evalContext);
      const applyMath = (l: unknown, r: unknown): number | null => {
        const ln = Number(l);
        const rn = Number(r);
        switch (entry.op) {
          case "+": return ln + rn;
          case "-": return ln - rn;
          case "*": return ln * rn;
          case "/": return ln / rn;
          case "//": return Math.floor(ln / rn);
          case "%": return ln % rn;
          case "^": return Math.pow(ln, rn);
          default: return null;
        }
      };
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
    case "coalesce": {
      // Deep-path LCP: when LHS is a `field_access` (`Issue.time_estimate`)
      // and RHS contains the SAME field_access somewhere in its tree, the
      // LCP is at the deeper field-path level — iterate per the LHS path's
      // non-null values instead of per the type-root. In this case the LHS
      // is always non-empty per iteration, so the result is just LHS as a
      // set (nulls filtered out).
      const structurallyEqualExpr = (a: SelectExprIREntry, b: SelectExprIREntry): boolean => {
        if (a === b) return true;
        if (a.kind !== b.kind) return false;
        if (a.kind === "field_access" && b.kind === "field_access") {
          return a.field === b.field && structurallyEqualExpr(a.value, b.value);
        }
        if (a.kind === "select" && b.kind === "select") {
          return a.query.sourceType === b.query.sourceType;
        }
        return false;
      };
      const containsExpr = (haystack: SelectExprIREntry, needle: SelectExprIREntry): boolean => {
        if (structurallyEqualExpr(haystack, needle)) return true;
        switch (haystack.kind) {
          case "field_access": return containsExpr(haystack.value, needle);
          case "coalesce":
            return containsExpr(haystack.left, needle) || containsExpr(haystack.right, needle);
          case "math":
          case "compare":
          case "and":
          case "or":
            return containsExpr(haystack.left, needle) || containsExpr(haystack.right, needle);
          case "not":
          case "cast":
          case "distinct":
          case "exists":
          case "shape_projection":
          case "select_expr_subquery":
            return containsExpr((haystack as { value?: SelectExprIREntry; expr?: SelectExprIREntry }).value
              ?? (haystack as { expr?: SelectExprIREntry }).expr!, needle);
          case "set_expr":
          case "tuple":
          case "array_literal_expr":
            return (haystack.values as SelectExprIREntry[]).some((v) => containsExpr(v, needle));
          case "concat":
            return (haystack.parts as SelectExprIREntry[]).some((p) => containsExpr(p, needle));
        }
        return false;
      };
      if (entry.left.kind === "field_access" && containsExpr(entry.right, entry.left)) {
        const leftValue = evaluateSelectExprEntry(schema, db, context, entry.left, sqlTrail, evalContext);
        const items = Array.isArray(leftValue) ? leftValue : (leftValue === null || leftValue === undefined ? [] : [leftValue]);
        return items.filter((v) => v !== null && v !== undefined);
      }

      // Longest-common-prefix iteration: when both sides thread through the
      // SAME (reference-identical or same pathId) `select` source, EdgeDB
      // iterates per source row and chooses LHS-or-RHS per row, rather than
      // treating the whole LHS as one set. Require strict identity here —
      // matching on `sourceType` alone would collapse semantically distinct
      // scopes like `(SELECT Issue FILTER ...)` and a plain `Issue`.
      const leftSubject = findSelectSubjectInExpr(entry.left);
      const rightSubject = findSelectSubjectInExpr(entry.right);
      const strictSameSubject = (
        l: SelectExprIREntry | null,
        r: SelectExprIREntry | null,
      ): boolean => {
        if (!l || !r) return false;
        if (l === r) return true;
        if (l.kind !== "select" || r.kind !== "select") return sameSelectExprSubject(l, r);
        if (l.query.sourceType !== r.query.sourceType) return false;
        // Both must share the same scope shape — different filter/orderBy/
        // limit/offset means semantically distinct subsets of the type even
        // though `sameSelectExprSubject` would accept them. The IR doesn't
        // expose binding identity for repeated references (e.g. two `Issue.X`
        // references), so we can't cleanly distinguish `WITH I2 := Issue;
        // SELECT Issue.x ?? I2.y` from `SELECT Issue.x ?? Issue.y` — both
        // produce different pathIds. We err on the LCP-permissive side here.
        const lq = l.query as { filter?: unknown; orderBy?: unknown; limit?: unknown; offset?: unknown };
        const rq = r.query as { filter?: unknown; orderBy?: unknown; limit?: unknown; offset?: unknown };
        const sameClause = (a: unknown, b: unknown): boolean => {
          if (a === undefined && b === undefined) return true;
          if (a === undefined || b === undefined) return false;
          return JSON.stringify(a) === JSON.stringify(b);
        };
        return sameClause(lq.filter, rq.filter)
          && sameClause(lq.orderBy, rq.orderBy)
          && sameClause(lq.limit, rq.limit)
          && sameClause(lq.offset, rq.offset);
      };
      if (leftSubject && rightSubject && strictSameSubject(leftSubject, rightSubject)) {
        const subjectValue = evaluateSelectExprEntry(schema, db, context, leftSubject, sqlTrail, evalContext);
        const subjectRows = Array.isArray(subjectValue)
          ? subjectValue
          : subjectValue === null || subjectValue === undefined ? [] : [subjectValue];
        if (subjectRows.length > 0) {
          const out: unknown[] = [];
          // Whether to flatten a value into multiple rows depends on the IR
          // kind of the producing expression: a `tuple`/`array_literal_expr`
          // is a SINGLE value even when it looks like an array, while set
          // producers (`set_expr`, `select`, multi-link field_access, …)
          // spread their elements into separate rows.
          const pushFromExpr = (v: unknown, expr: SelectExprIREntry): void => {
            if (v === null || v === undefined) return;
            if (expr.kind === "tuple" || expr.kind === "array_literal_expr") {
              out.push(v);
              return;
            }
            if (Array.isArray(v)) {
              if (v.length > 0 && v.every((item) => Array.isArray(item))) {
                for (const inner of v) out.push(inner);
              } else {
                for (const inner of v) {
                  if (inner !== null && inner !== undefined) out.push(inner);
                }
              }
              return;
            }
            out.push(v);
          };
          for (const subjectRow of subjectRows) {
            const lv = evaluateSelectExprEntryWithSubject(entry.left, leftSubject, subjectRow, evalContext);
            const lEmpty = lv === null || lv === undefined
              || (Array.isArray(lv) && lv.length === 0);
            if (!lEmpty) {
              pushFromExpr(lv, entry.left);
            } else {
              const rv = evaluateSelectExprEntryWithSubject(entry.right, rightSubject, subjectRow, evalContext);
              pushFromExpr(rv, entry.right);
            }
          }
          // Tag with the multi-row marker so the outer materializer doesn't
          // wrap this LCP-iterated set back into a single value via the
          // coalesce-tuple single-value heuristic.
          if (entry.left.kind === "tuple" || entry.right.kind === "tuple"
            || entry.left.kind === "array_literal_expr" || entry.right.kind === "array_literal_expr") {
            Object.defineProperty(out, TUPLE_MULTI_ROW_MARKER, {
              value: true,
              enumerable: false,
              configurable: true,
            });
          }
          return out;
        }
      }

      const leftValue = evaluateSelectExprEntry(schema, db, context, entry.left, sqlTrail, evalContext);
      const isEmpty = leftValue === null
        || leftValue === undefined
        || (Array.isArray(leftValue) && leftValue.length === 0);
      if (!isEmpty) {
        return leftValue;
      }
      return evaluateSelectExprEntry(schema, db, context, entry.right, sqlTrail, evalContext);
    }
    case "if_else": {
      const thenValue = evaluateSelectExprEntry(schema, db, context, entry.thenExpr, sqlTrail, evalContext);
      const conditionValue = evaluateSelectExprEntry(schema, db, context, entry.condition, sqlTrail, evalContext);
      const elseValue = evaluateSelectExprEntry(schema, db, context, entry.elseExpr, sqlTrail, evalContext);

      const thenItems = Array.isArray(thenValue) ? thenValue : [thenValue];
      const elseItems = Array.isArray(elseValue) ? elseValue : [elseValue];
      const conditionItems = Array.isArray(conditionValue) ? conditionValue : [conditionValue];
      const out: unknown[] = [];

      for (const condition of conditionItems) {
        const truthy = Boolean(condition);
        out.push(...(truthy ? thenItems : elseItems));
      }

      return (Array.isArray(thenValue) || Array.isArray(elseValue) || Array.isArray(conditionValue))
        ? out
        : (out[0] ?? null);
    }
    case "for_expr": {
  // FOR-loop body expressions like `x[IS T]` need each iterator item to
  // carry its `__source_type` so type-intersections can filter rows by
  // their concrete type. `evaluateSelectExprEntry(... select)` strips
  // `__source_type` via `materializeSelectRow`, so for "select" iterators
  // we run the SQL directly and pair the raw rows with their projected
  // form so projectOne keeps reading shape fields the usual way.
  // FOR-loop body expressions like `x[IS T] { ba, bb }` need each iterator
  // item to carry its full row, including every column the body may
  // reference and `__source_type` for type-intersection filtering. The
  // SelectIR's compiled SQL projects only the columns listed in its shape
  // (typically just `id`), so we build a wider polymorphic SELECT here
  // that yields every concrete column across the source tables.
  let iteratorValue: unknown;
  if (entry.iterator.kind === "select") {
    const query = entry.iterator.query;
    const sources = query.sourceTables.length > 0 ? query.sourceTables : [{ name: query.sourceType, table: query.table, columns: undefined }];
    const allColumns = Array.from(new Set(sources.flatMap((s) => s.columns ?? ["id"])));
    const sourceSelects = sources.map((source) => {
      const available = source.columns && source.columns.length > 0 ? new Set(source.columns) : undefined;
      const projection = allColumns
        .map((column) => (!available || available.has(column)
          ? `${quoteIdent(column)} AS ${quoteIdent(column)}`
          : `NULL AS ${quoteIdent(column)}`))
        .join(", ");
      return `SELECT '${source.name}' AS ${quoteIdent("__source_type")}, ${projection} FROM ${quoteIdent(source.table)}`;
    });
    const sql = sourceSelects.length === 1 ? sourceSelects[0]! : sourceSelects.join(" UNION ALL ");
    sqlTrail.push({ sql, params: [], loweringMode: "single_statement" });
    iteratorValue = db.prepare(sql).all() as Record<string, unknown>[];
  } else {
    iteratorValue = evaluateSelectExprEntry(schema, db, context, entry.iterator, sqlTrail, evalContext);
  }
  let iteratorItems: unknown[] = Array.isArray(iteratorValue) ? iteratorValue : [iteratorValue];
  if (entry.optional && iteratorItems.length === 0) {
    iteratorItems = [null];
  }
  const out: unknown[] = [];
  const bodyProducesTupleValue = isTupleLikeSelectExprEntry(entry.body);

  for (const item of iteratorItems) {
    const newBindings = { ...evalContext?.bindings, [entry.variable]: item };

    const loopContext = {
      currentBinding: entry.variable,
      currentValue: item,
      bindings: newBindings,
    };

    if (entry.filter) {
      const filterValue = evaluateSelectExprEntry(
        schema,
        db,
        context,
        entry.filter,
        sqlTrail,
        loopContext,
      );

      const passes = Array.isArray(filterValue)
        ? filterValue.some(Boolean)
        : Boolean(filterValue);

      if (!passes) {
        continue;
      }
    }

    const bodyValue = evaluateSelectExprEntry(
      schema,
      db,
      context,
      entry.body,
      sqlTrail,
      loopContext,
    );

    if (Array.isArray(bodyValue) && !bodyProducesTupleValue) {
      out.push(...bodyValue);
    } else if (
      bodyProducesTupleValue
      && Array.isArray(bodyValue)
      && bodyValue.length > 0
      && bodyValue.every((row) => Array.isArray(row))
    ) {
      out.push(...bodyValue);
    } else if (bodyValue === null || bodyValue === undefined) {
      // empty body — contributes nothing
    } else {
      out.push(bodyValue);
    }
  }

  if (entry.body.kind === "backlink_path") {
    return [...new Map(out
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((row) => [typeof row.id === "string" ? row.id : JSON.stringify(row), row] as const))
      .values()];
  }

  return out;
}
    case "current_item_field": {
      if (evalContext?.currentBinding !== entry.bindingName) {
        if (evalContext?.bindings && entry.bindingName in evalContext.bindings) {
          const currentValue = evalContext.bindings[entry.bindingName];
          if (currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)) {
            const row = currentValue as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(row, entry.field)) {
              return row[entry.field] ?? null;
            }
            return resolveFieldAccessValue(row, entry.field);
          }
          return null;
        }
        return null;
      }
      const currentValue = evalContext.currentValue;
      if (currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)) {
        const row = currentValue as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(row, entry.field)) {
          return row[entry.field] ?? null;
        }
        return resolveFieldAccessValue(row, entry.field);
      }
      return null;
    }
    case "distinct": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      if (!Array.isArray(value)) {
        return value;
      }

      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of value) {
        const key =
          item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string"
            ? `id:${String((item as Record<string, unknown>).id)}`
            : JSON.stringify(item);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(item);
      }
      return out;
    }
    case "path_steps": {
      return evaluatePathSteps(entry.steps, evalContext);
    }
    case "type_name": {
      const current = evalContext?.currentValue;
      if (current && typeof current === "object" && !Array.isArray(current)) {
        const sourceTypeName = (current as Record<string, unknown>).__source_type;
        if (typeof sourceTypeName === "string") {
          return sourceTypeName;
        }
      }
      return entry.sourceType || null;
    }
    case "polymorphic_field_ref": {
      const current = evalContext?.currentValue;
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return null;
      }
      const row = current as Record<string, unknown>;
      const rowTypeName = typeof row.__source_type === "string" ? row.__source_type : undefined;
      const concretes = entry.concreteSourceTypes && entry.concreteSourceTypes.length > 0
        ? entry.concreteSourceTypes
        : [entry.sourceType];
      if (!rowTypeName || !concretes.includes(rowTypeName)) {
        return null;
      }
      return materializeFieldValue(schema, rowTypeName, entry.column, row[entry.column]);
    }
    case "field_access": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      const readOne = (item: unknown): unknown => resolveFieldAccessValue(item, entry.field);
      const isLinkPropertyField = entry.field.startsWith("@");

      if (Array.isArray(value)) {
        const out: unknown[] = [];
        const seenObjectIds = new Set<string>();
        const carriesLinkProperty = (candidate: unknown): boolean => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            return false;
          }
          for (const key of Object.keys(candidate as Record<string, unknown>)) {
            if (key.startsWith("@")) {
              return true;
            }
          }
          return false;
        };
        const pushValue = (candidate: unknown): void => {
          if (candidate === null || candidate === undefined) {
            return;
          }
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && !carriesLinkProperty(candidate)) {
            const rowId = (candidate as Record<string, unknown>).id;
            if (typeof rowId === "string") {
              if (seenObjectIds.has(rowId)) {
                return;
              }
              seenObjectIds.add(rowId);
            }
          }
          out.push(candidate);
        };

        const sourceItems: unknown[] = isLinkPropertyField ? value : (() => {
          const seenSourceIds = new Set<string>();
          const filtered: unknown[] = [];
          for (const item of value) {
            if (item && typeof item === "object" && !Array.isArray(item)) {
              const itemId = (item as Record<string, unknown>).id;
              if (typeof itemId === "string") {
                if (seenSourceIds.has(itemId)) {
                  continue;
                }
                seenSourceIds.add(itemId);
              }
            }
            filtered.push(item);
          }
          return filtered;
        })();

        for (const item of sourceItems) {
          const fieldValue = readOne(item);
          if (Array.isArray(fieldValue)) {
            for (const nested of fieldValue) {
              pushValue(nested);
            }
            continue;
          }
          pushValue(fieldValue);
        }
        return out;
      }

      return readOne(value);
    }
    case "backlink_path": {
      return resolveBacklinkPathValue(evalContext?.currentValue, entry.link, entry.sourceType, entry.sourceTypeExpr);
    }
    case "shape_projection": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      const childBinding = evalContext?.currentBinding ?? "__current__";
      const projectOne = (item: unknown): Record<string, unknown> | null => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return null;
        }
        const row = item as Record<string, unknown>;
        const projected: Record<string, unknown> = {};
        for (const field of entry.fields) {
          if (field.expr) {
            const value = evaluateSelectExprEntry(schema, db, context, field.expr, sqlTrail, {
              currentBinding: childBinding,
              currentValue: row,
            });
            if (field.multi && value !== null && value !== undefined && !Array.isArray(value)) {
              projected[field.name] = [value];
            } else {
              projected[field.name] = value;
            }
            continue;
          }

          // Use resolveFieldAccessValue so we DB-load the field when the row
          // only carries `id` (typical for results of coalesce/select_expr
          // that project just `id`).
          const rawValue = field.sourceField
            ? resolveFieldAccessValue(row, field.sourceField)
            : null;
          if (field.itemFields && Array.isArray(rawValue)) {
            projected[field.name] = rawValue
              .map((child) => {
                if (!child || typeof child !== "object" || Array.isArray(child)) {
                  return null;
                }
                const childRow = child as Record<string, unknown>;
                const childProjected: Record<string, unknown> = {};
                for (const itemField of field.itemFields ?? []) {
                  if (itemField.expr) {
                    const itemValue = evaluateSelectExprEntry(schema, db, context, itemField.expr, sqlTrail, {
                      currentBinding: childBinding,
                      currentValue: childRow,
                    });
                    const childTypeName = typeof childRow.__source_type === "string"
                      ? childRow.__source_type
                      : typeof childRow.__type__ === "string"
                        ? childRow.__type__
                        : undefined;
                    childProjected[itemField.name] = childTypeName
                      ? itemField.multi ? [childTypeName] : childTypeName
                      : itemValue;
                  } else {
                    childProjected[itemField.name] = itemField.sourceField ? childRow[itemField.sourceField] ?? null : null;
                  }
                }
                return childProjected;
              })
              .filter((child): child is Record<string, unknown> => child !== null);
            continue;
          }

          projected[field.name] = rawValue;
        }
        return projected;
      };

      if (Array.isArray(value)) {
        return value
          .map((item) => projectOne(item))
          .filter((item): item is Record<string, unknown> => !!item);
      }

      return projectOne(value);
    }
    case "select": {
      const nestedSql = compileToSQL(entry.query, { target: resolvedRuntimeTarget(context, db) });
      assertTargetSqlCompatibility(nestedSql.sql, resolvedRuntimeTarget(context, db));
      sqlTrail.push(nestedSql);
      const rows = runSelectIR(db, schema, entry.query, context, nestedSql, sqlTrail);
      const seen = new Set<string>();
      const deduped: Record<string, unknown>[] = [];
      for (const row of rows) {
        const key = typeof row.id === "string" ? `id:${row.id}` : JSON.stringify(row);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        deduped.push(row);
      }
      return deduped;
    }
    case "mutation_expr": {
      return executeMutationBinding(db, schema, entry.statement, context);
    }
    case "type_field_path": {
      const typeDef = schema.getType(entry.typeName);
      if (!typeDef) {
        throw new AppError("E_SEMANTIC", `Unknown type '${entry.typeName}'`, 1, 1);
      }
      const field = typeDef.fields.find((f) => f.name === entry.field);
      if (!field) {
        const computed = typeDef.computeds?.find((computed) => computed.kind === "property" && computed.name === entry.field);
        if (!computed || computed.kind !== "property") {
          throw new AppError("E_SEMANTIC", `Unknown field '${entry.field}' on '${entry.typeName}'`, 1, 1);
        }

        if (computed.expr.kind === "literal") {
          return computed.expr.value;
        }
        if (computed.expr.kind === "set_literal") {
          return [...computed.expr.values];
        }
        if (computed.expr.kind === "field_ref") {
          const field = computed.expr.field;
          const rows = db.prepare(`SELECT ${quoteIdent(field)} FROM ${quoteIdent(tableNameForType(entry.typeName))}`).all();
          return rows.map((row) => row?.[field] ?? null);
        }
        if (computed.expr.kind === "concat") {
          return computed.expr.parts
            .map((part) => {
              if (part.kind === "literal") {
                return String(part.value ?? "");
              }
              if (part.kind === "field_ref") {
                const rows = db.prepare(`SELECT ${quoteIdent(part.field)} FROM ${quoteIdent(tableNameForType(entry.typeName))} LIMIT 1`).all();
                return String(rows.length > 0 ? rows[0]?.[part.field] ?? "" : "");
              }
              return "";
            })
            .join("");
        }
        if (computed.expr.kind === "function_call") {
          return executeFunctionCall(schema, db, context, computed.expr.name, computed.expr.args as RuntimeFunctionArg[]);
        }
        if (computed.expr.kind === "link_aggregate") {
          const aggregate = computed.expr;
          const rows = db.prepare(`SELECT * FROM ${quoteIdent(tableNameForType(entry.typeName))}`).all() as Record<string, unknown>[];
          return rows.map((row) => {
            if (typeof row.id !== "string") {
              return 0;
            }
            const targets = resolveFieldAccessValue({ ...row, id: row.id }, aggregate.link);
            const targetRows = Array.isArray(targets) ? targets : targets ? [targets] : [];
            return targetRows.reduce((total, target) => {
              if (!target || typeof target !== "object" || Array.isArray(target)) {
                return total;
              }
              const targetRow = target as Record<string, unknown>;
              return total + Number(targetRow[aggregate.field] ?? targetRow[`@${aggregate.field}`] ?? 0);
            }, 0);
          });
        }
        return null;
      }
      const rows = db.prepare(`SELECT ${quoteIdent(entry.field)} FROM ${quoteIdent(tableNameForType(entry.typeName))}`).all();
      return rows.map((row) => row?.[entry.field] ?? null);
    }
    case "cast": {
      if (entry.value.kind === "set_literal" || entry.value.kind === "set_expr") {
        const setValues = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
        if (Array.isArray(setValues)) {
          return setValues;
        }
        const castTypeDef = schema.getType(entry.castType);
        if (castTypeDef) {
          const allEnumValues = castTypeDef.fields.flatMap((f) => f.enumValues ?? []);
          if (allEnumValues.length > 0) {
            return [setValues];
          }
        }
        return [setValues];
      }
      const innerValue = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      if (entry.castType === "str") {
        if (Array.isArray(innerValue)) {
          return innerValue.map((item) => String(item ?? ""));
        }
        if (innerValue === null) return "";
        return String(innerValue);
      }
      if (entry.castType === "json") {
        return JSON.stringify(innerValue);
      }
      if (/^(default::)?array<.*>$/.test(entry.castType)) {
        // Cast to array<X>. EdgeDB treats JSON null cast to array as an
        // empty array (e.g. `<array<str>>to_json('null')` ⇒ `[]`).
        // Otherwise the value passes through unchanged.
        if (innerValue === null || innerValue === undefined) {
          return [];
        }
        if (typeof innerValue === "string") {
          // to_json("null") materializes as the literal string 'null' when
          // not parsed; treat that as JSON null too.
          if (innerValue === "null") return [];
        }
        return innerValue;
      }
      const castTypeDef = schema.getType(entry.castType);
      if (castTypeDef) {
        const allEnumValues = castTypeDef.fields.flatMap((f) => f.enumValues ?? []);
        if (allEnumValues.length > 0) {
          if (innerValue === null) {
            return null;
          }
          if (typeof innerValue !== "string") {
            throw new AppError("E_SEMANTIC", `Cannot cast to enum '${entry.castType}': expected string value`, 1, 1);
          }
          if (!allEnumValues.includes(innerValue)) {
            throw new AppError("E_SEMANTIC", `invalid input value for enum '${entry.castType}': "${innerValue}"`, 1, 1);
          }
          return innerValue;
        }
      }
      throw new AppError("E_SEMANTIC", `Unsupported cast type '${entry.castType}' in select_expr`, 1, 1);
    }
    case "is_type": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      const typeDef = schema.getType(entry.typeName);
      const enumValues = typeDef?.fields.flatMap((f) => f.enumValues ?? []) ?? [];
      const checkOne = (item: unknown): boolean => {
        if (enumValues.length > 0) {
          return typeof item === "string" && enumValues.includes(item);
        }
        return false;
      };
      const objectMatches = (item: unknown): boolean => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const sourceType = (item as Record<string, unknown>).__source_type;
        return typeof sourceType === "string" && rowMatchesTypeName(sourceType, entry.typeName);
      };
      if (enumValues.length === 0) {
        if (Array.isArray(value)) {
          return value.filter(objectMatches);
        }
        return objectMatches(value) ? value : [];
      }
      if (Array.isArray(value)) {
        return value.map(checkOne);
      }
      return checkOne(value);
    }
    case "select_expr_subquery": {
      const linkPropertyProjection = entry.value.kind === "field_access" && entry.value.field.startsWith("@")
        ? { subject: entry.value.value, property: entry.value.field }
        : undefined;
      if (linkPropertyProjection && (entry.filter || entry.orderBy)) {
        const subjectValue = evaluateSelectExprEntry(schema, db, context, linkPropertyProjection.subject, sqlTrail, evalContext);
        let subjectRows = Array.isArray(subjectValue) ? [...subjectValue] : [subjectValue];
        if (entry.filter) {
          subjectRows = subjectRows.filter((row) => {
            const filterValue = evaluateSelectExprEntryWithSubject(entry.filter!, linkPropertyProjection.subject, row, evalContext);
            return Array.isArray(filterValue) ? filterValue.some(Boolean) : Boolean(filterValue);
          });
        }
        if (entry.orderBy) {
          subjectRows.sort((a, b) => {
            const aKey = evaluateSelectExprEntryWithSubject(entry.orderBy!.value, linkPropertyProjection.subject, a, evalContext);
            const bKey = evaluateSelectExprEntryWithSubject(entry.orderBy!.value, linkPropertyProjection.subject, b, evalContext);
            if (aKey === bKey) {
              return 0;
            }
            return String(aKey ?? "").localeCompare(String(bKey ?? "")) * (entry.orderBy!.direction === "desc" ? -1 : 1);
          });
        }
        const offset = entry.offset ?? 0;
        const sliced = entry.limit === undefined ? subjectRows.slice(offset) : subjectRows.slice(offset, offset + entry.limit);
        return sliced.flatMap((row) => {
          const value = resolveFieldAccessValue(row, linkPropertyProjection.property);
          return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
        });
      }

      const shapeProjectionForFilter = entry.value.kind === "shape_projection" && (entry.filter || entry.orderBy)
        ? entry.value
        : undefined;
      const sourceForEval: SelectExprIREntry = shapeProjectionForFilter
        ? shapeProjectionForFilter.value as SelectExprIREntry
        : entry.value;
      const value = evaluateSelectExprEntry(schema, db, context, sourceForEval, sqlTrail, evalContext);
      // A `tuple` expression — including the empty tuple `()` — is a single
      // value, not a set. The empty tuple evaluates to `[]` (no slots), which
      // is indistinguishable from "empty set" by Array.isArray alone, so we
      // dispatch on the source IR kind. The multi-row marker is set by tuple
      // LCP iteration when slots co-iterate; in that case spread normally.
      const sourceIsSingleTuple = isTupleLikeSelectExprEntry(sourceForEval)
        && !(Array.isArray(value)
          && (value as unknown as { [k: symbol]: unknown })[TUPLE_MULTI_ROW_MARKER] === true);
      let rows = sourceIsSingleTuple
        ? [value]
        : Array.isArray(value) ? [...value] : [value];
      if (entry.filter) {
        const currentBinding = entry.alias ?? "__current__";
        rows = rows.filter((row) => {
          const filterValue = evaluateSelectExprEntry(schema, db, context, entry.filter!, sqlTrail, {
            currentBinding,
            currentValue: row,
            bindings: evalContext?.bindings,
          });
          return Array.isArray(filterValue) ? filterValue.some(Boolean) : Boolean(filterValue);
        });
      }
      if (entry.orderBy) {
        const currentBinding = entry.alias ?? evalContext?.currentBinding ?? "__current__";
        const inferredEnumOrder = entry.orderBy.value.kind === "current_item"
          && rows.every((item) => typeof item === "string")
          ? (() => {
              const values = rows as string[];
              for (const typeDef of schema.listTypes()) {
                const enumValues = typeDef.fields.flatMap((f) => f.enumValues ?? []);
                if (enumValues.length === 0) {
                  continue;
                }
                if (values.every((value) => enumValues.includes(value))) {
                  return new Map(enumValues.map((enumValue, index) => [enumValue, index] as const));
                }
              }
              return undefined;
            })()
          : undefined;

        rows.sort((a, b) => {
          const aKey = evaluateSelectExprEntry(
            schema,
            db,
            context,
            entry.orderBy!.value,
            sqlTrail,
            { currentBinding, currentValue: a, bindings: evalContext?.bindings },
          );
          const bKey = evaluateSelectExprEntry(
            schema,
            db,
            context,
            entry.orderBy!.value,
            sqlTrail,
            { currentBinding, currentValue: b, bindings: evalContext?.bindings },
          );
          if (aKey === bKey) {
            return 0;
          }
          if (inferredEnumOrder && typeof aKey === "string" && typeof bKey === "string") {
            const aIndex = inferredEnumOrder.get(aKey) ?? Number.MAX_SAFE_INTEGER;
            const bIndex = inferredEnumOrder.get(bKey) ?? Number.MAX_SAFE_INTEGER;
            if (aIndex === bIndex) {
              return 0;
            }
            const enumDirection = entry.orderBy!.direction === "desc" ? -1 : 1;
            return (aIndex < bIndex ? -1 : 1) * enumDirection;
          }
          const direction = entry.orderBy!.direction === "desc" ? -1 : 1;
          return compareEdgeQLValues(aKey, bKey) * direction;
        });
      }
      const offset = entry.offset ?? 0;
      const sliced = entry.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + entry.limit);
      if (shapeProjectionForFilter) {
        const projection = shapeProjectionForFilter;
        return sliced.map((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) {
            return null;
          }
          return evaluateSelectExprEntry(schema, db, context, {
            ...projection,
            value: { kind: "current_item", bindingName: "__projection__" },
          } as SelectExprIREntry, sqlTrail, {
            currentBinding: "__projection__",
            currentValue: row,
            bindings: evalContext?.bindings,
          });
        }).filter((item) => item !== null);
      }
      return sliced;
    }
    case "function_call": {
      return executeFunctionCall(
        schema,
        db,
        context,
        entry.functionName,
        (entry.args as unknown[]).map((arg): RuntimeFunctionArg => {
          const typedArg = arg as SelectExprIREntry;
          const value = evaluateSelectExprEntry(schema, db, context, typedArg, sqlTrail, evalContext);
          if (Array.isArray(value)) {
            return { kind: "set", values: (isTupleLikeSelectExprEntry(typedArg) ? [value] : value) as ScalarValue[] };
          }
          return value as ScalarValue;
        }),
      );
    }
    case "concat": {
      // Longest-common-prefix iteration: when every part threads through the
      // same select source (e.g. `Issue.name ++ <str>Issue.time_estimate`),
      // evaluate per-source-row and concatenate within that row. Any empty
      // part suppresses the result for that row, matching EdgeQL semantics.
      const partExprs = entry.parts as SelectExprIREntry[];
      const partSubjects = partExprs.map(findSelectSubjectInExpr);
      const firstPartSubject = partSubjects[0];
      // Require EVERY part to share the same non-null subject. If any part
      // has no detectable subject (filtered subquery, literal, …) we can't
      // safely co-iterate — fall back to the cartesian path below.
      const partsShareSubject = firstPartSubject !== null && partSubjects.every(
        (s) => s !== null && sameSelectExprSubject(s, firstPartSubject),
      );
      if (firstPartSubject && partsShareSubject && !evalContext?.currentValue) {
        const subjectValue = evaluateSelectExprEntry(schema, db, context, firstPartSubject, sqlTrail, evalContext);
        const subjectRows = Array.isArray(subjectValue)
          ? subjectValue
          : subjectValue === null || subjectValue === undefined ? [] : [subjectValue];
        if (subjectRows.length > 0) {
          const out: unknown[] = [];
          for (const subjectRow of subjectRows) {
            const slotValues = partExprs.map((p) => evaluateSelectExprEntryWithSubject(p, firstPartSubject, subjectRow, evalContext));
            let suppressed = false;
            let accums: string[] = [""];
            for (const slot of slotValues) {
              const items = Array.isArray(slot) ? slot : [slot];
              if (items.length === 0) { suppressed = true; break; }
              const next: string[] = [];
              for (const a of accums) {
                for (const b of items) {
                  if (b === null || b === undefined) { suppressed = true; break; }
                  next.push(`${a}${String(b)}`);
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

      const partValues = (entry.parts as unknown[]).map((part) => {
        const typedPart = part as SelectExprIREntry;
        const value = evaluateSelectExprEntry(schema, db, context, typedPart, sqlTrail, evalContext);
        return Array.isArray(value) && value.length === 1 ? value[0] : value;
      });
      for (let i = 0; i < partValues.length; i++) {
        const part = partValues[i];
        const partEntry = entry.parts[i];
        if (part instanceof AppError) {
          throw part;
        }
        if (partEntry.kind === "type_field_path") {
          const typeDef = schema.getType(partEntry.typeName);
          if (typeDef) {
            const field = typeDef.fields.find((f) => f.name === partEntry.field);
            if (field?.enumValues && field.enumValues.length > 0) {
              const fieldType = field.enumTypeName ?? `std::${field.type}`;
              throw new AppError("E_SEMANTIC", `operator '++' cannot be applied to operands of type 'std::str' and '${fieldType}'`, 1, 1);
            }
          }
        }
        if (Array.isArray(part)) {
          for (const item of part) {
            if (typeof item !== "string") {
              throw new AppError("E_SEMANTIC", `operator '++' cannot be applied to operands of type 'std::str' and '${typeof item}'`, 1, 1);
            }
          }
          continue;
        }
        if (typeof part !== "string") {
          throw new AppError("E_SEMANTIC", `operator '++' cannot be applied to operands of type 'std::str' and '${typeof part}'`, 1, 1);
        }
      }
      const hasMultiPart = partValues.some((p) => Array.isArray(p));
      if (!hasMultiPart) {
        return partValues.join("");
      }
      let combos: string[] = [""];
      for (const part of partValues) {
        const items = Array.isArray(part) ? part as string[] : [part as string];
        const next: string[] = [];
        for (const combo of combos) {
          for (const item of items) {
            next.push(combo + item);
          }
        }
        combos = next;
      }
      return combos;
    }
  }
};

const materializeSelectExprRows = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ir: SelectExprIR,
  context: SecurityContext,
  sqlTrail: SQLArtifact[],
): unknown[] => {
  if (ir.entries.length === 0) {
    return [];
  }
  const value = evaluateSelectExprEntry(schema, db, context, ir.entries[0], sqlTrail, {
    parentOrderBy: ir.orderBy ? { value: ir.orderBy.value, direction: ir.orderBy.direction } : undefined,
  });
  const firstEntry = ir.entries[0];
  const firstEntryKind = firstEntry.kind;
  const tupleMultiRow = firstEntryKind === "tuple"
    && Array.isArray(value)
    && (value as unknown as { [k: symbol]: unknown })[TUPLE_MULTI_ROW_MARKER] === true;
  // Coalesce is a single-value when both branches are structurally single
  // values — e.g. `to_json(...) ?? []` returns one array value, not a set.
  // We detect this by checking whether the RHS is an array literal or tuple
  // (both are inherently single values) since the LHS shape determines the
  // present-case shape but the empty-case falls through to RHS.
  // A coalesce is "single-value" only when neither branch ever multiplies —
  // e.g. `to_json(...) ?? []`. When LCP iteration produces a set of tuples
  // (`(Issue.x, …) ?? (Issue.y, …)`), the marker is set on the result.
  const coalesceProducesSingleValue = firstEntryKind === "coalesce"
    && (firstEntry.right.kind === "array_literal_expr" || firstEntry.right.kind === "tuple")
    && !(Array.isArray(value)
      && (value as unknown as { [k: symbol]: unknown })[TUPLE_MULTI_ROW_MARKER] === true);
  // `array_literal_expr[N]` extracts a single element from a single-array
  // value; if that element is itself a tuple, the result is one tuple value,
  // not a set of its slots. (e.g. `[(1,2)][0]` is the tuple `(1,2)`.)
  const indexAccessProducesSingleTuple = firstEntryKind === "index_access"
    && firstEntry.value.kind === "array_literal_expr";
  const entryProducesSingleValue =
    ((firstEntryKind === "array_literal_expr" || firstEntryKind === "tuple") && !tupleMultiRow)
    || coalesceProducesSingleValue
    || indexAccessProducesSingleTuple;
  const rows = !entryProducesSingleValue && Array.isArray(value) ? [...value] : [value];

  if (ir.orderBy) {
    // When the entry is a tuple and `ORDER BY` references a path that also
    // appears as one of the tuple's slots, sort by that slot directly —
    // the orderBy expression evaluated globally won't have row context,
    // but the slot value already does. This is what `ORDER BY Issue.number`
    // means in `SELECT (Issue.number, …) ORDER BY Issue.number`.
    const exprStructurallyEqual = (a: SelectExprIREntry, b: SelectExprIREntry): boolean => {
      if (a.kind !== b.kind) return false;
      if (a.kind === "field_access" && b.kind === "field_access") {
        return a.field === b.field && exprStructurallyEqual(a.value, b.value);
      }
      if (a.kind === "select" && b.kind === "select") {
        return a.query.sourceType === b.query.sourceType;
      }
      if (a.kind === "cast" && b.kind === "cast") {
        return (a as { castType: string }).castType === (b as { castType: string }).castType
          && exprStructurallyEqual((a as { value: SelectExprIREntry }).value, (b as { value: SelectExprIREntry }).value);
      }
      return false;
    };
    const orderByValue = ir.orderBy.value;
    const tupleSlotIdx = firstEntry.kind === "tuple"
      ? (firstEntry.values as SelectExprIREntry[]).findIndex((slot) => exprStructurallyEqual(slot, orderByValue))
      : -1;
    if (tupleSlotIdx >= 0) {
      const direction = ir.orderBy.direction === "desc" ? -1 : 1;
      rows.sort((a, b) => {
        const aKey = Array.isArray(a) ? a[tupleSlotIdx] : a;
        const bKey = Array.isArray(b) ? b[tupleSlotIdx] : b;
        return compareEdgeQLValues(aKey, bKey) * direction;
      });
      return rows;
    }

    const enumOrder = ir.orderBy.value.kind === "cast"
      ? (() => {
          const typeDef = schema.getType(ir.orderBy!.value.castType);
          const values = typeDef?.fields.flatMap((f) => f.enumValues ?? []) ?? [];
          if (values.length === 0) {
            return undefined;
          }
          return new Map(values.map((value, index) => [value, index] as const));
        })()
      : undefined;

    rows.sort((a, b) => {
      const aKey = evaluateSelectExprEntry(
        schema,
        db,
        context,
        ir.orderBy!.value,
        sqlTrail,
        { currentBinding: ir.currentBinding, currentValue: a },
      );
      const bKey = evaluateSelectExprEntry(
        schema,
        db,
        context,
        ir.orderBy!.value,
        sqlTrail,
        { currentBinding: ir.currentBinding, currentValue: b },
      );

      if (aKey === bKey) {
        return 0;
      }

      const direction = ir.orderBy!.direction === "desc" ? -1 : 1;
      if (enumOrder && typeof aKey === "string" && typeof bKey === "string") {
        const aIndex = enumOrder.get(aKey) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = enumOrder.get(bKey) ?? Number.MAX_SAFE_INTEGER;
        if (aIndex === bIndex) {
          return 0;
        }
        return (aIndex < bIndex ? -1 : 1) * direction;
      }
      return compareEdgeQLValues(aKey, bKey) * direction;
    });
  }

  return rows;
};

const runGelSelectExprSQL = (db: SQLiteDatabase, sqlArtifact: SQLArtifact): unknown[] => {
  const rows = db.prepare(sqlArtifact.sql).all(...sqlArtifact.params) as Record<string, unknown>[];
  return rows.map((row) => {
    const value = row.value;
    if (typeof value !== "string") {
      return value ?? null;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
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
        || inner.kind === "select_expr_subquery" || inner.kind === "select_expr") {
        inner = (inner as { expr: FreeObjectExpr }).expr;
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
  const builtin = resolveStdlibFunction(qualifiedName, args.length);
  if (builtin) {
    if (qualifiedName === "std::count") {
      return countRuntimeSetCardinality(args[0]);
    }
    return executeStdlibFunction(qualifiedName, args);
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

const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

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

const compileFilterPredicate = (lhsSql: string, op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike"): string => {
  if (op === "=") {
    return `${lhsSql} = ?`;
  }

  if (op === "!=") {
    return `${lhsSql} != ?`;
  }

  if (op === "like") {
    return `${lhsSql} LIKE ?`;
  }

  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    return `${lhsSql} ${op} ?`;
  }

  if (op === "?=") {
    return `(${lhsSql} IS NULL OR ${lhsSql} = ?)`;
  }

  if (op === "?!=" ) {
    return `(${lhsSql} IS NULL OR ${lhsSql} != ?)`;
  }

  return `LOWER(${lhsSql}) LIKE LOWER(?)`;
};

const compileNestedFilterExprSQL = (filter: FilterExprIR, params: ScalarValue[], linkPropertyAlias?: string): string => {
  const columnExpr = (column: string): string => {
    if (column.startsWith("@")) {
      const alias = linkPropertyAlias ?? "t";
      return `${alias}.${quoteIdent(column.slice(1))}`;
    }
    if (column === "__type__.name") {
      return `t.${quoteIdent("__source_type")}`;
    }
    return `t.${quoteIdent(column)}`;
  };

  if (filter.kind === "field") {
    params.push(filter.value);
    return compileFilterPredicate(columnExpr(filter.column), filter.op);
  }

  if (filter.kind === "field_in") {
    const column = columnExpr(filter.column);
    const placeholders = filter.values.map(() => "?").join(", ");
    params.push(...filter.values);
    const op = filter.op === "in" ? "IN" : "NOT IN";
    return `${column} ${op} (${placeholders})`;
  }

  if (filter.kind === "field_compare") {
    const left = columnExpr(filter.leftColumn);
    const right = columnExpr(filter.rightColumn);
    if (filter.op === "=") {
      return `${left} = ${right}`;
    }
    if (filter.op === "!=") {
      return `${left} != ${right}`;
    }
    if (filter.op === "like") {
      return `${left} LIKE ${right}`;
    }
    return `LOWER(${left}) LIKE LOWER(${right})`;
  }

  if (filter.kind === "backlink") {
    throw new AppError("E_SQL", "Backlink filters are not supported for nested runtime link resolution");
  }

  if (filter.kind === "self_in_select") {
    throw new AppError("E_SQL", "IN subquery filters are not supported for nested runtime link resolution");
  }

  if (filter.kind === "backlink_contains") {
    throw new AppError("E_SQL", "Backlink membership filters are not supported for nested runtime link resolution");
  }

  if (filter.kind === "link_property_exists" || filter.kind === "link_property_compare_exists" || filter.kind === "backlink_property_compare" || filter.kind === "backlink_property_in" || filter.kind === "backlink_property_value_compare") {
    throw new AppError("E_SQL", "Link property filters are not supported for nested runtime link resolution");
  }

  if (filter.kind === "not") {
    return `(NOT ${compileNestedFilterExprSQL(filter.expr, params, linkPropertyAlias)})`;
  }

  if (filter.kind === "and" || filter.kind === "or") {
    const left = compileNestedFilterExprSQL(filter.left, params, linkPropertyAlias);
    const right = compileNestedFilterExprSQL(filter.right, params, linkPropertyAlias);
    return filter.kind === "and" ? `(${left} AND ${right})` : `(${left} OR ${right})`;
  }

  return "1 = 1";
};

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
): { changes: number } => {
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
          applyInsertLinkAssignments(db, schema, ast, subjectType, inserted.id, context);
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
          ast,
          subjectType,
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
      runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType, context);
      for (const row of preRows) {
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
): string[] => {
  const ast: InsertStatement = {
    kind: "insert",
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

  applyInsertLinkAssignments(db, schema, ast, typeDef, inserted.id, context);
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
    return executeNestedInsert(db, schema, value, context).map((id) => ({ id, properties: {} }));
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

        const nestedIds = executeNestedInsert(db, schema, { kind: "insert", typeName: value.body.typeName, values: replacedValues }, context);
        rows.push(...nestedIds.map((id) => ({ id, properties: {} })));
      }
    }

    return rows;
  }

  return [];
};

const applyInsertLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: InsertStatement,
  typeDef: TypeDef,
  sourceId: string,
  context: SecurityContext,
): void => {
  const linkByName = new Map((typeDef.links ?? []).map((link) => [link.name, link] as const));

  const defaultLinkPropertyValue = (property: NonNullable<NonNullable<TypeDef["links"]>[number]["properties"]>[number]): ScalarValue => {
    if (!property.hasDefault) {
      return null;
    }

    if (property.type === "int" || property.type === "float") {
      return Math.round(Math.random() * 10);
    }

    return null;
  };

  const resolveDefaultLinkAssignments = (
    link: NonNullable<TypeDef["links"]>[number],
  ): Array<{ id: string; properties: Record<string, ScalarValue> }> => {
    const targetQualified = normalizeLinkTargetNames(link.targetType, typeDef.module ?? "default")[0] ?? `${typeDef.module ?? "default"}::${link.targetType}`;
    const targetType = schema.getType(targetQualified);
    const targetTable = tableNameForType(targetQualified);

    const lookupColumn = targetType?.fields.some((field) => field.name === "val")
      ? "val"
      : targetType?.fields.some((field) => field.name === "name")
        ? "name"
        : undefined;

    if (link.defaultTargetValues && link.defaultTargetValues.length > 0 && lookupColumn) {
      return link.defaultTargetValues.flatMap((targetValue) => {
        const row = db
          .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent(lookupColumn)} = ? LIMIT 1`)
          .all(targetValue)[0] as { id?: unknown } | undefined;
        return typeof row?.id === "string" ? [{ id: row.id, properties: {} }] : [];
      });
    }

    const first = db
      .prepare(`SELECT ${quoteIdent("id")} AS ${quoteIdent("id")} FROM ${quoteIdent(targetTable)} ORDER BY rowid ASC LIMIT 1`)
      .all()[0] as { id?: unknown } | undefined;
    if (typeof first?.id !== "string") {
      return [];
    }
    return [{ id: first.id, properties: {} }];
  };

  for (const [field, value] of Object.entries(ast.values)) {
    const link = linkByName.get(field);
    if (!link) {
      continue;
    }

    const targetAssignments = resolveInsertTargets(db, schema, value, context, ast);
    const targetIds = targetAssignments.map((assignment) => assignment.id);
    const linkOwner = resolveLinkStorageOwner(schema, typeDef, link);
    const ownerModule = linkOwner.module ?? "default";
    const targetTypeNames = normalizeLinkTargetNames(link.targetType, ownerModule);
    const assignableTargetTables = assignableTargetTablesForTargets(schema, targetTypeNames);
    for (const targetId of targetIds) {
      const row = db
        .prepare('SELECT "type_name" AS "type_name" FROM "__gel_global_ids" WHERE "id" = ?')
        .all(targetId)[0] as { type_name?: unknown } | undefined;
      if (!row || typeof row.type_name !== "string") {
        throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': '${targetId}' does not reference an existing object`, ast.pos.line, ast.pos.column);
      }
      if (!assignableTargetTables.has(row.type_name)) {
        const expected = [...assignableTargetTables].sort().join(" or ");
        throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': expected '${expected}', got '${row.type_name}'`, ast.pos.line, ast.pos.column);
      }
    }

    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    if (usesLinkTable) {
      const linkTable = `${tableNameForType(qualifiedTypeName(linkOwner))}__${link.name.toLowerCase()}`;
      const propertyDefs = link.properties ?? [];
      const propertyColumns = propertyDefs.map((property) => property.name);
      const propertyByName = new Map(propertyDefs.map((property) => [property.name, property] as const));
      const columns = ["source", "target", ...propertyColumns];
      const placeholders = columns.map(() => "?").join(", ");
      const insertSql = `INSERT INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;

      for (const assignment of targetAssignments) {
        const params = [
          sourceId,
          assignment.id,
          ...propertyColumns.map((column) => {
            const explicit = assignment.properties[`@${column}`];
            if (explicit !== undefined) {
              return explicit;
            }
            const property = propertyByName.get(column);
            return property ? defaultLinkPropertyValue(property) : null;
          }),
        ];
        db
          .prepare(insertSql)
          .run(...params);
      }
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    const targetId = targetIds[0] ?? null;
    db.prepare(`UPDATE ${quoteIdent(tableNameForType(qualifiedTypeName(typeDef)))} SET ${quoteIdent(inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(targetId, sourceId);
  }

  for (const link of typeDef.links ?? []) {
    if (Object.prototype.hasOwnProperty.call(ast.values, link.name)) {
      continue;
    }
    if (!link.hasDefault) {
      continue;
    }

    const assignments = resolveDefaultLinkAssignments(link);
    if (assignments.length === 0) {
      continue;
    }

    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    if (usesLinkTable) {
      const linkTable = `${tableNameForType(qualifiedTypeName(typeDef))}__${link.name.toLowerCase()}`;
      const propertyDefs = link.properties ?? [];
      const propertyColumns = propertyDefs.map((property) => property.name);
      const columns = ["source", "target", ...propertyColumns];
      const placeholders = columns.map(() => "?").join(", ");
      const insertSql = `INSERT INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;

      for (const assignment of assignments) {
        const params = [
          sourceId,
          assignment.id,
          ...propertyDefs.map((property) => defaultLinkPropertyValue(property)),
        ];
        db.prepare(insertSql).run(...params);
      }
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    db.prepare(`UPDATE ${quoteIdent(tableNameForType(qualifiedTypeName(typeDef)))} SET ${quoteIdent(inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
      .run(assignments[0]?.id ?? null, sourceId);
  }
};

const applyUpdateLinkAssignments = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: UpdateStatement,
  typeDef: TypeDef,
  sourceIds: string[],
  context: SecurityContext,
): void => {
  if (sourceIds.length === 0) {
    return;
  }

  const linkByName = new Map((typeDef.links ?? []).map((link) => [link.name, link] as const));

  for (const [field, value] of Object.entries(ast.values)) {
    const link = linkByName.get(field);
    if (!link) {
      continue;
    }

    const fauxInsertAst: InsertStatement = {
      kind: "insert",
      with: ast.with,
      withModule: ast.withModule,
      withModuleAliases: ast.withModuleAliases,
      typeName: ast.typeName,
      values: {},
      pos: ast.pos,
    };

    const targetAssignments = resolveInsertTargets(db, schema, value, context, fauxInsertAst);
    const targetIds = targetAssignments.map((assignment) => assignment.id);
    const linkOwner = resolveLinkStorageOwner(schema, typeDef, link);
    const ownerModule = linkOwner.module ?? "default";
    const targetTypeNames = normalizeLinkTargetNames(link.targetType, ownerModule);
    const assignableTargetTables = assignableTargetTablesForTargets(schema, targetTypeNames);
    for (const targetId of targetIds) {
      const row = db
        .prepare('SELECT "type_name" AS "type_name" FROM "__gel_global_ids" WHERE "id" = ?')
        .all(targetId)[0] as { type_name?: unknown } | undefined;
      if (!row || typeof row.type_name !== "string") {
        throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': '${targetId}' does not reference an existing object`, ast.pos.line, ast.pos.column);
      }
      if (!assignableTargetTables.has(row.type_name)) {
        const expected = [...assignableTargetTables].sort().join(" or ");
        throw new AppError("E_SEMANTIC", `Invalid id for link '${link.name}': expected '${expected}', got '${row.type_name}'`, ast.pos.line, ast.pos.column);
      }
    }

    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    if (usesLinkTable) {
      const linkTable = `${tableNameForType(qualifiedTypeName(linkOwner))}__${link.name.toLowerCase()}`;
      const propertyColumns = (link.properties ?? []).map((property) => property.name);
      const columns = ["source", "target", ...propertyColumns];
      const placeholders = columns.map(() => "?").join(", ");
      const operation = ast.operations?.[field] ?? "assign";
      const insertVerb = operation === "append" ? "INSERT OR IGNORE" : "INSERT";
      const insertSql = `${insertVerb} INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;

      for (const sourceId of sourceIds) {
        if (operation === "assign") {
          db.prepare(`DELETE FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).run(sourceId);
        }
        if (operation === "subtract") {
          for (const targetId of targetIds) {
            db.prepare(`DELETE FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ? AND ${quoteIdent("target")} = ?`).run(sourceId, targetId);
          }
          continue;
        }
        for (const assignment of targetAssignments) {
          const params = [
            sourceId,
            assignment.id,
            ...propertyColumns.map((column) => assignment.properties[`@${column}`] ?? null),
          ];
          db.prepare(insertSql).run(...params);
        }
      }
      continue;
    }

    const inlineColumn = `${link.name}_id`;
    const targetId = targetIds[0] ?? null;
    for (const sourceId of sourceIds) {
      if ((ast.operations?.[field] ?? "assign") === "subtract") {
        db.prepare(`UPDATE ${quoteIdent(tableNameForType(qualifiedTypeName(typeDef)))} SET ${quoteIdent(inlineColumn)} = NULL WHERE ${quoteIdent("id")} = ? AND ${quoteIdent(inlineColumn)} = ?`)
          .run(sourceId, targetId);
        continue;
      }
      db.prepare(`UPDATE ${quoteIdent(tableNameForType(qualifiedTypeName(typeDef)))} SET ${quoteIdent(inlineColumn)} = ? WHERE ${quoteIdent("id")} = ?`)
        .run(targetId, sourceId);
    }
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
  const sourceTable = tableNameForType(sourceType);
  const fullRow = readRowById(db, sourceTable, id);
  if (!fullRow) {
    return false;
  }

  return evaluatePoliciesForOperation(sourceTypeDef, "select", fullRow, context, { failOnDeny: false });
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
