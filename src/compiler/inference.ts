// Inference for the Live IR — the home that lets the Live IR carry the
// inference facts (volatility, …) the interpreter-era oracle (`semantic.ts`)
// still owns, so the oracle can eventually be deleted (the ADR 0001 follow-up).
//
// This module currently implements **volatility**: how an expression behaves
// across evaluations — `immutable` < `stable` < `volatile` < `modifying`. A
// statement's volatility is the max over its components (source, WITH bindings,
// FILTER, ORDER BY, LIMIT, OFFSET, shape computeds); mutations are `modifying`.
// The rules are ported from `semantic.ts`'s inference closure (the oracle that
// the 5 `edgeql_ir_*_inference` tests pin) so the Live IR reproduces the same
// verdicts. It runs over the **AST** (the same input the oracle uses) and is
// invoked by `compileASTToGelIR` to populate `Statement.volatility`. See
// docs/adr/0015. Cardinality / multiplicity / scope-tree parity remain on the
// oracle until ported here too.
import type {
  ComputedExpr,
  FilterExpr,
  FreeObjectExpr,
  OrderExpr,
  OrderExprChain,
  Statement,
  WithBindingValue,
} from "../edgeql/ast.js";
import { normalizeTypeName, type SchemaSnapshot } from "../schema/schema.js";
import { tryResolveStdlibFunction } from "../stdlib/functions.js";

export type Volatility = "immutable" | "stable" | "volatile" | "modifying";

const VOLATILITY_RANK: Record<Volatility, number> = {
  immutable: 0,
  stable: 1,
  volatile: 2,
  modifying: 3,
};

const maxVolatility = (...vols: Volatility[]): Volatility => {
  let result: Volatility = "immutable";
  for (const v of vols) {
    if (VOLATILITY_RANK[v] > VOLATILITY_RANK[result]) result = v;
  }
  return result;
};

const fnVolatilityToLevel = (
  v: "Immutable" | "Stable" | "Volatile" | "Modifying" | undefined,
): Volatility => {
  switch (v) {
    case "Stable":
      return "stable";
    case "Volatile":
      return "volatile";
    case "Modifying":
      return "modifying";
    default:
      return "immutable";
  }
};

type Bindings = Map<string, WithBindingValue>;

// Statement-level volatility for the Live IR, computed from the AST exactly as
// the `semantic.ts` oracle does, so the Live IR reproduces the oracle's verdict.
export const inferStatementVolatility = (
  statement: Statement,
  schema: SchemaSnapshot,
  activeModule = "default",
): Volatility => {
  const normalizeFunctionName = (name: string): string =>
    name.includes("::") ? name : `${activeModule}::${name}`;

  const resolveFunctionVolatility = (name: string, arity: number): Volatility => {
    const stdlib = tryResolveStdlibFunction(name, arity, activeModule);
    if (stdlib) {
      switch (stdlib.volatility) {
        case "immutable":
          return "immutable";
        case "stable":
          return "stable";
        case "volatile":
          return "volatile";
        default:
          return "immutable";
      }
    }
    const qualified = normalizeFunctionName(name);
    const divider = qualified.lastIndexOf("::");
    const moduleName = divider >= 0 ? qualified.slice(0, divider) : activeModule;
    const fnName = divider >= 0 ? qualified.slice(divider + 2) : qualified;
    const fn = schema.findFunction(moduleName, fnName, arity);
    // Unknown function: assume volatile (the conservative direction — never
    // under-report). The oracle throws here; the Live IR inference stays total.
    return fn ? fnVolatilityToLevel(fn.volatility) : "volatile";
  };

  // An object type root (directly, or a schema alias's sourceType) is STABLE;
  // scalar bindings are not.
  const bindingRefIsObjectRoot = (name: string, bindings: Bindings): boolean => {
    if (bindings.has(name)) return false;
    const normalized = normalizeTypeName(name, activeModule);
    if (schema.getType(normalized)) return true;
    const alias = schema.getAlias(normalized);
    if (alias?.sourceType) {
      const sourceName = normalizeTypeName(alias.sourceType, alias.module ?? activeModule);
      return Boolean(schema.getType(sourceName));
    }
    return false;
  };

  const inferTypeNameVolatility = (typeName: string, bindings: Bindings): Volatility => {
    const boundValue = bindings.get(typeName);
    if (boundValue !== undefined) {
      return inferWithBindingValueVolatility(boundValue, bindings);
    }
    const normalized = normalizeTypeName(typeName, activeModule);
    if (schema.getType(normalized)) return "stable";
    const alias = schema.getAlias(normalized);
    if (alias?.sourceType) {
      const sourceName = normalizeTypeName(alias.sourceType, alias.module ?? activeModule);
      if (schema.getType(sourceName)) return "stable";
    }
    return "immutable";
  };

  const inferFilterExprVolatility = (filter: FilterExpr | undefined, bindings: Bindings): Volatility => {
    if (!filter) return "immutable";
    switch (filter.kind) {
      case "predicate":
      case "in_predicate":
        return "immutable";
      case "and":
      case "or":
        return maxVolatility(
          inferFilterExprVolatility(filter.left, bindings),
          inferFilterExprVolatility(filter.right, bindings),
        );
      case "not":
        return inferFilterExprVolatility(filter.expr, bindings);
      case "free_expr":
        return inferFreeObjectExprVolatility(filter.expr, bindings);
    }
  };

  const inferOrderByVolatility = (orderBy: OrderExpr | undefined, bindings: Bindings): Volatility => {
    if (!orderBy) return "immutable";
    const own: Volatility = orderBy.expr ? inferFreeObjectExprVolatility(orderBy.expr, bindings) : "immutable";
    return maxVolatility(own, inferOrderByVolatility(orderBy.then, bindings));
  };

  const inferOrderByChainVolatility = (chain: OrderExprChain | undefined, bindings: Bindings): Volatility => {
    if (!chain) return "immutable";
    return maxVolatility(
      inferFreeObjectExprVolatility(chain.expr, bindings),
      inferOrderByChainVolatility(chain.then, bindings),
    );
  };

  const inferWithBindingValueVolatility = (value: WithBindingValue, bindings: Bindings): Volatility => {
    switch (value.kind) {
      case "literal":
      case "set_literal":
      case "array_literal":
      case "parameter":
      case "enum_path":
        return "immutable";
      case "binding_ref":
        return inferTypeNameVolatility(value.name, bindings);
      case "subquery": {
        const subType = inferTypeNameVolatility(value.query.typeName, bindings);
        const subFilter = inferFilterExprVolatility(value.query.clauses?.filter, bindings);
        const subOrder = inferOrderByVolatility(value.query.clauses?.orderBy, bindings);
        const subLimitExpr = value.query.clauses?.limitExpr
          ? inferFreeObjectExprVolatility(value.query.clauses.limitExpr, bindings)
          : "immutable";
        const subOffsetExpr = value.query.clauses?.offsetExpr
          ? inferFreeObjectExprVolatility(value.query.clauses.offsetExpr, bindings)
          : "immutable";
        return maxVolatility(subType, subFilter, subOrder, subLimitExpr, subOffsetExpr);
      }
      case "subquery_statement":
        return inferStmtVolatility(value.statement, bindings);
      case "subquery_expr":
        return inferFreeObjectExprVolatility(value.expr, bindings);
      case "path":
      case "path_chain":
      case "backlink_path":
        return "stable";
    }
  };

  const inferStmtVolatility = (stmt: Statement, parentBindings: Bindings): Volatility => {
    const localBindings: Bindings = new Map(parentBindings);
    for (const binding of (stmt as { with?: Array<{ name: string; value: WithBindingValue }> }).with ?? []) {
      localBindings.set(binding.name, binding.value);
    }

    if (stmt.kind === "insert" || stmt.kind === "update" || stmt.kind === "delete") {
      return "modifying";
    }

    let bindingsVol: Volatility = "immutable";
    for (const binding of (stmt as { with?: Array<{ name: string; value: WithBindingValue }> }).with ?? []) {
      bindingsVol = maxVolatility(bindingsVol, inferWithBindingValueVolatility(binding.value, localBindings));
    }

    if (stmt.kind === "select") {
      const baseVol = inferTypeNameVolatility(stmt.typeName, localBindings);
      const filterVol = inferFilterExprVolatility(stmt.filter, localBindings);
      const orderByVol = inferOrderByVolatility(stmt.orderBy, localBindings);
      const limitVol = stmt.limitExpr ? inferFreeObjectExprVolatility(stmt.limitExpr, localBindings) : "immutable";
      const offsetVol = stmt.offsetExpr ? inferFreeObjectExprVolatility(stmt.offsetExpr, localBindings) : "immutable";
      return maxVolatility(baseVol, filterVol, orderByVol, limitVol, offsetVol, bindingsVol);
    }

    if (stmt.kind === "select_expr") {
      const exprVol = inferFreeObjectExprVolatility(stmt.expr, localBindings);
      const orderByVol = inferOrderByChainVolatility(stmt.orderBy, localBindings);
      return maxVolatility(exprVol, orderByVol, bindingsVol);
    }

    if (stmt.kind === "select_free") {
      let vol: Volatility = bindingsVol;
      for (const entry of stmt.entries) {
        vol = maxVolatility(vol, inferFreeObjectExprVolatility(entry.expr, localBindings));
      }
      return vol;
    }

    if (stmt.kind === "for") {
      return "stable";
    }

    return bindingsVol;
  };

  const inferFreeObjectExprVolatility = (expr: FreeObjectExpr | ComputedExpr, bindings: Bindings): Volatility => {
    switch (expr.kind) {
      case "literal":
      case "set_literal":
      case "parameter":
      case "substitution":
      case "enum_path":
      case "type_name":
        return "immutable";
      case "global_ref":
        return "stable";
      case "current_item":
      case "field_ref":
      case "polymorphic_field_ref":
      case "field_suffix_math":
        return "immutable";
      case "binding_ref":
        return bindingRefIsObjectRoot(expr.name, bindings) ? "stable" : "immutable";
      case "path":
      case "path_chain":
      case "path_steps":
      case "backlink_path":
        return "stable";
      case "field_access":
        return inferFreeObjectExprVolatility(expr.expr, bindings);
      case "shape_projection": {
        let vol: Volatility = inferFreeObjectExprVolatility(expr.expr, bindings);
        for (const element of expr.shape) {
          if (element.kind === "computed") {
            vol = maxVolatility(vol, inferFreeObjectExprVolatility(element.expr, bindings));
          }
        }
        return vol;
      }
      case "select":
        return inferStmtVolatility({
          kind: "select",
          typeName: expr.typeName,
          shape: expr.shape,
          fields: [],
          filter: expr.clauses?.filter,
          orderBy: expr.clauses?.orderBy,
          limit: expr.clauses?.limit,
          offset: expr.clauses?.offset,
          limitExpr: expr.clauses?.limitExpr,
          offsetExpr: expr.clauses?.offsetExpr,
          pos: { line: 0, column: 0 },
        } as Statement, bindings);
      case "select_expr_subquery": {
        const exprVol = inferFreeObjectExprVolatility(expr.expr, bindings);
        const filterVol = expr.filter ? inferFreeObjectExprVolatility(expr.filter, bindings) : "immutable";
        const orderVol = inferOrderByChainVolatility(expr.orderBy, bindings);
        const limitVol = expr.limitExpr ? inferFreeObjectExprVolatility(expr.limitExpr, bindings) : "immutable";
        const offsetVol = expr.offsetExpr ? inferFreeObjectExprVolatility(expr.offsetExpr, bindings) : "immutable";
        let extraBindingsVol: Volatility = "immutable";
        const subBindings: Bindings = new Map(bindings);
        for (const binding of expr.clauses?._withBindings ?? []) {
          subBindings.set(binding.name, binding.value);
          extraBindingsVol = maxVolatility(extraBindingsVol, inferWithBindingValueVolatility(binding.value, subBindings));
        }
        const exprVolWithBindings = inferFreeObjectExprVolatility(expr.expr, subBindings);
        return maxVolatility(exprVol, exprVolWithBindings, filterVol, orderVol, limitVol, offsetVol, extraBindingsVol);
      }
      case "set_expr":
      case "tuple":
      case "array_literal_expr":
        return expr.values.reduce<Volatility>((acc, value) => maxVolatility(acc, inferFreeObjectExprVolatility(value, bindings)), "immutable");
      case "set_op":
      case "compare":
      case "and":
      case "or":
      case "in_expr":
      case "math":
      case "logical":
      case "coalesce":
        return maxVolatility(
          inferFreeObjectExprVolatility(expr.left, bindings),
          inferFreeObjectExprVolatility(expr.right, bindings),
        );
      case "distinct":
      case "exists":
      case "not":
      case "unary":
      case "cast":
        return inferFreeObjectExprVolatility(expr.expr, bindings);
      case "if_else":
        return maxVolatility(
          inferFreeObjectExprVolatility(expr.thenExpr, bindings),
          inferFreeObjectExprVolatility(expr.condition, bindings),
          inferFreeObjectExprVolatility(expr.elseExpr, bindings),
        );
      case "is_type":
        return inferFreeObjectExprVolatility(expr.expr, bindings);
      case "concat":
        return expr.parts.reduce<Volatility>((acc, part) => maxVolatility(acc, inferFreeObjectExprVolatility(part, bindings)), "immutable");
      case "free_object_constructor":
        return expr.entries.reduce<Volatility>((acc, entry) => maxVolatility(acc, inferFreeObjectExprVolatility(entry.expr, bindings)), "immutable");
      case "function_call": {
        let vol: Volatility = resolveFunctionVolatility(expr.call.name, expr.call.args.length);
        for (const arg of expr.call.args) {
          if (arg.kind === "expr") {
            vol = maxVolatility(vol, inferFreeObjectExprVolatility(arg.expr, bindings));
          }
        }
        return vol;
      }
      case "for_expr": {
        const iterVol = inferFreeObjectExprVolatility(expr.iterator, bindings);
        const bodyVol = inferFreeObjectExprVolatility(expr.body, bindings);
        const filterVol = expr.filter ? inferFreeObjectExprVolatility(expr.filter, bindings) : "immutable";
        const limitVol = expr.limitExpr ? inferFreeObjectExprVolatility(expr.limitExpr, bindings) : "immutable";
        const offsetVol = expr.offsetExpr ? inferFreeObjectExprVolatility(expr.offsetExpr, bindings) : "immutable";
        return maxVolatility(iterVol, bodyVol, filterVol, limitVol, offsetVol);
      }
      default:
        // Any AST node the oracle's switch did not enumerate: treat as
        // immutable (it carries no volatile sub-evaluation of its own).
        return "immutable";
    }
  };

  return inferStmtVolatility(statement, new Map());
};
