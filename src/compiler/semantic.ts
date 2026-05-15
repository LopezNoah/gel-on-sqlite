import { AppError } from "../errors.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import type { ComputedExpr, FilterExpr, FreeObjectExpr, InsertValue, SelectStatement, ShapeElement, Statement, WithBindingValue } from "../edgeql/ast.js";
import type {
  BacklinkSourceIR,
  FilterExprIR,
  InferenceResult,
  IRStatement,
  LinkRelationIR,
  OrderByIR,
  OverlayIR,
  PathIdIR,
  ScopeTreeIR,
  SelectShapeElementIR,
  TriggerIR,
  PolicyIR,
} from "../ir/model.js";
import { qualifiedTypeName, SchemaSnapshot } from "../schema/schema.js";
import type { ScalarType, ScalarValue, TypeDef } from "../types.js";
import { tryResolveStdlibFunction } from "../stdlib/functions.js";

const tableNameForType = (qualifiedName: string): string => qualifiedName.replaceAll("::", "__").toLowerCase();

export interface CompileContext {
  overlays?: OverlayIR[];
  globals?: Record<string, ScalarValue>;
  schemaModel?: import("../codegen/schema.js").GeneratedSchema;
  schemaModelName?: string;
}

export const compileToIR = (schema: SchemaSnapshot, statement: Statement, context: CompileContext = {}): IRStatement => {
  const fail = (message: string): never => {
    throw new AppError("E_SEMANTIC", message, statement.pos.line, statement.pos.column);
  };

  const requireValue = <T>(value: T, message: string): NonNullable<T> => {
    if (value === undefined || value === null) {
      fail(message);
    }

    return value as NonNullable<T>;
  };

  const requireDefined = <T>(value: T, message: string): Exclude<T, undefined> => {
    if (value === undefined) {
      fail(message);
    }

    return value as Exclude<T, undefined>;
  };

  type ExtractedLiteralValue = ScalarValue | ExtractedLiteralValue[];

  const extractLiteralValue = (entry: import("../ir/model.js").SelectExprIREntry): ExtractedLiteralValue => {
    switch (entry.kind) {
      case "literal":
        return entry.value;
      case "set_literal":
        return entry.values;
      case "set_expr":
        return (entry.values as unknown[]).map((value) => extractLiteralValue(value as import("../ir/model.js").SelectExprIREntry));
      case "cast":
        return extractLiteralValue(entry.value);
      case "enum_path":
        return entry.member;
      case "type_field_path":
        return null;
      case "concat":
        return (entry.parts as unknown[]).map((value) => extractLiteralValue(value as import("../ir/model.js").SelectExprIREntry)).join("");
      case "is_type":
        return null;
      case "select_expr_subquery":
        return extractLiteralValue(entry.value);
      case "and":
      case "or":
      case "not":
      case "compare":
      case "exists":
      case "field_access":
      case "shape_projection":
      case "select":
      case "tuple":
      case "index_access":
      case "if_else":
      case "for_expr":
      case "current_item_field":
      case "distinct":
        return null;
      case "function_call":
        return null;
      case "current_item":
        return null;
      case "math":
        return null;
    }
    return null;
  };

  const expectStringLiteral = (value: ExtractedLiteralValue, message: string): string => {
    return typeof value === "string" ? value : fail(message);
  };

  type FieldEqPredicate = Extract<FilterExpr, { kind: "predicate" }> & {
    op: "=";
    target: { kind: "field"; field: string };
  };

  const moduleNames = new Set(schema.listTypes().map((typeDef) => typeDef.module ?? "default"));
  const resolveModuleName = (name: string): string => {
    if (moduleNames.has(name)) {
      return name;
    }

    const stdFallback = `std::${name}`;
    if (moduleNames.has(stdFallback)) {
      return stdFallback;
    }

    return name;
  };

  const activeModule = statement.withModule ? resolveModuleName(statement.withModule) : "default";
  const moduleAliases = new Map(
    (statement.withModuleAliases ?? []).map((entry) => [entry.alias, resolveModuleName(entry.module)] as const),
  );

  const normalizeTypeName = (name: string, fallbackModule: string = activeModule): string => {
    if (!name.includes("::")) {
      return `${fallbackModule}::${name}`;
    }

    const [head, ...rest] = name.split("::");
    const aliasedModule = moduleAliases.get(head);
    if (!aliasedModule) {
      return name;
    }

    return rest.length === 0 ? aliasedModule : `${aliasedModule}::${rest.join("::")}`;
  };

  const resolveObjectTypeOrAliasSource = (name: string, fallbackModule: string = activeModule): TypeDef | undefined => {
    const normalizedName = normalizeTypeName(name, fallbackModule);
    const alias = schema.getAlias(normalizedName);
    if (alias?.sourceType) {
      return schema.getType(normalizeTypeName(alias.sourceType, alias.module ?? fallbackModule));
    }
    return schema.getType(normalizedName);
  };

  const normalizeFunctionName = (name: string, fallbackModule: string = activeModule): string => {
    if (!name.includes("::")) {
      return `${fallbackModule}::${name}`;
    }

    const [head, ...rest] = name.split("::");
    const aliasedModule = moduleAliases.get(head);
    if (!aliasedModule) {
      return name;
    }

    return rest.length === 0 ? aliasedModule : `${aliasedModule}::${rest.join("::")}`;
  };

  const resolveFunctionOrFail = (name: string, arity: number): { qualifiedName: string; volatility?: "Immutable" | "Stable" | "Volatile" | "Modifying" } => {
    const stdlib = tryResolveStdlibFunction(name, arity, activeModule);
    if (stdlib) {
      return {
        qualifiedName: stdlib.name,
      };
    }

    const qualified = normalizeFunctionName(name, activeModule);
    const divider = qualified.lastIndexOf("::");
    const moduleName = divider >= 0 ? qualified.slice(0, divider) : activeModule;
    const fnName = divider >= 0 ? qualified.slice(divider + 2) : qualified;
    const fn = requireValue(schema.findFunction(moduleName, fnName, arity), `Unknown function '${qualified}'`);

    return {
      qualifiedName: `${moduleName}::${fnName}`,
      volatility: fn.volatility,
    };
  };

  type CompiledShapeFunctionArg =
    | { kind: "literal"; value: ScalarValue }
    | { kind: "field_ref"; column: string }
    | { kind: "set_literal"; values: ScalarValue[] }
    | { kind: "array_literal"; values: ScalarValue[] }
    | { kind: "function_call"; functionName: string; args: CompiledShapeFunctionArg[] };

  type CompiledFreeObjectFunctionArg =
    | { kind: "literal"; value: ScalarValue }
    | { kind: "set_literal"; values: ScalarValue[] }
    | { kind: "array_literal"; values: ScalarValue[] }
    | { kind: "function_call"; functionName: string; args: CompiledFreeObjectFunctionArg[] };

  const compileFunctionArgInShape = (
    arg: NonNullable<Extract<ComputedExpr, { kind: "function_call" }>["call"]>["args"][number],
    ensureFieldRef: (field: string) => void,
    selectedColumns: Set<string>,
  ): CompiledShapeFunctionArg => {
    if (arg.kind === "field_ref") {
      ensureFieldRef(arg.field);
      selectedColumns.add(arg.field);
      return { kind: "field_ref", column: arg.field };
    }

    if (arg.kind === "binding_ref") {
      return { kind: "literal", value: resolveWithBindingScalar(arg.name) };
    }

    if (arg.kind === "set_literal" || arg.kind === "array_literal") {
      return { kind: arg.kind, values: [...arg.values] };
    }

    if (arg.kind === "function_call") {
      const nested = resolveFunctionOrFail(arg.call.name, arg.call.args.length);
      return {
        kind: "function_call",
        functionName: nested.qualifiedName,
        args: arg.call.args.map((nestedArg) => compileFunctionArgInShape(nestedArg, ensureFieldRef, selectedColumns)),
      };
    }

    if (arg.kind === "literal") {
      return { kind: "literal", value: arg.value };
    }

    if (arg.kind === "expr") {
      if (arg.expr.kind === "field_access" && arg.expr.expr.kind === "select") {
        ensureFieldRef(arg.expr.field);
        selectedColumns.add(arg.expr.field);
        return { kind: "field_ref", column: arg.expr.field };
      }
      if (arg.expr.kind === "path") {
        ensureFieldRef(arg.expr.tail);
        selectedColumns.add(arg.expr.tail);
        return { kind: "field_ref", column: arg.expr.tail };
      }
      fail("Shape function arguments do not support nested expressions");
    }

    fail("Unsupported function argument in shape");
    throw new Error("Unreachable");
  };

  const compileFunctionArgInFreeObject = (
    arg: NonNullable<Extract<FreeObjectExpr, { kind: "function_call" }>["call"]>["args"][number],
  ): CompiledFreeObjectFunctionArg => {
    if (arg.kind === "binding_ref") {
      return { kind: "literal", value: resolveWithBindingScalar(arg.name) };
    }

    if (arg.kind === "field_ref") {
      fail("Free object function arguments do not support field references");
    }

    if (arg.kind === "set_literal" || arg.kind === "array_literal") {
      return { kind: arg.kind, values: [...arg.values] };
    }

    if (arg.kind === "function_call") {
      const nested = resolveFunctionOrFail(arg.call.name, arg.call.args.length);
      return {
        kind: "function_call",
        functionName: nested.qualifiedName,
        args: arg.call.args.map((nestedArg) => compileFunctionArgInFreeObject(nestedArg)),
      };
    }

    if (arg.kind === "literal") {
      return { kind: "literal", value: arg.value };
    }

    if (arg.kind === "expr") {
      fail("Free object function arguments do not support nested expressions in this context");
    }

    fail("Unsupported function argument in free object");
    throw new Error("Unreachable");
  };

  const withBindings = new Map((statement.with ?? []).map((binding) => [binding.name, binding.value] as const));
  const resolvedBindingValues = new Map<string, ScalarValue>();
  const resolvingBindingValues = new Set<string>();

  const validateCastType = (castType: string, bindingName: string): void => {
    if (![
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
    ].includes(castType)) {
      fail(`Unsupported cast type '${castType}' in with binding '${bindingName}'`);
    }
  };

  const resolveWithBindingScalar = (name: string): ScalarValue => {
    if (resolvedBindingValues.has(name)) {
      return resolvedBindingValues.get(name) as ScalarValue;
    }

    if (resolvingBindingValues.has(name)) {
      fail(`Cyclic with binding '${name}'`);
    }

    const binding = requireValue(withBindings.get(name), `Unknown with binding '${name}'`);

    resolvingBindingValues.add(name);
    const resolved: ScalarValue = (() => {
      switch (binding.kind) {
        case "literal":
          return binding.value;
        case "set_literal":
          return fail(`With binding '${name}' is a set and cannot be used as a scalar value`);
        case "array_literal":
          return fail(`With binding '${name}' is an array and cannot be used as a scalar value`);
        case "binding_ref": {
          const resolvedType = schema.getType(normalizeTypeName(binding.name, activeModule));
          if (resolvedType) {
            const isEnumScalarType = resolvedType.fields.some((f) => f.name === "__enum__");
            if (isEnumScalarType) {
              fail(`enum path expression lacks an enum member name, as in 'color_enum_t.GREEN'`);
            }
          }
          return resolveWithBindingScalar(binding.name);
        }
        case "parameter": {
          if (binding.castType) {
            validateCastType(binding.castType, name);
          }

          const globals = context.globals ?? {};
          if (!Object.prototype.hasOwnProperty.call(globals, binding.name)) {
            fail(`Unknown query parameter '$${binding.name}'`);
          }
          const raw = requireDefined(globals[binding.name], `Unknown query parameter '$${binding.name}'`);
          return binding.castType
            ? coerceCastScalarValue(binding.castType, raw, `$${binding.name}`)
            : coerceRuntimeScalarValue(raw, `$${binding.name}`);
        }
        case "subquery":
          return fail(`With binding '${name}' is a subquery and cannot be used as a scalar value`);
        case "path_chain":
          return fail(`With binding '${name}' is a path and cannot be used as a scalar value`);
        case "backlink_path":
          return fail(`With binding '${name}' is a backlink path and cannot be used as a scalar value`);
        case "enum_path": {
          const normalizedEnumType = normalizeTypeName(binding.enumType, activeModule);
          const enumTypeDef = schema.getType(normalizedEnumType);
          if (!enumTypeDef) {
            fail(`Unknown enum type '${normalizedEnumType}'`);
          }
          const allEnumValues = enumTypeDef!.fields.flatMap((f) => f.enumValues ?? []);
          if (allEnumValues.length === 0) {
            fail(`Type '${normalizedEnumType}' is not an enum`);
          }
          if (!allEnumValues.includes(binding.member)) {
            fail(`enum '${normalizedEnumType}' has no member called '${binding.member}'`);
          }
          return binding.member;
        }
        case "subquery_expr": {
          if (binding.expr.kind === "literal") {
            return binding.expr.value;
          }
          if (binding.expr.kind === "binding_ref") {
            return resolveWithBindingScalar(binding.expr.name);
          }
          return fail(`Unsupported subquery_expr with kind '${binding.expr.kind}' in '${name}'`);
        }
        case "path": {
          const normalizedHead = normalizeTypeName(binding.head, activeModule);
          const headTypeDef = schema.getType(normalizedHead);
          if (headTypeDef) {
            const isEnumScalarType = headTypeDef.fields.length === 1
              && headTypeDef.fields[0]?.name === "__enum__"
              && headTypeDef.fields[0]?.enumValues
              && headTypeDef.fields[0].enumValues.length > 0;
            if (isEnumScalarType) {
              const allEnumValues = headTypeDef.fields[0]!.enumValues!;
              if (!allEnumValues.includes(binding.tail)) {
                fail(`enum '${normalizedHead}' has no member called '${binding.tail}'`);
              }
              return binding.tail;
            }
          }
          fail(`Unknown type or enum '${normalizedHead}'`);
        }
        default:
          return fail(`Unsupported with binding kind in '${name}'`);
      }
    })();

    resolvingBindingValues.delete(name);
    resolvedBindingValues.set(name, resolved);
    return resolved;
  };

  const resolveFilterValue = (
    value: ScalarValue | { kind: "binding_ref"; name: string } | { kind: "set_literal"; values: ScalarValue[] } | { kind: "field_ref"; field: string } | { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string },
  ): ScalarValue | ScalarValue[] | { kind: "field_ref"; field: string } | { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } => {
    if (typeof value === "object" && value !== null && "kind" in value) {
      if (value.kind === "binding_ref") {
        return resolveWithBindingScalar(value.name);
      }
      if (value.kind === "set_literal") {
        return value.values;
      }
      if (value.kind === "field_ref") {
        return value;
      }
      if (value.kind === "backlink_property_ref") {
        return value;
      }
    }

    return value as ScalarValue;
  };

  const resolveInsertScalarValue = (value: InsertValue): ScalarValue => {
    if (typeof value !== "object" || value === null || !("kind" in value)) {
      return value as ScalarValue;
    }

    switch (value.kind) {
      case "binding_ref":
        return resolveWithBindingScalar(value.name);
      case "array_literal":
        return JSON.stringify(value.values);
      case "tuple_literal":
        return JSON.stringify(value.values);
      default:
        return fail(`Expected scalar value in insert assignment, got ${value.kind}`);
    }
  };

  const resolveInsertSetValues = (value: InsertValue): ScalarValue[] => {
    if (typeof value !== "object" || value === null || !("kind" in value)) {
      return [value as ScalarValue];
    }

    if (value.kind === "set") {
      return value.values.flatMap((entry) => resolveInsertSetValues(entry));
    }

    if (value.kind === "binding_ref") {
      return [resolveWithBindingScalar(value.name)];
    }

    if (value.kind === "array_literal") {
      return [JSON.stringify(value.values)];
    }

    if (value.kind === "tuple_literal") {
      return [JSON.stringify(value.values)];
    }

    return fail(`Expected set-compatible value in insert assignment, got ${value.kind}`);
  };

  const compileFilterExpr = (
    fieldByName: Map<string, { name: string; type: ScalarType; required?: boolean }>,
    knownFields: Set<string>,
    typeLabel: string,
    filter: FilterExpr,
    options: { allowBacklink: boolean; fallbackModule: string; subjectType?: TypeDef },
  ): FilterExprIR => {
    const buildSubjectLinkRelation = (linkName: string): LinkRelationIR => {
      const subjectType = options.subjectType ?? fail(`Unknown link '${linkName}' on '${typeLabel}'`);
      const ownerQualifiedName = qualifiedTypeName(subjectType);
      const ownerScopeModule = subjectType.module ?? options.fallbackModule;
      const link = requireValue(
        collectLinks(subjectType, true).find((candidate) => candidate.name === linkName),
        `Unknown link '${linkName}' on '${ownerQualifiedName}'`,
      );
      const targetTypeNames = linkTargetNames(link.targetType, ownerScopeModule);
      const targetType = targetTypeNames[0] ?? normalizeTypeName(link.targetType, ownerScopeModule);
      const targetTableEntries = targetTypeNames.flatMap((targetTypeName) => {
        const assignable = schema.listConcreteTypesAssignableTo(targetTypeName);
        return assignable.length > 0
          ? assignable.map((candidate) => {
              const name = qualifiedTypeName(candidate);
              return { name, table: tableNameForType(name) };
            })
          : [{ name: targetTypeName, table: tableNameForType(targetTypeName) }];
      });
      const targetTables = [...new Map(targetTableEntries.map((entry) => [entry.name, entry] as const)).values()];
      const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
      return {
        sourceType: ownerQualifiedName,
        targetType,
        targetTable: tableNameForType(targetType),
        targetTables,
        propertyColumns: (link.properties ?? []).map((property) => property.name),
        computedProperties: (link.computedProperties ?? []).map((property) => ({ ...property })),
        multi: Boolean(link.multi),
        storage: usesLinkTable ? "table" : "inline",
        inlineColumn: usesLinkTable ? undefined : `${link.name}_id`,
        linkTable: usesLinkTable ? `${tableNameForType(ownerQualifiedName)}__${link.name.toLowerCase()}` : undefined,
      };
    };

    const compileFreeExprFilter = (expr: FreeObjectExpr): FilterExprIR => {
      if (
        expr.kind === "for_expr"
        && expr.iterator.kind === "field_access"
        && expr.iterator.expr.kind === "current_item"
        && expr.body.kind === "compare"
        && (expr.body.op === "=" || expr.body.op === "!=")
      ) {
        const left = expr.body.left;
        const right = expr.body.right;
        const readBindingField = (candidate: FreeObjectExpr): string | undefined => {
          if (candidate.kind === "field_access" && candidate.expr.kind === "binding_ref" && candidate.expr.name === expr.variable) {
            return candidate.field;
          }
          if (candidate.kind === "path" && candidate.head === expr.variable) {
            return candidate.tail;
          }
          return undefined;
        };
        const leftField = readBindingField(left);
        const rightField = readBindingField(right);
        const targetColumn = leftField && !leftField.startsWith("@") ? leftField : rightField && !rightField.startsWith("@") ? rightField : undefined;
        const property = leftField?.startsWith("@") ? leftField.slice(1) : rightField?.startsWith("@") ? rightField.slice(1) : undefined;
        if (targetColumn && property) {
          return {
            kind: "link_property_compare_exists",
            relation: buildSubjectLinkRelation(expr.iterator.field),
            targetColumn,
            property,
            op: expr.body.op,
          };
        }
      }
      fail("Unsupported free expression in filter");
      throw new Error("unreachable");
    };

    if (filter.kind === "and" || filter.kind === "or") {
      return {
        kind: filter.kind,
        left: compileFilterExpr(fieldByName, knownFields, typeLabel, filter.left, options),
        right: compileFilterExpr(fieldByName, knownFields, typeLabel, filter.right, options),
      };
    }

    if (filter.kind === "not") {
      return {
        kind: "not",
        expr: compileFilterExpr(fieldByName, knownFields, typeLabel, filter.expr, options),
      };
    }

    if (filter.kind === "free_expr") {
      return compileFreeExprFilter(filter.expr);
    }

    if (filter.kind === "in_predicate") {
      const fieldName = filter.target.kind === "field" ? filter.target.field : null;
      if (!fieldName) {
        fail("IN filter only supports field targets");
        return {} as FilterExprIR;
      }

      if (filter.values.kind === "backlink_property_ref") {
        if (!fieldName || !knownFields.has(fieldName)) {
          fail(`Unknown field '${fieldName ?? ""}' on '${typeLabel}'`);
        }
        return {
          kind: "backlink_property_in",
          sources: resolveBacklinkSources(typeLabel, options.fallbackModule, filter.values.link, filter.values.sourceType),
          column: fieldName,
          property: filter.values.property,
          op: filter.op,
        };
      }

      if (filter.values.kind === "set_literal") {
        if (!knownFields.has(fieldName)) {
          fail(`Unknown field '${fieldName}' on '${typeLabel}'`);
        }

        const field = requireValue(fieldByName.get(fieldName), `Unknown field '${fieldName}' on '${typeLabel}'`);
        for (const v of filter.values.values) {
          if (!isValidScalarValue(field.type, v)) {
            fail(`Type mismatch for '${fieldName}' in IN filter: expected ${field.type}`);
          }
        }
        return {
          kind: "field_in",
          column: fieldName,
          op: filter.op,
          values: filter.values.values,
        };
      }

      const resolveInQuery = (): { typeName: string; filter?: FilterExpr; precompiledFilter?: FilterExprIR } => {
        const valueExpr = filter.values;

        if (valueExpr.kind === "set_literal") {
          fail("Unsupported IN filter value expression");
        }

        if (valueExpr.kind === "select") {
          return {
            typeName: valueExpr.query.typeName,
            filter: valueExpr.query.clauses.filter,
          };
        }

        const nameExpr = valueExpr as Extract<typeof valueExpr, { kind: "name" }>;

        const binding = withBindings.get(nameExpr.name);
        if (binding?.kind === "subquery") {
          return {
            typeName: binding.query.typeName,
            filter: binding.query.clauses.filter,
          };
        }

        const aliasName = normalizeTypeName(nameExpr.name, options.fallbackModule);
        const alias = schema.getAlias(aliasName);
        if (alias?.sourceType) {
          if (alias.filter?.kind === "backlink_membership") {
            return {
              typeName: alias.sourceType,
              precompiledFilter: {
                kind: "backlink_contains",
                op: alias.filter.op,
                value: alias.filter.value,
                column: alias.filter.field,
                sources: resolveBacklinkSources(
                  normalizeTypeName(alias.sourceType, alias.module ?? options.fallbackModule),
                  alias.module ?? options.fallbackModule,
                  alias.filter.link,
                  alias.filter.sourceType,
                ),
              },
            };
          }

          return {
            typeName: alias.sourceType,
            filter: alias.filter
              && alias.filter.kind === "field_predicate"
              ? {
                  kind: "predicate",
                  target: { kind: "field", field: alias.filter.field },
                  op: alias.filter.op,
                  value: alias.filter.value,
                }
              : undefined,
          };
        }

        return {
          typeName: nameExpr.name,
          filter: undefined,
        };
      };

      const inQuery = resolveInQuery();
      const inTypeQualified = normalizeTypeName(inQuery.typeName, options.fallbackModule);
      const inType = schema.getType(inTypeQualified);
      if (!inType) {
        fail(`Unknown type '${inTypeQualified}' in IN filter`);
      }
      const resolvedInType = requireValue(inType, `Unknown type '${inTypeQualified}' in IN filter`);
      const inTypeName = qualifiedTypeName(resolvedInType);
      const sourceTables = schema
        .listConcreteTypesAssignableTo(inTypeName)
        .map((candidate) => {
          const name = qualifiedTypeName(candidate);
          return {
            name,
            table: tableNameForType(name),
          };
        });

      const subFilter = inQuery.precompiledFilter ?? (inQuery.filter
        ? compileFilterExpr(
            new Map(collectFields(resolvedInType, true).map((entry) => [entry.name, entry])),
            new Set(["id", ...collectFields(resolvedInType, true).map((entry) => entry.name)]),
            inTypeName,
            inQuery.filter,
            {
              allowBacklink: false,
              fallbackModule: resolvedInType.module ?? options.fallbackModule,
              subjectType: resolvedInType,
            },
          )
        : undefined);

      return {
        kind: "self_in_select",
        op: filter.op,
        sourceTables: sourceTables.length > 0
          ? sourceTables
          : [{ name: inTypeName, table: tableNameForType(inTypeName) }],
        filter: subFilter,
      };
    }

    const resolvedFilterValue = resolveFilterValue(filter.value);

    if (
      filter.kind === "predicate"
      && filter.target.kind === "field"
      && filter.op === "="
      && resolvedFilterValue === true
    ) {
      const linkPropertyMatch = /^([A-Za-z_][\w]*)\.@([A-Za-z_][\w]*)$/.exec(filter.target.field)
        ?? /^([A-Za-z_][\w]*)@([A-Za-z_][\w]*)$/.exec(filter.target.field);
      if (linkPropertyMatch && options.subjectType) {
        const ownerQualifiedName = qualifiedTypeName(options.subjectType);
        const ownerScopeModule = options.subjectType.module ?? options.fallbackModule;
        const link = requireValue(
          collectLinks(options.subjectType, true).find((candidate) => candidate.name === linkPropertyMatch[1]),
          `Unknown link '${linkPropertyMatch[1]}' on '${ownerQualifiedName}'`,
        );
        const targetTypeNames = linkTargetNames(link.targetType, ownerScopeModule);
        const targetType = targetTypeNames[0] ?? normalizeTypeName(link.targetType, ownerScopeModule);
        const targetTableEntries = targetTypeNames.flatMap((targetTypeName) => {
          const assignable = schema.listConcreteTypesAssignableTo(targetTypeName);
          return assignable.length > 0
            ? assignable.map((candidate) => {
                const name = qualifiedTypeName(candidate);
                return { name, table: tableNameForType(name) };
              })
            : [{ name: targetTypeName, table: tableNameForType(targetTypeName) }];
        });
        const targetTables = [...new Map(targetTableEntries.map((entry) => [entry.name, entry] as const)).values()];
        const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
        return {
          kind: "link_property_exists",
          relation: {
            sourceType: ownerQualifiedName,
            targetType,
            targetTable: tableNameForType(targetType),
            targetTables,
            propertyColumns: (link.properties ?? []).map((property) => property.name),
            computedProperties: (link.computedProperties ?? []).map((property) => ({ ...property })),
            multi: Boolean(link.multi),
            storage: usesLinkTable ? "table" : "inline",
            inlineColumn: usesLinkTable ? undefined : `${link.name}_id`,
            linkTable: usesLinkTable ? `${tableNameForType(ownerQualifiedName)}__${link.name.toLowerCase()}` : undefined,
          },
          property: linkPropertyMatch[2],
        };
      }
    }

    if (typeof resolvedFilterValue === "object" && resolvedFilterValue !== null && "kind" in resolvedFilterValue && resolvedFilterValue.kind === "backlink_property_ref") {
      const filterTarget = filter.target;
      const left = filterTarget.kind === "field"
        ? filterTarget.field
        : fail("Backlink link property comparisons require a field target");
      if (!knownFields.has(left)) {
        fail(`Unknown field '${left}' on '${typeLabel}'`);
      }

      return {
        kind: "backlink_property_compare",
        sources: resolveBacklinkSources(typeLabel, options.fallbackModule, resolvedFilterValue.link, resolvedFilterValue.sourceType),
        column: left,
        property: resolvedFilterValue.property,
        op: filter.op,
      };
    }

    if (typeof resolvedFilterValue === "object" && resolvedFilterValue !== null && "kind" in resolvedFilterValue && resolvedFilterValue.kind === "field_ref") {
      const filterTarget = filter.target;
      const left = filterTarget.kind === "field"
        ? filterTarget.field
        : fail("Backlink filters do not support field-to-field comparisons");
      const right = resolvedFilterValue.field;

      const leftKnown = knownFields.has(left) || left.startsWith("@") || left === "__type__.name";
      const rightKnown = knownFields.has(right) || right.startsWith("@") || right === "__type__.name";
      if (!leftKnown) {
        fail(`Unknown field '${left}' on '${typeLabel}'`);
      }
      if (!rightKnown) {
        fail(`Unknown field '${right}' on '${typeLabel}'`);
      }

      return {
        kind: "field_compare",
        leftColumn: left,
        rightColumn: right,
        op: filter.op,
      };
    }

    const value = resolvedFilterValue as ScalarValue;
    if (filter.target.kind === "backlink_property") {
      return {
        kind: "backlink_property_value_compare",
        sources: resolveBacklinkSources(typeLabel, options.fallbackModule, filter.target.link, filter.target.sourceType),
        property: filter.target.property,
        value,
        op: filter.op,
      };
    }

    if (filter.target.kind === "backlink") {
      if (!options.allowBacklink) {
        fail("Backlink filters are currently supported only at top-level select scope");
      }
      if (filter.op !== "=" && filter.op !== "!=") {
        fail("Backlink filters support only '=' and '!=' operators");
      }
      if (typeof value !== "string") {
        fail("Backlink filters require id string comparison values");
      }

      const op = filter.op as "=" | "!=";
      return {
        kind: "backlink",
        sources: resolveBacklinkSources(
          typeLabel,
          options.fallbackModule,
          filter.target.link,
          filter.target.sourceType,
        ),
        op,
        value,
      };
    }

    const targetField = filter.target.kind === "field" ? filter.target.field : fail("Unsupported filter target");

    if (!knownFields.has(targetField)) {
      if (targetField === "__type__.name") {
        if (filter.op === "like" || filter.op === "ilike") {
          if (typeof value !== "string") {
            fail(`Filter operator '${filter.op}' requires string value`);
          }
        } else if (typeof value !== "string") {
          fail("Type mismatch for '__type__.name': expected str");
        }

        return {
          kind: "field",
          column: "__source_type",
          op: filter.op,
          value,
        };
      }

      fail(`Unknown field '${targetField}' on '${typeLabel}'`);
    }

    const field = requireValue(fieldByName.get(targetField), `Unknown field '${targetField}' on '${typeLabel}'`);

    if (filter.op === "like" || filter.op === "ilike") {
      if (field.type !== "str") {
        fail(`Filter operator '${filter.op}' requires str field, got ${field.type}`);
      }
      if (typeof value !== "string") {
        fail(`Filter operator '${filter.op}' requires string value`);
      }
    } else if (!isValidScalarValue(field.type, value)) {
      fail(`Type mismatch for '${targetField}': expected ${field.type}`);
    }

    return {
      kind: "field",
      column: targetField,
      op: filter.op,
      value,
    };
  };

  const resolveTypeOrFail = (name: string, fallbackModule: string, context: string): TypeDef => {
    const qualifiedName = normalizeTypeName(name, fallbackModule);
    return requireValue(schema.getType(qualifiedName), `Unknown type '${qualifiedName}' in ${context}`);
  };

  const dedupeByName = <T extends { name: string }>(items: T[]): T[] => {
    const out: T[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.name)) {
        continue;
      }
      seen.add(item.name);
      out.push(item);
    }
    return out;
  };

  const collectFields = (typeDef: TypeDef, includeInherited: boolean, seen = new Set<string>()): TypeDef["fields"] => {
    const typeName = qualifiedTypeName(typeDef);
    if (seen.has(typeName)) {
      return [];
    }
    seen.add(typeName);

    const inherited = includeInherited
      ? (typeDef.extends ?? []).flatMap((baseName) => {
          const base = schema.getType(baseName);
          return base ? collectFields(base, true, seen) : [];
        })
      : [];

    return dedupeByName([...typeDef.fields, ...inherited]);
  };

  const collectLinks = (typeDef: TypeDef, includeInherited: boolean, seen = new Set<string>()): NonNullable<TypeDef["links"]> => {
    const typeName = qualifiedTypeName(typeDef);
    if (seen.has(typeName)) {
      return [];
    }
    seen.add(typeName);

    const inherited = includeInherited
      ? (typeDef.extends ?? []).flatMap((baseName) => {
          const base = schema.getType(baseName);
          return base ? collectLinks(base, true, seen) : [];
        })
      : [];

    return dedupeByName([...(typeDef.links ?? []), ...(inherited as NonNullable<TypeDef["links"]>)]);
  };

  const collectComputeds = (
    typeDef: TypeDef,
    includeInherited: boolean,
    seen = new Set<string>(),
  ): NonNullable<TypeDef["computeds"]> => {
    const typeName = qualifiedTypeName(typeDef);
    if (seen.has(typeName)) {
      return [];
    }
    seen.add(typeName);

    const inherited = includeInherited
      ? (typeDef.extends ?? []).flatMap((baseName) => {
          const base = schema.getType(baseName);
          return base ? collectComputeds(base, true, seen) : [];
        })
      : [];

    return dedupeByName([...(typeDef.computeds ?? []), ...(inherited as NonNullable<TypeDef["computeds"]>)]);
  };

  const isAssignableTo = (candidateTypeName: string, targetTypeName: string): boolean => {
    if (candidateTypeName === targetTypeName) {
      return true;
    }

    return schema.listConcreteTypesAssignableTo(targetTypeName).some((candidate) => qualifiedTypeName(candidate) === candidateTypeName);
  };

  const linkTargetNames = (targetType: string, moduleName: string): string[] =>
    targetType
      .split("|")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizeTypeName(entry, moduleName));

  const toPathIdIR = (id: string, steps?: PathIdIR["steps"], isPointerPath?: boolean): PathIdIR => ({
    id,
    steps: steps ?? [],
    isPointerPath: isPointerPath ?? false,
  });

  let nextPathOrdinal = 0;
  const createPathId = (parentPathId?: string | PathIdIR): string => {
    const parent = typeof parentPathId === "string" ? parentPathId : parentPathId?.id;
    const current = `p${nextPathOrdinal}`;
    nextPathOrdinal += 1;
    return parent ? `${parent}.${current}` : current;
  };

  const resolveBacklinkSources = (
    targetTypeQualifiedName: string,
    fallbackModule: string,
    linkName: string,
    sourceTypeName?: string,
  ): BacklinkSourceIR[] => {
    const requestedSourceType = sourceTypeName ? normalizeTypeName(sourceTypeName, fallbackModule) : undefined;
    const sources: BacklinkSourceIR[] = [];

    for (const candidate of schema.listTypes()) {
      const candidateQualifiedName = qualifiedTypeName(candidate);
      if (requestedSourceType && !isAssignableTo(candidateQualifiedName, requestedSourceType)) {
        continue;
      }

      const sourceTables = schema
        .listConcreteTypesAssignableTo(candidateQualifiedName)
        .map((assignable) => {
          const name = qualifiedTypeName(assignable);
          return {
            name,
            table: tableNameForType(name),
          };
        });

      const polymorphicSourceTables = sourceTables.length > 0
        ? sourceTables
        : [{ name: candidateQualifiedName, table: tableNameForType(candidateQualifiedName) }];

      for (const link of collectLinks(candidate, true)) {
        const targets = linkTargetNames(link.targetType, candidate.module ?? "default");
        const matchesTarget = targets.some((target) => isAssignableTo(targetTypeQualifiedName, target));
        if (link.name !== linkName || !matchesTarget) {
          continue;
        }

        const linkAppearsInAncestor = (ancestorNames: string[]): boolean =>
          ancestorNames.some((baseName) => {
            const base = schema.getType(baseName);
            return base ? (base.links ?? []).some((l) => l.name === link.name) : false;
          });
        if (linkAppearsInAncestor(candidate.extends ?? [])) {
          continue;
        }

        const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
        if (usesLinkTable) {
          sources.push({
            sourceType: candidateQualifiedName,
            table: tableNameForType(candidateQualifiedName),
            sourceTables: polymorphicSourceTables,
            storage: "table",
            linkTable: `${tableNameForType(candidateQualifiedName)}__${link.name.toLowerCase()}`,
            propertyColumns: (link.properties ?? []).map((property) => property.name),
          });
          continue;
        }

        sources.push({
          sourceType: candidateQualifiedName,
          table: tableNameForType(candidateQualifiedName),
          sourceTables: polymorphicSourceTables,
          storage: "inline",
          inlineColumn: `${link.name}_id`,
        });
      }
    }

    if (sources.length === 0) {
      const scoped = sourceTypeName ? `[is ${sourceTypeName}]` : "";
      fail(`Unknown backlink '.<${linkName}${scoped}' on '${targetTypeQualifiedName}'`);
    }

    return sources;
  };

  const compileSelectForType = (
    typeDef: TypeDef,
    pathId: string | PathIdIR,
    shape: ShapeElement[],
    clauses: {
      filter?: SelectStatement["filter"];
      orderBy?: SelectStatement["orderBy"];
      limit?: SelectStatement["limit"];
      offset?: SelectStatement["offset"];
    },
    options: {
      allowBacklinkFilter: boolean;
      aliasProjections?: Map<string, string>;
      linkProperties?: Set<string>;
    },
    ): {
      pathId: PathIdIR;
      sourceType: string;
      typeRef: import("../ir/model.js").SchemaTypeRefIR;
      table: string;
      sourceTables: Array<{ name: string; table: string }>;
      columns: string[];
      shape: SelectShapeElementIR[];
      scopeTree: ScopeTreeIR;
      appliedOverlays: OverlayIR[];
      filter?: FilterExprIR;
      orderBy?: OrderByIR<string>;
      limit?: number;
      offset?: number;
      inference: InferenceResult;
      triggers?: TriggerIR[];
      policies?: PolicyIR[];
  } => {
    const pathIdIR = typeof pathId === "string" ? toPathIdIR(pathId) : pathId;
    const qualifiedName = qualifiedTypeName(typeDef);
    const scopeModule = typeDef.module ?? "default";
    const table = tableNameForType(qualifiedName);
    const sourceTables = schema
      .listConcreteTypesAssignableTo(qualifiedName)
      .map((candidate) => {
        const name = qualifiedTypeName(candidate);
        return {
          name,
          table: tableNameForType(name),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const allFields = collectFields(typeDef, true);
    const allComputeds = collectComputeds(typeDef, true);
    const userFields = allFields.filter((field) => field.name !== "id");
    const knownFields = new Set(["id", ...userFields.map((f) => f.name)]);
    const computedByName = new Map(allComputeds.map((computed) => [computed.name, computed] as const));
    const fieldByName = new Map([
      ["id", { name: "id", type: "uuid" as const, required: true }],
      ...userFields.map((field) => [field.name, field] as const),
    ]);

    const ensureField = (fieldName: string): void => {
      if (!knownFields.has(fieldName)) {
        fail(`Unknown field '${fieldName}' on '${qualifiedName}'`);
      }
    };

    const resolveForwardLink = (ownerTypeDef: TypeDef, linkName: string): LinkRelationIR => {
      const ownerQualifiedName = qualifiedTypeName(ownerTypeDef);
      const ownerScopeModule = ownerTypeDef.module ?? scopeModule;
      const link = requireValue(
        collectLinks(ownerTypeDef, true).find((candidate) => candidate.name === linkName),
        `Unknown link '${linkName}' on '${ownerQualifiedName}'`,
      );

      const targetTypeNames = linkTargetNames(link.targetType, ownerScopeModule);
      const targetType = targetTypeNames[0] ?? normalizeTypeName(link.targetType, ownerScopeModule);
      const targetTableEntries = targetTypeNames.flatMap((targetTypeName) => {
        const assignable = schema.listConcreteTypesAssignableTo(targetTypeName);
        if (assignable.length > 0) {
          return assignable.map((candidate) => {
            const name = qualifiedTypeName(candidate);
            return {
              name,
              table: tableNameForType(name),
            };
          });
        }

        return [{ name: targetTypeName, table: tableNameForType(targetTypeName) }];
      });
      const targetTables = [...new Map(targetTableEntries.map((entry) => [entry.name, entry] as const)).values()]
        .sort((a, b) => a.name.localeCompare(b.name));

      const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;

      return {
        sourceType: ownerQualifiedName,
        targetType,
        targetTable: tableNameForType(targetType),
        targetTables: targetTables.length > 0
          ? targetTables
          : [
              {
                name: targetType,
                table: tableNameForType(targetType),
              },
            ],
        propertyColumns: (link.properties ?? []).map((property) => property.name),
        computedProperties: (link.computedProperties ?? []).map((property) => ({ ...property })),
        multi: Boolean(link.multi),
        storage: usesLinkTable ? "table" : "inline",
        inlineColumn: usesLinkTable ? undefined : `${link.name}_id`,
        linkTable: usesLinkTable ? `${tableNameForType(ownerQualifiedName)}__${link.name.toLowerCase()}` : undefined,
      };
    };

    const shapeElements: SelectShapeElementIR[] = [];
    const scopeChildren: ScopeTreeIR[] = [];
    const shapeNames = new Set<string>();
    const selectedColumns = new Set<string>();
    if ((typeDef.accessPolicies ?? []).length > 0) {
      selectedColumns.add("id");
    }
    let hasBacklink = false;

    for (const shapeElement of shape) {
      if (shapeElement.kind === "splat") {
        const splatTypeDef = shapeElement.sourceType
          ? resolveTypeOrFail(shapeElement.sourceType, scopeModule, "splat")
          : typeDef;
        const splatQualifiedName = qualifiedTypeName(splatTypeDef);

        if (!shapeElement.intersection && !isAssignableTo(qualifiedName, splatQualifiedName)) {
          fail(`Type '${splatQualifiedName}' is not a valid splat scope for '${qualifiedName}'`);
        }

        const fieldElements = collectFields(splatTypeDef, true).filter((field) => field.name !== "id");
        for (const field of [{ name: "id", type: "uuid" as const }, ...fieldElements]) {
          if (shapeNames.has(field.name)) {
            continue;
          }

          const elementPathId = createPathId(pathId);
          selectedColumns.add(field.name);

          if (shapeElement.intersection) {
            shapeElements.push({
              kind: "computed",
              name: field.name,
              pathId: toPathIdIR(elementPathId),
              expr: {
                kind: "polymorphic_field_ref",
                sourceType: splatQualifiedName,
                column: field.name,
              },
            });
          } else {
            shapeElements.push({
              kind: "field",
              name: field.name,
              pathId: toPathIdIR(elementPathId),
              column: field.name,
            });
          }

          shapeNames.add(field.name);
          scopeChildren.push({
            pathId: toPathIdIR(elementPathId),
            typeName: qualifiedName,
            children: [],
          });
        }

        if (shapeElement.depth === 2) {
          for (const linkDef of collectLinks(splatTypeDef, true)) {
            if (shapeNames.has(linkDef.name)) {
              continue;
            }

            const linkPathId = createPathId(pathId);
            const relation = resolveForwardLink(splatTypeDef, linkDef.name);
            const targetType = requireValue(
              schema.getType(relation.targetType),
              `Unknown link target type '${relation.targetType}' from '${splatQualifiedName}.${linkDef.name}'`,
            );

            const nested = compileSelectForType(targetType, linkPathId, [{ kind: "splat", depth: 1 }], {}, {
              allowBacklinkFilter: false,
            });
            if (relation.storage === "inline") {
              selectedColumns.add(requireValue(relation.inlineColumn, `Missing inline storage metadata for '${linkDef.name}'`));
            }

            shapeElements.push({
              kind: "link",
              name: linkDef.name,
              pathId: toPathIdIR(linkPathId),
              relation,
              typeFilter: undefined,
              sourceTypeFilter: shapeElement.intersection ? splatQualifiedName : undefined,
              columns: nested.columns,
              shape: nested.shape,
              orderBy: undefined,
              limit: undefined,
              offset: undefined,
              inference: nested.inference,
            });
            shapeNames.add(linkDef.name);
            scopeChildren.push(nested.scopeTree);
          }
        }

        continue;
      }

      if (shapeElement.kind === "field") {
        const resolvedFieldName = options.aliasProjections?.get(shapeElement.name) ?? shapeElement.name;
        const computed = computedByName.get(resolvedFieldName);
        if (!knownFields.has(resolvedFieldName) && computed) {
          if (computed.kind === "property") {
            const elementPathId = createPathId(pathId);
            if (computed.expr.kind === "field_ref") {
              ensureField(computed.expr.field);
              selectedColumns.add(computed.expr.field);
              shapeElements.push({
                kind: "computed",
                name: shapeElement.name,
                pathId: toPathIdIR(elementPathId),
                expr: {
                  kind: "field_ref",
                  column: computed.expr.field,
                },
              });
            } else if (computed.expr.kind === "literal") {
              shapeElements.push({
                kind: "computed",
                name: shapeElement.name,
                pathId: toPathIdIR(elementPathId),
                expr: {
                  kind: "literal",
                  value: computed.expr.value,
                },
              });
            } else if (computed.expr.kind === "function_call") {
              shapeElements.push({
                kind: "computed",
                name: shapeElement.name,
                pathId: toPathIdIR(elementPathId),
                expr: {
                  kind: "function_call",
                  functionName: computed.expr.name,
                  args: computed.expr.args.map((arg) => ({ kind: "literal", value: arg })),
                },
              });
            } else if (computed.expr.kind === "link_aggregate") {
              const relation = resolveForwardLink(typeDef, computed.expr.link);
              const targetType = requireValue(
                schema.getType(relation.targetType),
                `Unknown link target type '${relation.targetType}' from '${qualifiedName}.${computed.expr.link}'`,
              );
              const targetFields = new Set(["id", ...collectFields(targetType, true).map((field) => field.name)]);
              if (!targetFields.has(computed.expr.field)) {
                fail(`Unknown field '${computed.expr.field}' on aggregate target '${relation.targetType}'`);
              }
              shapeElements.push({
                kind: "computed",
                name: shapeElement.name,
                pathId: toPathIdIR(elementPathId),
                expr: {
                  kind: "link_aggregate",
                  functionName: computed.expr.functionName,
                  relation,
                  column: computed.expr.field,
                },
              });
            } else {
              for (const part of computed.expr.parts) {
                if (part.kind === "field_ref") {
                  ensureField(part.field);
                  selectedColumns.add(part.field);
                }
              }
              shapeElements.push({
                kind: "computed",
                name: shapeElement.name,
                pathId: toPathIdIR(elementPathId),
                expr: {
                  kind: "concat",
                  parts: computed.expr.parts.map((part) =>
                    part.kind === "field_ref"
                      ? { kind: "field_ref", column: part.field }
                      : { kind: "literal", value: part.value }),
                },
              });
            }

            shapeNames.add(shapeElement.name);
            scopeChildren.push({ pathId: toPathIdIR(elementPathId), typeName: qualifiedName, children: [] });
            continue;
          }

          if (computed.expr.kind === "backlink") {
            const elementPathId = createPathId(pathId);
            hasBacklink = true;
            const sources = resolveBacklinkSources(qualifiedName, scopeModule, computed.expr.link, computed.expr.sourceType);
            shapeElements.push({
              kind: "backlink",
              name: shapeElement.name,
              pathId: toPathIdIR(elementPathId),
              sources,
            });
            shapeNames.add(shapeElement.name);
            scopeChildren.push({ pathId: toPathIdIR(elementPathId), typeName: qualifiedName, children: [] });
            continue;
          }

          if (computed.expr.kind === "select_type") {
            fail(`Computed link '${qualifiedName}.${computed.name}' selects '${computed.expr.typeName}' and is not supported in query shapes yet`);
          }

          const computedLinkExpr = computed.expr.kind === "link_ref"
            ? computed.expr
            : fail(`Computed link '${qualifiedName}.${computed.name}' has unsupported expression kind '${computed.expr.kind}'`);
          const linkPathId = createPathId(pathId);
          const relation = resolveForwardLink(typeDef, computedLinkExpr.link);
          const targetType = requireValue(
            schema.getType(relation.targetType),
            `Unknown link target type '${relation.targetType}' from '${qualifiedName}.${computedLinkExpr.link}'`,
          );
          const nested = compileSelectForType(
            targetType,
            linkPathId,
            [{ kind: "field", name: "id" }],
            {
              filter: computedLinkExpr.filter
                ? {
                    kind: "predicate",
                    target: { kind: "field", field: computedLinkExpr.filter.field },
                    op: computedLinkExpr.filter.op,
                    value: computedLinkExpr.filter.value,
                  }
                : undefined,
            },
            { allowBacklinkFilter: false },
          );

          if (relation.storage === "inline") {
            selectedColumns.add(requireValue(relation.inlineColumn, `Missing inline storage metadata for '${computedLinkExpr.link}'`));
          } else {
            selectedColumns.add("id");
          }

          shapeElements.push({
            kind: "link",
            name: shapeElement.name,
            pathId: toPathIdIR(linkPathId),
            relation,
            typeFilter: undefined,
            sourceTypeFilter: undefined,
            columns: nested.columns,
            shape: nested.shape,
            filter: nested.filter,
            orderBy: nested.orderBy,
            limit: nested.limit,
            offset: nested.offset,
            inference: nested.inference,
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push(nested.scopeTree);
          continue;
        }

        const elementPathId = createPathId(pathId);
        ensureField(resolvedFieldName);
        selectedColumns.add(resolvedFieldName);
        shapeElements.push({
          kind: "field",
          name: shapeElement.name,
          pathId: toPathIdIR(elementPathId),
          column: resolvedFieldName,
        });
        shapeNames.add(shapeElement.name);
        scopeChildren.push({
          pathId: toPathIdIR(elementPathId),
          typeName: qualifiedName,
          children: [],
        });
        continue;
      }

      if (shapeElement.kind === "computed") {
        const elementPathId = createPathId(pathId);
        if (shapeElement.expr.kind === "field_ref") {
          if (shapeElement.expr.field.startsWith("@")) {
            const propertyName = shapeElement.expr.field.slice(1);
            if (!options.linkProperties?.has(propertyName)) {
              fail(`Unknown field '${shapeElement.expr.field}' on '${qualifiedName}'`);
            }
            shapeElements.push({
              kind: "computed",
              name: shapeElement.name,
              pathId: toPathIdIR(elementPathId),
              expr: {
                kind: "field_ref",
                column: shapeElement.expr.field,
              },
            });
            shapeNames.add(shapeElement.name);
            scopeChildren.push({
              pathId: toPathIdIR(elementPathId),
              typeName: qualifiedName,
              children: [],
            });
            continue;
          }
          ensureField(shapeElement.expr.field);
          selectedColumns.add(shapeElement.expr.field);
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "field_ref",
              column: shapeElement.expr.field,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: toPathIdIR(elementPathId),
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        if (shapeElement.expr.kind === "polymorphic_field_ref") {
          ensureField(shapeElement.expr.field);
          selectedColumns.add(shapeElement.expr.field);
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "polymorphic_field_ref",
              sourceType: normalizeTypeName(shapeElement.expr.sourceType, scopeModule),
              column: shapeElement.expr.field,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: toPathIdIR(elementPathId),
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        if (shapeElement.expr.kind === "type_name") {
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "type_name",
              sourceType: qualifiedName,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: toPathIdIR(elementPathId),
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        if (shapeElement.expr.kind === "subquery") {
          const nestedType = requireValue(
            schema.getType(normalizeTypeName(shapeElement.expr.typeName, scopeModule)),
            `Unknown type '${shapeElement.expr.typeName}' in computed subquery`,
          );
          const nestedPath = createPathId(elementPathId);
          const nested = compileSelectForType(
            nestedType,
            nestedPath,
            shapeElement.expr.shape,
            {
              filter: shapeElement.expr.clauses.filter,
              orderBy: shapeElement.expr.clauses.orderBy,
              limit: shapeElement.expr.clauses.limit,
              offset: shapeElement.expr.clauses.offset,
            },
            { allowBacklinkFilter: true },
          );

          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "subquery",
              query: {
                kind: "select",
                pathId: nested.pathId,
                sourceType: nested.sourceType,
                typeRef: nested.typeRef,
                table: nested.table,
                sourceTables: nested.sourceTables,
                columns: nested.columns,
                shape: nested.shape,
                scopeTree: nested.scopeTree,
                appliedOverlays: nested.appliedOverlays,
                filter: nested.filter,
                orderBy: nested.orderBy,
                limit: nested.limit,
                offset: nested.offset,
                inference: nested.inference,
              },
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push(nested.scopeTree);
          continue;
        }

        if (shapeElement.expr.kind === "function_call") {
          const resolved = resolveFunctionOrFail(shapeElement.expr.call.name, shapeElement.expr.call.args.length);
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "function_call",
              functionName: resolved.qualifiedName,
              args: shapeElement.expr.call.args.map((arg) => compileFunctionArgInShape(arg, ensureField, selectedColumns)) as never,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: toPathIdIR(elementPathId),
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        if (shapeElement.expr.kind === "binding_ref") {
          const boundValue = resolveWithBindingScalar(shapeElement.expr.name);
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "literal",
              value: boundValue,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: toPathIdIR(elementPathId),
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        if (shapeElement.expr.kind === "field_suffix_math") {
          ensureField(shapeElement.expr.field);
          selectedColumns.add(shapeElement.expr.field);
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "field_suffix_math",
              field: shapeElement.expr.field,
              fromEnd: shapeElement.expr.fromEnd,
              op: shapeElement.expr.op,
              constant: shapeElement.expr.constant,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: toPathIdIR(elementPathId),
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        if (shapeElement.expr.kind === "select_expr") {
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "select_expr",
              expr: shapeElement.expr.expr,
              withBindings: shapeElement.expr.clauses._withBindings,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: toPathIdIR(elementPathId),
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        if (shapeElement.expr.kind !== "literal") {
          fail(`Unsupported computed expression kind '${shapeElement.expr.kind}'`);
        }
        const literalExpr = shapeElement.expr as Extract<typeof shapeElement.expr, { kind: "literal" }>;

        shapeElements.push({
          kind: "computed",
          name: shapeElement.name,
          pathId: toPathIdIR(elementPathId),
          expr: {
            kind: "literal",
            value: literalExpr.value,
          },
        });
        shapeNames.add(shapeElement.name);
        scopeChildren.push({
          pathId: toPathIdIR(elementPathId),
          typeName: qualifiedName,
          children: [],
        });
        continue;
      }

      if (shapeElement.kind === "backlink") {
        const elementPathId = createPathId(pathId);
        hasBacklink = true;
        const sources = resolveBacklinkSources(qualifiedName, scopeModule, shapeElement.expr.link, shapeElement.expr.sourceType);
        shapeElements.push({
          kind: "backlink",
          name: shapeElement.name,
          pathId: toPathIdIR(elementPathId),
          sources,
        });
        shapeNames.add(shapeElement.name);
        scopeChildren.push({
          pathId: toPathIdIR(elementPathId),
          typeName: qualifiedName,
          children: [],
        });
        continue;
      }

      const linkPathId = createPathId(pathId);
      const resolvedLinkName = options.aliasProjections?.get(shapeElement.name) ?? shapeElement.name;
      const computedLink = computedByName.get(resolvedLinkName);
      if (computedLink?.kind === "link" && computedLink.expr.kind === "backlink") {
        hasBacklink = true;
        const sources = resolveBacklinkSources(qualifiedName, scopeModule, computedLink.expr.link, computedLink.expr.sourceType);
        const nestedSourceType = normalizeTypeName(computedLink.expr.sourceType ?? qualifiedName, scopeModule);
        const nestedType = requireValue(
          schema.getType(nestedSourceType),
          `Unknown backlink source type '${nestedSourceType}' on '${qualifiedName}.${shapeElement.name}'`,
        );
        const nested = compileSelectForType(nestedType, linkPathId, shapeElement.shape, shapeElement.clauses, {
          allowBacklinkFilter: false,
          linkProperties: new Set(sources.flatMap((source) => source.propertyColumns ?? [])),
        });
        shapeElements.push({
          kind: "backlink",
          name: shapeElement.name,
          pathId: toPathIdIR(linkPathId),
          sources,
          columns: nested.columns,
          shape: nested.shape,
          filter: nested.filter,
          orderBy: nested.orderBy,
          limit: nested.limit,
          offset: nested.offset,
          inference: nested.inference,
        });
        shapeNames.add(shapeElement.name);
        scopeChildren.push(nested.scopeTree);
        continue;
      }

      const typeFilterName = shapeElement.typeFilter ? normalizeTypeName(shapeElement.typeFilter, scopeModule) : undefined;
      const linkOwnerType = typeFilterName && !collectLinks(typeDef, true).some((link) => link.name === resolvedLinkName)
        ? requireValue(schema.getType(typeFilterName), `Unknown type filter '${typeFilterName}'`)
        : typeDef;
      const relation = resolveForwardLink(linkOwnerType, resolvedLinkName);
      const sourceTypeFilter = linkOwnerType === typeDef ? undefined : qualifiedTypeName(linkOwnerType);
      const normalizedTypeFilter = sourceTypeFilter ? undefined : typeFilterName;
      const filteredTargetTables = normalizedTypeFilter
        ? relation.targetTables.filter((candidate) => isAssignableTo(candidate.name, normalizedTypeFilter))
        : relation.targetTables;

        if (normalizedTypeFilter && filteredTargetTables.length === 0) {
        fail(`Type filter '${normalizedTypeFilter}' is not compatible with link '${qualifiedName}.${resolvedLinkName}'`);
      }

      const effectiveTargetType = normalizedTypeFilter ?? relation.targetType;
      const targetType = requireValue(
        schema.getType(effectiveTargetType),
        `Unknown link target type '${effectiveTargetType}' from '${qualifiedName}.${shapeElement.name}'`,
      );
      const nested = compileSelectForType(targetType, linkPathId, shapeElement.shape, shapeElement.clauses, {
        allowBacklinkFilter: false,
        linkProperties: new Set([
          ...(relation.propertyColumns ?? []),
          ...(relation.computedProperties ?? []).map((property) => property.name),
        ]),
      });

      if (relation.storage === "inline") {
        selectedColumns.add(requireValue(relation.inlineColumn, `Missing inline storage metadata for '${resolvedLinkName}'`));
      } else {
        selectedColumns.add("id");
      }

      shapeElements.push({
        kind: "link",
        name: shapeElement.name,
        pathId: toPathIdIR(linkPathId),
        relation: {
          ...relation,
          targetType: effectiveTargetType,
          targetTable: tableNameForType(effectiveTargetType),
          targetTables: filteredTargetTables,
        },
        typeFilter: normalizedTypeFilter,
        sourceTypeFilter,
        columns: nested.columns,
        shape: nested.shape,
        filter: nested.filter,
        orderBy: nested.orderBy,
        limit: nested.limit,
        offset: nested.offset,
        inference: nested.inference,
      });
      shapeNames.add(shapeElement.name);
      scopeChildren.push(nested.scopeTree);
    }

    if (hasBacklink) {
      selectedColumns.add("id");
    }

    if (shapeElements.length === 0) {
      fail("Select shape must include at least one element");
    }

    if (selectedColumns.size === 0) {
      selectedColumns.add("id");
    }

    ensureUniqueShapeNames(shapeElements, fail);

    const resolvedFilter = clauses.filter
        ? compileFilterExpr(fieldByName, knownFields, qualifiedName, clauses.filter, {
          allowBacklink: options.allowBacklinkFilter,
          fallbackModule: scopeModule,
          subjectType: typeDef,
        })
      : undefined;

    const narrowedSourceTables =
      resolvedFilter
      && resolvedFilter.kind === "field"
      && resolvedFilter.column === "__source_type"
      && resolvedFilter.op === "="
      && typeof resolvedFilter.value === "string"
        ? sourceTables.filter((source) => source.name === resolvedFilter.value)
        : sourceTables;

    let resolvedOrderBy = clauses.orderBy
      ? {
          value: clauses.orderBy.field.startsWith("@")
            ? clauses.orderBy.field.slice(1)
            : clauses.orderBy.field,
          direction: clauses.orderBy.direction,
        }
      : undefined;

    if (resolvedOrderBy && !clauses.orderBy!.field.startsWith("@")) {
      if (resolvedOrderBy.value.includes(".")) {
        resolvedOrderBy = undefined;
      }

      if (resolvedOrderBy) {
        const computedTypeNameAlias = shapeElements.find(
          (element) =>
            element.name === resolvedOrderBy!.value
            && element.kind === "computed"
            && element.expr.kind === "type_name",
        );
        if (computedTypeNameAlias) {
          resolvedOrderBy = {
            ...resolvedOrderBy,
            value: "__source_type",
          };
        } else {
          ensureField(resolvedOrderBy.value);
        }
      }
    }

    if (clauses.limit !== undefined && clauses.limit < 0) {
      fail("Limit must be zero or greater");
    }

    if (clauses.offset !== undefined && clauses.offset < 0) {
      fail("Offset must be zero or greater");
    }

    return {
      pathId: pathIdIR,
      sourceType: qualifiedName,
      typeRef: {
        name: qualifiedName,
        table,
        module: typeDef.module ?? "default",
        isAbstract: Boolean(typeDef.abstract),
        isScalar: false,
        children: (() => {
          const concreteTypes = schema.listConcreteTypesAssignableTo(qualifiedName);
          const names = concreteTypes.map((t) => qualifiedTypeName(t));
          return names.length > 0 ? names : undefined;
        })(),
        ancestors: typeDef.extends?.length ? typeDef.extends : undefined,
      },
      table,
      sourceTables: narrowedSourceTables,
      columns: [...selectedColumns],
      shape: shapeElements,
      scopeTree: {
        pathId: pathIdIR,
        typeName: qualifiedName,
        children: scopeChildren,
      },
      appliedOverlays: (context.overlays ?? []).filter((overlay) => overlay.table === table),
      filter: resolvedFilter,
      orderBy: resolvedOrderBy,
      limit: clauses.limit,
      offset: clauses.offset,
      inference: inferSelect(
        isDirectIdEqualityFilter(resolvedFilter),
        clauses.limit,
        selectedColumns,
      ),
      triggers: (typeDef.triggers ?? []).map((t) => ({
        name: t.name,
        events: [{ kind: t.event as "insert" | "update" | "delete" }],
        scope: (t.scope ?? "each") as "each" | "all",
        sourceType: qualifiedName,
      })),
      policies: (typeDef.accessPolicies ?? []).map((p) => ({
        name: p.name,
        effect: p.effect as "allow" | "deny",
        operations: [...p.operations],
        condition: p.condition.kind === "always" ? undefined : JSON.stringify(p.condition),
        errmessage: p.errmessage,
      })),
    };
  };

  const mergeFilters = (
    left: SelectStatement["filter"] | undefined,
    right: SelectStatement["filter"] | undefined,
  ): SelectStatement["filter"] | undefined => {
    if (!left) {
      return right;
    }
    if (!right) {
      return left;
    }

    return {
      kind: "and",
      left,
      right,
    };
  };

  const resolveSelectSource = (selectStatement: SelectStatement): {
    typeDef: TypeDef;
    aliasProjections?: Map<string, string>;
    clauses: {
      filter?: SelectStatement["filter"];
      orderBy?: SelectStatement["orderBy"];
      limit?: SelectStatement["limit"];
      offset?: SelectStatement["offset"];
    };
  } => {
    const resolvedTypeName = normalizeTypeName(selectStatement.typeName, activeModule);
    const schemaAlias = schema.getAlias(resolvedTypeName);
    if (schemaAlias?.sourceType) {
      const sourceType = requireValue(
        schema.getType(normalizeTypeName(schemaAlias.sourceType, schemaAlias.module ?? activeModule)),
        `Unknown type '${normalizeTypeName(schemaAlias.sourceType, schemaAlias.module ?? activeModule)}' in alias '${resolvedTypeName}'`,
      );
      const aliasFilter = schemaAlias.filter?.kind === "field_predicate"
        ? {
            kind: "predicate" as const,
            target: { kind: "field" as const, field: schemaAlias.filter.field },
            op: schemaAlias.filter.op,
            value: schemaAlias.filter.value,
          }
        : undefined;
      return {
        typeDef: sourceType,
        aliasProjections: schemaAlias.projections
          ? new Map(schemaAlias.projections.map((projection) => [projection.name, projection.sourceField] as const))
          : undefined,
        clauses: {
          filter: mergeFilters(aliasFilter, selectStatement.filter),
          orderBy: selectStatement.orderBy,
          limit: selectStatement.limit,
          offset: selectStatement.offset,
        },
      };
    }

    const directType = schema.getType(resolvedTypeName);
    if (directType) {
      const isEnumScalarType = directType.fields.some((f) => f.name === "__enum__");
      if (isEnumScalarType) {
        fail(`enum path expression lacks an enum member name, as in 'color_enum_t.GREEN'`);
      }
      return {
        typeDef: directType,
        aliasProjections: undefined,
        clauses: {
          filter: selectStatement.filter,
          orderBy: selectStatement.orderBy,
          limit: selectStatement.limit,
          offset: selectStatement.offset,
        },
      };
    }

    const withBinding = withBindings.get(selectStatement.typeName);
    if (withBinding) {
      if (withBinding.kind === "subquery") {
        const withQuery = (withBinding as Extract<NonNullable<SelectStatement["with"]>[number]["value"], { kind: "subquery" }>).query;
        const sourceType = requireValue(
          schema.getType(normalizeTypeName(withQuery.typeName, activeModule)),
          `Unknown type '${normalizeTypeName(withQuery.typeName, activeModule)}' in with binding '${selectStatement.typeName}'`,
        );
        return {
          typeDef: sourceType,
          aliasProjections: undefined,
          clauses: {
            filter: mergeFilters(withQuery.clauses.filter, selectStatement.filter),
            orderBy: selectStatement.orderBy ?? withQuery.clauses.orderBy,
            limit: selectStatement.limit ?? withQuery.clauses.limit,
            offset: selectStatement.offset ?? withQuery.clauses.offset,
          },
        };
      }
      if (withBinding.kind === "enum_path" || withBinding.kind === "path") {
        resolveWithBindingScalar(selectStatement.typeName);
        return {
          typeDef: { name: "__scalar_result__", module: "std", fields: [{ name: "__value__", type: "str" as const }] },
          aliasProjections: undefined,
          clauses: { filter: undefined, orderBy: undefined, limit: undefined, offset: undefined },
        };
      }
    }

    return fail(`Unknown type '${resolvedTypeName}'`);
  };

  if (statement.kind === "select_free") {
    const pathId = createPathId();
    const names = new Set<string>();
    const asNestedFreeEntry = (
      entry: import("../ir/model.js").SelectFreeIREntry,
    ): import("../ir/model.js").SelectFreeIREntry<3> => entry as import("../ir/model.js").SelectFreeIREntry<3>;

    const compileFreeObjectExprToSelectFreeEntry = (expr: FreeObjectExpr, name: string): import("../ir/model.js").SelectFreeIREntry => {
      if (expr.kind === "literal") {
        return { kind: "literal", name, value: expr.value };
      }
      if (expr.kind === "set_literal") {
        return { kind: "set_literal", name, values: [...expr.values] };
      }
      if (expr.kind === "function_call") {
        const resolved = resolveFunctionOrFail(expr.call.name, expr.call.args.length);
        return {
          kind: "function_call",
          name,
          functionName: resolved.qualifiedName,
          args: expr.call.args.map((arg) => compileFunctionArgInFreeObject(arg)) as never,
        };
      }
      if (expr.kind === "select") {
        const nestedType = requireValue(
          schema.getType(normalizeTypeName(expr.typeName, activeModule)),
          `Unknown type '${normalizeTypeName(expr.typeName, activeModule)}'`,
        );
        const nestedPath = createPathId(pathId);
        const nested = compileSelectForType(
          nestedType,
          nestedPath,
          expr.shape,
          {
            filter: expr.clauses.filter,
            orderBy: expr.clauses.orderBy,
            limit: expr.clauses.limit,
            offset: expr.clauses.offset,
          },
          { allowBacklinkFilter: true },
        );
        return {
          kind: "select",
          name,
          query: {
            kind: "select",
            pathId: nested.pathId,
            sourceType: nested.sourceType,
            typeRef: nested.typeRef,
            table: nested.table,
            sourceTables: nested.sourceTables,
            columns: nested.columns,
            shape: nested.shape,
            scopeTree: nested.scopeTree,
            appliedOverlays: nested.appliedOverlays,
            filter: nested.filter,
            orderBy: nested.orderBy,
            limit: nested.limit,
            offset: nested.offset,
            inference: nested.inference,
          },
        };
      }
      if (expr.kind === "cast") {
        const innerEntry = compileFreeObjectExprToSelectFreeEntry(expr.expr, name);
        return { kind: "cast", name, castType: expr.castType, value: asNestedFreeEntry(innerEntry) };
      }
      if (expr.kind === "path") {
        const normalizedHead = normalizeTypeName(expr.head, activeModule);
        const headTypeDef = schema.getType(normalizedHead);
        if (headTypeDef) {
          const isEnumScalarType = headTypeDef.fields.length === 1
            && headTypeDef.fields[0]?.name === "__enum__"
            && headTypeDef.fields[0]?.enumValues
            && headTypeDef.fields[0].enumValues.length > 0;
          if (isEnumScalarType) {
            const allEnumValues = headTypeDef.fields[0]!.enumValues!;
            if (!allEnumValues.includes(expr.tail)) {
              fail(`enum '${normalizedHead}' has no member called '${expr.tail}'`);
            }
            return { kind: "enum_path", name, enumType: normalizedHead, member: expr.tail };
          }
        }
        fail(`Unsupported path expression '${expr.head}.${expr.tail}' in free object select`);
      }
      if (expr.kind === "concat") {
        return {
          kind: "concat",
          name,
          parts: expr.parts.map((part) => asNestedFreeEntry(compileFreeObjectExprToSelectFreeEntry(part, ""))),
        };
      }
      fail(`Unsupported free object expression kind '${expr.kind}'`);
      throw new Error("unreachable");
    };

    const entries = statement.entries.map((entry): import("../ir/model.js").SelectFreeIREntry => {
      if (names.has(entry.name)) {
        fail(`Duplicate free object field '${entry.name}'`);
      }
      names.add(entry.name);
      return compileFreeObjectExprToSelectFreeEntry(entry.expr, entry.name);
    });

    return {
      kind: "select_free",
      pathId: toPathIdIR(pathId),
      entries,
    };
  }

  if (statement.kind === "select_expr") {
    const pathId = createPathId();
    const asNestedExprEntry = (
      entry: import("../ir/model.js").SelectExprIREntry,
    ): import("../ir/model.js").SelectExprIREntry<3> => entry as import("../ir/model.js").SelectExprIREntry<3>;

    const withBindings = new Map<string, WithBindingValue>();
    for (const binding of statement.with ?? []) {
      withBindings.set(binding.name, binding.value);
    }

    const compileExprToIREntry = (
      expr: FreeObjectExpr,
      currentItemBinding?: string,
    ): import("../ir/model.js").SelectExprIREntry => {
      if (expr.kind === "literal") {
        return { kind: "literal", value: expr.value };
      }
      if (expr.kind === "set_literal") {
        return { kind: "set_literal", values: [...expr.values] };
      }
      if (expr.kind === "set_expr") {
        return {
          kind: "set_expr",
          values: expr.values.map((value) => asNestedExprEntry(compileExprToIREntry(value, currentItemBinding))),
        };
      }
      if (expr.kind === "distinct") {
        return {
          kind: "distinct",
          value: asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding)),
        };
      }
      if (expr.kind === "field_access") {
        const value = asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding));
        if (
          value.kind === "literal"
          || value.kind === "set_literal"
          || value.kind === "enum_path"
          || value.kind === "cast"
          || value.kind === "function_call"
          || (value.kind === "type_field_path" && !expr.field.startsWith("@"))
        ) {
          fail("invalid property reference on an expression of primitive type");
        }
        return {
          kind: "field_access",
          value,
          field: expr.field,
        };
      }
      if (expr.kind === "shape_projection") {
        type ShapeProjectionField = {
          name: string;
          sourceField?: string;
          backlinkLink?: string;
          backlinkSourceType?: string;
          expr?: import("../ir/model.js").SelectExprIREntry<3>;
          itemFields?: Array<{
            name: string;
            sourceField?: string;
            expr?: import("../ir/model.js").SelectExprIREntry<3>;
            multi?: boolean;
          }>;
        };

        const fields: ShapeProjectionField[] = [];
        for (const element of expr.shape) {
          if (element.kind === "field") {
            fields.push({
              name: element.name,
              sourceField: element.name,
            });
            continue;
          }

          if (element.kind === "computed") {
            if (element.expr.kind === "field_ref") {
              fields.push({
                name: element.name,
                sourceField: element.expr.field,
              });
            }
            continue;
          }

          if (element.kind === "link") {
            if (element.shape && element.shape.length > 0) {
              const itemFields: ShapeProjectionField[] = [];
              for (const subElement of element.shape) {
                if (subElement.kind === "field") {
                  itemFields.push({ name: subElement.name, sourceField: subElement.name });
                  continue;
                }
                if (subElement.kind === "computed") {
                  if (subElement.expr.kind === "field_ref") {
                    itemFields.push({ name: subElement.name, sourceField: subElement.expr.field });
                    continue;
                  }
                  if (subElement.expr.kind === "select_expr") {
                    const adapted: FreeObjectExpr = {
                      kind: "select_expr_subquery",
                      expr: subElement.expr.expr,
                      clauses: subElement.expr.clauses,
                    };
                    itemFields.push({
                      name: subElement.name,
                      expr: asNestedExprEntry(compileExprToIREntry(adapted, currentItemBinding)),
                      multi: Boolean(subElement.multi || subElement.cardinality === "many"),
                    });
                    continue;
                  }
                }
              }
              fields.push({ name: element.name, sourceField: element.name, itemFields });
            } else {
              fields.push({ name: element.name, sourceField: element.name });
            }
            continue;
          }

          if (element.kind === "backlink") {
            fields.push({
              name: element.name,
              sourceField: element.name,
              backlinkLink: element.expr.link,
              backlinkSourceType: element.expr.sourceType,
            });
          }
        }

        return {
          kind: "shape_projection",
          value: asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding)),
          fields,
        };
      }
      if (expr.kind === "current_item") {
        return {
          kind: "current_item",
          bindingName: currentItemBinding ?? "__current__",
        };
      }
      if (expr.kind === "index_access") {
        return {
          kind: "index_access",
          value: asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding)),
          index: expr.index,
        };
      }
      if (expr.kind === "tuple") {
        return {
          kind: "tuple",
          values: expr.values.map((value) => asNestedExprEntry(compileExprToIREntry(value, currentItemBinding))),
        };
      }
      if (expr.kind === "exists") {
        return {
          kind: "exists",
          value: asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding)),
        };
      }
      if (expr.kind === "compare") {
        return {
          kind: "compare",
          op: expr.op,
          left: asNestedExprEntry(compileExprToIREntry(expr.left, currentItemBinding)),
          right: asNestedExprEntry(compileExprToIREntry(expr.right, currentItemBinding)),
        };
      }
      if (expr.kind === "and" || expr.kind === "or") {
        return {
          kind: expr.kind,
          left: asNestedExprEntry(compileExprToIREntry(expr.left, currentItemBinding)),
          right: asNestedExprEntry(compileExprToIREntry(expr.right, currentItemBinding)),
        };
      }
      if (expr.kind === "not") {
        return {
          kind: "not",
          expr: asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding)),
        };
      }
      if (expr.kind === "math") {
        return {
          kind: "math",
          op: expr.op,
          left: asNestedExprEntry(compileExprToIREntry(expr.left, currentItemBinding)),
          right: asNestedExprEntry(compileExprToIREntry(expr.right, currentItemBinding)),
        };
      }
      if (expr.kind === "if_else") {
        return {
          kind: "if_else",
          thenExpr: asNestedExprEntry(compileExprToIREntry(expr.thenExpr, currentItemBinding)),
          condition: asNestedExprEntry(compileExprToIREntry(expr.condition, currentItemBinding)),
          elseExpr: asNestedExprEntry(compileExprToIREntry(expr.elseExpr, currentItemBinding)),
        };
      }
      if (expr.kind === "for_expr") {
        return {
          kind: "for_expr",
          variable: expr.variable,
          iterator: asNestedExprEntry(compileExprToIREntry(expr.iterator, currentItemBinding)),
          body: asNestedExprEntry(compileExprToIREntry(expr.body, expr.variable)),
        };
      }
      if (expr.kind === "backlink_path") {
        return {
          kind: "backlink_path",
          link: expr.link,
          sourceType: expr.sourceType,
        };
      }
      if (expr.kind === "binding_ref") {
        if (currentItemBinding && expr.name === currentItemBinding) {
          return { kind: "current_item", bindingName: expr.name };
        }
        let bindingValue = withBindings.get(expr.name);
        if (!bindingValue) {
          const resolvedAliasName = normalizeTypeName(expr.name, activeModule);
          const alias = schema.getAlias(resolvedAliasName);
          if (alias?.values) {
            return { kind: "set_literal", values: [...alias.values] };
          }
          if (alias?.exprText) {
            const parsedAlias = parseEdgeQL(`select ${alias.exprText.replace(/;\s*$/, "")}`);
            if (parsedAlias.kind === "select_expr") {
              return compileExprToIREntry(parsedAlias.expr, currentItemBinding);
            }
          }

          const resolvedType = schema.getType(resolvedAliasName);
          if (resolvedType) {
            const isEnumScalarType = resolvedType.fields.length === 1
              && resolvedType.fields[0]?.name === "__enum__"
              && resolvedType.fields[0]?.enumValues
              && resolvedType.fields[0].enumValues.length > 0;
            if (isEnumScalarType) {
              fail("enum path expression lacks an enum member name, as in 'color_enum_t.GREEN'");
            }
          }

          if (/^__.+__/.test(expr.name)) {
            fail(`cannot refer to alias link helper type '${normalizeTypeName(expr.name, activeModule)}'`);
          }
          fail(`Unknown binding '${expr.name}'`);
        }
        bindingValue = requireValue(bindingValue, `Unknown binding '${expr.name}'`);
        if (bindingValue.kind === "literal") {
          return { kind: "literal", value: bindingValue.value };
        }
        if (bindingValue.kind === "set_literal") {
          return { kind: "set_literal", values: [...bindingValue.values] };
        }
        if (bindingValue.kind === "array_literal") {
          return { kind: "set_literal", values: [...bindingValue.values] };
        }
        if (bindingValue.kind === "enum_path") {
          return { kind: "enum_path", enumType: normalizeTypeName(bindingValue.enumType, activeModule), member: bindingValue.member };
        }
        if (bindingValue.kind === "path") {
          return compileExprToIREntry({ kind: "path", head: bindingValue.head, tail: bindingValue.tail }, currentItemBinding);
        }
        if (bindingValue.kind === "binding_ref") {
          return compileExprToIREntry({ kind: "binding_ref", name: bindingValue.name }, currentItemBinding);
        }
        if (bindingValue.kind === "subquery_expr") {
          if (bindingValue.expr.kind === "literal") {
            return { kind: "literal", value: bindingValue.expr.value };
          }
          return compileExprToIREntry(bindingValue.expr, currentItemBinding);
        }
        if (bindingValue.kind === "subquery") {
          const normalizedTypeName = normalizeTypeName(bindingValue.query.typeName, activeModule);
          const typeDef = requireValue(
            schema.getType(normalizedTypeName),
            `Unknown type '${normalizedTypeName}' in subquery binding`,
          );
          const subqueryPathId = createPathId();
          const mergedShape: ShapeElement[] = [
            ...bindingValue.query.shape,
            { kind: "splat" as const, depth: 1 as const },
          ];
          const nested = compileSelectForType(typeDef, subqueryPathId, mergedShape, bindingValue.query.clauses, {
            allowBacklinkFilter: true,
            linkProperties: new Set(),
          });
          return {
            kind: "select",
            query: {
              kind: "select",
              pathId: toPathIdIR(subqueryPathId),
              table: nested.table,
              sourceType: nested.sourceType,
              typeRef: nested.typeRef,
              sourceTables: nested.sourceTables.map((st) => ({
                name: st.name,
                table: st.table,
                schemaName: st.name,
                module: "default",
                isSchemaType: true,
              })),
              columns: nested.columns,
              shape: nested.shape,
              filter: nested.filter,
              orderBy: nested.orderBy,
              limit: nested.limit,
              offset: nested.offset,
              scopeTree: nested.scopeTree,
              inference: nested.inference,
              appliedOverlays: nested.appliedOverlays,
              triggers: nested.triggers,
              policies: nested.policies,
            },
          };
        }
        fail(`Unsupported binding kind '${bindingValue.kind}'`);
      }
      if (expr.kind === "enum_path") {
        const normalizedEnumType = normalizeTypeName(expr.enumType, activeModule);
        const enumTypeDef = schema.getType(normalizedEnumType);
        if (!enumTypeDef) {
          fail(`Unknown enum type '${normalizedEnumType}'`);
        }
        const allEnumValues = enumTypeDef!.fields.flatMap((f) => f.enumValues ?? []);
        if (allEnumValues.length === 0) {
          fail(`Type '${normalizedEnumType}' is not an enum`);
        }
        if (!allEnumValues.includes(expr.member)) {
          fail(`enum '${normalizedEnumType}' has no member called '${expr.member}'`);
        }
        return { kind: "enum_path", enumType: normalizedEnumType, member: expr.member };
      }
      if (expr.kind === "path") {
        if (currentItemBinding && expr.head === currentItemBinding) {
          return {
            kind: "current_item_field",
            bindingName: expr.head,
            field: expr.tail,
          };
        }

        // Check if head is a WITH binding
        const bindingValue = withBindings.get(expr.head);
        if (bindingValue) {
          // Resolve the binding to see what it refers to
          if (bindingValue.kind === "binding_ref") {
            if (/^__.+__$/.test(bindingValue.name) || /^__.+__/.test(bindingValue.name)) {
              fail(`cannot refer to alias link helper type '${normalizeTypeName(bindingValue.name, activeModule)}'`);
            }
            const resolvedType = schema.getType(normalizeTypeName(bindingValue.name, activeModule));
            if (resolvedType) {
              const isEnumScalarType = resolvedType.fields.length === 1
                && resolvedType.fields[0]?.name === "__enum__"
                && resolvedType.fields[0]?.enumValues
                && resolvedType.fields[0].enumValues.length > 0;
              if (isEnumScalarType) {
                fail(`enum path expression lacks an enum member name, as in '${bindingValue.name}.GREEN'`);
              }
            }
          }
          if (bindingValue.kind === "enum_path") {
            fail(`invalid property reference on an expression of primitive type`);
          }
          if (bindingValue.kind === "path") {
            const normalizedHead = normalizeTypeName(bindingValue.head, activeModule);
            const headTypeDef = schema.getType(normalizedHead);
            if (headTypeDef) {
              const isEnumScalarType = headTypeDef.fields.length === 1
                && headTypeDef.fields[0]?.name === "__enum__"
                && headTypeDef.fields[0]?.enumValues
                && headTypeDef.fields[0].enumValues.length > 0;
              if (isEnumScalarType) {
                fail(`invalid property reference on an expression of primitive type`);
              }
            }
          }
          fail(`Unknown type or enum '${expr.head}'`);
        }
        const normalizedHead = normalizeTypeName(expr.head, activeModule);
        const headAlias = schema.getAlias(normalizedHead);
        const resolvedHeadTypeName = headAlias?.sourceType
          ? normalizeTypeName(headAlias.sourceType, headAlias.module ?? activeModule)
          : normalizedHead;
        const headTypeDef = resolveObjectTypeOrAliasSource(expr.head, activeModule);
        if (headTypeDef) {
          const isEnumScalarType = headTypeDef.fields.length === 1
            && headTypeDef.fields[0]?.name === "__enum__"
            && headTypeDef.fields[0]?.enumValues
            && headTypeDef.fields[0].enumValues.length > 0;
          if (isEnumScalarType) {
            const allEnumValues = headTypeDef.fields[0]!.enumValues!;
            if (!allEnumValues.includes(expr.tail)) {
              fail(`enum has no member called '${expr.tail}'`);
            }
            return { kind: "enum_path", enumType: normalizedHead, member: expr.tail };
          }
          const field = headTypeDef.fields.find((f) => f.name === expr.tail);
          const fieldType = field?.enumTypeName ?? (field?.type ? `std::${field.type}` : "unknown");
          return { kind: "type_field_path", typeName: resolvedHeadTypeName, field: expr.tail, fieldType };
        }
        fail(`Unknown type or enum '${normalizedHead}'`);
      }
      if (expr.kind === "cast") {
        const innerEntry = compileExprToIREntry(expr.expr, currentItemBinding);
        const isBuiltinScalar = ["str", "int", "float", "bool", "json", "datetime", "duration", "local_datetime", "local_date", "local_time", "relative_duration", "date_duration", "uuid"].includes(expr.castType);
        const resolvedCastType = isBuiltinScalar ? expr.castType : normalizeTypeName(expr.castType, activeModule);
        const castTypeDef = isBuiltinScalar ? undefined : schema.getType(resolvedCastType);
        if (castTypeDef) {
          const allEnumValues = castTypeDef.fields.flatMap((f) => f.enumValues ?? []);
          if (allEnumValues.length > 0) {
            // Check if inner is a json cast - validate the JSON value is appropriate for enum
            if (innerEntry.kind === "cast" && innerEntry.castType === "json") {
              const jsonInnerValue = extractLiteralValue(innerEntry.value);
              if (jsonInnerValue === null) {
                return { kind: "cast", castType: resolvedCastType, value: { kind: "literal", value: null } };
              }
              const jsonInnerString = typeof jsonInnerValue === "string"
                ? jsonInnerValue
                : fail(`expected JSON string or null for enum cast, got ${typeof jsonInnerValue === "number" ? "JSON number" : typeof jsonInnerValue === "boolean" ? "JSON boolean" : "JSON value"}`);

              if (!allEnumValues.includes(jsonInnerString)) {
                fail(`invalid input value for enum '${resolvedCastType}': "${jsonInnerString}"`);
              }
              return { kind: "cast", castType: resolvedCastType, value: { kind: "literal", value: jsonInnerString } };
            }
            const coerceEnumValue = (entry: import("../ir/model.js").SelectExprIREntry): import("../ir/model.js").SelectExprIREntry => {
              if (entry.kind === "set_literal") {
                return {
                  kind: "set_literal",
                  values: entry.values.map((v) => {
                    if (typeof v !== "string") {
                      fail(`Cannot cast to enum '${resolvedCastType}': expected string value`);
                    }
                    if (!allEnumValues.includes(v as string)) {
                      fail(`invalid input value for enum '${resolvedCastType}': "${v}"`);
                    }
                    return v;
                  }),
                };
              }
              if (entry.kind === "set_expr") {
                return {
                  kind: "set_expr",
                  values: (entry.values as unknown[]).map((item) => {
                    const rawValue = extractLiteralValue(item as import("../ir/model.js").SelectExprIREntry);
                    const enumValue = expectStringLiteral(rawValue, `Cannot cast to enum '${resolvedCastType}': expected string value`);
                    if (!allEnumValues.includes(enumValue)) {
                      fail(`invalid input value for enum '${resolvedCastType}': "${enumValue}"`);
                    }
                    return { kind: "literal", value: enumValue };
                  }),
                };
              }
              if (entry.kind === "current_item") {
                return entry;
              }
              const rawValue = extractLiteralValue(entry);
              const enumValue = expectStringLiteral(rawValue, `Cannot cast to enum '${resolvedCastType}': expected string value`);
              if (!allEnumValues.includes(enumValue)) {
                fail(`invalid input value for enum '${resolvedCastType}': "${enumValue}"`);
              }
              return { kind: "literal", value: enumValue };
            };
            return {
              kind: "cast",
              castType: resolvedCastType,
              value: asNestedExprEntry(coerceEnumValue(innerEntry)),
            };
          }
          fail(`Unsupported cast type '${resolvedCastType}'`);
        }
        if (resolvedCastType === "str") {
          return {
            kind: "cast",
            castType: "str",
            value: asNestedExprEntry(innerEntry),
          };
        }
        if (resolvedCastType === "json") {
          return {
            kind: "cast",
            castType: "json",
            value: asNestedExprEntry(innerEntry),
          };
        }
        fail(`Unsupported cast type '${resolvedCastType}'`);
      }
      if (expr.kind === "concat") {
        return {
          kind: "concat",
          parts: expr.parts.map((part) => asNestedExprEntry(compileExprToIREntry(part, currentItemBinding))),
        };
      }
      if (expr.kind === "function_call") {
        const compileSelectExprFunctionArg = (
          arg: NonNullable<Extract<FreeObjectExpr, { kind: "function_call" }>["call"]>["args"][number],
          bindingName?: string,
        ): import("../ir/model.js").SelectExprIREntry<3> => {
          if (arg.kind === "literal") {
            return { kind: "literal", value: arg.value };
          }
          if (arg.kind === "binding_ref") {
            if (bindingName && arg.name === bindingName) {
              return { kind: "current_item", bindingName: arg.name };
            }
            const bindingValue = withBindings.get(arg.name);
            if (bindingValue?.kind === "set_literal") {
              return { kind: "set_literal", values: [...bindingValue.values] };
            }
            if (bindingValue?.kind === "array_literal") {
              return { kind: "set_literal", values: [...bindingValue.values] };
            }
            const scalar = resolveWithBindingScalar(arg.name);
            return { kind: "literal", value: scalar };
          }
          if (arg.kind === "set_literal") {
            return { kind: "set_literal", values: [...arg.values] };
          }
          if (arg.kind === "array_literal") {
            return { kind: "set_literal", values: [...arg.values] };
          }
          if (arg.kind === "expr") {
            return asNestedExprEntry(compileExprToIREntry(arg.expr, bindingName));
          }
          if (arg.kind === "field_ref") {
            fail("Free object function arguments do not support field references");
          }
          if (arg.kind === "function_call") {
            const nestedResolved = resolveFunctionOrFail(arg.call.name, arg.call.args.length);
            return {
              kind: "function_call",
              functionName: nestedResolved.qualifiedName,
              args: arg.call.args.map((nestedArg): import("../ir/model.js").SelectExprIREntry<2> => (
                compileSelectExprFunctionArg(nestedArg, bindingName) as import("../ir/model.js").SelectExprIREntry<2>
              )),
            };
          }

          fail("Unsupported function argument in select_expr");
          throw new Error("unreachable");
        };

        const resolved = resolveFunctionOrFail(expr.call.name, expr.call.args.length);
        return {
          kind: "function_call",
          functionName: resolved.qualifiedName,
          args: expr.call.args.map((arg): import("../ir/model.js").SelectExprIREntry<3> => (
            compileSelectExprFunctionArg(arg, currentItemBinding)
          )),
        };
      }
      if (expr.kind === "select") {
        // Check if this is actually a binding reference (e.g., WITH x := enum.RED SELECT x)
        const bindingValue = withBindings.get(expr.typeName);
        if (bindingValue) {
          if (currentItemBinding && expr.typeName === currentItemBinding) {
            return { kind: "current_item", bindingName: expr.typeName };
          }
          if (bindingValue.kind === "literal") {
            return { kind: "literal", value: bindingValue.value };
          }
          if (bindingValue.kind === "set_literal") {
            return { kind: "set_literal", values: [...bindingValue.values] };
          }
          if (bindingValue.kind === "array_literal") {
            return { kind: "set_literal", values: [...bindingValue.values] };
          }
          if (bindingValue.kind === "enum_path") {
            return { kind: "enum_path", enumType: bindingValue.enumType, member: bindingValue.member };
          }
          if (bindingValue.kind === "path") {
            const normalizedHead = normalizeTypeName(bindingValue.head, activeModule);
            const headTypeDef = schema.getType(normalizedHead);
            if (headTypeDef) {
              const isEnumScalarType = headTypeDef.fields.length === 1
                && headTypeDef.fields[0]?.name === "__enum__"
                && headTypeDef.fields[0]?.enumValues
                && headTypeDef.fields[0].enumValues.length > 0;
              if (isEnumScalarType) {
                const allEnumValues = headTypeDef.fields[0]!.enumValues!;
                if (!allEnumValues.includes(bindingValue.tail)) {
                  fail(`enum '${normalizedHead}' has no member called '${bindingValue.tail}'`);
                }
                return { kind: "enum_path", enumType: normalizedHead, member: bindingValue.tail };
              }
            }
            fail(`Unknown type or enum '${normalizedHead}'`);
          }
          if (bindingValue.kind === "binding_ref") {
            const resolvedType = schema.getType(normalizeTypeName(bindingValue.name, activeModule));
            if (resolvedType) {
              const isEnumScalarType = resolvedType.fields.length === 1
                && resolvedType.fields[0]?.name === "__enum__"
                && resolvedType.fields[0]?.enumValues
                && resolvedType.fields[0].enumValues.length > 0;
              if (isEnumScalarType) {
                fail(`enum path expression lacks an enum member name, as in '${bindingValue.name}.GREEN'`);
              }
            }
            fail(`Unknown binding '${expr.typeName}'`);
          }
          if (bindingValue.kind === "subquery_expr") {
            if (bindingValue.expr.kind === "literal") {
              return { kind: "literal", value: bindingValue.expr.value };
            }
            return compileExprToIREntry(bindingValue.expr, currentItemBinding);
          }
        if (bindingValue.kind === "subquery") {
          const normalizedTypeName = normalizeTypeName(bindingValue.query.typeName, activeModule);
          const typeDef = requireValue(
            schema.getType(normalizedTypeName),
            `Unknown type '${normalizedTypeName}' in subquery binding`,
          );
          const subqueryPathId = createPathId();
          const mergedShape: ShapeElement[] = [
            ...bindingValue.query.shape,
            { kind: "splat" as const, depth: 1 as const },
          ];
          const nested = compileSelectForType(typeDef, subqueryPathId, mergedShape, bindingValue.query.clauses, {
            allowBacklinkFilter: true,
            linkProperties: new Set(),
          });
          return {
            kind: "select",
            query: {
              kind: "select",
              pathId: toPathIdIR(subqueryPathId),
              table: nested.table,
              sourceType: nested.sourceType,
              typeRef: nested.typeRef,
              sourceTables: nested.sourceTables.map((st) => ({
                name: st.name,
                table: st.table,
                schemaName: st.name,
                module: "default",
                isSchemaType: true,
              })),
              columns: nested.columns,
              shape: nested.shape,
              filter: nested.filter,
              orderBy: nested.orderBy,
              limit: nested.limit,
              offset: nested.offset,
              scopeTree: nested.scopeTree,
              inference: nested.inference,
              appliedOverlays: nested.appliedOverlays,
              triggers: nested.triggers,
              policies: nested.policies,
            },
          };
        }
        fail(`Unsupported binding kind '${bindingValue.kind}'`);
        }

        const resolvedAliasName = normalizeTypeName(expr.typeName, activeModule);
        const schemaAlias = schema.getAlias(resolvedAliasName);
        if (schemaAlias?.values) {
          return { kind: "set_literal", values: [...schemaAlias.values] };
        }

        const aliasSourceType = schemaAlias?.sourceType
          ? schema.getType(normalizeTypeName(schemaAlias.sourceType, schemaAlias.module ?? activeModule))
          : undefined;

        const nestedType = requireValue(
          aliasSourceType ?? schema.getType(normalizeTypeName(expr.typeName, activeModule)),
          `Unknown type '${normalizeTypeName(expr.typeName, activeModule)}' in select expression`,
        );
        const aliasFilter = schemaAlias?.filter?.kind === "field_predicate"
          ? {
              kind: "predicate" as const,
              target: { kind: "field" as const, field: schemaAlias.filter.field },
              op: schemaAlias.filter.op,
              value: schemaAlias.filter.value,
            }
          : undefined;
        const nestedPath = createPathId(pathId);
        const nested = compileSelectForType(
          nestedType,
          nestedPath,
          expr.shape,
          {
            filter: mergeFilters(aliasFilter, expr.clauses.filter),
            orderBy: expr.clauses.orderBy,
            limit: expr.clauses.limit,
            offset: expr.clauses.offset,
          },
          { allowBacklinkFilter: true },
        );

        return {
          kind: "select",
          query: {
            kind: "select",
            pathId: nested.pathId,
            sourceType: nested.sourceType,
            typeRef: nested.typeRef,
            table: nested.table,
            sourceTables: nested.sourceTables,
            columns: nested.columns,
            shape: nested.shape,
            scopeTree: nested.scopeTree,
            appliedOverlays: nested.appliedOverlays,
            filter: nested.filter,
            orderBy: nested.orderBy,
            limit: nested.limit,
            offset: nested.offset,
            inference: nested.inference,
          },
        };
      }
      if (expr.kind === "is_type") {
        return {
          kind: "is_type",
          value: asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding)),
          typeName: normalizeTypeName(expr.typeName, activeModule),
        };
      }
      if (expr.kind === "select_expr_subquery") {
        const innerBinding = expr.alias ?? currentItemBinding;
        const addedBindingNames: string[] = [];
        for (const binding of expr.clauses?._withBindings ?? []) {
          if (!withBindings.has(binding.name)) {
            withBindings.set(binding.name, binding.value);
            addedBindingNames.push(binding.name);
          }
        }
        try {
          return {
            kind: "select_expr_subquery",
            alias: expr.alias,
            value: asNestedExprEntry(compileExprToIREntry(expr.expr, innerBinding)),
            filter: expr.filter
              ? asNestedExprEntry(compileExprToIREntry(expr.filter, innerBinding))
              : undefined,
            orderBy: expr.orderBy
              ? {
                  value: asNestedExprEntry(compileExprToIREntry(expr.orderBy.expr, innerBinding)),
                  direction: expr.orderBy.direction,
                }
              : undefined,
            limit: expr.limit,
            offset: expr.offset,
          };
        } finally {
          for (const name of addedBindingNames) {
            withBindings.delete(name);
          }
        }
      }
      fail(`Unsupported expression kind in select_expr: ${(expr as FreeObjectExpr).kind}`);
      throw new Error("unreachable");
    };

    const inferredCurrentBinding = (
      statement.expr.kind === "binding_ref"
      && withBindings.get(statement.expr.name)?.kind === "set_literal"
    )
      ? statement.expr.name
      : (
        statement.expr.kind === "select"
        && withBindings.get(statement.expr.typeName)?.kind === "set_literal"
      )
        ? statement.expr.typeName
        : (
          statement.expr.kind === "select_expr_subquery"
          && typeof statement.expr.alias === "string"
        )
          ? statement.expr.alias
        : "__current__";

    const entry = compileExprToIREntry(statement.expr);
    return {
      kind: "select_expr",
      entries: [entry],
      currentBinding: inferredCurrentBinding,
      orderBy: statement.orderBy
        ? {
            value: compileExprToIREntry(statement.orderBy.expr, inferredCurrentBinding),
            direction: statement.orderBy.direction,
          }
        : undefined,
    };
  }

  if (statement.kind === "for") {
    throw new Error("FOR statements should be handled at the execution layer");
  }

  const resolvedRootType = statement.kind === "select"
    ? resolveSelectSource(statement)
    : {
        constTypeName: requireValue(statement.typeName, `Statement kind '${statement.kind}' requires typeName`),
        typeDef: requireValue(
          schema.getType(normalizeTypeName(requireValue(statement.typeName, `Statement kind '${statement.kind}' requires typeName`), activeModule)),
          `Unknown type '${normalizeTypeName(requireValue(statement.typeName, `Statement kind '${statement.kind}' requires typeName`), activeModule)}'`,
        ),
        clauses: {
          filter: undefined,
          orderBy: undefined,
          limit: undefined,
          offset: undefined,
        },
        aliasProjections: undefined,
      };
  const typeDef = resolvedRootType.typeDef;
  const table = tableNameForType(qualifiedTypeName(typeDef));
  const userFields = typeDef.fields.filter((field) => field.name !== "id");
  const knownFields = new Set(["id", ...userFields.map((f) => f.name)]);
  const fieldByName = new Map([
    ["id", { name: "id", type: "uuid" as const, required: true }],
    ...userFields.map((field) => [field.name, field] as const),
  ]);
  const insertRewriteFields = new Set((typeDef.mutationRewrites ?? [])
    .filter((rewrite) => Boolean(rewrite.onInsert))
    .map((rewrite) => rewrite.field));

  const typeName = statement.typeName;

  const ensureField = (fieldName: string): void => {
    if (!knownFields.has(fieldName)) {
      fail(`Unknown field '${fieldName}' on '${typeName}'`);
    }
  };

  const validateFieldValue = (fieldName: string, value: ScalarValue): void => {
    ensureField(fieldName);
    const field = requireValue(fieldByName.get(fieldName), `Unknown field '${fieldName}' on '${typeName}'`);

      if (field.multi) {
        if (typeof value !== "string") {
          fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);
        }

        try {
          const serialized = typeof value === "string"
            ? value
            : fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);
          const parsed: unknown = JSON.parse(serialized);
          const parsedArray = Array.isArray(parsed)
            ? parsed
            : fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);

          for (const entry of parsedArray) {
            if (!isValidScalarValue(field.type, entry)) {
              fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);
            }
            if (field.enumValues && typeof entry === "string" && !field.enumValues.includes(entry)) {
              fail(`invalid input value for enum '${typeName}': "${entry}"`);
            }
          }
        } catch {
          fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);
        }
      return;
    }

    if (!isValidScalarValue(field.type, value)) {
      fail(`Type mismatch for '${fieldName}': expected ${field.type}`);
    }

    if (field.enumValues && typeof value === "string" && !field.enumValues.includes(value)) {
      fail(`invalid input value for enum '${typeName}': "${value}"`);
    }
  };

  if (statement.kind === "select") {
    const rootPathId = createPathId();
    const compiled = compileSelectForType(typeDef, rootPathId, statement.shape, {
      filter: resolvedRootType.clauses.filter,
      orderBy: resolvedRootType.clauses.orderBy,
      limit: resolvedRootType.clauses.limit,
      offset: resolvedRootType.clauses.offset,
    }, {
      allowBacklinkFilter: true,
      aliasProjections: resolvedRootType.aliasProjections,
    });

    return {
      kind: "select",
      pathId: compiled.pathId,
      sourceType: compiled.sourceType,
      typeRef: compiled.typeRef,
      table: compiled.table,
      sourceTables: compiled.sourceTables,
      columns: compiled.columns,
      shape: compiled.shape,
      scopeTree: compiled.scopeTree,
      appliedOverlays: compiled.appliedOverlays,
      filter: compiled.filter,
      orderBy: compiled.orderBy,
      limit: compiled.limit,
      offset: compiled.offset,
      inference: compiled.inference,
    };
  }

  if (statement.kind === "insert") {
    const pathId = createPathId();
    const pendingInlineLinkValue = "__gel_pending_inline_link__";
    const pendingGeneratedValueForField = (fieldName: string): ScalarValue => {
      const field = fieldByName.get(fieldName);
      if (!field) {
        return "__gel_pending_insert_rewrite__";
      }

      if (field.multi) {
        return "[]";
      }

      switch (field.type) {
        case "int":
        case "float":
          return 0;
        case "bool":
          return false;
        case "json":
          return "null";
        case "uuid":
          return pendingInlineLinkValue;
        default:
          return "__gel_pending_insert_rewrite__";
      }
    };
    if (typeDef.abstract) {
      fail(`cannot insert into abstract object type '${qualifiedTypeName(typeDef)}'`);
    }

    const linkByName = new Map((typeDef.links ?? []).map((link) => [link.name, link] as const));
    const scalarValues: Record<string, ScalarValue> = {};

    const validateInsertLinkExpr = (linkName: string, value: InsertValue): void => {
      if (typeof value !== "object" || value === null || !("kind" in value)) {
        if (typeof value !== "string" && value !== null) {
          fail(`Link '${linkName}' assignments require object ids or subqueries`);
        }
        return;
      }

      if (value.kind === "binding_ref") {
        return;
      }
      if (value.kind === "select") {
        return;
      }
      if (value.kind === "insert") {
        return;
      }
      if (value.kind === "set") {
        for (const item of value.values) {
          validateInsertLinkExpr(linkName, item);
        }
        return;
      }
      if (value.kind === "for") {
        return;
      }

      fail(`Unsupported insert expression for link '${linkName}'`);
    };

    for (const [field, value] of Object.entries(statement.values)) {
      if (field === "id") {
        fail("'id' is server-generated and cannot be assigned");
      }

      if (knownFields.has(field)) {
        const fieldDef = requireValue(fieldByName.get(field), `Unknown field '${field}' on '${statement.typeName}'`);
        const scalar = fieldDef.multi
          ? JSON.stringify(resolveInsertSetValues(value))
          : resolveInsertScalarValue(value);
        validateFieldValue(field, scalar);
        scalarValues[field] = scalar;
        continue;
      }

      if (linkByName.has(field)) {
        const linkDef = requireValue(linkByName.get(field), `Unknown link '${field}' on '${statement.typeName}'`);
        validateInsertLinkExpr(field, value);

        const usesLinkTable = Boolean(linkDef.multi) || (linkDef.properties?.length ?? 0) > 0;
        if (!usesLinkTable) {
          const inlineColumn = `${field}_id`;
          const inlineFieldDef = fieldByName.get(inlineColumn);

          if (typeof value === "string" || value === null) {
            validateFieldValue(inlineColumn, value);
            scalarValues[inlineColumn] = value;
          } else if (inlineFieldDef?.required) {
            scalarValues[inlineColumn] = pendingInlineLinkValue;
          }
        }

        continue;
      }

      fail(`Unknown field '${field}' on '${statement.typeName}'`);
    }

    for (const field of userFields) {
      if (field.required && !(field.name in scalarValues)) {
        if (insertRewriteFields.has(field.name)) {
          scalarValues[field.name] = pendingGeneratedValueForField(field.name);
          continue;
        }
        if (field.hasDefault) {
          scalarValues[field.name] = pendingGeneratedValueForField(field.name);
          continue;
        }
        fail(`Missing required field '${field.name}'`);
      }
    }

    return {
      kind: "insert",
      pathId: toPathIdIR(pathId),
      table,
      values: scalarValues,
      overlays: [
        {
          table,
          sourcePathId: pathId,
          operation: "union",
          policyPhase: "none",
          rewritePhase: "none",
        },
      ],
      triggers: (typeDef.triggers ?? []).map((t) => ({
        name: t.name,
        events: [{ kind: t.event as "insert" | "update" | "delete" }],
        scope: (t.scope ?? "each") as "each" | "all",
        sourceType: qualifiedTypeName(typeDef),
      })),
      policies: (typeDef.accessPolicies ?? []).map((p) => ({
        name: p.name,
        effect: p.effect as "allow" | "deny",
        operations: [...p.operations],
        condition: p.condition.kind === "always" ? undefined : JSON.stringify(p.condition),
        errmessage: p.errmessage,
      })),
    };
  }

  if (statement.kind === "update") {
    const pathId = createPathId();
    const filterExpr = statement.filter;
    let predicateFilter: FieldEqPredicate | undefined;
    if (filterExpr) {
      if (filterExpr.kind !== "predicate") {
        fail("Update filters currently support only a single predicate");
      } else {
        if (filterExpr.op !== "=") {
          fail("Update filters currently support only '='");
        }
        if (filterExpr.target.kind !== "field") {
          fail("Update filters do not support backlink targets");
        }
        predicateFilter = filterExpr as FieldEqPredicate;
        validateFieldValue(predicateFilter.target.field, resolveFilterValue(predicateFilter.value) as ScalarValue);
      }
    }

    const linkByName = new Map((typeDef.links ?? []).map((link) => [link.name, link] as const));

    const validateUpdateLinkExpr = (linkName: string, value: InsertValue): void => {
      if (typeof value !== "object" || value === null || !("kind" in value)) {
        if (typeof value !== "string" && value !== null) {
          fail(`Link '${linkName}' assignments require object ids or subqueries`);
        }
        return;
      }

      if (value.kind === "binding_ref" || value.kind === "select" || value.kind === "insert" || value.kind === "for") {
        return;
      }
      if (value.kind === "set") {
        for (const item of value.values) {
          validateUpdateLinkExpr(linkName, item);
        }
        return;
      }

      fail(`Unsupported update expression for link '${linkName}'`);
    };

    const scalarValues: Record<string, ScalarValue> = {};
    const updateFields = Object.entries(statement.values);
    if (updateFields.length === 0) {
      fail("Update requires at least one field assignment");
    }

    for (const [field, value] of updateFields) {
      if (field === "id") {
        fail("'id' is server-generated and cannot be assigned");
      }

      if (knownFields.has(field)) {
        const fieldDef = requireValue(fieldByName.get(field), `Unknown field '${field}' on '${statement.typeName}'`);
        const scalar = fieldDef.multi
          ? JSON.stringify(resolveInsertSetValues(value))
          : resolveInsertScalarValue(value);
        validateFieldValue(field, scalar);
        scalarValues[field] = scalar;
        continue;
      }

      if (linkByName.has(field)) {
        validateUpdateLinkExpr(field, value);
        continue;
      }

      fail(`Unknown field '${field}' on '${statement.typeName}'`);
    }

    return {
      kind: "update",
      pathId: toPathIdIR(pathId),
      table,
      filter: predicateFilter
        ? {
            column: predicateFilter.target.field,
            value: resolveFilterValue(predicateFilter.value) as ScalarValue,
          }
        : undefined,
      values: scalarValues,
      overlays: [
        {
          table,
          sourcePathId: pathId,
          operation: "replace",
          policyPhase: "none",
          rewritePhase: "none",
        },
      ],
      triggers: (typeDef.triggers ?? []).map((t) => ({
        name: t.name,
        events: [{ kind: t.event as "insert" | "update" | "delete" }],
        scope: (t.scope ?? "each") as "each" | "all",
        sourceType: qualifiedTypeName(typeDef),
      })),
      policies: (typeDef.accessPolicies ?? []).map((p) => ({
        name: p.name,
        effect: p.effect as "allow" | "deny",
        operations: [...p.operations],
        condition: p.condition.kind === "always" ? undefined : JSON.stringify(p.condition),
        errmessage: p.errmessage,
      })),
    };
  }

  const deleteFilterExpr = statement.filter;
  let deletePredicateFilter: FieldEqPredicate | undefined;
  if (deleteFilterExpr) {
    if (deleteFilterExpr.kind !== "predicate") {
      fail("Delete filters currently support only a single predicate");
    } else {
      if (deleteFilterExpr.op !== "=") {
        fail("Delete filters currently support only '='");
      }
      if (deleteFilterExpr.target.kind !== "field") {
        fail("Delete filters do not support backlink targets");
      }
      deletePredicateFilter = deleteFilterExpr as FieldEqPredicate;
      validateFieldValue(deletePredicateFilter.target.field, resolveFilterValue(deletePredicateFilter.value) as ScalarValue);
    }
  }

  const pathId = createPathId();
  return {
    kind: "delete",
    pathId: toPathIdIR(pathId),
    table,
    filter: deletePredicateFilter
      ? {
          column: deletePredicateFilter.target.field,
          value: resolveFilterValue(deletePredicateFilter.value) as ScalarValue,
        }
      : undefined,
    overlays: [
      {
        table,
        sourcePathId: pathId,
        operation: "exclude",
        policyPhase: "none",
        rewritePhase: "none",
      },
    ],
    triggers: (typeDef.triggers ?? []).map((t) => ({
      name: t.name,
      events: [{ kind: t.event as "insert" | "update" | "delete" }],
      scope: (t.scope ?? "each") as "each" | "all",
      sourceType: qualifiedTypeName(typeDef),
    })),
    policies: (typeDef.accessPolicies ?? []).map((p) => ({
      name: p.name,
      effect: p.effect as "allow" | "deny",
      operations: [...p.operations],
      condition: p.condition.kind === "always" ? undefined : JSON.stringify(p.condition),
      errmessage: p.errmessage,
    })),
  };
};

const ensureUniqueShapeNames = (shape: SelectShapeElementIR[], fail: (message: string) => never): void => {
  const seen = new Set<string>();
  for (const element of shape) {
    if (seen.has(element.name)) {
      fail(`Duplicate shape element '${element.name}'`);
    }
    seen.add(element.name);
  }
};

const isDirectIdEqualityFilter = (filter: FilterExprIR | undefined): boolean =>
  Boolean(filter && filter.kind === "field" && filter.column === "id" && filter.op === "=");

const inferSelect = (isIdFiltered: boolean, limit: number | undefined, selectedColumns: Set<string>): InferenceResult => {
  let cardinality: InferenceResult["cardinality"] = "many";
  if (limit === 0) {
    cardinality = "empty";
  } else if (isIdFiltered || limit === 1) {
    cardinality = "at_most_one";
  }

  return {
    cardinality,
    multiplicity: selectedColumns.has("id") ? "unique" : "duplicate",
    volatility: "immutable",
  };
};

const coerceRuntimeScalarValue = (value: unknown, context: string): ScalarValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  throw new AppError("E_SEMANTIC", `Expected scalar runtime value for ${context}`, 1, 1);
};

const coerceCastScalarValue = (castType: string, value: unknown, context: string): ScalarValue => {
  const scalar = coerceRuntimeScalarValue(value, context);

  switch (castType) {
    case "str":
      return scalar === null ? "" : String(scalar);
    case "int": {
      const numeric = typeof scalar === "number" ? scalar : Number(scalar);
      if (!Number.isInteger(numeric)) {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to int`, 1, 1);
      }
      return numeric;
    }
    case "float": {
      const numeric = typeof scalar === "number" ? scalar : Number(scalar);
      if (!Number.isFinite(numeric)) {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to float`, 1, 1);
      }
      return numeric;
    }
    case "bool":
      if (typeof scalar === "boolean") {
        return scalar;
      }
      if (typeof scalar === "string") {
        if (scalar.toLowerCase() === "true") {
          return true;
        }
        if (scalar.toLowerCase() === "false") {
          return false;
        }
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to bool`, 1, 1);
    case "json":
      if (typeof scalar !== "string") {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to json`, 1, 1);
      }
      try {
        JSON.parse(scalar);
        return scalar;
      } catch {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to json`, 1, 1);
      }
    case "datetime": {
      if (typeof scalar !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(scalar)) {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to datetime`, 1, 1);
      }
      const date = new Date(scalar);
      if (Number.isNaN(date.getTime())) {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to datetime`, 1, 1);
      }
      return date.toISOString();
    }
    case "local_datetime":
      if (typeof scalar === "string" && isValidLocalDateTime(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to local_datetime`, 1, 1);
    case "local_date":
      if (typeof scalar === "string" && isValidLocalDate(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to local_date`, 1, 1);
    case "local_time":
      if (typeof scalar === "string" && isValidLocalTime(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to local_time`, 1, 1);
    case "duration":
    case "relative_duration":
    case "date_duration":
      if (typeof scalar === "string" && /^[-+]?P/.test(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to ${castType}`, 1, 1);
    case "uuid":
      if (typeof scalar === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to uuid`, 1, 1);
    default:
      throw new AppError("E_SEMANTIC", `Unsupported cast '${castType}'`, 1, 1);
  }
};

const isValidScalarValue = (type: ScalarType, value: unknown): value is ScalarValue => {
  if (value === null) {
    return true;
  }

  switch (type) {
    case "str":
      return typeof value === "string";
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "float":
      return typeof value === "number";
    case "bool":
      return typeof value === "boolean";
    case "json":
      if (value === null) {
        return true;
      }
      if (typeof value === "boolean" || typeof value === "number") {
        return true;
      }
      if (typeof value === "string") {
        try {
          JSON.parse(value);
          return true;
        } catch {
          return false;
        }
      }
      if (Array.isArray(value)) {
        return true;
      }
      if (value !== null && typeof value === "object") {
        return true;
      }
      return false;
    case "datetime":
    case "duration":
    case "local_datetime":
    case "local_date":
    case "local_time":
    case "relative_duration":
    case "date_duration":
      return typeof value === "string";
    case "uuid":
      return typeof value === "string";
    default:
      return false;
  }
};

const isValidLocalDate = (value: string): boolean => {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) {
    return false;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
};

const isValidLocalDateTime = (value: string): boolean => {
  const matched = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)$/);
  if (!matched) {
    return false;
  }

  return isValidLocalDate(matched[1]) && isValidLocalTime(matched[2]);
};

const isValidLocalTime = (value: string): boolean => {
  const matched = value.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
  if (!matched) {
    return false;
  }

  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  const second = Number(matched[3] ?? "0");
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
};
