import type { SchemaSnapshot } from "../schema/schema.js";
import type { GeneratedSchema } from "./schema.js";
import {
  getOrGenerateSchemaModel,
  getRegisteredGeneratedSchemaModel,
  listRegisteredGeneratedSchemaModels,
} from "./schema.js";

export interface ResolveSchemaModelOptions {
  schema?: SchemaSnapshot;
  schemaModel?: GeneratedSchema;
  schemaModelName?: string;
}

export const resolveSchemaModelForCompile = (options: ResolveSchemaModelOptions): GeneratedSchema | undefined => {
  const schemaTypeNames = options.schema
    ? options.schema.listTypes().map((typeDef) => `${typeDef.module ?? "default"}::${typeDef.name}`).sort((a, b) => a.localeCompare(b))
    : undefined;

  const matchesSchema = (generated: GeneratedSchema): boolean => {
    if (!schemaTypeNames) {
      return true;
    }
    if (generated.typeNames.length !== schemaTypeNames.length) {
      return false;
    }
    return generated.typeNames.every((name, index) => name === schemaTypeNames[index]);
  };

  if (options.schemaModel) {
    return options.schemaModel;
  }

  if (options.schemaModelName) {
    const named = getRegisteredGeneratedSchemaModel(options.schemaModelName);
    if (named && matchesSchema(named)) {
      return named;
    }
  }

  const registered = listRegisteredGeneratedSchemaModels();
  if (registered.length === 1) {
    const only = getRegisteredGeneratedSchemaModel(registered[0]!);
    if (only && matchesSchema(only)) {
      return only;
    }
  }

  if (options.schema) {
    return getOrGenerateSchemaModel(options.schema);
  }

  return undefined;
};
