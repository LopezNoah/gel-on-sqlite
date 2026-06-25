// Shared core for the Cloudflare query executors (D1 + Durable Objects).
//
// Builds the gel-js-style cardinality methods (query / querySingle /
// queryRequiredSingle / queryRequired) from a single "fetch decoded rows"
// function, and applies the SAME row codec the file-backed Client uses — so
// result shapes (and therefore the `gel codegen` output types) are identical
// across every backend.
//
// Bundle-safe for workerd: imports only the pure codec + error classes, nothing
// that reaches better-sqlite3.

import type { SchemaSnapshot } from "../schema/schema.js";
import { buildRowConverter, stripInternalColumns } from "./codec.js";
import { NoDataError, ResultCardinalityMismatchError } from "./errors.js";

export type QueryArgs = Record<string, unknown>;

/** The read surface the generated query client calls — a structural subset of
 *  the file-backed Client's Executor, with the same method names + shapes. */
export interface QueryExecutor {
  query<T = unknown>(query: string, args?: QueryArgs): Promise<T[]>;
  querySingle<T = unknown>(query: string, args?: QueryArgs): Promise<T | null>;
  queryRequiredSingle<T = unknown>(query: string, args?: QueryArgs): Promise<T>;
  queryRequired<T = unknown>(query: string, args?: QueryArgs): Promise<[T, ...T[]]>;
}

export interface ExecutorOptions {
  /** Default module for unqualified names. Defaults to "default". */
  defaultModule?: string;
  /** Bypass the result codec and return raw engine rows. */
  rawResults?: boolean;
}

export interface ResolvedExecutorOptions {
  defaultModule: string;
  rawResults: boolean;
}

export const resolveExecutorOptions = (o: ExecutorOptions = {}): ResolvedExecutorOptions => ({
  defaultModule: o.defaultModule ?? "default",
  rawResults: o.rawResults ?? false,
});

/** Apply the same codec path as the file-backed Client's `decodedRows`. */
export const decodeRows = (
  schema: SchemaSnapshot,
  query: string,
  rows: unknown[],
  options: ResolvedExecutorOptions,
): unknown[] => {
  if (options.rawResults) return rows;
  const converter = buildRowConverter(schema, query, options.defaultModule);
  return converter ? rows.map(converter) : rows.map(stripInternalColumns);
};

/** Build the 4 cardinality methods from one "fetch decoded rows" function. */
export const buildExecutor = (
  fetchRows: (query: string, args?: QueryArgs) => Promise<unknown[]>,
): QueryExecutor => ({
  async query<T = unknown>(query: string, args?: QueryArgs): Promise<T[]> {
    return (await fetchRows(query, args)) as T[];
  },
  async querySingle<T = unknown>(query: string, args?: QueryArgs): Promise<T | null> {
    const rows = (await fetchRows(query, args)) as T[];
    if (rows.length > 1) {
      throw new ResultCardinalityMismatchError(
        `query returned ${rows.length} elements, at most one was expected`,
      );
    }
    return rows.length === 1 ? rows[0] : null;
  },
  async queryRequired<T = unknown>(query: string, args?: QueryArgs): Promise<[T, ...T[]]> {
    const rows = (await fetchRows(query, args)) as T[];
    if (rows.length === 0) {
      throw new ResultCardinalityMismatchError("query returned no elements, at least one was expected");
    }
    return rows as [T, ...T[]];
  },
  async queryRequiredSingle<T = unknown>(query: string, args?: QueryArgs): Promise<T> {
    const rows = (await fetchRows(query, args)) as T[];
    if (rows.length === 0) {
      throw new NoDataError("query returned no elements, exactly one was expected");
    }
    if (rows.length > 1) {
      throw new ResultCardinalityMismatchError(
        `query returned ${rows.length} elements, exactly one was expected`,
      );
    }
    return rows[0];
  },
});
