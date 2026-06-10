// Usage: npx tsx scripts/astdump.ts '<edgeql>' [depth]
import { parseEdgeQL } from "../src/edgeql/parser.js";
const ast: any = parseEdgeQL(process.argv[2] ?? "select 1");
const stmt = Array.isArray(ast) ? ast[0] : ast;
console.log(JSON.stringify(stmt, (k, v) => k === "pos" ? undefined : v, 1).slice(0, Number(process.argv[3] ?? 2500)));
