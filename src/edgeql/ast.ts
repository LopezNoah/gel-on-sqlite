import type { ScalarType, ScalarValue } from "../types.js";

export interface SourcePos {
  line: number;
  column: number;
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
    };

export type FilterValue =
  | ScalarValue
  | {
      kind: "binding_ref";
      name: string;
    };

export type FilterExpr =
  | {
      kind: "predicate";
      target: FilterTarget;
      op: "=" | "!=" | "like" | "ilike";
      value: FilterValue;
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
    };

export interface WithBinding {
  name: string;
  value: WithBindingValue;
}

export type WithBindingValue =
  | {
      kind: "literal";
      value: ScalarValue;
    }
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
      kind: "enum_path";
      enumType: string;
      member: string;
    }
  | {
      kind: "path";
      head: string;
      tail: string;
    };

export interface WithModuleAlias {
  alias: string;
  module: string;
}

export interface OrderExpr {
  field: string;
  direction: "asc" | "desc";
}

export interface ClauseChain {
  filter?: FilterExpr;
  orderBy?: OrderExpr;
  limit?: number;
  offset?: number;
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
      kind: "function_call";
      call: FunctionCallExpr;
    };

export interface BacklinkExpr {
  link: string;
  sourceType?: string;
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
      call: FunctionCallExpr;
    };

export interface FunctionCallExpr {
  name: string;
  args: FunctionCallArgExpr[];
}

export type ShapeElement =
  | {
      kind: "field";
      name: string;
    }
  | {
      kind: "splat";
      depth: 1 | 2;
      sourceType?: string;
      intersection?: boolean;
    }
  | {
      kind: "computed";
      name: string;
      expr: ComputedExpr;
    }
  | {
      kind: "backlink";
      name: string;
      expr: BacklinkExpr;
    }
  | {
      kind: "link";
      name: string;
      typeFilter?: string;
      shape: ShapeElement[];
      clauses: ClauseChain;
    };

export interface SelectStatement {
  kind: "select";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  typeName: string;
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
  | {
      kind: "set_literal";
      values: ScalarValue[];
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
    }
  | {
      kind: "concat";
      parts: FreeObjectExpr[];
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

export interface SelectExprStatement {
  kind: "select_expr";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  expr: FreeObjectExpr;
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
    };

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
  filter?: FilterExpr;
  values: Record<string, ScalarValue>;
  pos: SourcePos;
}

export interface DeleteStatement {
  kind: "delete";
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
  typeName: string;
  filter?: FilterExpr;
  pos: SourcePos;
}

export type Statement = SelectStatement | SelectFreeStatement | SelectExprStatement | InsertStatement | UpdateStatement | DeleteStatement;
