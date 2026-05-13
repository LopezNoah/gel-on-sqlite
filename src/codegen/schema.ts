import type { SchemaSnapshot } from "../schema/schema.js";
import { qualifiedTypeName } from "../schema/schema.js";
import type { FieldDef, LinkDef, TypeDef } from "../types.js";
import { tableNameForType } from "./sql.js";

export interface GeneratedSchemaType {
  qualifiedName: string;
  module: string;
  name: string;
  abstract: boolean;
  extends: string[];
  tableName: string;
  fields: FieldDef[];
  links: LinkDef[];
  resolvedFields: FieldDef[];
  resolvedLinks: LinkDef[];
  concreteSubtypes: string[];
}

export interface GeneratedSchema {
  typeNames: string[];
  typesByName: Record<string, GeneratedSchemaType>;
}

const GENERATED_SCHEMA_REGISTRY = new Map<string, GeneratedSchema>();

const dedupeByName = <T extends { name: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.name)) {
      continue;
    }
    seen.add(item.name);
    out.push(item);
  }
  return out;
};

const cloneField = (field: FieldDef): FieldDef => ({
  ...field,
  annotations: field.annotations?.map((annotation) => ({ ...annotation })),
  constraints: field.constraints?.map((constraint) => ({
    ...constraint,
    annotations: constraint.annotations.map((annotation) => ({ ...annotation })),
    params: constraint.params?.map((param) => ({ ...param })),
  })),
  defaultExpr: field.defaultExpr
    ? field.defaultExpr.kind === "literal"
      ? { kind: "literal", value: field.defaultExpr.value }
      : { kind: "function_call", name: field.defaultExpr.name, args: [...field.defaultExpr.args] }
    : undefined,
  collection: field.collection
    ? field.collection.kind === "tuple"
      ? { kind: "tuple", elementNames: field.collection.elementNames ? [...field.collection.elementNames] : undefined }
      : { kind: "array" }
    : undefined,
  enumValues: field.enumValues ? [...field.enumValues] : undefined,
});

const cloneLink = (link: LinkDef): LinkDef => ({
  ...link,
  defaultTargetValues: link.defaultTargetValues ? [...link.defaultTargetValues] : undefined,
  properties: link.properties?.map((property) => ({
    ...property,
    annotations: property.annotations?.map((annotation) => ({ ...annotation })),
    collection: property.collection
      ? property.collection.kind === "tuple"
        ? { kind: "tuple", elementNames: property.collection.elementNames ? [...property.collection.elementNames] : undefined }
        : { kind: "array" }
      : undefined,
  })),
  annotations: link.annotations?.map((annotation) => ({ ...annotation })),
});

export const generateSchemaModel = (schema: SchemaSnapshot): GeneratedSchema => {
  const types = schema.listTypes();
  const typeMap = new Map<string, ReturnType<typeof buildType>>();

  const buildRaw = (qualifiedName: string): ReturnType<typeof buildType> | undefined => {
    const existing = typeMap.get(qualifiedName);
    if (existing) {
      return existing;
    }
    const typeDef = schema.getType(qualifiedName);
    if (!typeDef) {
      return undefined;
    }
    const built = buildType(typeDef);
    typeMap.set(qualifiedName, built);
    return built;
  };

  const resolveFields = (qualifiedName: string, seen = new Set<string>()): FieldDef[] => {
    if (seen.has(qualifiedName)) {
      return [];
    }
    seen.add(qualifiedName);
    const typeDef = buildRaw(qualifiedName);
    if (!typeDef) {
      return [];
    }
    const inherited = typeDef.extends.flatMap((baseName) => resolveFields(baseName, seen));
    return dedupeByName([...typeDef.fields.map(cloneField), ...inherited]);
  };

  const resolveLinks = (qualifiedName: string, seen = new Set<string>()): LinkDef[] => {
    if (seen.has(qualifiedName)) {
      return [];
    }
    seen.add(qualifiedName);
    const typeDef = buildRaw(qualifiedName);
    if (!typeDef) {
      return [];
    }
    const inherited = typeDef.extends.flatMap((baseName) => resolveLinks(baseName, seen));
    return dedupeByName([...typeDef.links.map(cloneLink), ...inherited]);
  };

  const isSubtypeOf = (candidateName: string, targetName: string, seen = new Set<string>()): boolean => {
    if (seen.has(candidateName)) {
      return false;
    }
    seen.add(candidateName);

    const candidate = buildRaw(candidateName);
    if (!candidate) {
      return false;
    }

    for (const baseName of candidate.extends) {
      if (baseName === targetName || isSubtypeOf(baseName, targetName, seen)) {
        return true;
      }
    }
    return false;
  };

  const typeNames = types
    .map((typeDef) => qualifiedTypeName(typeDef))
    .sort((a, b) => a.localeCompare(b));

  const typesByName: Record<string, GeneratedSchemaType> = {};
  for (const typeName of typeNames) {
    const raw = buildRaw(typeName);
    if (!raw) {
      continue;
    }
    const concreteSubtypes = typeNames.filter((candidateName) => {
      const candidate = buildRaw(candidateName);
      if (!candidate || candidate.abstract) {
        return false;
      }
      return candidateName === typeName || isSubtypeOf(candidateName, typeName);
    });

    typesByName[typeName] = {
      ...raw,
      resolvedFields: resolveFields(typeName),
      resolvedLinks: resolveLinks(typeName),
      concreteSubtypes,
    };
  }

  return {
    typeNames,
    typesByName,
  };
};

const schemaModelCache = new WeakMap<SchemaSnapshot, GeneratedSchema>();

export const getOrGenerateSchemaModel = (schema: SchemaSnapshot): GeneratedSchema => {
  const existing = schemaModelCache.get(schema);
  if (existing) {
    return existing;
  }
  const generated = generateSchemaModel(schema);
  schemaModelCache.set(schema, generated);
  return generated;
};

export const registerGeneratedSchemaModel = (name: string, generated: GeneratedSchema): void => {
  GENERATED_SCHEMA_REGISTRY.set(name, generated);
};

export const getRegisteredGeneratedSchemaModel = (name: string): GeneratedSchema | undefined => {
  return GENERATED_SCHEMA_REGISTRY.get(name);
};

export const listRegisteredGeneratedSchemaModels = (): string[] => {
  return [...GENERATED_SCHEMA_REGISTRY.keys()];
};

export const renderSchemaModelModule = (
  generated: GeneratedSchema,
  exportName = "generatedSchema",
  options: {
    registerAs?: string;
  } = {},
): string => {
  const payload = JSON.stringify(generated, null, 2);
  if (!options.registerAs) {
    return `export const ${exportName} = ${payload} as const;\n`;
  }

  return [
    `import { registerGeneratedSchemaModel, type GeneratedSchema } from "../schema.js";`,
    ``,
    `export const ${exportName} = ${payload} as const;`,
    `registerGeneratedSchemaModel(${JSON.stringify(options.registerAs)}, ${exportName} as unknown as GeneratedSchema);`,
    ``,
  ].join("\n");
};

const buildType = (typeDef: TypeDef): GeneratedSchemaType => {
  const qualifiedName = qualifiedTypeName(typeDef);
  return {
    qualifiedName,
    module: typeDef.module ?? "default",
    name: typeDef.name,
    abstract: Boolean(typeDef.abstract),
    extends: [...(typeDef.extends ?? [])],
    tableName: tableNameForType(qualifiedName),
    fields: typeDef.fields.map(cloneField),
    links: (typeDef.links ?? []).map(cloneLink),
    resolvedFields: [],
    resolvedLinks: [],
    concreteSubtypes: [],
  };
};
