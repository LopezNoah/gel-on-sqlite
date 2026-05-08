import { AppError } from "../errors.js";
import type { ScalarType, ScalarValue } from "../types.js";
import type {
  BacklinkExpr,
  ClauseChain,
  ComputedExpr,
  DeleteStatement,
  FilterExpr,
  ForStatement,
  FunctionCallArgExpr,
  FunctionCallExpr,
  FreeObjectExpr,
  InsertConflict,
  InsertValue,
  InsertStatement,
  OrderExpr,
  SelectExprStatement,
  SelectFreeStatement,
  SelectStatement,
  ShapeElement,
  Statement,
  UpdateStatement,
  WithBinding,
  WithBindingValue,
  WithModuleAlias,
} from "./ast.js";
import type { Token } from "./tokenizer.js";
import { tokenize } from "./tokenizer.js";

interface ParseContext {
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
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

  private atFunctionCall(): boolean {
    return this.peek().kind === "identifier" && this.kindAfterQualifiedName() === "lparen";
  }

  private atQualifiedIdentifier(): boolean {
    return this.peek().kind === "identifier" && this.kindAfterQualifiedName() === "dot";
  }

  private atDotField(): boolean {
    return this.peek().kind === "dot" && this.peekNext().kind === "identifier";
  }

  private atBacklink(): boolean {
    return this.peek().kind === "dot" && this.peekNext().kind === "lt";
  }

  private atParenthesizedSelect(): boolean {
    return this.peek().kind === "lparen" && (this.peekNext().kind === "kw_select" || this.peekNext().kind === "kw_with");
  }

  private atInlineTypedSelect(): boolean {
    if (this.peek().kind !== "identifier") {
      return false;
    }

    const nextKind = this.kindAfterQualifiedName();
    return nextKind === "lbrace" || nextKind === "kw_filter" || nextKind === "kw_limit" || nextKind === "kw_offset";
  }

  private isExistsToken(token: Token): boolean {
    return token.kind === "identifier" && token.lexeme.toLowerCase() === "exists";
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
    if (value.length === 0) {
      return false;
    }
    for (const ch of value) {
      if (ch < "0" || ch > "9") {
        return false;
      }
    }
    return true;
  }

  private parseQualifiedName(message: string): string {
    const parts = [this.expect("identifier", message).lexeme];
    while (this.peek().kind === "coloncolon") {
      this.consume();
      parts.push(this.expect("identifier", "Expected identifier after '::'").lexeme);
    }

    while (this.peek().kind === "colon" && this.peekNext().kind === "colon") {
      this.consume();
      this.consume();
      parts.push(this.expect("identifier", "Expected identifier after '::'").lexeme);
    }

    return parts.join("::");
  }

  private kindAfterQualifiedName(): Token["kind"] {
    if (this.peek().kind !== "identifier") {
      return this.peek().kind;
    }

    let i = this.index + 1;
    while (true) {
      if (this.tokens[i]?.kind === "coloncolon" && this.tokens[i + 1]?.kind === "identifier") {
        i += 2;
        continue;
      }
      if (this.tokens[i]?.kind === "colon" && this.tokens[i + 1]?.kind === "colon" && this.tokens[i + 2]?.kind === "identifier") {
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
    const tail = this.expect("identifier", tailMessage).lexeme;
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

    throw new AppError("E_SYNTAX", "Expected 'select', 'insert', 'update', 'delete', or 'for'", token.line, token.column);
  }

  private parseFor(ctx: ParseContext = {}): ForStatement {
    const start = this.expect("kw_for", "Expected 'for'");
    const variable = this.expect("identifier", "Expected variable name after 'for'").lexeme;
    this.expect("kw_in", "Expected 'in' after for variable");
    const iteratorExpr = this.parseFreeObjectIfElseExpr();
    if (this.peek().kind === "kw_union") {
      this.consume();
    }
    const hasParen = this.peek().kind === "lparen";
    if (hasParen) {
      this.consume();
    }
    const next = this.peek();
    let body: InsertStatement | SelectStatement | SelectExprStatement | SelectFreeStatement;
    body = this.withLocalBinding(variable, () => {
      if (next.kind === "kw_select") {
        const selectStart = this.consume();
        const freeOrExpr = this.parseSelectFreeOrExpr(selectStart, ctx, false);
        if (freeOrExpr) {
          return freeOrExpr;
        }
        return this.parseTypedSelect(selectStart, ctx, false);
      }
      return this.parseInsert(ctx, false);
    });
    if (hasParen) {
      this.expect("rparen", "Expected ')' after for body");
    }
    return {
      ...this.withContext(ctx),
      kind: "for",
      variable,
      iteratorExpr,
      body,
      pos: { line: start.line, column: start.column },
    };
  }

  private parseSelect(ctx: ParseContext = {}): SelectStatement | SelectFreeStatement | SelectExprStatement {
    const start = this.expect("kw_select", "Expected 'select'");
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
    if (this.peek().kind === "identifier" && this.peekNext().kind === "assign") {
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

    if (this.peek().kind === "lparen" || this.peek().kind === "lt" || this.peek().kind === "string" || this.atFunctionCall()) {
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

    if (this.peek().kind === "identifier" && this.peekNext().kind === "at") {
      const atToken = this.peekNext();
      throw new AppError("E_SYNTAX", "unexpected reference to link property", atToken.line, atToken.column);
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt") {
      const backlinkToken = this.peekNth(2);
      const linkName = this.peekNth(3).lexeme;
      const headName = this.peek().lexeme;
      if (this.isEnumLikeName(headName)) {
        throw new AppError("E_SYNTAX", "enum types do not support backlinks", backlinkToken.line, backlinkToken.column);
      }
      throw new AppError("E_SYNTAX", `cannot follow backlink '${linkName}'`, backlinkToken.line, backlinkToken.column);
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "lbracket") {
      const lbracketToken = this.peekNext();
      this.consume();
      this.consume();
      if (this.peek().kind === "kw_is") {
        this.consume();
        this.parseQualifiedName("Expected type name in type filter");
        this.expect("rbracket", "Expected ']' after type filter");
        if (this.peek().kind === "dot") {
          const dotToken = this.peek();
          throw new AppError("E_SYNTAX", "an enum member name must follow enum type name in the path", dotToken.line, dotToken.column);
        }
      }
      throw new AppError("E_SYNTAX", "Unexpected tokens after statement", lbracketToken.line, lbracketToken.column);
    }

    if (this.atQualifiedIdentifier()) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (ctx.with && ctx.with.length > 0 && this.peek().kind === "identifier" && this.peekNext().kind !== "lbrace") {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.peek().kind === "identifier" && (this.peekNext().kind === "semi" || this.peekNext().kind === "eof")) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    return undefined;
  }

  private parseTypedSelect(start: Token, ctx: ParseContext, expectEof: boolean): SelectStatement {
    const typeName = this.parseQualifiedName("Expected type name");

    const shape: ShapeElement[] = [{ kind: "field", name: "id" }];
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

  private parseSelectExprTail(start: Token, ctx: ParseContext, expr: FreeObjectExpr, expectEof = true): SelectExprStatement {
    const orderBy = this.parseExprOrderBy();
    const pagination = this.parseExprPagination();
    const paginatedExpr: FreeObjectExpr = pagination.limit !== undefined || pagination.offset !== undefined
      ? {
          kind: "select_expr_subquery",
          expr,
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
      const name = this.expect("identifier", "Expected free object field name").lexeme;
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
        kind: "or",
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
        kind: "and",
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
        kind: "not",
        expr: this.parseFreeObjectNotExpr(),
      };
    }
    return this.parseFreeObjectComparisonExpr();
  }

  private parseFreeObjectComparisonExpr(): FreeObjectExpr {
    let left = this.parseFreeObjectExprWithPrecedence();

    while (true) {
      const token = this.peek();
      if (token.kind !== "equals" && token.kind !== "not_equals" && token.kind !== "gt" && token.kind !== "lt") {
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
              : "<",
        left,
        right,
      };
    }

    return left;
  }

  private parseFreeObjectPrimaryExpr(): FreeObjectExpr {
    if (this.peek().kind === "lparen") {
      this.consume();
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
        expr: this.parseFreeObjectPrimaryExpr(),
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
      const binders: Array<{ variable: string; iterator: FreeObjectExpr }> = [];
      while (this.peek().kind === "kw_for") {
        this.consume();
        const variable = this.expect("identifier", "Expected variable name after 'for'").lexeme;
        this.expect("kw_in", "Expected 'in' after for variable");
        const iterator = this.parseFreeObjectIfElseExpr();
        binders.push({ variable, iterator });
      }
      if (this.peek().kind === "kw_union") {
        this.consume();
      }
      this.expect("kw_select", "Expected 'select' after for iterator");
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
            body: parseBody(index + 1),
          };
        });
      };
      const first = binders[0]!;
      return {
        kind: "for_expr",
        variable: first.variable,
        iterator: first.iterator,
        body: parseBody(0),
      };
    }

    if (this.peek().kind === "kw_select") {
      return this.parseSelectExprSubquery();
    }

    if (this.peek().kind === "lt") {
      this.consume();
      const castType = this.parseQualifiedName("Expected type name in cast");
      this.expect("gt", "Expected '>' after cast type");
      const expr = this.parseFreeObjectPostfixExpr();
      return { kind: "cast", castType, expr };
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values = this.parseDelimited("rbrace", () => this.parseFreeObjectExpr(), "Expected ',' in set literal");
      this.expect("rbrace", "Expected '}' after set literal");
      if (values.every((v) => v.kind === "literal")) {
        return { kind: "set_literal", values: values.map((v) => (v as { kind: "literal"; value: ScalarValue }).value) };
      }
      return { kind: "set_expr", values };
    }

    if (this.peek().kind === "dot") {
      this.consume();
      if (this.peek().kind === "lt") {
        this.consume();
        const link = this.expect("identifier", "Expected backlink name after '.<'").lexeme;
        let sourceType: string | undefined;
        if (this.peek().kind === "lbracket") {
          sourceType = this.parseTypeFilter("backlink type filter");
        }
        return {
          kind: "backlink_path",
          link,
          sourceType,
        };
      }
      if (this.peek().kind === "number") {
        const indexToken = this.consume();
        return {
          kind: "index_access",
          expr: { kind: "current_item" },
          index: Number(indexToken.lexeme.endsWith("n") ? indexToken.lexeme.slice(0, -1) : indexToken.lexeme),
        };
      }

      const field = this.expect("identifier", "Expected field name after '.'").lexeme;
      return {
        kind: "field_access",
        expr: { kind: "current_item" },
        field,
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
        return { kind: "path", head: qualified.head, tail: qualified.tail };
      }
    }

    if (this.peek().kind === "identifier") {
      if (this.atInlineTypedSelect()) {
        return this.parseInlineSelectExpr();
      }
      const identifier = this.peek().lexeme;
      if (this.localBindings.includes(identifier)) {
        return {
          kind: "binding_ref",
          name: this.consume().lexeme,
        };
      }
      if (this.isTypeLikeName(identifier)) {
        this.consume();
        return {
          kind: "select",
          typeName: identifier,
          shape: [{ kind: "field", name: "id" }],
          clauses: {},
        };
      }
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    return {
      kind: "literal",
      value: this.readScalarLikeValue(),
    };
  }

  private parseFreeObjectPostfixExpr(): FreeObjectExpr {
    let expr = this.parseFreeObjectPrimaryExpr();

    while (true) {
      if (this.peek().kind === "dot") {
        this.consume();
        if (this.peek().kind === "lt") {
          this.consume();
          const link = this.expect("identifier", "Expected backlink name after '.<'").lexeme;
          let sourceType: string | undefined;
          if (this.peek().kind === "lbracket") {
            sourceType = this.parseTypeFilter("backlink type filter");
          }
          expr = {
            kind: "backlink_path",
            link,
            sourceType,
          };
        } else if (this.peek().kind === "number") {
          const indexToken = this.consume();
          expr = {
            kind: "index_access",
            expr,
            index: Number(indexToken.lexeme.endsWith("n") ? indexToken.lexeme.slice(0, -1) : indexToken.lexeme),
          };
        } else {
          const field = this.expect("identifier", "Expected field name after '.'").lexeme;
          expr = {
            kind: "field_access",
            expr,
            field,
          };
        }
        continue;
      }

      if (this.peek().kind === "at") {
        this.consume();
        const property = this.expect("identifier", "Expected link property name after '@'").lexeme;
        expr = {
          kind: "field_access",
          expr,
          field: `@${property}`,
        };
        continue;
      }

      if (this.peek().kind === "lbracket") {
        this.consume();
        const indexToken = this.expect("number", "Expected numeric index inside brackets");
        this.expect("rbracket", "Expected ']' after index access");
        expr = {
          kind: "index_access",
          expr,
          index: Number(indexToken.lexeme.endsWith("n") ? indexToken.lexeme.slice(0, -1) : indexToken.lexeme),
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

  private parseFreeObjectExprWithPrecedence(minPrecedence = 0): FreeObjectExpr {
    let left = this.parseFreeObjectPostfixExpr();

    while (true) {
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

      if (this.peek().kind === "plus") {
        const precedence = 30;
        if (precedence < minPrecedence) {
          break;
        }

        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        left = { kind: "math", op: "+", left, right };
        continue;
      }

      if (this.peek().kind === "kw_is") {
        const precedence = 10;
        if (precedence < minPrecedence) {
          break;
        }

        this.consume();
        const typeName = this.parseQualifiedName("Expected type name after 'is'");
        left = {
          kind: "is_type",
          expr: left,
          typeName,
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
    if (this.peek().kind === "identifier" && this.peekNext().kind === "assign") {
      alias = this.consume().lexeme;
      this.consume();
      expr = this.parseFreeObjectExpr();
    } else {
      expr = this.parseFreeObjectExpr();
    }

    const orderBy = this.parseExprOrderBy();
    const { limit, offset } = this.parseExprPagination();

    return {
      kind: "select_expr_subquery",
      alias,
      expr,
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

  private parseExprOrderBy(): { expr: FreeObjectExpr; direction: "asc" | "desc" } | undefined {
    if (this.peek().kind !== "kw_order") {
      return undefined;
    }
    this.consume();
    this.expect("kw_by", "Expected 'by' after 'order'");
    const expr = this.parseFreeObjectExpr();
    let direction: "asc" | "desc" = "asc";
    if (this.peek().kind === "kw_asc") {
      this.consume();
      direction = "asc";
    } else if (this.peek().kind === "kw_desc") {
      this.consume();
      direction = "desc";
    }
    return { expr, direction };
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
    const shape: ShapeElement[] = [{ kind: "field", name: "id" }];
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
    if (this.peek().kind === "at") {
      this.consume();
      const property = this.expect("identifier", "Expected link property name after '@'").lexeme;
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
      };
    }

    if (this.peek().kind === "star") {
      return {
        kind: "splat",
        depth: this.parseSplatDepth(),
      };
    }

    if (this.peek().kind === "lbracket") {
      const sourceType = this.parseTypeFilter("splat type intersection");
      this.expect("dot", "Expected '.' after type intersection in splat expression");
      return {
        kind: "splat",
        depth: this.parseSplatDepth(),
        sourceType,
        intersection: true,
      };
    }

    const isMulti = this.peek().kind === "identifier" && this.peek().lexeme.toLowerCase() === "multi" && this.peekNext().kind === "identifier";
    if (isMulti) {
      this.consume();
    }

    const name = this.expect("identifier", "Expected selected field or computed alias").lexeme;

    if (this.peek().kind === "dot" && this.peekNext().kind === "star") {
      this.consume();
      return {
        kind: "splat",
        depth: this.parseSplatDepth(),
        sourceType: name,
      };
    }

    let typeFilter: string | undefined;
    if (this.peek().kind === "lbracket") {
      typeFilter = this.parseTypeFilter("shape type filter");
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

      return {
        kind: "link",
        name,
        typeFilter,
        shape,
        clauses: this.parseClauseChain(),
      };
    }

    if (typeFilter) {
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

    if (this.peek().kind !== "assign") {
      return {
        kind: "field",
        name,
      };
    }

    this.consume();
    const expr = this.parseComputedExpr();
    if (this.isBacklinkExpr(expr)) {
      let shape: ShapeElement[] | undefined;
      if (this.peek().kind === "lbrace") {
        this.consume();
        shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
        this.expect("rbrace", "Expected '}' after backlink shape");
      }
      return {
        kind: "backlink",
        name,
        expr,
        shape,
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
      };
    }

    return {
      kind: "computed",
      name,
      expr,
      multi: isMulti || undefined,
    };
  }

  private parseComputedExpr(): ComputedExpr | BacklinkExpr {
    if (this.peek().kind === "at") {
      this.consume();
      return {
        kind: "field_ref",
        field: `@${this.expect("identifier", "Expected link property name after '@'").lexeme}`,
      };
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "dot") {
      this.consume();
      this.consume();
      return {
        kind: "field_ref",
        field: this.expect("identifier", "Expected field name after '.'").lexeme,
      };
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
    const startsGeneralExpr = token.kind === "kw_not" || token.kind === "kw_for" || token.kind === "kw_select";
    if (!startsGeneralExpr) {
      return undefined;
    }

    const start = this.index;
    try {
      const expr = this.parseFreeObjectExpr();
      if (["comma", "rbrace", "rparen", "kw_filter", "kw_order", "kw_limit", "kw_offset", "eof"].includes(this.peek().kind)) {
        return {
          kind: "select_expr",
          expr,
          clauses: {},
        };
      }
    } catch {
      // fall through to restore parser position below
    }
    this.index = start;
    return undefined;
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

    const sourceType = this.parseTypeFilter("polymorphic field reference");
    this.expect("dot", "Expected '.' after polymorphic type filter");
    return {
      kind: "polymorphic_field_ref",
      sourceType,
      field: this.expect("identifier", "Expected field name after polymorphic type filter").lexeme,
    };
  }

  private parseComputedDotRefExpr(): ComputedExpr | BacklinkExpr | undefined {
    if (this.peek().kind !== "dot") {
      return undefined;
    }
    this.consume();

    if (this.peek().kind === "lt") {
      this.consume();
      const link = this.expect("identifier", "Expected backlink name after '.<'").lexeme;

      let sourceType: string | undefined;
      if (this.peek().kind === "lbracket") {
        sourceType = this.parseTypeFilter("backlink type filter");
      }

      return {
        link,
        sourceType,
      };
    }

    const fieldName = this.expect("identifier", "Expected field name after '.'").lexeme;
    if (fieldName === "__type__") {
      if (this.peek().kind === "dot") {
        this.consume();
        const suffix = this.expect("identifier", "Expected 'name' after '__type__.'").lexeme;
        if (suffix !== "name") {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Expected '__type__.name'", token.line, token.column);
        }
      }
      return {
        kind: "type_name",
      };
    }

    return {
      kind: "field_ref",
      field: fieldName,
    };
  }

  private parseComputedSubqueryExpr(): ComputedExpr | undefined {
    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_with") {
      this.consume();
      const withClause = this.parseWithClause();
      this.expect("kw_select", "Expected 'select' in computed subquery expression");
      if (this.peek().kind === "identifier" && (this.peekNext().kind === "lbrace" || this.peekNext().kind === "kw_filter" || this.peekNext().kind === "kw_order" || this.peekNext().kind === "kw_limit" || this.peekNext().kind === "kw_offset")) {
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

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select" && this.peekNth(2).kind === "identifier" && this.peekNth(3).kind === "assign") {
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
      const rhsValue = Number(rhs.lexeme.endsWith("n") ? rhs.lexeme.slice(0, -1) : rhs.lexeme);
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
    if (this.peek().kind === "identifier") {
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
      return this.expect("identifier", "Expected field name after '.' in IF condition").lexeme;
    }

    const first = this.expect("identifier", "Expected condition field in IF expression").lexeme;
    if (this.peek().kind === "dot") {
      this.consume();
      return this.expect("identifier", "Expected condition field after qualifier in IF expression").lexeme;
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
        field: this.expect("identifier", dotFieldMessage).lexeme,
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
      const start = this.index;
      if (this.peek().kind !== "lt") {
        return undefined;
      }
      this.consume();
      if (this.peek().kind !== "identifier") {
        this.index = start;
        return undefined;
      }
      this.consume();
      if (this.peek().kind !== "gt") {
        this.index = start;
        return undefined;
      }
      this.consume();
      if (this.peek().kind !== "dot") {
        this.index = start;
        return undefined;
      }
      this.consume();
      if (this.peek().kind !== "identifier") {
        this.index = start;
        return undefined;
      }
      const field = this.consume().lexeme;
      if (this.peek().kind !== "lbracket") {
        this.index = start;
        return undefined;
      }
      this.consume();
      if (this.peek().kind !== "minus") {
        this.index = start;
        return undefined;
      }
      this.consume();
      if (this.peek().kind !== "number") {
        this.index = start;
        return undefined;
      }
      const indexToken = this.consume().lexeme;
      if (this.peek().kind !== "rbracket") {
        this.index = start;
        return undefined;
      }
      this.consume();
      return { field, fromEnd: Number(indexToken.endsWith("n") ? indexToken.slice(0, -1) : indexToken) };
    };

    if (this.peek().kind === "number" && this.peekNext().kind === "minus") {
      const start = this.index;
      const constantToken = this.consume().lexeme;
      this.consume();
      const ref = parseSuffixRef();
      if (!ref) {
        this.index = start;
        return undefined;
      }
      return {
        kind: "field_suffix_math",
        field: ref.field,
        fromEnd: ref.fromEnd,
        op: "const_minus",
        constant: Number(constantToken.endsWith("n") ? constantToken.slice(0, -1) : constantToken),
      };
    }

    if (this.peek().kind === "minus" && this.peekNext().kind === "lt") {
      const start = this.index;
      this.consume();
      const ref = parseSuffixRef();
      if (!ref) {
        this.index = start;
        return undefined;
      }
      return {
        kind: "field_suffix_math",
        field: ref.field,
        fromEnd: ref.fromEnd,
        op: "negate",
      };
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
        field: this.expect("identifier", "Expected field after '.' in function argument").lexeme,
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

    if (this.peek().kind === "identifier") {
      return this.parseIdentifierFunctionCallArgExpr(allowExpressionArgs);
    }

    return {
      kind: "literal",
      value: this.readScalarValue(),
    };
  }

  private tryParseFreeObjectFunctionCallArgExpr(): FunctionCallArgExpr | undefined {
    const token = this.peek();
    if (token.kind === "identifier" && (this.peekNext().kind === "comma" || this.peekNext().kind === "rparen")) {
      return undefined;
    }
    const startsExpression =
      token.kind === "lparen"
      || token.kind === "identifier"
      || token.kind === "kw_for"
      || token.kind === "kw_select"
      || token.kind === "kw_distinct"
      || token.kind === "kw_detached"
      || this.isExistsToken(token);
    if (!startsExpression) {
      return undefined;
    }

    const start = this.index;
    try {
      const expr = this.parseFreeObjectExpr();
      if (this.peek().kind === "comma" || this.peek().kind === "rparen") {
        return {
          kind: "expr",
          expr,
        };
      }
    } catch {
      // fall through to restore parser position below
    }

    this.index = start;
    return undefined;
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

    if (this.peek().kind === "identifier") {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.atDotField()) {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expect("identifier", "Expected field after '.' in cast function argument").lexeme,
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
    const field = this.expect("identifier", "Expected field name").lexeme;
    this.expect("assign", "Expected ':=' after field name");
    return {
      field,
      value: this.parseInsertValue(),
    };
  }

  private parseInsertValue(): InsertValue {
    if (this.peek().kind === "lt") {
      return this.parseCastInsertValue();
    }

    if (this.atFunctionCall()) {
      return this.parseInsertFunctionCallValue();
    }

    if (this.peek().kind === "identifier") {
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
    const castType = this.parseQualifiedName("Expected cast type");
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

  private readTupleLiteralValue(): { kind: "tuple_literal"; values: ScalarValue[] | Record<string, ScalarValue> } {
    const items: ScalarValue[] = [];
    const named: Record<string, ScalarValue> = {};
    let hasNamed = false;

    while (this.peek().kind !== "rparen") {
      if (this.peek().kind === "identifier" && this.peekNext().kind === "assign") {
        hasNamed = true;
        const key = this.consume().lexeme;
        this.consume();
        named[key] = this.readScalarLikeValue();
      } else {
        if (hasNamed) {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Cannot mix unnamed and named tuple elements", token.line, token.column);
        }
        items.push(this.readScalarLikeValue());
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

  private parseNestedInsertExpr(): { kind: "insert"; typeName: string; values: Record<string, InsertValue> } {
    const typeName = this.parseQualifiedName("Expected type name in nested insert");
    this.expect("lbrace", "Expected '{' in nested insert");
    const values: Record<string, InsertValue> = {};
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
    const field = this.expect("identifier", "Expected field name in nested insert").lexeme;
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
      onField = this.expect("identifier", "Expected field name in conflict target").lexeme;
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
    const field = this.expect("identifier", "Expected field name in update expression").lexeme;
    this.expect("assign", "Expected ':=' after field name");
    return {
      field,
      value: this.readScalarLikeValue(),
    };
  }

  private parseUpdate(ctx: ParseContext = {}): UpdateStatement {
    const start = this.expect("kw_update", "Expected 'update'");
    const typeName = this.parseQualifiedName("Expected type name");

    let filter: UpdateStatement["filter"];
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    this.expect("kw_set", "Expected 'set' in update statement");
    this.expect("lbrace", "Expected '{' after 'set'");

    const values: Record<string, InsertValue> = {};
    for (const assignment of this.parseDelimited("rbrace", () => this.parseInsertAssignment(), "Expected ',' between assignments")) {
      values[assignment.field] = assignment.value;
    }

    this.expect("rbrace", "Expected '}' after assignments");

    if (this.peek().kind === "semi") {
      this.consume();
    }

    this.expect("eof", "Unexpected tokens after statement");

    return {
      ...this.withContext(ctx),
      kind: "update",
      typeName,
      filter,
      values,
      pos: {
        line: start.line,
        column: start.column,
      },
    };
  }

  private parseDelete(ctx: ParseContext = {}): DeleteStatement {
    const start = this.expect("kw_delete", "Expected 'delete'");
    const typeName = this.parseQualifiedName("Expected type name");

    let filter: DeleteStatement["filter"];
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    if (this.peek().kind === "semi") {
      this.consume();
    }

    this.expect("eof", "Unexpected tokens after statement");

    return {
      ...this.withContext(ctx),
      kind: "delete",
      typeName,
      filter,
      pos: {
        line: start.line,
        column: start.column,
      },
    };
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

    if (this.isExistsToken(this.peek())) {
      this.consume();
      return {
        kind: "predicate",
        target: this.parseFilterTarget(),
        op: "=",
        value: true,
      };
    }

    if (this.peek().kind === "identifier" && this.peek().lexeme.toLowerCase() === "any" && this.peekNext().kind === "lparen") {
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

    const target = this.parseFilterTarget();
    const token = this.peek();
    if (["kw_and", "kw_or", "kw_order", "kw_limit", "kw_offset", "rparen", "semicolon", "eof"].includes(token.kind)) {
      return {
        kind: "predicate",
        target,
        op: "=",
        value: true,
      };
    }
    let op: "=" | "!=" | "like" | "ilike";
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
    } else {
      throw new AppError("E_SYNTAX", "Expected filter operator (=, !=, like, ilike, IN, NOT IN)", token.line, token.column);
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

    if (this.peek().kind === "identifier") {
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
    if (this.peek().kind === "identifier" && this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt") {
      this.consume();
      const backlink = this.parseBacklinkReference("filter");
      if (this.peek().kind === "at") {
        this.consume();
        return {
          kind: "backlink_property",
          ...backlink,
          property: this.expect("identifier", "Expected backlink link property name after '@'").lexeme,
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
          property: this.expect("identifier", "Expected backlink link property name after '@'").lexeme,
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

  private parseBacklinkReference(context: string): { link: string; sourceType?: string } {
    this.consume();
    this.consume();
    const link = this.expect("identifier", `Expected backlink name after '.<' in ${context}`).lexeme;
    let sourceType: string | undefined;
    if (this.peek().kind === "lbracket") {
      sourceType = this.parseTypeFilter("backlink type filter");
    }
    return { link, sourceType };
  }

  private parseBacklinkPropertyReference(context: string): { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } {
    const backlink = this.parseBacklinkReference(context);
    this.expect("at", "Expected '@' in backlink link property reference");
    return {
      kind: "backlink_property_ref",
      ...backlink,
      property: this.expect("identifier", "Expected backlink link property name after '@'").lexeme,
    };
  }

  private parseFieldReference(context: string): string {
    if (this.peek().kind === "at") {
      this.consume();
      return `@${this.expect("identifier", `Expected link property name in ${context}`).lexeme}`;
    }

    if (this.peek().kind === "dot") {
      this.consume();
    }

    const parts = [this.expect("identifier", `Expected field name in ${context}`).lexeme];
    while (this.peek().kind === "dot") {
      this.consume();
      parts.push(this.expect("identifier", `Expected field name after qualifier in ${context}`).lexeme);
    }

    if (this.peek().kind === "at") {
      this.consume();
      parts.push(`@${this.expect("identifier", `Expected link property name in ${context}`).lexeme}`);
    }

    if (parts.length === 2 && parts[0] === "__type__" && parts[1] === "name") {
      return "__type__.name";
    }

    if (parts.length >= 2 && this.isTypeLikeName(parts[0]!)) {
      return parts[parts.length - 1]!;
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

    if (this.peek().kind === "identifier") {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    return this.readScalarValue();
  }

  private parseWithClause(): ParseContext {
    this.expect("kw_with", "Expected 'with'");
    const bindings: WithBinding[] = [];
    const names = new Set<string>();
    const moduleAliases: WithModuleAlias[] = [];
    const aliasNames = new Set<string>();
    let withModule: string | undefined;

    while (true) {
      if (this.peek().kind === "kw_module") {
        const moduleToken = this.consume();
        if (withModule) {
          throw new AppError("E_SYNTAX", "Duplicate module selection in with block", moduleToken.line, moduleToken.column);
        }

        withModule = this.parseQualifiedName("Expected module name after 'module'");
      } else if (this.peek().kind === "identifier" && this.peekNext().kind === "kw_as") {
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
      } else {
        const name = this.expect("identifier", "Expected alias name in with block").lexeme;
        if (names.has(name)) {
          const token = this.peek();
          throw new AppError("E_SYNTAX", `Duplicate with binding '${name}'`, token.line, token.column);
        }
        names.add(name);
        this.expect("assign", "Expected ':=' in with binding");
        bindings.push({ name, value: this.parseWithBindingValue() });
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
  }

  private parseWithBindingValue(): WithBindingValue {
    if (this.atParenthesizedSelect()) {
      const nested = this.parseParenthesizedSelectQuery(
        "Expected 'select' in with subquery binding",
        "Expected ')' after with subquery binding",
      );
      return {
        kind: "subquery",
        query: nested,
      };
    }

    if (this.peek().kind === "lbrace") {
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

    if (this.peek().kind === "lt") {
      this.consume();
      const castType = this.parseQualifiedName("Expected scalar type in parameter cast");
      this.expect("gt", "Expected '>' after parameter cast");
      this.expect("dollar", "Expected '$' before parameter name");
      const name = this.expect("identifier", "Expected parameter name after '$'").lexeme;
      return {
        kind: "parameter",
        name,
        castType: castType as ScalarType,
      };
    }

    if (this.peek().kind === "kw_detached" && this.peekNext().kind === "identifier") {
      this.consume();
      const typeName = this.consume().lexeme;
      return {
        kind: "subquery",
        query: {
          typeName,
          shape: [{ kind: "field", name: "id" }],
          clauses: {},
        },
      };
    }

    if (this.peek().kind === "identifier") {
      if (this.atInlineTypedSelect()) {
        return {
          kind: "subquery",
          query: this.parseInlineSelectExpr(),
        };
      }

      const name = this.peek().lexeme;
      if (this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt") {
        this.consume();
        this.consume();
        this.consume();
        const link = this.expect("identifier", "Expected backlink name after '.<' in with binding").lexeme;
        let sourceType: string | undefined;
        if (this.peek().kind === "lbracket") {
          sourceType = this.parseTypeFilter("backlink type filter");
        }
        return { kind: "backlink_path", head: name, link, sourceType };
      }

      if (this.peekNext().kind === "dot") {
        const parts = [this.consume().lexeme];
        while (this.peek().kind === "dot" && this.peekNext().kind === "identifier") {
          this.consume();
          parts.push(this.consume().lexeme);
        }
        if (parts.length === 2) {
          return { kind: "path", head: parts[0]!, tail: parts[1]! };
        }
        return { kind: "path_chain", parts };
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
        return { kind: "path", head, tail };
      }
      this.consume();
      return {
        kind: "binding_ref",
        name,
      };
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

    let then: OrderExpr | undefined;
    if (this.peek().kind === "kw_then") {
      this.consume();
      then = this.parseOrderTerm(context);
    }

    return { field, direction, then };
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

  private parseTypeFilter(context: string): string {
    this.expect("lbracket", `Expected '[' for ${context}`);
    this.expect("kw_is", `Expected 'is' in ${context}`);
    const sourceType = this.parseQualifiedName(`Expected type name in ${context}`);
    this.expect("rbracket", `Expected ']' after ${context}`);
    return sourceType;
  }

  private parseSplatDepth(): 1 | 2 {
    this.expect("star", "Expected '*' in splat expression");
    if (this.peek().kind === "star") {
      this.consume();
      return 2;
    }

    return 1;
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
      const lexeme = next.lexeme.endsWith("n") ? next.lexeme.slice(0, -1) : next.lexeme;
      return -Number(lexeme);
    }

    if (token.kind === "string") {
      this.consume();
      return token.lexeme;
    }

    if (token.kind === "bytes_string") {
      this.consume();
      return token.lexeme;
    }

    if (token.kind === "number") {
      this.consume();
      const lexeme = token.lexeme;
      if (lexeme.endsWith("n")) {
        return Number(lexeme.slice(0, -1));
      }
      return Number(lexeme);
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

const parseSetModuleStatement = (input: string): string | undefined => {
  const tokens = tokenize(input).filter((token) => token.kind !== "eof");
  if (tokens[0]?.kind !== "kw_set" || tokens[1]?.kind !== "kw_module") {
    return undefined;
  }

  const parts: string[] = [];
  let i = 2;
  if (tokens[i]?.kind !== "identifier") {
    return undefined;
  }
  parts.push(tokens[i]!.lexeme);
  i += 1;

  while (true) {
    if (tokens[i]?.kind === "coloncolon" && tokens[i + 1]?.kind === "identifier") {
      parts.push(tokens[i + 1]!.lexeme);
      i += 2;
      continue;
    }
    if (tokens[i]?.kind === "colon" && tokens[i + 1]?.kind === "colon" && tokens[i + 2]?.kind === "identifier") {
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
    if (setModule) {
      activeModule = setModule;
    } else {
      statements.push(parseEdgeQL(piece, { defaultModule: activeModule }));
    }
  }

  return statements;
};
