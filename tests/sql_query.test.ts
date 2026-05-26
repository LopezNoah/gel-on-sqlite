import { describe, it } from "vitest";

// Ported from gel/tests/test_sql_query.py — tests the EdgeDB SQL frontend by
// speaking PostgreSQL wire protocol to a running server and asserting on the
// returned rows / column shapes. sqlite-ts has no PostgreSQL-compatible SQL
// frontend (its runtime executes EdgeQL only and lowers to SQLite SQL
// internally), so every test here is a skipped parity placeholder. The first
// SQL query string from each Python test is preserved in the test body as a
// hint for what to wire up once a SQL frontend lands.

describe("TestSQLQuery", () => {
  it.skip("test_sql_query_psql_describe_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_psql_describe_01 for details.
  });

  it.skip("test_sql_query_00 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT title FROM "Movie" order by title`;
    void _query;
  });

  it.skip("test_sql_query_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT mve.title, mve.release_year, director_id FROM "Movie" as mve`;
    void _query;
  });

  it.skip("test_sql_query_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT * FROM "Content"`;
    void _query;
  });

  it.skip("test_sql_query_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT * FROM ONLY "Content" -- should have only one result`;
    void _query;
  });

  it.skip("test_sql_query_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT mve.title, "Person".first_name
            FROM "Movie" mve, "Person" WHERE mve.director_id = "Person".id`;
    void _query;
  });

  it.skip("test_sql_query_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SeLeCt mve.title as tiT, perSon.first_name
            FROM "Movie" mve, "Person" person`;
    void _query;
  });

  it.skip("test_sql_query_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT id, title, prS.first_name
            FROM "Movie" mve, (SELECT first_name FROM "Person") prs`;
    void _query;
  });

  it.skip("test_sql_query_07 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT tItLe, release_year "RL year" FROM "Movie" ORDER BY titLe;`;
    void _query;
  });

  it.skip("test_sql_query_08 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT "Movie".id, "Genre".id
            FROM "Movie" JOIN "Genre" ON "Movie".genre_id = "Genre".id`;
    void _query;
  });

  it.skip("test_sql_query_09 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT "Movie".id, title, name
            FROM "Movie" JOIN "Genre" ON "Movie".genre_id = "Genre".id`;
    void _query;
  });

  it.skip("test_sql_query_10 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT m.* FROM "Movie" m`;
    void _query;
  });

  it.skip("test_sql_query_11 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT * FROM "Movie"
            JOIN "Genre" g ON "Movie".genre_id = g.id`;
    void _query;
  });

  it.skip("test_sql_query_12 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT * FROM "Movie"
            JOIN (SELECT id as genre_id, name FROM "Genre") g USING (genre_id)`;
    void _query;
  });

  it.skip("test_sql_query_13 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `WITH g AS (SELECT id as genre_id, name FROM "Genre")
            SELECT * FROM "Movie" JOIN g USING (genre_id)`;
    void _query;
  });

  it.skip("test_sql_query_14 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT title, CASE WHEN title='Forrest Gump' THEN 'forest'
            WHEN title='Saving Private Ryan' THEN 'the war film'
            ELSE 'unknown' END AS nick_name FROM "Movie"`;
    void _query;
  });

  it.skip("test_sql_query_15 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT id, title FROM "Movie" UNION SELECT id, title FROM "Book"`;
    void _query;
  });

  it.skip("test_sql_query_16 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_16 for details.
  });

  it.skip("test_sql_query_17 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_17 for details.
  });

  it.skip("test_sql_query_18 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT title FROM "Content" ORDER BY title OFFSET 1 LIMIT 2`;
    void _query;
  });

  it.skip("test_sql_query_19 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_19 for details.
  });

  it.skip("test_sql_query_20 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_20 for details.
  });

  it.skip("test_sql_query_21 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `WITH content AS (
                SELECT c.id, c.title, pages
                FROM "Content" c LEFT JOIN "Book" USING(id)
            ),
            content2 AS (
                SELECT id, COALESCE(pages, 0) as pages FROM content
            )
            SELECT pages, sum(pages) OVER (ORDER BY pages)
            FROM content2 ORDER BY pages DESC`;
    void _query;
  });

  it.skip("test_sql_query_22 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_22 for details.
  });

  it.skip("test_sql_query_23 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_23 for details.
  });

  it.skip("test_sql_query_24 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_24 for details.
  });

  it.skip("test_sql_query_25 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_25 for details.
  });

  it.skip("test_sql_query_26 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_26 for details.
  });

  it.skip("test_sql_query_27 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_27 for details.
  });

  it.skip("test_sql_query_28 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT name, title
            FROM "Movie" m CROSS JOIN LATERAL (
                SELECT g.name FROM "Genre" g WHERE m.genre_id = g.id
            ) t
            ORDER BY title`;
    void _query;
  });

  it.skip("test_sql_query_29 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_29 for details.
  });

  it.skip("test_sql_query_30 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_30 for details.
  });

  it.skip("test_sql_query_31 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_31 for details.
  });

  it.skip("test_sql_query_32 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_32 for details.
  });

  it.skip("test_sql_query_33 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_33 for details.
  });

  it.skip("test_sql_query_33a [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_33a for details.
  });

  it.skip("test_sql_query_34 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT substr(title, 2, 4) AS itl, count(*) FROM "Movie"
            GROUP BY itl
            ORDER BY itl`;
    void _query;
  });

  it.skip("test_sql_query_35 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT title AS aliased_title, count(*) FROM "Movie"
            GROUP BY title
            ORDER BY title`;
    void _query;
  });

  it.skip("test_sql_query_36 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_36 for details.
  });

  it.skip("test_sql_query_37 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_37 for details.
  });

  it.skip("test_sql_query_38 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_38 for details.
  });

  it.skip("test_sql_query_38a [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_38a for details.
  });

  it.skip("test_sql_query_39 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_39 for details.
  });

  it.skip("test_sql_query_40 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_40 for details.
  });

  it.skip("test_sql_query_41 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_41 for details.
  });

  it.skip("test_sql_query_42 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_42 for details.
  });

  it.skip("test_sql_query_43 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_43 for details.
  });

  it.skip("test_sql_query_44 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_44 for details.
  });

  it.skip("test_sql_query_45 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_45 for details.
  });

  it.skip("test_sql_query_46 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_46 for details.
  });

  it.skip("test_sql_query_47 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_47 for details.
  });

  it.skip("test_sql_query_48 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_48 for details.
  });

  it.skip("test_sql_query_49 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_49 for details.
  });

  it.skip("test_sql_query_50 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_50 for details.
  });

  it.skip("test_sql_query_51 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `TABLE "Movie"`;
    void _query;
  });

  it.skip("test_sql_query_52 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_52 for details.
  });

  it.skip("test_sql_query_53 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_53 for details.
  });

  it.skip("test_sql_query_54 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_54 for details.
  });

  it.skip("test_sql_query_55 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_55 for details.
  });

  it.skip("test_sql_query_56 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_56 for details.
  });

  it.skip("test_sql_query_57 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_57 for details.
  });

  it.skip("test_sql_query_58 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_58 for details.
  });

  it.skip("test_sql_query_59 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_59 for details.
  });

  it.skip("test_sql_query_60 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_60 for details.
  });

  it.skip("test_sql_query_61 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_61 for details.
  });

  it.skip("test_sql_query_62 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_62 for details.
  });

  it.skip("test_sql_query_63 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_63 for details.
  });

  it.skip("test_sql_query_introspection_00 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_introspection_00 for details.
  });

  it.skip("test_sql_query_introspection_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_introspection_01 for details.
  });

  it.skip("test_sql_query_introspection_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_introspection_02 for details.
  });

  it.skip("test_sql_query_introspection_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_introspection_03 for details.
  });

  it.skip("test_sql_query_introspection_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_introspection_04 for details.
  });

  it.skip("test_sql_query_introspection_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_introspection_05 for details.
  });

  it.skip("test_sql_query_introspection_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_introspection_06 for details.
  });

  it.skip("test_sql_query_schemas_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_schemas_01 for details.
  });

  it.skip("test_sql_query_static_eval_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_01 for details.
  });

  it.skip("test_sql_query_static_eval_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_02 for details.
  });

  it.skip("test_sql_query_static_eval_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_03 for details.
  });

  it.skip("test_sql_query_static_eval_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_04 for details.
  });

  it.skip("test_sql_query_static_eval_04a [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_04a for details.
  });

  it.skip("test_sql_query_static_eval_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_05 for details.
  });

  it.skip("test_sql_query_static_eval_05a [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_05a for details.
  });

  it.skip("test_sql_query_static_eval_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_06 for details.
  });

  it.skip("test_sql_query_static_eval_07 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_07 for details.
  });

  it.skip("test_sql_query_static_eval_08 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_08 for details.
  });

  it.skip("test_sql_query_static_eval_09 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_static_eval_09 for details.
  });

  it.skip("test_sql_native_query_static_eval_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_static_eval_01 for details.
  });

  it.skip("test_sql_query_be_state [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_be_state for details.
  });

  it.skip("test_sql_query_privileges_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_privileges_01 for details.
  });

  it.skip("test_sql_query_privileges_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_privileges_02 for details.
  });

  it.skip("test_sql_query_privileges_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_privileges_03 for details.
  });

  it.skip("test_sql_query_privileges_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_privileges_04 for details.
  });

  it.skip("test_sql_query_privileges_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_privileges_05 for details.
  });

  it.skip("test_sql_query_client_encoding_1 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_client_encoding_1 for details.
  });

  it.skip("test_sql_query_client_encoding_2 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_client_encoding_2 for details.
  });

  it.skip("test_sql_query_client_encoding_3 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_client_encoding_3 for details.
  });

  it.skip("test_sql_query_server_version [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_server_version for details.
  });

  it.skip("test_sql_query_server_version_num [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_server_version_num for details.
  });

  it.skip("test_sql_query_version [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_version for details.
  });

  it.skip("test_sql_query_copy_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_copy_01 for details.
  });

  it.skip("test_sql_query_copy_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_copy_02 for details.
  });

  it.skip("test_sql_query_copy_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_copy_03 for details.
  });

  it.skip("test_sql_query_copy_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_copy_04 for details.
  });

  it.skip("test_sql_query_copy_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_copy_05 for details.
  });

  it.skip("test_sql_query_copy_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_copy_06 for details.
  });

  it.skip("test_sql_query_copy_07 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_copy_07 for details.
  });

  it.skip("test_sql_query_copy_08 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_copy_08 for details.
  });

  it.skip("test_sql_query_error_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_01 for details.
  });

  it.skip("test_sql_query_error_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_02 for details.
  });

  it.skip("test_sql_query_error_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_03 for details.
  });

  it.skip("test_sql_query_error_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_04 for details.
  });

  it.skip("test_sql_query_error_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_05 for details.
  });

  it.skip("test_sql_query_error_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_06 for details.
  });

  it.skip("test_sql_query_error_07 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_07 for details.
  });

  it.skip("test_sql_query_error_08 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_08 for details.
  });

  it.skip("test_sql_query_error_09 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_09 for details.
  });

  it.skip("test_sql_query_error_10 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_10 for details.
  });

  it.skip("test_sql_query_prepare_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_prepare_01 for details.
  });

  it.skip("test_sql_query_prepare_error_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `PREPARE pserr1 AS (SELECT * FROM "Movie" ORDER BY 1 + 'a')`;
    void _query;
  });

  it.skip("test_sql_query_empty [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_empty for details.
  });

  it.skip("test_sql_query_pgadmin_hack [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_pgadmin_hack for details.
  });

  it.skip("test_sql_query_computed_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_01 for details.
  });

  it.skip("test_sql_query_computed_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_02 for details.
  });

  it.skip("test_sql_query_computed_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_03 for details.
  });

  it.skip("test_sql_query_computed_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_04 for details.
  });

  it.skip("test_sql_query_computed_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_05 for details.
  });

  it.skip("test_sql_query_computed_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_06 for details.
  });

  it.skip("test_sql_query_computed_07 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_07 for details.
  });

  it.skip("test_sql_query_computed_08 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_08 for details.
  });

  it.skip("test_sql_query_computed_09 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_09 for details.
  });

  it.skip("test_sql_query_computed_10 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_10 for details.
  });

  it.skip("test_sql_query_computed_11 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_11 for details.
  });

  it.skip("test_sql_query_computed_12 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_12 for details.
  });

  it.skip("test_sql_query_computed_13 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_computed_13 for details.
  });

  it.skip("test_sql_query_computed_14 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT first_name, directed_movie_id IS NOT NULL FROM "Person"
            ORDER BY first_name`;
    void _query;
  });

  it.skip("test_sql_query_access_policy_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_01 for details.
  });

  it.skip("test_sql_query_access_policy_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_02 for details.
  });

  it.skip("test_sql_query_access_policy_03a [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_03a for details.
  });

  it.skip("test_sql_query_access_policy_03b [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_03b for details.
  });

  it.skip("test_sql_query_access_policy_03c [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_03c for details.
  });

  it.skip("test_sql_query_access_policy_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_04 for details.
  });

  it.skip("test_sql_query_access_policy_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_05 for details.
  });

  it.skip("test_sql_query_access_policy_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_06 for details.
  });

  it.skip("test_sql_query_access_policy_07 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_access_policy_07 for details.
  });

  it.skip("test_sql_query_subquery_splat_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `with "average_pages" as (select avg("pages") as "value" from "Book")
            select pages from "Book"
            where "Book".pages < (select * from "average_pages")`;
    void _query;
  });

  it.skip("test_sql_query_having_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_having_01 for details.
  });

  it.skip("test_sql_query_unsupported_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_unsupported_01 for details.
  });

  it.skip("test_sql_query_locking_00 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_locking_00 for details.
  });

  it.skip("test_sql_query_locking_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_locking_01 for details.
  });

  it.skip("test_sql_query_locking_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_locking_02 for details.
  });

  it.skip("test_sql_query_locking_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_locking_03 for details.
  });

  it.skip("test_sql_query_reparse_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    const _query = `SELECT ('literal str'::text, 42::int)`;
    void _query;
  });

  it.skip("test_sql_native_query_00 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_00 for details.
  });

  it.skip("test_sql_native_query_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_01 for details.
  });

  it.skip("test_sql_native_query_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_02 for details.
  });

  it.skip("test_sql_native_query_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_03 for details.
  });

  it.skip("test_sql_native_query_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_04 for details.
  });

  it.skip("test_sql_native_query_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_05 for details.
  });

  it.skip("test_sql_native_query_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_06 for details.
  });

  it.skip("test_sql_native_query_07 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_07 for details.
  });

  it.skip("test_sql_native_query_08 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_08 for details.
  });

  it.skip("test_sql_native_query_09 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_09 for details.
  });

  it.skip("test_sql_native_query_10 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_10 for details.
  });

  it.skip("test_sql_native_query_11 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_11 for details.
  });

  it.skip("test_sql_native_query_12 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_12 for details.
  });

  it.skip("test_sql_native_query_13 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_13 for details.
  });

  it.skip("test_sql_native_query_14 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_14 for details.
  });

  it.skip("test_sql_native_query_15 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_15 for details.
  });

  it.skip("test_sql_native_query_16 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_16 for details.
  });

  it.skip("test_sql_native_query_17 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_17 for details.
  });

  it.skip("test_sql_native_query_18 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_18 for details.
  });

  it.skip("test_sql_native_query_19 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_19 for details.
  });

  it.skip("test_sql_native_query_20 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_20 for details.
  });

  it.skip("test_sql_native_query_21 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_21 for details.
  });

  it.skip("test_sql_native_query_22 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_22 for details.
  });

  it.skip("test_sql_native_query_23 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_23 for details.
  });

  it.skip("test_sql_native_query_24 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_24 for details.
  });

  it.skip("test_sql_native_query_25 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_25 for details.
  });

  it.skip("test_sql_native_query_26 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_26 for details.
  });

  it.skip("test_sql_native_query_27 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_27 for details.
  });

  it.skip("test_sql_native_query_28 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_28 for details.
  });

  it.skip("test_sql_native_query_29 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_29 for details.
  });

  it.skip("test_sql_native_query_30 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_30 for details.
  });

  it.skip("test_sql_native_query_31 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_native_query_31 for details.
  });

  it.skip("test_sql_query_set_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_set_01 for details.
  });

  it.skip("test_sql_query_set_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_set_02 for details.
  });

  it.skip("test_sql_query_set_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_set_03 for details.
  });

  it.skip("test_sql_query_set_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_set_04 for details.
  });

  it.skip("test_sql_query_set_05 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_set_05 for details.
  });

  it.skip("test_sql_query_set_06 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_set_06 for details.
  });

  it.skip("test_sql_query_set_07 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_set_07 for details.
  });

  it.skip("test_sql_query_set_08 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_set_08 for details.
  });

  it.skip("test_sql_query_locking_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_locking_04 for details.
  });

  it.skip("test_sql_transaction_01 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_transaction_01 for details.
  });

  it.skip("test_sql_transaction_02 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_transaction_02 for details.
  });

  it.skip("test_sql_transaction_03 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_transaction_03 for details.
  });

  it.skip("test_sql_transaction_04 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_transaction_04 for details.
  });

  it.skip("test_sql_query_error_11 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_11 for details.
  });

  it.skip("test_sql_query_error_12 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_12 for details.
  });

  it.skip("test_sql_query_error_13 [unconverted: PostgreSQL SQL frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_query.py::test_sql_query_error_13 for details.
  });

});