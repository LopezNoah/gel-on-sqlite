import { AppError } from "../errors.js";
import type {
  AbstractAnnotationDef,
  AccessPolicyCondition,
  AccessPolicyDef,
  AnnotationDef,
  AccessPolicyOperation,
  ComputedDef,
  ComputedValuePart,
  FunctionParamDef,
  FunctionVolatility,
  MutationRewriteExpr,
  ScalarType,
  ScalarValue,
  TriggerDef,
  TriggerInsertAction,
  TriggerValueExpr,
} from "../types.js";

export interface SchemaModule {
  name: string;
}

export interface PropertyMember {
  kind: "property";
  name: string;
  scalar: ScalarType;
  required: boolean;
  multi: boolean;
  overloaded: boolean;
  annotations: AnnotationDef[];
  enumValues?: string[];
  enumTypeName?: string;
  rewrite?: {
    onInsert?: MutationRewriteExpr;
    onUpdate?: MutationRewriteExpr;
  };
}

export interface LinkProperty {
  name: string;
  scalar: ScalarType;
  required: boolean;
  annotations: AnnotationDef[];
}

export interface LinkMember {
  kind: "link";
  name: string;
  target: string;
  required: boolean;
  multi: boolean;
  overloaded: boolean;
  annotations: AnnotationDef[];
  properties: LinkProperty[];
}

export interface ComputedMember {
  kind: "computed";
  name: string;
  required: boolean;
  multi: boolean;
  overloaded: boolean;
  annotations: AnnotationDef[];
  expr: ComputedDef["expr"];
  computedKind: ComputedDef["kind"];
}

export type TypeMember = PropertyMember | LinkMember | ComputedMember;

export interface ObjectTypeDeclaration {
  kind: "object";
  module: string;
  name: string;
  abstract: boolean;
  extends: string[];
  annotations: AnnotationDef[];
  members: TypeMember[];
  triggers: TriggerDef[];
  accessPolicies: AccessPolicyDef[];
}

export interface AbstractAnnotationDeclaration extends AbstractAnnotationDef {
  module: string;
  name: string;
  inheritable: boolean;
  annotations: AnnotationDef[];
}

export interface PermissionDeclaration {
  module: string;
  name: string;
}

export interface FunctionDeclaration {
  module: string;
  name: string;
  params: FunctionParamDef[];
  returnType: string;
  returnOptional: boolean;
  returnSetOf: boolean;
  volatility?: FunctionVolatility;
  annotations: AnnotationDef[];
  body: {
    language: "edgeql";
    text: string;
  };
}

export interface ScalarTypeDeclaration {
  name: string;
  module: string;
  enumValues: string[];
}

export interface DeclarativeSchema {
  modules: SchemaModule[];
  types: ObjectTypeDeclaration[];
  functions?: FunctionDeclaration[];
  abstractAnnotations?: AbstractAnnotationDeclaration[];
  permissions?: PermissionDeclaration[];
  scalarTypes?: ScalarTypeDeclaration[];
}

type TokenKind =
  | "word"
  | "string"
  | "number"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "colon"
  | "semi"
  | "comma"
  | "dot"
  | "equals"
  | "bang_eq"
  | "qeq"
  | "assign"
  | "arrow"
  | "concat"
  | "lt"
  | "gt"
  | "minus"
  | "star"
  | "pipe"
  | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  index: number;
}

const BUILTIN_SCALARS = new Set<string>([
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
  "int16",
  "int32",
  "int64",
  "float32",
  "float64",
  "bigint",
  "decimal",
  "bytes",
]);
const STANDARD_ANNOTATIONS = new Set(["title", "description", "deprecated"]);

class Parser {
  private readonly tokens: Token[];
  private readonly source: string;
  private readonly scalarAliases = new Map<string, ScalarType>();
  private readonly enumValues = new Map<string, string[]>();
  private index = 0;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  parse(): DeclarativeSchema {
    const modules: SchemaModule[] = [];
    const types: ObjectTypeDeclaration[] = [];
    const permissions: PermissionDeclaration[] = [];
    const functions: FunctionDeclaration[] = [];
    const abstractAnnotations: AbstractAnnotationDeclaration[] = [];
    const scalarTypes: ScalarTypeDeclaration[] = [];

    while (!this.match("eof")) {
      this.expectWord("module", "Expected 'module' declaration");
      const moduleName = this.expect("word", "Expected module name").text;
      modules.push({ name: moduleName });
      this.expect("lbrace", "Expected '{' after module name");

      while (!this.match("rbrace")) {
        if (this.matchWord("permission")) {
          const permissionName = this.expect("word", "Expected permission name").text;
          this.expect("semi", "Expected ';' after permission declaration");
          permissions.push({ module: moduleName, name: permissionName });
          continue;
        }

        if (this.peekWordAt(0) === "function") {
          this.consume();
          const declaration = this.parseFunctionDeclaration(moduleName);
          if (this.findFunctionIndex(functions, declaration.module, declaration.name, declaration.params) >= 0) {
            const token = this.peek();
            throw new AppError("E_SYNTAX", `Function '${declaration.name}' is already defined for this signature`, 1, token.index + 1);
          }
          functions.push(declaration);
          continue;
        }

        if (this.peekWordAt(0) === "create" && this.peekWordAt(1) === "function") {
          this.consume();
          this.consume();
          const declaration = this.parseFunctionDeclaration(moduleName);
          if (this.findFunctionIndex(functions, declaration.module, declaration.name, declaration.params) >= 0) {
            const token = this.peek();
            throw new AppError("E_SYNTAX", `Function '${declaration.name}' is already defined for this signature`, 1, token.index + 1);
          }
          functions.push(declaration);
          continue;
        }

        if (this.peekWordAt(0) === "alter" && this.peekWordAt(1) === "function") {
          this.consume();
          this.consume();
          this.parseAlterFunction(moduleName, functions);
          continue;
        }

        if (this.peekWordAt(0) === "drop" && this.peekWordAt(1) === "function") {
          this.consume();
          this.consume();
          this.parseDropFunction(moduleName, functions);
          continue;
        }

        if (this.isAbstractAnnotationDeclarationStart()) {
          abstractAnnotations.push(this.parseAbstractAnnotation(moduleName));
          continue;
        }

        if (this.peekWordAt(0) === "scalar" && this.peekWordAt(1) === "type") {
          this.parseScalarType(moduleName, scalarTypes);
          continue;
        }

        if (this.isTypeDeclarationStart()) {
          types.push(this.parseType(moduleName));
          continue;
        }

        this.skipDeclaration();
      }
    }

    return {
      modules,
      types,
      functions: functions.length ? functions : undefined,
      permissions,
      abstractAnnotations: abstractAnnotations.length ? abstractAnnotations : undefined,
      scalarTypes: scalarTypes.length ? scalarTypes : undefined,
    };
  }

  private parseFunctionDeclaration(moduleName: string): FunctionDeclaration {
    const name = this.expect("word", "Expected function name").text;
    const params = this.parseFunctionParameters();
    const returns = this.parseFunctionReturnSpec();
    const annotations: AnnotationDef[] = [];
    let volatility: FunctionVolatility | undefined;
    let body: FunctionDeclaration["body"] | undefined;

    if (this.matchWord("using")) {
      body = this.parseFunctionUsingClause();
      this.expect("semi", "Expected ';' after function declaration");
    } else if (this.match("lbrace")) {
      while (!this.match("rbrace")) {
        if (this.isAnnotationMutationStart()) {
          this.parseAnnotationMutation(moduleName, annotations);
          continue;
        }

        if (this.matchWord("volatility")) {
          this.expect("assign", "Expected ':=' after volatility");
          volatility = this.parseFunctionVolatility();
          this.expect("semi", "Expected ';' after volatility clause");
          continue;
        }

        if (this.matchWord("set")) {
          this.expectWord("volatility", "Expected 'volatility' after 'set'");
          this.expect("assign", "Expected ':=' after set volatility");
          volatility = this.parseFunctionVolatility();
          this.expect("semi", "Expected ';' after set volatility clause");
          continue;
        }

        if (this.matchWord("using")) {
          body = this.parseFunctionUsingClause();
          this.expect("semi", "Expected ';' after using clause");
          continue;
        }

        const token = this.peek();
        throw new AppError("E_SYNTAX", "Unsupported function subcommand", 1, token.index + 1);
      }

      this.expect("semi", "Expected ';' after function block");
    } else {
      const token = this.peek();
      throw new AppError("E_SYNTAX", "Expected function body using clause or block", 1, token.index + 1);
    }

    if (!body) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", "Function declaration is missing a using clause", 1, token.index + 1);
    }

    if (params.some((param) => param.setOf)) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", "User defined functions cannot declare set of parameters", 1, token.index + 1);
    }

    return {
      module: moduleName,
      name,
      params,
      returnType: returns.type,
      returnOptional: returns.optional,
      returnSetOf: returns.setOf,
      volatility,
      annotations,
      body,
    };
  }

  private parseAlterFunction(moduleName: string, functions: FunctionDeclaration[]): void {
    const name = this.expect("word", "Expected function name in alter statement").text;
    const params = this.parseFunctionParameters();
    const fnIndex = this.findFunctionIndex(functions, moduleName, name, params);
    if (fnIndex < 0) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", `Unknown function '${name}' for alter`, 1, token.index + 1);
    }

    const next = { ...functions[fnIndex], annotations: [...functions[fnIndex].annotations] };
    this.expect("lbrace", "Expected '{' in alter function block");
    while (!this.match("rbrace")) {
      if (this.matchWord("set")) {
        this.expectWord("volatility", "Expected 'volatility' after 'set'");
        this.expect("assign", "Expected ':=' after set volatility");
        next.volatility = this.parseFunctionVolatility();
        this.expect("semi", "Expected ';' after set volatility clause");
        continue;
      }

      if (this.matchWord("reset")) {
        this.expectWord("volatility", "Expected 'volatility' after 'reset'");
        next.volatility = undefined;
        this.expect("semi", "Expected ';' after reset volatility clause");
        continue;
      }

      if (this.matchWord("rename")) {
        this.expectWord("to", "Expected 'to' in rename clause");
        next.name = this.expect("word", "Expected new function name").text;
        this.expect("semi", "Expected ';' after rename clause");
        continue;
      }

      if (this.matchWord("using")) {
        next.body = this.parseFunctionUsingClause();
        this.expect("semi", "Expected ';' after using clause");
        continue;
      }

      if (this.matchWord("create") || this.matchWord("alter")) {
        this.expectWord("annotation", "Expected 'annotation' clause");
        const annotationName = this.normalizeAnnotationName(moduleName, this.expect("word", "Expected annotation name").text);
        this.expect("assign", "Expected ':=' in annotation clause");
        const value = this.readStringLiteral("Expected annotation string value");
        this.expect("semi", "Expected ';' after annotation clause");
        const existing = next.annotations.findIndex((annotation) => annotation.name === annotationName);
        if (existing >= 0) {
          next.annotations[existing] = { name: annotationName, value };
        } else {
          next.annotations.push({ name: annotationName, value });
        }
        continue;
      }

      if (this.matchWord("drop")) {
        this.expectWord("annotation", "Expected 'annotation' after 'drop'");
        const annotationName = this.normalizeAnnotationName(moduleName, this.expect("word", "Expected annotation name").text);
        this.expect("semi", "Expected ';' after drop annotation clause");
        const existing = next.annotations.findIndex((annotation) => annotation.name === annotationName);
        if (existing >= 0) {
          next.annotations.splice(existing, 1);
        }
        continue;
      }

      const token = this.peek();
      throw new AppError("E_SYNTAX", "Unsupported alter function subcommand", 1, token.index + 1);
    }

    this.expect("semi", "Expected ';' after alter function block");
    functions[fnIndex] = next;
  }

  private parseDropFunction(moduleName: string, functions: FunctionDeclaration[]): void {
    const name = this.expect("word", "Expected function name in drop statement").text;
    const params = this.parseFunctionParameters();
    this.expect("semi", "Expected ';' after drop function statement");
    const fnIndex = this.findFunctionIndex(functions, moduleName, name, params);
    if (fnIndex < 0) {
      return;
    }
    functions.splice(fnIndex, 1);
  }

  private parseFunctionParameters(): FunctionParamDef[] {
    this.expect("lparen", "Expected '(' before function parameter list");
    const params: FunctionParamDef[] = [];
    let sawVariadicOrNamedOnly = false;
    while (!this.match("rparen")) {
      let namedOnly = false;
      let variadic = false;
      if (this.matchWord("named")) {
        this.expectWord("only", "Expected 'only' after 'named'");
        namedOnly = true;
        sawVariadicOrNamedOnly = true;
      } else if (this.matchWord("variadic")) {
        variadic = true;
        sawVariadicOrNamedOnly = true;
      } else if (sawVariadicOrNamedOnly) {
        const token = this.peek();
        throw new AppError("E_SYNTAX", "Positional arguments cannot follow variadic or named only arguments", 1, token.index + 1);
      }

      const name = this.expect("word", "Expected function parameter name").text;
      this.expect("colon", "Expected ':' in function parameter");
      let optional = false;
      let setOf = false;
      if (this.matchWord("optional")) {
        optional = true;
      } else if (this.matchWord("set")) {
        this.expectWord("of", "Expected 'of' after 'set'");
        setOf = true;
      }

      const type = this.parseFunctionTypeRef();
      let defaultValue: ScalarValue | undefined;
      if (this.match("equals")) {
        if (variadic) {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Variadic parameters cannot have a default value", 1, token.index + 1);
        }
        defaultValue = this.readScalarValue("Expected default value in function parameter");
      }

      params.push({ name, type, optional, setOf, variadic, namedOnly, default: defaultValue });
      if (!this.match("comma")) {
        this.expect("rparen", "Expected ')' after function parameters");
        break;
      }
    }

    return params;
  }

  private parseFunctionTypeRef(): string {
    if (this.matchWord("array")) {
      this.expect("lt", "Expected '<' after array");
      const inner = this.expect("word", "Expected array inner type").text;
      this.expect("gt", "Expected '>' after array type");
      return `array<${inner}>`;
    }

    return this.expect("word", "Expected function type").text;
  }

  private parseFunctionReturnSpec(): { type: string; optional: boolean; setOf: boolean } {
    this.expect("arrow", "Expected '->' in function declaration");
    let optional = false;
    let setOf = false;
    if (this.matchWord("optional")) {
      optional = true;
    } else if (this.matchWord("set")) {
      this.expectWord("of", "Expected 'of' after 'set'");
      setOf = true;
    }

    return {
      type: this.parseFunctionTypeRef(),
      optional,
      setOf,
    };
  }

  private parseFunctionUsingClause(): FunctionDeclaration["body"] {
    if (this.peekIs("lparen")) {
      return {
        language: "edgeql",
        text: this.readParenthesizedRaw(),
      };
    }

    const language = this.expect("word", "Expected function language after using").text;
    if (language !== "edgeql") {
      const token = this.peek();
      throw new AppError("E_SYNTAX", `Unsupported function language '${language}'`, 1, token.index + 1);
    }
    return {
      language: "edgeql",
      text: this.readStringLiteral("Expected function body string"),
    };
  }

  private readParenthesizedRaw(): string {
    const lparen = this.expect("lparen", "Expected '(' in function body");
    let depth = 1;
    let end = lparen.index + 1;

    while (depth > 0) {
      const token = this.consume();
      if (token.kind === "lparen") {
        depth += 1;
      } else if (token.kind === "rparen") {
        depth -= 1;
        if (depth === 0) {
          end = token.index;
          break;
        }
      }

      if (token.kind === "eof") {
        throw new AppError("E_SYNTAX", "Unterminated function using clause", 1, token.index + 1);
      }
    }

    return this.source.slice(lparen.index + 1, end).trim();
  }

  private parseFunctionVolatility(): FunctionVolatility {
    const token = this.peek();
    const value = token.kind === "string" ? this.consume().text : this.expect("word", "Expected function volatility").text;
    if (value === "Immutable" || value === "Stable" || value === "Volatile" || value === "Modifying") {
      return value;
    }

    throw new AppError("E_SYNTAX", `Unsupported function volatility '${value}'`, 1, token.index + 1);
  }

  private functionSignature(moduleName: string, name: string, params: FunctionParamDef[]): string {
    const signature = params.map((param) => `${param.variadic ? "variadic " : ""}${param.namedOnly ? "named only " : ""}${param.optional ? "optional " : ""}${param.setOf ? "set of " : ""}${param.type}`).join(",");
    return `${moduleName}::${name}(${signature})`;
  }

  private findFunctionIndex(
    functions: FunctionDeclaration[],
    moduleName: string,
    name: string,
    params: FunctionParamDef[],
  ): number {
    const signature = this.functionSignature(moduleName, name, params);
    return functions.findIndex((fn) => this.functionSignature(fn.module, fn.name, fn.params) === signature);
  }

  private parseType(moduleName: string): ObjectTypeDeclaration {
    const isAbstract = this.matchWord("abstract");
    this.expectWord("type", "Expected 'type' declaration");
    const typeName = this.expect("word", "Expected type name").text;

    const extendsTypes: string[] = [];
    if (this.matchWord("extending")) {
      extendsTypes.push(this.normalizeTypeName(moduleName, this.expect("word", "Expected base type name").text));
      while (this.match("comma")) {
        extendsTypes.push(this.normalizeTypeName(moduleName, this.expect("word", "Expected base type name").text));
      }
    }

    const annotations: AnnotationDef[] = [];
    const members: TypeMember[] = [];
    const triggers: TriggerDef[] = [];
    const accessPolicies: AccessPolicyDef[] = [];

    if (this.match("semi")) {
      return {
        kind: "object",
        module: moduleName,
        name: typeName,
        abstract: isAbstract,
        extends: extendsTypes,
        annotations,
        members,
        triggers,
        accessPolicies,
      };
    }

    this.expect("lbrace", "Expected '{' after type declaration");
    while (!this.match("rbrace")) {
      if (this.isAnnotationMutationStart()) {
        this.parseAnnotationMutation(moduleName, annotations);
        continue;
      }

      if (this.matchWord("trigger")) {
        triggers.push(this.parseTrigger(moduleName));
        continue;
      }

      if (this.matchWord("access")) {
        this.expectWord("policy", "Expected 'policy' after 'access'");
        accessPolicies.push(this.parseAccessPolicy(moduleName));
        continue;
      }

      if (this.peekWordAt(0) === "index") {
        this.skipDeclaration();
        continue;
      }

      members.push(this.parseMember(moduleName));
    }

    this.match("semi");

    return {
      kind: "object",
      module: moduleName,
      name: typeName,
      abstract: isAbstract,
      extends: extendsTypes,
      annotations,
      members,
      triggers,
      accessPolicies,
    };
  }

  private parseAbstractAnnotation(moduleName: string): AbstractAnnotationDeclaration {
    this.expectWord("abstract", "Expected 'abstract' in annotation declaration");
    const inheritable = this.matchWord("inheritable");
    this.expectWord("annotation", "Expected 'annotation' in abstract annotation declaration");
    const name = this.normalizeAnnotationName(moduleName, this.expect("word", "Expected annotation name").text);

    const annotations: AnnotationDef[] = [];
    if (this.match("lbrace")) {
      while (!this.match("rbrace")) {
        this.parseAnnotationMutation(moduleName, annotations);
      }
    }

    this.expect("semi", "Expected ';' after abstract annotation declaration");
    return {
      module: moduleName,
      name,
      inheritable,
      annotations,
    };
  }

  private isAbstractAnnotationDeclarationStart(): boolean {
    if (this.peekWordAt(0) !== "abstract") {
      return false;
    }

    const next = this.peekWordAt(1);
    if (next === "annotation") {
      return true;
    }

    return next === "inheritable" && this.peekWordAt(2) === "annotation";
  }

  private isAnnotationMutationStart(): boolean {
    const head = this.peekWordAt(0);
    if (head === "annotation") {
      return true;
    }

    if (head === "create" || head === "alter" || head === "drop") {
      return this.peekWordAt(1) === "annotation";
    }

    return false;
  }

  private parseAnnotationMutation(moduleName: string, annotations: AnnotationDef[]): void {
    if (this.matchWord("drop")) {
      this.expectWord("annotation", "Expected 'annotation' after 'drop'");
      const name = this.normalizeAnnotationName(moduleName, this.expect("word", "Expected annotation name").text);
      this.expect("semi", "Expected ';' after drop annotation");
      const index = annotations.findIndex((item) => item.name === name);
      if (index >= 0) {
        annotations.splice(index, 1);
      }
      return;
    }

    if (this.matchWord("create") || this.matchWord("alter")) {
      this.expectWord("annotation", "Expected 'annotation' declaration");
    } else {
      this.expectWord("annotation", "Expected annotation declaration");
    }

    const name = this.normalizeAnnotationName(moduleName, this.expect("word", "Expected annotation name").text);
    this.expect("assign", "Expected ':=' in annotation declaration");
    const value = this.readStringLiteral("Expected annotation string value");
    this.expect("semi", "Expected ';' after annotation declaration");

    const existing = annotations.findIndex((item) => item.name === name);
    if (existing >= 0) {
      annotations[existing] = { name, value };
      return;
    }

    annotations.push({ name, value });
  }

  private parseMember(moduleName: string): TypeMember {
    let required = false;
    let multi = false;
    let overloaded = false;

    while (true) {
      if (this.matchWord("required")) {
        required = true;
        continue;
      }

      if (this.matchWord("multi")) {
        multi = true;
        continue;
      }

      if (this.matchWord("overloaded")) {
        overloaded = true;
        continue;
      }

      if (this.matchWord("single")) {
        continue;
      }

      break;
    }

    let memberKind: "property" | "link" | undefined;
    if (this.peekWordAt(0) === "property") {
      this.consume();
      memberKind = "property";
    } else if (this.peekWordAt(0) === "link") {
      this.consume();
      memberKind = "link";
    }

    const name = this.expect("word", "Expected property or link name").text;

    if (this.match("assign")) {
      return this.parseComputedMember(moduleName, {
        name,
        required,
        multi,
        overloaded,
      });
    }

    if (this.match("arrow")) {
      const targetToken = this.expect("word", "Expected property or link target type");
      this.consumeTypeTail();
      if (memberKind === "property" || (memberKind === undefined && this.isScalarLike(targetToken.text))) {
        const { scalar, enumValues, enumTypeName } = this.readScalarType(moduleName, targetToken.text);

        let annotations: AnnotationDef[] = [];
        let rewrite: PropertyMember["rewrite"] | undefined;
        if (this.match("lbrace")) {
          const parsed = this.parsePropertyBody(moduleName, name);
          rewrite = parsed.rewrite;
          annotations = parsed.annotations;
          this.expect("rbrace", "Expected '}' after property body");
        }

        this.match("semi");
        return {
          kind: "property",
          name,
          scalar,
          required,
          multi,
          overloaded,
          annotations,
          rewrite,
          enumValues,
          enumTypeName,
        };
      }

      const target = this.normalizeTypeName(moduleName, targetToken.text);
      while (this.match("pipe")) {
        this.expect("word", "Expected union link target type");
        this.consumeTypeTail();
      }
      const annotations: AnnotationDef[] = [];
      const linkProperties: LinkProperty[] = [];

      if (this.match("lbrace")) {
        while (!this.match("rbrace")) {
          if (this.isAnnotationMutationStart()) {
            this.parseAnnotationMutation(moduleName, annotations);
            continue;
          }

          let linkPropertyRequired = false;
          if (this.matchWord("required")) {
            linkPropertyRequired = true;
          }

          this.matchWord("single");
          this.matchWord("multi");
          this.matchWord("overloaded");
          this.matchWord("property");

          const propName = this.expect("word", "Expected link property name").text;
          if (this.match("arrow")) {
            const typeName = this.expect("word", "Expected link property scalar type").text;
            this.consumeTypeTail();
            const { scalar: linkScalar } = this.readScalarType(moduleName, typeName);
            let linkPropertyAnnotations: AnnotationDef[] = [];
            if (this.match("lbrace")) {
              linkPropertyAnnotations = this.parseLinkPropertyBody(moduleName);
              this.expect("rbrace", "Expected '}' after link property body");
            }
            this.match("semi");

            linkProperties.push({
              name: propName,
              scalar: linkScalar,
              required: linkPropertyRequired,
              annotations: linkPropertyAnnotations,
            });
            continue;
          }

          if (this.match("colon")) {
            const typeName = this.expect("word", "Expected link property scalar type").text;
            this.consumeTypeTail();
            const { scalar: linkScalar2 } = this.readScalarType(moduleName, typeName);
            this.match("semi");

            linkProperties.push({
              name: propName,
              scalar: linkScalar2,
              required: linkPropertyRequired,
              annotations: [],
            });
            continue;
          }

          this.skipStatementInBlock();
        }
      }

      this.match("semi");
      return {
        kind: "link",
        name,
        target,
        required,
        multi,
        overloaded,
        annotations,
        properties: linkProperties,
      };
    }

    this.expect("colon", "Expected ':' in property declaration");
    const scalarToken = this.expect("word", "Expected property scalar type");
    this.consumeTypeTail();
    const { scalar, enumValues, enumTypeName } = this.readScalarType(moduleName, scalarToken.text);

    let annotations: AnnotationDef[] = [];
    let rewrite: PropertyMember["rewrite"] | undefined;
    if (this.match("lbrace")) {
      const parsed = this.parsePropertyBody(moduleName, name);
      rewrite = parsed.rewrite;
      annotations = parsed.annotations;
      this.expect("rbrace", "Expected '}' after property body");
    }

    this.match("semi");
    return {
      kind: "property",
      name,
      scalar,
      required,
      multi,
      overloaded,
      annotations,
      rewrite,
      enumValues,
      enumTypeName,
    };
  }

  private parseComputedMember(
    moduleName: string,
    options: {
      name: string;
      required: boolean;
      multi: boolean;
      overloaded: boolean;
    },
  ): ComputedMember {
    if (options.required) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", `Computed field '${options.name}' cannot be declared required`, 1, token.index + 1);
    }

    const parsed = this.parseComputedDeclarationExpr(moduleName);
    const annotations: AnnotationDef[] = [];
    if (this.match("lbrace")) {
      while (!this.match("rbrace")) {
        this.parseAnnotationMutation(moduleName, annotations);
      }
    }

    this.expect("semi", "Expected ';' after computed declaration");
    return {
      kind: "computed",
      name: options.name,
      required: false,
      multi: options.multi,
      overloaded: options.overloaded,
      annotations,
      computedKind: parsed.kind,
      expr: parsed.expr,
    };
  }

  private parseComputedDeclarationExpr(moduleName: string): {
    kind: ComputedDef["kind"];
    expr: ComputedDef["expr"];
  } {
    if (this.match("lparen")) {
      this.expectWord("select", "Expected 'select' in computed declaration");
      const selectExpr = this.parseComputedSelectExpr(moduleName);
      this.expect("rparen", "Expected ')' after computed select expression");
      return {
        kind: "link",
        expr: selectExpr,
      };
    }

    const first = this.parseComputedValuePartOrLinkExpr(moduleName);
    if (first.kind === "backlink") {
      return {
        kind: "link",
        expr: first,
      };
    }

    if (first.kind === "link_ref") {
      return {
        kind: "link",
        expr: first,
      };
    }

    if (first.kind === "function_call") {
      return {
        kind: "property",
        expr: {
          kind: "function_call",
          name: first.name,
          args: first.args,
        },
      };
    }

    const parts: ComputedValuePart[] = [first];
    while (this.match("concat")) {
      const nextPart = this.parseComputedValuePart(moduleName);
      parts.push(nextPart);
    }

    if (parts.length === 1) {
      const part = parts[0];
      if (part.kind === "field_ref") {
        return {
          kind: "property",
          expr: {
            kind: "field_ref",
            field: part.field,
          },
        };
      }

      return {
        kind: "property",
        expr: {
          kind: "literal",
          value: part.value,
        },
      };
    }

    return {
      kind: "property",
      expr: {
        kind: "concat",
        parts,
      },
    };
  }

  private parseComputedSelectExpr(moduleName: string): Extract<ComputedDef, { kind: "link" }>['expr'] {
    const source = this.parseComputedLinkRef(moduleName);
    let filter: { field: string; op: "=" | "!=" | "like" | "ilike"; value: ScalarValue } | undefined;

    if (this.matchWord("filter")) {
      this.expect("dot", "Expected '.' before computed select filter field");
      const field = this.expect("word", "Expected field name in computed select filter").text;
      let op: "=" | "!=" | "like" | "ilike";
      if (this.match("equals")) {
        op = "=";
      } else if (this.match("bang_eq")) {
        op = "!=";
      } else if (this.peekWordAt(0) === "like") {
        this.consume();
        op = "like";
      } else if (this.peekWordAt(0) === "ilike") {
        this.consume();
        op = "ilike";
      } else {
        const token = this.peek();
        throw new AppError("E_SYNTAX", "Unsupported computed filter operator", 1, token.index + 1);
      }

      const value = this.readScalarValue("Expected scalar value in computed select filter");
      filter = { field, op, value };
    }

    return {
      kind: "link_ref",
      link: source.link,
      filter,
    };
  }

  private parseComputedValuePartOrLinkExpr(
    moduleName: string,
  ): ComputedValuePart | Extract<ComputedDef, { kind: "link" }>['expr'] | { kind: "function_call"; name: string; args: ScalarValue[] } {
    if (this.peek().kind === "dot") {
      this.consume();

      if (this.match("lt")) {
        const link = this.expect("word", "Expected backlink name after '.<'").text;
        let sourceType: string | undefined;
        if (this.match("lbracket")) {
          this.expectWord("is", "Expected 'is' in backlink type filter");
          sourceType = this.normalizeTypeName(moduleName, this.expect("word", "Expected backlink source type").text);
          this.expect("rbracket", "Expected ']' after backlink type filter");
        }

        return {
          kind: "backlink",
          link,
          sourceType,
        };
      }

      return {
        kind: "field_ref",
        field: this.expect("word", "Expected field name after '.'").text,
      };
    }

    if (this.peekWordAt(0) === "__source__") {
      this.consume();
      this.expect("dot", "Expected '.' after __source__");
      return {
        kind: "field_ref",
        field: this.expect("word", "Expected field name after __source__. ").text,
      };
    }

    if (this.peek().kind === "word") {
      const wordToken = this.peek();
      const word = wordToken.text;
      if (this.peekAt(1).kind === "lparen") {
        this.consume();
        this.consume();
        const args: ScalarValue[] = [];
        while (!this.match("rparen")) {
          args.push(this.readScalarValue("Expected function argument"));
          this.match("comma");
        }
        return {
          kind: "function_call",
          name: word,
          args,
        };
      }
    }

    if (this.peek().kind === "lt") {
      this.consume();
      const typeName = this.expect("word", "Expected type name in cast").text;
      this.expect("gt", "Expected '>' after type name in cast");
      const value = this.readScalarValue("Expected value after type cast");
      return {
        kind: "literal",
        value,
      };
    }

    if (this.peek().kind === "string" || this.peek().kind === "number" || this.peek().kind === "word") {
      return {
        kind: "literal",
        value: this.readScalarValue("Expected computed expression value"),
      };
    }

    return this.parseComputedLinkRef(moduleName);
  }

  private parseComputedValuePart(moduleName: string): ComputedValuePart {
    const parsed = this.parseComputedValuePartOrLinkExpr(moduleName);
    if (parsed.kind === "field_ref" || parsed.kind === "literal") {
      return parsed;
    }

    const token = this.peek();
    throw new AppError("E_SYNTAX", "Computed string concatenation only supports field references and literals", 1, token.index + 1);
  }

  private parseComputedLinkRef(moduleName: string): Extract<ComputedDef, { kind: "link" }>['expr'] {
    this.expect("dot", "Expected '.' in computed link expression");
    return {
      kind: "link_ref",
      link: this.expect("word", "Expected link name in computed link expression").text,
    };
  }

  private parsePropertyBody(
    moduleName: string,
    fieldName: string,
  ): { rewrite: PropertyMember["rewrite"]; annotations: AnnotationDef[] } {
    const rewrite: PropertyMember["rewrite"] = {};
    const annotations: AnnotationDef[] = [];

    while (!this.peekIs("rbrace")) {
      if (this.isAnnotationMutationStart()) {
        this.parseAnnotationMutation(moduleName, annotations);
        continue;
      }

      if (this.peekWordAt(0) === "constraint" || this.peekWordAt(0) === "default" || this.peekWordAt(0) === "readonly") {
        this.skipStatementInBlock();
        continue;
      }

      if (!this.matchWord("rewrite")) {
        this.skipStatementInBlock();
        continue;
      }

      const events = this.parseRewriteEvents();
      this.expectWord("using", "Expected 'using' in rewrite declaration");
      const expr = this.parseParenthesizedRewriteExpr(moduleName, fieldName);
      this.expect("semi", "Expected ';' after rewrite declaration");

      for (const event of events) {
        if (event === "insert") {
          rewrite.onInsert = expr;
        } else {
          rewrite.onUpdate = expr;
        }
      }
    }

    return { rewrite, annotations };
  }

  private parseLinkPropertyBody(moduleName: string): AnnotationDef[] {
    const annotations: AnnotationDef[] = [];

    while (!this.peekIs("rbrace")) {
      if (this.isAnnotationMutationStart()) {
        this.parseAnnotationMutation(moduleName, annotations);
        continue;
      }

      this.skipStatementInBlock();
    }

    return annotations;
  }

  private parseTrigger(moduleName: string): TriggerDef {
    const name = this.expect("word", "Expected trigger name").text;
    this.expectWord("after", "Expected 'after' in trigger declaration");
    const eventToken = this.expect("word", "Expected trigger event").text;
    if (eventToken !== "insert" && eventToken !== "update" && eventToken !== "delete") {
      const token = this.peek();
      throw new AppError("E_SYNTAX", `Unsupported trigger event '${eventToken}'`, 1, token.index + 1);
    }

    let scope: TriggerDef["scope"] = "each";
    if (this.matchWord("for")) {
      const scopeToken = this.expect("word", "Expected trigger scope ('each' or 'all')").text;
      if (scopeToken !== "each" && scopeToken !== "all") {
        const token = this.peek();
        throw new AppError("E_SYNTAX", `Unsupported trigger scope '${scopeToken}'`, 1, token.index + 1);
      }
      scope = scopeToken;
    }

    let when: TriggerDef["when"];
    if (this.matchWord("when")) {
      this.expect("lparen", "Expected '(' after 'when'");
      when = this.parseTriggerWhenCondition();
      this.expect("rparen", "Expected ')' after trigger 'when' expression");
    }

    this.expectWord("do", "Expected 'do' in trigger declaration");
    this.expect("lparen", "Expected '(' before trigger body");
    const actions: TriggerInsertAction[] = [];
    while (!this.match("rparen")) {
      actions.push(this.parseTriggerAction(moduleName));
      if (this.peekIs("rparen")) {
        continue;
      }
      this.match("semi");
    }
    this.expect("semi", "Expected ';' after trigger declaration");

    return {
      name,
      event: eventToken,
      scope,
      when,
      actions,
    };
  }

  private parseAccessPolicy(moduleName: string): AccessPolicyDef {
    const name = this.expect("word", "Expected access policy name").text;
    const effect = this.expect("word", "Expected access policy effect ('allow' or 'deny')").text;
    if (effect !== "allow" && effect !== "deny") {
      const token = this.peek();
      throw new AppError("E_SYNTAX", `Unsupported policy effect '${effect}'`, 1, token.index + 1);
    }

    const operations = this.parsePolicyOperations();
    let condition: AccessPolicyCondition = { kind: "always", value: true };
    if (this.matchWord("using")) {
      this.expect("lparen", "Expected '(' after policy 'using'");
      condition = this.parsePolicyCondition(moduleName);
      this.expect("rparen", "Expected ')' after policy condition");
    }

    let errmessage: string | undefined;
    if (this.match("lbrace")) {
      while (!this.match("rbrace")) {
        this.expectWord("errmessage", "Expected 'errmessage' in policy block");
        this.expect("assign", "Expected ':=' after 'errmessage'");
        errmessage = this.readStringLiteral("Expected string literal for policy errmessage");
        this.expect("semi", "Expected ';' after errmessage declaration");
      }
    }

    this.expect("semi", "Expected ';' after access policy declaration");

    return {
      name,
      effect,
      operations,
      condition,
      errmessage,
    };
  }

  private parseRewriteEvents(): Array<"insert" | "update"> {
    const events: Array<"insert" | "update"> = [];
    while (true) {
      const token = this.expect("word", "Expected mutation rewrite event").text;
      if (token !== "insert" && token !== "update") {
        const current = this.peek();
        throw new AppError("E_SYNTAX", `Unsupported rewrite event '${token}'`, 1, current.index + 1);
      }
      events.push(token);
      if (!this.match("comma")) {
        break;
      }
    }

    return events;
  }

  private parseParenthesizedRewriteExpr(moduleName: string, fieldName: string): MutationRewriteExpr {
    this.expect("lparen", "Expected '(' after 'using'");
    const expr = this.parseRewriteExpr(moduleName, fieldName);
    this.expect("rparen", "Expected ')' to close rewrite expression");
    return expr;
  }

  private parseRewriteExpr(moduleName: string, fieldName: string): MutationRewriteExpr {
    const token = this.peek();
    if (token.kind === "word" && token.text === "datetime_of_statement") {
      this.consume();
      this.expect("lparen", "Expected '(' after datetime_of_statement");
      this.expect("rparen", "Expected ')' after datetime_of_statement(");
      return { kind: "datetime_of_statement" };
    }

    if (token.kind === "dot") {
      this.consume();
      const field = this.expect("word", "Expected field name after '.'").text;
      return {
        kind: "subject_field",
        field,
      };
    }

    if (token.kind === "word" && token.text === "__subject__") {
      this.consume();
      this.expect("dot", "Expected '.' after __subject__");
      return {
        kind: "subject_field",
        field: this.expect("word", "Expected field name after __subject__.").text,
      };
    }

    if (token.kind === "word" && token.text === "__old__") {
      this.consume();
      this.expect("dot", "Expected '.' after __old__");
      return {
        kind: "old_field",
        field: this.expect("word", "Expected field name after __old__.").text,
      };
    }

    return {
      kind: "literal",
      value: this.readScalarValue(`Expected rewrite expression for '${moduleName}::${fieldName}'`),
    };
  }

  private parseTriggerWhenCondition(): TriggerDef["when"] {
    const lhs = this.parseTriggerValueExpr();
    this.expect("bang_eq", "Expected '!=' in trigger when condition");
    const rhs = this.parseTriggerValueExpr();

    if (lhs.kind === "old_field" && rhs.kind === "new_field" && lhs.field === rhs.field) {
      return { kind: "field_changed", field: lhs.field };
    }

    if (lhs.kind === "new_field" && rhs.kind === "old_field" && lhs.field === rhs.field) {
      return { kind: "field_changed", field: lhs.field };
    }

    const token = this.peek();
    throw new AppError("E_SYNTAX", "Unsupported trigger 'when' expression", 1, token.index + 1);
  }

  private parseTriggerAction(moduleName: string): TriggerInsertAction {
    this.expectWord("insert", "Expected trigger action 'insert'");
    const targetType = this.normalizeTypeName(moduleName, this.expect("word", "Expected trigger target type").text);
    this.expect("lbrace", "Expected '{' in trigger action");

    const values: Record<string, TriggerValueExpr> = {};
    while (!this.match("rbrace")) {
      const fieldName = this.expect("word", "Expected field name in trigger action").text;
      this.expect("assign", "Expected ':=' in trigger action assignment");
      values[fieldName] = this.parseTriggerValueExpr();
      if (!this.peekIs("rbrace")) {
        this.expect("comma", "Expected ',' between trigger action assignments");
      }
    }

    return {
      kind: "insert",
      targetType,
      values,
    };
  }

  private parseTriggerValueExpr(): TriggerValueExpr {
    if (this.peek().kind === "word" && this.peek().text === "__new__") {
      this.consume();
      this.expect("dot", "Expected '.' after __new__");
      return {
        kind: "new_field",
        field: this.expect("word", "Expected field name after __new__.").text,
      };
    }

    if (this.peek().kind === "word" && this.peek().text === "__old__") {
      this.consume();
      this.expect("dot", "Expected '.' after __old__");
      return {
        kind: "old_field",
        field: this.expect("word", "Expected field name after __old__.").text,
      };
    }

    return {
      kind: "literal",
      value: this.readScalarValue("Expected trigger value expression"),
    };
  }

  private parsePolicyOperations(): AccessPolicyOperation[] {
    const operations: AccessPolicyOperation[] = [];
    while (true) {
      const token = this.expect("word", "Expected access policy operation").text;
      if (token === "all" || token === "select" || token === "insert" || token === "delete") {
        operations.push(token);
      } else if (token === "update") {
        if (this.matchWord("read")) {
          operations.push("update_read");
        } else if (this.matchWord("write")) {
          operations.push("update_write");
        } else {
          operations.push("update_read", "update_write");
        }
      } else {
        const current = this.peek();
        throw new AppError("E_SYNTAX", `Unsupported access policy operation '${token}'`, 1, current.index + 1);
      }

      if (!this.match("comma")) {
        break;
      }
    }

    return operations;
  }

  private parsePolicyCondition(moduleName: string): AccessPolicyCondition {
    const clauses: AccessPolicyCondition[] = [];
    clauses.push(this.parsePolicyConditionAtom(moduleName));
    while (this.matchWord("and")) {
      clauses.push(this.parsePolicyConditionAtom(moduleName));
    }

    if (clauses.length === 1) {
      return clauses[0];
    }

    return {
      kind: "and",
      clauses,
    };
  }

  private parsePolicyConditionAtom(moduleName: string): AccessPolicyCondition {
    if (this.match("lparen")) {
      const nested = this.parsePolicyCondition(moduleName);
      this.expect("rparen", "Expected ')' after nested policy condition");
      return nested;
    }

    const left = this.parsePolicyOperand(moduleName);
    if (this.peekIs("qeq") || this.peekIs("equals")) {
      this.consume();
      const right = this.parsePolicyOperand(moduleName);

      if (left.kind === "global" && right.kind === "field") {
        return { kind: "field_eq_global", field: right.field, global: left.name };
      }
      if (left.kind === "field" && right.kind === "global") {
        return { kind: "field_eq_global", field: left.field, global: right.name };
      }
      if (left.kind === "field" && right.kind === "literal") {
        return { kind: "field_eq_literal", field: left.field, value: right.value };
      }

      const token = this.peek();
      throw new AppError("E_SYNTAX", "Unsupported access policy comparison expression", 1, token.index + 1);
    }

    if (left.kind === "global") {
      return { kind: "global", name: left.name };
    }

    if (left.kind === "literal" && typeof left.value === "boolean") {
      return { kind: "always", value: left.value };
    }

    const token = this.peek();
    throw new AppError("E_SYNTAX", "Unsupported access policy condition", 1, token.index + 1);
  }

  private parsePolicyOperand(moduleName: string):
    | { kind: "global"; name: string }
    | { kind: "field"; field: string }
    | { kind: "literal"; value: ScalarValue } {
    if (this.matchWord("global")) {
      return {
        kind: "global",
        name: this.expect("word", "Expected global name").text,
      };
    }

    if (this.match("dot")) {
      return {
        kind: "field",
        field: this.parsePolicyPathField(),
      };
    }

    return {
      kind: "literal",
      value: this.readScalarValue("Expected policy operand"),
    };
  }

  private parsePolicyPathField(): string {
    const first = this.expect("word", "Expected field path after '.'").text;
    if (!this.match("dot")) {
      return first;
    }

    const second = this.expect("word", "Expected path segment after '.'").text;
    if (second === "id") {
      return `${first}_id`;
    }

    return `${first}_${second}`;
  }

  private readScalarType(moduleName: string, name: string): { scalar: ScalarType; enumValues?: string[]; enumTypeName?: string } {
    const normalized = name.includes("::") ? name.split("::").at(-1)! : name;
    const lowered = normalized.toLowerCase();

    const mapped: Record<string, ScalarType> = {
      str: "str",
      bytes: "str",
      json: "json",
      bool: "bool",
      uuid: "uuid",
      datetime: "datetime",
      duration: "duration",
      local_datetime: "local_datetime",
      local_date: "local_date",
      local_time: "local_time",
      relative_duration: "relative_duration",
      date_duration: "date_duration",
      int: "int",
      int16: "int",
      int32: "int",
      int64: "int",
      bigint: "int",
      float: "float",
      float32: "float",
      float64: "float",
      decimal: "float",
      array: "str",
      tuple: "str",
    };

    if (mapped[lowered]) {
      return { scalar: mapped[lowered] };
    }

    const alias = this.scalarAliases.get(normalized) ?? this.scalarAliases.get(lowered);
    if (alias) {
      const enumVals = this.getEnumValues(normalized);
      const enumTypeName = name.includes("::") ? name : `${moduleName}::${normalized}`;
      return { scalar: alias, enumValues: enumVals, enumTypeName };
    }

    if (!BUILTIN_SCALARS.has(lowered)) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", `Unknown scalar type '${name}'`, 1, token.index + 1);
    }

    return { scalar: lowered as ScalarType };
  }

  private parseScalarType(moduleName: string, scalarTypes: ScalarTypeDeclaration[]): void {
    this.expectWord("scalar", "Expected 'scalar' declaration");
    this.expectWord("type", "Expected 'type' after 'scalar'");
    const name = this.expect("word", "Expected scalar type name").text;
    let alias: ScalarType = "str";
    let enumVals: string[] | undefined;

    if (this.matchWord("extending")) {
      if (this.matchWord("enum")) {
        enumVals = this.parseEnumValues();
        this.enumValues.set(name, enumVals);
        this.enumValues.set(name.toLowerCase(), enumVals);
        alias = "str";
      } else {
        alias = this.readScalarType(moduleName, this.expect("word", "Expected scalar base type").text).scalar;
      }
    }

    this.scalarAliases.set(name, alias);
    this.scalarAliases.set(name.toLowerCase(), alias);

    if (enumVals) {
      scalarTypes.push({ name, module: moduleName, enumValues: enumVals });
    }

    if (this.match("lbrace")) {
      this.skipBlockBody();
      this.expect("rbrace", "Expected '}' after scalar type body");
      this.match("semi");
      return;
    }

    this.match("semi");
  }

  private parseEnumValues(): string[] {
    this.expect("lt", "Expected '<' for enum type");
    const values: string[] = [];
    while (!this.match("gt")) {
      const token = this.expect("string", "Expected enum value");
      values.push(token.text);
      this.match("comma");
    }
    return values;
  }

  getEnumValues(name: string): string[] | undefined {
    return this.enumValues.get(name) ?? this.enumValues.get(name.toLowerCase());
  }

  private skipAngleTypeArgs(): void {
    this.expect("lt", "Expected '<'");
    let depth = 1;
    while (depth > 0) {
      const token = this.consume();
      if (token.kind === "lt") {
        depth += 1;
      } else if (token.kind === "gt") {
        depth -= 1;
      } else if (token.kind === "eof") {
        throw new AppError("E_SYNTAX", "Unterminated angle bracket expression", 1, token.index + 1);
      }
    }
  }

  private consumeTypeTail(): void {
    while (this.peekIs("lt")) {
      this.skipAngleTypeArgs();
    }
  }

  private isTypeDeclarationStart(): boolean {
    if (this.peekWordAt(0) === "type") {
      return true;
    }
    return this.peekWordAt(0) === "abstract" && this.peekWordAt(1) === "type";
  }

  private isScalarLike(name: string): boolean {
    const normalized = name.includes("::") ? name.split("::").at(-1)! : name;
    const lowered = normalized.toLowerCase();
    return BUILTIN_SCALARS.has(lowered) || this.scalarAliases.has(normalized) || this.scalarAliases.has(lowered);
  }

  private skipDeclaration(): void {
    let depth = 0;
    while (!this.peekIs("eof")) {
      const token = this.peek();
      if (token.kind === "lbrace" || token.kind === "lparen" || token.kind === "lbracket") {
        depth += 1;
        this.consume();
        continue;
      }

      if (token.kind === "rbrace" || token.kind === "rparen" || token.kind === "rbracket") {
        if (depth === 0) {
          return;
        }
        depth -= 1;
        this.consume();
        if (depth === 0 && token.kind === "rbrace") {
          this.match("semi");
          return;
        }
        continue;
      }

      if (token.kind === "semi" && depth === 0) {
        this.consume();
        return;
      }

      this.consume();
    }
  }

  private skipStatementInBlock(): void {
    let depth = 0;
    while (!this.peekIs("eof")) {
      const token = this.peek();

      if (token.kind === "semi" && depth === 0) {
        this.consume();
        return;
      }

      if (token.kind === "rbrace" || token.kind === "rparen" || token.kind === "rbracket") {
        if (depth === 0) {
          if (token.kind === "rbrace") {
            return;
          }
          this.consume();
          return;
        }
        depth -= 1;
        this.consume();
        if (depth === 0 && token.kind === "rbrace") {
          this.match("semi");
          return;
        }
        continue;
      }

      if (token.kind === "lbrace" || token.kind === "lparen" || token.kind === "lbracket") {
        depth += 1;
      }

      this.consume();
    }
  }

  private skipBlockBody(): void {
    let depth = 1;
    while (depth > 0) {
      const token = this.consume();
      if (token.kind === "lbrace") {
        depth += 1;
      } else if (token.kind === "rbrace") {
        depth -= 1;
      } else if (token.kind === "eof") {
        throw new AppError("E_SYNTAX", "Unterminated block", 1, token.index + 1);
      }
    }
    this.index -= 1;
  }

  private normalizeTypeName(moduleName: string, name: string): string {
    if (name.includes("::")) {
      return name;
    }

    return `${moduleName}::${name}`;
  }

  private normalizeAnnotationName(moduleName: string, name: string): string {
    if (name.includes("::")) {
      return name;
    }

    if (STANDARD_ANNOTATIONS.has(name)) {
      return `std::${name}`;
    }

    return `${moduleName}::${name}`;
  }

  private readStringLiteral(message: string): string {
    const token = this.peek();
    if (token.kind !== "string") {
      throw new AppError("E_SYNTAX", message, 1, token.index + 1);
    }

    this.index += 1;
    return token.text;
  }

  private readScalarValue(message: string): ScalarValue {
    const token = this.peek();
    const word = token.kind === "word" ? token.text.toLowerCase() : "";

    if (token.kind === "minus") {
      this.consume();
      const valueToken = this.expect("number", message);
      return -Number(valueToken.text);
    }

    if (token.kind === "string") {
      this.index += 1;
      return token.text;
    }

    if (token.kind === "number") {
      this.index += 1;
      return Number(token.text);
    }

    if (token.kind === "word" && word === "true") {
      this.index += 1;
      return true;
    }

    if (token.kind === "word" && word === "false") {
      this.index += 1;
      return false;
    }

    if (token.kind === "word" && word === "null") {
      this.index += 1;
      return null;
    }

    throw new AppError("E_SYNTAX", message, 1, token.index + 1);
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.index += 1;
      return true;
    }

    return false;
  }

  private peekIs(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private consume(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private matchWord(word: string): boolean {
    const token = this.peek();
    if (token.kind === "word" && token.text.toLowerCase() === word.toLowerCase()) {
      this.index += 1;
      return true;
    }

    return false;
  }

  private expectWord(word: string, message: string): void {
    if (!this.matchWord(word)) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", message, 1, token.index + 1);
    }
  }

  private expect(kind: TokenKind, message: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new AppError("E_SYNTAX", message, 1, token.index + 1);
    }

    this.index += 1;
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private peekAt(offset: number): Token {
    return this.tokens[this.index + offset];
  }

  private peekWordAt(offset: number): string | undefined {
    const token = this.tokens[this.index + offset];
    return token?.kind === "word" ? token.text : undefined;
  }
}

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "{") {
      tokens.push({ kind: "lbrace", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === "}") {
      tokens.push({ kind: "rbrace", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ kind: "lparen", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "rparen", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === "[") {
      tokens.push({ kind: "lbracket", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === "]") {
      tokens.push({ kind: "rbracket", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === ".") {
      tokens.push({ kind: "dot", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === ":" && source[i + 1] === "=") {
      tokens.push({ kind: "assign", text: ":=", index: i });
      i += 2;
      continue;
    }

    if (ch === "?" && source[i + 1] === "=") {
      tokens.push({ kind: "qeq", text: "?=", index: i });
      i += 2;
      continue;
    }

    if (ch === "!" && source[i + 1] === "=") {
      tokens.push({ kind: "bang_eq", text: "!=", index: i });
      i += 2;
      continue;
    }

    if (ch === "=") {
      tokens.push({ kind: "equals", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === ":") {
      tokens.push({ kind: "colon", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === ";") {
      tokens.push({ kind: "semi", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === ",") {
      tokens.push({ kind: "comma", text: ch, index: i });
      i += 1;
      continue;
    }

    if (ch === "-" && source[i + 1] === ">") {
      tokens.push({ kind: "arrow", text: "->", index: i });
      i += 2;
      continue;
    }

    if (ch === "+" && source[i + 1] === "+") {
      tokens.push({ kind: "concat", text: "++", index: i });
      i += 2;
      continue;
    }

    if (ch === "<") {
      tokens.push({ kind: "lt", text: "<", index: i });
      i += 1;
      continue;
    }

    if (ch === ">") {
      tokens.push({ kind: "gt", text: ">", index: i });
      i += 1;
      continue;
    }

    if (ch === "-") {
      tokens.push({ kind: "minus", text: "-", index: i });
      i += 1;
      continue;
    }

    if (ch === "|") {
      tokens.push({ kind: "pipe", text: "|", index: i });
      i += 1;
      continue;
    }

    if (ch === "*") {
      tokens.push({ kind: "star", text: "*", index: i });
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      let value = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < source.length) {
          value += source[i + 1];
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }

      if (i >= source.length) {
        throw new AppError("E_SYNTAX", "Unterminated string literal", 1, start + 1);
      }

      i += 1;
      tokens.push({ kind: "string", text: value, index: start });
      continue;
    }

    if (/\d/.test(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && /[\d.]/.test(source[i])) {
        i += 1;
      }

      tokens.push({ kind: "number", text: source.slice(start, i), index: start });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (/[A-Za-z0-9_]/.test(source[i])) {
          i += 1;
          continue;
        }

        if (source[i] === ":" && source[i + 1] === ":") {
          i += 2;
          continue;
        }

        break;
      }

      tokens.push({
        kind: "word",
        text: source.slice(start, i),
        index: start,
      });
      continue;
    }

    throw new AppError("E_SYNTAX", `Unexpected token '${ch}'`, 1, i + 1);
  }

  tokens.push({ kind: "eof", text: "", index: source.length });
  return tokens;
};

export const parseDeclarativeSchema = (source: string): DeclarativeSchema => {
  const parser = new Parser(source);
  return parser.parse();
};

export const gelSchema = (strings: TemplateStringsArray, ...values: unknown[]): DeclarativeSchema => {
  const source = strings.reduce((acc, part, index) => {
    const value = index < values.length ? String(values[index]) : "";
    return `${acc}${part}${value}`;
  }, "");

  return parseDeclarativeSchema(source);
};
