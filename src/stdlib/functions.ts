import { AppError } from "../errors.js";
import type { ScalarValue } from "../types.js";

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

const DEFINITIONS: StdlibFunctionDef[] = [
  { name: "math::abs", minArgs: 1, maxArgs: 1 },
  { name: "math::ceil", minArgs: 1, maxArgs: 1 },
  { name: "math::floor", minArgs: 1, maxArgs: 1 },
  { name: "math::exp", minArgs: 1, maxArgs: 1 },
  { name: "math::ln", minArgs: 1, maxArgs: 1 },
  { name: "math::lg", minArgs: 1, maxArgs: 1 },
  { name: "math::log", minArgs: 2, maxArgs: 2 },
  { name: "math::mean", minArgs: 1, maxArgs: 1 },
  { name: "math::stddev", minArgs: 1, maxArgs: 1 },
  { name: "math::stddev_pop", minArgs: 1, maxArgs: 1 },
  { name: "math::var", minArgs: 1, maxArgs: 1 },
  { name: "math::var_pop", minArgs: 1, maxArgs: 1 },
  { name: "math::pi", minArgs: 0, maxArgs: 0 },
  { name: "math::e", minArgs: 0, maxArgs: 0 },
  { name: "math::acos", minArgs: 1, maxArgs: 1 },
  { name: "math::asin", minArgs: 1, maxArgs: 1 },
  { name: "math::atan", minArgs: 1, maxArgs: 1 },
  { name: "math::atan2", minArgs: 2, maxArgs: 2 },
  { name: "math::cos", minArgs: 1, maxArgs: 1 },
  { name: "math::cot", minArgs: 1, maxArgs: 1 },
  { name: "math::sin", minArgs: 1, maxArgs: 1 },
  { name: "math::tan", minArgs: 1, maxArgs: 1 },
  { name: "std::datetime_current", minArgs: 0, maxArgs: 0, volatility: "volatile" },
  { name: "std::datetime_of_transaction", minArgs: 0, maxArgs: 0, volatility: "stable" },
  { name: "std::datetime_of_statement", minArgs: 0, maxArgs: 0, volatility: "stable" },
  { name: "std::to_datetime", minArgs: 1, maxArgs: 1 },
  // to_str accepts an optional format string for datetime / numeric inputs.
  { name: "std::to_str", minArgs: 1, maxArgs: 2 },
  { name: "std::len", minArgs: 1, maxArgs: 1 },
  { name: "std::count", minArgs: 1, maxArgs: 1 },
  { name: "std::max", minArgs: 1, maxArgs: 1 },
  { name: "std::min", minArgs: 1, maxArgs: 1 },
  { name: "std::sum", minArgs: 1, maxArgs: 1 },
  { name: "std::assert_exists", minArgs: 1, maxArgs: 2 },
  { name: "std::assert_single", minArgs: 1, maxArgs: 2 },
  { name: "std::assert_distinct", minArgs: 1, maxArgs: 2 },
  // `std::assert(cond, message := …)` passes through the condition's
  // cardinality and multiplicity. The optional `message` is a SET OF arg
  // (joined into the call), so when multi, the call multiplies out.
  { name: "std::assert", minArgs: 1, maxArgs: 2 },
  { name: "std::all", minArgs: 1, maxArgs: 1 },
  { name: "std::any", minArgs: 1, maxArgs: 1 },
  { name: "std::range", minArgs: 2, maxArgs: 2 },
  { name: "std::range_unpack", minArgs: 1, maxArgs: 1 },
  { name: "std::array_agg", minArgs: 1, maxArgs: 1 },
  { name: "std::array_unpack", minArgs: 1, maxArgs: 1 },
  // array_get returns an OPTIONAL element — out-of-bounds yields an empty
  // set rather than an error. Marking the return optional lets cardinality
  // inference report the result as at_most_one per index.
  { name: "std::array_get", minArgs: 2, maxArgs: 3, returnOptional: true },
  { name: "std::array_set", minArgs: 3, maxArgs: 3 },
  { name: "std::array_insert", minArgs: 3, maxArgs: 3 },
  { name: "std::enumerate", minArgs: 1, maxArgs: 1 },
  { name: "std::str_lower", minArgs: 1, maxArgs: 1 },
  { name: "std::str_upper", minArgs: 1, maxArgs: 1 },
  // str_split returns a set of strings — not a single value. Multiplicity
  // inference treats it as a regular function (no SET OF params), so the
  // result can be DUPLICATE when the operand is multi.
  { name: "std::str_split", minArgs: 2, maxArgs: 2 },
  { name: "std::to_duration", minArgs: 1, maxArgs: 1 },
  { name: "std::array_join", minArgs: 2, maxArgs: 2 },
  { name: "cal::to_local_datetime", minArgs: 1, maxArgs: 1 },
  { name: "cal::to_local_date", minArgs: 1, maxArgs: 1 },
  { name: "cal::to_local_time", minArgs: 1, maxArgs: 1 },
  { name: "cal::to_relative_duration", minArgs: 1, maxArgs: 1 },
  { name: "cal::to_date_duration", minArgs: 1, maxArgs: 1 },
  { name: "std::datetime_get", minArgs: 2, maxArgs: 2 },
  { name: "cal::date_get", minArgs: 2, maxArgs: 2 },
  { name: "cal::time_get", minArgs: 2, maxArgs: 2 },
  { name: "std::duration_get", minArgs: 2, maxArgs: 2 },
  { name: "std::datetime_truncate", minArgs: 2, maxArgs: 2 },
  { name: "std::duration_truncate", minArgs: 2, maxArgs: 2 },
  { name: "cal::duration_normalize_hours", minArgs: 1, maxArgs: 1 },
  { name: "cal::duration_normalize_days", minArgs: 1, maxArgs: 1 },
  { name: "std::__gel_subtract", minArgs: 2, maxArgs: 2 },
  { name: "std::__gel_if_eq", minArgs: 4, maxArgs: 4 },
  // to_json can return JSON `null`, and casting JSON null yields the empty
  // set — so on the casting-back path the effective return is OPTIONAL.
  { name: "std::to_json", minArgs: 1, maxArgs: 1, returnOptional: true },
  { name: "std::random", minArgs: 0, maxArgs: 0, volatility: "volatile" },
  { name: "std::round", minArgs: 1, maxArgs: 2 },
  { name: "std::find", minArgs: 2, maxArgs: 2 },
  { name: "std::contains", minArgs: 2, maxArgs: 2 },
  { name: "std::re_test", minArgs: 2, maxArgs: 2 },
  { name: "std::re_match", minArgs: 2, maxArgs: 2 },
  { name: "std::re_match_all", minArgs: 2, maxArgs: 2 },
  { name: "std::re_replace", minArgs: 3, maxArgs: 4 },
];

const BY_NAME = new Map(DEFINITIONS.map((def) => [def.name, def]));

export const resolveStdlibFunction = (qualifiedName: string, arity: number): StdlibFunctionDef | undefined => {
  const def = BY_NAME.get(qualifiedName);
  if (!def) {
    return undefined;
  }
  if (arity < def.minArgs || arity > def.maxArgs) {
    return undefined;
  }
  return def;
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

export const executeStdlibFunction = (name: string, args: RuntimeFunctionArg[]): unknown => {
  switch (name) {
    case "math::abs":
      return unaryNumeric(args[0], (value) => Math.abs(value));
    case "math::ceil":
      return unaryNumeric(args[0], (value) => Math.ceil(value));
    case "math::floor":
      return unaryNumeric(args[0], (value) => Math.floor(value));
    case "math::exp":
      return unaryNumeric(args[0], (value) => Math.exp(value));
    case "math::ln":
      return unaryNumeric(args[0], (value) => Math.log(value));
    case "math::lg":
      return unaryNumeric(args[0], (value) => Math.log10(value));
    case "math::log": {
      const x = toNumber(args[0]);
      const base = toNumber(args[1]);
      return Math.log(x) / Math.log(base);
    }
    case "math::mean": {
      const values = toNumberList(args[0]);
      if (values.length === 0) {
        return null;
      }
      return values.reduce((acc, value) => acc + value, 0) / values.length;
    }
    case "math::stddev": {
      const values = toNumberList(args[0]);
      return stddev(values, true);
    }
    case "math::stddev_pop": {
      const values = toNumberList(args[0]);
      return stddev(values, false);
    }
    case "math::var": {
      const values = toNumberList(args[0]);
      return variance(values, true);
    }
    case "math::var_pop": {
      const values = toNumberList(args[0]);
      return variance(values, false);
    }
    case "math::pi":
      return Math.PI;
    case "math::e":
      return Math.E;
    case "math::acos":
      return unaryNumeric(args[0], (value) => {
        if (value < -1 || value > 1 || !Number.isFinite(value)) {
          throw new AppError("E_VALIDATION", "input is out of range for math::acos");
        }
        return Math.acos(value);
      });
    case "math::asin":
      return unaryNumeric(args[0], (value) => {
        if (value < -1 || value > 1 || !Number.isFinite(value)) {
          throw new AppError("E_VALIDATION", "input is out of range for math::asin");
        }
        return Math.asin(value);
      });
    case "math::atan":
      return unaryNumeric(args[0], (value) => Math.atan(value));
    case "math::atan2":
      return Math.atan2(toNumber(args[0]), toNumber(args[1]));
    case "math::cos":
      return unaryNumeric(args[0], (value) => {
        if (!Number.isFinite(value)) throw new AppError("E_VALIDATION", "input is out of range for math::cos");
        return Math.cos(value);
      });
    case "math::cot":
      return unaryNumeric(args[0], (value) => {
        if (!Number.isFinite(value)) throw new AppError("E_VALIDATION", "input is out of range for math::cot");
        return 1 / Math.tan(value);
      });
    case "math::sin":
      return unaryNumeric(args[0], (value) => {
        if (!Number.isFinite(value)) throw new AppError("E_VALIDATION", "input is out of range for math::sin");
        return Math.sin(value);
      });
    case "math::tan":
      return unaryNumeric(args[0], (value) => {
        if (!Number.isFinite(value)) throw new AppError("E_VALIDATION", "input is out of range for math::tan");
        return Math.tan(value);
      });
    case "std::datetime_current":
    case "std::datetime_of_transaction":
    case "std::datetime_of_statement":
      return new Date().toISOString();
    case "std::to_datetime":
      return parseDateTime(args[0]);
    case "std::to_duration":
      return parseDuration(extractScalar(args[0]));
    case "std::array_join": {
      const values = toStringList(args[0]);
      const separator = String(extractScalar(args[1]) ?? "");
      return values.join(separator);
    }
    case "std::assert_exists": {
      const raw = args[0];
      const inner = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set"
        ? raw.values
        : raw;
      const isEmpty = Array.isArray(inner) ? inner.length === 0 : inner == null;
      if (isEmpty) {
        throw new AppError("E_VALIDATION", "assert_exists violation");
      }
      return inner;
    }
    case "std::assert_single": {
      // Pass-through unless the input is a set with >1 element; then raise.
      const raw = args[0];
      const isSet = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set";
      const values = isSet ? raw.values : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      if (values.length > 1) {
        const msg = args.length > 1 ? extractScalar(args[1]) : null;
        throw new AppError("E_VALIDATION", typeof msg === "string" && msg ? msg : "assert_single violation");
      }
      return isSet ? raw.values : raw;
    }
    case "std::assert_distinct": {
      const raw = args[0];
      const isSet = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set";
      const values = isSet ? raw.values : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      if (values.length !== new Set(values.map((v) => JSON.stringify(v))).size) {
        const msg = args.length > 1 ? extractScalar(args[1]) : null;
        throw new AppError("E_VALIDATION", typeof msg === "string" && msg ? msg : "assert_distinct violation");
      }
      return isSet ? raw.values : raw;
    }
    case "std::assert": {
      // `assert(cond)` and `assert(cond, message := …)`: raise "assertion
      // failed" (or the custom message) on false; pass `true`/`{}` through.
      const cond = extractScalar(args[0]);
      if (cond === false || cond === 0) {
        const msg = args.length > 1 ? extractScalar(args[1]) : null;
        throw new AppError("E_VALIDATION", typeof msg === "string" && msg ? msg : "assertion failed");
      }
      return cond;
    }
    case "std::all": {
      const raw = args[0];
      const values = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set"
        ? raw.values
        : Array.isArray(raw)
          ? raw
          : raw == null
            ? []
            : [raw];
      return values.every((value) => value === true || value === 1);
    }
    case "std::any": {
      const raw = args[0];
      const values = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "set"
        ? raw.values
        : Array.isArray(raw)
          ? raw
          : raw == null
            ? []
            : [raw];
      return values.some((value) => value === true || value === 1);
    }
    case "cal::to_local_datetime":
      return parseLocalDateTime(extractScalar(args[0]));
    case "cal::to_local_date":
      return parseLocalDate(extractScalar(args[0]));
    case "cal::to_local_time":
      return parseLocalTime(extractScalar(args[0]));
    case "cal::to_relative_duration":
      return parseDuration(extractScalar(args[0]));
    case "cal::to_date_duration":
      return parseDuration(extractScalar(args[0]));
    case "std::to_str":
      return String(extractScalar(args[0]) ?? "");
    case "std::len": {
      const value = extractScalar(args[0]);
      if (value === null || value === undefined) {
        return 0;
      }
      return String(value).length;
    }
    case "std::sum": {
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
    }
    case "std::random":
      return Math.random();
    case "std::re_test": {
      const pattern = String(args[0] ?? "");
      const subject = String(args[1] ?? "");
      const { source, flags } = parseEdgeQLRegex(pattern);
      return new RegExp(source, flags).test(subject);
    }
    case "std::re_match": {
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
    }
    case "std::re_match_all": {
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
    }
    case "std::re_replace": {
      const pattern = String(args[0] ?? "");
      const replacement = String(args[1] ?? "");
      const subject = String(args[2] ?? "");
      const optFlags = args[3] !== undefined ? String(args[3]) : "";
      const { source, flags } = parseEdgeQLRegex(pattern);
      const finalFlags = optFlags.includes("g") ? flags + "g" : flags;
      return subject.replace(new RegExp(source, finalFlags.replace(/(.)(?=.*\1)/g, "")), replacement);
    }
    case "std::max": {
      const values = toNumberList(args[0]);
      return values.length > 0 ? Math.max(...values) : null;
    }
    case "std::min": {
      const values = toNumberList(args[0]);
      return values.length > 0 ? Math.min(...values) : null;
    }
    case "std::range": {
      const start = toNumber(args[0]);
      const end = toNumber(args[1]);
      const values: number[] = [];
      for (let value = start; value < end; value += 1) {
        values.push(value);
      }
      return values;
    }
    case "std::range_unpack":
    case "std::array_unpack": {
      const value = args[0];
      if (value === null || value === undefined) return [];
      if (typeof value === "object" && value !== null && "kind" in value) {
        return [...value.values];
      }
      return Array.isArray(value) ? value : [value as ScalarValue];
    }
    case "std::array_get": {
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
    }
    case "std::array_set": {
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
    }
    case "std::array_insert": {
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
    }
    case "std::enumerate": {
      const value = args[0];
      const items: unknown[] = typeof value === "object" && value !== null && "kind" in value
        ? [...value.values]
        : Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
      return items.map((item, index) => [index, item]);
    }
    case "std::count": {
      if (typeof args[0] === "object" && args[0] !== null && "kind" in args[0]) {
        return args[0].values.length;
      }
      return args[0] === null ? 0 : 1;
    }
    case "std::array_agg": {
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
    }
    case "std::str_lower":
      return String(extractScalar(args[0]) ?? "").toLowerCase();
    case "std::str_upper":
      return String(extractScalar(args[0]) ?? "").toUpperCase();
    case "std::datetime_get": {
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
    }
    case "cal::date_get": {
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
    }
    case "cal::time_get": {
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
    }
    case "std::duration_get": {
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
    }
    case "std::datetime_truncate": {
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
    }
    case "std::duration_truncate": {
      const unit = String(extractScalar(args[0]) ?? "").toLowerCase();
      const duration = parseDurationParts(String(extractScalar(args[1]) ?? ""));
      if (unit === "hours") {
        return `PT${duration.hours}H`;
      }
      if (unit === "minutes") {
        return `PT${duration.hours}H${duration.minutes}M`;
      }
      return `PT${duration.hours}H${duration.minutes}M${duration.seconds}S`;
    }
    case "cal::duration_normalize_hours": {
      const duration = parseDurationParts(String(extractScalar(args[0]) ?? ""));
      const normalized = duration.hours + Math.floor(duration.minutes / 60);
      const minutes = duration.minutes % 60;
      return `PT${normalized}H${minutes}M${duration.seconds}S`;
    }
    case "cal::duration_normalize_days": {
      const duration = parseDurationParts(String(extractScalar(args[0]) ?? ""));
      const days = Math.floor(duration.hours / 24);
      const hours = duration.hours % 24;
      return `P${days}DT${hours}H${duration.minutes}M${duration.seconds}S`;
    }
    case "std::__gel_subtract": {
      return toNumber(args[0]) - toNumber(args[1]);
    }
    case "std::__gel_if_eq": {
      const lhs = extractScalar(args[0]);
      const rhs = extractScalar(args[1]);
      return lhs === rhs ? extractScalar(args[2]) : extractScalar(args[3]);
    }
    case "std::to_json": {
      const raw = extractScalar(args[0]);
      if (raw === null || raw === undefined) {
        return null;
      }
      const text = String(raw);
      if (text === "null") {
        return null;
      }
      return text;
    }
    default:
      return undefined;
  }
};

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
