import { AppError, tryResult } from "../errors.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import type { FilterExpr, FreeObjectExpr, InsertValue, SelectStatement, Statement, TypeExpr, WithBindingValue } from "../edgeql/ast.js";
import type {
  DeleteIR,
  InferenceResult,
  InsertIR,
  InsertLinkAssignmentIR,
  InsertLinkDefaultIR,
  InsertLinkPropertyIR,
  PathIdIR,
  UpdateIR,
  UpdateLinkAssignmentIR,
} from "../ir/model.js";
import { normalizeLinkTargetNames, qualifiedTypeName, type SchemaSnapshot } from "../schema/schema.js";
import { tableNameForType } from "../codegen/sql.js";
import type { ScalarType, ScalarValue, TypeDef } from "../types.js";
import { checkScopeTreeViolations } from "./scope_tree_check.js";

// Standalone INSERT/UPDATE/DELETE lowering: parser AST → runtime mutation
// plan (the model.ts DML IR shapes the engine's mutation executor consumes).
//
// This is the DML slice of the legacy semantic.ts `compileToIR`, extracted so
// mutation statements no longer route through the legacy pipeline at all —
// they compile through ast_to_ir/gel_ir for the SQL artifact, plus this module
// for the runtime plan (link-table writes, defaults, conflict targets). The
// remaining legacy consumer is GROUP; semantic.ts is deleted outright once
// GROUP lowers fully to SQL.
//
// A few helpers (binding-scalar resolution, filter-value resolution) still
// have twins inside semantic.ts because its select path uses them too; those
// copies die with semantic.ts rather than being worth a shared module now.
//
// The legacy DML IRs carried `triggers`/`policies`/`inference` and a refined
// update cardinality (via inferAstMultiplicity). All three fields are dead —
// nothing reads them off mutation IRs (the engine enforces policies straight
// from TypeDef) — so this port keeps only the cheap conflict/predicate-based
// cardinality for debug-dump value and drops the rest.

export type DmlStatement = Extract<Statement, { kind: "insert" | "update" | "delete" }>;

// Sentinel plan value for an insert/update scalar assignment whose value can't
// be resolved statically (function calls, subqueries, paths into WITH
// bindings, FOR bodies, …). The runtime mutation executor replaces it with the
// column's SQL-lowered expression from the gelIR insert artifact
// (GelIRSQLArtifact.insertColumns), so arbitrary EdgeQL expressions still
// lower fully to SQL.
export const PENDING_INSERT_SQL_EXPR_VALUE = "__gel_pending_insert_sql_expr__";

export interface DmlCompileContext {
  globals?: Record<string, ScalarValue>;
  // Set after `CONFIGURE SESSION SET allow_user_specified_id := true`: lets an
  // INSERT assign an explicit `id` rather than rejecting it as server-generated
  // (test_edgeql_insert_explicit_id_*).
  allowUserSpecifiedId?: boolean;
}

// Resolves the explicit `id` value an INSERT supplies under
// `allow_user_specified_id`. The parser already folds `<uuid>'…'` to a bare
// string and `<uuid>to_json('"…"')` to a JSON-quoted string; strip the JSON
// quotes so both forms store (and round-trip) as the same uuid text. Returns
// undefined for an empty value (`<optional uuid>{}`), which the caller turns
// into the required-property error (test_edgeql_insert_explicit_id_06).
const resolveExplicitInsertId = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
      const parsed = tryResult(() => JSON.parse(value) as unknown, { captureAll: true });
      if (parsed.ok && typeof parsed.value === "string") return parsed.value;
    }
    return value;
  }
  return undefined;
};

type MutationValueKind = "insert" | "update" | "delete";

type FieldEqPredicate = Extract<FilterExpr, { kind: "predicate" }> & {
  op: "=";
  target: { kind: "field"; field: string };
};

export const compileDmlToIR = (
  schema: SchemaSnapshot,
  statement: DmlStatement,
  context: DmlCompileContext = {},
): InsertIR | UpdateIR | DeleteIR => {
  const fail = (message: string): never => {
    throw new AppError("E_SEMANTIC", message, statement.pos.line, statement.pos.column);
  };

  const requireValue = <T>(value: T, message: string): NonNullable<T> => {
    if (value === undefined || value === null) {
      fail(message);
    }

    return value as NonNullable<T>;
  };

  const requireDefined = <T>(value: T, message: string): Exclude<T, undefined> => {
    if (value === undefined) {
      fail(message);
    }

    return value as Exclude<T, undefined>;
  };

  checkScopeTreeViolations(statement, schema);

  const moduleNames = new Set(schema.listTypes().map((typeDef) => typeDef.module ?? "default"));
  const resolveModuleName = (name: string): string => {
    if (moduleNames.has(name)) {
      return name;
    }

    const stdFallback = `std::${name}`;
    if (moduleNames.has(stdFallback)) {
      return stdFallback;
    }

    return name;
  };

  const activeModule = statement.withModule ? resolveModuleName(statement.withModule) : "default";
  const moduleAliases = new Map(
    (statement.withModuleAliases ?? []).map((entry) => [entry.alias, resolveModuleName(entry.module)] as const),
  );

  const normalizeTypeName = (name: string, fallbackModule: string = activeModule): string => {
    if (!name.includes("::")) {
      return `${fallbackModule}::${name}`;
    }

    const [head, ...rest] = name.split("::");
    const aliasedModule = moduleAliases.get(head);
    if (!aliasedModule) {
      return name;
    }

    return rest.length === 0 ? aliasedModule : `${aliasedModule}::${rest.join("::")}`;
  };

  const resolveObjectTypeOrAliasSource = (name: string, fallbackModule: string = activeModule): TypeDef | undefined => {
    const normalizedName = normalizeTypeName(name, fallbackModule);
    const alias = schema.getAlias(normalizedName);
    if (alias?.sourceType) {
      return schema.getType(normalizeTypeName(alias.sourceType, alias.module ?? fallbackModule));
    }
    return schema.getType(normalizedName);
  };

  const withBindings = new Map((statement.with ?? []).map((binding) => [binding.name, binding.value] as const));
  const resolvedBindingValues = new Map<string, ScalarValue>();
  const resolvingBindingValues = new Set<string>();

  const validateCastType = (castType: string, bindingName: string): void => {
    if (![
      "str",
      "int",
      "float",
      "bool",
      "json",
      "datetime",
      "duration",
      "local_datetime",
      "local_date",
      "local_time",
      "relative_duration",
      "date_duration",
      "uuid",
      // cal:: namespaced builtin scalar aliases.
      "cal::local_datetime",
      "cal::local_date",
      "cal::local_time",
      "cal::relative_duration",
      "cal::date_duration",
    ].includes(castType)) {
      fail(`Unsupported cast type '${castType}' in with binding '${bindingName}'`);
    }
  };

  const resolveWithBindingScalar = (name: string): ScalarValue => {
    if (resolvedBindingValues.has(name)) {
      return resolvedBindingValues.get(name) as ScalarValue;
    }

    if (resolvingBindingValues.has(name)) {
      fail(`Cyclic with binding '${name}'`);
    }

    const binding = requireValue(withBindings.get(name), `Unknown with binding '${name}'`);

    resolvingBindingValues.add(name);
    const resolved: ScalarValue = (() => {
      switch (binding.kind) {
        case "literal":
          return binding.value;
        case "set_literal":
          return fail(`With binding '${name}' is a set and cannot be used as a scalar value`);
        case "array_literal":
          return fail(`With binding '${name}' is an array and cannot be used as a scalar value`);
        case "binding_ref": {
          const resolvedType = schema.getType(normalizeTypeName(binding.name, activeModule));
          if (resolvedType) {
            const isEnumScalarType = resolvedType.fields.some((f) => f.name === "__enum__");
            if (isEnumScalarType) {
              fail(`enum path expression lacks an enum member name, as in 'color_enum_t.GREEN'`);
            }
          }
          return resolveWithBindingScalar(binding.name);
        }
        case "parameter": {
          if (binding.castType) {
            validateCastType(binding.castType, name);
          }

          const globals = context.globals ?? {};
          if (!Object.prototype.hasOwnProperty.call(globals, binding.name)) {
            fail(`Unknown query parameter '$${binding.name}'`);
          }
          const raw = requireDefined(globals[binding.name], `Unknown query parameter '$${binding.name}'`);
          return binding.castType
            ? coerceCastScalarValue(binding.castType, raw, `$${binding.name}`)
            : coerceRuntimeScalarValue(raw, `$${binding.name}`);
        }
        case "subquery":
          return fail(`With binding '${name}' is a subquery and cannot be used as a scalar value`);
        case "path_chain":
          return fail(`With binding '${name}' is a path and cannot be used as a scalar value`);
        case "backlink_path":
          return fail(`With binding '${name}' is a backlink path and cannot be used as a scalar value`);
        case "enum_path": {
          const normalizedEnumType = normalizeTypeName(binding.enumType, activeModule);
          const enumTypeDef = schema.getType(normalizedEnumType);
          if (!enumTypeDef) {
            return fail(`Unknown enum type '${normalizedEnumType}'`);
          }
          const allEnumValues = enumTypeDef.fields.flatMap((f) => f.enumValues ?? []);
          if (allEnumValues.length === 0) {
            fail(`Type '${normalizedEnumType}' is not an enum`);
          }
          if (!allEnumValues.includes(binding.member)) {
            fail(`enum '${normalizedEnumType}' has no member called '${binding.member}'`);
          }
          return binding.member;
        }
        case "subquery_expr": {
          // Resolve a small set of expression kinds whose value can be
          // computed statically from the WITH binding alone. Most WITH
          // bindings in test corpora bind a string-concat or function-call
          // expression that the runtime evaluates row-by-row, so we don't
          // need a heavyweight evaluator here — just enough to feed an
          // insert/update assignment its source string.
          const resolveExpr = (e: FreeObjectExpr): ScalarValue => {
            if (e.kind === "literal") return e.value;
            if (e.kind === "binding_ref") return resolveWithBindingScalar(e.name);
            if (e.kind === "cast") {
              const inner = resolveExpr(e.expr);
              // EdgeQL casts coerce the value to the target scalar type.
              // Without applying it here, `<str>random()` returns a JS number
              // which then fails INSERT field validation ("Type mismatch").
              const stripModule = (t: string): string => t.startsWith("std::") ? t.slice(5) : t;
              const target = stripModule(e.castType ?? "").toLowerCase();
              if (inner === null || inner === undefined) return inner as ScalarValue;
              if (target === "str") return String(inner);
              if (target === "int16" || target === "int32" || target === "int64") {
                const n = typeof inner === "number" ? Math.trunc(inner) : Number(inner);
                return Number.isFinite(n) ? n : inner;
              }
              if (target === "float32" || target === "float64") {
                return typeof inner === "number" ? inner : Number(inner);
              }
              if (target === "bool") return Boolean(inner);
              return inner;
            }
            if (e.kind === "concat") {
              return e.parts.map((part) => {
                const value = resolveExpr(part);
                return value === null || value === undefined ? "" : String(value);
              }).join("");
            }
            if (e.kind === "function_call") {
              const fnName = e.call.name;
              const isRandom = fnName === "random" || fnName === "std::random";
              if (isRandom && e.call.args.length === 0) {
                // `random()` baseline — produce a deterministic-per-binding
                // value so subsequent references see the same number. EdgeQL
                // semantics: random() is a volatile function whose value is
                // captured at the binding site and reused across references.
                return Math.random();
              }
            }
            return fail(`Unsupported subquery_expr with kind '${e.kind}' in '${name}'`);
          };
          return resolveExpr(binding.expr);
        }
        case "path": {
          const normalizedHead = normalizeTypeName(binding.head, activeModule);
          const headTypeDef = schema.getType(normalizedHead);
          if (headTypeDef) {
            const enumField = headTypeDef.fields.length === 1 ? headTypeDef.fields[0] : undefined;
            const enumValues = enumField?.name === "__enum__" ? enumField.enumValues : undefined;
            if (enumValues !== undefined && enumValues.length > 0) {
              const allEnumValues = enumValues;
              if (!allEnumValues.includes(binding.tail)) {
                fail(`enum '${normalizedHead}' has no member called '${binding.tail}'`);
              }
              return binding.tail;
            }
          }
          return fail(`Unknown type or enum '${normalizedHead}'`);
        }
        default:
          return fail(`Unsupported with binding kind in '${name}'`);
      }
    })();

    resolvingBindingValues.delete(name);
    resolvedBindingValues.set(name, resolved);
    return resolved;
  };

  const resolveFilterValue = (
    value: ScalarValue | { kind: "binding_ref"; name: string } | { kind: "set_literal"; values: ScalarValue[] } | { kind: "field_ref"; field: string } | { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string },
  ): ScalarValue | ScalarValue[] | { kind: "field_ref"; field: string } | { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } => {
    if (typeof value === "object" && value !== null && "kind" in value) {
      if (value.kind === "binding_ref") {
        return resolveWithBindingScalar(value.name);
      }
      if (value.kind === "set_literal") {
        return value.values;
      }
      if (value.kind === "field_ref") {
        return value;
      }
      if (value.kind === "backlink_property_ref") {
        return value;
      }
    }

    return value as ScalarValue;
  };

  // Resolve a with-binding to a scalar when statically possible; otherwise
  // defer the assignment to the SQL artifact. Any failure leaves the
  // in-progress resolution set dirty, so clear it before returning the
  // deferred sentinel.
  const resolveBindingScalarOrDefer = (name: string): ScalarValue => {
    if (!withBindings.has(name)) {
      // Not a WITH binding at all (e.g. FOR iterator variable, `__default__`)
      // — only the SQL lowering can resolve it.
      return PENDING_INSERT_SQL_EXPR_VALUE;
    }
    const attempt = tryResult(() => resolveWithBindingScalar(name));
    if (attempt.ok) {
      return attempt.value;
    }
    resolvingBindingValues.clear();
    return PENDING_INSERT_SQL_EXPR_VALUE;
  };

  const resolveInsertScalarValue = (value: InsertValue): ScalarValue => {
    if (typeof value !== "object" || value === null || !("kind" in value)) {
      return value as ScalarValue;
    }

    const resolveFreeObjectScalar = (expr: FreeObjectExpr): ScalarValue => {
      if (expr.kind === "literal") {
        return expr.value;
      }
      if (expr.kind === "binding_ref") {
        return resolveBindingScalarOrDefer(expr.name);
      }
      if (expr.kind === "cast") {
        return resolveFreeObjectScalar(expr.expr);
      }
      if (expr.kind === "concat") {
        const parts = expr.parts.map((part) => resolveFreeObjectScalar(part));
        if (parts.some((part) => part === PENDING_INSERT_SQL_EXPR_VALUE)) {
          return PENDING_INSERT_SQL_EXPR_VALUE;
        }
        return parts.map((part) => String(part ?? "")).join("");
      }
      if (expr.kind === "math") {
        const leftValue = resolveFreeObjectScalar(expr.left);
        const rightValue = resolveFreeObjectScalar(expr.right);
        if (leftValue === PENDING_INSERT_SQL_EXPR_VALUE || rightValue === PENDING_INSERT_SQL_EXPR_VALUE) {
          return PENDING_INSERT_SQL_EXPR_VALUE;
        }
        const left = Number(leftValue);
        const right = Number(rightValue);
        if (expr.op === "+") return left + right;
        if (expr.op === "-") return left - right;
        if (expr.op === "*") return left * right;
        if (expr.op === "/") return left / right;
        if (expr.op === "//") return Math.trunc(left / right);
        if (expr.op === "%") return left % right;
      }
      // Anything else (function calls, paths, subqueries, field access, …)
      // lowers through the gelIR SQL artifact instead.
      return PENDING_INSERT_SQL_EXPR_VALUE;
    };

    switch (value.kind) {
      case "binding_ref":
        return resolveBindingScalarOrDefer(value.name);
      case "expr":
        return resolveFreeObjectScalar(value.expr);
      case "array_literal":
        return JSON.stringify(value.values);
      case "tuple_literal":
        return JSON.stringify(value.values);
      default:
        return PENDING_INSERT_SQL_EXPR_VALUE;
    }
  };

  // A multi `json` property stores its elements as a JSON array of the actual
  // JSON values. resolveInsertSetValues yields each element as json *text*
  // (e.g. `"bar"`, `[1,2]`), so for json fields we parse each back to its
  // value before the array is JSON.stringified — otherwise the elements get
  // double-encoded as quoted strings.
  const encodeMultiSetForStorage = (values: ScalarValue[], fieldType: string): unknown[] => {
    if (fieldType !== "json") return values;
    return values.map((v) => {
      if (typeof v !== "string") return v;
      // captureAll: JSON.parse throws native SyntaxError (not an AppError) and
      // "not valid JSON" is exactly the probed condition here.
      const parsed = tryResult(() => JSON.parse(v) as unknown, { captureAll: true });
      return parsed.ok ? parsed.value : v;
    });
  };

  // A named-tuple field (`q3 -> tuple<x: str, y: decimal>`) accepts a
  // positional tuple literal (`('p11', 3.33n)`); coerce the stored positional
  // JSON array into the named object form using the field's declared slot
  // names so introspection / shape access see `{x, y}`.
  const encodeNamedTupleForStorage = (
    scalar: ScalarValue,
    fieldDef: { collection?: { kind: string; elementNames?: string[] } },
  ): ScalarValue => {
    const coll = fieldDef.collection;
    if (!coll || coll.kind !== "tuple" || !coll.elementNames || typeof scalar !== "string") {
      return scalar;
    }
    // captureAll: JSON.parse throws native SyntaxError (not an AppError);
    // non-JSON input just means "leave the scalar as-is".
    const parseAttempt = tryResult(() => JSON.parse(scalar) as unknown, { captureAll: true });
    if (parseAttempt.ok && Array.isArray(parseAttempt.value)) {
      const parsed = parseAttempt.value;
      const obj: Record<string, unknown> = {};
      coll.elementNames.forEach((name, idx) => { obj[name] = parsed[idx]; });
      return JSON.stringify(obj);
    }
    return scalar;
  };

  const resolveInsertSetValues = (value: InsertValue): ScalarValue[] => {
    if (typeof value !== "object" || value === null || !("kind" in value)) {
      return [value as ScalarValue];
    }

    if (value.kind === "set") {
      return value.values.flatMap((entry) => resolveInsertSetValues(entry));
    }

    if (value.kind === "binding_ref") {
      return [resolveBindingScalarOrDefer(value.name)];
    }

    if (value.kind === "array_literal") {
      return [JSON.stringify(value.values)];
    }

    if (value.kind === "tuple_literal") {
      return [JSON.stringify(value.values)];
    }

    // Non-static multi assignment (subquery, function call, …) — defer the
    // whole field to the SQL artifact.
    return [PENDING_INSERT_SQL_EXPR_VALUE];
  };

  const resolveShapeSourceObjectType = (expr: FreeObjectExpr): TypeDef | undefined => {
    if (expr.kind === "binding_ref") {
      const directBinding = withBindings.get(expr.name);
      if (directBinding) {
        if (directBinding.kind === "subquery_expr") return resolveShapeSourceObjectType(directBinding.expr);
        if (directBinding.kind === "subquery") return resolveObjectTypeOrAliasSource(directBinding.query.typeName);
        if (directBinding.kind === "subquery_statement") {
          const stmt = directBinding.statement;
          if (stmt.kind === "select" || stmt.kind === "insert" || stmt.kind === "update") {
            return resolveObjectTypeOrAliasSource(stmt.typeName);
          }
        }
      }
      return resolveObjectTypeOrAliasSource(expr.name);
    }
    if (expr.kind === "select") return resolveObjectTypeOrAliasSource(expr.typeName);
    if (expr.kind === "shape_projection") return resolveShapeSourceObjectType(expr.expr);
    if (expr.kind === "cast") return resolveShapeSourceObjectType(expr.expr);
    if (expr.kind === "distinct") return resolveShapeSourceObjectType(expr.expr);
    if (expr.kind === "select_expr_subquery") return resolveShapeSourceObjectType(expr.expr);
    if (expr.kind === "set_expr") {
      for (const v of expr.values) {
        const t = resolveShapeSourceObjectType(v);
        if (t) return t;
      }
      return undefined;
    }
    if (expr.kind === "for_expr") return resolveShapeSourceObjectType(expr.body);
    if (expr.kind === "mutation_expr") {
      const stmt = expr.statement;
      if (stmt.kind === "insert" || stmt.kind === "update") {
        return resolveObjectTypeOrAliasSource(stmt.typeName);
      }
      return undefined;
    }
    return undefined;
  };

  const tryExtractTypedRootExpr = (expr: FreeObjectExpr): TypeExpr | undefined => {
    if (expr.kind === "distinct") {
      return tryExtractTypedRootExpr(expr.expr);
    }
    if (expr.kind === "is_type" && expr.typeExpr) {
      const inner = tryExtractTypedRootExpr(expr.expr);
      if (!inner) return undefined;
      return { kind: "type_intersection", left: inner, right: expr.typeExpr };
    }
    if (expr.kind === "set_expr") {
      if (expr.values.length === 0) return undefined;
      const exprs: TypeExpr[] = [];
      for (const value of expr.values) {
        const inner = tryExtractTypedRootExpr(value);
        if (!inner) return undefined;
        exprs.push(inner);
      }
      return exprs.reduce((acc, next) => ({ kind: "type_union", left: acc, right: next }));
    }
    if (expr.kind === "binding_ref") {
      return { kind: "type_name", name: expr.name };
    }
    if (expr.kind === "select") {
      const hasOnlyDefaultId = !expr.shape
        || expr.shape.length === 0
        || expr.shape.every((el) => el.kind === "field" && el.name === "id" && el.origin === "default");
      if (hasOnlyDefaultId) {
        return { kind: "type_name", name: expr.typeName };
      }
    }
    if (expr.kind === "path_steps") {
      const head = expr.steps[0];
      if (!head || head.kind !== "object_ref") return undefined;
      let current: TypeExpr = { kind: "type_name", name: head.name };
      for (const step of expr.steps.slice(1)) {
        if (step.kind !== "type_intersection" || !step.typeExpr) return undefined;
        current = { kind: "type_intersection", left: current, right: step.typeExpr };
      }
      return current;
    }
    if (expr.kind === "select_expr_subquery") {
      return tryExtractTypedRootExpr(expr.expr);
    }
    return undefined;
  };

  const mergeFilters = (
    left: SelectStatement["filter"] | undefined,
    right: SelectStatement["filter"] | undefined,
  ): SelectStatement["filter"] | undefined => {
    if (!left) {
      return right;
    }
    if (!right) {
      return left;
    }

    return {
      kind: "and",
      left,
      right,
    };
  };

  const resolveWithBindingTypeSource = (
    name: string,
    seen = new Set<string>(),
  ): { typeName: string; filter?: SelectStatement["filter"] } | undefined => {
    if (seen.has(name)) return undefined;
    seen.add(name);

    const binding = withBindings.get(name);
    if (!binding) return undefined;

    if (binding.kind === "binding_ref") {
      const normalized = normalizeTypeName(binding.name, activeModule);
      if (schema.getType(normalized)) {
        return { typeName: binding.name };
      }
      return resolveWithBindingTypeSource(binding.name, seen);
    }

    if (binding.kind === "subquery") {
      return {
        typeName: binding.query.typeName,
        filter: binding.query.clauses.filter,
      };
    }

    if (binding.kind === "subquery_expr") {
      const peelSelect = (expr: FreeObjectExpr): Extract<FreeObjectExpr, { kind: "select" }> | undefined => {
        if (expr.kind === "select") return expr;
        if (expr.kind === "select_expr_subquery" || expr.kind === "distinct") return peelSelect(expr.expr);
        return undefined;
      };
      const selectExpr = peelSelect(binding.expr);
      if (selectExpr) {
        return {
          typeName: selectExpr.typeName,
          filter: selectExpr.clauses.filter,
        };
      }
      const typedRoot = tryExtractTypedRootExpr(binding.expr);
      if (typedRoot?.kind === "type_name") {
        return { typeName: typedRoot.name };
      }
      // set_expr / for_expr / mutation_expr that yields object rows — fall
      // back to the first branch's source type so consumers (UPDATE, SELECT
      // of binding) can find a table to operate on.
      const obj = resolveShapeSourceObjectType(binding.expr);
      if (obj) return { typeName: qualifiedTypeName(obj) };
    }

    return undefined;
  };

  const exprContainsMutation = (expr: FreeObjectExpr | undefined): MutationValueKind | undefined => {
    if (!expr) return undefined;
    if (expr.kind === "mutation_expr") return expr.statement.kind;
    if (expr.kind === "set_expr" || expr.kind === "tuple" || expr.kind === "array_literal_expr") {
      for (const value of expr.values) {
        const nested = exprContainsMutation(value);
        if (nested) return nested;
      }
      return undefined;
    }
    if (expr.kind === "free_object_constructor") {
      for (const entry of expr.entries) {
        const nested = exprContainsMutation(entry.expr);
        if (nested) return nested;
      }
      return undefined;
    }
    if (expr.kind === "shape_projection" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "exists" || expr.kind === "field_access" || expr.kind === "index_access" || expr.kind === "slice_access" || expr.kind === "is_type" || expr.kind === "unary" || expr.kind === "select_expr_subquery") {
      return exprContainsMutation((expr as { expr: FreeObjectExpr }).expr);
    }
    if (expr.kind === "compare" || expr.kind === "math" || expr.kind === "logical" || expr.kind === "coalesce" || expr.kind === "and" || expr.kind === "or") {
      return exprContainsMutation(expr.left) ?? exprContainsMutation(expr.right);
    }
    if (expr.kind === "if_else") {
      return exprContainsMutation(expr.condition) ?? exprContainsMutation(expr.thenExpr) ?? exprContainsMutation(expr.elseExpr);
    }
    if (expr.kind === "concat") {
      for (const part of expr.parts) {
        const nested = exprContainsMutation(part);
        if (nested) return nested;
      }
    }
    if (expr.kind === "function_call") {
      for (const arg of expr.call.args) {
        if (arg.kind === "expr") {
          const nested = exprContainsMutation(arg.expr);
          if (nested) return nested;
        }
      }
    }
    return undefined;
  };

  const filterContainsMutation = (filter: FilterExpr | undefined): MutationValueKind | undefined => {
    if (!filter) return undefined;
    if (filter.kind === "free_expr") return exprContainsMutation(filter.expr);
    if (filter.kind === "and" || filter.kind === "or") return filterContainsMutation(filter.left) ?? filterContainsMutation(filter.right);
    if (filter.kind === "not") return filterContainsMutation(filter.expr);
    return undefined;
  };

  if (statement.kind === "delete") {
    const mutationInFilter = filterContainsMutation(statement.filter);
    if (mutationInFilter) {
      fail(`${mutationInFilter.toUpperCase()} statements cannot be used in a FILTER clause`);
    }
    const mutationInOrder = exprContainsMutation(statement.orderBy?.expr);
    if (mutationInOrder) {
      fail(`${mutationInOrder.toUpperCase()} statements cannot be used in an ORDER BY clause`);
    }

    const bindingValue = (name: string): WithBindingValue | undefined => statement.with?.find((binding) => binding.name === name)?.value;
    const bindingExpr = (value: WithBindingValue | undefined): FreeObjectExpr | undefined => {
      if (!value) return undefined;
      if (value.kind === "subquery_expr") return value.expr;
      if (value.kind === "subquery") return { kind: "select", typeName: value.query.typeName, shape: value.query.shape, clauses: value.query.clauses };
      return undefined;
    };
    const isFreeObjectDeleteTarget = (expr: FreeObjectExpr | undefined): boolean => {
      if (!expr) return false;
      if (expr.kind === "free_object_constructor") return true;
      if (expr.kind === "binding_ref") return isFreeObjectDeleteTarget(bindingExpr(bindingValue(expr.name)));
      if (expr.kind === "select_expr_subquery") return isFreeObjectDeleteTarget(expr.expr);
      return false;
    };
    const containsStdlibDeleteTarget = (expr: FreeObjectExpr | undefined): boolean => {
      if (!expr) return false;
      if (expr.kind === "select") {
        const normalized = normalizeTypeName(expr.typeName, activeModule);
        return normalized.startsWith("schema::") || (normalized.startsWith("std::") && normalized !== "std::FreeObject");
      }
      if (expr.kind === "set_expr") return expr.values.some(containsStdlibDeleteTarget);
      if (expr.kind === "select_expr_subquery") return containsStdlibDeleteTarget(expr.expr);
      if (expr.kind === "shape_projection" || expr.kind === "distinct" || expr.kind === "cast" || expr.kind === "is_type" || expr.kind === "field_access") {
        return containsStdlibDeleteTarget((expr as { expr: FreeObjectExpr }).expr);
      }
      if (expr.kind === "binding_ref") return containsStdlibDeleteTarget(bindingExpr(bindingValue(expr.name)));
      return false;
    };
    const normalizedDeleteType = normalizeTypeName(statement.typeName, activeModule);
    if (normalizedDeleteType === "std::FreeObject" || isFreeObjectDeleteTarget(statement.target)) {
      fail("free objects cannot be deleted");
    }
    if (normalizedDeleteType.startsWith("schema::") || (normalizedDeleteType.startsWith("std::") && normalizedDeleteType !== "std::Object") || containsStdlibDeleteTarget(statement.target)) {
      fail("cannot delete standard library type");
    }
    if (statement.target && (statement.target.kind === "literal" || statement.target.kind === "set_literal" || statement.target.kind === "array_literal_expr" || statement.target.kind === "tuple")) {
      fail("cannot delete non-ObjectType object");
    }
  }

  const resolvedRootType = {
    typeDef: (() => {
      const rawTypeName = requireValue(statement.typeName, `Statement kind '${statement.kind}' requires typeName`);
      const bindingSource = resolveWithBindingTypeSource(rawTypeName);
      const norm = normalizeTypeName(bindingSource?.typeName ?? rawTypeName, activeModule);
      if (norm === "default::Object" || norm === "std::Object") {
        return { name: "Object", module: activeModule, fields: [], abstract: true, extends: [] } as TypeDef;
      }
      if (norm === "std::FreeObject") {
        return { name: "FreeObject", module: "std", fields: [], abstract: true, extends: [] } as TypeDef;
      }
      if (statement.kind === "insert" && schema.getAlias(norm)) {
        fail(`cannot insert into expression alias '${norm}'`);
      }
      return requireValue(
        schema.getType(norm),
        `Unknown type '${norm}'`,
      );
    })(),
    clauses: {
      filter: resolveWithBindingTypeSource(requireValue(statement.typeName, `Statement kind '${statement.kind}' requires typeName`))?.filter,
    },
  };
  const typeDef = resolvedRootType.typeDef;
  const table = tableNameForType(qualifiedTypeName(typeDef));
  // SDL-loaded snapshots flatten inherited members into each subtype, but
  // runtime-DDL types (`CREATE TYPE Bar EXTENDING Named`) keep them on the
  // base — walk the extends chain so inherited pointers resolve either way.
  const collectInheritedFields = (root: TypeDef): TypeDef["fields"] => {
    const seen = new Set<string>();
    const collected: TypeDef["fields"] = [];
    const visit = (def: TypeDef | undefined, guard: Set<string>): void => {
      if (!def) return;
      const key = qualifiedTypeName(def);
      if (guard.has(key)) return;
      guard.add(key);
      for (const field of def.fields) {
        if (seen.has(field.name)) continue;
        seen.add(field.name);
        collected.push(field);
      }
      for (const baseName of def.extends ?? []) {
        visit(schema.getType(baseName.includes("::") ? baseName : `${def.module ?? "default"}::${baseName}`), guard);
      }
    };
    visit(root, new Set());
    return collected;
  };
  const allFields = (typeDef.extends ?? []).length > 0 ? collectInheritedFields(typeDef) : typeDef.fields;
  const userFields = allFields.filter((field) => field.name !== "id");
  const knownFields = new Set(["id", ...userFields.map((f) => f.name)]);
  const fieldByName = new Map([
    ["id", { name: "id", type: "uuid" as const, required: true }],
    ...userFields.map((field) => [field.name, field] as const),
  ]);
  const insertRewriteFields = new Set((typeDef.mutationRewrites ?? [])
    .filter((rewrite) => Boolean(rewrite.onInsert))
    .map((rewrite) => rewrite.field));

  const typeName = statement.typeName;

  const ensureField = (fieldName: string): void => {
    if (!knownFields.has(fieldName)) {
      fail(`Unknown field '${fieldName}' on '${typeName}'`);
    }
  };

  const validateFieldValue = (fieldName: string, value: ScalarValue): void => {
    ensureField(fieldName);
    const field = requireValue(fieldByName.get(fieldName), `Unknown field '${fieldName}' on '${typeName}'`);

    if (field.multi) {
      if (typeof value !== "string") {
        fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);
      }

      try {
        const serialized = typeof value === "string"
          ? value
          : fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);
        const parsed: unknown = JSON.parse(serialized);
        const parsedArray = Array.isArray(parsed)
          ? parsed
          : fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);

        for (const entry of parsedArray) {
          // Each element of a multi `json` property is itself an arbitrary
          // JSON value (object/array/string/number/bool) — all are valid, so
          // don't run the scalar check that would (incorrectly) try to parse
          // a json *string* element like "bar" as json text.
          if (field.type !== "json" && !isValidScalarValue(field.type, entry)) {
            fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);
          }
          if (field.enumValues && typeof entry === "string" && !field.enumValues.includes(entry)) {
            fail(`invalid input value for enum '${typeName}': "${entry}"`);
          }
        }
      } catch {
        // Parity with the legacy compiler: any failure while decoding the
        // multi set — including the more specific fails above — surfaces as
        // the generic multi type mismatch.
        fail(`Type mismatch for '${fieldName}': expected multi ${field.type}`);
      }
      return;
    }

    if (!isValidScalarValue(field.type, value)) {
      fail(`Type mismatch for '${fieldName}': expected ${field.type}`);
    }

    if (field.enumValues && typeof value === "string" && !field.enumValues.includes(value)) {
      fail(`invalid input value for enum '${typeName}': "${value}"`);
    }
  };

  const toPathIdIR = (id: string): PathIdIR => ({
    id,
    steps: [],
    isPointerPath: false,
  });

  // Legacy compiles allocated path ids per compile starting at p0; a DML
  // statement consumes exactly one.
  const pathId = "p0";

  if (statement.kind === "insert") {
    const pendingInlineLinkValue = "__gel_pending_inline_link__";
    const pendingGeneratedValueForField = (fieldName: string): ScalarValue => {
      const field = fieldByName.get(fieldName);
      if (!field) {
        return "__gel_pending_insert_rewrite__";
      }

      if (field.multi) {
        return "[]";
      }

      switch (field.type) {
        case "int":
        case "float":
          return 0;
        case "bool":
          return false;
        case "json":
          return "null";
        case "uuid":
          return pendingInlineLinkValue;
        default:
          return "__gel_pending_insert_rewrite__";
      }
    };
    if (typeDef.abstract) {
      // `Object` and `FreeObject` are stdlib types — they're loaded under the
      // "default" module in our schema fixture but EdgeQL surfaces them as
      // `std::Object`/`std::FreeObject` in error messages. Rewrite the
      // qualified name so tests assertioning the upstream wording match.
      const qualified = qualifiedTypeName(typeDef);
      const reported = (typeDef.name === "Object" || typeDef.name === "FreeObject")
        ? `std::${typeDef.name}`
        : qualified;
      // `std::FreeObject` has a distinct upstream error ("free objects cannot
      // be inserted") even though it's also abstract.
      if (typeDef.name === "FreeObject") {
        fail("free objects cannot be inserted");
      }
      fail(`cannot insert into abstract object type '${reported}'`);
    }
    if (statement.typeName === "std::FreeObject") {
      // Catches the case where the schema doesn't have FreeObject registered
      // at all — we still want the right diagnostic.
      fail("free objects cannot be inserted");
    }
    // Inserting into a schema alias (e.g. `CREATE ALIAS Foo := SELECT T;
    // INSERT Foo;`) is rejected — aliases are read-only expressions.
    const aliasName = statement.typeName.includes("::")
      ? statement.typeName
      : `default::${statement.typeName}`;
    if (schema.getAlias(aliasName)) {
      fail(`cannot insert into expression alias '${aliasName}'`);
    }

    const linkByName = new Map((typeDef.links ?? []).map((link) => [link.name, link] as const));
    const scalarValues: Record<string, ScalarValue> = {};

    const validateInsertLinkExpr = (linkName: string, value: InsertValue): void => {
      if (typeof value !== "object" || value === null || !("kind" in value)) {
        if (typeof value !== "string" && value !== null) {
          fail(`Link '${linkName}' assignments require object ids or subqueries`);
        }
        return;
      }

      if (value.kind === "binding_ref") {
        return;
      }
      if (value.kind === "select") {
        return;
      }
      if (value.kind === "insert") {
        return;
      }
      if (value.kind === "set") {
        for (const item of value.values) {
          validateInsertLinkExpr(linkName, item);
        }
        return;
      }
      if (value.kind === "for") {
        return;
      }
      if (value.kind === "function_call") {
        return;
      }
      if (value.kind === "expr") {
        return;
      }

      fail(`Unsupported insert expression for link '${linkName}'`);
    };

    for (const [field, value] of Object.entries(statement.values)) {
      if (field === "id") {
        // Without `CONFIGURE SESSION SET allow_user_specified_id := true`, `id`
        // is server-generated and assigning it is an error
        // (test_edgeql_insert_explicit_id_00).
        if (!context.allowUserSpecifiedId) {
          fail("'id' is server-generated and cannot be assigned");
        }
        // With the config on, the explicit id is written verbatim. The cast
        // `<uuid>'…'` / `<uuid>to_json('"…"')` is already folded by the parser
        // to a (possibly JSON-quoted) string; `<optional uuid>{}` stays an
        // expr wrapping an empty set, which fails the required-property check
        // (test_edgeql_insert_explicit_id_06).
        const explicitId = requireDefined(
          resolveExplicitInsertId(value),
          `missing value for required property 'id' of object type '${qualifiedTypeName(typeDef)}'`,
        );
        scalarValues.id = explicitId;
        continue;
      }

      if (knownFields.has(field)) {
        const fieldDef = requireValue(fieldByName.get(field), `Unknown field '${field}' on '${statement.typeName}'`);
        const setValues = fieldDef.multi ? resolveInsertSetValues(value) : undefined;
        const scalar = setValues
          ? (setValues.includes(PENDING_INSERT_SQL_EXPR_VALUE)
              ? PENDING_INSERT_SQL_EXPR_VALUE
              : JSON.stringify(encodeMultiSetForStorage(setValues, fieldDef.type)))
          : encodeNamedTupleForStorage(resolveInsertScalarValue(value), fieldDef);
        if (scalar !== PENDING_INSERT_SQL_EXPR_VALUE) {
          validateFieldValue(field, scalar);
        }
        scalarValues[field] = scalar;
        continue;
      }

      if (linkByName.has(field)) {
        const linkDef = requireValue(linkByName.get(field), `Unknown link '${field}' on '${statement.typeName}'`);
        validateInsertLinkExpr(field, value);

        const usesLinkTable = Boolean(linkDef.multi) || (linkDef.properties?.length ?? 0) > 0;
        if (!usesLinkTable) {
          const inlineColumn = `${field}_id`;
          const inlineFieldDef = fieldByName.get(inlineColumn);

          if (typeof value === "string" || value === null) {
            validateFieldValue(inlineColumn, value);
            scalarValues[inlineColumn] = value;
          } else if (inlineFieldDef?.required) {
            scalarValues[inlineColumn] = pendingInlineLinkValue;
          }
        }

        continue;
      }

      fail(`Unknown field '${field}' on '${statement.typeName}'`);
    }

    for (const field of userFields) {
      if (field.required && !(field.name in scalarValues)) {
        if (insertRewriteFields.has(field.name)) {
          scalarValues[field.name] = pendingGeneratedValueForField(field.name);
          continue;
        }
        if (field.hasDefault) {
          // Defaults the engine can re-evaluate (literals, function calls,
          // `__source__.…` expressions) get the rewrite sentinel so the
          // engine's default application replaces them — typed placeholders
          // (0/false/…) would be indistinguishable from real values there.
          // Anything else (e.g. `SELECT count(T)` snapshot defaults) keeps
          // the legacy typed placeholder.
          const engineEvaluable = field.defaultExpr !== undefined
            || (field.defaultExprText ?? "").includes("__source__");
          scalarValues[field.name] = field.multi
            ? "[]"
            : engineEvaluable
              ? "__gel_pending_insert_rewrite__"
              : pendingGeneratedValueForField(field.name);
          continue;
        }
        fail(`missing value for required property '${field.name}' of object type '${qualifiedTypeName(typeDef)}'`);
      }
    }

    const linkAssignments = buildInsertLinkAssignments(schema, typeDef, statement.values, linkByName);
    const linkDefaults = buildInsertLinkDefaults(schema, typeDef, statement.values);

    // Cardinality of an INSERT:
    //   • plain INSERT → one (always inserts exactly one row)
    //   • UNLESS CONFLICT without ELSE → at_most_one (might silently skip)
    //   • UNLESS CONFLICT … ELSE <expr> → depends on the ELSE branch:
    //     - same-type ELSE: the ON-field filter on a unique key narrows it to
    //       exactly one row, joined with the always-one INSERT branch → "one"
    //     - different-type ELSE: use that type's set cardinality (many)
    let insertCard: InferenceResult["cardinality"] = "one";
    if (statement.conflict) {
      const elseExpr = statement.conflict.else;
      if (!elseExpr) {
        insertCard = "at_most_one";
      } else if ((elseExpr as { typeName?: string }).typeName === statement.typeName) {
        insertCard = "one";
      } else {
        insertCard = "many";
      }
    }
    const insertInference: InferenceResult = {
      cardinality: insertCard,
      multiplicity: "unique",
      volatility: "modifying",
    };

    return {
      kind: "insert",
      pathId: toPathIdIR(pathId),
      table,
      values: scalarValues,
      linkAssignments: linkAssignments.length > 0 ? linkAssignments : undefined,
      linkDefaults: linkDefaults.length > 0 ? linkDefaults : undefined,
      inference: insertInference,
      overlays: [
        {
          table,
          sourcePathId: pathId,
          operation: "union",
          policyPhase: "none",
          rewritePhase: "none",
        },
      ],
    };
  }

  if (statement.kind === "update") {
    let filterExpr = mergeFilters(resolvedRootType.clauses.filter, statement.filter);
    // Normalize a free_expr-form filter into a predicate when it's a
    // simple `<binding>.<field> = <literal>` comparison. This shows up in
    // queries like `WITH X := DETACHED User UPDATE X FILTER (X.name = …)`
    // where the user explicitly qualifies the subject by its alias.
    if (filterExpr && filterExpr.kind === "free_expr") {
      const e = filterExpr.expr;
      if (e.kind === "compare" && e.op === "=") {
        const targetName = statement.typeName;
        const pickField = (s: FreeObjectExpr): string | undefined => {
          if (s.kind === "path" && s.head === targetName) return s.tail;
          if (s.kind === "field_access" && s.expr.kind === "binding_ref" && s.expr.name === targetName) return s.field;
          if (s.kind === "field_access" && s.expr.kind === "current_item") return s.field;
          return undefined;
        };
        const leftField = pickField(e.left);
        const rightField = pickField(e.right);
        const fieldName = leftField ?? rightField;
        const valueSide = leftField ? e.right : (rightField ? e.left : undefined);
        if (fieldName && valueSide && valueSide.kind === "literal") {
          filterExpr = {
            kind: "predicate",
            target: { kind: "field", field: fieldName },
            op: "=",
            value: valueSide.value,
          };
        }
      }
    }
    let predicateFilter: FieldEqPredicate | undefined;
    if (filterExpr) {
      if (filterExpr.kind !== "predicate") {
        fail("Update filters currently support only a single predicate");
      } else {
        if (filterExpr.op !== "=") {
          fail("Update filters currently support only '='");
        }
        if (filterExpr.target.kind !== "field") {
          fail("Update filters do not support backlink targets");
        }
        predicateFilter = filterExpr as FieldEqPredicate;
        validateFieldValue(predicateFilter.target.field, resolveFilterValue(predicateFilter.value) as ScalarValue);
      }
    }

    const linkByName = new Map((typeDef.links ?? []).map((link) => [link.name, link] as const));

    const validateUpdateLinkExpr = (linkName: string, value: InsertValue): void => {
      if (typeof value !== "object" || value === null || !("kind" in value)) {
        if (typeof value !== "string" && value !== null) {
          fail(`Link '${linkName}' assignments require object ids or subqueries`);
        }
        return;
      }

      if (value.kind === "binding_ref" || value.kind === "select" || value.kind === "insert" || value.kind === "for") {
        return;
      }
      if (value.kind === "set") {
        for (const item of value.values) {
          validateUpdateLinkExpr(linkName, item);
        }
        return;
      }

      fail(`Unsupported update expression for link '${linkName}'`);
    };

    const scalarValues: Record<string, ScalarValue> = {};
    const updateFields = Object.entries(statement.values);
    // EdgeQL permits `UPDATE T FILTER X SET {}` as an explicit no-op that still
    // resolves the FILTER and returns the matched rows. The shape is then
    // available to a wrapping `SELECT (UPDATE … SET {}) { … }` projection.

    for (const [field, value] of updateFields) {
      if (field === "id") {
        fail("'id' is server-generated and cannot be assigned");
      }

      if (knownFields.has(field)) {
        if (typeof value === "object" && value !== null && "kind" in value && value.kind === "expr") {
          continue;
        }
        const fieldDef = requireValue(fieldByName.get(field), `Unknown field '${field}' on '${statement.typeName}'`);
        const setValues = fieldDef.multi ? resolveInsertSetValues(value) : undefined;
        const scalar = setValues
          ? (setValues.includes(PENDING_INSERT_SQL_EXPR_VALUE)
              ? PENDING_INSERT_SQL_EXPR_VALUE
              : JSON.stringify(encodeMultiSetForStorage(setValues, fieldDef.type)))
          : encodeNamedTupleForStorage(resolveInsertScalarValue(value), fieldDef);
        if (scalar !== PENDING_INSERT_SQL_EXPR_VALUE) {
          validateFieldValue(field, scalar);
        }
        scalarValues[field] = scalar;
        continue;
      }

      if (linkByName.has(field)) {
        validateUpdateLinkExpr(field, value);
        continue;
      }

      fail(`Unknown field '${field}' on '${statement.typeName}'`);
    }

    const updateLinkAssignments = buildUpdateLinkAssignments(schema, typeDef, statement.values, statement.operations, linkByName);

    return {
      kind: "update",
      pathId: toPathIdIR(pathId),
      table,
      filter: predicateFilter
        ? {
            column: predicateFilter.target.field,
            value: resolveFilterValue(predicateFilter.value) as ScalarValue,
          }
        : undefined,
      values: scalarValues,
      linkAssignments: updateLinkAssignments.length > 0 ? updateLinkAssignments : undefined,
      overlays: [
        {
          table,
          sourcePathId: pathId,
          operation: "replace",
          policyPhase: "none",
          rewritePhase: "none",
        },
      ],
      inference: {
        // The legacy compiler refined this through the WITH-binding
        // multiplicity fold (`X := {User, User}` → many); nothing reads
        // mutation-statement inference, so the predicate shortcut is kept
        // only for debug-dump value.
        cardinality: predicateFilter ? "at_most_one" : "many",
        multiplicity: "unique",
        volatility: "modifying",
      },
    };
  }

  const deleteFilterExpr = statement.filter;
  let deletePredicateFilter: FieldEqPredicate | undefined;
  if (deleteFilterExpr) {
    if (deleteFilterExpr.kind === "predicate" && deleteFilterExpr.op === "=" && deleteFilterExpr.target.kind === "field") {
      deletePredicateFilter = deleteFilterExpr as FieldEqPredicate;
      validateFieldValue(deletePredicateFilter.target.field, resolveFilterValue(deletePredicateFilter.value) as ScalarValue);
    }
  }

  return {
    kind: "delete",
    pathId: toPathIdIR(pathId),
    table,
    filter: deletePredicateFilter
      ? {
          column: deletePredicateFilter.target.field,
          value: resolveFilterValue(deletePredicateFilter.value) as ScalarValue,
        }
      : undefined,
    overlays: [
      {
        table,
        sourcePathId: pathId,
        operation: "exclude",
        policyPhase: "none",
        rewritePhase: "none",
      },
    ],
    inference: {
      cardinality: deletePredicateFilter ? "at_most_one" : "many",
      multiplicity: "unique",
      volatility: "modifying",
    },
  };
};

/* ---------------------------------- */
/* __default__ rewriting              */
/* ---------------------------------- */

// `INSERT T { p := __default__ … }` — `__default__` denotes the assigned
// pointer's declared default. Literal defaults substitute in place (so
// `__default__ + 3` stays a computable expression); a bare `__default__`
// assignment is dropped so the regular default machinery applies (covers
// function-call and subquery defaults). Defaults that are themselves DML
// reject the reference, matching upstream. Applied recursively so nested
// INSERTs inside value expressions get the same treatment.
const isDunderDefaultRef = (node: unknown): boolean =>
  typeof node === "object" && node !== null
  && ((node as { kind?: unknown }).kind === "binding_ref" || (node as { kind?: unknown }).kind === "global_ref")
  && (node as { name?: unknown }).name === "__default__";

const containsDunderDefaultRef = (node: unknown): boolean => {
  if (isDunderDefaultRef(node)) return true;
  if (Array.isArray(node)) return node.some(containsDunderDefaultRef);
  if (typeof node !== "object" || node === null) return false;
  return Object.values(node).some(containsDunderDefaultRef);
};

const substituteDunderDefaultRef = (node: unknown, literal: ScalarValue): unknown => {
  if (isDunderDefaultRef(node)) return { kind: "literal", value: literal };
  if (Array.isArray(node)) return node.map((item) => substituteDunderDefaultRef(item, literal));
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = substituteDunderDefaultRef(value, literal);
  return out;
};

export const rewriteDunderDefaults = <T>(schema: SchemaSnapshot, node: T): T => {
  if (!containsDunderDefaultRef(node)) return node;
  const failDunder = (): never => {
    throw new AppError("E_SEMANTIC", "__default__ cannot be used in this expression", 1, 1);
  };
  const rewriteInsertValues = (stmt: Record<string, unknown>): Record<string, unknown> => {
    const typeName = stmt.typeName as string;
    const qualified = typeName.includes("::") ? typeName : `default::${typeName}`;
    const typeDef = schema.getType(qualified);
    const values = { ...(stmt.values as Record<string, unknown>) };
    for (const [field, value] of Object.entries(values)) {
      if (!containsDunderDefaultRef(value)) continue;
      const bare = isDunderDefaultRef(value)
        || (typeof value === "object" && value !== null
            && (value as { kind?: unknown }).kind === "expr"
            && isDunderDefaultRef((value as { expr?: unknown }).expr));
      const fieldDef = typeDef?.fields.find((f) => f.name === field);
      const linkDef = (typeDef?.links ?? []).find((l) => l.name === field);
      if (fieldDef) {
        if (!fieldDef.hasDefault) failDunder();
        if (fieldDef.defaultExpr?.kind === "literal") {
          values[field] = bare
            ? fieldDef.defaultExpr.value
            : substituteDunderDefaultRef(value, fieldDef.defaultExpr.value);
          continue;
        }
        if (bare) {
          // A default that reads sibling values (`__source__.…`) isn't a
          // standalone expression `__default__` can re-emit here.
          if ((fieldDef.defaultExprText ?? "").includes("__source__")) failDunder();
          delete values[field];
          continue;
        }
        failDunder();
      }
      if (linkDef) {
        if (!linkDef.hasDefault) failDunder();
        const defaultIsDml = ((): boolean => {
          const text = (linkDef.defaultExprText ?? "").trim();
          if (!text) return false;
          // Probe: parse the schema default's expression text to classify it;
          // unparsable text is simply "not a DML default".
          const parsed = tryResult(() => parseEdgeQL(text.replace(/^\(\s*/, "").replace(/\s*\)$/, "")));
          if (!parsed.ok) return false;
          const stmt = Array.isArray(parsed.value) ? parsed.value[0] : parsed.value;
          return stmt?.kind === "insert" || stmt?.kind === "update" || stmt?.kind === "delete";
        })();
        if (defaultIsDml || !bare) failDunder();
        delete values[field];
        continue;
      }
      failDunder();
    }
    return { ...stmt, values };
  };
  const walk = (cur: unknown): unknown => {
    if (Array.isArray(cur)) return cur.map(walk);
    if (typeof cur !== "object" || cur === null) return cur;
    const n = cur as Record<string, unknown> & { kind?: unknown };
    // Bottom-up: nested INSERTs consume their own __default__ refs first, so
    // an enclosing insert never mistakes them for refs to its own pointers.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) out[key] = walk(value);
    return out.kind === "insert" && typeof out.typeName === "string" && out.values && typeof out.values === "object"
      ? rewriteInsertValues(out)
      : out;
  };
  return walk(node) as T;
};

/* ---------------------------------- */
/* Link mutation plans                */
/* ---------------------------------- */

const linkDefsEquivalent = (
  a: NonNullable<TypeDef["links"]>[number],
  b: NonNullable<TypeDef["links"]>[number],
): boolean => {
  if (a.name !== b.name) return false;
  if ((a.targetType ?? "") !== (b.targetType ?? "")) return false;
  if (Boolean(a.multi) !== Boolean(b.multi)) return false;
  const aProps = a.properties ?? [];
  const bProps = b.properties ?? [];
  if (aProps.length !== bProps.length) return false;
  for (let i = 0; i < aProps.length; i += 1) {
    const ap = aProps[i];
    const bp = bProps[i];
    if (!bp || ap.name !== bp.name || ap.type !== bp.type) return false;
  }
  return true;
};

// Inherited link tables live on the most-base type where the link is defined
// (e.g. `Owned.owner` stays in `default__owned__owner`, not in each subtype's
// own table). Mirrored by the runtime and the gelIR SQL compiler.
const resolveLinkStorageOwner = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  link: NonNullable<TypeDef["links"]>[number],
): TypeDef => {
  if (link.overloaded) return typeDef;
  let owner = typeDef;
  let current = typeDef;
  while ((current.extends ?? []).length > 0) {
    const baseName = current.extends?.[0];
    if (!baseName) break;
    const baseType = schema.getType(baseName);
    if (!baseType) break;
    const baseLink = (baseType.links ?? []).find((candidate) => candidate.name === link.name);
    if (!baseLink || baseLink.overloaded || !linkDefsEquivalent(link, baseLink)) break;
    owner = baseType;
    current = baseType;
  }
  return owner;
};

const expectedTargetTablesForLink = (
  schema: SchemaSnapshot,
  ownerModule: string,
  link: NonNullable<TypeDef["links"]>[number],
): string[] => {
  const targetTypeNames = normalizeLinkTargetNames(link.targetType, ownerModule);
  const tables = new Set<string>();
  for (const targetTypeName of targetTypeNames) {
    const assignable = schema.listConcreteTypesAssignableTo(targetTypeName);
    if (assignable.length > 0) {
      for (const candidate of assignable) {
        tables.add(tableNameForType(qualifiedTypeName(candidate)));
      }
    } else {
      tables.add(tableNameForType(targetTypeName));
    }
  }
  return [...tables].sort();
};

const linkPropertyIR = (
  property: NonNullable<NonNullable<TypeDef["links"]>[number]["properties"]>[number],
): InsertLinkPropertyIR => {
  const defaultExpr = property.defaultExpr;
  const defaultValue = defaultExpr?.kind === "literal" ? defaultExpr.value : undefined;
  return {
    name: property.name,
    type: property.type as ScalarType,
    hasDefault: Boolean(property.hasDefault),
    defaultValue: defaultValue ?? undefined,
    defaultExprText: defaultValue === undefined ? property.defaultExprText : undefined,
  };
};

const buildInsertLinkAssignments = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  values: Record<string, InsertValue>,
  linkByName: Map<string, NonNullable<TypeDef["links"]>[number]>,
): InsertLinkAssignmentIR[] => {
  const assignments: InsertLinkAssignmentIR[] = [];
  for (const [field, value] of Object.entries(values)) {
    const link = linkByName.get(field);
    if (!link) continue;
    const linkOwner = resolveLinkStorageOwner(schema, typeDef, link);
    const ownerModule = linkOwner.module ?? "default";
    const ownerTable = tableNameForType(qualifiedTypeName(typeDef));
    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    const expectedTargetTables = expectedTargetTablesForLink(schema, ownerModule, link);
    if (usesLinkTable) {
      const properties = (link.properties ?? []).map(linkPropertyIR);
      assignments.push({
        linkName: link.name,
        storage: "table",
        ownerTable,
        linkTable: `${tableNameForType(qualifiedTypeName(linkOwner))}__${link.name.toLowerCase()}`,
        propertyColumns: properties.map((p) => p.name),
        properties,
        expectedTargetTables,
        target: value,
      });
    } else {
      assignments.push({
        linkName: link.name,
        storage: "inline",
        ownerTable,
        inlineColumn: `${link.name}_id`,
        expectedTargetTables,
        target: value,
      });
    }
  }
  return assignments;
};

const buildUpdateLinkAssignments = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  values: Record<string, InsertValue>,
  operations: Record<string, "assign" | "append" | "subtract"> | undefined,
  linkByName: Map<string, NonNullable<TypeDef["links"]>[number]>,
): UpdateLinkAssignmentIR[] => {
  const assignments: UpdateLinkAssignmentIR[] = [];
  for (const [field, value] of Object.entries(values)) {
    const link = linkByName.get(field);
    if (!link) continue;
    const linkOwner = resolveLinkStorageOwner(schema, typeDef, link);
    const ownerModule = linkOwner.module ?? "default";
    const ownerTable = tableNameForType(qualifiedTypeName(typeDef));
    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    const expectedTargetTables = expectedTargetTablesForLink(schema, ownerModule, link);
    const operation = operations?.[field] ?? "assign";
    if (usesLinkTable) {
      const properties = (link.properties ?? []).map(linkPropertyIR);
      assignments.push({
        linkName: link.name,
        storage: "table",
        ownerTable,
        linkTable: `${tableNameForType(qualifiedTypeName(linkOwner))}__${link.name.toLowerCase()}`,
        propertyColumns: properties.map((p) => p.name),
        properties,
        expectedTargetTables,
        operation,
        target: value,
      });
    } else {
      assignments.push({
        linkName: link.name,
        storage: "inline",
        ownerTable,
        inlineColumn: `${link.name}_id`,
        expectedTargetTables,
        operation,
        target: value,
      });
    }
  }
  return assignments;
};

const buildInsertLinkDefaults = (
  schema: SchemaSnapshot,
  typeDef: TypeDef,
  values: Record<string, InsertValue>,
): InsertLinkDefaultIR[] => {
  const defaults: InsertLinkDefaultIR[] = [];
  for (const link of typeDef.links ?? []) {
    if (Object.prototype.hasOwnProperty.call(values, link.name)) continue;
    if (!link.hasDefault) continue;

    const targetQualified = normalizeLinkTargetNames(link.targetType, typeDef.module ?? "default")[0]
      ?? `${typeDef.module ?? "default"}::${link.targetType}`;
    const targetType = schema.getType(targetQualified);
    const parsedFilter = link.defaultTargetFilter;
    const lookupColumn = parsedFilter?.column
      ?? (targetType?.fields.some((field) => field.name === "val")
        ? "val"
        : targetType?.fields.some((field) => field.name === "name")
          ? "name"
          : undefined);

    const usesLinkTable = Boolean(link.multi) || (link.properties?.length ?? 0) > 0;
    const properties = (link.properties ?? []).map(linkPropertyIR);
    const ownerTable = tableNameForType(qualifiedTypeName(typeDef));
    const base = {
      linkName: link.name,
      ownerTable,
      targetTable: tableNameForType(targetQualified),
      defaultTargetValues: parsedFilter ? [...parsedFilter.values] : [...(link.defaultTargetValues ?? [])],
      lookupColumn,
    };
    if (usesLinkTable) {
      defaults.push({
        ...base,
        storage: "table",
        linkTable: `${tableNameForType(qualifiedTypeName(typeDef))}__${link.name.toLowerCase()}`,
        propertyColumns: properties.map((p) => p.name),
        properties,
      });
    } else {
      defaults.push({
        ...base,
        storage: "inline",
        inlineColumn: `${link.name}_id`,
      });
    }
  }
  return defaults;
};

/* ---------------------------------- */
/* Scalar value validation/coercion   */
/* ---------------------------------- */

export const coerceRuntimeScalarValue = (value: unknown, context: string): ScalarValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  throw new AppError("E_SEMANTIC", `Expected scalar runtime value for ${context}`, 1, 1);
};

// LEGITIMATE REGEX (do not remove): the temporal cases below validate/decode
// runtime scalar *values* (ISO-8601 datetime/date/time/duration text). Regex
// on a value's textual form is the right tool — these are data formats, not
// IR/type structure being recovered from a string.
export const coerceCastScalarValue = (castType: string, value: unknown, context: string): ScalarValue => {
  const scalar = coerceRuntimeScalarValue(value, context);

  switch (castType) {
    case "str":
      return scalar === null ? "" : String(scalar);
    case "int": {
      const numeric = typeof scalar === "number" ? scalar : Number(scalar);
      if (!Number.isInteger(numeric)) {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to int`, 1, 1);
      }
      return numeric;
    }
    case "float": {
      const numeric = typeof scalar === "number" ? scalar : Number(scalar);
      if (!Number.isFinite(numeric)) {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to float`, 1, 1);
      }
      return numeric;
    }
    case "bool":
      if (typeof scalar === "boolean") {
        return scalar;
      }
      if (typeof scalar === "string") {
        if (scalar.toLowerCase() === "true") {
          return true;
        }
        if (scalar.toLowerCase() === "false") {
          return false;
        }
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to bool`, 1, 1);
    case "json":
      if (typeof scalar !== "string") {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to json`, 1, 1);
      }
      try {
        JSON.parse(scalar);
        return scalar;
      } catch {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to json`, 1, 1);
      }
    case "datetime": {
      if (typeof scalar !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(scalar)) {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to datetime`, 1, 1);
      }
      const date = new Date(scalar);
      if (Number.isNaN(date.getTime())) {
        throw new AppError("E_SEMANTIC", `Cannot cast ${context} to datetime`, 1, 1);
      }
      return date.toISOString();
    }
    case "local_datetime":
      if (typeof scalar === "string" && isValidLocalDateTime(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to local_datetime`, 1, 1);
    case "local_date":
      if (typeof scalar === "string" && isValidLocalDate(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to local_date`, 1, 1);
    case "local_time":
      if (typeof scalar === "string" && isValidLocalTime(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to local_time`, 1, 1);
    case "duration":
    case "relative_duration":
    case "date_duration":
      if (typeof scalar === "string" && /^[-+]?P/.test(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to ${castType}`, 1, 1);
    case "uuid":
      if (typeof scalar === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scalar)) {
        return scalar;
      }
      throw new AppError("E_SEMANTIC", `Cannot cast ${context} to uuid`, 1, 1);
    default:
      throw new AppError("E_SEMANTIC", `Unsupported cast '${castType}'`, 1, 1);
  }
};

export const isValidScalarValue = (type: ScalarType, value: unknown): value is ScalarValue => {
  if (value === null) {
    return true;
  }

  switch (type) {
    case "str":
      return typeof value === "string";
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "float":
      return typeof value === "number";
    case "bool":
      return typeof value === "boolean";
    case "json":
      if (value === null) {
        return true;
      }
      if (typeof value === "boolean" || typeof value === "number") {
        return true;
      }
      if (typeof value === "string") {
        // captureAll: JSON.parse throws native SyntaxError (not an AppError);
        // the parse failure is the very validity answer being computed.
        return tryResult(() => JSON.parse(value) as unknown, { captureAll: true }).ok;
      }
      if (Array.isArray(value)) {
        return true;
      }
      if (value !== null && typeof value === "object") {
        return true;
      }
      return false;
    case "datetime":
    case "duration":
    case "local_datetime":
    case "local_date":
    case "local_time":
    case "relative_duration":
    case "date_duration":
      return typeof value === "string";
    case "uuid":
      return typeof value === "string";
    default:
      return false;
  }
};

export const isValidLocalDate = (value: string): boolean => {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) {
    return false;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
};

export const isValidLocalDateTime = (value: string): boolean => {
  const matched = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)$/);
  if (!matched) {
    return false;
  }

  return isValidLocalDate(matched[1]) && isValidLocalTime(matched[2]);
};

export const isValidLocalTime = (value: string): boolean => {
  const matched = value.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
  if (!matched) {
    return false;
  }

  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  const second = Number(matched[3] ?? "0");
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
};
