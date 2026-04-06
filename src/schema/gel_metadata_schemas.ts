import { z } from "zod";

const FunctionParamSchema = z.object({
  name: z.string(),
  type_id: z.string(),
  kind: z.enum(["PositionalParam", "NamedOnlyParam", "VariadicParam"]),
  typemod: z.enum(["SingletonType", "OptionalType", "SetOfType"]),
  default: z.string().nullable().optional(),
});

const ConstraintParamSchema = z.array(z.string()).optional();

// ObjectType metadata
export const ObjectTypeMetadataSchema = z.object({
  compound_type: z.boolean().optional(),
  is_from_alias: z.boolean().optional(),
  computed_fields: z.array(z.string()).optional(),
});

// ScalarType metadata
export const ScalarTypeMetadataSchema = z.object({
  base_type: z.string().optional(),
  enum_values: z.array(z.string()).optional(),
  arg_values: z.array(z.number()).optional(),
  default_expr: z.string().nullable().optional(),
});

// Link metadata
export const LinkMetadataSchema = z.object({
  cardinality: z.enum(["One", "Many"]),
  required: z.boolean().optional(),
  readonly: z.boolean().optional(),
  secret: z.boolean().optional(),
  on_target_delete: z.enum(["Allow", "Restrict", "DeleteSource", "DeleteTarget"]).optional(),
  on_source_delete: z.enum(["Allow", "Restrict", "DeleteTarget"]).optional(),
  target_type_id: z.string().optional(),
  computed_expr: z.string().nullable().optional(),
});

// Property metadata
export const PropertyMetadataSchema = z.object({
  cardinality: z.enum(["One", "Many"]),
  required: z.boolean().optional(),
  readonly: z.boolean().optional(),
  secret: z.boolean().optional(),
  target_type_id: z.string().optional(),
  computed_expr: z.string().nullable().optional(),
  sqlite_column: z.string().optional(),
});

// Function metadata
export const FunctionMetadataSchema = z.object({
  params: z.array(FunctionParamSchema).optional(),
  return_type_id: z.string().optional(),
  return_typemod: z.enum(["SingletonType", "OptionalType", "SetOfType"]).optional(),
  body: z.string().optional(),
  language: z.string().optional(),
  volatility: z.enum(["Immutable", "Stable", "Volatile", "Modifying"]).optional(),
  preserves_optionality: z.boolean().optional(),
  used_globals: z.array(z.string()).optional(),
  required_permissions: z.array(z.string()).optional(),
});

// Constraint metadata
export const ConstraintMetadataSchema = z.object({
  expr: z.string().optional(),
  subject_id: z.string().optional(),
  errmessage: z.string().optional(),
  delegated: z.boolean().optional(),
  except_expr: z.string().nullable().optional(),
  param_values: ConstraintParamSchema,
});

// Index metadata
export const IndexMetadataSchema = z.object({
  expr: z.string(),
  except_expr: z.string().nullable().optional(),
  kwargs: z.array(z.string()).optional(),
  deferrability: z.enum(["Prohibited", "Deferrable", "NotDeferrable"]).optional(),
  deferred: z.boolean().optional(),
  active: z.boolean().optional(),
});

// AccessPolicy metadata
export const AccessPolicyMetadataSchema = z.object({
  subject_id: z.string().optional(),
  action: z.enum(["Allow", "Deny"]).optional(),
  access_kinds: z.array(z.enum(["Select", "Insert", "Update", "Delete"])).optional(),
  condition: z.string().nullable().optional(),
  expr: z.string().optional(),
});

// Global metadata
export const GlobalMetadataSchema = z.object({
  target_type_id: z.string().optional(),
  required: z.boolean().optional(),
  cardinality: z.enum(["One", "Many"]).optional(),
  expr: z.string().nullable().optional(),
  default: z.string().nullable().optional(),
});

// Alias metadata
export const AliasMetadataSchema = z.object({
  expr: z.string(),
  target_type_id: z.string().optional(),
});

// Migration metadata
export const MigrationMetadataSchema = z.object({
  parent_id: z.string().optional(),
  script: z.string().optional(),
  sdl: z.string().optional(),
  message: z.string().optional(),
  generated_by: z.string().optional(),
});

// Annotation metadata
export const AnnotationMetadataSchema = z.object({
  inheritable: z.boolean().optional(),
});

// Trigger metadata
export const TriggerMetadataSchema = z.object({
  subject_id: z.string().optional(),
  timing: z.enum(["Before", "After", "InsteadOf"]).optional(),
  kinds: z.array(z.enum(["Insert", "Update", "Delete"])).optional(),
  scope: z.enum(["Each", "Statement"]).optional(),
  expr: z.string().optional(),
});

// Rewrite metadata
export const RewriteMetadataSchema = z.object({
  subject_id: z.string().optional(),
  kind: z.enum(["Insert", "Update"]).optional(),
  expr: z.string().optional(),
});

// Cast metadata
export const CastMetadataSchema = z.object({
  from_type_id: z.string(),
  to_type_id: z.string(),
  allow_implicit: z.boolean().optional(),
  allow_assignment: z.boolean().optional(),
  volatility: z.enum(["Immutable", "Stable", "Volatile"]).optional(),
});

// Operator metadata
export const OperatorMetadataSchema = z.object({
  operator_kind: z.enum(["Infix", "Prefix", "Postfix"]).optional(),
  abstract: z.boolean().optional(),
  volatility: z.enum(["Immutable", "Stable", "Volatile"]).optional(),
  params: z.array(FunctionParamSchema).optional(),
  return_type_id: z.string().optional(),
});

// Array metadata
export const ArrayMetadataSchema = z.object({
  element_type_id: z.string(),
  dimensions: z.array(z.number().nullable()).optional(),
});

// Tuple metadata
export const TupleMetadataSchema = z.object({
  named: z.boolean().optional(),
  element_type_ids: z.array(z.string()),
});

// Range / MultiRange metadata
export const RangeMetadataSchema = z.object({
  element_type_id: z.string(),
});

// Parameter metadata
export const ParameterMetadataSchema = z.object({
  type_id: z.string(),
  typemod: z.enum(["SingletonType", "OptionalType", "SetOfType"]).optional(),
  kind: z.enum(["PositionalParam", "NamedOnlyParam", "VariadicParam"]).optional(),
  num: z.number().optional(),
  default: z.string().nullable().optional(),
});

// TupleElement metadata
export const TupleElementMetadataSchema = z.object({
  name: z.string(),
  type_id: z.string(),
});

// Permission metadata
export const PermissionMetadataSchema = z.object({});

// Module metadata
export const ModuleMetadataSchema = z.object({});

// Extension metadata
export const ExtensionMetadataSchema = z.object({
  version: z.string().optional(),
});

// FutureBehavior metadata
export const FutureBehaviorMetadataSchema = z.object({});

// PseudoType metadata
export const PseudoTypeMetadataSchema = z.object({});

// Delta metadata
export const DeltaMetadataSchema = z.object({
  kind: z.enum(["Create", "Alter", "Delete"]).optional(),
  expr: z.string().optional(),
});

// Discriminated union for all metadata kinds
export const GelSchemaMetadataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ObjectType"), metadata: ObjectTypeMetadataSchema }),
  z.object({ kind: z.literal("ScalarType"), metadata: ScalarTypeMetadataSchema }),
  z.object({ kind: z.literal("Link"), metadata: LinkMetadataSchema }),
  z.object({ kind: z.literal("Property"), metadata: PropertyMetadataSchema }),
  z.object({ kind: z.literal("Function"), metadata: FunctionMetadataSchema }),
  z.object({ kind: z.literal("Constraint"), metadata: ConstraintMetadataSchema }),
  z.object({ kind: z.literal("Index"), metadata: IndexMetadataSchema }),
  z.object({ kind: z.literal("AccessPolicy"), metadata: AccessPolicyMetadataSchema }),
  z.object({ kind: z.literal("Global"), metadata: GlobalMetadataSchema }),
  z.object({ kind: z.literal("Alias"), metadata: AliasMetadataSchema }),
  z.object({ kind: z.literal("Migration"), metadata: MigrationMetadataSchema }),
  z.object({ kind: z.literal("Annotation"), metadata: AnnotationMetadataSchema }),
  z.object({ kind: z.literal("Trigger"), metadata: TriggerMetadataSchema }),
  z.object({ kind: z.literal("Rewrite"), metadata: RewriteMetadataSchema }),
  z.object({ kind: z.literal("Cast"), metadata: CastMetadataSchema }),
  z.object({ kind: z.literal("Operator"), metadata: OperatorMetadataSchema }),
  z.object({ kind: z.literal("Array"), metadata: ArrayMetadataSchema }),
  z.object({ kind: z.literal("Tuple"), metadata: TupleMetadataSchema }),
  z.object({ kind: z.literal("Range"), metadata: RangeMetadataSchema }),
  z.object({ kind: z.literal("MultiRange"), metadata: RangeMetadataSchema }),
  z.object({ kind: z.literal("Parameter"), metadata: ParameterMetadataSchema }),
  z.object({ kind: z.literal("TupleElement"), metadata: TupleElementMetadataSchema }),
  z.object({ kind: z.literal("Permission"), metadata: PermissionMetadataSchema }),
  z.object({ kind: z.literal("Module"), metadata: ModuleMetadataSchema }),
  z.object({ kind: z.literal("Extension"), metadata: ExtensionMetadataSchema }),
  z.object({ kind: z.literal("FutureBehavior"), metadata: FutureBehaviorMetadataSchema }),
  z.object({ kind: z.literal("PseudoType"), metadata: PseudoTypeMetadataSchema }),
  z.object({ kind: z.literal("Delta"), metadata: DeltaMetadataSchema }),
]);

// Export inferred types
export type ObjectTypeMetadata = z.infer<typeof ObjectTypeMetadataSchema>;
export type ScalarTypeMetadata = z.infer<typeof ScalarTypeMetadataSchema>;
export type LinkMetadata = z.infer<typeof LinkMetadataSchema>;
export type PropertyMetadata = z.infer<typeof PropertyMetadataSchema>;
export type FunctionMetadata = z.infer<typeof FunctionMetadataSchema>;
export type ConstraintMetadata = z.infer<typeof ConstraintMetadataSchema>;
export type IndexMetadata = z.infer<typeof IndexMetadataSchema>;
export type AccessPolicyMetadata = z.infer<typeof AccessPolicyMetadataSchema>;
export type GlobalMetadata = z.infer<typeof GlobalMetadataSchema>;
export type AliasMetadata = z.infer<typeof AliasMetadataSchema>;
export type MigrationMetadata = z.infer<typeof MigrationMetadataSchema>;
export type AnnotationMetadata = z.infer<typeof AnnotationMetadataSchema>;
export type TriggerMetadata = z.infer<typeof TriggerMetadataSchema>;
export type RewriteMetadata = z.infer<typeof RewriteMetadataSchema>;
export type CastMetadata = z.infer<typeof CastMetadataSchema>;
export type OperatorMetadata = z.infer<typeof OperatorMetadataSchema>;
export type ArrayMetadata = z.infer<typeof ArrayMetadataSchema>;
export type TupleMetadata = z.infer<typeof TupleMetadataSchema>;
export type RangeMetadata = z.infer<typeof RangeMetadataSchema>;
export type ParameterMetadata = z.infer<typeof ParameterMetadataSchema>;
export type TupleElementMetadata = z.infer<typeof TupleElementMetadataSchema>;
export type PermissionMetadata = z.infer<typeof PermissionMetadataSchema>;
export type ModuleMetadata = z.infer<typeof ModuleMetadataSchema>;
export type ExtensionMetadata = z.infer<typeof ExtensionMetadataSchema>;
export type FutureBehaviorMetadata = z.infer<typeof FutureBehaviorMetadataSchema>;
export type PseudoTypeMetadata = z.infer<typeof PseudoTypeMetadataSchema>;
export type DeltaMetadata = z.infer<typeof DeltaMetadataSchema>;
export type GelSchemaMetadata = z.infer<typeof GelSchemaMetadataSchema>;

// Validation helper
export const validateMetadata = (kind: string, metadata: unknown): void => {
  const result = GelSchemaMetadataSchema.safeParse({ kind, metadata });
  if (!result.success) {
    throw new Error(`Invalid ${kind} metadata: ${result.error.errors.map((e) => e.message).join(", ")}`);
  }
};
