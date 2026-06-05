import BetterSQLite3 from "better-sqlite3";
const db = new BetterSQLite3(":memory:");

// Test 1: json_group_array(text) vs json_group_array(json(text))
const tests = [
  `SELECT json_group_array(value) AS r FROM (SELECT '["wood"]' AS value UNION ALL SELECT '["rectangle"]' AS value)`,
  `SELECT json_group_array(json(value)) AS r FROM (SELECT '["wood"]' AS value UNION ALL SELECT '["rectangle"]' AS value)`,
  `SELECT json_group_array(value) AS r FROM (SELECT json('["wood"]') AS value UNION ALL SELECT json('["rectangle"]') AS value)`,
  `SELECT json_group_array(value) AS r FROM (SELECT json_array('wood') AS value UNION ALL SELECT json_array('rectangle') AS value)`,
];
for (const sql of tests) {
  const r = db.prepare(sql).get() as any;
  console.log(sql);
  console.log("=> ", r.r);
  console.log();
}
