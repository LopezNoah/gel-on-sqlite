import type { ScalarValue } from "../types.js";

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

export type SelectShapeElementIR =
  | {
      kind: "field";
      name: string;
      pathId: string;
      column: string;
    }
  | {
      kind: "computed";
      name: string;
      pathId: string;
      expr:
        | {
            kind: "field_ref";
            column: string;
          }
        | {
            kind: "literal";
            value: ScalarValue;
          }
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
        | {
            kind: "concat";
            parts: Array<
              | {
                  kind: "field_ref";
                  column: string;
                }
              | {
                  kind: "literal";
                  value: ScalarValue;
                }
            >;
          }
        | {
            kind: "function_call";
            functionName: string;
            args: Array<
              | {
                  kind: "literal";
                  value: ScalarValue;
                }
              | {
                  kind: "field_ref";
                  column: string;
                }
              | {
                  kind: "set_literal";
                  values: ScalarValue[];
                }
              | {
                  kind: "array_literal";
                  values: ScalarValue[];
                }
              | {
                  kind: "function_call";
                  functionName: string;
                  args: Array<
                    | {
                        kind: "literal";
                        value: ScalarValue;
                      }
                    | {
                        kind: "field_ref";
                        column: string;
                      }
                    | {
                        kind: "set_literal";
                        values: ScalarValue[];
                      }
                    | {
                        kind: "array_literal";
                        values: ScalarValue[];
                      }
                  >;
                }
            >;
          };
    }
  | {
      kind: "backlink";
      name: string;
      pathId: string;
      sources: BacklinkSourceIR[];
    }
  | {
      kind: "link";
      name: string;
      pathId: string;
      relation: LinkRelationIR;
      typeFilter?: string;
      sourceTypeFilter?: string;
      columns: string[];
      shape: SelectShapeElementIR[];
      filter?: FilterExprIR;
      orderBy?: {
        column: string;
        direction: "asc" | "desc";
      };
      limit?: number;
      offset?: number;
      inference: InferenceResult;
    };

export interface BacklinkSourceIR {
  sourceType: string;
  table: string;
  storage: "inline" | "table";
  inlineColumn?: string;
  linkTable?: string;
}

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

export interface LinkRelationIR {
  sourceType: string;
  targetType: string;
  targetTable: string;
  targetTables: SchemaTypeRefIR[];
  storage: "inline" | "table";
  inlineColumn?: string;
  linkTable?: string;
}

export interface InferenceResult {
  cardinality: "empty" | "at_most_one" | "many";
  multiplicity: "unique" | "duplicate";
  volatility: "immutable";
}

export interface SelectIR {
  kind: "select";
  pathId: string;
  sourceType: string;
  typeRef: SchemaTypeRefIR;
  table: string;
  sourceTables: SchemaTypeRefIR[];
  columns: string[];
  shape: SelectShapeElementIR[];
  scopeTree: ScopeTreeIR;
  appliedOverlays: OverlayIR[];
  filter?: FilterExprIR;
  orderBy?: {
    column: string;
    direction: "asc" | "desc";
  };
  limit?: number;
  offset?: number;
  inference: InferenceResult;
}

export interface InsertIR {
  kind: "insert";
  pathId: string;
  table: string;
  values: Record<string, ScalarValue>;
  overlays: OverlayIR[];
}

export interface UpdateIR {
  kind: "update";
  pathId: string;
  table: string;
  filter?: {
    column: string;
    value: ScalarValue;
  };
  values: Record<string, ScalarValue>;
  overlays: OverlayIR[];
}

export interface DeleteIR {
  kind: "delete";
  pathId: string;
  table: string;
  filter?: {
    column: string;
    value: ScalarValue;
  };
  overlays: OverlayIR[];
}

export type SelectFreeIREntry =
  | {
      kind: "literal";
      name: string;
      value: ScalarValue;
    }
  | {
      kind: "set_literal";
      name: string;
      values: ScalarValue[];
    }
  | {
      kind: "select";
      name: string;
      query: SelectIR;
    }
  | {
      kind: "function_call";
      name: string;
      functionName: string;
      args: Array<
        | {
            kind: "literal";
            value: ScalarValue;
          }
        | {
            kind: "binding_ref";
            name: string;
          }
        | {
            kind: "set_literal";
            values: ScalarValue[];
          }
        | {
            kind: "array_literal";
            values: ScalarValue[];
          }
        | {
            kind: "function_call";
            functionName: string;
            args: Array<
              | {
                  kind: "literal";
                  value: ScalarValue;
                }
              | {
                  kind: "binding_ref";
                  name: string;
                }
              | {
                  kind: "set_literal";
                  values: ScalarValue[];
                }
              | {
                  kind: "array_literal";
                  values: ScalarValue[];
                }
            >;
          }
      >;
    }
  | {
      kind: "cast";
      name: string;
      castType: string;
      value: SelectFreeIREntry;
    }
  | {
      kind: "enum_path";
      name: string;
      enumType: string;
      member: string;
    }
  | {
      kind: "concat";
      name: string;
      parts: SelectFreeIREntry[];
    };

export interface SelectFreeIR {
  kind: "select_free";
  pathId: string;
  entries: SelectFreeIREntry[];
}

export type SelectExprIREntry =
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | {
      kind: "set_literal";
      values: ScalarValue[];
    }
  | {
      kind: "cast";
      castType: string;
      value: SelectExprIREntry;
    }
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
      kind: "concat";
      parts: SelectExprIREntry[];
    };

export interface SelectExprIR {
  kind: "select_expr";
  entries: SelectExprIREntry[];
}

export type IRStatement = SelectIR | SelectFreeIR | SelectExprIR | InsertIR | UpdateIR | DeleteIR;
