import { parseEdgeQL } from "./src/edgeql/parser.js";
const q = process.argv[2];
console.log(JSON.stringify(parseEdgeQL(q), null, 2));
