// Result codec: converts the engine's JSON-ish row values into the typed
// JavaScript values the gel-js Client contract promises (Date for datetime,
// BigInt for bigint, dashed uuid strings, Uint8Array for bytes, the
// datatype classes for durations/local dates, parsed values for json).
//
// Type information comes from the compiled IR: the statement's result Set
// carries a typeref tree (scalars, collections) and a shape (objects). When
// a query can't be compiled to IR (DML, unlowerable constructs), the codec
// degrades to internal-column stripping only — values pass through as the
// engine produced them, never worse than the raw envelope.
//
// Converters never throw: a value that doesn't parse as its declared type is
// returned unchanged.

import type { SchemaSnapshot } from "../schema/schema.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import { compileASTToGelIR, expandSchemaAliasesInStatement } from "../compiler/ast_to_ir.js";
import {
  DateDuration,
  Duration,
  LocalDate,
  LocalDateTime,
  LocalTime,
  RelativeDuration,
} from "./datatypes.js";

type Converter = (value: unknown) => unknown;

// Engine-internal columns that must never surface through the public client.
const INTERNAL_KEYS = new Set(["__source_type", "__tid__", "__tname__"]);

interface TypeRefLike {
  id?: string;
  nameHint?: string;
  isScalar?: boolean;
  collection?: string;
  subtypes?: TypeRefLike[];
}

interface SetLike {
  typeref?: TypeRefLike;
  shape?: ShapeElementLike[];
  expr?: { kind?: string; result?: SetLike };
}

interface ShapeElementLike {
  name?: string;
  expr: SetLike;
}

const normalizeTypeName = (typeref: TypeRefLike | undefined): string => {
  let name = typeref?.id ?? typeref?.nameHint ?? "";
  if (name.startsWith("unknown:")) name = name.slice("unknown:".length);
  return name;
};

const dashUuid = (value: string): string => {
  if (/^[0-9a-fA-F]{32}$/.test(value)) {
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
  return value;
};

const identity: Converter = (value) => value;

const nullSafe = (convert: Converter): Converter => (value) =>
  value === null || value === undefined ? value : convert(value);

const scalarConverter = (typeName: string): Converter => {
  switch (typeName) {
    case "std::uuid":
      return nullSafe((v) => (typeof v === "string" ? dashUuid(v) : v));
    case "std::datetime":
      return nullSafe((v) => {
        if (typeof v !== "string") return v;
        const parsed = new Date(v);
        return Number.isNaN(parsed.getTime()) ? v : parsed;
      });
    case "std::bigint":
      return nullSafe((v) => {
        if (typeof v === "bigint") return v;
        if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
        if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
        return v;
      });
    case "std::bytes":
      return nullSafe((v) => {
        if (v instanceof Uint8Array) return v;
        if (typeof v === "string") return new TextEncoder().encode(v);
        return v;
      });
    case "std::json":
      return nullSafe((v) => {
        if (typeof v !== "string") return v;
        try {
          return JSON.parse(v) as unknown;
        } catch {
          return v;
        }
      });
    case "std::duration":
      return nullSafe((v) => (typeof v === "string" ? Duration.fromString(v) ?? v : v));
    case "cal::local_date":
      return nullSafe((v) => (typeof v === "string" ? LocalDate.fromString(v) ?? v : v));
    case "cal::local_time":
      return nullSafe((v) => (typeof v === "string" ? LocalTime.fromString(v) ?? v : v));
    case "cal::local_datetime":
      return nullSafe((v) => (typeof v === "string" ? LocalDateTime.fromString(v) ?? v : v));
    case "cal::relative_duration":
      // The engine surfaces these as strings; without component breakdown we
      // wrap the raw value only when it parses as an absolute duration.
      return nullSafe((v) => {
        if (typeof v !== "string") return v;
        const abs = Duration.fromString(v);
        if (abs) return new RelativeDuration(0, 0, 0, 0, abs.hours, abs.minutes, abs.seconds);
        return v;
      });
    case "cal::date_duration":
      return nullSafe((v) => (typeof v === "string" ? parseDateDuration(v) ?? v : v));
    default:
      return identity;
  }
};

const parseDateDuration = (value: string): DateDuration | null => {
  const iso = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(value.trim());
  if (!iso || (iso[1] === undefined && iso[2] === undefined && iso[3] === undefined && iso[4] === undefined)) {
    return null;
  }
  return new DateDuration(Number(iso[1] ?? 0), Number(iso[2] ?? 0), Number(iso[3] ?? 0), Number(iso[4] ?? 0));
};

// Strip engine-internal keys recursively; applied even when no IR-derived
// type information is available.
export const stripInternalColumns = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripInternalColumns);
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (INTERNAL_KEYS.has(key)) continue;
      out[key] = stripInternalColumns(entry);
    }
    return out;
  }
  return value;
};

const typeRefConverter = (typeref: TypeRefLike | undefined): Converter => {
  if (!typeref) return identity;
  if (typeref.collection === "array") {
    const element = typeRefConverter(typeref.subtypes?.[0]);
    return nullSafe((v) => (Array.isArray(v) ? v.map(element) : v));
  }
  if (typeref.collection === "tuple") {
    const elements = (typeref.subtypes ?? []).map(typeRefConverter);
    return nullSafe((v) => {
      if (Array.isArray(v)) {
        return v.map((item, i) => (elements[i] ?? identity)(item));
      }
      return v;
    });
  }
  return scalarConverter(normalizeTypeName(typeref));
};

const setConverter = (set: SetLike | undefined): Converter => {
  if (!set) return identity;
  // Unwrap select_expr layers so the typeref/shape of the underlying result
  // drives conversion.
  let cursor: SetLike = set;
  let guard = 0;
  while (cursor.expr?.kind === "select_expr" && cursor.expr.result && guard++ < 32) {
    if ((cursor.shape ?? []).length > 0) break;
    cursor = cursor.expr.result;
  }
  const shape = cursor.shape ?? [];
  if (shape.length > 0) {
    const fields = new Map<string, Converter>();
    for (const element of shape) {
      if (!element.name) continue;
      fields.set(element.name, setConverter(element.expr));
    }
    return nullSafe((v) => {
      if (Array.isArray(v)) {
        // Multi link/set materialized as an array of objects.
        const objectConvert = setConverter(cursor);
        return v.map(objectConvert);
      }
      if (v !== null && typeof v === "object" && (v as object).constructor === Object) {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
          if (INTERNAL_KEYS.has(key)) continue;
          const fieldConvert = fields.get(key);
          out[key] = fieldConvert ? fieldConvert(entry) : stripInternalColumns(entry);
        }
        return out;
      }
      return v;
    });
  }
  const typeref = cursor.typeref ?? set.typeref;
  // Try the scalar/collection conversion first: the IR builder marks many
  // scalar typerefs `isScalar: false` (the `unknown:` placeholder family),
  // so the name-keyed converter table is the reliable signal.
  const valueConverter = typeRefConverter(typeref);
  if (valueConverter !== identity) {
    return valueConverter;
  }
  const typeName = normalizeTypeName(typeref);
  const looksLikeObjectType = typeref !== undefined
    && !typeref.isScalar
    && typeref.collection === undefined
    && !typeName.startsWith("std::")
    && !typeName.startsWith("cal::")
    && typeName.includes("::");
  if (looksLikeObjectType) {
    // Object set without an explicit shape — identity objects; strip
    // internals and dash the id.
    return nullSafe((v) => {
      const stripped = stripInternalColumns(v);
      if (stripped !== null && typeof stripped === "object" && !Array.isArray(stripped)) {
        const record = stripped as Record<string, unknown>;
        if (typeof record.id === "string") record.id = dashUuid(record.id);
      }
      return stripped;
    });
  }
  return identity;
};

// Build a per-row converter for `query`. Returns null when the statement
// can't be compiled for type info — callers fall back to stripping only.
export const buildRowConverter = (
  schema: SchemaSnapshot,
  query: string,
  defaultModule: string,
): Converter | null => {
  try {
    const parsed = parseEdgeQL(query) as unknown;
    const statement = Array.isArray(parsed) ? parsed[0] : parsed;
    const expanded = expandSchemaAliasesInStatement(statement as never, schema);
    const ir = compileASTToGelIR(expanded as never, { schema, defaultModule } as never) as { kind?: string; expr?: SetLike };
    if (ir?.kind !== "select_stmt" || !ir.expr) return null;
    return setConverter(ir.expr);
  } catch {
    return null;
  }
};
