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
    const template = getStdlibSqlTemplate(candidate);
    if (template) {
      const result = template(args, argTypes);
      if (result) return result;
    }
  }
  return null;
};
