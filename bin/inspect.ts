#!/usr/bin/env -S npx tsx
// Dev CLI for the compile-inspection seam — one tool replacing the ad-hoc root
// runners (qast / qir / qsql / qins / inspect_compile …). It crosses the same
// seam the golden tests do (src/compiler/inspect.ts), which is what makes that
// seam real rather than indirection.
//
//   npx tsx bin/inspect.ts facts "SELECT Issue { name }"
//   npx tsx bin/inspect.ts sql   "SELECT Issue { name }" --schema issues
//   npx tsx bin/inspect.ts ir    "SELECT Issue"
//   npx tsx bin/inspect.ts raw   "SELECT Issue"            # full gelIr JSON
//   npx tsx bin/inspect.ts gel-facts "SELECT Issue"        # Gel-shaped facts
//   npx tsx bin/inspect.ts ast   "SELECT Issue"

import fs from "node:fs";
import { gelFactsOf, inspect, schemaFromSdl } from "../src/compiler/inspect.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--schema");

const cmd = positional[0] ?? "facts";
const query = positional[1] ?? "SELECT 1";
const schemaName = flag("--schema") ?? "issues";
const schemaFile = `tests/schemas/${schemaName}.esdl`;

const src = fs.readFileSync(
  new URL(`../${schemaFile}`, import.meta.url),
  "utf8",
);
const schema = schemaFromSdl(src);

const result = inspect(schema, query);
if (!result.ok) {
  console.error(`[${result.error?.phase}] ${result.error?.code}: ${result.error?.message}`);
  process.exit(1);
}

const skipSchema = (k: string, v: unknown) => (k === "schema" ? undefined : v);

switch (cmd) {
  case "facts":
    console.log(JSON.stringify(result.facts, null, 2));
    break;
  case "sql":
    console.log(result.sql());
    break;
  case "ir":
    console.log(JSON.stringify(result.facts?.irKindTree, null, 2));
    break;
  case "raw":
    console.log(JSON.stringify(result.artifact?.gelIr, skipSchema, 1));
    break;
  case "gel-facts":
    console.log(JSON.stringify(gelFactsOf(result, { schemaFile }), null, 2));
    break;
  case "ast":
    console.log(JSON.stringify(result.ast, skipSchema, 1));
    break;
  default:
    console.error(`unknown command "${cmd}" (use: facts | sql | ir | raw | gel-facts | ast)`);
    process.exit(2);
}
