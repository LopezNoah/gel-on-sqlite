import { EmbeddedActionsParser, Lexer, createToken, createTokenInstance, type TokenType } from "chevrotain";
import { AppError } from "../errors.js";
import type { FilterExpr, FreeObjectExpr, ShapeElement, Statement, WithBinding } from "./ast.js";
import { offsetToLineCol, tokenizeWithStarts, type TokenKind } from "./tokenizer.js";

// A second, explicitly scoped parser. It reuses the production tokenizer but
// expresses syntax as a validated grammar; no Python or generated code ships.
// The working AST is its output seam, so consumers need no new representation.
const Name = createToken({ name: "Name", pattern: Lexer.NA });
const kinds = [
  "kw_select", "kw_with", "kw_filter", "kw_or", "kw_and", "kw_not",
  "kw_true", "kw_false", "kw_null", "kw_unreserved", "identifier", "backtick_name",
  "number", "string", "semi", "lparen", "rparen", "lbrace", "rbrace", "comma",
  "dot", "coloncolon", "assign", "plus", "minus", "star", "slash", "floor_div",
  "modulo", "pow", "coalesce", "concat", "equals", "not_equals", "lt", "lte",
  "gt", "gte", "distinct_from", "not_distinct_from",
] as const satisfies readonly TokenKind[];
type GrammarKind = typeof kinds[number];
const tokens = Object.fromEntries(kinds.map((kind) => [
  kind, createToken({
    name: kind,
    pattern: Lexer.NA,
    categories: ["identifier", "backtick_name", "kw_unreserved"].includes(kind) ? [Name] : [],
  }),
])) as Record<GrammarKind, TokenType>;

const defaultShape = (): ShapeElement[] => [{ kind: "field", name: "id", operation: "assign", origin: "default" }];
const typeSource = (name: string): FreeObjectExpr => ({
  kind: "select", typeName: name, shape: defaultShape(), clauses: {},
});
const syntaxError = (message: string, line = 1, column = 1): AppError =>
  new AppError("E_SYNTAX", message, line, column);

function numberLiteral(text: string, line: number, column: number): FreeObjectExpr {
  const cleaned = text.replace(/_/g, "");
  const numericKind = cleaned.endsWith("n") ? /[.eE]/.test(cleaned) ? "decimal" : "bigint"
    : /[.eE]/.test(cleaned) ? "float" : "integer";
  const digits = cleaned.replace(/n$/, "");
  const value = Number(digits);
  if (!Number.isFinite(value)
      || (numericKind === "integer" && digits.length >= 20)
      || (value === 0 && /[1-9]/.test(digits.split(/[eE]/)[0] ?? ""))) {
    throw syntaxError(`Numeric literal out of range: ${text}`, line, column);
  }
  return { kind: "literal", value, numericKind };
}

type MathOp = Extract<FreeObjectExpr, { kind: "math" }>["op"];
type CompareOp = Extract<FreeObjectExpr, { kind: "compare" }>["op"];

class GrammarParser extends EmbeddedActionsParser {
  readonly bindings = new Set<string>();
  declare statement: () => Statement;
  declare binding: () => WithBinding;
  declare expression: () => FreeObjectExpr;
  declare orExpr: () => FreeObjectExpr;
  declare andExpr: () => FreeObjectExpr;
  declare comparison: () => FreeObjectExpr;
  declare additive: () => FreeObjectExpr;
  declare multiplicative: () => FreeObjectExpr;
  declare coalescing: () => FreeObjectExpr;
  declare unary: () => FreeObjectExpr;
  declare power: () => FreeObjectExpr;
  declare postfix: () => FreeObjectExpr;
  declare shape: () => ShapeElement[];
  declare atom: () => FreeObjectExpr;
  declare qualifiedName: () => string;

  constructor() {
    super([Name, ...Object.values(tokens)], { recoveryEnabled: false });
    const $ = this;

    // statement := (WITH name := expr (, name := expr)*)? SELECT expr (FILTER expr)? ;*
    $.RULE("statement", (): Statement => {
      const withBindings: WithBinding[] = [];
      $.OPTION(() => {
        $.CONSUME(tokens.kw_with);
        withBindings.push($.SUBRULE($.binding));
        $.MANY(() => {
          $.CONSUME(tokens.comma);
          withBindings.push($.SUBRULE2($.binding));
        });
      });
      const start = $.CONSUME(tokens.kw_select);
      const result = $.SUBRULE($.expression);
      let filter: FilterExpr | undefined;
      $.OPTION2(() => {
        $.CONSUME(tokens.kw_filter);
        const predicate = $.SUBRULE2($.expression);
        filter = $.ACTION(() => {
          if (predicate.kind === "compare" && predicate.right.kind === "literal"
              && predicate.left.kind === "field_access" && predicate.left.expr.kind === "current_item") {
            return {
              kind: "predicate", target: { kind: "field", field: predicate.left.field },
              op: predicate.op, value: predicate.right.value,
            } as FilterExpr;
          }
          throw syntaxError("FILTER expression is outside the grammar-backed AST slice");
        });
      });
      $.MANY2(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => {
        const pos = { line: start.startLine!, column: start.startColumn! };
        if (result.kind === "select" && filter) {
          return {
            kind: "select", typeName: result.typeName, shape: result.shape,
            fields: result.shape.filter((element) => element.kind === "field").map((element) => element.name),
            filter, pos, ...(withBindings.length ? { with: withBindings } : {}),
          };
        }
        if (result.kind === "shape_projection" && result.expr.kind === "select") {
          return {
            kind: "select", typeName: result.expr.typeName, shape: result.shape,
            fields: result.shape.filter((element) => element.kind === "field").map((element) => element.name),
            ...(filter ? { filter } : {}), pos,
            ...(withBindings.length ? { with: withBindings } : {}),
          };
        }
        if (filter) throw syntaxError("FILTER subject is outside the grammar-backed AST slice", pos.line, pos.column);
        return { kind: "select_expr", expr: result, pos, ...(withBindings.length ? { with: withBindings } : {}) };
      });
    });

    $.RULE("binding", (): WithBinding => {
      const name = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      const value = $.SUBRULE($.expression);
      return $.ACTION(() => {
        $.bindings.add(name);
        return { name, value: { kind: "subquery_expr", expr: value } };
      });
    });

    $.RULE("expression", (): FreeObjectExpr => $.SUBRULE($.orExpr));
    $.RULE("orExpr", (): FreeObjectExpr => {
      let left = $.SUBRULE($.andExpr);
      $.MANY(() => {
        $.CONSUME(tokens.kw_or);
        const right = $.SUBRULE2($.andExpr);
        left = $.ACTION(() => ({ kind: "logical", op: "or", left, right }));
      });
      return left;
    });
    $.RULE("andExpr", (): FreeObjectExpr => {
      let left = $.SUBRULE($.comparison);
      $.MANY(() => {
        $.CONSUME(tokens.kw_and);
        const right = $.SUBRULE2($.comparison);
        left = $.ACTION(() => ({ kind: "logical", op: "and", left, right }));
      });
      return left;
    });
    $.RULE("comparison", (): FreeObjectExpr => {
      const left = $.SUBRULE($.additive);
      let result = left;
      $.OPTION(() => {
        const op = $.OR([
          { ALT: () => $.CONSUME(tokens.equals) },
          { ALT: () => $.CONSUME(tokens.not_equals) },
          { ALT: () => $.CONSUME(tokens.lt) },
          { ALT: () => $.CONSUME(tokens.lte) },
          { ALT: () => $.CONSUME(tokens.gt) },
          { ALT: () => $.CONSUME(tokens.gte) },
          { ALT: () => $.CONSUME(tokens.distinct_from) },
          { ALT: () => $.CONSUME(tokens.not_distinct_from) },
        ]);
        const right = $.SUBRULE2($.additive);
        result = $.ACTION(() => ({ kind: "compare", op: op.image as CompareOp, left, right }));
      });
      return result;
    });
    $.RULE("additive", (): FreeObjectExpr => {
      let left = $.SUBRULE($.multiplicative);
      $.MANY(() => {
        const op = $.OR([
          { ALT: () => $.CONSUME(tokens.plus) },
          { ALT: () => $.CONSUME(tokens.minus) },
          { ALT: () => $.CONSUME(tokens.concat) },
        ]);
        const right = $.SUBRULE2($.multiplicative);
        left = $.ACTION(() => op.image === "++"
          ? left.kind === "concat" ? { kind: "concat", parts: [...left.parts, right] } : { kind: "concat", parts: [left, right] }
          : { kind: "math", op: op.image as MathOp, left, right });
      });
      return left;
    });
    $.RULE("multiplicative", (): FreeObjectExpr => {
      let left = $.SUBRULE($.coalescing);
      $.MANY(() => {
        const op = $.OR([
          { ALT: () => $.CONSUME(tokens.star) },
          { ALT: () => $.CONSUME(tokens.slash) },
          { ALT: () => $.CONSUME(tokens.floor_div) },
          { ALT: () => $.CONSUME(tokens.modulo) },
        ]);
        const right = $.SUBRULE2($.coalescing);
        left = $.ACTION(() => ({ kind: "math", op: op.image as MathOp, left, right }));
      });
      return left;
    });
    $.RULE("coalescing", (): FreeObjectExpr => {
      const left = $.SUBRULE($.unary);
      let result = left;
      $.OPTION(() => {
        $.CONSUME(tokens.coalesce);
        const right = $.SUBRULE($.coalescing);
        result = $.ACTION(() => ({ kind: "coalesce", left, right }));
      });
      return result;
    });
    $.RULE("unary", (): FreeObjectExpr => $.OR([
      { ALT: () => {
        $.CONSUME(tokens.minus);
        const expr = $.SUBRULE($.unary);
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "unary", op: "neg", expr }));
      } },
      { ALT: () => {
        $.CONSUME(tokens.plus);
        return $.SUBRULE2($.unary);
      } },
      { ALT: () => {
        $.CONSUME(tokens.kw_not);
        const expr = $.SUBRULE3($.unary);
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "unary", op: "not", expr }));
      } },
      { ALT: () => $.SUBRULE($.power) },
    ]));
    $.RULE("power", (): FreeObjectExpr => {
      const left = $.SUBRULE($.postfix);
      let result = left;
      $.OPTION(() => {
        $.CONSUME(tokens.pow);
        const right = $.SUBRULE($.unary);
        result = $.ACTION(() => ({ kind: "math", op: "^", left, right }));
      });
      return result;
    });
    $.RULE("postfix", (): FreeObjectExpr => {
      let expr = $.SUBRULE($.atom);
      $.MANY(() => $.OR([
        { ALT: () => {
          $.CONSUME(tokens.dot);
          const field = $.CONSUME(Name).image;
          expr = $.ACTION(() => ({ kind: "field_access", expr, field, optional: false }));
        } },
        { ALT: () => {
          $.CONSUME(tokens.lbrace);
          const shape = $.SUBRULE($.shape);
          $.CONSUME(tokens.rbrace);
          expr = $.ACTION(() => ({ kind: "shape_projection", expr, shape }));
        } },
      ]));
      return expr;
    });
    $.RULE("shape", (): ShapeElement[] => {
      const fields: ShapeElement[] = [];
      $.AT_LEAST_ONE_SEP({ SEP: tokens.comma, DEF: () => {
        const name = $.CONSUME(Name).image;
        fields.push($.ACTION(() => ({ kind: "field", name, operation: "assign", origin: "explicit" })));
      } });
      return fields;
    });
    $.RULE("atom", (): FreeObjectExpr => $.OR([
      { ALT: () => {
        const literal = $.CONSUME(tokens.number);
        return $.ACTION(() => numberLiteral(literal.image, literal.startLine!, literal.startColumn!));
      } },
      { ALT: () => {
        const value = $.CONSUME(tokens.string).image;
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "literal", value }));
      } },
      { ALT: () => { $.CONSUME(tokens.kw_true); return $.ACTION<FreeObjectExpr>(() => ({ kind: "literal", value: true })); } },
      { ALT: () => { $.CONSUME(tokens.kw_false); return $.ACTION<FreeObjectExpr>(() => ({ kind: "literal", value: false })); } },
      { ALT: () => { $.CONSUME(tokens.kw_null); return $.ACTION<FreeObjectExpr>(() => ({ kind: "literal", value: null })); } },
      { ALT: () => {
        $.CONSUME(tokens.dot);
        const field = $.CONSUME(Name).image;
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "field_access", expr: { kind: "current_item" }, field, optional: false }));
      } },
      { ALT: () => {
        const name = $.SUBRULE($.qualifiedName);
        let result: FreeObjectExpr | undefined;
        $.OPTION(() => {
          $.CONSUME(tokens.lparen);
          const args: FreeObjectExpr[] = [];
          $.OPTION2(() => $.AT_LEAST_ONE_SEP({ SEP: tokens.comma, DEF: () => {
            args.push($.SUBRULE($.expression));
          } }));
          $.CONSUME(tokens.rparen);
          result = $.ACTION(() => ({
            kind: "function_call", call: { name, args: args.map((expr) => ({ kind: "expr", expr })) },
          }));
        });
        return $.ACTION<FreeObjectExpr>(() => result ?? ($.bindings.has(name) ? { kind: "binding_ref", name } : typeSource(name)));
      } },
      { ALT: () => {
        $.CONSUME2(tokens.lparen);
        const expr = $.SUBRULE2($.expression);
        $.CONSUME2(tokens.rparen);
        return expr;
      } },
    ]));
    $.RULE("qualifiedName", (): string => {
      let name = $.CONSUME(Name).image;
      $.MANY(() => {
        $.CONSUME(tokens.coloncolon);
        const part = $.CONSUME2(Name).image;
        name = $.ACTION(() => `${name}::${part}`);
      });
      return name;
    });

    this.performSelfAnalysis();
  }
}

const grammar = new GrammarParser();

/** Parse one SELECT statement in the supported grammar slice, without fallback. */
export function parseEdgeQLGrammar(source: string): Statement {
  const { tokens: lexical, lineStarts } = tokenizeWithStarts(source);
  const input = lexical.filter((token) => token.kind !== "eof").map((token) => {
    const type = tokens[token.kind as GrammarKind];
    const pos = offsetToLineCol(token.offset, lineStarts);
    if (!type) throw syntaxError(`Unsupported token '${token.lexeme}' in grammar-backed parser`, pos.line, pos.column);
    return createTokenInstance(type, token.lexeme, token.offset, token.offset + token.lexeme.length - 1,
      pos.line, pos.line, pos.column, pos.column + token.lexeme.length - 1);
  });
  grammar.bindings.clear();
  grammar.input = input;
  try {
    const result = grammar.statement();
    if (grammar.errors.length) {
      const error = grammar.errors[0];
      const token = error.token;
      throw syntaxError(error.message, token.startLine ?? 1, token.startColumn ?? 1);
    }
    return result;
  } finally {
    grammar.bindings.clear();
  }
}
