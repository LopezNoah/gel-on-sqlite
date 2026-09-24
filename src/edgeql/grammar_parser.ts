import { EmbeddedActionsParser, Lexer, createToken, createTokenInstance, tokenMatcher, type TokenType } from "chevrotain";
import { AppError } from "../errors.js";
import type { ComputedExpr, FilterExpr, FreeObjectExpr, FunctionCallArgExpr, InsertValue, OrderExpr, OrderExprChain, ShapeElement, Statement, WithBinding } from "./ast.js";
import { offsetToLineCol, tokenizeWithStarts, type TokenKind } from "./tokenizer.js";

// A second, explicitly scoped parser. It reuses the production tokenizer but
// expresses syntax as a validated grammar; no Python or generated code ships.
// The working AST is its output seam, so consumers need no new representation.
const Name = createToken({ name: "Name", pattern: Lexer.NA });
const kinds = [
  "kw_select", "kw_with", "kw_filter", "kw_or", "kw_and", "kw_not",
  "kw_true", "kw_false", "kw_null", "kw_unreserved", "identifier", "backtick_name",
  "number", "string", "semi", "lparen", "rparen", "lbrace", "rbrace", "comma", "colon",
  "dot", "coloncolon", "assign", "plus", "minus", "star", "slash", "floor_div",
  "modulo", "pow", "coalesce", "concat", "equals", "not_equals", "lt", "lte",
  "gt", "gte", "distinct_from", "not_distinct_from",
  "kw_order", "kw_by", "kw_asc", "kw_desc", "kw_empty", "kw_limit", "kw_offset",
  "lbracket", "rbracket", "kw_distinct", "kw_exists",
  "kw_if", "kw_then", "kw_else", "kw_like", "kw_ilike", "parameter",
  "kw_insert", "kw_unless", "kw_conflict",
  "kw_on",
  "kw_update", "kw_delete", "kw_set",
  "kw_for", "kw_in", "kw_union",
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
const functionArg = (expr: FreeObjectExpr, bindings: ReadonlySet<string>): FunctionCallArgExpr =>
  expr.kind === "binding_ref" ? expr
    : expr.kind === "path" && bindings.has(expr.head)
    ? { kind: "expr", expr: { kind: "field_access", expr: { kind: "binding_ref", name: expr.head }, field: expr.tail, optional: false } }
    : expr.kind === "select" && expr.shape.length === 1 && expr.shape[0].kind === "field"
    && expr.shape[0].name === "id" && Object.keys(expr.clauses).length === 0
    ? { kind: "binding_ref", name: expr.typeName }
    : { kind: "expr", expr };

const computedExpr = (expr: FreeObjectExpr): ComputedExpr => {
  if (expr.kind === "literal") return { kind: "literal", value: expr.value };
  if (expr.kind === "binding_ref") return expr;
  if (expr.kind === "function_call") return expr;
  if (expr.kind === "field_access" && expr.expr.kind === "current_item") {
    return { kind: "field_ref", field: expr.field };
  }
  return { kind: "select_expr", expr, clauses: {} };
};
const insertValue = (expr: FreeObjectExpr): InsertValue => {
  if (expr.kind === "literal") return expr.value;
  if (expr.kind === "cast" && expr.expr.kind === "literal") return String(expr.expr.value);
  if (expr.kind === "set_literal") return { kind: "set", values: expr.values };
  if (expr.kind === "select") return { kind: "binding_ref", name: expr.typeName };
  if (expr.kind === "select_expr_subquery" && expr.expr.kind === "select") return expr.expr;
  if (expr.kind === "binding_ref" || expr.kind === "function_call") return expr;
  if (expr.kind === "array_literal_expr" && expr.values.every((value) => value.kind === "literal")) {
    return { kind: "array_literal", values: expr.values.map((value) => (value as Extract<FreeObjectExpr, { kind: "literal" }>).value) };
  }
  return { kind: "expr", expr };
};
const filterFromExpr = (predicate: FreeObjectExpr): FilterExpr => {
  if (predicate.kind === "compare" && predicate.right.kind === "literal"
      && (predicate.left.kind === "path" || predicate.left.kind === "field_access")) {
    const target = predicate.left.kind === "path"
      ? { kind: "field" as const, field: predicate.left.tail, root: predicate.left.head }
      : predicate.left.expr.kind === "current_item"
        ? { kind: "field" as const, field: predicate.left.field }
        : predicate.left.expr.kind === "select"
          ? { kind: "field" as const, field: predicate.left.field, root: predicate.left.expr.typeName }
          : undefined;
    if (!target) throw syntaxError("FILTER path is outside the grammar-backed AST slice");
    return {
      kind: "predicate", target,
      op: predicate.op as Extract<FilterExpr, { kind: "predicate" }>["op"], value: predicate.right.value,
    };
  }
  throw syntaxError("FILTER expression is outside the grammar-backed AST slice");
};
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
  readonly bindingValues = new Map<string, WithBinding["value"]>();
  readonly explicitShapes = new WeakSet<FreeObjectExpr>();
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
  declare shapeEntry: () => ShapeElement;
  declare orderItem: () => { expr: FreeObjectExpr; direction: "asc" | "desc" };
  declare braces: () => FreeObjectExpr;
  declare objectEntry: () => { name: string; expr: FreeObjectExpr };
  declare array: () => FreeObjectExpr;
  declare innerSelect: () => FreeObjectExpr;
  declare insertStatement: () => Statement;
  declare insertEntry: () => { name: string; value: InsertValue };
  declare updateStatement: () => Statement;
  declare deleteStatement: () => Statement;
  declare forStatement: () => Statement;
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
      const head = $.LA(1);
      const result = $.SUBRULE($.expression);
      let filter: FilterExpr | undefined;
      $.OPTION2(() => {
        $.CONSUME(tokens.kw_filter);
        const predicate = $.SUBRULE2($.expression);
        filter = $.ACTION(() => filterFromExpr(predicate));
      });
      let order: ReturnType<GrammarParser["orderItem"]> | undefined;
      $.OPTION3(() => {
        $.CONSUME(tokens.kw_order);
        $.CONSUME(tokens.kw_by);
        order = $.SUBRULE($.orderItem);
      });
      let offset: number | undefined;
      $.OPTION4(() => {
        $.CONSUME(tokens.kw_offset);
        const value = $.CONSUME(tokens.number);
        offset = $.ACTION(() => Number(value.image));
      });
      let limit: number | undefined;
      $.OPTION5(() => {
        $.CONSUME(tokens.kw_limit);
        const value = $.CONSUME2(tokens.number);
        limit = $.ACTION(() => Number(value.image));
      });
      $.MANY2(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => {
        const pos = { line: start.startLine!, column: start.startColumn! };
        const subject = result.kind === "binding_ref" && !$.bindings.has(result.name)
          && (filter || order || limit !== undefined || offset !== undefined)
          ? typeSource(result.name) : result;
        const shaped = $.explicitShapes.has(subject);
        const directShape = subject.kind === "select" && head.image === subject.typeName.split("::")[0]
          && head.tokenTypeIdx !== tokens.lparen.tokenTypeIdx;
        if (subject.kind === "select" && (filter || order || limit !== undefined || offset !== undefined || (shaped && directShape))) {
          const orderField = order?.expr.kind === "field_access" && (
            order.expr.expr.kind === "current_item"
            || (order.expr.expr.kind === "select" && order.expr.expr.typeName === subject.typeName)
          );
          const nameSort = order?.expr.kind === "binding_ref" ? order.expr.name
            : order?.expr.kind === "path" ? `${order.expr.head}.${order.expr.tail}` : undefined;
          const orderBy: OrderExpr | undefined = order && {
            field: orderField ? (order.expr as Extract<FreeObjectExpr, { kind: "field_access" }>).field : nameSort ?? "__expr__",
            ...(orderField || nameSort ? {} : { expr: order.expr }),
            direction: order.direction,
          };
          return {
            kind: "select", typeName: subject.typeName, shape: subject.shape,
            fields: subject.shape.filter((element) => element.kind === "field").map((element) => element.name),
            ...(filter ? { filter } : {}), ...(orderBy ? { orderBy } : {}),
            ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}),
            pos, ...(withBindings.length ? { with: withBindings } : {}),
          };
        }
        if (filter) throw syntaxError("FILTER subject is outside the grammar-backed AST slice", pos.line, pos.column);
        if (subject.kind === "free_object_constructor" && head.tokenTypeIdx === tokens.lbrace.tokenTypeIdx) {
          if (order || offset !== undefined || limit !== undefined) {
            throw syntaxError("Free object clauses are outside the grammar-backed AST slice", pos.line, pos.column);
          }
          return { kind: "select_free", entries: subject.entries, pos,
            ...(withBindings.length ? { with: withBindings } : {}) };
        }
        const orderBy: OrderExprChain | undefined = order && { expr: order.expr, direction: order.direction };
        const expr: FreeObjectExpr = offset !== undefined || limit !== undefined
          ? { kind: "select_expr_subquery", expr: subject, ...(offset !== undefined ? { offset } : {}),
              ...(limit !== undefined ? { limit } : {}) }
          : subject;
        return { kind: "select_expr", expr, ...(orderBy ? { orderBy } : {}), pos,
          ...(withBindings.length ? { with: withBindings } : {}) };
      });
    });

    $.RULE("insertStatement", (): Statement => {
      const start = $.CONSUME(tokens.kw_insert);
      const typeName = $.SUBRULE($.qualifiedName);
      $.CONSUME(tokens.lbrace);
      const values: Record<string, InsertValue> = {};
      $.OPTION(() => {
        const entry = $.SUBRULE($.insertEntry);
        $.ACTION(() => { values[entry.name] = entry.value; });
        $.MANY(() => {
          $.CONSUME(tokens.comma);
          const next = $.SUBRULE2($.insertEntry);
          $.ACTION(() => { values[next.name] = next.value; });
        });
        $.OPTION2(() => $.CONSUME2(tokens.comma));
      });
      $.CONSUME(tokens.rbrace);
      let conflict = false;
      let onFields: string[] | undefined;
      $.OPTION3(() => {
        $.CONSUME(tokens.kw_unless);
        $.CONSUME(tokens.kw_conflict);
        conflict = true;
        $.OPTION4(() => {
          $.CONSUME(tokens.kw_on);
          onFields = $.OR([
            { ALT: () => {
              $.CONSUME(tokens.lparen);
              $.CONSUME(tokens.dot);
              const fields = [$.CONSUME(Name).image];
              $.MANY3(() => {
                $.CONSUME3(tokens.comma);
                $.CONSUME2(tokens.dot);
                fields.push($.CONSUME2(Name).image);
              });
              $.CONSUME(tokens.rparen);
              return fields;
            } },
            { ALT: () => {
              $.CONSUME3(tokens.dot);
              return [$.CONSUME3(Name).image];
            } },
          ]);
        });
      });
      $.MANY2(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => ({ kind: "insert", typeName, values,
        ...(conflict ? { conflict: onFields?.length ? { onField: onFields[0],
          ...(onFields.length > 1 ? { onFields } : {}) } : {} } : {}),
        pos: { line: start.startLine!, column: start.startColumn! } }));
    });
    $.RULE("insertEntry", (): { name: string; value: InsertValue } => {
      const name = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      const expr = $.SUBRULE($.expression);
      return $.ACTION(() => ({ name, value: insertValue(expr) }));
    });

    $.RULE("deleteStatement", (): Statement => {
      const start = $.CONSUME(tokens.kw_delete);
      const subject = $.OR([
        { ALT: () => $.SUBRULE($.qualifiedName) },
        { ALT: () => {
          $.CONSUME(tokens.lparen);
          const target = $.SUBRULE($.innerSelect);
          $.CONSUME(tokens.rparen);
          return $.ACTION(() => target);
        } },
      ]);
      let filter: FilterExpr | undefined;
      $.OPTION(() => {
        $.CONSUME(tokens.kw_filter);
        const predicate = $.SUBRULE($.expression);
        filter = $.ACTION(() => filterFromExpr(predicate));
      });
      $.MANY(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => {
        const pos = { line: start.startLine!, column: start.startColumn! };
        if (typeof subject === "string") {
          return { kind: "delete", typeName: subject, ...(filter ? { filter } : {}), pos };
        }
        if (subject.kind !== "select_expr_subquery" || subject.expr.kind !== "select" || filter) {
          throw syntaxError("DELETE target is outside the grammar-backed AST slice", pos.line, pos.column);
        }
        return { kind: "delete", typeName: subject.expr.typeName, target: subject, pos };
      });
    });

    $.RULE("updateStatement", (): Statement => {
      const start = $.CONSUME(tokens.kw_update);
      const typeName = $.SUBRULE($.qualifiedName);
      let filter: FilterExpr | undefined;
      $.OPTION(() => {
        $.CONSUME(tokens.kw_filter);
        const predicate = $.SUBRULE($.expression);
        filter = $.ACTION(() => filterFromExpr(predicate));
      });
      $.CONSUME(tokens.kw_set);
      $.CONSUME(tokens.lbrace);
      const values: Record<string, InsertValue> = {};
      const operations: Record<string, "assign"> = {};
      $.OPTION2(() => {
        const entry = $.SUBRULE($.insertEntry);
        $.ACTION(() => { values[entry.name] = entry.value; operations[entry.name] = "assign"; });
        $.MANY(() => {
          $.CONSUME(tokens.comma);
          const next = $.SUBRULE2($.insertEntry);
          $.ACTION(() => { values[next.name] = next.value; operations[next.name] = "assign"; });
        });
        $.OPTION3(() => $.CONSUME2(tokens.comma));
      });
      $.CONSUME(tokens.rbrace);
      $.MANY2(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => ({ kind: "update", typeName, ...(filter ? { filter } : {}), values, operations,
        pos: { line: start.startLine!, column: start.startColumn! } }));
    });

    $.RULE("forStatement", (): Statement => {
      const start = $.CONSUME(tokens.kw_for);
      const variable = $.CONSUME(Name).image;
      $.CONSUME(tokens.kw_in);
      const iteratorExpr = $.SUBRULE($.expression);
      $.ACTION(() => {
        $.bindings.add(variable);
        if (iteratorExpr.kind === "select") {
          $.bindingValues.set(variable, { kind: "subquery", query: {
            typeName: iteratorExpr.typeName, shape: iteratorExpr.shape, clauses: {},
          } });
        }
      });
      const body = $.OR([
        { ALT: () => {
          const select = $.CONSUME(tokens.kw_select);
          const expr = $.SUBRULE2($.expression);
          return $.ACTION(() => ({ kind: "select_expr" as const, expr,
            pos: { line: select.startLine!, column: select.startColumn! } }));
        } },
        { ALT: () => {
          $.CONSUME(tokens.kw_union);
          const next = $.LA(1);
          const inner = $.LA(2);
          const expr = $.SUBRULE3($.expression);
          return $.ACTION(() => ({ kind: "select_expr" as const,
            expr: expr.kind === "select_expr_subquery" ? expr.expr : expr,
            pos: next.tokenTypeIdx === tokens.lparen.tokenTypeIdx && inner.tokenTypeIdx === tokens.kw_select.tokenTypeIdx
              ? { line: inner.startLine!, column: inner.startColumn! }
              : { line: start.startLine!, column: start.startColumn! } }));
        } },
      ]);
      $.MANY(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => ({ kind: "for", variable, optional: false, iteratorExpr, body,
        pos: { line: start.startLine!, column: start.startColumn! } }));
    });

    $.RULE("binding", (): WithBinding => {
      const name = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      const head = $.LA(1);
      const value = $.SUBRULE($.expression);
      return $.ACTION(() => {
        $.bindings.add(name);
        const mapped: WithBinding["value"] = value.kind === "select" && head.image === value.typeName.split("::")[0]
          && $.explicitShapes.has(value)
          ? { kind: "subquery", query: { kind: "select", typeName: value.typeName, shape: value.shape, clauses: {} } } as WithBinding["value"]
          : { kind: "subquery_expr", expr: value };
        $.bindingValues.set(name, mapped);
        return { name, value: mapped };
      });
    });

    $.RULE("orderItem", (): { expr: FreeObjectExpr; direction: "asc" | "desc" } => {
      const expr = $.SUBRULE($.expression);
      let direction: "asc" | "desc" = "asc";
      $.OPTION(() => $.OR([
        { ALT: () => { $.CONSUME(tokens.kw_asc); direction = "asc"; } },
        { ALT: () => { $.CONSUME(tokens.kw_desc); direction = "desc"; } },
      ]));
      return { expr, direction };
    });

    $.RULE("expression", (): FreeObjectExpr => {
      const thenExpr = $.SUBRULE($.orExpr);
      let result = thenExpr;
      $.OPTION(() => {
        $.CONSUME(tokens.kw_if);
        const condition = $.SUBRULE2($.orExpr);
        $.CONSUME(tokens.kw_else);
        const elseExpr = $.SUBRULE($.expression);
        result = $.ACTION(() => ({ kind: "if_else", thenExpr, condition, elseExpr }));
      });
      return result;
    });
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
          { ALT: () => $.CONSUME(tokens.kw_like) },
          { ALT: () => $.CONSUME(tokens.kw_ilike) },
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
      { ALT: () => {
        $.CONSUME(tokens.kw_distinct);
        const expr = $.SUBRULE4($.unary);
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "distinct", expr }));
      } },
      { ALT: () => {
        $.CONSUME(tokens.kw_exists);
        const expr = $.SUBRULE5($.unary);
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "exists", expr }));
      } },
      { ALT: () => {
        $.CONSUME(tokens.lt);
        const castType = $.SUBRULE($.qualifiedName);
        $.CONSUME(tokens.gt);
        const expr = $.SUBRULE6($.unary);
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "cast", castType, expr }));
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
          expr = $.ACTION(() => expr.kind === "binding_ref" && $.bindingValues.get(expr.name)?.kind !== "subquery"
            ? { kind: "path", head: expr.name, tail: field,
                steps: [{ kind: "object_ref", name: expr.name }, { kind: "ptr", name: field, direction: "outbound" }] }
            : { kind: "field_access", expr: expr.kind === "field_access" && expr.expr.kind === "current_item"
                ? { kind: "field_access", expr: expr.expr, field: expr.field } : expr, field, optional: false });
        } },
        { ALT: () => {
          $.CONSUME(tokens.lbrace);
          const shape = $.SUBRULE($.shape);
          $.CONSUME(tokens.rbrace);
          expr = $.ACTION(() => {
            if (expr.kind === "select") {
              const shaped: FreeObjectExpr = { kind: "select", typeName: expr.typeName, shape, clauses: {} };
              $.explicitShapes.add(shaped);
              return shaped;
            }
            return { kind: "shape_projection", expr, shape };
          });
        } },
        { ALT: () => {
          $.CONSUME(tokens.lbracket);
          const index = $.CONSUME(tokens.number);
          $.CONSUME(tokens.rbracket);
          expr = $.ACTION(() => ({ kind: "index_access", expr, index: Number(index.image) }));
        } },
      ]));
      return expr;
    });
    $.RULE("shape", (): ShapeElement[] => {
      const fields: ShapeElement[] = [];
      $.OPTION(() => {
        fields.push($.SUBRULE($.shapeEntry));
        $.MANY(() => {
          $.CONSUME(tokens.comma);
          fields.push($.SUBRULE2($.shapeEntry));
        });
        $.OPTION2(() => $.CONSUME2(tokens.comma));
      });
      return fields;
    });
    $.RULE("shapeEntry", (): ShapeElement => {
      const name = $.CONSUME(Name).image;
      let result: ShapeElement | undefined;
      $.OPTION(() => $.OR([
        { ALT: () => {
          $.CONSUME(tokens.assign);
          const expr = $.SUBRULE($.expression);
          result = $.ACTION(() => ({
            kind: "computed", name, expr: computedExpr(expr), operation: "assign", origin: "explicit",
          }));
        } },
        { ALT: () => {
          $.CONSUME(tokens.colon);
          $.CONSUME(tokens.lbrace);
          const shape = $.SUBRULE($.shape);
          $.CONSUME(tokens.rbrace);
          result = $.ACTION(() => ({
            kind: "link", name, shape, clauses: {}, operation: "assign", origin: "explicit",
          }));
        } },
      ]));
      return $.ACTION(() => result ?? { kind: "field", name, operation: "assign", origin: "explicit" });
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
      { ALT: () => {
        const param = $.CONSUME(tokens.parameter).image;
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "parameter", name: param.slice(1) }));
      } },
      { ALT: () => {
        $.CONSUME(tokens.kw_if);
        const condition = $.SUBRULE3($.expression);
        $.CONSUME(tokens.kw_then);
        const thenExpr = $.SUBRULE4($.expression);
        $.CONSUME(tokens.kw_else);
        const elseExpr = $.SUBRULE5($.expression);
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "if_else", thenExpr, condition, elseExpr }));
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
            kind: "function_call", call: { name, args: args.map((arg) => functionArg(arg, $.bindings)) },
          }));
        });
        return $.ACTION<FreeObjectExpr>(() => result ?? ($.bindings.has(name) || !/[A-Z]/.test(name.split("::").pop()?.[0] ?? "")
          ? { kind: "binding_ref", name } : typeSource(name)));
      } },
      { ALT: () => {
        $.CONSUME2(tokens.lparen);
        const expr = $.SUBRULE2($.expression);
        $.CONSUME2(tokens.rparen);
        return expr;
      } },
      { GATE: () => tokenMatcher($.LA(2), tokens.kw_select), ALT: () => {
        $.CONSUME3(tokens.lparen);
        const expr = $.SUBRULE($.innerSelect);
        $.CONSUME3(tokens.rparen);
        return expr;
      } },
      { ALT: () => $.SUBRULE($.braces) },
      { ALT: () => $.SUBRULE($.array) },
    ]));
    $.RULE("innerSelect", (): FreeObjectExpr => {
      $.CONSUME(tokens.kw_select);
      const expr = $.SUBRULE($.expression);
      let filter: FilterExpr | undefined;
      $.OPTION(() => {
        $.CONSUME(tokens.kw_filter);
        const predicate = $.SUBRULE2($.expression);
        filter = $.ACTION(() => filterFromExpr(predicate));
      });
      let order: ReturnType<GrammarParser["orderItem"]> | undefined;
      $.OPTION2(() => {
        $.CONSUME(tokens.kw_order);
        $.CONSUME(tokens.kw_by);
        order = $.SUBRULE($.orderItem);
      });
      let limit: number | undefined;
      $.OPTION3(() => {
        $.CONSUME(tokens.kw_limit);
        limit = Number($.CONSUME(tokens.number).image);
      });
      return $.ACTION(() => {
        if (filter && expr.kind !== "select") {
          throw syntaxError("Nested FILTER subject is outside the grammar-backed AST slice");
        }
        const sortField = order?.expr.kind === "field_access" && order.expr.expr.kind === "current_item"
          ? order.expr.field : undefined;
        const sortInShape = order && expr.kind === "select" && $.explicitShapes.has(expr)
          && sortField !== undefined;
        const inner: FreeObjectExpr = expr.kind === "select" && (filter || sortInShape)
          ? { ...expr, clauses: { ...expr.clauses, ...(filter ? { filter } : {}),
              ...(sortInShape ? { orderBy: { field: sortField, direction: order!.direction } } : {}) } }
          : expr;
        return { kind: "select_expr_subquery", expr: inner,
          ...(order && !sortInShape ? { orderBy: { expr: order.expr, direction: order.direction } } : {}),
          ...(limit !== undefined ? { limit } : {}) };
      });
    });
    $.RULE("objectEntry", (): { name: string; expr: FreeObjectExpr } => {
      const name = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      const expr = $.SUBRULE($.expression);
      return { name, expr };
    });
    $.RULE("braces", (): FreeObjectExpr => {
      $.CONSUME(tokens.lbrace);
      const result = $.OR([
        { GATE: () => tokenMatcher($.LA(1), Name) && tokenMatcher($.LA(2), tokens.assign), ALT: () => {
          const entries = [$.SUBRULE($.objectEntry)];
          $.MANY(() => {
            $.CONSUME(tokens.comma);
            entries.push($.SUBRULE2($.objectEntry));
          });
          $.OPTION(() => $.CONSUME2(tokens.comma));
          return $.ACTION<FreeObjectExpr>(() => ({ kind: "free_object_constructor", entries }));
        } },
        { ALT: () => {
          const values: FreeObjectExpr[] = [];
          $.OPTION2(() => {
            values.push($.SUBRULE($.expression));
            $.MANY2(() => {
              $.CONSUME3(tokens.comma);
              values.push($.SUBRULE2($.expression));
            });
            $.OPTION3(() => $.CONSUME4(tokens.comma));
          });
          return $.ACTION<FreeObjectExpr>(() => values.every((v) => v.kind === "literal" && (!v.numericKind || v.numericKind === "integer"))
            ? { kind: "set_literal", values: values.map((v) => (v as Extract<FreeObjectExpr, { kind: "literal" }>).value) }
            : { kind: "set_expr", values });
        } },
      ]);
      $.CONSUME(tokens.rbrace);
      return result;
    });
    $.RULE("array", (): FreeObjectExpr => {
      $.CONSUME(tokens.lbracket);
      const values: FreeObjectExpr[] = [];
      $.OPTION(() => {
        values.push($.SUBRULE($.expression));
        $.MANY(() => {
          $.CONSUME(tokens.comma);
          values.push($.SUBRULE2($.expression));
        });
        $.OPTION2(() => $.CONSUME2(tokens.comma));
      });
      $.CONSUME(tokens.rbracket);
      return $.ACTION(() => ({ kind: "array_literal_expr", values }));
    });
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

/** Parse one supported EdgeQL statement without falling back to the handwritten parser. */
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
  grammar.bindingValues.clear();
  grammar.input = input;
  try {
    const result = lexical[0]?.kind === "kw_insert" ? grammar.insertStatement()
      : lexical[0]?.kind === "kw_update" ? grammar.updateStatement()
      : lexical[0]?.kind === "kw_delete" ? grammar.deleteStatement()
      : lexical[0]?.kind === "kw_for" ? grammar.forStatement() : grammar.statement();
    if (grammar.errors.length) {
      const error = grammar.errors[0];
      const token = error.token;
      throw syntaxError(error.message, token.startLine ?? 1, token.startColumn ?? 1);
    }
    return result;
  } finally {
    grammar.bindings.clear();
    grammar.bindingValues.clear();
  }
}

/** Parse a script of supported statements. Separators inside nested forms or
 * strings are not statement boundaries; the production tokenizer identifies
 * both. Each statement is parsed through the same grammar (no legacy retry). */
export function parseEdgeQLGrammarScript(source: string): Statement[] {
  const { tokens: lexical, lineStarts } = tokenizeWithStarts(source);
  const statements: Statement[] = [];
  let depth = 0;
  let start = 0;
  const parsePiece = (end: number): void => {
    const piece = source.slice(start, end);
    const first = lexical.find((token) => token.offset >= start && token.offset < end && token.kind !== "semi");
    if (first) {
      const statement = parseEdgeQLGrammar(piece);
      const localStart = offsetToLineCol(first.offset - start, piece);
      const globalStart = offsetToLineCol(first.offset, lineStarts);
      statement.pos = {
        line: globalStart.line + statement.pos.line - localStart.line,
        column: statement.pos.line === localStart.line
          ? globalStart.column + statement.pos.column - localStart.column
          : statement.pos.column,
      };
      statements.push(statement);
    }
    start = end;
  };
  for (const token of lexical) {
    if (token.kind === "lbrace" || token.kind === "lparen" || token.kind === "lbracket") depth++;
    if (token.kind === "rbrace" || token.kind === "rparen" || token.kind === "rbracket") depth--;
    if (token.kind === "semi" && depth === 0) parsePiece(token.offset + 1);
  }
  parsePiece(source.length);
  return statements;
}
