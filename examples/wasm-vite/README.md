# Gel + WASM + Vite

This example runs the full EdgeQL-to-SQLite pipeline in the browser using
[`sql.js`](https://sql.js.org/). It provisions a Gel schema, executes reads and
writes, and saves the exported SQLite database in `localStorage`.

```bash
cd examples/wasm-vite
npm install
npm run dev
```

The important setup is in `src/main.ts`:

```ts
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { connectWasm, provisionWasm } from "../../../src/client/wasm.js";

const SQL = await initSqlJs({ locateFile: () => wasmUrl });
const db = new SQL.Database();
provisionWasm(db, SCHEMA);

const client = connectWasm(db);
await client.query("insert default::Person { name := 'Ada', age := 36 };");
const people = await client.query("select default::Person { name, age };");
```

The relative import is only because this repository is currently private and
does not publish package exports. In an installed package, it is intended to be
`sqlite-ts/client/wasm`.

`sql.js` is synchronous, so reads and writes both use the full Gel engine. The
database is in memory until `db.export()` is saved to IndexedDB, OPFS,
`localStorage`, or downloaded as a file.
