// Runtime type narrowing — EdgeQL's `[IS T]` intersections, `IS` type tests,
// the discriminator read (`__type__`-style), and polymorphic field access, as
// evaluated by the Runtime evaluator.
//
// These are the four `evalExpr` cases that read a row's `__source_type`
// discriminator and gate on the concrete-type closure — the runtime twin of
// the SQL-side polymorphic source (`compilePolymorphicSource`). They share one
// rule with the schema (`SchemaSnapshot.concreteTypeNamesUnder`, the qualified
// concrete-type names a possibly-polymorphic type covers) so the runtime and
// the SQL path agree on what a `[IS T]` admits.
//
// Lifted out of the 39-case `evalExpr` so `[IS T]` behaviour has its own
// interface and test surface (drivable with a stub schema, no full evaluator).
// The rest of the `evalExpr` decomposition stays deferred — see docs/adr/0014.

import type { ComputedExpr, FreeObjectExpr } from "../edgeql/ast.js";
import type { SchemaSnapshot } from "../schema/schema.js";

// The evaluator's environment is a flat scope map; `__current__` holds the row
// (or scalar) the narrowing is being applied to.
export type NarrowingEnv = Map<string, unknown>;

// The four expression kinds this module evaluates (drawn from both evalExpr
// operand unions).
export type TypeNarrowingExpr = Extract<
  FreeObjectExpr | ComputedExpr,
  { kind: "type_intersection" | "is_type" | "type_name" | "polymorphic_field_ref" }
>;

export interface TypeNarrowingDeps {
  // Recurse into the general expression evaluator — `is_type` evaluates its operand.
  evalExpr: (expr: FreeObjectExpr | ComputedExpr, env: NarrowingEnv) => unknown;
  // The authoritative schema; supplies `getType` and the concrete-type closure.
  schema: SchemaSnapshot;
  // Qualify a possibly-bare runtime type name to `module::name`.
  qualifyRuntimeTypeName: (name: string, module?: string) => string;
}

// Evaluate one runtime-type-narrowing expression. Returns the narrowed value
// (an object/array of objects whose `__source_type` is covered by the target),
// a boolean (a scalar `IS` test), or `null` when the row is absent / does not
// match.
export const evalTypeNarrowing = (
  expr: TypeNarrowingExpr,
  env: NarrowingEnv,
  deps: TypeNarrowingDeps,
): unknown => {
  const { evalExpr, schema, qualifyRuntimeTypeName } = deps;

  switch (expr.kind) {
    case "type_intersection":
      // `value[IS T]` is the same check as `value IS T` over the operand.
      return evalTypeNarrowing(
        { kind: "is_type", expr: expr.expr, typeName: expr.sourceType, typeExpr: expr.sourceTypeExpr },
        env,
        deps,
      );

    case "is_type": {
      const value = evalExpr(expr.expr, env);
      const typeDef = schema.getType(qualifyRuntimeTypeName(expr.typeName));
      const enumValues = typeDef?.fields.flatMap((field) => field.enumValues ?? []) ?? [];
      const checkOne = (item: unknown) => enumValues.length > 0 && typeof item === "string" && enumValues.includes(item);
      if (enumValues.length === 0) {
        const qualified = qualifyRuntimeTypeName(expr.typeName);
        const items = Array.isArray(value) ? value : [value];
        // Scalar IS type check: applies when item is a primitive value.
        const scalarTypeCheck = (item: unknown): boolean | undefined => {
          if (item === null || item === undefined) return undefined;
          if (typeof item === "object") return undefined;
          const last = expr.typeName.split("::").at(-1) ?? expr.typeName;
          const isInt = typeof item === "number" && Number.isInteger(item);
          const isFloat = typeof item === "number" && !Number.isInteger(item);
          const isStr = typeof item === "string";
          const isBool = typeof item === "boolean";
          switch (last) {
            case "anyscalar": return true;
            case "anytype": return true;
            case "anyreal": return typeof item === "number";
            case "anyint": return isInt;
            case "anyfloat": return isFloat;
            case "int64":
              return isInt;
            case "int16":
            case "int32":
              // Without static type info, can't distinguish int16/32 from int64.
              // EdgeQL `IS int16/int32` checks the static type, which defaults
              // to int64 for literals and field values.
              return false;
            case "float64":
              return isFloat;
            case "float32":
              return false;
            case "decimal":
            case "bigint":
              return false;
            case "str":
              return isStr;
            case "bool":
              return isBool;
            case "Object":
            case "BaseObject":
              return false;
            default:
              return undefined;
          }
        };
        // If all items are primitives, this is a scalar IS check — return boolean(s).
        if (items.length > 0 && items.every((item) => item !== null && item !== undefined && typeof item !== "object")) {
          const results = items.map((item) => scalarTypeCheck(item) ?? false);
          return Array.isArray(value) ? results : results[0];
        }
        return items.filter((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return false;
          const sourceType = (item as Record<string, unknown>).__source_type;
          return typeof sourceType === "string"
            && (sourceType === qualified || schema.concreteTypeNamesUnder(qualified).includes(sourceType));
        });
      }
      return Array.isArray(value) ? value.map(checkOne) : checkOne(value);
    }

    case "type_name": {
      const current = env.get("__current__");
      if (current && typeof current === "object" && !Array.isArray(current)) {
        const sourceType = (current as Record<string, unknown>).__source_type;
        if (typeof sourceType === "string") {
          return sourceType;
        }
      }
      return null;
    }

    case "polymorphic_field_ref": {
      const current = env.get("__current__");
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return null;
      }
      const row = current as Record<string, unknown>;
      const rowSourceType = typeof row.__source_type === "string" ? row.__source_type : undefined;
      if (!rowSourceType) {
        return null;
      }
      const sourceTypeQualified = qualifyRuntimeTypeName(expr.sourceType);
      const concretes = schema.concreteTypeNamesUnder(sourceTypeQualified);
      const matches = rowSourceType === sourceTypeQualified || concretes.includes(rowSourceType);
      if (!matches) {
        return null;
      }
      return row[expr.field] ?? null;
    }
  }
};
