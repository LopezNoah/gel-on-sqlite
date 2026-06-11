import type { AnnotationDef, ConstraintDef, ScalarType, TypeDef } from "../types.js";
import * as errors from "./errors.js"; // Assuming errors.ts is in the same directory

const BUILTIN_SCALARS: ScalarType[] = [
  "str",
  "int",
  "float",
  "bool",
  "json",
  "datetime",
  "duration",
  "local_datetime",
  "local_date",
  "local_time",
  "relative_duration",
  "date_duration",
  "uuid",
];

const BUILTIN_SCALAR_SET = new Set<ScalarType>(BUILTIN_SCALARS);

const SCALAR_ALIASES: Record<string, ScalarType> = {
  bytes: "str",
  int16: "int",
  int32: "int",
  int64: "int",
  bigint: "int",
  float32: "float",
  float64: "float",
  decimal: "float",
  sequence: "int",
  array: "str",
  tuple: "str",
};

const SQL_TYPE_MAP: Partial<Record<ScalarType, string>> = {
  str: "TEXT",
  json: "TEXT",
  datetime: "TEXT",
  uuid: "TEXT",
  int: "INTEGER",
  float: "REAL",
  bool: "INTEGER",
};

export const scalarToSqlType = (scalar: ScalarType): string => SQL_TYPE_MAP[scalar] ?? "TEXT";

export interface ScalarTypeDeclaration {
  name: string;
  module: string;
  enumValues?: string[];
  baseTypeName?: string;
  constraints?: ConstraintDef[];
  annotations?: AnnotationDef[];
}

export interface ScalarResolution {
  scalar: ScalarType;
  enumValues?: string[];
  enumTypeName?: string;
}

interface ScalarRegistrationOptions {
  scalar: ScalarType;
  enumValues?: string[];
  bases?: string[]; // Added to track inheritance
}

interface ScalarAliasInfo {
  scalar: ScalarType;
  enumValues?: string[];
  bases?: string[];
}

export class ScalarRegistry {
  private readonly aliasMap = new Map<string, ScalarAliasInfo>();

  public resolve(name: string, moduleName: string): ScalarResolution | undefined {
    const normalized = ScalarRegistry.normalizeName(name);
    const lower = normalized.toLowerCase();

    // Check for anonymous enum resolution (Matches Python AnonymousEnumTypeShell.resolve)
    if (lower === "anyenum" && !this.aliasMap.has(normalized)) {
      throw new errors.InvalidPropertyDefinitionError(
        'this type cannot be anonymous',
        // Note: The Python code includes a hint about defining the enum first
      );
    }

    const alias = this.lookupAlias(normalized, lower);
    if (alias) {
      return {
        scalar: alias.scalar,
        enumValues: alias.enumValues,
        enumTypeName: alias.enumValues
          ? ScalarRegistry.qualifyEnumName(name, moduleName)
          : undefined,
      };
    }

    const builtinAlias = SCALAR_ALIASES[lower];
    if (builtinAlias) {
      return { scalar: builtinAlias };
    }

    if (ScalarRegistry.isBuiltinScalar(lower)) {
      return { scalar: lower as ScalarType };
    }

    return undefined;
  }

  public register(name: string, options: ScalarRegistrationOptions): void {
    const normalized = ScalarRegistry.normalizeName(name);
    const lower = normalized.toLowerCase();

    // 1. Validation: Enums cannot contain duplicate values (Python: CreateScalarType)
    if (options.enumValues) {
      const uniqueValues = new Set(options.enumValues);
      if (uniqueValues.size !== options.enumValues.length) {
        throw new errors.SchemaDefinitionError(
          `enums cannot contain duplicate values`
        );
      }

      // 2. Validation: Enums must be the only supertype (Python: CreateScalarType)
      if (options.bases && options.bases.length > 1) {
        throw new errors.SchemaError(
          `invalid scalar type definition, enumeration must be the only supertype specified`
        );
      }
    }

    // 3. Validation: Collection base types (Python: CreateScalarType)
    if (options.bases) {
      for (const base of options.bases) {
        const baseLower = base.toLowerCase();
        if (baseLower.startsWith("array<") || baseLower.startsWith("tuple<")) {
          throw new errors.SchemaError(
            `scalar type may not have a collection base type`
          );
        }
      }
    }

    const info: ScalarAliasInfo = {
      scalar: options.scalar,
      enumValues: options.enumValues ? [...options.enumValues] : undefined,
      bases: options.bases,
    };
    
    this.aliasMap.set(normalized, info);
    if (lower !== normalized) {
      this.aliasMap.set(lower, info);
    }
  }

  /**
   * Simulates a Rebase/Alter operation (Python: RebaseScalarType)
   */
  public rebase(name: string, newEnumValues: string[]): void {
    const existing = this.aliasMap.get(name);
    if (!existing) return;

    // Validation: Cannot drop extending enum (Python: RebaseScalarType)
    if (existing.enumValues && !newEnumValues) {
      throw new errors.SchemaError(`cannot DROP EXTENDING enum`);
    }

    // Validation: Check duplicates during rebase
    const uniqueValues = new Set(newEnumValues);
    if (uniqueValues.size !== newEnumValues.length) {
      throw new errors.SchemaError(`enums cannot contain duplicate values`);
    }

    existing.enumValues = [...newEnumValues];
  }

  public isScalarLike(name: string): boolean {
    const normalized = ScalarRegistry.normalizeName(name);
    const lower = normalized.toLowerCase();
    if (this.aliasMap.has(normalized) || this.aliasMap.has(lower)) {
      return true;
    }
    return ScalarRegistry.isBuiltinScalar(lower) || lower in SCALAR_ALIASES;
  }

  public getEnumValues(name: string): string[] | undefined {
    const normalized = ScalarRegistry.normalizeName(name);
    const lower = normalized.toLowerCase();
    const alias = this.lookupAlias(normalized, lower);
    return alias?.enumValues;
  }

  private lookupAlias(normalized: string, lower: string): ScalarAliasInfo | undefined {
    return this.aliasMap.get(normalized) ?? this.aliasMap.get(lower);
  }

  private static normalizeName(name: string): string {
    if (name.includes("::")) {
      return name.slice(name.lastIndexOf("::") + 2);
    }
    return name;
  }

  private static qualifyEnumName(name: string, moduleName: string): string {
    if (name.includes("::")) {
      return name;
    }
    return `${moduleName}::${ScalarRegistry.normalizeName(name)}`;
  }

  private static isBuiltinScalar(name: string): name is ScalarType {
    return BUILTIN_SCALAR_SET.has(name as ScalarType);
  }
}

export const scalarTypeDeclarationToTypeDef = (
  decl: ScalarTypeDeclaration,
): TypeDef => ({
  module: decl.module,
  name: decl.name,
  fields: [
    {
      name: "__enum__",
      type: "str",
      enumValues: [...(decl.enumValues ?? [])],
    },
  ],
});
