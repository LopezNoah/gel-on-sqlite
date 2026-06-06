import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  queryRows,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLFunctions", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "issues",
      setup: "issues_setup"
    });
  });

  it("test_edgeql_functions_count_01", () => {
    assertQueryResult(
      h,
      `
                WITH
                    x := (
                        # User is simply employed as an object to be augmented
                        SELECT User {
                            count := 4,
                            all_issues := Issue
                        } FILTER .name = 'Elvis'
                    )
                SELECT x.count = count(x.all_issues);
            `,
      [true]
    );
  });

  it("test_edgeql_functions_count_02", () => {
    assertQueryResult(
      h,
      `
                WITH
                    x := (
                        # User is simply employed as an object to be augmented
                        SELECT User {
                            count := count(Issue),
                            all_issues := Issue
                        } FILTER .name = 'Elvis'
                    )
                SELECT x.count = count(x.all_issues);
            `,
      [true]
    );
  });

  it("test_edgeql_functions_count_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    x := (
                        # User is simply employed as an object to be augmented
                        SELECT User {
                            count := count(<int64>Issue.number),
                            all_issues := <int64>Issue.number
                        } FILTER .name = 'Elvis'
                    )
                SELECT x.count = count(x.all_issues);
            `,
      [true]
    );
  });

  it("test_edgeql_functions_array_agg_01", () => {
    assertQueryResult(
      h,
      `SELECT array_agg({1, 2, 3});`,
      [
            [1, 2, 3],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_agg({3, 2, 3});`,
      [
            [3, 2, 3],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_agg({3, 3, 2});`,
      [
            [3, 3, 2],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_02", () => {
    assertQueryResult(
      h,
      `SELECT array_agg({1, 2, 3})[0];`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT array_agg({3, 2, 3})[1];`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT array_agg({3, 3, 2})[-1];`,
      [2]
    );
  });

  it("test_edgeql_functions_array_agg_03", () => {
    assertQueryResult(
      h,
      `
                WITH x := {3, 1, 2}
                SELECT array_agg(x ORDER BY x);
            `,
      [
            [1, 2, 3],
          ]
    );
    assertQueryResult(
      h,
      `
                WITH x := {3, 1, 2}
                SELECT array_agg(x ORDER BY x) = [1, 2, 3];
            `,
      [true]
    );
  });

  it("test_edgeql_functions_array_agg_04", () => {
    assertQueryResult(
      h,
      `
                WITH x := {3, 1, 2}
                SELECT contains(array_agg(x ORDER BY x), 2);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH x := {3, 1, 2}
                SELECT contains(array_agg(x ORDER BY x), 5);
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
                WITH x := {3, 1, 2}
                SELECT contains(array_agg(x ORDER BY x), 5);
            `,
      [false]
    );
  });

  it("test_edgeql_functions_array_agg_05", () => {
    expect(() => {
      h.script(
        `
                SELECT array_agg({});
            `
      );
    }).toThrow(new RegExp("expression returns value of indeterminate type"));
  });

  it("test_edgeql_functions_array_agg_06", () => {
    assertQueryResult(
      h,
      `SELECT array_agg(<int64>{});`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_agg(DISTINCT <int64>{});`,
      [
            [],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_07", () => {
    assertQueryResult(
      h,
      `
                SELECT array_agg((SELECT schema::ObjectType FILTER False));
            `,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT array_agg(
                    (SELECT schema::ObjectType
                     FILTER <str>schema::ObjectType.id = '~')
                );
            `,
      [
            [],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_08", () => {
    assertQueryResult(
      h,
      `
                WITH x := <int64>{}
                SELECT array_agg(x);
            `,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `
                WITH x := (SELECT schema::ObjectType FILTER False)
                SELECT array_agg(x);
            `,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `
                WITH x := (
                    SELECT schema::ObjectType
                    FILTER <str>schema::ObjectType.id = '~'
                )
                SELECT array_agg(x);
            `,
      [
            [],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_09", () => {
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT
                    ObjectType {
                        l := array_agg(
                            ObjectType.properties.name
                            FILTER
                                ObjectType.properties.name IN {
                                    'id',
                                    'name'
                                }
                            ORDER BY ObjectType.properties.name ASC
                        )
                    }
                FILTER
                    ObjectType.name = 'schema::Object';
            `,
      [
            {
              "l": ["id", "name"],
            },
          ]
    );
  });

  it("test_edgeql_functions_array_agg_10", () => {
    assertQueryResult(
      h,
      `
                SELECT array_agg((
                    for issue in Issue
                        select [<str>issue.number, issue.status.name]
                    ORDER BY issue.number
                ));
            `,
      [
            [
              ["1", "Open"],
              ["2", "Open"],
              ["3", "Closed"],
              ["4", "Closed"],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_11", () => {
    assertQueryResult(
      h,
      `
                SELECT array_agg(
                    (<str>Issue.number, Issue.status.name)
                    ORDER BY Issue.number
                )[1];
            `,
      [
            ["2", "Open"],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_12", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    array_agg(User{name} ORDER BY User.name);
            `,
      [
            [
              {
                "name": "Elvis",
              },
              {
                "name": "Yury",
              },
            ],
          ]
    );
    let result = queryRows<any>(h, "\n            SELECT\n                array_agg(User{name} ORDER BY User.name);\n        ");
    expect(result[0][0].name).toEqual("Elvis");
    expect(result[0][1].name).toEqual("Yury");
  });

  it("test_edgeql_functions_array_agg_13", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    Issue {
                        number,
                        watchers_array := array_agg(Issue.watchers {name})
                    }
                FILTER
                    EXISTS Issue.watchers
                ORDER BY
                    Issue.number;
            `,
      [
            {
              "number": "1",
              "watchers_array": [
                {
                  "name": "Yury",
                },
              ],
            },
            {
              "number": "2",
              "watchers_array": [
                {
                  "name": "Elvis",
                },
              ],
            },
            {
              "number": "3",
              "watchers_array": [
                {
                  "name": "Elvis",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_functions_array_agg_14", () => {
    assertQueryResult(
      h,
      `
                SELECT array_agg(array_agg(User.name));
            `,
      [
            [
              ["Elvis", "Yury"],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_15", () => {
    assertQueryResult(
      h,
      `
                SELECT array_agg(
                    ([([User.name],)],) ORDER BY User.name
                );
            `,
      [
            [
              [
                [
                  [
                    ["Elvis"],
                  ],
                ],
              ],
              [
                [
                  [
                    ["Yury"],
                  ],
                ],
              ],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_16", () => {
    assertQueryResult(
      h,
      `
                SELECT array_agg(   # outer array
                    (               # tuple
                        array_agg(  # array
                            (       # tuple
                                array_agg(User.name ORDER BY User.name),
                            )
                        ),
                    )
                );
            `,
      [
            [
              [
                [
                  [
                    ["Elvis", "Yury"],
                  ],
                ],
              ],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_17", () => {
    assertQueryResult(
      h,
      `SELECT count(array_agg({}))`,
      [1]
    );
  });

  it("test_edgeql_functions_array_agg_18", () => {
    expect(() => {
      h.script(
        `SELECT array_agg({})`
      );
    }).toThrow(new RegExp("expression returns value of indeterminate type"));
  });

  it("test_edgeql_functions_array_agg_19", () => {
    assertQueryResult(
      h,
      `FOR X in {array_agg(0)} UNION (SELECT array_unpack(X));`,
      [0]
    );
    assertQueryResult(
      h,
      `
                FOR X in {array_agg((0, 1))}
                UNION (SELECT array_unpack(X));
            `,
      [
            [0, 1],
          ]
    );
    assertQueryResult(
      h,
      `FOR X in {array_agg((0, 1))} UNION (X);`,
      [
            [
              [0, 1],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_20", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue { te := array_agg(.time_estimate) };
            `,
      unorderedBag([
            {
              "te": [3000],
            },
            {
              "te": [],
            },
            {
              "te": [],
            },
            {
              "te": [],
            },
          ])
    );
    assertQueryResult(
      h,
      `
                SELECT Issue { te := array_agg(.time_estimate UNION 3000) };
            `,
      unorderedBag([
            {
              "te": [3000, 3000],
            },
            {
              "te": [3000],
            },
            {
              "te": [3000],
            },
            {
              "te": [3000],
            },
          ])
    );
  });

  it("test_edgeql_functions_array_agg_21", () => {
    assertQueryResult(
      h,
      `
            WITH X := array_agg((1, 2)),
            SELECT X FILTER X[0].0 = 1;
            `,
      [
            [
              [1, 2],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_22", () => {
    assertQueryResult(
      h,
      `
            WITH X := array_agg((foo := 1, bar := 2)),
            SELECT X FILTER X[0].foo = 1;
            `,
      [
            [
              {
                "bar": 2,
                "foo": 1,
              },
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_23", () => {
    assertQueryResult(
      h,
      `
            SELECT X := array_agg((foo := 1, bar := 2)) FILTER X[0].foo = 1;
            `,
      [
            [
              {
                "bar": 2,
                "foo": 1,
              },
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_24", () => {
    assertQueryResult(
      h,
      `SELECT array_agg({[1],[2],[3]});`,
      [
            [
              [1],
              [2],
              [3],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_25", () => {
    assertQueryResult(
      h,
      `SELECT array_agg({
                [(1, 'A')], [(2, 'B')], [(3, 'C')],
            });`,
      [
            [
              [
                [1, "A"],
              ],
              [
                [2, "B"],
              ],
              [
                [3, "C"],
              ],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_agg_26", () => {
    assertQueryResult(
      h,
      `SELECT array_agg({
                [([[11, 12], [13, 14]], [['AA', 'AB'], ['AC', 'AD']])],
                [([[21, 22], [23, 24]], [['BA', 'BB'], ['BC', 'BD']])],
            });`,
      [
            [
              [
                [
                  [
                    [11, 12],
                    [13, 14],
                  ],
                  [
                    ["AA", "AB"],
                    ["AC", "AD"],
                  ],
                ],
              ],
              [
                [
                  [
                    [21, 22],
                    [23, 24],
                  ],
                  [
                    ["BA", "BB"],
                    ["BC", "BD"],
                  ],
                ],
              ],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_unpack_01", () => {
    assertQueryResult(
      h,
      `SELECT [1, 2];`,
      [
            [1, 2],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_unpack([1, 2]);`,
      [1, 2]
    );
    assertQueryResult(
      h,
      `SELECT array_unpack([10, 20]) - 1;`,
      [9, 19]
    );
  });

  it("test_edgeql_functions_array_unpack_02", () => {
    assertQueryResult(
      h,
      `SELECT array_agg(array_unpack([1, 2, 3])) = [1, 2, 3];`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT array_unpack(array_agg({1, 2, 3}));`,
      unorderedSet([1, 2, 3])
    );
  });

  it("test_edgeql_functions_array_unpack_03", () => {
    assertQueryResult(
      h,
      `
                # array_agg and array_unpack are inverses of each other
                SELECT array_unpack(array_agg(Issue.number));
            `,
      unorderedSet(["1", "2", "3", "4"])
    );
  });

  it("test_edgeql_functions_array_unpack_04", () => {
    assertQueryResult(
      h,
      `
                # array_agg and array_unpack are inverses of each other
                SELECT array_unpack(array_agg(Issue)){number};
            `,
      unorderedBag([
            {
              "number": "1",
            },
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ])
    );
  });

  it("test_edgeql_functions_array_unpack_05", () => {
    assertQueryResult(
      h,
      `SELECT array_unpack([(1,)]).0;`,
      [1]
    );
  });

  it("test_edgeql_functions_array_unpack_06", () => {
    assertQueryResult(
      h,
      `SELECT 1 IN array_unpack([1]);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 2 IN array_unpack([1]);`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 2 NOT IN array_unpack([1]);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 1 IN array_unpack({[1,2,3], [4,5,6]});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 0 IN array_unpack({[1,2,3], [4,5,6]});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 1 NOT IN array_unpack({[1,2,3], [4,5,6]});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 0 NOT IN array_unpack({[1,2,3], [4,5,6]});`,
      [true]
    );
    assertQueryResult(
      h,
      `
            SELECT ("foo", 1) IN array_unpack([("foo", 1), ("bar", 2)]);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 2 IN array_unpack(<array<int64>>{});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 2 NOT IN array_unpack(<array<int64>>{});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 1n IN array_unpack([1n]);`,
      [true]
    );
    assertQueryResult(
      h,
      `
                select 1n in array_unpack(
                    <array<bigint>><array<str>>to_json('["1"]'))
            `,
      [true]
    );
  });

  it("test_edgeql_functions_array_unpack_07", () => {
    assertQueryResult(
      h,
      `SELECT array_unpack([[1], [2, 3], [4, 5, 6]]);`,
      [
            [1],
            [2, 3],
            [4, 5, 6],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_unpack([
                [(1, 'A')],
                [(2, 'B'), (3, 'C')],
                [(4, 'D'), (5, 'E'), (6, 'F')],
            ]);`,
      [
            [
              [1, "A"],
            ],
            [
              [2, "B"],
              [3, "C"],
            ],
            [
              [4, "D"],
              [5, "E"],
              [6, "F"],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_fill_01", () => {
    assertQueryResult(
      h,
      `select array_fill(0, 5);`,
      [
            [0, 0, 0, 0, 0],
          ]
    );
    assertQueryResult(
      h,
      `select array_fill('n/a', 5);`,
      [
            ["n/a", "n/a", "n/a", "n/a", "n/a"],
          ]
    );
    assertQueryResult(
      h,
      `
                with
                    date0 := <cal::local_date>'2022-05-01',
                    date1 := <cal::local_date>'2022-05-01'
                select array_fill(date0, 5) =
                    [date1, date1, date1, date1, date1];
            `,
      [true]
    );
  });

  it("test_edgeql_functions_array_fill_02 [xerror: edb.errors.InternalServerError: return type record[] is not supported for SQL functions]", () => {
    assertQueryResult(
      h,
      `select array_fill((1, 'hello'), 5);`,
      [
            [
              [1, "hello"],
              [1, "hello"],
              [1, "hello"],
              [1, "hello"],
              [1, "hello"],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_fill_03 [xerror: edb.errors.InternalServerError: return type record[] is not supported for SQL functions]", () => {
    assertQueryResult(
      h,
      `select array_fill((a := 1, b := 'hello'), 5);`,
      [
            [
              {
                "a": 1,
                "b": "hello",
              },
              {
                "a": 1,
                "b": "hello",
              },
              {
                "a": 1,
                "b": "hello",
              },
              {
                "a": 1,
                "b": "hello",
              },
              {
                "a": 1,
                "b": "hello",
              },
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_fill_04", () => {
    expect(() => {
      h.query(
        `select array_fill(0, 2147480000);`
      );
    }).toThrow(new RegExp("array size exceeds the maximum allowed"));
    expect(() => {
      h.query(
        `select array_fill(0, 2147483647);`
      );
    }).toThrow(new RegExp("array size exceeds the maximum allowed"));
    expect(() => {
      h.query(
        `select array_fill(0, 12147480000);`
      );
    }).toThrow(new RegExp("array size exceeds the maximum allowed"));
  });

  it("test_edgeql_functions_array_fill_05 [xerror: edb.errors.InternalServerError: return type record[] is not supported for SQL functions]", () => {
    assertQueryResult(
      h,
      `SELECT array_fill([1], 5);`,
      [
            [
              [1],
              [1],
              [1],
              [1],
              [1],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_fill([(1, 'A')], 5);`,
      [
            [
              [1, "A"],
              [1, "A"],
              [1, "A"],
              [1, "A"],
              [1, "A"],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_replace_01", () => {
    assertQueryResult(
      h,
      `select array_replace([1, 1, 2, 3, 5], 1, 99);`,
      [
            [99, 99, 2, 3, 5],
          ]
    );
    assertQueryResult(
      h,
      `select array_replace([1, 1, 2, 3, 5], 6, 99);`,
      [
            [1, 1, 2, 3, 5],
          ]
    );
  });

  it("test_edgeql_functions_array_replace_02", () => {
    assertQueryResult(
      h,
      `select array_replace(['h', 'e', 'l', 'l', 'o'], 'l', 'L');`,
      [
            ["h", "e", "L", "L", "o"],
          ]
    );
    assertQueryResult(
      h,
      `select array_replace(['h', 'e', 'l', 'l', 'o'], 'z', '!');`,
      [
            ["h", "e", "l", "l", "o"],
          ]
    );
  });

  it("test_edgeql_functions_array_replace_03", () => {
    assertQueryResult(
      h,
      `
            select array_replace(
                [(0, 'a'), (10, 'b'), (3, 'hello'), (0, 'a')],
                (0, 'a'), (99, '!')
            );
            `,
      [
            [
              [99, "!"],
              [10, "b"],
              [3, "hello"],
              [99, "!"],
            ],
          ]
    );
    assertQueryResult(
      h,
      `
            select array_replace(
                [(0, 'a'), (10, 'b'), (3, 'hello'), (0, 'a')],
                (1, 'a'), (99, '!')
            );
            `,
      [
            [
              [0, "a"],
              [10, "b"],
              [3, "hello"],
              [0, "a"],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_replace_04", () => {
    assertQueryResult(
      h,
      `
            select array_replace(
                [
                    (a := 0, b := 'a'),
                    (a := 10, b := 'b'),
                    (a := 3, b := 'hello'),
                    (a := 0, b := 'a')
                ],
                (a := 0, b := 'a'), (a := 99, b := '!')
            );
            `,
      [
            [
              {
                "a": 99,
                "b": "!",
              },
              {
                "a": 10,
                "b": "b",
              },
              {
                "a": 3,
                "b": "hello",
              },
              {
                "a": 99,
                "b": "!",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
            select array_replace(
                [
                    (a := 0, b := 'a'),
                    (a := 10, b := 'b'),
                    (a := 3, b := 'hello'),
                    (a := 0, b := 'a')
                ],
                (a := 1, b := 'a'), (a := 99, b := '!')
            );
            `,
      [
            [
              {
                "a": 0,
                "b": "a",
              },
              {
                "a": 10,
                "b": "b",
              },
              {
                "a": 3,
                "b": "hello",
              },
              {
                "a": 0,
                "b": "a",
              },
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_replace_05", () => {
    assertQueryResult(
      h,
      `SELECT array_replace([[1], [2, 3], [4, 5, 6]], [2, 3], [9]);`,
      [
            [
              [1],
              [9],
              [4, 5, 6],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_replace(
                [
                    [(1, 'A')],
                    [(2, 'B'), (3, 'C')],
                    [(4, 'D'), (5, 'E'), (6, 'F')],
                ],
                [(2, 'B'), (3, 'C')],
                [(9, 'I')],
            );`,
      [
            [
              [
                [1, "A"],
              ],
              [
                [9, "I"],
              ],
              [
                [4, "D"],
                [5, "E"],
                [6, "F"],
              ],
            ],
          ]
    );
  });

  it("test_edgeql_functions_enumerate_01", () => {
    assertQueryResult(
      h,
      `SELECT [10, 20];`,
      [
            [10, 20],
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([10,20]));`,
      [
            [0, 10],
            [1, 20],
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([10,20])).0 + 100;`,
      [100, 101]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([10,20])).1 + 100;`,
      [110, 120]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([(1, '2')]))`,
      [
            [
              0,
              [1, "2"],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([(1, '2')])).1.1`,
      ["2"]
    );
  });

  it("test_edgeql_functions_enumerate_02", () => {
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([(x:=1)])).1;`,
      [
            {
              "x": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([(x:=1)])).1.x;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([(x:=(a:=2))])).1;`,
      [
            {
              "x": {
                "a": 2,
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([(x:=(a:=2))])).1.x;`,
      [
            {
              "a": 2,
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(array_unpack([(x:=(a:=2))])).1.x.a;`,
      [2]
    );
  });

  it("test_edgeql_functions_enumerate_03", () => {
    assertQueryResult(
      h,
      `SELECT enumerate((SELECT User.name ORDER BY User.name));`,
      [
            [0, "Elvis"],
            [1, "Yury"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate({'a', 'b', 'c'});`,
      [
            [0, "a"],
            [1, "b"],
            [2, "c"],
          ]
    );
    assertQueryResult(
      h,
      `WITH A := {'a', 'b'} SELECT (A, enumerate(A));`,
      [
            [
              "a",
              [0, "a"],
            ],
            [
              "b",
              [0, "b"],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate({(1, 2), (3, 4)});`,
      [
            [
              0,
              [1, 2],
            ],
            [
              1,
              [3, 4],
            ],
          ]
    );
  });

  it("test_edgeql_functions_enumerate_04", () => {
    const rows = queryRows<string>(h, "select <json>enumerate({(1, 2), (3, 4)})");
    expect(rows).toEqual(["[0, [1, 2]]", "[1, [3, 4]]"]);
    expect(rows.map((row) => JSON.parse(row))).toEqual([[0, [1, 2]], [1, [3, 4]]]);
  });

  it("test_edgeql_functions_enumerate_05", () => {
    assertQueryResult(
      h,
      `SELECT enumerate(User { name } ORDER BY .name);`,
      [
            [
              0,
              {
                "name": "Elvis",
              },
            ],
            [
              1,
              {
                "name": "Yury",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(User ORDER BY .name).1.name;`,
      ["Elvis", "Yury"]
    );
  });

  it("test_edgeql_functions_enumerate_06", () => {
    assertQueryResult(
      h,
      `SELECT enumerate(_gen_series(0, 99) FILTER FALSE);`,
      []
    );
  });

  it("test_edgeql_functions_enumerate_07", () => {
    assertQueryResult(
      h,
      `
            WITH Z := enumerate(array_unpack([10, 20])),
                 Y := enumerate(Z),
            SELECT (Y.1.0, Y.1.1) ORDER BY Y.0;
            `,
      [
            [0, 10],
            [1, 20],
          ]
    );
  });

  it("test_edgeql_functions_enumerate_08", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue { te := enumerate(.time_estimate) };
            `,
      unorderedBag([
            {
              "te": [0, 3000],
            },
            {
              "te": null,
            },
            {
              "te": null,
            },
            {
              "te": null,
            },
          ])
    );
    assertQueryResult(
      h,
      `
            SELECT Issue { te := enumerate(.time_estimate UNION 3000) };
            `,
      unorderedBag([
            {
              "te": [
                [0, 3000],
                [1, 3000],
              ],
            },
            {
              "te": [
                [0, 3000],
              ],
            },
            {
              "te": [
                [0, 3000],
              ],
            },
            {
              "te": [
                [0, 3000],
              ],
            },
          ])
    );
  });

  it("test_edgeql_functions_enumerate_09", () => {
    assertQueryResult(
      h,
      `SELECT enumerate(sum({1,2,3}))`,
      [
            [0, 6],
          ]
    );
    assertQueryResult(
      h,
      `SELECT enumerate(count(Issue))`,
      [
            [0, 4],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH x := (SELECT enumerate(array_agg((select User)))),
            SELECT (x.0, array_unpack(x.1).name)
            `,
      [
            [0, "Elvis"],
            [0, "Yury"],
          ]
    );
  });

  it("test_edgeql_functions_array_get_01", () => {
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], 2);`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], -2);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], 20);`,
      []
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], -20);`,
      []
    );
    assertQueryResult(
      h,
      `SELECT array_get([[1], [2], [3]], 2);`,
      [
            [3],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_get([[1], [2], [3]], -2);`,
      [
            [2],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_get([[1], [2], [3]], 20);`,
      []
    );
    assertQueryResult(
      h,
      `SELECT array_get([[1], [2], [3]], -20);`,
      []
    );
  });

  it("test_edgeql_functions_array_get_02", () => {
    assertQueryResult(
      h,
      `
                SELECT array_get(array_agg(
                    Issue.number ORDER BY Issue.number), 2);
            `,
      ["3"]
    );
    assertQueryResult(
      h,
      `
                SELECT array_get(array_agg(
                    Issue.number ORDER BY Issue.number), -2);
            `,
      ["3"]
    );
    assertQueryResult(
      h,
      `SELECT array_get(array_agg(Issue.number), 20);`,
      []
    );
    assertQueryResult(
      h,
      `SELECT array_get(array_agg(Issue.number), -20);`,
      []
    );
  });

  it("test_edgeql_functions_array_get_03", () => {
    expect(() => {
      h.query(
        `
                SELECT array_get([1, 2, 3], 2^40);
            `
      );
    }).toThrow(new RegExp("function \"array_get.+\" does not exist"));
  });

  it("test_edgeql_functions_array_get_04", () => {
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], 0) ?? 42;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], 0, default := -1) ?? 42;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], -2) ?? 42;`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], 20) ?? 42;`,
      [42]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], -20) ?? 42;`,
      [42]
    );
  });

  it("test_edgeql_functions_array_get_05", () => {
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], 1, default := 4200) ?? 42;`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], -2, default := 4200) ?? 42;`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], 20, default := 4200) ?? 42;`,
      [4200]
    );
    assertQueryResult(
      h,
      `SELECT array_get([1, 2, 3], -20, default := 4200) ?? 42;`,
      [4200]
    );
  });

  it("test_edgeql_functions_array_get_06", () => {
    assertQueryResult(
      h,
      `SELECT array_get([(20,), (30,)], 0);`,
      [
            [20],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_get([(a:=20), (a:=30)], 1);`,
      [
            {
              "a": 30,
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_get([(20,), (30,)], 0).0;`,
      [20]
    );
    assertQueryResult(
      h,
      `SELECT array_get([(a:=20), (a:=30)], 1).0;`,
      [30]
    );
    assertQueryResult(
      h,
      `SELECT array_get([(a:=20, b:=1), (a:=30, b:=2)], 0).a;`,
      [20]
    );
    assertQueryResult(
      h,
      `SELECT array_get([(a:=20, b:=1), (a:=30, b:=2)], 1).b;`,
      [2]
    );
  });

  it("test_edgeql_functions_array_get_07", () => {
    assertQueryResult(
      h,
      `
                SELECT array_get([Issue.number], 0)
            `,
      unorderedSet(["1", "2", "3", "4"])
    );
  });

  it("test_edgeql_functions_array_get_08", () => {
    assertQueryResult(
      h,
      `
                select array_get(
                    array_agg((select x := {1,2,3} filter x > 0)), 1);
            `,
      [2]
    );
  });

  it("test_edgeql_functions_array_set_01", () => {
    assertQueryResult(
      h,
      `SELECT array_set([1, 2, 3, 4], 0, 9);`,
      [
            [9, 2, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1, 2, 3, 4], 1, 9);`,
      [
            [1, 9, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1, 2, 3, 4], 2, 9);`,
      [
            [1, 2, 9, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1, 2, 3, 4], 3, 9);`,
      [
            [1, 2, 3, 9],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1, 2, 3, 4], -1, 9);`,
      [
            [1, 2, 3, 9],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1, 2, 3, 4], -2, 9);`,
      [
            [1, 2, 9, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1, 2, 3, 4], -3, 9);`,
      [
            [1, 9, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1, 2, 3, 4], -4, 9);`,
      [
            [9, 2, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1], 0, 9);`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([1], -1, 9);`,
      [
            [9],
          ]
    );
  });

  it("test_edgeql_functions_array_set_01b [xerror: edb.errors.InternalServerError: return type record[] is not supported for SQL functions]", () => {
    assertQueryResult(
      h,
      `SELECT array_set([[1], [2], [3], [4]], 0, [9]);`,
      [
            [
              [9],
              [2],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1], [2], [3], [4]], 1, [9]);`,
      [
            [
              [1],
              [9],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1], [2], [3], [4]], 2, [9]);`,
      [
            [
              [1],
              [2],
              [9],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1], [2], [3], [4]], 3, [9]);`,
      [
            [
              [1],
              [2],
              [3],
              [9],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1], [2], [3], [4]], -1, [9]);`,
      [
            [
              [1],
              [2],
              [3],
              [9],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1], [2], [3], [4]], -2, [9]);`,
      [
            [
              [1],
              [2],
              [9],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1], [2], [3], [4]], -3, [9]);`,
      [
            [
              [1],
              [9],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1], [2], [3], [4]], -4, [9]);`,
      [
            [
              [9],
              [2],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1]], 0, [9]);`,
      [
            [
              [9],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_set([[1]], -1, [9]);`,
      [
            [
              [9],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_set_02", () => {
    expect(() => {
      h.query(
        `SELECT array_set([1, 2, 3, 4], 4, 9);`
      );
    }).toThrow(new RegExp("array index 4 is out of bounds"));
  });

  it("test_edgeql_functions_array_set_03", () => {
    expect(() => {
      h.query(
        `SELECT array_set([1, 2, 3, 4], -5, 9);`
      );
    }).toThrow(new RegExp("array index -5 is out of bounds"));
  });

  it("test_edgeql_functions_array_set_04", () => {
    expect(() => {
      h.query(
        `SELECT array_set([1], 1, 9);`
      );
    }).toThrow(new RegExp("array index 1 is out of bounds"));
  });

  it("test_edgeql_functions_array_set_05", () => {
    expect(() => {
      h.query(
        `SELECT array_set([1], -2, 9);`
      );
    }).toThrow(new RegExp("array index -2 is out of bounds"));
  });

  it("test_edgeql_functions_array_set_06", () => {
    expect(() => {
      h.query(
        `SELECT array_set(<array<int64>>[], 0, 9);`
      );
    }).toThrow(new RegExp("array index 0 is out of bounds"));
  });

  it("test_edgeql_functions_array_set_07", () => {
    expect(() => {
      h.query(
        `SELECT array_set(<array<int64>>[], -1, 9);`
      );
    }).toThrow(new RegExp("array index -1 is out of bounds"));
  });

  it("test_edgeql_functions_array_insert_01", () => {
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], 0, 9);`,
      [
            [9, 1, 2, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], 1, 9);`,
      [
            [1, 9, 2, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], 2, 9);`,
      [
            [1, 2, 9, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], 3, 9);`,
      [
            [1, 2, 3, 9, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], 4, 9);`,
      [
            [1, 2, 3, 4, 9],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], -1, 9);`,
      [
            [1, 2, 3, 9, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], -2, 9);`,
      [
            [1, 2, 9, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], -3, 9);`,
      [
            [1, 9, 2, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1, 2, 3, 4], -4, 9);`,
      [
            [9, 1, 2, 3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1], 0, 9);`,
      [
            [9, 1],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1], 1, 9);`,
      [
            [1, 9],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([1], -1, 9);`,
      [
            [9, 1],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert(<array<int64>>[], 0, 9);`,
      [
            [9],
          ]
    );
  });

  it("test_edgeql_functions_array_insert_01b [xerror: edb.errors.InternalServerError: return type record[] is not supported for SQL functions]", () => {
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], 0, [9]);`,
      [
            [
              [9],
              [1],
              [2],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], 1, [9]);`,
      [
            [
              [1],
              [9],
              [2],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], 2, [9]);`,
      [
            [
              [1],
              [2],
              [9],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], 3, [9]);`,
      [
            [
              [1],
              [2],
              [3],
              [9],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], 4, [9]);`,
      [
            [
              [1],
              [2],
              [3],
              [4],
              [9],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], -1, [9]);`,
      [
            [
              [1],
              [2],
              [3],
              [9],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], -2, [9]);`,
      [
            [
              [1],
              [2],
              [9],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], -3, [9]);`,
      [
            [
              [1],
              [9],
              [2],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1], [2], [3], [4]], -4, [9]);`,
      [
            [
              [9],
              [1],
              [2],
              [3],
              [4],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1]], 0, [9]);`,
      [
            [
              [9],
              [1],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1]], 1, [9]);`,
      [
            [
              [1],
              [9],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert([[1]], -1, [9]);`,
      [
            [
              [9],
              [1],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT array_insert(<array<int64>>[], 0, [9]);`,
      [
            [
              [9],
            ],
          ]
    );
  });

  it("test_edgeql_functions_array_insert_02", () => {
    expect(() => {
      h.query(
        `SELECT array_insert([1, 2, 3, 4], 5, 9);`
      );
    }).toThrow(new RegExp("array index 5 is out of bounds"));
  });

  it("test_edgeql_functions_array_insert_03", () => {
    expect(() => {
      h.query(
        `SELECT array_insert([1, 2, 3, 4], -5, 9);`
      );
    }).toThrow(new RegExp("array index -5 is out of bounds"));
  });

  it("test_edgeql_functions_array_insert_04", () => {
    expect(() => {
      h.query(
        `SELECT array_insert([1], 2, 9);`
      );
    }).toThrow(new RegExp("array index 2 is out of bounds"));
  });

  it("test_edgeql_functions_array_insert_05", () => {
    expect(() => {
      h.query(
        `SELECT array_insert([1], -2, 9);`
      );
    }).toThrow(new RegExp("array index -2 is out of bounds"));
  });

  it("test_edgeql_functions_array_insert_06", () => {
    expect(() => {
      h.query(
        `SELECT array_insert(<array<int64>>[], 1, 9);`
      );
    }).toThrow(new RegExp("array index 1 is out of bounds"));
  });

  it("test_edgeql_functions_array_insert_07", () => {
    expect(() => {
      h.query(
        `SELECT array_insert(<array<int64>>[], -1, 9);`
      );
    }).toThrow(new RegExp("array index -1 is out of bounds"));
  });

  it("test_edgeql_functions_re_match_01 [xerror: Known collation issue on Heroku Postgres]", () => {
    assertQueryResult(
      h,
      `SELECT re_match('ab', 'AbabaB');`,
      [
            ["ab"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT re_match('AB', 'AbabaB');`,
      []
    );
    assertQueryResult(
      h,
      `SELECT re_match('(?i)AB', 'AbabaB');`,
      [
            ["Ab"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT re_match('ac', 'AbabaB');`,
      []
    );
    assertQueryResult(
      h,
      `SELECT EXISTS re_match('ac', 'AbabaB');`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT NOT EXISTS re_match('ac', 'AbabaB');`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT EXISTS re_match('ab', 'AbabaB');`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT NOT EXISTS re_match('ab', 'AbabaB');`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT x := re_match({'(?i)ab', 'a'}, 'AbabaB') ORDER BY x;`,
      [
            ["Ab"],
            ["a"],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT x := re_match({'(?i)ab', 'a'}, {'AbabaB', 'qwerty'})
                ORDER BY x;
            `,
      [
            ["Ab"],
            ["a"],
          ]
    );
    assertQueryResult(
      h,
      `
            select re_match(
                r"(foo)?bar",
                'barbar',
            )
            `,
      [
            [""],
          ]
    );
  });

  it("test_edgeql_functions_re_match_02", () => {
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT x := re_match('(\\w+)::(Link|Property)',
                                     ObjectType.name)
                ORDER BY x;
            `,
      [
            ["schema", "Link"],
            ["schema", "Property"],
          ]
    );
  });

  it("test_edgeql_functions_re_match_03", () => {
    expect(() => {
      h.query(
        `
                select re_match('\\', 'asdf')
            `
      );
    }).toThrow(new RegExp("invalid regular expression"));
  });

  it("test_edgeql_functions_re_match_all_01 [xerror: Known collation issue on Heroku Postgres]", () => {
    assertQueryResult(
      h,
      `SELECT re_match_all('ab', 'AbabaB');`,
      [
            ["ab"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT re_match_all('AB', 'AbabaB');`,
      []
    );
    assertQueryResult(
      h,
      `SELECT re_match_all('(?i)AB', 'AbabaB');`,
      [
            ["Ab"],
            ["ab"],
            ["aB"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT re_match_all('ac', 'AbabaB');`,
      []
    );
    assertQueryResult(
      h,
      `SELECT EXISTS re_match_all('ac', 'AbabaB');`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT NOT EXISTS re_match_all('ac', 'AbabaB');`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT EXISTS re_match_all('(?i)ab', 'AbabaB');`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT NOT EXISTS re_match_all('(?i)ab', 'AbabaB');`,
      [false]
    );
    assertQueryResult(
      h,
      `
                SELECT x := re_match_all({'(?i)ab', 'a'}, 'AbabaB')
                ORDER BY x;`,
      [
            ["Ab"],
            ["a"],
            ["a"],
            ["aB"],
            ["ab"],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT x := re_match_all({'(?i)ab', 'a'},
                                         {'AbabaB', 'qwerty'})
                ORDER BY x;
            `,
      [
            ["Ab"],
            ["a"],
            ["a"],
            ["aB"],
            ["ab"],
          ]
    );
    assertQueryResult(
      h,
      `
            select re_match_all(
                r"(foo)?bar",
                'barbar',
            )
            `,
      [
            [""],
            [""],
          ]
    );
  });

  it("test_edgeql_functions_re_test_01", () => {
    assertQueryResult(
      h,
      `SELECT re_test('ac', 'AbabaB');`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT NOT re_test('ac', 'AbabaB');`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT re_test(r'(?i)ab', 'AbabaB');`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT NOT re_test(r'(?i)ab', 'AbabaB');`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT EXISTS re_test('(?i)ac', 'AbabaB');`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT NOT EXISTS re_test('(?i)ac', 'AbabaB');`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT x := re_test({'ab', 'a'}, 'AbabaB') ORDER BY x;`,
      [true, true]
    );
    assertQueryResult(
      h,
      `
                SELECT x := re_test({'ab', 'a'}, {'AbabaB', 'qwerty'})
                ORDER BY x;
            `,
      [false, false, true, true]
    );
  });

  it("test_edgeql_functions_re_test_02", () => {
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT count(
                    ObjectType FILTER re_test(r'(\W\w)bject$', ObjectType.name)
                ) = 2;
            `,
      [true]
    );
  });

  it("test_edgeql_functions_re_replace_01", () => {
    assertQueryResult(
      h,
      `SELECT re_replace('l', 'L', 'Hello World');`,
      ["HeLlo World"]
    );
    assertQueryResult(
      h,
      `SELECT re_replace('l', 'L', 'Hello World', flags := 'g');`,
      ["HeLLo WorLd"]
    );
    assertQueryResult(
      h,
      `
                SELECT re_replace('[a-z]', '~', 'Hello World',
                                  flags := 'i');`,
      ["~ello World"]
    );
    assertQueryResult(
      h,
      `
                SELECT re_replace('[a-z]', '~', 'Hello World',
                                  flags := 'gi');
            `,
      ["~~~~~ ~~~~~"]
    );
  });

  it("test_edgeql_functions_re_replace_02", () => {
    assertQueryResult(
      h,
      `SELECT re_replace('[aeiou]', '~', User.name);`,
      unorderedSet(["Elv~s", "Y~ry"])
    );
    assertQueryResult(
      h,
      `
                SELECT re_replace('[aeiou]', '~', User.name,
                                  flags := 'g');
            `,
      unorderedSet(["Elv~s", "Y~ry"])
    );
    assertQueryResult(
      h,
      `
                SELECT re_replace('[aeiou]', '~', User.name,
                                  flags := 'i');
            `,
      unorderedSet(["Y~ry", "~lvis"])
    );
    assertQueryResult(
      h,
      `
                SELECT re_replace('[aeiou]', '~', User.name,
                                  flags := 'gi');
            `,
      unorderedSet(["Y~ry", "~lv~s"])
    );
  });

  it("test_edgeql_functions_sum_01", () => {
    assertQueryResult(
      h,
      `SELECT sum({1, 2, 3, -4, 5});`,
      [7]
    );
    assertQueryResult(
      h,
      `SELECT sum({0.1, 0.2, 0.3, -0.4, 0.5});`,
      [0.7]
    );
  });

  it("test_edgeql_functions_sum_02", () => {
    assertQueryResult(
      h,
      `
                SELECT sum({1, 2, 3, -4.2, 5});
            `,
      [6.8]
    );
  });

  it("test_edgeql_functions_sum_03", () => {
    assertQueryResult(
      h,
      `
                SELECT sum({1.0, 2.0, 3.0, -4.2, 5});
            `,
      [6.8]
    );
  });

  it("test_edgeql_functions_sum_04", () => {
    assertQueryResult(
      h,
      `SELECT sum(<int16>2) IS int64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT sum(<int32>2) IS int64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT sum(<int64>2) IS int64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT sum(<float32>2) IS float32;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT sum(<float64>2) IS float64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT sum(<decimal>2) IS decimal;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT sum(<duration>"PT5S") IS duration;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT sum(<std::cal::relative_duration>"PT5S")
                IS std::cal::relative_duration;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT sum(<cal::date_duration>"PT5S")
                IS std::cal::date_duration;
            `,
      [true]
    );
  });

  it("test_edgeql_functions_sum_05", () => {
    assertQueryResult(
      h,
      `SELECT sum({<duration>"PT5S", <duration>"PT10S"})`,
      ["PT15S"]
    );
  });

  it("test_edgeql_functions_sum_07", () => {
    assertQueryResult(
      h,
      `
                SELECT sum({<cal::relative_duration>"PT5S",
                            <cal::relative_duration>"PT10S"})
            `,
      ["PT15S"]
    );
  });

  it("test_edgeql_functions_sum_08", () => {
    assertQueryResult(
      h,
      `
                SELECT sum({<cal::date_duration>"5 days",
                            <cal::date_duration>"10 days"})
            `,
      ["P15D"]
    );
  });

  it("test_edgeql_functions_unix_to_datetime_01", () => {
    let dt = h.query("SELECT <str>to_datetime(1590595184.584);");
    expect("2020-05-27T15:59:44.584+00:00").toEqual(dt);
  });

  it("test_edgeql_functions_unix_to_datetime_02", () => {
    let dt = h.query("SELECT <str>to_datetime(1590595184);");
    expect("2020-05-27T15:59:44+00:00").toEqual(dt);
  });

  it("test_edgeql_functions_unix_to_datetime_03", () => {
    let dt = h.query("SELECT <str>to_datetime(517795200);");
    expect("1986-05-30T00:00:00+00:00").toEqual(dt);
  });

  it("test_edgeql_functions_unix_to_datetime_04", () => {
    let dt = h.query("SELECT <str>to_datetime(517795200.00n);");
    expect("1986-05-30T00:00:00+00:00").toEqual(dt);
  });

  it("test_edgeql_functions_unix_to_datetime_05", () => {
    expect(() => {
      h.query(
        `SELECT to_datetime(999999999999)`
      );
    }).toThrow(new RegExp("'std::datetime' value out of range"));
  });

  it("test_edgeql_functions_datetime_current_01", () => {
    const [dt] = queryRows<string>(h, "SELECT <str>datetime_current();");
    expect(dt).toMatch(/\d+-\d+-\d+T\d+:\d+:\d+\.\d+.*/);
  });

  it("test_edgeql_functions_datetime_current_02", () => {
    type DatetimeRow = { dt_t: string; dt_s: string; dt_n: string };
    const batch1 = queryRows<DatetimeRow>(h, "\n            WITH MODULE schema\n            SELECT Type {\n                dt_t := datetime_of_transaction(),\n                dt_s := datetime_of_statement(),\n                dt_n := datetime_current(),\n            };\n        ");
    const batch2 = queryRows<DatetimeRow>(h, "\n            # NOTE: this test assumes that there's at least 1 microsecond\n            # time difference between statements\n            WITH MODULE schema\n            SELECT Type {\n                dt_t := datetime_of_transaction(),\n                dt_s := datetime_of_statement(),\n                dt_n := datetime_current(),\n            };\n        ");
    let batches = [...batch1, ...batch2];
    let set_dt_t = new Set(batches.map((t) => t.dt_t));
    expect(set_dt_t.size === 1).toBeTruthy();
    let set_dt_s1 = new Set(batch1.map((t) => t.dt_s));
    let set_dt_s2 = new Set(batch2.map((t) => t.dt_s));
    expect(set_dt_s1.size === 1).toBeTruthy();
    expect(set_dt_s2.size === 1).toBeTruthy();
    let dt_t = [...set_dt_t][0];
    let dt_s1 = [...set_dt_s1][0];
    let dt_s2 = [...set_dt_s2][0];
    expect(dt_t <= dt_s1 && dt_s1 < dt_s2).toBeTruthy();
    expect((dt_s1 <= batch1[0]["dt_n"])).toBeTruthy();
    expect((dt_s2 <= batch2[0]["dt_n"])).toBeTruthy();
    expect(batches.map((t) => t.dt_n)).toEqual([...batches.map((t) => t.dt_n)].sort());
    expect((batches[0]["dt_n"] < batches[batches.length - 1]["dt_n"])).toBeTruthy();
  });

  it("test_edgeql_functions_datetime_get_01", () => {
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'millennium');
            `,
      unorderedSet([3])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'century');
            `,
      unorderedSet([21])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'decade');
            `,
      unorderedSet([201])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'year');
            `,
      unorderedSet([2018])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'month');
            `,
      unorderedSet([5])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'day');
            `,
      unorderedSet([7])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'hour');
            `,
      unorderedSet([20])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'minutes');
            `,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'seconds');
            `,
      unorderedSet([22.306916])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'epochseconds');
            `,
      unorderedSet([1525723282.306916])
    );
  });

  it("test_edgeql_functions_datetime_get_02", () => {
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <cal::local_datetime>'2018-05-07T15:01:22.306916', 'year');
            `,
      unorderedSet([2018])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                  <cal::local_datetime>'2018-05-07T15:01:22.306916', 'month');
            `,
      unorderedSet([5])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <cal::local_datetime>'2018-05-07T15:01:22.306916', 'day');
            `,
      unorderedSet([7])
    );
    assertQueryResult(
      h,
      `
                SELECT datetime_get(
                    <cal::local_datetime>'2018-05-07T15:01:22.306916', 'hour');
            `,
      unorderedSet([15])
    );
    assertQueryResult(
      h,
      `SELECT datetime_get(
                <cal::local_datetime>'2018-05-07T15:01:22.306916', 'minutes');
            `,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `SELECT datetime_get(
                <cal::local_datetime>'2018-05-07T15:01:22.306916', 'seconds');
            `,
      unorderedSet([22.306916])
    );
  });

  it("test_edgeql_functions_datetime_get_03", () => {
    expect(() => {
      h.query(
        `
                SELECT datetime_get(
                    <cal::local_datetime>'2018-05-07T15:01:22.306916',
                    'timezone_hour'
                );
            `
      );
    }).toThrow(new RegExp("invalid unit for std::datetime_get"));
  });

  it("test_edgeql_functions_datetime_get_04", () => {
    expect(() => {
      h.query(
        `
                SELECT datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05',
                    'timezone_hour');
            `
      );
    }).toThrow(new RegExp("invalid unit for std::datetime_get"));
  });

  it("test_edgeql_functions_datetime_get_05", () => {
    expect(() => {
      h.script(
        `
                SELECT <str>datetime_get(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'epoch');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::datetime_get"));
  });

  it("test_edgeql_functions_duration_get_01", () => {
    assertQueryResult(
      h,
      `
                select duration_get(
                    <duration>'15:01:22.306916', 'hour');
            `,
      unorderedSet([15])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <duration>'15:01:22.306916', 'minutes');
            `,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <duration>'15:01:22.306916', 'seconds');
            `,
      unorderedSet([22.306916])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <duration>'15:01:22.306916', 'milliseconds');
            `,
      unorderedSet([22306.916])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <duration>'15:01:22.306916', 'microseconds');
            `,
      unorderedSet([22306916])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <duration>'15:01:22.306916', 'totalseconds');
            `,
      unorderedSet([54082.306916])
    );
  });

  it("test_edgeql_functions_duration_get_02", () => {
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'123 months', 'year');
            `,
      unorderedSet([10])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'123 months', 'month');
            `,
      unorderedSet([3])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'45 days', 'day');
            `,
      unorderedSet([45])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'15:01:22.306916', 'hour');
            `,
      unorderedSet([15])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'15:01:22.306916', 'minutes');
            `,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'15:01:22.306916', 'seconds');
            `,
      unorderedSet([22.306916])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'15:01:22.306916', 'milliseconds'
                );
            `,
      unorderedSet([22306.916])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'15:01:22.306916', 'microseconds'
                );
            `,
      unorderedSet([22306916])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::relative_duration>'15:01:22.306916', 'totalseconds'
                );
            `,
      unorderedSet([54082.306916])
    );
  });

  it("test_edgeql_functions_duration_get_03", () => {
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::date_duration>'123 months', 'year');
            `,
      unorderedSet([10])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::date_duration>'123 months', 'month');
            `,
      unorderedSet([3])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::date_duration>'45 days', 'day');
            `,
      unorderedSet([45])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::date_duration>'13 months 12 days', 'day');
            `,
      unorderedSet([12])
    );
    assertQueryResult(
      h,
      `
                select duration_get(
                    <cal::date_duration>'2 days', 'totalseconds'
                );
            `,
      unorderedSet([172800])
    );
  });

  it("test_edgeql_functions_duration_get_04", () => {
    expect(() => {
      h.script(
        `
                select duration_get(
                    <duration>'15:01:22.306916', 'days');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_get"));
  });

  it("test_edgeql_functions_duration_get_05", () => {
    expect(() => {
      h.script(
        `
                select duration_get(
                    <duration>'15:01:22.306916', 'epoch');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_get"));
  });

  it("test_edgeql_functions_duration_get_06", () => {
    expect(() => {
      h.script(
        `
                select duration_get(
                    <duration>'15:01:22.306916', 'epochseconds');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_get"));
  });

  it("test_edgeql_functions_duration_get_07", () => {
    expect(() => {
      h.script(
        `
                select duration_get(
                    <cal::relative_duration>'15:01:22.306916', 'epoch'
                );
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_get"));
  });

  it("test_edgeql_functions_duration_get_08", () => {
    expect(() => {
      h.script(
        `
                select duration_get(
                    <cal::relative_duration>'15:01:22.306916', 'epochseconds'
                );
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_get"));
  });

  it("test_edgeql_functions_duration_get_09", () => {
    expect(() => {
      h.script(
        `
                select duration_get(
                    <cal::date_duration>'1 day', 'hours');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_get"));
  });

  it("test_edgeql_functions_duration_get_10", () => {
    expect(() => {
      h.script(
        `
                select duration_get(
                    <cal::date_duration>'1 day', 'epoch');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_get"));
  });

  it("test_edgeql_functions_duration_get_11", () => {
    expect(() => {
      h.script(
        `
                select duration_get(
                    <cal::date_duration>'1 day', 'epochseconds');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_get"));
  });

  it("test_edgeql_functions_date_get_01", () => {
    assertQueryResult(
      h,
      `SELECT cal::date_get(<cal::local_date>'2018-05-07', 'year');
            `,
      unorderedSet([2018])
    );
    assertQueryResult(
      h,
      `SELECT cal::date_get(<cal::local_date>'2018-05-07', 'month');
            `,
      unorderedSet([5])
    );
    assertQueryResult(
      h,
      `SELECT cal::date_get(<cal::local_date>'2018-05-07', 'day');
            `,
      unorderedSet([7])
    );
  });

  it("test_edgeql_functions_date_get_02", () => {
    expect(() => {
      h.script(
        `
                SELECT <str>cal::date_get(
                    <cal::local_date>'2018-05-07', 'epoch');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::date_get"));
  });

  it("test_edgeql_functions_time_get_01", () => {
    assertQueryResult(
      h,
      `SELECT
                    cal::time_get(<cal::local_time>'15:01:22.306916', 'hour')
            `,
      unorderedSet([15])
    );
    assertQueryResult(
      h,
      `SELECT
                cal::time_get(<cal::local_time>'15:01:22.306916', 'minutes')
            `,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `SELECT
                cal::time_get(<cal::local_time>'15:01:22.306916', 'seconds')
            `,
      unorderedSet([22.306916])
    );
    assertQueryResult(
      h,
      `SELECT
                cal::time_get(<cal::local_time>'15:01:22.306916',
                              'midnightseconds')
            `,
      unorderedSet([54082.306916])
    );
  });

  it("test_edgeql_functions_time_get_02", () => {
    expect(() => {
      h.script(
        `
                SELECT <str>cal::time_get(
                    <cal::local_time>'15:01:22.306916', 'epoch');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::time_get"));
  });

  it("test_edgeql_functions_datetime_trunc_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'years');
            `,
      unorderedSet(["2018-01-01T00:00:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'decades');
            `,
      unorderedSet(["2010-01-01T00:00:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'centuries');
            `,
      unorderedSet(["2001-01-01T00:00:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'quarters');
            `,
      unorderedSet(["2018-04-01T00:00:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'months');
            `,
      unorderedSet(["2018-05-01T00:00:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'weeks');
            `,
      unorderedSet(["2018-05-07T00:00:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'days');
            `,
      unorderedSet(["2018-05-07T00:00:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'hours');
            `,
      unorderedSet(["2018-05-07T20:00:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'minutes');
            `,
      unorderedSet(["2018-05-07T20:01:00+00:00"])
    );
    assertQueryResult(
      h,
      `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'seconds');
            `,
      unorderedSet(["2018-05-07T20:01:22+00:00"])
    );
  });

  it("test_edgeql_functions_datetime_trunc_02", () => {
    expect(() => {
      h.script(
        `
                SELECT <str>datetime_truncate(
                    <datetime>'2018-05-07T15:01:22.306916-05', 'second');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::datetime_truncate"));
  });

  it("test_edgeql_functions_duration_trunc_01", () => {
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <duration>'15:01:22.306916', 'hours');
            `,
      unorderedSet(["PT15H"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <duration>'15:01:22.306916', 'minutes');
            `,
      unorderedSet(["PT15H1M"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <duration>'15:01:22.306916', 'seconds');
            `,
      unorderedSet(["PT15H1M22S"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <duration>'15:01:22.306916', 'milliseconds');
            `,
      unorderedSet(["PT15H1M22.306S"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <duration>'15:01:22.306916', 'microseconds');
            `,
      unorderedSet(["PT15H1M22.306916S"])
    );
  });

  it("test_edgeql_functions_duration_trunc_02", () => {
    expect(() => {
      h.script(
        `
                SELECT <str>duration_truncate(
                    <duration>'73 hours', 'day');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_truncate"));
  });

  it("test_edgeql_functions_duration_trunc_03", () => {
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::relative_duration>'P1312Y',
                'centuries'
            );
            `,
      unorderedSet(["P1300Y"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::relative_duration>'P1312Y',
                'decades'
            );
            `,
      unorderedSet(["P1310Y"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                cal::duration_normalize_days(
                    cal::duration_normalize_hours(
                        <cal::relative_duration>'PT15000H',
                    )
                ),
                'years'
            );
            `,
      unorderedSet(["P1Y"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                cal::duration_normalize_days(
                    cal::duration_normalize_hours(
                        <cal::relative_duration>'PT15000H'
                    )
                ),
                'quarters'
            );
            `,
      unorderedSet(["P1Y6M"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                cal::duration_normalize_days(
                    cal::duration_normalize_hours(
                        <cal::relative_duration>'PT15000H'
                    )
                ),
                'months'
            );
            `,
      unorderedSet(["P1Y8M"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                cal::duration_normalize_days(
                    cal::duration_normalize_hours(
                        <cal::relative_duration>'PT15000H'
                    )
                ),
                'days'
            );
            `,
      unorderedSet(["P1Y8M25D"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::relative_duration>'15:01:22.306916', 'hours');
            `,
      unorderedSet(["PT15H"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::relative_duration>'15:01:22.306916', 'minutes');
            `,
      unorderedSet(["PT15H1M"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::relative_duration>'15:01:22.306916', 'seconds');
            `,
      unorderedSet(["PT15H1M22S"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::relative_duration>'15:01:22.306916', 'milliseconds');
            `,
      unorderedSet(["PT15H1M22.306S"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::relative_duration>'15:01:22.306916', 'microseconds');
            `,
      unorderedSet(["PT15H1M22.306916S"])
    );
  });

  it("test_edgeql_functions_duration_trunc_04", () => {
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::date_duration>'P1312Y',
                'centuries'
            );
            `,
      unorderedSet(["P1300Y"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                <cal::date_duration>'P1312Y',
                'decades'
            );
            `,
      unorderedSet(["P1310Y"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                cal::duration_normalize_days(
                    <cal::date_duration>'P1312D'
                ),
                'years'
            );
            `,
      unorderedSet(["P3Y"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                cal::duration_normalize_days(
                    <cal::date_duration>'P1312D'
                ),
                'quarters'
            );
            `,
      unorderedSet(["P3Y6M"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                cal::duration_normalize_days(
                    <cal::date_duration>'P1312D'
                ),
                'months'
            );
            `,
      unorderedSet(["P3Y7M"])
    );
    assertQueryResult(
      h,
      `
            SELECT <str>duration_truncate(
                cal::duration_normalize_days(
                    <cal::date_duration>'P1312D'
                ),
                'days'
            );
            `,
      unorderedSet(["P3Y7M22D"])
    );
  });

  it("test_edgeql_functions_duration_trunc_05", () => {
    expect(() => {
      h.script(
        `
                SELECT <str>duration_truncate(
                    <cal::date_duration>'42 days', 'hours');
                `
      );
    }).toThrow(new RegExp("invalid unit for std::duration_truncate"));
  });

  it("test_edgeql_functions_to_datetime_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>to_datetime(
                    2018, 5, 7, 15, 1, 22.306916, 'EST');
            `,
      ["2018-05-07T20:01:22.306916+00:00"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>to_datetime(
                    2018, 5, 7, 15, 1, 22.306916, '-5');
            `,
      ["2018-05-07T20:01:22.306916+00:00"]
    );
    expect(() => {
      h.query(
        `SELECT to_datetime("2017-10-10", "")`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_datetime_02", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>to_datetime(
                    cal::to_local_datetime(2018, 5, 7, 15, 1, 22.306916),
                    'EST')
            `,
      ["2018-05-07T20:01:22.306916+00:00"]
    );
  });

  it("test_edgeql_functions_to_datetime_03", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    to_datetime('2019/01/01 00:00:00 0715',
                                'YYYY/MM/DD H24:MI:SS TZHTZM') =
                    <datetime>'2019-01-01T00:00:00+0715';
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT
                    to_datetime('2019/01/01 00:00:00 07TZM',
                                'YYYY/MM/DD H24:MI:SS TZH"TZM"') =
                    <datetime>'2019-01-01T00:00:00+07';
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT
                    to_datetime('2019/01/01 00:00:00 TZH07TZM',
                                'YYYY/MM/DD H24:MI:SS "TZH"TZH"TZM"') =
                    <datetime>'2019-01-01T00:00:00+07';
            `,
      [true]
    );
    expect(() => {
      h.query(
        `
                    SELECT
                        to_datetime('2019/01/01 00:00:00 TZH07',
                                    'YYYY/MM/DD H24:MI:SS "TZH"TZM') =
                        <datetime>'2019-01-01T00:00:00+07';
                `
      );
    }).toThrow(new RegExp("missing required time zone in format"));
  });

  it("test_edgeql_functions_to_datetime_04", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        to_datetime('2019/01/01 00:00:00 0715',
                                    'YYYY/MM/DD H24:MI:SS "NOPE"TZHTZM');
                `
      );
    }).toThrow(new RegExp("missing required time zone in input"));
  });

  it("test_edgeql_functions_to_datetime_05", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        to_datetime('2019/01/01 00:00:00');
                `
      );
    }).toThrow(new RegExp("invalid input syntax"));
  });

  it("test_edgeql_functions_to_datetime_06", () => {
    expect(() => {
      h.query(
        `
                SELECT to_datetime(10000, 1, 1, 1, 1, 1, 'UTC');
            `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.query(
        `
                SELECT to_datetime(0, 1, 1, 1, 1, 1, 'UTC');
            `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.query(
        `
                SELECT to_datetime(-1, 1, 1, 1, 1, 1, 'UTC');
            `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_functions_to_local_datetime_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>cal::to_local_datetime(
                    <datetime>'2018-05-07T20:01:22.306916+00:00',
                    'America/Los_Angeles');
            `,
      ["2018-05-07T13:01:22.306916"]
    );
  });

  it("test_edgeql_functions_to_local_datetime_02", () => {
    assertQueryResult(
      h,
      `
              SELECT <str>cal::to_local_datetime(2018, 5, 7, 15, 1, 22.306916);
            `,
      ["2018-05-07T15:01:22.306916"]
    );
  });

  it("test_edgeql_functions_to_local_datetime_03", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    cal::to_local_datetime('2019/01/01 00:00:00 0715',
                                      'YYYY/MM/DD H24:MI:SS "NOTZ"') =
                    <cal::local_datetime>'2019-01-01T00:00:00';
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT
                    cal::to_local_datetime('2019/01/01 00:00:00 0715',
                                      'YYYY/MM/DD H24:MI:SS') =
                    <cal::local_datetime>'2019-01-01T00:00:00';
            `,
      [true]
    );
  });

  it("test_edgeql_functions_to_local_datetime_04", () => {
    expect(() => {
      h.query(
        `
                        SELECT
                          cal::to_local_datetime('2019/01/01 00:00:00 0715',
                                                 'YYYY/MM/DD H24:MI:SS TZH') =
                          <cal::local_datetime>'2019-01-01T00:00:00';
                    `
      );
    }).toThrow(new RegExp("unexpected time zone in format"));
  });

  it("test_edgeql_functions_to_local_datetime_05", () => {
    assertQueryResult(
      h,
      `
                SELECT (<str><cal::local_datetime>'2019-01-01 00:00:00',
                        <str>cal::to_local_datetime('2019/01/01 00:00:00 0715',
                                                    'YYYY/MM/DD H24:MI:SS'),
                        <str><cal::local_datetime>'2019-02-01 00:00:00');
            `,
      [
            ["2019-01-01T00:00:00", "2019-01-01T00:00:00", "2019-02-01T00:00:00"],
          ]
    );
  });

  it("test_edgeql_functions_to_local_datetime_06", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        cal::to_local_datetime('2019/01/01 00:00:00 0715');
                `
      );
    }).toThrow(new RegExp("invalid input syntax"));
  });

  it("test_edgeql_functions_to_local_datetime_07", () => {
    expect(() => {
      h.query(
        `
                SELECT cal::to_local_datetime(10000, 1, 1, 1, 1, 1);
            `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.query(
        `
                SELECT cal::to_local_datetime(0, 1, 1, 1, 1, 1);
            `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.query(
        `
                SELECT cal::to_local_datetime(-1, 1, 1, 1, 1, 1);
            `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_functions_to_local_date_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>cal::to_local_date(2018, 5, 7);
            `,
      ["2018-05-07"]
    );
    expect(() => {
      h.query(
        `SELECT cal::to_local_date("2017-10-10", "")`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_local_date_02", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>cal::to_local_date(
                    <datetime>'2018-05-07T20:01:22.306916+00:00',
                    'America/Los_Angeles');
            `,
      ["2018-05-07"]
    );
  });

  it("test_edgeql_functions_to_local_date_03", () => {
    expect(() => {
      h.query(
        `
                        SELECT
                            cal::to_local_date('2019/01/01 00:00:00 0715',
                                               'YYYY/MM/DD H24:MI:SS TZH') =
                            <cal::local_date>'2019-01-01';
                    `
      );
    }).toThrow(new RegExp("unexpected time zone in format"));
  });

  it("test_edgeql_functions_to_local_date_04", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        cal::to_local_date('2019/01/01 00:00:00 0715');
                `
      );
    }).toThrow(new RegExp("invalid input syntax"));
  });

  it("test_edgeql_functions_to_local_date_05", () => {
    expect(() => {
      h.query(
        `
                SELECT cal::to_local_date(10000, 1, 1);
            `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.query(
        `
                SELECT cal::to_local_date(0, 1, 1);
            `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.query(
        `
                SELECT cal::to_local_date(-1, 1, 1);
            `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_functions_to_local_time_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>cal::to_local_time(15, 1, 22.306916);
            `,
      ["15:01:22.306916"]
    );
    expect(() => {
      h.query(
        `SELECT cal::to_local_time("12:00:00", "")`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_local_time_02", () => {
    assertQueryResult(
      h,
      `
                SELECT <str>cal::to_local_time(
                    <datetime>'2018-05-07T20:01:22.306916+00:00',
                    'America/Los_Angeles');
            `,
      ["13:01:22.306916"]
    );
  });

  it("test_edgeql_functions_to_local_time_03", () => {
    expect(() => {
      h.query(
        `
                        SELECT
                            cal::to_local_time('00:00:00 0715',
                                          'H24:MI:SS TZH') =
                            <cal::local_time>'00:00:00';
                    `
      );
    }).toThrow(new RegExp("unexpected time zone in format"));
  });

  it("test_edgeql_functions_to_local_time_04", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        cal::to_local_datetime('00:00:00 0715');
                `
      );
    }).toThrow(new RegExp("invalid input syntax"));
  });

  it("test_edgeql_functions_to_local_time_05", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        cal::to_local_time('24:00:00');
                `
      );
    }).toThrow(new RegExp("std::cal::local_time field value out of range"));
  });

  it("test_edgeql_functions_to_local_time_06", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        cal::to_local_time(23, 59, 60);
                `
      );
    }).toThrow(new RegExp("std::cal::local_time field value out of range"));
  });

  it("test_edgeql_functions_to_local_time_07", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        <cal::local_time>'23:59:59.999999999999';
                `
      );
    }).toThrow(new RegExp("std::cal::local_time field value out of range"));
  });

  it("test_edgeql_functions_to_local_time_08", () => {
    expect(() => {
      h.query(
        `
                    SELECT
                        <cal::local_time><json>'24:00:00';
                `
      );
    }).toThrow(new RegExp("std::cal::local_time field value out of range"));
  });

  it("test_edgeql_functions_to_duration_01", () => {
    assertQueryResult(
      h,
      `SELECT <str>to_duration(hours:=20);`,
      ["PT20H"]
    );
    assertQueryResult(
      h,
      `SELECT <str>to_duration(minutes:=20);`,
      ["PT20M"]
    );
    assertQueryResult(
      h,
      `SELECT <str>to_duration(seconds:=20);`,
      ["PT20S"]
    );
    assertQueryResult(
      h,
      `SELECT <str>to_duration(seconds:=20.15);`,
      ["PT20.15S"]
    );
    assertQueryResult(
      h,
      `SELECT <str>to_duration(microseconds:=100);`,
      ["PT0.0001S"]
    );
  });

  it("test_edgeql_functions_to_duration_02", () => {
    assertQueryResult(
      h,
      `SELECT to_duration(hours:=20) > to_duration(minutes:=20);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT to_duration(minutes:=20) > to_duration(seconds:=20);`,
      [true]
    );
  });

  it("test_edgeql_functions_duration_to_seconds", () => {
    assertQueryResult(
      h,
      `SELECT duration_to_seconds(<duration>'20 hours');`,
      [72000.0]
    );
    assertQueryResult(
      h,
      `SELECT duration_to_seconds(<duration>'1:02:03.000123');`,
      [3723.000123]
    );
  });

  it("test_edgeql_functions_duration_to_seconds_exact", () => {
    assertQueryResult(
      h,
      `SELECT duration_to_seconds(
                <duration>'1801439850 seconds 123456 microseconds');`,
      [1801439850.123456]
    );
  });

  it("test_edgeql_functions_duration_normalize_01", () => {
    assertQueryResult(
      h,
      `select <cal::relative_duration>'30240000 seconds';`,
      ["PT8400H"]
    );
    assertQueryResult(
      h,
      `select cal::duration_normalize_hours(
                <cal::relative_duration>'30240000 seconds');`,
      ["P350D"]
    );
    assertQueryResult(
      h,
      `select cal::duration_normalize_days(
                <cal::relative_duration>'350 days');`,
      ["P11M20D"]
    );
    assertQueryResult(
      h,
      `select cal::duration_normalize_days(
                    cal::duration_normalize_hours(
                        <cal::relative_duration>'30240000 seconds'));`,
      ["P11M20D"]
    );
  });

  it("test_edgeql_functions_duration_normalize_02", () => {
    assertQueryResult(
      h,
      `select <str>cal::duration_normalize_days(
                <cal::date_duration>'350 days');`,
      ["P11M20D"]
    );
  });

  it("test_edgeql_functions_to_str_01", () => {
    assertQueryResult(
      h,
      `
                WITH DT := datetime_current()
                # FIXME: the cast has a "T" and the str doesn't for some reason
                SELECT <str>DT = to_str(DT);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
            WITH D := cal::to_local_date(datetime_current(), 'UTC')
            SELECT <str>D = to_str(D);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
            WITH NT := cal::to_local_time(datetime_current(), 'UTC')
            SELECT <str>NT = to_str(NT);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <str>123 = to_str(123);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <str>123.456 = to_str(123.456);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <str>123.456e-20 = to_str(123.456e-20);`,
      [true]
    );
    assertQueryResult(
      h,
      `
            SELECT <str><decimal>'123456789012345678901234567890.1234567890' =
                to_str(123456789012345678901234567890.1234567890n);
            `,
      [true]
    );
    expect(() => {
      h.query(
        `SELECT to_str(1, "")`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
    expect(() => {
      h.query(
        `SELECT to_str(1.1, "")`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
    expect(() => {
      h.query(
        `SELECT to_str(1.1n, "")`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
    expect(() => {
      h.query(
        `SELECT to_str(to_json('{}'), "")`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_str_02", () => {
    assertQueryResult(
      h,
      `
            WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
            SELECT to_str(DT, 'YYYY-MM-DD');
            `,
      unorderedSet(["2018-05-07"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
            SELECT to_str(DT, 'YYYYBC');
            `,
      unorderedSet(["2018AD"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
            SELECT to_str(DT, 'FMDDth "of" FMMonth, YYYY');
            `,
      unorderedSet(["7th of May, 2018"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
            SELECT to_str(DT, 'CCth "century"');
            `,
      unorderedSet(["21st century"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
            SELECT to_str(DT, 'Y,YYY Month DD Day');
            `,
      unorderedSet(["2,018 May       07 Monday   "])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
            SELECT to_str(DT, 'foo');
            `,
      unorderedSet(["foo"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
            SELECT to_str(DT, ' ');
            `,
      unorderedSet([" "])
    );
    expect(() => {
      h.query(
        `
                    WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
                    SELECT to_str(DT, '');
                `
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
    expect(() => {
      h.query(
        `
                    WITH DT := to_duration(hours:=20)
                    SELECT to_str(DT, '');
                `
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_str_03", () => {
    assertQueryResult(
      h,
      `
                WITH DT := <datetime>'2018-05-07 15:01:22.306916-05'
                SELECT to_str(DT, 'HH:MI A.M.');
            `,
      unorderedSet(["08:01 P.M."])
    );
  });

  it("test_edgeql_functions_to_str_04", () => {
    assertQueryResult(
      h,
      `
            WITH DT := <cal::local_date>'2018-05-07'
            SELECT to_str(DT, 'YYYY-MM-DD');
            `,
      unorderedSet(["2018-05-07"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <cal::local_date>'2018-05-07'
            SELECT to_str(DT, 'YYYYBC');
            `,
      unorderedSet(["2018AD"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <cal::local_date>'2018-05-07'
            SELECT to_str(DT, 'FMDDth "of" FMMonth, YYYY');
            `,
      unorderedSet(["7th of May, 2018"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <cal::local_date>'2018-05-07'
            SELECT to_str(DT, 'CCth "century"');
            `,
      unorderedSet(["21st century"])
    );
    assertQueryResult(
      h,
      `
            WITH DT := <cal::local_date>'2018-05-07'
            SELECT to_str(DT, 'Y,YYY Month DD Day');
            `,
      unorderedSet(["2,018 May       07 Monday   "])
    );
    assertQueryResult(
      h,
      `
            # the format string doesn't have any special characters
            WITH DT := <cal::local_date>'2018-05-07'
            SELECT to_str(DT, 'foo');
            `,
      unorderedSet(["foo"])
    );
    expect(() => {
      h.query(
        `
                    WITH DT := <cal::local_time>'12:00:00'
                    SELECT to_str(DT, '');
                `
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
    expect(() => {
      h.query(
        `
                    WITH DT := <cal::local_date>'2018-05-07'
                    SELECT to_str(DT, '');
                `
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_str_05", () => {
    assertQueryResult(
      h,
      `SELECT to_str(123456789, '99');`,
      unorderedSet([" ##"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, '999999999');`,
      unorderedSet([" 123456789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, '999,999,999');`,
      unorderedSet([" 123,456,789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, '999,999,999,999');`,
      unorderedSet(["     123,456,789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, 'FM999,999,999,999');`,
      unorderedSet(["123,456,789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, 'S999,999,999,999');`,
      unorderedSet(["    +123,456,789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, 'SG999,999,999,999');`,
      unorderedSet(["+    123,456,789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, 'S099,999,999,999');`,
      unorderedSet(["+000,123,456,789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, 'SG099,999,999,999');`,
      unorderedSet(["+000,123,456,789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, 'S099999999999');`,
      unorderedSet(["+000123456789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, 'S990999999999');`,
      unorderedSet(["  +0123456789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123456789, 'FMS990999999999');`,
      unorderedSet(["+0123456789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(-123456789, '999999999PR');`,
      unorderedSet(["<123456789>"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(987654321, 'FM999999999th');`,
      unorderedSet(["987654321st"])
    );
    expect(() => {
      h.query(
        `SELECT to_str(987654321, '');`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_str_06", () => {
    assertQueryResult(
      h,
      `SELECT to_str(123.456789, '99');`,
      unorderedSet([" ##"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789, '999');`,
      unorderedSet([" 123"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789, '999.999');`,
      unorderedSet([" 123.457"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789, '999.999999999');`,
      unorderedSet([" 123.456789000"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789, 'FM999.999999999');`,
      unorderedSet(["123.456789"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789e-20, '999.999999999');`,
      unorderedSet(["    .000000000"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789e-20, 'FM999.999999999');`,
      unorderedSet(["0."])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789e-20, '099.999999990');`,
      unorderedSet([" 000.000000000"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789e-20, 'FM990.099999999');`,
      unorderedSet(["0.0"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789e-20, '0.0999EEEE');`,
      unorderedSet([" 1.2346e-18"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(123.456789e20, '0.0999EEEE');`,
      unorderedSet([" 1.2346e+22"])
    );
    expect(() => {
      h.query(
        `SELECT to_str(123.456789e20, '');`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_str_07", () => {
    assertQueryResult(
      h,
      `SELECT to_str(<cal::local_time>'15:01:22', 'HH:MI A.M.');`,
      unorderedSet(["03:01 P.M."])
    );
    assertQueryResult(
      h,
      `SELECT to_str(<cal::local_time>'15:01:22', 'HH:MI:SSam.');`,
      unorderedSet(["03:01:22pm."])
    );
    assertQueryResult(
      h,
      `SELECT to_str(<cal::local_time>'15:01:22', 'HH24:MI');`,
      unorderedSet(["15:01"])
    );
    assertQueryResult(
      h,
      `SELECT to_str(<cal::local_time>'15:01:22', ' ');`,
      unorderedSet([" "])
    );
    expect(() => {
      h.query(
        `SELECT to_str(<cal::local_time>'15:01:22', '');`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_string_bytes_conversion", () => {
    assertQueryResult(
      h,
      `
            WITH
                input := <bytes>$input,
                string := to_str(input),
                binary := to_bytes(string),
            SELECT
                binary = input;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_string_bytes_conversion_error", () => {
    expect(() => {
      h.script(
        `
                SELECT to_str(b'\x00')
                `
      );
    }).toThrow(new RegExp("invalid byte sequence for encoding \"UTF8\": 0x00"));
  });

  it("test_edgeql_functions_json_bytes_conversion", () => {
    assertQueryResult(
      h,
      `
                WITH
                    input := <bytes>$input,
                    as_json := to_json(to_str(input)),
                    as_bytes := to_bytes(as_json),
                SELECT
                    as_bytes = <bytes>$expected;
                `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
                WITH
                    input := <bytes>$input,
                    as_json := to_json(to_str(input)),
                    as_bytes := to_bytes(as_json),
                SELECT
                    as_bytes = <bytes>$expected;
                `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
                WITH
                    input := <bytes>$input,
                    as_json := to_json(to_str(input)),
                    as_bytes := to_bytes(as_json),
                SELECT
                    as_bytes = <bytes>$expected;
                `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_int_bytes_conversion_01", () => {
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int16>$val_b,
                        val_l := <int16>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int16(bin, Endian.Big),
                        val_l = to_int16(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int32>$val_b,
                        val_l := <int32>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int32(bin, Endian.Big),
                        val_l = to_int32(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
    assertQueryResult(
      h,
      `
                    WITH
                        val_b := <int64>$val_b,
                        val_l := <int64>$val_l,
                        bin := <bytes>$bin,
                    SELECT (
                        val_b = to_int64(bin, Endian.Big),
                        val_l = to_int64(bin, Endian.Little),
                        bin = to_bytes(val_b, Endian.Big),
                        bin = to_bytes(val_l, Endian.Little),
                    )
                    `,
      unorderedSet([
            [true, true, true, true],
          ])
    );
  });

  it("test_edgeql_functions_int_bytes_conversion_02", () => {
    expect(() => {
      h.script(
        `
                    SELECT to_int16(b'\x01', Endian.Big)
                    `
      );
    }).toThrow(new RegExp("to_int16.*the argument must be exactly 2 bytes long"));
    expect(() => {
      h.script(
        `
                    SELECT to_int16(
                        to_bytes(<int32>123, Endian.Big),
                        Endian.Big,
                    )
                    `
      );
    }).toThrow(new RegExp("to_int16.*the argument must be exactly 2 bytes long"));
  });

  it("test_edgeql_functions_int_bytes_conversion_03", () => {
    expect(() => {
      h.script(
        `
                    SELECT to_int32(
                        to_bytes(<int16>23, Endian.Big),
                        Endian.Big,
                    )
                    `
      );
    }).toThrow(new RegExp("to_int32.*the argument must be exactly 4 bytes long"));
    expect(() => {
      h.script(
        `
                    SELECT to_int32(
                        to_bytes(<int64>16908295, Endian.Big),
                        Endian.Big,
                    )
                    `
      );
    }).toThrow(new RegExp("to_int32.*the argument must be exactly 4 bytes long"));
  });

  it("test_edgeql_functions_int_bytes_conversion_04", () => {
    expect(() => {
      h.script(
        `
                    SELECT to_int64(
                        to_bytes(<int16>23, Endian.Big),
                        Endian.Big,
                    )
                    `
      );
    }).toThrow(new RegExp("to_int64.*the argument must be exactly 8 bytes long"));
    expect(() => {
      h.script(
        `
                    SELECT to_int64(
                        b'\x00' ++ to_bytes(62620574343574340, Endian.Big),
                        Endian.Big,
                    )
                    `
      );
    }).toThrow(new RegExp("to_int64.*the argument must be exactly 8 bytes long"));
  });

  it("test_edgeql_functions_uuid_bytes_conversion_01", () => {
    assertQueryResult(
      h,
      `
            WITH
                uuid_input := <uuid>$uuid_input,
                bin_input := <bytes>$bin_input,
            SELECT (
                bin_input = to_bytes(uuid_input),
                uuid_input = to_uuid(bin_input),
            )
            `,
      unorderedSet([
            [true, true],
          ])
    );
  });

  it("test_edgeql_functions_uuid_bytes_conversion_02", () => {
    expect(() => {
      h.script(
        `
                    SELECT to_uuid(to_bytes(uuid_generate_v4())[:10])
                    `
      );
    }).toThrow(new RegExp("to_uuid.*the argument must be exactly 16 bytes long"));
    expect(() => {
      h.script(
        `
                    SELECT to_uuid(b'\xff\xff' ++ to_bytes(uuid_generate_v4()))
                    `
      );
    }).toThrow(new RegExp("to_uuid.*the argument must be exactly 16 bytes long"));
  });

  it("test_edgeql_functions_array_join_01", () => {
    assertQueryResult(
      h,
      `SELECT array_join(['one', 'two', 'three'], ', ');`,
      ["one, two, three"]
    );
    assertQueryResult(
      h,
      `SELECT array_join(['one', 'two', 'three'], '');`,
      ["onetwothree"]
    );
    assertQueryResult(
      h,
      `SELECT array_join(<array<str>>[], ', ');`,
      [""]
    );
  });

  it("test_edgeql_functions_array_join_02", () => {
    assertQueryResult(
      h,
      `SELECT array_join(['one', 'two', 'three'], {', ', '@!'});`,
      unorderedSet(["one, two, three", "one@!two@!three"])
    );
  });

  it("test_edgeql_functions_array_join_03", () => {
    assertQueryResult(
      h,
      `SELECT array_join([b'one', b'two', b'three'], b', ');`,
      ["b25lLCB0d28sIHRocmVl"]
    );
    assertQueryResult(
      h,
      `SELECT array_join([b'one', b'two', b'three'], b'');`,
      ["b25ldHdvdGhyZWU="]
    );
    assertQueryResult(
      h,
      `SELECT array_join(<array<bytes>>[], b', ');`,
      [""]
    );
  });

  it("test_edgeql_functions_array_join_04", () => {
    assertQueryResult(
      h,
      `
            SELECT array_join([b'one', b'two', b'three'], {b', ', b'@!'});
            `,
      unorderedSet(["b25lLCB0d28sIHRocmVl", "b25lQCF0d29AIXRocmVl"])
    );
  });

  it("test_edgeql_functions_str_split_01", () => {
    assertQueryResult(
      h,
      `SELECT str_split('one, two, three', ', ');`,
      [
            ["one", "two", "three"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT str_split('', ', ');`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `SELECT str_split('foo', ', ');`,
      [
            ["foo"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT str_split('foo', '');`,
      [
            ["f", "o", "o"],
          ]
    );
  });

  it("test_edgeql_functions_to_int_01", () => {
    assertQueryResult(
      h,
      `SELECT to_int64(' 123456789', '999999999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64(' 123,456,789', '999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('     123,456,789', '999,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('123,456,789', 'FM999,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('    +123,456,789', 'S999,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('+    123,456,789', 'SG999,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('+000,123,456,789', 'S099,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('+000,123,456,789', 'SG099,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('+000123456789', 'S099999999999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('  +0123456789', 'S990999999999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('+0123456789', 'FMS990999999999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('<123456789>', '999999999PR');`,
      unorderedSet([-123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('987654321st', 'FM999999999th');`,
      unorderedSet([987654321])
    );
    assertQueryResult(
      h,
      `SELECT to_int64('987654321st', <str>$0);`,
      unorderedSet([987654321])
    );
    expect(() => {
      h.query(
        `SELECT to_int64('1', '')`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_int_02", () => {
    assertQueryResult(
      h,
      `SELECT to_int32(' 123456789', '999999999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32(' 123,456,789', '999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('     123,456,789', '999,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('123,456,789', 'FM999,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('    +123,456,789', 'S999,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('+    123,456,789', 'SG999,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('+000,123,456,789', 'S099,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('+000,123,456,789', 'SG099,999,999,999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('+000123456789', 'S099999999999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('  +0123456789', 'S990999999999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('+0123456789', 'FMS990999999999');`,
      unorderedSet([123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('<123456789>', '999999999PR');`,
      unorderedSet([-123456789])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('987654321st', 'FM999999999th');`,
      unorderedSet([987654321])
    );
    assertQueryResult(
      h,
      `SELECT to_int32('987654321st', <str>$0);`,
      unorderedSet([987654321])
    );
    expect(() => {
      h.query(
        `SELECT to_int32('1', '')`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_int_03", () => {
    assertQueryResult(
      h,
      `SELECT to_int16('12345', '999999999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('12,345', '999,999,999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('     12,345', '999,999,999,999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('12,345', 'FM999,999,999,999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('+12,345', 'S999,999,999,999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('+    12,345', 'SG999,999,999,999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('-000,012,345', 'S099,999,999,999');`,
      unorderedSet([-12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('+000,012,345', 'SG099,999,999,999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('+00012345', 'S099999999999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('  +012345', 'S990999999999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('+012345', 'FMS990999999999');`,
      unorderedSet([12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('<12345>', '999999999PR');`,
      unorderedSet([-12345])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('4321st', 'FM999999999th');`,
      unorderedSet([4321])
    );
    assertQueryResult(
      h,
      `SELECT to_int16('4321st', <str>$0);`,
      unorderedSet([4321])
    );
    expect(() => {
      h.query(
        `SELECT to_int16('1', '')`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_float_01", () => {
    assertQueryResult(
      h,
      `SELECT to_float64(' 123', '999');`,
      unorderedSet([123])
    );
    assertQueryResult(
      h,
      `SELECT to_float64('123.457', '999.999');`,
      unorderedSet([123.457])
    );
    assertQueryResult(
      h,
      `SELECT to_float64(' 123.456789000', '999.999999999');`,
      unorderedSet([123.456789])
    );
    assertQueryResult(
      h,
      `SELECT to_float64('123.456789', 'FM999.999999999');`,
      unorderedSet([123.456789])
    );
    assertQueryResult(
      h,
      `SELECT to_float64('123.456789', <str>$0);`,
      unorderedSet([123.456789])
    );
    expect(() => {
      h.query(
        `SELECT to_float64('1', '')`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_float_02", () => {
    assertQueryResult(
      h,
      `SELECT to_float32(' 123', '999');`,
      unorderedSet([123])
    );
    assertQueryResult(
      h,
      `SELECT to_float32('123.457', '999.999');`,
      unorderedSet([123.457])
    );
    assertQueryResult(
      h,
      `SELECT to_float32(' 123.456789000', '999.999999999');`,
      unorderedSet([123.457])
    );
    assertQueryResult(
      h,
      `SELECT to_float32('123.456789', 'FM999.999999999');`,
      unorderedSet([123.457])
    );
    expect(() => {
      h.query(
        `SELECT to_float32('1', '')`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_bigint_01", () => {
    assertQueryResult(
      h,
      `SELECT to_bigint(' 123', '999');`,
      unorderedSet([123])
    );
    expect(() => {
      h.query(
        `SELECT to_bigint('1', '')`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_bigint_02", () => {
    expect(() => {
      h.query(
        `SELECT to_bigint('1.02')`
      );
    }).toThrow(new RegExp("invalid input syntax"));
  });

  it("test_edgeql_functions_to_decimal_01", () => {
    assertQueryResult(
      h,
      `SELECT to_decimal(' 123', '999');`,
      unorderedSet([123])
    );
    assertQueryResult(
      h,
      `SELECT to_decimal('123.457', '999.999');`,
      unorderedSet([123.457])
    );
    assertQueryResult(
      h,
      `SELECT to_decimal(' 123.456789000', '999.999999999');`,
      unorderedSet([123.456789])
    );
    assertQueryResult(
      h,
      `SELECT to_decimal('123.456789', 'FM999.999999999');`,
      unorderedSet([123.456789])
    );
    expect(() => {
      h.query(
        `SELECT to_decimal('1', '')`
      );
    }).toThrow(new RegExp("\"fmt\" argument must be"));
  });

  it("test_edgeql_functions_to_decimal_02", () => {
    assertQueryResult(
      h,
      `
            SELECT to_decimal(
                '123456789123456789123456789.123456789123456789123456789',
                'FM999999999999999999999999999.999999999999999999999999999');
            `,
      unorderedSet([1.2345678912345679e+26])
    );
  });

  it("test_edgeql_functions_len_01", () => {
    assertQueryResult(
      h,
      `SELECT len('');`,
      [0]
    );
    assertQueryResult(
      h,
      `SELECT len('hello');`,
      [5]
    );
    assertQueryResult(
      h,
      `SELECT __std__::len({'hello', 'world'});`,
      [5, 5]
    );
  });

  it("test_edgeql_functions_len_02", () => {
    assertQueryResult(
      h,
      `SELECT len(b'');`,
      [0]
    );
    assertQueryResult(
      h,
      `SELECT len(b'hello');`,
      [5]
    );
    assertQueryResult(
      h,
      `SELECT len({b'hello', b'world'});`,
      [5, 5]
    );
  });

  it("test_edgeql_functions_len_03", () => {
    assertQueryResult(
      h,
      `SELECT len(<array<str>>[]);`,
      [0]
    );
    assertQueryResult(
      h,
      `SELECT len([]);`,
      [0]
    );
    assertQueryResult(
      h,
      `SELECT len(['hello']);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT len(['hello', 'world']);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT len([1, 2, 3, 4, 5]);`,
      [5]
    );
    assertQueryResult(
      h,
      `SELECT len({['hello'], ['hello', 'world']});`,
      unorderedSet([1, 2])
    );
  });

  it("test_edgeql_functions_min_01 [xerror: Known collation issue on Heroku Postgres]", () => {
    assertQueryResult(
      h,
      `SELECT min(<int64>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT min(4);`,
      [4]
    );
    assertQueryResult(
      h,
      `SELECT min({10, 20, -3, 4});`,
      [-3]
    );
    assertQueryResult(
      h,
      `SELECT min({10, 2.5, -3.1, 4});`,
      [-3.1]
    );
    assertQueryResult(
      h,
      `SELECT min({'10', '20', '-3', '4'});`,
      ["-3"]
    );
    assertQueryResult(
      h,
      `SELECT min({'10', 'hello', 'world', '-3', '4'});`,
      ["-3"]
    );
    assertQueryResult(
      h,
      `SELECT min({'hello', 'world'});`,
      ["hello"]
    );
    assertQueryResult(
      h,
      `SELECT min({[1, 2], [3, 4]});`,
      [
            [1, 2],
          ]
    );
    assertQueryResult(
      h,
      `SELECT min({[1, 2], [3, 4], <array<int64>>[]});`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `SELECT min({[1, 2], [1, 0.4]});`,
      [
            [1, 0.4],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>min(<datetime>{
                    '2018-05-07T15:01:22.306916-05',
                    '2017-05-07T16:01:22.306916-05',
                    '2017-01-07T11:01:22.306916-05',
                    '2018-01-07T11:12:22.306916-05',
                });
            `,
      ["2017-01-07T16:01:22.306916+00:00"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>min(<cal::local_datetime>{
                    '2018-05-07T15:01:22.306916',
                    '2017-05-07T16:01:22.306916',
                    '2017-01-07T11:01:22.306916',
                    '2018-01-07T11:12:22.306916',
                });
            `,
      ["2017-01-07T11:01:22.306916"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>min(<cal::local_date>{
                    '2018-05-07',
                    '2017-05-07',
                    '2017-01-07',
                    '2018-01-07',
                });
            `,
      ["2017-01-07"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>min(<cal::local_time>{
                    '15:01:22',
                    '16:01:22',
                    '11:01:22',
                    '11:12:22',
                });
            `,
      ["11:01:22"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>min(<duration>{
                    '15:01:22',
                    '16:01:22',
                    '11:01:22',
                    '11:12:22',
                });
            `,
      ["PT11H1M22S"]
    );
  });

  it("test_edgeql_functions_min_02", () => {
    assertQueryResult(
      h,
      `
                SELECT min(User.name);
            `,
      ["Elvis"]
    );
    assertQueryResult(
      h,
      `
                SELECT min(Issue.time_estimate);
            `,
      [3000]
    );
    assertQueryResult(
      h,
      `
                SELECT min(<int64>Issue.number);
            `,
      [1]
    );
  });

  it("test_edgeql_functions_min_03", () => {
    assertQueryResult(
      h,
      `
            SELECT min(User).id = min(User.id);
            `,
      [true]
    );
  });

  it("test_edgeql_functions_max_01", () => {
    assertQueryResult(
      h,
      `SELECT max(<int64>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT max(4);`,
      [4]
    );
    assertQueryResult(
      h,
      `SELECT max({10, 20, -3, 4});`,
      [20]
    );
    assertQueryResult(
      h,
      `SELECT max({10, 2.5, -3.1, 4});`,
      [10]
    );
    assertQueryResult(
      h,
      `SELECT max({'10', '20', '-3', '4'});`,
      ["4"]
    );
    assertQueryResult(
      h,
      `SELECT max({'10', 'hello', 'world', '-3', '4'});`,
      ["world"]
    );
    assertQueryResult(
      h,
      `SELECT max({'hello', 'world'});`,
      ["world"]
    );
    assertQueryResult(
      h,
      `SELECT max({[1, 2], [3, 4]});`,
      [
            [3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT max({[1, 2], [3, 4], <array<int64>>[]});`,
      [
            [3, 4],
          ]
    );
    assertQueryResult(
      h,
      `SELECT max({[1, 2], [1, 0.4]});`,
      [
            [1, 2],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>max(<datetime>{
                    '2018-05-07T15:01:22.306916-05',
                    '2017-05-07T16:01:22.306916-05',
                    '2017-01-07T11:01:22.306916-05',
                    '2018-01-07T11:12:22.306916-05',
                });
            `,
      ["2018-05-07T20:01:22.306916+00:00"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>max(<cal::local_datetime>{
                    '2018-05-07T15:01:22.306916',
                    '2017-05-07T16:01:22.306916',
                    '2017-01-07T11:01:22.306916',
                    '2018-01-07T11:12:22.306916',
                });
            `,
      ["2018-05-07T15:01:22.306916"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>max(<cal::local_date>{
                    '2018-05-07',
                    '2017-05-07',
                    '2017-01-07',
                    '2018-01-07',
                });
            `,
      ["2018-05-07"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>max(<cal::local_time>{
                    '15:01:22',
                    '16:01:22',
                    '11:01:22',
                    '11:12:22',
                });
            `,
      ["16:01:22"]
    );
    assertQueryResult(
      h,
      `
                SELECT <str>max(<duration>{
                    '15:01:22',
                    '16:01:22',
                    '11:01:22',
                    '11:12:22',
                });
            `,
      ["PT16H1M22S"]
    );
  });

  it("test_edgeql_functions_max_02", () => {
    assertQueryResult(
      h,
      `
                SELECT max(User.name);
            `,
      ["Yury"]
    );
    assertQueryResult(
      h,
      `
                SELECT max(Issue.time_estimate);
            `,
      [3000]
    );
    assertQueryResult(
      h,
      `
            SELECT max(<int64>Issue.number);
            `,
      [4]
    );
  });

  it("test_edgeql_functions_max_03", () => {
    assertQueryResult(
      h,
      `
            SELECT max(User).id = max(User.id);
            `,
      [true]
    );
  });

  it("test_edgeql_functions_max_04", () => {
    assertQueryResult(
      h,
      `
            select max(array_unpack(array_agg(User))) { name };
            `,
      [
            {
              "name": "str",
            },
          ]
    );
  });

  it("test_edgeql_functions_all_01", () => {
    assertQueryResult(
      h,
      `SELECT all(<bool>{});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT all({True});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT all({False});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT all({True, False, True, False});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT all({1, 2, 3, 4} > 0);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT all({1, -2, 3, 4} > 0);`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT all({0, -1, -2, -3} > 0);`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT all({1, -2, 3, 4} IN {-2, -1, 0, 1, 2, 3, 4});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT all(<int64>{} IN {-2, -1, 0, 1, 2, 3, 4});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT all({1, -2, 3, 4} IN <int64>{});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT all(<int64>{} IN <int64>{});`,
      [true]
    );
  });

  it("test_edgeql_functions_all_02", () => {
    assertQueryResult(
      h,
      `
                SELECT all(len(User.name) = 4);
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
                SELECT all(
                    (
                        FOR I IN {Issue}
                        UNION EXISTS I.time_estimate
                    )
                );
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
                SELECT all(Issue.number != '');
                `,
      [true]
    );
  });

  it("test_edgeql_functions_any_01", () => {
    assertQueryResult(
      h,
      `SELECT any(<bool>{});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT any({True});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT any({False});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT any({True, False, True, False});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT any({1, 2, 3, 4} > 0);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT any({1, -2, 3, 4} > 0);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT any({0, -1, -2, -3} > 0);`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT any({1, -2, 3, 4} IN {-2, -1, 0, 1, 2, 3, 4});`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT any(<int64>{} IN {-2, -1, 0, 1, 2, 3, 4});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT any({1, -2, 3, 4} IN <int64>{});`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT any(<int64>{} IN <int64>{});`,
      [false]
    );
  });

  it("test_edgeql_functions_any_02", () => {
    assertQueryResult(
      h,
      `
                SELECT any(len(User.name) = 4);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT any(
                    (
                        FOR I IN {Issue}
                        UNION EXISTS I.time_estimate
                    )
                );
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT any(Issue.number != '');
            `,
      [true]
    );
  });

  it("test_edgeql_functions_any_03", () => {
    assertQueryResult(
      h,
      `
                SELECT any(len(User.name) = 4) =
                    NOT all(NOT (len(User.name) = 4));
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT any(
                    (
                        FOR I IN {Issue}
                        UNION EXISTS I.time_estimate
                    )
                ) = NOT all(
                    (
                        FOR I IN {Issue}
                        UNION NOT EXISTS I.time_estimate
                    )
                );
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT any(Issue.number != '') = NOT all(Issue.number = '');
            `,
      [true]
    );
  });

  it("test_edgeql_functions_round_01", () => {
    assertQueryResult(
      h,
      `SELECT round(<float64>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>1);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>1);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>1.2);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>-1.2);`,
      [-1]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>1.2);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>-1.2);`,
      [-1]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>-2.5);`,
      [-2]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>-1.5);`,
      [-2]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>-0.5);`,
      [0]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>0.5);`,
      [0]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>1.5);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>2.5);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>-2.5);`,
      [-3]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>-1.5);`,
      [-2]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>-0.5);`,
      [-1]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>0.5);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>1.5);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>2.5);`,
      [3]
    );
  });

  it("test_edgeql_functions_round_02", () => {
    assertQueryResult(
      h,
      `SELECT round(1) IS int64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT round(<float32>1.2) IS float64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT round(<float64>1.2) IS float64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT round(1.2) IS float64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT round(<bigint>1) IS bigint;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>1.2) IS decimal;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>1.2, 0) IS decimal;`,
      [true]
    );
  });

  it("test_edgeql_functions_round_03", () => {
    assertQueryResult(
      h,
      `SELECT round(<decimal>123.456, 10);`,
      [123.456]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>123.456, 3);`,
      [123.456]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>123.456, 2);`,
      [123.46]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>123.456, 1);`,
      [123.5]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>123.456, 0);`,
      [123]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>123.456, -1);`,
      [120]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>123.456, -2);`,
      [100]
    );
    assertQueryResult(
      h,
      `SELECT round(<decimal>123.456, -3);`,
      [0]
    );
  });

  it("test_edgeql_functions_round_04", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := round(<int64>Issue.number / 2)
                ORDER BY _;
            `,
      [0, 1, 2, 2]
    );
    assertQueryResult(
      h,
      `
                SELECT _ := round(<decimal>Issue.number / 2)
                ORDER BY _;
            `,
      [1, 1, 2, 2]
    );
  });

  it("test_edgeql_functions_contains_01", () => {
    assertQueryResult(
      h,
      `SELECT std::contains(<array<int64>>[], {1, 3});`,
      [false, false]
    );
    assertQueryResult(
      h,
      `SELECT contains([1], {1, 3});`,
      [true, false]
    );
    assertQueryResult(
      h,
      `SELECT contains([1, 2], 1);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT contains([1, 2], 3);`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT contains(['a'], <str>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT contains([[1], [2, 3], [4, 5, 6]], [2, 3]);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT contains([[1], [2, 3], [4, 5, 6]], [2]);`,
      [false]
    );
  });

  it("test_edgeql_functions_contains_02", () => {
    assertQueryResult(
      h,
      `
                WITH x := [3, 1, 2]
                SELECT contains(x, 2);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH x := [3, 1, 2]
                SELECT contains(x, 5);
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
                WITH x := [3, 1, 2]
                SELECT contains(x, 5);
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
                WITH x := [[1], [2, 3], [4, 5, 6]]
                SELECT contains(x, [2, 3]);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH x := [[1], [2, 3], [4, 5, 6]]
                SELECT contains(x, [2]);
            `,
      [false]
    );
  });

  it("test_edgeql_functions_contains_03", () => {
    assertQueryResult(
      h,
      `SELECT contains(<str>{}, <str>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT contains(<str>{}, 'a');`,
      []
    );
    assertQueryResult(
      h,
      `SELECT contains('qwerty', <str>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT contains('qwerty', '');`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT contains('qwerty', 'q');`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT contains('qwerty', 'qwe');`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT contains('qwerty', 'we');`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT contains('qwerty', 't');`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT contains('qwerty', 'a');`,
      unorderedSet([false])
    );
    assertQueryResult(
      h,
      `SELECT contains('qwerty', 'azerty');`,
      unorderedSet([false])
    );
  });

  it("test_edgeql_functions_contains_04", () => {
    assertQueryResult(
      h,
      `SELECT contains(<bytes>{}, <bytes>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT contains(<bytes>{}, b'a');`,
      []
    );
    assertQueryResult(
      h,
      `SELECT contains(b'qwerty', <bytes>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT contains(b'qwerty', b't');`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT contains(b'qwerty', b'a');`,
      unorderedSet([false])
    );
    assertQueryResult(
      h,
      `SELECT contains(b'qwerty', b'azerty');`,
      unorderedSet([false])
    );
  });

  it("test_edgeql_functions_contains_05", () => {
    assertQueryResult(
      h,
      `
                SELECT contains(
                    array_agg(User),
                    (SELECT User FILTER .name = 'Elvis')
                )
            `,
      [true]
    );
  });

  it("test_edgeql_functions_find_01", () => {
    assertQueryResult(
      h,
      `SELECT find(<str>{}, <str>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT find(<str>{}, 'a');`,
      []
    );
    assertQueryResult(
      h,
      `SELECT find('qwerty', <str>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT find('qwerty', '');`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT find('qwerty', 'q');`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT find('qwerty', 'qwe');`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT find('qwerty', 'we');`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `SELECT find('qwerty', 't');`,
      unorderedSet([4])
    );
    assertQueryResult(
      h,
      `SELECT find('qwerty', 'a');`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `SELECT find('qwerty', 'azerty');`,
      unorderedSet([-1])
    );
  });

  it("test_edgeql_functions_find_02", () => {
    assertQueryResult(
      h,
      `SELECT find(<bytes>{}, <bytes>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT find(b'qwerty', b'');`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT find(b'qwerty', b'qwe');`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT find(b'qwerty', b'a');`,
      unorderedSet([-1])
    );
  });

  it("test_edgeql_functions_find_03", () => {
    assertQueryResult(
      h,
      `SELECT find(<array<str>>{}, <str>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT find(<array<str>>{}, 'the');`,
      []
    );
    assertQueryResult(
      h,
      `SELECT find(['the', 'quick', 'brown', 'fox'], <str>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT find(<array<str>>[], 'the');`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `SELECT find(['the', 'quick', 'brown', 'fox'], 'the');`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT find(['the', 'quick', 'brown', 'fox'], 'fox');`,
      unorderedSet([3])
    );
    assertQueryResult(
      h,
      `SELECT find(['the', 'quick', 'brown', 'fox'], 'jumps');`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `
                SELECT find(['the', 'quick', 'brown', 'fox',
                             'jumps', 'over', 'the', 'lazy', 'dog'],
                            'the');
            `,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `
                SELECT find(['the', 'quick', 'brown', 'fox',
                             'jumps', 'over', 'the', 'lazy', 'dog'],
                            'the', 1);
            `,
      unorderedSet([6])
    );
    assertQueryResult(
      h,
      `SELECT find(
                [['the', 'quick'], ['brown', 'fox']],
                ['the', 'quick']
            );`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT find(
                [['the', 'quick'], ['brown', 'fox']],
                ['the']
            );`,
      unorderedSet([-1])
    );
  });

  it("test_edgeql_functions_str_case_01", () => {
    assertQueryResult(
      h,
      `SELECT str_lower({'HeLlO', 'WoRlD!', 'ПриВет', 'мИр'});`,
      unorderedSet(["\u043c\u0438\u0440", "\u043f\u0440\u0438\u0432\u0435\u0442", "hello", "world!"])
    );
    assertQueryResult(
      h,
      `SELECT str_upper({'HeLlO', 'WoRlD!'});`,
      unorderedSet(["HELLO", "WORLD!"])
    );
    assertQueryResult(
      h,
      `SELECT str_title({'HeLlO', 'WoRlD!'});`,
      unorderedSet(["Hello", "World!"])
    );
    assertQueryResult(
      h,
      `SELECT str_lower('HeLlO WoRlD!');`,
      unorderedSet(["hello world!"])
    );
    assertQueryResult(
      h,
      `SELECT str_upper('HeLlO WoRlD!');`,
      unorderedSet(["HELLO WORLD!"])
    );
    assertQueryResult(
      h,
      `SELECT str_title('HeLlO WoRlD!');`,
      unorderedSet(["Hello World!"])
    );
  });

  it("test_edgeql_functions_str_pad_01", () => {
    assertQueryResult(
      h,
      `SELECT str_pad_start('Hello', 20);`,
      unorderedSet(["               Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_start('Hello', 20, '>');`,
      unorderedSet([">>>>>>>>>>>>>>>Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_start('Hello', 20, '-->');`,
      unorderedSet(["-->-->-->-->-->Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_end('Hello', 20);`,
      unorderedSet(["Hello               "])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_end('Hello', 20, '<');`,
      unorderedSet(["Hello<<<<<<<<<<<<<<<"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_end('Hello', 20, '<--');`,
      unorderedSet(["Hello<--<--<--<--<--"])
    );
    assertQueryResult(
      h,
      `SELECT str_lpad('Hello', 20);`,
      unorderedSet(["               Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_rpad('Hello', 20);`,
      unorderedSet(["Hello               "])
    );
  });

  it("test_edgeql_functions_str_pad_02", () => {
    assertQueryResult(
      h,
      `SELECT str_pad_start('Hello', 2);`,
      unorderedSet(["He"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_start('Hello', 2, '>');`,
      unorderedSet(["He"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_start('Hello', 2, '-->');`,
      unorderedSet(["He"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_end('Hello', 2);`,
      unorderedSet(["He"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_end('Hello', 2, '<');`,
      unorderedSet(["He"])
    );
    assertQueryResult(
      h,
      `SELECT str_pad_end('Hello', 2, '<--');`,
      unorderedSet(["He"])
    );
  });

  it("test_edgeql_functions_str_pad_03", () => {
    assertQueryResult(
      h,
      `
                FOR l IN {0, 2, 10, 20}
                SELECT len(str_pad_start('Hello', l)) = l;
            `,
      [true, true, true, true]
    );
    assertQueryResult(
      h,
      `
                FOR l IN {0, 2, 10, 20}
                SELECT len(str_pad_end('Hello', l)) = l;
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_str_trim_01", () => {
    assertQueryResult(
      h,
      `SELECT str_trim('    Hello    ');`,
      unorderedSet(["Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_trim_start('    Hello    ');`,
      unorderedSet(["Hello    "])
    );
    assertQueryResult(
      h,
      `SELECT str_trim_end('    Hello    ');`,
      unorderedSet(["    Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_ltrim('    Hello    ');`,
      unorderedSet(["Hello    "])
    );
    assertQueryResult(
      h,
      `SELECT str_rtrim('    Hello    ');`,
      unorderedSet(["    Hello"])
    );
  });

  it("test_edgeql_functions_str_trim_02", () => {
    assertQueryResult(
      h,
      `SELECT str_trim_start('               Hello', ' <->');`,
      unorderedSet(["Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_trim_start('>>>>>>>>>>>>>>>Hello', ' <->');`,
      unorderedSet(["Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_trim_start('-->-->-->-->-->Hello', ' <->');`,
      unorderedSet(["Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_trim_end('Hello               ', ' <->');`,
      unorderedSet(["Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_trim_end('Hello<<<<<<<<<<<<<<<', ' <->');`,
      unorderedSet(["Hello"])
    );
    assertQueryResult(
      h,
      `SELECT str_trim_end('Hello<--<--<--<--<--', ' <->');`,
      unorderedSet(["Hello"])
    );
    assertQueryResult(
      h,
      `
                SELECT str_trim(
                '-->-->-->-->-->Hello<--<--<--<--<--', ' <->');
            `,
      unorderedSet(["Hello"])
    );
  });

  it("test_edgeql_functions_str_repeat_01", () => {
    assertQueryResult(
      h,
      `SELECT str_repeat('', 1);`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `SELECT str_repeat('', 0);`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `SELECT str_repeat('', -1);`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `SELECT str_repeat('a', 1);`,
      unorderedSet(["a"])
    );
    assertQueryResult(
      h,
      `SELECT str_repeat('aa', 3);`,
      unorderedSet(["aaaaaa"])
    );
    assertQueryResult(
      h,
      `SELECT str_repeat('a', 0);`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `SELECT str_repeat('', -1);`,
      unorderedSet([""])
    );
  });

  it("test_edgeql_functions_str_replace_01", () => {
    assertQueryResult(
      h,
      `select str_replace('', '', '');`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `select str_replace('', 'a', 'b');`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `select str_replace('', 'a', '');`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `select str_replace('', '', 'b');`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', '', '');`,
      unorderedSet(["hello world"])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', 'a', 'b');`,
      unorderedSet(["hello world"])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', 'a', '');`,
      unorderedSet(["hello world"])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', '', 'b');`,
      unorderedSet(["hello world"])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', 'o', '0');`,
      unorderedSet(["hell0 w0rld"])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', 'o', 'LETTER_O');`,
      unorderedSet(["hellLETTER_O wLETTER_Orld"])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', 'orl', '');`,
      unorderedSet(["hello wd"])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', 'orl', '-');`,
      unorderedSet(["hello w-d"])
    );
    assertQueryResult(
      h,
      `select str_replace('hello world', 'orl', '...');`,
      unorderedSet(["hello w...d"])
    );
  });

  it("test_edgeql_functions_str_reverse_01", () => {
    assertQueryResult(
      h,
      `select str_reverse('');`,
      unorderedSet([""])
    );
    assertQueryResult(
      h,
      `select str_reverse('a');`,
      unorderedSet(["a"])
    );
    assertQueryResult(
      h,
      `select str_reverse('aa');`,
      unorderedSet(["aa"])
    );
    assertQueryResult(
      h,
      `select str_reverse('hello');`,
      unorderedSet(["olleh"])
    );
  });

  it("test_edgeql_functions_math_abs_01", () => {
    assertQueryResult(
      h,
      `SELECT math::abs(2);`,
      unorderedSet([2])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(-2);`,
      unorderedSet([2])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(2.5);`,
      unorderedSet([2.5])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(-2.5);`,
      unorderedSet([2.5])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(<decimal>2.5);`,
      unorderedSet([2.5])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(<decimal>-2.5);`,
      unorderedSet([2.5])
    );
  });

  it("test_edgeql_functions_math_abs_02", () => {
    assertQueryResult(
      h,
      `SELECT math::abs(<int16>2) IS int16;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(<int32>2) IS int32;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(<int64>2) IS int64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(<float32>2) IS float32;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(<float64>2) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::abs(<decimal>2) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_ceil_01", () => {
    assertQueryResult(
      h,
      `SELECT math::ceil(2);`,
      unorderedSet([2])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(2.5);`,
      unorderedSet([3])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(-2.5);`,
      unorderedSet([-2])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(<decimal>2.5);`,
      unorderedSet([3])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(<decimal>-2.5);`,
      unorderedSet([-2])
    );
  });

  it("test_edgeql_functions_math_ceil_02", () => {
    assertQueryResult(
      h,
      `SELECT math::ceil(<int16>2) IS int64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(<int32>2) IS int64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(<int64>2) IS int64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(<float32>2.5) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(<float64>2.5) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(<bigint>2) IS bigint;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::ceil(<decimal>2.5) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_floor_01", () => {
    assertQueryResult(
      h,
      `SELECT math::floor(2);`,
      unorderedSet([2])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(2.5);`,
      unorderedSet([2])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(-2.5);`,
      unorderedSet([-3])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(<decimal>2.5);`,
      unorderedSet([2])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(<decimal>-2.5);`,
      unorderedSet([-3])
    );
  });

  it("test_edgeql_functions_math_floor_02", () => {
    assertQueryResult(
      h,
      `SELECT math::floor(<int16>2) IS int64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(<int32>2) IS int64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(<int64>2) IS int64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(<float32>2.5) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(<float64>2.5) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(<bigint>2) IS bigint;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::floor(<decimal>2.5) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_exp_01", () => {
    assertQueryResult(
      h,
      `SELECT math::exp(0);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(1);`,
      unorderedSet([2.718281828459045])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(2.0);`,
      unorderedSet([7.38905609893065])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(<decimal>1.0);`,
      unorderedSet([2.718281828459045])
    );
    assertQueryResult(
      h,
      `SELECT math::exp({1, 2, 3});`,
      unorderedSet([2.718281828459045, 20.085536923187668, 7.38905609893065])
    );
  });

  it("test_edgeql_functions_math_exp_02", () => {
    assertQueryResult(
      h,
      `SELECT math::exp(<int64>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(<float64>1.0) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(<decimal>1.0) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_exp_03", () => {
    assertQueryResult(
      h,
      `SELECT math::exp(-1);`,
      unorderedSet([0.36787944117144233])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(-2.0);`,
      unorderedSet([0.1353352832366127])
    );
    expect(() => {
      h.query(
        `SELECT math::exp(1000);`
      );
    }).toThrow(new RegExp("value out of range: overflow"));
    assertQueryResult(
      h,
      `SELECT math::exp(<decimal>1000);`,
      unorderedSet([197007111401704699388887935224332312531693798532384578995280299138506385078244119347497807656302688993096381798752022693598298173054461289923262783660152825232320535169584566756192271567602788071422466826314006855168508653497941660316045367817938092905299728580132869945856470286534375900456564355589156220422320260518826112288638358372248724725214506150418881937494100871264232248436315760560377439930623959705844189509050047074217568])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(<decimal>100);`,
      unorderedSet([2.6881171418161212e+43])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(<float64>'inf');`,
      unorderedSet(["Infinity"])
    );
    assertQueryResult(
      h,
      `SELECT math::exp(<float64>'nan');`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_log_01", () => {
    assertQueryResult(
      h,
      `SELECT math::ln({1, 10, 32});`,
      unorderedSet([0, 2.30258509299405, 3.46573590279973])
    );
    assertQueryResult(
      h,
      `SELECT math::lg({1, 10, 32});`,
      unorderedSet([0, 1, 1.50514997831991])
    );
    assertQueryResult(
      h,
      `SELECT math::log(<decimal>{1, 10, 32}, base := <decimal>2);`,
      unorderedSet([0, 3.321928094887362, 5])
    );
  });

  it("test_edgeql_functions_math_log_02", () => {
    expect(() => {
      h.query(
        `SELECT math::ln(-1)`
      );
    }).toThrow(new RegExp(""));
    expect(() => {
      h.query(
        `SELECT math::lg(-1)`
      );
    }).toThrow(new RegExp(""));
    expect(() => {
      h.query(
        `SELECT math::log(-1, base := 10)`
      );
    }).toThrow(new RegExp(""));
  });

  it("test_edgeql_function_math_sqrt_01", () => {
    assertQueryResult(
      h,
      `SELECT math::sqrt({1, 2, 25});`,
      unorderedSet([1, 1.4142135623730951, 5])
    );
    expect(() => {
      h.query(
        `SELECT math::sqrt(-1)`
      );
    }).toThrow();
  });

  it("test_edgeql_function_math_sqrt_02", () => {
    assertQueryResult(
      h,
      `SELECT math::sqrt({1.0, 2.0, 25.0});`,
      unorderedSet([1.0, 1.4142135623730951, 5.0])
    );
    expect(() => {
      h.query(
        `SELECT math::sqrt(-1.0)`
      );
    }).toThrow();
  });

  it("test_edgeql_function_math_sqrt_03", () => {
    assertQueryResult(
      h,
      `SELECT math::sqrt({1n, 2n, 25n});`,
      unorderedSet([1, 1.4142135623730951, 5])
    );
    expect(() => {
      h.query(
        `SELECT math::sqrt(-1n)`
      );
    }).toThrow();
  });

  it("test_edgeql_functions_math_mean_01", () => {
    assertQueryResult(
      h,
      `SELECT math::mean(1);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::mean(1.5);`,
      unorderedSet([1.5])
    );
    assertQueryResult(
      h,
      `SELECT math::mean({1, 2, 3});`,
      unorderedSet([2.0])
    );
    assertQueryResult(
      h,
      `SELECT math::mean({1, 2, 3, 4});`,
      unorderedSet([2.5])
    );
    assertQueryResult(
      h,
      `SELECT math::mean({0.1, 0.2, 0.3});`,
      unorderedSet([0.2])
    );
    assertQueryResult(
      h,
      `SELECT math::mean({0.1, 0.2, 0.3, 0.4});`,
      unorderedSet([0.25])
    );
  });

  it("test_edgeql_functions_math_mean_02", () => {
    assertQueryResult(
      h,
      `SELECT math::mean(<int16>2) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::mean(<int32>2) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::mean(<int64>2) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::mean(<float32>2) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::mean(<float64>2) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::mean(<decimal>2) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_mean_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    A := {1, 3, 1}
                # the difference between sum and mean * count is due to
                # rounding errors, but it should be small
                SELECT abs(sum(A) - count(A) * mean(A)) < 1e-10;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_mean_04", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    A := <float64>{1, 3, 1}
                # the difference between sum and mean * count is due to
                # rounding errors, but it should be small
                SELECT abs(sum(A) - count(A) * mean(A)) < 1e-10;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_mean_05", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    A := len(default::Named.name)
                # the difference between sum and mean * count is due to
                # rounding errors, but it should be small
                SELECT abs(sum(A) - count(A) * mean(A)) < 1e-10;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_mean_06", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    A := <float64>len(default::Named.name)
                # the difference between sum and mean * count is due to
                # rounding errors, but it should be small
                SELECT abs(sum(A) - count(A) * mean(A)) < 1e-10;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_mean_07", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    A := {3}
                SELECT mean(A) * count(A);
            `,
      unorderedSet([3])
    );
  });

  it("test_edgeql_functions_math_mean_08", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := {1, 2, 3, 4}
                SELECT mean(X) = sum(X) / count(X);
            `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := {0.1, 0.2, 0.3, 0.4}
                SELECT mean(X) = sum(X) / count(X);
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_mean_09", () => {
    expect(() => {
      h.query(
        `
                SELECT math::mean(<int64>{});
            `
      );
    }).toThrow(new RegExp("invalid input to mean\\(\\): not enough elements in input set"));
  });

  it("test_edgeql_functions_math_stddev_01", () => {
    assertQueryResult(
      h,
      `SELECT math::stddev({1, 1});`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev({1, 1, -1, 1});`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev({1, 2, 3});`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev({0.1, 0.1, -0.1, 0.1});`,
      unorderedSet([0.1])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev(<decimal>{0.1, 0.2, 0.3});`,
      unorderedSet([0.1])
    );
  });

  it("test_edgeql_functions_math_stddev_02", () => {
    assertQueryResult(
      h,
      `SELECT math::stddev(<int16>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev(<int32>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev(<int64>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev(<float32>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev(<float64>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev(<decimal>{1, 1}) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_stddev_03", () => {
    expect(() => {
      h.query(
        `
                SELECT math::stddev(<int64>{});
            `
      );
    }).toThrow(new RegExp("invalid input to stddev\\(\\): not enough elements in input set"));
  });

  it("test_edgeql_functions_math_stddev_04", () => {
    expect(() => {
      h.query(
        `
                SELECT math::stddev(1);
            `
      );
    }).toThrow(new RegExp("invalid input to stddev\\(\\): not enough elements in input set"));
  });

  it("test_edgeql_functions_math_stddev_pop_01", () => {
    assertQueryResult(
      h,
      `SELECT math::stddev_pop(1);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop({1, 1, 1});`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop({1, 2, 1, 2});`,
      unorderedSet([0.5])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop({0.1, 0.1, 0.1});`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop({0.1, 0.2, 0.1, 0.2});`,
      unorderedSet([0.05])
    );
  });

  it("test_edgeql_functions_math_stddev_pop_02", () => {
    assertQueryResult(
      h,
      `SELECT math::stddev_pop(<int16>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop(<int32>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop(<int64>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop(<float32>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop(<float64>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::stddev_pop(<decimal>1) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_stddev_pop_04", () => {
    expect(() => {
      h.query(
        `
                SELECT math::stddev_pop(<int64>{});
            `
      );
    }).toThrow(new RegExp("invalid input to stddev_pop\\(\\): not enough elements in input set"));
  });

  it("test_edgeql_functions_math_var_01", () => {
    assertQueryResult(
      h,
      `SELECT math::var({1, 1});`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `SELECT math::var({1, 1, -1, 1});`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::var({1, 2, 3});`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::var({0.1, 0.1, -0.1, 0.1});`,
      unorderedSet([0.01])
    );
    assertQueryResult(
      h,
      `SELECT math::var(<decimal>{0.1, 0.2, 0.3});`,
      unorderedSet([0.01])
    );
  });

  it("test_edgeql_functions_math_var_02", () => {
    assertQueryResult(
      h,
      `SELECT math::var(<int16>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var(<int32>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var(<int64>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var(<float32>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var(<float64>{1, 1}) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var(<decimal>{1, 1}) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_var_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := {1, 1}
                SELECT var(X) = stddev(X) ^ 2;
            `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := {1, 1, -1, 1}
                SELECT var(X) = stddev(X) ^ 2;
            `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := {1, 2, 3}
                SELECT var(X) = stddev(X) ^ 2;
            `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := {0.1, 0.1, -0.1, 0.1}
                SELECT var(X) = stddev(X) ^ 2;
            `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := <decimal>{0.1, 0.2, 0.3}
                SELECT var(X) = stddev(X) ^ 2;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_var_04", () => {
    expect(() => {
      h.query(
        `
                SELECT math::var(<int64>{});
            `
      );
    }).toThrow(new RegExp("invalid input to var\\(\\): not enough elements in input set"));
  });

  it("test_edgeql_functions_math_var_05", () => {
    expect(() => {
      h.query(
        `
                SELECT math::var(1);
            `
      );
    }).toThrow(new RegExp("invalid input to var\\(\\): not enough elements in input set"));
  });

  it("test_edgeql_functions_math_var_pop_01", () => {
    assertQueryResult(
      h,
      `SELECT math::var_pop(1);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop({1, 1, 1});`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop({1, 2, 1, 2});`,
      unorderedSet([0.25])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop({0.1, 0.1, 0.1});`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop({0.1, 0.2, 0.1, 0.2});`,
      unorderedSet([0.0025])
    );
  });

  it("test_edgeql_functions_math_var_pop_02", () => {
    assertQueryResult(
      h,
      `SELECT math::var_pop(<int16>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop(<int32>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop(<int64>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop(<float32>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop(<float64>1) IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::var_pop(<decimal>1) IS decimal;`,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_var_pop_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := {1, 2, 1, 2}
                SELECT abs(var_pop(X) - stddev_pop(X) ^ 2) < 1.0e-15;
            `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE math,
                    X := {0.1, 0.2, 0.1, 0.2}
                SELECT abs(var_pop(X) - stddev_pop(X) ^ 2) < 1.0e-15;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_functions_math_var_pop_04", () => {
    expect(() => {
      h.query(
        `
                SELECT math::var_pop(<int64>{});
            `
      );
    }).toThrow(new RegExp("invalid input to var_pop\\(\\): not enough elements in input set"));
  });

  it("test_edgeql_functions_math_pi_01", () => {
    assertQueryResult(
      h,
      `SELECT math::pi() IS float64;`,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `SELECT math::pi();`,
      unorderedSet([3.141592653589793])
    );
  });

  it("test_edgeql_functions_math_acos_01", () => {
    assertQueryResult(
      h,
      `SELECT math::acos(-1);`,
      unorderedSet([3.141592653589793])
    );
    assertQueryResult(
      h,
      `SELECT math::acos(-math::sqrt(2) / 2);`,
      unorderedSet([2.356194490192345])
    );
    assertQueryResult(
      h,
      `SELECT math::acos(-0.0);`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::acos(0.0);`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::acos(math::sqrt(2) / 2);`,
      unorderedSet([0.7853981633974483])
    );
    assertQueryResult(
      h,
      `WITH x := math::acos(1) SELECT (x, <str>x);`,
      [
            [0.0, "0"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT <str>math::acos(<float64>"NaN");`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_acos_02", () => {
    expect(() => {
      h.query(
        `
                SELECT math::acos(-1.001);
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_acos_03", () => {
    expect(() => {
      h.query(
        `
                SELECT math::acos(1.001);
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_acos_04", () => {
    expect(() => {
      h.query(
        `
                SELECT math::acos(<float64>"-inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_acos_05", () => {
    expect(() => {
      h.query(
        `
                SELECT math::acos(<float64>"inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_asin_01", () => {
    assertQueryResult(
      h,
      `SELECT math::asin(-1);`,
      unorderedSet([-1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::asin(-math::sqrt(2) / 2);`,
      unorderedSet([-0.7853981633974483])
    );
    assertQueryResult(
      h,
      `WITH x := math::asin(-0.0) SELECT (x, <str>x);`,
      [
            [-0.0, "-0"],
          ]
    );
    assertQueryResult(
      h,
      `WITH x := math::asin(0.0) SELECT (x, <str>x);`,
      [
            [0.0, "0"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT math::asin(math::sqrt(2) / 2);`,
      unorderedSet([0.7853981633974483])
    );
    assertQueryResult(
      h,
      `SELECT math::asin(1);`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::asin(<float64>"NaN");`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_asin_02", () => {
    expect(() => {
      h.query(
        `
                SELECT math::asin(-1.001);
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_asin_03", () => {
    expect(() => {
      h.query(
        `
                SELECT math::asin(1.001);
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_asin_04", () => {
    expect(() => {
      h.query(
        `
                SELECT math::asin(<float64>"-inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_asin_05", () => {
    expect(() => {
      h.query(
        `
                SELECT math::asin(<float64>"inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_atan_01", () => {
    assertQueryResult(
      h,
      `SELECT math::atan(<float64>"-inf");`,
      unorderedSet([-1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan(-1000000000);`,
      unorderedSet([-1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan(-math::sqrt(3));`,
      unorderedSet([-1.0471975511965976])
    );
    assertQueryResult(
      h,
      `SELECT math::atan(-1);`,
      unorderedSet([-0.7853981633974483])
    );
    assertQueryResult(
      h,
      `SELECT math::atan(-1 / math::sqrt(3));`,
      unorderedSet([-0.5235987755982988])
    );
    assertQueryResult(
      h,
      `WITH x := math::atan(-0.0) SELECT (x, <str>x);`,
      [
            [-0.0, "-0"],
          ]
    );
    assertQueryResult(
      h,
      `WITH x := math::atan(0.0) SELECT (x, <str>x);`,
      [
            [0.0, "0"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT math::atan(1 / math::sqrt(3));`,
      unorderedSet([0.5235987755982988])
    );
    assertQueryResult(
      h,
      `SELECT math::atan(1);`,
      unorderedSet([0.7853981633974483])
    );
    assertQueryResult(
      h,
      `SELECT math::atan(math::sqrt(3));`,
      unorderedSet([1.0471975511965976])
    );
    assertQueryResult(
      h,
      `SELECT math::atan(1000000000);`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan(<float64>"inf");`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::atan(<float64>"NaN");`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_atan2_01", () => {
    assertQueryResult(
      h,
      `SELECT math::atan2(-0.0, -1);`,
      unorderedSet([-3.141592653589793])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-2, -2);`,
      unorderedSet([-2.356194490192345])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-3, -0.0);`,
      unorderedSet([-1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-4, 0.0);`,
      unorderedSet([-1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-5, 5);`,
      unorderedSet([-0.7853981633974483])
    );
    assertQueryResult(
      h,
      `WITH x := math::atan2(-0.0, 6) SELECT (x, <str>x);`,
      [
            [-0.0, "-0"],
          ]
    );
    assertQueryResult(
      h,
      `WITH x := math::atan2(0.0, 6) SELECT (x, <str>x);`,
      [
            [0.0, "0"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(8, 8);`,
      unorderedSet([0.7853981633974483])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(9, 0.0);`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(10, -0.0);`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(11, -11);`,
      unorderedSet([2.356194490192345])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(0.0, -12);`,
      unorderedSet([3.141592653589793])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-0.0, -0.0);`,
      unorderedSet([-3.141592653589793])
    );
    assertQueryResult(
      h,
      `WITH x := math::atan2(-0.0, 0.0) SELECT (x, <str>x);`,
      [
            [-0.0, "-0"],
          ]
    );
    assertQueryResult(
      h,
      `WITH x := math::atan2(0.0, 0.0) SELECT (x, <str>x);`,
      [
            [0.0, "0"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(0.0, -0.0);`,
      unorderedSet([3.141592653589793])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-0.0, -<float64>"inf");`,
      unorderedSet([-3.141592653589793])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-<float64>"inf", -<float64>"inf");`,
      unorderedSet([-2.356194490192345])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-<float64>"inf", -0.0);`,
      unorderedSet([-1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-<float64>"inf", 0.0);`,
      unorderedSet([-1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(-<float64>"inf", <float64>"inf");`,
      unorderedSet([-0.7853981633974483])
    );
    assertQueryResult(
      h,
      `
            WITH x := math::atan2(-0.0, <float64>"inf")
            SELECT (x, <str>x);
            `,
      [
            [-0.0, "-0"],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH x := math::atan2(0.0, <float64>"inf")
            SELECT (x, <str>x);
            `,
      [
            [0.0, "0"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(<float64>"inf", <float64>"inf");`,
      unorderedSet([0.7853981633974483])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(<float64>"inf", 0.0);`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(<float64>"inf", -0.0);`,
      unorderedSet([1.5707963267948966])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(<float64>"inf", -<float64>"inf");`,
      unorderedSet([2.356194490192345])
    );
    assertQueryResult(
      h,
      `SELECT math::atan2(0.0, -<float64>"inf");`,
      unorderedSet([3.141592653589793])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::atan2(<float64>"NaN", 1);`,
      unorderedSet(["NaN"])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::atan2(1, <float64>"NaN");`,
      unorderedSet(["NaN"])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::atan2(<float64>"NaN", <float64>"NaN");`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_cos_01", () => {
    assertQueryResult(
      h,
      `SELECT math::cos(-math::pi() * 2);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(-math::pi() * 7 / 4);`,
      unorderedSet([0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(-math::pi() * 3 / 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(-math::pi() * 5 / 4);`,
      unorderedSet([-0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(-math::pi());`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(-math::pi() * 3 / 4);`,
      unorderedSet([-0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(-math::pi() / 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(-math::pi() / 4);`,
      unorderedSet([0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(-0.0);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(0.0);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(math::pi() / 4);`,
      unorderedSet([0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(math::pi() / 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(math::pi() * 3 / 4);`,
      unorderedSet([-0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(math::pi());`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(math::pi() * 5 / 4);`,
      unorderedSet([-0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(math::pi() * 3 / 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(math::pi() * 7 / 4);`,
      unorderedSet([0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::cos(math::pi() * 2);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::cos(<float64>"NaN");`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_cos_02", () => {
    expect(() => {
      h.query(
        `
                SELECT math::cos(<float64>"-inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_cos_03", () => {
    expect(() => {
      h.query(
        `
                SELECT math::cos(<float64>"inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_cot_01", () => {
    assertQueryResult(
      h,
      `SELECT math::cot(-math::pi() * 7 / 4);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(-math::pi() * 3 / 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(-math::pi() * 5 / 4);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(-math::pi() * 3 / 4);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(-math::pi() / 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(-math::pi() / 4);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::cot(-0.0);`,
      unorderedSet(["-Infinity"])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::cot(0.0);`,
      unorderedSet(["Infinity"])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(math::pi() / 4);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(math::pi() / 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(math::pi() * 3 / 4);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(math::pi() * 5 / 4);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(math::pi() * 3 / 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::cot(math::pi() * 7 / 4);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::cot(<float64>"NaN");`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_cot_02", () => {
    expect(() => {
      h.query(
        `
                SELECT math::cot(<float64>"-inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_cot_03", () => {
    expect(() => {
      h.query(
        `
                SELECT math::cot(<float64>"inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_sin_01", () => {
    assertQueryResult(
      h,
      `SELECT math::sin(-math::pi() * 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(-math::pi() * 7 / 4);`,
      unorderedSet([0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(-math::pi() * 3 / 2);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(-math::pi() * 5 / 4);`,
      unorderedSet([0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(-math::pi());`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(-math::pi() * 3 / 4);`,
      unorderedSet([-0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(-math::pi() / 2);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(-math::pi() / 4);`,
      unorderedSet([-0.7071067811865476])
    );
    assertQueryResult(
      h,
      `WITH x := math::sin(-0.0) SELECT (x, <str>x);`,
      [
            [-0.0, "-0"],
          ]
    );
    assertQueryResult(
      h,
      `WITH x := math::sin(0.0) SELECT (x, <str>x);`,
      [
            [0.0, "0"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT math::sin(math::pi() / 4);`,
      unorderedSet([0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(math::pi() / 2);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(math::pi() * 3 / 4);`,
      unorderedSet([0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(math::pi());`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(math::pi() * 5 / 4);`,
      unorderedSet([-0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(math::pi() * 3 / 2);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(math::pi() * 7 / 4);`,
      unorderedSet([-0.7071067811865476])
    );
    assertQueryResult(
      h,
      `SELECT math::sin(math::pi() * 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::sin(<float64>"NaN");`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_sin_02", () => {
    expect(() => {
      h.query(
        `
                SELECT math::sin(<float64>"-inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_sin_03", () => {
    expect(() => {
      h.query(
        `
                SELECT math::sin(<float64>"inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_tan_01", () => {
    assertQueryResult(
      h,
      `SELECT math::tan(-math::pi() * 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(-math::pi() * 7 / 4);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(-math::pi() * 5 / 4);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(-math::pi());`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(-math::pi() * 3 / 4);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(-math::pi() / 4);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `WITH x := math::tan(-0.0) SELECT (x, <str>x);`,
      [
            [-0.0, "-0"],
          ]
    );
    assertQueryResult(
      h,
      `WITH x := math::tan(0.0) SELECT (x, <str>x);`,
      [
            [0.0, "0"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT math::tan(math::pi() / 4);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(math::pi() * 3 / 4);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(math::pi());`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(math::pi() * 5 / 4);`,
      unorderedSet([1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(math::pi() * 7 / 4);`,
      unorderedSet([-1.0])
    );
    assertQueryResult(
      h,
      `SELECT math::tan(math::pi() * 2);`,
      unorderedSet([0.0])
    );
    assertQueryResult(
      h,
      `SELECT <str>math::tan(<float64>"NaN");`,
      unorderedSet(["NaN"])
    );
  });

  it("test_edgeql_functions_math_tan_02", () => {
    expect(() => {
      h.query(
        `
                SELECT math::tan(<float64>"-inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions_math_tan_03", () => {
    expect(() => {
      h.query(
        `
                SELECT math::tan(<float64>"inf");
            `
      );
    }).toThrow(new RegExp("input is out of range"));
  });

  it("test_edgeql_functions__genseries_01", () => {
    assertQueryResult(
      h,
      `
            SELECT _gen_series(1, 10)
            `,
      [
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT _gen_series(1, 10, 2)
            `,
      [1, 3, 5, 7, 9]
    );
    assertQueryResult(
      h,
      `
            SELECT _gen_series(1n, 10n)
            `,
      [
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT _gen_series(1n, 10n, 2n)
            `,
      [1, 3, 5, 7, 9]
    );
  });

  it("test_edgeql_functions_sequence_next_reset", () => {
    h.script(
      `
            CREATE SCALAR TYPE my_seq_01 EXTENDING std::sequence;
        `
    );
    let result = h.query("\n            SELECT sequence_next(INTROSPECT my_seq_01)\n        ");
    expect(result).toEqual(1);
    result = h.query("\n            SELECT sequence_next(INTROSPECT my_seq_01)\n        ");
    expect(result).toEqual(2);
    h.script(
      `
            SELECT sequence_reset(INTROSPECT my_seq_01)
        `
    );
    result = h.query("\n            SELECT sequence_next(INTROSPECT my_seq_01)\n        ");
    expect(result).toEqual(1);
    h.script(
      `
            SELECT sequence_reset(INTROSPECT my_seq_01, 20)
        `
    );
    result = h.query("\n            SELECT sequence_next(INTROSPECT my_seq_01)\n        ");
    expect(result).toEqual(21);
  });

  it("test_edgeql_functions__datetime_range_buckets", () => {
    assertQueryResult(
      h,
      `
            SELECT <tuple<str, str>>std::_datetime_range_buckets(
                <datetime>'2021-01-01T00:00:00Z',
                <datetime>'2021-04-01T00:00:00Z',
                '1 month');
            `,
      [
            ["2021-01-01T00:00:00+00:00", "2021-02-01T00:00:00+00:00"],
            ["2021-02-01T00:00:00+00:00", "2021-03-01T00:00:00+00:00"],
            ["2021-03-01T00:00:00+00:00", "2021-04-01T00:00:00+00:00"],
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT <tuple<str, str>>std::_datetime_range_buckets(
                <datetime>'2021-04-01T00:00:00Z',
                <datetime>'2021-04-01T00:00:00Z',
                '1 month');
            `,
      []
    );
    assertQueryResult(
      h,
      `
            SELECT <tuple<str, str>>std::_datetime_range_buckets(
                <datetime>'2021-01-01T00:00:00Z',
                <datetime>'2021-04-01T00:00:00Z',
                '1.5 months');
            `,
      [
            ["2021-01-01T00:00:00+00:00", "2021-02-16T00:00:00+00:00"],
            ["2021-02-16T00:00:00+00:00", "2021-03-31T00:00:00+00:00"],
          ]
    );
  });

  it("test_edgeql_functions_bitwise_01", () => {
    assertQueryResult(
      h,
      `select bit_and(<int16>6, <int16>12);`,
      unorderedSet([4])
    );
    assertQueryResult(
      h,
      `select bit_and(<int32>6, <int32>12);`,
      unorderedSet([4])
    );
    assertQueryResult(
      h,
      `select bit_and(<int64>6, <int64>12);`,
      unorderedSet([4])
    );
  });

  it("test_edgeql_functions_bitwise_02", () => {
    assertQueryResult(
      h,
      `select bit_or(<int16>6, <int16>12);`,
      unorderedSet([14])
    );
    assertQueryResult(
      h,
      `select bit_or(<int32>6, <int32>12);`,
      unorderedSet([14])
    );
    assertQueryResult(
      h,
      `select bit_or(<int64>6, <int64>12);`,
      unorderedSet([14])
    );
  });

  it("test_edgeql_functions_bitwise_03", () => {
    assertQueryResult(
      h,
      `select bit_xor(<int16>6, <int16>12);`,
      unorderedSet([10])
    );
    assertQueryResult(
      h,
      `select bit_xor(<int32>6, <int32>12);`,
      unorderedSet([10])
    );
    assertQueryResult(
      h,
      `select bit_xor(<int64>6, <int64>12);`,
      unorderedSet([10])
    );
  });

  it("test_edgeql_functions_bitwise_04", () => {
    assertQueryResult(
      h,
      `select bit_not(<int16>123);`,
      unorderedSet([-124])
    );
    assertQueryResult(
      h,
      `select bit_not(<int32>123);`,
      unorderedSet([-124])
    );
    assertQueryResult(
      h,
      `select bit_not(<int64>123);`,
      unorderedSet([-124])
    );
  });

  it("test_edgeql_functions_bitwise_05", () => {
    expect(() => {
      h.query(
        `
                    select bit_lshift(<int16>5, -2);
                `
      );
    }).toThrow(new RegExp("bit_lshift.*: cannot shift by negative amount"));
    expect(() => {
      h.query(
        `
                    select bit_lshift(<int32>5, -2);
                `
      );
    }).toThrow(new RegExp("bit_lshift.*: cannot shift by negative amount"));
    expect(() => {
      h.query(
        `
                    select bit_lshift(<int64>5, -2);
                `
      );
    }).toThrow(new RegExp("bit_lshift.*: cannot shift by negative amount"));
    expect(() => {
      h.query(
        `
                    select bit_rshift(<int16>5, -2);
                `
      );
    }).toThrow(new RegExp("bit_rshift.*: cannot shift by negative amount"));
    expect(() => {
      h.query(
        `
                    select bit_rshift(<int32>5, -2);
                `
      );
    }).toThrow(new RegExp("bit_rshift.*: cannot shift by negative amount"));
    expect(() => {
      h.query(
        `
                    select bit_rshift(<int64>5, -2);
                `
      );
    }).toThrow(new RegExp("bit_rshift.*: cannot shift by negative amount"));
  });

  it("test_edgeql_functions_bitwise_06", () => {
    assertQueryResult(
      h,
      `select bit_lshift(<int16>5, 2);`,
      unorderedSet([20])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int16>32767, 15);`,
      unorderedSet([-32768])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int16>32767, 16);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int16>32767, 32);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int16>32767, 40);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int16>1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_lshift(bit_lshift(val, X.0), X.1) =
                   bit_lshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_07", () => {
    assertQueryResult(
      h,
      `select bit_lshift(<int32>5, 2);`,
      unorderedSet([20])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int32>2147483647, 31);`,
      unorderedSet([-2147483648])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int32>2147483647, 32);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int32>2147483647, 40);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int32>1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_lshift(bit_lshift(val, X.0), X.1) =
                   bit_lshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_08", () => {
    assertQueryResult(
      h,
      `select bit_lshift(<int64>5, 2);`,
      unorderedSet([20])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int64>9223372036854775807, 31);`,
      unorderedSet([-2147483648])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int64>9223372036854775807, 63);`,
      unorderedSet([-9223372036854775808])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int64>9223372036854775807, 64);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_lshift(<int64>9223372036854775807, 100);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int64>1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_lshift(bit_lshift(val, X.0), X.1) =
                   bit_lshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_09", () => {
    assertQueryResult(
      h,
      `select bit_rshift(<int16>123, 2);`,
      unorderedSet([30])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>32767, 14);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>32767, 15);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>32767, 16);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>32767, 32);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>32767, 40);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int16>1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_rshift(bit_rshift(val, X.0), X.1) =
                   bit_rshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_10", () => {
    assertQueryResult(
      h,
      `select bit_rshift(<int32>123, 2);`,
      unorderedSet([30])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int32>2147483647, 30);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int32>2147483647, 31);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int32>2147483647, 32);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int32>2147483647, 40);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int32>1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_rshift(bit_rshift(val, X.0), X.1) =
                   bit_rshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_11", () => {
    assertQueryResult(
      h,
      `select bit_rshift(<int64>123, 2);`,
      unorderedSet([30])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int64>9223372036854775807, 62);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int64>9223372036854775807, 63);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int64>9223372036854775807, 64);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int64>9223372036854775807, 90);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int64>1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_rshift(bit_rshift(val, X.0), X.1) =
                   bit_rshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_12", () => {
    assertQueryResult(
      h,
      `select bit_rshift(<int16>-123, 2);`,
      unorderedSet([-31])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>-32768, 14);`,
      unorderedSet([-2])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>-32768, 15);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>-32768, 16);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>-32768, 32);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int16>-32768, 40);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int16>-1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_rshift(bit_rshift(val, X.0), X.1) =
                   bit_rshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_13", () => {
    assertQueryResult(
      h,
      `select bit_rshift(<int32>-123, 2);`,
      unorderedSet([-31])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int32>-2147483648, 30);`,
      unorderedSet([-2])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int32>-2147483648, 31);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int32>-2147483648, 32);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int32>-2147483648, 40);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int32>-1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_rshift(bit_rshift(val, X.0), X.1) =
                   bit_rshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_14", () => {
    assertQueryResult(
      h,
      `select bit_rshift(<int64>-123, 2);`,
      unorderedSet([-31])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int64>-9223372036854775808, 62);`,
      unorderedSet([-2])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int64>-9223372036854775808, 63);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int64>-9223372036854775808, 64);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `select bit_rshift(<int64>-9223372036854775808, 90);`,
      unorderedSet([-1])
    );
    assertQueryResult(
      h,
      `
            with
                val := <int64>-1234,
            for X in {(2, 2), (10, 10), (20, 20), (40, 40)}
            select bit_rshift(bit_rshift(val, X.0), X.1) =
                   bit_rshift(val, X.0 + X.1);
            `,
      [true, true, true, true]
    );
  });

  it("test_edgeql_functions_bitwise_15", () => {
    assertQueryResult(
      h,
      `select bit_count(<int16>0);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_count(<int32>0);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_count(<int64>0);`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_count(<int16>1);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int32>1);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int64>1);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int16>255);`,
      unorderedSet([8])
    );
    assertQueryResult(
      h,
      `select bit_count(<int32>255);`,
      unorderedSet([8])
    );
    assertQueryResult(
      h,
      `select bit_count(<int64>255);`,
      unorderedSet([8])
    );
    assertQueryResult(
      h,
      `select bit_count(<int16>256);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int32>256);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int64>256);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int16>32767);`,
      unorderedSet([15])
    );
    assertQueryResult(
      h,
      `select bit_count(<int32>2147483647);`,
      unorderedSet([31])
    );
    assertQueryResult(
      h,
      `select bit_count(<int64>9223372036854775807);`,
      unorderedSet([63])
    );
    assertQueryResult(
      h,
      `select bit_count(<int16>-32768);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int32>-2147483648);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int64>-9223372036854775808);`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(<int16>-1);`,
      unorderedSet([16])
    );
    assertQueryResult(
      h,
      `select bit_count(<int32>-1);`,
      unorderedSet([32])
    );
    assertQueryResult(
      h,
      `select bit_count(<int64>-1);`,
      unorderedSet([64])
    );
    assertQueryResult(
      h,
      `select bit_count(b'');`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_count(b'\x00');`,
      unorderedSet([0])
    );
    assertQueryResult(
      h,
      `select bit_count(b'\x01');`,
      unorderedSet([1])
    );
    assertQueryResult(
      h,
      `select bit_count(b'\xff');`,
      unorderedSet([8])
    );
    assertQueryResult(
      h,
      `select bit_count(b'\x01\x01');`,
      unorderedSet([2])
    );
    assertQueryResult(
      h,
      `select bit_count(b'\xff\xff');`,
      unorderedSet([16])
    );
    assertQueryResult(
      h,
      `select bit_count(b'\x01\x01\x01\x01');`,
      unorderedSet([4])
    );
    assertQueryResult(
      h,
      `select bit_count(b'\xff\xff\xff\xff');`,
      unorderedSet([32])
    );
  });

  it("test_edgeql_functions_range_contains_01", () => {
    assertQueryResult(
      h,
      `select contains(
                        range(<int32>1, <int32>5),
                        range(<int32>2, <int32>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int32>1, <int32>5),
                        range(<int32>2, <int32>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int32>1, <int32>5),
                        range(<int32>-2, <int32>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int32>1),
                        range(<int32>2, <int32>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int32>1, <int32>5),
                        range(<int32>2));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int64>1, <int64>5),
                        range(<int64>2, <int64>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int64>1, <int64>5),
                        range(<int64>2, <int64>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int64>1, <int64>5),
                        range(<int64>-2, <int64>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int64>1),
                        range(<int64>2, <int64>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<int64>1, <int64>5),
                        range(<int64>2));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float32>1, <float32>5),
                        range(<float32>2, <float32>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float32>1, <float32>5),
                        range(<float32>2, <float32>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float32>1, <float32>5),
                        range(<float32>-2, <float32>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float32>1),
                        range(<float32>2, <float32>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float32>1, <float32>5),
                        range(<float32>2));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float64>1, <float64>5),
                        range(<float64>2, <float64>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float64>1, <float64>5),
                        range(<float64>2, <float64>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float64>1, <float64>5),
                        range(<float64>-2, <float64>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float64>1),
                        range(<float64>2, <float64>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<float64>1, <float64>5),
                        range(<float64>2));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>2, <decimal>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>2, <decimal>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>-2, <decimal>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<decimal>1),
                        range(<decimal>2, <decimal>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>2));`,
      [false]
    );
  });

  it("test_edgeql_functions_range_contains_02", () => {
    assertQueryResult(
      h,
      `select contains(range(<int32>1, <int32>5), <int32>2);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<int32>1, <int32>5), <int32>5);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<int32>1, <int32>5), <int32>15);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<int32>1), <int32>15);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<int32>1), <int32>0);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<int64>1, <int64>5), <int64>2);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<int64>1, <int64>5), <int64>5);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<int64>1, <int64>5), <int64>15);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<int64>1), <int64>15);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<int64>1), <int64>0);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<float32>1, <float32>5), <float32>2);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<float32>1, <float32>5), <float32>5);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<float32>1, <float32>5), <float32>15);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<float32>1), <float32>15);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<float32>1), <float32>0);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<float64>1, <float64>5), <float64>2);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<float64>1, <float64>5), <float64>5);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<float64>1, <float64>5), <float64>15);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<float64>1), <float64>15);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<float64>1), <float64>0);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<decimal>1, <decimal>5), <decimal>2);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<decimal>1, <decimal>5), <decimal>5);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<decimal>1, <decimal>5), <decimal>15);`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(range(<decimal>1), <decimal>15);`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(range(<decimal>1), <decimal>0);`,
      [false]
    );
  });

  it("test_edgeql_functions_range_contains_03", () => {
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z',
                          <datetime>'2022-06-05T00:00:00Z'),
                    range(<datetime>'2022-06-02T00:00:00Z',
                          <datetime>'2022-06-04T00:00:00Z'));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z',
                          <datetime>'2022-06-05T00:00:00Z'),
                    range(<datetime>'2022-06-02T00:00:00Z',
                          <datetime>'2022-06-07T00:00:00Z'));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z',
                          <datetime>'2022-06-05T00:00:00Z'),
                    range(<datetime>'2022-05-29T00:00:00Z',
                          <datetime>'2022-06-04T00:00:00Z'));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z'),
                    range(<datetime>'2022-06-02T00:00:00Z',
                          <datetime>'2022-06-07T00:00:00Z'));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z',
                          <datetime>'2022-06-05T00:00:00Z'),
                    range(<datetime>'2022-06-02T00:00:00Z'));`,
      [false]
    );
  });

  it("test_edgeql_functions_range_contains_04", () => {
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z',
                          <datetime>'2022-06-05T00:00:00Z'),
                    <datetime>'2022-06-02T00:00:00Z');`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z',
                          <datetime>'2022-06-05T00:00:00Z'),
                    <datetime>'2022-06-05T00:00:00Z');`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z',
                          <datetime>'2022-06-05T00:00:00Z'),
                    <datetime>'2022-06-15T00:00:00Z');`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z'),
                    <datetime>'2022-06-15T00:00:00Z');`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<datetime>'2022-06-01T00:00:00Z'),
                    <datetime>'2022-05-31T23:59:59Z');`,
      [false]
    );
  });

  it("test_edgeql_functions_range_contains_05", () => {
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00',
                          <cal::local_datetime>'2022-06-05T00:00:00'),
                    range(<cal::local_datetime>'2022-06-02T00:00:00',
                          <cal::local_datetime>'2022-06-04T00:00:00'));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00',
                          <cal::local_datetime>'2022-06-05T00:00:00'),
                    range(<cal::local_datetime>'2022-06-02T00:00:00',
                          <cal::local_datetime>'2022-06-07T00:00:00'));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00',
                          <cal::local_datetime>'2022-06-05T00:00:00'),
                    range(<cal::local_datetime>'2022-05-29T00:00:00',
                          <cal::local_datetime>'2022-06-04T00:00:00'));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00'),
                    range(<cal::local_datetime>'2022-06-02T00:00:00',
                          <cal::local_datetime>'2022-06-07T00:00:00'));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00',
                          <cal::local_datetime>'2022-06-05T00:00:00'),
                    range(<cal::local_datetime>'2022-06-02T00:00:00'));`,
      [false]
    );
  });

  it("test_edgeql_functions_range_contains_06", () => {
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00',
                          <cal::local_datetime>'2022-06-05T00:00:00'),
                    <cal::local_datetime>'2022-06-02T00:00:00');`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00',
                          <cal::local_datetime>'2022-06-05T00:00:00'),
                    <cal::local_datetime>'2022-06-05T00:00:00');`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00',
                          <cal::local_datetime>'2022-06-05T00:00:00'),
                    <cal::local_datetime>'2022-06-15T00:00:00');`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00'),
                    <cal::local_datetime>'2022-06-15T00:00:00');`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_datetime>'2022-06-01T00:00:00'),
                    <cal::local_datetime>'2022-05-31T23:59:59');`,
      [false]
    );
  });

  it("test_edgeql_functions_range_contains_07", () => {
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-05'),
                    range(<cal::local_date>'2022-06-02',
                          <cal::local_date>'2022-06-04'));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-05'),
                    range(<cal::local_date>'2022-06-02',
                          <cal::local_date>'2022-06-07'));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-05'),
                    range(<cal::local_date>'2022-05-29',
                          <cal::local_date>'2022-06-04'));`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01'),
                    range(<cal::local_date>'2022-06-02',
                          <cal::local_date>'2022-06-07'));`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-05'),
                    range(<cal::local_date>'2022-06-02'));`,
      [false]
    );
  });

  it("test_edgeql_functions_range_contains_08", () => {
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-05'),
                    <cal::local_date>'2022-06-02');`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-05'),
                    <cal::local_date>'2022-06-05');`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-05'),
                    <cal::local_date>'2022-06-15');`,
      [false]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01'),
                    <cal::local_date>'2022-06-15');`,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    range(<cal::local_date>'2022-06-01'),
                    <cal::local_date>'2022-05-31');`,
      [false]
    );
  });

  it("test_edgeql_functions_range_contains_09", () => {
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        multirange([
                            range(<int32>1, <int32>2),
                            range(<int32>8, <int32>10),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        range(<int32>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        <int32>3,
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        multirange([
                            range(<int64>1, <int64>2),
                            range(<int64>8, <int64>10),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        range(<int64>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        <int64>3,
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        multirange([
                            range(<float32>1, <float32>2),
                            range(<float32>8, <float32>10),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        range(<float32>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        <float32>3,
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        multirange([
                            range(<float64>1, <float64>2),
                            range(<float64>8, <float64>10),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        range(<float64>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        <float64>3,
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        multirange([
                            range(<decimal>1, <decimal>2),
                            range(<decimal>8, <decimal>10),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        range(<decimal>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        <decimal>3,
                    )
                `,
      [true]
    );
  });

  it("test_edgeql_functions_range_contains_10", () => {
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<datetime>'2022-06-01T00:00:00Z',
                              <datetime>'2022-06-10T00:00:00Z'),
                        range(<datetime>'2022-06-12T00:00:00Z',
                              <datetime>'2022-06-17T00:00:00Z'),
                        range(<datetime>'2022-06-20T00:00:00Z'),
                    ]),
                    multirange([
                        range(<datetime>'2022-06-01T00:00:00Z',
                              <datetime>'2022-06-05T00:00:00Z'),
                        range(<datetime>'2022-06-21T00:00:00Z',
                              <datetime>'2022-06-22T00:00:00Z'),
                    ]),
                )
            `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<datetime>'2022-06-01T00:00:00Z',
                              <datetime>'2022-06-10T00:00:00Z'),
                        range(<datetime>'2022-06-12T00:00:00Z',
                              <datetime>'2022-06-17T00:00:00Z'),
                        range(<datetime>'2022-06-20T00:00:00Z'),
                    ]),
                    range(<datetime>'2022-06-01T00:00:00Z',
                          <datetime>'2022-06-05T00:00:00Z'),
                )
            `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<datetime>'2022-06-01T00:00:00Z',
                              <datetime>'2022-06-10T00:00:00Z'),
                        range(<datetime>'2022-06-12T00:00:00Z',
                              <datetime>'2022-06-17T00:00:00Z'),
                        range(<datetime>'2022-06-20T00:00:00Z'),
                    ]),
                    <datetime>'2022-06-05T00:00:00Z',
                )
            `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<cal::local_datetime>'2022-06-01T00:00:00',
                              <cal::local_datetime>'2022-06-10T00:00:00'),
                        range(<cal::local_datetime>'2022-06-12T00:00:00',
                              <cal::local_datetime>'2022-06-17T00:00:00'),
                        range(<cal::local_datetime>'2022-06-20T00:00:00'),
                    ]),
                    multirange([
                        range(<cal::local_datetime>'2022-06-01T00:00:00',
                              <cal::local_datetime>'2022-06-05T00:00:00'),
                        range(<cal::local_datetime>'2022-06-21T00:00:00',
                              <cal::local_datetime>'2022-06-22T00:00:00')
                    ]),
                )
            `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<cal::local_datetime>'2022-06-01T00:00:00',
                              <cal::local_datetime>'2022-06-10T00:00:00'),
                        range(<cal::local_datetime>'2022-06-12T00:00:00',
                              <cal::local_datetime>'2022-06-17T00:00:00'),
                        range(<cal::local_datetime>'2022-06-20T00:00:00'),
                    ]),
                    range(<cal::local_datetime>'2022-06-01T00:00:00',
                          <cal::local_datetime>'2022-06-05T00:00:00'),
                )
            `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<cal::local_datetime>'2022-06-01T00:00:00',
                              <cal::local_datetime>'2022-06-10T00:00:00'),
                        range(<cal::local_datetime>'2022-06-12T00:00:00',
                              <cal::local_datetime>'2022-06-17T00:00:00'),
                        range(<cal::local_datetime>'2022-06-20T00:00:00'),
                    ]),
                    <cal::local_datetime>'2022-06-05T00:00:00',
                )
            `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<cal::local_date>'2022-06-01',
                              <cal::local_date>'2022-06-10'),
                        range(<cal::local_date>'2022-06-12',
                              <cal::local_date>'2022-06-17'),
                        range(<cal::local_date>'2022-06-20'),
                    ]),
                    multirange([
                        range(<cal::local_date>'2022-06-01',
                              <cal::local_date>'2022-06-05'),
                        range(<cal::local_date>'2022-06-21',
                              <cal::local_date>'2022-06-22')
                    ]),
                )
            `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<cal::local_date>'2022-06-01',
                              <cal::local_date>'2022-06-10'),
                        range(<cal::local_date>'2022-06-12',
                              <cal::local_date>'2022-06-17'),
                        range(<cal::local_date>'2022-06-20'),
                    ]),
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-05'),
                )
            `,
      [true]
    );
    assertQueryResult(
      h,
      `select contains(
                    multirange([
                        range(<cal::local_date>'2022-06-01',
                              <cal::local_date>'2022-06-10'),
                        range(<cal::local_date>'2022-06-12',
                              <cal::local_date>'2022-06-17'),
                        range(<cal::local_date>'2022-06-20'),
                    ]),
                    <cal::local_date>'2022-06-05',
                )
            `,
      [true]
    );
  });

  it("test_edgeql_functions_range_overlaps_01", () => {
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int32>1, <int32>5),
                        range(<int32>2, <int32>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int32>1, <int32>5),
                        range(<int32>5, <int32>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int32>1, <int32>5),
                        range(<int32>2, <int32>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int32>1),
                        range(<int32>2, <int32>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int32>1, <int32>5),
                        range(<int32>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int32>{}, <int32>5),
                        range(<int32>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int64>1, <int64>5),
                        range(<int64>2, <int64>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int64>1, <int64>5),
                        range(<int64>5, <int64>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int64>1, <int64>5),
                        range(<int64>2, <int64>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int64>1),
                        range(<int64>2, <int64>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int64>1, <int64>5),
                        range(<int64>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<int64>{}, <int64>5),
                        range(<int64>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float32>1, <float32>5),
                        range(<float32>2, <float32>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float32>1, <float32>5),
                        range(<float32>5, <float32>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float32>1, <float32>5),
                        range(<float32>2, <float32>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float32>1),
                        range(<float32>2, <float32>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float32>1, <float32>5),
                        range(<float32>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float32>{}, <float32>5),
                        range(<float32>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float64>1, <float64>5),
                        range(<float64>2, <float64>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float64>1, <float64>5),
                        range(<float64>5, <float64>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float64>1, <float64>5),
                        range(<float64>2, <float64>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float64>1),
                        range(<float64>2, <float64>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float64>1, <float64>5),
                        range(<float64>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<float64>{}, <float64>5),
                        range(<float64>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>2, <decimal>4));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>5, <decimal>7));`,
      [false]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>2, <decimal>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<decimal>1),
                        range(<decimal>2, <decimal>7));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>2));`,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        range(<decimal>{}, <decimal>5),
                        range(<decimal>2));`,
      [true]
    );
  });

  it("test_edgeql_functions_range_overlaps_02", () => {
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        multirange([
                            range(<int32>0, <int32>2),
                            range(<int32>5, <int32>6),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        range(<int32>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        multirange([
                            range(<int64>0, <int64>2),
                            range(<int64>5, <int64>6),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        range(<int64>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        multirange([
                            range(<float32>0, <float32>2),
                            range(<float32>5, <float32>6),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        range(<float32>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        multirange([
                            range(<float64>0, <float64>2),
                            range(<float64>5, <float64>6),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        range(<float64>8),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        multirange([
                            range(<decimal>0, <decimal>2),
                            range(<decimal>5, <decimal>6),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select overlaps(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        range(<decimal>8),
                    )
                `,
      [true]
    );
  });

  it("test_edgeql_functions_range_adjacent_01", () => {
    assertQueryResult(
      h,
      `select adjacent(
                        range(<int32>1, <int32>5),
                        range(<int32>5, <int32>6));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<int32>1, <int32>5),
                        range(<int32>4, <int32>6));`,
      [false]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<int32>1),
                        range(<int32>0, <int32>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<int32>{}, <int32>1),
                        range(<int32>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<int64>1, <int64>5),
                        range(<int64>5, <int64>6));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<int64>1, <int64>5),
                        range(<int64>4, <int64>6));`,
      [false]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<int64>1),
                        range(<int64>0, <int64>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<int64>{}, <int64>1),
                        range(<int64>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<float32>1, <float32>5),
                        range(<float32>5, <float32>6));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<float32>1, <float32>5),
                        range(<float32>4, <float32>6));`,
      [false]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<float32>1),
                        range(<float32>0, <float32>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<float32>{}, <float32>1),
                        range(<float32>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<float64>1, <float64>5),
                        range(<float64>5, <float64>6));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<float64>1, <float64>5),
                        range(<float64>4, <float64>6));`,
      [false]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<float64>1),
                        range(<float64>0, <float64>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<float64>{}, <float64>1),
                        range(<float64>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>5, <decimal>6));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>4, <decimal>6));`,
      [false]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<decimal>1),
                        range(<decimal>0, <decimal>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        range(<decimal>{}, <decimal>1),
                        range(<decimal>1));`,
      [true]
    );
  });

  it("test_edgeql_functions_range_adjacent_02", () => {
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        multirange([
                            range(<int32>-10, <int32>-2),
                            range(<int32>0, <int32>1),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        range(<int32>{}, <int32>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        multirange([
                            range(<int64>-10, <int64>-2),
                            range(<int64>0, <int64>1),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        range(<int64>{}, <int64>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        multirange([
                            range(<float32>-10, <float32>-2),
                            range(<float32>0, <float32>1),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        range(<float32>{}, <float32>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        multirange([
                            range(<float64>-10, <float64>-2),
                            range(<float64>0, <float64>1),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        range(<float64>{}, <float64>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        multirange([
                            range(<decimal>-10, <decimal>-2),
                            range(<decimal>0, <decimal>1),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select adjacent(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        range(<decimal>{}, <decimal>1),
                    )
                `,
      [true]
    );
  });

  it("test_edgeql_functions_range_strictly_below_01", () => {
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int32>1, <int32>4),
                        range(<int32>4, <int32>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int32>1, <int32>4),
                        range(<int32>1, <int32>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int32>2, <int32>3),
                        range(<int32>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int32>1),
                        range(<int32>{}, <int32>10));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int64>1, <int64>4),
                        range(<int64>4, <int64>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int64>1, <int64>4),
                        range(<int64>1, <int64>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int64>2, <int64>3),
                        range(<int64>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int64>1),
                        range(<int64>{}, <int64>10));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float32>1, <float32>4),
                        range(<float32>4, <float32>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float32>1, <float32>4),
                        range(<float32>1, <float32>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float32>2, <float32>3),
                        range(<float32>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float32>1),
                        range(<float32>{}, <float32>10));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float64>1, <float64>4),
                        range(<float64>4, <float64>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float64>1, <float64>4),
                        range(<float64>1, <float64>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float64>2, <float64>3),
                        range(<float64>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float64>1),
                        range(<float64>{}, <float64>10));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<decimal>1, <decimal>4),
                        range(<decimal>4, <decimal>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<decimal>1, <decimal>4),
                        range(<decimal>1, <decimal>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<decimal>2, <decimal>3),
                        range(<decimal>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<decimal>1),
                        range(<decimal>{}, <decimal>10));`,
      [false]
    );
  });

  it("test_edgeql_functions_range_strictly_below_02", () => {
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<int32>-10, <int32>-2),
                            range(<int32>1, <int32>5),
                        ]),
                        multirange([
                            range(<int32>6, <int32>9),
                            range(<int32>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<int32>-10, <int32>-2),
                            range(<int32>1, <int32>5),
                        ]),
                        multirange([
                            range(<int32>2, <int32>9),
                            range(<int32>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int32>{}, <int32>3),
                        multirange([
                            range(<int32>3, <int32>4),
                            range(<int32>7),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        range(<int32>10),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<int64>-10, <int64>-2),
                            range(<int64>1, <int64>5),
                        ]),
                        multirange([
                            range(<int64>6, <int64>9),
                            range(<int64>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<int64>-10, <int64>-2),
                            range(<int64>1, <int64>5),
                        ]),
                        multirange([
                            range(<int64>2, <int64>9),
                            range(<int64>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<int64>{}, <int64>3),
                        multirange([
                            range(<int64>3, <int64>4),
                            range(<int64>7),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        range(<int64>10),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<float32>-10, <float32>-2),
                            range(<float32>1, <float32>5),
                        ]),
                        multirange([
                            range(<float32>6, <float32>9),
                            range(<float32>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<float32>-10, <float32>-2),
                            range(<float32>1, <float32>5),
                        ]),
                        multirange([
                            range(<float32>2, <float32>9),
                            range(<float32>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float32>{}, <float32>3),
                        multirange([
                            range(<float32>3, <float32>4),
                            range(<float32>7),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        range(<float32>10),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<float64>-10, <float64>-2),
                            range(<float64>1, <float64>5),
                        ]),
                        multirange([
                            range(<float64>6, <float64>9),
                            range(<float64>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<float64>-10, <float64>-2),
                            range(<float64>1, <float64>5),
                        ]),
                        multirange([
                            range(<float64>2, <float64>9),
                            range(<float64>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<float64>{}, <float64>3),
                        multirange([
                            range(<float64>3, <float64>4),
                            range(<float64>7),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        range(<float64>10),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<decimal>-10, <decimal>-2),
                            range(<decimal>1, <decimal>5),
                        ]),
                        multirange([
                            range(<decimal>6, <decimal>9),
                            range(<decimal>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<decimal>-10, <decimal>-2),
                            range(<decimal>1, <decimal>5),
                        ]),
                        multirange([
                            range(<decimal>2, <decimal>9),
                            range(<decimal>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        range(<decimal>{}, <decimal>3),
                        multirange([
                            range(<decimal>3, <decimal>4),
                            range(<decimal>7),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_below(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        range(<decimal>10),
                    )
                `,
      [false]
    );
  });

  it("test_edgeql_functions_range_strictly_above_01", () => {
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int32>4, <int32>5),
                        range(<int32>1, <int32>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int32>1, <int32>5),
                        range(<int32>1, <int32>3));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int32>5),
                        range(<int32>2, <int32>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int32>{}, <int32>10),
                        range(<int32>1));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int64>4, <int64>5),
                        range(<int64>1, <int64>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int64>1, <int64>5),
                        range(<int64>1, <int64>3));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int64>5),
                        range(<int64>2, <int64>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int64>{}, <int64>10),
                        range(<int64>1));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float32>4, <float32>5),
                        range(<float32>1, <float32>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float32>1, <float32>5),
                        range(<float32>1, <float32>3));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float32>5),
                        range(<float32>2, <float32>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float32>{}, <float32>10),
                        range(<float32>1));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float64>4, <float64>5),
                        range(<float64>1, <float64>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float64>1, <float64>5),
                        range(<float64>1, <float64>3));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float64>5),
                        range(<float64>2, <float64>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float64>{}, <float64>10),
                        range(<float64>1));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<decimal>4, <decimal>5),
                        range(<decimal>1, <decimal>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>1, <decimal>3));`,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<decimal>5),
                        range(<decimal>2, <decimal>3));`,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<decimal>{}, <decimal>10),
                        range(<decimal>1));`,
      [false]
    );
  });

  it("test_edgeql_functions_range_strictly_above_02", () => {
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<int32>3, <int32>4),
                            range(<int32>7),
                        ]),
                        multirange([
                            range(<int32>-10, <int32>-2),
                            range(<int32>1, <int32>3),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        multirange([
                            range(<int32>-10, <int32>-2),
                            range(<int32>1, <int32>3),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<int32>3, <int32>4),
                            range(<int32>7),
                        ]),
                        range(<int32>{}, <int32>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int32>{}, <int32>10),
                        multirange([
                            range(<int32>3, <int32>4),
                            range(<int32>7),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<int64>3, <int64>4),
                            range(<int64>7),
                        ]),
                        multirange([
                            range(<int64>-10, <int64>-2),
                            range(<int64>1, <int64>3),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        multirange([
                            range(<int64>-10, <int64>-2),
                            range(<int64>1, <int64>3),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<int64>3, <int64>4),
                            range(<int64>7),
                        ]),
                        range(<int64>{}, <int64>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<int64>{}, <int64>10),
                        multirange([
                            range(<int64>3, <int64>4),
                            range(<int64>7),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<float32>3, <float32>4),
                            range(<float32>7),
                        ]),
                        multirange([
                            range(<float32>-10, <float32>-2),
                            range(<float32>1, <float32>3),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        multirange([
                            range(<float32>-10, <float32>-2),
                            range(<float32>1, <float32>3),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<float32>3, <float32>4),
                            range(<float32>7),
                        ]),
                        range(<float32>{}, <float32>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float32>{}, <float32>10),
                        multirange([
                            range(<float32>3, <float32>4),
                            range(<float32>7),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<float64>3, <float64>4),
                            range(<float64>7),
                        ]),
                        multirange([
                            range(<float64>-10, <float64>-2),
                            range(<float64>1, <float64>3),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        multirange([
                            range(<float64>-10, <float64>-2),
                            range(<float64>1, <float64>3),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<float64>3, <float64>4),
                            range(<float64>7),
                        ]),
                        range(<float64>{}, <float64>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<float64>{}, <float64>10),
                        multirange([
                            range(<float64>3, <float64>4),
                            range(<float64>7),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<decimal>3, <decimal>4),
                            range(<decimal>7),
                        ]),
                        multirange([
                            range(<decimal>-10, <decimal>-2),
                            range(<decimal>1, <decimal>3),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        multirange([
                            range(<decimal>-10, <decimal>-2),
                            range(<decimal>1, <decimal>3),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        multirange([
                            range(<decimal>3, <decimal>4),
                            range(<decimal>7),
                        ]),
                        range(<decimal>{}, <decimal>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select strictly_above(
                        range(<decimal>{}, <decimal>10),
                        multirange([
                            range(<decimal>3, <decimal>4),
                            range(<decimal>7),
                        ]),
                    )
                `,
      [false]
    );
  });

  it("test_edgeql_functions_range_bounded_above_01", () => {
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int32>1, <int32>4),
                        range(<int32>4, <int32>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int32>1, <int32>5),
                        range(<int32>2, <int32>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int32>2, <int32>3),
                        range(<int32>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int32>1),
                        range(<int32>{}, <int32>10));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int64>1, <int64>4),
                        range(<int64>4, <int64>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int64>1, <int64>5),
                        range(<int64>2, <int64>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int64>2, <int64>3),
                        range(<int64>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int64>1),
                        range(<int64>{}, <int64>10));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float32>1, <float32>4),
                        range(<float32>4, <float32>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float32>1, <float32>5),
                        range(<float32>2, <float32>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float32>2, <float32>3),
                        range(<float32>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float32>1),
                        range(<float32>{}, <float32>10));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float64>1, <float64>4),
                        range(<float64>4, <float64>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float64>1, <float64>5),
                        range(<float64>2, <float64>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float64>2, <float64>3),
                        range(<float64>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float64>1),
                        range(<float64>{}, <float64>10));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<decimal>1, <decimal>4),
                        range(<decimal>4, <decimal>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<decimal>1, <decimal>5),
                        range(<decimal>2, <decimal>4));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<decimal>2, <decimal>3),
                        range(<decimal>10));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<decimal>1),
                        range(<decimal>{}, <decimal>10));`,
      [false]
    );
  });

  it("test_edgeql_functions_range_bounded_above_02", () => {
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<int32>-10, <int32>-2),
                            range(<int32>1, <int32>5),
                        ]),
                        multirange([
                            range(<int32>6, <int32>9),
                            range(<int32>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<int32>-10, <int32>-2),
                            range(<int32>20),
                        ]),
                        multirange([
                            range(<int32>1, <int32>3),
                            range(<int32>6, <int32>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        range(<int32>10),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int32>{}, <int32>10),
                        multirange([
                            range(<int32>3, <int32>4),
                            range(<int32>7, <int32>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<int64>-10, <int64>-2),
                            range(<int64>1, <int64>5),
                        ]),
                        multirange([
                            range(<int64>6, <int64>9),
                            range(<int64>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<int64>-10, <int64>-2),
                            range(<int64>20),
                        ]),
                        multirange([
                            range(<int64>1, <int64>3),
                            range(<int64>6, <int64>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        range(<int64>10),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<int64>{}, <int64>10),
                        multirange([
                            range(<int64>3, <int64>4),
                            range(<int64>7, <int64>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<float32>-10, <float32>-2),
                            range(<float32>1, <float32>5),
                        ]),
                        multirange([
                            range(<float32>6, <float32>9),
                            range(<float32>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<float32>-10, <float32>-2),
                            range(<float32>20),
                        ]),
                        multirange([
                            range(<float32>1, <float32>3),
                            range(<float32>6, <float32>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        range(<float32>10),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float32>{}, <float32>10),
                        multirange([
                            range(<float32>3, <float32>4),
                            range(<float32>7, <float32>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<float64>-10, <float64>-2),
                            range(<float64>1, <float64>5),
                        ]),
                        multirange([
                            range(<float64>6, <float64>9),
                            range(<float64>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<float64>-10, <float64>-2),
                            range(<float64>20),
                        ]),
                        multirange([
                            range(<float64>1, <float64>3),
                            range(<float64>6, <float64>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        range(<float64>10),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<float64>{}, <float64>10),
                        multirange([
                            range(<float64>3, <float64>4),
                            range(<float64>7, <float64>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<decimal>-10, <decimal>-2),
                            range(<decimal>1, <decimal>5),
                        ]),
                        multirange([
                            range(<decimal>6, <decimal>9),
                            range(<decimal>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<decimal>-10, <decimal>-2),
                            range(<decimal>20),
                        ]),
                        multirange([
                            range(<decimal>1, <decimal>3),
                            range(<decimal>6, <decimal>9),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        range(<decimal>10),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_above(
                        range(<decimal>{}, <decimal>10),
                        multirange([
                            range(<decimal>3, <decimal>4),
                            range(<decimal>7, <decimal>9),
                        ]),
                    )
                `,
      [false]
    );
  });

  it("test_edgeql_functions_range_bounded_below_01", () => {
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int32>1, <int32>4),
                        range(<int32>1, <int32>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int32>1, <int32>4),
                        range(<int32>4, <int32>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int32>2, <int32>3),
                        range(<int32>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int32>{}, <int32>3),
                        range(<int32>1));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int64>1, <int64>4),
                        range(<int64>1, <int64>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int64>1, <int64>4),
                        range(<int64>4, <int64>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int64>2, <int64>3),
                        range(<int64>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int64>{}, <int64>3),
                        range(<int64>1));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float32>1, <float32>4),
                        range(<float32>1, <float32>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float32>1, <float32>4),
                        range(<float32>4, <float32>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float32>2, <float32>3),
                        range(<float32>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float32>{}, <float32>3),
                        range(<float32>1));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float64>1, <float64>4),
                        range(<float64>1, <float64>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float64>1, <float64>4),
                        range(<float64>4, <float64>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float64>2, <float64>3),
                        range(<float64>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float64>{}, <float64>3),
                        range(<float64>1));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<decimal>1, <decimal>4),
                        range(<decimal>1, <decimal>5));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<decimal>1, <decimal>4),
                        range(<decimal>4, <decimal>5));`,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<decimal>2, <decimal>3),
                        range(<decimal>1));`,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<decimal>{}, <decimal>3),
                        range(<decimal>1));`,
      [false]
    );
  });

  it("test_edgeql_functions_range_bounded_below_02", () => {
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<int32>1, <int32>2),
                            range(<int32>4, <int32>7),
                        ]),
                        multirange([
                            range(<int32>0, <int32>9),
                            range(<int32>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<int32>-10, <int32>-2),
                            range(<int32>1, <int32>5),
                        ]),
                        multirange([
                            range(<int32>2, <int32>9),
                            range(<int32>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                        range(<int32>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int32>{}, <int32>3),
                        multirange([
                            range(<int32>1, <int32>4),
                            range(<int32>7),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<int64>1, <int64>2),
                            range(<int64>4, <int64>7),
                        ]),
                        multirange([
                            range(<int64>0, <int64>9),
                            range(<int64>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<int64>-10, <int64>-2),
                            range(<int64>1, <int64>5),
                        ]),
                        multirange([
                            range(<int64>2, <int64>9),
                            range(<int64>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                        range(<int64>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<int64>{}, <int64>3),
                        multirange([
                            range(<int64>1, <int64>4),
                            range(<int64>7),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<float32>1, <float32>2),
                            range(<float32>4, <float32>7),
                        ]),
                        multirange([
                            range(<float32>0, <float32>9),
                            range(<float32>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<float32>-10, <float32>-2),
                            range(<float32>1, <float32>5),
                        ]),
                        multirange([
                            range(<float32>2, <float32>9),
                            range(<float32>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                        range(<float32>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float32>{}, <float32>3),
                        multirange([
                            range(<float32>1, <float32>4),
                            range(<float32>7),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<float64>1, <float64>2),
                            range(<float64>4, <float64>7),
                        ]),
                        multirange([
                            range(<float64>0, <float64>9),
                            range(<float64>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<float64>-10, <float64>-2),
                            range(<float64>1, <float64>5),
                        ]),
                        multirange([
                            range(<float64>2, <float64>9),
                            range(<float64>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                        range(<float64>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<float64>{}, <float64>3),
                        multirange([
                            range(<float64>1, <float64>4),
                            range(<float64>7),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<decimal>1, <decimal>2),
                            range(<decimal>4, <decimal>7),
                        ]),
                        multirange([
                            range(<decimal>0, <decimal>9),
                            range(<decimal>20),
                        ]),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<decimal>-10, <decimal>-2),
                            range(<decimal>1, <decimal>5),
                        ]),
                        multirange([
                            range(<decimal>2, <decimal>9),
                            range(<decimal>20),
                        ]),
                    )
                `,
      [false]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                        range(<decimal>1),
                    )
                `,
      [true]
    );
    assertQueryResult(
      h,
      `select bounded_below(
                        range(<decimal>{}, <decimal>3),
                        multirange([
                            range(<decimal>1, <decimal>4),
                            range(<decimal>7),
                        ]),
                    )
                `,
      [false]
    );
  });

  it("test_edgeql_functions_range_unpack_01", () => {
    assertQueryResult(
      h,
      `select range_unpack(range(<int32>1, <int32>10));`,
      [
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
          ]
    );
    assertQueryResult(
      h,
      `select range_unpack(range(<int64>1, <int64>10));`,
      [
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
          ]
    );
    assertQueryResult(
      h,
      `select range_unpack(range(<int32>1, <int32>10), <int32>3);`,
      [1, 4, 7]
    );
    assertQueryResult(
      h,
      `select range_unpack(range(<int64>1, <int64>10), <int64>3);`,
      [1, 4, 7]
    );
    assertQueryResult(
      h,
      `select range_unpack(range(<float32>1, <float32>10), <float32>3);`,
      [1, 4, 7]
    );
    assertQueryResult(
      h,
      `select range_unpack(range(<float64>1, <float64>10), <float64>3);`,
      [1, 4, 7]
    );
    assertQueryResult(
      h,
      `select range_unpack(range(<decimal>1, <decimal>10), <decimal>3);`,
      [1, 4, 7]
    );
  });

  it("test_edgeql_functions_range_unpack_02", () => {
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<int32>1, <int32>10,
                              inc_lower := true,
                              inc_upper := true),
                        <int32>3
                    );
                `,
      [1, 4, 7, 10]
    );
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<int64>1, <int64>10,
                              inc_lower := true,
                              inc_upper := true),
                        <int64>3
                    );
                `,
      [1, 4, 7, 10]
    );
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<float32>1, <float32>10,
                              inc_lower := true,
                              inc_upper := true),
                        <float32>3
                    );
                `,
      [1, 4, 7, 10]
    );
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<float64>1, <float64>10,
                              inc_lower := true,
                              inc_upper := true),
                        <float64>3
                    );
                `,
      [1, 4, 7, 10]
    );
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<decimal>1, <decimal>10,
                              inc_lower := true,
                              inc_upper := true),
                        <decimal>3
                    );
                `,
      [1, 4, 7, 10]
    );
  });

  it("test_edgeql_functions_range_unpack_03", () => {
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<int32>1, <int32>11,
                              inc_lower := false,
                              inc_upper := false),
                        <int32>3
                    );
                `,
      [2, 5, 8]
    );
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<int64>1, <int64>11,
                              inc_lower := false,
                              inc_upper := false),
                        <int64>3
                    );
                `,
      [2, 5, 8]
    );
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<float32>1, <float32>10,
                              inc_lower := false,
                              inc_upper := false),
                        <float32>3
                    );
                `,
      [4, 7]
    );
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<float64>1, <float64>10,
                              inc_lower := false,
                              inc_upper := false),
                        <float64>3
                    );
                `,
      [4, 7]
    );
    assertQueryResult(
      h,
      `
                    select range_unpack(
                        range(<decimal>1, <decimal>10,
                              inc_lower := false,
                              inc_upper := false),
                        <decimal>3
                    );
                `,
      [4, 7]
    );
  });

  it("test_edgeql_functions_range_unpack_04", () => {
    assertQueryResult(
      h,
      `select <str>range_unpack(
                    range(<datetime>'2022-06-01T07:00:00Z',
                          <datetime>'2022-06-10T07:00:00Z'),
                    <duration>'36:00:00');`,
      ["2022-06-01T07:00:00+00:00", "2022-06-02T19:00:00+00:00", "2022-06-04T07:00:00+00:00", "2022-06-05T19:00:00+00:00", "2022-06-07T07:00:00+00:00", "2022-06-08T19:00:00+00:00"]
    );
    assertQueryResult(
      h,
      `select <str>range_unpack(
                    range(<cal::local_datetime>'2022-06-01T07:00:00',
                          <cal::local_datetime>'2022-06-10T07:00:00'),
                    <cal::relative_duration>'36:00:00');`,
      ["2022-06-01T07:00:00", "2022-06-02T19:00:00", "2022-06-04T07:00:00", "2022-06-05T19:00:00", "2022-06-07T07:00:00", "2022-06-08T19:00:00"]
    );
    assertQueryResult(
      h,
      `select <str>range_unpack(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2022-06-10'));`,
      [
            "2022-06-01",
            "2022-06-02",
            "2022-06-03",
            "2022-06-04",
            "2022-06-05",
            "2022-06-06",
            "2022-06-07",
            "2022-06-08",
            "2022-06-09",
          ]
    );
    assertQueryResult(
      h,
      `select <str>range_unpack(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2023-06-10'),
                    <cal::date_duration>'P1M1D');`,
      [
            "2022-06-01",
            "2022-07-02",
            "2022-08-03",
            "2022-09-04",
            "2022-10-05",
            "2022-11-06",
            "2022-12-07",
            "2023-01-08",
            "2023-02-09",
            "2023-03-10",
            "2023-04-11",
            "2023-05-12",
          ]
    );
  });

  it("test_edgeql_functions_range_unpack_05", () => {
    assertQueryResult(
      h,
      `select <str>range_unpack(
                    range(<datetime>'2022-06-01T07:00:00Z',
                          <datetime>'2022-06-10T07:00:00Z',
                          inc_lower := false,
                          inc_upper := true),
                    <duration>'36:00:00');`,
      ["2022-06-02T19:00:00+00:00", "2022-06-04T07:00:00+00:00", "2022-06-05T19:00:00+00:00", "2022-06-07T07:00:00+00:00", "2022-06-08T19:00:00+00:00", "2022-06-10T07:00:00+00:00"]
    );
    assertQueryResult(
      h,
      `select <str>range_unpack(
                    range(<cal::local_datetime>'2022-06-01T07:00:00',
                          <cal::local_datetime>'2022-06-10T07:00:00',
                          inc_lower := false,
                          inc_upper := true),
                    <cal::relative_duration>'36:00:00');`,
      ["2022-06-02T19:00:00", "2022-06-04T07:00:00", "2022-06-05T19:00:00", "2022-06-07T07:00:00", "2022-06-08T19:00:00", "2022-06-10T07:00:00"]
    );
    assertQueryResult(
      h,
      `select <str>range_unpack(
                    range(<cal::local_date>'2022-06-01',
                          <cal::local_date>'2023-05-13',
                          inc_lower := false,
                          inc_upper := true),
                    <cal::date_duration>'P1M1D');`,
      [
            "2022-06-02",
            "2022-07-03",
            "2022-08-04",
            "2022-09-05",
            "2022-10-06",
            "2022-11-07",
            "2022-12-08",
            "2023-01-09",
            "2023-02-10",
            "2023-03-11",
            "2023-04-12",
            "2023-05-13",
          ]
    );
  });

  it("test_edgeql_functions_range_unpack_06", () => {
    assertQueryResult(
      h,
      `
                select range_unpack(
                    range(<int32>{}, empty := true), <int32>1);
                `,
      []
    );
    assertQueryResult(
      h,
      `
                select range_unpack(
                    range(<int64>{}, empty := true), <int64>1);
                `,
      []
    );
    assertQueryResult(
      h,
      `
                select range_unpack(
                    range(<float32>{}, empty := true), <float32>1);
                `,
      []
    );
    assertQueryResult(
      h,
      `
                select range_unpack(
                    range(<float64>{}, empty := true), <float64>1);
                `,
      []
    );
    assertQueryResult(
      h,
      `
                select range_unpack(
                    range(<decimal>{}, empty := true), <decimal>1);
                `,
      []
    );
    assertQueryResult(
      h,
      `
            select range_unpack(
                range(<datetime>{}, empty := true), <duration>'36:00:00');
            `,
      []
    );
    assertQueryResult(
      h,
      `
            select range_unpack(
                range(<cal::local_datetime>{}, empty := true),
                <cal::relative_duration>'36:00:00');
            `,
      []
    );
    assertQueryResult(
      h,
      `
            select range_unpack(
                range(<cal::local_date>{}, empty := true));
            `,
      []
    );
  });

  it("test_edgeql_functions_range_unpack_07", () => {
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<int32>5), <int32>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<int32>{}, <int32>5), <int32>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<int64>5), <int64>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<int64>{}, <int64>5), <int64>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<float32>5), <float32>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<float32>{}, <float32>5), <float32>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<float64>5), <float64>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<float64>{}, <float64>5), <float64>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<decimal>5), <decimal>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                    select range_unpack(
                        range(<decimal>{}, <decimal>5), <decimal>1);
                `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                select range_unpack(
                    range(<datetime>'2022-06-01T07:00:00Z'),
                    <duration>'36:00:00');
            `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                select range_unpack(
                    range(<datetime>{}, <datetime>'2022-06-01T07:00:00Z'),
                    <duration>'36:00:00');
            `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                select range_unpack(
                    range(<cal::local_datetime>'2022-06-01T07:00:00'),
                    <cal::relative_duration>'36:00:00');
            `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                select range_unpack(
                    range(<cal::local_datetime>{},
                          <cal::local_datetime>'2022-06-01T07:00:00'),
                    <cal::relative_duration>'36:00:00');
            `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                select range_unpack(
                    range(<cal::local_date>'2022-06-01'));
            `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
    expect(() => {
      h.script(
        `
                select range_unpack(
                    range(<cal::local_date>{},
                          <cal::local_date>'2022-06-01'));
            `
      );
    }).toThrow(new RegExp("cannot unpack an unbounded range"));
  });

  it("test_edgeql_functions_multirange_unpack_01", () => {
    assertQueryResult(
      h,
      `select multirange_unpack(
                        multirange([
                            range(<int32>4, <int32>8),
                            range(<int32>0, <int32>2),
                            range(<int32>10),
                        ]),
                    )
                `,
      [
            {
              "lower": 0,
              "inc_lower": true,
              "upper": 2,
              "inc_upper": false,
            },
            {
              "lower": 4,
              "inc_lower": true,
              "upper": 8,
              "inc_upper": false,
            },
            {
              "lower": 10,
              "inc_lower": true,
              "upper": null,
              "inc_upper": false,
            },
          ]
    );
    assertQueryResult(
      h,
      `select multirange_unpack(
                        multirange([
                            range(<int64>4, <int64>8),
                            range(<int64>0, <int64>2),
                            range(<int64>10),
                        ]),
                    )
                `,
      [
            {
              "lower": 0,
              "inc_lower": true,
              "upper": 2,
              "inc_upper": false,
            },
            {
              "lower": 4,
              "inc_lower": true,
              "upper": 8,
              "inc_upper": false,
            },
            {
              "lower": 10,
              "inc_lower": true,
              "upper": null,
              "inc_upper": false,
            },
          ]
    );
    assertQueryResult(
      h,
      `select multirange_unpack(
                        multirange([
                            range(<float32>4, <float32>8),
                            range(<float32>0, <float32>2),
                            range(<float32>10),
                        ]),
                    )
                `,
      [
            {
              "lower": 0,
              "inc_lower": true,
              "upper": 2,
              "inc_upper": false,
            },
            {
              "lower": 4,
              "inc_lower": true,
              "upper": 8,
              "inc_upper": false,
            },
            {
              "lower": 10,
              "inc_lower": true,
              "upper": null,
              "inc_upper": false,
            },
          ]
    );
    assertQueryResult(
      h,
      `select multirange_unpack(
                        multirange([
                            range(<float64>4, <float64>8),
                            range(<float64>0, <float64>2),
                            range(<float64>10),
                        ]),
                    )
                `,
      [
            {
              "lower": 0,
              "inc_lower": true,
              "upper": 2,
              "inc_upper": false,
            },
            {
              "lower": 4,
              "inc_lower": true,
              "upper": 8,
              "inc_upper": false,
            },
            {
              "lower": 10,
              "inc_lower": true,
              "upper": null,
              "inc_upper": false,
            },
          ]
    );
    assertQueryResult(
      h,
      `select multirange_unpack(
                        multirange([
                            range(<decimal>4, <decimal>8),
                            range(<decimal>0, <decimal>2),
                            range(<decimal>10),
                        ]),
                    )
                `,
      [
            {
              "lower": 0,
              "inc_lower": true,
              "upper": 2,
              "inc_upper": false,
            },
            {
              "lower": 4,
              "inc_lower": true,
              "upper": 8,
              "inc_upper": false,
            },
            {
              "lower": 10,
              "inc_lower": true,
              "upper": null,
              "inc_upper": false,
            },
          ]
    );
  });

  it("test_edgeql_functions_encoding_base64_fuzz", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "9SXkE97W7fNl9kzzNtLB1F0gvyxJy7qt6LrEQuYfNO2apYBo3mQh0X+s7wsI4HVKBc4n+DVipxMex1GDYX0nYsOjBpmrM9nX9J6ZbrO33/ANd528GuQX3qKwpQVJlVO06aI+w0JMUGQF/cpr6drG57lpucIz+qlNKCkFpbxOxiPpvCKspBvxY2CyUWZrq5VdUtrgZ1JXXSwEdJMU8E52cYPnnOq+4u+ewcviVtYqBQiWOXzYy4XntU3D8XuQm7MRuANLXUEYbCt0mqyulNdbfmJjlffc5x2Wi8NM4vC6T8IySNvMtFqE8Yf3OMKmIcDBoxhBeEZeH6IYnZCfah4w5gqaIjDVIcdjmUwPQrlm98ymlWCWQ57gLWc+zI4PjhaGnxRvfIJC6Mq1ZMTFzUWYa451/95HiHQKTZdi8zn6F8P1C/0sOqYfwXYnB4dVZ5K3MLs1GBrIop1lcGyA5QU6RXSUAJpQde914YeJ3+df28p/nMLZGPAixy1p2eLqYPzrP4Ytz9DaLaDfDBw0squVzxy2llqOPPMXEYTi6L+7QggUKkicEzYV8JtlDoQ7xFUrDRvsc/f0X4WFXl5ubtm+0+0wx+ughagCVf/ni6xxdDYwDHngYNwUjH7cDjS5bxUi5FHOSVsZIGzBumsCiiVKNBCtwpjL",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "9SXkE97W7fNl9kzzNtLB1F0gvyxJy7qt6LrEQuYfNO2apYBo3mQh0X+s7wsI4HVKBc4n+DVipxMex1GDYX0nYsOjBpmrM9nX9J6ZbrO33/ANd528GuQX3qKwpQVJlVO06aI+w0JMUGQF/cpr6drG57lpucIz+qlNKCkFpbxOxiPpvCKspBvxY2CyUWZrq5VdUtrgZ1JXXSwEdJMU8E52cYPnnOq+4u+ewcviVtYqBQiWOXzYy4XntU3D8XuQm7MRuANLXUEYbCt0mqyulNdbfmJjlffc5x2Wi8NM4vC6T8IySNvMtFqE8Yf3OMKmIcDBoxhBeEZeH6IYnZCfah4w5gqaIjDVIcdjmUwPQrlm98ymlWCWQ57gLWc+zI4PjhaGnxRvfIJC6Mq1ZMTFzUWYa451/95HiHQKTZdi8zn6F8P1C/0sOqYfwXYnB4dVZ5K3MLs1GBrIop1lcGyA5QU6RXSUAJpQde914YeJ3+df28p/nMLZGPAixy1p2eLqYPzrP4Ytz9DaLaDfDBw0squVzxy2llqOPPMXEYTi6L+7QggUKkicEzYV8JtlDoQ7xFUrDRvsc/f0X4WFXl5ubtm+0+0wx+ughagCVf/ni6xxdDYwDHngYNwUjH7cDjS5bxUi5FHOSVsZIGzBumsCiiVKNBCtwpjL",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "9SXkE97W7fNl9kzzNtLB1F0gvyxJy7qt6LrEQuYfNO2apYBo3mQh0X-s7wsI4HVKBc4n-DVipxMex1GDYX0nYsOjBpmrM9nX9J6ZbrO33_ANd528GuQX3qKwpQVJlVO06aI-w0JMUGQF_cpr6drG57lpucIz-qlNKCkFpbxOxiPpvCKspBvxY2CyUWZrq5VdUtrgZ1JXXSwEdJMU8E52cYPnnOq-4u-ewcviVtYqBQiWOXzYy4XntU3D8XuQm7MRuANLXUEYbCt0mqyulNdbfmJjlffc5x2Wi8NM4vC6T8IySNvMtFqE8Yf3OMKmIcDBoxhBeEZeH6IYnZCfah4w5gqaIjDVIcdjmUwPQrlm98ymlWCWQ57gLWc-zI4PjhaGnxRvfIJC6Mq1ZMTFzUWYa451_95HiHQKTZdi8zn6F8P1C_0sOqYfwXYnB4dVZ5K3MLs1GBrIop1lcGyA5QU6RXSUAJpQde914YeJ3-df28p_nMLZGPAixy1p2eLqYPzrP4Ytz9DaLaDfDBw0squVzxy2llqOPPMXEYTi6L-7QggUKkicEzYV8JtlDoQ7xFUrDRvsc_f0X4WFXl5ubtm-0-0wx-ughagCVf_ni6xxdDYwDHngYNwUjH7cDjS5bxUi5FHOSVsZIGzBumsCiiVKNBCtwpjL",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "9SXkE97W7fNl9kzzNtLB1F0gvyxJy7qt6LrEQuYfNO2apYBo3mQh0X-s7wsI4HVKBc4n-DVipxMex1GDYX0nYsOjBpmrM9nX9J6ZbrO33_ANd528GuQX3qKwpQVJlVO06aI-w0JMUGQF_cpr6drG57lpucIz-qlNKCkFpbxOxiPpvCKspBvxY2CyUWZrq5VdUtrgZ1JXXSwEdJMU8E52cYPnnOq-4u-ewcviVtYqBQiWOXzYy4XntU3D8XuQm7MRuANLXUEYbCt0mqyulNdbfmJjlffc5x2Wi8NM4vC6T8IySNvMtFqE8Yf3OMKmIcDBoxhBeEZeH6IYnZCfah4w5gqaIjDVIcdjmUwPQrlm98ymlWCWQ57gLWc-zI4PjhaGnxRvfIJC6Mq1ZMTFzUWYa451_95HiHQKTZdi8zn6F8P1C_0sOqYfwXYnB4dVZ5K3MLs1GBrIop1lcGyA5QU6RXSUAJpQde914YeJ3-df28p_nMLZGPAixy1p2eLqYPzrP4Ytz9DaLaDfDBw0squVzxy2llqOPPMXEYTi6L-7QggUKkicEzYV8JtlDoQ7xFUrDRvsc_f0X4WFXl5ubtm-0-0wx-ughagCVf_ni6xxdDYwDHngYNwUjH7cDjS5bxUi5FHOSVsZIGzBumsCiiVKNBCtwpjL",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "eHyJ/x94G4IOudO0wBmJa+MgFtGQjeynGhljOHHuiFP8f6l/9VYSDl9o/0NwWoDZHiC9XZO3qv+cZLbHIVoOjiwR7hhzMg5OXxOo03S6E457UgCdxeoACby6135ikSnPLKlr",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "eHyJ/x94G4IOudO0wBmJa+MgFtGQjeynGhljOHHuiFP8f6l/9VYSDl9o/0NwWoDZHiC9XZO3qv+cZLbHIVoOjiwR7hhzMg5OXxOo03S6E457UgCdxeoACby6135ikSnPLKlr",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "eHyJ_x94G4IOudO0wBmJa-MgFtGQjeynGhljOHHuiFP8f6l_9VYSDl9o_0NwWoDZHiC9XZO3qv-cZLbHIVoOjiwR7hhzMg5OXxOo03S6E457UgCdxeoACby6135ikSnPLKlr",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "eHyJ_x94G4IOudO0wBmJa-MgFtGQjeynGhljOHHuiFP8f6l_9VYSDl9o_0NwWoDZHiC9XZO3qv-cZLbHIVoOjiwR7hhzMg5OXxOo03S6E457UgCdxeoACby6135ikSnPLKlr",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "GN6T43dHKeYpgjGh6xW64IV/a+s98jOHBvCYUkiNmDXjhb7qZNrDZo/BaAxyP26MnRgUCPIP+BxZFprK+gvScKi/GDLvbmYLzLD/xp8Q297tTjNZ3ctk/iNUzQVokqL7p/WBh9G9YWTdmAAWDJLWuZkpYbH1IHQifrFsWYhM6C0pjQ/E7G2jOhp0u3R9xaJu4J/PUM4UjAigC2ZfOiga8nrwQLLAAfguW38jYGwOIw50cKeMWhnf5FfP4yPbNPZg/I10fovz7nU3oEIVG2C7mCU2V8M6LNDCJkX+rQorG+kT3EOi2GhmINPTcpWh2ewQ6+0h4U2vz24vRaFJiDV2VxI/wVlI6T9Id1gNxTUPs1MDAFyTprsdsMNYJMDrmlS16+GE/6s8EhAQnpoGC7WF+qwBH4mmNweUCqLj481RDwLi4HfHh1/E+it5TOwgudGbC7bH/8p1UAj3I0+9h90McOthwFSj+9krA+xFnJCaM/QU7+3vsj7ccOYaXsSydG8bya8gziXt+3v26mzOfrvsLdTBmHeAHX9NO6eSmmn7vGqIcwlW3WyQ0Y2Qh6e/O3Su/hb9z0JevOdB6MBgaSQd8smhYyY9GqRtCphdFETSIdB2qFCsd4T6CRV/C2WDO3wSZxHo3b21jiAU2AzGbgmCglRIqfoIIrKnwbdhB5TISjTedZ0ZQzcOG9mUCs2NFFRJtrjwLTTL28yNwqUrja2buCP9NM5sxL41+HT0vq3KU3MxlkONdYrS1lZqciyMReQlOEat1oTmuxMHtA4lgjLs6vxJDa2pBue4f/gkqj50eyqpW9B+n63UUi544N68vDFhfsEGExk4CW01AUXlJEEytXYHsFVX+vxSHEm2Pn57S5MCV8yy26P6XO6o4Bxnyn7jwdzekMA8o5c=",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "GN6T43dHKeYpgjGh6xW64IV/a+s98jOHBvCYUkiNmDXjhb7qZNrDZo/BaAxyP26MnRgUCPIP+BxZFprK+gvScKi/GDLvbmYLzLD/xp8Q297tTjNZ3ctk/iNUzQVokqL7p/WBh9G9YWTdmAAWDJLWuZkpYbH1IHQifrFsWYhM6C0pjQ/E7G2jOhp0u3R9xaJu4J/PUM4UjAigC2ZfOiga8nrwQLLAAfguW38jYGwOIw50cKeMWhnf5FfP4yPbNPZg/I10fovz7nU3oEIVG2C7mCU2V8M6LNDCJkX+rQorG+kT3EOi2GhmINPTcpWh2ewQ6+0h4U2vz24vRaFJiDV2VxI/wVlI6T9Id1gNxTUPs1MDAFyTprsdsMNYJMDrmlS16+GE/6s8EhAQnpoGC7WF+qwBH4mmNweUCqLj481RDwLi4HfHh1/E+it5TOwgudGbC7bH/8p1UAj3I0+9h90McOthwFSj+9krA+xFnJCaM/QU7+3vsj7ccOYaXsSydG8bya8gziXt+3v26mzOfrvsLdTBmHeAHX9NO6eSmmn7vGqIcwlW3WyQ0Y2Qh6e/O3Su/hb9z0JevOdB6MBgaSQd8smhYyY9GqRtCphdFETSIdB2qFCsd4T6CRV/C2WDO3wSZxHo3b21jiAU2AzGbgmCglRIqfoIIrKnwbdhB5TISjTedZ0ZQzcOG9mUCs2NFFRJtrjwLTTL28yNwqUrja2buCP9NM5sxL41+HT0vq3KU3MxlkONdYrS1lZqciyMReQlOEat1oTmuxMHtA4lgjLs6vxJDa2pBue4f/gkqj50eyqpW9B+n63UUi544N68vDFhfsEGExk4CW01AUXlJEEytXYHsFVX+vxSHEm2Pn57S5MCV8yy26P6XO6o4Bxnyn7jwdzekMA8o5c",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "GN6T43dHKeYpgjGh6xW64IV_a-s98jOHBvCYUkiNmDXjhb7qZNrDZo_BaAxyP26MnRgUCPIP-BxZFprK-gvScKi_GDLvbmYLzLD_xp8Q297tTjNZ3ctk_iNUzQVokqL7p_WBh9G9YWTdmAAWDJLWuZkpYbH1IHQifrFsWYhM6C0pjQ_E7G2jOhp0u3R9xaJu4J_PUM4UjAigC2ZfOiga8nrwQLLAAfguW38jYGwOIw50cKeMWhnf5FfP4yPbNPZg_I10fovz7nU3oEIVG2C7mCU2V8M6LNDCJkX-rQorG-kT3EOi2GhmINPTcpWh2ewQ6-0h4U2vz24vRaFJiDV2VxI_wVlI6T9Id1gNxTUPs1MDAFyTprsdsMNYJMDrmlS16-GE_6s8EhAQnpoGC7WF-qwBH4mmNweUCqLj481RDwLi4HfHh1_E-it5TOwgudGbC7bH_8p1UAj3I0-9h90McOthwFSj-9krA-xFnJCaM_QU7-3vsj7ccOYaXsSydG8bya8gziXt-3v26mzOfrvsLdTBmHeAHX9NO6eSmmn7vGqIcwlW3WyQ0Y2Qh6e_O3Su_hb9z0JevOdB6MBgaSQd8smhYyY9GqRtCphdFETSIdB2qFCsd4T6CRV_C2WDO3wSZxHo3b21jiAU2AzGbgmCglRIqfoIIrKnwbdhB5TISjTedZ0ZQzcOG9mUCs2NFFRJtrjwLTTL28yNwqUrja2buCP9NM5sxL41-HT0vq3KU3MxlkONdYrS1lZqciyMReQlOEat1oTmuxMHtA4lgjLs6vxJDa2pBue4f_gkqj50eyqpW9B-n63UUi544N68vDFhfsEGExk4CW01AUXlJEEytXYHsFVX-vxSHEm2Pn57S5MCV8yy26P6XO6o4Bxnyn7jwdzekMA8o5c=",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "GN6T43dHKeYpgjGh6xW64IV_a-s98jOHBvCYUkiNmDXjhb7qZNrDZo_BaAxyP26MnRgUCPIP-BxZFprK-gvScKi_GDLvbmYLzLD_xp8Q297tTjNZ3ctk_iNUzQVokqL7p_WBh9G9YWTdmAAWDJLWuZkpYbH1IHQifrFsWYhM6C0pjQ_E7G2jOhp0u3R9xaJu4J_PUM4UjAigC2ZfOiga8nrwQLLAAfguW38jYGwOIw50cKeMWhnf5FfP4yPbNPZg_I10fovz7nU3oEIVG2C7mCU2V8M6LNDCJkX-rQorG-kT3EOi2GhmINPTcpWh2ewQ6-0h4U2vz24vRaFJiDV2VxI_wVlI6T9Id1gNxTUPs1MDAFyTprsdsMNYJMDrmlS16-GE_6s8EhAQnpoGC7WF-qwBH4mmNweUCqLj481RDwLi4HfHh1_E-it5TOwgudGbC7bH_8p1UAj3I0-9h90McOthwFSj-9krA-xFnJCaM_QU7-3vsj7ccOYaXsSydG8bya8gziXt-3v26mzOfrvsLdTBmHeAHX9NO6eSmmn7vGqIcwlW3WyQ0Y2Qh6e_O3Su_hb9z0JevOdB6MBgaSQd8smhYyY9GqRtCphdFETSIdB2qFCsd4T6CRV_C2WDO3wSZxHo3b21jiAU2AzGbgmCglRIqfoIIrKnwbdhB5TISjTedZ0ZQzcOG9mUCs2NFFRJtrjwLTTL28yNwqUrja2buCP9NM5sxL41-HT0vq3KU3MxlkONdYrS1lZqciyMReQlOEat1oTmuxMHtA4lgjLs6vxJDa2pBue4f_gkqj50eyqpW9B-n63UUi544N68vDFhfsEGExk4CW01AUXlJEEytXYHsFVX-vxSHEm2Pn57S5MCV8yy26P6XO6o4Bxnyn7jwdzekMA8o5c",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "7Y2rgjkPJD4pNZfoI55dhrEm4UI3qiEfuyIEnXrlJmK3Kzsqd13vA7uSzQVNxBkUSxKKknCIqCwBYD9sTjKRovVWumXnm2m+kkv3P1Z+4raj+bbOm4Wg9eBovyct4yB7wLDGTbiUbp3Ltys+tgz6xY7rCsP3fpS+GL2jJAxVE5YsOF7QMCIFJtFR9GdG0fXHK2Y2f6VZztCg9yWgdCzhzX8byk4SafmcWp2WNefVmi25Ortmz7oNkZVDIUrdttD/0QvWJSr0+m0g6v/Y9oMVDGeYnBf3RfFwlFCtq+e45sJYjhATdF6puFr0QJoXDxsty4MJ21L+4ZLPiSdBh/hH2ApW9lC0QaDo3VLgLAf6a1WHAtQhNx3z80u1OKTOjTCNjCTcSGtiE4xIgC4ynSPa6bRXJvhn9uxIlvmRYWlK1jarG9PnxATz0xdbFVbYadXkpI2a1RfuHhH6n/7JLjlfzoEHbwc5egwhJoqFz+Z87cDn5xAc/aMHl+ohYcMs1jFfryvwhPs=",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "7Y2rgjkPJD4pNZfoI55dhrEm4UI3qiEfuyIEnXrlJmK3Kzsqd13vA7uSzQVNxBkUSxKKknCIqCwBYD9sTjKRovVWumXnm2m+kkv3P1Z+4raj+bbOm4Wg9eBovyct4yB7wLDGTbiUbp3Ltys+tgz6xY7rCsP3fpS+GL2jJAxVE5YsOF7QMCIFJtFR9GdG0fXHK2Y2f6VZztCg9yWgdCzhzX8byk4SafmcWp2WNefVmi25Ortmz7oNkZVDIUrdttD/0QvWJSr0+m0g6v/Y9oMVDGeYnBf3RfFwlFCtq+e45sJYjhATdF6puFr0QJoXDxsty4MJ21L+4ZLPiSdBh/hH2ApW9lC0QaDo3VLgLAf6a1WHAtQhNx3z80u1OKTOjTCNjCTcSGtiE4xIgC4ynSPa6bRXJvhn9uxIlvmRYWlK1jarG9PnxATz0xdbFVbYadXkpI2a1RfuHhH6n/7JLjlfzoEHbwc5egwhJoqFz+Z87cDn5xAc/aMHl+ohYcMs1jFfryvwhPs",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "7Y2rgjkPJD4pNZfoI55dhrEm4UI3qiEfuyIEnXrlJmK3Kzsqd13vA7uSzQVNxBkUSxKKknCIqCwBYD9sTjKRovVWumXnm2m-kkv3P1Z-4raj-bbOm4Wg9eBovyct4yB7wLDGTbiUbp3Ltys-tgz6xY7rCsP3fpS-GL2jJAxVE5YsOF7QMCIFJtFR9GdG0fXHK2Y2f6VZztCg9yWgdCzhzX8byk4SafmcWp2WNefVmi25Ortmz7oNkZVDIUrdttD_0QvWJSr0-m0g6v_Y9oMVDGeYnBf3RfFwlFCtq-e45sJYjhATdF6puFr0QJoXDxsty4MJ21L-4ZLPiSdBh_hH2ApW9lC0QaDo3VLgLAf6a1WHAtQhNx3z80u1OKTOjTCNjCTcSGtiE4xIgC4ynSPa6bRXJvhn9uxIlvmRYWlK1jarG9PnxATz0xdbFVbYadXkpI2a1RfuHhH6n_7JLjlfzoEHbwc5egwhJoqFz-Z87cDn5xAc_aMHl-ohYcMs1jFfryvwhPs=",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "7Y2rgjkPJD4pNZfoI55dhrEm4UI3qiEfuyIEnXrlJmK3Kzsqd13vA7uSzQVNxBkUSxKKknCIqCwBYD9sTjKRovVWumXnm2m-kkv3P1Z-4raj-bbOm4Wg9eBovyct4yB7wLDGTbiUbp3Ltys-tgz6xY7rCsP3fpS-GL2jJAxVE5YsOF7QMCIFJtFR9GdG0fXHK2Y2f6VZztCg9yWgdCzhzX8byk4SafmcWp2WNefVmi25Ortmz7oNkZVDIUrdttD_0QvWJSr0-m0g6v_Y9oMVDGeYnBf3RfFwlFCtq-e45sJYjhATdF6puFr0QJoXDxsty4MJ21L-4ZLPiSdBh_hH2ApW9lC0QaDo3VLgLAf6a1WHAtQhNx3z80u1OKTOjTCNjCTcSGtiE4xIgC4ynSPa6bRXJvhn9uxIlvmRYWlK1jarG9PnxATz0xdbFVbYadXkpI2a1RfuHhH6n_7JLjlfzoEHbwc5egwhJoqFz-Z87cDn5xAc_aMHl-ohYcMs1jFfryvwhPs",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "twFBBE69LpA8uNlY75mslhbuuo8jET+1ISqOJMVaPjY1osruSDa/FZg3/PpERMnhGqxeAsh0HeH9wGbU+ZjGIjbSleHkCDhPm9ExfdXVNbeAdTNRurOSoulkWWtJXVHDoUnuxbNoL0E5QtIZFDfVhdQ3v89iZkiCXX9+tD/uWPEDyBFAmnGWjMcLKBWbOilQJOnDZtyOJvOAX/dtR01MFwxIzviH/gI23jPhyLIlgPd1loQef7O1vmK14d0+WW8WtVePW+mhlfDl3adfZKYYdx7tjsFd7yJF8IzidVtwf9SZ6IkxnAD1CleRXXnnS+9vQyXBR3vkTo8UFsXbdOjWBn+GzKcS+gq8eXzXFV0QFMuLhYz1aV0s4V4OJDrspnuqiHIGn14jcA/llzpTg4PCprLmbaWHrkBAgk7vKmPmdsubFfGY9wjDpICcpaojAiOGcg1438YeEy1vgV/U1C8RUL4QwxlzarV2XfJsUTwLEPjMKhvtt31gZGk8jx5rn6qYIdIk+AqGjM2L/D65HlFteNz62ELsdJTuDA8990psJzmBCTrc8oSrZKn1vMRW9RnazpACboqmoMruRh6GoR+XwmZWrxnTaepMnNITFWuKxVSdFrPFjK4Wl/NnXgyElPKcp2TvOkoxE+nQ9z9I4BAucD4h6ueI2vX/t9vA+9FsJVy7o8JgT84gOAek9oMJXaxAWpxWauFBGxx3h//FifzjWiis6IdBmfYaRRy/CuVzggWYdN7PCtOjA+SNCGsJqbSpl8KgJA==",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "twFBBE69LpA8uNlY75mslhbuuo8jET+1ISqOJMVaPjY1osruSDa/FZg3/PpERMnhGqxeAsh0HeH9wGbU+ZjGIjbSleHkCDhPm9ExfdXVNbeAdTNRurOSoulkWWtJXVHDoUnuxbNoL0E5QtIZFDfVhdQ3v89iZkiCXX9+tD/uWPEDyBFAmnGWjMcLKBWbOilQJOnDZtyOJvOAX/dtR01MFwxIzviH/gI23jPhyLIlgPd1loQef7O1vmK14d0+WW8WtVePW+mhlfDl3adfZKYYdx7tjsFd7yJF8IzidVtwf9SZ6IkxnAD1CleRXXnnS+9vQyXBR3vkTo8UFsXbdOjWBn+GzKcS+gq8eXzXFV0QFMuLhYz1aV0s4V4OJDrspnuqiHIGn14jcA/llzpTg4PCprLmbaWHrkBAgk7vKmPmdsubFfGY9wjDpICcpaojAiOGcg1438YeEy1vgV/U1C8RUL4QwxlzarV2XfJsUTwLEPjMKhvtt31gZGk8jx5rn6qYIdIk+AqGjM2L/D65HlFteNz62ELsdJTuDA8990psJzmBCTrc8oSrZKn1vMRW9RnazpACboqmoMruRh6GoR+XwmZWrxnTaepMnNITFWuKxVSdFrPFjK4Wl/NnXgyElPKcp2TvOkoxE+nQ9z9I4BAucD4h6ueI2vX/t9vA+9FsJVy7o8JgT84gOAek9oMJXaxAWpxWauFBGxx3h//FifzjWiis6IdBmfYaRRy/CuVzggWYdN7PCtOjA+SNCGsJqbSpl8KgJA",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "twFBBE69LpA8uNlY75mslhbuuo8jET-1ISqOJMVaPjY1osruSDa_FZg3_PpERMnhGqxeAsh0HeH9wGbU-ZjGIjbSleHkCDhPm9ExfdXVNbeAdTNRurOSoulkWWtJXVHDoUnuxbNoL0E5QtIZFDfVhdQ3v89iZkiCXX9-tD_uWPEDyBFAmnGWjMcLKBWbOilQJOnDZtyOJvOAX_dtR01MFwxIzviH_gI23jPhyLIlgPd1loQef7O1vmK14d0-WW8WtVePW-mhlfDl3adfZKYYdx7tjsFd7yJF8IzidVtwf9SZ6IkxnAD1CleRXXnnS-9vQyXBR3vkTo8UFsXbdOjWBn-GzKcS-gq8eXzXFV0QFMuLhYz1aV0s4V4OJDrspnuqiHIGn14jcA_llzpTg4PCprLmbaWHrkBAgk7vKmPmdsubFfGY9wjDpICcpaojAiOGcg1438YeEy1vgV_U1C8RUL4QwxlzarV2XfJsUTwLEPjMKhvtt31gZGk8jx5rn6qYIdIk-AqGjM2L_D65HlFteNz62ELsdJTuDA8990psJzmBCTrc8oSrZKn1vMRW9RnazpACboqmoMruRh6GoR-XwmZWrxnTaepMnNITFWuKxVSdFrPFjK4Wl_NnXgyElPKcp2TvOkoxE-nQ9z9I4BAucD4h6ueI2vX_t9vA-9FsJVy7o8JgT84gOAek9oMJXaxAWpxWauFBGxx3h__FifzjWiis6IdBmfYaRRy_CuVzggWYdN7PCtOjA-SNCGsJqbSpl8KgJA==",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "twFBBE69LpA8uNlY75mslhbuuo8jET-1ISqOJMVaPjY1osruSDa_FZg3_PpERMnhGqxeAsh0HeH9wGbU-ZjGIjbSleHkCDhPm9ExfdXVNbeAdTNRurOSoulkWWtJXVHDoUnuxbNoL0E5QtIZFDfVhdQ3v89iZkiCXX9-tD_uWPEDyBFAmnGWjMcLKBWbOilQJOnDZtyOJvOAX_dtR01MFwxIzviH_gI23jPhyLIlgPd1loQef7O1vmK14d0-WW8WtVePW-mhlfDl3adfZKYYdx7tjsFd7yJF8IzidVtwf9SZ6IkxnAD1CleRXXnnS-9vQyXBR3vkTo8UFsXbdOjWBn-GzKcS-gq8eXzXFV0QFMuLhYz1aV0s4V4OJDrspnuqiHIGn14jcA_llzpTg4PCprLmbaWHrkBAgk7vKmPmdsubFfGY9wjDpICcpaojAiOGcg1438YeEy1vgV_U1C8RUL4QwxlzarV2XfJsUTwLEPjMKhvtt31gZGk8jx5rn6qYIdIk-AqGjM2L_D65HlFteNz62ELsdJTuDA8990psJzmBCTrc8oSrZKn1vMRW9RnazpACboqmoMruRh6GoR-XwmZWrxnTaepMnNITFWuKxVSdFrPFjK4Wl_NnXgyElPKcp2TvOkoxE-nQ9z9I4BAucD4h6ueI2vX_t9vA-9FsJVy7o8JgT84gOAek9oMJXaxAWpxWauFBGxx3h__FifzjWiis6IdBmfYaRRy_CuVzggWYdN7PCtOjA-SNCGsJqbSpl8KgJA",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "jPYfkw==",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "jPYfkw",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "jPYfkw==",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "jPYfkw",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "Ohw11dREPcn75pIIiwg/YSP0vyiTAgZZOHTw9JygWXPqbtOSGbBzLDrKr32Wexs2PXU9V4TJwDmb7K8Mz7CcZRx7UCeJh7spFE0t9ZFzCOSrtlGYgCnzIw==",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "Ohw11dREPcn75pIIiwg/YSP0vyiTAgZZOHTw9JygWXPqbtOSGbBzLDrKr32Wexs2PXU9V4TJwDmb7K8Mz7CcZRx7UCeJh7spFE0t9ZFzCOSrtlGYgCnzIw",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "Ohw11dREPcn75pIIiwg_YSP0vyiTAgZZOHTw9JygWXPqbtOSGbBzLDrKr32Wexs2PXU9V4TJwDmb7K8Mz7CcZRx7UCeJh7spFE0t9ZFzCOSrtlGYgCnzIw==",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "Ohw11dREPcn75pIIiwg_YSP0vyiTAgZZOHTw9JygWXPqbtOSGbBzLDrKr32Wexs2PXU9V4TJwDmb7K8Mz7CcZRx7UCeJh7spFE0t9ZFzCOSrtlGYgCnzIw",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "CCyT4heZf8bTLQek8vG6vk/Chigjih5vJnURXlCHF8EBqfKJtLHlVtdkJEnsY+yYXUAp6lakfNLEPM0Sqzu4uVzCZy/ywsgac//sCSVrWmiPr1gFCN7FqLiZT4y3+kV4moDidwK92O4JtBjB+FVVgcx40SyYk7CHoEhRA4U4UKf0a1RVR0ko8tdWR/iDX1Ipwmss2nMLxWncSJmBYFXm4zdwZSYKfDj3SJH/oKURFv3YLHPnesGjwOng9ZPFG63QdzSGJNuqk+8HPdFc66Tz9wvHMOuhQ4YmwYfDX2CdhiiA2InjgWE9xmw8K0pR3aEwKuvQ0jUJppveN+VQ3g==",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "CCyT4heZf8bTLQek8vG6vk/Chigjih5vJnURXlCHF8EBqfKJtLHlVtdkJEnsY+yYXUAp6lakfNLEPM0Sqzu4uVzCZy/ywsgac//sCSVrWmiPr1gFCN7FqLiZT4y3+kV4moDidwK92O4JtBjB+FVVgcx40SyYk7CHoEhRA4U4UKf0a1RVR0ko8tdWR/iDX1Ipwmss2nMLxWncSJmBYFXm4zdwZSYKfDj3SJH/oKURFv3YLHPnesGjwOng9ZPFG63QdzSGJNuqk+8HPdFc66Tz9wvHMOuhQ4YmwYfDX2CdhiiA2InjgWE9xmw8K0pR3aEwKuvQ0jUJppveN+VQ3g",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "CCyT4heZf8bTLQek8vG6vk_Chigjih5vJnURXlCHF8EBqfKJtLHlVtdkJEnsY-yYXUAp6lakfNLEPM0Sqzu4uVzCZy_ywsgac__sCSVrWmiPr1gFCN7FqLiZT4y3-kV4moDidwK92O4JtBjB-FVVgcx40SyYk7CHoEhRA4U4UKf0a1RVR0ko8tdWR_iDX1Ipwmss2nMLxWncSJmBYFXm4zdwZSYKfDj3SJH_oKURFv3YLHPnesGjwOng9ZPFG63QdzSGJNuqk-8HPdFc66Tz9wvHMOuhQ4YmwYfDX2CdhiiA2InjgWE9xmw8K0pR3aEwKuvQ0jUJppveN-VQ3g==",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "CCyT4heZf8bTLQek8vG6vk_Chigjih5vJnURXlCHF8EBqfKJtLHlVtdkJEnsY-yYXUAp6lakfNLEPM0Sqzu4uVzCZy_ywsgac__sCSVrWmiPr1gFCN7FqLiZT4y3-kV4moDidwK92O4JtBjB-FVVgcx40SyYk7CHoEhRA4U4UKf0a1RVR0ko8tdWR_iDX1Ipwmss2nMLxWncSJmBYFXm4zdwZSYKfDj3SJH_oKURFv3YLHPnesGjwOng9ZPFG63QdzSGJNuqk-8HPdFc66Tz9wvHMOuhQ4YmwYfDX2CdhiiA2InjgWE9xmw8K0pR3aEwKuvQ0jUJppveN-VQ3g",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "Mw8H1Z1VRlpgiRgX4m3D0GmZ95wKWLC4HAiGeeqMb8mnbCTAJfaLVfZl2/3v+3WjGgnHg9Z9k7ggWUrmF7IxubATCULiWS90HDnFW7w//UwfiLbJikaJy5gD8x1PlozM/DtNzsqUn8WQXP5J4Uk9GePS361IuZ+gkjEKG7i2FC3jRMjc4DxtbeKOTuCGjl2gcruuWIpAFo+sFKxPAQEJHI82bph9ZFQrYYImpWEfimm5SSQdbrpHI1nrGYLyLGHRi6vQaUle5bystxsdiSq8cihtzG5Nb5I=",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "Mw8H1Z1VRlpgiRgX4m3D0GmZ95wKWLC4HAiGeeqMb8mnbCTAJfaLVfZl2/3v+3WjGgnHg9Z9k7ggWUrmF7IxubATCULiWS90HDnFW7w//UwfiLbJikaJy5gD8x1PlozM/DtNzsqUn8WQXP5J4Uk9GePS361IuZ+gkjEKG7i2FC3jRMjc4DxtbeKOTuCGjl2gcruuWIpAFo+sFKxPAQEJHI82bph9ZFQrYYImpWEfimm5SSQdbrpHI1nrGYLyLGHRi6vQaUle5bystxsdiSq8cihtzG5Nb5I",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "Mw8H1Z1VRlpgiRgX4m3D0GmZ95wKWLC4HAiGeeqMb8mnbCTAJfaLVfZl2_3v-3WjGgnHg9Z9k7ggWUrmF7IxubATCULiWS90HDnFW7w__UwfiLbJikaJy5gD8x1PlozM_DtNzsqUn8WQXP5J4Uk9GePS361IuZ-gkjEKG7i2FC3jRMjc4DxtbeKOTuCGjl2gcruuWIpAFo-sFKxPAQEJHI82bph9ZFQrYYImpWEfimm5SSQdbrpHI1nrGYLyLGHRi6vQaUle5bystxsdiSq8cihtzG5Nb5I=",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "Mw8H1Z1VRlpgiRgX4m3D0GmZ95wKWLC4HAiGeeqMb8mnbCTAJfaLVfZl2_3v-3WjGgnHg9Z9k7ggWUrmF7IxubATCULiWS90HDnFW7w__UwfiLbJikaJy5gD8x1PlozM_DtNzsqUn8WQXP5J4Uk9GePS361IuZ-gkjEKG7i2FC3jRMjc4DxtbeKOTuCGjl2gcruuWIpAFo-sFKxPAQEJHI82bph9ZFQrYYImpWEfimm5SSQdbrpHI1nrGYLyLGHRi6vQaUle5bystxsdiSq8cihtzG5Nb5I",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE std::enc,
                    value := <bytes>$value,
                    standard_encoded := base64_encode(
                        value),
                    standard_decoded := base64_decode(
                        standard_encoded),
                    standard_unpadded_encoded := base64_encode(
                        value,
                        padding := false),
                    standard_unpadded_decoded := base64_decode(
                        standard_unpadded_encoded,
                        padding := false),
                    urlsafe_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_decoded := base64_decode(
                        urlsafe_encoded,
                        alphabet := Base64Alphabet.urlsafe),
                    urlsafe_unpadded_encoded := base64_encode(
                        value,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                    urlsafe_unpadded_decoded := base64_decode(
                        urlsafe_unpadded_encoded,
                        alphabet := Base64Alphabet.urlsafe,
                        padding := false),
                SELECT {
                    standard_encoded :=
                        standard_encoded,
                    standard_crosscheck :=
                        standard_decoded = value,
                    standard_unpadded_encoded :=
                        standard_unpadded_encoded,
                    standard_unpadded_crosscheck :=
                        standard_unpadded_decoded = value,
                    urlsafe_encoded :=
                        urlsafe_encoded,
                    urlsafe_crosscheck :=
                        urlsafe_decoded = value,
                    urlsafe_unpadded_encoded :=
                        urlsafe_unpadded_encoded,
                    urlsafe_unpadded_crosscheck :=
                        urlsafe_unpadded_decoded = value,
                }
                `,
      [
            {
              "standard_encoded": "Q4+43T95hzY4kFWiODeTs9Nq4jzdJDDNY/ZmbGAh3jKMkLvwMXK/OtFYDW8JBJ4wneiPyd3mJ312GjUuawpCNzoTj6wuUkg2GRKCm3qqR+rP4ariU7Z/j+eLa/bwX/7aRfxottcJX+Mn6E0jhOwtZBXuBAQW5+3Lf+1U2JiY9nUnPCjUarVPNvWRVUUPSMz+1/PnJuAnsFceICcEOoGjqOL+39vk7yVj+s7SUJdfHMKlPYMN/SS6zYc33Eew+9bPgGjyKPcNiT2fWds3Q8UgOTxWGX62PDo5lQ2v31k7ZeBn5bwxwo0fmuB07I/7PTV0Y7IehvNkRUY04hNxyRmZVSN7abP8U0EFdHSGn/LjoW21NI31nS+2gwBmnC8aWgeTRgde77BDxP1EMYsbfJ1aP49nfr2LnTvQaIFlGcuR0KTMeSs4R6PBlziDq4CdZqIQAjJQwoQafmme8Kxrjx2YaAD3iMvWmMTsUGD3uiacYbFZUVSHRtTrwDrs3eqx258=",
              "standard_crosscheck": true,
              "standard_unpadded_encoded": "Q4+43T95hzY4kFWiODeTs9Nq4jzdJDDNY/ZmbGAh3jKMkLvwMXK/OtFYDW8JBJ4wneiPyd3mJ312GjUuawpCNzoTj6wuUkg2GRKCm3qqR+rP4ariU7Z/j+eLa/bwX/7aRfxottcJX+Mn6E0jhOwtZBXuBAQW5+3Lf+1U2JiY9nUnPCjUarVPNvWRVUUPSMz+1/PnJuAnsFceICcEOoGjqOL+39vk7yVj+s7SUJdfHMKlPYMN/SS6zYc33Eew+9bPgGjyKPcNiT2fWds3Q8UgOTxWGX62PDo5lQ2v31k7ZeBn5bwxwo0fmuB07I/7PTV0Y7IehvNkRUY04hNxyRmZVSN7abP8U0EFdHSGn/LjoW21NI31nS+2gwBmnC8aWgeTRgde77BDxP1EMYsbfJ1aP49nfr2LnTvQaIFlGcuR0KTMeSs4R6PBlziDq4CdZqIQAjJQwoQafmme8Kxrjx2YaAD3iMvWmMTsUGD3uiacYbFZUVSHRtTrwDrs3eqx258",
              "standard_unpadded_crosscheck": true,
              "urlsafe_encoded": "Q4-43T95hzY4kFWiODeTs9Nq4jzdJDDNY_ZmbGAh3jKMkLvwMXK_OtFYDW8JBJ4wneiPyd3mJ312GjUuawpCNzoTj6wuUkg2GRKCm3qqR-rP4ariU7Z_j-eLa_bwX_7aRfxottcJX-Mn6E0jhOwtZBXuBAQW5-3Lf-1U2JiY9nUnPCjUarVPNvWRVUUPSMz-1_PnJuAnsFceICcEOoGjqOL-39vk7yVj-s7SUJdfHMKlPYMN_SS6zYc33Eew-9bPgGjyKPcNiT2fWds3Q8UgOTxWGX62PDo5lQ2v31k7ZeBn5bwxwo0fmuB07I_7PTV0Y7IehvNkRUY04hNxyRmZVSN7abP8U0EFdHSGn_LjoW21NI31nS-2gwBmnC8aWgeTRgde77BDxP1EMYsbfJ1aP49nfr2LnTvQaIFlGcuR0KTMeSs4R6PBlziDq4CdZqIQAjJQwoQafmme8Kxrjx2YaAD3iMvWmMTsUGD3uiacYbFZUVSHRtTrwDrs3eqx258=",
              "urlsafe_crosscheck": true,
              "urlsafe_unpadded_encoded": "Q4-43T95hzY4kFWiODeTs9Nq4jzdJDDNY_ZmbGAh3jKMkLvwMXK_OtFYDW8JBJ4wneiPyd3mJ312GjUuawpCNzoTj6wuUkg2GRKCm3qqR-rP4ariU7Z_j-eLa_bwX_7aRfxottcJX-Mn6E0jhOwtZBXuBAQW5-3Lf-1U2JiY9nUnPCjUarVPNvWRVUUPSMz-1_PnJuAnsFceICcEOoGjqOL-39vk7yVj-s7SUJdfHMKlPYMN_SS6zYc33Eew-9bPgGjyKPcNiT2fWds3Q8UgOTxWGX62PDo5lQ2v31k7ZeBn5bwxwo0fmuB07I_7PTV0Y7IehvNkRUY04hNxyRmZVSN7abP8U0EFdHSGn_LjoW21NI31nS-2gwBmnC8aWgeTRgde77BDxP1EMYsbfJ1aP49nfr2LnTvQaIFlGcuR0KTMeSs4R6PBlziDq4CdZqIQAjJQwoQafmme8Kxrjx2YaAD3iMvWmMTsUGD3uiacYbFZUVSHRtTrwDrs3eqx258",
              "urlsafe_unpadded_crosscheck": true,
            },
          ]
    );
  });

  it("test_edgeql_functions_encoding_base64_bad", () => {
    expect(() => {
      h.script(
        `select std::enc::base64_decode("~")`
      );
    }).toThrow(new RegExp("invalid symbol \"~\" found while decoding base64 sequence"));
    expect(() => {
      h.script(
        `select std::enc::base64_decode("AA")`
      );
    }).toThrow(new RegExp("invalid base64 end sequence"));
  });

  it("test_edgeql_call_type_as_function_01", () => {
    expect(() => {
      h.script(
        `
                select str(1);
            `
      );
    }).toThrow(new RegExp("does not exist"));
    expect(() => {
      h.script(
        `
                select int32(1);
            `
      );
    }).toThrow(new RegExp("does not exist"));
    expect(() => {
      h.script(
        `
                select cal::local_date(1);
            `
      );
    }).toThrow(new RegExp("does not exist"));
  });

  it("test_edgeql_functions_complex_types_01", () => {
    h.script(
      `
            create function foo(x: File | URL) -> File | URL using (
                x
            );
        `
    );
    assertQueryResult(
      h,
      `select foo(<File>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<URL>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<File | URL>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select File)).name`,
      unorderedBag(["screenshot.png"])
    );
    assertQueryResult(
      h,
      `select foo((select URL)).name`,
      unorderedBag(["edgedb.com"])
    );
    assertQueryResult(
      h,
      `select foo((select {File, URL})).name`,
      unorderedBag(["edgedb.com", "screenshot.png"])
    );
  });

  it("test_edgeql_functions_complex_types_02", () => {
    h.script(
      `
            create function foo(x: str) -> optional File | URL using (
                select {File, URL} filter .name = x limit 1
            );
        `
    );
    assertQueryResult(
      h,
      `select foo(<str>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo("haha")`,
      []
    );
    assertQueryResult(
      h,
      `select foo("screenshot.png").name`,
      unorderedBag(["screenshot.png"])
    );
    assertQueryResult(
      h,
      `select foo("edgedb.com").name`,
      unorderedBag(["edgedb.com"])
    );
    assertQueryResult(
      h,
      `select foo({"edgedb.com", "screenshot.png"}).name`,
      unorderedBag(["edgedb.com", "screenshot.png"])
    );
  });

  it("test_edgeql_functions_complex_types_03", () => {
    h.script(
      `
            create function foo(x: File | URL) -> str using (
                x.name
            );
        `
    );
    assertQueryResult(
      h,
      `select foo(<File>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<URL>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<File | URL>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select File))`,
      unorderedBag(["screenshot.png"])
    );
    assertQueryResult(
      h,
      `select foo((select URL))`,
      unorderedBag(["edgedb.com"])
    );
    assertQueryResult(
      h,
      `select foo((select {File, URL}))`,
      unorderedBag(["edgedb.com", "screenshot.png"])
    );
  });

  it("test_edgeql_functions_complex_types_04", () => {
    h.script(
      `
            create function foo(x: File | URL) -> str using (
                if x is URL
                then assert_exists(x[is URL]).address
                else '~/' ++ x.name
            );
        `
    );
    assertQueryResult(
      h,
      `select foo(<File>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<URL>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<File | URL>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select File))`,
      unorderedBag(["~/screenshot.png"])
    );
    assertQueryResult(
      h,
      `select foo((select URL))`,
      unorderedBag(["https://edgedb.com"])
    );
    assertQueryResult(
      h,
      `select foo((select {File, URL}))`,
      unorderedBag(["https://edgedb.com", "~/screenshot.png"])
    );
  });

  it("test_edgeql_functions_approximate_count", () => {
    assertQueryResult(
      h,
      `
            select sys::approximate_count(introspect Issue);
            `,
      [
            "int",
          ]
    );
    assertQueryResult(
      h,
      `
            select sys::approximate_count(
                introspect schema::Object, ignore_subtypes := True);
            `,
      [0]
    );
    let val = h.query("\n            select sys::approximate_count(introspect schema::Object);\n            ");
    expect(val).toBeGreaterThan(0);
  });
});
