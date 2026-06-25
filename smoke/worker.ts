// Cloudflare Worker entry demonstrating the Tier-1 D1 read path.
//
// GET /?q=<edgeql>  → runs the query against the bound D1 database and returns
// the rows as JSON. Reads only (single-statement lowering); mutations and the
// interpreter-fallback path return 400 with an AsyncUnsupportedError message.
//
// Deploy notes:
//   - Requires `compatibility_flags = ["nodejs_compat"]` (the compiler's cache
//     key uses node:crypto). See wrangler.toml.
//   - Provision the D1 database with the schema + data first; the schema is
//     read from the `gel_instdata` blob (run serializeSchemaToInstdata when
//     seeding). See README.md and smoke/d1_smoke.ts for a local example.

import { executeSelectAsync } from "../src/runtime/async_query.js";
import { loadSchemaAsync } from "../src/runtime/async_schema.js";
import { createD1Adapter, type D1DatabaseLike } from "../src/runtime/d1_adapter.js";
import type { SchemaSnapshot } from "../src/schema/schema.js";

export interface Env {
  DB: D1DatabaseLike;
}

// The schema is read-mostly; cache it per isolate to avoid re-reading the
// instdata blob on every request. (Invalidate by redeploying after a schema
// change — a production build would key this on a schema version.)
let cachedSchema: Promise<SchemaSnapshot> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const query =
      url.searchParams.get("q") ?? "select default::Person { name, age } order by .name;";

    const db = createD1Adapter(env.DB);
    try {
      const schema = await (cachedSchema ??= loadSchemaAsync(db));
      const { rows } = await executeSelectAsync(db, schema, query);
      return Response.json(rows);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  },
};
