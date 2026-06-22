import { AppError } from "../errors.js";
import type { ScalarValue } from "../types.js";

// ── The single home for the standard library ──────────────────────────────
//
// Each stdlib function is described once, here, by a `StdlibFunctionEntry`
// carrying up to three slots:
//
//   • `meta`    — arity / volatility / cardinality facts (read by name
//                 resolution and the inference passes)
//   • `sql`     — the SQL-lowering adapter (read by the SQL compiler)
//   • `runtime` — the interpreter adapter (read by the Runtime evaluator)
//
// Before this module the three lived apart: metadata in `stdlib/functions.ts`,
// SQL templates in `sql/stdlib_lowering.ts`, runtime cases in a switch, and a
// *fourth* name-set gate in `runtime/target.ts`. They were hand-synced and
// drifted (the gate forgot functions that had templates, so a patch-set was
// bolted on). Now a function exists in exactly one place and its
// SQL-lowerability *is* the presence of a `sql` slot. See `docs/adr/0043`.

export type RuntimeFunctionArg =
  | ScalarValue
  | {
      kind: "set";
      values: ScalarValue[];
    }
  | {
      kind: "array";
      values: ScalarValue[];
    };

export type StdlibVolatility = "immutable" | "stable" | "volatile";

/** The arity / inference metadata for a stdlib function. */
export interface StdlibFunctionDef {
  name: string;
  minArgs: number;
  maxArgs: number;
  /** Defaults to "immutable" when omitted. */
  volatility?: StdlibVolatility;
  /** True when the function can return an empty set even with non-empty
   * input (e.g. `array_get`, `to_json`, `assert`). Used by cardinality
   * inference to lower the return cardinality bound to at_most_one. */
  returnOptional?: boolean;
  /** Per-parameter SET OF flag (true ⇒ the arg's set is collapsed to a
   * single invocation, like aggregates). Length matches max-arity; trailing
   * entries default to false. */
  paramSetOf?: boolean[];
}

/** The SQL-lowering adapter: produces the SQL fragment for a call, or null
 * when the arguments aren't lowerable as given. */
export type StdlibSqlTemplate = (args: string[], argTypes?: (string | undefined)[]) => string | null;

/** The interpreter adapter: evaluates a call over already-evaluated args. */
export type StdlibRuntimeImpl = (args: RuntimeFunctionArg[]) => unknown;

/** One stdlib function, described once. `meta` omits `name` (the entry's
 * `name` is authoritative); resolution stitches them back together. */
export interface StdlibFunctionEntry {
  name: string;
  meta?: Omit<StdlibFunctionDef, "name">;
  sql?: StdlibSqlTemplate;
  runtime?: StdlibRuntimeImpl;
}

// ── Runtime helpers (shared by the `runtime` slots) ───────────────────────

const extractScalar = (arg: RuntimeFunctionArg): ScalarValue | null => {
  if (typeof arg === "object" && arg !== null && "kind" in arg) {
    return arg.values[0] ?? null;
  }
  return arg;
};

const toNumber = (arg: RuntimeFunctionArg): number => {
  const scalar = extractScalar(arg);
  const number = Number(scalar);
  return Number.isFinite(number) ? number : 0;
};

const toNumberList = (arg: RuntimeFunctionArg): number[] => {
  if (typeof arg === "object" && arg !== null && "kind" in arg) {
    return arg.values.map((value) => toNumber(value));
  }
  return [toNumber(arg)];
};

const toStringList = (arg: RuntimeFunctionArg): string[] => {
  if (typeof arg === "object" && arg !== null && "kind" in arg) {
    return arg.values.map((value) => String(value ?? ""));
  }
  return [String(arg ?? "")];
};

const unaryNumeric = (arg: RuntimeFunctionArg, fn: (value: number) => number): number | number[] => {
  if (typeof arg === "object" && arg !== null && "kind" in arg && arg.kind === "set") {
    return arg.values.map((value) => fn(toNumber(value)));
  }
  return fn(toNumber(arg));
};

const variance = (values: number[], sample: boolean): number | null => {
  if (values.length === 0) {
    return null;
  }
  if (sample && values.length < 2) {
    return null;
  }

  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const numerator = values.reduce((acc, value) => acc + (value - mean) * (value - mean), 0);
  const denominator = sample ? values.length - 1 : values.length;
  return numerator / denominator;
};

const stddev = (values: number[], sample: boolean): number | null => {
  const varValue = variance(values, sample);
  if (varValue === null) {
    return null;
  }
  return Math.sqrt(varValue);
};

// EdgeQL regex flags are embedded as `(?xyz)` at the start of the pattern.
// JS regex doesn't understand most of these inline groups, so strip them and
// map known flags (i, m, s, x) into JS flags. Unknown flags are dropped.
//
// LEGITIMATE REGEX (do not remove): the EdgeQL std `re_test` / `re_match` /
// `re_replace` builtins ARE regular-expression operations by definition. This
// helper and the `new RegExp(...)` calls below implement those runtime
// functions over user-supplied patterns — they are not parsing IR/type
// structure out of a string.
const parseEdgeQLRegex = (pattern: string): { source: string; flags: string } => {
  const match = /^\(\?([a-zA-Z]+)\)(.*)$/s.exec(pattern);
  if (!match) return { source: pattern, flags: "" };
  const flagChars = match[1];
  let jsFlags = "";
  if (flagChars.includes("i")) jsFlags += "i";
  if (flagChars.includes("m")) jsFlags += "m";
  if (flagChars.includes("s")) jsFlags += "s";
  return { source: match[2], flags: jsFlags };
};

// LEGITIMATE REGEX (do not remove): the helpers below validate and decode
// runtime scalar *values* — ISO-8601 datetime/date/time and ISO-8601 duration
// strings. Regex on a value's textual representation is the correct tool here;
// these are temporal data formats, not IR/type structure being re-parsed.
const parseDateTime = (arg: RuntimeFunctionArg): string => {
  const scalar = extractScalar(arg);
  const date = new Date(String(scalar ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw new AppError("E_VALIDATION", "Invalid datetime input");
  }
  return date.toISOString();
};

const parseLocalDateTime = (value: ScalarValue | null): string => {
  const text = String(value ?? "");
  if (!isValidLocalDateTime(text)) {
    throw new AppError("E_VALIDATION", "Invalid local_datetime input");
  }
  return text;
};

const parseLocalDate = (value: ScalarValue | null): string => {
  const text = String(value ?? "");
  if (!isValidLocalDate(text)) {
    throw new AppError("E_VALIDATION", "Invalid local_date input");
  }
  return text;
};

const parseLocalTime = (value: ScalarValue | null): string => {
  const text = String(value ?? "");
  if (!isValidLocalTime(text)) {
    throw new AppError("E_VALIDATION", "Invalid local_time input");
  }
  return text;
};

const parseDuration = (value: ScalarValue | null): string => {
  const text = String(value ?? "");
  if (!/^[-+]?P/.test(text)) {
    throw new AppError("E_VALIDATION", "Invalid duration input");
  }
  return text;
};

const parseDateComponents = (value: string): { year: number; month: number; day: number } => {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) {
    throw new AppError("E_VALIDATION", "Invalid local_date input");
  }
  return {
    year: Number(matched[1]),
    month: Number(matched[2]),
    day: Number(matched[3]),
  };
};

const parseTimeComponents = (value: string): { hour: number; minute: number; second: number } => {
  const matched = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!matched) {
    throw new AppError("E_VALIDATION", "Invalid local_time input");
  }
  return {
    hour: Number(matched[1]),
    minute: Number(matched[2]),
    second: Number(matched[3] ?? "0"),
  };
};

const parseDurationParts = (value: string): { hours: number; minutes: number; seconds: number } => {
  const matched = value.match(/^[-+]?P(?:\d+D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!matched) {
    throw new AppError("E_VALIDATION", "Invalid duration input");
  }
  return {
    hours: Number(matched[1] ?? "0"),
    minutes: Number(matched[2] ?? "0"),
    seconds: Number(matched[3] ?? "0"),
  };
};

const isValidLocalDate = (value: string): boolean => {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) {
    return false;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
};

const isValidLocalDateTime = (value: string): boolean => {
  const matched = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)$/);
  if (!matched) {
    return false;
  }

  return isValidLocalDate(matched[1]) && isValidLocalTime(matched[2]);
};

const isValidLocalTime = (value: string): boolean => {
  const matched = value.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
  if (!matched) {
    return false;
  }

  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  const second = Number(matched[3] ?? "0");
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
};

// Shared runtime bodies for the fall-through cases of the old switch.
const datetimeNowRuntime: StdlibRuntimeImpl = () => new Date().toISOString();

const unpackRuntime: StdlibRuntimeImpl = (args) => {
  const value = args[0];
  if (value === null || value === undefined) return [];
  if (typeof value === "object" && value !== null && "kind" in value) {
    return [...value.values];
  }
  return Array.isArray(value) ? value : [value as ScalarValue];
};

// ── SQL helpers (shared by the `sql` slots) ───────────────────────────────

// EdgeQL's bit_* family is overloaded per integer type and wraps results to
// the operand's width. The width comes from the first argument's static type
// hint; unknown/unresolved types default to 64-bit (the int64 overload).
const bitWidthOf = (typeHint: string | undefined): number => {
  if (typeHint && typeHint.endsWith("int16")) return 16;
  if (typeHint && typeHint.endsWith("int32")) return 32;
  return 64;
};

// Canonical uuid text (8-4-4-4-12) built inline from per-segment randomblob
// draws. Each `randomblob(n)` appears directly in the row expression (no
// wrapping subquery) so SQLite re-evaluates it for every row — a non-correlated
// scalar subquery would be folded to a single value and every row would share
// one uuid, which breaks `count(DISTINCT …)`-style volatility.
const uuidGenerateSql = (): string =>
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || "
  + "lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || "
  + "lower(hex(randomblob(6))))";

// ── The registry ──────────────────────────────────────────────────────────

export const STDLIB_FUNCTIONS: StdlibFunctionEntry[] = [
  // math::
  {
    name: "math::abs",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `abs(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => Math.abs(value)),
  },
  {
    name: "math::ceil",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `ceil(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => Math.ceil(value)),
  },
  {
    name: "math::floor",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `floor(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => Math.floor(value)),
  },
  {
    name: "math::exp",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `_gel_exp(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => Math.exp(value)),
  },
  // math::sqrt is SQL-lowered only (no runtime case in the interpreter).
  {
    name: "math::sqrt",
    sql: (argSql) => argSql[0] ? `_gel_sqrt(${argSql[0]})` : null,
  },
  {
    name: "math::ln",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `_gel_ln(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => Math.log(value)),
  },
  {
    name: "math::lg",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `_gel_lg(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => Math.log10(value)),
  },
  {
    name: "math::log",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_log(${argSql[0]}, ${argSql[1]})` : null,
    runtime: (args) => {
      const x = toNumber(args[0]);
      const base = toNumber(args[1]);
      return Math.log(x) / Math.log(base);
    },
  },
  {
    name: "math::mean",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const values = toNumberList(args[0]);
      if (values.length === 0) {
        return null;
      }
      return values.reduce((acc, value) => acc + value, 0) / values.length;
    },
  },
  {
    name: "math::stddev",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const values = toNumberList(args[0]);
      return stddev(values, true);
    },
  },
  {
    name: "math::stddev_pop",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const values = toNumberList(args[0]);
      return stddev(values, false);
    },
  },
  {
    name: "math::var",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const values = toNumberList(args[0]);
      return variance(values, true);
    },
  },
  {
    name: "math::var_pop",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const values = toNumberList(args[0]);
      return variance(values, false);
    },
  },
  {
    name: "math::pi",
    meta: { minArgs: 0, maxArgs: 0 },
    sql: () => "pi()",
    runtime: () => Math.PI,
  },
  {
    name: "math::e",
    meta: { minArgs: 0, maxArgs: 0 },
    sql: () => "exp(1.0)",
    runtime: () => Math.E,
  },
  {
    name: "math::acos",
    meta: { minArgs: 1, maxArgs: 1 },
    // Trig functions use the `_gel_*` custom SQLite functions registered in
    // openSQLite() — those wrappers raise "input is out of range" for inputs
    // SQLite's built-in trig would silently return NULL / Infinity for.
    sql: (argSql) => argSql[0] ? `_gel_acos(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => {
      if (value < -1 || value > 1 || !Number.isFinite(value)) {
        throw new AppError("E_VALIDATION", "input is out of range for math::acos");
      }
      return Math.acos(value);
    }),
  },
  {
    name: "math::asin",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `_gel_asin(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => {
      if (value < -1 || value > 1 || !Number.isFinite(value)) {
        throw new AppError("E_VALIDATION", "input is out of range for math::asin");
      }
      return Math.asin(value);
    }),
  },
  {
    name: "math::atan",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `atan(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => Math.atan(value)),
  },
  {
    name: "math::atan2",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1] ? `atan2(${argSql[0]}, ${argSql[1]})` : null,
    runtime: (args) => Math.atan2(toNumber(args[0]), toNumber(args[1])),
  },
  {
    name: "math::cos",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `_gel_cos(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => {
      if (!Number.isFinite(value)) throw new AppError("E_VALIDATION", "input is out of range for math::cos");
      return Math.cos(value);
    }),
  },
  {
    name: "math::cot",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `_gel_cot(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => {
      if (!Number.isFinite(value)) throw new AppError("E_VALIDATION", "input is out of range for math::cot");
      return 1 / Math.tan(value);
    }),
  },
  {
    name: "math::sin",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `_gel_sin(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => {
      if (!Number.isFinite(value)) throw new AppError("E_VALIDATION", "input is out of range for math::sin");
      return Math.sin(value);
    }),
  },
  {
    name: "math::tan",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `_gel_tan(${argSql[0]})` : null,
    runtime: (args) => unaryNumeric(args[0], (value) => {
      if (!Number.isFinite(value)) throw new AppError("E_VALIDATION", "input is out of range for math::tan");
      return Math.tan(value);
    }),
  },

  // std:: datetime / temporal
  {
    name: "std::datetime_current",
    meta: { minArgs: 0, maxArgs: 0, volatility: "volatile" },
    sql: () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    runtime: datetimeNowRuntime,
  },
  {
    name: "std::datetime_of_transaction",
    meta: { minArgs: 0, maxArgs: 0, volatility: "stable" },
    sql: () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    runtime: datetimeNowRuntime,
  },
  {
    name: "std::datetime_of_statement",
    meta: { minArgs: 0, maxArgs: 0, volatility: "stable" },
    sql: () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    runtime: datetimeNowRuntime,
  },
  {
    name: "std::to_datetime",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => parseDateTime(args[0]),
  },
  {
    // to_str accepts an optional format string for datetime / numeric inputs.
    name: "std::to_str",
    meta: { minArgs: 1, maxArgs: 2 },
    sql: (argSql) => argSql[0] ? `CAST(${argSql[0]} AS TEXT)` : null,
    runtime: (args) => String(extractScalar(args[0]) ?? ""),
  },
  {
    // `len` is polymorphic: over arrays it counts elements (json_array_length),
    // over bytes it counts bytes (octet length), and over strings it counts
    // characters. Dispatch on the inferred argument type — a bare TEXT length()
    // would count the JSON characters of an array (`"[]"` → 2) instead of 0.
    name: "std::len",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql, argTypes) => {
      if (!argSql[0]) return null;
      const t = argTypes?.[0] ?? "";
      if (t.includes("array<")) return `json_array_length(COALESCE(${argSql[0]}, '[]'))`;
      if (t.endsWith("bytes")) return `length(CAST(${argSql[0]} AS BLOB))`;
      return `length(COALESCE(CAST(${argSql[0]} AS TEXT), ''))`;
    },
    runtime: (args) => {
      const value = extractScalar(args[0]);
      if (value === null || value === undefined) {
        return 0;
      }
      return String(value).length;
    },
  },
  {
    name: "std::count",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `count(${argSql[0]})` : null,
    runtime: (args) => {
      if (typeof args[0] === "object" && args[0] !== null && "kind" in args[0]) {
        return args[0].values.length;
      }
      return args[0] === null ? 0 : 1;
    },
  },
  {
    name: "std::max",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `max(${argSql[0]})` : null,
    runtime: (args) => {
      const values = toNumberList(args[0]);
      return values.length > 0 ? Math.max(...values) : null;
    },
  },
  {
    name: "std::min",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `min(${argSql[0]})` : null,
    runtime: (args) => {
      const values = toNumberList(args[0]);
      return values.length > 0 ? Math.min(...values) : null;
    },
  },
  {
    name: "std::sum",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const rawArg = args[0];
      if (typeof rawArg === "string") {
        throw new AppError("E_SEMANTIC", `function "sum(arg0: std::str)" does not exist`);
      }
      if (Array.isArray(rawArg) && rawArg.some((v) => typeof v === "string")) {
        throw new AppError("E_SEMANTIC", `function "sum(arg0: std::str)" does not exist`);
      }
      const values = toNumberList(rawArg);
      if (values.length === 0) {
        return 0;
      }
      return values.reduce((acc, value) => acc + value, 0);
    },
  },
  {
    name: "std::assert_exists",
    meta: { minArgs: 1, maxArgs: 2 },
    sql: (argSql) => argSql[0] ? `_gel_assert_exists(${argSql[0]})` : null,
    runtime: (args) => {
      const raw = args[0];
      const inner = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set"
        ? raw.values
        : raw;
      const isEmpty = Array.isArray(inner) ? inner.length === 0 : inner == null;
      if (isEmpty) {
        throw new AppError("E_VALIDATION", "assert_exists violation");
      }
      return inner;
    },
  },
  {
    name: "std::assert_single",
    meta: { minArgs: 1, maxArgs: 2 },
    sql: (argSql) => {
      if (!argSql[0]) return null;
      if (argSql[1]) return `_gel_assert_single(${argSql[0]}, ${argSql[1]})`;
      return `_gel_assert_single(${argSql[0]})`;
    },
    runtime: (args) => {
      // Pass-through unless the input is a set with >1 element; then raise.
      const raw = args[0];
      const isSet = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set";
      const values = isSet ? raw.values : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      if (values.length > 1) {
        const msg = args.length > 1 ? extractScalar(args[1]) : null;
        throw new AppError("E_VALIDATION", typeof msg === "string" && msg ? msg : "assert_single violation");
      }
      return isSet ? raw.values : raw;
    },
  },
  {
    name: "std::assert_distinct",
    meta: { minArgs: 1, maxArgs: 2 },
    runtime: (args) => {
      const raw = args[0];
      const isSet = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set";
      const values = isSet ? raw.values : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      if (values.length !== new Set(values.map((v) => JSON.stringify(v))).size) {
        const msg = args.length > 1 ? extractScalar(args[1]) : null;
        throw new AppError("E_VALIDATION", typeof msg === "string" && msg ? msg : "assert_distinct violation");
      }
      return isSet ? raw.values : raw;
    },
  },
  {
    // `std::assert(cond, message := …)` passes through the condition's
    // cardinality and multiplicity. The optional `message` is a SET OF arg
    // (joined into the call), so when multi, the call multiplies out.
    name: "std::assert",
    meta: { minArgs: 1, maxArgs: 2 },
    // `std::assert(cond)` / `std::assert(cond, message := …)` — route through
    // the `_gel_assert` custom function so falsy conditions raise an error
    // instead of returning NULL through the SQL fallback.
    sql: (argSql) => {
      if (!argSql[0]) return null;
      if (argSql[1]) return `_gel_assert(${argSql[0]}, ${argSql[1]})`;
      return `_gel_assert(${argSql[0]})`;
    },
    runtime: (args) => {
      // `assert(cond)` and `assert(cond, message := …)`: raise "assertion
      // failed" (or the custom message) on false; pass `true`/`{}` through.
      const cond = extractScalar(args[0]);
      if (cond === false || cond === 0) {
        const msg = args.length > 1 ? extractScalar(args[1]) : null;
        throw new AppError("E_VALIDATION", typeof msg === "string" && msg ? msg : "assertion failed");
      }
      return cond;
    },
  },
  {
    name: "std::all",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const raw = args[0];
      const values = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set"
        ? raw.values
        : Array.isArray(raw)
          ? raw
          : raw == null
            ? []
            : [raw];
      return values.every((value) => value === true || value === 1);
    },
  },
  {
    name: "std::any",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const raw = args[0];
      const values = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set"
        ? raw.values
        : Array.isArray(raw)
          ? raw
          : raw == null
            ? []
            : [raw];
      return values.some((value) => value === true || value === 1);
    },
  },
  {
    name: "std::range",
    meta: { minArgs: 2, maxArgs: 2 },
    runtime: (args) => {
      const start = toNumber(args[0]);
      const end = toNumber(args[1]);
      const values: number[] = [];
      for (let value = start; value < end; value += 1) {
        values.push(value);
      }
      return values;
    },
  },
  {
    name: "std::range_unpack",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: unpackRuntime,
  },
  {
    name: "std::array_agg",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const value = args[0];
      if (typeof value === "object" && value !== null && "kind" in value) {
        return [...value.values];
      }
      // Multi-property fields materialize to a plain JS array of elements.
      // EdgeQL `array_agg(<multi-set>)` should fold those elements directly
      // into the resulting array, not wrap the set in an extra layer.
      if (Array.isArray(value)) {
        return [...value];
      }
      return value == null ? [] : [value as ScalarValue];
    },
  },
  {
    name: "std::array_unpack",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: unpackRuntime,
  },
  {
    // array_get returns an OPTIONAL element — out-of-bounds yields an empty
    // set rather than an error. Marking the return optional lets cardinality
    // inference report the result as at_most_one per index.
    name: "std::array_get",
    meta: { minArgs: 2, maxArgs: 3, returnOptional: true },
    // `std::array_get(arr, idx [, default])` — returns the element at `idx`,
    // or `default` (or empty set / NULL) when out of range. Negative indices
    // count from the end. SQLite's json_extract returns NULL for invalid
    // paths, which serializes back as `{}` and matches the EdgeQL empty-set
    // expectation in our test harness.
    sql: (argSql) => {
      if (!argSql[0] || !argSql[1]) return null;
      // Bind the array and index once each in a correlated subquery: the
      // negative-index branch reuses the array, and re-emitting an argument that
      // carries `?` placeholders would bind too few params. Keep the projection
      // order (array, index, default) identical to the push order so positional
      // params still line up.
      const inner = `SELECT ${argSql[0]} AS a, ${argSql[1]} AS i${argSql[2] ? `, ${argSql[2]} AS d` : ""}`;
      const idx = `CASE WHEN i < 0 THEN json_array_length(a) + i ELSE i END`;
      const lookup = `json_extract(a, '$[' || (${idx}) || ']')`;
      const body = argSql[2] ? `IFNULL(${lookup}, d)` : lookup;
      return `(SELECT ${body} FROM (${inner}))`;
    },
    runtime: (args) => {
      // `array_get(array, idx)` / `array_get(array, idx, default)` — return
      // `array[idx]` or `default` (or {} if absent) when `idx` is out of
      // range. Negative indices count from the end.
      const raw = args[0];
      const arr: ScalarValue[] = Array.isArray(raw)
        ? raw
        : typeof raw === "object" && raw !== null && "kind" in raw
          ? [...raw.values]
          : [];
      if (arr.length === 0 && typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set") {
        return [];
      }
      const indexes = toNumberList(args[1]);
      if (indexes.length > 1) {
        const values = arr.some(Array.isArray)
          ? arr.flatMap((item) => Array.isArray(item)
            ? indexes.map((idx) => item[idx < 0 ? item.length + idx : idx] ?? null).filter((v) => v !== null && v !== undefined)
            : [])
          : indexes.map((idx) => arr[idx < 0 ? arr.length + idx : idx] ?? null).filter((v) => v !== null && v !== undefined);
        return values.sort((a, b) => String(a).localeCompare(String(b)));
      }
      const idx = indexes[0] ?? 0;
      if (arr.length > 0 && Array.isArray(arr[0])) {
        return arr.map((item) => {
          const tuple = item as unknown as unknown[];
          return tuple[idx < 0 ? tuple.length + idx : idx] ?? null;
        }).filter((value) => value !== null && value !== undefined)
          .sort((a, b) => String(a).localeCompare(String(b)));
      }
      const normalized = idx < 0 ? arr.length + idx : idx;
      if (normalized < 0 || normalized >= arr.length) {
        return args.length > 2 ? extractScalar(args[2]) ?? null : null;
      }
      return arr[normalized];
    },
  },
  {
    name: "std::array_set",
    meta: { minArgs: 3, maxArgs: 3 },
    sql: (argSql) => argSql[0] && argSql[1] && argSql[2]
      ? `_gel_array_set(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`
      : null,
    runtime: (args) => {
      const raw = args[0];
      const arr: ScalarValue[] = Array.isArray(raw)
        ? [...raw]
        : typeof raw === "object" && raw !== null && "kind" in raw
          ? [...raw.values]
          : [];
      const idx = toNumber(args[1]);
      const normalized = idx < 0 ? arr.length + idx : idx;
      if (normalized < 0 || normalized >= arr.length) {
        throw new AppError("E_VALIDATION", `array index ${idx} is out of bounds`);
      }
      const value = extractScalar(args[2]) as ScalarValue;
      arr[normalized] = value;
      return arr;
    },
  },
  {
    name: "std::array_insert",
    meta: { minArgs: 3, maxArgs: 3 },
    sql: (argSql) => argSql[0] && argSql[1] && argSql[2]
      ? `_gel_array_insert(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`
      : null,
    runtime: (args) => {
      const raw = args[0];
      const arr: ScalarValue[] = Array.isArray(raw)
        ? [...raw]
        : typeof raw === "object" && raw !== null && "kind" in raw
          ? [...raw.values]
          : [];
      const idx = toNumber(args[1]);
      // EdgeQL allows insert at [0, len] (length-inclusive — appending) and at
      // [-len, -1] (negative offsets from the end). Anything outside that band
      // raises "array index N is out of bounds".
      if (idx > arr.length || idx < -arr.length - 1) {
        throw new AppError("E_VALIDATION", `array index ${idx} is out of bounds`);
      }
      const normalized = idx < 0 ? arr.length + idx + 1 : idx;
      const value = extractScalar(args[2]) as ScalarValue;
      arr.splice(normalized, 0, value);
      return arr;
    },
  },
  {
    name: "std::enumerate",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const value = args[0];
      const items: unknown[] = typeof value === "object" && value !== null && "kind" in value
        ? [...value.values]
        : Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
      return items.map((item, index) => [index, item]);
    },
  },
  {
    name: "std::str_lower",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `lower(COALESCE(CAST(${argSql[0]} AS TEXT), ''))` : null,
    runtime: (args) => String(extractScalar(args[0]) ?? "").toLowerCase(),
  },
  {
    name: "std::str_upper",
    meta: { minArgs: 1, maxArgs: 1 },
    sql: (argSql) => argSql[0] ? `upper(COALESCE(CAST(${argSql[0]} AS TEXT), ''))` : null,
    runtime: (args) => String(extractScalar(args[0]) ?? "").toUpperCase(),
  },
  {
    // str_split returns a single `array<std::str>` value (see the return-type
    // inference in ast_to_ir). Multiplicity inference treats it as a regular
    // function (no SET OF params), so the result can be DUPLICATE when the
    // operand is multi.
    name: "std::str_split",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_str_split(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::to_duration",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => parseDuration(extractScalar(args[0])),
  },
  {
    // array_join(arr, sep): walk the array via json_each and join the values.
    // Wraps the array in a CTE so the array placeholder appears in the SQL
    // BEFORE the separator placeholder — keeping ? positions aligned with the
    // params array (which receives arg0 before arg1).
    name: "std::array_join",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => {
      if (!argSql[0] || !argSql[1]) return null;
      return `(WITH __aj(__arr) AS (VALUES (${argSql[0]})) SELECT COALESCE(group_concat(value, ${argSql[1]}), '') FROM __aj, json_each(__aj.__arr))`;
    },
    runtime: (args) => {
      const values = toStringList(args[0]);
      const separator = String(extractScalar(args[1]) ?? "");
      return values.join(separator);
    },
  },

  // cal:: temporal constructors
  {
    name: "cal::to_local_datetime",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => parseLocalDateTime(extractScalar(args[0])),
  },
  {
    name: "cal::to_local_date",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => parseLocalDate(extractScalar(args[0])),
  },
  {
    name: "cal::to_local_time",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => parseLocalTime(extractScalar(args[0])),
  },
  {
    name: "cal::to_relative_duration",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => parseDuration(extractScalar(args[0])),
  },
  {
    name: "cal::to_date_duration",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => parseDuration(extractScalar(args[0])),
  },

  // temporal accessors / truncation
  {
    name: "std::datetime_get",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_datetime_get(${argSql[0]}, ${argSql[1]})`
      : null,
    runtime: (args) => {
      const date = new Date(parseDateTime(args[0]));
      const part = String(extractScalar(args[1]) ?? "").toLowerCase();
      switch (part) {
        case "year":
          return date.getUTCFullYear();
        case "month":
          return date.getUTCMonth() + 1;
        case "day":
          return date.getUTCDate();
        case "hour":
          return date.getUTCHours();
        case "minute":
          return date.getUTCMinutes();
        case "second":
          return date.getUTCSeconds();
        case "epochseconds":
          return Math.floor(date.getTime() / 1000);
        default:
          return null;
      }
    },
  },
  {
    name: "cal::date_get",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_date_get(${argSql[0]}, ${argSql[1]})`
      : null,
    runtime: (args) => {
      const date = parseDateComponents(String(extractScalar(args[0]) ?? ""));
      const part = String(extractScalar(args[1]) ?? "").toLowerCase();
      if (part === "year") {
        return date.year;
      }
      if (part === "month") {
        return date.month;
      }
      if (part === "day") {
        return date.day;
      }
      throw new AppError("E_VALIDATION", `invalid unit for cal::date_get: '${part}'`);
    },
  },
  {
    name: "cal::time_get",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_time_get(${argSql[0]}, ${argSql[1]})`
      : null,
    runtime: (args) => {
      const time = parseTimeComponents(String(extractScalar(args[0]) ?? ""));
      const part = String(extractScalar(args[1]) ?? "").toLowerCase();
      if (part === "hour") {
        return time.hour;
      }
      if (part === "minute") {
        return time.minute;
      }
      if (part === "second") {
        return time.second;
      }
      throw new AppError("E_VALIDATION", `invalid unit for cal::time_get: '${part}'`);
    },
  },
  {
    name: "std::duration_get",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_duration_get(${argSql[0]}, ${argSql[1]})`
      : null,
    runtime: (args) => {
      const duration = parseDurationParts(String(extractScalar(args[0]) ?? ""));
      const part = String(extractScalar(args[1]) ?? "").toLowerCase();
      if (part === "hours") {
        return duration.hours;
      }
      if (part === "minutes") {
        return duration.minutes;
      }
      if (part === "seconds") {
        return duration.seconds;
      }
      // EdgeQL only accepts hours/minutes/seconds — `days`, `epoch`, etc. are
      // rejected. Match the upstream message so tests recognise it.
      throw new AppError("E_VALIDATION", `invalid unit for std::duration_get: '${part}'`);
    },
  },
  {
    name: "std::datetime_truncate",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_datetime_truncate(${argSql[0]}, ${argSql[1]})`
      : null,
    runtime: (args) => {
      const part = String(extractScalar(args[0]) ?? "").toLowerCase();
      const date = new Date(parseDateTime(args[1]));
      if (part === "year") {
        date.setUTCMonth(0, 1);
        date.setUTCHours(0, 0, 0, 0);
      } else if (part === "month") {
        date.setUTCDate(1);
        date.setUTCHours(0, 0, 0, 0);
      } else if (part === "day") {
        date.setUTCHours(0, 0, 0, 0);
      } else if (part === "hour") {
        date.setUTCMinutes(0, 0, 0);
      } else if (part === "minute") {
        date.setUTCSeconds(0, 0);
      } else if (part === "second") {
        date.setUTCMilliseconds(0);
      }
      return date.toISOString();
    },
  },
  {
    name: "std::duration_truncate",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_duration_truncate(${argSql[0]}, ${argSql[1]})`
      : null,
    runtime: (args) => {
      const unit = String(extractScalar(args[0]) ?? "").toLowerCase();
      const duration = parseDurationParts(String(extractScalar(args[1]) ?? ""));
      if (unit === "hours") {
        return `PT${duration.hours}H`;
      }
      if (unit === "minutes") {
        return `PT${duration.hours}H${duration.minutes}M`;
      }
      return `PT${duration.hours}H${duration.minutes}M${duration.seconds}S`;
    },
  },
  {
    name: "cal::duration_normalize_hours",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const duration = parseDurationParts(String(extractScalar(args[0]) ?? ""));
      const normalized = duration.hours + Math.floor(duration.minutes / 60);
      const minutes = duration.minutes % 60;
      return `PT${normalized}H${minutes}M${duration.seconds}S`;
    },
  },
  {
    name: "cal::duration_normalize_days",
    meta: { minArgs: 1, maxArgs: 1 },
    runtime: (args) => {
      const duration = parseDurationParts(String(extractScalar(args[0]) ?? ""));
      const days = Math.floor(duration.hours / 24);
      const hours = duration.hours % 24;
      return `P${days}DT${hours}H${duration.minutes}M${duration.seconds}S`;
    },
  },
  {
    name: "std::duration_to_seconds",
    sql: (argSql) => argSql[0]
      ? `_gel_duration_to_seconds(${argSql[0]})`
      : null,
  },

  // internal helpers
  {
    name: "std::__gel_subtract",
    meta: { minArgs: 2, maxArgs: 2 },
    runtime: (args) => toNumber(args[0]) - toNumber(args[1]),
  },
  {
    name: "std::__gel_if_eq",
    meta: { minArgs: 4, maxArgs: 4 },
    runtime: (args) => {
      const lhs = extractScalar(args[0]);
      const rhs = extractScalar(args[1]);
      return lhs === rhs ? extractScalar(args[2]) : extractScalar(args[3]);
    },
  },

  // json
  {
    // to_json can return JSON `null`, and casting JSON null yields the empty
    // set — so on the casting-back path the effective return is OPTIONAL.
    name: "std::to_json",
    meta: { minArgs: 1, maxArgs: 1, returnOptional: true },
    // `to_json(s)` parses the string as JSON; SQLite's json() validates and
    // minifies, raising on malformed input like EdgeQL does.
    sql: (argSql) => argSql[0] ? `json(${argSql[0]})` : null,
    runtime: (args) => {
      const raw = extractScalar(args[0]);
      if (raw === null || raw === undefined) {
        return null;
      }
      const text = String(raw);
      if (text === "null") {
        return null;
      }
      return text;
    },
  },
  {
    // `json_get(j, p1, p2, …)` walks the path and yields the element as json
    // (empty set — NULL — when missing). Path segments are arbitrary exprs, so
    // build the json_extract path string by concatenation.
    name: "std::json_get",
    sql: (argSql) => {
      if (!argSql[0] || argSql.length < 2 || argSql.slice(1).some((a) => !a)) return null;
      const path = argSql.slice(1).map((a) => ` || '."' || ${a} || '"'`).join("");
      return `json_extract(${argSql[0]}, '$'${path})`;
    },
  },

  // randomness / uuid
  {
    name: "std::random",
    meta: { minArgs: 0, maxArgs: 0, volatility: "volatile" },
    // `std::random()` — float in [0, 1). SQLite's `random()` returns a
    // signed 64-bit integer; shift+normalise to the [0, 1) range. Use
    // `random() / 9223372036854775808.0` (max abs value + 1) which yields
    // values in (-1, 1), then halve+shift to [0, 1).
    sql: () => "((CAST(random() AS REAL) / 18446744073709551616.0) + 0.5)",
    runtime: () => Math.random(),
  },
  {
    // `std::uuid_generate_v1mc()` / `std::uuid_generate_v4()` — generate a fresh
    // uuid. SQLite has no uuid type, so build a canonical 8-4-4-4-12 hex string
    // from 16 random bytes (`randomblob(16)`), splicing dashes at the right
    // offsets. Both forms produce distinct random values per row, which is all
    // the EdgeQL semantics require here (a uuid value carried as text).
    name: "std::uuid_generate_v1mc",
    sql: () => uuidGenerateSql(),
  },
  {
    name: "std::uuid_generate_v4",
    sql: () => uuidGenerateSql(),
  },

  // rounding
  {
    name: "std::round",
    meta: { minArgs: 1, maxArgs: 2 },
    // EdgeQL round: float64 is half-to-even, decimal/bigint half-away-from-zero
    // (Postgres float8 vs numeric). The mode comes from the arg's static type.
    sql: (argSql, argTypes) => {
      if (!argSql[0]) return null;
      const t = argTypes?.[0] ?? "";
      const mode = t.endsWith("decimal") || t.endsWith("bigint") ? "'away'" : "'even'";
      if (argSql[1]) return `_gel_round(${argSql[0]}, ${argSql[1]}, ${mode})`;
      return `_gel_round(${argSql[0]}, 0, ${mode})`;
    },
  },

  // string search
  {
    // `find(haystack, needle)` returns 0-based position or -1 if not found.
    // SQLite's instr returns 1-based, 0 if not found — translate accordingly.
    name: "std::find",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => {
      if (!argSql[0] || !argSql[1]) return null;
      return `(instr(CAST(${argSql[0]} AS TEXT), CAST(${argSql[1]} AS TEXT)) - 1)`;
    },
  },
  {
    // `contains(haystack, needle)` for strings: true if instr > 0.
    name: "std::contains",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => {
      if (!argSql[0] || !argSql[1]) return null;
      return `(instr(CAST(${argSql[0]} AS TEXT), CAST(${argSql[1]} AS TEXT)) > 0)`;
    },
  },

  // regex (runtime is JS RegExp; SQL routes through `_gel_re_*` UDFs)
  {
    // `re_test(pattern, str)` / `re_match(pattern, str)` / `re_replace(...)` —
    // SQLite has no built-in REGEXP, so we lower to the JS-backed `_gel_re_*`
    // SQLite functions registered in openSQLite().
    name: "std::re_test",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1]
      ? `(_gel_re_test(${argSql[0]}, ${argSql[1]}) = 1)`
      : null,
    runtime: (args) => {
      const pattern = String(args[0] ?? "");
      const subject = String(args[1] ?? "");
      const { source, flags } = parseEdgeQLRegex(pattern);
      return new RegExp(source, flags).test(subject);
    },
  },
  {
    name: "std::re_match",
    meta: { minArgs: 2, maxArgs: 2 },
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_re_match_first(${argSql[0]}, ${argSql[1]})`
      : null,
    runtime: (args) => {
      const patterns = toStringList(args[0]);
      const subjects = toStringList(args[1]);
      const out: unknown[] = [];
      for (const pattern of patterns) {
        const { source, flags } = parseEdgeQLRegex(pattern);
        for (const subject of subjects) {
          const match = new RegExp(source, flags).exec(subject);
          if (!match) continue;
          out.push(match.length === 1 ? [match[0]] : match.slice(1));
        }
      }
      return out;
    },
  },
  {
    name: "std::re_match_all",
    meta: { minArgs: 2, maxArgs: 2 },
    runtime: (args) => {
      const pattern = String(args[0] ?? "");
      const subject = String(args[1] ?? "");
      const { source, flags } = parseEdgeQLRegex(pattern);
      const re = new RegExp(source, flags.includes("g") ? flags : flags + "g");
      const out: unknown[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(subject)) !== null) {
        out.push(m.length === 1 ? m[0] : m.slice(1));
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
      return out;
    },
  },
  {
    name: "std::re_replace",
    meta: { minArgs: 3, maxArgs: 4 },
    sql: (argSql) => {
      if (!argSql[0] || !argSql[1] || !argSql[2]) return null;
      if (argSql[3]) return `_gel_re_replace(${argSql[0]}, ${argSql[1]}, ${argSql[2]}, ${argSql[3]})`;
      return `_gel_re_replace(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`;
    },
    runtime: (args) => {
      const pattern = String(args[0] ?? "");
      const replacement = String(args[1] ?? "");
      const subject = String(args[2] ?? "");
      const optFlags = args[3] !== undefined ? String(args[3]) : "";
      const { source, flags } = parseEdgeQLRegex(pattern);
      const finalFlags = optFlags.includes("g") ? flags + "g" : flags;
      return subject.replace(new RegExp(source, finalFlags.replace(/(.)(?=.*\1)/g, "")), replacement);
    },
  },

  // ── SQL-only functions (never reached by the Runtime evaluator) ──────────
  {
    name: "std::str_trim",
    // str_trim family: SQLite's trim(x, y) trims any character in y from both
    // ends (ltrim/rtrim for one side), matching EdgeQL's optional `trim` arg.
    sql: (argSql) => argSql[0]
      ? (argSql[1] ? `trim(${argSql[0]}, ${argSql[1]})` : `trim(${argSql[0]})`)
      : null,
  },
  {
    name: "std::str_trim_start",
    sql: (argSql) => argSql[0]
      ? (argSql[1] ? `ltrim(${argSql[0]}, ${argSql[1]})` : `ltrim(${argSql[0]})`)
      : null,
  },
  {
    name: "std::str_trim_end",
    sql: (argSql) => argSql[0]
      ? (argSql[1] ? `rtrim(${argSql[0]}, ${argSql[1]})` : `rtrim(${argSql[0]})`)
      : null,
  },
  {
    name: "std::str_pad_start",
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_str_pad_start(${argSql[0]}, ${argSql[1]}${argSql[2] ? `, ${argSql[2]}` : ""})`
      : null,
  },
  {
    name: "std::str_pad_end",
    sql: (argSql) => argSql[0] && argSql[1]
      ? `_gel_str_pad_end(${argSql[0]}, ${argSql[1]}${argSql[2] ? `, ${argSql[2]}` : ""})`
      : null,
  },
  {
    name: "std::str_repeat",
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_str_repeat(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::str_reverse",
    sql: (argSql) => argSql[0] ? `_gel_str_reverse(${argSql[0]})` : null,
  },
  {
    name: "std::str_replace",
    sql: (argSql) => argSql[0] && argSql[1] && argSql[2]
      ? `replace(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`
      : null,
  },
  {
    name: "std::array_replace",
    sql: (argSql) => argSql[0] && argSql[1] && argSql[2]
      ? `_gel_array_replace(${argSql[0]}, ${argSql[1]}, ${argSql[2]})`
      : null,
  },
  {
    name: "std::to_int16",
    sql: (argSql) => argSql[0] ? `_gel_to_int16(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null,
  },
  {
    name: "std::to_int32",
    sql: (argSql) => argSql[0] ? `_gel_to_int32(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null,
  },
  {
    name: "std::to_int64",
    sql: (argSql) => argSql[0] ? `_gel_to_int64(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null,
  },
  {
    name: "std::to_float32",
    sql: (argSql) => argSql[0] ? `_gel_to_float32(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null,
  },
  {
    name: "std::to_float64",
    sql: (argSql) => argSql[0] ? `_gel_to_float64(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null,
  },
  {
    name: "std::to_bigint",
    sql: (argSql) => argSql[0] ? `_gel_to_bigint(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null,
  },
  {
    name: "std::to_decimal",
    sql: (argSql) => argSql[0] ? `_gel_to_decimal(${argSql[0]}${argSql[1] ? `, ${argSql[1]}` : ""})` : null,
  },
  // Bitwise functions. AND/OR/NOT sign-extend cleanly from any width to
  // 64-bit (the ops are homomorphic under sign extension), so SQLite's
  // native operators suffice. XOR has no SQLite operator and the shifts /
  // popcount are width-sensitive — those go through `_gel_bit_*` UDFs.
  {
    name: "std::bit_and",
    sql: (argSql) => argSql[0] && argSql[1] ? `(${argSql[0]} & ${argSql[1]})` : null,
  },
  {
    name: "std::bit_or",
    sql: (argSql) => argSql[0] && argSql[1] ? `(${argSql[0]} | ${argSql[1]})` : null,
  },
  {
    name: "std::bit_not",
    sql: (argSql) => argSql[0] ? `(~(${argSql[0]}))` : null,
  },
  {
    name: "std::bit_xor",
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_bit_xor(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::bit_lshift",
    sql: (argSql, argTypes) => argSql[0] && argSql[1]
      ? `_gel_bit_lshift(${argSql[0]}, ${argSql[1]}, ${bitWidthOf(argTypes?.[0])})`
      : null,
  },
  {
    name: "std::bit_rshift",
    sql: (argSql, argTypes) => argSql[0] && argSql[1]
      ? `_gel_bit_rshift(${argSql[0]}, ${argSql[1]}, ${bitWidthOf(argTypes?.[0])})`
      : null,
  },
  {
    name: "std::bit_count",
    sql: (argSql, argTypes) => argSql[0]
      ? `_gel_bit_count(${argSql[0]}, ${bitWidthOf(argTypes?.[0])})`
      : null,
  },
  // Range predicates/accessors — ranges are JSON objects produced by
  // `_gel_range` (constructed in compileFunctionCallSQL, which knows the
  // bound types). Boolean results are JSON-encoded by the caller.
  {
    name: "std::overlaps",
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_range_overlaps(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::adjacent",
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_range_adjacent(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::strictly_below",
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_range_strictly_below(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::strictly_above",
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_range_strictly_above(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::bounded_above",
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_range_bounded_above(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::bounded_below",
    sql: (argSql) => argSql[0] && argSql[1] ? `_gel_range_bounded_below(${argSql[0]}, ${argSql[1]})` : null,
  },
  {
    name: "std::range_is_empty",
    sql: (argSql) => argSql[0] ? `_gel_range_is_empty(${argSql[0]})` : null,
  },
  {
    name: "std::range_is_inclusive_lower",
    sql: (argSql) => argSql[0] ? `_gel_range_is_inclusive_lower(${argSql[0]})` : null,
  },
  {
    name: "std::range_is_inclusive_upper",
    sql: (argSql) => argSql[0] ? `_gel_range_is_inclusive_upper(${argSql[0]})` : null,
  },
  {
    name: "std::range_get_lower",
    sql: (argSql) => argSql[0] ? `_gel_range_get_lower(${argSql[0]})` : null,
  },
  {
    name: "std::range_get_upper",
    sql: (argSql) => argSql[0] ? `_gel_range_get_upper(${argSql[0]})` : null,
  },
  {
    name: "std::multirange",
    sql: (argSql) => argSql[0] ? `_gel_multirange(${argSql[0]})` : null,
  },
];

// ── Index + accessors (the readers both engines go through) ────────────────

const BY_NAME = new Map<string, StdlibFunctionEntry>(STDLIB_FUNCTIONS.map((entry) => [entry.name, entry]));

export const getStdlibEntry = (name: string): StdlibFunctionEntry | undefined => BY_NAME.get(name);

/** The metadata view (arity gating included), or undefined when `name` has no
 * metadata slot or the arity is out of range. */
export const resolveStdlibFunction = (qualifiedName: string, arity: number): StdlibFunctionDef | undefined => {
  const entry = BY_NAME.get(qualifiedName);
  if (!entry || !entry.meta) {
    return undefined;
  }
  if (arity < entry.meta.minArgs || arity > entry.meta.maxArgs) {
    return undefined;
  }
  return { name: entry.name, ...entry.meta };
};

export const tryResolveStdlibFunction = (name: string, arity: number, activeModule: string): StdlibFunctionDef | undefined => {
  // If the name comes in already qualified (e.g. `default::range`) and that
  // exact name isn't a stdlib function, fall back to the unqualified name
  // resolved against `std::` / `math::` / `cal::`. EdgeQL's name resolution
  // makes unqualified bareword calls in the default module look like
  // `default::range` after qualification, but stdlib functions live in the
  // std/math/cal modules — without this fallback every bareword call to a
  // stdlib function from a default-module script would miss.
  const candidates: string[] = [];
  if (name.includes("::")) {
    candidates.push(name);
    const shortName = name.slice(name.lastIndexOf("::") + 2);
    candidates.push(`std::${shortName}`, `math::${shortName}`, `cal::${shortName}`);
  } else {
    candidates.push(`${activeModule}::${name}`, `std::${name}`, `math::${name}`, `cal::${name}`);
  }
  for (const candidate of candidates) {
    const hit = resolveStdlibFunction(candidate, arity);
    if (hit) {
      return hit;
    }
  }
  return undefined;
};

/** The interpreter dispatch. Returns undefined for an unknown name or a
 * function without a runtime slot (matching the old switch's default). */
export const executeStdlibFunction = (name: string, args: RuntimeFunctionArg[]): unknown => {
  const entry = BY_NAME.get(name);
  return entry?.runtime ? entry.runtime(args) : undefined;
};

/** The SQL-lowering adapter for `name`, or undefined when the function has no
 * SQL slot (i.e. it is not SQL-lowerable). */
export const getStdlibSqlTemplate = (name: string): StdlibSqlTemplate | undefined => BY_NAME.get(name)?.sql;

/** A stdlib function is SQL-lowerable iff it has a SQL slot in the registry.
 * This replaced the hand-synced `BASE_SQL_NATIVE_STDLIB_LOWERING` name-set in
 * `runtime/target.ts` plus the `UNREGISTERED_BUT_SUPPORTED` patch-set. */
export const stdlibFunctionLowersToSql = (name: string): boolean => Boolean(BY_NAME.get(name)?.sql);
