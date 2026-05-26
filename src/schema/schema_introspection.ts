// Schema introspection types & population.
//
// EdgeDB exposes its own metadata through a `schema` module — `schema::Type`,
// `schema::ObjectType`, `schema::Pointer`, `schema::Tuple`, etc. (See
// `edb/lib/schema.edgeql` for the canonical definition.) Queries against
// these types ("WITH MODULE schema SELECT Type FILTER .name = '...'") need
// to flow through the regular SELECT pipeline; previously every shape had
// its own regex-driven bypass (`trySchemaTypeQuery`, `trySchemaObjectType
// Query`, …) which this module is the first step toward replacing.
//
// Phase 1 (this file): register `schema::Type` as a real TypeDef, create the
// backing SQLite table, and populate one row per user type / alias / synthetic
// type. Enough for the `aliases_schema_types_*` and `expr_array_08`/
// `expr_tuple_16` queries. Phases 2-3 add ObjectType, ScalarType, Pointer,
// Tuple, Constraint, Annotation, Index, Function, etc. with their links.

import type { TypeDef } from "../types.js";
import type { SchemaSnapshot } from "./schema.js";
import { qualifiedTypeName } from "./schema.js";

// Returns TypeDefs for the `schema::*` introspection module that should be
// folded into every SchemaSnapshot. Currently just `schema::Type`; extend
// here as later phases land.
export const schemaIntrospectionTypeDefs = (): TypeDef[] => [
  {
    name: "Type",
    module: "schema",
    abstract: true,
    fields: [
      { name: "name", type: "str", required: true },
      { name: "from_alias", type: "bool" },
    ],
  },
];

// SQLite database surface needed for populating introspection rows. Kept
// narrow so this module doesn't depend on the full SQLiteDatabase type.
interface IntrospectionDB {
  prepare: (sql: string) => {
    all: (...params: (string | number | boolean | null)[]) => unknown;
    run: (...params: (string | number | boolean | null)[]) => { changes: number };
  };
}

const SCHEMA_TYPE_TABLE = "schema__type";
const quoteIdent = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

// Rewrites the `schema__type` table so it reflects the current SchemaSnapshot.
// Called once after `materializeSchema` and again whenever a CREATE/DROP
// ALIAS mutates alias state, so the introspection rows track schema changes
// without each query touching SchemaSnapshot directly.
//
// `extraAliasNames` covers aliases that don't live on SchemaSnapshot — the
// engine's runtime expr-alias map keeps scalar/tuple-set CREATE ALIAS forms
// separately from typed schema aliases. The caller (executeScript) passes
// listAllRuntimeAliasNames(schema) to merge both flavors.
export const populateSchemaIntrospection = (
  db: IntrospectionDB,
  schema: SchemaSnapshot,
  extraAliasNames: readonly string[] = [],
): void => {
  db.prepare(`DELETE FROM ${quoteIdent(SCHEMA_TYPE_TABLE)}`).run();

  const insert = db.prepare(
    `INSERT INTO ${quoteIdent(SCHEMA_TYPE_TABLE)} (${quoteIdent("id")}, ${quoteIdent("name")}, ${quoteIdent("from_alias")}) VALUES (?, ?, ?)`,
  );

  // EdgeQL introspection identifies entries by `name` (`default::User`,
  // `schema::ObjectType`, …); the actual UUID is opaque. We derive a stable
  // id from the name so re-population doesn't change ids unnecessarily.
  const idFor = (name: string): string => syntheticIntrospectionId(name);

  // User types and aliases. EdgeDB also exposes synthetic types created by
  // alias-defined shapes (`default::__best_card__Card` for an alias whose
  // body is `SELECT Card { ... }`); those are populated in later phases.
  const seen = new Set<string>();
  const writeRow = (name: string, fromAlias: boolean): void => {
    if (seen.has(name)) return;
    seen.add(name);
    insert.run(idFor(name), name, fromAlias ? 1 : 0);
  };

  for (const typeDef of schema.listTypes()) {
    const name = qualifiedTypeName(typeDef);
    if (name.startsWith("schema::")) {
      // Skip the introspection types themselves — they're builtins, not
      // user-visible from_alias entries. Phase 2/3 will re-add these once
      // schema::ObjectType etc. are real and we need them queryable.
      continue;
    }
    writeRow(name, false);
  }
  for (const alias of schema.listAliases()) {
    writeRow(`${alias.module}::${alias.name}`, true);
  }
  for (const name of extraAliasNames) {
    writeRow(name, true);
  }
};

// Deterministic, opaque id for an introspection row. Hex-encodes a hash of
// the qualified name so rows are stable across re-population.
const syntheticIntrospectionId = (name: string): string => {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < name.length; i += 1) {
    h ^= BigInt(name.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // 16 hex chars × 2 = 32 chars, formatted like the existing
  // `lower(hex(randomblob(16)))` ids the DB triggers emit.
  const hex = h.toString(16).padStart(16, "0");
  return `${hex}${hex.split("").reverse().join("")}`;
};
