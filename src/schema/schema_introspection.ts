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

import type { AliasDef, AnnotationDef, ConstraintDef, FieldDef, FunctionDef, LinkDef, TypeDef } from "../types.js";
import type { ScalarTypeDeclaration } from "./scalar.js";
import type { SchemaSnapshot } from "./schema.js";
import { qualifiedTypeName } from "./schema.js";
import { tableNameForType } from "../codegen/sql.js";
import { STDLIB_FUNCTIONS } from "../stdlib/registry.js";

const typeFields = (): FieldDef[] => [
  { name: "name", type: "str", required: true },
  { name: "from_alias", type: "bool" },
  // Gel's canonical field is `abstract` (schema::SubclassableObject); `is_abstract`
  // is its backwards-compat alias. We expose both so introspection queries that
  // use either name resolve. See edb/lib/schema.edgeql.
  { name: "abstract", type: "bool" },
  { name: "is_abstract", type: "bool" },
];

const annotationLink = (): LinkDef => ({
  name: "annotations",
  targetType: "schema::Annotation",
  multi: true,
  properties: [{ name: "value", type: "str" }],
});

const indexedTypeLink = (name: "bases" | "ancestors"): LinkDef => ({
  name,
  targetType: "schema::Type",
  multi: true,
  properties: [{ name: "index", type: "int" }],
});

// Returns TypeDefs for the `schema::*` introspection module that should be
// folded into every SchemaSnapshot. These TypeDefs are intentionally regular
// object types backed by SQLite tables so introspection queries can use the
// same typed-select IR/SQL path as user data.
export const schemaIntrospectionTypeDefs = (): TypeDef[] => [
  {
    name: "Type",
    module: "schema",
    abstract: true,
    fields: typeFields(),
  },
  {
    name: "Module",
    module: "schema",
    fields: [{ name: "name", type: "str", required: true }],
  },
  {
    name: "Annotation",
    module: "schema",
    fields: [{ name: "name", type: "str", required: true }],
  },
  {
    name: "ConstraintParam",
    module: "schema",
    fields: [{ name: "name", type: "str", required: true }],
  },
  {
    name: "Constraint",
    module: "schema",
    fields: [
      { name: "name", type: "str", required: true },
      { name: "delegated", type: "bool" },
      // From schema::SubclassableObject / schema::Constraint in schema.edgeql.
      // `abstract` distinguishes a constraint *definition* (std::exclusive) from
      // a concrete *application* on a property.
      { name: "abstract", type: "bool" },
      { name: "is_abstract", type: "bool" },
      { name: "expr", type: "str" },
      { name: "subjectexpr", type: "str" },
      { name: "errmessage", type: "str" },
    ],
    links: [
      annotationLink(),
      {
        name: "params",
        targetType: "schema::ConstraintParam",
        multi: true,
        properties: [{ name: "value", type: "str" }],
      },
    ],
  },
  {
    name: "Index",
    module: "schema",
    fields: [{ name: "expr", type: "str" }],
  },
  {
    name: "Property",
    module: "schema",
    fields: [
      { name: "name", type: "str", required: true },
      { name: "target_id", type: "uuid" },
    ],
    links: [
      annotationLink(),
      { name: "constraints", targetType: "schema::Constraint", multi: true },
      { name: "target", targetType: "schema::Type" },
    ],
  },
  {
    name: "Link",
    module: "schema",
    fields: [
      { name: "name", type: "str", required: true },
      { name: "target_id", type: "uuid" },
    ],
    links: [
      annotationLink(),
      { name: "properties", targetType: "schema::Property", multi: true },
      { name: "target", targetType: "schema::Type" },
    ],
  },
  {
    name: "Pointer",
    module: "schema",
    fields: [
      { name: "name", type: "str", required: true },
      { name: "source_id", type: "uuid" },
      { name: "target_id", type: "uuid" },
    ],
    links: [
      annotationLink(),
      { name: "source", targetType: "schema::Type" },
      { name: "target", targetType: "schema::Type" },
    ],
  },
  {
    name: "ObjectType",
    module: "schema",
    fields: [
      ...typeFields(),
      // EXISTS .union_of OR EXISTS .intersection_of — false for ordinary
      // user/std types; true only for synthesized union/intersection types.
      { name: "compound_type", type: "bool" },
    ],
    links: [
      annotationLink(),
      { name: "properties", targetType: "schema::Property", multi: true },
      { name: "links", targetType: "schema::Link", multi: true },
      { name: "pointers", targetType: "schema::Pointer", multi: true },
      { name: "indexes", targetType: "schema::Index", multi: true },
      indexedTypeLink("bases"),
      indexedTypeLink("ancestors"),
    ],
  },
  {
    name: "ScalarType",
    module: "schema",
    fields: [
      ...typeFields(),
      { name: "default", type: "str" },
    ],
    links: [
      indexedTypeLink("ancestors"),
      { name: "constraints", targetType: "schema::Constraint", multi: true },
    ],
  },
  {
    name: "FunctionParam",
    module: "schema",
    fields: [
      { name: "num", type: "int", required: true },
      { name: "name", type: "str" },
      { name: "kind", type: "str", required: true },
      { name: "typemod", type: "str", required: true },
      { name: "type_id", type: "uuid" },
    ],
    links: [{ name: "type", targetType: "schema::Type" }],
  },
  {
    name: "Function",
    module: "schema",
    fields: [
      { name: "name", type: "str", required: true },
      { name: "volatility", type: "str" },
      { name: "return_typemod", type: "str", required: true },
      { name: "return_type_id", type: "uuid" },
    ],
    links: [
      annotationLink(),
      { name: "params", targetType: "schema::FunctionParam", multi: true },
      { name: "return_type", targetType: "schema::Type" },
    ],
  },
  {
    name: "TupleElement",
    module: "schema",
    fields: [{ name: "type_id", type: "uuid" }],
    links: [{ name: "type", targetType: "schema::Type" }],
  },
  {
    name: "Tuple",
    module: "schema",
    fields: typeFields(),
    links: [
      {
        name: "element_types",
        targetType: "schema::TupleElement",
        multi: true,
        properties: [{ name: "index", type: "int" }],
      },
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
const scopedIdFor = (scope: string, name: string): string => syntheticIntrospectionId(`${scope}:${name}`);

type SQLParam = string | number | boolean | null;

type RuntimeExprAliasMap = ReadonlyMap<string, string>;

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
  runtimeExprAliases?: RuntimeExprAliasMap,
): void => {
  const typeNames = schemaIntrospectionTypeDefs().map((typeDef) => `schema::${typeDef.name}`);
  const tableNames = typeNames.map(tableNameForType);
  const linkTableNames = schemaIntrospectionTypeDefs().flatMap((typeDef) => {
    const ownerName = `schema::${typeDef.name}`;
    return (typeDef.links ?? [])
      .filter((link) => Boolean(link.multi) || (link.properties?.length ?? 0) > 0)
      .map((link) => `${tableNameForType(ownerName)}__${link.name.toLowerCase()}`);
  });

  for (const table of [...linkTableNames, ...tableNames]) {
    db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
  }

  const insertCache = new Map<string, { run: (...params: SQLParam[]) => { changes: number } }>();
  const insertRow = (table: string, row: Record<string, SQLParam>): void => {
    const columns = Object.keys(row);
    const key = `${table}:${columns.join(",")}`;
    let stmt = insertCache.get(key);
    if (!stmt) {
      stmt = db.prepare(
        `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      insertCache.set(key, stmt);
    }
    stmt.run(...columns.map((column) => row[column] ?? null));
  };

  const insertLink = (
    ownerType: string,
    linkName: string,
    sourceId: string,
    targetId: string,
    properties: Record<string, SQLParam> = {},
  ): void => {
    insertRow(`${tableNameForType(ownerType)}__${linkName.toLowerCase()}`, {
      source: sourceId,
      target: targetId,
      ...properties,
    });
  };

  // EdgeQL introspection identifies entries by `name` (`default::User`,
  // `schema::ObjectType`, …); the actual UUID is opaque. We derive a stable
  // id from the name so re-population doesn't change ids unnecessarily.
  const typeIdFor = (name: string): string => syntheticIntrospectionId(name);

  // User types and aliases. EdgeDB also exposes synthetic types created by
  // alias-defined shapes (`default::__best_card__Card` for an alias whose
  // body is `SELECT Card { ... }`); those are populated in later phases.
  const typeRows = new Set<string>();
  const writeTypeRow = (name: string, fromAlias: boolean, isAbstract = false): string => {
    const id = typeIdFor(name);
    if (typeRows.has(name)) return id;
    typeRows.add(name);
    insertRow(SCHEMA_TYPE_TABLE, {
      id,
      name,
      from_alias: fromAlias ? 1 : 0,
      abstract: isAbstract ? 1 : 0,
      is_abstract: isAbstract ? 1 : 0,
    });
    return id;
  };

  const ensureTypeRow = (name: string, fromAlias = false, isAbstract = false): string => {
    return writeTypeRow(name, fromAlias, isAbstract);
  };

  const annotationIds = new Map<string, string>();
  const ensureAnnotation = (name: string): string => {
    const existing = annotationIds.get(name);
    if (existing) return existing;
    const id = scopedIdFor("schema::Annotation", name);
    annotationIds.set(name, id);
    insertRow("schema__annotation", { id, name });
    return id;
  };

  const linkAnnotations = (
    ownerType: string,
    sourceId: string,
    annotations: readonly AnnotationDef[] | undefined,
  ): void => {
    for (const annotation of annotations ?? []) {
      insertLink(ownerType, "annotations", sourceId, ensureAnnotation(annotation.name), { value: annotation.value });
    }
  };

  for (const typeDef of schema.listTypes()) {
    const name = qualifiedTypeName(typeDef);
    if (name.startsWith("schema::")) {
      // Skip the introspection types themselves in schema::Type; user queries
      // mostly want application and std rows here, while each schema subtype
      // has its own concrete table below.
      continue;
    }
    writeTypeRow(name, false, Boolean(typeDef.abstract));
  }
  for (const alias of schema.listAliases()) {
    writeTypeRow(`${alias.module}::${alias.name}`, true);
  }
  for (const name of extraAliasNames) {
    writeTypeRow(name, true);
  }

  for (const scalarType of schema.listScalarTypes()) {
    writeTypeRow(`${scalarType.module}::${scalarType.name}`, false);
  }

  for (const builtin of builtinTypeNames(schema)) {
    writeTypeRow(builtin, false, builtin === "std::Object" || builtin === "std::BaseObject");
  }

  for (const typeDef of schema.listTypes()) {
    const name = qualifiedTypeName(typeDef);
    if (name.startsWith("schema::") || isScalarTypeDef(typeDef)) {
      continue;
    }
    populateObjectType(db, schema, insertRow, insertLink, linkAnnotations, ensureTypeRow, typeDef);
  }

  for (const alias of schema.listAliases()) {
    populateAliasPointers(insertRow, insertLink, linkAnnotations, ensureTypeRow, alias);
  }

  for (const scalarType of schema.listScalarTypes()) {
    populateScalarType(db, schema, insertRow, insertLink, ensureTypeRow, linkAnnotations, scalarType);
  }

  for (const fn of schema.listFunctions()) {
    populateFunction(insertRow, insertLink, ensureTypeRow, linkAnnotations, fn);
  }

  populateTupleAliases(insertRow, insertLink, ensureTypeRow, runtimeExprAliases);

  populateModules(insertRow, schema);
  populateStdScalarTypes(db, insertRow, ensureTypeRow);
  populateStdlibFunctions(db, insertRow);
  populateAbstractConstraints(insertRow);
};

// Names already written to a `schema__*` table this round — used so the std-lib
// populators below don't double-insert a row a user definition already covers.
const existingNames = (db: IntrospectionDB, table: string): Set<string> => {
  const rows = db.prepare(`SELECT name FROM ${quoteIdent(table)}`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
};

// The standard scalar types every Gel branch defines (edb/lib/std + cal).
// Concrete first, then the abstract "any*" scalars (schema::ScalarType rows
// with abstract := true). Pseudo-types (anytype/anytuple/anyobject) are NOT
// here — they are schema::PseudoType, populated separately.
const STD_CONCRETE_SCALARS: readonly string[] = [
  "std::bool", "std::bytes", "std::str", "std::int16", "std::int32", "std::int64",
  "std::float32", "std::float64", "std::bigint", "std::decimal", "std::uuid", "std::json",
  "std::datetime", "std::duration",
  "cal::local_date", "cal::local_time", "cal::local_datetime",
  "cal::relative_duration", "cal::date_duration",
];
const STD_ABSTRACT_SCALARS: readonly string[] = [
  "std::anyscalar", "std::anyenum", "std::anyint", "std::anyfloat", "std::anyreal",
  "std::anynumeric", "std::anydiscrete", "std::anycontiguous", "std::anypoint",
];

const populateStdScalarTypes = (db: IntrospectionDB, insertRow: InsertRow, ensureTypeRow: EnsureTypeRow): void => {
  const present = existingNames(db, "schema__scalartype");
  const write = (name: string, isAbstract: boolean): void => {
    if (present.has(name)) return;
    present.add(name);
    insertRow("schema__scalartype", {
      id: scopedIdFor("schema::ScalarType", name),
      name,
      from_alias: 0,
      abstract: isAbstract ? 1 : 0,
      is_abstract: isAbstract ? 1 : 0,
      default: null,
    });
    // Mirror into schema::Type so `count(ScalarType) < count(Type)` and
    // ancestor/target lookups resolve the same row.
    ensureTypeRow(name, false, isAbstract);
  };
  for (const name of STD_CONCRETE_SCALARS) write(name, false);
  for (const name of STD_ABSTRACT_SCALARS) write(name, true);
};

const VOLATILITY_LABEL: Record<string, string> = {
  immutable: "Immutable",
  stable: "Stable",
  volatile: "Volatile",
};

// One schema::Function row per stdlib function the engine actually implements
// (the single source of truth is the STDLIB_FUNCTIONS registry). Overloads
// collapse to one row by name — enough for `SELECT Function FILTER .name = …`
// and the `count(Function) > 0` introspection goldens.
const populateStdlibFunctions = (db: IntrospectionDB, insertRow: InsertRow): void => {
  const present = existingNames(db, "schema__function");
  for (const entry of STDLIB_FUNCTIONS) {
    if (present.has(entry.name)) continue;
    present.add(entry.name);
    insertRow("schema__function", {
      id: scopedIdFor("schema::Function", entry.name),
      name: entry.name,
      volatility: VOLATILITY_LABEL[entry.meta?.volatility ?? "immutable"] ?? "Immutable",
      return_typemod: entry.meta?.returnOptional ? "OptionalType" : "SingletonType",
      return_type_id: null,
    });
  }
};

// The abstract constraint *definitions* from edb/lib/std/50-constraints.edgeql.
// These coexist with concrete applications of the same name (abstract := false)
// that populateConstraint writes; `FILTER .abstract` separates them.
const STD_ABSTRACT_CONSTRAINTS: ReadonlyArray<{ name: string; errmessage: string }> = [
  { name: "std::constraint", errmessage: "invalid {__subject__}" },
  { name: "std::expression", errmessage: "invalid {__subject__}" },
  { name: "std::exclusive", errmessage: "{__subject__} violates exclusivity constraint" },
  { name: "std::one_of", errmessage: "{__subject__} must be one of: {vals}." },
  { name: "std::max_value", errmessage: "Maximum allowed value for {__subject__} is {max}." },
  { name: "std::min_value", errmessage: "Minimum allowed value for {__subject__} is {min}." },
  { name: "std::max_ex_value", errmessage: "{__subject__} must be less than {max}." },
  { name: "std::min_ex_value", errmessage: "{__subject__} must be greater than {min}." },
  { name: "std::len_value", errmessage: "invalid {__subject__}" },
  { name: "std::min_len_value", errmessage: "{__subject__} must be at least {min} characters." },
  { name: "std::max_len_value", errmessage: "{__subject__} must be no longer than {max} characters." },
  { name: "std::regexp", errmessage: "invalid {__subject__}" },
];

const populateAbstractConstraints = (insertRow: InsertRow): void => {
  for (const constraint of STD_ABSTRACT_CONSTRAINTS) {
    insertRow("schema__constraint", {
      id: scopedIdFor("schema::Constraint", `abstract:${constraint.name}`),
      name: constraint.name,
      delegated: 0,
      abstract: 1,
      is_abstract: 1,
      expr: null,
      subjectexpr: null,
      errmessage: constraint.errmessage,
    });
  }
};

// The standard-library modules a freshly-initialized Gel branch always carries.
// User modules are merged in from the live schema. Mirrors the modules defined
// across edb/lib/*.edgeql so `SELECT schema::Module` and `'std' IN
// schema::Module.name` behave like real Gel.
const STD_MODULES: readonly string[] = [
  "std", "schema", "sys", "cfg", "math", "cal", "fts", "enc", "net", "pg", "default",
];

const populateModules = (insertRow: InsertRow, schema: SchemaSnapshot): void => {
  const modules = new Set<string>(STD_MODULES);
  for (const typeDef of schema.listTypes()) modules.add(typeDef.module ?? "default");
  for (const scalarType of schema.listScalarTypes()) modules.add(scalarType.module);
  for (const fn of schema.listFunctions()) modules.add(fn.module);
  for (const alias of schema.listAliases()) modules.add(alias.module);
  for (const name of [...modules].sort()) {
    insertRow("schema__module", { id: scopedIdFor("schema::Module", name), name });
  }
};

type InsertRow = (table: string, row: Record<string, SQLParam>) => void;
type InsertLink = (ownerType: string, linkName: string, sourceId: string, targetId: string, properties?: Record<string, SQLParam>) => void;
type LinkAnnotations = (ownerType: string, sourceId: string, annotations: readonly AnnotationDef[] | undefined) => void;
type EnsureTypeRow = (name: string, fromAlias?: boolean, isAbstract?: boolean) => string;

const populateObjectType = (
  db: IntrospectionDB,
  schema: SchemaSnapshot,
  insertRow: InsertRow,
  insertLink: InsertLink,
  linkAnnotations: LinkAnnotations,
  ensureTypeRow: EnsureTypeRow,
  typeDef: TypeDef,
): void => {
  const name = qualifiedTypeName(typeDef);
  const id = scopedIdFor("schema::ObjectType", name);
  insertRow("schema__objecttype", {
    id,
    name,
    from_alias: 0,
    abstract: typeDef.abstract ? 1 : 0,
    is_abstract: typeDef.abstract ? 1 : 0,
    compound_type: 0,
  });
  linkAnnotations("schema::ObjectType", id, typeDef.annotations);

  for (const [index, baseName] of (typeDef.extends ?? []).entries()) {
    insertLink("schema::ObjectType", "bases", id, ensureTypeRow(baseName), { index });
  }
  for (const [index, ancestorName] of objectTypeAncestors(schema, typeDef).entries()) {
    insertLink("schema::ObjectType", "ancestors", id, ensureTypeRow(ancestorName), { index });
  }

  for (const [index, field] of objectTypeProperties(typeDef).entries()) {
    const propertyId = populateProperty(insertRow, insertLink, linkAnnotations, ensureTypeRow, {
      scope: `${name}:property:${index}`,
      name: field.name,
      annotations: field.annotations,
      constraints: field.constraints,
      targetTypeName: fieldTargetTypeName(field),
      abstractOwner: Boolean(typeDef.abstract),
    });
    insertLink("schema::ObjectType", "properties", id, propertyId);

    const pointerId = populatePointer(insertRow, insertLink, linkAnnotations, ensureTypeRow, {
      scope: `${name}:pointer:property:${index}`,
      name: field.name,
      sourceTypeName: name,
      targetTypeName: fieldTargetTypeName(field),
      annotations: field.annotations,
    });
    insertLink("schema::ObjectType", "pointers", id, pointerId);
  }

  for (const [index, link] of (typeDef.links ?? []).entries()) {
    const targetTypeName = normalizeSchemaTypeName(link.targetType, typeDef.module ?? "default");
    const linkId = scopedIdFor("schema::Link", `${name}:link:${index}:${link.name}`);
    insertRow("schema__link", {
      id: linkId,
      name: link.name,
      target_id: ensureTypeRow(targetTypeName),
    });
    linkAnnotations("schema::Link", linkId, link.annotations);
    for (const [propertyIndex, property] of (link.properties ?? []).entries()) {
      const propertyId = populateProperty(insertRow, insertLink, linkAnnotations, ensureTypeRow, {
        scope: `${name}:link:${link.name}:property:${propertyIndex}`,
        name: property.name,
        annotations: property.annotations,
        targetTypeName: scalarTypeName(property.type),
        abstractOwner: Boolean(typeDef.abstract),
      });
      insertLink("schema::Link", "properties", linkId, propertyId);
    }
    insertLink("schema::ObjectType", "links", id, linkId);

    const pointerId = populatePointer(insertRow, insertLink, linkAnnotations, ensureTypeRow, {
      scope: `${name}:pointer:link:${index}`,
      name: link.name,
      sourceTypeName: name,
      targetTypeName,
      annotations: link.annotations,
    });
    insertLink("schema::ObjectType", "pointers", id, pointerId);
  }

  for (const [index, schemaIndex] of (typeDef.indexes ?? []).entries()) {
    const indexId = scopedIdFor("schema::Index", `${name}:index:${index}`);
    insertRow("schema__index", { id: indexId, expr: schemaIndex.expr });
    insertLink("schema::ObjectType", "indexes", id, indexId);
  }

  void db;
};

const objectTypeProperties = (typeDef: TypeDef): FieldDef[] => [
  {
    name: "id",
    type: "uuid",
    required: true,
    constraints: [{ name: "std::exclusive", annotations: [], delegated: false, params: [] }],
  },
  ...typeDef.fields,
];

const populateProperty = (
  insertRow: InsertRow,
  insertLink: InsertLink,
  linkAnnotations: LinkAnnotations,
  ensureTypeRow: EnsureTypeRow,
  property: {
    scope: string;
    name: string;
    annotations?: readonly AnnotationDef[];
    constraints?: readonly ConstraintDef[];
    targetTypeName?: string;
    abstractOwner: boolean;
  },
): string => {
  const propertyId = scopedIdFor("schema::Property", `${property.scope}:${property.name}`);
  const targetId = property.targetTypeName ? ensureTypeRow(property.targetTypeName) : null;
  insertRow("schema__property", {
    id: propertyId,
    name: property.name,
    target_id: targetId,
  });
  linkAnnotations("schema::Property", propertyId, property.annotations);
  for (const [index, constraint] of (property.constraints ?? []).entries()) {
    const constraintId = populateConstraint(insertRow, insertLink, linkAnnotations, {
      scope: `${property.scope}:constraint:${index}`,
      constraint,
      abstractOwner: property.abstractOwner,
    });
    insertLink("schema::Property", "constraints", propertyId, constraintId);
  }
  return propertyId;
};

const populatePointer = (
  insertRow: InsertRow,
  insertLink: InsertLink,
  linkAnnotations: LinkAnnotations,
  ensureTypeRow: EnsureTypeRow,
  pointer: {
    scope: string;
    name: string;
    sourceTypeName: string;
    targetTypeName?: string;
    annotations?: readonly AnnotationDef[];
  },
): string => {
  const pointerId = scopedIdFor("schema::Pointer", `${pointer.scope}:${pointer.name}`);
  insertRow("schema__pointer", {
    id: pointerId,
    name: pointer.name,
    source_id: ensureTypeRow(pointer.sourceTypeName),
    target_id: pointer.targetTypeName ? ensureTypeRow(pointer.targetTypeName) : null,
  });
  linkAnnotations("schema::Pointer", pointerId, pointer.annotations);
  return pointerId;
};

const populateAliasPointers = (
  insertRow: InsertRow,
  insertLink: InsertLink,
  linkAnnotations: LinkAnnotations,
  ensureTypeRow: EnsureTypeRow,
  alias: AliasDef,
): void => {
  if (!alias.sourceType || !alias.exprText) return;
  const sourceTypeName = `${alias.module}::${alias.name}`;
  for (const override of parseAliasLinkOverrides(alias.exprText, alias.module)) {
    const targetTypeName = `${alias.module}::__${alias.name}__${override.name}`;
    ensureTypeRow(targetTypeName, true);
    populatePointer(insertRow, insertLink, linkAnnotations, ensureTypeRow, {
      scope: `${sourceTypeName}:alias-pointer:${override.name}`,
      name: override.name,
      sourceTypeName,
      targetTypeName,
      annotations: undefined,
    });
  }
};

const populateConstraint = (
  insertRow: InsertRow,
  insertLink: InsertLink,
  linkAnnotations: LinkAnnotations,
  data: { scope: string; constraint: ConstraintDef; abstractOwner: boolean },
): string => {
  const id = scopedIdFor("schema::Constraint", `${data.scope}:${data.constraint.name}`);
  insertRow("schema__constraint", {
    id,
    name: data.constraint.name,
    delegated: data.abstractOwner && data.constraint.delegated ? 1 : 0,
    // A constraint *application* on a property — never abstract; the abstract
    // definitions (std::exclusive, …) are written by populateAbstractConstraints.
    abstract: 0,
    is_abstract: 0,
    expr: null,
    subjectexpr: null,
    errmessage: null,
  });
  linkAnnotations("schema::Constraint", id, data.constraint.annotations);
  for (const [index, param] of (data.constraint.params ?? []).entries()) {
    if (param.name === "__subject__") continue;
    const paramId = scopedIdFor("schema::ConstraintParam", `${data.scope}:${data.constraint.name}:param:${index}:${param.name}`);
    insertRow("schema__constraintparam", { id: paramId, name: param.name });
    insertLink("schema::Constraint", "params", id, paramId, { value: String(param.value) });
  }
  return id;
};

const populateScalarType = (
  db: IntrospectionDB,
  schema: SchemaSnapshot,
  insertRow: InsertRow,
  insertLink: InsertLink,
  ensureTypeRow: EnsureTypeRow,
  linkAnnotations: LinkAnnotations,
  scalarType: ScalarTypeDeclaration,
): void => {
  const name = `${scalarType.module}::${scalarType.name}`;
  const id = scopedIdFor("schema::ScalarType", name);
  insertRow("schema__scalartype", {
    id,
    name,
    from_alias: 0,
    abstract: 0,
    is_abstract: 0,
    default: null,
  });
  for (const [index, ancestor] of scalarAncestorsForDeclaration(schema, name, scalarType.baseTypeName, scalarType.enumValues).entries()) {
    insertLink("schema::ScalarType", "ancestors", id, ensureTypeRow(ancestor), { index });
  }
  for (const [index, constraint] of (scalarType.constraints ?? []).entries()) {
    const constraintId = populateConstraint(insertRow, insertLink, linkAnnotations, {
      scope: `${name}:constraint:${index}`,
      constraint,
      abstractOwner: false,
    });
    insertLink("schema::ScalarType", "constraints", id, constraintId);
  }
  void db;
};

const populateFunction = (
  insertRow: InsertRow,
  insertLink: InsertLink,
  ensureTypeRow: EnsureTypeRow,
  linkAnnotations: LinkAnnotations,
  fn: FunctionDef,
): void => {
  const name = `${fn.module}::${fn.name}`;
  const signature = `${name}(${fn.params.map((param) => `${param.variadic ? "variadic " : ""}${param.type}`).join(",")})`;
  const id = scopedIdFor("schema::Function", signature);
  const returnTypeName = displayTypeName(fn.returnType);
  insertRow("schema__function", {
    id,
    name,
    volatility: fn.volatility ?? null,
    return_typemod: fn.returnOptional ? "OptionalType" : fn.returnSetOf ? "SetOfType" : "SingletonType",
    return_type_id: ensureTypeRow(returnTypeName),
  });
  linkAnnotations("schema::Function", id, fn.annotations);

  for (const [index, param] of fn.params.entries()) {
    const paramTypeName = param.variadic ? `array<${displayTypeName(param.type)}>` : displayTypeName(param.type);
    const paramId = scopedIdFor("schema::FunctionParam", `${signature}:param:${index}`);
    insertRow("schema__functionparam", {
      id: paramId,
      num: index,
      name: param.name,
      kind: param.variadic ? "VariadicParam" : param.namedOnly ? "NamedOnlyParam" : "PositionalParam",
      typemod: param.optional ? "OptionalType" : param.setOf ? "SetOfType" : "SingletonType",
      type_id: ensureTypeRow(paramTypeName),
    });
    insertLink("schema::Function", "params", id, paramId);
  }
};

const populateTupleAliases = (
  insertRow: InsertRow,
  insertLink: InsertLink,
  ensureTypeRow: EnsureTypeRow,
  runtimeExprAliases: RuntimeExprAliasMap | undefined,
): void => {
  if (!runtimeExprAliases) return;
  for (const [rawName, expr] of runtimeExprAliases.entries()) {
    const name = rawName.includes("::") ? rawName : `default::${rawName}`;
    const tupleMatch = expr.trim().match(/^\((.*)\)$/s);
    if (!tupleMatch) continue;
    const id = scopedIdFor("schema::Tuple", name);
    insertRow("schema__tuple", {
      id,
      name,
      from_alias: 1,
      abstract: 0,
      is_abstract: 0,
    });
    const elementExprs = tupleMatch[1]
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    for (const [index, elementExpr] of elementExprs.entries()) {
      const typeName = scalarTypeNameForRuntimeValue(elementExpr);
      const elementId = scopedIdFor("schema::TupleElement", `${name}:element:${index}`);
      insertRow("schema__tupleelement", {
        id: elementId,
        type_id: ensureTypeRow(typeName),
      });
      insertLink("schema::Tuple", "element_types", id, elementId, { index });
    }
  }
};

const parseAliasLinkOverrides = (exprText: string, moduleName: string): Array<{ name: string; targetType: string }> => {
  const compact = exprText.replace(/^[ \t]*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const overrides: Array<{ name: string; targetType: string }> = [];
  const linkPattern = /\b([A-Za-z_][\w]*)\s*:=\s*\(?\s*(?:SELECT\s+)?[A-Za-z_][\w:]*\s*\.\s*<\s*([A-Za-z_][\w]*)\s*\[\s*IS\s+([A-Za-z_][\w:]*)\s*\]\s*\{([^}]*)\}/gi;
  for (const match of compact.matchAll(linkPattern)) {
    overrides.push({
      name: match[1],
      targetType: normalizeSchemaTypeName(match[3], moduleName),
    });
  }
  return overrides;
};

const objectTypeAncestors = (schema: SchemaSnapshot, typeDef: TypeDef): string[] => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
  };

  for (const base of typeDef.extends ?? []) {
    add(base);
  }
  const visitParents = (typeName: string): void => {
    const baseType = schema.getType(typeName);
    for (const parent of baseType?.extends ?? []) {
      add(parent);
      visitParents(parent);
    }
  };
  for (const base of typeDef.extends ?? []) {
    visitParents(base);
  }
  add("std::Object");
  add("std::BaseObject");
  return ordered;
};

const scalarAncestorsForDeclaration = (
  schema: SchemaSnapshot,
  scalarName: string,
  baseTypeName: string | undefined,
  enumValues: string[] | undefined,
  seen = new Set<string>(),
): string[] => {
  if (seen.has(scalarName)) return [];
  seen.add(scalarName);
  if (enumValues && enumValues.length > 0) return ["std::anyenum", "std::anyscalar"];
  const base = (baseTypeName ?? "str").trim();
  const lower = (base.includes("::") ? base.slice(base.lastIndexOf("::") + 2) : base).toLowerCase();
  if (lower === "anyenum") return ["std::anyenum", "std::anyscalar"];
  if (lower === "str" || lower === "bytes") return ["std::str", "std::anyscalar"];
  if (lower === "int" || lower === "int64") return ["std::int64", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  if (lower === "int32") return ["std::int32", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  if (lower === "int16") return ["std::int16", "std::anyint", "std::anyreal", "std::anydiscrete", "std::anypoint", "std::anyscalar"];
  if (lower === "bool") return ["std::bool", "std::anyscalar"];
  const qualifiedBase = base.includes("::") ? base : `${scalarName.split("::")[0]}::${base}`;
  const baseDecl = schema.getScalarType(qualifiedBase);
  return baseDecl
    ? [qualifiedBase, ...scalarAncestorsForDeclaration(schema, qualifiedBase, baseDecl.baseTypeName, baseDecl.enumValues, seen)]
    : [qualifiedBase, "std::anyscalar"];
};

const fieldTargetTypeName = (field: FieldDef): string => {
  if (field.targetTypeName) return field.targetTypeName;
  if (field.enumTypeName) return field.enumTypeName;
  if (field.collection?.kind === "array") return `array<${scalarTypeName(field.type)}>`;
  if (field.collection?.kind === "tuple") return "tuple";
  return scalarTypeName(field.type);
};

const scalarTypeName = (type: FieldDef["type"]): string => {
  if (type === "int") return "std::int64";
  if (type === "float") return "std::float64";
  return `std::${type}`;
};

const normalizeSchemaTypeName = (name: string, fallbackModule: string): string => {
  const trimmed = name.trim();
  if (trimmed.includes("::") || trimmed.includes("<")) return displayTypeName(trimmed);
  if (trimmed === "anytype") return "anytype";
  if (trimmed === "anyscalar") return "std::anyscalar";
  if (["str", "bool", "json", "uuid", "bytes"].includes(trimmed)) return `std::${trimmed}`;
  if (["int", "int16", "int32", "int64", "bigint"].includes(trimmed)) return "std::int64";
  if (["float", "float32", "float64", "decimal"].includes(trimmed)) return "std::float64";
  return `${fallbackModule}::${trimmed}`;
};

const displayTypeName = (name: string): string => {
  if (name === "default::anytype" || name === "std::anytype") return "anytype";
  if (name === "default::anypoint" || name === "std::anypoint") return "std::anypoint";
  return name;
};

const scalarTypeNameForRuntimeValue = (value: string): string => {
  const trimmed = value.trim();
  if (/^'[^']*'$/.test(trimmed) || /^"[^"]*"$/.test(trimmed)) return "std::str";
  if (/^-?\d+$/.test(trimmed)) return "std::int64";
  if (/^-?\d+\.\d+$/.test(trimmed)) return "std::float64";
  if (/^(?:true|false)$/i.test(trimmed)) return "std::bool";
  return "std::str";
};

const isScalarTypeDef = (typeDef: TypeDef): boolean =>
  typeDef.fields.length === 1 && typeDef.fields[0]?.name === "__enum__";

const builtinTypeNames = (schema: SchemaSnapshot): string[] => {
  const names = new Set([
    "std::Object",
    "std::BaseObject",
    "std::str",
    "std::bytes",
    "std::bool",
    "std::json",
    "std::uuid",
    "std::int16",
    "std::int32",
    "std::int64",
    "std::float32",
    "std::float64",
    "std::anytype",
    "anytype",
    "std::anyscalar",
    "std::anyenum",
    "std::anyint",
    "std::anyreal",
    "std::anydiscrete",
    "std::anypoint",
  ]);
  for (const typeDef of schema.listTypes()) {
    for (const field of typeDef.fields) {
      names.add(fieldTargetTypeName(field));
    }
    for (const link of typeDef.links ?? []) {
      names.add(normalizeSchemaTypeName(link.targetType, typeDef.module ?? "default"));
      for (const property of link.properties ?? []) {
        names.add(scalarTypeName(property.type));
      }
    }
  }
  for (const fn of schema.listFunctions()) {
    names.add(displayTypeName(fn.returnType));
    for (const param of fn.params) {
      const typeName = displayTypeName(param.type);
      names.add(typeName);
      if (param.variadic) names.add(`array<${typeName}>`);
    }
  }
  return [...names];
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
