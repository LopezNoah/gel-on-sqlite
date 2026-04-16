import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLFilter", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "issues",
      setup: "issues_filter_setup",
      dbFile: "./tests/.artifacts/filter.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_filter_two_scalar_conditions01", () => {
    assertQueryResult(
      h,
      `
                # Find Users who own at least one Issue with simultaneously
                # time_estimate > 9000 and due_date on 2020/01/15.
                SELECT User{name}
                FILTER
                    any((
                      for issue in User.<owner[IS Issue]
                      select issue.time_estimate > 9000
                      AND
                      issue.due_date = <datetime>'2020-01-15T00:00:00+00:00'
                    ))
                ORDER BY User.name;
            `,
      [
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_two_scalar_conditions02", () => {
    assertQueryResult(
      h,
      `
                # NOTE: semantically same as and01, but using OR
                # Find Users who own at least one Issue with simultaneously
                # time_estimate > 9000 and due_date on 2020/01/15.
                SELECT User{name}
                FILTER
                    EXISTS (
                        SELECT
                            I := User.<owner[IS Issue]
                        FILTER
                            NOT (
                                NOT (
                                    EXISTS I.time_estimate AND
                                    I.time_estimate > 9000
                                ) OR
                                NOT (
                                    EXISTS I.due_date
                                    AND I.due_date =
                                        <datetime>'2020-01-15T00:00:00+00:00'
                                )
                            )
                    )
                ORDER BY User.name;
            `,
      [
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_two_scalar_conditions03", () => {
    assertQueryResult(
      h,
      `
                # NOTE: same as above, but more human-like
                # Find Users who own at least one Issue with simultaneously
                # time_estimate > 9000 and due_date on 2020/01/15.
                SELECT User{name}
                FILTER
                    EXISTS (
                        SELECT
                            I := User.<owner[IS Issue]
                        FILTER
                            NOT (
                                NOT EXISTS I.time_estimate OR
                                NOT EXISTS I.due_date OR
                                I.time_estimate <= 9000 OR
                                I.due_date !=
                                    <datetime>'2020-01-15T00:00:00+00:00'
                            )
                    )
                ORDER BY User.name;
            `,
      [
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_not_exists01", () => {
    assertQueryResult(
      h,
      `
                # Find Users who do not have any Issues with time_estimate
                SELECT User{name}
                FILTER
                    NOT EXISTS User.<owner[IS Issue].time_estimate
                ORDER BY User.name;
            `,
      [
            {
              "name": "Victor",
            },
          ]
    );
  });

  it("test_edgeql_filter_not_exists02", () => {
    assertQueryResult(
      h,
      `
                # Find Users who have at least one Issue without time_estimates
                SELECT (
                    SELECT Issue
                    FILTER
                        NOT EXISTS Issue.time_estimate
                ).owner{name} ORDER BY .name;
            `,
      [
            {
              "name": "Elvis",
            },
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_not_exists03", () => {
    assertQueryResult(
      h,
      `
                # NOTE: same as above, but starting with User
                #
                # Find Users who have at least one Issue without time_estimates
                SELECT User{name}
                FILTER
                    EXISTS (
                        SELECT I := User.<owner[IS Issue]
                        FILTER NOT EXISTS I.time_estimate
                    )
                ORDER BY User.name;
            `,
      [
            {
              "name": "Elvis",
            },
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_not_exists04", () => {
    assertQueryResult(
      h,
      `
                # NOTE: same as above, but with separate roots and
                # explicit path joining
                #
                # Find Users who have at least one Issue without time_estimates
                WITH
                    U2 := User
                SELECT User{name}
                FILTER
                    EXISTS User.<owner[IS Issue]
                    AND
                    (FOR lol IN U2.<owner[IS Issue]
                    SELECT
                      NOT EXISTS lol.time_estimate
                      AND
                      User.<owner[IS Issue] = lol)
                ORDER BY User.name;
            `,
      [
            {
              "name": "Elvis",
            },
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_two_scalar_exists01", () => {
    assertQueryResult(
      h,
      `
                # NOTE: very similar to two_scalar_conditions, same
                #       expected results
                #
                # Find Users who own at least one Issue with simultaneously
                # having a time_estimate and a due_date.
                SELECT User{name}
                FILTER
                    EXISTS (
                        SELECT
                            I := User.<owner[IS Issue]
                        FILTER
                            EXISTS I.time_estimate AND EXISTS I.due_date
                    )
                ORDER BY User.name;
            `,
      [
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_two_scalar_exists02", () => {
    assertQueryResult(
      h,
      `
                # NOTE: same as above, but using OR
                #
                # Find Users who own at least one Issue with simultaneously
                # time_estimate > 9000 and due_date on 2020/01/15.
                SELECT User{name}
                FILTER
                    EXISTS (
                        SELECT
                            I := User.<owner[IS Issue]
                        FILTER
                            NOT (
                                NOT EXISTS I.time_estimate OR
                                NOT EXISTS I.due_date
                            )
                    )
                ORDER BY User.name;
            `,
      [
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_two_scalar_exists04", () => {
    assertQueryResult(
      h,
      `
                # NOTE: same as above, but using OR,
                #       explicit sub-query and explicit joining
                #
                # Find Users who own at least one Issue with simultaneously
                # time_estimate > 9000 and due_date on 2020/01/15.
                WITH
                    U2 := User
                SELECT User{name}
                FILTER
                    EXISTS (
                        SELECT
                            I := User.<owner[IS Issue]
                        FILTER
                            NOT (
                                NOT EXISTS I.time_estimate OR
                                NOT EXISTS (
                                    (SELECT U2.<owner[IS Issue]
                                     FILTER I = U2.<owner[IS Issue]).due_date
                                )
                            )
                    )
                ORDER BY User.name;
            `,
      [
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_filter_short_form01", () => {
    assertQueryResult(
      h,
      `
                SELECT Status{name}
                FILTER .name = 'Open';
            `,
      [
            {
              "name": "Open",
            },
          ]
    );
  });

  it("test_edgeql_filter_short_form02", () => {
    assertQueryResult(
      h,
      `
                # test that shape spec is not necessary to use short form
                # in the filter
                SELECT Status
                FILTER .name = 'Open';
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_filter_flow01", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue.number
                FILTER TRUE
                ORDER BY Issue.number;
            `,
      ["1", "2", "3", "4"]
    );
    assertQueryResult(
      h,
      `
                SELECT Issue.number
                # obviously irrelevant filter, simply equivalent to TRUE
                FILTER Status.name = 'Closed'
                ORDER BY Issue.number;
            `,
      ["1", "2", "3", "4"]
    );
  });

  it("test_edgeql_filter_flow02", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue.number
                FILTER FALSE
                ORDER BY Issue.number;
            `,
      []
    );
    assertQueryResult(
      h,
      `
                SELECT Issue.number
                # obviously irrelevant filter, simply equivalent to FALSE
                FILTER Status.name = 'XXX'
                ORDER BY Issue.number;
            `,
      []
    );
  });

  it("test_edgeql_filter_flow03", () => {
    assertQueryResult(
      h,
      `
                # base line for a cross product
                SELECT _ := Issue.number ++ Status.name
                ORDER BY _;
            `,
      [
            "1Closed",
            "1Open",
            "2Closed",
            "2Open",
            "3Closed",
            "3Open",
            "4Closed",
            "4Open",
          ]
    );
    assertQueryResult(
      h,
      `
                # interaction of filter and cross product
                SELECT _ := (
                        SELECT Issue
                        FILTER Issue.owner.name = 'Elvis'
                    ).number ++ Status.name
                ORDER BY _;
            `,
      ["1Closed", "1Open", "2Closed", "2Open"]
    );
    assertQueryResult(
      h,
      `
                SELECT _ := (
                        SELECT Issue
                        FILTER Issue.owner.name = 'Elvis'
                    ).number ++ Status.name
                FILTER
                    # this FILTER is legal, but irrelevant, the same way as
                    # SELECT
                    #    Issue.number + Status.name FILTER Status.name = 'Open'
                    Status.name = 'Open'
                ORDER BY _;
            `,
      ["1Closed", "1Open", "2Closed", "2Open"]
    );
  });

  it("test_edgeql_filter_empty01", () => {
    assertQueryResult(
      h,
      `
                # the FILTER clause is always empty, so it can never be true
                SELECT Issue{number}
                FILTER {};
            `,
      []
    );
  });

  it("test_edgeql_filter_empty02", () => {
    assertQueryResult(
      h,
      `
                # the FILTER clause evaluates to empty, so it can never be true
                SELECT Issue{number}
                FILTER Issue.number = <str>{};
            `,
      []
    );
    assertQueryResult(
      h,
      `
                SELECT Issue{number}
                FILTER Issue.priority = <Object>{};
            `,
      []
    );
    assertQueryResult(
      h,
      `
                SELECT Issue{number}
                FILTER Issue.priority.name = <str>{};
            `,
      []
    );
  });

  it("test_edgeql_filter_aggregate01", () => {
    assertQueryResult(
      h,
      `
                SELECT count(Issue);
            `,
      [4]
    );
  });

  it("test_edgeql_filter_aggregate04", () => {
    assertQueryResult(
      h,
      `
                SELECT count(Issue)
                # this filter is not related to the aggregate and is allowed
                #
                FILTER Status.name = 'Open';
            `,
      [4]
    );
    assertQueryResult(
      h,
      `
                SELECT count(Issue)
                # this filter is conceptually equivalent to the above
                FILTER TRUE;
            `,
      [4]
    );
  });

  it("test_edgeql_filter_aggregate05", () => {
    assertQueryResult(
      h,
      `
                WITH
                    I := (SELECT Issue FILTER Issue.status.name = 'Open')
                SELECT count(I);
            `,
      [3]
    );
  });

  it("test_edgeql_filter_aggregate06", () => {
    assertQueryResult(
      h,
      `
                # regardless of what count evaluates to, FILTER clause is
                # impossible to fulfill, so the result is empty
                SELECT count(Issue)
                FILTER FALSE;
            `,
      []
    );
    assertQueryResult(
      h,
      `
                SELECT count(Issue)
                FILTER {};
            `,
      []
    );
  });
});
