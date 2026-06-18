// The Runtime evaluator — the TypeScript interpreter for the `select_expr`
// constructs that don't lower to SQL (free objects, FOR iteration, runtime
// aliases, inlined UDFs). It was a 1,680-line closure buried in engine.ts with
// no interface of its own; only reachable end-to-end through executeQuery.
//
// Lifted here behind an explicit `SelectExprEvaluatorDeps` seam: the engine
// capabilities the interpreter reaches back into (function execution, link
// traversal, row reads, …) are injected rather than captured, so the back-edges
// are visible and the evaluator can be driven directly in tests. The body is
// byte-identical to the original closure — the deps are destructured into the
// same local names it always used. See docs/adr/0044.
import { linkTableName, tableNameForType } from "../codegen/sql.js";
import { selectExprNeedsRuntime } from "../compiler/execution_strategy.js";
import type {
  ComputedExpr,
  FilterValue,
  FreeObjectExpr,
  PathStep,
  SelectStatement,
  ShapeElement,
  Statement,
  TypeExpr,
  WithBindingValue,
} from "../edgeql/ast.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import { AppError } from "../errors.js";
import type { SQLiteDatabase } from "./database.js";
import { resolveLinkStorageOwner } from "../schema/physical_layout.js";
import { normalizeLinkTargetNames, qualifiedTypeName, usesLinkTable, type SchemaSnapshot } from "../schema/schema.js";
import { resolveStdlibFunction, type RuntimeFunctionArg } from "../stdlib/functions.js";
import type { ScalarValue } from "../types.js";
import { coIteratedBinding } from "./co_iteration.js";
import { applyLimitOffset, dedupeRowsById, distinctValues } from "./result_clauses.js";
import { evalTypeNarrowing, type TypeNarrowingDeps } from "./type_narrowing.js";
import type { QueryResult, SecurityContext, SelectExprEvaluatorDeps } from "./engine.js";

export const runSelectExprEvaluation = (
  db: SQLiteDatabase,
  schema: SchemaSnapshot,
  ast: Extract<Statement, { kind: "select_expr" }>,
  context: SecurityContext,
  deps: SelectExprEvaluatorDeps,
): QueryResult | undefined => {
  const {
    evaluateRuntimeAggregate,
    executeFunctionCall,
    executeMutationBinding,
    findFieldDef,
    findRuntimeLinkDef,
    inferStaticArgType,
    likeMatch,
    materializeFieldValue,
    normalizeRuntimeFloat,
    qualifiedRuntimeAliasName,
    qualifyRuntimeTypeName,
    quoteIdent,
    readRuntimeTypedAliasSourceRows,
    resolveBacklinkRowsForSubject,
    resolveUserFunctionOverload,
    runtimeAliasPredicateMatches,
  } = deps;
  type EvalEnv = Map<string, unknown>;

  // The SQL-vs-runtime predicate now lives in src/compiler/execution_strategy.ts
  // (shared with the compile-inspection seam's `strategy` fact; see ADR 0003).
  if (!selectExprNeedsRuntime(ast, schema)) {
    return undefined;
  }

  const evalFilterValue = (value: FilterValue, env: EvalEnv): unknown => {
    if (typeof value === "object" && value !== null && "kind" in value) {
      if (value.kind === "binding_ref") {
        return env.get(value.name) ?? null;
      }
      if (value.kind === "field_ref") {
        return env.get(value.field) ?? null;
      }
      if (value.kind === "set_literal") {
        return value.values;
      }
    }
    return value;
  };

  const resolveFieldPathValue = (
    row: Record<string, unknown>,
    typeName: string | undefined,
    fieldPath: string,
  ): unknown => {
    if (!fieldPath.includes(".")) {
      return row[fieldPath];
    }
    if (!typeName) {
      return undefined;
    }
    const parts = fieldPath.split(".");
    let currentRows: Record<string, unknown>[] = [row];
    let currentType = typeName;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const linkName = parts[i];
      const nextRows: Record<string, unknown>[] = [];
      for (const r of currentRows) {
        const linkDef = findRuntimeLinkDef(schema, currentType, linkName);
        if (!linkDef) {
          return undefined;
        }
        const sourceType = schema.getType(currentType);
        if (!sourceType) return undefined;
        const targetTypeNames = normalizeLinkTargetNames(linkDef.link.targetType, sourceType.module ?? "default");
        const targetTypes = targetTypeNames.flatMap((name) => schema.listConcreteTypesAssignableTo(name));
        if (usesLinkTable(linkDef.link)) {
          const owner = resolveLinkStorageOwner(schema, sourceType, linkDef.link);
          const linkTable = linkTableName(qualifiedTypeName(owner), linkDef.link);
          const linkRows = db.prepare(`SELECT ${quoteIdent("target")} FROM ${quoteIdent(linkTable)} WHERE ${quoteIdent("source")} = ?`).all(r.id as string) as Array<{ target?: unknown }>;
          for (const linkRow of linkRows) {
            if (typeof linkRow.target !== "string") continue;
            for (const targetType of targetTypes) {
              const targetTable = tableNameForType(qualifiedTypeName(targetType));
              const fetched = db.prepare(`SELECT * FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent("id")} = ?`).all(linkRow.target) as Record<string, unknown>[];
              for (const t of fetched) {
                nextRows.push(t);
              }
            }
          }
          currentType = qualifiedTypeName(targetTypes[0] ?? sourceType);
        } else {
          const targetId = r[`${linkDef.link.name}_id`];
          if (typeof targetId !== "string") continue;
          for (const targetType of targetTypes) {
            const targetTable = tableNameForType(qualifiedTypeName(targetType));
            const fetched = db.prepare(`SELECT * FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent("id")} = ?`).all(targetId) as Record<string, unknown>[];
            for (const t of fetched) {
              nextRows.push(t);
            }
          }
          currentType = qualifiedTypeName(targetTypes[0] ?? sourceType);
        }
      }
      currentRows = nextRows;
      if (currentRows.length === 0) return undefined;
    }
    const tail = parts[parts.length - 1];
    if (currentRows.length === 1) {
      return currentRows[0][tail];
    }
    return currentRows.map((r) => r[tail]);
  };

  const evalFilter = (row: Record<string, unknown>, filter: SelectStatement["filter"], env: EvalEnv, sourceTypeName?: string): boolean => {
    if (!filter) {
      return true;
    }
    if (filter.kind === "and") {
      return evalFilter(row, filter.left, env, sourceTypeName) && evalFilter(row, filter.right, env, sourceTypeName);
    }
    if (filter.kind === "or") {
      return evalFilter(row, filter.left, env, sourceTypeName) || evalFilter(row, filter.right, env, sourceTypeName);
    }
    if (filter.kind === "not") {
      return !evalFilter(row, filter.expr, env, sourceTypeName);
    }
    if (filter.kind === "free_expr") {
      const childEnv = new Map(env);
      childEnv.set("__current__", row);
      const value = evalExpr(filter.expr, childEnv);
      return Array.isArray(value) ? value.some(Boolean) : Boolean(value);
    }
    if (filter.target.kind !== "field") {
      return true;
    }
    const left = resolveFieldPathValue(row, sourceTypeName, filter.target.field);
    if (filter.kind === "in_predicate") {
      const values = filter.values.kind === "set_literal" ? filter.values.values : [];
      const hasValue = values.some((value) => value === left);
      return filter.op === "not_in" ? !hasValue : hasValue;
    }
    const right = evalFilterValue(filter.value, env);
    if (Array.isArray(left)) {
      return left.some((item) => runtimeAliasPredicateMatches(item, filter.op, right as ScalarValue));
    }
    return runtimeAliasPredicateMatches(left, filter.op, right as ScalarValue);
  };

  const evalComputedExpr = (computed: ComputedExpr, row: Record<string, unknown>, env: EvalEnv): unknown => {
    if (computed.kind === "literal") return computed.value;
    if (computed.kind === "field_ref") return row[computed.field] ?? null;
    if (computed.kind === "type_name") {
      return typeof row.__source_type === "string" ? row.__source_type : null;
    }
    if (computed.kind === "select_expr") {
      const childEnv = new Map(env);
      childEnv.set("__current__", row);
      return evalExpr(computed.expr, childEnv);
    }
    if (computed.kind === "binding_ref") {
      const bound = env.get(computed.name);
      if (bound === undefined) return null;
      if (Array.isArray(bound) && bound.length === 1) return bound[0];
      return bound;
    }
    // Other expression kinds (function_call, coalesce, math, …) — bind
    // `__current__` to the source row and delegate to the generic evaluator.
    // Without this, e.g. `Issue { z := opt_test(true, .time_estimate) }`
    // returns null for `z` because the function_call kind falls through to
    // the null default below.
    {
      const childEnv = new Map(env);
      childEnv.set("__current__", row);
      const result = evalExpr(computed as FreeObjectExpr, childEnv);
      if (result === undefined) return null;
      return result;
    }
  };

  const exprIsTupleValue = (expr: FreeObjectExpr | ComputedExpr): boolean => {
    if (expr.kind === "tuple") return true;
    if (expr.kind === "select_expr") return exprIsTupleValue(expr.expr);
    if (expr.kind === "coalesce") return exprIsTupleValue(expr.left) || exprIsTupleValue(expr.right);
    if (expr.kind === "field_access" && expr.expr.kind === "select") {
      const typeName = qualifyRuntimeTypeName(expr.expr.typeName, expr.expr.clauses._withModule ?? ast.withModule ?? "default");
      return findFieldDef(schema, typeName, expr.field)?.collection?.kind === "tuple";
    }
    return false;
  };

  const materializeShapeOnRow = (row: Record<string, unknown>, typeName: string, shape: ShapeElement[], env: EvalEnv): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const childEnv = new Map(env);
    childEnv.set("__source__", row);
    childEnv.set("__current__", row);
    childEnv.set(typeName.split("::").at(-1) ?? typeName, row);
    for (const element of shape) {
      if (element.kind === "field") {
        out[element.name] = row[element.name] ?? null;
        continue;
      }
      if (element.kind === "computed") {
        out[element.name] = evalComputedExpr(element.expr, row, childEnv);
        continue;
      }
    }
    return out;
  };

  const evalExpr = (expr: FreeObjectExpr | ComputedExpr, env: EvalEnv): unknown => {
    switch (expr.kind) {
      case "literal":
        return expr.value;
      case "field_ref": {
        const current = env.get("__current__");
        if (current && typeof current === "object" && !Array.isArray(current)) {
          return (current as Record<string, unknown>)[expr.field] ?? null;
        }
        return env.get(expr.field) ?? null;
      }
      case "select_expr":
        return evalExpr(expr.expr, env);
      case "subquery":
        return evalExpr({ kind: "select", typeName: expr.typeName, shape: expr.shape, clauses: expr.clauses }, env);
      case "type_intersection":
        return evalTypeNarrowing(expr, env, typeNarrowingDeps);
      case "field_suffix_math":
        return null;
      case "global_ref":
        return context.globals?.[expr.name] ?? null;
      case "set_literal":
        return [...expr.values];
      case "set_expr":
        return expr.values.flatMap((value) => {
          const evaluated = evalExpr(value, env);
          return Array.isArray(evaluated) && !exprIsTupleValue(value) && value.kind !== "array_literal_expr" ? evaluated : [evaluated];
        });
      case "array_literal_expr":
        {
          const evaluated = expr.values.map((value) => ({
            source: value,
            value: evalExpr(value, env),
          })).map((entry) => ({
            ...entry,
            setLike: Array.isArray(entry.value) && !exprIsTupleValue(entry.source) && entry.source.kind !== "array_literal_expr",
          }));
          if (!evaluated.some((entry) => entry.setLike)) return evaluated.map((entry) => entry.value);
          const sets = evaluated.map((entry) => {
            if (!entry.setLike) return [entry.value];
            return [...(entry.value as unknown[])].sort((a, b) => String(a).localeCompare(String(b)));
          });
          return sets.reduce<unknown[][]>(
            (rows, items) => rows.flatMap((row) => items.map((item) => [...row, item])),
            [[]],
          );
        }
      case "unary": {
        const value = evalExpr(expr.expr, env);
        const apply = (item: unknown): ScalarValue => {
          if (expr.op === "not") return !(item);
          return -Number(item);
        };
        return Array.isArray(value) ? value.map(apply) : apply(value);
      }
      case "binding_ref": {
        if (env.has(expr.name)) {
          return env.get(expr.name);
        }
        if (schema.getType(qualifyRuntimeTypeName(expr.name))) {
          return evalExpr({
            kind: "select",
            typeName: expr.name,
            shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }],
            clauses: {},
          }, env);
        }
        const alias = schema.getAlias(qualifiedRuntimeAliasName(expr.name));
        if (alias?.values) {
          return [...alias.values];
        }
        if (alias?.exprText) {
          const aliasAst = parseEdgeQL(`select ${alias.exprText.replace(/;\s*$/, "")}`);
          if (aliasAst.kind === "select_expr") {
            return evalExpr(aliasAst.expr, env);
          }
        }
        return null;
      }
      case "path": {
        const value = env.get(expr.head);
        if (value === undefined && schema.getType(qualifyRuntimeTypeName(expr.head))) {
          return evalExpr({
            kind: "field_access",
            expr: { kind: "select", typeName: expr.head, shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }], clauses: {} },
            field: expr.tail,
            optional: false,
          }, env);
        }
        if (Array.isArray(value)) {
          const nextEnv = new Map(env);
          nextEnv.set("__path_tmp", value);
          return evalExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__path_tmp" }, field: expr.tail, optional: false }, nextEnv);
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(row, expr.tail)) {
            return row[expr.tail] ?? null;
          }
          const nextEnv = new Map(env);
          nextEnv.set("__path_tmp", value);
          return evalExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__path_tmp" }, field: expr.tail, optional: false }, nextEnv);
        }
        return null;
      }
      case "current_item": {
        return env.get("__current__") ?? null;
      }
      case "backlink_path": {
        return resolveBacklinkRowsForSubject(db, schema, env.get("__current__"), expr.link, expr.sourceType);
      }
      case "tuple": {
        const bindingPath = (value: FreeObjectExpr): { name: string; path: number[] } | undefined => {
          if (value.kind === "binding_ref") return { name: value.name, path: [] };
          if (value.kind === "index_access") {
            const inner = bindingPath(value.expr);
            return inner ? { name: inner.name, path: [...inner.path, value.index] } : undefined;
          }
          return undefined;
        };
        const bindingPaths = expr.values.map(bindingPath);
        const firstBinding = bindingPaths[0]?.name;
        if (firstBinding && bindingPaths.every((path) => path?.name === firstBinding)) {
          const readPath = (value: unknown, path: number[]): unknown => {
            let current = value;
            for (const index of path) {
              if (!Array.isArray(current)) return null;
              current = current[index] ?? null;
            }
            return current;
          };
          const bound = evalExpr({ kind: "binding_ref", name: firstBinding }, env);
          const items = Array.isArray(bound) ? bound : [bound];
          return items.map((item) => bindingPaths.map((path) => readPath(item, path?.path ?? [])));
        }

        // Longest-common-prefix iteration: when every slot threads through the
        // same plain `select` source, iterate per source row rather than
        // cartesian-producting each slot independently.
        const findSelectScope = (e: FreeObjectExpr): string | null => {
          if (!e || typeof e !== "object") return null;
          if (e.kind === "select") {
            // Only treat the bare `Issue`-style select as an LCP scope, not
            // a filtered subquery — those scope to a distinct subset.
            const hasClauses = e.clauses?.filter || e.clauses?.orderBy
              || e.clauses?.limit !== undefined || e.clauses?.offset !== undefined;
            if (hasClauses) return null;
            return e.typeName;
          }
          if (e.kind === "field_access") return findSelectScope(e.expr);
          if (e.kind === "coalesce" || e.kind === "compare" || e.kind === "math" || e.kind === "and" || e.kind === "or") {
            return findSelectScope(e.left) ?? findSelectScope(e.right);
          }
          if (e.kind === "select_expr_subquery") return findSelectScope(e.expr);
          if (e.kind === "cast" || e.kind === "not" || e.kind === "distinct" || e.kind === "exists") {
            return findSelectScope(e.expr);
          }
          if (e.kind === "tuple" || e.kind === "set_expr" || e.kind === "array_literal_expr") {
            for (const v of e.values) {
              const s = findSelectScope(v);
              if (s) return s;
            }
            return null;
          }
          return null;
        };

        const slotScopes = expr.values.map(findSelectScope);
        const firstScope = slotScopes.find((s) => s !== null);
        const sharesScope = Boolean(firstScope)
          && slotScopes.every((s) => s === null || s === firstScope);
        if (firstScope && sharesScope) {
          const shortName = firstScope.split("::").at(-1) ?? firstScope;
          const scopedSource = env.has(firstScope)
            ? env.get(firstScope)
            : env.has(shortName)
              ? env.get(shortName)
              : undefined;
          const sourceRows = scopedSource === undefined
            ? evalExpr({
                kind: "select",
                typeName: firstScope,
                shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }],
                clauses: {},
              }, env)
            : scopedSource;
          const rows = Array.isArray(sourceRows)
            ? sourceRows
            : sourceRows === null || sourceRows === undefined ? [] : [sourceRows];
          if (rows.length > 0) {
            const allRows: unknown[][] = [];
            for (const sourceRow of rows) {
              const rowEnv = new Map(env);
              rowEnv.set("__current__", sourceRow);
              rowEnv.set(firstScope.split("::").at(-1) ?? firstScope, sourceRow);
              const slotEvaluated = expr.values.map((value) => ({
                value: evalExpr(value, rowEnv),
                tupleLike: exprIsTupleValue(value) || value.kind === "array_literal_expr",
              }));
              // Empty slot (null / empty multi-set) suppresses the whole row:
              // tuple cardinality is the product of slot cardinalities, so any
              // zero gives 0 rows. NULL on a property is the empty set in
              // EdgeQL semantics.
              const sets = slotEvaluated.map((entry) => {
                if (entry.value === null || entry.value === undefined) return [];
                if (Array.isArray(entry.value) && !entry.tupleLike) return entry.value;
                return [entry.value];
              });
              const expanded = sets.reduce<unknown[][]>(
                (acc, items) => acc.flatMap((row) => items.map((item) => [...row, item])),
                [[]],
              );
              allRows.push(...expanded);
            }
            if (scopedSource !== undefined) {
              return allRows[0] ?? null;
            }
            return allRows;
          }
        }

        const evaluated = expr.values.map((value) => ({
          value: evalExpr(value, env),
          tupleLike: exprIsTupleValue(value) || value.kind === "array_literal_expr",
        }));
        if (evaluated.some((entry) => (entry.value === null || entry.value === undefined) && !entry.tupleLike)) {
          return null;
        }
        const anyArray = evaluated.some((entry) => Array.isArray(entry.value) && !entry.tupleLike);
        if (!anyArray) return evaluated.map((entry) => entry.value);
        const sets = evaluated.map((entry) => {
          if ((entry.value === null || entry.value === undefined) && !entry.tupleLike) return [];
          return Array.isArray(entry.value) && !entry.tupleLike ? entry.value : [entry.value];
        });
        return sets.reduce<unknown[][]>(
          (rows, items) => rows.flatMap((row) => items.map((item) => [...row, item])),
          [[]],
        );
      }
      case "path_steps": {
        const first = expr.steps[0];
        if (!first) return [];
        let value: unknown;
        let rest: PathStep[];
        if (first.kind === "object_ref") {
          value = env.has(first.name)
            ? env.get(first.name)
            : evalExpr({ kind: "select", typeName: first.name, shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }], clauses: {} }, env);
          rest = expr.steps.slice(1);
        } else {
          value = env.get("__current__") ?? null;
          rest = expr.steps;
        }
        const matchesType = (row: unknown, typeExpr: TypeExpr): boolean => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return false;
          const sourceType = (row as Record<string, unknown>).__source_type;
          if (typeof sourceType !== "string") return false;
          const matchName = (name: string): boolean => {
            const qualified = qualifyRuntimeTypeName(name);
            return sourceType === qualified || schema.concreteTypeNamesUnder(qualified).includes(sourceType);
          };
          if (typeExpr.kind === "type_name") return matchName(typeExpr.name);
          if (typeExpr.kind === "type_union") return matchesType(row, typeExpr.left) || matchesType(row, typeExpr.right);
          return matchesType(row, typeExpr.left) && matchesType(row, typeExpr.right);
        };
        for (const step of rest) {
          if (step.kind === "type_intersection") {
            const typeExpr = step.typeExpr ?? { kind: "type_name" as const, name: step.typeName };
            const items = Array.isArray(value) ? value : [value];
            value = items.filter((item) => matchesType(item, typeExpr));
            continue;
          }
          if (step.kind === "ptr") {
            const nextEnv = new Map(env);
            nextEnv.set("__path_tmp", value);
            value = evalExpr({ kind: "field_access", expr: { kind: "binding_ref", name: "__path_tmp" }, field: step.name, optional: step.optional }, nextEnv);
          }
        }
        return value;
      }
      case "index_access": {
        const value = evalExpr(expr.expr, env);
        const rawIndex = expr.indexExpr ? evalExpr(expr.indexExpr, env) : expr.index;
        const indexPath = Array.isArray(rawIndex) ? rawIndex.filter((item): item is number => Number.isInteger(item)) : Number.isInteger(rawIndex) ? [rawIndex as number] : [];
        // The reference EdgeQL diagnostic uses a category prefix specific to the
        // source kind: "array index", "string index", or "JSON index".
        const indexErrorCategory = (item: unknown): string => {
          if (typeof item === "string") return "string";
          if (expr.expr.kind === "function_call" && (expr.expr.call.name === "to_json" || expr.expr.call.name.endsWith("::to_json"))) return "JSON";
          if (Array.isArray(item)) return "array";
          return "array";
        };
        const checkBounds = (item: unknown, index: number): void => {
          const length = typeof item === "string" || Array.isArray(item) ? item.length : 0;
          if (index >= length || index < -length) {
            throw new AppError(
              "E_RUNTIME",
              `${indexErrorCategory(item)} index ${index} is out of bounds`,
              ast.pos?.line ?? 0,
              ast.pos?.column ?? 0,
            );
          }
        };
        const readIndex = (item: unknown): unknown => {
          let current = item;
          for (const index of indexPath) {
            if (typeof current === "string") {
              checkBounds(current, index);
              current = current[index < 0 ? current.length + index : index] ?? null;
            } else if (Array.isArray(current)) {
              checkBounds(current, index);
              current = current[index < 0 ? current.length + index : index] ?? null;
            } else {
              return null;
            }
          }
          return current;
        };
        const readOneIndex = (item: unknown, index: number): unknown => {
          const prior = indexPath.splice(0, indexPath.length, index);
          const result = readIndex(item);
          indexPath.splice(0, indexPath.length, ...prior);
          return result;
        };
        if (typeof value === "string") {
          return readIndex(value);
        }
        if (Array.isArray(value)) {
          if (indexPath.length > 1) {
            return indexPath.flatMap((index) => {
              const item = readOneIndex(value, index);
              return Array.isArray(item) && expr.expr.kind === "array_literal_expr" ? item : item == null ? [] : [item];
            });
          }
          if (value.length > 0 && Array.isArray(value[0])) {
            const sourceIsSetOfTuples = expr.expr.kind === "tuple"
              && expr.expr.values.some((slot) => {
                const slotValue = evalExpr(slot, env);
                return Array.isArray(slotValue) && !exprIsTupleValue(slot) && slot.kind !== "array_literal_expr";
              });
            if (sourceIsSetOfTuples) {
              return value.map((tup) => Array.isArray(tup) ? readIndex(tup) : tup);
            }
            // `array_literal_expr[N]` is array indexing: the source IS an
            // array (single value), and the result is its Nth element — even
            // if that element is itself a tuple/array. Distinguish from a
            // set-of-tuples expression where `.N` would project per-row.
            if (expr.expr.kind === "array_literal_expr") return readIndex(value);
            return (exprIsTupleValue(expr.expr) || expr.expr.kind === "index_access") ? readIndex(value) : value.map((tup) => Array.isArray(tup) ? readIndex(tup) : tup);
          }
          // For scalar arrays the discriminator is the source IR kind:
          //   - `binding_ref`, `current_item`, `index_access` carry a SINGLE
          //     value (a tuple slot, or a single string/number) — `[N]` is
          //     slot/char access on that single value.
          //   - `path_steps`, `field_access` (over a select) produce a SET —
          //     `[N]` applies element-wise (e.g. `X.name[0]` → first char of
          //     each name).
          if (expr.expr.kind === "binding_ref"
            || expr.expr.kind === "current_item"
            || expr.expr.kind === "index_access") {
            return readIndex(value);
          }
          return value.map(readIndex);
        }
        return null;
      }
      case "slice_access": {
        const value = evalExpr(expr.expr, env);
        const startValue = expr.startExpr ? evalExpr(expr.startExpr, env) : expr.start;
        const endValue = expr.endExpr ? evalExpr(expr.endExpr, env) : expr.end;
        const starts = Array.isArray(startValue) ? startValue.filter((item): item is number => Number.isInteger(item)) : [startValue].filter((item): item is number => Number.isInteger(item));
        const ends = Array.isArray(endValue) ? endValue.filter((item): item is number => Number.isInteger(item)) : [endValue].filter((item): item is number => Number.isInteger(item));
        const sliceOne = (source: unknown, start: number | undefined, end: number | undefined): unknown => {
          if (!Array.isArray(source) && typeof source !== "string") return null;
          return source.slice(start, end);
        };
        if (starts.length > 0) {
          return starts.map((start) => sliceOne(value, start, ends[0])).filter((item) => item !== null);
        }
        return sliceOne(value, undefined, ends[0]);
      }
      case "field_access": {
        const value = evalExpr(expr.expr, env);
        const fieldName = expr.field;
        const readOne = (item: unknown): unknown => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return null;
          }
          const row = item as Record<string, unknown>;
          const sourceTypeName = typeof row.__source_type === "string" ? row.__source_type : undefined;
          if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
            return sourceTypeName ? materializeFieldValue(schema, sourceTypeName, fieldName, row[fieldName]) : row[fieldName] ?? null;
          }
          if (sourceTypeName && !fieldName.startsWith("@") && typeof row.id === "string") {
            const linkDef = findRuntimeLinkDef(schema, sourceTypeName, fieldName);
            if (linkDef) {
              const usesTable = usesLinkTable(linkDef.link);
              const sourceType = schema.getType(sourceTypeName);
              if (usesTable && sourceType) {
                const owner = resolveLinkStorageOwner(schema, sourceType, linkDef.link);
                const linkTable = linkTableName(qualifiedTypeName(owner), linkDef.link);
                const targetTypeNames = normalizeLinkTargetNames(linkDef.link.targetType, sourceType.module ?? "default");
                const candidates = targetTypeNames.flatMap((targetTypeName) => {
                  const concrete = schema.listConcreteTypesAssignableTo(targetTypeName);
                  if (concrete.length > 0) return concrete;
                  const direct = schema.getType(targetTypeName);
                  return direct ? [direct] : [];
                });
                const targets: Record<string, unknown>[] = [];
                for (const concrete of candidates) {
                  const concreteName = qualifiedTypeName(concrete);
                  const concreteTable = tableNameForType(concreteName);
                  const rows = db.prepare(
                    `SELECT t.*, j.* FROM ${quoteIdent(concreteTable)} t JOIN ${quoteIdent(linkTable)} j ON j.${quoteIdent("target")} = t.${quoteIdent("id")} WHERE j.${quoteIdent("source")} = ?`
                  ).all(row.id) as Record<string, unknown>[];
                  for (const linkRow of rows) {
                    const merged: Record<string, unknown> = { ...linkRow, __source_type: concreteName };
                    for (const property of linkDef.link.properties ?? []) {
                      merged[`@${property.name}`] = linkRow[property.name] ?? null;
                    }
                    targets.push(merged);
                  }
                }
                return targets;
              }
              const inlineColumn = `${linkDef.link.name}_id`;
              if (Object.prototype.hasOwnProperty.call(row, inlineColumn)) {
                const targetId = row[inlineColumn];
                if (typeof targetId !== "string") return null;
                const targetTypeName = qualifyRuntimeTypeName(linkDef.link.targetType);
                const targetTable = tableNameForType(targetTypeName);
                const loaded = db.prepare(`SELECT * FROM ${quoteIdent(targetTable)} WHERE ${quoteIdent("id")} = ?`).all(targetId)[0] as Record<string, unknown> | undefined;
                return loaded ? { ...loaded, __source_type: targetTypeName } : null;
              }
            }
          }
          const computed = sourceTypeName
            ? schema.getType(sourceTypeName)?.computeds?.find((candidate) => candidate.kind === "property" && candidate.name === fieldName)
            : undefined;
          if (computed?.kind === "property" && computed.expr.kind === "literal") {
            return computed.expr.value;
          }
          if (computed?.kind === "property" && computed.expr.kind === "set_literal") {
            return [...computed.expr.values];
          }
          if (computed?.kind === "property" && computed.expr.kind === "link_aggregate") {
            const aggregateExpr = computed.expr;
            const aggregateField = aggregateExpr.field;
            const sourceEnv = new Map(env);
            sourceEnv.set("__computed_source__", row);
            const linked = evalExpr({
              kind: "field_access",
              expr: { kind: "binding_ref", name: "__computed_source__" },
              field: aggregateExpr.link,
              optional: false,
            }, sourceEnv);
            const linkItems = Array.isArray(linked)
              ? linked
              : linked === null || linked === undefined ? [] : [linked];
            if (aggregateField === undefined) {
              // Fieldless `count(.link)`: aggregate over the link target
              // rows themselves, matching the SQL path's
              // COUNT(DISTINCT target). Only `count` is produced fieldless
              // upstream (sdl_adapter's detectCountOfLink); numeric
              // aggregates over object rows reduce to the empty set.
              return evaluateRuntimeAggregate(aggregateExpr.functionName, dedupeRowsById(linkItems));
            }
            const values = linkItems.flatMap((item) => {
              const linkEnv = new Map(env);
              linkEnv.set("__computed_link__", item);
              const value = evalExpr({
                kind: "field_access",
                expr: { kind: "binding_ref", name: "__computed_link__" },
                field: aggregateField,
                optional: false,
              }, linkEnv);
              return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
            });
            return evaluateRuntimeAggregate(aggregateExpr.functionName, values);
          }
          return null;
        };
        if (Array.isArray(value)) {
          const out: unknown[] = [];
          for (const item of value) {
            const result = readOne(item);
            if (Array.isArray(result)) out.push(...result);
            else if (result !== null && result !== undefined) out.push(result);
          }
          // EdgeQL paths return DISTINCT objects (by id). When the result
          // items are all id-bearing rows, dedupe so cross-product joins
          // collapse to set semantics.
          if (out.length > 1
            && out.every((item) => item && typeof item === "object" && !Array.isArray(item)
              && typeof (item as { id?: unknown }).id === "string")) {
            return dedupeRowsById(out);
          }
          return out;
        }
        return readOne(value);
      }
      case "function_call": {
        const qualifiedName = expr.call.name.includes("::")
          ? expr.call.name
          : resolveStdlibFunction(`std::${expr.call.name}`, expr.call.args.length)
            ? `std::${expr.call.name}`
            : `${ast.withModule ?? "default"}::${expr.call.name}`;
        const args = expr.call.args.map((arg): RuntimeFunctionArg => {
          if (arg.kind === "expr") {
            const value = evalExpr(arg.expr, env);
            // An `array_literal_expr` produces a SINGLE array value (not a
            // set), and a `tuple` produces a single tuple value — preserve
            // that distinction so user-function overload resolution can
            // accept `array<int64>` / tuple parameter types correctly.
            if (Array.isArray(value)) {
              if (arg.expr.kind === "array_literal_expr") return { kind: "array", values: value as ScalarValue[] };
              return { kind: "set", values: value as ScalarValue[] };
            }
            return value as ScalarValue;
          }
          if (arg.kind === "literal") return arg.value;
          if (arg.kind === "set_literal") return { kind: "set", values: [...arg.values] };
          if (arg.kind === "array_literal") return { kind: "array", values: [...arg.values] };
          if (arg.kind === "binding_ref") {
            const value = evalExpr({ kind: "binding_ref", name: arg.name }, env);
            return Array.isArray(value) ? { kind: "set", values: value as ScalarValue[] } : value as ScalarValue;
          }
          if (arg.kind === "function_call") {
            const value = evalExpr({ kind: "function_call", call: arg.call }, env);
            return Array.isArray(value) ? { kind: "set", values: value as ScalarValue[] } : value as ScalarValue;
          }
          if (arg.kind === "field_ref") {
            return env.get(arg.field) as ScalarValue ?? null;
          }
          return null;
        });
        // Static type hints from the AST disambiguate overloaded calls when
        // a runtime arg is empty (so its type can't be inferred from value
        // alone). E.g. `opt_test(false, Issue.time_estimate)` — when an Issue
        // has no time_estimate the runtime sees `null`, but the static type
        // is `int64`, which picks the right overload's body.
        const staticTypes = expr.call.args.map((arg) => inferStaticArgType(arg, schema, ast.withModule ?? "default"));
        // EdgeQL empty-set propagation: when a UDF exists by name+arity but
        // no overload accepts the runtime args because some non-OPTIONAL
        // parameter received an empty set, the whole call evaluates to an
        // empty set (not scalar null, which the top-level set wrapping
        // would otherwise turn into a one-row `[null]` result).
        const dividerIdx = qualifiedName.lastIndexOf("::");
        const fnModule = dividerIdx >= 0 ? qualifiedName.slice(0, dividerIdx) : (ast.withModule ?? "default");
        const fnName = dividerIdx >= 0 ? qualifiedName.slice(dividerIdx + 2) : qualifiedName;
        const anyEmpty = args.some((arg) => {
          if (arg === null || arg === undefined) return true;
          return typeof arg === "object" && "kind" in arg && arg.kind === "set" && arg.values.length === 0;
        });
        if (anyEmpty && schema.listFunctions().some((f) => f.module === fnModule && f.name === fnName)) {
          if (!resolveUserFunctionOverload(schema, fnModule, fnName, args, staticTypes)) {
            return [];
          }
        }
        return executeFunctionCall(schema, db, context, qualifiedName, args, staticTypes);
      }
      case "for_expr": {
        const iteratorValue = evalExpr(expr.iterator, env);
        const iteratorItems = Array.isArray(iteratorValue)
          ? iteratorValue
          : iteratorValue === null || iteratorValue === undefined
            ? []
            : [iteratorValue];
        const isSetProducing = (body: FreeObjectExpr): boolean => {
          if (body.kind === "select_expr_subquery") {
            if ((body.filter || body.orderBy || body.limit !== undefined || body.offset !== undefined)
              && !exprIsTupleValue(body.expr)) {
              return true;
            }
            return isSetProducing(body.expr);
          }
          if (body.kind === "select") return true;
          if (body.kind === "for_expr") return true;
          if (body.kind === "set_expr") return true;
          if (body.kind === "distinct") return isSetProducing(body.expr);
          // A shape projection over a set-producing base is itself a set
          // (e.g. `for n in {8,9} select User{name, b:=n}` flattens its rows).
          if (body.kind === "shape_projection") return isSetProducing(body.expr);
          if (body.kind === "field_access") return true;
          if (body.kind === "path_steps") return true;
          return false;
        };
        const flatten = isSetProducing(expr.body);
        return iteratorItems.flatMap((item) => {
          const nextEnv = new Map(env);
          nextEnv.set(expr.variable, item);
          const bodyValue = evalExpr(expr.body, nextEnv);
          if (!flatten) {
            return bodyValue === null || bodyValue === undefined ? [] : [bodyValue];
          }
          return Array.isArray(bodyValue) ? bodyValue : bodyValue === null || bodyValue === undefined ? [] : [bodyValue];
        });
      }
      case "free_object_constructor": {
        const record: Record<string, unknown> = {};
        for (const entry of expr.entries) {
          record[entry.name] = evalExpr(entry.expr, env);
        }
        return record;
      }
      case "math": {
        const applyMath = (l: unknown, r: unknown): number | null => {
          const ln = Number(l);
          const rn = Number(r);
          switch (expr.op) {
            case "+": return ln + rn;
            case "-": return ln - rn;
            case "*": return ln * rn;
            case "/": return normalizeRuntimeFloat(ln / rn);
            case "//": return Math.floor(ln / rn);
            case "%": return ln % rn;
            case "^": return Math.pow(ln, rn);
            default: return null;
          }
        };
        // EdgeQL co-iteration: when both sides walk a binding currently
        // bound to a set (e.g. `WITH x := {1,2,3} SELECT x * x`), the two
        // references must iterate in lockstep — `x * x` produces three
        // values (1, 4, 9), not nine. Without this, evaluating each side
        // independently yields the full Cartesian product. (The `compare`
        // case below has a similar shortcut for `?=`/`?!=`.)
        const coBinding = coIteratedBinding(expr.left, expr.right, env);
        if (coBinding) {
          const rows: number[] = [];
          for (const row of coBinding.rows) {
            const rowEnv: EvalEnv = new Map(env);
            rowEnv.set(coBinding.root, row);
            const l = evalExpr(expr.left, rowEnv);
            const r = evalExpr(expr.right, rowEnv);
            const value = applyMath(
              Array.isArray(l) ? l[0] : l,
              Array.isArray(r) ? r[0] : r,
            );
            if (value !== null) rows.push(value);
          }
          return rows;
        }
        const leftValue = evalExpr(expr.left, env);
        const rightValue = evalExpr(expr.right, env);
        const leftIsSet = Array.isArray(leftValue);
        const rightIsSet = Array.isArray(rightValue);
        if (!leftIsSet && !rightIsSet) {
          return applyMath(leftValue, rightValue);
        }
        const leftItems = leftIsSet ? leftValue : [leftValue];
        const rightItems = rightIsSet ? rightValue : [rightValue];
        const out: unknown[] = [];
        for (const l of leftItems) {
          for (const r of rightItems) {
            out.push(applyMath(l, r));
          }
        }
        return out;
      }
      case "compare": {
        // LCP iteration for `?=`/`?!=`: when both sides walk through paths
        // rooted in the same WITH binding (a multi-row set), iterate per
        // row of that binding so the two sides co-iterate rather than being
        // evaluated as independent global sets. Example:
        //   WITH I := (SELECT Issue FILTER …)
        //   SELECT I.time_estimate ?!= I.time_spent_log.spent_time
        // must produce |I| booleans, one per row, not a single global value.
        if (expr.op === "?=" || expr.op === "?!=") {
          const coBinding = coIteratedBinding(expr.left, expr.right, env);
          if (coBinding && coBinding.rows.length > 0) {
            const lcpIsEmpty = (v: unknown): boolean =>
              v === null || v === undefined || (Array.isArray(v) && v.length === 0);
            const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
              && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
            const out: boolean[] = [];
            for (const row of coBinding.rows) {
              const subEnv = new Map(env);
              subEnv.set(coBinding.root, [row]);
              const lv = evalExpr(expr.left, subEnv);
              const rv = evalExpr(expr.right, subEnv);
              const lEmpty = lcpIsEmpty(lv);
              const rEmpty = lcpIsEmpty(rv);
              if (lEmpty && rEmpty) {
                out.push(expr.op === "?=");
                continue;
              }
              if (lEmpty) {
                const rItems = Array.isArray(rv) ? rv : [rv];
                const v = expr.op === "?!=";
                for (let i = 0; i < rItems.length; i++) out.push(v);
                continue;
              }
              if (rEmpty) {
                const lItems = Array.isArray(lv) ? lv : [lv];
                const v = expr.op === "?!=";
                for (let i = 0; i < lItems.length; i++) out.push(v);
                continue;
              }
              const lItems = Array.isArray(lv) ? lv : [lv];
              const rItems = Array.isArray(rv) ? rv : [rv];
              for (const l of lItems) {
                for (const r of rItems) {
                  const eq = comparable(l) === comparable(r);
                  out.push(expr.op === "?=" ? eq : !eq);
                }
              }
            }
            return out;
          }
        }

        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        const isEmpty = (v: unknown): boolean =>
          v === null || v === undefined || (Array.isArray(v) && v.length === 0);
        if (expr.op === "?=" || expr.op === "?!=") {
          const leftEmpty = isEmpty(left);
          const rightEmpty = isEmpty(right);
          if (leftEmpty && rightEmpty) return expr.op === "?=";
          if (leftEmpty) {
            // LHS empty, RHS has N elements → produce N booleans
            // (?= empty vs present = false; ?!= empty vs present = true).
            const rItems = Array.isArray(right) ? right : [right];
            const value = expr.op === "?!=";
            return Array.isArray(right) ? rItems.map(() => value) : value;
          }
          if (rightEmpty) {
            // Symmetric: RHS empty, LHS has N elements.
            const lItems = Array.isArray(left) ? left : [left];
            const value = expr.op === "?!=";
            return Array.isArray(left) ? lItems.map(() => value) : value;
          }
          const lItems = Array.isArray(left) ? left : [left];
          const rItems = Array.isArray(right) ? right : [right];
          // Compare by id for object rows so distinct JS instances of the
          // same row equate; fall back to value equality for scalars.
          const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
            && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
          const out: boolean[] = [];
          for (const l of lItems) {
            for (const r of rItems) {
              const eq = comparable(l) === comparable(r);
              out.push(expr.op === "?=" ? eq : !eq);
            }
          }
          return (Array.isArray(left) || Array.isArray(right)) ? out : out[0] ?? false;
        }
        const compareOne = (l: unknown, r: unknown): boolean => {
          if (expr.op === "=") return l === r;
          if (expr.op === "!=") return l !== r;
          if (expr.op === ">") return Number(l) > Number(r);
          if (expr.op === "<") return Number(l) < Number(r);
          if (expr.op === ">=") return Number(l) >= Number(r);
          if (expr.op === "<=") return Number(l) <= Number(r);
          if (expr.op === "like" || expr.op === "ilike") {
            return likeMatch(l, r, expr.op === "ilike");
          }
          if (expr.op === "not_like" || expr.op === "not_ilike") {
            return !likeMatch(l, r, expr.op === "not_ilike");
          }
          return false;
        };
        const leftIsSet = Array.isArray(left);
        const rightIsSet = Array.isArray(right);
        // EdgeQL: any binary op with an empty-set operand produces empty set.
        if ((leftIsSet && (left as unknown[]).length === 0)
          || (rightIsSet && (right as unknown[]).length === 0)) {
          return [];
        }
        if (!leftIsSet && !rightIsSet) {
          return compareOne(left, right);
        }
        const leftItems = leftIsSet ? left : [left];
        const rightItems = rightIsSet ? right : [right];
        const out: boolean[] = [];
        for (const l of leftItems) {
          for (const r of rightItems) {
            out.push(compareOne(l, r));
          }
        }
        return out;
      }
      case "in_expr": {
        // `x IN set_of_y` — true iff `x` equals any element of the set
        // produced by evaluating `right`. EdgeQL semantics: scalar IN
        // empty-set is false (not empty). When `left` is itself set-valued,
        // emit one boolean per `left` element.
        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        const rightItems = Array.isArray(right) ? right : right === null || right === undefined ? [] : [right];
        const leftIsSet = Array.isArray(left);
        const leftItems = leftIsSet ? left : [left];
        const comparable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
          && typeof (v as { id?: unknown }).id === "string") ? (v as { id: string }).id : v;
        const checkOne = (item: unknown): boolean => {
          const target = comparable(item);
          const has = rightItems.some((candidate) => comparable(candidate) === target);
          return expr.op === "not_in" ? !has : has;
        };
        if (!leftIsSet) {
          return checkOne(left);
        }
        return leftItems.map(checkOne);
      }
      case "and": {
        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        if (!Array.isArray(left) && !Array.isArray(right)) {
          return Boolean(left) && Boolean(right);
        }
        const leftItems = Array.isArray(left) ? left : [left];
        const rightItems = Array.isArray(right) ? right : [right];
        return leftItems.flatMap((l) => rightItems.map((r) => Boolean(l) && Boolean(r)));
      }
      case "or": {
        const left = evalExpr(expr.left, env);
        const right = evalExpr(expr.right, env);
        if (!Array.isArray(left) && !Array.isArray(right)) {
          return Boolean(left) || Boolean(right);
        }
        const leftItems = Array.isArray(left) ? left : [left];
        const rightItems = Array.isArray(right) ? right : [right];
        return leftItems.flatMap((l) => rightItems.map((r) => Boolean(l) || Boolean(r)));
      }
      case "not":
        return !(evalExpr(expr.expr, env));
      case "coalesce": {
        // LCP iteration: when both sides root in the same WITH binding (e.g.
        // `WITH X := {Priority, Status} SELECT X[IS Priority].name ??
        //  X[IS Status].name`), iterate per row of X so each element gets
        // its own LHS/RHS choice — rather than evaluating LHS globally,
        // finding it non-empty (the Priorities), and returning just those.
        const findBindingRoot = (e: FreeObjectExpr | ComputedExpr): string | null => {
          if (!e || typeof e !== "object") return null;
          if (e.kind === "binding_ref") return e.name;
          if (e.kind === "field_access") return findBindingRoot(e.expr);
          if (e.kind === "index_access") return findBindingRoot(e.expr);
          if (e.kind === "cast") return findBindingRoot(e.expr);
          if (e.kind === "path_steps") {
            const first = e.steps[0];
            return first?.kind === "object_ref" ? first.name : null;
          }
          return null;
        };
        const leftRoot = findBindingRoot(expr.left);
        const rightRoot = findBindingRoot(expr.right);
        if (leftRoot && leftRoot === rightRoot && env.has(leftRoot)) {
          const bound = env.get(leftRoot);
          if (Array.isArray(bound) && bound.length > 0) {
            const out: unknown[] = [];
            for (const row of bound) {
              const subEnv = new Map(env);
              subEnv.set(leftRoot, [row]);
              const lv = evalExpr(expr.left, subEnv);
              const lEmpty = lv === null || lv === undefined
                || (Array.isArray(lv) && lv.length === 0);
              const branch = lEmpty ? evalExpr(expr.right, subEnv) : lv;
              if (branch === null || branch === undefined) continue;
              if (Array.isArray(branch)) {
                for (const item of branch) {
                  if (item !== null && item !== undefined) out.push(item);
                }
              } else {
                out.push(branch);
              }
            }
            return out;
          }
        }
        const left = evalExpr(expr.left, env);
        const isEmpty = left === null
          || left === undefined
          || (Array.isArray(left) && left.length === 0);
        if (!isEmpty) return left;
        return evalExpr(expr.right, env);
      }
      case "concat": {
        // Longest-common-prefix iteration for `++`: when every part threads
        // through the same `select` source, evaluate per-source-row and
        // concatenate within that row. When LCP does NOT apply we return
        // undefined so the caller falls back to the legacy cross-product
        // handler.
        const findScope = (e: FreeObjectExpr): string | null => {
          if (!e || typeof e !== "object") return null;
          if (e.kind === "select") {
            const hasClauses = e.clauses?.filter || e.clauses?.orderBy
              || e.clauses?.limit !== undefined || e.clauses?.offset !== undefined;
            if (hasClauses) return null;
            return e.typeName;
          }
          if (e.kind === "field_access") return findScope(e.expr);
          if (e.kind === "cast") return findScope(e.expr);
          if (e.kind === "select_expr_subquery") return findScope(e.expr);
          if (e.kind === "coalesce") return findScope(e.left) ?? findScope(e.right);
          if (e.kind === "concat") {
            for (const p of e.parts) { const s = findScope(p); if (s) return s; }
            return null;
          }
          if (e.kind === "function_call") {
            // The function's scope is the shared scope of its non-literal
            // args. Literals contribute no scope. Mixed scopes disqualify
            // (return null) so the caller falls back to cross-product.
            let scope: string | null = null;
            for (const arg of e.call.args) {
              if (arg.kind !== "expr") continue;
              const s = findScope(arg.expr);
              if (s === null) continue;
              if (scope === null) scope = s;
              else if (scope !== s) return null;
            }
            return scope;
          }
          return null;
        };
        const partScopes = expr.parts.map(findScope);
        // Require EVERY part to have the same non-null scope. A null in any
        // part means we can't determine its source (e.g. it's a filtered
        // subquery), so falling back to the cartesian path is safer than
        // picking the wrong scope.
        const firstScope = partScopes[0];
        const sharesScope = firstScope !== null
          && partScopes.every((s) => s === firstScope);
        if (firstScope && sharesScope && !env.has(firstScope) && !env.has("__current__")) {
          const sourceRows = evalExpr({
            kind: "select",
            typeName: firstScope,
            shape: [{ kind: "splat", depth: 1, operation: "assign", origin: "explicit" }],
            clauses: {},
          }, env);
          const rows = Array.isArray(sourceRows)
            ? sourceRows
            : sourceRows === null || sourceRows === undefined ? [] : [sourceRows];
          if (rows.length > 0) {
            const out: unknown[] = [];
            for (const sourceRow of rows) {
              const rowEnv = new Map(env);
              rowEnv.set("__current__", sourceRow);
              rowEnv.set(firstScope.split("::").at(-1) ?? firstScope, sourceRow);
              let accums: string[] = [""];
              let suppressed = false;
              for (const part of expr.parts) {
                const partValue = evalExpr(part, rowEnv);
                const partItems = Array.isArray(partValue) ? partValue : [partValue];
                if (partItems.length === 0) { suppressed = true; break; }
                const next: string[] = [];
                for (const left of accums) {
                  for (const right of partItems) {
                    if (right === null || right === undefined) { suppressed = true; break; }
                    next.push(`${left}${String(right)}`);
                  }
                  if (suppressed) break;
                }
                if (suppressed) break;
                accums = next;
              }
              if (!suppressed) out.push(...accums);
            }
            return out;
          }
        }
        return undefined;
      }
      case "select": {
        const envValue = env.get(expr.typeName);
        if (envValue !== undefined) {
          if (Array.isArray(envValue)) return envValue;
          if (typeof envValue === "object" && envValue !== null) return envValue;
        }
        const alias = schema.getAlias(qualifiedRuntimeAliasName(expr.typeName));
        if (alias?.values) {
          return [...alias.values];
        }
        const sourceType = qualifyRuntimeTypeName(expr.typeName);
        let rows = readRuntimeTypedAliasSourceRows(db, schema, {
          aliasName: "__expr__",
          moduleName: sourceType.split("::")[0] ?? "default",
          sourceType,
          linkOverrides: [],
        });
        rows = rows.filter((row) => evalFilter(row, expr.clauses.filter, env, sourceType));
        const clausesOrderBy = expr.clauses.orderBy;
        if (clausesOrderBy) {
          const direction = clausesOrderBy.direction === "desc" ? -1 : 1;
          rows.sort((a, b) => String(a[clausesOrderBy.field] ?? "").localeCompare(String(b[clausesOrderBy.field] ?? "")) * direction);
        }
        rows = applyLimitOffset(rows, expr.clauses.limit);
        if (expr.shape && expr.shape.some((el) => el.kind === "computed" || (el.kind === "field" && el.origin !== "default"))) {
          return rows.map((row) => materializeShapeOnRow(row, sourceType, expr.shape, env));
        }
        return rows;
      }
      case "cast": {
        const value = evalExpr(expr.expr, env);
        if (expr.castType === "str") {
          // `<str>{}` is empty in EdgeQL; preserve null so downstream
          // concat/?? sees emptiness rather than an empty string. For
          // arrays we map per-element so nulls propagate per-row.
          if (value === null || value === undefined) return null;
          if (Array.isArray(value)) {
            return value.map((item) => (item === null || item === undefined ? null : String(item)));
          }
          return String(value);
        }
        return value;
      }
      case "is_type":
        return evalTypeNarrowing(expr, env, typeNarrowingDeps);
      case "select_expr_subquery": {
        const value = evalExpr(expr.expr, env);
        if (value === undefined) {
          return undefined;
        }
        if (!expr.orderBy && !expr.filter && expr.limit === undefined && expr.offset === undefined) {
          return value;
        }
        let rows = Array.isArray(value) ? [...value] : [value];
        const filterExpr = expr.filter;
        if (filterExpr) {
          rows = rows.filter((item) => {
            const childEnv = new Map(env);
            if (expr.alias) childEnv.set(expr.alias, item);
            childEnv.set("__current__", item as Record<string, unknown>);
            const result = evalExpr(filterExpr, childEnv);
            return Array.isArray(result) ? result.some(Boolean) : Boolean(result);
          });
        }
        const orderByClause = expr.orderBy;
        if (orderByClause) {
          const enumOrder = enumOrderForRows(rows);
          const direction = orderByClause.direction === "desc" ? -1 : 1;
          rows.sort((a, b) => {
            const leftEnv = new Map(env);
            const rightEnv = new Map(env);
            if (expr.alias) {
              leftEnv.set(expr.alias, a);
              rightEnv.set(expr.alias, b);
            }
            leftEnv.set("__current__", a as Record<string, unknown>);
            rightEnv.set("__current__", b as Record<string, unknown>);
            const left = evalExpr(orderByClause.expr, leftEnv);
            const right = evalExpr(orderByClause.expr, rightEnv);
            const leftEnumIndex = typeof left === "string" ? enumOrder?.get(left) : undefined;
            const rightEnumIndex = typeof right === "string" ? enumOrder?.get(right) : undefined;
            if (leftEnumIndex !== undefined && rightEnumIndex !== undefined && leftEnumIndex !== rightEnumIndex) {
              return (leftEnumIndex < rightEnumIndex ? -1 : 1) * direction;
            }
            return String(left ?? "").localeCompare(String(right ?? "")) * direction;
          });
        }
        rows = applyLimitOffset(rows, expr.limit, expr.offset);
        return rows;
      }
      case "distinct": {
        const value = evalExpr(expr.expr, env);
        if (!Array.isArray(value)) return value;
        return distinctValues(value);
      }
      case "type_name":
        return evalTypeNarrowing(expr, env, typeNarrowingDeps);
      case "polymorphic_field_ref":
        return evalTypeNarrowing(expr, env, typeNarrowingDeps);
      case "shape_projection": {
        const exprAsPath = (e: FreeObjectExpr | undefined): string | undefined => {
          if (!e || typeof e !== "object") return undefined;
          if (e.kind === "field_access") {
            const inner = exprAsPath(e.expr);
            return inner ? `${inner}.${e.field}` : undefined;
          }
          if (e.kind === "index_access") {
            const inner = exprAsPath(e.expr);
            return inner ? `${inner}[${e.index}]` : undefined;
          }
          if (e.kind === "binding_ref") return `:${e.name}`;
          if (e.kind === "current_item") return ":__current__";
          return undefined;
        };
        const baseAsTupleIteration = (e: FreeObjectExpr): { tuplesPath: FreeObjectExpr; index: number } | undefined => {
          if (e.kind === "index_access") {
            return { tuplesPath: e.expr, index: e.index };
          }
          return undefined;
        };
        const tupleIter = baseAsTupleIteration(expr.expr);
        if (tupleIter) {
          const stripBindingsToCurrent = (e: FreeObjectExpr | undefined): FreeObjectExpr | undefined => {
            if (!e || typeof e !== "object") return e;
            if (e.kind === "binding_ref" && env.get(e.name) !== undefined) {
              return { kind: "current_item" } as FreeObjectExpr;
            }
            if (e.kind === "field_access") return { ...e, expr: stripBindingsToCurrent(e.expr) as FreeObjectExpr };
            if (e.kind === "index_access") return { ...e, expr: stripBindingsToCurrent(e.expr) as FreeObjectExpr };
            return e;
          };
          const tuplePathExpr = stripBindingsToCurrent(tupleIter.tuplesPath) as FreeObjectExpr;
          const tupleBasePath = exprAsPath(tuplePathExpr);
          const tuples = evalExpr(tupleIter.tuplesPath, env);
          const tupleList: unknown[] = Array.isArray(tuples) ? tuples : tuples == null ? [] : [tuples];
          const onlyTupleRows = tupleList.length > 0 && tupleList.every((t) => Array.isArray(t));
          if (onlyTupleRows && tupleBasePath) {
            const out: Record<string, unknown>[] = [];
            for (const tuple of tupleList as unknown[][]) {
              const subjectValue = tuple[tupleIter.index];
              if (!subjectValue || typeof subjectValue !== "object" || Array.isArray(subjectValue)) continue;
              const subjectRow = subjectValue as Record<string, unknown>;
              const childEnv = new Map(env);
              childEnv.set("__current__", subjectRow);
              const projected: Record<string, unknown> = { ...subjectRow };
              for (const element of expr.shape) {
                if (element.kind === "field") {
                  projected[element.name] = subjectRow[element.name] ?? null;
                } else if (element.kind === "computed") {
                  if (element.expr.kind === "field_ref") {
                    projected[element.name] = subjectRow[element.expr.field] ?? null;
                  } else {
                    const unwrappedExpr = element.expr.kind === "select_expr"
                      ? element.expr.expr
                      : element.expr as FreeObjectExpr;
                    const normalizedElemExpr = stripBindingsToCurrent(unwrappedExpr) as FreeObjectExpr;
                    const elemPath = exprAsPath(normalizedElemExpr);
                    const tupleIndexMatch = elemPath && elemPath.startsWith(`${tupleBasePath}[`) && elemPath.endsWith("]")
                      ? Number(elemPath.slice(tupleBasePath.length + 1, -1))
                      : undefined;
                    if (tupleIndexMatch !== undefined && !Number.isNaN(tupleIndexMatch)) {
                      projected[element.name] = tuple[tupleIndexMatch] ?? null;
                    } else {
                      projected[element.name] = evalExpr(element.expr as FreeObjectExpr, childEnv);
                    }
                  }
                }
              }
              out.push(projected);
            }
            return out;
          }
        }
        const value = evalExpr(expr.expr, env);
        let items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
        // EdgeQL paths return DISTINCT objects (by id). When the shape source
        // is a field_access path (e.g. `Issue.owner`), dedupe the items so the
        // projected shape isn't multiplied by the join's source cardinality.
        if (expr.expr.kind === "field_access"
          && items.length > 1
          && items.every((item) => item && typeof item === "object" && !Array.isArray(item)
            && typeof (item as { id?: unknown }).id === "string")) {
          const seen = new Set<string>();
          const deduped: unknown[] = [];
          for (const item of items) {
            const id = (item as { id: string }).id;
            if (seen.has(id)) continue;
            seen.add(id);
            deduped.push(item);
          }
          items = deduped;
        }
        // If the shape source is a WITH binding (e.g. `SELECT X { ... }` with
        // `WITH X := {...}`), rebind that name per row so the computed shape
        // sees the current row through the original binding name. Without this,
        // `X[IS …].name` in `foo := X[IS Priority].name ?? X[IS Status].name`
        // reads the entire binding for every row.
        const shapeBindingName = expr.expr.kind === "binding_ref" && env.has(expr.expr.name)
          ? expr.expr.name
          : undefined;
        const projectOne = (item: unknown): Record<string, unknown> => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return {};
          const row = item as Record<string, unknown>;
          const childEnv = new Map(env);
          childEnv.set("__current__", row);
          if (shapeBindingName) {
            childEnv.set(shapeBindingName, [row]);
          }
          const out: Record<string, unknown> = { ...row };
          for (const element of expr.shape) {
            if (element.kind === "field") {
              out[element.name] = row[element.name] ?? null;
            } else if (element.kind === "computed") {
              if (element.expr.kind === "field_ref") {
                out[element.name] = row[element.expr.field] ?? null;
              } else {
                const computedValue = evalExpr(element.expr as FreeObjectExpr, childEnv);
                // Single-cardinality computed properties (no `multi` prefix)
                // unwrap a singleton set produced by per-row LCP iteration
                // (e.g. `foo := X[IS T].name ?? X[IS U].name` evaluates to a
                // 1-element array per X; EdgeQL exposes it as a scalar).
                // Tuple/array values keep their array shape — they're single
                // values structurally — but a set wrapper around them is
                // still unwrapped.
                if (!element.multi && Array.isArray(computedValue) && computedValue.length <= 1) {
                  out[element.name] = computedValue.length === 0 ? null : computedValue[0];
                } else if (element.multi && !Array.isArray(computedValue)) {
                  // Explicit `multi` cardinality wraps a scalar into a singleton
                  // array (matches `assert_query_result`'s expectation).
                  out[element.name] = computedValue == null ? [] : [computedValue];
                } else {
                  out[element.name] = computedValue;
                }
              }
            } else if (element.kind === "link") {
              const linkValue = row[element.name];
              const linkItems = Array.isArray(linkValue) ? linkValue : linkValue == null ? [] : [linkValue];
              const projected = linkItems.map((linkItem) => {
                if (!linkItem || typeof linkItem !== "object" || Array.isArray(linkItem)) return null;
                const linkRow = linkItem as Record<string, unknown>;
                const inner: Record<string, unknown> = {};
                for (const innerEl of element.shape) {
                  if (innerEl.kind === "field") {
                    inner[innerEl.name] = linkRow[innerEl.name] ?? null;
                  } else if (innerEl.kind === "computed") {
                    if (innerEl.expr.kind === "field_ref") {
                      inner[innerEl.name] = linkRow[innerEl.expr.field] ?? null;
                    } else {
                      const linkChildEnv = new Map(childEnv);
                      linkChildEnv.set("__current__", linkRow);
                      inner[innerEl.name] = evalExpr(innerEl.expr as FreeObjectExpr, linkChildEnv);
                    }
                  }
                }
                return inner;
              }).filter((entry): entry is Record<string, unknown> => entry !== null);
              const wantsMulti = Array.isArray(linkValue) && linkValue.length > 1;
              out[element.name] = wantsMulti ? projected : (projected[0] ?? null);
            }
          }
          return out;
        };
        return Array.isArray(value) ? items.map(projectOne) : projectOne(value);
      }
      default:
        return undefined;
    }
  };

  // The runtime type-narrowing cases (`[IS T]` / `IS` / discriminator read /
  // polymorphic field) delegate to one home; see runtime/type_narrowing.ts.
  const typeNarrowingDeps: TypeNarrowingDeps = { evalExpr, schema, qualifyRuntimeTypeName };

  const enumOrderForRows = (rows: unknown[]): Map<string, number> | undefined => {
    if (!rows.every((item) => typeof item === "string")) {
      return undefined;
    }
    const values = rows as string[];
    for (const typeDef of schema.listTypes()) {
      const enumValues = typeDef.fields.flatMap((field) => field.enumValues ?? []);
      if (enumValues.length > 0 && values.every((value) => enumValues.includes(value))) {
        return new Map(enumValues.map((value, index) => [value, index] as const));
      }
    }
    return undefined;
  };

  const enumOrderForCast = (castType: string): Map<string, number> | undefined => {
    const typeDef = schema.getType(qualifyRuntimeTypeName(castType));
    const values = typeDef?.fields.flatMap((field) => field.enumValues ?? []) ?? [];
    return values.length > 0 ? new Map(values.map((value, index) => [value, index] as const)) : undefined;
  };

  const initialEnv = new Map<string, unknown>();
  const evalWithBindingValue = (value: WithBindingValue, env: EvalEnv): unknown => {
    switch (value.kind) {
      case "literal":
        return value.value;
      case "set_literal":
      case "array_literal":
        return [...value.values];
      case "binding_ref":
        return evalExpr({ kind: "binding_ref", name: value.name }, env);
      case "parameter":
        return context.globals?.[value.name] ?? null;
      case "subquery":
        return evalExpr({ kind: "select", typeName: value.query.typeName, shape: value.query.shape, clauses: value.query.clauses }, env);
      case "subquery_statement":
        return executeMutationBinding(db, schema, value.statement, context);
      case "subquery_expr": {
        let innerSelectExpr: FreeObjectExpr = value.expr;
        while (innerSelectExpr.kind === "select_expr_subquery") {
          innerSelectExpr = innerSelectExpr.expr;
        }
        if (innerSelectExpr.kind === "select") {
          const projected = evalExpr(value.expr, env);
          const base = evalExpr({
            ...innerSelectExpr,
            shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
          }, env);
          const baseItems = Array.isArray(base) ? base : base === null || base === undefined ? [] : [base];
          const projectedItems = Array.isArray(projected) ? projected : projected === null || projected === undefined ? [] : [projected];
          return projectedItems.map((item, index) => {
            const baseItem = baseItems[index];
            return baseItem && typeof baseItem === "object" && !Array.isArray(baseItem)
              && item && typeof item === "object" && !Array.isArray(item)
              ? { ...(baseItem as Record<string, unknown>), ...(item as Record<string, unknown>) }
              : item;
          });
        }
        if (value.expr.kind === "shape_projection") {
          const base = evalExpr(value.expr.expr, env);
          const projected = evalExpr(value.expr, env);
          const baseItems = Array.isArray(base) ? base : base === null || base === undefined ? [] : [base];
          const projectedItems = Array.isArray(projected) ? projected : projected === null || projected === undefined ? [] : [projected];
          return projectedItems.map((item, index) => {
            const baseItem = baseItems[index];
            return baseItem && typeof baseItem === "object" && !Array.isArray(baseItem)
              && item && typeof item === "object" && !Array.isArray(item)
              ? { ...(baseItem as Record<string, unknown>), ...(item as Record<string, unknown>) }
              : item;
          });
        }
        return evalExpr(value.expr, env);
      }
      case "enum_path":
        return value.member;
      case "path":
        return evalExpr({ kind: "path", head: value.head, tail: value.tail, steps: value.steps }, env);
      case "path_chain":
        return evalExpr({ kind: "path_chain", parts: value.parts, steps: value.steps }, env);
      case "backlink_path":
        return evalExpr({ kind: "backlink_path", link: value.link, sourceType: value.sourceType, sourceTypeExpr: value.sourceTypeExpr }, env);
    }
  };
  for (const binding of ast.with ?? []) {
    initialEnv.set(binding.name, evalWithBindingValue(binding.value, initialEnv));
  }

  const value = evalExpr(ast.expr, initialEnv);
  if (value === undefined) {
    return undefined;
  }
  const projectToShape = (item: unknown, shape: ShapeElement[]): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const element of shape) {
      if ("name" in element) {
        out[element.name] = row[element.name] ?? null;
      }
    }
    return out;
  };
  const finalShape = ast.expr.kind === "shape_projection"
    ? ast.expr.shape
    : ast.expr.kind === "select_expr_subquery" && ast.expr.expr.kind === "shape_projection"
      ? ast.expr.expr.shape
      : undefined;
  const currentBinding = ast.expr.kind === "binding_ref"
    ? ast.expr.name
    : ast.expr.kind === "select_expr_subquery" && ast.expr.alias
      ? ast.expr.alias
      : undefined;
  const topIsArrayAgg = ast.expr.kind === "function_call"
    && ((ast.expr.call.name.includes("::") ? ast.expr.call.name.split("::").at(-1) : ast.expr.call.name)?.toLowerCase() === "array_agg");
  const rows = Array.isArray(value) ? (topIsArrayAgg ? [value] : value) : [value];
  if (ast.orderBy) {
    type OrderKey = { expr: FreeObjectExpr; direction: number; enumOrder?: Map<string, number> };
    const orderKeys: OrderKey[] = [];
    let cursor: typeof ast.orderBy | undefined = ast.orderBy;
    while (cursor) {
      orderKeys.push({
        expr: cursor.expr,
        direction: cursor.direction === "desc" ? -1 : 1,
        enumOrder: cursor.expr.kind === "cast"
          ? enumOrderForCast(cursor.expr.castType)
          : cursor.expr.kind === "binding_ref"
            ? enumOrderForRows(rows)
            : undefined,
      });
      cursor = cursor.then;
    }

    rows.sort((a, b) => {
      const leftEnv = new Map(initialEnv);
      const rightEnv = new Map(initialEnv);
      if (currentBinding) {
        leftEnv.set(currentBinding, a);
        rightEnv.set(currentBinding, b);
      }
      leftEnv.set("__current__", a as Record<string, unknown>);
      rightEnv.set("__current__", b as Record<string, unknown>);
      for (const key of orderKeys) {
        const tupleBindingIndex = key.expr.kind === "binding_ref"
          && ast.expr.kind === "tuple"
          && ast.expr.values[0]?.kind === "binding_ref"
          && ast.expr.values[0].name === key.expr.name
          ? 0
          : undefined;
        const left = tupleBindingIndex !== undefined && Array.isArray(a) ? a[tupleBindingIndex] : evalExpr(key.expr, leftEnv);
        const right = tupleBindingIndex !== undefined && Array.isArray(b) ? b[tupleBindingIndex] : evalExpr(key.expr, rightEnv);
        const leftEnumIndex = typeof left === "string" ? key.enumOrder?.get(left) : undefined;
        const rightEnumIndex = typeof right === "string" ? key.enumOrder?.get(right) : undefined;
        if (leftEnumIndex !== undefined && rightEnumIndex !== undefined && leftEnumIndex !== rightEnumIndex) {
          return (leftEnumIndex < rightEnumIndex ? -1 : 1) * key.direction;
        }
        if (typeof left === "number" && typeof right === "number") {
          if (left !== right) {
            return (left < right ? -1 : 1) * key.direction;
          }
          continue;
        }
        const cmp = String(left ?? "").localeCompare(String(right ?? ""));
        if (cmp !== 0) {
          return cmp * key.direction;
        }
      }
      return 0;
    });
  }
  const finalRows = finalShape ? rows.map((row) => projectToShape(row, finalShape)) : rows;
  return {
    kind: "select",
    rows: finalRows,
  };
};
