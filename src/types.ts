export type ScalarType =
  | "str"
  | "int"
  | "float"
  | "bool"
  | "json"
  | "datetime"
  | "duration"
  | "local_datetime"
  | "local_date"
  | "local_time"
  | "relative_duration"
  | "date_duration"
  | "uuid";

export type ScalarValue = string | number | boolean | null;

export interface AnnotationDef {
  name: string;
  value: string;
}

export type FunctionVolatility = "Immutable" | "Stable" | "Volatile" | "Modifying";

export interface FunctionParamDef {
  name: string;
  type: string;
  optional?: boolean;
  setOf?: boolean;
  variadic?: boolean;
  namedOnly?: boolean;
  default?: ScalarValue;
}

export type FunctionExprDef =
  | {
      kind: "param_ref";
      name: string;
    }
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | {
      kind: "concat";
      parts: Array<
        | {
            kind: "param_ref";
            name: string;
          }
        | {
            kind: "literal";
            value: ScalarValue;
          }
      >;
    };

export type FunctionBodyDef =
  | {
      kind: "expr";
      expr: FunctionExprDef;
    }
  | {
      kind: "query";
      language: "edgeql";
      query: string;
    };

export interface FunctionDef {
  module: string;
  name: string;
  params: FunctionParamDef[];
  returnType: string;
  returnOptional?: boolean;
  returnSetOf?: boolean;
  volatility?: FunctionVolatility;
  annotations?: AnnotationDef[];
  body: FunctionBodyDef;
}

export type ComputedValuePart =
  | {
      kind: "field_ref";
      field: string;
    }
  | {
      kind: "literal";
      value: ScalarValue;
    };

export type ComputedDef = {
  name: string;
  required?: boolean;
  multi?: boolean;
  annotations?: AnnotationDef[];
} & (
  | {
      kind: "property";
      expr:
        | {
            kind: "field_ref";
            field: string;
          }
        | {
            kind: "literal";
            value: ScalarValue;
          }
        | {
            kind: "concat";
            parts: ComputedValuePart[];
          };
    }
  | {
      kind: "link";
      expr:
        | {
            kind: "link_ref";
            link: string;
            filter?: {
              field: string;
              op: "=" | "!=" | "like" | "ilike";
              value: ScalarValue;
            };
          }
        | {
            kind: "backlink";
            link: string;
            sourceType?: string;
          };
    }
);

export interface AbstractAnnotationDef {
  module: string;
  name: string;
  inheritable?: boolean;
  annotations?: AnnotationDef[];
}

export type TriggerEvent = "insert" | "update" | "delete";

export type TriggerValueExpr =
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | {
      kind: "new_field";
      field: string;
    }
  | {
      kind: "old_field";
      field: string;
    };

export interface TriggerInsertAction {
  kind: "insert";
  targetType: string;
  values: Record<string, TriggerValueExpr>;
}

export interface TriggerDef {
  name: string;
  event: TriggerEvent;
  scope?: "each" | "all";
  when?:
    | {
        kind: "field_changed";
        field: string;
      }
    | {
        kind: "always";
      };
  actions: TriggerInsertAction[];
}

export type MutationRewriteExpr =
  | {
      kind: "datetime_of_statement";
    }
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | {
      kind: "subject_field";
      field: string;
    }
  | {
      kind: "old_field";
      field: string;
    };

export interface MutationRewriteDef {
  field: string;
  onInsert?: MutationRewriteExpr;
  onUpdate?: MutationRewriteExpr;
}

export type AccessPolicyOperation = "select" | "insert" | "update_read" | "update_write" | "delete" | "all";

export type AccessPolicyCondition =
  | {
      kind: "always";
      value: boolean;
    }
  | {
      kind: "global";
      name: string;
    }
  | {
      kind: "field_eq_global";
      field: string;
      global: string;
    }
  | {
      kind: "field_eq_literal";
      field: string;
      value: ScalarValue;
    }
  | {
      kind: "and";
      clauses: AccessPolicyCondition[];
    };

export interface AccessPolicyDef {
  name: string;
  effect: "allow" | "deny";
  operations: AccessPolicyOperation[];
  condition: AccessPolicyCondition;
  errmessage?: string;
}

export interface FieldDef {
  name: string;
  type: ScalarType;
  required?: boolean;
  multi?: boolean;
  annotations?: AnnotationDef[];
  enumValues?: string[];
}

export interface LinkPropertyDef {
  name: string;
  type: ScalarType;
  required?: boolean;
  annotations?: AnnotationDef[];
}

export interface LinkDef {
  name: string;
  targetType: string;
  multi?: boolean;
  properties?: LinkPropertyDef[];
  annotations?: AnnotationDef[];
}

export interface TypeDef {
  name: string;
  module?: string;
  abstract?: boolean;
  extends?: string[];
  annotations?: AnnotationDef[];
  fields: FieldDef[];
  links?: LinkDef[];
  computeds?: ComputedDef[];
  mutationRewrites?: MutationRewriteDef[];
  triggers?: TriggerDef[];
  accessPolicies?: AccessPolicyDef[];
}
