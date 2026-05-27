import { AppError } from "../errors.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import { simpleTypeName } from "../edgeql/ast.js";
import type { ClauseChain, ComputedExpr, FilterExpr, FreeObjectExpr, GroupByAtom, InsertValue, OrderExpr, OrderExprChain, SelectStatement, ShapeElement, Statement, TypeExpr, WithBindingValue } from "../edgeql/ast.js";
import type { GeneratedSchema } from "../codegen/schema.js";
import type {
  BacklinkSourceIR,
  FilterExprIR,
  GroupIR,
  InferenceResult,
  InsertLinkAssignmentIR,
  InsertLinkDefaultIR,
  InsertLinkPropertyIR,
  IRStatement,
  LinkRelationIR,
  OrderByIR,
  OverlayIR,
  PathIdIR,
  ScalarExprIR,
  ScalarFnName,
  ScopeTreeIR,
  SchemaTypeRefIR,
  SelectExprIREntry,
  SelectFreeIREntry,
  SelectShapeElementIR,
  SelectShapeExprIR,
  TriggerIR,
  UpdateLinkAssignmentIR,
  PolicyIR,
} from "../ir/model.js";
import { qualifiedTypeName, SchemaSnapshot } from "../schema/schema.js";
import type { AccessPolicyCondition, ScalarType, ScalarValue, TypeDef } from "../types.js";
import { tryResolveStdlibFunction } from "../stdlib/functions.js";

const tableNameForType = (qualifiedName: string): string => qualifiedName.replaceAll("::", "__").toLowerCase();

const normalizeLinkTargetNames = (targetType: string, moduleName: string): string[] =>
  targetType
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.includes("::") ? part : `${moduleName}::${part}`));

const linkDefsEquivalent = (
  a: NonNullable<TypeDef["links"]>[number],
  b: NonNullable<TypeDef["links"]>[number],
): boolean => {
  if (a.name !== b.name) return false;
  if ((a.targetType ?? "") !== (b.targetType ?? "")) return false;
  if (Boolean(a.multi) !== Boolean(b.multi)) return false;
  const aProps = a.properties ?? [];
  const bProps = b.properties ?? [];
  if (aProps.length !== bProps.length) return false;
  for (let i = 0; i < aProps.length; i += 1) {
    const ap = aProps[i];
    const bp = bProps[i];
    if (!bp || ap.name !== bp.name || ap.type !== bp.type) return false;
  }
  return true;
};

const resolveLinkStorageOwner = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  link: NonNullable<TypeDef["links"]>[number],
): TypeDef => {
  if (link.overloaded) return typeDef;
  let owner = typeDef;
  let current = typeDef;
  while ((current.extends ?? []).length > 0) {
    const baseName = current.extends?.[0];
    if (!baseName) break;
    const baseType = schema.getType(baseName);
    if (!baseType) break;
    const baseLink = (baseType.links ?? []).find((candidate) => candidate.name === link.name);
    if (!baseLink || baseLink.overloaded || !linkDefsEquivalent(link, baseLink)) break;
    owner = baseType;
    current = baseType;
  }
  return owner;
};

const expectedTargetTablesForLink = (
  schema: SchemaSnapshot,
  ownerModule: string,
  link: NonNullable<TypeDef["links"]>[number],
): string[] => {
  const targetTypeNames = normalizeLinkTargetNames(link.targetType, ownerModule);
  const tables = new Set<string>();
  for (const targetTypeName of targetTypeNames) {
    const assignable = schema.listConcreteTypesAssignableTo(targetTypeName);
    if (assignable.length > 0) {
      for (const candidate of assignable) {
        tables.add(tableNameForType(qualifiedTypeName(candidate)));
      }
    } else {
      tables.add(tableNameForType(targetTypeName));
    }
  }
  return [...tables].sort();
};

const linkPropertyIR = (
  property: NonNullable<NonNullable<TypeDef["links"]>[number]["properties"]>[number],
): InsertLinkPropertyIR => ({
  name: property.name,
  type: property.type as ScalarType,
  hasDefault: Boolean(property.hasDefault),
});

const buildInsertLinkAssignments = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  values: Record<string, InsertValue>,
  linkByName: Map<string, NonNullable<TypeDef["links"]>[number]>,
): InsertLinkAssignmentIR[] => {
  const assignments: InsertLinkAssignmentIR[] = [];
  for (const [field, value] of Object.entries(values)) {
    const link = linkByName.get(field);
    if (!link) continue;
    const linkOwner = resolveLinkStorageOwner(schema, typeDef, link);
    const ownerModule = linkOwner.module ?? "default";
    const ownerTable = tableNameForType(qualifiedTypeName(typeDef));
    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    const expectedTargetTables = expectedTargetTablesForLink(schema, ownerModule, link);
    if (usesLinkTable) {
      const properties = (link.properties ?? []).map(linkPropertyIR);
      assignments.push({
        linkName: link.name,
        storage: "table",
        ownerTable,
        linkTable: `${tableNameForType(qualifiedTypeName(linkOwner))}__${link.name.toLowerCase()}`,
        propertyColumns: properties.map((p) => p.name),
        properties,
        expectedTargetTables,
        target: value,
      });
    } else {
      assignments.push({
        linkName: link.name,
        storage: "inline",
        ownerTable,
        inlineColumn: `${link.name}_id`,
        expectedTargetTables,
        target: value,
      });
    }
  }
  return assignments;
};

const buildUpdateLinkAssignments = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  values: Record<string, InsertValue>,
  operations: Record<string, "assign" | "append" | "subtract"> | undefined,
  linkByName: Map<string, NonNullable<TypeDef["links"]>[number]>,
): UpdateLinkAssignmentIR[] => {
  const assignments: UpdateLinkAssignmentIR[] = [];
  for (const [field, value] of Object.entries(values)) {
    const link = linkByName.get(field);
    if (!link) continue;
    const linkOwner = resolveLinkStorageOwner(schema, typeDef, link);
    const ownerModule = linkOwner.module ?? "default";
    const ownerTable = tableNameForType(qualifiedTypeName(typeDef));
    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    const expectedTargetTables = expectedTargetTablesForLink(schema, ownerModule, link);
    const operation = operations?.[field] ?? "assign";
    if (usesLinkTable) {
      const properties = (link.properties ?? []).map(linkPropertyIR);
      assignments.push({
        linkName: link.name,
        storage: "table",
        ownerTable,
        linkTable: `${tableNameForType(qualifiedTypeName(linkOwner))}__${link.name.toLowerCase()}`,
        propertyColumns: properties.map((p) => p.name),
        properties,
        expectedTargetTables,
        operation,
        target: value,
      });
    } else {
      assignments.push({
        linkName: link.name,
        storage: "inline",
        ownerTable,
        inlineColumn: `${link.name}_id`,
        expectedTargetTables,
        operation,
        target: value,
      });
    }
  }
  return assignments;
};

const buildInsertLinkDefaults = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  values: Record<string, InsertValue>,
): InsertLinkDefaultIR[] => {
  const defaults: InsertLinkDefaultIR[] = [];
  for (const link of typeDef.links ?? []) {
    if (Object.prototype.hasOwnProperty.call(values, link.name)) continue;
    if (!link.hasDefault) continue;

    const targetQualified = normalizeLinkTargetNames(link.targetType, typeDef.module ?? "default")[0]
      ?? `${typeDef.module ?? "default"}::${link.targetType}`;
    const targetType = schema.getType(targetQualified);
    const lookupColumn = targetType?.fields.some((field) => field.name === "val")
      ? "val"
      : targetType?.fields.some((field) => field.name === "name")
        ? "name"
        : undefined;

    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    const properties = (link.properties ?? []).map(linkPropertyIR);
    const ownerTable = tableNameForType(qualifiedTypeName(typeDef));
    const base = {
      linkName: link.name,
      ownerTable,
      targetTable: tableNameForType(targetQualified),
      defaultTargetValues: [...(link.defaultTargetValues ?? [])],
      lookupColumn,
    };
    if (usesLinkTable) {
      defaults.push({
        ...base,
        storage: "table",
        linkTable: `${tableNameForType(qualifiedTypeName(typeDef))}__${link.name.toLowerCase()}`,
        propertyColumns: properties.map((p) => p.name),
        properties,
      });
    } else {
      defaults.push({
        ...base,
        storage: "inline",
        inlineColumn: `${link.name}_id`,
      });
    }
  }
  return defaults;
};

export interface CompileContext {
  overlays?: OverlayIR[];
  globals?: Record<string, ScalarValue>;
  schemaModel?: GeneratedSchema;
  schemaModelName?: string;
}

interface PeeledGroupForm {
  group: Extract<FreeObjectExpr, { kind: "group_expr" }>;
  postFilter?: FreeObjectExpr;
  postShape?: ShapeElement[];
  postOrderBy?: OrderExprChain;
  postLimit?: number;
  postOffset?: number;
}

// Peels common wrappers around a `(GROUP …)` expression inside a
// `SELECT (GROUP …)` statement, collecting any filter / shape / order /
// limit / offset to apply as post-processing on the group's output rows.
const peelGroupExprFromSelectExpr = (
  statement: Extract<Statement, { kind: "select_expr" }>,
): PeeledGroupForm | undefined => {
  let cursor: FreeObjectExpr = statement.expr;
  const peeled: PeeledGroupForm = { group: undefined as never };

  if (cursor.kind === "shape_projection") {
    peeled.postShape = cursor.shape;
    cursor = cursor.expr;
  }

  if (cursor.kind === "select_expr_subquery") {
    peeled.postFilter = cursor.filter;
    peeled.postOrderBy = cursor.orderBy;
    peeled.postLimit = cursor.limit;
    peeled.postOffset = cursor.offset;
    cursor = cursor.expr;
  }

  if (cursor.kind === "shape_projection" && !peeled.postShape) {
    peeled.postShape = cursor.shape;
    cursor = cursor.expr;
  }

  if (cursor.kind !== "group_expr") {
    return undefined;
  }

  // A trailing `ORDER BY` on the SELECT (`statement.orderBy`) applies to
  // the group's output rows just like an in-paren ORDER BY does.
  if (statement.orderBy && !peeled.postOrderBy) {
    peeled.postOrderBy = statement.orderBy;
  }

  peeled.group = cursor;
  return peeled;
};

const compileGroupStatement = (
  schema: SchemaSnapshot,
  statement: Extract<Statement, { kind: "group" }>,
  context: CompileContext,
): GroupIR => {
  const fail = (message: string): never => {
    throw new AppError("E_SEMANTIC", message, statement.pos.line, statement.pos.column);
  };

  const rawSource = statement.source;

  // The source might be a typed select (`Card { name }`), a binding ref
  // (`X { a, b }` where X is WITH-bound), or any other FreeObjectExpr. For
  // anything that isn't a clean typed select on a real type, we wrap as a
  // select_expr over a shape_projection so the runtime's expression evaluator
  // materialises the rows.
  const sourceUserShape: ShapeElement[] = rawSource.kind === "select" ? rawSource.shape : [];
  const sourceTypeName: string | undefined = rawSource.kind === "select" ? rawSource.typeName : undefined;
  const sourceClauses: ClauseChain | undefined = rawSource.kind === "select" ? rawSource.clauses : undefined;

  const hiddenByFields: string[] = [];
  const shapeNames = new Set(
    sourceUserShape
      .filter((element): element is Extract<ShapeElement, { name: string }> => "name" in element)
      .map((element) => element.name),
  );
  // For non-select sources (e.g. `{a := 1, b := 2}`) the source's natural
  // fields are already present on each row, so they shouldn't be marked
  // hidden when referenced by BY.
  if (rawSource.kind === "free_object_constructor") {
    for (const entry of rawSource.entries) {
      shapeNames.add(entry.name);
    }
  }
  const augmentedShape: ShapeElement[] = [...sourceUserShape];

  // USING bindings become computed shape entries on the source. The engine's
  // existing per-row shape evaluator computes them once per source row, so the
  // alias is available as a regular field for partitioning and we don't need
  // a separate per-row evaluator pass. Each alias is also marked hidden so it
  // doesn't leak into the group's `elements` projection.
  const usingExprToComputed = (expr: FreeObjectExpr): ComputedExpr => {
    // Match the shape-entry form the regular parser produces, so the source
    // SelectIR compiles the USING expression along the same path as a
    // hand-written `nowners := count(.owners)` inside a SELECT … {} shape.
    if (expr.kind === "function_call") {
      return { kind: "function_call", call: expr.call };
    }
    if (expr.kind === "field_access" && expr.expr.kind === "current_item") {
      return { kind: "field_ref", field: expr.field };
    }
    if (expr.kind === "literal") {
      return { kind: "literal", value: expr.value };
    }
    return { kind: "select_expr", expr, clauses: {} };
  };

  for (const usingBinding of statement.using ?? []) {
    if (shapeNames.has(usingBinding.alias)) {
      // Already in the source shape — `by name_ref` will find it; no need to
      // append, and don't hide a user-visible field.
      continue;
    }
    augmentedShape.push({
      kind: "computed",
      name: usingBinding.alias,
      expr: usingExprToComputed(usingBinding.expr),
      operation: "assign",
      origin: "explicit",
    });
    shapeNames.add(usingBinding.alias);
    hiddenByFields.push(usingBinding.alias);
  }

  const atomName = (atom: GroupByAtom): string =>
    atom.kind === "field_ref" ? atom.field : atom.name;

  const ensureAtomInShape = (atom: GroupByAtom): string => {
    const name = atomName(atom);
    if (atom.kind === "name_ref") {
      if (!shapeNames.has(name)) {
        fail(`BY clause references '${name}' which is not declared in USING`);
      }
      return name;
    }
    if (!shapeNames.has(name)) {
      augmentedShape.push({
        kind: "field",
        name,
        operation: "assign",
        origin: "default",
      });
      shapeNames.add(name);
      hiddenByFields.push(name);
    }
    return name;
  };

  // Expand each BY-element into a list of grouping sets (each a list of atom
  // names). Top-level entries combine by Cartesian product, matching
  // SQL-style `GROUPING SETS / CUBE / ROLLUP` composition.
  let groupingSets: string[][] = [[]];
  const atomOrder: string[] = [];
  const addAtom = (atom: GroupByAtom): string => {
    const name = ensureAtomInShape(atom);
    if (!atomOrder.includes(name)) atomOrder.push(name);
    return name;
  };

  const subsetsOfList = (items: string[], mode: "cube" | "rollup"): string[][] => {
    if (mode === "rollup") {
      const out: string[][] = [];
      for (let i = 0; i <= items.length; i += 1) {
        out.push(items.slice(0, i));
      }
      return out;
    }
    // cube: power set
    const out: string[][] = [[]];
    for (const item of items) {
      const len = out.length;
      for (let i = 0; i < len; i += 1) {
        out.push([...out[i]!, item]);
      }
    }
    return out;
  };

  const crossProduct = (left: string[][], right: string[][]): string[][] => {
    const out: string[][] = [];
    for (const l of left) {
      for (const r of right) {
        out.push([...l, ...r]);
      }
    }
    return out;
  };

  for (const element of statement.by) {
    if (element.kind === "field_ref" || element.kind === "name_ref") {
      const name = addAtom(element);
      groupingSets = groupingSets.map((s) => [...s, name]);
      continue;
    }
    if (element.kind === "sets") {
      const setOptions: string[][] = element.sets.map((atomList) => atomList.map(addAtom));
      groupingSets = crossProduct(groupingSets, setOptions);
      continue;
    }
    if (element.kind === "cube" || element.kind === "rollup") {
      const names = element.atoms.map(addAtom);
      const subsets = subsetsOfList(names, element.kind);
      groupingSets = crossProduct(groupingSets, subsets);
      continue;
    }
  }

  if (groupingSets.length === 0) {
    groupingSets = [[]];
  }

  const withBindingNames = new Set((statement.with ?? []).map((binding) => binding.name));
  const sourceIsBinding = sourceTypeName !== undefined && withBindingNames.has(sourceTypeName);
  const sourceIsRealType = sourceTypeName !== undefined && !sourceIsBinding;

  let source: GroupIR["source"];
  if (sourceIsRealType) {
    // Real-type source. Let it flow through the IR path; the parsed runtime
    // fallback in `runGroupIR` handles the cases the IR compile rejects
    // (e.g. link-typed USING aliases).
    source = {
      kind: "select",
      typeName: sourceTypeName!,
      shape: augmentedShape,
      fields: [],
      filter: sourceClauses?.filter,
      orderBy: sourceClauses?.orderBy,
      limit: sourceClauses?.limit,
      offset: sourceClauses?.offset,
      pos: statement.pos,
      with: statement.with,
      withModule: statement.withModule,
      withModuleAliases: statement.withModuleAliases,
    };
  } else {
    // Any other source shape — wrap in select_expr. When the source is a
    // binding-named typed-select we project over `binding_ref(name)` with the
    // user's explicit shape; when the source is a raw expression like
    // `{a := 1, b := 2}` or `Card.element` we use it as-is (no
    // shape_projection) so the runtime keeps every field the source emits.
    const innerExpr: FreeObjectExpr = sourceIsBinding
      ? { kind: "binding_ref", name: sourceTypeName! }
      : rawSource;
    const projection: FreeObjectExpr = sourceIsBinding && augmentedShape.length > 0
      ? { kind: "shape_projection", expr: innerExpr, shape: augmentedShape }
      : innerExpr;
    source = {
      kind: "select_expr",
      with: statement.with,
      withModule: statement.withModule,
      withModuleAliases: statement.withModuleAliases,
      expr: projection,
      pos: statement.pos,
    };
  }

  return {
    kind: "group",
    source,
    byAtoms: atomOrder,
    groupingSets,
    hiddenByFields,
  };
};

export const compileToIR = (schema: SchemaSnapshot, statement: Statement, context: CompileContext = {}): IRStatement => {
  const fail = (message: string): never => {
    throw new AppError("E_SEMANTIC", message, statement.pos.line, statement.pos.column);
  };

  if (statement.kind === "group") {
    return compileGroupStatement(schema, statement, context);
  }

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

  const extractLiteralValue = (entry: SelectExprIREntry): ExtractedLiteralValue => {
    switch (entry.kind) {
      case "literal":
        return entry.value;
      case "set_literal":
        return entry.values;
      case "set_expr":
        return (entry.values as unknown[]).map((value) => extractLiteralValue(value as SelectExprIREntry));
      case "cast":
        return extractLiteralValue(entry.value);
      case "enum_path":
        return entry.member;
      case "type_field_path":
        return null;
      case "concat":
        return (entry.parts as unknown[]).map((value) => extractLiteralValue(value as SelectExprIREntry)).join("");
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
      if (arg.expr.kind === "field_access" && arg.expr.expr.kind === "current_item") {
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
          return fail(`Unknown type or enum '${normalizedHead}'`);
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

    const resolveFreeObjectScalar = (expr: FreeObjectExpr): ScalarValue => {
      if (expr.kind === "literal") {
        return expr.value;
      }
      if (expr.kind === "binding_ref") {
        return resolveWithBindingScalar(expr.name);
      }
      if (expr.kind === "cast") {
        return resolveFreeObjectScalar(expr.expr);
      }
      if (expr.kind === "concat") {
        return expr.parts.map((part) => String(resolveFreeObjectScalar(part) ?? "")).join("");
      }
      if (expr.kind === "math") {
        const left = Number(resolveFreeObjectScalar(expr.left));
        const right = Number(resolveFreeObjectScalar(expr.right));
        if (expr.op === "+") return left + right;
        if (expr.op === "-") return left - right;
        if (expr.op === "*") return left * right;
        if (expr.op === "/") return left / right;
        if (expr.op === "//") return Math.trunc(left / right);
        if (expr.op === "%") return left % right;
      }
      return fail(`Expected scalar value in insert assignment, got ${expr.kind}`);
    };

    switch (value.kind) {
      case "binding_ref":
        return resolveWithBindingScalar(value.name);
      case "expr":
        return resolveFreeObjectScalar(value.expr);
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
    const buildForwardLinkRelation = (ownerTypeDef: TypeDef, linkName: string): LinkRelationIR => {
      const ownerQualifiedName = qualifiedTypeName(ownerTypeDef);
      const ownerScopeModule = ownerTypeDef.module ?? options.fallbackModule;
      const link = requireValue(
        collectLinks(ownerTypeDef, true).find((candidate) => candidate.name === linkName),
        `Unknown link '${linkName}' on '${ownerQualifiedName}'`,
      );
      const targetTypeNames = linkTargetNames(link.targetType, ownerScopeModule);
      const targetType = targetTypeNames[0] ?? normalizeTypeName(link.targetType, ownerScopeModule);
      const targetTableEntries = targetTypeNames.flatMap((targetTypeName) => targetTableRefsForType(targetTypeName));
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
        linkTables: usesLinkTable ? collectLinkTableSources(ownerTypeDef, link.name) : undefined,
      };
    };

    const buildSubjectLinkRelation = (linkName: string): LinkRelationIR => {
      const subjectType = options.subjectType ?? fail(`Unknown link '${linkName}' on '${typeLabel}'`);
      return buildForwardLinkRelation(subjectType, linkName);
    };

    // Mapping for the small whitelist of stdlib scalar functions the filter
    // SQL path can lower directly. Anything else falls through to the runtime.
    const scalarFnNameFor = (name: string): ScalarFnName | undefined => {
      const stripped = name.startsWith("std::") ? name.slice(5) : name;
      if (stripped === "str_upper" || stripped === "str_lower" || stripped === "len") {
        return stripped;
      }
      return undefined;
    };

    // Recursive lowering of a FreeObjectExpr to a ScalarExprIR. Returns
    // undefined when the expression contains constructs that aren't
    // scalar-expressible (paths through links, function calls, etc.).
    const tryCompileScalarExpr = (
      expr: FreeObjectExpr,
    ): ScalarExprIR | undefined => {
      if (expr.kind === "literal") {
        return { kind: "literal", value: expr.value };
      }
      // Unwrap a cast around a literal: `<str>1` → literal "1".  This lets
      // pre-expanded FOR-bindings (e.g. `FILTER .number = <str>x` where x is
      // substituted with a number literal) compile through the scalar path.
      if (expr.kind === "cast" && expr.expr.kind === "literal") {
        const inner = expr.expr.value;
        const castTo = expr.castType;
        if (castTo === "str" || castTo === "std::str") {
          return { kind: "literal", value: inner === null ? null : String(inner) };
        }
        if (castTo === "int64" || castTo === "int32" || castTo === "int16" || castTo === "int") {
          return { kind: "literal", value: inner === null ? null : Math.trunc(Number(inner)) };
        }
        if (castTo === "float64" || castTo === "float32" || castTo === "float") {
          return { kind: "literal", value: inner === null ? null : Number(inner) };
        }
        if (castTo === "bool") {
          return { kind: "literal", value: inner === null ? null : Boolean(inner) };
        }
        return { kind: "literal", value: inner };
      }
      if (
        expr.kind === "field_access"
        && expr.expr.kind === "current_item"
        && !expr.field.startsWith("@")
      ) {
        if (!knownFields.has(expr.field)) {
          return undefined;
        }
        return { kind: "column", column: expr.field };
      }
      // `T.field` where T is the current select's subject — treat as a column
      // reference (same as `.field`).  Handles filters that write the source
      // explicitly: `FILTER Issue.number > ...`.
      if (
        expr.kind === "field_access"
        && expr.expr.kind === "select"
        && (!expr.expr.clauses || Object.keys(expr.expr.clauses).length === 0)
        && !expr.field.startsWith("@")
      ) {
        const shortTypeLabel = typeLabel.includes("::") ? typeLabel.split("::").at(-1) : typeLabel;
        if ((expr.expr.typeName === typeLabel || expr.expr.typeName === shortTypeLabel) && knownFields.has(expr.field)) {
          return { kind: "column", column: expr.field };
        }
      }
      // `T.field` parsed as a path AST node — same case as above.
      if (
        expr.kind === "path"
        && !expr.steps?.length
        && !expr.tail.startsWith("@")
      ) {
        const shortTypeLabel = typeLabel.includes("::") ? typeLabel.split("::").at(-1) : typeLabel;
        if ((expr.head === typeLabel || expr.head === shortTypeLabel) && knownFields.has(expr.tail)) {
          return { kind: "column", column: expr.tail };
        }
      }
      if (expr.kind === "math") {
        const left = tryCompileScalarExpr(expr.left);
        const right = tryCompileScalarExpr(expr.right);
        if (!left || !right) return undefined;
        if (expr.op !== "+" && expr.op !== "-" && expr.op !== "*" && expr.op !== "/" && expr.op !== "//" && expr.op !== "%") {
          return undefined;
        }
        return { kind: "binop", op: expr.op, left, right };
      }
      if (expr.kind === "concat") {
        const parts = expr.parts.map((part) => tryCompileScalarExpr(part));
        if (parts.some((p) => !p)) return undefined;
        let acc = parts[0]!;
        for (let i = 1; i < parts.length; i++) {
          acc = { kind: "binop", op: "++", left: acc, right: parts[i]! };
        }
        return acc;
      }
      if (expr.kind === "unary" && expr.op === "neg") {
        const inner = tryCompileScalarExpr(expr.expr);
        if (!inner) return undefined;
        return { kind: "neg", expr: inner };
      }
      if (expr.kind === "index_access") {
        const inner = tryCompileScalarExpr(expr.expr);
        if (!inner) return undefined;
        return { kind: "index_access", value: inner, index: expr.index };
      }
      if (expr.kind === "function_call") {
        const fn = scalarFnNameFor(expr.call.name);
        if (!fn) return undefined;
        const args: ScalarExprIR[] = [];
        for (const arg of expr.call.args) {
          if (arg.kind !== "expr") return undefined;
          const compiled = tryCompileScalarExpr(arg.expr);
          if (!compiled) return undefined;
          args.push(compiled);
        }
        return { kind: "fn_call", name: fn, args };
      }
      return undefined;
    };

    const compileFreeExprFilter = (expr: FreeObjectExpr): FilterExprIR => {
      if (expr.kind === "literal" && typeof expr.value === "boolean") {
        return {
          kind: "expr_compare",
          left: { kind: "literal", value: true },
          right: { kind: "literal", value: expr.value },
          op: "=",
        };
      }
      if (expr.kind === "set_literal" && expr.values.length === 0) {
        return {
          kind: "expr_compare",
          left: { kind: "literal", value: true },
          right: { kind: "literal", value: false },
          op: "=",
        };
      }
      if (
        expr.kind === "cast"
        && expr.expr.kind === "set_literal"
        && expr.expr.values.length === 0
      ) {
        return {
          kind: "expr_compare",
          left: { kind: "literal", value: true },
          right: { kind: "literal", value: false },
          op: "=",
        };
      }
      const isEmptySetExpr = (e: FreeObjectExpr): boolean => {
        if (e.kind === "set_literal" && e.values.length === 0) return true;
        if (e.kind === "cast" && e.expr.kind === "set_literal" && e.expr.values.length === 0) return true;
        return false;
      };
      if (expr.kind === "compare" && (isEmptySetExpr(expr.left) || isEmptySetExpr(expr.right))) {
        return {
          kind: "expr_compare",
          left: { kind: "literal", value: true },
          right: { kind: "literal", value: false },
          op: "=",
        };
      }
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
      // Generic comparison with arithmetic / concat on either side, lowered
      // to an `expr_compare` IR node that the SQL compiler can emit
      // directly. Example: `.bb % 2 = 0`.
      if (
        expr.kind === "compare"
        && (expr.op === "=" || expr.op === "!=" || expr.op === "<" || expr.op === "<=" || expr.op === ">" || expr.op === ">=")
      ) {
        const left = tryCompileScalarExpr(expr.left);
        const right = tryCompileScalarExpr(expr.right);
        if (left && right) {
          return { kind: "expr_compare", left, right, op: expr.op };
        }
      }
      // `<scalar-fn?>(.linkName.columnName) <op> <literal>` — pattern produced
      // by alias-FILTER rewrites such as `FILTER .winner.name_upper = 'ALICE'`
      // (rewritten to `str_upper(.winner.name) = 'ALICE'` when `winner` is a
      // computed link with a `name_upper := str_upper(.name)` body). Lower to
      // `link_target_field_compare` (forward link) or
      // `backlink_target_field_compare` (computed backlink) so the SQL path
      // handles it end-to-end instead of bouncing to the runtime bypass.
      if (
        expr.kind === "compare"
        && options.subjectType
        && (expr.op === "=" || expr.op === "!=" || expr.op === "<" || expr.op === "<="
          || expr.op === ">" || expr.op === ">=" || expr.op === "like" || expr.op === "ilike")
      ) {
        const compareOp = expr.op;
        // Strip an optional scalar-function wrapper (str_upper, etc.) and
        // return the (function-name, inner-expression) pair. When no wrapper,
        // returns the expression with an undefined function.
        const peelFn = (e: FreeObjectExpr): { fn?: ScalarFnName; inner: FreeObjectExpr } => {
          if (e.kind === "function_call") {
            const fnName = scalarFnNameFor(e.call.name);
            if (fnName && e.call.args.length === 1 && e.call.args[0].kind === "expr") {
              return { fn: fnName, inner: e.call.args[0].expr };
            }
          }
          return { inner: e };
        };
        // A `.link.column` path against the current item: `field_access(field_access(current_item, linkName), columnName)`.
        const readLinkColumnPath = (e: FreeObjectExpr): { linkName: string; columnName: string } | undefined => {
          if (e.kind === "field_access" && e.expr.kind === "field_access" && e.expr.expr.kind === "current_item"
            && !e.field.startsWith("@") && !e.expr.field.startsWith("@")) {
            return { linkName: e.expr.field, columnName: e.field };
          }
          return undefined;
        };
        const readLiteral = (e: FreeObjectExpr): ScalarValue | undefined => {
          if (e.kind === "literal") return e.value;
          if (e.kind === "cast" && e.expr.kind === "literal") return e.expr.value;
          return undefined;
        };
        const leftPeel = peelFn(expr.left);
        const rightPeel = peelFn(expr.right);
        const leftPath = readLinkColumnPath(leftPeel.inner);
        const rightPath = readLinkColumnPath(rightPeel.inner);
        const leftLiteral = readLiteral(expr.left);
        const rightLiteral = readLiteral(expr.right);
        const pathSide = leftPath ? { path: leftPath, fn: leftPeel.fn, literal: rightLiteral }
          : rightPath ? { path: rightPath, fn: rightPeel.fn, literal: leftLiteral }
            : undefined;
        if (pathSide && pathSide.literal !== undefined) {
          const { linkName, columnName } = pathSide.path;
          // Forward link on the subject type → reuse link_target_field_compare.
          const fwdLink = collectLinks(options.subjectType, true).find((cand) => cand.name === linkName);
          if (fwdLink) {
            const ownerQualifiedName = qualifiedTypeName(options.subjectType);
            const ownerScopeModule = options.subjectType.module ?? options.fallbackModule;
            const targetTypeNames = linkTargetNames(fwdLink.targetType, ownerScopeModule);
            const targetType = targetTypeNames[0] ?? normalizeTypeName(fwdLink.targetType, ownerScopeModule);
            const targetTableEntries = targetTypeNames.flatMap((typeName) => targetTableRefsForType(typeName));
            const targetTables = [...new Map(targetTableEntries.map((entry) => [entry.name, entry] as const)).values()];
            const usesLinkTable = Boolean(fwdLink.multi) || (fwdLink.properties?.length ?? 0) > 0;
            return {
              kind: "link_target_field_compare",
              relation: {
                sourceType: ownerQualifiedName,
                targetType,
                targetTable: tableNameForType(targetType),
                targetTables,
                propertyColumns: (fwdLink.properties ?? []).map((p) => p.name),
                computedProperties: (fwdLink.computedProperties ?? []).map((p) => ({ ...p })),
                multi: Boolean(fwdLink.multi),
                storage: usesLinkTable ? "table" : "inline",
                inlineColumn: usesLinkTable ? undefined : `${fwdLink.name}_id`,
                linkTable: usesLinkTable ? `${tableNameForType(ownerQualifiedName)}__${fwdLink.name.toLowerCase()}` : undefined,
                linkTables: usesLinkTable ? collectLinkTableSources(options.subjectType, fwdLink.name) : undefined,
              },
              targetColumn: columnName,
              value: pathSide.literal,
              op: compareOp,
              targetFn: pathSide.fn,
            };
          }
          // Computed link with backlink expression (e.g. Award.winner := .<awards[is User]).
          const computedLink = collectComputeds(options.subjectType, true).find((cand) =>
            cand.name === linkName && cand.kind === "link" && cand.expr.kind === "backlink");
          if (computedLink && computedLink.kind === "link" && computedLink.expr.kind === "backlink"
            && (compareOp === "=" || compareOp === "!=" || compareOp === "<" || compareOp === "<="
              || compareOp === ">" || compareOp === ">=" || compareOp === "like" || compareOp === "ilike")) {
            const typeLabelQualified = qualifiedTypeName(options.subjectType);
            const sources = resolveBacklinkSources(
              typeLabelQualified,
              options.fallbackModule,
              computedLink.expr.link,
              computedLink.expr.sourceType,
            );
            if (sources.length > 0) {
              return {
                kind: "backlink_target_field_compare",
                sources,
                targetColumn: columnName,
                targetFn: pathSide.fn,
                value: pathSide.literal,
                op: compareOp,
              };
            }
          }
        }
      }
      if (expr.kind === "exists") {
        const shortTypeLabel = typeLabel.includes("::") ? typeLabel.split("::").at(-1)! : typeLabel;
        const isSubjectRef = (e: FreeObjectExpr): boolean => {
          if (e.kind === "current_item") return true;
          if (e.kind === "binding_ref" && (e.name === typeLabel || e.name === shortTypeLabel)) return true;
          if (
            e.kind === "select"
            && (e.typeName === typeLabel || e.typeName === shortTypeLabel)
            && (!e.clauses || Object.keys(e.clauses).length === 0)
          ) {
            return true;
          }
          return false;
        };
        const fieldOfCurrentItem = (e: FreeObjectExpr): string | undefined => {
          if (e.kind === "field_access" && !e.field.startsWith("@") && isSubjectRef(e.expr)) {
            return e.field;
          }
          if (
            e.kind === "path"
            && (e.head === typeLabel || e.head === shortTypeLabel)
            && !e.tail.startsWith("@")
            && !e.steps?.length
          ) {
            return e.tail;
          }
          return undefined;
        };
        const field = fieldOfCurrentItem(expr.expr);
        if (field && knownFields.has(field)) {
          return {
            kind: "expr_compare",
            left: { kind: "column", column: field },
            right: { kind: "literal", value: null },
            op: "!=",
          };
        }
        // EXISTS on a single inline link (e.g. `EXISTS Issue.priority`):
        // map to a null check on the link's inline FK column.
        if (field && options.subjectType) {
          const link = collectLinks(options.subjectType, true).find((candidate) => candidate.name === field);
          if (link) {
            const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
            if (!usesLinkTable) {
              return {
                kind: "expr_compare",
                left: { kind: "column", column: `${link.name}_id` },
                right: { kind: "literal", value: null },
                op: "!=",
              };
            }
          }
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
        // Link-traversal IN: `Issue.priority.name IN {'High', 'Low'}` — when
        // the target is a dotted path through a single forward link, emit a
        // link_target_field_in IR that joins to the target table.
        if (!knownFields.has(fieldName) && fieldName.includes(".") && options.subjectType) {
          const firstDot = fieldName.indexOf(".");
          const linkName = fieldName.slice(0, firstDot);
          const linkFieldName = fieldName.slice(firstDot + 1);
          const link = collectLinks(options.subjectType, true).find((candidate) => candidate.name === linkName);
          if (link && !linkFieldName.includes(".")) {
            const ownerQualifiedName = qualifiedTypeName(options.subjectType);
            const ownerScopeModule = options.subjectType.module ?? options.fallbackModule;
            const targetTypeNames = linkTargetNames(link.targetType, ownerScopeModule);
            const targetType = targetTypeNames[0] ?? normalizeTypeName(link.targetType, ownerScopeModule);
            const targetTableEntries = targetTypeNames.flatMap((targetTypeName) => targetTableRefsForType(targetTypeName));
            const targetTables = [...new Map(targetTableEntries.map((entry) => [entry.name, entry] as const)).values()];
            const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
            return {
              kind: "link_target_field_in",
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
                linkTables: usesLinkTable ? collectLinkTableSources(options.subjectType, link.name) : undefined,
              },
              targetColumn: linkFieldName,
              op: filter.op,
              values: filter.values.values,
            };
          }
        }
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
        const targetTableEntries = targetTypeNames.flatMap((targetTypeName) => targetTableRefsForType(targetTypeName));
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
            linkTables: usesLinkTable ? collectLinkTableSources(options.subjectType!, link.name) : undefined,
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
    const targetBareName = filter.target.kind === "field" ? filter.target.bareName : undefined;
    if (targetBareName !== undefined) {
      // EdgeQL treats `filter X = ...` as a name reference that must resolve to
      // an object type / alias (a field would be written `.X`).
      fail(`object type or alias '${normalizeTypeName(targetBareName, options.fallbackModule)}' does not exist`);
    }

    if (filter.op === "=" && resolvedFilterValue === true && options.subjectType) {
      const pathParts = targetField.split(".");
      if (pathParts.length === 1) {
        const link = collectLinks(options.subjectType, true).find((candidate) => candidate.name === targetField);
        if (link) {
          return {
            kind: "link_exists",
            relation: buildForwardLinkRelation(options.subjectType, link.name),
          };
        }
      }
      if (pathParts.length === 2) {
        const [linkName, targetLinkName] = pathParts;
        const link = collectLinks(options.subjectType, true).find((candidate) => candidate.name === linkName);
        if (link) {
          const relation = buildForwardLinkRelation(options.subjectType, link.name);
          const targetType = schema.getType(relation.targetType);
          const targetLink = targetType
            ? collectLinks(targetType, true).find((candidate) => candidate.name === targetLinkName)
            : undefined;
          if (targetType && targetLink) {
            return {
              kind: "link_target_link_exists",
              relation,
              targetRelation: buildForwardLinkRelation(targetType, targetLink.name),
            };
          }
        }
      }
    }

    if (!knownFields.has(targetField) && targetField.includes(".") && options.subjectType) {
      const firstDot = targetField.indexOf(".");
      const linkName = targetField.slice(0, firstDot);
      const fieldName = targetField.slice(firstDot + 1);
      const link = collectLinks(options.subjectType, true).find((candidate) => candidate.name === linkName);
      if (link && !fieldName.includes(".")) {
        const ownerQualifiedName = qualifiedTypeName(options.subjectType);
        const ownerScopeModule = options.subjectType.module ?? options.fallbackModule;
        const targetTypeNames = linkTargetNames(link.targetType, ownerScopeModule);
        const targetType = targetTypeNames[0] ?? normalizeTypeName(link.targetType, ownerScopeModule);
        const targetTableEntries = targetTypeNames.flatMap((targetTypeName) => targetTableRefsForType(targetTypeName));
        const targetTables = [...new Map(targetTableEntries.map((entry) => [entry.name, entry] as const)).values()];
        const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
        return {
          kind: "link_target_field_compare",
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
            linkTables: usesLinkTable ? collectLinkTableSources(options.subjectType, link.name) : undefined,
          },
          targetColumn: fieldName,
          value: resolvedFilterValue as ScalarValue,
          op: filter.op,
        };
      }
    }

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

      fail(`object type '${typeLabel}' has no link or property '${targetField}'`);
    }

    const field = requireValue(fieldByName.get(targetField), `object type '${typeLabel}' has no link or property '${targetField}'`);

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

  const schemaTypeRefForType = (typeDef: TypeDef) => {
    const name = qualifiedTypeName(typeDef);
    return {
      name,
      table: tableNameForType(name),
      columns: ["id", ...collectFields(typeDef, true).map((field) => field.name)],
    };
  };

  const targetTableRefsForType = (typeName: string) => {
    const assignable = schema.listConcreteTypesAssignableTo(typeName);
    if (assignable.length > 0) {
      return assignable.map((candidate) => schemaTypeRefForType(candidate));
    }

    const typeDef = schema.getType(typeName);
    return typeDef
      ? [schemaTypeRefForType(typeDef)]
      : [{ name: typeName, table: tableNameForType(typeName) }];
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

  // For a multi link (or single link with link properties) declared on
  // `ownerTypeDef`, returns every concrete subtype's link table that may
  // hold rows for this relation. Used to UNION ALL link sources for
  // polymorphic shape queries (e.g. `SELECT S { l_a }` when only `V`
  // instances exist materialised in V's link table).
  const collectLinkTableSources = (
    ownerTypeDef: TypeDef,
    linkName: string,
  ): Array<{ name: string; table: string }> => {
    const ownerName = qualifiedTypeName(ownerTypeDef);
    const collected = new Map<string, { name: string; table: string }>();
    const addTable = (typeName: string): void => {
      const table = `${tableNameForType(typeName)}__${linkName.toLowerCase()}`;
      if (!collected.has(table)) {
        collected.set(table, { name: typeName, table });
      }
    };
    if (!ownerTypeDef.abstract) {
      addTable(ownerName);
    }
    for (const candidate of schema.listConcreteTypesAssignableTo(ownerName)) {
      const candidateName = qualifiedTypeName(candidate);
      const hasLink = collectLinks(candidate, true).some((l) => l.name === linkName);
      if (hasLink) {
        addTable(candidateName);
      }
    }
    return [...collected.values()].sort((a, b) => a.name.localeCompare(b.name));
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

  const allConcreteTypeNames = (): string[] =>
    schema.listTypes()
      .filter((typeDef) => !typeDef.abstract)
      .map((typeDef) => qualifiedTypeName(typeDef));

  const concreteTypeNamesForTypeExpr = (
    expr: TypeExpr,
    moduleName: string,
  ): string[] => {
    if (expr.kind === "type_name") {
      const normalized = normalizeTypeName(expr.name, moduleName);
      if (normalized === "default::Object" || normalized === "std::Object") {
        return allConcreteTypeNames();
      }
      return schema
        .listConcreteTypesAssignableTo(normalized)
        .map((candidate) => qualifiedTypeName(candidate));
    }
    const left = new Set(concreteTypeNamesForTypeExpr(expr.left, moduleName));
    const right = new Set(concreteTypeNamesForTypeExpr(expr.right, moduleName));
    if (expr.kind === "type_union") {
      return [...new Set([...left, ...right])];
    }
    return [...left].filter((name) => right.has(name));
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

  // A backlink `Target.<linkName[IS Source]` is at-most-one when every
  // matching forward link carries a `constraint exclusive`. If even one
  // matching forward link permits multiple sources per target, the backlink
  // is multi.
  const isBacklinkSingle = (
    targetTypeQualifiedName: string,
    fallbackModule: string,
    linkName: string,
    sourceTypeName?: string,
  ): boolean => {
    const requestedSourceType = sourceTypeName ? normalizeTypeName(sourceTypeName, fallbackModule) : undefined;
    let anyMatched = false;
    for (const candidate of schema.listTypes()) {
      const candidateQualifiedName = qualifiedTypeName(candidate);
      if (requestedSourceType && !isAssignableTo(candidateQualifiedName, requestedSourceType)) {
        continue;
      }
      for (const link of collectLinks(candidate, true)) {
        const targets = linkTargetNames(link.targetType, candidate.module ?? "default");
        if (link.name !== linkName || !targets.some((target) => isAssignableTo(targetTypeQualifiedName, target))) {
          continue;
        }
        anyMatched = true;
        const isExclusive = (link.constraints ?? []).some(
          (c) => c.name === "std::exclusive" || c.name === "exclusive",
        );
        if (!isExclusive) {
          return false;
        }
      }
    }
    return anyMatched;
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

  const rewriteSubjectBindingRefsToCurrent = (
    expr: FreeObjectExpr,
    subjectBindingName: string,
  ): FreeObjectExpr => {
    type Expr = FreeObjectExpr;
    const walk = (node: Expr): Expr => {
      if (node.kind === "binding_ref" && node.name === subjectBindingName) {
        return { kind: "current_item" };
      }
      if (node.kind === "field_access") {
        return { ...node, expr: walk(node.expr) };
      }
      if (node.kind === "math" || node.kind === "compare" || node.kind === "and" || node.kind === "or" || node.kind === "logical" || node.kind === "coalesce") {
        return { ...node, left: walk(node.left), right: walk(node.right) };
      }
      if (node.kind === "if_else") {
        return {
          ...node,
          condition: walk(node.condition),
          thenExpr: walk(node.thenExpr),
          elseExpr: walk(node.elseExpr),
        };
      }
      if (node.kind === "not" || node.kind === "unary" || node.kind === "cast" || node.kind === "distinct" || node.kind === "exists" || node.kind === "shape_projection") {
        return { ...node, expr: walk(node.expr) };
      }
      if (node.kind === "select_expr_subquery") {
        return { ...node, expr: walk(node.expr) };
      }
      if (node.kind === "concat") {
        return { ...node, parts: node.parts.map(walk) };
      }
      if (node.kind === "tuple" || node.kind === "array_literal_expr" || node.kind === "set_expr") {
        return { ...node, values: node.values.map(walk) };
      }
      if (node.kind === "index_access" || node.kind === "slice_access") {
        return { ...node, expr: walk(node.expr) };
      }
      return node;
    };
    return walk(expr);
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
      typeFilterExprs?: TypeExpr[];
      branchTypeFilterExprs?: TypeExpr[];
      subjectBindingName?: string;
      // Set when this call compiles a link/backlink shape element. Strips a
      // leading `<linkScopeName>.` from clause-orderBy field paths so e.g.
      // `deck: { id } ORDER BY User.deck.cost` resolves `cost` relative to
      // the link target (the parser already strips `User.`, leaving us with
      // `deck.cost`).
      linkScopeName?: string;
    },
    ): {
      pathId: PathIdIR;
      sourceType: string;
      typeRef: SchemaTypeRefIR;
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
    const narrowedTypeNames = (options.typeFilterExprs ?? []).reduce<Set<string> | undefined>(
      (acc, expr) => {
        const matched = new Set(concreteTypeNamesForTypeExpr(expr, scopeModule));
        if (!acc) return matched;
        return new Set([...acc].filter((name) => matched.has(name)));
      },
      undefined,
    );
    // Per-branch concrete types preserve duplicates so set-expression branches
    // that share concrete types produce one row per branch (UNION ALL).
    const branchConcreteSequence: string[] | undefined = options.branchTypeFilterExprs && options.branchTypeFilterExprs.length > 0
      ? options.branchTypeFilterExprs.flatMap((expr) => {
          const list = concreteTypeNamesForTypeExpr(expr, scopeModule);
          return narrowedTypeNames
            ? list.filter((name) => narrowedTypeNames.has(name))
            : list;
        })
      : undefined;
    const concreteAssignable = schema.listConcreteTypesAssignableTo(qualifiedName);
    const candidateNames = branchConcreteSequence
      ? branchConcreteSequence
      : concreteAssignable.length > 0
        ? concreteAssignable.map((candidate) => qualifiedTypeName(candidate))
        : narrowedTypeNames
          ? [...narrowedTypeNames]
          : [];
    const buildSourceTableEntry = (name: string) => {
      const candidate = schema.getType(name);
      return {
        name,
        table: tableNameForType(name),
        columns: ["id", ...(candidate ? collectFields(candidate, true).map((field) => field.name) : [])],
      };
    };
    const sourceTables = branchConcreteSequence
      ? branchConcreteSequence.map(buildSourceTableEntry)
      : candidateNames
        .map(buildSourceTableEntry)
        .filter((entry) => !narrowedTypeNames || narrowedTypeNames.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    const allFields = collectFields(typeDef, true);
    const allComputeds = collectComputeds(typeDef, true);
    const userFields = allFields.filter((field) => field.name !== "id");
    const knownFields = new Set(["id", ...userFields.map((f) => f.name)]);
    if (narrowedTypeNames) {
      for (const narrowedTypeName of narrowedTypeNames) {
        const narrowedTypeDef = schema.getType(narrowedTypeName);
        if (narrowedTypeDef) {
          for (const field of collectFields(narrowedTypeDef, true)) {
            knownFields.add(field.name);
          }
          for (const link of collectLinks(narrowedTypeDef, true)) {
            knownFields.add(link.name);
          }
          for (const computed of collectComputeds(narrowedTypeDef, true)) {
            knownFields.add(computed.name);
          }
        }
      }
    }
    const computedByName = new Map(allComputeds.map((computed) => [computed.name, computed] as const));
    const fieldByName = new Map([
      ["id", { name: "id", type: "uuid" as const, required: true }],
      ...userFields.map((field) => [field.name, field] as const),
    ]);
    if (narrowedTypeNames) {
      for (const narrowedTypeName of narrowedTypeNames) {
        const narrowedTypeDef = schema.getType(narrowedTypeName);
        if (!narrowedTypeDef) continue;
        for (const field of collectFields(narrowedTypeDef, true)) {
          if (!fieldByName.has(field.name) && field.name !== "id") {
            fieldByName.set(field.name, field);
          }
        }
      }
    }

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
      const targetTableEntries = targetTypeNames.flatMap((targetTypeName) => targetTableRefsForType(targetTypeName));
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
        linkTables: usesLinkTable ? collectLinkTableSources(ownerTypeDef, link.name) : undefined,
      };
    };

    const shapeElements: SelectShapeElementIR[] = [];
    const scopeChildren: ScopeTreeIR[] = [];
    const shapeNames = new Set<string>();
    const selectedColumns = new Set<string>();
    if ((typeDef.accessPolicies ?? []).length > 0) {
      selectedColumns.add("id");
      // Project every column the policy conditions read so the runtime can
      // evaluate the predicate directly off the SELECT result, without
      // firing one `readRowById` per row.
      const collectPolicyConditionFields = (condition: AccessPolicyCondition, into: Set<string>): void => {
        if (condition.kind === "field_eq_global" || condition.kind === "field_eq_literal") {
          into.add(condition.field);
          return;
        }
        if (condition.kind === "and") {
          for (const clause of condition.clauses) collectPolicyConditionFields(clause, into);
        }
      };
      for (const policy of typeDef.accessPolicies ?? []) {
        collectPolicyConditionFields(policy.condition, selectedColumns);
      }
    }
    let hasBacklink = false;

    // Names of explicit (non-splat) shape entries — splat expansion should
    // suppress these so an explicit override silently wins (EdgeQL reference
    // behavior for `Issue { **, name := "X" }`).
    const explicitShapeNames = new Set<string>(
      shape
        .filter((element): element is Extract<ShapeElement, { name: string }> => element.kind !== "splat" && "name" in element)
        .map((element) => element.name),
    );

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
          if (shapeNames.has(field.name) || explicitShapeNames.has(field.name)) {
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
            if (shapeNames.has(linkDef.name) || explicitShapeNames.has(linkDef.name)) {
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
            } else if (computed.expr.kind === "set_literal") {
              shapeElements.push({
                kind: "computed",
                name: shapeElement.name,
                pathId: toPathIdIR(elementPathId),
                expr: {
                  kind: "set_literal",
                  values: [...computed.expr.values],
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
            const single = isBacklinkSingle(qualifiedName, scopeModule, computed.expr.link, computed.expr.sourceType);
            shapeElements.push({
              kind: "backlink",
              name: shapeElement.name,
              pathId: toPathIdIR(elementPathId),
              sources,
              multi: !single,
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

        // Bare link reference (`User { todo }` with no nested shape) — treat
        // as `User { todo: { id } }` so the link is included with a default
        // shape.  Without this, ensureField would reject the name as unknown.
        const matchingLink = collectLinks(typeDef, true).find((link) => link.name === resolvedFieldName);
        if (matchingLink) {
          const linkPathId = createPathId(pathId);
          const relation = resolveForwardLink(typeDef, matchingLink.name);
          const linkTargetType = requireValue(
            schema.getType(relation.targetType),
            `Unknown link target type '${relation.targetType}' from '${qualifiedName}.${matchingLink.name}'`,
          );
          const nested = compileSelectForType(
            linkTargetType,
            linkPathId,
            [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
            {},
            { allowBacklinkFilter: false },
          );
          if (relation.storage === "inline") {
            selectedColumns.add(requireValue(relation.inlineColumn, `Missing inline storage metadata for '${matchingLink.name}'`));
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
            const rawPropertyName = shapeElement.expr.field.slice(1);
            const propertyName = [...(options.linkProperties ?? new Set<string>())]
              .find((candidate) => candidate.toLowerCase() === rawPropertyName.toLowerCase())
              ?? rawPropertyName;
            if (!options.linkProperties?.has(propertyName)) {
              fail(`Unknown field '${shapeElement.expr.field}' on '${qualifiedName}'`);
            }
            shapeElements.push({
              kind: "computed",
              name: shapeElement.name.startsWith("@") ? `@${propertyName}` : shapeElement.name,
              pathId: toPathIdIR(elementPathId),
              expr: {
                kind: "field_ref",
                column: `@${propertyName}`,
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
          const polymorphicSourceTypeName = normalizeTypeName(shapeElement.expr.sourceType, scopeModule);
          const polymorphicFieldName = shapeElement.expr.field;
          const polymorphicConcretes = shapeElement.expr.sourceTypeExpr
            ? concreteTypeNamesForTypeExpr(shapeElement.expr.sourceTypeExpr, scopeModule)
            : schema
                .listConcreteTypesAssignableTo(polymorphicSourceTypeName)
                .map((candidate) => qualifiedTypeName(candidate));
          if (!knownFields.has(polymorphicFieldName)) {
            const fieldOnAnyConcrete = polymorphicConcretes.some((concreteName) => {
              const concreteType = schema.getType(concreteName);
              return concreteType
                ? collectFields(concreteType, true).some((field) => field.name === polymorphicFieldName)
                : false;
            });
            if (!fieldOnAnyConcrete) {
              fail(`Unknown field '${polymorphicFieldName}' on '${polymorphicSourceTypeName}'`);
            }
          }
          selectedColumns.add(polymorphicFieldName);
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "polymorphic_field_ref",
              sourceType: polymorphicSourceTypeName,
              concreteSourceTypes: polymorphicConcretes,
              column: polymorphicFieldName,
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
          // EdgeQL `sum(.link.field)` over a multi link aggregates the target
          // column across the linked rows. Recognise it here and emit a
          // `link_aggregate` IR entry so sql/compiler can lower it to a
          // correlated SUM subquery — otherwise the per-row N+1 fallback in
          // materializeSelectRow has to fire one SQL per outer row.
          const aggregateLinkExpr = (() => {
            if (resolved.qualifiedName !== "std::sum") return undefined;
            const args = shapeElement.expr.call.args;
            if (args.length !== 1) return undefined;
            const arg = args[0]!;
            if (arg.kind !== "expr") return undefined;
            // Match `field_access(field_access(current_item, link), field)`.
            const outer = arg.expr;
            if (outer.kind !== "field_access" || outer.field.startsWith("@")) return undefined;
            const inner = outer.expr;
            if (inner.kind !== "field_access" || inner.expr.kind !== "current_item" || inner.field.startsWith("@")) return undefined;
            const linkName = inner.field;
            const fieldName = outer.field;
            const link = collectLinks(typeDef, true).find((candidate) => candidate.name === linkName);
            if (!link) return undefined;
            const relation = resolveForwardLink(typeDef, linkName);
            const targetTypeDef = schema.getType(relation.targetType);
            if (!targetTypeDef) return undefined;
            const targetFields = new Set([
              "id",
              ...collectFields(targetTypeDef, true).map((f) => f.name),
            ]);
            if (!targetFields.has(fieldName)) return undefined;
            return { relation, fieldName };
          })();
          if (aggregateLinkExpr) {
            shapeElements.push({
              kind: "computed",
              name: shapeElement.name,
              pathId: toPathIdIR(elementPathId),
              expr: {
                kind: "link_aggregate",
                functionName: "sum",
                relation: aggregateLinkExpr.relation,
                column: aggregateLinkExpr.fieldName,
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
          const bindingName = shapeElement.expr.name;
          const bindingValue = withBindings.get(bindingName);
          const isWithBinding = Boolean(bindingValue);
          const expr: SelectShapeExprIR = isWithBinding
            ? { kind: "literal", value: resolveWithBindingScalar(bindingName) }
            : { kind: "binding_ref", name: bindingName };
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr,
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
          const selectExpr = shapeElement.expr;
          const innerExpr = selectExpr.expr;
          // `Object IS T` (and `Object IS (T | U)` etc.) in a shape entry is
          // a per-row type check: row's actual type matches the type expr.
          if (
            innerExpr.kind === "is_type"
            && innerExpr.expr.kind === "select"
            && (innerExpr.expr.typeName === "Object" || innerExpr.expr.typeName === "std::Object")
          ) {
            const typeExpr = innerExpr.typeExpr ?? { kind: "type_name" as const, name: innerExpr.typeName };
            shapeElements.push({
              kind: "computed",
              name: shapeElement.name,
              pathId: toPathIdIR(elementPathId),
              expr: {
                kind: "is_type",
                concreteSourceTypes: concreteTypeNamesForTypeExpr(typeExpr, scopeModule),
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
          if (innerExpr.kind === "shape_projection"
            && innerExpr.expr.kind === "field_access"
            && innerExpr.expr.expr.kind === "current_item") {
            const linkName = innerExpr.expr.field;
            const computedLinkRef = computedByName.get(linkName);
            if (computedLinkRef?.kind === "link" && computedLinkRef.expr.kind === "backlink") {
              hasBacklink = true;
              const sources = resolveBacklinkSources(qualifiedName, scopeModule, computedLinkRef.expr.link, computedLinkRef.expr.sourceType);
              const nestedSourceType = normalizeTypeName(computedLinkRef.expr.sourceType ?? qualifiedName, scopeModule);
              const nestedType = requireValue(
                schema.getType(nestedSourceType),
                `Unknown backlink source type '${nestedSourceType}' on '${qualifiedName}.${linkName}'`,
              );
              const nested = compileSelectForType(
                nestedType,
                elementPathId,
                innerExpr.shape,
                {},
                {
                  allowBacklinkFilter: false,
                  linkProperties: new Set(sources.flatMap((source) => source.propertyColumns ?? [])),
                },
              );
              shapeElements.push({
                kind: "backlink",
                name: shapeElement.name,
                pathId: toPathIdIR(elementPathId),
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
          }
          // For polymorphic chained reads `[is T].link.field`, the runtime
          // needs the link column on every source row, so make sure it gets
          // projected through.
          if (
            innerExpr.kind === "path_steps"
            && innerExpr.partial
            && innerExpr.steps[0]?.kind === "type_intersection"
            && innerExpr.steps[1]?.kind === "ptr"
          ) {
            const linkOrField = innerExpr.steps[1].name;
            selectedColumns.add(linkOrField);
            selectedColumns.add(`${linkOrField}_id`);
            // Validate that `[is T].field` is compatible with the root
            // type's view of `field` — same cardinality and same
            // computed-ness. Mixed-cardinality and mixed-computed
            // intersections are illegal.
            const intersectionType = schema.getType(normalizeTypeName(
              simpleTypeName(innerExpr.steps[0].typeExpr) ?? innerExpr.steps[0].typeName,
              scopeModule,
            ));
            const rootField = collectFields(typeDef, true).find((f) => f.name === linkOrField);
            const rootLink = collectLinks(typeDef, true).find((l) => l.name === linkOrField);
            const rootComputedAll = collectComputeds(typeDef, true).find((c) => c.name === linkOrField);
            const rootMulti = rootField?.multi ?? rootLink?.multi ?? rootComputedAll?.multi ?? false;
            const rootIsComputed = Boolean(rootComputedAll) && !rootField && !rootLink;
            if (intersectionType) {
              const otherField = collectFields(intersectionType, true).find((f) => f.name === linkOrField);
              const otherLink = collectLinks(intersectionType, true).find((l) => l.name === linkOrField);
              const otherComputedAll = collectComputeds(intersectionType, true).find((c) => c.name === linkOrField);
              const otherMulti = otherField?.multi ?? otherLink?.multi ?? otherComputedAll?.multi ?? false;
              const otherIsComputed = Boolean(otherComputedAll) && !otherField && !otherLink;
              const haveBoth = Boolean((rootField || rootLink || rootComputedAll) && (otherField || otherLink || otherComputedAll));
              const isLink = Boolean(rootLink || otherLink);
              // Walk the inheritance DAG to find topmost ancestors that
              // declare the field/link/computed. Used to verify both sides
              // of a type intersection share an origin for a computed.
              const hasName = (t: TypeDef): boolean =>
                (t.fields ?? []).some((f) => f.name === linkOrField)
                || (t.links ?? []).some((l) => l.name === linkOrField)
                || (t.computeds ?? []).some((c) => c.name === linkOrField);
              const findOrigins = (t: TypeDef, visited = new Set<string>()): Set<string> => {
                const key = qualifiedTypeName(t);
                if (visited.has(key)) return new Set();
                visited.add(key);
                const baseTypes = (t.extends ?? [])
                  .map((n) => schema.getType(n))
                  .filter((b): b is TypeDef => Boolean(b) && hasName(b!));
                if (baseTypes.length === 0) {
                  return hasName(t) ? new Set([key]) : new Set();
                }
                const out = new Set<string>();
                for (const base of baseTypes) {
                  for (const origin of findOrigins(base, visited)) {
                    out.add(origin);
                  }
                }
                return out;
              };
              if (haveBoth) {
                // Mixed computed vs non-computed is illegal.
                if (otherIsComputed !== rootIsComputed) {
                  fail(`it is illegal to create a type intersection that causes a computed ${isLink ? "link" : "property"} '${linkOrField}' to mix with other versions of the same ${isLink ? "link" : "property"}`);
                }
                // Two computeds defined independently (no shared origin in
                // the inheritance DAG) are illegal — their expressions may
                // be unrelated even if the names match.
                if (rootIsComputed && otherIsComputed) {
                  const rootOrigins = findOrigins(typeDef);
                  const otherOrigins = findOrigins(intersectionType);
                  const sharesOrigin = [...rootOrigins].some((o) => otherOrigins.has(o));
                  if (!sharesOrigin) {
                    fail(`it is illegal to create a type intersection that causes a computed ${isLink ? "link" : "property"} '${linkOrField}' to mix with other versions of the same ${isLink ? "link" : "property"}`);
                  }
                }
                if (otherMulti !== rootMulti) {
                  fail(`it is illegal to create a type intersection that causes a ${isLink ? "link" : "property"} '${linkOrField}' to mix with other versions of '${linkOrField}' which have a different cardinality`);
                }
              }
            }
          }
          const rewrittenInnerExpr = options.subjectBindingName
            ? rewriteSubjectBindingRefsToCurrent(shapeElement.expr.expr, options.subjectBindingName)
            : shapeElement.expr.expr;
          shapeElements.push({
            kind: "computed",
            name: shapeElement.name,
            pathId: toPathIdIR(elementPathId),
            expr: {
              kind: "select_expr",
              expr: rewrittenInnerExpr,
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
        if (!shapeElement.expr.sourceType && shapeElement.shape) {
          for (const el of shapeElement.shape) {
            const requestedLinkProperty = el.kind === "field" && el.name.startsWith("@")
              ? el.name.slice(1)
              : el.kind === "computed" && el.name.startsWith("@")
                ? el.name.slice(1)
                : undefined;
            if (requestedLinkProperty) {
              fail(`link 'deck' has no property '${requestedLinkProperty}'`);
            }
          }
        }
        let nestedShape: SelectShapeElementIR[] | undefined;
        let nestedColumns: string[] | undefined;
        if (shapeElement.shape && shapeElement.shape.length > 0) {
          const nestedSourceType = shapeElement.expr.sourceType
            ? normalizeTypeName(shapeElement.expr.sourceType, scopeModule)
            : sources[0]?.sourceType;
          const nestedType = nestedSourceType ? schema.getType(nestedSourceType) : undefined;
          if (nestedType) {
            const nested = compileSelectForType(
              nestedType,
              elementPathId,
              shapeElement.shape,
              {},
              {
                allowBacklinkFilter: false,
                linkProperties: new Set(sources.flatMap((source) => source.propertyColumns ?? [])),
              },
            );
            nestedShape = nested.shape;
            nestedColumns = nested.columns;
          }
        }
        const singleBacklink = isBacklinkSingle(qualifiedName, scopeModule, shapeElement.expr.link, shapeElement.expr.sourceType);
        shapeElements.push({
          kind: "backlink",
          name: shapeElement.name,
          pathId: toPathIdIR(elementPathId),
          sources,
          shape: nestedShape,
          columns: nestedColumns,
          multi: !singleBacklink,
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
          linkScopeName: shapeElement.name,
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
        linkScopeName: shapeElement.name,
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

    {
      const seen = new Set<string>();
      const linkNames = new Set(collectLinks(typeDef, true).map((link) => link.name));
      for (const element of shapeElements) {
        if (seen.has(element.name)) {
          const memberKind = linkNames.has(element.name) ? "link" : "property";
          fail(`duplicate definition of ${memberKind} '${element.name}' of object type '${qualifiedName}'`);
        }
        seen.add(element.name);
      }
    }

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

    const resolveOrderByTerm = (term: OrderExpr | undefined): OrderByIR<string> | undefined => {
      if (!term) return undefined;
      if (term.expr) {
        const built: OrderByIR<string> = {
          value: "__expr__",
          direction: term.direction,
          exprAst: term.expr,
        };
        if (term.nullsPosition) built.nullsPosition = term.nullsPosition;
        const nextTerm = resolveOrderByTerm(term.then);
        if (nextTerm) built.then = nextTerm;
        return built;
      }
      let value = term.field.startsWith("@") ? term.field.slice(1) : term.field;
      if (term.field.startsWith("@") && options.linkProperties) {
        value = [...options.linkProperties]
          .find((candidate) => candidate.toLowerCase() === value.toLowerCase())
          ?? value;
      }
      if (!term.field.startsWith("@") && options.linkScopeName && value.startsWith(`${options.linkScopeName}.`)) {
        // Strip the link's own name from the path. `ORDER BY User.deck.cost`
        // parses to field `deck.cost`; from the link target's perspective
        // (Card), the actual sort column is `cost`.
        value = value.slice(options.linkScopeName.length + 1);
      }
      if (!term.field.startsWith("@") && value.includes(".")) {
        return undefined;
      }
      if (!term.field.startsWith("@")) {
        const computedTypeNameAlias = shapeElements.find(
          (element) =>
            element.name === value
            && element.kind === "computed"
            && element.expr.kind === "type_name",
        );
        if (computedTypeNameAlias) {
          value = "__source_type";
        } else {
          const computedShapeAlias = shapeElements.find(
            (element) => element.name === value && element.kind === "computed",
          );
          if (!computedShapeAlias) {
            ensureField(value);
          }
        }
      }
      const built: OrderByIR<string> = { value, direction: term.direction };
      if (term.nullsPosition) built.nullsPosition = term.nullsPosition;
      const nextTerm = resolveOrderByTerm(term.then);
      if (nextTerm) built.then = nextTerm;
      return built;
    };
    const resolvedOrderBy = resolveOrderByTerm(clauses.orderBy);

    if (clauses.limit !== undefined && clauses.limit < 0) {
      fail("LIMIT must not be negative");
    }

    if (clauses.offset !== undefined && clauses.offset < 0) {
      fail("OFFSET must not be negative");
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

  // Convert a `FreeObjectExpr` whose value set is determined entirely by
  // type expressions (a bare type name, type intersections, set unions of
  // those, or `DISTINCT` of those) into a single `TypeExpr` describing the
  // matching concrete types. Returns undefined if the expression depends on
  // anything beyond schema types.
  const tryExtractTypedRootExpr = (expr: FreeObjectExpr): TypeExpr | undefined => {
    if (expr.kind === "distinct") {
      return tryExtractTypedRootExpr(expr.expr);
    }
    if (expr.kind === "is_type" && expr.typeExpr) {
      const inner = tryExtractTypedRootExpr(expr.expr);
      if (!inner) return undefined;
      return { kind: "type_intersection", left: inner, right: expr.typeExpr };
    }
    if (expr.kind === "set_expr") {
      if (expr.values.length === 0) return undefined;
      const exprs: TypeExpr[] = [];
      for (const value of expr.values) {
        const inner = tryExtractTypedRootExpr(value);
        if (!inner) return undefined;
        exprs.push(inner);
      }
      return exprs.reduce((acc, next) => ({ kind: "type_union", left: acc, right: next }));
    }
    if (expr.kind === "binding_ref") {
      return { kind: "type_name", name: expr.name };
    }
    if (expr.kind === "select") {
      const hasOnlyDefaultId = !expr.shape
        || expr.shape.length === 0
        || expr.shape.every((el) => el.kind === "field" && el.name === "id" && el.origin === "default");
      if (hasOnlyDefaultId) {
        return { kind: "type_name", name: expr.typeName };
      }
    }
    if (expr.kind === "path_steps") {
      const head = expr.steps[0];
      if (!head || head.kind !== "object_ref") return undefined;
      let current: TypeExpr = { kind: "type_name", name: head.name };
      for (const step of expr.steps.slice(1)) {
        if (step.kind !== "type_intersection" || !step.typeExpr) return undefined;
        current = { kind: "type_intersection", left: current, right: step.typeExpr };
      }
      return current;
    }
    if (expr.kind === "select_expr_subquery") {
      return tryExtractTypedRootExpr(expr.expr);
    }
    return undefined;
  };

  const fieldAccessOrderByField = (expr: FreeObjectExpr): string | undefined => {
    if (expr.kind === "field_access" && expr.expr.kind === "current_item") {
      return expr.field;
    }
    return undefined;
  };

  const orderByChainToOrderExpr = (
    chain: OrderExprChain | undefined,
  ): OrderExpr | undefined => {
    if (!chain) return undefined;
    const field = fieldAccessOrderByField(chain.expr);
    if (field === undefined) return undefined;
    const built: OrderExpr = { field, direction: chain.direction };
    if (chain.nullsPosition) built.nullsPosition = chain.nullsPosition;
    const next = orderByChainToOrderExpr(chain.then);
    if (next) built.then = next;
    return built;
  };

  const hasSetExpr = (expr: FreeObjectExpr): boolean => {
    if (expr.kind === "set_expr") return true;
    if (
      expr.kind === "distinct"
      || expr.kind === "cast"
      || expr.kind === "field_access"
      || expr.kind === "shape_projection"
      || expr.kind === "index_access"
      || expr.kind === "slice_access"
      || expr.kind === "is_type"
    ) {
      return hasSetExpr(expr.expr);
    }
    if (expr.kind === "tuple" || expr.kind === "array_literal_expr") {
      return expr.values.some(hasSetExpr);
    }
    if (expr.kind === "select_expr_subquery") {
      return hasSetExpr(expr.expr);
    }
    return false;
  };

  // Returns the per-branch TypeExpr list when `expr` is a set_expr whose
  // values each resolve to a TypeExpr, else undefined. Each branch keeps its
  // own concrete-type expansion so a type that occurs in more than one branch
  // shows up once per branch (multiset / UNION ALL semantics). DISTINCT
  // disables this — when wrapped in `distinct`, the caller wants set
  // semantics (no duplicates) so the consolidated rewrite is correct.
  const tryExtractSetExprBranches = (expr: FreeObjectExpr): TypeExpr[] | undefined => {
    if (expr.kind !== "set_expr") return undefined;
    if (expr.values.length === 0) return undefined;
    const branches: TypeExpr[] = [];
    for (const value of expr.values) {
      const inner = tryExtractTypedRootExpr(value);
      if (!inner) return undefined;
      branches.push(inner);
    }
    return branches;
  };

  // Shape elements that compile cleanly through the typed-select IR path —
  // anything else (e.g. aggregate function calls over links) needs the
  // select_expr runtime so it can resolve link-table polymorphism per row.
  const shapeIsTypedSelectFriendly = (shape: ShapeElement[]): boolean =>
    shape.every((el) => (
      el.kind === "field"
      || el.kind === "splat"
      || (el.kind === "computed"
        && (el.expr.kind === "field_ref"
          || el.expr.kind === "polymorphic_field_ref"
          || el.expr.kind === "type_name"))
      || el.kind === "link"
      || el.kind === "backlink"
    ));

  const tryRewriteSelectExprAsTypedSelect = (
    selectExpr: Extract<Statement, { kind: "select_expr" }>,
  ): SelectStatement | undefined => {
    const root = selectExpr.expr.kind === "shape_projection"
      ? selectExpr.expr
      : undefined;
    if (!root) {
      if (hasSetExpr(selectExpr.expr)) {
        return undefined;
      }
      return undefined;
    }
    const typedRoot = tryExtractTypedRootExpr(root.expr);
    if (!typedRoot) return undefined;
    // Bail out when the shape uses anything richer than direct field/link
    // references — the select_expr runtime resolves those per row whereas
    // the typed-select path would need them lowered into SQL up front.
    if (hasSetExpr(selectExpr.expr) && !shapeIsTypedSelectFriendly(root.shape)) {
      return undefined;
    }

    let orderBy: OrderExpr | undefined;
    if (selectExpr.orderBy) {
      const converted = orderByChainToOrderExpr(selectExpr.orderBy);
      if (!converted) return undefined;
      orderBy = converted;
    }

    // If the root is a set-expression (e.g. `{T1, T2}` or `{T[IS X], T[IS Y]}`)
    // and there is overlap between the branches' concrete types, we need
    // multiset (UNION ALL) semantics to preserve duplicates. Switch to the
    // branch-aware rewrite in that case.
    const branches = tryExtractSetExprBranches(root.expr);
    if (branches && branches.length > 1) {
      const branchConcretes = branches.map((branch) => concreteTypeNamesForTypeExpr(branch, "default"));
      const seen = new Set<string>();
      let hasOverlap = false;
      for (const list of branchConcretes) {
        for (const name of list) {
          if (seen.has(name)) {
            hasOverlap = true;
            break;
          }
          seen.add(name);
        }
        if (hasOverlap) break;
      }
      if (hasOverlap) {
        return {
          kind: "select",
          typeName: "Object",
          branchTypeFilterExprs: branches,
          shape: root.shape,
          fields: [],
          orderBy,
          with: selectExpr.with,
          withModule: selectExpr.withModule,
          withModuleAliases: selectExpr.withModuleAliases,
          pos: selectExpr.pos,
        };
      }
    }

    return {
      kind: "select",
      typeName: typedRoot.kind === "type_name" ? typedRoot.name : "Object",
      typeFilterExprs: typedRoot.kind === "type_name" ? undefined : [typedRoot],
      shape: root.shape,
      fields: [],
      orderBy,
      with: selectExpr.with,
      withModule: selectExpr.withModule,
      withModuleAliases: selectExpr.withModuleAliases,
      pos: selectExpr.pos,
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

    // `Object` (and `std::Object`) is the universal object root. The schema
    // doesn't carry a TypeDef for it, so synthesise one — the narrowing in
    // typeFilterExprs (if any) determines the actual sources downstream.
    if (resolvedTypeName === "default::Object" || resolvedTypeName === "std::Object") {
      return {
        typeDef: { name: "Object", module: activeModule, fields: [], abstract: true } as TypeDef,
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
      // `WITH x := SomeType` — the binding aliases a type directly; treat
      // the SELECT as if rooted on that type so type narrowing applies.
      if (withBinding.kind === "binding_ref") {
        const referencedTypeName = normalizeTypeName(withBinding.name, activeModule);
        const referencedType = schema.getType(referencedTypeName);
        if (referencedType) {
          return {
            typeDef: referencedType,
            aliasProjections: undefined,
            clauses: {
              filter: selectStatement.filter,
              orderBy: selectStatement.orderBy,
              limit: selectStatement.limit,
              offset: selectStatement.offset,
            },
          };
        }
      }
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
      if (withBinding.kind === "subquery_expr") {
        const typedRoot = tryExtractTypedRootExpr(withBinding.expr);
        if (typedRoot) {
          const sourceName = typedRoot.kind === "type_name" ? typedRoot.name : "Object";
          if (typedRoot.kind !== "type_name") {
            selectStatement.typeFilterExprs = [typedRoot, ...(selectStatement.typeFilterExprs ?? [])];
          }
          // When the WITH-binding value is a set-expression of typed roots,
          // we need multiset semantics — each branch is unioned with
          // duplicates preserved. The branches are stored separately from
          // typeFilterExprs (which intersect to narrow further).
          const branches = tryExtractSetExprBranches(withBinding.expr);
          if (branches && branches.length > 1) {
            const branchConcretes = branches.map((branch) => concreteTypeNamesForTypeExpr(branch, activeModule));
            const seen = new Set<string>();
            let hasOverlap = false;
            for (const list of branchConcretes) {
              for (const name of list) {
                if (seen.has(name)) {
                  hasOverlap = true;
                  break;
                }
                seen.add(name);
              }
              if (hasOverlap) break;
            }
            if (hasOverlap) {
              selectStatement.branchTypeFilterExprs = branches;
              // Remove the now-redundant union we prepended above.
              if (typedRoot.kind !== "type_name") {
                selectStatement.typeFilterExprs = (selectStatement.typeFilterExprs ?? []).slice(1);
                if (selectStatement.typeFilterExprs.length === 0) {
                  selectStatement.typeFilterExprs = undefined;
                }
              }
            }
          }
          const normalizedSourceName = normalizeTypeName(sourceName, activeModule);
          const sourceType = normalizedSourceName === "default::Object" || normalizedSourceName === "std::Object"
            ? ({ name: "Object", module: activeModule, fields: [], abstract: true } as TypeDef)
            : schema.getType(normalizedSourceName);
          if (sourceType) {
            // If the binding's value contains a SELECT with a FILTER, fold
            // that filter into the outer SELECT so the binding's predicate
            // is preserved (e.g. `with x := (select Bb filter .bb > 0)`).
            let nestedFilter: SelectStatement["filter"] | undefined;
            const peelToSelect = (e: FreeObjectExpr): FreeObjectExpr | undefined => {
              if (e.kind === "select_expr_subquery") return peelToSelect(e.expr) ?? e.expr;
              if (e.kind === "distinct") return peelToSelect(e.expr);
              if (e.kind === "select") return e;
              return undefined;
            };
            const innerSelect = peelToSelect(withBinding.expr);
            if (innerSelect && innerSelect.kind === "select") {
              nestedFilter = innerSelect.clauses?.filter;
            }
            return {
              typeDef: sourceType,
              aliasProjections: undefined,
              clauses: {
                filter: mergeFilters(nestedFilter, selectStatement.filter),
                orderBy: selectStatement.orderBy,
                limit: selectStatement.limit,
                offset: selectStatement.offset,
              },
            };
          }
        }
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
      entry: SelectFreeIREntry,
    ): SelectFreeIREntry<3> => entry as SelectFreeIREntry<3>;

    const compileFreeObjectExprToSelectFreeEntry = (expr: FreeObjectExpr, name: string): SelectFreeIREntry => {
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
      if (expr.kind === "select_expr_subquery" && expr.expr.kind === "select") {
        // The wrapper carries optional extra tail clauses (filter/orderBy/limit/
        // offset) that apply *outside* the inner SELECT's own clauses. When any
        // wrapper-level clause is present we can't faithfully fold it into the
        // inner SELECT here (semantics: outer FILTER applies to the inner set,
        // not to its rows pre-aggregation), so fall through to the more general
        // error handling. The common case (`(SELECT T { ... } ORDER BY .x)`)
        // parses the tail into `inner.clauses`, leaving the wrapper bare.
        const hasOuterTail = expr.filter !== undefined
          || expr.orderBy !== undefined
          || expr.limit !== undefined
          || expr.offset !== undefined;
        if (!hasOuterTail) {
          return compileFreeObjectExprToSelectFreeEntry(expr.expr, name);
        }
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

    const entries = statement.entries.map((entry): SelectFreeIREntry => {
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
    // Structural validation of parameter usage in the select expression tree:
    //  * a bare `$N` (no enclosing cast and no inline castType) → "missing a type cast"
    //  * a shape applied to a parameter (`<T>$0 { id }`) → "cannot apply a shape to the parameter"
    const isFreeExpr = (value: unknown): value is FreeObjectExpr =>
      !!value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string";
    const visitParamCheck = (expr: FreeObjectExpr, castWrapped: boolean): void => {
      if (expr.kind === "shape_projection" && expr.expr.kind === "parameter") {
        throw new AppError("E_SEMANTIC", "cannot apply a shape to the parameter", statement.pos.line, statement.pos.column);
      }
      if (expr.kind === "parameter") {
        if (!castWrapped && (expr as { castType?: string }).castType === undefined) {
          throw new AppError("E_SEMANTIC", "missing a type cast before the parameter", statement.pos.line, statement.pos.column);
        }
        return;
      }
      const childCastWrapped = expr.kind === "cast";
      for (const key of Object.keys(expr)) {
        const value = (expr as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isFreeExpr(item)) visitParamCheck(item, childCastWrapped);
          }
        } else if (isFreeExpr(value)) {
          visitParamCheck(value, childCastWrapped);
        }
      }
    };
    visitParamCheck(statement.expr, false);

    // Rewrite `SELECT <typed-root> { shape }` (where typed-root is a typed
    // expression like `Ba[IS Bb | Bc]` or `{CBaBb, CBbBc}`) as a narrowed
    // typed select so it flows through the typed-select IR pipeline.
    const rewritten = tryRewriteSelectExprAsTypedSelect(statement);
    if (rewritten) {
      return compileToIR(schema, rewritten, context);
    }

    // `SELECT (GROUP …)` and its wrapped forms (with filter / shape / order /
    // limit / offset on top of the group) — peel the wrapper, lower the
    // GROUP, and attach the post-process so the engine applies it to the
    // group's output rows.
    const groupForm = peelGroupExprFromSelectExpr(statement);
    if (groupForm) {
      const groupStatement: Extract<Statement, { kind: "group" }> = {
        kind: "group",
        source: groupForm.group.source,
        using: groupForm.group.using,
        by: groupForm.group.by,
        with: statement.with,
        withModule: statement.withModule,
        withModuleAliases: statement.withModuleAliases,
        pos: statement.pos,
      };
      const groupIR = compileToIR(schema, groupStatement, context);
      if (groupIR.kind === "group") {
        return {
          ...groupIR,
          postFilter: groupForm.postFilter,
          postShape: groupForm.postShape,
          postOrderBy: groupForm.postOrderBy,
          postLimit: groupForm.postLimit,
          postOffset: groupForm.postOffset,
        };
      }
      return groupIR;
    }
    const pathId = createPathId();
    const asNestedExprEntry = (
      entry: SelectExprIREntry,
    ): SelectExprIREntry<3> => entry as SelectExprIREntry<3>;

    const withBindings = new Map<string, WithBindingValue>();
    for (const binding of statement.with ?? []) {
      withBindings.set(binding.name, binding.value);
    }

    const forBindingStack: string[] = [];

    const bindingRootOfExpr = (expr: FreeObjectExpr | undefined): string | undefined => {
      if (!expr) return undefined;
      if (expr.kind === "binding_ref") return expr.name;
      if (expr.kind === "current_item") return "__current__";
      if (expr.kind === "path") return expr.head;
      if (expr.kind === "path_chain") return expr.parts[0];
      if (expr.kind === "path_steps") {
        const first = expr.steps[0];
        return first?.kind === "object_ref" ? first.name : undefined;
      }
      if (expr.kind === "field_access" || expr.kind === "index_access" || expr.kind === "slice_access" || expr.kind === "cast" || expr.kind === "is_type") {
        return bindingRootOfExpr(expr.expr);
      }
      if (expr.kind === "select_expr_subquery" || expr.kind === "distinct") {
        return bindingRootOfExpr(expr.expr);
      }
      return undefined;
    };

    const forIteratorIsScopedLink = (expr: FreeObjectExpr, currentItemBinding?: string): boolean => {
      const scopedNames = new Set(["__current__", ...forBindingStack]);
      if (currentItemBinding) scopedNames.add(currentItemBinding);
      if (expr.kind === "field_access" && !expr.field.startsWith("@")) {
        const root = bindingRootOfExpr(expr.expr);
        return Boolean(root && scopedNames.has(root));
      }
      if (expr.kind === "path" || expr.kind === "path_chain" || expr.kind === "path_steps") {
        const root = bindingRootOfExpr(expr);
        return Boolean(root && scopedNames.has(root));
      }
      if (expr.kind === "backlink_path") return true;
      if (expr.kind === "select_expr_subquery" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "is_type") {
        return forIteratorIsScopedLink(expr.expr, currentItemBinding);
      }
      return false;
    };

    const computedReferencesBindingLinkProperty = (expr: ComputedExpr, bindingName: string): boolean => {
      if (expr.kind === "select_expr") return freeExprReferencesBindingLinkProperty(expr.expr, bindingName);
      if (expr.kind === "function_call") {
        return expr.call.args.some((arg) => arg.kind === "expr"
          ? freeExprReferencesBindingLinkProperty(arg.expr, bindingName)
          : arg.kind === "function_call"
            ? computedReferencesBindingLinkProperty({ kind: "function_call", call: arg.call }, bindingName)
            : false);
      }
      return false;
    };

    function freeExprReferencesBindingLinkProperty(expr: FreeObjectExpr, bindingName: string): boolean {
      if (expr.kind === "field_access") {
        if (expr.field.startsWith("@") && expr.expr.kind === "binding_ref" && expr.expr.name === bindingName) {
          return true;
        }
        return freeExprReferencesBindingLinkProperty(expr.expr, bindingName);
      }
      if (expr.kind === "set_expr" || expr.kind === "tuple" || expr.kind === "array_literal_expr") {
        return expr.values.some((value) => freeExprReferencesBindingLinkProperty(value, bindingName));
      }
      if (expr.kind === "concat") {
        return expr.parts.some((part) => freeExprReferencesBindingLinkProperty(part, bindingName));
      }
      if (expr.kind === "free_object_constructor") {
        return expr.entries.some((entry) => freeExprReferencesBindingLinkProperty(entry.expr, bindingName));
      }
      if (expr.kind === "shape_projection") {
        return freeExprReferencesBindingLinkProperty(expr.expr, bindingName)
          || expr.shape.some((element) => element.kind === "computed" && computedReferencesBindingLinkProperty(element.expr, bindingName));
      }
      if (expr.kind === "select_expr_subquery") {
        return freeExprReferencesBindingLinkProperty(expr.expr, bindingName)
          || Boolean(expr.filter && freeExprReferencesBindingLinkProperty(expr.filter, bindingName))
          || Boolean(expr.orderBy && freeExprReferencesBindingLinkProperty(expr.orderBy.expr, bindingName));
      }
      if (expr.kind === "for_expr") {
        return freeExprReferencesBindingLinkProperty(expr.iterator, bindingName)
          || (expr.variable === bindingName ? false : freeExprReferencesBindingLinkProperty(expr.body, bindingName));
      }
      if (expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "exists" || expr.kind === "index_access" || expr.kind === "slice_access" || expr.kind === "is_type") {
        return freeExprReferencesBindingLinkProperty(expr.expr, bindingName);
      }
      if (expr.kind === "compare" || expr.kind === "math" || expr.kind === "logical" || expr.kind === "coalesce") {
        return freeExprReferencesBindingLinkProperty(expr.left, bindingName) || freeExprReferencesBindingLinkProperty(expr.right, bindingName);
      }
      if (expr.kind === "and" || expr.kind === "or") {
        return freeExprReferencesBindingLinkProperty(expr.left, bindingName) || freeExprReferencesBindingLinkProperty(expr.right, bindingName);
      }
      if (expr.kind === "not" || expr.kind === "unary") {
        return freeExprReferencesBindingLinkProperty(expr.expr, bindingName);
      }
      if (expr.kind === "if_else") {
        return freeExprReferencesBindingLinkProperty(expr.thenExpr, bindingName)
          || freeExprReferencesBindingLinkProperty(expr.condition, bindingName)
          || freeExprReferencesBindingLinkProperty(expr.elseExpr, bindingName);
      }
      if (expr.kind === "function_call") {
        return expr.call.args.some((arg) => arg.kind === "expr"
          ? freeExprReferencesBindingLinkProperty(arg.expr, bindingName)
          : arg.kind === "function_call"
            ? computedReferencesBindingLinkProperty({ kind: "function_call", call: arg.call }, bindingName)
            : false);
      }
      return false;
    }

    const compileExprToIREntry = (
      expr: FreeObjectExpr | ComputedExpr,
      currentItemBinding?: string,
    ): SelectExprIREntry => {
      if (expr.kind === "group_expr") {
        throw new AppError("E_SEMANTIC", "GROUP statement is not yet implemented", statement.pos.line, statement.pos.column);
      }
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
      if (expr.kind === "field_ref") {
        return {
          kind: "current_item_field",
          bindingName: currentItemBinding ?? "__current__",
          field: expr.field,
        };
      }
      if (expr.kind === "polymorphic_field_ref") {
        const polymorphicSourceTypeName = normalizeTypeName(expr.sourceType, "default");
        const polymorphicConcretes = expr.sourceTypeExpr
          ? concreteTypeNamesForTypeExpr(expr.sourceTypeExpr, "default")
          : schema
              .listConcreteTypesAssignableTo(polymorphicSourceTypeName)
              .map((candidate) => qualifiedTypeName(candidate));
        return {
          kind: "polymorphic_field_ref",
          sourceType: polymorphicSourceTypeName,
          concreteSourceTypes: polymorphicConcretes,
          column: expr.field,
        };
      }
      if (expr.kind === "type_name") {
        return { kind: "type_name", sourceType: "" };
      }
      if (expr.kind === "subquery") {
        return compileExprToIREntry({ kind: "select", typeName: expr.typeName, shape: expr.shape, clauses: expr.clauses }, currentItemBinding);
      }
      if (expr.kind === "select_expr") {
        return compileExprToIREntry({ kind: "select_expr_subquery", expr: expr.expr, clauses: expr.clauses }, currentItemBinding);
      }
      if (expr.kind === "field_suffix_math") {
        fail("Unsupported field suffix math in select_expr");
      }
      if (expr.kind === "type_intersection") {
        return compileExprToIREntry(expr.expr, currentItemBinding);
      }
      if (expr.kind === "distinct") {
        return {
          kind: "distinct",
          value: asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding)),
        };
      }
      if (expr.kind === "field_access") {
        if (expr.expr.kind === "select" && !expr.field.startsWith("@")) {
          // Validate the field exists on the source type when the access is
          // directly on a typed select (`SELECT User.nam`).
          const sourceTypeName = normalizeTypeName(expr.expr.typeName, activeModule);
          const sourceTypeDef = schema.getType(sourceTypeName);
          if (sourceTypeDef) {
            const inlineShapeNames = (expr.expr.shape ?? [])
              .filter((el): el is Extract<ShapeElement, { name: string }> => "name" in el)
              .map((el) => el.name);
            const knownFieldNames = new Set<string>([
              "id",
              "__type__",
              ...collectFields(sourceTypeDef, true).map((f) => f.name),
              ...collectLinks(sourceTypeDef, true).map((l) => l.name),
              ...(sourceTypeDef.computeds ?? []).map((c) => c.name),
              ...inlineShapeNames,
            ]);
            if (!knownFieldNames.has(expr.field)) {
              fail(`'${sourceTypeName}' has no link or property '${expr.field}'`);
            }
          }
        }
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
      if (expr.kind === "mutation_expr") {
        return {
          kind: "mutation_expr",
          statement: expr.statement,
        };
      }
      if (expr.kind === "shape_projection") {
        type ShapeProjectionField = {
          name: string;
          sourceField?: string;
          backlinkLink?: string;
          backlinkSourceType?: string;
          expr?: SelectExprIREntry<3>;
          itemFields?: Array<{
            name: string;
            sourceField?: string;
            expr?: SelectExprIREntry<3>;
            multi?: boolean;
          }>;
          multi?: boolean;
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
              continue;
            }
            if (element.expr.kind === "type_name") {
              fields.push({
                name: element.name,
                expr: { kind: "type_name", sourceType: "" },
              });
              continue;
            }
            if (element.expr.kind === "polymorphic_field_ref") {
              const polymorphicSourceTypeName = normalizeTypeName(element.expr.sourceType, "default");
              const polymorphicConcretes = element.expr.sourceTypeExpr
                ? concreteTypeNamesForTypeExpr(element.expr.sourceTypeExpr, "default")
                : schema
                    .listConcreteTypesAssignableTo(polymorphicSourceTypeName)
                    .map((candidate) => qualifiedTypeName(candidate));
              fields.push({
                name: element.name,
                expr: {
                  kind: "polymorphic_field_ref",
                  sourceType: polymorphicSourceTypeName,
                  concreteSourceTypes: polymorphicConcretes,
                  column: element.expr.field,
                },
              });
              continue;
            }
            fields.push({
              name: element.name,
              expr: asNestedExprEntry(compileExprToIREntry(element.expr, currentItemBinding)),
              multi: Boolean(element.multi || element.cardinality === "many"),
            });
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
        // Compile-time bounds check for literal array / string sources.
        // The reference EdgeQL diagnostic categories: "array", "string", "JSON".
        const literalIndexBoundsCheck = (): void => {
          const idx = expr.index;
          if (!Number.isFinite(idx) || !Number.isInteger(idx)) return;
          const source = expr.expr;
          if (source.kind === "array_literal_expr") {
            const len = source.values.length;
            if (idx >= len || idx < -len) {
              fail(`array index ${idx} is out of bounds`);
            }
          }
          if (source.kind === "literal" && typeof source.value === "string") {
            const len = source.value.length;
            if (idx >= len || idx < -len) {
              fail(`string index ${idx} is out of bounds`);
            }
          }
          if (source.kind === "function_call" && (source.call.name === "to_json" || source.call.name.endsWith("::to_json"))) {
            const arg = source.call.args[0];
            if (arg && arg.kind === "literal" && typeof arg.value === "string") {
              try {
                const parsed = JSON.parse(arg.value);
                if (Array.isArray(parsed)) {
                  const len = parsed.length;
                  if (idx >= len || idx < -len) {
                    fail(`JSON index ${idx} is out of bounds`);
                  }
                } else if (typeof parsed === "string") {
                  const len = parsed.length;
                  if (idx >= len || idx < -len) {
                    fail(`JSON index ${idx} is out of bounds`);
                  }
                }
              } catch { /* not valid JSON — let runtime handle */ }
            }
          }
        };
        literalIndexBoundsCheck();
        // Index access requires an indexable source — string, bytes, JSON,
        // array, or tuple. Numeric / bool / uuid / datetime scalars are not
        // indexable, so we reject them here (e.g. `<str>1[0]` parses as
        // `<str>(1[0])` due to precedence and the inner `1[0]` is invalid).
        const nonIndexableScalarLabel = (typeName: string): string | undefined => {
          // Heuristic: any scalar that isn't str/bytes/json is non-indexable
          // for our purposes. The reference EdgeQL diagnostic spells the type
          // as `std::int64` etc; we approximate from the FieldDef.type string.
          if (typeName === "str" || typeName === "bytes" || typeName === "json") return undefined;
          return `std::${typeName === "int" ? "int64" : typeName === "float" ? "float64" : typeName}`;
        };
        if (expr.expr.kind === "literal") {
          const value = expr.expr.value;
          if (typeof value === "number") {
            fail(`index indirection cannot be applied to scalar type 'std::int64'`);
          }
          if (typeof value === "boolean") {
            fail(`index indirection cannot be applied to scalar type 'std::bool'`);
          }
        }
        if (expr.expr.kind === "field_access" || expr.expr.kind === "path") {
          const fieldAccessSource = expr.expr.kind === "field_access"
            ? (expr.expr.expr.kind === "select_expr_subquery" ? expr.expr.expr.expr : expr.expr.expr)
            : undefined;
          const sourceTypeName = expr.expr.kind === "field_access" && fieldAccessSource && fieldAccessSource.kind === "select"
            ? normalizeTypeName(fieldAccessSource.typeName, activeModule)
            : expr.expr.kind === "path"
              ? normalizeTypeName(expr.expr.head, activeModule)
              : undefined;
          const fieldName = expr.expr.kind === "field_access" ? expr.expr.field : expr.expr.kind === "path" ? expr.expr.tail : undefined;
          if (sourceTypeName && fieldName) {
            const sourceTypeDef = schema.getType(sourceTypeName);
            const field = sourceTypeDef ? collectFields(sourceTypeDef, true).find((f) => f.name === fieldName) : undefined;
            if (field && !field.collection) {
              const label = nonIndexableScalarLabel(field.type);
              if (label) {
                fail(`index indirection cannot be applied to scalar type '${label}'`);
              }
            }
          }
        }
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
      if (expr.kind === "free_object_constructor") {
        return {
          kind: "free_object",
          entries: expr.entries.map((entry) => ({
            name: entry.name,
            expr: asNestedExprEntry(compileExprToIREntry(entry.expr, currentItemBinding)),
          })),
        };
      }
      if (expr.kind === "array_literal_expr") {
        return {
          kind: "array_literal_expr",
          values: expr.values.map((value) => asNestedExprEntry(compileExprToIREntry(value, currentItemBinding))),
        };
      }
      if (expr.kind === "slice_access") {
        // Compile-time slice evaluation for literal sources (`[1,2,3][1:]`,
        // `"hello"[1:3]`).  EdgeQL slice semantics: out-of-range bounds are
        // silently clamped; missing start/end mean 0 / length.
        const sliceClamp = (length: number, value: number | undefined, fallback: number): number => {
          if (value === undefined) return fallback;
          if (value < 0) {
            const adjusted = length + value;
            return adjusted < 0 ? 0 : adjusted;
          }
          return value > length ? length : value;
        };
        if (expr.expr.kind === "array_literal_expr") {
          const source = expr.expr.values;
          const start = sliceClamp(source.length, expr.start, 0);
          const end = sliceClamp(source.length, expr.end, source.length);
          const slice = start >= end ? [] : source.slice(start, end);
          return {
            kind: "array_literal_expr",
            values: slice.map((value) => asNestedExprEntry(compileExprToIREntry(value, currentItemBinding))),
          };
        }
        if (expr.expr.kind === "literal" && typeof expr.expr.value === "string") {
          const source = expr.expr.value;
          const start = sliceClamp(source.length, expr.start, 0);
          const end = sliceClamp(source.length, expr.end, source.length);
          const slice = start >= end ? "" : source.slice(start, end);
          return { kind: "literal", value: slice };
        }
        // Other sources (paths, casts, function calls) — fall through to the
        // generic "Unsupported" diagnostic so we don't silently misbehave.
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
      // The parser emits `{ kind: "logical", op: "and"|"or", ... }` for
      // top-level boolean operators; the IR uses `and`/`or` directly.
      if (expr.kind === "logical") {
        return {
          kind: expr.op,
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
      if (expr.kind === "unary") {
        const inner = asNestedExprEntry(compileExprToIREntry(expr.expr, currentItemBinding));
        if (expr.op === "not") {
          return { kind: "not", expr: inner };
        }
        return {
          kind: "math",
          op: "-",
          left: asNestedExprEntry({ kind: "literal", value: 0 }),
          right: inner,
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
      if (expr.kind === "coalesce") {
        return {
          kind: "coalesce",
          left: asNestedExprEntry(compileExprToIREntry(expr.left, currentItemBinding)),
          right: asNestedExprEntry(compileExprToIREntry(expr.right, currentItemBinding)),
        };
      }
      
      if (expr.kind === "for_expr") {
        // Pre-expansion: if the iterator is a literal set, expand the FOR loop
        // statically by substituting binding_ref(variable) with each literal
        // value inside the body and wrapping the copies in a UNION (set_expr).
        // This avoids needing a binding_ref scalar at SQL-compile time for the
        // common case of `FOR x IN {a, b, c} UNION (...x...)`.
        if (
          expr.iterator.kind === "set_literal"
          && expr.iterator.values.length > 0
          && expr.iterator.values.every((v) => v !== undefined && v !== null && (typeof v === "number" || typeof v === "string" || typeof v === "boolean"))
        ) {
          const substituteAny = (node: unknown, variable: string, value: number | string | boolean): unknown => {
            if (!node || typeof node !== "object") return node;
            if (Array.isArray(node)) return node.map((item) => substituteAny(item, variable, value));
            const obj = node as Record<string, unknown>;
            if (obj.kind === "binding_ref" && obj.name === variable) {
              return { kind: "literal", value };
            }
            // Inner FOR with the same variable shadows — leave its body alone.
            if (obj.kind === "for_expr" && (obj as { variable?: string }).variable === variable) {
              return node;
            }
            const result: Record<string, unknown> = {};
            for (const key of Object.keys(obj)) {
              result[key] = substituteAny(obj[key], variable, value);
            }
            return result;
          };
          const substituteBindingRef = (node: FreeObjectExpr, variable: string, value: number | string | boolean): FreeObjectExpr =>
            substituteAny(node, variable, value) as FreeObjectExpr;
          const expandedValues = expr.iterator.values.map((v) =>
            substituteBindingRef(expr.body, expr.variable, v as number | string | boolean),
          );
          const expandedSet: FreeObjectExpr = { kind: "set_expr", values: expandedValues };
          return compileExprToIREntry(expandedSet, currentItemBinding);
        }
        if (freeExprReferencesBindingLinkProperty(expr.body, expr.variable) && !forIteratorIsScopedLink(expr.iterator, currentItemBinding)) {
          fail(`unexpected reference to link property on '${expr.variable}'`);
        }
        if (
          expr.variable === "__gel_backlink_item__"
          && expr.body.kind === "backlink_path"
          && expr.iterator.kind === "binding_ref"
        ) {
          const iteratorName = normalizeTypeName(expr.iterator.name, activeModule);
          const iteratorType = schema.getType(iteratorName);
          const isEnumScalar = iteratorType?.fields.length === 1
            && iteratorType.fields[0]?.name === "__enum__"
            && (iteratorType.fields[0]?.enumValues?.length ?? 0) > 0;
          if (isEnumScalar) {
            fail("enum types do not support backlink");
          }
        }
        if (
          expr.variable === "__gel_backlink_item__"
          && expr.body.kind === "backlink_path"
        ) {
          const linkName = expr.body.link;
          const linkIsBacklinkComputed = schema.listTypes().some((candidate) => (
            (candidate.computeds ?? []).some((computed) => (
              computed.kind === "link" && computed.name === linkName && computed.expr.kind === "backlink"
            ))
          ));
          if (linkIsBacklinkComputed) {
            fail(`cannot follow backlink '${linkName}' as it targets an alias`);
          }
        }
        const iterator = asNestedExprEntry(compileExprToIREntry(expr.iterator, currentItemBinding));
        const isIndeterminateEmptyIterator = (entry: { kind: string; values?: unknown[] }): boolean => {
          if (entry.kind === "set_literal" && Array.isArray(entry.values) && entry.values.length === 0) return true;
          if (entry.kind === "set_expr") {
            return Array.isArray(entry.values) && entry.values.length > 0 && entry.values.every((v) => isIndeterminateEmptyIterator(v as { kind: string; values?: unknown[] }));
          }
          return false;
        };
        if (isIndeterminateEmptyIterator(iterator)) {
          fail("FOR statement has iterator of indeterminate type");
        }
        forBindingStack.push(expr.variable);
        // const body = asNestedExprEntry(compileExprToIREntry(expr.body, expr.variable));
        // forBindingStack.pop();
        // return {
        //   kind: "for_expr",
        //   variable: expr.variable,
        //   iterator: asNestedExprEntry(compileExprToIREntry(expr.iterator, currentItemBinding)),
        //   body,
        // };
        try {
  return {
    kind: "for_expr",
    variable: expr.variable,
    iterator,
    body: asNestedExprEntry(compileExprToIREntry(expr.body, expr.variable)),
    optional: expr.optional,
    filter: expr.filter
      ? asNestedExprEntry(compileExprToIREntry(expr.filter, expr.variable))
      : undefined,
    orderBy: expr.orderBy
      ? {
          value: asNestedExprEntry(compileExprToIREntry(expr.orderBy.expr, expr.variable)),
          direction: expr.orderBy.direction,
        }
      : undefined,
    limit: expr.limit,
    offset: expr.offset,
  };
} finally {
  forBindingStack.pop();
}
      }
      if (expr.kind === "backlink_path") {
        return {
          kind: "backlink_path",
          link: expr.link,
          sourceType: expr.sourceType,
          sourceTypeExpr: expr.sourceTypeExpr,
        };
      }
      if (expr.kind === "path_steps") {
        const first = expr.steps[0];
        if (first?.kind === "object_ref") {
          const bindingValue = withBindings.get(first.name);
          if (bindingValue) {
            let value: SelectExprIREntry;
            if (bindingValue.kind === "subquery_expr") {
              value = compileExprToIREntry(bindingValue.expr, currentItemBinding);
            } else if (bindingValue.kind === "subquery_statement") {
              value = compileExprToIREntry({ kind: "select", typeName: bindingValue.statement.typeName ?? "Object", shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }], clauses: {} }, currentItemBinding);
            } else if (bindingValue.kind === "subquery") {
              value = compileExprToIREntry({ kind: "select", typeName: bindingValue.query.typeName, shape: bindingValue.query.shape, clauses: bindingValue.query.clauses }, currentItemBinding);
            } else if (bindingValue.kind === "binding_ref") {
              value = compileExprToIREntry({ kind: "select", typeName: bindingValue.name, shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }], clauses: {} }, currentItemBinding);
            } else if (bindingValue.kind === "path") {
              value = compileExprToIREntry({ kind: "path", head: bindingValue.head, tail: bindingValue.tail, steps: bindingValue.steps }, currentItemBinding);
            } else if (bindingValue.kind === "path_chain") {
              value = compileExprToIREntry({ kind: "path_chain", parts: bindingValue.parts, steps: bindingValue.steps }, currentItemBinding);
            } else {
              value = { kind: "path_steps", steps: expr.steps };
            }
            for (const step of expr.steps.slice(1)) {
              if (step.kind === "ptr") {
                value = { kind: "field_access", value: asNestedExprEntry(value), field: step.name };
              } else if (step.kind === "type_intersection") {
                value = { kind: "is_type", value: asNestedExprEntry(value), typeName: normalizeTypeName(simpleTypeName(step.typeExpr) ?? step.typeName, activeModule) };
              }
            }
            return value;
          }
        }
        return {
          kind: "path_steps",
          steps: expr.steps,
        };
      }
      if (expr.kind === "binding_ref") {
        if (currentItemBinding && expr.name === currentItemBinding) {
          return { kind: "current_item", bindingName: expr.name };
        }
        if (forBindingStack.includes(expr.name)) {
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
            return compileExprToIREntry(
              {
                kind: "select",
                typeName: expr.name,
                shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
                clauses: {},
              },
              currentItemBinding,
            );
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
        if (bindingValue.kind === "subquery_statement") {
          return compileExprToIREntry({ kind: "select", typeName: bindingValue.statement.typeName ?? "Object", shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }], clauses: {} }, currentItemBinding);
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
        if ((currentItemBinding && expr.head === currentItemBinding) ||
        forBindingStack.includes(expr.head)) {
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
            return {
              kind: "field_access",
              value: asNestedExprEntry(compileExprToIREntry({ kind: "binding_ref", name: bindingValue.name }, currentItemBinding)),
              field: expr.tail,
            };
          }
          if (bindingValue.kind === "subquery_expr") {
            return {
              kind: "field_access",
              value: asNestedExprEntry(compileExprToIREntry(bindingValue.expr, currentItemBinding)),
              field: expr.tail,
            };
          }
          if (bindingValue.kind === "subquery") {
            return {
              kind: "field_access",
              value: asNestedExprEntry(compileExprToIREntry({ kind: "select", typeName: bindingValue.query.typeName, shape: bindingValue.query.shape, clauses: bindingValue.query.clauses }, currentItemBinding)),
              field: expr.tail,
            };
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
        const isBuiltinScalar = ["str", "int", "int16", "int32", "int64", "bigint", "float", "float32", "float64", "decimal", "bool", "json", "datetime", "duration", "local_datetime", "local_date", "local_time", "relative_duration", "date_duration", "uuid", "bytes"].includes(expr.castType);
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
            const coerceEnumValue = (entry: SelectExprIREntry): SelectExprIREntry => {
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
                    const rawValue = extractLiteralValue(item as SelectExprIREntry);
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
          if (!castTypeDef.fields.some((f) => f.name === "__enum__")) {
            return innerEntry;
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
        if (isBuiltinScalar) {
          // Pass through for non-str/json scalar casts (int, int64, bool, etc).
          // The runtime currently doesn't reshape the value; this is a no-op
          // type annotation in evaluation.
          return innerEntry;
        }
        if (/^(default::)?array<.*>$/.test(resolvedCastType)) {
          // Preserve the array<...> cast so runtime evaluation can coerce
          // JSON-null sources into an empty array. Pass-through loses that
          // signal and leaves null as the value.
          return {
            kind: "cast",
            castType: resolvedCastType,
            value: asNestedExprEntry(innerEntry),
          };
        }
        if (/^(default::)?tuple<.*>$/.test(resolvedCastType)) {
          // Preserve `tuple<...>` casts so the runtime can reshape named
          // tuples / free-objects into positional or renamed-named tuples
          // per the cast type. Dropping the cast loses the shape, leaving
          // a named-tuple value where the user asked for `tuple<T, T, T>`.
          return {
            kind: "cast",
            castType: resolvedCastType,
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
        ): SelectExprIREntry<3> => {
          if (arg.kind === "literal") {
            return { kind: "literal", value: arg.value };
          }
          if (arg.kind === "binding_ref") {
            if (bindingName && arg.name === bindingName) {
              return { kind: "current_item", bindingName: arg.name };
            }
            if (forBindingStack.includes(arg.name)) {
              return { kind: "current_item", bindingName: arg.name };
            }
            const bindingValue = withBindings.get(arg.name);
            if (bindingValue?.kind === "set_literal") {
              return { kind: "set_literal", values: [...bindingValue.values] };
            }
            if (bindingValue?.kind === "array_literal") {
              return { kind: "set_literal", values: [...bindingValue.values] };
            }
            if (!bindingValue && schema.getType(normalizeTypeName(arg.name, activeModule))) {
              return asNestedExprEntry(compileExprToIREntry({ kind: "binding_ref", name: arg.name }, bindingName)) as SelectExprIREntry<3>;
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
              args: arg.call.args.map((nestedArg): SelectExprIREntry<2> => (
                compileSelectExprFunctionArg(nestedArg, bindingName) as SelectExprIREntry<2>
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
          args: expr.call.args.map((arg): SelectExprIREntry<3> => (
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
          if (bindingValue.kind === "subquery_statement") {
            return compileExprToIREntry({ kind: "select", typeName: bindingValue.statement.typeName ?? "Object", shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }], clauses: {} }, currentItemBinding);
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

        if (schemaAlias && !aliasSourceType && schemaAlias.exprText) {
          const aliasBody = schemaAlias.exprText.replace(/;\s*$/, "");
          try {
            const parsedAlias = parseEdgeQL(`select ${aliasBody}`);
            if (parsedAlias.kind === "select_expr") {
              return compileExprToIREntry(parsedAlias.expr, currentItemBinding);
            }
          } catch {
            // fall through to default error
          }
        }

        const nestedType = requireValue(
          aliasSourceType ?? schema.getType(normalizeTypeName(expr.typeName, activeModule)),
          `object type or alias '${normalizeTypeName(expr.typeName, activeModule)}' does not exist`,
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
      // if (expr.kind === "select_expr_subquery") {
      //   const innerBinding = expr.alias ?? currentItemBinding;
      //   const addedBindingNames: string[] = [];
      //   for (const binding of expr.clauses?._withBindings ?? []) {
      //     if (!withBindings.has(binding.name)) {
      //       withBindings.set(binding.name, binding.value);
      //       addedBindingNames.push(binding.name);
      //     }
      //   }
      //   try {
      //     return {
      //       kind: "select_expr_subquery",
      //       alias: expr.alias,
      //       value: asNestedExprEntry(compileExprToIREntry(expr.expr, innerBinding)),
      //       filter: expr.filter
      //         ? asNestedExprEntry(compileExprToIREntry(expr.filter, innerBinding))
      //         : undefined,
      //       orderBy: expr.orderBy
      //         ? {
      //             value: asNestedExprEntry(compileExprToIREntry(expr.orderBy.expr, innerBinding)),
      //             direction: expr.orderBy.direction,
      //           }
      //         : undefined,
      //       limit: expr.limit,
      //       offset: expr.offset,
      //     };
      //   } finally {
      //     for (const name of addedBindingNames) {
      //       withBindings.delete(name);
      //     }
      //   }
      // }
      if (expr.kind === "select_expr_subquery") {
  const innerExpr = expr.expr;
  const aliasFromInnerSubquery = innerExpr.kind === "select_expr_subquery" ? innerExpr.alias : undefined;
  const innerBinding = expr.alias ?? aliasFromInnerSubquery ?? currentItemBinding;

  const pushedForBindings: string[] = [];
  let wrapped = expr.expr;
  while (wrapped.kind === "for_expr") {
    forBindingStack.push(wrapped.variable);
    pushedForBindings.push(wrapped.variable);
    wrapped = wrapped.body;
  }

  const addedBindingNames: string[] = [];
  for (const binding of expr.clauses?._withBindings ?? []) {
    if (!withBindings.has(binding.name)) {
      withBindings.set(binding.name, binding.value);
      addedBindingNames.push(binding.name);
    }
  }

  try {
    if (expr.limit !== undefined && expr.limit < 0) {
      fail("LIMIT must not be negative");
    }
    if (expr.offset !== undefined && expr.offset < 0) {
      fail("OFFSET must not be negative");
    }
    return {
      kind: "select_expr_subquery",
      alias: expr.alias ?? aliasFromInnerSubquery,
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
    for (let bindingIndex = 0; bindingIndex < pushedForBindings.length; bindingIndex += 1) {
      forBindingStack.pop();
    }
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

  const exprContainsMutation = (expr: FreeObjectExpr | undefined): InsertValue["kind"] | undefined => {
    if (!expr) return undefined;
    if (expr.kind === "mutation_expr") return expr.statement.kind;
    if (expr.kind === "set_expr" || expr.kind === "tuple" || expr.kind === "array_literal_expr") {
      for (const value of expr.values) {
        const nested = exprContainsMutation(value);
        if (nested) return nested;
      }
      return undefined;
    }
    if (expr.kind === "free_object_constructor") {
      for (const entry of expr.entries) {
        const nested = exprContainsMutation(entry.expr);
        if (nested) return nested;
      }
      return undefined;
    }
    if (expr.kind === "shape_projection" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "exists" || expr.kind === "field_access" || expr.kind === "index_access" || expr.kind === "slice_access" || expr.kind === "is_type" || expr.kind === "unary" || expr.kind === "select_expr_subquery") {
      return exprContainsMutation((expr as { expr: FreeObjectExpr }).expr);
    }
    if (expr.kind === "compare" || expr.kind === "math" || expr.kind === "logical" || expr.kind === "coalesce" || expr.kind === "and" || expr.kind === "or") {
      return exprContainsMutation(expr.left) ?? exprContainsMutation(expr.right);
    }
    if (expr.kind === "if_else") {
      return exprContainsMutation(expr.condition) ?? exprContainsMutation(expr.thenExpr) ?? exprContainsMutation(expr.elseExpr);
    }
    if (expr.kind === "concat") {
      for (const part of expr.parts) {
        const nested = exprContainsMutation(part);
        if (nested) return nested;
      }
    }
    if (expr.kind === "function_call") {
      for (const arg of expr.call.args) {
        if (arg.kind === "expr") {
          const nested = exprContainsMutation(arg.expr);
          if (nested) return nested;
        }
      }
    }
    return undefined;
  };

  const filterContainsMutation = (filter: FilterExpr | undefined): InsertValue["kind"] | undefined => {
    if (!filter) return undefined;
    if (filter.kind === "free_expr") return exprContainsMutation(filter.expr);
    if (filter.kind === "and" || filter.kind === "or") return filterContainsMutation(filter.left) ?? filterContainsMutation(filter.right);
    if (filter.kind === "not") return filterContainsMutation(filter.expr);
    return undefined;
  };

  if (statement.kind === "delete") {
    const mutationInFilter = filterContainsMutation(statement.filter);
    if (mutationInFilter) {
      fail(`${mutationInFilter.toUpperCase()} statements cannot be used in a FILTER clause`);
    }
    const mutationInOrder = exprContainsMutation(statement.orderBy?.expr);
    if (mutationInOrder) {
      fail(`${mutationInOrder.toUpperCase()} statements cannot be used in an ORDER BY clause`);
    }

    const bindingValue = (name: string): WithBindingValue | undefined => statement.with?.find((binding) => binding.name === name)?.value;
    const bindingExpr = (value: WithBindingValue | undefined): FreeObjectExpr | undefined => {
      if (!value) return undefined;
      if (value.kind === "subquery_expr") return value.expr;
      if (value.kind === "subquery") return { kind: "select", typeName: value.query.typeName, shape: value.query.shape, clauses: value.query.clauses };
      return undefined;
    };
    const isFreeObjectDeleteTarget = (expr: FreeObjectExpr | undefined): boolean => {
      if (!expr) return false;
      if (expr.kind === "free_object_constructor") return true;
      if (expr.kind === "binding_ref") return isFreeObjectDeleteTarget(bindingExpr(bindingValue(expr.name)));
      if (expr.kind === "select_expr_subquery") return isFreeObjectDeleteTarget(expr.expr);
      return false;
    };
    const containsStdlibDeleteTarget = (expr: FreeObjectExpr | undefined): boolean => {
      if (!expr) return false;
      if (expr.kind === "select") {
        const normalized = normalizeTypeName(expr.typeName, activeModule);
        return normalized.startsWith("schema::") || (normalized.startsWith("std::") && normalized !== "std::FreeObject");
      }
      if (expr.kind === "set_expr") return expr.values.some(containsStdlibDeleteTarget);
      if (expr.kind === "select_expr_subquery") return containsStdlibDeleteTarget(expr.expr);
      if (expr.kind === "shape_projection" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "is_type" || expr.kind === "field_access") {
        return containsStdlibDeleteTarget((expr as { expr: FreeObjectExpr }).expr);
      }
      if (expr.kind === "binding_ref") return containsStdlibDeleteTarget(bindingExpr(bindingValue(expr.name)));
      return false;
    };
    const normalizedDeleteType = normalizeTypeName(statement.typeName, activeModule);
    if (normalizedDeleteType === "std::FreeObject" || isFreeObjectDeleteTarget(statement.target)) {
      fail("free objects cannot be deleted");
    }
    if (normalizedDeleteType.startsWith("schema::") || (normalizedDeleteType.startsWith("std::") && normalizedDeleteType !== "std::Object") || containsStdlibDeleteTarget(statement.target)) {
      fail("cannot delete standard library type");
    }
    if (statement.target && (statement.target.kind === "literal" || statement.target.kind === "set_literal" || statement.target.kind === "array_literal_expr" || statement.target.kind === "tuple")) {
      fail("cannot delete non-ObjectType object");
    }
  }

  const resolvedRootType = statement.kind === "select"
    ? resolveSelectSource(statement)
    : {
        constTypeName: requireValue(statement.typeName, `Statement kind '${statement.kind}' requires typeName`),
        typeDef: (() => {
          const norm = normalizeTypeName(requireValue(statement.typeName, `Statement kind '${statement.kind}' requires typeName`), activeModule);
          if (norm === "default::Object" || norm === "std::Object") {
            return { name: "Object", module: activeModule, fields: [], abstract: true, extends: [] } as TypeDef;
          }
          return requireValue(
            schema.getType(norm),
            `Unknown type '${norm}'`,
          );
        })(),
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
      typeFilterExprs: statement.typeFilterExprs,
      branchTypeFilterExprs: statement.branchTypeFilterExprs,
      subjectBindingName: statement.typeName,
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
      if (value.kind === "function_call") {
        return;
      }
      if (value.kind === "expr") {
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

    const linkAssignments = buildInsertLinkAssignments(schema, typeDef, statement.values, linkByName);
    const linkDefaults = buildInsertLinkDefaults(schema, typeDef, statement.values);

    return {
      kind: "insert",
      pathId: toPathIdIR(pathId),
      table,
      values: scalarValues,
      linkAssignments: linkAssignments.length > 0 ? linkAssignments : undefined,
      linkDefaults: linkDefaults.length > 0 ? linkDefaults : undefined,
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
        if (typeof value === "object" && value !== null && "kind" in value && value.kind === "expr") {
          continue;
        }
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

    const updateLinkAssignments = buildUpdateLinkAssignments(schema, typeDef, statement.values, statement.operations, linkByName);

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
      linkAssignments: updateLinkAssignments.length > 0 ? updateLinkAssignments : undefined,
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
    if (deleteFilterExpr.kind === "predicate" && deleteFilterExpr.op === "=" && deleteFilterExpr.target.kind === "field") {
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
