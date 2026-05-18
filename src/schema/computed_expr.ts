import { parseEdgeQL } from "../edgeql/parser.js";
import type { FreeObjectExpr } from "../edgeql/ast.js";
import type { ComputedDef, ScalarValue } from "../types.js";

type ComputedPropertyExpr = Extract<ComputedDef, { kind: "property" }>["expr"];
type ComputedSetLiteralExpr = Extract<ComputedPropertyExpr, { kind: "set_literal" }>;

const scalarValueFromExpr = (expr: FreeObjectExpr): ScalarValue | undefined => {
  if (expr.kind === "literal") {
    return expr.value;
  }

  if (expr.kind === "cast") {
    return scalarValueFromExpr(expr.expr);
  }

  return undefined;
};

const scalarValuesFromSetExpr = (expr: FreeObjectExpr): ScalarValue[] | undefined => {
  if (expr.kind === "set_literal") {
    return [...expr.values];
  }

  if (expr.kind !== "set_expr") {
    return undefined;
  }

  const values: ScalarValue[] = [];
  for (const valueExpr of expr.values) {
    const value = scalarValueFromExpr(valueExpr);
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  return values;
};

export const parseComputedSetLiteralExpr = (text: string): ComputedSetLiteralExpr | undefined => {
  let statement;
  try {
    statement = parseEdgeQL(`select ${text}`);
  } catch {
    return undefined;
  }

  if (statement.kind !== "select_expr") {
    return undefined;
  }

  const values = scalarValuesFromSetExpr(statement.expr);
  return values === undefined ? undefined : { kind: "set_literal", values };
};
