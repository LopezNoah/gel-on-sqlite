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

export interface StdlibFunctionDef {
  name: string;
  minArgs: number;
  maxArgs: number;
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
  { name: "std::datetime_current", minArgs: 0, maxArgs: 0 },
  { name: "std::datetime_of_transaction", minArgs: 0, maxArgs: 0 },
  { name: "std::datetime_of_statement", minArgs: 0, maxArgs: 0 },
  { name: "std::to_datetime", minArgs: 1, maxArgs: 1 },
  // to_str accepts an optional format string for datetime / numeric inputs.
  { name: "std::to_str", minArgs: 1, maxArgs: 2 },
  { name: "std::len", minArgs: 1, maxArgs: 1 },
  { name: "std::count", minArgs: 1, maxArgs: 1 },
  { name: "std::max", minArgs: 1, maxArgs: 1 },
  { name: "std::min", minArgs: 1, maxArgs: 1 },
  { name: "std::sum", minArgs: 1, maxArgs: 1 },
  { name: "std::assert_exists", minArgs: 1, maxArgs: 1 },
  { name: "std::assert_single", minArgs: 1, maxArgs: 1 },
  { name: "std::assert_distinct", minArgs: 1, maxArgs: 1 },
  { name: "std::all", minArgs: 1, maxArgs: 1 },
  { name: "std::any", minArgs: 1, maxArgs: 1 },
  { name: "std::range", minArgs: 2, maxArgs: 2 },
  { name: "std::range_unpack", minArgs: 1, maxArgs: 1 },
  { name: "std::array_agg", minArgs: 1, maxArgs: 1 },
  { name: "std::array_unpack", minArgs: 1, maxArgs: 1 },
  { name: "std::array_get", minArgs: 2, maxArgs: 3 },
  { name: "std::array_set", minArgs: 3, maxArgs: 3 },
  { name: "std::array_insert", minArgs: 3, maxArgs: 3 },
  { name: "std::enumerate", minArgs: 1, maxArgs: 1 },
  { name: "std::str_lower", minArgs: 1, maxArgs: 1 },
  { name: "std::str_upper", minArgs: 1, maxArgs: 1 },
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
  { name: "std::to_json", minArgs: 1, maxArgs: 1 },
  { name: "std::random", minArgs: 0, maxArgs: 0 },
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
    const shortName = name.split("::").pop()!;
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
      return unaryNumeric(args[0], (value) => Math.acos(value));
    case "math::asin":
      return unaryNumeric(args[0], (value) => Math.asin(value));
    case "math::atan":
      return unaryNumeric(args[0], (value) => Math.atan(value));
    case "math::atan2":
      return Math.atan2(toNumber(args[0]), toNumber(args[1]));
    case "math::cos":
      return unaryNumeric(args[0], (value) => Math.cos(value));
    case "math::cot":
      return unaryNumeric(args[0], (value) => 1 / Math.tan(value));
    case "math::sin":
      return unaryNumeric(args[0], (value) => Math.sin(value));
    case "math::tan":
      return unaryNumeric(args[0], (value) => Math.tan(value));
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
        throw new Error("assert_exists violation");
      }
      return inner;
    }
    case "std::assert_single":
    case "std::assert_distinct":
      return typeof args[0] === "object" && args[0] !== null && "kind" in args[0] && args[0].kind === "set"
        ? args[0].values
        : args[0];
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
        throw new Error(`function "sum(arg0: std::str)" does not exist`);
      }
      if (Array.isArray(rawArg) && rawArg.some((v) => typeof v === "string")) {
        throw new Error(`function "sum(arg0: std::str)" does not exist`);
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
      const pattern = String(args[0] ?? "");
      const subject = String(args[1] ?? "");
      const { source, flags } = parseEdgeQLRegex(pattern);
      const match = new RegExp(source, flags).exec(subject);
      if (!match) return [];
      return match.length === 1 ? [match[0]] : match.slice(1);
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
      const idx = toNumber(args[1]);
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
      const normalized = idx < 0 ? Math.max(0, arr.length + idx) : Math.min(arr.length, idx);
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
      if (typeof args[0] === "object" && args[0] !== null && "kind" in args[0]) {
        return [...args[0].values];
      }
      return [args[0] as ScalarValue];
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
      return null;
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
      return null;
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
      return null;
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

const parseDateTime = (arg: RuntimeFunctionArg): string => {
  const scalar = extractScalar(arg);
  const date = new Date(String(scalar ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid datetime input");
  }
  return date.toISOString();
};

const parseLocalDateTime = (value: ScalarValue | null): string => {
  const text = String(value ?? "");
  if (!isValidLocalDateTime(text)) {
    throw new Error("Invalid local_datetime input");
  }
  return text;
};

const parseLocalDate = (value: ScalarValue | null): string => {
  const text = String(value ?? "");
  if (!isValidLocalDate(text)) {
    throw new Error("Invalid local_date input");
  }
  return text;
};

const parseLocalTime = (value: ScalarValue | null): string => {
  const text = String(value ?? "");
  if (!isValidLocalTime(text)) {
    throw new Error("Invalid local_time input");
  }
  return text;
};

const parseDuration = (value: ScalarValue | null): string => {
  const text = String(value ?? "");
  if (!/^[-+]?P/.test(text)) {
    throw new Error("Invalid duration input");
  }
  return text;
};

const parseDateComponents = (value: string): { year: number; month: number; day: number } => {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) {
    throw new Error("Invalid local_date input");
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
    throw new Error("Invalid local_time input");
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
    throw new Error("Invalid duration input");
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
