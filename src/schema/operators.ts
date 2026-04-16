import * as errors from "./errors.js";

export enum OperatorKind {
  Infix = "Infix",
  Postfix = "Postfix",
  Prefix = "Prefix",
  Ternary = "Ternary",
}

export enum ReturnTypeModifier {
  Singleton = "Singleton",
  Optional = "Optional",
  SetOf = "SetOf",
}

export interface TypeLike {
  name: string;
  getDisplayname(schema: OperatorSchema): string;
  isArray?(): boolean;
  isTuple?(schema: OperatorSchema): boolean;
  isRange?(): boolean;
  isMultirange?(): boolean;
}

export interface OperatorParameter {
  name: string;
  type: TypeLike;
  asStr(schema: OperatorSchema): string;
}

export interface OperatorCode {
  language?: string;
  fromOperator?: string[];
  fromFunction?: string[];
  fromExpr?: boolean;
  code?: string;
}

export interface OperatorAst {
  kind: OperatorKind;
  code?: OperatorCode;
  span?: unknown;
}

export interface OperatorSchema {
  getOperator(fullname: string): Operator | undefined;
  setOperator(op: Operator): void;
  getOperatorsByShortname(name: string, moduleAliases?: Record<string, string>): Operator[];
}

export interface OperatorData {
  fullname: string;
  shortname: string;
  params: OperatorParameter[];
  returnType: TypeLike;
  returnTypemod: ReturnTypeModifier;
  abstract?: boolean;
  operatorKind: OperatorKind;
  language?: string;
  fromOperator?: string[];
  fromFunction?: string[];
  fromExpr?: boolean;
  forceReturnCast?: boolean;
  code?: string;
  derivativeOf?: string;
  commutator?: string;
  negator?: string;
  recursive?: boolean;
  implIsStrict?: boolean;
}

export class Operator {
  constructor(public data: OperatorData) {}

  getShortname(_schema: OperatorSchema): { name: string } {
    return { name: this.data.shortname };
  }

  getParams(_schema: OperatorSchema): OperatorParameter[] {
    return [...this.data.params];
  }

  getOperatorKind(_schema: OperatorSchema): OperatorKind {
    return this.data.operatorKind;
  }

  getReturnTypemod(_schema: OperatorSchema): ReturnTypeModifier {
    return this.data.returnTypemod;
  }

  getReturnType(_schema: OperatorSchema): TypeLike {
    return this.data.returnType;
  }

  getDerivativeOf(_schema: OperatorSchema): string | undefined {
    return this.data.derivativeOf;
  }

  getRecursive(_schema: OperatorSchema): boolean {
    return Boolean(this.data.recursive);
  }

  getDisplaySignature(schema: OperatorSchema): string {
    const params = this.getParams(schema).map((p) => p.type.getDisplayname(schema));
    const name = this.getShortname(schema).name;
    const kind = this.getOperatorKind(schema);

    if (kind === OperatorKind.Infix) {
      return `${params[0]} ${name} ${params[1]}`;
    }
    if (kind === OperatorKind.Postfix) {
      return `${params[0]} ${name}`;
    }
    if (kind === OperatorKind.Prefix) {
      return `${name} ${params[0]}`;
    }
    if (kind === OperatorKind.Ternary) {
      return `${name} (${params.join(", ")})`;
    }

    throw new Error("unexpected operator kind");
  }

  getVerbosename(schema: OperatorSchema): string {
    return `operator "${this.getDisplaySignature(schema)}"`;
  }
}

export interface OperatorCommandContext {
  stdmode?: boolean;
  testmode?: boolean;
  modaliases?: Record<string, string>;
}

export interface AlterObjectProperty {
  property: string;
  newValue: unknown;
}

export interface CreateOperatorNode {
  kind: "CreateOperator";
  returning?: string;
  returningTypemod?: ReturnTypeModifier;
  code?: OperatorCode;
}

export class OperatorCommand {
  constructor(public readonly schemaClass: typeof Operator = Operator) {}

  getAstAttrForField(field: string): string | undefined {
    if (field === "abstract") {
      return field;
    }
    if (field === "operator_kind") {
      return "kind";
    }
    return undefined;
  }

  cmdTreeFromAst(schema: OperatorSchema, astnode: OperatorAst, context: OperatorCommandContext): CreateOperator {
    if (!context.stdmode && !context.testmode) {
      throw new errors.UnsupportedFeatureError("user-defined operators are not supported");
    }

    return CreateOperator.cmdTreeFromAst(schema, astnode, context);
  }

  classnameFromAst(shortname: string, params: OperatorParameter[], kind: OperatorKind): string {
    const sig = params.map((p) => p.name).join(",");
    return `default::${shortname}[${kind}](${sig})`;
  }
}

export class CreateOperator extends OperatorCommand {
  static cmdTreeFromAst(schema: OperatorSchema, astnode: OperatorAst, _context: OperatorCommandContext): CreateOperator {
    const cmd = new CreateOperator();
    void schema;
    void astnode;
    return cmd;
  }

  createBegin(schema: OperatorSchema, op: Operator): void {
    const fullname = op.data.fullname;
    const shortname = op.data.shortname;
    const signature = `${shortname}(${op.data.params.map((p) => p.asStr(schema)).join(", ")})`;

    const existing = schema.getOperator(fullname);
    if (existing) {
      throw new errors.InvalidOperatorDefinitionError(
        `cannot create the \`${signature}\` operator: an operator with the same signature is already defined`,
      );
    }

    const params = op.getParams(schema);
    const returnTypemod = op.getReturnTypemod(schema);
    const recursive = op.getRecursive(schema);
    const derivativeOf = op.getDerivativeOf(schema);

    if (params.length === 0) {
      throw new errors.InvalidOperatorDefinitionError(
        `cannot create the \`${signature}\` operator: an operator must have operands`,
      );
    }

    let allArrays = true;
    let allTuples = true;
    let allRanges = true;
    for (const param of params) {
      const t = param.type;
      allArrays = allArrays && Boolean(t.isArray?.());
      allTuples = allTuples && Boolean(t.isTuple?.(schema));
      allRanges = allRanges && (Boolean(t.isRange?.()) || Boolean(t.isMultirange?.()));
    }

    if (recursive && ![allArrays, allTuples, allRanges].some(Boolean)) {
      throw new errors.InvalidOperatorDefinitionError(
        `cannot create the \`${signature}\` operator: operands of a recursive operator must either be all arrays or all tuples`,
      );
    }

    for (const existingOp of lookupOperators(shortname, schema)) {
      if (existingOp.data.fullname === op.data.fullname) {
        continue;
      }

      if (existingOp.getReturnTypemod(schema) !== returnTypemod) {
        throw new errors.DuplicateOperatorDefinitionError(
          `cannot create the \`${signature}\` operator: overloading another operator with different return type`,
        );
      }

      const existingDerivative = existingOp.getDerivativeOf(schema);
      if (existingDerivative) {
        throw new errors.DuplicateOperatorDefinitionError(
          `cannot create the \`${signature}\` operator: there exists a derivative operator of the same name`,
        );
      }
      if (derivativeOf) {
        throw new errors.DuplicateOperatorDefinitionError(
          `cannot create \`${signature}\` as a derivative operator: there already exists an operator of the same name`,
        );
      }

      const existingRecursive = existingOp.getRecursive(schema);
      if (existingRecursive !== recursive) {
        let exArrays = true;
        let exTuples = true;
        let exRanges = true;
        for (const param of existingOp.getParams(schema)) {
          const t = param.type;
          exArrays = exArrays && Boolean(t.isArray?.());
          exTuples = exTuples && Boolean(t.isTuple?.(schema));
          exRanges = exRanges && (Boolean(t.isRange?.()) || Boolean(t.isMultirange?.()));
        }

        if (allArrays === exArrays && allTuples === exTuples && allRanges === exRanges) {
          const newRec = recursive ? "recursive" : "non-recursive";
          const oldRec = existingRecursive ? "recursive" : "non-recursive";
          throw new errors.InvalidOperatorDefinitionError(
            `cannot create the ${newRec} \`${signature}\` operator: overloading a ${oldRec} operator is not allowed`,
          );
        }
      }
    }
  }

  applyFieldAst(node: CreateOperatorNode, op: AlterObjectProperty): void {
    const newValue = op.newValue;
    if (op.property === "return_type") {
      node.returning = String(newValue);
      return;
    }
    if (op.property === "return_typemod") {
      node.returningTypemod = newValue as ReturnTypeModifier;
      return;
    }
    if (op.property === "code") {
      node.code = node.code ?? {};
      node.code.code = String(newValue);
      return;
    }
    if (op.property === "language") {
      node.code = node.code ?? {};
      node.code.language = String(newValue);
      return;
    }
    if (op.property === "from_function" && newValue) {
      node.code = node.code ?? {};
      node.code.fromFunction = [...(newValue as string[])];
      return;
    }
    if (op.property === "from_expr" && newValue) {
      node.code = node.code ?? {};
      node.code.fromExpr = Boolean(newValue);
      return;
    }
    if (op.property === "from_operator" && newValue) {
      node.code = node.code ?? {};
      node.code.fromOperator = [...(newValue as string[])];
    }
  }
}

export class RenameOperator extends OperatorCommand {}

export class AlterOperator extends OperatorCommand {}

export class DeleteOperator extends OperatorCommand {}

export const lookupOperators = (
  name: string,
  schema: OperatorSchema,
  options?: {
    default?: readonly Operator[];
    moduleAliases?: Record<string, string>;
  },
): Operator[] => {
  const funcs = schema.getOperatorsByShortname(name, options?.moduleAliases);
  if (funcs.length > 0) {
    return funcs;
  }
  if (options?.default) {
    return [...options.default];
  }
  throw new errors.InvalidReferenceError(`reference to unknown operator: ${name}`);
};

export const lookup_operators = lookupOperators;
