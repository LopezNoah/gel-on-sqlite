import type { ScalarValue } from "../types.js";

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
/* Shared basics                      */
/* ---------------------------------- */

export interface SchemaTypeRefIR {
  name: string;
  table: string;
}

export interface ScopeTreeIR {
  pathId: string;
  typeName: string;
  children: ScopeTreeIR[];
}

export interface OverlayIR {
  table: string;
  sourcePathId: string;
  operation: "union" | "replace" | "exclude";
  policyPhase: "none";
  rewritePhase: "none";
}

export interface OrderByIR<TValue = string> {
  value: TValue;
  direction: "asc" | "desc";
}

export interface PageIR {
  limit?: number;
  offset?: number;
}

export interface InferenceResult {
  cardinality: "empty" | "at_most_one" | "many";
  multiplicity: "unique" | "duplicate";
  volatility: "immutable";
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
  storage: "inline" | "table";
  inlineColumn?: string;
  linkTable?: string;
}

export interface LinkRelationIR {
  sourceType: string;
  targetType: string;
  targetTable: string;
  targetTables: SchemaTypeRefIR[];
  propertyColumns?: string[];
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
      op: "=" | "!=" | "like" | "ilike";
      value: ScalarValue;
    }
  | {
      kind: "field_in";
      column: string;
      op: "in" | "not_in";
      values: ScalarValue[];
    }
  | {
      kind: "field_compare";
      leftColumn: string;
      rightColumn: string;
      op: "=" | "!=" | "like" | "ilike";
    }
  | {
      kind: "backlink";
      sources: BacklinkSourceIR[];
      op: "=" | "!=";
      value: ScalarValue;
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
  | {
      kind: "polymorphic_field_ref";
      sourceType: string;
      column: string;
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
    };

/* ---------------------------------- */
/* Select shape                       */
/* ---------------------------------- */

export interface ShapeBaseIR {
  name: string;
  pathId: string;
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
  pathId: string;
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
}

export interface UpdateIR extends MutationBaseIR {
  kind: "update";
  filter?: {
    column: string;
    value: ScalarValue;
  };
  values: Record<string, ScalarValue>;
}

export interface DeleteIR extends MutationBaseIR {
  kind: "delete";
  filter?: {
    column: string;
    value: ScalarValue;
  };
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
}

/* ---------------------------------- */
/* Select-expr                        */
/* ---------------------------------- */
export type SelectExprIREntry<D extends Depth = 4> =
  | LiteralIR
  | SetLiteralIR
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
          orderBy?: {
            value: SelectExprIREntry<Dec<D>>;
            direction: "asc" | "desc";
          };
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
