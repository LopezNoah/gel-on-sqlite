import type { ScalarValue } from "../types.js";

/** Identity of one SQL range variable. The printable alias is deliberately not identity. */
export interface SqlBinding {
  readonly id: symbol;
  readonly alias: string;
}

export const sqlBinding = (alias: string, debugName = alias): SqlBinding => ({
  id: Symbol(debugName),
  alias,
});

export type SqlBinaryOperator =
  | "="
  | "!="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "||"
  | "AND"
  | "OR"
  | "IS"
  | "IS NOT"
  | "IN"
  | "NOT IN";

export type SqlUnaryOperator = "NOT" | "-" | "+";

export type SqlExpr =
  | { readonly kind: "column"; readonly binding: SqlBinding; readonly name: string }
  | { readonly kind: "parameter"; readonly value: ScalarValue }
  | { readonly kind: "literal"; readonly value: ScalarValue }
  | { readonly kind: "binary"; readonly operator: SqlBinaryOperator; readonly left: SqlExpr; readonly right: SqlExpr }
  | { readonly kind: "unary"; readonly operator: SqlUnaryOperator; readonly operand: SqlExpr }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly SqlExpr[] }
  | { readonly kind: "case"; readonly branches: readonly SqlCaseBranch[]; readonly otherwise: SqlExpr }
  | { readonly kind: "scalar_subquery"; readonly query: SqlQuery }
  | { readonly kind: "exists"; readonly query: SqlQuery; readonly negated?: boolean }
  | { readonly kind: "star"; readonly binding?: SqlBinding }
  | SqlLegacyExpr;

export interface SqlCaseBranch {
  readonly when: SqlExpr;
  readonly then: SqlExpr;
}

/**
 * Explicit migration adapter for a fragment still emitted by a legacy lowering.
 * Its SQL references are not inspectable by the AST scope validator.
 */
export interface SqlLegacyExpr {
  readonly kind: "legacy_expr";
  readonly sql: string;
  readonly params: readonly ScalarValue[];
  readonly reason: string;
}

export type SqlQuery = SqlSelect | SqlCompoundSelect;

export interface SqlSelect {
  readonly kind: "select";
  readonly distinct?: boolean;
  readonly projections: readonly SqlProjection[];
  readonly from?: readonly SqlFromItem[];
  readonly where?: SqlExpr;
  readonly groupBy?: readonly SqlExpr[];
  readonly having?: SqlExpr;
  readonly orderBy?: readonly SqlOrder[];
  readonly limit?: SqlExpr;
  readonly offset?: SqlExpr;
}

export interface SqlCompoundSelect {
  readonly kind: "compound_select";
  readonly operator: "UNION ALL";
  readonly branches: readonly SqlQuery[];
}

export interface SqlProjection {
  readonly expr: SqlExpr;
  readonly alias?: string;
}

export interface SqlOrder {
  readonly expr: SqlExpr;
  readonly direction: "ASC" | "DESC";
  readonly nulls?: "FIRST" | "LAST";
}

export interface SqlFromItem {
  readonly source: SqlSource;
  /** Omitted for the first FROM item; required for subsequent items. */
  readonly join?: SqlJoin;
}

export interface SqlJoin {
  readonly kind: "cross" | "inner" | "left";
  readonly on?: SqlExpr;
}

export type SqlSource = SqlTableSource | SqlDerivedSource | SqlLegacySource;

export interface SqlTableSource {
  readonly kind: "table";
  readonly name: string;
  readonly binding: SqlBinding;
  /** Optional schema knowledge used to validate column references. */
  readonly columns?: readonly string[];
}

export interface SqlDerivedSource {
  readonly kind: "derived";
  readonly query: SqlQuery;
  readonly binding: SqlBinding;
}

/**
 * Explicit migration adapter for a FROM source still emitted as SQL text.
 * `columns` records the derived range's exported names when they are known.
 */
export interface SqlLegacySource {
  readonly kind: "legacy_source";
  readonly sql: string;
  readonly params: readonly ScalarValue[];
  readonly reason: string;
  readonly binding: SqlBinding;
  readonly columns?: readonly string[];
}

export const sql = {
  column: (binding: SqlBinding, name: string): SqlExpr => ({ kind: "column", binding, name }),
  parameter: (value: ScalarValue): SqlExpr => ({ kind: "parameter", value }),
  literal: (value: ScalarValue): SqlExpr => ({ kind: "literal", value }),
  binary: (operator: SqlBinaryOperator, left: SqlExpr, right: SqlExpr): SqlExpr => ({
    kind: "binary",
    operator,
    left,
    right,
  }),
  unary: (operator: SqlUnaryOperator, operand: SqlExpr): SqlExpr => ({
    kind: "unary",
    operator,
    operand,
  }),
  call: (name: string, ...args: SqlExpr[]): SqlExpr => ({ kind: "call", name, args }),
  case: (branches: readonly SqlCaseBranch[], otherwise: SqlExpr): SqlExpr => ({
    kind: "case",
    branches,
    otherwise,
  }),
  scalarSubquery: (query: SqlQuery): SqlExpr => ({ kind: "scalar_subquery", query }),
  exists: (query: SqlQuery, negated = false): SqlExpr => ({ kind: "exists", query, negated }),
  star: (binding?: SqlBinding): SqlExpr => ({ kind: "star", binding }),
  legacyExpr: (
    sqlText: string,
    reason: string,
    params: readonly ScalarValue[] = [],
  ): SqlLegacyExpr => ({ kind: "legacy_expr", sql: sqlText, params, reason }),
  table: (
    name: string,
    binding: SqlBinding,
    columns?: readonly string[],
  ): SqlTableSource => ({ kind: "table", name, binding, columns }),
  derived: (query: SqlQuery, binding: SqlBinding): SqlDerivedSource => ({
    kind: "derived",
    query,
    binding,
  }),
  legacySource: (
    sqlText: string,
    binding: SqlBinding,
    reason: string,
    params: readonly ScalarValue[] = [],
    columns?: readonly string[],
  ): SqlLegacySource => ({ kind: "legacy_source", sql: sqlText, params, reason, binding, columns }),
  select: (args: Omit<SqlSelect, "kind">): SqlSelect => ({ kind: "select", ...args }),
  unionAll: (...branches: SqlQuery[]): SqlCompoundSelect => ({
    kind: "compound_select",
    operator: "UNION ALL",
    branches,
  }),
};
