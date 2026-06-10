import type { ScalarValue } from "../types.js";

export type UUID = string;

export type Cardinality = "one" | "many" | "at_most_one" | "at_least_one" | "unknown";
export type Multiplicity = "empty" | "unique" | "duplicate" | "unknown";
export type Volatility = "immutable" | "stable" | "volatile" | "modifying";
export type BindingKind = "with" | "for" | "select" | "schema";
export type TypeModifier = "singleton" | "optional" | "set_of";
export type Polymorphism = "not_used" | "type" | "expr";

export interface Span {
  line: number;
  column: number;
}

export interface Base {
  kind: string;
  span?: Span;
}

export interface TypeRef extends Base {
  kind: "type_ref";
  id: UUID;
  nameHint: string;
  origNameHint?: string;
  module: string;
  isView: boolean;
  isCfgView?: boolean;
  isScalar: boolean;
  isAbstract: boolean;
  inSchema?: boolean;
  isOpaqueUnion?: boolean;
  needsCustomJsonCast?: boolean;
  collection?: "array" | "tuple" | "range" | "multirange";
  elementName?: string;
  subtypes?: TypeRef[];
  materialType?: TypeRef;
  baseType?: TypeRef;
  children?: TypeRef[];
  ancestors?: TypeRef[];
  union?: TypeRef[];
  unionIsExhaustive?: boolean;
  intersection?: TypeRef[];
  exprIntersection?: TypeRef[];
  exprUnion?: TypeRef[];
  sqlType?: string;
  customSqlSerialization?: string;
}

export interface PointerRef extends Base {
  kind: "pointer_ref" | "tuple_indirection_pointer_ref" | "special_pointer_ref" | "type_intersection_pointer_ref";
  id: UUID;
  name: string;
  shortName: string;
  stdParentName?: string;
  outSource: TypeRef;
  outTarget: TypeRef;
  sourcePtr?: PointerRef;
  basePtr?: PointerRef;
  outCardinality: Cardinality;
  inCardinality: Cardinality;
  unionIsExhaustive?: boolean;
  intersectionComponents?: PointerRef[];
  isComputed: boolean;
  isDerived?: boolean;
  isIdPointer?: boolean;
  isLinkProperty?: boolean;
  hasProperties: boolean;
  definedHere?: boolean;
  computedLinkAlias?: PointerRef;
  computedLinkAliasIsBackward?: boolean;
  materialPtr?: PointerRef;
  children?: PointerRef[];
  unionComponents?: PointerRef[];
}

export interface TupleIndirectionPointerRef extends PointerRef {
  kind: "tuple_indirection_pointer_ref";
}

export interface SpecialPointerRef extends PointerRef {
  kind: "special_pointer_ref";
}

export interface TypeIntersectionPointerRef extends PointerRef {
  kind: "type_intersection_pointer_ref";
  optional: boolean;
  isEmpty: boolean;
  isSubtype: boolean;
  rptrSpecialization: PointerRef[];
}

export interface PathId extends Base {
  kind: "path_id";
  namespace: string[];
  isPointerPath: boolean;
  steps: PathStep[];
}

export interface PathStep {
  type: TypeRef;
  pointer?: PointerRef;
  direction?: "outbound" | "inbound";
}

export interface ScopeTreeNode extends Base {
  kind: "scope_tree_node";
  uniqueId: number;
  pathId?: PathId;
  children: ScopeTreeNode[];
  namespaces: string[];
  fenced: boolean;
  optional: boolean;
}

export interface MaterializedSet extends Base {
  kind: "materialized_set";
  materialized: Set;
  reason: string[];
  useSets: Set[];
  cardinality: Cardinality;
  finalized?: boolean;
}

export interface Param extends Base {
  kind: "param";
  name: string;
  required: boolean;
  typeref: TypeRef;
  schemaType: string;
  subParams?: Param[];
}

export interface Global extends Base {
  kind: "global";
  name: string;
  required: boolean;
  hasPresentArg: boolean;
  typeref: TypeRef;
}

export interface Set extends Base {
  kind: "set";
  expr: Expr;
  pathId: PathId;
  typeref: TypeRef;
  shape: ShapeElement[];
  shapeSource?: Set;
  isBinding: boolean | BindingKind;
  isMaterializedRef: boolean;
  isSchemaAlias: boolean;
  isVisibleBindingRef?: boolean;
  ignoreRewrites?: boolean;
  isFactoringProtected?: boolean;
  anchor?: string;
  showAsAnchor?: string;
  pathScopeId?: number;
  materializedSets?: MaterializedSet[];
}

export interface ShapeElement extends Base {
  kind: "shape_element";
  span?: Span;
  source: Set;
  expr: Set;
  targetPtr?: PointerRef;
  shapeOp?: "append" | "subtract" | "assign" | "materialize";
  shapeOrigin?: "explicit" | "default" | "splat_expansion" | "materialization";
  required: boolean;
  cardinality: Cardinality;
  // EdgeQL name of this shape entry as written in the query (e.g. `letter`
  // for `letter := letter`). Preserved from the AST so SQL lowering can use
  // it as the JSON object key when the inner expression doesn't carry a
  // pointer ref of its own.
  name?: string;
}

export interface Statement extends Base {
  kind: "statement" | "select_stmt" | "insert_stmt" | "update_stmt" | "delete_stmt" | "group_stmt" | "config_stmt";
  expr: Set;
  scopeTree: ScopeTreeNode;
  views: Record<string, string>;
  params: Param[];
  globals: Global[];
  requiredPermissions: string[];
  serverParamConversions: ServerParamConversion[];
  serverParamConversionParams: Param[];
  cardinality: Cardinality;
  multiplicity: Multiplicity;
  volatility: Volatility;
  stype?: string;
  viewShapes: Record<string, string[]>;
  viewShapesMetadata: Record<string, ViewShapeMetadata>;
  schema?: string;
  schemaRefs: UUID[];
  schemaRefExprs?: Record<UUID, string[]>;
  dmlExprs: string[];
  typeRewrites: Record<string, Set>;
  singletons: PathId[];
  triggers: Trigger[][];
  warnings: string[];
  unsafeIsolationDangers: string[];
}

export interface SelectStmt extends Statement {
  kind: "select_stmt";
  where?: Set;
  orderBy?: SortExpr[];
  limit?: Set;
  offset?: Set;
  implicitWrapper: boolean;
  cardInferenceOverride?: Set;
}

export interface InsertStmt extends Statement, MutatingStmtShape {
  kind: "insert_stmt";
  shape: ShapeElement[];
  onConflict?: OnConflictClause;
  finalTyperef?: TypeRef;
}

export interface UpdateStmt extends Statement, MutatingStmtShape {
  kind: "update_stmt";
  where?: Set;
  shape: ShapeElement[];
  materialType?: TypeRef;
}

export interface DeleteStmt extends Statement, MutatingStmtShape {
  kind: "delete_stmt";
  where?: Set;
  orderBy?: SortExpr[];
  limit?: Set;
  offset?: Set;
  materialType?: TypeRef;
  linksToDelete?: Record<UUID, PointerRef[]>;
}

export interface MutatingStmtShape {
  subject: TypeRef;
  conflictChecks?: OnConflictClause[];
  writePolicies?: Record<UUID, WritePolicies>;
  readPolicies?: Record<UUID, ReadPolicyExpr>;
  rewrites?: Rewrites;
}

export interface GroupStmt extends Statement {
  kind: "group_stmt";
  by: Set[];
  using: Record<string, Set>;
  subject: Set;
  // Union of all BY-atom names, in BY order. Every group row's `key` object
  // carries all of them (NULL when the row's grouping set doesn't include
  // the atom). Left undefined for the features that stay on the runtime
  // grouper (link-property keys, USING whole-set references, non-lowerable
  // subjects); compileGroupStmtToSQL then bails and the engine falls back
  // to runGroupIR.
  byAtoms?: string[];
  // Expanded grouping sets, each a list of atom names: `BY a, b` → [[a,b]];
  // `BY {a, b}` → [[a],[b]]; CUBE/ROLLUP enumerate subsets; comma-mixing
  // takes the Cartesian product. The SQL stage emits one GROUP BY branch per
  // entry, UNION ALL'd.
  groupingSets?: string[][];
  // Fields added to the subject's projection just to make them available as
  // group keys (BY fields not in the written shape, USING aliases). Stripped
  // from the displayed `elements` so the output shape stays as written.
  hiddenByFields?: string[];
}

export interface ConfigStmt extends Statement {
  kind: "config_stmt";
  operation: "set" | "insert" | "reset";
  scope: "session" | "current_database" | "instance";
  name: string;
  value?: Set;
}

export interface SortExpr extends Base {
  kind: "sort_expr";
  path: Set;
  direction: "asc" | "desc";
  nonesOrder: "first" | "last";
}

export type Expr =
  | EmptySet
  | TypeRoot
  | MaterializedExpr
  | VisibleBindingExpr
  | InlinedParameterExpr
  | Pointer
  | TypeIntersectionPointer
  | TupleIndirectionPointer
  | Tuple
  | ArrayExpr
  | BaseConstant
  | ConstantSet
  | ParameterExpr
  | QueryParameterExpr
  | FunctionParameterExpr
  | GlobalExpr
  | OperatorCall
  | FunctionCall
  | TypeCast
  | SelectExpr
  | InsertExpr
  | UpdateExpr
  | DeleteExpr
  | ForExpr
  | IfElseExpr
  | ExistsExpr
  | CoalesceExpr
  | SliceExpr
  | IndexExpr
  | TypeIntrospectionExpr
  | TypeCheckOpExpr
  | FTSDocumentExpr
  | StaticIntrospectionExpr
  | EmbeddedGroupExpr
  | GroupRowsExpr
  | GroupRowFieldExpr
  | TriggerAnchor;

export interface EmptySet extends Base {
  kind: "empty_set";
  typeref?: TypeRef;
}

export interface TypeRoot extends Base {
  kind: "type_root";
  typeref: TypeRef;
  skipSubtypes: boolean;
  isCachedGlobal: boolean;
}

export interface MaterializedExpr extends Base {
  kind: "materialized_expr";
  typeref: TypeRef;
}

export interface VisibleBindingExpr extends Base {
  kind: "visible_binding_expr";
  typeref: TypeRef;
}

export interface InlinedParameterExpr extends Base {
  kind: "inlined_parameter_expr";
  typeref: TypeRef;
  required: boolean;
  isGlobal: boolean;
}

export interface Pointer extends Base {
  kind: "pointer";
  source: Set;
  ptrref: PointerRef;
  direction: "outbound" | "inbound";
  optionalDeref?: boolean;
  forceLinkTable?: boolean;
  expr?: Expr;
  isDefinition: boolean;
  isPhony?: boolean;
  anchor?: string;
  showAsAnchor?: string;
  isMutation?: boolean;
}

export interface TypeIntersectionPointer extends Base {
  kind: "type_intersection_pointer";
  source: Set;
  optional: boolean;
  ptrref: TypeIntersectionPointerRef;
  isDefinition?: boolean;
}

export interface TupleIndirectionPointer extends Base {
  kind: "tuple_indirection_pointer";
  source: Set;
  ptrref: TupleIndirectionPointerRef;
  isDefinition?: boolean;
}

export interface TupleElement {
  name?: string;
  val: Set;
}

export interface Tuple extends Base {
  kind: "tuple";
  named: boolean;
  elements: TupleElement[];
}

export interface ArrayExpr extends Base {
  kind: "array";
  elements: Set[];
  typeref?: TypeRef;
}

export interface BaseConstant extends Base {
  kind:
    | "string_constant"
    | "integer_constant"
    | "float_constant"
    | "decimal_constant"
    | "bigint_constant"
    | "boolean_constant"
    | "bytes_constant";
  value: ScalarValue;
  typeref?: TypeRef;
}

export interface ConstantSet extends Base {
  kind: "constant_set";
  elements: Array<BaseConstant | ParameterExpr>;
  typeref?: TypeRef;
}

export interface LegacyConstantCompat extends Base {
  kind: "constant";
  value: ScalarValue;
  typeref?: TypeRef;
}

export interface ParameterExpr extends Base {
  kind: "parameter" | "query_parameter" | "function_parameter";
  name: string;
  required: boolean;
  typeref: TypeRef;
}

export interface QueryParameterExpr extends ParameterExpr {
  kind: "query_parameter";
}

export interface FunctionParameterExpr extends ParameterExpr {
  kind: "function_parameter";
}

export interface GlobalExpr extends Base {
  kind: "global_expr";
  name: string;
  typeref: TypeRef;
}

export interface OperatorCall extends Base {
  kind: "operator_call";
  operator: string;
  args: Record<string, CallArg>;
  returning: TypeRef;
  volatility: Volatility;
  operatorKind?: "infix" | "prefix" | "postfix" | "ternary";
  sqlFunction?: string[];
  sqlOperator?: string[];
}

export interface FunctionCall extends Base {
  kind: "function_call";
  functionName: string;
  args: Record<string, CallArg>;
  typeref: TypeRef;
  volatility: Volatility;
  typemod?: TypeModifier;
  tuplePathIds?: PathId[];
  implIsStrict?: boolean;
  preferSubqueryArgs?: boolean;
  preservesOptionality?: boolean;
  preservesUpperCardinality: boolean;
  variadicParamType?: TypeRef;
  globalArgs?: Set[];
  extras?: Record<string, unknown>;
  body?: Set;
}

export interface CallArg extends Base {
  kind: "call_arg";
  expr: Set;
  exprTypePathId?: PathId;
  cardinality: Cardinality;
  multiplicity: Multiplicity;
  isDefault: boolean;
  paramTypemod: TypeModifier;
  polymorphism: Polymorphism;
}

export interface TypeCast extends Base {
  kind: "type_cast";
  fromType: TypeRef;
  toType: TypeRef;
  expr: Set;
  castName?: string;
  cardinalityMod?: "required" | "optional";
  sqlFunction?: string;
  sqlCast?: boolean;
  sqlExpr?: boolean;
  errorMessageContext?: string;
}

export interface SelectExpr extends Base {
  kind: "select_expr";
  result: Set;
  where?: Set;
  orderBy?: SortExpr[];
  offset?: Set;
  limit?: Set;
  implicitWrapper: boolean;
}

export interface InsertExpr extends Base {
  kind: "insert_expr";
  subject: TypeRef;
  shape: ShapeElement[];
}

export interface UpdateExpr extends Base {
  kind: "update_expr";
  subject: TypeRef;
  where?: Set;
  shape: ShapeElement[];
}

export interface DeleteExpr extends Base {
  kind: "delete_expr";
  subject: TypeRef;
  where?: Set;
}

export interface ForExpr extends Base {
  kind: "for_expr";
  iterator: Set;
  body: Set;
  bindingKind: BindingKind;
  optional?: boolean;
  where?: Set;
  orderBy?: SortExpr[];
  limit?: Set;
  offset?: Set;
}

export interface IfElseExpr extends Base {
  kind: "if_else_expr";
  condition: Set;
  ifExpr: Set;
  elseExpr: Set;
}

export interface ExistsExpr extends Base {
  kind: "exists_expr";
  expr: Set;
}

export interface CoalesceExpr extends Base {
  kind: "coalesce_expr";
  left: Set;
  right: Set;
}

export interface SliceExpr extends Base {
  kind: "slice_expr";
  expr: Set;
  start?: Set;
  end?: Set;
}

export interface IndexExpr extends Base {
  kind: "index_expr";
  expr: Set;
  index: Set;
}

export interface TypeIntrospectionExpr extends Base {
  kind: "type_introspection_expr";
  outputTyperef?: TypeRef;
  typeref: TypeRef;
}

export interface TypeCheckOpExpr extends Base {
  kind: "type_check_op";
  left: Set;
  right: TypeRef;
  op: string;
  result?: boolean;
  typeref?: TypeRef;
}

export interface TriggerAnchor extends Base {
  kind: "trigger_anchor";
  anchor: "__old__" | "__new__";
  set: Set;
}

// `(GROUP <subject> BY <atoms>)` in expression position over a general
// (non-link) subject — `WITH g := (GROUP Card BY .element) SELECT g {…}`,
// `SELECT (GROUP …) {…} FILTER …`. Compiles to the same one-row-per-group
// UNION ALL subquery as a top-level GroupStmt (see compileGroupRowsSQL),
// optionally re-projected by `projection` when the wrapping select applies a
// shape over the group rows' virtual `key`/`grouping`/`elements` fields.
// A shape element the projection model can't express marks the whole set
// non-lowerable (`unlowerable`), and the engine falls back to the runtime
// grouper via the legacy pipeline.
export interface GroupRowsExpr extends Base {
  kind: "group_rows";
  group: GroupStmt;
  projection?: GroupRowProjection[];
  unlowerable?: boolean;
  // The group's AST parts (source/using/by — typed loosely to keep AST types
  // out of this module). A projection applied later (`select GR {elements:
  // {name}}` over a WITH binding) may need subject fields the original
  // compile didn't project; the shape_projection compiler rebuilds the
  // GroupStmt from these parts with the subject augmented.
  astParts?: unknown;
}

// A path step chain off a group-rows set (`.key.cost`, `.elements`, or a
// projected name like `.count`) — these aren't schema pointers, so the SQL
// stage resolves them against the group row's JSON value: projected names
// re-emit their projection expression, anything else reads the raw
// `$."step1"."step2"` path.
export interface GroupRowFieldExpr extends Base {
  kind: "group_row_field";
  steps: string[];
}

export type GroupRowProjection =
  // `element := .key.element`, bare `key` / `grouping` / `elements`
  | { name: string; kind: "path"; steps: string[] }
  // `cnt := count(.elements)`
  | { name: string; kind: "count_elements" }
  // `elements: {name, cost, z := .b <= 1}` — re-project each element object
  | { name: string; kind: "elements_shape"; fields: GroupElementsField[] }
  // `key: {cost}` — re-project the key object to a field subset
  | { name: string; kind: "key_shape"; fields: string[] }
  // `name: (select .elements.name limit 1)` — a field of the group's first
  // element (steps are the path AFTER `.elements`)
  | { name: string; kind: "element_first_path"; steps: string[] }
  // `agrouping := array_agg((SELECT _ := .grouping ORDER BY _))` — the
  // grouping-set names as a sorted array (a stable per-set identifier)
  | { name: string; kind: "sorted_grouping" };

export type GroupElementsField =
  // plain field passthrough (`name`)
  | { name: string; kind: "field" }
  // `z := .b <= 1` — an element field path compared against a literal
  | { name: string; kind: "compare"; steps: string[]; op: "=" | "!=" | "<" | "<=" | ">" | ">="; rhs: string | number | boolean }
  // `b: {c, z := .d <= 1}` — re-project a nested object field (recursive)
  | { name: string; kind: "object_shape"; fields: GroupElementsField[] };

// `(GROUP <link> BY <key>)` in expression / shape position. Unlike a top-level
// GROUP (which runs in the runtime grouper), this lowers directly to a
// correlated `GROUP BY` subquery over the link, emitting one JSON object per
// group: `{ key: {...}, [grouping: [...],] elements: [...] }`.
export interface EmbeddedGroupExpr extends Base {
  kind: "embedded_group";
  // The link set being grouped (e.g. `.deck`), as a pointer Set correlated to
  // the enclosing row. Its `shape` is the default `elements` projection.
  source: Set;
  byAtoms: EmbeddedGroupAtom[];
  typeref: TypeRef;
  // Trailing `{ key: {...} }` field names, if a shape was written. Absent ⇒
  // default key (one entry per BY atom).
  keyFields?: string[];
  // Trailing `{ elements: {...} }` projection, if written; else the source
  // link's own shape is used.
  elementsShape?: ShapeElement[];
  // Whether a trailing `{ … }` shape was written at all. When false the full
  // default group row (`key` + `grouping` + `elements`) is emitted.
  hasTrailingShape: boolean;
}

export interface EmbeddedGroupAtom {
  // Key field name (`count` for `@count`, `element` for `.element`).
  name: string;
  // `@count` keys on the link table; `.element` keys on the target row.
  isLinkProperty: boolean;
}

export interface FTSDocumentExpr extends Base {
  kind: "fts_document";
  text: Set;
  language: Set;
  languageDomain: string[];
  weight?: string;
  typeref: TypeRef;
}

export interface StaticIntrospectionExpr extends Base {
  kind: "static_introspection";
  ir: TypeIntrospectionExpr;
  schema?: string;
}

export interface ConfigCommandShape {
  name: string;
  scope: "instance" | "database" | "session" | "global";
  cardinality: "one" | "many" | "unknown";
  requiresRestart: boolean;
  backendSetting?: string;
  isSystemConfig: boolean;
  typeRewrites?: Record<string, Set>;
  globals?: Global[];
  scopeTree?: ScopeTreeNode;
  params: Param[];
  schema?: string;
}

export interface ConfigSetCommand extends Base {
  kind: "config_set";
  command: ConfigCommandShape;
  expr: Set;
  required: boolean;
  backendExpr?: Set;
}

export interface ConfigResetCommand extends Base {
  kind: "config_reset";
  command: ConfigCommandShape;
  selector?: Set;
}

export interface ConfigInsertCommand extends Base {
  kind: "config_insert";
  command: ConfigCommandShape;
  expr: Set;
}

export interface SessionStateCommand extends Base {
  kind: "session_state_cmd";
  modaliases: Record<string, string>;
  testmode: boolean;
}

export interface ServerParamConversion extends Base {
  kind: "server_param_conversion";
  paramName: string;
  conversionName: string;
  additionalInfo: string[];
  scriptParamIndex?: number;
  constantValue?: unknown;
}

export interface ViewShapeMetadata extends Base {
  kind: "view_shape_metadata";
  hasImplicitId: boolean;
}

export interface ReadPolicyExpr extends Base {
  kind: "read_policy_expr";
  expr: Set;
  cardinality: Cardinality;
}

export interface WritePolicy extends Base {
  kind: "write_policy";
  expr: Set;
  action: "allow" | "deny";
  name: string;
  errorMsg?: string;
  cardinality: Cardinality;
}

export interface WritePolicies extends Base {
  kind: "write_policies";
  policies: WritePolicy[];
}

export interface Trigger extends Base {
  kind: "trigger";
  expr: Set;
  affected: Array<{ type: TypeRef; statementKind: "insert" | "update" | "delete" }>;
  allAffectedTypes: TypeRef[];
  sourceType: TypeRef;
  kinds: Array<"insert" | "update" | "delete">;
  scope: "each" | "all";
  newSet: Set;
  oldSet?: Set;
}

export interface OnConflictClause extends Base {
  kind: "on_conflict_clause";
  constraintId?: UUID;
  selectIr: Set;
  alwaysCheck: boolean;
  elseIr?: Set;
  checkAnchor?: PathId;
}

export interface Rewrites extends Base {
  kind: "rewrites";
  oldPathId?: PathId;
  byType: Record<UUID, Record<string, [Set, PointerRef]>>;
}

export type IRNode =
  | TypeRef
  | PointerRef
  | TupleIndirectionPointerRef
  | SpecialPointerRef
  | TypeIntersectionPointerRef
  | PathId
  | ScopeTreeNode
  | MaterializedSet
  | Param
  | Global
  | Set
  | ShapeElement
  | Statement
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | GroupStmt
  | ConfigStmt
  | SortExpr
  | Expr
  | TypeCheckOpExpr
  | FTSDocumentExpr
  | MaterializedExpr
  | VisibleBindingExpr
  | InlinedParameterExpr
  | StaticIntrospectionExpr
  | ConfigSetCommand
  | ConfigResetCommand
  | ConfigInsertCommand
  | SessionStateCommand
  | CallArg
  | ViewShapeMetadata
  | ServerParamConversion
  | ReadPolicyExpr
  | WritePolicy
  | WritePolicies
  | Trigger
  | OnConflictClause
  | Rewrites
  | LegacyConstantCompat;
