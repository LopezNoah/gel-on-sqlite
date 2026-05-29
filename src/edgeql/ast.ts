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
  offsetExpr?: FreeObjectExpr;
  limitExpr?: FreeObjectExpr;
}

export type FilterTarget =
  | {
      kind: "field";
      field: string;
      // Set when the parser saw a bare unqualified name (no `.` prefix) — in
      // EdgeQL this is a name reference that must resolve to a binding/type,
      // so the semantic analyzer flags it for a clearer diagnostic.
      bareName?: string;
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
            kind: "expr_set";
            values: FreeObjectExpr[];
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

export type TupleLiteralElementValue = ScalarValue | TupleLiteralElementArray | TupleLiteralElementObject;
export type TupleLiteralElementArray = Array<TupleLiteralElementValue>;
export interface TupleLiteralElementObject {
  [key: string]: TupleLiteralElementValue;
}

export interface TupleLiteralValue {
  kind: "tuple_literal";
  values: TupleLiteralElementValue[] | Record<string, TupleLiteralElementValue>;
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
  /**
   * Optional expression form. When set, the sort key is computed by evaluating
   * this expression per row, not by reading `field`. Used for ORDER BY clauses
   * like `len(.body)` that don't reduce to a single field path.
   */
  expr?: FreeObjectExpr;
  direction: "asc" | "desc";
  nullsPosition?: "first" | "last";
  then?: OrderExpr;
}

export interface ClauseChain {
  filter?: FilterExpr;
  orderBy?: OrderExpr;
  limit?: number;
  offset?: number;
  limitExpr?: FreeObjectExpr;
  offsetExpr?: FreeObjectExpr;
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
    }
  | {
      kind: "named_arg";
      name: string;
      arg: FunctionCallArgExpr;
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
  limitExpr?: ClauseChain["limitExpr"];
  offsetExpr?: ClauseChain["offsetExpr"];
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
      kind: "set_op";
      op: "intersect" | "except";
      left: FreeObjectExpr;
      right: FreeObjectExpr;
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
      kind: "introspect_typeof";
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
      indexExpr?: FreeObjectExpr;
    }
  | {
      kind: "slice_access";
      expr: FreeObjectExpr;
      start?: number;
      end?: number;
      startExpr?: FreeObjectExpr;
      endExpr?: FreeObjectExpr;
    }
  | {
      kind: "tuple";
      values: FreeObjectExpr[];
    }
  | {
      kind: "free_object_constructor";
      entries: Array<{ name: string; expr: FreeObjectExpr }>;
      // Set when the source used `(name := …, …)` rather than `{name := …, …}`.
      // The paren form is a *named tuple* (cardinality is the cartesian
      // product of entries); the brace form is a free object (cardinality is
      // exactly one).
      tupleLike?: boolean;
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
      op: "=" | "!=" | ">" | "<" | ">=" | "<=" | "?=" | "?!=" | "like" | "ilike" | "not_like" | "not_ilike";
      left: FreeObjectExpr;
      right: FreeObjectExpr;
    }
  | {
      // EdgeQL `expr IN set` / `expr NOT IN set` — true iff `left` equals any
      // element of `right`. `right` is set-valued (a set literal, subquery,
      // path, …). The semantic and IR layers desugar the literal-RHS case to
      // an OR-chain of `=` comparisons; non-literal RHS is not yet supported.
      kind: "in_expr";
      op: "in" | "not_in";
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
      limitExpr?: FreeObjectExpr;
      offsetExpr?: FreeObjectExpr;
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
      limitExpr?: FreeObjectExpr;
      offsetExpr?: FreeObjectExpr;
    }
  | {
      kind: "mutation_expr";
      statement: InsertStatement | UpdateStatement | DeleteStatement;
    }
  | GroupExpr;

export interface GroupUsingBinding {
  alias: string;
  expr: FreeObjectExpr;
}

export type GroupByAtom =
  | { kind: "field_ref"; field: string }
  | { kind: "name_ref"; name: string };

// Top-level BY entries combine to form one or more "grouping sets" — each set
// is a list of atom names. Plain `BY a, b` → one set [a, b]; `BY {a, b}` →
// two sets [[a], [b]]; CUBE / ROLLUP enumerate further subsets.
export type GroupByElement =
  | GroupByAtom
  | { kind: "sets"; sets: GroupByAtom[][] }
  | { kind: "cube"; atoms: GroupByAtom[] }
  | { kind: "rollup"; atoms: GroupByAtom[] };

export interface GroupExpr {
  kind: "group_expr";
  source: FreeObjectExpr;
  using?: GroupUsingBinding[];
  by: GroupByElement[];
}

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
  orderBy?: ClauseChain["orderBy"];
  limit?: ClauseChain["limit"];
  offset?: ClauseChain["offset"];
  limitExpr?: ClauseChain["limitExpr"];
  offsetExpr?: ClauseChain["offsetExpr"];
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

export interface FunctionParamDecl {
  name: string;
  type: string;
  variadic?: boolean;
  namedOnly?: boolean;
  optional?: boolean;
  setOf?: boolean;
  defaultExpr?: string;
}

export interface FunctionDecl {
  params: FunctionParamDecl[];
  returnType: string;
  returnOptional?: boolean;
  returnSetOf?: boolean;
  body: {
    kind: "query";
    language: string;
    query: string;
    fromFunction?: string;
    fromExpression?: boolean;
  };
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
    | "global"
    | "annotation"
    | "migration"
    | "future"
    | "cast"
    | "operator";
  name: string;
  value?: FreeObjectExpr;
  functionDecl?: FunctionDecl;
  pos: SourcePos;
}

export interface GroupStatement {
  kind: "group";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  source: FreeObjectExpr;
  using?: GroupUsingBinding[];
  by: GroupByElement[];
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
