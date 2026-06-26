// Strangler bridge for the qlast migration: convert the bespoke ast.ts
// path-shaped expressions into Gel-faithful `qlast.Path` nodes, so the
// qlast-consuming compiler (`compilePathQlast`) can run on real parser output
// without first rewriting the parser. This encodes the mapping the parser will
// eventually emit natively.
//
// SCOPE (this slice): the Expr-shaped path forms the parser produces —
//   - `select`        bare type root (`Movie`, with the implicit `{id}` shape)
//   - `field_access`  dotted access chains (`Movie.reviews.body`)
//   - `path` / `path_chain` / `path_steps`  binding-rooted + intersection forms
//   - `binding_ref`   a WITH/FOR name used as a path root
// Forms not yet bridged return `null` (caller falls back to the live compiler):
// `backlink_path`, link-property `@` access, and the FilterExpr DSL (`.name` in
// a FILTER, which isn't an Expr at all). Each is a tracked migration frontier —
// see tests/qlast_path_parity.test.ts.

import type {
  FreeObjectExpr,
  PathStep as AstPathStep,
  TypeExpr as AstTypeExpr,
} from "../edgeql/ast.js";
import type {
  ObjectRef,
  Path,
  Ptr,
  Splat,
  TypeExpr as QlTypeExpr,
  TypeIntersection,
  TypeName,
} from "../edgeql/qlast.js";

// `Path.steps` is typed `(Expr | Ptr | TypeIntersection | ObjectRef | Splat)[]`
// (the first element can be an arbitrary Expr). We only ever emit the non-Expr
// step kinds, but align to the full element type so spreads stay assignable.
type QlPathStep = Path["steps"][number];

// Typed node-builders — keep each `__kind__` a literal (not widened to string)
// and produce exactly-typed nodes assignable to QlPathStep.
const mkObjectRef = (name: string): ObjectRef => ({ __kind__: "ObjectRef", name });
const mkPtr = (name: string, direction?: string): Ptr => ({
  __kind__: "Ptr",
  name,
  ...(direction ? { direction } : {}),
});
const mkTypeIntersection = (type: QlTypeExpr): TypeIntersection => ({ __kind__: "TypeIntersection", type });
const mkSplat = (depth: number): Splat => ({ __kind__: "Splat", depth });

const qlTypeName = (name: string): TypeName => ({ __kind__: "TypeName", maintype: mkObjectRef(name) });

// The path slice only needs the simple `type_name` case for `[IS T]`; type
// unions/intersections inside an intersection step are rare and deferred.
const astTypeExprToQl = (typeExpr: AstTypeExpr | undefined, fallbackName: string): QlTypeExpr =>
  typeExpr && typeExpr.kind === "type_name" ? qlTypeName(typeExpr.name) : qlTypeName(fallbackName);

const pathStepToQl = (step: AstPathStep): QlPathStep[] => {
  switch (step.kind) {
    case "object_ref":
      return [mkObjectRef(step.name)];
    case "ptr": {
      const ptr = mkPtr(step.name, step.direction);
      // ast.ts folds `.foo[IS T]` onto the ptr step via typeFilter/typeFilterExpr;
      // qlast splits it into a Ptr followed by a TypeIntersection.
      if (step.typeFilter || step.typeFilterExpr) {
        return [ptr, mkTypeIntersection(astTypeExprToQl(step.typeFilterExpr, step.typeFilter ?? ""))];
      }
      return [ptr];
    }
    case "type_intersection":
      return [mkTypeIntersection(astTypeExprToQl(step.typeExpr, step.typeName))];
    case "splat":
      return [mkSplat(step.depth)];
  }
};

const pathStepsToQl = (steps: AstPathStep[]): QlPathStep[] => steps.flatMap(pathStepToQl);

const mkPath = (steps: QlPathStep[], partial: boolean): Path => ({
  __kind__: "Path",
  steps,
  partial,
  allow_factoring: false,
});

// Real (non-meta) clause keys whose presence makes a `select` a query, not a
// bare type-root path. `_withModule`/`_withModuleAliases` are parser bookkeeping
// and don't count; `_withBindings` (an actual WITH) does.
const REAL_CLAUSE_KEYS = [
  "filter",
  "orderBy",
  "limit",
  "offset",
  "limitExpr",
  "offsetExpr",
  "groupBy",
  "using",
  "window",
  "_withBindings",
] as const;

const isBareTypeSelect = (sel: Extract<FreeObjectExpr, { kind: "select" }>): boolean => {
  const clauses = sel.clauses ?? ({} as Record<string, unknown>);
  const hasClauses = REAL_CLAUSE_KEYS.some((key) => (clauses as Record<string, unknown>)[key] !== undefined);
  // The parser attaches an implicit `{ id }` element (origin "default") to a
  // bare type reference; any non-default element means a real projection.
  const hasExplicitShape = (sel.shape ?? []).some((el) => el.origin !== "default");
  return !hasClauses && !hasExplicitShape && !sel.detached;
};

const stepsArePartial = (steps: AstPathStep[]): boolean => steps[0]?.kind !== "object_ref";

/**
 * Convert an ast.ts path-shaped expression to a qlast `Path`, or `null` if the
 * expression is not a (yet-bridged) pure path. Recursive over `field_access`.
 */
export const astPathExprToQlast = (expr: FreeObjectExpr): Path | null => {
  switch (expr.kind) {
    case "path_steps":
      return mkPath(pathStepsToQl(expr.steps), expr.partial ?? stepsArePartial(expr.steps));

    case "path":
      if (expr.steps?.length) return mkPath(pathStepsToQl(expr.steps), stepsArePartial(expr.steps));
      // head/tail fallback: head is a binding/type root, tail a single pointer.
      return mkPath([mkObjectRef(expr.head), mkPtr(expr.tail)], false);

    case "path_chain": {
      if (expr.steps?.length) return mkPath(pathStepsToQl(expr.steps), stepsArePartial(expr.steps));
      const [head, ...rest] = expr.parts;
      if (!head) return null;
      return mkPath([mkObjectRef(head), ...rest.map((part) => mkPtr(part))], false);
    }

    case "field_access": {
      // Link-property access (`@prop`) is a deferred subsystem in compilePathQlast.
      if (expr.field.startsWith("@")) return null;
      const base = astPathExprToQlast(expr.expr);
      if (!base) return null;
      return mkPath([...base.steps, mkPtr(expr.field)], base.partial);
    }

    case "select":
      return isBareTypeSelect(expr) ? mkPath([mkObjectRef(expr.typeName)], false) : null;

    case "binding_ref":
      return mkPath([mkObjectRef(expr.name)], false);

    default:
      return null;
  }
};
