const sqlite = require('better-sqlite3');
const db = new sqlite(':memory:');
// Test ordering for scalar strings (non-JSON-encoded)
const rows = db.prepare("select value from (select 'rectangle' as value union all select 'wood') order by value").all();
console.log("Plain str sort:", rows);
// json_array_length on plain str
try {
  console.log("json_array_length('wood'):", db.prepare("select json_array_length('wood')").get());
} catch (e) { console.log("err:", e.message); }
// Use json() to validate
try {
  console.log("json_valid('wood'):", db.prepare("select json_valid('wood')").get());
} catch (e) { console.log("err:", e.message); }
// What if we use CASE
const rows3 = db.prepare("select value from (select 'rectangle' as value union all select 'wood') order by case when json_valid(value) then json_array_length(value) else -1 end, value").all();
console.log("Test sort with json_valid:", rows3);
