import { parseEdgeQL } from "./src/edgeql/parser.js";
const queries = [
  `SELECT User.deck FILTER User.name`,
  `SELECT User.deck FILTER User.deck@count`,
  `SELECT User.deck { foo := User }`,
  `UPDATE User.deck SET { name := User.name }`,
  `UPDATE User SET { avatar := (UPDATE .avatar SET { text := "foo" }) }`,
];
for (const q of queries) {
  console.log("==== Query:", q);
  try {
    const ast = parseEdgeQL(q);
    console.log(JSON.stringify(ast, null, 2));
  } catch (e: any) {
    console.log("Parse error:", e.message);
  }
}
