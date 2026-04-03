import { AppError } from "../errors.js";
import type { ScalarType, ScalarValue } from "../types.js";
import type {
  BacklinkExpr,
  ClauseChain,
  ComputedExpr,
  DeleteStatement,
  FilterExpr,
  FunctionCallArgExpr,
  FunctionCallExpr,
  FreeObjectExpr,
  InsertConflict,
  InsertValue,
  InsertStatement,
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

    if (token.kind === "kw_delete") {
      return this.parseDelete(withClause.bindings, withClause.module, withClause.moduleAliases);
    }

    throw new AppError("E_SYNTAX", "Expected 'select', 'insert', 'update', or 'delete'", token.line, token.column);
  }

  private parseSelect(
    withBindings?: WithBinding[],
    withModule?: string,
    withModuleAliases?: WithModuleAlias[],
  ): SelectStatement | SelectFreeStatement {
    const start = this.expect("kw_select", "Expected 'select'");

    if (this.peek().kind === "lbrace") {
      return this.parseFreeObjectSelect(start.line, start.column, withBindings, withModule, withModuleAliases);
    }

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
    if (this.peek().kind === "lbrace") {
      this.consume();
      const values: ScalarValue[] = [];
      while (this.peek().kind !== "rbrace") {
        values.push(this.readValue());
        if (this.peek().kind !== "rbrace") {
          this.expect("comma", "Expected ',' in set literal");
        }
      }
      this.expect("rbrace", "Expected '}' after set literal");
      return { kind: "set_literal", values };
    }

    if (this.peek().kind === "identifier" && this.peekNext().kind === "lparen") {
      return {
        kind: "function_call",
        call: this.parseFunctionCallExpr(),
      };
    }

    if (this.peek().kind === "identifier") {
      return this.parseInlineSelectExpr();
    }

    return {
      kind: "literal",
      value: this.readValue(),
    };
  }

  private parseInlineSelectExpr(): { kind: "select"; typeName: string; shape: ShapeElement[]; clauses: ClauseChain } {
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
    if (this.peek().kind === "lbracket") {
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
      return {
        kind: "function_call",
        call: this.parseFunctionCallExpr(),
      };
    }

    return {
      kind: "literal",
      value: this.readValue(),
    };
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
  ): InsertStatement {
    const start = this.expect("kw_insert", "Expected 'insert'");
    const typeName = this.expect("identifier", "Expected type name").lexeme;
    this.expect("lbrace", "Expected '{' after type name");

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

    const conflict = this.parseInsertConflict();

    if (this.peek().kind === "semi") {
      this.consume();
    }

    this.expect("eof", "Unexpected tokens after statement");

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
    if (this.peek().kind === "identifier") {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select") {
      this.consume();
      this.expect("kw_select", "Expected 'select' in insert expression");
      const nested = this.parseInlineSelectExpr();
      this.expect("rparen", "Expected ')' after insert select expression");
      return nested;
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_insert") {
      this.consume();
      this.expect("kw_insert", "Expected 'insert' in nested insert expression");
      const nested = this.parseNestedInsertExpr();
      this.expect("rparen", "Expected ')' after nested insert expression");
      return nested;
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

    const values: Record<string, ScalarValue> = {};
    while (this.peek().kind !== "rbrace") {
      const fieldName = this.expect("identifier", "Expected field name").lexeme;
      this.expect("assign", "Expected ':=' after field name");
      values[fieldName] = this.readValue();

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
    } else {
      throw new AppError("E_SYNTAX", "Expected filter operator (=, !=, like, ilike)", token.line, token.column);
    }

    return {
      kind: "predicate",
      target,
      op,
      value: this.readFilterValue(),
    };
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
    if (this.peek().kind === "dot") {
      this.consume();
    }

    const first = this.expect("identifier", `Expected field name in ${context}`).lexeme;
    if (this.peek().kind === "dot") {
      this.consume();
      return this.expect("identifier", `Expected field name after qualifier in ${context}`).lexeme;
    }

    return first;
  }

  private readFilterValue(): ScalarValue | { kind: "binding_ref"; name: string } {
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

  private parseOrderBy(): { field: string; direction: "asc" | "desc" } {
    this.expect("kw_order", "Expected 'order'");
    this.expect("kw_by", "Expected 'by' after 'order'");
    const field = this.expect("identifier", "Expected field name in order by").lexeme;

    let direction: "asc" | "desc" = "asc";
    if (this.peek().kind === "kw_asc") {
      this.consume();
      direction = "asc";
    } else if (this.peek().kind === "kw_desc") {
      this.consume();
      direction = "desc";
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
      return -Number(next.lexeme);
    }

    if (token.kind === "string") {
      this.consume();
      return token.lexeme;
    }

    if (token.kind === "number") {
      this.consume();
      return Number(token.lexeme);
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
}

export const parseEdgeQL = (input: string): Statement => {
  const parser = new Parser(input);
  return parser.parseStatement();
};

export const parseEdgeQLScript = (input: string): Statement[] => {
  const statements: Statement[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if ((ch === "'" || ch === '"') && (!quote || quote === ch)) {
      quote = quote ? undefined : (ch as "'" | '"');
      current += ch;
      continue;
    }

    if (ch === ";" && !quote) {
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
