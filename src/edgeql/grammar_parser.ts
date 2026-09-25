import { EmbeddedActionsParser, Lexer, createToken, createTokenInstance, tokenMatcher, type TokenType } from "chevrotain";
import { AppError } from "../errors.js";
import { extractTrailingBraceBlock, parseAlterTypeBody, parseCreateTypeBody, type AlterTypeOp } from "./ddl_body.js";
import type { ComputedExpr, ConfigureStatement, DDLStatement, FilterExpr, ForStatement, FreeObjectExpr, FunctionCallArgExpr, FunctionDecl, FunctionParamDecl, GroupByAtom, GroupByElement, GroupExpr, GroupStatement, InsertConflict, InsertValue, OrderExpr, OrderExprChain, PathStep, ShapeElement, Statement, TypeExpr, WithBinding } from "./ast.js";
import { simpleTypeName } from "./ast.js";
import { offsetToLineCol, tokenizeWithStarts, type Token, type TokenKind } from "./tokenizer.js";

// A second, explicitly scoped parser. It reuses the production tokenizer but
// expresses syntax as a validated grammar; no Python or generated code ships.
// The working AST is its output seam, so consumers need no new representation.
const Name = createToken({ name: "Name", pattern: Lexer.NA });
const kinds = [
  "kw_select", "kw_with", "kw_filter", "kw_or", "kw_and", "kw_not",
  "kw_true", "kw_false", "kw_null", "kw_typeof", "kw_type", "kw_introspect",
  "kw_unreserved", "identifier", "backtick_name",
  "kw_current_reserved", "kw_current_reserved_source", "kw_current_reserved_subject",
  "kw_current_reserved_type", "kw_current_reserved_std", "kw_current_reserved_edgedbsys",
  "kw_current_reserved_edgedbtpl", "kw_current_reserved_new", "kw_current_reserved_old",
  "kw_current_reserved_specified", "kw_current_reserved_default",
  "kw_object",
  "number", "string", "bytes_string", "semi", "lparen", "rparen", "lbrace", "rbrace", "comma", "colon",
  "str_interp_start", "str_interp_cont", "str_interp_end",
  "dot", "coloncolon", "assign", "plus", "minus", "star", "slash", "floor_div",
  "double_splat", "modulo", "pow", "coalesce", "concat", "pipe", "ampersand", "equals", "not_equals", "lt", "lte",
  "gt", "gte", "distinct_from", "not_distinct_from",
  "kw_order", "kw_by", "kw_asc", "kw_desc", "kw_empty", "kw_limit", "kw_offset",
  "lbracket", "rbracket", "kw_distinct", "kw_exists",
  "kw_if", "kw_then", "kw_else", "kw_like", "kw_ilike", "parameter",
  "kw_insert", "kw_unless", "kw_conflict",
  "kw_on", "kw_module", "kw_schema", "kw_optional", "kw_single", "kw_multi", "kw_required",
  "kw_update", "kw_delete", "kw_set",
  "kw_for", "kw_in", "kw_union", "kw_except", "kw_intersect",
  "kw_group", "kw_using", "kw_is", "kw_detached", "backward_link", "optional_link", "at",
] as const satisfies readonly TokenKind[];
type GrammarKind = typeof kinds[number];
const tokens = Object.fromEntries(kinds.map((kind) => [
  kind, createToken({
    name: kind,
    pattern: Lexer.NA,
    categories: ["identifier", "backtick_name", "kw_unreserved"].includes(kind)
      || kind.startsWith("kw_current_reserved") || kind === "kw_object"
      || kind === "kw_schema" || kind === "kw_type"
      || ["kw_optional", "kw_single", "kw_multi", "kw_required"].includes(kind) ? [Name] : [],
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
const validateFunctionCallArgs = (args: readonly FunctionCallArgExpr[], line: number, column: number): void => {
  let sawNamed = false;
  const seenNames = new Set<string>();
  for (const arg of args) {
    if (arg.kind === "named_arg") {
      sawNamed = true;
      if (seenNames.has(arg.name)) {
        throw syntaxError(`duplicate named argument '${arg.name}' in function call`, line, column);
      }
      seenNames.add(arg.name);
    } else if (sawNamed) {
      throw syntaxError("positional argument follows a named argument in function call", line, column);
    }
  }
};

const computedExpr = (expr: FreeObjectExpr): ComputedExpr => {
  if (expr.kind === "literal") return { kind: "literal", value: expr.value };
  if (expr.kind === "binding_ref") return expr;
  if (expr.kind === "function_call") return expr;
  if (expr.kind === "field_access" && expr.expr.kind === "field_access"
      && expr.expr.expr.kind === "current_item" && expr.expr.field === "__type__"
      && expr.field === "name") {
    return { kind: "type_name" };
  }
  if (expr.kind === "field_access" && expr.expr.kind === "current_item" && expr.field === "__type__") {
    return { kind: "type_name" };
  }
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
    if (!target) return { kind: "free_expr", expr: predicate };
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

type InsertConflictAlternativeInput =
  | { kind: "type_name"; name: string }
  | { kind: "select_expr"; expr: FreeObjectExpr }
  | { kind: "update_statement"; statement: Statement };

function insertConflictAlternative(
  alternative: InsertConflictAlternativeInput,
  defaultModule: string | undefined,
  line: number,
  column: number,
): NonNullable<InsertConflict["else"]> {
  if (alternative.kind === "type_name") {
    return {
      kind: "select", typeName: inModule(alternative.name, defaultModule),
      shape: defaultShape(), clauses: {},
    };
  }
  if (alternative.kind === "update_statement") {
    if (alternative.statement.kind !== "update") {
      throw syntaxError("Expected an UPDATE statement in UNLESS CONFLICT ELSE", line, column);
    }
    const update = alternative.statement;
    return {
      kind: "update", typeName: update.typeName,
      ...(update.filter ? { filter: update.filter } : {}),
      values: update.values,
      ...(update.operations ? { operations: update.operations } : {}),
    };
  }
  const query = alternative.expr.kind === "select_expr_subquery" ? alternative.expr.expr : alternative.expr;
  if (query.kind === "select") {
    return { kind: "select", typeName: query.typeName, shape: query.shape, clauses: query.clauses };
  }
  throw syntaxError("Expected a SELECT or UPDATE expression in UNLESS CONFLICT ELSE", line, column);
}

function numberLiteral(text: string, line: number, column: number): FreeObjectExpr {
  const cleaned = text.replace(/_/g, "");
  const numericKind = cleaned.endsWith("n") ? /[.eE]/.test(cleaned) ? "decimal" : "bigint"
    : /[.eE]/.test(cleaned) ? "float" : "integer";
  const digits = cleaned.replace(/n$/, "");
  const value = Number(digits);
  if (!Number.isFinite(value)
      || (numericKind === "integer" && digits.length > 20)
      || (value === 0 && /[1-9]/.test(digits.split(/[eE]/)[0] ?? ""))) {
    throw syntaxError(`Numeric literal out of range: ${text}`, line, column);
  }
  return { kind: "literal", value, numericKind };
}

function tupleAccess(expr: FreeObjectExpr, text: string): FreeObjectExpr {
  const parts = text.split(".");
  if (parts.some((part) => !/^[0-9](?:[0-9_]*[0-9])?$/.test(part))) {
    throw syntaxError(`Invalid tuple index '${text}': tuple indices must be plain integers`);
  }
  return parts.reduce<FreeObjectExpr>((current, part) => ({
    kind: "index_access", expr: current, index: Number(part.replace(/_/g, "")),
  }), expr);
}

type MathOp = Extract<FreeObjectExpr, { kind: "math" }>["op"];
type CompareOp = Extract<FreeObjectExpr, { kind: "compare" }>["op"];
type GrammarOrderItem = {
  expr: FreeObjectExpr;
  direction: "asc" | "desc";
  nullsPosition?: "first" | "last";
  then?: GrammarOrderItem;
};
type GrammarOrderSuffix = Pick<GrammarOrderItem, "direction" | "nullsPosition">;

function orderExprForSelect(item: GrammarOrderItem, typeName: string): OrderExpr {
  const orderField = item.expr.kind === "field_access" && (
    item.expr.expr.kind === "current_item"
    || (item.expr.expr.kind === "select" && item.expr.expr.typeName === typeName)
  );
  const nameSort = item.expr.kind === "binding_ref" ? item.expr.name
    : item.expr.kind === "path" ? `${item.expr.head}.${item.expr.tail}` : undefined;
  return {
    field: orderField ? (item.expr as Extract<FreeObjectExpr, { kind: "field_access" }>).field
      : nameSort ?? "__expr__",
    ...(orderField || nameSort ? {} : { expr: item.expr }),
    direction: item.direction,
    ...(item.nullsPosition ? { nullsPosition: item.nullsPosition } : {}),
    ...(item.then ? { then: orderExprForSelect(item.then, typeName) } : {}),
  };
}

function orderExprChain(item: GrammarOrderItem): OrderExprChain {
  return {
    expr: item.expr,
    direction: item.direction,
    ...(item.nullsPosition ? { nullsPosition: item.nullsPosition } : {}),
    ...(item.then ? { then: orderExprChain(item.then) } : {}),
  };
}

function orderUsesOnlyCurrentItemFields(item: GrammarOrderItem): boolean {
  return item.expr.kind === "field_access" && item.expr.expr.kind === "current_item"
    && (!item.then || orderUsesOnlyCurrentItemFields(item.then));
}

function pathStepsForExpr(expr: FreeObjectExpr): PathStep[] | undefined {
  if (expr.kind === "path_steps") return [...expr.steps];
  if (expr.kind === "path") return expr.steps ? [...expr.steps] : [
    { kind: "object_ref", name: expr.head }, { kind: "ptr", name: expr.tail, direction: "outbound" },
  ];
  if (expr.kind === "path_chain") {
    const [head, ...tail] = expr.parts;
    return head ? [
      { kind: "object_ref", name: head }, ...tail.map((name) => ({ kind: "ptr" as const, name, direction: "outbound" as const })),
    ] : undefined;
  }
  if (expr.kind === "binding_ref") return [{ kind: "object_ref", name: expr.name }];
  if (expr.kind === "select") return [{ kind: "object_ref", name: expr.typeName }];
  if (expr.kind === "current_item") return [{ kind: "object_ref", name: "__current__" }];
  if (expr.kind === "field_access") {
    const base = pathStepsForExpr(expr.expr);
    return base ? [...base, { kind: "ptr", name: expr.field, direction: "outbound", optional: expr.optional }] : undefined;
  }
  if (expr.kind === "backlink_path") return [
    { kind: "object_ref", name: "__current__" },
    { kind: "ptr", name: expr.link, direction: "inbound", optional: expr.optional },
  ];
  return undefined;
}

function mutationTargetTypeName(expr: FreeObjectExpr, bindings: ReadonlySet<string>): string {
  switch (expr.kind) {
    case "select": return expr.typeName;
    case "path": return expr.head;
    case "path_chain": return expr.parts[0] ?? "Object";
    case "path_steps": {
      const first = expr.steps[0];
      return first?.kind === "object_ref" ? first.name : "Object";
    }
    case "set_expr": return expr.values[0] ? mutationTargetTypeName(expr.values[0], bindings) : "Object";
    case "select_expr_subquery":
    case "shape_projection":
    case "distinct":
    case "cast":
    case "field_access":
    case "is_type": return mutationTargetTypeName(expr.expr, bindings);
    case "binding_ref": return bindings.has(expr.name) ? "Object" : expr.name;
    default: return "Object";
  }
}

class GrammarParser extends EmbeddedActionsParser {
  readonly bindings = new Set<string>();
  readonly bindingValues = new Map<string, WithBinding["value"]>();
  readonly explicitShapes = new WeakSet<FreeObjectExpr>();
  defaultModule?: string;
  declare statement: () => Statement;
  declare ifStatement: () => Statement;
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
  declare shapeEntryCore: () => ShapeElement;
  declare computedBacklinkShapeEntry: () => ShapeElement;
  declare orderItem: () => GrammarOrderItem;
  declare orderSuffix: () => GrammarOrderSuffix;
  declare braces: () => FreeObjectExpr;
  declare objectEntry: () => {
    name: string; expr: FreeObjectExpr;
    cardinality?: "one" | "many"; required?: boolean;
  };
  declare array: () => FreeObjectExpr;
  declare innerSelect: () => FreeObjectExpr;
  declare insertStatement: () => Statement;
  declare insertEntry: () => { name: string; value: InsertValue };
  declare updateSubject: () => { typeName: string; target?: FreeObjectExpr };
  declare updateStatement: () => Statement;
  declare deleteStatement: () => Statement;
  declare forStatementBinder: () => {
    variable: string; optional: boolean; iteratorExpr: FreeObjectExpr; pos: { line: number; column: number };
  };
  declare forStatement: () => Statement;
  declare forExpr: () => FreeObjectExpr;
  declare groupStatement: () => GroupStatement;
  declare groupExpr: () => GroupExpr;
  declare groupByElement: () => GroupByElement;
  declare groupByAtom: () => GroupByAtom;
  declare groupByAtomList: () => GroupByAtom[];
  declare groupUsing: () => { alias: string; expr: FreeObjectExpr };
  declare tupleEntries: () => Array<{ name: string; expr: FreeObjectExpr }>;
  declare parenthesized: () => FreeObjectExpr;
  declare stringInterpolation: () => FreeObjectExpr;
  declare subscriptBound: () => FreeObjectExpr;
  declare atom: () => FreeObjectExpr;
  declare functionCallArg: () => FunctionCallArgExpr;
  declare qualifiedName: () => string;
  declare typeExpr: () => TypeExpr;
  declare typeIntersectExpr: () => TypeExpr;
  declare typeAtom: () => TypeExpr;
  declare castType: () => string;
  declare castTypeIntersect: () => string;
  declare castTypeUnit: () => string;
  declare castTypeArg: () => string;

  constructor() {
    super([Name, ...Object.values(tokens)], { recoveryEnabled: false });
    const $ = this;

    // statement := (WITH name := expr (, name := expr)*)? SELECT expr (FILTER expr)? ;*
    $.RULE("statement", (): Statement => {
      const withBindings: WithBinding[] = [];
      $.OPTION(() => {
        $.CONSUME(tokens.kw_with);
        withBindings.push($.SUBRULE($.binding));
        $.MANY({ GATE: () => tokenMatcher($.LA(1), tokens.comma)
          && !tokenMatcher($.LA(2), tokens.kw_select), DEF: () => {
          $.CONSUME(tokens.comma);
          withBindings.push($.SUBRULE2($.binding));
        } });
        $.OPTION6({ GATE: () => tokenMatcher($.LA(1), tokens.comma)
          && tokenMatcher($.LA(2), tokens.kw_select), DEF: () => $.CONSUME3(tokens.comma) });
      });
      const start = $.CONSUME(tokens.kw_select);
      let resultAlias: string | undefined;
      $.OPTION7({ GATE: () => tokenMatcher($.LA(1), Name) && tokenMatcher($.LA(2), tokens.assign), DEF: () => {
        resultAlias = $.CONSUME(Name).image;
        $.CONSUME(tokens.assign);
        $.ACTION(() => { if (resultAlias !== undefined) $.bindings.add(resultAlias); });
      } });
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
      let offsetExpr: FreeObjectExpr | undefined;
      $.OPTION4(() => {
        $.CONSUME(tokens.kw_offset);
        const value = $.SUBRULE3($.expression);
        $.ACTION(() => {
          if (value.kind === "literal" && typeof value.value === "number" && value.numericKind === "integer") {
            offset = value.value;
          } else offsetExpr = value;
        });
      });
      let limit: number | undefined;
      let limitExpr: FreeObjectExpr | undefined;
      $.OPTION5(() => {
        $.CONSUME(tokens.kw_limit);
        const value = $.SUBRULE4($.expression);
        $.ACTION(() => {
          if (value.kind === "literal" && typeof value.value === "number" && value.numericKind === "integer") {
            limit = value.value;
          } else limitExpr = value;
        });
      });
      $.MANY2(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => {
        const pos = { line: start.startLine!, column: start.startColumn! };
        const shapeProjection = result.kind === "shape_projection" ? result : undefined;
        const shapePath = shapeProjection?.expr.kind === "path_steps" ? shapeProjection.expr : undefined;
        const rootStep = shapePath?.steps[0];
        const filterSteps = shapePath?.steps.slice(1);
        const typedObjectShape = shapeProjection && rootStep?.kind === "object_ref"
          && filterSteps?.length
          && filterSteps.every((step) => step.kind === "type_intersection" && step.typeExpr)
          ? {
              subject: { kind: "select" as const, typeName: rootStep.name,
                shape: shapeProjection.shape, clauses: {} },
              filters: filterSteps.map((step) => (step as Extract<typeof step, { kind: "type_intersection" }>).typeExpr!),
            }
          : undefined;
        const baseResult = typedObjectShape?.subject ?? result;
        const subject = baseResult.kind === "binding_ref" && !$.bindings.has(baseResult.name)
          && (filter || filterExpr || order || limit !== undefined || offset !== undefined || limitExpr || offsetExpr)
          ? typeSource(inModule(baseResult.name, $.defaultModule)) : baseResult;
        const shaped = $.explicitShapes.has(subject) || typedObjectShape !== undefined;
        const directShape = subject.kind === "select"
          && head.image.toLowerCase() === subject.typeName.split("::")[0].toLowerCase()
          && head.tokenTypeIdx !== tokens.lparen.tokenTypeIdx;
        if (subject.kind === "select" && (filter || order || limit !== undefined || offset !== undefined
            || limitExpr || offsetExpr || (shaped && directShape))) {
          const orderBy = order ? orderExprForSelect(order, subject.typeName) : undefined;
          return {
            kind: "select", typeName: subject.typeName,
            ...(resultAlias ? { resultAlias } : {}), shape: subject.shape,
            fields: subject.shape.filter((element) => element.kind === "field").map((element) => element.name),
            ...(typedObjectShape ? { typeFilterExprs: typedObjectShape.filters } : {}),
            ...(filter ? { filter } : {}), ...(orderBy ? { orderBy } : {}),
            ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}),
            ...(offsetExpr ? { offsetExpr } : {}), ...(limitExpr ? { limitExpr } : {}),
            pos, ...(withBindings.length ? { with: withBindings } : {}),
          };
        }
        if (filterExpr) {
          const expr: FreeObjectExpr = { kind: "select_expr_subquery", expr: subject, filter: filterExpr,
            ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}),
            ...(offsetExpr ? { offsetExpr } : {}), ...(limitExpr ? { limitExpr } : {}) };
          return { kind: "select_expr", expr, pos,
            ...(withBindings.length ? { with: withBindings } : {}),
            ...(resultAlias ? { resultAlias } : {}) };
        }
        if (subject.kind === "free_object_constructor" && head.tokenTypeIdx === tokens.lbrace.tokenTypeIdx) {
          if (order || offset !== undefined || limit !== undefined || offsetExpr || limitExpr) {
            throw syntaxError("Free object clauses are outside the grammar-backed AST slice", pos.line, pos.column);
          }
          return { kind: "select_free", entries: subject.entries, pos,
            ...(withBindings.length ? { with: withBindings } : {}),
            ...(resultAlias ? { resultAlias } : {}) };
        }
        const orderBy = order ? orderExprChain(order) : undefined;
        const expr: FreeObjectExpr = offset !== undefined || limit !== undefined || offsetExpr || limitExpr
          ? { kind: "select_expr_subquery", expr: subject, ...(offset !== undefined ? { offset } : {}),
              ...(limit !== undefined ? { limit } : {}), ...(offsetExpr ? { offsetExpr } : {}),
              ...(limitExpr ? { limitExpr } : {}) }
          : subject;
        return { kind: "select_expr", expr, ...(orderBy ? { orderBy } : {}), pos,
          ...(withBindings.length ? { with: withBindings } : {}),
          ...(resultAlias ? { resultAlias } : {}) };
      });
    });

    $.RULE("ifStatement", (): Statement => {
      const start = $.LA(1);
      const expr = $.SUBRULE($.expression);
      $.MANY(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => ({ kind: "select_expr", expr,
        pos: { line: start.startLine ?? 1, column: start.startColumn ?? 1 } }));
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
      let conflictElse: NonNullable<InsertConflict["else"]> | undefined;
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
        $.OPTION5(() => {
          const elseToken = $.CONSUME(tokens.kw_else);
          const elsePosition = {
            line: elseToken.startLine ?? 1,
            column: elseToken.startColumn ?? 1,
          };
          let parenthesized = false;
          $.OPTION6(() => {
            $.CONSUME2(tokens.lparen);
            parenthesized = true;
          });
          const alternative = $.OR2([
            { GATE: () => tokenMatcher($.LA(1), tokens.kw_update), ALT: () => ({
              kind: "update_statement" as const, statement: $.SUBRULE($.updateStatement),
            }) },
            { GATE: () => tokenMatcher($.LA(1), tokens.kw_select), ALT: () => ({
              kind: "select_expr" as const, expr: $.SUBRULE($.innerSelect),
            }) },
            { ALT: () => ({ kind: "type_name" as const, name: $.SUBRULE2($.qualifiedName) }) },
          ]);
          $.OPTION7({ GATE: () => parenthesized, DEF: () => $.CONSUME2(tokens.rparen) });
          conflictElse = $.ACTION(() => {
            if (!onFields?.length) {
              throw syntaxError(
                "UNLESS CONFLICT ELSE (...) requires an ON (.field) target",
                elsePosition.line, elsePosition.column,
              );
            }
            return insertConflictAlternative(
              alternative, $.defaultModule, elsePosition.line, elsePosition.column,
            );
          });
        });
      });
      $.MANY2(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => ({ kind: "insert", typeName: inModule(typeName, $.defaultModule), values,
        ...(conflict ? { conflict: {
          ...(onFields?.length ? { onField: onFields[0], ...(onFields.length > 1 ? { onFields } : {}) } : {}),
          ...(conflictElse ? { else: conflictElse } : {}),
        } } : {}),
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

    $.RULE("updateSubject", (): { typeName: string; target?: FreeObjectExpr } => {
      const isExpressionTarget = (): boolean => {
        const first = $.LA(1);
        const second = $.LA(2);
        if ([tokens.lbrace, tokens.lparen, tokens.dot, tokens.backward_link, tokens.optional_link]
          .some((kind) => tokenMatcher(first, kind))) return true;
        return tokenMatcher(first, Name) && (
          [tokens.lbracket, tokens.lbrace, tokens.dot, tokens.backward_link, tokens.optional_link]
            .some((kind) => tokenMatcher(second, kind))
          || $.bindings.has(first.image)
        );
      };
      return $.OR([
        { GATE: isExpressionTarget, ALT: () => {
          const target = $.SUBRULE($.expression);
          return $.ACTION(() => ({ typeName: mutationTargetTypeName(target, $.bindings), target }));
        } },
        { ALT: () => ({ typeName: $.SUBRULE2($.qualifiedName) }) },
      ]);
    });
    $.RULE("updateStatement", (): Statement => {
      const start = $.CONSUME(tokens.kw_update);
      const subject = $.SUBRULE($.updateSubject);
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
      return $.ACTION(() => ({ kind: "update", typeName: inModule(subject.typeName, $.defaultModule),
        ...(subject.target ? { target: subject.target } : {}), ...(filter ? { filter } : {}), values, operations,
        pos: { line: start.startLine!, column: start.startColumn! } }));
    });

    $.RULE("forStatementBinder", (): {
      variable: string; optional: boolean; iteratorExpr: FreeObjectExpr; pos: { line: number; column: number };
    } => {
      const start = $.CONSUME(tokens.kw_for);
      let optional = false;
      $.OPTION(() => { $.CONSUME(tokens.kw_optional); optional = true; });
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
      return { variable, optional, iteratorExpr,
        pos: { line: start.startLine ?? 1, column: start.startColumn ?? 1 } };
    });
    $.RULE("forStatement", (): Statement => {
      const binders = [$.SUBRULE($.forStatementBinder)];
      $.MANY(() => binders.push($.SUBRULE2($.forStatementBinder)));
      const start = binders[0];
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
              : start.pos }));
        } },
        { GATE: () => [tokens.kw_insert, tokens.kw_update, tokens.kw_delete].some((kind) => tokenMatcher($.LA(1), kind)), ALT: () => $.OR2([
          { ALT: () => $.SUBRULE($.insertStatement) },
          { ALT: () => $.SUBRULE($.updateStatement) },
          { ALT: () => $.SUBRULE($.deleteStatement) },
        ]) },
      ]);
      $.MANY2(() => $.CONSUME(tokens.semi));
      return $.ACTION(() => {
        let nested: Statement = body;
        for (let i = binders.length - 1; i >= 0; i--) {
          const binder = binders[i];
          nested = { kind: "for", variable: binder.variable, optional: binder.optional,
            iteratorExpr: binder.iteratorExpr, body: nested as ForStatement["body"], pos: binder.pos };
        }
        return nested;
      });
    });

    $.RULE("groupStatement", (): GroupStatement => {
      let withBindings: WithBinding[] = [];
      $.OPTION(() => {
        $.CONSUME(tokens.kw_with);
        withBindings = [$.SUBRULE($.binding)];
        $.MANY2({ GATE: () => tokenMatcher($.LA(1), tokens.comma)
          && !tokenMatcher($.LA(2), tokens.kw_group), DEF: () => {
          $.CONSUME(tokens.comma);
          withBindings.push($.SUBRULE2($.binding));
        } });
        $.OPTION2({ GATE: () => tokenMatcher($.LA(1), tokens.comma)
          && tokenMatcher($.LA(2), tokens.kw_group), DEF: () => $.CONSUME3(tokens.comma) });
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
          return operation === "cube" ? { kind: "cube" as const, atoms } : { kind: "rollup" as const, atoms };
        } },
        { ALT: () => {
          $.CONSUME2(tokens.lparen);
          const atoms = $.SUBRULE5($.groupByAtomList);
          $.CONSUME2(tokens.rparen);
          return { kind: "sets" as const, sets: [atoms] };
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
        return { kind: "field_ref" as const, field: field.image };
      } },
      { ALT: () => {
        $.CONSUME(tokens.at);
        return { kind: "link_property_ref" as const, name: $.CONSUME2(Name).image };
      } },
      { ALT: () => ({ kind: "name_ref" as const, name: $.CONSUME3(Name).image }) },
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
      const finalStatement = () => [tokens.kw_insert, tokens.kw_update, tokens.kw_delete, tokens.kw_for]
        .some((kind) => tokenMatcher($.LA(2), kind));
      $.MANY({ GATE: () => tokenMatcher($.LA(1), tokens.comma) && !finalStatement(), DEF: () => {
        $.CONSUME(tokens.comma);
        withBindings.push($.SUBRULE2($.binding));
      } });
      $.OPTION({ GATE: finalStatement, DEF: () => $.CONSUME2(tokens.comma) });
      const statement = $.OR([
        { ALT: () => $.SUBRULE($.insertStatement) },
        { ALT: () => $.SUBRULE($.updateStatement) },
        { ALT: () => $.SUBRULE($.deleteStatement) },
        { ALT: () => $.SUBRULE($.forStatement) },
      ]);
      return $.ACTION(() => ({ ...statement, with: withBindings } as Statement));
    });

    $.RULE("orderItem", (): GrammarOrderItem => {
      const expr = $.SUBRULE($.expression);
      const suffix = $.SUBRULE($.orderSuffix);
      const head: GrammarOrderItem = { expr, ...suffix };
      let current = head;
      $.MANY(() => {
        $.CONSUME(tokens.kw_then);
        const nextExpr = $.SUBRULE2($.expression);
        const nextSuffix = $.SUBRULE2($.orderSuffix);
        const next: GrammarOrderItem = { expr: nextExpr, ...nextSuffix };
        current.then = next;
        current = next;
      });
      return head;
    });

    $.RULE("orderSuffix", (): GrammarOrderSuffix => {
      let direction: "asc" | "desc" = "asc";
      $.OPTION(() => $.OR([
        { ALT: () => { $.CONSUME(tokens.kw_asc); direction = "asc"; } },
        { ALT: () => { $.CONSUME(tokens.kw_desc); direction = "desc"; } },
      ]));
      let nullsPosition: "first" | "last" | undefined;
      $.OPTION2(() => {
        $.CONSUME(tokens.kw_empty);
        const position = $.CONSUME(Name);
        nullsPosition = $.ACTION(() => {
          const lowered = position.image.toLowerCase();
          if (lowered !== "first" && lowered !== "last") {
            throw syntaxError("Expected FIRST or LAST after EMPTY", position.startLine!, position.startColumn!);
          }
          return lowered;
        });
      });
      return { direction, nullsPosition };
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
      $.OPTION5({ GATE: () => tokenMatcher($.LA(1), tokens.kw_not)
        && [tokens.kw_like, tokens.kw_ilike].some((kind) => tokenMatcher($.LA(2), kind)), DEF: () => {
        $.CONSUME3(tokens.kw_not);
        const like = $.OR3([
          { ALT: () => $.CONSUME2(tokens.kw_like) },
          { ALT: () => $.CONSUME2(tokens.kw_ilike) },
        ]);
        const right = $.SUBRULE4($.additive);
        result = $.ACTION(() => ({ kind: "compare", op: `not_${like.image}` as CompareOp, left, right }));
      } });
      $.OPTION2(() => {
        let op: "in" | "not_in" = "in";
        $.OR2([
          { ALT: () => { $.CONSUME(tokens.kw_in); op = "in"; } },
          { ALT: () => { $.CONSUME(tokens.kw_not); $.CONSUME2(tokens.kw_in); op = "not_in"; } },
        ]);
        const right = $.SUBRULE3($.additive);
        result = $.ACTION(() => ({ kind: "in_expr", op, left, right }));
      });
      $.OPTION3(() => {
        $.CONSUME(tokens.kw_is);
        let negated = false;
        $.OPTION4(() => { $.CONSUME2(tokens.kw_not); negated = true; });
        const typeExpr = $.SUBRULE($.typeExpr);
        result = $.ACTION(() => {
          const isType: FreeObjectExpr = {
            kind: "is_type", expr: left,
            typeName: simpleTypeName(typeExpr) ?? "", typeExpr,
          };
          return negated ? { kind: "not", expr: isType } : isType;
        });
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
        let optional = false;
        $.OPTION3({ GATE: () => tokenMatcher($.LA(1), tokens.kw_optional), DEF: () => {
          $.CONSUME(tokens.kw_optional);
          optional = true;
        } });
        $.OPTION4({ GATE: () => tokenMatcher($.LA(1), tokens.kw_required), DEF: () => {
          $.CONSUME(tokens.kw_required);
        } });
        const castType = $.SUBRULE($.castType);
        $.CONSUME(tokens.gt);
        const expr = $.SUBRULE6($.unary);
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "cast", castType, expr, ...(optional ? { optional: true } : {}) }));
      } },
      { GATE: () => tokenMatcher($.LA(1), tokens.kw_introspect), ALT: () => {
        $.CONSUME(tokens.kw_introspect);
        let typeofForm = false;
        $.OPTION({ GATE: () => tokenMatcher($.LA(1), tokens.kw_typeof), DEF: () => {
          $.CONSUME(tokens.kw_typeof);
          typeofForm = true;
        } });
        const expr = $.OR2([
          { GATE: () => !typeofForm && tokenMatcher($.LA(1), tokens.lparen)
            && tokenMatcher($.LA(2), Name) && tokenMatcher($.LA(3), tokens.lt), ALT: () => {
            $.CONSUME(tokens.lparen);
            const typeName = $.SUBRULE2($.castType);
            $.CONSUME(tokens.rparen);
            return { kind: "binding_ref" as const, name: typeName };
          } },
          { ALT: () => $.SUBRULE7($.unary) },
        ]);
        return $.ACTION<FreeObjectExpr>(() => ({ kind: "introspect_typeof", expr, typeofForm }));
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
            sourceType = $.SUBRULE($.typeExpr);
            $.CONSUME(tokens.rbracket);
          });
          expr = $.ACTION(() => ({
            kind: "for_expr", variable: "__gel_backlink_item__", iterator: expr,
            body: { kind: "backlink_path", link, sourceType: simpleTypeName(sourceType),
              sourceTypeExpr: sourceType, optional: false },
          }));
          void backlink;
        } },
        { ALT: () => {
          $.CONSUME(tokens.dot);
          const member = $.OR3([
            { GATE: () => tokenMatcher($.LA(1), tokens.number), ALT: () => ({ index: $.CONSUME(tokens.number) }) },
            { ALT: () => ({ field: $.CONSUME2(Name).image }) },
          ]);
          expr = $.ACTION(() => {
            if ("index" in member) {
              return tupleAccess(expr, member.index.image);
            }
            const field = member.field;
            return expr.kind === "path_steps"
              ? { ...expr, steps: [...expr.steps, { kind: "ptr" as const, name: field, direction: "outbound" as const, optional: false }] }
              : expr.kind === "binding_ref" && $.bindingValues.get(expr.name)?.kind !== "subquery"
              ? { kind: "path" as const, head: expr.name, tail: field,
                  steps: [{ kind: "object_ref" as const, name: expr.name }, { kind: "ptr" as const, name: field, direction: "outbound" as const }] }
              : { kind: "field_access" as const, expr: expr.kind === "field_access" && expr.expr.kind === "current_item"
                  ? { kind: "field_access" as const, expr: expr.expr, field: expr.field, optional: false } : expr,
                  field, optional: false };
          });
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
              const typeExpr = $.SUBRULE2($.typeExpr);
              $.CONSUME2(tokens.rbracket);
              return $.ACTION<FreeObjectExpr>(() => {
                const typeName = simpleTypeName(typeExpr) ?? "";
                const steps = pathStepsForExpr(expr);
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
    $.RULE("typeExpr", (): TypeExpr => {
      let left = $.SUBRULE($.typeIntersectExpr);
      $.MANY(() => {
        $.CONSUME(tokens.pipe);
        const right = $.SUBRULE2($.typeIntersectExpr);
        left = { kind: "type_union", left, right };
      });
      return left;
    });
    $.RULE("typeIntersectExpr", (): TypeExpr => {
      let left = $.SUBRULE($.typeAtom);
      $.MANY(() => {
        $.CONSUME(tokens.ampersand);
        const right = $.SUBRULE2($.typeAtom);
        left = { kind: "type_intersection", left, right };
      });
      return left;
    });
    $.RULE("typeAtom", (): TypeExpr => $.OR([
      { ALT: () => {
        $.CONSUME(tokens.lparen);
        const expr = $.SUBRULE($.typeExpr);
        $.CONSUME(tokens.rparen);
        return expr;
      } },
      { ALT: () => {
        $.CONSUME(tokens.kw_typeof);
        const expr = $.SUBRULE($.unary);
        return { kind: "type_of" as const, expr };
      } },
      { ALT: () => ({ kind: "type_name" as const, name: $.SUBRULE($.qualifiedName) }) },
    ]));
    $.RULE("castType", (): string => {
      let left = $.SUBRULE($.castTypeIntersect);
      $.MANY(() => {
        $.CONSUME(tokens.pipe);
        const right = $.SUBRULE2($.castTypeIntersect);
        left = `${left} | ${right}`;
      });
      return left;
    });
    $.RULE("castTypeIntersect", (): string => {
      let left = $.SUBRULE($.castTypeUnit);
      $.MANY(() => {
        $.CONSUME(tokens.ampersand);
        const right = $.SUBRULE2($.castTypeUnit);
        left = `${left} & ${right}`;
      });
      return left;
    });
    $.RULE("castTypeUnit", (): string => $.OR([
      { ALT: () => {
        $.CONSUME(tokens.lparen);
        const inner = $.SUBRULE($.castType);
        $.CONSUME(tokens.rparen);
        return `(${inner})`;
      } },
      { ALT: () => {
      const name = $.SUBRULE($.qualifiedName);
      let args: string[] = [];
      let hasArgs = false;
      $.OPTION(() => {
        $.CONSUME(tokens.lt);
        hasArgs = true;
        args = [$.SUBRULE($.castTypeArg)];
        $.MANY(() => {
          $.CONSUME(tokens.comma);
          args.push($.SUBRULE2($.castTypeArg));
        });
        $.CONSUME(tokens.gt);
      });
      return hasArgs ? `${name}<${args.join(", ")}>` : name;
      } },
    ]));
    $.RULE("castTypeArg", (): string => $.OR([
      { GATE: () => tokenMatcher($.LA(1), Name) && tokenMatcher($.LA(2), tokens.colon), ALT: () => {
        const name = $.CONSUME(Name).image;
        $.CONSUME(tokens.colon);
        return `${name}: ${$.SUBRULE($.castType)}`;
      } },
      { ALT: () => $.SUBRULE2($.castType) },
    ]));
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
      let required: boolean | undefined;
      let cardinality: ShapeElement["cardinality"];
      const isModifier = (): boolean => {
        const token = $.LA(1);
        const terminator = [tokens.comma, tokens.rbrace, tokens.colon, tokens.assign]
          .some((kind) => tokenMatcher($.LA(2), kind));
        return !terminator && [tokens.kw_required, tokens.kw_optional, tokens.kw_multi, tokens.kw_single]
          .some((kind) => tokenMatcher(token, kind));
      };
      $.MANY({ GATE: isModifier, DEF: () => {
        const modifier = $.OR([
          { ALT: () => $.CONSUME(tokens.kw_required) },
          { ALT: () => $.CONSUME(tokens.kw_optional) },
          { ALT: () => $.CONSUME(tokens.kw_multi) },
          { ALT: () => $.CONSUME(tokens.kw_single) },
        ]);
        $.ACTION(() => {
          if (modifier.tokenTypeIdx === tokens.kw_required.tokenTypeIdx) required = true;
          else if (modifier.tokenTypeIdx === tokens.kw_optional.tokenTypeIdx) required = false;
          else if (modifier.tokenTypeIdx === tokens.kw_multi.tokenTypeIdx) cardinality = "many";
          else cardinality = "one";
        });
      } });
      const entry = $.SUBRULE($.shapeEntryCore);
      return $.ACTION(() => ({ ...entry,
        ...(required !== undefined ? { required } : {}),
        ...(cardinality !== undefined ? { cardinality } : {}),
      }));
    });
    $.RULE("shapeEntryCore", (): ShapeElement => $.OR([
      { GATE: () => tokenMatcher($.LA(1), tokens.star) || tokenMatcher($.LA(1), tokens.double_splat), ALT: () => {
        const splat = $.OR3([
          { ALT: () => $.CONSUME(tokens.star) },
          { ALT: () => $.CONSUME(tokens.double_splat) },
        ]);
        const depth = splat.tokenTypeIdx === tokens.star.tokenTypeIdx ? 1 as const : 2 as const;
        return { kind: "splat" as const, depth,
          operation: "assign" as const, origin: "explicit" as const };
      } },
      { GATE: () => tokenMatcher($.LA(1), tokens.backward_link), ALT: () => {
        $.CONSUME(tokens.backward_link);
        const name = $.CONSUME(Name).image;
        let sourceType: TypeExpr | undefined;
        $.OPTION(() => {
          $.CONSUME(tokens.lbracket);
          $.CONSUME(tokens.kw_is);
          sourceType = $.SUBRULE($.typeExpr);
          $.CONSUME(tokens.rbracket);
        });
        let nestedShape: ShapeElement[] | undefined;
        $.OPTION2(() => {
          $.CONSUME(tokens.lbrace);
          nestedShape = $.SUBRULE($.shape);
          $.CONSUME(tokens.rbrace);
        });
        return $.ACTION(() => ({ kind: "backlink" as const, name,
          expr: { link: name, sourceType: simpleTypeName(sourceType),
            sourceTypeExpr: sourceType }, ...(nestedShape ? { shape: nestedShape } : {}),
          operation: "assign" as const, origin: "explicit" as const }));
      } },
      { GATE: () => tokenMatcher($.LA(1), tokens.at), ALT: () => {
        $.CONSUME(tokens.at);
        const property = $.CONSUME3(Name).image;
        let expr: ComputedExpr = { kind: "field_ref", field: `@${property}` };
        $.OPTION4(() => {
          $.CONSUME2(tokens.assign);
          expr = computedExpr($.SUBRULE2($.expression));
        });
        return $.ACTION(() => ({ kind: "computed" as const, name: `@${property}`, expr,
          operation: "assign" as const, origin: "explicit" as const }));
      } },
      { GATE: () => tokenMatcher($.LA(1), tokens.lbracket) && tokenMatcher($.LA(2), tokens.kw_is), ALT: () => {
        $.CONSUME2(tokens.lbracket);
        $.CONSUME2(tokens.kw_is);
        const sourceTypeExpr = $.SUBRULE2($.typeExpr);
        $.CONSUME2(tokens.rbracket);
        $.CONSUME(tokens.dot);
        const name = $.CONSUME4(Name).image;
        return $.ACTION(() => ({
          kind: "computed" as const, name,
          expr: { kind: "polymorphic_field_ref" as const,
            sourceType: simpleTypeName(sourceTypeExpr) ?? "", sourceTypeExpr, field: name },
          operation: "assign" as const, origin: "explicit" as const,
        }));
      } },
      { GATE: () => tokenMatcher($.LA(1), Name)
        && tokenMatcher($.LA(2), tokens.assign)
        && tokenMatcher($.LA(3), tokens.backward_link), ALT: () => $.SUBRULE($.computedBacklinkShapeEntry) },
      { ALT: () => {
        const name = $.CONSUME2(Name).image;
        let result: ShapeElement | undefined;
        $.OPTION3(() => $.OR2([
          { ALT: () => {
            $.CONSUME3(tokens.assign);
            const expr = $.SUBRULE3($.expression);
            result = $.ACTION(() => ({
              kind: "computed" as const, name, expr: computedExpr(expr),
              operation: "assign" as const, origin: "explicit" as const,
            }));
          } },
          { ALT: () => {
            $.CONSUME(tokens.colon);
            $.CONSUME2(tokens.lbrace);
            const shape = $.SUBRULE2($.shape);
            $.CONSUME2(tokens.rbrace);
            let filter: FilterExpr | undefined;
            $.OPTION5({ GATE: () => tokenMatcher($.LA(1), tokens.kw_filter), DEF: () => {
              $.CONSUME(tokens.kw_filter);
              const predicate = $.SUBRULE4($.expression);
              filter = $.ACTION(() => filterFromExpr(predicate));
            } });
            let orderBy: OrderExpr | undefined;
            $.OPTION6(() => {
              $.CONSUME(tokens.kw_order);
              $.CONSUME(tokens.kw_by);
              const order = $.SUBRULE($.orderItem);
              orderBy = $.ACTION(() => orderExprForSelect(order, ""));
            });
            result = $.ACTION(() => ({
              kind: "link", name, shape,
              clauses: { ...(filter ? { filter } : {}), ...(orderBy ? { orderBy } : {}) },
              operation: "assign", origin: "explicit",
            }));
          } },
        ]));
        return $.ACTION(() => result ?? { kind: "field" as const, name,
          operation: "assign" as const, origin: "explicit" as const });
      } },
    ]));
    $.RULE("computedBacklinkShapeEntry", (): ShapeElement => {
      const name = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      $.CONSUME(tokens.backward_link);
      const link = $.CONSUME2(Name).image;
      let sourceTypeExpr: TypeExpr | undefined;
      $.OPTION(() => {
        $.CONSUME(tokens.lbracket);
        $.CONSUME(tokens.kw_is);
        sourceTypeExpr = $.SUBRULE($.typeExpr);
        $.CONSUME(tokens.rbracket);
      });
      let shape: ShapeElement[] | undefined;
      $.OPTION2(() => {
        $.CONSUME(tokens.lbrace);
        shape = $.SUBRULE($.shape);
        $.CONSUME(tokens.rbrace);
      });
      return $.ACTION(() => ({ kind: "backlink" as const, name,
        expr: { link, sourceType: simpleTypeName(sourceTypeExpr), sourceTypeExpr },
        ...(shape ? { shape } : {}), operation: "assign" as const, origin: "explicit" as const }));
    });
    $.RULE("forExpr", (): FreeObjectExpr => {
      const binders: Array<{ variable: string; iterator: FreeObjectExpr; optional: boolean }> = [];
      $.AT_LEAST_ONE(() => {
        $.CONSUME(tokens.kw_for);
        let optional = false;
        $.OPTION(() => { $.CONSUME(tokens.kw_optional); optional = true; });
        const variable = $.CONSUME(Name).image;
        $.CONSUME(tokens.kw_in);
        const iterator = $.SUBRULE($.orExpr);
        binders.push({ variable, iterator, optional });
        $.ACTION(() => { $.bindings.add(variable); });
      });
      $.OR([
        { ALT: () => $.CONSUME(tokens.kw_select) },
        { ALT: () => $.CONSUME(tokens.kw_union) },
      ]);
      const body = $.SUBRULE2($.expression);
      return $.ACTION(() => {
        let result = body;
        for (let i = binders.length - 1; i >= 0; i--) {
          const binder = binders[i];
          result = { kind: "for_expr", variable: binder.variable, iterator: binder.iterator,
            optional: binder.optional, body: result };
          $.bindings.delete(binder.variable);
          $.bindingValues.delete(binder.variable);
        }
        return result;
      });
    });
    $.RULE("atom", (): FreeObjectExpr => $.OR([
      { GATE: () => tokenMatcher($.LA(1), tokens.str_interp_start), ALT: () => $.SUBRULE($.stringInterpolation) },
      { GATE: () => tokenMatcher($.LA(1), tokens.lbracket) && tokenMatcher($.LA(2), tokens.kw_is), ALT: () => {
        $.CONSUME(tokens.lbracket);
        $.CONSUME(tokens.kw_is);
        const typeExpr = $.SUBRULE($.typeExpr);
        $.CONSUME(tokens.rbracket);
        return { kind: "path_steps" as const, steps: [{ kind: "type_intersection" as const,
          typeName: simpleTypeName(typeExpr) ?? "", typeExpr }], partial: true };
      } },
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
        const expr = $.SUBRULE($.unary);
        return $.ACTION<FreeObjectExpr>(() => {
          if (expr.kind === "select" || expr.kind === "select_expr_subquery"
              || expr.kind === "free_object_constructor") return { ...expr, detached: true };
          return expr;
        });
      } },
      { GATE: () => tokenMatcher($.LA(1), tokens.kw_for), ALT: () => $.SUBRULE($.forExpr) },
      { GATE: () => tokenMatcher($.LA(1), tokens.backward_link), ALT: () => {
        $.CONSUME(tokens.backward_link);
        const link = $.CONSUME2(Name).image;
        let sourceType: TypeExpr | undefined;
        $.OPTION5(() => {
          $.CONSUME2(tokens.lbracket);
          $.CONSUME2(tokens.kw_is);
          sourceType = $.SUBRULE2($.typeExpr);
          $.CONSUME2(tokens.rbracket);
        });
        return { kind: "backlink_path" as const, link,
          sourceType: simpleTypeName(sourceType), sourceTypeExpr: sourceType, optional: false };
      } },
      { ALT: () => {
        $.CONSUME(tokens.dot);
        const member = $.OR2([
          { GATE: () => tokenMatcher($.LA(1), tokens.number), ALT: () => ({ index: $.CONSUME2(tokens.number) }) },
          { ALT: () => ({ field: $.CONSUME(Name).image }) },
        ]);
        return $.ACTION<FreeObjectExpr>(() => "index" in member
          ? tupleAccess({ kind: "current_item" }, member.index.image)
          : { kind: "field_access", expr: { kind: "current_item" }, field: member.field, optional: false });
      } },
      { ALT: () => {
        const name = $.SUBRULE($.qualifiedName);
        let result: FreeObjectExpr | undefined;
        $.OPTION(() => {
          const lparen = $.CONSUME(tokens.lparen);
          const args: FunctionCallArgExpr[] = [];
          $.OPTION2(() => {
            args.push($.SUBRULE($.functionCallArg));
            $.MANY3(() => {
              $.CONSUME2(tokens.comma);
              args.push($.SUBRULE2($.functionCallArg));
            });
            $.OPTION3(() => $.CONSUME3(tokens.comma));
          });
          $.CONSUME(tokens.rparen);
          result = $.ACTION(() => {
            validateFunctionCallArgs(args, lparen.startLine ?? 1, lparen.startColumn ?? 1);
            return { kind: "function_call", call: { name, args } };
          });
        });
        return $.ACTION<FreeObjectExpr>(() => {
          if (name.startsWith("__") && name.endsWith("__")) {
            if (name === "__type__") throw syntaxError("'__type__' is always a path step; reference it as 'X.__type__'");
            return { kind: "global_ref", name };
          }
          return result ?? ($.bindings.has(name) || !/[A-Z]/.test(name.split("::").pop()?.[0] ?? "")
            ? { kind: "binding_ref", name } : typeSource(inModule(name, $.defaultModule)));
        });
      } },
      { ALT: () => $.SUBRULE($.parenthesized) },
      { ALT: () => $.SUBRULE($.groupExpr) },
      { ALT: () => $.SUBRULE($.braces) },
      { ALT: () => $.SUBRULE($.array) },
    ]));
    $.RULE("functionCallArg", (): FunctionCallArgExpr => $.OR([
      { GATE: () => (tokenMatcher($.LA(1), Name) || tokenMatcher($.LA(1), tokens.kw_empty))
        && tokenMatcher($.LA(2), tokens.assign), ALT: () => {
        const name = $.OR2([
          { ALT: () => $.CONSUME(Name).image },
          { ALT: () => $.CONSUME(tokens.kw_empty).image },
        ]);
        $.CONSUME(tokens.assign);
        const expr = $.SUBRULE($.expression);
        return $.ACTION<FunctionCallArgExpr>(() => ({ kind: "named_arg", name, arg: functionArg(expr, $.bindings) }));
      } },
      { ALT: () => {
        const expr = $.SUBRULE2($.expression);
        let order: GrammarOrderItem | undefined;
        $.OPTION({ GATE: () => tokenMatcher($.LA(1), tokens.kw_order), DEF: () => {
          $.CONSUME(tokens.kw_order);
          $.CONSUME(tokens.kw_by);
          order = $.SUBRULE($.orderItem);
        } });
        return $.ACTION(() => functionArg(order
          ? { kind: "select_expr_subquery", expr, orderBy: orderExprChain(order) }
          : expr, $.bindings));
      } },
    ]));
    $.RULE("innerSelect", (): FreeObjectExpr => {
      $.CONSUME(tokens.kw_select);
      let alias: string | undefined;
      $.OPTION4({ GATE: () => tokenMatcher($.LA(1), Name) && tokenMatcher($.LA(2), tokens.assign), DEF: () => {
        alias = $.CONSUME(Name).image;
        $.CONSUME(tokens.assign);
        $.ACTION(() => { if (alias !== undefined) $.bindings.add(alias); });
      } });
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
        const sortInShape = order && expr.kind === "select" && $.explicitShapes.has(expr)
          && orderUsesOnlyCurrentItemFields(order);
        const inner: FreeObjectExpr = expr.kind === "select" && (filter || sortInShape)
          ? { ...expr, clauses: { ...expr.clauses, ...(filter ? { filter } : {}),
              ...(sortInShape && order ? { orderBy: orderExprForSelect(order, expr.typeName) } : {}) } }
          : expr;
        return { kind: "select_expr_subquery", ...(alias ? { alias } : {}), expr: inner,
          filter: filterExpr && expr.kind !== "select" ? filterExpr : undefined,
          orderBy: order && !sortInShape ? orderExprChain(order) : undefined,
          limit, offset: undefined, limitExpr: undefined, offsetExpr: undefined };
      });
    });
    $.RULE("objectEntry", (): {
      name: string; expr: FreeObjectExpr;
      cardinality?: "one" | "many"; required?: boolean;
    } => {
      let required: boolean | undefined;
      let cardinality: "one" | "many" | undefined;
      const isModifier = (): boolean => {
        const terminator = [tokens.comma, tokens.rbrace, tokens.rparen, tokens.colon, tokens.assign]
          .some((kind) => tokenMatcher($.LA(2), kind));
        return !terminator && [tokens.kw_required, tokens.kw_optional, tokens.kw_multi, tokens.kw_single]
          .some((kind) => tokenMatcher($.LA(1), kind));
      };
      $.MANY({ GATE: isModifier, DEF: () => {
        const modifier = $.OR([
          { ALT: () => $.CONSUME(tokens.kw_required) },
          { ALT: () => $.CONSUME(tokens.kw_optional) },
          { ALT: () => $.CONSUME(tokens.kw_multi) },
          { ALT: () => $.CONSUME(tokens.kw_single) },
        ]);
        $.ACTION(() => {
          if (modifier.tokenTypeIdx === tokens.kw_required.tokenTypeIdx) required = true;
          else if (modifier.tokenTypeIdx === tokens.kw_optional.tokenTypeIdx) required = false;
          else if (modifier.tokenTypeIdx === tokens.kw_multi.tokenTypeIdx) cardinality = "many";
          else cardinality = "one";
        });
      } });
      const name = $.CONSUME(Name).image;
      $.CONSUME(tokens.assign);
      const expr = $.SUBRULE($.expression);
      return { name, expr, ...(required !== undefined ? { required } : {}),
        ...(cardinality !== undefined ? { cardinality } : {}) };
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
        { GATE: () => tokenMatcher($.LA(1), tokens.kw_with), ALT: () => {
          $.CONSUME(tokens.kw_with);
          const bindings = [$.SUBRULE($.binding)];
          $.MANY2({ GATE: () => tokenMatcher($.LA(1), tokens.comma)
            && ![tokens.kw_select, tokens.kw_group, tokens.kw_for].some((kind) => tokenMatcher($.LA(2), kind)), DEF: () => {
            $.CONSUME3(tokens.comma);
            bindings.push($.SUBRULE2($.binding));
          } });
          $.OPTION4({ GATE: () => tokenMatcher($.LA(1), tokens.comma)
            && [tokens.kw_select, tokens.kw_group, tokens.kw_for].some((kind) => tokenMatcher($.LA(2), kind)),
          DEF: () => $.CONSUME5(tokens.comma) });
          const expr = $.OR2([
            { GATE: () => tokenMatcher($.LA(1), tokens.kw_select), ALT: () => $.SUBRULE2($.innerSelect) },
            { GATE: () => tokenMatcher($.LA(1), tokens.kw_group), ALT: () => $.SUBRULE($.groupExpr) },
            { GATE: () => tokenMatcher($.LA(1), tokens.kw_for), ALT: () => $.SUBRULE2($.forExpr) },
          ]);
          $.MANY3(() => $.CONSUME(tokens.semi));
          $.CONSUME7(tokens.rparen);
          return { kind: "select_expr_subquery" as const, expr, clauses: { _withBindings: bindings } };
        } },
        { GATE: () => tokenMatcher($.LA(1), tokens.kw_select), ALT: () => {
          const expr = $.SUBRULE($.innerSelect);
          $.CONSUME2(tokens.rparen);
          return expr;
        } },
        { GATE: () => tokenMatcher($.LA(1), tokens.kw_for), ALT: () => {
          const expr = $.SUBRULE($.forExpr);
          $.CONSUME6(tokens.rparen);
          return expr;
        } },
        { GATE: () => [tokens.kw_insert, tokens.kw_update, tokens.kw_delete].some((kind) => tokenMatcher($.LA(1), kind)), ALT: () => {
          const statement = $.OR3([
            { ALT: () => $.SUBRULE($.insertStatement) },
            { ALT: () => $.SUBRULE($.updateStatement) },
            { ALT: () => $.SUBRULE($.deleteStatement) },
          ]);
          $.CONSUME4(tokens.rparen);
            return { kind: "mutation_expr" as const, statement } as FreeObjectExpr;
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
            result = { kind: "tuple", values } as FreeObjectExpr;
          });
          $.CONSUME5(tokens.rparen);
          return result;
        } },
      ]);
      return result;
    });
    $.RULE("stringInterpolation", (): FreeObjectExpr => {
      const start = $.CONSUME(tokens.str_interp_start);
      const expressions = [$.SUBRULE($.expression)];
      const continuations: Array<{ text: string; expr: FreeObjectExpr }> = [];
      $.MANY({ GATE: () => tokenMatcher($.LA(1), tokens.str_interp_cont), DEF: () => {
        const text = $.CONSUME(tokens.str_interp_cont).image;
        continuations.push({ text, expr: $.SUBRULE2($.expression) });
      } });
      const end = $.CONSUME(tokens.str_interp_end);
      return $.ACTION(() => {
        const parts: FreeObjectExpr[] = [];
        if (start.image.length) parts.push({ kind: "literal", value: start.image });
        parts.push({ kind: "cast", castType: "str", expr: expressions[0] });
        for (const continuation of continuations) {
          if (continuation.text.length) parts.push({ kind: "literal", value: continuation.text });
          parts.push({ kind: "cast", castType: "str", expr: continuation.expr });
        }
        if (end.image.length) parts.push({ kind: "literal", value: end.image });
        if (parts.length === 0) return { kind: "literal", value: "" };
        return parts.length === 1 ? parts[0] : { kind: "concat", parts };
      });
    });
    $.RULE("braces", (): FreeObjectExpr => {
      $.CONSUME(tokens.lbrace);
      const isObjectEntryAhead = (): boolean => {
        let offset = 1;
        while ([tokens.kw_required, tokens.kw_optional, tokens.kw_multi, tokens.kw_single]
          .some((kind) => tokenMatcher($.LA(offset), kind))
          && ![tokens.comma, tokens.rbrace, tokens.colon, tokens.assign]
            .some((kind) => tokenMatcher($.LA(offset + 1), kind))) offset++;
        return tokenMatcher($.LA(offset), Name) && tokenMatcher($.LA(offset + 1), tokens.assign);
      };
      const result = $.OR([
        { GATE: isObjectEntryAhead, ALT: () => {
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
      const first = $.CONSUME(Name);
      let name = first.tokenTypeIdx === tokens.kw_object.tokenTypeIdx ? "Object" : first.image;
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

const isWordToken = (token: Token | undefined): boolean => !!token
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
      variadic: prefix.some((token) => token.lower === "variadic") || undefined,
      namedOnly: prefix.some((token) => token.lower === "named") || undefined,
      optional: optional || undefined, setOf: setOf || undefined, defaultExpr });
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
      query = tokensIn[body].lexeme.trim();
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
  return { params, returnType, returnOptional, returnSetOf, body: { kind: "query", language, query,
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

function parseGlobalSettingGrammar(
  source: string,
  lexical: readonly Token[],
  lineStarts: readonly number[],
  defaultModule?: string,
): ConfigureStatement {
  const stream = lexical.filter((token) => token.kind !== "eof" && token.kind !== "semi");
  const start = stream[0];
  const operation = start.lower.toLowerCase();
  if (operation !== "set" && operation !== "reset") throw syntaxError("Expected SET or RESET GLOBAL");
  let i = 2;
  const targetStart = i;
  while (i < stream.length && stream[i].kind !== "assign") i++;
  const target = stream.slice(targetStart, i).map((token) => token.lexeme).join("");
  let value: FreeObjectExpr | undefined;
  if (operation === "set") {
    if (stream[i]?.kind !== "assign") throw syntaxError("Expected ':=' in SET GLOBAL statement");
    const expressionSource = source.slice(stream[i].offset + stream[i].lexeme.length).replace(/;\s*$/, "").trim();
    const parsed = parseEdgeQLGrammar(`SELECT ${expressionSource}`, defaultModule);
    if (parsed.kind === "select_expr") value = parsed.expr;
  }
  const pos = offsetToLineCol(start.offset, lineStarts);
  return { kind: "configure", scope: "session", operation, target,
    ...(value ? { value } : {}), isSessionGlobal: true, pos };
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
    let bindingComma = -1;
    let foundBody = -1;
    for (let i = 2; i < lexical.length; i++) {
      const token = lexical[i];
      if (depth === 0 && token.kind === "comma") { bindingComma = i; break; }
      if (depth === 0 && ["kw_select", "kw_group", "kw_insert", "kw_update", "kw_delete", "kw_for", "kw_create", "kw_alter", "kw_drop"]
        .includes(token.kind)) { foundBody = i; break; }
      if (["lbrace", "lparen", "lbracket"].includes(token.kind)) depth++;
      else if (["rbrace", "rparen", "rbracket"].includes(token.kind)) depth--;
    }
    if (bindingComma >= 0) {
      const moduleName = source.slice(lexical[2].offset, lexical[bindingComma].offset).trim();
      depth = 0;
      for (let i = bindingComma + 1; i < lexical.length; i++) {
        const token = lexical[i];
        if (depth === 0 && ["kw_select", "kw_group", "kw_insert", "kw_update", "kw_delete", "kw_for", "kw_create", "kw_alter", "kw_drop"]
          .includes(token.kind)) { foundBody = i; break; }
        if (["lbrace", "lparen", "lbracket"].includes(token.kind)) depth++;
        else if (["rbrace", "rparen", "rbracket"].includes(token.kind)) depth--;
      }
      if (foundBody < 0) throw syntaxError("Expected a statement after WITH MODULE bindings");
      const tail = source.slice(lexical[bindingComma].offset + lexical[bindingComma].lexeme.length);
      const parsed = parseEdgeQLGrammar(`WITH ${tail}`);
      parsed.pos = offsetToLineCol(lexical[foundBody].offset, lineStarts);
      return { ...parsed, withModule: moduleName } as Statement;
    }
    if (foundBody < 0) throw syntaxError("Expected a statement after WITH MODULE");
    const moduleName = source.slice(lexical[2].offset, lexical[foundBody].offset).trim();
    const parsed = parseEdgeQLGrammar(source.slice(lexical[foundBody].offset));
    const bodyPos = offsetToLineCol(lexical[foundBody].offset, lineStarts);
    parsed.pos = bodyPos;
    return { ...parsed, withModule: moduleName } as Statement;
  }
  if (lexical[0]?.kind === "kw_set" && lexical[1]?.kind === "kw_global") {
    return parseGlobalSettingGrammar(source, lexical, lineStarts, defaultModule);
  }
  if (lexical[0]?.lower === "reset" && lexical[1]?.kind === "kw_global") {
    return parseGlobalSettingGrammar(source, lexical, lineStarts, defaultModule);
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
      : lexical[0]?.kind === "kw_for" ? grammar.forStatement()
      : lexical[0]?.kind === "kw_if" ? grammar.ifStatement() : grammar.statement();
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
export function parseEdgeQLGrammarScript(source: string, defaultModule?: string): Statement[] {
  const { tokens: lexical, lineStarts } = tokenizeWithStarts(source);
  const statements: Statement[] = [];
  let depth = 0;
  let start = 0;
  let activeModule = defaultModule;
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
