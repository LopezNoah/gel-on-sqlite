import { describe, expect, it } from "vitest";

// Ported from gel/tests/test_sql_parse.py — a PostgreSQL SQL parser round-trip
// suite (parse -> codegen, compare normalized strings). sqlite-ts does not
// embed a PG SQL parser/codegen of its own (its SQL story is "lower IR to
// SQLite SQL", not "ingest arbitrary SQL"), so every test is a skipped parity
// placeholder. They become runnable once a SQL parser + source-printer is
// added under e.g. src/sql/parser.ts and src/sql/codegen.ts.

declare const parseSQL: (source: string) => unknown[];
declare const renderSQL: (ast: unknown) => string;

const inline = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");

const normalize = (text: string): string =>
  text.split("  ").join(" ").split("( ").join("(").split(" )").join(")");

const runParseRoundTrip = (source: string, expected?: string): void => {
  const normalizedSource = normalize(inline(source));
  const normalizedExpected = expected ? normalize(inline(expected)) : normalizedSource;
  const ast = parseSQL(normalizedSource);
  const rendered = normalize(ast.map(renderSQL).join("; "));
  expect(rendered).toBe(normalizedExpected);
};

describe("TestSQLParse", () => {
  it.skip("test_sql_parse_select_00 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM my_table`);
  });

  it.skip("test_sql_parse_select_01 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT col1 FROM my_table WHERE
        my_attribute LIKE 'condition' AND other = 5.6 AND extra > 5`, `SELECT col1 FROM my_table WHERE
        (((my_attribute LIKE 'condition') AND
        (other = 5.6)) AND (extra > 5))`);
  });

  it.skip("test_sql_parse_select_02 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM table_one JOIN table_two USING (common)`);
  });

  it.skip("test_sql_parse_select_03 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`WITH fake_table AS (
            SELECT SUM(countable) AS total FROM inner_table
            GROUP BY groupable
        ) SELECT * FROM fake_table`, `WITH fake_table AS ((
            SELECT sum(countable) AS total FROM inner_table
            GROUP BY groupable
        )) SELECT * FROM fake_table`);
  });

  it.skip("test_sql_parse_select_04 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM (SELECT something FROM dataset) AS other`);
  });

  it.skip("test_sql_parse_select_05 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a, CASE WHEN a=1 THEN 'one' WHEN a=2
        THEN 'two' ELSE 'other' END FROM test`, `SELECT a, (CASE WHEN (a = 1) THEN 'one' WHEN (a = 2)
        THEN 'two' ELSE 'other' END) FROM test`);
  });

  it.skip("test_sql_parse_select_06 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT CASE a.value WHEN 0 THEN '1' ELSE '2' END
        FROM sometable a`, `SELECT (CASE a.value WHEN 0 THEN '1' ELSE '2' END)
        FROM sometable AS a`);
  });

  it.skip("test_sql_parse_select_07 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM table_one UNION select * FROM table_two`, `(SELECT * FROM table_one) UNION (SELECT * FROM table_two)`);
  });

  it.skip("test_sql_parse_select_08 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM my_table WHERE ST_Intersects(geo1, geo2)`, `SELECT * FROM my_table WHERE st_intersects(geo1, geo2)`);
  });

  it.skip("test_sql_parse_select_09 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT 'accbf276-705b-11e7-b8e4-0242ac120002'::UUID`, `SELECT ('accbf276-705b-11e7-b8e4-0242ac120002')::uuid`);
  });

  it.skip("test_sql_parse_select_10 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM my_table ORDER BY field DESC NULLS FIRST`);
  });

  it.skip("test_sql_parse_select_11 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM my_table ORDER BY field`);
  });

  it.skip("test_sql_parse_select_12 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT salary, sum(salary) OVER () FROM empsalary`);
  });

  it.skip("test_sql_parse_select_13 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT salary, sum(salary)
OVER (ORDER BY salary) FROM empsalary`);
  });

  it.skip("test_sql_parse_select_14 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT salary, avg(salary)
OVER (PARTITION BY depname) FROM empsalary`);
  });

  it.skip("test_sql_parse_select_15 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT m.* FROM mytable m WHERE m.foo IS NULL`, `SELECT m.* FROM mytable AS m WHERE (m.foo IS NULL)`);
  });

  it.skip("test_sql_parse_select_16 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT m.* FROM mytable m WHERE m.foo IS NOT NULL`, `SELECT m.* FROM mytable AS m WHERE (m.foo IS NOT NULL)`);
  });

  it.skip("test_sql_parse_select_17 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT m.* FROM mytable m WHERE m.foo IS TRUE`, `SELECT m.* FROM mytable AS m WHERE (m.foo IS TRUE)`);
  });

  it.skip("test_sql_parse_select_18 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT m.name AS mname, pname FROM manufacturers m,
        LATERAL get_product_names(m.id) pname`, `SELECT m.name AS mname, pname FROM manufacturers AS m,
        LATERAL get_product_names(m.id) AS pname`);
  });

  it.skip("test_sql_parse_select_19 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM unnest(ARRAY['a','b','c','d','e','f'])`, `SELECT * FROM unnest(ARRAY['a', 'b', 'c', 'd', 'e', 'f'])`);
  });

  it.skip("test_sql_parse_select_20 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM my_table
        WHERE (a, b) in (('a', 'b'), ('c', 'd'))`, `SELECT * FROM my_table
        WHERE ((a, b) IN (('a', 'b'), ('c', 'd')))`);
  });

  it.skip("test_sql_parse_select_21 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FRO my_table`);
  });

  it.skip("test_sql_parse_select_22 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a, CASE WHEN a=1 THEN 'one'
WHEN a=2 THEN ELSE 'other' END FROM test`);
  });

  it.skip("test_sql_parse_select_23 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM table_one, table_two`);
  });

  it.skip("test_sql_parse_select_24 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM table_one, public.table_one`);
  });

  it.skip("test_sql_parse_select_25 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`WITH fake_table AS (SELECT * FROM inner_table)
        SELECT * FROM fake_table`, `WITH fake_table AS ((SELECT * FROM inner_table))
        SELECT * FROM fake_table`);
  });

  it.skip("test_sql_parse_select_26 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM table_one JOIN table_two USING (common_1)
JOIN table_three USING (common_2)`);
  });

  it.skip("test_sql_parse_select_27 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`select * FROM table_one UNION select * FROM table_two`, `(SELECT * FROM table_one) UNION (SELECT * FROM table_two)`);
  });

  it.skip("test_sql_parse_select_28 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM my_table WHERE (a, b) in ('a', 'b')`, `SELECT * FROM my_table WHERE ((a, b) IN ('a', 'b'))`);
  });

  it.skip("test_sql_parse_select_29 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM my_table
        WHERE (a, b) in (('a', 'b'), ('c', 'd'))`, `SELECT * FROM my_table
        WHERE ((a, b) IN (('a', 'b'), ('c', 'd')))`);
  });

  it.skip("test_sql_parse_select_30 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT (SELECT * FROM table_one)`, `SELECT ((SELECT * FROM table_one))`);
  });

  it.skip("test_sql_parse_select_31 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT my_func((select * from table_one))`, `SELECT my_func(((SELECT * FROM table_one)))`);
  });

  it.skip("test_sql_parse_select_32 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT 1`);
  });

  it.skip("test_sql_parse_select_33 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT 2`);
  });

  it.skip("test_sql_parse_select_34 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT $1`);
  });

  it.skip("test_sql_parse_select_35 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT 1; SELECT a FROM b`);
  });

  it.skip("test_sql_parse_select_36 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT COUNT(DISTINCT id), * FROM targets
        WHERE something IS NOT NULL
        AND elsewhere::interval < now()`, `SELECT count(DISTINCT id), * FROM targets
        WHERE ((something IS NOT NULL)
        AND ((elsewhere)::pg_catalog.interval < now()))`);
  });

  it.skip("test_sql_parse_select_37 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT b AS x, a AS y FROM z`);
  });

  it.skip("test_sql_parse_select_38 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`WITH a AS (SELECT * FROM x WHERE x.y = $1 AND x.z = 1)
        SELECT * FROM a`, `WITH a AS ((SELECT * FROM x WHERE ((x.y = $1) AND (x.z = 1))))
        SELECT * FROM a`);
  });

  it.skip("test_sql_parse_select_39 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM x WHERE y IN ($1)`, `SELECT * FROM x WHERE (y IN ($1))`);
  });

  it.skip("test_sql_parse_select_40 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM x WHERE y IN ($1, $2, $3)`, `SELECT * FROM x WHERE (y IN ($1, $2, $3))`);
  });

  it.skip("test_sql_parse_select_41 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM x WHERE y IN ( $1::uuid )`, `SELECT * FROM x WHERE (y IN (($1)::uuid))`);
  });

  it.skip("test_sql_parse_select_42 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM x
        WHERE y IN ( $1::uuid, $2::uuid, $3::uuid )`, `SELECT * FROM x
        WHERE (y IN (($1)::uuid, ($2)::uuid, ($3)::uuid))`);
  });

  it.skip("test_sql_parse_select_43 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM x AS a, y AS b`);
  });

  it.skip("test_sql_parse_select_44 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM y AS a, x AS b`);
  });

  it.skip("test_sql_parse_select_45 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT x AS a, y AS b FROM x`);
  });

  it.skip("test_sql_parse_select_46 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT x, y FROM z`);
  });

  it.skip("test_sql_parse_select_47 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT y, x FROM z`);
  });

  it.skip("test_sql_parse_select_48 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM a`);
  });

  it.skip("test_sql_parse_select_49 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM a AS b`);
  });

  it.skip("test_sql_parse_select_50 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`-- nothing`);
  });

  it.skip("test_sql_parse_select_51 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT INTERVAL (0) $2`, `SELECT ($2)::pg_catalog.interval`);
  });

  it.skip("test_sql_parse_select_52 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT INTERVAL (2) $2`, `SELECT ($2)::pg_catalog.interval`);
  });

  it.skip("test_sql_parse_select_53 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM t WHERE t.a IN (1, 2) AND t.b = 3`, `SELECT * FROM t WHERE ((t.a IN (1, 2)) AND (t.b = 3))`);
  });

  it.skip("test_sql_parse_select_54 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM t WHERE t.b = 3 AND t.a IN (1, 2)`, `SELECT * FROM t WHERE ((t.b = 3) AND (t.a IN (1, 2)))`);
  });

  it.skip("test_sql_parse_select_55 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM t WHERE a && '[1,2]'`, `SELECT * FROM t WHERE (a && '[1,2]')`);
  });

  it.skip("test_sql_parse_select_56 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM t WHERE a && '[1,2]'::int4range`, `SELECT * FROM t WHERE (a && ('[1,2]')::int4range)`);
  });

  it.skip("test_sql_parse_select_57 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM t_20210301_x`);
  });

  it.skip("test_sql_parse_select_58 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT (1.2 * 3.4)`);
  });

  it.skip("test_sql_parse_select_59 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT TRUE; SELECT FALSE`);
  });

  it.skip("test_sql_parse_select_60 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT -1; SELECT 0; SELECT 1`);
  });

  it.skip("test_sql_parse_select_61 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a[1:3], b.x`, `SELECT (a)[1:3], b.x`);
  });

  it.skip("test_sql_parse_insert_00 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO my_table (id, name) VALUES (1, 'some')`);
  });

  it.skip("test_sql_parse_insert_01 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO my_table (id, name) SELECT 1, 'some'`, `INSERT INTO my_table (id, name) ((SELECT 1, 'some'))`);
  });

  it.skip("test_sql_parse_insert_02 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO my_table (id) VALUES (5) RETURNING id, date`);
  });

  it.skip("test_sql_parse_insert_03 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO my_table (id) VALUES (5) RETURNING id, "date"`, `INSERT INTO my_table (id) VALUES (5) RETURNING id, date`);
  });

  it.skip("test_sql_parse_insert_04 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO my_table (id) VALUES(1); SELECT * FROM my_table`, `INSERT INTO my_table (id) VALUES (1); SELECT * FROM my_table`);
  });

  it.skip("test_sql_parse_insert_05 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO my_table`);
  });

  it.skip("test_sql_parse_insert_06 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO table_one (id, name) SELECT * from table_two`, `INSERT INTO table_one (id, name) ((SELECT * FROM table_two))`);
  });

  it.skip("test_sql_parse_insert_07 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`WITH fake as (SELECT * FROM inner_table)
        INSERT INTO dataset SELECT * FROM fake`, `WITH fake AS ((SELECT * FROM inner_table))
        INSERT INTO dataset ((SELECT * FROM fake))`);
  });

  it.skip("test_sql_parse_insert_08 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO test (a, b) VALUES
        (ARRAY[$1, $1, $2, $3], $4::timestamptz),
        (ARRAY[$1, $1, $2, $3], $4::timestamptz),
        ($5, $6::timestamptz)`, `INSERT INTO test (a, b) VALUES
        (ARRAY[$1, $1, $2, $3], ($4)::timestamptz),
        (ARRAY[$1, $1, $2, $3], ($4)::timestamptz),
        ($5, ($6)::timestamptz)`);
  });

  it.skip("test_sql_parse_insert_09 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO films (code, title, did) VALUES
('UA502', 'Bananas', 105), ('T_601', 'Yojimbo', DEFAULT)`);
  });

  it.skip("test_sql_parse_insert_10 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO films (code, title, did) VALUES ($1, $2, $3)`);
  });

  it.skip("test_sql_parse_insert_11 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO films DEFAULT VALUES
ON CONFLICT DO UPDATE
SET (a, b) = ('a', 'b'), c = 'c', (d, e) = ('d', 'e')`);
  });

  it.skip("test_sql_parse_insert_12 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO foo DEFAULT VALUES
        RETURNING a[1:3] AS a, b.x AS b`, `INSERT INTO foo DEFAULT VALUES
        RETURNING (a)[1:3] AS a, b.x AS b`);
  });

  it.skip("test_sql_parse_insert_13 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO map (key, value) VALUES ('x', 3)
        ON CONFLICT (key)
        DO UPDATE SET value = map.value + excluded.value
        WHERE map.value < 20`, `INSERT INTO map (key, value) VALUES ('x', 3)
        ON CONFLICT (key)
        DO UPDATE SET value = (map.value + excluded.value)
        WHERE (map.value < 20)`);
  });

  it.skip("test_sql_parse_insert_14 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO map VALUES ('x', 3)
ON CONFLICT ON CONSTRAINT my_constraint
DO UPDATE SET value = 42`);
  });

  it.skip("test_sql_parse_insert_15 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO map VALUES ('x', 3)
        ON CONFLICT (key) WHERE key < 100
        DO UPDATE SET value = 42`, `INSERT INTO map VALUES ('x', 3)
        ON CONFLICT (key) WHERE (key < 100)
        DO UPDATE SET value = 42`);
  });

  it.skip("test_sql_parse_insert_16 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO map VALUES ('x', 3)
ON CONFLICT (key)
DO UPDATE SET (key, value) = ('_', 0)`);
  });

  it.skip("test_sql_parse_insert_17 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO map VALUES ('x', 3)
ON CONFLICT (key)
DO UPDATE SET key = '_', value = DEFAULT`);
  });

  it.skip("test_sql_parse_insert_18 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`INSERT INTO map VALUES ('x', 3)
ON CONFLICT (mod(key, 5) DESC NULLS LAST)
DO NOTHING`);
  });

  it.skip("test_sql_parse_update_00 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE my_table SET the_value = DEFAULT`);
  });

  it.skip("test_sql_parse_update_01 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE tictactoe SET board[1:3][1:3] = '{{,,},{,,},{,,}}'
        WHERE game = 1`, `UPDATE tictactoe SET board[1:3][1:3] = '{{,,},{,,},{,,}}'
        WHERE (game = 1)`);
  });

  it.skip("test_sql_parse_update_02 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE accounts SET
        (contact_first_name, contact_last_name) =
        (SELECT first_name, last_name
        FROM salesmen WHERE salesmen.id = accounts.sales_id)`, `UPDATE accounts SET
        (contact_first_name, contact_last_name) =
        ((SELECT first_name, last_name
        FROM salesmen WHERE (salesmen.id = accounts.sales_id)))`);
  });

  it.skip("test_sql_parse_update_03 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE my_table SET id = 5; DELETE FROM my_table`);
  });

  it.skip("test_sql_parse_update_04 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE dataset SET a = 5
        WHERE id IN (SELECT * from table_one)
        OR age IN (select * from table_two)`, `UPDATE dataset SET a = 5
        WHERE (id = ANY ((SELECT * FROM table_one))
        OR age = ANY ((SELECT * FROM table_two)))`);
  });

  it.skip("test_sql_parse_update_05 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE dataset SET a = 5 FROM extra WHERE b = c`, `UPDATE dataset SET a = 5 FROM extra WHERE (b = c)`);
  });

  it.skip("test_sql_parse_update_06 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE users SET one_thing = $1, second_thing = $2
        WHERE users.id = $1`, `UPDATE users SET one_thing = $1, second_thing = $2
        WHERE (users.id = $1)`);
  });

  it.skip("test_sql_parse_update_07 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE users SET something_else = $1 WHERE users.id = $1`, `UPDATE users SET something_else = $1 WHERE (users.id = $1)`);
  });

  it.skip("test_sql_parse_update_08 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE users SET something_else =
        (SELECT a FROM x WHERE uid = users.id LIMIT 1)
        WHERE users.id = $1`, `UPDATE users SET something_else =
        ((SELECT a FROM x WHERE (uid = users.id) LIMIT 1))
        WHERE (users.id = $1)`);
  });

  it.skip("test_sql_parse_update_09 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE x SET a = 1, b = 2, c = 3`);
  });

  it.skip("test_sql_parse_update_10 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE x SET z = now()`);
  });

  it.skip("test_sql_parse_update_11 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE x SET (a, b) = ('a', 'b'), c = 'c', (d, e) = ('d', 'e')`);
  });

  it.skip("test_sql_parse_update_12 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE tictactoe SET
(board[1:3][1:3], finished) = ('{{,,},{,,},{,,}}', FALSE)`);
  });

  it.skip("test_sql_parse_update_13 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`UPDATE tictactoe SET a = a RETURNING *`);
  });

  it.skip("test_sql_parse_delete [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`DELETE FROM dataset USING table_one
        WHERE x = y OR x IN (SELECT * from table_two)`, `DELETE FROM dataset USING table_one
        WHERE ((x = y) OR x = ANY ((SELECT * FROM table_two)))`);
  });

  it.skip("test_sql_parse_transaction_00 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`BEGIN`);
  });

  it.skip("test_sql_parse_transaction_01 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`BEGIN TRANSACTION`, `BEGIN`);
  });

  it.skip("test_sql_parse_transaction_02 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY DEFERRABLE`);
  });

  it.skip("test_sql_parse_transaction_03 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`START TRANSACTION`);
  });

  it.skip("test_sql_parse_transaction_04 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`START TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
  });

  it.skip("test_sql_parse_transaction_05 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`START TRANSACTION ISOLATION LEVEL READ COMMITTED`);
  });

  it.skip("test_sql_parse_transaction_06 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`START TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`);
  });

  it.skip("test_sql_parse_transaction_07 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`START TRANSACTION READ WRITE`);
  });

  it.skip("test_sql_parse_transaction_08 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`START TRANSACTION READ ONLY`);
  });

  it.skip("test_sql_parse_transaction_09 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`START TRANSACTION NOT DEFERRABLE`);
  });

  it.skip("test_sql_parse_transaction_10 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`START TRANSACTION DEFERRABLE`);
  });

  it.skip("test_sql_parse_transaction_11 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COMMIT`);
  });

  it.skip("test_sql_parse_transaction_12 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COMMIT TRANSACTION`, `COMMIT`);
  });

  it.skip("test_sql_parse_transaction_13 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COMMIT WORK`, `COMMIT`);
  });

  it.skip("test_sql_parse_transaction_14 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COMMIT AND NO CHAIN`, `COMMIT`);
  });

  it.skip("test_sql_parse_transaction_15 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COMMIT AND CHAIN`);
  });

  it.skip("test_sql_parse_transaction_16 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`ROLLBACK`);
  });

  it.skip("test_sql_parse_transaction_17 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`ROLLBACK TRANSACTION`, `ROLLBACK`);
  });

  it.skip("test_sql_parse_transaction_18 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`ROLLBACK WORK`, `ROLLBACK`);
  });

  it.skip("test_sql_parse_transaction_19 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`ROLLBACK AND NO CHAIN`, `ROLLBACK`);
  });

  it.skip("test_sql_parse_transaction_20 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`ROLLBACK AND CHAIN`);
  });

  it.skip("test_sql_parse_transaction_21 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SAVEPOINT some_id`);
  });

  it.skip("test_sql_parse_transaction_22 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`RELEASE some_id`);
  });

  it.skip("test_sql_parse_transaction_23 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`ROLLBACK TO SAVEPOINT savepoint_name`);
  });

  it.skip("test_sql_parse_transaction_24 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`PREPARE TRANSACTION 'transaction_id'`);
  });

  it.skip("test_sql_parse_transaction_25 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COMMIT PREPARED 'transaction_id'`);
  });

  it.skip("test_sql_parse_transaction_26 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`ROLLBACK PREPARED 'transaction_id'`);
  });

  it.skip("test_sql_parse_transaction_27 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE`);
  });

  it.skip("test_sql_parse_transaction_28 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
  });

  it.skip("test_sql_parse_query_00 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM
(VALUES (1, 'one'), (2, 'two')) AS t(num, letter)`);
  });

  it.skip("test_sql_parse_query_01 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM my_table ORDER BY field ASC NULLS LAST USING @>`);
  });

  it.skip("test_sql_parse_query_02 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT m.* FROM mytable AS m FOR UPDATE`);
  });

  it.skip("test_sql_parse_query_03 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT m.* FROM mytable m FOR SHARE of m nowait`);
  });

  it.skip("test_sql_parse_query_04 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM unnest(ARRAY['a', 'b', 'c', 'd', 'e', 'f'])`);
  });

  it.skip("test_sql_parse_query_06 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT ?`);
  });

  it.skip("test_sql_parse_query_07 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM x WHERE y = ?`);
  });

  it.skip("test_sql_parse_query_08 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM x WHERE y = ANY ($1)`);
  });

  it.skip("test_sql_parse_query_09 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`PREPARE fooplan (int, text, bool, numeric) AS (SELECT $1, $2, $3, $4)`, `PREPARE fooplan(pg_catalog.int4, text, bool, pg_catalog.numeric) AS (
            SELECT $1, $2, $3, $4
        )`);
  });

  it.skip("test_sql_parse_query_10 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`EXECUTE fooplan(1, 'Hunter Valley', 't', 200.00)`);
  });

  it.skip("test_sql_parse_query_11 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`DEALLOCATE a123`);
  });

  it.skip("test_sql_parse_query_12 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`DEALLOCATE ALL`);
  });

  it.skip("test_sql_parse_query_13 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`EXPLAIN ANALYZE SELECT a`);
  });

  it.skip("test_sql_parse_query_14 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`VACUUM FULL my_table`);
  });

  it.skip("test_sql_parse_query_15 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT (pg_column_size(ROW()))::text`);
  });

  it.skip("test_sql_parse_query_19 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`DECLARE cursor_123 CURSOR FOR
SELECT * FROM test WHERE id = 123`);
  });

  it.skip("test_sql_parse_query_20 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`FETCH 1000 FROM cursor_123`);
  });

  it.skip("test_sql_parse_query_21 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`CLOSE cursor_123`);
  });

  it.skip("test_sql_parse_query_22 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`CREATE VIEW view_a (a, b) AS WITH RECURSIVE view_a (a, b) AS
(SELECT * FROM a(1)) SELECT "a", "b" FROM "view_a"`);
  });

  it.skip("test_sql_parse_query_23 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`CREATE FOREIGN TABLE ft1 () SERVER no_server`);
  });

  it.skip("test_sql_parse_query_24 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`CREATE TEMPORARY TABLE my_temp_table (
            test_id integer NOT NULL
        ) ON COMMIT DROP`, `CREATE TEMPORARY TABLE my_temp_table (
            test_id pg_catalog.int4 NOT NULL
        ) ON COMMIT DROP`);
  });

  it.skip("test_sql_parse_query_25 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`CREATE TEMPORARY TABLE my_temp_table AS (SELECT 1) WITH NO DATA`);
  });

  it.skip("test_sql_parse_query_26 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`CREATE TABLE types (
        a float(2), b float(49),
        c NUMERIC(2, 3), d character(4), e char(5),
        f varchar(6), g character varying(7))`, `CREATE TABLE types (
            a pg_catalog.float4,
            b pg_catalog.float8,
            c pg_catalog.numeric,
            d pg_catalog.bpchar,
            e pg_catalog.bpchar,
            f pg_catalog.varchar,
            g pg_catalog.varchar
        )`);
  });

  it.skip("test_sql_parse_query_27 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SET LOCAL search_path TO 'my_schema', 'public'`);
  });

  it.skip("test_sql_parse_query_28 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SET SESSION datestyle TO postgres, dmy`, `SET datestyle TO 'postgres', 'dmy'`);
  });

  it.skip("test_sql_parse_query_29 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SHOW search_path`);
  });

  it.skip("test_sql_parse_query_30 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SHOW TIME ZONE`, `SHOW timezone`);
  });

  it.skip("test_sql_parse_query_31 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT ('asxasx')[2][3:4]`);
  });

  it.skip("test_sql_parse_query_32 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT ((blah(4))[0])[2][3:4][2][5:5]`);
  });

  it.skip("test_sql_parse_query_33 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a <= ANY (ARRAY[1, 2, 3])`);
  });

  it.skip("test_sql_parse_query_34 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a <= ALL (ARRAY[1, 2, 3])`);
  });

  it.skip("test_sql_parse_query_35 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a <= some(array[1, 2, 3])`, `SELECT a <= ANY (ARRAY[1, 2, 3])`);
  });

  it.skip("test_sql_parse_query_36 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a NOT IN (1, 2, 3)`, `SELECT (a NOT IN (1, 2, 3))`);
  });

  it.skip("test_sql_parse_query_37 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a NOT LIKE 'a%'`, `SELECT (a NOT LIKE 'a%')`);
  });

  it.skip("test_sql_parse_query_38 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a NOT ILIKE 'a%'`, `SELECT (a NOT ILIKE 'a%')`);
  });

  it.skip("test_sql_parse_query_39 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT a ILIKE 'a%'`, `SELECT (a ILIKE 'a%')`);
  });

  it.skip("test_sql_parse_query_40 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`WITH RECURSIVE t(n) AS (((
    VALUES (1)
) UNION ALL (
    SELECT (n + 1) FROM t WHERE (n < 100)
)))
SELECT sum(n) FROM t`);
  });

  it.skip("test_sql_parse_query_41 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT 1 FROM t WHERE ia.attnum > 0 AND NOT ia.attisdropped`, `SELECT 1 FROM t WHERE ((ia.attnum > 0) AND (NOT ia.attisdropped))`);
  });

  it.skip("test_sql_parse_query_42 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT ($1)::oid[]`);
  });

  it.skip("test_sql_parse_query_43 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT ($1)::oid[5]`);
  });

  it.skip("test_sql_parse_query_44 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT ($1)::oid[5][6]`);
  });

  it.skip("test_sql_parse_query_45 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SET LOCAL search_path TO DEFAULT`);
  });

  it.skip("test_sql_parse_query_46 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SET SESSION search_path TO DEFAULT`, `SET search_path TO DEFAULT`);
  });

  it.skip("test_sql_parse_query_47 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`RESET search_path`, `SET search_path TO DEFAULT`);
  });

  it.skip("test_sql_parse_query_48 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`RESET ALL`);
  });

  it.skip("test_sql_parse_query_49 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT nullif(a, 3) FROM b`);
  });

  it.skip("test_sql_parse_query_50 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT 'a'::char, 'a'::"char"`, `SELECT ('a')::pg_catalog.bpchar, ('a')::pg_catalog.char`);
  });

  it.skip("test_sql_parse_query_51 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT ARRAY ((SELECT c FROM a)) FROM b`);
  });

  it.skip("test_sql_parse_query_52 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT * FROM b WHERE (c ILIKE 'blah%' COLLATE collation_name)`);
  });

  it.skip("test_sql_parse_query_53 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT GREATEST(x, y, 0), LEAST(x, y, 100) FROM b`);
  });

  it.skip("test_sql_parse_query_54 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT (x IS DISTINCT FROM y) FROM b`);
  });

  it.skip("test_sql_parse_query_55 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT (x IS NOT DISTINCT FROM y) FROM b`);
  });

  it.skip("test_sql_parse_query_56 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT dense_rank('1') WITHIN GROUP (ORDER BY 1)`);
  });

  it.skip("test_sql_parse_lock_01 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN ACCESS SHARE MODE`);
  });

  it.skip("test_sql_parse_lock_02 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN ACCESS SHARE MODE NOWAIT`);
  });

  it.skip("test_sql_parse_lock_03 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE ONLY (films) IN ACCESS SHARE MODE`);
  });

  it.skip("test_sql_parse_lock_04 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE ONLY (films) IN ACCESS SHARE MODE NOWAIT`);
  });

  it.skip("test_sql_parse_lock_05 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN ROW SHARE MODE`);
  });

  it.skip("test_sql_parse_lock_06 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN ROW EXCLUSIVE MODE`);
  });

  it.skip("test_sql_parse_lock_07 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN SHARE UPDATE EXCLUSIVE MODE`);
  });

  it.skip("test_sql_parse_lock_08 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN SHARE MODE`);
  });

  it.skip("test_sql_parse_lock_09 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN SHARE ROW EXCLUSIVE MODE`);
  });

  it.skip("test_sql_parse_lock_10 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN EXCLUSIVE MODE`);
  });

  it.skip("test_sql_parse_lock_11 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`LOCK TABLE films IN ACCESS EXCLUSIVE MODE`);
  });

  it.skip("test_sql_parse_transaction_29 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SET SESSION transaction_isolation = serializable`, `SET LOCAL transaction_isolation TO 'serializable'`);
  });

  it.skip("test_sql_parse_transaction_30 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`RESET transaction_deferrable`, `SET LOCAL transaction_deferrable TO DEFAULT`);
  });

  it.skip("test_sql_parse_transaction_31 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SET transaction_read_only TO DEFAULT`, `SET LOCAL transaction_read_only TO DEFAULT`);
  });

  it.skip("test_sql_parse_copy_01 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COPY "Movie" TO STDOUT (
    FORMAT CSV,
    FREEZE,
    DELIMITER '|',
    NULL 'this is a null',
    HEADER FALSE,
    QUOTE '''',
    ESCAPE 'e',
    FORCE_QUOTE (title, year_release),
    FORCE_NOT_NULL (title),
    FORCE_NULL (year_release),
    ENCODING 'UTF-8'
)`);
  });

  it.skip("test_sql_parse_copy_02 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COPY ((SELECT * FROM "Movie")) TO STDOUT`);
  });

  it.skip("test_sql_parse_copy_03 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COPY "Movie" (title, release_year) FROM STDIN WHERE (id > 100)`);
  });

  it.skip("test_sql_parse_copy_04 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COPY country TO STDOUT (DELIMITER '|')`);
  });

  it.skip("test_sql_parse_copy_05 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COPY country FROM '/usr1/proj/bray/sql/country_data'`);
  });

  it.skip("test_sql_parse_copy_06 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`COPY country TO PROGRAM 'gzip > /usr1/proj/bray/sql/country_data.gz'`);
  });

  it.skip("test_sql_parse_table [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`TABLE hello_world`, `SELECT * FROM hello_world`);
  });

  it.skip("test_sql_parse_select_locking_00 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT id FROM a FOR UPDATE`);
  });

  it.skip("test_sql_parse_select_locking_01 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT id FROM a FOR NO KEY UPDATE`);
  });

  it.skip("test_sql_parse_select_locking_02 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT id FROM a FOR SHARE`);
  });

  it.skip("test_sql_parse_select_locking_03 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT id FROM a FOR KEY SHARE`);
  });

  it.skip("test_sql_parse_select_locking_04 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT id FROM a FOR UPDATE NOWAIT`);
  });

  it.skip("test_sql_parse_select_locking_05 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT id FROM a FOR UPDATE SKIP LOCKED`);
  });

  it.skip("test_sql_parse_select_locking_06 [unconverted: SQL parser/codegen not implemented in sqlite-ts]", () => {
    runParseRoundTrip(`SELECT id FROM a FOR UPDATE OF b`);
  });

});