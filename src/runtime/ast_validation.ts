import { AppError } from "../errors.js";
import type {
  FunctionCallArgExpr,
  FunctionCallExpr,
  ShapeElement,
  Statement,
  WithBinding,
  WithBindingValue,
} from "../edgeql/ast.js";
import { qualifiedTypeName, type SchemaSnapshot } from "../schema/schema.js";
import type { FieldDef, ScalarValue, TypeDef } from "../types.js";
import {
  bindingSelectShape,
  computedElementReferencedField,
  computedExprIsMulti,
  inferArrayValuedType,
  insertValueHasUnscopedPartialPath,
  literalStdTypeName,
  unwrapSubqueryWrappers,
} from "../compiler/ast_inference.js";

// The engine's runtime-alias registries (WeakMap-backed, populated when runtime
// aliases are registered) are the only engine state this pre-validation cluster
// reaches back into. They are injected so this module stays a pure,
// one-directional dependency with no engine import cycle. The cluster only ever
// probes membership (`.has`), never reads the values.
export interface AstValidationDeps {
  runtimeTypedAliasMap: (schema: SchemaSnapshot) => ReadonlyMap<string, unknown>;
  runtimeExprAliasMap: (schema: SchemaSnapshot) => ReadonlyMap<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// AST pre-validation (EdgeDB parity diagnostics)
//
// The GelIR→SQL pipeline doesn't surface several semantic errors the
// reference implementation raises (illegal type unions over computed
// pointers, single/multi mismatches, invalid property references on
// primitives, …). These checks run on the parsed AST right after
// `validateParsedStatement` so invalid queries fail with the reference
// error message instead of silently compiling.
// ═══════════════════════════════════════════════════════════════════════════

interface AstPreValidationCtx {
  schema: SchemaSnapshot;
  module: string;
  bindings: Map<string, WithBindingValue>;
  // Mirrors the session config: when true, an INSERT may assign `id`.
  allowUserSpecifiedId?: boolean;
  deps: AstValidationDeps;
}

export function preValidationFail(message: string): never {
  throw new AppError("E_SEMANTIC", message, 1, 1);
}

function qualifyAstTypeName(name: string, module: string): string {
  return name.includes("::") ? name : `${module}::${name}`;
}

function lookupAstObjectType(ctx: AstPreValidationCtx, name: string): TypeDef | undefined {
  return ctx.schema.getType(qualifyAstTypeName(name, ctx.module))
    ?? ctx.schema.getType(name)
    ?? ctx.schema.getType(`default::${name}`);
}

type AstPointerInfo =
  | { kind: "field"; field: FieldDef; owner: TypeDef }
  | { kind: "link"; link: NonNullable<TypeDef["links"]>[number]; owner: TypeDef };

// Resolve a pointer (property or link) on a type, walking `extends`.
function findAstPointer(ctx: AstPreValidationCtx, typeDef: TypeDef, name: string): AstPointerInfo | undefined {
  const queue: TypeDef[] = [typeDef];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const qname = qualifiedTypeName(current);
    if (seen.has(qname)) continue;
    seen.add(qname);
    const field = current.fields.find((f) => f.name === name && !f.isLinkColumn);
    if (field) return { kind: "field", field, owner: current };
    const link = current.links?.find((l) => l.name === name);
    if (link) return { kind: "link", link, owner: current };
    for (const base of current.extends ?? []) {
      const baseDef = lookupAstObjectType(ctx, base);
      if (baseDef) queue.push(baseDef);
    }
  }
  return undefined;
}

const STD_SCALAR_NAME_BY_TYPE: Record<string, string> = {
  str: "std::str",
  int: "std::int64",
  float: "std::float64",
  bool: "std::bool",
  uuid: "std::uuid",
  datetime: "std::datetime",
  json: "std::json",
  bytes: "std::bytes",
  decimal: "std::decimal",
  bigint: "std::bigint",
};

function declaredScalarTypeName(field: FieldDef): string {
  return field.targetTypeName ?? field.enumTypeName ?? STD_SCALAR_NAME_BY_TYPE[field.type] ?? `std::${field.type}`;
}

// Names of standard-library scalar/object types that, when written bare in a
// cast (`<datetime>`, `<Object>`), live in the `std` module. Used to qualify
// the cast target so it can be compared to a declared pointer type.
const STD_CAST_TYPE_NAMES = new Set([
  "str", "int16", "int32", "int64", "float32", "float64", "bool", "uuid",
  "datetime", "duration", "json", "bytes", "decimal", "bigint", "Object",
  "BaseObject", "FreeObject", "cal::local_date", "cal::local_time",
  "cal::local_datetime", "cal::relative_duration", "cal::date_duration",
]);

// True when `name` resolves to a registered expression alias of any flavor
// (schema alias, runtime typed alias, or runtime expr alias) rather than an
// object type. Used to reject `INSERT <alias>` (test_edgeql_insert_alias).
function isExpressionAliasName(ctx: AstPreValidationCtx, name: string): boolean {
  const qualified = qualifyAstTypeName(name, ctx.module);
  const bare = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
  if (ctx.schema.getAlias(qualified) || ctx.schema.getAlias(name)) return true;
  const typed = ctx.deps.runtimeTypedAliasMap(ctx.schema);
  if (typed.has(qualified) || typed.has(name) || typed.has(bare)) return true;
  const expr = ctx.deps.runtimeExprAliasMap(ctx.schema);
  if (expr.has(qualified) || expr.has(name) || expr.has(bare)) return true;
  return false;
}

// Best-effort qualification of a cast target type name written in an INSERT
// shape value (`<datetime>{}`, `<Object>{}`). Returns a module-qualified name
// when possible so it can be reported and compared against a declared type.
function qualifyCastTypeName(ctx: AstPreValidationCtx, castType: string): string {
  if (castType.includes("::")) return castType;
  if (STD_CAST_TYPE_NAMES.has(castType)) return `std::${castType}`;
  // A user-defined object type referenced bare in the cast.
  const obj = lookupAstObjectType(ctx, castType);
  if (obj) return qualifiedTypeName(obj);
  return `std::${castType}`;
}

// Generic recursive walk over every object node carrying a string `kind`.
function walkAstForValidation(node: unknown, visit: (n: Record<string, unknown> & { kind: string }) => void, seen: Set<unknown> = new Set()): void {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walkAstForValidation(item, visit, seen);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.kind === "string") {
    visit(record as Record<string, unknown> & { kind: string });
  }
  for (const value of Object.values(record)) {
    walkAstForValidation(value, visit, seen);
  }
}

// ── union-branch pointer info (setops_14/15, banned_free_shape_01) ─────────

interface UnionBranchInfo {
  computed: Set<string>;
  typeName?: string;
  bindingName?: string;
}

function unionBranchInfo(ctx: AstPreValidationCtx, value: unknown, depth = 0): UnionBranchInfo | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const node = value as Record<string, unknown> & { kind?: string };
  switch (node.kind) {
    case "select": {
      const computed = new Set<string>();
      for (const el of (node.shape as ShapeElement[] | undefined) ?? []) {
        if (el.kind === "computed") computed.add(el.name);
      }
      return { computed, typeName: node.typeName as string | undefined };
    }
    case "free_object_constructor": {
      if (node.tupleLike) return undefined;
      const computed = new Set<string>();
      for (const entry of (node.entries as Array<{ name: string }> | undefined) ?? []) {
        computed.add(entry.name);
      }
      return { computed };
    }
    case "shape_projection": {
      const inner = unionBranchInfo(ctx, node.expr, depth + 1);
      const computed = new Set<string>(inner?.computed ?? []);
      for (const el of (node.shape as ShapeElement[] | undefined) ?? []) {
        if (el.kind === "computed") computed.add(el.name);
      }
      return { computed, typeName: inner?.typeName };
    }
    case "binding_ref": {
      const binding = ctx.bindings.get(node.name as string);
      if (!binding) return undefined;
      const info = bindingUnionBranchInfo(ctx, binding, depth + 1);
      if (info) info.bindingName = node.name as string;
      return info;
    }
    case "cast": {
      const castType = node.castType as string | undefined;
      if (castType && lookupAstObjectType(ctx, castType)) {
        return { computed: new Set(), typeName: castType };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function bindingUnionBranchInfo(ctx: AstPreValidationCtx, binding: WithBindingValue, depth: number): UnionBranchInfo | undefined {
  switch (binding.kind) {
    case "subquery": {
      const computed = new Set<string>();
      for (const el of binding.query.shape ?? []) {
        if (el.kind === "computed") computed.add(el.name);
      }
      return { computed, typeName: binding.query.typeName };
    }
    case "subquery_expr":
      return unionBranchInfo(ctx, unwrapSubqueryWrappers(binding.expr), depth);
    case "subquery_statement":
      return unionBranchInfo(ctx, binding.statement, depth);
    default:
      return undefined;
  }
}

function branchHasSchemaPointer(ctx: AstPreValidationCtx, info: UnionBranchInfo, name: string): boolean {
  if (!info.typeName) return false;
  const typeDef = lookupAstObjectType(ctx, info.typeName);
  if (!typeDef) return false;
  return findAstPointer(ctx, typeDef, name) !== undefined;
}

// `SELECT { Issue{number := 'foo'}, Issue }` — a union may not mix a shape
// computed pointer with another version of the same pointer.
function checkUnionComputedPointerMix(ctx: AstPreValidationCtx, values: unknown[]): void {
  if (values.length < 2) return;
  const infos = values.map((v) => unionBranchInfo(ctx, unwrapSubqueryWrappers(v)));
  for (let i = 0; i < infos.length; i += 1) {
    const info = infos[i];
    if (!info) continue;
    for (const name of info.computed) {
      for (let j = 0; j < infos.length; j += 1) {
        if (j === i) continue;
        const other = infos[j];
        if (!other) continue;
        // The same WITH binding unioned with itself is a single view type —
        // no pointer mixing happens.
        if (info.bindingName !== undefined && info.bindingName === other.bindingName) continue;
        if (other.computed.has(name) || branchHasSchemaPointer(ctx, other, name)) {
          preValidationFail(
            `it is illegal to create a type union that causes a computed property '${name}' to mix with other versions of the same property '${name}'`,
          );
        }
      }
    }
  }
}

// `(Issue UNION <Named>{}).number` — a pointer accessed on a union must
// exist on every branch of the union.
function checkUnionFieldAccess(ctx: AstPreValidationCtx, setValues: unknown[], field: string): void {
  if (setValues.length < 2) return;
  if (field === "id" || field === "__type__" || field.startsWith("@")) return;
  const branches: Array<{ typeDef: TypeDef; computed: Set<string> }> = [];
  for (const value of setValues) {
    const info = unionBranchInfo(ctx, unwrapSubqueryWrappers(value));
    if (!info || !info.typeName) return; // unresolvable branch — skip the check
    const typeDef = lookupAstObjectType(ctx, info.typeName);
    if (!typeDef) return;
    branches.push({ typeDef, computed: info.computed });
  }
  for (const branch of branches) {
    if (branch.computed.has(field)) continue;
    if (findAstPointer(ctx, branch.typeDef, field)) continue;
    preValidationFail(`object type '${qualifiedTypeName(branch.typeDef)}' has no link or property '${field}'`);
  }
}

// ── computed pointer checks (computable_17 / computable_34) ────────────────

// Whether a computed expression is statically known to produce more than one
// element (a set literal / UNION with several branches).
// `SELECT V { single foo := .foo }` where V's `foo` is a multi computed.
function checkSingleDeclaredComputeds(ctx: AstPreValidationCtx, shape: ShapeElement[], sourceShape: ShapeElement[] | undefined): void {
  if (!sourceShape) return;
  for (const el of shape) {
    if (el.kind !== "computed") continue;
    const cardinality = (el as { cardinality?: string }).cardinality;
    if (cardinality !== "one") continue;
    const referenced = computedElementReferencedField(el.expr);
    if (!referenced) continue;
    const source = sourceShape.find((s) => s.kind === "computed" && s.name === referenced) as Extract<ShapeElement, { kind: "computed" }> | undefined;
    if (!source) continue;
    if ((source as { multi?: boolean }).multi || computedExprIsMulti(source.expr)) {
      preValidationFail(
        `possibly more than one element returned by an expression for a computed property '${el.name}' declared as 'single'`,
      );
    }
  }
}

// Resolve a `current_item`-rooted field-access chain to its final pointer,
// starting at `subjectType`. Returns undefined when any step is unknown.
function resolveCurrentItemPathPointer(ctx: AstPreValidationCtx, expr: unknown, subjectType: TypeDef): AstPointerInfo | undefined {
  const fields: string[] = [];
  let current = expr as Record<string, unknown> & { kind?: string };
  let guard = 0;
  while (current && typeof current === "object" && current.kind === "field_access" && guard < 12) {
    fields.unshift(current.field as string);
    current = current.expr as Record<string, unknown> & { kind?: string };
    guard += 1;
  }
  if (!current || current.kind !== "current_item" || fields.length === 0) return undefined;
  let typeDef: TypeDef = subjectType;
  let pointer: AstPointerInfo | undefined;
  for (const field of fields) {
    pointer = findAstPointer(ctx, typeDef, field);
    if (!pointer) return undefined;
    if (pointer.kind === "link") {
      const target = lookupAstObjectType(ctx, pointer.link.targetType.split("|")[0]);
      if (!target) return pointer;
      typeDef = target;
    } else {
      typeDef = undefined as unknown as TypeDef;
    }
    if (!typeDef && field !== fields[fields.length - 1]) return undefined;
  }
  return pointer;
}

// `foo := .owner.todo UNION .owner.todo` — a computed link must be a
// provably distinct set; a UNION of link paths is not.
function checkComputedLinkUnions(ctx: AstPreValidationCtx, typeName: string, shape: ShapeElement[]): void {
  const subjectType = lookupAstObjectType(ctx, typeName);
  if (!subjectType) return;
  for (const el of shape) {
    if (el.kind !== "computed") continue;
    let expr: unknown = el.expr;
    const wrapper = expr as Record<string, unknown> & { kind?: string };
    if (wrapper?.kind === "select_expr" || wrapper?.kind === "select_expr_subquery") expr = wrapper.expr;
    const setNode = expr as Record<string, unknown> & { kind?: string };
    if (setNode?.kind !== "set_expr") continue;
    const values = (setNode.values as unknown[]) ?? [];
    if (values.length < 2) continue;
    const allLinkPaths = values.every((value) => {
      const pointer = resolveCurrentItemPathPointer(ctx, value, subjectType);
      return pointer?.kind === "link";
    });
    if (allLinkPaths) {
      preValidationFail(`possibly not a distinct set returned by an expression for a computed link '${el.name}'`);
    }
  }
}

// ── scalar path misuse (type_03 / partial_06 / precedence_02) ──────────────

// Resolve `field_access(select T, f)` (a `T.f` path) to the property def.
function scalarPathProperty(ctx: AstPreValidationCtx, node: unknown): FieldDef | undefined {
  const access = node as Record<string, unknown> & { kind?: string };
  if (!access || access.kind !== "field_access") return undefined;
  const base = access.expr as Record<string, unknown> & { kind?: string };
  if (!base || base.kind !== "select" || typeof base.typeName !== "string") return undefined;
  const typeDef = lookupAstObjectType(ctx, base.typeName as string);
  if (!typeDef) return undefined;
  const pointer = findAstPointer(ctx, typeDef, access.field as string);
  if (pointer?.kind !== "field") return undefined;
  if (pointer.field.collection) return undefined;
  return pointer.field;
}

function exprContainsPartialPathRef(node: unknown): boolean {
  let found = false;
  walkAstForValidation(node, (n) => {
    if (n.kind === "current_item" || n.kind === "field_ref") found = true;
  });
  return found;
}

// ── function call signature checks (func_06 / func_08) ─────────────────────

function functionCallArgLiteral(ctx: AstPreValidationCtx, arg: FunctionCallArgExpr): { value: ScalarValue; numericKind?: string } | undefined {
  if (arg.kind === "literal") return { value: arg.value };
  if (arg.kind === "expr") {
    const inner = arg.expr as Record<string, unknown> & { kind?: string };
    if (inner?.kind === "literal") {
      return { value: inner.value as ScalarValue, numericKind: inner.numericKind as string | undefined };
    }
    if (inner?.kind === "binding_ref") {
      return bindingLiteralValue(ctx, inner.name as string);
    }
    return undefined;
  }
  if (arg.kind === "binding_ref") return bindingLiteralValue(ctx, arg.name);
  return undefined;
}

function bindingLiteralValue(ctx: AstPreValidationCtx, name: string): { value: ScalarValue } | undefined {
  const binding = ctx.bindings.get(name);
  if (!binding) return undefined;
  if (binding.kind === "literal") return { value: binding.value };
  if (binding.kind === "subquery_expr") {
    const inner = binding.expr as Record<string, unknown> & { kind?: string };
    if (inner?.kind === "literal") return { value: inner.value as ScalarValue };
  }
  return undefined;
}

function checkFunctionCallSignatures(ctx: AstPreValidationCtx, call: FunctionCallExpr): void {
  const callNameParts = call.name.split("::");
  const leaf = callNameParts[callNameParts.length - 1];

  // `sum` only accepts numeric arguments. The SQL pipeline silently coerces
  // strings, so reject the statically-known-string case here.
  if (leaf === "sum" && call.args.length === 1) {
    const literal = functionCallArgLiteral(ctx, call.args[0]);
    if (literal && typeof literal.value === "string") {
      preValidationFail(`function "sum(arg0: std::str)" does not exist`);
    }
  }

  // Schema (user-declared) functions: validate literal argument types against
  // the declared parameter types — the reference raises "function … does not
  // exist" when no overload matches.
  const moduleName = call.name.includes("::") ? call.name.slice(0, call.name.lastIndexOf("::")) : ctx.module;
  const fnDef = ctx.schema.findFunction(moduleName, leaf, call.args.length)
    ?? (moduleName === "default" ? undefined : ctx.schema.findFunction("default", leaf, call.args.length));
  if (!fnDef) return;
  for (let i = 0; i < call.args.length; i += 1) {
    const arg = call.args[i];
    if (arg.kind === "named_arg") continue;
    const param = fnDef.params[Math.min(i, fnDef.params.length - 1)];
    if (!param) continue;
    const paramIsVariadicTail = param.variadic && i >= fnDef.params.length - 1;
    if (i >= fnDef.params.length && !paramIsVariadicTail) continue;
    const paramType = param.type.replace(/^std::/, "");
    const literal = functionCallArgLiteral(ctx, arg);
    if (!literal) continue;
    const argType = literalStdTypeName(literal);
    if (!argType) continue;
    const isStrParam = paramType === "str";
    const isNumericArg = argType === "std::int64" || argType === "std::float64";
    if (isStrParam && isNumericArg) {
      const renderedArgs = call.args.map((_, idx) => `arg${idx}: ${literalStdTypeName(functionCallArgLiteral(ctx, call.args[idx]) ?? { value: "" }) ?? "std::str"}`).join(", ");
      preValidationFail(`function "${leaf}(${renderedArgs})" does not exist`);
    }
  }
}

// ── statement-level static pre-validation ──────────────────────────────────

export function validateStatementAst(
  schema: SchemaSnapshot,
  statement: Statement,
  deps: AstValidationDeps,
  allowUserSpecifiedId = false,
): void {
  const module = (statement as { withModule?: string }).withModule ?? "default";
  const bindings = new Map<string, WithBindingValue>();
  for (const binding of (statement as { with?: WithBinding[] }).with ?? []) {
    bindings.set(binding.name, binding.value);
  }
  const ctx: AstPreValidationCtx = { schema, module, bindings, allowUserSpecifiedId, deps };

  // `SELECT T.scalarProp FILTER .x …` — partial paths can't be resolved
  // against a primitive subject. (Checked before the generic walk so the
  // error reports the *declared* scalar type, e.g. a custom scalar.)
  if (statement.kind === "select_expr") {
    const wrapper = (statement as { expr?: unknown }).expr as Record<string, unknown> & { kind?: string };
    if (wrapper?.kind === "select_expr_subquery" && wrapper.filter) {
      const prop = scalarPathProperty(ctx, wrapper.expr);
      if (prop && exprContainsPartialPathRef(wrapper.filter)) {
        preValidationFail(`invalid property reference on an expression of primitive type '${declaredScalarTypeName(prop)}'`);
      }
    }
  }

  walkAstForValidation(statement, (node) => {
    switch (node.kind) {
      case "set_expr": {
        const values = (node.values as unknown[]) ?? [];
        checkUnionComputedPointerMix(ctx, values);
        break;
      }
      case "field_access": {
        const base = node.expr as Record<string, unknown> & { kind?: string };
        if (base?.kind === "set_expr") {
          checkUnionFieldAccess(ctx, (base.values as unknown[]) ?? [], node.field as string);
        }
        // `User.name.__type__` — property reference on a primitive.
        if (node.field === "__type__" && scalarPathProperty(ctx, base)) {
          preValidationFail("invalid property reference on an expression of primitive type");
        }
        break;
      }
      case "index_access": {
        // `Issue.time_estimate[0]` — index indirection on a non-indexable scalar.
        const prop = scalarPathProperty(ctx, node.expr);
        if (prop && (prop.type === "int" || prop.type === "bool")) {
          const label = prop.type === "int" ? "std::int64" : "std::bool";
          preValidationFail(`index indirection cannot be applied to scalar type '${label}'`);
        }
        break;
      }
      case "distinct": {
        const inner = node.expr as Record<string, unknown> & { kind?: string };
        if (inner?.kind === "free_object_constructor" && !inner.tupleLike) {
          preValidationFail("cannot use DISTINCT on free shape");
        }
        break;
      }
      case "polymorphic_field_ref": {
        if (node.field === "id") {
          preValidationFail("cannot access property 'id' on a polymorphic shape element");
        }
        break;
      }
      case "function_call": {
        const call = (node.call ?? node) as unknown as FunctionCallExpr;
        if (call && typeof call.name === "string" && Array.isArray(call.args)) {
          checkFunctionCallSignatures(ctx, call);
        }
        break;
      }
      case "select": {
        const typeName = node.typeName as string | undefined;
        const shape = node.shape as ShapeElement[] | undefined;
        if (typeName && shape) {
          checkComputedLinkUnions(ctx, typeName, shape);
        }
        break;
      }
      case "shape_projection": {
        const base = node.expr as Record<string, unknown> & { kind?: string };
        if (base?.kind === "binding_ref") {
          const info = ctx.bindings.get(base.name as string);
          const sourceShape = bindingSelectShape(info);
          checkSingleDeclaredComputeds(ctx, (node.shape as ShapeElement[]) ?? [], sourceShape);
        }
        break;
      }
      case "insert": {
        const typeName = node.typeName as string | undefined;
        const values = (node.values as Record<string, unknown> | undefined) ?? undefined;
        if (typeName && values) {
          checkInsertStatementAst(ctx, typeName, values);
        }
        break;
      }
      case "tuple": {
        checkCorrelatedDmlInTuple(ctx, (node.values as unknown[]) ?? []);
        break;
      }
      default:
        break;
    }
  });
}

// Standard-library modules whose object types cannot be the subject of an
// INSERT (test_edgeql_insert_fail_07: `INSERT schema::Migration {…}`).
const INSERT_STD_MODULES = new Set(["std", "schema", "sys", "cfg", "ext"]);

// Static checks for an INSERT statement's subject type and shape values that
// don't depend on row data: assigning to computed/server-generated pointers,
// inserting std-lib types, and assigning a provably-multi expression to a
// single link. (All additive — fall through silently when unknown.)
function checkInsertStatementAst(
  ctx: AstPreValidationCtx,
  typeName: string,
  values: Record<string, unknown>,
): void {
  // `INSERT schema::Migration {…}` — std-lib types are not insertable.
  const qualified = qualifyAstTypeName(typeName, ctx.module);
  const moduleName = qualified.includes("::") ? qualified.slice(0, qualified.lastIndexOf("::")) : ctx.module;
  const leafName = qualified.slice(qualified.lastIndexOf("::") + 2);
  // `std::FreeObject` has its own diagnostic (test_edgeql_insert_free_obj);
  // leave it to the downstream check rather than the generic std-lib message.
  if (INSERT_STD_MODULES.has(moduleName) && leafName !== "FreeObject") {
    preValidationFail("insert standard library type");
  }

  // `INSERT Foo` where `Foo` is an expression alias, not an object type
  // (test_edgeql_insert_alias). Aliases of every flavor (schema-registered,
  // runtime typed, runtime expr) are rejected — you can't insert into a view.
  if (!lookupAstObjectType(ctx, typeName) && isExpressionAliasName(ctx, typeName)) {
    preValidationFail(`cannot insert into expression alias '${qualified}'`);
  }

  const typeDef = lookupAstObjectType(ctx, typeName);

  for (const field of Object.keys(values)) {
    // `id` is server-generated; assigning it requires the
    // `allow_user_specified_id` config (test_edgeql_insert_explicit_id_00).
    // With that config on, the explicit id is allowed through to lowering.
    if (field === "id" && !ctx.allowUserSpecifiedId) {
      preValidationFail("cannot assign to property 'id'");
    }
    // `__type__` is a system link that names the object's type and can't be
    // written (test_edgeql_insert_specified_type).
    if (field === "__type__") {
      preValidationFail("cannot assign to link '__type__'");
    }
  }

  if (!typeDef) return;

  for (const [field, value] of Object.entries(values)) {
    // `name := .name` — a partial path (`.foo`) directly in an INSERT shape
    // value has no enclosing path scope to resolve against
    // (test_edgeql_insert_fail_06).
    if (insertValueHasUnscopedPartialPath(value)) {
      preValidationFail("could not resolve partial path");
    }

    // Assigning a computed pointer is prohibited — computeds derive their
    // value from an expression (test_edgeql_insert_fail_03).
    const computed = (typeDef.computeds ?? []).find((c) => c.name === field);
    if (computed) {
      preValidationFail(
        `modification of computed property '${field}' of object type '${qualifiedTypeName(typeDef)}' is prohibited`,
      );
    }

    // A provably-multi expression assigned to a `single` link.
    const link = (typeDef.links ?? []).find((l) => l.name === field);
    if (link && !link.multi && insertValueProvablyMulti(ctx, value)) {
      preValidationFail(
        `possibly more than one element returned by an expression for a link '${field}' declared as 'single'`,
      );
    }

    // An explicitly-cast empty set (`<datetime>{}`, `<Object>{}`) whose cast
    // target type doesn't match the declared pointer type
    // (test_edgeql_insert_empty_02/05). Resolve the pointer via inheritance so
    // derived types are covered.
    checkEmptyCastTargetType(ctx, typeDef, field, value);

    // Empty/array-typed scalar assignments to a scalar property
    // (test_edgeql_insert_empty_array_01/02/03): a bare `[]` has indeterminate
    // type, and an array/element type that disagrees with the declared
    // property type is an invalid target.
    checkArrayValuedScalarTarget(ctx, typeDef, field, value);

    // A link value carrying a link-property computed body of indeterminate
    // type — `subordinates := (SELECT Sub { @comment := [] })`
    // (test_edgeql_insert_empty_array_04). The scalar guard above only sees
    // top-level shape fields, so reach into the link value's own shape and
    // reject any `@prop := <indeterminate>` linkprop body.
    checkIndeterminateLinkPropTarget(value);

    // A link value that references the (non-detached) extent of the type being
    // inserted — `INSERT SelfRef { ref := SelfRef }` and SELECT/WITH variants
    // (test_edgeql_insert_selfref_01/02/03). DETACHED breaks the correlation
    // and is permitted (selfref_04).
    if (link && insertValueIsSelfReference(ctx, value, qualifiedTypeName(typeDef))) {
      preValidationFail("self-referencing INSERTs are not allowed");
    }
  }
}

// True when `value` references the bare extent of `selfTypeName` (the type
// being inserted) without DETACHED — directly (`SelfRef`), via an inline
// SELECT (`SELECT SelfRef …`), or via a WITH binding (`WITH X := SelfRef
// SELECT X …`). FILTER/ORDER/LIMIT clauses don't matter: any live reference
// to the same extent during its own INSERT is disallowed.
function insertValueIsSelfReference(ctx: AstPreValidationCtx, value: unknown, selfTypeName: string): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown> & { kind?: string };

  // Bare extent reference: `ref := SelfRef`.
  if (node.kind === "binding_ref" && typeof node.name === "string" && !ctx.bindings.has(node.name)) {
    const def = lookupAstObjectType(ctx, node.name);
    return def !== undefined && qualifiedTypeName(def) === selfTypeName;
  }

  // Inline SELECT: `(SELECT SelfRef …)` or `(WITH X := SelfRef SELECT X …)`.
  if (node.kind === "select" && typeof node.typeName === "string") {
    if (node.detached === true) return false;
    const clauses = (node.clauses as Record<string, unknown> | undefined) ?? {};
    const withBindings = (clauses._withBindings as Array<{ name: string; value: unknown }> | undefined) ?? [];
    // Resolve the select subject through any local WITH binding.
    let subject = node.typeName as string;
    for (const b of withBindings) {
      if (b.name === subject) {
        const bv = b.value as Record<string, unknown> & { kind?: string };
        if (bv?.kind === "binding_ref" && typeof bv.name === "string") subject = bv.name;
        else if (bv?.kind === "select" && typeof bv.typeName === "string") subject = bv.typeName as string;
        break;
      }
    }
    const def = lookupAstObjectType(ctx, subject);
    return def !== undefined && qualifiedTypeName(def) === selfTypeName;
  }

  return false;
}

// Type descriptor inferred for an INSERT-shape scalar value expression.
// Reject a link-property computed body whose value type is indeterminate —
// `subordinates := (SELECT Sub { @comment := [] })`
// (test_edgeql_insert_empty_array_04). A bare empty array `[]` in a linkprop
// body has no element type and must error rather than silently writing an
// empty value. The shape parser folds `@comment := []` to a literal carrying
// the JSON text `"[]"`, so recognise both that and the `array_literal` form.
function checkIndeterminateLinkPropTarget(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown> & { kind?: string };

  // Unwrap the shapes a link value can take to reach the `@`-prefixed shape
  // elements: `select`/`shape_projection`/`expr`/`select_expr_subquery`.
  let shape: unknown[] | undefined;
  if (node.kind === "select" && Array.isArray(node.shape)) shape = node.shape as unknown[];
  else if (node.kind === "shape_projection" && Array.isArray(node.shape)) shape = node.shape as unknown[];
  else if (node.kind === "expr") return checkIndeterminateLinkPropTarget(node.expr);
  else if (node.kind === "select_expr" || node.kind === "select_expr_subquery") return checkIndeterminateLinkPropTarget(node.expr);

  if (!shape) return;
  for (const raw of shape) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as Record<string, unknown> & { kind?: string; name?: string };
    if (el.kind !== "computed" || typeof el.name !== "string" || !el.name.startsWith("@")) continue;
    const body = el.expr as Record<string, unknown> & { kind?: string } | undefined;
    if (!body) continue;
    const isEmptyArrayLiteral = body.kind === "array_literal"
      && Array.isArray(body.values) && (body.values as unknown[]).length === 0;
    const isFoldedEmptyArray = body.kind === "literal" && body.value === "[]";
    if (isEmptyArrayLiteral || isFoldedEmptyArray) {
      preValidationFail("expression returns value of indeterminate type");
    }
  }
}

// Reject array-valued or indeterminate assignments to a scalar property.
function checkArrayValuedScalarTarget(
  ctx: AstPreValidationCtx,
  typeDef: TypeDef,
  field: string,
  value: unknown,
): void {
  const inferred = inferArrayValuedType(value);
  if (!inferred) return;

  const pointer = findAstPointer(ctx, typeDef, field);
  // Only meaningful for scalar properties (links can't take arrays/scalars).
  if (!pointer || pointer.kind !== "field") return;
  // Collection-typed properties (declared `array<...>`) legitimately take
  // array values — leave those to downstream handling.
  if (pointer.field.collection) return;

  if (inferred.kind === "indeterminate") {
    preValidationFail("expression returns value of indeterminate type");
  }

  const declared = declaredScalarTypeName(pointer.field);
  const actual = inferred.kind === "array" ? `array<${inferred.element}>` : inferred.name;
  if (actual !== declared) {
    preValidationFail(
      `invalid target for property '${field}' of object type ` +
      `'${qualifiedTypeName(typeDef)}': '${actual}' (expecting '${declared}')`,
    );
  }
}

// Reject an `<T>{}` assignment whose cast target `T` is incompatible with the
// declared property/link type. Empty sets without a cast are fine (they unify
// with any type); only an explicit, mismatched cast is an error.
function checkEmptyCastTargetType(
  ctx: AstPreValidationCtx,
  typeDef: TypeDef,
  field: string,
  value: unknown,
): void {
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown> & { kind?: string };
  if (node.kind !== "set" || typeof node.castType !== "string") return;
  if (((node.values as unknown[] | undefined)?.length ?? 0) !== 0) return;

  const pointer = findAstPointer(ctx, typeDef, field);
  if (!pointer) return;

  const castName = qualifyCastTypeName(ctx, node.castType);

  if (pointer.kind === "field") {
    const declared = declaredScalarTypeName(pointer.field);
    if (castName !== declared) {
      preValidationFail(
        `invalid target for property '${field}' of object type ` +
        `'${qualifiedTypeName(typeDef)}': '${castName}' (expecting '${declared}')`,
      );
    }
  } else {
    // Link: the cast target must be assignable to the link's declared target.
    const declared = qualifyAstTypeName(pointer.link.targetType, ctx.module);
    if (castName === declared) return;
    const castObj = lookupAstObjectType(ctx, node.castType);
    const declaredObj = ctx.schema.getType(declared);
    const compatible =
      castObj && declaredObj &&
      ctx.schema.concreteTypeNamesUnder(declared).includes(qualifiedTypeName(castObj));
    if (!compatible) {
      preValidationFail(
        `invalid target for link '${field}' of object type ` +
        `'${qualifiedTypeName(typeDef)}': '${castName}' (expecting '${declared}')`,
      );
    }
  }
}

// A SELECT tuple `(S, (INSERT … ref-to-S))` correlates its elements: a DML
// statement in one element may not reference (or insert into) a set that also
// appears as a bare extent in a sibling element. Detect that and reject with
// EdgeQL's "cannot reference correlated set" wording
// (test_edgeql_insert_correlated_bad_01/02/03, for_bad_*).
function checkCorrelatedDmlInTuple(ctx: AstPreValidationCtx, elements: unknown[]): void {
  // Bare object-type extents referenced as tuple elements (`Subordinate`,
  // `Person` — a whole-set SELECT with no narrowing clauses).
  const correlated = new Set<string>();
  for (const el of elements) {
    const name = bareObjectExtentName(ctx, el);
    if (name) correlated.add(name);
  }
  if (correlated.size === 0) return;

  for (const el of elements) {
    const dml = unwrapToInsert(el);
    if (!dml) continue;
    const referenced = insertReferencesCorrelatedSet(ctx, dml.insert, dml.forIterators, correlated);
    if (referenced) {
      preValidationFail(`cannot reference correlated set '${referenced}' here`);
    }
  }
}

// Resolve a tuple element that is a plain reference to an object type's full
// extent (no FILTER/LIMIT/OFFSET/ORDER), returning the type name.
function bareObjectExtentName(ctx: AstPreValidationCtx, value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown> & { kind?: string };
  if (node.kind === "select" && typeof node.typeName === "string") {
    const clauses = (node.clauses as Record<string, unknown> | undefined) ?? {};
    if (clauses.filter !== undefined || clauses.limit !== undefined || clauses.offset !== undefined || clauses.order !== undefined) {
      return undefined;
    }
    const qn = qualifyAstTypeName(node.typeName as string, ctx.module);
    if (lookupAstObjectType(ctx, node.typeName as string)) return qn.slice(qn.lastIndexOf("::") + 2);
  }
  if (node.kind === "binding_ref" && typeof node.name === "string" && !ctx.bindings.has(node.name)) {
    if (lookupAstObjectType(ctx, node.name as string)) return node.name as string;
  }
  return undefined;
}

// Peel `mutation_expr` / `select` / `for_expr` wrappers off a tuple element to
// reach an INSERT, recording any FOR iterators encountered en route (their
// iterated sets count as correlated references too).
function unwrapToInsert(value: unknown, iterators: unknown[] = [], depth = 0): { insert: Record<string, unknown>; forIterators: unknown[] } | undefined {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const node = value as Record<string, unknown> & { kind?: string };
  if (node.kind === "insert") return { insert: node, forIterators: iterators };
  if (node.kind === "mutation_expr") return unwrapToInsert(node.statement, iterators, depth + 1);
  if (node.kind === "select" || node.kind === "select_expr" || node.kind === "select_expr_subquery" || node.kind === "subquery_expr") {
    return unwrapToInsert(node.expr ?? node.statement, iterators, depth + 1);
  }
  if (node.kind === "for_expr" || node.kind === "for") {
    return unwrapToInsert(node.body, [...iterators, node.iterator], depth + 1);
  }
  // A nested tuple (`SELECT (20, (FOR y … INSERT …))`) — descend into each
  // element until an INSERT surfaces, carrying the accumulated FOR iterators.
  if (node.kind === "tuple" && Array.isArray(node.values)) {
    for (const el of node.values) {
      const found = unwrapToInsert(el, iterators, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

// Does an INSERT (possibly within FOR scopes) reference a correlated set name?
function insertReferencesCorrelatedSet(
  ctx: AstPreValidationCtx,
  insert: Record<string, unknown>,
  forIterators: unknown[],
  correlated: Set<string>,
): string | undefined {
  // Inserting into a type that is itself a correlated extent (bad_03).
  const subject = insert.typeName as string | undefined;
  if (subject && correlated.has(subject)) return subject;

  // A FOR loop iterating over a correlated extent (for_bad_*).
  for (const it of forIterators) {
    const name = bareObjectExtentName(ctx, it);
    if (name && correlated.has(name)) return name;
  }

  // A shape value referencing the correlated set by name (bad_01/02).
  let hit: string | undefined;
  walkAstForValidation(insert.values, (n) => {
    if (hit) return;
    if (n.kind === "binding_ref" && typeof n.name === "string" && correlated.has(n.name) && !ctx.bindings.has(n.name)) {
      hit = n.name;
    }
  });
  return hit;
}

// True when an INSERT shape value references a partial path (`.foo`, an AST
// `current_item`) in its own scope, i.e. not nested inside a sub-query that
// would supply the path's source. Such a path has nothing to resolve against.
// True when an INSERT shape value is provably a multi set (more than one
// element). Conservative: only forms we can prove multi return true; anything
// uncertain returns false so well-formed single assignments aren't rejected.
function insertValueProvablyMulti(ctx: AstPreValidationCtx, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown> & { kind?: string };

  // A bare reference to an object type (`sub := Subordinate`) is a multi set
  // unless the name is a WITH/FOR-bound (necessarily single-or-known) variable.
  if (node.kind === "binding_ref") {
    const name = node.name as string;
    if (ctx.bindings.has(name)) return false;
    return lookupAstObjectType(ctx, name) !== undefined;
  }

  // `subject := (SELECT T FILTER …)` — a filtered select over an object type
  // is multi unless it is constrained to at most one element (a `LIMIT 1`, or
  // an equality filter on an exclusive single property).
  if (node.kind === "select" && typeof node.typeName === "string") {
    const clauses = (node.clauses as Record<string, unknown> | undefined) ?? {};
    if (clauses.filter === undefined) return false; // unfiltered: leave to runtime
    if (clauses.limit !== undefined) return false; // LIMIT may pin to one
    return !selectFilterGuaranteesSingle(ctx, node.typeName as string, clauses.filter);
  }

  return false;
}

// Does a SELECT's FILTER guarantee at most one row? True only for an equality
// predicate on an exclusive-constrained single property of the subject type.
function selectFilterGuaranteesSingle(ctx: AstPreValidationCtx, typeName: string, filter: unknown): boolean {
  const pred = filter as Record<string, unknown> & { kind?: string };
  if (!pred || pred.kind !== "predicate" || pred.op !== "=") return false;
  const target = pred.target as Record<string, unknown> & { kind?: string };
  if (!target || target.kind !== "field" || typeof target.field !== "string") return false;
  const typeDef = lookupAstObjectType(ctx, typeName);
  if (!typeDef) return false;
  const fieldDef = (typeDef.fields ?? []).find((f) => f.name === target.field && !f.isLinkColumn);
  if (!fieldDef || fieldDef.multi) return false;
  return (fieldDef.constraints ?? []).some((c) => c.name === "std::exclusive" || c.name === "exclusive");
}
