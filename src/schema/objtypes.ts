import * as errors from "./errors.js";
import { Link } from "./links.js";

export interface QualifiedName {
  module: string;
  name: string;
}

export interface TriggerLike {
  getKinds(schema: ObjectTypeSchema): ReadonlyArray<TriggerKind>;
}

export interface AccessPolicyLike {
  name: string;
}

export interface PointerLike {
  name: string;
  nonConcrete?: boolean;
}

export type TriggerKind = "Insert" | "Update" | "Delete";

export interface ObjectTypeSchema {
  getObjectType(name: string): ObjectType | undefined;
  setObjectType(type: ObjectType): void;
  delist(name: string): ObjectTypeSchema;
  getReferrers(input: {
    target: ObjectType;
    fieldName: "target" | "union_of";
    type?: "link" | "object_type";
  }): ReadonlyArray<Link | ObjectType>;
}

export interface ComparisonContext {
  deletions?: ReadonlySet<string>;
}

export interface CommandContext {
  stdmode?: boolean;
  testmode?: boolean;
  canonical?: boolean;
  declarative?: boolean;
  disableDepVerification?: boolean;
}

export interface DeleteObjectLike {
  classname: string;
  getSubcommands(): ReadonlyArray<DeleteObjectLike>;
}

export interface DDLOperation {
  kind: string;
  name: string;
  commands?: unknown[];
}

export interface ObjectTypeData {
  id: string;
  name: string;
  module: string;
  abstract?: boolean;
  extends?: string[];
  unionOf?: string[];
  intersectionOf?: string[];
  isOpaqueUnion?: boolean;
  isView?: boolean;
  aliasIsPersistent?: boolean;
  exprType?: string;
  expr?: string;
  pointers?: PointerLike[];
  links?: Link[];
  accessPolicies?: AccessPolicyLike[];
  triggers?: TriggerLike[];
}

const STD_MODULES = new Set(["std", "schema", "sys", "cfg", "ext"]);

const qual = (module: string, name: string): string => `${module}::${name}`;

const shortName = (name: string): string => {
  if (!name.includes("::")) {
    return name;
  }
  return name.split("::").at(-1) ?? name;
};

const parseQual = (name: string): QualifiedName => {
  if (!name.includes("::")) {
    return { module: "default", name };
  }
  const [module, local] = name.split("::");
  return { module, name: local };
};

const listEq = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export class ObjectTypeRefMixin {
  accessPoliciesRefs: AccessPolicyLike[] = [];
  accessPolicies: AccessPolicyLike[] = [];

  triggersRefs: TriggerLike[] = [];
  triggers: TriggerLike[] = [];
}

export class ObjectType extends ObjectTypeRefMixin {
  public data: ObjectTypeData;

  constructor(data: ObjectTypeData) {
    super();
    this.data = {
      ...data,
      extends: [...(data.extends ?? [])],
      unionOf: [...(data.unionOf ?? [])],
      intersectionOf: [...(data.intersectionOf ?? [])],
      pointers: [...(data.pointers ?? [])],
      links: [...(data.links ?? [])],
      accessPolicies: [...(data.accessPolicies ?? [])],
      triggers: [...(data.triggers ?? [])],
    };
    this.accessPolicies = this.data.accessPolicies ?? [];
    this.triggers = this.data.triggers ?? [];
  }

  getName(_schema: ObjectTypeSchema): string {
    void _schema;
    return qual(this.data.module, this.data.name);
  }

  getShortname(_schema: ObjectTypeSchema): { name: string } {
    void _schema;
    return { name: this.data.name };
  }

  getBases(_schema: ObjectTypeSchema): ReadonlyArray<string> {
    void _schema;
    return this.data.extends ?? [];
  }

  getAncestors(schema: ObjectTypeSchema): ReadonlyArray<ObjectType> {
    const visited = new Set<string>();
    const out: ObjectType[] = [];

    const walk = (name: string): void => {
      if (visited.has(name)) {
        return;
      }
      visited.add(name);
      const parent = schema.getObjectType(name);
      if (!parent) {
        return;
      }
      out.push(parent);
      for (const base of parent.getBases(schema)) {
        walk(base);
      }
    };

    for (const base of this.getBases(schema)) {
      walk(base);
    }

    return out;
  }

  getUnionOf(_schema: ObjectTypeSchema): ReadonlyArray<string> {
    void _schema;
    return this.data.unionOf ?? [];
  }

  getIntersectionOf(_schema: ObjectTypeSchema): ReadonlyArray<string> {
    void _schema;
    return this.data.intersectionOf ?? [];
  }

  getIsOpaqueUnion(_schema: ObjectTypeSchema): boolean {
    void _schema;
    return Boolean(this.data.isOpaqueUnion);
  }

  getTriggers(_schema: ObjectTypeSchema): ReadonlyArray<TriggerLike> {
    void _schema;
    return this.triggers;
  }

  isView(_schema: ObjectTypeSchema): boolean {
    void _schema;
    return Boolean(this.data.isView);
  }

  getAliasIsPersistent(_schema: ObjectTypeSchema): boolean {
    void _schema;
    return Boolean(this.data.aliasIsPersistent);
  }

  isObjectType(): boolean {
    return true;
  }

  isFreeObjectType(schema: ObjectTypeSchema): boolean {
    if (this.getName(schema) === "std::FreeObject") {
      return true;
    }

    const freeObject = schema.getObjectType("std::FreeObject");
    if (!freeObject) {
      return false;
    }

    return this.issubclass(schema, freeObject);
  }

  isFakeObjectType(schema: ObjectTypeSchema): boolean {
    return this.isFreeObjectType(schema);
  }

  isMaterialObjectType(schema: ObjectTypeSchema): boolean {
    return !(this.isFakeObjectType(schema) || this.isCompoundType(schema) || this.isView(schema));
  }

  isUnionType(schema: ObjectTypeSchema): boolean {
    return this.getUnionOf(schema).length > 0;
  }

  isIntersectionType(schema: ObjectTypeSchema): boolean {
    return this.getIntersectionOf(schema).length > 0;
  }

  isCompoundType(schema: ObjectTypeSchema): boolean {
    return this.isUnionType(schema) || this.isIntersectionType(schema);
  }

  getDisplayname(schema: ObjectTypeSchema): string {
    const mtype = this.isView(schema) && !this.getAliasIsPersistent(schema)
      ? this.materialType(schema)
      : this;

    const unionOf = mtype.getUnionOf(schema);
    if (unionOf.length) {
      if (mtype.getIsOpaqueUnion(schema)) {
        return "std::BaseObject";
      }
      const comp = unionOf
        .map((name) => schema.getObjectType(name)?.getDisplayname(schema) ?? shortName(name))
        .sort();
      return `(${comp.join(" | ")})`;
    }

    const intersectionOf = mtype.getIntersectionOf(schema);
    if (intersectionOf.length) {
      const comp = intersectionOf
        .map((name) => schema.getObjectType(name)?.getDisplayname(schema) ?? shortName(name))
        .sort()
        .filter((dn) => dn !== "std::BaseObject");
      return `(${comp.join(" & ")})`;
    }

    return this.getName(schema);
  }

  materialType(_schema: ObjectTypeSchema): ObjectType {
    void _schema;
    return this;
  }

  getrptrs(
    schema: ObjectTypeSchema,
    name: string,
    args?: { sources?: Iterable<ObjectType> },
  ): Set<Link> {
    if (name.includes("::")) {
      throw new Error("references to concrete pointers must not be qualified");
    }

    const ptrs = new Set<Link>();
    const sourceFilter = new Set(args?.sources ? [...args.sources] : []);
    const add = (obj: ObjectType): void => {
      for (const link of schema.getReferrers({ target: obj, fieldName: "target", type: "link" })) {
        if (!(link instanceof Link)) {
          continue;
        }
        if (shortName(link.data.name) !== name) {
          continue;
        }
        const srcName = link.data.sourceType;
        if (!srcName) {
          continue;
        }
        const src = schema.getObjectType(srcName);
        if (!src || !src.isMaterialObjectType(schema)) {
          continue;
        }
        if (sourceFilter.size > 0 && !sourceFilter.has(src)) {
          continue;
        }
        ptrs.add(link);
      }
    };

    add(this);
    for (const ancestor of this.getAncestors(schema)) {
      add(ancestor);
    }

    for (const iName of this.getIntersectionOf(schema)) {
      schema.getObjectType(iName)?.getrptrs(schema, name, args).forEach((ptr) => ptrs.add(ptr));
    }

    for (const ref of schema.getReferrers({ target: this, fieldName: "union_of", type: "object_type" })) {
      if (ref instanceof ObjectType) {
        ref.getrptrs(schema, name, args).forEach((ptr) => ptrs.add(ptr));
      }
    }

    return ptrs;
  }

  getRelevantTriggers(kind: TriggerKind, schema: ObjectTypeSchema): TriggerLike[] {
    return this.getTriggers(schema).filter((trigger) => trigger.getKinds(schema).includes(kind));
  }

  implicitlyCastableTo(other: ObjectType, schema: ObjectTypeSchema): boolean {
    return this.issubclass(schema, other);
  }

  findCommonImplicitlyCastableType(
    other: ObjectType,
    schema: ObjectTypeSchema,
  ): [ObjectTypeSchema, ObjectType | null] {
    const ourAncestors = [this, ...this.getAncestors(schema)];
    const theirLineage = new Set([other, ...other.getAncestors(schema)]);
    const common = ourAncestors.find((candidate) => theirLineage.has(candidate)) ?? null;
    return [schema, common];
  }

  static getRootClasses(): readonly [QualifiedName, QualifiedName, QualifiedName] {
    return [
      { module: "std", name: "BaseObject" },
      { module: "std", name: "Object" },
      { module: "std", name: "FreeObject" },
    ] as const;
  }

  static getDefaultBaseName(): QualifiedName {
    return { module: "std", name: "Object" };
  }

  issubclass(schema: ObjectTypeSchema, parent: ObjectType): boolean {
    return this._issubclass(schema, parent);
  }

  protected _issubclass(schema: ObjectTypeSchema, parent: ObjectType): boolean {
    if (this === parent || this.getName(schema) === parent.getName(schema)) {
      return true;
    }

    const myUnion = this.getUnionOf(schema);
    if (myUnion.length && !this.getIsOpaqueUnion(schema)) {
      return myUnion.every((name) => schema.getObjectType(name)?._issubclass(schema, parent) ?? false);
    }

    const myIntersection = this.getIntersectionOf(schema);
    if (myIntersection.length) {
      return myIntersection.some((name) => schema.getObjectType(name)?._issubclass(schema, parent) ?? false);
    }

    if (this.getAncestors(schema).some((anc) => anc.getName(schema) === parent.getName(schema))) {
      return true;
    }

    const parentUnion = parent.getUnionOf(schema);
    if (parentUnion.length && !parent.getIsOpaqueUnion(schema)) {
      return parentUnion.some((name) => {
        const t = schema.getObjectType(name);
        return t ? this._issubclass(schema, t) : false;
      });
    }

    const parentIntersection = parent.getIntersectionOf(schema);
    if (parentIntersection.length) {
      return parentIntersection.every((name) => {
        const t = schema.getObjectType(name);
        return t ? this._issubclass(schema, t) : false;
      });
    }

    return false;
  }

  allowRefPropagation(_schema: ObjectTypeSchema, _context: CommandContext, refdict: { attr: string }): boolean {
    return !this.data.isView || refdict.attr === "pointers";
  }

  asTypeDeleteIfUnused(schema: ObjectTypeSchema): DeleteObjectType | null {
    if (!this.isDeletable(schema)) {
      return null;
    }

    if ((this.isView(schema) && this.getAliasIsPersistent(schema)) || this.isCompoundType(schema)) {
      return new DeleteObjectType(qual(this.data.module, this.data.name), this, {
        ifUnused: true,
        ifExists: true,
      });
    }

    return null;
  }

  testPolymorphic(_schema: ObjectTypeSchema, other: { isAnyobject(): boolean }): boolean {
    return other.isAnyobject();
  }

  private isDeletable(_schema: ObjectTypeSchema): boolean {
    void _schema;
    return true;
  }
}

export const getOrCreateUnionType = (
  schema: ObjectTypeSchema,
  components: Iterable<ObjectType>,
  args?: {
    transient?: boolean;
    opaque?: boolean;
    module?: string;
  },
): [ObjectTypeSchema, ObjectType, boolean] => {
  const opaque = Boolean(args?.opaque);
  const module = args?.module ?? "__derived__";
  const componentNames = [...components].map((c) => c.getName(schema)).sort();
  const unionName = `${module}::${opaque ? "opaque_union" : "union"}<${componentNames.join("|")}>`;

  const existing = schema.getObjectType(unionName);
  if (existing) {
    return [schema, existing, false];
  }

  const union = new ObjectType({
    id: unionName,
    module,
    name: shortName(unionName),
    abstract: true,
    unionOf: componentNames,
    isOpaqueUnion: opaque,
  });

  schema.setObjectType(union);
  return [schema, union, true];
};

export const getOrCreateIntersectionType = (
  schema: ObjectTypeSchema,
  components: Iterable<ObjectType>,
  args?: {
    module?: string;
    transient?: boolean;
  },
): [ObjectTypeSchema, ObjectType, boolean] => {
  const module = args?.module ?? "__derived__";
  const componentNames = [...components].map((c) => c.getName(schema)).sort();
  const intersectionName = `${module}::intersection<${componentNames.join("&")}>`;

  const existing = schema.getObjectType(intersectionName);
  if (existing) {
    return [schema, existing, false];
  }

  const intersection = new ObjectType({
    id: intersectionName,
    module,
    name: shortName(intersectionName),
    abstract: true,
    intersectionOf: componentNames,
  });

  schema.setObjectType(intersection);
  return [schema, intersection, true];
};

export class ObjectTypeCommandContext {
  constructor(public readonly context: CommandContext = {}) {}
}

class BaseObjectTypeCommand {
  constructor(
    public readonly classname: string,
    public readonly scls: ObjectType,
  ) {}

  protected get friendlyName(): string {
    return this.classname;
  }

  protected getAttributeValue<K extends keyof ObjectTypeData>(key: K): ObjectTypeData[K] {
    return this.scls.data[key];
  }

  protected getOrigAttributeValue<K extends keyof ObjectTypeData>(key: K): ObjectTypeData[K] {
    return this.scls.data[key];
  }

  protected propagateIfExprRefs(schema: ObjectTypeSchema): ObjectTypeSchema {
    return schema;
  }

  getFriendlyDescription(): string {
    return this.friendlyName;
  }
}

export class ObjectTypeCommand extends BaseObjectTypeCommand {
  validateObject(schema: ObjectTypeSchema, context: CommandContext): void {
    if (!context.stdmode && !context.testmode && this.scls.isMaterialObjectType(schema)) {
      for (const baseName of this.scls.getBases(schema)) {
        const qn = parseQual(baseName);
        if (
          STD_MODULES.has(qn.module)
          && baseName !== "std::BaseObject"
          && baseName !== "std::Object"
        ) {
          throw new errors.SchemaDefinitionError(`cannot extend system type '${baseName}'`);
        }
      }
    }

    const rootMod = parseQual(this.classname).module;
    if (this.scls.isMaterialObjectType(schema) && STD_MODULES.has(rootMod)) {
      for (const baseName of this.scls.getBases(schema)) {
        if (baseName === "std::Object") {
          throw new errors.SchemaDefinitionError(
            `standard lib/extension type '${this.classname}' cannot extend std::Object`,
          );
        }
      }
    }
  }
}

export class CreateObjectType extends ObjectTypeCommand {
  static readonly astnode = "CreateObjectType" as const;

  getAst(_schema: ObjectTypeSchema, _context: CommandContext, parentNode?: DDLOperation): DDLOperation | undefined {
    if (this.getAttributeValue("exprType") && !this.getAttributeValue("expr")) {
      return undefined;
    }
    return parentNode ?? {
      kind: this.getAstNode(),
      name: this.classname,
      commands: [],
    };
  }

  getAstNode(): string {
    if (this.getAttributeValue("exprType")) {
      return "CreateAlias";
    }
    return "CreateObjectType";
  }

  createFinalize(schema: ObjectTypeSchema, context: CommandContext): ObjectTypeSchema {
    if (!context.canonical && this.scls.isMaterialObjectType(schema)) {
      schema = this.propagateIfExprRefs(schema);
    }
    return schema;
  }
}

export class RenameObjectType extends ObjectTypeCommand {}

export class RebaseObjectType extends ObjectTypeCommand {}

export class AlterObjectType extends ObjectTypeCommand {
  static readonly astnode = "AlterObjectType" as const;

  alterBegin(schema: ObjectTypeSchema, context: CommandContext): ObjectTypeSchema {
    if (!context.canonical) {
      schema = this.propagateIfExprRefs(schema);
    }
    return schema;
  }

  alterFinalize(schema: ObjectTypeSchema, context: CommandContext): ObjectTypeSchema {
    if (!context.canonical) {
      const unions = schema.getReferrers({
        target: this.scls,
        fieldName: "union_of",
        type: "object_type",
      });

      const originalDisable = context.disableDepVerification;
      for (const unionRef of unions) {
        if (!(unionRef instanceof ObjectType)) {
          continue;
        }
        if (unionRef.getIsOpaqueUnion(schema)) {
          continue;
        }

        context.disableDepVerification = true;
        const deleteCmd = new DeleteObjectType(unionRef.getName(schema), unionRef, {});
        const nschema = deleteToDelist(deleteCmd.asDeleteTree(), schema);
        context.disableDepVerification = originalDisable;

        const [, rebuiltUnion] = getOrCreateUnionType(nschema, unionRef.getUnionOf(schema)
          .map((name) => schema.getObjectType(name))
          .filter((t): t is ObjectType => Boolean(t)), {
          opaque: unionRef.getIsOpaqueUnion(schema),
          module: parseQual(unionRef.getName(schema)).module,
        });

        if (!listEq(unionRef.getUnionOf(schema), rebuiltUnion.getUnionOf(schema))) {
          schema.setObjectType(rebuiltUnion);
        }
      }
    }

    return schema;
  }
}

export const deleteToDelist = (deleteCmd: DeleteObjectLike, schema: ObjectTypeSchema): ObjectTypeSchema => {
  let next = schema.delist(deleteCmd.classname);
  for (const sub of deleteCmd.getSubcommands()) {
    next = deleteToDelist(sub, next);
  }
  return next;
};

export class DeleteObjectType extends ObjectTypeCommand {
  static readonly astnode = "DropObjectType" as const;

  constructor(
    classname: string,
    scls: ObjectType,
    private readonly options: {
      ifUnused?: boolean;
      ifExists?: boolean;
    },
  ) {
    super(classname, scls);
  }

  getAst(_schema: ObjectTypeSchema, _context: CommandContext, parentNode?: DDLOperation): DDLOperation | undefined {
    if (this.getOrigAttributeValue("exprType")) {
      return undefined;
    }

    return parentNode ?? {
      kind: "DropObjectType",
      name: this.classname,
      commands: [this.options],
    };
  }

  deleteFinalize(schema: ObjectTypeSchema, context: CommandContext): ObjectTypeSchema {
    if (!context.canonical && this.scls.isMaterialObjectType(schema)) {
      schema = this.propagateIfExprRefs(schema);
    }
    return schema;
  }

  asDeleteTree(): DeleteObjectLike {
    return {
      classname: this.classname,
      getSubcommands: () => [],
    };
  }
}

// snake_case aliases for easier source-file parity searches
export const get_or_create_union_type = getOrCreateUnionType;
export const get_or_create_intersection_type = getOrCreateIntersectionType;
export const _delete_to_delist = deleteToDelist;
