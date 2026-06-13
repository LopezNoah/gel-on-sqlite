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
  delegated?: boolean;
  params?: Array<{
    name: string;
    value: ScalarValue;
  }>;
  // `constraint exclusive on (<expr>)` — the subject expression text.
  onExpr?: string;
  // `constraint exclusive on (...) except (<expr>)` — rows where the except
  // expression is true are exempt from the uniqueness check.
  exceptExpr?: string;
}

export type FieldDefaultExpr =
  | {
      kind: "literal";
      value: ScalarValue;
    }
  | {
      kind: "function_call";
      name: string;
      args: ScalarValue[];
    };

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
  exprText?: string;
  values?: ScalarValue[];
  sourceType?: string;
  projections?: Array<{
    name: string;
    sourceField: string;
  }>;
  filter?:
    | {
        kind: "field_predicate";
        field: string;
        op: "=" | "!=" | "like" | "ilike";
        value: ScalarValue;
      }
    | {
        kind: "backlink_membership";
        op: "in" | "not_in";
        value: ScalarValue;
        link: string;
        sourceType?: string;
        field: string;
      };
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

export type ComputedLinkPropertyExpr =
  | {
      kind: "binary_op";
      op: "*" | "+" | "-" | "/" | "++" | "??";
      left: ComputedLinkPropertyExpr;
      right: ComputedLinkPropertyExpr;
    }
  | {
      kind: "field_ref";
      name: string;
    }
  | {
      kind: "link_property_ref";
      name: string;
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
            kind: "set_literal";
            values: ScalarValue[];
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
            functionName: "sum" | "count";
            link: string;
            field?: string;
          }
        | {
            kind: "edgeql_expr";
            exprText: string;
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
          }
        | {
            kind: "select_type";
            typeName: string;
            exprText: string;
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
  defaultExpr?: FieldDefaultExpr;
  // Raw text of the declared default — kept for defaults that don't fit the
  // literal/function-call IR (e.g. `default := __source__.a + 1`).
  defaultExprText?: string;
  readonly?: boolean;
  multi?: boolean;
  collection?: CollectionTypeDef;
  constraints?: ConstraintDef[];
  annotations?: AnnotationDef[];
  targetTypeName?: string;
  enumValues?: string[];
  enumTypeName?: string;
  splatStrategy?: "Implicit" | "Explicit";
  // True when this field is the synthetic `<link>_id` column the runtime
  // adds for inline single-target links. Such columns aren't user-visible
  // properties — splat expansion must skip them so `Type { * }` doesn't
  // surface `status_id`, `priority_id`, etc.
  isLinkColumn?: boolean;
}

export interface LinkPropertyDef {
  name: string;
  type: ScalarType;
  required?: boolean;
  hasDefault?: boolean;
  defaultExpr?: FieldDefaultExpr;
  defaultExprText?: string;
  readonly?: boolean;
  collection?: CollectionTypeDef;
  annotations?: AnnotationDef[];
}

export interface ComputedLinkPropertyDef {
  name: string;
  exprText: string;
  computedExpr: ComputedLinkPropertyExpr;
  annotations?: AnnotationDef[];
}

export type OnTargetDeleteAction = "restrict" | "delete_source" | "allow" | "deferred_restrict";

export interface LinkDef {
  name: string;
  targetType: string;
  overloaded?: boolean;
  required?: boolean;
  multi?: boolean;
  hasDefault?: boolean;
  readonly?: boolean;
  onTargetDelete?: OnTargetDeleteAction;
  defaultTargetValues?: string[];
  // Filter column + scalar values of a `select T filter .col = <v>` default,
  // for non-string lookups the legacy defaultTargetValues can't carry.
  defaultTargetFilter?: { column: string; values: ScalarValue[] };
  // Raw text of the link's `default := ...` expression (when declared). Used
  // to classify the default (e.g. DML defaults reject `__default__` refs).
  defaultExprText?: string;
  properties?: LinkPropertyDef[];
  computedProperties?: ComputedLinkPropertyDef[];
  annotations?: AnnotationDef[];
  constraints?: ConstraintDef[];
  splatStrategy?: "Implicit" | "Explicit";
}

export interface TypeDef {
  name: string;
  module?: string;
  abstract?: boolean;
  // True when this type was registered by the runtime DDL pre-pass
  // (`CREATE TYPE …`), whose lightweight parser does not yet capture
  // `CREATE CONSTRAINT exclusive`. Consumers that need complete constraint
  // metadata (e.g. UNLESS CONFLICT ON validation) skip such types.
  ddlSynthesized?: boolean;
  extends?: string[];
  annotations?: AnnotationDef[];
  indexes?: Array<{
    expr: string;
  }>;
  fields: FieldDef[];
  links?: LinkDef[];
  computeds?: ComputedDef[];
  mutationRewrites?: MutationRewriteDef[];
  triggers?: TriggerDef[];
  accessPolicies?: AccessPolicyDef[];
  // Type-level constraints (e.g. `constraint exclusive on ((.first, .last))`).
  // Only basic metadata needed for cardinality inference is preserved.
  typeConstraints?: Array<{
    name: string;
    exprText: string;
    fieldRefs: string[];
    delegated?: boolean;
    exceptExpr?: string;
  }>;
}
