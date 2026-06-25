// Async schema load for the D1 / async runtime.
//
// The sync engine loads its schema by reading the persisted `gel_*` metadata
// straight off a synchronous SQLiteDatabase. On D1 the only access is async,
// so this reads the schema blob through the async adapter and then reuses the
// *canonical* sync deserializer — there is no duplicated decode logic here.
//
// The trick: `deserializeSchemaFromInstdata` issues exactly one query
// (`SELECT data FROM gel_instdata WHERE key = 'schema'`). We prefetch that one
// row asynchronously, then hand the deserializer a synchronous view that
// answers that single query from the prefetched buffer. All real I/O stays at
// the async edge; the JSON→SchemaSnapshot decode stays in its one home. This
// module imports nothing that reaches better-sqlite3, so it bundles for
// workerd (the `SQLiteDatabase` parameter type is erased at the cast site).

import { deserializeSchemaFromInstdata } from "../schema/gel_persistence.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import type { ScalarValue } from "../types.js";
import type { AsyncRuntimeDatabaseAdapter } from "./adapter.js";

const INSTDATA_SQL = "SELECT data FROM gel_instdata WHERE key = ?";

export class AsyncSchemaLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncSchemaLoadError";
  }
}

export const loadSchemaAsync = async (
  db: AsyncRuntimeDatabaseAdapter,
): Promise<SchemaSnapshot> => {
  const rows = await db.prepare(INSTDATA_SQL).all("schema");

  // A synchronous facade over the single prefetched row. Structurally this is
  // the slice of SQLiteDatabase that deserializeSchemaFromInstdata touches; we
  // cast through `Parameters<...>` so no value-import of the native database
  // module is needed.
  const bufferedDb = {
    prepare: (sql: string) => ({
      all: (...params: ScalarValue[]) =>
        sql === INSTDATA_SQL && params[0] === "schema" ? rows : [],
      run: () => ({ changes: 0 }),
    }),
  } as unknown as Parameters<typeof deserializeSchemaFromInstdata>[0];

  const schema = deserializeSchemaFromInstdata(bufferedDb);
  if (!schema) {
    throw new AsyncSchemaLoadError(
      "no schema snapshot in gel_instdata (key 'schema'); the async path needs the " +
        "instdata blob — run serializeSchemaToInstdata when provisioning the database",
    );
  }
  return schema;
};
