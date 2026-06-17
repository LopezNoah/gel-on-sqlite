// EdgeQL co-iteration detection for the Runtime evaluator. When both operands
// of a binary expression walk the *same* set-valued WITH binding (e.g.
// `WITH x := {1,2,3} SELECT x * x`, or `I.time_estimate ?!= I.time_spent.spent`
// over a row set `I`), the two references must iterate in lockstep — `x * x`
// yields {1,4,9}, not the 9-element Cartesian product. The `math` and `compare`
// cases of the evaluator each detected this the same way (`findBindingRoot` on
// both sides, then "same root + bound to an array"); the detection now lives
// here once. The per-row body still differs (math applies the operator and
// binds the scalar row; compare does LCP `?=`/`?!=` and binds `[row]`), so only
// the detection is shared — see docs/adr/0014.
import type { ComputedExpr, FreeObjectExpr } from "../edgeql/ast.js";

// The root WITH-binding name a path expression walks, if any: `x` → "x",
// `x.a.b` → "x", `<int64>x[0]` → "x". Null when the expression is not rooted in
// a binding reference.
export const findBindingRoot = (e: FreeObjectExpr | ComputedExpr): string | null => {
  if (!e || typeof e !== "object") return null;
  if (e.kind === "binding_ref") return e.name;
  if (e.kind === "field_access") return findBindingRoot(e.expr);
  if (e.kind === "index_access") return findBindingRoot(e.expr);
  if (e.kind === "cast") return findBindingRoot(e.expr);
  return null;
};

// When `left` and `right` both walk the same binding and that binding is
// currently bound to a set (array) in `env`, return its name and the row set so
// the caller can iterate the operands per row. Null otherwise (the caller then
// evaluates each side independently and takes the Cartesian product).
export const coIteratedBinding = (
  left: FreeObjectExpr | ComputedExpr,
  right: FreeObjectExpr | ComputedExpr,
  env: Map<string, unknown>,
): { root: string; rows: unknown[] } | null => {
  const leftRoot = findBindingRoot(left);
  const rightRoot = findBindingRoot(right);
  if (leftRoot && leftRoot === rightRoot && env.has(leftRoot)) {
    const bound = env.get(leftRoot);
    if (Array.isArray(bound)) return { root: leftRoot, rows: bound };
  }
  return null;
};
