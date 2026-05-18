import { parseEdgeQL } from "./src/edgeql/parser.js";
const q = `SELECT {CBaBb, CBbBc} { tn := .__type__.name, bb } ORDER BY .bb`;
console.log(JSON.stringify(parseEdgeQL(q), null, 2));
