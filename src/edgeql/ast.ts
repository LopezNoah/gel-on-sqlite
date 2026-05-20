import type { ScalarType, ScalarValue } from "../types.js";

export interface SourcePos {
  line: number;
  column: number;
}

export type TypeExpr =
  | { kind: "type_name"; name: string }
  | { kind: "type_union"; left: TypeExpr; right: TypeExpr }
  | { kind: "type_intersection"; left: TypeExpr; right: TypeExpr };

export const simpleTypeName = (expr: TypeExpr | undefined): string | undefined =>
  expr && expr.kind === "type_name" ? expr.name : undefined;

export type PathStep =
  | {
      kind: "object_ref";
      name: string;
    }
  | {
      kind: "ptr";
      name: string;
      direction?: "outbound" | "inbound";
      typeFilter?: string;
      typeFilterExpr?: TypeExpr;
      optional?: boolean;
    }
  | {
      kind: "type_intersection";
      typeName: string;
      typeExpr?: TypeExpr;
    }
  | {
      kind: "splat";
      depth: 1 | 2;
      typeName?: string;
      intersectionTypeName?: string;
      typeExpr?: TypeExpr;
      intersectionTypeExpr?: TypeExpr;
    };

export interface ShapeElementModifiers {
  cardinality?: "one" | "many" | "unknown";
  required?: boolean;
  operation?: "assign" | "append" | "subtract" | "materialize";
  origin?: "explicit" | "default" | "splat_expansion" | "materialization";
  where?: FreeObjectExpr;
  orderBy?: OrderExpr[];
  offset?: number;
  limit?: number;
}

export type FilterTarget =
  | {
      kind: "field";
      field: string;
    }
  | {
      kind: "backlink";
      link: string;
      sourceType?: string;
    }
  | {
      kind: "backlink_property";
      link: string;
      sourceType?: string;
      property: string;
    };

export type FilterValue =
  | ScalarValue
  | {
      kind: "binding_ref";
      name: string;
    }
  | {
      kind: "field_ref";
      field: string;
    }
  | {
      kind: "backlink_property_ref";
      link: string;
      sourceType?: string;
      property: string;
    }
  | SetLiteralValue;

export type FilterExpr =
  | {
      kind: "predicate";
      target: FilterTarget;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
      value: FilterValue;
    }
  | {
      kind: "in_predicate";
      target: FilterTarget;
      op: "in" | "not_in";
      values:
        | SetLiteralValue
        | {
            kind: "select";
            query: {
              typeName: string;
              shape: ShapeElement[];
              clauses: ClauseChain;
            };
          }
        | {
            kind: "name";
            name: string;
          }
        | {
            kind: "backlink_property_ref";
            link: string;
            sourceType?: string;
            property: string;
          };
    }
  | {
      kind: "and";
      left: FilterExpr;
      right: FilterExpr;
    }
  | {
      kind: "or";
      left: FilterExpr;
      right: FilterExpr;
    }
  | {
      kind: "not";
      expr: FilterExpr;
    }
  | {
      kind: "free_expr";
      expr: FreeObjectExpr;
    };

export interface WithBinding {
  name: string;
  value: WithBindingValue;
}

export interface SetLiteralValue {
  kind: "set_literal";
  values: ScalarValue[];
}

export interface ArrayLiteralValue {
  kind: "array_literal";
  values: ScalarValue[];
}

export interface TupleLiteralValue {
  kind: "tuple_literal";
  values: ScalarValue[] | Record<string, ScalarValue>;
}

export type WithBindingValue =
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | SetLiteralValue
  | ArrayLiteralValue
  | {
      kind: "binding_ref";
      name: string;
    }
  | {
      kind: "parameter";
      name: string;
      castType?: ScalarType;
    }
  | {
      kind: "subquery";
      query: {
        typeName: string;
        shape: ShapeElement[];
        clauses: ClauseChain;
      };
    }
  | {
      kind: "subquery_statement";
      statement: Statement;
    }
  | {
      kind: "subquery_expr";
      expr: FreeObjectExpr;
    }
  | {
      kind: "enum_path";
      enumType: string;
      member: string;
    }
  | {
      kind: "path";
      head: string;
      tail: string;
      steps?: PathStep[];
    }
  | {
      kind: "path_chain";
      parts: string[];
      steps?: PathStep[];
    }
  | {
      kind: "backlink_path";
      head: string;
      link: string;
      sourceType?: string;
      sourceTypeExpr?: TypeExpr;
    };

export interface WithModuleAlias {
  alias: string;
  module: string;
}

export interface OrderExpr {
  field: string;
  direction: "asc" | "desc";
  nullsPosition?: "first" | "last";
  then?: OrderExpr;
}

export interface ClauseChain {
  filter?: FilterExpr;
  orderBy?: OrderExpr;
  limit?: number;
  offset?: number;
  groupBy?: FreeObjectExpr[];
  using?: Record<string, FreeObjectExpr>;
  window?: {
    partitionBy?: FreeObjectExpr[];
    orderBy?: OrderExpr[];
  };
  _withBindings?: WithBinding[];
  _withModule?: string;
  _withModuleAliases?: WithModuleAlias[];
}

export type ComputedExpr =
  | {
      kind: "field_ref";
      field: string;
    }
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | {
      kind: "polymorphic_field_ref";
      sourceType: string;
      sourceTypeExpr?: TypeExpr;
      field: string;
    }
  | {
      kind: "type_name";
    }
  | {
      kind: "subquery";
      typeName: string;
      shape: ShapeElement[];
      clauses: ClauseChain;
    }
  | {
      kind: "select_expr";
      expr: FreeObjectExpr;
      clauses: ClauseChain;
    }
  | {
      kind: "function_call";
      call: FunctionCallExpr;
    }
  | {
      kind: "binding_ref";
      name: string;
    }
  | {
      kind: "field_suffix_math";
      field: string;
      fromEnd: number;
      op: "negate" | "const_minus";
      constant?: number;
    }
  | {
      kind: "parameter";
      name: string;
      castType?: string;
    }
  | {
      kind: "global_ref";
      name: string;
    }
  | {
      kind: "type_intersection";
      sourceType: string;
      sourceTypeExpr?: TypeExpr;
      expr: FreeObjectExpr;
    };

export interface BacklinkExpr {
  link: string;
  sourceType?: string;
  sourceTypeExpr?: TypeExpr;
}

export type FunctionCallArgExpr =
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | {
      kind: "field_ref";
      field: string;
    }
  | {
      kind: "binding_ref";
      name: string;
    }
  | SetLiteralValue
  | ArrayLiteralValue
  | {
      kind: "function_call";
      call: FunctionCallExpr;
    }
  | {
      kind: "expr";
      expr: FreeObjectExpr;
    }
  | {
      kind: "parameter";
      name: string;
      castType?: string;
    };

export interface FunctionCallExpr {
  name: string;
  args: FunctionCallArgExpr[];
}

export type ShapeElement =
  | ({
      kind: "field";
      name: string;
    } & ShapeElementModifiers)
  | ({
      kind: "splat";
      depth: 1 | 2;
      sourceType?: string;
      sourceTypeExpr?: TypeExpr;
      intersection?: boolean;
    } & ShapeElementModifiers)
  | ({
      kind: "computed";
      name: string;
      expr: ComputedExpr;
      multi?: boolean;
    } & ShapeElementModifiers)
  | ({
      kind: "backlink";
      name: string;
      expr: BacklinkExpr;
      shape?: ShapeElement[];
    } & ShapeElementModifiers)
  | ({
      kind: "link";
      name: string;
      typeFilter?: string;
      typeFilterExpr?: TypeExpr;
      shape: ShapeElement[];
      clauses: ClauseChain;
    } & ShapeElementModifiers);

export interface SelectStatement {
  kind: "select";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  typeName: string;
  typeFilterExprs?: TypeExpr[];
  /**
   * Per-branch type filter expressions arising from a set-expression like
   * `{T1, T2}` at the SELECT subject. Unlike `typeFilterExprs` (which
   * intersect to narrow the subject), the branches are UNION ALL'd, so
   * matching concrete types that occur in more than one branch appear
   * once per branch in the result.
   */
  branchTypeFilterExprs?: TypeExpr[];
  shape: ShapeElement[];
  fields: string[];
  filter?: ClauseChain["filter"];
  orderBy?: ClauseChain["orderBy"];
  limit?: ClauseChain["limit"];
  offset?: ClauseChain["offset"];
  pos: SourcePos;
}

export type FreeObjectExpr =
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | SetLiteralValue
  | {
      kind: "set_expr";
      values: FreeObjectExpr[];
    }
  | {
      kind: "distinct";
      expr: FreeObjectExpr;
    }
  | {
      kind: "binding_ref";
      name: string;
    }
  | {
      kind: "current_item";
    }
  | {
      kind: "select";
      typeName: string;
      shape: ShapeElement[];
      clauses: ClauseChain;
    }
  | {
      kind: "function_call";
      call: FunctionCallExpr;
    }
  | {
      kind: "cast";
      castType: string;
      expr: FreeObjectExpr;
    }
  | {
      kind: "enum_path";
      enumType: string;
      member: string;
    }
  | {
      kind: "path";
      head: string;
      tail: string;
      steps?: PathStep[];
    }
  | {
      kind: "path_chain";
      parts: string[];
      steps?: PathStep[];
    }
  | {
      kind: "path_steps";
      steps: PathStep[];
      partial?: boolean;
    }
  | {
      kind: "backlink_path";
      link: string;
      sourceType?: string;
      sourceTypeExpr?: TypeExpr;
      optional?: boolean;
    }
  | {
      kind: "field_access";
      expr: FreeObjectExpr;
      field: string;
      optional?: boolean;
    }
  | {
      kind: "shape_projection";
      expr: FreeObjectExpr;
      shape: ShapeElement[];
    }
  | {
      kind: "index_access";
      expr: FreeObjectExpr;
      index: number;
    }
  | {
      kind: "slice_access";
      expr: FreeObjectExpr;
      start?: number;
      end?: number;
    }
  | {
      kind: "tuple";
      values: FreeObjectExpr[];
    }
  | {
      kind: "free_object_constructor";
      entries: Array<{ name: string; expr: FreeObjectExpr }>;
    }
  | {
      kind: "array_literal_expr";
      values: FreeObjectExpr[];
    }
  | {
      kind: "exists";
      expr: FreeObjectExpr;
    }
  | {
      kind: "compare";
      op: "=" | "!=" | ">" | "<" | ">=" | "<=" | "?=" | "?!=";
      left: FreeObjectExpr;
      right: FreeObjectExpr;
    }
  | {
      kind: "and";
      left: FreeObjectExpr;
      right: FreeObjectExpr;
    }
  | {
      kind: "or";
      left: FreeObjectExpr;
      right: FreeObjectExpr;
    }
  | {
      kind: "not";
      expr: FreeObjectExpr;
    }
  | {
      kind: "math";
      op: "+" | "-" | "*" | "/" | "//" | "%" | "^";
      left: FreeObjectExpr;
      right: FreeObjectExpr;
    }
  | {
      kind: "logical";
      op: "and" | "or";
      left: FreeObjectExpr;
      right: FreeObjectExpr;
    }
  | {
      kind: "unary";
      op: "not" | "neg";
      expr: FreeObjectExpr;
    }
  | {
      kind: "if_else";
      thenExpr: FreeObjectExpr;
      condition: FreeObjectExpr;
      elseExpr: FreeObjectExpr;
    }
  | {
      kind: "for_expr";
      variable: string;
      iterator: FreeObjectExpr;
      body: FreeObjectExpr;
      optional?: boolean;
      filter?: FreeObjectExpr;
      orderBy?: {
        expr: FreeObjectExpr;
        direction: "asc" | "desc";
      };
      limit?: number;
      offset?: number;
    }
  | {
      kind: "concat";
      parts: FreeObjectExpr[];
    }
  | {
      kind: "is_type";
      expr: FreeObjectExpr;
      typeName: string;
      typeExpr?: TypeExpr;
    }
  | {
      kind: "coalesce";
      left: FreeObjectExpr;
      right: FreeObjectExpr;
    }
  | {
      kind: "parameter";
      name: string;
      castType?: string;
    }
  | {
      kind: "substitution";
      name: string;
    }
  | {
      kind: "global_ref";
      name: string;
    }
  | {
      kind: "select_expr_subquery";
      alias?: string;
      expr: FreeObjectExpr;
      clauses?: ClauseChain;
      filter?: FreeObjectExpr;
      orderBy?: OrderExprChain;
      limit?: number;
      offset?: number;
    };

export interface SelectFreeStatement {
  kind: "select_free";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  entries: Array<{
    name: string;
    expr: FreeObjectExpr;
  }>;
  pos: SourcePos;
}

export interface OrderExprChain {
  expr: FreeObjectExpr;
  direction: "asc" | "desc";
  nullsPosition?: "first" | "last";
  then?: OrderExprChain;
}

export interface SelectExprStatement {
  kind: "select_expr";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  expr: FreeObjectExpr;
  orderBy?: OrderExprChain;
  pos: SourcePos;
}

export interface InsertStatement {
  kind: "insert";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  typeName: string;
  values: Record<string, InsertValue>;
  conflict?: InsertConflict;
  pos: SourcePos;
}

export type InsertValue =
  | ScalarValue
  | ArrayLiteralValue
  | TupleLiteralValue
  | {
      kind: "binding_ref";
      name: string;
    }
  | {
      kind: "select";
      typeName: string;
      shape: ShapeElement[];
      clauses: ClauseChain;
    }
  | {
      kind: "insert";
      typeName: string;
      values: Record<string, InsertValue>;
    }
  | {
      kind: "set";
      values: InsertValue[];
    }
  | {
      kind: "function_call";
      call: FunctionCallExpr;
    }
  | {
      kind: "expr";
      expr: FreeObjectExpr;
    }
  | ForStatement;

export interface InsertConflict {
  onField?: string;
  else?:
    | {
        kind: "select";
        typeName: string;
        shape: ShapeElement[];
        clauses: ClauseChain;
      }
    | {
        kind: "update";
        typeName: string;
        filter?: FilterExpr;
        values: Record<string, ScalarValue>;
      };
}

export interface UpdateStatement {
  kind: "update";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  typeName: string;
  target?: FreeObjectExpr;
  filter?: FilterExpr;
  values: Record<string, InsertValue>;
  operations?: Record<string, "assign" | "append" | "subtract">;
  pos: SourcePos;
}

export interface DeleteStatement {
  kind: "delete";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  typeName: string;
  target?: FreeObjectExpr;
  filter?: FilterExpr;
  pos: SourcePos;
}

export interface ForStatement {
  kind: "for";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  variable: string;
  optional?: boolean;
  iteratorExpr: FreeObjectExpr;
  body: InsertStatement | SelectStatement | SelectExprStatement | SelectFreeStatement;
  pos: SourcePos;
}

export interface ConfigureStatement {
  kind: "configure";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  scope: "session" | "current_database" | "instance";
  operation: "set" | "insert" | "reset";
  target: string;
  value?: FreeObjectExpr;
  pos: SourcePos;
}

export interface TransactionStatement {
  kind: "transaction";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  action: "start" | "commit" | "rollback";
  isolation?: "serializable" | "repeatable_read";
  pos: SourcePos;
}

export interface DDLStatement {
  kind: "ddl";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  action: "create" | "alter" | "drop";
  objectKind:
    | "type"
    | "scalar"
    | "link"
    | "property"
    | "function"
    | "constraint"
    | "index"
    | "trigger"
    | "policy"
    | "module"
    | "database"
    | "branch"
    | "role"
    | "extension"
    | "alias"
    | "global";
  name: string;
  value?: FreeObjectExpr;
  pos: SourcePos;
}

export interface GroupStatement {
  kind: "group";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  source: FreeObjectExpr;
  by: FreeObjectExpr[];
  using?: Array<{
    alias: string;
    expr: FreeObjectExpr;
  }>;
  shape?: ShapeElement[];
  pos: SourcePos;
}

export interface DescribeStatement {
  kind: "describe";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  objectKind: "schema" | "current_database" | "instance" | "type";
  objectName?: string;
  format?: "ddl" | "sdl" | "json" | "text";
  pos: SourcePos;
}

export interface ExplainStatement {
  kind: "explain";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  analyze: boolean;
  query: Statement;
  pos: SourcePos;
}

export type Statement = (
  | SelectStatement
  | SelectFreeStatement
  | SelectExprStatement
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | ForStatement
  | ConfigureStatement
  | TransactionStatement
  | DDLStatement
  | GroupStatement
  | DescribeStatement
  | ExplainStatement) & {
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  typeName?: string;
  filter?: FilterExpr;
};
