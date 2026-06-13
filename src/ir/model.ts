import type { DeleteStatement, FreeObjectExpr, InsertStatement, InsertValue, OrderExprChain, PathStep, SelectExprStatement, SelectStatement, ShapeElement, TypeExpr, UpdateStatement, WithBinding } from "../edgeql/ast.js";
import type { ComputedLinkPropertyDef, ScalarType, ScalarValue } from "../types.js";

/* ---------------------------------- */
/* Depth control                      */
/* ---------------------------------- */

type Depth = 0 | 1 | 2 | 3 | 4;
type PrevDepth = {
  0: 0;
  1: 0;
  2: 1;
  3: 2;
  4: 3;
};

type Dec<D extends Depth> = PrevDepth[D];

/* ---------------------------------- */
/* Path identity                      */
/* ---------------------------------- */

export interface PathStepIR {
  typeName: string;
  pointer?: string;
  direction?: "outbound" | "inbound";
  optional?: boolean;
}

export interface PathIdIR {
  id: string;
  steps: PathStepIR[];
  isPointerPath: boolean;
}

/* ---------------------------------- */
/* Shared basics                      */
/* ---------------------------------- */

export interface SchemaTypeRefIR {
  name: string;
  table: string;
  columns?: string[];
  module?: string;
  isAbstract?: boolean;
  isScalar?: boolean;
  children?: string[];
  ancestors?: string[];
  baseType?: string;
  materialType?: string;
}

export interface ScopeTreeIR {
  pathId: PathIdIR;
  typeName: string;
  children: ScopeTreeIR[];
}

export interface OverlayIR {
  table: string;
  sourcePathId: string;
  operation: "union" | "replace" | "exclude";
  policyPhase: "none" | "access" | "rewrite";
  rewritePhase: "none" | "insert" | "update";
}

export interface OrderByIR<TValue = string> {
  value: TValue;
  direction: "asc" | "desc";
  nullsPosition?: "first" | "last";
  then?: OrderByIR<TValue>;
  /**
   * Raw AST expression for `ORDER BY <expr>` forms (e.g. `len(.body)`). When
   * set, the SQL compiler compiles this expression against the current row
   * alias instead of looking up `value` as a column. `value` is left as the
   * `__expr__` sentinel and is unused.
   */
  exprAst?: FreeObjectExpr;
}

export interface PageIR {
  limit?: number;
  offset?: number;
}

export type Cardinality = "one" | "many" | "at_most_one" | "at_least_one" | "empty" | "unknown";

export type Multiplicity = "unique" | "duplicate" | "empty" | "unknown";

export type Volatility = "immutable" | "stable" | "volatile" | "modifying";

export interface InferenceResult {
  cardinality: Cardinality;
  multiplicity: Multiplicity;
  volatility: Volatility;
}

/* ---------------------------------- */
/* Triggers & policies                */
/* ---------------------------------- */

export interface TriggerEvent {
  kind: "insert" | "update" | "delete";
}

export interface TriggerIR {
  name: string;
  events: TriggerEvent[];
  scope: "each" | "all";
  sourceType: string;
}

export interface PolicyIR {
  name: string;
  effect: "allow" | "deny";
  operations: string[];
  condition?: string;
  errmessage?: string;
}

/* ---------------------------------- */
/* Reusable leaf nodes                */
/* ---------------------------------- */

export type LiteralIR = {
  kind: "literal";
  value: ScalarValue;
};

export type SetLiteralIR = {
  kind: "set_literal";
  values: ScalarValue[];
};

export type ArrayLiteralIR = {
  kind: "array_literal";
  values: ScalarValue[];
};

export type FieldRefIR = {
  kind: "field_ref";
  column: string;
};

export type BindingRefIR = {
  kind: "binding_ref";
  name: string;
};

export type ConcatIR<TPart> = {
  kind: "concat";
  parts: TPart[];
};

export type FunctionCallIR<TArg> = {
  kind: "function_call";
  functionName: string;
  args: TArg[];
};

/* ---------------------------------- */
/* Link / backlink                    */
/* ---------------------------------- */

export interface BacklinkSourceIR {
  sourceType: string;
  table: string;
  sourceTables?: SchemaTypeRefIR[];
  storage: "inline" | "table";
  inlineColumn?: string;
  linkTable?: string;
  propertyColumns?: string[];
  computedProperties?: ComputedLinkPropertyDef[];
}

export interface LinkRelationIR {
  sourceType: string;
  targetType: string;
  targetTable: string;
  targetTables: SchemaTypeRefIR[];
  propertyColumns?: string[];
  computedProperties?: ComputedLinkPropertyDef[];
  multi: boolean;
  storage: "inline" | "table";
  inlineColumn?: string;
  linkTable?: string;
  /** All concrete-subtype link tables that may carry data for this
   * relation. Used to UNION ALL across them when a query's row set spans
   * multiple subtypes (polymorphic link materialization). When undefined
   * or empty, the SQL compiler falls back to `linkTable`. */
  linkTables?: Array<{ name: string; table: string }>;
}

export type LinkPathStepIR =
  | {
      kind: "link";
      relation: LinkRelationIR;
    }
  | {
      kind: "backlink";
      sources: BacklinkSourceIR[];
    };

/* ---------------------------------- */
/* Filter                             */
/* ---------------------------------- */

export type FilterExprIR =
  | {
      kind: "field";
      column: string;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
      value: ScalarValue;
    }
  | {
      kind: "field_in";
      column: string;
      op: "in" | "not_in";
      values: ScalarValue[];
    }
  | {
      // Multi-property set-membership: tests whether the JSON-encoded multi
      // value at `column` shares any element with `values`. Used to lower
      // EdgeQL's set-cross-product semantics (`X IN .multi`, `.multi IN {…}`,
      // `.multi = {…}`) directly to SQL via `json_each` + `EXISTS`.
      kind: "multi_field_in";
      column: string;
      op: "in" | "not_in";
      values: ScalarValue[];
    }
  | {
      kind: "self_in_select";
      op: "in" | "not_in";
      sourceTables: SchemaTypeRefIR[];
      filter?: FilterExprIR;
    }
  | {
      kind: "backlink_contains";
      op: "in" | "not_in";
      value: ScalarValue;
      column: string;
      sources: BacklinkSourceIR[];
    }
  | {
      kind: "field_compare";
      leftColumn: string;
      rightColumn: string;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
    }
  | {
      kind: "backlink";
      sources: BacklinkSourceIR[];
      op: "=" | "!=";
      value: ScalarValue;
    }
  | {
      kind: "backlink_exists";
      sources: BacklinkSourceIR[];
    }
  | {
      kind: "link_property_exists";
      relation: LinkRelationIR;
      property: string;
    }
  | {
      kind: "link_exists";
      relation: LinkRelationIR;
    }
  | {
      kind: "link_target_link_exists";
      relation: LinkRelationIR;
      targetRelation: LinkRelationIR;
    }
  | {
      kind: "link_property_compare_exists";
      relation: LinkRelationIR;
      targetColumn: string;
      property: string;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
    }
  | {
      kind: "link_target_field_compare";
      relation: LinkRelationIR;
      targetColumn: string;
      value: ScalarValue;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
      // Optional scalar function wrapper applied to the target column before
      // comparison. Lets the SQL path lower forms like
      // `str_upper(.link.col) = 'X'` to `UPPER(target.col) = ?`.
      targetFn?: ScalarFnName;
    }
  | {
      kind: "link_target_field_in";
      relation: LinkRelationIR;
      targetColumn: string;
      values: ScalarValue[];
      op: "in" | "not_in";
    }
  | {
      kind: "backlink_property_compare";
      sources: BacklinkSourceIR[];
      column: string;
      property: string;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
    }
  | {
      kind: "backlink_property_in";
      sources: BacklinkSourceIR[];
      column: string;
      property: string;
      op: "in" | "not_in";
    }
  | {
      kind: "backlink_property_value_compare";
      sources: BacklinkSourceIR[];
      property: string;
      value: ScalarValue;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
    }
  // `<scalar fn>(.<computed-backlink>.<col>) <op> <value>` — a FILTER expression
  // that compares a (possibly scalar-fn-wrapped) column on the backlink source
  // type against a literal. Lower to `EXISTS (... AND <fn>(src.col) <op> ?)`
  // joined through each backlink source. This lets aliases-with-FILTER paths
  // like `FILTER str_upper(.winner.name) = 'ALICE'` lower to a single SQL
  // statement instead of the runtime typed-alias bypass.
  | {
      kind: "backlink_target_field_compare";
      sources: BacklinkSourceIR[];
      targetColumn: string;
      targetFn?: ScalarFnName;
      value: ScalarValue;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "ilike";
    }
  | {
      kind: "link_path_target_field_compare";
      steps: LinkPathStepIR[];
      targetColumn: string;
      value: ScalarValue;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "ilike";
    }
  | {
      kind: "and";
      left: FilterExprIR;
      right: FilterExprIR;
    }
  | {
      kind: "or";
      left: FilterExprIR;
      right: FilterExprIR;
    }
  | {
      kind: "not";
      expr: FilterExprIR;
    }
  | {
      kind: "expr_compare";
      left: ScalarExprIR;
      right: ScalarExprIR;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=";
    };

/** Scalar stdlib functions the SQL filter path can lower directly. Whitelisted
 * so the compiler doesn't accept arbitrary names (they'd need overload-aware
 * lowering through gel_ir, not a plain SQLite function). */
export type ScalarFnName = "str_upper" | "str_lower" | "len";

/** Scalar expression compiled from filter LHS/RHS — column refs, literals,
 * and arithmetic/string-concat operators that lower directly to SQL. */
export type ScalarExprIR =
  | { kind: "column"; column: string }
  | { kind: "literal"; value: ScalarValue }
  | { kind: "binop"; op: "+" | "-" | "*" | "/" | "//" | "%" | "++"; left: ScalarExprIR; right: ScalarExprIR }
  | { kind: "neg"; expr: ScalarExprIR }
  | { kind: "index_access"; value: ScalarExprIR; index: number }
  | { kind: "fn_call"; name: ScalarFnName; args: ScalarExprIR[] }
  // `array_agg(.multi_prop ORDER BY .multi_prop [ASC|DESC])` lowered to the
  // JSON-string representation of the sorted multi-property elements, so
  // `array_agg = array_agg` / `array_agg = [literal]` compare by canonical
  // JSON equality directly in SQL.
  | { kind: "multi_field_array_agg"; column: string; direction: "asc" | "desc" }
  // `count(.multi_prop)` / `count((SELECT _ := .multi_prop FILTER ...))` —
  // lowered to a `COUNT(*)` over `json_each` with an optional WHERE clause
  // on the iterated element value.
  | { kind: "multi_field_count"; column: string; elementFilter?: MultiFieldElementFilterIR };

/** Lowered `_ <op> ...` filter on a multi-property element inside a
 *  `count(SELECT _ := .multi FILTER ...)` subquery. The element value comes
 *  from `json_each(...).value`. */
export type MultiFieldElementFilterIR =
  | { kind: "in"; op: "in" | "not_in"; values: ScalarValue[] }
  | { kind: "compare"; op: "=" | "!=" | "<" | "<=" | ">" | ">="; value: ScalarValue };

/* ---------------------------------- */
/* Select-shape expressions           */
/* ---------------------------------- */

type SelectShapeFunctionArgIR<D extends Depth = 4> =
  | LiteralIR
  | FieldRefIR
  | SetLiteralIR
  | ArrayLiteralIR
  | (D extends 0 ? never : FunctionCallIR<SelectShapeFunctionArgIR<Dec<D>>>);

export type SelectShapeExprIR =
  | FieldRefIR
  | BindingRefIR
  | LiteralIR
  | SetLiteralIR
  | {
      kind: "polymorphic_field_ref";
      sourceType: string;
      concreteSourceTypes?: string[];
      column: string;
    }
  | {
      kind: "is_type";
      concreteSourceTypes: string[];
    }
  | {
      kind: "type_name";
      sourceType: string;
    }
  | {
      kind: "subquery";
      query: SelectIR;
    }
  | ConcatIR<FieldRefIR | LiteralIR>
  | FunctionCallIR<SelectShapeFunctionArgIR>
  | {
      kind: "field_suffix_math";
      field: string;
      fromEnd: number;
      op: "negate" | "const_minus";
      constant?: number;
    }
  | {
      kind: "link_aggregate";
      functionName: "sum" | "count" | "min" | "max" | "avg";
      relation: LinkRelationIR;
      column: string;
    }
  | {
      kind: "select_expr";
      expr: FreeObjectExpr;
      withBindings?: WithBinding[];
    };

/* ---------------------------------- */
/* Select shape                       */
/* ---------------------------------- */

export interface ShapeBaseIR {
  name: string;
  pathId: PathIdIR;
  typeRef?: SchemaTypeRefIR;
  cardinality?: Cardinality;
}

export type SelectShapeElementIR =
  | (ShapeBaseIR & {
      kind: "field";
      column: string;
    })
  | (ShapeBaseIR & {
      kind: "computed";
      expr: SelectShapeExprIR;
    })
  | (ShapeBaseIR & {
      kind: "backlink";
      sources: BacklinkSourceIR[];
      // True when the backlink may yield multiple source rows; false when
      // EdgeQL's cardinality inference proves it's at-most-one (e.g., the
      // forward link is `constraint exclusive`). Defaults to true at the
      // call site so existing callers keep multi semantics.
      multi?: boolean;
      columns?: string[];
      shape?: SelectShapeElementIR[];
      filter?: FilterExprIR;
      orderBy?: OrderByIR<string>;
      limit?: number;
      offset?: number;
      inference?: InferenceResult;
    })
  | (ShapeBaseIR & {
      kind: "link";
      relation: LinkRelationIR;
      typeFilter?: string;
      sourceTypeFilter?: string;
      columns: string[];
      shape: SelectShapeElementIR[];
      filter?: FilterExprIR;
      orderBy?: OrderByIR<string>;
      limit?: number;
      offset?: number;
      inference: InferenceResult;
    });

/* ---------------------------------- */
/* Statement bases                    */
/* ---------------------------------- */

export interface PathStatementIR {
  kind: string;
  pathId: PathIdIR;
}

export interface TableStatementIR extends PathStatementIR {
  table: string;
}

export interface MutationBaseIR extends TableStatementIR {
  overlays: OverlayIR[];
}

export interface SelectBaseIR extends TableStatementIR, PageIR {
  sourceType: string;
  typeRef: SchemaTypeRefIR;
  sourceTables: SchemaTypeRefIR[];
  columns: string[];
  filter?: FilterExprIR;
  orderBy?: OrderByIR<string>;
  inference: InferenceResult;
  triggers?: TriggerIR[];
  policies?: PolicyIR[];
  requiredPermissions?: string[];
}

/* ---------------------------------- */
/* Main statements                    */
/* ---------------------------------- */

export interface SelectIR extends SelectBaseIR {
  kind: "select";
  shape: SelectShapeElementIR[];
  scopeTree: ScopeTreeIR;
  appliedOverlays: OverlayIR[];
}

export interface InsertLinkPropertyIR {
  name: string;
  type: ScalarType;
  hasDefault: boolean;
  defaultValue?: ScalarValue;
  defaultExprText?: string;
}

export interface InsertLinkAssignmentIR {
  linkName: string;
  storage: "inline" | "table";
  inlineColumn?: string;
  ownerTable: string;
  linkTable?: string;
  propertyColumns?: string[];
  properties?: InsertLinkPropertyIR[];
  expectedTargetTables: string[];
  target: InsertValue;
}

export interface InsertLinkDefaultIR {
  linkName: string;
  storage: "inline" | "table";
  inlineColumn?: string;
  ownerTable: string;
  linkTable?: string;
  propertyColumns?: string[];
  properties?: InsertLinkPropertyIR[];
  targetTable: string;
  defaultTargetValues: ScalarValue[];
  lookupColumn?: string;
  // When the link `default` is an INSERT expression (e.g.
  // `default := (INSERT DefaultTest5 { … })`), this carries the EdgeQL text of
  // that nested insert. The runtime executes it and links the new row, rather
  // than looking an existing target up by `lookupColumn`.
  insertExprText?: string;
}

export interface InsertIR extends MutationBaseIR {
  kind: "insert";
  values: Record<string, ScalarValue>;
  linkAssignments?: InsertLinkAssignmentIR[];
  linkDefaults?: InsertLinkDefaultIR[];
  inference?: InferenceResult;
}

export interface UpdateLinkAssignmentIR {
  linkName: string;
  storage: "inline" | "table";
  inlineColumn?: string;
  ownerTable: string;
  linkTable?: string;
  propertyColumns?: string[];
  properties?: InsertLinkPropertyIR[];
  expectedTargetTables: string[];
  operation: "assign" | "append" | "subtract";
  target: InsertValue;
}

export interface UpdateIR extends MutationBaseIR {
  kind: "update";
  filter?: {
    column: string;
    value: ScalarValue;
  };
  values: Record<string, ScalarValue>;
  linkAssignments?: UpdateLinkAssignmentIR[];
  inference?: InferenceResult;
}

export interface DeleteIR extends MutationBaseIR {
  kind: "delete";
  filter?: {
    column: string;
    value: ScalarValue;
  };
  inference?: InferenceResult;
}

/* ---------------------------------- */
/* Select-free                        */
/* ---------------------------------- */

export type SelectFreeFunctionArgIR<D extends Depth = 4> =
  | LiteralIR
  | BindingRefIR
  | SetLiteralIR
  | ArrayLiteralIR
  | (D extends 0 ? never : FunctionCallIR<SelectFreeFunctionArgIR<Dec<D>>>);

export type SelectFreeIREntry<D extends Depth = 4> =
  | (LiteralIR & { name: string })
  | (SetLiteralIR & { name: string })
  | {
      kind: "select";
      name: string;
      query: SelectIR;
    }
  | (FunctionCallIR<SelectFreeFunctionArgIR<Dec<D>>> & {
      name: string;
    })
  | (D extends 0
      ? never
      : {
          kind: "cast";
          name: string;
          castType: string;
          value: SelectFreeIREntry<Dec<D>>;
        })
  | {
      kind: "enum_path";
      name: string;
      enumType: string;
      member: string;
    }
  | (D extends 0
      ? never
      : {
          kind: "concat";
          name: string;
          parts: SelectFreeIREntry<Dec<D>>[];
        });

export interface SelectFreeIR extends PathStatementIR {
  kind: "select_free";
  entries: SelectFreeIREntry[];
  triggers?: TriggerIR[];
  policies?: PolicyIR[];
  inference?: InferenceResult;
}

/* ---------------------------------- */
/* Select-expr                        */
/* ---------------------------------- */
export type SelectExprIREntry<D extends Depth = 4> =
  | LiteralIR
  | SetLiteralIR
  | BindingRefIR
  | (D extends 0
      ? never
      : {
          kind: "set_expr";
          values: SelectExprIREntry<Dec<D>>[];
        })
  | (D extends 0
      ? never
      : {
          kind: "cast";
          castType: string;
          value: SelectExprIREntry<Dec<D>>;
        })
  | {
      kind: "enum_path";
      enumType: string;
      member: string;
    }
  | {
      kind: "type_field_path";
      typeName: string;
      field: string;
      fieldType: string;
    }
  | {
      kind: "type_name";
      sourceType: string;
    }
  | {
      kind: "polymorphic_field_ref";
      sourceType: string;
      concreteSourceTypes?: string[];
      column: string;
    }
  | {
      kind: "current_item_field";
      bindingName: string;
      field: string;
    }
  | {
      kind: "global_ref";
      name: string;
    }
  | (D extends 0
      ? never
      : {
          kind: "distinct";
          value: SelectExprIREntry<Dec<D>>;
        })
  | (D extends 0
      ? never
      : {
          kind: "field_access";
          value: SelectExprIREntry<Dec<D>>;
          field: string;
        })
  | {
      kind: "backlink_path";
      link: string;
      sourceType?: string;
      sourceTypeExpr?: TypeExpr;
    }
  | {
      kind: "path_steps";
      steps: PathStep[];
    }
  | (D extends 0
      ? never
      : {
          kind: "shape_projection";
          value: SelectExprIREntry<Dec<D>>;
          fields: Array<{
            name: string;
            sourceField?: string;
            backlinkLink?: string;
            backlinkSourceType?: string;
            expr?: SelectExprIREntry<Dec<D>>;
            multi?: boolean;
            itemFields?: Array<{
              name: string;
              sourceField?: string;
              expr?: SelectExprIREntry<Dec<D>>;
              multi?: boolean;
            }>;
          }>;
        })
  | (D extends 0
      ? never
      : {
          kind: "select";
          query: SelectIR;
        })
  | (D extends 0
      ? never
      : {
          kind: "tuple";
          values: SelectExprIREntry<Dec<D>>[];
        })
  | (D extends 0
      ? never
      : {
          kind: "free_object";
          entries: Array<{ name: string; expr: SelectExprIREntry<Dec<D>> }>;
        })
  | (D extends 0
      ? never
      : {
          kind: "array_literal_expr";
          values: SelectExprIREntry<Dec<D>>[];
        })
  | (D extends 0
      ? never
      : {
          kind: "index_access";
          value: SelectExprIREntry<Dec<D>>;
          index: number;
        })
  | (D extends 0
      ? never
      : {
          kind: "exists";
          value: SelectExprIREntry<Dec<D>>;
        })
  | (D extends 0
      ? never
      : {
          kind: "compare";
          op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike" | "not_like" | "not_ilike";
          left: SelectExprIREntry<Dec<D>>;
          right: SelectExprIREntry<Dec<D>>;
        })
  | (D extends 0
      ? never
      : {
          kind: "and" | "or";
          left: SelectExprIREntry<Dec<D>>;
          right: SelectExprIREntry<Dec<D>>;
        })
  | (D extends 0
      ? never
      : {
          kind: "not";
          expr: SelectExprIREntry<Dec<D>>;
        })
  | (D extends 0
      ? never
      : {
          kind: "math";
          op: "+" | "-" | "*" | "/" | "//" | "%" | "^";
          left: SelectExprIREntry<Dec<D>>;
          right: SelectExprIREntry<Dec<D>>;
        })
  | (D extends 0
      ? never
      : {
          kind: "if_else";
          thenExpr: SelectExprIREntry<Dec<D>>;
          condition: SelectExprIREntry<Dec<D>>;
          elseExpr: SelectExprIREntry<Dec<D>>;
        })
  | (D extends 0
      ? never
      : {
          kind: "coalesce";
          left: SelectExprIREntry<Dec<D>>;
          right: SelectExprIREntry<Dec<D>>;
        })
  | (D extends 0
      ? never
      : {
          kind: "for_expr";
          variable: string;
          iterator: SelectExprIREntry<Dec<D>>;
          body: SelectExprIREntry<Dec<D>>;
          optional?: boolean;
          filter?: SelectExprIREntry;
          orderBy?: OrderByIR<SelectExprIREntry>;
          limit?: number;
          offset?: number;
        })
  | (D extends 0
      ? never
      : {
          kind: "concat";
          parts: SelectExprIREntry<Dec<D>>[];
        })
  | (D extends 0
      ? never
      : {
          kind: "is_type";
          value: SelectExprIREntry<Dec<D>>;
          typeName: string;
        })
  | (D extends 0
      ? never
      : {
          kind: "select_expr_subquery";
          alias?: string;
          value: SelectExprIREntry<Dec<D>>;
          filter?: SelectExprIREntry<Dec<D>>;
          orderBy?: {
            value: SelectExprIREntry<Dec<D>>;
            direction: "asc" | "desc";
          };
          limit?: number;
          offset?: number;
        })
  | {
      kind: "mutation_expr";
      statement: InsertStatement
        | UpdateStatement
        | DeleteStatement;
    }
  | (D extends 0 ? never : FunctionCallIR<SelectExprIREntry<Dec<D>>>)
  | {
      kind: "current_item";
      bindingName: string;
    };

export interface SelectExprIR {
  kind: "select_expr";
  entries: SelectExprIREntry[];
  currentBinding?: string;
  orderBy?: OrderByIR<SelectExprIREntry>;
  typeRef?: SchemaTypeRefIR;
  inference?: InferenceResult;
}

/* ---------------------------------- */
/* Group                              */
/* ---------------------------------- */

// Phase 6: keys are flat name strings used at runtime to read each row's
// already-materialised value (USING aliases land in the source shape as
// computed entries, BY-only fields land as plain field entries). Field vs.
// alias provenance is tracked at compile time and no longer needed at runtime.
export type GroupByElementIR = never;

export interface GroupIR {
  kind: "group";
  // Underlying source query AS AN AST so the runtime can route it through the
  // existing `tryEvaluateParsedRuntimeSelect` path. That path materialises
  // computed shape entries (e.g. `count(.owners)` over a backlink) at runtime
  // — something the strict IR/SQL compile rejects because backlinks aren't in
  // `knownFields`. BY fields and USING aliases are folded into the shape so
  // their values come back on each row. When the source typeName is a WITH
  // binding (free-object, set-literal, path, etc.) we build a `select_expr`
  // wrapping a `shape_projection` over the binding ref so the parsed runtime
  // recognizes it.
  source:
    | SelectStatement
    | SelectExprStatement;
  // The union of all atom names referenced by any grouping set. Each row's
  // `key` includes every name in this list — for rows produced by a grouping
  // set that doesn't include an atom, that key field is NULL.
  byAtoms: string[];
  // Each entry is a list of atom names; the runtime runs one partition pass
  // per entry. Plain `BY a, b` → `[[a, b]]`; `BY {a, b}` → `[[a], [b]]`;
  // CUBE / ROLLUP enumerate further subsets; mixing produces the Cartesian
  // product.
  groupingSets: string[][];
  // Field names that the source select materialises but that should be
  // stripped from `elements`, e.g. BY-only fields or USING aliases.
  hiddenByFields: string[];
  // USING aliases that name the source binding itself (`GROUP X USING z := X
  // BY z`). These are not materialised as object fields; the runtime groups on
  // the whole source row/value for the alias.
  selfBindingAliases?: string[];
  // Post-process the {key, elements, grouping} group rows. These are AST
  // nodes evaluated by the engine against each row as `current_item`.
  postFilter?: FreeObjectExpr;
  postShape?: ShapeElement[];
  postOrderBy?: OrderExprChain;
  postLimit?: number;
  postOffset?: number;
  // Contract C1: a trailing field-access chain applied to the group-output
  // rows AFTER postShape/postFilter/postOrderBy/postLimit/postOffset, for
  // queries that destructure a group directly, e.g.
  //   (GROUP Card BY .element).elements    -> ["elements"]
  //   (GROUP Card BY .element).key.element -> ["key", "element"]
  //   (GROUP Card BY .element).grouping    -> ["grouping"]
  // The engine walks the path over each group row: when a step value is an
  // array it flattens one level (contributing each element); otherwise it
  // contributes the scalar/object. The result is the flat array of values.
  postFieldPath?: string[];
}

export type IRStatement =
  | SelectIR
  | SelectFreeIR
  | SelectExprIR
  | InsertIR
  | UpdateIR
  | DeleteIR
  | GroupIR;
