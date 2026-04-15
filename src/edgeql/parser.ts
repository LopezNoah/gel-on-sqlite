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

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
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

  parseStatement(): Statement {
    const withClause = this.peek().kind === "kw_with"
      ? this.parseWithClause()
      : { bindings: undefined, module: undefined, moduleAliases: undefined };
    const token = this.peek();
    if (token.kind === "kw_select") {
      return this.parseSelect(withClause.bindings, withClause.module, withClause.moduleAliases);
    }

    if (token.kind === "kw_insert") {
      return this.parseInsert(withClause.bindings, withClause.module, withClause.moduleAliases);
    }

    if (token.kind === "kw_update") {
      return this.parseUpdate(withClause.bindings, withClause.module, withClause.moduleAliases);
    }

    if (token.kind === "kw_for") {
      return this.parseFor(withClause.bindings, withClause.module, withClause.moduleAliases);
    }

    if (token.kind === "kw_delete") {
      return this.parseDelete(withClause.bindings, withClause.module, withClause.moduleAliases);
    }

    throw new AppError("E_SYNTAX", "Expected 'select', 'insert', 'update', 'delete', or 'for'", token.line, token.column);
  }

  private parseFor(
    withBindings?: WithBinding[],
    withModule?: string,
    withModuleAliases?: WithModuleAlias[],
  ): ForStatement {
    const start = this.expect("kw_for", "Expected 'for'");
    const variable = this.expect("identifier", "Expected variable name after 'for'").lexeme;
    this.expect("kw_in", "Expected 'in' after for variable");
    const iteratorExpr = this.parseFreeObjectConcatExpr();
    this.expect("kw_union", "Expected 'union' after for iterator");
    const hasParen = this.peek().kind === "lparen";
    if (hasParen) {
      this.consume();
    }
    const next = this.peek();
    let body: InsertStatement | SelectStatement;
    if (next.kind === "kw_select") {
      this.consume();
      const nested = this.parseInlineSelectExpr();
      body = {
        kind: "select",
        with: withBindings,
        withModule,
        withModuleAliases,
        typeName: nested.typeName,
        shape: nested.shape,
        fields: [],
        filter: nested.clauses.filter,
        orderBy: nested.clauses.orderBy,
        limit: nested.clauses.limit,
        offset: nested.clauses.offset,
        pos: { line: start.line, column: start.column },
      };
    } else {
      body = this.parseInsert(withBindings, withModule, withModuleAliases, false);
    }
    if (hasParen) {
      this.expect("rparen", "Expected ')' after for body");
    }
    return {
      kind: "for",
      with: withBindings,
      withModule,
      withModuleAliases,
      variable,
      iteratorExpr,
      body,
      pos: { line: start.line, column: start.column },
    };
  }

  private parseSelect(
    withBindings?: WithBinding[],
    withModule?: string,
    withModuleAliases?: WithModuleAlias[],
  ): SelectStatement | SelectFreeStatement | SelectExprStatement {
    const start = this.expect("kw_select", "Expected 'select'");

    const parseSelectExprTail = (expr: FreeObjectExpr): SelectExprStatement => {
      const orderBy = this.parseExprOrderBy();
      if (this.peek().kind === "semi") {
        this.consume();
      }
      this.expect("eof", "Unexpected tokens after statement");
      return {
        kind: "select_expr",
        with: withBindings,
        withModule,
        withModuleAliases,
        expr,
        orderBy,
        pos: { line: start.line, column: start.column },
      };
    };

    // Free object select: SELECT { ... }
    if (this.peek().kind === "lbrace") {
      if (this.looksLikeFreeObjectSelect()) {
        return this.parseFreeObjectSelect(start.line, start.column, withBindings, withModule, withModuleAliases);
      }
      const expr = this.parseFreeObjectConcatExpr();
      return parseSelectExprTail(expr);
    }

    // Expression select: SELECT <type>expr, SELECT expr ++ expr, SELECT enum_type.MEMBER
    if (this.peek().kind === "lt" || this.peek().kind === "string") {
      const expr = this.parseFreeObjectConcatExpr();
      return parseSelectExprTail(expr);
    }

    // Function call expression: SELECT fn(...)
    if (this.peek().kind === "identifier" && this.peekNext().kind === "lparen") {
      const expr = this.parseFreeObjectConcatExpr();
      return parseSelectExprTail(expr);
    }

    // Check for enum path: SELECT enum_type.MEMBER
    if (this.peek().kind === "identifier" && this.peekNext().kind === "dot" && this.peekNth(2).kind === "identifier") {
      const first = this.peek().lexeme;
      const third = this.peekNth(2).lexeme;
      // If the "member" part looks like a valid identifier (not a keyword), treat as enum path
      if (!["select", "insert", "update", "delete", "filter", "with", "order", "by", "limit", "offset"].includes(third)) {
        const expr = this.parseFreeObjectConcatExpr();
        return parseSelectExprTail(expr);
      }
    }

    // Check for enum type with @ (link property reference)
    if (this.peek().kind === "identifier" && this.peekNext().kind === "at") {
      const typeName = this.consume().lexeme;
      this.consume();
      throw new AppError("E_SYNTAX", "unexpected reference to link property", this.peek().line, this.peek().column);
    }

    // Check for backlink syntax: SELECT enum_type.<LINK
    if (this.peek().kind === "identifier" && this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt") {
      const typeName = this.peek().lexeme;
      this.consume();
      this.consume();
      this.consume();
      throw new AppError("E_SYNTAX", `enum types do not support backlink`, this.peek().line, this.peek().column);
    }

    // Check for [IS type].field syntax on enum types
    if (this.peek().kind === "identifier" && this.peekNext().kind === "lbracket") {
      const typeName = this.peek().lexeme;
      this.consume();
      this.consume();
      if (this.peek().kind === "kw_is") {
        this.consume();
        const filterType = this.expect("identifier", "Expected type name in type filter").lexeme;
        this.expect("rbracket", "Expected ']' after type filter");
        if (this.peek().kind === "dot") {
          this.consume();
          const member = this.expect("identifier", "Expected member name after '.'").lexeme;
          throw new AppError("E_SYNTAX", `an enum member name must follow enum type name in the path`, this.peek().line, this.peek().column);
        }
      }
      throw new AppError("E_SYNTAX", "Unexpected tokens after statement", this.peek().line, this.peek().column);
    }

    // If there are WITH bindings and SELECT is followed by a simple identifier (no shape),
    // treat it as a select_expr (could be a binding reference to a scalar value)
    if (withBindings && withBindings.length > 0) {
      const firstToken = this.peek();
      const secondToken = this.peekNext();
      if (firstToken.kind === "identifier" && secondToken.kind !== "lbrace") {
        const expr = this.parseFreeObjectConcatExpr();
        return parseSelectExprTail(expr);
      }
    }

    // Bare identifier expression: SELECT Primes;
    if (this.peek().kind === "identifier" && (this.peekNext().kind === "semi" || this.peekNext().kind === "eof")) {
      const expr = this.parseFreeObjectConcatExpr();
      return parseSelectExprTail(expr);
    }

    // Regular type select: SELECT TypeName { ... }
    const typeName = this.expect("identifier", "Expected type name").lexeme;

    const shape: ShapeElement[] = [{ kind: "field", name: "id" }];
    const fields: string[] = ["id"];
    if (this.peek().kind === "lbrace") {
      this.consume();
      shape.length = 0;
      fields.length = 0;

      while (this.peek().kind !== "rbrace") {
        const entry = this.parseShapeEntry();
        shape.push(entry);
        if (entry.kind === "field") {
          fields.push(entry.name);
        }

        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' between shape entries");
        }
      }
      this.expect("rbrace", "Expected '}' after selected fields");
    }

    const clauses = this.parseClauseChain();

    if (this.peek().kind === "semi") {
      this.consume();
    }

    this.expect("eof", "Unexpected tokens after statement");

    return {
      kind: "select",
      with: withBindings,
      withModule,
      withModuleAliases,
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

  private parseFreeObjectSelect(
    line: number,
    column: number,
    withBindings?: WithBinding[],
    withModule?: string,
    withModuleAliases?: WithModuleAlias[],
  ): SelectFreeStatement {
    this.expect("lbrace", "Expected '{' after 'select' in free object query");
    const entries: SelectFreeStatement["entries"] = [];

    while (this.peek().kind !== "rbrace") {
      const name = this.expect("identifier", "Expected free object field name").lexeme;
      this.expect("assign", "Expected ':=' in free object field");
      const expr = this.parseFreeObjectExpr();
      entries.push({ name, expr });

      if (this.peek().kind !== "rbrace") {
        this.expect("comma", "Expected ',' between free object entries");
      }
    }

    this.expect("rbrace", "Expected '}' after free object entries");
    if (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after statement");

    return {
      kind: "select_free",
      with: withBindings,
      withModule,
      withModuleAliases,
      entries,
      pos: { line, column },
    };
  }

  private parseFreeObjectExpr(): FreeObjectExpr {
    if (this.peek().kind === "lparen") {
      this.consume();
      const expr = this.parseFreeObjectConcatExpr();
      this.expect("rparen", "Expected ')' after parenthesized expression");
      return expr;
    }

    if (this.peek().kind === "kw_distinct") {
      this.consume();
      return this.parseFreeObjectExpr();
    }

    if (this.peek().kind === "kw_select") {
      return this.parseSelectExprSubquery();
    }

    if (this.peek().kind === "lt") {
      this.consume();
      const castType = this.expect("identifier", "Expected type name in cast").lexeme;
      this.expect("gt", "Expected '>' after cast type");
      const expr = this.parseFreeObjectExpr();
      return { kind: "cast", castType, expr };
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values: FreeObjectExpr[] = [];
      while (this.peek().kind !== "rbrace") {
        values.push(this.parseFreeObjectConcatExpr());
        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' in set literal");
        }
      }
      this.expect("rbrace", "Expected '}' after set literal");
      if (values.every((v) => v.kind === "literal")) {
        return { kind: "set_literal", values: values.map((v) => (v as { kind: "literal"; value: ScalarValue }).value) };
      }
      return { kind: "set_expr", values };
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "lparen") {
      return {
        kind: "function_call",
        call: this.parseFunctionCallExpr(),
      };
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "dot" && this.peekNth(2).kind === "identifier") {
      const head = this.consume().lexeme;
      this.consume();
      const tail = this.consume().lexeme;
      // Check for chained path: color_enum_t.RED.GREEN
      if (this.peek().kind === "dot" && this.peekNext().kind === "identifier") {
        this.consume();
        this.consume();
        throw new AppError("E_SYNTAX", "invalid property reference on an expression of primitive type", this.peek().line, this.peek().column);
      }
      return { kind: "path", head, tail };
    }

    if (this.peek().kind === "identifier") {
      if (this.peekNext().kind === "at") {
        this.consume();
        this.consume();
        throw new AppError("E_SYNTAX", "unexpected reference to link property", this.peek().line, this.peek().column);
      }
      if (
        this.peekNext().kind === "lbrace"
        || this.peekNext().kind === "kw_filter"
        || this.peekNext().kind === "kw_limit"
        || this.peekNext().kind === "kw_offset"
      ) {
        return this.parseInlineSelectExpr();
      }
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    return {
      kind: "literal",
      value: this.readValue(),
    };
  }

  private parseFreeObjectConcatExpr(): FreeObjectExpr {
    let left = this.parseFreeObjectExpr();
    while (this.peek().kind === "concat") {
      this.consume();
      const right = this.parseFreeObjectExpr();
      if (left.kind === "concat") {
        left = { kind: "concat", parts: [...left.parts, right] };
      } else {
        left = { kind: "concat", parts: [left, right] };
      }
    }
    if (this.peek().kind === "kw_is") {
      this.consume();
      const typeName = this.expect("identifier", "Expected type name after 'is'").lexeme;
      return {
        kind: "is_type",
        expr: left,
        typeName,
      };
    }
    return left;
  }

  private parseSelectExprSubquery(): FreeObjectExpr {
    this.expect("kw_select", "Expected 'select'");
    let alias: string | undefined;
    let expr: FreeObjectExpr;
    if (this.peek().kind === "identifier" && this.peekNext().kind === "assign") {
      alias = this.consume().lexeme;
      this.consume();
      expr = this.parseFreeObjectConcatExpr();
    } else {
      expr = this.parseFreeObjectConcatExpr();
    }

    return {
      kind: "select_expr_subquery",
      alias,
      expr,
      orderBy: this.parseExprOrderBy(),
    };
  }

  private parseExprOrderBy(): { expr: FreeObjectExpr; direction: "asc" | "desc" } | undefined {
    if (this.peek().kind !== "kw_order") {
      return undefined;
    }
    this.consume();
    this.expect("kw_by", "Expected 'by' after 'order'");
    const expr = this.parseFreeObjectConcatExpr();
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
    if (this.peek().kind === "identifier" && this.peek().lexeme.toLowerCase() === "detached") {
      this.consume();
    }
    const typeName = this.expect("identifier", "Expected type name in inline select").lexeme;
    const shape: ShapeElement[] = [{ kind: "field", name: "id" }];
    if (this.peek().kind === "lbrace") {
      this.consume();
      shape.length = 0;
      while (this.peek().kind !== "rbrace") {
        shape.push(this.parseShapeEntry());
        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' between shape entries");
        }
      }
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
        kind: "literal",
        value: null,
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
      const shape: ShapeElement[] = [];
      while (this.peek().kind !== "rbrace") {
        shape.push(this.parseShapeEntry());
        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' between shape entries");
        }
      }
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
      return {
        kind: "backlink",
        name,
        expr,
      };
    }

    return {
      kind: "computed",
      name,
      expr,
    };
  }

  private parseComputedExpr(): ComputedExpr | BacklinkExpr {
    const suffixMathExpr = this.parseFieldSuffixMathExpr();
    if (suffixMathExpr) {
      return suffixMathExpr;
    }

    if (this.peek().kind === "lbracket") {
      if (this.peekNth(1).kind !== "kw_is") {
        return {
          kind: "literal",
          value: this.readValue(),
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
          link,
          sourceType,
        };
      }

      const fieldName = this.expect("identifier", "Expected field name after '.'").lexeme;
      if (fieldName === "__type__") {
        return {
          kind: "type_name",
        };
      }

      return {
        kind: "field_ref",
        field: fieldName,
      };
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select") {
      this.consume();
      this.expect("kw_select", "Expected 'select' in computed subquery expression");
      const nested = this.parseInlineSelectExpr();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "subquery",
        typeName: nested.typeName,
        shape: nested.shape,
        clauses: nested.clauses,
      };
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "lparen") {
      const call = this.parseFunctionCallExpr();
      if (this.peek().kind === "minus" && this.peekNext().kind === "number") {
        this.consume();
        const rhs = this.consume();
        const rhsValue = Number(rhs.lexeme.endsWith("n") ? rhs.lexeme.slice(0, -1) : rhs.lexeme);
        return {
          kind: "function_call",
          call: {
            name: "__gel_subtract",
            args: [
              { kind: "function_call", call },
              { kind: "literal", value: rhsValue },
            ],
          },
        };
      }

      return {
        kind: "function_call",
        call,
      };
    }

    if (this.peek().kind === "identifier") {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    const thenValue = this.readValue();
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
      return {
        kind: "function_call",
        call: conditionalArg.call,
      };
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
    if (!(this.peek().kind === "identifier" && this.peek().lexeme.toLowerCase() === "if")) {
      return initialThenArg;
    }
    this.consume();

    const conditionField = this.parseIfConditionField();
    this.expect("equals", "Expected '=' in IF condition");
    const conditionValue = this.readValue();
    if (!(this.peek().kind === "kw_else" || (this.peek().kind === "identifier" && this.peek().lexeme.toLowerCase() === "else"))) {
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
    if (this.peek().kind === "identifier" && this.peekNext().kind === "lparen") {
      return {
        kind: "function_call",
        call: this.parseFunctionCallExpr(),
      };
    }

    if (this.peek().kind === "dot") {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expect("identifier", "Expected field after '.' in IF expression").lexeme,
      };
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "dot" && this.peekNth(2).kind === "identifier") {
      this.consume();
      this.consume();
      return {
        kind: "field_ref",
        field: this.consume().lexeme,
      };
    }

    return {
      kind: "literal",
      value: this.readValue(),
    };
  }

  private parseArithmeticLeafArg(): FunctionCallArgExpr {
    if (this.peek().kind === "identifier" && this.peekNext().kind === "lparen") {
      return {
        kind: "function_call",
        call: this.parseFunctionCallExpr(),
      };
    }

    if (this.peek().kind === "dot") {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expect("identifier", "Expected field after '.' in arithmetic expression").lexeme,
      };
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "dot" && this.peekNth(2).kind === "identifier") {
      this.consume();
      this.consume();
      return {
        kind: "field_ref",
        field: this.consume().lexeme,
      };
    }

    return {
      kind: "literal",
      value: this.readValue(),
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

  private parseFunctionCallExpr(): FunctionCallExpr {
    const name = this.expect("identifier", "Expected function name").lexeme;
    this.expect("lparen", "Expected '(' after function name");
    const args: FunctionCallArgExpr[] = [];
    while (this.peek().kind !== "rparen") {
      args.push(this.parseFunctionCallArgExpr());
      if (this.peek().kind !== "rparen") {
        this.expect("comma", "Expected ',' between function arguments");
      }
    }
    this.expect("rparen", "Expected ')' after function arguments");
    return { name, args };
  }

  private parseFunctionCallArgExpr(): FunctionCallArgExpr {
    if (this.peek().kind === "lt") {
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
        const values: ScalarValue[] = [];
        while (this.peek().kind !== "rbrace") {
          values.push(this.readValue());
          if (this.peek().kind !== "rbrace") {
            this.expect("comma", "Expected ',' in cast set literal function argument");
          }
        }
        this.expect("rbrace", "Expected '}' after cast set literal function argument");
        return { kind: "set_literal", values };
      }

      if (this.peek().kind === "identifier") {
        return {
          kind: "binding_ref",
          name: this.consume().lexeme,
        };
      }

      if (this.peek().kind === "dot") {
        this.consume();
        return {
          kind: "field_ref",
          field: this.expect("identifier", "Expected field after '.' in cast function argument").lexeme,
        };
      }

      return {
        kind: "literal",
        value: this.readValue(),
      };
    }

    if (this.peek().kind === "dot") {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expect("identifier", "Expected field after '.' in function argument").lexeme,
      };
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values: ScalarValue[] = [];
      while (this.peek().kind !== "rbrace") {
        values.push(this.readValue());
        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' in set literal function argument");
        }
      }
      this.expect("rbrace", "Expected '}' after set literal function argument");
      return { kind: "set_literal", values };
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values: ScalarValue[] = [];
      while (this.peek().kind !== "rbracket") {
        values.push(this.readValue());
        if (this.peek().kind !== "rbracket") {
          this.expect("comma", "Expected ',' in array literal function argument");
        }
      }
      this.expect("rbracket", "Expected ']' after array literal function argument");
      return { kind: "array_literal", values };
    }

    if (this.peek().kind === "identifier") {
      if (this.peekNext().kind === "lparen") {
        return {
          kind: "function_call",
          call: this.parseFunctionCallExpr(),
        };
      }

      if (this.peekNext().kind === "dot" && this.peekNth(2).kind === "identifier") {
        this.consume();
        this.consume();
        return {
          kind: "field_ref",
          field: this.consume().lexeme,
        };
      }

      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    return {
      kind: "literal",
      value: this.readValue(),
    };
  }

  private isBacklinkExpr(expr: ComputedExpr | BacklinkExpr): expr is BacklinkExpr {
    return "link" in expr;
  }

  private parseInsert(
    withBindings?: WithBinding[],
    withModule?: string,
    withModuleAliases?: WithModuleAlias[],
    expectEof = true,
  ): InsertStatement {
    const start = this.expect("kw_insert", "Expected 'insert'");
    const typeName = this.expect("identifier", "Expected type name").lexeme;

    const values: Record<string, InsertValue> = {};
    if (this.peek().kind === "lbrace") {
      this.consume();
      while (this.peek().kind !== "rbrace") {
        const fieldName = this.expect("identifier", "Expected field name").lexeme;
        this.expect("assign", "Expected ':=' after field name");
        values[fieldName] = this.parseInsertValue();

        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' between assignments");
        }
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
      kind: "insert",
      with: withBindings,
      withModule,
      withModuleAliases,
      typeName,
      values,
      conflict,
      pos: {
        line: start.line,
        column: start.column,
      },
    };
  }

  private parseInsertValue(): InsertValue {
    if (this.peek().kind === "lt") {
      this.consume();
      const castType = this.consume().lexeme;
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

    if (this.peek().kind === "identifier" && this.peekNext().kind === "lparen") {
      const call = this.parseFunctionCallExpr();
      if (call.name === "to_json") {
        if (call.args.length === 1 && call.args[0].kind === "literal") {
          return call.args[0].value;
        }
      }
      return { kind: "function_call", call };
    }

    if (this.peek().kind === "identifier") {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.peek().kind === "lparen") {
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
            _withBindings: withClause.bindings,
            _withModule: withClause.module,
            _withModuleAliases: withClause.moduleAliases,
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

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values: InsertValue[] = [];
      while (this.peek().kind !== "rbrace") {
        values.push(this.parseInsertValue());
        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' in set literal");
        }
      }
      this.expect("rbrace", "Expected '}' after set literal");
      return {
        kind: "set",
        values,
      };
    }

    return this.readValue();
  }

  private readTupleLiteralValue(): ScalarValue {
    const items: ScalarValue[] = [];
    const named: Record<string, ScalarValue> = {};
    let hasNamed = false;

    while (this.peek().kind !== "rparen") {
      if (this.peek().kind === "identifier" && this.peekNext().kind === "assign") {
        hasNamed = true;
        const key = this.consume().lexeme;
        this.consume();
        named[key] = this.readValue();
      } else {
        if (hasNamed) {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Cannot mix unnamed and named tuple elements", token.line, token.column);
        }
        items.push(this.readValue());
      }

      if (this.peek().kind === "comma") {
        this.consume();
      } else {
        break;
      }
    }

    this.expect("rparen", "Expected ')' after tuple literal");
    return JSON.stringify(hasNamed ? named : items);
  }

  private parseNestedInsertExpr(): { kind: "insert"; typeName: string; values: Record<string, InsertValue> } {
    const typeName = this.expect("identifier", "Expected type name in nested insert").lexeme;
    this.expect("lbrace", "Expected '{' in nested insert");
    const values: Record<string, InsertValue> = {};
    while (this.peek().kind !== "rbrace") {
      const fieldName = this.expect("identifier", "Expected field name in nested insert").lexeme;
      this.expect("assign", "Expected ':=' after field name");
      values[fieldName] = this.parseInsertValue();

      if (this.peek().kind !== "rbrace") {
        this.expect("comma", "Expected ',' between assignments");
      }
    }
    this.expect("rbrace", "Expected '}' after nested insert assignments");
    return {
      kind: "insert",
      typeName,
      values,
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
    const typeName = this.expect("identifier", "Expected type name in update expression").lexeme;

    let filter: FilterExpr | undefined;
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    this.expect("kw_set", "Expected 'set' in update expression");
    this.expect("lbrace", "Expected '{' after 'set'");
    const values: Record<string, ScalarValue> = {};
    while (this.peek().kind !== "rbrace") {
      const fieldName = this.expect("identifier", "Expected field name in update expression").lexeme;
      this.expect("assign", "Expected ':=' after field name");
      values[fieldName] = this.readValue();
      if (this.peek().kind !== "rbrace") {
        this.expect("comma", "Expected ',' between assignments");
      }
    }
    this.expect("rbrace", "Expected '}' after assignments");
    return {
      kind: "update",
      typeName,
      filter,
      values,
    };
  }

  private parseUpdate(
    withBindings?: WithBinding[],
    withModule?: string,
    withModuleAliases?: WithModuleAlias[],
  ): UpdateStatement {
    const start = this.expect("kw_update", "Expected 'update'");
    const typeName = this.expect("identifier", "Expected type name").lexeme;

    let filter: UpdateStatement["filter"];
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    this.expect("kw_set", "Expected 'set' in update statement");
    this.expect("lbrace", "Expected '{' after 'set'");

    const values: Record<string, InsertValue> = {};
    while (this.peek().kind !== "rbrace") {
      const fieldName = this.expect("identifier", "Expected field name").lexeme;
      this.expect("assign", "Expected ':=' after field name");
      values[fieldName] = this.parseInsertValue();

      if (this.peek().kind !== "rbrace") {
        this.expect("comma", "Expected ',' between assignments");
      }
    }

    this.expect("rbrace", "Expected '}' after assignments");

    if (this.peek().kind === "semi") {
      this.consume();
    }

    this.expect("eof", "Unexpected tokens after statement");

    return {
      kind: "update",
      with: withBindings,
      withModule,
      withModuleAliases,
      typeName,
      filter,
      values,
      pos: {
        line: start.line,
        column: start.column,
      },
    };
  }

  private parseDelete(
    withBindings?: WithBinding[],
    withModule?: string,
    withModuleAliases?: WithModuleAlias[],
  ): DeleteStatement {
    const start = this.expect("kw_delete", "Expected 'delete'");
    const typeName = this.expect("identifier", "Expected type name").lexeme;

    let filter: DeleteStatement["filter"];
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    if (this.peek().kind === "semi") {
      this.consume();
    }

    this.expect("eof", "Unexpected tokens after statement");

    return {
      kind: "delete",
      with: withBindings,
      withModule,
      withModuleAliases,
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

    const target = this.parseFilterTarget();
    const token = this.peek();
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
    | { kind: "name"; name: string } {
    const token = this.peek();
    // Handle DISTINCT keyword before set literal
    if (token.kind === "kw_distinct") {
      this.consume();
    }
    if (this.peek().kind === "lbrace") {
      this.consume();
      const values: ScalarValue[] = [];
      while (this.peek().kind !== "rbrace") {
        const val = this.readFilterValue();
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean" || val === null) {
          values.push(val);
        } else {
          throw new AppError("E_SYNTAX", "IN filter values must be scalar literals", token.line, token.column);
        }
        if (this.peek().kind === "comma") {
          this.consume();
        } else {
          break;
        }
      }
      this.expect("rbrace", "Expected '}' to close IN filter value set");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select") {
      this.consume();
      this.expect("kw_select", "Expected 'SELECT' in IN predicate subquery");
      const query = this.parseInlineSelectExpr();
      this.expect("rparen", "Expected ')' after IN predicate subquery");
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

    throw new AppError("E_SYNTAX", "Expected set literal, identifier, or SELECT subquery in IN filter", token.line, token.column);
  }

  private parseFilterTarget(): { kind: "field"; field: string } | { kind: "backlink"; link: string; sourceType?: string } {
    if (this.peek().kind === "dot" && this.peekNext().kind === "lt") {
      this.consume();
      this.consume();
      const link = this.expect("identifier", "Expected backlink name after '.<' in filter").lexeme;
      let sourceType: string | undefined;
      if (this.peek().kind === "lbracket") {
        sourceType = this.parseTypeFilter("backlink type filter");
      }
      return {
        kind: "backlink",
        link,
        sourceType,
      };
    }

    return {
      kind: "field",
      field: this.parseFieldReference("filter"),
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

    const first = this.expect("identifier", `Expected field name in ${context}`).lexeme;
    if (this.peek().kind === "dot") {
      this.consume();
      const second = this.expect("identifier", `Expected field name after qualifier in ${context}`).lexeme;
      if (first === "__type__" && second === "name") {
        return "__type__.name";
      }
      return second;
    }

    return first;
  }

  private readFilterValue(): ScalarValue | { kind: "binding_ref"; name: string } | { kind: "field_ref"; field: string } {
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

    return this.readValue();
  }

  private parseWithClause(): {
    bindings?: WithBinding[];
    module?: string;
    moduleAliases?: WithModuleAlias[];
  } {
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

        withModule = this.expect("identifier", "Expected module name after 'module'").lexeme;
      } else if (this.peek().kind === "identifier" && this.peekNext().kind === "kw_as") {
        const aliasToken = this.consume();
        const alias = aliasToken.lexeme;
        if (aliasNames.has(alias)) {
          throw new AppError("E_SYNTAX", `Duplicate module alias '${alias}'`, aliasToken.line, aliasToken.column);
        }

        this.expect("kw_as", "Expected 'as' in module alias declaration");
        this.expect("kw_module", "Expected 'module' in module alias declaration");
        const module = this.expect("identifier", "Expected module name in module alias declaration").lexeme;
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
      bindings: bindings.length > 0 ? bindings : undefined,
      module: withModule,
      moduleAliases: moduleAliases.length > 0 ? moduleAliases : undefined,
    };
  }

  private parseWithBindingValue(): WithBindingValue {
    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select") {
      this.consume();
      this.expect("kw_select", "Expected 'select' in with subquery binding");
      const nested = this.parseInlineSelectExpr();
      this.expect("rparen", "Expected ')' after with subquery binding");
      return {
        kind: "subquery",
        query: nested,
      };
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values: ScalarValue[] = [];
      while (this.peek().kind !== "rbrace") {
        values.push(this.readValue());
        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' in set literal with binding");
        }
      }
      this.expect("rbrace", "Expected '}' after set literal with binding");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values: ScalarValue[] = [];
      while (this.peek().kind !== "rbracket") {
        values.push(this.readValue());
        if (this.peek().kind !== "rbracket") {
          this.expect("comma", "Expected ',' in array literal with binding");
        }
      }
      this.expect("rbracket", "Expected ']' after array literal with binding");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.peek().kind === "lt") {
      this.consume();
      const castType = this.expect("identifier", "Expected scalar type in parameter cast").lexeme;
      this.expect("gt", "Expected '>' after parameter cast");
      this.expect("dollar", "Expected '$' before parameter name");
      const name = this.expect("identifier", "Expected parameter name after '$'").lexeme;
      return {
        kind: "parameter",
        name,
        castType: castType as ScalarType,
      };
    }

    if (this.peek().kind === "identifier") {
      if (this.peek().lexeme.toLowerCase() === "detached" && this.peekNext().kind === "identifier") {
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

      const name = this.peek().lexeme;
      if (this.peekNext().kind === "dot" && this.peekNth(2).kind === "identifier") {
        const head = this.consume().lexeme;
        this.consume();
        const tail = this.consume().lexeme;
        // Check for chained path: x.GREEN.MORE
        if (this.peek().kind === "dot" && this.peekNext().kind === "identifier") {
          this.consume();
          this.consume();
          throw new AppError("E_SYNTAX", "invalid property reference on an expression of primitive type", this.peek().line, this.peek().column);
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
      value: this.readValue(),
    };
  }

  private parseOrderBy(): { field: string; direction: "asc" | "desc" } {
    this.expect("kw_order", "Expected 'order'");
    this.expect("kw_by", "Expected 'by' after 'order'");
    const field = this.parseFieldReference("order by");

    let direction: "asc" | "desc" = "asc";
    if (this.peek().kind === "kw_asc") {
      this.consume();
      direction = "asc";
    } else if (this.peek().kind === "kw_desc") {
      this.consume();
      direction = "desc";
    }

    if (this.peek().kind === "identifier" && this.peek().lexeme.toLowerCase() === "then") {
      this.consume();
      this.parseFieldReference("order by");
      if (this.peek().kind === "kw_asc" || this.peek().kind === "kw_desc") {
        this.consume();
      }
    }

    return { field, direction };
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
    const sourceType = this.expect("identifier", `Expected type name in ${context}`).lexeme;
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

  private readValue(): ScalarValue {
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

    if (token.kind === "lbracket") {
      this.consume();
      const values: ScalarValue[] = [];
      while (this.peek().kind !== "rbracket") {
        values.push(this.readValue());
        if (this.peek().kind === "comma") {
          this.consume();
        } else {
          break;
        }
      }
      this.expect("rbracket", "Expected ']' after array literal");
      return JSON.stringify(values);
    }

    throw new AppError("E_SYNTAX", "Expected a literal value", token.line, token.column);
  }

  private readInteger(message: string): number {
    const token = this.peek();
    if (token.kind !== "number") {
      throw new AppError("E_SYNTAX", message, token.line, token.column);
    }

    if (!/^\d+$/.test(token.lexeme)) {
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

export const parseEdgeQL = (input: string): Statement => {
  const parser = new Parser(input);
  return parser.parseStatement();
};

export const parseEdgeQLScript = (input: string): Statement[] => {
  const statements: Statement[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let depth = 0;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if ((ch === "'" || ch === '"') && (!quote || quote === ch)) {
      quote = quote ? undefined : (ch as "'" | '"');
      current += ch;
      continue;
    }

    if (!quote) {
      if (ch === "{" || ch === "(" || ch === "[") {
        depth += 1;
      } else if (ch === "}" || ch === ")" || ch === "]") {
        depth -= 1;
      }
    }

    if (ch === ";" && !quote && depth === 0) {
      const piece = current.trim();
      if (piece.length > 0) {
        statements.push(parseEdgeQL(`${piece};`));
      }
      current = "";
      continue;
    }

    current += ch;
  }

  const piece = current.trim();
  if (piece.length > 0) {
    statements.push(parseEdgeQL(piece));
  }

  return statements;
};
