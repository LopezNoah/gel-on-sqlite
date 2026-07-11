// AUTO-GENERATED — do not edit by hand.
// Source of truth: edb/edgeql/ast.py (Gel's real EdgeQL AST).
// Regenerate: ../.venv/bin/python scripts/generate-qlast.py
//
// 253 node interfaces, 27 enums.
//
// This mirrors the grammar's single `Expr` hierarchy — unlike the parser's
// current ast.ts, which splits expressions across FilterExpr / ComputedExpr /
// FreeObjectExpr / FunctionCallArgExpr / InsertValue. `kind` is a synthetic
// discriminant (the Python class name); `span`/`system_comment` are omitted.

// qltypes enum
export type AccessKind = "Select" | "UpdateRead" | "UpdateWrite" | "Delete" | "Insert";

// qltypes enum
export type AccessPolicyAction = "Allow" | "Deny";

// ast enum
export type BranchType = "EMPTY" | "SCHEMA" | "DATA" | "TEMPLATE";

// ast enum
export type CardinalityModifier = "OPTIONAL" | "REQUIRED";

// qltypes enum
export type ConfigScope = "INSTANCE" | "DATABASE" | "SESSION" | "GLOBAL";

// ast enum
export type DescribeGlobal = "SCHEMA" | "DATABASE CONFIG" | "INSTANCE CONFIG" | "ROLES";

// qltypes enum
export type DescribeLanguage = "DDL" | "SDL" | "TEXT" | "JSON";

// ast enum
export type Language = "SQL" | "EdgeQL";

// qltypes enum
export type LinkSourceDeleteAction = "DeleteTarget" | "Allow" | "DeleteTargetIfOrphan";

// qltypes enum
export type LinkTargetDeleteAction = "Restrict" | "DeleteSource" | "Allow" | "DeferredRestrict";

// ast enum
export type NonesOrder = "first" | "last";

// qltypes enum
export type OperatorKind = "Infix" | "Postfix" | "Prefix" | "Ternary";

// qltypes enum
export type ParameterKind = "VariadicParam" | "NamedOnlyParam" | "PositionalParam";

// qltypes enum
export type RewriteKind = "Update" | "Insert";

// qltypes enum
export type SchemaCardinality = "One" | "Many" | "Unknown";

// qltypes enum
export type SchemaObjectClass = "ACCESS_POLICY" | "ALIAS" | "ANNOTATION" | "ARRAY TYPE" | "BRANCH" | "CAST" | "CONSTRAINT" | "DATABASE" | "EXTENSION" | "EXTENSION PACKAGE" | "EXTENSION PACKAGE MIGRATION" | "FUTURE" | "FUNCTION" | "GLOBAL" | "INDEX" | "INDEX MATCH" | "LINK" | "MIGRATION" | "MODULE" | "MULTIRANGE_TYPE" | "OPERATOR" | "PARAMETER" | "PERMISSION" | "PROPERTY" | "PSEUDO TYPE" | "RANGE TYPE" | "REWRITE" | "ROLE" | "SCALAR TYPE" | "TRIGGER" | "TUPLE TYPE" | "TYPE";

// ast enum
export type ShapeOp = "APPEND" | "SUBTRACT" | "ASSIGN" | "MATERIALIZE";

// ast enum
export type ShapeOrigin = "EXPLICIT" | "DEFAULT" | "SPLAT_EXPANSION" | "MATERIALIZATION";

// ast enum
export type SortOrder = "ASC" | "DESC";

// qltypes enum
export type TransactionAccessMode = "READ WRITE" | "READ ONLY";

// qltypes enum
export type TransactionDeferMode = "DEFERRABLE" | "NOT DEFERRABLE";

// qltypes enum
export type TransactionIsolationLevel = "REPEATABLE READ" | "SERIALIZABLE";

// qltypes enum
export type TriggerKind = "Update" | "Delete" | "Insert";

// qltypes enum
export type TriggerScope = "Each" | "All";

// qltypes enum
export type TriggerTiming = "After" | "After Commit Of";

// qltypes enum
export type TypeModifier = "SetOfType" | "OptionalType" | "SingletonType";

// ast enum
export type TypeOpName = "|" | "&";

export interface Base {
  __kind__: string;
}

export interface GrammarEntryPoint extends Base {
}

export interface OptionValue extends Base {
  name: string;
}

export interface OptionFlag extends OptionValue {
  __kind__: "OptionFlag";
  val: boolean;
}

export interface Options extends Base {
  __kind__: "Options";
  options: Record<string, OptionValue>;
}

export interface Expr extends GrammarEntryPoint, Base {
}

export interface Placeholder extends Expr {
  __kind__: "Placeholder";
  name: string;
}

export interface SortExpr extends Base {
  __kind__: "SortExpr";
  path: Expr;
  direction?: SortOrder;
  nones_order?: NonesOrder;
}

export interface Alias extends Base {
}

export interface AliasedExpr extends Alias {
  __kind__: "AliasedExpr";
  alias: string;
  expr: Expr;
}

export interface ModuleAliasDecl extends Alias {
  __kind__: "ModuleAliasDecl";
  module: string;
  alias?: string;
}

export interface GroupingAtom extends Base {
}

export interface BaseObjectRef extends Base {
}

export interface ObjectRef extends BaseObjectRef, GroupingAtom {
  __kind__: "ObjectRef";
  name: string;
  module?: string;
  itemclass?: SchemaObjectClass;
}

export interface PseudoObjectRef extends BaseObjectRef {
  __kind__: "PseudoObjectRef";
  name: string;
}

export interface Anchor extends Expr {
  name: string;
}

export interface IRAnchor extends Anchor {
  __kind__: "IRAnchor";
  has_dml: boolean;
  move_scope: boolean;
}

export interface SpecialAnchor extends Anchor {
  __kind__: "SpecialAnchor";
}

export interface Cursor extends Expr {
  __kind__: "Cursor";
}

export interface DetachedExpr extends Expr {
  __kind__: "DetachedExpr";
  expr: Expr;
  preserve_path_prefix: boolean;
}

export interface GlobalExpr extends Expr {
  __kind__: "GlobalExpr";
  name: ObjectRef;
}

export interface Index extends Base {
  __kind__: "Index";
  index: Expr;
}

export interface Slice extends Base {
  __kind__: "Slice";
  start?: Expr;
  stop?: Expr;
}

export interface Indirection extends Expr {
  __kind__: "Indirection";
  arg: Expr;
  indirection: (Index | Slice)[];
}

export interface BinOp extends Expr {
  __kind__: "BinOp";
  left: Expr;
  op: string;
  right: Expr;
  rebalanced: boolean;
  set_constructor: boolean;
}

export interface WindowSpec extends Base {
  __kind__: "WindowSpec";
  orderby: SortExpr[];
  partition: Expr[];
}

export interface FunctionCall extends Expr {
  __kind__: "FunctionCall";
  func: [string, string] | string;
  args: Expr[];
  kwargs: Record<string, Expr>;
  window?: WindowSpec;
}

export interface StrInterpFragment extends Base {
  __kind__: "StrInterpFragment";
  expr: Expr;
  suffix: string;
}

export interface StrInterp extends Expr {
  __kind__: "StrInterp";
  prefix: string;
  interpolations: StrInterpFragment[];
}

export interface BaseConstant extends Expr {
}

export interface Constant extends BaseConstant {
  __kind__: "Constant";
  kind: unknown;
  value: string;
}

export interface BytesConstant extends BaseConstant {
  __kind__: "BytesConstant";
  value: string;
}

export interface QueryParameter extends Expr {
  __kind__: "QueryParameter";
  name: string;
}

export interface FunctionParameter extends Expr {
  __kind__: "FunctionParameter";
  name: string;
}

export interface UnaryOp extends Expr {
  __kind__: "UnaryOp";
  op: string;
  operand: Expr;
}

export interface TypeExpr extends Base {
  name?: string;
}

export interface TypeOf extends TypeExpr {
  __kind__: "TypeOf";
  expr: Expr;
}

export interface TypeExprLiteral extends TypeExpr {
  __kind__: "TypeExprLiteral";
  val: Constant;
}

export interface TypeName extends TypeExpr {
  __kind__: "TypeName";
  maintype: BaseObjectRef;
  subtypes?: TypeExpr[];
  dimensions?: number[];
}

export interface TypeOp extends TypeExpr {
  __kind__: "TypeOp";
  left: TypeExpr;
  op: TypeOpName;
  right: TypeExpr;
}

export interface FuncParamDecl extends Base {
  __kind__: "FuncParamDecl";
  name: string;
  type: TypeExpr;
  typemod: TypeModifier;
  kind: ParameterKind;
  default?: Expr;
}

export interface IsOp extends Expr {
  __kind__: "IsOp";
  left: Expr;
  op: string;
  right: TypeExpr;
}

export interface TypeIntersection extends Base {
  __kind__: "TypeIntersection";
  type: TypeExpr;
}

export interface Ptr extends Base {
  __kind__: "Ptr";
  name: string;
  direction?: string;
  type?: unknown;
}

export interface Splat extends Base {
  __kind__: "Splat";
  depth: number;
  type?: TypeExpr;
  intersection?: TypeIntersection;
}

export interface Path extends Expr, GroupingAtom {
  __kind__: "Path";
  steps: (Expr | Ptr | TypeIntersection | ObjectRef | Splat)[];
  partial: boolean;
  allow_factoring: boolean;
}

export interface TypeCast extends Expr {
  __kind__: "TypeCast";
  expr: Expr;
  type: TypeExpr;
  cardinality_mod?: CardinalityModifier;
}

export interface Introspect extends Expr {
  __kind__: "Introspect";
  type: TypeExpr;
}

export interface IfElse extends Expr {
  __kind__: "IfElse";
  condition: Expr;
  if_expr: Expr;
  else_expr: Expr;
  python_style: boolean;
}

export interface TupleElement extends Base {
  __kind__: "TupleElement";
  name: Ptr;
  val: Expr;
}

export interface NamedTuple extends Expr {
  __kind__: "NamedTuple";
  elements: TupleElement[];
}

export interface Tuple extends Expr {
  __kind__: "Tuple";
  elements: Expr[];
}

export interface Array extends Expr {
  __kind__: "Array";
  elements: Expr[];
}

export interface Set extends Expr {
  __kind__: "Set";
  elements: Expr[];
}

export interface Command extends Base {
  aliases?: Alias[];
}

export interface Commands extends GrammarEntryPoint, Base {
  __kind__: "Commands";
  commands: Command[];
}

export interface SessionSetAliasDecl extends Command {
  __kind__: "SessionSetAliasDecl";
  decl: ModuleAliasDecl;
}

export interface SessionResetAliasDecl extends Command {
  __kind__: "SessionResetAliasDecl";
  alias: string;
}

export interface SessionResetModule extends Command {
  __kind__: "SessionResetModule";
}

export interface SessionResetAllAliases extends Command {
  __kind__: "SessionResetAllAliases";
}

export interface ShapeOperation extends Base {
  __kind__: "ShapeOperation";
  op: ShapeOp;
}

export interface ShapeElement extends Expr {
  __kind__: "ShapeElement";
  expr: Path;
  elements?: ShapeElement[];
  compexpr?: Expr;
  cardinality?: SchemaCardinality;
  required?: boolean;
  operation: ShapeOperation;
  origin: ShapeOrigin;
  where?: Expr;
  orderby?: SortExpr[];
  offset?: Expr;
  limit?: Expr;
}

export interface Shape extends Expr {
  __kind__: "Shape";
  expr?: Expr;
  elements: ShapeElement[];
  allow_factoring: boolean;
}

export interface Query extends Expr, GrammarEntryPoint, Command {
  aliases?: Alias[];
}

export interface SelectQuery extends Query {
  __kind__: "SelectQuery";
  result_alias?: string;
  result: Expr;
  where?: Expr;
  orderby?: SortExpr[];
  offset?: Expr;
  limit?: Expr;
  rptr_passthrough: boolean;
  implicit: boolean;
}

export interface GroupingIdentList extends GroupingAtom, Base {
  __kind__: "GroupingIdentList";
  elements: GroupingAtom[];
}

export interface GroupingElement extends Base {
}

export interface GroupingSimple extends GroupingElement {
  __kind__: "GroupingSimple";
  element: GroupingAtom;
}

export interface GroupingSets extends GroupingElement {
  __kind__: "GroupingSets";
  sets: GroupingElement[];
}

export interface GroupingOperation extends GroupingElement {
  __kind__: "GroupingOperation";
  oper: string;
  elements: GroupingAtom[];
}

export interface GroupQuery extends Query {
  __kind__: "GroupQuery";
  subject_alias?: string;
  using?: AliasedExpr[];
  by: GroupingElement[];
  subject: Expr;
}

export interface InternalGroupQuery extends Query {
  __kind__: "InternalGroupQuery";
  subject_alias?: string;
  using?: AliasedExpr[];
  by: GroupingElement[];
  subject: Expr;
  group_alias: string;
  grouping_alias?: string;
  from_desugaring: boolean;
  result_alias?: string;
  result: Expr;
  where?: Expr;
  orderby?: SortExpr[];
}

export interface InsertQuery extends Query {
  __kind__: "InsertQuery";
  subject: ObjectRef;
  shape: ShapeElement[];
  unless_conflict?: [Expr, Expr];
}

export interface UpdateQuery extends Query {
  __kind__: "UpdateQuery";
  shape: ShapeElement[];
  subject: Expr;
  where?: Expr;
}

export interface DeleteQuery extends Query {
  __kind__: "DeleteQuery";
  subject: Expr;
  where?: Expr;
  orderby?: SortExpr[];
  offset?: Expr;
  limit?: Expr;
}

export interface ForQuery extends Query {
  __kind__: "ForQuery";
  from_desugaring: boolean;
  has_union: boolean;
  optional: boolean;
  iterator: Expr;
  iterator_alias: string;
  result_alias?: string;
  result: Expr;
}

export interface Transaction extends Base {
}

export interface StartTransaction extends Transaction {
  __kind__: "StartTransaction";
  isolation?: TransactionIsolationLevel;
  access?: TransactionAccessMode;
  deferrable?: TransactionDeferMode;
}

export interface CommitTransaction extends Transaction {
  __kind__: "CommitTransaction";
}

export interface RollbackTransaction extends Transaction {
  __kind__: "RollbackTransaction";
}

export interface DeclareSavepoint extends Transaction {
  __kind__: "DeclareSavepoint";
  name: string;
}

export interface RollbackToSavepoint extends Transaction {
  __kind__: "RollbackToSavepoint";
  name: string;
}

export interface ReleaseSavepoint extends Transaction {
  __kind__: "ReleaseSavepoint";
  name: string;
}

export interface DDL extends Base {
}

export interface Position extends DDL {
  __kind__: "Position";
  ref?: ObjectRef;
  position: string;
}

export interface DDLOperation extends DDL {
  commands: DDLOperation[];
}

export interface DDLCommand extends DDLOperation, Command {
}

export interface DDLQuery extends DDLCommand {
  __kind__: "DDLQuery";
  query: Query;
}

export interface NonTransactionalDDLCommand extends DDLCommand {
}

export interface AlterAddInherit extends DDLOperation {
  __kind__: "AlterAddInherit";
  position?: Position;
  bases: TypeName[];
}

export interface AlterDropInherit extends DDLOperation {
  __kind__: "AlterDropInherit";
  bases: TypeName[];
}

export interface OnTargetDelete extends DDLOperation {
  __kind__: "OnTargetDelete";
  cascade?: LinkTargetDeleteAction;
}

export interface OnSourceDelete extends DDLOperation {
  __kind__: "OnSourceDelete";
  cascade?: LinkSourceDeleteAction;
}

export interface SetField extends DDLOperation {
  name: string;
  value?: Expr | TypeExpr;
  special_syntax: boolean;
}

export interface SetPointerType extends SetField {
  __kind__: "SetPointerType";
  name: string;
  value?: TypeExpr;
  special_syntax: boolean;
  cast_expr?: Expr;
}

export interface SetPointerCardinality extends SetField {
  __kind__: "SetPointerCardinality";
  name: string;
  special_syntax: boolean;
  conv_expr?: Expr;
}

export interface SetPointerOptionality extends SetField {
  __kind__: "SetPointerOptionality";
  name: string;
  special_syntax: boolean;
  fill_expr?: Expr;
}

export interface ObjectDDL extends DDLCommand {
  name: ObjectRef;
}

export interface CreateObject extends ObjectDDL {
  abstract: boolean;
  sdl_alter_if_exists: boolean;
  create_if_not_exists: boolean;
}

export interface AlterObject extends ObjectDDL {
}

export interface DropObject extends ObjectDDL {
}

export interface CreateExtendingObject extends CreateObject {
  final: boolean;
  bases: TypeName[];
}

export interface Rename extends ObjectDDL {
  __kind__: "Rename";
  new_name: ObjectRef;
}

export interface NestedQLBlock extends DDL {
  __kind__: "NestedQLBlock";
  commands: DDLOperation[];
  text?: string;
}

export interface MigrationCommand extends DDLCommand {
}

export interface CreateMigration extends CreateObject, MigrationCommand, GrammarEntryPoint {
  __kind__: "CreateMigration";
  body: NestedQLBlock;
  parent?: ObjectRef;
  metadata_only: boolean;
  target_sdl?: string;
}

export interface CommittedSchema extends DDL {
  __kind__: "CommittedSchema";
}

export interface StartMigration extends MigrationCommand {
  __kind__: "StartMigration";
  target: unknown | CommittedSchema;
}

export interface AbortMigration extends MigrationCommand {
  __kind__: "AbortMigration";
}

export interface PopulateMigration extends MigrationCommand {
  __kind__: "PopulateMigration";
}

export interface AlterCurrentMigrationRejectProposed extends MigrationCommand {
  __kind__: "AlterCurrentMigrationRejectProposed";
}

export interface DescribeCurrentMigration extends MigrationCommand {
  __kind__: "DescribeCurrentMigration";
  language: DescribeLanguage;
}

export interface CommitMigration extends MigrationCommand {
  __kind__: "CommitMigration";
}

export interface AlterMigration extends AlterObject, MigrationCommand {
  __kind__: "AlterMigration";
}

export interface DropMigration extends DropObject, MigrationCommand {
  __kind__: "DropMigration";
}

export interface ResetSchema extends MigrationCommand {
  __kind__: "ResetSchema";
  target: ObjectRef;
}

export interface StartMigrationRewrite extends MigrationCommand {
  __kind__: "StartMigrationRewrite";
}

export interface AbortMigrationRewrite extends MigrationCommand {
  __kind__: "AbortMigrationRewrite";
}

export interface CommitMigrationRewrite extends MigrationCommand {
  __kind__: "CommitMigrationRewrite";
}

export interface UnqualifiedObjectCommand extends ObjectDDL {
}

export interface GlobalObjectCommand extends UnqualifiedObjectCommand {
}

export interface DatabaseCommand extends GlobalObjectCommand, NonTransactionalDDLCommand {
  flavor: SchemaObjectClass;
}

export interface CreateDatabase extends CreateObject, DatabaseCommand {
  __kind__: "CreateDatabase";
  template?: ObjectRef;
  branch_type: BranchType;
}

export interface AlterDatabase extends AlterObject, DatabaseCommand {
  __kind__: "AlterDatabase";
  force: boolean;
}

export interface DropDatabase extends DropObject, DatabaseCommand {
  __kind__: "DropDatabase";
  force: boolean;
}

export interface ExtensionPackageCommand extends GlobalObjectCommand {
  version: Constant;
}

export interface CreateExtensionPackage extends CreateObject, ExtensionPackageCommand {
  __kind__: "CreateExtensionPackage";
  body: NestedQLBlock;
}

export interface DropExtensionPackage extends DropObject, ExtensionPackageCommand {
  __kind__: "DropExtensionPackage";
}

export interface ExtensionPackageMigrationCommand extends GlobalObjectCommand {
}

export interface CreateExtensionPackageMigration extends CreateObject, ExtensionPackageMigrationCommand {
  __kind__: "CreateExtensionPackageMigration";
  from_version: Constant;
  to_version: Constant;
  body: NestedQLBlock;
}

export interface DropExtensionPackageMigration extends DropObject, ExtensionPackageMigrationCommand {
  __kind__: "DropExtensionPackageMigration";
  from_version: Constant;
  to_version: Constant;
}

export interface ExtensionCommand extends UnqualifiedObjectCommand {
}

export interface CreateExtension extends CreateObject, ExtensionCommand {
  __kind__: "CreateExtension";
  version?: Constant;
}

export interface AlterExtension extends DropObject, ExtensionCommand {
  __kind__: "AlterExtension";
  version?: Constant;
  to_version: Constant;
}

export interface DropExtension extends DropObject, ExtensionCommand {
  __kind__: "DropExtension";
  version?: Constant;
}

export interface FutureCommand extends UnqualifiedObjectCommand {
}

export interface CreateFuture extends CreateObject, FutureCommand {
  __kind__: "CreateFuture";
}

export interface DropFuture extends DropObject, FutureCommand {
  __kind__: "DropFuture";
}

export interface ModuleCommand extends UnqualifiedObjectCommand {
}

export interface CreateModule extends ModuleCommand, CreateObject {
  __kind__: "CreateModule";
}

export interface AlterModule extends ModuleCommand, AlterObject {
  __kind__: "AlterModule";
}

export interface DropModule extends ModuleCommand, DropObject {
  __kind__: "DropModule";
}

export interface RoleCommand extends GlobalObjectCommand {
}

export interface CreateRole extends CreateObject, RoleCommand {
  __kind__: "CreateRole";
  superuser: boolean;
  bases: TypeName[];
}

export interface AlterRole extends AlterObject, RoleCommand {
  __kind__: "AlterRole";
}

export interface DropRole extends DropObject, RoleCommand {
  __kind__: "DropRole";
}

export interface AnnotationCommand extends ObjectDDL {
}

export interface CreateAnnotation extends CreateExtendingObject, AnnotationCommand {
  __kind__: "CreateAnnotation";
  type?: TypeExpr;
  inheritable: boolean;
}

export interface AlterAnnotation extends AlterObject, AnnotationCommand {
  __kind__: "AlterAnnotation";
}

export interface DropAnnotation extends DropObject, AnnotationCommand {
  __kind__: "DropAnnotation";
}

export interface PseudoTypeCommand extends ObjectDDL {
}

export interface CreatePseudoType extends CreateObject, PseudoTypeCommand {
  __kind__: "CreatePseudoType";
}

export interface ScalarTypeCommand extends ObjectDDL {
}

export interface CreateScalarType extends CreateExtendingObject, ScalarTypeCommand {
  __kind__: "CreateScalarType";
}

export interface AlterScalarType extends AlterObject, ScalarTypeCommand {
  __kind__: "AlterScalarType";
}

export interface DropScalarType extends DropObject, ScalarTypeCommand {
  __kind__: "DropScalarType";
}

export interface PropertyCommand extends ObjectDDL {
}

export interface CreateProperty extends CreateExtendingObject, PropertyCommand {
  __kind__: "CreateProperty";
}

export interface AlterProperty extends AlterObject, PropertyCommand {
  __kind__: "AlterProperty";
}

export interface DropProperty extends DropObject, PropertyCommand {
  __kind__: "DropProperty";
}

export interface CreateConcretePointer extends CreateObject {
  is_required?: boolean;
  declared_overloaded: boolean;
  target?: Expr | TypeExpr;
  cardinality: SchemaCardinality;
  bases: TypeName[];
}

export interface CreateConcreteUnknownPointer extends CreateConcretePointer {
  __kind__: "CreateConcreteUnknownPointer";
}

export interface AlterConcreteUnknownPointer extends AlterObject, PropertyCommand {
  __kind__: "AlterConcreteUnknownPointer";
}

export interface CreateConcreteProperty extends CreateConcretePointer, PropertyCommand {
  __kind__: "CreateConcreteProperty";
}

export interface AlterConcreteProperty extends AlterObject, PropertyCommand {
  __kind__: "AlterConcreteProperty";
}

export interface DropConcreteProperty extends DropObject, PropertyCommand {
  __kind__: "DropConcreteProperty";
}

export interface ObjectTypeCommand extends ObjectDDL {
}

export interface CreateObjectType extends CreateExtendingObject, ObjectTypeCommand {
  __kind__: "CreateObjectType";
}

export interface AlterObjectType extends AlterObject, ObjectTypeCommand {
  __kind__: "AlterObjectType";
}

export interface DropObjectType extends DropObject, ObjectTypeCommand {
  __kind__: "DropObjectType";
}

export interface AliasCommand extends ObjectDDL {
}

export interface CreateAlias extends CreateObject, AliasCommand {
  __kind__: "CreateAlias";
}

export interface AlterAlias extends AlterObject, AliasCommand {
  __kind__: "AlterAlias";
}

export interface DropAlias extends DropObject, AliasCommand {
  __kind__: "DropAlias";
}

export interface GlobalCommand extends ObjectDDL {
}

export interface CreateGlobal extends CreateObject, GlobalCommand {
  __kind__: "CreateGlobal";
  is_required?: boolean;
  target?: Expr | TypeExpr;
  cardinality?: SchemaCardinality;
}

export interface AlterGlobal extends AlterObject, GlobalCommand {
  __kind__: "AlterGlobal";
}

export interface DropGlobal extends DropObject, GlobalCommand {
  __kind__: "DropGlobal";
}

export interface SetGlobalType extends SetField {
  __kind__: "SetGlobalType";
  name: string;
  value?: TypeExpr;
  special_syntax: boolean;
  cast_expr?: Expr;
  reset_value: boolean;
}

export interface PermissionCommand extends ObjectDDL {
}

export interface CreatePermission extends CreateObject, PermissionCommand {
  __kind__: "CreatePermission";
}

export interface AlterPermission extends AlterObject, PermissionCommand {
  __kind__: "AlterPermission";
}

export interface DropPermission extends DropObject, PermissionCommand {
  __kind__: "DropPermission";
}

export interface LinkCommand extends ObjectDDL {
}

export interface CreateLink extends CreateExtendingObject, LinkCommand {
  __kind__: "CreateLink";
}

export interface AlterLink extends AlterObject, LinkCommand {
  __kind__: "AlterLink";
}

export interface DropLink extends DropObject, LinkCommand {
  __kind__: "DropLink";
}

export interface CreateConcreteLink extends CreateExtendingObject, CreateConcretePointer, LinkCommand {
  __kind__: "CreateConcreteLink";
}

export interface AlterConcreteLink extends AlterObject, LinkCommand {
  __kind__: "AlterConcreteLink";
}

export interface DropConcreteLink extends DropObject, LinkCommand {
  __kind__: "DropConcreteLink";
}

export interface ConstraintCommand extends ObjectDDL {
}

export interface CreateConstraint extends CreateExtendingObject, ConstraintCommand {
  __kind__: "CreateConstraint";
  abstract: boolean;
  subjectexpr?: Expr;
  params: FuncParamDecl[];
}

export interface AlterConstraint extends AlterObject, ConstraintCommand {
  __kind__: "AlterConstraint";
}

export interface DropConstraint extends DropObject, ConstraintCommand {
  __kind__: "DropConstraint";
}

export interface ConcreteConstraintOp extends ConstraintCommand {
  args: Expr[];
  subjectexpr?: Expr;
  except_expr?: Expr;
}

export interface CreateConcreteConstraint extends ConcreteConstraintOp, CreateObject {
  __kind__: "CreateConcreteConstraint";
  delegated: boolean;
}

export interface AlterConcreteConstraint extends ConcreteConstraintOp, AlterObject {
  __kind__: "AlterConcreteConstraint";
}

export interface DropConcreteConstraint extends ConcreteConstraintOp, DropObject {
  __kind__: "DropConcreteConstraint";
}

export interface IndexType extends DDL {
  __kind__: "IndexType";
  name: ObjectRef;
  args: Expr[];
  kwargs: Record<string, Expr>;
}

export interface IndexCommand extends ObjectDDL {
}

export interface IndexCode extends DDL {
  __kind__: "IndexCode";
  language: unknown;
  code: string;
}

export interface CreateIndex extends CreateExtendingObject, IndexCommand {
  __kind__: "CreateIndex";
  kwargs: Record<string, Expr>;
  index_types: IndexType[];
  code?: IndexCode;
  params: FuncParamDecl[];
}

export interface AlterIndex extends AlterObject, IndexCommand {
  __kind__: "AlterIndex";
}

export interface DropIndex extends DropObject, IndexCommand {
  __kind__: "DropIndex";
}

export interface IndexMatchCommand extends ObjectDDL {
  valid_type: TypeName;
}

export interface CreateIndexMatch extends CreateObject, IndexMatchCommand {
  __kind__: "CreateIndexMatch";
}

export interface DropIndexMatch extends DropObject, IndexMatchCommand {
  __kind__: "DropIndexMatch";
}

export interface ConcreteIndexCommand extends IndexCommand {
  kwargs: Record<string, Expr>;
  expr: Expr;
  except_expr?: Expr;
  deferred: boolean;
}

export interface CreateConcreteIndex extends ConcreteIndexCommand, CreateObject {
  __kind__: "CreateConcreteIndex";
}

export interface AlterConcreteIndex extends ConcreteIndexCommand, AlterObject {
  __kind__: "AlterConcreteIndex";
}

export interface DropConcreteIndex extends ConcreteIndexCommand, DropObject {
  __kind__: "DropConcreteIndex";
}

export interface CreateAnnotationValue extends AnnotationCommand, CreateObject {
  __kind__: "CreateAnnotationValue";
  value: Expr;
}

export interface AlterAnnotationValue extends AnnotationCommand, AlterObject {
  __kind__: "AlterAnnotationValue";
  value?: Expr;
}

export interface DropAnnotationValue extends AnnotationCommand, DropObject {
  __kind__: "DropAnnotationValue";
}

export interface AccessPolicyCommand extends ObjectDDL {
}

export interface CreateAccessPolicy extends CreateObject, AccessPolicyCommand {
  __kind__: "CreateAccessPolicy";
  condition?: Expr;
  action: AccessPolicyAction;
  access_kinds: AccessKind[];
  expr?: Expr;
}

export interface SetAccessPerms extends DDLOperation {
  __kind__: "SetAccessPerms";
  access_kinds: AccessKind[];
  action: AccessPolicyAction;
}

export interface AlterAccessPolicy extends AlterObject, AccessPolicyCommand {
  __kind__: "AlterAccessPolicy";
}

export interface DropAccessPolicy extends DropObject, AccessPolicyCommand {
  __kind__: "DropAccessPolicy";
}

export interface TriggerCommand extends ObjectDDL {
}

export interface CreateTrigger extends CreateObject, TriggerCommand {
  __kind__: "CreateTrigger";
  timing: TriggerTiming;
  kinds: TriggerKind[];
  scope: TriggerScope;
  expr: Expr;
  condition?: Expr;
}

export interface AlterTrigger extends AlterObject, TriggerCommand {
  __kind__: "AlterTrigger";
}

export interface DropTrigger extends DropObject, TriggerCommand {
  __kind__: "DropTrigger";
}

export interface RewriteCommand extends ObjectDDL {
  kinds: RewriteKind[];
}

export interface CreateRewrite extends CreateObject, RewriteCommand {
  __kind__: "CreateRewrite";
  expr: Expr;
}

export interface AlterRewrite extends AlterObject, RewriteCommand {
  __kind__: "AlterRewrite";
}

export interface DropRewrite extends DropObject, RewriteCommand {
  __kind__: "DropRewrite";
}

export interface FunctionCode extends DDL {
  __kind__: "FunctionCode";
  language: Language;
  code?: string;
  nativecode?: Expr;
  from_function?: string;
  from_expr: boolean;
}

export interface FunctionCommand extends DDLCommand {
  params: FuncParamDecl[];
}

export interface CreateFunction extends CreateObject, FunctionCommand {
  __kind__: "CreateFunction";
  returning: TypeExpr;
  code: FunctionCode;
  nativecode?: Expr;
  returning_typemod: TypeModifier;
}

export interface AlterFunction extends AlterObject, FunctionCommand {
  __kind__: "AlterFunction";
  code: FunctionCode;
  nativecode?: Expr;
}

export interface DropFunction extends DropObject, FunctionCommand {
  __kind__: "DropFunction";
}

export interface OperatorCode extends DDL {
  __kind__: "OperatorCode";
  language: Language;
  from_operator?: string[];
  from_function?: string[];
  from_expr: boolean;
  code?: string;
}

export interface OperatorCommand extends DDLCommand {
  kind: OperatorKind;
  params: FuncParamDecl[];
}

export interface CreateOperator extends CreateObject, OperatorCommand {
  __kind__: "CreateOperator";
  returning: TypeExpr;
  returning_typemod: TypeModifier;
  code: OperatorCode;
}

export interface AlterOperator extends AlterObject, OperatorCommand {
  __kind__: "AlterOperator";
}

export interface DropOperator extends DropObject, OperatorCommand {
  __kind__: "DropOperator";
}

export interface CastCode extends DDL {
  __kind__: "CastCode";
  language: Language;
  from_function: string;
  from_expr: boolean;
  from_cast: boolean;
  code: string;
}

export interface CastCommand extends ObjectDDL {
  from_type: TypeName;
  to_type: TypeName;
}

export interface CreateCast extends CreateObject, CastCommand {
  __kind__: "CreateCast";
  code: CastCode;
  allow_implicit: boolean;
  allow_assignment: boolean;
}

export interface AlterCast extends AlterObject, CastCommand {
  __kind__: "AlterCast";
}

export interface DropCast extends DropObject, CastCommand {
  __kind__: "DropCast";
}

export interface OptionalExpr extends Expr {
  __kind__: "OptionalExpr";
  expr: Expr;
}

export interface ConfigOp extends Base {
  name: ObjectRef;
  scope: ConfigScope;
}

export interface ConfigSet extends ConfigOp {
  __kind__: "ConfigSet";
  expr: Expr;
}

export interface ConfigInsert extends ConfigOp {
  __kind__: "ConfigInsert";
  shape: ShapeElement[];
}

export interface ConfigReset extends ConfigOp {
  __kind__: "ConfigReset";
  where?: Expr;
}

export interface DescribeStmt extends Command {
  __kind__: "DescribeStmt";
  language: DescribeLanguage;
  object: ObjectRef | DescribeGlobal;
  options: Options;
}

export interface ExplainStmt extends Command {
  __kind__: "ExplainStmt";
  args?: NamedTuple;
  query: Query;
}

export interface AdministerStmt extends Command {
  __kind__: "AdministerStmt";
  expr: FunctionCall;
}

export interface SDL extends Base {
}

export interface ModuleDeclaration extends SDL {
  __kind__: "ModuleDeclaration";
  name: ObjectRef;
  declarations: (ObjectDDL | ModuleDeclaration)[];
}

export interface Schema extends SDL, GrammarEntryPoint, Base {
  __kind__: "Schema";
  declarations: (ObjectDDL | ModuleDeclaration)[];
}
