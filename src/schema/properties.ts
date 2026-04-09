import * as errors from "./errors.js";
import type { Expression } from "./expr.js";
import { Link } from "./links.js";

export enum SchemaCardinality {
  One = "One",
  Many = "Many",
}

export interface PropertyTypeLike {
  getVerbosename(schema: PropertySchema): string;
  isPolymorphic(schema: PropertySchema): boolean;
  isObjectType(): boolean;
  containsObject?(schema: PropertySchema): boolean;
  isView?(schema: PropertySchema): boolean;
}

export interface PointerLike {
  name: string;
  source?: unknown;
  target?: PropertyTypeLike;
  nonConcrete?: boolean;
  special?: boolean;
  pureComputable?: boolean;
}

export interface ObjectShellLike {
  resolve(schema: PropertySchema): unknown;
}

export interface PropertySchema {
  getProperty(name: string): Property | undefined;
  getType(name: string): PropertyTypeLike | undefined;
}

export interface ComparisonContext {
  deletions?: ReadonlySet<string>;
}

export interface CommandContext {
  get<T>(ctx: new (...args: any[]) => T): T | undefined;
}

export interface AlterObjectProperty {
  property: string;
  newValue: unknown;
}

export interface DDLOperation {
  kind: string;
  span?: unknown;
  target?: unknown;
  commands: DDLSubcommand[];
}

export type DDLSubcommand =
  | {
      kind: "CreateConcretePointer";
    }
  | {
      kind: "OnSourceDelete";
    }
  | {
      kind: "OnTargetDelete";
    }
  | {
      kind: "SetPointerType";
      value: unknown;
    }
  | {
      kind: "SetField";
      name: string;
      value: unknown;
    };

export interface PropertyData {
  name: string;
  source?: unknown;
  target?: PropertyTypeLike;
  required?: boolean;
  cardinality?: SchemaCardinality;
  owned?: boolean;
  special?: boolean;
  pureComputable?: boolean;
  endpointPointer?: boolean;
  nonConcrete?: boolean;
  fromAlias?: boolean;
}

export class Property {
  constructor(public data: PropertyData) {}

  getShortname(_schema: PropertySchema): { name: string } {
    return { name: this.data.name };
  }

  getTarget(_schema: PropertySchema): PropertyTypeLike | undefined {
    return this.data.target;
  }

  getSource(_schema: PropertySchema): unknown {
    return this.data.source;
  }

  isSpecialPointer(_schema: PropertySchema): boolean {
    return Boolean(this.data.special);
  }

  isPureComputable(_schema: PropertySchema): boolean {
    return Boolean(this.data.pureComputable);
  }

  isNonConcrete(_schema: PropertySchema): boolean {
    return Boolean(this.data.nonConcrete);
  }

  isEndpointPointer(_schema: PropertySchema): boolean {
    return Boolean(this.data.endpointPointer);
  }

  issubclass(_schema: PropertySchema, other: Property): boolean {
    if (this.data.name === other.data.name) {
      return true;
    }
    if (other.data.name === "std::source" && this.data.name.endsWith("source")) {
      return true;
    }
    return false;
  }

  deriveRef(
    schema: PropertySchema,
    referrer: { getSource?(schema: PropertySchema): unknown; getFieldValue?(schema: PropertySchema, field: string): unknown },
    options?: {
      target?: PropertyTypeLike;
      attrs?: Partial<PropertyData>;
    },
  ): [PropertySchema, Property] {
    const target = options?.target ?? this.getTarget(schema);
    const ptr = new Property({
      ...this.data,
      ...options?.attrs,
      target,
    });

    const ptrSn = ptr.getShortname(schema).name;
    if (ptrSn === "std::source") {
      ptr.data.target = referrer.getSource?.(schema) as PropertyTypeLike;
    } else if (ptrSn === "std::target") {
      ptr.data.target = referrer.getFieldValue?.(schema, "target") as PropertyTypeLike;
    }

    return [schema, ptr];
  }

  compare(other: unknown, schema: PropertySchema, _context: ComparisonContext): number {
    if (!(other instanceof Property)) {
      if (typeof other === "object" && other !== null) {
        return 0;
      }
      throw new Error("cannot compare property with non-object");
    }

    let similarity = 1;
    if (this.data.name !== other.data.name) {
      similarity *= 0.8;
    }

    if (
      !this.isNonConcrete(schema)
      && !other.isNonConcrete(schema)
      && this.issubclass(schema, new Property({ name: "std::source" }))
      && other.issubclass(schema, new Property({ name: "std::source" }))
    ) {
      // std::source target differences are intentionally ignored
      return similarity;
    }

    if ((this.data.target?.getVerbosename(schema) ?? "") !== (other.data.target?.getVerbosename(schema) ?? "")) {
      similarity *= 0.9;
    }

    return similarity;
  }

  shouldPropagate(schema: PropertySchema): boolean {
    return !this.isEndpointPointer(schema);
  }

  static isProperty(): boolean {
    return true;
  }

  hasUserDefinedProperties(_schema: PropertySchema): boolean {
    return false;
  }

  isLinkProperty(schema: PropertySchema): boolean {
    return this.getSource(schema) instanceof Link;
  }

  allowRefPropagation(schema: PropertySchema): boolean {
    const source = this.getSource(schema);
    if (source instanceof Link) {
      if ((source as Link).data.pureComputable) {
        return true;
      }
      return true;
    }

    const sourceType = source as PropertyTypeLike | undefined;
    return !sourceType?.isView?.(schema);
  }

  static getRootClasses(): readonly [{ module: "std"; name: "property" }] {
    return [{ module: "std", name: "property" }] as const;
  }

  static getDefaultBaseName(): { module: "std"; name: "property" } {
    return { module: "std", name: "property" };
  }

  isBlockingRef(schema: PropertySchema): boolean {
    return !this.isEndpointPointer(schema);
  }

  initDeltaCommand<T extends { isStrongRef?: boolean }>(schema: PropertySchema, cmd: T): T {
    void schema;
    cmd.isStrongRef = this.isSpecialPointer(schema);
    return cmd;
  }
}

export class PropertySourceContext<SourceT = unknown> {
  constructor(public readonly source?: SourceT) {}
}

export class PropertySourceCommand<SourceT = unknown> {
  constructor(public readonly source?: SourceT) {}
}

export class PropertyCommandContext {}

class BasePropertyCommand {
  constructor(
    public readonly scls: Property,
    protected readonly attributes: Partial<PropertyData> = {},
  ) {}

  protected getAttributeValue<K extends keyof PropertyData>(key: K): PropertyData[K] | undefined {
    return (this.attributes[key] ?? this.scls.data[key]) as PropertyData[K] | undefined;
  }
}

export class PropertyCommand extends BasePropertyCommand {
  validateObject(schema: PropertySchema): void {
    const scls = this.scls;
    if (!scls.data.owned) {
      return;
    }

    if (scls.isSpecialPointer(schema)) {
      return;
    }

    if (scls.isLinkProperty(schema) && !scls.isPureComputable(schema)) {
      if (this.getAttributeValue("cardinality") === SchemaCardinality.Many) {
        throw new errors.InvalidPropertyDefinitionError("multi properties aren't supported for links");
      }
    }

    const targetType = scls.getTarget(schema);
    if (!targetType) {
      throw new Error(`missing target type in property ${scls.data.name}`);
    }

    if (targetType.isPolymorphic(schema)) {
      throw new errors.InvalidPropertyTargetError(
        `invalid property type: ${targetType.getVerbosename(schema)} is a generic type`,
      );
    }

    if (targetType.isObjectType() || targetType.containsObject?.(schema)) {
      throw new errors.InvalidPropertyTargetError(
        `invalid property type: expected a scalar type, or a scalar collection, got ${targetType.getVerbosename(schema)}`,
      );
    }
  }

  checkFieldErrors(node: DDLOperation): void {
    for (const sub of node.commands) {
      if (sub.kind === "CreateConcretePointer") {
        throw new errors.InvalidDefinitionError(
          "cannot place a link property on a property",
        );
      }
      if (sub.kind === "OnSourceDelete" || sub.kind === "OnTargetDelete") {
        throw new errors.InvalidDefinitionError(
          "cannot place a deletion policy on a property",
        );
      }
    }
  }
}

export class CreateProperty extends PropertyCommand {
  static readonly astnode = ["CreateConcreteProperty", "CreateProperty"] as const;
  static readonly referencedAstnode = "CreateConcreteProperty" as const;

  static cmdTreeFromAst(nodeKind: string, cmd: CreateProperty): CreateProperty {
    if (nodeKind === "CreateConcreteProperty") {
      cmd.checkFieldErrors({ kind: nodeKind, commands: [] });
    }
    return cmd;
  }

  getAstAttrForField(field: string, astnode: string): string | undefined {
    if (field === "required" && astnode === "CreateConcreteProperty") {
      return "is_required";
    }
    if (field === "cardinality" && astnode === "CreateConcreteProperty") {
      return "cardinality";
    }
    return undefined;
  }

  applyFieldAst(schema: PropertySchema, context: CommandContext, node: DDLOperation, op: AlterObjectProperty): void {
    const link = context.get(PropertySourceContext);
    if (op.property === "target" && link) {
      if (node.kind === "CreateConcreteProperty") {
        const expr = this.getAttributeValue("expr" as keyof PropertyData) as unknown as Expression | undefined;
        if (expr) {
          node.target = expr.parse();
        } else {
          node.target = op.newValue;
        }
      } else {
        node.commands.push({ kind: "SetPointerType", value: op.newValue });
      }
      return;
    }

    node.commands.push({
      kind: "SetField",
      name: op.property,
      value: op.newValue,
    });
    void schema;
  }
}

export class RenameProperty extends PropertyCommand {}

export class RebaseProperty extends PropertyCommand {}

export class SetPropertyType extends PropertyCommand {}

export class AlterPropertyUpperCardinality extends PropertyCommand {}

export class AlterPropertyLowerCardinality extends PropertyCommand {}

export class AlterPropertyOwned extends PropertyCommand {}

export class AlterProperty extends PropertyCommand {
  static readonly astnode = ["AlterConcreteProperty", "AlterProperty"] as const;
  static readonly referencedAstnode = "AlterConcreteProperty" as const;

  static cmdTreeFromAst(nodeKind: string, cmd: AlterProperty): AlterProperty {
    cmd.checkFieldErrors({ kind: nodeKind, commands: [] });
    return cmd;
  }

  applyFieldAst(node: DDLOperation, op: AlterObjectProperty): void {
    if (op.property === "target") {
      if (op.newValue) {
        node.commands.push({
          kind: "SetPointerType",
          value: op.newValue,
        });
      }
      return;
    }

    node.commands.push({
      kind: "SetField",
      name: op.property,
      value: op.newValue,
    });
  }

  getAst(): DDLOperation | undefined {
    if (this.scls.data.fromAlias) {
      return undefined;
    }
    return {
      kind: "AlterProperty",
      commands: [],
    };
  }
}

export class DeleteProperty extends PropertyCommand {
  static readonly astnode = ["DropConcreteProperty", "DropProperty"] as const;
  static readonly referencedAstnode = "DropConcreteProperty" as const;

  getAst(): DDLOperation | undefined {
    if (this.scls.data.fromAlias) {
      return undefined;
    }
    return {
      kind: "DropProperty",
      commands: [],
    };
  }
}
