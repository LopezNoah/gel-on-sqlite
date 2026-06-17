import {
  AccessPolicyError,
  CardinalityViolationError,
  EdgeDBError,
  EdgeQLSyntaxError,
  ExecutionError,
  InvalidReferenceError,
  InvalidValueError,
  QueryError,
  UnsupportedFeatureError,
} from "./schema/errors.js";

export type ErrorCode =
  | "E_SYNTAX"
  | "E_SEMANTIC"
  | "E_VALIDATION"
  | "E_SQL"
  | "E_RUNTIME"
  | "E_UNSUPPORTED";

export interface AppErrorOptions {
  line?: number;
  column?: number;
  /** Extra guidance for the user, appended to messages at the boundary. */
  hint?: string;
  /** The original thrown value, preserved on Error#cause so stacks survive wrapping. */
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly line?: number;
  public readonly column?: number;
  public readonly hint?: string;

  constructor(
    code: ErrorCode,
    message: string,
    lineOrOptions?: number | AppErrorOptions,
    column?: number,
  ) {
    const opts: AppErrorOptions =
      typeof lineOrOptions === "object" && lineOrOptions !== null
        ? lineOrOptions
        : { line: lineOrOptions, column };
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.line = opts.line;
    this.column = opts.column;
    this.hint = opts.hint;
  }
}

export const asAppError = (err: unknown): AppError => {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof Error) {
    return new AppError("E_RUNTIME", err.message, { cause: err });
  }

  return new AppError("E_RUNTIME", `Unknown error: ${String(err)}`, { cause: err });
};

export const fail = (code: ErrorCode, message: string, opts?: AppErrorOptions): never => {
  throw new AppError(code, message, opts);
};

/**
 * Errors that represent the query (or a candidate interpretation of it) being
 * invalid, as opposed to a bug in this engine. Probe-style call sites that try
 * one interpretation and fall back to another may swallow these; anything else
 * (TypeError, RangeError, …) is a defect and must propagate.
 */
export const isQueryFailure = (err: unknown): err is AppError =>
  err instanceof AppError &&
  (err.code === "E_SYNTAX" ||
    err.code === "E_SEMANTIC" ||
    err.code === "E_VALIDATION" ||
    err.code === "E_UNSUPPORTED");

// Message heuristics below are verified against actual throw-site messages
// (grep before adding a pattern — do not invent ones the engine never emits).
// "assert_single/assert_exists violation" come from stdlib/engine assertion
// builtins; they are cardinality failures regardless of which AppError code
// the throw site happened to pick (stdlib/UDF throw sites use E_VALIDATION,
// engine-level ones surface as E_SEMANTIC or E_RUNTIME).
const ASSERTION_VIOLATION = /assert_(?:single|exists) violation/i;

// E_SEMANTIC name-resolution failures: `function "..." does not exist`,
// `Unknown type '...'`, `Unknown link '...' on '...'`, `Unknown function`,
// `object type '...' has no link or property '...'`.
const UNRESOLVED_REFERENCE =
  /does not exist|unknown (?:module|link|property|type|function)|has no link or property/i;

// E_RUNTIME access-policy rejections: `Access policy violation on insert of …`.
const ACCESS_POLICY_VIOLATION = /access policy violation/i;

/**
 * Map an arbitrary thrown value onto the Gel (EdgeDB) error taxonomy without
 * rewriting throw sites. The returned instance carries the original message
 * and keeps the source AppError on Error#cause. Values that are already Gel
 * errors (e.g. from schema DDL code) pass through unchanged.
 */
export const toGelError = (err: unknown): EdgeDBError => {
  if (err instanceof EdgeDBError) {
    return err;
  }

  const appError = asAppError(err);
  const message = appError.message;

  let gelError: EdgeDBError;
  switch (appError.code) {
    case "E_SYNTAX":
      gelError = new EdgeQLSyntaxError(message);
      break;
    case "E_VALIDATION":
      // assert_exists/assert_single raise CardinalityViolationError in real
      // Gel even though the stdlib throw sites tag them E_VALIDATION.
      if (ASSERTION_VIOLATION.test(message)) {
        gelError = new CardinalityViolationError(message);
      } else {
        gelError = new InvalidValueError(message);
      }
      break;
    case "E_UNSUPPORTED":
      gelError = new UnsupportedFeatureError(message);
      break;
    case "E_SEMANTIC":
      if (ASSERTION_VIOLATION.test(message)) {
        gelError = new CardinalityViolationError(message);
      } else if (UNRESOLVED_REFERENCE.test(message)) {
        gelError = new InvalidReferenceError(message);
      } else {
        gelError = new QueryError(message);
      }
      break;
    case "E_RUNTIME":
    case "E_SQL":
      if (ASSERTION_VIOLATION.test(message)) {
        gelError = new CardinalityViolationError(message);
      } else if (ACCESS_POLICY_VIOLATION.test(message)) {
        gelError = new AccessPolicyError(message);
      } else {
        gelError = new ExecutionError(message);
      }
      break;
  }

  gelError.cause = appError;
  return gelError;
};

/** Render a Gel error's numeric code in the canonical 0xAABBCCDD hex form. */
export const gelCodeToHex = (code: number): string =>
  `0x${code.toString(16).toUpperCase().padStart(8, "0")}`;

export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Run a fallible computation and capture the outcome as a Result instead of a
 * thrown exception. Only query failures (see isQueryFailure) are captured;
 * engine bugs keep propagating so they cannot hide inside probe call sites.
 * Pass captureAll: true for boundaries that must not throw at all.
 */
export const tryResult = <T>(
  fn: () => T,
  opts?: { captureAll?: boolean },
): Result<T> => {
  try {
    return ok(fn());
  } catch (e) {
    if (opts?.captureAll || isQueryFailure(e)) {
      return err(asAppError(e));
    }
    throw e;
  }
};

/**
 * Optimistic-probe sugar over `tryResult`: run `fn` and return its value, or
 * `undefined` when it fails as a query problem (see isQueryFailure). Engine
 * defects (TypeError, RangeError, …) keep propagating, so a bug in a lowering
 * path can no longer hide behind a bare `catch { return undefined }`. The home
 * for "try this interpretation, fall back if it doesn't apply".
 */
export const tryProbe = <T>(fn: () => T): T | undefined => {
  const r = tryResult(fn);
  return r.ok ? r.value : undefined;
};
