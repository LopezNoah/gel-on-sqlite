import type { FreeObjectExpr, PathStep, WithBinding } from "../edgeql/ast.js";
import type { ComputedLinkPropertyDef, ScalarValue } from "../types.js";

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
}

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
      kind: "link_property_exists";
      relation: LinkRelationIR;
      property: string;
    }
  | {
      kind: "link_property_compare_exists";
      relation: LinkRelationIR;
      targetColumn: string;
      property: string;
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
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
    };

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
      functionName: "sum";
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

export interface InsertIR extends MutationBaseIR {
  kind: "insert";
  values: Record<string, ScalarValue>;
  triggers?: TriggerIR[];
  policies?: PolicyIR[];
}

export interface UpdateIR extends MutationBaseIR {
  kind: "update";
  filter?: {
    column: string;
    value: ScalarValue;
  };
  values: Record<string, ScalarValue>;
  triggers?: TriggerIR[];
  policies?: PolicyIR[];
}

export interface DeleteIR extends MutationBaseIR {
  kind: "delete";
  filter?: {
    column: string;
    value: ScalarValue;
  };
  triggers?: TriggerIR[];
  policies?: PolicyIR[];
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
          op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=";
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
          kind: "for_expr";
          variable: string;
          iterator: SelectExprIREntry<Dec<D>>;
          body: SelectExprIREntry<Dec<D>>;
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
}

export type IRStatement =
  | SelectIR
  | SelectFreeIR
  | SelectExprIR
  | InsertIR
  | UpdateIR
  | DeleteIR;
