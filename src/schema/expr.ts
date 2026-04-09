import { parseEdgeQL } from "../edgeql/parser.js";

export type UUID = string;

export interface SchemaLike {
  hasObject(id: UUID): boolean;
  getReferrersEx?(obj: SchemaObjectLike): Iterable<SchemaReferrerEntry>;
}

export interface SchemaObjectLike {
  id: UUID;
  getName(schema: SchemaLike): string;
  asShell?(schema: SchemaLike): ObjectShellLike<SchemaObjectLike>;
}

export interface ObjectShellLike<T extends SchemaObjectLike> {
  resolve(schema: SchemaLike): T;
}

export interface IRSetLike {
  [key: string]: unknown;
}

export interface IRStatementLike {
  schemaRefs: Iterable<SchemaObjectLike>;
  warnings?: unknown[];
  expr: IRSetLike;
  stype?: unknown;
  cardinality?: unknown;
  schema?: SchemaLike;
}

export interface DeltaRootLike {
  warnings: unknown[];
}

export interface CommandContextLike {
  top(): { op?: unknown };
}

export interface CompilerOptionsLike {
  [key: string]: unknown;
}

export interface CompileToIrArgs {
  schema: SchemaLike;
  options?: CompilerOptionsLike;
}

export interface CompilerAdapter {
  normalize(args: {
    qltree: EdgeQLBase;
    schema: SchemaLike;
    modaliases: Readonly<Record<string, string>>;
    localnames: ReadonlySet<string>;
  }): void;
  generateSource(qltree: EdgeQLBase): string;
  compileAstFragmentToIr(qltree: EdgeQLExpr, args: CompileToIrArgs): IRStatementLike;
  compileAstToIr(qltree: EdgeQLExpr, args: CompileToIrArgs): IRStatementLike;
  evaluateIrStatementToValue(ir: IRStatementLike): unknown;
}

const defaultCompilerAdapter: CompilerAdapter = {
  normalize: () => {},
  generateSource: (qltree) => {
    if (typeof qltree === "string") {
      return qltree;
    }
    return JSON.stringify(qltree);
  },
  compileAstFragmentToIr: () => {
    throw new Error("compileAstFragmentToIr adapter is not configured");
  },
  compileAstToIr: () => {
    throw new Error("compileAstToIr adapter is not configured");
  },
  evaluateIrStatementToValue: () => {
    throw new Error("evaluateIrStatementToValue adapter is not configured");
  },
};

let compilerAdapter: CompilerAdapter = defaultCompilerAdapter;

export const setExprCompilerAdapter = (adapter: Partial<CompilerAdapter>): void => {
  compilerAdapter = {
    ...compilerAdapter,
    ...adapter,
  };
};

export interface ParserAdapter {
  parseFragment(text: string, filename?: string): EdgeQLExpr;
}

const defaultParserAdapter: ParserAdapter = {
  parseFragment: (text: string): EdgeQLExpr => {
    const parsed = parseEdgeQL(text);
    return {
      kind: "ParsedEdgeQL",
      statement: parsed,
    };
  },
};

let parserAdapter: ParserAdapter = defaultParserAdapter;

export const setExprParserAdapter = (adapter: Partial<ParserAdapter>): void => {
  parserAdapter = {
    ...parserAdapter,
    ...adapter,
  };
};

export class ObjectCollection<T extends SchemaObjectLike> {
  private readonly values: readonly T[];

  constructor(values: Iterable<T>) {
    this.values = [...values];
  }

  static create<T extends SchemaObjectLike>(_schema: SchemaLike, values: Iterable<T>): ObjectCollection<T> {
    return new ObjectCollection(values);
  }

  objects(_schema: SchemaLike): readonly T[] {
    return this.values;
  }

  schemaReduce(): ObjectCollectionSchemaData {
    return ["ObjectCollection", this.values.map((v) => v.id), []];
  }

  static schemaRestore(data: ObjectCollectionSchemaData): ObjectCollection<SchemaObjectLike> {
    const [, ids] = data;
    const restored = ids.map((id) => ({
      id,
      getName: () => id,
    }));
    return new ObjectCollection(restored);
  }

  static schemaRefsFromData(data: ObjectCollectionSchemaData): ReadonlySet<UUID> {
    return new Set(data[1]);
  }
}

export type ObjectCollectionSchemaData = [
  string,
  UUID[],
  Array<[string, unknown]>,
];

export type ExpressionSchemaData = [
  string,
  ObjectCollectionSchemaData,
  string | null,
];

export type ExpressionSchemaDataWithoutOrigin = [
  string,
  ObjectCollectionSchemaData,
];

const refKey = (obj: SchemaObjectLike, schema: SchemaLike): string =>
  `${obj.constructor.name}:${obj.getName(schema)}`;

export interface ComparisonContext {
  deletions: ReadonlySet<string>;
}

export type EdgeQLBase = {
  kind: string;
  aliases?: EdgeQLAliasDecl[];
  [key: string]: unknown;
};

export type EdgeQLExpr = EdgeQLBase;

export interface EdgeQLAliasDecl extends EdgeQLBase {
  kind: "ModuleAliasDecl";
  alias: string | null;
  module: string;
}

export interface EdgeQLSet extends EdgeQLExpr {
  kind: "Set";
  elements: EdgeQLBase[];
}

export interface EdgeQLArray extends EdgeQLExpr {
  kind: "Array";
  elements: EdgeQLBase[];
}

export interface EdgeQLBaseConstant extends EdgeQLExpr {
  kind: "BaseConstant";
}

export interface EdgeQLSelectQuery extends EdgeQLBase {
  kind: "SelectQuery";
  implicit: boolean;
  result: EdgeQLExpr;
  aliases?: EdgeQLAliasDecl[];
}

export interface ParsedEdgeQLExpr extends EdgeQLExpr {
  kind: "ParsedEdgeQL";
  statement: unknown;
}

export class Expression {
  public readonly text: string;
  public readonly refs: ObjectCollection<SchemaObjectLike> | null;
  public origin: string | null;

  protected _qlast: EdgeQLExpr | null;
  protected _irast: IRStatementLike | null;

  constructor(args: {
    text: string;
    refs?: ObjectCollection<SchemaObjectLike> | null;
    origin?: string | null;
    _qlast?: EdgeQLExpr | null;
    _irast?: IRStatementLike | null;
  }) {
    this.text = args.text;
    this.refs = args.refs ?? null;
    this.origin = args.origin ?? null;
    this._qlast = args._qlast ?? null;
    this._irast = args._irast ?? null;
  }

  getState(): {
    text: string;
    refs: ObjectCollection<SchemaObjectLike> | null;
    _qlast: null;
    _irast: null;
  } {
    return {
      text: this.text,
      refs: this.refs,
      _qlast: null,
      _irast: null,
    };
  }

  setState(state: {
    text: string;
    refs: ObjectCollection<SchemaObjectLike> | null;
    _qlast?: EdgeQLExpr | null;
    _irast?: IRStatementLike | null;
    origin?: string | null;
  }): Expression {
    return new Expression({
      text: state.text,
      refs: state.refs,
      origin: state.origin ?? null,
      _qlast: state._qlast ?? null,
      _irast: state._irast ?? null,
    });
  }

  equals(rhs: unknown): boolean {
    if (!(rhs instanceof Expression)) {
      return false;
    }
    return this.text === rhs.text && this.refs === rhs.refs && this.origin === rhs.origin;
  }

  parse(): EdgeQLExpr {
    if (this._qlast === null) {
      const filename = this.origin ? `<${this.origin}>` : undefined;
      this._qlast = parserAdapter.parseFragment(this.text, filename);
    }
    return this._qlast;
  }

  get irast(): IRStatementLike | null {
    return this._irast;
  }

  setOrigin(id: UUID, field: string): void {
    this.origin = `${id} ${field}`;
  }

  isCompiled(): boolean {
    return this.refs !== null;
  }

  protected refsKeys(schema: SchemaLike): Set<string> {
    return new Set((this.refs?.objects(schema) ?? []).map((ref) => refKey(ref, schema)));
  }

  static compareValues(
    ours: Expression | null | undefined,
    theirs: Expression | null | undefined,
    args: {
      ourSchema: SchemaLike;
      theirSchema: SchemaLike;
      context: ComparisonContext;
      compcoef: number;
    },
  ): number {
    if (!ours && !theirs) {
      return 1;
    }
    if (!ours || !theirs) {
      return args.compcoef;
    }

    const ourRefs = ours.refsKeys(args.ourSchema);
    const theirRefs = theirs.refsKeys(args.theirSchema);
    const shared = [...ourRefs].filter((key) => theirRefs.has(key));
    if (shared.some((key) => args.context.deletions.has(key))) {
      return 0;
    }

    if (ours.text === theirs.text) {
      return 1;
    }
    return args.compcoef;
  }

  static fromAst(
    qltree: EdgeQLExpr,
    schema: SchemaLike,
    modaliases?: Readonly<Record<string, string>>,
    localnames: ReadonlySet<string> = new Set(),
    options?: { asFragment?: boolean },
  ): Expression {
    const aliases = modaliases ?? {};
    if (!options?.asFragment) {
      compilerAdapter.normalize({
        qltree,
        schema,
        modaliases: aliases,
        localnames,
      });
    }

    const normText = compilerAdapter.generateSource(qltree);
    return new Expression({ text: normText, _qlast: qltree });
  }

  notCompiled(): Expression {
    return new Expression({ text: this.text, origin: this.origin });
  }

  compiled(args: {
    schema: SchemaLike;
    options?: CompilerOptionsLike;
    asFragment?: boolean;
    detached?: boolean;
    findExtraRefs?: (expr: IRSetLike) => Set<SchemaObjectLike>;
    context?: CommandContextLike;
  }): CompiledExpression {
    const parsed = this.parse();

    let ir: IRStatementLike;
    if (args.asFragment) {
      ir = compilerAdapter.compileAstFragmentToIr(parsed, {
        schema: args.schema,
        options: args.options,
      });
    } else {
      const qlExpr = args.detached
        ? ({ kind: "DetachedExpr", expr: parsed, preserve_path_prefix: true } as EdgeQLExpr)
        : parsed;
      ir = compilerAdapter.compileAstToIr(qlExpr, {
        schema: args.schema,
        options: args.options,
      });
    }

    if (args.context && ir.warnings?.length) {
      const deltaRoot = args.context.top().op;
      if (isDeltaRoot(deltaRoot)) {
        deltaRoot.warnings.push(...ir.warnings);
      }
    }

    const schemaRefs = [...ir.schemaRefs].filter((ref) => args.schema.hasObject(ref.id));
    const srefs = new Set(schemaRefs);
    if (args.findExtraRefs) {
      for (const ref of args.findExtraRefs(ir.expr)) {
        srefs.add(ref);
      }
    }

    return new CompiledExpression({
      text: this.text,
      refs: ObjectCollection.create(args.schema, srefs),
      _qlast: parsed,
      _irast: ir,
      origin: this.origin,
    });
  }

  ensureCompiled(args: {
    schema: SchemaLike;
    options?: CompilerOptionsLike;
    asFragment?: boolean;
    context?: CommandContextLike;
  }): CompiledExpression {
    if (this._irast) {
      return this as unknown as CompiledExpression;
    }

    return this.compiled({
      schema: args.schema,
      options: args.options,
      asFragment: args.asFragment,
      context: args.context,
    });
  }

  assertCompiled(): CompiledExpression {
    if (this._irast) {
      return this as unknown as CompiledExpression;
    }
    throw new Error(`uncompiled expression '${this.text}' (origin: ${this.origin})`);
  }

  static fromIr(expr: Expression, ir: IRStatementLike, schema: SchemaLike): CompiledExpression {
    return new CompiledExpression({
      text: expr.text,
      refs: ObjectCollection.create(schema, ir.schemaRefs),
      _qlast: expr.parse(),
      _irast: ir,
      origin: expr.origin,
    });
  }

  asShell(schema: SchemaLike): ExpressionShell {
    return new ExpressionShell({
      text: this.text,
      refs: this.refs ? this.refs.objects(schema).map((r) => r.asShell?.(schema)).filter(isDefined) : null,
      _qlast: this._qlast,
      _irast: this._irast,
    });
  }

  schemaReduce(): ExpressionSchemaData {
    if (!this.refs) {
      throw new Error("expected expression to be compiled");
    }
    return [
      this.text,
      this.refs.schemaReduce(),
      this.origin,
    ];
  }

  static schemaRestore(data: ExpressionSchemaData): Expression {
    const [text, refsData, origin] = data;
    return new Expression({
      text,
      refs: ObjectCollection.schemaRestore(refsData),
      origin,
    });
  }

  static schemaRefsFromData(data: ExpressionSchemaDataWithoutOrigin): ReadonlySet<UUID> {
    return ObjectCollection.schemaRefsFromData(data[1]);
  }

  get irStatement(): IRStatementLike {
    if (!this.isCompiled()) {
      throw new Error("expected a compiled expression");
    }
    if (!this.irast) {
      throw new Error("expected the result of an expression to be a Statement");
    }
    return this.irast;
  }

  get stype(): unknown {
    return this.irStatement.stype;
  }

  get cardinality(): unknown {
    return this.irStatement.cardinality;
  }

  get schema(): SchemaLike | undefined {
    return this.irStatement.schema;
  }
}

const isDeltaRoot = (value: unknown): value is DeltaRootLike => {
  return Boolean(
    value
      && typeof value === "object"
      && Array.isArray((value as DeltaRootLike).warnings),
  );
};

export class CompiledExpression extends Expression {
  declare public readonly refs: ObjectCollection<SchemaObjectLike>;
  declare protected _irast: IRStatementLike;

  constructor(args: {
    text: string;
    refs: ObjectCollection<SchemaObjectLike>;
    origin?: string | null;
    _qlast?: EdgeQLExpr | null;
    _irast: IRStatementLike;
  }) {
    super(args);
    this.refs = args.refs;
    this._irast = args._irast;
  }

  override get irast(): IRStatementLike {
    return this._irast;
  }

  asPythonValue(): unknown {
    return compilerAdapter.evaluateIrStatementToValue(this.irast);
  }
}

export class ExpressionShell {
  public readonly text: string;
  public readonly refs: ReadonlyArray<ObjectShellLike<SchemaObjectLike>> | null;
  protected _qlast: EdgeQLExpr | null;
  protected _irast: IRStatementLike | null;

  constructor(args: {
    text: string;
    refs: Iterable<ObjectShellLike<SchemaObjectLike>> | null;
    _qlast?: EdgeQLExpr | null;
    _irast?: IRStatementLike | null;
  }) {
    this.text = args.text;
    this.refs = args.refs ? [...args.refs] : null;
    this._qlast = args._qlast ?? null;
    this._irast = args._irast ?? null;
  }

  resolve(schema: SchemaLike): Expression {
    const refs = this.refs
      ? ObjectCollection.create(schema, this.refs.map((shell) => shell.resolve(schema)))
      : null;

    if (this._irast) {
      return new CompiledExpression({
        text: this.text,
        refs: refs ?? ObjectCollection.create(schema, []),
        _qlast: this._qlast,
        _irast: this._irast,
      });
    }

    return new Expression({
      text: this.text,
      refs,
      _qlast: this._qlast,
      _irast: this._irast,
    });
  }

  parse(): EdgeQLExpr {
    if (this._qlast === null) {
      this._qlast = parserAdapter.parseFragment(this.text);
    }
    return this._qlast;
  }

  toString(): string {
    const refs = this.refs ? this.refs.map((obj) => JSON.stringify(obj)).join(", ") : "N/A";
    return `<ExpressionShell ${this.text} refs=(${refs})>`;
  }
}

export class ExpressionList extends Array<Expression> {
  constructor(values: Iterable<Expression> = []) {
    super(...values);
    Object.setPrototypeOf(this, ExpressionList.prototype);
    Object.freeze(this);
  }

  static mergeValues(
    target: { getExplicitFieldValue(fieldName: string): ExpressionList | null | undefined },
    sources: ReadonlyArray<{ getExplicitFieldValue(fieldName: string): ExpressionList | null | undefined }>,
    fieldName: string,
    options?: { ignoreLocal?: boolean },
  ): ExpressionList | null {
    const result = !options?.ignoreLocal ? target.getExplicitFieldValue(fieldName) : null;
    let merged = result ? [...result] : null;
    for (const source of sources) {
      const theirs = source.getExplicitFieldValue(fieldName);
      if (theirs?.length) {
        if (merged === null) {
          merged = [...theirs];
        } else {
          merged.push(...theirs);
        }
      }
    }

    return merged ? new ExpressionList(merged) : null;
  }

  static compareValues(
    ours: ExpressionList | null | undefined,
    theirs: ExpressionList | null | undefined,
    args: {
      ourSchema: SchemaLike;
      theirSchema: SchemaLike;
      context: ComparisonContext;
      compcoef: number;
    },
  ): number {
    let basecoef: number;

    if (!ours && !theirs) {
      basecoef = 1;
    } else if (!ours || !theirs || ours.length !== theirs.length) {
      basecoef = 0.2;
    } else {
      const similarity: number[] = [];
      for (let i = 0; i < ours.length; i += 1) {
        similarity.push(Expression.compareValues(ours[i], theirs[i], args));
      }
      basecoef = similarity.reduce((a, b) => a + b, 0) / similarity.length;
    }

    return basecoef + (1 - basecoef) * args.compcoef;
  }
}

export class ExpressionDict extends Map<string, Expression> {
  static mergeValues(
    target: { getExplicitFieldValue(fieldName: string): ExpressionDict | null | undefined },
    sources: ReadonlyArray<{ getExplicitFieldValue(fieldName: string): ExpressionDict | null | undefined }>,
    fieldName: string,
    options?: { ignoreLocal?: boolean },
  ): ExpressionDict | null {
    let result: Map<string, Expression> | null = null;

    for (let i = sources.length - 1; i >= 0; i -= 1) {
      const theirs = sources[i].getExplicitFieldValue(fieldName);
      if (theirs?.size) {
        if (result === null) {
          result = new Map(theirs);
        } else {
          for (const [k, v] of theirs.entries()) {
            result.set(k, v);
          }
        }
      }
    }

    if (!options?.ignoreLocal) {
      const ours = target.getExplicitFieldValue(fieldName);
      if (result === null) {
        result = ours ? new Map(ours) : null;
      } else if (ours?.size) {
        for (const [k, v] of ours.entries()) {
          result.set(k, v);
        }
      }
    }

    return result ? new ExpressionDict(result) : null;
  }

  static compareValues(
    ours: ExpressionDict | null | undefined,
    theirs: ExpressionDict | null | undefined,
    args: {
      ourSchema: SchemaLike;
      theirSchema: SchemaLike;
      context: ComparisonContext;
      compcoef: number;
    },
  ): number {
    let basecoef: number;

    if (!ours && !theirs) {
      basecoef = 1;
    } else if (!ours || !theirs || ours.size !== theirs.size) {
      basecoef = 0.2;
    } else {
      const ourKeys = [...ours.keys()].sort();
      const theirKeys = [...theirs.keys()].sort();
      if (ourKeys.join("|") !== theirKeys.join("|")) {
        basecoef = 0.2;
      } else {
        const similarity: number[] = [];
        for (const key of ourKeys) {
          similarity.push(Expression.compareValues(ours.get(key), theirs.get(key), args));
        }
        basecoef = similarity.reduce((a, b) => a + b, 0) / similarity.length;
      }
    }

    return basecoef + (1 - basecoef) * args.compcoef;
  }
}

export const EXPRESSION_TYPES = [
  Expression,
  ExpressionList,
  ExpressionDict,
] as const;

export const imprintExprContext = (
  qltree: EdgeQLBase,
  modaliases: Readonly<Record<string, string>>,
): EdgeQLBase => {
  if (
    qltree.kind === "BaseConstant"
    || (qltree.kind === "Set" && (!isEdgeQLSet(qltree).elements.length))
    || (qltree.kind === "Array" && isEdgeQLArray(qltree).elements.every((el) => el.kind === "BaseConstant"))
  ) {
    return qltree;
  }

  let queryTree: EdgeQLSelectQuery | EdgeQLBase;
  if (isExpressionLike(qltree)) {
    queryTree = {
      kind: "SelectQuery",
      result: qltree,
      implicit: true,
      aliases: [],
    };
  } else {
    queryTree = {
      ...qltree,
      aliases: qltree.aliases ? [...qltree.aliases] : [],
    };
  }

  const existingAliases = new Map<string | null, string>();
  for (const alias of queryTree.aliases ?? []) {
    if (alias.kind === "ModuleAliasDecl") {
      existingAliases.set(alias.alias, alias.module);
    }
  }

  for (const [aliasName, moduleName] of Object.entries(modaliases)) {
    if (!existingAliases.has(aliasName)) {
      queryTree.aliases = queryTree.aliases ?? [];
      queryTree.aliases.push({
        kind: "ModuleAliasDecl",
        alias: aliasName,
        module: moduleName,
      });
    }
  }

  return queryTree;
};

export interface SchemaFieldMeta {
  type: unknown;
}

export interface SchemaObjectClassLike {
  getField(name: string): SchemaFieldMeta;
}

export interface SchemaReferrerEntry {
  mcls: SchemaObjectClassLike;
  fieldName: string;
  referrers: Iterable<SchemaObjectLike>;
}

export const getExprReferrers = (
  schema: SchemaLike,
  obj: SchemaObjectLike,
): Map<SchemaObjectLike, string[]> => {
  const result = new Map<SchemaObjectLike, string[]>();
  const entries = schema.getReferrersEx?.(obj) ?? [];

  for (const entry of entries) {
    const field = entry.mcls.getField(entry.fieldName);
    if (isExpressionFieldType(field.type)) {
      for (const ref of entry.referrers) {
        const fields = result.get(ref) ?? [];
        fields.push(entry.fieldName);
        result.set(ref, fields);
      }
    }
  }

  return result;
};

const isExpressionFieldType = (value: unknown): boolean => {
  if (value === Expression || value === ExpressionList) {
    return true;
  }
  if (typeof value === "function") {
    return value.prototype instanceof Expression || value.prototype instanceof ExpressionList;
  }
  return false;
};

const isEdgeQLSet = (value: EdgeQLBase): EdgeQLSet => value as EdgeQLSet;

const isEdgeQLArray = (value: EdgeQLBase): EdgeQLArray => value as EdgeQLArray;

const isExpressionLike = (value: EdgeQLBase): boolean => {
  if (value.kind.endsWith("Command") || value.kind.endsWith("DDLCommand")) {
    return false;
  }
  if (value.kind === "SelectQuery") {
    return false;
  }
  return true;
};

const isDefined = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;
