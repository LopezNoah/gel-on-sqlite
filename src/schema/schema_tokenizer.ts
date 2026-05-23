// parser.ts

export type TokenType =
  | "keyword"
  | "identifier"
  | "string"
  | "number"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "colon"
  | "semicolon"
  | "dot"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "equal"       // =
  | "exclamation" // !
  | "not_equals"  // !=
  | "assign"      // :=
  | "arrow"       // ->
  | "colon2"      // ::
  | "symbol"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface ParseOptions {
  legacySyntaxCompat?: boolean;
}

const DEFAULT_PARSE_OPTIONS: Readonly<Required<ParseOptions>> = {
  legacySyntaxCompat: true,
};

const normalizeParseOptions = (options: ParseOptions): Required<ParseOptions> => ({
  ...DEFAULT_PARSE_OPTIONS,
  ...options,
});

const KEYWORDS = new Set([
  "abstract",
  "type",
  "scalar",
  "enum",
  "function",
  "extending",
  "annotation",
  "inheritable",
  "property",
  "link",
  "constraint",
  "delegated",
  "required",
  "optional",
  "single",
  "multi",
  "overloaded",
  "default",
  "readonly",
  "true",
  "false",
  "using",
  "set",
  "of",
  "named",
  "only",
  "variadic",
  "volatility",
  "on",
  "except",
  "errmessage",
  "index",
  "module",
  "alias",
  "target",
  "source",
  "delete",
]);

// ---------------- Tokenizer ----------------

export class Tokenizer {
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly input: string) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (!this.isAtEnd()) {
      this.skipWhitespaceAndComments();
      if (this.isAtEnd()) break;

      const start = this.pos;
      const line = this.line;
      const column = this.column;
      const ch = this.peek();

      if (this.isIdentifierStart(ch)) {
        const value = this.readIdentifier();
        tokens.push({
          type: KEYWORDS.has(value) ? "keyword" : "identifier",
          value,
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      if (this.isDigit(ch)) {
        const value = this.readNumber();
        tokens.push({
          type: "number",
          value,
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      if (ch === "'" || ch === '"') {
        const value = this.readString();
        tokens.push({
          type: "string",
          value,
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      if (ch === ":" && this.peek(1) === "=") {
        this.advance();
        this.advance();
        tokens.push({
          type: "assign",
          value: ":=",
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      if (ch === ":" && this.peek(1) === ":") {
        this.advance();
        this.advance();
        tokens.push({
          type: "colon2",
          value: "::",
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      if (ch === "-" && this.peek(1) === ">") {
        this.advance();
        this.advance();
        tokens.push({
          type: "arrow",
          value: "->",
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      if (ch === "!" && this.peek(1) === "=") {
        this.advance();
        this.advance();
        tokens.push({
          type: "not_equals",
          value: "!=",
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      if (ch === "<" && this.peek(1) === "=") {
        this.advance();
        this.advance();
        tokens.push({
          type: "lte",
          value: "<=",
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      if (ch === ">" && this.peek(1) === "=") {
        this.advance();
        this.advance();
        tokens.push({
          type: "gte",
          value: ">=",
          start,
          end: this.pos,
          line,
          column,
        });
        continue;
      }

      switch (ch) {
        case "{":
          this.advance();
          tokens.push(this.makeToken("lbrace", "{", start, line, column));
          break;
        case "}":
          this.advance();
          tokens.push(this.makeToken("rbrace", "}", start, line, column));
          break;
        case "(":
          this.advance();
          tokens.push(this.makeToken("lparen", "(", start, line, column));
          break;
        case ")":
          this.advance();
          tokens.push(this.makeToken("rparen", ")", start, line, column));
          break;
        case "[":
          this.advance();
          tokens.push(this.makeToken("lbracket", "[", start, line, column));
          break;
        case "]":
          this.advance();
          tokens.push(this.makeToken("rbracket", "]", start, line, column));
          break;
        case ",":
          this.advance();
          tokens.push(this.makeToken("comma", ",", start, line, column));
          break;
        case ":":
          this.advance();
          tokens.push(this.makeToken("colon", ":", start, line, column));
          break;
        case ";":
          this.advance();
          tokens.push(this.makeToken("semicolon", ";", start, line, column));
          break;
        case ".":
          this.advance();
          tokens.push(this.makeToken("dot", ".", start, line, column));
          break;
        case "<":
          this.advance();
          tokens.push(this.makeToken("lt", "<", start, line, column));
          break;
        case ">":
          this.advance();
          tokens.push(this.makeToken("gt", ">", start, line, column));
          break;
        case "!":
            this.advance();
            tokens.push(this.makeToken("exclamation", "!", start, line, column));
            break;
        case "=":
            this.advance();
            tokens.push(this.makeToken("equal", "=", start, line, column));
            break;
        default:
          this.advance();
          tokens.push(this.makeToken("symbol", ch, start, line, column));
      }
    }

    tokens.push({
      type: "eof",
      value: "",
      start: this.pos,
      end: this.pos,
      line: this.line,
      column: this.column,
    });

    return tokens;
  }

  private makeToken(
    type: TokenType,
    value: string,
    start: number,
    line: number,
    column: number
  ): Token {
    return { type, value, start, end: this.pos, line, column };
  }

  private syntaxError(message: string, _pos: number, line: number, column: number) {
    return new SyntaxError(`${message} at ${line}:${column}`);
  }

  private isAtEnd(): boolean {
    return this.pos >= this.input.length;
  }

  private peek(offset = 0): string {
    return this.input[this.pos + offset] ?? "";
  }

  private advance(): string {
    const ch = this.input[this.pos++] ?? "";
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private skipWhitespaceAndComments(): void {
    while (!this.isAtEnd()) {
      const ch = this.peek();

      if (/\s/.test(ch)) {
        this.advance();
        continue;
      }

      // line comment
      if (ch === "#" ) {
        while (!this.isAtEnd() && this.peek() !== "\n") this.advance();
        continue;
      }

      // // comment
      if (ch === "/" && this.peek(1) === "/") {
        this.advance();
        this.advance();
        while (!this.isAtEnd() && this.peek() !== "\n") this.advance();
        continue;
      }

      // /* comment */
      if (ch === "/" && this.peek(1) === "*") {
        this.advance();
        this.advance();
        while (!this.isAtEnd()) {
          if (this.peek() === "*" && this.peek(1) === "/") {
            this.advance();
            this.advance();
            break;
          }
          this.advance();
        }
        continue;
      }

      break;
    }
  }

  private isIdentifierStart(ch: string): boolean {
    return /[A-Za-z_]/.test(ch);
  }

  private isIdentifierPart(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch);
  }

  private isDigit(ch: string): boolean {
    return /[0-9]/.test(ch);
  }

  private readIdentifier(): string {
    const start = this.pos;
    this.advance();
    while (!this.isAtEnd() && this.isIdentifierPart(this.peek())) {
      this.advance();
    }
    return this.input.slice(start, this.pos);
  }

  private readNumber(): string {
    const start = this.pos;
    while (!this.isAtEnd() && /[0-9.]/.test(this.peek())) {
      this.advance();
    }
    return this.input.slice(start, this.pos);
  }

  private readString(): string {
    const quote = this.advance();
    const start = this.pos - 1;

    while (!this.isAtEnd()) {
      const ch = this.advance();
      if (ch === "\\") {
        if (!this.isAtEnd()) this.advance();
        continue;
      }
      if (ch === quote) {
        return this.input.slice(start, this.pos);
      }
    }

    throw new SyntaxError(`Unterminated string at ${this.line}:${this.column}`);
  }
}

// ---------------- AST ----------------

export interface DocumentNode {
  kind: "Document";
  declarations: TopLevelDeclarationNode[];
}

export type TopLevelDeclarationNode =
  | TypeDeclarationNode
  | ScalarTypeDeclarationNode
  | AbstractAnnotationNode
  | ConstraintDeclarationNode
  | FunctionDeclarationNode
  | AliasDeclarationNode
  | IgnoredDeclarationNode;

export interface IgnoredDeclarationNode {
  kind: "IgnoredDeclaration";
}

export interface AliasDeclarationNode {
  kind: "AliasDeclaration";
  name: QualifiedNameNode;
  expr: OpaqueNode;
}

export type DeclarationNode =
  | AnnotationAssignmentNode
  | PropertyDeclarationNode
  | LinkDeclarationNode
  | ConstraintDeclarationNode
  | IndexDeclarationNode;

export type FunctionVolatilityNode = "Immutable" | "Stable" | "Volatile" | "Modifying";

export interface FunctionDeclarationNode {
  kind: "FunctionDeclaration";
  name: QualifiedNameNode;
  params: FunctionParamNode[];
  returnType: string;
  returnOptional: boolean;
  returnSetOf: boolean;
  volatility: FunctionVolatilityNode | null;
  annotations: AnnotationAssignmentNode[];
  body: FunctionBodyNode;
}

export interface FunctionParamNode {
  name: string;
  type: string;
  optional: boolean;
  setOf: boolean;
  variadic: boolean;
  namedOnly: boolean;
  defaultExpr: OpaqueNode | null;
}

export interface FunctionBodyNode {
  kind: "FunctionBody";
  language: "edgeql";
  text: string;
}

export interface ScalarTypeDeclarationNode {
  kind: "ScalarTypeDeclaration";
  name: QualifiedNameNode;
  baseType: OpaqueNode | null;
  enumValues: string[] | null;
  body: ScalarTypeBodyNode | null;
}

export interface ScalarTypeBodyNode {
  kind: "ScalarTypeBody";
  annotations: AnnotationAssignmentNode[];
  constraints: ConstraintDeclarationNode[];
}

export interface TypeDeclarationNode {
  kind: "TypeDeclaration";
  abstract: boolean;
  name: QualifiedNameNode;
  extends: QualifiedNameNode[];
  body: TypeBodyNode | null;
}

export interface TypeBodyNode {
  kind: "TypeBody";
  declarations: DeclarationNode[];
}

export interface QualifiedNameNode {
  kind: "QualifiedName";
  parts: string[];
}

const opaqueTypeReferenceToQualifiedName = (node: OpaqueNode): QualifiedNameNode | null => {
  const text = node.text.trim();
  if (text.length === 0 || text.includes("|") || text.includes("<") || text.includes(">")) {
    return null;
  }

  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ":" && text[i + 1] === ":") {
      const part = text.slice(start, i).trim();
      if (part.length === 0) {
        return null;
      }
      parts.push(part);
      i += 1;
      start = i + 1;
    }
  }

  const last = text.slice(start).trim();
  if (last.length === 0) {
    return null;
  }
  parts.push(last);
  return { kind: "QualifiedName", parts };
};

export interface AbstractAnnotationNode {
  kind: "AbstractAnnotation";
  abstract: true;
  inheritable: boolean;
  name: QualifiedNameNode;
  body: AnnotationBlockNode | null;
}

export interface AnnotationBlockNode {
  kind: "AnnotationBlock";
  declarations: AnnotationAssignmentNode[];
}

export interface AnnotationAssignmentNode {
  kind: "AnnotationAssignment";
  name: QualifiedNameNode;
  value: OpaqueNode;
}

export interface PropertyDeclarationNode {
  kind: "PropertyDeclaration";
  explicitKeyword: boolean;
  abstract: boolean;
  overloaded: boolean;
  required: boolean | null;
  cardinality: "single" | "multi" | null;
  name: QualifiedNameNode;
  declaredType: QualifiedNameNode | null;
  typeExpr: OpaqueNode | null;
  computed: boolean;
  expr: OpaqueNode | null;
  body: PropertyBodyNode | null;
}

export interface PropertyBodyNode {
  kind: "PropertyBody";
  using: OpaqueNode | null;
  extending: QualifiedNameNode[];
  default: OpaqueNode | null;
  readonly: boolean | null;
  annotations: AnnotationAssignmentNode[];
  constraints: ConstraintDeclarationNode[];
}

export interface LinkDeclarationNode {
  kind: "LinkDeclaration";
  explicitKeyword: boolean;
  abstract: boolean;
  overloaded: boolean;
  required: boolean | null;
  cardinality: "single" | "multi" | null;
  name: QualifiedNameNode;
  declaredType: QualifiedNameNode | null;
  targetType: OpaqueNode | null;
  computed: boolean;
  expr: OpaqueNode | null;
  body: LinkBodyNode | null;
}

export interface LinkBodyNode {
  kind: "LinkBody";
  using: OpaqueNode | null;
  extending: QualifiedNameNode[];
  default: OpaqueNode | null;
  readonly: boolean | null;
  onTargetDelete: string | null;
  onSourceDelete: string | null;
  annotations: AnnotationAssignmentNode[];
  properties: PropertyDeclarationNode[];
  constraints: ConstraintDeclarationNode[];
  indexes: IndexDeclarationNode[];
}

export interface ConstraintDeclarationNode {
  kind: "ConstraintDeclaration";
  abstract: boolean;
  delegated: boolean;
  name: QualifiedNameNode;
  args: ConstraintArgNode[];
  onExpr: OpaqueNode | null;
  exceptExpr: OpaqueNode | null;
  extending: QualifiedNameNode[];
  using: OpaqueNode | null;
  errmessage: OpaqueNode | null;
  annotations: AnnotationAssignmentNode[];
}

export interface ConstraintArgNode {
  kind: "ConstraintArg";
  name: string | null;
  value: OpaqueNode;
}

export interface IndexDeclarationNode {
  kind: "IndexDeclaration";
  content: OpaqueNode;
}

export interface OpaqueNode {
  kind: "Opaque";
  text: string;
}

// ---------------- Parser ----------------

export class Parser {
  private pos = 0;
  private readonly options: Required<ParseOptions>;

  constructor(
    private readonly tokens: Token[],
    private readonly sourceText: string,
    options: ParseOptions = {}
  ) {
    this.options = normalizeParseOptions(options);
  }

  parseDocument(): DocumentNode {
    const declarations: TopLevelDeclarationNode[] = [];

    while (!this.check("eof")) {
      declarations.push(this.parseTopLevelDeclaration());
    }

    return {
      kind: "Document",
      declarations,
    };
  }

  parseTypeDeclaration(): TypeDeclarationNode {
    const isAbstract = this.matchKeyword("abstract");
    this.expectKeyword("type");

    const name = this.parseQualifiedName();
    const extendsList = this.parseOptionalExtendingList();

    let body: TypeBodyNode | null = null;
    if (this.match("lbrace")) {
      body = this.parseTypeBody();
      this.expect("rbrace", "Expected '}' to close type body");
      this.match("semicolon");
    } else {
      this.match("semicolon");
    }

    return {
      kind: "TypeDeclaration",
      abstract: isAbstract,
      name,
      extends: extendsList,
      body,
    };
  }

  parseScalarTypeDeclaration(): ScalarTypeDeclarationNode {
    this.expectNameValueInsensitive("scalar", "Expected keyword 'scalar'");
    this.expectNameValueInsensitive("type", "Expected keyword 'type' after 'scalar'");
    const name = this.parseQualifiedName();

    let baseType: OpaqueNode | null = null;
    let enumValues: string[] | null = null;
    if (this.matchNameInsensitive("extending")) {
      if (this.matchNameInsensitive("enum")) {
        enumValues = this.parseEnumValues();
      } else {
        baseType = this.parseTypeReferenceUntilBoundary("Expected scalar base type");
      }
    }

    let body: ScalarTypeBodyNode | null = null;
    if (this.match("lbrace")) {
      body = this.parseScalarTypeBody();
      this.expect("rbrace", "Expected '}' after scalar type body");
      this.match("semicolon");
    } else {
      this.match("semicolon");
    }

    return {
      kind: "ScalarTypeDeclaration",
      name,
      baseType,
      enumValues,
      body,
    };
  }

  parseFunctionDeclaration(): FunctionDeclarationNode {
    this.expectNameValueInsensitive("function", "Expected keyword 'function'");
    const name = this.parseQualifiedName();
    const params = this.parseFunctionParameters();
    const returnSpec = this.parseFunctionReturnSpec();
    const annotations: AnnotationAssignmentNode[] = [];
    let volatility: FunctionVolatilityNode | null = null;
    let body: FunctionBodyNode | null = null;

    if (this.matchNameInsensitive("using")) {
      body = this.parseFunctionUsingClause();
    } else if (this.match("lbrace")) {
      while (!this.check("rbrace") && !this.check("eof")) {
        if (this.isAnnotationAssignmentStart()) {
          annotations.push(this.parseAnnotationAssignment());
          continue;
        }

        if (this.matchNameInsensitive("volatility")) {
          this.expect("assign", "Expected ':=' after volatility");
          volatility = this.parseFunctionVolatility();
          this.expect("semicolon", "Expected ';' after volatility clause");
          continue;
        }

        if (this.matchNameInsensitive("set")) {
          this.expectNameValueInsensitive("volatility", "Expected 'volatility' after 'set'");
          this.expect("assign", "Expected ':=' after set volatility");
          volatility = this.parseFunctionVolatility();
          this.expect("semicolon", "Expected ';' after set volatility clause");
          continue;
        }

        if (this.matchNameInsensitive("using")) {
          body = this.parseFunctionUsingClause();
          this.match("semicolon");
          continue;
        }

        if (this.match("semicolon")) continue;

        this.unexpected("Unsupported function subcommand");
      }
      this.expect("rbrace", "Expected '}' after function block");
    } else {
      this.unexpected("Expected function body using clause or block");
    }

    if (!body) {
      this.unexpected("Function declaration is missing a using clause");
    }

    if (params.some((param) => param.setOf)) {
      this.unexpected("User defined functions cannot declare set of parameters");
    }

    this.match("semicolon");

    return {
      kind: "FunctionDeclaration",
      name,
      params,
      returnType: returnSpec.type,
      returnOptional: returnSpec.optional,
      returnSetOf: returnSpec.setOf,
      volatility,
      annotations,
      body,
    };
  }

  private parseTopLevelDeclaration(): TopLevelDeclarationNode {
    if (this.checkNameInsensitive("scalar") && this.checkNameInsensitive("type", 1)) {
      return this.parseScalarTypeDeclaration();
    }

    if (this.checkNameInsensitive("function")) {
      return this.parseFunctionDeclaration();
    }

    if (this.checkKeyword("abstract") && this.checkKeyword("type", 1)) {
      return this.parseTypeDeclaration();
    }

    if (
      this.checkKeyword("abstract") &&
      (this.checkKeyword("inheritable", 1) || this.checkKeyword("annotation", 1) || this.checkKeyword("annotation", 2))
    ) {
      return this.parseAbstractAnnotation();
    }

    if (this.isConstraintStart()) {
      return this.parseConstraintDeclaration();
    }

    if (this.checkKeyword("type") || (this.checkKeyword("abstract") && this.checkKeyword("type", 1))) {
      return this.parseTypeDeclaration();
    }

    if (this.checkKeyword("alias")) {
      return this.parseAliasDeclaration();
    }

    if (this.checkNameInsensitive("global") || this.checkNameInsensitive("permission")) {
      return this.parseIgnoredDeclaration();
    }

    this.unexpected("Expected top-level declaration");
  }

  private parseIgnoredDeclaration(): IgnoredDeclarationNode {
    this.parseOpaqueUntilSemicolonBalanced();
    this.expect("semicolon", "Expected ';' after declaration");
    return { kind: "IgnoredDeclaration" };
  }

  private parseAliasDeclaration(): AliasDeclarationNode {
    this.expectKeyword("alias");
    const name = this.parseQualifiedName();

    if (this.match("lbrace")) {
      this.expectKeyword("using");
      this.expect("lparen", "Expected '(' after alias using");
      const expr = this.parseOpaqueInBalancedParens();
      this.match("semicolon");
      this.expect("rbrace", "Expected '}' after alias declaration");
      this.match("semicolon");
      return {
        kind: "AliasDeclaration",
        name,
        expr,
      };
    }

    this.expect("assign", "Expected ':=' in alias declaration");
    const expr = this.parseOpaqueUntilSemicolonBalanced();
    this.expect("semicolon", "Expected ';' after alias declaration");
    return {
      kind: "AliasDeclaration",
      name,
      expr,
    };
  }

  private parseTypeBody(): TypeBodyNode {
    const declarations: DeclarationNode[] = [];

    while (!this.check("rbrace") && !this.check("eof")) {
      if (this.match("semicolon")) {
        continue;
      }
      const decl = this.parseDeclaration();
      declarations.push(decl);
    }

    return { kind: "TypeBody", declarations };
  }

  private parseScalarTypeBody(): ScalarTypeBodyNode {
    const annotations: AnnotationAssignmentNode[] = [];
    const constraints: ConstraintDeclarationNode[] = [];

    while (!this.check("rbrace") && !this.check("eof")) {
      if (this.match("semicolon")) {
        continue;
      }

      if (this.isAnnotationAssignmentStart()) {
        annotations.push(this.parseAnnotationAssignment());
        continue;
      }

      if (this.isConstraintStart()) {
        constraints.push(this.parseConstraintDeclaration());
        continue;
      }

      this.unexpected("Expected annotation or constraint declaration in scalar type body");
    }

    return {
      kind: "ScalarTypeBody",
      annotations,
      constraints,
    };
  }

  private parseEnumValues(): string[] {
    this.expect("lt", "Expected '<' for enum declaration");
    const values: string[] = [];

    while (!this.check("gt") && !this.check("eof")) {
      const token = this.current();
      if (token.type === "string") {
        values.push(this.readStringTokenValue(token));
        this.pos += 1;
      } else if (token.type === "identifier" || token.type === "keyword") {
        values.push(token.value);
        this.pos += 1;
      } else {
        throw this.error("Expected enum value", token);
      }

      if (!this.match("comma")) {
        break;
      }
    }

    this.expect("gt", "Expected '>' after enum declaration");
    return values;
  }

  private parseTypeReferenceUntilBoundary(message: string): OpaqueNode {
    const token = this.current();
    if (token.type === "semicolon" || token.type === "lbrace" || token.type === "eof") {
      throw this.error(message, token);
    }

    const start = token.start;
    let end = token.end;
    let angleDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    while (!this.check("eof")) {
      const next = this.current();

      if (next.type === "lt") {
        angleDepth += 1;
        end = next.end;
        this.pos += 1;
        continue;
      }

      if (next.type === "gt") {
        if (angleDepth > 0) {
          angleDepth -= 1;
        }
        end = next.end;
        this.pos += 1;
        continue;
      }

      if (next.type === "lparen") {
        parenDepth += 1;
        end = next.end;
        this.pos += 1;
        continue;
      }

      if (next.type === "rparen") {
        if (parenDepth > 0) {
          parenDepth -= 1;
        }
        end = next.end;
        this.pos += 1;
        continue;
      }

      if (next.type === "lbracket") {
        bracketDepth += 1;
        end = next.end;
        this.pos += 1;
        continue;
      }

      if (next.type === "rbracket") {
        if (bracketDepth > 0) {
          bracketDepth -= 1;
        }
        end = next.end;
        this.pos += 1;
        continue;
      }

      if (
        angleDepth === 0
        && parenDepth === 0
        && bracketDepth === 0
        && (next.type === "semicolon" || next.type === "lbrace")
      ) {
        break;
      }

      end = next.end;
      this.pos += 1;
    }

    return {
      kind: "Opaque",
      text: this.sourceText.slice(start, end).trim(),
    };
  }

  private consumeTypeExpressionRemainder(): void {
    let angleDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    while (!this.check("eof")) {
      const token = this.current();

      if (token.type === "lt") {
        angleDepth += 1;
        this.pos += 1;
        continue;
      }

      if (token.type === "gt") {
        if (angleDepth > 0) {
          angleDepth -= 1;
        }
        this.pos += 1;
        continue;
      }

      if (token.type === "lparen") {
        parenDepth += 1;
        this.pos += 1;
        continue;
      }

      if (token.type === "rparen") {
        if (parenDepth > 0) {
          parenDepth -= 1;
        }
        this.pos += 1;
        continue;
      }

      if (token.type === "lbracket") {
        bracketDepth += 1;
        this.pos += 1;
        continue;
      }

      if (token.type === "rbracket") {
        if (bracketDepth > 0) {
          bracketDepth -= 1;
        }
        this.pos += 1;
        continue;
      }

      if (
        angleDepth === 0
        && parenDepth === 0
        && bracketDepth === 0
        && (token.type === "semicolon" || token.type === "lbrace")
      ) {
        return;
      }

      this.pos += 1;
    }
  }

  private parseDeclaration(): DeclarationNode {
    if (this.isAnnotationAssignmentStart()) return this.parseAnnotationAssignment();
    if (this.isImplicitLinkWithBodyStart()) return this.parseLinkDeclaration();
    if (this.isPropertyStart()) return this.parsePropertyDeclaration();
    if (this.isLinkStart()) return this.parseLinkDeclaration();
    if (this.isConstraintStart()) return this.parseConstraintDeclaration();
    if (this.isIndexStart()) return this.parseIndexDeclaration();

    this.unexpected("Expected annotation, property, link, constraint, or index declaration");
  }

  // -------- annotation --------

  private parseAbstractAnnotation(): AbstractAnnotationNode {
    this.expectKeyword("abstract");
    const inheritable = this.matchKeyword("inheritable");
    this.expectKeyword("annotation");

    const name = this.parseQualifiedName();

    let body: AnnotationBlockNode | null = null;
    if (this.match("lbrace")) {
      const declarations: AnnotationAssignmentNode[] = [];
      while (!this.check("rbrace") && !this.check("eof")) {
        declarations.push(this.parseAnnotationAssignment());
      }
      this.expect("rbrace", "Expected '}' after annotation body");
      body = { kind: "AnnotationBlock", declarations };
    }

    this.match("semicolon");

    return {
      kind: "AbstractAnnotation",
      abstract: true,
      inheritable,
      name,
      body,
    };
  }

  private parseAnnotationAssignment(): AnnotationAssignmentNode {
    this.expectKeyword("annotation");
    const name = this.parseQualifiedName();
    this.expect("assign", "Expected ':=' in annotation assignment");
    const value = this.parseOpaqueUntilSemicolonOrBrace();
    if (!this.match("semicolon") && !this.check("rbrace")) {
      this.expect("semicolon", "Expected ';' after annotation assignment");
    }

    return {
      kind: "AnnotationAssignment",
      name,
      value,
    };
  }

  // -------- property --------

  private parsePropertyDeclaration(): PropertyDeclarationNode {
    const abstract = this.matchKeyword("abstract");
    const overloaded = this.matchKeyword("overloaded");
    const required = this.parseOptionalRequiredOptional();
    const cardinality = this.parseOptionalCardinality();

    const explicitKeyword = this.matchKeyword("property");
    const name = this.parseQualifiedName();

    if (this.match("assign")) {
      const expr = this.parseOpaqueUntilSemicolon();
      this.expect("semicolon", "Expected ';' after computed property");
      return {
        kind: "PropertyDeclaration",
        explicitKeyword,
        abstract,
        overloaded,
        required,
        cardinality,
        name,
        declaredType: null,
        typeExpr: null,
        computed: true,
        expr,
        body: null,
      };
    }

    let declaredType: QualifiedNameNode | null = null;
    let typeExpr: OpaqueNode | null = null;
    if (this.matchPointerTypeSeparator()) {
      typeExpr = this.parseTypeReferenceUntilBoundary("Expected property target type");
      declaredType = opaqueTypeReferenceToQualifiedName(typeExpr);
    } else if (abstract || overloaded || this.check("lbrace")) {
      declaredType = null;
    } else {
      this.unexpected("Expected ':', '->', or ':=' after property name");
    }

    let body: PropertyBodyNode | null = null;
    if (this.match("lbrace")) {
      body = this.parsePropertyBody();
      this.expect("rbrace", "Expected '}' after property body");
      this.match("semicolon");
    } else if (!abstract) {
      this.match("semicolon");
    }

    return {
      kind: "PropertyDeclaration",
      explicitKeyword,
      abstract,
      overloaded,
      required,
      cardinality,
      name,
      declaredType,
      typeExpr,
      computed: false,
      expr: null,
      body,
    };
  }

  private parsePropertyBody(): PropertyBodyNode {
    let using: OpaqueNode | null = null;
    const extending: QualifiedNameNode[] = [];
    let defaultExpr: OpaqueNode | null = null;
    let readonly: boolean | null = null;
    const annotations: AnnotationAssignmentNode[] = [];
    const constraints: ConstraintDeclarationNode[] = [];

    while (!this.check("rbrace") && !this.check("eof")) {
      if (this.match("semicolon")) {
        continue;
      }
      if (this.matchKeyword("using")) {
        this.expect("lparen", "Expected '(' after using");
        using = this.parseOpaqueInBalancedParens();
        this.expect("semicolon", "Expected ';' after using clause");
        continue;
      }

      if (this.matchKeyword("extending")) {
        extending.push(...this.parseNameListTail());
        this.expect("semicolon", "Expected ';' after extending clause");
        continue;
      }

      if (this.matchKeyword("default")) {
        this.expect("assign", "Expected ':=' after default");
        defaultExpr = this.parseOpaqueDefaultExpr();
        if (!this.match("semicolon") && !this.check("rbrace")) {
          this.expect("semicolon", "Expected ';' after default");
        }
        continue;
      }

      if (this.matchKeyword("readonly")) {
        this.expect("assign", "Expected ':=' after readonly");
        if (this.matchNameInsensitive("true")) readonly = true;
        else if (this.matchNameInsensitive("false")) readonly = false;
        else this.unexpected("Expected true or false after readonly :=");
        this.expect("semicolon", "Expected ';' after readonly");
        continue;
      }

      if (this.isAnnotationAssignmentStart()) {
        annotations.push(this.parseAnnotationAssignment());
        continue;
      }

      if (this.isConstraintStart()) {
        constraints.push(this.parseConstraintDeclaration());
        continue;
      }

      if (this.isGenericOptionStart()) {
        this.skipGenericOption();
        continue;
      }

      this.unexpected("Unexpected item in property body");
    }

    return {
      kind: "PropertyBody",
      using,
      extending,
      default: defaultExpr,
      readonly,
      annotations,
      constraints,
    };
  }

  // -------- link --------

  private parseLinkDeclaration(): LinkDeclarationNode {
    const abstract = this.matchKeyword("abstract");
    const overloaded = this.matchKeyword("overloaded");
    const required = this.parseOptionalRequiredOptional();
    const cardinality = this.parseOptionalCardinality();

    const explicitKeyword = this.matchKeyword("link");
    const name = this.parseQualifiedName();

    if (this.match("assign")) {
      const expr = this.parseOpaqueUntilSemicolon();
      this.expect("semicolon", "Expected ';' after computed link");
      return {
        kind: "LinkDeclaration",
        explicitKeyword,
        abstract,
        overloaded,
        required,
        cardinality,
        name,
        declaredType: null,
        targetType: null,
        computed: true,
        expr,
        body: null,
      };
    }

    let declaredType: QualifiedNameNode | null = null;
    let targetType: OpaqueNode | null = null;
    if (this.matchPointerTypeSeparator()) {
      targetType = this.parseTypeReferenceUntilBoundary("Expected link target type");
      declaredType = opaqueTypeReferenceToQualifiedName(targetType);
    } else if (abstract || overloaded) {
      declaredType = null;
    } else {
      this.unexpected("Expected ':', '->', or ':=' after link name");
    }

    let body: LinkBodyNode | null = null;
    if (this.match("lbrace")) {
      body = this.parseLinkBody();
      this.expect("rbrace", "Expected '}' after link body");
      this.match("semicolon");
    } else if (!abstract) {
      this.match("semicolon");
    }

    return {
      kind: "LinkDeclaration",
      explicitKeyword,
      abstract,
      overloaded,
      required,
      cardinality,
      name,
      declaredType,
      targetType,
      computed: false,
      expr: null,
      body,
    };
  }

  private parseLinkBody(): LinkBodyNode {
    let using: OpaqueNode | null = null;
    const extending: QualifiedNameNode[] = [];
    let defaultExpr: OpaqueNode | null = null;
    let readonly: boolean | null = null;
    let onTargetDelete: string | null = null;
    let onSourceDelete: string | null = null;
    const annotations: AnnotationAssignmentNode[] = [];
    const properties: PropertyDeclarationNode[] = [];
    const constraints: ConstraintDeclarationNode[] = [];
    const indexes: IndexDeclarationNode[] = [];

    while (!this.check("rbrace") && !this.check("eof")) {
      if (this.match("semicolon")) {
        continue;
      }
      if (this.matchKeyword("using")) {
        this.expect("lparen", "Expected '(' after using");
        using = this.parseOpaqueInBalancedParens();
        this.expect("semicolon", "Expected ';' after using clause");
        continue;
      }

      if (this.matchKeyword("extending")) {
        extending.push(...this.parseNameListTail());
        this.expect("semicolon", "Expected ';' after extending clause");
        continue;
      }

      if (this.matchKeyword("default")) {
        this.expect("assign", "Expected ':=' after default");
        defaultExpr = this.parseOpaqueDefaultExpr();
        if (!this.match("semicolon") && !this.check("rbrace")) {
          this.expect("semicolon", "Expected ';' after default");
        }
        continue;
      }

      if (this.matchKeyword("readonly")) {
        this.expect("assign", "Expected ':=' after readonly");
        if (this.matchNameInsensitive("true")) readonly = true;
        else if (this.matchNameInsensitive("false")) readonly = false;
        else this.unexpected("Expected true or false after readonly :=");
        this.expect("semicolon", "Expected ';' after readonly");
        continue;
      }

      if (this.checkKeyword("on")) {
        const deleteAction = this.parseOnDeleteClause();
        if (deleteAction.which === "target") onTargetDelete = deleteAction.action;
        else onSourceDelete = deleteAction.action;
        continue;
      }

      if (this.isAnnotationAssignmentStart()) {
        annotations.push(this.parseAnnotationAssignment());
        continue;
      }

      if (this.isPropertyStart()) {
        properties.push(this.parsePropertyDeclaration());
        continue;
      }

      if (this.isConstraintStart()) {
        constraints.push(this.parseConstraintDeclaration());
        continue;
      }

      if (this.isIndexStart()) {
        indexes.push(this.parseIndexDeclaration());
        continue;
      }

      this.unexpected("Unexpected item in link body");
    }

    return {
      kind: "LinkBody",
      using,
      extending,
      default: defaultExpr,
      readonly,
      onTargetDelete,
      onSourceDelete,
      annotations,
      properties,
      constraints,
      indexes,
    };
  }

  private parseOnDeleteClause(): { which: "target" | "source"; action: string } {
    this.expectKeyword("on");

    let which: "target" | "source";
    if (this.matchKeyword("target")) which = "target";
    else if (this.matchKeyword("source")) which = "source";
    else this.unexpected("Expected 'target' or 'source' after 'on'");

    this.expectKeyword("delete");

    const start = this.current().start;
    while (!this.check("semicolon") && !this.check("eof")) {
      this.pos++;
    }
    const end = this.current().start;

    this.expect("semicolon", "Expected ';' after on ... delete clause");

    return {
      which,
      action: this.sourceText.slice(start, end).trim(),
    };
  }

  // -------- constraint --------

  private parseConstraintDeclaration(): ConstraintDeclarationNode {
    const abstract = this.matchKeyword("abstract");
    const delegated = this.matchKeyword("delegated");

    this.expectKeyword("constraint");
    const name = this.parseQualifiedName();

    const args: ConstraintArgNode[] = [];
    if (this.match("lparen")) {
      if (!this.check("rparen")) {
        do {
          args.push(this.parseConstraintArg());
        } while (this.match("comma"));
      }
      this.expect("rparen", "Expected ')' after constraint argument list");
    }

    let onExpr: OpaqueNode | null = null;
    if (this.matchKeyword("on")) {
      this.expect("lparen", "Expected '(' after on");
      onExpr = this.parseOpaqueInBalancedParens();
    }

    let exceptExpr: OpaqueNode | null = null;
    if (this.matchKeyword("except")) {
      this.expect("lparen", "Expected '(' after except");
      exceptExpr = this.parseOpaqueInBalancedParens();
    }

    const extending = this.parseOptionalExtendingList();

    let using: OpaqueNode | null = null;
    let errmessage: OpaqueNode | null = null;
    const annotations: AnnotationAssignmentNode[] = [];

    if (this.match("lbrace")) {
      while (!this.check("rbrace") && !this.check("eof")) {
        if (this.match("semicolon")) {
          continue;
        }

        if (this.matchKeyword("using")) {
          using = this.parseOpaqueUntilSemicolon();
          this.expect("semicolon", "Expected ';' after using clause");
          continue;
        }

        if (this.matchKeyword("errmessage")) {
          this.expect("assign", "Expected ':=' after errmessage");
          errmessage = this.parseOpaqueUntilSemicolon();
          this.expect("semicolon", "Expected ';' after errmessage");
          continue;
        }

        if (this.isAnnotationAssignmentStart()) {
          annotations.push(this.parseAnnotationAssignment());
          continue;
        }

        // ignore additional future items for now by consuming one statement
        const opaque = this.parseOpaqueUntilSemicolonOrBrace();
        if (opaque.text.length > 0 && this.match("semicolon")) {
          continue;
        }

        this.unexpected("Unexpected item in constraint body");
      }

      this.expect("rbrace", "Expected '}' after constraint body");
      this.match("semicolon");
    } else if (!this.match("semicolon") && !this.check("rbrace")) {
      this.expect("semicolon", "Expected ';' after constraint declaration");
    }

    return {
      kind: "ConstraintDeclaration",
      abstract,
      delegated,
      name,
      args,
      onExpr,
      exceptExpr,
      extending,
      using,
      errmessage,
      annotations,
    };
  }

  private parseConstraintArg(): ConstraintArgNode {
    if (
      (this.check("identifier") || this.check("keyword")) &&
      this.peekType(1) === "colon"
    ) {
      const name = this.current().value;
      this.pos++;
      this.expect("colon", "Expected ':' after argument name");
      return {
        kind: "ConstraintArg",
        name,
        value: this.parseOpaqueUntilCommaOrRParen(),
      };
    }

    return {
      kind: "ConstraintArg",
      name: null,
      value: this.parseOpaqueUntilCommaOrRParen(),
    };
  }

  // -------- index --------

  private parseIndexDeclaration(): IndexDeclarationNode {
    this.expectKeyword("index");
    const start = this.previous().end;
    while (!this.check("semicolon") && !this.check("eof")) {
      this.pos++;
    }
    const end = this.current().start;
    this.expect("semicolon", "Expected ';' after index declaration");

    return {
      kind: "IndexDeclaration",
      content: {
        kind: "Opaque",
        text: this.sourceText.slice(start, end).trim(),
      },
    };
  }

  // -------- function --------

  private parseFunctionParameters(): FunctionParamNode[] {
    this.expect("lparen", "Expected '(' before function parameter list");
    const params: FunctionParamNode[] = [];
    let sawVariadicOrNamedOnly = false;

    while (!this.match("rparen")) {
      let namedOnly = false;
      let variadic = false;
      if (this.matchNameInsensitive("named")) {
        this.expectNameValueInsensitive("only", "Expected 'only' after 'named'");
        namedOnly = true;
        sawVariadicOrNamedOnly = true;
      } else if (this.matchNameInsensitive("variadic")) {
        variadic = true;
        sawVariadicOrNamedOnly = true;
      } else if (sawVariadicOrNamedOnly) {
        this.unexpected("Positional arguments cannot follow variadic or named only arguments");
      }

      const name = this.expectName("Expected function parameter name").value;
      this.expect("colon", "Expected ':' in function parameter");

      let optional = false;
      let setOf = false;
      if (this.matchNameInsensitive("optional")) {
        optional = true;
      } else if (this.matchNameInsensitive("set")) {
        this.expectNameValueInsensitive("of", "Expected 'of' after 'set'");
        setOf = true;
      }

      const type = this.parseFunctionTypeRef();
      let defaultExpr: OpaqueNode | null = null;
      if (this.match("equal")) {
        if (variadic) {
          this.unexpected("Variadic parameters cannot have a default value");
        }
        defaultExpr = this.parseOpaqueUntilCommaOrRParen();
      }

      params.push({
        name,
        type,
        optional,
        setOf,
        variadic,
        namedOnly,
        defaultExpr,
      });

      if (!this.match("comma")) {
        this.expect("rparen", "Expected ')' after function parameters");
        break;
      }
    }

    return params;
  }

  private parseFunctionTypeRef(): string {
    if (this.matchNameInsensitive("array")) {
      this.expect("lt", "Expected '<' after array");
      const inner = this.parseQualifiedNameText("Expected array inner type");
      this.expect("gt", "Expected '>' after array type");
      return `array<${inner}>`;
    }

    return this.parseQualifiedNameText("Expected function type");
  }

  private parseFunctionReturnSpec(): { type: string; optional: boolean; setOf: boolean } {
    this.expect("arrow", "Expected '->' in function declaration");
    let optional = false;
    let setOf = false;
    if (this.matchNameInsensitive("optional")) {
      optional = true;
    } else if (this.matchNameInsensitive("set")) {
      this.expectNameValueInsensitive("of", "Expected 'of' after 'set'");
      setOf = true;
    }

    return {
      type: this.parseFunctionTypeRef(),
      optional,
      setOf,
    };
  }

  private parseFunctionUsingClause(): FunctionBodyNode {
    if (this.match("lparen")) {
      const body = this.parseOpaqueInBalancedParens();
      return {
        kind: "FunctionBody",
        language: "edgeql",
        text: body.text,
      };
    }

    const language = this.expectName("Expected function language after using").value;
    if (language.toLowerCase() !== "edgeql") {
      this.unexpected(`Unsupported function language '${language}'`);
    }

    const textToken = this.expect("string", "Expected function body string");
    const text = this.readStringTokenValue(textToken);
    return {
      kind: "FunctionBody",
      language: "edgeql",
      text,
    };
  }

  private parseFunctionVolatility(): FunctionVolatilityNode {
    const token = this.current();
    let value: string;
    if (token.type === "string") {
      value = this.readStringTokenValue(token);
      this.pos += 1;
    } else {
      value = this.expectName("Expected function volatility").value;
    }

    const normalized = value.toLowerCase();
    if (normalized === "immutable") {
      return "Immutable";
    }
    if (normalized === "stable") {
      return "Stable";
    }
    if (normalized === "volatile") {
      return "Volatile";
    }
    if (normalized === "modifying") {
      return "Modifying";
    }

    this.unexpected(`Unsupported function volatility '${value}'`);
  }

  // -------- opaque parsing helpers --------

  private parseOpaqueUntilSemicolon(): OpaqueNode {
    const start = this.current().start;
    while (!this.check("semicolon") && !this.check("eof")) {
      this.pos++;
    }
    const end = this.current().start;
    return { kind: "Opaque", text: this.sourceText.slice(start, end).trim() };
  }

  private parseOpaqueUntilSemicolonBalanced(): OpaqueNode {
    const start = this.current().start;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;

    while (!this.check("eof")) {
      if (this.check("lparen")) {
        parenDepth += 1;
        this.pos += 1;
        continue;
      }
      if (this.check("rparen")) {
        if (parenDepth > 0) {
          parenDepth -= 1;
        }
        this.pos += 1;
        continue;
      }
      if (this.check("lbrace")) {
        braceDepth += 1;
        this.pos += 1;
        continue;
      }
      if (this.check("rbrace")) {
        if (braceDepth > 0) {
          braceDepth -= 1;
        }
        this.pos += 1;
        continue;
      }
      if (this.check("lbracket")) {
        bracketDepth += 1;
        this.pos += 1;
        continue;
      }
      if (this.check("rbracket")) {
        if (bracketDepth > 0) {
          bracketDepth -= 1;
        }
        this.pos += 1;
        continue;
      }

      if (this.check("semicolon") && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
        break;
      }

      this.pos += 1;
    }

    const end = this.current().start;
    return { kind: "Opaque", text: this.sourceText.slice(start, end).trim() };
  }

  private parseOpaqueDefaultExpr(): OpaqueNode {
    const start = this.current().start;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;

    while (!this.check("eof")) {
      if (this.check("lparen")) {
        parenDepth += 1;
        this.pos += 1;
        continue;
      }
      if (this.check("rparen")) {
        if (parenDepth === 0) break;
        parenDepth -= 1;
        this.pos += 1;
        continue;
      }
      if (this.check("lbrace")) {
        braceDepth += 1;
        this.pos += 1;
        continue;
      }
      if (this.check("rbrace")) {
        if (braceDepth === 0) break;
        braceDepth -= 1;
        this.pos += 1;
        continue;
      }
      if (this.check("lbracket")) {
        bracketDepth += 1;
        this.pos += 1;
        continue;
      }
      if (this.check("rbracket")) {
        if (bracketDepth === 0) break;
        bracketDepth -= 1;
        this.pos += 1;
        continue;
      }

      if (this.check("semicolon") && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
        break;
      }

      this.pos += 1;
    }

    const end = this.current().start;
    return { kind: "Opaque", text: this.sourceText.slice(start, end).trim() };
  }

  private parseOpaqueUntilSemicolonOrBrace(): OpaqueNode {
    const start = this.current().start;
    while (!this.check("semicolon") && !this.check("rbrace") && !this.check("eof")) {
      this.pos++;
    }
    const end = this.current().start;
    return { kind: "Opaque", text: this.sourceText.slice(start, end).trim() };
  }

  private parseOpaqueUntilCommaOrRParen(): OpaqueNode {
    const start = this.current().start;
    let depth = 0;

    while (!this.check("eof")) {
      if (this.check("lparen")) {
        depth++;
        this.pos++;
        continue;
      }
      if (this.check("rparen")) {
        if (depth === 0) break;
        depth--;
        this.pos++;
        continue;
      }
      if (this.check("comma") && depth === 0) break;
      this.pos++;
    }

    const end = this.current().start;
    return { kind: "Opaque", text: this.sourceText.slice(start, end).trim() };
  }

  private parseOpaqueInBalancedParens(): OpaqueNode {
    const startToken = this.previous(); // lparen already consumed
    const contentStart = startToken.end;

    let depth = 1;
    while (!this.check("eof")) {
      if (this.match("lparen")) {
        depth++;
        continue;
      }
      if (this.match("rparen")) {
        depth--;
        if (depth === 0) {
          const contentEnd = this.previous().start;
          return {
            kind: "Opaque",
            text: this.sourceText.slice(contentStart, contentEnd).trim(),
          };
        }
        continue;
      }
      this.pos++;
    }

    this.unexpected("Unterminated parenthesized expression");
  }

  // -------- start detection --------

  private isAnnotationAssignmentStart(): boolean {
    return this.checkKeyword("annotation");
  }

  private isGenericOptionStart(): boolean {
    let i = 0;
    while (this.peekType(i) === "identifier" || this.peekType(i) === "keyword") {
      i += 1;
      if (this.peekType(i) !== "colon2") break;
      i += 1;
    }
    if (i === 0) return false;
    return this.peekType(i) === "assign";
  }

  private skipGenericOption(): void {
    this.parseQualifiedName();
    this.expect("assign", "Expected ':=' in option assignment");
    this.parseOpaqueUntilSemicolonOrBrace();
    if (!this.match("semicolon") && !this.check("rbrace")) {
      this.expect("semicolon", "Expected ';' after option assignment");
    }
  }

  private isPropertyStart(): boolean {
    let i = 0;
    if (this.checkKeyword("abstract", i)) i++;
    if (this.checkKeyword("overloaded", i)) i++;
    if (this.checkKeyword("required", i) || this.checkKeyword("optional", i)) i++;
    if (this.checkKeyword("single", i) || this.checkKeyword("multi", i)) i++;
    return this.checkKeyword("property", i) || this.peekType(i) === "identifier";
  }

  private isImplicitLinkWithBodyStart(): boolean {
    let i = 0;
    if (this.checkKeyword("abstract", i)) i++;
    if (this.checkKeyword("overloaded", i)) i++;
    if (this.checkKeyword("required", i) || this.checkKeyword("optional", i)) i++;
    if (this.checkKeyword("single", i) || this.checkKeyword("multi", i)) i++;

    if (this.checkKeyword("property", i) || this.checkKeyword("link", i) || this.peekType(i) !== "identifier") {
      return false;
    }

    i += 1;
    while (this.peekType(i) === "colon2") {
      i += 1;
      if (this.peekType(i) !== "identifier" && this.peekType(i) !== "keyword") {
        return false;
      }
      i += 1;
    }

    if (this.peekType(i) !== "colon" && this.peekType(i) !== "arrow") {
      return false;
    }

    const bodyStart = this.findDeclarationBodyStart(i + 1);
    if (bodyStart === null) {
      return false;
    }

    return this.isLinkBodyOnlyStart(bodyStart + 1);
  }

  private findDeclarationBodyStart(startOffset: number): number | null {
    let angleDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let i = startOffset; ; i += 1) {
      const token = this.tokens[this.pos + i];
      if (!token || token.type === "eof" || token.type === "semicolon") {
        return null;
      }

      if (token.type === "lt") {
        angleDepth += 1;
        continue;
      }
      if (token.type === "gt") {
        if (angleDepth > 0) angleDepth -= 1;
        continue;
      }
      if (token.type === "lparen") {
        parenDepth += 1;
        continue;
      }
      if (token.type === "rparen") {
        if (parenDepth > 0) parenDepth -= 1;
        continue;
      }
      if (token.type === "lbracket") {
        bracketDepth += 1;
        continue;
      }
      if (token.type === "rbracket") {
        if (bracketDepth > 0) bracketDepth -= 1;
        continue;
      }

      if (angleDepth === 0 && parenDepth === 0 && bracketDepth === 0 && token.type === "lbrace") {
        return i;
      }
    }
  }

  private isLinkBodyOnlyStart(bodyOffset: number): boolean {
    let i = bodyOffset;
    while (this.peekType(i) === "semicolon") {
      i += 1;
    }

    return this.checkKeyword("on", i)
      || this.checkKeyword("index", i)
      || this.isNestedPointerDeclAt(i);
  }

  private isNestedPointerDeclAt(offset: number): boolean {
    let i = offset;
    if (this.checkKeyword("abstract", i)) i += 1;
    if (this.checkKeyword("overloaded", i)) i += 1;
    if (this.checkKeyword("required", i) || this.checkKeyword("optional", i)) i += 1;
    if (this.checkKeyword("single", i) || this.checkKeyword("multi", i)) i += 1;

    if (this.checkKeyword("property", i) || this.checkKeyword("link", i)) {
      const headType = this.peekType(i + 1);
      return headType === "identifier" || headType === "keyword";
    }

    if (this.peekType(i) !== "identifier") {
      return false;
    }
    i += 1;
    while (this.peekType(i) === "colon2") {
      i += 1;
      const next = this.peekType(i);
      if (next !== "identifier" && next !== "keyword") {
        return false;
      }
      i += 1;
    }
    return this.peekType(i) === "colon" || this.peekType(i) === "arrow";
  }

  private isPropertyStartAt(offset: number): boolean {
    let i = offset;
    if (this.checkKeyword("abstract", i)) i++;
    if (this.checkKeyword("overloaded", i)) i++;
    if (this.checkKeyword("required", i) || this.checkKeyword("optional", i)) i++;
    if (this.checkKeyword("single", i) || this.checkKeyword("multi", i)) i++;
    return this.checkKeyword("property", i) || this.peekType(i) === "identifier";
  }

  private isLinkStart(): boolean {
    let i = 0;
    if (this.checkKeyword("abstract", i)) i++;
    if (this.checkKeyword("overloaded", i)) i++;
    if (this.checkKeyword("required", i) || this.checkKeyword("optional", i)) i++;
    if (this.checkKeyword("single", i) || this.checkKeyword("multi", i)) i++;
    return this.checkKeyword("link", i);
  }

  private isConstraintStart(): boolean {
    let i = 0;
    if (this.checkKeyword("abstract", i) || this.checkKeyword("delegated", i)) i++;
    return this.checkKeyword("constraint", i);
  }

  private isIndexStart(): boolean {
    return this.checkKeyword("index");
  }

  // -------- shared pieces --------

  private matchPointerTypeSeparator(): boolean {
    if (this.match("colon")) {
      return true;
    }

    if (this.check("arrow")) {
      const token = this.current();
      if (!this.options.legacySyntaxCompat) {
        throw this.error(
          "Legacy pointer type separator '->' is disabled; use ':' for pointer type annotations",
          token,
        );
      }
      this.pos += 1;
      return true;
    }

    return false;
  }

  private parseOptionalRequiredOptional(): boolean | null {
    if (this.matchKeyword("required")) return true;
    if (this.matchKeyword("optional")) return false;
    return null;
  }

  private parseOptionalCardinality(): "single" | "multi" | null {
    if (this.matchKeyword("single")) return "single";
    if (this.matchKeyword("multi")) return "multi";
    return null;
  }

  private parseOptionalExtendingList(): QualifiedNameNode[] {
    if (!this.matchKeyword("extending")) return [];
    return this.parseNameListTail();
  }

  private parseNameListTail(): QualifiedNameNode[] {
    const names = [this.parseQualifiedName()];
    while (this.match("comma")) {
      names.push(this.parseQualifiedName());
    }
    return names;
  }

  private parseQualifiedName(): QualifiedNameNode {
    const parts: string[] = [];
    parts.push(this.expectName("Expected name").value);

    while (this.match("colon2")) {
      parts.push(this.expectName("Expected name after '::'").value);
    }

    return { kind: "QualifiedName", parts };
  }

  private parseQualifiedNameText(message: string): string {
    const parts: string[] = [];
    parts.push(this.expectName(message).value);

    while (this.match("colon2")) {
      parts.push(this.expectName("Expected name after '::'").value);
    }

    return parts.join("::");
  }

  private expectName(message: string): Token {
    const token = this.current();
    if (token.type !== "identifier" && token.type !== "keyword") {
      throw this.error(message, token);
    }
    this.pos++;
    return token;
  }

  private expectNameValue(value: string, message: string): Token {
    const token = this.current();
    if ((token.type !== "identifier" && token.type !== "keyword") || token.value !== value) {
      throw this.error(message, token);
    }
    this.pos += 1;
    return token;
  }

  private expectNameValueInsensitive(value: string, message: string): Token {
    const token = this.current();
    if ((token.type !== "identifier" && token.type !== "keyword") || token.value.toLowerCase() !== value.toLowerCase()) {
      throw this.error(message, token);
    }
    this.pos += 1;
    return token;
  }

  private readStringTokenValue(token: Token): string {
    if (token.type !== "string") {
      throw this.error("Expected string token", token);
    }

    const raw = token.value;
    if (raw.length < 2) {
      return "";
    }
    const quote = raw[0];
    if ((quote !== "'" && quote !== '"') || raw[raw.length - 1] !== quote) {
      return raw;
    }

    let out = "";
    for (let i = 1; i < raw.length - 1; i += 1) {
      const ch = raw[i];
      if (ch === "\\" && i + 1 < raw.length - 1) {
        out += raw[i + 1];
        i += 1;
        continue;
      }
      out += ch;
    }

    return out;
  }

  // -------- token helpers --------

  private current(): Token {
    return this.tokens[this.pos];
  }

  private previous(): Token {
    return this.tokens[this.pos - 1];
  }

  private peekType(offset = 0): TokenType {
    return this.tokens[this.pos + offset]?.type ?? "eof";
  }

  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  private match(type: TokenType): boolean {
    if (this.check(type)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private checkKeyword(value: string, offset = 0): boolean {
    const token = this.tokens[this.pos + offset];
    return !!token && token.type === "keyword" && token.value === value;
  }

  private checkName(value: string, offset = 0): boolean {
    const token = this.tokens[this.pos + offset];
    return !!token && (token.type === "identifier" || token.type === "keyword") && token.value === value;
  }

  private checkNameInsensitive(value: string, offset = 0): boolean {
    const token = this.tokens[this.pos + offset];
    return !!token
      && (token.type === "identifier" || token.type === "keyword")
      && token.value.toLowerCase() === value.toLowerCase();
  }

  private matchKeyword(value: string): boolean {
    if (this.checkKeyword(value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private matchName(value: string): boolean {
    if (this.checkName(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private matchNameInsensitive(value: string): boolean {
    if (this.checkNameInsensitive(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expect(type: TokenType, message: string): Token {
    const token = this.current();
    if (token.type !== type) {
      throw this.error(message, token);
    }
    this.pos++;
    return token;
  }

  private expectKeyword(value: string): Token {
    const token = this.current();
    if (token.type !== "keyword" || token.value !== value) {
      throw this.error(`Expected keyword '${value}'`, token);
    }
    this.pos++;
    return token;
  }

  private error(message: string, token: Token): SyntaxError {
    return new SyntaxError(
      `${message}. Found '${token.value || token.type}' at ${token.line}:${token.column}`
    );
  }

  private unexpected(message: string): never {
    throw this.error(message, this.current());
  }
}

// ---------------- API ----------------

export function tokenize(input: string): Token[] {
  return new Tokenizer(input).tokenize();
}

export function parseDocument(input: string, options: ParseOptions = {}): DocumentNode {
  const tokens = tokenize(input);
  return new Parser(tokens, input, options).parseDocument();
}

export function parseTypeDeclaration(input: string, options: ParseOptions = {}): TypeDeclarationNode {
  const tokens = tokenize(input);
  const parser = new Parser(tokens, input, options);
  const node = parser.parseTypeDeclaration();
  parser["expect"]("eof", "Unexpected trailing tokens");
  return node;
}
