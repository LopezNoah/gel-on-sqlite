import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  queryRows,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLSelectInterpreter", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "issues",
      setup: "issues_setup",
    });
  });

  it("test_edgeql_select_interpreter_unique_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue.watchers.<owner[IS Issue] {
                    name
                } ORDER BY .name;
            `,
      [
            {
              "name": "Improve EdgeDB repl output rendering.",
            },
            {
              "name": "Regression.",
            },
            {
              "name": "Release EdgeDB",
            },
            {
              "name": "Repl tweak.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_unique_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue.owner{name}
            ORDER BY Issue.owner.name;
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

  it("test_edgeql_select_interpreter_computable_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number,
                    aliased_number := Issue.number,
                    total_time_spent := (
                        SELECT sum(Issue.time_spent_log.spent_time)
                    )
                }
            FILTER
                Issue.number = '1';
            `,
      [
            {
              "number": "1",
              "aliased_number": "1",
              "total_time_spent": 50000,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_02", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number,
                    total_time_spent := (
                        SELECT sum(Issue.time_spent_log.spent_time)
                    )
                }
            FILTER
                Issue.number = '1';
            `,
      [
            {
              "number": "1",
              "total_time_spent": 50000,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_03", () => {
    assertQueryResult(
      h,
      `
            SELECT
                User {
                    name,
                    shortest_own_text := (
                        SELECT
                            Text {
                                body
                            }
                        FILTER
                            Text[IS Owned].owner = User
                        ORDER BY
                            len(Text.body) ASC
                        LIMIT 1
                    ),
                }
            FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "shortest_own_text": {
                "body": "Rewriting everything.",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_04", () => {
    assertQueryResult(
      h,
      `
            WITH
                # we aren't referencing User in any way, so this works
                # best as a subquery, rather than inline computable
                sub := (
                    SELECT
                        Text
                    ORDER BY
                        len(Text.body) ASC
                    LIMIT 1
                )
            SELECT
                User {
                    name,
                    shortest_text := sub {
                        body
                    }
                }
            FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "shortest_text": {
                "body": "Minor lexer tweaks.",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_05", () => {
    assertQueryResult(
      h,
      `
            WITH
                # we aren't referencing User in any way, so this works
                # best as a subquery, than inline computable
                sub := (
                    SELECT
                        Text
                    ORDER BY
                        len(Text.body) ASC
                    LIMIT
                        1
                )
            SELECT
                User {
                    name,
                    shortest_own_text := (
                        SELECT
                            Text {body}
                        FILTER
                            Text[IS Owned].owner = User
                        ORDER BY
                            len(Text.body) ASC
                        LIMIT
                            1
                    ),
                    shortest_text := sub {
                        body
                    },
                }
            FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "shortest_own_text": {
                "body": "Rewriting everything.",
              },
              "shortest_text": {
                "body": "Minor lexer tweaks.",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_06", () => {
    assertQueryResult(
      h,
      `
            SELECT
                User {
                    name,
                    shortest_text := (
                        SELECT
                            Text {body}
                        # a clause that references User and is always true
                        FILTER
                            User IS User
                        ORDER
                            BY len(Text.body) ASC
                        LIMIT 1
                    ),
                }
            FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "shortest_text": {
                "body": "Minor lexer tweaks.",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_07", () => {
    assertQueryResult(
      h,
      `
            SELECT
                User {
                    name,
                    # ad-hoc computable with many results
                    special_texts := (
                        SELECT Text {body}
                        FILTER Text[IS Owned].owner != User
                        ORDER BY len(Text.body) DESC
                    ),
                }
            FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "special_texts": [
                {
                  "body": "We need to be able to render data in tabular format.",
                },
                {
                  "body": "Minor lexer tweaks.",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_08", () => {
    assertQueryResult(
      h,
      `
            # get a user + the latest issue (regardless of owner), which has
            # the same number of characters in the status as the user's name
            SELECT User{
                name,
                special_issue := (
                    SELECT Issue {
                        name,
                        number,
                        owner: {
                            name
                        },
                        status: {
                            name
                        }
                    }
                    FILTER len(Issue.status.name) = len(User.name)
                    ORDER BY Issue.number DESC
                    LIMIT 1
                )
            }
            ORDER BY User.name;
            `,
      [
            {
              "name": "Elvis",
              "special_issue": null,
            },
            {
              "name": "Yury",
              "special_issue": {
                "name": "Improve EdgeDB repl output rendering.",
                "owner": {
                  "name": "Yury",
                },
                "status": {
                  "name": "Open",
                },
                "number": "2",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_09", () => {
    assertQueryResult(
      h,
      `
            SELECT Text{
                body,
                name := Text[IS Issue].name IF Text IS Issue      ELSE
                        'log'                IF Text IS LogEntry   ELSE
                        'comment'            IF Text IS Comment    ELSE
                        'unknown'
            }
            ORDER BY Text.body;
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
              "name": "comment",
            },
            {
              "body": "Fix regression introduced by lexer tweak.",
              "name": "Regression.",
            },
            {
              "body": "Initial public release of EdgeDB.",
              "name": "Release EdgeDB",
            },
            {
              "body": "Minor lexer tweaks.",
              "name": "Repl tweak.",
            },
            {
              "body": "Rewriting everything.",
              "name": "log",
            },
            {
              "body": "We need to be able to render data in tabular format.",
              "name": "Improve EdgeDB repl output rendering.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_10", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                name,
                number,
                # use shorthand with some simple operations
                foo := <int64>Issue.number + 10,
            }
            FILTER Issue.number = '1';
            `,
      [
            {
              "name": "Release EdgeDB",
              "number": "1",
              "foo": 11,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_11", () => {
    assertQueryResult(
      h,
      `
            WITH
                sub := (
                    SELECT
                        Text
                    ORDER BY
                        len(Text.body) ASC
                    LIMIT
                        1
                )
            SELECT
                sub.body;
            `,
      ["Minor lexer tweaks."]
    );
  });

  it("test_edgeql_select_interpreter_computable_12", () => {
    assertQueryResult(
      h,
      `
            WITH
                sub := (
                    SELECT
                        Text
                    ORDER BY
                        len(Text.body) ASC
                    LIMIT
                        1
                )
            SELECT
                sub.__type__.name;
            `,
      ["default::Issue"]
    );
  });

  it("test_edgeql_select_interpreter_computable_13", () => {
    assertQueryResult(
      h,
      `
            WITH
                sub := (
                    SELECT
                        Text
                    ORDER BY
                        len(Text.body) ASC
                    LIMIT
                        1
                )
            SELECT
                sub[IS Issue].number;
            `,
      ["3"]
    );
  });

  it("test_edgeql_select_interpreter_computable_14", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                name,
                number,
                foo := <int64>Issue.number + 10,
                }
                FILTER Issue.number = '1';
            `,
      [
            {
              "name": "Release EdgeDB",
              "number": "1",
              "foo": 11,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_15", () => {
    h.script(
      "            SELECT Issue{\n                name,\n                number,\n                foo := {1, 2}\n            }\n            FILTER Issue.number = '1';\n        "
    );
  });

  it("test_edgeql_select_interpreter_computable_16", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                name,
                number,
                single foo := <int64>{},
                single bar := 11,
            }
            FILTER Issue.number = '1';
            `,
      [
            {
              "name": "Release EdgeDB",
              "number": "1",
              "foo": null,
              "bar": 11,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_17", () => {
    h.script(
      "            WITH\n                V := (SELECT Issue {\n                    foo := {1, 2}\n                } FILTER .number = '1')\n            SELECT\n                V {\n                    foo := .foo\n                };\n        "
    );
  });

  it("test_edgeql_select_interpreter_computable_18", () => {
    h.script(
      "\n                    INSERT Publication {\n                        title := 'aaa'\n                    }\n                "
    );
    assertQueryResult(
      h,
      `
                    SELECT Publication {
                        title,
                        title1,
                        title2,
                        title3,
                        title4,
                        title5,
                        title6,
                    }
                    FILTER .title = 'aaa'
                `,
      [
            {
              "title": "aaa",
              "title1": "aaa",
              "title2": "aaa",
              "title3": "aaa",
              "title4": "aaa",
              "title5": ["aaa"],
              "title6": ["aaa"],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_19", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                number,
                required foo := 42,
            }
            FILTER Issue.number = '1';
            `,
      [
            {
              "number": "1",
              "foo": 42,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_30", () => {
    assertQueryResult(
      h,
      `
                WITH O := (SELECT {m := 10}),
                SELECT (O {m}, O.m);
            `,
      [
            [
              {
                "m": 10,
              },
              10,
            ],
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_32", () => {
    assertQueryResult(
      h,
      `
            SELECT _ := (User {x := .name}.x, (SELECT User.name)) ORDER BY _;
            `,
      [
            ["Elvis", "Elvis"],
            ["Yury", "Yury"],
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT _ := ((SELECT User.name), User {x := .name}.x) ORDER BY _;
            `,
      [
            ["Elvis", "Elvis"],
            ["Yury", "Yury"],
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT _ := ((SELECT User.name), (User {x := .name},).0.x)
            ORDER BY _;
            `,
      [
            ["Elvis", "Elvis"],
            ["Yury", "Yury"],
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_33", () => {
    assertQueryResult(
      h,
      `
            SELECT User {name, todo_ids := .todo.id} FILTER .name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "todo_ids": [
                "str",
                "str",
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH Z := (SELECT User {
                asdf := (SELECT .todo ORDER BY .number LIMIT 1)})
            SELECT Z {name, asdf_id := .asdf.id} FILTER .name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "asdf_id": "str",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_computable_34", () => {
    h.script(
      "            SELECT Issue{\n                number,\n                foo := .owner.todo UNION .owner.todo,\n            }\n            FILTER Issue.number = '1';\n        "
    );
  });

  it("test_edgeql_select_interpreter_computable_35", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
                __type__ := (select Issue.__type__ { name }),
            }
            FILTER .number = '3'
            `,
      [
            {
              "number": "3",
              "__type__": {
                "name": "default::Issue",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_match_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name LIKE '%edgedb'
            ORDER BY Issue.number;
            `,
      []
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name LIKE '%EdgeDB'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name LIKE '%Edge%'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "2",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_match_02", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name NOT LIKE '%edgedb'
            ORDER BY Issue.number;
            `,
      [
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
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name NOT LIKE '%EdgeDB'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name NOT LIKE '%Edge%'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_match_03", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name ILIKE '%edgedb'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name ILIKE '%EdgeDB'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name ILIKE '%re%'
            ORDER BY Issue.number;
            `,
      [
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
          ]
    );
  });

  it("test_edgeql_select_interpreter_match_04", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name NOT ILIKE '%edgedb'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name NOT ILIKE '%EdgeDB'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            FILTER
                Issue.name NOT ILIKE '%re%'
            ORDER BY Issue.number;
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_match_07", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Text {body}
            FILTER
                re_test('ed', Text.body)
            ORDER BY Text.body;
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
            },
            {
              "body": "Fix regression introduced by lexer tweak.",
            },
            {
              "body": "We need to be able to render data in tabular format.",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Text {body}
            FILTER
                re_test('eD', Text.body)
            ORDER BY Text.body;
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
            },
            {
              "body": "Initial public release of EdgeDB.",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Text {body}
            FILTER
                re_test(r'ed([S\\s]|$)', Text.body)
            ORDER BY Text.body;
            `,
      [
            {
              "body": "Fix regression introduced by lexer tweak.",
            },
            {
              "body": "We need to be able to render data in tabular format.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_match_08", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Text {body}
            FILTER
                re_test('(?i)ed', Text.body)
            ORDER BY Text.body;
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
            },
            {
              "body": "Fix regression introduced by lexer tweak.",
            },
            {
              "body": "Initial public release of EdgeDB.",
            },
            {
              "body": "We need to be able to render data in tabular format.",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Text {body}
            FILTER
                re_test('(?i)eD', Text.body)
            ORDER BY Text.body;
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
            },
            {
              "body": "Fix regression introduced by lexer tweak.",
            },
            {
              "body": "Initial public release of EdgeDB.",
            },
            {
              "body": "We need to be able to render data in tabular format.",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Text {body}
            FILTER
                re_test(r'(?i)ed([S\\s]|$)', Text.body)
            ORDER BY Text.body;
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
            },
            {
              "body": "Fix regression introduced by lexer tweak.",
            },
            {
              "body": "We need to be able to render data in tabular format.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_type_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number,
                    __type__: {
                        name
                    }
                }
            FILTER
                Issue.number = '1';
            `,
      [
            {
              "number": "1",
              "__type__": {
                "name": "default::Issue",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_type_02", () => {
    assertQueryResult(
      h,
      `
            SELECT User.__type__.name LIMIT 1;
            `,
      ["default::User"]
    );
  });

  it("test_edgeql_select_interpreter_recursive_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number,
                    related_to: {
                        number,
                    },
                }
            FILTER
                Issue.number = '2';
            `,
      [
            {
              "number": "2",
              "related_to": [],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_limit_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            OFFSET 2;
            `,
      [
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            LIMIT 3;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            OFFSET 2 LIMIT 3;
            `,
      [
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_limit_02", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            OFFSET 1 + 1;
            `,
      [
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            LIMIT 6 // 2;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            OFFSET 4 - 2 LIMIT 5 * 2 - 7;
            `,
      [
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_limit_03", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            OFFSET (SELECT count(Status));
            `,
      [
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            LIMIT (SELECT count(Status) + 1);
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {number}
            ORDER BY Issue.number
            OFFSET (SELECT count(Status))
            LIMIT (SELECT count(Priority) + 1);
            `,
      [
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_limit_04", () => {
    assertQueryResult(
      h,
      `
            SELECT
                User {
                    name,
                    owner_of := (
                        SELECT User.<owner[IS Issue] {
                            number
                        } ORDER BY .number
                        LIMIT 1
                    )
                }
            ORDER BY User.name;
            `,
      [
            {
              "name": "Elvis",
              "owner_of": {
                "number": "1",
              },
            },
            {
              "name": "Yury",
              "owner_of": {
                "number": "2",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_limit_05", () => {
    assertQueryResult(
      h,
      `
            SELECT
                User {
                    name,
                    owner_of := (
                        SELECT User.<owner[IS Issue] {
                            number
                        } ORDER BY .number
                        LIMIT len(User.name) - 3
                    )
                }
            ORDER BY User.name;
            `,
      [
            {
              "name": "Elvis",
              "owner_of": [
                {
                  "number": "1",
                },
                {
                  "number": "4",
                },
              ],
            },
            {
              "name": "Yury",
              "owner_of": [
                {
                  "number": "2",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_limit_10", () => {
    expect(() => {
      h.script(
        "\n                SELECT 1 LIMIT -1\n            "
      );
    }).toThrow(new RegExp("LIMIT must not be negative"));
  });

  it("test_edgeql_select_interpreter_offset_01", () => {
    expect(() => {
      h.script(
        "\n                SELECT 1 OFFSET -1\n            "
      );
    }).toThrow(new RegExp("OFFSET must not be negative"));
  });

  it("test_edgeql_select_interpreter_polymorphic_02", () => {
    assertQueryResult(
      h,
      `
            SELECT User{
                name,
                owner_of := User.<owner[IS LogEntry] {
                    body
                },
            } FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "owner_of": [
                {
                  "body": "Rewriting everything.",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_polymorphic_03", () => {
    assertQueryResult(
      h,
      `
            SELECT User{
                name,
                owner_of := (
                    SELECT User.<owner[IS Issue] {
                        number
                    } FILTER <int64>(.number) < 3
                ),
            } FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "owner_of": [
                {
                  "number": "1",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_polymorphic_04", () => {
    h.script(
      "\n                SELECT User {\n                    [IS Named].id,\n                };\n            "
    );
  });

  it("test_edgeql_select_interpreter_polymorphic_14", () => {
    assertQueryResult(
      h,
      `
            select Issue { number, related_to }
            filter exists .related_to;
            `,
      unorderedBag([
            {
              "number": "3",
              "related_to": [
                {},
              ],
            },
            {
              "number": "4",
              "related_to": [
                {},
              ],
            },
          ])
    );
  });

  it("test_edgeql_select_interpreter_reverse_link_03", () => {
    expect(() => {
      h.script(
        "\n                SELECT\n                    User.<owner[IS Text]@since\n                "
      );
    }).toThrow(new RegExp("property 'since' does not exist"));
  });

  it("test_edgeql_select_interpreter_reverse_link_05", () => {
    assertQueryResult(
      h,
      `
            SELECT (User.<owner[IS Comment], User.<owner[IS Issue]);
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_empty_intersection_property", () => {
    expect(() => {
      h.script(
        "\n                SELECT\n                    User.<owner[IS Status]@since\n                "
      );
    }).toThrow(new RegExp("property 'since' does not exist"));
  });

  it("test_edgeql_select_interpreter_nested_redefined_link", () => {
    assertQueryResult(
      h,
      `
                SELECT (SELECT (SELECT Issue { watchers: {name} }).watchers);
            `,
      unorderedBag([
            {
              "name": "Elvis",
            },
            {
              "name": "Yury",
            },
          ])
    );
  });

  it("test_edgeql_select_interpreter_tvariant_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                number,
                related_to: {
                    number
                } FILTER Issue.related_to.owner = Issue.owner,
            } ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "related_to": [],
            },
            {
              "number": "2",
              "related_to": [],
            },
            {
              "number": "3",
              "related_to": [
                {
                  "number": "2",
                },
              ],
            },
            {
              "number": "4",
              "related_to": [],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tvariant_02", () => {
    assertQueryResult(
      h,
      `
            SELECT User{
                name,
                owner_of := (
                    SELECT User.<owner[IS Issue] {
                        number
                    } FILTER EXISTS .related_to
                ),
            } ORDER BY User.name;
            `,
      [
            {
              "name": "Elvis",
              "owner_of": [
                {
                  "number": "4",
                },
              ],
            },
            {
              "name": "Yury",
              "owner_of": [
                {
                  "number": "3",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tvariant_03", () => {
    assertQueryResult(
      h,
      `
            SELECT User{
                name,
                owner_of := (
                    SELECT User.<owner[IS Issue] {
                        number
                    } ORDER BY .number DESC
                ),
            } ORDER BY User.name;
            `,
      [
            {
              "name": "Elvis",
              "owner_of": [
                {
                  "number": "4",
                },
                {
                  "number": "1",
                },
              ],
            },
            {
              "name": "Yury",
              "owner_of": [
                {
                  "number": "3",
                },
                {
                  "number": "2",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tvariant_04", () => {
    assertQueryResult(
      h,
      `
            WITH
                L := LogEntry   # there happens to only be 1 entry
            SELECT
                # define a type variant that assigns a log to every Issue
                Issue {
                    tsl := (Issue.time_spent_log ?? L)
                }.tsl {
                    body
                };
            `,
      [
            {
              "body": "Rewriting everything.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tvariant_05", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue.owner {
                name,
                # this path extends \`Issue.owner\` from top scope
                foo := Issue.owner.<owner[IS Issue]{
                    number,
                    # this path *also* extends \`Issue.owner\` from top scope
                    bar := Issue.owner.name
                }
            };
            `,
      unorderedBag([
            {
              "name": "Elvis",
              "foo": [
                {
                  "bar": "Elvis",
                  "number": "1",
                },
                {
                  "bar": "Elvis",
                  "number": "4",
                },
              ],
            },
            {
              "name": "Yury",
              "foo": [
                {
                  "bar": "Yury",
                  "number": "2",
                },
                {
                  "bar": "Yury",
                  "number": "3",
                },
              ],
            },
          ])
    );
  });

  it("test_edgeql_select_interpreter_tvariant_06", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
                name,
                foo := (
                    SELECT (
                        SELECT Status
                        FILTER Status.name = 'Open'
                    ).name
                )
            } FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "foo": "Open",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tvariant_07", () => {
    assertQueryResult(
      h,
      `
            # semantically identical to the previous test
            SELECT User {
                name,
                foo := {
                    (
                        SELECT Status
                        FILTER Status.name = 'Open'
                    ).name
                }
            } FILTER User.name = 'Elvis';
            # FIXME: please also fix the error message to be less
            # arcane with some sort of reference to where things go
            # wrong in the query
            `,
      [
            {
              "name": "Elvis",
              "foo": "Open",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tvariant_09", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    (((SELECT Issue {
                        x := .number ++ "!"
                    }), Issue).0.x ++ (SELECT Issue.number));
            `,
      unorderedSet(["1!1", "2!2", "3!3", "4!4"])
    );
  });

  it("test_edgeql_select_interpreter_tvariant_bad_01", () => {
    expect(() => {
      h.script(
        "\n                SELECT User {\n                    name := 1\n                }\n            "
      );
    }).toThrow(new RegExp("cannot redefine property 'name' of object type 'default::User' as scalar type 'std::int64'"));
  });

  it("test_edgeql_select_interpreter_tvariant_bad_02", () => {
    expect(() => {
      h.script(
        "\n                SELECT User {\n                    name := Issue\n                }\n            "
      );
    }).toThrow(new RegExp("cannot redefine property 'name' of object type 'default::User' as object type 'default::Issue'"));
  });

  it("test_edgeql_select_interpreter_tvariant_bad_03", () => {
    expect(() => {
      h.script(
        "\n                SELECT Issue {\n                    related_to := 1\n                }\n            "
      );
    }).toThrow(new RegExp("cannot redefine link 'related_to' of object type 'default::Issue' as scalar type 'std::int64'"));
  });

  it("test_edgeql_select_interpreter_tvariant_bad_04", () => {
    expect(() => {
      h.script(
        "\n                SELECT Issue {\n                    related_to := Text\n                }\n            "
      );
    }).toThrow(new RegExp("cannot redefine link 'related_to' of object type 'default::Issue' as object type 'default::Text'"));
  });

  it("test_edgeql_select_interpreter_tvariant_bad_05", () => {
    h.script(
      "\n                SELECT Issue {\n                    priority := Priority\n                }\n            "
    );
  });

  it("test_edgeql_select_interpreter_tvariant_bad_06", () => {
    h.script(
      "\n                SELECT Issue {\n                    multi owner := User\n                }\n            "
    );
  });

  it("test_edgeql_select_interpreter_tvariant_bad_07", () => {
    h.script(
      "\n                SELECT Issue {\n                    single related_to := (SELECT Issue LIMIT 1)\n                }\n            "
    );
  });

  it("test_edgeql_select_interpreter_tvariant_bad_08", () => {
    h.script(
      "\n                SELECT Issue {\n                    owner := (SELECT User LIMIT 1)\n                }\n            "
    );
  });

  it("test_edgeql_select_interpreter_instance_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Text {body}
            FILTER Text IS Comment
            ORDER BY Text.body;
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_instance_03", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Text {body}
            FILTER Text IS Issue AND Text[IS Issue].number = '1'
            ORDER BY Text.body;
            `,
      [
            {
              "body": "Initial public release of EdgeDB.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_03", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
                # open := 'yes' IF Issue.status.name = 'Open' ELSE 'no'
                # equivalent to
                open := (SELECT (
                    (SELECT 'yes' FILTER Issue.status.name = 'Open')
                    UNION
                    (SELECT 'no' FILTER NOT Issue.status.name = 'Open')
                ) LIMIT 1)
            }
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "open": "yes",
            },
            {
              "number": "2",
              "open": "yes",
            },
            {
              "number": "3",
              "open": "no",
            },
            {
              "number": "4",
              "open": "no",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_04", () => {
    assertQueryResult(
      h,
      `
            # equivalent to ?=
            SELECT Issue {number}
            FILTER
                # Issue.priority.name ?= 'High'
                # equivalent to this via an if/else translation
                (SELECT Issue.priority.name = 'High'
                 FILTER EXISTS Issue.priority.name)
                UNION
                (SELECT EXISTS Issue.priority.name = TRUE
                 FILTER NOT EXISTS Issue.priority.name)
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_05", () => {
    assertQueryResult(
      h,
      `
            # using DISTINCT on a UNION with overlapping sets of Objects
            SELECT _ := (
                DISTINCT ((
                    # Issue 1, 4
                    (SELECT User
                     FILTER User.name = 'Elvis').<owner[IS Issue]
                ) UNION (
                    # Issue 1
                    (SELECT User
                     FILTER User.name = 'Yury').<watchers[IS Issue]
                ) UNION (
                    # Issue 1, 4
                    SELECT Issue
                    FILTER NOT EXISTS Issue.priority
                ))
            ) { number }
            ORDER BY _.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_06", () => {
    assertQueryResult(
      h,
      `
            # using DISTINCT on a UNION with overlapping sets of Objects
            SELECT _ := count(DISTINCT ((
                # Issue 1, 4
                (SELECT User
                 FILTER User.name = 'Elvis').<owner[IS Issue]
            ) UNION (
                # Issue 1
                (SELECT User
                 FILTER User.name = 'Yury').<watchers[IS Issue]
            ) UNION (
                # Issue 1, 4
                SELECT Issue
                FILTER NOT EXISTS Issue.priority
            )));
            `,
      [2]
    );
  });

  it("test_edgeql_select_interpreter_setops_07", () => {
    assertQueryResult(
      h,
      `
            # using UNION with overlapping sets of Objects
            SELECT _ := {  # equivalent to UNION for Objects
                # Issue 1, 4
                (
                    SELECT Issue
                    FILTER Issue.owner.name = 'Elvis'
                ), (
                    SELECT Issue
                    FILTER Issue.number = '1'
                )
            } { number }
            ORDER BY _.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_08", () => {
    assertQueryResult(
      h,
      `
            # using implicit nested UNION with overlapping sets of Objects
            SELECT _ := {  # equivalent to UNION for Objects
                # Issue 1, 4
                (
                    SELECT Issue
                    FILTER Issue.owner.name = 'Elvis'
                ),
                {
                    (
                        # Issue 1, 4
                        (
                            SELECT User
                            FILTER User.name = 'Elvis'
                        ).<owner[IS Issue]
                    ) UNION (
                        # Issue 1
                        (
                            SELECT User
                            FILTER User.name = 'Yury'
                        ).<watchers[IS Issue]
                    ),
                    (
                        # Issue 1, 4
                        SELECT Issue
                        FILTER NOT EXISTS Issue.priority
                    )
                },
                (
                    SELECT Issue FILTER Issue.number = '1'
                )
            } { number }
            ORDER BY _.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "1",
            },
            {
              "number": "1",
            },
            {
              "number": "1",
            },
            {
              "number": "1",
            },
            {
              "number": "4",
            },
            {
              "number": "4",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_09", () => {
    assertQueryResult(
      h,
      `
            # same as above but with a DISTINCT
            SELECT _ := (DISTINCT {  # equivalent to UNION for Objects
                # Issue 1, 4
                (
                    SELECT Issue
                    FILTER Issue.owner.name = 'Elvis'
                ),
                {
                    (
                        # Issue 1, 4
                        (
                            SELECT User
                            FILTER User.name = 'Elvis'
                        ).<owner[IS Issue]
                    ) UNION (
                        # Issue 1
                        (
                            SELECT User
                            FILTER User.name = 'Yury'
                        ).<watchers[IS Issue]
                    ),
                    (
                        # Issue 1, 4
                        SELECT Issue
                        FILTER NOT EXISTS Issue.priority
                    )
                },
                (
                    SELECT Issue
                    FILTER Issue.number = '1'
                )
            }) { number }
            ORDER BY _.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_10", () => {
    assertQueryResult(
      h,
      `
            # using UNION in a FILTER
            SELECT _ := User{name}
            FILTER (
                (
                    SELECT User.<owner[IS Issue]
                ) UNION (
                    # this part should guarantee the filter is always true
                    SELECT Issue
                    FILTER Issue.number = '1'
                )
            ).number = '1'
            ORDER BY _.name;
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

  it("test_edgeql_select_interpreter_setops_11", () => {
    assertQueryResult(
      h,
      `
            WITH
                L := LogEntry  # there happens to only be 1 entry
            SELECT
                (Issue.time_spent_log UNION L) {
                    body
                };
            `,
      [
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_12", () => {
    assertQueryResult(
      h,
      `
            WITH
                L := LogEntry  # there happens to only be 1 entry
            SELECT
                (DISTINCT (Issue.time_spent_log UNION L)) {
                    body
                };
            `,
      [
            {
              "body": "Rewriting everything.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_13a", () => {
    assertQueryResult(
      h,
      `
            WITH
                L := LogEntry
            SELECT
                (Issue.time_spent_log UNION L, Issue).0 {
                    body
                };
            `,
      [
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_13b", () => {
    assertQueryResult(
      h,
      `
            WITH
                L := LogEntry  # there happens to only be 1 entry
            SELECT
                (SELECT (Issue.time_spent_log UNION L, Issue)).0 {
                    body
                };
            `,
      [
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_13c", () => {
    assertQueryResult(
      h,
      `
            SELECT
                (Issue.time_spent_log UNION LogEntry, Issue).0
                {
                    body
                };
            `,
      [
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Rewriting everything.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_14", () => {
    h.script(
      "\n                SELECT {\n                    Issue{number := 'foo'}, Issue\n                }.number;\n                "
    );
  });

  it("test_edgeql_select_interpreter_setops_15", () => {
    h.script(
      "\n                WITH\n                    I := Issue{number := 'foo'}\n                SELECT {I, Issue}.number;\n                "
    );
  });

  it("test_edgeql_select_interpreter_setops_16", () => {
    assertQueryResult(
      h,
      `
            # Named doesn't have a property number.
            SELECT Issue[IS Named].number;
            `,
      unorderedSet(["1", "2", "3", "4"])
    );
  });

  it("test_edgeql_select_interpreter_setops_18", () => {
    assertQueryResult(
      h,
      `
            # UNION between Issue and empty set Named should be
            # duck-typed to be effectively equivalent to Issue[IS Named].
            SELECT (Issue UNION <Named>{}).name;
            `,
      unorderedSet(["Improve EdgeDB repl output rendering.", "Regression.", "Release EdgeDB", "Repl tweak."])
    );
  });

  it("test_edgeql_select_interpreter_setops_19", () => {
    assertQueryResult(
      h,
      `
            # UNION between Issue and empty set Issue should be
            # duck-typed to be effectively equivalent to Issue[IS
            # Issue], which is just an Issue.
            SELECT (Issue UNION <Issue>{}).name;
            `,
      unorderedSet(["Improve EdgeDB repl output rendering.", "Regression.", "Release EdgeDB", "Repl tweak."])
    );
    assertQueryResult(
      h,
      `
            SELECT (Issue UNION <Issue>{}).number;
            `,
      unorderedSet(["1", "2", "3", "4"])
    );
  });

  it("test_edgeql_select_interpreter_setops_24", () => {
    assertQueryResult(
      h,
      `
            with A := Owned except {LogEntry, Comment}
            select all(A in Issue) and all(Issue in A)
            `,
      unorderedSet([true])
    );
    assertQueryResult(
      h,
      `
            with A := Owned intersect Issue
            select all(A in Owned[is Issue]) and all(Owned[is Issue] in A)
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_select_interpreter_setops_25", () => {
    assertQueryResult(
      h,
      `
            with
              A := (select Issue filter .name ilike '%edgedb%'),
              B := (select Issue filter .owner.name = 'Elvis')
            select (B except A) {name};
            `,
      [
            {
              "name": "Regression.",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            with
              A := (select Issue filter .name ilike '%edgedb%'),
              B := (select Issue filter .owner.name = 'Elvis')
            select (B intersect A) {name};
            `,
      [
            {
              "name": "Release EdgeDB",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_26", () => {
    assertQueryResult(
      h,
      `
            select (Issue except Named);
            `,
      []
    );
    assertQueryResult(
      h,
      `
            select (Issue intersect <Named>{});
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_setops_27", () => {
    assertQueryResult(
      h,
      `
            with
                A := (select Issue filter .name not ilike '%edgedb%').body
            select _ :=
                str_lower(array_unpack(str_split(A, ' ')))
                except
                {'minor', 'fix', 'lexer'}
            order by _
            `,
      ["by", "introduced", "lexer", "regression", "tweak.", "tweaks."]
    );
    assertQueryResult(
      h,
      `
            with A := (select Issue filter .name not ilike '%edgedb%')
            select _ :=
              str_lower(array_unpack(str_split(A.body, ' ')))
              except
              str_lower(array_unpack(str_split(A.name, ' ')))
            order by _
            `,
      [
            "by",
            "fix",
            "introduced",
            "lexer",
            "lexer",
            "minor",
            "regression",
            "tweaks.",
          ]
    );
  });

  it("test_edgeql_select_interpreter_setops_28", () => {
    assertQueryResult(
      h,
      `
            select _ :=
              len(array_unpack(str_split(Issue.body, ' ')))
              intersect {1, 2, 2, 3, 3, 3, 7, 7, 7, 7, 7, 7, 7}
            order by _
            `,
      [
            2,
            2,
            3,
            7,
            7,
            7,
            7,
            7,
            7,
          ]
    );
    assertQueryResult(
      h,
      `
            select _ :=
              str_lower(array_unpack(str_split(Issue.name, ' ')))
              except
              str_lower(array_unpack(str_split(Issue.body, ' ')))
            order by _
            `,
      [
            "edgedb",
            "edgedb",
            "improve",
            "output",
            "regression.",
            "rendering.",
            "repl",
            "repl",
          ]
    );
  });

  it("test_edgeql_select_interpreter_order_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {name}
            ORDER BY Issue.priority.name ASC EMPTY LAST THEN Issue.name;
            `,
      [
            {
              "name": "Improve EdgeDB repl output rendering.",
            },
            {
              "name": "Repl tweak.",
            },
            {
              "name": "Regression.",
            },
            {
              "name": "Release EdgeDB",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Issue {name}
            ORDER BY Issue.priority.name ASC EMPTY FIRST THEN Issue.name;
            `,
      [
            {
              "name": "Regression.",
            },
            {
              "name": "Release EdgeDB",
            },
            {
              "name": "Improve EdgeDB repl output rendering.",
            },
            {
              "name": "Repl tweak.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_order_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Text {body}
            ORDER BY len(Text.body) DESC;
            `,
      [
            {
              "body": "We need to be able to render data in tabular format.",
            },
            {
              "body": "Fix regression introduced by lexer tweak.",
            },
            {
              "body": "Initial public release of EdgeDB.",
            },
            {
              "body": "EdgeDB needs to happen soon.",
            },
            {
              "body": "Rewriting everything.",
            },
            {
              "body": "Minor lexer tweaks.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_order_03", () => {
    assertQueryResult(
      h,
      `
            SELECT User {name}
            ORDER BY (
                SELECT sum(<int64>User.<watchers[IS Issue].number)
            );
            `,
      [
            {
              "name": "Yury",
            },
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_where_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            # issue where the owner also has a comment with non-empty body
            FILTER Issue.owner.<owner[IS Comment].body != ''
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_where_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            # issue where the owner also has a comment to it
            FILTER Issue.owner.<owner[IS Comment].issue = Issue;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_where_03", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                name,
                number,
                owner: {
                    name
                },
                status: {
                    name
                }
            } FILTER len(Issue.status.name) = 4
            ORDER BY Issue.number;
            `,
      [
            {
              "owner": {
                "name": "Elvis",
              },
              "status": {
                "name": "Open",
              },
              "name": "Release EdgeDB",
              "number": "1",
            },
            {
              "owner": {
                "name": "Yury",
              },
              "status": {
                "name": "Open",
              },
              "name": "Improve EdgeDB repl output rendering.",
              "number": "2",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_func_01", () => {
    assertQueryResult(
      h,
      `
            SELECT std::len(User.name) ORDER BY User.name;
            `,
      [5, 4]
    );
    assertQueryResult(
      h,
      `
            SELECT std::sum(<std::int64>Issue.number);
            `,
      [10]
    );
  });

  it("test_edgeql_select_interpreter_exists_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number
                }
            FILTER
                NOT EXISTS Issue.time_estimate
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number
                }
            FILTER
                EXISTS Issue.time_estimate
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_02", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number
                }
            FILTER
                NOT EXISTS (Issue.<issue[IS Comment])
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_03", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number
                }
            FILTER
                NOT EXISTS (SELECT Issue.<issue[IS Comment])
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_04", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number
                }
            FILTER
                EXISTS (Issue.<issue[IS Comment])
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_05", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority           # has Priority [2, 3]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_06", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority.id        # has Priority [2, 3]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_07", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.<issue             # has Comment [1]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_08", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.<issue.id          # has Comment [1]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_09", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority       # has no Priority [1, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_10", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority.id    # has no Priority [1, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_11", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.<issue         # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_12", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.<issue.id      # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_13", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            # issue where the owner also has a comment
            FILTER EXISTS Issue.owner.<owner[IS Comment]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_14", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            # issue where the owner also has a comment to it
            FILTER
                EXISTS (
                    SELECT Comment
                    FILTER
                        Comment.owner = Issue.owner
                        AND
                        Comment.issue = Issue
                )
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_15", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            # issue where the owner also has a comment, but not to the
            # issue itself
            FILTER
                EXISTS (
                    SELECT Comment
                    FILTER
                        Comment.owner = Issue.owner
                        AND
                        Comment.issue != Issue
                )
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_16", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            # issue where the owner also has a comment, but not to the
            # issue itself
            FILTER
                EXISTS (
                    SELECT Comment
                    FILTER
                        Comment.owner = Issue.owner
                        AND
                        Comment.issue.id != Issue.id
                )
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_17", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            # issue where the owner also has a comment, but not to the
            # issue itself
            FILTER
                EXISTS (
                    SELECT Comment
                    FILTER
                        Comment.owner = Issue.owner
                        AND
                        NOT Comment.issue = Issue
                )
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_exists_18", () => {
    assertQueryResult(
      h,
      `
            SELECT EXISTS (
                SELECT Issue
                FILTER Issue.status.name = 'Open'
            );
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_coalesce_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                kind := Issue.priority.name ?? Issue.status.name
            }
            ORDER BY Issue.number;
            `,
      [
            {
              "kind": "Open",
            },
            {
              "kind": "High",
            },
            {
              "kind": "Low",
            },
            {
              "kind": "Closed",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_coalesce_03", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                Issue.priority.name ?? 'High' = 'High'
            ORDER BY
                Issue.priority.name EMPTY LAST THEN Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_equivalence_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
                h1 := Issue.priority.name = 'High',
                h2 := Issue.priority.name ?= 'High',
                l1 := Issue.priority.name != 'High',
                l2 := Issue.priority.name ?!= 'High'
            }
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "h1": null,
              "h2": false,
              "l1": null,
              "l2": true,
            },
            {
              "number": "2",
              "h1": true,
              "h2": true,
              "l1": false,
              "l2": false,
            },
            {
              "number": "3",
              "h1": false,
              "h2": false,
              "l1": true,
              "l2": true,
            },
            {
              "number": "4",
              "h1": null,
              "h2": false,
              "l1": null,
              "l2": true,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_equivalence_02", () => {
    assertQueryResult(
      h,
      `
            # get Issues such that there's another Issue with
            # equivalent priority
            WITH
                I2 := Issue
            SELECT Issue {number}
            FILTER
                I2 != Issue
                AND
                I2.priority.name ?= Issue.priority.name
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_equivalence_03", () => {
    assertQueryResult(
      h,
      `
            # get Issues with priority equivalent to empty
            SELECT Issue {number}
            FILTER
                Issue.priority.name ?= <str>{}
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_equivalence_04", () => {
    assertQueryResult(
      h,
      `
            # get Issues with priority equivalent to empty
            SELECT Issue {number}
            FILTER
                NOT Issue.priority.name ?!= <str>{}
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_as_01", () => {
    assertQueryResult(
      h,
      `
            SELECT (SELECT T := Text[IS Issue] ORDER BY T.body).number;
            `,
      ["4", "1", "3", "2"]
    );
  });

  it("test_edgeql_select_interpreter_as_02", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT T := Text[IS Issue]
                FILTER T.body LIKE '%EdgeDB%'
                ORDER BY T.name
            ).name;
            `,
      ["Release EdgeDB"]
    );
  });

  it("test_edgeql_select_interpreter_and_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority           # has Priority [2, 3]
                AND
                EXISTS Issue.<issue             # has Comment [1]
            ORDER BY Issue.number;
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_and_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority.id        # has Priority [2, 3]
                AND
                EXISTS Issue.<issue             # has Comment [1]
            ORDER BY Issue.number;
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_and_03", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority       # has no Priority [1, 4]
                AND
                NOT EXISTS Issue.<issue         # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_04", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority.id    # has no Priority [1, 4]
                AND
                NOT EXISTS Issue.<issue         # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_05", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority       # has no Priority [1, 4]
                AND
                EXISTS Issue.<issue             # has Comment [1]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_06", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority       # has no Priority [1, 4]
                AND
                EXISTS Issue.<issue.id          # has Comment [1]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_07", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority           # has Priority [2, 3]
                AND
                NOT EXISTS Issue.<issue         # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_08", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority           # has Priority [2, 3]
                AND
                NOT EXISTS Issue.<issue.id      # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_09", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                val,
                x := .val < 5 and .name like '%on'
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "val": 2,
              "x": false,
            },
            {
              "name": "hexagon",
              "val": 4,
              "x": true,
            },
            {
              "name": "pentagon",
              "val": null,
              "x": null,
            },
            {
              "name": "square",
              "val": null,
              "x": null,
            },
            {
              "name": "triangle",
              "val": 10,
              "x": false,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_10", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                val,
                x := not (.val < 5 and .name like '%on')
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "val": 2,
              "x": true,
            },
            {
              "name": "hexagon",
              "val": 4,
              "x": false,
            },
            {
              "name": "pentagon",
              "val": null,
              "x": null,
            },
            {
              "name": "square",
              "val": null,
              "x": null,
            },
            {
              "name": "triangle",
              "val": 10,
              "x": true,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_11", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                tags,
                x := (
                    select _ := .tags = 'red' and .name like '%a%' order by _
                )
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "tags": unorderedSet(["black", "red"]),
              "x": [false, false],
            },
            {
              "name": "hexagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "pentagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "square",
              "tags": unorderedSet(["red"]),
              "x": [true],
            },
            {
              "name": "triangle",
              "tags": unorderedSet(["green", "red"]),
              "x": [false, true],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_and_12", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                tags,
                x := (
                    select _ := not (.tags = 'red' and .name like '%a%')
                    order by _
                )
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "tags": unorderedSet(["black", "red"]),
              "x": [true, true],
            },
            {
              "name": "hexagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "pentagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "square",
              "tags": unorderedSet(["red"]),
              "x": [false],
            },
            {
              "name": "triangle",
              "tags": unorderedSet(["green", "red"]),
              "x": [false, true],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                Issue.priority.name = 'High'
                OR
                Issue.priority.name = 'Low'
            ORDER BY Issue.priority.name THEN Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_04", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                Issue.priority.name = 'High'
                OR
                Issue.status.name = 'Closed'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                Issue.priority.name = 'High'
                OR
                Issue.priority.name = 'Low'
                OR
                Issue.status.name = 'Closed'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                Issue.priority.name IN {'High', 'Low'}
                OR
                Issue.status.name = 'Closed'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_05", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority.id
                OR
                Issue.status.name = 'Closed'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            # should be identical
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority
                OR
                Issue.status.name = 'Closed'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_06", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority           # has Priority [2, 3]
                OR
                EXISTS Issue.<issue             # has Comment [1]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_07", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority.id        # has Priority [2, 3]
                OR
                EXISTS Issue.<issue             # has Comment [1]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_08", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority       # has no Priority [1, 4]
                OR
                NOT EXISTS Issue.<issue         # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
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
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_09", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority.id    # has no Priority [1, 4]
                OR
                NOT EXISTS Issue.<issue         # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
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
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_10", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority       # has no Priority [1, 4]
                OR
                EXISTS Issue.<issue             # has Comment [1]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_11", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT EXISTS Issue.priority       # has no Priority [1, 4]
                OR
                EXISTS Issue.<issue.id          # has Comment [1]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_12", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority           # has Priority [2, 3]
                OR
                NOT EXISTS Issue.<issue         # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_13", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                EXISTS Issue.priority           # has Priority [2, 3]
                OR
                NOT EXISTS Issue.<issue.id      # has no Comment [2, 3, 4]
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_14", () => {
    assertQueryResult(
      h,
      `
            # Find Issues that have status 'Closed' or number 2 or 3
            #
            SELECT Issue{number}
            FILTER
                Issue.status.name = 'Closed'
                OR
                Issue.number = '2'
                OR
                Issue.number = '3'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_15", () => {
    assertQueryResult(
      h,
      `
            # Find Issues that have status 'Closed' or number 2 or 3
            #
            SELECT Issue{number}
            FILTER
                (
                    # Issues 2, 3, 4 satisfy this subclause
                    Issue.status.name = 'Closed'
                    OR
                    Issue.number = '2'
                    OR
                    Issue.number = '3'
                ) AND (
                    # Issues 1, 2, 3 satisfy this subclause
                    Issue.name ILIKE '%edgedb%'
                    OR
                    Issue.priority.name = 'Low'
                )
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_16", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                val,
                x := .val < 5 or .name like '%on'
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "val": 2,
              "x": true,
            },
            {
              "name": "hexagon",
              "val": 4,
              "x": true,
            },
            {
              "name": "pentagon",
              "val": null,
              "x": null,
            },
            {
              "name": "square",
              "val": null,
              "x": null,
            },
            {
              "name": "triangle",
              "val": 10,
              "x": false,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_17", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                val,
                x := not (.val < 5 or .name like '%on')
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "val": 2,
              "x": false,
            },
            {
              "name": "hexagon",
              "val": 4,
              "x": false,
            },
            {
              "name": "pentagon",
              "val": null,
              "x": null,
            },
            {
              "name": "square",
              "val": null,
              "x": null,
            },
            {
              "name": "triangle",
              "val": 10,
              "x": true,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_18", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                tags,
                x := (
                    select _ := .tags = 'red' or .name like '%t%a%' order by _
                )
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "tags": unorderedSet(["black", "red"]),
              "x": [false, true],
            },
            {
              "name": "hexagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "pentagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "square",
              "tags": unorderedSet(["red"]),
              "x": [true],
            },
            {
              "name": "triangle",
              "tags": unorderedSet(["green", "red"]),
              "x": [true, true],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_or_19", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                tags,
                x := (
                    select _ := not (.tags = 'red' or .name like '%t%a%')
                    order by _
                )
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "tags": unorderedSet(["black", "red"]),
              "x": [false, true],
            },
            {
              "name": "hexagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "pentagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "square",
              "tags": unorderedSet(["red"]),
              "x": [false],
            },
            {
              "name": "triangle",
              "tags": unorderedSet(["green", "red"]),
              "x": [false, false],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_not_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER NOT Issue.priority.name = 'High'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "3",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER Issue.priority.name != 'High'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_not_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER NOT NOT NOT Issue.priority.name = 'High'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "3",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER NOT NOT Issue.priority.name != 'High'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_not_03", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                NOT (
                    NOT Issue.priority.name = 'High'
                    AND
                    NOT Issue.status.name = 'Closed'
                )
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_not_04", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                val,
                x := not (.val < 5)
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "val": 2,
              "x": false,
            },
            {
              "name": "hexagon",
              "val": 4,
              "x": false,
            },
            {
              "name": "pentagon",
              "val": null,
              "x": null,
            },
            {
              "name": "square",
              "val": null,
              "x": null,
            },
            {
              "name": "triangle",
              "val": 10,
              "x": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                val,
                x := not not (.val < 5)
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "val": 2,
              "x": true,
            },
            {
              "name": "hexagon",
              "val": 4,
              "x": true,
            },
            {
              "name": "pentagon",
              "val": null,
              "x": null,
            },
            {
              "name": "square",
              "val": null,
              "x": null,
            },
            {
              "name": "triangle",
              "val": 10,
              "x": false,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_not_05", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                tags,
                x := (select _ := not (.tags = 'red') order by _)
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "tags": unorderedSet(["black", "red"]),
              "x": [false, true],
            },
            {
              "name": "hexagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "pentagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "square",
              "tags": unorderedSet(["red"]),
              "x": [false],
            },
            {
              "name": "triangle",
              "tags": unorderedSet(["green", "red"]),
              "x": [false, true],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                tags,
                x := (select _ := not not (.tags = 'red') order by _)
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "tags": unorderedSet(["black", "red"]),
              "x": [false, true],
            },
            {
              "name": "hexagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "pentagon",
              "tags": [],
              "x": [],
            },
            {
              "name": "square",
              "tags": unorderedSet(["red"]),
              "x": [true],
            },
            {
              "name": "triangle",
              "tags": unorderedSet(["green", "red"]),
              "x": [false, true],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_empty_01", () => {
    assertQueryResult(
      h,
      `
            # This is not the same as checking that number does not EXIST.
            # Any binary operator with one operand as empty results in an
            # empty result, because the cross product of anything with an
            # empty set is empty.
            SELECT Issue.number = <str>{};
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_empty_02", () => {
    assertQueryResult(
      h,
      `
            # Test short-circuiting operations with empty
            SELECT Issue.number = '1' OR <bool>{};
            `,
      []
    );
    assertQueryResult(
      h,
      `
            SELECT Issue.number = 'X' OR <bool>{};
            `,
      []
    );
    assertQueryResult(
      h,
      `
            SELECT Issue.number = '1' AND <bool>{};
            `,
      []
    );
    assertQueryResult(
      h,
      `
            SELECT Issue.number = 'X' AND <bool>{};
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_empty_03", () => {
    assertQueryResult(
      h,
      `
            # Test short-circuiting operations with empty
            SELECT count(Issue.number = '1' OR <bool>{});
            `,
      [0]
    );
    assertQueryResult(
      h,
      `
            SELECT count(Issue.number = 'X' OR <bool>{});
            `,
      [0]
    );
    assertQueryResult(
      h,
      `
            SELECT count(Issue.number = '1' AND <bool>{});
            `,
      [0]
    );
    assertQueryResult(
      h,
      `
            SELECT count(Issue.number = 'X' AND <bool>{});
            `,
      [0]
    );
  });

  it("test_edgeql_select_interpreter_empty_04", () => {
    assertQueryResult(
      h,
      `
            # Perfectly legal way to mask 'time_estimate' with empty set.
            SELECT Issue {
                number,
                time_estimate := <int64>{}
            } ORDER BY .number;
            `,
      [
            {
              "number": "1",
              "time_estimate": null,
            },
            {
              "number": "2",
              "time_estimate": null,
            },
            {
              "number": "3",
              "time_estimate": null,
            },
            {
              "number": "4",
              "time_estimate": null,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_empty_object_01", () => {
    assertQueryResult(
      h,
      `
            SELECT <Issue>{}
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_empty_object_02", () => {
    assertQueryResult(
      h,
      `
            SELECT NOT EXISTS (<Issue>{})
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_empty_object_03", () => {
    assertQueryResult(
      h,
      `
            SELECT ((SELECT Issue FILTER false) ?= <Issue>{})
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_empty_object_04", () => {
    assertQueryResult(
      h,
      `
            SELECT count(<Issue>{}) = 0
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_cross_01", () => {
    assertQueryResult(
      h,
      `
            # the cross product of status and priority names
            SELECT Status.name ++ Priority.name
            ORDER BY Status.name THEN Priority.name;
            `,
      ["ClosedHigh", "ClosedLow", "OpenHigh", "OpenLow"]
    );
  });

  it("test_edgeql_select_interpreter_cross_02", () => {
    assertQueryResult(
      h,
      `
            # status and priority name for each issue
            SELECT Issue.status.name ++ Issue.priority.name
            ORDER BY Issue.number;
            `,
      ["OpenHigh", "ClosedLow"]
    );
  });

  it("test_edgeql_select_interpreter_cross_03", () => {
    assertQueryResult(
      h,
      `
            # cross-product of all user names and issue numbers
            SELECT User.name ++ Issue.number
            ORDER BY User.name THEN Issue.number;
            `,
      [
            "Elvis1",
            "Elvis2",
            "Elvis3",
            "Elvis4",
            "Yury1",
            "Yury2",
            "Yury3",
            "Yury4",
          ]
    );
  });

  it("test_edgeql_select_interpreter_cross_04", () => {
    assertQueryResult(
      h,
      `
            # concatenate the user name with every issue number that user has
            SELECT User.name ++ User.<owner[IS Issue].number
            ORDER BY User.name THEN User.<owner[IS Issue].number;
            `,
      ["Elvis1", "Elvis4", "Yury2", "Yury3"]
    );
  });

  it("test_edgeql_select_interpreter_cross05", () => {
    assertQueryResult(
      h,
      `
            # tuples will not exist for the Issue without watchers
            SELECT _ := (Issue.owner.name, Issue.watchers.name)
            ORDER BY _;
            `,
      [
            ["Elvis", "Yury"],
            ["Yury", "Elvis"],
            ["Yury", "Elvis"],
          ]
    );
  });

  it("test_edgeql_select_interpreter_cross06", () => {
    assertQueryResult(
      h,
      `
            # tuples will not exist for the Issue without watchers
            SELECT _ := Issue.owner.name ++ Issue.watchers.name
            ORDER BY _;
            `,
      ["ElvisYury", "YuryElvis", "YuryElvis"]
    );
  });

  it("test_edgeql_select_interpreter_cross_07", () => {
    assertQueryResult(
      h,
      `
            SELECT _ := count(Issue.owner.name ++ Issue.watchers.name);
            `,
      [3]
    );
    assertQueryResult(
      h,
      `
            SELECT _ := count(DISTINCT (
                Issue.owner.name ++ Issue.watchers.name));
            `,
      [2]
    );
  });

  it("test_edgeql_select_interpreter_cross08", () => {
    assertQueryResult(
      h,
      `
            SELECT _ := Issue.owner.name ++ <str>count(Issue.watchers.name)
            ORDER BY _;
            `,
      ["Elvis0", "Elvis1", "Yury1", "Yury1"]
    );
  });

  it("test_edgeql_select_interpreter_cross_09", () => {
    assertQueryResult(
      h,
      `
            SELECT _ := count(
                Issue.owner.name ++ <str>count(Issue.watchers.name));
            `,
      [4]
    );
  });

  it("test_edgeql_select_interpreter_cross_10", () => {
    assertQueryResult(
      h,
      `
            WITH
                # this select shows all the relevant data for next tests
                x := (SELECT Issue {
                    name := Issue.owner.name,
                    w := count(Issue.watchers.name),
                })
            SELECT count(x.name ++ <str>x.w);
            `,
      [4]
    );
  });

  it("test_edgeql_select_interpreter_cross_11", () => {
    assertQueryResult(
      h,
      `
            SELECT count(
                Issue.owner.name ++
                <str>count(Issue.watchers) ++
                <str>Issue.time_estimate ?? '0'
            );
            `,
      [4]
    );
  });

  it("test_edgeql_select_interpreter_cross_12", () => {
    assertQueryResult(
      h,
      `
            SELECT count(
                Issue.owner.name ++
                <str>count(Issue.watchers) ++
                <str>Issue.time_estimate
            );
            `,
      [1]
    );
  });

  it("test_edgeql_select_interpreter_cross_13", () => {
    assertQueryResult(
      h,
      `
            SELECT count(count(Issue.watchers));
            `,
      [1]
    );
    assertQueryResult(
      h,
      `
            SELECT count(
                (Issue, count(Issue.watchers))
            );
            `,
      [4]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_01", () => {
    assertQueryResult(
      h,
      `
            WITH
                Issue2 := Issue
            # this is string concatenation, not integer arithmetic
            SELECT Issue.number ++ Issue2.number
            ORDER BY Issue.number ++ Issue2.number;
            `,
      [
            "11",
            "12",
            "13",
            "14",
            "21",
            "22",
            "23",
            "24",
            "31",
            "32",
            "33",
            "34",
            "41",
            "42",
            "43",
            "44",
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{number}
            FILTER
                Issue.number IN {'2', '3', '4'}
                AND
                EXISTS (
                    # due to common prefix, the Issue referred to here is
                    # the same Issue as in the LHS of AND, therefore
                    # this condition can never be true
                    SELECT Issue FILTER Issue.number IN {'1', '6'}
                );
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_subqueries_03", () => {
    assertQueryResult(
      h,
      `
            WITH
                sub := (
                    SELECT Issue FILTER Issue.number IN {'1', '6'}
                )
            SELECT Issue{number}
            FILTER
                Issue.number IN {'2', '3', '4'}
                AND
                EXISTS (
                    (SELECT sub FILTER sub = Issue)
                );
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_subqueries_04", () => {
    assertQueryResult(
      h,
      `
            WITH
                sub := (
                    SELECT
                        Issue
                    FILTER
                        Issue.number IN {'1', '6'}
                )
            SELECT
                Issue{number}
            FILTER
                Issue.number IN {'2', '3', '4'}
                AND
                EXISTS sub
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_05", () => {
    assertQueryResult(
      h,
      `
            # find all issues such that there's at least one more
            # issue with the same priority
            WITH
                Issue2 := (SELECT Issue)
            SELECT
                Issue {
                    number
                }
            FILTER
                Issue != Issue2
                AND
                # NOTE: this condition is false when one of the sides is empty
                Issue.priority = Issue2.priority
            ORDER BY
                Issue.number;
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_subqueries_06", () => {
    assertQueryResult(
      h,
      `
            # find all issues such that there's at least one more
            # issue with the same priority (even if the "same" means empty)
            WITH
                Issue2 := Issue
            SELECT
                Issue {
                    number
                }
            FILTER
                Issue != Issue2 AND Issue.priority ?= Issue2.priority
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_07", () => {
    assertQueryResult(
      h,
      `
            # find all issues such that there's at least one more
            # issue watched by the same user as this one
            SELECT Issue{number}
            FILTER
                EXISTS Issue.watchers
                AND
                EXISTS (
                    (SELECT
                        User
                     FILTER
                        User = Issue.watchers AND
                        User.<watchers != Issue
                    ).<watchers
                )
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_08", () => {
    assertQueryResult(
      h,
      `
            # find all issues such that there's at least one more
            # issue watched by the same user as this one
            SELECT Issue{number}
            FILTER
                EXISTS Issue.watchers
                AND
                EXISTS (
                    SELECT Text
                    FILTER
                        Text IS Issue
                        AND
                        Text[IS Issue].watchers = Issue.watchers
                        AND
                        Text != Issue
                )
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_09", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue.number ++ (SELECT Issue.number);
            `,
      unorderedSet(["11", "22", "33", "44"])
    );
  });

  it("test_edgeql_select_interpreter_subqueries_10", () => {
    assertQueryResult(
      h,
      `
            WITH
                sub := (SELECT Issue.number)
            SELECT
                Issue.number ++ sub;
            `,
      unorderedSet([
            "11",
            "12",
            "13",
            "14",
            "21",
            "22",
            "23",
            "24",
            "31",
            "32",
            "33",
            "34",
            "41",
            "42",
            "43",
            "44",
          ])
    );
  });

  it("test_edgeql_select_interpreter_subqueries_12", () => {
    assertQueryResult(
      h,
      `
            # same as above, but also include the body_length computable
            SELECT Issue{
                number,
                body_length := len(Issue.body)
            }
            FILTER
                EXISTS (
                    SELECT Text
                    FILTER
                        Text != Issue
                        AND
                        (len(Text.body) - len(Issue.body)) ^ 2 <= 25
                )
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "body_length": 33,
            },
            {
              "number": "3",
              "body_length": 19,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_13", () => {
    assertQueryResult(
      h,
      `
            SELECT User{name}
            FILTER
                EXISTS (
                    SELECT Comment
                    FILTER
                        Comment.owner = User
                );
            `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_14", () => {
    assertQueryResult(
      h,
      `
            SELECT User{name}
            FILTER
                EXISTS (
                    SELECT Comment
                    FILTER
                        Comment.owner = User
                # adding a required link to an EXISTS should not alter
                # the result
                ).owner;
            `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_15", () => {
    assertQueryResult(
      h,
      `
            # Find all issues such that there's at least one more
            # issue watched by the same user as this one, this user
            # must have at least one Comment.
            SELECT Issue {
                number
            }
            FILTER
                EXISTS Issue.watchers AND
                EXISTS (
                    SELECT
                        User
                    FILTER
                        # The User is among the watchers of this Issue
                        User = Issue.watchers AND
                        # and they also watch some other Issue other than this
                        User.<watchers[IS Issue] != Issue AND
                        # and they also have at least one comment
                        EXISTS (
                            SELECT Comment FILTER Comment.owner = User
                        )
                )
            ORDER BY
                Issue.number;
            `,
      [
            {
              "number": "2",
            },
            {
              "number": "3",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_16", () => {
    assertQueryResult(
      h,
      `
            # testing IN and a subquery
            SELECT Comment{body}
            FILTER
                Comment.owner IN (
                    SELECT User
                    FILTER
                        User.name = 'Elvis'
                );
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_17", () => {
    assertQueryResult(
      h,
      `
            # get a comment whose owner is part of the users who own Issue "1"
            SELECT Comment{body}
            FILTER
                Comment.owner IN (
                    SELECT User
                    FILTER
                        User.<owner IN (
                            SELECT Issue
                            FILTER
                                Issue.number = '1'
                        )
                );
            `,
      [
            {
              "body": "EdgeDB needs to happen soon.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subqueries_18", () => {
    assertQueryResult(
      h,
      `
            # here, DETACHED doesn't do anything special, because the
            # symbol U2 is reused on both sides of '+'
            WITH
                U2 := DETACHED User
            SELECT U2.name ++ U2.name;
            `,
      unorderedSet(["ElvisElvis", "YuryYury"])
    );
    assertQueryResult(
      h,
      `
            # DETACHED is reused on both sides of '+' directly
            SELECT (DETACHED User).name ++ (DETACHED User).name;
            `,
      unorderedSet(["ElvisElvis", "ElvisYury", "YuryElvis", "YuryYury"])
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_01", () => {
    assertQueryResult(
      h,
      `
            # Direct reference to a computable element in a subquery
            SELECT
                (
                    SELECT User {
                        num_issues := count(User.<owner[IS Issue])
                    } FILTER .name = 'Elvis'
                ).num_issues;
            `,
      [2]
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_02", () => {
    assertQueryResult(
      h,
      `
            # Reference to a computable element in a subquery
            # defined as an alias.
            WITH U := (
                    SELECT User {
                        num_issues := count(User.<owner[IS Issue])
                    } FILTER .name = 'Elvis'
                )
            SELECT
                U.num_issues;
            `,
      [2]
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_03", () => {
    assertQueryResult(
      h,
      `
            # Reference a computed object set in an alias.
            WITH U := (
                    WITH U2 := User
                    SELECT User {
                        friend := (
                            SELECT U2 FILTER U2.name = 'Yury'
                        )
                    } FILTER .name = 'Elvis'
                )
            SELECT
                U.friend.name;
            `,
      ["Yury"]
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_05", () => {
    assertQueryResult(
      h,
      `
            # Reference multiple aliases.
            WITH U := (
                    SELECT User FILTER User.name = 'Elvis'
                ),
                I := (
                    SELECT Issue FILTER Issue.number = '1'
                )
            SELECT
                I.owner = U;
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_06", () => {
    assertQueryResult(
      h,
      `
            # Reference another alias from an alias.
            WITH U := (
                    SELECT User FILTER User.name = 'Elvis'
                ),
                I := (
                    SELECT Issue FILTER Issue.owner = U
                )
            SELECT
                I.number
            ORDER BY
                I.number;
            `,
      ["1", "4"]
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_07", () => {
    assertQueryResult(
      h,
      `
            # A combination of the above two.
            WITH U := (
                    SELECT User FILTER User.name = 'Elvis'
                ),
                I := (
                    SELECT Issue FILTER Issue.owner = U
                )
            SELECT
                I
            FILTER
                I.owner != U
            ORDER BY
                I.number;
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_09", () => {
    assertQueryResult(
      h,
      `
            WITH
                sub := (
                    SELECT
                        Text {
                            foo := Text.body ++ '!'
                        }
                    ORDER BY
                        len(Text.body) ASC
                    LIMIT 1
                )
            SELECT
                User {
                    name,
                    shortest_text_shape := sub {
                        body,
                        foo
                    }
                }
            FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "shortest_text_shape": {
                "body": "Minor lexer tweaks.",
                "foo": "Minor lexer tweaks.!",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_10", () => {
    assertQueryResult(
      h,
      `
            WITH
                sub := (
                    SELECT
                        Text {
                            foo := Text.body ++ '!'
                        }
                    ORDER BY
                        len(Text.body) ASC
                    LIMIT 1
                )
            SELECT
                User {
                    name,
                    shortest_text_foo := sub.foo
                }
            FILTER User.name = 'Elvis';
            `,
      [
            {
              "name": "Elvis",
              "shortest_text_foo": "Minor lexer tweaks.!",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_alias_indirection_11", () => {
    assertQueryResult(
      h,
      `
            WITH
                Developers := (
                    SELECT
                        User {
                            open_issues := (
                                SELECT
                                    Issue {
                                        spent_time := (
                                            SELECT
                                                sum(Issue.time_spent_log
                                                         .spent_time)
                                        )
                                    }
                                FILTER
                                    Issue.owner = User
                            )
                        }
                    FILTER
                        User.name IN {'Elvis', 'Yury'}
                )
            SELECT
                Developers {
                    name,
                    open_issues: {
                        number,
                        spent_time
                    } ORDER BY .number
                }
            ORDER BY
                Developers.name;
            `,
      [
            {
              "name": "Elvis",
              "open_issues": [
                {
                  "number": "1",
                  "spent_time": 50000,
                },
                {
                  "number": "4",
                  "spent_time": 0,
                },
              ],
            },
            {
              "name": "Yury",
              "open_issues": [
                {
                  "number": "2",
                  "spent_time": 0,
                },
                {
                  "number": "3",
                  "spent_time": 0,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_slice_01", () => {
    assertQueryResult(
      h,
      `
            # full name of the Issue is 'Release EdgeDB'
            SELECT (
                SELECT Issue
                FILTER Issue.number = '1'
            ).name[2];
            `,
      ["l"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT Issue
                FILTER Issue.number = '1'
            ).name[-2];
            `,
      ["D"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT Issue
                FILTER Issue.number = '1'
            ).name[2:4];
            `,
      ["le"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT Issue
                FILTER Issue.number = '1'
            ).name[2:];
            `,
      ["lease EdgeDB"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT Issue
                FILTER Issue.number = '1'
            ).name[:2];
            `,
      ["Re"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT Issue
                FILTER Issue.number = '1'
            ).name[2:-1];
            `,
      ["lease EdgeD"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT Issue
                FILTER Issue.number = '1'
            ).name[-2:];
            `,
      ["DB"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT Issue
                FILTER Issue.number = '1'
            ).name[:-2];
            `,
      ["Release Edge"]
    );
  });

  it("test_edgeql_select_interpreter_slice_03", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                name,
                type_name := Issue.__type__.name,
                a := Issue.name[2],
                b := Issue.name[2:-1],
                c := Issue.__type__.name[2:-1],
            }
            FILTER Issue.number = '1';
            `,
      [
            {
              "name": "Release EdgeDB",
              "type_name": "default::Issue",
              "a": "l",
              "b": "lease EdgeD",
              "c": "fault::Issu",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_slice_04", () => {
    assertQueryResult(
      h,
      `
            select [1,2,3,4,5][1:];
            `,
      [
            [2, 3, 4, 5],
          ]
    );
    assertQueryResult(
      h,
      `
            select [1,2,3,4,5][:3];
            `,
      [
            [1, 2, 3],
          ]
    );
    assertQueryResult(
      h,
      `
            select [1,2,3][1:<int64>{}];
            `,
      []
    );
    assertQueryResult(
      h,
      `
            select [1,2,3][1:<optional int64>$0];
            `,
      []
    );
    assertQueryResult(
      h,
      `
            select [1,2,3][<optional int64>$0:2];
            `,
      []
    );
    assertQueryResult(
      h,
      `
            select [1,2,3][<optional int64>$0:<optional int64>$1];
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select to_json('[true, 3, 4, null]')[1:];
                `,
      ["[3, 4, null]"]
    );
    assertQueryResult(
      h,
      `
                select to_json('[true, 3, 4, null]')[:2];
                `,
      ["[true, 3]"]
    );
    assertQueryResult(
      h,
      `
            select (<optional json>$0)[2:];
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select to_json('"hello world"')[2:];
                `,
      ["\"llo world\""]
    );
    assertQueryResult(
      h,
      `
                select to_json('"hello world"')[:4];
                `,
      ["\"hell\""]
    );
    assertQueryResult(
      h,
      `
            select (<array<str>>[])[0:];
            `,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `select to_json('[]')[0:];`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `select [(1,'foo'), (2,'bar'), (3,'baz')][1:];`,
      [
            [
              [2, "bar"],
              [3, "baz"],
            ],
          ]
    );
    assertQueryResult(
      h,
      `select [(1,'foo'), (2,'bar'), (3,'baz')][:2];`,
      [
            [
              [1, "foo"],
              [2, "bar"],
            ],
          ]
    );
    assertQueryResult(
      h,
      `select [(1,'foo'), (2,'bar'), (3,'baz')][1:2];`,
      [
            [
              [2, "bar"],
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                select [(1,'foo'), (2,'bar'), (3,'baz')][<optional int64>$0:];
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select (<optional array<int32>>$0)[2];
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select (<optional str>$0)[2];
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select to_json(<optional str>$0)[2];
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select (<optional array<int32>>$0)[1:2];
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select (<optional str>$0)[1:2];
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select to_json(<optional str>$0)[1:2];
            `,
      []
    );
  });

  it("test_edgeql_select_interpreter_bigint_index_01", () => {
    expect(() => {
      h.script(
        "select [1, 2, 3][1099511627776];"
      );
    }).toThrow(new RegExp("array index 1099511627776 is out of bounds"));
    expect(() => {
      h.script(
        "select [1, 2, 3][-1099511627776];"
      );
    }).toThrow(new RegExp("array index -1099511627776 is out of bounds"));
    assertQueryResult(
      h,
      `select [1, 2, 3][0:1099511627776];`,
      [
            [1, 2, 3],
          ]
    );
    assertQueryResult(
      h,
      `select [1, 2, 3][0:-1099511627776];`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `select [1, 2, 3][-1099511627776:1099511627776];`,
      [
            [1, 2, 3],
          ]
    );
    assertQueryResult(
      h,
      `select [1, 2, 3][1099511627776:-1099511627776];`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `select [1, 2, 3][-1099511627776:-1099511627776];`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `select [1, 2, 3][1099511627776:1099511627776];`,
      [
            [],
          ]
    );
  });

  it("test_edgeql_select_interpreter_bigint_index_02", () => {
    expect(() => {
      h.script(
        "select \"Hello world!\"[1099511627776];"
      );
    }).toThrow(new RegExp("index 1099511627776 is out of bounds"));
    expect(() => {
      h.script(
        "select \"Hello world!\"[-1099511627776];"
      );
    }).toThrow(new RegExp("index -1099511627776 is out of bounds"));
    assertQueryResult(
      h,
      `select "Hello world!"[6:1099511627776];`,
      ["world!"]
    );
    assertQueryResult(
      h,
      `select "Hello world!"[6:-1099511627776];`,
      [""]
    );
    assertQueryResult(
      h,
      `select "Hello world!"[-1099511627776:1099511627776];`,
      ["Hello world!"]
    );
    assertQueryResult(
      h,
      `select "Hello world!"[1099511627776:-1099511627776];`,
      [""]
    );
    assertQueryResult(
      h,
      `select "Hello world!"[-1099511627776:-1099511627776];`,
      [""]
    );
    assertQueryResult(
      h,
      `select "Hello world!"[1099511627776:1099511627776];`,
      [""]
    );
  });

  it("test_edgeql_select_interpreter_bigint_index_03", () => {
    expect(() => {
      h.script(
        "select to_json(\"[1, 2, 3]\")[1099511627776];"
      );
    }).toThrow(new RegExp("index 1099511627776 is out of bounds"));
    expect(() => {
      h.script(
        "select to_json(\"[1, 2, 3]\")[-1099511627776];"
      );
    }).toThrow(new RegExp("index -1099511627776 is out of bounds"));
    assertQueryResult(
      h,
      `select to_json("[1, 2, 3]")[1:1099511627776];`,
      [
            [2, 3],
          ]
    );
    assertQueryResult(
      h,
      `select to_json("[1, 2, 3]")[1:-1099511627776];`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `select to_json("[1, 2, 3]")[-1099511627776:1099511627776];`,
      [
            [1, 2, 3],
          ]
    );
    assertQueryResult(
      h,
      `select to_json("[1, 2, 3]")[1099511627776:-1099511627776];`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `select to_json("[1, 2, 3]")[-1099511627776:-1099511627776];`,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `select to_json("[1, 2, 3]")[1099511627776:1099511627776];`,
      [
            [],
          ]
    );
  });

  it("test_edgeql_select_interpreter_tuple_01", () => {
    assertQueryResult(
      h,
      `
            # get tuples (status, number of issues)
            SELECT (Status.name, count(Status.<status))
            ORDER BY Status.name;
            `,
      [
            ["Closed", 2],
            ["Open", 2],
          ]
    );
  });

  it("test_edgeql_select_interpreter_tuple_02", () => {
    assertQueryResult(
      h,
      `
            # nested tuples
            SELECT
                _ := (
                    User.name, (
                        User.<owner[IS Issue].status.name,
                        count(User.<owner[IS Issue])
                    )
                )
                # A tuple is essentially an identity function within our
                # set operation semantics, so here we're selecting a cross
                # product of all user names with user owned issue statuses.
                #
            ORDER BY _.0 THEN _.1;
            `,
      [
            [
              "Elvis",
              ["Closed", 1],
            ],
            [
              "Elvis",
              ["Open", 1],
            ],
            [
              "Yury",
              ["Closed", 1],
            ],
            [
              "Yury",
              ["Open", 1],
            ],
          ]
    );
  });

  it("test_edgeql_select_interpreter_tuple_03", () => {
    assertQueryResult(
      h,
      `
            WITH
                _ := {('Elvis',), ('Yury',)}
            SELECT
                User {
                    name
                }
            FILTER
                User.name = _.0
            ORDER BY
                User.name;
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

  it("test_edgeql_select_interpreter_tuple_04", () => {
    assertQueryResult(
      h,
      `
            SELECT
                User {
                    t := {(1, 2), (3, 4)}
                }
            FILTER
                User.name = 'Elvis'
            ORDER BY
                User.name;
            `,
      [
            {
              "t": [
                [1, 2],
                [3, 4],
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tuple_05", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    statuses := count(Status),
                    issues := count(Issue),
                );
            `,
      [
            {
              "statuses": 2,
              "issues": 4,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tuple_06", () => {
    assertQueryResult(
      h,
      `
            WITH
                counts := (SELECT (
                    statuses := count(Status),
                    issues := count(Issue),
                ))
            SELECT
                counts.statuses + counts.issues;
            `,
      [6]
    );
  });

  it("test_edgeql_select_interpreter_tuple_07", () => {
    assertQueryResult(
      h,
      `
            WITH
                criteria := (SELECT (
                    user := (SELECT User FILTER User.name = 'Yury'),
                    status := (SELECT Status FILTER Status.name = 'Open'),
                ))
            SELECT (
                SELECT
                    Issue
                FILTER
                    Issue.owner = criteria.user
                    AND Issue.status = criteria.status
            ).number;
            `,
      ["2"]
    );
  });

  it("test_edgeql_select_interpreter_tuple_08", () => {
    assertQueryResult(
      h,
      `
            SELECT
                (
                    user := (SELECT User{name} FILTER User.name = 'Yury')
                );
            `,
      [
            {
              "user": {
                "name": "Yury",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_tuple_09", () => {
    assertQueryResult(
      h,
      `
            SELECT
                (
                    user := (SELECT User{name} FILTER User.name = 'Yury')
                ).user.name;
            `,
      ["Yury"]
    );
  });

  it("test_edgeql_select_interpreter_tuple_10", () => {
    assertQueryResult(
      h,
      `
            WITH
                U1 := User,
                U2 := User
            SELECT
                (user := (SELECT U1{name} FILTER U1.name = 'Yury'))
                    =
                (user := (SELECT U2{name} FILTER U2.name = 'Yury'));
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
            WITH
                U1 := User,
                U2 := User
            SELECT
                (user := (SELECT U1{name} FILTER U1.name = 'Yury'))
                    =
                (user := (SELECT U2{name} FILTER U2.name = 'Elvis'));

            `,
      [false]
    );
  });

  it("test_edgeql_select_interpreter_linkproperty_01", () => {
    assertQueryResult(
      h,
      `
            SELECT User.todo@rank + <int64>User.todo.number
            ORDER BY User.todo.number;
            `,
      [43, 44, 45, 46]
    );
  });

  it("test_edgeql_select_interpreter_linkproperty_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue.<todo[IS User]@rank + <int64>Issue.number
            ORDER BY Issue.number;
            `,
      [43, 44, 45, 46]
    );
  });

  it("test_edgeql_select_interpreter_linkproperty_03", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
                name,
                todo: {
                    number,
                    @rank
                } ORDER BY User.todo.number
            }
            ORDER BY User.name;
            `,
      [
            {
              "name": "Elvis",
              "todo": [
                {
                  "number": "1",
                  "@rank": 42,
                },
                {
                  "number": "2",
                  "@rank": 42,
                },
              ],
            },
            {
              "name": "Yury",
              "todo": [
                {
                  "number": "3",
                  "@rank": 42,
                },
                {
                  "number": "4",
                  "@rank": 42,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_linkproperty_04", () => {
    h.script(
      "\n            SELECT\n                Issue { since := (SELECT .owner)@since }\n            "
    );
  });

  it("test_edgeql_select_interpreter_linkproperty_06", () => {
    assertQueryResult(
      h,
      `
            SELECT
                User {
                    todo := DISTINCT (
                        FOR entry IN {("1", 10), ("1", 10)}
                        UNION (
                            SELECT Issue {
                                @rank := entry.1
                            } FILTER
                                .number = entry.0
                        )
                    )
                }
            FILTER
                .name = "Elvis"
            `,
      [
            {
              "todo": [
                {
                  "@rank": 10,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_if_else_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
                open := 'yes' IF Issue.status.name = 'Open' ELSE 'no'
            }
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "open": "yes",
            },
            {
              "number": "2",
              "open": "yes",
            },
            {
              "number": "3",
              "open": "no",
            },
            {
              "number": "4",
              "open": "no",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_if_else_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
                # foo is 'bar' for Issue number 1 and status name for the rest
                foo := 'bar' IF Issue.number = '1' ELSE Issue.status.name
            }
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
              "foo": "bar",
            },
            {
              "number": "2",
              "foo": "Open",
            },
            {
              "number": "3",
              "foo": "Closed",
            },
            {
              "number": "4",
              "foo": "Closed",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_if_else_03", () => {
    h.script(
      "\n                SELECT Issue {\n                    foo := 'bar' IF Issue.number = '1' ELSE 123\n                };\n                "
    );
  });

  it("test_edgeql_select_interpreter_if_else_04", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue{
                kind := (Issue.priority.name
                         IF EXISTS Issue.priority.name
                         ELSE Issue.status.name)
            }
            ORDER BY Issue.number;
            `,
      [
            {
              "kind": "Open",
            },
            {
              "kind": "High",
            },
            {
              "kind": "Low",
            },
            {
              "kind": "Closed",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            # Above IF is equivalent to ??,
            SELECT Issue{
                kind := Issue.priority.name ?? Issue.status.name
            }
            ORDER BY Issue.number;
            `,
      [
            {
              "kind": "Open",
            },
            {
              "kind": "High",
            },
            {
              "kind": "Low",
            },
            {
              "kind": "Closed",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_if_else_05", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {number}
            FILTER
                Issue.priority.name = 'High'
                    IF EXISTS Issue.priority.name AND EXISTS 'High'
                    ELSE EXISTS Issue.priority.name = EXISTS 'High'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            # Above IF is equivalent to ?=,
            SELECT Issue {number}
            FILTER
                Issue.priority.name ?= 'High'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "2",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_if_else_06", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {number}
            FILTER
                Issue.priority.name != 'High'
                    IF EXISTS Issue.priority.name AND EXISTS 'High'
                    ELSE EXISTS Issue.priority.name != EXISTS 'High'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            # Above IF is equivalent to !?=,
            SELECT Issue {number}
            FILTER
                Issue.priority.name ?!= 'High'
            ORDER BY Issue.number;
            `,
      [
            {
              "number": "1",
            },
            {
              "number": "3",
            },
            {
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_if_else_07", () => {
    assertQueryResult(
      h,
      `
            WITH a := (SELECT Issue FILTER .number = '2'),
                 b := (SELECT Issue FILTER .number = '1'),
            SELECT a.number IF a.time_estimate < b.time_estimate ELSE b.number;
            `,
      []
    );
  });

  it("test_edgeql_partial_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue {
                    number
                }
            FILTER
                .number = '1';
            `,
      [
            {
              "number": "1",
            },
          ]
    );
  });

  it("test_edgeql_partial_02", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue.watchers {
                    name
                }
            FILTER
                .name = 'Yury';
            `,
      [
            {
              "name": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_partial_03", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
                watchers: {
                    name,
                    name_upper := str_upper(.name)
                } FILTER .name = 'Yury'
            } FILTER .status.name = 'Open' AND .owner.name = 'Elvis';
            `,
      [
            {
              "number": "1",
              "watchers": {
                "name": "Yury",
                "name_upper": "YURY",
              },
            },
          ]
    );
  });

  it("test_edgeql_partial_04", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
            } FILTER .number > '1'
              ORDER BY .number DESC;
            `,
      [
            {
              "number": "4",
            },
            {
              "number": "3",
            },
            {
              "number": "2",
            },
          ]
    );
  });

  it("test_edgeql_partial_05", () => {
    assertQueryResult(
      h,
      `
            SELECT
                Issue{
                    sub := (SELECT .number)
                }
            FILTER .number = '1';
        `,
      [
            {
              "sub": "1",
            },
          ]
    );
  });

  it("test_edgeql_union_target_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
            } FILTER EXISTS (.references)
              ORDER BY .number DESC;
            `,
      [
            {
              "number": "2",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
            } FILTER .references[IS URL].address = 'https://edgedb.com'
              ORDER BY .number DESC;
            `,
      [
            {
              "number": "2",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Issue {
                number,
            } FILTER .references[IS Named].name = 'screenshot.png'
              ORDER BY .number DESC;
            `,
      [
            {
              "number": "2",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_for_01", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue := (
                FOR x IN {1, 4}
                UNION (
                    SELECT Issue {
                        name
                    }
                    FILTER
                        .number = <str>x
                )
            )
            ORDER BY
                .number;
            `,
      [
            {
              "name": "Release EdgeDB",
            },
            {
              "name": "Regression.",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_for_02", () => {
    assertQueryResult(
      h,
      `
            SELECT I := (
                FOR x IN {1, 3, 4}
                UNION (
                    SELECT Issue {
                        name,
                        number,
                    }
                    FILTER
                        .number > <str>x
                )
            )
            ORDER BY .number;
            `,
      [
            {
              "name": "Improve EdgeDB repl output rendering.",
              "number": "2",
            },
            {
              "name": "Repl tweak.",
              "number": "3",
            },
            {
              "name": "Regression.",
              "number": "4",
            },
            {
              "name": "Regression.",
              "number": "4",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_for_03", () => {
    assertQueryResult(
      h,
      `
            FOR x IN {1, 3, 4}
            UNION (
                SELECT Issue {
                    name,
                    number,
                }
                FILTER
                    Issue.number > <str>x
                ORDER BY
                    Issue.number
                LIMIT 2
            );
            `,
      unorderedBag([
            {
              "name": "Improve EdgeDB repl output rendering.",
              "number": "2",
            },
            {
              "name": "Repl tweak.",
              "number": "3",
            },
            {
              "name": "Regression.",
              "number": "4",
            },
          ])
    );
  });

  it("test_edgeql_select_interpreter_for_04", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue {
                    asdf := (
                        FOR z IN .due_date UNION (1)
                    )
                }
                FILTER .name = 'Release EdgeDB';
            `,
      [
            {
              "asdf": null,
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_json_01", () => {
    assertQueryResult(
      h,
      `
            # cast a type variant into a set of json
            SELECT (
                SELECT <json>Issue {
                    number,
                    time_estimate
                } FILTER Issue.number = '1'
            ) = to_json('{"number": "1", "time_estimate": 3000}');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                SELECT <json>Issue {
                    number,
                    time_estimate
                } FILTER Issue.number = '2'
            ) = to_json('{"number": "2", "time_estimate": null}');
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_precedence_03", () => {
    assertQueryResult(
      h,
      `
            SELECT (<str>1)[0];
            `,
      ["1"]
    );
    assertQueryResult(
      h,
      `
            SELECT (<str>Issue.time_estimate)[0];
            `,
      ["3"]
    );
  });

  it("test_edgeql_select_interpreter_precedence_04", () => {
    assertQueryResult(
      h,
      `
            SELECT EXISTS Issue{number};
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
            SELECT EXISTS Issue;
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_precedence_05", () => {
    assertQueryResult(
      h,
      `
            SELECT EXISTS Issue{number};
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_is_01", () => {
    assertQueryResult(
      h,
      `SELECT 5 IS int64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 5 IS anyint;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 5 IS anyreal;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 5 IS anyscalar;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 5 IS int16;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 5 IS float64;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 5 IS anyfloat;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 5 IS str;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 5 IS Object;`,
      [false]
    );
  });

  it("test_edgeql_select_interpreter_is_02", () => {
    assertQueryResult(
      h,
      `SELECT 5.5 IS int64;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 5.5 IS anyint;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 5.5 IS anyreal;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 5.5 IS anyscalar;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 5.5 IS int16;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 5.5 IS float64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 5.5 IS anyfloat;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT 5.5 IS str;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT 5.5 IS Object;`,
      [false]
    );
  });

  it("test_edgeql_select_interpreter_is_03", () => {
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS int64 LIMIT 1;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS anyint LIMIT 1;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS anyreal LIMIT 1;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS anyscalar LIMIT 1;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS int16 LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS float64 LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS anyfloat LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS str LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.time_estimate IS Object LIMIT 1;`,
      [false]
    );
  });

  it("test_edgeql_select_interpreter_is_04", () => {
    assertQueryResult(
      h,
      `SELECT Issue.number IS int64 LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.number IS anyint LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.number IS anyreal LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.number IS anyscalar LIMIT 1;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT Issue.number IS int16 LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.number IS float64 LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.number IS anyfloat LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.number IS str LIMIT 1;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT Issue.number IS Object LIMIT 1;`,
      [false]
    );
  });

  it("test_edgeql_select_interpreter_is_05", () => {
    assertQueryResult(
      h,
      `SELECT Issue.status IS int64 LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.status IS anyint LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.status IS anyreal LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.status IS anyscalar LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.status IS int16 LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.status IS float64 LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.status IS anyfloat LIMIT 1;`,
      [false]
    );
    assertQueryResult(
      h,
      `SELECT Issue.status IS str LIMIT 1;`,
      [false]
    );
  });

  it("test_edgeql_select_interpreter_is_06", () => {
    assertQueryResult(
      h,
      `
            SELECT 5 IS anytype;
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_is_07", () => {
    assertQueryResult(
      h,
      `
            SELECT 5 IS anyint;
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_is_08", () => {
    assertQueryResult(
      h,
      `
            SELECT 5.5 IS anyfloat;
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_is_09", () => {
    assertQueryResult(
      h,
      `
            SELECT Issue.time_estimate IS anytype LIMIT 1;
            `,
      [true]
    );
  });

  it("test_edgeql_select_interpreter_big_set_literal", () => {
    let res = queryRows<unknown>(h, `
            SELECT {
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
                 (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,), (1,),
            };
        `);
    expect(((res).length === 100)).toBeTruthy();
  });

  it("test_edgeql_select_interpreter_big_unions", () => {
    let res = queryRows<unknown>(h, `
            SELECT (
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,) union
                 (1,) union (1,) union (1,) union (1,) union (1,)
            );
        `);
    expect(((res).length === 100)).toBeTruthy();
  });

  it("test_edgeql_select_interpreter_set_literal_in_order", () => {
    assertQueryResult(
      h,
      `SELECT {0, 1}`,
      [0, 1]
    );
    assertQueryResult(
      h,
      `SELECT 0 union 1`,
      [0, 1]
    );
    assertQueryResult(
      h,
      `SELECT {0, 1, 2, 3}`,
      [0, 1, 2, 3]
    );
    assertQueryResult(
      h,
      `SELECT 0 union 1 union 2 union 3`,
      [0, 1, 2, 3]
    );
    assertQueryResult(
      h,
      `SELECT {0, 1, 2, 3, 4, 5, 6, 7, 8, 9}`,
      [
            0,
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
      `SELECT 0 union 1 union 2 union 3 union 4 union 5 union 6 union 7 union 8 union 9`,
      [
            0,
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
      `SELECT {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24}`,
      [
            0,
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
            11,
            12,
            13,
            14,
            15,
            16,
            17,
            18,
            19,
            20,
            21,
            22,
            23,
            24,
          ]
    );
    assertQueryResult(
      h,
      `SELECT 0 union 1 union 2 union 3 union 4 union 5 union 6 union 7 union 8 union 9 union 10 union 11 union 12 union 13 union 14 union 15 union 16 union 17 union 18 union 19 union 20 union 21 union 22 union 23 union 24`,
      [
            0,
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
            11,
            12,
            13,
            14,
            15,
            16,
            17,
            18,
            19,
            20,
            21,
            22,
            23,
            24,
          ]
    );
  });

  it("test_edgeql_select_interpreter_revlink_on_union", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    File {
                        referrers := (
                            SELECT .<references[IS Issue] {
                                name,
                                number,
                            } ORDER BY .number
                        )
                    }
                FILTER
                    .name = 'screenshot.png'
            `,
      [
            {
              "referrers": [
                {
                  "name": "Improve EdgeDB repl output rendering.",
                  "number": "2",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_expr_objects_01", () => {
    assertQueryResult(
      h,
      `
                SELECT array_agg(Issue ORDER BY .body)[0].owner.name;
            `,
      ["Elvis"]
    );
  });

  it("test_edgeql_select_interpreter_expr_objects_02", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := array_unpack(array_agg(Issue)).owner.name
                ORDER BY _;
            `,
      ["Elvis", "Yury"]
    );
  });

  it("test_edgeql_select_interpreter_expr_objects_04", () => {
    assertQueryResult(
      h,
      `
                WITH items := array_agg((SELECT Named ORDER BY .name))
                SELECT items[0] IS Status;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH items := array_agg((
                    SELECT Named ORDER BY .name LIMIT 1))
                SELECT (items, items[0], items[0].name,
                        items[0] IS Status);
            `,
      [
            [
              [
                {},
              ],
              {},
              "Closed",
              true,
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                WITH items := (User.name, array_agg(User.todo ORDER BY .name))
                SELECT _ := (items.0, items.1, items.1[0].name) ORDER BY _.0;
            `,
      [
            [
              "Elvis",
              [
                {},
                {},
              ],
              "Improve EdgeDB repl output rendering.",
            ],
            [
              "Yury",
              [
                {},
                {},
              ],
              "Regression.",
            ],
          ]
    );
  });

  it("test_edgeql_select_interpreter_expr_objects_05", () => {
    assertQueryResult(
      h,
      `
            WITH
                L := ('x', User)
            SELECT (L, L);
            `,
      [
            [
              [
                "x",
                {},
              ],
              [
                "x",
                {},
              ],
            ],
            [
              [
                "x",
                {},
              ],
              [
                "x",
                {},
              ],
            ],
          ]
    );
  });

  it("test_edgeql_select_interpreter_expr_objects_06", () => {
    assertQueryResult(
      h,
      `
            SELECT (User, User {name}) ORDER BY .1.name;
            `,
      [
            [
              {},
              {
                "name": "Elvis",
              },
            ],
            [
              {},
              {
                "name": "Yury",
              },
            ],
          ]
    );
  });

  it("test_edgeql_select_interpreter_expr_objects_07", () => {
    let res = queryRows<{ id: string; name: string }>(h, `
            SELECT User {
                name,
                id
            }
            ORDER BY User.name;
        `);
    assertQueryResult(
      h,
      `
            WITH
                L := ('x', User),
            SELECT _ := (L, L.1 {name})
            ORDER BY _.1.name;
            `,
      res.map((user) => [["x", { "id": user.id }], { "name": user.name }])
    );
    assertQueryResult(
      h,
      `
            WITH
                L := ('x', User),
            SELECT _ := (L.1 {name}, L)
            ORDER BY _.0.name;
            `,
      res.map((user) => [{ "name": user.name }, ["x", { "id": user.id }]])
    );
  });

  it("test_edgeql_select_interpreter_expr_objects_08", () => {
    assertQueryResult(
      h,
      `
            SELECT DISTINCT
                [(SELECT Issue {number, name} FILTER .number = "1")];
            `,
      [
            [
              {
                "number": "1",
                "name": "Release EdgeDB",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT DISTINCT
                ((SELECT Issue {number, name} FILTER .number = "1"),
                 Issue.status.name);
            `,
      [
            [
              {
                "number": "1",
                "name": "Release EdgeDB",
              },
              "Open",
            ],
          ]
    );
  });

  it("test_edgeql_select_interpreter_banned_free_shape_01", () => {
    h.script(
      "\n            SELECT DISTINCT {{ z := 1 }, { z := 2 }};\n        "
    );
    h.script(
      "\n            SELECT DISTINCT { z := 1 } = { z := 2 };\n        "
    );
  });

  it("test_edgeql_select_interpreter_free_shape_01", () => {
    let [res] = queryRows<{ test: number }>(h, "SELECT {test := 1}");
    expect(res["test"]).toEqual(1);
  });

  it("test_edgeql_select_interpreter_result_alias_binding_01", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := (User { tag := User.name }) ORDER BY _.name;
            `,
      [
            {
              "tag": "Elvis",
            },
            {
              "tag": "Yury",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_reverse_overload_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    z := (SELECT .<owner[IS Named] { name }
                          ORDER BY .name)
                } FILTER .name = 'Elvis';
            `,
      [
            {
              "z": [
                {
                  "name": "Regression.",
                },
                {
                  "name": "Release EdgeDB",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_reverse_overload_02", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    z := (SELECT .<owner[IS Named] { name }
                          ORDER BY .name)
                } FILTER .name = 'Elvis';
            `,
      [
            {
              "z": [
                {
                  "name": "Regression.",
                },
                {
                  "name": "Release EdgeDB",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_function_source_01a", () => {
    assertQueryResult(
      h,
      `
                SELECT DISTINCT array_unpack([(
                    SELECT User {name} FILTER .name[0] = 'E'
                )]);
           `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_function_source_01b", () => {
    assertQueryResult(
      h,
      `
                SELECT (DISTINCT array_unpack([(
                    SELECT User FILTER .name[0] = 'E'
                )])) { name };
           `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_function_source_02", () => {
    assertQueryResult(
      h,
      `
                SELECT DISTINCT enumerate((
                    SELECT User {name} FILTER .name[0] = 'E'
                )).1;
            `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_function_source_03", () => {
    assertQueryResult(
      h,
      `
                SELECT assert_single(array_unpack([(
                    SELECT User FILTER .name[0] = 'E'
                )])) {name};
           `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_function_source_04", () => {
    assertQueryResult(
      h,
      `
                SELECT assert_distinct(array_unpack([(
                    SELECT User FILTER .name[0] = 'E'
                )])) {name} ;
           `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_function_source_05", () => {
    assertQueryResult(
      h,
      `
                SELECT assert_exists(array_unpack([(
                    SELECT User FILTER .name[0] = 'E'
                )])) {name};
            `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_function_source_06", () => {
    assertQueryResult(
      h,
      `
                SELECT enumerate(array_unpack([(
                    SELECT User FILTER .name[0] = 'E'
                )]) {name});
            `,
      [
            [
              0,
              {
                "name": "Elvis",
              },
            ],
          ]
    );
  });

  it("test_edgeql_function_source_07", () => {
    assertQueryResult(
      h,
      `
                SELECT (enumerate((
                    SELECT User FILTER .name[0] = 'E'
                )).1 UNION (SELECT User FILTER false)) {name};
            `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_function_source_08", () => {
    assertQueryResult(
      h,
      `
                SELECT (enumerate((
                    SELECT User FILTER .name[0] = 'E'
                )).1 ?? (SELECT User FILTER false)) {name};
            `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_function_source_09", () => {
    assertQueryResult(
      h,
      `
                SELECT (enumerate((
                    SELECT User FILTER .name[0] = 'E'
                )).1 if 1 = 1 ELSE (SELECT User FILTER false)) {name};
            `,
      [
            {
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_collection_shape_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <array<User>>{} UNION [User]
            `,
      [
            [
              {
                "id": "str",
              },
            ],
            [
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <array<User>>{} ?? [User]
            `,
      [
            [
              {
                "id": "str",
              },
            ],
            [
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <array<User>>{} IF false ELSE [User]
            `,
      [
            [
              {
                "id": "str",
              },
            ],
            [
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT assert_exists([User])
            `,
      [
            [
              {
                "id": "str",
              },
            ],
            [
              {
                "id": "str",
              },
            ],
          ]
    );
  });

  it("test_edgeql_collection_shape_02", () => {
    assertQueryResult(
      h,
      `
                SELECT <array<User>>{} UNION array_agg(User)
            `,
      [
            [
              {
                "id": "str",
              },
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <array<User>>{} ?? array_agg(User)
            `,
      [
            [
              {
                "id": "str",
              },
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <array<User>>{} IF false ELSE array_agg(User)
            `,
      [
            [
              {
                "id": "str",
              },
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT assert_exists(array_agg(User))
            `,
      [
            [
              {
                "id": "str",
              },
              {
                "id": "str",
              },
            ],
          ]
    );
  });

  it("test_edgeql_collection_shape_03", () => {
    assertQueryResult(
      h,
      `
                SELECT <tuple<User, int64>>{} UNION (User, 2)
            `,
      [
            [
              {
                "id": "str",
              },
              2,
            ],
            [
              {
                "id": "str",
              },
              2,
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <tuple<User, int64>>{} ?? (User, 2)
            `,
      [
            [
              {
                "id": "str",
              },
              2,
            ],
            [
              {
                "id": "str",
              },
              2,
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <tuple<User, int64>>{} IF false ELSE (User, 2)
            `,
      [
            [
              {
                "id": "str",
              },
              2,
            ],
            [
              {
                "id": "str",
              },
              2,
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT assert_exists((User, 2))
            `,
      [
            [
              {
                "id": "str",
              },
              2,
            ],
            [
              {
                "id": "str",
              },
              2,
            ],
          ]
    );
  });

  it("test_edgeql_collection_shape_04", () => {
    assertQueryResult(
      h,
      `
                SELECT [(User,)][0]
            `,
      [
            [
              {
                "id": "str",
              },
            ],
            [
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT [((SELECT User {name} ORDER BY .name),)][0]
            `,
      [
            [
              {
                "name": "Elvis",
              },
            ],
            [
              {
                "name": "Yury",
              },
            ],
          ]
    );
  });

  it("test_edgeql_collection_shape_05", () => {
    assertQueryResult(
      h,
      `
                SELECT ([User],).0
            `,
      [
            [
              {
                "id": "str",
              },
            ],
            [
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT ([(SELECT User {name} ORDER BY .name)],).0
            `,
      [
            [
              {
                "name": "Elvis",
              },
            ],
            [
              {
                "name": "Yury",
              },
            ],
          ]
    );
  });

  it("test_edgeql_collection_shape_06", () => {
    assertQueryResult(
      h,
      `
                SELECT { z := ([User],).0 }
            `,
      [
            {
              "z": [
                [
                  {
                    "id": "str",
                  },
                ],
                [
                  {
                    "id": "str",
                  },
                ],
              ],
            },
          ]
    );
  });

  it("test_edgeql_collection_shape_07", () => {
    assertQueryResult(
      h,
      `
                WITH Z := (<array<User>>{} IF false ELSE [User]),
                SELECT (Z, array_agg(array_unpack(Z))).1;
            `,
      [
            [
              {
                "id": "str",
              },
            ],
            [
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                WITH Z := (SELECT assert_exists([User]))
                SELECT (Z, array_agg(array_unpack(Z))).1;
            `,
      [
            [
              {
                "id": "str",
              },
            ],
            [
              {
                "id": "str",
              },
            ],
          ]
    );
  });

  it("test_edgeql_collection_shape_08", () => {
    assertQueryResult(
      h,
      `
                SELECT X := array_agg(User) FILTER X[0].name != 'Sully';
            `,
      [
            [
              {
                "id": "str",
              },
              {
                "id": "str",
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT X := [User] FILTER X[0].name = 'Elvis';
            `,
      [
            [
              {
                "id": "str",
              },
            ],
          ]
    );
  });

  it("test_edgeql_assert_fail_object_computed_02", () => {
    expect(() => {
      h.script(
        "\n                SELECT array_agg((SELECT User {m := Publication}))[{1000}].m;\n            "
      );
    }).toThrow(new RegExp("array index 1000 is out of bounds"));
  });

  it("test_edgeql_select_interpreter_concat_null_01", () => {
    assertQueryResult(
      h,
      `
            select BooleanTest {
                name,
                val,
                x := [.val] ++ [0]
            } order by .name;
            `,
      [
            {
              "name": "circle",
              "val": 2,
              "x": [2, 0],
            },
            {
              "name": "hexagon",
              "val": 4,
              "x": [4, 0],
            },
            {
              "name": "pentagon",
              "val": null,
              "x": null,
            },
            {
              "name": "square",
              "val": null,
              "x": null,
            },
            {
              "name": "triangle",
              "val": 10,
              "x": [10, 0],
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_subshape_filter_01", () => {
    h.script(
      "\n            SELECT Comment { owner: { name } FILTER false }\n            "
    );
  });

  it("test_edgeql_select_interpreter_nested_order_01", () => {
    assertQueryResult(
      h,
      `
                SELECT
                  Issue {
                    key := (WITH c := Issue.name,
                            SELECT { name := c })
                  }
                ORDER BY .key.name;
            `,
      [
            {
              "key": {
                "name": "Improve EdgeDB repl output rendering.",
              },
            },
            {
              "key": {
                "name": "Regression.",
              },
            },
            {
              "key": {
                "name": "Release EdgeDB",
              },
            },
            {
              "key": {
                "name": "Repl tweak.",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_nested_order_02", () => {
    assertQueryResult(
      h,
      `
                SELECT
                  Issue {
                    key := (WITH n := Issue.number, c := Issue.name,
                            SELECT { name := c, number := n })
                  }
                ORDER BY .key.number THEN .key.name;
            `,
      [
            {
              "key": {
                "name": "Release EdgeDB",
                "number": "1",
              },
            },
            {
              "key": {
                "name": "Improve EdgeDB repl output rendering.",
                "number": "2",
              },
            },
            {
              "key": {
                "name": "Repl tweak.",
                "number": "3",
              },
            },
            {
              "key": {
                "name": "Regression.",
                "number": "4",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_scalar_views_02", () => {
    assertQueryResult(
      h,
      `
            select (select {1,2} filter random() > 0) filter random() > 0
            `,
      unorderedSet([1, 2])
    );
  });

  it("test_edgeql_select_interpreter_scalar_views_03", () => {
    assertQueryResult(
      h,
      `
            select {1,2,3,4+0} filter random() > 0
            `,
      unorderedSet([1, 2, 3, 4])
    );
  });

  it("test_edgeql_select_interpreter_scalar_views_04", () => {
    assertQueryResult(
      h,
      `
            for x in 2 union (select {1,x} filter random() > 0)
            `,
      unorderedSet([1, 2])
    );
  });

  it("test_edgeql_with_rebind_01", () => {
    assertQueryResult(
      h,
      `
            WITH Z := (SELECT User { name })
            SELECT Z
            `,
      [
            {
              "name": "str",
            },
            {
              "name": "str",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_shadow_computable_01", () => {
    assertQueryResult(
      h,
      `
            SELECT User := User { name, is_elvis := User.name = 'Elvis' }
            ORDER BY User.is_elvis
            `,
      [
            {
              "is_elvis": false,
              "name": "Yury",
            },
            {
              "is_elvis": true,
              "name": "Elvis",
            },
          ]
    );
  });

  it("test_edgeql_select_interpreter_card_blowup_01", () => {
    h.script(
      "\n        SELECT Comment {\n          issue := assert_exists(( .issue {\n            status1 := ( .status { a := .__type__.name, b := .__type__.id } ),\n            status2 := ( .status { a := .__type__.name, b := .__type__.id } ),\n            status3 := ( .status { a := .__type__.name, b := .__type__.id } ),\n            status4 := ( .status { a := .__type__.name, b := .__type__.id } ),\n            status5 := ( .status { a := .__type__.name, b := .__type__.id } ),\n            status6 := ( .status { a := .__type__.name, b := .__type__.id } ),\n            status7 := ( .status { a := .__type__.name, b := .__type__.id } ),\n            status8 := ( .status { a := .__type__.name, b := .__type__.id } ),\n          })),\n        };\n        "
    );
  });

  it("test_edgeql_select_interpreter_paths_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Issue.name
                FILTER Issue.number > '2';
            `,
      unorderedBag(["Repl tweak.", "Regression."])
    );
  });
});
