import { AppError } from "../errors.js";
import type { ScalarType, ScalarValue } from "../types.js";
import type {
  BacklinkExpr,
  ClauseChain,
  ComputedExpr,
  DeleteStatement,
  DDLStatement,
  ConfigureStatement,
  FilterExpr,
  ForStatement,
  FunctionCallArgExpr,
  FunctionCallExpr,
  FreeObjectExpr,
  GroupByAtom,
  GroupByElement,
  GroupExpr,
  GroupStatement,
  GroupUsingBinding,
  InsertConflict,
  InsertValue,
  InsertStatement,
  OrderExpr,
  OrderExprChain,
  SelectExprStatement,
  SelectFreeStatement,
  SelectStatement,
  ShapeElement,
  Statement,
  TransactionStatement,
  TupleLiteralElementValue,
  TupleLiteralValue,
  TypeExpr,
  UpdateStatement,
  WithBinding,
  WithBindingValue,
  WithModuleAlias,
  PathStep,
  ShapeElementModifiers,
} from "./ast.js";
import { simpleTypeName } from "./ast.js";
import type { Token } from "./tokenizer.js";
import { tokenize } from "./tokenizer.js";

interface ParseContext {
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
}

interface ParseCheckpoint {
  index: number;
}

export interface ParseEdgeQLOptions {
  defaultModule?: string;
}

type ParsedLiteralValue = ScalarValue | ParsedLiteralValue[];

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private readonly localBindings: string[] = [];
  private readonly defaultModule?: string;

  constructor(input: string, options: ParseEdgeQLOptions = {}) {
    this.tokens = tokenize(input);
    this.defaultModule = options.defaultModule;
  }

  private parseDelimited<T>(
    endKind: Token["kind"],
    parseItem: () => T,
    commaMessage: string,
  ): T[] {
    const items: T[] = [];
    while (this.peek().kind !== endKind) {
      items.push(parseItem());
      if (this.peek().kind !== endKind) {
        this.expect("comma", commaMessage);
      }
    }
    return items;
  }

  private withLocalBinding<T>(name: string, fn: () => T): T {
    this.localBindings.push(name);
    try {
      return fn();
    } finally {
      this.localBindings.pop();
    }
  }

  private checkpoint(): ParseCheckpoint {
    return { index: this.index };
  }

  private restore(checkpoint: ParseCheckpoint): void {
    this.index = checkpoint.index;
  }

  private attempt<T>(fn: () => T | undefined): T | undefined {
    const checkpoint = this.checkpoint();
    try {
      const result = fn();
      if (result === undefined) {
        this.restore(checkpoint);
      }
      return result;
    } catch {
      this.restore(checkpoint);
      return undefined;
    }
  }

  private atFunctionCall(): boolean {
    return this.isNameToken(this.peek()) && this.kindAfterQualifiedName() === "lparen";
  }

  private atQualifiedIdentifier(): boolean {
    if (!this.isNameToken(this.peek()) || this.kindAfterQualifiedName() !== "dot") {
      return false;
    }
    return this.isNameToken(this.tokenAfterQualifiedNameAndDot());
  }

  private tokenAfterQualifiedNameAndDot(): Token {
    let i = this.index + 1;
    while (true) {
      if (this.tokens[i]?.kind === "coloncolon" && this.tokens[i + 1] && this.isNameToken(this.tokens[i + 1]!)) {
        i += 2;
        continue;
      }
      if (this.tokens[i]?.kind === "colon" && this.tokens[i + 1]?.kind === "colon" && this.tokens[i + 2] && this.isNameToken(this.tokens[i + 2]!)) {
        i += 3;
        continue;
      }
      break;
    }
    if (this.tokens[i]?.kind === "dot") {
      return this.tokens[i + 1] ?? this.tokens[this.tokens.length - 1]!;
    }
    return this.tokens[i] ?? this.tokens[this.tokens.length - 1]!;
  }

  private atDotField(): boolean {
    return this.peek().kind === "dot" && this.isNameToken(this.peekNext());
  }

  private atBacklink(): boolean {
    return this.peek().kind === "backward_link" || (this.peek().kind === "dot" && this.peekNext().kind === "lt");
  }

  private isNameToken(token: Token): boolean {
    return token.kind === "identifier"
      || token.kind === "backtick_name"
      || token.kind === "kw_object"
      || token.kind === "kw_named"
      || token.kind === "kw_unreserved"
      || token.kind === "kw_partial_reserved"
      || token.kind === "kw_future_reserved"
      || token.kind === "kw_current_reserved"
      || token.kind.startsWith("kw_current_reserved_");
  }

  private nameTokenLexeme(token: Token): string {
    return token.kind === "kw_object" ? "Object" : token.lexeme;
  }

  private expectName(message: string): Token {
    const token = this.peek();
    if (!this.isNameToken(token)) {
      throw new AppError("E_SYNTAX", message, token.line, token.column);
    }
    this.index += 1;
    return { ...token, lexeme: this.nameTokenLexeme(token) };
  }

  private atParenthesizedSelect(): boolean {
    return this.peek().kind === "lparen" && (this.peekNext().kind === "kw_select" || this.peekNext().kind === "kw_with");
  }

  private atInlineTypedSelect(): boolean {
    if (!this.isNameToken(this.peek())) {
      return false;
    }

    const nextKind = this.kindAfterQualifiedName();
    return nextKind === "lbrace" || nextKind === "kw_filter" || nextKind === "kw_limit" || nextKind === "kw_offset";
  }

  private isExistsToken(token: Token): boolean {
    return (this.isNameToken(token) || token.kind === "kw_exists") && token.lexeme.toLowerCase() === "exists";
  }

  private isEnumLikeName(name: string): boolean {
    return name.toLowerCase().includes("enum");
  }

  private qualifiedNameLeaf(name: string): string {
    const divider = name.lastIndexOf("::");
    return divider >= 0 ? name.slice(divider + 2) : name;
  }

  private isTypeLikeName(name: string): boolean {
    const first = this.qualifiedNameLeaf(name)[0];
    return first !== undefined && first >= "A" && first <= "Z";
  }

  private isIntegerLexeme(value: string): boolean {
    const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
    const clean = normalized.replace(/_/g, "");
    if (clean.length === 0) {
      return false;
    }
    for (const ch of clean) {
      if (ch < "0" || ch > "9") {
        return false;
      }
    }
    return true;
  }

  private parseNumberLexeme(value: string): number {
    const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
    return Number(normalized.replace(/_/g, ""));
  }

  private buildIndexAccessExpr(expr: FreeObjectExpr, indexLexeme: string): FreeObjectExpr {
    const normalized = indexLexeme.endsWith("n") ? indexLexeme.slice(0, -1) : indexLexeme;
    return normalized.split(".").reduce<FreeObjectExpr>((current, part) => ({
      kind: "index_access",
      expr: current,
      index: Number(part.replace(/_/g, "")),
    }), expr);
  }

  private parseParameterLexeme(value: string): string {
    const raw = value.startsWith("$") ? value.slice(1) : value;
    return raw.replace(/^`|`$/g, "");
  }

  private parseParameterWithTypeLexeme(value: string): { name: string; castType: string } {
    const split = value.indexOf("$");
    const castType = value.slice(1, split - 1);
    const name = this.parseParameterLexeme(value.slice(split));
    return { name, castType };
  }

  private isGlobalReservedToken(token: Token): boolean {
    return token.kind.startsWith("kw_current_reserved_");
  }

  private parseQualifiedName(message: string): string {
    const parts = [this.expectName(message).lexeme];
    while (this.peek().kind === "coloncolon") {
      this.consume();
      parts.push(this.expectName("Expected identifier after '::'").lexeme);
    }

    while (this.peek().kind === "colon" && this.peekNext().kind === "colon") {
      this.consume();
      this.consume();
      parts.push(this.expectName("Expected identifier after '::'").lexeme);
    }

    return parts.join("::");
  }

  // Parses a (possibly parametric) type used in cast position: handles
  // `str`, `std::int64`, `array<str>`, `tuple<int64, str>`, `tuple<tuple<...>, ...>`.
  private parseCastTypeName(message: string): string {
    const head = this.parseQualifiedName(message);
    if (this.peek().kind !== "lt") {
      return head;
    }
    this.consume();
    const args: string[] = [];
    args.push(this.parseCastTypeName("Expected type argument"));
    while (this.peek().kind === "comma") {
      this.consume();
      args.push(this.parseCastTypeName("Expected type argument"));
    }
    this.expect("gt", `Expected '>' to close ${head}<...>`);
    return `${head}<${args.join(", ")}>`;
  }

  private kindAfterQualifiedName(): Token["kind"] {
    if (!this.isNameToken(this.peek())) {
      return this.peek().kind;
    }

    let i = this.index + 1;
    while (true) {
      if (this.tokens[i]?.kind === "coloncolon" && this.tokens[i + 1] && this.isNameToken(this.tokens[i + 1]!)) {
        i += 2;
        continue;
      }
      if (this.tokens[i]?.kind === "colon" && this.tokens[i + 1]?.kind === "colon" && this.tokens[i + 2] && this.isNameToken(this.tokens[i + 2]!)) {
        i += 3;
        continue;
      }
      break;
    }

    return (this.tokens[i]?.kind ?? "eof") as Token["kind"];
  }

  private parseQualifiedIdentifier(
    headMessage: string,
    tailMessage: string,
  ): { head: string; tail: string } {
    const head = this.parseQualifiedName(headMessage);
    this.expect("dot", "Expected '.' in qualified identifier");
    const tail = this.expectName(tailMessage).lexeme;
    return { head, tail };
  }

  private parseParenthesizedSelectQuery(
    selectMessage: string,
    rparenMessage: string,
  ): { kind: "select"; typeName: string; shape: ShapeElement[]; clauses: ClauseChain } {
    this.expect("lparen", "Expected '(' before select subquery");
    const withClause = this.peek().kind === "kw_with" ? this.parseWithClause() : undefined;
    this.expect("kw_select", selectMessage);
    const nested = this.parseInlineSelectExpr();
    if (withClause) {
      nested.clauses = {
        ...nested.clauses,
        _withBindings: withClause.with,
        _withModule: withClause.withModule,
        _withModuleAliases: withClause.withModuleAliases,
      };
    }
    this.expect("rparen", rparenMessage);
    return nested;
  }

  private functionCallExpr(call: FunctionCallExpr): { kind: "function_call"; call: FunctionCallExpr } {
    return { kind: "function_call", call };
  }

  private withContext(ctx: ParseContext): ParseContext {
    return {
      with: ctx.with,
      withModule: ctx.withModule,
      withModuleAliases: ctx.withModuleAliases,
    };
  }

  private inlineSelectToStatement(
    start: Token,
    ctx: ParseContext,
    nested: { kind: "select"; typeName: string; shape: ShapeElement[]; clauses: ClauseChain },
  ): SelectStatement {
    return {
      ...this.withContext(ctx),
      kind: "select",
      typeName: nested.typeName,
      shape: nested.shape,
      fields: [],
      filter: nested.clauses.filter,
      orderBy: nested.clauses.orderBy,
      limit: nested.clauses.limit,
      offset: nested.clauses.offset,
      pos: { line: start.line, column: start.column },
    };
  }

  parseStatement(): Statement {
    const withClause = this.peek().kind === "kw_with"
      ? this.parseWithClause()
      : { with: undefined, withModule: this.defaultModule, withModuleAliases: undefined };
    if (!withClause.withModule) {
      withClause.withModule = this.defaultModule;
    }
    const withBindingNames = withClause.with?.map((binding) => binding.name) ?? [];
    this.localBindings.push(...withBindingNames);
    try {
      const token = this.peek();
      if (token.kind === "kw_select") {
        return this.parseSelect(withClause);
      }

      if (token.kind === "kw_insert") {
        return this.parseInsert(withClause);
      }

      if (token.kind === "kw_update") {
        return this.parseUpdate(withClause);
      }

      if (token.kind === "kw_for") {
        return this.parseFor(withClause);
      }

      if (token.kind === "kw_delete") {
        return this.parseDelete(withClause);
      }

      if (token.kind === "kw_configure") {
        return this.parseConfigure(withClause);
      }

      if (token.kind === "kw_group") {
        return this.parseGroup(withClause);
      }

      if (token.kind === "kw_start" || token.kind === "kw_commit" || token.kind === "kw_rollback") {
        return this.parseTransaction();
      }

      if (token.kind === "kw_create" || token.kind === "kw_alter" || token.kind === "kw_drop") {
        return this.parseDDL();
      }

      throw new AppError("E_SYNTAX", "Expected 'select', 'insert', 'update', 'delete', 'for', 'configure', transaction, or DDL statement", token.line, token.column);
    } finally {
      withBindingNames.forEach(() => {
        this.localBindings.pop();
      });
    }
  }

  private parseConfigure(ctx: ParseContext = {}): ConfigureStatement {
    const start = this.expect("kw_configure", "Expected 'configure'");
    const scopeToken = this.expectName("Expected configuration scope");
    const scopeLexeme = scopeToken.lexeme.toLowerCase();
    let scope: ConfigureStatement["scope"];
    if (scopeLexeme === "session") {
      scope = "session";
    } else if (scopeLexeme === "instance") {
      scope = "instance";
    } else if (scopeLexeme === "current_database" || scopeLexeme === "currentdatabase" || scopeLexeme === "database") {
      scope = "current_database";
    } else {
      throw new AppError("E_SYNTAX", "Expected configure scope: session, current_database, or instance", scopeToken.line, scopeToken.column);
    }

    const opToken = this.peek();
    this.consume();
    const opLexeme = opToken.lexeme.toLowerCase();
    let operation: ConfigureStatement["operation"];
    if (opLexeme === "set") {
      operation = "set";
    } else if (opLexeme === "insert") {
      operation = "insert";
    } else if (opLexeme === "reset") {
      operation = "reset";
    } else {
      throw new AppError("E_SYNTAX", "Expected configure operation: set, insert, or reset", opToken.line, opToken.column);
    }

    const target = this.parseQualifiedName("Expected configuration target");
    let value: FreeObjectExpr | undefined;
    if (operation !== "reset") {
      this.expect("assign", "Expected ':=' in configure statement");
      value = this.parseFreeObjectExpr();
    }

    if (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after configure statement");

    return {
      ...this.withContext(ctx),
      kind: "configure",
      scope,
      operation,
      target,
      value,
      pos: { line: start.line, column: start.column },
    };
  }

  private parseGroup(ctx: ParseContext = {}): GroupStatement {
    const start = this.expect("kw_group", "Expected 'group'");
    const body = this.parseGroupBody();
    while (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after group statement");
    return {
      ...this.withContext(ctx),
      kind: "group",
      source: body.source,
      using: body.using,
      by: body.by,
      pos: { line: start.line, column: start.column },
    };
  }

  private parseGroupExpr(): GroupExpr {
    this.expect("kw_group", "Expected 'group'");
    const body = this.parseGroupBody();
    return {
      kind: "group_expr",
      source: body.source,
      using: body.using,
      by: body.by,
    };
  }

  private parseGroupBody(): { source: FreeObjectExpr; using?: GroupUsingBinding[]; by: GroupByElement[] } {
    const source = this.parseGroupSource();

    let using: GroupUsingBinding[] | undefined;
    if (this.peek().kind === "kw_using") {
      this.consume();
      using = this.parseGroupUsingBindings();
    }

    const byKeyword = this.expect("kw_by", "Expected 'BY' in group statement");
    const by = this.parseGroupByList(byKeyword);

    this.validateGroupBindings(using, by);

    return { source, using, by };
  }

  private parseGroupSource(): FreeObjectExpr {
    // `GROUP cards::Card [{shape}] [USING ...] BY ...` -- a bare or shape-decorated
    // type name. parseFreeObjectExpr won't recognise `cards::Card BY` as a typed
    // source (it isn't followed by '.field' or '{shape}'), so we route through
    // parseInlineSelectExpr when the next thing after the qualified name is one
    // of the GROUP-tail keywords.
    if (this.isNameToken(this.peek())) {
      const afterName = this.kindAfterQualifiedName();
      if (afterName === "lbrace" || afterName === "kw_using" || afterName === "kw_by") {
        return this.parseInlineSelectExpr();
      }
    }
    return this.parseFreeObjectExpr();
  }

  private parseGroupUsingBindings(): GroupUsingBinding[] {
    const bindings: GroupUsingBinding[] = [];
    while (true) {
      const aliasToken = this.peek();
      if (!this.isNameToken(aliasToken)) {
        throw new AppError("E_SYNTAX", "Expected alias name in USING clause", aliasToken.line, aliasToken.column);
      }
      const alias = this.consume().lexeme;
      if (alias === "id") {
        throw new AppError("E_SYNTAX", "may not name a grouping alias 'id'", aliasToken.line, aliasToken.column);
      }
      this.expect("assign", "Expected ':=' in USING binding");
      const aliasExpr = this.withLocalBinding(alias, () => this.parseFreeObjectExpr());
      bindings.push({ alias, expr: aliasExpr });
      if (this.peek().kind !== "comma") {
        break;
      }
      this.consume();
      if (this.peek().kind === "kw_by") {
        break;
      }
    }
    return bindings;
  }

  private parseGroupByList(byKeyword: Token): GroupByElement[] {
    const elements: GroupByElement[] = [];
    while (true) {
      elements.push(this.parseGroupByElement(byKeyword));
      if (this.peek().kind !== "comma") {
        break;
      }
      this.consume();
    }
    if (elements.length === 0) {
      throw new AppError("E_SYNTAX", "Expected at least one element in BY clause", byKeyword.line, byKeyword.column);
    }
    return elements;
  }

  private parseGroupByElement(byKeyword: Token): GroupByElement {
    const token = this.peek();

    // `BY { atom, atom, … }` — comma-separated grouping sets, each set
    // implicitly a singleton atom. Nested braces would mean multi-column
    // sets, but the current grammar reads atoms only.
    if (token.kind === "lbrace") {
      this.consume();
      const sets: GroupByAtom[][] = [];
      while (this.peek().kind !== "rbrace") {
        sets.push([this.parseGroupByAtom()]);
        if (this.peek().kind === "rbrace") break;
        this.expect("comma", "Expected ',' between grouping sets in BY {...}");
      }
      this.expect("rbrace", "Expected '}' after BY grouping sets");
      return { kind: "sets", sets };
    }

    if (this.isNameToken(token) && token.lexeme.toLowerCase() === "cube" && this.peekNext().kind === "lparen") {
      this.consume(); this.consume();
      const atoms = this.parseGroupByAtomList();
      this.expect("rparen", "Expected ')' after CUBE(...)");
      return { kind: "cube", atoms };
    }
    if (this.isNameToken(token) && token.lexeme.toLowerCase() === "rollup" && this.peekNext().kind === "lparen") {
      this.consume(); this.consume();
      const atoms = this.parseGroupByAtomList();
      this.expect("rparen", "Expected ')' after ROLLUP(...)");
      return { kind: "rollup", atoms };
    }

    return this.parseGroupByAtom();
  }

  private parseGroupByAtom(): GroupByAtom {
    const token = this.peek();
    if (token.kind === "at") {
      throw new AppError("E_SYNTAX", "BY clause cannot refer to link properties (parser does not yet support '@<name>' in BY)", token.line, token.column);
    }
    if (token.kind === "dot") {
      this.consume();
      const fieldToken = this.peek();
      if (!this.isNameToken(fieldToken)) {
        throw new AppError("E_SYNTAX", "Expected field name after '.' in BY clause", fieldToken.line, fieldToken.column);
      }
      const field = this.consume().lexeme;
      if (field === "id") {
        throw new AppError("E_SYNTAX", "may not group by a field named id", fieldToken.line, fieldToken.column);
      }
      return { kind: "field_ref", field };
    }
    if (this.isNameToken(token)) {
      const nameToken = this.consume();
      return { kind: "name_ref", name: nameToken.lexeme };
    }
    if (token.kind === "kw_by") {
      throw new AppError("E_SYNTAX", "Expected BY-clause atom", token.line, token.column);
    }
    throw new AppError("E_SYNTAX", "Expected '.field' or USING alias name as BY atom", token.line, token.column);
  }

  private parseGroupByAtomList(): GroupByAtom[] {
    const atoms: GroupByAtom[] = [];
    while (true) {
      atoms.push(this.parseGroupByAtom());
      if (this.peek().kind !== "comma") {
        break;
      }
      this.consume();
    }
    return atoms;
  }

  private validateGroupBindings(using: GroupUsingBinding[] | undefined, by: GroupByElement[]): void {
    const declared = new Set<string>();
    if (using) {
      for (const binding of using) {
        declared.add(binding.alias);
      }
    }
    for (const element of by) {
      if (element.kind === "name_ref" && !declared.has(element.name)) {
        throw new AppError("E_SYNTAX", `variable '${element.name}' referenced in BY but not declared in USING`, 0, 0);
      }
    }
  }

  private parseTransaction(): TransactionStatement {
    const token = this.peek();
    let action: TransactionStatement["action"];
    if (token.kind === "kw_start") {
      action = "start";
      this.consume();
      if (this.peek().kind === "kw_transaction" || (this.isNameToken(this.peek()) && this.peek().lexeme.toLowerCase() === "transaction")) {
        this.consume();
      }
    } else if (token.kind === "kw_commit") {
      action = "commit";
      this.consume();
    } else {
      action = "rollback";
      this.expect("kw_rollback", "Expected 'start', 'commit', or 'rollback'");
    }

    let isolation: TransactionStatement["isolation"];
    if (action === "start" && this.isNameToken(this.peek()) && this.peek().lexeme.toLowerCase() === "isolation") {
      this.consume();
      const level = this.expectName("Expected transaction isolation level").lexeme.toLowerCase();
      if (level === "serializable") {
        isolation = "serializable";
      } else if (level === "repeatable") {
        const maybeRead = this.expectName("Expected 'read' after 'repeatable'").lexeme.toLowerCase();
        if (maybeRead !== "read") {
          const tok = this.peek();
          throw new AppError("E_SYNTAX", "Expected 'read' after 'repeatable'", tok.line, tok.column);
        }
        isolation = "repeatable_read";
      }
    }

    if (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after transaction statement");

    return {
      kind: "transaction",
      action,
      isolation,
      pos: { line: token.line, column: token.column },
    };
  }

  private parseDDL(): DDLStatement {
    const start = this.peek();
    let action: DDLStatement["action"];
    if (start.kind === "kw_create") {
      action = "create";
      this.consume();
    } else if (start.kind === "kw_alter") {
      action = "alter";
      this.consume();
    } else {
      action = "drop";
      this.expect("kw_drop", "Expected 'create', 'alter', or 'drop'");
    }

    const objectToken = this.peek();
    this.consume();
    const objectLexeme = objectToken.lexeme.toLowerCase();
    const objectKindMap: Record<string, DDLStatement["objectKind"]> = {
      type: "type",
      scalar: "scalar",
      link: "link",
      property: "property",
      function: "function",
      constraint: "constraint",
      index: "index",
      trigger: "trigger",
      policy: "policy",
      module: "module",
      database: "database",
      branch: "branch",
      role: "role",
      extension: "extension",
      alias: "alias",
      global: "global",
    };
    const objectKind = objectKindMap[objectLexeme];
    if (!objectKind) {
      throw new AppError("E_SYNTAX", `Unsupported DDL object kind '${objectToken.lexeme}'`, objectToken.line, objectToken.column);
    }

    const name = this.parseQualifiedName("Expected DDL object name");
    let value: DDLStatement["value"];
    if (action === "create" && (objectKind === "alias" || objectKind === "global") && this.peek().kind === "assign") {
      this.expect("assign", "Expected ':=' in DDL definition");
      value = this.parseFreeObjectExpr();
    } else {
      this.skipDDLBody();
    }
    if (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after DDL statement");

    return {
      kind: "ddl",
      action,
      objectKind,
      name,
      value,
      pos: { line: start.line, column: start.column },
    };
  }

  private skipDDLBody(): void {
    let depth = 0;
    while (this.peek().kind !== "eof") {
      const token = this.peek();
      if (token.kind === "semi" && depth === 0) {
        break;
      }
      if (token.kind === "lbrace" || token.kind === "lparen" || token.kind === "lbracket") {
        depth += 1;
      } else if (token.kind === "rbrace" || token.kind === "rparen" || token.kind === "rbracket") {
        depth = Math.max(0, depth - 1);
      }
      this.consume();
    }
  }

  private parseFor(ctx: ParseContext = {}): ForStatement {
    const start = this.expect("kw_for", "Expected 'for'");
    let optional = false;
    if (this.peek().kind === "kw_optional") {
      this.consume();
      optional = true;
    }
    const variable = this.expectName("Expected variable name after 'for'").lexeme;
    this.expect("kw_in", "Expected 'in' after for variable");
    const iteratorExpr = this.parseFreeObjectIfElseExpr();
    if (this.peek().kind === "kw_union") {
      this.consume();
    }
    const hasWrappedStatement = this.peek().kind === "lparen"
      && (this.peekNext().kind === "kw_select" || this.peekNext().kind === "kw_insert");
    if (hasWrappedStatement) {
      this.consume();
    }
    const body: InsertStatement | SelectStatement | SelectExprStatement | SelectFreeStatement
      = this.withLocalBinding(variable, () => {
      const next = this.peek();
      if (next.kind === "kw_select") {
        const selectStart = this.consume();
        const freeOrExpr = this.parseSelectFreeOrExpr(selectStart, ctx, false);
        if (freeOrExpr) {
          return freeOrExpr;
        }
        return this.parseTypedSelect(selectStart, ctx, false);
      }
      if (next.kind === "kw_insert") {
        return this.parseInsert(ctx, false);
      }

      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), false);
    });
    if (hasWrappedStatement) {
      this.expect("rparen", "Expected ')' after for body");
    }
    return {
      ...this.withContext(ctx),
      kind: "for",
      variable,
      optional,
      iteratorExpr,
      body,
      pos: { line: start.line, column: start.column },
    };
  }

  private parseSelect(ctx: ParseContext = {}): SelectStatement | SelectFreeStatement | SelectExprStatement {
    const start = this.expect("kw_select", "Expected 'select'");
    const narrowedTyped = this.attempt(() => this.tryParseNarrowedTypedSelect(start, ctx, true));
    if (narrowedTyped) {
      return narrowedTyped;
    }
    const freeOrExpr = this.parseSelectFreeOrExpr(start, ctx, true);
    if (freeOrExpr) {
      return freeOrExpr;
    }

    return this.parseTypedSelect(start, ctx, true);
  }

  private parseSelectFreeOrExpr(
    start: Token,
    ctx: ParseContext,
    expectEof: boolean,
  ): SelectFreeStatement | SelectExprStatement | undefined {
    if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
      const alias = this.consume().lexeme;
      this.expect("assign", "Expected ':=' after select expression alias");
      const expr = this.parseFreeObjectExpr();
      return this.parseSelectExprTail(start, ctx, {
        kind: "select_expr_subquery",
        alias,
        expr,
      }, expectEof);
    }

    if (this.peek().kind === "lbrace") {
      if (this.looksLikeFreeObjectSelect()) {
        return this.parseFreeObjectSelect(start.line, start.column, ctx);
      }
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.peek().kind === "lparen" || this.peek().kind === "lt" || this.peek().kind === "string" || this.peek().kind === "lbracket" || this.atFunctionCall()) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if ([
      "number",
      "kw_true",
      "kw_false",
      "kw_null",
      "kw_for",
      "kw_distinct",
      "kw_detached",
      "dot",
      "kw_not",
    ].includes(this.peek().kind)) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isExistsToken(this.peek())) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isNameToken(this.peek()) && this.peekNext().kind === "at") {
      const atToken = this.peekNext();
      throw new AppError("E_SYNTAX", "unexpected reference to link property", atToken.line, atToken.column);
    }

    const hasNamedBacklink = this.isNameToken(this.peek()) && (
      (this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt")
      || this.peekNext().kind === "backward_link"
    );
    if (hasNamedBacklink) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isNameToken(this.peek()) && this.peekNext().kind === "lbracket") {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.atQualifiedIdentifier()) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isNameToken(this.peek()) && this.localBindings.includes(this.peek().lexeme)) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (ctx.with && ctx.with.length > 0 && this.isNameToken(this.peek()) && this.peekNext().kind !== "lbrace") {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isNameToken(this.peek()) && (this.peekNext().kind === "semi" || this.peekNext().kind === "eof")) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    // Name followed by a binary operator — treat as a free expression so the
    // expression parser handles the full RHS instead of letting parseTypedSelect
    // stop at the bare name and choke on the trailing operator.
    const binaryOpKinds: Token["kind"][] = [
      "coalesce",
      "not_distinct_from",
      "distinct_from",
      "plus",
      "minus",
      "star",
      "slash",
      "floor_div",
      "modulo",
      "pow",
      "concat",
      "equals",
      "not_equals",
      "lt",
      "gt",
      "lte",
      "gte",
      "kw_and",
      "kw_or",
      "kw_is",
      "kw_if",
      "kw_union",
    ];
    if (this.isNameToken(this.peek()) && binaryOpKinds.includes(this.peekNext().kind)) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    return undefined;
  }

  private parseTypedSelect(start: Token, ctx: ParseContext, expectEof: boolean): SelectStatement {
    const typeName = this.parseQualifiedName("Expected type name");

    const shape: ShapeElement[] = [{ kind: "field", name: "id", operation: "assign", origin: "default" }];
    const fields: string[] = ["id"];
    if (this.peek().kind === "lbrace") {
      this.consume();
      shape.length = 0;
      fields.length = 0;

      for (const entry of this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries")) {
        shape.push(entry);
        if (entry.kind === "field") {
          fields.push(entry.name);
        }
      }
      this.expect("rbrace", "Expected '}' after selected fields");
    }

    const clauses = this.parseClauseChain();

    if (expectEof && this.peek().kind === "semi") {
      this.consume();
    }

    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "select",
      typeName,
      shape,
      fields,
      filter: clauses.filter,
      orderBy: clauses.orderBy,
      limit: clauses.limit,
      offset: clauses.offset,
      pos: {
        line: start.line,
        column: start.column,
      },
    };
  }

  // Matches `Name[IS T1]...[IS Tn] { shape }` as a typed select with type
  // narrowing, so the typed-select IR path applies. Returns undefined when
  // the lookahead doesn't fit (e.g. no `{` follows the bracket chain) so the
  // caller can fall back to the select-expression path.
  private tryParseNarrowedTypedSelect(
    start: Token,
    ctx: ParseContext,
    expectEof: boolean,
  ): SelectStatement | undefined {
    if (!this.atQualifiedIdentifierForTypedSelect()) {
      return undefined;
    }
    const typeName = this.parseQualifiedName("Expected type name");
    const typeFilterExprs: TypeExpr[] = [];
    while (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
      typeFilterExprs.push(this.parseTypeFilter("typed select narrowing"));
    }
    if (typeFilterExprs.length === 0 || this.peek().kind !== "lbrace") {
      return undefined;
    }

    this.consume();
    const shape: ShapeElement[] = [];
    const fields: string[] = [];
    for (const entry of this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries")) {
      shape.push(entry);
      if (entry.kind === "field") {
        fields.push(entry.name);
      }
    }
    this.expect("rbrace", "Expected '}' after selected fields");

    const clauses = this.parseClauseChain();

    if (expectEof && this.peek().kind === "semi") {
      this.consume();
    }
    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "select",
      typeName,
      typeFilterExprs,
      shape,
      fields,
      filter: clauses.filter,
      orderBy: clauses.orderBy,
      limit: clauses.limit,
      offset: clauses.offset,
      pos: { line: start.line, column: start.column },
    };
  }

  private atQualifiedIdentifierForTypedSelect(): boolean {
    if (!this.isNameToken(this.peek())) return false;
    let offset = 1;
    while (this.peekNth(offset).kind === "coloncolon" && this.isNameToken(this.peekNth(offset + 1))) {
      offset += 2;
    }
    return this.peekNth(offset).kind === "lbracket" && this.peekNth(offset + 1).kind === "kw_is";
  }

  private parseSelectExprTail(start: Token, ctx: ParseContext, expr: FreeObjectExpr, expectEof = true): SelectExprStatement {
    let filterExpr: FreeObjectExpr | undefined;
    if (this.peek().kind === "kw_filter") {
      this.consume();
      filterExpr = this.parseFreeObjectExpr();
    }
    const orderBy = this.parseExprOrderBy();
    const pagination = this.parseExprPagination();
    const paginatedExpr: FreeObjectExpr = filterExpr !== undefined || pagination.limit !== undefined || pagination.offset !== undefined
      ? {
          kind: "select_expr_subquery",
          expr,
          filter: filterExpr,
          orderBy,
          limit: pagination.limit,
          offset: pagination.offset,
        }
      : expr;
    if (expectEof && this.peek().kind === "semi") {
      this.consume();
    }
    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }
    return {
      ...this.withContext(ctx),
      kind: "select_expr",
      expr: paginatedExpr,
      orderBy: paginatedExpr === expr ? orderBy : undefined,
      pos: { line: start.line, column: start.column },
    };
  }

  private parseFreeObjectSelect(
    line: number,
    column: number,
    ctx: ParseContext,
  ): SelectFreeStatement {
    this.expect("lbrace", "Expected '{' after 'select' in free object query");
    const entries = this.parseDelimited("rbrace", () => {
      const name = this.expectName("Expected free object field name").lexeme;
      this.expect("assign", "Expected ':=' in free object field");
      const expr = this.parseFreeObjectExpr();
      return { name, expr };
    }, "Expected ',' between free object entries");

    this.expect("rbrace", "Expected '}' after free object entries");
    if (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after statement");

    return {
      ...this.withContext(ctx),
      kind: "select_free",
      entries,
      pos: { line, column },
    };
  }

  private parseFreeObjectExpr(): FreeObjectExpr {
    let expr = this.parseFreeObjectIfElseExpr();
    while (this.peek().kind === "kw_union") {
      this.consume();
      const right = this.parseFreeObjectIfElseExpr();
      expr = expr.kind === "set_expr"
        ? { kind: "set_expr", values: [...expr.values, right] }
        : { kind: "set_expr", values: [expr, right] };
    }
    return expr;
  }

  private parseFreeObjectIfElseExpr(): FreeObjectExpr {
    const thenExpr = this.parseFreeObjectOrExpr();
    if (this.peek().kind !== "kw_if") {
      return thenExpr;
    }

    this.consume();
    const condition = this.parseFreeObjectOrExpr();
    this.expect("kw_else", "Expected 'else' in IF expression");
    const elseExpr = this.parseFreeObjectIfElseExpr();
    return {
      kind: "if_else",
      thenExpr,
      condition,
      elseExpr,
    };
  }

  private parseFreeObjectOrExpr(): FreeObjectExpr {
    let left = this.parseFreeObjectAndExpr();
    while (this.peek().kind === "kw_or") {
      this.consume();
      left = {
        kind: "logical",
        op: "or",
        left,
        right: this.parseFreeObjectAndExpr(),
      };
    }
    return left;
  }

  private parseFreeObjectAndExpr(): FreeObjectExpr {
    let left = this.parseFreeObjectNotExpr();
    while (this.peek().kind === "kw_and") {
      this.consume();
      left = {
        kind: "logical",
        op: "and",
        left,
        right: this.parseFreeObjectNotExpr(),
      };
    }
    return left;
  }

  private parseFreeObjectNotExpr(): FreeObjectExpr {
    if (this.peek().kind === "kw_not") {
      this.consume();
      return {
        kind: "unary",
        op: "not",
        expr: this.parseFreeObjectNotExpr(),
      };
    }
    if (this.peek().kind === "minus") {
      this.consume();
      return {
        kind: "unary",
        op: "neg",
        expr: this.parseFreeObjectNotExpr(),
      };
    }
    return this.parseFreeObjectComparisonExpr();
  }

  private parseFreeObjectComparisonExpr(): FreeObjectExpr {
    let left = this.parseFreeObjectExprWithPrecedence();

    while (true) {
      const token = this.peek();
      if (
        token.kind !== "equals"
        && token.kind !== "not_equals"
        && token.kind !== "gt"
        && token.kind !== "lt"
        && token.kind !== "gte"
        && token.kind !== "lte"
        && token.kind !== "not_distinct_from"
        && token.kind !== "distinct_from"
        && token.kind !== "kw_like"
        && token.kind !== "kw_ilike"
      ) {
        break;
      }

      this.consume();
      const right = this.parseFreeObjectExprWithPrecedence();
      left = {
        kind: "compare",
        op: token.kind === "equals"
          ? "="
          : token.kind === "not_equals"
            ? "!="
            : token.kind === "gt"
              ? ">"
              : token.kind === "lt"
                ? "<"
                : token.kind === "gte"
                  ? ">="
                  : token.kind === "lte"
                    ? "<="
                    : token.kind === "not_distinct_from"
                      ? "?="
                      : token.kind === "distinct_from"
                        ? "?!="
                        : token.kind === "kw_like"
                          ? "like"
                          : "ilike",
        left,
        right,
      };
    }

    return left;
  }

  private parseFreeObjectPrimaryExpr(): FreeObjectExpr {
    if (this.peek().kind === "lparen") {
      this.consume();
      if (this.peek().kind === "rparen") {
        this.consume();
        // `()` is the empty tuple in EdgeQL, distinct from `{}` (empty set).
        return { kind: "tuple", values: [] };
      }
      if (["kw_insert", "kw_update", "kw_delete"].includes(this.peek().kind)) {
        const kind = this.peek().kind;
        let statement: InsertStatement | UpdateStatement | DeleteStatement;
        if (kind === "kw_insert") {
          statement = this.parseInsert({}, false);
        } else if (kind === "kw_update") {
          statement = this.parseUpdate({}, false);
        } else {
          statement = this.parseDelete({}, false);
        }
        this.expect("rparen", "Expected ')' after parenthesized mutation expression");
        return { kind: "mutation_expr", statement };
      }
      // Parenthesised free-object constructor: `( name := expr, name := expr )`
      if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
        const entries: Array<{ name: string; expr: FreeObjectExpr }> = [];
        while (true) {
          const name = this.expectName("Expected free object field name").lexeme;
          this.expect("assign", "Expected ':=' in free object field");
          const fieldExpr = this.parseFreeObjectExpr();
          entries.push({ name, expr: fieldExpr });
          if (this.peek().kind !== "comma") {
            break;
          }
          this.consume();
          if (this.peek().kind === "rparen") {
            break;
          }
        }
        this.expect("rparen", "Expected ')' after free object entries");
        return { kind: "free_object_constructor", entries };
      }

      if (this.peek().kind === "kw_with") {
        const withClause = this.parseWithClause();
        let inner: FreeObjectExpr;
        if (this.peek().kind === "kw_select") {
          inner = this.parseSelectExprSubquery();
        } else {
          inner = this.parseFreeObjectExpr();
        }
        let filter: FreeObjectExpr | undefined;
        if (this.peek().kind === "kw_filter") {
          this.consume();
          filter = this.parseFreeObjectExpr();
        }
        const orderBy = this.parseExprOrderBy();
        const { limit, offset } = this.parseExprPagination();
        const wrapped: FreeObjectExpr = {
          kind: "select_expr_subquery",
          expr: inner,
          filter,
          orderBy,
          limit,
          offset,
          clauses: {
            _withBindings: withClause.with,
            _withModule: withClause.withModule,
            _withModuleAliases: withClause.withModuleAliases,
          },
        };
        if (this.peek().kind === "comma") {
          const values: FreeObjectExpr[] = [wrapped];
          while (this.peek().kind === "comma") {
            this.consume();
            if (this.peek().kind === "rparen") break;
            values.push(this.parseFreeObjectExpr());
          }
          this.expect("rparen", "Expected ')' after tuple expression");
          return { kind: "tuple", values };
        }
        this.expect("rparen", "Expected ')' after parenthesized WITH expression");
        return wrapped;
      }
      const expr = this.parseFreeObjectExpr();
      if (this.peek().kind === "comma") {
        const values: FreeObjectExpr[] = [expr];
        while (this.peek().kind === "comma") {
          this.consume();
          if (this.peek().kind === "rparen") {
            break;
          }
          values.push(this.parseFreeObjectExpr());
        }
        this.expect("rparen", "Expected ')' after tuple expression");
        return {
          kind: "tuple",
          values,
        };
      }
      this.expect("rparen", "Expected ')' after parenthesized expression");
      return expr;
    }

    if (this.peek().kind === "kw_distinct") {
      this.consume();
      return {
        kind: "distinct",
        expr: this.parsePostfixChain(this.parseFreeObjectPrimaryExpr()),
      };
    }

    if (this.peek().kind === "kw_detached") {
      this.consume();
      return this.parseFreeObjectPrimaryExpr();
    }

    if (this.isExistsToken(this.peek())) {
      this.consume();
      return {
        kind: "exists",
        expr: this.parseFreeObjectPostfixExpr(),
      };
    }

    if (this.peek().kind === "kw_for") {
      const binders: Array<{ variable: string; iterator: FreeObjectExpr; optional: boolean }> = [];
      while (this.peek().kind === "kw_for") {
        this.consume();
        let optional = false;
        if (this.peek().kind === "kw_optional") {
          this.consume();
          optional = true;
        }
        const variable = this.expectName("Expected variable name after 'for'").lexeme;
        this.expect("kw_in", "Expected 'in' after for variable");
        const iterator = this.parseFreeObjectIfElseExpr();
        binders.push({ variable, iterator, optional });
        this.localBindings.push(variable);

      }
      if (this.peek().kind === "kw_union") {
        this.consume();
      } else {
        this.expect("kw_select", "Expected 'select' after for iterator");
      }
      const parseBody = (index: number): FreeObjectExpr => {
        const binder = binders[index];
        return this.withLocalBinding(binder.variable, () => {
          if (index === binders.length - 1) {
            return this.parseFreeObjectExpr();
          }
          return {
            kind: "for_expr",
            variable: binders[index + 1]!.variable,
            iterator: binders[index + 1]!.iterator,
            optional: binders[index + 1]!.optional,
            body: parseBody(index + 1),
            //filter:
          };
        });
      };
      const first = binders[0]!;
      let expr: FreeObjectExpr = {
        kind: "for_expr",
        variable: first.variable,
        iterator: first.iterator,
        optional: first.optional,
        body: parseBody(0),
      };
      for (const binder of binders) {
        this.localBindings.push(binder.variable);
      }
      let filter: FreeObjectExpr | undefined;
      if (this.peek().kind === "kw_filter") {
        this.consume();
        filter = this.parseFreeObjectExpr();
      }
      const orderBy = this.parseExprOrderBy();
      const { limit, offset } = this.parseExprPagination();
      for (let binderIndex = 0; binderIndex < binders.length; binderIndex += 1) {
        this.localBindings.pop();
      }
      if (filter || orderBy || limit !== undefined || offset !== undefined) {
        // const wrapLeaf = (node: FreeObjectExpr): FreeObjectExpr => {
        //   if (node.kind === "for_expr") {
        //     return {
        //       kind: "for_expr",
        //       variable: node.variable,
        //       iterator: node.iterator,
        //       body: {
        //         kind: "select_expr_subquery",
        //         expr: node.body,
        //         filter,
        //         orderBy,
        //         limit,
        //         offset,
        //       },
        //     };
        //   }
        //   return {
        //     kind: "select_expr_subquery",
        //     expr: node,
        //     filter,
        //     orderBy,
        //     limit,
        //     offset,
        //   };
        // };
        // expr = wrapLeaf(expr);
        expr = {
          ...expr,
          filter,
          orderBy,
          limit,
          offset,
        };
      }
      return expr;
    }

    if (this.peek().kind === "kw_select") {
      return this.parseSelectExprSubquery();
    }

    if (this.peek().kind === "kw_group") {
      return this.parseGroupExpr();
    }

    if (this.peek().kind === "str_interp_start") {
      return this.parseStringInterpolationExpr();
    }

    if (this.peek().kind === "lt") {
      this.consume();
      const castType = this.parseCastTypeName("Expected type name in cast");
      this.expect("gt", "Expected '>' after cast type");
      const expr = this.parseFreeObjectPostfixExpr();
      return { kind: "cast", castType, expr };
    }

    if (this.peek().kind === "lbrace") {
      if (this.isNameToken(this.peekNth(1)) && this.peekNth(2).kind === "assign") {
        this.consume();
        const entries = this.parseDelimited("rbrace", () => {
          const name = this.expectName("Expected free object field name").lexeme;
          this.expect("assign", "Expected ':=' in free object field");
          const fieldExpr = this.parseFreeObjectExpr();
          return { name, expr: fieldExpr };
        }, "Expected ',' between free object entries");
        this.expect("rbrace", "Expected '}' after free object entries");
        return { kind: "free_object_constructor", entries };
      }
      this.consume();
      const values = this.parseDelimited("rbrace", () => this.parseFreeObjectExpr(), "Expected ',' in set literal");
      this.expect("rbrace", "Expected '}' after set literal");
      if (values.every((v) => v.kind === "literal")) {
        return { kind: "set_literal", values: values.map((v) => (v as { kind: "literal"; value: ScalarValue }).value) };
      }
      return { kind: "set_expr", values };
    }

    if (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
      const typeExpr = this.parseTypeFilter("polymorphic type intersection");
      return {
        kind: "path_steps",
        steps: [{ kind: "type_intersection", typeName: simpleTypeName(typeExpr) ?? "", typeExpr }],
        partial: true,
      };
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values = this.parseDelimited("rbracket", () => this.parseFreeObjectExpr(), "Expected ',' in array literal");
      this.expect("rbracket", "Expected ']' after array literal");
      return { kind: "array_literal_expr", values };
    }

    if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link") {
      const op = this.peek().kind;
      this.consume();
      if (op === "backward_link" || this.peek().kind === "lt") {
        if (this.peek().kind === "lt") {
          this.consume();
        }
        const link = this.expectName("Expected backlink name after '.<'").lexeme;
        let sourceTypeExpr: TypeExpr | undefined;
        if (this.peek().kind === "lbracket") {
          sourceTypeExpr = this.parseTypeFilter("backlink type filter");
        }
        return {
          kind: "backlink_path",
          link,
          sourceType: simpleTypeName(sourceTypeExpr),
          sourceTypeExpr,
          optional: op === "optional_link",
        };
      }
      if (this.peek().kind === "number") {
        const indexToken = this.consume();
        return this.buildIndexAccessExpr({ kind: "current_item" }, indexToken.lexeme);
      }

      const field = this.expectName("Expected field name after '.'").lexeme;
      return {
        kind: "field_access",
        expr: { kind: "current_item" },
        field,
        optional: op === "optional_link",
      };
    }

    if (this.peek().kind === "parameter") {
      const token = this.consume();
      return {
        kind: "parameter",
        name: token.lexeme.slice(1),
      };
    }

    if (this.peek().kind === "parameter_and_type") {
      const token = this.consume();
      const split = token.lexeme.indexOf("$");
      const castType = token.lexeme.slice(1, split - 1);
      const name = token.lexeme.slice(split + 1).replace(/^`|`$/g, "");
      return {
        kind: "parameter",
        castType,
        name,
      };
    }

    if (this.peek().kind === "substitution") {
      const token = this.consume();
      return {
        kind: "substitution",
        name: token.lexeme.slice(2, -1),
      };
    }

    if (this.peek().kind.startsWith("kw_current_reserved_")) {
      const token = this.consume();
      return {
        kind: "global_ref",
        name: token.lexeme,
      };
    }

    if (this.atFunctionCall()) {
      return this.functionCallExpr(this.parseFunctionCallExpr(true));
    }

    if (this.atQualifiedIdentifier()) {
      const head = this.peek().lexeme;
      if (!this.isTypeLikeName(head)) {
        const qualified = this.parseQualifiedIdentifier(
          "Expected path head in free object expression",
          "Expected path tail in free object expression",
        );
        return {
          kind: "path",
          head: qualified.head,
          tail: qualified.tail,
          steps: this.pathStepsFromParts([qualified.head, qualified.tail]),
        };
      }
    }

    if (this.isNameToken(this.peek())) {
      const identifier = this.nameTokenLexeme(this.peek());
      if (this.localBindings.includes(identifier)) {
        this.consume();
        return {
          kind: "binding_ref",
          name: identifier,
        };
      }
      if (this.atInlineTypedSelect()) {
        return this.parseInlineSelectExpr();
      }
      if (this.isTypeLikeName(identifier)) {
        this.consume();
        return {
          kind: "select",
          typeName: identifier,
          shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
          clauses: {},
        };
      }
      this.consume();
      return {
        kind: "binding_ref",
        name: identifier,
      };
    }

    return {
      kind: "literal",
      value: this.readScalarLikeValue(),
    };
  }

  private parseStringInterpolationExpr(): FreeObjectExpr {
    const start = this.expect("str_interp_start", "Expected interpolated string start");
    const parts: FreeObjectExpr[] = [];

    if (start.lexeme.length > 0) {
      parts.push({ kind: "literal", value: start.lexeme });
    }

    while (true) {
      const expr = this.parseFreeObjectExpr();
      parts.push(expr);

      if (this.peek().kind === "str_interp_cont") {
        const cont = this.consume();
        if (cont.lexeme.length > 0) {
          parts.push({ kind: "literal", value: cont.lexeme });
        }
        continue;
      }

      if (this.peek().kind === "str_interp_end") {
        const end = this.consume();
        if (end.lexeme.length > 0) {
          parts.push({ kind: "literal", value: end.lexeme });
        }
        break;
      }

      const token = this.peek();
      throw new AppError(
        "E_SYNTAX",
        "Expected string interpolation continuation or end",
        token.line,
        token.column,
      );
    }

    if (parts.length === 0) {
      return { kind: "literal", value: "" };
    }
    if (parts.length === 1) {
      return parts[0]!;
    }
    return { kind: "concat", parts };
  }

  private parseFreeObjectPostfixExpr(): FreeObjectExpr {
    let expr = this.parseFreeObjectPrimaryExpr();
    expr = this.applyPostfixExprChain(expr);
    return expr;
  }

  private applyPostfixExprChain(expr: FreeObjectExpr): FreeObjectExpr {
    const backlinkBindingName = "__gel_backlink_item__";

    while (true) {
      if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link") {
        const op = this.peek().kind;
        this.consume();
        if (op === "backward_link" || this.peek().kind === "lt") {
          if (this.peek().kind === "lt") {
            this.consume();
          }
          const link = this.expectName("Expected backlink name after '.<'").lexeme;
          let sourceTypeExpr: TypeExpr | undefined;
          if (this.peek().kind === "lbracket") {
            sourceTypeExpr = this.parseTypeFilter("backlink type filter");
          }
          expr = {
            kind: "for_expr",
            variable: backlinkBindingName,
            iterator: expr,
            body: {
              kind: "backlink_path",
              link,
              sourceType: simpleTypeName(sourceTypeExpr),
              sourceTypeExpr,
              optional: op === "optional_link",
            },
          };
        } else if (this.peek().kind === "number") {
          const indexToken = this.consume();
          expr = this.buildIndexAccessExpr(expr, indexToken.lexeme);
        } else {
          const field = this.expectName("Expected field name after '.'").lexeme;
          if (expr.kind === "path_steps") {
            expr = {
              kind: "path_steps",
              steps: [...expr.steps, { kind: "ptr", name: field, direction: "outbound", optional: op === "optional_link" }],
              partial: expr.partial,
            };
          } else {
            expr = {
              kind: "field_access",
              expr,
              field,
              optional: op === "optional_link",
            };
          }
        }
        continue;
      }

      if (this.peek().kind === "at") {
        this.consume();
        const property = this.expectName("Expected link property name after '@'").lexeme;
        expr = {
          kind: "field_access",
          expr,
          field: `@${property}`,
        };
        continue;
      }

      if (this.peek().kind === "lbracket") {
        this.consume();
        if (this.peek().kind === "kw_is") {
          this.consume();
          const typeExpr = this.parseTypeExpr("type intersection");
          this.expect("rbracket", "Expected ']' after type intersection");
          const typeName = simpleTypeName(typeExpr) ?? "";
          const baseHeadName = this.headNameOfExpr(expr);
          if (baseHeadName && this.isEnumLikeName(baseHeadName) && this.peek().kind === "dot") {
            const dotToken = this.peek();
            throw new AppError("E_SYNTAX", "an enum member name must follow enum type name in the path", dotToken.line, dotToken.column);
          }
          const steps = this.exprToPathSteps(expr);
          if (steps) {
            expr = {
              kind: "path_steps",
              steps: [...steps, { kind: "type_intersection", typeName, typeExpr }],
              partial: expr.kind === "path_steps" ? expr.partial : undefined,
            };
          } else {
            expr = {
              kind: "is_type",
              expr,
              typeName,
              typeExpr,
            };
          }
          continue;
        }

        if (this.peek().kind === "colon") {
          this.consume();
          let end: number | undefined;
          if (this.peek().kind === "number") {
            end = this.parseNumberLexeme(this.consume().lexeme);
          }
          this.expect("rbracket", "Expected ']' after slice access");
          expr = {
            kind: "slice_access",
            expr,
            start: undefined,
            end,
          };
          continue;
        }

        const startToken = this.peek();
        let start: number | undefined;
        if (startToken.kind === "number") {
          start = this.parseNumberLexeme(this.consume().lexeme);
        }

        if (this.peek().kind === "colon") {
          this.consume();
          let end: number | undefined;
          if (this.peek().kind === "number") {
            end = this.parseNumberLexeme(this.consume().lexeme);
          }
          this.expect("rbracket", "Expected ']' after slice access");
          expr = {
            kind: "slice_access",
            expr,
            start,
            end,
          };
          continue;
        }

        if (start === undefined) {
          throw new AppError("E_SYNTAX", "Expected numeric index or '[is <Type>]' inside brackets", startToken.line, startToken.column);
        }
        this.expect("rbracket", "Expected ']' after index access");
        expr = {
          kind: "index_access",
          expr,
          index: start,
        };
        continue;
      }

      if (this.peek().kind === "lbrace") {
        this.consume();
        const shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
        this.expect("rbrace", "Expected '}' after shape projection");
        expr = {
          kind: "shape_projection",
          expr,
          shape,
        };
        continue;
      }

      break;
    }

    return expr;
  }

  private parsePostfixChain(baseExpr: FreeObjectExpr): FreeObjectExpr {
    let expr = baseExpr;
    const backlinkBindingName = "__gel_backlink_item__";
    while (true) {
      if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link") {
        const op = this.peek().kind;
        this.consume();
        if (op === "backward_link" || this.peek().kind === "lt") {
          if (this.peek().kind === "lt") {
            this.consume();
          }
          const link = this.expectName("Expected backlink name after '.<'").lexeme;
          let sourceTypeExpr: TypeExpr | undefined;
          if (this.peek().kind === "lbracket") {
            sourceTypeExpr = this.parseTypeFilter("backlink type filter");
          }
          expr = {
            kind: "for_expr",
            variable: backlinkBindingName,
            iterator: expr,
            body: {
              kind: "backlink_path",
              link,
              sourceType: simpleTypeName(sourceTypeExpr),
              sourceTypeExpr,
              optional: op === "optional_link",
            },
          };
        } else {
          const field = this.expectName("Expected field name after '.'").lexeme;
          expr = {
            kind: "field_access",
            expr,
            field,
            optional: op === "optional_link",
          };
        }
        continue;
      }

      if (this.peek().kind === "at") {
        this.consume();
        const property = this.expectName("Expected link property name after '@'").lexeme;
        expr = {
          kind: "field_access",
          expr,
          field: `@${property}`,
        };
        continue;
      }

      break;
    }
    return expr;
  }

  private parseFreeObjectUnaryAtom(): FreeObjectExpr {
    if (this.peek().kind === "minus") {
      this.consume();
      return { kind: "unary", op: "neg", expr: this.parseFreeObjectUnaryAtom() };
    }
    return this.parseFreeObjectPostfixExpr();
  }

  private parseFreeObjectExprWithPrecedence(minPrecedence = 0): FreeObjectExpr {
    let left = this.parseFreeObjectUnaryAtom();

    while (true) {
      if (this.peek().kind === "coalesce") {
        const precedence = 5;
        if (precedence < minPrecedence) {
          break;
        }
        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        left = { kind: "coalesce", left, right };
        continue;
      }

      if (this.peek().kind === "concat") {
        const precedence = 20;
        if (precedence < minPrecedence) {
          break;
        }

        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        if (left.kind === "concat") {
          left = { kind: "concat", parts: [...left.parts, right] };
        } else {
          left = { kind: "concat", parts: [left, right] };
        }
        continue;
      }

      if (this.peek().kind === "plus" || this.peek().kind === "minus") {
        const precedence = 30;
        if (precedence < minPrecedence) {
          break;
        }

        const op = this.consume().kind;
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        left = { kind: "math", op: op === "plus" ? "+" : "-", left, right };
        continue;
      }

      if (
        this.peek().kind === "star"
        || this.peek().kind === "slash"
        || this.peek().kind === "floor_div"
        || this.peek().kind === "modulo"
      ) {
        const precedence = 40;
        if (precedence < minPrecedence) {
          break;
        }

        const op = this.consume().kind;
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        left = {
          kind: "math",
          op: op === "star" ? "*" : op === "slash" ? "/" : op === "floor_div" ? "//" : "%",
          left,
          right,
        };
        continue;
      }

      if (this.peek().kind === "pow") {
        const precedence = 50;
        if (precedence < minPrecedence) {
          break;
        }
        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence(precedence);
        left = { kind: "math", op: "^", left, right };
        continue;
      }

      if (this.peek().kind === "kw_is") {
        const precedence = 10;
        if (precedence < minPrecedence) {
          break;
        }

        this.consume();
        const typeExpr = this.parseTypeExpr("type expression after 'is'");
        left = {
          kind: "is_type",
          expr: left,
          typeName: simpleTypeName(typeExpr) ?? "",
          typeExpr,
        };
        continue;
      }

      break;
    }

    return left;
  }

  private parseFreeObjectConcatExpr(): FreeObjectExpr {
    return this.parseFreeObjectExprWithPrecedence();
  }

  private parseSelectExprSubquery(): FreeObjectExpr {
    this.expect("kw_select", "Expected 'select'");
    let alias: string | undefined;
    let expr: FreeObjectExpr;
    if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
      alias = this.consume().lexeme;
      this.consume();
      expr = this.parseFreeObjectExpr();
    } else {
      expr = this.parseFreeObjectExpr();
    }

    let filter: FreeObjectExpr | undefined;
    if (this.peek().kind === "kw_filter") {
      this.consume();
      filter = this.parseFreeObjectExpr();
    }

    const orderBy = this.parseExprOrderBy();
    const { limit, offset } = this.parseExprPagination();

    return {
      kind: "select_expr_subquery",
      alias,
      expr,
      filter,
      orderBy,
      limit,
      offset,
    };
  }

  private parseExprPagination(): { limit?: number; offset?: number } {
    let limit: number | undefined;
    let offset: number | undefined;
    if (this.peek().kind === "kw_offset") {
      this.consume();
      offset = this.readInteger("Expected integer after 'offset'");
    }
    if (this.peek().kind === "kw_limit") {
      this.consume();
      limit = this.readInteger("Expected integer after 'limit'");
    }
    return { limit, offset };
  }

  private parseExprOrderBy(): OrderExprChain | undefined {
    if (this.peek().kind !== "kw_order") {
      return undefined;
    }
    this.consume();
    this.expect("kw_by", "Expected 'by' after 'order'");
    return this.parseExprOrderByTerm();
  }

  private parseExprOrderByTerm(): OrderExprChain {
    const expr = this.parseFreeObjectExpr();
    let direction: "asc" | "desc" = "asc";
    if (this.peek().kind === "kw_asc") {
      this.consume();
      direction = "asc";
    } else if (this.peek().kind === "kw_desc") {
      this.consume();
      direction = "desc";
    }
    let nullsPosition: "first" | "last" | undefined;
    if (this.peek().kind === "kw_empty") {
      this.consume();
      const nullsPositionToken = this.peek();
      if (this.isNameToken(nullsPositionToken)) {
        const lowered = nullsPositionToken.lexeme.toLowerCase();
        if (lowered === "first" || lowered === "last") {
          this.consume();
          nullsPosition = lowered;
        }
      }
    }
    let then: OrderExprChain | undefined;
    if (this.peek().kind === "kw_then") {
      this.consume();
      then = this.parseExprOrderByTerm();
    }
    return { expr, direction, nullsPosition, then };
  }

  private looksLikeFreeObjectSelect(): boolean {
    if (this.peek().kind !== "lbrace") {
      return false;
    }

    let depth = 0;
    for (let i = this.index; i < this.tokens.length; i += 1) {
      const token = this.tokens[i];
      if (token.kind === "lbrace") {
        depth += 1;
        continue;
      }
      if (token.kind === "rbrace") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
        continue;
      }

      if (depth === 1 && token.kind === "assign") {
        return true;
      }
    }

    return false;
  }

  private parseInlineSelectExpr(): { kind: "select"; typeName: string; shape: ShapeElement[]; clauses: ClauseChain } {
    if (this.peek().kind === "kw_detached") {
      this.consume();
    }
    const typeName = this.parseQualifiedName("Expected type name in inline select");
    const shape: ShapeElement[] = [{ kind: "field", name: "id", operation: "assign", origin: "default" }];
    if (this.peek().kind === "lbrace") {
      this.consume();
      shape.length = 0;
      shape.push(...this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries"));
      this.expect("rbrace", "Expected '}' after selected fields");
    }

    return {
      kind: "select",
      typeName,
      shape,
      clauses: this.parseClauseChain(),
    };
  }

  private parseShapeEntry(): ShapeElement {
    const { required, cardinality } = this.parseShapeEntryModifiers();

    if (this.peek().kind === "at") {
      this.consume();
      const property = this.expectName("Expected link property name after '@'").lexeme;
      let expr: ComputedExpr = {
        kind: "field_ref",
        field: `@${property}`,
      };

      if (this.peek().kind === "assign") {
        this.consume();
        const parsed = this.parseComputedExpr();
        if (this.isBacklinkExpr(parsed)) {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Link property expressions do not support backlinks", token.line, token.column);
        }
        expr = parsed;
      }

      return {
        kind: "computed",
        name: `@${property}`,
        expr,
        operation: "assign",
        origin: "explicit",
        required,
        cardinality,
      };
    }

    if (this.peek().kind === "star") {
      const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
      return {
        kind: "splat",
        depth: this.parseSplatDepth(),
        operation: "assign",
        origin: "explicit",
        required,
        cardinality,
        ...clauseModifiers,
      };
    }

    if (this.peek().kind === "lbracket") {
      const splat = this.attempt(() => {
        const sourceTypeExpr = this.parseTypeFilter("splat type intersection");
        this.expect("dot", "Expected '.' after type intersection in splat expression");
        if (this.peek().kind !== "star") {
          return undefined;
        }
        const depth = this.parseSplatDepth();
        const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
        return {
          kind: "splat" as const,
          depth,
          sourceType: simpleTypeName(sourceTypeExpr),
          sourceTypeExpr,
          intersection: true,
          operation: "assign" as const,
          origin: "explicit" as const,
          required,
          cardinality,
          ...clauseModifiers,
        };
      });
      if (splat) {
        return splat;
      }
    }

    const isMulti = this.isNameToken(this.peek()) && this.peek().lexeme.toLowerCase() === "multi" && this.isNameToken(this.peekNext());
    if (isMulti) {
      this.consume();
    }

    let leadingTypeFilter: TypeExpr | undefined;
    if (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
      leadingTypeFilter = this.parseTypeFilter("shape type filter");
      this.expect("dot", "Expected '.' after shape type filter");
    }

    const name = this.expectName("Expected selected field or computed alias").lexeme;

    if (this.peek().kind === "dot" && this.peekNext().kind === "star") {
      this.consume();
      const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
        return {
          kind: "splat" as const,
        depth: this.parseSplatDepth(),
        sourceType: name,
          operation: "assign" as const,
          origin: "explicit" as const,
        required,
        cardinality,
        ...clauseModifiers,
      };
    }

    let typeFilter: TypeExpr | undefined;
    if (this.peek().kind === "lbracket") {
      typeFilter = this.parseTypeFilter("shape type filter");
    }
    if (leadingTypeFilter) {
      if (typeFilter) {
        const token = this.peek();
        throw new AppError("E_SYNTAX", "Duplicate shape type filter", token.line, token.column);
      }
      typeFilter = leadingTypeFilter;
    }

    let hasLinkShapeColon = false;
    if (this.peek().kind === "colon") {
      this.consume();
      hasLinkShapeColon = true;
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
      this.expect("rbrace", "Expected '}' after nested shape");
      const clauses = this.parseClauseChain();

      return {
        kind: "link",
        name,
        typeFilter: simpleTypeName(typeFilter),
        typeFilterExpr: typeFilter,
        shape,
        clauses,
        operation: "assign",
        origin: "explicit",
        required,
        cardinality,
        ...this.clauseChainToShapeModifiers(clauses),
      };
    }

    if (typeFilter) {
      if (leadingTypeFilter && !hasLinkShapeColon) {
        const opTokenPoly = this.peek();
        const hasAssignmentPoly = opTokenPoly.kind === "assign"
          || opTokenPoly.kind === "add_assign"
          || opTokenPoly.kind === "sub_assign";
        if (!hasAssignmentPoly) {
          const modifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
          return {
            kind: "computed",
            name,
            expr: {
              kind: "polymorphic_field_ref",
              sourceType: simpleTypeName(typeFilter) ?? "",
              sourceTypeExpr: typeFilter,
              field: name,
            },
            operation: "assign",
            origin: "explicit",
            required,
            cardinality,
            ...modifiers,
          };
        }
      }
      const token = this.peek();
      throw new AppError(
        "E_SYNTAX",
        "Type filters in shapes require a nested link shape",
        token.line,
        token.column,
      );
    }

    if (hasLinkShapeColon) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", "Expected '{' after ':' in link shape", token.line, token.column);
    }

    const opToken = this.peek();
    const hasAssignment = opToken.kind === "assign" || opToken.kind === "add_assign" || opToken.kind === "sub_assign";

    if (!hasAssignment) {
      const modifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
      return {
        kind: "field",
        name,
        required,
        cardinality,
        operation: "assign",
        origin: "explicit",
        ...modifiers,
      };
    }

    this.consume();
    const operation = opToken.kind === "add_assign" ? "append" : opToken.kind === "sub_assign" ? "subtract" : "assign";
    const expr = this.parseComputedExpr();
    if (this.isBacklinkExpr(expr)) {
      let shape: ShapeElement[] | undefined;
      if (this.peek().kind === "lbrace") {
        this.consume();
        shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
        this.expect("rbrace", "Expected '}' after backlink shape");
      }
      const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
      return {
        kind: "backlink",
        name,
        expr,
        shape,
        required,
        cardinality,
        operation,
        origin: "explicit",
        ...clauseModifiers,
      };
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
      this.expect("rbrace", "Expected '}' after computed shape projection");
      const baseExpr: FreeObjectExpr = expr.kind === "field_ref"
        ? { kind: "field_access", expr: { kind: "current_item" }, field: expr.field }
        : expr.kind === "binding_ref"
          ? { kind: "binding_ref", name: expr.name }
          : expr.kind === "select_expr"
            ? expr.expr
          : { kind: "literal", value: null };
      return {
        kind: "computed",
        name,
        expr: {
          kind: "select_expr",
          expr: {
            kind: "shape_projection",
            expr: baseExpr,
            shape,
          },
          clauses: {},
        },
        multi: true,
        required,
        cardinality,
        operation,
        origin: "explicit",
      };
    }

    const modifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
    return {
      kind: "computed",
      name,
      expr,
      multi: isMulti || undefined,
      required,
      cardinality,
      operation,
      origin: "explicit",
      ...modifiers,
    };
  }

  private parseComputedExpr(): ComputedExpr | BacklinkExpr {
    if (this.peek().kind === "at") {
      this.consume();
      return {
        kind: "field_ref",
        field: `@${this.expectName("Expected link property name after '@'").lexeme}`,
      };
    }

    if (this.isNameToken(this.peek()) && this.peekNext().kind === "dot") {
      const shortcutTerminators: Token["kind"][] = [
        "comma",
        "rbrace",
        "rparen",
        "kw_filter",
        "kw_order",
        "kw_limit",
        "kw_offset",
        "eof",
      ];
      const shortcutContinuations: Token["kind"][] = ["dot", "lbracket", "at", "lbrace"];
      const shortcut = this.attempt(() => {
        this.consume();
        this.consume();
        const fieldName = this.expectName("Expected field name after '.'").lexeme;
        if (shortcutContinuations.includes(this.peek().kind)) {
          let base: FreeObjectExpr = { kind: "field_access", expr: { kind: "current_item" }, field: fieldName };
          base = this.applyPostfixExprChain(base);
          if (!shortcutTerminators.includes(this.peek().kind)) {
            return undefined;
          }
          return { kind: "select_expr" as const, expr: base, clauses: {} };
        }
        if (!shortcutTerminators.includes(this.peek().kind)) {
          return undefined;
        }
        return {
          kind: "field_ref" as const,
          field: fieldName,
        };
      });
      if (shortcut) {
        return shortcut;
      }
    }

    const suffixMathExpr = this.parseFieldSuffixMathExpr();
    if (suffixMathExpr) {
      return suffixMathExpr;
    }

    const polymorphicExpr = this.parseComputedPolymorphicFieldExpr();
    if (polymorphicExpr) {
      return polymorphicExpr;
    }

    const dotExpr = this.parseComputedDotRefExpr();
    if (dotExpr) {
      return dotExpr;
    }

    const subqueryExpr = this.parseComputedSubqueryExpr();
    if (subqueryExpr) {
      return subqueryExpr;
    }

    const fnExpr = this.parseComputedFunctionCallExpr();
    if (fnExpr) {
      return fnExpr;
    }

    const generalExpr = this.tryParseComputedFreeObjectExpr();
    if (generalExpr) {
      return generalExpr;
    }

    return this.parseComputedLiteralOrBindingExpr();
  }

  private tryParseComputedFreeObjectExpr(): ComputedExpr | undefined {
    const token = this.peek();
    const nextKind = this.peekNext().kind;
    const boundaryKinds: Token["kind"][] = ["comma", "rbrace", "rparen", "eof"];
    const nameStartsGeneralExpr = this.isNameToken(token) && !boundaryKinds.includes(nextKind);
    const literalStartsGeneralExpr = ["number", "string", "bytes_string", "kw_true", "kw_false", "kw_null"].includes(token.kind)
      && !boundaryKinds.includes(nextKind);
    const startsGeneralExpr = token.kind === "kw_not" || token.kind === "kw_for" || token.kind === "kw_select" || token.kind === "kw_exists"
      || token.kind === "kw_distinct"
      || token.kind === "kw_detached"
      || token.kind === "lparen"
      || token.kind === "lbrace"
      || token.kind === "lbracket"
      || token.kind === "lt"
      || token.kind === "dot"
      || token.kind === "str_interp_start"
      || nameStartsGeneralExpr
      || literalStartsGeneralExpr;
    if (!startsGeneralExpr) {
      return undefined;
    }

    const parsed = this.attempt(() => {
      const expr = this.parseFreeObjectExpr();
      if (["comma", "rbrace", "rparen", "kw_filter", "kw_order", "kw_limit", "kw_offset", "eof"].includes(this.peek().kind)) {
        return {
          kind: "select_expr" as const,
          expr,
          clauses: {},
        };
      }
      return undefined;
    });
    return parsed;
  }

  private parseComputedPolymorphicFieldExpr(): ComputedExpr | undefined {
    if (this.peek().kind !== "lbracket") {
      return undefined;
    }

    if (this.peekNth(1).kind !== "kw_is") {
      return {
        kind: "literal",
        value: this.readScalarLikeValue(),
      };
    }

    return this.attempt(() => {
      const sourceTypeExpr = this.parseTypeFilter("polymorphic field reference");
      this.expect("dot", "Expected '.' after polymorphic type filter");
      const field = this.expectName("Expected field name after polymorphic type filter").lexeme;
      // Defer chained access (e.g. `[is T].link.name`) to the general expression
      // path so postfix chaining can build a full path_steps.
      if (this.peek().kind === "dot") {
        return undefined;
      }
      return {
        kind: "polymorphic_field_ref" as const,
        sourceType: simpleTypeName(sourceTypeExpr) ?? "",
        sourceTypeExpr,
        field,
      };
    });
  }

  private parseComputedDotRefExpr(): ComputedExpr | BacklinkExpr | undefined {
    if (this.peek().kind !== "dot" && this.peek().kind !== "backward_link") {
      return undefined;
    }
    // If the dot-chain is followed by a binary operator (`/`, `*`, `+`, `-`,
    // `%`, `??`, `=`, `!=`, `<`, …) we defer to the general computed-expr
    // parser so the whole binary expression compiles, instead of stopping at
    // the field ref. Scan ahead non-destructively.
    if (this.peek().kind === "dot") {
      let i = this.index + 1;
      // Skip a chain of `.fieldName` tokens.
      while (i + 1 < this.tokens.length
        && this.isNameToken(this.tokens[i]!)
        && this.tokens[i + 1]?.kind === "dot") {
        i += 2;
      }
      if (i < this.tokens.length && this.isNameToken(this.tokens[i]!)) {
        const afterChain = this.tokens[i + 1]?.kind;
        const continuesAsBinary: Array<Token["kind"]> = [
          "plus", "minus", "star", "slash",
          "coalesce", "equals", "not_equals", "lt", "gt", "lte", "gte",
        ];
        if (afterChain && continuesAsBinary.includes(afterChain)) {
          return undefined;
        }
      }
    }
    const op = this.peek().kind;
    this.consume();

    if (op === "backward_link" || this.peek().kind === "lt") {
      if (this.peek().kind === "lt") {
        this.consume();
      }
      const link = this.expectName("Expected backlink name after '.<'").lexeme;

      let sourceTypeExpr: TypeExpr | undefined;
      if (this.peek().kind === "lbracket") {
        sourceTypeExpr = this.parseTypeFilter("backlink type filter");
      }

      return {
        link,
        sourceType: simpleTypeName(sourceTypeExpr),
        sourceTypeExpr,
      };
    }

    const fieldName = this.expectName("Expected field name after '.'").lexeme;
    if (fieldName === "__type__") {
      if (this.peek().kind === "dot") {
        this.consume();
        const suffix = this.expectName("Expected 'name' after '__type__.'").lexeme;
        if (suffix !== "name") {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Expected '__type__.name'", token.line, token.column);
        }
      }
      return {
        kind: "type_name",
      };
    }

    // Chained access (e.g. `.key.element` or `.elements[is T].name`) — wrap as a
    // select_expr over a field_access chain so the downstream IR sees the full path.
    if (this.peek().kind === "dot" || this.peek().kind === "lbracket" || this.peek().kind === "at") {
      let chained: FreeObjectExpr = {
        kind: "field_access",
        expr: { kind: "current_item" },
        field: fieldName,
      };
      chained = this.applyPostfixExprChain(chained);
      return {
        kind: "select_expr",
        expr: chained,
        clauses: {},
      };
    }

    return {
      kind: "field_ref",
      field: fieldName,
    };
  }

  // If a computed shape entry's value starts with `.field` and is followed by
  // a math operator (`/`, `*`, `+`, `-`, `%`), `?`/`?=`/`?!=` etc., we need to
  // parse the rest of the expression too.

  private parseComputedSubqueryExpr(): ComputedExpr | undefined {
    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_with") {
      this.consume();
      const withClause = this.parseWithClause();
      this.expect("kw_select", "Expected 'select' in computed subquery expression");
      if (this.isNameToken(this.peek()) && (this.peekNext().kind === "lbrace" || this.peekNext().kind === "kw_filter" || this.peekNext().kind === "kw_order" || this.peekNext().kind === "kw_limit" || this.peekNext().kind === "kw_offset")) {
        const nested = this.parseInlineSelectExpr();
        nested.clauses = {
          ...nested.clauses,
          _withBindings: withClause.with,
          _withModule: withClause.withModule,
          _withModuleAliases: withClause.withModuleAliases,
        };
        this.expect("rparen", "Expected ')' after computed subquery expression");
        return {
          kind: "subquery",
          typeName: nested.typeName,
          shape: nested.shape,
          clauses: nested.clauses,
        };
      }

      const expr = this.parseFreeObjectExpr();
      const clauses = this.parseClauseChain();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "select_expr",
        expr,
        clauses: {
          ...clauses,
          _withBindings: withClause.with,
          _withModule: withClause.withModule,
          _withModuleAliases: withClause.withModuleAliases,
        },
      };
    }

    if (!this.atParenthesizedSelect()) {
      return undefined;
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select" && this.peekNth(2).kind === "dot") {
      this.consume();
      this.consume();
      const expr = this.parseFreeObjectExpr();
      const clauses = this.parseClauseChain();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "select_expr",
        expr,
        clauses,
      };
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select" && this.isNameToken(this.peekNth(2)) && this.peekNth(3).kind === "assign") {
      this.consume();
      const expr = this.parseSelectExprSubquery();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "select_expr",
        expr,
        clauses: {},
      };
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select") {
      this.consume();
      const expr = this.parseSelectExprSubquery();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "select_expr",
        expr,
        clauses: {},
      };
    }

    const nested = this.parseParenthesizedSelectQuery(
      "Expected 'select' in computed subquery expression",
      "Expected ')' after computed subquery expression",
    );
    return {
      kind: "subquery",
      typeName: nested.typeName,
      shape: nested.shape,
      clauses: nested.clauses,
    };
  }

  private parseComputedFunctionCallExpr(): ComputedExpr | undefined {
    if (!this.atFunctionCall()) {
      return undefined;
    }

    const call = this.parseFunctionCallExpr(true);
    if (this.peek().kind === "minus" && this.peekNext().kind === "number") {
      this.consume();
      const rhs = this.consume();
      const rhsValue = this.parseNumberLexeme(rhs.lexeme);
      return {
        kind: "function_call",
        call: {
          name: "__gel_subtract",
          args: [
            this.functionCallExpr(call),
            { kind: "literal", value: rhsValue },
          ],
        },
      };
    }

    return this.functionCallExpr(call);
  }

  private parseComputedLiteralOrBindingExpr(): ComputedExpr {
    if (this.isNameToken(this.peek())) {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    const thenValue = this.readScalarLikeValue();
    let baseArg: FunctionCallArgExpr = { kind: "literal", value: thenValue };
    if (this.peek().kind === "minus") {
      this.consume();
      const rhs = this.parseArithmeticLeafArg();
      baseArg = {
        kind: "function_call",
        call: {
          name: "__gel_subtract",
          args: [baseArg, rhs],
        },
      };
    }

    const conditionalArg = this.parseIfElseArg(baseArg);
    if (conditionalArg.kind === "function_call") {
      return this.functionCallExpr(conditionalArg.call);
    }

    if (conditionalArg.kind === "field_ref") {
      return {
        kind: "field_ref",
        field: conditionalArg.field,
      };
    }

    if (conditionalArg.kind === "binding_ref") {
      return {
        kind: "binding_ref",
        name: conditionalArg.name,
      };
    }

    return {
      kind: "literal",
      value: conditionalArg.kind === "literal" ? conditionalArg.value : null,
    };
  }

  private parseIfElseArg(initialThenArg: FunctionCallArgExpr): FunctionCallArgExpr {
    if (this.peek().kind !== "kw_if") {
      return initialThenArg;
    }
    this.consume();

    const conditionField = this.parseIfConditionField();
    this.expect("equals", "Expected '=' in IF condition");
    const conditionValue = this.readScalarValue();
    if (this.peek().kind !== "kw_else") {
      const token = this.peek();
      throw new AppError("E_SYNTAX", "Expected 'else' in IF expression", token.line, token.column);
    }
    this.consume();

    const elseArg = this.parseIfElseArg(this.parseIfElseLeafArg());
    return {
      kind: "function_call",
      call: {
        name: "__gel_if_eq",
        args: [
          { kind: "field_ref", field: conditionField },
          { kind: "literal", value: conditionValue },
          initialThenArg,
          elseArg,
        ],
      },
    };
  }

  private parseIfConditionField(): string {
    if (this.peek().kind === "dot") {
      this.consume();
      return this.expectName("Expected field name after '.' in IF condition").lexeme;
    }

    const first = this.expectName("Expected condition field in IF expression").lexeme;
    if (this.peek().kind === "dot") {
      this.consume();
      return this.expectName("Expected condition field after qualifier in IF expression").lexeme;
    }
    return first;
  }

  private parseIfElseLeafArg(): FunctionCallArgExpr {
    return this.parseFieldOrLiteralArg(
      "Expected field after '.' in IF expression",
      "Expected qualifier in IF expression",
      "Expected field name after qualifier in IF expression",
    );
  }

  private parseArithmeticLeafArg(): FunctionCallArgExpr {
    return this.parseFieldOrLiteralArg(
      "Expected field after '.' in arithmetic expression",
      "Expected qualifier in arithmetic expression",
      "Expected field name after qualifier in arithmetic expression",
    );
  }

  private parseFieldOrLiteralArg(
    dotFieldMessage: string,
    qualifierMessage: string,
    fieldAfterQualifierMessage: string,
  ): FunctionCallArgExpr {
    if (this.atFunctionCall()) {
      return this.functionCallExpr(this.parseFunctionCallExpr());
    }

    if (this.atDotField()) {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expectName(dotFieldMessage).lexeme,
      };
    }

    if (this.atQualifiedIdentifier()) {
      const { tail } = this.parseQualifiedIdentifier(qualifierMessage, fieldAfterQualifierMessage);
      return {
        kind: "field_ref",
        field: tail,
      };
    }

    return {
      kind: "literal",
      value: this.readScalarLikeValue(),
    };
  }

  private parseFieldSuffixMathExpr(): ComputedExpr | undefined {
    const parseSuffixRef = (): { field: string; fromEnd: number } | undefined => {
      return this.attempt(() => {
        if (this.peek().kind !== "lt") {
          return undefined;
        }
        this.consume();
        if (!this.isNameToken(this.peek())) {
          return undefined;
        }
        this.consume();
        if (this.peek().kind !== "gt") {
          return undefined;
        }
        this.consume();
        if (this.peek().kind !== "dot") {
          return undefined;
        }
        this.consume();
        if (!this.isNameToken(this.peek())) {
          return undefined;
        }
        const field = this.consume().lexeme;
        if (this.peek().kind !== "lbracket") {
          return undefined;
        }
        this.consume();
        if (this.peek().kind !== "minus") {
          return undefined;
        }
        this.consume();
        if (this.peek().kind !== "number") {
          return undefined;
        }
        const indexToken = this.consume().lexeme;
        if (this.peek().kind !== "rbracket") {
          return undefined;
        }
        this.consume();
        return { field, fromEnd: this.parseNumberLexeme(indexToken) };
      });
    };

    if (this.peek().kind === "number" && this.peekNext().kind === "minus") {
      return this.attempt(() => {
        const constantToken = this.consume().lexeme;
        this.consume();
        const ref = parseSuffixRef();
        if (!ref) {
          return undefined;
        }
        return {
          kind: "field_suffix_math",
          field: ref.field,
          fromEnd: ref.fromEnd,
          op: "const_minus",
          constant: this.parseNumberLexeme(constantToken),
        };
      });
    }

    if (this.peek().kind === "minus" && this.peekNext().kind === "lt") {
      return this.attempt(() => {
        this.consume();
        const ref = parseSuffixRef();
        if (!ref) {
          return undefined;
        }
        return {
          kind: "field_suffix_math",
          field: ref.field,
          fromEnd: ref.fromEnd,
          op: "negate",
        };
      });
    }

    return undefined;
  }

  private parseFunctionCallExpr(allowExpressionArgs = false): FunctionCallExpr {
    const name = this.parseQualifiedName("Expected function name");
    this.expect("lparen", "Expected '(' after function name");
    const args = this.parseDelimited(
      "rparen",
      () => this.parseFunctionCallArgExpr(allowExpressionArgs),
      "Expected ',' between function arguments",
    );
    this.expect("rparen", "Expected ')' after function arguments");
    return { name, args };
  }

  private parseFunctionCallArgExpr(allowExpressionArgs = false): FunctionCallArgExpr {
    if (allowExpressionArgs) {
      const parsedExpr = this.tryParseFreeObjectFunctionCallArgExpr();
      if (parsedExpr) {
        return parsedExpr;
      }
    }

    if (this.peek().kind === "lt") {
      return this.parseCastFunctionCallArgExpr();
    }

    if (this.atDotField()) {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expectName("Expected field after '.' in function argument").lexeme,
      };
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values = this.parseDelimited("rbrace", () => this.readScalarValue(), "Expected ',' in set literal function argument");
      this.expect("rbrace", "Expected '}' after set literal function argument");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values = this.parseDelimited("rbracket", () => this.readScalarValue(), "Expected ',' in array literal function argument");
      this.expect("rbracket", "Expected ']' after array literal function argument");
      return {
        kind: "array_literal",
        values,
      };
    }

    if (this.isNameToken(this.peek())) {
      return this.parseIdentifierFunctionCallArgExpr(allowExpressionArgs);
    }

    return {
      kind: "literal",
      value: this.readScalarValue(),
    };
  }

  private tryParseFreeObjectFunctionCallArgExpr(): FunctionCallArgExpr | undefined {
    const token = this.peek();
    if (this.isNameToken(token) && (this.peekNext().kind === "comma" || this.peekNext().kind === "rparen")) {
      return undefined;
    }
    const startsExpression =
      token.kind === "lparen"
      || token.kind === "lbrace"
      || token.kind === "lbracket"
      || token.kind === "lt"
      || token.kind === "dot"
      || token.kind === "backward_link"
      || token.kind === "optional_link"
      || this.isNameToken(token)
      || token.kind === "number"
      || token.kind === "string"
      || token.kind === "bytes_string"
      || token.kind === "kw_true"
      || token.kind === "kw_false"
      || token.kind === "kw_null"
      || token.kind === "kw_not"
      || token.kind === "kw_for"
      || token.kind === "kw_select"
      || token.kind === "kw_distinct"
      || token.kind === "kw_detached"
      || token.kind === "str_interp_start"
      || this.isExistsToken(token);
    if (!startsExpression) {
      return undefined;
    }

    const parsed = this.attempt(() => {
      let expr = this.parseFreeObjectExpr();
      let filter: FreeObjectExpr | undefined;
      if (this.peek().kind === "kw_filter") {
        this.consume();
        filter = this.parseFreeObjectExpr();
      }
      const orderBy = this.parseExprOrderBy();
      const { limit, offset } = this.parseExprPagination();
      if (filter || orderBy || limit !== undefined || offset !== undefined) {
        expr = {
          kind: "select_expr_subquery",
          expr,
          filter,
          orderBy,
          limit,
          offset,
        };
      }
      if (this.peek().kind === "comma" || this.peek().kind === "rparen") {
        return {
          kind: "expr" as const,
          expr,
        };
      }
      return undefined;
    });
    return parsed;
  }

  private parseCastFunctionCallArgExpr(): FunctionCallArgExpr {
    this.consume();
    let depth = 1;
    while (depth > 0 && this.peek().kind !== "eof") {
      const token = this.consume();
      if (token.kind === "lt") {
        depth += 1;
      } else if (token.kind === "gt") {
        depth -= 1;
      }
    }
    if (depth !== 0) {
      throw new AppError("E_SYNTAX", "Expected '>' after function argument cast type", this.peek().line, this.peek().column);
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values = this.parseDelimited("rbrace", () => this.readScalarValue(), "Expected ',' in cast set literal function argument");
      this.expect("rbrace", "Expected '}' after cast set literal function argument");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.isNameToken(this.peek())) {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.atDotField()) {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expectName("Expected field after '.' in cast function argument").lexeme,
      };
    }

    return {
      kind: "literal",
      value: this.readScalarValue(),
    };
  }

  private parseIdentifierFunctionCallArgExpr(allowExpressionArgs = false): FunctionCallArgExpr {
    if (this.atFunctionCall()) {
      return this.functionCallExpr(this.parseFunctionCallExpr(allowExpressionArgs));
    }

    if (this.atQualifiedIdentifier()) {
      const { tail } = this.parseQualifiedIdentifier(
        "Expected qualifier in function argument",
        "Expected field name after qualifier in function argument",
      );
      return {
        kind: "field_ref",
        field: tail,
      };
    }

    return {
      kind: "binding_ref",
      name: this.consume().lexeme,
    };
  }

  private isBacklinkExpr(expr: ComputedExpr | BacklinkExpr): expr is BacklinkExpr {
    return "link" in expr;
  }

  private parseInsert(ctx: ParseContext = {}, expectEof = true): InsertStatement {
    const start = this.expect("kw_insert", "Expected 'insert'");
    const typeName = this.parseQualifiedName("Expected type name");

    const values: Record<string, InsertValue> = {};
    if (this.peek().kind === "lbrace") {
      this.consume();
      for (const assignment of this.parseDelimited("rbrace", () => this.parseInsertAssignment(), "Expected ',' between assignments")) {
        values[assignment.field] = assignment.value;
      }
      this.expect("rbrace", "Expected '}' after assignments");
    }

    const conflict = this.parseInsertConflict();

    if (this.peek().kind === "semi") {
      this.consume();
    }

    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "insert",
      typeName,
      values,
      conflict,
      pos: {
        line: start.line,
        column: start.column,
      },
    };
  }

  private parseInsertAssignment(): { field: string; value: InsertValue } {
    const field = this.expectName("Expected field name").lexeme;
    this.expect("assign", "Expected ':=' after field name");
    return {
      field,
      value: this.parseInsertValue(),
    };
  }

  private parseUpdateAssignment(): { field: string; operation: "assign" | "append" | "subtract"; value: InsertValue } {
    const field = this.expectName("Expected field name").lexeme;
    const opToken = this.peek();
    if (opToken.kind !== "assign" && opToken.kind !== "add_assign" && opToken.kind !== "sub_assign") {
      throw new AppError("E_SYNTAX", "Expected assignment operator after field name", opToken.line, opToken.column);
    }
    this.consume();
    return {
      field,
      operation: opToken.kind === "add_assign" ? "append" : opToken.kind === "sub_assign" ? "subtract" : "assign",
      value: this.parseUpdateValue(),
    };
  }

  private parseUpdateValue(): InsertValue {
    const insertAttempt = this.attempt<InsertValue>(() => {
      const value = this.parseInsertValue();
      const next = this.peek().kind;
      if (next === "comma" || next === "rbrace") {
        return value;
      }
      return undefined;
    });
    if (insertAttempt !== undefined) {
      return insertAttempt;
    }
    const expr = this.parseFreeObjectExpr();
    return { kind: "expr", expr };
  }

  private parseInsertValue(): InsertValue {
    const first = this.parseInsertValueAtom();
    if (this.peek().kind !== "kw_union") {
      return first;
    }
    const operands: InsertValue[] = [];
    appendInsertValueOperand(operands, first);
    while (this.peek().kind === "kw_union") {
      this.consume();
      appendInsertValueOperand(operands, this.parseInsertValueAtom());
    }
    return { kind: "set", values: operands };
  }

  private parseInsertValueAtom(): InsertValue {
    if (this.peek().kind === "lt") {
      return this.parseCastInsertValue();
    }

    if (this.atFunctionCall()) {
      return this.parseInsertFunctionCallValue();
    }

    if (this.isNameToken(this.peek())) {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.peek().kind === "lparen") {
      return this.parseParenthesizedInsertValue();
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values = this.parseDelimited("rbracket", () => this.readScalarValue(), "Expected ',' in array literal");
      this.expect("rbracket", "Expected ']' after array literal");
      return {
        kind: "array_literal",
        values,
      };
    }

    if (this.peek().kind === "lbrace") {
      return this.parseInsertSetLiteralValue();
    }

    return this.readScalarValue();
  }

  private parseCastInsertValue(): InsertValue {
    this.consume();
    const castType = this.parseCastTypeName("Expected cast type");
    this.expect("gt", "Expected '>' after cast type");
    const inner = this.parseInsertValue();
    if (castType === "json" || castType === "std::json") {
      if (typeof inner === "string") {
        return JSON.stringify(inner);
      }
      if (typeof inner === "boolean" || typeof inner === "number" || inner === null) {
        return inner;
      }
    }
    return inner;
  }

  private parseInsertFunctionCallValue(): InsertValue {
    const call = this.parseFunctionCallExpr();
    if (call.name === "to_json") {
      if (call.args.length === 1 && call.args[0].kind === "literal") {
        return call.args[0].value;
      }
    }
    return this.functionCallExpr(call);
  }

  private parseParenthesizedInsertValue(): InsertValue {
    this.consume();
    const next = this.peek();
    if (next.kind === "kw_with") {
      const withClause = this.parseWithClause();
      this.expect("kw_select", "Expected 'select' after with clause in insert expression");
      const nested = this.parseInlineSelectExpr();
      this.expect("rparen", "Expected ')' after insert select expression");
      return {
        kind: "select",
        typeName: nested.typeName,
        shape: nested.shape,
        clauses: {
          ...nested.clauses,
          _withBindings: withClause.with,
          _withModule: withClause.withModule,
          _withModuleAliases: withClause.withModuleAliases,
        },
      };
    }
    if (next.kind === "kw_select") {
      this.consume();
      if (this.peek().kind === "lparen") {
        const parsed = this.attempt(() => {
          this.consume();
          if (this.peek().kind === "kw_detached") {
            this.consume();
          }
          const typeName = this.parseQualifiedName("Expected type name in parenthesized select expression");
          this.expect("rparen", "Expected ')' after select expression root");
          const clauses = this.parseClauseChain();
          return {
            kind: "select" as const,
            typeName,
            shape: [{ kind: "field" as const, name: "id", operation: "assign" as const, origin: "default" as const }],
            clauses,
          };
        });
        if (parsed) {
          this.expect("rparen", "Expected ')' after insert select expression");
          return parsed;
        }
      }
      const nested = this.parseInlineSelectExpr();
      this.expect("rparen", "Expected ')' after insert select expression");
      return nested;
    }
    if (next.kind === "kw_insert") {
      this.consume();
      const nested = this.parseNestedInsertExpr();
      this.expect("rparen", "Expected ')' after nested insert expression");
      return nested;
    }
    if (next.kind === "kw_for") {
      const forStmt = this.parseFor();
      this.expect("rparen", "Expected ')' after for expression");
      return forStmt;
    }

    return this.readTupleLiteralValue();
  }

  private parseInsertSetLiteralValue(): InsertValue {
    this.consume();
    const values = this.parseDelimited("rbrace", () => this.parseInsertValue(), "Expected ',' in set literal");
    this.expect("rbrace", "Expected '}' after set literal");
    return {
      kind: "set",
      values,
    };
  }

  private readTupleLiteralValue(): TupleLiteralValue {
    const items: TupleLiteralElementValue[] = [];
    const named: Record<string, TupleLiteralElementValue> = {};
    let hasNamed = false;

    while (this.peek().kind !== "rparen") {
      if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
        hasNamed = true;
        const key = this.consume().lexeme;
        this.consume();
        named[key] = this.readTupleLiteralElementValue();
      } else {
        if (hasNamed) {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Cannot mix unnamed and named tuple elements", token.line, token.column);
        }
        items.push(this.readTupleLiteralElementValue());
      }

      if (this.peek().kind === "comma") {
        this.consume();
      } else {
        break;
      }
    }

    this.expect("rparen", "Expected ')' after tuple literal");
    return {
      kind: "tuple_literal",
      values: hasNamed ? named : items,
    };
  }

  private readTupleLiteralElementValue(): TupleLiteralElementValue {
    if (this.peek().kind === "lparen") {
      this.consume();
      return this.readTupleLiteralValue().values;
    }
    return this.readScalarLikeValue();
  }

  private parseNestedInsertExpr(): { kind: "insert"; typeName: string; values: Record<string, InsertValue> } {
    const typeName = this.parseQualifiedName("Expected type name in nested insert");
    const values: Record<string, InsertValue> = {};
    if (this.peek().kind !== "lbrace") {
      return {
        kind: "insert",
        typeName,
        values,
      };
    }
    this.consume();
    for (const assignment of this.parseDelimited("rbrace", () => this.parseNestedInsertAssignment(), "Expected ',' between assignments")) {
      values[assignment.field] = assignment.value;
    }
    this.expect("rbrace", "Expected '}' after nested insert assignments");
    return {
      kind: "insert",
      typeName,
      values,
    };
  }

  private parseNestedInsertAssignment(): { field: string; value: InsertValue } {
    const field = this.expectName("Expected field name in nested insert").lexeme;
    this.expect("assign", "Expected ':=' after field name");
    return {
      field,
      value: this.parseInsertValue(),
    };
  }

  private parseInsertConflict(): InsertConflict | undefined {
    if (this.peek().kind !== "kw_unless") {
      return undefined;
    }

    this.consume();
    this.expect("kw_conflict", "Expected 'conflict' after 'unless'");

    let onField: string | undefined;
    if (this.peek().kind === "kw_on") {
      this.consume();
      this.expect("dot", "Expected '.' in conflict target");
      onField = this.expectName("Expected field name in conflict target").lexeme;
    }

    let elseExpr: InsertConflict["else"];
    if (this.peek().kind === "kw_else") {
      this.consume();
      this.expect("lparen", "Expected '(' after else");
      if (this.peek().kind === "kw_select") {
        this.consume();
        elseExpr = this.parseInlineSelectExpr();
      } else if (this.peek().kind === "kw_update") {
        elseExpr = this.parseInlineUpdateExpr();
      } else {
        const token = this.peek();
        throw new AppError("E_SYNTAX", "Expected select or update expression in else clause", token.line, token.column);
      }
      this.expect("rparen", "Expected ')' after else expression");
    }

    return {
      onField,
      else: elseExpr,
    };
  }

  private parseInlineUpdateExpr(): { kind: "update"; typeName: string; filter?: FilterExpr; values: Record<string, ScalarValue> } {
    this.expect("kw_update", "Expected 'update' in else expression");
    const typeName = this.parseQualifiedName("Expected type name in update expression");

    let filter: FilterExpr | undefined;
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    this.expect("kw_set", "Expected 'set' in update expression");
    this.expect("lbrace", "Expected '{' after 'set'");
    const values: Record<string, ScalarValue> = {};
    for (const assignment of this.parseDelimited("rbrace", () => this.parseInlineUpdateAssignment(), "Expected ',' between assignments")) {
      values[assignment.field] = assignment.value;
    }
    this.expect("rbrace", "Expected '}' after assignments");
    return {
      kind: "update",
      typeName,
      filter,
      values,
    };
  }

  private parseInlineUpdateAssignment(): { field: string; value: ScalarValue } {
    const field = this.expectName("Expected field name in update expression").lexeme;
    this.expect("assign", "Expected ':=' after field name");
    return {
      field,
      value: this.readScalarLikeValue(),
    };
  }

  private parseUpdate(ctx: ParseContext = {}, expectEof = true): UpdateStatement {
    const start = this.expect("kw_update", "Expected 'update'");
    let target: FreeObjectExpr | undefined;
    let typeName: string;
    if (this.peek().kind === "lbrace" || this.peek().kind === "lparen" || (this.isNameToken(this.peek()) && this.peekNext().kind === "lbracket")) {
      target = this.parseFreeObjectExpr();
      typeName = this.deleteTargetRootTypeName(target);
    } else {
      typeName = this.parseQualifiedName("Expected type name");
    }

    let filter: UpdateStatement["filter"];
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    this.expect("kw_set", "Expected 'set' in update statement");
    this.expect("lbrace", "Expected '{' after 'set'");

    const values: Record<string, InsertValue> = {};
    const operations: NonNullable<UpdateStatement["operations"]> = {};
    for (const assignment of this.parseDelimited("rbrace", () => this.parseUpdateAssignment(), "Expected ',' between assignments")) {
      values[assignment.field] = assignment.value;
      operations[assignment.field] = assignment.operation;
    }

    this.expect("rbrace", "Expected '}' after assignments");

    if (this.peek().kind === "semi") {
      this.consume();
    }

    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "update",
      typeName,
      target,
      filter,
      values,
      operations: Object.keys(operations).length > 0 ? operations : undefined,
      pos: {
        line: start.line,
        column: start.column,
      },
    };
  }

  private parseDelete(ctx: ParseContext = {}, expectEof = true): DeleteStatement {
    const start = this.expect("kw_delete", "Expected 'delete'");
    let target: FreeObjectExpr | undefined;
    let typeName: string;
    if (this.peek().kind === "lbrace" || this.peek().kind === "lparen" || (this.isNameToken(this.peek()) && this.peekNext().kind === "lbracket")) {
      target = this.parseFreeObjectExpr();
      typeName = this.deleteTargetRootTypeName(target);
    } else {
      typeName = this.parseQualifiedName("Expected type name");
    }

    let filter: DeleteStatement["filter"];
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    if (this.peek().kind === "semi") {
      this.consume();
    }

    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "delete",
      typeName,
      target,
      filter,
      pos: {
        line: start.line,
        column: start.column,
      },
    };
  }

  private deleteTargetRootTypeName(target: FreeObjectExpr): string {
    if (target.kind === "path_steps") {
      const first = target.steps[0];
      if (first?.kind === "object_ref") {
        return first.name;
      }
    }
    if (target.kind === "select") {
      return target.typeName;
    }
    if (target.kind === "shape_projection") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "set_expr" && target.values.length > 0) {
      return this.deleteTargetRootTypeName(target.values[0]);
    }
    if (target.kind === "path") {
      return target.head;
    }
    if (target.kind === "path_chain") {
      return target.parts[0];
    }
    if (target.kind === "binding_ref") {
      return target.name;
    }
    if (target.kind === "is_type") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "distinct") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "cast") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "field_access") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    const token = this.peek();
    throw new AppError("E_SYNTAX", "Expected type name in delete target", token.line, token.column);
  }

  private parseFilter(): FilterExpr {
    this.expect("kw_filter", "Expected 'filter'");
    return this.parseOrFilterExpr();
  }

  private parseOrFilterExpr(): FilterExpr {
    let left = this.parseAndFilterExpr();
    while (this.peek().kind === "kw_or") {
      this.consume();
      left = {
        kind: "or",
        left,
        right: this.parseAndFilterExpr(),
      };
    }

    return left;
  }

  private parseAndFilterExpr(): FilterExpr {
    let left = this.parseUnaryFilterExpr();
    while (this.peek().kind === "kw_and") {
      this.consume();
      left = {
        kind: "and",
        left,
        right: this.parseUnaryFilterExpr(),
      };
    }

    return left;
  }

  private parseUnaryFilterExpr(): FilterExpr {
    if (this.peek().kind === "kw_not") {
      this.consume();
      return {
        kind: "not",
        expr: this.parseUnaryFilterExpr(),
      };
    }

    return this.parsePrimaryFilterExpr();
  }

  private parsePrimaryFilterExpr(): FilterExpr {
    if (this.peek().kind === "lparen") {
      this.consume();
      const inner = this.parseOrFilterExpr();
      this.expect("rparen", "Expected ')' to close filter expression");
      return inner;
    }

    if (["kw_true", "kw_false", "kw_null", "number", "string", "bytes_string", "lbrace", "lbracket"].includes(this.peek().kind)) {
      return {
        kind: "free_expr",
        expr: this.parseFreeObjectExpr(),
      };
    }

    if (this.isExistsToken(this.peek())) {
      const savedIndex = this.index;
      this.consume();
      const lookahead = this.peek();
      const useFreeExpr =
        lookahead.kind === "lparen"
        || (this.isNameToken(lookahead) && this.peekNext().kind === "dot")
        || (this.isNameToken(lookahead) && this.peekNext().kind === "backward_link")
        || (this.isNameToken(lookahead) && this.peekNext().kind === "at")
        || lookahead.kind === "kw_select"
        || lookahead.kind === "kw_with"
        || lookahead.kind === "kw_for"
        || lookahead.kind === "kw_distinct";
      if (useFreeExpr) {
        this.index = savedIndex;
        const expr = this.parseFreeObjectExpr();
        return {
          kind: "free_expr",
          expr,
        };
      }
      return {
        kind: "predicate",
        target: this.parseFilterTarget(),
        op: "=",
        value: true,
      };
    }

    if (this.isNameToken(this.peek()) && this.peek().lexeme.toLowerCase() === "any" && this.peekNext().kind === "lparen") {
      this.consume();
      this.consume();
      if (this.peek().kind === "lparen" || this.peek().kind === "kw_for") {
        const expr = this.parseFreeObjectExpr();
        this.expect("rparen", "Expected ')' after any() filter");
        return {
          kind: "free_expr",
          expr,
        };
      }
      const target = this.parseFilterTarget();
      const opToken = this.peek();
      const op = opToken.kind === "kw_like" ? "like" : opToken.kind === "kw_ilike" ? "ilike" : undefined;
      if (!op) {
        throw new AppError("E_SYNTAX", "Expected LIKE or ILIKE in any() filter", opToken.line, opToken.column);
      }
      this.consume();
      const values = this.parseInPredicateValues();
      this.expect("rparen", "Expected ')' after any() filter");
      if (values.kind !== "set_literal") {
        throw new AppError("E_SYNTAX", "Expected set literal in any() filter", opToken.line, opToken.column);
      }
      return values.values
        .map((value): FilterExpr => ({ kind: "predicate", target, op, value }))
        .reduce((left, right): FilterExpr => ({ kind: "or", left, right }));
    }

    const beforeTarget = this.index;
    const target = this.parseFilterTarget();
    // If the target is a path rooted at a local binding (e.g. FOR variable),
    // the simple predicate form doesn't apply — `user.name` isn't a field on
    // the current row. Rewind and parse the whole predicate as a free_expr.
    if (target.kind === "field" && target.field.includes(".")) {
      const head = target.field.split(".")[0]!;
      if (this.localBindings.includes(head)) {
        this.index = beforeTarget;
        const expr = this.parseFreeObjectExpr();
        return { kind: "free_expr", expr };
      }
    }
    const token = this.peek();
    if (["kw_and", "kw_or", "kw_order", "kw_limit", "kw_offset", "rparen", "semi", "eof"].includes(token.kind)) {
      return {
        kind: "predicate",
        target,
        op: "=",
        value: true,
      };
    }
    let op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
    if (token.kind === "equals") {
      this.consume();
      op = "=";
    } else if (token.kind === "not_equals") {
      this.consume();
      op = "!=";
    } else if (token.kind === "kw_like") {
      this.consume();
      op = "like";
    } else if (token.kind === "kw_ilike") {
      this.consume();
      op = "ilike";
    } else if (token.kind === "lt") {
      this.consume();
      op = "<";
    } else if (token.kind === "lte") {
      this.consume();
      op = "<=";
    } else if (token.kind === "gt") {
      this.consume();
      op = ">";
    } else if (token.kind === "gte") {
      this.consume();
      op = ">=";
    } else if (token.kind === "not_distinct_from") {
      this.consume();
      op = "?=";
    } else if (token.kind === "distinct_from") {
      this.consume();
      op = "?!=";
    } else if (token.kind === "kw_in") {
      this.consume();
      const values = this.parseInPredicateValues();
      return {
        kind: "in_predicate",
        target,
        op: "in",
        values,
      };
    } else if (token.kind === "kw_not") {
      this.consume();
      this.expect("kw_in", "Expected 'IN' after 'NOT' in filter");
      const values = this.parseInPredicateValues();
      return {
        kind: "in_predicate",
        target,
        op: "not_in",
        values,
      };
    } else if (
      token.kind === "plus"
      || token.kind === "minus"
      || token.kind === "star"
      || token.kind === "slash"
      || token.kind === "floor_div"
      || token.kind === "modulo"
      || token.kind === "pow"
      || token.kind === "concat"
      || token.kind === "lbracket"
    ) {
      // Arithmetic / string-concat / indexing continues the LHS expression. Rewind
      // and parse the whole predicate as a FreeObjectExpr so we can
      // capture `.field[op] cmp value` etc.
      this.index = beforeTarget;
      const expr = this.parseFreeObjectExpr();
      return { kind: "free_expr", expr };
    } else {
      throw new AppError("E_SYNTAX", "Expected filter operator (=, !=, like, ilike, IN, NOT IN)", token.line, token.column);
    }

    if (this.peek().kind === "lt" || this.peek().kind === "lparen") {
      // Complex RHS like `<int64>v.0` or `(x)` — rewind to predicate start and
      // parse as free_expr so the runtime evaluator handles it.
      this.index = beforeTarget;
      const expr = this.parseFreeObjectExpr();
      return { kind: "free_expr", expr };
    }
    return {
      kind: "predicate",
      target,
      op,
      value: this.readFilterValue(),
    };
  }

  private parseInPredicateValues():
    | { kind: "set_literal"; values: ScalarValue[] }
    | { kind: "select"; query: { typeName: string; shape: ShapeElement[]; clauses: ClauseChain } }
    | { kind: "name"; name: string }
    | { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } {
    const token = this.peek();
    // Handle DISTINCT keyword before set literal
    if (token.kind === "kw_distinct") {
      this.consume();
    }
    if (this.peek().kind === "lbrace") {
      this.consume();
      const values = this.parseDelimited("rbrace", () => this.readScalarValue(), "Expected ',' in IN filter values");
      this.expect("rbrace", "Expected '}' to close IN filter value set");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.atParenthesizedSelect()) {
      const query = this.parseParenthesizedSelectQuery(
        "Expected 'SELECT' in IN predicate subquery",
        "Expected ')' after IN predicate subquery",
      );
      return {
        kind: "select",
        query,
      };
    }

    if (this.isNameToken(this.peek())) {
      return {
        kind: "name",
        name: this.consume().lexeme,
      };
    }

    if (this.atBacklink()) {
      return this.parseBacklinkPropertyReference("IN filter");
    }

    throw new AppError("E_SYNTAX", "Expected set literal, identifier, or SELECT subquery in IN filter", token.line, token.column);
  }

  private parseFilterTarget(): { kind: "field"; field: string } | { kind: "backlink"; link: string; sourceType?: string } | { kind: "backlink_property"; link: string; sourceType?: string; property: string } {
    if (
      this.isNameToken(this.peek())
      && (
        (this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt")
        || this.peekNext().kind === "backward_link"
      )
    ) {
      this.consume();
      const backlink = this.parseBacklinkReference("filter");
      if (this.peek().kind === "at") {
        this.consume();
        return {
          kind: "backlink_property",
          ...backlink,
          property: this.expectName("Expected backlink link property name after '@'").lexeme,
        };
      }
      return {
        kind: "backlink",
        ...backlink,
      };
    }

    if (this.atBacklink()) {
      const backlink = this.parseBacklinkReference("filter");
      if (this.peek().kind === "at") {
        this.consume();
        return {
          kind: "backlink_property",
          ...backlink,
          property: this.expectName("Expected backlink link property name after '@'").lexeme,
        };
      }
      return {
        kind: "backlink",
        ...backlink,
      };
    }

    return {
      kind: "field",
      field: this.parseFieldReference("filter"),
    };
  }

  private parseBacklinkReference(context: string): { link: string; sourceType?: string; sourceTypeExpr?: TypeExpr } {
    if (this.peek().kind === "backward_link") {
      this.consume();
    } else {
      this.consume();
      this.consume();
    }
    const link = this.expectName(`Expected backlink name after '.<' in ${context}`).lexeme;
    let sourceTypeExpr: TypeExpr | undefined;
    if (this.peek().kind === "lbracket") {
      sourceTypeExpr = this.parseTypeFilter("backlink type filter");
    }
    return { link, sourceType: simpleTypeName(sourceTypeExpr), sourceTypeExpr };
  }

  private parseBacklinkPropertyReference(context: string): { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } {
    const backlink = this.parseBacklinkReference(context);
    this.expect("at", "Expected '@' in backlink link property reference");
    return {
      kind: "backlink_property_ref",
      ...backlink,
      property: this.expectName("Expected backlink link property name after '@'").lexeme,
    };
  }

  private parseFieldReference(context: string): string {
    if (this.peek().kind === "at") {
      this.consume();
      return `@${this.expectName(`Expected link property name in ${context}`).lexeme}`;
    }

    if (this.peek().kind === "dot") {
      this.consume();
    }

    const parts = [this.expectName(`Expected field name in ${context}`).lexeme];
    while (this.peek().kind === "dot") {
      this.consume();
      parts.push(this.expectName(`Expected field name after qualifier in ${context}`).lexeme);
    }

    if (this.peek().kind === "at") {
      this.consume();
      parts.push(`@${this.expectName(`Expected link property name in ${context}`).lexeme}`);
    }

    if (parts.length === 2 && parts[0] === "__type__" && parts[1] === "name") {
      return "__type__.name";
    }

    if (parts.length >= 2 && this.isTypeLikeName(parts[0]!)) {
      return parts.slice(1).join(".");
    }

    return parts.join(".");
  }

  private readFilterValue(): ScalarValue | { kind: "binding_ref"; name: string } | { kind: "field_ref"; field: string } | { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } {
    if (this.atBacklink()) {
      return this.parseBacklinkPropertyReference("filter value");
    }

    if (this.peek().kind === "at" || this.peek().kind === "dot") {
      return {
        kind: "field_ref",
        field: this.parseFieldReference("filter value"),
      };
    }

    if (this.peek().kind === "parameter") {
      return {
        kind: "binding_ref",
        name: this.parseParameterLexeme(this.consume().lexeme),
      };
    }

    if (this.isNameToken(this.peek())) {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.isGlobalReservedToken(this.peek())) {
      return this.consume().lexeme;
    }

    return this.readScalarValue();
  }

  private parseWithClause(): ParseContext {
    this.expect("kw_with", "Expected 'with'");
    const bindings: WithBinding[] = [];
    const names = new Set<string>();
    const scopedBindingNames: string[] = [];
    const moduleAliases: WithModuleAlias[] = [];
    const aliasNames = new Set<string>();
    let withModule: string | undefined;

    try {
      while (true) {
        if (this.peek().kind === "kw_module") {
          const moduleToken = this.consume();
          if (withModule) {
            throw new AppError("E_SYNTAX", "Duplicate module selection in with block", moduleToken.line, moduleToken.column);
          }

          withModule = this.parseQualifiedName("Expected module name after 'module'");
        } else if (this.isNameToken(this.peek()) && this.peekNext().kind === "kw_as") {
          const aliasToken = this.consume();
          const alias = aliasToken.lexeme;
          if (aliasNames.has(alias)) {
            throw new AppError("E_SYNTAX", `Duplicate module alias '${alias}'`, aliasToken.line, aliasToken.column);
          }

          this.expect("kw_as", "Expected 'as' in module alias declaration");
          this.expect("kw_module", "Expected 'module' in module alias declaration");
          const module = this.parseQualifiedName("Expected module name in module alias declaration");
          moduleAliases.push({ alias, module });
          aliasNames.add(alias);
        } else if (this.isNameToken(this.peek())) {
          const name = this.expectName("Expected alias name in with block").lexeme;
          if (names.has(name)) {
            const token = this.peek();
            throw new AppError("E_SYNTAX", `Duplicate with binding '${name}'`, token.line, token.column);
          }
          names.add(name);
          this.expect("assign", "Expected ':=' in with binding");
          bindings.push({ name, value: this.parseWithBindingValue() });
          this.localBindings.push(name);
          scopedBindingNames.push(name);
        } else {
          break;
        }

        if (this.peek().kind !== "comma") {
          break;
        }
        this.consume();
      }

      return {
        with: bindings.length > 0 ? bindings : undefined,
        withModule,
        withModuleAliases: moduleAliases.length > 0 ? moduleAliases : undefined,
      };
    } finally {
      scopedBindingNames.forEach(() => {
        this.localBindings.pop();
      });
    }
  }

  private isWithBindingValueTerminator(): boolean {
    return [
      "comma",
      "eof",
      "semi",
      "kw_select",
      "kw_insert",
      "kw_update",
      "kw_delete",
      "kw_for",
      "kw_configure",
      "kw_group",
      "kw_create",
      "kw_alter",
      "kw_drop",
      "kw_start",
      "kw_commit",
      "kw_rollback",
    ].includes(this.peek().kind);
  }

  private preferLegacyWithBindingValue(expr: FreeObjectExpr): boolean {
    return expr.kind === "binding_ref"
      || expr.kind === "path"
      || expr.kind === "path_chain"
      || expr.kind === "backlink_path"
      || expr.kind === "select";
  }

  private tryParseWithBindingExpressionValue(allowLegacy = true): WithBindingValue | undefined {
    return this.attempt(() => {
      const expr = this.parseFreeObjectExpr();
      if (!this.isWithBindingValueTerminator()) {
        return undefined;
      }
      if (!allowLegacy && this.preferLegacyWithBindingValue(expr)) {
        return undefined;
      }
      return {
        kind: "subquery_expr" as const,
        expr,
      };
    });
  }

  private parseWithBindingValue(): WithBindingValue {
    if (this.peek().kind === "lparen" && ["kw_insert", "kw_update", "kw_delete"].includes(this.peekNext().kind)) {
      this.consume(); // lparen
      const kind = this.peek().kind;
      let statement: Statement;
      if (kind === "kw_insert") {
        statement = this.parseInsert({}, false);
      } else if (kind === "kw_update") {
        statement = this.parseUpdate({}, false);
      } else {
        statement = this.parseDelete({}, false);
      }
      this.expect("rparen", "Expected ')' after parenthesized mutation statement");
      return {
        kind: "subquery_statement",
        statement,
      };
    }

    if (this.peek().kind === "lparen") {
      const subqueryExpr = this.attempt(() => {
        this.consume();
        const expr = this.parseFreeObjectExpr();
        this.expect("rparen", "Expected ')' after with binding expression");
        if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link" || this.peek().kind === "at") {
          return {
            kind: "subquery_expr" as const,
            expr: this.parsePostfixChain(expr),
          };
        }
        return {
          kind: "subquery_expr" as const,
          expr,
        };
      });
      if (subqueryExpr) {
        return subqueryExpr;
      }
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select") {
      this.consume();
      const expr = this.parseSelectExprSubquery();
      this.expect("rparen", "Expected ')' after with subquery binding");
      if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link" || this.peek().kind === "at") {
        return {
          kind: "subquery_expr" as const,
          expr: this.parsePostfixChain(expr),
        };
      }
      return {
        kind: "subquery_expr" as const,
        expr,
      };
    }

    if (this.atParenthesizedSelect()) {
      const nested = this.parseParenthesizedSelectQuery(
        "Expected 'select' in with subquery binding",
        "Expected ')' after with subquery binding",
      );
      const baseExpr: FreeObjectExpr = {
        kind: "select_expr_subquery",
        expr: {
          kind: "select",
          typeName: nested.typeName,
          shape: nested.shape,
          clauses: nested.clauses,
        },
      };
      if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link" || this.peek().kind === "at") {
        return {
          kind: "subquery_expr",
          expr: this.parsePostfixChain(baseExpr),
        };
      }
      return {
        kind: "subquery",
        query: nested,
      };
    }

    if (this.peek().kind === "lbrace") {
      const exprBinding = this.attempt(() => {
        const expr = this.parseFreeObjectExpr();
        if (this.isWithBindingValueTerminator()) {
          return { kind: "subquery_expr" as const, expr };
        }
        return undefined;
      });
      if (exprBinding) {
        return exprBinding;
      }

      this.consume();
      const values = this.parseDelimited("rbrace", () => this.readScalarValue(), "Expected ',' in set literal with binding");
      this.expect("rbrace", "Expected '}' after set literal with binding");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values = this.parseDelimited("rbracket", () => this.readScalarValue(), "Expected ',' in array literal with binding");
      this.expect("rbracket", "Expected ']' after array literal with binding");
      return {
        kind: "array_literal",
        values,
      };
    }

    if (this.peek().kind === "parameter_and_type") {
      const token = this.consume();
      const split = token.lexeme.indexOf("$");
      const castType = token.lexeme.slice(1, split - 1);
      const name = token.lexeme.slice(split + 1).replace(/^`|`$/g, "");
      return {
        kind: "parameter",
        name,
        castType: castType as ScalarType,
      };
    }

    const typedParameter = this.attempt(() => {
      if (this.peek().kind !== "lt") {
        return undefined;
      }
      this.consume();
      const castType = this.parseQualifiedName("Expected scalar type in parameter cast");
      this.expect("gt", "Expected '>' after parameter cast");
      this.expect("dollar", "Expected '$' before parameter name");
      const name = this.expectName("Expected parameter name after '$'").lexeme;
      return {
        kind: "parameter" as const,
        name,
        castType: castType as ScalarType,
      };
    });
    if (typedParameter) {
      return typedParameter;
    }

    if (this.peek().kind === "parameter") {
      return {
        kind: "parameter",
        name: this.consume().lexeme.slice(1),
      };
    }

    const expressionBinding = this.tryParseWithBindingExpressionValue(false);
    if (expressionBinding) {
      return expressionBinding;
    }

    if (this.peek().kind === "kw_detached" && this.isNameToken(this.peekNext())) {
      this.consume();
      const typeName = this.consume().lexeme;
      return {
        kind: "subquery",
        query: {
          typeName,
          shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
          clauses: {},
        },
      };
    }

    if (this.isNameToken(this.peek())) {
      const name = this.peek().lexeme;
      if (this.peekNext().kind === "lbracket") {
        return {
          kind: "subquery_expr",
          expr: this.parseFreeObjectExpr(),
        };
      }

      if (this.localBindings.includes(name)) {
        return {
          kind: "subquery_expr",
          expr: this.parseFreeObjectExpr(),
        };
      }

      if (this.atInlineTypedSelect()) {
        return {
          kind: "subquery",
          query: this.parseInlineSelectExpr(),
        };
      }

      // `WITH x := cards::Card GROUP ...` — a bare qualified type name as the
      // binding value, with the binding terminating at the start of the next
      // statement. parseInlineSelectExpr handles the qualified name and gives
      // back a default-shape select; the binding terminator check guards us
      // from over-consuming non-binding tokens.
      if (this.peekNext().kind === "coloncolon") {
        const candidate = this.attempt(() => {
          const nested = this.parseInlineSelectExpr();
          if (!this.isWithBindingValueTerminator()) {
            return undefined;
          }
          return { kind: "subquery" as const, query: nested };
        });
        if (candidate) {
          return candidate;
        }
      }

      if ((this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt") || this.peekNext().kind === "backward_link") {
        this.consume();
        if (this.peek().kind === "dot") {
          this.consume();
          this.consume();
        } else {
          this.consume();
        }
        const link = this.expectName("Expected backlink name after '.<' in with binding").lexeme;
        let sourceTypeExpr: TypeExpr | undefined;
        if (this.peek().kind === "lbracket") {
          sourceTypeExpr = this.parseTypeFilter("backlink type filter");
        }
        return { kind: "backlink_path", head: name, link, sourceType: simpleTypeName(sourceTypeExpr), sourceTypeExpr };
      }

      if (this.peekNext().kind === "dot") {
        const parts = [this.consume().lexeme];
        while (this.peek().kind === "dot" && this.isNameToken(this.peekNext())) {
          this.consume();
          parts.push(this.consume().lexeme);
        }
        if (parts.length === 2) {
          return { kind: "path", head: parts[0]!, tail: parts[1]!, steps: this.pathStepsFromParts(parts) };
        }
        return { kind: "path_chain", parts, steps: this.pathStepsFromParts(parts) };
      }

      if (this.atQualifiedIdentifier()) {
        const { head, tail } = this.parseQualifiedIdentifier(
          "Expected path head in with binding",
          "Expected path tail in with binding",
        );
        // Check for chained path: x.GREEN.MORE
        if (this.atDotField()) {
          const dotToken = this.peek();
          throw new AppError("E_SYNTAX", "invalid property reference on an expression of primitive type", dotToken.line, dotToken.column);
        }
        return { kind: "path", head, tail, steps: this.pathStepsFromParts([head, tail]) };
      }
      this.consume();
      return {
        kind: "binding_ref",
        name,
      };
    }

    const fallbackExpr = this.attempt(() => {
      const expr = this.parseFreeObjectExpr();
      if (this.isWithBindingValueTerminator()) {
        return {
          kind: "subquery_expr" as const,
          expr,
        };
      }
      return undefined;
    });
    if (fallbackExpr) {
      return fallbackExpr;
    }

    return {
      kind: "literal",
      value: this.readScalarValue(),
    };
  }

  private parseOrderBy(): { field: string; direction: "asc" | "desc" } {
    this.expect("kw_order", "Expected 'order'");
    this.expect("kw_by", "Expected 'by' after 'order'");
    return this.parseOrderTerm("order by");
  }

  private parseOrderTerm(context: string): OrderExpr {
    const field = this.parseFieldReference("order by");

    let direction: "asc" | "desc" = "asc";
    if (this.peek().kind === "kw_asc") {
      this.consume();
      direction = "asc";
    } else if (this.peek().kind === "kw_desc") {
      this.consume();
      direction = "desc";
    }

    let nullsPosition: "first" | "last" | undefined;
    if (this.peek().kind === "kw_empty") {
      this.consume();
      const nullsPositionToken = this.peek();
      if (this.isNameToken(nullsPositionToken)) {
        const lowered = nullsPositionToken.lexeme.toLowerCase();
        if (lowered === "first" || lowered === "last") {
          this.consume();
          nullsPosition = lowered;
        }
      }
    }

    let then: OrderExpr | undefined;
    if (this.peek().kind === "kw_then") {
      this.consume();
      then = this.parseOrderTerm(context);
    }

    return { field, direction, nullsPosition, then };
  }

  private parseClauseChain(): ClauseChain {
    const clauses: ClauseChain = {};
    let stage = 0;

    while (true) {
      const token = this.peek();
      if (token.kind === "kw_filter") {
        if (stage > 0) {
          throw new AppError("E_SYNTAX", "'filter' must appear before ordering and pagination", token.line, token.column);
        }
        clauses.filter = this.parseFilter();
        stage = 1;
        continue;
      }

      if (token.kind === "kw_order") {
        if (stage > 1) {
          throw new AppError("E_SYNTAX", "'order by' must appear before offset/limit", token.line, token.column);
        }
        clauses.orderBy = this.parseOrderBy();
        stage = 2;
        continue;
      }

      if (token.kind === "kw_offset") {
        if (stage > 2) {
          throw new AppError("E_SYNTAX", "'offset' must appear before 'limit'", token.line, token.column);
        }
        this.consume();
        clauses.offset = this.readInteger("Expected integer after 'offset'");
        stage = 3;
        continue;
      }

      if (token.kind === "kw_limit") {
        this.consume();
        clauses.limit = this.readInteger("Expected integer after 'limit'");
        stage = 4;
        continue;
      }

      return clauses;
    }
  }

  private parseTypeFilter(context: string): TypeExpr {
    this.expect("lbracket", `Expected '[' for ${context}`);
    this.expect("kw_is", `Expected 'is' in ${context}`);
    const expr = this.parseTypeExpr(context);
    this.expect("rbracket", `Expected ']' after ${context}`);
    return expr;
  }

  // type_expr := type_intersect_expr ('|' type_intersect_expr)*
  // type_intersect_expr := type_atom ('&' type_atom)*
  // type_atom := qualified_name | '(' type_expr ')'
  private parseTypeExpr(context: string): TypeExpr {
    let left = this.parseTypeIntersectExpr(context);
    while (this.peek().kind === "pipe") {
      this.consume();
      const right = this.parseTypeIntersectExpr(context);
      left = { kind: "type_union", left, right };
    }
    return left;
  }

  private parseTypeIntersectExpr(context: string): TypeExpr {
    let left = this.parseTypeAtom(context);
    while (this.peek().kind === "ampersand") {
      this.consume();
      const right = this.parseTypeAtom(context);
      left = { kind: "type_intersection", left, right };
    }
    return left;
  }

  private parseTypeAtom(context: string): TypeExpr {
    if (this.peek().kind === "lparen") {
      this.consume();
      const expr = this.parseTypeExpr(context);
      this.expect("rparen", `Expected ')' in ${context}`);
      return expr;
    }
    const name = this.parseQualifiedName(`Expected type name in ${context}`);
    return { kind: "type_name", name };
  }

  private parseSplatDepth(): 1 | 2 {
    this.expect("star", "Expected '*' in splat expression");
    if (this.peek().kind === "star") {
      this.consume();
      return 2;
    }

    return 1;
  }

  private clauseChainToShapeModifiers(clauses: ClauseChain): ShapeElementModifiers {
    const orderBy: OrderExpr[] = [];
    let cursor = clauses.orderBy;
    while (cursor) {
      orderBy.push({ field: cursor.field, direction: cursor.direction, then: undefined });
      cursor = cursor.then;
    }
    return {
      where: clauses.filter?.kind === "free_expr" ? clauses.filter.expr : undefined,
      orderBy: orderBy.length > 0 ? orderBy : undefined,
      offset: clauses.offset,
      limit: clauses.limit,
    };
  }

  private parseShapeEntryModifiers(): {
    required?: boolean;
    cardinality?: "one" | "many" | "unknown";
  } {
    let required: boolean | undefined;
    let cardinality: "one" | "many" | "unknown" | undefined;

    while (true) {
      const token = this.peek();
      if (token.kind === "kw_required") {
        this.consume();
        required = true;
        continue;
      }
      if (token.kind === "kw_optional") {
        this.consume();
        required = false;
        continue;
      }
      if (token.kind === "kw_multi") {
        this.consume();
        cardinality = "many";
        continue;
      }
      if (token.kind === "kw_single") {
        this.consume();
        cardinality = "one";
        continue;
      }
      break;
    }

    return { required, cardinality };
  }

  private pathStepsFromParts(parts: string[]): PathStep[] {
    if (parts.length === 0) {
      return [];
    }
    const [head, ...tail] = parts;
    const steps: PathStep[] = [{ kind: "object_ref", name: head! }];
    for (const field of tail) {
      steps.push({ kind: "ptr", name: field, direction: "outbound" });
    }
    return steps;
  }

  private headNameOfExpr(expr: FreeObjectExpr): string | undefined {
    if (expr.kind === "binding_ref") {
      return expr.name;
    }
    if (expr.kind === "path") {
      return expr.head;
    }
    if (expr.kind === "path_chain") {
      return expr.parts[0];
    }
    if (expr.kind === "path_steps") {
      const first = expr.steps[0];
      return first && first.kind === "object_ref" ? first.name : undefined;
    }
    return undefined;
  }

  private exprToPathSteps(expr: FreeObjectExpr): PathStep[] | undefined {
    if (expr.kind === "path_steps") {
      return [...expr.steps];
    }
    if (expr.kind === "path") {
      return expr.steps ? [...expr.steps] : this.pathStepsFromParts([expr.head, expr.tail]);
    }
    if (expr.kind === "path_chain") {
      return expr.steps ? [...expr.steps] : this.pathStepsFromParts(expr.parts);
    }
    if (expr.kind === "binding_ref") {
      return [{ kind: "object_ref", name: expr.name }];
    }
    if (expr.kind === "select") {
      return [{ kind: "object_ref", name: expr.typeName }];
    }
    if (expr.kind === "field_access") {
      const base = this.exprToPathSteps(expr.expr);
      if (!base) {
        return undefined;
      }
      return [...base, { kind: "ptr", name: expr.field, direction: "outbound", optional: expr.optional }];
    }
    if (expr.kind === "backlink_path") {
      return [
        { kind: "object_ref", name: "__current__" },
        { kind: "ptr", name: expr.link, direction: "inbound", optional: expr.optional },
      ];
    }
    return undefined;
  }

  private readValue(): ParsedLiteralValue {
    const token = this.peek();
    if (token.kind === "minus") {
      const next = this.peekNext();
      if (next.kind !== "number") {
        throw new AppError("E_SYNTAX", "Expected a numeric literal after '-'", token.line, token.column);
      }
      this.consume();
      this.consume();
      return -this.parseNumberLexeme(next.lexeme);
    }

    if (token.kind === "string") {
      this.consume();
      return token.lexeme;
    }

    if (token.kind === "str_interp_start") {
      throw new AppError("E_SYNTAX", "String interpolation is not allowed in literal-only context", token.line, token.column);
    }

    if (token.kind === "bytes_string") {
      this.consume();
      return token.lexeme;
    }

    if (token.kind === "number") {
      this.consume();
      const lexeme = token.lexeme;
      return this.parseNumberLexeme(lexeme);
    }

    if (token.kind === "kw_true") {
      this.consume();
      return true;
    }

    if (token.kind === "kw_false") {
      this.consume();
      return false;
    }

    if (token.kind === "kw_null") {
      this.consume();
      return null;
    }

    if (token.kind === "identifier") {
      const lowered = token.lexeme.toLowerCase();
      if (lowered === "true") {
        this.consume();
        return true;
      }
      if (lowered === "false") {
        this.consume();
        return false;
      }
      if (lowered === "null") {
        this.consume();
        return null;
      }
    }

    if (token.kind === "lbracket") {
      this.consume();
      const values: ParsedLiteralValue[] = [];
      while (this.peek().kind !== "rbracket") {
        values.push(this.readValue());
        if (this.peek().kind === "comma") {
          this.consume();
        } else {
          break;
        }
      }
      this.expect("rbracket", "Expected ']' after array literal");
      return values;
    }

    throw new AppError("E_SYNTAX", "Expected a literal value", token.line, token.column);
  }

  private readScalarValue(message = "Expected a literal value"): ScalarValue {
    if (this.peek().kind === "lbracket") {
      const token = this.peek();
      throw new AppError("E_SYNTAX", message, token.line, token.column);
    }

    const value = this.readValue();
    if (Array.isArray(value)) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", message, token.line, token.column);
    }

    return value;
  }

  private readScalarLikeValue(): ScalarValue {
    const value = this.readValue();
    if (Array.isArray(value)) {
      return JSON.stringify(value);
    }

    return value;
  }

  private readInteger(message: string): number {
    const token = this.peek();
    if (token.kind !== "number") {
      throw new AppError("E_SYNTAX", message, token.line, token.column);
    }

    if (!this.isIntegerLexeme(token.lexeme)) {
      throw new AppError("E_SYNTAX", message, token.line, token.column);
    }

    this.consume();
    return Number(token.lexeme);
  }

  private expect(kind: Token["kind"], message: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new AppError("E_SYNTAX", message, token.line, token.column);
    }

    this.index += 1;
    return token;
  }

  private consume(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private peekNext(): Token {
    return this.tokens[this.index + 1] ?? this.tokens[this.tokens.length - 1];
  }

  private peekNth(n: number): Token {
    return this.tokens[this.index + n] ?? this.tokens[this.tokens.length - 1];
  }
}

const appendInsertValueOperand = (operands: InsertValue[], value: InsertValue): void => {
  if (typeof value === "object" && value !== null && "kind" in value && (value as { kind: string }).kind === "set") {
    for (const inner of (value as { kind: "set"; values: InsertValue[] }).values) {
      appendInsertValueOperand(operands, inner);
    }
    return;
  }
  operands.push(value);
};

const parseSetModuleStatement = (input: string): string | undefined => {
  const tokens = tokenize(input).filter((token) => token.kind !== "eof");
  if (tokens[0]?.kind !== "kw_set" || tokens[1]?.kind !== "kw_module") {
    return undefined;
  }

  const isNameKind = (kind: Token["kind"] | undefined): boolean =>
    kind === "identifier" ||
    kind === "backtick_name" ||
    kind === "kw_unreserved" ||
    kind === "kw_partial_reserved" ||
    kind === "kw_future_reserved" ||
    kind === "kw_current_reserved" ||
    kind?.startsWith("kw_current_reserved_") === true;

  const parts: string[] = [];
  let i = 2;
  if (!isNameKind(tokens[i]?.kind)) {
    return undefined;
  }
  parts.push(tokens[i]!.lexeme);
  i += 1;

  while (true) {
    if (tokens[i]?.kind === "coloncolon" && isNameKind(tokens[i + 1]?.kind)) {
      parts.push(tokens[i + 1]!.lexeme);
      i += 2;
      continue;
    }
    if (tokens[i]?.kind === "colon" && tokens[i + 1]?.kind === "colon" && isNameKind(tokens[i + 2]?.kind)) {
      parts.push(tokens[i + 2]!.lexeme);
      i += 3;
      continue;
    }
    break;
  }

  if (tokens[i]?.kind === "semi") {
    i += 1;
  }

  return i === tokens.length ? parts.join("::") : undefined;
};

export const parseEdgeQL = (input: string, options: ParseEdgeQLOptions = {}): Statement => {
  const parser = new Parser(input, options);
  return parser.parseStatement();
};

export const parseEdgeQLScript = (input: string, options: ParseEdgeQLOptions = {}): Statement[] => {
  const statements: Statement[] = [];
  const tokens = tokenize(input);
  let activeModule = options.defaultModule;

  const lineStarts: number[] = [0];
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }

  const toIndex = (line: number, column: number): number => {
    const lineStart = lineStarts[line - 1] ?? 0;
    return lineStart + column - 1;
  };

  let startIndex = 0;
  let depth = 0;

  for (const token of tokens) {
    if (token.kind === "eof") {
      break;
    }

    if (token.kind === "semi" && depth === 0) {
      const endIndex = toIndex(token.line, token.column) + 1;
      const piece = input.slice(startIndex, endIndex).trim();
      if (piece.length > 0) {
        const setModule = parseSetModuleStatement(piece);
        if (setModule) {
          activeModule = setModule;
        } else {
          statements.push(parseEdgeQL(piece, { defaultModule: activeModule }));
        }
      }
      startIndex = endIndex;
      continue;
    }

    if (token.kind === "lbrace" || token.kind === "lparen" || token.kind === "lbracket") {
      depth += 1;
    } else if (token.kind === "rbrace" || token.kind === "rparen" || token.kind === "rbracket") {
      depth -= 1;
    }
  }

  const piece = input.slice(startIndex).trim();
  if (piece.length > 0) {
    const setModule = parseSetModuleStatement(piece);
    statements.push(parseEdgeQL(piece, { defaultModule: setModule }));
  }

  return statements;
};
