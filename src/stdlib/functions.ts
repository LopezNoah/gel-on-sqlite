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
  { name: "std::to_str", minArgs: 1, maxArgs: 1 },
  { name: "std::to_duration", minArgs: 1, maxArgs: 1 },
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
  const candidates = name.includes("::")
    ? [name]
    : [`${activeModule}::${name}`, `std::${name}`, `math::${name}`, `cal::${name}`];
  for (const candidate of candidates) {
    const hit = resolveStdlibFunction(candidate, arity);
    if (hit) {
      return hit;
    }
  }
  return undefined;
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
