import { quoteIdent, quoteLiteral } from "../codegen/sql.js";
import type { ScalarValue } from "../types.js";
import type {
  SqlBinding,
  SqlExpr,
  SqlFromItem,
  SqlQuery,
  SqlSelect,
  SqlSource,
} from "./sql_ast.js";

export interface RenderedSql {
  sql: string;
  params: ScalarValue[];
}

export class SqlAstValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlAstValidationError";
  }
}

interface BindingInfo {
  binding: SqlBinding;
  /** undefined means the source's columns are intentionally unknown. */
  columns?: ReadonlySet<string>;
}

type Scope = Map<symbol, BindingInfo>;

const cloneScope = (scope: Scope): Scope => new Map(scope);

const columnsForSource = (source: SqlSource): ReadonlySet<string> | undefined => {
  if (source.kind === "table") {
    return source.columns === undefined ? undefined : new Set(source.columns);
  }
  if (source.kind === "legacy_source") {
    return source.columns === undefined ? undefined : new Set(source.columns);
  }
  const names = queryProjectionNames(source.query);
  return names === undefined ? undefined : new Set(names);
};

const queryProjectionNames = (query: SqlQuery): string[] | undefined => {
  if (query.kind === "select") {
    if (query.projections.some((projection) => projection.alias === undefined)) return undefined;
    return query.projections.map((projection) => projection.alias!);
  }
  const first = query.branches[0];
  return first ? queryProjectionNames(first) : [];
};

const queryProjectionCount = (query: SqlQuery): number => {
  if (query.kind === "select") return query.projections.length;
  return query.branches[0] ? queryProjectionCount(query.branches[0]) : 0;
};

const validateQuery = (query: SqlQuery, outerScope: Scope = new Map()): void => {
  if (query.kind === "compound_select") {
    if (query.branches.length === 0) {
      throw new SqlAstValidationError("A compound SELECT must contain at least one branch");
    }
    let expectedWidth: number | undefined;
    for (const branch of query.branches) {
      validateQuery(branch, outerScope);
      const width = queryProjectionCount(branch);
      if (expectedWidth !== undefined && width !== expectedWidth) {
        throw new SqlAstValidationError(
          `UNION ALL branches project different column counts (${expectedWidth} and ${width})`,
        );
      }
      expectedWidth = width;
    }
    return;
  }

  validateSelect(query, outerScope);
};

const validateSelect = (select: SqlSelect, outerScope: Scope): void => {
  if (select.projections.length === 0) {
    throw new SqlAstValidationError("A SELECT must project at least one expression");
  }

  const localScope = cloneScope(outerScope);
  const localAliases = new Set<string>();
  const availableToJoin = cloneScope(outerScope);

  for (let index = 0; index < (select.from?.length ?? 0); index += 1) {
    const item = select.from![index];
    if (index === 0 && item.join) {
      throw new SqlAstValidationError("The first FROM item cannot have a JOIN kind");
    }
    const binding = item.source.binding;
    if (localAliases.has(binding.alias)) {
      throw new SqlAstValidationError(`Duplicate range-variable alias '${binding.alias}'`);
    }
    localAliases.add(binding.alias);

    // A derived table is not LATERAL: it may correlate to an enclosing query,
    // but it cannot capture a sibling FROM item in this SELECT.
    if (item.source.kind === "derived") validateQuery(item.source.query, outerScope);

    const bindingInfo: BindingInfo = {
      binding,
      columns: columnsForSource(item.source),
    };
    if (availableToJoin.has(binding.id)) {
      throw new SqlAstValidationError(`Range-variable binding '${binding.alias}' is declared twice`);
    }
    availableToJoin.set(binding.id, bindingInfo);
    localScope.set(binding.id, bindingInfo);

    if (index > 0) {
      const join = item.join;
      if (join?.kind === "cross" && join.on) {
        throw new SqlAstValidationError("CROSS JOIN cannot have an ON expression");
      }
      if (join && join.kind !== "cross" && !join.on) {
        throw new SqlAstValidationError(`${join.kind.toUpperCase()} JOIN requires an ON expression`);
      }
      if (join?.on) validateExpr(join.on, availableToJoin);
    }
  }

  const expressionScope = select.from?.length ? localScope : outerScope;
  for (const projection of select.projections) validateExpr(projection.expr, expressionScope);
  if (select.where) validateExpr(select.where, expressionScope);
  for (const expr of select.groupBy ?? []) validateExpr(expr, expressionScope);
  if (select.having) validateExpr(select.having, expressionScope);
  for (const order of select.orderBy ?? []) validateExpr(order.expr, expressionScope);
  if (select.limit) validateExpr(select.limit, expressionScope);
  if (select.offset) validateExpr(select.offset, expressionScope);
};

const validateExpr = (expr: SqlExpr, scope: Scope): void => {
  switch (expr.kind) {
    case "column": {
      const info = scope.get(expr.binding.id);
      if (!info) {
        throw new SqlAstValidationError(
          `Column '${expr.binding.alias}.${expr.name}' references a range variable outside its scope`,
        );
      }
      if (info.columns && !info.columns.has(expr.name)) {
        throw new SqlAstValidationError(
          `Column '${expr.binding.alias}.${expr.name}' is not exported by its source`,
        );
      }
      return;
    }
    case "parameter":
    case "literal":
    case "legacy_expr":
    case "star":
      if (expr.kind === "star" && expr.binding && !scope.has(expr.binding.id)) {
        throw new SqlAstValidationError(
          `Star projection for '${expr.binding.alias}' references a range variable outside its scope`,
        );
      }
      return;
    case "binary":
      validateExpr(expr.left, scope);
      validateExpr(expr.right, scope);
      return;
    case "unary":
      validateExpr(expr.operand, scope);
      return;
    case "call":
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr.name)) {
        throw new SqlAstValidationError(`Invalid SQL function name '${expr.name}'`);
      }
      for (const arg of expr.args) validateExpr(arg, scope);
      return;
    case "case":
      for (const branch of expr.branches) {
        validateExpr(branch.when, scope);
        validateExpr(branch.then, scope);
      }
      validateExpr(expr.otherwise, scope);
      return;
    case "scalar_subquery":
      validateQuery(expr.query, scope);
      return;
    case "exists":
      validateQuery(expr.query, scope);
      return;
    default: {
      const exhaustive: never = expr;
      throw new SqlAstValidationError(`Unsupported SQL expression ${(exhaustive as { kind: string }).kind}`);
    }
  }
};

export const validateSqlAst = (query: SqlQuery): void => validateQuery(query);

export const renderSqlAst = (query: SqlQuery): RenderedSql => {
  validateSqlAst(query);
  const params: ScalarValue[] = [];
  return { sql: renderQuery(query, params), params };
};

/** Render an expression fragment without query-scope validation. */
export const renderSqlExpr = (expr: SqlExpr): RenderedSql => {
  const params: ScalarValue[] = [];
  return { sql: renderExpr(expr, params), params };
};

const renderQuery = (query: SqlQuery, params: ScalarValue[]): string => {
  if (query.kind === "compound_select") {
    return query.branches.map((branch) => renderQuery(branch, params)).join(` ${query.operator} `);
  }
  return renderSelect(query, params);
};

const renderSelect = (select: SqlSelect, params: ScalarValue[]): string => {
  const projections = select.projections
    .map(({ expr, alias }) =>
      alias === undefined
        ? renderExpr(expr, params)
        : `${renderExpr(expr, params)} AS ${quoteIdent(alias)}`,
    )
    .join(", ");
  let text = `SELECT${select.distinct ? " DISTINCT" : ""} ${projections}`;

  if (select.from?.length) {
    text += ` FROM ${renderFromItem(select.from[0], params)}`;
    for (const item of select.from.slice(1)) {
      const join = item.join ?? { kind: "cross" as const };
      const source = renderSource(item.source, params);
      if (join.kind === "cross") {
        text += ` CROSS JOIN ${source}`;
      } else {
        text += ` ${join.kind === "left" ? "LEFT JOIN" : "JOIN"} ${source} ON ${renderExpr(join.on!, params)}`;
      }
    }
  }

  if (select.where) text += ` WHERE ${renderExpr(select.where, params)}`;
  if (select.groupBy?.length) {
    text += ` GROUP BY ${select.groupBy.map((expr) => renderExpr(expr, params)).join(", ")}`;
  }
  if (select.having) text += ` HAVING ${renderExpr(select.having, params)}`;
  if (select.orderBy?.length) {
    text += ` ORDER BY ${select.orderBy
      .map(({ expr, direction, nulls }) =>
        `${renderExpr(expr, params)} ${direction}${nulls ? ` NULLS ${nulls}` : ""}`,
      )
      .join(", ")}`;
  }
  if (select.limit) text += ` LIMIT ${renderExpr(select.limit, params)}`;
  if (select.offset) text += ` OFFSET ${renderExpr(select.offset, params)}`;
  return text;
};

const renderFromItem = (item: SqlFromItem, params: ScalarValue[]): string => {
  if (item.join) throw new SqlAstValidationError("The first FROM item cannot have a JOIN kind");
  return renderSource(item.source, params);
};

const renderSource = (source: SqlSource, params: ScalarValue[]): string => {
  switch (source.kind) {
    case "table":
      return `${quoteIdent(source.name)} ${quoteIdent(source.binding.alias)}`;
    case "derived":
      return `(${renderQuery(source.query, params)}) ${quoteIdent(source.binding.alias)}`;
    case "legacy_source":
      params.push(...source.params);
      return `${source.sql} ${quoteIdent(source.binding.alias)}`;
  }
};

const renderExpr = (expr: SqlExpr, params: ScalarValue[]): string => {
  switch (expr.kind) {
    case "column":
      return `${quoteIdent(expr.binding.alias)}.${quoteIdent(expr.name)}`;
    case "parameter":
      params.push(expr.value);
      return "?";
    case "literal":
      return quoteLiteral(expr.value);
    case "binary":
      return `(${renderExpr(expr.left, params)} ${expr.operator} ${renderExpr(expr.right, params)})`;
    case "unary":
      return `(${expr.operator} ${renderExpr(expr.operand, params)})`;
    case "call":
      return `${expr.name}(${expr.args.map((arg) => renderExpr(arg, params)).join(", ")})`;
    case "case":
      return (
        `CASE ${expr.branches
          .map(({ when, then }) => `WHEN ${renderExpr(when, params)} THEN ${renderExpr(then, params)}`)
          .join(" ")} ELSE ${renderExpr(expr.otherwise, params)} END`
      );
    case "scalar_subquery":
      return `(${renderQuery(expr.query, params)})`;
    case "exists":
      return `${expr.negated ? "NOT " : ""}EXISTS (${renderQuery(expr.query, params)})`;
    case "star":
      return expr.binding ? `${quoteIdent(expr.binding.alias)}.*` : "*";
    case "legacy_expr":
      params.push(...expr.params);
      return expr.sql;
  }
};
