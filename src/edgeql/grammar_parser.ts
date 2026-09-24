import { EmbeddedActionsParser, Lexer, createToken, createTokenInstance, tokenMatcher, type TokenType } from "chevrotain";
import { AppError } from "../errors.js";
import { extractTrailingBraceBlock, parseAlterTypeBody, parseCreateTypeBody, type AlterTypeOp } from "./ddl_body.js";
import type { ComputedExpr, ConfigureStatement, DDLStatement, FilterExpr, FreeObjectExpr, FunctionCallArgExpr, FunctionDecl, FunctionParamDecl, GroupByAtom, GroupByElement, GroupExpr, GroupStatement, InsertValue, OrderExpr, OrderExprChain, ShapeElement, Statement, TypeExpr, WithBinding } from "./ast.js";
import { offsetToLineCol, tokenizeWithStarts, type Token, type TokenKind } from "./tokenizer.js";

// A second, explicitly scoped parser. It reuses the production tokenizer but
// expresses syntax as a validated grammar; no Python or generated code ships.
// The working AST is its output seam, so consumers need no new representation.
const Name = createToken({ name: "Name", pattern: Lexer.NA });
const kinds = [
  "kw_select", "kw_with", "kw_filter", "kw_or", "kw_and", "kw_not",
  "kw_true", "kw_false", "kw_null", "kw_unreserved", "identifier", "backtick_name",
  "number", "string", "bytes_string", "semi", "lparen", "rparen", "lbrace", "rbrace", "comma", "colon",
  "dot", "coloncolon", "assign", "plus", "minus", "star", "slash", "floor_div",
  "modulo", "pow", "coalesce", "concat", "equals", "not_equals", "lt", "lte",
  "gt", "gte", "distinct_from", "not_distinct_from",
  "kw_order", "kw_by", "kw_asc", "kw_desc", "kw_empty", "kw_limit", "kw_offset",
  "lbracket", "rbracket", "kw_distinct", "kw_exists",
  "kw_if", "kw_then", "kw_else", "kw_like", "kw_ilike", "parameter",
  "kw_insert", "kw_unless", "kw_conflict",
  "kw_on", "kw_module",
  "kw_update", "kw_delete", "kw_set",
  "kw_for", "kw_in", "kw_union", "kw_except", "kw_intersect",
  "kw_group", "kw_using", "kw_is", "kw_detached", "backward_link", "optional_link", "at",
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
  kind: "select", typeName: name, shape: defaultShape(), clauses: {}, detached: undefined,
});
const inModule = (name: string, module: string | undefined): string =>
  module && !name.includes("::") ? `${module}::${name}` : name;
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
  if (predicate.kind === "and" || predicate.kind === "or") {
    return { kind: predicate.kind, left: filterFromExpr(predicate.left), right: filterFromExpr(predicate.right) };
  }
  if (predicate.kind === "unary" && predicate.op === "not") {
    return { kind: "not", expr: filterFromExpr(predicate.expr) };
  }
  const targetFor = (left: FreeObjectExpr): Extract<FilterExpr, { kind: "predicate" | "in_predicate" }> ["target"] | undefined => {
    if (left.kind === "path") return { kind: "field", field: left.tail, root: left.head };
    if (left.kind !== "field_access") return undefined;
    if (left.expr.kind === "current_item") return { kind: "field", field: left.field };
    if (left.expr.kind === "select") return { kind: "field", field: left.field, root: left.expr.typeName };
    if (left.expr.kind === "binding_ref") return { kind: "field", field: left.field, root: left.expr.name };
    return undefined;
  };
  if (predicate.kind === "in_expr") {
    const target = targetFor(predicate.left);
    if (!target) throw syntaxError("FILTER IN target is outside the grammar-backed AST slice");
    const values = predicate.right.kind === "set_literal" ? predicate.right
      : predicate.right.kind === "set_expr" ? { kind: "expr_set" as const, values: predicate.right.values }
      : predicate.right.kind === "select" ? { kind: "select" as const, query: {
          typeName: predicate.right.typeName, shape: predicate.right.shape, clauses: predicate.right.clauses,
        } }
      : predicate.right.kind === "binding_ref" ? { kind: "name" as const, name: predicate.right.name }
      : { kind: "expr_set" as const, values: [predicate.right] };
    return { kind: "in_predicate", target, op: predicate.op, values };
  }
  if (predicate.kind === "compare" && predicate.right.kind === "literal"
      && (predicate.left.kind === "path" || predicate.left.kind === "field_access")) {
    const target = targetFor(predicate.left);
    if (!target) return { kind: "free_expr", expr: predicate };
    return {
      kind: "predicate", target,
      op: predicate.op as Extract<FilterExpr, { kind: "predicate" }>["op"], value: predicate.right.value,
    };
  }
  return { kind: "free_expr", expr: predicate };
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
  defaultModule?: string;
  declare statement: () => Statement;
  declare binding: () => WithBinding;
  declare withDmlStatement: () => Statement;
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
  declare groupStatement: () => GroupStatement;
  declare groupExpr: () => GroupExpr;
  declare groupByElement: () => GroupByElement;
  declare groupByAtom: () => GroupByAtom;
  declare groupByAtomList: () => GroupByAtom[];
  declare groupUsing: () => { alias: string; expr: FreeObjectExpr };
  declare tupleEntries: () => Array<{ name: string; expr: FreeObjectExpr }>;
  declare parenthesized: () => FreeObjectExpr;
  declare subscriptBound: () => FreeObjectExpr;
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
      let filterExpr: FreeObjectExpr | undefined;
      $.OPTION2(() => {
        $.CONSUME(tokens.kw_filter);
        const predicate = $.SUBRULE2($.expression);
        filterExpr = predicate;
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
          && (filter || filterExpr || order || limit !== undefined || offset !== undefined)
          ? typeSource(inModule(result.name, $.defaultModule)) : result;
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
        if (filterExpr) {
          const expr: FreeObjectExpr = { kind: "select_expr_subquery", expr: subject, filter: filterExpr,
            ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) };
          return { kind: "select_expr", expr, pos,
            ...(withBindings.length ? { with: withBindings } : {}) };
        }
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
      return $.ACTION(() => ({ kind: "insert", typeName: inModule(typeName, $.defaultModule), values,
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
          return { kind: "delete", typeName: inModule(subject, $.defaultModule), ...(filter ? { filter } : {}), pos };
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
      return $.ACTION(() => ({ kind: "update", typeName: inModule(typeName, $.defaultModule), ...(filter ? { filter } : {}), values, operations,
        pos: { line: start.startLine!, column: start.startColumn! } }));
    });

    $.RULE("forStatement", (): Statement => {
      const start = $.CONSUME(tokens.kw_for);
      const variable = $.CONSUME(Name).image;
      $.CONSUME(tokens.kw_in);
      const iteratorExpr = $.SUBRULE($.orExpr);
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

    $.RULE("groupStatement", (): GroupStatement => {
      let withBindings: WithBinding[] = [];
      $.OPTION(() => {
        $.CONSUME(tokens.kw_with);
        withBindings = [$.SUBRULE($.binding)];
        $.MANY2(() => {
          $.CONSUME(tokens.comma);
          withBindings.push($.SUBRULE2($.binding));
        });
      });
      const start = $.LA(1);
      const group = $.SUBRULE($.groupExpr);
      $.MANY(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => ({ ...group, kind: "group", pos: {
        line: start.startLine!, column: start.startColumn!,
      }, ...(withBindings.length ? { with: withBindings } : {}) }));
    });


    $.RULE("groupExpr", (): GroupExpr => {
      $.CONSUME(tokens.kw_group);
      let source = $.SUBRULE($.expression);
      if (source.kind === "select") {
        source = { ...source, shape: source.shape.map((element) => ({
          ...element, cardinality: element.cardinality, required: element.required,
          where: element.where, orderBy: element.orderBy, offset: element.offset,
          limit: element.limit, offsetExpr: element.offsetExpr, limitExpr: element.limitExpr,
        })) };
      }
      const using: Array<{ alias: string; expr: FreeObjectExpr }> = [];
      $.OPTION(() => {
        $.CONSUME(tokens.kw_using);
        using.push($.SUBRULE($.groupUsing));
        $.MANY2({ GATE: () => tokenMatcher($.LA(1), tokens.comma)
          && !tokenMatcher($.LA(2), tokens.kw_by), DEF: () => {
          $.CONSUME(tokens.comma);
          using.push($.SUBRULE2($.groupUsing));
        } });
        $.OPTION2({ GATE: () => tokenMatcher($.LA(1), tokens.comma)
          && tokenMatcher($.LA(2), tokens.kw_by), DEF: () => $.CONSUME2(tokens.comma) });
      });
      $.CONSUME(tokens.kw_by);
      const by = [$.SUBRULE($.groupByElement)];
      $.MANY3(() => {
        $.CONSUME3(tokens.comma);
        by.push($.SUBRULE2($.groupByElement));
      });
      return $.ACTION(() => ({ kind: "group_expr", source,
        using: using.length ? using : undefined, by }));
    });

    $.RULE("groupUsing", (): { alias: string; expr: FreeObjectExpr } => {
      const alias = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      const expr = $.SUBRULE($.expression);
      return { alias, expr };
    });

    $.RULE("groupByElement", (): GroupByElement => {
      const result = $.OR([
        { ALT: () => {
          $.CONSUME(tokens.lbrace);
          const sets: GroupByAtom[][] = [];
          $.OPTION(() => {
            const first = $.SUBRULE($.groupByAtom);
            sets.push([first]);
            $.MANY(() => {
              $.CONSUME(tokens.comma);
              const atom = $.SUBRULE2($.groupByAtom);
              sets.push([atom]);
            });
            $.OPTION2(() => $.CONSUME2(tokens.comma));
          });
          $.CONSUME(tokens.rbrace);
          return $.ACTION(() => ({ kind: "sets" as const, sets }));
        } },
        { GATE: () => tokenMatcher($.LA(1), Name) && tokenMatcher($.LA(2), tokens.lparen)
          && ["cube", "rollup"].includes($.LA(1).image.toLowerCase()), ALT: () => {
          const operation = $.CONSUME(Name).image.toLowerCase();
          $.CONSUME(tokens.lparen);
          const atoms = $.SUBRULE4($.groupByAtomList);
          $.CONSUME(tokens.rparen);
          return operation === "cube" ? { kind: "cube", atoms } : { kind: "rollup", atoms };
        } },
        { ALT: () => {
          $.CONSUME2(tokens.lparen);
          const atoms = $.SUBRULE5($.groupByAtomList);
          $.CONSUME2(tokens.rparen);
          return { kind: "sets", sets: [atoms] };
        } },
        { ALT: () => $.SUBRULE3($.groupByAtom) },
      ]);
      return result;
    });

    $.RULE("groupByAtomList", (): GroupByAtom[] => {
      const atoms = [$.SUBRULE($.groupByAtom)];
      $.MANY(() => {
        $.CONSUME(tokens.comma);
        atoms.push($.SUBRULE2($.groupByAtom));
      });
      return atoms;
    });

    $.RULE("groupByAtom", (): GroupByAtom => $.OR([
      { ALT: () => {
        $.CONSUME(tokens.dot);
        const field = $.CONSUME(Name);
        return { kind: "field_ref", field: field.image };
      } },
      { ALT: () => {
        $.CONSUME(tokens.at);
        return { kind: "link_property_ref", name: $.CONSUME2(Name).image };
      } },
      { ALT: () => ({ kind: "name_ref", name: $.CONSUME3(Name).image }) },
    ]));

    $.RULE("binding", (): WithBinding => {
      const name = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      const head = $.LA(1);
      const value = $.SUBRULE($.expression);
      return $.ACTION(() => {
        $.bindings.add(name);
        const mapped: WithBinding["value"] = value.kind === "select"
          && (head.image === value.typeName.split("::")[0] || head.tokenTypeIdx === tokens.kw_detached.tokenTypeIdx)
          ? { kind: "subquery", query: {
              kind: "select" as const,
              typeName: value.typeName, shape: value.shape, clauses: value.clauses,
              detached: value.detached,
            } } as WithBinding["value"]
          : { kind: "subquery_expr", expr: value };
        $.bindingValues.set(name, mapped);
        return { name, value: mapped };
      });
    });

    $.RULE("withDmlStatement", (): Statement => {
      $.CONSUME(tokens.kw_with);
      const withBindings = [$.SUBRULE($.binding)];
      $.MANY(() => {
        $.CONSUME(tokens.comma);
        withBindings.push($.SUBRULE2($.binding));
      });
      const statement = $.OR([
        { ALT: () => $.SUBRULE($.insertStatement) },
        { ALT: () => $.SUBRULE($.updateStatement) },
        { ALT: () => $.SUBRULE($.deleteStatement) },
        { ALT: () => $.SUBRULE($.forStatement) },
      ]);
      return $.ACTION(() => ({ ...statement, with: withBindings } as Statement));
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
      $.MANY(() => {
        const op = $.OR([
          { ALT: () => $.CONSUME(tokens.kw_union) },
          { ALT: () => $.CONSUME(tokens.kw_intersect) },
          { ALT: () => $.CONSUME(tokens.kw_except) },
        ]);
        const right = $.SUBRULE3($.orExpr);
        result = $.ACTION(() => op.tokenTypeIdx === tokens.kw_union.tokenTypeIdx
          ? result.kind === "set_expr" ? { kind: "set_expr", values: [...result.values, right] }
            : { kind: "set_expr", values: [result, right] }
          : { kind: "set_op", op: op.tokenTypeIdx === tokens.kw_intersect.tokenTypeIdx ? "intersect" : "except",
              left: result, right });
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
      $.OPTION2(() => {
        let op: "in" | "not_in" = "in";
        $.OR2([
          { ALT: () => { $.CONSUME(tokens.kw_in); op = "in"; } },
          { ALT: () => { $.CONSUME(tokens.kw_not); $.CONSUME2(tokens.kw_in); op = "not_in"; } },
        ]);
        const right = $.SUBRULE3($.additive);
        result = $.ACTION(() => ({ kind: "in_expr", op, left, right }));
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
          const backlink = $.CONSUME(tokens.backward_link);
          const link = $.CONSUME(Name).image;
          let sourceType: TypeExpr | undefined;
          $.OPTION(() => {
            $.CONSUME(tokens.lbracket);
            $.CONSUME(tokens.kw_is);
            const typeName = $.SUBRULE($.qualifiedName);
            $.CONSUME(tokens.rbracket);
            sourceType = { kind: "type_name", name: typeName };
          });
          expr = $.ACTION(() => ({
            kind: "for_expr", variable: "__gel_backlink_item__", iterator: expr,
            body: { kind: "backlink_path", link, sourceType: sourceType?.kind === "type_name" ? sourceType.name : undefined,
              sourceTypeExpr: sourceType, optional: false },
          }));
          void backlink;
        } },
        { ALT: () => {
          $.CONSUME(tokens.dot);
          const field = $.CONSUME2(Name).image;
          expr = $.ACTION(() => expr.kind === "path_steps"
            ? { ...expr, steps: [...expr.steps, { kind: "ptr", name: field, direction: "outbound", optional: false }] }
            : expr.kind === "binding_ref" && $.bindingValues.get(expr.name)?.kind !== "subquery"
            ? { kind: "path", head: expr.name, tail: field,
                steps: [{ kind: "object_ref", name: expr.name }, { kind: "ptr", name: field, direction: "outbound" }] }
            : { kind: "field_access", expr: expr.kind === "field_access" && expr.expr.kind === "current_item"
                ? { kind: "field_access", expr: expr.expr, field: expr.field, optional: false } : expr, field, optional: false });
        } },
        { ALT: () => {
          $.CONSUME(tokens.at);
          const property = $.CONSUME3(Name).image;
          expr = $.ACTION(() => ({ kind: "field_access", expr, field: `@${property}` }));
        } },
        { ALT: () => {
          $.CONSUME(tokens.lbrace);
          const shape = $.SUBRULE($.shape);
          $.CONSUME(tokens.rbrace);
          expr = $.ACTION(() => {
            if (expr.kind === "select") {
              const shaped: FreeObjectExpr = { ...expr, shape, clauses: {} };
              $.explicitShapes.add(shaped);
              return shaped;
            }
            if (expr.kind === "binding_ref" && $.bindingValues.get(expr.name)?.kind === "subquery") {
              const binding = $.bindingValues.get(expr.name);
              const shaped: FreeObjectExpr = {
                kind: "select", typeName: expr.name, shape, clauses: {},
                detached: binding?.kind === "subquery" ? binding.query.detached : undefined,
              };
              $.explicitShapes.add(shaped);
              return shaped;
            }
            return { kind: "shape_projection", expr, shape };
          });
        } },
        { ALT: () => {
          $.CONSUME2(tokens.lbracket);
          const subscript = $.OR2([
            { GATE: () => tokenMatcher($.LA(1), tokens.kw_is), ALT: () => {
              $.CONSUME2(tokens.kw_is);
              const typeName = $.SUBRULE2($.qualifiedName);
              $.CONSUME2(tokens.rbracket);
              return $.ACTION<FreeObjectExpr>(() => {
                const typeExpr: TypeExpr = { kind: "type_name", name: typeName };
                const steps = expr.kind === "select" ? [{ kind: "object_ref" as const, name: expr.typeName }]
                  : expr.kind === "path_steps" ? expr.steps : undefined;
                return steps
                  ? { kind: "path_steps", steps: [...steps, { kind: "type_intersection", typeName, typeExpr }],
                      partial: expr.kind === "path_steps" ? expr.partial : undefined }
                  : { kind: "is_type", expr, typeName, typeExpr, intersection: true };
              });
            } },
            { ALT: () => {
              let first: FreeObjectExpr | undefined;
              let end: FreeObjectExpr | undefined;
              $.OPTION2({ GATE: () => !tokenMatcher($.LA(1), tokens.colon)
                && !tokenMatcher($.LA(1), tokens.rbracket), DEF: () => { first = $.SUBRULE($.subscriptBound); } });
              let isSlice = false;
              $.OPTION3(() => {
                $.CONSUME(tokens.colon);
                isSlice = true;
                $.OPTION4({ GATE: () => !tokenMatcher($.LA(1), tokens.rbracket), DEF: () => {
                  end = $.SUBRULE2($.subscriptBound);
                } });
              });
              $.CONSUME3(tokens.rbracket);
              const numberValue = (value: FreeObjectExpr | undefined): number | undefined =>
                value?.kind === "literal" && typeof value.value === "number" ? value.value : undefined;
              return $.ACTION<FreeObjectExpr>(() => {
                if (isSlice) return { kind: "slice_access", expr, start: numberValue(first), end: numberValue(end),
                  ...(first && numberValue(first) === undefined ? { startExpr: first } : {}),
                  ...(end && numberValue(end) === undefined ? { endExpr: end } : {}) };
                if (!first) throw syntaxError("Empty subscript is not supported");
                return { kind: "index_access", expr, index: numberValue(first) ?? 0,
                  ...(numberValue(first) === undefined ? { indexExpr: first } : {}) };
              });
            } },
          ]);
          expr = subscript;
        } },
      ]));
      return expr;
    });
    $.RULE("subscriptBound", (): FreeObjectExpr => $.SUBRULE($.unary));
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
    $.RULE("shapeEntry", (): ShapeElement => $.OR([
      { GATE: () => tokenMatcher($.LA(1), tokens.backward_link), ALT: () => {
        $.CONSUME(tokens.backward_link);
        const name = $.CONSUME(Name).image;
        let sourceType: TypeExpr | undefined;
        $.OPTION(() => {
          $.CONSUME(tokens.lbracket);
          $.CONSUME(tokens.kw_is);
          sourceType = { kind: "type_name", name: $.SUBRULE($.qualifiedName) };
          $.CONSUME(tokens.rbracket);
        });
        let nestedShape: ShapeElement[] | undefined;
        $.OPTION2(() => {
          $.CONSUME(tokens.lbrace);
          nestedShape = $.SUBRULE($.shape);
          $.CONSUME(tokens.rbrace);
        });
        return $.ACTION(() => ({ kind: "backlink", name,
          expr: { link: name, sourceType: sourceType?.kind === "type_name" ? sourceType.name : undefined,
            sourceTypeExpr: sourceType }, ...(nestedShape ? { shape: nestedShape } : {}),
          operation: "assign", origin: "explicit" }));
      } },
      { GATE: () => tokenMatcher($.LA(1), tokens.at), ALT: () => {
        $.CONSUME(tokens.at);
        const property = $.CONSUME3(Name).image;
        let expr: ComputedExpr = { kind: "field_ref", field: `@${property}` };
        $.OPTION4(() => {
          $.CONSUME2(tokens.assign);
          expr = computedExpr($.SUBRULE2($.expression));
        });
        return $.ACTION(() => ({ kind: "computed", name: `@${property}`, expr,
          operation: "assign", origin: "explicit" }));
      } },
      { ALT: () => {
        const name = $.CONSUME2(Name).image;
        let result: ShapeElement | undefined;
        $.OPTION3(() => $.OR2([
          { ALT: () => {
            $.CONSUME3(tokens.assign);
            const expr = $.SUBRULE3($.expression);
            result = $.ACTION(() => ({
              kind: "computed", name, expr: computedExpr(expr), operation: "assign", origin: "explicit",
            }));
          } },
          { ALT: () => {
            $.CONSUME(tokens.colon);
            $.CONSUME2(tokens.lbrace);
            const shape = $.SUBRULE2($.shape);
            $.CONSUME2(tokens.rbrace);
            result = $.ACTION(() => ({
              kind: "link", name, shape, clauses: {}, operation: "assign", origin: "explicit",
            }));
          } },
        ]));
        return $.ACTION(() => result ?? { kind: "field", name, operation: "assign", origin: "explicit" });
      } },
    ]));
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
        const value = $.CONSUME(tokens.bytes_string).image;
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
        $.CONSUME(tokens.kw_detached);
        const typeName = $.SUBRULE2($.qualifiedName);
        return $.ACTION<FreeObjectExpr>(() => ({ ...typeSource(inModule(typeName, $.defaultModule)), detached: true }));
      } },
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
          ? { kind: "binding_ref", name } : typeSource(inModule(name, $.defaultModule))));
      } },
      { ALT: () => $.SUBRULE($.parenthesized) },
      { ALT: () => $.SUBRULE($.groupExpr) },
      { ALT: () => $.SUBRULE($.braces) },
      { ALT: () => $.SUBRULE($.array) },
    ]));
    $.RULE("innerSelect", (): FreeObjectExpr => {
      $.CONSUME(tokens.kw_select);
      const expr = $.SUBRULE($.expression);
      let filterExpr: FreeObjectExpr | undefined;
      $.OPTION(() => {
        $.CONSUME(tokens.kw_filter);
        filterExpr = $.SUBRULE2($.expression);
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
        const filter = filterExpr && expr.kind === "select" ? filterFromExpr(filterExpr) : undefined;
        const sortField = order?.expr.kind === "field_access" && order.expr.expr.kind === "current_item"
          ? order.expr.field : undefined;
        const sortInShape = order && expr.kind === "select" && $.explicitShapes.has(expr)
          && sortField !== undefined;
        const inner: FreeObjectExpr = expr.kind === "select" && (filter || sortInShape)
          ? { ...expr, clauses: { ...expr.clauses, ...(filter ? { filter } : {}),
              ...(sortInShape ? { orderBy: { field: sortField, direction: order!.direction } } : {}) } }
          : expr;
        return { kind: "select_expr_subquery", expr: inner,
          filter: filterExpr && expr.kind !== "select" ? filterExpr : undefined,
          orderBy: order && !sortInShape ? { expr: order.expr, direction: order.direction } : undefined,
          limit, offset: undefined, limitExpr: undefined, offsetExpr: undefined };
      });
    });
    $.RULE("objectEntry", (): { name: string; expr: FreeObjectExpr } => {
      const name = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      const expr = $.SUBRULE($.expression);
      return { name, expr };
    });
    $.RULE("tupleEntries", (): Array<{ name: string; expr: FreeObjectExpr }> => {
      const entries = [$.SUBRULE($.objectEntry)];
      $.MANY(() => {
        $.CONSUME(tokens.comma);
        entries.push($.SUBRULE2($.objectEntry));
      });
      $.OPTION(() => $.CONSUME2(tokens.comma));
      return entries;
    });
    $.RULE("parenthesized", (): FreeObjectExpr => {
      $.CONSUME(tokens.lparen);
      const result = $.OR([
        { GATE: () => tokenMatcher($.LA(1), tokens.rparen), ALT: () => {
          $.CONSUME(tokens.rparen);
          return { kind: "tuple" as const, values: [] };
        } },
        { GATE: () => tokenMatcher($.LA(1), tokens.kw_select), ALT: () => {
          const expr = $.SUBRULE($.innerSelect);
          $.CONSUME2(tokens.rparen);
          return expr;
        } },
        { GATE: () => [tokens.kw_insert, tokens.kw_update, tokens.kw_delete].some((kind) => tokenMatcher($.LA(1), kind)), ALT: () => {
          const statement = $.OR2([
            { ALT: () => $.SUBRULE($.insertStatement) },
            { ALT: () => $.SUBRULE($.updateStatement) },
            { ALT: () => $.SUBRULE($.deleteStatement) },
          ]);
          $.CONSUME4(tokens.rparen);
          return { kind: "mutation_expr", statement };
        } },
        { GATE: () => tokenMatcher($.LA(1), Name) && tokenMatcher($.LA(2), tokens.assign), ALT: () => {
          const entries = $.SUBRULE($.tupleEntries);
          $.CONSUME3(tokens.rparen);
          return { kind: "free_object_constructor" as const, entries, tupleLike: true };
        } },
        { ALT: () => {
          const first = $.SUBRULE($.expression);
          let result: FreeObjectExpr = first;
          $.OPTION(() => {
            $.CONSUME(tokens.comma);
            const values = [first];
            $.OPTION2({ GATE: () => !tokenMatcher($.LA(1), tokens.rparen), DEF: () => {
              values.push($.SUBRULE2($.expression));
              $.MANY(() => {
                $.CONSUME2(tokens.comma);
                values.push($.SUBRULE3($.expression));
              });
              $.OPTION3(() => $.CONSUME4(tokens.comma));
            } });
            result = { kind: "tuple", values };
          });
          $.CONSUME5(tokens.rparen);
          return result;
        } },
      ]);
      return result;
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
          return $.ACTION<FreeObjectExpr>(() => values.every((v) => v.kind === "literal"
            && (!v.numericKind || v.numericKind === "integer"))
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

const ddlKinds: Record<string, DDLStatement["objectKind"]> = {
  type: "type", scalar: "scalar", link: "link", property: "property", function: "function",
  constraint: "constraint", index: "index", trigger: "trigger", policy: "policy", module: "module",
  database: "database", branch: "branch", role: "role", extension: "extension", alias: "alias",
  global: "global", annotation: "annotation", migration: "migration", future: "future", cast: "cast",
  operator: "operator",
};

const isWordToken = (token: Token | undefined): token is Token => !!token
  && !["eof", "semi", "lbrace", "rbrace", "lparen", "rparen", "lbracket", "rbracket", "comma", "colon", "coloncolon", "dot", "assign"].includes(token.kind);

function parseFunctionDecl(source: string, tokensIn: readonly Token[], start: number): FunctionDecl | undefined {
  if (tokensIn[start]?.kind !== "lparen") return undefined;
  let endParams = start + 1;
  let depth = 1;
  for (; endParams < tokensIn.length; endParams++) {
    if (tokensIn[endParams].kind === "lparen") depth++;
    else if (tokensIn[endParams].kind === "rparen" && --depth === 0) break;
  }
  if (!tokensIn[endParams] || tokensIn[endParams].kind !== "rparen") return undefined;
  const params: FunctionParamDecl[] = [];
  let partStart = start + 1;
  depth = 0;
  const parseParam = (from: number, to: number): void => {
    if (from >= to) return;
    const paramTokens = tokensIn.slice(from, to);
    const colon = paramTokens.findIndex((token) => token.kind === "colon");
    if (colon < 0) return;
    const prefix = paramTokens.slice(0, colon);
    const nameToken = prefix.find((token) => token.kind === "identifier" || token.kind === "backtick_name" || token.kind === "kw_unreserved");
    if (!nameToken) return;
    const afterColon = from + colon + 1;
    let typeStart = afterColon;
    let optional = false;
    let setOf = false;
    if (tokensIn[typeStart]?.lower === "optional") { optional = true; typeStart++; }
    if (tokensIn[typeStart]?.lower === "set" && tokensIn[typeStart + 1]?.lower === "of") {
      setOf = true;
      typeStart += 2;
    }
    let typeEnd = to;
    const defaultAt = tokensIn.slice(typeStart, to).findIndex((token) => token.kind === "equals");
    if (defaultAt >= 0) typeEnd = typeStart + defaultAt;
    const type = typeEnd > typeStart
      ? source.slice(tokensIn[typeStart].offset, tokensIn[typeEnd - 1].offset + tokensIn[typeEnd - 1].lexeme.length).trim()
      : "";
    let defaultExpr: string | undefined;
    if (typeEnd < to) {
      const defaultStart = typeEnd + 1;
      if (defaultStart < to) defaultExpr = source.slice(tokensIn[defaultStart].offset,
        tokensIn[to - 1].offset + tokensIn[to - 1].lexeme.length).trim();
    }
    params.push({ name: nameToken.lexeme.replace(/^`|`$/g, ""), type,
      ...(prefix.some((token) => token.lower === "variadic") ? { variadic: true } : {}),
      ...(optional ? { optional: true } : {}), ...(setOf ? { setOf: true } : {}),
      ...(defaultExpr !== undefined ? { defaultExpr } : {}) });
  };
  for (let i = start + 1; i <= endParams; i++) {
    const token = tokensIn[i];
    if (i === endParams || (token.kind === "comma" && depth === 0)) {
      parseParam(partStart, i);
      partStart = i + 1;
    } else if (["lparen", "lbrace", "lbracket", "lt"].includes(token.kind)) depth++;
    else if (["rparen", "rbrace", "rbracket", "gt"].includes(token.kind)) depth--;
  }
  let arrow = endParams + 1;
  if (tokensIn[arrow]?.kind !== "arrow") return undefined;
  arrow++;
  let returnOptional = false;
  let returnSetOf = false;
  if (tokensIn[arrow]?.lower === "optional") { returnOptional = true; arrow++; }
  if (tokensIn[arrow]?.lower === "set" && tokensIn[arrow + 1]?.lower === "of") {
    returnSetOf = true;
    arrow += 2;
  }
  let using = arrow;
  while (using < tokensIn.length && tokensIn[using].kind !== "kw_using" && tokensIn[using].kind !== "lbrace") using++;
  const returnEnd = using;
  const returnType = returnEnd > arrow
    ? source.slice(tokensIn[arrow].offset, tokensIn[returnEnd - 1].offset + tokensIn[returnEnd - 1].lexeme.length).trim()
    : "";
  if (tokensIn[using]?.kind === "lbrace") {
    const innerUsing = tokensIn.findIndex((token, index) => index > using && token.kind === "kw_using");
    if (innerUsing >= 0) using = innerUsing;
  }
  let language = "edgeql";
  let query = "";
  let fromFunction: string | undefined;
  let fromExpression = false;
  if (tokensIn[using]?.kind === "kw_using") {
    let body = using + 1;
    language = tokensIn[body]?.lower ?? "edgeql";
    body++;
    if (language === "sql" && tokensIn[body]?.kind === "kw_function") {
      fromFunction = tokensIn[body + 1]?.lexeme;
    } else if (tokensIn[body]?.kind === "string" || tokensIn[body]?.kind === "bytes_string") {
      query = tokensIn[body].lexeme;
    } else if (tokensIn[body]?.kind === "lparen") {
      const open = body;
      let parenDepth = 0;
      for (let i = body; i < tokensIn.length; i++) {
        if (tokensIn[i].kind === "lparen") parenDepth++;
        else if (tokensIn[i].kind === "rparen" && --parenDepth === 0) {
          query = source.slice(tokensIn[open].offset + 1, tokensIn[i].offset).trim();
          fromExpression = true;
          break;
        }
      }
    }
  }
  return { params, returnType, ...(returnOptional ? { returnOptional } : {}),
    ...(returnSetOf ? { returnSetOf } : {}), body: { kind: "query", language, query,
      ...(fromFunction ? { fromFunction } : {}), ...(fromExpression ? { fromExpression } : {}) } };
}

function functionSetCommands(tokensIn: readonly Token[]): string[] {
  const commands: string[] = [];
  for (let i = 0; i + 1 < tokensIn.length; i++) {
    if (tokensIn[i].lower === "set" && isWordToken(tokensIn[i + 1])) commands.push(tokensIn[i + 1].lexeme);
  }
  return commands;
}

/** Parse the shared DDL header and the type-body forms modelled by the AST. */
function parseDdlGrammar(source: string, lexical: readonly Token[], lineStarts: readonly number[]): DDLStatement {
  const input = lexical.filter((token) => token.kind !== "eof" && token.kind !== "semi");
  const start = input[0];
  if (!start || !["kw_create", "kw_alter", "kw_drop"].includes(start.kind)) {
    throw syntaxError("Expected a DDL statement");
  }
  const action: DDLStatement["action"] = start.kind === "kw_create" ? "create"
    : start.kind === "kw_alter" ? "alter" : "drop";
  const modifiers: string[] = [];
  let i = 1;
  while (i < input.length && !ddlKinds[input[i].lower]) {
    if (!isWordToken(input[i])) {
      throw syntaxError(`Expected DDL object kind, found '${input[i].lexeme}'`, input[i].offset < 0 ? 1 : offsetToLineCol(input[i].offset, lineStarts).line,
        offsetToLineCol(input[i].offset, lineStarts).column);
    }
    modifiers.push(input[i].lower);
    i++;
  }
  const kindToken = input[i];
  const objectKind = kindToken && ddlKinds[kindToken.lower];
  if (!kindToken || !objectKind) throw syntaxError("Expected DDL object kind");
  i++;
  if ((objectKind === "scalar" || objectKind === "future") && input[i]?.lower === "type") i++;
  if (objectKind === "extension" && input[i]?.lower === "package") i++;

  let name = "";
  let nameEnd = kindToken.offset + kindToken.lexeme.length;
  if (objectKind !== "cast" && !(objectKind === "migration" && input[i]?.kind === "lbrace")) {
    const nameToken = input[i];
    if (!isWordToken(nameToken)) {
      const pos = offsetToLineCol(nameToken?.offset ?? 0, lineStarts);
      throw syntaxError("Expected DDL object name", pos.line, pos.column);
    }
    name = nameToken.lexeme.replace(/^`|`$/g, "");
    nameEnd = nameToken.offset + nameToken.lexeme.length;
    i++;
    while (input[i]?.kind === "coloncolon" && isWordToken(input[i + 1])) {
      name += `::${input[i + 1].lexeme.replace(/^`|`$/g, "")}`;
      nameEnd = input[i + 1].offset + input[i + 1].lexeme.length;
      i += 2;
    }
    if (objectKind === "module") {
      while (input[i]?.kind === "dot" && isWordToken(input[i + 1])) {
        name += `.${input[i + 1].lexeme.replace(/^`|`$/g, "")}`;
        nameEnd = input[i + 1].offset + input[i + 1].lexeme.length;
        i += 2;
      }
    }
  }

  const afterName = source.slice(nameEnd);
  let value: DDLStatement["value"];
  if (action === "create" && (objectKind === "alias" || objectKind === "global")) {
    const assign = input.find((token) => token.kind === "assign" && token.offset >= nameEnd);
    if (assign) {
      const expressionSource = source.slice(assign.offset + assign.lexeme.length).replace(/;\s*$/, "").trim();
      const parsed = parseEdgeQLGrammar(/^select\b/i.test(expressionSource)
        ? expressionSource : `SELECT ${expressionSource}`);
      value = parsed.kind === "select_expr" ? parsed.expr
        : parsed.kind === "select_free" ? { kind: "free_object_constructor", entries: parsed.entries }
        : undefined;
    }
  }

  let createTypeBody: DDLStatement["createTypeBody"];
  if (action === "create" && objectKind === "type") {
    const body = extractTrailingBraceBlock(afterName);
    if (body !== undefined) {
      createTypeBody = parseCreateTypeBody(body);
      if (body.trim() && createTypeBody.length === 0) {
        const pos = offsetToLineCol(nameEnd, lineStarts);
        throw syntaxError("Unsupported CREATE TYPE body entry", pos.line, pos.column);
      }
    }
  }
  let alterTypeOps: AlterTypeOp[] | undefined;
  if (action === "alter" && objectKind === "type") {
    const ops = parseAlterTypeBody(afterName);
    if (ops.length) alterTypeOps = ops;
  }
  const functionDecl = action === "create" && objectKind === "function"
    ? parseFunctionDecl(source, input, i) : undefined;
  const setCommands = objectKind === "function" ? functionSetCommands(input.slice(i)) : [];

  let extendsList: string[] | undefined;
  if (action === "create") {
    const extending = input.findIndex((token, index) => index >= i && token.lower === "extending");
    if (extending >= 0) {
      const bases: string[] = [];
      let cursor = extending + 1;
      while (isWordToken(input[cursor])) {
        let base = input[cursor].lexeme.replace(/^`|`$/g, "");
        cursor++;
        while (input[cursor]?.kind === "coloncolon" && isWordToken(input[cursor + 1])) {
          base += `::${input[cursor + 1].lexeme.replace(/^`|`$/g, "")}`;
          cursor += 2;
        }
        bases.push(base);
        if (input[cursor]?.kind !== "comma") break;
        cursor++;
      }
      if (bases.length) extendsList = bases;
    }
  }

  const pos = offsetToLineCol(start.offset, lineStarts);
  return {
    kind: "ddl", action, objectKind, name, ...(value ? { value } : {}),
    ...(functionDecl ? { functionDecl } : {}),
    ...(modifiers.length ? { modifiers } : {}), ...(extendsList ? { extendsList } : {}),
    ...(setCommands.length ? { setCommands } : {}),
    ...(createTypeBody ? { createTypeBody } : {}), ...(alterTypeOps ? { alterTypeOps } : {}),
    pos,
  };
}

function parseConfigureGrammar(source: string, lexical: readonly Token[], lineStarts: readonly number[]): ConfigureStatement {
  const stream = lexical.filter((token) => token.kind !== "eof" && token.kind !== "semi");
  const start = stream[0];
  let i = 1;
  let scope: ConfigureStatement["scope"];
  if (stream[i]?.lower === "current") {
    i += 2;
    scope = "current_database";
  } else {
    scope = stream[i]?.lower === "instance" ? "instance" : "session";
    i++;
  }
  const opWord = stream[i]?.lower;
  if (opWord !== "set" && opWord !== "insert" && opWord !== "reset") {
    const token = stream[i] ?? start;
    const pos = offsetToLineCol(token.offset, lineStarts);
    throw syntaxError("Expected configure operation: set, insert, or reset", pos.line, pos.column);
  }
  const operation = opWord as ConfigureStatement["operation"];
  i++;
  const targetStart = i;
  while (i < stream.length && stream[i].kind !== "assign" && stream[i].kind !== "lbrace") i++;
  const target = stream.slice(targetStart, i).map((token) => token.lexeme).join("");
  let value: FreeObjectExpr | undefined;
  if (operation === "set" && stream[i]?.kind === "assign") {
    const expressionSource = source.slice(stream[i].offset + stream[i].lexeme.length).replace(/;\s*$/, "").trim();
    const parsed = parseEdgeQLGrammar(`SELECT ${expressionSource}`);
    if (parsed.kind === "select_expr") value = parsed.expr;
  }
  const pos = offsetToLineCol(start.offset, lineStarts);
  return { kind: "configure", scope, operation, target, ...(value ? { value } : {}), pos };
}

function hasTopLevelDmlAfterWith(lexical: readonly Token[]): boolean {
  let depth = 0;
  for (const token of lexical) {
    if (token.kind === "eof") break;
    if (depth === 0 && ["kw_insert", "kw_update", "kw_delete", "kw_for"].includes(token.kind)) return true;
    if (["lbrace", "lparen", "lbracket"].includes(token.kind)) depth++;
    else if (["rbrace", "rparen", "rbracket"].includes(token.kind)) depth--;
  }
  return false;
}

function hasTopLevelGroupAfterWith(lexical: readonly Token[]): boolean {
  let depth = 0;
  for (const token of lexical) {
    if (token.kind === "eof") break;
    if (depth === 0 && token.kind === "kw_group") return true;
    if (["lbrace", "lparen", "lbracket"].includes(token.kind)) depth++;
    else if (["rbrace", "rparen", "rbracket"].includes(token.kind)) depth--;
  }
  return false;
}

/** Parse one supported EdgeQL statement without falling back to the handwritten parser. */
export function parseEdgeQLGrammar(source: string, defaultModule?: string): Statement {
  const { tokens: lexical, lineStarts } = tokenizeWithStarts(source);
  grammar.defaultModule = defaultModule;
  if (lexical[0]?.kind === "kw_with" && lexical[1]?.kind === "kw_module") {
    let depth = 0;
    // Account for nested delimiters while locating the statement following the
    // module qualifier; SELECTs in parenthesized expressions aren't the body.
    let foundBody = -1;
    for (let i = 2; i < lexical.length; i++) {
      const token = lexical[i];
      if (depth === 0 && ["kw_select", "kw_group", "kw_insert", "kw_update", "kw_delete", "kw_for", "kw_create", "kw_alter", "kw_drop"]
        .includes(token.kind)) { foundBody = i; break; }
      if (["lbrace", "lparen", "lbracket"].includes(token.kind)) depth++;
      else if (["rbrace", "rparen", "rbracket"].includes(token.kind)) depth--;
    }
    if (foundBody < 0) throw syntaxError("Expected a statement after WITH MODULE");
    const moduleName = source.slice(lexical[2].offset, lexical[foundBody].offset).trim();
    const parsed = parseEdgeQLGrammar(source.slice(lexical[foundBody].offset));
    const bodyPos = offsetToLineCol(lexical[foundBody].offset, lineStarts);
    parsed.pos = bodyPos;
    return { ...parsed, withModule: moduleName } as Statement;
  }
  if (lexical[0]?.kind === "kw_configure") return parseConfigureGrammar(source, lexical, lineStarts);
  if (["kw_create", "kw_alter", "kw_drop"].includes(lexical[0]?.kind ?? "")) {
    return parseDdlGrammar(source, lexical, lineStarts);
  }
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
    const result = lexical[0]?.kind === "kw_with" && hasTopLevelDmlAfterWith(lexical) ? grammar.withDmlStatement()
      : lexical[0]?.kind === "kw_with" && hasTopLevelGroupAfterWith(lexical) ? grammar.groupStatement()
      : lexical[0]?.kind === "kw_group" ? grammar.groupStatement()
      : lexical[0]?.kind === "kw_insert" ? grammar.insertStatement()
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
  let activeModule: string | undefined;
  const parsePiece = (end: number): void => {
    const piece = source.slice(start, end);
    const first = lexical.find((token) => token.offset >= start && token.offset < end && token.kind !== "semi");
    if (first) {
      const pieceTokens = lexical.filter((token) => token.offset >= start && token.offset < end && token.kind !== "semi" && token.kind !== "eof");
      if (pieceTokens[0]?.kind === "kw_set" && pieceTokens[1]?.kind === "kw_module") {
        activeModule = pieceTokens.slice(2).map((token) => token.lexeme).join("");
        start = end;
        return;
      }
      const statement = parseEdgeQLGrammar(piece, activeModule);
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
