import { AppError, tryResult } from "../errors.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import { inferStatementCardinality, inferStatementMultiplicity, inferStatementType, inferStatementVolatility } from "./inference.js";
import { checkScopeTreeViolations } from "./scope_tree_check.js";
import type {
  Statement as EdgeQLStatement,
  ComputedExpr,
  FreeObjectExpr,
  FunctionCallArgExpr,
  SelectStatement,
  SelectFreeStatement,
  InsertStatement,
  UpdateStatement,
  DeleteStatement,
  ForStatement,
  ConfigureStatement,
  ShapeElement as EdgeQLShapeElement,
  InsertValue,
  WithBinding,
  FilterExpr,
  FilterTarget,
  FilterValue,
  OrderExpr,
  OrderExprChain,
  PathStep as EdgeQLPathStep,
  GroupByElement,
  GroupByAtom,
  TypeExpr,
} from "../edgeql/ast.js";
import type {
  Cardinality,
  CallArg,
  CoalesceExpr,
  ArrayExpr,
  IndexExpr,
  TypeCast,
  BaseConstant,
  FunctionCall as IRFunctionCall,
  Global,
  IfElseExpr,
  Multiplicity,
  OperatorCall,
  Param,
  PathId,
  ScopeTreeNode,
  SelectStmt,
  Set,
  SortExpr,
  Statement,
  InsertStmt,
  UpdateStmt,
  DeleteStmt,
  ConfigStmt,
  GroupStmt,
  InsertExpr,
  UpdateExpr,
  DeleteExpr,
  ForExpr,
  EmbeddedGroupExpr,
  GroupRowsExpr,
  GroupRowProjection,
  GroupRowFieldExpr,
  GroupElementsField,
  Pointer,
  PointerRef,
  ExistsExpr,
  Tuple,
  TupleElement,
  SelectExpr,
  ShapeElement,
  TypeRef,
  TypeRoot,
  Volatility,
} from "../ir/gel_ir.js";
import type { FieldDef, FunctionDef, LinkDef, LinkPropertyDef, ScalarType, ScalarValue, TypeDef } from "../types.js";
import { qualifiedTypeName, type SchemaSnapshot } from "../schema/schema.js";
import type { GeneratedSchema, GeneratedSchemaType } from "../codegen/schema.js";
import { resolveSchemaModelForCompile } from "../codegen/schema_loader.js";

// Reject a GROUP BY clause that uses one name in conflicting roles (a USING
// alias vs a direct field, or a link property vs an object property). Relocated
// here from the retired legacy semantic pipeline; this is the only live
// consumer.
export const validateGroupByAtomCollisions = (
  by: GroupByElement[],
  fail: (message: string) => never,
): void => {
  // (`Set` is shadowed by the gel_ir `Set` type in this module, so track
  // origins with a plain flag record instead.)
  const origins = new Map<string, { field: boolean; using: boolean; linkProperty: boolean }>();
  const record = (atom: GroupByAtom): void => {
    const name = atom.kind === "field_ref" ? atom.field : atom.name;
    const origin: "field" | "using" | "linkProperty" =
      atom.kind === "field_ref" ? "field" : atom.kind === "link_property_ref" ? "linkProperty" : "using";
    const seen = origins.get(name) ?? { field: false, using: false, linkProperty: false };
    seen[origin] = true;
    origins.set(name, seen);
    if (seen.field && seen.using) {
      fail(`the name '${name}' cannot be used both as a USING alias and used directly in the BY clause`);
    }
    if (seen.field && seen.linkProperty) {
      fail(`BY clause cannot refer to link property and object property with the same name '${name}'`);
    }
  };
  for (const element of by) {
    if (element.kind === "field_ref" || element.kind === "name_ref" || element.kind === "link_property_ref") {
      record(element);
    } else if (element.kind === "sets") {
      for (const list of element.sets) for (const atom of list) record(atom);
    } else if (element.kind === "cube" || element.kind === "rollup") {
      for (const atom of element.atoms) record(atom);
    }
  }
};

export interface IRCompileOptions {
  module?: string;
  schema?: SchemaSnapshot;
  schemaModel?: GeneratedSchema;
  schemaModelName?: string;
}

export interface IRCompileContext {
  module: string;
  schema?: SchemaSnapshot;
  schemaModel?: GeneratedSchema;
  nextScopeId: number;
  params: Map<string, Param>;
  globals: Map<string, Global>;
  bindingScopes: Map<string, Set>[];
  // Stack of schema aliases currently being inlined. Used to detect cycles
  // (e.g. alias A := SELECT B; alias B := SELECT A) and to skip alias
  // resolution within an alias's own body.
  aliasResolutionStack?: globalThis.Set<string>;
  // Stack of computed-property bodies currently being inlined (`Type.fieldName`
  // keys). Prevents infinite recursion when a computed body references the
  // same computed transitively.
  computedExprResolutionStack?: globalThis.Set<string>;
}

const defaultCardinality: Cardinality = "unknown";
const defaultMultiplicity: Multiplicity = "unknown";
const defaultVolatility: Volatility = "stable";

// Normalize a string literal that targets `std::datetime` into Gel's canonical
// form: `YYYY-MM-DDTHH:MM:SS+HH:MM` (always two-digit hour/minute/second, full
// timezone offset). Accepts the shorthand `+HH` zone Gel emits in fixtures by
// padding it to `+HH:00` before delegating to `Date`. Returns `undefined` if
// the input doesn't parse — the callsite then falls back to passing the raw
// literal through `CAST(... AS TEXT)` so the runtime surfaces a real error.
const normalizeDateTimeLiteral = (literal: string): string | undefined => {
  const trimmed = literal.trim();
  // Expand `+00` / `-05` zones to `+00:00` / `-05:00`. The check looks at the
  // last 3 chars: a `+`/`-` sign followed by two digits. SQLite's `Date`
  // doesn't accept the shorthand, so without this pad ISO casts that pass on
  // Python silently fail here.
  const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
  const lastSign = Math.max(trimmed.lastIndexOf("+"), trimmed.lastIndexOf("-"));
  let toParse = trimmed;
  if (lastSign > 10 /* past the date part */ && trimmed.length - lastSign === 3) {
    const sign = trimmed[lastSign];
    const h1 = trimmed[lastSign + 1] ?? "";
    const h2 = trimmed[lastSign + 2] ?? "";
    if ((sign === "+" || sign === "-") && isDigit(h1) && isDigit(h2)) {
      toParse = `${trimmed.slice(0, lastSign)}${sign}${h1}${h2}:00`;
    }
  }
  // Extract the sub-second fraction as TEXT before handing to `Date` — JS
  // Date only keeps milliseconds, but Gel datetimes carry microseconds
  // (`datetime_get(.., 'seconds')` and `<str>` round-trips depend on them).
  // Timezone offsets are whole minutes, so shifting to UTC never alters the
  // fraction digits.
  let fracDigits = "";
  const fracMatch = /\.(\d+)/.exec(toParse);
  if (fracMatch) {
    fracDigits = fracMatch[1];
    toParse = toParse.slice(0, fracMatch.index) + toParse.slice(fracMatch.index + fracMatch[0].length);
  }
  const date = new Date(toParse);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  // We always normalize to UTC since `Date` collapses to a fixed instant. The
  // EdgeQL test fixtures stamp `+00` zones, so this preserves the expected
  // wall-clock representation while widening the offset to `+00:00`.
  const yyyy = pad(date.getUTCFullYear(), 4);
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  let frac = fracDigits.slice(0, 6);
  while (frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${frac ? `.${frac}` : ""}+00:00`;
};

// Parse a Postgres-interval-style duration literal ('15:01:22.306916',
// '24 hours', '123 months', '1 day 12:00:00', or ISO 'PT20H') into months /
// days / microseconds components. Returns undefined when unparseable.
const parseIntervalParts = (s: string): { months: number; days: number; us: number } | undefined => {
  let months = 0; let days = 0; let us = 0;
  const str = s.trim();
  if (str === "") return undefined;
  if (/^P/i.test(str)) {
    const m = /^P(?:(-?\d+)Y)?(?:(-?\d+)M)?(?:(-?\d+)W)?(?:(-?\d+)D)?(?:T(?:(-?\d+)H)?(?:(-?\d+)M)?(?:(-?\d+(?:\.\d+)?)S)?)?$/i.exec(str);
    if (!m) return undefined;
    months = Number(m[1] ?? 0) * 12 + Number(m[2] ?? 0);
    days = Number(m[3] ?? 0) * 7 + Number(m[4] ?? 0);
    us = (Number(m[5] ?? 0) * 3600 + Number(m[6] ?? 0) * 60 + Number(m[7] ?? 0)) * 1e6;
    return { months, days, us: Math.round(us) };
  }
  const UNIT_TO_US: Record<string, number> = {
    us: 1, microsecond: 1, microseconds: 1,
    ms: 1000, millisecond: 1000, milliseconds: 1000,
    s: 1e6, sec: 1e6, secs: 1e6, second: 1e6, seconds: 1e6,
    min: 6e7, mins: 6e7, minute: 6e7, minutes: 6e7,
    h: 3.6e9, hr: 3.6e9, hrs: 3.6e9, hour: 3.6e9, hours: 3.6e9,
  };
  const UNIT_TO_DAYS: Record<string, number> = { day: 1, days: 1, d: 1, week: 7, weeks: 7 };
  const UNIT_TO_MONTHS: Record<string, number> = {
    mon: 1, mons: 1, month: 1, months: 1,
    year: 12, years: 12, y: 12,
    decade: 120, decades: 120, century: 1200, centuries: 1200,
    millennium: 12000, millenniums: 12000, millennia: 12000,
  };
  const tokenRe = /(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)|([+-]?\d+):(\d+)(?::(\d+(?:\.\d+)?))?/g;
  let matched = false;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(str)) !== null) {
    // Reject inputs with garbage between tokens.
    if (str.slice(lastIndex, m.index).trim() !== "") return undefined;
    lastIndex = tokenRe.lastIndex;
    matched = true;
    if (m[3] !== undefined) {
      const sign = m[3].startsWith("-") ? -1 : 1;
      us += sign * (Math.abs(Number(m[3])) * 3600 + Number(m[4]) * 60 + Number(m[5] ?? 0)) * 1e6;
      continue;
    }
    const qty = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit in UNIT_TO_US) us += qty * UNIT_TO_US[unit];
    else if (unit in UNIT_TO_DAYS) days += qty * UNIT_TO_DAYS[unit];
    else if (unit in UNIT_TO_MONTHS) months += qty * UNIT_TO_MONTHS[unit];
    else return undefined;
  }
  if (!matched || str.slice(lastIndex).trim() !== "") return undefined;
  return { months, days, us: Math.round(us) };
};

// Format duration components in Gel's canonical ISO-ish form: 'PT24H',
// 'P1300Y', 'P11M20D', 'PT1M22.306916S', zero → 'PT0S'. Exact durations
// (std::duration) fold days/months into hours.
const formatDurationParts = (parts: { months: number; days: number; us: number }, exact: boolean): string => {
  let { months, days, us } = parts;
  if (exact) {
    us += (months * 30 + days) * 86400 * 1e6;
    months = 0; days = 0;
  }
  const neg = us < 0 && months === 0 && days === 0;
  let rest = Math.abs(us);
  const h = Math.floor(rest / 3.6e9); rest -= h * 3.6e9;
  const mi = Math.floor(rest / 6e7); rest -= mi * 6e7;
  const sWhole = Math.floor(rest / 1e6); rest -= sWhole * 1e6;
  let secStr = String(sWhole);
  if (rest > 0) {
    let frac = String(Math.round(rest)).padStart(6, "0");
    while (frac.endsWith("0")) frac = frac.slice(0, -1);
    secStr += `.${frac}`;
  }
  const y = Math.trunc(months / 12);
  const mo = months - y * 12;
  let out = "P";
  if (y) out += `${y}Y`;
  if (mo) out += `${mo}M`;
  if (days) out += `${days}D`;
  const timeParts: string[] = [];
  if (h) timeParts.push(`${neg ? "-" : ""}${h}H`);
  if (mi) timeParts.push(`${neg ? "-" : ""}${mi}M`);
  if (sWhole || rest > 0) timeParts.push(`${neg ? "-" : ""}${secStr}S`);
  if (timeParts.length > 0) out += `T${timeParts.join("")}`;
  if (out === "P") out = "PT0S";
  return out;
};

const normalizeDurationLiteral = (literal: string, exact: boolean): string | undefined => {
  const parts = parseIntervalParts(literal);
  return parts ? formatDurationParts(parts, exact) : undefined;
};

const scalarToStdName = (scalar: ScalarType): string => {
  switch (scalar) {
    case "str":
      return "std::str";
    case "int":
      return "std::int64";
    case "float":
      return "std::float64";
    case "bool":
      return "std::bool";
    case "json":
      return "std::json";
    case "datetime":
      return "std::datetime";
    case "duration":
      return "std::duration";
    case "local_datetime":
      return "cal::local_datetime";
    case "local_date":
      return "cal::local_date";
    case "local_time":
      return "cal::local_time";
    case "relative_duration":
      return "cal::relative_duration";
    case "date_duration":
      return "cal::date_duration";
    case "uuid":
      return "std::uuid";
    default:
      return "std::anyscalar";
  }
};

const getSchemaTypeByQualifiedName = (ctx: IRCompileContext, qualifiedName: string): TypeDef | undefined => {
  const modelType = ctx.schemaModel?.typesByName[qualifiedName];
  if (modelType) {
    return {
      name: modelType.name,
      module: modelType.module,
      abstract: modelType.abstract,
      extends: [...modelType.extends],
      fields: modelType.fields.map((field) => ({ ...field })),
      links: modelType.links.map((link) => ({ ...link })),
    };
  }
  return ctx.schema?.getType(qualifiedName);
};

const getResolvedSchemaType = (ctx: IRCompileContext, qualifiedName: string): GeneratedSchemaType | undefined => {
  return ctx.schemaModel?.typesByName[qualifiedName];
};

const listSchemaTypeDefs = (ctx: IRCompileContext): TypeDef[] => {
  if (ctx.schemaModel) {
    return ctx.schemaModel.typeNames
      .map((name) => ctx.schemaModel?.typesByName[name])
      .filter((entry): entry is GeneratedSchemaType => !!entry)
      .map((entry) => ({
        name: entry.name,
        module: entry.module,
        abstract: entry.abstract,
        extends: [...entry.extends],
        fields: entry.fields.map((field) => ({ ...field })),
        links: entry.links.map((link) => ({ ...link })),
      }));
  }
  return ctx.schema ? ctx.schema.listTypes() : [];
};

const qualifyTypeName = (name: string, moduleName: string): string => (name.includes("::") ? name : `${moduleName}::${name}`);

const getSchemaType = (ctx: IRCompileContext, name: string): TypeDef | undefined => {
  if (!ctx.schema && !ctx.schemaModel) {
    return undefined;
  }
  const qualified = qualifyTypeName(name, ctx.module);
  return getSchemaTypeByQualifiedName(ctx, qualified)
    ?? getSchemaTypeByQualifiedName(ctx, name)
    ?? getSchemaTypeByQualifiedName(ctx, `default::${name}`);
};

const collectDerivedTypes = (ctx: IRCompileContext, baseQualified: string): TypeDef[] => {
  const allTypes = listSchemaTypeDefs(ctx);
  const queue = [baseQualified];
  const seen = new globalThis.Set<string>();
  const derived: TypeDef[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    for (const candidate of allTypes) {
      const candidateQualified = qualifyTypeName(candidate.name, candidate.module ?? "default");
      if (seen.has(candidateQualified) || candidateQualified === current) {
        continue;
      }
      const extendsCurrent = (candidate.extends ?? []).some((base) => {
        const qualifiedBase = qualifyTypeName(base, candidate.module ?? "default");
        return qualifiedBase === current || base === current;
      });
      if (!extendsCurrent) {
        continue;
      }
      seen.add(candidateQualified);
      derived.push(candidate);
      queue.push(candidateQualified);
    }
  }

  return derived;
};

const typeRefFromTypeDef = (ctx: IRCompileContext, typeDef: TypeDef, seen: globalThis.Set<string> = new globalThis.Set<string>()): TypeRef => {
  const qualified = qualifiedTypeName(typeDef);
  const typeRef: TypeRef = {
    kind: "type_ref",
    id: qualified,
    nameHint: qualified,
    module: typeDef.module ?? "default",
    isView: false,
    isScalar: false,
    isAbstract: Boolean(typeDef.abstract),
    inSchema: true,
  };

  if (seen.has(qualified)) {
    return typeRef;
  }

  const nextSeen = new globalThis.Set(seen);
  nextSeen.add(qualified);
  const resolved = getResolvedSchemaType(ctx, qualified);
  const children = resolved
    ? resolved.concreteSubtypes
      .map((name) => getSchemaTypeByQualifiedName(ctx, name))
      .filter((candidate): candidate is TypeDef => !!candidate)
      .map((candidate) => typeRefFromTypeDef(ctx, candidate, nextSeen))
    : collectDerivedTypes(ctx, qualified)
      .map((candidate) => typeRefFromTypeDef(ctx, candidate, nextSeen));
  if (children.length > 0) {
    typeRef.children = children;
  }
  return typeRef;
};

const scalarTypeRef = (scalar: ScalarType): TypeRef => {
  const qualified = scalarToStdName(scalar);
  const [moduleName, typeName] = qualified.split("::");
  return {
    kind: "type_ref",
    id: qualified,
    nameHint: qualified,
    module: moduleName ?? "std",
    isView: false,
    isScalar: true,
    isAbstract: false,
    inSchema: true,
    collection: typeName === "array" || typeName === "tuple" ? typeName : undefined,
  };
};

const resolveTypeRef = (ctx: IRCompileContext, name: string): TypeRef => {
  const typeDef = getSchemaType(ctx, name);
  if (typeDef) {
    return typeRefFromTypeDef(ctx, typeDef);
  }
  if (isUniversalObjectRefName(name)) {
    return universalObjectTypeRef(ctx, name);
  }
  // Parametric tuple types (`tuple<…>`) resolve into a structured TypeRef
  // carrying `collection` + `subtypes` so SQL lowering reads tuple slots from
  // structure instead of re-parsing the type name. Scoped to tuples on purpose:
  // `array<…>` is intentionally left to the `unknownTypeRef` fallback below, so
  // the existing array-comparison lowering (which keys off the `unknown:`-
  // prefixed id form) is unaffected.
  const tupleRef = parseTupleStructuredTypeRef(ctx, name);
  if (tupleRef) {
    return tupleRef;
  }
  // Unqualified builtin scalars (`str`, `int64`, …) should resolve as
  // `std::*` rather than `<active-module>::*` so downstream SQL lowering
  // recognises them via `sqlCastTarget` / `qualifyTypeName`.
  if (!name.includes("::") && BUILTIN_SCALAR_NAMES[name]) {
    return unknownTypeRef(BUILTIN_SCALAR_NAMES[name]);
  }
  return unknownTypeRef(qualifyTypeName(name, ctx.module));
};

// INSERT/UPDATE subjects may name a WITH binding that aliases a type
// (`WITH T1 := Tree, INSERT T1 {…}`). Prefer the binding's object type so the
// DML targets the real storage table instead of a phantom `default__t1`.
const resolveSubjectTypeRef = (ctx: IRCompileContext, name: string): TypeRef => {
  const bound = resolveBinding(ctx, name);
  if (bound && !bound.typeref.isScalar && !bound.typeref.id.startsWith("unknown:")) {
    return bound.typeref;
  }
  return resolveTypeRef(ctx, name);
};

// Parse a parametric tuple type *name* (`tuple<a: str, b: int64>`,
// `tuple<str, int64>`, optionally `default::`/`std::`-prefixed) into a
// structured TypeRef with `collection: "tuple"`, recursively-resolved
// `subtypes`, and per-slot `elementName` for named tuples. Returns undefined
// for anything that isn't a tuple (including `array<…>`).
//
// IMPORTANT: this is the ONE legitimate place a tuple type *name* string is
// turned into structure — the IR boundary where names become TypeRefs.
// Downstream stages (notably SQL lowering in gel_ir_compiler.ts's
// `tupleTypeSlots`) MUST read `collection` / `subtypes` / `elementName` instead
// of re-parsing the name. The remaining upstream string-collapse is the parser
// (`parseCastTypeName` flattens cast types back to a string); if that ever
// emits a structured AST node, this becomes a thin adapter rather than a parser.
const parseTupleStructuredTypeRef = (ctx: IRCompileContext, name: string): TypeRef | undefined => {
  const trimmed = name.trim();
  const open = trimmed.indexOf("<");
  if (open < 0 || !trimmed.endsWith(">")) return undefined;
  const head = trimmed.slice(0, open).trim();
  const bare = head.includes("::") ? (head.split("::").pop() ?? head) : head;
  if (bare !== "tuple") return undefined;
  const collection = "tuple" as const;
  const inner = trimmed.slice(open + 1, -1);
  // Depth-aware split on top-level commas so nested `tuple<…>` / `array<…>`
  // arguments stay intact.
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= inner.length; i += 1) {
    const c = inner[i];
    if (c === "<") depth += 1;
    else if (c === ">") depth -= 1;
    if ((c === "," && depth === 0) || i === inner.length) {
      const part = inner.slice(start, i).trim();
      start = i + 1;
      if (part.length > 0) parts.push(part);
    }
  }
  const subtypes: TypeRef[] = parts.map((part) => {
    // Named tuple element: `name: type`. Only a lone `:` at depth 0 counts —
    // a `::` (qualified name like `std::int64`) is a positional element.
    let colonIdx = -1;
    let d = 0;
    for (let j = 0; j < part.length; j += 1) {
      const ch = part[j];
      if (ch === "<") d += 1;
      else if (ch === ">") d -= 1;
      else if (ch === ":" && d === 0 && part[j + 1] !== ":" && part[j - 1] !== ":") {
        colonIdx = j;
        break;
      }
    }
    if (collection === "tuple" && colonIdx > 0) {
      const elementName = part.slice(0, colonIdx).trim();
      return { ...resolveTypeRef(ctx, part.slice(colonIdx + 1).trim()), elementName };
    }
    return resolveTypeRef(ctx, part);
  });
  // Reconstruct the canonical tuple type name from the *resolved* subtypes so
  // element types are fully qualified (`tuple<std::str, std::str>`). Naively
  // running the raw `tuple<str, str>` through qualifyTypeName would mis-prefix
  // the whole thing as `default::tuple<...>` because it has no top-level `::`.
  const cleanId = (st: TypeRef): string => {
    const raw = st.id ?? st.nameHint ?? "";
    return raw.startsWith("unknown:") ? raw.slice("unknown:".length) : raw;
  };
  const canonical = `tuple<${subtypes
    .map((st) => (st.elementName ? `${st.elementName}: ${cleanId(st)}` : cleanId(st)))
    .join(", ")}>`;
  return {
    kind: "type_ref",
    id: canonical,
    nameHint: canonical,
    module: "std",
    isView: false,
    isScalar: false,
    isAbstract: false,
    collection,
    subtypes,
  };
};

// Coerce an inlined UDF argument Set so its tuple values carry the element
// NAMES declared by the parameter's type. A call like `foo((1,))` where `foo`
// declares `x: tuple<a: int64>` passes a POSITIONAL tuple, but inside the body
// `x` is a NAMED tuple — its result must serialize as `{"a": 1}` and `.a` must
// resolve to the element. The call-site argument compiles to a tuple with
// `named: false` / element name `"0"`; here we rewrite each tuple value reached
// through the set-shaped wrappers (UNION operands, SELECT/FOR bodies) to be
// `named: true` with the declared element names. Returns the (possibly
// rewritten) Set; a no-op when the declared type isn't a named tuple or the
// argument doesn't structurally contain a same-arity tuple to rename.
const coerceArgToNamedTupleType = (
  ctx: IRCompileContext,
  argIR: Set,
  declaredType: string,
): Set => {
  const declaredRef = parseTupleStructuredTypeRef(ctx, declaredType);
  if (!declaredRef || declaredRef.collection !== "tuple") return argIR;
  const declaredSubtypes = declaredRef.subtypes ?? [];
  const elementNames = declaredSubtypes.map((st) => st.elementName);
  // Only a tuple with at least one explicitly-named slot needs renaming.
  if (!elementNames.some((n) => n !== undefined)) return argIR;

  const rewriteTuple = (tuple: Tuple): Tuple => {
    if (tuple.elements.length !== elementNames.length) return tuple;
    return {
      ...tuple,
      named: true,
      elements: tuple.elements.map((el, i) => ({
        ...el,
        name: elementNames[i] ?? el.name ?? String(i),
      })),
    };
  };

  // Recurse through the set-shaped wrappers a tuple-valued argument can sit
  // behind: UNION of tuples (`{(1,), (2,)}`), SELECT/FOR wrappers, etc. The
  // walk only rewrites `tuple` exprs and rebuilds the spine around them.
  const rewrite = (set: Set): Set => {
    const e = set.expr;
    if (e.kind === "tuple") {
      return { ...set, expr: rewriteTuple(e as Tuple) };
    }
    if (e.kind === "operator_call" && (e as OperatorCall).operator === "union") {
      const op = e as OperatorCall;
      const newArgs: Record<string, CallArg> = {};
      for (const [k, arg] of Object.entries(op.args)) {
        newArgs[k] = { ...arg, expr: rewrite(arg.expr) };
      }
      return { ...set, expr: { ...op, args: newArgs } };
    }
    if (e.kind === "select_expr") {
      const sel = e as SelectExpr;
      return { ...set, expr: { ...sel, result: rewrite(sel.result) } };
    }
    if (e.kind === "for_expr") {
      const fr = e as unknown as { body: Set };
      return { ...set, expr: { ...(e as object), body: rewrite(fr.body) } as typeof e };
    }
    return set;
  };

  return rewrite(argIR);
};

const isUniversalObjectRefName = (name: string): boolean => {
  const last = name.includes("::") ? name.split("::").at(-1) : name;
  return last === "Object" || last === "BaseObject";
};

const universalObjectTypeRef = (ctx: IRCompileContext, name: string): TypeRef => {
  const last = name.includes("::") ? (name.split("::").at(-1) ?? name) : name;
  const qualified = name.includes("::") ? name : `std::${last}`;
  const children = listSchemaTypeDefs(ctx)
    .filter((candidate) => !candidate.abstract)
    .map((candidate) => typeRefFromTypeDef(ctx, candidate));
  const typeRef: TypeRef = {
    kind: "type_ref",
    id: qualified,
    nameHint: qualified,
    module: qualified.split("::")[0] ?? "std",
    isView: false,
    isScalar: false,
    isAbstract: true,
    inSchema: true,
  };
  if (children.length > 0) {
    typeRef.children = children;
  }
  return typeRef;
};

// The implicit `id` pointer every object carries. It isn't stored in
// `typeDef.fields`, so `resolvePointerRef` can't find it — both the splat
// expansion and an explicit `{ id }` shape element synthesise it from here.
const idPointerRef = (source: TypeRef): PointerRef => ({
  kind: "pointer_ref",
  id: `${source.id}.id`,
  name: "id",
  shortName: "id",
  outSource: source,
  outTarget: { kind: "type_ref", id: "std::uuid", nameHint: "std::uuid", module: "std", isView: false, isScalar: true, isAbstract: false, inSchema: true },
  outCardinality: "one",
  inCardinality: "many",
  isComputed: false,
  isIdPointer: true,
  isLinkProperty: false,
  hasProperties: false,
});

const collectionFieldTargetRef = (field: FieldDef): TypeRef => {
  const base = scalarTypeRef(field.type);
  if (!field.collection) return base;
  // Collection-typed properties store JSON (`field.type === "json"`), but the
  // logical type is `array<…>` / `tuple<…>`. Carry the collection marker so
  // downstream (e.g. polymorphic `len`) can distinguish element-count from
  // character-length semantics.
  return { ...base, collection: field.collection.kind };
};

const pointerRefFromField = (source: TypeRef, field: FieldDef): PointerRef => ({
  kind: "pointer_ref",
  id: `${source.id}.field::${field.name}`,
  name: field.name,
  shortName: field.name,
  outSource: source,
  outTarget: collectionFieldTargetRef(field),
  outCardinality: field.multi
    ? (field.required ? "at_least_one" : "many")
    : (field.required ? "one" : "at_most_one"),
  inCardinality: "many",
  isComputed: false,
  isIdPointer: field.name === "id",
  isLinkProperty: false,
  isExclusive: (field.constraints ?? []).some(
    (constraint) => constraint.name === "std::exclusive" || constraint.name === "exclusive",
  ),
  hasProperties: false,
});

const pointerRefFromLink = (source: TypeRef, target: TypeRef, link: LinkDef): PointerRef => {
  // EdgeQL: when the forward link is `constraint exclusive`, each target
  // is referenced by at most one source row, so the inbound (backlink)
  // cardinality is at-most-one rather than many.
  const isExclusive = (link.constraints ?? []).some(
    (constraint) => constraint.name === "std::exclusive" || constraint.name === "exclusive",
  );
  return {
    kind: "pointer_ref",
    id: `${source.id}.link::${link.name}`,
    name: link.name,
    shortName: link.name,
    outSource: source,
    outTarget: target,
    // Mirror pointerRefFromField: a `required` link has a lower bound of one
    // (`one` / `at_least_one`), so `.owner` on a required link is single-and-
    // present — not `at_most_one`, which would mislead cardinality inference
    // into thinking `owner := .owner` may be empty.
    outCardinality: link.multi
      ? (link.required ? "at_least_one" : "many")
      : (link.required ? "one" : "at_most_one"),
    inCardinality: isExclusive ? "at_most_one" : "many",
    isComputed: false,
    isIdPointer: false,
    isLinkProperty: false,
    hasProperties: (link.properties?.length ?? 0) > 0,
  };
};

const mkCallArg = (expr: Set): CallArg => ({
  kind: "call_arg",
  expr,
  cardinality: "unknown",
  multiplicity: "unknown",
  isDefault: false,
  paramTypemod: "singleton",
  polymorphism: "not_used",
});

const createRootScope = (): ScopeTreeNode => ({
  kind: "scope_tree_node",
  uniqueId: 1,
  children: [],
  namespaces: [],
  fenced: false,
  optional: false,
});

const unknownTypeRef = (nameHint: string): TypeRef => {
  const ref: TypeRef = {
    kind: "type_ref",
    id: `unknown:${nameHint}`,
    nameHint,
    module: nameHint.includes("::") ? nameHint.split("::")[0] : "default",
    isView: false,
    isScalar: false,
    isAbstract: false,
  };
  // Collection-typed names (`array<...>`, `tuple<...>`, `range<...>`) carry
  // a `collection` marker that downstream shape-projection / SQL-lowering
  // code uses to decide whether to wrap the value with `json(...)` (so the
  // JSON structure is preserved through aggregation) vs treat it as an
  // opaque scalar.
  if (nameHint.startsWith("array<")) ref.collection = "array";
  else if (nameHint.startsWith("tuple<")) ref.collection = "tuple";
  else if (nameHint.startsWith("range<")) ref.collection = "range";
  else if (nameHint.startsWith("multirange<")) ref.collection = "multirange";
  return ref;
};

const defaultPathId = (name: string): PathId => ({
  kind: "path_id",
  namespace: [],
  isPointerPath: false,
  steps: [
    {
      type: unknownTypeRef(name),
    },
  ],
});

const setFromTypeRoot = (typeref: TypeRef): Set => ({
  kind: "set",
  expr: {
    kind: "type_root",
    typeref,
    skipSubtypes: false,
    isCachedGlobal: false,
  } as TypeRoot,
  pathId: {
    kind: "path_id",
    namespace: [],
    isPointerPath: false,
    steps: [{ type: typeref }],
  },
  typeref,
  shape: [],
  isBinding: false,
  isMaterializedRef: false,
  isSchemaAlias: false,
});

const extendPathSet = (source: Set, ptrref: PointerRef): Set =>
  // A computed link alias defined as a backlink (`link winner := .<awards[is
  // User]`) carries `computedLinkAliasIsBackward`; traversing it walks the
  // underlying pointer *backward* (target -> source). Honour that here so the
  // single source of truth for building a pointer step is direction-aware,
  // rather than special-casing the flag at every call site.
  extendPathSetDirectional(source, ptrref, ptrref.computedLinkAliasIsBackward ? "inbound" : "outbound");

// The cardinality of a pointer step as seen from the *result* of traversing it.
// A forward step uses `outCardinality`; a backward-traversed computed alias
// (`link winner := .<awards[is User]`) uses `inCardinality` — e.g. an exclusive
// `awards` link makes the inverse `winner` single rather than many.
const effectivePointerCardinality = (ptrref: PointerRef): Cardinality =>
  ptrref.computedLinkAliasIsBackward ? ptrref.inCardinality : ptrref.outCardinality;

const extendPathSetDirectional = (source: Set, ptrref: PointerRef, direction: "outbound" | "inbound"): Set => {
  const resultType = direction === "outbound" ? ptrref.outTarget : ptrref.outSource;
  return {
    kind: "set",
    expr: {
      kind: "pointer",
      source,
      ptrref,
      direction,
      isDefinition: false,
    } as Pointer,
    pathId: {
      kind: "path_id",
      namespace: source.pathId?.namespace ?? [],
      isPointerPath: true,
      steps: [...(source.pathId?.steps ?? [{ type: source.typeref }]), { type: resultType, pointer: ptrref }],
    },
    typeref: resultType,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

// Walk the parsed AST for bare-parameter (`$N`) usage that the EdgeQL spec
// requires to be wrapped in a type cast, and reject shape projections applied
// to a parameter set (`<int64>$0 { id }`) — there is no underlying object to
// shape. We thread an `insideCast` flag through the walk; once any explicit
// `<T>$0` covers a parameter, it's typed and any nested occurrence is OK.
const validateParametersInStatement = (statement: EdgeQLStatement): void => {
  const visitExpr = (expr: unknown, insideCast: boolean): void => {
    if (!expr || typeof expr !== "object") return;
    const node = expr as Record<string, unknown> & { kind?: string };
    if (node.kind === "parameter") {
      if (!insideCast) {
        const name = typeof node.name === "string" ? node.name : "";
        throw new AppError("E_SEMANTIC", `missing a type cast before the parameter $${name}`, 1, 1);
      }
      return;
    }
    if (node.kind === "cast") {
      visitExpr(node.expr, true);
      return;
    }
    if (node.kind === "shape_projection") {
      const inner = node.expr as Record<string, unknown> | undefined;
      const innerKind = inner && typeof inner === "object" ? (inner as { kind?: string }).kind : undefined;
      const isParamShape = innerKind === "parameter"
        || (innerKind === "cast" && ((inner as { expr?: { kind?: string } }).expr?.kind === "parameter"));
      if (isParamShape) {
        throw new AppError("E_SEMANTIC", "cannot apply a shape to the parameter", 1, 1);
      }
      visitExpr(node.expr, insideCast);
      if (Array.isArray(node.shape)) {
        for (const el of node.shape) visitExpr(el, insideCast);
      }
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visitExpr(item, insideCast);
      } else if (value && typeof value === "object") {
        visitExpr(value, insideCast);
      }
    }
  };

  if (statement.kind === "select_expr") {
    visitExpr(statement.expr, false);
    return;
  }
  if (statement.kind === "select_free") {
    for (const entry of statement.entries) visitExpr(entry.expr, false);
    return;
  }
  if (statement.kind === "select") {
    if (statement.filter) visitExpr(statement.filter, false);
    if (statement.shape) for (const el of statement.shape) visitExpr(el, false);
    if (statement.limit) visitExpr(statement.limit, false);
    if (statement.offset) visitExpr(statement.offset, false);
  }
};

const containsSubSelect = (expr: FreeObjectExpr): boolean => {
  if (!expr || typeof expr !== "object") return false;
  if (expr.kind === "select_expr_subquery") return true;
  if (expr.kind === "field_access") return containsSubSelect(expr.expr);
  if (expr.kind === "cast") return containsSubSelect(expr.expr);
  if (expr.kind === "exists" || expr.kind === "not") return containsSubSelect((expr as { expr: FreeObjectExpr }).expr);
  if (expr.kind === "index_access") return containsSubSelect(expr.expr);
  return false;
};

// The "effective" output shape of a set, peeling binding wrappers so a
// re-projection (`select X { …, b }` where `X := (for n in {…} select T { b := n })`)
// can adopt a computed pointer the binding materialised inside a FOR body or a
// nested select. A bare binding ref's own `.shape` is empty — the shape lives
// on the for_expr's body / select_expr's result / the first union arm.
function gatherBindingShape(set: Set, depth = 0): ShapeElement[] {
  if (set.shape && set.shape.length > 0) return set.shape;
  if (depth > 8) return [];
  const ex = set.expr;
  if (ex.kind === "select_expr") return gatherBindingShape((ex as SelectExpr).result, depth + 1);
  if (ex.kind === "for_expr") return gatherBindingShape((ex as ForExpr).body, depth + 1);
  if (ex.kind === "operator_call" && (ex as OperatorCall).operator === "union") {
    for (const arg of Object.values((ex as OperatorCall).args)) {
      const s = gatherBindingShape((arg as CallArg).expr, depth + 1);
      if (s.length > 0) return s;
    }
  }
  return [];
}

const shapeRequestsLinkProperty = (shape: EdgeQLShapeElement[]): boolean => {
  for (const el of shape) {
    if (el.kind === "field" && el.name.startsWith("@")) return true;
    if (el.kind === "computed") {
      if (el.name.startsWith("@")) return true;
      if (el.expr.kind === "field_ref" && el.expr.field.startsWith("@")) return true;
    }
  }
  return false;
};

// The Gel restriction this guards (`(select User).deck { linkprop := @count }`)
// applies when the projection base traverses a LINK out of a subselect — the
// implicitly-referenced object set would be interpreted differently at the
// link path and at the shape. A bare object subselect base
// (`(SELECT Subordinate LIMIT 1) { @comment := … }`) is the canonical way to
// assign a link property to a selected target and is allowed.
const baseTraversesLinkOverSubSelect = (expr: FreeObjectExpr | undefined): boolean => {
  if (!expr || typeof expr !== "object") return false;
  if (expr.kind === "field_access") {
    return containsSubSelect(expr.expr) || baseTraversesLinkOverSubSelect(expr.expr);
  }
  if (expr.kind === "select_expr_subquery") return baseTraversesLinkOverSubSelect(expr.expr as FreeObjectExpr);
  if (expr.kind === "shape_projection") return baseTraversesLinkOverSubSelect((expr as { expr: FreeObjectExpr }).expr);
  return false;
};

const validateShapeProjectionLinkPropContext = (expr: Extract<FreeObjectExpr, { kind: "shape_projection" }>): void => {
  if (!shapeRequestsLinkProperty(expr.shape)) return;
  if (baseTraversesLinkOverSubSelect(expr.expr)) {
    throw new AppError(
      "E_SEMANTIC",
      "implicit reference to an object changes the interpretation of it elsewhere in the query",
      1,
      1,
    );
  }
};

const resolvePointerRef = (ctx: IRCompileContext, source: TypeRef, field: string): PointerRef | undefined => {
  // Every object type carries an implicit `id` pointer that isn't part of its
  // declared fields/links, so it never appears in `resolvedFields`. Surface it
  // explicitly so `FILTER .id = …` / `.id IN {…}` resolve to a real scalar
  // pointer (the `id` column) instead of collapsing to the bare subject set.
  if (field === "id" && !source.isScalar) {
    return idPointerRef(source);
  }
  const sourceType = getResolvedSchemaType(ctx, source.id);
  if (sourceType) {
    const schemaField = sourceType.resolvedFields.find((candidate) => candidate.name === field);
    if (schemaField) {
      return pointerRefFromField(source, schemaField);
    }
    const schemaLink = sourceType.resolvedLinks.find((candidate) => candidate.name === field);
    if (schemaLink) {
      const target = resolveTypeRef(ctx, schemaLink.targetType);
      return pointerRefFromLink(source, target, schemaLink);
    }
    const schemaComputed = ctx.schema?.getType(source.id)?.computeds?.find((candidate) => candidate.kind === "link" && candidate.name === field);
    if (schemaComputed?.kind === "link" && schemaComputed.expr.kind === "backlink") {
      const backlink = resolveBacklinkPointerRef(ctx, source, schemaComputed.expr.link, schemaComputed.expr.sourceType);
      return backlink ? { ...backlink, computedLinkAliasIsBackward: true } : undefined;
    }
    return undefined;
  }

  // Named union source (`link stw -> S | T | W`): the union type itself has no
  // members, so probe each component for the field. The SQL polymorphic source
  // projects the column from each concrete branch (NULL where absent).
  if (source.id.includes("|")) {
    const componentIds = source.id.replace(/^unknown:/, "").split("|").map((part) => part.trim());
    for (const componentId of componentIds) {
      const componentDef = getResolvedSchemaType(ctx, componentId) ?? ctx.schema?.getType(componentId);
      if (!componentDef) continue;
      // `resolvedFields`/`resolvedLinks` only exist on GeneratedSchemaType;
      // a plain TypeDef exposes the unresolved `fields`/`links` instead.
      const componentFields = "resolvedFields" in componentDef ? componentDef.resolvedFields : componentDef.fields;
      const cField = (componentFields ?? []).find((c) => c.name === field);
      if (cField) {
        return pointerRefFromField(source, cField);
      }
      const componentLinks = "resolvedLinks" in componentDef ? componentDef.resolvedLinks : componentDef.links;
      const cLink = (componentLinks ?? []).find((c) => c.name === field);
      if (cLink) {
        return pointerRefFromLink(source, resolveTypeRef(ctx, cLink.targetType), cLink);
      }
    }
  }

  // Universal `Object` / `BaseObject` source: probe the concrete subtype set
  // for the field so `.name` on `Object` lowers as a polymorphic column
  // reference. The SQL pipeline's polymorphic source projects NULL for
  // branches missing the column.
  if (isUniversalObjectRefName(source.id)) {
    const children = source.children ?? [];
    for (const child of children) {
      if (child.isAbstract) continue;
      const childDef = ctx.schema?.getType(child.id);
      if (!childDef) continue;
      const cField = childDef.fields.find((c) => c.name === field);
      if (cField) {
        return pointerRefFromField(source, cField);
      }
    }
  }

  const sourceTypeDef = ctx.schema?.getType(source.id);
  if (!sourceTypeDef) {
    return undefined;
  }

  const findFieldOrLink = (typeName: string, seen = new Set<string>()): { kind: "field"; field: FieldDef } | { kind: "link"; link: LinkDef } | undefined => {
    if (!ctx.schema || seen.has(typeName)) {
      return undefined;
    }
    seen.add(typeName);
    const typeDef = ctx.schema.getType(typeName);
    if (!typeDef) {
      return undefined;
    }

    const directField = typeDef.fields.find((candidate) => candidate.name === field);
    if (directField) {
      return { kind: "field", field: directField };
    }
    const directLink = (typeDef.links ?? []).find((candidate) => candidate.name === field);
    if (directLink) {
      return { kind: "link", link: directLink };
    }

    for (const baseName of typeDef.extends ?? []) {
      const inherited = findFieldOrLink(baseName, seen);
      if (inherited) {
        return inherited;
      }
    }
    return undefined;
  };

  const resolved = findFieldOrLink(source.id);
  if (resolved?.kind === "field") {
    return pointerRefFromField(source, resolved.field);
  }
  if (resolved?.kind === "link") {
    const target = resolveTypeRef(ctx, resolved.link.targetType);
    return pointerRefFromLink(source, target, resolved.link);
  }
  const computed = sourceTypeDef.computeds?.find((candidate) => candidate.kind === "link" && candidate.name === field);
  if (computed?.kind === "link" && computed.expr.kind === "backlink") {
    const backlink = resolveBacklinkPointerRef(ctx, source, computed.expr.link, computed.expr.sourceType);
    return backlink ? { ...backlink, computedLinkAliasIsBackward: true } : undefined;
  }
  return undefined;
};

const resolveBacklinkPointerRef = (
  ctx: IRCompileContext,
  target: TypeRef,
  linkName: string,
  sourceTypeName?: string,
): PointerRef | undefined => {
  if (!ctx.schema && !ctx.schemaModel) {
    return undefined;
  }
  const sourceHint = sourceTypeName ? resolveTypeRef(ctx, sourceTypeName).id : undefined;
  const hintTypeDef = sourceHint ? ctx.schema?.getType(sourceHint) : undefined;
  // Set of concrete-subtype ids that should be considered when `[IS T]` filters
  // by an abstract (or otherwise polymorphic) supertype. When the filter is a
  // concrete type, this collapses to `{filter id}`.
  const allowedSourceIds = sourceHint
    ? new globalThis.Set<string>([sourceHint, ...(hintTypeDef && ctx.schema ? ctx.schema.concreteTypeNamesUnder(sourceHint) : [])])
    : undefined;
  // Targets accepted by this backlink. Includes the requested type and any
  // ancestor whose link target is a union (`Issue.references: File | URL | …`)
  // that contains the requested type — the backlink should match when the
  // file's id appears as a `target` in the union link's storage table.
  const targetMatches = (linkTargetTypeName: string): boolean => {
    if (linkTargetTypeName === target.id) return true;
    if (!linkTargetTypeName.includes("|")) return false;
    return linkTargetTypeName
      .split("|")
      .map((part) => part.trim())
      .some((part) => {
        const resolved = resolveTypeRef(ctx, part);
        if (resolved.id === target.id) return true;
        // Union branch may itself be a supertype of the requested target;
        // accept that too so `<references[IS Issue]` on a File still matches.
        const branchAssignable = ctx.schema?.concreteTypeNamesUnder(part) ?? [];
        return branchAssignable.includes(target.id);
      });
  };
  const matches: PointerRef[] = [];
  // When the backlink is unqualified (no `[IS T]`), Python errors if ANY type
  // in the schema defines the link as computed — the result set's identity
  // can't be reasoned about. Surface the same error here so users get the
  // canonical message instead of a partially-correct result that quietly
  // drops computed-link rows.
  if (!sourceHint) {
    // Computed-link aliases live on the schema snapshot's `computeds` (the
    // generated schema model drops them), so consult `ctx.schema` directly.
    const allTypeDefs = ctx.schema?.listTypes() ?? [];
    for (const typeDef of allTypeDefs) {
      const computed = (typeDef.computeds ?? []).find(
        (candidate) => candidate.kind === "link" && candidate.name === linkName,
      );
      if (computed) {
        throw new AppError(
          "E_SEMANTIC",
          `cannot follow backlink '${linkName}' because link '${linkName}' of object type '${qualifyTypeNameOf(typeDef)}' is computed`,
          1,
          1,
        );
      }
    }
  }
  for (const typeDef of listSchemaTypeDefs(ctx)) {
    const sourceRef = typeRefFromTypeDef(ctx, typeDef);
    if (allowedSourceIds && !allowedSourceIds.has(sourceRef.id)) {
      continue;
    }
    const link = (typeDef.links ?? []).find((candidate) => candidate.name === linkName);
    if (!link) {
      continue;
    }
    const linkTarget = resolveTypeRef(ctx, link.targetType);
    if (!targetMatches(link.targetType)) {
      continue;
    }
    matches.push(pointerRefFromLink(sourceRef, linkTarget, link));
  }
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  // Abstract `[IS T]` covering multiple concrete sources: surface a union
  // ptrref. The SQL compiler reads `outSource` / `unionComponents` when
  // building the polymorphic FROM, and the link table is per-concrete-type.
  const merged: PointerRef = { ...matches[0] };
  merged.unionComponents = matches;
  // outSource broadens to the requested abstract type so downstream type
  // queries (e.g. `[IS Named]`) reason against the filter, not just the
  // first concrete source.
  if (sourceHint) {
    merged.outSource = resolveTypeRef(ctx, sourceHint);
  }
  return merged;
};

const qualifyTypeNameOf = (typeDef: TypeDef): string => `${typeDef.module}::${typeDef.name}`;

// `T.<computed-property>` resolves at AST→IR time by substituting the
// computed body. Supports the structured property-computed shapes the SDL
// adapter emits (literal, set-of-literals, concat of literal/param parts).
// Returns undefined when the type has no such computed or the body uses a
// shape we don't lower here — callers fall through to their existing failure
// handling.
const tryLowerComputedPropertyOnTypePath = (
  ctx: IRCompileContext,
  source: Set,
  fieldName: string,
): Set | undefined => {
  if (!ctx.schema) return undefined;
  const typeDef = ctx.schema.getType(source.typeref.id);
  if (!typeDef) return undefined;
  const computed = typeDef.computeds?.find(
    (candidate) => candidate.kind === "property" && candidate.name === fieldName,
  );
  if (!computed || computed.kind !== "property") return undefined;
  const expr = computed.expr;
  if (expr.kind === "literal") {
    return literalToSet(expr.value);
  }
  if (expr.kind === "set_literal") {
    return compileSetConstructor(expr.values.map((value) => literalToSet(value)), "set_literal");
  }
  if (expr.kind === "edgeql_expr") {
    // Free-form EdgeQL computed body: parse, bind the current source as the
    // subject so `.field` references inside the body resolve against the
    // current row, then lower through compileFreeObjectExpr.
    const text = expr.exprText.trim();
    const parseAttempt = tryResult(() =>
      parseEdgeQL(text.toLowerCase().startsWith("select ") ? text : `SELECT ${text}`),
    );
    if (!parseAttempt.ok) {
      return undefined;
    }
    const parsed = parseAttempt.value;
    // Guard against direct self-reference recursion (`p := .p`): if the body
    // is itself `.<fieldName>` it would loop forever.
    if (ctx.computedExprResolutionStack?.has(`${typeDef.module}::${typeDef.name}.${fieldName}`)) {
      return undefined;
    }
    if (!ctx.computedExprResolutionStack) {
      ctx.computedExprResolutionStack = new globalThis.Set<string>();
    }
    const key = `${typeDef.module}::${typeDef.name}.${fieldName}`;
    ctx.computedExprResolutionStack.add(key);
    try {
      const innerCtx = childScope(ctx);
      bindValue(innerCtx, "__current__", source);
      bindValue(innerCtx, "__subject__", source);
      if (parsed.kind === "select_expr") {
        return compileFreeObjectExpr(parsed.expr, innerCtx);
      }
      return undefined;
    } finally {
      ctx.computedExprResolutionStack.delete(key);
    }
  }
  if (expr.kind === "link_aggregate") {
    // `count(.x)` / `sum(.x.y)` — synthesise the equivalent free expression
    // and let `compileFreeObjectExpr` lower it through the normal pipeline.
    // We use the EdgeQL text and re-parse so the resulting IR is identical
    // to what an explicit user-written `count(.x)` would produce.
    const innerCtx = childScope(ctx);
    bindValue(innerCtx, "__current__", source);
    bindValue(innerCtx, "__subject__", source);
    const argText = expr.field ? `.${expr.link}.${expr.field}` : `.${expr.link}`;
    const parseAttempt = tryResult(() => parseEdgeQL(`SELECT ${expr.functionName}(${argText})`));
    if (!parseAttempt.ok) {
      return undefined;
    }
    const parsed = parseAttempt.value;
    if (parsed.kind === "select_expr") {
      return compileFreeObjectExpr(parsed.expr, innerCtx);
    }
    return undefined;
  }
  return undefined;
};

// Field names a FOR body reads off the group's elements — `g.elements.name`
// (path or field_access form), fields read through a WITH alias bound to
// `g.elements` (`WITH U := g.elements SELECT U {name, x := .cost}`), and
// leading-dot references inside such a shape. Used to augment the group
// subject's projection so the SQL stage can read the fields off each
// materialized element row.
const collectForBodyElementFields = (body: unknown, varName: string): globalThis.Set<string> => {
  const out = new globalThis.Set<string>();
  const elementAliases = new globalThis.Set<string>();
  const isElementsExpr = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false;
    const node = n as Record<string, unknown> & { kind?: string };
    if ((node.kind === "select_expr" || node.kind === "select_expr_subquery" || node.kind === "subquery_expr") && node.expr) {
      return isElementsExpr(node.expr);
    }
    if (node.kind === "path" && Array.isArray(node.steps) && node.steps.length === 2) {
      const [head, step] = node.steps as Array<{ kind?: string; name?: string }>;
      return head?.kind === "object_ref" && head.name === varName && step?.kind === "ptr" && step.name === "elements";
    }
    if (node.kind === "field_access" && node.field === "elements") {
      const src = node.expr as { kind?: string; name?: string } | undefined;
      return src?.kind === "binding_ref" && src.name === varName;
    }
    return false;
  };
  const collectLeadingDots = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(collectLeadingDots); return; }
    const node = n as Record<string, unknown> & { kind?: string; field?: string };
    if (node.kind === "field_access" && typeof node.field === "string"
        && (node.expr as { kind?: string } | undefined)?.kind === "current_item") {
      out.add(node.field);
    }
    if (node.kind === "path" && Array.isArray(node.steps)) {
      const head = (node.steps as Array<{ kind?: string; name?: string }>)[0];
      if (head?.kind === "ptr" && typeof head.name === "string") out.add(head.name);
    }
    for (const value of Object.values(node)) collectLeadingDots(value);
  };
  const collectAliasShape = (shape: unknown): void => {
    if (!Array.isArray(shape)) return;
    for (const el of shape) {
      if (el && typeof el === "object" && typeof (el as { name?: unknown }).name === "string"
          && (el as { kind?: string }).kind === "field") {
        out.add((el as { name: string }).name);
      }
    }
    collectLeadingDots(shape);
  };
  // First pass: register every WITH alias bound to `g.elements` anywhere in
  // the body — bindings can appear lexically after their uses in the AST
  // (clauses serialize after the result expression).
  const registerAliases = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(registerAliases); return; }
    const node = n as Record<string, unknown>;
    for (const wbKey of ["with", "_withBindings"]) {
      const wb = node[wbKey] ?? (node.clauses as Record<string, unknown> | undefined)?.[wbKey];
      if (Array.isArray(wb)) {
        for (const binding of wb) {
          const b = binding as { name?: unknown; value?: unknown };
          if (typeof b.name === "string" && isElementsExpr(b.value)) elementAliases.add(b.name);
        }
      }
    }
    for (const value of Object.values(node)) registerAliases(value);
  };
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const node = n as Record<string, unknown> & { kind?: string; field?: string };
    // `g.elements.X` — path or field_access form; `U.X` via an alias.
    if (node.kind === "path" && Array.isArray(node.steps)) {
      const steps = node.steps as Array<{ kind?: string; name?: string }>;
      if (steps[0]?.kind === "object_ref" && steps[0].name === varName
          && steps[1]?.kind === "ptr" && steps[1].name === "elements"
          && steps[2]?.kind === "ptr" && typeof steps[2].name === "string") {
        out.add(steps[2].name);
      }
      if (steps[0]?.kind === "object_ref" && typeof steps[0].name === "string"
          && elementAliases.has(steps[0].name)
          && steps[1]?.kind === "ptr" && typeof steps[1].name === "string") {
        out.add(steps[1].name);
      }
    }
    if (node.kind === "field_access" && typeof node.field === "string") {
      const src = node.expr as { kind?: string; name?: string } | undefined;
      if (isElementsExpr(node.expr)) out.add(node.field);
      if (src?.kind === "binding_ref" && typeof src.name === "string" && elementAliases.has(src.name)) {
        out.add(node.field);
      }
    }
    // A shape applied to an element alias: collect its plain fields and
    // leading-dot references inside its computeds.
    if (node.kind === "select" && typeof node.typeName === "string" && elementAliases.has(node.typeName)) {
      collectAliasShape(node.shape);
    }
    if (node.kind === "shape_projection") {
      const src = node.expr as { kind?: string; name?: string } | undefined;
      if (src?.kind === "binding_ref" && typeof src.name === "string" && elementAliases.has(src.name)) {
        collectAliasShape(node.shape);
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  registerAliases(body);
  walk(body);
  return out;
};

// Field names a group's subject projection already carries (shape entries,
// tuple element names — peeling select/for wrappers).
const collectGroupSubjectFieldNames = (subject: Set): globalThis.Set<string> => {
  const have = new globalThis.Set<string>();
  let cursor: Set = subject;
  for (;;) {
    for (const shapeEl of cursor.shape ?? []) {
      const elName = shapeEl.name
        ?? (shapeEl.expr.expr.kind === "pointer" ? (shapeEl.expr.expr as Pointer).ptrref.shortName : undefined);
      if (elName) have.add(elName);
    }
    if (cursor.expr.kind === "tuple") {
      for (const tupleEl of (cursor.expr as Tuple).elements) {
        if (tupleEl.name) have.add(tupleEl.name);
      }
    }
    if (cursor.expr.kind === "select_expr") {
      cursor = (cursor.expr as SelectExpr).result;
    } else if (cursor.expr.kind === "for_expr") {
      cursor = (cursor.expr as { body: Set }).body;
    } else {
      break;
    }
  }
  return have;
};

// A path step over a group-rows set (or a partial group-row path) extends
// to a group_row_field chain instead of a schema pointer — `g.elements`,
// `g.key.x`, `g.elements.name` inside `FOR g IN (GROUP …)`. Returns
// undefined when the source isn't group-rows-shaped (callers fall through
// to regular pointer resolution). peelToGroupRows is declared later in the
// file; both are only invoked at compile time, after module init.
// A shape over a group-elements set (`U {name, …}` where U := g.elements) —
// plain fields aren't schema pointers on the (anytype) base, so the generic
// compile drops them. Re-add each as a group_row_field extension the SQL
// stage reads off the element row's JSON. Mutates `compiledShape` in place.
const augmentGroupRowFieldShape = (
  base: Set,
  astShape: EdgeQLShapeElement[] | undefined,
  compiledShape: ShapeElement[],
): void => {
  if (base.expr.kind !== "group_row_field") return;
  const present = new globalThis.Set(compiledShape.map((el) => el.name).filter(Boolean));
  for (const astEl of astShape ?? []) {
    if (astEl.kind !== "field" || typeof astEl.name !== "string" || present.has(astEl.name)) continue;
    const fieldSet = tryExtendGroupRowFieldPath(base, astEl.name);
    if (!fieldSet) continue;
    compiledShape.push({
      kind: "shape_element",
      source: base,
      expr: fieldSet,
      name: astEl.name,
      shapeOp: "assign",
      shapeOrigin: "explicit",
      required: false,
      cardinality: "one",
    } as ShapeElement);
  }
};

const tryExtendGroupRowFieldPath = (out: Set, stepName: string, direction?: "outbound" | "inbound"): Set | undefined => {
  if (stepName.startsWith("@")) return undefined;
  // Backlink steps (`g.elements.<owner`) can't be read off the row JSON —
  // record them with a `<` marker so the SQL stage bails (and the runtime
  // FOR-group executor takes over) instead of silently dropping the step.
  const recorded = direction === "inbound" ? `<${stepName}` : stepName;
  // CLAUSED group selects (`(select (group …) order by … limit 1).elements`)
  // keep the full claused set as the rows source so the SQL stage applies
  // ORDER BY/LIMIT before flattening.
  const grouped = peelToGroupRows(out) ?? peelToGroupRowsThroughClauses(out);
  if (grouped) {
    return {
      ...out,
      expr: { kind: "group_row_field", steps: [recorded], rows: grouped.rows } as GroupRowFieldExpr,
      shape: [],
      pathId: defaultPathId(`group_row_field:${recorded}`),
      typeref: unknownTypeRef("std::anytype"),
    };
  }
  if (out.expr.kind === "group_row_field") {
    const inner = out.expr as GroupRowFieldExpr;
    return {
      ...out,
      expr: { ...inner, steps: [...inner.steps, recorded] } as GroupRowFieldExpr,
      pathId: defaultPathId(`group_row_field:${[...inner.steps, recorded].join(".")}`),
    };
  }
  return undefined;
};

// `.field` on a (named) tuple value (`WITH t := (a := 1, b := 2) SELECT t.a`)
// resolves to the named element's value Set. The tuple may sit behind a
// SELECT wrapper or a FOR body (`SELECT (a := …)`), so peel those first.
// resolvePointerRef has no pointer for a `std::tuple` type, so without this the
// `.field` step is dropped and the entire tuple leaks through.
// A tuple-valued union is "correlated" when it is a FOR iterator binding:
// `for X in {(2,2),(10,10)} select (X.0, X.1)` projects the SAME union twice
// and the two projections must align per iteration. Distributing `.N` over the
// union operands would de-correlate them, so such unions keep the opaque
// index_expr form (which the SQL co-iteration pass resolves correctly).
// A UDF param/result union (`x.a` in a body where `x` is bound to a multi-set
// argument, or `foo({…}).0`) carries no `for:` tag and IS safe to distribute —
// each operand is one independent call value. Recognised by the `for:<name>:`
// pathId namespace tag the for_expr stamps on its iterator binding.
const isCorrelatedTupleUnion = (source: Set): boolean =>
  (source.pathId?.namespace ?? []).some((tag) => tag.startsWith("for:"));

const resolveNamedTupleElement = (source: Set, field: string): Set | undefined => {
  if (field.startsWith("@")) return undefined;
  let cursor: Set = source;
  for (;;) {
    if (cursor.expr.kind === "select_expr") {
      cursor = (cursor.expr as SelectExpr).result;
    } else if (cursor.expr.kind === "for_expr") {
      cursor = (cursor.expr as { body: Set }).body;
    } else if (cursor.expr.kind === "function_call" && (cursor.expr as IRFunctionCall).body) {
      // `foo(…).a` where `foo` is an inlined tuple-returning UDF: the call
      // envelope wraps the substituted body Set — peel into it so the field
      // projection resolves against the body's tuple.
      cursor = (cursor.expr as IRFunctionCall).body as Set;
    } else {
      break;
    }
  }
  if (cursor.expr.kind === "tuple" && (cursor.expr as Tuple).named) {
    return (cursor.expr as Tuple).elements.find((e) => e.name === field)?.val;
  }
  // `.field` over a UNION of named tuples (`{(a:=1), (a:=2)}.a`, which arises
  // when a UDF param `x: tuple<a: int64>` is bound to a multi-set argument and
  // the body projects `x.a`): distribute the projection over each operand so
  // the union carries the element values, not whole tuples.
  if (!isCorrelatedTupleUnion(source)
      && cursor.expr.kind === "operator_call" && (cursor.expr as OperatorCall).operator === "union") {
    const op = cursor.expr as OperatorCall;
    const newArgs: Record<string, CallArg> = {};
    for (const [k, arg] of Object.entries(op.args)) {
      const projected = resolveNamedTupleElement(arg.expr, field);
      if (!projected) return undefined;
      newArgs[k] = { ...arg, expr: projected };
    }
    const first = Object.values(newArgs)[0]?.expr;
    return { ...cursor, expr: { ...op, args: newArgs }, typeref: first?.typeref ?? cursor.typeref };
  }
  return undefined;
};

// Collect the schema type-root ids a Set's value depends on. Used to decide
// whether a constant index into a literal tuple can be resolved to the element
// directly without changing cardinality (see resolveConstTupleIndexElement).
const collectSetTypeRoots = (set: Set, out: globalThis.Set<string>): void => {
  const e = set.expr;
  switch (e.kind) {
    case "type_root": out.add((e as TypeRoot).typeref.id); break;
    case "pointer": collectSetTypeRoots((e as Pointer).source, out); break;
    case "select_expr": collectSetTypeRoots((e as SelectExpr).result, out); break;
    case "for_expr": collectSetTypeRoots((e as { body: Set }).body, out); break;
    case "index_expr": collectSetTypeRoots((e as IndexExpr).expr, out); break;
    case "tuple": for (const el of (e as Tuple).elements) collectSetTypeRoots(el.val, out); break;
    case "array": for (const el of (e as ArrayExpr).elements) collectSetTypeRoots(el, out); break;
    case "coalesce_expr":
      collectSetTypeRoots((e as CoalesceExpr).left, out);
      collectSetTypeRoots((e as CoalesceExpr).right, out);
      break;
    case "type_cast": collectSetTypeRoots((e as TypeCast).expr, out); break;
    case "exists_expr": collectSetTypeRoots((e as ExistsExpr).expr, out); break;
    case "operator_call":
    case "function_call":
      for (const arg of Object.values((e as { args: Record<string, CallArg> }).args)) {
        collectSetTypeRoots(arg.expr, out);
      }
      break;
    default: break;
  }
  for (const sh of set.shape ?? []) collectSetTypeRoots(sh.expr, out);
};

// `(A, B).N` with a constant N over a literal tuple. EdgeQL builds the tuple as
// the cross product of its element sets, so `.N` generally can't be peeled to
// element N (that would drop the other elements' cardinality multiplier). It
// IS safe when every element depends on at most one common type root R and
// element N itself depends on R (so the cross product collapses to |R| and
// element N already has that cardinality), or when all elements are singletons.
// Peeling enables shared-root correlation and shape reprojection that the
// opaque index_expr form blocks (e.g. `(…, Issue).0.x ++ Issue.number`,
// `(L, L.1 {name})`).
const resolveConstTupleIndexElement = (source: Set, index: number): Set | undefined => {
  if (!Number.isInteger(index) || index < 0) return undefined;
  let cursor: Set = source;
  for (;;) {
    if (cursor.expr.kind === "select_expr") {
      const se = cursor.expr as SelectExpr;
      if (se.where || se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) return undefined;
      cursor = se.result;
    } else if (cursor.expr.kind === "function_call" && (cursor.expr as IRFunctionCall).body) {
      // `foo(…).0` where `foo` is an inlined tuple-returning UDF: peel into the
      // substituted body Set so the index resolves against the body's tuple.
      cursor = (cursor.expr as IRFunctionCall).body as Set;
    } else {
      break;
    }
  }
  // `.N` over a UNION of tuples (`{(1,), (2,)}.0`): distribute the projection
  // over each operand so the union carries element N, not whole tuples.
  if (!isCorrelatedTupleUnion(source)
      && cursor.expr.kind === "operator_call" && (cursor.expr as OperatorCall).operator === "union") {
    const op = cursor.expr as OperatorCall;
    const newArgs: Record<string, CallArg> = {};
    for (const [k, arg] of Object.entries(op.args)) {
      const projected = resolveConstTupleIndexElement(arg.expr, index);
      if (!projected) return undefined;
      newArgs[k] = { ...arg, expr: projected };
    }
    const first = Object.values(newArgs)[0]?.expr;
    return { ...cursor, expr: { ...op, args: newArgs }, typeref: first?.typeref ?? cursor.typeref };
  }
  if (cursor.expr.kind !== "tuple") return undefined;
  const elements = (cursor.expr as Tuple).elements;
  if (index >= elements.length) return undefined;
  const allRoots = new globalThis.Set<string>();
  for (const el of elements) collectSetTypeRoots(el.val, allRoots);
  if (allRoots.size > 1) return undefined;
  if (allRoots.size === 1) {
    const elemRoots = new globalThis.Set<string>();
    collectSetTypeRoots(elements[index].val, elemRoots);
    // Element N must carry the shared root, else peeling drops the multiplier.
    if (elemRoots.size === 0) return undefined;
  }
  return elements[index].val;
};

const compilePathSteps = (steps: EdgeQLPathStep[], ctx: IRCompileContext): Set => {
  if (steps.length === 0) {
    return literalToSet(null);
  }
  const first = steps[0];
  // Leading-dot paths like `.name` resolve against the surrounding subject
  // (`__current__` / `__subject__`) rather than a named object. Without this
  // they'd bail out as `null`, and the wrapping pointer would be built over
  // a string-constant source — breaking shape filters like
  // `SELECT Card {…} FILTER .name = 'Imp'`.
  if (!first || first.kind !== "object_ref") {
    const current = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
    if (!current) {
      return literalToSet(null);
    }
    let out = current;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (step.kind === "ptr") {
        const groupStepSet = tryExtendGroupRowFieldPath(out, step.name, step.direction);
        if (groupStepSet) {
          out = groupStepSet;
          continue;
        }
        const ptrref = resolvePointerRef(ctx, out.typeref, step.name);
        if (!ptrref) {
          return { ...out, pathId: defaultPathId("path_steps") };
        }
        out = extendPathSetDirectional(out, ptrref, ptrref.computedLinkAliasIsBackward ? "inbound" : (step.direction ?? "outbound"));
        if (step.optional) {
          out = { ...out, expr: { ...(out.expr as Pointer), optionalDeref: true } };
        }
        continue;
      }
      if (step.kind === "type_intersection") {
        const baseTypeId = out.typeref.id;
        const intersected = resolveTypeRef(ctx, step.typeName);
        const next = steps[i + 1];
        if (next && next.kind === "ptr") {
          validateTypeIntersectionPointer(ctx, baseTypeId, intersected.id, next.name);
        }
        out = { ...out, typeref: intersected };
        continue;
      }
      if (step.kind === "splat") continue;
    }
    return out;
  }
  if (!resolveBinding(ctx, first.name)) {
    const enumType = lookupEnumScalar(ctx, first.name);
    if (enumType) {
      const rest = steps.slice(1);
      const memberStep = rest.find((step) => step.kind === "ptr");
      if (!memberStep || memberStep.kind !== "ptr") {
        failSemantic(`enum path expression lacks an enum member name, as in '${first.name}.${enumType.members[0]}'`);
      }
      const ptrSteps = rest.filter((step) => step.kind === "ptr");
      if (ptrSteps.length > 1) {
        failSemantic(`invalid property reference on an expression of primitive type`);
      }
      return resolvePathToEnumLiteral(ctx, first.name, (memberStep as { kind: "ptr"; name: string }).name) ?? literalToSet(null);
    }
  }
  let out = resolveBinding(ctx, first.name) ?? setFromTypeRoot(resolveTypeRef(ctx, first.name));
  const rest = steps.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const step = rest[i];
    if (step.kind === "ptr") {
      // `.foo` on a primitive value — e.g. a WITH-bound enum member
      // (`WITH x := color_enum_t.RED SELECT x.GREEN`) — is invalid.
      if (out.typeref.isScalar && step.name !== "id" && step.name !== "__type__" && !step.name.startsWith("@")) {
        failSemantic(`invalid property reference on an expression of primitive type`);
      }
      // `X.__type__.name` — `__type__` has no schema pointer; synthesize the
      // pointer steps so the SQL layer's `__source_type` shortcuts fire
      // instead of falling into the unresolved-pointer fallback.
      if (step.name === "__type__") {
        out = synthesizeTypePointerSet(out);
        continue;
      }
      if (step.name === "name" && out.expr.kind === "pointer" && (out.expr as Pointer).ptrref.shortName === "__type__") {
        out = synthesizeTypeNamePointerSet(out);
        continue;
      }
      // `.field` on a named-tuple binding (`WITH t := (a := 1) SELECT t.a`).
      const tupleElement = resolveNamedTupleElement(out, step.name);
      if (tupleElement) {
        out = tupleElement;
        continue;
      }
      // Paths off a group-rows set (`g.elements`, `g.key.x` where g is a FOR
      // iteration over a GROUP) aren't schema pointers — model them as
      // group_row_field steps the SQL stage resolves against the row JSON.
      const groupStepSet = tryExtendGroupRowFieldPath(out, step.name, step.direction);
      if (groupStepSet) {
        out = groupStepSet;
        continue;
      }
      let ptrref = resolvePointerRef(ctx, out.typeref, step.name);
      // A type intersection can narrow to a SUPERTYPE (`Issue[IS Named]`):
      // the rows are still the original type's, so a pointer the narrowed
      // view lacks resolves against the underlying root type.
      if (!ptrref && out.expr.kind === "type_root"
          && (out.expr as TypeRoot).typeref.id !== out.typeref.id) {
        ptrref = resolvePointerRef(ctx, (out.expr as TypeRoot).typeref, step.name);
      }
      if (!ptrref) {
        // No backing column / link / backlink — but the source type may
        // expose `step.name` as a computed property (`property p := <expr>`).
        // Lower the computed body in place so the SQL pipeline sees the
        // substituted expression instead of an unresolved pointer.
        const computedSet = tryLowerComputedPropertyOnTypePath(ctx, out, step.name);
        if (computedSet) {
          out = computedSet;
          continue;
        }
        return { ...out, pathId: defaultPathId("path_steps") };
      }
      out = extendPathSetDirectional(
        out,
        ptrref,
        ptrref.computedLinkAliasIsBackward ? "inbound" : (step.direction ?? "outbound"),
      );
      if (step.optional) {
        out = {
          ...out,
          expr: {
            ...(out.expr as Pointer),
            optionalDeref: true,
          },
        };
      }
      continue;
    }
    if (step.kind === "type_intersection") {
      const baseTypeId = out.typeref.id;
      const intersected = resolveTypeRef(ctx, step.typeName);
      const next = rest[i + 1];
      if (next && next.kind === "ptr") {
        validateTypeIntersectionPointer(ctx, baseTypeId, intersected.id, next.name);
      }
      out = {
        ...out,
        typeref: intersected,
      };
      continue;
    }
    if (step.kind === "splat") {
      continue;
    }
  }
  return out;
};

const childScope = (ctx: IRCompileContext): IRCompileContext => ({
  ...ctx,
  bindingScopes: [...ctx.bindingScopes, new Map<string, Set>()],
});

const bindValue = (ctx: IRCompileContext, name: string, value: Set): void => {
  const current = ctx.bindingScopes[ctx.bindingScopes.length - 1];
  if (!current) {
    return;
  }
  current.set(name, value);
};

const resolveBinding = (ctx: IRCompileContext, name: string): Set | undefined => {
  for (let index = ctx.bindingScopes.length - 1; index >= 0; index -= 1) {
    const scope = ctx.bindingScopes[index];
    const value = scope?.get(name);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const withBindings = (ctx: IRCompileContext, bindings: WithBinding[] | undefined): IRCompileContext => {
  if (!bindings?.length) {
    return ctx;
  }
  const scoped = childScope(ctx);
  for (const binding of bindings) {
    let set: Set;
    switch (binding.value.kind) {
      case "literal":
        set = literalToSet(binding.value.value);
        break;
      case "set_literal": {
        // Inspect the literal values to give the binding the right typeref —
        // `WITH A := {1.0, 2.0}` should resolve to float64 on
        // `INTROSPECT TYPEOF A`, not the length placeholder we used to bind.
        const values = binding.value.values;
        const inferred = inferAstExprTypeName(
          { kind: "set_literal", values } as FreeObjectExpr,
          scoped,
        );
        const placeholder = values.length > 0 ? (values[0] as ScalarValue) : null;
        set = literalToSet(placeholder);
        if (inferred) {
          set = { ...set, typeref: unknownTypeRef(inferred) };
        }
        break;
      }
      case "array_literal":
        // Bind the real array IR — a length placeholder would make
        // `x[0]` / `SELECT x` read the count instead of the elements.
        set = compileFreeObjectExpr(
          {
            kind: "array_literal_expr",
            values: binding.value.values.map((value) => ({ kind: "literal", value })),
          } as unknown as FreeObjectExpr,
          scoped,
        );
        break;
      case "parameter":
        set = compileFreeObjectExpr({ kind: "parameter", name: binding.value.name, castType: binding.value.castType }, scoped);
        break;
      case "binding_ref":
        set = resolveBinding(scoped, binding.value.name) ?? compileFreeObjectExpr({ kind: "binding_ref", name: binding.value.name }, scoped);
        break;
      case "path":
        set = compileFreeObjectExpr({ kind: "path", head: binding.value.head, tail: binding.value.tail }, scoped);
        break;
      case "path_chain":
        set = compileFreeObjectExpr({ kind: "path_chain", parts: binding.value.parts }, scoped);
        break;
      case "enum_path":
        set = literalToSet(binding.value.member);
        break;
      case "subquery":
        set = setFromTypeRoot(resolveTypeRef(scoped, binding.value.query.typeName));
        break;
      case "subquery_expr":
        set = compileFreeObjectExpr(binding.value.expr, scoped);
        break;
      case "backlink_path":
        set = setFromTypeRoot(resolveTypeRef(scoped, binding.value.head));
        break;
      default:
        set = literalToSet(null);
        break;
    }
    // WITH bindings are DETACHED from the enclosing query's path scope —
    // mark subquery-valued ones so the SQL layer suppresses outer-scope
    // capture of their internals (an inline `EXISTS (SELECT Issue …)` is
    // IR-identical otherwise but SHARES the outer path prefix).
    if (set.expr.kind === "select_expr") {
      set = { ...set, isWithBinding: true } as Set;
    }
    // Tag object identity aliases so a later bare reference to the same type
    // is distinguishable from the WITH binding in SQL outer-scope matching.
    if (
      !set.typeref.isScalar
      && set.expr.kind === "type_root"
      && set.pathId
    ) {
      const ns = `with:${binding.name}:${ctx.nextScopeId++}`;
      set = {
        ...set,
        pathId: {
          ...set.pathId,
          namespace: [...(set.pathId.namespace ?? []), ns],
        },
      };
    }
    bindValue(scoped, binding.name, set);
  }
  return scoped;
};

const literalToSet = (value: string | number | boolean | null): Set => ({
  kind: "set",
  expr: {
    kind:
      typeof value === "string"
        ? "string_constant"
        : typeof value === "boolean"
          ? "boolean_constant"
          : typeof value === "number"
            ? Number.isInteger(value)
              ? "integer_constant"
              : "float_constant"
            : "string_constant",
    value,
  } as BaseConstant,
  pathId: defaultPathId("std::anyscalar"),
  typeref: unknownTypeRef("std::anyscalar"),
  shape: [],
  isBinding: false,
  isMaterializedRef: false,
  isSchemaAlias: false,
});

const compileSetConstructor = (values: Set[], label: string): Set => {
  if (values.length === 0) {
    return literalToSet(null);
  }
  if (values.length === 1) {
    return values[0];
  }
  const first = values[0];
  // A union of distinct concrete object types (`{CBaBb, CBbBc}`) spans more
  // than one type, so its element type is the `A | B` union — not the first
  // branch's type. Reflect that in the typeref so `.__type__.name` reads the
  // dynamic `__source_type` discriminator (the `includes("|")` path) instead of
  // baking in the first branch's static name, and so polymorphic pointer
  // resolution probes every branch. Scalars and same-typed branches keep
  // `first.typeref`.
  const objectIds = values
    .map((value) => value.typeref)
    .filter((ref) => ref && !ref.isScalar && !ref.id.startsWith("unknown:"))
    .map((ref) => ref.id);
  const distinctObjectIds = [...new globalThis.Set(objectIds)];
  const allObjects = objectIds.length === values.length;
  const typeref = allObjects && distinctObjectIds.length > 1
    ? ({ ...first.typeref, id: distinctObjectIds.join(" | "), isAbstract: false } as TypeRef)
    : first.typeref;
  return {
    kind: "set",
    expr: {
      kind: "operator_call",
      operator: "union",
      args: Object.fromEntries(values.map((value, index) => [String(index), mkCallArg(value)])),
      returning: typeref,
      volatility: "immutable",
    } as OperatorCall,
    pathId: defaultPathId(label),
    typeref,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

const failSemantic = (message: string): never => {
  throw new AppError("E_SEMANTIC", message, 1, 1);
};

// EdgeQL forbids unioning two object types when a same-named pointer resolves
// to incompatible types across the branches (`SELECT Dummy1 union Dummy2`
// where both declare `foo` with different types). Surface the exact upstream
// error so these stay validation failures rather than producing a bogus row
// set ("no such column").
const validateUnionPointerCompat = (left: Set, right: Set, ctx: IRCompileContext): void => {
  const lId = left.typeref?.id;
  const rId = right.typeref?.id;
  if (!lId || !rId || lId.startsWith("unknown:") || rId.startsWith("unknown:")) return;
  if (left.typeref?.isScalar || right.typeref?.isScalar) return;
  const lDef = getSchemaType(ctx, lId);
  const rDef = getSchemaType(ctx, rId);
  if (!lDef || !rDef) return;
  const unionName = `(${lId} | ${rId})`;
  const fieldStdName = (f: FieldDef): string => f.enumTypeName ?? scalarToStdName(f.type);
  const qLink = (l: LinkDef): string => qualifyTypeName(l.targetType, ctx.module);
  const lProps = new Map((lDef.fields ?? []).filter((f) => !f.isLinkColumn).map((f) => [f.name, f] as const));
  const rProps = new Map((rDef.fields ?? []).filter((f) => !f.isLinkColumn).map((f) => [f.name, f] as const));
  const lLinks = new Map((lDef.links ?? []).map((l) => [l.name, l] as const));
  const rLinks = new Map((rDef.links ?? []).map((l) => [l.name, l] as const));
  const names = new globalThis.Set<string>([...lProps.keys(), ...rProps.keys(), ...lLinks.keys(), ...rLinks.keys()]);
  for (const name of names) {
    if (name === "id" || name === "__type__") continue;
    const lp = lProps.get(name);
    const rp = rProps.get(name);
    const ll = lLinks.get(name);
    const rl = rLinks.get(name);
    if (lp && rp) {
      const lt = fieldStdName(lp);
      const rt = fieldStdName(rp);
      if (lt !== rt) {
        failSemantic(`cannot create union ${unionName} with property '${name}' using incompatible types ${lt}, ${rt}`);
      }
    } else if (ll && rl) {
      const lt = qLink(ll);
      const rt = qLink(rl);
      if (lt !== rt) {
        failSemantic(`cannot create union ${unionName} with link '${name}' using incompatible types ${lt}, ${rt}`);
      }
      const lProp = new Map((ll.properties ?? []).map((p) => [p.name, p] as const));
      for (const rprop of rl.properties ?? []) {
        const lprop = lProp.get(rprop.name);
        if (lprop) {
          const a = scalarToStdName(lprop.type);
          const b = scalarToStdName(rprop.type);
          if (a !== b) {
            failSemantic(`cannot create union ${unionName} with link '${name}' with property '${rprop.name}' using incompatible types ${a}, ${b}`);
          }
        }
      }
    } else if (ll && rp) {
      failSemantic(`cannot create union ${unionName} with link '${name}' using incompatible types ${qLink(ll)}, ${fieldStdName(rp)}`);
    } else if (lp && rl) {
      failSemantic(`cannot create union ${unionName} with link '${name}' using incompatible types ${qLink(rl)}, ${fieldStdName(lp)}`);
    }
  }
};

const enumValuesOfTypeDef = (typeDef: TypeDef | undefined): string[] | undefined => {
  if (!typeDef) return undefined;
  const first = typeDef.fields[0];
  if (typeDef.fields.length === 1 && first?.name === "__enum__" && first.enumValues && first.enumValues.length > 0) {
    return first.enumValues;
  }
  return undefined;
};

const lookupEnumScalar = (ctx: IRCompileContext, name: string): { qualifiedName: string; members: string[] } | undefined => {
  const typeDef = getSchemaType(ctx, name);
  const members = enumValuesOfTypeDef(typeDef);
  if (!typeDef || !members) return undefined;
  return { qualifiedName: qualifiedTypeName(typeDef), members };
};

const enumLiteralSet = (member: string): Set => literalToSet(member);

const resolvePathToEnumLiteral = (ctx: IRCompileContext, head: string, tail: string | undefined): Set | undefined => {
  const enumType = lookupEnumScalar(ctx, head);
  if (!enumType) return undefined;
  if (tail === undefined) {
    return failSemantic(`enum path expression lacks an enum member name, as in '${head}.${enumType.members[0]}'`);
  }
  if (!enumType.members.includes(tail)) {
    // Matches upstream Gel's phrasing ("enum has no member called 'X'");
    // the type name lives in the path, not the message.
    failSemantic(`enum has no member called '${tail}'`);
  }
  // Tag the member literal with its (scalar) enum type so downstream
  // primitive-reference checks fire on `color_enum_t.RED.GREEN` etc. without
  // having to special-case bare string constants everywhere.
  const literal = enumLiteralSet(tail);
  return { ...literal, typeref: { ...unknownTypeRef(enumType.qualifiedName), isScalar: true } };
};

const jsonEncodeString = (value: string): string => JSON.stringify(JSON.stringify(value));

const tryExtractStringConstant = (set: Set): string | undefined => {
  const expr = set.expr as { kind: string; value?: unknown };
  if (expr.kind === "string_constant" && typeof expr.value === "string") {
    return expr.value;
  }
  return undefined;
};

const tryExtractAnyConstant = (set: Set): { value: unknown; kind: string } | undefined => {
  const expr = set.expr as { kind: string; value?: unknown };
  if (expr.kind.endsWith("_constant")) {
    return { value: expr.value, kind: expr.kind };
  }
  return undefined;
};

const jsonTypeNameForLiteral = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  return "object";
};

const tryExtractSetOfStringConstants = (set: Set): string[] | undefined => {
  const direct = tryExtractStringConstant(set);
  if (direct !== undefined) return [direct];
  const expr = set.expr as { kind: string; operator?: string; args?: Record<string, { expr: Set }> };
  if (expr.kind === "operator_call" && expr.operator === "union" && expr.args) {
    const values: string[] = [];
    for (const key of Object.keys(expr.args).sort((a, b) => Number(a) - Number(b))) {
      const inner = tryExtractStringConstant(expr.args[key].expr);
      if (inner === undefined) return undefined;
      values.push(inner);
    }
    return values;
  }
  return undefined;
};

const compileEnumCast = (
  ctx: IRCompileContext,
  enumQualifiedName: string,
  enumMembers: string[],
  inner: Set,
): Set => {
  // Validate any literal members up-front so bad input still fails at
  // compile time, but always wrap the inner in a `type_cast` to the enum
  // target so downstream consumers (especially ORDER BY) can recover the
  // enum target type and emit enum-aware SQL (mapping each member to its
  // declared index for sorting).
  const stringValues = tryExtractSetOfStringConstants(inner);
  if (stringValues !== undefined) {
    for (const value of stringValues) {
      if (!enumMembers.includes(value)) {
        failSemantic(`invalid input value for enum '${enumQualifiedName}': "${value}"`);
      }
    }
  }
  const toType = resolveTypeRef(ctx, enumQualifiedName);
  return {
    kind: "set",
    expr: {
      kind: "type_cast",
      fromType: inner.typeref,
      toType,
      expr: inner,
    },
    pathId: defaultPathId(`cast:${enumQualifiedName}`),
    typeref: toType,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

const BUILTIN_SCALAR_NAMES: Record<string, string> = {
  str: "std::str",
  int: "std::int64",
  int16: "std::int16",
  int32: "std::int32",
  int64: "std::int64",
  float: "std::float64",
  float32: "std::float32",
  float64: "std::float64",
  bool: "std::bool",
  json: "std::json",
  datetime: "std::datetime",
  duration: "std::duration",
  uuid: "std::uuid",
  decimal: "std::decimal",
  bigint: "std::bigint",
  bytes: "std::bytes",
};

const normalizeScalarCastName = (ctx: IRCompileContext, name: string): string => {
  // Parametric collection casts (`tuple<str, str>`, `array<int64>`) must be
  // normalized through the structured TypeRef so element scalars are fully
  // qualified (`tuple<std::str, std::str>`). Naively prepending the active
  // module yields a bogus `default::tuple<str, str>` that mismatches the
  // canonical `std::*`-qualified form used elsewhere (type-compat checks etc).
  {
    const trimmed = name.trim();
    const open = trimmed.indexOf("<");
    if (open > 0 && trimmed.endsWith(">")) {
      const head = trimmed.slice(0, open).trim();
      const bare = head.includes("::") ? (head.split("::").pop() ?? head) : head;
      if (bare === "tuple") {
        const tupleRef = parseTupleStructuredTypeRef(ctx, name);
        if (tupleRef) return tupleRef.id;
      }
    }
  }
  if (name.includes("::")) {
    // `cal::*` casts (`<cal::local_date>...`) keep their short form coming out
    // of the parser; promote them to fully-qualified `std::cal::*` so
    // downstream comparators (type compatibility checks, error messages,
    // overlay metadata) see the same canonical name as the rest of the code.
    if (name.startsWith("cal::")) return `std::${name}`;
    return name;
  }
  if (BUILTIN_SCALAR_NAMES[name]) return BUILTIN_SCALAR_NAMES[name];
  const typeDef = getSchemaType(ctx, name);
  if (typeDef) return qualifiedTypeName(typeDef);
  return `${ctx.module}::${name}`;
};

const inferPropertyTypeName = (ctx: IRCompileContext, typeName: string, fieldName: string): string | undefined => {
  const typeDef = getSchemaType(ctx, typeName);
  if (!typeDef) return undefined;
  const field = typeDef.fields.find((f) => f.name === fieldName);
  if (!field) return undefined;
  if (field.enumTypeName) return field.enumTypeName;
  // Collection-typed properties (`array<str>`, tuples) store their values as
  // JSON, so `field.type` is the *storage* scalar ("json"), not the logical
  // element type. Reporting std::json here makes `.tag_array = ['a']` fail
  // the '=' compatibility check with a false mismatch — bail instead; callers
  // treat undefined as "uninferable" and skip the check.
  if (field.collection) return undefined;
  return BUILTIN_SCALAR_NAMES[field.type] ?? `std::${field.type}`;
};

const inferAstExprTypeName = (expr: FreeObjectExpr, ctx: IRCompileContext): string | undefined => {
  switch (expr.kind) {
    case "literal":
      if (typeof expr.value === "string") return "std::str";
      if (typeof expr.value === "boolean") return "std::bool";
      if (typeof expr.value === "number") {
        // Parser stamps a numericKind hint so `1` (int) is distinguishable
        // from `1.0` (float) — `Number.isInteger(1.0)` is true, so we'd
        // otherwise mis-classify floats whose fractional part is zero.
        const kind = (expr as { numericKind?: "integer" | "float" | "bigint" | "decimal" }).numericKind;
        if (kind === "float") return "std::float64";
        if (kind === "bigint") return "std::bigint";
        if (kind === "decimal") return "std::decimal";
        if (kind === "integer") return "std::int64";
        return Number.isInteger(expr.value) ? "std::int64" : "std::float64";
      }
      return undefined;
    case "cast":
      return normalizeScalarCastName(ctx, expr.castType);
    case "enum_path":
      return normalizeScalarCastName(ctx, expr.enumType);
    case "path": {
      const enumType = lookupEnumScalar(ctx, expr.head);
      if (enumType) return enumType.qualifiedName;
      return inferPropertyTypeName(ctx, expr.head, expr.tail);
    }
    case "path_chain": {
      const parts = expr.parts;
      if (parts.length < 1) return undefined;
      const enumType = lookupEnumScalar(ctx, parts[0]);
      if (enumType) return enumType.qualifiedName;
      if (parts.length === 2) return inferPropertyTypeName(ctx, parts[0], parts[1]);
      return undefined;
    }
    case "path_steps": {
      const first = expr.steps[0];
      if (!first || first.kind !== "object_ref") return undefined;
      const enumType = lookupEnumScalar(ctx, first.name);
      if (enumType) return enumType.qualifiedName;
      const ptrSteps = expr.steps.slice(1).filter((step) => step.kind === "ptr");
      if (ptrSteps.length === 1) {
        return inferPropertyTypeName(ctx, first.name, (ptrSteps[0] as { kind: "ptr"; name: string }).name);
      }
      return undefined;
    }
    case "field_access": {
      // `Issue.time_estimate` parses as field_access over a `select Issue`
      // head; resolve the head's type name and look the property up on it.
      const inner = expr as unknown as { expr: FreeObjectExpr; field: string };
      const sourceType = inferAstExprTypeName(inner.expr, ctx);
      if (sourceType === undefined) return undefined;
      return inferPropertyTypeName(ctx, sourceType, inner.field);
    }
    case "current_item": {
      // `.x` inside a shape computed: the subject's bound Set carries the
      // object type the leading dot refers to.
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      const name = subject?.typeref?.nameHint;
      return name !== undefined && name !== "std::anyscalar" ? name : undefined;
    }
    case "binding_ref": {
      const enumType = lookupEnumScalar(ctx, expr.name);
      if (enumType) return enumType.qualifiedName;
      // `INTROSPECT std::float64` parses the type name as a binding_ref;
      // recognise the std/cal/schema qualified names so the introspect_typeof
      // case can emit the type itself.
      if (expr.name.includes("::")) return expr.name;
      return undefined;
    }
    case "select_expr_subquery": {
      // A parenthesised subquery (`(SELECT User …)`) carries the same element
      // type as its inner statement, so element-type inference (e.g. for the
      // single-element array inside `array_unpack([(SELECT User …)])`) sees
      // the object type rather than std::anytype.
      return inferAstExprTypeName((expr as { expr: FreeObjectExpr }).expr, ctx);
    }
    case "select": {
      // `INTROSPECT TYPEOF Card` / `INTROSPECT TYPEOF schema::ObjectType`
      // — the parser turns the type name into a `select` statement with
      // an implicit `{id}` shape. Surface the type name back so the outer
      // introspect_typeof case can carry it as the inferred type.
      return (expr as { typeName?: string }).typeName;
    }
    case "tuple": {
      // Best-effort: name the tuple by its element types so cross-type
      // comparisons (`(1,2) = [1,2]`) can be rejected. If any element is
      // un-inferable, fall back to a generic `tuple<>` so the type-category
      // bucket still matches.
      const inner = (expr as { values: FreeObjectExpr[] }).values
        .map((v) => inferAstExprTypeName(v, ctx) ?? "anytype");
      return `tuple<${inner.join(", ")}>`;
    }
    case "array_literal_expr": {
      const values = (expr as { values: FreeObjectExpr[] }).values;
      if (values.length === 0) return "array<anytype>";
      const elemType = inferAstExprTypeName(values[0], ctx) ?? "anytype";
      return `array<${elemType}>`;
    }
    case "set_expr": {
      // Set elements promote up the numeric hierarchy when mixed:
      // `{1, <float32>2.1}` is float64, `{1, <decimal>2.1}` is decimal.
      const values = (expr as { values: FreeObjectExpr[] }).values;
      if (values.length === 0) return undefined;
      let acc: string | undefined;
      for (const value of values) {
        const t = inferAstExprTypeName(value, ctx);
        if (!t) continue;
        if (!acc) { acc = t; continue; }
        // Re-use the math promotion rules for set element promotion.
        const promoted = inferAstExprTypeName(
          { kind: "math", op: "add", left: { kind: "literal", value: 0 }, right: { kind: "literal", value: 0 } } as unknown as FreeObjectExpr,
          ctx,
        );
        // Direct path: emulate INT_RANK / FLOAT_RANK promotion here.
        const INT_RANK: Record<string, number> = {
          "std::int16": 1, "std::int32": 2, "std::int64": 3, "std::bigint": 4,
        };
        const FLOAT_RANK: Record<string, number> = {
          "std::float32": 1, "std::float64": 2, "std::decimal": 3,
        };
        const aInt = INT_RANK[acc];
        const bInt = INT_RANK[t];
        const aFloat = FLOAT_RANK[acc];
        const bFloat = FLOAT_RANK[t];
        if (aInt !== undefined && bInt !== undefined) {
          acc = aInt >= bInt ? acc : t;
        } else if (aFloat !== undefined && bFloat !== undefined) {
          acc = aFloat >= bFloat ? acc : t;
        } else if ((aInt !== undefined && bFloat !== undefined) || (aFloat !== undefined && bInt !== undefined)) {
          const floatType = aFloat !== undefined ? acc : t;
          const intType = aInt !== undefined ? acc : t;
          if (floatType === "std::decimal") acc = "std::decimal";
          else if (floatType === "std::float64") acc = "std::float64";
          else acc = intType === "std::int16" ? "std::float32" : "std::float64";
        }
        void promoted;
      }
      return acc;
    }
    case "set_literal": {
      const values = (expr as { values: ScalarValue[] }).values;
      if (values.length === 0) return undefined;
      // Promote across all elements: `{1, 2.1}` is float64, not int64.
      let anyFloat = false;
      let anyString = false;
      let anyBool = false;
      for (const v of values) {
        if (typeof v === "string") anyString = true;
        else if (typeof v === "boolean") anyBool = true;
        else if (typeof v === "number" && !Number.isInteger(v)) anyFloat = true;
      }
      if (anyString) return "std::str";
      if (anyBool) return "std::bool";
      if (anyFloat) return "std::float64";
      const v = values[0];
      if (typeof v === "number") return "std::int64";
      return undefined;
    }
    case "unary": {
      // `-X` / `+X` preserve `X`'s inferred type. `NOT bool` returns bool.
      const inner = inferAstExprTypeName((expr as { expr: FreeObjectExpr }).expr, ctx);
      const op = (expr as { op: string }).op;
      if (op === "not") return "std::bool";
      return inner;
    }
    case "exists":
    case "compare":
    case "logical":
    case "in_expr": {
      return "std::bool";
    }
    case "if_else": {
      const thenType = inferAstExprTypeName((expr as { thenExpr: FreeObjectExpr }).thenExpr, ctx);
      const elseType = inferAstExprTypeName((expr as { elseExpr: FreeObjectExpr }).elseExpr, ctx);
      return thenType ?? elseType;
    }
    case "concat": {
      // String concat returns str; array concat returns the array type.
      const parts = (expr as { parts: FreeObjectExpr[] }).parts;
      for (const part of parts) {
        const t = inferAstExprTypeName(part, ctx);
        if (t?.startsWith("array<")) return t;
      }
      return "std::str";
    }
    case "for_expr": {
      // `User.<owner` parses as `FOR x IN User UNION (<owner backlink>)`.
      // The body's backlink_path with no sourceType resolves to the universal
      // `std::BaseObject`; with a sourceType the target is that type.
      const body = (expr as { body: FreeObjectExpr }).body;
      if (body.kind === "backlink_path") {
        const sourceType = (body as { sourceType?: string }).sourceType;
        return sourceType ?? "std::BaseObject";
      }
      return inferAstExprTypeName(body, ctx);
    }
    case "math": {
      // Numeric promotion for `a + b`, `a - b`, etc. — matches EdgeQL's
      // implicit-cast hierarchy. Mixed int/float promotes to float64 unless
      // the int fits in float32 (only int16 does), in which case float32
      // wins. Pure-int and pure-float ladders use widest-wins.
      const INT_RANK: Record<string, number> = {
        "std::int16": 1, "std::int32": 2, "std::int64": 3, "std::bigint": 4,
      };
      const FLOAT_RANK: Record<string, number> = {
        "std::float32": 1, "std::float64": 2, "std::decimal": 3,
      };
      const leftType = inferAstExprTypeName((expr as { left: FreeObjectExpr }).left, ctx);
      const rightType = inferAstExprTypeName((expr as { right: FreeObjectExpr }).right, ctx);
      const op = (expr as { op: string }).op;
      const promote = (a: string | undefined, b: string | undefined): string | undefined => {
        if (!a) return b;
        if (!b) return a;
        const aInt = INT_RANK[a]; const bInt = INT_RANK[b];
        const aFloat = FLOAT_RANK[a]; const bFloat = FLOAT_RANK[b];
        if (aInt !== undefined && bInt !== undefined) return aInt >= bInt ? a : b;
        if (aFloat !== undefined && bFloat !== undefined) return aFloat >= bFloat ? a : b;
        const intType = aInt !== undefined ? a : b;
        const floatType = aFloat !== undefined ? a : b;
        if (floatType === "std::decimal") return "std::decimal";
        if (floatType === "std::float64") return "std::float64";
        return intType === "std::int16" ? "std::float32" : "std::float64";
      };
      // `/` (true division) always returns a float — `3 / 2` is float64,
      // `<decimal>3 / 2` is decimal. Promote integer operands to float64.
      if (op === "/" || op === "div") {
        const promoted = promote(leftType, rightType);
        if (promoted && INT_RANK[promoted] !== undefined) return "std::float64";
        return promoted;
      }
      return promote(leftType, rightType);
    }
    case "coalesce": {
      // `A ?? B` adopts the wider operand type — `(int) ?? <float64>{}`
      // resolves to float64, etc. Falls through to math-like promotion.
      const leftT = inferAstExprTypeName((expr as { left: FreeObjectExpr }).left, ctx);
      const rightT = inferAstExprTypeName((expr as { right: FreeObjectExpr }).right, ctx);
      if (!leftT) return rightT;
      if (!rightT) return leftT;
      const INT_RANK: Record<string, number> = {
        "std::int16": 1, "std::int32": 2, "std::int64": 3, "std::bigint": 4,
      };
      const FLOAT_RANK: Record<string, number> = {
        "std::float32": 1, "std::float64": 2, "std::decimal": 3,
      };
      const aInt = INT_RANK[leftT];
      const bInt = INT_RANK[rightT];
      const aFloat = FLOAT_RANK[leftT];
      const bFloat = FLOAT_RANK[rightT];
      if (aInt !== undefined && bInt !== undefined) return aInt >= bInt ? leftT : rightT;
      if (aFloat !== undefined && bFloat !== undefined) return aFloat >= bFloat ? leftT : rightT;
      if ((aInt !== undefined && bFloat !== undefined) || (aFloat !== undefined && bInt !== undefined)) {
        const floatType = aFloat !== undefined ? leftT : rightT;
        return floatType;
      }
      return leftT;
    }
    case "function_call": {
      // Best-effort inference for aggregates/scalar functions used by
      // INTROSPECT TYPEOF / IS checks. We only need to cover stdlib calls
      // whose return type is a deterministic function of their argument
      // types; anything else falls back to undefined and downstream code
      // treats it as std::anytype.
      const fnName = expr.call.name;
      const shortName = fnName.includes("::") ? fnName.slice(fnName.lastIndexOf("::") + 2) : fnName;
      const argTypes = expr.call.args.map((arg): string | undefined => {
        const a = arg as { kind?: string; expr?: FreeObjectExpr; arg?: { expr?: FreeObjectExpr } };
        if (a.kind === "expr" && a.expr) return inferAstExprTypeName(a.expr, ctx);
        if (a.kind === "named_arg" && a.arg?.expr) return inferAstExprTypeName(a.arg.expr, ctx);
        if ((arg as FreeObjectExpr).kind) return inferAstExprTypeName(arg as FreeObjectExpr, ctx);
        return undefined;
      });
      const first = argTypes[0];
      // `sum(int...)` returns int64; `sum(float...)` returns float64 (etc.).
      // EdgeQL promotes the numeric category to its widest representative.
      const isAnyNumericFloat = argTypes.some((t) => t === "std::float32" || t === "std::float64");
      const isAnyDecimal = argTypes.some((t) => t === "std::decimal");
      const isAnyBigint = argTypes.some((t) => t === "std::bigint");
      const isAllInt = argTypes.every((t) => t === "std::int16" || t === "std::int32" || t === "std::int64");
      if (shortName === "sum") {
        if (isAnyDecimal) return "std::decimal";
        if (isAnyNumericFloat) return "std::float64";
        if (isAnyBigint) return "std::bigint";
        if (isAllInt && argTypes.length > 0) return "std::int64";
      }
      if (shortName === "mean" || shortName === "stddev" || shortName === "stddev_pop"
        || shortName === "var" || shortName === "var_pop") {
        if (isAnyDecimal) return "std::decimal";
        return "std::float64";
      }
      if (shortName === "min" || shortName === "max") return first;
      if (shortName === "count") return "std::int64";
      if (shortName === "len") return "std::int64";
      if (shortName === "to_str" || shortName === "str_lower" || shortName === "str_upper"
        || shortName === "str_trim" || shortName === "str_pad_start" || shortName === "str_pad_end"
        || shortName === "str_repeat" || shortName === "str_split" || shortName === "re_replace") {
        return "std::str";
      }
      if (shortName === "round") return first ?? "std::float64";
      if (shortName === "ceil" || shortName === "floor") {
        // EdgeQL `math::ceil` / `math::floor` return int64 for any integer
        // input and the matching float / decimal otherwise.
        const integers = new Set(["std::int16", "std::int32", "std::int64", "std::bigint"]);
        if (first && integers.has(first)) return "std::int64";
        if (first === "std::decimal") return "std::decimal";
        return first ?? "std::float64";
      }
      if (shortName === "abs") return first;
      // Cardinality/identity assertions pass their argument's type through
      // unchanged, so a shape applied to `assert_single(SELECT User …)`
      // resolves against User rather than std::anytype.
      if (shortName === "assert_single" || shortName === "assert_exists"
        || shortName === "assert_distinct") {
        return first;
      }
      if (shortName === "random") return "std::float64";
      if (shortName === "to_json") return "std::json";
      if (shortName === "array_get" || shortName === "array_unpack") {
        // Element-type extraction: `array<T>` → `T`. The parser already
        // canonicalises array type names to that exact form, so a prefix /
        // suffix match is sufficient and avoids a regex. Cast-derived names
        // may arrive module-qualified (`default::array<Issue>`) — strip the
        // prefix before matching.
        if (!first) return undefined;
        // Strip only a module prefix BEFORE the generic bracket
        // (`default::array<Issue>` → `array<Issue>`), never a `::` inside
        // the type args (`array<std::tuple>` must stay intact).
        const ltIdx = first.indexOf("<");
        const modIdx = first.indexOf("::");
        const bareFirst = modIdx >= 0 && (ltIdx < 0 || modIdx < ltIdx)
          ? first.slice(modIdx + 2)
          : first;
        if (bareFirst.startsWith("array<") && bareFirst.endsWith(">")) {
          return bareFirst.slice("array<".length, -1);
        }
        return undefined;
      }
      if (shortName === "array_agg") return first ? `array<${first}>` : undefined;
      // `re_match(pattern, str)` / `re_match_all(pattern, str)` return an
      // array of capture-group strings per match. Mark them as `array<str>`
      // so downstream code knows the projection produces a JSON-shaped
      // value (the cross-product over multi-scalar args relies on this to
      // emit the right `json_group_array(json(...))` wrapping).
      if (shortName === "re_match" || shortName === "re_match_all") return "array<std::str>";
      return undefined;
    }
    default:
      return undefined;
  }
};

// Type-category helpers used by binary/unary operator validation. We keep the
// taxonomy aligned with EdgeQL's std types: numeric scalars share arithmetic,
// strings/bytes have their own set of operations, and temporals form another
// island. Returns one of "numeric", "str", "bytes", "bool", "uuid", "json",
// "datetime", "duration", "array", "tuple", or "other" if no specific bucket
// applies.
const typeCategory = (typeName: string | undefined): string => {
  if (!typeName) return "other";
  const NUMERIC = new Set([
    "std::int16", "std::int32", "std::int64",
    "std::float32", "std::float64",
    "std::bigint", "std::decimal",
  ]);
  if (NUMERIC.has(typeName)) return "numeric";
  if (typeName === "std::str") return "str";
  if (typeName === "std::bytes") return "bytes";
  if (typeName === "std::bool") return "bool";
  if (typeName === "std::uuid") return "uuid";
  if (typeName === "std::json") return "json";
  if (typeName === "std::datetime"
    || typeName === "std::cal::local_datetime"
    || typeName === "std::cal::local_date"
    || typeName === "std::cal::local_time"
  ) return "datetime";
  if (typeName === "std::duration"
    || typeName === "std::cal::relative_duration"
    || typeName === "std::cal::date_duration"
  ) return "duration";
  if (typeName.startsWith("array<") || typeName === "std::array") return "array";
  if (typeName.startsWith("tuple<") || typeName === "std::tuple") return "tuple";
  return "other";
};

const canApplyUnaryArith = (typeName: string): boolean => {
  const c = typeCategory(typeName);
  return c === "numeric" || c === "duration";
};

const NUMERIC_FLOAT_FAMILY = new Set(["std::float32", "std::float64"]);
const NUMERIC_ARBITRARY_PRECISION = new Set(["std::bigint", "std::decimal"]);

const SAME_CATEGORIES = new Set(["str", "bool", "uuid", "bytes", "json"]);

// Returns true if `a` and `b` can be combined under EdgeQL's "comparable"
// rules — same type, compatible numeric families (small-int <-> float OK;
// bigint/decimal <-> float NOT OK), or one of the known cross-temporal pairs
// (`local_date <-> local_datetime`, `relative_duration <-> date_duration`).
// Compatible pairs survive operator resolution; everything else triggers
// "cannot be applied to operands".
const areCompareCompatible = (a: string, b: string): boolean => {
  if (a === b) return true;
  const ca = typeCategory(a);
  const cb = typeCategory(b);
  if (ca === "numeric" && cb === "numeric") {
    // EdgeQL incompatibility rules for numeric: `bigint`/`decimal` cannot be
    // compared with float types without an explicit cast. They CAN be
    // compared with int families and with each other. int families are
    // compatible with everything except as above.
    const aArb = NUMERIC_ARBITRARY_PRECISION.has(a);
    const bArb = NUMERIC_ARBITRARY_PRECISION.has(b);
    const aFloat = NUMERIC_FLOAT_FAMILY.has(a);
    const bFloat = NUMERIC_FLOAT_FAMILY.has(b);
    if ((aArb && bFloat) || (bArb && aFloat)) {
      return false;
    }
    return true;
  }
  if ((a === "std::cal::local_date" && b === "std::cal::local_datetime")
    || (b === "std::cal::local_date" && a === "std::cal::local_datetime")) {
    return true;
  }
  if ((a === "std::cal::relative_duration" && b === "std::cal::date_duration")
    || (b === "std::cal::relative_duration" && a === "std::cal::date_duration")) {
    return true;
  }
  if (ca === cb && SAME_CATEGORIES.has(ca)) return true;
  // Two arrays / two tuples: defer to a structural comparison of the inner
  // generics so `array<int64>` vs `array<float64>` is rejected but two
  // `array<int64>` (even when the literals were assembled differently) is
  // accepted. The simplest form: same outer kind AND same printed name OR
  // anytype on either side wins (we use `anytype` for empty/unknown).
  if (ca === cb && (ca === "array" || ca === "tuple")) {
    if (a.includes("anytype") || b.includes("anytype")) return true;
    return a === b;
  }
  return false;
};

// Arithmetic-compatible: numeric pairs per the compare rules, plus
// temporal/duration combinations EdgeQL actually permits. `datetime + datetime`
// is rejected (no such operator); `datetime + duration` returns datetime.
const areArithCompatible = (a: string, b: string): boolean => {
  if (a === b) {
    const cat = typeCategory(a);
    return cat === "numeric" || cat === "duration";
  }
  const ca = typeCategory(a);
  const cb = typeCategory(b);
  if (ca === "numeric" && cb === "numeric") {
    const aArb = NUMERIC_ARBITRARY_PRECISION.has(a);
    const bArb = NUMERIC_ARBITRARY_PRECISION.has(b);
    const aFloat = NUMERIC_FLOAT_FAMILY.has(a);
    const bFloat = NUMERIC_FLOAT_FAMILY.has(b);
    if ((aArb && bFloat) || (bArb && aFloat)) return false;
    return true;
  }
  if ((ca === "datetime" && cb === "duration") || (ca === "duration" && cb === "datetime")) return true;
  if (ca === "duration" && cb === "duration") return true;
  return false;
};

// EdgeQL schema aliases (e.g. `alias FireCard := SELECT Card FILTER .element = 'Fire'`)
// are stored on the schema as a body of EdgeQL text. When a query refers to
// such an alias by name we want the gel_ir to carry the alias's expanded body
// — same as if the user had inlined `(SELECT Card FILTER .element = 'Fire')`
// at that position — so downstream SQL lowering treats it as a real set
// expression and not an unresolved type. Returns undefined when the name is
// not an alias, when the alias body cannot be parsed as a SELECT, or when
// resolving the alias would cycle.
const tryResolveSchemaAliasSet = (ctx: IRCompileContext, name: string): Set | undefined => {
  if (!ctx.schema) {
    return undefined;
  }
  const qualified = qualifyTypeName(name, ctx.module);
  const alias = ctx.schema.getAlias(qualified);
  if (!alias?.exprText) {
    return undefined;
  }
  if (ctx.aliasResolutionStack?.has(qualified)) {
    return undefined;
  }

  let body = alias.exprText.trim();
  if (body.endsWith(";")) {
    body = body.slice(0, -1).trim();
  }
  while (body.startsWith("(") && body.endsWith(")")) {
    const inner = body.slice(1, -1).trim();
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
    body = inner;
  }

  // `alias N := SELECT T {...}` parses to a `select`; `alias N := {2,3,5}`
  // (and other free-expression bodies) parse to `select_expr` wrapping a
  // FreeObjectExpr. Both shapes resolve through `compileFreeObjectExpr`.
  let ast: Extract<EdgeQLStatement, { kind: "select" | "select_expr" }> | undefined;
  for (const candidate of [body, `SELECT ${body}`]) {
    const parsed = tryResult(() => parseEdgeQL(candidate));
    if (!parsed.ok) continue; // query failure only — try next candidate
    if (parsed.value.kind === "select" || parsed.value.kind === "select_expr") {
      ast = parsed.value;
      break;
    }
  }
  if (!ast) {
    return undefined;
  }

  if (!ctx.aliasResolutionStack) {
    ctx.aliasResolutionStack = new globalThis.Set<string>();
  }
  ctx.aliasResolutionStack.add(qualified);
  try {
    if (ast.kind === "select_expr") {
      return compileFreeObjectExpr(ast.expr, ctx);
    }
    return compileFreeObjectExpr(
      {
        kind: "select",
        typeName: ast.typeName,
        shape: ast.shape,
        clauses: {
          filter: ast.filter,
          orderBy: ast.orderBy,
          limit: ast.limit,
          offset: ast.offset,
          limitExpr: ast.limitExpr,
          offsetExpr: ast.offsetExpr,
        },
      },
      ctx,
    );
  } finally {
    ctx.aliasResolutionStack.delete(qualified);
  }
};

// Convert a function-call argument AST node into a plain FreeObjectExpr so it
// can stand in for a parameter reference during UDF body inlining. Mirrors the
// per-kind argument handling in the `function_call` IR-build case.
const functionCallArgToFreeObjectExpr = (arg: FunctionCallArgExpr): FreeObjectExpr => {
  if (arg && typeof arg === "object" && "kind" in arg) {
    if (arg.kind === "expr") return arg.expr;
    if (arg.kind === "literal") return { kind: "literal", value: arg.value };
    if (arg.kind === "field_ref") return { kind: "binding_ref", name: arg.field };
    if (arg.kind === "binding_ref") return { kind: "binding_ref", name: arg.name };
    if (arg.kind === "function_call") return { kind: "function_call", call: arg.call };
    if (arg.kind === "parameter") return { kind: "parameter", name: arg.name, castType: arg.castType } as FreeObjectExpr;
    // `a := <expr>` — peel the envelope; the inner arg is what the function sees.
    if (arg.kind === "named_arg") return functionCallArgToFreeObjectExpr(arg.arg);
    // set_literal / array_literal already match FreeObjectExpr kinds.
    return arg as FreeObjectExpr;
  }
  return { kind: "literal", value: null };
};

// Unwrap nested `select_expr` / `select_expr_subquery` wrappers around a body
// expression. UDF bodies parse as `select_expr { expr: <body> }`; the wrapper
// has no effect on the value and gets in the way of inlining.
const unwrapTrivialSelectWrapper = (expr: FreeObjectExpr): FreeObjectExpr | undefined => {
  let cursor: FreeObjectExpr = expr;
  while (true) {
    if (cursor.kind === "select_expr_subquery") {
      cursor = cursor.expr;
      continue;
    }
    return cursor;
  }
};

// Implicit-cast edges mirroring the `ALLOW IMPLICIT` casts in EdgeDB's std
// library (edb/lib/std/25-numoperators.edgeql). Used by UDF overload
// resolution to rank candidates the way the Python compiler's polyres does.
const IMPLICIT_CAST_EDGES: Record<string, string[]> = {
  "std::int16": ["std::int32", "std::float32"],
  "std::int32": ["std::int64"],
  "std::int64": ["std::float64", "std::bigint", "std::decimal"],
  "std::bigint": ["std::decimal"],
  "std::float32": ["std::float64"],
};

// Shortest implicit-cast path length from `from` to `to` (BFS over the edge
// table): 0 when equal, undefined when no implicit conversion exists.
const implicitCastDistance = (from: string, to: string): number | undefined => {
  if (from === to) return 0;
  const seen = new globalThis.Set<string>([from]);
  let frontier = [from];
  let dist = 0;
  while (frontier.length > 0) {
    dist += 1;
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of IMPLICIT_CAST_EDGES[node] ?? []) {
        if (edge === to) return dist;
        if (!seen.has(edge)) {
          seen.add(edge);
          next.push(edge);
        }
      }
    }
    frontier = next;
  }
  return undefined;
};

// Cast distance from an argument type to a parameter type. Scalar subtyping
// is free — a schema scalar extending std::str binds a `str` param at
// distance 0, matching polyres (`issubclass` short-circuits before the cast
// search). Otherwise implicit casts (int64 → float64 etc.) count by path
// length. Undefined means "cannot bind".
const argToParamCastDistance = (
  ctx: IRCompileContext,
  argType: string,
  paramType: string,
): number | undefined => {
  // Walk the arg type's extends-chain to collect it plus all its scalar
  // ancestors; an exact hit anywhere along the chain is a distance-0 match.
  const chain: string[] = [];
  const seen = new globalThis.Set<string>();
  let cursor: string | undefined = argType;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    if (cursor === paramType) return 0;
    const cur: string = cursor;
    const decl: { baseTypeName?: string } | undefined = ctx.schema
      ?.listScalarTypes()
      .find((s) => `${s.module}::${s.name}` === cur);
    cursor = decl?.baseTypeName !== undefined
      ? normalizeScalarCastName(ctx, decl.baseTypeName)
      : undefined;
  }
  for (const t of chain) {
    const d = implicitCastDistance(t, paramType);
    if (d !== undefined) return d;
  }
  return undefined;
};

// Try to bind the call-site argument types against one overload candidate's
// params, returning the total implicit-cast distance, or undefined when the
// candidate can't bind. Mirrors polyres.try_bind_call_args: a param with no
// matching arg must have a DEFAULT — `optional` alone does NOT make it
// fillable here. (That asymmetry with the single-overload inlining path below
// is deliberate: it's what lets `opt_test(false, x)` pick the 2-param
// overload over the 3-param `(tag, x, y: optional int64)` one, exactly as
// the Python compiler does.)
const scoreUDFOverloadCandidate = (
  fn: FunctionDef,
  positionalTypes: string[],
  namedTypes: Map<string, string>,
  ctx: IRCompileContext,
): number | undefined => {
  for (const name of namedTypes.keys()) {
    if (!fn.params.some((p) => p.name === name)) return undefined;
  }
  let total = 0;
  let cursor = 0;
  for (const param of fn.params) {
    const paramType = normalizeScalarCastName(ctx, param.type);
    if (param.variadic) {
      // The variadic slot absorbs every remaining positional arg; each one
      // must individually bind to the element type.
      while (cursor < positionalTypes.length) {
        const d = argToParamCastDistance(ctx, positionalTypes[cursor], paramType);
        if (d === undefined) return undefined;
        total += d;
        cursor += 1;
      }
      continue;
    }
    let argType: string | undefined;
    if (!param.namedOnly && cursor < positionalTypes.length) {
      argType = positionalTypes[cursor];
      cursor += 1;
    } else {
      argType = namedTypes.get(param.name);
    }
    if (argType === undefined) {
      if (param.default === undefined) return undefined;
      continue;
    }
    const d = argToParamCastDistance(ctx, argType, paramType);
    if (d === undefined) return undefined;
    total += d;
  }
  // Surplus positional args with no variadic slot to absorb them.
  if (cursor < positionalTypes.length) return undefined;
  return total;
};

// Pick the unique best overload for a UDF call, modeled (simplified) on the
// Python compiler's polyres.find_callable: every candidate must bind all
// arguments, candidates are ranked by total implicit-cast distance (exact
// matches beat castable ones), and anything other than a single clear winner
// — ambiguity, an unbindable argument, or an argument whose type can't be
// inferred from the AST — returns undefined so the caller bails instead of
// guessing.
const resolveUDFOverload = (
  candidates: FunctionDef[],
  args: FunctionCallArgExpr[],
  ctx: IRCompileContext,
): FunctionDef | undefined => {
  const positionalTypes: string[] = [];
  const namedTypes = new Map<string, string>();
  for (const arg of args) {
    const isNamed = arg && typeof arg === "object" && "kind" in arg && arg.kind === "named_arg";
    const inferAttempt = tryResult(() =>
      inferAstExprTypeName(functionCallArgToFreeObjectExpr(isNamed ? arg.arg : arg), ctx),
    );
    if (!inferAttempt.ok || inferAttempt.value === undefined) return undefined;
    if (isNamed) namedTypes.set(arg.name, inferAttempt.value);
    else positionalTypes.push(inferAttempt.value);
  }
  let best: FunctionDef[] = [];
  let bestDistance = Infinity;
  for (const fn of candidates) {
    const distance = scoreUDFOverloadCandidate(fn, positionalTypes, namedTypes, ctx);
    if (distance === undefined) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [fn];
    } else if (distance === bestDistance) {
      best.push(fn);
    }
  }
  return best.length === 1 ? best[0] : undefined;
};

// Attempt to build an inlined-body Set for a user-defined function call. The
// body becomes the SQL compiler's expression to lower, with parameters
// substituted by the call's argument expressions. Returns undefined when:
//   - the function isn't a user-defined expr-body UDF in the current schema,
//   - the call has multiple overloads and type-based resolution (see
//     resolveUDFOverload above) can't pick a unique best one, or
//   - the body uses AST kinds the substitution walker doesn't cover.
const tryBuildInlinedUDFBody = (
  callName: string,
  args: FunctionCallArgExpr[],
  ctx: IRCompileContext,
): Set | undefined => {
  if (!ctx.schema) return undefined;
  const dividerIdx = callName.lastIndexOf("::");
  const moduleName = dividerIdx >= 0 ? callName.slice(0, dividerIdx) : ctx.module;
  const shortName = dividerIdx >= 0 ? callName.slice(dividerIdx + 2) : callName;
  // Skip well-known stdlib modules — those are handled by lowerStdlibFunctionSql.
  if (moduleName === "std" || moduleName === "math" || moduleName === "cal") return undefined;
  const matches = ctx.schema.listFunctions().filter((fn) =>
    fn.module === moduleName && fn.name === shortName,
  );
  if (matches.length === 0) return undefined;
  const fn = matches.length === 1 ? matches[0] : resolveUDFOverload(matches, args, ctx);
  if (!fn) return undefined;
  const fnBody = fn.body;
  if (fnBody.kind !== "query") return undefined;
  // Split call-site args into positional and named. Named args (`a := X`)
  // bypass positional ordering and bind by parameter name; remaining
  // positional args fill the leading positional / namedOnly-excluded slots
  // in declared order. Anything left over (more positional args than
  // positional slots) is unsupported.
  const positionalArgs: FunctionCallArgExpr[] = [];
  const namedArgs = new Map<string, FunctionCallArgExpr>();
  for (const arg of args) {
    if (arg && typeof arg === "object" && "kind" in arg && arg.kind === "named_arg") {
      namedArgs.set(arg.name, arg.arg);
    } else {
      positionalArgs.push(arg);
    }
  }
  const positionalParams = fn.params.filter((p) => !p.namedOnly);
  // A variadic slot absorbs any surplus positional args.
  const hasVariadic = fn.params.some((p) => p.variadic);
  if (!hasVariadic && positionalArgs.length > positionalParams.length) return undefined;
  // Every named arg must match a declared parameter (named-only or not).
  for (const name of namedArgs.keys()) {
    if (!fn.params.some((p) => p.name === name)) return undefined;
  }
  // Parameters not satisfied by either positional or named args need defaults
  // (or must be OPTIONAL — defaultable to empty set).
  let positionalCursor = 0;
  for (const param of fn.params) {
    // A variadic param is always satisfiable: zero leftover positional args
    // simply pack into an empty array.
    if (param.variadic) {
      positionalCursor = positionalArgs.length;
      continue;
    }
    const isPositionalSlot = !param.namedOnly;
    const filled = (isPositionalSlot && positionalCursor < positionalArgs.length)
      || namedArgs.has(param.name);
    if (isPositionalSlot && positionalCursor < positionalArgs.length) {
      positionalCursor += 1;
    }
    if (!filled && param.default === undefined && !param.optional) return undefined;
  }
  const parseAttempt = tryResult(() => parseEdgeQL(fnBody.query));
  if (!parseAttempt.ok) return undefined;
  const parsed = parseAttempt.value;
  if (parsed.kind !== "select_expr") return undefined;
  const bodyExpr = unwrapTrivialSelectWrapper(parsed.expr);
  if (!bodyExpr) return undefined;
  // Compile each call argument to IR exactly once and bind it to a fresh
  // name in a child scope. Replacing param refs with `binding_ref(unique)`
  // means every occurrence in the body resolves (via resolveBinding) to
  // the SAME Set object — which is the signal the SQL co-iteration pass
  // uses to recognize "all `x` references share a source". Without this,
  // `foo(x: int64) using (x*x)` called with `{1,2,3}` would compile two
  // independent union IR nodes for the two `x` references and produce a
  // Cartesian product (9 rows) instead of co-iteration (3 rows).
  const inlineCtx = childScope(ctx);
  const substitutions = new Map<string, FreeObjectExpr>();
  // Required (non-OPTIONAL, non-SET OF) params propagate emptiness: in
  // EdgeQL, `f(x)` with required `x: int64` and an empty argument yields the
  // empty set — the body never runs — even when the body is `x ?? -1`.
  // Bindings alone can't express that (the `??` would see the empty binding
  // and fire), so such params collect an EXISTS guard wrapped around the
  // whole body below. Args that are trivially non-empty skip the guard.
  const requiredGuardNames: string[] = [];
  positionalCursor = 0;
  for (const param of fn.params) {
    let argExpr: FreeObjectExpr;
    const namedArg = namedArgs.get(param.name);
    if (param.variadic) {
      // Pack all remaining positional args into an array literal — the body
      // sees the variadic param as `array<T>`.
      const packed = positionalArgs
        .slice(positionalCursor)
        .map((a) => functionCallArgToFreeObjectExpr(a));
      positionalCursor = positionalArgs.length;
      argExpr = { kind: "array_literal_expr", values: packed } as FreeObjectExpr;
    } else if (!param.namedOnly && positionalCursor < positionalArgs.length) {
      argExpr = functionCallArgToFreeObjectExpr(positionalArgs[positionalCursor]);
      positionalCursor += 1;
    } else if (namedArg !== undefined) {
      argExpr = functionCallArgToFreeObjectExpr(namedArg);
    } else if (param.default !== undefined) {
      argExpr = { kind: "literal", value: param.default };
    } else if (param.defaultExpr !== undefined) {
      // Non-scalar default (array/tuple literal like `[9]` or `(9,)`): the
      // scalar reducer couldn't turn it into a ScalarValue, so the raw text
      // was preserved. Parse it as an EdgeQL expression and substitute the
      // resulting AST exactly as if it had been written at the call site.
      const parsedDefault = tryResult(() => parseEdgeQL(`SELECT ${param.defaultExpr}`));
      if (!parsedDefault.ok || parsedDefault.value.kind !== "select_expr") return undefined;
      const defaultBody = unwrapTrivialSelectWrapper(parsedDefault.value.expr);
      if (!defaultBody) return undefined;
      argExpr = defaultBody as FreeObjectExpr;
    } else {
      // OPTIONAL param without an explicit default: substitute the empty
      // set so the body's body-level set-union behaves correctly (e.g.
      // `{<str>x, y}` with empty x reduces to `{y}`).
      argExpr = { kind: "set_literal", values: [] };
    }
    // Modifying functions force each argument to be evaluated exactly once,
    // so a non-singleton argument is a compile error (upstream EdgeDB). A
    // required (non-OPTIONAL, non-SET OF) param rejects a provably-empty
    // argument; ANY param rejects a provably multi-element argument. SET OF
    // params take the whole set, so they're exempt from both checks.
    if (fn.volatility === "Modifying" && !param.setOf && !param.variadic) {
      if (astExprDefinitelyMulti(argExpr, ctx)) {
        throw new AppError(
          "E_SEMANTIC",
          "possibly more than one element passed into modifying function",
          1,
          1,
        );
      }
      if (!param.optional && astExprDefinitelyEmpty(argExpr)) {
        throw new AppError(
          "E_SEMANTIC",
          "possibly an empty set passed as non-optional argument into modifying function",
          1,
          1,
        );
      }
    }
    const argAttempt = tryResult(() => compileFreeObjectExpr(argExpr, ctx));
    if (!argAttempt.ok) return undefined;
    // A param declared as a NAMED tuple (`x: tuple<a: int64>`) makes the body
    // see `x` as a named tuple even when the call passes a positional `(1,)`.
    // Rewrite the bound argument's tuple values to carry the declared element
    // names so the result serializes by name (`{"a": 1}`) and `.a` resolves.
    const argIR: Set = coerceArgToNamedTupleType(ctx, argAttempt.value, param.type);
    const uniqueName = `__udf_inline__${shortName}__${param.name}__${inlineCallCounter++}`;
    bindValue(inlineCtx, uniqueName, argIR);
    substitutions.set(param.name, { kind: "binding_ref", name: uniqueName });
    const argNonEmpty = astExprDefinitelyNonEmpty(argExpr, ctx);
    if (argNonEmpty) {
      // Propagate the fact through nested inlining: when the substituted body
      // itself calls a UDF with this binding as an argument (`foo(x) using
      // (inner(x) + …)`), the nested call only sees a binding_ref — record
      // the bound Set so the nested guard decision can recover non-emptiness
      // instead of wrapping the inner body in a de-correlating EXISTS guard.
      definitelyNonEmptyBindingSets.add(argIR);
    }
    if (!param.optional && !param.setOf && !param.variadic && !argNonEmpty) {
      requiredGuardNames.push(uniqueName);
    }
  }
  // All substitutions are binding_ref → binding_ref renames (each argument
  // is pre-bound to a unique name above), so a generic structural rename
  // walker covers every AST context — select-statement filters, shape
  // computeds, order-by, nested calls — without enumerating node kinds.
  const renames = new Map<string, string>();
  for (const [from, to] of substitutions) {
    if (to.kind === "binding_ref") renames.set(from, to.name);
  }
  let substituted = renameBindingRefsDeep(bodyExpr, renames) as FreeObjectExpr;
  // Required-param emptiness guards: `(SELECT body FILTER EXISTS arg)` per
  // possibly-empty required argument (see requiredGuardNames above). FILTER
  // drops rows (rather than producing a NULL like an IF/ELSE with an empty
  // ELSE branch would), which is exactly the empty-set propagation EdgeQL
  // gives required params in both top-level and shape-computed positions.
  for (const guardName of requiredGuardNames) {
    substituted = {
      kind: "select_expr_subquery",
      expr: substituted,
      filter: { kind: "exists", expr: { kind: "binding_ref", name: guardName } },
    } as FreeObjectExpr;
  }
  const bodyAttempt = tryResult(() => compileFreeObjectExpr(substituted, inlineCtx));
  return bodyAttempt.ok ? bodyAttempt.value : undefined;
};

// IR Sets known to be non-empty at their binding site — populated when a UDF
// inline binds an argument whose AST was provably non-empty, so nested
// inlined calls receiving the binding can skip the EXISTS guard (see
// astExprDefinitelyNonEmpty's binding_ref case). WeakSet keyed by object
// identity: resolveBinding returns the exact Set bound by bindValue.
const definitelyNonEmptyBindingSets = new WeakSet<Set>();

// Conservative "this argument expression can never be the empty set" check
// used to skip the required-param EXISTS guard for trivially non-empty args
// (literals, tuple/array constructors, non-empty set constructors, casts of
// the same, FOR-iterator references, and the shape-computed subject `.`).
const astExprDefinitelyNonEmpty = (expr: FreeObjectExpr, ctx: IRCompileContext): boolean => {
  switch (expr.kind) {
    case "literal":
      return (expr as { value: unknown }).value !== null;
    case "tuple":
    case "array_literal_expr":
      return true;
    case "set_literal":
      return (expr as { values: unknown[] }).values.length > 0
        && (expr as { values: unknown[] }).values.every((v) => v !== null);
    case "set_expr":
      return (expr as { values: FreeObjectExpr[] }).values.some((v) => astExprDefinitelyNonEmpty(v, ctx));
    case "cast":
      return astExprDefinitelyNonEmpty((expr as { expr: FreeObjectExpr }).expr, ctx);
    case "binding_ref": {
      // A FOR-iterator variable is bound to exactly one element per
      // iteration, so it can never be empty inside the loop body. Crucially,
      // wrapping the inlined body in `FILTER EXISTS <iterator>` would
      // DE-CORRELATE the iterator from the enclosing co-iteration scope, so
      // the guard must be skipped here, not merely "may be skipped".
      // Iterator bindings are recognised by the `for:<name>:<scope>` pathId
      // namespace tag stamped where the for_expr binds its variable; the
      // name match guards against derived bindings (`with z := x.prop`)
      // that merely inherit the iterator's namespace but may be empty.
      const name = (expr as { name: string }).name;
      const bound = resolveBinding(ctx, name);
      if (!bound) return false;
      // A binding recorded non-empty at its own binding site (nested UDF
      // inline argument whose AST was provably non-empty).
      if (definitelyNonEmptyBindingSets.has(bound)) return true;
      const namespace = bound.pathId?.namespace;
      return namespace !== undefined
        && namespace.some((tag) => tag.startsWith(`for:${name}:`));
    }
    case "current_item":
      // The bare leading-dot subject of a shape computed: the row being
      // projected always exists, so `.` itself is non-empty (a field access
      // off it, `.x`, parses as field_access and stays guarded).
      return true;
    default:
      return false;
  }
};

// Conservative "this argument expression can definitely be the EMPTY set"
// check used to reject empty args passed to a required parameter of a
// Modifying function. Only fires for shapes we can statically prove empty —
// an explicit empty set literal `{}` or a cast of one (`<int64>{}`). Anything
// we can't prove returns false (the call is allowed through).
const astExprDefinitelyEmpty = (expr: FreeObjectExpr): boolean => {
  switch (expr.kind) {
    case "set_literal":
      return (expr as { values: unknown[] }).values.length === 0;
    case "set_expr":
      return (expr as { values: FreeObjectExpr[] }).values.length === 0;
    case "cast":
      return astExprDefinitelyEmpty((expr as { expr: FreeObjectExpr }).expr);
    default:
      return false;
  }
};

// Conservative "this argument expression definitely contains MORE THAN ONE
// element" check used to reject multi-element args passed to any parameter of
// a Modifying function. Fires only for statically multi set constructors
// (`{1, 2, 3}`) — or casts thereof — where every element is itself a proven
// singleton, so the set has > 1 element with certainty.
const astExprDefinitelyMulti = (expr: FreeObjectExpr, ctx: IRCompileContext): boolean => {
  switch (expr.kind) {
    case "set_expr": {
      const values = (expr as { values: FreeObjectExpr[] }).values;
      return values.length > 1 && values.every((v) => astExprDefinitelyNonEmpty(v, ctx));
    }
    case "set_literal":
      return (expr as { values: unknown[] }).values.length > 1;
    case "cast":
      return astExprDefinitelyMulti((expr as { expr: FreeObjectExpr }).expr, ctx);
    default:
      return false;
  }
};

// Deep structural clone that renames every `{kind:"binding_ref", name}` node
// (in any position — filter values, function args, computed shapes, …) per
// the rename map. Non-binding_ref nodes pass through with children rewritten.
const renameBindingRefsDeep = (node: unknown, renames: Map<string, string>): unknown => {
  if (Array.isArray(node)) return node.map((child) => renameBindingRefsDeep(child, renames));
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.kind === "binding_ref" && typeof obj.name === "string") {
      const to = renames.get(obj.name);
      return to !== undefined ? { ...obj, name: to } : obj;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = renameBindingRefsDeep(obj[key], renames);
    }
    // Field access on a parameter (`x.name` for param `x`) parses as a path
    // whose head / leading object_ref step carries the param name, not a
    // binding_ref — rewrite those name slots too. Params shadow type names
    // inside the body, so an unconditional rename is correct.
    if (out.kind === "path" && typeof out.head === "string" && renames.has(out.head)) {
      out.head = renames.get(out.head);
    }
    if (out.kind === "path_chain" && Array.isArray(out.parts)
        && typeof out.parts[0] === "string" && renames.has(out.parts[0])) {
      out.parts = [renames.get(out.parts[0]), ...(out.parts as unknown[]).slice(1)];
    }
    if (out.kind === "object_ref" && typeof out.name === "string" && renames.has(out.name)) {
      out.name = renames.get(out.name);
    }
    return out;
  }
  return node;
};

let inlineCallCounter = 0;

// Lower `(GROUP <link> BY <atoms>) [{ key:{…}, elements:{…} }]` (a group in
// expression/shape position) to an `embedded_group` Set. The SQL stage turns
// this into a correlated `GROUP BY` subquery over the link.
const compileEmbeddedGroup = (
  groupExpr: Extract<FreeObjectExpr, { kind: "group_expr" }>,
  trailingShape: EdgeQLShapeElement[] | undefined,
  ctx: IRCompileContext,
): Set => {
  validateGroupByAtomCollisions(groupExpr.by, (message) => {
    throw new AppError("E_SEMANTIC", message, 1, 1);
  });
  // Compile the link bare (`.deck`); a shape on the source (`.deck { name }`)
  // is the element projection, re-rooted at the target type below so its
  // columns read off the grouped target row rather than re-walking the link.
  let sourceAst = groupExpr.source;
  let sourceShapeAst: EdgeQLShapeElement[] = [];
  if (sourceAst.kind === "shape_projection") {
    sourceShapeAst = sourceAst.shape;
    sourceAst = sourceAst.expr;
  }
  const sourceSet = compileFreeObjectExpr(sourceAst, ctx);
  const targetRoot = setFromTypeRoot(sourceSet.typeref);

  const atomsOf = (el: GroupByElement): GroupByAtom[] => {
    if (el.kind === "field_ref" || el.kind === "name_ref" || el.kind === "link_property_ref") return [el];
    if (el.kind === "sets") return el.sets.flat();
    return el.atoms; // cube / rollup
  };
  const byAtoms = groupExpr.by.flatMap(atomsOf).map((atom) => ({
    name: atom.kind === "field_ref" ? atom.field : atom.name,
    isLinkProperty: atom.kind === "link_property_ref",
  }));

  // A trailing shape projects the group result's virtual fields. `key`'s inner
  // shape names the key fields to emit; `elements`'s inner shape becomes the
  // element projection. Both are interpreted here, not via the generic shape
  // compiler (which would reject `key`/`elements` as non-existent members).
  let keyFields: string[] | undefined;
  let trailingElementsAst: EdgeQLShapeElement[] | undefined;
  for (const el of trailingShape ?? []) {
    if (!("name" in el)) continue;
    if (el.name === "key" && "shape" in el && el.shape) {
      keyFields = el.shape
        .filter((s): s is Extract<EdgeQLShapeElement, { name: string }> => "name" in s && typeof s.name === "string")
        .map((s) => s.name);
    } else if (el.name === "elements" && "shape" in el && el.shape) {
      trailingElementsAst = el.shape;
    }
  }
  const rawElementsShape = trailingElementsAst ?? sourceShapeAst;
  const elementsShape = rawElementsShape.length > 0
    ? compileShape(targetRoot, rawElementsShape, ctx)
    : undefined;

  return {
    kind: "set",
    expr: {
      kind: "embedded_group",
      source: sourceSet,
      byAtoms,
      keyFields,
      elementsShape,
      hasTrailingShape: trailingShape !== undefined,
      typeref: sourceSet.typeref,
    } as EmbeddedGroupExpr,
    pathId: defaultPathId("embedded_group"),
    typeref: sourceSet.typeref,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

const compileFreeObjectExpr = (expr: FreeObjectExpr | ComputedExpr, ctx: IRCompileContext): Set => {
  const resolveHeadSet = (name: string): Set => {
    const bound = resolveBinding(ctx, name);
    if (bound) return bound;
    const aliasSet = tryResolveSchemaAliasSet(ctx, name);
    if (aliasSet) return aliasSet;
    return setFromTypeRoot(resolveTypeRef(ctx, name));
  };

  switch (expr.kind) {
    case "set_literal": {
      const result = compileSetConstructor(expr.values.map((value) => literalToSet(value)), "set_literal");
      // Apply the inferred scalar type so downstream `INTROSPECT TYPEOF X` /
      // `X IS T` checks see e.g. `std::float64` instead of `std::anyscalar`.
      const inferred = inferAstExprTypeName(expr, ctx);
      if (inferred && result.typeref?.id === "unknown:std::anyscalar") {
        return { ...result, typeref: unknownTypeRef(inferred) };
      }
      return result;
    }

    case "set_expr": {
      const compiledValues = expr.values.map((value) => compileFreeObjectExpr(value, ctx));
      // A set constructor `{A, B}` over object types (the parse of `A union B`)
      // is a type union — reject incompatible same-named pointers across the
      // members, matching EdgeQL's union-type rules.
      for (let i = 0; i < compiledValues.length; i += 1) {
        for (let j = i + 1; j < compiledValues.length; j += 1) {
          validateUnionPointerCompat(compiledValues[i], compiledValues[j], ctx);
        }
      }
      const result = compileSetConstructor(compiledValues, "set_expr");
      // Apply the inferred scalar type so downstream `INTROSPECT TYPEOF X` /
      // `X IS T` checks see the promoted type instead of `std::anyscalar`.
      const inferred = inferAstExprTypeName(expr, ctx);
      if (inferred && result.typeref?.id === "unknown:std::anyscalar") {
        return { ...result, typeref: unknownTypeRef(inferred) };
      }
      return result;
    }

    case "current_item": {
      return resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__") ?? literalToSet(null);
    }

    case "distinct": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "distinct",
          args: { "0": mkCallArg(inner) },
          returning: inner.typeref,
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("distinct"),
        typeref: inner.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "binding_ref": {
      const bound = resolveBinding(ctx, expr.name);
      if (bound) {
        return bound;
      }
      const enumType = lookupEnumScalar(ctx, expr.name);
      if (enumType) {
        failSemantic(`enum path expression lacks an enum member name, as in '${expr.name}.${enumType.members[0]}'`);
      }
      const aliasSet = tryResolveSchemaAliasSet(ctx, expr.name);
      if (aliasSet) return aliasSet;
      // Inside a shape body (`SELECT T { x := p2 }`) the surrounding
      // compileShape binds `__subject__` / `__current__` to the source set.
      // A bare name like `p2` should resolve to a field/link on the subject
      // before we fall through to the unknown-type-root marker — otherwise
      // the SQL pipeline never emits the `p2` column and the alias yields a
      // phantom type-reference value.
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      if (subject) {
        const ptrref = resolvePointerRef(ctx, subject.typeref, expr.name);
        if (ptrref) {
          return ptrref.computedLinkAliasIsBackward
            ? extendPathSetDirectional(subject, ptrref, "inbound")
            : extendPathSet(subject, ptrref);
        }
        const computedSet = tryLowerComputedPropertyOnTypePath(ctx, subject, expr.name);
        if (computedSet) return computedSet;
      }
      const typeref = resolveTypeRef(ctx, expr.name);
      return setFromTypeRoot(typeref);
    }

    case "field_ref": {
      const bound = resolveBinding(ctx, expr.field);
      if (bound) {
        return bound;
      }
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      const ptrref = subject ? resolvePointerRef(ctx, subject.typeref, expr.field) : undefined;
      return subject && ptrref ? extendPathSet(subject, ptrref) : literalToSet(null);
    }

    case "polymorphic_field_ref": {
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      // `[is Bb & Bc].bb` / `[is (CBaBc | Bb) & Bc].bc` — a compound `[is …]`
      // type expression (no single `sourceType`). Evaluate the `&`/`|` tree to
      // the concrete types it admits and narrow to their `|`-union, so pointer
      // resolution probes every branch and the SQL layer gates the column by
      // `__source_type` (a row contributes only when its concrete type is in
      // the intersection). An empty intersection narrows to the empty set.
      let narrowedTyperef: TypeRef;
      if (!expr.sourceType && expr.sourceTypeExpr) {
        const concrete = evalTypeExprConcreteNames(ctx, expr.sourceTypeExpr);
        if (concrete && concrete.size === 0) {
          return literalToSet(null);
        }
        const baseTyperef = subject?.typeref ?? resolveTypeRef(ctx, "std::BaseObject");
        narrowedTyperef = concrete
          ? { ...baseTyperef, id: [...concrete].join(" | "), isScalar: false, isAbstract: false }
          : baseTyperef;
      } else {
        narrowedTyperef = resolveTypeRef(ctx, expr.sourceType);
      }
      const narrowedSubject = subject
        ? { ...subject, typeref: narrowedTyperef }
        : setFromTypeRoot(narrowedTyperef);
      const ptrref = resolvePointerRef(ctx, narrowedSubject.typeref, expr.field);
      return ptrref ? extendPathSet(narrowedSubject, ptrref) : literalToSet(null);
    }

    case "type_name": {
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      // `.__type__.name` is per-row whenever the source spans more than one
      // concrete type: a union link target (`ck -> C | K`) or a type with
      // concrete subtypes (`D` whose rows may be D/E/F). In those cases mark
      // the set so the SQL layer reads the dynamic `__source_type` column
      // rather than the static parent/union name — otherwise
      // `FILTER .__type__.name = 'default::D'` would match every subtype row.
      const isUnion = !!subject && subject.typeref.id.includes("|");
      const hasSubtypes = !!subject
        && !subject.typeref.id.startsWith("unknown:")
        && (ctx.schema?.listConcreteTypesAssignableTo(subject.typeref.id).length ?? 0) > 1;
      if (subject && (isUnion || hasSubtypes)) {
        return {
          ...literalToSet(subject.typeref.id),
          dynamicTypeName: true,
        } as Set;
      }
      return literalToSet(subject?.typeref.id ?? null);
    }

    case "select": {
      const scoped = withBindings(ctx, expr.clauses._withBindings);
      const bound = resolveBinding(scoped, expr.typeName);
      const aliasSet = bound ? undefined : tryResolveSchemaAliasSet(scoped, expr.typeName);
      if (!bound && !aliasSet && ctx.schema) {
        const qualified = qualifyTypeName(expr.typeName, ctx.module);
        const typeDef = getSchemaType(scoped, qualified) ?? ctx.schema.getType(qualified);
        const universal = isUniversalObjectRefName(expr.typeName);
        if (!typeDef && !universal && !expr.typeName.startsWith("schema::")) {
          throw new AppError(
            "E_SEMANTIC",
            `object type or alias '${qualified}' does not exist`,
            1,
            1,
          );
        }
      }
      const typeref = bound?.typeref ?? aliasSet?.typeref ?? resolveTypeRef(scoped, expr.typeName);
      let root = bound ?? aliasSet ?? setFromTypeRoot(typeref);
      // `(DETACHED User)` is a fresh, independent set: stamp a unique namespace
      // so two detached references to the same type don't factor together into
      // one correlated source. (`(DETACHED User).name ++ (DETACHED User).name`
      // is the full cross product, not the diagonal.)
      if (expr.detached && !bound && !aliasSet) {
        const detachedNs = `detached:${ctx.nextScopeId++}`;
        root = {
          ...root,
          pathId: {
            ...root.pathId,
            namespace: [...(root.pathId?.namespace ?? []), detachedNs],
          },
        };
      }
      if (expr.shape.length > 0) {
        const compiledShape = compileShape(root, expr.shape, scoped);
        augmentGroupRowFieldShape(root, expr.shape, compiledShape);
        root = {
          ...root,
          shape: compiledShape,
        };
      }
      const clauses = expr.clauses;
      const hasClauses = clauses && (
        clauses.filter !== undefined
        || clauses.orderBy !== undefined
        || clauses.limit !== undefined
        || clauses.offset !== undefined
      );
      if (!hasClauses) {
        return root;
      }
      const where = clauses?.filter ? compileFilterExpr(clauses.filter, root, scoped) : undefined;
      // ORDER BY paths (`Issue.number` collapses to field `number`, and
      // leading-dot fields) resolve against THIS select's subject, not the
      // enclosing query's.
      const orderCtx = childScope(scoped);
      bindValue(orderCtx, "__current__", root);
      bindValue(orderCtx, "__subject__", root);
      return {
        kind: "set",
        expr: {
          kind: "select_expr",
          result: root,
          where,
          orderBy: clauses?.orderBy ? compileSelectOrderExprChain(clauses.orderBy, orderCtx) : undefined,
          offset: clauses?.offset === undefined ? undefined : literalToSet(clauses.offset),
          limit: clauses?.limit === undefined ? undefined : literalToSet(clauses.limit),
          implicitWrapper: false,
        },
        pathId: defaultPathId(`select_with_clauses:${expr.typeName}`),
        typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "subquery": {
      return compileFreeObjectExpr({ kind: "select", typeName: expr.typeName, shape: expr.shape, clauses: expr.clauses }, ctx);
    }

    case "select_expr_subquery": {
      // `( WITH MODULE cards … )` — the module switch applies to the whole
      // subquery, including its WITH binding values.
      const subqueryModule = expr.clauses?._withModule;
      const moduleCtx = subqueryModule && subqueryModule !== ctx.module
        ? { ...ctx, module: subqueryModule }
        : ctx;
      const scoped = withBindings(moduleCtx, expr.clauses?._withBindings);
      let inner = compileFreeObjectExpr(expr.expr, scoped);
      // `SELECT alias := X ORDER BY alias` binds `alias` to `X` for the
      // duration of the SELECT's modifiers; the FILTER / ORDER BY clauses
      // need to resolve that name back to the inner expression. Also
      // shadow `__current__`/`__subject__` so leading-dot references
      // (`.number`) inside the FILTER resolve against the subquery's
      // subject rather than the enclosing query's.
      const clauseCtx = childScope(scoped);
      if (expr.alias) {
        bindValue(clauseCtx, expr.alias, inner);
      }
      bindValue(clauseCtx, "__current__", inner);
      bindValue(clauseCtx, "__subject__", inner);
      // ORDER BY into a first-element projection (`order by .keyCard.cost`)
      // reads raw element fields the subject may not carry — rebuild the
      // group with them when possible.
      {
        const grouped = peelToGroupRows(inner);
        const astParts = grouped?.groupRows.astParts as GroupAstParts | undefined;
        if (grouped && astParts && expr.orderBy) {
          const needed = new globalThis.Set<string>();
          const scanOrder = (node: unknown): void => {
            if (!node || typeof node !== "object") return;
            const maybe = node as { kind?: string; field?: string; expr?: unknown; tail?: unknown };
            if (maybe.kind === "field_access") {
              // Collect `.head.field` pairs: head matching an element_first
              // projection needs `field` on the subject rows.
              const innerFa = maybe.expr as { kind?: string; field?: string } | undefined;
              if (innerFa?.kind === "field_access" && typeof innerFa.field === "string" && typeof maybe.field === "string") {
                const headProj = (grouped.groupRows.projection ?? []).find((proj) => proj.name === innerFa.field);
                if (headProj && (headProj.kind === "element_first_shape" || headProj.kind === "element_first_path")) {
                  needed.add(maybe.field);
                }
              }
            }
            for (const value of Object.values(maybe)) {
              if (value && typeof value === "object") scanOrder(value);
            }
          };
          scanOrder(expr.orderBy);
          if (needed.size > 0) {
            const astShape = grouped.groupRows.astShape as EdgeQLShapeElement[] | undefined;
            inner = buildGroupRowsSet(astParts, astShape, scoped, [...needed]);
            bindValue(clauseCtx, "__current__", inner);
            bindValue(clauseCtx, "__subject__", inner);
            if (expr.alias) bindValue(clauseCtx, expr.alias, inner);
          }
        }
      }
      // Surface the deepest shape on the outer set so
      // `(SELECT X { c := … }).c` and `(SELECT X { c := … } FILTER …).c` both
      // find the computed entry via field_access's shape lookup. The inner
      // shape lives directly on `inner.shape` when the body was a plain
      // shape, or one level deeper inside a `select_expr.result` when FILTER/
      // ORDER BY required wrapping. SQL lowering still reads the shape off
      // the select_expr's `result`, so this is purely a read-side hint.
      const innerShape = inner.shape.length > 0
        ? inner.shape
        : (inner.expr.kind === "select_expr"
            ? (inner.expr as SelectExpr).result.shape
            : []);
      return {
        kind: "set",
        expr: {
          kind: "select_expr",
          result: inner,
          where: expr.filter ? compileFreeObjectExpr(expr.filter, clauseCtx) : undefined,
          orderBy: expr.orderBy ? compileOrderExprChain(expr.orderBy, clauseCtx) : undefined,
          // A non-constant LIMIT/OFFSET (`LIMIT len(User.name) - 3`) parses to
          // `limitExpr`/`offsetExpr` — compile it as a set so the SQL layer can
          // correlate its paths to the enclosing row, instead of dropping it.
          offset: expr.offset !== undefined ? literalToSet(expr.offset)
            : expr.offsetExpr !== undefined ? compileFreeObjectExpr(expr.offsetExpr, clauseCtx) : undefined,
          limit: expr.limit !== undefined ? literalToSet(expr.limit)
            : expr.limitExpr !== undefined ? compileFreeObjectExpr(expr.limitExpr, clauseCtx) : undefined,
          implicitWrapper: false,
        },
        pathId: defaultPathId("select_expr_subquery"),
        typeref: inner.typeref,
        shape: innerShape,
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "path": {
      if (!resolveBinding(ctx, expr.head)) {
        const enumLiteral = resolvePathToEnumLiteral(ctx, expr.head, expr.tail);
        if (enumLiteral) return enumLiteral;
      }
      if (expr.steps?.length) {
        return compilePathSteps(expr.steps, ctx);
      }
      const headSet = resolveHeadSet(expr.head);
      const ptrref = resolvePointerRef(ctx, headSet.typeref, expr.tail);
      return ptrref ? extendPathSet(headSet, ptrref) : {
        ...headSet,
        pathId: defaultPathId(`${expr.head}.${expr.tail}`),
      };
    }

    case "path_chain": {
      if (!resolveBinding(ctx, expr.parts[0] ?? "")) {
        const headName = expr.parts[0];
        if (headName) {
          const enumType = lookupEnumScalar(ctx, headName);
          if (enumType) {
            if (expr.parts.length < 2) {
              failSemantic(`enum path expression lacks an enum member name, as in '${headName}.${enumType.members[0]}'`);
            }
            if (expr.parts.length > 2) {
              failSemantic(`invalid property reference on an expression of primitive type`);
            }
            return resolvePathToEnumLiteral(ctx, headName, expr.parts[1]) ?? literalToSet(null);
          }
        }
      }
      if (expr.steps?.length) {
        return compilePathSteps(expr.steps, ctx);
      }
      const [head, ...tail] = expr.parts;
      if (!head) {
        return literalToSet(null);
      }
      let out = resolveHeadSet(head);
      for (const field of tail) {
        const ptrref = resolvePointerRef(ctx, out.typeref, field);
        if (!ptrref) {
          return {
            ...out,
            pathId: defaultPathId(expr.parts.join(".")),
          };
        }
        out = extendPathSet(out, ptrref);
      }
      return out;
    }

    case "path_steps": {
      if (expr.steps.length === 0) {
        return literalToSet(null);
      }
      const [first, ...rest] = expr.steps;
      if (!first || first.kind !== "object_ref") {
        // A partial path (`[is BaseOriginB].dest.name`, `.dest.name`) starts
        // from the surrounding subject rather than a named object. Delegate to
        // the shared path walker, which seeds from `__current__`/`__subject__`
        // and applies a leading `[is T]` intersection.
        return compilePathSteps(expr.steps, ctx);
      }
      if (!resolveBinding(ctx, first.name)) {
        const enumType = lookupEnumScalar(ctx, first.name);
        if (enumType) {
          const memberStep = rest.find((step) => step.kind === "ptr");
          if (!memberStep || memberStep.kind !== "ptr") {
            failSemantic(`enum path expression lacks an enum member name, as in '${first.name}.${enumType.members[0]}'`);
          }
          const ptrSteps = rest.filter((step) => step.kind === "ptr");
          if (ptrSteps.length > 1) {
            failSemantic(`invalid property reference on an expression of primitive type`);
          }
          return resolvePathToEnumLiteral(ctx, first.name, (memberStep as { kind: "ptr"; name: string }).name) ?? literalToSet(null);
        }
      }
      let out = resolveHeadSet(first.name);
      for (const step of rest) {
        if (step.kind === "ptr") {
          let ptrref = resolvePointerRef(ctx, out.typeref, step.name);
          // A type intersection can narrow to a SUPERTYPE (`Issue[IS Named]`):
          // the rows are still the original type's, so a pointer the narrowed
          // view lacks resolves against the underlying root type.
          if (!ptrref && out.expr.kind === "type_root"
              && (out.expr as TypeRoot).typeref.id !== out.typeref.id) {
            ptrref = resolvePointerRef(ctx, (out.expr as TypeRoot).typeref, step.name);
          }
          if (!ptrref) {
            return {
              ...out,
              pathId: defaultPathId(expr.steps.map((item) => (item.kind === "ptr" ? item.name : "*")).join(".")),
            };
          }
          out = extendPathSetDirectional(out, ptrref, step.direction ?? "outbound");
          continue;
        }
        if (step.kind === "type_intersection") {
          // `Issue[IS Named]` — intersecting with a SUPERTYPE is a no-op:
          // the set stays the (narrower) current type. Only narrow when the
          // intersection type is NOT an ancestor of the current type.
          const intersected = resolveTypeRef(ctx, step.typeName);
          if (!isSubtypeOf(ctx, out.typeref.id, intersected.id)) {
            out = { ...out, typeref: intersected };
          }
          continue;
        }
      }
      return out;
    }

    case "field_access": {
      // `X.<l.field` (no `[IS T]` narrowing): Python treats untyped backlinks
      // as `std::BaseObject` — only `id` / `__type__` survive, accessing any
      // other field errors with "no link or property 'field'". Mirror that
      // behaviour here so the SQL pipeline never sees the dangling path.
      if (!expr.field.startsWith("@")
          && expr.field !== "id"
          && expr.field !== "__type__"
          && expr.expr.kind === "for_expr"
          && (expr.expr as Extract<FreeObjectExpr, { kind: "for_expr" }>).variable === "__gel_backlink_item__"
          && (expr.expr as Extract<FreeObjectExpr, { kind: "for_expr" }>).body.kind === "backlink_path"
          && (((expr.expr as Extract<FreeObjectExpr, { kind: "for_expr" }>).body as Extract<FreeObjectExpr, { kind: "backlink_path" }>).sourceType === undefined)) {
        throw new AppError(
          "E_SEMANTIC",
          `object type 'std::BaseObject' has no link or property '${expr.field}'`,
          1,
          1,
        );
      }

      // `@<name>` is only valid when applied directly to a link path step.
      // EdgeQL rejects link-property access on SET OF expressions — a
      // parenthesized SELECT (`select_expr_subquery`), an array constructor,
      // a tuple, or a free-object literal all produce one of those. Other
      // forms (path / field_access / backlink_path / a FOR over a backlink,
      // which is how the parser models `.<l[IS T]`) yield a pointer and pass
      // through to the regular link-property handler below.
      if (expr.field.startsWith("@")) {
        const innerKind = expr.expr.kind;
        const rejectedInner = new Set([
          "select_expr_subquery",
          "array_literal_expr",
          "tuple",
          "free_object_constructor",
          "set_literal",
          "set_expr",
        ]);
        if (rejectedInner.has(innerKind)) {
          const propName = expr.field.slice(1);
          throw new AppError(
            "E_SEMANTIC",
            `unexpected reference to link property '${propName}' outside of a path expression`,
            1,
            1,
          );
        }
        // `X.<l[IS T]@p` where T's subtype set contains no concrete type with
        // link `l`: the parser wraps the backlink in a `for_expr` over a
        // `backlink_path` body. Verify the chosen `[IS T]` filter actually
        // includes at least one source type that defines `l`; otherwise no
        // amount of polymorphic expansion will surface `@p` and we should
        // mirror Python's "property does not exist because there are no
        // 'l' links" error.
        if (expr.expr.kind === "for_expr"
            && (expr.expr as Extract<FreeObjectExpr, { kind: "for_expr" }>).variable === "__gel_backlink_item__"
            && (expr.expr as Extract<FreeObjectExpr, { kind: "for_expr" }>).body.kind === "backlink_path") {
          const backlink = (expr.expr as Extract<FreeObjectExpr, { kind: "for_expr" }>).body as Extract<FreeObjectExpr, { kind: "backlink_path" }>;
          // Use the iterator's typeref as the link target. compileFreeObjectExpr
          // would do the same; we recompute here just to peek at the resolution.
          const iteratorSet = compileFreeObjectExpr((expr.expr as Extract<FreeObjectExpr, { kind: "for_expr" }>).iterator, ctx);
          const probe = resolveBacklinkPointerRef(ctx, iteratorSet.typeref, backlink.link, backlink.sourceType);
          if (!probe) {
            const propName = expr.field.slice(1);
            throw new AppError(
              "E_SEMANTIC",
              `property '${propName}' does not exist because there are no '${backlink.link}' links`,
              1,
              1,
            );
          }
        }
      }

      const source = compileFreeObjectExpr(expr.expr, ctx);

      // Field access into a tuple-valued computed (`.b.d` where
      // b := { c := 3, d := … } possibly produced per-iteration by a FOR):
      // resolve to the tuple element's value Set. Without this the generic
      // pointer resolution fabricates an `anytype`-targeted link and the SQL
      // stage scans a nonexistent table.
      if (!expr.field.startsWith("@")) {
        // Resolve `.field` against a named tuple value. resolveNamedTupleElement
        // peels SELECT/FOR wrappers and inlined-UDF call bodies, and distributes
        // over a UNION of named tuples (`foo({…}).a` over a multi-set arg).
        const tupleEl = resolveNamedTupleElement(source, expr.field);
        if (tupleEl) {
          return tupleEl;
        }
      }

      // Paths off a group-rows set (`.key.cost`, `.elements`, a projected
      // `.count`) aren't schema pointers — model them as group_row_field
      // steps the SQL stage resolves against the group row's JSON (or its
      // projection). Chained accesses extend the inner field's steps.
      if (!expr.field.startsWith("@")) {
        const groupedSource = peelToGroupRows(source) ?? peelToGroupRowsThroughClauses(source);
        if (groupedSource) {
          return {
            ...source,
            expr: { kind: "group_row_field", steps: [expr.field], rows: groupedSource.rows } as GroupRowFieldExpr,
            shape: [],
            pathId: defaultPathId(`group_row_field:${expr.field}`),
            typeref: unknownTypeRef("std::anytype"),
          };
        }
        if (source.expr.kind === "group_row_field") {
          const inner = source.expr as GroupRowFieldExpr;
          return {
            ...source,
            expr: { ...inner, steps: [...inner.steps, expr.field] } as GroupRowFieldExpr,
            pathId: defaultPathId(`group_row_field:${[...inner.steps, expr.field].join(".")}`),
          };
        }
      }

      if (expr.field.startsWith("@") && source.expr.kind === "pointer") {
        const linkPointer = source.expr as Pointer;
        if (!linkPointer.ptrref.isLinkProperty) {
          const propName = expr.field.slice(1);
          // Concrete subtypes contributing to this pointer's source. For a
          // simple pointer this is just the declaring type; for a polymorphic
          // backlink (`<owner[IS Text]`) it's the abstract filter's concrete
          // subtypes — each must expose the link property, or the access is
          // semantically invalid even if the filter type itself doesn't carry
          // the link.
          const components = linkPointer.ptrref.unionComponents?.length
            ? linkPointer.ptrref.unionComponents
            : [linkPointer.ptrref];
          const propDefs: Array<{ owner: string; prop: LinkPropertyDef }> = [];
          let anyComponentDefinesLink = false;
          for (const comp of components) {
            const linkOwnerTypeRef = linkPointer.direction === "inbound"
              ? comp.outSource
              : linkPointer.source.typeref;
            const linkOwnerResolved = getResolvedSchemaType(ctx, linkOwnerTypeRef.id);
            const linkDef = linkOwnerResolved?.resolvedLinks.find((candidate) => candidate.name === linkPointer.ptrref.shortName);
            if (linkDef) {
              anyComponentDefinesLink = true;
              const propDef = linkDef.properties?.find((property) => property.name === propName);
              if (propDef) {
                propDefs.push({ owner: linkOwnerTypeRef.id, prop: propDef });
              } else {
                // A concrete subtype is missing the property — Python reports
                // the same `link 'l' has no property 'p'` error even when other
                // subtypes have it, because the union must agree on schema.
                throw new AppError(
                  "E_SEMANTIC",
                  `link '${linkPointer.ptrref.shortName}' has no property '${propName}'`,
                  1,
                  1,
                );
              }
            }
          }
          if (propDefs.length > 0) {
            const first = propDefs[0].prop;
            const propertyPtrRef: PointerRef = {
              kind: "pointer_ref",
              id: `${linkPointer.ptrref.id}.${expr.field}`,
              name: expr.field,
              shortName: expr.field,
              outSource: source.typeref,
              outTarget: scalarTypeRef(first.type),
              outCardinality: first.required ? "one" : "at_most_one",
              inCardinality: "many",
              isComputed: false,
              isLinkProperty: true,
              hasProperties: false,
            };
            return extendPathSet(source, propertyPtrRef);
          }
          if (!anyComponentDefinesLink && linkPointer.direction === "inbound") {
            // Type-intersection that matches no concrete subtype with this
            // link: Python surfaces this as
            // `property 'p' does not exist because there are no 'l' links`.
            throw new AppError(
              "E_SEMANTIC",
              `property '${propName}' does not exist because there are no '${linkPointer.ptrref.shortName}' links`,
              1,
              1,
            );
          }
        }
      }

      const ptrref = resolvePointerRef(ctx, source.typeref, expr.field);
      if (ptrref) {
        const extended = ptrref.computedLinkAliasIsBackward
          ? extendPathSetDirectional(source, ptrref, "inbound")
          : extendPathSet(source, ptrref);
        // `(SELECT Type { l: { x } }).l` — the outer SELECT's shape element
        // for `l` carries a nested `{ x }` projection we want to surface on
        // the resulting pointer set. Inherit it so the SQL pipeline projects
        // `x` instead of returning bare `{}` objects.
        const shapeEntry = source.shape?.find(
          (entry) => entry.name === expr.field
            && entry.expr.shape
            && entry.expr.shape.length > 0
            && !entry.expr.typeref?.isScalar,
        );
        if (shapeEntry?.expr.shape && shapeEntry.expr.shape.length > 0 && (!extended.shape || extended.shape.length === 0)) {
          return { ...extended, shape: shapeEntry.expr.shape };
        }
        return extended;
      }
      // No direct pointer / link / backlink — try computed-property
      // substitution before the unknown-type fallback. Lets `Type.computedP`
      // lower as the computed body's expression rather than a phantom
      // `std::anytype` pointer reference.
      const computedSet = tryLowerComputedPropertyOnTypePath(ctx, source, expr.field);
      if (computedSet) {
        // `(SELECT T FILTER …).computedP` — the substituted body alone
        // loses the source's filtered iteration; wrap in a FOR over the
        // source so the body evaluates once per (filtered) row.
        const sourceHasClauses = ((): boolean => {
          let cur: Set = source;
          while (cur.expr.kind === "select_expr") {
            const se = cur.expr as SelectExpr;
            if (se.where || se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) return true;
            cur = se.result;
          }
          return false;
        })();
        // Only wrap value-producing computeds — an object-set body may have
        // further path steps applied, which the pointer-chain compiler
        // can't walk through a for_expr.
        const computedIsObjectSet = ((): boolean => {
          let cur: Set = computedSet;
          while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
          return (cur.expr.kind === "type_root" || cur.expr.kind === "pointer") && !cur.typeref.isScalar;
        })();
        if (sourceHasClauses && !computedIsObjectSet) {
          return {
            kind: "set",
            expr: {
              kind: "for_expr",
              iterator: source,
              body: computedSet,
              bindingKind: "with",
              optional: false,
            } as ForExpr,
            pathId: computedSet.pathId,
            typeref: computedSet.typeref,
            shape: computedSet.shape ?? [],
            isBinding: false,
            isMaterializedRef: false,
            isSchemaAlias: false,
          };
        }
        return computedSet;
      }
      // A shape attached to `source` may define a *new* computed pointer
      // (e.g. `Person {ok := .name = .tag}`) which the type's schema doesn't
      // declare. Surface that shape element so `P.ok` resolves to its body.
      // Skip splat-expanded entries and pure field/link entries (`{name}`):
      // those expose existing pointers and would normally have been picked
      // up by `resolvePointerRef` above — falling through to them here would
      // change the meaning of the access from "the underlying pointer" to
      // "the projected shape value", which is wrong for cross-product queries
      // that rely on the pointer reaching through to the row source.
      const shapedElement = source.shape?.find(
        (entry) =>
          entry.name !== undefined
          && entry.name === expr.field
          && entry.shapeOrigin === "explicit"
          && entry.targetPtr === undefined
          && !expr.field.startsWith("@"),
      );
      if (shapedElement) {
        // `(SELECT T { c := E } FILTER F).c` — the computed body alone loses
        // the subject's iteration scope and FILTER. Wrap it in a FOR over the
        // subject so E evaluates once per (filtered) subject row.
        const sourceHasClauses = ((): boolean => {
          let cur: Set = source;
          while (cur.expr.kind === "select_expr") {
            const se = cur.expr as SelectExpr;
            if (se.where || se.limit || se.offset || (se.orderBy && se.orderBy.length > 0)) return true;
            cur = se.result;
          }
          return false;
        })();
        // Only wrap value-producing computeds — an object-set computed
        // (type_root / pointer body) may have further path steps applied
        // (`U.friend.name`), which the pointer-chain compiler can't walk
        // through a for_expr.
        const computedIsObjectPath = ((): boolean => {
          let cur: Set = shapedElement.expr;
          while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
          return (cur.expr.kind === "type_root" || cur.expr.kind === "pointer") && !cur.typeref.isScalar;
        })();
        // A group-row chain computed (`z := g.elements.name`) is independent
        // of the subject rows, so returning the body alone would drop the
        // subject's cardinality (`count((Award {z}).z)` multiplies by the
        // Award count) — keep the FOR wrap for those too.
        const computedIsGroupRowChain = ((): boolean => {
          let cur: Set = shapedElement.expr;
          while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
          return cur.expr.kind === "group_row_field";
        })();
        if ((sourceHasClauses || computedIsGroupRowChain) && !computedIsObjectPath) {
          return {
            kind: "set",
            expr: {
              kind: "for_expr",
              iterator: source,
              body: shapedElement.expr,
              bindingKind: "with",
              optional: false,
            } as ForExpr,
            pathId: shapedElement.expr.pathId,
            typeref: shapedElement.expr.typeref,
            shape: shapedElement.expr.shape ?? [],
            isBinding: false,
            isMaterializedRef: false,
            isSchemaAlias: false,
          };
        }
        return shapedElement.expr;
      }
      // If the source is a direct `Type.field` reference (no intermediate
      // computed/subquery scope) and the field isn't a built-in pseudo-
      // pointer (`id`/`__type__`) or a link property (`@x`), surface a
      // friendly "no link or property" error instead of a phantom
      // `std::anytype` pointer. Limit to the simple type_root-source case so
      // we don't trip on subquery contexts where `.field` should bind to a
      // different subject (the select_expr_subquery handler now sets
      // `__current__` correctly, so the inner `.field` resolves against the
      // subquery's subject and bypasses this check naturally).
      if (
        ctx.schema
        && source.expr.kind === "type_root"
        && expr.field !== "id"
        && expr.field !== "__type__"
        && !expr.field.startsWith("@")
        && !source.typeref.id.startsWith("unknown:")
        && !source.typeref.id.startsWith("std::")
        && !source.typeref.isScalar
        && getResolvedSchemaType(ctx, source.typeref.id)
      ) {
        throw new AppError(
          "E_SEMANTIC",
          `object type '${source.typeref.id}' has no link or property '${expr.field}'`,
          1,
          1,
        );
      }
      // `.foo` on a scalar value (`Issue.number` is scalar, `.x` would be
      // invalid). EdgeQL reports this as "invalid property reference on
      // an expression of primitive type 'T'".
      if (
        ctx.schema
        && source.typeref.isScalar
        && !expr.field.startsWith("@")
        && expr.field !== "id"
        && expr.field !== "__type__"
      ) {
        const typeName = source.typeref.id.startsWith("unknown:")
          ? source.typeref.id.slice("unknown:".length)
          : source.typeref.id;
        throw new AppError(
          "E_SEMANTIC",
          `invalid property reference on an expression of primitive type '${typeName}'`,
          1,
          1,
        );
      }
      return {
        kind: "set",
        expr: {
          kind: "pointer",
          source,
          ptrref: {
            kind: "pointer_ref",
            id: `${source.typeref.id}.unknown::${expr.field}`,
            name: expr.field,
            shortName: expr.field,
            outSource: source.typeref,
            outTarget: unknownTypeRef("std::anytype"),
            outCardinality: "unknown",
            inCardinality: "unknown",
            isComputed: false,
            isLinkProperty: expr.field.startsWith("@"),
            hasProperties: false,
          },
          direction: "outbound",
          optionalDeref: expr.optional,
          isDefinition: false,
        } as Pointer,
        pathId: defaultPathId(`${source.typeref.id}.${expr.field}`),
        typeref: unknownTypeRef("std::anytype"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "backlink_path": {
      const subject = resolveBinding(ctx, "__subject__") ?? resolveBinding(ctx, "__current__");
      if (!subject) {
        return setFromTypeRoot(resolveTypeRef(ctx, expr.sourceType ?? "default::Object"));
      }
      const ptrref = resolveBacklinkPointerRef(ctx, subject.typeref, expr.link, expr.sourceType);
      if (!ptrref) {
        return setFromTypeRoot(resolveTypeRef(ctx, expr.sourceType ?? "default::Object"));
      }
      const out = extendPathSetDirectional(subject, ptrref, "inbound");
      if (expr.optional) {
        return {
          ...out,
          expr: {
            ...(out.expr as Pointer),
            optionalDeref: true,
          },
        };
      }
      return out;
    }

    case "exists": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "exists_expr",
          expr: inner,
        },
        pathId: defaultPathId("exists"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "index_access": {
      // Validate that the index is a non-float numeric. EdgeQL reports the
      // failure as either "cannot index array by 'std::X'" or "cannot index
      // string by 'std::X'", so we surface the source category in the message.
      const indexTypeName = expr.indexExpr
        ? inferAstExprTypeName(expr.indexExpr, ctx)
        : (typeof expr.index === "number"
            ? (Number.isInteger(expr.index) ? "std::int64" : "std::float64")
            : typeof expr.index === "string" ? "std::str" : undefined);
      if (indexTypeName) {
        const cat = typeCategory(indexTypeName);
        const isIntegerNumeric = cat === "numeric"
          && (indexTypeName === "std::int16"
            || indexTypeName === "std::int32"
            || indexTypeName === "std::int64"
            || indexTypeName === "std::bigint");
        if (!isIntegerNumeric) {
          const sourceTypeName = inferAstExprTypeName(expr.expr, ctx);
          const sourceCat = typeCategory(sourceTypeName);
          const targetWord = sourceCat === "str" ? "string"
            : sourceCat === "bytes" ? "bytes"
            : sourceCat === "json" ? "JSON"
            : "array";
          failSemantic(`cannot index ${targetWord} by '${indexTypeName}'`);
        }
      }
      // `1[0]` (int indexed) — index indirection only applies to str/bytes/
      // array/json. Surface the EdgeQL error so `<str>1[0]` (which the
      // parser reads as `<str>(1[0])` because index has higher precedence
      // than cast) reports a useful message.
      const sourceTypeName = inferAstExprTypeName(expr.expr, ctx);
      if (sourceTypeName) {
        const sourceCat = typeCategory(sourceTypeName);
        if (sourceCat !== "str" && sourceCat !== "bytes" && sourceCat !== "json"
            && sourceTypeName !== "std::anytype" && sourceTypeName !== "std::anyscalar"
            // Bare `std::tuple` is the un-parameterised placeholder a partial
            // path on a tuple-valued subject infers to (`filter .1`) — tuple
            // element access is legal there.
            && sourceTypeName !== "std::tuple"
            && !sourceTypeName.startsWith("array<") && !sourceTypeName.startsWith("tuple<")) {
          failSemantic(`index indirection cannot be applied to '${sourceTypeName}'`);
        }
      }
      const source = compileFreeObjectExpr(expr.expr, ctx);
      // A constant index into a literal tuple may resolve straight to the
      // element when cardinality is preserved — keeps the element's type root
      // visible so downstream shaping / operator correlation factor correctly.
      // Skip an implicit-subject index (`filter .1`, `order by .0`): there `.N`
      // selects a slot of the materialized result row, which the SQL stage
      // resolves against the row JSON — re-deriving the element decorrelates it.
      if (expr.indexExpr === undefined && typeof expr.index === "number"
          && expr.expr.kind !== "current_item") {
        const peeled = resolveConstTupleIndexElement(source, expr.index);
        if (peeled) return peeled;
      }
      return {
        kind: "set",
        expr: {
          kind: "index_expr",
          expr: source,
          index: expr.indexExpr ? compileFreeObjectExpr(expr.indexExpr, ctx) : literalToSet(expr.index),
        },
        pathId: defaultPathId("index_access"),
        typeref: unknownTypeRef("std::anytype"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "slice_access": {
      const checkSliceBound = (e: FreeObjectExpr | undefined, raw: unknown): void => {
        const t = e
          ? inferAstExprTypeName(e, ctx)
          : (typeof raw === "number"
              ? (Number.isInteger(raw) ? "std::int64" : "std::float64")
              : typeof raw === "string" ? "std::str" : undefined);
        if (!t) return;
        const isIntegerNumeric = t === "std::int16" || t === "std::int32"
          || t === "std::int64" || t === "std::bigint";
        if (!isIntegerNumeric) {
          const sourceTypeName = inferAstExprTypeName(expr.expr, ctx);
          const sourceCat = typeCategory(sourceTypeName);
          const targetWord = sourceCat === "str" ? "string"
            : sourceCat === "bytes" ? "bytes"
            : "array";
          failSemantic(`cannot slice ${targetWord} by '${t}'`);
        }
      };
      checkSliceBound(expr.startExpr, expr.start);
      checkSliceBound(expr.endExpr, expr.end);
      const source = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "slice_expr",
          expr: source,
          start: expr.startExpr ? compileFreeObjectExpr(expr.startExpr, ctx) : expr.start === undefined ? undefined : literalToSet(expr.start),
          end: expr.endExpr ? compileFreeObjectExpr(expr.endExpr, ctx) : expr.end === undefined ? undefined : literalToSet(expr.end),
        },
        pathId: defaultPathId("slice_access"),
        typeref: source.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "substitution": {
      const value = resolveBinding(ctx, expr.name);
      return value ?? literalToSet(null);
    }

    case "tuple": {
      const elements = expr.values.map((value, index) => ({ name: String(index), val: compileFreeObjectExpr(value, ctx) }));
      return {
        kind: "set",
        expr: {
          kind: "tuple",
          named: false,
          elements,
        },
        pathId: defaultPathId("tuple"),
        typeref: unknownTypeRef("std::tuple"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "free_object_constructor": {
      // A free object written as an *expression* (e.g. bound in WITH or nested)
      // is not a trivial top-level exposed free object, so inline DML in its
      // fields is rejected — same rule as a shape's computed expression. The
      // allowed `select { obj := (INSERT …) }` form is compiled separately via
      // `compileSelectFreeStatement`, never through this expression branch.
      for (const entry of expr.entries) {
        if (exprDefinesInlineMutation(entry.expr)) {
          throw new AppError(
            "E_SEMANTIC",
            "mutations are invalid in a shape's computed expression",
            1, 1,
          );
        }
      }
      const elements = expr.entries.map((entry) => ({ name: entry.name, val: compileFreeObjectExpr(entry.expr, ctx) }));
      return {
        kind: "set",
        expr: {
          kind: "tuple",
          named: true,
          // `(a := …)` (tupleLike) is a real tuple; `{a := …}` is a free object
          // whose fields may be empty without collapsing the object.
          isFreeObject: !expr.tupleLike,
          elements,
        },
        pathId: defaultPathId("free_object"),
        typeref: unknownTypeRef("std::tuple"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "concat": {
      const partTypes = expr.parts.map((part) => inferAstExprTypeName(part, ctx));
      const isArrayType = (typeName?: string): boolean => !!typeName && typeName.startsWith("array<");
      const definedTypes = partTypes.filter((typeName): typeName is string => typeName !== undefined);
      if (definedTypes.some(isArrayType)) {
        // `++` over arrays is array concatenation, not string concat. Every
        // defined operand must be an array; mixing an array with a scalar is
        // the genuine type error.
        const nonArrayIndex = partTypes.findIndex((typeName) => typeName !== undefined && !isArrayType(typeName));
        const offenderType = nonArrayIndex >= 0 ? partTypes[nonArrayIndex] : undefined;
        const otherType = definedTypes.find(isArrayType);
        if (offenderType !== undefined && otherType !== undefined) {
          const [leftType, rightType] = nonArrayIndex === 0 ? [offenderType, otherType] : [otherType, offenderType];
          failSemantic(`operator '++' cannot be applied to operands of type '${leftType}' and '${rightType}'`);
        }
        // Array concatenation requires compatible element types — `[1,2] ++
        // ['a']` (array<int64> ++ array<str>) is an error reported in terms of
        // the element types. `anytype` (an empty/untyped array_agg) unifies
        // with anything; numeric scalars promote to each other; tuple/array
        // element types are left to downstream structural checks.
        const numericTypes = new globalThis.Set<string>([
          "std::int16", "std::int32", "std::int64", "std::float32",
          "std::float64", "std::decimal", "std::bigint",
        ]);
        const elementType = (typeName: string): string => typeName.slice("array<".length, -1);
        const elementsIncompatible = (left: string, right: string): boolean => {
          if (left === right) return false;
          if (left === "anytype" || right === "anytype" || left === "std::anytype" || right === "std::anytype") return false;
          if (left.includes("<") || right.includes("<")) return false;
          if (numericTypes.has(left) && numericTypes.has(right)) return false;
          return true;
        };
        const concreteElements = definedTypes.map(elementType);
        const mismatch = concreteElements.find((elem) => elementsIncompatible(concreteElements[0], elem));
        if (mismatch !== undefined) {
          failSemantic(`operator '++' cannot be applied to operands of type '${concreteElements[0]}' and '${mismatch}'`);
        }
      } else {
        const nonStrIndex = partTypes.findIndex((typeName) => typeName !== undefined && typeName !== "std::str");
        const nonStrType = nonStrIndex >= 0 ? partTypes[nonStrIndex] : undefined;
        if (nonStrType !== undefined) {
          const offenderType = nonStrType;
          const otherType = partTypes.find((typeName, index) => index !== nonStrIndex && typeName !== undefined) ?? "std::str";
          const [leftType, rightType] = nonStrIndex === 0 ? [offenderType, otherType] : [otherType, offenderType];
          failSemantic(`operator '++' cannot be applied to operands of type '${leftType}' and '${rightType}'`);
        }
      }
      const parts = expr.parts.map((part) => compileFreeObjectExpr(part, ctx));
      // `++` over arrays yields an array, not a str — the result decoder
      // keys str-specific handling off the statement typeref, so stamping
      // std::str on an array concat would decode `[1,2,3,4]` as the string.
      const concatResultType = definedTypes.find(isArrayType) ?? "std::str";
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "++",
          args: Object.fromEntries(parts.map((part, index) => [String(index), mkCallArg(part)])),
          returning: unknownTypeRef(concatResultType),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("concat"),
        typeref: unknownTypeRef(concatResultType),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "is_type": {
      // `X IS A | B` forms a type union in type position — apply the same
      // incompatible-pointer check as a value-level union (`A union B`).
      const typeExpr = (expr as { typeExpr?: { kind?: string; left?: { name?: string }; right?: { name?: string } } }).typeExpr;
      if (typeExpr?.kind === "type_union" && typeExpr.left?.name && typeExpr.right?.name) {
        validateUnionPointerCompat(
          setFromTypeRoot(resolveTypeRef(ctx, typeExpr.left.name)),
          setFromTypeRoot(resolveTypeRef(ctx, typeExpr.right.name)),
          ctx,
        );
      }
      const left = compileFreeObjectExpr(expr.expr, ctx);
      // Collection type checks (`[5] IS (array<int64>)`) resolve statically
      // on the collection kind — the IR carries the left side's collection
      // typeref, and a value's collection kind can't vary at runtime.
      if (expr.typeName === "array" || expr.typeName === "tuple") {
        // Tuple literals carry `unknown:std::tuple` without a collection tag;
        // arrays carry `collection: "array"`.
        const leftKind = left.typeref?.collection
          ?? (left.typeref && (left.typeref.id === "unknown:std::tuple" || left.expr.kind === "tuple") ? "tuple" : undefined);
        return literalToSet(leftKind === expr.typeName);
      }
      const right = resolveTypeRef(ctx, expr.typeName);
      return {
        kind: "set",
        expr: {
          kind: "type_check_op",
          left,
          right,
          op: "is",
          typeref: unknownTypeRef("std::bool"),
        },
        pathId: defaultPathId("is_type"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "shape_projection": {
      validateShapeProjectionLinkPropContext(expr);
      // A shape applied to an arbitrary expression (e.g. `(for … union T) {
      // c := (INSERT …) }`) is a non-DML view: inline DML in a computed is
      // rejected. Check before compiling the (possibly unrelated-failing)
      // subject expression so the right error surfaces.
      for (const el of expr.shape as EdgeQLShapeElement[]) {
        if (el.kind === "computed" && !el.name.startsWith("@") && exprDefinesInlineMutation(el.expr)) {
          throw new AppError(
            "E_SEMANTIC",
            "mutations are invalid in a shape's computed expression",
            1, 1,
          );
        }
      }
      // `(GROUP … ) { key: {…}, elements: {…} }` — the trailing shape projects
      // the group result's virtual `key`/`grouping`/`elements`, which aren't
      // real pointers, so compile the group with the shape rather than running
      // the generic shape compiler against the (non-existent) members.
      if (expr.expr.kind === "group_expr") {
        return compileGroupExprSet(expr.expr, expr.shape, ctx);
      }
      const base = (() => {
        if (expr.expr.kind === "is_type") {
          const narrowedBase = compileFreeObjectExpr(expr.expr.expr, ctx);
          const narrowedType = resolveTypeRef(ctx, expr.expr.typeName);
          if (!narrowedBase.typeref.isScalar && !narrowedType.isScalar) {
            return { ...narrowedBase, typeref: narrowedType };
          }
        }
        return compileFreeObjectExpr(expr.expr, ctx);
      })();
      // `GR { … }` over a WITH-bound group (possibly through no-op select
      // wrappers, `select (select GR) {…}`): rebuild the group-rows set with
      // this projection (the subject may need extra fields for an
      // `elements: {…}` re-projection) rather than running the generic shape
      // compiler against the virtual key/grouping/elements members.
      const grouped = peelToGroupRows(base);
      if (grouped) {
        const parsed = parseProjectionWithComputedFallback(expr.shape, grouped.groupRows.projection, grouped.rows, ctx);
        // An `elements: {…}` re-projection reads fields off the materialized
        // element rows — when the already-compiled subject doesn't project
        // one of them, rebuild the group from its AST parts with the subject
        // augmented. Only then: a rebuild recompiles in THIS scope, which
        // loses bindings when the group's WITH lives on an inner subquery.
        const neededElementFields = [...parsed.needs].concat((parsed.projection ?? [])
          .flatMap((p) => {
            if (p.kind === "elements_shape") {
              return p.fields.map(elementFieldSubjectName);
            }
            if (p.kind === "element_first_path") {
              return [p.steps[0] ?? ""];
            }
            if (p.kind === "element_first_shape") {
              return p.fields;
            }
            if (p.kind === "element_agg") {
              return [p.steps[0] ?? ""];
            }
            return [];
          })
          .filter((fieldName) => fieldName.length > 0));
        const have = new globalThis.Set<string>();
        {
          let cursor: Set = grouped.groupRows.group.subject;
          for (;;) {
            for (const shapeEl of cursor.shape ?? []) {
              const elName = shapeEl.name
                ?? (shapeEl.expr.expr.kind === "pointer" ? (shapeEl.expr.expr as Pointer).ptrref.shortName : undefined);
              if (elName) have.add(elName);
            }
            if (cursor.expr.kind === "tuple") {
              for (const tupleEl of (cursor.expr as Tuple).elements) {
                if (tupleEl.name) have.add(tupleEl.name);
              }
            }
            if (cursor.expr.kind === "select_expr") {
              cursor = (cursor.expr as SelectExpr).result;
            } else if (cursor.expr.kind === "for_expr") {
              cursor = (cursor.expr as { body: Set }).body;
            } else {
              break;
            }
          }
        }
        const astParts = grouped.groupRows.astParts as GroupAstParts | undefined;
        if (astParts && neededElementFields.some((fieldName) => fieldName !== "id" && !have.has(fieldName))) {
          // Rebuilding from the AST recompiles in THIS scope — when the
          // group's WITH bindings live on an inner subquery (`X := (WITH B
          // := DETACHED User … GROUP B …)`) that fails; augment the
          // already-compiled subject's shape instead (added fields stay
          // hidden — they exist only for the computed reads).
          const rebuilt = tryResult(() => buildGroupRowsSet(astParts, expr.shape, ctx));
          // The rebuild can "succeed" with an UNLOWERABLE group when the
          // original WITH bindings are out of scope (its subject compile
          // failed quietly) — only accept a rebuild that stayed lowerable.
          const rebuiltLowerable = rebuilt.ok
            && (rebuilt.value.expr as GroupRowsExpr).group.byAtoms !== undefined
            && !(rebuilt.value.expr as GroupRowsExpr).unlowerable;
          if (rebuilt.ok && rebuiltLowerable) {
            return rebuilt.value;
          }
          const missing = neededElementFields.filter((fieldName) => fieldName !== "id" && !have.has(fieldName));
          const augmented = augmentCompiledGroupSubject(grouped.groupRows.group.subject, missing, ctx);
          if (augmented) {
            // The added fields stay VISIBLE on the materialized rows — the
            // computed projections read them off the elements JSON, which is
            // built after hidden-field stripping.
            const group = {
              ...grouped.groupRows.group,
              subject: augmented,
              expr: augmented,
            };
            const reParsed = parseProjectionWithComputedFallback(
              expr.shape,
              grouped.groupRows.projection,
              grouped.rows,
              ctx,
            );
            return {
              ...grouped.rows,
              expr: {
                ...grouped.groupRows,
                group,
                projection: reParsed.projection,
                astShape: expr.shape,
                unlowerable: grouped.groupRows.unlowerable || reParsed.unlowerable || undefined,
              } as GroupRowsExpr,
            };
          }
        }
        // A projection that re-reads element fields (`elements: {…, z := .b
        // <= 1}`) must see them on the materialized rows — un-hide any it
        // needs that BY-augmentation marked hidden (the re-projection emits
        // only the requested subset anyway).
        let group = grouped.groupRows.group;
        const hidden = group.hiddenByFields;
        if (hidden && neededElementFields.length > 0) {
          const needed = new globalThis.Set(neededElementFields);
          const kept = hidden.filter((h) => !needed.has(h));
          if (kept.length !== hidden.length) {
            group = { ...group, hiddenByFields: kept.length > 0 ? kept : undefined };
          }
        }
        return {
          ...grouped.rows,
          expr: {
            ...grouped.groupRows,
            group,
            projection: parsed.projection,
            astShape: expr.shape,
            unlowerable: grouped.groupRows.unlowerable || parsed.unlowerable || undefined,
          } as GroupRowsExpr,
        };
      }
      const projectedShape = compileShape(base, expr.shape, ctx);
      augmentGroupRowFieldShape(base, expr.shape, projectedShape);
      return {
        ...base,
        shape: projectedShape,
      };
    }

    case "and": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "and",
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("and"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "or": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "or",
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("or"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "not": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "not",
          args: { "0": mkCallArg(inner) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("not"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "literal": {
      const kind = (expr as { numericKind?: "integer" | "float" | "bigint" | "decimal" }).numericKind;
      const set = literalToSet(expr.value);
      if (typeof expr.value === "number" && kind === "float" && set.expr.kind === "integer_constant") {
        // Promote `1.0` to a float constant so `IS float64` / TYPEOF
        // inspection see the parsed lexical kind. `Number.isInteger(1.0)`
        // is true in JS, so without the numericKind hint we'd silently
        // demote whole-number floats to int64.
        return {
          ...set,
          expr: { ...set.expr, kind: "float_constant" },
        };
      }
      // `literalToSet(number)` always yields an integer/float constant, so the
      // kind checks here only serve to narrow the Expr union to BaseConstant.
      if (set.expr.kind === "integer_constant" || set.expr.kind === "float_constant") {
        if (typeof expr.value === "number" && kind === "decimal") {
          return { ...set, expr: { ...set.expr, kind: "decimal_constant" } };
        }
        if (typeof expr.value === "number" && kind === "bigint") {
          return { ...set, expr: { ...set.expr, kind: "bigint_constant" } };
        }
      }
      return set;
    }

    case "parameter": {
      const typeref = unknownTypeRef(expr.castType ?? "std::anytype");
      if (!ctx.params.has(expr.name)) {
        ctx.params.set(expr.name, {
          kind: "param",
          name: expr.name,
          required: true,
          typeref,
          schemaType: expr.castType ?? "std::anytype",
        });
      }
      return {
        kind: "set",
        expr: {
          kind: "parameter",
          name: expr.name,
          required: true,
          typeref,
        },
        pathId: defaultPathId(`param:${expr.name}`),
        typeref,
        shape: [],
        isBinding: true,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "global_ref": {
      const typeref = unknownTypeRef("std::anytype");
      if (!ctx.globals.has(expr.name)) {
        ctx.globals.set(expr.name, {
          kind: "global",
          name: expr.name,
          required: false,
          hasPresentArg: false,
          typeref,
        });
      }
      return {
        kind: "set",
        expr: {
          kind: "global_expr",
          name: expr.name,
          typeref,
        },
        pathId: defaultPathId(`global:${expr.name}`),
        typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "function_call": {
      // Compile a single call-site arg into a Set. Named args (`a := X`)
      // wrap their value in a `named_arg` envelope; peel it before compiling
      // so the inner expression is what gets lowered.
      const compileCallArg = (arg: FunctionCallArgExpr): Set => {
        if (arg && typeof arg === "object" && "kind" in arg) {
          if (arg.kind === "named_arg") return compileCallArg(arg.arg);
          if (arg.kind === "expr") {
            return compileFreeObjectExpr(arg.expr, ctx);
          }
          if (arg.kind === "parameter") {
            return compileFreeObjectExpr({ kind: "parameter", name: arg.name, castType: arg.castType }, ctx);
          }
          if (arg.kind === "literal") {
            return literalToSet(arg.value);
          }
          if (arg.kind === "field_ref") {
            return compileFreeObjectExpr({ kind: "binding_ref", name: arg.field }, ctx);
          }
          // Bare-expression args (binding_ref `Issue`, field_access `Issue.x`,
          // tuple `(a, b)`, select `(SELECT …)`, etc.) arrive here without an
          // `{kind:"expr"}` wrapper. They are themselves FreeObjectExprs and
          // must be lowered as such — otherwise we fall through to the null
          // literal and `count(Issue)` becomes count of an empty scalar set.
          return compileFreeObjectExpr(arg as FreeObjectExpr, ctx);
        }
        return literalToSet(null);
      };
      const args = expr.call.args.map(compileCallArg);
      // Preserve named-arg names: `to_duration(hours := 20)` must reach the
      // SQL lowering keyed as "hours", not by its positional index — the
      // stdlib templates dispatch on parameter names. Positional args keep
      // their numeric keys (orderedCallArgs sorts numerics first).
      const argKeys = expr.call.args.map((arg, index) =>
        arg && typeof arg === "object" && "kind" in arg && arg.kind === "named_arg"
          ? arg.name
          : String(index));
      // Inline expr-body UDFs at AST→IR time so the SQL compiler can lower
      // the call as if the body were written inline (substituting parameter
      // references with the actual argument expressions). Falls back to a
      // body-less function_call IR when the function isn't a known UDF or
      // the body shape isn't supported — the runtime path picks that up.
      const inlinedBody = tryBuildInlinedUDFBody(expr.call.name, expr.call.args, ctx);
      // Object-returning UDFs: substitute the inlined body Set directly so
      // every downstream consumer (pointer chains `foo(1).a`, shapes,
      // EXISTS, DML wrappers) sees an ordinary object set — the
      // function_call envelope is only understood by the scalar value
      // lowering.
      if (inlinedBody && !inlinedBody.typeref.isScalar && inlinedBody.typeref.inSchema) {
        return inlinedBody;
      }
      // Use the inferred return type so downstream type-check operations
      // (`X IS float64`, `INTROSPECT TYPEOF X`) can resolve common stdlib
      // function results instead of seeing `std::anytype`. Falls back to
      // anytype when we don't know the function's return shape.
      const inferredReturnTypeName = inferAstExprTypeName(expr, ctx);
      // If the inferred return type names a schema object type (e.g.
      // `assert_single(SELECT User …)` → User), build a full type ref so a
      // trailing shape resolves its pointers against the real type rather
      // than an unqualified `unknown:User` the shape compiler can't find.
      const inferredObjectType = inferredReturnTypeName
        && !inferredReturnTypeName.startsWith("array<")
        && !inferredReturnTypeName.startsWith("tuple<")
        ? getSchemaType(ctx, inferredReturnTypeName)
        : undefined;
      const callTyperef = inferredObjectType
        ? typeRefFromTypeDef(ctx, inferredObjectType)
        : inferredReturnTypeName && isUniversalObjectRefName(inferredReturnTypeName)
        ? universalObjectTypeRef(ctx, inferredReturnTypeName)
        : inferredReturnTypeName
        ? unknownTypeRef(inferredReturnTypeName)
        : unknownTypeRef("std::anytype");
      return {
        kind: "set",
        expr: {
          kind: "function_call",
          functionName: expr.call.name,
          args: Object.fromEntries(args.map((arg, index) => [argKeys[index], mkCallArg(arg)])),
          volatility: "stable",
          typeref: callTyperef,
          preservesUpperCardinality: false,
          body: inlinedBody,
          extras: {
            backendName: expr.call.name,
            funcPolymorphic: false,
          },
        },
        pathId: defaultPathId(`fn:${expr.call.name}`),
        typeref: callTyperef,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "coalesce": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "coalesce_expr",
          left,
          right,
        } as CoalesceExpr,
        pathId: defaultPathId("std::coalesce"),
        typeref: left.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "if_else": {
      const condition = compileFreeObjectExpr(expr.condition, ctx);
      const ifExpr = compileFreeObjectExpr(expr.thenExpr, ctx);
      const elseExpr = compileFreeObjectExpr(expr.elseExpr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "if_else_expr",
          condition,
          ifExpr,
          elseExpr,
        } as IfElseExpr,
        pathId: defaultPathId("std::if_else"),
        typeref: ifExpr.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "compare": {
      // Reject incompatible-type comparisons (`<int64>1 = <str>'a'`, etc.) so
      // they raise "operator 'X' cannot be applied to operands of type 'Y' and
      // 'Z'" rather than silently returning false from SQLite.
      const leftType = inferAstExprTypeName(expr.left, ctx);
      const rightType = inferAstExprTypeName(expr.right, ctx);
      if (leftType && rightType && !areCompareCompatible(leftType, rightType)) {
        failSemantic(
          `operator '${expr.op}' cannot be applied to operands of type '${leftType}' and '${rightType}'`,
        );
      }
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::compare"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "in_expr": {
      // Unwrap `<T>{...}` casts wrapping a set literal so the empty-set
      // identity / OR-chain reduction below still applies. `<int64>{}` is
      // semantically the empty set of int64s, which `IN` evaluates to
      // FALSE / NOT IN to TRUE.
      let rhs: FreeObjectExpr = expr.right;
      while (rhs.kind === "cast") {
        rhs = (rhs as { expr: FreeObjectExpr }).expr;
      }
      const members = rhs.kind === "set_literal"
        ? rhs.values.map((value): FreeObjectExpr => ({ kind: "literal", value }))
        : rhs.kind === "set_expr"
          ? rhs.values
          : undefined;
      if (members) {
        const lhsIsSet = expr.left.kind === "set_expr" || expr.left.kind === "set_literal";
        if (members.length === 0) {
          // `1 IN {}` is vacuously false; `1 NOT IN {}` is vacuously true.
          // When the LHS is a set, the result is a set of per-element bools;
          // fall through to the operator_call path so SQL emits one row per
          // element of the LHS instead of collapsing to a single literal.
          if (!lhsIsSet) {
            return compileFreeObjectExpr({ kind: "literal", value: expr.op === "not_in" }, ctx);
          }
          // else fall through to operator_call below
        } else if (!lhsIsSet) {
          const orChain: FreeObjectExpr = members.reduceRight((acc, value, idx) => {
            const eq: FreeObjectExpr = { kind: "compare", op: "=", left: expr.left, right: value };
            return idx === members.length - 1 ? eq : { kind: "or", left: eq, right: acc };
          }, undefined as unknown as FreeObjectExpr);
          const result: FreeObjectExpr = expr.op === "not_in" ? { kind: "not", expr: orChain } : orChain;
          return compileFreeObjectExpr(result, ctx);
        }
      }
      // Singleton-RHS form (array literal, tuple, scalar): `A IN B` → `A = B`.
      const singletonRhs = expr.right.kind === "array_literal_expr"
        || expr.right.kind === "tuple"
        || expr.right.kind === "literal"
        || expr.right.kind === "cast";
      if (singletonRhs) {
        const compareOp = expr.op === "in" ? "=" : "!=";
        return compileFreeObjectExpr(
          { kind: "compare", op: compareOp, left: expr.left, right: expr.right },
          ctx,
        );
      }
      // Path/binding RHS form (`X IN Y` where Y is a set produced by a path,
      // binding, or subquery): build an `operator_call` IR node so the SQL
      // compiler — which already handles `in`/`not in` over compiled value
      // SELECTs — can lower it as `(<left> IN (<right>))`.
      const leftSet = compileFreeObjectExpr(expr.left, ctx);
      const rightSet = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op === "in" ? "in" : "not in",
          args: { "0": mkCallArg(leftSet), "1": mkCallArg(rightSet) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId(`std::${expr.op}`),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "logical": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::logical"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "unary": {
      // Fold `-NUMBER` / `+NUMBER` into a single numeric constant so
      // downstream SQL lowering doesn't need to handle an operator_call(neg).
      if (expr.op === "neg" && expr.expr.kind === "literal") {
        const value = expr.expr.value;
        if (typeof value === "number") {
          const folded = expr.op === "neg" ? -value : value;
          return compileFreeObjectExpr({ kind: "literal", value: folded } as typeof expr.expr, ctx);
        }
      }
      // Reject unary -/+/NOT on operands whose declared type cannot accept it,
      // matching EdgeQL's "operator 'X' cannot ... 'std::Y'" error.
      const innerTypeName = inferAstExprTypeName(expr.expr, ctx);
      if (innerTypeName) {
        // Unary nodes only carry op "neg" | "not" — the parser never emits a
        // "pos" node (unary `+` is absorbed during parsing), so the former
        // `op === "pos"` branch here was dead and has been removed.
        if (expr.op === "neg" && !canApplyUnaryArith(innerTypeName)) {
          failSemantic(`operator '-' cannot be applied to operand of type '${innerTypeName}'`);
        }
        if (expr.op === "not" && innerTypeName !== "std::bool") {
          failSemantic(`operator 'NOT' cannot be applied to operand of type '${innerTypeName}'`);
        }
      }
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(inner) },
          returning: expr.op === "not" ? unknownTypeRef("std::bool") : inner.typeref,
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::unary"),
        typeref: expr.op === "not" ? unknownTypeRef("std::bool") : inner.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "math": {
      // Reject incompatible-type arithmetic (`<int64>1 + <str>'a'`, etc.) so it
      // raises "operator 'X' cannot be applied to operands of type 'Y' and 'Z'"
      // rather than silently coercing in SQLite.
      const mathLeftType = inferAstExprTypeName(expr.left, ctx);
      const mathRightType = inferAstExprTypeName(expr.right, ctx);
      if (mathLeftType && mathRightType && !areArithCompatible(mathLeftType, mathRightType)) {
        // Math AST nodes already carry the operator symbol (`+`, `-`, …); no
        // producer emits word-form ops ("add"/"sub"/…), so the former
        // word→symbol mapping here was dead and has been removed.
        const opSym = expr.op;
        failSemantic(
          `operator '${opSym}' cannot be applied to operands of type '${mathLeftType}' and '${mathRightType}'`,
        );
      }
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      // Use the AST-level numeric promotion so `INTROSPECT TYPEOF(a + b)`
      // and `a + b IS T` see the promoted result type instead of `left`'s.
      const promotedTypeName = inferAstExprTypeName(expr, ctx);
      const promotedTyperef = promotedTypeName ? unknownTypeRef(promotedTypeName) : left.typeref;
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: promotedTyperef,
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::math"),
        typeref: promotedTyperef,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "for_expr": {
      if (
        expr.variable === "__gel_backlink_item__"
        && expr.body.kind === "backlink_path"
        && expr.iterator.kind === "binding_ref"
      ) {
        const enumType = lookupEnumScalar(ctx, expr.iterator.name);
        if (enumType) {
          failSemantic("enum types do not support backlink");
        }
      }
      if (
        expr.variable === "__gel_backlink_item__"
        && expr.body.kind === "backlink_path"
        && !expr.filter
        && !expr.orderBy
        && expr.limit === undefined
        && expr.offset === undefined
      ) {
        const iterator = compileFreeObjectExpr(expr.iterator, ctx);
        // A TYPED backlink off group-rows elements
        // (`X.elements.<friends[is User]`) rewrites to the equivalent
        // correlated membership select — `select User filter .friends.id in
        // X.elements.id` — which the SQL stage already lowers (json_each
        // rows on the RHS of IN).
        {
          let elemCursor: Set = iterator;
          while (elemCursor.expr.kind === "select_expr") {
            elemCursor = (elemCursor.expr as SelectExpr).result;
          }
          const elemField = elemCursor.expr.kind === "group_row_field" ? elemCursor.expr as GroupRowFieldExpr : undefined;
          if (elemField && elemField.steps[0] === "elements" && elemField.steps.length === 1 && expr.body.sourceType) {
            const targetTyperef = resolveTypeRef(ctx, expr.body.sourceType);
            const linkPtr = targetTyperef && !targetTyperef.id.startsWith("unknown:")
              ? resolvePointerRef(ctx, targetTyperef, expr.body.link)
              : undefined;
            if (targetTyperef && linkPtr && !linkPtr.outTarget.isScalar) {
              const root = setFromTypeRoot(targetTyperef);
              const linkSet = extendPathSet(root, linkPtr);
              const idPtr = resolvePointerRef(ctx, linkPtr.outTarget, "id");
              const lhs = idPtr ? extendPathSet(linkSet, idPtr) : undefined;
              const rhs = tryExtendGroupRowFieldPath(iterator, "id");
              if (lhs && rhs) {
                const where: Set = {
                  kind: "set",
                  expr: {
                    kind: "operator_call",
                    operator: "in",
                    args: { "0": mkCallArg(lhs), "1": mkCallArg(rhs) },
                    returning: unknownTypeRef("std::bool"),
                    volatility: "stable",
                  } as OperatorCall,
                  pathId: defaultPathId("group_backlink_in"),
                  typeref: unknownTypeRef("std::bool"),
                  shape: [],
                  isBinding: false,
                  isMaterializedRef: false,
                  isSchemaAlias: false,
                };
                return {
                  kind: "set",
                  expr: {
                    kind: "select_expr",
                    result: root,
                    where,
                    implicitWrapper: false,
                  } as SelectExpr,
                  pathId: defaultPathId(`group_backlink:${expr.body.link}`),
                  typeref: targetTyperef,
                  shape: [],
                  isBinding: false,
                  isMaterializedRef: false,
                  isSchemaAlias: false,
                };
              }
            }
          }
        }
        // Untyped backlinks off group-rows elements (`g.elements.<owner`)
        // can't be read off the row JSON — record a marked group_row_field
        // step so the SQL stage bails and the runtime FOR-group executor
        // runs it.
        const groupBacklink = tryExtendGroupRowFieldPath(iterator, expr.body.link, "inbound");
        if (groupBacklink) {
          return groupBacklink;
        }
        const ptrref = resolveBacklinkPointerRef(ctx, iterator.typeref, expr.body.link, expr.body.sourceType);
        if (ptrref) {
          const out = extendPathSetDirectional(iterator, ptrref, "inbound");
          return expr.body.optional
            ? {
                ...out,
                expr: {
                  ...(out.expr as Pointer),
                  optionalDeref: true,
                },
              }
            : out;
        }
      }
      let rawIterator = compileFreeObjectExpr(expr.iterator, ctx);
      // `FOR g IN (GROUP …)` whose body reads element fields the subject
      // doesn't project (`g.elements.name` over a bare `GROUP Card`):
      // rebuild the group with those fields added to the subject so the SQL
      // stage can read them off each element row.
      {
        const grouped = peelToGroupRows(rawIterator);
        const astParts = grouped?.groupRows.astParts as GroupAstParts | undefined;
        if (grouped && astParts) {
          const needed = collectForBodyElementFields(expr.body, expr.variable);
          const have = collectGroupSubjectFieldNames(grouped.groupRows.group.subject);
          const missing = [...needed].filter((name) => name !== "id" && !have.has(name));
          if (missing.length > 0) {
            const astShape = grouped.groupRows.astShape as EdgeQLShapeElement[] | undefined;
            const rebuilt = tryResult(() => buildGroupRowsSet(astParts, astShape, ctx, missing));
            if (rebuilt.ok) rawIterator = rebuilt.value;
          }
        }
      }
      // Namespace the iterator's pathId so the body can distinguish references
      // to the iteration binding (e.g. `C`) from fresh references to the same
      // type (e.g. `Card`) — without this, both produce identical pathIds and
      // the SQL compiler can't tell them apart for cross-product semantics.
      const iterScopeTag = `for:${expr.variable}:${ctx.nextScopeId++}`;
      const iterator: Set = {
        ...rawIterator,
        pathId: {
          ...rawIterator.pathId,
          namespace: [...(rawIterator.pathId?.namespace ?? []), iterScopeTag],
        },
      };
      const loopCtx = childScope(ctx);
      bindValue(loopCtx, expr.variable, iterator);
      const body = compileFreeObjectExpr(expr.body, loopCtx);
      return {
        kind: "set",
        expr: {
          kind: "for_expr",
          iterator,
          body,
          bindingKind: "with",
          optional: expr.optional ?? false,
          where: expr.filter ? compileFreeObjectExpr(expr.filter, loopCtx) : undefined,
          orderBy: expr.orderBy
            ? [{ kind: "sort_expr", path: compileFreeObjectExpr(expr.orderBy.expr, loopCtx), direction: expr.orderBy.direction, nonesOrder: "last" }]
            : undefined,
          offset: expr.offset === undefined ? undefined : literalToSet(expr.offset),
          limit: expr.limit === undefined ? undefined : literalToSet(expr.limit),
        } as ForExpr,
        pathId: defaultPathId(`for:${expr.variable}`),
        typeref: body.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "cast": {
      const innerExpr = expr.expr;
      const innerIsJsonCast = innerExpr.kind === "cast" && innerExpr.castType === "json";
      const enumTarget = lookupEnumScalar(ctx, expr.castType);

      if (enumTarget) {
        const sourceExpr = innerIsJsonCast ? (innerExpr as { kind: "cast"; castType: string; expr: FreeObjectExpr }).expr : innerExpr;
        const innerSet = compileFreeObjectExpr(sourceExpr, ctx);
        if (innerIsJsonCast) {
          const innerLiteral = tryExtractAnyConstant(innerSet);
          if (innerLiteral !== undefined && typeof innerLiteral.value !== "string") {
            failSemantic(`expected JSON string or null; got JSON ${jsonTypeNameForLiteral(innerLiteral.value)}`);
          }
        }
        return compileEnumCast(ctx, enumTarget.qualifiedName, enumTarget.members, innerSet);
      }

      if (expr.castType === "json") {
        const innerSet = compileFreeObjectExpr(innerExpr, ctx);
        const values = tryExtractSetOfStringConstants(innerSet);
        if (values !== undefined) {
          const encoded = values.map((value) => enumLiteralSet(jsonEncodeString(value)));
          return compileSetConstructor(encoded, "json_string_cast");
        }
      }

      if (expr.castType === "str") {
        const innerSet = compileFreeObjectExpr(innerExpr, ctx);
        const literal = tryExtractStringConstant(innerSet);
        if (literal !== undefined) return enumLiteralSet(literal);
        // Fall through to the generic type_cast emission below so the SQL
        // pipeline produces a real `CAST(<inner> AS TEXT)` wrapper; otherwise
        // an int-valued inner survives unchanged and the runtime ends up
        // formatting it via SQLite's default REAL coercion (e.g. `99` →
        // `'99.0'`).
      }

      if (expr.castType === "datetime") {
        const innerSet = compileFreeObjectExpr(innerExpr, ctx);
        const literal = tryExtractStringConstant(innerSet);
        if (literal !== undefined) {
          const normalized = normalizeDateTimeLiteral(literal);
          // Keep the datetime typeref on the folded constant — the client
          // result codec keys value conversion off it.
          if (normalized !== undefined) {
            return { ...enumLiteralSet(normalized), typeref: unknownTypeRef("std::datetime") };
          }
        }
      }

      // Duration literals fold to Gel's canonical ISO form ('PT24H',
      // 'P11M20D') — equality, ordering, and result serialization all
      // operate on the canonical text.
      if (expr.castType === "duration" || expr.castType === "relative_duration"
          || expr.castType === "date_duration"
          || expr.castType === "cal::relative_duration" || expr.castType === "cal::date_duration") {
        const innerSet = compileFreeObjectExpr(innerExpr, ctx);
        const literal = tryExtractStringConstant(innerSet);
        if (literal !== undefined) {
          const exact = expr.castType === "duration";
          const normalized = normalizeDurationLiteral(literal, exact);
          if (normalized !== undefined) {
            const typeName = expr.castType === "duration"
              ? "std::duration"
              : expr.castType.includes("date_duration") ? "cal::date_duration" : "cal::relative_duration";
            return { ...enumLiteralSet(normalized), typeref: unknownTypeRef(typeName) };
          }
        }
      }

      const inner = compileFreeObjectExpr(innerExpr, ctx);
      // `<optional T>$0` — the cardinality modifier makes the parameter accept
      // the empty set. Mark the underlying parameter (and its registered
      // binding) optional so SQL lowering drops a missing/NULL arg to zero
      // rows instead of emitting a NULL-valued row.
      if (expr.optional && inner.expr.kind === "parameter") {
        (inner.expr as { required: boolean }).required = false;
        const paramDef = ctx.params.get((inner.expr as { name: string }).name);
        if (paramDef) (paramDef as { required: boolean }).required = false;
      }
      const toType = resolveTypeRef(ctx, expr.castType);
      return {
        kind: "set",
        expr: {
          kind: "type_cast",
          fromType: inner.typeref,
          toType,
          expr: inner,
        },
        pathId: defaultPathId(`cast:${expr.castType}`),
        typeref: toType,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "type_intersection": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        ...inner,
        typeref: resolveTypeRef(ctx, expr.sourceType),
      };
    }

    case "field_suffix_math": {
      // Desugar the parser's `<const> <op> <int64>.field[-fromEnd]` shorthand
      // (e.g. `100 - <int64>.val[-1]`) into the equivalent arithmetic over the
      // field, so it computes instead of collapsing to the bare field / NULL.
      // The parser only emits `field_suffix_math` with op "const_minus" or
      // "negate"; the former "const_plus"/"const_mul"/"const_div" branches
      // were dead and have been removed.
      const opSymbol = expr.op === "const_minus" ? "-" : undefined;
      const current = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      if ((opSymbol !== undefined || expr.op === "negate") && current) {
        const indexed: FreeObjectExpr = {
          kind: "index_access",
          expr: { kind: "field_access", expr: { kind: "current_item" }, field: expr.field, optional: false },
          index: -expr.fromEnd,
        } as FreeObjectExpr;
        const casted: FreeObjectExpr = { kind: "cast", castType: "int64", expr: indexed } as FreeObjectExpr;
        if (expr.op === "negate") {
          // `-<int64>.field[-fromEnd]` — negation, expressed as `0 - digit`
          // since the SQL layer lowers binary `-` but not a unary neg operator.
          return compileFreeObjectExpr({
            kind: "math",
            op: "-",
            left: { kind: "literal", value: 0 },
            right: casted,
          } as FreeObjectExpr, ctx);
        }
        return compileFreeObjectExpr({
          kind: "math",
          op: opSymbol,
          left: { kind: "literal", value: expr.constant },
          right: casted,
        } as FreeObjectExpr, ctx);
      }
      const resolved = resolveBinding(ctx, expr.field);
      if (resolved) {
        return resolved;
      }
      return literalToSet(null);
    }

    case "select_expr": {
      // `WITH z := (...) <expr>` written inside a computed — the bindings
      // ride on the wrapper's clauses.
      const innerCtx = (expr as { clauses?: { _withBindings?: WithBinding[] } }).clauses?._withBindings
        ? withBindings(ctx, (expr as { clauses?: { _withBindings?: WithBinding[] } }).clauses?._withBindings)
        : ctx;
      const inner = compileFreeObjectExpr(expr.expr, innerCtx);
      const clauses = (expr as { clauses?: { filter?: FreeObjectExpr; orderBy?: OrderExpr; limit?: number; offset?: number } }).clauses;
      if (!clauses?.filter && !clauses?.orderBy && clauses?.limit === undefined && clauses?.offset === undefined) {
        return inner;
      }
      const clauseCtx = childScope(innerCtx);
      bindValue(clauseCtx, "__current__", inner);
      bindValue(clauseCtx, "__subject__", inner);
      return {
        kind: "set",
        expr: {
          kind: "select_expr",
          result: inner,
          where: clauses.filter ? compileFreeObjectExpr(clauses.filter, clauseCtx) : undefined,
          orderBy: clauses.orderBy ? compileSelectOrderExprChain(clauses.orderBy, clauseCtx) : undefined,
          offset: clauses.offset === undefined ? undefined : literalToSet(clauses.offset),
          limit: clauses.limit === undefined ? undefined : literalToSet(clauses.limit),
          implicitWrapper: false,
        },
        pathId: defaultPathId("select_expr"),
        typeref: inner.typeref,
        shape: inner.shape,
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "array_literal_expr": {
      const values = expr.values.map((value) => compileFreeObjectExpr(value, ctx));
      const elementType = values[0]?.typeref ?? { id: "std::anytype", nameHint: "anytype", module: "std", isView: false, isScalar: false, isAbstract: false } as TypeRef;
      const arrayTypeRef: TypeRef = {
        kind: "type_ref",
        id: `array<${elementType.id}>`,
        nameHint: `array<${elementType.nameHint}>`,
        module: "std",
        isView: false,
        isScalar: false,
        isAbstract: false,
        collection: "array",
        subtypes: [elementType],
      };
      return {
        kind: "set",
        expr: {
          kind: "array",
          elements: values,
          typeref: arrayTypeRef,
        },
        pathId: defaultPathId("array_literal"),
        typeref: arrayTypeRef,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "mutation_expr": {
      // Parser wraps `(delete X filter …)` / `(insert X …)` / `(update X …)`
      // when they appear in expression positions (e.g. as a FOR iterator).
      // Lower to the value-level mutation expr Set so callers can treat
      // it like any other set producer.
      const stmt = expr.statement;
      const scoped = withBindings(ctx, stmt.with);
      if (stmt.kind === "delete") {
        const typeref = resolveTypeRef(scoped, stmt.typeName);
        const subject = setFromTypeRoot(typeref);
        bindValue(scoped, "__subject__", subject);
        bindValue(scoped, "__current__", subject);
        const where = compileFilterToSet(stmt.filter, subject, scoped);
        return {
          kind: "set",
          expr: {
            kind: "delete_expr",
            subject: typeref,
            where,
          } as DeleteExpr,
          pathId: defaultPathId(`delete:${stmt.typeName}`),
          typeref,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        };
      }
      if (stmt.kind === "insert") {
        const typeref = resolveSubjectTypeRef(scoped, stmt.typeName);
        const subjectSet = setFromTypeRoot(typeref);
        bindValue(scoped, "__subject__", subjectSet);
        bindValue(scoped, "__current__", subjectSet);
        const shape: ShapeElement[] = Object.entries(stmt.values).map(([name, value]) => {
          const ptrref = resolvePointerRef(scoped, typeref, name);
          const exprSet = compileInsertValue(value, scoped);
          return {
            kind: "shape_element",
            source: subjectSet,
            expr: exprSet,
            targetPtr: ptrref,
            shapeOp: "assign",
            shapeOrigin: "explicit",
            required: ptrref?.outCardinality === "one",
            cardinality: ptrref?.outCardinality ?? "unknown",
          };
        });
        return {
          kind: "set",
          expr: { kind: "insert_expr", subject: typeref, shape } as InsertExpr,
          pathId: defaultPathId(`insert:${stmt.typeName}`),
          typeref,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        };
      }
      if (stmt.kind === "update") {
        const typeref = resolveSubjectTypeRef(scoped, stmt.typeName);
        const subjectSet = setFromTypeRoot(typeref);
        bindValue(scoped, "__subject__", subjectSet);
        bindValue(scoped, "__current__", subjectSet);
        const shape: ShapeElement[] = Object.entries(stmt.values).map(([name, value]) => {
          const ptrref = resolvePointerRef(scoped, typeref, name);
          return {
            kind: "shape_element",
            source: subjectSet,
            expr: compileInsertValue(value, scoped),
            targetPtr: ptrref,
            shapeOp: stmt.operations?.[name] ?? "assign",
            shapeOrigin: "explicit",
            required: ptrref?.outCardinality === "one",
            cardinality: ptrref?.outCardinality ?? "unknown",
          };
        });
        const where = compileFilterToSet(stmt.filter, subjectSet, scoped);
        return {
          kind: "set",
          expr: { kind: "update_expr", subject: typeref, where, shape } as UpdateExpr,
          pathId: defaultPathId(`update:${stmt.typeName}`),
          typeref,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        };
      }
      throw new AppError("E_RUNTIME", `AST->IR mutation kind '${(stmt as { kind: string }).kind}' not supported in expression position`, 1, 1);
    }

    case "introspect_typeof": {
      // `INTROSPECT TYPEOF expr` resolves to the schema type of `expr`. We
      // don't model schema::Type fully, but the only test patterns we see
      // ultimately read `.name` off the result. Build a synthetic set whose
      // shape exposes `name` as a string literal carrying the inferred type
      // — the shape lookup in field_access surfaces it as the answer to
      // `(INTROSPECT TYPEOF x).name`. Falling back to `anytype` keeps the
      // shape consistent when type inference is incomplete; the test
      // harness still compares strings.
      let typeName = inferAstExprTypeName(expr.expr, ctx);
      if (!typeName && expr.expr.kind === "binding_ref") {
        // Resolve the binding's compiled set typeref so
        // `WITH A := {1.0, 2.0}; INTROSPECT TYPEOF A` sees float64 instead
        // of anytype.
        const bound = resolveBinding(ctx, expr.expr.name);
        if (bound) {
          const id = bound.typeref?.id ?? bound.typeref?.nameHint;
          const stripped = id?.startsWith("unknown:") ? id.slice("unknown:".length) : id;
          if (stripped) typeName = stripped;
        }
      }
      typeName = typeName ?? "std::anytype";
      const typeref = unknownTypeRef("schema::Type");
      const nameSet = literalToSet(typeName);
      const root: Set = {
        kind: "set",
        expr: { kind: "type_root", typeref } as TypeRoot,
        pathId: defaultPathId("introspect_typeof"),
        typeref,
        shape: [
          {
            kind: "shape_element",
            source: { kind: "set", expr: { kind: "type_root", typeref } as TypeRoot, pathId: defaultPathId("introspect_typeof"), typeref, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false },
            expr: nameSet,
            shapeOp: "assign",
            shapeOrigin: "explicit",
            required: true,
            cardinality: "one",
            name: "name",
          },
        ],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
      return root;
    }

    case "set_op": {
      // `intersect`/`except` lower into operator_call nodes the SQL compiler
      // recognises (it already handles `union` similarly). Building the IR
      // here at least lets these queries reach the SQL layer rather than
      // throwing during AST→IR.
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      // No `op === "union"` handling here: the parser lowers `a UNION b` to a
      // `set_expr` node (see parseFreeObjectSetOpExpr), so `set_op` only ever
      // carries "intersect" | "except" — the union branch was dead.
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: left.typeref,
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId(`set_op:${expr.op}`),
        typeref: left.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "group_expr": {
      // `(GROUP <subject> BY <key>)` in expression position with no trailing
      // shape — emits the full default group row (`key` + `grouping` +
      // `elements`). A trailing `{ … }` shape is handled by the
      // `shape_projection` case, which routes here with the shape.
      return compileGroupExprSet(expr, undefined, ctx);
    }

    default:
      throw new AppError("E_RUNTIME", `AST->IR is not implemented yet for '${expr.kind}'`, 1, 1);
  }
};

const compileOrderBy = (statement: Extract<EdgeQLStatement, { kind: "select_expr" }>, ctx: IRCompileContext): SortExpr[] | undefined => {
  if (!statement.orderBy) {
    return undefined;
  }
  return compileOrderExprChain(statement.orderBy, ctx);
};

const compileOrderExprChain = (orderBy: OrderExprChain, ctx: IRCompileContext): SortExpr[] => {
  const out: SortExpr[] = [];
  let cursor: OrderExprChain | undefined = orderBy;
  while (cursor) {
    out.push({
      kind: "sort_expr",
      path: compileFreeObjectExpr(cursor.expr, ctx),
      direction: cursor.direction,
      nonesOrder: cursor.nullsPosition ?? (cursor.direction === "desc" ? "last" : "first"),
    });
    cursor = cursor.then;
  }
  return out;
};

const compileSelectOrderExprChain = (orderBy: OrderExpr, ctx: IRCompileContext): SortExpr[] => {
  const out: SortExpr[] = [];
  let cursor: OrderExpr | undefined = orderBy;
  while (cursor) {
    out.push({
      kind: "sort_expr",
      path: cursor.expr
        ? compileFreeObjectExpr(cursor.expr, ctx)
        : compileFreeObjectExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__current__" }, field: cursor.field, optional: false }, ctx),
      direction: cursor.direction,
      nonesOrder: cursor.nullsPosition ?? (cursor.direction === "desc" ? "last" : "first"),
    });
    cursor = cursor.then;
  }
  return out;
};

const statementBase = (ctx: IRCompileContext) => ({
  scopeTree: createRootScope(),
  views: {},
  params: [...ctx.params.values()],
  globals: [...ctx.globals.values()],
  requiredPermissions: [],
  serverParamConversions: [],
  serverParamConversionParams: [],
  cardinality: defaultCardinality,
  multiplicity: defaultMultiplicity,
  volatility: defaultVolatility,
  viewShapes: {},
  viewShapesMetadata: {},
  schemaRefs: [],
  dmlExprs: [],
  typeRewrites: {},
  singletons: [],
  triggers: [],
  warnings: [],
  unsafeIsolationDangers: [],
});

// Resolve a written path root (`I2` / `Issue` / `User`) plus dotted segments
// to a pointer-chain Set. The root may be a WITH binding or a type name; when
// it isn't resolvable (or a segment is missing) returns undefined so callers
// keep their legacy subject-anchored behaviour.
const tryCompileRootedFieldPath = (
  root: string,
  field: string,
  ctx: IRCompileContext,
): Set | undefined => {
  let out = resolveBinding(ctx, root);
  if (!out) {
    const typeref = resolveTypeRef(ctx, root);
    if (!typeref || typeref.id.startsWith("unknown:")) return undefined;
    out = setFromTypeRoot(typeref);
  }
  for (const segment of field.split(".")) {
    const ptrref = resolvePointerRef(ctx, out.typeref, segment);
    if (!ptrref) {
      const computedSet = tryLowerComputedPropertyOnTypePath(ctx, out, segment);
      if (!computedSet) return undefined;
      out = computedSet;
      continue;
    }
    out = extendPathSetDirectional(
      out,
      ptrref,
      ptrref.computedLinkAliasIsBackward ? "inbound" : "outbound",
    );
  }
  return out;
};

const compileFilterValue = (value: FilterValue, ctx: IRCompileContext): Set => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return literalToSet(value);
  }
  if (value.kind === "binding_ref") {
    return compileFreeObjectExpr({ kind: "binding_ref", name: value.name }, ctx);
  }
  if (value.kind === "field_ref") {
    if (value.root) {
      const rooted = tryCompileRootedFieldPath(value.root, value.field, ctx);
      if (rooted) return rooted;
    }
    return compileFreeObjectExpr({ kind: "binding_ref", name: value.field }, ctx);
  }
  if (value.kind === "set_literal") {
    return literalToSet(value.values.length);
  }
  return literalToSet(null);
};

const compileFilterTarget = (target: FilterTarget, subject: Set, ctx: IRCompileContext): Set => {
  if (target.kind === "field") {
    // `FILTER .__type__.name = '…'` — compares the row's concrete type. For a
    // source spanning multiple concrete types (subtypes or a union) this must
    // read the dynamic `__source_type` column, not a static parent-type
    // literal (which would match every subtype row). Mark the set so SQL emits
    // `<alias>.__source_type`.
    if (target.field === "__type__.name") {
      const isUnion = subject.typeref.id.includes("|");
      const hasSubtypes = !subject.typeref.id.startsWith("unknown:")
        && (ctx.schema?.listConcreteTypesAssignableTo(subject.typeref.id).length ?? 0) > 1;
      if (isUnion || hasSubtypes) {
        return { ...literalToSet(subject.typeref.id), dynamicTypeName: true } as Set;
      }
      return literalToSet(subject.typeref.id);
    }
    // The written path carried an explicit root (`I2.priority.name`). When it
    // names a WITH binding, or a type other than the subject's, anchor the
    // path THERE — collapsing to the subject would conflate `I2` with the
    // iteration row. Paths rooted at the subject's own type keep the legacy
    // subject-anchored lowering below.
    if ("root" in target && target.root) {
      const rootBinding = resolveBinding(ctx, target.root);
      const rootType = rootBinding ? undefined : resolveTypeRef(ctx, target.root);
      const sameAsSubject = !rootBinding
        && (!rootType || rootType.id.startsWith("unknown:") || rootType.id === subject.typeref.id);
      if (!sameAsSubject) {
        const rooted = tryCompileRootedFieldPath(target.root, target.field, ctx);
        if (rooted) return rooted;
      }
    }
    // A bare leading identifier (no leading dot) that names a WITH binding is a
    // free reference to that binding's value — `WITH x := '010' … FILTER x IN
    // {…}` compares the literal `x`, not an implicit `.x` on the subject.
    // Without this, the binding lookup below only suppresses the "no such
    // property" error and the target silently collapses to the subject set.
    if ("bareName" in target && target.bareName) {
      const segments = target.field.split(".");
      const first = segments[0];
      const bound = first === "__current__" || first === "__subject__"
        ? undefined
        : resolveBinding(ctx, first);
      if (bound) {
        let result = bound;
        for (let i = 1; i < segments.length; i++) {
          const ptrref = resolvePointerRef(ctx, result.typeref, segments[i]);
          if (!ptrref) {
            break;
          }
          result = extendPathSet(result, ptrref);
        }
        return result;
      }
    }
    // `FILTER number = …` (no leading dot) — EdgeQL treats this as a free
    // reference to a type/alias named "number", not as an implicit field on
    // the subject. If the parser tagged it bareName and we can confirm no
    // such type/alias/binding exists, surface the friendlier EdgeQL error.
    if ("bareName" in target && target.bareName && !target.field.includes(".")) {
      const name = target.field;
      if (
        !resolveBinding(ctx, name)
        && ctx.schema
      ) {
        const qualified = qualifyTypeName(name, ctx.module);
        const typeDef = getSchemaType(ctx, qualified) ?? ctx.schema.getType(qualified);
        if (!typeDef && !isUniversalObjectRefName(name)) {
          throw new AppError(
            "E_SEMANTIC",
            `object type or alias '${qualified}' does not exist`,
            1,
            1,
          );
        }
      }
    }
    const segments = target.field.split(".");
    let result = subject;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const ptrref = resolvePointerRef(ctx, result.typeref, segment);
      if (!ptrref) {
        // `.field` against a known schema type — surface the "no link or
        // property" error so typos in FILTER don't silently match nothing.
        // Skip when this is the leading segment and the name happens to
        // alias a known type/binding (`FILTER User = Issue.watchers`).
        const isLeading = i === 0;
        const aliasedToBinding = isLeading && resolveBinding(ctx, segment);
        const aliasedToType = isLeading && ctx.schema && (getSchemaType(ctx, segment) ?? ctx.schema.getType(qualifyTypeName(segment, ctx.module)));
        if (
          ctx.schema
          && !aliasedToBinding
          && !aliasedToType
          && segment !== "id"
          && segment !== "__type__"
          && !segment.startsWith("@")
          && !result.typeref.id.startsWith("unknown:")
          && !result.typeref.id.startsWith("std::")
          && !result.typeref.isScalar
          && getResolvedSchemaType(ctx, result.typeref.id)
        ) {
          throw new AppError(
            "E_SEMANTIC",
            `object type '${result.typeref.id}' has no link or property '${segment}'`,
            1,
            1,
          );
        }
        return {
          ...result,
          pathId: defaultPathId(`${result.typeref.id}.${segment}`),
        };
      }
      result = extendPathSet(result, ptrref);
    }
    return result;
  }
  if (target.kind === "backlink") {
    const ptrref = resolveBacklinkPointerRef(ctx, subject.typeref, target.link, target.sourceType);
    if (!ptrref) {
      return setFromTypeRoot(resolveTypeRef(ctx, target.sourceType ?? "default::Object"));
    }
    return extendPathSetDirectional(subject, ptrref, "inbound");
  }
  const ptrref = resolveBacklinkPointerRef(ctx, subject.typeref, target.link, target.sourceType);
  if (!ptrref) {
    return setFromTypeRoot(resolveTypeRef(ctx, target.sourceType ?? "default::Object"));
  }
  const backlinkSet = extendPathSetDirectional(subject, ptrref, "inbound");
  const propertyPtr: PointerRef = {
    kind: "pointer_ref",
    id: `${ptrref.id}.@${target.property}`,
    name: `@${target.property}`,
    shortName: `@${target.property}`,
    outSource: backlinkSet.typeref,
    outTarget: { ...unknownTypeRef("std::anyscalar"), isScalar: true },
    outCardinality: "at_most_one",
    inCardinality: "many",
    isComputed: false,
    isLinkProperty: true,
    hasProperties: false,
  };
  return extendPathSetDirectional(backlinkSet, propertyPtr, "outbound");
};

const compileFilterExpr = (filter: FilterExpr, subject: Set, ctx: IRCompileContext): Set => {
  // Bind the filter's subject so leading-dot paths inside the filter
  // (e.g. `.name`, `.deck`) resolve against the subject set rather than
  // bailing to `null` and producing pointer-on-null IR. The bindings live
  // in a child scope so they don't leak past the filter.
  const filterCtx = childScope(ctx);
  bindValue(filterCtx, "__current__", subject);
  bindValue(filterCtx, "__subject__", subject);
  if (filter.kind === "free_expr") {
    return compileFreeObjectExpr(filter.expr, filterCtx);
  }
  if (filter.kind === "and" || filter.kind === "or") {
    const left = compileFilterExpr(filter.left, subject, ctx);
    const right = compileFilterExpr(filter.right, subject, ctx);
    return {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: filter.kind,
        args: { "0": mkCallArg(left), "1": mkCallArg(right) },
        returning: unknownTypeRef("std::bool"),
        volatility: "immutable",
      } as OperatorCall,
      pathId: defaultPathId(`filter:${filter.kind}`),
      typeref: unknownTypeRef("std::bool"),
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
  }
  if (filter.kind === "not") {
    const inner = compileFilterExpr(filter.expr, subject, ctx);
    return {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: "not",
        args: { "0": mkCallArg(inner) },
        returning: unknownTypeRef("std::bool"),
        volatility: "immutable",
      } as OperatorCall,
      pathId: defaultPathId("filter:not"),
      typeref: unknownTypeRef("std::bool"),
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
  }
  if (filter.kind === "in_predicate") {
    const left = compileFilterTarget(filter.target, subject, ctx);
    const right = filter.values.kind === "set_literal"
      ? compileSetConstructor(filter.values.values.map((value) => literalToSet(value)), "filter:in:set_literal")
      : filter.values.kind === "name"
        ? compileFreeObjectExpr({ kind: "binding_ref", name: filter.values.name }, ctx)
        : filter.values.kind === "select"
          ? setFromTypeRoot(resolveTypeRef(ctx, filter.values.query.typeName))
          : filter.values.kind === "expr_set"
            ? compileSetConstructor(filter.values.values.map((value) => compileFreeObjectExpr(value, ctx)), "filter:in:expr_set")
            : literalToSet(null);
    return {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: filter.op === "not_in" ? "not in" : "in",
        args: { "0": mkCallArg(left), "1": mkCallArg(right) },
        returning: unknownTypeRef("std::bool"),
        volatility: "immutable",
      } as OperatorCall,
      pathId: defaultPathId("filter:in"),
      typeref: unknownTypeRef("std::bool"),
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
  }
  const left = compileFilterTarget(filter.target, subject, ctx);
  // The filter grammar lowers `EXISTS <bare-name>` to `<name> = true`; when
  // the name resolved to an OBJECT set (a WITH binding / link), the intent
  // is an existence test, not a boolean comparison.
  if (filter.op === "=" && filter.value === true && !left.typeref.isScalar
      && (left.expr.kind === "select_expr" || left.expr.kind === "type_root"
          || (left.expr.kind === "pointer" && !(left.expr as Pointer).ptrref.outTarget.isScalar))) {
    return {
      kind: "set",
      expr: { kind: "exists_expr", expr: left } as ExistsExpr,
      pathId: defaultPathId("filter:exists"),
      typeref: unknownTypeRef("std::bool"),
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
  }
  const right = compileFilterValue(filter.value, ctx);
  return {
    kind: "set",
    expr: {
      kind: "operator_call",
      operator: filter.op,
      args: { "0": mkCallArg(left), "1": mkCallArg(right) },
      returning: unknownTypeRef("std::bool"),
      volatility: "immutable",
    } as OperatorCall,
    pathId: defaultPathId(`filter:${filter.op}`),
    typeref: unknownTypeRef("std::bool"),
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

const compileFilterToSet = (
  filter: SelectStatement["filter"] | UpdateStatement["filter"] | DeleteStatement["filter"],
  subject: Set,
  ctx: IRCompileContext,
): Set | undefined => {
  if (!filter) {
    return undefined;
  }
  return compileFilterExpr(filter, subject, ctx);
};

type ComputedExprCard = {
  upper: "one" | "many" | "unknown";
  lower: "zero" | "one" | "unknown";
};

type ComputedExprType =
  | { kind: "scalar"; typeName: string }
  | { kind: "object"; typeName: string }
  | { kind: "empty" }
  | { kind: "unknown" };

const scalarToQualified = (name: string): string => {
  if (name.includes("::")) return name;
  switch (name.toLowerCase()) {
    case "str": return "std::str";
    case "int16": return "std::int16";
    case "int32": return "std::int32";
    case "int64": return "std::int64";
    case "int": return "std::int64";
    case "float32": return "std::float32";
    case "float64": return "std::float64";
    case "decimal": return "std::decimal";
    case "bigint": return "std::bigint";
    case "bool": return "std::bool";
    case "uuid": return "std::uuid";
    case "json": return "std::json";
    case "datetime": return "std::datetime";
    case "duration": return "std::duration";
    case "bytes": return "std::bytes";
    default: return `std::${name}`;
  }
};

const literalScalarTypeName = (value: unknown): string => {
  if (typeof value === "string") return "std::str";
  if (typeof value === "boolean") return "std::bool";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "std::int64" : "std::float64";
  }
  if (typeof value === "bigint") return "std::int64";
  return "std::anyscalar";
};

const ScalarBindingNames = new globalThis.Set<string>([
  "__subject__", "__current__", "__source__",
]);

// Does a SELECT's FILTER clause guarantee at most one row by equality-matching
// a property that carries a plain (non-`except`) exclusive constraint?
// `select Person filter .name = 'x'` → yes (name is exclusive). An
// `exclusive … except (.flag)` constraint does not clamp (exempt rows can
// duplicate the value), so it returns false.
const selectFilterClampsToOne = (
  typeName: string,
  filter: FilterExpr | undefined,
  ctx: IRCompileContext,
): boolean => {
  if (!filter || filter.kind !== "predicate" || filter.op !== "=") return false;
  if (filter.target.kind !== "field" || filter.target.field.includes(".")) return false;
  const fieldName = filter.target.field;
  const typeDef = getSchemaType(ctx, typeName);
  if (!typeDef) return false;
  // Field-level `constraint exclusive` (no `except`).
  const field = typeDef.fields.find((f) => f.name === fieldName) as
    | { multi?: boolean; constraints?: Array<{ name?: string; exceptExpr?: string }> }
    | undefined;
  if (field && !field.multi) {
    const excl = (field.constraints ?? []).find((c) => c.name === "std::exclusive" || c.name === "exclusive");
    if (excl && excl.exceptExpr === undefined) return true;
  }
  // Type-level single-field `constraint exclusive on (.field)` without `except`.
  const typeExcl = (typeDef.typeConstraints ?? []).find(
    (c) =>
      (c.name === "std::exclusive" || c.name === "exclusive")
      && c.fieldRefs.length === 1
      && c.fieldRefs[0] === fieldName,
  );
  if (typeExcl && typeExcl.exceptExpr === undefined) return true;
  return false;
};

const inferFreeExprCard = (
  expr: FreeObjectExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): ComputedExprCard => {
  switch (expr.kind) {
    case "literal":
      return { upper: "one", lower: "one" };
    case "set_literal":
      if (expr.values.length === 0) return { upper: "one", lower: "zero" };
      if (expr.values.length === 1) return { upper: "one", lower: "one" };
      return { upper: "many", lower: "one" };
    case "cast":
      return inferFreeExprCard(expr.expr, ctx, subjectTypeRef);
    case "current_item":
      return { upper: "one", lower: "one" };
    case "binding_ref": {
      if (ScalarBindingNames.has(expr.name)) return { upper: "one", lower: "one" };
      const bound = resolveBinding(ctx, expr.name);
      if (bound) {
        return { upper: "unknown", lower: "unknown" };
      }
      const typeDef = getSchemaType(ctx, expr.name);
      if (typeDef) {
        return { upper: "many", lower: "zero" };
      }
      return { upper: "unknown", lower: "unknown" };
    }
    case "field_access": {
      const baseCard = inferFreeExprCard(expr.expr, ctx, subjectTypeRef);
      const baseType = inferFreeExprType(expr.expr, ctx, subjectTypeRef);
      if (baseType.kind === "object") {
        const objectType = getSchemaType(ctx, baseType.typeName);
        const fieldDef = objectType?.fields.find((candidate) => candidate.name === expr.field);
        const linkDef = objectType?.links?.find((candidate) => candidate.name === expr.field);
        if (fieldDef) {
          return combineCard(baseCard, {
            upper: fieldDef.multi ? "many" : "one",
            lower: fieldDef.required ? "one" : "zero",
          });
        }
        if (linkDef) {
          return combineCard(baseCard, {
            upper: linkDef.multi ? "many" : "one",
            lower: linkDef.required ? "one" : "zero",
          });
        }
      }
      return { upper: "unknown", lower: "unknown" };
    }
    case "path":
    case "path_chain":
    case "path_steps":
      return { upper: "unknown", lower: "unknown" };
    case "select_expr_subquery": {
      if (expr.limit === 1) return { upper: "one", lower: "zero" };
      // A parenthesised subquery (`(select T filter …)`) carries its inner
      // SELECT under `.expr` — recurse so exclusive-filter clamping is honoured.
      if (expr.expr) return inferFreeExprCard(expr.expr, ctx, subjectTypeRef);
      return { upper: "unknown", lower: "zero" };
    }
    case "select":
      if (expr.clauses?.limit === 1) return { upper: "one", lower: "zero" };
      // An equality filter on a property carrying a plain `exclusive` constraint
      // selects at most one row (`select Person filter .name = 'x'`). An
      // `exclusive … except (…)` constraint does NOT clamp — exempt rows can
      // share the value — so it stays many.
      if (selectFilterClampsToOne(expr.typeName, expr.clauses?.filter, ctx)) {
        return { upper: "one", lower: "zero" };
      }
      return { upper: "many", lower: "zero" };
    case "tuple":
      return { upper: "one", lower: "one" };
    case "function_call":
      return { upper: "unknown", lower: "unknown" };
    case "math":
    case "compare":
    case "and":
    case "or":
    case "not":
    case "unary":
    case "logical":
    case "concat":
      return { upper: "unknown", lower: "unknown" };
    case "coalesce":
      return { upper: "unknown", lower: "unknown" };
    case "if_else":
      return { upper: "unknown", lower: "unknown" };
    case "for_expr":
      return { upper: "many", lower: "zero" };
    case "exists":
      return { upper: "one", lower: "one" };
    default:
      return { upper: "unknown", lower: "unknown" };
  }
};

const combineCard = (a: ComputedExprCard, b: ComputedExprCard): ComputedExprCard => {
  const upper: ComputedExprCard["upper"] =
    a.upper === "many" || b.upper === "many" ? "many"
      : a.upper === "unknown" || b.upper === "unknown" ? "unknown"
      : "one";
  const lower: ComputedExprCard["lower"] =
    a.lower === "zero" || b.lower === "zero" ? "zero"
      : a.lower === "unknown" || b.lower === "unknown" ? "unknown"
      : "one";
  return { upper, lower };
};

const inferComputedExprCard = (
  expr: ComputedExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): ComputedExprCard => {
  switch (expr.kind) {
    case "literal":
      return { upper: "one", lower: "one" };
    case "field_ref": {
      const ptrref = resolvePointerRef(ctx, subjectTypeRef, expr.field);
      if (!ptrref) return { upper: "unknown", lower: "unknown" };
      const upper: ComputedExprCard["upper"] = ptrref.outCardinality === "many" ? "many" : "one";
      const lower: ComputedExprCard["lower"] = ptrref.outCardinality === "one" ? "one" : "zero";
      return { upper, lower };
    }
    case "select_expr":
      return inferFreeExprCard(expr.expr, ctx, subjectTypeRef);
    case "binding_ref": {
      if (ScalarBindingNames.has(expr.name)) return { upper: "one", lower: "one" };
      const bound = resolveBinding(ctx, expr.name);
      if (bound) return { upper: "unknown", lower: "unknown" };
      const typeDef = getSchemaType(ctx, expr.name);
      if (typeDef) return { upper: "many", lower: "zero" };
      return { upper: "unknown", lower: "unknown" };
    }
    case "function_call":
      return { upper: "unknown", lower: "unknown" };
    default:
      return { upper: "unknown", lower: "unknown" };
  }
};

const inferFreeExprType = (
  expr: FreeObjectExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): ComputedExprType => {
  switch (expr.kind) {
    case "literal":
      return { kind: "scalar", typeName: literalScalarTypeName(expr.value) };
    case "set_literal":
      if (expr.values.length === 0) return { kind: "empty" };
      return { kind: "scalar", typeName: literalScalarTypeName(expr.values[0]) };
    case "cast":
      return { kind: "scalar", typeName: scalarToQualified(expr.castType) };
    case "current_item":
      return { kind: "object", typeName: subjectTypeRef.id };
    case "binding_ref": {
      if (ScalarBindingNames.has(expr.name)) return { kind: "object", typeName: subjectTypeRef.id };
      const typeDef = getSchemaType(ctx, expr.name);
      if (typeDef) {
        return { kind: "object", typeName: qualifyTypeName(typeDef.name, typeDef.module ?? "default") };
      }
      return { kind: "unknown" };
    }
    case "field_access": {
      const baseType = inferFreeExprType(expr.expr, ctx, subjectTypeRef);
      if (baseType.kind === "object") {
        const objectType = getSchemaType(ctx, baseType.typeName);
        const fieldDef = objectType?.fields.find((candidate) => candidate.name === expr.field);
        const linkDef = objectType?.links?.find((candidate) => candidate.name === expr.field);
        if (fieldDef) {
          const target = fieldDef.targetTypeName;
          return { kind: "scalar", typeName: target ?? scalarToStdName(fieldDef.type) };
        }
        if (linkDef) return { kind: "object", typeName: linkDef.targetType };
      }
      return { kind: "unknown" };
    }
    case "select":
      return { kind: "object", typeName: resolveTypeRef(ctx, expr.typeName).id };
    case "select_expr_subquery":
      return inferFreeExprType(expr.expr, ctx, subjectTypeRef);
    case "if_else":
      return inferFreeExprType(expr.thenExpr, ctx, subjectTypeRef);
    case "coalesce":
      return inferFreeExprType(expr.left, ctx, subjectTypeRef);
    default:
      return { kind: "unknown" };
  }
};

const isScalarSubtypeOf = (childName: string, parentName: string): boolean => {
  if (childName === parentName) return true;
  if (parentName === "std::anyscalar") return true;
  if (parentName === "std::number" && (
    childName === "std::int16" || childName === "std::int32" || childName === "std::int64"
    || childName === "std::float32" || childName === "std::float64"
    || childName === "std::decimal" || childName === "std::bigint"
  )) return true;
  return false;
};

const validateOperatorTypes = (
  expr: FreeObjectExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): void => {
  if (expr.kind === "if_else") {
    const thenType = inferFreeExprType(expr.thenExpr, ctx, subjectTypeRef);
    const elseType = inferFreeExprType(expr.elseExpr, ctx, subjectTypeRef);
    if (thenType.kind === "scalar" && elseType.kind === "scalar"
      && thenType.typeName !== elseType.typeName
      && !isScalarSubtypeOf(thenType.typeName, elseType.typeName)
      && !isScalarSubtypeOf(elseType.typeName, thenType.typeName)
    ) {
      throw new AppError(
        "E_SEMANTIC",
        `operator 'IF' cannot be applied to operands of type '${thenType.typeName}' and '${elseType.typeName}'`,
        1, 1,
      );
    }
    validateOperatorTypes(expr.thenExpr, ctx, subjectTypeRef);
    validateOperatorTypes(expr.elseExpr, ctx, subjectTypeRef);
    validateOperatorTypes(expr.condition, ctx, subjectTypeRef);
    return;
  }
  if (expr.kind === "coalesce") {
    const leftType = inferFreeExprType(expr.left, ctx, subjectTypeRef);
    const rightType = inferFreeExprType(expr.right, ctx, subjectTypeRef);
    if (leftType.kind === "scalar" && rightType.kind === "scalar"
      && leftType.typeName !== rightType.typeName
      && !isScalarSubtypeOf(leftType.typeName, rightType.typeName)
      && !isScalarSubtypeOf(rightType.typeName, leftType.typeName)
    ) {
      throw new AppError(
        "E_SEMANTIC",
        `operator '??' cannot be applied to operands of type '${leftType.typeName}' and '${rightType.typeName}'`,
        1, 1,
      );
    }
    validateOperatorTypes(expr.left, ctx, subjectTypeRef);
    validateOperatorTypes(expr.right, ctx, subjectTypeRef);
    return;
  }
  if (expr.kind === "cast") {
    validateOperatorTypes(expr.expr, ctx, subjectTypeRef);
    return;
  }
  if (expr.kind === "select_expr_subquery") {
    validateOperatorTypes(expr.expr, ctx, subjectTypeRef);
    return;
  }
  if (expr.kind === "field_access") {
    validateOperatorTypes(expr.expr, ctx, subjectTypeRef);
    return;
  }
};

const inferComputedExprType = (
  expr: ComputedExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): ComputedExprType => {
  switch (expr.kind) {
    case "literal":
      return { kind: "scalar", typeName: literalScalarTypeName(expr.value) };
    case "field_ref": {
      const ptrref = resolvePointerRef(ctx, subjectTypeRef, expr.field);
      if (!ptrref) return { kind: "unknown" };
      if (ptrref.outTarget.isScalar) return { kind: "scalar", typeName: ptrref.outTarget.id };
      return { kind: "object", typeName: ptrref.outTarget.id };
    }
    case "select_expr":
      return inferFreeExprType(expr.expr, ctx, subjectTypeRef);
    case "binding_ref": {
      if (ScalarBindingNames.has(expr.name)) return { kind: "object", typeName: subjectTypeRef.id };
      const typeDef = getSchemaType(ctx, expr.name);
      if (typeDef) {
        return { kind: "object", typeName: qualifyTypeName(typeDef.name, typeDef.module ?? "default") };
      }
      return { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
};

const findInheritedFieldOwner = (
  ctx: IRCompileContext,
  typeId: string,
  fieldName: string,
  seen = new globalThis.Set<string>(),
): { kind: "field"; owner: string; field: FieldDef } | { kind: "link"; owner: string; link: LinkDef } | undefined => {
  if (seen.has(typeId)) return undefined;
  seen.add(typeId);
  const typeDef = getSchemaTypeByQualifiedName(ctx, typeId);
  if (!typeDef) return undefined;
  const directField = typeDef.fields.find((c) => c.name === fieldName);
  if (directField) return { kind: "field", owner: typeId, field: directField };
  const directLink = (typeDef.links ?? []).find((c) => c.name === fieldName);
  if (directLink) return { kind: "link", owner: typeId, link: directLink };
  for (const baseName of typeDef.extends ?? []) {
    const inherited = findInheritedFieldOwner(ctx, qualifyTypeName(baseName, typeDef.module ?? "default"), fieldName, seen);
    if (inherited) return inherited;
  }
  return undefined;
};

// Evaluate a `[is …]` type expression (`Bb & Bc`, `(CBaBc | Bb) & Bc`) into the
// set of qualified CONCRETE type names it admits: a `type_name` contributes its
// own concrete subtypes, `&` intersects the operand sets, `|` unions them.
// Returns undefined when the schema is unavailable.
const evalTypeExprConcreteNames = (
  ctx: IRCompileContext,
  typeExpr: TypeExpr,
): globalThis.Set<string> | undefined => {
  if (!ctx.schema) return undefined;
  if (typeExpr.kind === "type_name") {
    const qualified = qualifyTypeName(typeExpr.name, ctx.module);
    return new globalThis.Set(ctx.schema.concreteTypeNamesUnder(qualified));
  }
  const left = evalTypeExprConcreteNames(ctx, typeExpr.left);
  const right = evalTypeExprConcreteNames(ctx, typeExpr.right);
  if (!left || !right) return undefined;
  if (typeExpr.kind === "type_union") {
    return new globalThis.Set([...left, ...right]);
  }
  return new globalThis.Set([...left].filter((id) => right.has(id)));
};

// The fullest TypeDef available, including `computeds` — `getSchemaTypeByQualifiedName`
// prefers the generated schema model, which omits computed pointers, so the
// intersection-pointer checks (which must see computeds) read the snapshot.
const fullTypeDef = (ctx: IRCompileContext, typeId: string): TypeDef | undefined =>
  ctx.schema?.getType(typeId) ?? getSchemaTypeByQualifiedName(ctx, typeId);

// The most-ancestral type that declares `ptrName`. Inherited members are folded
// down, so every type in the chain "has" the pointer; the origin is the topmost
// ancestor still carrying it. Two types share the SAME version of a computed
// pointer iff they share this origin.
const pointerDeclOrigin = (ctx: IRCompileContext, typeId: string, ptrName: string): string => {
  const hasPtr = (def: TypeDef): boolean =>
    (def.fields ?? []).some((f) => f.name === ptrName && !f.isLinkColumn)
    || (def.links ?? []).some((l) => l.name === ptrName)
    || (def.computeds ?? []).some((c) => c.name === ptrName);
  let origin = typeId;
  const visit = (id: string, seen: globalThis.Set<string>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const def = fullTypeDef(ctx, id);
    if (!def || !hasPtr(def)) return;
    origin = id;
    for (const base of def.extends ?? []) {
      visit(qualifyTypeName(base, def.module ?? "default"), seen);
    }
  };
  visit(typeId, new globalThis.Set());
  return origin;
};

type IntersectionPointerInfo = { kind: "property" | "link"; computed: boolean; multi: boolean; origin: string };

const intersectionPointerInfo = (
  ctx: IRCompileContext,
  typeId: string,
  ptrName: string,
): IntersectionPointerInfo | undefined => {
  const def = fullTypeDef(ctx, typeId);
  if (!def) return undefined;
  const field = (def.fields ?? []).find((f) => f.name === ptrName && !f.isLinkColumn);
  if (field) {
    return { kind: "property", computed: false, multi: !!field.multi, origin: pointerDeclOrigin(ctx, typeId, ptrName) };
  }
  const link = (def.links ?? []).find((l) => l.name === ptrName);
  if (link) {
    return { kind: "link", computed: false, multi: !!link.multi, origin: pointerDeclOrigin(ctx, typeId, ptrName) };
  }
  const computed = (def.computeds ?? []).find((c) => c.name === ptrName);
  if (computed) {
    return {
      kind: computed.kind === "link" ? "link" : "property",
      computed: true,
      multi: !!computed.multi,
      origin: pointerDeclOrigin(ctx, typeId, ptrName),
    };
  }
  return undefined;
};

// `A[is B].p` introduces `p` from BOTH A and B into the A&B intersection type.
// Mixing two versions of a computed pointer from different declarations — or two
// non-computed versions with different cardinalities — is illegal; surface the
// upstream error. Same-origin computeds (both inherited from one base) are a
// single version and pass; a pointer present on only one side has no conflict.
const validateTypeIntersectionPointer = (
  ctx: IRCompileContext,
  baseTypeId: string,
  intersectTypeId: string,
  ptrName: string,
): void => {
  if (baseTypeId === intersectTypeId) return;
  if (baseTypeId.startsWith("unknown:") || intersectTypeId.startsWith("unknown:")) return;
  const a = intersectionPointerInfo(ctx, baseTypeId, ptrName);
  const b = intersectionPointerInfo(ctx, intersectTypeId, ptrName);
  if (!a || !b) return;
  const label = `${a.kind} '${ptrName}'`;
  if (a.computed || b.computed) {
    if (a.origin !== b.origin) {
      throw new AppError(
        "E_SEMANTIC",
        `it is illegal to create a type intersection that causes a computed ${label} to mix with other versions of the same ${label}`,
        1,
        1,
      );
    }
    return;
  }
  if (a.multi !== b.multi) {
    throw new AppError(
      "E_SEMANTIC",
      `it is illegal to create a type intersection that causes a ${label} to mix with other versions of ${label} which have a different cardinality`,
      1,
      1,
    );
  }
};

const isSubtypeOf = (ctx: IRCompileContext, childId: string, parentId: string): boolean => {
  if (childId === parentId) return true;
  const seen = new globalThis.Set<string>();
  const walk = (typeId: string): boolean => {
    if (seen.has(typeId)) return false;
    seen.add(typeId);
    const typeDef = getSchemaTypeByQualifiedName(ctx, typeId);
    if (!typeDef) return false;
    for (const baseName of typeDef.extends ?? []) {
      const qualified = qualifyTypeName(baseName, typeDef.module ?? "default");
      if (qualified === parentId) return true;
      if (walk(qualified)) return true;
    }
    return false;
  };
  return walk(childId);
};

// Decide whether to surface a "no link or property 'X'" error for a shape
// element whose name failed to resolve against `subject`'s type. Only fires
// when the subject is a real, schema-resolvable object type — synthesized
// containers (`unknown:*`, anytype, tuple wrappers, computed alias targets)
// have no enumerable member list and so we can't tell if the spelling is
// wrong vs. dynamically added.
const shouldEnforceShapeMember = (
  el: EdgeQLShapeElement,
  subject: Set,
  ctx: IRCompileContext,
): boolean => {
  if (!("name" in el) || !el.name || el.name.startsWith("@")) return false;
  if (el.name === "id" || el.name === "__type__") return false;
  if ("origin" in el && el.origin && el.origin !== "explicit") return false;
  const typeId = subject.typeref.id;
  if (typeId.startsWith("unknown:") || typeId.startsWith("std::")) return false;
  if (subject.typeref.isScalar) return false;
  if (!getResolvedSchemaType(ctx, typeId)) return false;
  return true;
};

// Does a computed shape element's expression define a mutation
// (INSERT/UPDATE/DELETE) inside the view it constructs? EdgeQL forbids DML in
// a shape's computed expression — the mutation must be factored into a
// top-level WITH binding instead (where it becomes a `binding_ref`, not an
// inline `mutation_expr`). Inline DML always surfaces as a `mutation_expr`
// node, so a deep scan for one suffices. This helper is only consulted from
// SELECT / free-object shape compilation, never from INSERT/UPDATE *value*
// shapes (which use the distinct `InsertValue` AST), so it never rejects
// legitimate nested DML.
const exprDefinesInlineMutation = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(exprDefinesInlineMutation);
  if (node === null || typeof node !== "object") return false;
  if ((node as { kind?: unknown }).kind === "mutation_expr") return true;
  return Object.values(node as Record<string, unknown>).some(exprDefinesInlineMutation);
};

const validateComputedShapeElement = (
  el: Extract<EdgeQLShapeElement, { kind: "computed" }>,
  subject: Set,
  ctx: IRCompileContext,
): void => {
  if (el.name.startsWith("@")) return;
  // DML is not allowed inside a shape's computed expression in a non-DML
  // (SELECT / free-object) context. EdgeQL requires factoring the mutation
  // into a top-level WITH binding. `validateComputedShapeElement` is only
  // reached from SELECT/free-object shape compilation, never from INSERT or
  // UPDATE value shapes, so this never rejects legitimate nested DML.
  if (exprDefinesInlineMutation(el.expr)) {
    throw new AppError(
      "E_SEMANTIC",
      "mutations are invalid in a shape's computed expression",
      1, 1,
    );
  }
  const subjectTypeId = subject.typeref.id;
  const inherited = findInheritedFieldOwner(ctx, subjectTypeId, el.name);
  const inferredType = inferComputedExprType(el.expr, ctx, subject.typeref);
  const inferredCard = inferComputedExprCard(el.expr, ctx, subject.typeref);

  if (inherited) {
    const ownerName = inherited.owner;
    const memberKind = inherited.kind;
    const expectedRequired = memberKind === "field" ? inherited.field.required === true : inherited.link.required === true;
    const expectedMulti = memberKind === "field" ? inherited.field.multi === true : inherited.link.multi === true;

    if (memberKind === "field") {
      const expectedScalar = scalarToStdName(inherited.field.type);
      if (inferredType.kind === "object") {
        throw new AppError(
          "E_SEMANTIC",
          `cannot redefine property '${el.name}' of object type '${ownerName}' as object type '${inferredType.typeName}'`,
          1, 1,
        );
      }
      if (inferredType.kind === "scalar" && inferredType.typeName !== expectedScalar && inferredType.typeName !== "std::anyscalar") {
        throw new AppError(
          "E_SEMANTIC",
          `cannot redefine property '${el.name}' of object type '${ownerName}' as scalar type '${inferredType.typeName}'`,
          1, 1,
        );
      }
    } else {
      const expectedTargetId = inherited.link.targetType;
      if (inferredType.kind === "scalar") {
        throw new AppError(
          "E_SEMANTIC",
          `cannot redefine link '${el.name}' of object type '${ownerName}' as scalar type '${inferredType.typeName}'`,
          1, 1,
        );
      }
      if (inferredType.kind === "object" && !isSubtypeOf(ctx, inferredType.typeName, expectedTargetId) && inferredType.typeName !== expectedTargetId) {
        throw new AppError(
          "E_SEMANTIC",
          `cannot redefine link '${el.name}' of object type '${ownerName}' as object type '${inferredType.typeName}'`,
          1, 1,
        );
      }
    }

    if (el.cardinality === "many" && !expectedMulti) {
      throw new AppError(
        "E_SEMANTIC",
        `cannot redefine the cardinality of ${memberKind} '${el.name}': it is defined as 'single' in the base object type '${ownerName}'`,
        1, 1,
      );
    }
    if (el.cardinality === "one" && expectedMulti) {
      throw new AppError(
        "E_SEMANTIC",
        `cannot redefine the cardinality of ${memberKind} '${el.name}': it is defined as 'multi' in the base object type '${ownerName}'`,
        1, 1,
      );
    }
    if (el.required === false && expectedRequired) {
      throw new AppError(
        "E_SEMANTIC",
        `cannot redefine ${memberKind} '${el.name}' as optional: it is defined as required in the base object type '${ownerName}'`,
        1, 1,
      );
    }
  }

  const memberKindForMsg = inherited ? inherited.kind : (inferredType.kind === "object" ? "link" : "property");

  const inheritedMulti = inherited && (inherited.kind === "field" ? inherited.field.multi : inherited.link.multi) === true;
  const inheritedRequired = inherited && (inherited.kind === "field" ? inherited.field.required : inherited.link.required) === true;
  const declaredSingle = el.cardinality === "one" || (inherited && !inheritedMulti && el.cardinality !== "many");
  const declaredRequired = el.required === true || (inheritedRequired && el.required !== false);

  if (declaredSingle && inferredCard.upper === "many") {
    throw new AppError(
      "E_SEMANTIC",
      `possibly more than one element returned by an expression for a computed ${memberKindForMsg} '${el.name}' declared as 'single'`,
      1, 1,
    );
  }
  if (declaredRequired && inferredCard.lower === "zero") {
    throw new AppError(
      "E_SEMANTIC",
      `possibly an empty set returned by an expression for a computed ${memberKindForMsg} '${el.name}' declared as 'required'`,
      1, 1,
    );
  }

  if (el.expr.kind === "select_expr") {
    validateOperatorTypes(el.expr.expr, ctx, subject.typeref);
  }
};

// Heuristic: does the compiled IR set look like it can yield more than one
// row? Used to set a sensible default cardinality on computed shape elements
// (`owner_of := X.<owner[IS Y]`) where the AST doesn't carry an explicit
// `multi`/`single` modifier.
const inferComputedShapeIsMany = (set: Set): boolean => {
  let cur: Set | undefined = set;
  while (cur) {
    const expr = cur.expr;
    if (expr.kind === "pointer") {
      const ptr = expr as Pointer;
      if (ptr.direction === "inbound") return true;
      if (ptr.ptrref.outCardinality === "many" || ptr.ptrref.outCardinality === "at_least_one") return true;
      cur = ptr.source;
      continue;
    }
    if (expr.kind === "select_expr") {
      const se = expr as SelectExpr;
      // A bare `SELECT T { … } FILTER …` (no LIMIT *at any nesting level*) over
      // a type_root is many-cardinality. Peel through nested select_expr layers
      // (parens-induced) to find the innermost result; if any layer carries a
      // LIMIT, the chain collapses to single.
      const limitIsLiteralOne = (limitSet: Set | undefined): boolean => {
        if (!limitSet) return false;
        const e = limitSet.expr;
        return e.kind === "integer_constant" && Number((e as { value: unknown }).value) <= 1;
      };
      // An equality FILTER on an exclusive pointer selects at most one row
      // (`SELECT Status FILTER Status.name = 'Open'`) — check every peeled
      // layer's where, the filter often sits on an inner parens layer.
      const whereClampsToOne = (where: Set | undefined): boolean => {
        if (!where || where.expr.kind !== "operator_call") return false;
        const oc = where.expr as OperatorCall;
        if (oc.operator !== "=") return false;
        return Object.values(oc.args).some((arg: CallArg) => {
          let argSet: Set = arg.expr;
          while (argSet.expr.kind === "select_expr") argSet = (argSet.expr as SelectExpr).result;
          return argSet.expr.kind === "pointer" && (argSet.expr as Pointer).ptrref.isExclusive === true;
        });
      };
      let cursor: Set = se.result;
      let foundLimit = !!se.limit;
      let foundLimitOne = limitIsLiteralOne(se.limit);
      let foundExclusiveWhere = whereClampsToOne(se.where);
      while (cursor.expr.kind === "select_expr") {
        const inner = cursor.expr as SelectExpr;
        if (inner.limit) foundLimit = true;
        if (limitIsLiteralOne(inner.limit)) foundLimitOne = true;
        if (whereClampsToOne(inner.where)) foundExclusiveWhere = true;
        cursor = inner.result;
      }
      // `LIMIT 1` clamps to single no matter what the underlying expression
      // is — including inbound-pointer chains the loop below would otherwise
      // flag as many.
      if (foundLimitOne) return false;
      if (foundExclusiveWhere) return false;
      if (!foundLimit && cursor.expr.kind === "type_root") {
        return true;
      }
      cur = cursor;
      continue;
    }
    // Element-wise scalar expressions inherit the cardinality of their
    // operands: `.tags = 'red' or .name like '%a%'` yields one boolean per
    // tags element. Aggregates collapse to single, so don't recurse into
    // them.
    if (expr.kind === "operator_call") {
      const oc = expr as OperatorCall;
      if (oc.operator === "union") return true;
      if (oc.operator === "??" || oc.operator === "exists") return false;
      return Object.values(oc.args).some((arg) => inferComputedShapeIsMany(arg.expr));
    }
    if (expr.kind === "function_call") {
      const fc = expr as IRFunctionCall;
      const shortName = (fc.functionName ?? "").split("::").pop() ?? "";
      const collapsing = new globalThis.Set([
        "count", "sum", "min", "max", "avg", "all", "any",
        "array_agg", "assert_single", "exists",
      ]);
      if (collapsing.has(shortName)) return false;
      return Object.values(fc.args).some((arg: CallArg) => inferComputedShapeIsMany(arg.expr));
    }
    return false;
  }
  return false;
};

// `X.__type__` as a path step — synthesize the pointer set (no real table
// backs it); the SQL layer reads `__source_type` off the source row.
const synthesizeTypePointerSet = (source: Set): Set => {
  const objectTypeRef: TypeRef = {
    kind: "type_ref",
    id: "schema::ObjectType",
    nameHint: "schema::ObjectType",
    module: "schema",
    isView: false,
    isScalar: false,
    isAbstract: false,
    inSchema: false,
  };
  const ptrref: PointerRef = {
    kind: "pointer_ref",
    id: `${source.typeref.id}.link::__type__`,
    name: "__type__",
    shortName: "__type__",
    outSource: source.typeref,
    outTarget: objectTypeRef,
    outCardinality: "one",
    inCardinality: "many",
    isComputed: false,
    isIdPointer: false,
    isLinkProperty: false,
    hasProperties: false,
  };
  return {
    kind: "set",
    expr: { kind: "pointer", source, ptrref, direction: "outbound", isDefinition: false } as Pointer,
    pathId: defaultPathId(`${source.typeref.id}.__type__`),
    typeref: objectTypeRef,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

// `.name` applied to a synthesized `__type__` pointer.
const synthesizeTypeNamePointerSet = (typeSet: Set): Set => {
  const strRef: TypeRef = {
    kind: "type_ref",
    id: "std::str",
    nameHint: "std::str",
    module: "std",
    isView: false,
    isScalar: true,
    isAbstract: false,
    inSchema: false,
  };
  const ptrref: PointerRef = {
    kind: "pointer_ref",
    id: "schema::ObjectType.property::name",
    name: "name",
    shortName: "name",
    outSource: typeSet.typeref,
    outTarget: strRef,
    outCardinality: "one",
    inCardinality: "many",
    isComputed: false,
    isIdPointer: false,
    isLinkProperty: false,
    hasProperties: false,
  };
  return {
    kind: "set",
    expr: { kind: "pointer", source: typeSet, ptrref, direction: "outbound", isDefinition: false } as Pointer,
    pathId: defaultPathId(`${typeSet.typeref.id}.__type__.name`),
    typeref: strRef,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

// Build a shape element for `__type__: { … }`. The SQL compiler keys off the
// `shape_element.targetPtr.shortName === "__type__"` marker (we tag the
// element name accordingly) to emit a synthetic json_object from the row's
// `__source_type` column without trying to JOIN a non-existent table.
const synthesizeTypeLinkShapeElement = (
  subject: Set,
  el: Extract<EdgeQLShapeElement, { kind: "link" }>,
): ShapeElement => {
  const typeRef: TypeRef = {
    kind: "type_ref",
    id: "schema::ObjectType",
    nameHint: "schema::ObjectType",
    module: "schema",
    isView: false,
    isScalar: false,
    isAbstract: false,
    inSchema: false,
  };
  const ptrref: PointerRef = {
    kind: "pointer_ref",
    id: `${subject.typeref.id}.link::__type__`,
    name: "__type__",
    shortName: "__type__",
    outSource: subject.typeref,
    outTarget: typeRef,
    outCardinality: "one",
    inCardinality: "many",
    isComputed: false,
    isIdPointer: false,
    isLinkProperty: false,
    hasProperties: false,
  };
  const childNames = (el.shape ?? [])
    .map((child) => (child.kind === "field" || child.kind === "computed" || child.kind === "link" || child.kind === "backlink") ? child.name : "")
    .filter((name) => name && !name.startsWith("@"));
  const exprSet: Set = {
    kind: "set",
    expr: {
      kind: "pointer",
      source: subject,
      ptrref,
      direction: "outbound",
      isDefinition: false,
    } as Pointer,
    pathId: defaultPathId(`${subject.typeref.id}.__type__`),
    typeref: typeRef,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
  return {
    kind: "shape_element",
    source: subject,
    expr: exprSet,
    shapeOp: el.operation,
    shapeOrigin: "explicit",
    required: false,
    cardinality: "at_most_one",
    name: el.name,
    targetPtr: ptrref,
    // Carry the user's requested sub-fields on the shape element via a side
    // channel so the SQL compiler can pick from a fixed map (name, id).
    syntheticTypeFields: childNames,
  } as ShapeElement & { syntheticTypeFields: string[] };
};

// Walks a shape's splat entries and rejects combinations like
// `Object { [is User].*, [is Issue].* }` where the splatted types are
// unrelated (neither is a subtype of the other, and neither extends a
// common subject type). Mirrors the EdgeQL diagnostic
// `appears in splats for unrelated types`.
const validateSplatTypeIntersections = (
  subject: Set,
  shape: EdgeQLShapeElement[],
  ctx: IRCompileContext,
): void => {
  if (!ctx.schema) return;
  const schema = ctx.schema;
  const splatTypes: string[] = [];
  for (const el of shape) {
    if (el.kind !== "splat") continue;
    if (!el.sourceType) continue;
    const typeRef = resolveTypeRef(ctx, el.sourceType);
    splatTypes.push(typeRef.id);
  }
  if (splatTypes.length < 2) return;
  const subjectTypeId = subject.typeref.id;
  const subjectIsUniversal = isUniversalObjectRefName(subjectTypeId);
  // Subject branches (Union types): for `Issue.references: File | URL | …`
  // the subject's typeref id is `default::File|default::URL|…` (or
  // `unknown:default::File|…` when the union arrives unresolved). Treat
  // each branch as a valid subject for the relatedness check — `[is File].*`
  // and `[is Publication].*` are both legal even though File and
  // Publication are unrelated concrete types. Strip the `unknown:` marker
  // each branch may carry so the subsequent `isTypeSubtypeOf` lookups land
  // on the canonical schema names.
  const stripUnknown = (name: string): string => name.startsWith("unknown:") ? name.slice("unknown:".length) : name;
  const subjectBranches = new globalThis.Set<string>();
  if (subjectTypeId.includes("|")) {
    for (const branch of subjectTypeId.split("|")) {
      subjectBranches.add(stripUnknown(branch.trim()));
    }
  } else {
    subjectBranches.add(stripUnknown(subjectTypeId));
  }
  for (let i = 0; i < splatTypes.length; i += 1) {
    for (let j = i + 1; j < splatTypes.length; j += 1) {
      const a = splatTypes[i];
      const b = splatTypes[j];
      if (a === b) continue;
      const aSubB = ctx.schema.isTypeSubtypeOf(a, b);
      const bSubA = ctx.schema.isTypeSubtypeOf(b, a);
      if (aSubB || bSubA) continue;
      // When the surrounding subject narrows both types under a single
      // ancestor (e.g. `Named { [is Issue].*, [is User].* }` where Named is
      // an ancestor of both), the splats are still considered related
      // because each intersection refines the subject independently.
      if (!subjectIsUniversal) {
        const aRelatedToSubject = [...subjectBranches].some((branch) => schema.isTypeSubtypeOf(a, branch));
        const bRelatedToSubject = [...subjectBranches].some((branch) => schema.isTypeSubtypeOf(b, branch));
        if (aRelatedToSubject && bRelatedToSubject) continue;
      }
      throw new AppError(
        "E_SEMANTIC",
        `type '${a}' appears in splats for unrelated types ('${a}' and '${b}')`,
        1,
        1,
      );
    }
  }
};

const compileShape = (
  subject: Set,
  shape: EdgeQLShapeElement[],
  ctx: IRCompileContext,
  seenTypeIds: globalThis.Set<string> = new globalThis.Set<string>(),
): ShapeElement[] => {
  const out: ShapeElement[] = [];
  const explicitNames = new globalThis.Set<string>();
  for (const el of shape) {
    if (el.kind === "field" || el.kind === "link" || el.kind === "computed" || el.kind === "backlink") {
      explicitNames.add(el.name);
    }
  }

  // Reject `Type { foo, foo }` and `Type { foo, foo := … }` against the same
  // object. The shape syntax has no semantics for two siblings sharing a name;
  // the same expression-list quirk used to silently accept it.
  const seenExplicit = new globalThis.Set<string>();
  for (const el of shape) {
    if (el.kind !== "field" && el.kind !== "link" && el.kind !== "computed" && el.kind !== "backlink") continue;
    if (!el.name || el.name.startsWith("@")) continue;
    if (el.origin && el.origin !== "explicit") continue;
    if (seenExplicit.has(el.name)) {
      const probe = resolvePointerRef(ctx, subject.typeref, el.name);
      const memberKind = probe && !probe.outTarget.isScalar ? "link" : "property";
      throw new AppError(
        "E_SEMANTIC",
        `duplicate definition of ${memberKind} '${el.name}' of object type '${subject.typeref.id}'`,
        1,
        1,
      );
    }
    seenExplicit.add(el.name);
  }

  const resolveShapeOrigin = (el: EdgeQLShapeElement): "explicit" | "default" | "splat_expansion" | "materialization" => {
    if (el.origin) {
      return el.origin;
    }
    if (el.operation === "materialize") {
      return "materialization";
    }
    return "explicit";
  };

  const expandSplatEntries = (
    baseSet: Set,
    targetType: TypeRef,
    depth: 1 | 2,
    skipNames: globalThis.Set<string>,
    withModifiersFrom?: EdgeQLShapeElement,
    ancestry: globalThis.Set<string> = new globalThis.Set<string>(),
  ): ShapeElement[] => {
    const expanded: ShapeElement[] = [];
    const generatedType = getResolvedSchemaType(ctx, targetType.id);
    const resolvedFields = generatedType?.resolvedFields;
    const resolvedLinks = generatedType?.resolvedLinks;
    // The generated schema model doesn't preserve `computeds`, so fall back to
    // the live snapshot when the user has computed pointers (e.g.
    // `num_watchers := count(.watchers)`) we need to splat.
    const snapshotTypeDef = ctx.schema?.getType(targetType.id);
    const typeDef = generatedType
      ? {
          name: generatedType.name,
          module: generatedType.module,
          fields: generatedType.fields,
          links: generatedType.links,
          computeds: snapshotTypeDef?.computeds,
        }
      : snapshotTypeDef;
    if (!typeDef) {
      return expanded;
    }

    // Implicit `id`. Every object carries one, so splats must include it
    // even though it doesn't appear in typeDef.fields. The runtime strips
    // `id` from result rows unless a shape element with that name is
    // present, so this is what surfaces it in the public JSON shape.
    if (!skipNames.has("id")) {
      const expr = extendPathSet(baseSet, idPointerRef(targetType));
      expanded.push({
        kind: "shape_element",
        source: baseSet,
        expr,
        shapeOp: "assign",
        shapeOrigin: "splat_expansion",
        required: true,
        cardinality: "one",
        name: "id",
      });
    }
    for (const field of resolvedFields ?? typeDef.fields) {
      if (field.name.startsWith("__") && field.name.endsWith("__")) {
        continue;
      }
      if (skipNames.has(field.name)) {
        continue;
      }
      // `splat_strategy := 'Explicit'` opts a field out of `*` / `**`
      // expansion. The user can still write the field by name; only the
      // implicit splat skips it.
      if (field.splatStrategy === "Explicit") {
        continue;
      }
      // Synthetic `<link>_id` columns the runtime adds for inline single
      // links — they're storage, not properties, and shouldn't surface in
      // splat output.
      if (field.isLinkColumn) {
        continue;
      }
      const ptrref = pointerRefFromField(targetType, field);
      const expr = extendPathSet(baseSet, ptrref);
      expanded.push({
        kind: "shape_element",
        source: baseSet,
        expr: withModifiersFrom ? withShapeModifiers(expr, withModifiersFrom) : expr,
        shapeOp: "assign",
        shapeOrigin: "splat_expansion",
        required: field.required ?? false,
        cardinality: field.required ? "one" : "at_most_one",
        name: field.name,
      });
    }

    for (const link of resolvedLinks ?? typeDef.links ?? []) {
      if (link.name.startsWith("__") && link.name.endsWith("__")) {
        continue;
      }
      if (skipNames.has(link.name)) {
        continue;
      }
      if (link.splatStrategy === "Explicit") {
        continue;
      }
      // Plain `*` only includes links the schema explicitly opted into via
      // `splat_strategy := 'Implicit'`; `**` includes all implicit links.
      if (depth <= 1 && link.splatStrategy !== "Implicit") {
        continue;
      }
      const linkTarget = resolveTypeRef(ctx, link.targetType);
      const ptrref = pointerRefFromLink(targetType, linkTarget, link);
      let expr = extendPathSet(baseSet, ptrref);

      if (depth > 1) {
        const nextAncestry = new Set(ancestry);
        nextAncestry.add(targetType.id);
        const canDescend = !nextAncestry.has(linkTarget.id);
        const nested = canDescend
          ? expandSplatEntries(expr, linkTarget, 1, new globalThis.Set<string>(), undefined, nextAncestry)
          : [];
        // Also surface this link's link properties (e.g. `@note` on
        // `owner`) as part of the deep splat. Without this the projection
        // omits link-table-only columns the deep ** result is expected to
        // carry alongside the target's scalar fields.
        const linkPropEntries = expandLinkPropertyEntries(expr, link, expr.typeref);
        const combined = [...nested, ...linkPropEntries];
        if (combined.length > 0) {
          expr = {
            ...expr,
            shape: combined,
          };
        }
      }

      expanded.push({
        kind: "shape_element",
        source: baseSet,
        expr: withModifiersFrom ? withShapeModifiers(expr, withModifiersFrom) : expr,
        shapeOp: "assign",
        shapeOrigin: "splat_expansion",
        required: false,
        cardinality: link.multi ? "many" : "at_most_one",
        name: link.name,
      });
    }

    // Computed pointers (e.g. `num_watchers := count(.watchers)`). Top-level
    // splats project them unless the schema has the
    // `no_linkful_computed_splats` future flag — in which case computeds that
    // pull through a link (anything other than a plain literal) are dropped.
    if (depth > 0) {
      const innerCtx = childScope(ctx);
      bindValue(innerCtx, "__subject__", baseSet);
      bindValue(innerCtx, "__current__", baseSet);
      for (const computed of typeDef.computeds ?? []) {
        if (skipNames.has(computed.name)) continue;
        if (computed.kind !== "property") continue;
        if (computed.expr.kind === "link_aggregate" && futureFlagForbidsLinkfulComputedSplats(ctx)) continue;
        const compiledExpr = tryLowerComputedPropertyOnTypePath(innerCtx, baseSet, computed.name);
        if (!compiledExpr) continue;
        expanded.push({
          kind: "shape_element",
          source: baseSet,
          expr: compiledExpr,
          shapeOp: "assign",
          shapeOrigin: "splat_expansion",
          required: false,
          cardinality: "one",
          name: computed.name,
        });
      }
    }

    return expanded;
  };

  // Expand a link's stored link properties (`@note`, `@since`, …) as nested
  // shape entries for deep splats. We synthesise the link-property pointer
  // refs the same way `compileLinkPropertyExpr` does for explicit `@name`
  // shape elements so SQL lowering reads the link-table column.
  const expandLinkPropertyEntries = (
    linkSet: Set,
    link: { name: string; properties?: Array<{ name: string; type: string; required?: boolean }> },
    targetTypeRef: TypeRef,
  ): ShapeElement[] => {
    const out: ShapeElement[] = [];
    for (const prop of link.properties ?? []) {
      if (prop.name.startsWith("__") && prop.name.endsWith("__")) continue;
      const propName = `@${prop.name}`;
      const propertyPtrRef: PointerRef = {
        kind: "pointer_ref",
        id: `${targetTypeRef.id}.link::${link.name}.${propName}`,
        name: propName,
        shortName: propName,
        outSource: targetTypeRef,
        outTarget: scalarTypeRef(prop.type as ScalarType),
        outCardinality: prop.required ? "one" : "at_most_one",
        inCardinality: "many",
        isComputed: false,
        isLinkProperty: true,
        hasProperties: false,
      };
      out.push({
        kind: "shape_element",
        source: linkSet,
        expr: extendPathSet(linkSet, propertyPtrRef),
        shapeOp: "assign",
        shapeOrigin: "splat_expansion",
        required: prop.required ?? false,
        cardinality: prop.required ? "one" : "at_most_one",
        name: propName,
      });
    }
    return out;
  };

  const futureFlagForbidsLinkfulComputedSplats = (_ctx: IRCompileContext): boolean => {
    // The schema snapshot tracks active future flags (set via `CREATE FUTURE`
    // DDL). When `no_linkful_computed_splats` is enabled, deep splats drop
    // any computed whose body would emit linkful SQL (e.g. `count(.watchers)`).
    const flags = _ctx.schema?.listFutureFlags?.() ?? [];
    return flags.includes("no_linkful_computed_splats");
  };

  const expandSplat = (el: Extract<EdgeQLShapeElement, { kind: "splat" }>): ShapeElement[] => {
    const targetType = el.sourceType ? resolveTypeRef(ctx, el.sourceType) : subject.typeref;
    const nextSeen = new globalThis.Set(seenTypeIds);
    nextSeen.add(targetType.id);
    return expandSplatEntries(subject, targetType, el.depth, explicitNames, el, nextSeen);
  };

  const withShapeModifiers = (expr: Set, el: EdgeQLShapeElement): Set => {
    const hasFilter = !!el.where;
    const hasOrder = !!el.orderBy?.length;
    const hasLimit = el.limit !== undefined;
    const hasOffset = el.offset !== undefined;
    if (!hasFilter && !hasOrder && !hasLimit && !hasOffset) {
      return expr;
    }
    // A per-link FILTER (`properties: {…} FILTER EXISTS .annotations`) is
    // evaluated against the link's *target* rows, so `.annotations` must
    // resolve on the target type (schema::Property), not the enclosing subject
    // (schema::ObjectType). Without this the dotted path resolves against the
    // outer subject and picks the wrong link-storage table.
    const filterCtx = (() => {
      // A per-link FILTER (`properties: {…} FILTER EXISTS .annotations` /
      // `… FILTER .name IN {…}`) is evaluated against the link's target rows.
      // Bind `.`-paths to the link path itself so `.field` lowers as a
      // chain off the link (source resolves on the target type, e.g.
      // schema::Property) — the SQL layer then anchors that chain to the
      // iterated target alias via rewriteFilterAgainstPointerChain. Only for
      // object-typed links; scalar/multi-scalar property filters
      // (`tag_set1 FILTER Item.tag_set1 > 'p'`) keep the outer scope.
      // Also used to resolve a computed-sibling ORDER BY key against the link
      // target (`stw: { typename := … } ORDER BY .typename`).
      if ((!el.where && !el.orderBy?.length) || expr.typeref.isScalar || expr.expr.kind !== "pointer") return ctx;
      const scoped = childScope(ctx);
      bindValue(scoped, "__current__", expr);
      bindValue(scoped, "__subject__", expr);
      return scoped;
    })();
    const where = el.where ? compileFreeObjectExpr(el.where, filterCtx) : undefined;
    const orderBy = el.orderBy?.map((entry) => {
      // `ORDER BY @prop` — a link-property sort key on the link being shaped
      // (`ancestors: {…} ORDER BY @index`). Build a link-property pointer so
      // SQL sorts by the link table's property column.
      if (entry.field.startsWith("@")) {
        const propPtr: PointerRef = {
          kind: "pointer_ref",
          id: `${expr.typeref.id}.linkprop::${entry.field}`,
          name: entry.field,
          shortName: entry.field,
          outSource: expr.typeref,
          outTarget: { ...unknownTypeRef("std::anyscalar"), isScalar: true },
          outCardinality: "at_most_one",
          inCardinality: "many",
          isComputed: false,
          isLinkProperty: true,
          hasProperties: false,
        };
        return {
          kind: "sort_expr",
          path: extendPathSetDirectional(expr, propPtr, "outbound"),
          direction: entry.direction,
          nonesOrder: "last",
        } as SortExpr;
      }
      // `entry.field` is the dotted path written after `ORDER BY` (the parser
      // has already stripped the leading subject — `User.todo.number` arrives
      // here as `todo.number`). Walk each segment so multi-step paths into the
      // shape's iteration target (`todo` link → `Issue.number`) lower as a
      // pointer chain rather than collapsing to a NULL literal. Try resolving
      // first against the shape's iteration target (`.number`) and fall back
      // to walking from the enclosing subject (`User.todo.number` style).
      const segments = entry.field.split(".");
      // `ORDER BY .typename` may reference a *computed* field declared in this
      // same shape (`stw: { typename := .__type__.name } ORDER BY .typename`).
      // Resolve it by compiling that sibling computed's expression against the
      // link target, since it has no backing pointer.
      if (segments.length === 1) {
        // Only the "link"/"backlink" shape-element arms carry a nested shape.
        const computedSibling = ("shape" in el ? el.shape : undefined)?.find(
          (sub): sub is Extract<EdgeQLShapeElement, { kind: "computed" }> =>
            sub.kind === "computed" && sub.name === segments[0] && !!sub.expr,
        );
        if (computedSibling) {
          return {
            kind: "sort_expr",
            path: compileFreeObjectExpr(computedSibling.expr, filterCtx),
            direction: entry.direction,
            nonesOrder: "last",
          } as SortExpr;
        }
      }
      const walkFrom = (start: Set): Set | undefined => {
        let cursor: Set | undefined = start;
        for (const segment of segments) {
          if (!cursor) return undefined;
          const ptrref = resolvePointerRef(ctx, cursor.typeref, segment);
          if (!ptrref) return undefined;
          cursor = extendPathSet(cursor, ptrref);
        }
        return cursor;
      };
      const path = walkFrom(expr) ?? walkFrom(subject) ?? literalToSet(null);
      return {
        kind: "sort_expr",
        path,
        direction: entry.direction,
        nonesOrder: "last",
      } as SortExpr;
    });
    return {
      kind: "set",
      expr: {
        kind: "select_expr",
        result: expr,
        where,
        orderBy,
        offset: el.offset === undefined ? undefined : literalToSet(el.offset),
        limit: el.limit === undefined ? undefined : literalToSet(el.limit),
        implicitWrapper: false,
      },
      pathId: expr.pathId,
      typeref: expr.typeref,
      shape: expr.shape,
      shapeSource: expr,
      isBinding: expr.isBinding,
      isMaterializedRef: expr.isMaterializedRef,
      isSchemaAlias: expr.isSchemaAlias,
      isVisibleBindingRef: expr.isVisibleBindingRef,
      ignoreRewrites: expr.ignoreRewrites,
      isFactoringProtected: expr.isFactoringProtected,
      anchor: expr.anchor,
      showAsAnchor: expr.showAsAnchor,
      pathScopeId: expr.pathScopeId,
      materializedSets: expr.materializedSets,
    };
  };

  const compileLinkPropertyExpr = (el: Extract<EdgeQLShapeElement, { kind: "field" | "computed" }>): ShapeElement | undefined => {
    const propertyName = el.name;
    const subjectExpr = subject.expr;
    let linkPtrRef: PointerRef | undefined;
    if (subjectExpr.kind === "pointer") {
      const linkPointer = subjectExpr as Pointer;
      if (!linkPointer.ptrref.isLinkProperty) {
        const linkPtr = linkPointer.ptrref;
        linkPtrRef = linkPtr;
        const linkSourceType = getResolvedSchemaType(ctx, linkPointer.source.typeref.id);
        if (linkSourceType) {
          const linkDef = linkSourceType.resolvedLinks.find(l => l.name === linkPtr.shortName);
          if (linkDef?.properties) {
            const propName = propertyName.slice(1);
            const propDef = linkDef.properties.find(p => p.name === propName);
            if (propDef) {
              const propertyPtrRef: PointerRef = {
                kind: "pointer_ref",
                id: `${linkPtrRef.id}.${propertyName}`,
                name: propertyName,
                shortName: propertyName,
                outSource: subject.typeref,
                outTarget: propDef.collection
                  ? { ...scalarTypeRef(propDef.type), collection: propDef.collection.kind }
                  : scalarTypeRef(propDef.type),
                outCardinality: propDef.required ? "one" : "at_most_one",
                inCardinality: "many",
                isComputed: false,
                isIdPointer: false,
                isLinkProperty: true,
                hasProperties: false,
              };
              const propExpr = extendPathSet(subject, propertyPtrRef);
              return {
                kind: "shape_element",
                source: subject,
                expr: withShapeModifiers(propExpr, el),
                shapeOp: el.operation,
                shapeOrigin: resolveShapeOrigin(el),
                required: el.required ?? propDef.required ?? false,
                cardinality: el.cardinality ?? (propDef.required ? "one" : "at_most_one"),
                name: el.name,
              };
            }
          }
        }
      }
    }
    const fallbackType = linkPtrRef?.outTarget
      ? { ...linkPtrRef.outTarget, isScalar: true }
      : { ...unknownTypeRef("std::anyscalar"), isScalar: true };
    const propertyPtrRef: PointerRef = {
      kind: "pointer_ref",
      id: `${subject.typeref.id}.${propertyName}`,
      name: propertyName,
      shortName: propertyName,
      outSource: subject.typeref,
      outTarget: fallbackType,
      outCardinality: "at_most_one",
      inCardinality: "many",
      isComputed: false,
      isIdPointer: false,
      isLinkProperty: true,
      hasProperties: false,
    };
    const expr = extendPathSet(subject, propertyPtrRef);
    return {
      kind: "shape_element",
      source: subject,
      expr: withShapeModifiers(expr, el),
      shapeOp: el.operation,
      shapeOrigin: resolveShapeOrigin(el),
      required: el.required ?? false,
      cardinality: el.cardinality ?? "at_most_one",
      name: el.name,
    };
  };

  for (const el of shape) {
    if (el.kind === "field") {
      if (el.name.startsWith("@")) {
        const result = compileLinkPropertyExpr(el);
        if (result) {
          out.push(result);
        }
        continue;
      }
      // Explicit `{ id }`: `id` is implicit (not in the schema's field list),
      // so resolvePointerRef can't see it. Synthesise the id pointer so the
      // element surfaces `id` in the projection (and keeps it in materialised
      // rows the GROUP runtime traverses) instead of being silently dropped.
      if (el.name === "id" && !resolvePointerRef(ctx, subject.typeref, "id")
        && Boolean(getResolvedSchemaType(ctx, subject.typeref.id) ?? ctx.schema?.getType(subject.typeref.id))) {
        const idPtr = idPointerRef(subject.typeref);
        out.push({
          kind: "shape_element",
          source: subject,
          expr: withShapeModifiers(extendPathSet(subject, idPtr), el),
          shapeOp: el.operation,
          shapeOrigin: resolveShapeOrigin(el),
          required: true,
          cardinality: "one",
          name: "id",
        });
        continue;
      }
      const ptrref = resolvePointerRef(ctx, subject.typeref, el.name);
      if (!ptrref) {
        // Schema-declared property computeds aren't surfaced by resolvePointerRef
        // (they aren't pointers, they're substituted expressions). Try lowering
        // the computed body before surfacing the "no such property" error so
        // `SELECT Publication { title1 }` works when title1 := (SELECT ident(.title)).
        const computedSet = tryLowerComputedPropertyOnTypePath(ctx, subject, el.name);
        if (computedSet) {
          // Pull cardinality/required hints from the schema's computed declaration:
          // `multi title5 := …` produces a multi shape element, even when the query
          // doesn't repeat the modifier.
          const computedDecl = ctx.schema
            ?.getType(subject.typeref.id)
            ?.computeds
            ?.find((c) => c.kind === "property" && c.name === el.name);
          const declMulti = computedDecl?.multi === true;
          const declRequired = computedDecl?.required === true;
          const inferredMulti = declMulti || computedSet.typeref.collection === "array";
          const cardinality: Cardinality = inferredMulti
            ? (declRequired ? "at_least_one" : "many")
            : (declRequired ? "one" : "at_most_one");
          out.push({
            kind: "shape_element",
            source: subject,
            expr: withShapeModifiers(computedSet, el),
            name: el.name,
            shapeOp: el.operation,
            shapeOrigin: resolveShapeOrigin(el),
            required: el.required ?? declRequired,
            cardinality: el.cardinality ?? cardinality,
          });
          continue;
        }
        // Re-projecting a WITH binding's computed pointer (`select X {name, b}`
        // where X := User { …, b := … }): the field isn't on the schema type,
        // but the binding's compiled shape carries the element — adopt it so
        // the projection keeps the computed value.
        const carried = gatherBindingShape(subject).find((s) => {
          const carriedName = s.name
            ?? (s.expr.expr.kind === "pointer" ? (s.expr.expr as Pointer).ptrref.shortName : undefined);
          return carriedName === el.name;
        });
        if (carried) {
          out.push({
            ...carried,
            shapeOp: el.operation,
            shapeOrigin: resolveShapeOrigin(el),
            name: el.name,
          });
          continue;
        }
        // `SELECT User { missing }` — user spelled a field name that doesn't
        // exist on the source type. Silently skipping turned every typo into
        // an empty-but-passing shape; surface it so query authors learn at
        // compile time. Guarded: `id`/`__type__` are implicit on every object
        // and resolved by the SQL projection itself; non-schema types
        // (`unknown:*`, tuple wrappers, computed binding aliases) don't have a
        // resolvable member list, so we can't tell whether the field is real.
        if (shouldEnforceShapeMember(el, subject, ctx)) {
          throw new AppError(
            "E_SEMANTIC",
            `object type '${subject.typeref.id}' has no link or property '${el.name}'`,
            1,
            1,
          );
        }
        continue;
      }
      const expr = extendPathSet(subject, ptrref);
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(expr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? (effectivePointerCardinality(ptrref) === "one"),
        cardinality: el.cardinality ?? effectivePointerCardinality(ptrref),
        // Project under the requested field name. For a plain field this equals
        // `ptrref.shortName`, but a computed link alias (`winner := .<awards`)
        // resolves to a pointer whose `shortName` is the underlying link
        // (`awards`); without `name` the SQL emitter would label the column
        // `awards`, breaking `GROUP … BY .winner` and `.key.winner`.
        name: el.name,
      });
      continue;
    }

    if (el.kind === "computed") {
      if (el.name.startsWith("@")) {
        if (subject.expr.kind !== "pointer") {
          const fieldCtx = childScope(ctx);
          // Bind the link-target row as the current item so `.`-paths inside
          // the link-property value (`@rolp10 := 100 - <int64>.val[-1]`)
          // resolve against the target (C), not the outer mutation subject.
          bindValue(fieldCtx, "__current__", subject);
          bindValue(fieldCtx, "__subject__", subject);
          const subjectType = getResolvedSchemaType(ctx, subject.typeref.id);
          if (subjectType) {
            for (const field of subjectType.fields) {
              if (resolveBinding(ctx, field.name)) {
                continue;
              }
              const ptrref = resolvePointerRef(ctx, subject.typeref, field.name);
              if (ptrref) {
                bindValue(fieldCtx, field.name, extendPathSet(subject, ptrref));
              }
            }
          }
          const compiledExpr = compileFreeObjectExpr(el.expr, fieldCtx);
          out.push({
            kind: "shape_element",
            source: subject,
            expr: compiledExpr,
            shapeOp: el.operation,
            shapeOrigin: resolveShapeOrigin(el),
            required: el.required ?? false,
            cardinality: el.cardinality ?? "at_most_one",
            name: el.name,
          });
          continue;
        }
        const result = compileLinkPropertyExpr(el);
        if (result) {
          out.push(result);
        }
        continue;
      }
      validateComputedShapeElement(el, subject, ctx);
      if (el.expr.kind === "field_ref") {
        const fieldName = el.expr.field;
        const ptrref = resolvePointerRef(ctx, subject.typeref, fieldName);
        if (!ptrref) {
          // Not a schema pointer — may be a computed the binding materialised
          // in its body (`l := C.len` where C := (for … select T { len := … })).
          // Adopt the carried element so the key resolves; the FOR lowering
          // re-projects it correlated against the iterated element.
          const carried = gatherBindingShape(subject).find((s) => {
            const carriedName = s.name
              ?? (s.expr.expr.kind === "pointer" ? (s.expr.expr as Pointer).ptrref.shortName : undefined);
            return carriedName === fieldName;
          });
          if (carried) {
            out.push({ ...carried, shapeOp: el.operation, shapeOrigin: resolveShapeOrigin(el), name: el.name });
          }
          continue;
        }
        const expr = extendPathSet(subject, ptrref);
        out.push({
          kind: "shape_element",
          source: subject,
          expr: withShapeModifiers(expr, el),
          shapeOp: el.operation,
          shapeOrigin: resolveShapeOrigin(el),
          required: el.required ?? false,
          cardinality: el.cardinality ?? (el.multi ? "many" : ptrref.outCardinality),
          name: el.name,
        });
        continue;
      }
      const computedCtx = childScope(ctx);
      // Carry prior SIBLING computeds (no backing pointer) on the current
      // item so a later computed can read them (`b := (…), d := .b.d`) —
      // field_access falls back to the shape lookup when pointer resolution
      // fails. Only pointer-less computeds: real pointers must keep
      // resolving through the schema, not the projected shape.
      const siblingComputeds = out.filter((prior) =>
        prior.name !== undefined && prior.targetPtr === undefined && prior.shapeOrigin === "explicit"
        && prior.expr.expr.kind !== "pointer");
      const shapedSubject = siblingComputeds.length > 0 ? { ...subject, shape: siblingComputeds } : subject;
      bindValue(computedCtx, "__subject__", shapedSubject);
      bindValue(computedCtx, "__current__", shapedSubject);
      const compiledExpr = compileFreeObjectExpr(el.expr, computedCtx);
      // Computed shape elements without an explicit `multi`/`single` mod
      // used to default to `at_most_one`, which made `owner_of := X.<owner`
      // collapse to a single object even when the backlink fans out. Sniff
      // the compiled expression for a clearly-many shape (backlink, multi
      // pointer, link-table walk) and use `many` instead.
      const inferredMany = inferComputedShapeIsMany(compiledExpr);
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(compiledExpr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? false,
        cardinality: el.cardinality ?? (el.multi || inferredMany ? "many" : "at_most_one"),
        name: el.name,
      });
      continue;
    }

    if (el.kind === "link") {
      // `__type__: { name }` — every object has an implicit link to its
      // schema::ObjectType. We don't materialize that type, but the source
      // row's __source_type column already carries the qualified type name,
      // so synthesize a shape element with a marker ptrref that the SQL
      // compiler unwraps into a tiny json_object.
      if (el.name === "__type__") {
        out.push(synthesizeTypeLinkShapeElement(subject, el));
        continue;
      }
      const ptrref = resolvePointerRef(ctx, subject.typeref, el.name);
      // `User { todo: { name: { bogus } } }` — `name` is a scalar so it
      // can't carry a nested shape. EdgeQL reports this as
      // "shapes cannot be applied to scalar type 'std::str'".
      if (ptrref && ptrref.outTarget.isScalar && el.shape && el.shape.length > 0) {
        throw new AppError(
          "E_SEMANTIC",
          `shapes cannot be applied to scalar type '${ptrref.outTarget.id.startsWith("unknown:") ? ptrref.outTarget.id.slice("unknown:".length) : ptrref.outTarget.id}'`,
          1,
          1,
        );
      }
      if (!ptrref) {
        // Re-projecting a WITH binding's computed pointer with a sub-shape
        // (`select X { b: {c, d} }` where X := User { b := {…} }): adopt the
        // binding's carried element, as in the field branch above.
        const carried = gatherBindingShape(subject).find((s) => {
          const carriedName = s.name
            ?? (s.expr.expr.kind === "pointer" ? (s.expr.expr as Pointer).ptrref.shortName : undefined);
          return carriedName === el.name;
        });
        if (carried) {
          // The written sub-shape (`b: {c}`) selects which fields of the
          // carried value stay visible — record it on the adopted expr so
          // the SQL stage filters tuple fields accordingly.
          const subShape = el.shape && el.shape.length > 0 && carried.expr.expr.kind === "tuple"
            ? el.shape
                .filter((sub): sub is Extract<EdgeQLShapeElement, { name: string }> =>
                  "name" in sub && typeof sub.name === "string" && sub.kind === "field")
                .map((sub): ShapeElement => ({
                  kind: "shape_element",
                  source: carried.expr,
                  expr: carried.expr,
                  name: sub.name,
                  shapeOp: "assign",
                  shapeOrigin: "explicit",
                  required: false,
                  cardinality: "one",
                } as ShapeElement))
            : undefined;
          out.push({
            ...carried,
            expr: subShape && subShape.length === (el.shape ?? []).length
              ? { ...carried.expr, shape: subShape }
              : carried.expr,
            shapeOp: el.operation,
            shapeOrigin: resolveShapeOrigin(el),
            name: el.name,
          });
          continue;
        }
        // Links with nested shapes can resolve dynamically (subtype-only
        // pointers reached through `[IS T]`, computed link aliases, etc.) —
        // skip the strict check here. The field-level check above is enough
        // to catch the common typo case.
        continue;
      }
      let expr = extendPathSet(subject, ptrref);
      // `owners[IS Bot]: {…}` — narrow the link set's typeref to the
      // intersection type before the nested shape resolves, so subtype-only
      // pointers are visible and the SQL stage scans only the narrowed
      // type's tables (see narrowedLinkTarget in the SQL compiler).
      if (el.typeFilter) {
        const narrowed = resolveTypeRef(ctx, el.typeFilter);
        if (narrowed && !narrowed.id.startsWith("unknown:") && narrowed.id !== expr.typeref.id) {
          expr = { ...expr, typeref: narrowed };
        }
      }
      if (el.shape && el.shape.length > 0) {
        // An explicit nested shape is bounded by the written query, so it's
        // safe to descend even into self-referential links (`Tree { children:
        // { children: {…} } }`); the `seenTypeIds` cycle guard only needs to
        // constrain implicit splat expansion, not user-written nesting.
        const nextSeen = new globalThis.Set(seenTypeIds);
        nextSeen.add(expr.typeref.id);
        expr = {
          ...expr,
          shape: compileShape(expr, el.shape, ctx, nextSeen),
        };
      }
      // A computed link alias that expands to a bare backlink (`multi link
      // children := .<parent[IS Tree]`) resolves to the *forward* link's
      // ptrref (here `parent`), so its `outCardinality` describes the forward
      // direction (single). Traversed backward, the effective cardinality is
      // the forward link's `inCardinality` (many unless the forward link is
      // exclusive).
      const linkCardinality = ptrref.computedLinkAliasIsBackward
        ? ptrref.inCardinality
        : ptrref.outCardinality;
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(expr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? (linkCardinality === "one"),
        cardinality: el.cardinality ?? linkCardinality,
        name: el.name,
      });
      continue;
    }

    if (el.kind === "backlink") {
      const ptrref = resolveBacklinkPointerRef(ctx, subject.typeref, el.expr.link, el.expr.sourceType);
      if (!ptrref) {
        continue;
      }
      let expr = extendPathSetDirectional(subject, ptrref, "inbound");
      if (el.shape && el.shape.length > 0) {
        const nextSeen = new globalThis.Set(seenTypeIds);
        const canDescend = true;
        nextSeen.add(expr.typeref.id);
        if (canDescend) {
          expr = {
            ...expr,
            shape: compileShape(expr, el.shape, ctx, nextSeen),
          };
        }
      }
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(expr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? false,
        cardinality: el.cardinality ?? ptrref.inCardinality,
        // A named backlink computable (`w_of := .<w[IS X] {…}`) carries its
        // alias on the AST element; without this the projection would fall
        // back to the link's own short name (`w`).
        name: el.name,
      });
      continue;
    }

    if (el.kind === "splat") {
      const expanded = expandSplat(el);
      if (expanded.length > 0) {
        out.push(...expanded);
      } else {
        // A splat that expands to nothing on a real object type means every
        // member it would project is already listed explicitly (e.g.
        // `User { *, id, name }`, where `*` is fully shadowed by the explicit
        // `id`/`name`). The explicit elements cover the projection, so emit
        // nothing. The whole-subject fallback below only makes sense for an
        // opaque set with no resolvable members (scalar / computed value),
        // where `json(value)` on a bare object id would be malformed JSON.
        const splatType = el.sourceType ? resolveTypeRef(ctx, el.sourceType) : subject.typeref;
        const isObjectType = Boolean(getResolvedSchemaType(ctx, splatType.id) ?? ctx.schema?.getType(splatType.id));
        if (!isObjectType) {
          out.push({
            kind: "shape_element",
            source: subject,
            expr: withShapeModifiers(subject, el),
            shapeOp: el.operation,
            shapeOrigin: resolveShapeOrigin(el),
            required: el.required ?? false,
            cardinality: el.cardinality ?? "unknown",
          });
        }
      }
    }
  }
  // Validate that all `[is T].*` splats in this shape are mutually related
  // (one is a subtype of another, or both share a subject-type ancestor).
  // The catch-all `select Object { [is User].*, [is Issue].* }` test exercises
  // this — User and Issue are unrelated, so EdgeQL surfaces an error rather
  // than producing an ill-typed projection.
  validateSplatTypeIntersections(subject, shape, ctx);
  return out;
};

const compileInsertValue = (value: InsertValue, ctx: IRCompileContext, seenInsertTypes: globalThis.Set<string> = new globalThis.Set<string>()): Set => {
  if (value && typeof value === "object") {
    if ("kind" in value) {
      if (value.kind === "set") {
        const compiled = value.values.map((entry) => compileInsertValue(entry, ctx, seenInsertTypes));
        return compileSetConstructor(compiled, "insert_set");
      }
      if (value.kind === "binding_ref") {
        return compileFreeObjectExpr({ kind: "binding_ref", name: value.name }, ctx);
      }
      if (value.kind === "function_call") {
        return compileFreeObjectExpr({ kind: "function_call", call: value.call }, ctx);
      }
      if (value.kind === "expr") {
        return compileFreeObjectExpr(value.expr, ctx);
      }
      if (value.kind === "select") {
        const bound = resolveBinding(ctx, value.typeName);
        const subjectSet = bound ?? setFromTypeRoot(resolveTypeRef(ctx, value.typeName));
        return {
          ...subjectSet,
          shape: value.shape.length > 0 ? compileShape(subjectSet, value.shape, ctx) : subjectSet.shape,
        };
      }
      if (value.kind === "insert") {
        const subject = resolveTypeRef(ctx, value.typeName);
        if (seenInsertTypes.has(subject.id)) {
          return setFromTypeRoot(subject);
        }

        const nextSeen = new Set(seenInsertTypes);
        nextSeen.add(subject.id);

        const subjectSet = setFromTypeRoot(subject);
        const shape: ShapeElement[] = Object.entries(value.values).map(([name, nestedValue]) => {
          const ptrref = resolvePointerRef(ctx, subject, name);
          const nestedExpr = compileInsertValue(nestedValue, ctx, nextSeen);
          return {
            kind: "shape_element",
            source: subjectSet,
            expr: nestedExpr,
            shapeOp: "assign",
            shapeOrigin: "explicit",
            required: ptrref?.outCardinality === "one",
            cardinality: ptrref?.outCardinality ?? "unknown",
          };
        });

        return {
          kind: "set",
          expr: {
            kind: "insert_expr",
            subject,
            shape,
          },
          pathId: defaultPathId(`insert:${subject.id}`),
          typeref: subject,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        };
      }
      if (value.kind === "array_literal") {
        return literalToSet(value.values.length);
      }
      if (value.kind === "tuple_literal") {
        return literalToSet(Array.isArray(value.values) ? value.values.length : Object.keys(value.values).length);
      }
      if (value.kind === "for") {
        return compileFreeObjectExpr({ kind: "for_expr", variable: value.variable, iterator: value.iteratorExpr, body: { kind: "literal", value: null }, optional: value.optional }, ctx);
      }
    }
  }
  return literalToSet(value as string | number | boolean | null);
};

const compileSelectExprStatement = (statement: Extract<EdgeQLStatement, { kind: "select_expr" }>, ctx: IRCompileContext): SelectStmt => {
  const scoped = withBindings(ctx, statement.with);
  const result = compileFreeObjectExpr(statement.expr, scoped);
  // `SELECT _ := EXPR ORDER BY _` — the result alias (`_`) is only bound while
  // compiling the subquery's own clauses, so the outer ORDER BY can't see it
  // and `_` collapses to a bare type-root (dropping the sort). Bind the alias
  // to the compiled result for the ORDER BY scope so it sorts by the value.
  const orderCtx = childScope(scoped);
  if (statement.expr.kind === "select_expr_subquery" && statement.expr.alias) {
    bindValue(orderCtx, statement.expr.alias, result);
    bindValue(orderCtx, "__current__", result);
    bindValue(orderCtx, "__subject__", result);
  }
  // Statement clauses over group rows (`SELECT (GROUP …){…} FILTER .count > 1
  // ORDER BY .key.cost`) compile with the group row as __current__ so paths
  // resolve to group_row_field steps the SQL stage can read off the row JSON.
  // Scoped to group rows: other select_expr statements keep their existing
  // clause handling (inside the subquery wrapper).
  let groupWhere: Set | undefined;
  if (peelToGroupRows(result)) {
    bindValue(orderCtx, "__current__", result);
    bindValue(orderCtx, "__subject__", result);
    if (statement.filter) {
      groupWhere = compileFilterToSet(statement.filter, result, orderCtx);
    }
  }
  return {
    kind: "select_stmt",
    expr: result,
    ...statementBase(scoped),
    where: groupWhere,
    orderBy: compileOrderBy(statement, orderCtx),
    implicitWrapper: false,
    span: statement.pos,
  };
};

// EdgeQL semantics treat `SELECT AliasName { shape } FILTER outer` as if
// `AliasName` were textually replaced by its body. We perform that expansion
// once at the AST level so the rest of compilation never has to know that
// `AliasName` was an alias: typeName becomes the alias's source type, the
// alias body's filter is AND'd with the outer filter, the alias body's
// computed/link shape elements replace outer field references of the same
// name (so the outer can project an alias-defined field by name), and any
// outer-unset orderBy/limit/offset is inherited from the alias body.
// Recursive aliases are detected via the `visited` set.
export const expandSchemaAliasesInStatement = (
  statement: EdgeQLStatement,
  schema: SchemaSnapshot,
  defaultModule = "default",
): EdgeQLStatement => {
  const ctx: IRCompileContext = {
    module: (statement as { withModule?: string }).withModule ?? defaultModule,
    schema,
    nextScopeId: 1,
    params: new Map(),
    globals: new Map(),
    bindingScopes: [new Map()],
  };
  if (statement.kind === "select") {
    return expandAliasInSelectStatement(statement, ctx, new globalThis.Set<string>());
  }
  if (statement.kind === "select_free") {
    return {
      ...statement,
      entries: statement.entries.map((entry) => ({
        ...entry,
        expr: expandAliasInFreeObjectExpr(entry.expr, ctx),
      })),
    };
  }
  if (statement.kind === "select_expr") {
    return {
      ...statement,
      expr: expandAliasInFreeObjectExpr(statement.expr, ctx),
    };
  }
  return statement;
};

const expandAliasInFreeObjectExpr = (
  expr: FreeObjectExpr,
  ctx: IRCompileContext,
): FreeObjectExpr => {
  if (expr.kind === "select_expr_subquery") {
    return { ...expr, expr: expandAliasInFreeObjectExpr(expr.expr, ctx) };
  }
  if (expr.kind === "field_access") {
    return { ...expr, expr: expandAliasInFreeObjectExpr(expr.expr, ctx) };
  }
  if (expr.kind === "select") {
    const synthetic: SelectStatement = {
      kind: "select",
      with: expr.clauses._withBindings,
      withModule: expr.clauses._withModule,
      withModuleAliases: expr.clauses._withModuleAliases,
      typeName: expr.typeName,
      shape: expr.shape,
      fields: [],
      filter: expr.clauses.filter,
      orderBy: expr.clauses.orderBy,
      limit: expr.clauses.limit,
      offset: expr.clauses.offset,
      limitExpr: expr.clauses.limitExpr,
      offsetExpr: expr.clauses.offsetExpr,
      pos: { line: 0, column: 0 },
    };
    const expanded = expandAliasInSelectStatement(synthetic, ctx, new globalThis.Set<string>());
    return {
      kind: "select",
      typeName: expanded.typeName,
      shape: expanded.shape,
      clauses: {
        ...expr.clauses,
        filter: expanded.filter,
        orderBy: expanded.orderBy,
        limit: expanded.limit,
        offset: expanded.offset,
        limitExpr: expanded.limitExpr,
        offsetExpr: expanded.offsetExpr,
        _withBindings: expanded.with ?? expr.clauses._withBindings,
        _withModule: expanded.withModule ?? expr.clauses._withModule,
        _withModuleAliases: expanded.withModuleAliases ?? expr.clauses._withModuleAliases,
      },
    };
  }
  return expr;
};

// Walk a FreeObjectExpr, replacing each `current_item` node with `newRoot`.
// Used when inlining a shape-defined computed expression into a FILTER path: a
// computed like `name_upper := str_upper(.name)` is written against the
// computed link's target (`.name` is relative to a winner row), so when we lift
// it into the outer FILTER scope (`.winner.name_upper = ...`) we have to
// rebind `.name` to `.winner.name`.
const substituteCurrentItemInFreeExpr = (
  expr: FreeObjectExpr,
  newRoot: FreeObjectExpr,
): FreeObjectExpr => {
  const rec = (e: FreeObjectExpr): FreeObjectExpr => substituteCurrentItemInFreeExpr(e, newRoot);
  switch (expr.kind) {
    case "current_item":
      return newRoot;
    case "field_access":
      return { ...expr, expr: rec(expr.expr) };
    case "function_call":
      return {
        ...expr,
        call: {
          ...expr.call,
          args: expr.call.args.map((arg) => {
            if (arg.kind === "expr") return { ...arg, expr: rec(arg.expr) };
            if (arg.kind === "function_call") {
              const innerCall = substituteCurrentItemInFreeExpr({ kind: "function_call", call: arg.call }, newRoot);
              return innerCall.kind === "function_call" ? { kind: "function_call", call: innerCall.call } : arg;
            }
            return arg;
          }),
        },
      };
    case "compare":
    case "math":
    case "and":
    case "or":
    case "coalesce":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "not":
    case "exists":
    case "distinct":
    case "cast":
    case "unary":
      return { ...expr, expr: rec(expr.expr) };
    case "if_else":
      return { ...expr, condition: rec(expr.condition), thenExpr: rec(expr.thenExpr), elseExpr: rec(expr.elseExpr) };
    case "concat":
      return { ...expr, parts: expr.parts.map(rec) };
    case "tuple":
    case "set_expr":
    case "array_literal_expr":
      return { ...expr, values: expr.values.map(rec) };
    case "index_access":
    case "slice_access":
    case "shape_projection":
    case "is_type":
      return { ...expr, expr: rec(expr.expr) };
    default:
      // Other kinds (literal, binding_ref, path, etc.) carry no current_item
      // references in well-formed shape-computed bodies.
      return expr;
  }
};

// Convert a parser FilterValue into the FreeObjectExpr form `compare` accepts.
// Returns undefined for value shapes we can't inline (set literals, sub-selects
// inside the comparison RHS — the existing predicate path handles those).
const filterValueToFreeObjectExpr = (value: FilterValue): FreeObjectExpr | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return { kind: "literal", value };
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  if (typeof value === "object" && value !== null && "kind" in value) {
    if (value.kind === "binding_ref") {
      return { kind: "binding_ref", name: value.name };
    }
  }
  return undefined;
};

// Pull the inner shape from a `winner := <expr> { ... }` style computed body.
const innerShapeOfComputedBody = (
  body: ComputedExpr | FreeObjectExpr,
): EdgeQLShapeElement[] | undefined => {
  if ((body as { kind?: string }).kind === "select_expr") {
    return innerShapeOfComputedBody((body as { expr: FreeObjectExpr }).expr);
  }
  if ((body as { kind?: string }).kind === "shape_projection") {
    return (body as { shape: EdgeQLShapeElement[] }).shape;
  }
  return undefined;
};

// Substitute alias-defined shape computeds into a FILTER expression so the
// rewritten filter compiles through the standard SQL path. Specifically: a
// FILTER target like `linkName.fieldName` where `linkName` is a computed shape
// element on the surrounding select and `fieldName` is a computed property in
// its inner shape gets lifted into the equivalent free-expression form
// (`<inner-computed-expr-with-current_item→linkName>` `op` `value`).
export const rewriteFilterThroughShapeComputeds = (
  filter: FilterExpr,
  shape: EdgeQLShapeElement[],
): FilterExpr => {
  if (filter.kind === "and" || filter.kind === "or") {
    return {
      ...filter,
      left: rewriteFilterThroughShapeComputeds(filter.left, shape),
      right: rewriteFilterThroughShapeComputeds(filter.right, shape),
    };
  }
  if (filter.kind === "not") {
    return { ...filter, expr: rewriteFilterThroughShapeComputeds(filter.expr, shape) };
  }
  if (filter.kind !== "predicate" || filter.target.kind !== "field") {
    return filter;
  }
  const parts = filter.target.field.split(".");
  if (parts.length !== 2) return filter;
  const [linkName, propName] = parts;
  const shapeEl = shape.find((el) => "name" in el && el.name === linkName);
  if (!shapeEl || shapeEl.kind !== "computed") return filter;
  const innerShape = innerShapeOfComputedBody(shapeEl.expr);
  if (!innerShape) return filter;
  const innerEl = innerShape.find((el) => "name" in el && el.name === propName);
  if (!innerEl || innerEl.kind !== "computed") return filter;
  const valueExpr = filterValueToFreeObjectExpr(filter.value);
  if (!valueExpr) return filter;
  // Only inline computed bodies whose AST is already a FreeObjectExpr — i.e.
  // ComputedExpr shapes that overlap with FreeObjectExpr (function_call,
  // literal). Other ComputedExpr-only kinds (field_ref, polymorphic_field_ref,
  // …) would need translation, which the runtime bypass already handles.
  const innerExpr = innerEl.expr;
  if (innerExpr.kind !== "function_call" && innerExpr.kind !== "literal") {
    return filter;
  }
  const newRoot: FreeObjectExpr = {
    kind: "field_access",
    expr: { kind: "current_item" },
    field: linkName,
    optional: false,
  };
  const substituted = substituteCurrentItemInFreeExpr(innerExpr as FreeObjectExpr, newRoot);
  return {
    kind: "free_expr",
    expr: {
      kind: "compare",
      op: filter.op,
      left: substituted,
      right: valueExpr,
    },
  };
};

// Eagerly applies the alias-shape FILTER rewrite to a parsed SELECT so the
// downstream pipeline (in particular the AST interpreter `tryEvaluateParsed
// RuntimeSelect`, which gates on FILTER shape) sees the inlined free
// expression form. Mirrors what `expandAliasInSelectStatement` does for the
// SQL path. Idempotent: returns the input unchanged when nothing can be
// rewritten.
export const rewriteAliasFilterEagerly = (
  statement: SelectStatement,
  schema: SchemaSnapshot,
  defaultModule = "default",
): SelectStatement => {
  if (!statement.filter) return statement;
  const aliasName = qualifyTypeName(statement.typeName, statement.withModule ?? defaultModule);
  const alias = schema.getAlias(aliasName);
  if (!alias?.exprText) return statement;
  let body = alias.exprText.trim();
  if (body.endsWith(";")) body = body.slice(0, -1).trim();
  while (body.startsWith("(") && body.endsWith(")")) {
    const inner = body.slice(1, -1).trim();
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
    body = inner;
  }
  let aliasAst: EdgeQLStatement | undefined;
  for (const candidate of [body, `SELECT ${body}`]) {
    const parsed = tryResult(() => parseEdgeQL(candidate));
    if (!parsed.ok) continue; // query failure only — try next candidate
    if (parsed.value.kind === "select") { aliasAst = parsed.value; break; }
  }
  if (!aliasAst || aliasAst.kind !== "select") return statement;
  const aliasBodyShape = aliasAst.shape;
  const rewritten = rewriteFilterThroughShapeComputeds(statement.filter, aliasBodyShape);
  if (rewritten === statement.filter) return statement;
  return { ...statement, filter: rewritten };
};

const expandAliasInSelectStatement = (
  statement: SelectStatement,
  ctx: IRCompileContext,
  visited: globalThis.Set<string>,
): SelectStatement => {
  if (!ctx.schema) return statement;
  const qualified = qualifyTypeName(statement.typeName, statement.withModule ?? ctx.module);
  if (visited.has(qualified)) return statement;
  const alias = ctx.schema.getAlias(qualified);
  if (!alias?.exprText) return statement;

  let body = alias.exprText.trim();
  if (body.endsWith(";")) {
    body = body.slice(0, -1).trim();
  }
  while (body.startsWith("(") && body.endsWith(")")) {
    const inner = body.slice(1, -1).trim();
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
    body = inner;
  }

  // Alias bodies in the SDL can omit the leading `SELECT` keyword
  // (`alias SpecialCardAlias := SpecialCard { ... }`, `alias AwardAlias := (Award { ... })`).
  // Try parsing the body as-is first, then with `SELECT ` prepended.
  let aliasAst: EdgeQLStatement | undefined;
  for (const candidate of [body, `SELECT ${body}`]) {
    const parsed = tryResult(() => parseEdgeQL(candidate));
    if (!parsed.ok) continue; // query failure only — try next candidate
    if (parsed.value.kind === "select") {
      aliasAst = parsed.value;
      break;
    }
  }
  if (!aliasAst) return statement;

  visited.add(qualified);
  const expandedAlias = expandAliasInSelectStatement(aliasAst as SelectStatement, ctx, visited);

  const aliasShapeByName = new Map<string, EdgeQLShapeElement>();
  for (const element of expandedAlias.shape) {
    if ("name" in element) {
      aliasShapeByName.set(element.name, element);
    }
  }

  // When outer's link `winner: { outerShape }` matches an alias-defined
  // `winner := <expr> { aliasInnerShape }`, the result needs to use the
  // alias's expression (so winner's source is the alias-defined backlink/
  // computed) but project the outer's requested shape. Recursively merge
  // outerShape with aliasInnerShape so any outer field-ref that names an
  // alias-defined computed inside the inner shape is swapped for its
  // definition.
  const mergeNestedShape = (
    outerInnerShape: EdgeQLShapeElement[],
    aliasInnerShape: EdgeQLShapeElement[],
  ): EdgeQLShapeElement[] => {
    const innerByName = new Map<string, EdgeQLShapeElement>();
    for (const el of aliasInnerShape) {
      if ("name" in el) innerByName.set(el.name, el);
    }
    return outerInnerShape.map((outerInner) => {
      if (!("name" in outerInner) || outerInner.kind !== "field") return outerInner;
      const aliasInner = innerByName.get(outerInner.name);
      if (aliasInner && (aliasInner.kind === "computed" || aliasInner.kind === "link" || aliasInner.kind === "backlink")) {
        return aliasInner;
      }
      return outerInner;
    });
  };

  // Locate the inner shape inside an alias's computed expression
  // (`select_expr → shape_projection { shape: [...] }`). Returns null if the
  // expression isn't a shape-bearing form we know how to merge into.
  const computedInnerShape = (expr: ComputedExpr | FreeObjectExpr): EdgeQLShapeElement[] | null => {
    if (expr.kind === "select_expr") {
      return computedInnerShape(expr.expr);
    }
    if (expr.kind === "shape_projection") {
      return expr.shape;
    }
    return null;
  };

  const rewriteComputedInnerShape = (
    expr: ComputedExpr | FreeObjectExpr,
    nextShape: EdgeQLShapeElement[],
  ): ComputedExpr | FreeObjectExpr => {
    if (expr.kind === "select_expr") {
      return { ...expr, expr: rewriteComputedInnerShape(expr.expr, nextShape) as FreeObjectExpr };
    }
    if (expr.kind === "shape_projection") {
      return { ...expr, shape: nextShape };
    }
    return expr;
  };

  // When the outer query has no explicit shape (parser-default `[{id, origin:
  // "default"}]`), `SELECT Alias` means "select the alias body" — adopt the
  // alias's body shape verbatim so alias-defined computeds (e.g.
  // `SpecialCardAlias.el_cost`) are projected onto each row.
  const outerShapeIsImplicit = statement.shape.length > 0
    && statement.shape.every((el) =>
      "name" in el && (el as { origin?: string }).origin === "default",
    );

  const mergedShape: EdgeQLShapeElement[] = [];
  if (outerShapeIsImplicit) {
    mergedShape.push(...expandedAlias.shape);
  } else {
    for (const outerEl of statement.shape) {
      if (!("name" in outerEl)) {
        mergedShape.push(outerEl);
        continue;
      }
      const aliasEl = aliasShapeByName.get(outerEl.name);
      // A plain `field` reference in the outer shape that names a computed or
      // link defined on the alias body should use the alias's definition,
      // since the outer query is asking to project that named value.
      if (outerEl.kind === "field"
        && aliasEl
        && (aliasEl.kind === "computed" || aliasEl.kind === "link" || aliasEl.kind === "backlink")) {
        mergedShape.push(aliasEl);
        continue;
      }
      // An outer link/backlink with nested shape matched against an alias-
      // defined computed: keep the alias's expression but merge the outer's
      // nested projections into the alias's inner shape so the outer's
      // explicit projection (`winner: { name }`) wins over the alias's
      // default inner shape (`{ name_upper := ... }`).
      if ((outerEl.kind === "link" || outerEl.kind === "backlink") && aliasEl?.kind === "computed") {
        const outerInner = (outerEl as { shape?: EdgeQLShapeElement[] }).shape ?? [];
        const aliasInner = computedInnerShape(aliasEl.expr);
        if (aliasInner) {
          const merged = mergeNestedShape(outerInner, aliasInner);
          mergedShape.push({
            ...aliasEl,
            expr: rewriteComputedInnerShape(aliasEl.expr, merged) as ComputedExpr,
          });
          continue;
        }
        mergedShape.push(aliasEl);
        continue;
      }
      mergedShape.push(outerEl);
    }
  }

  const mergedFilterRaw = statement.filter && expandedAlias.filter
    ? { kind: "and" as const, left: expandedAlias.filter, right: statement.filter }
    : statement.filter ?? expandedAlias.filter;
  const mergedFilter = mergedFilterRaw
    ? rewriteFilterThroughShapeComputeds(mergedFilterRaw, mergedShape)
    : mergedFilterRaw;

  return {
    ...statement,
    typeName: expandedAlias.typeName,
    shape: mergedShape,
    fields: [...new globalThis.Set([...(expandedAlias.fields ?? []), ...statement.fields])],
    filter: mergedFilter,
    orderBy: statement.orderBy ?? expandedAlias.orderBy,
    limit: statement.limit ?? expandedAlias.limit,
    offset: statement.offset ?? expandedAlias.offset,
    limitExpr: statement.limitExpr ?? expandedAlias.limitExpr,
    offsetExpr: statement.offsetExpr ?? expandedAlias.offsetExpr,
  };
};

const compileSelectStatement = (rawStatement: SelectStatement, ctx: IRCompileContext): SelectStmt => {
  const statement = expandAliasInSelectStatement(rawStatement, ctx, new globalThis.Set<string>());
  const scoped = withBindings(ctx, statement.with);
  // `select Foo { ... }` may name either a type or a WITH-bound expression
  // (e.g. `with GR := (...) select GR { key }`). Prefer the binding when
  // it exists so the subject inherits the bound set's expression.
  const bound = resolveBinding(scoped, statement.typeName);
  if (!bound) {
    // `SELECT Usr` against a non-existent type: the IR builder used to fall
    // back to `unknownTypeRef`, which then produced an ugly
    // `no such table: default__usr` from SQLite. Surface the EdgeQL-shaped
    // message instead.
    if (ctx.schema) {
      const qualified = qualifyTypeName(statement.typeName, ctx.module);
      const typeDef = getSchemaType(scoped, qualified) ?? ctx.schema.getType(qualified);
      const universal = isUniversalObjectRefName(statement.typeName);
      if (!typeDef && !universal && !statement.typeName.startsWith("schema::")) {
        throw new AppError(
          "E_SEMANTIC",
          `object type or alias '${qualified}' does not exist`,
          1,
          1,
        );
      }
    }
  }
  const subject = bound ?? setFromTypeRoot(resolveTypeRef(scoped, statement.typeName));
  bindValue(scoped, "__subject__", subject);
  bindValue(scoped, "__current__", subject);
  const shaped = compileShape(subject, statement.shape, scoped);
  // Expose the computed shape elements to FILTER / ORDER BY so `.n1` etc.
  // resolve to the corresponding shape entry rather than failing with a
  // "no link or property" error. The non-shaped `subject` continues to
  // back path-sharing inside the shape itself.
  const shapedSubject: Set = shaped.length > 0 ? { ...subject, shape: shaped } : subject;
  if (shaped.length > 0) {
    bindValue(scoped, "__current__", shapedSubject);
    bindValue(scoped, "__subject__", shapedSubject);
  }
  const compileOrderEntry = (entry: OrderExpr): SortExpr => {
    // The parser stamps `field = "__expr__"` when ORDER BY carries an
    // arbitrary expression (`ORDER BY count(...)`), with the real expr
    // hanging off `entry.expr`. Falling back to resolvePointerRef on the
    // sentinel name would drop the order; route through compileFreeObjectExpr
    // so complex paths survive.
    let path: Set;
    if (entry.expr) {
      path = compileFreeObjectExpr(entry.expr, scoped);
    } else if (entry.field) {
      // Walk dotted paths (`priority.name`) segment by segment so link
      // traversals become pointer chains instead of degrading to a NULL
      // literal (which sorts every row identically).
      const segments = entry.field.split(".");
      let cursor: Set | undefined = subject;
      for (const segment of segments) {
        if (!cursor) break;
        const ptrref = resolvePointerRef(scoped, cursor.typeref, segment);
        cursor = ptrref ? extendPathSet(cursor, ptrref) : undefined;
      }
      if (cursor) {
        path = cursor;
      } else {
        // The path may step through a computed shape element (`.key.name`
        // where `key := {…}`), which isn't a schema pointer. Resolve it as a
        // leading-dot field access against the shaped subject — the same way
        // FILTER does (compileFreeObjectExpr consults the bound __subject__'s
        // shape computeds).
        let node: FreeObjectExpr = { kind: "current_item" };
        for (const segment of segments) {
          node = { kind: "field_access", expr: node, field: segment, optional: false };
        }
        path = compileFreeObjectExpr(node, scoped);
      }
    } else {
      path = literalToSet(null);
    }
    return {
      kind: "sort_expr",
      path,
      direction: entry.direction,
      nonesOrder: entry.nullsPosition ?? (entry.direction === "desc" ? "last" : "first"),
    };
  };
  const orderBy: SortExpr[] | undefined = (() => {
    if (!statement.orderBy) return undefined;
    const out: SortExpr[] = [];
    let cursor: OrderExpr | undefined = statement.orderBy;
    while (cursor) {
      out.push(compileOrderEntry(cursor));
      cursor = cursor.then;
    }
    return out;
  })();
  return {
    kind: "select_stmt",
    expr: { ...subject, shape: shaped },
    ...statementBase(scoped),
    where: compileFilterToSet(statement.filter, shapedSubject, scoped),
    orderBy,
    // Forward LIMIT/OFFSET literals from the parsed clause chain into the IR;
    // they were being dropped on the floor, so `SELECT Issue {…} LIMIT 3`
    // surfaced every row at the SQL layer.
    limit: statement.limitExpr
      ? compileFreeObjectExpr(statement.limitExpr, scoped)
      : statement.limit === undefined ? undefined : literalToSet(statement.limit),
    offset: statement.offsetExpr
      ? compileFreeObjectExpr(statement.offsetExpr, scoped)
      : statement.offset === undefined ? undefined : literalToSet(statement.offset),
    implicitWrapper: false,
    span: statement.pos,
  };
};

const compileSelectFreeStatement = (statement: SelectFreeStatement, ctx: IRCompileContext): SelectStmt => {
  const scoped = withBindings(ctx, statement.with);
  // `select { single x := <expr> }` requires `<expr>` to be provably single-or-
  // empty. An exclusive constraint on the filtered property clamps to one, but
  // an `exclusive … except (…)` constraint does NOT (rows can share the value),
  // so a filtered select over an except-exclusive prop stays many — reject it.
  const freeObjectTypeRef = unknownTypeRef("std::FreeObject");
  for (const entry of statement.entries) {
    if (entry.cardinality !== "one") continue;
    const card = inferFreeExprCard(entry.expr, scoped, freeObjectTypeRef);
    if (card.upper === "many") {
      throw new AppError(
        "E_SEMANTIC",
        `possibly more than one element returned by an expression for a computed property '${entry.name}' declared as 'single'`,
        statement.pos.line,
        statement.pos.column,
      );
    }
  }
  const tupleValues = statement.entries.map((entry) => ({ name: entry.name, val: compileFreeObjectExpr(entry.expr, scoped) }));
  const tupleSet: Set = {
    kind: "set",
    expr: { kind: "tuple", named: true, isFreeObject: true, elements: tupleValues.map((entry) => ({ name: entry.name, val: entry.val })) },
    pathId: defaultPathId("free_object"),
    typeref: unknownTypeRef("std::tuple"),
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
  return {
    kind: "select_stmt",
    expr: tupleSet,
    ...statementBase(scoped),
    implicitWrapper: false,
    span: statement.pos,
  };
};

const compileInsertStatement = (statement: InsertStatement, ctx: IRCompileContext): InsertStmt => {
  const scoped = withBindings(ctx, statement.with);
  const subject = resolveSubjectTypeRef(scoped, statement.typeName);
  const subjectSet = setFromTypeRoot(subject);
  bindValue(scoped, "__subject__", subjectSet);
  bindValue(scoped, "__current__", subjectSet);
  const shape: ShapeElement[] = Object.entries(statement.values).map(([name, value]) => {
    const ptrref = resolvePointerRef(scoped, subject, name);
    const exprSet = compileInsertValue(value, scoped);
    return {
      kind: "shape_element",
      source: subjectSet,
      expr: exprSet,
      targetPtr: ptrref,
      shapeOp: "assign",
      shapeOrigin: "explicit",
      required: ptrref?.outCardinality === "one",
      cardinality: ptrref?.outCardinality ?? "unknown",
    };
  });
  return {
    kind: "insert_stmt",
    expr: subjectSet,
    ...statementBase(scoped),
    subject,
    shape,
    span: statement.pos,
  };
};

const compileUpdateStatement = (statement: UpdateStatement, ctx: IRCompileContext): UpdateStmt => {
  const scoped = withBindings(ctx, statement.with);
  const subject = resolveSubjectTypeRef(scoped, statement.typeName);
  const subjectSet = setFromTypeRoot(subject);
  bindValue(scoped, "__subject__", subjectSet);
  bindValue(scoped, "__current__", subjectSet);
  const shape: ShapeElement[] = Object.entries(statement.values).map(([name, value]) => {
    const ptrref = resolvePointerRef(scoped, subject, name);
    return {
      kind: "shape_element",
      source: subjectSet,
      expr: compileInsertValue(value, scoped),
      targetPtr: ptrref,
      shapeOp: statement.operations?.[name] ?? "assign",
      shapeOrigin: "explicit",
      required: ptrref?.outCardinality === "one",
      cardinality: ptrref?.outCardinality ?? "unknown",
    };
  });
  return {
    kind: "update_stmt",
    expr: subjectSet,
    ...statementBase(scoped),
    subject,
    where: compileFilterToSet(statement.filter, subjectSet, scoped),
    shape,
    span: statement.pos,
  };
};

const compileDeleteStatement = (statement: DeleteStatement, ctx: IRCompileContext): DeleteStmt => {
  const scoped = withBindings(ctx, statement.with);
  const subject = resolveTypeRef(scoped, statement.typeName);
  const expr = statement.target
    ? compileFreeObjectExpr(statement.target, scoped)
    : setFromTypeRoot(subject);
  bindValue(scoped, "__subject__", expr);
  bindValue(scoped, "__current__", expr);
  const orderBy: SortExpr[] | undefined = statement.orderBy
    ? [{
        kind: "sort_expr",
        path: statement.orderBy.expr
          ? compileFreeObjectExpr(statement.orderBy.expr, scoped)
          : compileFreeObjectExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__current__" }, field: statement.orderBy.field, optional: false }, scoped),
        direction: statement.orderBy.direction,
        nonesOrder: "last",
      }]
    : undefined;
  return {
    kind: "delete_stmt",
    expr,
    ...statementBase(scoped),
    subject,
    where: compileFilterToSet(statement.filter, expr, scoped),
    orderBy,
    limit: statement.limit === undefined ? undefined : literalToSet(statement.limit),
    offset: statement.offset === undefined ? undefined : literalToSet(statement.offset),
    span: statement.pos,
  };
};

const compileForStatement = (statement: ForStatement, ctx: IRCompileContext): SelectStmt => {
  const scoped = withBindings(ctx, statement.with);
  const iteratorSet = compileFreeObjectExpr(statement.iteratorExpr, scoped);
  const loopCtx = childScope(scoped);
  bindValue(loopCtx, statement.variable, iteratorSet);
  const bodyExpr: FreeObjectExpr = statement.body.kind === "select_expr"
    ? statement.body.expr
    : statement.body.kind === "select"
      ? { kind: "select", typeName: statement.body.typeName, shape: statement.body.shape, clauses: { filter: statement.body.filter, orderBy: statement.body.orderBy, limit: statement.body.limit, offset: statement.body.offset } }
      : { kind: "literal", value: null };
  const set = compileFreeObjectExpr({ kind: "for_expr", variable: statement.variable, iterator: statement.iteratorExpr, body: bodyExpr, optional: statement.optional }, loopCtx);
  return {
    kind: "select_stmt",
    expr: set,
    ...statementBase(loopCtx),
    implicitWrapper: false,
    span: statement.pos,
  };
};

// `GROUP <subject> [USING …] BY <elements>` — the shared core for top-level
// statements and expression-position `(GROUP …)`. Builds the subject Set and
// the lowering metadata the SQL stage turns into `{ key, grouping, elements }`
// rows — one GROUP BY branch per expanded grouping set. USING bindings are
// folded into the subject's projection as hidden computed fields so each
// alias is evaluated once per element. The BY expansion below implements the
// grouping-set algebra directly.
// Features the SQL stage can't express (link-property keys, USING whole-set
// references, free-object subjects, lossy projections) leave `byAtoms`
// undefined so the engine falls back to the runtime grouper.
type GroupStatementAst = Extract<EdgeQLStatement, { kind: "group" }>;
type GroupAstParts = Pick<GroupStatementAst, "source" | "using" | "by"> & { pos?: GroupStatementAst["pos"] };

// A USING expression that references a WITH binding or the subject itself
// (`using z := N <= 1` where N is volatile-once, `using l := C.len` where C
// is the grouped set) needs whole-set / materialize-once semantics the
// per-row computed projection can't express; those stay on the runtime
// grouper's per-row evaluator.
const containsBindingRef = (node: unknown, seen = new globalThis.Set<unknown>()): boolean => {
  if (!node || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  if ((node as { kind?: unknown }).kind === "binding_ref") return true;
  if (Array.isArray(node)) return node.some((item) => containsBindingRef(item, seen));
  return Object.values(node).some((value) => containsBindingRef(value, seen));
};

// Whether `node` references a binding_ref with the given name — used to tell a
// USING self-reference to the subject (`group X using z := X`) apart from a
// reference to an unrelated WITH binding (`using z := N <= 1`).
const containsBindingRefNamed = (node: unknown, name: string, seen = new globalThis.Set<unknown>()): boolean => {
  if (!node || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  const obj = node as { kind?: unknown; name?: unknown };
  if (obj.kind === "binding_ref" && obj.name === name) return true;
  if (Array.isArray(node)) return node.some((item) => containsBindingRefNamed(item, name, seen));
  return Object.values(node).some((value) => containsBindingRefNamed(value, name, seen));
};

// Add schema fields to an ALREADY-COMPILED group subject's shape (peeling
// no-op select wrappers down to the type root) — used when an AST rebuild
// isn't possible because the group's WITH bindings live on an inner scope.
const augmentCompiledGroupSubject = (
  subject: Set,
  fields: string[],
  ctx: IRCompileContext,
): Set | undefined => {
  if (subject.expr.kind === "select_expr") {
    const wrapper = subject.expr as SelectExpr;
    const inner = augmentCompiledGroupSubject(wrapper.result, fields, ctx);
    return inner ? { ...subject, expr: { ...wrapper, result: inner } } : undefined;
  }
  if (subject.expr.kind !== "type_root") return undefined;
  const have = new globalThis.Set(
    (subject.shape ?? []).map((el) => el.name
      ?? (el.expr.expr.kind === "pointer" ? (el.expr.expr as Pointer).ptrref.shortName : undefined)),
  );
  const additions: ShapeElement[] = [];
  for (const field of fields) {
    if (have.has(field)) continue;
    const ptrref = resolvePointerRef(ctx, subject.typeref, field);
    if (!ptrref || !ptrref.outTarget.isScalar) return undefined;
    additions.push({
      kind: "shape_element",
      source: subject,
      expr: extendPathSet(subject, ptrref),
      name: field,
      shapeOp: "assign",
      shapeOrigin: "explicit",
      required: false,
      cardinality: ptrref.outCardinality ?? "at_most_one",
    } as ShapeElement);
  }
  return additions.length > 0 ? { ...subject, shape: [...(subject.shape ?? []), ...additions] } : subject;
};

// Deep-rewrite paths rooted at the group SUBJECT's binding name into
// leading-dot form (`B.avatar.name` → `.avatar.name` when the subject is
// `GROUP B`): per-row reads, not whole-set references. Bare `B` references
// (no trailing steps) are left alone — those ARE whole-set.
const rewriteSubjectBindingPathsToCurrentItem = (node: unknown, subjectName: string): unknown => {
  if (Array.isArray(node)) return node.map((item) => rewriteSubjectBindingPathsToCurrentItem(item, subjectName));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown> & { kind?: string };
  if (obj.kind === "path" && Array.isArray(obj.steps)) {
    const steps = obj.steps as Array<{ kind?: string; name?: string }>;
    if (steps.length > 1 && steps[0]?.kind === "object_ref" && steps[0].name === subjectName) {
      return { ...obj, head: undefined, steps: steps.slice(1).map((step) => rewriteSubjectBindingPathsToCurrentItem(step, subjectName)) };
    }
  }
  if (obj.kind === "field_access") {
    const src = obj.expr as { kind?: string; name?: string; steps?: Array<{ kind?: string; name?: string }> } | undefined;
    const isBareSubjectRef = (src?.kind === "binding_ref" && src.name === subjectName)
      || (src?.kind === "path" && Array.isArray(src.steps) && src.steps.length === 1
          && src.steps[0]?.kind === "object_ref" && src.steps[0].name === subjectName);
    if (isBareSubjectRef) {
      return { ...obj, expr: { kind: "current_item" } };
    }
    const innerRewritten = rewriteSubjectBindingPathsToCurrentItem(obj.expr, subjectName);
    return { ...obj, expr: innerRewritten };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    out[key] = rewriteSubjectBindingPathsToCurrentItem(obj[key], subjectName);
  }
  return out;
};

// `group <scalar-set> USING k := <expr> BY k` — the elements are scalar or
// tuple VALUES, so there's no shape to attach the USING computeds to.
// Desugar the subject into `FOR el IN <src> UNION ({__element__ := el,
// k := <expr(el)>, …})` (a named IR tuple per element): the generic GROUP
// lowering then reads keys off each row's fields and re-reads the raw
// element from GROUP_ELEMENT_VALUE_FIELD for display. Returns undefined
// when the source isn't a value set or a USING expression doesn't compile.
const GROUP_ELEMENT_VALUE_FIELD = "__element__";
const tryBuildScalarGroupSubject = (
  statement: GroupAstParts,
  sourceAst: GroupAstParts["source"],
  ctx: IRCompileContext,
  fieldAtoms: string[] = [],
): Set | undefined => {
  const attempt = tryResult(() => compileFreeObjectExpr(sourceAst, ctx));
  if (!attempt.ok) return undefined;
  const src = attempt.value;
  let cursor: Set = src;
  while (cursor.expr.kind === "select_expr") {
    cursor = (cursor.expr as SelectExpr).result;
  }
  const kind = cursor.expr.kind;
  // group_rows subjects (an outer GROUP over an inner one) iterate one row
  // per inner group; their USING keys read fields off the row JSON.
  const valueLike = kind.endsWith("_constant")
    || kind === "function_call" || kind === "operator_call"
    || kind === "index_expr" || kind === "type_cast" || kind === "array"
    || kind === "group_rows" || kind === "group_row_field";
  if (!valueLike) return undefined;

  const iterScopeTag = `for:__group_element__:${ctx.nextScopeId++}`;
  const iterator: Set = {
    ...src,
    pathId: {
      ...src.pathId,
      namespace: [...(src.pathId?.namespace ?? []), iterScopeTag],
    },
  };
  const loopCtx = childScope(ctx);
  bindValue(loopCtx, "__current__", iterator);
  const elements: TupleElement[] = [{ name: GROUP_ELEMENT_VALUE_FIELD, val: iterator }];
  for (const usingBinding of statement.using ?? []) {
    if (containsBindingRef(usingBinding.expr) && !resolveBinding(loopCtx, usingNameOfBindingRef(usingBinding.expr) ?? "")) {
      return undefined;
    }
    const compiled = tryResult(() => compileFreeObjectExpr(usingBinding.expr, loopCtx));
    if (!compiled.ok) return undefined;
    elements.push({ name: usingBinding.alias, val: compiled.value });
    // Chained aliases (`USING x := …, y := x`) resolve against the prior
    // computed.
    bindValue(loopCtx, usingBinding.alias, compiled.value);
  }
  // Field-ref BY atoms over element rows (`group <rows>.elements by .cost`)
  // read the current element's field.
  for (const atom of fieldAtoms) {
    if (elements.some((el) => el.name === atom)) continue;
    const compiled = tryResult(() => compileFreeObjectExpr(
      { kind: "field_access", expr: { kind: "current_item" }, field: atom, optional: false } as FreeObjectExpr,
      loopCtx,
    ));
    if (!compiled.ok) return undefined;
    elements.push({ name: atom, val: compiled.value });
  }
  const tupleSet: Set = {
    kind: "set",
    expr: { kind: "tuple", named: true, elements } as Tuple,
    pathId: defaultPathId("group_scalar_subject"),
    typeref: unknownTypeRef("std::tuple"),
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
  return {
    kind: "set",
    expr: {
      kind: "for_expr",
      iterator,
      body: tupleSet,
      bindingKind: "with",
      optional: false,
    } as ForExpr,
    pathId: defaultPathId("for:__group_element__"),
    typeref: tupleSet.typeref,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

// The name a bare `binding_ref` USING expression points at — chained USING
// aliases (`USING x := …, y := x`) are allowed in the scalar-subject desugar
// because the prior alias is bound in the loop scope.
const usingNameOfBindingRef = (expr: unknown): string | undefined =>
  (expr as { kind?: string; name?: string })?.kind === "binding_ref"
    ? (expr as { name?: string }).name
    : undefined;

const buildGroupStmtParts = (
  statement: GroupAstParts,
  scoped: IRCompileContext,
): Pick<GroupStmt, "byAtoms" | "groupingSets" | "hiddenByFields" | "elementValueField" | "selfKeyAliases"> & { subject: Set } => {
  let lowerable = true;

  // --- Expand BY into the atom-name union + grouping sets. ---
  const atomName = (atom: GroupByAtom): string =>
    atom.kind === "field_ref" ? atom.field : atom.name;
  const atomOrder: string[] = [];
  // field_ref atoms must exist as fields on the subject rows; name_ref atoms
  // resolve to USING aliases (folded into the projection below).
  const fieldAtoms: string[] = [];
  const addAtom = (atom: GroupByAtom): string => {
    // `@prop` keys live on the link table, which the per-element projection
    // doesn't carry; those stay on the runtime grouper.
    if (atom.kind === "link_property_ref") lowerable = false;
    const name = atomName(atom);
    if (!atomOrder.includes(name)) atomOrder.push(name);
    if (atom.kind === "field_ref" && !fieldAtoms.includes(name)) fieldAtoms.push(name);
    return name;
  };
  const subsetsOfList = (items: string[], mode: "cube" | "rollup"): string[][] => {
    if (mode === "rollup") {
      const out: string[][] = [];
      for (let i = 0; i <= items.length; i += 1) out.push(items.slice(0, i));
      return out;
    }
    // cube: power set
    const out: string[][] = [[]];
    for (const item of items) {
      const len = out.length;
      for (let i = 0; i < len; i += 1) out.push([...out[i], item]);
    }
    return out;
  };
  const crossProduct = (left: string[][], right: string[][]): string[][] => {
    const out: string[][] = [];
    for (const l of left) for (const r of right) out.push([...l, ...r]);
    return out;
  };
  let groupingSets: string[][] = [[]];
  for (const element of statement.by) {
    if (element.kind === "field_ref" || element.kind === "name_ref" || element.kind === "link_property_ref") {
      const name = addAtom(element);
      groupingSets = groupingSets.map((s) => [...s, name]);
    } else if (element.kind === "sets") {
      groupingSets = crossProduct(groupingSets, element.sets.map((atoms) => atoms.map(addAtom)));
    } else {
      groupingSets = crossProduct(groupingSets, subsetsOfList(element.atoms.map(addAtom), element.kind));
    }
  }
  if (groupingSets.length === 0) {
    groupingSets = [[]];
  }

  // --- Fold USING aliases and BY fields into the subject projection. ---
  // A USING expression becomes a computed shape entry compiled along the same
  // path as a hand-written `alias := <expr>` inside the shape, so the alias
  // is a regular (hidden) field on each element row.
  const usingExprToComputed = (expr: NonNullable<typeof statement.using>[number]["expr"]): Extract<EdgeQLShapeElement, { kind: "computed" }>["expr"] => {
    if (expr.kind === "function_call") {
      return { kind: "function_call", call: expr.call };
    }
    // A direct field of the current row (`owner := .owner`) lowers like a
    // plain shape field; anything else routes through the per-row
    // select_expr computed path.
    if (expr.kind === "field_access" && expr.expr.kind === "current_item") {
      return { kind: "field_ref", field: expr.field };
    }
    if (expr.kind === "literal") {
      return { kind: "literal", value: expr.value };
    }
    return { kind: "select_expr", expr, clauses: {} };
  };

  let sourceAst = statement.source;
  // Peel no-op parenthesized wrappers (`group (select X {…}) using …`) so
  // the USING fold below can attach its computed fields to the inner shape.
  // Wrapper WITH bindings stay visible by folding them into the scope.
  while (sourceAst.kind === "select_expr_subquery") {
    const wrapper = sourceAst as unknown as {
      expr?: GroupAstParts["source"];
      filter?: unknown; orderBy?: unknown; limit?: unknown; offset?: unknown;
      clauses?: { _withBindings?: WithBinding[] };
      _withBindings?: WithBinding[];
    };
    const inner = wrapper.expr;
    if (!inner || (inner.kind !== "select" && inner.kind !== "shape_projection")) break;
    if (wrapper.filter !== undefined || wrapper.orderBy !== undefined
        || wrapper.limit !== undefined || wrapper.offset !== undefined) break;
    const wb = wrapper._withBindings ?? wrapper.clauses?._withBindings;
    if (wb && wb.length > 0) {
      scoped = withBindings(scoped, wb);
    }
    sourceAst = inner;
  }
  // `group X using z := X by z` — group a value/tuple set by the element value
  // itself. The subject is plain value rows; the self-alias keys (and the
  // displayed elements) read the whole `value`, so there is no object shape to
  // fold and no per-element tuple to build (which would cross-join the value
  // against itself). Handled here, before the shaped / scalar-element paths.
  const subjectName = sourceAst.kind === "select"
    ? sourceAst.typeName
    : sourceAst.kind === "shape_projection" && sourceAst.expr.kind === "binding_ref"
      ? sourceAst.expr.name
      : sourceAst.kind === "binding_ref"
        ? (sourceAst as { name?: string }).name
        : undefined;
  const selfAliasNames = subjectName
    ? (statement.using ?? [])
        .filter((u) => u.expr.kind === "binding_ref" && (u.expr as { name?: string }).name === subjectName)
        .map((u) => u.alias)
    : [];
  if (selfAliasNames.length > 0
      && (statement.using ?? []).length === selfAliasNames.length
      && atomOrder.length > 0 && atomOrder.every((a) => selfAliasNames.includes(a))
      && fieldAtoms.length === 0) {
    const compiled = tryResult(() => compileFreeObjectExpr(sourceAst, scoped));
    if (compiled.ok) {
      return {
        subject: compiled.value,
        byAtoms: atomOrder,
        groupingSets,
        hiddenByFields: undefined,
        elementValueField: undefined,
        selfKeyAliases: atomOrder,
      };
    }
  }
  const hiddenByFields: string[] = [];
  if (sourceAst.kind === "shape_projection" || sourceAst.kind === "select" || sourceAst.kind === "binding_ref") {
    const originalShape = sourceAst.kind === "binding_ref" ? [] : (sourceAst.shape ?? []);
    const shape = [...originalShape];
    const present = new globalThis.Set<string>(
      shape
        .filter((s): s is Extract<EdgeQLShapeElement, { name: string }> => "name" in s && typeof s.name === "string")
        .map((s) => s.name),
    );
    const usingComputeds = new Map<string, Extract<EdgeQLShapeElement, { kind: "computed" }>["expr"]>();
    const containsVolatileCall = (node: unknown): boolean =>
      JSON.stringify(node ?? null).includes('"random"');
    for (const usingBinding of statement.using ?? []) {
      // Chained alias (`USING x := count(.owners), nowners := x`):
      // substitute the prior alias's computed expression. Re-evaluating is
      // only safe for non-volatile expressions — a chained volatile alias
      // would diverge between the two fields, so it stays on the runtime
      // grouper.
      let computed: Extract<EdgeQLShapeElement, { kind: "computed" }>["expr"] | undefined;
      const prior = usingBinding.expr.kind === "binding_ref" ? usingComputeds.get(usingBinding.expr.name) : undefined;
      if (prior !== undefined && !containsVolatileCall(prior)) {
        computed = prior;
      }
      if (!computed) {
        // Paths through the SUBJECT's own binding name (`USING category :=
        // B.avatar.name` where the subject is `GROUP B`) are per-row reads —
        // rewrite them to leading-dot form so they don't trip the whole-set
        // binding-ref bail below.
        let usingExpr = usingBinding.expr;
        // The subject's name itself (binding OR type name): paths through it
        // inside USING are per-row reads of the subject element.
        const subjectBindingName = sourceAst.kind === "select"
          ? sourceAst.typeName
          : sourceAst.kind === "shape_projection" && sourceAst.expr.kind === "binding_ref"
            ? sourceAst.expr.name
            : sourceAst.kind === "binding_ref"
              ? (sourceAst as { name?: string }).name
            : undefined;
        if (subjectBindingName && containsBindingRef(usingExpr)) {
          const rewritten = rewriteSubjectBindingPathsToCurrentItem(usingExpr, subjectBindingName);
          if (rewritten && !containsBindingRef(rewritten)) {
            usingExpr = rewritten as typeof usingExpr;
          }
        }
        // A self-reference to the subject binding (`group X using z := X`)
        // means "group on the whole element" — the shaped fold can't model
        // that, so it stays on the runtime grouper. Any OTHER binding reference
        // (`using z := N <= 1` where N := random()) is inlined: it resolves
        // against the surrounding scope when the subject shape compiles below.
        if (subjectBindingName && containsBindingRefNamed(usingExpr, subjectBindingName)) {
          lowerable = false;
          continue;
        }
        if (containsBindingRef(usingExpr) && !subjectBindingName) {
          // No identifiable subject binding to disambiguate a self-reference —
          // keep the conservative bail (e.g. `group <tuple set> using z := X`).
          lowerable = false;
          continue;
        }
        computed = usingExprToComputed(usingExpr);
      }
      usingComputeds.set(usingBinding.alias, computed);
      if (present.has(usingBinding.alias)) continue;
      shape.push({
        kind: "computed",
        name: usingBinding.alias,
        expr: computed,
        operation: "assign",
        origin: "explicit",
      } as EdgeQLShapeElement);
      hiddenByFields.push(usingBinding.alias);
      present.add(usingBinding.alias);
    }
    // Any BY field the subject doesn't already project is added (and hidden)
    // so the key is readable off each element row.
    for (const name of fieldAtoms) {
      if (present.has(name)) continue;
      shape.push({ kind: "field", name });
      hiddenByFields.push(name);
      present.add(name);
    }
    if (shape.length !== originalShape.length) {
      sourceAst = sourceAst.kind === "binding_ref"
        ? { kind: "shape_projection", expr: sourceAst, shape }
        : { ...sourceAst, shape };
    }
  }

  // Scalar/tuple-element subjects with USING keys desugar to a FOR over the
  // source carrying the raw element + USING fields per row (see
  // tryBuildScalarGroupSubject). Field-ref BY atoms can't resolve against a
  // value row, so those bail.
  let scalarElementSubject: Set | undefined;
  if (sourceAst.kind !== "shape_projection" && sourceAst.kind !== "select"
      && ((statement.using ?? []).length > 0 || fieldAtoms.length > 0)) {
    // A single-row named-tuple source (a free object) takes the
    // tuple-extension path below instead — its USING aliases become extra
    // tuple fields.
    const probe = tryResult(() => compileFreeObjectExpr(sourceAst, scoped));
    let probeIsTuple = false;
    let probeIsValueLike = false;
    if (probe.ok) {
      let probeCursor: Set = probe.value;
      while (probeCursor.expr.kind === "select_expr") {
        probeCursor = (probeCursor.expr as SelectExpr).result;
      }
      probeIsTuple = probeCursor.expr.kind === "tuple" && (probeCursor.expr as Tuple).named;
      probeIsValueLike = probeCursor.expr.kind === "group_row_field"
        || probeCursor.expr.kind === "group_rows"
        || probeCursor.expr.kind === "function_call"
        || probeCursor.expr.kind === "operator_call"
        || probeCursor.expr.kind === "index_expr"
        || probeCursor.expr.kind === "type_cast"
        || probeCursor.expr.kind === "array"
        || probeCursor.expr.kind.endsWith("_constant");
    }
    if (!probeIsTuple && ((statement.using ?? []).length > 0 || probeIsValueLike)) {
      scalarElementSubject = tryBuildScalarGroupSubject(statement, sourceAst, scoped, fieldAtoms);
      if (!scalarElementSubject) {
        // USING over an unshaped / wrapped source has nowhere to attach its
        // computed fields; the presence check below would pass vacuously.
        lowerable = false;
      }
    }
  }

  // A typed-select over a free-object binding (`group X { a, b }` where
  // X := { a := 1, … }) compiles the BINDING itself as the subject — tuple
  // fields aren't schema pointers, so the generic shape compile would reject
  // them. The written shape only selects which fields stay visible in
  // `elements` (see the subjectTuple strip below).
  let tupleBindingSubject: Set | undefined;
  {
    let probeAst: typeof sourceAst | undefined = sourceAst;
    while (probeAst && probeAst.kind === "select_expr_subquery") {
      probeAst = (probeAst as { expr?: typeof sourceAst }).expr;
    }
    const bindingName = probeAst && probeAst.kind === "select"
      ? probeAst.typeName
      : probeAst && probeAst.kind === "shape_projection" && probeAst.expr.kind === "binding_ref"
        ? probeAst.expr.name
        : undefined;
    const bound = bindingName ? resolveBinding(scoped, bindingName) : undefined;
    if (bound) {
      let cursor: Set = bound;
      while (cursor.expr.kind === "select_expr") {
        cursor = (cursor.expr as SelectExpr).result;
      }
      if (cursor.expr.kind === "tuple") {
        tupleBindingSubject = bound;
      }
    }
  }

  // The subject may not be lowerable to GelIR (e.g. `select X { name, b }`
  // re-projects a computed field `b` off the binding `X`, which the shape
  // compiler validates against the base type and rejects). In that case emit a
  // non-lowerable GroupStmt (byAtoms cleared) so the SQL stage bails and the
  // engine falls back to the runtime grouper, which handles it.
  let subject: Set;
  const subjectAttempt = tryResult(() => tupleBindingSubject ?? scalarElementSubject ?? compileFreeObjectExpr(sourceAst, scoped));
  if (subjectAttempt.ok) {
    subject = subjectAttempt.value;
  } else {
    subject = literalToSet(null);
    lowerable = false;
  }

  // Subjects that produce one element row per set member lower to SQL: the
  // FOR-iteration family (`group (for … select …) by …`), shaped / bare type
  // roots (`group Card {…} by …`), and single-row free objects
  // (`group {a := 1, b := random()} …`, compiled as a named IR tuple whose
  // select_free lowering emits exactly one json_object row). A free object
  // with a multi field (`b := {1, 2}`) cross-joins into several rows — that
  // breaks the one-row-per-element contract, so it stays on the runtime
  // grouper.
  const SET_RETURNING_FUNCTIONS = new globalThis.Set([
    "array_unpack", "enumerate", "range_unpack", "json_array_unpack", "json_object_unpack", "sequence",
  ]);
  const isSingleTupleElement = (val: Set): boolean => {
    const kind = val.expr.kind;
    if (kind.endsWith("_constant")) return true;
    if (kind === "type_cast" || kind === "tuple" || kind === "array") return true;
    if (kind === "function_call") {
      const shortName = ((val.expr as IRFunctionCall).functionName ?? "").split("::").pop() ?? "";
      return !SET_RETURNING_FUNCTIONS.has(shortName);
    }
    if (kind === "operator_call") {
      return (val.expr as OperatorCall).operator !== "union";
    }
    // `b := (for n in {9} union (…))` — a FOR over a single-element iterator
    // yields exactly one row, so the field is still single.
    if (kind === "for_expr") {
      let iterCursor = (val.expr as ForExpr).iterator;
      while (iterCursor.expr.kind === "select_expr") {
        iterCursor = (iterCursor.expr as SelectExpr).result;
      }
      const iterKind = iterCursor.expr.kind;
      if (iterKind.endsWith("_constant") || iterKind === "type_cast") return true;
      if (iterKind === "operator_call" && (iterCursor.expr as OperatorCall).operator === "union") {
        return Object.keys((iterCursor.expr as OperatorCall).args).length === 1;
      }
      return false;
    }
    return false;
  };
  let subjectTuple: Tuple | undefined;
  if (lowerable) {
    let cursor: Set = subject;
    while (cursor.expr.kind === "select_expr") {
      cursor = (cursor.expr as SelectExpr).result;
    }
    // A multi field (`b := {2, 3, 4}`) doesn't break the one-row contract:
    // a free object is still ONE element whose field holds the whole set —
    // the SQL stage aggregates union-valued fields into JSON arrays.
    // A FOR field over a plain value (`b := (for n in {8,9} select n)`) is also
    // a single element whose value holds the whole produced set — the SQL stage
    // aggregates it into a JSON array like a union-valued field. A FOR whose
    // body produces an OBJECT (`b := (for n in {9} union ({c:=3, d:=n}))`)
    // carries its own shape/computed pointers and stays on the runtime grouper.
    const forBodyIsScalarish = (forExpr: ForExpr): boolean => {
      let body: Set = forExpr.body;
      while (body.expr.kind === "select_expr") body = (body.expr as SelectExpr).result;
      return body.expr.kind !== "tuple" && (body.shape?.length ?? 0) === 0;
    };
    const isTupleElementValue = (val: Set): boolean =>
      isSingleTupleElement(val)
      || (val.expr.kind === "operator_call" && (val.expr as OperatorCall).operator === "union")
      || (val.expr.kind === "for_expr" && forBodyIsScalarish(val.expr as ForExpr));
    if (cursor.expr.kind === "tuple"
      && (cursor.expr as Tuple).named
      && (cursor.expr as Tuple).elements.every((el) => el.name && isTupleElementValue(el.val))) {
      subjectTuple = cursor.expr as Tuple;
    }
    // USING aliases over a tuple subject become extra (hidden) tuple fields,
    // compiled with the tuple as the current item so `.c.d` / `.b.d` peel
    // into the tuple's nested values.
    if (subjectTuple && (statement.using ?? []).length > 0) {
      const usingCtx = childScope(scoped);
      bindValue(usingCtx, "__current__", subject);
      bindValue(usingCtx, "__subject__", subject);
      const extendedElements = [...subjectTuple.elements];
      const fieldNames = new globalThis.Set(extendedElements.map((el) => el.name));
      let extendOk = true;
      for (const usingBinding of statement.using ?? []) {
        if (fieldNames.has(usingBinding.alias)) continue;
        const compiledUsing = tryResult(() => compileFreeObjectExpr(usingBinding.expr, usingCtx));
        if (!compiledUsing.ok) { extendOk = false; break; }
        extendedElements.push({ name: usingBinding.alias, val: compiledUsing.value });
        bindValue(usingCtx, usingBinding.alias, compiledUsing.value);
        fieldNames.add(usingBinding.alias);
        if (!hiddenByFields.includes(usingBinding.alias)) hiddenByFields.push(usingBinding.alias);
      }
      if (extendOk) {
        subjectTuple = { ...subjectTuple, elements: extendedElements };
        subject = { ...subject, expr: subjectTuple, shape: [] };
      } else {
        lowerable = false;
      }
    }
    if (cursor.expr.kind !== "for_expr" && cursor.expr.kind !== "type_root"
      && cursor.expr.kind !== "group_rows" && !subjectTuple) {
      lowerable = false;
    }
    // The shape compiler silently skips elements it can't resolve (e.g. a
    // nested shape over a binding's computed pointer). The SQL lowering
    // re-aggregates the projected JSON wholesale, so a lossy projection must
    // fall back to the runtime grouper, which materializes such pointers.
    // The same check guards the group keys: a BY atom that didn't land in
    // the projection would group everything under a NULL key.
    if (lowerable) {
      let shapedAst: typeof sourceAst | undefined = sourceAst;
      while (shapedAst && shapedAst.kind === "select_expr_subquery") {
        shapedAst = (shapedAst as { expr?: typeof sourceAst }).expr;
      }
      const wanted = shapedAst && (shapedAst.kind === "shape_projection" || shapedAst.kind === "select")
        ? (shapedAst.shape ?? [])
            .filter((s): s is Extract<EdgeQLShapeElement, { name: string }> => "name" in s && typeof s.name === "string")
            .map((s) => s.name)
        : [];
      const have = new globalThis.Set<string>();
      const collect = (set: Set): void => {
        for (const el of set.shape ?? []) {
          const name = el.name
            ?? (el.expr.expr.kind === "pointer" ? (el.expr.expr as Pointer).ptrref.shortName : undefined);
          if (name) have.add(name);
        }
        if (set.expr.kind === "tuple") {
          for (const el of (set.expr as Tuple).elements) {
            if (el.name) have.add(el.name);
          }
        }
        if (set.expr.kind === "group_rows") {
          const projection = (set.expr as GroupRowsExpr).projection;
          if (projection) {
            for (const proj of projection) have.add(proj.name);
          } else {
            have.add("key");
            have.add("grouping");
            have.add("elements");
          }
        }
        if (set.expr.kind === "select_expr") collect((set.expr as SelectExpr).result);
        if (set.expr.kind === "for_expr") {
          const body = (set.expr as { body?: Set }).body;
          if (body) collect(body);
        }
      };
      collect(subject);
      const missing = (name: string): boolean =>
        name !== "id" && name !== "__type__" && !have.has(name);
      if (wanted.some(missing) || atomOrder.some(missing)) {
        lowerable = false;
      }
      // A free-object subject materializes every field in its value row;
      // strip the ones the written shape doesn't project from the displayed
      // elements.
      if (lowerable && subjectTuple && wanted.length > 0) {
        for (const el of subjectTuple.elements) {
          if (el.name && !wanted.includes(el.name) && !hiddenByFields.includes(el.name)) {
            hiddenByFields.push(el.name);
          }
        }
      }
    }
  }

  return {
    subject,
    byAtoms: lowerable ? atomOrder : undefined,
    groupingSets: lowerable ? groupingSets : undefined,
    hiddenByFields: lowerable && hiddenByFields.length > 0 ? hiddenByFields : undefined,
    elementValueField: lowerable && scalarElementSubject ? GROUP_ELEMENT_VALUE_FIELD : undefined,
  };
};

const makeGroupStmt = (parts: GroupAstParts, scoped: IRCompileContext): GroupStmt => {
  const core = buildGroupStmtParts(parts, scoped);
  return {
    kind: "group_stmt",
    expr: core.subject,
    subject: core.subject,
    by: [],
    using: {},
    byAtoms: core.byAtoms,
    groupingSets: core.groupingSets,
    hiddenByFields: core.hiddenByFields,
    elementValueField: core.elementValueField,
    selfKeyAliases: core.selfKeyAliases,
    ...statementBase(scoped),
    span: parts.pos ?? { line: 1, column: 1 },
  } as GroupStmt;
};

const compileGroupStatement = (statement: GroupStatementAst, ctx: IRCompileContext): GroupStmt => {
  // BY-clause name-collision diagnostics (`group … using x := … by .x, x`) used
  // to be raised by the legacy compileToIR; the gelIR path now owns them.
  validateGroupByAtomCollisions(statement.by, (message) => {
    throw new AppError("E_SEMANTIC", message, statement.pos?.line ?? 1, statement.pos?.column ?? 1);
  });
  return makeGroupStmt(statement, withBindings(ctx, statement.with));
};

// Parse a trailing shape over group rows (`(GROUP …) { element := .key.element,
// cnt := count(.elements), key: {cost}, elements: {name} }`) into the
// GroupRowProjection model the SQL stage can emit. A shape element outside
// the model marks the whole set unlowerable, and the engine falls back to
// the runtime grouper.
const parseGroupRowProjection = (
  shape: EdgeQLShapeElement[] | undefined,
  priorProjection?: GroupRowProjection[],
): { projection?: GroupRowProjection[]; unlowerable?: boolean } => {
  if (!shape || shape.length === 0) return {};
  // `.key.element` / `.elements` — a field_access chain rooted at the
  // current group row.
  const pathSteps = (e: unknown): string[] | null => {
    const steps: string[] = [];
    let cursor = e as { kind?: string; field?: string; expr?: unknown } | undefined;
    while (cursor && cursor.kind === "field_access" && typeof cursor.field === "string") {
      steps.unshift(cursor.field);
      cursor = cursor.expr as typeof cursor;
    }
    return cursor && cursor.kind === "current_item" && steps.length > 0 ? steps : null;
  };
  const out: GroupRowProjection[] = [];
  const dbg = (reason: string, el?: unknown): { unlowerable: true } => {
    if (process.env.DBG_GROUP_PROJ) console.error("[group-proj] unlowerable:", reason, JSON.stringify(el ?? null)?.slice(0, 220));
    return { unlowerable: true };
  };
  for (const el of shape) {
    if (!("name" in el) || typeof el.name !== "string") return dbg("unnamed", el);
    const name = el.name;
    if (el.kind === "link" && el.shape && el.shape.length > 0) {
      if (name === "elements") {
        const fields = parseElementsFields(el.shape, pathSteps);
        if (!fields) return dbg("site2", el);
        out.push({ name, kind: "elements_shape", fields });
        continue;
      }
      const fields = el.shape
        .filter((s): s is Extract<EdgeQLShapeElement, { name: string }> => "name" in s && typeof s.name === "string" && s.kind === "field")
        .map((s) => s.name);
      if (fields.length !== el.shape.length) return dbg("site3", el);
      if (name === "key") {
        out.push({ name, kind: "key_shape", fields });
        continue;
      }
      return dbg("site4", el);
    }
    if (el.kind === "field") {
      if (name === "key" || name === "grouping" || name === "elements" || name === "id") {
        out.push({ name, kind: "path", steps: [name] });
        continue;
      }
      // Re-projecting an already-projected name (`select submissions
      // { minCost }` over a shaped group binding): keep the prior entry.
      const prior = priorProjection?.find((proj) => proj.name === name);
      if (prior) {
        out.push(prior);
        continue;
      }
      return dbg("site5", el);
    }
    if (el.kind === "computed") {
      const computed = el.expr;
      if (computed.kind === "field_ref") {
        out.push({ name, kind: "path", steps: [computed.field] });
        continue;
      }
      if (computed.kind === "function_call") {
        const fname = (computed.call?.name ?? "").split("::").pop();
        const args = computed.call?.args ?? [];
        const arg0 = args[0] as { kind?: string; expr?: unknown } | undefined;
        const steps = fname === "count" && args.length === 1 && arg0?.kind === "expr"
          ? pathSteps(arg0.expr)
          : null;
        if (steps && steps.length === 1 && steps[0] === "elements") {
          out.push({ name, kind: "count_elements" });
          continue;
        }
        // `minCost := min(.elements.cost)` — aggregate over an element field.
        const AGG_FNS: Record<string, "min" | "max" | "sum" | "avg"> = { min: "min", max: "max", sum: "sum", avg: "avg", mean: "avg" };
        if (fname && AGG_FNS[fname] && args.length === 1 && arg0?.kind === "expr") {
          const aggSteps = pathSteps(arg0.expr);
          if (aggSteps && aggSteps.length >= 2 && aggSteps[0] === "elements") {
            out.push({ name, kind: "element_agg", fn: AGG_FNS[fname], steps: aggSteps.slice(1) });
            continue;
          }
        }
        // `array_agg((SELECT _ := .grouping ORDER BY _))` — the grouping
        // names as a sorted array.
        if (fname === "array_agg" && args.length === 1 && arg0?.kind === "expr") {
          let inner = arg0.expr as { kind?: string; expr?: unknown } | undefined;
          while (inner && inner.kind === "select_expr_subquery") {
            inner = inner.expr as typeof inner;
          }
          const innerSteps = pathSteps(inner);
          if (innerSteps && innerSteps.length === 1 && innerSteps[0] === "grouping") {
            out.push({ name, kind: "sorted_grouping" });
            continue;
          }
        }
        return dbg("site6", el);
      }
      if (computed.kind === "select_expr") {
        const computedClauses = (computed.clauses ?? {}) as Record<string, unknown> & { limit?: unknown };
        const computedClauseKeys = Object.keys(computed.clauses ?? {})
          .filter((key) => computedClauses[key] !== undefined);
        // The parser stores `limit 1` as both `limit` and `limitExpr`.
        const onlyLimitOne = computedClauseKeys.length > 0
          && computedClauseKeys.every((key) => key === "limit" || key === "limitExpr")
          && computedClauses.limit === 1;
        if (computedClauseKeys.length > 0 && !onlyLimitOne) return dbg("site7", el);
        const steps = pathSteps(computed.expr);
        if (steps && !onlyLimitOne) {
          out.push({ name, kind: "path", steps });
          continue;
        }
        if (steps && onlyLimitOne && steps.length >= 2 && steps[0] === "elements") {
          out.push({ name, kind: "element_first_path", steps: steps.slice(1) });
          continue;
        }
        // `name: (select .elements.name limit 1)` — first-element field.
        const sub = computed.expr as {
          kind?: string;
          expr?: unknown;
          shape?: EdgeQLShapeElement[];
          limit?: unknown;
          filter?: unknown;
          orderBy?: unknown;
          offset?: unknown;
        };
        if (sub.kind === "select_expr_subquery" && sub.limit === 1
          && !sub.filter && !sub.orderBy && !sub.offset) {
          const subSteps = pathSteps(sub.expr);
          if (subSteps && subSteps.length >= 2 && subSteps[0] === "elements") {
            out.push({ name, kind: "element_first_path", steps: subSteps.slice(1) });
            continue;
          }
        }
        // `keyCard := (select .elements {id} limit 1)` — first element
        // re-projected to a field subset (the parser puts the limit on the
        // computed's clauses in this form).
        if (sub.kind === "shape_projection") {
          if (onlyLimitOne && sub.shape) {
            const baseSteps = pathSteps(sub.expr);
            const fields = sub.shape
              .filter((s): s is Extract<EdgeQLShapeElement, { name: string }> => "name" in s && typeof s.name === "string" && s.kind === "field")
              .map((s) => s.name);
            if (baseSteps && baseSteps.length === 1 && baseSteps[0] === "elements"
              && fields.length === sub.shape.length) {
              out.push({ name, kind: "element_first_shape", fields });
              continue;
            }
          }
        }
        return dbg("site8", el);
      }
      return dbg("site9", el);
    }
    return dbg("site10", el);
  }
  return { projection: out };
};

// The subject field an elements-projection entry reads (`z := .b <= 1`
// reads `b`; everything else reads its own name).
const elementFieldSubjectName = (field: GroupElementsField): string =>
  field.kind === "compare" || field.kind === "count_path" ? (field.steps[0] ?? "") : field.name;

// Parse an `elements: {…}` (or nested object) sub-shape into
// GroupElementsField entries: plain fields, literal comparisons
// (`z := .d <= 1`), and nested object sub-shapes (recursive). Returns null
// when an entry is outside the model.
const parseElementsFields = (
  shape: EdgeQLShapeElement[],
  pathSteps: (e: unknown) => string[] | null,
): GroupElementsField[] | null => {
  const fields: GroupElementsField[] = [];
  for (const sub of shape) {
    if (!("name" in sub) || typeof sub.name !== "string") return null;
    if (sub.kind === "field") {
      fields.push({ name: sub.name, kind: "field" });
      continue;
    }
    if (sub.kind === "link" && sub.shape && sub.shape.length > 0) {
      const nested = parseElementsFields(sub.shape, pathSteps);
      if (!nested) return null;
      fields.push({ name: sub.name, kind: "object_shape", fields: nested });
      continue;
    }
    if (sub.kind === "computed" && sub.expr.kind === "select_expr") {
      const inner = sub.expr.expr as { kind?: string; op?: string; left?: unknown; right?: unknown };
      const ops = new globalThis.Set(["=", "!=", "<", "<=", ">", ">="]);
      const rhs = inner.right as { kind?: string; value?: unknown } | undefined;
      const steps = inner.kind === "compare" && typeof inner.op === "string" && ops.has(inner.op)
        ? pathSteps(inner.left)
        : null;
      if (steps && rhs?.kind === "literal"
        && (typeof rhs.value === "string" || typeof rhs.value === "number" || typeof rhs.value === "boolean")) {
        fields.push({
          name: sub.name,
          kind: "compare",
          steps,
          op: inner.op as Extract<GroupElementsField, { kind: "compare" }>["op"],
          rhs: rhs.value,
        });
        continue;
      }
    }
    // `n := count(.elements)` — count of an array-valued field of the
    // element row (each element of a group-of-groups is itself a group row).
    if (sub.kind === "computed") {
      let computedInner: unknown = sub.expr;
      while ((computedInner as { kind?: string })?.kind === "select_expr") {
        computedInner = (computedInner as { expr?: unknown }).expr;
      }
      const call = (computedInner as { kind?: string; call?: { name?: string; args?: unknown[] } });
      if (call?.kind === "function_call" && (call.call?.name === "count" || call.call?.name === "std::count")
          && Array.isArray(call.call?.args) && call.call.args.length === 1) {
        const arg = call.call.args[0] as { kind?: string; expr?: unknown };
        const steps = pathSteps(arg?.kind === "expr" ? arg.expr : arg);
        if (steps && steps.length > 0) {
          fields.push({ name: sub.name, kind: "count_path", steps });
          continue;
        }
      }
    }
    return null;
  }
  return fields;
};

// Like peelToGroupRows, but unwraps CLAUSED select layers too — `rows` stays
// the FULL claused set so consumers apply ORDER BY/LIMIT before flattening.
const peelToGroupRowsThroughClauses = (set: Set): { rows: Set; groupRows: GroupRowsExpr } | undefined => {
  let cursor: Set = set;
  while (cursor.expr.kind === "select_expr") {
    cursor = (cursor.expr as SelectExpr).result;
  }
  if (cursor.expr.kind !== "group_rows") return undefined;
  return { rows: set, groupRows: cursor.expr as GroupRowsExpr };
};

// Peel no-op select_expr wrappers (`select (select GR)`) down to a
// group-rows set, when that's what they wrap.
const peelToGroupRows = (set: Set): { rows: Set; groupRows: GroupRowsExpr } | undefined => {
  let cursor: Set = set;
  while (cursor.expr.kind === "select_expr") {
    const wrapper = cursor.expr as SelectExpr;
    if (wrapper.where || wrapper.limit || wrapper.offset || (wrapper.orderBy && wrapper.orderBy.length > 0)) break;
    cursor = wrapper.result;
  }
  if (cursor.expr.kind !== "group_rows") return undefined;
  return { rows: cursor, groupRows: cursor.expr as GroupRowsExpr };
};

// Build a `group_rows` set from group AST parts plus an optional trailing
// shape. An `elements: {…}` projection re-reads fields off the materialized
// element rows, so any field it names is added to the subject's projection
// (visible, not hidden — the re-projection selects the exact subset anyway).
// A bare (projection-less) group-rows set — used as the current-item binding
// when compiling computed projections, so `.key.x` / inner `group .elements`
// references peel to group rows.
const buildGroupRowsBaseSet = (
  parts: GroupAstParts,
  ctx: IRCompileContext,
  extraElementFields: string[] = [],
): Set => {
  const scoped = childScope(ctx);
  const group = makeGroupStmt(parts, scoped);
  void extraElementFields;
  return {
    kind: "set",
    expr: { kind: "group_rows", group, astParts: parts } as GroupRowsExpr,
    pathId: defaultPathId("group_rows"),
    typeref: unknownTypeRef("std::FreeObject"),
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

// Field names a computed projection reads off group elements — any
// group_row_field with steps [elements, X, …] anywhere in its compiled IR.
const collectComputedElementNeeds = (node: unknown, out: globalThis.Set<string>, seen = new globalThis.Set<unknown>()): void => {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) { node.forEach((item) => collectComputedElementNeeds(item, out, seen)); return; }
  const obj = node as { kind?: unknown; steps?: unknown };
  if (obj.kind === "group_row_field" && Array.isArray(obj.steps)
      && obj.steps[0] === "elements" && typeof obj.steps[1] === "string") {
    out.add(obj.steps[1]);
  }
  for (const value of Object.values(node)) collectComputedElementNeeds(value, out, seen);
};

// Parse a trailing projection, compiling entries outside the static model
// (`groups := (for z in (group .elements …) union (…))`) as IR values with
// the group row bound as the current item. Static entries keep their
// specialized lowerings; `needs` reports element fields the computed values
// read (for subject augmentation).
const parseProjectionWithComputedFallback = (
  trailingShape: EdgeQLShapeElement[] | undefined,
  priorProjection: GroupRowProjection[] | undefined,
  baseRows: Set,
  ctx: IRCompileContext,
): { projection?: GroupRowProjection[]; unlowerable?: boolean; needs: globalThis.Set<string> } => {
  const needs = new globalThis.Set<string>();
  const parsed = parseGroupRowProjection(trailingShape, priorProjection);
  if (!parsed.unlowerable || !trailingShape || !trailingShape.some((el) => el.kind === "computed")) {
    return { ...parsed, needs };
  }
  const computedCtx = childScope(ctx);
  bindValue(computedCtx, "__current__", baseRows);
  bindValue(computedCtx, "__subject__", baseRows);
  const merged: GroupRowProjection[] = [];
  for (const el of trailingShape) {
    const single = parseGroupRowProjection([el], priorProjection);
    if (!single.unlowerable && single.projection) {
      merged.push(...single.projection);
      continue;
    }
    if (el.kind === "computed" && typeof el.name === "string") {
      const compiled = tryResult(() => compileFreeObjectExpr(el.expr, computedCtx));
      if (compiled.ok) {
        let value = compiled.value;
        // A tuple referencing an INNER group binding (`select (even :=
        // z.key.x, …)` where z := (group .elements …)) iterates z
        // element-wise — rewrite to the equivalent FOR.
        let tupleCursor: Set = value;
        while (tupleCursor.expr.kind === "select_expr") {
          tupleCursor = (tupleCursor.expr as SelectExpr).result;
        }
        if (tupleCursor.expr.kind === "tuple") {
          const innerRows = new globalThis.Set<Set>();
          const findInnerRows = (node: unknown, seen = new globalThis.Set<unknown>()): void => {
            if (!node || typeof node !== "object" || seen.has(node)) return;
            seen.add(node);
            if (Array.isArray(node)) { node.forEach((item) => findInnerRows(item, seen)); return; }
            const obj = node as { kind?: unknown; rows?: Set };
            if (obj.kind === "group_row_field" && obj.rows && obj.rows !== baseRows) {
              innerRows.add(obj.rows);
            }
            for (const v of Object.values(node)) findInnerRows(v, seen);
          };
          findInnerRows(tupleCursor.expr);
          if (innerRows.size === 1) {
            const iterator = [...innerRows][0];
            value = {
              kind: "set",
              expr: { kind: "for_expr", iterator, body: value, bindingKind: "with", optional: false } as ForExpr,
              pathId: defaultPathId("group_inner_iteration"),
              typeref: value.typeref,
              shape: [],
              isBinding: false,
              isMaterializedRef: false,
              isSchemaAlias: false,
            };
          }
        }
        merged.push({ name: el.name, kind: "computed_set", value });
        collectComputedElementNeeds(value, needs);
        continue;
      }
    }
    return { unlowerable: true, needs };
  }
  return { projection: merged, needs };
};

const buildGroupRowsSet = (
  parts: GroupAstParts,
  trailingShape: EdgeQLShapeElement[] | undefined,
  ctx: IRCompileContext,
  extraElementFields: string[] = [],
): Set => {
  let parsed: { projection?: GroupRowProjection[]; unlowerable?: boolean } = parseGroupRowProjection(trailingShape);
  if (parsed.unlowerable && trailingShape && trailingShape.some((el) => el.kind === "computed")) {
    const baseRows = buildGroupRowsBaseSet(parts, ctx, extraElementFields);
    const withComputed = parseProjectionWithComputedFallback(trailingShape, undefined, baseRows, ctx);
    if (!withComputed.unlowerable) {
      parsed = withComputed;
      extraElementFields = [...extraElementFields, ...withComputed.needs];
    }
  }
  const elementFields = extraElementFields.concat((parsed.projection ?? [])
    .flatMap((p) => {
      if (p.kind === "elements_shape") {
        return p.fields.map(elementFieldSubjectName);
      }
      if (p.kind === "element_first_path") {
        return [p.steps[0] ?? ""];
      }
      if (p.kind === "element_first_shape") {
        return p.fields;
      }
      if (p.kind === "element_agg") {
        return [p.steps[0] ?? ""];
      }
      return [];
    })
    .filter((name) => name.length > 0));
  let source = parts.source;
  if (
    elementFields.length > 0
    && (source.kind === "select" || source.kind === "shape_projection")
  ) {
    const shape = [...(source.shape ?? [])];
    const present = new globalThis.Set<string>(
      shape
        .filter((s): s is Extract<EdgeQLShapeElement, { name: string }> => "name" in s && typeof s.name === "string")
        .map((s) => s.name),
    );
    const additions: EdgeQLShapeElement[] = [];
    for (const name of elementFields) {
      if (present.has(name)) continue;
      additions.push({ kind: "field", name });
      present.add(name);
    }
    if (additions.length > 0) {
      source = { ...source, shape: [...shape, ...additions] };
    }
  }
  const scoped = childScope(ctx);
  const group = makeGroupStmt({ ...parts, source }, scoped);
  return {
    kind: "set",
    expr: {
      kind: "group_rows",
      group,
      projection: parsed.projection,
      unlowerable: parsed.unlowerable,
      astParts: parts,
      astShape: trailingShape,
    } as GroupRowsExpr,
    pathId: defaultPathId("group_rows"),
    typeref: unknownTypeRef("std::FreeObject"),
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

// `(GROUP <subject> BY <atoms>)` in expression position. Link subjects keep
// the correlated embedded_group lowering (one JSON array per outer row, the
// shape-position semantics); general subjects compile to a `group_rows` set
// — one row per group — that the statement compiler lowers like a top-level
// GROUP (see compileGelIRToSQL's group_rows branch).
const compileGroupExprSet = (
  groupExpr: Extract<FreeObjectExpr, { kind: "group_expr" }>,
  trailingShape: EdgeQLShapeElement[] | undefined,
  ctx: IRCompileContext,
): Set => {
  // BY-clause name collisions (`BY @text, .text`) are rejected for every
  // expression-position group, regardless of which lowering handles it.
  validateGroupByAtomCollisions(groupExpr.by, (message) => {
    throw new AppError("E_SEMANTIC", message, 1, 1);
  });
  let probeAst: FreeObjectExpr = groupExpr.source;
  if (probeAst.kind === "shape_projection") probeAst = probeAst.expr;
  const probeAttempt = tryResult(() => compileFreeObjectExpr(probeAst, ctx));
  const probe: Set | undefined = probeAttempt.ok ? probeAttempt.value : undefined;
  if (probe && probe.expr.kind === "pointer" && !probe.typeref.isScalar) {
    return compileEmbeddedGroup(groupExpr, trailingShape, ctx);
  }
  return buildGroupRowsSet(
    { source: groupExpr.source, using: groupExpr.using, by: groupExpr.by },
    trailingShape,
    ctx,
  );
};

const compileConfigureStatement = (statement: ConfigureStatement, ctx: IRCompileContext): ConfigStmt => {
  const scoped = withBindings(ctx, statement.with);
  return {
    kind: "config_stmt",
    expr: statement.value ? compileFreeObjectExpr(statement.value, scoped) : literalToSet(null),
    ...statementBase(scoped),
    operation: statement.operation,
    scope: statement.scope,
    name: statement.target,
    value: statement.value ? compileFreeObjectExpr(statement.value, scoped) : undefined,
    span: statement.pos,
  };
};

export const compileASTToGelIR = (statement: EdgeQLStatement, options: IRCompileOptions = {}): Statement => {
  const schemaModel = resolveSchemaModelForCompile(options);
  const ctx: IRCompileContext = {
    module: options.module ?? statement.withModule ?? "default",
    schema: options.schema,
    schemaModel,
    nextScopeId: 2,
    params: new Map(),
    globals: new Map(),
    bindingScopes: [new Map()],
  };

  validateParametersInStatement(statement);

  // Scope-tree validation: reject correlated-reference violations (a path that
  // "changes the interpretation" of a set used elsewhere, or a correlated set
  // referenced inside a nested mutation). This is the oracle's check, now run on
  // the Live IR path too (the last inference dimension — ADR 0019). Unlike the
  // additive value-inferences, this one is meant to throw, so it is NOT guarded.
  if (ctx.schema) {
    checkScopeTreeViolations(statement, ctx.schema);
  }

  const buildResult = (): Statement => {
    switch (statement.kind) {
      case "select_expr": return compileSelectExprStatement(statement, ctx);
      case "select": return compileSelectStatement(statement, ctx);
      case "select_free": return compileSelectFreeStatement(statement, ctx);
      case "insert": return compileInsertStatement(statement, ctx);
      case "update": return compileUpdateStatement(statement, ctx);
      case "delete": return compileDeleteStatement(statement, ctx);
      case "for": return compileForStatement(statement, ctx);
      case "configure": return compileConfigureStatement(statement, ctx);
      case "group": return compileGroupStatement(statement, ctx);
      default:
        throw new AppError(
          "E_RUNTIME",
          `AST->IR entrypoint is scaffolded, but statement '${statement.kind}' is not wired yet`,
          statement.pos.line,
          statement.pos.column,
        );
    }
  };

  const result = buildResult();

  // Populate statement-level volatility inference on the Live IR. Purely
  // additive — nothing on the execution path reads `Statement.volatility`; this
  // brings the Live IR toward the oracle's inference (semantic.ts) so the oracle
  // can eventually be retired (the ADR 0001 follow-up). See ADR 0015.
  if (ctx.schema) {
    // Inference is additive decoration (nothing on the execution path reads
    // `Statement.volatility`), so it must never break a compile. Keep the
    // default if the walk hits a pathological shape (e.g. a self-referential
    // WITH binding that would recurse without bound).
    try {
      (result as { volatility: Volatility }).volatility = inferStatementVolatility(statement, ctx.schema, ctx.module);
    } catch {
      // leave default volatility
    }
    try {
      (result as { cardinality: string }).cardinality = inferStatementCardinality(statement, ctx.schema, ctx.module);
    } catch {
      // leave default cardinality
    }
    try {
      (result as { multiplicity: string }).multiplicity = inferStatementMultiplicity(statement, ctx.schema, ctx.module);
    } catch {
      // leave default multiplicity
    }
    try {
      const derived = inferStatementType(statement, ctx.schema, ctx.module);
      const baseType = (result as { expr?: { typeref?: { id?: string } } }).expr?.typeref?.id;
      const stype = derived ?? baseType;
      if (stype !== undefined) (result as { stype?: string }).stype = stype;
    } catch {
      // leave stype unset
    }
  }

  return result;
};

export const isGelIRCompatibleStatement = (statement: EdgeQLStatement): boolean => {
  return statement.kind === "select"
    || statement.kind === "select_expr"
    || statement.kind === "select_free"
    || statement.kind === "insert"
    || statement.kind === "update"
    || statement.kind === "delete"
    || statement.kind === "for"
    || statement.kind === "configure"
    || statement.kind === "group";
};

export type GelIRCompileResult = Statement;

const exprIsLiteralFalse = (expr: FreeObjectExpr): boolean => {
  return expr.kind === "literal" && expr.value === false;
};

const walkAndValidateShapes = (
  shape: EdgeQLShapeElement[],
  subject: Set,
  ctx: IRCompileContext,
): void => {
  for (const el of shape) {
    if (el.kind === "computed" && !el.name.startsWith("@")) {
      validateComputedShapeElement(el, subject, ctx);
    }
    if (el.kind === "link") {
      const ptrref = resolvePointerRef(ctx, subject.typeref, el.name);
      if (ptrref) {
        const inherited = findInheritedFieldOwner(ctx, subject.typeref.id, el.name);
        const inheritedRequired = inherited?.kind === "link" && inherited.link.required === true;
        const filterIsFalse = el.where ? exprIsLiteralFalse(el.where as FreeObjectExpr) : false;
        if (inheritedRequired && filterIsFalse) {
          throw new AppError(
            "E_SEMANTIC",
            `possibly an empty set returned by an expression for a computed link '${el.name}' declared as 'required'`,
            1, 1,
          );
        }
        const childSubject = extendPathSet(subject, ptrref);
        walkAndValidateShapes(el.shape, childSubject, ctx);
      }
    }
  }
};

const collectStatementShapesForValidation = (
  statement: EdgeQLStatement,
  ctx: IRCompileContext,
): void => {
  if (statement.kind === "select" && statement.typeName) {
    const typeref = resolveTypeRef(ctx, statement.typeName);
    const subject = setFromTypeRoot(typeref);
    walkAndValidateShapes(statement.shape, subject, ctx);
  }
};

export const validateParsedStatement = (
  statement: EdgeQLStatement,
  options: IRCompileOptions = {},
): void => {
  const schemaModel = resolveSchemaModelForCompile(options);
  const ctx: IRCompileContext = {
    module: options.module ?? (statement as { withModule?: string }).withModule ?? "default",
    schema: options.schema,
    schemaModel,
    nextScopeId: 2,
    params: new Map(),
    globals: new Map(),
    bindingScopes: [new Map()],
  };
  collectStatementShapesForValidation(statement, ctx);
};
