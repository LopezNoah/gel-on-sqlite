// Execution strategy — the single source of truth for "how does this query run?"
//
// The SQL-vs-runtime decision used to be split three ways: the SQL gate
// (`loweringMode !== "single_statement" || sql.length === 0`, deduped into
// `lowersToSingleSql`, see docs/adr/0003), the engine's `needsRuntimeEval`
// AST walk (this module), and the kind-specific reject throws in the engine
// dispatch. This module unifies them: `classifyExecutionStrategy` returns the
// one verdict, the engine dispatches on it (its reject sites and its
// select_expr runtime entry), and the compile-inspection seam reports it as the
// `strategy` Compile fact — so the engine and the inspector cannot disagree
// (architecture review candidate #2; completes docs/adr/0003).

import type {
  ComputedExpr,
  FreeObjectExpr,
  ShapeElement,
  Statement,
  WithBinding,
  WithBindingValue,
} from "../edgeql/ast.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { lowersToSingleSql, type GelIRSQLArtifact } from "../sql/compiler_types.js";

type SelectExprStmt = Extract<Statement, { kind: "select_expr" }>;

// Mirror of the engine's private helper; trivial enough to inline rather than
// share (avoids a compiler↔runtime import cycle).
const qualifiedRuntimeAliasName = (name: string): string =>
  name.includes("::") ? name : `default::${name}`;

export type ExecutionStrategy = "sql" | "runtime" | "reject";

/**
 * Does this `select_expr` statement require the runtime evaluator (free
 * objects, FOR, UDF calls, runtime aliases, link-property subqueries…) rather
 * than the SQL path? Extracted verbatim from the engine's
 * `tryRuntimeSelectExprEvaluationAst` so the engine's runtime entry and the
 * inspector's `strategy` fact share one predicate.
 */
export function selectExprNeedsRuntime(ast: SelectExprStmt, schema: SchemaSnapshot): boolean {
  const needsRuntimeEval = (expr: FreeObjectExpr): boolean => {
    switch (expr.kind) {
      case "binding_ref": {
        const alias = schema.getAlias(qualifiedRuntimeAliasName(expr.name));
        return Boolean(alias?.exprText && !alias.values && !alias.sourceType);
      }
      case "function_call": {
        const shortName = expr.call.name.split("::").at(-1) ?? expr.call.name;
        const argWrapsShapedSelect = expr.call.args.some((arg) => arg.kind === "expr"
          && arg.expr.kind === "select_expr_subquery"
          && arg.expr.expr.kind === "select"
          && Array.isArray(arg.expr.expr.shape)
          && arg.expr.expr.shape.length > 1);
        if (argWrapsShapedSelect && (shortName === "assert_exists" || shortName === "assert_single" || shortName === "assert_distinct")) {
          return false;
        }
        return Boolean(schema.findFunction(ast.withModule ?? "default", shortName, expr.call.args.length))
          || ["array_unpack", "range_unpack", "range", "max", "assert_exists", "assert_single", "enumerate"].includes(shortName)
          || expr.call.args.some((arg) => arg.kind === "expr" ? needsRuntimeEval(arg.expr) : arg.kind === "function_call" ? needsRuntimeEval({ kind: "function_call", call: arg.call }) : arg.kind === "binding_ref" ? needsRuntimeEval({ kind: "binding_ref", name: arg.name }) : false);
      }
      case "for_expr":
        return true;
      case "free_object_constructor":
        // Top-level free objects (`{a:=1, b:={2,3,4}, c:={d:=5}}`) must
        // materialise at runtime as a single row whose multi-valued entries
        // are arrays — SQL lowering can't express the free-object set shape.
        return true;
      case "field_access":
        return needsRuntimeEval(expr.expr);
      case "distinct":
      case "exists":
        return needsRuntimeEval(expr.expr);
      case "cast":
        return needsRuntimeEval(expr.expr);
      case "select": {
        const alias = schema.getAlias(qualifiedRuntimeAliasName(expr.typeName));
        return Boolean(alias?.values);
      }
      case "select_expr_subquery":
        if (expr.expr.kind === "shape_projection") return false;
        return Boolean(expr.orderBy) || needsRuntimeEval(expr.expr);
      case "set_expr":
      case "tuple":
        return expr.values.some((value) => needsRuntimeEval(value));
      case "math":
      case "compare":
      case "and":
      case "or":
        return needsRuntimeEval(expr.left) || needsRuntimeEval(expr.right);
      case "not":
        return needsRuntimeEval(expr.expr);
      case "if_else":
        return needsRuntimeEval(expr.thenExpr) || needsRuntimeEval(expr.condition) || needsRuntimeEval(expr.elseExpr);
      case "shape_projection":
        return needsRuntimeEval(expr.expr);
      case "index_access":
      case "is_type":
        return needsRuntimeEval(expr.expr);
      case "concat":
        // A concat containing a user-defined function call must take the
        // runtime path so the per-source-row LCP iteration handles the
        // function correctly (OPTIONAL parameters etc.).
        return expr.parts.some((part) => needsRuntimeEval(part));
      default:
        return false;
    }
  };

  const isEnumScalarTypeDef = (typeName: string | undefined): boolean => {
    if (!typeName) return false;
    const qualified = typeName.includes("::") ? typeName : qualifiedRuntimeAliasName(typeName);
    const typeDef = schema.getType(qualified) ?? schema.getType(typeName);
    if (!typeDef) return false;
    const first = typeDef.fields[0];
    return typeDef.fields.length === 1
      && first?.name === "__enum__"
      && Boolean(first?.enumValues?.length);
  };

  const bindingNeedsRuntime = (binding: WithBinding): boolean => {
    const value = binding.value;
    if (value.kind === "enum_path") return false;
    if (value.kind === "path") return !isEnumScalarTypeDef(value.head);
    if (value.kind === "path_chain") return !isEnumScalarTypeDef(value.parts?.[0]);
    if (value.kind === "binding_ref") return !isEnumScalarTypeDef(value.name);
    if (value.kind === "subquery") {
      // Defer only when the subquery has no link-property shape, AND the outer
      // query doesn't access link properties on a shape-redefined link.
      const computedHasForExpr = (expr: ComputedExpr | FreeObjectExpr | WithBindingValue | undefined): boolean => {
        if (!expr || typeof expr !== "object") return false;
        if (expr.kind === "for_expr") return true;
        if (expr.kind === "select_expr" || expr.kind === "subquery_expr" || expr.kind === "select_expr_subquery") {
          return computedHasForExpr(expr.expr);
        }
        return false;
      };
      const shapeHasForExpr = (shape: ShapeElement[] | undefined): boolean => Boolean(
        shape?.some((el) => el.kind === "computed" && computedHasForExpr(el.expr)),
      );
      if (shapeHasForExpr(value.query.shape)) return true;
      const shapeHasLinkProperty = (shape: ShapeElement[] | undefined): boolean => Boolean(
        shape?.some((el) => (el.kind === "computed" || el.kind === "field") && el.name.startsWith("@")
          || (el.kind === "link" && shapeHasLinkProperty(el.shape))
          || (el.kind === "computed" && el.expr.kind === "select_expr" && el.expr.expr.kind === "select_expr_subquery"
              && (() => {
                let inner: FreeObjectExpr = el.expr.expr;
                while (inner && inner.kind === "select_expr_subquery") inner = inner.expr;
                if (inner?.kind === "select") return shapeHasLinkProperty(inner.shape);
                return false;
              })())
        ),
      );
      if (shapeHasLinkProperty(value.query.shape)) return true;
      // Check the outer ast for link-property access on this binding name.
      const outerNeedsLinkProps = (expr: FreeObjectExpr): boolean => {
        if (!expr || typeof expr !== "object") return false;
        if (expr.kind === "shape_projection") {
          if (shapeHasLinkProperty(expr.shape)) return true;
          return outerNeedsLinkProps(expr.expr);
        }
        if (
          expr.kind === "distinct"
          || expr.kind === "cast"
          || expr.kind === "field_access"
          || expr.kind === "index_access"
          || expr.kind === "slice_access"
          || expr.kind === "exists"
          || expr.kind === "not"
          || expr.kind === "unary"
          || expr.kind === "is_type"
          || expr.kind === "select_expr_subquery"
        ) {
          return outerNeedsLinkProps(expr.expr);
        }
        return false;
      };
      if (outerNeedsLinkProps(ast.expr)) return true;
      return false;
    }
    // Defer to the regular compile path for raw path-based subqueries; the
    // runtime fallback below cannot traverse link junctions on plain paths.
    if (value.kind === "subquery_expr") {
      // Only defer when the inner is a pure field_access chain (no shape).
      let inner: FreeObjectExpr = value.expr;
      while (inner.kind === "select_expr_subquery") {
        inner = inner.expr;
      }
      if (inner.kind === "field_access") return false;
    }
    return true;
  };

  const withRequiresRuntime = (ast.with ?? []).some(bindingNeedsRuntime);
  return withRequiresRuntime || needsRuntimeEval(ast.expr);
}

/**
 * The one verdict on how a compiled statement runs. `sql`: executes off the SQL
 * artifact. `runtime`: handled by the runtime evaluator / write path. `reject`:
 * the engine raises E_UNSUPPORTED (no lowering, no runtime path). Faithful to
 * the engine's dispatch — the engine consumes this at its reject sites and its
 * select_expr runtime entry, so the inspector's `strategy` fact matches what the
 * engine actually does.
 */
export function classifyExecutionStrategy(
  ast: Statement,
  artifact: GelIRSQLArtifact,
  schema: SchemaSnapshot,
): ExecutionStrategy {
  if (lowersToSingleSql(artifact)) return "sql";
  // Past the SQL gate: the engine still runs most kinds off the (possibly
  // incomplete) SQL artifact via runGelSelectSQL — it only *rejects*
  // (E_UNSUPPORTED) for select_free that didn't reach single_statement mode and
  // for GROUP that didn't lower; only select_expr/FOR divert to the runtime
  // evaluator. "sql" here means "executes via the SQL path", distinct from
  // `lowersToSingleSql` (whether that lowering was clean).
  switch (ast.kind) {
    case "select_expr":
      return selectExprNeedsRuntime(ast, schema) ? "runtime" : "sql";
    case "select_free":
      // Matches the dispatch guard: throws unless mode reached single_statement.
      return artifact.loweringMode !== "single_statement" ? "reject" : "sql";
    case "group":
      // Engine throws E_UNSUPPORTED when a GROUP can't lower to one statement.
      return "reject";
    case "for":
      // FOR bodies that don't lower run via the runtime evaluator / executeForLoop.
      return "runtime";
    case "insert":
    case "update":
    case "delete":
      // Mutations run via the write path, which splices SQL-lowered columns.
      return "runtime";
    default:
      // Plain SELECT with a source executes off the artifact via runGelSelectSQL.
      return "sql";
  }
}
