import { describe, it } from "vitest";

// Ported from gel/tests/test_sql_dml.py — exercises the EdgeDB SQL frontend
// for INSERT/UPDATE/DELETE statements (multi-property tables, rewrites,
// triggers, link bookkeeping, etc.). sqlite-ts has no PostgreSQL-compatible
// SQL frontend, so every test is a skipped parity placeholder. Each test
// body preserves the first SQL query string from the Python source as a hint
// for what to wire up once a SQL DML frontend exists.

describe("TestSQLDataModificationLanguage", () => {
  it.skip("test_sql_dml_insert_01 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_01 for details.
  });

  it.skip("test_sql_dml_insert_02 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_02 for details.
  });

  it.skip("test_sql_dml_insert_03 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_03 for details.
  });

  it.skip("test_sql_dml_insert_04 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_04 for details.
  });

  it.skip("test_sql_dml_insert_05 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_05 for details.
  });

  it.skip("test_sql_dml_insert_06 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_06 for details.
  });

  it.skip("test_sql_dml_insert_07 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_07 for details.
  });

  it.skip("test_sql_dml_insert_08 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_08 for details.
  });

  it.skip("test_sql_dml_insert_09 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_09 for details.
  });

  it.skip("test_sql_dml_insert_10 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_10 for details.
  });

  it.skip("test_sql_dml_insert_11 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_11 for details.
  });

  it.skip("test_sql_dml_insert_12 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_12 for details.
  });

  it.skip("test_sql_dml_insert_13 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_13 for details.
  });

  it.skip("test_sql_dml_insert_14 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_14 for details.
  });

  it.skip("test_sql_dml_insert_15 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_15 for details.
  });

  it.skip("test_sql_dml_insert_16 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_16 for details.
  });

  it.skip("test_sql_dml_insert_17a [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_17a for details.
  });

  it.skip("test_sql_dml_insert_17b [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_17b for details.
  });

  it.skip("test_sql_dml_insert_18 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_18 for details.
  });

  it.skip("test_sql_dml_insert_19 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_19 for details.
  });

  it.skip("test_sql_dml_insert_20 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    const _query = `INSERT INTO "Document" (title) VALUES ('Report'), ('Briefing');`;
    void _query;
  });

  it.skip("test_sql_dml_insert_21 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    const _query = `INSERT INTO "Document" (title) VALUES ('Report'), ('Briefing')
            RETURNING id as my_id;`;
    void _query;
  });

  it.skip("test_sql_dml_insert_22 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    const _query = `INSERT INTO "Document" (title) VALUES ('Report'), ('Briefing')
            RETURNING id;`;
    void _query;
  });

  it.skip("test_sql_dml_insert_24 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_24 for details.
  });

  it.skip("test_sql_dml_insert_25 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_25 for details.
  });

  it.skip("test_sql_dml_insert_26 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_26 for details.
  });

  it.skip("test_sql_dml_insert_27 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_27 for details.
  });

  it.skip("test_sql_dml_insert_28 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_28 for details.
  });

  it.skip("test_sql_dml_insert_29 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_29 for details.
  });

  it.skip("test_sql_dml_insert_30 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_30 for details.
  });

  it.skip("test_sql_dml_insert_31 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_31 for details.
  });

  it.skip("test_sql_dml_insert_32 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_32 for details.
  });

  it.skip("test_sql_dml_insert_33 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_33 for details.
  });

  it.skip("test_sql_dml_insert_34 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_34 for details.
  });

  it.skip("test_sql_dml_insert_35 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_35 for details.
  });

  it.skip("test_sql_dml_insert_36 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_36 for details.
  });

  it.skip("test_sql_dml_insert_37 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_37 for details.
  });

  it.skip("test_sql_dml_insert_38 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_38 for details.
  });

  it.skip("test_sql_dml_insert_39 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_39 for details.
  });

  it.skip("test_sql_dml_insert_40 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_40 for details.
  });

  it.skip("test_sql_dml_insert_41 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_41 for details.
  });

  it.skip("test_sql_dml_insert_42 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_42 for details.
  });

  it.skip("test_sql_dml_insert_43 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_43 for details.
  });

  it.skip("test_sql_dml_insert_44 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_44 for details.
  });

  it.skip("test_sql_dml_insert_45 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_45 for details.
  });

  it.skip("test_sql_dml_insert_46 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_46 for details.
  });

  it.skip("test_sql_dml_insert_47 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_47 for details.
  });

  it.skip("test_sql_dml_insert_48 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_48 for details.
  });

  it.skip("test_sql_dml_insert_49 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_49 for details.
  });

  it.skip("test_sql_dml_insert_50 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_50 for details.
  });

  it.skip("test_sql_dml_insert_51 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_51 for details.
  });

  it.skip("test_sql_dml_insert_52 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_52 for details.
  });

  it.skip("test_sql_dml_insert_53 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_53 for details.
  });

  it.skip("test_sql_dml_insert_54 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_54 for details.
  });

  it.skip("test_sql_dml_insert_55 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_55 for details.
  });

  it.skip("test_sql_dml_insert_56 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_56 for details.
  });

  it.skip("test_sql_dml_insert_57 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_57 for details.
  });

  it.skip("test_sql_dml_insert_58 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_58 for details.
  });

  it.skip("test_sql_dml_insert_59 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_59 for details.
  });

  it.skip("test_sql_dml_insert_60 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_60 for details.
  });

  it.skip("test_sql_dml_insert_61 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_61 for details.
  });

  it.skip("test_sql_dml_insert_62 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_62 for details.
  });

  it.skip("test_sql_dml_insert_63 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_63 for details.
  });

  it.skip("test_sql_dml_insert_64 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_64 for details.
  });

  it.skip("test_sql_dml_insert_65 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_65 for details.
  });

  it.skip("test_sql_dml_insert_66 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_66 for details.
  });

  it.skip("test_sql_dml_insert_67 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_67 for details.
  });

  it.skip("test_sql_dml_insert_68 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_insert_68 for details.
  });

  it.skip("test_sql_dml_delete_01 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_01 for details.
  });

  it.skip("test_sql_dml_delete_02 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_02 for details.
  });

  it.skip("test_sql_dml_delete_03 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_03 for details.
  });

  it.skip("test_sql_dml_delete_04 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_04 for details.
  });

  it.skip("test_sql_dml_delete_05 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_05 for details.
  });

  it.skip("test_sql_dml_delete_06 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_06 for details.
  });

  it.skip("test_sql_dml_delete_07 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_07 for details.
  });

  it.skip("test_sql_dml_delete_08 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_08 for details.
  });

  it.skip("test_sql_dml_delete_09 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_09 for details.
  });

  it.skip("test_sql_dml_delete_10 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_10 for details.
  });

  it.skip("test_sql_dml_delete_11 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_11 for details.
  });

  it.skip("test_sql_dml_delete_12 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_12 for details.
  });

  it.skip("test_sql_dml_delete_13 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_13 for details.
  });

  it.skip("test_sql_dml_delete_14 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_delete_14 for details.
  });

  it.skip("test_sql_dml_update_01 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_01 for details.
  });

  it.skip("test_sql_dml_update_02 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_02 for details.
  });

  it.skip("test_sql_dml_update_03 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_03 for details.
  });

  it.skip("test_sql_dml_update_04 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_04 for details.
  });

  it.skip("test_sql_dml_update_05 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_05 for details.
  });

  it.skip("test_sql_dml_update_06 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_06 for details.
  });

  it.skip("test_sql_dml_update_07 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_07 for details.
  });

  it.skip("test_sql_dml_update_08 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_08 for details.
  });

  it.skip("test_sql_dml_update_09 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_09 for details.
  });

  it.skip("test_sql_dml_update_10 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_10 for details.
  });

  it.skip("test_sql_dml_update_11 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_11 for details.
  });

  it.skip("test_sql_dml_update_12 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_12 for details.
  });

  it.skip("test_sql_dml_update_13 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_13 for details.
  });

  it.skip("test_sql_dml_update_14 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_14 for details.
  });

  it.skip("test_sql_dml_update_14a [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_14a for details.
  });

  it.skip("test_sql_dml_update_15 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_15 for details.
  });

  it.skip("test_sql_dml_update_16 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_16 for details.
  });

  it.skip("test_sql_dml_update_17 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_17 for details.
  });

  it.skip("test_sql_dml_update_19 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_update_19 for details.
  });

  it.skip("test_sql_dml_01 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_01 for details.
  });

  it.skip("test_sql_dml_02 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_02 for details.
  });

  it.skip("test_sql_dml_03 [unconverted: PostgreSQL SQL DML frontend not implemented in sqlite-ts]", () => {
    // No inline query string detected in the Python source; see test_sql_dml.py::test_sql_dml_03 for details.
  });

});