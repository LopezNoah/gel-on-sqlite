import { AppError } from "../errors.js";
import type {
  FilterExpr,
  FreeObjectExpr,
  OrderExpr,
  OrderExprChain,
  SelectExprStatement,
  SelectStatement,
  ShapeElement,
  Statement,
} from "./ast.js";
import { offsetToLineCol } from "./tokenizer.js";
import { parseGelGrammarCST, type GelCSTNode, type GelCSTProduction } from "./gel_lr_parser.js";

const isProduction = (node: GelCSTNode | undefined): node is GelCSTProduction =>
  node?.kind === "production";

const productions = (node: GelCSTNode): GelCSTProduction[] =>
  node.kind === "production" ? node.args.filter(isProduction) : [];

const findProductions = (
  node: GelCSTNode,
  productionName: string,
  ruleName?: string,
): GelCSTProduction[] => {
  if (node.kind !== "production") return [];
  const matches =
    node.name[0] === productionName && (!ruleName || node.name[1] === ruleName) ? [node] : [];
  return [
    ...matches,
    ...productions(node).flatMap((child) => findProductions(child, productionName, ruleName)),
  ];
};

const terminals = (node: GelCSTNode): Array<Extract<GelCSTNode, { kind: "terminal" }>> =>
  node.kind === "production"
    ? node.args.flatMap((arg) => (arg.kind === "terminal" ? [arg] : []))
    : [];

const allTerminals = (node: GelCSTNode): Array<Extract<GelCSTNode, { kind: "terminal" }>> => {
  if (node.kind === "terminal") return [node];
  if (node.kind === "empty") return [];
  return node.args.flatMap(allTerminals);
};

const syntaxError = (message: string, offset: number, source: string): AppError => {
  const position = offsetToLineCol(offset, source);
  return new AppError("E_SYNTAX", message, position.line, position.column);
};

const inModule = (name: string, module: string): string =>
  module && !name.includes("::") ? `${module}::${name}` : name;

const startOffset = (node: GelCSTNode): number =>
  node.kind === "production"
    ? (node.span?.start ?? 0)
    : node.kind === "terminal"
      ? node.span.start
      : 0;

const reduceSimpleShape = (
  node: GelCSTNode,
  source: string,
  defaultModule: string,
): ShapeElement[] => {
  const topLevelElements = (current: GelCSTNode): GelCSTProduction[] => {
    if (current.kind !== "production") return [];
    if (current.name[0] === "ShapeElement") return [current];
    return productions(current).flatMap(topLevelElements);
  };
  const elements = topLevelElements(node);
  return elements.map((element) => {
    if (element.name[1] !== "reduce_ShapeElementWithSubShape") {
      throw syntaxError(
        "Generated shape reducer supports plain fields and nested link shapes only",
        element.span?.start ?? 0,
        source,
      );
    }
    const directProductions = productions(element);
    const unsupportedOptions = ["OptAnySubShape"]
      .map((name) => directProductions.find((child) => child.name[0] === name))
      .filter((option): option is GelCSTProduction =>
        Boolean(option && option.name[1] !== "reduce_empty"),
      );
    if (unsupportedOptions.length > 0) {
      throw syntaxError(
        "Generated shape reducer supports plain fields and nested link shapes only",
        element.span?.start ?? 0,
        source,
      );
    }

    const optionNode = (name: string): GelCSTProduction | undefined =>
      directProductions.find((child) => child.name[0] === name);
    const nestedShape = directProductions.find((child) => child.name[0] === "ShapeElementList");
    const filterNode =
      optionNode("OptFilterClause") ?? directProductions.find((child) => child.name[0] === "Expr");
    const sortNode =
      optionNode("OptSortClause") ??
      directProductions.find((child) => child.name[0] === "OrderbyList");
    const limitNode =
      optionNode("OptSelectLimit") ??
      directProductions.find((child) => child.name[0] === "SelectLimit");
    const hasClause = (option: GelCSTProduction | undefined): boolean =>
      Boolean(option && option.name[1] !== "reduce_empty");
    if (
      findProductions(element, "OptTypeIntersection").some(
        (option) => option.name[1] !== "reduce_empty",
      )
    ) {
      throw syntaxError(
        "Generated shape reducer does not yet support shape type intersections",
        element.span?.start ?? 0,
        source,
      );
    }
    const pointer = productions(element)[0];
    const pointerTokens = pointer ? allTerminals(pointer) : [];
    const name =
      pointerTokens.length === 1 && pointerTokens[0]?.terminal === "IDENT"
        ? pointerTokens[0].text
        : undefined;
    if (!name)
      throw syntaxError(
        "Generated shape entry is missing its field name",
        element.span?.start ?? 0,
        source,
      );
    const filterExprNode = filterNode
      ? filterNode.name[0] === "OptFilterClause"
        ? productions(filterNode)[0]
        : filterNode
      : undefined;
    const filterExpr = filterExprNode
      ? reduceExpression(filterExprNode, source, defaultModule)
      : undefined;
    const filter = filterExpr
      ? reduceSimpleFilter(filterExpr, source, startOffset(filterExprNode!))
      : undefined;
    const order = hasClause(sortNode) ? reduceOrderBy(sortNode, source, defaultModule) : undefined;
    const pagination = hasClause(limitNode)
      ? reduceSelectLimit(limitNode, source, defaultModule)
      : {};
    const modifiers = {
      ...(filterExpr ? { where: filterExpr } : {}),
      ...(order ? { orderBy: toSelectOrderExprList(order) } : {}),
      ...pagination,
    };
    if (nestedShape) {
      return {
        kind: "link",
        name,
        typeFilter: undefined,
        typeFilterExpr: undefined,
        shape: reduceSimpleShape(nestedShape, source, defaultModule),
        clauses: {
          ...(filter ? { filter } : {}),
          ...(order ? { orderBy: toSelectOrderExpr(order, "") } : {}),
          ...pagination,
        },
        operation: "assign",
        origin: "explicit",
        ...modifiers,
      };
    }
    return { kind: "field", name, operation: "assign", origin: "explicit", ...modifiers };
  });
};

const reduceSimpleFilter = (expr: FreeObjectExpr, source: string, offset: number): FilterExpr => {
  if (expr.kind === "and" || expr.kind === "or") {
    return {
      kind: expr.kind,
      left: reduceSimpleFilter(expr.left, source, offset),
      right: reduceSimpleFilter(expr.right, source, offset),
    };
  }
  if (expr.kind === "not") {
    return { kind: "not", expr: reduceSimpleFilter(expr.expr, source, offset) };
  }
  if (
    expr.kind === "compare" &&
    expr.left.kind === "field_access" &&
    expr.left.expr.kind === "current_item"
  ) {
    let value: Extract<FilterExpr, { kind: "predicate" }>["value"] | undefined;
    if (expr.right.kind === "literal") value = expr.right.value;
    else if (expr.right.kind === "binding_ref") {
      value = { kind: "binding_ref", name: expr.right.name };
    } else if (expr.right.kind === "field_access" && expr.right.expr.kind === "current_item") {
      value = { kind: "field_ref", field: expr.right.field };
    }
    if (value === undefined) {
      throw syntaxError(
        "Generated filter reducer supports field-to-literal or field-reference comparisons only",
        offset,
        source,
      );
    }
    return {
      kind: "predicate",
      target: { kind: "field", field: expr.left.field },
      op: expr.op as Extract<FilterExpr, { kind: "predicate" }>["op"],
      value,
    };
  }
  throw syntaxError(
    "Generated CST reducer currently supports field-to-literal filters only",
    offset,
    source,
  );
};

interface ReducedOrderExpr {
  expr: FreeObjectExpr;
  direction: "asc" | "desc";
  nullsPosition?: "first" | "last";
  then?: ReducedOrderExpr;
}

const reduceOrderBy = (
  node: GelCSTNode | undefined,
  source: string,
  defaultModule: string,
): ReducedOrderExpr | undefined => {
  if (!isProduction(node) || node.name[1] === "reduce_empty") return undefined;
  if (node.name[0] === "OptSortClause") {
    return reduceOrderBy(productions(node)[0], source, defaultModule);
  }

  if (node.name[0] === "OrderbyList") {
    const children = productions(node);
    const previous = children.find((child) => child.name[0] === "OrderbyList");
    const last = children.find((child) => child.name[0] === "OrderbyExpr");
    if (previous && last) {
      const left = reduceOrderBy(previous, source, defaultModule);
      const right = reduceOrderBy(last, source, defaultModule);
      if (!left || !right) {
        throw syntaxError("Malformed generated ORDER BY list", node.span?.start ?? 0, source);
      }
      let cursor = left;
      while (cursor.then) cursor = cursor.then;
      cursor.then = right;
      return left;
    }
    const child = children.find((candidate) => candidate.name[0] === "OrderbyExpr");
    if (child) return reduceOrderBy(child, source, defaultModule);
  }

  if (node.name[0] === "OrderbyExpr") {
    const children = productions(node);
    const expression = children.find(
      (child) => child.name[0] !== "OptDirection" && child.name[0] !== "OptNonesOrder",
    );
    if (!expression) {
      throw syntaxError(
        "Generated ORDER BY item is missing its expression",
        node.span?.start ?? 0,
        source,
      );
    }
    const directionNode = children.find((child) => child.name[0] === "OptDirection");
    const nullsNode = children.find((child) => child.name[0] === "OptNonesOrder");
    const direction = allTerminals(directionNode ?? node)
      .map((token) => token.text.toLowerCase())
      .find((text) => text === "asc" || text === "desc");
    const nullsPosition = allTerminals(nullsNode ?? node)
      .map((token) => token.text.toLowerCase())
      .find((text) => text === "first" || text === "last");
    return {
      expr: reduceExpression(expression, source, defaultModule),
      direction: direction === "desc" ? "desc" : "asc",
      ...(nullsPosition ? { nullsPosition } : {}),
    };
  }

  throw syntaxError(
    `Generated ORDER BY production is not supported: ${node.name[0]}.${node.name[1]}`,
    node.span?.start ?? 0,
    source,
  );
};

const toOrderExprChain = (order: ReducedOrderExpr): OrderExprChain => ({
  expr: order.expr,
  direction: order.direction,
  ...(order.nullsPosition ? { nullsPosition: order.nullsPosition } : {}),
  ...(order.then ? { then: toOrderExprChain(order.then) } : {}),
});

const toSelectOrderExpr = (order: ReducedOrderExpr, typeName: string): OrderExpr => {
  const fieldAccess =
    order.expr.kind === "field_access" &&
    (order.expr.expr.kind === "current_item" ||
      (order.expr.expr.kind === "select" && order.expr.expr.typeName === typeName));
  const nameSort =
    order.expr.kind === "binding_ref"
      ? order.expr.name
      : order.expr.kind === "path"
        ? `${order.expr.head}.${order.expr.tail}`
        : undefined;
  return {
    field: fieldAccess
      ? (order.expr as Extract<FreeObjectExpr, { kind: "field_access" }>).field
      : (nameSort ?? "__expr__"),
    ...(fieldAccess || nameSort ? {} : { expr: order.expr }),
    direction: order.direction,
    ...(order.nullsPosition ? { nullsPosition: order.nullsPosition } : {}),
    ...(order.then ? { then: toSelectOrderExpr(order.then, typeName) } : {}),
  };
};

const toSelectOrderExprList = (order: ReducedOrderExpr): OrderExpr[] => {
  const { then, ...first } = order;
  return [toSelectOrderExpr(first, ""), ...(then ? toSelectOrderExprList(then) : [])];
};

interface ReducedSelectLimit {
  limit?: number;
  offset?: number;
  limitExpr?: FreeObjectExpr;
  offsetExpr?: FreeObjectExpr;
}

const hasPagination = (pagination: ReducedSelectLimit): boolean =>
  pagination.limit !== undefined ||
  pagination.offset !== undefined ||
  pagination.limitExpr !== undefined ||
  pagination.offsetExpr !== undefined;

const reduceSelectLimit = (
  node: GelCSTNode | undefined,
  source: string,
  defaultModule: string,
): ReducedSelectLimit => {
  if (!isProduction(node) || node.name[1] === "reduce_empty") return {};
  if (node.name[0] === "OptSelectLimit") {
    return reduceSelectLimit(productions(node)[0], source, defaultModule);
  }
  if (node.name[0] !== "SelectLimit") {
    throw syntaxError(
      `Generated SELECT limit production is not supported: ${node.name[0]}.${node.name[1]}`,
      node.span?.start ?? 0,
      source,
    );
  }

  const children = productions(node);
  const result: ReducedSelectLimit = {};
  const assign = (key: "limit" | "offset", expression: GelCSTNode): void => {
    const value = reduceExpression(expression, source, defaultModule);
    if (
      value.kind === "literal" &&
      typeof value.value === "number" &&
      value.numericKind === "integer"
    ) {
      result[key] = value.value;
    } else {
      result[key === "limit" ? "limitExpr" : "offsetExpr"] = value;
    }
  };

  const rule = node.name[1];
  if (rule === "reduce_OffsetClause_LimitClause") {
    if (children.length !== 2) {
      throw syntaxError("Malformed generated OFFSET/LIMIT clause", node.span?.start ?? 0, source);
    }
    assign("offset", children[0]);
    assign("limit", children[1]);
  } else if (rule === "reduce_LimitClause_OffsetClause") {
    if (children.length !== 2) {
      throw syntaxError("Malformed generated LIMIT/OFFSET clause", node.span?.start ?? 0, source);
    }
    assign("limit", children[0]);
    assign("offset", children[1]);
  } else if (rule === "reduce_OffsetClause" || rule === "reduce_LimitClause") {
    const child = children[0];
    if (!child) {
      throw syntaxError("Malformed generated SELECT limit clause", node.span?.start ?? 0, source);
    }
    assign(rule === "reduce_OffsetClause" ? "offset" : "limit", child);
  } else {
    throw syntaxError(
      `Generated SELECT limit production is not supported: ${rule}`,
      node.span?.start ?? 0,
      source,
    );
  }
  return result;
};

const topLevelStatements = (cst: GelCSTNode): GelCSTProduction[] => {
  const block = productions(cst).find((child) => child.name[0] === "EdgeQLBlock");
  const statementList = block && productions(block).find((child) => child.name[0] === "StmtList");
  if (!statementList) return [];

  const result: GelCSTProduction[] = [];
  const visit = (list: GelCSTProduction): void => {
    for (const child of productions(list)) {
      if (child.name[0] === "StmtList") visit(child);
      else if (child.name[0] !== "Semicolons" && child.name[0] !== "OptSemicolons") {
        result.push(child);
      }
    }
  };
  visit(statementList);
  return result;
};

const reduceSelectNode = (
  select: GelCSTProduction,
  source: string,
  defaultModule: string,
): Statement => {
  if (select.name[1] !== "reduce_Select") {
    throw syntaxError(
      "Generated CST reducer currently supports simple SELECT statements only",
      select.span?.start ?? 0,
      source,
    );
  }
  const resultNode = select.args[1];
  if (!isProduction(resultNode) || resultNode.name[0] !== "OptionallyAliasedExpr") {
    throw syntaxError("Malformed generated SELECT result", startOffset(select), source);
  }

  const aliasNode = findProductions(resultNode, "AliasedExpr")[0];
  const resultAlias = aliasNode
    ? allTerminals(findProductions(aliasNode, "Identifier")[0] ?? aliasNode).find(
        (token) => token.terminal === "IDENT",
      )?.text
    : undefined;
  const expressionNode = aliasNode
    ? productions(aliasNode).find((child) => child.name[0] === "Expr")
    : productions(resultNode)[0];
  if (!expressionNode) {
    throw syntaxError("SELECT is missing its result expression", startOffset(select), source);
  }
  const expr = reduceExpression(expressionNode, source, defaultModule);
  const filterNode = select.args[2];
  const filterExpr =
    isProduction(filterNode) && filterNode.name[1] !== "reduce_empty"
      ? reduceExpression(filterNode, source, defaultModule)
      : undefined;
  const order = reduceOrderBy(select.args[3], source, defaultModule);
  const pagination = reduceSelectLimit(select.args[4], source, defaultModule);
  const hasClauses = Boolean(filterExpr || order || hasPagination(pagination));
  const shapeProjection = expr.kind === "shape_projection" ? expr : undefined;
  let subject = shapeProjection?.expr ?? expr;

  if (subject.kind === "binding_ref" && hasClauses) {
    subject = {
      kind: "select",
      typeName: inModule(subject.name, defaultModule),
      shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
      clauses: {},
    };
  }

  const pos = offsetToLineCol(select.span?.start ?? 0, source);
  if (subject.kind === "select" && (shapeProjection || hasClauses)) {
    const shape = shapeProjection?.shape ?? subject.shape;
    const filter = filterExpr
      ? reduceSimpleFilter(filterExpr, source, startOffset(filterNode!))
      : undefined;
    const orderBy = order ? toSelectOrderExpr(order, subject.typeName) : undefined;
    const statement: SelectStatement = {
      kind: "select",
      typeName: subject.typeName,
      ...(resultAlias ? { resultAlias } : {}),
      shape,
      fields: shape.flatMap((element) => (element.kind === "field" ? [element.name] : [])),
      ...(filter ? { filter } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...pagination,
      pos,
    };
    return statement;
  }

  const orderBy = order ? toOrderExprChain(order) : undefined;
  if (filterExpr || hasPagination(pagination)) {
    return {
      kind: "select_expr",
      ...(resultAlias ? { resultAlias } : {}),
      expr: {
        kind: "select_expr_subquery",
        expr: subject,
        ...(filterExpr ? { filter: filterExpr } : {}),
        ...(orderBy ? { orderBy } : {}),
        ...pagination,
      },
      pos,
    } satisfies SelectExprStatement;
  }
  return {
    kind: "select_expr",
    ...(resultAlias ? { resultAlias } : {}),
    expr: subject,
    ...(orderBy ? { orderBy } : {}),
    pos,
  } satisfies SelectExprStatement;
};

const reduceExpression = (
  node: GelCSTNode,
  source: string,
  defaultModule: string,
): FreeObjectExpr => {
  if (node.kind !== "production") {
    throw syntaxError("Expected a generated EdgeQL expression", startOffset(node), source);
  }

  const [nonterminal, rule] = node.name;
  if (nonterminal === "BaseNumberConstant" && /ICONST|FCONST/.test(rule)) {
    const token = terminals(node)[0];
    if (!token) throw syntaxError("Missing numeric literal token", node.span?.start ?? 0, source);
    const value = Number(token.text.replace(/_/g, ""));
    if (!Number.isFinite(value))
      throw syntaxError(`Numeric literal out of range: ${token.text}`, token.span.start, source);
    return { kind: "literal", value, numericKind: /FCONST/.test(rule) ? "float" : "integer" };
  }

  if (nonterminal === "BaseStringConstant" && rule === "reduce_SCONST") {
    const token = terminals(node)[0];
    if (!token) throw syntaxError("Missing string literal token", node.span?.start ?? 0, source);
    return { kind: "literal", value: token.text };
  }

  if (nonterminal === "BaseBooleanConstant") {
    return { kind: "literal", value: /TRUE/.test(rule) };
  }

  if (nonterminal === "BaseAtomicExpr" && rule === "reduce_NodeName") {
    const identifiers = allTerminals(node).filter((token) => token.terminal === "IDENT");
    if (identifiers.length !== 1) {
      throw syntaxError(
        "Generated reducer currently supports unqualified name expressions only",
        node.span?.start ?? 0,
        source,
      );
    }
    const name = identifiers[0].text;
    return /^[A-Z]/.test(name)
      ? {
          kind: "select",
          typeName: inModule(name, defaultModule),
          shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
          clauses: {},
        }
      : { kind: "binding_ref", name };
  }

  if (nonterminal === "BaseAtomicExpr" && rule === "reduce_PathStep") {
    const field = allTerminals(node).find((token) => token.terminal === "IDENT")?.text;
    if (!field)
      throw syntaxError("Generated field path is missing its name", node.span?.start ?? 0, source);
    return { kind: "field_access", expr: { kind: "current_item" }, field, optional: false };
  }

  if (nonterminal === "Path" && rule === "reduce_Expr_PathStep") {
    const children = productions(node);
    if (children.length < 2)
      throw syntaxError("Malformed generated field path", node.span?.start ?? 0, source);
    const base = reduceExpression(children[0], source, defaultModule);
    const field = allTerminals(children[1]).find((token) => token.terminal === "IDENT")?.text;
    if (!field)
      throw syntaxError("Generated field path is missing its name", node.span?.start ?? 0, source);
    return { kind: "field_access", expr: base, field, optional: false };
  }

  if (nonterminal === "Expr" && rule === "reduce_Expr_Shape") {
    const children = productions(node);
    if (children.length < 2)
      throw syntaxError("Malformed generated shape expression", node.span?.start ?? 0, source);
    return {
      kind: "shape_projection",
      expr: reduceExpression(children[0], source, defaultModule),
      shape: reduceSimpleShape(children[1], source, defaultModule),
    };
  }

  if (nonterminal === "Expr" && rule === "reduce_Expr_CompareOp_Expr") {
    const operands = productions(node);
    const operator = terminals(node)[0]?.text;
    const validOperators = ["=", "!=", "<", "<=", ">", ">=", "?=", "?!=", "like", "ilike"];
    if (!operator || !validOperators.includes(operator) || operands.length < 2) {
      throw syntaxError(
        `Generated comparison production is not supported: ${rule}`,
        node.span?.start ?? 0,
        source,
      );
    }
    return {
      kind: "compare",
      op: operator as Extract<FreeObjectExpr, { kind: "compare" }>["op"],
      left: reduceExpression(operands[0], source, defaultModule),
      right: reduceExpression(operands[operands.length - 1], source, defaultModule),
    };
  }

  if (
    nonterminal === "Expr" &&
    (rule === "reduce_Expr_AND_Expr" || rule === "reduce_Expr_OR_Expr")
  ) {
    const operands = productions(node);
    if (operands.length < 2)
      throw syntaxError(`Malformed logical expression: ${rule}`, node.span?.start ?? 0, source);
    const kind = rule === "reduce_Expr_AND_Expr" ? "and" : "or";
    return {
      kind,
      left: reduceExpression(operands[0], source, defaultModule),
      right: reduceExpression(operands[operands.length - 1], source, defaultModule),
    };
  }

  if (nonterminal === "Expr" && /^reduce_Expr_.*_Expr$/.test(rule)) {
    const operands = productions(node);
    const operator = rule.slice("reduce_Expr_".length, -"_Expr".length);
    const arithmetic: Record<string, Extract<FreeObjectExpr, { kind: "math" }>["op"]> = {
      PLUS: "+",
      MINUS: "-",
      STAR: "*",
      SLASH: "/",
      FLOORDIV: "//",
      MODULO: "%",
      POW: "^",
    };
    const op = arithmetic[operator];
    if (!op || operands.length < 2) {
      throw syntaxError(
        `Generated expression production is not supported: ${rule}`,
        node.span?.start ?? 0,
        source,
      );
    }
    return {
      kind: "math",
      op,
      left: reduceExpression(operands[0], source, defaultModule),
      right: reduceExpression(operands[operands.length - 1], source, defaultModule),
    };
  }

  if (nonterminal === "Expr" && /Paren/.test(rule)) {
    const child = productions(node)[0];
    if (child) return reduceExpression(child, source, defaultModule);
  }

  if (nonterminal === "OptionallyAliasedExpr" && rule === "reduce_Expr") {
    const child = productions(node)[0];
    if (child) return reduceExpression(child, source, defaultModule);
  }

  throw syntaxError(
    `Generated expression production is not supported: ${nonterminal}.${rule}`,
    node.span?.start ?? 0,
    source,
  );
};

/**
 * Reduce supported SELECT productions from Gel's generated CST into the
 * compiler's existing AST. Unsupported productions fail explicitly instead
 * of silently falling back to another parser.
 */
export function reduceGelGrammarCST(
  cst: GelCSTNode,
  source: string,
  defaultModule = "default",
): Statement {
  const statements = topLevelStatements(cst);
  if (statements.length !== 1 || statements[0]?.name[0] !== "ExprStmtSimpleCore") {
    throw syntaxError(
      "Generated CST reducer currently supports simple SELECT statements only",
      startOffset(cst),
      source,
    );
  }
  return reduceSelectNode(statements[0], source, defaultModule);
}

export function parseGelGrammarStatement(source: string, defaultModule = "default"): Statement {
  const cst = parseGelGrammarCST(source);
  if (!cst) throw syntaxError("Input is not accepted by Gel's generated EdgeQL grammar", 0, source);
  return reduceGelGrammarCST(cst, source, defaultModule);
}

export function parseGelGrammarScript(source: string, defaultModule = "default"): Statement[] {
  const cst = parseGelGrammarCST(source);
  if (!cst) throw syntaxError("Input is not accepted by Gel's generated EdgeQL grammar", 0, source);
  return topLevelStatements(cst).map((statement) => {
    if (statement.name[0] !== "ExprStmtSimpleCore") {
      throw syntaxError(
        "Generated CST reducer currently supports simple SELECT statements only",
        startOffset(statement),
        source,
      );
    }
    return reduceSelectNode(statement, source, defaultModule);
  });
}
