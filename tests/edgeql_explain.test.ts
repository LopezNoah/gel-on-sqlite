import { describe, it } from "vitest";

// Direct port of tests/test_edgeql_explain.py (TestEdgeQLExplain +
// NameTranslation).
//
// ANALYZE / EXPLAIN is not supported in sqlite-ts: the entire
// `edb.server.compiler.explain` pipeline produces a PostgreSQL plan tree
// (IndexScan, BitmapHeapScan, fine_grained/coarse_grained shapes, etc.) which
// has no equivalent on SQLite. None of these tests are expected to run as-is.
// Each case is preserved as a skipped placeholder so that future parity work
// has a one-to-one mapping with the Python suite.

describe("TestEdgeQLExplain", () => {
  it.skip("test_edgeql_explain_simple_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select User { id, name } filter .name = 'Elvis'
    // Expected: fine_grained pipeline with IndexScan on User on (__subject__.name).
  });

  it.skip("test_edgeql_explain_introspection_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select sys::Branch
    // Expected: fine_grained pipeline references pg_database relation.
  });

  it.skip("test_edgeql_explain_with_bound_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // with U := User, select { elvis := ..., yury := ... }
    // Expected: subplans contain IndexScan / SeqScan for the two filters.
    // Also skipped upstream on Postgres 17 (operator-class changes).
  });

  it.skip("test_edgeql_explain_multi_link_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select User { name, todo: {name, number} } filter .name = 'Elvis'
    // Expected: IndexScan on User, with NestedLoop + IndexOnlyScan subplan over User.todo.
  });

  it.skip("test_edgeql_explain_computed_backlink_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select User { name, owned_issues: {name, number} } filter .name = 'Elvis'
    // Expected: fine_grained plan with two buffers and IndexScan on Issue.owner.
  });

  it.skip("test_edgeql_explain_inheritance_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // WITH X := Text, select X
    // Expected: Append over LogEntry / Issue / Comment IndexOnlyScans.
  });

  it.skip("test_edgeql_explain_type_intersect_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select Text { body, z := [is Issue].name }
    // Expected: Result + Append over Text subtypes, IndexScan subplan for [is Issue].
  });

  it.skip("test_edgeql_explain_insert_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // insert User { name := 'Fantix' } executed via explain
    // Expected: NestedLoop pipeline; insert is rolled back so Fantix is not visible.
  });

  it.skip("test_edgeql_explain_insert_02 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // explain insert inside a transaction with a prior insert of 'Sully'
    // Expected: NestedLoop pipeline; only Sully survives the outer transaction.
  });

  it.skip("test_edgeql_explain_options_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // analyze (buffers := True/False) select User
    // Expected: arguments echoed back; shared_read_blocks present iff buffers := true.
  });

  it.skip("test_edgeql_explain_options_02 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // analyze (bogus_argument := True) select User  -> QueryError "unknown ANALYZE argument"
    // analyze (execute := "hell yeah") select User  -> QueryError "incorrect type"
  });

  it.skip("test_edgeql_explain_ranges_contains_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // contains(.rval/.mval/.rdate/.mdate, <scalar>) — expects GiST index usage on RangeTest.
  });

  it.skip("test_edgeql_explain_ranges_contains_02 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // contains(.<range_prop>, range(...)) — expects GiST index usage on RangeTest.
  });

  it.skip("test_edgeql_explain_ranges_contains_03 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // contains(.<multirange_prop>, multirange([...])) — expects GiST index usage on RangeTest.
  });

  it.skip("test_edgeql_explain_ranges_overlaps_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // overlaps(.<prop>, range(...)) — field as first arg; expects GiST index usage.
  });

  it.skip("test_edgeql_explain_ranges_overlaps_02 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // overlaps(range(...), .<prop>) — field as second arg; expects GiST index usage.
  });

  it.skip("test_edgeql_explain_ranges_adjacent_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // adjacent(.<prop>, range(...)) — field as first arg; expects GiST index usage.
  });

  it.skip("test_edgeql_explain_ranges_adjacent_02 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // adjacent(range(...), .<prop>) — field as second arg; expects GiST index usage.
  });

  it.skip("test_edgeql_explain_ranges_strictly_below_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // strictly_below(.<prop>, range(...)) — field as first arg.
  });

  it.skip("test_edgeql_explain_ranges_strictly_below_02 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // strictly_below(range(...), .<prop>) — field as second arg.
  });

  it.skip("test_edgeql_explain_ranges_strictly_above_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // strictly_above(.<prop>, range(...)) — field as first arg.
  });

  it.skip("test_edgeql_explain_ranges_strictly_above_02 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // strictly_above(range(...), .<prop>) — field as second arg.
  });

  it.skip("test_edgeql_explain_ranges_bounded_below_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // bounded_below(.<prop>, range(...)) — expects GiST index usage.
  });

  it.skip("test_edgeql_explain_ranges_bounded_above_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // bounded_above(.<prop>, range(...)) — expects GiST index usage.
  });

  it.skip("test_edgeql_explain_json_contains_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select JSONTest filter contains(.val, <json>(b := 123))
    // Expected: BitmapHeapScan with BitmapIndexScan using std::pg::gin index on .val.
  });

  it.skip("test_edgeql_explain_user_func_index_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select Issue filter .number2 = '500!' — expects index usage via user-defined function index.
  });

  it.skip("test_edgeql_explain_order_index_01 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select User order by .name limit 1 — expects index usage on name.
  });

  it.skip("test_edgeql_explain_order_index_02 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select User order by .id limit 1 — expects index usage via id's exclusive constraint.
  });

  it.skip("test_edgeql_explain_order_index_03 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // select User filter .id > <uuid>... order by .id empty last limit 1 — expects index usage.
  });

  it.skip("test_edgeql_explain_bug_5758 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // Regression: coarse_grained plan must not be None when main_alias is missing.
  });

  it.skip("test_edgeql_explain_bug_5791 [not supported: analyze/explain not implemented in sqlite-ts]", () => {
    // Regression: coarse_grained plan must not be None for complex SELECT-with-shape query.
  });
});

describe("NameTranslation", () => {
  it.skip("test_name_default [not supported: pg_tree._translate_name has no sqlite-ts equivalent]", () => {
    // _translate_name(QualName('default', 'Type1'), {'default': None}) -> 'Type1'
    // _translate_name(QualName('mod1', 'Type2'),    {'default': None}) -> 'mod1::Type2'
    // _translate_name(QualName('m1::m2', 'Type3'),  {'default': None}) -> 'm1::m2::Type3'
  });

  it.skip("test_name_aliases_01 [not supported: pg_tree._translate_name has no sqlite-ts equivalent]", () => {
    // raliases = {'mod1': None, 'mod2': 'main'}
    // default::Type1 -> 'default::Type1'
    // mod1::Type2    -> 'Type2'
    // mod2::Type3    -> 'main::Type3'
  });

  it.skip("test_name_aliases_nested_01 [not supported: pg_tree._translate_name has no sqlite-ts equivalent]", () => {
    // raliases = {'mod1': None, 'mod2': 'main', 'mod3::mod4': 'aux'}
    // default::Type1         -> 'default::Type1'
    // mod1::mod2::Type2      -> 'mod1::mod2::Type2'  (no default-module replacement when nested)
    // mod3::mod4::mod5::Type3      -> 'aux::mod5::Type3'
    // mod3::mod4::mod5::mod6::Type4 -> 'aux::mod5::mod6::Type4'
    // mod3::mod7::Type5      -> 'mod3::mod7::Type5'
    // mod2::mod3::mod4::Type6 -> 'main::mod3::mod4::Type6'
  });
});
