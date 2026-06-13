// gel-js-compatible Client facade over the sqlite-ts engine.
//
// Mirrors the public surface of the `gel` driver's Client (createClient,
// query/querySingle/queryRequiredSingle/queryRequired, the *JSON variants,
// execute, querySQL/executeSQL, transaction, close) so application code
// written against gel-js ports over unchanged. The engine is synchronous
// (better-sqlite3), so the Promise-based methods resolve immediately; the
// async signatures exist for drop-in compatibility.
//
// Result values pass through the codec (codec.ts), which converts engine
// output to the documented gel-js value types and strips engine-internal
// columns. Construct with `rawResults: true` to bypass the codec — the
// conformance test harness uses this mode so its expected values (ported
// verbatim from the Python suite's JSON-ish shapes) keep matching.

import { openSQLite } from "../runtime/database.js";
import { executeQuery, executeScript, type QueryResult, type QueryVariables } from "../runtime/engine.js";
import {
  deserializeSchemaFromGelTables,
  deserializeSchemaFromInstdata,
} from "../schema/gel_persistence.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { buildRowConverter, stripInternalColumns } from "./codec.js";
import {
  ClientClosedError,
  ClientError,
  NoDataError,
  ResultCardinalityMismatchError,
} from "./errors.js";

export * from "./errors.js";
export * from "./datatypes.js";

export interface ConnectOptions {
  // Path to a SQLite database file produced by sqlite-ts (must contain the
  // serialized schema). `:memory:` is not meaningful here — an empty
  // in-memory database has no schema to run EdgeQL against.
  file?: string;
  // Default module for unqualified names in queries. Defaults to "default".
  defaultModule?: string;
  // Bypass the result codec and return the engine's raw row values.
  rawResults?: boolean;
}

interface SecurityContextLike {
  strictUserDDL?: boolean;
}

// The query-running surface shared by Client and Transaction.
export interface Executor {
  execute(query: string): Promise<void>;
  query<T = unknown>(query: string): Promise<T[]>;
  queryRequired<T = unknown>(query: string): Promise<[T, ...T[]]>;
  querySingle<T = unknown>(query: string): Promise<T | null>;
  queryRequiredSingle<T = unknown>(query: string): Promise<T>;
  queryJSON(query: string): Promise<string>;
  queryRequiredJSON(query: string): Promise<string>;
  querySingleJSON(query: string): Promise<string>;
  queryRequiredSingleJSON(query: string): Promise<string>;
  querySQL<T = unknown>(query: string, args?: unknown[]): Promise<T[]>;
  executeSQL(query: string, args?: unknown[]): Promise<void>;
}

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  return value;
};

export class Transaction implements Executor {
  constructor(private readonly client: Client) {}

  execute(query: string): Promise<void> { return this.client.execute(query); }
  query<T = unknown>(query: string): Promise<T[]> { return this.client.query<T>(query); }
  queryRequired<T = unknown>(query: string): Promise<[T, ...T[]]> { return this.client.queryRequired<T>(query); }
  querySingle<T = unknown>(query: string): Promise<T | null> { return this.client.querySingle<T>(query); }
  queryRequiredSingle<T = unknown>(query: string): Promise<T> { return this.client.queryRequiredSingle<T>(query); }
  queryJSON(query: string): Promise<string> { return this.client.queryJSON(query); }
  queryRequiredJSON(query: string): Promise<string> { return this.client.queryRequiredJSON(query); }
  querySingleJSON(query: string): Promise<string> { return this.client.querySingleJSON(query); }
  queryRequiredSingleJSON(query: string): Promise<string> { return this.client.queryRequiredSingleJSON(query); }
  querySQL<T = unknown>(query: string, args?: unknown[]): Promise<T[]> { return this.client.querySQL<T>(query, args); }
  executeSQL(query: string, args?: unknown[]): Promise<void> { return this.client.executeSQL(query, args); }
}

export class Client implements Executor {
  private closed = false;
  private inTransaction = false;
  private securityContext: SecurityContextLike | undefined;

  private constructor(
    private readonly db: ReturnType<typeof openSQLite>["db"],
    private readonly schema: SchemaSnapshot,
    private readonly options: { defaultModule: string; rawResults: boolean },
  ) {}

  // Public factory for a file-backed client (see createClient). Also the
  // integration point for embedders that already hold a db + schema pair —
  // the test harness constructs its Client this way.
  static fromParts(
    db: ReturnType<typeof openSQLite>["db"],
    schema: SchemaSnapshot,
    options: { defaultModule?: string; rawResults?: boolean } = {},
  ): Client {
    return new Client(db, schema, {
      defaultModule: options.defaultModule ?? "default",
      rawResults: options.rawResults ?? false,
    });
  }

  static fromFile(options: ConnectOptions): Client {
    if (!options.file) {
      throw new ClientError(
        "createClient requires a `file` pointing at a sqlite-ts database (no project/environment discovery in the embedded client)",
      );
    }
    const { db } = openSQLite(options.file);
    const schema = deserializeSchemaFromInstdata(db) ?? deserializeSchemaFromGelTables(db);
    if (!schema) {
      throw new ClientError(`database '${options.file}' does not contain a serialized sqlite-ts schema`);
    }
    return new Client(db, schema, {
      defaultModule: options.defaultModule ?? "default",
      rawResults: options.rawResults ?? false,
    });
  }

  // ── engine-facing sync core ─────────────────────────────────────────────
  // The harness (and any other sync embedder) runs through these so every
  // conformance test exercises the same pipeline the async client uses.

  setSecurityContext(context: SecurityContextLike | undefined): void {
    this.securityContext = context;
  }

  querySyncEnvelope(query: string, variables?: QueryVariables): QueryResult {
    this.assertOpen();
    return executeQuery(this.db, this.schema, query, this.securityContext as never, variables);
  }

  scriptSyncEnvelope(script: string, variables?: QueryVariables): QueryResult {
    this.assertOpen();
    return executeScript(this.db, this.schema, script, this.securityContext as never, {
      defaultModule: this.options.defaultModule,
    }, variables);
  }

  private decodedRows(query: string): unknown[] {
    const envelope = this.querySyncEnvelope(query);
    const rows = envelope.rows ?? [];
    if (this.options.rawResults) {
      return rows;
    }
    const converter = buildRowConverter(this.schema, query, this.options.defaultModule);
    if (converter) {
      return rows.map(converter);
    }
    return rows.map(stripInternalColumns);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ClientClosedError("the client is closed");
    }
  }

  // ── gel-js Client surface ───────────────────────────────────────────────

  async execute(query: string): Promise<void> {
    this.scriptSyncEnvelope(query);
  }

  async query<T = unknown>(query: string): Promise<T[]> {
    return this.decodedRows(query) as T[];
  }

  async queryRequired<T = unknown>(query: string): Promise<[T, ...T[]]> {
    const rows = this.decodedRows(query) as T[];
    if (rows.length === 0) {
      throw new ResultCardinalityMismatchError("query returned no elements, at least one was expected");
    }
    return rows as [T, ...T[]];
  }

  async querySingle<T = unknown>(query: string): Promise<T | null> {
    const rows = this.decodedRows(query) as T[];
    if (rows.length > 1) {
      throw new ResultCardinalityMismatchError(
        `query returned ${rows.length} elements, at most one was expected`,
      );
    }
    return rows.length === 1 ? rows[0] : null;
  }

  async queryRequiredSingle<T = unknown>(query: string): Promise<T> {
    const rows = this.decodedRows(query) as T[];
    if (rows.length === 0) {
      throw new NoDataError("query returned no elements, exactly one was expected");
    }
    if (rows.length > 1) {
      throw new ResultCardinalityMismatchError(
        `query returned ${rows.length} elements, exactly one was expected`,
      );
    }
    return rows[0];
  }

  async queryJSON(query: string): Promise<string> {
    return JSON.stringify(await this.query(query), jsonReplacer);
  }

  async queryRequiredJSON(query: string): Promise<string> {
    return JSON.stringify(await this.queryRequired(query), jsonReplacer);
  }

  async querySingleJSON(query: string): Promise<string> {
    return JSON.stringify(await this.querySingle(query), jsonReplacer) ?? "null";
  }

  async queryRequiredSingleJSON(query: string): Promise<string> {
    return JSON.stringify(await this.queryRequiredSingle(query), jsonReplacer);
  }

  async querySQL<T = unknown>(query: string, args: unknown[] = []): Promise<T[]> {
    this.assertOpen();
    return this.db.prepare(query).all(...(args as never[])) as T[];
  }

  async executeSQL(query: string, args: unknown[] = []): Promise<void> {
    this.assertOpen();
    this.db.prepare(query).run(...(args as never[]));
  }

  // Single-connection embedded database: the transaction body runs against
  // the same handle inside BEGIN/COMMIT, rolled back on any throw. There is
  // no concurrent writer, so the gel-js retry loop degenerates to a single
  // attempt.
  async transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.inTransaction) {
      throw new ClientError("nested transactions are not supported");
    }
    this.inTransaction = true;
    this.db.prepare("BEGIN").run();
    try {
      const result = await action(new Transaction(this));
      this.db.prepare("COMMIT").run();
      return result;
    } catch (err) {
      try {
        this.db.prepare("ROLLBACK").run();
      } catch {
        // Rollback can fail if the engine already ended the tx; the original
        // error is what matters.
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  async ensureConnected(): Promise<Client> {
    this.assertOpen();
    return this;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function createClient(options?: string | ConnectOptions | null): Client {
  if (typeof options === "string") {
    return Client.fromFile({ file: options });
  }
  return Client.fromFile(options ?? {});
}
