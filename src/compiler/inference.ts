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
  FunctionCallExpr,
  OrderExpr,
  OrderExprChain,
  ShapeElement,
  Statement,
  TypeExpr,
  WithBindingValue,
} from "../edgeql/ast.js";
import { normalizeTypeName, qualifiedTypeName, type SchemaSnapshot } from "../schema/schema.js";
import { tryResolveStdlibFunction } from "../stdlib/functions.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import { tryResult } from "../errors.js";
import type { TypeDef } from "../types.js";

export type Volatility = "immutable" | "stable" | "volatile" | "modifying";

export type CardLevel = "one" | "many" | "at_most_one" | "at_least_one" | "empty" | "unknown";

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

// ───────────────────────── Cardinality inference ─────────────────────────
// Ported from the oracle's cardinality engine (`semantic.ts`): `inferAstCardinality`
// + its lattice/schema/filter helpers, and the statement-level derivation
// (`compileToIR` select_expr / select paths). Statement-level only — the
// per-shape-element cardinality the SQL lowering reads is produced by the
// builder and is out of scope here. Additive (nothing reads `Statement.cardinality`).
type Bindings2 = Map<string, WithBindingValue>;

const dedupeByName = <T extends { name: string }>(items: readonly T[]): T[] => {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  return out;
};

export type MultLevel = "empty" | "unique" | "duplicate" | "unknown";

// Shared per-statement inference engine: builds the schema walkers + the
// cardinality expression engine once, and exposes statement-level cardinality
// and multiplicity derivations that reuse them. Both `inferStatementCardinality`
// and `inferStatementMultiplicity` are thin wrappers over this (see ADR 0017).
const makeInferenceEngine = (
  statement: Statement,
  schema: SchemaSnapshot,
  activeModule = "default",
) => {
  const bindingTypes = new Map<string, TypeDef>();
  const bindingCards = new Map<string, CardLevel>();
  const bindingTypeExprs = new Map<string, TypeExpr>();

  const collectFields = (typeDef: TypeDef, seen = new Set<string>()): TypeDef["fields"] => {
    const tn = qualifiedTypeName(typeDef);
    if (seen.has(tn)) return [];
    seen.add(tn);
    const inherited = (typeDef.extends ?? []).flatMap((b) => {
      const base = schema.getType(b);
      return base ? collectFields(base, seen) : [];
    });
    return dedupeByName([...typeDef.fields, ...inherited]);
  };
  const collectLinks = (typeDef: TypeDef, seen = new Set<string>()): NonNullable<TypeDef["links"]> => {
    const tn = qualifiedTypeName(typeDef);
    if (seen.has(tn)) return [];
    seen.add(tn);
    const inherited = (typeDef.extends ?? []).flatMap((b) => {
      const base = schema.getType(b);
      return base ? collectLinks(base, seen) : [];
    });
    return dedupeByName([...(typeDef.links ?? []), ...(inherited as NonNullable<TypeDef["links"]>)]);
  };

  const resolveObjectTypeOrAliasSource = (name: string, fallbackModule: string = activeModule): TypeDef | undefined => {
    const normalized = normalizeTypeName(name, fallbackModule);
    const alias = schema.getAlias(normalized);
    if (alias?.sourceType) {
      return schema.getType(normalizeTypeName(alias.sourceType, alias.module ?? fallbackModule));
    }
    return schema.getType(normalized);
  };

  const cardinalityForFieldDef = (f: { required?: boolean; multi?: boolean }): CardLevel =>
    f.multi ? (f.required ? "at_least_one" : "many") : (f.required ? "one" : "at_most_one");
  const cardinalityForLinkDef = cardinalityForFieldDef;

  const isAtMostOne = (c: CardLevel): boolean => c === "one" || c === "at_most_one" || c === "empty";
  const isAtLeastOne = (c: CardLevel): boolean => c === "one" || c === "at_least_one";
  const cartesianCard = (a: CardLevel, b: CardLevel): CardLevel => {
    if (a === "empty" || b === "empty") return "empty";
    if (a === "one" && b === "one") return "one";
    if (isAtMostOne(a) && isAtLeastOne(a) && isAtMostOne(b) && isAtLeastOne(b)) return "one";
    if (isAtMostOne(a) && isAtMostOne(b)) return "at_most_one";
    if (isAtLeastOne(a) && isAtLeastOne(b)) return "at_least_one";
    return "many";
  };
  const cartesianMany = (cards: CardLevel[]): CardLevel =>
    cards.reduce((acc, c) => cartesianCard(acc, c), "one" as CardLevel);
  const unionCard = (cards: CardLevel[]): CardLevel => {
    if (cards.length === 0) return "empty";
    if (cards.every((c) => c === "empty")) return "empty";
    if (cards.some((c) => c === "one" || c === "at_least_one")) return "at_least_one";
    return "many";
  };
  const cardUnionOfFields = (a: CardLevel, b: CardLevel): CardLevel => {
    if (a === "empty") return b;
    if (b === "empty") return a;
    const lower = isAtLeastOne(a) && isAtLeastOne(b);
    const upper = (a === "one" || a === "at_most_one") && (b === "one" || b === "at_most_one");
    if (lower && upper) return "one";
    if (upper) return "at_most_one";
    if (lower) return "at_least_one";
    return "many";
  };
  const cardIntersectOfFields = (a: CardLevel, b: CardLevel): CardLevel => {
    if (a === "empty" || b === "empty") return "empty";
    const lower = isAtLeastOne(a) || isAtLeastOne(b);
    const upper = (a === "one" || a === "at_most_one") || (b === "one" || b === "at_most_one");
    if (lower && upper) return "one";
    if (upper) return "at_most_one";
    if (lower) return "at_least_one";
    return "many";
  };

  const AGGREGATING = new Set(["array_agg", "count", "sum", "all", "any", "exists"]);
  const OPTIONAL_AGG = new Set(["min", "max", "avg", "mean", "assert_single"]);
  const stripModulePrefix = (name: string): string => name.split("::").pop() ?? name;
  const isAggregating = (name: string): boolean => AGGREGATING.has(stripModulePrefix(name));
  const isOptionalAggregate = (name: string): boolean => OPTIONAL_AGG.has(stripModulePrefix(name));

  const isExclusiveFieldOf = (fieldName: string, typeDef: TypeDef): boolean => {
    if (fieldName === "id") return true;
    const field = collectFields(typeDef).find((f) => f.name === fieldName);
    const constraint = field?.constraints?.find((c) => c.name === "std::exclusive" || c.name === "exclusive");
    if (!constraint) return false;
    if (constraint.delegated && typeDef.abstract) return false;
    return true;
  };

  const lookupCard = (typeDef: TypeDef, fieldName: string): CardLevel | undefined => {
    const f = collectFields(typeDef).find((x) => x.name === fieldName);
    if (f) return cardinalityForFieldDef(f);
    const l = collectLinks(typeDef).find((x) => x.name === fieldName);
    if (l) return cardinalityForLinkDef(l);
    return undefined;
  };
  const fieldCardOnTypeExpr = (typeExpr: TypeExpr, fieldName: string): CardLevel | undefined => {
    if (typeExpr.kind === "type_name") {
      const typeDef = schema.getType(normalizeTypeName(typeExpr.name, activeModule));
      if (!typeDef) return undefined;
      return lookupCard(typeDef, fieldName);
    }
    if (typeExpr.kind === "type_of") return undefined;
    const lc = fieldCardOnTypeExpr(typeExpr.left, fieldName);
    const rc = fieldCardOnTypeExpr(typeExpr.right, fieldName);
    if (lc === undefined || rc === undefined) return undefined;
    return typeExpr.kind === "type_union" ? cardUnionOfFields(lc, rc) : cardIntersectOfFields(lc, rc);
  };

  const findUnderlyingTypeExpr = (expr: FreeObjectExpr): TypeExpr | undefined => {
    if (expr.kind === "binding_ref") return bindingTypeExprs.get(expr.name);
    if (expr.kind === "function_call") {
      const s = stripModulePrefix(expr.call.name);
      if (s === "assert_exists" || s === "assert_single" || s === "assert_distinct") {
        const first = expr.call.args[0];
        if (first?.kind === "expr") return findUnderlyingTypeExpr(first.expr);
        if (first?.kind === "binding_ref") return findUnderlyingTypeExpr({ kind: "binding_ref", name: first.name } as FreeObjectExpr);
      }
    }
    if (expr.kind === "select_expr_subquery" || expr.kind === "cast" || expr.kind === "distinct") {
      return findUnderlyingTypeExpr(expr.expr);
    }
    return undefined;
  };

  const resolveExprObjectType = (expr: FreeObjectExpr): TypeDef | undefined => {
    if (expr.kind === "binding_ref") return bindingTypes.get(expr.name) ?? resolveObjectTypeOrAliasSource(expr.name);
    if (expr.kind === "select") return resolveObjectTypeOrAliasSource(expr.typeName);
    if (expr.kind === "shape_projection" || expr.kind === "cast" || expr.kind === "distinct" || expr.kind === "select_expr_subquery") {
      return resolveExprObjectType(expr.expr);
    }
    return undefined;
  };

  const isAssignableTo = (candidate: string, target: string): boolean => {
    if (candidate === target) return true;
    return schema.concreteTypeNamesUnder(target).includes(candidate);
  };

  // ---- filter-restricts-at-most-one (exclusive-constraint detection) ----
  const subjectAliasesFor = (typeDef: TypeDef): Set<string> => {
    const tn = qualifiedTypeName(typeDef);
    const short = tn.split("::").pop() ?? tn;
    const aliases = new Set<string>([tn, short]);
    for (const [name, t] of bindingTypes.entries()) {
      if (qualifiedTypeName(t) === tn) aliases.add(name);
    }
    return aliases;
  };
  const isSubjectFieldAccess = (expr: FreeObjectExpr, typeDef: TypeDef): { field: string } | undefined => {
    const aliases = subjectAliasesFor(typeDef);
    if (expr.kind === "field_access") {
      const base = expr.expr;
      if (base.kind === "current_item") return { field: expr.field };
      if (base.kind === "binding_ref" && aliases.has(base.name)) return { field: expr.field };
      if (base.kind === "select" && aliases.has(base.typeName)) return { field: expr.field };
    }
    if (expr.kind === "path" && aliases.has(expr.head)) return { field: expr.tail };
    return undefined;
  };
  const isSubjectReference = (expr: FreeObjectExpr, typeDef: TypeDef): boolean => {
    const aliases = subjectAliasesFor(typeDef);
    if (expr.kind === "current_item") return true;
    if (expr.kind === "binding_ref" && aliases.has(expr.name)) return true;
    if (expr.kind === "select" && aliases.has(expr.typeName)) return true;
    return false;
  };
  const isExclusiveSinglePathChain = (expr: FreeObjectExpr, typeDef: TypeDef): boolean => {
    const path: string[] = [];
    let cur: FreeObjectExpr = expr;
    while (true) {
      if (cur.kind === "field_access") { path.unshift(cur.field); cur = cur.expr; continue; }
      if (cur.kind === "current_item" || cur.kind === "binding_ref" || cur.kind === "select" || cur.kind === "shape_projection") break;
      return false;
    }
    if (cur.kind === "binding_ref" && !subjectAliasesFor(typeDef).has(cur.name)) return false;
    let stepType: TypeDef | undefined = typeDef;
    for (const step of path) {
      if (!stepType) return false;
      const link = collectLinks(stepType).find((l) => l.name === step);
      if (link) {
        if (link.multi) return false;
        const exclusive = (link.constraints ?? []).some((c) => c.name === "std::exclusive" || c.name === "exclusive");
        if (!exclusive) return false;
        stepType = resolveObjectTypeOrAliasSource(link.targetType);
        continue;
      }
      const field = collectFields(stepType).find((f) => f.name === step);
      if (!field) return false;
      if (field.multi) return false;
      if (step === "id") { stepType = undefined; continue; }
      if (!isExclusiveFieldOf(step, stepType)) return false;
      stepType = undefined;
    }
    return true;
  };
  const dottedPathIsExclusiveChain = (dotted: string, typeDef: TypeDef): boolean => {
    const steps = dotted.split(".");
    let stepType: TypeDef | undefined = typeDef;
    for (const step of steps) {
      if (!stepType) return false;
      const link = collectLinks(stepType).find((l) => l.name === step);
      if (link) {
        if (link.multi) return false;
        const exclusive = (link.constraints ?? []).some((c) => c.name === "std::exclusive" || c.name === "exclusive");
        if (!exclusive) return false;
        stepType = resolveObjectTypeOrAliasSource(link.targetType);
        continue;
      }
      const field = collectFields(stepType).find((f) => f.name === step);
      if (!field) return false;
      if (field.multi) return false;
      if (step === "id") { stepType = undefined; continue; }
      if (!isExclusiveFieldOf(step, stepType)) return false;
      stepType = undefined;
    }
    return true;
  };
  const freeExprRestrictsAtMostOne = (expr: FreeObjectExpr, typeDef: TypeDef): boolean => {
    if (expr.kind === "logical") {
      if (expr.op === "and") return freeExprRestrictsAtMostOne(expr.left, typeDef) || freeExprRestrictsAtMostOne(expr.right, typeDef);
      if (expr.op === "or") return freeExprRestrictsAtMostOne(expr.left, typeDef) && freeExprRestrictsAtMostOne(expr.right, typeDef);
    }
    if (expr.kind === "and") return freeExprRestrictsAtMostOne(expr.left, typeDef) || freeExprRestrictsAtMostOne(expr.right, typeDef);
    if (expr.kind === "or") return freeExprRestrictsAtMostOne(expr.left, typeDef) && freeExprRestrictsAtMostOne(expr.right, typeDef);
    if (expr.kind === "compare" && expr.op === "=") {
      const lf = isSubjectFieldAccess(expr.left, typeDef);
      const rf = isSubjectFieldAccess(expr.right, typeDef);
      const field = lf?.field ?? rf?.field;
      if (field && isExclusiveFieldOf(field, typeDef)) return true;
      if (isExclusiveSinglePathChain(expr.left, typeDef)) return true;
      if (isExclusiveSinglePathChain(expr.right, typeDef)) return true;
      if (isSubjectReference(expr.left, typeDef) && isAtMostOne(inferAstCardinality(expr.right))) return true;
      if (isSubjectReference(expr.right, typeDef) && isAtMostOne(inferAstCardinality(expr.left))) return true;
    }
    return false;
  };
  const filterRestrictsAtMostOneInner = (filter: FilterExpr | undefined, typeDef: TypeDef): boolean => {
    if (!filter) return false;
    switch (filter.kind) {
      case "predicate":
        if (filter.op !== "=") return false;
        if (filter.target.kind === "field") {
          if (filter.target.field.includes(".")) return dottedPathIsExclusiveChain(filter.target.field, typeDef);
          return isExclusiveFieldOf(filter.target.field, typeDef);
        }
        return false;
      case "and":
        return filterRestrictsAtMostOneInner(filter.left, typeDef) || filterRestrictsAtMostOneInner(filter.right, typeDef);
      case "or":
        return filterRestrictsAtMostOneInner(filter.left, typeDef) && filterRestrictsAtMostOneInner(filter.right, typeDef);
      case "not":
      case "in_predicate":
        return false;
      case "free_expr":
        return freeExprRestrictsAtMostOne(filter.expr, typeDef);
      default:
        return false;
    }
  };
  // Type-level compound exclusive constraints (`exclusive on (.first, .last)`):
  // an equality on every referenced field pins the row to at most one.
  const collectEqualityPinnedFields = (filter: FilterExpr | undefined, typeDef: TypeDef): Set<string> => {
    const pinned = new Set<string>();
    if (!filter) return pinned;
    const addFromFreeExpr = (expr: FreeObjectExpr): void => {
      if ((expr.kind === "logical" && expr.op === "and") || expr.kind === "and") {
        addFromFreeExpr(expr.left); addFromFreeExpr(expr.right); return;
      }
      if (expr.kind === "compare" && expr.op === "=") {
        const l = isSubjectFieldAccess(expr.left, typeDef);
        const r = isSubjectFieldAccess(expr.right, typeDef);
        if (l) pinned.add(l.field);
        if (r) pinned.add(r.field);
      }
    };
    const walk = (f: FilterExpr): void => {
      if (f.kind === "predicate" && f.op === "=" && f.target.kind === "field") pinned.add(f.target.field);
      else if (f.kind === "and") { walk(f.left); walk(f.right); }
      else if (f.kind === "free_expr") addFromFreeExpr(f.expr);
    };
    walk(filter);
    return pinned;
  };
  const typeConstraintSatisfied = (typeDef: TypeDef, pinned: Set<string>, rootAbstract: boolean, visited = new Set<string>()): boolean => {
    const tn = qualifiedTypeName(typeDef);
    if (visited.has(tn)) return false;
    visited.add(tn);
    for (const c of (typeDef as { typeConstraints?: Array<{ name: string; fieldRefs: string[]; delegated?: boolean }> }).typeConstraints ?? []) {
      if (c.name !== "std::exclusive" && c.name !== "exclusive") continue;
      if (c.fieldRefs.length === 0) continue;
      if (c.delegated && rootAbstract) continue;
      if (c.fieldRefs.every((f) => pinned.has(f))) return true;
    }
    for (const baseName of typeDef.extends ?? []) {
      const base = schema.getType(baseName);
      if (base && typeConstraintSatisfied(base, pinned, rootAbstract, visited)) return true;
    }
    return false;
  };
  const filterRestrictsAtMostOne = (filter: FilterExpr | undefined, typeDef: TypeDef): boolean => {
    if (!filter) return false;
    if (filterRestrictsAtMostOneInner(filter, typeDef)) return true;
    const pinned = collectEqualityPinnedFields(filter, typeDef);
    return pinned.size > 0 && typeConstraintSatisfied(typeDef, pinned, Boolean(typeDef.abstract));
  };

  // ---- the core expression cardinality engine ----
  const inferAstCardinality = (expr: FreeObjectExpr | undefined): CardLevel => {
    if (!expr) return "many";
    switch (expr.kind) {
      case "literal":
      case "parameter":
      case "substitution":
        return "one";
      case "global_ref": {
        const normalized = normalizeTypeName(expr.name, activeModule);
        const def = schema.getGlobal(normalized) ?? schema.getGlobal(`default::${expr.name}`) ?? schema.getGlobal(expr.name);
        if (def?.exprText) {
          const exprText = def.exprText;
          const parsed = tryResult(() => parseEdgeQL(`select ${exprText.replace(/;\s*$/, "")}`));
          if (parsed.ok) {
            const stmt = (Array.isArray(parsed.value) ? parsed.value[0] : parsed.value) as Statement;
            if (stmt.kind === "select_expr") return inferAstCardinality(stmt.expr);
            if (stmt.kind === "select") return inferAstCardinality({ kind: "select", typeName: stmt.typeName, shape: stmt.shape, clauses: { filter: stmt.filter } } as FreeObjectExpr);
          }
        }
        return "one";
      }
      case "current_item":
      case "enum_path":
        return "one";
      case "is_type":
      case "exists":
        return cartesianCard(inferAstCardinality(expr.expr), "one");
      case "binding_ref": {
        const bound = bindingCards.get(expr.name);
        if (bound !== undefined) return bound;
        return "many";
      }
      case "select": {
        if (expr.clauses?.limit === 0) return "empty";
        if (expr.clauses?.limit === 1) return "at_most_one";
        const typeDef = resolveObjectTypeOrAliasSource(expr.typeName);
        if (typeDef && expr.clauses?.filter && filterRestrictsAtMostOne(expr.clauses.filter, typeDef)) return "at_most_one";
        return "many";
      }
      case "select_expr_subquery": {
        if (expr.limit === 0) return "empty";
        let card = inferAstCardinality(expr.expr);
        if (expr.filter) {
          let restricted = false;
          const innerType = resolveExprObjectType(expr.expr);
          if (innerType && freeExprRestrictsAtMostOne(expr.filter, innerType)) {
            card = isAtLeastOne(card) ? "one" : "at_most_one";
            restricted = true;
          }
          if (!restricted) {
            if (card === "one") card = "at_most_one";
            else if (card === "at_least_one") card = "many";
          }
        }
        if (expr.limit === 1) card = isAtLeastOne(card) ? "one" : "at_most_one";
        const dyn = expr.limitExpr !== undefined || (expr.offset !== undefined && expr.offset > 0) || expr.offsetExpr !== undefined;
        if (dyn) { if (card === "one") card = "at_most_one"; else if (card === "at_least_one") card = "many"; }
        return card;
      }
      case "shape_projection":
        return inferAstCardinality(expr.expr);
      case "field_access": {
        const sourceCard = inferAstCardinality(expr.expr);
        if ((expr as { optional?: boolean }).optional) {
          if (sourceCard === "one") return "at_most_one";
          if (sourceCard === "at_least_one") return "many";
          return sourceCard;
        }
        if (!expr.field.startsWith("@")) {
          const ute = findUnderlyingTypeExpr(expr.expr);
          if (ute) {
            const fc = fieldCardOnTypeExpr(ute, expr.field);
            if (fc !== undefined) return cartesianCard(sourceCard, fc);
          }
        }
        const findShapeProjection = (e: FreeObjectExpr): { expr: FreeObjectExpr; shape: ShapeElement[] } | undefined => {
          if (e.kind === "shape_projection") return e as unknown as { expr: FreeObjectExpr; shape: ShapeElement[] };
          if (e.kind === "select_expr_subquery" || e.kind === "cast") return findShapeProjection(e.expr);
          return undefined;
        };
        const shaped = findShapeProjection(expr.expr);
        if (shaped) {
          const el = shaped.shape.find((s) => (s as { name?: string }).name === expr.field);
          if (el && (el as { expr?: { kind?: string; sourceType?: string } }).expr?.kind === "polymorphic_field_ref") {
            const polySrc = (el as { expr: { sourceType: string } }).expr.sourceType;
            const srcType = resolveExprObjectType(shaped.expr);
            const srcName = srcType ? qualifiedTypeName(srcType) : undefined;
            const total = srcName ? isAssignableTo(srcName, normalizeTypeName(polySrc, activeModule)) : false;
            if (!total) {
              if (sourceCard === "one") return "at_most_one";
              if (sourceCard === "at_least_one") return "many";
              return sourceCard;
            }
          }
        }
        return sourceCard;
      }
      case "set_literal":
        return expr.values.length === 0 ? "empty" : "at_least_one";
      case "set_expr":
        return unionCard(expr.values.map(inferAstCardinality));
      case "set_op": {
        const a = inferAstCardinality(expr.left);
        const b = inferAstCardinality(expr.right);
        if (a === "empty" || b === "empty") return "empty";
        if (expr.op === "intersect") return (isAtMostOne(a) || isAtMostOne(b)) ? "at_most_one" : "many";
        return isAtMostOne(a) ? "at_most_one" : "many";
      }
      case "array_literal_expr":
        return cartesianMany(expr.values.map(inferAstCardinality));
      case "free_object_constructor":
        return expr.tupleLike ? cartesianMany(expr.entries.map((e) => inferAstCardinality(e.expr))) : "one";
      case "tuple":
        return cartesianMany(expr.values.map(inferAstCardinality));
      case "cast":
      case "distinct":
      case "not":
      case "unary":
      case "index_access":
      case "slice_access":
        return inferAstCardinality(expr.expr);
      case "in_expr":
        return inferAstCardinality(expr.left);
      case "math":
      case "logical":
      case "and":
      case "or":
        return cartesianCard(inferAstCardinality(expr.left), inferAstCardinality(expr.right));
      case "compare": {
        const a = inferAstCardinality(expr.left);
        const b = inferAstCardinality(expr.right);
        if ((expr.op === "?=" || expr.op === "?!=") && isAtMostOne(a) && isAtMostOne(b)) return "one";
        return cartesianCard(a, b);
      }
      case "coalesce": {
        const a = inferAstCardinality(expr.left);
        const b = inferAstCardinality(expr.right);
        if (isAtLeastOne(a)) return a;
        const upper = isAtMostOne(a) && isAtMostOne(b);
        const lower = isAtLeastOne(b);
        if (upper && lower) return "one";
        if (upper) return "at_most_one";
        if (lower) return "at_least_one";
        return "many";
      }
      case "if_else": {
        const t = inferAstCardinality(expr.thenExpr);
        const e = inferAstCardinality(expr.elseExpr);
        const lower = isAtLeastOne(t) && isAtLeastOne(e);
        const upper = isAtMostOne(t) && isAtMostOne(e);
        let branch: CardLevel;
        if (upper && lower) branch = "one";
        else if (upper) branch = "at_most_one";
        else if (lower) branch = "at_least_one";
        else branch = "many";
        return cartesianCard(inferAstCardinality(expr.condition), branch);
      }
      case "concat":
        return cartesianMany(expr.parts.map(inferAstCardinality));
      case "function_call": {
        const callName = expr.call.name;
        const stripped = stripModulePrefix(callName);
        const inferArgCard = (a: unknown): CardLevel => {
          const k = (a as { kind?: string }).kind;
          if (k === "named_arg") return inferArgCard((a as { arg: unknown }).arg);
          if (k === "expr") return inferAstCardinality((a as { expr: FreeObjectExpr }).expr);
          if (k === "binding_ref") return inferAstCardinality({ kind: "binding_ref", name: (a as { name: string }).name } as FreeObjectExpr);
          if (k === "literal" || k === "parameter") return "one";
          if (k === "set_literal") return ((a as { values: unknown[] }).values.length === 0) ? "empty" : "at_least_one";
          if (k === "array_literal") return "one";
          if (k === "function_call") return inferAstCardinality({ kind: "function_call", call: (a as { call: FunctionCallExpr }).call } as FreeObjectExpr);
          return "many";
        };
        const argCards = expr.call.args.map(inferArgCard);
        if (isAggregating(callName)) return "one";
        if (stripped === "assert_exists") {
          const primary = argCards[0] ?? "many";
          const rest = argCards.slice(1);
          const card: CardLevel = isAtMostOne(primary) ? "one" : "at_least_one";
          if (rest.some((c) => c !== "one" && c !== "at_most_one" && c !== "empty")) return "at_least_one";
          return rest.reduce((acc, c) => cartesianCard(acc, c), card);
        }
        if (stripped === "assert_distinct") {
          const primary = argCards[0] ?? "many";
          return argCards.slice(1).reduce((acc, c) => cartesianCard(acc, c), primary);
        }
        if (stripped === "assert") {
          const primary = argCards[0] ?? "many";
          const msg = argCards[1];
          const pLower = isAtLeastOne(primary);
          const pUpper = isAtMostOne(primary);
          const msgMulti = msg !== undefined && msg !== "one" && msg !== "at_most_one" && msg !== "empty";
          if (msgMulti) return pLower ? "at_least_one" : "many";
          if (pUpper && pLower) return "one";
          if (pUpper) return "at_most_one";
          if (pLower) return "at_least_one";
          return "many";
        }
        if (isOptionalAggregate(callName)) {
          const primary = argCards[0] ?? "many";
          return isAtLeastOne(primary) ? "one" : "at_most_one";
        }
        const fn = schema.findFunction("default", stripped, expr.call.args.length) ?? schema.findFunction("std", stripped, expr.call.args.length);
        if (fn) {
          const eff = fn.params.map((p, i) => {
            const c = argCards[i] ?? "many";
            if (p.setOf) return "one" as CardLevel;
            if (p.optional) { if (c === "empty" || c === "at_most_one") return "one" as CardLevel; return c; }
            return c;
          });
          const cart = eff.reduce((acc, c) => cartesianCard(acc, c), "one" as CardLevel);
          return cartesianCard(cart, fn.returnOptional ? "at_most_one" : "one");
        }
        const stdlib = tryResolveStdlibFunction(callName, expr.call.args.length, "default");
        if (stdlib) {
          const eff = argCards.map((c, i) => stdlib.paramSetOf?.[i] ? "one" as CardLevel : c);
          const cart = eff.reduce((acc, c) => cartesianCard(acc, c), "one" as CardLevel);
          return cartesianCard(cart, stdlib.returnOptional ? "at_most_one" : "one");
        }
        return cartesianMany(argCards);
      }
      case "for_expr":
        return cartesianCard(inferAstCardinality(expr.iterator), inferAstCardinality(expr.body));
      case "path_steps": {
        const steps = expr.steps ?? [];
        if (steps.length === 0) return "many";
        return (steps[steps.length - 1] as { kind: string }).kind === "type_intersection" ? "at_most_one" : "many";
      }
      case "backlink_path": {
        if (!expr.sourceType) return "many";
        const srcType = resolveObjectTypeOrAliasSource(expr.sourceType);
        if (!srcType) return "many";
        const fwd = collectLinks(srcType).find((l) => l.name === expr.link);
        if (!fwd) return "many";
        const excl = (fwd.constraints ?? []).find((c) => c.name === "std::exclusive" || c.name === "exclusive");
        if (!excl) return "many";
        if (excl.delegated && srcType.abstract) return "many";
        return "at_most_one";
      }
      case "mutation_expr":
        return expr.statement.kind === "insert" ? "one" : "many";
      default:
        return "many";
    }
  };

  // ---- statement-level derivation (mirrors compileToIR) ----
  const populateBindings = (withClause: Array<{ name: string; value: WithBindingValue }> | undefined): void => {
    for (const binding of withClause ?? []) {
      const value = binding.value;
      let card: CardLevel | undefined;
      let resolved: TypeDef | undefined;
      if (value.kind === "subquery") {
        resolved = resolveObjectTypeOrAliasSource(value.query.typeName);
        card = "many";
        if (value.query.clauses?.limit === 0) card = "empty";
        else if (value.query.clauses?.limit === 1) card = "at_most_one";
      } else if (value.kind === "subquery_expr") {
        resolved = resolveExprObjectType(value.expr);
        if (value.expr.kind === "set_literal") card = value.expr.values.length === 0 ? "empty" : "at_least_one";
        else if (value.expr.kind === "array_literal_expr") card = "one";
        else card = inferAstCardinality(value.expr);
        if (value.expr.kind === "path_steps") {
          const steps = (value.expr as { steps?: Array<{ kind: string; typeExpr?: TypeExpr }> }).steps ?? [];
          const last = steps[steps.length - 1];
          if (last?.kind === "type_intersection" && last.typeExpr) bindingTypeExprs.set(binding.name, last.typeExpr);
        }
      } else if (value.kind === "subquery_statement") {
        const inner = value.statement;
        if (inner.kind === "select") { resolved = resolveObjectTypeOrAliasSource(inner.typeName); card = "many"; }
        else if (inner.kind === "select_expr") { resolved = resolveExprObjectType(inner.expr); card = inferAstCardinality(inner.expr); }
      } else if (value.kind === "literal" || value.kind === "array_literal" || value.kind === "parameter") {
        card = "one";
      } else if (value.kind === "set_literal") {
        card = value.values.length === 0 ? "empty" : "at_least_one";
      } else if (value.kind === "binding_ref") {
        resolved = resolveObjectTypeOrAliasSource(value.name) ?? bindingTypes.get(value.name);
        card = bindingCards.get(value.name);
      }
      if (resolved) bindingTypes.set(binding.name, resolved);
      if (card !== undefined) bindingCards.set(binding.name, card);
    }
  };

  const statementCardinality = (): CardLevel => {
    if (statement.kind === "insert") {
      const ins = statement as { typeName: string; conflict?: { else?: { typeName?: string } } };
      const conflict = ins.conflict;
      if (!conflict) return "one";
      if (!conflict.else) return "at_most_one"; // UNLESS CONFLICT may insert nothing
      const elseType = conflict.else.typeName;
      if (elseType && normalizeTypeName(elseType, activeModule) === normalizeTypeName(ins.typeName, activeModule)) return "one";
      return "many";
    }
    if (statement.kind === "update" || statement.kind === "delete") {
      populateBindings((statement as { with?: Array<{ name: string; value: WithBindingValue }> }).with);
      const s = statement as { typeName: string; filter?: FilterExpr };
      const typeDef = bindingTypes.get(s.typeName) ?? resolveObjectTypeOrAliasSource(s.typeName);
      if (typeDef && filterRestrictsAtMostOne(s.filter, typeDef)) return "at_most_one";
      return "many";
    }
    if (statement.kind === "for") {
      populateBindings((statement as { with?: Array<{ name: string; value: WithBindingValue }> }).with);
      const s = statement as { iteratorExpr: FreeObjectExpr; body: Statement };
      const iterCard = inferAstCardinality(s.iteratorExpr);
      const bodyCard = inferStatementCardinality(s.body, schema, activeModule);
      return cartesianCard(iterCard, bodyCard);
    }
    if (statement.kind === "select_expr") {
      populateBindings((statement as { with?: Array<{ name: string; value: WithBindingValue }> }).with);
      const raw = inferAstCardinality(statement.expr);
      return raw === "empty" ? "at_most_one" : raw;
    }
    if (statement.kind === "select") {
      populateBindings((statement as { with?: Array<{ name: string; value: WithBindingValue }> }).with);
      const limit = (statement as { limit?: number }).limit;
      let card: CardLevel = limit === 0 ? "empty" : limit === 1 ? "at_most_one" : "many";
      const typeDef = resolveObjectTypeOrAliasSource((statement as { typeName: string }).typeName);
      if (card === "many" && typeDef && filterRestrictsAtMostOne((statement as { filter?: FilterExpr }).filter, typeDef)) {
        card = "at_most_one";
      }
      return card;
    }
    if (statement.kind === "select_free") return "one";
    return "many";
  };

  // ---- multiplicity engine (mirrors the oracle's inferAstMultiplicity) ----
  const bindingMults = new Map<string, MultLevel>();
  const shapeContextStack: ShapeElement[][] = [];
  const withBindingValues = new Map<string, WithBindingValue>(
    (statement as { with?: Array<{ name: string; value: WithBindingValue }> }).with?.map((b) => [b.name, b.value] as const) ?? [],
  );

  // Look up `field` in the shape a binding/projection projects, returning the
  // multiplicity of the matching computed element's body (mirrors the oracle's
  // findInShape). Lets `binding.computed` resolve through the binding's own
  // shape rather than the underlying schema type.
  const computedBodyToExpr = (ce: unknown): FreeObjectExpr | undefined => {
    if (!ce || typeof ce !== "object") return undefined;
    const node = ce as { kind?: string; expr?: unknown };
    if (node.kind === "select_expr" && node.expr) return node.expr as FreeObjectExpr;
    if (node.kind === "field_ref") return undefined;
    return ce as FreeObjectExpr;
  };
  const findShapeFieldMult = (shape: ShapeElement[], field: string): MultLevel | undefined => {
    for (const el of shape) {
      if ("name" in el && el.name === field && el.kind === "computed") {
        const inner = computedBodyToExpr((el as { expr: unknown }).expr);
        if (!inner) return undefined;
        shapeContextStack.push(shape);
        try { return inferAstMultiplicity(inner); } finally { shapeContextStack.pop(); }
      }
    }
    return undefined;
  };
  const findInExprShape = (e: FreeObjectExpr, field: string): MultLevel | undefined => {
    if (e.kind === "shape_projection") {
      const own = findShapeFieldMult(e.shape, field);
      if (own !== undefined) return own;
      return findInExprShape(e.expr, field);
    }
    if (e.kind === "select_expr_subquery" || e.kind === "distinct" || e.kind === "cast") return findInExprShape(e.expr, field);
    if (e.kind === "binding_ref") {
      const v = withBindingValues.get(e.name);
      if (v?.kind === "subquery") return findShapeFieldMult(v.query.shape, field);
      if (v?.kind === "subquery_expr") return findInExprShape(v.expr, field);
    }
    return undefined;
  };

  const objectTypesOverlap = (a: TypeDef, b: TypeDef): boolean => {
    const aName = qualifiedTypeName(a);
    const bName = qualifiedTypeName(b);
    if (aName === bName) return true;
    const aConc = new Set(schema.concreteTypeNamesUnder(aName));
    return schema.concreteTypeNamesUnder(bName).some((n) => aConc.has(n));
  };

  const fieldMultiplicityOnType = (typeDef: TypeDef, fieldName: string): MultLevel => {
    if (fieldName === "id") return "unique";
    if (collectLinks(typeDef).some((l) => l.name === fieldName)) return "unique"; // object link → UNIQUE
    const computed = (typeDef.computeds ?? []).find((c) => c.name === fieldName);
    if (computed) return computed.kind === "link" ? "unique" : "duplicate";
    const field = collectFields(typeDef).find((f) => f.name === fieldName);
    if (!field) return "unknown";
    return isExclusiveFieldOf(fieldName, typeDef) ? "unique" : "duplicate";
  };

  const callArgAsExpr = (a: unknown): FreeObjectExpr | undefined => {
    const k = (a as { kind?: string }).kind;
    if (k === "named_arg") return callArgAsExpr((a as { arg: unknown }).arg);
    if (k === "expr") return (a as { expr: FreeObjectExpr }).expr;
    if (k === "binding_ref") return { kind: "binding_ref", name: (a as { name: string }).name } as FreeObjectExpr;
    if (k === "literal") return { kind: "literal", value: (a as { value: unknown }).value } as FreeObjectExpr;
    if (k === "parameter") return { kind: "parameter", name: (a as { name: string }).name } as FreeObjectExpr;
    if (k === "set_literal") return { kind: "set_literal", values: (a as { values: unknown[] }).values } as FreeObjectExpr;
    if (k === "array_literal") return { kind: "array_literal_expr", values: [] } as FreeObjectExpr;
    if (k === "function_call") return { kind: "function_call", call: (a as { call: FunctionCallExpr }).call } as FreeObjectExpr;
    return undefined;
  };

  const inferUnionMultiplicity = (values: FreeObjectExpr[]): MultLevel => {
    if (values.length === 0) return "empty";
    const mults = values.map(inferAstMultiplicity);
    const nonEmpty = mults.filter((m) => m !== "empty");
    if (nonEmpty.length === 0) return "empty";
    if (nonEmpty.some((m) => m === "duplicate")) return "duplicate";
    if (nonEmpty.length === 1) return nonEmpty[0];
    if (values.every((v) => v.kind === "mutation_expr" && (v as { statement: { kind: string } }).statement.kind === "insert")) return "unique";
    const types = values.map((v) => resolveExprObjectType(v));
    let anyType = false;
    let overlap = false;
    for (let i = 0; i < types.length && !overlap; i++) {
      const ti = types[i];
      if (!ti) continue;
      anyType = true;
      for (let j = i + 1; j < types.length; j++) {
        const tj = types[j];
        if (tj && objectTypesOverlap(ti, tj)) { overlap = true; break; }
      }
    }
    if (anyType && !overlap) return "unique";
    return "duplicate";
  };

  function inferAstMultiplicity(expr: FreeObjectExpr | undefined): MultLevel {
    if (!expr) return "unknown";
    switch (expr.kind) {
      case "literal":
      case "parameter":
      case "substitution":
      case "global_ref":
      case "current_item":
      case "enum_path":
      case "introspect_typeof":
        return "unique";
      case "select": {
        return resolveObjectTypeOrAliasSource(expr.typeName) ? "unique" : "duplicate";
      }
      case "binding_ref": {
        const bound = bindingMults.get(expr.name);
        if (bound !== undefined) return bound;
        return resolveObjectTypeOrAliasSource(expr.name) ? "unique" : "unknown";
      }
      case "shape_projection":
      case "cast":
        return inferAstMultiplicity(expr.expr);
      case "distinct": {
        const inner = inferAstMultiplicity(expr.expr);
        return inner === "empty" ? "empty" : "unique";
      }
      case "set_literal": {
        if (expr.values.length === 0) return "empty";
        const seen = new Set<string>();
        for (const v of expr.values) {
          const key = JSON.stringify(v);
          if (seen.has(key)) return "duplicate";
          seen.add(key);
        }
        return "unique";
      }
      case "set_expr":
        return inferUnionMultiplicity(expr.values);
      case "set_op": {
        const a = inferAstMultiplicity(expr.left);
        const b = inferAstMultiplicity(expr.right);
        if (a === "empty" || b === "empty") return "empty";
        if (expr.op === "intersect") return (a === "unique" || b === "unique") ? "unique" : "duplicate";
        return a;
      }
      case "tuple": {
        const mults = expr.values.map(inferAstMultiplicity);
        if (mults.some((m) => m === "empty")) return "empty";
        const cards = expr.values.map(inferAstCardinality);
        const numMany = cards.filter((c) => !isAtMostOne(c)).length;
        if (numMany === 0) return mults.every((m) => m === "unique") ? "unique" : "duplicate";
        if (numMany > 1) return "duplicate";
        for (let i = 0; i < cards.length; i++) if (!isAtMostOne(cards[i])) return mults[i];
        return "duplicate";
      }
      case "free_object_constructor":
        return "unique";
      case "array_literal_expr": {
        const mults = expr.values.map(inferAstMultiplicity);
        if (mults.some((m) => m === "empty")) return "empty";
        const cards = expr.values.map(inferAstCardinality);
        const numMany = cards.filter((c) => !isAtMostOne(c)).length;
        return (numMany <= 1 && mults.every((m) => m === "unique")) ? "unique" : "duplicate";
      }
      case "field_access": {
        if (expr.expr.kind === "introspect_typeof") return "unique";
        // Shape-element body resolution via the surrounding shape context.
        if (expr.expr.kind === "current_item" && shapeContextStack.length > 0) {
          const ctx = shapeContextStack[shapeContextStack.length - 1];
          for (const el of ctx) {
            if ("name" in el && el.name === expr.field && el.kind === "computed") {
              const body = (el as { expr?: { kind?: string; expr?: FreeObjectExpr } }).expr;
              const inner = body?.kind === "select_expr" ? body.expr : (body as FreeObjectExpr | undefined);
              if (inner) {
                shapeContextStack.push(ctx);
                try { return inferAstMultiplicity(inner); } finally { shapeContextStack.pop(); }
              }
            }
          }
        }
        const shapeMult = findInExprShape(expr.expr, expr.field);
        if (shapeMult !== undefined) return shapeMult;
        const srcType = resolveExprObjectType(expr.expr);
        if (!srcType) return "duplicate";
        return fieldMultiplicityOnType(srcType, expr.field);
      }
      case "is_type":
      case "exists":
        return "duplicate";
      case "math": {
        const lm = inferAstMultiplicity(expr.left);
        const rm = inferAstMultiplicity(expr.right);
        if (lm === "empty" || rm === "empty") return "empty";
        if (expr.op === "+") {
          if (lm === "duplicate" || rm === "duplicate") return "duplicate";
          const numMany = (isAtMostOne(inferAstCardinality(expr.left)) ? 0 : 1) + (isAtMostOne(inferAstCardinality(expr.right)) ? 0 : 1);
          return numMany > 1 ? "duplicate" : "unique";
        }
        return "duplicate";
      }
      case "compare":
      case "in_expr":
      case "logical":
      case "and":
      case "or":
        return "duplicate";
      case "not":
      case "unary":
        return inferAstMultiplicity(expr.expr);
      case "if_else": {
        if (!isAtMostOne(inferAstCardinality(expr.condition))) return "duplicate";
        const t = inferAstMultiplicity(expr.thenExpr);
        const e = inferAstMultiplicity(expr.elseExpr);
        if (t === "empty") return e;
        if (e === "empty") return t;
        return (t === "unique" && e === "unique") ? "unique" : "duplicate";
      }
      case "coalesce": {
        const a = inferAstMultiplicity(expr.left);
        const b = inferAstMultiplicity(expr.right);
        if (a === "empty") return b;
        if (b === "empty") return a;
        return (a === "unique" && b === "unique") ? "unique" : "duplicate";
      }
      case "concat": {
        const partMults = expr.parts.map(inferAstMultiplicity);
        if (partMults.some((m) => m === "empty")) return "empty";
        if (partMults.some((m) => m === "duplicate")) return "duplicate";
        const numMany = expr.parts.map(inferAstCardinality).filter((c) => !isAtMostOne(c)).length;
        if (numMany > 1) return "duplicate";
        return partMults.every((m) => m === "unique") ? "unique" : "duplicate";
      }
      case "function_call": {
        const callName = expr.call.name;
        const stripped = stripModulePrefix(callName);
        const argExprs = expr.call.args.map(callArgAsExpr);
        const argMults = argExprs.map((a) => a ? inferAstMultiplicity(a) : "duplicate");
        const argCards = argExprs.map((a) => a ? inferAstCardinality(a) : "many");
        if (isAggregating(callName) || isOptionalAggregate(callName)) return "unique";
        if (stripped === "assert_distinct" || stripped === "enumerate") return "unique";
        if (stripped === "assert_exists" || stripped === "assert_single") return argMults[0] ?? "unknown";
        const fn = schema.findFunction("default", stripped, expr.call.args.length) ?? schema.findFunction("std", stripped, expr.call.args.length);
        if (fn) {
          const eMults = fn.params.map((p, i) => p.setOf ? "unique" : (argMults[i] ?? "unknown"));
          const eCards = fn.params.map((p, i) => p.setOf ? "one" as CardLevel : (argCards[i] ?? "many"));
          if (eMults.some((m) => m === "empty")) return "empty";
          if (eMults.some((m) => m === "duplicate" || m === "unknown")) return "duplicate";
          return eCards.filter((c) => !isAtMostOne(c)).length > 1 ? "duplicate" : "unique";
        }
        return "duplicate";
      }
      case "index_access": {
        if (expr.expr.kind === "tuple") {
          const els = expr.expr.values;
          const idx = expr.index;
          if (idx < 0 || idx >= els.length) return "unknown";
          const elCards = els.map(inferAstCardinality);
          const numMany = elCards.filter((c) => !isAtMostOne(c)).length;
          if (numMany > 1) return "duplicate";
          if (numMany === 1 && isAtMostOne(elCards[idx])) return "duplicate";
          return inferAstMultiplicity(els[idx]);
        }
        if (isAtMostOne(inferAstCardinality(expr.expr))) return inferAstMultiplicity(expr.expr);
        return "duplicate";
      }
      case "slice_access":
        return "duplicate";
      case "select_expr_subquery":
        if (expr.limit === 0) return "empty";
        return inferAstMultiplicity(expr.expr);
      case "for_expr": {
        const iterMult = inferAstMultiplicity(expr.iterator);
        const bodyMult = inferAstMultiplicity(expr.body);
        if (iterMult === "empty" || bodyMult === "empty") return "empty";
        if (iterMult === "duplicate") return "duplicate";
        if (expr.body.kind === "free_object_constructor") return "unique";
        return bodyMult === "unique" ? "unique" : "duplicate";
      }
      case "path":
        return inferAstMultiplicity({
          kind: "field_access",
          expr: { kind: "binding_ref", name: (expr as { head: string }).head } as FreeObjectExpr,
          field: (expr as { tail: string }).tail,
        } as FreeObjectExpr);
      case "backlink_path":
      case "mutation_expr":
      case "group_expr":
        return "unique";
      default:
        return "unknown";
    }
  }

  const inferTopLevelMultiplicity = (expr: FreeObjectExpr | undefined, card: CardLevel): MultLevel => {
    const m = inferAstMultiplicity(expr);
    if ((m === "duplicate" || m === "unknown") && isAtMostOne(card)) return "unique";
    return m;
  };

  const populateBindingMults = (withClause: Array<{ name: string; value: WithBindingValue }> | undefined): void => {
    for (const binding of withClause ?? []) {
      const value = binding.value;
      if (value.kind === "subquery_expr") bindingMults.set(binding.name, inferAstMultiplicity(value.expr));
      else if (value.kind === "subquery") bindingMults.set(binding.name, "unique");
      else if (value.kind === "set_literal") bindingMults.set(binding.name, value.values.length === 0 ? "empty" : (new Set(value.values.map((v) => JSON.stringify(v))).size === value.values.length ? "unique" : "duplicate"));
      else if (value.kind === "literal" || value.kind === "parameter" || value.kind === "array_literal") bindingMults.set(binding.name, "unique");
      else if (value.kind === "binding_ref") { const m = bindingMults.get(value.name); if (m !== undefined) bindingMults.set(binding.name, m); }
    }
  };

  const statementMultiplicity = (): MultLevel => {
    if (statement.kind === "insert" || statement.kind === "update" || statement.kind === "delete") return "unique";
    if (statement.kind === "select" || statement.kind === "select_free") return "unique";
    const withClause = (statement as { with?: Array<{ name: string; value: WithBindingValue }> }).with;
    populateBindings(withClause);
    populateBindingMults(withClause);
    if (statement.kind === "select_expr") {
      return inferTopLevelMultiplicity(statement.expr, inferAstCardinality(statement.expr));
    }
    if (statement.kind === "for") {
      // Mirrors the oracle's `_infer_for_multiplicity` (DISTINCT_UNION
      // detection): a UNIQUE body that is provably disjoint across iterations
      // (references the iter var, filters by it, or has fresh identity) keeps
      // the union UNIQUE; otherwise the iterator's duplicates leak through.
      const variable = (statement as { variable: string }).variable;
      const iteratorExpr = (statement as { iteratorExpr: FreeObjectExpr }).iteratorExpr;
      const body = (statement as { body: Statement }).body;

      const iterCard = inferAstCardinality(iteratorExpr);
      let bodyCard: CardLevel = "many";
      if (body.kind === "select_expr") bodyCard = inferAstCardinality((body as { expr: FreeObjectExpr }).expr);
      else if (body.kind === "select_free") bodyCard = "one";
      else if (body.kind === "insert") bodyCard = "one";
      const combinedRaw = cartesianCard(iterCard, bodyCard);

      bindingMults.set(variable, "unique");
      bindingCards.set(variable, "one");
      const forIterMult = inferAstMultiplicity(iteratorExpr);
      const forBodyExpr: FreeObjectExpr | undefined =
        body.kind === "select_expr" ? (body as { expr: FreeObjectExpr }).expr :
        body.kind === "select" ? { kind: "select", typeName: (body as { typeName: string }).typeName, shape: (body as { shape: ShapeElement[] }).shape, clauses: {} } as FreeObjectExpr :
        undefined;

      const isIterDerivedRef = (e: FreeObjectExpr): boolean => {
        if (e.kind === "binding_ref" && e.name === variable) return true;
        if (e.kind === "index_access" || e.kind === "field_access") return isIterDerivedRef(e.expr);
        return false;
      };
      const isDirectIterFilter = (filter: FilterExpr | undefined): boolean => {
        if (!filter) return false;
        if (filter.kind === "predicate" && filter.op === "=" && filter.target.kind === "field") {
          const v = (filter as { value?: unknown }).value;
          if (typeof v === "object" && v !== null && (v as { kind?: string }).kind === "binding_ref" && (v as { name?: string }).name === variable) return true;
        }
        if (filter.kind === "and") return isDirectIterFilter(filter.left) || isDirectIterFilter(filter.right);
        if (filter.kind === "free_expr") {
          const e = filter.expr;
          if (e.kind === "compare" && e.op === "=") {
            const sides = [e.left, e.right];
            const fieldSide = sides.find((s) => s.kind === "field_access" && (s.expr.kind === "current_item" || s.expr.kind === "binding_ref"));
            const varSide = sides.find(isIterDerivedRef);
            if (fieldSide && varSide) return true;
          }
        }
        return false;
      };
      const bodyFilter: FilterExpr | undefined =
        body.kind === "select" ? (body as { filter?: FilterExpr }).filter :
        body.kind === "select_expr" && ((body as { expr: { filter?: unknown } }).expr).filter ? (((body as { expr: { filter: FreeObjectExpr } }).expr).filter as unknown as FilterExpr) :
        undefined;
      const unwrapBodyExpr = (e: FreeObjectExpr | undefined): FreeObjectExpr | undefined => {
        if (!e) return undefined;
        if (e.kind === "shape_projection" || e.kind === "cast" || e.kind === "distinct") return unwrapBodyExpr(e.expr);
        if (e.kind === "select_expr_subquery" && !e.filter && !e.orderBy && e.limit === undefined && e.offset === undefined) return unwrapBodyExpr(e.expr);
        return e;
      };
      const withList = (statement as { with?: Array<{ name: string; value: WithBindingValue }> }).with ?? [];
      const resolveBindingToExpr = (name: string, depth = 0): FreeObjectExpr | undefined => {
        if (depth > 8) return undefined;
        for (const b of withList) {
          if (b.name === name) {
            if (b.value.kind === "subquery_expr") return b.value.expr;
            if (b.value.kind === "binding_ref") return resolveBindingToExpr(b.value.name, depth + 1);
          }
        }
        return undefined;
      };
      const seededInner: string[] = [];
      const seedInnerBindings = (e: FreeObjectExpr | undefined): void => {
        if (!e) return;
        if (e.kind === "select_expr_subquery") {
          const withs = (e.clauses as { _withBindings?: Array<{ name: string; value: { kind: string; expr?: FreeObjectExpr } }> } | undefined)?._withBindings;
          for (const b of withs ?? []) {
            if (b.value.kind === "subquery_expr" && b.value.expr) { bindingMults.set(b.name, inferAstMultiplicity(b.value.expr)); seededInner.push(b.name); }
          }
          seedInnerBindings(e.expr);
        }
      };
      seedInnerBindings(forBodyExpr);
      const innerBindingMap = new Map<string, FreeObjectExpr>();
      const collectInner = (e: FreeObjectExpr | undefined): void => {
        if (!e) return;
        if (e.kind === "select_expr_subquery") {
          const withs = (e.clauses as { _withBindings?: Array<{ name: string; value: { kind: string; expr?: FreeObjectExpr } }> } | undefined)?._withBindings;
          for (const b of withs ?? []) if (b.value.kind === "subquery_expr" && b.value.expr) innerBindingMap.set(b.name, b.value.expr);
          collectInner(e.expr);
        }
      };
      collectInner(forBodyExpr);
      const resolvesToIterVar = (name: string): boolean => {
        const seen = new Set<string>();
        let cur: string | undefined = name;
        while (cur !== undefined && !seen.has(cur)) {
          if (cur === variable) return true;
          seen.add(cur);
          const next = innerBindingMap.get(cur);
          cur = next && next.kind === "binding_ref" ? next.name : undefined;
        }
        return false;
      };
      const findNestedIterFilter = (e: FreeObjectExpr | undefined, depth = 0): boolean => {
        if (!e || depth > 6) return false;
        const fc = (e as { filter?: unknown }).filter;
        if (fc && isDirectIterFilter(fc as unknown as FilterExpr)) return true;
        if (e.kind === "select" && e.clauses?.filter && isDirectIterFilter(e.clauses.filter)) return true;
        if (e.kind === "select_expr_subquery" || e.kind === "shape_projection" || e.kind === "distinct" || e.kind === "cast") return findNestedIterFilter(e.expr, depth + 1);
        if (e.kind === "set_expr") return e.values.some((v) => findNestedIterFilter(v, depth + 1));
        return false;
      };

      const forBodyMult = forBodyExpr ? inferAstMultiplicity(forBodyExpr) : "unique";
      const bodyInner = unwrapBodyExpr(forBodyExpr);
      const bodyResolvedFreeObj = bodyInner?.kind === "binding_ref"
        ? unwrapBodyExpr(resolveBindingToExpr(bodyInner.name))?.kind === "free_object_constructor"
        : false;

      let forCombinedMult: MultLevel = "duplicate";
      if (forIterMult === "empty" || forBodyMult === "empty") forCombinedMult = "empty";
      else if (body.kind === "insert") forCombinedMult = "unique";
      else if (forIterMult !== "duplicate" && forBodyMult === "unique") {
        const bodyRefsIter =
          (bodyInner?.kind === "binding_ref" && resolvesToIterVar(bodyInner.name))
          || (bodyInner !== undefined && isIterDerivedRef(bodyInner));
        const bodyIsFreeObj = bodyInner?.kind === "free_object_constructor";
        const bodyIsInsert = bodyInner?.kind === "mutation_expr" && (bodyInner as { statement: { kind: string } }).statement.kind === "insert";
        if (bodyRefsIter || bodyIsFreeObj || bodyIsInsert || isDirectIterFilter(bodyFilter) || findNestedIterFilter(forBodyExpr)) {
          forCombinedMult = "unique";
        }
      }
      if (bodyInner?.kind === "free_object_constructor" || bodyResolvedFreeObj) forCombinedMult = "unique";
      if (forCombinedMult === "duplicate" && isAtMostOne(combinedRaw)) forCombinedMult = "unique";
      return forCombinedMult;
    }
    return "unknown";
  };

  return { statementCardinality, statementMultiplicity };
};

export const inferStatementCardinality = (
  statement: Statement,
  schema: SchemaSnapshot,
  activeModule = "default",
): CardLevel => makeInferenceEngine(statement, schema, activeModule).statementCardinality();

export const inferStatementMultiplicity = (
  statement: Statement,
  schema: SchemaSnapshot,
  activeModule = "default",
): MultLevel => makeInferenceEngine(statement, schema, activeModule).statementMultiplicity();

// Statement-level type name (`stype`) for the Live IR. Returns the derived
// union name `__derived__::(modA:A | modB:B)` when the top-level expression
// composes multiple distinct object types (UNION / set literal / IF-ELSE / ??),
// matching the oracle; otherwise `undefined` so the caller falls back to the
// base set's typeref (which the builder already computes for the single-type
// case). Additive — `stype` is read 0× by execution.
export const inferStatementType = (
  statement: Statement,
  schema: SchemaSnapshot,
  activeModule = "default",
): string | undefined => {
  const branchObjectTypeName = (expr: FreeObjectExpr | undefined): string | undefined => {
    if (!expr) return undefined;
    let name: string | undefined;
    if (expr.kind === "binding_ref") name = expr.name;
    else if (expr.kind === "select") name = expr.typeName;
    else if (expr.kind === "shape_projection") return branchObjectTypeName(expr.expr);
    if (!name) return undefined;
    const typeDef = schema.getType(normalizeTypeName(name, activeModule));
    return typeDef ? qualifiedTypeName(typeDef) : undefined;
  };

  const expr = (statement as { expr?: FreeObjectExpr }).expr;
  if (!expr) return undefined;
  let branches: FreeObjectExpr[] | undefined;
  if (expr.kind === "set_expr") branches = expr.values;
  else if (expr.kind === "if_else") branches = [expr.thenExpr, expr.elseExpr];
  else if (expr.kind === "coalesce") branches = [expr.left, expr.right];
  if (!branches) return undefined;
  const names: string[] = [];
  for (const b of branches) {
    const n = branchObjectTypeName(b);
    if (!n) return undefined;
    names.push(n);
  }
  const distinct = [...new Set(names)];
  if (distinct.length < 2) return undefined;
  return `__derived__::(${distinct.map((qn) => qn.replace("::", ":")).join(" | ")})`;
};
