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
  // KNOWN LIMITATION on D1/DO: native `round` rounds half AWAY from zero;
  // Gel's default is banker's rounding (half to even). Results differ on exact
  // .5 cases. Accepted as SQLite-native behaviour (see KNOWN_LIMITATIONS.md).
  "std::round": (a) => (a[0] ? (a[1] ? `round(${a[0]}, ${a[1]})` : `round(${a[0]})`) : null),
};

// Native datetime-part extraction via `strftime`, for D1/DO. The unit may be
// any SQL expression (literal or dynamic), so we branch with a CASE. KNOWN
// LIMITATION on D1/DO: sub-second units are millisecond-precision (SQLite
// `strftime('%f')`), not Gel's microsecond; and an out-of-range unit yields
// NULL rather than raising. The better-sqlite3 target keeps `_gel_*` for exact
// semantics. See KNOWN_LIMITATIONS.md.
// The CASE references the datetime and unit many times; binding them once in a
// subquery (`u.dt`, `u.un`) keeps each compiled arg — which may be a `?` param
// — appearing exactly once in the emitted SQL, so the parameter count stays
// correct.
const nativeDatetimePart = (dt: string, unit: string): string =>
  `(SELECT (CASE lower(u.un)` +
  ` WHEN 'year' THEN CAST(strftime('%Y',u.dt) AS INTEGER)` +
  ` WHEN 'month' THEN CAST(strftime('%m',u.dt) AS INTEGER)` +
  ` WHEN 'day' THEN CAST(strftime('%d',u.dt) AS INTEGER)` +
  ` WHEN 'hour' THEN CAST(strftime('%H',u.dt) AS INTEGER)` +
  ` WHEN 'minute' THEN CAST(strftime('%M',u.dt) AS INTEGER)` +
  ` WHEN 'minutes' THEN CAST(strftime('%M',u.dt) AS INTEGER)` +
  ` WHEN 'second' THEN CAST(strftime('%f',u.dt) AS REAL)` +
  ` WHEN 'seconds' THEN CAST(strftime('%f',u.dt) AS REAL)` +
  ` WHEN 'milliseconds' THEN CAST(strftime('%f',u.dt) AS REAL)*1000` +
  ` WHEN 'microseconds' THEN CAST(strftime('%f',u.dt) AS REAL)*1000000` +
  ` WHEN 'quarter' THEN (CAST(strftime('%m',u.dt) AS INTEGER)+2)/3` +
  ` WHEN 'dow' THEN CAST(strftime('%w',u.dt) AS INTEGER)` +
  ` WHEN 'isodow' THEN (CASE strftime('%w',u.dt) WHEN '0' THEN 7 ELSE CAST(strftime('%w',u.dt) AS INTEGER) END)` +
  ` WHEN 'doy' THEN CAST(strftime('%j',u.dt) AS INTEGER)` +
  ` WHEN 'decade' THEN CAST(strftime('%Y',u.dt) AS INTEGER)/10` +
  ` WHEN 'century' THEN (CAST(strftime('%Y',u.dt) AS INTEGER)+99)/100` +
  ` WHEN 'millennium' THEN (CAST(strftime('%Y',u.dt) AS INTEGER)+999)/1000` +
  ` WHEN 'epochseconds' THEN CAST(strftime('%s',u.dt) AS REAL)` +
  ` END) FROM (SELECT ${dt} AS dt, ${unit} AS un) AS u)`;

// Datetime/date/time part extractors share the strftime CASE (extra units for
// a given type simply never match a valid query's unit). Truncation and the
// duration accessors are NOT yet lowered natively (date-string round-trip /
// interval semantics) — they stay `_gel_*`, i.e. unsupported on D1/DO for now.
const NATIVE_DATETIME_FOR_RESTRICTED_TARGET: Record<string, (a: string[]) => string | null> = {
  "std::datetime_get": (a) => (a[0] && a[1] ? nativeDatetimePart(a[0], a[1]) : null),
  "cal::date_get": (a) => (a[0] && a[1] ? nativeDatetimePart(a[0], a[1]) : null),
  "cal::time_get": (a) => (a[0] && a[1] ? nativeDatetimePart(a[0], a[1]) : null),
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
    // On custom-function-less targets, prefer the native SQLite form (math,
    // datetime extractors) over the `_gel_*` template so the query runs at all.
    if (targetForbidsCustomFunctions(target)) {
      const native =
        NATIVE_MATH_FOR_RESTRICTED_TARGET[candidate]?.(args) ??
        NATIVE_DATETIME_FOR_RESTRICTED_TARGET[candidate]?.(args);
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
