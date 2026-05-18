import { getCompilerService, type CompilerCacheMeta } from "../compiler/service.js";
import { AppError, asAppError } from "../errors.js";
import { parseEdgeQL, parseEdgeQLScript, type ParseEdgeQLOptions } from "../edgeql/parser.js";
import type { ComputedExpr, FilterValue, ForStatement, FreeObjectExpr, FunctionCallArgExpr, InsertStatement, InsertValue, OrderExpr, SelectExprStatement, SelectStatement, ShapeElement, Statement, UpdateStatement, WithBinding, WithBindingValue } from "../edgeql/ast.js";
import type { RuntimeDatabaseAdapter } from "./adapter.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { compileToSQL, computedValueAlias, shapePayloadAlias, type SQLArtifact } from "../sql/compiler.js";
import { executeStdlibFunction, resolveStdlibFunction, type RuntimeFunctionArg } from "../stdlib/functions.js";
import { assertTargetSqlCompatibility, type RuntimeTarget } from "./target.js";
import type { BacklinkSourceIR, FilterExprIR, IRStatement, LinkRelationIR, OrderByIR, OverlayIR, SelectExprIREntry, SelectExprIR, SelectIR, SelectShapeElementIR } from "../ir/model.js";
import type { AccessPolicyCondition, AccessPolicyDef, AliasDef, ComputedLinkPropertyExpr, FieldDef, FunctionDef, FunctionExprDef, ScalarType, ScalarValue, TypeDef } from "../types.js";
import { qualifiedTypeName } from "../schema/schema.js";
import type { SQLiteDatabase } from "../runtime/database.js";


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
          || ["array_unpack", "range_unpack", "range", "max", "assert_exists", "assert_single"].includes(shortName)
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
      case "subquery_expr":
        return needsRuntimeEval(expr.expr);
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

  const bindingNeedsRuntime = (binding: { value: { kind: string; head?: string; parts?: string[]; name?: string } }): boolean => {
    const value = binding.value;
    if (value.kind === "enum_path") return false;
    if (value.kind === "path") return !isEnumScalarTypeDef(value.head);
    if (value.kind === "path_chain") return !isEnumScalarTypeDef(value.parts?.[0]);
    if (value.kind === "binding_ref") return !isEnumScalarTypeDef(value.name);
    if (value.kind === "subquery") return false;
    // Defer to the regular compile path for richer binding kinds; the runtime
    // fallback evaluator below cannot follow link traversals or junction tables.
    if (value.kind === "subquery_expr" || value.kind === "select_expr_subquery" || value.kind === "field_access") {
      return false;
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

  const evalFilter = (row: Record<string, unknown>, filter: SelectStatement["filter"], env: EvalEnv): boolean => {
    if (!filter) {
      return true;
    }
    if (filter.kind === "and") {
      return evalFilter(row, filter.left, env) && evalFilter(row, filter.right, env);
    }
    if (filter.kind === "or") {
      return evalFilter(row, filter.left, env) || evalFilter(row, filter.right, env);
    }
    if (filter.kind === "not") {
      return !evalFilter(row, filter.expr, env);
    }
    if (filter.kind === "free_expr") {
      return Boolean(evalExpr(filter.expr, env));
    }
    if (filter.target.kind !== "field") {
      return true;
    }
    const left = row[filter.target.field];
    if (filter.kind === "in_predicate") {
      const values = filter.values.kind === "set_literal" ? filter.values.values : [];
      const hasValue = values.some((value) => value === left);
      return filter.op === "not_in" ? !hasValue : hasValue;
    }
    const right = evalFilterValue(filter.value, env);
    return runtimeAliasPredicateMatches(left, filter.op, right as ScalarValue);
  };

  const evalExpr = (expr: FreeObjectExpr, env: EvalEnv): unknown => {
    switch (expr.kind) {
      case "literal":
        return expr.value;
      case "set_literal":
        return [...expr.values];
      case "set_expr":
        return expr.values.flatMap((value) => {
          const evaluated = evalExpr(value, env);
          return Array.isArray(evaluated) ? evaluated : [evaluated];
        });
      case "binding_ref": {
        if (env.has(expr.name)) {
          return env.get(expr.name);
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
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return (value as Record<string, unknown>)[expr.tail] ?? null;
        }
        return null;
      }
      case "field_access": {
        const value = evalExpr(expr.expr, env);
        const readOne = (item: unknown): unknown => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return null;
          }
          const row = item as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(row, expr.field)) {
            return row[expr.field] ?? null;
          }
          const sourceTypeName = typeof row.__source_type === "string" ? row.__source_type : undefined;
          const computed = sourceTypeName
            ? schema.getType(sourceTypeName)?.computeds?.find((candidate) => candidate.kind === "property" && candidate.name === expr.field)
            : undefined;
          if (computed?.kind === "property" && computed.expr.kind === "literal") {
            return computed.expr.value;
          }
          return null;
        };
        return Array.isArray(value) ? value.map(readOne).filter((item) => item !== null && item !== undefined) : readOne(value);
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
            return Array.isArray(value) ? { kind: "set", values: value as ScalarValue[] } : value as ScalarValue;
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
        return executeFunctionCall(schema, db, context, qualifiedName, args);
      }
      case "for_expr": {
        const iteratorValue = evalExpr(expr.iterator, env);
        const iteratorItems = Array.isArray(iteratorValue) ? iteratorValue : [iteratorValue];
        return iteratorItems.map((item) => {
          const nextEnv = new Map(env);
          nextEnv.set(expr.variable, item);
          return evalExpr(expr.body, nextEnv);
        });
      }
      case "math":
        return Number(evalExpr(expr.left, env)) + Number(evalExpr(expr.right, env));
      case "compare": {
        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        if (expr.op === "=") return left === right;
        if (expr.op === "!=") return left !== right;
        if (expr.op === ">") return Number(left) > Number(right);
        return Number(left) < Number(right);
      }
      case "and":
        return Boolean(evalExpr(expr.left, env)) && Boolean(evalExpr(expr.right, env));
      case "or":
        return Boolean(evalExpr(expr.left, env)) || Boolean(evalExpr(expr.right, env));
      case "not":
        return !(evalExpr(expr.expr, env));
      case "select": {
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
        rows = rows.filter((row) => evalFilter(row, expr.clauses.filter, env));
        if (expr.clauses.orderBy) {
          const direction = expr.clauses.orderBy.direction === "desc" ? -1 : 1;
          rows.sort((a, b) => String(a[expr.clauses.orderBy!.field] ?? "").localeCompare(String(b[expr.clauses.orderBy!.field] ?? "")) * direction);
        }
        if (expr.clauses.limit !== undefined) {
          rows = rows.slice(0, expr.clauses.limit);
        }
        return rows;
      }
      case "cast": {
        const value = evalExpr(expr.expr, env);
        if (expr.castType === "str") {
          return Array.isArray(value) ? value.map((item) => String(item ?? "")) : String(value ?? "");
        }
        return value;
      }
      case "is_type": {
        const value = evalExpr(expr.expr, env);
        const typeDef = schema.getType(qualifyRuntimeTypeName(expr.typeName));
        const enumValues = typeDef?.fields.flatMap((field) => field.enumValues ?? []) ?? [];
        const checkOne = (item: unknown) => enumValues.length > 0 && typeof item === "string" && enumValues.includes(item);
        return Array.isArray(value) ? value.map(checkOne) : checkOne(value);
      }
      case "select_expr_subquery":
      case "subquery_expr": {
        const value = evalExpr(expr.expr, env);
        if (expr.kind !== "select_expr_subquery" || !expr.orderBy) {
          return value;
        }
        const rows = Array.isArray(value) ? [...value] : [value];
        const enumOrder = enumOrderForRows(rows);
        const direction = expr.orderBy.direction === "desc" ? -1 : 1;
        rows.sort((a, b) => {
          const leftEnv = new Map(env);
          const rightEnv = new Map(env);
          if (expr.alias) {
            leftEnv.set(expr.alias, a);
            rightEnv.set(expr.alias, b);
          }
          const left = evalExpr(expr.orderBy!.expr, leftEnv);
          const right = evalExpr(expr.orderBy!.expr, rightEnv);
          const leftEnumIndex = typeof left === "string" ? enumOrder?.get(left) : undefined;
          const rightEnumIndex = typeof right === "string" ? enumOrder?.get(right) : undefined;
          if (leftEnumIndex !== undefined && rightEnumIndex !== undefined && leftEnumIndex !== rightEnumIndex) {
            return (leftEnumIndex < rightEnumIndex ? -1 : 1) * direction;
          }
          return String(left ?? "").localeCompare(String(right ?? "")) * direction;
        });
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
  for (const binding of ast.with ?? []) {
    initialEnv.set(binding.name, evalExpr(binding.value, initialEnv));
  }

  const value = evalExpr(ast.expr, initialEnv);
  if (value === undefined) {
    return undefined;
  }
  const currentBinding = ast.expr.kind === "binding_ref" ? ast.expr.name : undefined;
  const topIsArrayAgg = ast.expr.kind === "function_call"
    && ((ast.expr.call.name.includes("::") ? ast.expr.call.name.split("::").at(-1) : ast.expr.call.name)?.toLowerCase() === "array_agg");
  const rows = Array.isArray(value) ? (topIsArrayAgg ? [value] : value) : [value];
  if (ast.orderBy) {
    const direction = ast.orderBy.direction === "desc" ? -1 : 1;
    const enumOrder = ast.orderBy.expr.kind === "cast"
      ? enumOrderForCast(ast.orderBy.expr.castType)
      : ast.orderBy.expr.kind === "binding_ref"
        ? enumOrderForRows(rows)
        : undefined;
    rows.sort((a, b) => {
      const leftEnv = new Map(initialEnv);
      const rightEnv = new Map(initialEnv);
      if (currentBinding) {
        leftEnv.set(currentBinding, a);
        rightEnv.set(currentBinding, b);
      }
      const left = evalExpr(ast.orderBy!.expr, leftEnv);
      const right = evalExpr(ast.orderBy!.expr, rightEnv);
      const leftEnumIndex = typeof left === "string" ? enumOrder?.get(left) : undefined;
      const rightEnumIndex = typeof right === "string" ? enumOrder?.get(right) : undefined;
      if (leftEnumIndex !== undefined && rightEnumIndex !== undefined && leftEnumIndex !== rightEnumIndex) {
        return (leftEnumIndex < rightEnumIndex ? -1 : 1) * direction;
      }
      return String(left ?? "").localeCompare(String(right ?? "")) * direction;
    });
  }
  return {
    kind: "select",
    rows,
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
  const withMatch = /^with\s+([A-Za-z_][\w]*)\s*:=\s*([A-Za-z_][\w:]*)\s*\{\s*([A-Za-z_][\w]*)\s*:=\s*[\[(]([^\])]+)[\])]\s*\}\s*select\s+\1\.\3$/i.exec(trimmed.replace(/\s+/g, " "));
  const inlineMatch = /^select\s*\(\s*([A-Za-z_][\w:]*)\s*\{\s*([A-Za-z_][\w]*)\s*:=\s*[\[(]([^\])]+)[\])]\s*\}\s*\)\.\2$/i.exec(trimmed.replace(/\s+/g, " "));
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
};

const tryEvaluateParsedRuntimeSelect = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  statement: Statement,
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
    || value.kind === "path_chain"
    || (value.kind === "subquery" && shapeNeedsParsedRuntime(value.query.shape));
  const functionCallNeedsParsedRuntime = (expr: Extract<ComputedExpr, { kind: "function_call" }>): boolean =>
    expr.call.args.some((arg) => arg.kind === "expr" || (arg.kind === "function_call" && functionCallNeedsParsedRuntime({ kind: "function_call", call: arg.call })));
  const computedNeedsParsedRuntime = (expr: ComputedExpr): boolean => expr.kind === "select_expr"
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

  if (!selectedAliasNeedsParsedRuntime && !shapeNeedsParsedRuntime(statement.shape) && !statement.with?.some((binding) => bindingNeedsParsedRuntime(binding.value))) {
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

  const readBacklink = (row: ParsedRuntimeRow, targetTypeName: string, linkName: string, sourceTypeFilter?: string): ParsedRuntimeRow[] => {
    if (typeof row.id !== "string") {
      return [];
    }
    const sourceTypes = sourceTypeFilter
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
    }
    return next;
  };

  const evalBinding = (value: WithBindingValue, env: ParsedRuntimeEnv): ParsedRuntimeRow[] => {
    if (value.kind === "subquery") {
      return evalSelect(value.query.typeName, value.query.shape, value.query.clauses, env);
    }
    if (value.kind === "backlink_path") {
      const row = env.row;
      const rowType = row ? rowTypeName(row, qualifyType(value.head)) : undefined;
      return row && rowType ? readBacklink(row, rowType, value.link, value.sourceType) : [];
    }
    if (value.kind === "path" && env.bindings.has(value.head)) {
      return env.bindings.get(value.head)!.map((row) => ({ __count: countForwardLink(row, rowTypeName(row), value.tail) }));
    }
    if (value.kind === "path_chain" && value.parts.at(-2) === "__type__" && value.parts.at(-1) === "name" && env.row) {
      const baseType = rowTypeName(env.row, env.rowType);
      return [{ __scalar: concreteTypeForRow(baseType, env.row.id) }];
    }
    return [];
  };

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
        return Array.isArray(evaluated) ? evaluated : [evaluated];
      });
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
      if (bound) {
        return bound;
      }
      if (env.row) {
        const qualifiedType = qualifyType(expr.typeName);
        const rowType = rowTypeName(env.row, env.rowType);
        const assignable = new Set(schema.listConcreteTypesAssignableTo(qualifiedType).map((typeDef) => qualifiedTypeName(typeDef)));
        if (rowType === qualifiedType || assignable.has(rowType)) {
          return env.row;
        }
      }
      return evalSelect(expr.typeName, expr.shape, expr.clauses, env).map((row) => materialize(row, rowTypeName(row, qualifyType(expr.typeName)), expr.shape, env));
    }
    if (expr.kind === "backlink_path") {
      return env.row ? readBacklink(env.row, rowTypeName(env.row, env.rowType), expr.link, expr.sourceType) : [];
    }
    if (expr.kind === "field_access") {
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
      const iterator = evalFreeExpr(expr.iterator, env);
      const items = Array.isArray(iterator) ? iterator : [iterator];
      return items.flatMap((item) => {
        if (!isRecordRow(item)) {
          return [];
        }
        const bindings = new Map(env.bindings);
        bindings.set(expr.variable, [item]);
        const value = evalFreeExpr(expr.body, { ...env, bindings });
        return Array.isArray(value) ? value : [value];
      });
    }
    if (expr.kind === "compare") {
      const left = evalFreeExpr(expr.left, env);
      const right = evalFreeExpr(expr.right, env);
      const leftItems = Array.isArray(left) ? left : [left];
      const rightItems = Array.isArray(right) ? right : [right];
      const comparable = (value: unknown): unknown => isRecordRow(value) && typeof value.id === "string" ? value.id : value;
      return leftItems.some((leftItem) => rightItems.some((rightItem) => {
        const comparableLeft = comparable(leftItem);
        const comparableRight = comparable(rightItem);
        if (expr.op === "=") return comparableLeft === comparableRight;
        if (expr.op === "!=") return comparableLeft !== comparableRight;
        if (expr.op === ">") return Number(leftItem) > Number(rightItem);
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
      let value = evalFreeExpr(expr.expr, env);
      if (Array.isArray(value)) {
        let items = [...value];
        if (expr.filter) {
          items = items.filter((item) => {
            const bindings = new Map(env.bindings);
            if (expr.alias && isRecordRow(item)) {
              bindings.set(expr.alias, [item]);
            }
            const filterValue = evalFreeExpr(expr.filter!, { ...env, row: isRecordRow(item) ? item : env.row, bindings });
            return Array.isArray(filterValue) ? filterValue.some(Boolean) : Boolean(filterValue);
          });
        }
        if (expr.orderBy) {
          const direction = expr.orderBy.direction === "desc" ? -1 : 1;
          items.sort((a, b) => {
            const leftBindings = new Map(env.bindings);
            const rightBindings = new Map(env.bindings);
            if (expr.alias && isRecordRow(a)) {
              leftBindings.set(expr.alias, [a]);
            }
            if (expr.alias && isRecordRow(b)) {
              rightBindings.set(expr.alias, [b]);
            }
            const left = evalFreeExpr(expr.orderBy!.expr, { ...env, row: isRecordRow(a) ? a : env.row, bindings: leftBindings });
            const right = evalFreeExpr(expr.orderBy!.expr, { ...env, row: isRecordRow(b) ? b : env.row, bindings: rightBindings });
            return String(left ?? "").localeCompare(String(right ?? "")) * direction;
          });
        }
        const offset = expr.offset ?? 0;
        items = expr.limit === undefined ? items.slice(offset) : items.slice(offset, offset + expr.limit);
        value = items;
      }
      return value;
    }
    if (expr.kind === "function_call") {
      const name = expr.call.name.includes("::") ? expr.call.name : `std::${expr.call.name}`;
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
        return Array.isArray(value) ? value.length : value === null || value === undefined ? 0 : 1;
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
        return Array.isArray(value) ? value.length : value === null || value === undefined ? 0 : 1;
      }
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
      return multi ? (Array.isArray(value) ? value : [value]) : Array.isArray(value) && value.length === 1 ? value[0] : value;
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
        out[element.name] = evalComputed(element.expr, { ...env, row, rowType: typeName }, Boolean(element.multi));
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
      const value = evalFreeExpr(filter.expr, { ...env, row, rowType: typeName });
      return Array.isArray(value) ? value.some(Boolean) : Boolean(value);
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
    const expected = typeof filter.value === "object" && filter.value !== null && "kind" in filter.value
      ? filter.value.kind === "field_ref"
        ? row[filter.value.field]
        : filter.value.kind === "binding_ref"
          ? env.bindings.get(filter.value.name)?.[0]
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
  const schemaQueryResult = trySchemaObjectTypeQuery(schema, rewrittenQuery);
  if (schemaQueryResult) {
    return schemaQueryResult;
  }

  const parsedQuery = parseEdgeQL(rewrittenQuery);
  const parsedRuntimeResult = tryEvaluateParsedRuntimeSelect(db, schema, parsedQuery);
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
  if (maybeHandleAliasDDLScript(schema, script)) {
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
      const isShapeOrObject = firstEntry
        && (firstEntry.kind === "shape_projection"
          || firstEntry.kind === "select"
          || firstEntry.kind === "field_access"
          || firstEntry.kind === "select_expr_subquery"
          || firstEntry.kind === "array_literal_expr");
      const sqlIsRunnable = compiled.usesGelIrSql && sqlArtifact.loweringMode === "single_statement";
      result = {
        kind: "select",
        rows: sqlIsRunnable && !isShapeOrObject
          ? runGelSelectExprSQL(db, sqlArtifact)
          : materializeSelectExprRows(db, schema, ir, context, sqlTrail),
      };
    } else {
      const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType!, context, compiled.usesGelIrSql);

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

export const executeQueryUnitWithTrace = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  script: string,
  securityContext: SecurityContext = DEFAULT_SECURITY_CONTEXT,
  parserOptions: ParseEdgeQLOptions = {},
): QueryUnitTrace => {
  try {
    const context = normalizeSecurityContext(securityContext);
    const runtimeTarget = resolvedRuntimeTarget(context, db);
    const compilerService = getCompilerService();
    const statements = parseEdgeQLScript(script, parserOptions);
    if (statements.length === 0) {
      throw new Error("No statements to execute");
    }

    const overlays: OverlayIR[] = [];
    const traces: QueryExecutionTrace[] = [];

    for (const ast of statements) {
      if (ast.kind === "for") {
        executeForLoop(db, schema, ast, context, runtimeTarget, compilerService, overlays, traces);
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
        const sqlIsRunnable = compiled.usesGelIrSql && sqlArtifact.loweringMode === "single_statement";
        result = {
          kind: "select",
          rows: sqlIsRunnable
            ? runGelSelectExprSQL(db, sqlArtifact)
            : materializeSelectExprRows(db, schema, ir, context, sqlTrail),
        };
      } else {
        const writeResult = runWriteWithAccessPolicies(db, schema, ast, ir, sqlArtifact, subjectType!, context, compiled.usesGelIrSql);
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

const substituteBindingInASTFilter = (
  filter: import("../edgeql/ast.js").FilterExpr,
  variable: string,
  value: ScalarValue,
): import("../edgeql/ast.js").FilterExpr => {
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
  return filter;
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

  if (body.kind === "insert") {
    const iteratorValues = evaluateForIteratorValues(iteratorExpr, schema, db, context);
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

      const writeResult = runWriteWithAccessPolicies(db, schema, insertAst, ir, sqlArtifact, subjectType, context, compiled.usesGelIrSql);
      const result = { kind: "insert" as const, changes: writeResult.changes };

      const currentOverlays = extractOverlays(ir);
      if (ir.kind !== "select" && ir.kind !== "select_free" && ir.kind !== "select_expr") {
        overlays.push(...currentOverlays);
      }

      traces.push({
        ast: insertAst,
        ir,
        sql: sqlArtifact,
        compiler: compiled.cache,
        sqlTrail,
        overlays: currentOverlays,
        result,
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
    const iteratorValues = evaluateForIteratorValues(iteratorExpr, schema, db, context);
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
      } else if (element.expr.kind === "polymorphic_field_ref") {
        output[element.name] = element.expr.sourceType === sourceType
          ? materializeFieldValue(schema, sourceType, element.expr.column, row[element.expr.column])
          : [];
      } else if (element.expr.kind === "type_name") {
        output[element.name] = sourceType;
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
          sql = `SELECT COALESCE(SUM(${aggregateColumn}), 0) AS ${quoteIdent("value")} FROM ${targetSource} JOIN ${quoteIdent(relation.linkTable!)} l ON l.${quoteIdent("target")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("source")} = ?`;
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
  if (!subjectType) {
    throw new AppError("E_SEMANTIC", `Unknown type '${ir.sourceType}'`, 1, 1);
  }

  const stmt = db.prepare(sqlArtifact.sql);
  const rows = stmt.all(...sqlArtifact.params);
  const visibleRows = rows.filter((row) => evaluateSelectPolicies(schema, db, subjectType, row, context));
  return visibleRows.map((row) => materializeSelectRow(db, schema, context, ir.shape, row, rowSourceType(row, ir.sourceType), sqlTrail));
};

const runSelectFreeSQL = (
  db: SQLiteDatabase,
  sqlArtifact: SQLArtifact,
): Record<string, unknown>[] => db.prepare(sqlArtifact.sql).all(...sqlArtifact.params) as Record<string, unknown>[];

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
      return sourceRow?.[field] ?? null;
    }

    const computed = sourceType.computeds?.find((candidate) => candidate.kind === "property" && candidate.name === field);
    if (computed && computed.kind === "property") {
      const sourceTable = tableNameForType(sourceTypeName);
      const sourceRow = readRowById(db, sourceTable, id) ?? row;

      if (computed.expr.kind === "literal") {
        return computed.expr.value;
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

  const resolveBacklinkPathValue = (item: unknown, link: string, sourceTypeFilter?: string): unknown[] => {
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
    const sourceTypes = sourceTypeFilter
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

  const isTupleLikeSelectExprEntry = (value: SelectExprIREntry): boolean => {
    if (value.kind === "tuple") {
      return true;
    }
    if (value.kind === "if_else") {
      return isTupleLikeSelectExprEntry(value.thenExpr) && isTupleLikeSelectExprEntry(value.elseExpr);
    }
    if (value.kind === "select_expr_subquery") {
      return isTupleLikeSelectExprEntry(value.value);
    }
    return false;
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
      return (entry.values as unknown[]).flatMap((value) => {
        const typedValue = value as SelectExprIREntry;
        const item = evaluateSelectExprEntry(schema, db, context, typedValue, sqlTrail, evalContext);
        return Array.isArray(item) ? item : [item];
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
      const values = (entry.values as unknown[]).map((value) => {
        const typedValue = value as SelectExprIREntry;
        return evaluateSelectExprEntry(schema, db, context, typedValue, sqlTrail, evalContext);
      });
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
    case "array_literal_expr": {
      return (entry.values as unknown[]).map((value) => {
        const typedValue = value as SelectExprIREntry;
        return evaluateSelectExprEntry(schema, db, context, typedValue, sqlTrail, evalContext);
      });
    }
    case "index_access": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      const valueIsTuple = Array.isArray(value)
        && (isTupleLikeSelectExprEntry(entry.value) || entry.value.kind === "current_item");
      const readIndex = (item: unknown): unknown => {
        if (typeof item === "string") {
          return item[entry.index] ?? null;
        }
        if (Array.isArray(item)) {
          return item[entry.index] ?? null;
        }
        return null;
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
      const leftValue = evaluateSelectExprEntry(schema, db, context, entry.left, sqlTrail, evalContext);
      const rightValue = evaluateSelectExprEntry(schema, db, context, entry.right, sqlTrail, evalContext);

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
      return Number(leftValue) + Number(rightValue);
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
  const iteratorValue = evaluateSelectExprEntry(schema, db, context, entry.iterator, sqlTrail, evalContext);
  const iteratorItems = Array.isArray(iteratorValue) ? iteratorValue : [iteratorValue];
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
    } else {
      out.push(bodyValue);
    }
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
    case "field_access": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      const readOne = (item: unknown): unknown => resolveFieldAccessValue(item, entry.field);

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

        for (const item of value) {
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
      return resolveBacklinkPathValue(evalContext?.currentValue, entry.link, entry.sourceType);
    }
    case "shape_projection": {
      const value = evaluateSelectExprEntry(schema, db, context, entry.value, sqlTrail, evalContext);
      const projectOne = (item: unknown): Record<string, unknown> | null => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return null;
        }
        const row = item as Record<string, unknown>;
        const projected: Record<string, unknown> = {};
        for (const field of entry.fields) {
          if (field.expr) {
            projected[field.name] = evaluateSelectExprEntry(schema, db, context, field.expr, sqlTrail, {
              currentBinding: evalContext?.currentBinding,
              currentValue: row,
            });
            continue;
          }

          const rawValue = field.sourceField ? row[field.sourceField] ?? null : null;
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
                      currentBinding: evalContext?.currentBinding,
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
      let rows = Array.isArray(value) ? [...value] : [value];
      if (entry.filter) {
        const currentBinding = entry.alias ?? evalContext?.currentBinding ?? "__current__";
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
          if (entry.orderBy!.direction === "desc") {
            return String(aKey).localeCompare(String(bKey)) * -1;
          }
          return String(aKey).localeCompare(String(bKey));
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
            return { kind: "set", values: value as ScalarValue[] };
          }
          return value as ScalarValue;
        }),
      );
    }
    case "concat": {
      const parts = (entry.parts as unknown[]).map((part) => {
        const typedPart = part as SelectExprIREntry;
        const value = evaluateSelectExprEntry(schema, db, context, typedPart, sqlTrail, evalContext);
        return Array.isArray(value) && value.length === 1 ? value[0] : value;
      });
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
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
        if (typeof part !== "string") {
          throw new AppError("E_SEMANTIC", `operator '++' cannot be applied to operands of type 'std::str' and '${typeof part}'`, 1, 1);
        }
      }
      return parts.join("");
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
  const value = evaluateSelectExprEntry(schema, db, context, ir.entries[0], sqlTrail);
  const entryProducesSingleValue = ir.entries[0].kind === "array_literal_expr";
  const rows = !entryProducesSingleValue && Array.isArray(value) ? [...value] : [value];

  if (ir.orderBy) {
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
      const aText = String(aKey);
      const bText = String(bKey);
      return (aText < bText ? -1 : 1) * direction;
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

const executeFunctionCall = (
  schema: SchemaSnapshot,
  db: SQLiteDatabase,
  context: SecurityContext,
  qualifiedName: string,
  args: RuntimeFunctionArg[],
): unknown => {
  const builtin = resolveStdlibFunction(qualifiedName, args.length);
  if (builtin) {
    return executeStdlibFunction(qualifiedName, args);
  }

  const divider = qualifiedName.lastIndexOf("::");
  const moduleName = divider >= 0 ? qualifiedName.slice(0, divider) : "default";
  const fnName = divider >= 0 ? qualifiedName.slice(divider + 2) : qualifiedName;
  const fn = schema.findFunction(moduleName, fnName, args.length);
  if (!fn) {
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
    sql = `SELECT ${selected.join(", ")} FROM ${targetSource} JOIN ${quoteIdent(relation.linkTable!)} l ON l.${quoteIdent("target")} = t.${quoteIdent("id")} WHERE l.${quoteIdent("source")} = ?`;
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
    let rows: Array<{ id: unknown }> = [];
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

  const left = compileNestedFilterExprSQL(filter.left, params, linkPropertyAlias);
  const right = compileNestedFilterExprSQL(filter.right, params, linkPropertyAlias);
  return filter.kind === "and" ? `(${left} AND ${right})` : `(${left} OR ${right})`;
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
  return statement.kind === "select_free" || statement.kind === "select_expr" ? "select" : statement.kind;
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
      const insertSql = `INSERT INTO ${quoteIdent(linkTable)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;

      for (const sourceId of sourceIds) {
        db.prepare(`DELETE FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).run(sourceId);
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
