// Value-kind facts about a Gel IR `Set` — "what kind of value does this set
// produce?" — answered ONCE, here, instead of re-peeling IR shapes at each SQL
// lowering leaf.
//
// Motivation (the first-party "semantic seam", ADR 0057): a local SQL fix such
// as string index/slice previously had to re-derive, inline, the answer to
// "is this base a string?" — peeling `select_expr` wrappers, consulting the
// typeref, special-casing literals and index/slice chains (the old
// `isStringValuedSet` in gel_ir_compiler.ts). That re-derivation lived next to
// the leaf, was duplicated per call site, and saw only partial context. This
// module centralizes the classification so SQL lowering can ask a fact
// (`valueFactsOf(set).category === "scalar" && .typeName === "std::str"`)
// rather than reconstruct it.
//
// Pure: no IR mutation, no schema access — it reads only the IR `Set`/`TypeRef`
// the builder already produced. Lives in `src/ir/` (the lowest layer) so the
// SQL compiler can import it without a cycle.

import type { IndexExpr, SelectExpr, Set, SliceExpr, TypeRef } from "./gel_ir.js";

export type ValueCategory = "scalar" | "collection" | "object" | "unknown";
export type CollectionKind = "array" | "tuple" | "range" | "multirange";

export interface ValueFacts {
  /** The broad shape of the value this set produces. */
  category: ValueCategory;
  /**
   * Fully-qualified type name (`std::str`, `default::User`) when known; the
   * empty string when the typeref carries no usable name. For scalars whose
   * typeref under-detects (a bare string literal is `std::anyscalar`), this is
   * the *resolved* kind, not the raw typeref name.
   */
  typeName: string;
  /** For `category === "collection"`, which collection kind. */
  collection?: CollectionKind;
}

/**
 * An IR `TypeRef` → its fully-qualified name. This is the single
 * implementation of TypeRef name-qualification; the SQL compiler's
 * `qualifyTypeName` delegates here (ADR 0057). Distinct from
 * `schema/schema.ts`'s `qualifiedTypeName`, which qualifies a *schema*
 * TypeDef rather than an IR TypeRef.
 */
export const qualifiedTypeRefName = (typeRef: TypeRef): string =>
  typeRef.nameHint.includes("::") ? typeRef.nameHint : `${typeRef.module}::${typeRef.nameHint}`;

const scalarFacts = (typeName: string): ValueFacts => ({ category: "scalar", typeName });

// The non-str/bytes literal kinds (str/bytes are pinned separately because the
// SQL layer keys on them). An uncast numeric literal carries `std::anyscalar`,
// so its kind — not its typeref — tells us it is a scalar.
const NUMERIC_BOOL_CONSTANT_KINDS = new Set<string>([
  "integer_constant",
  "float_constant",
  "decimal_constant",
  "bigint_constant",
  "boolean_constant",
]);

/**
 * Classify the value a set produces, folding the wrapper-peeling and the
 * literal / index-slice special cases into one place.
 *
 * Subtleties consolidated here:
 *  - `select_expr` wrappers (`SELECT <expr>`) are transparent to value kind;
 *  - a bare string/bytes literal carries `unknown:std::anyscalar`, so its
 *    typeref under-detects — the constant's syntactic kind is authoritative;
 *  - indexing/slicing a str/bytes loses the scalar type on the *result* set's
 *    typeref, but the kind is preserved (a char of a str is a str, a slice of
 *    a str is a str). For collection sources we instead fall through to the
 *    result typeref, which carries the element/slice type.
 */
export const valueFactsOf = (set: Set): ValueFacts => {
  let cur: Set = set;
  while (cur.expr.kind === "select_expr") cur = (cur.expr as SelectExpr).result;
  const e = cur.expr;
  const t = cur.typeref;
  const name = t ? qualifiedTypeRefName(t) : "";

  // Literals are scalars even when the typeref is the abstract `anyscalar`.
  // str/bytes are pinned (syntactically unambiguous; the SQL layer keys on
  // them); other numeric/bool literals report the typeref name (often
  // `std::anyscalar` until a cast/inference pins it) but the *category* is
  // authoritative.
  if (e.kind === "string_constant") return scalarFacts("std::str");
  if (e.kind === "bytes_constant") return scalarFacts("std::bytes");
  if (NUMERIC_BOOL_CONSTANT_KINDS.has(e.kind)) return scalarFacts(name);

  // Literal collections — a tuple's typeref doesn't always carry `.collection`,
  // so key off the expr kind.
  if (e.kind === "tuple") return { category: "collection", typeName: name || "std::tuple", collection: "tuple" };
  if (e.kind === "array") return { category: "collection", typeName: name, collection: "array" };

  // Index/slice of a str/bytes preserves the scalar kind though the result
  // typeref loses it (`'f'[0][0]`). Collection sources fall through to the
  // result typeref below.
  if (e.kind === "index_expr" || e.kind === "slice_expr") {
    const inner = valueFactsOf((e as IndexExpr | SliceExpr).expr);
    if (inner.category === "scalar" && (inner.typeName === "std::str" || inner.typeName === "std::bytes")) {
      return scalarFacts(inner.typeName);
    }
  }

  // str / bytes detection must hold regardless of the isScalar flag (keeps
  // parity with the old isStringValuedSet, which keyed off the qualified name).
  if (name === "std::str" || name === "std::bytes") return scalarFacts(name);
  if (t?.collection) return { category: "collection", typeName: name, collection: t.collection };
  // `isScalar` is an unreliable discriminator in this IR — it is left `false`
  // on both object typerefs (`default::Issue`) AND scalar results of casts /
  // operators (`<int64>1` carries `isScalar:false`). So classify positively:
  // object typerefs carry schema-structural fields (they're in the schema, have
  // a concrete-subtype list, or are a union/intersection); scalars never do.
  // A named typeref that is neither a collection nor structurally an object is
  // a scalar (a cast/operator/pointer result).
  if (t?.isScalar) return scalarFacts(name);
  const looksLikeObject = !!(t && (t.inSchema || t.children || t.union || t.intersection));
  if (looksLikeObject) return { category: "object", typeName: name };
  if (name) return scalarFacts(name);
  return { category: "unknown", typeName: name };
};

/**
 * True when the set produces a `std::str` value — including string literals
 * (whose typeref is `anyscalar`) and index/slice chains over one. The
 * first-party replacement for the inline `isStringValuedSet`.
 */
export const isStrValued = (set: Set): boolean => {
  const f = valueFactsOf(set);
  return f.category === "scalar" && f.typeName === "std::str";
};

/** True when the set produces a `std::bytes` value (literals + index/slice chains). */
export const isBytesValued = (set: Set): boolean => {
  const f = valueFactsOf(set);
  return f.category === "scalar" && f.typeName === "std::bytes";
};
