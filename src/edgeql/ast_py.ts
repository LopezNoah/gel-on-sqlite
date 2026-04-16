// Auto-generated from edb/edgeql/ast.py
// This file mirrors the upstream EdgeQL AST node layout for TypeScript tooling.

export type Span = unknown;

export enum SortOrder {
  Asc = "ASC",
  Desc = "DESC",
}

export enum NonesOrder {
  First = "first",
  Last = "last",
}

export enum CardinalityModifier {
  Optional = "OPTIONAL",
  Required = "REQUIRED",
}

export enum DescribeGlobal {
  Schema = "SCHEMA",
  DatabaseConfig = "DATABASE CONFIG",
  InstanceConfig = "INSTANCE CONFIG",
  Roles = "ROLES",
}

export enum ConstantKind {
  STRING = "STRING",
  BOOLEAN = "BOOLEAN",
  INTEGER = "INTEGER",
  FLOAT = "FLOAT",
  BIGINT = "BIGINT",
  DECIMAL = "DECIMAL",
}

export enum TypeOpName {
  OR = "|",
  AND = "&",
}

export enum ShapeOp {
  APPEND = "APPEND",
  SUBTRACT = "SUBTRACT",
  ASSIGN = "ASSIGN",
  MATERIALIZE = "MATERIALIZE",
}

export enum ShapeOrigin {
  EXPLICIT = "EXPLICIT",
  DEFAULT = "DEFAULT",
  SPLAT_EXPANSION = "SPLAT_EXPANSION",
  MATERIALIZATION = "MATERIALIZATION",
}

export enum BranchType {
  EMPTY = "EMPTY",
  SCHEMA = "SCHEMA",
  DATA = "DATA",
  TEMPLATE = "TEMPLATE",
}

export enum Language {
  SQL = "SQL",
  EdgeQL = "EdgeQL",
}

export const SortAsc = SortOrder.Asc;
export const SortDesc = SortOrder.Desc;
export const SortDefault = SortAsc;
export const NonesFirst = NonesOrder.First;
export const NonesLast = NonesOrder.Last;

export type PathElement = Expr | Ptr | TypeIntersection | ObjectRef | Splat;
export type SessionCommand = SessionSetAliasDecl | SessionResetAliasDecl | SessionResetModule | SessionResetAllAliases;
export type ReturningQuery = SelectQuery | ForQuery | InternalGroupQuery;
export type FilteringQuery = SelectQuery | DeleteQuery | ShapeElement | UpdateQuery | ConfigReset;
export type SubjectQuery = DeleteQuery | UpdateQuery | GroupQuery;
export type OffsetLimitQuery = SelectQuery | DeleteQuery | ShapeElement;
export type BasedOn = AlterAddInherit | AlterDropInherit | CreateExtendingObject | CreateRole | CreateConcretePointer;
export type CallableObjectCommand = CreateConstraint | CreateIndex | FunctionCommand | OperatorCommand;
export type Statement = Query | Command;

export interface Base {
  span: Span | null | undefined;
  system_comment: string | null | undefined;
}

export interface GrammarEntryPoint extends Base {
}

export interface OptionValue extends Base {
  name: string;
}

export interface OptionFlag extends OptionValue {
  val: boolean;
}

export interface Options extends Base {
  options: Record<string, OptionValue> | undefined;
}

export interface Expr extends GrammarEntryPoint, Base {
}

export interface Placeholder extends Expr {
  name: string;
}

export interface SortExpr extends Base {
  path: Expr;
  direction: SortOrder | null | undefined;
  nones_order: NonesOrder | null | undefined;
}

export interface Alias extends Base {
}

export interface AliasedExpr extends Alias {
  alias: string;
  expr: Expr;
}

export interface ModuleAliasDecl extends Alias {
  module: string;
  alias: string | null;
}

export interface GroupingAtom extends Base {
}

export interface BaseObjectRef extends Base {
}

export interface ObjectRef extends BaseObjectRef, GroupingAtom {
  name: string;
  module: string | null | undefined;
  itemclass: string | null | undefined;
}

export interface PseudoObjectRef extends BaseObjectRef {
  name: string;
}

export interface Anchor extends Expr {
  name: string;
}

export interface IRAnchor extends Anchor {
  has_dml: boolean | undefined;
  move_scope: boolean | undefined;
}

export interface SpecialAnchor extends Anchor {
}

export interface Cursor extends Expr {
}

export interface DetachedExpr extends Expr {
  expr: Expr;
  preserve_path_prefix: boolean | undefined;
}

export interface GlobalExpr extends Expr {
  name: ObjectRef;
}

export interface Index extends Base {
  index: Expr;
}

export interface Slice extends Base {
  start: Expr | null;
  stop: Expr | null;
}

export interface Indirection extends Expr {
  arg: Expr;
  indirection: Index | Slice[];
}

export interface BinOp extends Expr {
  left: Expr;
  op: string;
  right: Expr;
  rebalanced: boolean | undefined;
  set_constructor: boolean | undefined;
}

export interface WindowSpec extends Base {
  orderby: SortExpr[];
  partition: Expr[];
}

export interface FunctionCall extends Expr {
  func: [string, string] | string;
  args: Expr[] | undefined;
  kwargs: Record<string, Expr> | undefined;
  window: WindowSpec | null | undefined;
}

export interface StrInterpFragment extends Base {
  expr: Expr;
  suffix: string;
}

export interface StrInterp extends Expr {
  prefix: string;
  interpolations: StrInterpFragment[];
}

export interface BaseConstant extends Expr {
}

export interface Constant extends BaseConstant {
  kind: ConstantKind;
  value: string;
}

export interface BytesConstant extends BaseConstant {
  value: string;
}

export interface QueryParameter extends Expr {
  name: string;
}

export interface FunctionParameter extends Expr {
  name: string;
}

export interface UnaryOp extends Expr {
  op: string;
  operand: Expr;
}

export interface TypeExpr extends Base {
  name: string | null | undefined;
}

export interface TypeOf extends TypeExpr {
  expr: Expr;
}

export interface TypeExprLiteral extends TypeExpr {
  val: Constant;
}

export interface TypeName extends TypeExpr {
  maintype: BaseObjectRef;
  subtypes: TypeExpr[] | null | undefined;
  dimensions: number[] | null | undefined;
}

export interface TypeOp extends TypeExpr {
  left: TypeExpr;
  op: TypeOpName;
  right: TypeExpr;
}

export interface FuncParamDecl extends Base {
  name: string;
  type: TypeExpr;
  typemod: string | undefined;
  kind: string;
  default: Expr | null | undefined;
}

export interface IsOp extends Expr {
  left: Expr;
  op: string;
  right: TypeExpr;
}

export interface TypeIntersection extends Base {
  type: TypeExpr;
}

export interface Ptr extends Base {
  name: string;
  direction: string | null | undefined;
  type: "optional" | "property" | null | undefined;
}

export interface Splat extends Base {
  depth: number;
  type: TypeExpr | null | undefined;
  intersection: TypeIntersection | null | undefined;
}

export interface Path extends Expr, GroupingAtom {
  steps: PathElement[];
  partial: boolean | undefined;
  allow_factoring: boolean | undefined;
}

export interface TypeCast extends Expr {
  expr: Expr;
  type: TypeExpr;
  cardinality_mod: CardinalityModifier | null | undefined;
}

export interface Introspect extends Expr {
  type: TypeExpr;
}

export interface IfElse extends Expr {
  condition: Expr;
  if_expr: Expr;
  else_expr: Expr;
  python_style: boolean | undefined;
}

export interface TupleElement extends Base {
  name: Ptr;
  val: Expr;
}

export interface NamedTuple extends Expr {
  elements: TupleElement[];
}

export interface Tuple extends Expr {
  elements: Expr[];
}

export interface Array extends Expr {
  elements: Expr[];
}

export interface Set extends Expr {
  elements: Expr[];
}

export interface Command extends Base {
  aliases: Alias[] | null | undefined;
}

export interface Commands extends GrammarEntryPoint, Base {
  commands: Command[];
}

export interface SessionSetAliasDecl extends Command {
  decl: ModuleAliasDecl;
}

export interface SessionResetAliasDecl extends Command {
  alias: string;
}

export interface SessionResetModule extends Command {
}

export interface SessionResetAllAliases extends Command {
}

export interface ShapeOperation extends Base {
  op: ShapeOp;
}

export interface ShapeElement extends Expr {
  expr: Path;
  elements: ShapeElement[] | null | undefined;
  compexpr: Expr | null | undefined;
  cardinality: string | null | undefined;
  required: boolean | null | undefined;
  operation: ShapeOperation | undefined;
  origin: ShapeOrigin | undefined;
  where: Expr | null | undefined;
  orderby: SortExpr[] | null | undefined;
  offset: Expr | null | undefined;
  limit: Expr | null | undefined;
}

export interface Shape extends Expr {
  expr: Expr | null;
  elements: ShapeElement[];
  allow_factoring: boolean | undefined;
}

export interface Query extends Expr, GrammarEntryPoint, Command {
}

export interface SelectQuery extends Query {
  result_alias: string | null | undefined;
  result: Expr;
  where: Expr | null | undefined;
  orderby: SortExpr[] | null | undefined;
  offset: Expr | null | undefined;
  limit: Expr | null | undefined;
  rptr_passthrough: boolean | undefined;
  implicit: boolean | undefined;
}

export interface GroupingIdentList extends GroupingAtom, Base {
  elements: GroupingAtom[];
}

export interface GroupingElement extends Base {
}

export interface GroupingSimple extends GroupingElement {
  element: GroupingAtom;
}

export interface GroupingSets extends GroupingElement {
  sets: GroupingElement[];
}

export interface GroupingOperation extends GroupingElement {
  oper: string;
  elements: GroupingAtom[];
}

export interface GroupQuery extends Query {
  subject_alias: string | null | undefined;
  using: AliasedExpr[] | null;
  by: GroupingElement[];
  subject: Expr;
}

export interface InternalGroupQuery extends Query {
  subject_alias: string | null | undefined;
  using: AliasedExpr[] | null;
  by: GroupingElement[];
  subject: Expr;
  group_alias: string;
  grouping_alias: string | null;
  from_desugaring: boolean | undefined;
  result_alias: string | null | undefined;
  result: Expr;
  where: Expr | null | undefined;
  orderby: SortExpr[] | null | undefined;
}

export interface InsertQuery extends Query {
  subject: ObjectRef;
  shape: ShapeElement[];
  unless_conflict: [Expr | null, Expr | null] | null | undefined;
}

export interface UpdateQuery extends Query {
  shape: ShapeElement[];
  subject: Expr;
  where: Expr | null | undefined;
}

export interface DeleteQuery extends Query {
  subject: Expr;
  where: Expr | null | undefined;
  orderby: SortExpr[] | null | undefined;
  offset: Expr | null | undefined;
  limit: Expr | null | undefined;
}

export interface ForQuery extends Query {
  from_desugaring: boolean | undefined;
  has_union: boolean | undefined;
  optional: boolean | undefined;
  iterator: Expr;
  iterator_alias: string;
  result_alias: string | null | undefined;
  result: Expr;
}

export interface Transaction extends Base {
}

export interface StartTransaction extends Transaction {
  isolation: string | null | undefined;
  access: string | null | undefined;
  deferrable: string | null | undefined;
}

export interface CommitTransaction extends Transaction {
}

export interface RollbackTransaction extends Transaction {
}

export interface DeclareSavepoint extends Transaction {
  name: string;
}

export interface RollbackToSavepoint extends Transaction {
  name: string;
}

export interface ReleaseSavepoint extends Transaction {
  name: string;
}

export interface DDL extends Base {
}

export interface Position extends DDL {
  ref: ObjectRef | null | undefined;
  position: string;
}

export interface DDLOperation extends DDL {
  commands: DDLOperation[] | undefined;
}

export interface DDLCommand extends DDLOperation, Command {
}

export interface DDLQuery extends DDLCommand {
  query: Query;
}

export interface NonTransactionalDDLCommand extends DDLCommand {
}

export interface AlterAddInherit extends DDLOperation {
  position: Position | null | undefined;
  bases: TypeName[];
}

export interface AlterDropInherit extends DDLOperation {
  bases: TypeName[];
}

export interface OnTargetDelete extends DDLOperation {
  cascade: string | null;
}

export interface OnSourceDelete extends DDLOperation {
  cascade: string | null;
}

export interface SetField extends DDLOperation {
  name: string;
  value: Expr | TypeExpr | null;
  special_syntax: boolean | undefined;
}

export interface SetPointerType extends SetField {
  cast_expr: Expr | null | undefined;
}

export interface SetPointerCardinality extends SetField {
  conv_expr: Expr | null | undefined;
}

export interface SetPointerOptionality extends SetField {
  fill_expr: Expr | null | undefined;
}

export interface ObjectDDL extends DDLCommand {
  name: ObjectRef;
}

export interface CreateObject extends ObjectDDL {
  abstract: boolean | undefined;
  sdl_alter_if_exists: boolean | undefined;
  create_if_not_exists: boolean | undefined;
}

export interface AlterObject extends ObjectDDL {
}

export interface DropObject extends ObjectDDL {
}

export interface CreateExtendingObject extends CreateObject {
  final: boolean | undefined;
  bases: TypeName[];
}

export interface Rename extends ObjectDDL {
  new_name: ObjectRef;
}

export interface NestedQLBlock extends DDL {
  commands: DDLOperation[];
  text: string | null | undefined;
}

export interface MigrationCommand extends DDLCommand {
}

export interface CreateMigration extends CreateObject, MigrationCommand, GrammarEntryPoint {
  body: NestedQLBlock;
  parent: ObjectRef | null | undefined;
  metadata_only: boolean | undefined;
  target_sdl: string | null | undefined;
}

export interface CommittedSchema extends DDL {
}

export interface StartMigration extends MigrationCommand {
  target: Schema | CommittedSchema;
}

export interface AbortMigration extends MigrationCommand {
}

export interface PopulateMigration extends MigrationCommand {
}

export interface AlterCurrentMigrationRejectProposed extends MigrationCommand {
}

export interface DescribeCurrentMigration extends MigrationCommand {
  language: string;
}

export interface CommitMigration extends MigrationCommand {
}

export interface AlterMigration extends AlterObject, MigrationCommand {
}

export interface DropMigration extends DropObject, MigrationCommand {
}

export interface ResetSchema extends MigrationCommand {
  target: ObjectRef;
}

export interface StartMigrationRewrite extends MigrationCommand {
}

export interface AbortMigrationRewrite extends MigrationCommand {
}

export interface CommitMigrationRewrite extends MigrationCommand {
}

export interface UnqualifiedObjectCommand extends ObjectDDL {
}

export interface GlobalObjectCommand extends UnqualifiedObjectCommand {
}

export interface DatabaseCommand extends GlobalObjectCommand, NonTransactionalDDLCommand {
  flavor: string | undefined;
}

export interface CreateDatabase extends CreateObject, DatabaseCommand {
  template: ObjectRef | null | undefined;
  branch_type: BranchType;
}

export interface AlterDatabase extends AlterObject, DatabaseCommand {
  force: boolean | undefined;
}

export interface DropDatabase extends DropObject, DatabaseCommand {
  force: boolean | undefined;
}

export interface ExtensionPackageCommand extends GlobalObjectCommand {
  version: Constant;
}

export interface CreateExtensionPackage extends CreateObject, ExtensionPackageCommand {
  body: NestedQLBlock;
}

export interface DropExtensionPackage extends DropObject, ExtensionPackageCommand {
}

export interface ExtensionPackageMigrationCommand extends GlobalObjectCommand {
}

export interface CreateExtensionPackageMigration extends CreateObject, ExtensionPackageMigrationCommand {
  from_version: Constant;
  to_version: Constant;
  body: NestedQLBlock;
}

export interface DropExtensionPackageMigration extends DropObject, ExtensionPackageMigrationCommand {
  from_version: Constant;
  to_version: Constant;
}

export interface ExtensionCommand extends UnqualifiedObjectCommand {
}

export interface CreateExtension extends CreateObject, ExtensionCommand {
  version: Constant | null | undefined;
}

export interface AlterExtension extends DropObject, ExtensionCommand {
  version: Constant | null | undefined;
  to_version: Constant;
}

export interface DropExtension extends DropObject, ExtensionCommand {
  version: Constant | null | undefined;
}

export interface FutureCommand extends UnqualifiedObjectCommand {
}

export interface CreateFuture extends CreateObject, FutureCommand {
}

export interface DropFuture extends DropObject, FutureCommand {
}

export interface ModuleCommand extends UnqualifiedObjectCommand {
}

export interface CreateModule extends ModuleCommand, CreateObject {
}

export interface AlterModule extends ModuleCommand, AlterObject {
}

export interface DropModule extends ModuleCommand, DropObject {
}

export interface RoleCommand extends GlobalObjectCommand {
}

export interface CreateRole extends CreateObject, RoleCommand {
  superuser: boolean | undefined;
  bases: TypeName[];
}

export interface AlterRole extends AlterObject, RoleCommand {
}

export interface DropRole extends DropObject, RoleCommand {
}

export interface AnnotationCommand extends ObjectDDL {
}

export interface CreateAnnotation extends CreateExtendingObject, AnnotationCommand {
  type: TypeExpr | null;
  inheritable: boolean;
}

export interface AlterAnnotation extends AlterObject, AnnotationCommand {
}

export interface DropAnnotation extends DropObject, AnnotationCommand {
}

export interface PseudoTypeCommand extends ObjectDDL {
}

export interface CreatePseudoType extends CreateObject, PseudoTypeCommand {
}

export interface ScalarTypeCommand extends ObjectDDL {
}

export interface CreateScalarType extends CreateExtendingObject, ScalarTypeCommand {
}

export interface AlterScalarType extends AlterObject, ScalarTypeCommand {
}

export interface DropScalarType extends DropObject, ScalarTypeCommand {
}

export interface PropertyCommand extends ObjectDDL {
}

export interface CreateProperty extends CreateExtendingObject, PropertyCommand {
}

export interface AlterProperty extends AlterObject, PropertyCommand {
}

export interface DropProperty extends DropObject, PropertyCommand {
}

export interface CreateConcretePointer extends CreateObject {
  is_required: boolean | null | undefined;
  declared_overloaded: boolean | undefined;
  target: Expr | TypeExpr | null;
  cardinality: string;
  bases: TypeName[];
}

export interface CreateConcreteUnknownPointer extends CreateConcretePointer {
}

export interface AlterConcreteUnknownPointer extends AlterObject, PropertyCommand {
}

export interface CreateConcreteProperty extends CreateConcretePointer, PropertyCommand {
}

export interface AlterConcreteProperty extends AlterObject, PropertyCommand {
}

export interface DropConcreteProperty extends DropObject, PropertyCommand {
}

export interface ObjectTypeCommand extends ObjectDDL {
}

export interface CreateObjectType extends CreateExtendingObject, ObjectTypeCommand {
}

export interface AlterObjectType extends AlterObject, ObjectTypeCommand {
}

export interface DropObjectType extends DropObject, ObjectTypeCommand {
}

export interface AliasCommand extends ObjectDDL {
}

export interface CreateAlias extends CreateObject, AliasCommand {
}

export interface AlterAlias extends AlterObject, AliasCommand {
}

export interface DropAlias extends DropObject, AliasCommand {
}

export interface GlobalCommand extends ObjectDDL {
}

export interface CreateGlobal extends CreateObject, GlobalCommand {
  is_required: boolean | null | undefined;
  target: Expr | TypeExpr | null;
  cardinality: string | null;
}

export interface AlterGlobal extends AlterObject, GlobalCommand {
}

export interface DropGlobal extends DropObject, GlobalCommand {
}

export interface SetGlobalType extends SetField {
  cast_expr: Expr | null | undefined;
  reset_value: boolean | undefined;
}

export interface PermissionCommand extends ObjectDDL {
}

export interface CreatePermission extends CreateObject, PermissionCommand {
}

export interface AlterPermission extends AlterObject, PermissionCommand {
}

export interface DropPermission extends DropObject, PermissionCommand {
}

export interface LinkCommand extends ObjectDDL {
}

export interface CreateLink extends CreateExtendingObject, LinkCommand {
}

export interface AlterLink extends AlterObject, LinkCommand {
}

export interface DropLink extends DropObject, LinkCommand {
}

export interface CreateConcreteLink extends CreateExtendingObject, CreateConcretePointer, LinkCommand {
}

export interface AlterConcreteLink extends AlterObject, LinkCommand {
}

export interface DropConcreteLink extends DropObject, LinkCommand {
}

export interface ConstraintCommand extends ObjectDDL {
}

export interface CreateConstraint extends CreateExtendingObject, ConstraintCommand {
  subjectexpr: Expr | null;
  params: FuncParamDecl[] | undefined;
}

export interface AlterConstraint extends AlterObject, ConstraintCommand {
}

export interface DropConstraint extends DropObject, ConstraintCommand {
}

export interface ConcreteConstraintOp extends ConstraintCommand {
  args: Expr[];
  subjectexpr: Expr | null;
  except_expr: Expr | null | undefined;
}

export interface CreateConcreteConstraint extends ConcreteConstraintOp, CreateObject {
  delegated: boolean | undefined;
}

export interface AlterConcreteConstraint extends ConcreteConstraintOp, AlterObject {
}

export interface DropConcreteConstraint extends ConcreteConstraintOp, DropObject {
}

export interface IndexType extends DDL {
  name: ObjectRef;
  args: Expr[] | undefined;
  kwargs: Record<string, Expr> | undefined;
}

export interface IndexCommand extends ObjectDDL {
}

export interface IndexCode extends DDL {
  language: Language;
  code: string;
}

export interface CreateIndex extends CreateExtendingObject, IndexCommand {
  kwargs: Record<string, Expr> | undefined;
  index_types: IndexType[];
  code: IndexCode | null | undefined;
  params: FuncParamDecl[] | undefined;
}

export interface AlterIndex extends AlterObject, IndexCommand {
}

export interface DropIndex extends DropObject, IndexCommand {
}

export interface IndexMatchCommand extends ObjectDDL {
  valid_type: TypeName;
}

export interface CreateIndexMatch extends CreateObject, IndexMatchCommand {
}

export interface DropIndexMatch extends DropObject, IndexMatchCommand {
}

export interface ConcreteIndexCommand extends IndexCommand {
  kwargs: Record<string, Expr> | undefined;
  expr: Expr;
  except_expr: Expr | null | undefined;
  deferred: boolean | undefined;
}

export interface CreateConcreteIndex extends ConcreteIndexCommand, CreateObject {
}

export interface AlterConcreteIndex extends ConcreteIndexCommand, AlterObject {
}

export interface DropConcreteIndex extends ConcreteIndexCommand, DropObject {
}

export interface CreateAnnotationValue extends AnnotationCommand, CreateObject {
  value: Expr;
}

export interface AlterAnnotationValue extends AnnotationCommand, AlterObject {
  value: Expr | null;
}

export interface DropAnnotationValue extends AnnotationCommand, DropObject {
}

export interface AccessPolicyCommand extends ObjectDDL {
}

export interface CreateAccessPolicy extends CreateObject, AccessPolicyCommand {
  condition: Expr | null;
  action: string;
  access_kinds: string[];
  expr: Expr | null;
}

export interface SetAccessPerms extends DDLOperation {
  access_kinds: string[];
  action: string;
}

export interface AlterAccessPolicy extends AlterObject, AccessPolicyCommand {
}

export interface DropAccessPolicy extends DropObject, AccessPolicyCommand {
}

export interface TriggerCommand extends ObjectDDL {
}

export interface CreateTrigger extends CreateObject, TriggerCommand {
  timing: string;
  kinds: string[];
  scope: string;
  expr: Expr;
  condition: Expr | null;
}

export interface AlterTrigger extends AlterObject, TriggerCommand {
}

export interface DropTrigger extends DropObject, TriggerCommand {
}

export interface RewriteCommand extends ObjectDDL {
  kinds: string[];
}

export interface CreateRewrite extends CreateObject, RewriteCommand {
  expr: Expr;
}

export interface AlterRewrite extends AlterObject, RewriteCommand {
}

export interface DropRewrite extends DropObject, RewriteCommand {
}

export interface FunctionCode extends DDL {
  language: Language | undefined;
  code: string | null | undefined;
  nativecode: Expr | null | undefined;
  from_function: string | null | undefined;
  from_expr: boolean | undefined;
}

export interface FunctionCommand extends DDLCommand {
  params: FuncParamDecl[] | undefined;
}

export interface CreateFunction extends CreateObject, FunctionCommand {
  returning: TypeExpr;
  code: FunctionCode;
  nativecode: Expr | null;
  returning_typemod: string | undefined;
}

export interface AlterFunction extends AlterObject, FunctionCommand {
  code: FunctionCode | undefined;
  nativecode: Expr | null;
}

export interface DropFunction extends DropObject, FunctionCommand {
}

export interface OperatorCode extends DDL {
  language: Language;
  from_operator: string[] | null;
  from_function: string[] | null;
  from_expr: boolean;
  code: string | null;
}

export interface OperatorCommand extends DDLCommand {
  kind: string;
  params: FuncParamDecl[] | undefined;
}

export interface CreateOperator extends CreateObject, OperatorCommand {
  returning: TypeExpr;
  returning_typemod: string | undefined;
  code: OperatorCode;
}

export interface AlterOperator extends AlterObject, OperatorCommand {
}

export interface DropOperator extends DropObject, OperatorCommand {
}

export interface CastCode extends DDL {
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
  code: CastCode;
  allow_implicit: boolean;
  allow_assignment: boolean;
}

export interface AlterCast extends AlterObject, CastCommand {
}

export interface DropCast extends DropObject, CastCommand {
}

export interface OptionalExpr extends Expr {
  expr: Expr;
}

export interface ConfigOp extends Base {
  name: ObjectRef;
  scope: string;
}

export interface ConfigSet extends ConfigOp {
  expr: Expr;
}

export interface ConfigInsert extends ConfigOp {
  shape: ShapeElement[];
}

export interface ConfigReset extends ConfigOp {
  where: Expr | null | undefined;
}

export interface DescribeStmt extends Command {
  language: string;
  object: ObjectRef | DescribeGlobal;
  options: Options;
}

export interface ExplainStmt extends Command {
  args: NamedTuple | null;
  query: Query;
}

export interface AdministerStmt extends Command {
  expr: FunctionCall;
}

export interface SDL extends Base {
}

export interface ModuleDeclaration extends SDL {
  name: ObjectRef;
  declarations: ObjectDDL | ModuleDeclaration[];
}

export interface Schema extends SDL, GrammarEntryPoint, Base {
  declarations: ObjectDDL | ModuleDeclaration[];
}

export type EdgeQLAstNode =
  Base |
  GrammarEntryPoint |
  OptionValue |
  OptionFlag |
  Options |
  Expr |
  Placeholder |
  SortExpr |
  Alias |
  AliasedExpr |
  ModuleAliasDecl |
  GroupingAtom |
  BaseObjectRef |
  ObjectRef |
  PseudoObjectRef |
  Anchor |
  IRAnchor |
  SpecialAnchor |
  Cursor |
  DetachedExpr |
  GlobalExpr |
  Index |
  Slice |
  Indirection |
  BinOp |
  WindowSpec |
  FunctionCall |
  StrInterpFragment |
  StrInterp |
  BaseConstant |
  Constant |
  BytesConstant |
  QueryParameter |
  FunctionParameter |
  UnaryOp |
  TypeExpr |
  TypeOf |
  TypeExprLiteral |
  TypeName |
  TypeOp |
  FuncParamDecl |
  IsOp |
  TypeIntersection |
  Ptr |
  Splat |
  Path |
  TypeCast |
  Introspect |
  IfElse |
  TupleElement |
  NamedTuple |
  Tuple |
  Array |
  Set |
  Command |
  Commands |
  SessionSetAliasDecl |
  SessionResetAliasDecl |
  SessionResetModule |
  SessionResetAllAliases |
  ShapeOperation |
  ShapeElement |
  Shape |
  Query |
  SelectQuery |
  GroupingIdentList |
  GroupingElement |
  GroupingSimple |
  GroupingSets |
  GroupingOperation |
  GroupQuery |
  InternalGroupQuery |
  InsertQuery |
  UpdateQuery |
  DeleteQuery |
  ForQuery |
  Transaction |
  StartTransaction |
  CommitTransaction |
  RollbackTransaction |
  DeclareSavepoint |
  RollbackToSavepoint |
  ReleaseSavepoint |
  DDL |
  Position |
  DDLOperation |
  DDLCommand |
  DDLQuery |
  NonTransactionalDDLCommand |
  AlterAddInherit |
  AlterDropInherit |
  OnTargetDelete |
  OnSourceDelete |
  SetField |
  SetPointerType |
  SetPointerCardinality |
  SetPointerOptionality |
  ObjectDDL |
  CreateObject |
  AlterObject |
  DropObject |
  CreateExtendingObject |
  Rename |
  NestedQLBlock |
  MigrationCommand |
  CreateMigration |
  CommittedSchema |
  StartMigration |
  AbortMigration |
  PopulateMigration |
  AlterCurrentMigrationRejectProposed |
  DescribeCurrentMigration |
  CommitMigration |
  AlterMigration |
  DropMigration |
  ResetSchema |
  StartMigrationRewrite |
  AbortMigrationRewrite |
  CommitMigrationRewrite |
  UnqualifiedObjectCommand |
  GlobalObjectCommand |
  DatabaseCommand |
  CreateDatabase |
  AlterDatabase |
  DropDatabase |
  ExtensionPackageCommand |
  CreateExtensionPackage |
  DropExtensionPackage |
  ExtensionPackageMigrationCommand |
  CreateExtensionPackageMigration |
  DropExtensionPackageMigration |
  ExtensionCommand |
  CreateExtension |
  AlterExtension |
  DropExtension |
  FutureCommand |
  CreateFuture |
  DropFuture |
  ModuleCommand |
  CreateModule |
  AlterModule |
  DropModule |
  RoleCommand |
  CreateRole |
  AlterRole |
  DropRole |
  AnnotationCommand |
  CreateAnnotation |
  AlterAnnotation |
  DropAnnotation |
  PseudoTypeCommand |
  CreatePseudoType |
  ScalarTypeCommand |
  CreateScalarType |
  AlterScalarType |
  DropScalarType |
  PropertyCommand |
  CreateProperty |
  AlterProperty |
  DropProperty |
  CreateConcretePointer |
  CreateConcreteUnknownPointer |
  AlterConcreteUnknownPointer |
  CreateConcreteProperty |
  AlterConcreteProperty |
  DropConcreteProperty |
  ObjectTypeCommand |
  CreateObjectType |
  AlterObjectType |
  DropObjectType |
  AliasCommand |
  CreateAlias |
  AlterAlias |
  DropAlias |
  GlobalCommand |
  CreateGlobal |
  AlterGlobal |
  DropGlobal |
  SetGlobalType |
  PermissionCommand |
  CreatePermission |
  AlterPermission |
  DropPermission |
  LinkCommand |
  CreateLink |
  AlterLink |
  DropLink |
  CreateConcreteLink |
  AlterConcreteLink |
  DropConcreteLink |
  ConstraintCommand |
  CreateConstraint |
  AlterConstraint |
  DropConstraint |
  ConcreteConstraintOp |
  CreateConcreteConstraint |
  AlterConcreteConstraint |
  DropConcreteConstraint |
  IndexType |
  IndexCommand |
  IndexCode |
  CreateIndex |
  AlterIndex |
  DropIndex |
  IndexMatchCommand |
  CreateIndexMatch |
  DropIndexMatch |
  ConcreteIndexCommand |
  CreateConcreteIndex |
  AlterConcreteIndex |
  DropConcreteIndex |
  CreateAnnotationValue |
  AlterAnnotationValue |
  DropAnnotationValue |
  AccessPolicyCommand |
  CreateAccessPolicy |
  SetAccessPerms |
  AlterAccessPolicy |
  DropAccessPolicy |
  TriggerCommand |
  CreateTrigger |
  AlterTrigger |
  DropTrigger |
  RewriteCommand |
  CreateRewrite |
  AlterRewrite |
  DropRewrite |
  FunctionCode |
  FunctionCommand |
  CreateFunction |
  AlterFunction |
  DropFunction |
  OperatorCode |
  OperatorCommand |
  CreateOperator |
  AlterOperator |
  DropOperator |
  CastCode |
  CastCommand |
  CreateCast |
  AlterCast |
  DropCast |
  OptionalExpr |
  ConfigOp |
  ConfigSet |
  ConfigInsert |
  ConfigReset |
  DescribeStmt |
  ExplainStmt |
  AdministerStmt |
  SDL |
  ModuleDeclaration |
  Schema;
