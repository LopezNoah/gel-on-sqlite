// Shared helpers for the async SQL backends (Cloudflare D1, Durable Objects
// SQL storage). Both bind positional params and run plain SQL, but they are
// stricter than better-sqlite3 and surface their own error types — this module
// normalizes both so the D1 and DO adapters behave identically. Bundle-safe:
// imports only the (native-free) error type.

import { AppError } from "../errors.js";
import type { ScalarValue } from "../types.js";

// D1 and DO SQL reject some values better-sqlite3 accepts: booleans must be
// bound as 1/0. (null, number, string pass through; bigint/blob aren't part of
// ScalarValue, so this covers the param domain.)
export const normalizeBindParam = (value: ScalarValue): ScalarValue =>
  typeof value === "boolean" ? (value ? 1 : 0) : value;

export const normalizeBindParams = (params: ScalarValue[]): ScalarValue[] =>
  params.map(normalizeBindParam);

// Map a backend execution error to the engine's AppError so callers see the
// same typed errors as the sync engine, not raw backend exceptions. A missing
// `_gel_*` function (neither D1 nor DO SQL can host custom functions) is the
// common case worth a clear hint.
export const wrapBackendError = (
  backend: "d1" | "durable-object",
  err: unknown,
): AppError => {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const missingCustomFn = message.includes("no such function") && message.includes("_gel_");
  return new AppError("E_SQL", `${backend} query failed: ${message}`, {
    cause: err,
    hint: missingCustomFn
      ? "this query lowers to a custom function the backend cannot host; it is not supported on the async path"
      : undefined,
  });
};
