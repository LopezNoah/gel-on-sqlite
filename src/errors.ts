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
