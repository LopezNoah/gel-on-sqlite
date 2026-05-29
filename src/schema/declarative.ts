import { AppError } from "../errors.js";
import type {
  AbstractAnnotationDef,
  AccessPolicyDef,
  AnnotationDef,
  ConstraintDef,
  ComputedDef,
  ComputedLinkPropertyExpr,
  CollectionTypeDef,
  FieldDefaultExpr,
  FunctionParamDef,
  FunctionVolatility,
  MutationRewriteExpr,
  OnTargetDeleteAction,
  ScalarType,
  ScalarValue,
  TriggerDef,
} from "../types.js";
import { OperatorKind, ReturnTypeModifier } from "./operators.js";
import type { ScalarTypeDeclaration } from "./scalar.js";
import { parseDeclarativeSchema } from "./sdl_adapter.js";

export type { ComputedLinkPropertyExpr } from "../types.js";

export interface SchemaModule {
  name: string;
}

export interface PropertyMember {
  kind: "property";
  name: string;
  scalar: ScalarType;
  required: boolean;
  hasDefault?: boolean;
  defaultExpr?: FieldDefaultExpr;
  readonly?: boolean;
  computed?: boolean;
  expr?: string;
  multi: boolean;
  collection?: CollectionTypeDef;
  overloaded: boolean;
  annotations: AnnotationDef[];
  targetTypeName?: string;
  enumValues?: string[];
  enumTypeName?: string;
  rewrite?: {
    onInsert?: MutationRewriteExpr;
    onUpdate?: MutationRewriteExpr;
  };
  constraints: ConstraintDef[];
}

export interface LinkProperty {
  name: string;
  scalar: ScalarType;
  required: boolean;
  computed?: false;
  hasDefault?: boolean;
  readonly?: boolean;
  collection?: CollectionTypeDef;
  annotations: AnnotationDef[];
}

export interface ComputedLinkProperty {
  name: string;
  computed: true;
  exprText: string;
  computedExpr: ComputedLinkPropertyExpr;
  annotations: AnnotationDef[];
}

export type LinkMemberProperty = LinkProperty | ComputedLinkProperty;

export interface LinkMember {
  kind: "link";
  name: string;
  target: string;
  required: boolean;
  hasDefault?: boolean;
  readonly?: boolean;
  onTargetDelete?: OnTargetDeleteAction;
  defaultTargetValues?: string[];
  multi: boolean;
  overloaded: boolean;
  annotations: AnnotationDef[];
  properties: LinkMemberProperty[];
  constraints?: ConstraintDef[];
}

export interface ComputedMember {
  kind: "computed";
  name: string;
  required: boolean;
  multi: boolean;
  overloaded: boolean;
  annotations: AnnotationDef[];
  expr: ComputedDef["expr"];
  computedKind: ComputedDef["kind"];
}

export type TypeMember = PropertyMember | LinkMember | ComputedMember;

export interface ObjectTypeDeclaration {
  kind: "object";
  module: string;
  name: string;
  abstract: boolean;
  extends: string[];
  annotations: AnnotationDef[];
  indexes?: Array<{
    expr: string;
  }>;
  members: TypeMember[];
  triggers: TriggerDef[];
  accessPolicies: AccessPolicyDef[];
  typeConstraints?: Array<{
    name: string;
    exprText: string;
    fieldRefs: string[];
    delegated?: boolean;
  }>;
}

export interface AbstractAnnotationDeclaration extends AbstractAnnotationDef {
  module: string;
  name: string;
  inheritable: boolean;
  annotations: AnnotationDef[];
}

export interface ConstraintDeclaration {
  module: string;
  name: string;
  params: string[];
  annotations: AnnotationDef[];
}

export interface PermissionDeclaration {
  module: string;
  name: string;
}

export interface GlobalDeclaration {
  module: string;
  name: string;
  // EdgeQL expression source if the global was declared with `:= …`.
  // Cardinality inference reads this to infer whether `global G` is one /
  // at_most_one / many based on the bound expression.
  exprText?: string;
}

export interface FunctionDeclaration {
  module: string;
  name: string;
  params: FunctionParamDef[];
  returnType: string;
  returnOptional: boolean;
  returnSetOf: boolean;
  volatility?: FunctionVolatility;
  annotations: AnnotationDef[];
  body: {
    language: "edgeql";
    text: string;
  };
}

export interface OperatorDeclaration {
  module: string;
  name: string;
  kind: OperatorKind;
  params: FunctionParamDef[];
  returnType: string;
  returnTypemod: ReturnTypeModifier;
  language?: string;
  fromOperator?: string[];
  fromFunction?: string[];
  fromExpr?: boolean;
  code?: string;
  recursive?: boolean;
  derivativeOf?: string;
}

export interface AliasDeclaration {
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

export interface DeclarativeSchema {
  modules: SchemaModule[];
  types: ObjectTypeDeclaration[];
  functions?: FunctionDeclaration[];
  operators?: OperatorDeclaration[];
  abstractAnnotations?: AbstractAnnotationDeclaration[];
  permissions?: PermissionDeclaration[];
  globals?: GlobalDeclaration[];
  scalarTypes?: ScalarTypeDeclaration[];
  constraints?: ConstraintDeclaration[];
  aliases?: AliasDeclaration[];
}

export interface DeclarativeParseOptions {
  legacySyntaxCompat?: boolean;
  parserEngine?: DeclarativeParserEngine;
}

export type DeclarativeParserEngine = "legacy" | "new_sdl" | "auto";

const asSchemaParseError = (err: unknown): AppError => {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof Error) {
    return new AppError("E_SYNTAX", err.message, 1, 1);
  }

  return new AppError("E_SYNTAX", "Unknown SDL parse error", 1, 1);
};

export const gelSchema = (strings: TemplateStringsArray, ...values: unknown[]): DeclarativeSchema => {
  const source = strings.reduce((acc, part, index) => {
    const value = index < values.length ? String(values[index]) : "";
    return `${acc}${part}${value}`;
  }, "");

  try {
    return parseDeclarativeSchema(source, {
      legacySyntaxCompat: true
    });
  } catch (err) {
    throw asSchemaParseError(err);
  }
};
