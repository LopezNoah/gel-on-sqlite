import type { SchemaSnapshot } from "../schema/schema.js";
import type {
  ComputedDef,
  ComputedLinkPropertyDef,
  FieldDef,
  LinkDef,
  LinkPropertyDef,
  ScalarType,
  TypeDef,
} from "../types.js";

export type PointerDirection = "outbound" | "inbound";
export type PathNamespace = Iterable<string>;

export type TypeRef = {
  readonly kind: "object" | "scalar";
  readonly name: string;
  readonly displayName: string;
};

export type PointerRef = {
  readonly name: string;
  readonly shortName: string;
  readonly sourceType: TypeRef;
  readonly targetType: TypeRef;
  readonly sourcePointer?: PointerRef;
  readonly link?: LinkDef;
  readonly field?: FieldDef;
  readonly linkProperty?: LinkPropertyDef | ComputedLinkPropertyDef;
};

type PathStep = {
  readonly pointer: PointerRef;
  readonly direction: PointerDirection;
  readonly target: TypeRef;
};

const SCALAR_DISPLAY_NAMES: Record<string, string> = {
  bool: "std::bool",
  date_duration: "std::date_duration",
  datetime: "std::datetime",
  duration: "std::duration",
  float: "std::float64",
  int: "std::int64",
  json: "std::json",
  local_date: "std::cal::local_date",
  local_datetime: "std::cal::local_datetime",
  local_time: "std::cal::local_time",
  relative_duration: "std::relative_duration",
  str: "std::str",
  uuid: "std::uuid",
};

const normalizeTypeName = (name: string): string =>
  name.includes("::") ? name : `default::${name}`;

const qualifiedTypeName = (typeDef: TypeDef): string =>
  `${typeDef.module ?? "default"}::${typeDef.name}`;

const scalarTypeRef = (scalar: ScalarType | string): TypeRef => {
  const displayName = SCALAR_DISPLAY_NAMES[scalar] ?? (scalar.includes("::") ? scalar : `std::${scalar}`);
  return { kind: "scalar", name: displayName, displayName };
};

const objectTypeRef = (schema: SchemaSnapshot, name: string): TypeRef => {
  const normalized = normalizeTypeName(name);
  if (!schema.getType(normalized)) {
    throw new Error(`Unknown object type: ${normalized}`);
  }
  return { kind: "object", name: normalized, displayName: normalized };
};

const dedupeByName = <T extends { name: string }>(items: readonly T[]): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
};

const collectFields = (
  schema: SchemaSnapshot,
  typeName: string,
  seen = new Set<string>(),
): FieldDef[] => {
  if (seen.has(typeName)) return [];
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) return [];

  const inherited = (typeDef.extends ?? []).flatMap((baseName) =>
    collectFields(schema, baseName, seen),
  );

  return dedupeByName([...typeDef.fields, ...inherited]);
};

const collectLinks = (
  schema: SchemaSnapshot,
  typeName: string,
  seen = new Set<string>(),
): LinkDef[] => {
  if (seen.has(typeName)) return [];
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) return [];

  const inherited = (typeDef.extends ?? []).flatMap((baseName) =>
    collectLinks(schema, baseName, seen),
  );

  return dedupeByName([...(typeDef.links ?? []), ...inherited]);
};

const collectComputeds = (
  schema: SchemaSnapshot,
  typeName: string,
  seen = new Set<string>(),
): ComputedDef[] => {
  if (seen.has(typeName)) return [];
  seen.add(typeName);

  const typeDef = schema.getType(typeName);
  if (!typeDef) return [];

  const inherited = (typeDef.extends ?? []).flatMap((baseName) =>
    collectComputeds(schema, baseName, seen),
  );

  return dedupeByName([...(typeDef.computeds ?? []), ...inherited]);
};

const typeRefForField = (field: FieldDef | LinkPropertyDef): TypeRef =>
  scalarTypeRef(field.type);

const inferLiteralScalar = (value: unknown): ScalarType => {
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    default:
      return "str";
  }
};

const inferComputedPropertyType = (
  schema: SchemaSnapshot,
  sourceTypeName: string,
  computed: Extract<ComputedDef, { kind: "property" }>,
): TypeRef => {
  const expr = computed.expr;
  if (expr.kind === "concat") return scalarTypeRef("str");
  if (expr.kind === "field_ref") {
    const field = collectFields(schema, sourceTypeName).find((candidate) => candidate.name === expr.field);
    return field ? typeRefForField(field) : scalarTypeRef("str");
  }
  if (expr.kind === "literal") return scalarTypeRef(inferLiteralScalar(expr.value));
  if (expr.kind === "link_aggregate") return scalarTypeRef("int");
  if (expr.kind === "set_literal") {
    return scalarTypeRef(expr.values.length > 0 ? inferLiteralScalar(expr.values[0]) : "str");
  }
  return scalarTypeRef("str");
};

const inferComputedLinkTarget = (
  schema: SchemaSnapshot,
  sourceType: TypeRef,
  computed: Extract<ComputedDef, { kind: "link" }>,
): TypeRef => {
  const expr = computed.expr;
  if (expr.kind === "backlink") {
    if (expr.sourceType) return objectTypeRef(schema, expr.sourceType);

    const sourceTypeName = schema.listTypes().find((typeDef) =>
      collectLinks(schema, qualifiedTypeName(typeDef)).some((link) =>
        link.name === expr.link && normalizeTypeName(link.targetType) === sourceType.name,
      ),
    );
    if (sourceTypeName) return objectTypeRef(schema, qualifiedTypeName(sourceTypeName));
  }

  if (expr.kind === "link_ref") {
    const link = collectLinks(schema, sourceType.name).find((candidate) => candidate.name === expr.link);
    if (link) return objectTypeRef(schema, link.targetType);
  }

  if (expr.kind === "select_type") {
    return objectTypeRef(schema, expr.typeName);
  }

  throw new Error(`Cannot infer target type for computed link '${computed.name}' on ${sourceType.name}`);
};

const resolvePointer = (schema: SchemaSnapshot, sourceType: TypeRef, stepName: string): PointerRef => {
  if (sourceType.kind !== "object") {
    throw new Error(`Cannot resolve pointer '${stepName}' on scalar type ${sourceType.displayName}`);
  }

  const sourceQualifiedName = sourceType.name;
  const link = collectLinks(schema, sourceQualifiedName).find((candidate) => candidate.name === stepName);
  if (link) {
    return {
      name: `${sourceQualifiedName}.${link.name}`,
      shortName: link.name,
      sourceType,
      targetType: objectTypeRef(schema, link.targetType),
      link,
    };
  }

  const field = collectFields(schema, sourceQualifiedName).find((candidate) => candidate.name === stepName);
  if (field) {
    return {
      name: `${sourceQualifiedName}.${field.name}`,
      shortName: field.name,
      sourceType,
      targetType: typeRefForField(field),
      field,
    };
  }

  const computed = collectComputeds(schema, sourceQualifiedName).find((candidate) => candidate.name === stepName);
  if (computed?.kind === "property") {
    return {
      name: `${sourceQualifiedName}.${computed.name}`,
      shortName: computed.name,
      sourceType,
      targetType: inferComputedPropertyType(schema, sourceQualifiedName, computed),
    };
  }
  if (computed?.kind === "link") {
    return {
      name: `${sourceQualifiedName}.${computed.name}`,
      shortName: computed.name,
      sourceType,
      targetType: inferComputedLinkTarget(schema, sourceType, computed),
    };
  }

  throw new Error(`Unknown pointer '${stepName}' on ${sourceQualifiedName}`);
};

const inferComputedLinkPropertyType = (property: ComputedLinkPropertyDef): TypeRef => {
  const expr = property.computedExpr;
  if (expr.kind === "binary_op" && expr.op === "++") return scalarTypeRef("str");
  return scalarTypeRef("int");
};

const resolveLinkProperty = (sourcePointer: PointerRef, propertyName: string): PointerRef => {
  const property = sourcePointer.link?.properties?.find((candidate) => candidate.name === propertyName);
  if (property) {
    return {
      name: `${sourcePointer.name}@${property.name}`,
      shortName: property.name,
      sourceType: sourcePointer.targetType,
      targetType: typeRefForField(property),
      sourcePointer,
      linkProperty: property,
    };
  }

  const computedProperty = sourcePointer.link?.computedProperties?.find((candidate) => candidate.name === propertyName);
  if (computedProperty) {
    return {
      name: `${sourcePointer.name}@${computedProperty.name}`,
      shortName: computedProperty.name,
      sourceType: sourcePointer.targetType,
      targetType: inferComputedLinkPropertyType(computedProperty),
      sourcePointer,
      linkProperty: computedProperty,
    };
  }

  throw new Error(`Unknown link property '@${propertyName}' on ${sourcePointer.name}`);
};

const namespaceFrom = (namespace?: PathNamespace): Set<string> =>
  new Set(namespace ?? []);

const setEquals = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((item) => right.has(item));

const union = (left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> =>
  new Set([...left, ...right]);

const difference = (left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> =>
  new Set([...left].filter((item) => !right.has(item)));

const namespacePrefix = (namespace: ReadonlySet<string>): string => {
  if (namespace.size === 0) return "";
  return `${[...namespace].sort().join("@")}@@`;
};

const pointerDirectionSymbol = (direction: PointerDirection): ">" | "<" =>
  direction === "outbound" ? ">" : "<";

export class PathId {
  private constructor(
    private readonly root: TypeRef,
    private readonly steps: readonly PathStep[],
    private readonly ns: ReadonlySet<string>,
    private readonly prefix: PathId | undefined,
    private readonly pointerPath: boolean,
    private readonly linkPropertyPath: boolean,
  ) {}

  static fromType(
    schema: SchemaSnapshot,
    typeName: string,
    options: { namespace?: PathNamespace } = {},
  ): PathId {
    return new PathId(
      objectTypeRef(schema, typeName),
      [],
      namespaceFrom(options.namespace),
      undefined,
      false,
      false,
    );
  }

  get namespace(): Set<string> {
    return new Set(this.ns);
  }

  get target(): TypeRef {
    return this.steps.at(-1)?.target ?? this.root;
  }

  extend(
    schema: SchemaSnapshot,
    stepName: string,
    options: { namespace?: PathNamespace; direction?: PointerDirection } = {},
  ): PathId {
    if (stepName.startsWith("@")) {
      const sourcePointer = this.rptr();
      if (!sourcePointer) {
        throw new Error(`Cannot resolve link property '${stepName}' without a source pointer`);
      }

      return this.ptrPath().extendPointer(
        resolveLinkProperty(sourcePointer, stepName.slice(1)),
        options,
      );
    }

    return this.extendPointer(resolvePointer(schema, this.target, stepName), options);
  }

  extendPointer(
    pointer: PointerRef,
    options: { namespace?: PathNamespace; direction?: PointerDirection } = {},
  ): PathId {
    const direction = options.direction ?? "outbound";
    const isLinkProperty = pointer.sourcePointer !== undefined;

    if (isLinkProperty && !this.pointerPath) {
      throw new Error("link property path extension on a non-link path");
    }

    const namespace = namespaceFrom(options.namespace);
    const nextNamespace = namespace.size > 0
      ? this.ns.size > 0 ? union(this.ns, namespace) : namespace
      : new Set(this.ns);
    const prefix = setEquals(this.ns, nextNamespace) ? this.prefix : this;
    const target = direction === "outbound" ? pointer.targetType : pointer.sourceType;

    return new PathId(
      this.root,
      [...this.steps, { pointer, direction, target }],
      nextNamespace,
      prefix,
      false,
      isLinkProperty,
    );
  }

  equals(other: PathId): boolean {
    return this.pointerPath === other.pointerPath
      && this.pathSignature() === other.pathSignature()
      && setEquals(this.ns, other.ns)
      && ((this.prefix === undefined && other.prefix === undefined)
        || (this.prefix !== undefined && other.prefix !== undefined && this.prefix.equals(other.prefix)));
  }

  startsWith(
    pathId: PathId,
    options: { permissivePointerPath?: boolean } = {},
  ): boolean {
    const base = this.prefixForPathSize(pathId.pathSize);
    return base.equals(pathId)
      || Boolean(options.permissivePointerPath && base.tgtPath().equals(pathId));
  }

  *iterPrefixes(options: { includePointerPaths?: boolean } = {}): IterableIterator<PathId> {
    let start = 1;
    if (this.prefix) {
      yield* this.prefix.iterPrefixes(options);
      start = this.prefix.pathSize;
    } else {
      yield this.prefixForPathSize(1);
    }

    for (let i = start; i < this.pathSize - 1; i += 2) {
      const pathId = this.prefixForPathSize(i + 2);
      if (pathId.isPointerPath()) {
        yield pathId.tgtPath();
        if (options.includePointerPaths) yield pathId;
      } else {
        yield pathId;
      }
    }
  }

  rptr(): PointerRef | undefined {
    return this.steps.at(-1)?.pointer;
  }

  rptrDirection(): PointerDirection | undefined {
    return this.steps.at(-1)?.direction;
  }

  rptrName(): string | undefined {
    return this.rptr()?.shortName;
  }

  srcPath(): PathId | undefined {
    return this.steps.length === 0 ? undefined : this.prefixForPathSize(this.pathSize - 2);
  }

  ptrPath(): PathId {
    if (this.pointerPath) return this;
    return new PathId(this.root, this.steps, this.ns, this.prefix, true, this.linkPropertyPath);
  }

  tgtPath(): PathId {
    if (!this.pointerPath) return this;
    return new PathId(this.root, this.steps, this.ns, this.prefix, false, this.linkPropertyPath);
  }

  isObjectTypePath(): boolean {
    return !this.pointerPath && this.target.kind === "object";
  }

  isScalarPath(): boolean {
    return !this.pointerPath && this.target.kind === "scalar";
  }

  isPointerPath(): boolean {
    return this.pointerPath;
  }

  isLinkPropertyPath(): boolean {
    return this.linkPropertyPath;
  }

  toString(): string {
    let result = `${namespacePrefix(this.ns)}(${this.root.displayName})`;

    for (const step of this.steps) {
      const lexpr = `${step.pointer.shortName}[IS ${step.target.displayName}]`;
      result += step.pointer.sourcePointer
        ? `@${lexpr}`
        : `.${pointerDirectionSymbol(step.direction)}${lexpr}`;
    }

    if (this.pointerPath) result += "@";
    return result;
  }

  private get pathSize(): number {
    return 1 + this.steps.length * 2;
  }

  private pathSignature(): string {
    return JSON.stringify([
      this.root.name,
      ...this.steps.flatMap((step) => [
        step.pointer.name,
        step.direction,
        step.pointer.sourcePointer !== undefined,
        step.target.name,
      ]),
    ]);
  }

  private prefixForPathSize(size: number): PathId {
    const normalizedSize = size < 0 ? this.pathSize + size : size;
    if (normalizedSize === this.pathSize) return this;
    if (normalizedSize > this.pathSize) return this;
    if (normalizedSize < 1 || normalizedSize % 2 === 0) {
      throw new Error(`Invalid PathId prefix size: ${size}`);
    }

    if (this.prefix) {
      if (this.prefix.pathSize === normalizedSize) return this.prefix;
      if (this.prefix.pathSize > normalizedSize) return this.prefix.prefixForPathSize(normalizedSize);
    }

    const stepCount = (normalizedSize - 1) / 2;
    const steps = this.steps.slice(0, stepCount);
    const nextStep = this.steps[stepCount];
    const isPointerPath = nextStep?.pointer.sourcePointer !== undefined;
    const isLinkPropertyPath = steps.at(-1)?.pointer.sourcePointer !== undefined;

    return new PathId(
      this.root,
      steps,
      this.ns,
      this.prefix,
      isPointerPath,
      isLinkPropertyPath,
    );
  }
}

export const replacePathIdPrefix = (
  pathId: PathId,
  prefix: PathId,
  replacement: PathId,
  options: { permissivePointerPath?: boolean } = {},
): PathId => {
  if (!pathId.startsWith(prefix, options)) return pathId;

  let result = replacement;
  const prefixes = [...pathId.iterPrefixes({ includePointerPaths: prefix.isPointerPath() })];
  let lastNamespace = prefix.namespace;
  let start = prefixes.findIndex((candidate) => candidate.equals(prefix));

  if (start === -1 && options.permissivePointerPath) {
    start = prefixes.findIndex((candidate) => candidate.equals(prefix.ptrPath()));
  }
  if (start === -1) {
    throw new Error("PathId prefix was not found after startsWith succeeded");
  }

  for (const part of prefixes.slice(start + 1)) {
    if (part.isPointerPath()) continue;

    const pointer = part.rptr();
    const direction = part.rptrDirection();
    if (!pointer || !direction) continue;

    if (pointer.sourcePointer) {
      result = result.ptrPath();
    }

    const partNamespace = part.namespace;
    result = result.extendPointer(pointer, {
      direction,
      namespace: difference(partNamespace, lastNamespace),
    });
    lastNamespace = partNamespace;
  }

  return pathId.isPointerPath() ? result.ptrPath() : result;
};
