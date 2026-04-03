import { AppError } from "../errors.js";
import type { ComputedExpr, FilterExpr, FreeObjectExpr, InsertValue, SelectStatement, ShapeElement, Statement } from "../edgeql/ast.js";
import type {
  BacklinkSourceIR,
  FilterExprIR,
  InferenceResult,
  IRStatement,
  LinkRelationIR,
  OverlayIR,
  ScopeTreeIR,
  SelectShapeElementIR,
} from "../ir/model.js";
import { qualifiedTypeName, SchemaSnapshot } from "../schema/schema.js";
import type { ScalarType, ScalarValue, TypeDef } from "../types.js";
import { tryResolveStdlibFunction } from "../stdlib/functions.js";

const tableNameForType = (qualifiedName: string): string => qualifiedName.replaceAll("::", "__").toLowerCase();

export interface CompileContext {
  overlays?: OverlayIR[];
  globals?: Record<string, ScalarValue>;
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
        case "binding_ref":
          return resolveWithBindingScalar(binding.name);
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
        default:
          return fail(`Unsupported with binding kind in '${name}'`);
      }
    })();

    resolvingBindingValues.delete(name);
    resolvedBindingValues.set(name, resolved);
    return resolved;
  };

  const resolveFilterValue = (value: ScalarValue | { kind: "binding_ref"; name: string }): ScalarValue => {
    if (typeof value === "object" && value !== null && "kind" in value && value.kind === "binding_ref") {
      return resolveWithBindingScalar(value.name);
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
      default:
        return fail(`Expected scalar value in insert assignment, got ${value.kind}`);
    }
  };

  const compileFilterExpr = (
    fieldByName: Map<string, { name: string; type: ScalarType; required?: boolean }>,
    knownFields: Set<string>,
    typeLabel: string,
    filter: FilterExpr,
    options: { allowBacklink: boolean; fallbackModule: string },
  ): FilterExprIR => {
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

    const value = resolveFilterValue(filter.value);
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

    if (!knownFields.has(filter.target.field)) {
      fail(`Unknown field '${filter.target.field}' on '${typeLabel}'`);
    }

    const field = requireValue(fieldByName.get(filter.target.field), `Unknown field '${filter.target.field}' on '${typeLabel}'`);
    if (filter.op === "like" || filter.op === "ilike") {
      if (field.type !== "str") {
        fail(`Filter operator '${filter.op}' requires str field, got ${field.type}`);
      }
      if (typeof value !== "string") {
        fail(`Filter operator '${filter.op}' requires string value`);
      }
    } else if (!isValidScalarValue(field.type, value)) {
      fail(`Type mismatch for '${filter.target.field}': expected ${field.type}`);
    }

    return {
      kind: "field",
      column: filter.target.field,
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

  let nextPathOrdinal = 0;
  const createPathId = (parentPathId?: string): string => {
    const current = `p${nextPathOrdinal}`;
    nextPathOrdinal += 1;
    return parentPathId ? `${parentPathId}.${current}` : current;
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
      if (requestedSourceType && candidateQualifiedName !== requestedSourceType) {
        continue;
      }

      for (const link of candidate.links ?? []) {
        const linkTarget = normalizeTypeName(link.targetType, candidate.module ?? "default");
        if (link.name !== linkName || linkTarget !== targetTypeQualifiedName) {
          continue;
        }

        if (link.multi) {
          sources.push({
            sourceType: candidateQualifiedName,
            table: tableNameForType(candidateQualifiedName),
            storage: "table",
            linkTable: `${tableNameForType(candidateQualifiedName)}__${link.name.toLowerCase()}`,
          });
          continue;
        }

        sources.push({
          sourceType: candidateQualifiedName,
          table: tableNameForType(candidateQualifiedName),
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
    pathId: string,
    shape: ShapeElement[],
    clauses: {
      filter?: SelectStatement["filter"];
      orderBy?: SelectStatement["orderBy"];
      limit?: SelectStatement["limit"];
      offset?: SelectStatement["offset"];
    },
    options: {
      allowBacklinkFilter: boolean;
    },
    ): {
      pathId: string;
      sourceType: string;
      typeRef: { name: string; table: string };
      table: string;
      sourceTables: Array<{ name: string; table: string }>;
      columns: string[];
      shape: SelectShapeElementIR[];
    scopeTree: ScopeTreeIR;
    appliedOverlays: OverlayIR[];
    filter?: FilterExprIR;
    orderBy?: { column: string; direction: "asc" | "desc" };
    limit?: number;
    offset?: number;
    inference: InferenceResult;
  } => {
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

    const validateFieldValue = (fieldName: string, value: ScalarValue): void => {
      ensureField(fieldName);
      const field = requireValue(fieldByName.get(fieldName), `Unknown field '${fieldName}' on '${qualifiedName}'`);

      if (!isValidScalarValue(field.type, value)) {
        fail(`Type mismatch for '${fieldName}': expected ${field.type}`);
      }
    };

    const resolveForwardLink = (ownerTypeDef: TypeDef, linkName: string): LinkRelationIR => {
      const ownerQualifiedName = qualifiedTypeName(ownerTypeDef);
      const ownerScopeModule = ownerTypeDef.module ?? scopeModule;
      const link = requireValue(
        collectLinks(ownerTypeDef, true).find((candidate) => candidate.name === linkName),
        `Unknown link '${linkName}' on '${ownerQualifiedName}'`,
      );

      const targetType = normalizeTypeName(link.targetType, ownerScopeModule);
      const targetTables = schema
        .listConcreteTypesAssignableTo(targetType)
        .map((candidate) => {
          const name = qualifiedTypeName(candidate);
          return {
            name,
            table: tableNameForType(name),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

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
        storage: link.multi ? "table" : "inline",
        inlineColumn: link.multi ? undefined : `${link.name}_id`,
        linkTable: link.multi ? `${tableNameForType(ownerQualifiedName)}__${link.name.toLowerCase()}` : undefined,
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
              pathId: elementPathId,
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
              pathId: elementPathId,
              column: field.name,
            });
          }

          shapeNames.add(field.name);
          scopeChildren.push({
            pathId: elementPathId,
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
              pathId: linkPathId,
              relation,
              typeFilter: undefined,
              sourceTypeFilter: shapeElement.intersection ? splatQualifiedName : undefined,
              columns: nested.columns,
              shape: nested.shape,
              filter: undefined,
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
        const computed = computedByName.get(shapeElement.name);
        if (!knownFields.has(shapeElement.name) && computed) {
          if (computed.kind === "property") {
            const elementPathId = createPathId(pathId);
            if (computed.expr.kind === "field_ref") {
              ensureField(computed.expr.field);
              selectedColumns.add(computed.expr.field);
              shapeElements.push({
                kind: "computed",
                name: shapeElement.name,
                pathId: elementPathId,
                expr: {
                  kind: "field_ref",
                  column: computed.expr.field,
                },
              });
            } else if (computed.expr.kind === "literal") {
              shapeElements.push({
                kind: "computed",
                name: shapeElement.name,
                pathId: elementPathId,
                expr: {
                  kind: "literal",
                  value: computed.expr.value,
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
                pathId: elementPathId,
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
            scopeChildren.push({ pathId: elementPathId, typeName: qualifiedName, children: [] });
            continue;
          }

          if (computed.expr.kind === "backlink") {
            const elementPathId = createPathId(pathId);
            hasBacklink = true;
            const sources = resolveBacklinkSources(qualifiedName, scopeModule, computed.expr.link, computed.expr.sourceType);
            shapeElements.push({
              kind: "backlink",
              name: shapeElement.name,
              pathId: elementPathId,
              sources,
            });
            shapeNames.add(shapeElement.name);
            scopeChildren.push({ pathId: elementPathId, typeName: qualifiedName, children: [] });
            continue;
          }

          const linkPathId = createPathId(pathId);
          const relation = resolveForwardLink(typeDef, computed.expr.link);
          const targetType = requireValue(
            schema.getType(relation.targetType),
            `Unknown link target type '${relation.targetType}' from '${qualifiedName}.${computed.expr.link}'`,
          );
          const nested = compileSelectForType(
            targetType,
            linkPathId,
            [{ kind: "field", name: "id" }],
            {
              filter: computed.expr.filter
                ? {
                    kind: "predicate",
                    target: { kind: "field", field: computed.expr.filter.field },
                    op: computed.expr.filter.op,
                    value: computed.expr.filter.value,
                  }
                : undefined,
            },
            { allowBacklinkFilter: false },
          );

          if (relation.storage === "inline") {
            selectedColumns.add(requireValue(relation.inlineColumn, `Missing inline storage metadata for '${computed.expr.link}'`));
          }

          shapeElements.push({
            kind: "link",
            name: shapeElement.name,
            pathId: linkPathId,
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
        ensureField(shapeElement.name);
        selectedColumns.add(shapeElement.name);
        shapeElements.push({
          kind: "field",
          name: shapeElement.name,
          pathId: elementPathId,
          column: shapeElement.name,
        });
        shapeNames.add(shapeElement.name);
        scopeChildren.push({
          pathId: elementPathId,
          typeName: qualifiedName,
          children: [],
        });
        continue;
      }

      if (shapeElement.kind === "computed") {
        const elementPathId = createPathId(pathId);
        if (shapeElement.expr.kind === "field_ref") {
          ensureField(shapeElement.expr.field);
          selectedColumns.add(shapeElement.expr.field);
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: elementPathId,
            expr: {
              kind: "field_ref",
              column: shapeElement.expr.field,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: elementPathId,
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
            pathId: elementPathId,
            expr: {
              kind: "polymorphic_field_ref",
              sourceType: normalizeTypeName(shapeElement.expr.sourceType, scopeModule),
              column: shapeElement.expr.field,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: elementPathId,
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        if (shapeElement.expr.kind === "type_name") {
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: elementPathId,
            expr: {
              kind: "type_name",
              sourceType: qualifiedName,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: elementPathId,
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
            pathId: elementPathId,
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
            pathId: elementPathId,
            expr: {
              kind: "function_call",
              functionName: resolved.qualifiedName,
              args: shapeElement.expr.call.args.map((arg) => compileFunctionArgInShape(arg, ensureField, selectedColumns)) as never,
            },
          });
          shapeNames.add(shapeElement.name);
          scopeChildren.push({
            pathId: elementPathId,
            typeName: qualifiedName,
            children: [],
          });
          continue;
        }

        shapeElements.push({
          kind: "computed",
          name: shapeElement.name,
          pathId: elementPathId,
          expr: {
            kind: "literal",
            value: shapeElement.expr.value,
          },
        });
        shapeNames.add(shapeElement.name);
        scopeChildren.push({
          pathId: elementPathId,
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
          pathId: elementPathId,
          sources,
        });
        shapeNames.add(shapeElement.name);
        scopeChildren.push({
          pathId: elementPathId,
          typeName: qualifiedName,
          children: [],
        });
        continue;
      }

      const linkPathId = createPathId(pathId);
      const relation = resolveForwardLink(typeDef, shapeElement.name);
      const normalizedTypeFilter = shapeElement.typeFilter ? normalizeTypeName(shapeElement.typeFilter, scopeModule) : undefined;
      const filteredTargetTables = normalizedTypeFilter
        ? relation.targetTables.filter((candidate) => isAssignableTo(candidate.name, normalizedTypeFilter))
        : relation.targetTables;

      if (normalizedTypeFilter && filteredTargetTables.length === 0) {
        fail(`Type filter '${normalizedTypeFilter}' is not compatible with link '${qualifiedName}.${shapeElement.name}'`);
      }

      const effectiveTargetType = normalizedTypeFilter ?? relation.targetType;
      const targetType = requireValue(
        schema.getType(effectiveTargetType),
        `Unknown link target type '${effectiveTargetType}' from '${qualifiedName}.${shapeElement.name}'`,
      );
      const nested = compileSelectForType(targetType, linkPathId, shapeElement.shape, shapeElement.clauses, {
        allowBacklinkFilter: false,
      });

      if (relation.storage === "inline") {
        selectedColumns.add(requireValue(relation.inlineColumn, `Missing inline storage metadata for '${shapeElement.name}'`));
      }

      shapeElements.push({
        kind: "link",
        name: shapeElement.name,
        pathId: linkPathId,
        relation: {
          ...relation,
          targetType: effectiveTargetType,
          targetTable: tableNameForType(effectiveTargetType),
          targetTables: filteredTargetTables,
        },
        typeFilter: normalizedTypeFilter,
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
        })
      : undefined;

    if (clauses.orderBy) {
      ensureField(clauses.orderBy.field);
    }

    if (clauses.limit !== undefined && clauses.limit < 0) {
      fail("Limit must be zero or greater");
    }

    if (clauses.offset !== undefined && clauses.offset < 0) {
      fail("Offset must be zero or greater");
    }

    return {
      pathId,
      sourceType: qualifiedName,
      typeRef: {
        name: qualifiedName,
        table,
      },
      table,
      sourceTables,
      columns: [...selectedColumns],
      shape: shapeElements,
      scopeTree: {
        pathId,
        typeName: qualifiedName,
        children: scopeChildren,
      },
      appliedOverlays: (context.overlays ?? []).filter((overlay) => overlay.table === table),
      filter: resolvedFilter,
      orderBy: clauses.orderBy
        ? {
            column: clauses.orderBy.field,
            direction: clauses.orderBy.direction,
          }
        : undefined,
      limit: clauses.limit,
      offset: clauses.offset,
      inference: inferSelect(
        isDirectIdEqualityFilter(resolvedFilter),
        clauses.limit,
        selectedColumns,
      ),
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
    clauses: {
      filter?: SelectStatement["filter"];
      orderBy?: SelectStatement["orderBy"];
      limit?: SelectStatement["limit"];
      offset?: SelectStatement["offset"];
    };
  } => {
    const resolvedTypeName = normalizeTypeName(selectStatement.typeName, activeModule);
    const directType = schema.getType(resolvedTypeName);
    if (directType) {
      return {
        typeDef: directType,
        clauses: {
          filter: selectStatement.filter,
          orderBy: selectStatement.orderBy,
          limit: selectStatement.limit,
          offset: selectStatement.offset,
        },
      };
    }

    const withBinding = withBindings.get(selectStatement.typeName);
    if (withBinding?.kind !== "subquery") {
      fail(`Unknown type '${resolvedTypeName}'`);
    }
    const withQuery = (withBinding as Extract<NonNullable<SelectStatement["with"]>[number]["value"], { kind: "subquery" }>).query;

    const sourceType = requireValue(
      schema.getType(normalizeTypeName(withQuery.typeName, activeModule)),
      `Unknown type '${normalizeTypeName(withQuery.typeName, activeModule)}' in with binding '${selectStatement.typeName}'`,
    );

    return {
      typeDef: sourceType,
      clauses: {
        filter: mergeFilters(withQuery.clauses.filter, selectStatement.filter),
        orderBy: selectStatement.orderBy ?? withQuery.clauses.orderBy,
        limit: selectStatement.limit ?? withQuery.clauses.limit,
        offset: selectStatement.offset ?? withQuery.clauses.offset,
      },
    };
  };

  if (statement.kind === "select_free") {
    const pathId = createPathId();
    const names = new Set<string>();
    const entries = statement.entries.map((entry) => {
      if (names.has(entry.name)) {
        fail(`Duplicate free object field '${entry.name}'`);
      }
      names.add(entry.name);

      if (entry.expr.kind === "literal") {
        return {
          kind: "literal" as const,
          name: entry.name,
          value: entry.expr.value,
        };
      }

      if (entry.expr.kind === "set_literal") {
        return {
          kind: "set_literal" as const,
          name: entry.name,
          values: [...entry.expr.values],
        };
      }

      if (entry.expr.kind === "function_call") {
        const resolved = resolveFunctionOrFail(entry.expr.call.name, entry.expr.call.args.length);
        return {
          kind: "function_call" as const,
          name: entry.name,
          functionName: resolved.qualifiedName,
          args: entry.expr.call.args.map((arg) => compileFunctionArgInFreeObject(arg)) as never,
        };
      }

      const nestedType = requireValue(
        schema.getType(normalizeTypeName(entry.expr.typeName, activeModule)),
        `Unknown type '${normalizeTypeName(entry.expr.typeName, activeModule)}'`,
      );
      const nestedPath = createPathId(pathId);
      const nested = compileSelectForType(
        nestedType,
        nestedPath,
        entry.expr.shape,
        {
          filter: entry.expr.clauses.filter,
          orderBy: entry.expr.clauses.orderBy,
          limit: entry.expr.clauses.limit,
          offset: entry.expr.clauses.offset,
        },
        { allowBacklinkFilter: true },
      );

      return {
        kind: "select" as const,
        name: entry.name,
        query: {
          kind: "select" as const,
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
    });

    return {
      kind: "select_free",
      pathId,
      entries,
    };
  }

  const resolvedRootType = statement.kind === "select"
    ? resolveSelectSource(statement)
    : {
        typeDef: requireValue(
          schema.getType(normalizeTypeName(statement.typeName, activeModule)),
          `Unknown type '${normalizeTypeName(statement.typeName, activeModule)}'`,
        ),
        clauses: {
          filter: undefined,
          orderBy: undefined,
          limit: undefined,
          offset: undefined,
        },
      };
  const typeDef = resolvedRootType.typeDef;
  const table = tableNameForType(qualifiedTypeName(typeDef));
  const userFields = typeDef.fields.filter((field) => field.name !== "id");
  const knownFields = new Set(["id", ...userFields.map((f) => f.name)]);
  const fieldByName = new Map([
    ["id", { name: "id", type: "uuid" as const, required: true }],
    ...userFields.map((field) => [field.name, field] as const),
  ]);

  const ensureField = (fieldName: string): void => {
    if (!knownFields.has(fieldName)) {
      fail(`Unknown field '${fieldName}' on '${statement.typeName}'`);
    }
  };

  const validateFieldValue = (fieldName: string, value: ScalarValue): void => {
    ensureField(fieldName);
    const field = requireValue(fieldByName.get(fieldName), `Unknown field '${fieldName}' on '${statement.typeName}'`);

    if (!isValidScalarValue(field.type, value)) {
      fail(`Type mismatch for '${fieldName}': expected ${field.type}`);
    }
  };

  if (statement.kind === "select") {
    const rootPathId = createPathId();
    const compiled = compileSelectForType(typeDef, rootPathId, statement.shape, {
      filter: resolvedRootType.clauses.filter,
      orderBy: resolvedRootType.clauses.orderBy,
      limit: resolvedRootType.clauses.limit,
      offset: resolvedRootType.clauses.offset,
    }, { allowBacklinkFilter: true });

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

      fail(`Unsupported insert expression for link '${linkName}'`);
    };

    for (const [field, value] of Object.entries(statement.values)) {
      if (field === "id") {
        fail("'id' is server-generated and cannot be assigned");
      }

      if (knownFields.has(field)) {
        const scalar = resolveInsertScalarValue(value);
        validateFieldValue(field, scalar);
        scalarValues[field] = scalar;
        continue;
      }

      if (linkByName.has(field)) {
        validateInsertLinkExpr(field, value);
        continue;
      }

      fail(`Unknown field '${field}' on '${statement.typeName}'`);
    }

    for (const field of userFields) {
      if (field.required && !(field.name in scalarValues)) {
        fail(`Missing required field '${field.name}'`);
      }
    }

    return {
      kind: "insert",
      pathId,
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
        validateFieldValue(predicateFilter.target.field, resolveFilterValue(predicateFilter.value));
      }
    }

    const updateFields = Object.entries(statement.values);
    if (updateFields.length === 0) {
      fail("Update requires at least one field assignment");
    }

    for (const [field, value] of updateFields) {
      if (field === "id") {
        fail("'id' is server-generated and cannot be assigned");
      }
      validateFieldValue(field, value);
    }

    return {
      kind: "update",
      pathId,
      table,
      filter: predicateFilter
        ? {
            column: predicateFilter.target.field,
            value: resolveFilterValue(predicateFilter.value),
          }
        : undefined,
      values: statement.values,
      overlays: [
        {
          table,
          sourcePathId: pathId,
          operation: "replace",
          policyPhase: "none",
          rewritePhase: "none",
        },
      ],
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
      validateFieldValue(deletePredicateFilter.target.field, resolveFilterValue(deletePredicateFilter.value));
    }
  }

  const pathId = createPathId();
  return {
    kind: "delete",
    pathId,
    table,
    filter: deletePredicateFilter
      ? {
          column: deletePredicateFilter.target.field,
          value: resolveFilterValue(deletePredicateFilter.value),
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

const isValidScalarValue = (type: ScalarType, value: ScalarValue): boolean => {
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
      if (typeof value !== "string") {
        return false;
      }

      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
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
