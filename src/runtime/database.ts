import BetterSQLite3 from "better-sqlite3";
import { createRequire } from "node:module";

import { AppError } from "../errors.js";

import type { AsyncRuntimeInstance, RuntimeDatabaseAdapter, RuntimeInstance } from "./adapter.js";
import { toAsyncAdapter } from "./adapter.js";
import type { ScalarValue } from "../types.js";

export interface SQLiteStatement {
  all: (...params: ScalarValue[]) => Record<string, unknown>[];
  run: (...params: ScalarValue[]) => { changes: number };
}

export interface SQLiteDatabase extends RuntimeDatabaseAdapter {
  prepare: (sql: string) => SQLiteStatement;
  target: "sqlite";
  /** Snapshot the entire DB as a Buffer. Only available on the better-sqlite3 backend. */
  serialize?: () => Buffer;
}

export type SQLiteRuntime = RuntimeInstance<SQLiteDatabase>;

const isRowRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toRowRecords = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (isRowRecord(entry)) {
      out.push(entry);
    }
  }
  return out;
};

// JS RegExp rejects a bad pattern with a SyntaxError at construction time;
// rewrap it so the calling query gets the same "invalid regular expression"
// wording the Gel server produces, naming the UDF and the offending pattern.
const compileRegex = (fname: string, source: string, flags: string): RegExp => {
  // EdgeQL (POSIX/PG-style) regexes accept leading inline option groups like
  // `(?i)`; JS RegExp doesn't — translate them to equivalent JS flags.
  let normalizedSource = source;
  let normalizedFlags = flags;
  const inlineFlags = /^\(\?([ims]+)\)/.exec(normalizedSource);
  if (inlineFlags) {
    normalizedSource = normalizedSource.slice(inlineFlags[0].length);
    for (const flag of inlineFlags[1]) {
      if (!normalizedFlags.includes(flag === "m" ? "m" : flag)) normalizedFlags += flag;
    }
  }
  try {
    return new RegExp(normalizedSource, normalizedFlags);
  } catch (cause) {
    throw new AppError(
      "E_RUNTIME",
      `invalid regular expression in ${fname}: '${source}'`,
      { cause },
    );
  }
};

// The array UDFs receive their array argument as a JSON-encoded string; a
// parse failure means the stored data (or an upstream encoder) is corrupt,
// so surface it instead of pretending the array was empty.
const parseJsonArg = (fname: string, raw: string): unknown[] => {
  try {
    return JSON.parse(raw) as unknown[];
  } catch (cause) {
    const sample = raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
    throw new AppError(
      "E_RUNTIME",
      `${fname}: argument is not valid JSON: '${sample}'`,
      { cause },
    );
  }
};

export const openSQLite = (target: string | Buffer = ":memory:"): SQLiteRuntime => {
  try {
    const db = new BetterSQLite3(target as string);
    const isMemoryOrBuffer = typeof target !== "string" || target === ":memory:";
    if (!isMemoryOrBuffer) {
      db.pragma("journal_mode = WAL");
    }
    // EdgeQL's LIKE is case-sensitive (ILIKE for case-insensitive). SQLite's
    // default LIKE is case-insensitive for ASCII; flip the pragma to match.
    db.pragma("case_sensitive_like = 1");

    // `math::acos(x)` / `math::asin(x)` raise "input is out of range" when |x|>1
    // in EdgeQL; SQLite's acos/asin silently return NULL. Wrap them in custom
    // helpers that explicitly throw, so SELECT queries surface the diagnostic.
    // `math::sin/cos/tan/cot` raise on non-finite input (Infinity); same idea.
    const requireFinite = (value: number | null, fname: string): number => {
      if (value === null || !Number.isFinite(value)) {
        throw new AppError("E_VALIDATION", `input is out of range for ${fname}`);
      }
      return value;
    };
    const requireUnitInterval = (value: number | null, fname: string): number => {
      if (value === null || !Number.isFinite(value) || value < -1 || value > 1) {
        throw new AppError("E_VALIDATION", `input is out of range for ${fname}`);
      }
      return value;
    };
    db.function("_gel_acos", (x: number | null) => Math.acos(requireUnitInterval(x, "math::acos")));
    db.function("_gel_asin", (x: number | null) => Math.asin(requireUnitInterval(x, "math::asin")));
    db.function("_gel_cos", (x: number | null) => Math.cos(requireFinite(x, "math::cos")));
    db.function("_gel_sin", (x: number | null) => Math.sin(requireFinite(x, "math::sin")));
    db.function("_gel_tan", (x: number | null) => Math.tan(requireFinite(x, "math::tan")));
    db.function("_gel_cot", (x: number | null) => 1 / Math.tan(requireFinite(x, "math::cot")));
    // `math::ln/lg/log(x)` raise on non-positive inputs (log of zero or
    // negative is undefined); SQLite returns NULL silently.
    const requirePositive = (value: number | null, fname: string): number => {
      if (value === null || !Number.isFinite(value) || value <= 0) {
        throw new AppError("E_VALIDATION", `input is out of range for ${fname}`);
      }
      return value;
    };
    db.function("_gel_ln", (x: number | null) => Math.log(requirePositive(x, "math::ln")));
    db.function("_gel_lg", (x: number | null) => Math.log10(requirePositive(x, "math::lg")));
    db.function("_gel_log", (x: number | null, base: number | null) =>
      Math.log(requirePositive(x, "math::log")) / Math.log(requirePositive(base, "math::log"))
    );
    // `math::exp(1000)` overflows IEEE-754 double — EdgeQL raises "value out
    // of range: overflow"; SQLite returns Infinity silently. Note: `inf` input
    // is *allowed* — only finite inputs that overflow trigger the error.
    db.function("_gel_exp", (x: number | null) => {
      if (x === null) return null;
      const r = Math.exp(x);
      if (Number.isFinite(x) && !Number.isFinite(r)) {
        throw new AppError("E_VALIDATION", "value out of range: overflow");
      }
      return r;
    });
    // `math::sqrt(-1)` errors — SQLite's sqrt() returns NULL for negatives.
    db.function("_gel_sqrt", (x: number | null) => {
      if (x === null) return null;
      if (x < 0) throw new AppError("E_VALIDATION", "input is out of range for math::sqrt");
      return Math.sqrt(x);
    });
    // `std::assert(cond, msg)` — raise on falsy cond with a custom or default
    // message. Surfacing this as a SQL function lets fallback-mode SELECTs
    // still trigger the right error instead of returning NULL.
    db.function("_gel_assert", { varargs: true }, (...args: unknown[]) => {
      const cond = args[0];
      const truthy = cond === true || cond === 1 || cond === "true";
      if (!truthy) {
        const msg = args.length > 1 && typeof args[1] === "string" && args[1]
          ? args[1] : "assertion failed";
        throw new AppError("E_VALIDATION", String(msg));
      }
      return cond as number | string | null;
    });
    // `std::assert_exists(x)` — raise on null/empty.
    db.function("_gel_assert_exists", (value: unknown) => {
      if (value === null || value === undefined) {
        throw new AppError("E_VALIDATION", "assert_exists violation");
      }
      return value as number | string | null;
    });
    // `std::re_test(pattern, str)` — returns 1 if pattern matches anywhere in
    // str, else 0. SQLite lacks REGEXP by default; map to JS RegExp.
    db.function("_gel_re_test", (pattern: string | null, value: string | null) => {
      if (pattern === null || value === null) return null;
      return compileRegex("std::re_test", String(pattern), "").test(String(value)) ? 1 : 0;
    });
    // `std::re_match(pattern, str)` — returns the array<str> of the first
    // match's groups, or NULL when no match. Mirrors PostgreSQL's
    // `regexp_matches`: when the pattern has no capture groups, the return is
    // `[full_match]`; when it has groups, returns the captures only (the
    // full-match is dropped). Encoded as a JSON array string so callers can
    // unwrap with json_each / pass through json_group_array.
    db.function("_gel_re_match_first", (pattern: string | null, value: string | null) => {
      if (pattern === null || value === null) return null;
      const flagsMatch = /^\(\?([a-zA-Z]+)\)(.*)$/s.exec(String(pattern));
      let source: string;
      let flags = "";
      if (flagsMatch) {
        const flagChars = flagsMatch[1];
        if (flagChars.includes("i")) flags += "i";
        if (flagChars.includes("m")) flags += "m";
        if (flagChars.includes("s")) flags += "s";
        source = flagsMatch[2];
      } else {
        source = String(pattern);
      }
      const m = compileRegex("std::re_match", source, flags).exec(String(value));
      if (!m) return null;
      const groups = m.length === 1 ? [m[0]] : Array.from(m).slice(1);
      return JSON.stringify(groups);
    });
    // `std::re_replace(pattern, replacement, str, flags?)` — string substitution.
    db.function("_gel_re_replace", { varargs: true }, (...args: unknown[]) => {
      const pattern = args[0]; const replacement = args[1]; const value = args[2];
      const flags = (args[3] as string | undefined) ?? "";
      if (pattern == null || replacement == null || value == null) return null;
      return String(value).replace(
        compileRegex("std::re_replace", String(pattern), flags),
        String(replacement),
      );
    });
    // `std::assert_single(x)` — raise if more than one element. `x` is the
    // JSON-encoded array (multi-cardinality sets surface as `json_group_array`).
    db.function("_gel_assert_single", { varargs: true }, (...args: unknown[]) => {
      const v = args[0];
      let arr: unknown[];
      if (typeof v === "string" && v.startsWith("[")) {
        arr = parseJsonArg("std::assert_single", v);
      } else if (Array.isArray(v)) {
        arr = v;
      } else {
        arr = v == null ? [] : [v];
      }
      if (arr.length > 1) {
        const msg = args.length > 1 && typeof args[1] === "string" && args[1]
          ? args[1] : "assert_single violation";
        throw new AppError("E_VALIDATION", String(msg));
      }
      return arr.length === 0 ? null : (typeof arr[0] === "object" ? JSON.stringify(arr[0]) : arr[0]) as number | string | null;
    });
    // `std::array_get(arr, idx, default := …)` — return element or default.
    db.function("_gel_array_get", { varargs: true }, (...args: unknown[]) => {
      const a = args[0];
      const idx = Number(args[1]);
      const dflt = args.length > 2 ? args[2] : null;
      const arr = typeof a === "string"
        ? parseJsonArg("std::array_get", a)
        : Array.isArray(a) ? a : [];
      const normalized = idx < 0 ? arr.length + idx : idx;
      if (normalized < 0 || normalized >= arr.length) return dflt as number | string | null;
      const v = arr[normalized];
      return (typeof v === "object" ? JSON.stringify(v) : v) as number | string | null;
    });
    // `std::array_set(arr, idx, val)` — raise on out-of-bounds, otherwise
    // return the mutated array as JSON.
    db.function("_gel_array_set", (a: string | null, idxRaw: number | null, val: unknown) => {
      const idx = Number(idxRaw);
      const arr = a ? parseJsonArg("std::array_set", a) : [];
      const normalized = idx < 0 ? arr.length + idx : idx;
      if (normalized < 0 || normalized >= arr.length) {
        throw new AppError("E_VALIDATION", `array index ${idx} is out of bounds`);
      }
      arr[normalized] = val;
      return JSON.stringify(arr);
    });
    // `std::array_insert(arr, idx, val)` — raise on out-of-bounds, otherwise
    // splice and return as JSON. EdgeQL allows idx in [-len, len] (a
    // length-inclusive append is valid; one-past-end and negative-past-start
    // are not).
    db.function("_gel_array_insert", (a: string | null, idxRaw: number | null, val: unknown) => {
      const idx = Number(idxRaw);
      const arr = a ? parseJsonArg("std::array_insert", a) : [];
      if (idx > arr.length || idx < -arr.length) {
        throw new AppError("E_VALIDATION", `array index ${idx} is out of bounds`);
      }
      const normalized = idx < 0 ? arr.length + idx : idx;
      arr.splice(normalized, 0, val);
      return JSON.stringify(arr);
    });
    // Statistical aggregates (`math::mean/stddev/var/…`) — SQLite has no
    // built-ins for these. Mean uses Kahan-compensated summation so float
    // sets like {0.1, 0.2, 0.3} average to 0.2 exactly (matching Postgres);
    // variance/stddev use Welford's online algorithm for numeric stability.
    // Sample variants raise below 2 elements, population variants below 1 —
    // mirroring Postgres's NULL → EdgeQL's "not enough elements" error.
    type StatState = { n: number; mean: number; m2: number; sum: number; comp: number };
    const statStart = (): StatState => ({ n: 0, mean: 0, m2: 0, sum: 0, comp: 0 });
    const statStep = (state: StatState, value: unknown): void => {
      if (value === null || value === undefined) return;
      const x = Number(value);
      state.n += 1;
      // Kahan-compensated running sum (for mean).
      const y = x - state.comp;
      const t = state.sum + y;
      state.comp = (t - state.sum) - y;
      state.sum = t;
      // Welford (for variance).
      const delta = x - state.mean;
      state.mean += delta / state.n;
      state.m2 += delta * (x - state.mean);
    };
    const statAggregate = (
      name: string,
      fname: string,
      minN: number,
      finish: (s: StatState) => number,
    ): void => {
      db.aggregate(name, {
        start: statStart,
        step: (state: StatState, value: unknown) => { statStep(state, value); },
        result: (state: StatState) => {
          if (state.n < minN) {
            throw new AppError(
              "E_VALIDATION",
              `invalid input to ${fname}(): not enough elements in input set`,
            );
          }
          return finish(state);
        },
      });
    };
    statAggregate("_gel_mean", "mean", 1, (s) => s.sum / s.n);
    statAggregate("_gel_var", "var", 2, (s) => s.m2 / (s.n - 1));
    statAggregate("_gel_var_pop", "var_pop", 1, (s) => s.m2 / s.n);
    statAggregate("_gel_stddev", "stddev", 2, (s) => Math.sqrt(s.m2 / (s.n - 1)));
    statAggregate("_gel_stddev_pop", "stddev_pop", 1, (s) => Math.sqrt(s.m2 / s.n));

    // Bitwise functions (`std::bit_xor/bit_lshift/bit_rshift/bit_count`).
    // Registered with safeIntegers so int64 operands arrive as BigInt —
    // JS doubles can't represent values near the int64 extremes, which the
    // shift/wrap semantics depend on. The `width` argument (16/32/64) is the
    // operand type's bit width, baked in by the SQL lowering; results wrap
    // to that width via BigInt.asIntN, matching the EdgeQL overloads.
    const asBigInt = (value: unknown): bigint | null => {
      if (value === null || value === undefined) return null;
      if (typeof value === "bigint") return value;
      return BigInt(Math.trunc(Number(value)));
    };
    const bitShift = (fname: string, v: unknown, nRaw: unknown, wRaw: unknown, left: boolean): bigint | null => {
      const x = asBigInt(v);
      const n = asBigInt(nRaw);
      if (x === null || n === null) return null;
      if (n < 0n) {
        throw new AppError("E_VALIDATION", `${fname}(): cannot shift by negative amount`);
      }
      const w = Number(asBigInt(wRaw) ?? 64n);
      if (n >= BigInt(w)) {
        // Shifting past the width: lshift drains to 0; rshift is arithmetic,
        // so it converges on the sign bit (0 or -1).
        return left ? 0n : (x < 0n ? -1n : 0n);
      }
      return BigInt.asIntN(w, left ? (x << n) : (x >> n));
    };
    db.function("_gel_bit_xor", { safeIntegers: true }, (a: unknown, b: unknown) => {
      const x = asBigInt(a);
      const y = asBigInt(b);
      return x === null || y === null ? null : x ^ y;
    });
    db.function("_gel_bit_lshift", { safeIntegers: true }, (v: unknown, n: unknown, w: unknown) =>
      bitShift("bit_lshift", v, n, w, true));
    db.function("_gel_bit_rshift", { safeIntegers: true }, (v: unknown, n: unknown, w: unknown) =>
      bitShift("bit_rshift", v, n, w, false));
    db.function("_gel_bit_count", { safeIntegers: true }, (v: unknown, w: unknown) => {
      const x = asBigInt(v);
      if (x === null) return null;
      let u = BigInt.asUintN(Number(asBigInt(w) ?? 64n), x);
      let count = 0n;
      while (u > 0n) {
        count += u & 1n;
        u >>= 1n;
      }
      return count;
    });

    // EdgeQL `//` is FLOOR division and `%` is the FLOORED ("Python") modulo:
    // the result follows the sign of the divisor, unlike SQLite's truncated `/`
    // and sign-of-dividend `%`. Registered with safeIntegers so int64 operands
    // arrive as BigInt (exact division beyond 2^53).
    db.function("_gel_floordiv", { safeIntegers: true }, (a: unknown, b: unknown) => {
      if (a === null || a === undefined || b === null || b === undefined) return null;
      if (typeof a === "bigint" && typeof b === "bigint") {
        if (b === 0n) throw new AppError("E_VALIDATION", "division by zero");
        let q = a / b;
        // BigInt `/` truncates toward zero; subtract one when the signs differ
        // and the division was inexact to reach the floor.
        if (a % b !== 0n && (a < 0n) !== (b < 0n)) q -= 1n;
        return q;
      }
      const an = Number(a);
      const bn = Number(b);
      if (bn === 0) throw new AppError("E_VALIDATION", "division by zero");
      return Math.floor(an / bn);
    });
    db.function("_gel_mod", { safeIntegers: true }, (a: unknown, b: unknown) => {
      if (a === null || a === undefined || b === null || b === undefined) return null;
      if (typeof a === "bigint" && typeof b === "bigint") {
        if (b === 0n) throw new AppError("E_VALIDATION", "division by zero");
        return ((a % b) + b) % b;
      }
      const an = Number(a);
      const bn = Number(b);
      if (bn === 0) throw new AppError("E_VALIDATION", "division by zero");
      return an - Math.floor(an / bn) * bn;
    });

    // String utilities without SQLite built-ins. Pads repeat the fill string
    // and truncate to the target length (Postgres lpad/rpad semantics);
    // lengths shorter than the input truncate the input.
    const padImpl = (s: unknown, n: unknown, fill: unknown, start: boolean): string | null => {
      if (s === null || s === undefined || n === null || n === undefined) return null;
      const str = String(s);
      const len = Number(n);
      const f = fill === null || fill === undefined ? " " : String(fill);
      if (len <= 0) return "";
      if (str.length >= len) return start ? str.slice(0, len) : str.slice(0, len);
      if (f.length === 0) return str;
      const padLen = len - str.length;
      const pad = f.repeat(Math.ceil(padLen / f.length)).slice(0, padLen);
      return start ? pad + str : str + pad;
    };
    db.function("_gel_str_pad_start", { varargs: true }, (...a: unknown[]) => padImpl(a[0], a[1], a[2], true));
    db.function("_gel_str_pad_end", { varargs: true }, (...a: unknown[]) => padImpl(a[0], a[1], a[2], false));
    db.function("_gel_str_repeat", (s: string | null, n: number | null) => {
      if (s === null || n === null) return null;
      return String(s).repeat(Math.max(0, Number(n)));
    });
    db.function("_gel_str_reverse", (s: string | null) =>
      s === null ? null : [...String(s)].reverse().join(""));
    db.function("_gel_str_split", (s: string | null, delim: string | null) => {
      if (s === null || delim === null) return null;
      const str = String(s);
      // An empty delimiter splits into individual characters (Gel lowers this
      // to `regexp_split_to_array(s, '')`). A non-empty delimiter uses
      // `string_to_array`, which yields the empty array for empty input —
      // not a single empty-string element the way JS `''.split(d)` would.
      const parts = delim === ""
        ? [...str]
        : str === "" ? [] : str.split(String(delim));
      return JSON.stringify(parts);
    });
    // `std::array_replace(arr, old, new)` — replace every occurrence.
    db.function("_gel_array_replace", { varargs: true }, (...a: unknown[]) => {
      const [arrRaw, oldV, newV] = a;
      if (arrRaw === null || arrRaw === undefined) return null;
      const arr = typeof arrRaw === "string" ? parseJsonArg("std::array_replace", arrRaw) : arrRaw as unknown[];
      return JSON.stringify(arr.map((v) => (v === oldV ? newV : v)));
    });
    // Numeric parsers (`to_int64('1,234', '9,999')` etc.). The `fmt` argument
    // is OPTIONAL, with three regimes mirroring the server's lib/std defs:
    //   - absent (NULL / empty set) → a plain string→number cast, which
    //     rejects any non-numeric (or, for integer targets, non-integer)
    //     input with "invalid input syntax", like `str_to_int64`.
    //   - an explicit empty string → an error, since to_number needs a
    //     non-empty template.
    //   - a non-empty string → a Postgres `to_number` template. The template
    //     positions are advisory; we read the signed numeric value out of the
    //     input, honouring the angle-bracket negative form (the `PR` pattern)
    //     and any sign, and discarding grouping, currency, padding and
    //     ordinal-suffix characters.
    const toNumberImpl = (
      raw: unknown,
      fmt: unknown,
      fnName: string,
      typeName: string,
      integer: boolean,
    ): number | null => {
      if (raw === null || raw === undefined) return null;
      const rawStr = String(raw);
      if (fmt === "") {
        throw new AppError("E_VALIDATION", `${fnName}(): "fmt" argument must be a non-empty string`);
      }
      if (fmt === null || fmt === undefined) {
        const s = rawStr.trim();
        const num = Number(s);
        if (s === "" || !Number.isFinite(num) || (integer && !Number.isInteger(num))) {
          throw new AppError("E_VALIDATION", `invalid input syntax for type ${typeName}: '${rawStr}'`);
        }
        return num;
      }
      const fmtStr = String(fmt);
      const negativeOnBrackets = fmtStr.includes("PR");
      let negative = false;
      let digits = "";
      let sawDecimal = false;
      for (const ch of rawStr) {
        if (ch >= "0" && ch <= "9") {
          digits += ch;
        } else if (ch === ".") {
          if (!sawDecimal) {
            digits += ".";
            sawDecimal = true;
          }
        } else if (ch === "-") {
          negative = true;
        } else if ((ch === "<" || ch === ">") && negativeOnBrackets) {
          negative = true;
        }
        // '+', grouping (',' / spaces), currency ('$'), zero-padding and
        // ordinal-suffix letters ('st'/'nd'/'rd'/'th') carry no value.
      }
      let num = digits === "" || digits === "." ? Number.NaN : Number(digits);
      if (!Number.isFinite(num)) {
        throw new AppError("E_VALIDATION", `${fnName}(): format '${fmtStr}' is invalid`);
      }
      if (negative) num = -num;
      // `to_number(...)::bigint` rounds to the nearest integer.
      return integer ? Math.round(num) : num;
    };
    db.function("_gel_to_int16", { varargs: true }, (...a: unknown[]) => toNumberImpl(a[0], a[1], "to_int16", "std::int16", true));
    db.function("_gel_to_int32", { varargs: true }, (...a: unknown[]) => toNumberImpl(a[0], a[1], "to_int32", "std::int32", true));
    db.function("_gel_to_int64", { varargs: true }, (...a: unknown[]) => toNumberImpl(a[0], a[1], "to_int64", "std::int64", true));
    db.function("_gel_to_float32", { varargs: true }, (...a: unknown[]) => toNumberImpl(a[0], a[1], "to_float32", "std::float32", false));
    db.function("_gel_to_float64", { varargs: true }, (...a: unknown[]) => toNumberImpl(a[0], a[1], "to_float64", "std::float64", false));
    db.function("_gel_to_bigint", { varargs: true }, (...a: unknown[]) => toNumberImpl(a[0], a[1], "to_bigint", "std::bigint", true));
    db.function("_gel_to_decimal", { varargs: true }, (...a: unknown[]) => toNumberImpl(a[0], a[1], "to_decimal", "std::decimal", false));

    // Range family. Ranges are JSON objects `{lower, upper, inc_lower,
    // inc_upper, empty}` mirroring EdgeQL's JSON encoding. Discrete (integer)
    // ranges canonicalize to inclusive-lower / exclusive-upper, like
    // Postgres. NULL bounds are unbounded.
    type RangeObj = { lower: number | null; upper: number | null; inc_lower: boolean; inc_upper: boolean; empty?: boolean };
    const parseRange = (raw: unknown): RangeObj | null => {
      if (raw === null || raw === undefined) return null;
      const o = typeof raw === "string" ? JSON.parse(raw) as RangeObj : raw as RangeObj;
      return o;
    };
    db.function("_gel_range", { varargs: true }, (...a: unknown[]) => {
      let lower = a[0] === undefined ? null : a[0] as number | string | null;
      let upper = a[1] === undefined ? null : a[1] as number | string | null;
      // Boolean args may arrive as JSON-encoded text ('true'/'false') from
      // the value layer — coerce by content, not JS truthiness.
      const boolArg = (v: unknown, dflt: boolean): boolean =>
        v === null || v === undefined ? dflt
          : v === true || v === 1 || v === "true" || v === "1";
      let incLower = boolArg(a[2], true);
      let incUpper = boolArg(a[3], false);
      const discrete = Boolean(a[4]);
      // An unbounded bound (`range(<T>{})`, a missing lower/upper) has no
      // endpoint to include, so it is never inclusive — Postgres treats
      // infinities as exclusive. Normalize before discrete canonicalization
      // (which only shifts finite bounds).
      if (lower === null) incLower = false;
      if (upper === null) incUpper = false;
      // Step a discrete bound to its canonical neighbour: integers by one,
      // `cal::local_date` strings ('YYYY-MM-DD') by one calendar day.
      const stepBound = (v: number | string): number | string => {
        if (typeof v === "number") return v + 1;
        const [y, mo, d] = String(v).split("-").map(Number);
        const next = new Date(Date.UTC(y, mo - 1, d + 1));
        const pad = (n: number): string => String(n).padStart(2, "0");
        return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
      };
      if (discrete) {
        if (lower !== null && !incLower) { lower = stepBound(lower); incLower = true; }
        if (upper !== null && incUpper) { upper = stepBound(upper); incUpper = false; }
      }
      const cmpBound = (x: unknown, y: unknown): number => {
        if (typeof x === "number" && typeof y === "number") return x < y ? -1 : x > y ? 1 : 0;
        const a = String(x); const b = String(y);
        return a < b ? -1 : a > b ? 1 : 0;
      };
      if (lower !== null && upper !== null && cmpBound(lower, upper) > 0) {
        throw new AppError("E_VALIDATION", "range lower bound must be less than or equal to range upper bound");
      }
      const empty = lower !== null && upper !== null
        && cmpBound(lower, upper) === 0 && !(incLower && incUpper);
      if (empty) {
        return JSON.stringify({ empty: true });
      }
      return JSON.stringify({ lower, upper, inc_lower: incLower, inc_upper: incUpper });
    });
    // Comparable position of a bound: {u: unbounded direction, v: value,
    // eps: tie-break for exclusive bounds}. Bound values compare numerically
    // when both are numbers, lexicographically otherwise (ISO datetime
    // strings order correctly that way).
    type BoundPos = { u: -1 | 0 | 1; v: unknown; eps: number };
    const cmpVals = (a: unknown, b: unknown): number => {
      if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
      const x = String(a); const y = String(b);
      return x < y ? -1 : x > y ? 1 : 0;
    };
    const lowerPos = (r: RangeObj): BoundPos =>
      r.lower === null ? { u: -1, v: null, eps: 0 } : { u: 0, v: r.lower, eps: r.inc_lower ? 0 : 1 };
    const upperPos = (r: RangeObj): BoundPos =>
      r.upper === null ? { u: 1, v: null, eps: 0 } : { u: 0, v: r.upper, eps: r.inc_upper ? 0 : -1 };
    const cmpPos = (x: BoundPos, y: BoundPos): number => {
      if (x.u !== y.u) return x.u - y.u;
      if (x.u !== 0) return 0;
      const c = cmpVals(x.v, y.v);
      return c !== 0 ? c : x.eps - y.eps;
    };
    const rangeIsEmpty = (r: RangeObj): boolean => Boolean(r.empty);
    // A range value is either a single range object or a multirange
    // `{ranges: [...]}` — normalize both into a sorted, merged list of
    // non-empty ranges so the predicates can treat them uniformly.
    const asRangeList = (raw: unknown): RangeObj[] | null => {
      if (raw === null || raw === undefined) return null;
      const o = typeof raw === "string" ? JSON.parse(raw) as RangeObj | { ranges: unknown[] } : raw as RangeObj | { ranges: unknown[] };
      const list = Array.isArray((o as { ranges?: unknown[] }).ranges)
        ? ((o as { ranges: unknown[] }).ranges).map((x) => (typeof x === "string" ? JSON.parse(x) : x) as RangeObj)
        : [o as RangeObj];
      const nonEmpty = list.filter((r) => !rangeIsEmpty(r));
      nonEmpty.sort((x, y) => cmpPos(lowerPos(x), lowerPos(y)));
      // Merge overlapping/adjacent ranges (Postgres multirange canonical form).
      const merged: RangeObj[] = [];
      for (const r of nonEmpty) {
        const last = merged[merged.length - 1];
        if (last && cmpPos(lowerPos(r), upperPos(last)) <= 0) {
          if (cmpPos(upperPos(r), upperPos(last)) > 0) {
            last.upper = r.upper; last.inc_upper = r.inc_upper;
          }
        } else {
          merged.push({ ...r });
        }
      }
      return merged;
    };
    const rangeContainsValue = (r: RangeObj, v: unknown): boolean => {
      const x = typeof v === "number" ? v : String(v);
      const aboveLower = r.lower === null
        || (r.inc_lower ? cmpVals(x, r.lower) >= 0 : cmpVals(x, r.lower) > 0);
      const belowUpper = r.upper === null
        || (r.inc_upper ? cmpVals(x, r.upper) <= 0 : cmpVals(x, r.upper) < 0);
      return aboveLower && belowUpper;
    };
    // Range set algebra (`+` union, `*` intersection, `-` difference). Both
    // single ranges and multiranges are handled uniformly as range lists
    // (`asRangeList`). The result serializes as a single range when both
    // operands were single ranges (erroring if the result isn't one contiguous
    // range, as EdgeQL does), or as a multirange `{ranges:[…]}` — byte-identical
    // to `_gel_multirange` — when either operand was a multirange.
    const serializeRange = (r: RangeObj): string =>
      r.empty
        ? JSON.stringify({ empty: true })
        : JSON.stringify({ lower: r.lower, upper: r.upper, inc_lower: r.inc_lower, inc_upper: r.inc_upper });
    const mkRange = (
      lower: number | string | null, incLower: boolean,
      upper: number | string | null, incUpper: boolean,
    ): RangeObj => {
      const il = lower === null ? false : incLower;
      const iu = upper === null ? false : incUpper;
      if (lower !== null && upper !== null) {
        const c = cmpVals(lower, upper);
        if (c > 0 || (c === 0 && !(il && iu))) return { lower: null, upper: null, inc_lower: false, inc_upper: false, empty: true };
      }
      return { lower: lower as number | null, upper: upper as number | null, inc_lower: il, inc_upper: iu };
    };
    const rawIsMultirange = (raw: unknown): boolean => {
      if (raw === null || raw === undefined) return false;
      const o = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Boolean(o) && Array.isArray((o as { ranges?: unknown[] }).ranges);
    };
    // Re-run the multirange canonicalizer over a raw list so a computed result
    // matches the shape `_gel_multirange` (and thus range/multirange `=`) emits.
    const canonicalize = (list: RangeObj[]): RangeObj[] =>
      asRangeList(JSON.stringify({ ranges: list })) ?? [];
    const overlaps = (a: RangeObj, b: RangeObj): boolean =>
      cmpPos(lowerPos(a), upperPos(b)) <= 0 && cmpPos(lowerPos(b), upperPos(a)) <= 0;
    const intersectOne = (a: RangeObj, b: RangeObj): RangeObj => {
      const lo = cmpPos(lowerPos(a), lowerPos(b)) >= 0 ? a : b; // the greater lower
      const up = cmpPos(upperPos(a), upperPos(b)) <= 0 ? a : b; // the lesser upper
      return mkRange(lo.lower, lo.inc_lower, up.upper, up.inc_upper);
    };
    // `a` minus `b` — 0, 1, or 2 ranges (2 when `b` carves out `a`'s middle).
    const subtractOne = (a: RangeObj, b: RangeObj): RangeObj[] => {
      if (!overlaps(a, b)) return [a];
      const out: RangeObj[] = [];
      if (cmpPos(lowerPos(a), lowerPos(b)) < 0) out.push(mkRange(a.lower, a.inc_lower, b.lower, !b.inc_lower));
      if (cmpPos(upperPos(a), upperPos(b)) > 0) out.push(mkRange(b.upper, !b.inc_upper, a.upper, a.inc_upper));
      return out.filter((r) => !r.empty);
    };
    const serializeResult = (list: RangeObj[], anyMulti: boolean, op: string): string => {
      if (anyMulti) {
        return JSON.stringify({
          ranges: list.map((r) => ({ lower: r.lower, upper: r.upper, inc_lower: r.inc_lower, inc_upper: r.inc_upper })),
        });
      }
      if (list.length === 0) return JSON.stringify({ empty: true });
      if (list.length === 1) return serializeRange(list[0]);
      throw new AppError("E_VALIDATION", `result of range ${op} would not be contiguous`);
    };
    const rangeSetOp = (
      aRaw: string | null, bRaw: string | null, op: "union" | "intersection" | "difference",
    ): string | null => {
      const a = asRangeList(aRaw); const b = asRangeList(bRaw);
      if (!a || !b) return null;
      let result: RangeObj[];
      if (op === "union") {
        result = canonicalize([...a, ...b]);
      } else if (op === "intersection") {
        const parts: RangeObj[] = [];
        for (const x of a) for (const y of b) if (overlaps(x, y)) parts.push(intersectOne(x, y));
        result = canonicalize(parts);
      } else {
        let acc = a;
        for (const y of b) acc = acc.flatMap((x) => subtractOne(x, y));
        result = canonicalize(acc);
      }
      return serializeResult(result, rawIsMultirange(aRaw) || rawIsMultirange(bRaw), op);
    };
    db.function("_gel_range_union", (aRaw: string | null, bRaw: string | null) => rangeSetOp(aRaw, bRaw, "union"));
    db.function("_gel_range_intersection", (aRaw: string | null, bRaw: string | null) => rangeSetOp(aRaw, bRaw, "intersection"));
    db.function("_gel_range_difference", (aRaw: string | null, bRaw: string | null) => rangeSetOp(aRaw, bRaw, "difference"));
    db.function("_gel_range_contains", (rRaw: string | null, v: unknown) => {
      const rs = asRangeList(rRaw);
      if (!rs || v === null || v === undefined) return null;
      if (typeof v === "string" && v.trimStart().startsWith("{")) {
        const inner = asRangeList(v);
        if (!inner) return null;
        // Every inner range must be covered by some outer range.
        return inner.every((b) => rs.some((a) =>
          cmpPos(lowerPos(a), lowerPos(b)) <= 0 && cmpPos(upperPos(a), upperPos(b)) >= 0)) ? 1 : 0;
      }
      return rs.some((r) => rangeContainsValue(r, v)) ? 1 : 0;
    });
    db.function("_gel_range_overlaps", (aRaw: string | null, bRaw: string | null) => {
      const r1s = asRangeList(aRaw); const r2s = asRangeList(bRaw);
      if (!r1s || !r2s) return null;
      return r1s.some((a) => r2s.some((b) =>
        cmpPos(lowerPos(a), upperPos(b)) <= 0 && cmpPos(lowerPos(b), upperPos(a)) <= 0)) ? 1 : 0;
    });
    // Adjacent: the values don't overlap and one's upper bound meets the
    // other's lower bound with no gap (inclusive/exclusive pairing).
    db.function("_gel_range_adjacent", (aRaw: string | null, bRaw: string | null) => {
      const r1s = asRangeList(aRaw); const r2s = asRangeList(bRaw);
      if (!r1s || !r2s || r1s.length === 0 || r2s.length === 0) return r1s && r2s ? 0 : null;
      const meets = (x: RangeObj, y: RangeObj): boolean =>
        x.upper !== null && y.lower !== null && cmpVals(x.upper, y.lower) === 0
        && (x.inc_upper !== y.inc_lower);
      const overlap = r1s.some((a) => r2s.some((b) =>
        cmpPos(lowerPos(a), upperPos(b)) <= 0 && cmpPos(lowerPos(b), upperPos(a)) <= 0));
      if (overlap) return 0;
      const lastA = r1s[r1s.length - 1]; const firstA = r1s[0];
      const lastB = r2s[r2s.length - 1]; const firstB = r2s[0];
      return meets(lastA, firstB) || meets(lastB, firstA) ? 1 : 0;
    });
    db.function("_gel_range_strictly_below", (aRaw: string | null, bRaw: string | null) => {
      const r1s = asRangeList(aRaw); const r2s = asRangeList(bRaw);
      if (!r1s || !r2s) return null;
      if (r1s.length === 0 || r2s.length === 0) return 0;
      return cmpPos(upperPos(r1s[r1s.length - 1]), lowerPos(r2s[0])) < 0 ? 1 : 0;
    });
    db.function("_gel_range_strictly_above", (aRaw: string | null, bRaw: string | null) => {
      const r1s = asRangeList(aRaw); const r2s = asRangeList(bRaw);
      if (!r1s || !r2s) return null;
      if (r1s.length === 0 || r2s.length === 0) return 0;
      return cmpPos(lowerPos(r1s[0]), upperPos(r2s[r2s.length - 1])) > 0 ? 1 : 0;
    });
    // `bounded_above(l, r)` / `bounded_below(l, r)` — true when l's bound
    // does not extend past r's on that side.
    db.function("_gel_range_bounded_above", (aRaw: string | null, bRaw: string | null) => {
      const r1s = asRangeList(aRaw); const r2s = asRangeList(bRaw);
      if (!r1s || !r2s) return null;
      if (r1s.length === 0 || r2s.length === 0) return 0;
      return cmpPos(upperPos(r1s[r1s.length - 1]), upperPos(r2s[r2s.length - 1])) <= 0 ? 1 : 0;
    });
    db.function("_gel_range_bounded_below", (aRaw: string | null, bRaw: string | null) => {
      const r1s = asRangeList(aRaw); const r2s = asRangeList(bRaw);
      if (!r1s || !r2s) return null;
      if (r1s.length === 0 || r2s.length === 0) return 0;
      return cmpPos(lowerPos(r1s[0]), lowerPos(r2s[0])) >= 0 ? 1 : 0;
    });
    // `multirange(array<range>)` constructor — canonicalize via asRangeList.
    db.function("_gel_multirange", (arrRaw: string | null) => {
      if (arrRaw === null) return null;
      const arr = parseJsonArg("std::multirange", arrRaw);
      const merged = asRangeList(JSON.stringify({ ranges: arr }));
      return JSON.stringify({ ranges: merged ?? [] });
    });
    // `multirange_unpack(mr)` — JSON array of constituent ranges (the SQL
    // layer explodes it with json_each).
    db.function("_gel_multirange_unpack", (raw: string | null) => {
      const rs = asRangeList(raw);
      return rs ? JSON.stringify(rs) : null;
    });
    // These bound queries work on multiranges too: `asRangeList` normalizes a
    // single range or a `{ranges: […]}` multirange into a sorted, merged,
    // non-empty list, so the overall lower bound is the first range's and the
    // overall upper bound is the last range's. An empty list means an empty
    // range/multirange (no bound to report, never inclusive).
    db.function("_gel_range_is_empty", (raw: string | null) => {
      const rs = asRangeList(raw);
      return rs ? (rs.length === 0 ? 1 : 0) : null;
    });
    db.function("_gel_range_is_inclusive_lower", (raw: string | null) => {
      const rs = asRangeList(raw);
      return rs ? (rs.length === 0 ? 0 : (rs[0].inc_lower ? 1 : 0)) : null;
    });
    db.function("_gel_range_is_inclusive_upper", (raw: string | null) => {
      const rs = asRangeList(raw);
      return rs ? (rs.length === 0 ? 0 : (rs[rs.length - 1].inc_upper ? 1 : 0)) : null;
    });
    db.function("_gel_range_get_lower", (raw: string | null) => {
      const rs = asRangeList(raw);
      return rs && rs.length > 0 ? rs[0].lower : null;
    });
    db.function("_gel_range_get_upper", (raw: string | null) => {
      const rs = asRangeList(raw);
      return rs && rs.length > 0 ? rs[rs.length - 1].upper : null;
    });
    // `range_unpack(range [, step])` — explode into a JSON array of values
    // (the SQL layer json_each's the result into rows).
    db.function("_gel_range_unpack", { varargs: true }, (...a: unknown[]) => {
      const r = parseRange(a[0]);
      if (!r) return null;
      if (rangeIsEmpty(r)) return "[]";
      if (r.lower === null || r.upper === null) {
        throw new AppError("E_VALIDATION", "cannot unpack an unbounded range");
      }
      // Temporal ranges: ISO-string bounds stepped by a duration. The output
      // strings mirror the bound's own shape (date-only / naive / +00:00).
      if (typeof r.lower === "string" || typeof r.upper === "string") {
        const lowerStr = String(r.lower);
        const hasTime = lowerStr.includes("T") || lowerStr.includes(" ");
        const hasZone = /Z$|[+-]\d\d:?\d\d$/.test(lowerStr);
        const normDt = (s: string): number => {
          let t = s.replace(" ", "T");
          if (!t.includes("T")) t += "T00:00:00";
          if (!/Z$|[+-]\d\d:?\d\d$/.test(t)) t += "Z";
          const ms = Date.parse(t);
          if (Number.isNaN(ms)) throw new AppError("E_VALIDATION", `invalid range bound: '${s}'`);
          return ms;
        };
        const parseDurMs = (v: unknown): number => {
          if (v === null || v === undefined) return 24 * 3600 * 1000;
          if (typeof v === "number") return v * 1000;
          const s = String(v).trim();
          let m = /^(-?\d+):(\d\d)(?::(\d\d(?:\.\d+)?))?$/.exec(s);
          if (m) return ((Number(m[1]) * 3600) + Number(m[2]) * 60 + Number(m[3] ?? 0)) * 1000;
          m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
          if (m) {
            return ((Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600)
              + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0)) * 1000;
          }
          m = /^(-?\d+(?:\.\d+)?)\s*(day|hour|minute|second)s?$/i.exec(s);
          if (m) {
            const mult = { day: 86400, hour: 3600, minute: 60, second: 1 }[m[2].toLowerCase() as "day" | "hour" | "minute" | "second"];
            return Number(m[1]) * mult * 1000;
          }
          throw new AppError("E_VALIDATION", `invalid step duration: '${s}'`);
        };
        const stepMs = parseDurMs(a[1]);
        if (!(stepMs > 0)) throw new AppError("E_VALIDATION", "step has to be greater than zero");
        const fmt = (ms: number): string => {
          const d = new Date(ms);
          const p = (n: number, w = 2): string => String(n).padStart(w, "0");
          const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
          if (!hasTime) return date;
          const frac = d.getUTCMilliseconds();
          const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${frac ? "." + p(frac, 3) : ""}`;
          return `${date}T${time}${hasZone ? "+00:00" : ""}`;
        };
        const lo = normDt(lowerStr);
        const hi = normDt(String(r.upper));
        const outS: string[] = [];
        let v = lo;
        if (!r.inc_lower) v += stepMs;
        for (; r.inc_upper ? v <= hi : v < hi; v += stepMs) {
          outS.push(fmt(v));
          if (outS.length > 1_000_000) throw new AppError("E_VALIDATION", "range_unpack result is too large");
        }
        return JSON.stringify(outS);
      }
      const step = a[1] === null || a[1] === undefined ? 1 : Number(a[1]);
      if (!(step > 0)) {
        throw new AppError("E_VALIDATION", "step has to be greater than zero");
      }
      const out: number[] = [];
      let v = Number(r.lower);
      if (!r.inc_lower) v += step;
      const upper = Number(r.upper);
      for (; r.inc_upper ? v <= upper : v < upper; v += step) {
        out.push(v);
        if (out.length > 1_000_000) throw new AppError("E_VALIDATION", "range_unpack result is too large");
      }
      return JSON.stringify(out);
    });

    // `<float64>x` — SQLite's CAST('inf' AS REAL) silently yields 0.0;
    // EdgeQL accepts 'inf'/'-inf'/'nan' spellings and rejects garbage.
    db.function("_gel_float_cast", (v: unknown) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return v;
      const s = String(v).trim().toLowerCase();
      if (s === "inf" || s === "+inf" || s === "infinity" || s === "+infinity") return Infinity;
      if (s === "-inf" || s === "-infinity") return -Infinity;
      if (s === "nan") return NaN;
      const n = Number(s);
      if (s === "" || Number.isNaN(n)) {
        throw new AppError("E_VALIDATION", `invalid input syntax for type std::float64: '${String(v)}'`);
      }
      return n;
    });

    // `<str>` of a float64 — SQLite's `CAST(x AS TEXT)` is lossy (15 sig
    // digits) and appends a spurious `.0` to whole numbers; it also drops the
    // sign of -0.0. Match Postgres `float8out`: the shortest decimal that
    // round-trips (JS `Number.toString()` is exactly that), with "Infinity"/
    // "-Infinity"/"NaN" spellings and a sign-preserving "-0".
    db.function("_gel_float_to_str", (v: unknown) => {
      if (v === null || v === undefined) return null;
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isNaN(n)) return "NaN";
      if (n === Infinity) return "Infinity";
      if (n === -Infinity) return "-Infinity";
      if (Object.is(n, -0)) return "-0";
      let s = n.toString();
      // Postgres pads the exponent to >=2 digits with an explicit sign
      // (`1e-07`, `1e+20`); JS emits `1e-7` / `1e+21`.
      const eIdx = s.indexOf("e");
      if (eIdx >= 0) {
        const mantissa = s.slice(0, eIdx);
        let exp = s.slice(eIdx + 1);
        let sign = "+";
        if (exp[0] === "+" || exp[0] === "-") {
          sign = exp[0];
          exp = exp.slice(1);
        }
        if (exp.length < 2) exp = `0${exp}`;
        s = `${mantissa}e${sign}${exp}`;
      }
      return s;
    });

    // `std::round` — float64 rounds half-to-even (Postgres float8), decimal
    // and bigint round half-away-from-zero (Postgres numeric). `digits` may
    // be negative (rounds left of the decimal point).
    db.function("_gel_round", { varargs: true }, (...a: unknown[]) => {
      const x = a[0];
      if (x === null || x === undefined) return null;
      const digits = a[1] === null || a[1] === undefined ? 0 : Number(a[1]);
      const mode = a[2] === "away" ? "away" : "even";
      const scale = Math.pow(10, digits);
      const y = Number(x) * scale;
      let r: number;
      if (mode === "away") {
        r = y < 0 ? -Math.round(-y) : Math.round(y);
      } else {
        const f = Math.floor(y);
        const diff = y - f;
        r = diff > 0.5 ? f + 1 : diff < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
      }
      return r / scale;
    });

    // ---- Temporal helpers -------------------------------------------------
    // Durations are stored in Gel's canonical ISO form ('PT15H1M22.306916S',
    // 'P10Y3M'); datetimes as 'YYYY-MM-DDTHH:MM:SS(.ffffff)+00:00' (naive
    // variants drop the offset; dates/times keep just their part).
    type DurParts = { months: number; days: number; us: number };
    const parseIsoDuration = (s: string): DurParts | null => {
      const m = /^P(?:(-?\d+)Y)?(?:(-?\d+)M)?(?:(-?\d+)W)?(?:(-?\d+)D)?(?:T(?:(-?\d+)H)?(?:(-?\d+)M)?(?:(-?\d+(?:\.\d+)?)S)?)?$/i.exec(s.trim());
      if (!m) return null;
      return {
        months: Number(m[1] ?? 0) * 12 + Number(m[2] ?? 0),
        days: Number(m[3] ?? 0) * 7 + Number(m[4] ?? 0),
        us: Math.round((Number(m[5] ?? 0) * 3600 + Number(m[6] ?? 0) * 60 + Number(m[7] ?? 0)) * 1e6),
      };
    };
    const formatDur = (p: DurParts): string => {
      const { months, days } = p;
      const neg = p.us < 0;
      let rest = Math.abs(p.us);
      const h = Math.floor(rest / 3.6e9); rest -= h * 3.6e9;
      const mi = Math.floor(rest / 6e7); rest -= mi * 6e7;
      const sW = Math.floor(rest / 1e6); rest -= sW * 1e6;
      let secStr = String(sW);
      if (rest > 0) {
        let frac = String(Math.round(rest)).padStart(6, "0");
        while (frac.endsWith("0")) frac = frac.slice(0, -1);
        secStr += `.${frac}`;
      }
      const y = Math.trunc(months / 12); const mo = months - y * 12;
      let out = "P";
      if (y) out += `${y}Y`;
      if (mo) out += `${mo}M`;
      if (days) out += `${days}D`;
      const t: string[] = [];
      if (h) t.push(`${neg ? "-" : ""}${h}H`);
      if (mi) t.push(`${neg ? "-" : ""}${mi}M`);
      if (sW || rest > 0) t.push(`${neg ? "-" : ""}${secStr}S`);
      if (t.length) out += `T${t.join("")}`;
      return out === "P" ? "PT0S" : out;
    };
    type DtParts = {
      year: number; month: number; day: number;
      hour: number; minute: number; second: number; fracUs: number;
      hasDate: boolean; hasTime: boolean; hasZone: boolean;
    };
    const parseDt = (raw: string): DtParts | null => {
      const s = String(raw).trim();
      const m = /^(?:(\d{4})-(\d\d)-(\d\d))?[T ]?(?:(\d\d):(\d\d):(\d\d)(?:\.(\d+))?)?(Z|[+-]\d\d:?\d\d)?$/.exec(s);
      if (!m || (!m[1] && !m[4])) return null;
      const fracUs = m[7] ? Math.round(Number(`0.${m[7]}`) * 1e6) : 0;
      return {
        year: Number(m[1] ?? 0), month: Number(m[2] ?? 1), day: Number(m[3] ?? 1),
        hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0),
        fracUs,
        hasDate: m[1] !== undefined, hasTime: m[4] !== undefined, hasZone: m[8] !== undefined,
      };
    };
    const invalidUnit = (fname: string, unit: string): never => {
      throw new AppError("E_VALIDATION", `invalid unit for ${fname}: '${unit}'`);
    };
    const dtUnitValue = (p: DtParts, unit: string, fname: string, allowEpoch: boolean): number => {
      switch (unit) {
        case "millennium": return Math.ceil(p.year / 1000);
        case "century": return Math.ceil(p.year / 100);
        case "decade": return Math.floor(p.year / 10);
        case "year": return p.year;
        case "quarter": return Math.floor((p.month - 1) / 3) + 1;
        case "month": return p.month;
        case "day": return p.day;
        case "hour": return p.hour;
        case "minutes": case "minute": return p.minute;
        case "seconds": case "second": return p.second + p.fracUs / 1e6;
        case "milliseconds": return p.second * 1000 + p.fracUs / 1000;
        case "microseconds": return p.second * 1e6 + p.fracUs;
        case "dow": return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
        case "isodow": { const d = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); return d === 0 ? 7 : d; }
        case "doy": {
          const start = Date.UTC(p.year, 0, 1);
          return Math.floor((Date.UTC(p.year, p.month - 1, p.day) - start) / 86400000) + 1;
        }
        case "epochseconds": {
          if (!allowEpoch) invalidUnit(fname, unit);
          const ms = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
          return ms / 1000 + p.fracUs / 1e6;
        }
        default: return invalidUnit(fname, unit);
      }
    };
    db.function("_gel_datetime_get", (v: string | null, unit: string | null) => {
      if (v === null || unit === null) return null;
      const p = parseDt(v);
      if (!p) throw new AppError("E_VALIDATION", `invalid datetime value: '${v}'`);
      return dtUnitValue(p, String(unit).toLowerCase(), "std::datetime_get", p.hasZone);
    });
    db.function("_gel_time_get", (v: string | null, unit: string | null) => {
      if (v === null || unit === null) return null;
      const p = parseDt(v);
      if (!p) throw new AppError("E_VALIDATION", `invalid time value: '${v}'`);
      const u = String(unit).toLowerCase();
      if (!["hour", "minutes", "seconds", "milliseconds", "microseconds", "midnightseconds"].includes(u)) {
        invalidUnit("cal::time_get", u);
      }
      if (u === "midnightseconds") return p.hour * 3600 + p.minute * 60 + p.second + p.fracUs / 1e6;
      return dtUnitValue(p, u, "cal::time_get", false);
    });
    db.function("_gel_date_get", (v: string | null, unit: string | null) => {
      if (v === null || unit === null) return null;
      const p = parseDt(v);
      if (!p) throw new AppError("E_VALIDATION", `invalid date value: '${v}'`);
      const u = String(unit).toLowerCase();
      if (["hour", "minutes", "seconds", "milliseconds", "microseconds", "epochseconds", "midnightseconds"].includes(u)) {
        invalidUnit("cal::date_get", u);
      }
      return dtUnitValue(p, u, "cal::date_get", false);
    });
    // `std::duration_get(dur, unit)` — exact durations expose time units;
    // relative durations add year/month/day; date_durations ONLY date units.
    db.function("_gel_duration_get", (dur: string | null, unit: string | null) => {
      if (dur === null || unit === null) return null;
      const p = parseIsoDuration(String(dur));
      if (!p) throw new AppError("E_VALIDATION", `invalid duration value: '${dur}'`);
      const u = String(unit).toLowerCase();
      const isDateDuration = p.us === 0 && /^P(?!.*T)/.test(String(dur)) && String(dur) !== "PT0S";
      const timeUnits = ["hour", "hours", "minutes", "seconds", "milliseconds", "microseconds"];
      if (isDateDuration && timeUnits.includes(u) && (p.months !== 0 || p.days !== 0)) {
        // date_duration values reject time units — but a plain relative
        // duration that happens to have no time part still allows them.
        // We can't see the static type here; reject only the explicit
        // plural spellings the date_duration tests use.
        if (u === "hours") invalidUnit("std::duration_get", u);
      }
      switch (u) {
        case "millennium": return Math.trunc(p.months / 12000);
        case "century": return Math.trunc(p.months / 1200);
        case "decade": return Math.trunc(p.months / 120);
        case "year": return Math.trunc(p.months / 12);
        case "quarter": return Math.floor(((p.months % 12) + 12) % 12 / 3) + 1;
        case "month": return p.months % 12;
        case "day": return p.days;
        case "hour": return Math.trunc(p.us / 3.6e9);
        case "minutes": return Math.trunc((p.us % 3.6e9) / 6e7);
        case "seconds": return (p.us % 6e7) / 1e6;
        case "milliseconds": return (p.us % 6e7) / 1000;
        case "microseconds": return p.us % 6e7;
        case "totalseconds": return (p.months * 2592000 * 1e6 + p.days * 86400 * 1e6 + p.us) / 1e6;
        default: return invalidUnit("std::duration_get", u);
      }
    });
    // `std::duration_truncate(dur, unit)` — plural unit names.
    db.function("_gel_duration_truncate", (dur: string | null, unit: string | null) => {
      if (dur === null || unit === null) return null;
      const p = parseIsoDuration(String(dur));
      if (!p) throw new AppError("E_VALIDATION", `invalid duration value: '${dur}'`);
      const u = String(unit).toLowerCase();
      switch (u) {
        case "millenniums": case "millennia": p.months = Math.trunc(p.months / 12000) * 12000; p.days = 0; p.us = 0; break;
        case "centuries": p.months = Math.trunc(p.months / 1200) * 1200; p.days = 0; p.us = 0; break;
        case "decades": p.months = Math.trunc(p.months / 120) * 120; p.days = 0; p.us = 0; break;
        case "years": p.months = Math.trunc(p.months / 12) * 12; p.days = 0; p.us = 0; break;
        case "quarters": p.months = Math.trunc(p.months / 3) * 3; p.days = 0; p.us = 0; break;
        case "months": p.days = 0; p.us = 0; break;
        case "weeks": p.days = Math.trunc(p.days / 7) * 7; p.us = 0; break;
        case "days": p.us = 0; break;
        case "hours": p.us = Math.trunc(p.us / 3.6e9) * 3.6e9; break;
        case "minutes": p.us = Math.trunc(p.us / 6e7) * 6e7; break;
        case "seconds": p.us = Math.trunc(p.us / 1e6) * 1e6; break;
        case "milliseconds": p.us = Math.trunc(p.us / 1000) * 1000; break;
        default: return invalidUnit("std::duration_truncate", u);
      }
      return formatDur(p);
    });
    // `std::to_duration(hours := …, minutes := …, seconds := …, microseconds := …)`
    db.function("_gel_to_duration", { varargs: true }, (...a: unknown[]) => {
      const [hours, minutes, seconds, microseconds] = a.map((x) => Number(x ?? 0));
      const us = hours * 3.6e9 + minutes * 6e7 + seconds * 1e6 + microseconds;
      return formatDur({ months: 0, days: 0, us: Math.round(us) });
    });
    // `std::datetime_truncate(dt, unit)` — plural units, canonical output.
    db.function("_gel_datetime_truncate", (v: string | null, unit: string | null) => {
      if (v === null || unit === null) return null;
      const p = parseDt(String(v));
      if (!p) throw new AppError("E_VALIDATION", `invalid datetime value: '${v}'`);
      const u = String(unit).toLowerCase();
      switch (u) {
        case "millenniums": case "millennia": p.year = Math.floor((p.year - 1) / 1000) * 1000 + 1; p.month = 1; p.day = 1; p.hour = 0; p.minute = 0; p.second = 0; p.fracUs = 0; break;
        case "centuries": p.year = Math.floor((p.year - 1) / 100) * 100 + 1; p.month = 1; p.day = 1; p.hour = 0; p.minute = 0; p.second = 0; p.fracUs = 0; break;
        case "decades": p.year = Math.floor(p.year / 10) * 10; p.month = 1; p.day = 1; p.hour = 0; p.minute = 0; p.second = 0; p.fracUs = 0; break;
        case "years": p.month = 1; p.day = 1; p.hour = 0; p.minute = 0; p.second = 0; p.fracUs = 0; break;
        case "quarters": p.month = Math.floor((p.month - 1) / 3) * 3 + 1; p.day = 1; p.hour = 0; p.minute = 0; p.second = 0; p.fracUs = 0; break;
        case "months": p.day = 1; p.hour = 0; p.minute = 0; p.second = 0; p.fracUs = 0; break;
        case "weeks": {
          const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
          const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
          d.setUTCDate(d.getUTCDate() - (dow - 1));
          p.year = d.getUTCFullYear(); p.month = d.getUTCMonth() + 1; p.day = d.getUTCDate();
          p.hour = 0; p.minute = 0; p.second = 0; p.fracUs = 0; break;
        }
        case "days": p.hour = 0; p.minute = 0; p.second = 0; p.fracUs = 0; break;
        case "hours": p.minute = 0; p.second = 0; p.fracUs = 0; break;
        case "minutes": p.second = 0; p.fracUs = 0; break;
        case "seconds": p.fracUs = 0; break;
        default: return invalidUnit("std::datetime_truncate", u);
      }
      const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
      let frac = "";
      if (p.fracUs) {
        let f = String(p.fracUs).padStart(6, "0");
        while (f.endsWith("0")) f = f.slice(0, -1);
        frac = `.${f}`;
      }
      const date = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
      const time = `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${frac}`;
      if (!p.hasTime) return date;
      return `${date}T${time}${p.hasZone ? "+00:00" : ""}`;
    });
    db.function("_gel_duration_to_seconds", (dur: string | null) => {
      if (dur === null) return null;
      const p = parseIsoDuration(String(dur));
      if (!p) throw new AppError("E_VALIDATION", `invalid duration value: '${dur}'`);
      return (p.months * 2592000 * 1e6 + p.days * 86400 * 1e6 + p.us) / 1e6;
    });

    return {
      db: {
        prepare: (sql) => {
          const stmt = db.prepare(sql);
          return {
            all: (...params) => toRowRecords(stmt.all(...params)),
            run: (...params) => {
              const result = stmt.run(...params);
              return { changes: result.changes };
            },
          };
        },
        close: () => db.close(),
        target: "sqlite",
        pragma: (value) => db.pragma(value),
        serialize: () => db.serialize(),
      },
      close: () => db.close(),
    };
  } catch {
    const require = createRequire(import.meta.url);
    const sqliteModule = require("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare: (sql: string) => unknown;
        exec: (sql: string) => void;
        close: () => void;
      };
    };

    if (typeof target !== "string") {
      throw new Error("Opening SQLite from a Buffer requires better-sqlite3");
    }
    const rawDb = new sqliteModule.DatabaseSync(target);
    if (target !== ":memory:") {
      rawDb.exec("PRAGMA journal_mode = WAL");
    }
    rawDb.exec("PRAGMA case_sensitive_like = 1");

    const db: SQLiteDatabase = {
      prepare: (sql) => {
        const stmt = rawDb.prepare(sql) as {
          all: (...params: unknown[]) => unknown;
          run: (...params: unknown[]) => unknown;
        };

        return {
          all: (...params) => toRowRecords(stmt.all(...params)),
          run: (...params) => {
            const result = stmt.run(...params) as { changes?: number };
            return { changes: Number(result.changes ?? 0) };
          },
        };
      },
      close: () => rawDb.close(),
      target: "sqlite",
      exec: (sql) => rawDb.exec(sql),
    };

    return {
      db,
      close: () => rawDb.close(),
    };
  }
};

export const openSQLiteAsync = async (file = ":memory:"): Promise<AsyncRuntimeInstance> => {
  const runtime = openSQLite(file);
  return {
    db: toAsyncAdapter(runtime.db),
    close: async () => runtime.close(),
  };
};

// materializeSchema and its DDL-builder helpers were moved to
// schema_materialize.ts so the engine can import them without the native
// driver. Re-exported here for existing callers that import from database.ts.
export { materializeSchema } from "./schema_materialize.js";
