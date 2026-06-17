// AST inference — facts inferred purely from the shape of an EdgeQL AST
// fragment, with no schema, no security context, and no throwing. The AST
// pre-validation cluster in `engine.ts` (`preValidateStatementAst` and its
// `check*` helpers) mixed these value-returning inferers in with the throwing
// validators, so the inferers could only be exercised by feeding a full
// statement to the validator and watching it (not) throw. Collected here behind
// their own small interfaces, each is directly unit-testable: an AST fragment
// in, a type/cardinality/shape fact out. The ctx-bound inferers
// (`unionBranchInfo`, `scalarPathProperty`, …) stay in `engine.ts` — they
// depend on the `AstPreValidationCtx` (schema + bindings + lookups), which is
// the validator's own context. See docs/adr/0038.
import type { ScalarValue } from "../types.js";
import type { ShapeElement, WithBindingValue } from "../edgeql/ast.js";

export type InferredAssignType =
  | { kind: "indeterminate" }   // bare `[]` — no element type
  | { kind: "array"; element: string }  // `array<element>`
  | { kind: "scalar"; name: string }    // a plain scalar
  | undefined;                  // not inferable / not relevant

// Std scalar name for a literal node based on its runtime JS value.
const literalScalarName = (node: Record<string, unknown>): string | undefined => {
  const v = node.value;
  if (typeof v === "string") return "std::str";
  if (typeof v === "boolean") return "std::bool";
  if (typeof v === "number") {
    return node.numericKind === "float" ? "std::float64" : "std::int64";
  }
  return undefined;
};

// Element scalar name of an array literal's first element.
const inferArrayElementType = (el: unknown, depth: number): string | undefined => {
  if (!el || typeof el !== "object") return undefined;
  const node = el as Record<string, unknown> & { kind?: string };
  if (node.kind === "literal") return literalScalarName(node);
  if (node.kind === "expr") return inferArrayElementType(node.expr, depth + 1);
  return undefined;
};

// Infer the type produced by a (subset of) INSERT-shape value expressions:
// empty/non-empty array literals, `++` concatenations of arrays, and
// `array_unpack(...)`. Returns undefined when not one of these forms.
export const inferArrayValuedType = (value: unknown, depth = 0): InferredAssignType => {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const node = value as Record<string, unknown> & { kind?: string };
  switch (node.kind) {
    case "expr":
      return inferArrayValuedType(node.expr, depth + 1);
    case "array_literal":
    case "array_literal_expr": {
      const els = (node.values as unknown[] | undefined) ?? [];
      if (els.length === 0) return { kind: "indeterminate" };
      const elType = inferArrayElementType(els[0], depth + 1);
      return elType ? { kind: "array", element: elType } : undefined;
    }
    case "concat": {
      // `A ++ B` of arrays: element type comes from a non-empty operand.
      const parts = (node.parts as unknown[] | undefined) ?? [];
      let element: string | undefined;
      let sawArray = false;
      for (const part of parts) {
        const inferred = inferArrayValuedType(part, depth + 1);
        if (!inferred) return undefined;
        if (inferred.kind === "array") {
          sawArray = true;
          element = element ?? inferred.element;
        } else if (inferred.kind === "indeterminate") {
          sawArray = true;
        } else {
          return undefined;
        }
      }
      if (!sawArray) return undefined;
      return element ? { kind: "array", element } : { kind: "indeterminate" };
    }
    case "function_call": {
      const call = (node.call ?? node) as { name?: string; args?: unknown[] };
      if (call.name === "array_unpack" && (call.args?.length ?? 0) === 1) {
        const inner = inferArrayValuedType(call.args?.[0], depth + 1);
        if (inner?.kind === "array") return { kind: "scalar", name: inner.element };
        if (inner?.kind === "indeterminate") return { kind: "indeterminate" };
      }
      return undefined;
    }
    default:
      return undefined;
  }
};

// Std scalar name for a literal carrying an explicit value + numeric kind hint.
export const literalStdTypeName = (literal: { value: ScalarValue; numericKind?: string }): string | undefined => {
  const { value, numericKind } = literal;
  if (typeof value === "string") return "std::str";
  if (typeof value === "boolean") return "std::bool";
  if (typeof value === "number") {
    if (numericKind === "float" || !Number.isInteger(value)) return "std::float64";
    return "std::int64";
  }
  return undefined;
};

// True when a computed body provably yields more than one element.
export const computedExprIsMulti = (expr: unknown, depth = 0): boolean => {
  if (!expr || typeof expr !== "object" || depth > 6) return false;
  const node = expr as Record<string, unknown> & { kind?: string };
  if (node.kind === "set_literal") return ((node.values as unknown[]) ?? []).length > 1;
  if (node.kind === "set_expr") return ((node.values as unknown[]) ?? []).length > 1;
  if (node.kind === "select_expr" || node.kind === "select_expr_subquery" || node.kind === "subquery_expr") {
    return computedExprIsMulti(node.expr, depth + 1);
  }
  return false;
};

// The single field a computed element references (`foo := .bar` → "bar"),
// peeling select/subquery wrappers and `.field` off the current row.
export const computedElementReferencedField = (expr: unknown, depth = 0): string | undefined => {
  if (!expr || typeof expr !== "object" || depth > 4) return undefined;
  const node = expr as Record<string, unknown> & { kind?: string };
  if (node.kind === "field_ref") return node.field as string;
  if (node.kind === "select_expr" || node.kind === "select_expr_subquery") {
    return computedElementReferencedField(node.expr, depth + 1);
  }
  if (node.kind === "field_access") {
    const base = node.expr as Record<string, unknown> & { kind?: string };
    if (base?.kind === "current_item") return node.field as string;
  }
  return undefined;
};

// Peel `select_expr_subquery` / `subquery_expr` wrappers to reach the inner expr.
export const unwrapSubqueryWrappers = (expr: unknown): unknown => {
  let current = expr as Record<string, unknown> & { kind?: string };
  let guard = 0;
  while (current && typeof current === "object" && guard < 8) {
    if (current.kind === "select_expr_subquery" || current.kind === "subquery_expr") {
      current = current.expr as Record<string, unknown> & { kind?: string };
      guard += 1;
      continue;
    }
    break;
  }
  return current;
};

// The SELECT shape a WITH binding projects, across the binding's value forms.
export const bindingSelectShape = (binding: WithBindingValue | undefined): ShapeElement[] | undefined => {
  if (!binding) return undefined;
  if (binding.kind === "subquery") return binding.query.shape;
  if (binding.kind === "subquery_expr") {
    const inner = unwrapSubqueryWrappers(binding.expr) as Record<string, unknown> & { kind?: string };
    if (inner?.kind === "select") return inner.shape as ShapeElement[];
    return undefined;
  }
  if (binding.kind === "subquery_statement" && binding.statement.kind === "select") {
    return binding.statement.shape;
  }
  return undefined;
};

// True when an INSERT shape value references a partial path (`.field` /
// current-item) that is NOT scoped inside a nested query — such a reference
// resolves against the INSERT shape and is illegal. Does not descend into
// nested query/DML scopes, whose partial paths resolve against their own subject.
export const insertValueHasUnscopedPartialPath = (value: unknown, depth = 0): boolean => {
  if (!value || typeof value !== "object" || depth > 12) return false;
  if (Array.isArray(value)) {
    return value.some((item) => insertValueHasUnscopedPartialPath(item, depth + 1));
  }
  const node = value as Record<string, unknown> & { kind?: string };
  if (node.kind === "current_item") return true;
  // Don't descend into nested query scopes — a partial path inside them
  // resolves against that scope's subject, not the INSERT shape.
  if (node.kind === "select" || node.kind === "select_expr" || node.kind === "select_expr_subquery"
      || node.kind === "subquery_expr" || node.kind === "subquery_statement"
      || node.kind === "for" || node.kind === "insert" || node.kind === "update" || node.kind === "delete") {
    return false;
  }
  return Object.values(node).some((v) => insertValueHasUnscopedPartialPath(v, depth + 1));
};
