import * as errors from "./errors.js";
import { type CompiledExpression, Expression, type EdgeQLExpr } from "./expr.js";

export enum TriggerTiming {
  After = "After",
}

export enum TriggerKind {
  Insert = "Insert",
  Update = "Update",
  Delete = "Delete",
}

export enum TriggerScope {
  Each = "Each",
  Statement = "Statement",
}

export interface TriggerTypeLike {
  getDisplayname(schema: TriggerSchema): string;
  getVerbosename(schema: TriggerSchema): string;
}

export interface TriggerSchema {
  getType(name: string): TriggerTypeLike | undefined;
}

export interface TriggerSourceLike {
  getObject(schema: TriggerSchema): TriggerTypeLike;
  getVerbosename(schema: TriggerSchema): string;
}

export interface TriggerCommandContextState {
  modaliases?: Record<string, string>;
  localnames?: ReadonlySet<string>;
  stdmode?: boolean;
  canonical?: boolean;
}

export interface TriggerReferrerContext {
  op: {
    scls: TriggerTypeLike;
    getObject(schema: TriggerSchema): TriggerTypeLike;
  };
}

export interface TriggerIRLike {
  stype?: {
    getDisplayname(schema: TriggerSchema): string;
    issubclass(schema: TriggerSchema, target: unknown): boolean;
  };
  schema?: TriggerSchema;
  dmlExprs?: Array<{ span?: unknown }>;
}

export interface TriggerData {
  name: string;
  timing: TriggerTiming;
  kinds: ReadonlySet<TriggerKind>;
  scope: TriggerScope;
  expr: Expression;
  condition?: Expression;
  subject: TriggerTypeLike;
  owned?: boolean;
}

export class Trigger {
  constructor(public data: TriggerData) {}

  getKinds(_schema: TriggerSchema): ReadonlySet<TriggerKind> {
    void _schema;
    return this.data.kinds;
  }

  getScope(_schema: TriggerSchema): TriggerScope {
    void _schema;
    return this.data.scope;
  }

  getDisplayname(_schema: TriggerSchema): string {
    void _schema;
    return this.data.name;
  }

  getSubject(_schema: TriggerSchema): TriggerTypeLike {
    void _schema;
    return this.data.subject;
  }
}

export class TriggerCommandContext {
  constructor(public readonly context: TriggerCommandContextState = {}) {}
}

export class TriggerSourceCommandContext<SourceT = unknown> {
  constructor(public readonly source?: SourceT) {}
}

export interface TriggerField {
  name: "expr" | "condition" | string;
}

class BaseTriggerCommand {
  protected localAttributes: Partial<TriggerData> = {};

  constructor(
    public readonly scls: Trigger,
    protected readonly referrerContext: TriggerReferrerContext,
  ) {}

  protected getReferrerContextOrDie(): TriggerReferrerContext {
    return this.referrerContext;
  }

  protected getAttributeValue<K extends keyof TriggerData>(name: K): TriggerData[K] | undefined {
    return (this.localAttributes[name] ?? this.scls.data[name]) as TriggerData[K] | undefined;
  }

  protected getOrigAttributeValue<K extends keyof TriggerData>(name: K): TriggerData[K] | undefined {
    return this.scls.data[name];
  }

  protected getLocalAttributeValue<K extends keyof TriggerData>(name: K): TriggerData[K] | undefined {
    return this.localAttributes[name] as TriggerData[K] | undefined;
  }

  setAttributeValue<K extends keyof TriggerData>(name: K, value: TriggerData[K]): void {
    this.localAttributes[name] = value;
  }

  protected getVerbosename(parent?: string): string {
    if (parent) {
      return `trigger '${this.scls.data.name}' on ${parent}`;
    }
    return `trigger '${this.scls.data.name}'`;
  }
}

export class TriggerCommand extends BaseTriggerCommand {
  canonicalizeAttributes(schema: TriggerSchema, context: TriggerCommandContextState): TriggerSchema {
    const source = this.getReferrerContextOrDie().op.scls;
    const trigName = this.getVerbosename(source.getVerbosename(schema));

    for (const field of ["expr", "condition"] as const) {
      const expr = this.getLocalAttributeValue(field);
      if (!expr) {
        continue;
      }

      const vname = field === "condition" ? "when" : "using";
      const compiled = this.compileExprField(
        schema,
        context,
        { name: field },
        expr,
      );

      if (field === "condition") {
        const target = schema.getType("std::bool");
        const exprType = (compiled.irast as TriggerIRLike).stype;
        if (!target) {
          throw new errors.SchemaDefinitionError("missing std::bool in schema while validating trigger condition");
        }
        if (!exprType?.issubclass(schema, target)) {
          throw new errors.SchemaDefinitionError(
            `${vname} expression for ${trigName} is of invalid type: ${exprType?.getDisplayname(schema)} expected ${target.getDisplayname(schema)}`,
          );
        }

        if ((compiled.irast as TriggerIRLike).dmlExprs?.length) {
          throw new errors.SchemaDefinitionError(
            "data-modifying statements are not allowed in trigger when clauses",
          );
        }
      }
    }

    return schema;
  }

  protected getScope(schema: TriggerSchema): TriggerScope {
    return this.getAttributeValue("scope") ?? this.scls.getScope(schema);
  }

  protected getKinds(schema: TriggerSchema): ReadonlySet<TriggerKind> {
    return this.getAttributeValue("kinds") ?? this.scls.getKinds(schema);
  }

  compileExprField(
    schema: TriggerSchema,
    context: TriggerCommandContextState,
    field: TriggerField,
    value: Expression,
    trackSchemaRefExprs = false,
  ): CompiledExpression {
    if (field.name === "expr" || field.name === "condition") {
      const source = this.getReferrerContextOrDie().op.getObject(schema);
      const scope = this.getScope(schema);
      const kinds = this.getKinds(schema);

      const anchors: Record<string, unknown> = {};
      if (!kinds.has(TriggerKind.Insert)) {
        anchors.__old__ = {
          typename: "__derived__::__old__",
          source,
        };
      }
      if (!kinds.has(TriggerKind.Delete)) {
        anchors.__new__ = {
          typename: "__derived__::__new__",
          source,
        };
      }

      const singletons = scope === TriggerScope.Each
        ? new Set(Object.values(anchors))
        : new Set();

      try {
        return value.compiled({
          schema: {
            ...schema,
            hasObject: () => true,
          },
          options: {
            modaliases: context.modaliases,
            anchors,
            singletons,
            applyQueryRewrites: !context.stdmode,
            trackSchemaRefExprs,
            detached: true,
            triggerType: source,
            triggerKinds: kinds,
          },
          context: {
            top: () => ({ op: { warnings: [] } }),
          },
        });
      } catch (e) {
        if (e instanceof errors.QueryError) {
          throw e;
        }
        throw e;
      }
    }

    return value.compiled({
      schema: {
        ...schema,
        hasObject: () => true,
      },
      options: {},
      context: {
        top: () => ({ op: { warnings: [] } }),
      },
    });
  }

  getDummyExprFieldValue(field: TriggerField): Expression | undefined {
    if (field.name === "expr" || field.name === "condition") {
      return new Expression({ text: "false" });
    }
    throw new Error(`unhandled field '${field.name}'`);
  }

  validateObject(): void {
    // Python implementation currently intentionally no-op.
  }
}

export interface CreateTriggerAst {
  expr?: EdgeQLExpr;
  condition?: EdgeQLExpr;
  timing: TriggerTiming;
  kinds: ReadonlySet<TriggerKind>;
  scope: TriggerScope;
}

export class CreateTrigger extends TriggerCommand {
  static readonly astnode = "CreateTrigger" as const;
  static readonly referencedAstnode = "CreateTrigger" as const;

  getAstAttrForField(field: string, astnode: string): string | undefined {
    if (["timing", "condition", "kinds", "scope", "expr"].includes(field) && astnode === "CreateTrigger") {
      return field;
    }
    return undefined;
  }

  static cmdTreeFromAst(
    schema: TriggerSchema,
    astnode: CreateTriggerAst,
    context: TriggerCommandContextState,
    cmd: CreateTrigger,
  ): CreateTrigger {
    if (astnode.expr) {
      cmd.setAttributeValue("expr", Expression.fromAst(
        astnode.expr,
        {
          ...schema,
          hasObject: () => true,
        },
        context.modaliases ?? {},
        context.localnames ?? new Set(),
      ));
    }

    if (astnode.condition) {
      cmd.setAttributeValue("condition", Expression.fromAst(
        astnode.condition,
        {
          ...schema,
          hasObject: () => true,
        },
        context.modaliases ?? {},
        context.localnames ?? new Set(),
      ));
    }

    cmd.setAttributeValue("timing", astnode.timing);
    cmd.setAttributeValue("kinds", astnode.kinds);
    cmd.setAttributeValue("scope", astnode.scope);

    return cmd;
  }
}

export class RenameTrigger extends TriggerCommand {}

export class RebaseTrigger extends TriggerCommand {}

export class AlterTrigger extends TriggerCommand {
  static readonly astnode = "AlterTrigger" as const;
  static readonly referencedAstnode = "AlterTrigger" as const;

  alterBegin(schema: TriggerSchema, context: TriggerCommandContextState): TriggerSchema {
    void context;
    if (this.getAttributeValue("owned") && !this.getOrigAttributeValue("owned")) {
      throw new errors.SchemaDefinitionError(
        `cannot alter the definition of inherited trigger ${this.scls.getDisplayname(schema)}`,
      );
    }
    return schema;
  }
}

export class DeleteTrigger extends TriggerCommand {
  static readonly astnode = "DropTrigger" as const;
  static readonly referencedAstnode = "DropTrigger" as const;
}
