import type { LinkDef, LinkPropertyDef } from "../types.js";
import * as errors from "./errors.js";

export enum LinkTargetDeleteAction {
  Restrict = "Restrict",
  DeleteSource = "DeleteSource",
  Allow = "Allow",
  DeferredRestrict = "DeferredRestrict",
}

export enum LinkSourceDeleteAction {
  DeleteTarget = "DeleteTarget",
  Allow = "Allow",
  DeleteTargetIfOrphan = "DeleteTargetIfOrphan",
}

export interface MergeActionObject<T> {
  getExplicitFieldValue(fieldName: string): T | undefined;
  getSourceDisplayName(): string;
  getDisplayName(): string;
}

export interface MergeActionTarget<T> extends MergeActionObject<T> {
  getExplicitLocalFieldValue(fieldName: string): T | undefined;
}

export const mergeActions = <T>(
  target: MergeActionTarget<T>,
  sources: MergeActionObject<T>[],
  fieldName: string,
  options?: {
    ignoreLocal?: boolean;
    renderValue?: (value: T) => string;
  },
): T | undefined => {
  const renderValue = options?.renderValue ?? ((value: T) => String(value));
  const ours = options?.ignoreLocal ? undefined : target.getExplicitLocalFieldValue(fieldName);
  if (ours !== undefined) {
    return ours;
  }

  let current: T | undefined;
  let currentFrom: MergeActionObject<T> | undefined;

  for (const source of sources) {
    const theirs = source.getExplicitFieldValue(fieldName);
    if (theirs === undefined) {
      continue;
    }

    if (current === undefined) {
      current = theirs;
      currentFrom = source;
      continue;
    }

    if (current !== theirs) {
      const tgtRepr = `${target.getSourceDisplayName()}.${target.getDisplayName()}`;
      const currentFromRepr = `${currentFrom?.getSourceDisplayName()}.${currentFrom?.getDisplayName()}`;
      const otherRepr = `${source.getSourceDisplayName()}.${source.getDisplayName()}`;
      throw new errors.SchemaError(
        `cannot implicitly resolve the \`on target delete\` action for '${tgtRepr}': `
          + `it is defined as ${renderValue(current)} in '${currentFromRepr}' and as ${renderValue(theirs)} `
          + `in '${otherRepr}'; to resolve, declare \`on target delete\` explicitly on '${tgtRepr}'`,
      );
    }
  }

  return current;
};

export interface LinkTargetDescriptor {
  displayName: string;
  verboseName?: string;
  isObjectType: boolean;
  isArray?: boolean;
  arrayElementDisplayName?: string;
  isFreeObjectType?: boolean;
  isView?: boolean;
}

export interface LinkPropertyDescriptor {
  special?: boolean;
  pureComputable?: boolean;
}

export interface SchemaLink extends LinkDef {
  sourceType?: string;
  required?: boolean;
  computable?: boolean;
  pureComputable?: boolean;
  fromAlias?: boolean;
  owned?: boolean;
  onTargetDelete?: LinkTargetDeleteAction;
  onSourceDelete?: LinkSourceDeleteAction;
  targetDescriptor?: LinkTargetDescriptor;
  pointers?: LinkPropertyDescriptor[];
}

export interface LinkEndpointPropertyDef extends LinkPropertyDef {
  readonly: true;
  fromAlias?: boolean;
  cardinality: "One";
  source: string;
  targetType: string;
}

export interface LinkEndpointPropertyPlan {
  sourceProperty: LinkEndpointPropertyDef;
  targetProperty: LinkEndpointPropertyDef;
}

export interface SchemaState {
  links: Map<string, SchemaLink>;
  endpointProperties: Map<string, LinkEndpointPropertyPlan>;
}

export interface ComparisonContext {
  [key: string]: unknown;
}

export interface CommandContext {
  declarative?: boolean;
  canonical?: boolean;
  slimLinks?: boolean;
}

export interface AlterObjectProperty {
  property: string;
  newValue: unknown;
}

export interface SetPointerTypeOperation {
  kind: "SetPointerType";
  value: string;
  castExpr?: string;
}

export interface SetFieldOperation {
  kind: "SetField";
  name: string;
  value: unknown;
  specialSyntax?: boolean;
}

export interface OnTargetDeleteOperation {
  kind: "OnTargetDelete";
  cascade: LinkTargetDeleteAction;
}

export interface OnSourceDeleteOperation {
  kind: "OnSourceDelete";
  cascade: LinkSourceDeleteAction;
}

export type DDLOperationCommand =
  | SetPointerTypeOperation
  | SetFieldOperation
  | OnTargetDeleteOperation
  | OnSourceDeleteOperation;

export interface DDLOperation {
  kind: string;
  name: string;
  isRequired?: boolean;
  target?: string;
  commands: DDLOperationCommand[];
}

export const hasUserDefinedProperties = (properties: LinkPropertyDescriptor[]): boolean =>
  properties.some((prop) => !prop.special && !prop.pureComputable);

export const validateLink = (link: SchemaLink): void => {
  const target = link.targetDescriptor;
  if (!target) {
    return;
  }

  if (!target.isObjectType) {
    const hint = target.isArray && target.arrayElementDisplayName
      ? `did you mean 'multi link ${link.name} -> ${target.arrayElementDisplayName}'?`
      : undefined;

    const targetName = target.verboseName ?? target.displayName;
    const message = `invalid link target type, expected object type, got ${targetName}`;
    throw new errors.InvalidLinkTargetError(hint ? `${message} (${hint})` : message);
  }

  if (target.isFreeObjectType) {
    throw new errors.InvalidLinkTargetError(`${target.verboseName ?? target.displayName} is not a valid link target`);
  }

  if (!link.pureComputable && !link.fromAlias && target.isView) {
    throw new errors.InvalidLinkTargetError(
      `invalid link type: '${target.displayName}' is an expression alias, not a proper object type`,
    );
  }

  if (link.required && link.onTargetDelete === LinkTargetDeleteAction.DeferredRestrict) {
    throw new errors.InvalidLinkTargetError("required links may not use `on target delete deferred restrict`");
  }
};

export const createEndpointPropertyPlan = (input: {
  linkName: string;
  linkQualifiedName: string;
  parentTypeName: string;
  targetTypeName: string;
  fromAlias?: boolean;
}): LinkEndpointPropertyPlan => {
  const sourceProperty: LinkEndpointPropertyDef = {
    name: "source",
    type: "str",
    required: true,
    readonly: true,
    fromAlias: input.fromAlias,
    cardinality: "One",
    source: input.linkQualifiedName,
    targetType: input.parentTypeName,
    annotations: [],
  };

  const targetProperty: LinkEndpointPropertyDef = {
    name: "target",
    type: "str",
    required: false,
    readonly: true,
    fromAlias: input.fromAlias,
    cardinality: "One",
    source: input.linkQualifiedName,
    targetType: input.targetTypeName,
    annotations: [],
  };

  return {
    sourceProperty,
    targetProperty,
  };
};

export class Link implements MergeActionTarget<LinkTargetDeleteAction | LinkSourceDeleteAction> {
  public data: SchemaLink;
  private readonly localFields = new Map<string, LinkTargetDeleteAction | LinkSourceDeleteAction>();
  private readonly inheritedFields = new Map<string, LinkTargetDeleteAction | LinkSourceDeleteAction>();

  constructor(data: SchemaLink) {
    this.data = { ...data };
  }

  getTarget(): string {
    return this.data.targetType;
  }

  isLinkProperty(): boolean {
    return false;
  }

  hasUserDefinedProperties(): boolean {
    return hasUserDefinedProperties(this.data.pointers ?? []);
  }

  getSource(): string | undefined {
    return this.data.sourceType;
  }

  getSourceType(): string {
    const source = this.getSource();
    if (!source) {
      throw new Error(`link '${this.data.name}' does not have a source type`);
    }
    return source;
  }

  compare(other: unknown): number {
    if (!(other instanceof Link)) {
      if (typeof other === "object" && other !== null) {
        return 0;
      }
      throw new Error("cannot compare link to non-object value");
    }

    if (this.data.name !== other.data.name) {
      return 0;
    }
    if (this.data.targetType !== other.data.targetType) {
      return 0;
    }
    return 1;
  }

  setTarget(targetType: string): void {
    this.data = {
      ...this.data,
      targetType,
    };
  }

  getExplicitLocalFieldValue(fieldName: string): LinkTargetDeleteAction | LinkSourceDeleteAction | undefined {
    return this.localFields.get(fieldName);
  }

  getExplicitFieldValue(fieldName: string): LinkTargetDeleteAction | LinkSourceDeleteAction | undefined {
    return this.localFields.get(fieldName) ?? this.inheritedFields.get(fieldName);
  }

  getSourceDisplayName(): string {
    return this.data.sourceType ?? "default";
  }

  getDisplayName(): string {
    return this.data.name;
  }

  setField(fieldName: string, value: LinkTargetDeleteAction | LinkSourceDeleteAction, explicitLocal = true): void {
    if (explicitLocal) {
      this.localFields.set(fieldName, value);
    } else {
      this.inheritedFields.set(fieldName, value);
    }
  }

  static getRootClasses(): readonly ["std::link", "schema::__type__"] {
    return ["std::link", "schema::__type__"];
  }

  static getDefaultBaseName(): "std::link" {
    return "std::link";
  }
}

class BaseLinkCommand {
  constructor(
    public readonly classname: string,
    public readonly scls: Link,
  ) {}

  protected getAttributeSpan(_attribute: string): undefined {
    return undefined;
  }

  protected getAttributeValue(attribute: keyof SchemaLink): SchemaLink[keyof SchemaLink] {
    return this.scls.data[attribute];
  }

  protected setAttributeValue(attribute: keyof SchemaLink, value: unknown): void {
    this.scls.data = {
      ...this.scls.data,
      [attribute]: value,
    };
  }

  protected getOrigAttributeValue(attribute: keyof SchemaLink): SchemaLink[keyof SchemaLink] {
    return this.scls.data[attribute];
  }

  protected getReferrerContext(context: CommandContext): { typeName: string } | undefined {
    if (!this.scls.data.sourceType) {
      return undefined;
    }
    if (context.slimLinks) {
      return undefined;
    }
    return { typeName: this.scls.data.sourceType };
  }
}

export class LinkSourceCommandContext<SourceT = unknown> {
  constructor(public readonly source?: SourceT) {}
}

export class LinkSourceCommand<SourceT = unknown> {
  constructor(public readonly source?: SourceT) {}
}

export class LinkCommandContext {
  constructor(public readonly context: CommandContext = {}) {}
}

export class LinkCommand extends BaseLinkCommand {
  appendSubcmdAst(node: DDLOperation, subcmd: { classname?: string; pointerName?: string }): void {
    if (subcmd.classname && subcmd.classname !== this.classname) {
      const pointerName = subcmd.pointerName ?? subcmd.classname.split("::").at(-1) ?? "";
      if (pointerName === "source" || pointerName === "target") {
        return;
      }
    }
    node.commands.push({ kind: "SetField", name: "_subcmd", value: subcmd.classname ?? "unknown" });
  }

  validateObject(_schema: SchemaState, _context: CommandContext): void {
    validateLink(this.scls.data);
  }

  getAst(_schema: SchemaState, context: CommandContext, parentNode?: DDLOperation): DDLOperation | undefined {
    const node = parentNode ?? {
      kind: "CreateLink",
      name: this.classname,
      commands: [],
    };

    if (context.declarative && node.name.endsWith("::__type__")) {
      node.isRequired = true;
    }

    return node;
  }

  protected reinheritClassrefDict(_schema: SchemaState, _context: CommandContext, refdictAttr: string): Record<string, string> {
    if (this.scls.data.computable && refdictAttr !== "pointers") {
      return {};
    }
    return { [refdictAttr]: this.classname };
  }
}

export class CreateLink extends LinkCommand {
  static readonly astnode = ["CreateConcreteLink", "CreateLink"] as const;
  static readonly referencedAstnode = "CreateConcreteLink" as const;

  static cmdTreeFromAst(classname: string, link: Link): CreateLink {
    return new CreateLink(classname, link);
  }

  getAstAttrForField(field: string, astnode: string): string | undefined {
    if (field === "required" && astnode === "CreateConcreteLink") {
      return "isRequired";
    }
    if (field === "cardinality" && astnode === "CreateConcreteLink") {
      return "cardinality";
    }
    return undefined;
  }

  applyFieldAst(
    schema: SchemaState,
    context: CommandContext,
    node: DDLOperation,
    op: AlterObjectProperty,
  ): void {
    const referrer = this.getReferrerContext(context);

    if (op.property === "target" && referrer) {
      if (node.kind === "CreateConcreteLink") {
        node.target = String(op.newValue);
      } else {
        const oldType = this.scls.getTarget();
        const newType = String(op.newValue);
        const castExpr = oldType !== newType ? `(<${newType}>{})` : undefined;
        node.commands.push({
          kind: "SetPointerType",
          value: newType,
          castExpr,
        });
      }
      return;
    }

    if (op.property === "on_target_delete") {
      node.commands.push({ kind: "OnTargetDelete", cascade: op.newValue as LinkTargetDeleteAction });
      return;
    }

    if (op.property === "on_source_delete") {
      node.commands.push({ kind: "OnSourceDelete", cascade: op.newValue as LinkSourceDeleteAction });
      return;
    }

    node.commands.push({ kind: "SetField", name: op.property, value: op.newValue });
    schema.links.set(this.classname, this.scls.data);
  }

  inheritClassrefDict(schema: SchemaState, context: CommandContext, refdictAttr: string): LinkEndpointPropertyPlan | undefined {
    if (this.scls.data.computable && refdictAttr !== "pointers") {
      return undefined;
    }

    if (refdictAttr !== "pointers") {
      return undefined;
    }

    const parent = this.getReferrerContext(context);
    if (!parent || context.slimLinks) {
      return undefined;
    }

    const plan = createEndpointPropertyPlan({
      linkName: this.scls.data.name,
      linkQualifiedName: this.classname,
      parentTypeName: parent.typeName,
      targetTypeName: this.scls.data.targetType,
      fromAlias: this.scls.data.fromAlias,
    });

    schema.endpointProperties.set(this.classname, plan);
    return plan;
  }
}

export class RenameLink extends LinkCommand {}

export class RebaseLink extends LinkCommand {}

export class SetLinkType extends LinkCommand {
  alterBegin(schema: SchemaState, context: CommandContext, newTargetType: string): SchemaState {
    this.scls.setTarget(newTargetType);

    if (!context.canonical) {
      const plan = schema.endpointProperties.get(this.classname);
      if (plan) {
        schema.endpointProperties.set(this.classname, {
          ...plan,
          targetProperty: {
            ...plan.targetProperty,
            targetType: newTargetType,
          },
        });
      }
    }

    schema.links.set(this.classname, this.scls.data);
    return schema;
  }
}

export class AlterLinkUpperCardinality extends LinkCommand {}

export class AlterLinkLowerCardinality extends LinkCommand {}

export class AlterLinkOwned extends LinkCommand {}

export class SetTargetDeletePolicy {
  static readonly astnode = "OnTargetDelete" as const;

  static cmdFromAst(): AlterObjectProperty {
    return {
      property: "on_target_delete",
      newValue: LinkTargetDeleteAction.Restrict,
    };
  }

  static cmdTreeFromAst(cascade: LinkTargetDeleteAction): AlterObjectProperty {
    return {
      property: "on_target_delete",
      newValue: cascade,
    };
  }
}

export class SetSourceDeletePolicy {
  static readonly astnode = "OnSourceDelete" as const;

  static cmdFromAst(): AlterObjectProperty {
    return {
      property: "on_source_delete",
      newValue: LinkSourceDeleteAction.Allow,
    };
  }

  static cmdTreeFromAst(cascade: LinkSourceDeleteAction): AlterObjectProperty {
    return {
      property: "on_source_delete",
      newValue: cascade,
    };
  }
}

export class AlterLink extends LinkCommand {
  static readonly astnode = ["AlterConcreteLink", "AlterLink"] as const;
  static readonly referencedAstnode = "AlterConcreteLink" as const;

  static cmdTreeFromAst(classname: string, link: Link): AlterLink {
    return new AlterLink(classname, link);
  }

  applyFieldAst(node: DDLOperation, op: AlterObjectProperty): void {
    if (op.property === "target") {
      if (op.newValue) {
        node.commands.push({ kind: "SetPointerType", value: String(op.newValue) });
      }
      return;
    }

    if (op.property === "computable") {
      if (!op.newValue) {
        node.commands.push({
          kind: "SetField",
          name: "expr",
          value: null,
          specialSyntax: true,
        });
      }
      return;
    }

    if (op.property === "on_target_delete") {
      node.commands.push({ kind: "OnTargetDelete", cascade: op.newValue as LinkTargetDeleteAction });
      return;
    }

    if (op.property === "on_source_delete") {
      node.commands.push({ kind: "OnSourceDelete", cascade: op.newValue as LinkSourceDeleteAction });
      return;
    }

    node.commands.push({ kind: "SetField", name: op.property, value: op.newValue });
  }
}

export class DeleteLink extends LinkCommand {
  static readonly astnode = ["DropConcreteLink", "DropLink"] as const;
  static readonly referencedAstnode = "DropConcreteLink" as const;

  getAst(_schema: SchemaState, _context: CommandContext, parentNode?: DDLOperation): DDLOperation | undefined {
    if (this.getOrigAttributeValue("fromAlias")) {
      return undefined;
    }

    return parentNode ?? {
      kind: "DropLink",
      name: this.classname,
      commands: [],
    };
  }
}

export const applyPolicyCommand = (
  link: SchemaLink,
  command:
    | {
        kind: "set_target_delete_policy";
        value: LinkTargetDeleteAction;
      }
    | {
        kind: "set_source_delete_policy";
        value: LinkSourceDeleteAction;
      },
): SchemaLink => {
  if (command.kind === "set_target_delete_policy") {
    return {
      ...link,
      onTargetDelete: command.value,
    };
  }

  return {
    ...link,
    onSourceDelete: command.value,
  };
};
