// Durable Object running the FULL synchronous engine on `ctx.storage.sql`.
//
// Unlike the D1 worker (read-only Tier-1, because D1 is async), a DO's SQL API
// is synchronous, so this runs `executeQuery` directly — SELECT, GROUP, the
// interpreter fallback, AND writes (insert/update/delete) — with no async
// path. This is only possible because engine.ts is now bundle-safe (the native
// driver is no longer in its import closure).
//
// Provision the object's storage with the schema + data first (materializeSchema
// + serializeSchemaToInstdata against ctx.storage.sql); the schema is then read
// back synchronously from the gel_instdata blob.

import type { SQLiteDatabase } from "../src/runtime/database.js";
import { createDOSqlSyncAdapter, type SqlStorageLike } from "../src/runtime/do_adapter.js";
import { executeQuery } from "../src/runtime/engine.js";
import { deserializeSchemaFromInstdata } from "../src/schema/gel_persistence.js";

interface DurableObjectStateLike {
  storage: { sql: SqlStorageLike };
}

export class GelDurableObject {
  private readonly sql: SqlStorageLike;

  constructor(ctx: DurableObjectStateLike) {
    this.sql = ctx.storage.sql;
  }

  async fetch(request: Request): Promise<Response> {
    // The cast is sound: executeQuery only uses prepare()+target at runtime,
    // and a RuntimeDatabaseAdapter's statements ({ all, run }) match.
    const db = createDOSqlSyncAdapter(this.sql) as unknown as SQLiteDatabase;
    const schema = deserializeSchemaFromInstdata(db);
    if (!schema) {
      return Response.json({ error: "no schema provisioned in gel_instdata" }, { status: 500 });
    }

    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "select default::Person { name, age };";
    try {
      const result = executeQuery(db, schema, query);
      return Response.json(result.rows ?? { changes: result.changes ?? 0 });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  }
}

// A default fetch handler so the script is also a valid plain Worker module.
export default {
  fetch(): Response {
    return new Response("Bind the GelDurableObject class to use the full sync engine on D.O. storage.");
  },
};
