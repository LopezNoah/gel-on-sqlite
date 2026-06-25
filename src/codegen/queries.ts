// Typed query-client codegen — turns each `.edgeql` file into a typed TS
// function (edgeql-js / Prisma-client style).
//
// For every query we run the compile-inspection seam (src/compiler/inspect.ts),
// which parses + compiles the query against the schema WITHOUT touching a DB and
// hands back the Live IR. From the IR we read:
//   * `statement.params`      → the function's parameter type
//   * `statement.expr`+shape  → the result type (recursing through link shapes)
//   * `statement.cardinality` → array vs single vs nullable
//
// Result typing is best-effort: anything the inferencer leaves underspecified
// (unknown cardinality, polymorphic unions, exotic collections) degrades to
// `unknown` with a warning rather than emitting a wrong type. See the D1/codegen
// notes: unions need an explicit `__typename__` to discriminate.

import fs from "node:fs";
import path from "node:path";
import { loadSchema } from "../schema/load.js";
import { inspect } from "../compiler/inspect.js";
import { qualifiedTypeRefName, valueFactsOf } from "../ir/value_facts.js";
import type { Cardinality, Set as IRSet, ShapeElement, Statement as GelIRStatement, TypeRef } from "../ir/gel_ir.js";

export interface GenerateQueryClientInput {
  schemaSource: string;
  queriesDir: string;
  outFile: string;
}

export interface GenerateQueryClientResult {
  generated: number;
  warnings: string[];
}

// Gel scalar → TypeScript. Temporal/decimal types arrive from the engine as
// strings in JSON results, so they map to `string` (not the rich client
// classes) to keep generated output runtime-agnostic.
const SCALAR_TS: Record<string, string> = {
  "std::str": "string",
  "std::uuid": "string",
  "std::int16": "number",
  "std::int32": "number",
  "std::int64": "number",
  "std::float32": "number",
  "std::float64": "number",
  "std::decimal": "string",
  "std::bool": "boolean",
  "std::bigint": "bigint",
  "std::bytes": "Uint8Array",
  "std::json": "unknown",
  "std::datetime": "string",
  "cal::local_date": "string",
  "cal::local_time": "string",
  "cal::local_datetime": "string",
  "std::duration": "string",
  "cal::relative_duration": "string",
  "cal::date_duration": "string",
};

const scalarToTs = (name: string): string => SCALAR_TS[name] ?? "unknown";

// A cast type name as written in the query (`str`, `int64`, `cal::local_date`)
// → TypeScript. Short names are resolved under `std::`.
const castTypeToTs = (castType: string): string => {
  if (castType in SCALAR_TS) return SCALAR_TS[castType];
  const qualified = `std::${castType}`;
  return SCALAR_TS[qualified] ?? "unknown";
};

interface ParamInfo {
  name: string;
  tsType: string;
  required: boolean;
}

const isParameterNode = (x: unknown): x is { name: string } =>
  !!x && typeof x === "object" && (x as { kind?: unknown }).kind === "parameter";

// Walk the parsed AST to collect every `<T>$name` parameter, in first-seen
// order. The AST is the reliable source: the IR's `statement.params` omits
// params that appear only in a FILTER, and a param's IR typeref under-detects to
// `std::anytype` — the written cast carries the real type.
const collectParams = (ast: unknown): ParamInfo[] => {
  const found = new Map<string, ParamInfo>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.kind === "cast" && isParameterNode(obj.expr)) {
      const name = obj.expr.name;
      if (!found.has(name)) {
        found.set(name, { name, tsType: castTypeToTs(String(obj.castType)), required: obj.optional !== true });
      }
    } else if (obj.kind === "parameter" && typeof obj.name === "string") {
      if (!found.has(obj.name)) found.set(obj.name, { name: obj.name, tsType: "unknown", required: true });
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(ast);
  return [...found.values()];
};

const discoverQueryFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (path.extname(entry.name) === ".edgeql") out.push(full);
    }
  };
  walk(dir);
  return out.sort();
};

const pascalCase = (raw: string): string =>
  raw
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const camelCase = (raw: string): string => {
  const p = pascalCase(raw);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

// The "list-ness" half of cardinality: many/at-least-one → array. Absence of a
// single value (at_most_one) is encoded by the caller — as a `?` on a shape
// field, or `| null` on a top-level result — so it is NOT added here.
const arrayWrap = (base: string, card: Cardinality, warn: (m: string) => void, ctx: string): string => {
  if (card === "many" || card === "at_least_one") return `${base}[]`;
  if (card === "unknown") {
    warn(`${ctx}: cardinality is unknown — treating as a list`);
    return `${base}[]`;
  }
  return base;
};

const typeRefToTs = (typeref: TypeRef | undefined): string => {
  if (!typeref) return "unknown";
  if (typeref.collection === "array") {
    return `${typeRefToTs(typeref.subtypes?.[0])}[]`;
  }
  if (typeref.collection === "tuple") {
    const parts = (typeref.subtypes ?? []).map((t) => typeRefToTs(t));
    return parts.length ? `[${parts.join(", ")}]` : "unknown[]";
  }
  return scalarToTs(qualifiedTypeRefName(typeref));
};

// The element type of a result set — its object shape, scalar, or collection,
// with NO cardinality wrapping. Callers wrap it: nested shape fields via
// `setToTs`/`arrayWrap`, the top-level result via the chosen Client method.
const baseTypeOf = (set: IRSet, indent: string, warn: (m: string) => void, ctx: string): string => {
  if (set.typeref?.union && set.typeref.union.length > 0) {
    warn(`${ctx}: result is a polymorphic union — add __typename__ to the query to discriminate; typed as unknown`);
    return "unknown";
  }

  const facts = valueFactsOf(set);

  // Object shape (a `{ ... }` projection).
  if (set.shape && set.shape.length > 0) {
    const fields = set.shape
      .map((el) => shapeElementToTs(el, `${indent}  `, warn, ctx))
      .filter((f): f is string => f !== null);
    return fields.length ? `{\n${fields.join("\n")}\n${indent}}` : "Record<string, unknown>";
  }

  if (facts.category === "collection") {
    return typeRefToTs(set.typeref);
  }

  const scalarName = facts.typeName || (set.typeref ? qualifiedTypeRefName(set.typeref) : "");
  return scalarToTs(scalarName);
};

// Build the TS type for one nested result set (a shape field), wrapping the
// element type for many/at-least-one cardinality.
const setToTs = (set: IRSet, card: Cardinality, indent: string, warn: (m: string) => void, ctx: string): string =>
  arrayWrap(baseTypeOf(set, indent, warn, ctx), card, warn, ctx);

// Maps the statement's top-level cardinality to the matching gel-js Client
// method + how the method's return wraps the element type `T`.
const CARD_METHOD: Record<Cardinality, { method: string; ret: (t: string) => string }> = {
  one: { method: "queryRequiredSingle", ret: (t) => t },
  at_most_one: { method: "querySingle", ret: (t) => `${t} | null` },
  at_least_one: { method: "queryRequired", ret: (t) => `[${t}, ...${t}[]]` },
  many: { method: "query", ret: (t) => `${t}[]` },
  unknown: { method: "query", ret: (t) => `${t}[]` },
};

const shapeElementToTs = (
  el: ShapeElement,
  indent: string,
  warn: (m: string) => void,
  ctx: string,
): string | null => {
  const name = el.name ?? el.targetPtr?.name;
  if (!name) return null;
  const inner = setToTs(el.expr, el.cardinality, indent, warn, `${ctx}.${name}`);
  const optional = el.required ? "" : "?";
  const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
  return `${indent}${key}${optional}: ${inner};`;
};

interface GeneratedQuery {
  name: string;
  pascal: string;
  query: string;
  paramsType: string;
  /** The per-row element type (assigned to `<Pascal>Result`). */
  resultType: string;
  /** The Client method to call (query / querySingle / …). */
  method: string;
  /** The function's Promise payload, in terms of `<Pascal>Result`. */
  returnType: string;
  hasParams: boolean;
}

const buildQuery = (
  ir: GelIRStatement,
  params: ParamInfo[],
  fileBase: string,
  queryText: string,
  warn: (m: string) => void,
): GeneratedQuery => {
  const name = camelCase(fileBase);
  const pascal = pascalCase(fileBase);

  const paramFields = params.map((p) => `  ${p.name}${p.required ? "" : "?"}: ${p.tsType};`);
  const paramsType = paramFields.length ? `{\n${paramFields.join("\n")}\n}` : "Record<string, never>";

  // The per-row element type; the chosen Client method encodes cardinality
  // (querySingle → `T | null`, query → `T[]`, …).
  const element = baseTypeOf(ir.expr, "", warn, pascal);
  if (ir.cardinality === "unknown") {
    warn(`${pascal}: result cardinality is unknown — using \`query\` (returns a list)`);
  }
  const card = CARD_METHOD[ir.cardinality] ?? CARD_METHOD.many;

  return {
    name,
    pascal,
    query: queryText.trim(),
    paramsType,
    resultType: element,
    method: card.method,
    returnType: card.ret(`${pascal}Result`),
    hasParams: paramFields.length > 0,
  };
};

const HEADER = `// AUTO-GENERATED by \`gel codegen\` — do not edit by hand.
// Regenerate after changing your .edgeql queries or schema.

// Structural subset of the sqlite-ts Client/Transaction surface. A real
// \`Client\` (or \`Transaction\`) is assignable to this — pass it straight in.
export interface Executor {
  query<T = unknown>(query: string, args?: Record<string, unknown>): Promise<T[]>;
  querySingle<T = unknown>(query: string, args?: Record<string, unknown>): Promise<T | null>;
  queryRequiredSingle<T = unknown>(query: string, args?: Record<string, unknown>): Promise<T>;
  queryRequired<T = unknown>(query: string, args?: Record<string, unknown>): Promise<[T, ...T[]]>;
}
`;

const renderQuery = (q: GeneratedQuery): string => {
  const clientParam = q.hasParams ? `client: Executor, params: ${q.pascal}Params` : `client: Executor`;
  const argsForward = q.hasParams ? ", params" : "";
  return [
    `export type ${q.pascal}Params = ${q.paramsType};`,
    `export type ${q.pascal}Result = ${q.resultType};`,
    ``,
    `const ${q.pascal}_QUERY = ${JSON.stringify(q.query)};`,
    ``,
    `export function ${q.name}(${clientParam}): Promise<${q.returnType}> {`,
    `  return client.${q.method}<${q.pascal}Result>(${q.pascal}_QUERY${argsForward});`,
    `}`,
  ].join("\n");
};

export const generateQueryClient = (input: GenerateQueryClientInput): GenerateQueryClientResult => {
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  const files = discoverQueryFiles(input.queriesDir);
  if (files.length === 0) return { generated: 0, warnings };

  const schema = loadSchema(input.schemaSource, { legacySyntaxCompat: true });
  const blocks: string[] = [];

  for (const file of files) {
    const fileBase = path.basename(file, ".edgeql");
    const queryText = fs.readFileSync(file, "utf-8");
    const insp = inspect(schema, queryText);
    if (!insp.ok || !insp.artifact) {
      warn(`${path.relative(input.queriesDir, file)}: did not compile [${insp.error?.code}] ${insp.error?.message}`);
      continue;
    }
    const params = collectParams(insp.ast);
    blocks.push(renderQuery(buildQuery(insp.artifact.gelIr, params, fileBase, queryText, warn)));
  }

  const body = `${HEADER}\n${blocks.join("\n\n")}\n`;
  fs.mkdirSync(path.dirname(input.outFile), { recursive: true });
  fs.writeFileSync(input.outFile, body);

  return { generated: blocks.length, warnings };
};
