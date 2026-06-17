// Decodes `gel_*` metadata rows back into schema defs — the one home for the
// gel-table row format on the *read* path, and the test surface for it. The
// serializers in `gel_persistence.ts` are the write counterpart; the decode
// rules used to be ~8 free functions wired into the 320-line
// `deserializeSchemaFromGelTables` by a shared `idToRow` local, reachable only
// through a full schema round-trip. Here the row index is bound once
// (`GelTableDecoder`) so each id-resolving rule is a method, and the
// metadata-string parsers are pure exported functions a test can call directly.
// See docs/adr/0034.
//
// `parseComputedPropertyExpr` / `parseComputedLinkExpr` share their names with
// the SDL-side parsers in `sdl_adapter.ts` but stay separate: these decode the
// narrow canonical output of `serializeComputedExpr`, not arbitrary user SDL
// (docs/adr/0024). The relocation does not change that boundary.
import type {
  ComputedDef,
  FunctionParamDef,
  MutationRewriteExpr,
  ScalarType,
  ScalarValue,
} from "../types.js";
import type { FunctionMetadata } from "./gel_metadata_schemas.js";
import { parseComputedSetLiteralExpr } from "./computed_expr.js";
import { AppError } from "../errors.js";

// The columns the decoder reads off a `gel_schema` row, structurally. The full
// row carries more; the decode rules only ever look at these three.
export type DecoderRow = { kind: string; name: string; name__internal: string };

// Binds the `gel_schema` row index (`id` → row) once, so every type-id-resolving
// decode rule is a small method instead of a free function threading the map.
export class GelTableDecoder {
  // ReadonlyMap (not Map): the decoder only ever reads the index, and the
  // covariant value type lets the caller pass its richer `gel_schema` row map.
  constructor(private readonly idToRow: ReadonlyMap<string, DecoderRow>) {}

  // A field's scalar type from its `target_type_id`. `scalar_*` ids carry the
  // base name inline; object-type ids resolve through the row index; unknown
  // ids fall back to `str` (the legacy default).
  scalarType(targetTypeId: string | undefined): ScalarType {
    if (!targetTypeId) return "str";
    if (targetTypeId.startsWith("scalar_")) return targetTypeId.replace("scalar_", "") as ScalarType;
    const row = this.idToRow.get(targetTypeId);
    if (row) return row.name as ScalarType;
    return "str";
  }

  // A link's target (qualified) type name from its `target_type_id`.
  targetType(targetTypeId: string | undefined): string {
    if (!targetTypeId) return "std::str";
    const row = this.idToRow.get(targetTypeId);
    if (row) return row.name__internal;
    return targetTypeId;
  }

  // A (qualified) type name from an id — used for function return types and
  // parameter types. `scalar_*` ids carry the bare scalar name.
  typeName(typeId: string | undefined): string {
    if (!typeId) {
      return "std::str";
    }

    if (typeId.startsWith("scalar_")) {
      return typeId.replace(/^scalar_/, "");
    }

    const row = this.idToRow.get(typeId);
    if (row) {
      return row.name__internal;
    }

    return typeId;
  }

  // Function parameter defs from their stored metadata.
  functionParams(metaParams: FunctionMetadata["params"] | undefined): FunctionParamDef[] {
    return (metaParams ?? []).map((param) => ({
      name: param.name,
      type: this.typeName(param.type_id),
      optional: param.typemod === "OptionalType",
      setOf: param.typemod === "SetOfType",
      variadic: param.kind === "VariadicParam",
      namedOnly: param.kind === "NamedOnlyParam",
      default: parseScalarValueFromMetadata(param.default),
    }));
  }
}

// --- Pure metadata-string parsers (no row context) -------------------------

export const parseComputedPropertyExpr = (exprStr: string): Extract<ComputedDef, { kind: "property" }>["expr"] => {
  const aggregateMatch = exprStr.match(/^\s*sum\(\.([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\)\s*$/i);
  if (aggregateMatch) {
    return {
      kind: "link_aggregate",
      functionName: "sum",
      link: aggregateMatch[1],
      field: aggregateMatch[2],
    };
  }

  const setLiteral = parseComputedSetLiteralExpr(exprStr);
  if (setLiteral) {
    return setLiteral;
  }

  if (exprStr.startsWith(".")) {
    const field = exprStr.slice(1);
    if (field.includes(" ")) {
      return { kind: "function_call", name: field.split("(")[0], args: [] };
    }
    return { kind: "field_ref", field };
  }
  return { kind: "literal", value: exprStr };
};

export const parseComputedLinkExpr = (exprStr: string): { kind: "link_ref"; link: string; filter?: { field: string; op: "=" | "!=" | "like" | "ilike"; value: ScalarValue } } | { kind: "backlink"; link: string; sourceType?: string } => {
  if (exprStr.startsWith(".<")) {
    const link = exprStr.slice(2).split("[")[0];
    const sourceType = exprStr.includes("[is ") ? exprStr.split("[is ")[1]?.split("]")[0] : undefined;
    return { kind: "backlink", link, sourceType };
  }
  return { kind: "link_ref", link: exprStr.slice(1) };
};

export const parseRewriteExpr = (exprStr: string): MutationRewriteExpr => {
  if (exprStr === "datetime_of_statement()") return { kind: "datetime_of_statement" };
  if (exprStr.startsWith("__old__.")) return { kind: "old_field", field: exprStr.slice(8) };
  if (exprStr.startsWith(".")) return { kind: "subject_field", field: exprStr.slice(1) };
  try {
    return { kind: "literal", value: JSON.parse(exprStr) };
  } catch (e) {
    // Literal rewrite expressions are stored via JSON.stringify (see
    // serializeRewriteExpr), so a non-JSON value is corrupt metadata.
    throw new AppError(
      "E_RUNTIME",
      `corrupt rewrite expression in gel_pointer_rewrites metadata: not valid JSON: ${JSON.stringify(exprStr.slice(0, 80))}`,
      { cause: e },
    );
  }
};

export const parseScalarValueFromMetadata = (value: string | undefined | null): ScalarValue | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    // Scalar values in function-param metadata are stored via
    // JSON.stringify (see buildFunctionParamMetadata), so a non-JSON value
    // is corrupt metadata.
    throw new AppError(
      "E_RUNTIME",
      `corrupt scalar value in function metadata: not valid JSON: ${JSON.stringify(value.slice(0, 80))}`,
      { cause: e },
    );
  }
};
