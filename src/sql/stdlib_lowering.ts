import type { RuntimeTarget } from "../runtime/target.js";
import { getStdlibSqlTemplate, stdlibFunctionLowersToSql } from "../stdlib/registry.js";

export type { StdlibSqlTemplate } from "../stdlib/registry.js";

// A stdlib function is SQL-lowerable iff the registry gives it a SQL slot.
// This replaced the old triple of `BASE_SQL_NATIVE_STDLIB_LOWERING` (a name-set
// gate in runtime/target.ts), `UNREGISTERED_BUT_SUPPORTED` (a patch-set for the
// templates that gate forgot), and the template map itself. The `target`
// parameter is retained: both supported targets (sqlite, d1) currently expose
// the same SQL-lowerable set, so lowerability is target-independent today, but
// the gate stays target-shaped for when that diverges. See `docs/adr/0043`.
export const canLowerStdlibFunctionSql = (_target: RuntimeTarget, functionName: string): boolean =>
  stdlibFunctionLowersToSql(functionName);

// Math functions whose default `_gel_*` lowering exists ONLY to enforce Gel's
// domain-error semantics (throw on out-of-range / non-finite input). On targets
// that cannot register custom functions — Cloudflare D1 and Durable Objects SQL
// — we emit the native SQLite math function instead. These are in every modern
// SQLite (the same math extension that backs the native `abs`/`ceil`/`atan`
// lowerings, and D1's allowed-function list). The result is identical for valid
// inputs; SQLite yields NULL where Gel would throw a domain error — an accepted
// difference on these backends, in exchange for the function working at all
// (otherwise the query fails with "no such function: _gel_*"). The default
// (better-sqlite3) target keeps the `_gel_*` form for exact conformance.
//
// SQLite arg conventions (verified): `log(X)` is base-10, `log(B, X)` is base-B
// — so `math::lg(x)` → `log(x)` and `math::log(x, base)` → `log(base, x)`.
const NATIVE_MATH_FOR_RESTRICTED_TARGET: Record<string, (a: string[]) => string | null> = {
  "math::sin": (a) => (a[0] ? `sin(${a[0]})` : null),
  "math::cos": (a) => (a[0] ? `cos(${a[0]})` : null),
  "math::tan": (a) => (a[0] ? `tan(${a[0]})` : null),
  "math::cot": (a) => (a[0] ? `(1.0 / tan(${a[0]}))` : null),
  "math::asin": (a) => (a[0] ? `asin(${a[0]})` : null),
  "math::acos": (a) => (a[0] ? `acos(${a[0]})` : null),
  "math::ln": (a) => (a[0] ? `ln(${a[0]})` : null),
  "math::lg": (a) => (a[0] ? `log(${a[0]})` : null),
  "math::log": (a) => (a[0] && a[1] ? `log(${a[1]}, ${a[0]})` : null),
  "math::exp": (a) => (a[0] ? `exp(${a[0]})` : null),
  "math::sqrt": (a) => (a[0] ? `sqrt(${a[0]})` : null),
};

// D1 and Durable Objects share the no-custom-functions constraint; the DO sync
// adapter reports its target as "d1" for exactly this reason.
const targetForbidsCustomFunctions = (target: RuntimeTarget): boolean => target === "d1";

export const lowerStdlibFunctionSql = (
  target: RuntimeTarget,
  functionName: string,
  args: string[],
  argTypes?: (string | undefined)[],
): string | null => {
  // Unqualified names (e.g. `len`, `count`) reach us when the AST→IR
  // pass doesn't qualify the function. Try the standard module prefixes
  // before giving up — matches tryResolveStdlibFunction in stdlib/registry.
  const candidates = functionName.includes("::")
    ? [functionName]
    : [`std::${functionName}`, `math::${functionName}`, `cal::${functionName}`];
  for (const candidate of candidates) {
    if (!canLowerStdlibFunctionSql(target, candidate)) continue;
    // On custom-function-less targets, prefer the native math form over the
    // `_gel_*` template so the query runs at all.
    if (targetForbidsCustomFunctions(target)) {
      const native = NATIVE_MATH_FOR_RESTRICTED_TARGET[candidate]?.(args);
      if (native) return native;
    }
    const template = getStdlibSqlTemplate(candidate);
    if (template) {
      const result = template(args, argTypes);
      if (result) return result;
    }
  }
  return null;
};
