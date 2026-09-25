import { AppError } from "../errors.js";
import type { FilterExpr, FreeObjectExpr, SelectExprStatement, SelectStatement, ShapeElement, Statement } from "./ast.js";
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
  const matches = node.name[0] === productionName && (!ruleName || node.name[1] === ruleName) ? [node] : [];
  return [...matches, ...productions(node).flatMap((child) => findProductions(child, productionName, ruleName))];
};

const terminals = (node: GelCSTNode): Array<Extract<GelCSTNode, { kind: "terminal" }>> =>
  node.kind === "production"
    ? node.args.flatMap((arg) => arg.kind === "terminal" ? [arg] : [])
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

const startOffset = (node: GelCSTNode): number => node.kind === "production"
  ? node.span?.start ?? 0
  : node.kind === "terminal" ? node.span.start : 0;

const reduceSimpleShape = (node: GelCSTNode, source: string): ShapeElement[] => {
  const topLevelElements = (current: GelCSTNode): GelCSTProduction[] => {
    if (current.kind !== "production") return [];
    if (current.name[0] === "ShapeElement") return [current];
    return productions(current).flatMap(topLevelElements);
  };
  const elements = topLevelElements(node);
  return elements.map((element) => {
    if (element.name[1] !== "reduce_ShapeElementWithSubShape") {
      throw syntaxError("Generated shape reducer currently supports plain field entries only",
        element.span?.start ?? 0, source);
    }
    const unsupportedOptions = ["OptAnySubShape", "OptFilterClause", "OptSortClause", "OptSelectLimit"]
      .flatMap((name) => findProductions(element, name))
      .filter((option) => option.name[1] !== "reduce_empty");
    if (unsupportedOptions.length > 0
        || findProductions(element, "ShapeElementList").length > 0
        || findProductions(element, "OptTypeIntersection").some((option) => option.name[1] !== "reduce_empty")) {
      throw syntaxError("Generated shape reducer currently supports plain field entries only",
        element.span?.start ?? 0, source);
    }
    const pointer = productions(element)[0];
    const pointerTokens = pointer ? allTerminals(pointer) : [];
    const name = pointerTokens.length === 1 && pointerTokens[0]?.terminal === "IDENT"
      ? pointerTokens[0].text
      : undefined;
    if (!name) throw syntaxError("Generated shape entry is missing its field name", element.span?.start ?? 0, source);
    return { kind: "field", name, operation: "assign", origin: "explicit" };
  });
};

const reduceSimpleFilter = (expr: FreeObjectExpr, source: string, offset: number): FilterExpr => {
  if (expr.kind === "compare"
      && expr.left.kind === "field_access"
      && expr.left.expr.kind === "current_item"
      && expr.right.kind === "literal") {
    return {
      kind: "predicate",
      target: { kind: "field", field: expr.left.field },
      op: expr.op as Extract<FilterExpr, { kind: "predicate" }>["op"],
      value: expr.right.value,
    };
  }
  throw syntaxError("Generated CST reducer currently supports field-to-literal filters only", offset, source);
};

const reduceExpression = (node: GelCSTNode, source: string, defaultModule: string): FreeObjectExpr => {
  if (node.kind !== "production") {
    throw syntaxError("Expected a generated EdgeQL expression", startOffset(node), source);
  }

  const [nonterminal, rule] = node.name;
  if (nonterminal === "BaseNumberConstant" && /ICONST|FCONST/.test(rule)) {
    const token = terminals(node)[0];
    if (!token) throw syntaxError("Missing numeric literal token", node.span?.start ?? 0, source);
    const value = Number(token.text.replace(/_/g, ""));
    if (!Number.isFinite(value)) throw syntaxError(`Numeric literal out of range: ${token.text}`, token.span.start, source);
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
      throw syntaxError("Generated reducer currently supports unqualified name expressions only",
        node.span?.start ?? 0, source);
    }
    const name = identifiers[0]!.text;
    return /^[A-Z]/.test(name)
      ? { kind: "select", typeName: `${defaultModule}::${name}`,
          shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }], clauses: {} }
      : { kind: "binding_ref", name };
  }

  if (nonterminal === "BaseAtomicExpr" && rule === "reduce_PathStep") {
    const field = allTerminals(node).find((token) => token.terminal === "IDENT")?.text;
    if (!field) throw syntaxError("Generated field path is missing its name", node.span?.start ?? 0, source);
    return { kind: "field_access", expr: { kind: "current_item" }, field, optional: false };
  }

  if (nonterminal === "Path" && rule === "reduce_Expr_PathStep") {
    const children = productions(node);
    if (children.length < 2) throw syntaxError("Malformed generated field path", node.span?.start ?? 0, source);
    const base = reduceExpression(children[0]!, source, defaultModule);
    const field = allTerminals(children[1]!).find((token) => token.terminal === "IDENT")?.text;
    if (!field) throw syntaxError("Generated field path is missing its name", node.span?.start ?? 0, source);
    return { kind: "field_access", expr: base, field, optional: false };
  }

  if (nonterminal === "Expr" && rule === "reduce_Expr_Shape") {
    const children = productions(node);
    if (children.length < 2) throw syntaxError("Malformed generated shape expression", node.span?.start ?? 0, source);
    return {
      kind: "shape_projection",
      expr: reduceExpression(children[0]!, source, defaultModule),
      shape: reduceSimpleShape(children[1]!, source),
    };
  }

  if (nonterminal === "Expr" && rule === "reduce_Expr_CompareOp_Expr") {
    const operands = productions(node);
    const operator = terminals(node)[0]?.text;
    const validOperators = ["=", "!=", "<", "<=", ">", ">=", "?=", "?!=", "like", "ilike"];
    if (!operator || !validOperators.includes(operator) || operands.length < 2) {
      throw syntaxError(`Generated comparison production is not supported: ${rule}`, node.span?.start ?? 0, source);
    }
    return {
      kind: "compare", op: operator as Extract<FreeObjectExpr, { kind: "compare" }>["op"],
      left: reduceExpression(operands[0]!, source, defaultModule),
      right: reduceExpression(operands.at(-1)!, source, defaultModule),
    };
  }

  if (nonterminal === "Expr" && (rule === "reduce_Expr_AND_Expr" || rule === "reduce_Expr_OR_Expr")) {
    const operands = productions(node);
    if (operands.length < 2) throw syntaxError(`Malformed logical expression: ${rule}`, node.span?.start ?? 0, source);
    const kind = rule === "reduce_Expr_AND_Expr" ? "and" : "or";
    return {
      kind,
      left: reduceExpression(operands[0]!, source, defaultModule),
      right: reduceExpression(operands.at(-1)!, source, defaultModule),
    };
  }

  if (nonterminal === "Expr" && /^reduce_Expr_.*_Expr$/.test(rule)) {
    const operands = productions(node);
    const operator = rule.slice("reduce_Expr_".length, -"_Expr".length);
    const arithmetic: Record<string, Extract<FreeObjectExpr, { kind: "math" }>["op"]> = {
      PLUS: "+", MINUS: "-", STAR: "*", SLASH: "/", FLOORDIV: "//", MODULO: "%", POW: "^",
    };
    const op = arithmetic[operator];
    if (!op || operands.length < 2) {
      throw syntaxError(`Generated expression production is not supported: ${rule}`, node.span?.start ?? 0, source);
    }
    return {
      kind: "math", op,
      left: reduceExpression(operands[0], source, defaultModule),
      right: reduceExpression(operands.at(-1)!, source, defaultModule),
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

  throw syntaxError(`Generated expression production is not supported: ${nonterminal}.${rule}`,
    node.span?.start ?? 0, source);
};

/**
 * Reduce the first vertical slice of Gel's generated CST into the compiler's
 * existing AST: SELECT of literals, arithmetic, and parenthesized expressions.
 * Unsupported generated productions fail explicitly instead of falling back
 * to the handwritten parser.
 */
export function reduceGelGrammarCST(cst: GelCSTNode, source: string, defaultModule = "default"): Statement {
  const selects = findProductions(cst, "ExprStmtSimpleCore", "reduce_Select");
  if (selects.length !== 1) {
    throw syntaxError("Generated CST reducer currently supports simple SELECT statements only",
      startOffset(cst), source);
  }
  const select = selects[0]!;

  const resultNode = select.args[1];
  if (resultNode?.kind !== "production"
      || resultNode.name[0] !== "OptionallyAliasedExpr"
      || resultNode.name[1] !== "reduce_Expr") {
    throw syntaxError("Generated CST reducer does not yet support SELECT result aliases", startOffset(select), source);
  }
  const unsupportedClauses = select.args.slice(3).filter(isProduction)
    .filter((clause) => clause.name[1] !== "reduce_empty");
  if (unsupportedClauses.length > 0) {
    throw syntaxError("Generated CST reducer does not yet support SELECT clauses", startOffset(select), source);
  }

  const expressionRoot = productions(resultNode)[0];
  if (!expressionRoot) throw syntaxError("SELECT is missing its result expression", select.span?.start ?? 0, source);
  const expr = reduceExpression(expressionRoot, source, defaultModule);
  const pos = offsetToLineCol(select.span?.start ?? 0, source);
  const filterNode = select.args[2];
  const filterExpr = isProduction(filterNode) && filterNode.name[1] !== "reduce_empty"
    ? reduceExpression(filterNode, source, defaultModule)
    : undefined;
  const filter = filterExpr ? reduceSimpleFilter(filterExpr, source, startOffset(filterNode!)) : undefined;
  const sortNode = select.args[3];
  const limitNode = select.args[4];
  if (isProduction(sortNode) && sortNode.name[1] !== "reduce_empty"
      || isProduction(limitNode) && limitNode.name[1] !== "reduce_empty") {
    throw syntaxError("Generated CST reducer does not yet support ORDER BY, OFFSET, or LIMIT",
      startOffset(select), source);
  }
  const subject = expr.kind === "shape_projection" ? expr.expr : expr;
  const shape = expr.kind === "shape_projection" && expr.expr.kind === "select"
    ? expr.shape
    : subject.kind === "select" ? subject.shape : undefined;
  if (subject.kind === "select" && (expr.kind === "shape_projection" || filter)) {
    const statement: SelectStatement = {
      kind: "select", typeName: subject.typeName, shape: shape!,
      fields: shape!.flatMap((element) => element.kind === "field" ? [element.name] : []),
      ...(filter ? { filter } : {}),
      pos,
    };
    return statement;
  }
  return { kind: "select_expr", expr, pos } satisfies SelectExprStatement;
}

export function parseGelGrammarStatement(source: string, defaultModule = "default"): Statement {
  const cst = parseGelGrammarCST(source);
  if (!cst) throw syntaxError("Input is not accepted by Gel's generated EdgeQL grammar", 0, source);
  return reduceGelGrammarCST(cst, source, defaultModule);
}
