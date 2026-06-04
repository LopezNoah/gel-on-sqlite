import { AppError } from "../errors.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import type {
  Statement as EdgeQLStatement,
  ComputedExpr,
  FreeObjectExpr,
  FunctionCallArgExpr,
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
  OrderExpr,
  OrderExprChain,
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
  InsertExpr,
  UpdateExpr,
  DeleteExpr,
  ForExpr,
  Pointer,
  PointerRef,
  SelectExpr,
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
  // Stack of schema aliases currently being inlined. Used to detect cycles
  // (e.g. alias A := SELECT B; alias B := SELECT A) and to skip alias
  // resolution within an alias's own body.
  aliasResolutionStack?: globalThis.Set<string>;
  // Stack of computed-property bodies currently being inlined (`Type.fieldName`
  // keys). Prevents infinite recursion when a computed body references the
  // same computed transitively.
  computedExprResolutionStack?: globalThis.Set<string>;
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
  // Unqualified builtin scalars (`str`, `int64`, …) should resolve as
  // `std::*` rather than `<active-module>::*` so downstream SQL lowering
  // recognises them via `sqlCastTarget` / `qualifyTypeName`.
  if (!name.includes("::") && BUILTIN_SCALAR_NAMES[name]) {
    return unknownTypeRef(BUILTIN_SCALAR_NAMES[name]);
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

const pointerRefFromLink = (source: TypeRef, target: TypeRef, link: LinkDef): PointerRef => {
  // EdgeQL: when the forward link is `constraint exclusive`, each target
  // is referenced by at most one source row, so the inbound (backlink)
  // cardinality is at-most-one rather than many.
  const isExclusive = (link.constraints ?? []).some(
    (constraint) => constraint.name === "std::exclusive" || constraint.name === "exclusive",
  );
  return {
    kind: "pointer_ref",
    id: `${source.id}.link::${link.name}`,
    name: link.name,
    shortName: link.name,
    outSource: source,
    outTarget: target,
    outCardinality: link.multi ? "many" : "at_most_one",
    inCardinality: isExclusive ? "at_most_one" : "many",
    isComputed: false,
    isIdPointer: false,
    isLinkProperty: false,
    hasProperties: (link.properties?.length ?? 0) > 0,
  };
};

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

// Walk the parsed AST for bare-parameter (`$N`) usage that the EdgeQL spec
// requires to be wrapped in a type cast, and reject shape projections applied
// to a parameter set (`<int64>$0 { id }`) — there is no underlying object to
// shape. We thread an `insideCast` flag through the walk; once any explicit
// `<T>$0` covers a parameter, it's typed and any nested occurrence is OK.
const validateParametersInStatement = (statement: EdgeQLStatement): void => {
  const visitExpr = (expr: unknown, insideCast: boolean): void => {
    if (!expr || typeof expr !== "object") return;
    const node = expr as Record<string, unknown> & { kind?: string };
    if (node.kind === "parameter") {
      if (!insideCast) {
        const name = typeof node.name === "string" ? node.name : "";
        throw new AppError("E_SEMANTIC", `missing a type cast before the parameter $${name}`, 1, 1);
      }
      return;
    }
    if (node.kind === "cast") {
      visitExpr(node.expr, true);
      return;
    }
    if (node.kind === "shape_projection") {
      const inner = node.expr as Record<string, unknown> | undefined;
      const innerKind = inner && typeof inner === "object" ? (inner as { kind?: string }).kind : undefined;
      const isParamShape = innerKind === "parameter"
        || (innerKind === "cast" && ((inner as { expr?: { kind?: string } }).expr?.kind === "parameter"));
      if (isParamShape) {
        throw new AppError("E_SEMANTIC", "cannot apply a shape to the parameter", 1, 1);
      }
      visitExpr(node.expr, insideCast);
      if (Array.isArray(node.shape)) {
        for (const el of node.shape) visitExpr(el, insideCast);
      }
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visitExpr(item, insideCast);
      } else if (value && typeof value === "object") {
        visitExpr(value, insideCast);
      }
    }
  };

  if (statement.kind === "select_expr") {
    visitExpr(statement.expr, false);
    return;
  }
  if (statement.kind === "select_free") {
    for (const entry of statement.entries) visitExpr(entry.expr, false);
    return;
  }
  if (statement.kind === "select") {
    if (statement.filter) visitExpr(statement.filter, false);
    if (statement.shape) for (const el of statement.shape) visitExpr(el, false);
    if (statement.limit) visitExpr(statement.limit, false);
    if (statement.offset) visitExpr(statement.offset, false);
  }
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

// `T.<computed-property>` resolves at AST→IR time by substituting the
// computed body. Supports the structured property-computed shapes the SDL
// adapter emits (literal, set-of-literals, concat of literal/param parts).
// Returns undefined when the type has no such computed or the body uses a
// shape we don't lower here — callers fall through to their existing failure
// handling.
const tryLowerComputedPropertyOnTypePath = (
  ctx: IRCompileContext,
  source: Set,
  fieldName: string,
): Set | undefined => {
  if (!ctx.schema) return undefined;
  const typeDef = ctx.schema.getType(source.typeref.id);
  if (!typeDef) return undefined;
  const computed = typeDef.computeds?.find(
    (candidate) => candidate.kind === "property" && candidate.name === fieldName,
  );
  if (!computed || computed.kind !== "property") return undefined;
  const expr = computed.expr;
  if (expr.kind === "literal") {
    return literalToSet(expr.value);
  }
  if (expr.kind === "set_literal") {
    return compileSetConstructor(expr.values.map((value) => literalToSet(value)), "set_literal");
  }
  if (expr.kind === "edgeql_expr") {
    // Free-form EdgeQL computed body: parse, bind the current source as the
    // subject so `.field` references inside the body resolve against the
    // current row, then lower through compileFreeObjectExpr.
    const text = expr.exprText.trim();
    let parsed;
    try {
      parsed = parseEdgeQL(text.toLowerCase().startsWith("select ") ? text : `SELECT ${text}`);
    } catch {
      return undefined;
    }
    // Guard against direct self-reference recursion (`p := .p`): if the body
    // is itself `.<fieldName>` it would loop forever.
    if (ctx.computedExprResolutionStack?.has(`${typeDef.module}::${typeDef.name}.${fieldName}`)) {
      return undefined;
    }
    if (!ctx.computedExprResolutionStack) {
      ctx.computedExprResolutionStack = new globalThis.Set<string>();
    }
    const key = `${typeDef.module}::${typeDef.name}.${fieldName}`;
    ctx.computedExprResolutionStack.add(key);
    try {
      const innerCtx = childScope(ctx);
      bindValue(innerCtx, "__current__", source);
      bindValue(innerCtx, "__subject__", source);
      if (parsed.kind === "select_expr") {
        return compileFreeObjectExpr(parsed.expr, innerCtx);
      }
      return undefined;
    } finally {
      ctx.computedExprResolutionStack.delete(key);
    }
  }
  return undefined;
};

const compilePathSteps = (steps: EdgeQLPathStep[], ctx: IRCompileContext): Set => {
  if (steps.length === 0) {
    return literalToSet(null);
  }
  const first = steps[0];
  // Leading-dot paths like `.name` resolve against the surrounding subject
  // (`__current__` / `__subject__`) rather than a named object. Without this
  // they'd bail out as `null`, and the wrapping pointer would be built over
  // a string-constant source — breaking shape filters like
  // `SELECT Card {…} FILTER .name = 'Imp'`.
  if (!first || first.kind !== "object_ref") {
    const current = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
    if (!current) {
      return literalToSet(null);
    }
    let out = current;
    for (const step of steps) {
      if (step.kind === "ptr") {
        const ptrref = resolvePointerRef(ctx, out.typeref, step.name);
        if (!ptrref) {
          return { ...out, pathId: defaultPathId("path_steps") };
        }
        out = extendPathSetDirectional(out, ptrref, ptrref.computedLinkAliasIsBackward ? "inbound" : (step.direction ?? "outbound"));
        if (step.optional) {
          out = { ...out, expr: { ...(out.expr as Pointer), optionalDeref: true } };
        }
        continue;
      }
      if (step.kind === "type_intersection") {
        out = { ...out, typeref: resolveTypeRef(ctx, step.typeName) };
        continue;
      }
      if (step.kind === "splat") continue;
    }
    return out;
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
        // No backing column / link / backlink — but the source type may
        // expose `step.name` as a computed property (`property p := <expr>`).
        // Lower the computed body in place so the SQL pipeline sees the
        // substituted expression instead of an unresolved pointer.
        const computedSet = tryLowerComputedPropertyOnTypePath(ctx, out, step.name);
        if (computedSet) {
          out = computedSet;
          continue;
        }
        return { ...out, pathId: defaultPathId("path_steps") };
      }
      out = extendPathSetDirectional(
        out,
        ptrref,
        ptrref.computedLinkAliasIsBackward ? "inbound" : (step.direction ?? "outbound"),
      );
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
      case "set_literal": {
        // Inspect the literal values to give the binding the right typeref —
        // `WITH A := {1.0, 2.0}` should resolve to float64 on
        // `INTROSPECT TYPEOF A`, not the length placeholder we used to bind.
        const values = binding.value.values;
        const inferred = inferAstExprTypeName(
          { kind: "set_literal", values } as FreeObjectExpr,
          scoped,
        );
        const placeholder = values.length > 0 ? (values[0] as ScalarValue) : null;
        set = literalToSet(placeholder);
        if (inferred) {
          set = { ...set, typeref: unknownTypeRef(inferred) };
        }
        break;
      }
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
  // Validate any literal members up-front so bad input still fails at
  // compile time, but always wrap the inner in a `type_cast` to the enum
  // target so downstream consumers (especially ORDER BY) can recover the
  // enum target type and emit enum-aware SQL (mapping each member to its
  // declared index for sorting).
  const stringValues = tryExtractSetOfStringConstants(inner);
  if (stringValues !== undefined) {
    for (const value of stringValues) {
      if (!enumMembers.includes(value)) {
        failSemantic(`invalid input value for enum '${enumQualifiedName}': "${value}"`);
      }
    }
  }
  const toType = resolveTypeRef(ctx, enumQualifiedName);
  return {
    kind: "set",
    expr: {
      kind: "type_cast",
      fromType: inner.typeref,
      toType,
      expr: inner,
    },
    pathId: defaultPathId(`cast:${enumQualifiedName}`),
    typeref: toType,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
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
  if (name.includes("::")) {
    // `cal::*` casts (`<cal::local_date>...`) keep their short form coming out
    // of the parser; promote them to fully-qualified `std::cal::*` so
    // downstream comparators (type compatibility checks, error messages,
    // overlay metadata) see the same canonical name as the rest of the code.
    if (name.startsWith("cal::")) return `std::${name}`;
    return name;
  }
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
      if (typeof expr.value === "number") {
        // Parser stamps a numericKind hint so `1` (int) is distinguishable
        // from `1.0` (float) — `Number.isInteger(1.0)` is true, so we'd
        // otherwise mis-classify floats whose fractional part is zero.
        const kind = (expr as { numericKind?: "integer" | "float" | "bigint" | "decimal" }).numericKind;
        if (kind === "float") return "std::float64";
        if (kind === "bigint") return "std::bigint";
        if (kind === "decimal") return "std::decimal";
        if (kind === "integer") return "std::int64";
        return Number.isInteger(expr.value) ? "std::int64" : "std::float64";
      }
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
      // `INTROSPECT std::float64` parses the type name as a binding_ref;
      // recognise the std/cal/schema qualified names so the introspect_typeof
      // case can emit the type itself.
      if (expr.name.includes("::")) return expr.name;
      return undefined;
    }
    case "select": {
      // `INTROSPECT TYPEOF Card` / `INTROSPECT TYPEOF schema::ObjectType`
      // — the parser turns the type name into a `select` statement with
      // an implicit `{id}` shape. Surface the type name back so the outer
      // introspect_typeof case can carry it as the inferred type.
      return (expr as { typeName?: string }).typeName;
    }
    case "tuple": {
      // Best-effort: name the tuple by its element types so cross-type
      // comparisons (`(1,2) = [1,2]`) can be rejected. If any element is
      // un-inferable, fall back to a generic `tuple<>` so the type-category
      // bucket still matches.
      const inner = (expr as { values: FreeObjectExpr[] }).values
        .map((v) => inferAstExprTypeName(v, ctx) ?? "anytype");
      return `tuple<${inner.join(", ")}>`;
    }
    case "array_literal_expr": {
      const values = (expr as { values: FreeObjectExpr[] }).values;
      if (values.length === 0) return "array<anytype>";
      const elemType = inferAstExprTypeName(values[0], ctx) ?? "anytype";
      return `array<${elemType}>`;
    }
    case "set_expr": {
      // Set elements promote up the numeric hierarchy when mixed:
      // `{1, <float32>2.1}` is float64, `{1, <decimal>2.1}` is decimal.
      const values = (expr as { values: FreeObjectExpr[] }).values;
      if (values.length === 0) return undefined;
      let acc: string | undefined;
      for (const value of values) {
        const t = inferAstExprTypeName(value, ctx);
        if (!t) continue;
        if (!acc) { acc = t; continue; }
        // Re-use the math promotion rules for set element promotion.
        const promoted = inferAstExprTypeName(
          { kind: "math", op: "add", left: { kind: "literal", value: 0 }, right: { kind: "literal", value: 0 } } as unknown as FreeObjectExpr,
          ctx,
        );
        // Direct path: emulate INT_RANK / FLOAT_RANK promotion here.
        const INT_RANK: Record<string, number> = {
          "std::int16": 1, "std::int32": 2, "std::int64": 3, "std::bigint": 4,
        };
        const FLOAT_RANK: Record<string, number> = {
          "std::float32": 1, "std::float64": 2, "std::decimal": 3,
        };
        const aInt = INT_RANK[acc];
        const bInt = INT_RANK[t];
        const aFloat = FLOAT_RANK[acc];
        const bFloat = FLOAT_RANK[t];
        if (aInt !== undefined && bInt !== undefined) {
          acc = aInt >= bInt ? acc : t;
        } else if (aFloat !== undefined && bFloat !== undefined) {
          acc = aFloat >= bFloat ? acc : t;
        } else if ((aInt !== undefined && bFloat !== undefined) || (aFloat !== undefined && bInt !== undefined)) {
          const floatType = aFloat !== undefined ? acc : t;
          const intType = aInt !== undefined ? acc : t;
          if (floatType === "std::decimal") acc = "std::decimal";
          else if (floatType === "std::float64") acc = "std::float64";
          else acc = intType === "std::int16" ? "std::float32" : "std::float64";
        }
        void promoted;
      }
      return acc;
    }
    case "set_literal": {
      const values = (expr as { values: ScalarValue[] }).values;
      if (values.length === 0) return undefined;
      // Promote across all elements: `{1, 2.1}` is float64, not int64.
      let anyFloat = false;
      let anyString = false;
      let anyBool = false;
      for (const v of values) {
        if (typeof v === "string") anyString = true;
        else if (typeof v === "boolean") anyBool = true;
        else if (typeof v === "number" && !Number.isInteger(v)) anyFloat = true;
      }
      if (anyString) return "std::str";
      if (anyBool) return "std::bool";
      if (anyFloat) return "std::float64";
      const v = values[0];
      if (typeof v === "number") return "std::int64";
      return undefined;
    }
    case "unary": {
      // `-X` / `+X` preserve `X`'s inferred type. `NOT bool` returns bool.
      const inner = inferAstExprTypeName((expr as { expr: FreeObjectExpr }).expr, ctx);
      const op = (expr as { op: string }).op;
      if (op === "not") return "std::bool";
      return inner;
    }
    case "exists":
    case "compare":
    case "logical":
    case "in_expr": {
      return "std::bool";
    }
    case "if_else": {
      const thenType = inferAstExprTypeName((expr as { thenExpr: FreeObjectExpr }).thenExpr, ctx);
      const elseType = inferAstExprTypeName((expr as { elseExpr: FreeObjectExpr }).elseExpr, ctx);
      return thenType ?? elseType;
    }
    case "concat": {
      // String concat returns str; array concat returns the array type.
      const parts = (expr as { parts: FreeObjectExpr[] }).parts;
      for (const part of parts) {
        const t = inferAstExprTypeName(part, ctx);
        if (t?.startsWith("array<")) return t;
      }
      return "std::str";
    }
    case "for_expr": {
      // `User.<owner` parses as `FOR x IN User UNION (<owner backlink>)`.
      // The body's backlink_path with no sourceType resolves to the universal
      // `std::BaseObject`; with a sourceType the target is that type.
      const body = (expr as { body: FreeObjectExpr }).body;
      if (body.kind === "backlink_path") {
        const sourceType = (body as { sourceType?: string }).sourceType;
        return sourceType ?? "std::BaseObject";
      }
      return inferAstExprTypeName(body, ctx);
    }
    case "math": {
      // Numeric promotion for `a + b`, `a - b`, etc. — matches EdgeQL's
      // implicit-cast hierarchy. Mixed int/float promotes to float64 unless
      // the int fits in float32 (only int16 does), in which case float32
      // wins. Pure-int and pure-float ladders use widest-wins.
      const INT_RANK: Record<string, number> = {
        "std::int16": 1, "std::int32": 2, "std::int64": 3, "std::bigint": 4,
      };
      const FLOAT_RANK: Record<string, number> = {
        "std::float32": 1, "std::float64": 2, "std::decimal": 3,
      };
      const leftType = inferAstExprTypeName((expr as { left: FreeObjectExpr }).left, ctx);
      const rightType = inferAstExprTypeName((expr as { right: FreeObjectExpr }).right, ctx);
      const op = (expr as { op: string }).op;
      const promote = (a: string | undefined, b: string | undefined): string | undefined => {
        if (!a) return b;
        if (!b) return a;
        const aInt = INT_RANK[a]; const bInt = INT_RANK[b];
        const aFloat = FLOAT_RANK[a]; const bFloat = FLOAT_RANK[b];
        if (aInt !== undefined && bInt !== undefined) return aInt >= bInt ? a : b;
        if (aFloat !== undefined && bFloat !== undefined) return aFloat >= bFloat ? a : b;
        const intType = aInt !== undefined ? a : b;
        const floatType = aFloat !== undefined ? a : b;
        if (floatType === "std::decimal") return "std::decimal";
        if (floatType === "std::float64") return "std::float64";
        return intType === "std::int16" ? "std::float32" : "std::float64";
      };
      // `/` (true division) always returns a float — `3 / 2` is float64,
      // `<decimal>3 / 2` is decimal. Promote integer operands to float64.
      if (op === "/" || op === "div") {
        const promoted = promote(leftType, rightType);
        if (promoted && INT_RANK[promoted] !== undefined) return "std::float64";
        return promoted;
      }
      return promote(leftType, rightType);
    }
    case "coalesce": {
      // `A ?? B` adopts the wider operand type — `(int) ?? <float64>{}`
      // resolves to float64, etc. Falls through to math-like promotion.
      const leftT = inferAstExprTypeName((expr as { left: FreeObjectExpr }).left, ctx);
      const rightT = inferAstExprTypeName((expr as { right: FreeObjectExpr }).right, ctx);
      if (!leftT) return rightT;
      if (!rightT) return leftT;
      const INT_RANK: Record<string, number> = {
        "std::int16": 1, "std::int32": 2, "std::int64": 3, "std::bigint": 4,
      };
      const FLOAT_RANK: Record<string, number> = {
        "std::float32": 1, "std::float64": 2, "std::decimal": 3,
      };
      const aInt = INT_RANK[leftT];
      const bInt = INT_RANK[rightT];
      const aFloat = FLOAT_RANK[leftT];
      const bFloat = FLOAT_RANK[rightT];
      if (aInt !== undefined && bInt !== undefined) return aInt >= bInt ? leftT : rightT;
      if (aFloat !== undefined && bFloat !== undefined) return aFloat >= bFloat ? leftT : rightT;
      if ((aInt !== undefined && bFloat !== undefined) || (aFloat !== undefined && bInt !== undefined)) {
        const floatType = aFloat !== undefined ? leftT : rightT;
        return floatType;
      }
      return leftT;
    }
    case "function_call": {
      // Best-effort inference for aggregates/scalar functions used by
      // INTROSPECT TYPEOF / IS checks. We only need to cover stdlib calls
      // whose return type is a deterministic function of their argument
      // types; anything else falls back to undefined and downstream code
      // treats it as std::anytype.
      const fnName = expr.call.name;
      const shortName = fnName.includes("::") ? fnName.split("::").pop()! : fnName;
      const argTypes = expr.call.args.map((arg): string | undefined => {
        const a = arg as { kind?: string; expr?: FreeObjectExpr; arg?: { expr?: FreeObjectExpr } };
        if (a.kind === "expr" && a.expr) return inferAstExprTypeName(a.expr, ctx);
        if (a.kind === "named_arg" && a.arg?.expr) return inferAstExprTypeName(a.arg.expr, ctx);
        if ((arg as FreeObjectExpr).kind) return inferAstExprTypeName(arg as FreeObjectExpr, ctx);
        return undefined;
      });
      const first = argTypes[0];
      // `sum(int...)` returns int64; `sum(float...)` returns float64 (etc.).
      // EdgeQL promotes the numeric category to its widest representative.
      const isAnyNumericFloat = argTypes.some((t) => t === "std::float32" || t === "std::float64");
      const isAnyDecimal = argTypes.some((t) => t === "std::decimal");
      const isAnyBigint = argTypes.some((t) => t === "std::bigint");
      const isAllInt = argTypes.every((t) => t === "std::int16" || t === "std::int32" || t === "std::int64");
      if (shortName === "sum") {
        if (isAnyDecimal) return "std::decimal";
        if (isAnyNumericFloat) return "std::float64";
        if (isAnyBigint) return "std::bigint";
        if (isAllInt && argTypes.length > 0) return "std::int64";
      }
      if (shortName === "mean" || shortName === "stddev" || shortName === "stddev_pop"
        || shortName === "var" || shortName === "var_pop") {
        if (isAnyDecimal) return "std::decimal";
        return "std::float64";
      }
      if (shortName === "min" || shortName === "max") return first;
      if (shortName === "count") return "std::int64";
      if (shortName === "len") return "std::int64";
      if (shortName === "to_str" || shortName === "str_lower" || shortName === "str_upper"
        || shortName === "str_trim" || shortName === "str_pad_start" || shortName === "str_pad_end"
        || shortName === "str_repeat" || shortName === "str_split" || shortName === "re_replace") {
        return "std::str";
      }
      if (shortName === "round") return first ?? "std::float64";
      if (shortName === "ceil" || shortName === "floor") {
        // EdgeQL `math::ceil` / `math::floor` return int64 for any integer
        // input and the matching float / decimal otherwise.
        const integers = new Set(["std::int16", "std::int32", "std::int64", "std::bigint"]);
        if (first && integers.has(first)) return "std::int64";
        if (first === "std::decimal") return "std::decimal";
        return first ?? "std::float64";
      }
      if (shortName === "abs") return first;
      if (shortName === "random") return "std::float64";
      if (shortName === "array_get" || shortName === "array_unpack") {
        // Element-type extraction: `array<T>` → `T`. The parser already
        // canonicalises array type names to that exact form, so a prefix /
        // suffix match is sufficient and avoids a regex.
        if (!first) return undefined;
        if (first.startsWith("array<") && first.endsWith(">")) {
          return first.slice("array<".length, -1);
        }
        return undefined;
      }
      if (shortName === "array_agg") return first ? `array<${first}>` : undefined;
      return undefined;
    }
    default:
      return undefined;
  }
};

// Type-category helpers used by binary/unary operator validation. We keep the
// taxonomy aligned with EdgeQL's std types: numeric scalars share arithmetic,
// strings/bytes have their own set of operations, and temporals form another
// island. Returns one of "numeric", "str", "bytes", "bool", "uuid", "json",
// "datetime", "duration", "array", "tuple", or "other" if no specific bucket
// applies.
const typeCategory = (typeName: string | undefined): string => {
  if (!typeName) return "other";
  const NUMERIC = new Set([
    "std::int16", "std::int32", "std::int64",
    "std::float32", "std::float64",
    "std::bigint", "std::decimal",
  ]);
  if (NUMERIC.has(typeName)) return "numeric";
  if (typeName === "std::str") return "str";
  if (typeName === "std::bytes") return "bytes";
  if (typeName === "std::bool") return "bool";
  if (typeName === "std::uuid") return "uuid";
  if (typeName === "std::json") return "json";
  if (typeName === "std::datetime"
    || typeName === "std::cal::local_datetime"
    || typeName === "std::cal::local_date"
    || typeName === "std::cal::local_time"
  ) return "datetime";
  if (typeName === "std::duration"
    || typeName === "std::cal::relative_duration"
    || typeName === "std::cal::date_duration"
  ) return "duration";
  if (typeName.startsWith("array<") || typeName === "std::array") return "array";
  if (typeName.startsWith("tuple<") || typeName === "std::tuple") return "tuple";
  return "other";
};

const canApplyUnaryArith = (typeName: string): boolean => {
  const c = typeCategory(typeName);
  return c === "numeric" || c === "duration";
};

const NUMERIC_INT_FAMILY = new Set(["std::int16", "std::int32", "std::int64"]);
const NUMERIC_FLOAT_FAMILY = new Set(["std::float32", "std::float64"]);
const NUMERIC_ARBITRARY_PRECISION = new Set(["std::bigint", "std::decimal"]);

const SAME_CATEGORIES = new Set(["str", "bool", "uuid", "bytes", "json"]);

// Returns true if `a` and `b` can be combined under EdgeQL's "comparable"
// rules — same type, compatible numeric families (small-int <-> float OK;
// bigint/decimal <-> float NOT OK), or one of the known cross-temporal pairs
// (`local_date <-> local_datetime`, `relative_duration <-> date_duration`).
// Compatible pairs survive operator resolution; everything else triggers
// "cannot be applied to operands".
const areCompareCompatible = (a: string, b: string): boolean => {
  if (a === b) return true;
  const ca = typeCategory(a);
  const cb = typeCategory(b);
  if (ca === "numeric" && cb === "numeric") {
    // EdgeQL incompatibility rules for numeric: `bigint`/`decimal` cannot be
    // compared with float types without an explicit cast. They CAN be
    // compared with int families and with each other. int families are
    // compatible with everything except as above.
    const aArb = NUMERIC_ARBITRARY_PRECISION.has(a);
    const bArb = NUMERIC_ARBITRARY_PRECISION.has(b);
    const aFloat = NUMERIC_FLOAT_FAMILY.has(a);
    const bFloat = NUMERIC_FLOAT_FAMILY.has(b);
    if ((aArb && bFloat) || (bArb && aFloat)) {
      return false;
    }
    return true;
  }
  if ((a === "std::cal::local_date" && b === "std::cal::local_datetime")
    || (b === "std::cal::local_date" && a === "std::cal::local_datetime")) {
    return true;
  }
  if ((a === "std::cal::relative_duration" && b === "std::cal::date_duration")
    || (b === "std::cal::relative_duration" && a === "std::cal::date_duration")) {
    return true;
  }
  if (ca === cb && SAME_CATEGORIES.has(ca)) return true;
  // Two arrays / two tuples: defer to a structural comparison of the inner
  // generics so `array<int64>` vs `array<float64>` is rejected but two
  // `array<int64>` (even when the literals were assembled differently) is
  // accepted. The simplest form: same outer kind AND same printed name OR
  // anytype on either side wins (we use `anytype` for empty/unknown).
  if (ca === cb && (ca === "array" || ca === "tuple")) {
    if (a.includes("anytype") || b.includes("anytype")) return true;
    return a === b;
  }
  return false;
};

// Arithmetic-compatible: numeric pairs per the compare rules, plus
// temporal/duration combinations EdgeQL actually permits. `datetime + datetime`
// is rejected (no such operator); `datetime + duration` returns datetime.
const areArithCompatible = (a: string, b: string): boolean => {
  if (a === b) {
    const cat = typeCategory(a);
    return cat === "numeric" || cat === "duration";
  }
  const ca = typeCategory(a);
  const cb = typeCategory(b);
  if (ca === "numeric" && cb === "numeric") {
    const aArb = NUMERIC_ARBITRARY_PRECISION.has(a);
    const bArb = NUMERIC_ARBITRARY_PRECISION.has(b);
    const aFloat = NUMERIC_FLOAT_FAMILY.has(a);
    const bFloat = NUMERIC_FLOAT_FAMILY.has(b);
    if ((aArb && bFloat) || (bArb && aFloat)) return false;
    return true;
  }
  if ((ca === "datetime" && cb === "duration") || (ca === "duration" && cb === "datetime")) return true;
  if (ca === "duration" && cb === "duration") return true;
  return false;
};

// EdgeQL schema aliases (e.g. `alias FireCard := SELECT Card FILTER .element = 'Fire'`)
// are stored on the schema as a body of EdgeQL text. When a query refers to
// such an alias by name we want the gel_ir to carry the alias's expanded body
// — same as if the user had inlined `(SELECT Card FILTER .element = 'Fire')`
// at that position — so downstream SQL lowering treats it as a real set
// expression and not an unresolved type. Returns undefined when the name is
// not an alias, when the alias body cannot be parsed as a SELECT, or when
// resolving the alias would cycle.
const tryResolveSchemaAliasSet = (ctx: IRCompileContext, name: string): Set | undefined => {
  if (!ctx.schema) {
    return undefined;
  }
  const qualified = qualifyTypeName(name, ctx.module);
  const alias = ctx.schema.getAlias(qualified);
  if (!alias?.exprText) {
    return undefined;
  }
  if (ctx.aliasResolutionStack?.has(qualified)) {
    return undefined;
  }

  let body = alias.exprText.trim();
  if (body.endsWith(";")) {
    body = body.slice(0, -1).trim();
  }
  while (body.startsWith("(") && body.endsWith(")")) {
    const inner = body.slice(1, -1).trim();
    let depth = 0;
    let balanced = true;
    for (const ch of inner) {
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth < 0) { balanced = false; break; }
      }
    }
    if (!balanced || depth !== 0) break;
    body = inner;
  }

  // `alias N := SELECT T {...}` parses to a `select`; `alias N := {2,3,5}`
  // (and other free-expression bodies) parse to `select_expr` wrapping a
  // FreeObjectExpr. Both shapes resolve through `compileFreeObjectExpr`.
  let ast: EdgeQLStatement | undefined;
  for (const candidate of [body, `SELECT ${body}`]) {
    try {
      const parsed = parseEdgeQL(candidate);
      if (parsed.kind === "select" || parsed.kind === "select_expr") {
        ast = parsed;
        break;
      }
    } catch {
      // try next candidate
    }
  }
  if (!ast) {
    return undefined;
  }

  if (!ctx.aliasResolutionStack) {
    ctx.aliasResolutionStack = new globalThis.Set<string>();
  }
  ctx.aliasResolutionStack.add(qualified);
  try {
    if (ast.kind === "select_expr") {
      return compileFreeObjectExpr(ast.expr, ctx);
    }
    return compileFreeObjectExpr(
      {
        kind: "select",
        typeName: ast.typeName,
        shape: ast.shape,
        clauses: {
          filter: ast.filter,
          orderBy: ast.orderBy,
          limit: ast.limit,
          offset: ast.offset,
          limitExpr: ast.limitExpr,
          offsetExpr: ast.offsetExpr,
        },
      },
      ctx,
    );
  } finally {
    ctx.aliasResolutionStack.delete(qualified);
  }
};

// Convert a function-call argument AST node into a plain FreeObjectExpr so it
// can stand in for a parameter reference during UDF body inlining. Mirrors the
// per-kind argument handling in the `function_call` IR-build case.
const functionCallArgToFreeObjectExpr = (arg: FunctionCallArgExpr): FreeObjectExpr => {
  if (arg && typeof arg === "object" && "kind" in arg) {
    if (arg.kind === "expr") return arg.expr;
    if (arg.kind === "literal") return { kind: "literal", value: arg.value };
    if (arg.kind === "field_ref") return { kind: "binding_ref", name: arg.field };
    if (arg.kind === "binding_ref") return { kind: "binding_ref", name: arg.name };
    if (arg.kind === "function_call") return { kind: "function_call", call: arg.call };
    if (arg.kind === "parameter") return { kind: "parameter", name: arg.name, castType: arg.castType } as FreeObjectExpr;
    // `a := <expr>` — peel the envelope; the inner arg is what the function sees.
    if (arg.kind === "named_arg") return functionCallArgToFreeObjectExpr(arg.arg);
    // set_literal / array_literal already match FreeObjectExpr kinds.
    return arg as FreeObjectExpr;
  }
  return { kind: "literal", value: null };
};

// Substitute `binding_ref` nodes (by name) inside a FreeObjectExpr tree with
// replacement expressions. Used to inline a UDF body at AST-build time:
// `foo(x: int64) using (x * x)` called as `foo(N)` rewrites the parsed body
// `binding_ref(x) * binding_ref(x)` to `<N> * <N>`. Returns the expr unchanged
// when no parameter reference is present (or the kind isn't handled — in that
// case the inliner skips body attachment and the call falls back to runtime).
const substituteBindingRefsInFreeObjectExpr = (
  expr: FreeObjectExpr,
  substitutions: Map<string, FreeObjectExpr>,
): FreeObjectExpr => {
  const rec = (e: FreeObjectExpr): FreeObjectExpr => substituteBindingRefsInFreeObjectExpr(e, substitutions);
  switch (expr.kind) {
    case "binding_ref": {
      const replacement = substitutions.get(expr.name);
      return replacement ?? expr;
    }
    case "literal":
    case "current_item":
    case "enum_path":
    case "backlink_path":
      return expr;
    case "set_expr":
    case "tuple":
    case "array_literal_expr":
      return { ...expr, values: expr.values.map(rec) };
    case "distinct":
    case "cast":
    case "exists":
    case "not":
    case "unary":
    case "shape_projection":
    case "field_access":
    case "index_access":
    case "slice_access":
      return { ...expr, expr: rec(expr.expr) } as FreeObjectExpr;
    case "compare":
    case "in_expr":
    case "math":
    case "logical":
    case "and":
    case "or":
    case "set_op":
    case "coalesce":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) } as FreeObjectExpr;
    case "concat":
      return { ...expr, parts: expr.parts.map(rec) };
    case "if_else":
      return { ...expr, thenExpr: rec(expr.thenExpr), condition: rec(expr.condition), elseExpr: rec(expr.elseExpr) };
    case "function_call":
      return {
        ...expr,
        call: {
          ...expr.call,
          args: expr.call.args.map((arg) => {
            if (!arg || typeof arg !== "object" || !("kind" in arg)) return arg;
            if (arg.kind === "expr") {
              return { ...arg, expr: rec(arg.expr) };
            }
            // The body AST can hold a parameter reference directly as a
            // binding_ref-shaped FunctionCallArgExpr (not wrapped in `expr`).
            // Substitute by name so nested `inner(x)` calls inside a UDF
            // body pick up the inlined parameter binding.
            if (arg.kind === "binding_ref" && substitutions.has(arg.name)) {
              const replacement = substitutions.get(arg.name)!;
              if (replacement.kind === "binding_ref") return { kind: "binding_ref", name: replacement.name };
              if (replacement.kind === "literal") return { kind: "literal", value: replacement.value };
              if (replacement.kind === "function_call") return { kind: "function_call", call: replacement.call };
              return { kind: "expr", expr: replacement };
            }
            if (arg.kind === "function_call") {
              const inner = rec({ kind: "function_call", call: arg.call });
              if (inner.kind === "function_call") return { kind: "function_call", call: inner.call };
              return { kind: "expr", expr: inner };
            }
            return arg;
          }),
        },
      };
    case "for_expr":
      return { ...expr, iterator: rec(expr.iterator), body: rec(expr.body) };
    default:
      return expr;
  }
};

// Unwrap nested `select_expr` / `select_expr_subquery` wrappers around a body
// expression. UDF bodies parse as `select_expr { expr: <body> }`; the wrapper
// has no effect on the value and gets in the way of inlining.
const unwrapTrivialSelectWrapper = (expr: FreeObjectExpr): FreeObjectExpr | undefined => {
  let cursor: FreeObjectExpr = expr;
  while (true) {
    if (cursor.kind === "select_expr_subquery") {
      cursor = cursor.expr;
      continue;
    }
    return cursor;
  }
};

// Attempt to build an inlined-body Set for a user-defined function call. The
// body becomes the SQL compiler's expression to lower, with parameters
// substituted by the call's argument expressions. Returns undefined when:
//   - the function isn't a user-defined expr-body UDF in the current schema,
//   - more than one overload matches (we don't have type info at AST→IR time
//     to disambiguate; let the runtime path handle it), or
//   - the body uses AST kinds the substitution walker doesn't cover.
const tryBuildInlinedUDFBody = (
  callName: string,
  args: FunctionCallArgExpr[],
  ctx: IRCompileContext,
): Set | undefined => {
  if (!ctx.schema) return undefined;
  const dividerIdx = callName.lastIndexOf("::");
  const moduleName = dividerIdx >= 0 ? callName.slice(0, dividerIdx) : ctx.module;
  const shortName = dividerIdx >= 0 ? callName.slice(dividerIdx + 2) : callName;
  // Skip well-known stdlib modules — those are handled by lowerStdlibFunctionSql.
  if (moduleName === "std" || moduleName === "math" || moduleName === "cal") return undefined;
  const matches = ctx.schema.listFunctions().filter((fn) =>
    fn.module === moduleName && fn.name === shortName,
  );
  if (matches.length !== 1) return undefined;
  const fn = matches[0];
  if (fn.body.kind !== "query") return undefined;
  // Variadic parameters still bail — those need slot-list reshaping the
  // inliner doesn't model yet.
  if (fn.params.some((p) => p.variadic)) return undefined;
  // Split call-site args into positional and named. Named args (`a := X`)
  // bypass positional ordering and bind by parameter name; remaining
  // positional args fill the leading positional / namedOnly-excluded slots
  // in declared order. Anything left over (more positional args than
  // positional slots) is unsupported.
  const positionalArgs: FunctionCallArgExpr[] = [];
  const namedArgs = new Map<string, FunctionCallArgExpr>();
  for (const arg of args) {
    if (arg && typeof arg === "object" && "kind" in arg && arg.kind === "named_arg") {
      namedArgs.set(arg.name, arg.arg);
    } else {
      positionalArgs.push(arg);
    }
  }
  const positionalParams = fn.params.filter((p) => !p.namedOnly);
  if (positionalArgs.length > positionalParams.length) return undefined;
  // Every named arg must match a declared parameter (named-only or not).
  for (const name of namedArgs.keys()) {
    if (!fn.params.some((p) => p.name === name)) return undefined;
  }
  // Parameters not satisfied by either positional or named args need defaults
  // (or must be OPTIONAL — defaultable to empty set).
  let positionalCursor = 0;
  for (const param of fn.params) {
    const isPositionalSlot = !param.namedOnly;
    const filled = (isPositionalSlot && positionalCursor < positionalArgs.length)
      || namedArgs.has(param.name);
    if (isPositionalSlot && positionalCursor < positionalArgs.length) {
      positionalCursor += 1;
    }
    if (!filled && param.default === undefined && !param.optional) return undefined;
  }
  let parsed: EdgeQLStatement;
  try {
    parsed = parseEdgeQL(fn.body.query);
  } catch {
    return undefined;
  }
  if (parsed.kind !== "select_expr") return undefined;
  const bodyExpr = unwrapTrivialSelectWrapper(parsed.expr);
  if (!bodyExpr) return undefined;
  // Compile each call argument to IR exactly once and bind it to a fresh
  // name in a child scope. Replacing param refs with `binding_ref(unique)`
  // means every occurrence in the body resolves (via resolveBinding) to
  // the SAME Set object — which is the signal the SQL co-iteration pass
  // uses to recognize "all `x` references share a source". Without this,
  // `foo(x: int64) using (x*x)` called with `{1,2,3}` would compile two
  // independent union IR nodes for the two `x` references and produce a
  // Cartesian product (9 rows) instead of co-iteration (3 rows).
  const inlineCtx = childScope(ctx);
  const substitutions = new Map<string, FreeObjectExpr>();
  positionalCursor = 0;
  for (const param of fn.params) {
    let argExpr: FreeObjectExpr;
    if (!param.namedOnly && positionalCursor < positionalArgs.length) {
      argExpr = functionCallArgToFreeObjectExpr(positionalArgs[positionalCursor]);
      positionalCursor += 1;
    } else if (namedArgs.has(param.name)) {
      argExpr = functionCallArgToFreeObjectExpr(namedArgs.get(param.name)!);
    } else if (param.default !== undefined) {
      argExpr = { kind: "literal", value: param.default };
    } else {
      // OPTIONAL param without an explicit default: substitute the empty
      // set so the body's body-level set-union behaves correctly (e.g.
      // `{<str>x, y}` with empty x reduces to `{y}`).
      argExpr = { kind: "set_literal", values: [] };
    }
    let argIR: Set;
    try {
      argIR = compileFreeObjectExpr(argExpr, ctx);
    } catch {
      return undefined;
    }
    const uniqueName = `__udf_inline__${shortName}__${param.name}__${inlineCallCounter++}`;
    bindValue(inlineCtx, uniqueName, argIR);
    substitutions.set(param.name, { kind: "binding_ref", name: uniqueName });
  }
  const substituted = substituteBindingRefsInFreeObjectExpr(bodyExpr, substitutions);
  try {
    return compileFreeObjectExpr(substituted, inlineCtx);
  } catch {
    return undefined;
  }
};

let inlineCallCounter = 0;

const compileFreeObjectExpr = (expr: FreeObjectExpr | ComputedExpr, ctx: IRCompileContext): Set => {
  const resolveHeadSet = (name: string): Set => {
    const bound = resolveBinding(ctx, name);
    if (bound) return bound;
    const aliasSet = tryResolveSchemaAliasSet(ctx, name);
    if (aliasSet) return aliasSet;
    return setFromTypeRoot(resolveTypeRef(ctx, name));
  };

  switch (expr.kind) {
    case "set_literal": {
      const result = compileSetConstructor(expr.values.map((value) => literalToSet(value)), "set_literal");
      // Apply the inferred scalar type so downstream `INTROSPECT TYPEOF X` /
      // `X IS T` checks see e.g. `std::float64` instead of `std::anyscalar`.
      const inferred = inferAstExprTypeName(expr, ctx);
      if (inferred && result.typeref?.id === "unknown:std::anyscalar") {
        return { ...result, typeref: unknownTypeRef(inferred) };
      }
      return result;
    }

    case "set_expr": {
      const result = compileSetConstructor(expr.values.map((value) => compileFreeObjectExpr(value, ctx)), "set_expr");
      // Apply the inferred scalar type so downstream `INTROSPECT TYPEOF X` /
      // `X IS T` checks see the promoted type instead of `std::anyscalar`.
      const inferred = inferAstExprTypeName(expr, ctx);
      if (inferred && result.typeref?.id === "unknown:std::anyscalar") {
        return { ...result, typeref: unknownTypeRef(inferred) };
      }
      return result;
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
      const aliasSet = tryResolveSchemaAliasSet(ctx, expr.name);
      if (aliasSet) return aliasSet;
      // Inside a shape body (`SELECT T { x := p2 }`) the surrounding
      // compileShape binds `__subject__` / `__current__` to the source set.
      // A bare name like `p2` should resolve to a field/link on the subject
      // before we fall through to the unknown-type-root marker — otherwise
      // the SQL pipeline never emits the `p2` column and the alias yields a
      // phantom type-reference value.
      const subject = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
      if (subject) {
        const ptrref = resolvePointerRef(ctx, subject.typeref, expr.name);
        if (ptrref) {
          return ptrref.computedLinkAliasIsBackward
            ? extendPathSetDirectional(subject, ptrref, "inbound")
            : extendPathSet(subject, ptrref);
        }
        const computedSet = tryLowerComputedPropertyOnTypePath(ctx, subject, expr.name);
        if (computedSet) return computedSet;
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
      const scoped = withBindings(ctx, expr.clauses._withBindings);
      const bound = resolveBinding(scoped, expr.typeName);
      const aliasSet = bound ? undefined : tryResolveSchemaAliasSet(scoped, expr.typeName);
      if (!bound && !aliasSet && ctx.schema) {
        const qualified = qualifyTypeName(expr.typeName, ctx.module);
        const typeDef = getSchemaType(scoped, qualified) ?? ctx.schema.getType(qualified);
        const universal = isUniversalObjectRefName(expr.typeName);
        if (!typeDef && !universal && !expr.typeName.startsWith("schema::")) {
          throw new AppError(
            "E_SEMANTIC",
            `object type or alias '${qualified}' does not exist`,
            1,
            1,
          );
        }
      }
      const typeref = bound?.typeref ?? aliasSet?.typeref ?? resolveTypeRef(scoped, expr.typeName);
      let root = bound ?? aliasSet ?? setFromTypeRoot(typeref);
      if (expr.shape.length > 0) {
        root = {
          ...root,
          shape: compileShape(root, expr.shape, scoped),
        };
      }
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
      const where = clauses?.filter ? compileFilterExpr(clauses.filter, root, scoped) : undefined;
      return {
        kind: "set",
        expr: {
          kind: "select_expr",
          result: root,
          where,
          orderBy: clauses?.orderBy ? compileSelectOrderExprChain(clauses.orderBy, scoped) : undefined,
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
      const scoped = withBindings(ctx, expr.clauses?._withBindings);
      const inner = compileFreeObjectExpr(expr.expr, scoped);
      // `SELECT alias := X ORDER BY alias` binds `alias` to `X` for the
      // duration of the SELECT's modifiers; the FILTER / ORDER BY clauses
      // need to resolve that name back to the inner expression. Also
      // shadow `__current__`/`__subject__` so leading-dot references
      // (`.number`) inside the FILTER resolve against the subquery's
      // subject rather than the enclosing query's.
      const clauseCtx = childScope(scoped);
      if (expr.alias) {
        bindValue(clauseCtx, expr.alias, inner);
      }
      bindValue(clauseCtx, "__current__", inner);
      bindValue(clauseCtx, "__subject__", inner);
      // Surface the deepest shape on the outer set so
      // `(SELECT X { c := … }).c` and `(SELECT X { c := … } FILTER …).c` both
      // find the computed entry via field_access's shape lookup. The inner
      // shape lives directly on `inner.shape` when the body was a plain
      // shape, or one level deeper inside a `select_expr.result` when FILTER/
      // ORDER BY required wrapping. SQL lowering still reads the shape off
      // the select_expr's `result`, so this is purely a read-side hint.
      const innerShape = inner.shape.length > 0
        ? inner.shape
        : (inner.expr.kind === "select_expr"
            ? (inner.expr as SelectExpr).result.shape
            : []);
      return {
        kind: "set",
        expr: {
          kind: "select_expr",
          result: inner,
          where: expr.filter ? compileFreeObjectExpr(expr.filter, clauseCtx) : undefined,
          orderBy: expr.orderBy ? compileOrderExprChain(expr.orderBy, clauseCtx) : undefined,
          offset: expr.offset === undefined ? undefined : literalToSet(expr.offset),
          limit: expr.limit === undefined ? undefined : literalToSet(expr.limit),
          implicitWrapper: false,
        },
        pathId: defaultPathId("select_expr_subquery"),
        typeref: inner.typeref,
        shape: innerShape,
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
      if (ptrref) {
        return ptrref.computedLinkAliasIsBackward
          ? extendPathSetDirectional(source, ptrref, "inbound")
          : extendPathSet(source, ptrref);
      }
      // No direct pointer / link / backlink — try computed-property
      // substitution before the unknown-type fallback. Lets `Type.computedP`
      // lower as the computed body's expression rather than a phantom
      // `std::anytype` pointer reference.
      const computedSet = tryLowerComputedPropertyOnTypePath(ctx, source, expr.field);
      if (computedSet) return computedSet;
      // A shape attached to `source` may define a *new* computed pointer
      // (e.g. `Person {ok := .name = .tag}`) which the type's schema doesn't
      // declare. Surface that shape element so `P.ok` resolves to its body.
      // Skip splat-expanded entries and pure field/link entries (`{name}`):
      // those expose existing pointers and would normally have been picked
      // up by `resolvePointerRef` above — falling through to them here would
      // change the meaning of the access from "the underlying pointer" to
      // "the projected shape value", which is wrong for cross-product queries
      // that rely on the pointer reaching through to the row source.
      const shapedElement = source.shape?.find(
        (entry) =>
          entry.name !== undefined
          && entry.name === expr.field
          && entry.shapeOrigin === "explicit"
          && entry.targetPtr === undefined
          && !expr.field.startsWith("@"),
      );
      if (shapedElement) return shapedElement.expr;
      // If the source is a direct `Type.field` reference (no intermediate
      // computed/subquery scope) and the field isn't a built-in pseudo-
      // pointer (`id`/`__type__`) or a link property (`@x`), surface a
      // friendly "no link or property" error instead of a phantom
      // `std::anytype` pointer. Limit to the simple type_root-source case so
      // we don't trip on subquery contexts where `.field` should bind to a
      // different subject (the select_expr_subquery handler now sets
      // `__current__` correctly, so the inner `.field` resolves against the
      // subquery's subject and bypasses this check naturally).
      if (
        ctx.schema
        && source.expr.kind === "type_root"
        && expr.field !== "id"
        && expr.field !== "__type__"
        && !expr.field.startsWith("@")
        && !source.typeref.id.startsWith("unknown:")
        && !source.typeref.id.startsWith("std::")
        && !source.typeref.isScalar
        && getResolvedSchemaType(ctx, source.typeref.id)
      ) {
        throw new AppError(
          "E_SEMANTIC",
          `object type '${source.typeref.id}' has no link or property '${expr.field}'`,
          1,
          1,
        );
      }
      // `.foo` on a scalar value (`Issue.number` is scalar, `.x` would be
      // invalid). EdgeQL reports this as "invalid property reference on
      // an expression of primitive type 'T'".
      if (
        ctx.schema
        && source.typeref.isScalar
        && !expr.field.startsWith("@")
        && expr.field !== "id"
        && expr.field !== "__type__"
      ) {
        const typeName = source.typeref.id.startsWith("unknown:")
          ? source.typeref.id.slice("unknown:".length)
          : source.typeref.id;
        throw new AppError(
          "E_SEMANTIC",
          `invalid property reference on an expression of primitive type '${typeName}'`,
          1,
          1,
        );
      }
      return {
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
      // Validate that the index is a non-float numeric. EdgeQL reports the
      // failure as either "cannot index array by 'std::X'" or "cannot index
      // string by 'std::X'", so we surface the source category in the message.
      const indexTypeName = expr.indexExpr
        ? inferAstExprTypeName(expr.indexExpr, ctx)
        : (typeof expr.index === "number"
            ? (Number.isInteger(expr.index) ? "std::int64" : "std::float64")
            : typeof expr.index === "string" ? "std::str" : undefined);
      if (indexTypeName) {
        const cat = typeCategory(indexTypeName);
        const isIntegerNumeric = cat === "numeric"
          && (indexTypeName === "std::int16"
            || indexTypeName === "std::int32"
            || indexTypeName === "std::int64"
            || indexTypeName === "std::bigint");
        if (!isIntegerNumeric) {
          const sourceTypeName = inferAstExprTypeName(expr.expr, ctx);
          const sourceCat = typeCategory(sourceTypeName);
          const targetWord = sourceCat === "str" ? "string"
            : sourceCat === "bytes" ? "bytes"
            : sourceCat === "json" ? "JSON"
            : "array";
          failSemantic(`cannot index ${targetWord} by '${indexTypeName}'`);
        }
      }
      // `1[0]` (int indexed) — index indirection only applies to str/bytes/
      // array/json. Surface the EdgeQL error so `<str>1[0]` (which the
      // parser reads as `<str>(1[0])` because index has higher precedence
      // than cast) reports a useful message.
      const sourceTypeName = inferAstExprTypeName(expr.expr, ctx);
      if (sourceTypeName) {
        const sourceCat = typeCategory(sourceTypeName);
        if (sourceCat !== "str" && sourceCat !== "bytes" && sourceCat !== "json"
            && sourceTypeName !== "std::anytype" && sourceTypeName !== "std::anyscalar"
            && !sourceTypeName.startsWith("array<") && !sourceTypeName.startsWith("tuple<")) {
          failSemantic(`index indirection cannot be applied to '${sourceTypeName}'`);
        }
      }
      const source = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "index_expr",
          expr: source,
          index: expr.indexExpr ? compileFreeObjectExpr(expr.indexExpr, ctx) : literalToSet(expr.index),
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
      const checkSliceBound = (e: FreeObjectExpr | undefined, raw: unknown): void => {
        const t = e
          ? inferAstExprTypeName(e, ctx)
          : (typeof raw === "number"
              ? (Number.isInteger(raw) ? "std::int64" : "std::float64")
              : typeof raw === "string" ? "std::str" : undefined);
        if (!t) return;
        const isIntegerNumeric = t === "std::int16" || t === "std::int32"
          || t === "std::int64" || t === "std::bigint";
        if (!isIntegerNumeric) {
          const sourceTypeName = inferAstExprTypeName(expr.expr, ctx);
          const sourceCat = typeCategory(sourceTypeName);
          const targetWord = sourceCat === "str" ? "string"
            : sourceCat === "bytes" ? "bytes"
            : "array";
          failSemantic(`cannot slice ${targetWord} by '${t}'`);
        }
      };
      checkSliceBound(expr.startExpr, expr.start);
      checkSliceBound(expr.endExpr, expr.end);
      const source = compileFreeObjectExpr(expr.expr, ctx);
      return {
        kind: "set",
        expr: {
          kind: "slice_expr",
          expr: source,
          start: expr.startExpr ? compileFreeObjectExpr(expr.startExpr, ctx) : expr.start === undefined ? undefined : literalToSet(expr.start),
          end: expr.endExpr ? compileFreeObjectExpr(expr.endExpr, ctx) : expr.end === undefined ? undefined : literalToSet(expr.end),
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

    case "literal": {
      const kind = (expr as { numericKind?: "integer" | "float" | "bigint" | "decimal" }).numericKind;
      const set = literalToSet(expr.value);
      if (typeof expr.value === "number" && kind === "float" && set.expr.kind === "integer_constant") {
        // Promote `1.0` to a float constant so `IS float64` / TYPEOF
        // inspection see the parsed lexical kind. `Number.isInteger(1.0)`
        // is true in JS, so without the numericKind hint we'd silently
        // demote whole-number floats to int64.
        return {
          ...set,
          expr: { ...set.expr, kind: "float_constant" },
        };
      }
      if (typeof expr.value === "number" && kind === "decimal") {
        return { ...set, expr: { ...set.expr, kind: "decimal_constant" } };
      }
      if (typeof expr.value === "number" && kind === "bigint") {
        return { ...set, expr: { ...set.expr, kind: "bigint_constant" } };
      }
      return set;
    }

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
      // Compile a single call-site arg into a Set. Named args (`a := X`)
      // wrap their value in a `named_arg` envelope; peel it before compiling
      // so the inner expression is what gets lowered.
      const compileCallArg = (arg: FunctionCallArgExpr): Set => {
        if (arg && typeof arg === "object" && "kind" in arg) {
          if (arg.kind === "named_arg") return compileCallArg(arg.arg);
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
          // Bare-expression args (binding_ref `Issue`, field_access `Issue.x`,
          // tuple `(a, b)`, select `(SELECT …)`, etc.) arrive here without an
          // `{kind:"expr"}` wrapper. They are themselves FreeObjectExprs and
          // must be lowered as such — otherwise we fall through to the null
          // literal and `count(Issue)` becomes count of an empty scalar set.
          return compileFreeObjectExpr(arg as FreeObjectExpr, ctx);
        }
        return literalToSet(null);
      };
      const args = expr.call.args.map(compileCallArg);
      // Inline expr-body UDFs at AST→IR time so the SQL compiler can lower
      // the call as if the body were written inline (substituting parameter
      // references with the actual argument expressions). Falls back to a
      // body-less function_call IR when the function isn't a known UDF or
      // the body shape isn't supported — the runtime path picks that up.
      const inlinedBody = tryBuildInlinedUDFBody(expr.call.name, expr.call.args, ctx);
      // Use the inferred return type so downstream type-check operations
      // (`X IS float64`, `INTROSPECT TYPEOF X`) can resolve common stdlib
      // function results instead of seeing `std::anytype`. Falls back to
      // anytype when we don't know the function's return shape.
      const inferredReturnTypeName = inferAstExprTypeName(expr, ctx);
      const callTyperef = inferredReturnTypeName
        ? unknownTypeRef(inferredReturnTypeName)
        : unknownTypeRef("std::anytype");
      return {
        kind: "set",
        expr: {
          kind: "function_call",
          functionName: expr.call.name,
          args: Object.fromEntries(args.map((arg, index) => [String(index), mkCallArg(arg)])),
          volatility: "stable",
          typeref: callTyperef,
          preservesUpperCardinality: false,
          body: inlinedBody,
          extras: {
            backendName: expr.call.name,
            funcPolymorphic: false,
          },
        },
        pathId: defaultPathId(`fn:${expr.call.name}`),
        typeref: callTyperef,
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
      // Reject incompatible-type comparisons (`<int64>1 = <str>'a'`, etc.) so
      // they raise "operator 'X' cannot be applied to operands of type 'Y' and
      // 'Z'" rather than silently returning false from SQLite.
      const leftType = inferAstExprTypeName(expr.left, ctx);
      const rightType = inferAstExprTypeName(expr.right, ctx);
      if (leftType && rightType && !areCompareCompatible(leftType, rightType)) {
        failSemantic(
          `operator '${expr.op}' cannot be applied to operands of type '${leftType}' and '${rightType}'`,
        );
      }
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

    case "in_expr": {
      // Unwrap `<T>{...}` casts wrapping a set literal so the empty-set
      // identity / OR-chain reduction below still applies. `<int64>{}` is
      // semantically the empty set of int64s, which `IN` evaluates to
      // FALSE / NOT IN to TRUE.
      let rhs: FreeObjectExpr = expr.right;
      while (rhs.kind === "cast") {
        rhs = (rhs as { expr: FreeObjectExpr }).expr;
      }
      const members = rhs.kind === "set_literal"
        ? rhs.values.map((value): FreeObjectExpr => ({ kind: "literal", value }))
        : rhs.kind === "set_expr"
          ? rhs.values
          : undefined;
      if (members) {
        const lhsIsSet = expr.left.kind === "set_expr" || expr.left.kind === "set_literal";
        if (members.length === 0) {
          // `1 IN {}` is vacuously false; `1 NOT IN {}` is vacuously true.
          // When the LHS is a set, the result is a set of per-element bools;
          // fall through to the operator_call path so SQL emits one row per
          // element of the LHS instead of collapsing to a single literal.
          if (!lhsIsSet) {
            return compileFreeObjectExpr({ kind: "literal", value: expr.op === "not_in" }, ctx);
          }
          // else fall through to operator_call below
        } else if (!lhsIsSet) {
          const orChain: FreeObjectExpr = members.reduceRight((acc, value, idx) => {
            const eq: FreeObjectExpr = { kind: "compare", op: "=", left: expr.left, right: value };
            return idx === members.length - 1 ? eq : { kind: "or", left: eq, right: acc };
          }, undefined as unknown as FreeObjectExpr);
          const result: FreeObjectExpr = expr.op === "not_in" ? { kind: "not", expr: orChain } : orChain;
          return compileFreeObjectExpr(result, ctx);
        }
      }
      // Singleton-RHS form (array literal, tuple, scalar): `A IN B` → `A = B`.
      const singletonRhs = expr.right.kind === "array_literal_expr"
        || expr.right.kind === "tuple"
        || expr.right.kind === "literal"
        || expr.right.kind === "cast";
      if (singletonRhs) {
        const compareOp = expr.op === "in" ? "=" : "!=";
        return compileFreeObjectExpr(
          { kind: "compare", op: compareOp, left: expr.left, right: expr.right },
          ctx,
        );
      }
      // Path/binding RHS form (`X IN Y` where Y is a set produced by a path,
      // binding, or subquery): build an `operator_call` IR node so the SQL
      // compiler — which already handles `in`/`not in` over compiled value
      // SELECTs — can lower it as `(<left> IN (<right>))`.
      const leftSet = compileFreeObjectExpr(expr.left, ctx);
      const rightSet = compileFreeObjectExpr(expr.right, ctx);
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op === "in" ? "in" : "not in",
          args: { "0": mkCallArg(leftSet), "1": mkCallArg(rightSet) },
          returning: unknownTypeRef("std::bool"),
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId(`std::${expr.op}`),
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
      // Reject unary -/+/NOT on operands whose declared type cannot accept it,
      // matching EdgeQL's "operator 'X' cannot ... 'std::Y'" error.
      const innerTypeName = inferAstExprTypeName(expr.expr, ctx);
      if (innerTypeName) {
        if ((expr.op === "neg" || expr.op === "pos") && !canApplyUnaryArith(innerTypeName)) {
          const sym = expr.op === "neg" ? "-" : "+";
          failSemantic(`operator '${sym}' cannot be applied to operand of type '${innerTypeName}'`);
        }
        if (expr.op === "not" && innerTypeName !== "std::bool") {
          failSemantic(`operator 'NOT' cannot be applied to operand of type '${innerTypeName}'`);
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
      // Reject incompatible-type arithmetic (`<int64>1 + <str>'a'`, etc.) so it
      // raises "operator 'X' cannot be applied to operands of type 'Y' and 'Z'"
      // rather than silently coercing in SQLite.
      const mathLeftType = inferAstExprTypeName(expr.left, ctx);
      const mathRightType = inferAstExprTypeName(expr.right, ctx);
      if (mathLeftType && mathRightType && !areArithCompatible(mathLeftType, mathRightType)) {
        const opSym = expr.op === "add" ? "+"
          : expr.op === "sub" ? "-"
          : expr.op === "mul" ? "*"
          : expr.op === "div" ? "/"
          : expr.op === "mod" ? "%"
          : expr.op === "pow" ? "^"
          : expr.op === "floor_div" ? "//"
          : expr.op;
        failSemantic(
          `operator '${opSym}' cannot be applied to operands of type '${mathLeftType}' and '${mathRightType}'`,
        );
      }
      const left = compileFreeObjectExpr(expr.left, ctx);
      const right = compileFreeObjectExpr(expr.right, ctx);
      // Use the AST-level numeric promotion so `INTROSPECT TYPEOF(a + b)`
      // and `a + b IS T` see the promoted result type instead of `left`'s.
      const promotedTypeName = inferAstExprTypeName(expr, ctx);
      const promotedTyperef = promotedTypeName ? unknownTypeRef(promotedTypeName) : left.typeref;
      return {
        kind: "set",
        expr: {
          kind: "operator_call",
          operator: expr.op,
          args: { "0": mkCallArg(left), "1": mkCallArg(right) },
          returning: promotedTyperef,
          volatility: "immutable",
        } as OperatorCall,
        pathId: defaultPathId("std::math"),
        typeref: promotedTyperef,
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
      if (
        expr.variable === "__gel_backlink_item__"
        && expr.body.kind === "backlink_path"
        && !expr.filter
        && !expr.orderBy
        && expr.limit === undefined
        && expr.offset === undefined
      ) {
        const iterator = compileFreeObjectExpr(expr.iterator, ctx);
        const ptrref = resolveBacklinkPointerRef(ctx, iterator.typeref, expr.body.link, expr.body.sourceType);
        if (ptrref) {
          const out = extendPathSetDirectional(iterator, ptrref, "inbound");
          return expr.body.optional
            ? {
                ...out,
                expr: {
                  ...(out.expr as Pointer),
                  optionalDeref: true,
                },
              }
            : out;
        }
      }
      const rawIterator = compileFreeObjectExpr(expr.iterator, ctx);
      // Namespace the iterator's pathId so the body can distinguish references
      // to the iteration binding (e.g. `C`) from fresh references to the same
      // type (e.g. `Card`) — without this, both produce identical pathIds and
      // the SQL compiler can't tell them apart for cross-product semantics.
      const iterScopeTag = `for:${expr.variable}:${ctx.nextScopeId++}`;
      const iterator: Set = {
        ...rawIterator,
        pathId: {
          ...rawIterator.pathId,
          namespace: [...(rawIterator.pathId?.namespace ?? []), iterScopeTag],
        },
      };
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
        // Fall through to the generic type_cast emission below so the SQL
        // pipeline produces a real `CAST(<inner> AS TEXT)` wrapper; otherwise
        // an int-valued inner survives unchanged and the runtime ends up
        // formatting it via SQLite's default REAL coercion (e.g. `99` →
        // `'99.0'`).
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
      const elementType = values[0]?.typeref ?? { id: "std::anytype", nameHint: "anytype", module: "std", isView: false, isScalar: false, isAbstract: false } as TypeRef;
      const arrayTypeRef: TypeRef = {
        kind: "type_ref",
        id: `array<${elementType.id}>`,
        nameHint: `array<${elementType.nameHint}>`,
        module: "std",
        isView: false,
        isScalar: false,
        isAbstract: false,
        collection: "array",
        subtypes: [elementType],
      };
      return {
        kind: "set",
        expr: {
          kind: "array",
          elements: values,
          typeref: arrayTypeRef,
        },
        pathId: defaultPathId("array_literal"),
        typeref: arrayTypeRef,
        shape: [],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
    }

    case "mutation_expr": {
      // Parser wraps `(delete X filter …)` / `(insert X …)` / `(update X …)`
      // when they appear in expression positions (e.g. as a FOR iterator).
      // Lower to the value-level mutation expr Set so callers can treat
      // it like any other set producer.
      const stmt = expr.statement;
      const scoped = withBindings(ctx, stmt.with);
      if (stmt.kind === "delete") {
        const typeref = resolveTypeRef(scoped, stmt.typeName);
        const subject = setFromTypeRoot(typeref);
        bindValue(scoped, "__subject__", subject);
        bindValue(scoped, "__current__", subject);
        const where = compileFilterToSet(stmt.filter, subject, scoped);
        return {
          kind: "set",
          expr: {
            kind: "delete_expr",
            subject: typeref,
            where,
          } as DeleteExpr,
          pathId: defaultPathId(`delete:${stmt.typeName}`),
          typeref,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        };
      }
      if (stmt.kind === "insert") {
        const typeref = resolveTypeRef(scoped, stmt.typeName);
        const subjectSet = setFromTypeRoot(typeref);
        bindValue(scoped, "__subject__", subjectSet);
        bindValue(scoped, "__current__", subjectSet);
        const shape: ShapeElement[] = Object.entries(stmt.values).map(([name, value]) => {
          const ptrref = resolvePointerRef(scoped, typeref, name);
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
          kind: "set",
          expr: { kind: "insert_expr", subject: typeref, shape } as InsertExpr,
          pathId: defaultPathId(`insert:${stmt.typeName}`),
          typeref,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        };
      }
      if (stmt.kind === "update") {
        const typeref = resolveTypeRef(scoped, stmt.typeName);
        const subjectSet = setFromTypeRoot(typeref);
        bindValue(scoped, "__subject__", subjectSet);
        bindValue(scoped, "__current__", subjectSet);
        const shape: ShapeElement[] = Object.entries(stmt.values).map(([name, value]) => {
          const ptrref = resolvePointerRef(scoped, typeref, name);
          return {
            kind: "shape_element",
            source: subjectSet,
            expr: compileInsertValue(value, scoped),
            targetPtr: ptrref,
            shapeOp: stmt.operations?.[name] ?? "assign",
            shapeOrigin: "explicit",
            required: ptrref?.outCardinality === "one",
            cardinality: ptrref?.outCardinality ?? "unknown",
          };
        });
        const where = compileFilterToSet(stmt.filter, subjectSet, scoped);
        return {
          kind: "set",
          expr: { kind: "update_expr", subject: typeref, where, shape } as UpdateExpr,
          pathId: defaultPathId(`update:${stmt.typeName}`),
          typeref,
          shape: [],
          isBinding: false,
          isMaterializedRef: false,
          isSchemaAlias: false,
        };
      }
      throw new AppError("E_RUNTIME", `AST->IR mutation kind '${(stmt as { kind: string }).kind}' not supported in expression position`, 1, 1);
    }

    case "introspect_typeof": {
      // `INTROSPECT TYPEOF expr` resolves to the schema type of `expr`. We
      // don't model schema::Type fully, but the only test patterns we see
      // ultimately read `.name` off the result. Build a synthetic set whose
      // shape exposes `name` as a string literal carrying the inferred type
      // — the shape lookup in field_access surfaces it as the answer to
      // `(INTROSPECT TYPEOF x).name`. Falling back to `anytype` keeps the
      // shape consistent when type inference is incomplete; the test
      // harness still compares strings.
      let typeName = inferAstExprTypeName(expr.expr, ctx);
      if (!typeName && expr.expr.kind === "binding_ref") {
        // Resolve the binding's compiled set typeref so
        // `WITH A := {1.0, 2.0}; INTROSPECT TYPEOF A` sees float64 instead
        // of anytype.
        const bound = resolveBinding(ctx, expr.expr.name);
        if (bound) {
          const id = bound.typeref?.id ?? bound.typeref?.nameHint;
          const stripped = id?.startsWith("unknown:") ? id.slice("unknown:".length) : id;
          if (stripped) typeName = stripped;
        }
      }
      typeName = typeName ?? "std::anytype";
      const typeref = unknownTypeRef("schema::Type");
      const nameSet = literalToSet(typeName);
      const root: Set = {
        kind: "set",
        expr: { kind: "type_root", typeref } as TypeRoot,
        pathId: defaultPathId("introspect_typeof"),
        typeref,
        shape: [
          {
            kind: "shape_element",
            source: { kind: "set", expr: { kind: "type_root", typeref } as TypeRoot, pathId: defaultPathId("introspect_typeof"), typeref, shape: [], isBinding: false, isMaterializedRef: false, isSchemaAlias: false },
            expr: nameSet,
            shapeOp: "assign",
            shapeOrigin: "explicit",
            required: true,
            cardinality: "one",
            name: "name",
          },
        ],
        isBinding: false,
        isMaterializedRef: false,
        isSchemaAlias: false,
      };
      return root;
    }

    case "set_op": {
      // `intersect`/`except` lower into operator_call nodes the SQL compiler
      // recognises (it already handles `union` similarly). Building the IR
      // here at least lets these queries reach the SQL layer rather than
      // throwing during AST→IR.
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
        pathId: defaultPathId(`set_op:${expr.op}`),
        typeref: left.typeref,
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
  return compileOrderExprChain(statement.orderBy, ctx);
};

const compileOrderExprChain = (orderBy: OrderExprChain, ctx: IRCompileContext): SortExpr[] => {
  const out: SortExpr[] = [];
  let cursor: OrderExprChain | undefined = orderBy;
  while (cursor) {
    out.push({
      kind: "sort_expr",
      path: compileFreeObjectExpr(cursor.expr, ctx),
      direction: cursor.direction,
      nonesOrder: "last",
    });
    cursor = cursor.then;
  }
  return out;
};

const compileSelectOrderExprChain = (orderBy: OrderExpr, ctx: IRCompileContext): SortExpr[] => {
  const out: SortExpr[] = [];
  let cursor: OrderExpr | undefined = orderBy;
  while (cursor) {
    out.push({
      kind: "sort_expr",
      path: cursor.expr
        ? compileFreeObjectExpr(cursor.expr, ctx)
        : compileFreeObjectExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__current__" }, field: cursor.field, optional: false }, ctx),
      direction: cursor.direction,
      nonesOrder: cursor.nullsPosition ?? "last",
    });
    cursor = cursor.then;
  }
  return out;
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
    // `FILTER number = …` (no leading dot) — EdgeQL treats this as a free
    // reference to a type/alias named "number", not as an implicit field on
    // the subject. If the parser tagged it bareName and we can confirm no
    // such type/alias/binding exists, surface the friendlier EdgeQL error.
    if ("bareName" in target && target.bareName && !target.field.includes(".")) {
      const name = target.field;
      if (
        !resolveBinding(ctx, name)
        && ctx.schema
      ) {
        const qualified = qualifyTypeName(name, ctx.module);
        const typeDef = getSchemaType(ctx, qualified) ?? ctx.schema.getType(qualified);
        if (!typeDef && !isUniversalObjectRefName(name)) {
          throw new AppError(
            "E_SEMANTIC",
            `object type or alias '${qualified}' does not exist`,
            1,
            1,
          );
        }
      }
    }
    const segments = target.field.split(".");
    let result = subject;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const ptrref = resolvePointerRef(ctx, result.typeref, segment);
      if (!ptrref) {
        // `.field` against a known schema type — surface the "no link or
        // property" error so typos in FILTER don't silently match nothing.
        // Skip when this is the leading segment and the name happens to
        // alias a known type/binding (`FILTER User = Issue.watchers`).
        const isLeading = i === 0;
        const aliasedToBinding = isLeading && resolveBinding(ctx, segment);
        const aliasedToType = isLeading && ctx.schema && (getSchemaType(ctx, segment) ?? ctx.schema.getType(qualifyTypeName(segment, ctx.module)));
        if (
          ctx.schema
          && !aliasedToBinding
          && !aliasedToType
          && segment !== "id"
          && segment !== "__type__"
          && !segment.startsWith("@")
          && !result.typeref.id.startsWith("unknown:")
          && !result.typeref.id.startsWith("std::")
          && !result.typeref.isScalar
          && getResolvedSchemaType(ctx, result.typeref.id)
        ) {
          throw new AppError(
            "E_SEMANTIC",
            `object type '${result.typeref.id}' has no link or property '${segment}'`,
            1,
            1,
          );
        }
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
  // Bind the filter's subject so leading-dot paths inside the filter
  // (e.g. `.name`, `.deck`) resolve against the subject set rather than
  // bailing to `null` and producing pointer-on-null IR. The bindings live
  // in a child scope so they don't leak past the filter.
  const filterCtx = childScope(ctx);
  bindValue(filterCtx, "__current__", subject);
  bindValue(filterCtx, "__subject__", subject);
  if (filter.kind === "free_expr") {
    return compileFreeObjectExpr(filter.expr, filterCtx);
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
          : filter.values.kind === "expr_set"
            ? compileSetConstructor(filter.values.values.map((value) => compileFreeObjectExpr(value, ctx)), "filter:in:expr_set")
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

// Decide whether to surface a "no link or property 'X'" error for a shape
// element whose name failed to resolve against `subject`'s type. Only fires
// when the subject is a real, schema-resolvable object type — synthesized
// containers (`unknown:*`, anytype, tuple wrappers, computed alias targets)
// have no enumerable member list and so we can't tell if the spelling is
// wrong vs. dynamically added.
const shouldEnforceShapeMember = (
  el: EdgeQLShapeElement,
  subject: Set,
  ctx: IRCompileContext,
): boolean => {
  if (!("name" in el) || !el.name || el.name.startsWith("@")) return false;
  if (el.name === "id" || el.name === "__type__") return false;
  if ("origin" in el && el.origin && el.origin !== "explicit") return false;
  const typeId = subject.typeref.id;
  if (typeId.startsWith("unknown:") || typeId.startsWith("std::")) return false;
  if (subject.typeref.isScalar) return false;
  if (!getResolvedSchemaType(ctx, typeId)) return false;
  return true;
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

// Heuristic: does the compiled IR set look like it can yield more than one
// row? Used to set a sensible default cardinality on computed shape elements
// (`owner_of := X.<owner[IS Y]`) where the AST doesn't carry an explicit
// `multi`/`single` modifier.
const inferComputedShapeIsMany = (set: Set): boolean => {
  let cur: Set | undefined = set;
  while (cur) {
    const expr = cur.expr;
    if (expr.kind === "pointer") {
      const ptr = expr as Pointer;
      if (ptr.direction === "inbound") return true;
      if (ptr.ptrref.outCardinality === "many" || ptr.ptrref.outCardinality === "at_least_one") return true;
      cur = ptr.source;
      continue;
    }
    if (expr.kind === "select_expr") {
      const se = expr as SelectExpr;
      // A bare `SELECT T { … } FILTER …` (no LIMIT *at any nesting level*) over
      // a type_root is many-cardinality. Peel through nested select_expr layers
      // (parens-induced) to find the innermost result; if any layer carries a
      // LIMIT, the chain collapses to single.
      let cursor: Set = se.result;
      let foundLimit = !!se.limit;
      while (cursor.expr.kind === "select_expr") {
        const inner = cursor.expr as SelectExpr;
        if (inner.limit) foundLimit = true;
        cursor = inner.result;
      }
      if (!foundLimit && cursor.expr.kind === "type_root") {
        return true;
      }
      cur = cursor;
      continue;
    }
    return false;
  }
  return false;
};

// Build a shape element for `__type__: { … }`. The SQL compiler keys off the
// `shape_element.targetPtr.shortName === "__type__"` marker (we tag the
// element name accordingly) to emit a synthetic json_object from the row's
// `__source_type` column without trying to JOIN a non-existent table.
const synthesizeTypeLinkShapeElement = (
  subject: Set,
  el: Extract<EdgeQLShapeElement, { kind: "link" }>,
): ShapeElement => {
  const typeRef: TypeRef = {
    kind: "type_ref",
    id: "schema::ObjectType",
    nameHint: "schema::ObjectType",
    module: "schema",
    isView: false,
    isScalar: false,
    isAbstract: false,
    inSchema: false,
  };
  const ptrref: PointerRef = {
    kind: "pointer_ref",
    id: `${subject.typeref.id}.link::__type__`,
    name: "__type__",
    shortName: "__type__",
    outSource: subject.typeref,
    outTarget: typeRef,
    outCardinality: "one",
    inCardinality: "many",
    isComputed: false,
    isIdPointer: false,
    isLinkProperty: false,
    hasProperties: false,
  };
  const childNames = (el.shape ?? [])
    .map((child) => (child.kind === "field" || child.kind === "computed" || child.kind === "link" || child.kind === "backlink") ? child.name : "")
    .filter((name) => name && !name.startsWith("@"));
  const exprSet: Set = {
    kind: "set",
    expr: {
      kind: "pointer",
      source: subject,
      ptrref,
      direction: "outbound",
      isDefinition: false,
    } as Pointer,
    pathId: defaultPathId(`${subject.typeref.id}.__type__`),
    typeref: typeRef,
    shape: [],
    isBinding: false,
    isMaterializedRef: false,
    isSchemaAlias: false,
  };
  return {
    kind: "shape_element",
    source: subject,
    expr: exprSet,
    shapeOp: el.operation,
    shapeOrigin: "explicit",
    required: false,
    cardinality: "at_most_one",
    name: el.name,
    targetPtr: ptrref,
    // Carry the user's requested sub-fields on the shape element via a side
    // channel so the SQL compiler can pick from a fixed map (name, id).
    syntheticTypeFields: childNames,
  } as ShapeElement & { syntheticTypeFields: string[] };
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

  // Reject `Type { foo, foo }` and `Type { foo, foo := … }` against the same
  // object. The shape syntax has no semantics for two siblings sharing a name;
  // the same expression-list quirk used to silently accept it.
  const seenExplicit = new globalThis.Set<string>();
  for (const el of shape) {
    if (el.kind !== "field" && el.kind !== "link" && el.kind !== "computed" && el.kind !== "backlink") continue;
    if (!el.name || el.name.startsWith("@")) continue;
    if (el.origin && el.origin !== "explicit") continue;
    if (seenExplicit.has(el.name)) {
      const probe = resolvePointerRef(ctx, subject.typeref, el.name);
      const memberKind = probe && !probe.outTarget.isScalar ? "link" : "property";
      throw new AppError(
        "E_SEMANTIC",
        `duplicate definition of ${memberKind} '${el.name}' of object type '${subject.typeref.id}'`,
        1,
        1,
      );
    }
    seenExplicit.add(el.name);
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
        // Schema-declared property computeds aren't surfaced by resolvePointerRef
        // (they aren't pointers, they're substituted expressions). Try lowering
        // the computed body before surfacing the "no such property" error so
        // `SELECT Publication { title1 }` works when title1 := (SELECT ident(.title)).
        const computedSet = tryLowerComputedPropertyOnTypePath(ctx, subject, el.name);
        if (computedSet) {
          // Pull cardinality/required hints from the schema's computed declaration:
          // `multi title5 := …` produces a multi shape element, even when the query
          // doesn't repeat the modifier.
          const computedDecl = ctx.schema
            ?.getType(subject.typeref.id)
            ?.computeds
            ?.find((c) => c.kind === "property" && c.name === el.name);
          const declMulti = computedDecl?.multi === true;
          const declRequired = computedDecl?.required === true;
          const inferredMulti = declMulti || computedSet.typeref.collection === "array";
          const cardinality: Cardinality = inferredMulti
            ? (declRequired ? "at_least_one" : "many")
            : (declRequired ? "one" : "at_most_one");
          out.push({
            kind: "shape_element",
            source: subject,
            expr: withShapeModifiers(computedSet, el),
            name: el.name,
            shapeOp: el.operation,
            shapeOrigin: resolveShapeOrigin(el),
            required: el.required ?? declRequired,
            cardinality: el.cardinality ?? cardinality,
          });
          continue;
        }
        // `SELECT User { missing }` — user spelled a field name that doesn't
        // exist on the source type. Silently skipping turned every typo into
        // an empty-but-passing shape; surface it so query authors learn at
        // compile time. Guarded: `id`/`__type__` are implicit on every object
        // and resolved by the SQL projection itself; non-schema types
        // (`unknown:*`, tuple wrappers, computed binding aliases) don't have a
        // resolvable member list, so we can't tell whether the field is real.
        if (shouldEnforceShapeMember(el, subject, ctx)) {
          throw new AppError(
            "E_SEMANTIC",
            `object type '${subject.typeref.id}' has no link or property '${el.name}'`,
            1,
            1,
          );
        }
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
          name: el.name,
        });
        continue;
      }
      const computedCtx = childScope(ctx);
      bindValue(computedCtx, "__subject__", subject);
      bindValue(computedCtx, "__current__", subject);
      const compiledExpr = compileFreeObjectExpr(el.expr, computedCtx);
      // Computed shape elements without an explicit `multi`/`single` mod
      // used to default to `at_most_one`, which made `owner_of := X.<owner`
      // collapse to a single object even when the backlink fans out. Sniff
      // the compiled expression for a clearly-many shape (backlink, multi
      // pointer, link-table walk) and use `many` instead.
      const inferredMany = inferComputedShapeIsMany(compiledExpr);
      out.push({
        kind: "shape_element",
        source: subject,
        expr: withShapeModifiers(compiledExpr, el),
        shapeOp: el.operation,
        shapeOrigin: resolveShapeOrigin(el),
        required: el.required ?? false,
        cardinality: el.cardinality ?? (el.multi || inferredMany ? "many" : "at_most_one"),
        name: el.name,
      });
      continue;
    }

    if (el.kind === "link") {
      // `__type__: { name }` — every object has an implicit link to its
      // schema::ObjectType. We don't materialize that type, but the source
      // row's __source_type column already carries the qualified type name,
      // so synthesize a shape element with a marker ptrref that the SQL
      // compiler unwraps into a tiny json_object.
      if (el.name === "__type__") {
        out.push(synthesizeTypeLinkShapeElement(subject, el));
        continue;
      }
      const ptrref = resolvePointerRef(ctx, subject.typeref, el.name);
      // `User { todo: { name: { bogus } } }` — `name` is a scalar so it
      // can't carry a nested shape. EdgeQL reports this as
      // "shapes cannot be applied to scalar type 'std::str'".
      if (ptrref && ptrref.outTarget.isScalar && el.shape && el.shape.length > 0) {
        throw new AppError(
          "E_SEMANTIC",
          `shapes cannot be applied to scalar type '${ptrref.outTarget.id.startsWith("unknown:") ? ptrref.outTarget.id.slice("unknown:".length) : ptrref.outTarget.id}'`,
          1,
          1,
        );
      }
      if (!ptrref) {
        // Links with nested shapes can resolve dynamically (subtype-only
        // pointers reached through `[IS T]`, computed link aliases, etc.) —
        // skip the strict check here. The field-level check above is enough
        // to catch the common typo case.
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

// EdgeQL semantics treat `SELECT AliasName { shape } FILTER outer` as if
// `AliasName` were textually replaced by its body. We perform that expansion
// once at the AST level so the rest of compilation never has to know that
// `AliasName` was an alias: typeName becomes the alias's source type, the
// alias body's filter is AND'd with the outer filter, the alias body's
// computed/link shape elements replace outer field references of the same
// name (so the outer can project an alias-defined field by name), and any
// outer-unset orderBy/limit/offset is inherited from the alias body.
// Recursive aliases are detected via the `visited` set.
export const expandSchemaAliasesInStatement = (
  statement: EdgeQLStatement,
  schema: SchemaSnapshot,
  defaultModule = "default",
): EdgeQLStatement => {
  const ctx: IRCompileContext = {
    module: (statement as { withModule?: string }).withModule ?? defaultModule,
    schema,
    nextScopeId: 1,
    params: new Map(),
    globals: new Map(),
    bindingScopes: [new Map()],
  };
  if (statement.kind === "select") {
    return expandAliasInSelectStatement(statement, ctx, new globalThis.Set<string>());
  }
  if (statement.kind === "select_free") {
    return {
      ...statement,
      entries: statement.entries.map((entry) => ({
        ...entry,
        expr: expandAliasInFreeObjectExpr(entry.expr, ctx),
      })),
    };
  }
  if (statement.kind === "select_expr") {
    return {
      ...statement,
      expr: expandAliasInFreeObjectExpr(statement.expr, ctx),
    };
  }
  return statement;
};

const expandAliasInFreeObjectExpr = (
  expr: FreeObjectExpr,
  ctx: IRCompileContext,
): FreeObjectExpr => {
  if (expr.kind === "select_expr_subquery") {
    return { ...expr, expr: expandAliasInFreeObjectExpr(expr.expr, ctx) };
  }
  if (expr.kind === "field_access") {
    return { ...expr, expr: expandAliasInFreeObjectExpr(expr.expr, ctx) };
  }
  if (expr.kind === "select") {
    const synthetic: SelectStatement = {
      kind: "select",
      with: expr.clauses._withBindings,
      withModule: expr.clauses._withModule,
      withModuleAliases: expr.clauses._withModuleAliases,
      typeName: expr.typeName,
      shape: expr.shape,
      fields: [],
      filter: expr.clauses.filter,
      orderBy: expr.clauses.orderBy,
      limit: expr.clauses.limit,
      offset: expr.clauses.offset,
      limitExpr: expr.clauses.limitExpr,
      offsetExpr: expr.clauses.offsetExpr,
      pos: { line: 0, column: 0 },
    };
    const expanded = expandAliasInSelectStatement(synthetic, ctx, new globalThis.Set<string>());
    return {
      kind: "select",
      typeName: expanded.typeName,
      shape: expanded.shape,
      clauses: {
        ...expr.clauses,
        filter: expanded.filter,
        orderBy: expanded.orderBy,
        limit: expanded.limit,
        offset: expanded.offset,
        limitExpr: expanded.limitExpr,
        offsetExpr: expanded.offsetExpr,
        _withBindings: expanded.with ?? expr.clauses._withBindings,
        _withModule: expanded.withModule ?? expr.clauses._withModule,
        _withModuleAliases: expanded.withModuleAliases ?? expr.clauses._withModuleAliases,
      },
    };
  }
  return expr;
};

// Walk a FreeObjectExpr, replacing each `current_item` node with `newRoot`.
// Used when inlining a shape-defined computed expression into a FILTER path: a
// computed like `name_upper := str_upper(.name)` is written against the
// computed link's target (`.name` is relative to a winner row), so when we lift
// it into the outer FILTER scope (`.winner.name_upper = ...`) we have to
// rebind `.name` to `.winner.name`.
const substituteCurrentItemInFreeExpr = (
  expr: FreeObjectExpr,
  newRoot: FreeObjectExpr,
): FreeObjectExpr => {
  const rec = (e: FreeObjectExpr): FreeObjectExpr => substituteCurrentItemInFreeExpr(e, newRoot);
  switch (expr.kind) {
    case "current_item":
      return newRoot;
    case "field_access":
      return { ...expr, expr: rec(expr.expr) };
    case "function_call":
      return {
        ...expr,
        call: {
          ...expr.call,
          args: expr.call.args.map((arg) => {
            if (arg.kind === "expr") return { ...arg, expr: rec(arg.expr) };
            if (arg.kind === "function_call") {
              const innerCall = substituteCurrentItemInFreeExpr({ kind: "function_call", call: arg.call }, newRoot);
              return innerCall.kind === "function_call" ? { kind: "function_call", call: innerCall.call } : arg;
            }
            return arg;
          }),
        },
      };
    case "compare":
    case "math":
    case "and":
    case "or":
    case "coalesce":
      return { ...expr, left: rec(expr.left), right: rec(expr.right) };
    case "not":
    case "exists":
    case "distinct":
    case "cast":
    case "unary":
      return { ...expr, expr: rec(expr.expr) };
    case "if_else":
      return { ...expr, condition: rec(expr.condition), thenExpr: rec(expr.thenExpr), elseExpr: rec(expr.elseExpr) };
    case "concat":
      return { ...expr, parts: expr.parts.map(rec) };
    case "tuple":
    case "set_expr":
    case "array_literal_expr":
      return { ...expr, values: expr.values.map(rec) };
    case "index_access":
    case "slice_access":
    case "shape_projection":
    case "is_type":
      return { ...expr, expr: rec(expr.expr) };
    default:
      // Other kinds (literal, binding_ref, path, etc.) carry no current_item
      // references in well-formed shape-computed bodies.
      return expr;
  }
};

// Convert a parser FilterValue into the FreeObjectExpr form `compare` accepts.
// Returns undefined for value shapes we can't inline (set literals, sub-selects
// inside the comparison RHS — the existing predicate path handles those).
const filterValueToFreeObjectExpr = (value: FilterValue): FreeObjectExpr | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return { kind: "literal", value };
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  if (typeof value === "object" && value !== null && "kind" in value) {
    if (value.kind === "binding_ref") {
      return { kind: "binding_ref", name: value.name };
    }
  }
  return undefined;
};

// Pull the inner shape from a `winner := <expr> { ... }` style computed body.
const innerShapeOfComputedBody = (
  body: ComputedExpr | FreeObjectExpr,
): EdgeQLShapeElement[] | undefined => {
  if ((body as { kind?: string }).kind === "select_expr") {
    return innerShapeOfComputedBody((body as { expr: FreeObjectExpr }).expr);
  }
  if ((body as { kind?: string }).kind === "shape_projection") {
    return (body as { shape: EdgeQLShapeElement[] }).shape;
  }
  return undefined;
};

// Substitute alias-defined shape computeds into a FILTER expression so the
// rewritten filter compiles through the standard SQL path. Specifically: a
// FILTER target like `linkName.fieldName` where `linkName` is a computed shape
// element on the surrounding select and `fieldName` is a computed property in
// its inner shape gets lifted into the equivalent free-expression form
// (`<inner-computed-expr-with-current_item→linkName>` `op` `value`).
export const rewriteFilterThroughShapeComputeds = (
  filter: FilterExpr,
  shape: EdgeQLShapeElement[],
): FilterExpr => {
  if (filter.kind === "and" || filter.kind === "or") {
    return {
      ...filter,
      left: rewriteFilterThroughShapeComputeds(filter.left, shape),
      right: rewriteFilterThroughShapeComputeds(filter.right, shape),
    };
  }
  if (filter.kind === "not") {
    return { ...filter, expr: rewriteFilterThroughShapeComputeds(filter.expr, shape) };
  }
  if (filter.kind !== "predicate" || filter.target.kind !== "field") {
    return filter;
  }
  const parts = filter.target.field.split(".");
  if (parts.length !== 2) return filter;
  const [linkName, propName] = parts;
  const shapeEl = shape.find((el) => "name" in el && el.name === linkName);
  if (!shapeEl || shapeEl.kind !== "computed") return filter;
  const innerShape = innerShapeOfComputedBody(shapeEl.expr);
  if (!innerShape) return filter;
  const innerEl = innerShape.find((el) => "name" in el && el.name === propName);
  if (!innerEl || innerEl.kind !== "computed") return filter;
  const valueExpr = filterValueToFreeObjectExpr(filter.value);
  if (!valueExpr) return filter;
  // Only inline computed bodies whose AST is already a FreeObjectExpr — i.e.
  // ComputedExpr shapes that overlap with FreeObjectExpr (function_call,
  // literal). Other ComputedExpr-only kinds (field_ref, polymorphic_field_ref,
  // …) would need translation, which the runtime bypass already handles.
  const innerExpr = innerEl.expr;
  if (innerExpr.kind !== "function_call" && innerExpr.kind !== "literal") {
    return filter;
  }
  const newRoot: FreeObjectExpr = {
    kind: "field_access",
    expr: { kind: "current_item" },
    field: linkName,
    optional: false,
  };
  const substituted = substituteCurrentItemInFreeExpr(innerExpr as FreeObjectExpr, newRoot);
  return {
    kind: "free_expr",
    expr: {
      kind: "compare",
      op: filter.op,
      left: substituted,
      right: valueExpr,
    },
  };
};

// Eagerly applies the alias-shape FILTER rewrite to a parsed SELECT so the
// downstream pipeline (in particular the AST interpreter `tryEvaluateParsed
// RuntimeSelect`, which gates on FILTER shape) sees the inlined free
// expression form. Mirrors what `expandAliasInSelectStatement` does for the
// SQL path. Idempotent: returns the input unchanged when nothing can be
// rewritten.
export const rewriteAliasFilterEagerly = (
  statement: SelectStatement,
  schema: SchemaSnapshot,
  defaultModule = "default",
): SelectStatement => {
  if (!statement.filter) return statement;
  const aliasName = qualifyTypeName(statement.typeName, statement.withModule ?? defaultModule);
  const alias = schema.getAlias(aliasName);
  if (!alias?.exprText) return statement;
  let body = alias.exprText.trim();
  if (body.endsWith(";")) body = body.slice(0, -1).trim();
  while (body.startsWith("(") && body.endsWith(")")) {
    const inner = body.slice(1, -1).trim();
    let depth = 0;
    let balanced = true;
    for (const ch of inner) {
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth < 0) { balanced = false; break; }
      }
    }
    if (!balanced || depth !== 0) break;
    body = inner;
  }
  let aliasAst: EdgeQLStatement | undefined;
  for (const candidate of [body, `SELECT ${body}`]) {
    try {
      const parsed = parseEdgeQL(candidate);
      if (parsed.kind === "select") { aliasAst = parsed; break; }
    } catch {
      // try next
    }
  }
  if (!aliasAst || aliasAst.kind !== "select") return statement;
  const aliasBodyShape = aliasAst.shape;
  const rewritten = rewriteFilterThroughShapeComputeds(statement.filter, aliasBodyShape);
  if (rewritten === statement.filter) return statement;
  return { ...statement, filter: rewritten };
};

const expandAliasInSelectStatement = (
  statement: SelectStatement,
  ctx: IRCompileContext,
  visited: globalThis.Set<string>,
): SelectStatement => {
  if (!ctx.schema) return statement;
  const qualified = qualifyTypeName(statement.typeName, statement.withModule ?? ctx.module);
  if (visited.has(qualified)) return statement;
  const alias = ctx.schema.getAlias(qualified);
  if (!alias?.exprText) return statement;

  let body = alias.exprText.trim();
  if (body.endsWith(";")) {
    body = body.slice(0, -1).trim();
  }
  while (body.startsWith("(") && body.endsWith(")")) {
    const inner = body.slice(1, -1).trim();
    let depth = 0;
    let balanced = true;
    for (const ch of inner) {
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth < 0) { balanced = false; break; }
      }
    }
    if (!balanced || depth !== 0) break;
    body = inner;
  }

  // Alias bodies in the SDL can omit the leading `SELECT` keyword
  // (`alias SpecialCardAlias := SpecialCard { ... }`, `alias AwardAlias := (Award { ... })`).
  // Try parsing the body as-is first, then with `SELECT ` prepended.
  let aliasAst: EdgeQLStatement | undefined;
  for (const candidate of [body, `SELECT ${body}`]) {
    try {
      const parsed = parseEdgeQL(candidate);
      if (parsed.kind === "select") {
        aliasAst = parsed;
        break;
      }
    } catch {
      // try next candidate
    }
  }
  if (!aliasAst) return statement;

  visited.add(qualified);
  const expandedAlias = expandAliasInSelectStatement(aliasAst as SelectStatement, ctx, visited);

  const aliasShapeByName = new Map<string, EdgeQLShapeElement>();
  for (const element of expandedAlias.shape) {
    if ("name" in element) {
      aliasShapeByName.set(element.name, element);
    }
  }

  // When outer's link `winner: { outerShape }` matches an alias-defined
  // `winner := <expr> { aliasInnerShape }`, the result needs to use the
  // alias's expression (so winner's source is the alias-defined backlink/
  // computed) but project the outer's requested shape. Recursively merge
  // outerShape with aliasInnerShape so any outer field-ref that names an
  // alias-defined computed inside the inner shape is swapped for its
  // definition.
  const mergeNestedShape = (
    outerInnerShape: EdgeQLShapeElement[],
    aliasInnerShape: EdgeQLShapeElement[],
  ): EdgeQLShapeElement[] => {
    const innerByName = new Map<string, EdgeQLShapeElement>();
    for (const el of aliasInnerShape) {
      if ("name" in el) innerByName.set(el.name, el);
    }
    return outerInnerShape.map((outerInner) => {
      if (!("name" in outerInner) || outerInner.kind !== "field") return outerInner;
      const aliasInner = innerByName.get(outerInner.name);
      if (aliasInner && (aliasInner.kind === "computed" || aliasInner.kind === "link" || aliasInner.kind === "backlink")) {
        return aliasInner;
      }
      return outerInner;
    });
  };

  // Locate the inner shape inside an alias's computed expression
  // (`select_expr → shape_projection { shape: [...] }`). Returns null if the
  // expression isn't a shape-bearing form we know how to merge into.
  const computedInnerShape = (expr: ComputedExpr | FreeObjectExpr): EdgeQLShapeElement[] | null => {
    if (expr.kind === "select_expr") {
      return computedInnerShape(expr.expr);
    }
    if (expr.kind === "shape_projection") {
      return expr.shape;
    }
    return null;
  };

  const rewriteComputedInnerShape = (
    expr: ComputedExpr | FreeObjectExpr,
    nextShape: EdgeQLShapeElement[],
  ): ComputedExpr | FreeObjectExpr => {
    if (expr.kind === "select_expr") {
      return { ...expr, expr: rewriteComputedInnerShape(expr.expr, nextShape) as FreeObjectExpr };
    }
    if (expr.kind === "shape_projection") {
      return { ...expr, shape: nextShape };
    }
    return expr;
  };

  // When the outer query has no explicit shape (parser-default `[{id, origin:
  // "default"}]`), `SELECT Alias` means "select the alias body" — adopt the
  // alias's body shape verbatim so alias-defined computeds (e.g.
  // `SpecialCardAlias.el_cost`) are projected onto each row.
  const outerShapeIsImplicit = statement.shape.length > 0
    && statement.shape.every((el) =>
      "name" in el && (el as { origin?: string }).origin === "default",
    );

  const mergedShape: EdgeQLShapeElement[] = [];
  if (outerShapeIsImplicit) {
    mergedShape.push(...expandedAlias.shape);
  } else {
    for (const outerEl of statement.shape) {
      if (!("name" in outerEl)) {
        mergedShape.push(outerEl);
        continue;
      }
      const aliasEl = aliasShapeByName.get(outerEl.name);
      // A plain `field` reference in the outer shape that names a computed or
      // link defined on the alias body should use the alias's definition,
      // since the outer query is asking to project that named value.
      if (outerEl.kind === "field"
        && aliasEl
        && (aliasEl.kind === "computed" || aliasEl.kind === "link" || aliasEl.kind === "backlink")) {
        mergedShape.push(aliasEl);
        continue;
      }
      // An outer link/backlink with nested shape matched against an alias-
      // defined computed: keep the alias's expression but merge the outer's
      // nested projections into the alias's inner shape so the outer's
      // explicit projection (`winner: { name }`) wins over the alias's
      // default inner shape (`{ name_upper := ... }`).
      if ((outerEl.kind === "link" || outerEl.kind === "backlink") && aliasEl?.kind === "computed") {
        const outerInner = (outerEl as { shape?: EdgeQLShapeElement[] }).shape ?? [];
        const aliasInner = computedInnerShape(aliasEl.expr);
        if (aliasInner) {
          const merged = mergeNestedShape(outerInner, aliasInner);
          mergedShape.push({
            ...aliasEl,
            expr: rewriteComputedInnerShape(aliasEl.expr, merged) as ComputedExpr,
          });
          continue;
        }
        mergedShape.push(aliasEl);
        continue;
      }
      mergedShape.push(outerEl);
    }
  }

  const mergedFilterRaw = statement.filter && expandedAlias.filter
    ? { kind: "and" as const, left: expandedAlias.filter, right: statement.filter }
    : statement.filter ?? expandedAlias.filter;
  const mergedFilter = mergedFilterRaw
    ? rewriteFilterThroughShapeComputeds(mergedFilterRaw, mergedShape)
    : mergedFilterRaw;

  return {
    ...statement,
    typeName: expandedAlias.typeName,
    shape: mergedShape,
    fields: [...new globalThis.Set([...(expandedAlias.fields ?? []), ...statement.fields])],
    filter: mergedFilter,
    orderBy: statement.orderBy ?? expandedAlias.orderBy,
    limit: statement.limit ?? expandedAlias.limit,
    offset: statement.offset ?? expandedAlias.offset,
    limitExpr: statement.limitExpr ?? expandedAlias.limitExpr,
    offsetExpr: statement.offsetExpr ?? expandedAlias.offsetExpr,
  };
};

const compileSelectStatement = (rawStatement: SelectStatement, ctx: IRCompileContext): SelectStmt => {
  const statement = expandAliasInSelectStatement(rawStatement, ctx, new globalThis.Set<string>());
  const scoped = withBindings(ctx, statement.with);
  // `select Foo { ... }` may name either a type or a WITH-bound expression
  // (e.g. `with GR := (...) select GR { key }`). Prefer the binding when
  // it exists so the subject inherits the bound set's expression.
  const bound = resolveBinding(scoped, statement.typeName);
  if (!bound) {
    // `SELECT Usr` against a non-existent type: the IR builder used to fall
    // back to `unknownTypeRef`, which then produced an ugly
    // `no such table: default__usr` from SQLite. Surface the EdgeQL-shaped
    // message instead.
    if (ctx.schema) {
      const qualified = qualifyTypeName(statement.typeName, ctx.module);
      const typeDef = getSchemaType(scoped, qualified) ?? ctx.schema.getType(qualified);
      const universal = isUniversalObjectRefName(statement.typeName);
      if (!typeDef && !universal && !statement.typeName.startsWith("schema::")) {
        throw new AppError(
          "E_SEMANTIC",
          `object type or alias '${qualified}' does not exist`,
          1,
          1,
        );
      }
    }
  }
  const subject = bound ?? setFromTypeRoot(resolveTypeRef(scoped, statement.typeName));
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
    // Forward LIMIT/OFFSET literals from the parsed clause chain into the IR;
    // they were being dropped on the floor, so `SELECT Issue {…} LIMIT 3`
    // surfaced every row at the SQL layer.
    limit: statement.limitExpr
      ? compileFreeObjectExpr(statement.limitExpr, scoped)
      : statement.limit === undefined ? undefined : literalToSet(statement.limit),
    offset: statement.offsetExpr
      ? compileFreeObjectExpr(statement.offsetExpr, scoped)
      : statement.offset === undefined ? undefined : literalToSet(statement.offset),
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
  const orderBy: SortExpr[] | undefined = statement.orderBy
    ? [{
        kind: "sort_expr",
        path: statement.orderBy.expr
          ? compileFreeObjectExpr(statement.orderBy.expr, scoped)
          : compileFreeObjectExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__current__" }, field: statement.orderBy.field, optional: false }, scoped),
        direction: statement.orderBy.direction,
        nonesOrder: "last",
      }]
    : undefined;
  return {
    kind: "delete_stmt",
    expr,
    ...statementBase(scoped),
    subject,
    where: compileFilterToSet(statement.filter, expr, scoped),
    orderBy,
    limit: statement.limit === undefined ? undefined : literalToSet(statement.limit),
    offset: statement.offset === undefined ? undefined : literalToSet(statement.offset),
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

  validateParametersInStatement(statement);

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
