import { AppError } from "../errors.js";
import type {
  Statement as EdgeQLStatement,
  ComputedExpr,
  FreeObjectExpr,
  SelectStatement,
  SelectFreeStatement,
  InsertStatement,
  UpdateStatement,
  DeleteStatement,
  ForStatement,
  ConfigureStatement,
  ShapeElement as EdgeQLShapeElement,
  InsertValue,
  WithBinding,
  FilterExpr,
  FilterTarget,
  FilterValue,
  PathStep as EdgeQLPathStep,
} from "../edgeql/ast.js";
import type {
  Cardinality,
  CallArg,
  CoalesceExpr,
  BaseConstant,
  Global,
  IfElseExpr,
  Multiplicity,
  OperatorCall,
  Param,
  PathId,
  ScopeTreeNode,
  SelectStmt,
  Set,
  SortExpr,
  Statement,
  InsertStmt,
  UpdateStmt,
  DeleteStmt,
  ConfigStmt,
  ForExpr,
  Pointer,
  PointerRef,
  ShapeElement,
  TypeRef,
  TypeRoot,
  Volatility,
} from "../ir/gel_ir.js";
import type { FieldDef, LinkDef, ScalarType, TypeDef } from "../types.js";
import { qualifiedTypeName, type SchemaSnapshot } from "../schema/schema.js";
import type { GeneratedSchema, GeneratedSchemaType } from "../codegen/schema.js";
import { resolveSchemaModelForCompile } from "../codegen/schema_loader.js";

export interface IRCompileOptions {
  module?: string;
  schema?: SchemaSnapshot;
  schemaModel?: GeneratedSchema;
  schemaModelName?: string;
}

export interface IRCompileContext {
  module: string;
  schema?: SchemaSnapshot;
  schemaModel?: GeneratedSchema;
  nextScopeId: number;
  params: Map<string, Param>;
  globals: Map<string, Global>;
  bindingScopes: Map<string, Set>[];
}

const defaultCardinality: Cardinality = "unknown";
const defaultMultiplicity: Multiplicity = "unknown";
const defaultVolatility: Volatility = "stable";

const scalarToStdName = (scalar: ScalarType): string => {
  switch (scalar) {
    case "str":
      return "std::str";
    case "int":
      return "std::int64";
    case "float":
      return "std::float64";
    case "bool":
      return "std::bool";
    case "json":
      return "std::json";
    case "datetime":
      return "std::datetime";
    case "duration":
      return "std::duration";
    case "local_datetime":
      return "cal::local_datetime";
    case "local_date":
      return "cal::local_date";
    case "local_time":
      return "cal::local_time";
    case "relative_duration":
      return "cal::relative_duration";
    case "date_duration":
      return "cal::date_duration";
    case "uuid":
      return "std::uuid";
    default:
      return "std::anyscalar";
  }
};

const getSchemaTypeByQualifiedName = (ctx: IRCompileContext, qualifiedName: string): TypeDef | undefined => {
  const modelType = ctx.schemaModel?.typesByName[qualifiedName];
  if (modelType) {
    return {
      name: modelType.name,
      module: modelType.module,
      abstract: modelType.abstract,
      extends: [...modelType.extends],
      fields: modelType.fields.map((field) => ({ ...field })),
      links: modelType.links.map((link) => ({ ...link })),
    };
  }
  return ctx.schema?.getType(qualifiedName);
};

const getResolvedSchemaType = (ctx: IRCompileContext, qualifiedName: string): GeneratedSchemaType | undefined => {
  return ctx.schemaModel?.typesByName[qualifiedName];
};

const listSchemaTypeDefs = (ctx: IRCompileContext): TypeDef[] => {
  if (ctx.schemaModel) {
    return ctx.schemaModel.typeNames
      .map((name) => ctx.schemaModel?.typesByName[name])
      .filter((entry): entry is GeneratedSchemaType => !!entry)
      .map((entry) => ({
        name: entry.name,
        module: entry.module,
        abstract: entry.abstract,
        extends: [...entry.extends],
        fields: entry.fields.map((field) => ({ ...field })),
        links: entry.links.map((link) => ({ ...link })),
      }));
  }
  return ctx.schema ? ctx.schema.listTypes() : [];
};

const qualifyTypeName = (name: string, moduleName: string): string => (name.includes("::") ? name : `${moduleName}::${name}`);

const getSchemaType = (ctx: IRCompileContext, name: string): TypeDef | undefined => {
  if (!ctx.schema && !ctx.schemaModel) {
    return undefined;
  }
  const qualified = qualifyTypeName(name, ctx.module);
  return getSchemaTypeByQualifiedName(ctx, qualified)
    ?? getSchemaTypeByQualifiedName(ctx, name)
    ?? getSchemaTypeByQualifiedName(ctx, `default::${name}`);
};

const collectDerivedTypes = (ctx: IRCompileContext, baseQualified: string): TypeDef[] => {
  const allTypes = listSchemaTypeDefs(ctx);
  const queue = [baseQualified];
  const seen = new globalThis.Set<string>();
  const derived: TypeDef[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    for (const candidate of allTypes) {
      const candidateQualified = qualifyTypeName(candidate.name, candidate.module ?? "default");
      if (seen.has(candidateQualified) || candidateQualified === current) {
        continue;
      }
      const extendsCurrent = (candidate.extends ?? []).some((base) => {
        const qualifiedBase = qualifyTypeName(base, candidate.module ?? "default");
        return qualifiedBase === current || base === current;
      });
      if (!extendsCurrent) {
        continue;
      }
      seen.add(candidateQualified);
      derived.push(candidate);
      queue.push(candidateQualified);
    }
  }

  return derived;
};

const typeRefFromTypeDef = (ctx: IRCompileContext, typeDef: TypeDef, seen: globalThis.Set<string> = new globalThis.Set<string>()): TypeRef => {
  const qualified = qualifiedTypeName(typeDef);
  const typeRef: TypeRef = {
    kind: "type_ref",
    id: qualified,
    nameHint: qualified,
    module: typeDef.module ?? "default",
    isView: false,
    isScalar: false,
    isAbstract: Boolean(typeDef.abstract),
    inSchema: true,
  };

  if (seen.has(qualified)) {
    return typeRef;
  }

  const nextSeen = new globalThis.Set(seen);
  nextSeen.add(qualified);
  const resolved = getResolvedSchemaType(ctx, qualified);
  const children = resolved
    ? resolved.concreteSubtypes
      .map((name) => getSchemaTypeByQualifiedName(ctx, name))
      .filter((candidate): candidate is TypeDef => !!candidate)
      .map((candidate) => typeRefFromTypeDef(ctx, candidate, nextSeen))
    : collectDerivedTypes(ctx, qualified)
      .map((candidate) => typeRefFromTypeDef(ctx, candidate, nextSeen));
  if (children.length > 0) {
    typeRef.children = children;
  }
  return typeRef;
};

const scalarTypeRef = (scalar: ScalarType): TypeRef => {
  const qualified = scalarToStdName(scalar);
  const [moduleName, typeName] = qualified.split("::");
  return {
    kind: "type_ref",
    id: qualified,
    nameHint: qualified,
    module: moduleName ?? "std",
    isView: false,
    isScalar: true,
    isAbstract: false,
    inSchema: true,
    collection: typeName === "array" || typeName === "tuple" ? typeName : undefined,
  };
};

const resolveTypeRef = (ctx: IRCompileContext, name: string): TypeRef => {
  const typeDef = getSchemaType(ctx, name);
  if (typeDef) {
    return typeRefFromTypeDef(ctx, typeDef);
  }
  if (isUniversalObjectRefName(name)) {
    return universalObjectTypeRef(ctx, name);
  }
  return unknownTypeRef(qualifyTypeName(name, ctx.module));
};

const isUniversalObjectRefName = (name: string): boolean => {
  const last = name.includes("::") ? name.split("::").at(-1) : name;
  return last === "Object" || last === "BaseObject";
};

const universalObjectTypeRef = (ctx: IRCompileContext, name: string): TypeRef => {
  const last = name.includes("::") ? (name.split("::").at(-1) ?? name) : name;
  const qualified = name.includes("::") ? name : `std::${last}`;
  const children = listSchemaTypeDefs(ctx)
    .filter((candidate) => !candidate.abstract)
    .map((candidate) => typeRefFromTypeDef(ctx, candidate));
  const typeRef: TypeRef = {
    kind: "type_ref",
    id: qualified,
    nameHint: qualified,
    module: qualified.split("::")[0] ?? "std",
    isView: false,
    isScalar: false,
    isAbstract: true,
    inSchema: true,
  };
  if (children.length > 0) {
    typeRef.children = children;
  }
  return typeRef;
};

const pointerRefFromField = (source: TypeRef, field: FieldDef): PointerRef => ({
  kind: "pointer_ref",
  id: `${source.id}.field::${field.name}`,
  name: field.name,
  shortName: field.name,
  outSource: source,
  outTarget: scalarTypeRef(field.type),
  outCardinality: field.required ? "one" : "at_most_one",
  inCardinality: "many",
  isComputed: false,
  isIdPointer: field.name === "id",
  isLinkProperty: false,
  hasProperties: false,
});

const pointerRefFromLink = (source: TypeRef, target: TypeRef, link: LinkDef): PointerRef => ({
  kind: "pointer_ref",
  id: `${source.id}.link::${link.name}`,
  name: link.name,
  shortName: link.name,
  outSource: source,
  outTarget: target,
  outCardinality: link.multi ? "many" : "at_most_one",
  inCardinality: "many",
  isComputed: false,
  isIdPointer: false,
  isLinkProperty: false,
  hasProperties: (link.properties?.length ?? 0) > 0,
});

const mkCallArg = (expr: Set): CallArg => ({
  kind: "call_arg",
  expr,
  cardinality: "unknown",
  multiplicity: "unknown",
  isDefault: false,
  paramTypemod: "singleton",
  polymorphism: "not_used",
});

const createRootScope = (): ScopeTreeNode => ({
  kind: "scope_tree_node",
  uniqueId: 1,
  children: [],
  namespaces: [],
  fenced: false,
  optional: false,
});

const unknownTypeRef = (nameHint: string): TypeRef => ({
  kind: "type_ref",
  id: `unknown:${nameHint}`,
  nameHint,
  module: nameHint.includes("::") ? nameHint.split("::")[0]! : "default",
  isView: false,
  isScalar: false,
  isAbstract: false,
});

const defaultPathId = (name: string): PathId => ({
  kind: "path_id",
  namespace: [],
  isPointerPath: false,
  steps: [
    {
      type: unknownTypeRef(name),
    },
  ],
});

const setFromTypeRoot = (typeref: TypeRef): Set => ({
  kind: "set",
  expr: {
    kind: "type_root",
    typeref,
    skipSubtypes: false,
    isCachedGlobal: false,
  } as TypeRoot,
  pathId: {
    kind: "path_id",
    namespace: [],
    isPointerPath: false,
    steps: [{ type: typeref }],
  },
  typeref,
  shape: [],
  isBinding: false,
  isMaterializedRef: false,
  isSchemaAlias: false,
});

const extendPathSet = (source: Set, ptrref: PointerRef): Set => ({
  kind: "set",
  expr: {
    kind: "pointer",
    source,
    ptrref,
    direction: "outbound",
    isDefinition: false,
  } as Pointer,
  pathId: {
    kind: "path_id",
    namespace: source.pathId?.namespace ?? [],
    isPointerPath: true,
    steps: [...(source.pathId?.steps ?? [{ type: source.typeref }]), { type: ptrref.outTarget, pointer: ptrref }],
  },
  typeref: ptrref.outTarget,
  shape: [],
  isBinding: false,
  isMaterializedRef: false,
  isSchemaAlias: false,
});

const extendPathSetDirectional = (source: Set, ptrref: PointerRef, direction: "outbound" | "inbound"): Set => {
  const resultType = direction === "outbound" ? ptrref.outTarget : ptrref.outSource;
  return {
    kind: "set",
    expr: {
      kind: "pointer",
      source,
      ptrref,
      direction,
      isDefinition: false,
    } as Pointer,
    pathId: {
      kind: "path_id",
      namespace: source.pathId?.namespace ?? [],
      isPointerPath: true,
      steps: [...(source.pathId?.steps ?? [{ type: source.typeref }]), { type: resultType, pointer: ptrref }],
    },
    typeref: resultType,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

const containsSubSelect = (expr: FreeObjectExpr): boolean => {
  if (!expr || typeof expr !== "object") return false;
  if (expr.kind === "select_expr_subquery") return true;
  if (expr.kind === "field_access") return containsSubSelect(expr.expr);
  if (expr.kind === "cast") return containsSubSelect(expr.expr);
  if (expr.kind === "exists" || expr.kind === "not") return containsSubSelect((expr as { expr: FreeObjectExpr }).expr);
  if (expr.kind === "index_access") return containsSubSelect(expr.expr);
  return false;
};

const shapeRequestsLinkProperty = (shape: EdgeQLShapeElement[]): boolean => {
  for (const el of shape) {
    if (el.kind === "field" && el.name.startsWith("@")) return true;
    if (el.kind === "computed") {
      if (el.name.startsWith("@")) return true;
      if (el.expr.kind === "field_ref" && el.expr.field.startsWith("@")) return true;
    }
  }
  return false;
};

const validateShapeProjectionLinkPropContext = (expr: Extract<FreeObjectExpr, { kind: "shape_projection" }>): void => {
  if (!shapeRequestsLinkProperty(expr.shape)) return;
  if (containsSubSelect(expr.expr)) {
    throw new AppError(
      "E_SEMANTIC",
      "implicit reference to an object changes the interpretation of it elsewhere in the query",
      1,
      1,
    );
  }
};

const resolvePointerRef = (ctx: IRCompileContext, source: TypeRef, field: string): PointerRef | undefined => {
  const sourceType = getResolvedSchemaType(ctx, source.id);
  if (sourceType) {
    const schemaField = sourceType.resolvedFields.find((candidate) => candidate.name === field);
    if (schemaField) {
      return pointerRefFromField(source, schemaField);
    }
    const schemaLink = sourceType.resolvedLinks.find((candidate) => candidate.name === field);
    if (schemaLink) {
      const target = resolveTypeRef(ctx, schemaLink.targetType);
      return pointerRefFromLink(source, target, schemaLink);
    }
    const schemaComputed = ctx.schema?.getType(source.id)?.computeds?.find((candidate) => candidate.kind === "link" && candidate.name === field);
    if (schemaComputed?.kind === "link" && schemaComputed.expr.kind === "backlink") {
      const backlink = resolveBacklinkPointerRef(ctx, source, schemaComputed.expr.link, schemaComputed.expr.sourceType);
      return backlink ? { ...backlink, computedLinkAliasIsBackward: true } : undefined;
    }
    return undefined;
  }

  const sourceTypeDef = ctx.schema?.getType(source.id);
  if (!sourceTypeDef) {
    return undefined;
  }

  const findFieldOrLink = (typeName: string, seen = new Set<string>()): { kind: "field"; field: FieldDef } | { kind: "link"; link: LinkDef } | undefined => {
    if (!ctx.schema || seen.has(typeName)) {
      return undefined;
    }
    seen.add(typeName);
    const typeDef = ctx.schema.getType(typeName);
    if (!typeDef) {
      return undefined;
    }

    const directField = typeDef.fields.find((candidate) => candidate.name === field);
    if (directField) {
      return { kind: "field", field: directField };
    }
    const directLink = (typeDef.links ?? []).find((candidate) => candidate.name === field);
    if (directLink) {
      return { kind: "link", link: directLink };
    }

    for (const baseName of typeDef.extends ?? []) {
      const inherited = findFieldOrLink(baseName, seen);
      if (inherited) {
        return inherited;
      }
    }
    return undefined;
  };

  const resolved = findFieldOrLink(source.id);
  if (resolved?.kind === "field") {
    return pointerRefFromField(source, resolved.field);
  }
  if (resolved?.kind === "link") {
    const target = resolveTypeRef(ctx, resolved.link.targetType);
    return pointerRefFromLink(source, target, resolved.link);
  }
  const computed = sourceTypeDef.computeds?.find((candidate) => candidate.kind === "link" && candidate.name === field);
  if (computed?.kind === "link" && computed.expr.kind === "backlink") {
    const backlink = resolveBacklinkPointerRef(ctx, source, computed.expr.link, computed.expr.sourceType);
    return backlink ? { ...backlink, computedLinkAliasIsBackward: true } : undefined;
  }
  return undefined;
};

const resolveBacklinkPointerRef = (
  ctx: IRCompileContext,
  target: TypeRef,
  linkName: string,
  sourceTypeName?: string,
): PointerRef | undefined => {
  if (!ctx.schema && !ctx.schemaModel) {
    return undefined;
  }
  const sourceHint = sourceTypeName ? resolveTypeRef(ctx, sourceTypeName).id : undefined;
  for (const typeDef of listSchemaTypeDefs(ctx)) {
    const sourceRef = typeRefFromTypeDef(ctx, typeDef);
    if (sourceHint && sourceRef.id !== sourceHint) {
      continue;
    }
    const link = (typeDef.links ?? []).find((candidate) => candidate.name === linkName);
    if (!link) {
      continue;
    }
    const linkTarget = resolveTypeRef(ctx, link.targetType);
    if (linkTarget.id !== target.id) {
      continue;
    }
    return pointerRefFromLink(sourceRef, linkTarget, link);
  }
  return undefined;
};

const compilePathSteps = (steps: EdgeQLPathStep[], ctx: IRCompileContext): Set => {
  if (steps.length === 0) {
    return literalToSet(null);
  }
  const first = steps[0];
  if (!first || first.kind !== "object_ref") {
    return literalToSet(null);
  }
  if (!resolveBinding(ctx, first.name)) {
    const enumType = lookupEnumScalar(ctx, first.name);
    if (enumType) {
      const rest = steps.slice(1);
      const memberStep = rest.find((step) => step.kind === "ptr");
      if (!memberStep || memberStep.kind !== "ptr") {
        failSemantic(`enum path expression lacks an enum member name, as in '${first.name}.${enumType.members[0]}'`);
      }
      const ptrSteps = rest.filter((step) => step.kind === "ptr");
      if (ptrSteps.length > 1) {
        failSemantic(`invalid property reference on an expression of primitive type`);
      }
      return resolvePathToEnumLiteral(ctx, first.name, (memberStep as { kind: "ptr"; name: string }).name) ?? literalToSet(null);
    }
  }
  let out = resolveBinding(ctx, first.name) ?? setFromTypeRoot(resolveTypeRef(ctx, first.name));
  for (const step of steps.slice(1)) {
    if (step.kind === "ptr") {
      const ptrref = resolvePointerRef(ctx, out.typeref, step.name);
      if (!ptrref) {
        return { ...out, pathId: defaultPathId("path_steps") };
      }
      out = extendPathSetDirectional(out, ptrref, step.direction ?? "outbound");
      if (step.optional) {
        out = {
          ...out,
          expr: {
            ...(out.expr as Pointer),
            optionalDeref: true,
          },
        };
      }
      continue;
    }
    if (step.kind === "type_intersection") {
      out = {
        ...out,
        typeref: resolveTypeRef(ctx, step.typeName),
      };
      continue;
    }
    if (step.kind === "splat") {
      continue;
    }
  }
  return out;
};

const childScope = (ctx: IRCompileContext): IRCompileContext => ({
  ...ctx,
  bindingScopes: [...ctx.bindingScopes, new Map<string, Set>()],
});

const bindValue = (ctx: IRCompileContext, name: string, value: Set): void => {
  const current = ctx.bindingScopes[ctx.bindingScopes.length - 1];
  if (!current) {
    return;
  }
  current.set(name, value);
};

const resolveBinding = (ctx: IRCompileContext, name: string): Set | undefined => {
  for (let index = ctx.bindingScopes.length - 1; index >= 0; index -= 1) {
    const scope = ctx.bindingScopes[index];
    const value = scope?.get(name);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const withBindings = (ctx: IRCompileContext, bindings: WithBinding[] | undefined): IRCompileContext => {
  if (!bindings?.length) {
    return ctx;
  }
  const scoped = childScope(ctx);
  for (const binding of bindings) {
    let set: Set;
    switch (binding.value.kind) {
      case "literal":
        set = literalToSet(binding.value.value);
        break;
      case "set_literal":
        set = literalToSet(binding.value.values.length);
        break;
      case "array_literal":
        set = literalToSet(binding.value.values.length);
        break;
      case "parameter":
        set = compileFreeObjectExpr({ kind: "parameter", name: binding.value.name, castType: binding.value.castType }, scoped);
        break;
      case "binding_ref":
        set = resolveBinding(scoped, binding.value.name) ?? compileFreeObjectExpr({ kind: "binding_ref", name: binding.value.name }, scoped);
        break;
      case "path":
        set = compileFreeObjectExpr({ kind: "path", head: binding.value.head, tail: binding.value.tail }, scoped);
        break;
      case "path_chain":
        set = compileFreeObjectExpr({ kind: "path_chain", parts: binding.value.parts }, scoped);
        break;
      case "enum_path":
        set = literalToSet(binding.value.member);
        break;
      case "subquery":
        set = setFromTypeRoot(resolveTypeRef(scoped, binding.value.query.typeName));
        break;
      case "subquery_expr":
        set = compileFreeObjectExpr(binding.value.expr, scoped);
        break;
      case "backlink_path":
        set = setFromTypeRoot(resolveTypeRef(scoped, binding.value.head));
        break;
      default:
        set = literalToSet(null);
        break;
    }
    bindValue(scoped, binding.name, set);
  }
  return scoped;
};

const literalToSet = (value: string | number | boolean | null): Set => ({
  kind: "set",
  expr: {
    kind:
      typeof value === "string"
        ? "string_constant"
        : typeof value === "boolean"
          ? "boolean_constant"
          : typeof value === "number"
            ? Number.isInteger(value)
              ? "integer_constant"
              : "float_constant"
            : "string_constant",
    value,
  } as BaseConstant,
  pathId: defaultPathId("std::anyscalar"),
  typeref: unknownTypeRef("std::anyscalar"),
  shape: [],
  isBinding: false,
  isMaterializedRef: false,
  isSchemaAlias: false,
});

const compileSetConstructor = (values: Set[], label: string): Set => {
  if (values.length === 0) {
    return literalToSet(null);
  }
  if (values.length === 1) {
    return values[0]!;
  }
  const first = values[0]!;
  return {
    kind: "set",
    expr: {
      kind: "operator_call",
      operator: "union",
      args: Object.fromEntries(values.map((value, index) => [String(index), mkCallArg(value)])),
      returning: first.typeref,
      volatility: "immutable",
    } as OperatorCall,
    pathId: defaultPathId(label),
    typeref: first.typeref,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

const failSemantic = (message: string): never => {
  throw new AppError("E_SEMANTIC", message, 1, 1);
};

const enumValuesOfTypeDef = (typeDef: TypeDef | undefined): string[] | undefined => {
  if (!typeDef) return undefined;
  const first = typeDef.fields[0];
  if (typeDef.fields.length === 1 && first?.name === "__enum__" && first.enumValues && first.enumValues.length > 0) {
    return first.enumValues;
  }
  return undefined;
};

const lookupEnumScalar = (ctx: IRCompileContext, name: string): { qualifiedName: string; members: string[] } | undefined => {
  const typeDef = getSchemaType(ctx, name);
  const members = enumValuesOfTypeDef(typeDef);
  if (!typeDef || !members) return undefined;
  return { qualifiedName: qualifiedTypeName(typeDef), members };
};

const enumLiteralSet = (member: string): Set => literalToSet(member);

const resolvePathToEnumLiteral = (ctx: IRCompileContext, head: string, tail: string | undefined): Set | undefined => {
  const enumType = lookupEnumScalar(ctx, head);
  if (!enumType) return undefined;
  if (tail === undefined) {
    failSemantic(`enum path expression lacks an enum member name, as in '${head}.${enumType.members[0]}'`);
  }
  if (!enumType.members.includes(tail!)) {
    failSemantic(`enum '${enumType.qualifiedName}' has no member called '${tail}'`);
  }
  return enumLiteralSet(tail!);
};

const jsonEncodeString = (value: string): string => JSON.stringify(JSON.stringify(value));

const tryExtractStringConstant = (set: Set): string | undefined => {
  const expr = set.expr as { kind: string; value?: unknown };
  if (expr.kind === "string_constant" && typeof expr.value === "string") {
    return expr.value;
  }
  return undefined;
};

const tryExtractAnyConstant = (set: Set): { value: unknown; kind: string } | undefined => {
  const expr = set.expr as { kind: string; value?: unknown };
  if (expr.kind.endsWith("_constant")) {
    return { value: expr.value, kind: expr.kind };
  }
  return undefined;
};

const jsonTypeNameForLiteral = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  return "object";
};

const tryExtractSetOfStringConstants = (set: Set): string[] | undefined => {
  const direct = tryExtractStringConstant(set);
  if (direct !== undefined) return [direct];
  const expr = set.expr as { kind: string; operator?: string; args?: Record<string, { expr: Set }> };
  if (expr.kind === "operator_call" && expr.operator === "union" && expr.args) {
    const values: string[] = [];
    for (const key of Object.keys(expr.args).sort((a, b) => Number(a) - Number(b))) {
      const inner = tryExtractStringConstant(expr.args[key]!.expr);
      if (inner === undefined) return undefined;
      values.push(inner);
    }
    return values;
  }
  return undefined;
};

const compileEnumCast = (
  ctx: IRCompileContext,
  enumQualifiedName: string,
  enumMembers: string[],
  inner: Set,
): Set => {
  const stringValues = tryExtractSetOfStringConstants(inner);
  if (stringValues !== undefined) {
    const validated = stringValues.map((value) => {
      if (!enumMembers.includes(value)) {
        failSemantic(`invalid input value for enum '${enumQualifiedName}': "${value}"`);
      }
      return enumLiteralSet(value);
    });
    return compileSetConstructor(validated, "enum_cast");
  }
  return inner;
};

const BUILTIN_SCALAR_NAMES: Record<string, string> = {
  str: "std::str",
  int: "std::int64",
  int16: "std::int16",
  int32: "std::int32",
  int64: "std::int64",
  float: "std::float64",
  float32: "std::float32",
  float64: "std::float64",
  bool: "std::bool",
  json: "std::json",
  datetime: "std::datetime",
  duration: "std::duration",
  uuid: "std::uuid",
  decimal: "std::decimal",
  bigint: "std::bigint",
  bytes: "std::bytes",
};

const normalizeScalarCastName = (ctx: IRCompileContext, name: string): string => {
  if (name.includes("::")) return name;
  if (BUILTIN_SCALAR_NAMES[name]) return BUILTIN_SCALAR_NAMES[name];
  const typeDef = getSchemaType(ctx, name);
  if (typeDef) return qualifiedTypeName(typeDef);
  return `${ctx.module}::${name}`;
};

const inferPropertyTypeName = (ctx: IRCompileContext, typeName: string, fieldName: string): string | undefined => {
  const typeDef = getSchemaType(ctx, typeName);
  if (!typeDef) return undefined;
  const field = typeDef.fields.find((f) => f.name === fieldName);
  if (!field) return undefined;
  if (field.enumTypeName) return field.enumTypeName;
  return BUILTIN_SCALAR_NAMES[field.type] ?? `std::${field.type}`;
};

const inferAstExprTypeName = (expr: FreeObjectExpr, ctx: IRCompileContext): string | undefined => {
  switch (expr.kind) {
    case "literal":
      if (typeof expr.value === "string") return "std::str";
      if (typeof expr.value === "boolean") return "std::bool";
      if (typeof expr.value === "number") return Number.isInteger(expr.value) ? "std::int64" : "std::float64";
      return undefined;
    case "cast":
      return normalizeScalarCastName(ctx, expr.castType);
    case "enum_path":
      return normalizeScalarCastName(ctx, expr.enumType);
    case "path": {
      const enumType = lookupEnumScalar(ctx, expr.head);
      if (enumType) return enumType.qualifiedName;
      return inferPropertyTypeName(ctx, expr.head, expr.tail);
    }
    case "path_chain": {
      const parts = expr.parts;
      if (parts.length < 1) return undefined;
      const enumType = lookupEnumScalar(ctx, parts[0]!);
      if (enumType) return enumType.qualifiedName;
      if (parts.length === 2) return inferPropertyTypeName(ctx, parts[0]!, parts[1]!);
      return undefined;
    }
    case "path_steps": {
      const first = expr.steps[0];
      if (!first || first.kind !== "object_ref") return undefined;
      const enumType = lookupEnumScalar(ctx, first.name);
      if (enumType) return enumType.qualifiedName;
      const ptrSteps = expr.steps.slice(1).filter((step) => step.kind === "ptr");
      if (ptrSteps.length === 1) {
        return inferPropertyTypeName(ctx, first.name, (ptrSteps[0] as { kind: "ptr"; name: string }).name);
      }
      return undefined;
    }
    case "binding_ref": {
      const enumType = lookupEnumScalar(ctx, expr.name);
      if (enumType) return enumType.qualifiedName;
      return undefined;
    }
    default:
      return undefined;
  }
};

const compileFreeObjectExpr = (expr: FreeObjectExpr | ComputedExpr, ctx: IRCompileContext): Set => {
  const resolveHeadSet = (name: string): Set => resolveBinding(ctx, name) ?? setFromTypeRoot(resolveTypeRef(ctx, name));

  switch (expr.kind) {
    case "set_literal": {
      return compileSetConstructor(expr.values.map((value) => literalToSet(value)), "set_literal");
    }

    case "set_expr": {
      return compileSetConstructor(expr.values.map((value) => compileFreeObjectExpr(value, ctx)), "set_expr");
    }

    case "current_item": {
      return resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__") ?? literalToSet(null);
    }

    case "distinct": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "distinct",
          args: { "0": mkCallArg(inner) },
          returning: inner.typeref,
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("distinct"),
        typeref: inner.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "binding_ref": {
      const bound = resolveBinding(ctx, expr.name);
      if (bound) {
        return bound;
      }
      const enumType = lookupEnumScalar(ctx, expr.name);
      if (enumType) {
        failSemantic(`enum path expression lacks an enum member name, as in '${expr.name}.${enumType.members[0]}'`);
      }
      const typeref = resolveTypeRef(ctx, expr.name);
      return setFromTypeRoot(typeref);
    }

    case "field_ref": {
      const bound = resolveBinding(ctx, expr.field);
      if (bound) {
        return bound;
      }
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      const ptrref = subject ? resolvePointerRef(ctx, subject.typeref, expr.field) : undefined;
      return subject && ptrref ? extendPathSet(subject, ptrref) : literalToSet(null);
    }

    case "polymorphic_field_ref": {
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      const narrowedSubject = subject
        ? { ...subject, typeref: resolveTypeRef(ctx, expr.sourceType) }
        : setFromTypeRoot(resolveTypeRef(ctx, expr.sourceType));
      const ptrref = resolvePointerRef(ctx, narrowedSubject.typeref, expr.field);
      return ptrref ? extendPathSet(narrowedSubject, ptrref) : literalToSet(null);
    }

    case "type_name": {
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      return literalToSet(subject?.typeref.id ?? null);
    }

    case "select": {
      const typeref = resolveTypeRef(ctx, expr.typeName);
      const root = setFromTypeRoot(typeref);
      const clauses = expr.clauses;
      const hasClauses = clauses && (
        clauses.filter !== undefined
        || clauses.orderBy !== undefined
        || clauses.limit !== undefined
        || clauses.offset !== undefined
      );
      if (!hasClauses) {
        return root;
      }
      const where = clauses?.filter ? compileFilterExpr(clauses.filter, root, ctx) : undefined;
      return {
        kind: "set",
        expr: {
          kind: "select_expr",
          result: root,
          where,
          orderBy: clauses?.orderBy
            ? [{
              kind: "sort_expr",
              path: clauses.orderBy.expr
                ? compileFreeObjectExpr(clauses.orderBy.expr, ctx)
                : compileFreeObjectExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__current__" }, field: clauses.orderBy.field, optional: false }, ctx),
              direction: clauses.orderBy.direction,
              nonesOrder: "last",
            }]
            : undefined,
          offset: clauses?.offset === undefined ? undefined : literalToSet(clauses.offset),
          limit: clauses?.limit === undefined ? undefined : literalToSet(clauses.limit),
          implicitWrapper: false,
        },
        pathId: defaultPathId(`select_with_clauses:${expr.typeName}`),
        typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "subquery": {
      return compileFreeObjectExpr({ kind: "select", typeName: expr.typeName, shape: expr.shape, clauses: expr.clauses }, ctx);
    }

    case "select_expr_subquery": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "select_expr",
          result: inner,
          where: expr.filter ? compileFreeObjectExpr(expr.filter, ctx) : undefined,
          orderBy: expr.orderBy
            ? [{ kind: "sort_expr", path: compileFreeObjectExpr(expr.orderBy.expr, ctx), direction: expr.orderBy.direction, nonesOrder: "last" }]
            : undefined,
          offset: expr.offset === undefined ? undefined : literalToSet(expr.offset),
          limit: expr.limit === undefined ? undefined : literalToSet(expr.limit),
          implicitWrapper: false,
        },
        pathId: defaultPathId("select_expr_subquery"),
        typeref: inner.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "path": {
      if (!resolveBinding(ctx, expr.head)) {
        const enumLiteral = resolvePathToEnumLiteral(ctx, expr.head, expr.tail);
        if (enumLiteral) return enumLiteral;
      }
      if (expr.steps?.length) {
        return compilePathSteps(expr.steps, ctx);
      }
      const headSet = resolveHeadSet(expr.head);
      const ptrref = resolvePointerRef(ctx, headSet.typeref, expr.tail);
      return ptrref ? extendPathSet(headSet, ptrref) : {
        ...headSet,
        pathId: defaultPathId(`${expr.head}.${expr.tail}`),
      };
    }

    case "path_chain": {
      if (!resolveBinding(ctx, expr.parts[0] ?? "")) {
        const headName = expr.parts[0];
        if (headName) {
          const enumType = lookupEnumScalar(ctx, headName);
          if (enumType) {
            if (expr.parts.length < 2) {
              failSemantic(`enum path expression lacks an enum member name, as in '${headName}.${enumType.members[0]}'`);
            }
            if (expr.parts.length > 2) {
              failSemantic(`invalid property reference on an expression of primitive type`);
            }
            return resolvePathToEnumLiteral(ctx, headName, expr.parts[1]) ?? literalToSet(null);
          }
        }
      }
      if (expr.steps?.length) {
        return compilePathSteps(expr.steps, ctx);
      }
      const [head, ...tail] = expr.parts;
      if (!head) {
        return literalToSet(null);
      }
      let out = resolveHeadSet(head);
      for (const field of tail) {
        const ptrref = resolvePointerRef(ctx, out.typeref, field);
        if (!ptrref) {
          return {
            ...out,
            pathId: defaultPathId(expr.parts.join(".")),
          };
        }
        out = extendPathSet(out, ptrref);
      }
      return out;
    }

    case "path_steps": {
      if (expr.steps.length === 0) {
        return literalToSet(null);
      }
      const [first, ...rest] = expr.steps;
      if (!first || first.kind !== "object_ref") {
        return literalToSet(null);
      }
      if (!resolveBinding(ctx, first.name)) {
        const enumType = lookupEnumScalar(ctx, first.name);
        if (enumType) {
          const memberStep = rest.find((step) => step.kind === "ptr");
          if (!memberStep || memberStep.kind !== "ptr") {
            failSemantic(`enum path expression lacks an enum member name, as in '${first.name}.${enumType.members[0]}'`);
          }
          const ptrSteps = rest.filter((step) => step.kind === "ptr");
          if (ptrSteps.length > 1) {
            failSemantic(`invalid property reference on an expression of primitive type`);
          }
          return resolvePathToEnumLiteral(ctx, first.name, (memberStep as { kind: "ptr"; name: string }).name) ?? literalToSet(null);
        }
      }
      let out = resolveHeadSet(first.name);
      for (const step of rest) {
        if (step.kind === "ptr") {
          const ptrref = resolvePointerRef(ctx, out.typeref, step.name);
          if (!ptrref) {
            return {
              ...out,
              pathId: defaultPathId(expr.steps.map((item) => (item.kind === "ptr" ? item.name : "*")).join(".")),
            };
          }
          out = extendPathSetDirectional(out, ptrref, step.direction ?? "outbound");
          continue;
        }
        if (step.kind === "type_intersection") {
          out = {
            ...out,
            typeref: resolveTypeRef(ctx, step.typeName),
          };
          continue;
        }
      }
      return out;
    }

    case "field_access": {
      const source = compileFreeObjectExpr(expr.expr, ctx);

      if (expr.field.startsWith("@") && source.expr.kind === "pointer") {
        const linkPointer = source.expr as Pointer;
        if (!linkPointer.ptrref.isLinkProperty) {
          const linkOwnerTypeRef = linkPointer.direction === "inbound"
            ? linkPointer.ptrref.outSource
            : linkPointer.source.typeref;
          const linkOwnerResolved = getResolvedSchemaType(ctx, linkOwnerTypeRef.id);
          const linkDef = linkOwnerResolved?.resolvedLinks.find((candidate) => candidate.name === linkPointer.ptrref.shortName);
          const propName = expr.field.slice(1);
          const propDef = linkDef?.properties?.find((property) => property.name === propName);
          if (propDef) {
            const propertyPtrRef: PointerRef = {
              kind: "pointer_ref",
              id: `${linkPointer.ptrref.id}.${expr.field}`,
              name: expr.field,
              shortName: expr.field,
              outSource: source.typeref,
              outTarget: scalarTypeRef(propDef.type),
              outCardinality: propDef.required ? "one" : "at_most_one",
              inCardinality: "many",
              isComputed: false,
              isLinkProperty: true,
              hasProperties: false,
            };
            return extendPathSet(source, propertyPtrRef);
          }
          if (linkDef) {
            throw new AppError(
              "E_SEMANTIC",
              `link '${linkPointer.ptrref.shortName}' has no property '${propName}'`,
              1,
              1,
            );
          }
        }
      }

      const ptrref = resolvePointerRef(ctx, source.typeref, expr.field);
      return ptrref ? (
        ptrref.computedLinkAliasIsBackward ? extendPathSetDirectional(source, ptrref, "inbound") : extendPathSet(source, ptrref)
      ) : {
        kind: "set",
        expr: {
          kind: "pointer",
          source,
          ptrref: {
            kind: "pointer_ref",
            id: `${source.typeref.id}.unknown::${expr.field}`,
            name: expr.field,
            shortName: expr.field,
            outSource: source.typeref,
            outTarget: unknownTypeRef("std::anytype"),
            outCardinality: "unknown",
            inCardinality: "unknown",
            isComputed: false,
            isLinkProperty: expr.field.startsWith("@"),
            hasProperties: false,
          },
          direction: "outbound",
          optionalDeref: expr.optional,
          isDefinition: false,
        } as Pointer,
        pathId: defaultPathId(`${source.typeref.id}.${expr.field}`),
        typeref: unknownTypeRef("std::anytype"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "backlink_path": {
      const subject = resolveBinding(ctx, "__subject__") ?? resolveBinding(ctx, "__current__");
      if (!subject) {
        return setFromTypeRoot(resolveTypeRef(ctx, expr.sourceType ?? "default::Object"));
      }
      const ptrref = resolveBacklinkPointerRef(ctx, subject.typeref, expr.link, expr.sourceType);
      if (!ptrref) {
        return setFromTypeRoot(resolveTypeRef(ctx, expr.sourceType ?? "default::Object"));
      }
      const out = extendPathSetDirectional(subject, ptrref, "inbound");
      if (expr.optional) {
        return {
          ...out,
          expr: {
            ...(out.expr as Pointer),
            optionalDeref: true,
          },
        };
      }
      return out;
    }

    case "exists": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "exists_expr",
          expr: inner,
        },
        pathId: defaultPathId("exists"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "index_access": {
      const source = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "index_expr",
          expr: source,
          index: literalToSet(expr.index),
        },
        pathId: defaultPathId("index_access"),
        typeref: unknownTypeRef("std::anytype"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "slice_access": {
      const source = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "slice_expr",
          expr: source,
          start: expr.start === undefined ? undefined : literalToSet(expr.start),
          end: expr.end === undefined ? undefined : literalToSet(expr.end),
        },
        pathId: defaultPathId("slice_access"),
        typeref: source.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "substitution": {
      const value = resolveBinding(ctx, expr.name);
      return value ?? literalToSet(null);
    }

    case "tuple": {
      const elements = expr.values.map((value, index) => ({ name: String(index), val: compileFreeObjectExpr(value, ctx) }));
      return {
        kind: "set",
        expr: {
          kind: "tuple",
          named: false,
          elements,
        },
        pathId: defaultPathId("tuple"),
        typeref: unknownTypeRef("std::tuple"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "free_object_constructor": {
      const elements = expr.entries.map((entry) => ({ name: entry.name, val: compileFreeObjectExpr(entry.expr, ctx) }));
      return {
        kind: "set",
        expr: {
          kind: "tuple",
          named: true,
          elements,
        },
        pathId: defaultPathId("free_object"),
        typeref: unknownTypeRef("std::tuple"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "concat": {
      const partTypes = expr.parts.map((part) => inferAstExprTypeName(part, ctx));
      const nonStrIndex = partTypes.findIndex((typeName) => typeName !== undefined && typeName !== "std::str");
      if (nonStrIndex >= 0) {
        const offenderType = partTypes[nonStrIndex]!;
        const otherType = partTypes.find((typeName, index) => index !== nonStrIndex && typeName !== undefined) ?? "std::str";
        const [leftType, rightType] = nonStrIndex === 0 ? [offenderType, otherType] : [otherType, offenderType];
        failSemantic(`operator '++' cannot be applied to operands of type '${leftType}' and '${rightType}'`);
      }
      const parts = expr.parts.map((part) => compileFreeObjectExpr(part, ctx));
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "++",
          args: Object.fromEntries(parts.map((part, index) => [String(index), mkCallArg(part)])),
          returning: unknownTypeRef("std::str"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("concat"),
        typeref: unknownTypeRef("std::str"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "is_type": {
      const left = compileFreeObjectExpr(expr.expr, ctx);
      const right = resolveTypeRef(ctx, expr.typeName);
      return {
        kind: "set",
        expr: {
          kind: "type_check_op",
          left,
          right,
          op: "is",
          typeref: unknownTypeRef("std::bool"),
        },
        pathId: defaultPathId("is_type"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "shape_projection": {
      validateShapeProjectionLinkPropContext(expr);
      const base = compileFreeObjectExpr(expr.expr, ctx);
      const projectedShape = compileShape(base, expr.shape, ctx);
      return {
        ...base,
        shape: projectedShape,
      };
    }

    case "and": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "and",
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("and"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "or": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "or",
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("or"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "not": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: "not",
          args: { "0": mkCallArg(inner) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("not"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "literal":
      return literalToSet(expr.value);

    case "parameter": {
      const typeref = unknownTypeRef(expr.castType ?? "std::anytype");
      if (!ctx.params.has(expr.name)) {
        ctx.params.set(expr.name, {
          kind: "param",
          name: expr.name,
          required: true,
          typeref,
          schemaType: expr.castType ?? "std::anytype",
        });
      }
      return {
        kind: "set",
        expr: {
          kind: "parameter",
          name: expr.name,
          required: true,
          typeref,
        },
        pathId: defaultPathId(`param:${expr.name}`),
        typeref,
        shape: [],
        isBinding: true,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "global_ref": {
      const typeref = unknownTypeRef("std::anytype");
      if (!ctx.globals.has(expr.name)) {
        ctx.globals.set(expr.name, {
          kind: "global",
          name: expr.name,
          required: false,
          hasPresentArg: false,
          typeref,
        });
      }
      return {
        kind: "set",
        expr: {
          kind: "global_expr",
          name: expr.name,
          typeref,
        },
        pathId: defaultPathId(`global:${expr.name}`),
        typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "function_call": {
      const args = expr.call.args.map((arg) => {
        if (arg && typeof arg === "object" && "kind" in arg) {
          if (arg.kind === "expr") {
            return compileFreeObjectExpr(arg.expr, ctx);
          }
          if (arg.kind === "parameter") {
            return compileFreeObjectExpr({ kind: "parameter", name: arg.name, castType: arg.castType }, ctx);
          }
          if (arg.kind === "literal") {
            return literalToSet(arg.value);
          }
          if (arg.kind === "field_ref") {
            return compileFreeObjectExpr({ kind: "binding_ref", name: arg.field }, ctx);
          }
        }
        return literalToSet(null);
      });
      return {
        kind: "set",
        expr: {
          kind: "function_call",
          functionName: expr.call.name,
          args: Object.fromEntries(args.map((arg, index) => [String(index), mkCallArg(arg)])),
          volatility: "stable",
          typeref: unknownTypeRef("std::anytype"),
          preservesUpperCardinality: false,
          extras: {
            backendName: expr.call.name,
            funcPolymorphic: false,
          },
        },
        pathId: defaultPathId(`fn:${expr.call.name}`),
        typeref: unknownTypeRef("std::anytype"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "coalesce": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "coalesce_expr",
          left,
          right,
        } as CoalesceExpr,
        pathId: defaultPathId("std::coalesce"),
        typeref: left.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "if_else": {
      const condition = compileFreeObjectExpr(expr.condition, ctx);
      const ifExpr = compileFreeObjectExpr(expr.thenExpr, ctx);
      const elseExpr = compileFreeObjectExpr(expr.elseExpr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "if_else_expr",
          condition,
          ifExpr,
          elseExpr,
        } as IfElseExpr,
        pathId: defaultPathId("std::if_else"),
        typeref: ifExpr.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "compare": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::compare"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "logical": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::logical"),
        typeref: unknownTypeRef("std::bool"),
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "unary": {
      // Fold `-NUMBER` / `+NUMBER` into a single numeric constant so
      // downstream SQL lowering doesn't need to handle an operator_call(neg).
      if (expr.op === "neg" && expr.expr.kind === "literal") {
        const value = expr.expr.value;
        if (typeof value === "number") {
          const folded = expr.op === "neg" ? -value : value;
          return compileFreeObjectExpr({ kind: "literal", value: folded } as typeof expr.expr, ctx);
        }
      }
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(inner) },
          returning: expr.op === "not" ? unknownTypeRef("std::bool") : inner.typeref,
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::unary"),
        typeref: expr.op === "not" ? unknownTypeRef("std::bool") : inner.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "math": {
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: left.typeref,
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::math"),
        typeref: left.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "for_expr": {
      if (
        expr.variable === "__gel_backlink_item__"
        && expr.body.kind === "backlink_path"
        && expr.iterator.kind === "binding_ref"
      ) {
        const enumType = lookupEnumScalar(ctx, expr.iterator.name);
        if (enumType) {
          failSemantic("enum types do not support backlink");
        }
      }
      const iterator = compileFreeObjectExpr(expr.iterator, ctx);
      const loopCtx = childScope(ctx);
      bindValue(loopCtx, expr.variable, iterator);
      const body = compileFreeObjectExpr(expr.body, loopCtx);
      return {
        kind: "set",
        expr: {
          kind: "for_expr",
          iterator,
          body,
          bindingKind: "with",
          optional: expr.optional ?? false,
          where: expr.filter ? compileFreeObjectExpr(expr.filter, loopCtx) : undefined,
          orderBy: expr.orderBy
            ? [{ kind: "sort_expr", path: compileFreeObjectExpr(expr.orderBy.expr, loopCtx), direction: expr.orderBy.direction, nonesOrder: "last" }]
            : undefined,
          offset: expr.offset === undefined ? undefined : literalToSet(expr.offset),
          limit: expr.limit === undefined ? undefined : literalToSet(expr.limit),
        } as ForExpr,
        pathId: defaultPathId(`for:${expr.variable}`),
        typeref: body.typeref,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "cast": {
      const innerExpr = expr.expr;
      const innerIsJsonCast = innerExpr.kind === "cast" && innerExpr.castType === "json";
      const enumTarget = lookupEnumScalar(ctx, expr.castType);

      if (enumTarget) {
        const sourceExpr = innerIsJsonCast ? (innerExpr as { kind: "cast"; castType: string; expr: FreeObjectExpr }).expr : innerExpr;
        const innerSet = compileFreeObjectExpr(sourceExpr, ctx);
        if (innerIsJsonCast) {
          const innerLiteral = tryExtractAnyConstant(innerSet);
          if (innerLiteral !== undefined && typeof innerLiteral.value !== "string") {
            failSemantic(`expected JSON string or null; got JSON ${jsonTypeNameForLiteral(innerLiteral.value)}`);
          }
        }
        return compileEnumCast(ctx, enumTarget.qualifiedName, enumTarget.members, innerSet);
      }

      if (expr.castType === "json") {
        const innerSet = compileFreeObjectExpr(innerExpr, ctx);
        const values = tryExtractSetOfStringConstants(innerSet);
        if (values !== undefined) {
          const encoded = values.map((value) => enumLiteralSet(jsonEncodeString(value)));
          return compileSetConstructor(encoded, "json_string_cast");
        }
      }

      if (expr.castType === "str") {
        const innerSet = compileFreeObjectExpr(innerExpr, ctx);
        const literal = tryExtractStringConstant(innerSet);
        if (literal !== undefined) return enumLiteralSet(literal);
        return innerSet;
      }

      const inner = compileFreeObjectExpr(innerExpr, ctx);
      const toType = resolveTypeRef(ctx, expr.castType);
      return {
        kind: "set",
        expr: {
          kind: "type_cast",
          fromType: inner.typeref,
          toType,
          expr: inner,
        },
        pathId: defaultPathId(`cast:${expr.castType}`),
        typeref: toType,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "type_intersection": {
      const inner = compileFreeObjectExpr(expr.expr, ctx);
      return {
        ...inner,
        typeref: resolveTypeRef(ctx, expr.sourceType),
      };
    }

    case "field_suffix_math": {
      const resolved = resolveBinding(ctx, expr.field);
      if (resolved) {
        return resolved;
      }
      return literalToSet(null);
    }

    case "select_expr": {
      return compileFreeObjectExpr(expr.expr, ctx);
    }

    case "array_literal_expr": {
      const values = expr.values.map((value) => compileFreeObjectExpr(value, ctx));
      return {
        kind: "set",
        expr: {
          kind: "array_constructor",
          args: values,
        } as never,
        pathId: defaultPathId("array_literal"),
        typeref: values[0]?.typeref ?? { id: "array", name: "array", isScalar: false },
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    default:
      throw new AppError("E_RUNTIME", `AST->IR is not implemented yet for '${expr.kind}'`, 1, 1);
  }
};

const compileOrderBy = (statement: Extract<EdgeQLStatement, { kind: "select_expr" }>, ctx: IRCompileContext): SortExpr[] | undefined => {
  if (!statement.orderBy) {
    return undefined;
  }
  return [
    {
      kind: "sort_expr",
      path: compileFreeObjectExpr(statement.orderBy.expr, ctx),
      direction: statement.orderBy.direction,
      nonesOrder: "last",
    },
  ];
};

const statementBase = (ctx: IRCompileContext) => ({
  scopeTree: createRootScope(),
  views: {},
  params: [...ctx.params.values()],
  globals: [...ctx.globals.values()],
  requiredPermissions: [],
  serverParamConversions: [],
  serverParamConversionParams: [],
  cardinality: defaultCardinality,
  multiplicity: defaultMultiplicity,
  volatility: defaultVolatility,
  viewShapes: {},
  viewShapesMetadata: {},
  schemaRefs: [],
  dmlExprs: [],
  typeRewrites: {},
  singletons: [],
  triggers: [],
  warnings: [],
  unsafeIsolationDangers: [],
});

const compileFilterValue = (value: FilterValue, ctx: IRCompileContext): Set => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return literalToSet(value);
  }
  if (value.kind === "binding_ref") {
    return compileFreeObjectExpr({ kind: "binding_ref", name: value.name }, ctx);
  }
  if (value.kind === "field_ref") {
    return compileFreeObjectExpr({ kind: "binding_ref", name: value.field }, ctx);
  }
  if (value.kind === "set_literal") {
    return literalToSet(value.values.length);
  }
  return literalToSet(null);
};

const compileFilterTarget = (target: FilterTarget, subject: Set, ctx: IRCompileContext): Set => {
  if (target.kind === "field") {
    const segments = target.field.split(".");
    let result = subject;
    for (const segment of segments) {
      const ptrref = resolvePointerRef(ctx, result.typeref, segment);
      if (!ptrref) {
        return {
          ...result,
          pathId: defaultPathId(`${result.typeref.id}.${segment}`),
        };
      }
      result = extendPathSet(result, ptrref);
    }
    return result;
  }
  if (target.kind === "backlink") {
    const ptrref = resolveBacklinkPointerRef(ctx, subject.typeref, target.link, target.sourceType);
    if (!ptrref) {
      return setFromTypeRoot(resolveTypeRef(ctx, target.sourceType ?? "default::Object"));
    }
    return extendPathSetDirectional(subject, ptrref, "inbound");
  }
  const ptrref = resolveBacklinkPointerRef(ctx, subject.typeref, target.link, target.sourceType);
  if (!ptrref) {
    return setFromTypeRoot(resolveTypeRef(ctx, target.sourceType ?? "default::Object"));
  }
  const backlinkSet = extendPathSetDirectional(subject, ptrref, "inbound");
  const propertyPtr: PointerRef = {
    kind: "pointer_ref",
    id: `${ptrref.id}.@${target.property}`,
    name: `@${target.property}`,
    shortName: `@${target.property}`,
    outSource: backlinkSet.typeref,
    outTarget: { ...unknownTypeRef("std::anyscalar"), isScalar: true },
    outCardinality: "at_most_one",
    inCardinality: "many",
    isComputed: false,
    isLinkProperty: true,
    hasProperties: false,
  };
  return extendPathSetDirectional(backlinkSet, propertyPtr, "outbound");
};

const compileFilterExpr = (filter: FilterExpr, subject: Set, ctx: IRCompileContext): Set => {
  if (filter.kind === "free_expr") {
    return compileFreeObjectExpr(filter.expr, ctx);
  }
  if (filter.kind === "and" || filter.kind === "or") {
    const left = compileFilterExpr(filter.left, subject, ctx);
    const right = compileFilterExpr(filter.right, subject, ctx);
    return {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: filter.kind,
        args: { "0": mkCallArg(left), "1": mkCallArg(right) },
        returning: unknownTypeRef("std::bool"),
        volatility: "immutable",
      } as OperatorCall,
      pathId: defaultPathId(`filter:${filter.kind}`),
      typeref: unknownTypeRef("std::bool"),
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
  }
  if (filter.kind === "not") {
    const inner = compileFilterExpr(filter.expr, subject, ctx);
    return {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: "not",
        args: { "0": mkCallArg(inner) },
        returning: unknownTypeRef("std::bool"),
        volatility: "immutable",
      } as OperatorCall,
      pathId: defaultPathId("filter:not"),
      typeref: unknownTypeRef("std::bool"),
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
  }
  if (filter.kind === "in_predicate") {
    const left = compileFilterTarget(filter.target, subject, ctx);
    const right = filter.values.kind === "set_literal"
      ? compileSetConstructor(filter.values.values.map((value) => literalToSet(value)), "filter:in:set_literal")
      : filter.values.kind === "name"
        ? compileFreeObjectExpr({ kind: "binding_ref", name: filter.values.name }, ctx)
        : filter.values.kind === "select"
          ? setFromTypeRoot(resolveTypeRef(ctx, filter.values.query.typeName))
          : literalToSet(null);
    return {
      kind: "set",
      expr: {
        kind: "operator_call",
        operator: filter.op === "not_in" ? "not in" : "in",
        args: { "0": mkCallArg(left), "1": mkCallArg(right) },
        returning: unknownTypeRef("std::bool"),
        volatility: "immutable",
      } as OperatorCall,
      pathId: defaultPathId("filter:in"),
      typeref: unknownTypeRef("std::bool"),
      shape: [],
      isBinding: false,
      isMaterializedRef: false,
      isSchemaAlias: false,
    };
  }
  const left = compileFilterTarget(filter.target, subject, ctx);
  const right = compileFilterValue(filter.value, ctx);
  return {
    kind: "set",
    expr: {
      kind: "operator_call",
      operator: filter.op,
      args: { "0": mkCallArg(left), "1": mkCallArg(right) },
      returning: unknownTypeRef("std::bool"),
      volatility: "immutable",
    } as OperatorCall,
    pathId: defaultPathId(`filter:${filter.op}`),
    typeref: unknownTypeRef("std::bool"),
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
};

const compileFilterToSet = (
  filter: SelectStatement["filter"] | UpdateStatement["filter"] | DeleteStatement["filter"],
  subject: Set,
  ctx: IRCompileContext,
): Set | undefined => {
  if (!filter) {
    return undefined;
  }
  return compileFilterExpr(filter, subject, ctx);
};

type ComputedExprCard = {
  upper: "one" | "many" | "unknown";
  lower: "zero" | "one" | "unknown";
};

type ComputedExprType =
  | { kind: "scalar"; typeName: string }
  | { kind: "object"; typeName: string }
  | { kind: "empty" }
  | { kind: "unknown" };

const scalarToQualified = (name: string): string => {
  if (name.includes("::")) return name;
  switch (name.toLowerCase()) {
    case "str": return "std::str";
    case "int16": return "std::int16";
    case "int32": return "std::int32";
    case "int64": return "std::int64";
    case "int": return "std::int64";
    case "float32": return "std::float32";
    case "float64": return "std::float64";
    case "decimal": return "std::decimal";
    case "bigint": return "std::bigint";
    case "bool": return "std::bool";
    case "uuid": return "std::uuid";
    case "json": return "std::json";
    case "datetime": return "std::datetime";
    case "duration": return "std::duration";
    case "bytes": return "std::bytes";
    default: return `std::${name}`;
  }
};

const literalScalarTypeName = (value: unknown): string => {
  if (typeof value === "string") return "std::str";
  if (typeof value === "boolean") return "std::bool";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "std::int64" : "std::float64";
  }
  if (typeof value === "bigint") return "std::int64";
  return "std::anyscalar";
};

const ScalarBindingNames = new globalThis.Set<string>([
  "__subject__", "__current__", "__source__",
]);

const inferFreeExprCard = (
  expr: FreeObjectExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): ComputedExprCard => {
  switch (expr.kind) {
    case "literal":
      return { upper: "one", lower: "one" };
    case "set_literal":
      if (expr.values.length === 0) return { upper: "one", lower: "zero" };
      if (expr.values.length === 1) return { upper: "one", lower: "one" };
      return { upper: "many", lower: "one" };
    case "cast":
      return inferFreeExprCard(expr.expr, ctx, subjectTypeRef);
    case "current_item":
      return { upper: "one", lower: "one" };
    case "binding_ref": {
      if (ScalarBindingNames.has(expr.name)) return { upper: "one", lower: "one" };
      const bound = resolveBinding(ctx, expr.name);
      if (bound) {
        return { upper: "unknown", lower: "unknown" };
      }
      const typeDef = getSchemaType(ctx, expr.name);
      if (typeDef) {
        return { upper: "many", lower: "zero" };
      }
      return { upper: "unknown", lower: "unknown" };
    }
    case "field_access": {
      const baseCard = inferFreeExprCard(expr.expr, ctx, subjectTypeRef);
      const baseType = inferFreeExprType(expr.expr, ctx, subjectTypeRef);
      if (baseType.kind === "object") {
        const objectType = getSchemaType(ctx, baseType.typeName);
        const fieldDef = objectType?.fields.find((candidate) => candidate.name === expr.field);
        const linkDef = objectType?.links?.find((candidate) => candidate.name === expr.field);
        if (fieldDef) {
          return combineCard(baseCard, {
            upper: fieldDef.multi ? "many" : "one",
            lower: fieldDef.required ? "one" : "zero",
          });
        }
        if (linkDef) {
          return combineCard(baseCard, {
            upper: linkDef.multi ? "many" : "one",
            lower: linkDef.required ? "one" : "zero",
          });
        }
      }
      return { upper: "unknown", lower: "unknown" };
    }
    case "path":
    case "path_chain":
    case "path_steps":
      return { upper: "unknown", lower: "unknown" };
    case "select_expr_subquery": {
      if (expr.limit === 1) return { upper: "one", lower: "zero" };
      return { upper: "unknown", lower: "zero" };
    }
    case "select":
      if (expr.clauses?.limit === 1) return { upper: "one", lower: "zero" };
      return { upper: "many", lower: "zero" };
    case "tuple":
      return { upper: "one", lower: "one" };
    case "function_call":
      return { upper: "unknown", lower: "unknown" };
    case "math":
    case "compare":
    case "and":
    case "or":
    case "not":
    case "unary":
    case "logical":
    case "concat":
      return { upper: "unknown", lower: "unknown" };
    case "coalesce":
      return { upper: "unknown", lower: "unknown" };
    case "if_else":
      return { upper: "unknown", lower: "unknown" };
    case "for_expr":
      return { upper: "many", lower: "zero" };
    case "exists":
      return { upper: "one", lower: "one" };
    default:
      return { upper: "unknown", lower: "unknown" };
  }
};

const combineCard = (a: ComputedExprCard, b: ComputedExprCard): ComputedExprCard => {
  const upper: ComputedExprCard["upper"] =
    a.upper === "many" || b.upper === "many" ? "many"
      : a.upper === "unknown" || b.upper === "unknown" ? "unknown"
      : "one";
  const lower: ComputedExprCard["lower"] =
    a.lower === "zero" || b.lower === "zero" ? "zero"
      : a.lower === "unknown" || b.lower === "unknown" ? "unknown"
      : "one";
  return { upper, lower };
};

const inferComputedExprCard = (
  expr: ComputedExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): ComputedExprCard => {
  switch (expr.kind) {
    case "literal":
      return { upper: "one", lower: "one" };
    case "field_ref": {
      const ptrref = resolvePointerRef(ctx, subjectTypeRef, expr.field);
      if (!ptrref) return { upper: "unknown", lower: "unknown" };
      const upper: ComputedExprCard["upper"] = ptrref.outCardinality === "many" ? "many" : "one";
      const lower: ComputedExprCard["lower"] = ptrref.outCardinality === "one" ? "one" : "zero";
      return { upper, lower };
    }
    case "select_expr":
      return inferFreeExprCard(expr.expr, ctx, subjectTypeRef);
    case "binding_ref": {
      if (ScalarBindingNames.has(expr.name)) return { upper: "one", lower: "one" };
      const bound = resolveBinding(ctx, expr.name);
      if (bound) return { upper: "unknown", lower: "unknown" };
      const typeDef = getSchemaType(ctx, expr.name);
      if (typeDef) return { upper: "many", lower: "zero" };
      return { upper: "unknown", lower: "unknown" };
    }
    case "function_call":
      return { upper: "unknown", lower: "unknown" };
    default:
      return { upper: "unknown", lower: "unknown" };
  }
};

const inferFreeExprType = (
  expr: FreeObjectExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): ComputedExprType => {
  switch (expr.kind) {
    case "literal":
      return { kind: "scalar", typeName: literalScalarTypeName(expr.value) };
    case "set_literal":
      if (expr.values.length === 0) return { kind: "empty" };
      return { kind: "scalar", typeName: literalScalarTypeName(expr.values[0]) };
    case "cast":
      return { kind: "scalar", typeName: scalarToQualified(expr.castType) };
    case "current_item":
      return { kind: "object", typeName: subjectTypeRef.id };
    case "binding_ref": {
      if (ScalarBindingNames.has(expr.name)) return { kind: "object", typeName: subjectTypeRef.id };
      const typeDef = getSchemaType(ctx, expr.name);
      if (typeDef) {
        return { kind: "object", typeName: qualifyTypeName(typeDef.name, typeDef.module ?? "default") };
      }
      return { kind: "unknown" };
    }
    case "field_access": {
      const baseType = inferFreeExprType(expr.expr, ctx, subjectTypeRef);
      if (baseType.kind === "object") {
        const objectType = getSchemaType(ctx, baseType.typeName);
        const fieldDef = objectType?.fields.find((candidate) => candidate.name === expr.field);
        const linkDef = objectType?.links?.find((candidate) => candidate.name === expr.field);
        if (fieldDef) {
          const target = fieldDef.targetTypeName;
          return { kind: "scalar", typeName: target ?? scalarToStdName(fieldDef.type) };
        }
        if (linkDef) return { kind: "object", typeName: linkDef.targetType };
      }
      return { kind: "unknown" };
    }
    case "select":
      return { kind: "object", typeName: resolveTypeRef(ctx, expr.typeName).id };
    case "select_expr_subquery":
      return inferFreeExprType(expr.expr, ctx, subjectTypeRef);
    case "if_else":
      return inferFreeExprType(expr.thenExpr, ctx, subjectTypeRef);
    case "coalesce":
      return inferFreeExprType(expr.left, ctx, subjectTypeRef);
    default:
      return { kind: "unknown" };
  }
};

const isScalarSubtypeOf = (childName: string, parentName: string): boolean => {
  if (childName === parentName) return true;
  if (parentName === "std::anyscalar") return true;
  if (parentName === "std::number" && (
    childName === "std::int16" || childName === "std::int32" || childName === "std::int64"
    || childName === "std::float32" || childName === "std::float64"
    || childName === "std::decimal" || childName === "std::bigint"
  )) return true;
  return false;
};

const validateOperatorTypes = (
  expr: FreeObjectExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): void => {
  if (expr.kind === "if_else") {
    const thenType = inferFreeExprType(expr.thenExpr, ctx, subjectTypeRef);
    const elseType = inferFreeExprType(expr.elseExpr, ctx, subjectTypeRef);
    if (thenType.kind === "scalar" && elseType.kind === "scalar"
      && thenType.typeName !== elseType.typeName
      && !isScalarSubtypeOf(thenType.typeName, elseType.typeName)
      && !isScalarSubtypeOf(elseType.typeName, thenType.typeName)
    ) {
      throw new AppError(
        "E_SEMANTIC",
        `operator 'IF' cannot be applied to operands of type '${thenType.typeName}' and '${elseType.typeName}'`,
        1, 1,
      );
    }
    validateOperatorTypes(expr.thenExpr, ctx, subjectTypeRef);
    validateOperatorTypes(expr.elseExpr, ctx, subjectTypeRef);
    validateOperatorTypes(expr.condition, ctx, subjectTypeRef);
    return;
  }
  if (expr.kind === "coalesce") {
    const leftType = inferFreeExprType(expr.left, ctx, subjectTypeRef);
    const rightType = inferFreeExprType(expr.right, ctx, subjectTypeRef);
    if (leftType.kind === "scalar" && rightType.kind === "scalar"
      && leftType.typeName !== rightType.typeName
      && !isScalarSubtypeOf(leftType.typeName, rightType.typeName)
      && !isScalarSubtypeOf(rightType.typeName, leftType.typeName)
    ) {
      throw new AppError(
        "E_SEMANTIC",
        `operator '??' cannot be applied to operands of type '${leftType.typeName}' and '${rightType.typeName}'`,
        1, 1,
      );
    }
    validateOperatorTypes(expr.left, ctx, subjectTypeRef);
    validateOperatorTypes(expr.right, ctx, subjectTypeRef);
    return;
  }
  if (expr.kind === "cast") {
    validateOperatorTypes(expr.expr, ctx, subjectTypeRef);
    return;
  }
  if (expr.kind === "select_expr_subquery") {
    validateOperatorTypes(expr.expr, ctx, subjectTypeRef);
    return;
  }
  if (expr.kind === "field_access") {
    validateOperatorTypes(expr.expr, ctx, subjectTypeRef);
    return;
  }
};

const inferComputedExprType = (
  expr: ComputedExpr,
  ctx: IRCompileContext,
  subjectTypeRef: TypeRef,
): ComputedExprType => {
  switch (expr.kind) {
    case "literal":
      return { kind: "scalar", typeName: literalScalarTypeName(expr.value) };
    case "field_ref": {
      const ptrref = resolvePointerRef(ctx, subjectTypeRef, expr.field);
      if (!ptrref) return { kind: "unknown" };
      if (ptrref.outTarget.isScalar) return { kind: "scalar", typeName: ptrref.outTarget.id };
      return { kind: "object", typeName: ptrref.outTarget.id };
    }
    case "select_expr":
      return inferFreeExprType(expr.expr, ctx, subjectTypeRef);
    case "binding_ref": {
      if (ScalarBindingNames.has(expr.name)) return { kind: "object", typeName: subjectTypeRef.id };
      const typeDef = getSchemaType(ctx, expr.name);
      if (typeDef) {
        return { kind: "object", typeName: qualifyTypeName(typeDef.name, typeDef.module ?? "default") };
      }
      return { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
};

const findInheritedFieldOwner = (
  ctx: IRCompileContext,
  typeId: string,
  fieldName: string,
  seen = new globalThis.Set<string>(),
): { kind: "field"; owner: string; field: FieldDef } | { kind: "link"; owner: string; link: LinkDef } | undefined => {
  if (seen.has(typeId)) return undefined;
  seen.add(typeId);
  const typeDef = getSchemaTypeByQualifiedName(ctx, typeId);
  if (!typeDef) return undefined;
  const directField = typeDef.fields.find((c) => c.name === fieldName);
  if (directField) return { kind: "field", owner: typeId, field: directField };
  const directLink = (typeDef.links ?? []).find((c) => c.name === fieldName);
  if (directLink) return { kind: "link", owner: typeId, link: directLink };
  for (const baseName of typeDef.extends ?? []) {
    const inherited = findInheritedFieldOwner(ctx, qualifyTypeName(baseName, typeDef.module ?? "default"), fieldName, seen);
    if (inherited) return inherited;
  }
  return undefined;
};

const isSubtypeOf = (ctx: IRCompileContext, childId: string, parentId: string): boolean => {
  if (childId === parentId) return true;
  const seen = new globalThis.Set<string>();
  const walk = (typeId: string): boolean => {
    if (seen.has(typeId)) return false;
    seen.add(typeId);
    const typeDef = getSchemaTypeByQualifiedName(ctx, typeId);
    if (!typeDef) return false;
    for (const baseName of typeDef.extends ?? []) {
      const qualified = qualifyTypeName(baseName, typeDef.module ?? "default");
      if (qualified === parentId) return true;
      if (walk(qualified)) return true;
    }
    return false;
  };
  return walk(childId);
};

const validateComputedShapeElement = (
  el: Extract<EdgeQLShapeElement, { kind: "computed" }>,
  subject: Set,
  ctx: IRCompileContext,
): void => {
  if (el.name.startsWith("@")) return;
  const subjectTypeId = subject.typeref.id;
  const inherited = findInheritedFieldOwner(ctx, subjectTypeId, el.name);
  const inferredType = inferComputedExprType(el.expr, ctx, subject.typeref);
  const inferredCard = inferComputedExprCard(el.expr, ctx, subject.typeref);

  if (inherited) {
    const ownerName = inherited.owner;
    const memberKind = inherited.kind;
    const expectedRequired = memberKind === "field" ? inherited.field.required === true : inherited.link.required === true;
    const expectedMulti = memberKind === "field" ? inherited.field.multi === true : inherited.link.multi === true;

    if (memberKind === "field") {
      const expectedScalar = scalarToStdName(inherited.field.type);
      if (inferredType.kind === "object") {
        throw new AppError(
          "E_SEMANTIC",
          `cannot redefine property '${el.name}' of object type '${ownerName}' as object type '${inferredType.typeName}'`,
          1, 1,
        );
      }
      if (inferredType.kind === "scalar" && inferredType.typeName !== expectedScalar && inferredType.typeName !== "std::anyscalar") {
        throw new AppError(
          "E_SEMANTIC",
          `cannot redefine property '${el.name}' of object type '${ownerName}' as scalar type '${inferredType.typeName}'`,
          1, 1,
        );
      }
    } else {
      const expectedTargetId = inherited.link.targetType;
      if (inferredType.kind === "scalar") {
        throw new AppError(
          "E_SEMANTIC",
          `cannot redefine link '${el.name}' of object type '${ownerName}' as scalar type '${inferredType.typeName}'`,
          1, 1,
        );
      }
      if (inferredType.kind === "object" && !isSubtypeOf(ctx, inferredType.typeName, expectedTargetId) && inferredType.typeName !== expectedTargetId) {
        throw new AppError(
          "E_SEMANTIC",
          `cannot redefine link '${el.name}' of object type '${ownerName}' as object type '${inferredType.typeName}'`,
          1, 1,
        );
      }
    }

    if (el.cardinality === "many" && !expectedMulti) {
      throw new AppError(
        "E_SEMANTIC",
        `cannot redefine the cardinality of ${memberKind} '${el.name}': it is defined as 'single' in the base object type '${ownerName}'`,
        1, 1,
      );
    }
    if (el.cardinality === "one" && expectedMulti) {
      throw new AppError(
        "E_SEMANTIC",
        `cannot redefine the cardinality of ${memberKind} '${el.name}': it is defined as 'multi' in the base object type '${ownerName}'`,
        1, 1,
      );
    }
    if (el.required === false && expectedRequired) {
      throw new AppError(
        "E_SEMANTIC",
        `cannot redefine ${memberKind} '${el.name}' as optional: it is defined as required in the base object type '${ownerName}'`,
        1, 1,
      );
    }
  }

  const memberKindForMsg = inherited ? inherited.kind : (inferredType.kind === "object" ? "link" : "property");

  const inheritedMulti = inherited && (inherited.kind === "field" ? inherited.field.multi : inherited.link.multi) === true;
  const inheritedRequired = inherited && (inherited.kind === "field" ? inherited.field.required : inherited.link.required) === true;
  const declaredSingle = el.cardinality === "one" || (inherited && !inheritedMulti && el.cardinality !== "many");
  const declaredRequired = el.required === true || (inheritedRequired && el.required !== false);

  if (declaredSingle && inferredCard.upper === "many") {
    throw new AppError(
      "E_SEMANTIC",
      `possibly more than one element returned by an expression for a computed ${memberKindForMsg} '${el.name}' declared as 'single'`,
      1, 1,
    );
  }
  if (declaredRequired && inferredCard.lower === "zero") {
    throw new AppError(
      "E_SEMANTIC",
      `possibly an empty set returned by an expression for a computed ${memberKindForMsg} '${el.name}' declared as 'required'`,
      1, 1,
    );
  }

  if (el.expr.kind === "select_expr") {
    validateOperatorTypes(el.expr.expr, ctx, subject.typeref);
  }
};

const compileShape = (
  subject: Set,
  shape: EdgeQLShapeElement[],
  ctx: IRCompileContext,
  seenTypeIds: globalThis.Set<string> = new globalThis.Set<string>(),
): ShapeElement[] => {
  const out: ShapeElement[] = [];
  const explicitNames = new globalThis.Set<string>();
  for (const el of shape) {
    if (el.kind === "field" || el.kind === "link" || el.kind === "computed" || el.kind === "backlink") {
      explicitNames.add(el.name);
    }
  }

  const resolveShapeOrigin = (el: EdgeQLShapeElement): "explicit" | "default" | "splat_expansion" | "materialization" => {
    if (el.origin) {
      return el.origin;
    }
    if (el.operation === "materialize") {
      return "materialization";
    }
    return "explicit";
  };

  const expandSplatEntries = (
    baseSet: Set,
    targetType: TypeRef,
    depth: 1 | 2,
    skipNames: globalThis.Set<string>,
    withModifiersFrom?: EdgeQLShapeElement,
    ancestry: globalThis.Set<string> = new globalThis.Set<string>(),
  ): ShapeElement[] => {
    const expanded: ShapeElement[] = [];
    const generatedType = getResolvedSchemaType(ctx, targetType.id);
    const resolvedFields = generatedType?.resolvedFields;
    const resolvedLinks = generatedType?.resolvedLinks;
    const typeDef = generatedType
      ? {
          name: generatedType.name,
          module: generatedType.module,
          fields: generatedType.fields,
          links: generatedType.links,
        }
      : ctx.schema?.getType(targetType.id);
    if (!typeDef) {
      return expanded;
    }

    for (const field of resolvedFields ?? typeDef.fields) {
      if (field.name.startsWith("__") && field.name.endsWith("__")) {
        continue;
      }
      if (skipNames.has(field.name)) {
        continue;
      }
      const ptrref = pointerRefFromField(targetType, field);
      const expr = extendPathSet(baseSet, ptrref);
      expanded.push({
        kind: "shape_element",
        source: baseSet,
        expr: withModifiersFrom ? withShapeModifiers(expr, withModifiersFrom) : expr,
        shapeOp: "assign",
        shapeOrigin: "splat_expansion",
        required: field.required ?? false,
        cardinality: field.required ? "one" : "at_most_one",
      });
    }

    for (const link of resolvedLinks ?? typeDef.links ?? []) {
      if (link.name.startsWith("__") && link.name.endsWith("__")) {
        continue;
      }
      if (skipNames.has(link.name)) {
        continue;
      }
      const linkTarget = resolveTypeRef(ctx, link.targetType);
      const ptrref = pointerRefFromLink(targetType, linkTarget, link);
      let expr = extendPathSet(baseSet, ptrref);

      if (depth > 1) {
        const nextAncestry = new Set(ancestry);
        nextAncestry.add(targetType.id);
        const canDescend = !nextAncestry.has(linkTarget.id);
        const nested = canDescend
          ? expandSplatEntries(expr, linkTarget, 1, new globalThis.Set<string>(), undefined, nextAncestry)
          : [];
        if (nested.length > 0) {
          expr = {
            ...expr,
            shape: nested,
          };
        }
      }

      expanded.push({
        kind: "shape_element",
        source: baseSet,
        expr: withModifiersFrom ? withShapeModifiers(expr, withModifiersFrom) : expr,
        shapeOp: "assign",
        shapeOrigin: "splat_expansion",
        required: false,
        cardinality: link.multi ? "many" : "at_most_one",
      });
    }

    return expanded;
  };

  const expandSplat = (el: Extract<EdgeQLShapeElement, { kind: "splat" }>): ShapeElement[] => {
    const targetType = el.sourceType ? resolveTypeRef(ctx, el.sourceType) : subject.typeref;
    const nextSeen = new globalThis.Set(seenTypeIds);
    nextSeen.add(targetType.id);
    return expandSplatEntries(subject, targetType, el.depth, explicitNames, el, nextSeen);
  };

  const withShapeModifiers = (expr: Set, el: EdgeQLShapeElement): Set => {
    const hasFilter = !!el.where;
    const hasOrder = !!el.orderBy?.length;
    const hasLimit = el.limit !== undefined;
    const hasOffset = el.offset !== undefined;
    if (!hasFilter && !hasOrder && !hasLimit && !hasOffset) {
      return expr;
    }
    const where = el.where ? compileFreeObjectExpr(el.where, ctx) : undefined;
    const orderBy = el.orderBy?.map((entry) => {
      const ptrref = resolvePointerRef(ctx, expr.typeref, entry.field);
      const path = ptrref ? extendPathSet(expr, ptrref) : literalToSet(null);
      return {
        kind: "sort_expr",
        path,
        direction: entry.direction,
        nonesOrder: "last",
      } as SortExpr;
    });
    return {
      kind: "set",
      expr: {
        kind: "select_expr",
        result: expr,
        where,
        orderBy,
        offset: el.offset === undefined ? undefined : literalToSet(el.offset),
        limit: el.limit === undefined ? undefined : literalToSet(el.limit),
        implicitWrapper: false,
      },
      pathId: expr.pathId,
      typeref: expr.typeref,
      shape: expr.shape,
      shapeSource: expr,
      isBinding: expr.isBinding,
      isMaterializedRef: expr.isMaterializedRef,
      isSchemaAlias: expr.isSchemaAlias,
      isVisibleBindingRef: expr.isVisibleBindingRef,
      ignoreRewrites: expr.ignoreRewrites,
      isFactoringProtected: expr.isFactoringProtected,
      anchor: expr.anchor,
      showAsAnchor: expr.showAsAnchor,
      pathScopeId: expr.pathScopeId,
      materializedSets: expr.materializedSets,
    };
  };

  const compileLinkPropertyExpr = (el: Extract<EdgeQLShapeElement, { kind: "field" | "computed" }>): ShapeElement | undefined => {
    const propertyName = el.name;
    const subjectExpr = subject.expr;
    let linkPtrRef: PointerRef | undefined;
    if (subjectExpr.kind === "pointer") {
      const linkPointer = subjectExpr as Pointer;
      if (!linkPointer.ptrref.isLinkProperty) {
        const linkPtr = linkPointer.ptrref;
        linkPtrRef = linkPtr;
        const linkSourceType = getResolvedSchemaType(ctx, linkPointer.source.typeref.id);
        if (linkSourceType) {
          const linkDef = linkSourceType.resolvedLinks.find(l => l.name === linkPtr.shortName);
          if (linkDef?.properties) {
            const propName = propertyName.slice(1);
            const propDef = linkDef.properties.find(p => p.name === propName);
            if (propDef) {
              const propertyPtrRef: PointerRef = {
                kind: "pointer_ref",
                id: `${linkPtrRef.id}.${propertyName}`,
                name: propertyName,
                shortName: propertyName,
                outSource: subject.typeref,
                outTarget: scalarTypeRef(propDef.type),
                outCardinality: propDef.required ? "one" : "at_most_one",
                inCardinality: "many",
                isComputed: false,
                isIdPointer: false,
                isLinkProperty: true,
                hasProperties: false,
              };
              const propExpr = extendPathSet(subject, propertyPtrRef);
              return {
                kind: "shape_element",
                source: subject,
                expr: withShapeModifiers(propExpr, el),
                shapeOp: el.operation,
                shapeOrigin: resolveShapeOrigin(el),
                required: el.required ?? propDef.required ?? false,
                cardinality: el.cardinality ?? (propDef.required ? "one" : "at_most_one"),
              };
            }
          }
        }
      }
    }
    const fallbackType = linkPtrRef?.outTarget
      ? { ...linkPtrRef.outTarget, isScalar: true }
      : { ...unknownTypeRef("std::anyscalar"), isScalar: true };
    const propertyPtrRef: PointerRef = {
      kind: "pointer_ref",
      id: `${subject.typeref.id}.${propertyName}`,
      name: propertyName,
      shortName: propertyName,
      outSource: subject.typeref,
      outTarget: fallbackType,
      outCardinality: "at_most_one",
      inCardinality: "many",
      isComputed: false,
      isIdPointer: false,
      isLinkProperty: true,
      hasProperties: false,
    };
    const expr = extendPathSet(subject, propertyPtrRef);
    return {
      kind: "shape_element",
      source: subject,
      expr: withShapeModifiers(expr, el),
      shapeOp: el.operation,
      shapeOrigin: resolveShapeOrigin(el),
      required: el.required ?? false,
      cardinality: el.cardinality ?? "at_most_one",
    };
  };

  for (const el of shape) {
    if (el.kind === "field") {
      if (el.name.startsWith("@")) {
        const result = compileLinkPropertyExpr(el);
        if (result) {
          out.push(result);
        }
        continue;
      }
      const ptrref = resolvePointerRef(ctx, subject.typeref, el.name);
      if (!ptrref) {
        continue;
      }
      const expr = extendPathSet(subject, ptrref);
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(expr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? (ptrref.outCardinality === "one"),
        cardinality: el.cardinality ?? ptrref.outCardinality,
      });
      continue;
    }

    if (el.kind === "computed") {
      if (el.name.startsWith("@")) {
        if (subject.expr.kind !== "pointer") {
          const fieldCtx = childScope(ctx);
          const subjectType = getResolvedSchemaType(ctx, subject.typeref.id);
          if (subjectType) {
            for (const field of subjectType.fields) {
              if (resolveBinding(ctx, field.name)) {
                continue;
              }
              const ptrref = resolvePointerRef(ctx, subject.typeref, field.name);
              if (ptrref) {
                bindValue(fieldCtx, field.name, extendPathSet(subject, ptrref));
              }
            }
          }
          const compiledExpr = compileFreeObjectExpr(el.expr, fieldCtx);
          out.push({
            kind: "shape_element",
            source: subject,
            expr: compiledExpr,
            shapeOp: el.operation,
            shapeOrigin: resolveShapeOrigin(el),
            required: el.required ?? false,
            cardinality: el.cardinality ?? "at_most_one",
          });
          continue;
        }
        const result = compileLinkPropertyExpr(el);
        if (result) {
          out.push(result);
        }
        continue;
      }
      validateComputedShapeElement(el, subject, ctx);
      if (el.expr.kind === "field_ref") {
        const ptrref = resolvePointerRef(ctx, subject.typeref, el.expr.field);
        if (!ptrref) {
          continue;
        }
        const expr = extendPathSet(subject, ptrref);
        out.push({
          kind: "shape_element",
          source: subject,
          expr: withShapeModifiers(expr, el),
          shapeOp: el.operation,
          shapeOrigin: resolveShapeOrigin(el),
          required: el.required ?? false,
          cardinality: el.cardinality ?? (el.multi ? "many" : ptrref.outCardinality),
        });
        continue;
      }
      const computedCtx = childScope(ctx);
      bindValue(computedCtx, "__subject__", subject);
      bindValue(computedCtx, "__current__", subject);
      const compiledExpr = compileFreeObjectExpr(el.expr, computedCtx);
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(compiledExpr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? false,
        cardinality: el.cardinality ?? (el.multi ? "many" : "at_most_one"),
      });
      continue;
    }

    if (el.kind === "link") {
      const ptrref = resolvePointerRef(ctx, subject.typeref, el.name);
      if (!ptrref) {
        continue;
      }
      let expr = extendPathSet(subject, ptrref);
      if (el.shape && el.shape.length > 0) {
        const nextSeen = new globalThis.Set(seenTypeIds);
        const canDescend = !nextSeen.has(expr.typeref.id);
        nextSeen.add(expr.typeref.id);
        if (canDescend) {
          expr = {
            ...expr,
            shape: compileShape(expr, el.shape, ctx, nextSeen),
          };
        }
      }
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(expr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? (ptrref.outCardinality === "one"),
        cardinality: el.cardinality ?? ptrref.outCardinality,
      });
      continue;
    }

    if (el.kind === "backlink") {
      const ptrref = resolveBacklinkPointerRef(ctx, subject.typeref, el.expr.link, el.expr.sourceType);
      if (!ptrref) {
        continue;
      }
      let expr = extendPathSetDirectional(subject, ptrref, "inbound");
      if (el.shape && el.shape.length > 0) {
        const nextSeen = new globalThis.Set(seenTypeIds);
        const canDescend = !nextSeen.has(expr.typeref.id);
        nextSeen.add(expr.typeref.id);
        if (canDescend) {
          expr = {
            ...expr,
            shape: compileShape(expr, el.shape, ctx, nextSeen),
          };
        }
      }
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(expr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? false,
        cardinality: el.cardinality ?? ptrref.inCardinality,
      });
      continue;
    }

    if (el.kind === "splat") {
      const expanded = expandSplat(el);
      if (expanded.length > 0) {
        out.push(...expanded);
      } else {
        out.push({
          kind: "shape_element",
          source: subject,
          expr: withShapeModifiers(subject, el),
          shapeOp: el.operation,
          shapeOrigin: resolveShapeOrigin(el),
          required: el.required ?? false,
          cardinality: el.cardinality ?? "unknown",
        });
      }
    }
  }
  return out;
};

const compileInsertValue = (value: InsertValue, ctx: IRCompileContext, seenInsertTypes: globalThis.Set<string> = new globalThis.Set<string>()): Set => {
  if (value && typeof value === "object") {
    if ("kind" in value) {
      if (value.kind === "set") {
        const compiled = value.values.map((entry) => compileInsertValue(entry, ctx, seenInsertTypes));
        return compileSetConstructor(compiled, "insert_set");
      }
      if (value.kind === "binding_ref") {
        return compileFreeObjectExpr({ kind: "binding_ref", name: value.name }, ctx);
      }
      if (value.kind === "function_call") {
        return compileFreeObjectExpr({ kind: "function_call", call: value.call }, ctx);
      }
      if (value.kind === "expr") {
        return compileFreeObjectExpr(value.expr, ctx);
      }
      if (value.kind === "select") {
        const bound = resolveBinding(ctx, value.typeName);
        const subjectSet = bound ?? setFromTypeRoot(resolveTypeRef(ctx, value.typeName));
        return {
          ...subjectSet,
          shape: value.shape.length > 0 ? compileShape(subjectSet, value.shape, ctx) : subjectSet.shape,
        };
      }
      if (value.kind === "insert") {
        const subject = resolveTypeRef(ctx, value.typeName);
        if (seenInsertTypes.has(subject.id)) {
          return setFromTypeRoot(subject);
        }

        const nextSeen = new Set(seenInsertTypes);
        nextSeen.add(subject.id);

        const subjectSet = setFromTypeRoot(subject);
        const shape: ShapeElement[] = Object.entries(value.values).map(([name, nestedValue]) => {
          const ptrref = resolvePointerRef(ctx, subject, name);
          const nestedExpr = compileInsertValue(nestedValue, ctx, nextSeen);
          return {
            kind: "shape_element",
            source: subjectSet,
            expr: nestedExpr,
            shapeOp: "assign",
            shapeOrigin: "explicit",
            required: ptrref?.outCardinality === "one",
            cardinality: ptrref?.outCardinality ?? "unknown",
          };
        });

        return {
          kind: "set",
          expr: {
            kind: "insert_expr",
            subject,
            shape,
          },
          pathId: defaultPathId(`insert:${subject.id}`),
          typeref: subject,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        };
      }
      if (value.kind === "array_literal") {
        return literalToSet(value.values.length);
      }
      if (value.kind === "tuple_literal") {
        return literalToSet(Array.isArray(value.values) ? value.values.length : Object.keys(value.values).length);
      }
      if (value.kind === "for") {
        return compileFreeObjectExpr({ kind: "for_expr", variable: value.variable, iterator: value.iteratorExpr, body: { kind: "literal", value: null }, optional: value.optional }, ctx);
      }
    }
  }
  return literalToSet(value as string | number | boolean | null);
};

const compileSelectExprStatement = (statement: Extract<EdgeQLStatement, { kind: "select_expr" }>, ctx: IRCompileContext): SelectStmt => {
  const scoped = withBindings(ctx, statement.with);
  const result = compileFreeObjectExpr(statement.expr, scoped);
  return {
    kind: "select_stmt",
    expr: result,
    ...statementBase(scoped),
    orderBy: compileOrderBy(statement, scoped),
    implicitWrapper: false,
    span: statement.pos,
  };
};

const compileSelectStatement = (statement: SelectStatement, ctx: IRCompileContext): SelectStmt => {
  const scoped = withBindings(ctx, statement.with);
  const subject = setFromTypeRoot(resolveTypeRef(scoped, statement.typeName));
  bindValue(scoped, "__subject__", subject);
  bindValue(scoped, "__current__", subject);
  const shaped = compileShape(subject, statement.shape, scoped);
  const orderBy: SortExpr[] | undefined = statement.orderBy
    ? [{
        kind: "sort_expr",
        path: (() => {
          const ptrref = resolvePointerRef(scoped, subject.typeref, statement.orderBy!.field);
          return ptrref ? extendPathSet(subject, ptrref) : literalToSet(null);
        })(),
        direction: statement.orderBy.direction,
        nonesOrder: "last",
      }]
    : undefined;
  return {
    kind: "select_stmt",
    expr: { ...subject, shape: shaped },
    ...statementBase(scoped),
    where: compileFilterToSet(statement.filter, subject, scoped),
    orderBy,
    implicitWrapper: false,
    span: statement.pos,
  };
};

const compileSelectFreeStatement = (statement: SelectFreeStatement, ctx: IRCompileContext): SelectStmt => {
  const scoped = withBindings(ctx, statement.with);
  const tupleValues = statement.entries.map((entry) => ({ name: entry.name, val: compileFreeObjectExpr(entry.expr, scoped) }));
  const tupleSet: Set = {
    kind: "set",
    expr: { kind: "tuple", named: true, elements: tupleValues.map((entry) => ({ name: entry.name, val: entry.val })) },
    pathId: defaultPathId("free_object"),
    typeref: unknownTypeRef("std::tuple"),
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
  return {
    kind: "select_stmt",
    expr: tupleSet,
    ...statementBase(scoped),
    implicitWrapper: false,
    span: statement.pos,
  };
};

const compileInsertStatement = (statement: InsertStatement, ctx: IRCompileContext): InsertStmt => {
  const scoped = withBindings(ctx, statement.with);
  const subject = resolveTypeRef(scoped, statement.typeName);
  const subjectSet = setFromTypeRoot(subject);
  bindValue(scoped, "__subject__", subjectSet);
  bindValue(scoped, "__current__", subjectSet);
  const shape: ShapeElement[] = Object.entries(statement.values).map(([name, value]) => {
    const ptrref = resolvePointerRef(scoped, subject, name);
    const exprSet = compileInsertValue(value, scoped);
    return {
      kind: "shape_element",
      source: subjectSet,
      expr: exprSet,
      targetPtr: ptrref,
      shapeOp: "assign",
      shapeOrigin: "explicit",
      required: ptrref?.outCardinality === "one",
      cardinality: ptrref?.outCardinality ?? "unknown",
    };
  });
  return {
    kind: "insert_stmt",
    expr: subjectSet,
    ...statementBase(scoped),
    subject,
    shape,
    span: statement.pos,
  };
};

const compileUpdateStatement = (statement: UpdateStatement, ctx: IRCompileContext): UpdateStmt => {
  const scoped = withBindings(ctx, statement.with);
  const subject = resolveTypeRef(scoped, statement.typeName);
  const subjectSet = setFromTypeRoot(subject);
  bindValue(scoped, "__subject__", subjectSet);
  bindValue(scoped, "__current__", subjectSet);
  const shape: ShapeElement[] = Object.entries(statement.values).map(([name, value]) => {
    const ptrref = resolvePointerRef(scoped, subject, name);
    return {
      kind: "shape_element",
      source: subjectSet,
      expr: compileInsertValue(value, scoped),
      targetPtr: ptrref,
      shapeOp: statement.operations?.[name] ?? "assign",
      shapeOrigin: "explicit",
      required: ptrref?.outCardinality === "one",
      cardinality: ptrref?.outCardinality ?? "unknown",
    };
  });
  return {
    kind: "update_stmt",
    expr: subjectSet,
    ...statementBase(scoped),
    subject,
    where: compileFilterToSet(statement.filter, subjectSet, scoped),
    shape,
    span: statement.pos,
  };
};

const compileDeleteStatement = (statement: DeleteStatement, ctx: IRCompileContext): DeleteStmt => {
  const scoped = withBindings(ctx, statement.with);
  const subject = resolveTypeRef(scoped, statement.typeName);
  const expr = statement.target
    ? compileFreeObjectExpr(statement.target, scoped)
    : setFromTypeRoot(subject);
  bindValue(scoped, "__subject__", expr);
  bindValue(scoped, "__current__", expr);
  return {
    kind: "delete_stmt",
    expr,
    ...statementBase(scoped),
    subject,
    where: compileFilterToSet(statement.filter, expr, scoped),
    span: statement.pos,
  };
};

const compileForStatement = (statement: ForStatement, ctx: IRCompileContext): SelectStmt => {
  const scoped = withBindings(ctx, statement.with);
  const iteratorSet = compileFreeObjectExpr(statement.iteratorExpr, scoped);
  const loopCtx = childScope(scoped);
  bindValue(loopCtx, statement.variable, iteratorSet);
  const bodyExpr: FreeObjectExpr = statement.body.kind === "select_expr"
    ? statement.body.expr
    : statement.body.kind === "select"
      ? { kind: "select", typeName: statement.body.typeName, shape: statement.body.shape, clauses: { filter: statement.body.filter, orderBy: statement.body.orderBy, limit: statement.body.limit, offset: statement.body.offset } }
      : { kind: "literal", value: null };
  const set = compileFreeObjectExpr({ kind: "for_expr", variable: statement.variable, iterator: statement.iteratorExpr, body: bodyExpr, optional: statement.optional }, loopCtx);
  return {
    kind: "select_stmt",
    expr: set,
    ...statementBase(loopCtx),
    implicitWrapper: false,
    span: statement.pos,
  };
};

const compileConfigureStatement = (statement: ConfigureStatement, ctx: IRCompileContext): ConfigStmt => {
  const scoped = withBindings(ctx, statement.with);
  return {
    kind: "config_stmt",
    expr: statement.value ? compileFreeObjectExpr(statement.value, scoped) : literalToSet(null),
    ...statementBase(scoped),
    operation: statement.operation,
    scope: statement.scope,
    name: statement.target,
    value: statement.value ? compileFreeObjectExpr(statement.value, scoped) : undefined,
    span: statement.pos,
  };
};

export const compileASTToGelIR = (statement: EdgeQLStatement, options: IRCompileOptions = {}): Statement => {
  const schemaModel = resolveSchemaModelForCompile(options);
  const ctx: IRCompileContext = {
    module: options.module ?? statement.withModule ?? "default",
    schema: options.schema,
    schemaModel,
    nextScopeId: 2,
    params: new Map(),
    globals: new Map(),
    bindingScopes: [new Map()],
  };

  if (statement.kind === "select_expr") {
    return compileSelectExprStatement(statement, ctx);
  }

  if (statement.kind === "select") {
    return compileSelectStatement(statement, ctx);
  }

  if (statement.kind === "select_free") {
    return compileSelectFreeStatement(statement, ctx);
  }

  if (statement.kind === "insert") {
    return compileInsertStatement(statement, ctx);
  }

  if (statement.kind === "update") {
    return compileUpdateStatement(statement, ctx);
  }

  if (statement.kind === "delete") {
    return compileDeleteStatement(statement, ctx);
  }

  if (statement.kind === "for") {
    return compileForStatement(statement, ctx);
  }

  if (statement.kind === "configure") {
    return compileConfigureStatement(statement, ctx);
  }

  throw new AppError(
    "E_RUNTIME",
    `AST->IR entrypoint is scaffolded, but statement '${statement.kind}' is not wired yet`,
    statement.pos.line,
    statement.pos.column,
  );
};

export const isGelIRCompatibleStatement = (statement: EdgeQLStatement): boolean => {
  return statement.kind === "select"
    || statement.kind === "select_expr"
    || statement.kind === "select_free"
    || statement.kind === "insert"
    || statement.kind === "update"
    || statement.kind === "delete"
    || statement.kind === "for"
    || statement.kind === "configure";
};

export type GelIRCompileResult = Statement;

const exprIsLiteralFalse = (expr: FreeObjectExpr): boolean => {
  return expr.kind === "literal" && expr.value === false;
};

const walkAndValidateShapes = (
  shape: EdgeQLShapeElement[],
  subject: Set,
  ctx: IRCompileContext,
): void => {
  for (const el of shape) {
    if (el.kind === "computed" && !el.name.startsWith("@")) {
      validateComputedShapeElement(el, subject, ctx);
    }
    if (el.kind === "link") {
      const ptrref = resolvePointerRef(ctx, subject.typeref, el.name);
      if (ptrref) {
        const inherited = findInheritedFieldOwner(ctx, subject.typeref.id, el.name);
        const inheritedRequired = inherited?.kind === "link" && inherited.link.required === true;
        const filterIsFalse = el.where ? exprIsLiteralFalse(el.where as FreeObjectExpr) : false;
        if (inheritedRequired && filterIsFalse) {
          throw new AppError(
            "E_SEMANTIC",
            `possibly an empty set returned by an expression for a computed link '${el.name}' declared as 'required'`,
            1, 1,
          );
        }
        const childSubject = extendPathSet(subject, ptrref);
        walkAndValidateShapes(el.shape, childSubject, ctx);
      }
    }
  }
};

const collectStatementShapesForValidation = (
  statement: EdgeQLStatement,
  ctx: IRCompileContext,
): void => {
  if (statement.kind === "select" && statement.typeName) {
    const typeref = resolveTypeRef(ctx, statement.typeName);
    const subject = setFromTypeRoot(typeref);
    walkAndValidateShapes(statement.shape, subject, ctx);
  }
};

export const validateParsedStatement = (
  statement: EdgeQLStatement,
  options: IRCompileOptions = {},
): void => {
  const schemaModel = resolveSchemaModelForCompile(options);
  const ctx: IRCompileContext = {
    module: options.module ?? (statement as { withModule?: string }).withModule ?? "default",
    schema: options.schema,
    schemaModel,
    nextScopeId: 2,
    params: new Map(),
    globals: new Map(),
    bindingScopes: [new Map()],
  };
  collectStatementShapesForValidation(statement, ctx);
};
