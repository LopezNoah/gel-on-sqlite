import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLCoalesce", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "issues",
      setup: "issues_coalesce_setup",
      dbFile: "./tests/.artifacts/coalesce.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_coalesce_scalar_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    time_estimate := Issue.time_estimate ?? -1
                };
            `,
      unorderedBag([
            {
              "time_estimate": -1,
            },
            {
              "time_estimate": -1,
            },
            {
              "time_estimate": -1,
            },
            {
              "time_estimate": 60,
            },
            {
              "time_estimate": 90,
            },
            {
              "time_estimate": 90,
            },
          ])
    );
  });

  it("test_edgeql_coalesce_scalar_02", () => {
    assertQueryResult(
      h,
      `
                SELECT (Issue.number, Issue.time_estimate ?? -1)
                ORDER BY Issue.number;
            `,
      [
            ["1", 60],
            ["2", 90],
            ["3", 90],
            ["4", -1],
            ["5", -1],
            ["6", -1],
          ]
    );
  });

  it("test_edgeql_coalesce_scalar_03", () => {
    assertQueryResult(
      h,
      `
                # Only values present in the graph will be selected.
                # There is at least one value there.
                # Therefore, the second argument to ?? will not be returned.
                SELECT Issue.time_estimate ?? -1;
            `,
      unorderedBag([60, 90, 90])
    );
  });

  it("test_edgeql_coalesce_scalar_04", () => {
    assertQueryResult(
      h,
      `
                # No open issue has a time_estimate, so the first argument
                # to ?? is an empty set.
                # Therefore, the second argument to ?? will be returned.
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?? -1;
            `,
      [-1]
    );
  });

  it("test_edgeql_coalesce_scalar_05", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I := (SELECT Issue
                          FILTER Issue.status.name = 'Open')
                # No open issue has a time_estimate, so the first argument
                # to ?? is an empty set.
                # Therefore, the second argument to ?? will be returned.
                SELECT I.time_estimate ?? -1;
            `,
      [-1]
    );
  });

  it("test_edgeql_coalesce_scalar_06", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue.time_estimate ?? -1
                FILTER NOT EXISTS Issue.time_estimate;
            `,
      []
    );
  });

  it("test_edgeql_coalesce_scalar_07", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    number,
                    has_estimate := Issue.time_estimate ?!= <int64>{}
                };
            `,
      unorderedBag([
            {
              "number": "1",
              "has_estimate": true,
            },
            {
              "number": "2",
              "has_estimate": true,
            },
            {
              "number": "3",
              "has_estimate": true,
            },
            {
              "number": "4",
              "has_estimate": false,
            },
            {
              "number": "5",
              "has_estimate": false,
            },
            {
              "number": "6",
              "has_estimate": false,
            },
          ])
    );
  });

  it("test_edgeql_coalesce_scalar_08", () => {
    assertQueryResult(
      h,
      `
                SELECT (Issue.number, Issue.time_estimate ?= 60)
                ORDER BY Issue.number;
            `,
      [
            ["1", true],
            ["2", false],
            ["3", false],
            ["4", false],
            ["5", false],
            ["6", false],
          ]
    );
  });

  it("test_edgeql_coalesce_scalar_09", () => {
    assertQueryResult(
      h,
      `
                # Only values present in the graph will be selected.
                SELECT Issue.time_estimate ?= 60;
            `,
      unorderedBag([false, false, true])
    );
    assertQueryResult(
      h,
      `
                SELECT Issue.time_estimate ?= <int64>{};
            `,
      unorderedBag([false, false, false])
    );
  });

  it("test_edgeql_coalesce_scalar_10", () => {
    assertQueryResult(
      h,
      `
                # No open issue has a time_estimate, so the first argument
                # to ?= is an empty set.
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?= <int64>{};
            `,
      [true]
    );
  });

  it("test_edgeql_coalesce_scalar_11", () => {
    assertQueryResult(
      h,
      `
                # No open issue has a time_estimate, so the first argument
                # to ?!= is an empty set.
                WITH
                    I := (SELECT Issue
                          FILTER Issue.status.name = 'Open')
                SELECT I.time_estimate ?!= <int64>{};
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (SELECT Issue
                          FILTER Issue.status.name = 'Open')
                SELECT I.time_estimate ?!= 60;
            `,
      [true]
    );
  });

  it("test_edgeql_coalesce_scalar_12", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    number,
                    time_estimate,
                    related_to: {time_estimate},
                }
                ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "related_to": [],
              "time_estimate": 60,
            },
            {
              "number": "2",
              "related_to": [],
              "time_estimate": 90,
            },
            {
              "number": "3",
              "related_to": [],
              "time_estimate": 90,
            },
            {
              "number": "4",
              "related_to": [],
              "time_estimate": null,
            },
            {
              "number": "5",
              "related_to": [
                {
                  "time_estimate": 60,
                },
              ],
              "time_estimate": null,
            },
            {
              "number": "6",
              "related_to": [
                {
                  "time_estimate": 90,
                },
              ],
              "time_estimate": null,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                # now test a combination of several coalescing operators
                SELECT
                    Issue.time_estimate ??
                    Issue.related_to.time_estimate ?=
                        <int64>Issue.number * 12
                ORDER BY Issue.number;
            `,
      [false, false, false, false, true, false]
    );
  });

  it("test_edgeql_coalesce_set_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    comp_time_estimate := Issue.time_estimate ?? {-1, -2}
                };
            `,
      unorderedBag([
            {
              "comp_time_estimate": [-1, -2],
            },
            {
              "comp_time_estimate": [-1, -2],
            },
            {
              "comp_time_estimate": [-1, -2],
            },
            {
              "comp_time_estimate": [60],
            },
            {
              "comp_time_estimate": [90],
            },
            {
              "comp_time_estimate": [90],
            },
          ])
    );
  });

  it("test_edgeql_coalesce_set_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    multi te := (
                        SELECT Issue.time_estimate ?? {-1, -2}
                    )
                };
            `,
      unorderedBag([
            {
              "te": [-1, -2],
            },
            {
              "te": [-1, -2],
            },
            {
              "te": [-1, -2],
            },
            {
              "te": [60],
            },
            {
              "te": [90],
            },
            {
              "te": [90],
            },
          ])
    );
  });

  it("test_edgeql_coalesce_set_03", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := (Issue.number, Issue.time_estimate ?? {-1, -2})
                ORDER BY _;
            `,
      [
            ["1", 60],
            ["2", 90],
            ["3", 90],
            ["4", -2],
            ["4", -1],
            ["5", -2],
            ["5", -1],
            ["6", -2],
            ["6", -1],
          ]
    );
  });

  it("test_edgeql_coalesce_set_04", () => {
    assertQueryResult(
      h,
      `
                # Only values present in the graph will be selected.
                # There is at least one value there.
                # Therefore, the second argument to ?? will not be returned.
                SELECT Issue.time_estimate ?? {-1, -2};
            `,
      unorderedBag([60, 90, 90])
    );
  });

  it("test_edgeql_coalesce_set_05", () => {
    assertQueryResult(
      h,
      `
                # No open issue has a time_estimate, so the first argument
                # to ?? is an empty set.
                # Therefore, the second argument to ?? will be returned.
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?? {-1, -2};
            `,
      unorderedSet([-1, -2])
    );
  });

  it("test_edgeql_coalesce_set_06", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I := (SELECT Issue
                          FILTER Issue.status.name = 'Open')
                # No open issue has a time_estimate, so the first argument
                # to ?? is an empty set.
                # Therefore, the second argument to ?? will be returned.
                SELECT I.time_estimate ?? {-1, -2};
            `,
      unorderedSet([-1, -2])
    );
  });

  it("test_edgeql_coalesce_set_07", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    number,
                    te := Issue.time_estimate ?= {60, 30}
                };
            `,
      unorderedBag([
            {
              "number": "1",
              "te": unorderedSet([false, true]),
            },
            {
              "number": "2",
              "te": [false, false],
            },
            {
              "number": "3",
              "te": [false, false],
            },
            {
              "number": "4",
              "te": [false, false],
            },
            {
              "number": "5",
              "te": [false, false],
            },
            {
              "number": "6",
              "te": [false, false],
            },
          ])
    );
  });

  it("test_edgeql_coalesce_set_08", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := (Issue.number, Issue.time_estimate ?= {60, 90})
                ORDER BY _;
            `,
      [
            ["1", false],
            ["1", true],
            ["2", false],
            ["2", true],
            ["3", false],
            ["3", true],
            ["4", false],
            ["4", false],
            ["5", false],
            ["5", false],
            ["6", false],
            ["6", false],
          ]
    );
  });

  it("test_edgeql_coalesce_set_09", () => {
    assertQueryResult(
      h,
      `
                # Only values present in the graph will be selected.
                SELECT Issue.time_estimate ?= {60, 30};
            `,
      unorderedBag([false, false, false, false, false, true])
    );
  });

  it("test_edgeql_coalesce_set_10", () => {
    assertQueryResult(
      h,
      `
                # No open issue has a time_estimate, so the first argument
                # to ?!= is an empty set.
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?!= {-1, -2};
            `,
      [true, true]
    );
  });

  it("test_edgeql_coalesce_set_11", () => {
    assertQueryResult(
      h,
      `
                # No open issue has a time_estimate, so the first argument
                # to ?= is an empty set.
                WITH
                    I := (SELECT Issue
                          FILTER Issue.status.name = 'Open')
                SELECT I.time_estimate ?= {-1, -2};
            `,
      [false, false]
    );
  });

  it("test_edgeql_coalesce_dependent_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    # for every issue, there's a unique derived "default"
                    # to use  with ??
                    time_estimate :=
                        Issue.time_estimate ?? -<int64>Issue.number
                } ORDER BY Issue.time_estimate;
            `,
      [
            {
              "time_estimate": -6,
            },
            {
              "time_estimate": -5,
            },
            {
              "time_estimate": -4,
            },
            {
              "time_estimate": 60,
            },
            {
              "time_estimate": 90,
            },
            {
              "time_estimate": 90,
            },
          ]
    );
  });

  it("test_edgeql_coalesce_dependent_02", () => {
    assertQueryResult(
      h,
      `
                # for every issue, there's a unique derived "default" to use
                # with ??
                SELECT (Issue.number,
                        Issue.time_estimate ?? -<int64>Issue.number)
                ORDER BY Issue.number;
            `,
      [
            ["1", 60],
            ["2", 90],
            ["3", 90],
            ["4", -4],
            ["5", -5],
            ["6", -6],
          ]
    );
  });

  it("test_edgeql_coalesce_dependent_03", () => {
    assertQueryResult(
      h,
      `
                # ?? is OPTIONAL w.r.t. first argument, so it behaves like
                # an element-wise function. Therefore, the longest common
                # prefix \`Issue\` is factored out and the expression is
                # evaluated for every Issue.
                SELECT Issue.time_estimate ?? -<int64>Issue.number;
            `,
      unorderedBag([-6, -5, -4, 60, 90, 90])
    );
  });

  it("test_edgeql_coalesce_dependent_04", () => {
    assertQueryResult(
      h,
      `
                # Since ?? is OPTIONAL over it's first argument,
                # the expression is evaluated for all six issues.
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?? -<int64>Issue.number;
            `,
      unorderedBag([-6, -5, -4, -3, -2, -1])
    );
  });

  it("test_edgeql_coalesce_dependent_05", () => {
    assertQueryResult(
      h,
      `
                # Unlike the above test, we refer to the
                # same "open" subset of issues on both
                # sides of ??, so the result set contains
                # only three elements.
                WITH
                    I := (SELECT Issue
                          FILTER Issue.status.name = 'Open')
                SELECT I.time_estimate ?? -<int64>I.number;
            `,
      unorderedBag([-6, -5, -4])
    );
  });

  it("test_edgeql_coalesce_dependent_06", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I2 := Issue
                # ?? is OPTIONAL w.r.t. first argument, so it behaves like
                # an element-wise function. However, since there is no
                # common prefix, the expression gets evaluated ONLY for
                # existing values of \`Issue.time_estimate\`.
                SELECT Issue.time_estimate ?? -<int64>I2.number;
            `,
      unorderedBag([60, 90, 90])
    );
  });

  it("test_edgeql_coalesce_dependent_07", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?? -<int64>Issue.number;
            `,
      unorderedBag([-6, -5, -4, -3, -2, -1])
    );
  });

  it("test_edgeql_coalesce_dependent_08", () => {
    assertQueryResult(
      h,
      `
                # On one hand the right operand of ?? is not independent
                # of the left. On the other hand, it is constructed in
                # such a way as to be equivalent to literal \`-1\` for the
                # case when its value is important.
                #
                # LCP is \`Issue.time_estimate\`, so this should not
                # actually be evaluated for every \`Issue\`, but for every
                # \`Issue.time_estimate\`.
                SELECT Issue.time_estimate ?? {Issue.time_estimate, -1};
            `,
      unorderedBag([60, 90, 90])
    );
  });

  it("test_edgeql_coalesce_dependent_09", () => {
    assertQueryResult(
      h,
      `
                # \`Issue\` on both sides is behind a fence, so the left-hand
                # expression is an empty set, and the result is a union
                # of all existing time estimates and -1.
                SELECT _ := (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?? {Issue.time_estimate, -1}
                ORDER BY _;
            `,
      [-1, 60, 90, 90]
    );
  });

  it("test_edgeql_coalesce_dependent_10", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                # \`I.time_estimate\` is now a LCP
                SELECT I.time_estimate ?? {I.time_estimate, -1};
            `,
      [-1]
    );
  });

  it("test_edgeql_coalesce_dependent_11", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    number,
                    foo := Issue.time_estimate ?= <int64>Issue.number * 30
                } ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "foo": false,
            },
            {
              "number": "2",
              "foo": false,
            },
            {
              "number": "3",
              "foo": true,
            },
            {
              "number": "4",
              "foo": false,
            },
            {
              "number": "5",
              "foo": false,
            },
            {
              "number": "6",
              "foo": false,
            },
          ]
    );
  });

  it("test_edgeql_coalesce_dependent_12", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    Issue.number,
                    Issue.time_estimate ?!= <int64>Issue.number * 30
                )
                ORDER BY Issue.number;
            `,
      [
            ["1", true],
            ["2", true],
            ["3", false],
            ["4", true],
            ["5", true],
            ["6", true],
          ]
    );
  });

  it("test_edgeql_coalesce_dependent_13", () => {
    assertQueryResult(
      h,
      `
                # ?= is OPTIONAL w.r.t. both arguments, so it behaves like
                # an element-wise function. Therefore, the longest common
                # prefix \`Issue\` is factored out and the expression is
                # evaluated for every Issue.
                SELECT Issue.time_estimate ?= <int64>Issue.number * 30;
            `,
      unorderedBag([false, false, false, false, false, true])
    );
  });

  it("test_edgeql_coalesce_dependent_14", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?= <int64>Issue.number;
            `,
      unorderedBag([false, false, false, false, false, false])
    );
  });

  it("test_edgeql_coalesce_dependent_15", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I := (SELECT Issue
                          FILTER Issue.status.name = 'Open')
                # Same as dependent_13, but only 'Open' issues
                # being considered.
                SELECT I.time_estimate ?!= I.time_spent_log.spent_time;
            `,
      unorderedBag([false, false, false])
    );
  });

  it("test_edgeql_coalesce_dependent_16", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I2 := Issue
                # ?= is OPTIONAL w.r.t. both arguments, so it behaves like
                # an element-wise function. However, since there is no
                # common prefix, the expression gets evaluated ONLY for
                # existing values of \`Issue.time_estimate\`, so the cardinality
                # of the result set is 18 (3 * 6).
                SELECT Issue.time_estimate ?= <int64>I2.number * 30;
            `,
      unorderedBag([
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            true,
            true,
            true,
          ])
    );
  });

  it("test_edgeql_coalesce_dependent_17", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I2 := Issue
                # ?!= is OPTIONAL w.r.t. both arguments, so it behaves like
                # an element-wise function. However, since there is no
                # common prefix, the expression gets evaluated ONLY for
                # existing values of \`Issue.time_estimate\`, where
                # \`Issue.status\` is 'Open', which happens to be an empty set,
                # but ?!= is OPTIONAL, so the cardinality of the result set is
                # 1 * |I.number| == 6.
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?!= <int64>I2.number * 30;
            `,
      unorderedBag([true, true, true, true, true, true])
    );
  });

  it("test_edgeql_coalesce_dependent_18", () => {
    assertQueryResult(
      h,
      `
                # LCP is \`Issue.time_estimate\`, so this should not
                # actually be evaluated for every \`Issue\`, but for every
                # \`Issue.time_estimate\`.
                SELECT Issue.time_estimate ?= Issue.time_estimate * 2;
            `,
      unorderedBag([false, false, false])
    );
  });

  it("test_edgeql_coalesce_dependent_19", () => {
    assertQueryResult(
      h,
      `
                # \`Issue\` is now a LCP and the overall expression will be
                # evaluated for every \`Issue\`.
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_estimate ?= Issue.time_estimate * 2;
            `,
      unorderedBag([false, false, false, true, true, true])
    );
  });

  it("test_edgeql_coalesce_dependent_20", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                # \`I.time_estimate\` is now a LCP
                SELECT I.time_estimate ?= I.time_estimate * 2;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                # \`I.time_estimate\` is now a LCP
                SELECT I.time_estimate ?= (I.time_estimate,).0;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                # \`I.time_estimate\` is now a LCP
                SELECT (I.time_estimate,).0 ?= (I.time_estimate,).0;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                # \`I.time_estimate\` is now a LCP
                SELECT ((I.time_estimate,).0,).0 ?= (I.time_estimate,).0;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                # \`I.time_estimate\` is now a LCP
                SELECT
                  ({I.time_estimate} = 0) ?=
                  (({I.time_estimate} = 0) = (I.time_estimate = 0));
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                # \`I.time_estimate\` is now a LCP
                SELECT {I.time_estimate} ?= (I.time_estimate,).0;
            `,
      [true]
    );
  });

  it("test_edgeql_coalesce_dependent_21", () => {
    assertQueryResult(
      h,
      `
                WITH
                    X := {Priority, Status}
                SELECT X[IS Priority].name ?? X[IS Status].name;
            `,
      unorderedSet(["Closed", "High", "Low", "Open"])
    );
  });

  it("test_edgeql_coalesce_dependent_22", () => {
    assertQueryResult(
      h,
      `
                WITH
                    X := {Priority, Status}
                SELECT X[IS Priority].name[0] ?? X[IS Status].name;
            `,
      unorderedSet(["Closed", "H", "L", "Open"])
    );
    assertQueryResult(
      h,
      `
                WITH
                    X := {Priority, Status}
                SELECT X[IS Priority].name ?? X[IS Status].name[0];
            `,
      unorderedSet(["C", "High", "Low", "O"])
    );
    assertQueryResult(
      h,
      `
                WITH
                    X := {Priority, Status}
                SELECT X[IS Priority].name[0] ?? X[IS Status].name[0];
            `,
      unorderedSet(["C", "H", "L", "O"])
    );
  });

  it("test_edgeql_coalesce_dependent_23", () => {
    assertQueryResult(
      h,
      `
                WITH
                    X := {Priority, Status}
                SELECT X {
                    foo := X[IS Priority].name ?? X[IS Status].name
                };
            `,
      unorderedBag([
            {
              "foo": "Closed",
            },
            {
              "foo": "High",
            },
            {
              "foo": "Low",
            },
            {
              "foo": "Open",
            },
          ])
    );
    assertQueryResult(
      h,
      `
                WITH
                    X := {Priority, Status}
                SELECT X {
                    foo := X[IS Priority].name[0] ?? X[IS Status].name
                };
            `,
      unorderedBag([
            {
              "foo": "Closed",
            },
            {
              "foo": "H",
            },
            {
              "foo": "L",
            },
            {
              "foo": "Open",
            },
          ])
    );
    assertQueryResult(
      h,
      `
                WITH
                    X := {Priority, Status}
                SELECT X {
                    foo := X[IS Priority].name ?? X[IS Status].name[0]
                };
            `,
      unorderedBag([
            {
              "foo": "C",
            },
            {
              "foo": "High",
            },
            {
              "foo": "Low",
            },
            {
              "foo": "O",
            },
          ])
    );
    assertQueryResult(
      h,
      `
                WITH
                    X := {Priority, Status}
                SELECT X {
                    foo := X[IS Priority].name[0] ?? X[IS Status].name[0]
                };
            `,
      unorderedBag([
            {
              "foo": "C",
            },
            {
              "foo": "H",
            },
            {
              "foo": "L",
            },
            {
              "foo": "O",
            },
          ])
    );
  });

  it("test_edgeql_coalesce_object_01", () => {
    assertQueryResult(
      h,
      `
                WITH
                    DUMMY := (SELECT LogEntry FILTER LogEntry.body = 'Dummy')
                SELECT Issue {
                    number,
                    time_spent_log := (
                        SELECT x := (Issue.time_spent_log ?? DUMMY) {
                            id,
                            spent_time
                        }
                        ORDER BY x.spent_time
                    )
                } ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "time_spent_log": [
                {
                  "spent_time": 60,
                },
              ],
            },
            {
              "number": "2",
              "time_spent_log": [
                {
                  "spent_time": 90,
                },
              ],
            },
            {
              "number": "3",
              "time_spent_log": [
                {
                  "spent_time": 30,
                },
                {
                  "spent_time": 60,
                },
              ],
            },
            {
              "number": "4",
              "time_spent_log": [
                {
                  "spent_time": -1,
                },
              ],
            },
            {
              "number": "5",
              "time_spent_log": [
                {
                  "spent_time": -1,
                },
              ],
            },
            {
              "number": "6",
              "time_spent_log": [
                {
                  "spent_time": -1,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_coalesce_object_02", () => {
    assertQueryResult(
      h,
      `
                WITH
                    DUMMY := (SELECT LogEntry FILTER LogEntry.body = 'Dummy')
                SELECT x := (
                    Issue.number,
                    (Issue.time_spent_log ?? DUMMY).spent_time
                ) ORDER BY x.0 THEN x.1;
            `,
      [
            ["1", 60],
            ["2", 90],
            ["3", 30],
            ["3", 60],
            ["4", -1],
            ["5", -1],
            ["6", -1],
          ]
    );
  });

  it("test_edgeql_coalesce_object_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    DUMMY := (SELECT LogEntry FILTER LogEntry.body = 'Dummy')
                SELECT x := (Issue.time_spent_log ?? DUMMY) {
                    spent_time
                }
                ORDER BY x.spent_time;
            `,
      unorderedBag([
            {
              "spent_time": 30,
            },
            {
              "spent_time": 60,
            },
            {
              "spent_time": 60,
            },
            {
              "spent_time": 90,
            },
          ])
    );
  });

  it("test_edgeql_coalesce_object_04", () => {
    assertQueryResult(
      h,
      `
                WITH
                    DUMMY := (SELECT LogEntry FILTER LogEntry.body = 'Dummy')
                SELECT (
                    (SELECT Issue
                     FILTER Issue.status.name = 'Open').time_spent_log
                    ??
                    DUMMY
                ) {
                    id,
                    spent_time
                };
            `,
      [
            {
              "spent_time": -1,
            },
          ]
    );
  });

  it("test_edgeql_coalesce_object_05", () => {
    assertQueryResult(
      h,
      `
                WITH
                    DUMMY := (SELECT LogEntry FILTER LogEntry.body = 'Dummy'),
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                SELECT (I.time_spent_log ?? DUMMY) {
                    id,
                    spent_time
                };
            `,
      [
            {
              "spent_time": -1,
            },
          ]
    );
  });

  it("test_edgeql_coalesce_object_06", () => {
    assertQueryResult(
      h,
      `
                WITH
                    LOG1 := (SELECT LogEntry FILTER LogEntry.body = 'Log1')
                SELECT Issue {
                    number,
                    log1 := Issue.time_spent_log ?= LOG1
                } ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "log1": [true],
            },
            {
              "number": "2",
              "log1": [false],
            },
            {
              "number": "3",
              "log1": [false, false],
            },
            {
              "number": "4",
              "log1": [false],
            },
            {
              "number": "5",
              "log1": [false],
            },
            {
              "number": "6",
              "log1": [false],
            },
          ]
    );
  });

  it("test_edgeql_coalesce_object_07", () => {
    assertQueryResult(
      h,
      `
                WITH
                    LOG1 := (SELECT LogEntry FILTER LogEntry.body = 'Log1')
                SELECT (
                    Issue.number, Issue.time_spent_log ?= LOG1
                ) ORDER BY Issue.number;
            `,
      [
            ["1", true],
            ["2", false],
            ["3", false],
            ["3", false],
            ["4", false],
            ["5", false],
            ["6", false],
          ]
    );
  });

  it("test_edgeql_coalesce_object_08", () => {
    assertQueryResult(
      h,
      `
                WITH
                    LOG1 := (SELECT LogEntry FILTER LogEntry.body = 'Log1')
                SELECT Issue.time_spent_log ?!= LOG1;
            `,
      unorderedBag([false, true, true, true])
    );
  });

  it("test_edgeql_coalesce_object_09", () => {
    assertQueryResult(
      h,
      `
                WITH
                    DUMMY := (SELECT LogEntry FILTER LogEntry.body = 'Dummy')
                SELECT (
                    SELECT Issue
                    FILTER Issue.status.name = 'Open'
                ).time_spent_log ?= DUMMY;
            `,
      [false]
    );
  });

  it("test_edgeql_coalesce_object_10", () => {
    assertQueryResult(
      h,
      `
                WITH
                    DUMMY := (SELECT LogEntry FILTER LogEntry.body = 'Dummy'),
                    I := (
                        SELECT Issue
                        FILTER Issue.status.name = 'Open'
                    )
                SELECT I.time_spent_log ?!= DUMMY;
            `,
      [true]
    );
  });

  it("test_edgeql_coalesce_object_11", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    (
                        (SELECT Issue FILTER .number = '1')
                        ??
                        (SELECT Issue FILTER .number = '2')
                    ) {
                        number
                    }
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_coalesce_object_12", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    (
                        (SELECT Issue FILTER .number = '100')
                        ??
                        (SELECT Issue FILTER .number = '2')
                    ) {
                        number
                    }
            `,
      [
            {
              "number": "2",
            },
          ]
    );
  });

  it("test_edgeql_coalesce_wrapping_optional", () => {
    h.script(
      `
                CREATE FUNCTION optfunc(
                        a: std::str, b: OPTIONAL std::str) -> OPTIONAL std::str
                    USING EdgeQL $$
                        SELECT b IF a = 'foo' ELSE a
                    $$;
            `
    );
    assertQueryResult(
      h,
      `
                SELECT optfunc('foo', <str>{}) ?? 'N/A';
            `,
      ["N/A"]
    );
    assertQueryResult(
      h,
      `
                SELECT optfunc('foo', 'b') ?? 'N/A';
            `,
      ["b"]
    );
    assertQueryResult(
      h,
      `
                SELECT optfunc('a', <str>{}) ?? 'N/A';
            `,
      ["a"]
    );
  });

  it("test_edgeql_coalesce_set_of_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>Publication.id ?? <str>count(Publication)
            `,
      ["0"]
    );
  });

  it("test_edgeql_coalesce_set_of_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Publication.title ?? <str>count(Publication)
            `,
      ["0"]
    );
  });

  it("test_edgeql_coalesce_set_of_03", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>Publication.id ?= <str>count(Publication)
            `,
      [false]
    );
  });

  it("test_edgeql_coalesce_set_of_04", () => {
    assertQueryResult(
      h,
      `
                SELECT Publication.title ?= <str>count(Publication)
            `,
      [false]
    );
  });

  it("test_edgeql_coalesce_set_of_05", () => {
    assertQueryResult(
      h,
      `
                SELECT (Publication.title ?? <str>count(Publication))
                       ?? Publication.title
            `,
      ["0"]
    );
  });

  it("test_edgeql_coalesce_set_of_06", () => {
    assertQueryResult(
      h,
      `
                SELECT (Publication.title ?= <str>count(Publication),
                        Publication)
            `,
      []
    );
  });

  it("test_edgeql_coalesce_set_of_07", () => {
    assertQueryResult(
      h,
      `
                SELECT (Publication.title ?= '0',
                        (Publication.title ?? <str>count(Publication)));
            `,
      [
            [false, "0"],
          ]
    );
  });

  it("test_edgeql_coalesce_set_of_08", () => {
    assertQueryResult(
      h,
      `
                SELECT ("1" if Publication.title ?= "foo" else "2") ++
                       (Publication.title ?? <str>count(Publication))
            `,
      ["20"]
    );
  });

  it("test_edgeql_coalesce_set_of_09", () => {
    assertQueryResult(
      h,
      `
                SELECT (Publication.title ?= "Foo", Publication.title ?= "bar")
            `,
      [
            [false, false],
          ]
    );
  });

  it("test_edgeql_coalesce_set_of_10", () => {
    assertQueryResult(
      h,
      `
                SELECT (Publication.title++Publication.title ?= "Foo",
                        Publication.title ?= "bar")
            `,
      [
            [false, false],
          ]
    );
  });

  it("test_edgeql_coalesce_set_of_11", () => {
    assertQueryResult(
      h,
      `
                SELECT (Publication.title ?= "", count(Publication))
            `,
      [
            [false, 0],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (count(Publication), Publication.title ?= "")
            `,
      [
            [false, 0],
          ]
    );
  });

  it("test_edgeql_coalesce_set_of_12", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    Publication ?= Publication,
                    (Publication.title++Publication.title
                       ?= Publication.title) ?=
                    (Publication ?!= Publication)
                )
            `,
      [
            [true, false],
          ]
    );
  });

  it("test_edgeql_coalesce_set_of_13", () => {
    assertQueryResult(
      h,
      `
                SELECT (Publication ?= Publication, Publication)
            `,
      []
    );
  });

  it("test_edgeql_coalesce_set_of_nonempty_01", () => {
    h.script(
      `INSERT Publication { title := "1" }`
    );
    h.script(
      `INSERT Publication { title := "asdf" }`
    );
    assertQueryResult(
      h,
      `
                SELECT Publication.title ?= <str>count(Publication)
            `,
      [true, false]
    );
  });

  it("test_edgeql_coalesce_self_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Publication ?? Publication
            `,
      []
    );
  });

  it("test_edgeql_coalesce_self_02", () => {
    assertQueryResult(
      h,
      `
                WITH Z := (SELECT Comment FILTER .owner.name = "Yury")
                SELECT (Z.parent ?? Z);
            `,
      []
    );
  });

  it("test_edgeql_coalesce_pointless_01", () => {
    assertQueryResult(
      h,
      `
                SELECT 'a' ?? (SELECT {'a', 'b'})
            `,
      ["a"]
    );
  });

  it("test_edgeql_coalesce_correlation_01", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := (
                    SELECT (Issue.name ++ <str>Issue.time_estimate)) ?? 'n/a'
                ORDER BY _;
            `,
      ["Issue 160", "Issue 290", "Issue 390"]
    );
  });

  it("test_edgeql_coalesce_correlation_02", () => {
    assertQueryResult(
      h,
      `
                WITH X := (SELECT (Issue.name ++ <str>Issue.time_estimate)),
                SELECT _ := X ?? 'n/a'
                ORDER BY _;
            `,
      ["Issue 160", "Issue 290", "Issue 390"]
    );
  });

  it("test_edgeql_coalesce_correlation_03", () => {
    h.script(
      `
            CREATE FUNCTION opts(x: OPTIONAL str) -> OPTIONAL str {
                USING (x) };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT _ := (
                    count(Issue),
                    opts((SELECT (<str>Issue.time_estimate))),
                ) ORDER BY _;
            `,
      [
            [6, "60"],
            [6, "90"],
            [6, "90"],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_01", () => {
    assertQueryResult(
      h,
      `
                SELECT (SELECT ('no', 'no') FILTER false) ?? ('a', 'b');
            `,
      [
            ["a", "b"],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_02", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := (Issue.name, (Issue.name, <str>Issue.time_estimate)
                             ?? ('hm', 'n/a')) ORDER BY _;
            `,
      [
            [
              "Issue 1",
              ["Issue 1", "60"],
            ],
            [
              "Issue 2",
              ["Issue 2", "90"],
            ],
            [
              "Issue 3",
              ["Issue 3", "90"],
            ],
            [
              "Issue 4",
              ["hm", "n/a"],
            ],
            [
              "Issue 5",
              ["hm", "n/a"],
            ],
            [
              "Issue 6",
              ["hm", "n/a"],
            ],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_03", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := (Issue.name, (Issue.name, Issue.time_estimate)
                             ?? (Issue.name, -1)) ORDER BY _;
            `,
      [
            [
              "Issue 1",
              ["Issue 1", 60],
            ],
            [
              "Issue 2",
              ["Issue 2", 90],
            ],
            [
              "Issue 3",
              ["Issue 3", 90],
            ],
            [
              "Issue 4",
              ["Issue 4", -1],
            ],
            [
              "Issue 5",
              ["Issue 5", -1],
            ],
            [
              "Issue 6",
              ["Issue 6", -1],
            ],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_04", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := (Issue.name, Issue.time_estimate)
                             ?? (Issue.name, -1) ORDER BY _;
            `,
      [
            ["Issue 1", 60],
            ["Issue 2", 90],
            ["Issue 3", 90],
            ["Issue 4", -1],
            ["Issue 5", -1],
            ["Issue 6", -1],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_05", () => {
    assertQueryResult(
      h,
      `
                WITH X := (Issue.name, Issue.time_estimate),
                SELECT _ := X ?? ('hm', -1) ORDER BY _;
            `,
      [
            ["Issue 1", 60],
            ["Issue 2", 90],
            ["Issue 3", 90],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_06", () => {
    assertQueryResult(
      h,
      `
                SELECT (SELECT ((), 'no') FILTER false) ?? ((), 'b');
            `,
      [
            [
              [],
              "b",
            ],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_07", () => {
    assertQueryResult(
      h,
      `
                SELECT (SELECT () FILTER false) ?? {(), ()};
            `,
      [
            [],
            [],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (SELECT () FILTER true) ?? {(), ()};
            `,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (SELECT ((), ()) FILTER true) ?? {((), ()), ((), ())}
            `,
      [
            [
              [],
              [],
            ],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_08", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY bar -> tuple<int64, int64>;
                CREATE PROPERTY baz -> tuple<tuple<int64, int64>, str>;
             };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo.bar ?? (1, 2)
            `,
      [
            [1, 2],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Foo.bar UNION (1, 2)
            `,
      [
            [1, 2],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (Foo.bar ?? (1, 2)).0
            `,
      [1]
    );
    assertQueryResult(
      h,
      `
                SELECT (Foo.bar UNION (1, 2)).0
            `,
      [1]
    );
    assertQueryResult(
      h,
      `
                SELECT (Foo.baz ?? ((1, 2), 'huh')).0.1
            `,
      [2]
    );
    h.script(
      `
            INSERT Foo { bar := (3, 4), baz := ((3, 4), 'test') }
        `
    );
    assertQueryResult(
      h,
      `
                SELECT ([Foo.bar], array_agg(Foo.bar));
            `,
      [
            [
              [
                [3, 4],
              ],
              [
                [3, 4],
              ],
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Foo.bar ?? (1, 2)
            `,
      [
            [3, 4],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT _ := Foo.bar UNION (1, 2) ORDER BY _;
            `,
      [
            [1, 2],
            [3, 4],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (Foo.bar ?? (1, 2)).1
            `,
      [4]
    );
    assertQueryResult(
      h,
      `
                SELECT _ := (Foo.bar UNION (1, 2)).0 ORDER BY _;
            `,
      [1, 3]
    );
    assertQueryResult(
      h,
      `
                SELECT (Foo.baz ?? ((1, 2), 'huh')).0.1
            `,
      [4]
    );
    assertQueryResult(
      h,
      `
                WITH W := (Foo.baz UNION ((1, 2), 'huh')),
                SELECT (W, W.1, W.0.0) ORDER BY W;
            `,
      [
            [
              [
                [1, 2],
                "huh",
              ],
              "huh",
              1,
            ],
            [
              [
                [3, 4],
                "test",
              ],
              "test",
              3,
            ],
          ]
    );
  });

  it("test_edgeql_coalesce_tuple_09", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := ([(1,2)][0] UNION (3,4)).1 ORDER BY _;
            `,
      [2, 4]
    );
  });

  it("test_edgeql_coalesce_overload_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue.name ++ opt_test(false, <str>Issue.time_estimate)
            `,
      unorderedSet(["Issue 160", "Issue 290", "Issue 390", "Issue 4", "Issue 5", "Issue 6"])
    );
    assertQueryResult(
      h,
      `
                SELECT (Issue.name, opt_test(false, Issue.time_estimate))
            `,
      unorderedSet([
            ["Issue 1", 60],
            ["Issue 2", 90],
            ["Issue 3", 90],
            ["Issue 4", -1],
            ["Issue 5", -1],
            ["Issue 6", -1],
          ])
    );
    assertQueryResult(
      h,
      `
                SELECT opt_test(true, <str>Issue.time_estimate)
            `,
      unorderedBag(["60", "90", "90"])
    );
    assertQueryResult(
      h,
      `
                SELECT opt_test(true, Issue.time_estimate)
            `,
      unorderedBag([60, 90, 90])
    );
    assertQueryResult(
      h,
      `
                select Issue { z := opt_test(true, .time_estimate) }
            `,
      unorderedBag([
            {
              "z": 60,
            },
            {
              "z": 90,
            },
            {
              "z": 90,
            },
            {
              "z": -1,
            },
            {
              "z": -1,
            },
            {
              "z": -1,
            },
          ])
    );
    assertQueryResult(
      h,
      `
                select Issue { z := opt_test(true, .time_estimate, 1) }
            `,
      unorderedBag([
            {
              "z": 1,
            },
            {
              "z": 1,
            },
            {
              "z": 1,
            },
            {
              "z": 1,
            },
            {
              "z": 1,
            },
            {
              "z": 1,
            },
          ])
    );
  });

  it("test_edgeql_coalesce_overload_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue.name ++ opt_test(0, <str>Issue.time_estimate)
            `,
      unorderedSet(["Issue 160", "Issue 290", "Issue 390"])
    );
    assertQueryResult(
      h,
      `
                SELECT (Issue.name, opt_test(0, Issue.time_estimate))
            `,
      unorderedSet([
            ["Issue 1", 60],
            ["Issue 2", 90],
            ["Issue 3", 90],
          ])
    );
    assertQueryResult(
      h,
      `
                SELECT opt_test(0, <str>Issue.time_estimate)
            `,
      unorderedBag(["60", "90", "90"])
    );
    assertQueryResult(
      h,
      `
                SELECT opt_test(0, Issue.time_estimate)
            `,
      unorderedBag([60, 90, 90])
    );
    assertQueryResult(
      h,
      `
                select Issue { z := opt_test(0, .time_estimate) }
            `,
      unorderedBag([
            {
              "z": 60,
            },
            {
              "z": 90,
            },
            {
              "z": 90,
            },
            {
              "z": null,
            },
            {
              "z": null,
            },
            {
              "z": null,
            },
          ])
    );
    assertQueryResult(
      h,
      `
                select Issue { z := opt_test(0, .time_estimate, 1) }
            `,
      unorderedBag([
            {
              "z": 1,
            },
            {
              "z": 1,
            },
            {
              "z": 1,
            },
            {
              "z": null,
            },
            {
              "z": null,
            },
            {
              "z": null,
            },
          ])
    );
  });

  it("test_edgeql_coalesce_single_links_01", () => {
    h.script(
      `
            CREATE TYPE default::Content;
            CREATE TYPE default::Noob {
                CREATE LINK primary: default::Content;
                CREATE LINK secondary: default::Content;
            };
            insert Noob {
              primary := (insert Content)
            };
            insert Noob {
              secondary := (insert Content)
            };
            `
    );
    assertQueryResult(
      h,
      `
            select Noob {
              coalesce := (.primary ?? .secondary),
            };
            `,
      [
            {
              "coalesce": {
                "id": "str",
              },
            },
            {
              "coalesce": {
                "id": "str",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select Noob {
              coalesce := (select (.primary ?? .secondary) limit 100),
            };
            `,
      [
            {
              "coalesce": {
                "id": "str",
              },
            },
            {
              "coalesce": {
                "id": "str",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select Noob {
              coalesce := {.primary ?? .secondary},
            };
            `,
      [
            {
              "coalesce": {
                "id": "str",
              },
            },
            {
              "coalesce": {
                "id": "str",
              },
            },
          ]
    );
  });

  it("test_edgeql_optional_leakage_01", () => {
    h.script(
      `
                insert Comment {
                    body := "a",
                    owner := assert_single(User),
                    issue := (select Issue limit 1),
                };
            `
    );
    assertQueryResult(
      h,
      `
            select (
              Comment,
              (select (
                <str>Comment.parent.id ?= '',
                Comment.body
              )),
            );
            `,
      [
            [
              {},
              [false, "a"],
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                select (
                  Comment.body,
                  (select (
                    <str>Comment.parent.id ?= '' or
                    Comment.id ?= <uuid>{}
                  )),
                ) filter .1;
            `,
      []
    );
  });

  it("test_edgeql_optional_ensure_source_01", () => {
    assertQueryResult(
      h,
      `
                with x := array_unpack(<array<Issue>>[])
                select (x.name ?= x.body);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                with user := array_unpack(<array<Object>>[])
                select
                    (<str>user.id ?? "") ++ <str>(exists user);
            `,
      ["false"]
    );
  });

  it("test_edgeql_optional_ensure_source_02", () => {
    h.script(
      `
            create function test(x: optional Issue) -> bool using (
                (x.name ?= x.body)
            )
        `
    );
    assertQueryResult(
      h,
      `
                select test(<Issue>{})
            `,
      [true]
    );
  });

  it("test_edgeql_optional_array_cast_01", () => {
    assertQueryResult(
      h,
      `
            select <array<str>>to_json('null') ?? [];
            `,
      [
            [],
          ]
    );
  });

  it("test_edgeql_optional_array_cast_02", () => {
    assertQueryResult(
      h,
      `
            select {<array<str>>to_json('null')} ?? [];
            `,
      [
            [],
          ]
    );
  });

  it("test_edgeql_coalesce_policy_link_01", () => {
    h.query(
      `
            with module schema
            select Type {
              range_element_type_id := [is Range].element_type.id
                  ?? [is MultiRange].element_type.id,
            };
        `
    );
  });
});
