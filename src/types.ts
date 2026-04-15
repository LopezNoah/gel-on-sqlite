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

export type CollectionTypeDef =
  | {
      kind: "array";
    }
  | {
      kind: "tuple";
      elementNames?: string[];
    };

export interface AnnotationDef {
  name: string;
  value: string;
}

export interface ConstraintDef {
  name: string;
  annotations: AnnotationDef[];
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

export interface AliasDef {
  module: string;
  name: string;
  values: ScalarValue[];
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
          }
        | {
            kind: "function_call";
            name: string;
            args: ScalarValue[];
          }
        | {
            kind: "link_aggregate";
            functionName: "sum";
            link: string;
            field: string;
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
  hasDefault?: boolean;
  multi?: boolean;
  collection?: CollectionTypeDef;
  constraints?: ConstraintDef[];
  annotations?: AnnotationDef[];
  enumValues?: string[];
  enumTypeName?: string;
}

export interface LinkPropertyDef {
  name: string;
  type: ScalarType;
  required?: boolean;
  hasDefault?: boolean;
  collection?: CollectionTypeDef;
  annotations?: AnnotationDef[];
}

export interface LinkDef {
  name: string;
  targetType: string;
  overloaded?: boolean;
  multi?: boolean;
  hasDefault?: boolean;
  defaultTargetValues?: string[];
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
