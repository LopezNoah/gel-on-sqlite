import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  queryRows,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLScope", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "cards",
      setup: "cards_setup",
    });
  });

  it("test_edgeql_scope_sort_01a", () => {
    assertQueryResult(
      h,
      `
                WITH
                    A := {1, 2},
                    U := (SELECT User FILTER User.name IN {'Alice', 'Bob'})
                SELECT _ := (U{name}, A)
                # specifically test the ORDER clause
                ORDER BY _.1 THEN _.0.name DESC;
            `,
      [
            [
              {
                "name": "Bob",
              },
              1,
            ],
            [
              {
                "name": "Alice",
              },
              1,
            ],
            [
              {
                "name": "Bob",
              },
              2,
            ],
            [
              {
                "name": "Alice",
              },
              2,
            ],
          ]
    );
  });

  it("test_edgeql_scope_sort_01b", () => {
    assertQueryResult(
      h,
      `
            SELECT assert_exists((
                WITH
                    A := {1, 2},
                    U := (SELECT User FILTER User.name IN {'Alice', 'Bob'})
                SELECT _ := (U{name}, A)
                # specifically test the ORDER clause
                ORDER BY _.1 THEN _.0.name DESC
            ));
            `,
      [
            [
              {
                "name": "Bob",
              },
              1,
            ],
            [
              {
                "name": "Alice",
              },
              1,
            ],
            [
              {
                "name": "Bob",
              },
              2,
            ],
            [
              {
                "name": "Alice",
              },
              2,
            ],
          ]
    );
  });

  it("test_edgeql_scope_sort_01c", () => {
    assertQueryResult(
      h,
      `
            SELECT assert_exists(array_agg((
                WITH
                    A := {1, 2},
                    U := (SELECT User FILTER User.name IN {'Alice', 'Bob'})
                SELECT _ := (U{name}, A)
                # specifically test the ORDER clause
                ORDER BY _.1 THEN _.0.name DESC
            )));
            `,
      [
            [
              [
                {
                  "name": "Bob",
                },
                1,
              ],
              [
                {
                  "name": "Alice",
                },
                1,
              ],
              [
                {
                  "name": "Bob",
                },
                2,
              ],
              [
                {
                  "name": "Alice",
                },
                2,
              ],
            ],
          ]
    );
  });

  it("test_edgeql_scope_tuple_07", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    foo := (
                        # this is the same as enclosing User
                        WITH U2 := User
                        SELECT U2 {name} ORDER BY U2.name
                    )
                }
                ORDER BY User.name;
            `,
      [
            {
              "name": "Alice",
              "foo": {
                "name": "Alice",
              },
            },
            {
              "name": "Bob",
              "foo": {
                "name": "Bob",
              },
            },
            {
              "name": "Carol",
              "foo": {
                "name": "Carol",
              },
            },
            {
              "name": "Dave",
              "foo": {
                "name": "Dave",
              },
            },
          ]
    );
  });

  it("test_edgeql_scope_tuple_10", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                FOR User in User
                SELECT (User.name, User.deck_cost, count(User.deck),
                        User.deck_cost / count(User.deck))
                )
                ORDER BY .0;
            `,
      [
            ["Alice", 11, 4, 2.75],
            ["Bob", 9, 4, 2.25],
            ["Carol", 16, 7, 2.28571428571429],
            ["Dave", 20, 7, 2.85714285714286],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (SELECT (
                FOR uf in User.friends
                SELECT (uf, uf.deck_cost / count(uf.deck))
                ) ORDER BY .0.name).1
            `,
      [2.25, 2.28571428571429, 2.85714285714286]
    );
    assertQueryResult(
      h,
      `
                FOR uf in User.friends
                SELECT uf.deck_cost / count(uf.deck)
                FILTER uf.name = 'Bob';
            `,
      [2.25]
    );
  });

  it("test_edgeql_scope_tuple_16", () => {
    assertQueryResult(
      h,
      `
            with z := User, select ({z}.name, count(z));
            `,
      unorderedBag([
            ["Alice", 4],
            ["Bob", 4],
            ["Carol", 4],
            ["Dave", 4],
          ])
    );
  });

  it("test_edgeql_scope_binding_01", () => {
    assertQueryResult(
      h,
      `
            WITH
                L := (FOR name in {'Alice', 'Bob'} UNION (
                    SELECT User
                    FILTER .name = name
                )),
            SELECT _ := ((SELECT L.name), (SELECT L.name))
            ORDER BY _;
            `,
      [
            ["Alice", "Alice"],
            ["Alice", "Bob"],
            ["Bob", "Alice"],
            ["Bob", "Bob"],
          ]
    );
  });

  it("test_edgeql_scope_binding_02a", () => {
    assertQueryResult(
      h,
      `
            WITH
                name := {'Alice', 'Bob'},
                L := (name, (
                    SELECT User
                    FILTER any(.name = name)
                )),
            SELECT _ := ((SELECT L.1.name), (SELECT L.1.name))
            ORDER BY _;
            `,
      [
            ["Alice", "Alice"],
            ["Alice", "Alice"],
            ["Alice", "Alice"],
            ["Alice", "Alice"],
            ["Alice", "Bob"],
            ["Alice", "Bob"],
            ["Alice", "Bob"],
            ["Alice", "Bob"],
            ["Bob", "Alice"],
            ["Bob", "Alice"],
            ["Bob", "Alice"],
            ["Bob", "Alice"],
            ["Bob", "Bob"],
            ["Bob", "Bob"],
            ["Bob", "Bob"],
            ["Bob", "Bob"],
          ]
    );
  });

  it("test_edgeql_scope_binding_02b", () => {
    assertQueryResult(
      h,
      `
            WITH
                name := {'Alice', 'Bob'},
                L := ((
                    SELECT User
                    FILTER any(.name = name)
                ), name),
            SELECT _ := ((SELECT L.0.name), (SELECT L.0.name))
            ORDER BY _;
            `,
      [
            ["Alice", "Alice"],
            ["Alice", "Alice"],
            ["Alice", "Alice"],
            ["Alice", "Alice"],
            ["Alice", "Bob"],
            ["Alice", "Bob"],
            ["Alice", "Bob"],
            ["Alice", "Bob"],
            ["Bob", "Alice"],
            ["Bob", "Alice"],
            ["Bob", "Alice"],
            ["Bob", "Alice"],
            ["Bob", "Bob"],
            ["Bob", "Bob"],
            ["Bob", "Bob"],
            ["Bob", "Bob"],
          ]
    );
  });

  it("test_edgeql_scope_binding_04", () => {
    assertQueryResult(
      h,
      `
            WITH Y := (FOR x IN {1, 2} UNION (x + 1)),
            SELECT _ := ((SELECT Y), (SELECT Y))
            ORDER BY _;
            `,
      [
            [2, 2],
            [2, 3],
            [3, 2],
            [3, 3],
          ]
    );
  });

  it("test_edgeql_scope_binding_05", () => {
    assertQueryResult(
      h,
      `
            WITH X := {1, 2},
                 Y := (X, X+1).1,
            SELECT _ := ((SELECT Y), (SELECT Y))
            ORDER BY _;
            `,
      [
            [2, 2],
            [2, 2],
            [2, 2],
            [2, 2],
            [2, 3],
            [2, 3],
            [2, 3],
            [2, 3],
            [3, 2],
            [3, 2],
            [3, 2],
            [3, 2],
            [3, 3],
            [3, 3],
            [3, 3],
            [3, 3],
          ]
    );
  });

  it("test_edgeql_scope_binding_06", () => {
    assertQueryResult(
      h,
      `
            SELECT {
                lol := (
                    WITH L := (FOR name in {'Alice', 'Bob'} UNION (
                        SELECT User
                        FILTER .name = name
                    )),
                    SELECT _ := ((SELECT L.name), (SELECT L.name))
                    ORDER BY _
                )
            };
            `,
      [
            {
              "lol": [
                ["Alice", "Alice"],
                ["Alice", "Bob"],
                ["Bob", "Alice"],
                ["Bob", "Bob"],
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_binding_07", () => {
    assertQueryResult(
      h,
      `
            SELECT {
                lol := (
                    WITH Y := (FOR x IN {1, 2} UNION (x + 1)),
                    SELECT _ := ((SELECT Y), (SELECT Y))
                    ORDER BY _
                )
            };
            `,
      [
            {
              "lol": [
                [2, 2],
                [2, 3],
                [3, 2],
                [3, 3],
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_with_subquery_01", () => {
    assertQueryResult(
      h,
      `
                SELECT count((
                    Card.name,
                    (WITH X := (SELECT Card) SELECT X.name),
                ));
            `,
      [81]
    );
  });

  it("test_edgeql_scope_filter_01", () => {
    assertQueryResult(
      h,
      `
                WITH
                    U2 := User
                SELECT User {
                    name,
                    foo := (SELECT U2 {name} ORDER BY U2.name)
                }
                # the FILTER clause is irrelevant because it's in a
                # parallel scope to the other mentions of U2
                FILTER U2.name = 'Alice'
                ORDER BY User.name;
            `,
      [
            {
              "name": "Alice",
              "foo": [
                {
                  "name": "Alice",
                },
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Bob",
              "foo": [
                {
                  "name": "Alice",
                },
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Carol",
              "foo": [
                {
                  "name": "Alice",
                },
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Dave",
              "foo": [
                {
                  "name": "Alice",
                },
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_filter_02", () => {
    assertQueryResult(
      h,
      `
                SELECT User.friends {name}
                FILTER User.friends NOT IN <Object>{}
                ORDER BY User.friends.name;
            `,
      [
            {
              "name": "Bob",
            },
            {
              "name": "Carol",
            },
            {
              "name": "Dave",
            },
          ]
    );
  });

  it("test_edgeql_scope_filter_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    U2 := User
                SELECT User {
                    name,
                    friends_of_others := (
                        SELECT U2.friends {name}
                        FILTER
                            # not me
                            U2.friends != User
                            AND
                            # not one of my friends
                            U2.friends NOT IN User.friends
                        ORDER BY U2.friends.name
                    )
                }
                ORDER BY User.name;
            `,
      [
            {
              "name": "Alice",
              "friends_of_others": [],
            },
            {
              "name": "Bob",
              "friends_of_others": [
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Carol",
              "friends_of_others": [
                {
                  "name": "Bob",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Dave",
              "friends_of_others": [
                {
                  "name": "Carol",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_filter_04", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    friends: {
                        name
                    } ORDER BY User.friends.name
                }
                FILTER User.friends.name = 'Carol';
            `,
      [
            {
              "name": "Alice",
              "friends": [
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_filter_05", () => {
    assertQueryResult(
      h,
      `
                # User.name is wrapped into a SELECT, so it's a SET OF
                # w.r.t FILTER
                SELECT (SELECT User.name)
                FILTER User.name = 'Alice';
            `,
      unorderedSet(["Alice", "Bob", "Carol", "Dave"])
    );
  });

  it("test_edgeql_scope_filter_06", () => {
    assertQueryResult(
      h,
      `
                # User is wrapped into a SELECT, so it's a SET OF
                # w.r.t FILTER
                SELECT (SELECT User).name
                FILTER User.name = 'Alice';
            `,
      unorderedSet(["Alice", "Bob", "Carol", "Dave"])
    );
  });

  it("test_edgeql_scope_filter_07", () => {
    assertQueryResult(
      h,
      `
                # User.name is a SET OF argument of ??, so it's unaffected
                # by the FILTER
                SELECT (<str>{} ?? User.name)
                FILTER User.name = 'Alice';
            `,
      unorderedSet(["Alice", "Bob", "Carol", "Dave"])
    );
  });

  it("test_edgeql_scope_filter_08", () => {
    assertQueryResult(
      h,
      `
                # User is a SET OF argument of ??, so it's unaffected
                # by the FILTER
                SELECT (<User>{} ?? User).name
                FILTER User.name = 'Alice';
            `,
      unorderedSet(["Alice", "Bob", "Carol", "Dave"])
    );
  });

  it("test_edgeql_scope_order_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    friends: {
                        name
                    } ORDER BY User.friends.name
                }
                ORDER BY (
                    assert_single((
                        SELECT User.friends FILTER @nickname = 'Firefighter'
                    )).name
                ) EMPTY FIRST
                THEN User.name;
            `,
      [
            {
              "name": "Bob",
              "friends": [],
            },
            {
              "name": "Carol",
              "friends": [],
            },
            {
              "name": "Dave",
              "friends": [
                {
                  "name": "Bob",
                },
              ],
            },
            {
              "name": "Alice",
              "friends": [
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_offset_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    friends: {
                        name
                    } ORDER BY User.friends.name
                }
                ORDER BY User.name
                # the OFFSET clause is in a sibling scope to SELECT, so
                # the User.friends are completely independent in them.
                OFFSET (# NOTE: effectively it's OFFSET 2
                        #
                        # Select the average card value (rounded to an
                        # int) for the user who is someone's friend AND
                        # nicknamed 'Firefighter':
                        # - the user happens to be Carol
                        # - her average deck cost is 2
                        #   (see test_edgeql_scope_tuple_08)
                        WITH
                            F := (
                                SELECT User
                                FILTER
                                    User.<friends[IS User]@nickname
                                    = 'Firefighter'
                            )
                        SELECT
                            # cardinality should be inferable here:
                            # - deck_cost is a computable based on sum
                            # - count also has cardinality 1 of the return set
                            <int64>(F.deck_cost / count(F.deck))
                        LIMIT 1
                    );
            `,
      [
            {
              "name": "Carol",
              "friends": [],
            },
            {
              "name": "Dave",
              "friends": [
                {
                  "name": "Bob",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_offset_02", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    friends: {
                        name
                    }  # User.friends is scoped from the enclosing shape
                    ORDER BY User.friends.name
                    OFFSET (count(User.friends) - 1)
                            IF EXISTS User.friends ELSE 0
                    # the above is equivalent to getting the last friend,
                    # ordered by name
                }
                ORDER BY User.name;
            `,
      [
            {
              "name": "Alice",
              "friends": [
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Bob",
              "friends": [],
            },
            {
              "name": "Carol",
              "friends": [],
            },
            {
              "name": "Dave",
              "friends": [
                {
                  "name": "Bob",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_limit_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    friends: {
                        name
                    } ORDER BY User.friends.name
                }
                ORDER BY User.name
                # the LIMIT clause is in a sibling scope to SELECT, so
                # the User.<friends are completely independent in them.
                LIMIT ( # NOTE: effectively it's LIMIT 2
                        #
                        # Select the average card value (rounded to an
                        # int) for the user who is someone's friend AND
                        # nicknamed 'Firefighter':
                        # - the user happens to be Carol
                        # - her average deck cost is 2
                        #   (see test_edgeql_scope_tuple_08)
                        WITH
                            F := (
                                SELECT User
                                FILTER
                                    User.<friends[IS User]@nickname
                                    = 'Firefighter'
                            )
                        SELECT
                            # cardinality should be inferable here:
                            # - deck_cost is a computable based on sum
                            # - count also has cardinality 1 of the return set
                            <int64>(F.deck_cost / count(F.deck))
                        LIMIT 1
                    );
            `,
      [
            {
              "name": "Alice",
              "friends": [
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Bob",
              "friends": [],
            },
          ]
    );
  });

  it("test_edgeql_scope_limit_02", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    friends: {
                        name,
                        name_upper := str_upper(User.friends.name),
                    }  # User.friends is scoped from the enclosing shape
                    ORDER BY User.friends.name
                    LIMIT (count(User.friends) - 1)
                           IF EXISTS User.friends ELSE 0
                    # the above is equivalent to getting the all except
                    # last friend, ordered by name
                }
                ORDER BY User.name;
            `,
      [
            {
              "name": "Alice",
              "friends": [
                {
                  "name": "Bob",
                  "name_upper": "BOB",
                },
                {
                  "name": "Carol",
                  "name_upper": "CAROL",
                },
              ],
            },
            {
              "name": "Bob",
              "friends": [],
            },
            {
              "name": "Carol",
              "friends": [],
            },
            {
              "name": "Dave",
              "friends": [],
            },
          ]
    );
  });

  it("test_edgeql_scope_nested_01", () => {
    assertQueryResult(
      h,
      `
                # control query Q1
                select (
                SELECT Card { slug := Card.element ++ ' ' ++ Card.name }
                FILTER Card.name > Card.element
                ORDER BY Card.name
                ).slug
            `,
      ["Air Djinn", "Air Giant eagle", "Earth Golem", "Fire Imp", "Air Sprite"]
    );
  });

  it("test_edgeql_scope_nested_05", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    Card {
                        foo := Card.element ++ <str>count(Card.name)
                    }
                FILTER
                    Card.name > Card.element
                ORDER BY
                    Card.name;
            `,
      [
            {
              "foo": "Air1",
            },
            {
              "foo": "Air1",
            },
            {
              "foo": "Earth1",
            },
            {
              "foo": "Fire1",
            },
            {
              "foo": "Air1",
            },
          ]
    );
  });

  it("test_edgeql_scope_nested_06", () => {
    assertQueryResult(
      h,
      `
                # control query Q2
                # combination of element + SET OF with a common prefix
                SELECT (SELECT (
                FOR Card in Card
                SELECT (Card.name ++ <str>count(Card.owners), Card)
                FILTER
                    # some element filters
                    Card.name < Card.element
                    AND
                    # a SET OF filter that shares a prefix with SELECT SET
                    # OF, but is actually independent
                    count(Card.owners.friends) > 2
                ) ORDER BY .1.name).0;
            `,
      ["Bog monster4", "Dragon2", "Giant turtle4"]
    );
  });

  it("test_edgeql_scope_nested_09", () => {
    assertQueryResult(
      h,
      `
                # control query Q3
                FOR Card in Card
                SELECT Card.name ++ <str>count(Card.owners);
            `,
      unorderedSet([
            "Bog monster4",
            "Djinn2",
            "Dragon2",
            "Dwarf2",
            "Giant eagle2",
            "Giant turtle4",
            "Golem3",
            "Imp1",
            "Sprite2",
          ])
    );
  });

  it("test_edgeql_scope_nested_11", () => {
    assertQueryResult(
      h,
      `
                # semantically same as control query Q3, except that some
                # aliases are introduced
                FOR Card in Card
                SELECT Card.name ++
                       <str>count((WITH A := Card SELECT A).owners);
            `,
      unorderedSet([
            "Bog monster4",
            "Djinn2",
            "Dragon2",
            "Dwarf2",
            "Giant eagle2",
            "Giant turtle4",
            "Golem3",
            "Imp1",
            "Sprite2",
          ])
    );
    assertQueryResult(
      h,
      `
                FOR Card in Card
                SELECT Card.name ++
                       <str>count((WITH A := Card SELECT A.owners));
            `,
      unorderedSet([
            "Bog monster4",
            "Djinn2",
            "Dragon2",
            "Dwarf2",
            "Giant eagle2",
            "Giant turtle4",
            "Golem3",
            "Imp1",
            "Sprite2",
          ])
    );
    assertQueryResult(
      h,
      `
                FOR Card in Card
                SELECT <str>count((WITH A := Card SELECT A.owners)) ++
                       Card.name;
            `,
      unorderedSet([
            "1Imp",
            "2Djinn",
            "2Dragon",
            "2Dwarf",
            "2Giant eagle",
            "2Sprite",
            "3Golem",
            "4Bog monster",
            "4Giant turtle",
          ])
    );
    assertQueryResult(
      h,
      `
                FOR Card in Card
                # semantically same as control query Q3, except that some
                # aliases are introduced
                SELECT (Card.name,
                        count((WITH A := Card SELECT A).owners));
            `,
      unorderedBag([
            ["Bog monster", 4],
            ["Djinn", 2],
            ["Dragon", 2],
            ["Dwarf", 2],
            ["Giant eagle", 2],
            ["Giant turtle", 4],
            ["Golem", 3],
            ["Imp", 1],
            ["Sprite", 2],
          ])
    );
  });

  it("test_edgeql_scope_nested_12", () => {
    assertQueryResult(
      h,
      `
                SELECT Card {
                    name,
                    owner := (
                        SELECT User {
                            # masking a real \`name\` link
                            name := 'Elvis'
                        }
                        # this filter should be impossible with the new \`name\`
                        FILTER User.name = 'Alice'
                    )
                }
                FILTER Card.name = 'Dragon';
            `,
      [
            {
              "name": "Dragon",
              "owner": [],
            },
          ]
    );
  });

  it("test_edgeql_scope_detached_01", () => {
    assertQueryResult(
      h,
      `
                # U2 is a combination of DETACHED and non-DETACHED expression
                WITH
                    U2 := User.name ++ DETACHED User.name
                SELECT U2 ++ U2;
            `,
      unorderedSet([
            "AliceAliceAliceAlice",
            "AliceAliceAliceBob",
            "AliceAliceAliceCarol",
            "AliceAliceAliceDave",
            "AliceAliceBobAlice",
            "AliceAliceBobBob",
            "AliceAliceBobCarol",
            "AliceAliceBobDave",
            "AliceAliceCarolAlice",
            "AliceAliceCarolBob",
            "AliceAliceCarolCarol",
            "AliceAliceCarolDave",
            "AliceAliceDaveAlice",
            "AliceAliceDaveBob",
            "AliceAliceDaveCarol",
            "AliceAliceDaveDave",
            "AliceBobAliceAlice",
            "AliceBobAliceBob",
            "AliceBobAliceCarol",
            "AliceBobAliceDave",
            "AliceBobBobAlice",
            "AliceBobBobBob",
            "AliceBobBobCarol",
            "AliceBobBobDave",
            "AliceBobCarolAlice",
            "AliceBobCarolBob",
            "AliceBobCarolCarol",
            "AliceBobCarolDave",
            "AliceBobDaveAlice",
            "AliceBobDaveBob",
            "AliceBobDaveCarol",
            "AliceBobDaveDave",
            "AliceCarolAliceAlice",
            "AliceCarolAliceBob",
            "AliceCarolAliceCarol",
            "AliceCarolAliceDave",
            "AliceCarolBobAlice",
            "AliceCarolBobBob",
            "AliceCarolBobCarol",
            "AliceCarolBobDave",
            "AliceCarolCarolAlice",
            "AliceCarolCarolBob",
            "AliceCarolCarolCarol",
            "AliceCarolCarolDave",
            "AliceCarolDaveAlice",
            "AliceCarolDaveBob",
            "AliceCarolDaveCarol",
            "AliceCarolDaveDave",
            "AliceDaveAliceAlice",
            "AliceDaveAliceBob",
            "AliceDaveAliceCarol",
            "AliceDaveAliceDave",
            "AliceDaveBobAlice",
            "AliceDaveBobBob",
            "AliceDaveBobCarol",
            "AliceDaveBobDave",
            "AliceDaveCarolAlice",
            "AliceDaveCarolBob",
            "AliceDaveCarolCarol",
            "AliceDaveCarolDave",
            "AliceDaveDaveAlice",
            "AliceDaveDaveBob",
            "AliceDaveDaveCarol",
            "AliceDaveDaveDave",
            "BobAliceAliceAlice",
            "BobAliceAliceBob",
            "BobAliceAliceCarol",
            "BobAliceAliceDave",
            "BobAliceBobAlice",
            "BobAliceBobBob",
            "BobAliceBobCarol",
            "BobAliceBobDave",
            "BobAliceCarolAlice",
            "BobAliceCarolBob",
            "BobAliceCarolCarol",
            "BobAliceCarolDave",
            "BobAliceDaveAlice",
            "BobAliceDaveBob",
            "BobAliceDaveCarol",
            "BobAliceDaveDave",
            "BobBobAliceAlice",
            "BobBobAliceBob",
            "BobBobAliceCarol",
            "BobBobAliceDave",
            "BobBobBobAlice",
            "BobBobBobBob",
            "BobBobBobCarol",
            "BobBobBobDave",
            "BobBobCarolAlice",
            "BobBobCarolBob",
            "BobBobCarolCarol",
            "BobBobCarolDave",
            "BobBobDaveAlice",
            "BobBobDaveBob",
            "BobBobDaveCarol",
            "BobBobDaveDave",
            "BobCarolAliceAlice",
            "BobCarolAliceBob",
            "BobCarolAliceCarol",
            "BobCarolAliceDave",
            "BobCarolBobAlice",
            "BobCarolBobBob",
            "BobCarolBobCarol",
            "BobCarolBobDave",
            "BobCarolCarolAlice",
            "BobCarolCarolBob",
            "BobCarolCarolCarol",
            "BobCarolCarolDave",
            "BobCarolDaveAlice",
            "BobCarolDaveBob",
            "BobCarolDaveCarol",
            "BobCarolDaveDave",
            "BobDaveAliceAlice",
            "BobDaveAliceBob",
            "BobDaveAliceCarol",
            "BobDaveAliceDave",
            "BobDaveBobAlice",
            "BobDaveBobBob",
            "BobDaveBobCarol",
            "BobDaveBobDave",
            "BobDaveCarolAlice",
            "BobDaveCarolBob",
            "BobDaveCarolCarol",
            "BobDaveCarolDave",
            "BobDaveDaveAlice",
            "BobDaveDaveBob",
            "BobDaveDaveCarol",
            "BobDaveDaveDave",
            "CarolAliceAliceAlice",
            "CarolAliceAliceBob",
            "CarolAliceAliceCarol",
            "CarolAliceAliceDave",
            "CarolAliceBobAlice",
            "CarolAliceBobBob",
            "CarolAliceBobCarol",
            "CarolAliceBobDave",
            "CarolAliceCarolAlice",
            "CarolAliceCarolBob",
            "CarolAliceCarolCarol",
            "CarolAliceCarolDave",
            "CarolAliceDaveAlice",
            "CarolAliceDaveBob",
            "CarolAliceDaveCarol",
            "CarolAliceDaveDave",
            "CarolBobAliceAlice",
            "CarolBobAliceBob",
            "CarolBobAliceCarol",
            "CarolBobAliceDave",
            "CarolBobBobAlice",
            "CarolBobBobBob",
            "CarolBobBobCarol",
            "CarolBobBobDave",
            "CarolBobCarolAlice",
            "CarolBobCarolBob",
            "CarolBobCarolCarol",
            "CarolBobCarolDave",
            "CarolBobDaveAlice",
            "CarolBobDaveBob",
            "CarolBobDaveCarol",
            "CarolBobDaveDave",
            "CarolCarolAliceAlice",
            "CarolCarolAliceBob",
            "CarolCarolAliceCarol",
            "CarolCarolAliceDave",
            "CarolCarolBobAlice",
            "CarolCarolBobBob",
            "CarolCarolBobCarol",
            "CarolCarolBobDave",
            "CarolCarolCarolAlice",
            "CarolCarolCarolBob",
            "CarolCarolCarolCarol",
            "CarolCarolCarolDave",
            "CarolCarolDaveAlice",
            "CarolCarolDaveBob",
            "CarolCarolDaveCarol",
            "CarolCarolDaveDave",
            "CarolDaveAliceAlice",
            "CarolDaveAliceBob",
            "CarolDaveAliceCarol",
            "CarolDaveAliceDave",
            "CarolDaveBobAlice",
            "CarolDaveBobBob",
            "CarolDaveBobCarol",
            "CarolDaveBobDave",
            "CarolDaveCarolAlice",
            "CarolDaveCarolBob",
            "CarolDaveCarolCarol",
            "CarolDaveCarolDave",
            "CarolDaveDaveAlice",
            "CarolDaveDaveBob",
            "CarolDaveDaveCarol",
            "CarolDaveDaveDave",
            "DaveAliceAliceAlice",
            "DaveAliceAliceBob",
            "DaveAliceAliceCarol",
            "DaveAliceAliceDave",
            "DaveAliceBobAlice",
            "DaveAliceBobBob",
            "DaveAliceBobCarol",
            "DaveAliceBobDave",
            "DaveAliceCarolAlice",
            "DaveAliceCarolBob",
            "DaveAliceCarolCarol",
            "DaveAliceCarolDave",
            "DaveAliceDaveAlice",
            "DaveAliceDaveBob",
            "DaveAliceDaveCarol",
            "DaveAliceDaveDave",
            "DaveBobAliceAlice",
            "DaveBobAliceBob",
            "DaveBobAliceCarol",
            "DaveBobAliceDave",
            "DaveBobBobAlice",
            "DaveBobBobBob",
            "DaveBobBobCarol",
            "DaveBobBobDave",
            "DaveBobCarolAlice",
            "DaveBobCarolBob",
            "DaveBobCarolCarol",
            "DaveBobCarolDave",
            "DaveBobDaveAlice",
            "DaveBobDaveBob",
            "DaveBobDaveCarol",
            "DaveBobDaveDave",
            "DaveCarolAliceAlice",
            "DaveCarolAliceBob",
            "DaveCarolAliceCarol",
            "DaveCarolAliceDave",
            "DaveCarolBobAlice",
            "DaveCarolBobBob",
            "DaveCarolBobCarol",
            "DaveCarolBobDave",
            "DaveCarolCarolAlice",
            "DaveCarolCarolBob",
            "DaveCarolCarolCarol",
            "DaveCarolCarolDave",
            "DaveCarolDaveAlice",
            "DaveCarolDaveBob",
            "DaveCarolDaveCarol",
            "DaveCarolDaveDave",
            "DaveDaveAliceAlice",
            "DaveDaveAliceBob",
            "DaveDaveAliceCarol",
            "DaveDaveAliceDave",
            "DaveDaveBobAlice",
            "DaveDaveBobBob",
            "DaveDaveBobCarol",
            "DaveDaveBobDave",
            "DaveDaveCarolAlice",
            "DaveDaveCarolBob",
            "DaveDaveCarolCarol",
            "DaveDaveCarolDave",
            "DaveDaveDaveAlice",
            "DaveDaveDaveBob",
            "DaveDaveDaveCarol",
            "DaveDaveDaveDave",
          ])
    );
    assertQueryResult(
      h,
      `
                # DETACHED is reused directly
                SELECT User.name ++ DETACHED User.name ++
                       User.name ++ DETACHED User.name;
            `,
      unorderedSet([
            "AliceAliceAliceAlice",
            "AliceAliceAliceBob",
            "AliceAliceAliceCarol",
            "AliceAliceAliceDave",
            "AliceAliceBobAlice",
            "AliceAliceBobBob",
            "AliceAliceBobCarol",
            "AliceAliceBobDave",
            "AliceAliceCarolAlice",
            "AliceAliceCarolBob",
            "AliceAliceCarolCarol",
            "AliceAliceCarolDave",
            "AliceAliceDaveAlice",
            "AliceAliceDaveBob",
            "AliceAliceDaveCarol",
            "AliceAliceDaveDave",
            "AliceBobAliceAlice",
            "AliceBobAliceBob",
            "AliceBobAliceCarol",
            "AliceBobAliceDave",
            "AliceBobBobAlice",
            "AliceBobBobBob",
            "AliceBobBobCarol",
            "AliceBobBobDave",
            "AliceBobCarolAlice",
            "AliceBobCarolBob",
            "AliceBobCarolCarol",
            "AliceBobCarolDave",
            "AliceBobDaveAlice",
            "AliceBobDaveBob",
            "AliceBobDaveCarol",
            "AliceBobDaveDave",
            "AliceCarolAliceAlice",
            "AliceCarolAliceBob",
            "AliceCarolAliceCarol",
            "AliceCarolAliceDave",
            "AliceCarolBobAlice",
            "AliceCarolBobBob",
            "AliceCarolBobCarol",
            "AliceCarolBobDave",
            "AliceCarolCarolAlice",
            "AliceCarolCarolBob",
            "AliceCarolCarolCarol",
            "AliceCarolCarolDave",
            "AliceCarolDaveAlice",
            "AliceCarolDaveBob",
            "AliceCarolDaveCarol",
            "AliceCarolDaveDave",
            "AliceDaveAliceAlice",
            "AliceDaveAliceBob",
            "AliceDaveAliceCarol",
            "AliceDaveAliceDave",
            "AliceDaveBobAlice",
            "AliceDaveBobBob",
            "AliceDaveBobCarol",
            "AliceDaveBobDave",
            "AliceDaveCarolAlice",
            "AliceDaveCarolBob",
            "AliceDaveCarolCarol",
            "AliceDaveCarolDave",
            "AliceDaveDaveAlice",
            "AliceDaveDaveBob",
            "AliceDaveDaveCarol",
            "AliceDaveDaveDave",
            "BobAliceAliceAlice",
            "BobAliceAliceBob",
            "BobAliceAliceCarol",
            "BobAliceAliceDave",
            "BobAliceBobAlice",
            "BobAliceBobBob",
            "BobAliceBobCarol",
            "BobAliceBobDave",
            "BobAliceCarolAlice",
            "BobAliceCarolBob",
            "BobAliceCarolCarol",
            "BobAliceCarolDave",
            "BobAliceDaveAlice",
            "BobAliceDaveBob",
            "BobAliceDaveCarol",
            "BobAliceDaveDave",
            "BobBobAliceAlice",
            "BobBobAliceBob",
            "BobBobAliceCarol",
            "BobBobAliceDave",
            "BobBobBobAlice",
            "BobBobBobBob",
            "BobBobBobCarol",
            "BobBobBobDave",
            "BobBobCarolAlice",
            "BobBobCarolBob",
            "BobBobCarolCarol",
            "BobBobCarolDave",
            "BobBobDaveAlice",
            "BobBobDaveBob",
            "BobBobDaveCarol",
            "BobBobDaveDave",
            "BobCarolAliceAlice",
            "BobCarolAliceBob",
            "BobCarolAliceCarol",
            "BobCarolAliceDave",
            "BobCarolBobAlice",
            "BobCarolBobBob",
            "BobCarolBobCarol",
            "BobCarolBobDave",
            "BobCarolCarolAlice",
            "BobCarolCarolBob",
            "BobCarolCarolCarol",
            "BobCarolCarolDave",
            "BobCarolDaveAlice",
            "BobCarolDaveBob",
            "BobCarolDaveCarol",
            "BobCarolDaveDave",
            "BobDaveAliceAlice",
            "BobDaveAliceBob",
            "BobDaveAliceCarol",
            "BobDaveAliceDave",
            "BobDaveBobAlice",
            "BobDaveBobBob",
            "BobDaveBobCarol",
            "BobDaveBobDave",
            "BobDaveCarolAlice",
            "BobDaveCarolBob",
            "BobDaveCarolCarol",
            "BobDaveCarolDave",
            "BobDaveDaveAlice",
            "BobDaveDaveBob",
            "BobDaveDaveCarol",
            "BobDaveDaveDave",
            "CarolAliceAliceAlice",
            "CarolAliceAliceBob",
            "CarolAliceAliceCarol",
            "CarolAliceAliceDave",
            "CarolAliceBobAlice",
            "CarolAliceBobBob",
            "CarolAliceBobCarol",
            "CarolAliceBobDave",
            "CarolAliceCarolAlice",
            "CarolAliceCarolBob",
            "CarolAliceCarolCarol",
            "CarolAliceCarolDave",
            "CarolAliceDaveAlice",
            "CarolAliceDaveBob",
            "CarolAliceDaveCarol",
            "CarolAliceDaveDave",
            "CarolBobAliceAlice",
            "CarolBobAliceBob",
            "CarolBobAliceCarol",
            "CarolBobAliceDave",
            "CarolBobBobAlice",
            "CarolBobBobBob",
            "CarolBobBobCarol",
            "CarolBobBobDave",
            "CarolBobCarolAlice",
            "CarolBobCarolBob",
            "CarolBobCarolCarol",
            "CarolBobCarolDave",
            "CarolBobDaveAlice",
            "CarolBobDaveBob",
            "CarolBobDaveCarol",
            "CarolBobDaveDave",
            "CarolCarolAliceAlice",
            "CarolCarolAliceBob",
            "CarolCarolAliceCarol",
            "CarolCarolAliceDave",
            "CarolCarolBobAlice",
            "CarolCarolBobBob",
            "CarolCarolBobCarol",
            "CarolCarolBobDave",
            "CarolCarolCarolAlice",
            "CarolCarolCarolBob",
            "CarolCarolCarolCarol",
            "CarolCarolCarolDave",
            "CarolCarolDaveAlice",
            "CarolCarolDaveBob",
            "CarolCarolDaveCarol",
            "CarolCarolDaveDave",
            "CarolDaveAliceAlice",
            "CarolDaveAliceBob",
            "CarolDaveAliceCarol",
            "CarolDaveAliceDave",
            "CarolDaveBobAlice",
            "CarolDaveBobBob",
            "CarolDaveBobCarol",
            "CarolDaveBobDave",
            "CarolDaveCarolAlice",
            "CarolDaveCarolBob",
            "CarolDaveCarolCarol",
            "CarolDaveCarolDave",
            "CarolDaveDaveAlice",
            "CarolDaveDaveBob",
            "CarolDaveDaveCarol",
            "CarolDaveDaveDave",
            "DaveAliceAliceAlice",
            "DaveAliceAliceBob",
            "DaveAliceAliceCarol",
            "DaveAliceAliceDave",
            "DaveAliceBobAlice",
            "DaveAliceBobBob",
            "DaveAliceBobCarol",
            "DaveAliceBobDave",
            "DaveAliceCarolAlice",
            "DaveAliceCarolBob",
            "DaveAliceCarolCarol",
            "DaveAliceCarolDave",
            "DaveAliceDaveAlice",
            "DaveAliceDaveBob",
            "DaveAliceDaveCarol",
            "DaveAliceDaveDave",
            "DaveBobAliceAlice",
            "DaveBobAliceBob",
            "DaveBobAliceCarol",
            "DaveBobAliceDave",
            "DaveBobBobAlice",
            "DaveBobBobBob",
            "DaveBobBobCarol",
            "DaveBobBobDave",
            "DaveBobCarolAlice",
            "DaveBobCarolBob",
            "DaveBobCarolCarol",
            "DaveBobCarolDave",
            "DaveBobDaveAlice",
            "DaveBobDaveBob",
            "DaveBobDaveCarol",
            "DaveBobDaveDave",
            "DaveCarolAliceAlice",
            "DaveCarolAliceBob",
            "DaveCarolAliceCarol",
            "DaveCarolAliceDave",
            "DaveCarolBobAlice",
            "DaveCarolBobBob",
            "DaveCarolBobCarol",
            "DaveCarolBobDave",
            "DaveCarolCarolAlice",
            "DaveCarolCarolBob",
            "DaveCarolCarolCarol",
            "DaveCarolCarolDave",
            "DaveCarolDaveAlice",
            "DaveCarolDaveBob",
            "DaveCarolDaveCarol",
            "DaveCarolDaveDave",
            "DaveDaveAliceAlice",
            "DaveDaveAliceBob",
            "DaveDaveAliceCarol",
            "DaveDaveAliceDave",
            "DaveDaveBobAlice",
            "DaveDaveBobBob",
            "DaveDaveBobCarol",
            "DaveDaveBobDave",
            "DaveDaveCarolAlice",
            "DaveDaveCarolBob",
            "DaveDaveCarolCarol",
            "DaveDaveCarolDave",
            "DaveDaveDaveAlice",
            "DaveDaveDaveBob",
            "DaveDaveDaveCarol",
            "DaveDaveDaveDave",
          ])
    );
  });

  it("test_edgeql_scope_detached_02", () => {
    let names = queryRows<string>(h, `
            SELECT User.name ++ <str>count(User.deck);
        `);
    assertQueryResult(
      h,
      `
                # Let's say we need a tournament where everybody will play
                # with everybody twice.
                WITH
                    # calculate some expression ("full" name)
                    X := User.name ++ <str>count(User.deck),
                FOR U0 in X FOR U1 IN X
                SELECT U0 ++ ' vs ' ++ U1
                # get rid of players matching themselves
                FILTER U0 != U1;
            `,
      unorderedSet(names.flatMap((a) => names.filter((b) => a !== b).map((b) => `${a} vs ${b}`)))
    );
  });

  it("test_edgeql_scope_detached_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    # make 3 copies of User.name
                    U0 := DETACHED User.name,
                    U1 := DETACHED User.name,
                    U2 := DETACHED User.name
                SELECT User.name ++ U0 ++ U1 ++ U2;
            `,
      unorderedSet([
            "AliceAliceAliceAlice",
            "AliceAliceAliceBob",
            "AliceAliceAliceCarol",
            "AliceAliceAliceDave",
            "AliceAliceBobAlice",
            "AliceAliceBobBob",
            "AliceAliceBobCarol",
            "AliceAliceBobDave",
            "AliceAliceCarolAlice",
            "AliceAliceCarolBob",
            "AliceAliceCarolCarol",
            "AliceAliceCarolDave",
            "AliceAliceDaveAlice",
            "AliceAliceDaveBob",
            "AliceAliceDaveCarol",
            "AliceAliceDaveDave",
            "AliceBobAliceAlice",
            "AliceBobAliceBob",
            "AliceBobAliceCarol",
            "AliceBobAliceDave",
            "AliceBobBobAlice",
            "AliceBobBobBob",
            "AliceBobBobCarol",
            "AliceBobBobDave",
            "AliceBobCarolAlice",
            "AliceBobCarolBob",
            "AliceBobCarolCarol",
            "AliceBobCarolDave",
            "AliceBobDaveAlice",
            "AliceBobDaveBob",
            "AliceBobDaveCarol",
            "AliceBobDaveDave",
            "AliceCarolAliceAlice",
            "AliceCarolAliceBob",
            "AliceCarolAliceCarol",
            "AliceCarolAliceDave",
            "AliceCarolBobAlice",
            "AliceCarolBobBob",
            "AliceCarolBobCarol",
            "AliceCarolBobDave",
            "AliceCarolCarolAlice",
            "AliceCarolCarolBob",
            "AliceCarolCarolCarol",
            "AliceCarolCarolDave",
            "AliceCarolDaveAlice",
            "AliceCarolDaveBob",
            "AliceCarolDaveCarol",
            "AliceCarolDaveDave",
            "AliceDaveAliceAlice",
            "AliceDaveAliceBob",
            "AliceDaveAliceCarol",
            "AliceDaveAliceDave",
            "AliceDaveBobAlice",
            "AliceDaveBobBob",
            "AliceDaveBobCarol",
            "AliceDaveBobDave",
            "AliceDaveCarolAlice",
            "AliceDaveCarolBob",
            "AliceDaveCarolCarol",
            "AliceDaveCarolDave",
            "AliceDaveDaveAlice",
            "AliceDaveDaveBob",
            "AliceDaveDaveCarol",
            "AliceDaveDaveDave",
            "BobAliceAliceAlice",
            "BobAliceAliceBob",
            "BobAliceAliceCarol",
            "BobAliceAliceDave",
            "BobAliceBobAlice",
            "BobAliceBobBob",
            "BobAliceBobCarol",
            "BobAliceBobDave",
            "BobAliceCarolAlice",
            "BobAliceCarolBob",
            "BobAliceCarolCarol",
            "BobAliceCarolDave",
            "BobAliceDaveAlice",
            "BobAliceDaveBob",
            "BobAliceDaveCarol",
            "BobAliceDaveDave",
            "BobBobAliceAlice",
            "BobBobAliceBob",
            "BobBobAliceCarol",
            "BobBobAliceDave",
            "BobBobBobAlice",
            "BobBobBobBob",
            "BobBobBobCarol",
            "BobBobBobDave",
            "BobBobCarolAlice",
            "BobBobCarolBob",
            "BobBobCarolCarol",
            "BobBobCarolDave",
            "BobBobDaveAlice",
            "BobBobDaveBob",
            "BobBobDaveCarol",
            "BobBobDaveDave",
            "BobCarolAliceAlice",
            "BobCarolAliceBob",
            "BobCarolAliceCarol",
            "BobCarolAliceDave",
            "BobCarolBobAlice",
            "BobCarolBobBob",
            "BobCarolBobCarol",
            "BobCarolBobDave",
            "BobCarolCarolAlice",
            "BobCarolCarolBob",
            "BobCarolCarolCarol",
            "BobCarolCarolDave",
            "BobCarolDaveAlice",
            "BobCarolDaveBob",
            "BobCarolDaveCarol",
            "BobCarolDaveDave",
            "BobDaveAliceAlice",
            "BobDaveAliceBob",
            "BobDaveAliceCarol",
            "BobDaveAliceDave",
            "BobDaveBobAlice",
            "BobDaveBobBob",
            "BobDaveBobCarol",
            "BobDaveBobDave",
            "BobDaveCarolAlice",
            "BobDaveCarolBob",
            "BobDaveCarolCarol",
            "BobDaveCarolDave",
            "BobDaveDaveAlice",
            "BobDaveDaveBob",
            "BobDaveDaveCarol",
            "BobDaveDaveDave",
            "CarolAliceAliceAlice",
            "CarolAliceAliceBob",
            "CarolAliceAliceCarol",
            "CarolAliceAliceDave",
            "CarolAliceBobAlice",
            "CarolAliceBobBob",
            "CarolAliceBobCarol",
            "CarolAliceBobDave",
            "CarolAliceCarolAlice",
            "CarolAliceCarolBob",
            "CarolAliceCarolCarol",
            "CarolAliceCarolDave",
            "CarolAliceDaveAlice",
            "CarolAliceDaveBob",
            "CarolAliceDaveCarol",
            "CarolAliceDaveDave",
            "CarolBobAliceAlice",
            "CarolBobAliceBob",
            "CarolBobAliceCarol",
            "CarolBobAliceDave",
            "CarolBobBobAlice",
            "CarolBobBobBob",
            "CarolBobBobCarol",
            "CarolBobBobDave",
            "CarolBobCarolAlice",
            "CarolBobCarolBob",
            "CarolBobCarolCarol",
            "CarolBobCarolDave",
            "CarolBobDaveAlice",
            "CarolBobDaveBob",
            "CarolBobDaveCarol",
            "CarolBobDaveDave",
            "CarolCarolAliceAlice",
            "CarolCarolAliceBob",
            "CarolCarolAliceCarol",
            "CarolCarolAliceDave",
            "CarolCarolBobAlice",
            "CarolCarolBobBob",
            "CarolCarolBobCarol",
            "CarolCarolBobDave",
            "CarolCarolCarolAlice",
            "CarolCarolCarolBob",
            "CarolCarolCarolCarol",
            "CarolCarolCarolDave",
            "CarolCarolDaveAlice",
            "CarolCarolDaveBob",
            "CarolCarolDaveCarol",
            "CarolCarolDaveDave",
            "CarolDaveAliceAlice",
            "CarolDaveAliceBob",
            "CarolDaveAliceCarol",
            "CarolDaveAliceDave",
            "CarolDaveBobAlice",
            "CarolDaveBobBob",
            "CarolDaveBobCarol",
            "CarolDaveBobDave",
            "CarolDaveCarolAlice",
            "CarolDaveCarolBob",
            "CarolDaveCarolCarol",
            "CarolDaveCarolDave",
            "CarolDaveDaveAlice",
            "CarolDaveDaveBob",
            "CarolDaveDaveCarol",
            "CarolDaveDaveDave",
            "DaveAliceAliceAlice",
            "DaveAliceAliceBob",
            "DaveAliceAliceCarol",
            "DaveAliceAliceDave",
            "DaveAliceBobAlice",
            "DaveAliceBobBob",
            "DaveAliceBobCarol",
            "DaveAliceBobDave",
            "DaveAliceCarolAlice",
            "DaveAliceCarolBob",
            "DaveAliceCarolCarol",
            "DaveAliceCarolDave",
            "DaveAliceDaveAlice",
            "DaveAliceDaveBob",
            "DaveAliceDaveCarol",
            "DaveAliceDaveDave",
            "DaveBobAliceAlice",
            "DaveBobAliceBob",
            "DaveBobAliceCarol",
            "DaveBobAliceDave",
            "DaveBobBobAlice",
            "DaveBobBobBob",
            "DaveBobBobCarol",
            "DaveBobBobDave",
            "DaveBobCarolAlice",
            "DaveBobCarolBob",
            "DaveBobCarolCarol",
            "DaveBobCarolDave",
            "DaveBobDaveAlice",
            "DaveBobDaveBob",
            "DaveBobDaveCarol",
            "DaveBobDaveDave",
            "DaveCarolAliceAlice",
            "DaveCarolAliceBob",
            "DaveCarolAliceCarol",
            "DaveCarolAliceDave",
            "DaveCarolBobAlice",
            "DaveCarolBobBob",
            "DaveCarolBobCarol",
            "DaveCarolBobDave",
            "DaveCarolCarolAlice",
            "DaveCarolCarolBob",
            "DaveCarolCarolCarol",
            "DaveCarolCarolDave",
            "DaveCarolDaveAlice",
            "DaveCarolDaveBob",
            "DaveCarolDaveCarol",
            "DaveCarolDaveDave",
            "DaveDaveAliceAlice",
            "DaveDaveAliceBob",
            "DaveDaveAliceCarol",
            "DaveDaveAliceDave",
            "DaveDaveBobAlice",
            "DaveDaveBobBob",
            "DaveDaveBobCarol",
            "DaveDaveBobDave",
            "DaveDaveCarolAlice",
            "DaveDaveCarolBob",
            "DaveDaveCarolCarol",
            "DaveDaveCarolDave",
            "DaveDaveDaveAlice",
            "DaveDaveDaveBob",
            "DaveDaveDaveCarol",
            "DaveDaveDaveDave",
          ])
    );
    assertQueryResult(
      h,
      `
                # same thing, but building it up differently
                WITH
                    # calculate some expression ("full" name)
                    U0 := User.name,
                    # make that expression DETACHED so that we can do
                    # cross product
                    U1 := U0,
                    # cross product of players
                    U2 := U0 ++ U1,
                    # a copy of the players cross product
                    U3 := U2
                # compute what is effectively a cross product of a cross
                # product of names (expecting 256 results)
                SELECT U2 ++ U3;
            `,
      unorderedSet([
            "AliceAliceAliceAlice",
            "AliceAliceAliceBob",
            "AliceAliceAliceCarol",
            "AliceAliceAliceDave",
            "AliceAliceBobAlice",
            "AliceAliceBobBob",
            "AliceAliceBobCarol",
            "AliceAliceBobDave",
            "AliceAliceCarolAlice",
            "AliceAliceCarolBob",
            "AliceAliceCarolCarol",
            "AliceAliceCarolDave",
            "AliceAliceDaveAlice",
            "AliceAliceDaveBob",
            "AliceAliceDaveCarol",
            "AliceAliceDaveDave",
            "AliceBobAliceAlice",
            "AliceBobAliceBob",
            "AliceBobAliceCarol",
            "AliceBobAliceDave",
            "AliceBobBobAlice",
            "AliceBobBobBob",
            "AliceBobBobCarol",
            "AliceBobBobDave",
            "AliceBobCarolAlice",
            "AliceBobCarolBob",
            "AliceBobCarolCarol",
            "AliceBobCarolDave",
            "AliceBobDaveAlice",
            "AliceBobDaveBob",
            "AliceBobDaveCarol",
            "AliceBobDaveDave",
            "AliceCarolAliceAlice",
            "AliceCarolAliceBob",
            "AliceCarolAliceCarol",
            "AliceCarolAliceDave",
            "AliceCarolBobAlice",
            "AliceCarolBobBob",
            "AliceCarolBobCarol",
            "AliceCarolBobDave",
            "AliceCarolCarolAlice",
            "AliceCarolCarolBob",
            "AliceCarolCarolCarol",
            "AliceCarolCarolDave",
            "AliceCarolDaveAlice",
            "AliceCarolDaveBob",
            "AliceCarolDaveCarol",
            "AliceCarolDaveDave",
            "AliceDaveAliceAlice",
            "AliceDaveAliceBob",
            "AliceDaveAliceCarol",
            "AliceDaveAliceDave",
            "AliceDaveBobAlice",
            "AliceDaveBobBob",
            "AliceDaveBobCarol",
            "AliceDaveBobDave",
            "AliceDaveCarolAlice",
            "AliceDaveCarolBob",
            "AliceDaveCarolCarol",
            "AliceDaveCarolDave",
            "AliceDaveDaveAlice",
            "AliceDaveDaveBob",
            "AliceDaveDaveCarol",
            "AliceDaveDaveDave",
            "BobAliceAliceAlice",
            "BobAliceAliceBob",
            "BobAliceAliceCarol",
            "BobAliceAliceDave",
            "BobAliceBobAlice",
            "BobAliceBobBob",
            "BobAliceBobCarol",
            "BobAliceBobDave",
            "BobAliceCarolAlice",
            "BobAliceCarolBob",
            "BobAliceCarolCarol",
            "BobAliceCarolDave",
            "BobAliceDaveAlice",
            "BobAliceDaveBob",
            "BobAliceDaveCarol",
            "BobAliceDaveDave",
            "BobBobAliceAlice",
            "BobBobAliceBob",
            "BobBobAliceCarol",
            "BobBobAliceDave",
            "BobBobBobAlice",
            "BobBobBobBob",
            "BobBobBobCarol",
            "BobBobBobDave",
            "BobBobCarolAlice",
            "BobBobCarolBob",
            "BobBobCarolCarol",
            "BobBobCarolDave",
            "BobBobDaveAlice",
            "BobBobDaveBob",
            "BobBobDaveCarol",
            "BobBobDaveDave",
            "BobCarolAliceAlice",
            "BobCarolAliceBob",
            "BobCarolAliceCarol",
            "BobCarolAliceDave",
            "BobCarolBobAlice",
            "BobCarolBobBob",
            "BobCarolBobCarol",
            "BobCarolBobDave",
            "BobCarolCarolAlice",
            "BobCarolCarolBob",
            "BobCarolCarolCarol",
            "BobCarolCarolDave",
            "BobCarolDaveAlice",
            "BobCarolDaveBob",
            "BobCarolDaveCarol",
            "BobCarolDaveDave",
            "BobDaveAliceAlice",
            "BobDaveAliceBob",
            "BobDaveAliceCarol",
            "BobDaveAliceDave",
            "BobDaveBobAlice",
            "BobDaveBobBob",
            "BobDaveBobCarol",
            "BobDaveBobDave",
            "BobDaveCarolAlice",
            "BobDaveCarolBob",
            "BobDaveCarolCarol",
            "BobDaveCarolDave",
            "BobDaveDaveAlice",
            "BobDaveDaveBob",
            "BobDaveDaveCarol",
            "BobDaveDaveDave",
            "CarolAliceAliceAlice",
            "CarolAliceAliceBob",
            "CarolAliceAliceCarol",
            "CarolAliceAliceDave",
            "CarolAliceBobAlice",
            "CarolAliceBobBob",
            "CarolAliceBobCarol",
            "CarolAliceBobDave",
            "CarolAliceCarolAlice",
            "CarolAliceCarolBob",
            "CarolAliceCarolCarol",
            "CarolAliceCarolDave",
            "CarolAliceDaveAlice",
            "CarolAliceDaveBob",
            "CarolAliceDaveCarol",
            "CarolAliceDaveDave",
            "CarolBobAliceAlice",
            "CarolBobAliceBob",
            "CarolBobAliceCarol",
            "CarolBobAliceDave",
            "CarolBobBobAlice",
            "CarolBobBobBob",
            "CarolBobBobCarol",
            "CarolBobBobDave",
            "CarolBobCarolAlice",
            "CarolBobCarolBob",
            "CarolBobCarolCarol",
            "CarolBobCarolDave",
            "CarolBobDaveAlice",
            "CarolBobDaveBob",
            "CarolBobDaveCarol",
            "CarolBobDaveDave",
            "CarolCarolAliceAlice",
            "CarolCarolAliceBob",
            "CarolCarolAliceCarol",
            "CarolCarolAliceDave",
            "CarolCarolBobAlice",
            "CarolCarolBobBob",
            "CarolCarolBobCarol",
            "CarolCarolBobDave",
            "CarolCarolCarolAlice",
            "CarolCarolCarolBob",
            "CarolCarolCarolCarol",
            "CarolCarolCarolDave",
            "CarolCarolDaveAlice",
            "CarolCarolDaveBob",
            "CarolCarolDaveCarol",
            "CarolCarolDaveDave",
            "CarolDaveAliceAlice",
            "CarolDaveAliceBob",
            "CarolDaveAliceCarol",
            "CarolDaveAliceDave",
            "CarolDaveBobAlice",
            "CarolDaveBobBob",
            "CarolDaveBobCarol",
            "CarolDaveBobDave",
            "CarolDaveCarolAlice",
            "CarolDaveCarolBob",
            "CarolDaveCarolCarol",
            "CarolDaveCarolDave",
            "CarolDaveDaveAlice",
            "CarolDaveDaveBob",
            "CarolDaveDaveCarol",
            "CarolDaveDaveDave",
            "DaveAliceAliceAlice",
            "DaveAliceAliceBob",
            "DaveAliceAliceCarol",
            "DaveAliceAliceDave",
            "DaveAliceBobAlice",
            "DaveAliceBobBob",
            "DaveAliceBobCarol",
            "DaveAliceBobDave",
            "DaveAliceCarolAlice",
            "DaveAliceCarolBob",
            "DaveAliceCarolCarol",
            "DaveAliceCarolDave",
            "DaveAliceDaveAlice",
            "DaveAliceDaveBob",
            "DaveAliceDaveCarol",
            "DaveAliceDaveDave",
            "DaveBobAliceAlice",
            "DaveBobAliceBob",
            "DaveBobAliceCarol",
            "DaveBobAliceDave",
            "DaveBobBobAlice",
            "DaveBobBobBob",
            "DaveBobBobCarol",
            "DaveBobBobDave",
            "DaveBobCarolAlice",
            "DaveBobCarolBob",
            "DaveBobCarolCarol",
            "DaveBobCarolDave",
            "DaveBobDaveAlice",
            "DaveBobDaveBob",
            "DaveBobDaveCarol",
            "DaveBobDaveDave",
            "DaveCarolAliceAlice",
            "DaveCarolAliceBob",
            "DaveCarolAliceCarol",
            "DaveCarolAliceDave",
            "DaveCarolBobAlice",
            "DaveCarolBobBob",
            "DaveCarolBobCarol",
            "DaveCarolBobDave",
            "DaveCarolCarolAlice",
            "DaveCarolCarolBob",
            "DaveCarolCarolCarol",
            "DaveCarolCarolDave",
            "DaveCarolDaveAlice",
            "DaveCarolDaveBob",
            "DaveCarolDaveCarol",
            "DaveCarolDaveDave",
            "DaveDaveAliceAlice",
            "DaveDaveAliceBob",
            "DaveDaveAliceCarol",
            "DaveDaveAliceDave",
            "DaveDaveBobAlice",
            "DaveDaveBobBob",
            "DaveDaveBobCarol",
            "DaveDaveBobDave",
            "DaveDaveCarolAlice",
            "DaveDaveCarolBob",
            "DaveDaveCarolCarol",
            "DaveDaveCarolDave",
            "DaveDaveDaveAlice",
            "DaveDaveDaveBob",
            "DaveDaveDaveCarol",
            "DaveDaveDaveDave",
          ])
    );
  });

  it("test_edgeql_scope_detached_04", () => {
    expect(() => {
      h.query(
        `
                    SELECT User.friends
                    FILTER User.friends@nickname = 'Firefighter';
                `
      );
    }).toThrow(new RegExp("'User' changes the interpretation of 'User'"));
    expect(() => {
      h.query(
        `
                SELECT User.friends
                FILTER (
                    # create an independent link target set
                    WITH F := DETACHED User.friends
                    # explicitly connect it back to our User
                    SELECT F
                    FILTER F.<friends = User
                ).friends@nickname = 'Firefighter';
                `
      );
    }).toThrow(new RegExp("'User' changes the interpretation of 'User'"));
  });

  it("test_edgeql_scope_detached_05", () => {
    assertQueryResult(
      h,
      `
                # Natural syntax for filtering friends based on nickname:
                SELECT User {
                    name,
                    friends: {
                        name
                    } FILTER @nickname = 'Firefighter'
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "friends": [
                {
                  "name": "Carol",
                },
              ],
            },
            {
              "name": "Bob",
              "friends": [],
            },
            {
              "name": "Carol",
              "friends": [],
            },
            {
              "name": "Dave",
              "friends": [],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                # Alternative natural syntax for filtering friends based
                # on nickname:
                SELECT User {
                    name,
                    fr := (
                        SELECT User.friends {
                            name
                        }
                        FILTER @nickname = 'Firefighter'
                    )
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "fr": [
                {
                  "name": "Carol",
                },
              ],
            },
            {
              "name": "Bob",
              "fr": [],
            },
            {
              "name": "Carol",
              "fr": [],
            },
            {
              "name": "Dave",
              "fr": [],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                # The above query is legal, but the reason why may be more
                # obvious with the equivalent query below.
                SELECT User {
                    name,
                    fr := (
                        WITH F0 := (
                            WITH F1 := DETACHED User.friends
                            SELECT F1
                            # explicitly connect it back to our User
                            FILTER .<friends = User
                        )
                        SELECT F0 {name}
                        FILTER .<friends[IS User]@nickname = 'Firefighter'
                    )
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "fr": [
                {
                  "name": "Carol",
                },
              ],
            },
            {
              "name": "Bob",
              "fr": [],
            },
            {
              "name": "Carol",
              "fr": [],
            },
            {
              "name": "Dave",
              "fr": [],
            },
          ]
    );
  });

  it("test_edgeql_scope_detached_06", () => {
    assertQueryResult(
      h,
      `
                WITH
                    U2 := DETACHED User
                SELECT User {
                    name,
                    foo := (SELECT U2 {name} ORDER BY U2.name)
                }
                # the FILTER clause is irrelevant because it's in a
                # parallel scope to the other mentions of U2
                FILTER U2.name = 'Alice'
                ORDER BY User.name;
            `,
      [
            {
              "name": "Alice",
              "foo": [
                {
                  "name": "Alice",
                },
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Bob",
              "foo": [
                {
                  "name": "Alice",
                },
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Carol",
              "foo": [
                {
                  "name": "Alice",
                },
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Dave",
              "foo": [
                {
                  "name": "Alice",
                },
                {
                  "name": "Bob",
                },
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_detached_07", () => {
    let res = queryRows<unknown>(h, `
            SELECT User {
                name,
                fire_deck := (
                    SELECT .deck {name, element}
                    FILTER .element = 'Fire'
                    ORDER BY .name
                )
            };
        `);
    assertQueryResult(
      h,
      `
                # adding a top-level DETACHED should not change anything at all
                SELECT DETACHED User {
                    name,
                    fire_deck := (
                        SELECT .deck {name, element}
                        FILTER .element = 'Fire'
                        ORDER BY .name
                    )
                };
            `,
      unorderedBag(res)
    );
  });

  it("test_edgeql_scope_detached_08", () => {
    let res = queryRows<unknown>(h, `
            SELECT User {
                name,
                fire_deck := (
                    SELECT .deck {name, element}
                    FILTER .element = 'Fire'
                    ORDER BY .name
                ).name
            };
        `);
    assertQueryResult(
      h,
      `
                # adding a top-level DETACHED should not change anything at all
                SELECT DETACHED User {
                    name,
                    fire_deck := (
                        SELECT .deck {name, element}
                        FILTER .element = 'Fire'
                        ORDER BY .name
                    ).name
                };
            `,
      unorderedBag(res)
    );
    assertQueryResult(
      h,
      `
                # adding a top-level DETACHED should not change anything at all
                SELECT DETACHED User {
                    name,
                    fire_deck := (
                        SELECT .deck {name, element}
                        FILTER .element = 'Fire'
                        ORDER BY .name
                    ).name
                };
            `,
      unorderedBag(res)
    );
  });

  it("test_edgeql_scope_detached_09", () => {
    expect(() => {
      h.script(
        `
                    SELECT DETACHED User {name}
                    # a subtle error
                    ORDER BY User.name;
                `
      );
    }).toThrow(new RegExp("only singletons are allowed"));
    assertQueryResult(
      h,
      `
                SELECT DETACHED User {name}
                # correct usage
                ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
            },
            {
              "name": "Bob",
            },
            {
              "name": "Carol",
            },
            {
              "name": "Dave",
            },
          ]
    );
  });

  it("test_edgeql_scope_detached_10", () => {
    assertQueryResult(
      h,
      `
                WITH
                    Card := (SELECT Card FILTER .name = 'Bog monster')
                # The contents of the shape will be detached, thus
                # the \`Card\` mentioned in the shape will be referring to
                # the set of all issues and not the one defined in the
                # WITH clause.
                SELECT
                    _ := (
                        Card,
                        DETACHED (User {
                            name,
                            fire_cards := (
                                SELECT User.deck {
                                    name,
                                    element,
                                }
                                FILTER User.deck IN Card
                                ORDER BY .name
                            ),
                        }),
                    ).1
                ORDER BY _.name;
            `,
      [
            {
              "name": "Alice",
              "fire_cards": [
                {
                  "name": "Bog monster",
                  "element": "Water",
                },
                {
                  "name": "Dragon",
                  "element": "Fire",
                },
                {
                  "name": "Giant turtle",
                  "element": "Water",
                },
                {
                  "name": "Imp",
                  "element": "Fire",
                },
              ],
            },
            {
              "name": "Bob",
              "fire_cards": [
                {
                  "name": "Bog monster",
                  "element": "Water",
                },
                {
                  "name": "Dwarf",
                  "element": "Earth",
                },
                {
                  "name": "Giant turtle",
                  "element": "Water",
                },
                {
                  "name": "Golem",
                  "element": "Earth",
                },
              ],
            },
            {
              "name": "Carol",
              "fire_cards": [
                {
                  "name": "Bog monster",
                  "element": "Water",
                },
                {
                  "name": "Djinn",
                  "element": "Air",
                },
                {
                  "name": "Dwarf",
                  "element": "Earth",
                },
                {
                  "name": "Giant eagle",
                  "element": "Air",
                },
                {
                  "name": "Giant turtle",
                  "element": "Water",
                },
                {
                  "name": "Golem",
                  "element": "Earth",
                },
                {
                  "name": "Sprite",
                  "element": "Air",
                },
              ],
            },
            {
              "name": "Dave",
              "fire_cards": [
                {
                  "name": "Bog monster",
                  "element": "Water",
                },
                {
                  "name": "Djinn",
                  "element": "Air",
                },
                {
                  "name": "Dragon",
                  "element": "Fire",
                },
                {
                  "name": "Giant eagle",
                  "element": "Air",
                },
                {
                  "name": "Giant turtle",
                  "element": "Water",
                },
                {
                  "name": "Golem",
                  "element": "Earth",
                },
                {
                  "name": "Sprite",
                  "element": "Air",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_detached_11", () => {
    assertQueryResult(
      h,
      `
            SELECT _ := (User.name, { x := User.name }) ORDER BY _;
            `,
      [
            [
              "Alice",
              {
                "x": ["Alice", "Bob", "Carol", "Dave"],
              },
            ],
            [
              "Bob",
              {
                "x": ["Alice", "Bob", "Carol", "Dave"],
              },
            ],
            [
              "Carol",
              {
                "x": ["Alice", "Bob", "Carol", "Dave"],
              },
            ],
            [
              "Dave",
              {
                "x": ["Alice", "Bob", "Carol", "Dave"],
              },
            ],
          ]
    );
  });

  it("test_edgeql_scope_detached_12", () => {
    assertQueryResult(
      h,
      `
            SELECT DETACHED (User { name2 := User.name }) ORDER BY .name;
            `,
      [
            {
              "name2": "Alice",
            },
            {
              "name2": "Bob",
            },
            {
              "name2": "Carol",
            },
            {
              "name2": "Dave",
            },
          ]
    );
  });

  it("test_edgeql_scope_detached_13", () => {
    assertQueryResult(
      h,
      `
            SELECT (DETACHED User) { name2 := .name } ORDER BY .name;
            `,
      [
            {
              "name2": "Alice",
            },
            {
              "name2": "Bob",
            },
            {
              "name2": "Carol",
            },
            {
              "name2": "Dave",
            },
          ]
    );
  });

  it("test_edgeql_scope_detached_14", () => {
    assertQueryResult(
      h,
      `
            SELECT (DETACHED User) { names := User.name }
            `,
      [
            {
              "names": unorderedSet(["Alice", "Bob", "Carol", "Dave"]),
            },
            {
              "names": unorderedSet(["Alice", "Bob", "Carol", "Dave"]),
            },
            {
              "names": unorderedSet(["Alice", "Bob", "Carol", "Dave"]),
            },
            {
              "names": unorderedSet(["Alice", "Bob", "Carol", "Dave"]),
            },
          ]
    );
  });

  it("test_edgeql_scope_union_01", () => {
    assertQueryResult(
      h,
      `
                # UNION and \`{...}\` should create SET OF scoped operands,
                # therefore \`count\` should operate on the entire set
                SELECT len(User.name) UNION count(User);
            `,
      unorderedBag([3, 4, 4, 5, 5])
    );
    assertQueryResult(
      h,
      `
                SELECT {len(User.name), count(User)};
            `,
      unorderedBag([3, 4, 4, 5, 5])
    );
  });

  it("test_edgeql_scope_union_02", () => {
    assertQueryResult(
      h,
      `
                # UNION and \`{...}\` should create SET OF scoped operands,
                # therefore FILTER should not be effective
                SELECT len(User.name)
                FILTER User.name > 'C';
            `,
      unorderedBag([3, 4, 5, 5])
    );
    assertQueryResult(
      h,
      `
                SELECT {len(User.name)}
                FILTER User.name > 'C';
            `,
      unorderedBag([3, 4, 5, 5])
    );
    assertQueryResult(
      h,
      `
                SELECT {len(User.name), count(User)}
                FILTER User.name > 'C';
            `,
      unorderedBag([3, 4, 4, 5, 5])
    );
  });

  it("test_edgeql_scope_computables_01 [xfail: This broke with SIMPLE_SCOPING but something about it is worth saving I think]", () => {
    assertQueryResult(
      h,
      `
                SELECT x := (User.name, User.deck.name, User.deck_cost)
                FILTER x.0 = 'Alice'
                ORDER BY x.1;
            `,
      [
            ["Alice", "Bog monster", 11],
            ["Alice", "Dragon", 11],
            ["Alice", "Giant turtle", 11],
            ["Alice", "Imp", 11],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT x := (User.name, User.deck.name, sum(User.deck.cost))
                FILTER x.0 = 'Alice'
                ORDER BY x.1;
            `,
      [
            ["Alice", "Bog monster", 2],
            ["Alice", "Dragon", 5],
            ["Alice", "Giant turtle", 3],
            ["Alice", "Imp", 1],
          ]
    );
  });

  it("test_edgeql_scope_computables_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Card {
                    name,
                    alice := (SELECT User FILTER User.name = 'Alice')
                } FILTER Card.alice != User AND Card.name = 'Bog monster';
            `,
      [
            {
              "name": "Bog monster",
            },
          ]
    );
  });

  it("test_edgeql_scope_computables_03", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    # a sub-shape with a computable property is ordered
                    deck: {
                        name,
                        elemental_cost,
                    } ORDER BY .name
                } FILTER .name = 'Alice';
            `,
      [
            {
              "name": "Alice",
              "deck": [
                {
                  "name": "Bog monster",
                  "elemental_cost": "2 Water",
                },
                {
                  "name": "Dragon",
                  "elemental_cost": "5 Fire",
                },
                {
                  "name": "Giant turtle",
                  "elemental_cost": "3 Water",
                },
                {
                  "name": "Imp",
                  "elemental_cost": "1 Fire",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_computables_04", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    # a sub-shape with a computable link is ordered
                    deck: {
                        name,
                        owners: {
                            name
                        } ORDER BY .name,
                    } ORDER BY .name
                } FILTER .name = 'Alice';
            `,
      [
            {
              "name": "Alice",
              "deck": [
                {
                  "name": "Bog monster",
                  "owners": [
                    {
                      "name": "Alice",
                    },
                    {
                      "name": "Bob",
                    },
                    {
                      "name": "Carol",
                    },
                    {
                      "name": "Dave",
                    },
                  ],
                },
                {
                  "name": "Dragon",
                  "owners": [
                    {
                      "name": "Alice",
                    },
                    {
                      "name": "Dave",
                    },
                  ],
                },
                {
                  "name": "Giant turtle",
                  "owners": [
                    {
                      "name": "Alice",
                    },
                    {
                      "name": "Bob",
                    },
                    {
                      "name": "Carol",
                    },
                    {
                      "name": "Dave",
                    },
                  ],
                },
                {
                  "name": "Imp",
                  "owners": [
                    {
                      "name": "Alice",
                    },
                  ],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_computables_05", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    # a sub-shape with a computable derived from a
                    # computable link is ordered
                    deck: {
                        name,
                        o_name := User.deck.owners.name,
                    } ORDER BY .name
                } FILTER .name = 'Alice';
            `,
      [
            {
              "name": "Alice",
              "deck": [
                {
                  "name": "Bog monster",
                  "o_name": unorderedSet(["Alice", "Bob", "Carol", "Dave"]),
                },
                {
                  "name": "Dragon",
                  "o_name": unorderedSet(["Alice", "Dave"]),
                },
                {
                  "name": "Giant turtle",
                  "o_name": unorderedSet(["Alice", "Bob", "Carol", "Dave"]),
                },
                {
                  "name": "Imp",
                  "o_name": unorderedSet(["Alice"]),
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_computables_06", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    # a sub-shape with some arbitrary computable link
                    multi x := (
                        SELECT Card { name }
                        FILTER .elemental_cost = '1 Fire'
                    )
                } FILTER .name = 'Alice';
            `,
      [
            {
              "name": "Alice",
              "x": [
                {
                  "name": "Imp",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_computables_07a", () => {
    assertQueryResult(
      h,
      `
                WITH U := User { cards := .deck },
                SELECT count((U.cards.name, U.cards.cost));
            `,
      [81]
    );
  });

  it("test_edgeql_scope_computables_07b", () => {
    assertQueryResult(
      h,
      `
                WITH U := User { cards := Card },
                SELECT count((U.cards.name, U.cards.cost));
            `,
      [81]
    );
  });

  it("test_edgeql_scope_computables_07c", () => {
    assertQueryResult(
      h,
      `
                WITH U := (SELECT User { cards := Card }
                           FILTER .name = "Phil"),
                SELECT count((U.cards.name, U.cards.cost));
            `,
      [0]
    );
  });

  it("test_edgeql_scope_computables_08", () => {
    assertQueryResult(
      h,
      `
                SELECT count((Card.owners.name, Card.owners.deck_cost));
            `,
      [16]
    );
  });

  it("test_edgeql_scope_computables_09a", () => {
    assertQueryResult(
      h,
      `
                WITH U := User {
                        unowned := (SELECT Card FILTER Card NOT IN User.deck)
                    },
                SELECT _ := U.unowned.name ORDER BY _;
            `,
      [
            "Djinn",
            "Dragon",
            "Dwarf",
            "Giant eagle",
            "Golem",
            "Imp",
            "Sprite",
          ]
    );
  });

  it("test_edgeql_scope_computables_09b", () => {
    assertQueryResult(
      h,
      `
                WITH U := (SELECT User {
                        unowned := (SELECT Card FILTER Card NOT IN User.deck)
                    } FILTER .name IN {'Carol', 'Dave'}),
                SELECT _ := U.unowned.name ORDER BY _;
            `,
      ["Dragon", "Dwarf", "Imp"]
    );
  });

  it("test_edgeql_scope_computables_11a", () => {
    assertQueryResult(
      h,
      `
                WITH U := (SELECT User {
                        deck: {name, a := Award},
                    }),
                SELECT count((U.deck.a.name, U.deck.a.id, U.deck.name));
            `,
      [81]
    );
  });

  it("test_edgeql_scope_computables_11b", () => {
    assertQueryResult(
      h,
      `
                WITH U := (SELECT User {
                        cards := .deck {name, a := Award},
                    }),
                SELECT count((U.cards.a.name, U.cards.a.id, U.cards.name));
            `,
      [81]
    );
  });

  it("test_edgeql_scope_computables_11c", () => {
    assertQueryResult(
      h,
      `
                WITH U := (SELECT User {
                        cards := .deck {name, a := Award},
                    }),
                SELECT (U.cards.a.name, U.cards.a.id, U.cards) LIMIT 1;
            `,
      [
            [
              "str",
              "str",
              {
                "id": "str",
              },
            ],
          ]
    );
  });

  it("test_edgeql_scope_computables_12", () => {
    assertQueryResult(
      h,
      `
                WITH rows := Named,
                SELECT rows {
                    name, owner_count := count([IS Card].owners)
                } FILTER .name IN {'1st', 'Alice', 'Dwarf'} ORDER BY .name;
            `,
      [
            {
              "name": "1st",
              "owner_count": 0,
            },
            {
              "name": "Alice",
              "owner_count": 0,
            },
            {
              "name": "Dwarf",
              "owner_count": 2,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (Named { name }) {
                    name, owner_count := count([IS Card].owners)
                } FILTER .name IN {'1st', 'Alice', 'Dwarf'} ORDER BY .name;
            `,
      [
            {
              "name": "1st",
              "owner_count": 0,
            },
            {
              "name": "Alice",
              "owner_count": 0,
            },
            {
              "name": "Dwarf",
              "owner_count": 2,
            },
          ]
    );
  });

  it("test_edgeql_scope_computables_13", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    title := (SELECT _ := User.name)
                }
                FILTER .title = 'Alice';
            `,
      [
            {
              "title": "Alice",
            },
          ]
    );
  });

  it("test_edgeql_scope_with_01", () => {
    assertQueryResult(
      h,
      `
                WITH
                    User := User,
                    User := User,
                    User := User
                SELECT User.name;
            `,
      unorderedSet(["Alice", "Bob", "Carol", "Dave"])
    );
    assertQueryResult(
      h,
      `
                WITH
                    User := Card,
                    User := User
                # this is a Card.name now
                SELECT User.name;
            `,
      unorderedSet([
            "Bog monster",
            "Djinn",
            "Dragon",
            "Dwarf",
            "Giant eagle",
            "Giant turtle",
            "Golem",
            "Imp",
            "Sprite",
          ])
    );
    assertQueryResult(
      h,
      `
                WITH
                    User := User,
                    User := User.deck,
                    User := User.element,
                    User := User
                # this is a User.deck.element now
                SELECT DISTINCT User;
            `,
      unorderedSet(["Air", "Earth", "Fire", "Water"])
    );
  });

  it("test_edgeql_scope_with_02", () => {
    assertQueryResult(
      h,
      `
                WITH
                    X := {1, 2},
                    Y := X + 1,
                SELECT _ := (X, Y) ORDER BY _;
            `,
      [
            [1, 2],
            [1, 3],
            [2, 2],
            [2, 3],
          ]
    );
  });

  it("test_edgeql_scope_with_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    a := count({Card.name})
                SELECT Card {name, a := a} FILTER .name = 'Imp';
            `,
      [
            {
              "name": "Imp",
              "a": 9,
            },
          ]
    );
  });

  it("test_edgeql_scope_unused_with_def_01", () => {
    assertQueryResult(
      h,
      `
                WITH foo := 1
                SELECT 1;
            `,
      [1]
    );
  });

  it("test_edgeql_scope_nested_computable_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    deck: {
                        name,
                        awards: { name } ORDER BY .name
                    }
                }
                FILTER EXISTS (User.deck.awards)
                ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
            },
            {
              "name": "Carol",
            },
            {
              "name": "Dave",
            },
          ]
    );
  });

  it("test_edgeql_scope_nested_computable_02", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                }
                FILTER EXISTS (User.deck.good_awards)
                ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
            },
            {
              "name": "Dave",
            },
          ]
    );
  });

  it("test_edgeql_scope_link_narrow_card_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    specials := .deck[IS SpecialCard].name
                } ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "specials": [],
            },
            {
              "name": "Bob",
              "specials": [],
            },
            {
              "name": "Carol",
              "specials": ["Djinn"],
            },
            {
              "name": "Dave",
              "specials": ["Djinn"],
            },
          ]
    );
  });

  it("test_edgeql_scope_link_narrow_computable_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Card {
                    owners[IS Bot]: {name}
                } FILTER .name = 'Sprite'
            `,
      [
            {
              "owners": [
                {
                  "name": "Dave",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_branch_01", () => {
    assertQueryResult(
      h,
      `
                SELECT count(((SELECT User), ((User),).0));
            `,
      [16]
    );
  });

  it("test_edgeql_scope_branch_02", () => {
    assertQueryResult(
      h,
      `
                SELECT count((
                    (SELECT User.name),
                    ((SELECT User.name) ++ (User.name),).0,
                 ));
            `,
      [64]
    );
  });

  it("test_edgeql_scope_branch_03", () => {
    assertQueryResult(
      h,
      `
                SELECT count((
                    (SELECT User.name),
                    ((SELECT User.name) ++ (User.name)) ?? "uhoh",
                 ));
            `,
      [64]
    );
  });

  it("test_edgeql_scope_computable_factoring_01", () => {
    assertQueryResult(
      h,
      `
                WITH U := (
                        SELECT User {
                            cards := (
                                SELECT .deck {
                                    foo := .name
                                }
                            )
                        } FILTER .name = 'Dave'
                    )
                SELECT
                    count(((SELECT U.cards.foo), (SELECT U.cards.foo)));
            `,
      [49]
    );
  });

  it("test_edgeql_scope_computable_factoring_02", () => {
    assertQueryResult(
      h,
      `
                WITH U := (
                        SELECT User {
                            cards := (
                                SELECT .deck {
                                    foo := .name
                                }
                            )
                        } FILTER .name = 'Dave'
                    )
                SELECT
                    count(((SELECT U.cards.foo),
                          ((SELECT U.cards.foo), (U.cards.foo))))
            `,
      [343]
    );
  });

  it("test_edgeql_scope_computable_factoring_03", () => {
    assertQueryResult(
      h,
      `
                WITH U := (
                        SELECT User {
                            cards := (
                                SELECT .deck {
                                    foo := .name
                                }
                            )
                        } FILTER .name = 'Dave'
                    )
                SELECT
                    count(((SELECT U.cards.foo),
                          (((SELECT U.cards.foo), (U.cards.foo)),).0))
            `,
      [343]
    );
  });

  it("test_edgeql_scope_3x_nested_materialized_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    avatar: {
                        name,
                        awards: {
                            name,
                            nonce := random(),
                        },
                    }
                }
                FILTER EXISTS User.avatar.awards AND User.name = 'Alice';
            `,
      [
            {
              "avatar": {
                "awards": unorderedBag([
                  {
                    "name": "1st",
                  },
                  {
                    "name": "3rd",
                  },
                ]),
                "name": "Dragon",
              },
              "name": "Alice",
            },
          ]
    );
  });

  it("test_edgeql_scope_3x_nested_materialized_02", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    avatar: {
                        name,
                        awd := (SELECT .awards {
                            name,
                            nonce := random(),
                        } FILTER .name = '1st'),
                    }
                }
                FILTER EXISTS User.avatar.awd AND User.name = 'Alice';
            `,
      [
            {
              "avatar": {
                "awd": {
                  "name": "1st",
                },
                "name": "Dragon",
              },
              "name": "Alice",
            },
          ]
    );
  });

  it("test_edgeql_scope_source_rebind_01", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (SELECT User { tag := User.name }),
                A := (SELECT U FILTER .name = 'Alice'),
                SELECT A.tag;
            `,
      ["Alice"]
    );
  });

  it("test_edgeql_scope_source_rebind_02a", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (SELECT User { tag := (
                    SELECT User.name FILTER random() > 0) }),
                A := (SELECT U FILTER .name = 'Alice'),
                SELECT A.tag;
            `,
      ["Alice"]
    );
  });

  it("test_edgeql_scope_source_rebind_02b [xerror: can't find materialized set]", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (SELECT User { tag := (
                    SELECT User.name FILTER random() > 0) }),
                A := (SELECT U FILTER .name = 'Alice'),
                SELECT (A,).0.tag;
            `,
      ["Alice"]
    );
  });

  it("test_edgeql_scope_source_rebind_03a", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (SELECT User {
                    cards := (SELECT .deck FILTER random() > 0) }),
                A := (SELECT U FILTER .name = 'Alice')
                SELECT A {cards: {name}};
            `,
      [
            {
              "cards": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_scope_source_rebind_03b", () => {
    h.script(
      `
            alter type User create access policy test
            allow all using (true)
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                U := (SELECT User {
                    cards := (SELECT .deck FILTER random() > 0) }),
                A := (SELECT U FILTER .name = 'Alice')
                SELECT A {cards: {name}};
            `,
      [
            {
              "cards": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_scope_source_rebind_04", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (for c in {'A', 'B', 'C', 'D'} union (
                    SELECT User { name, single tag := c }
                    FILTER .name[0] = c and random() > 0)),
                A := (SELECT U {name} FILTER .name IN {'Alice', 'Bob'})
                     {name },
                SELECT A { name, tag };
            `,
      unorderedBag([
            {
              "name": "Alice",
              "tag": "A",
            },
            {
              "name": "Bob",
              "tag": "B",
            },
          ])
    );
  });

  it("test_edgeql_scope_source_rebind_05", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (SELECT User {
                    cards := (SELECT .deck FILTER random() > 0
                              ORDER BY .name LIMIT 1) }),
                A := (SELECT U FILTER .name = 'Alice')
                SELECT A {cards: {name}};
            `,
      [
            {
              "cards": {
                "name": "Bog monster",
              },
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    cards := (SELECT (SELECT _ := .deck {
                        tag := .name ++ " - " ++ User.name,
                    }
                    ) ORDER BY .name)
                } FILTER .name = 'Alice'
            `,
      [
            {
              "cards": [
                {
                  "tag": "Bog monster - Alice",
                },
                {
                  "tag": "Dragon - Alice",
                },
                {
                  "tag": "Giant turtle - Alice",
                },
                {
                  "tag": "Imp - Alice",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_02a", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    cards := (SELECT _ := .deck {
                        multi tag := User.name,
                    })
                } FILTER .name = 'Alice' AND EXISTS .cards;
            `,
      [
            {
              "cards": [
                {
                  "tag": ["Alice"],
                },
                {
                  "tag": ["Alice"],
                },
                {
                  "tag": ["Alice"],
                },
                {
                  "tag": ["Alice"],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_02b", () => {
    assertQueryResult(
      h,
      `
                SELECT (for u IN User UNION u {
                    cards := (SELECT _ := .deck {
                        multi tag := u.name,
                    })
                }) FILTER .name = 'Alice' AND EXISTS .cards;
            `,
      [
            {
              "cards": [
                {
                  "tag": ["Alice"],
                },
                {
                  "tag": ["Alice"],
                },
                {
                  "tag": ["Alice"],
                },
                {
                  "tag": ["Alice"],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_03", () => {
    assertQueryResult(
      h,
      `
                WITH A := (SELECT User {
                    cards := .deck {
                        name,
                        multi tag := User.name ++ " - " ++ .name,
                    }
                } FILTER .name = 'Alice'),
                SELECT _ := A.cards.tag ORDER BY _;
            `,
      ["Alice - Bog monster", "Alice - Dragon", "Alice - Giant turtle", "Alice - Imp"]
    );
    assertQueryResult(
      h,
      `
                WITH A := (SELECT AliasedFriends {
                    cards := .deck {
                        name,
                        multi tag := AliasedFriends.name ++ " - " ++ .name,
                    }
                } FILTER .name = 'Alice'),
                SELECT _ := A.cards.tag ORDER BY _;
            `,
      ["Alice - Bog monster", "Alice - Dragon", "Alice - Giant turtle", "Alice - Imp"]
    );
    assertQueryResult(
      h,
      `
                WITH A := (SELECT AliasedFriends {
                    cards := .deck {
                        name,
                        multi tag := (
                            SELECT _ := AliasedFriends.name ++ " - " ++ .name),
                    }
                } FILTER .name = 'Alice'),
                SELECT _ := A.cards.tag ORDER BY _;
            `,
      ["Alice - Bog monster", "Alice - Dragon", "Alice - Giant turtle", "Alice - Imp"]
    );
  });

  it("test_edgeql_scope_ref_outer_04", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (
                    SELECT User {
                        cards := .deck {
                            name,
                            multi tag := User.name ++ " - " ++ .name,
                        }
                    }),
                A := (SELECT U FILTER .name = 'Alice'),
                SELECT _ := A.cards.tag ORDER BY _;
            `,
      ["Alice - Bog monster", "Alice - Dragon", "Alice - Giant turtle", "Alice - Imp"]
    );
  });

  it("test_edgeql_scope_ref_outer_05a", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (
                    SELECT User {
                        cards := .deck {
                            name,
                            tag := User.name ++ " - " ++ .name,
                        }
                    }),
                A := (SELECT U FILTER .name = 'Alice'),
                B := (SELECT U FILTER .name = 'Bob'),
                SELECT { a := A.cards.tag, b := B.cards.tag };
            `,
      [
            {
              "a": unorderedSet(["Alice - Bog monster", "Alice - Dragon", "Alice - Giant turtle", "Alice - Imp"]),
              "b": unorderedSet(["Bob - Bog monster", "Bob - Dwarf", "Bob - Giant turtle", "Bob - Golem"]),
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_05b [xfail: gives every user name in the output this was xfailed for a long time, and then the xfail was removed in #8405 when we switched to simple_scoping for tests. But I don't think it was working for any fundamental reason, so when I broke it in simple_scoping mode while doing some optimizations, I figured it was fine for now.]", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (
                    SELECT User {
                        cards := .deck {
                            name,
                            tag := User.name ++ " - " ++ .name,
                        }
                    }),
                A := (SELECT U FILTER .name = 'Alice'),
                B := (SELECT U FILTER .name = 'Bob'),
                SELECT { a := (A.cards,).0.tag, b := B.cards.tag };
            `,
      [
            {
              "a": unorderedSet(["Alice - Bog monster", "Alice - Dragon", "Alice - Giant turtle", "Alice - Imp"]),
              "b": unorderedSet(["Bob - Bog monster", "Bob - Dwarf", "Bob - Giant turtle", "Bob - Golem"]),
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_06a", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (
                    SELECT User {
                        cards := .deck {
                            name,
                            tag := User.name ++ " - " ++ .name,
                        }
                    }),
                A := (SELECT U FILTER .name = 'Alice'),
                B := (SELECT U FILTER .name = 'Bob'),
                Bc := B.cards,
                SELECT { a := A.cards.tag, b := Bc.tag };
            `,
      [
            {
              "a": unorderedSet(["Alice - Bog monster", "Alice - Dragon", "Alice - Giant turtle", "Alice - Imp"]),
              "b": unorderedSet(["Bob - Bog monster", "Bob - Dwarf", "Bob - Giant turtle", "Bob - Golem"]),
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_06b [xerror: can't find materialized set]", () => {
    assertQueryResult(
      h,
      `
                WITH
                U := (
                    SELECT User {
                        cards := .deck {
                            name,
                            tag := User.name ++ " - " ++ .name,
                        }
                    }),
                A := (SELECT U FILTER .name = 'Alice'),
                B := (SELECT U FILTER .name = 'Bob'),
                Bc := B.cards { tag2 := .tag ++ "!" },
                SELECT { a := A.cards.tag, b := Bc.tag2 };
            `,
      [
            {
              "a": unorderedSet(["Alice - Bog monster", "Alice - Dragon", "Alice - Giant turtle", "Alice - Imp"]),
              "b": unorderedSet(["Bob - Bog monster", "Bob - Dwarf", "Bob - Giant turtle", "Bob - Golem"]),
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_07", () => {
    let baseline = queryRows<string>(h, `
            WITH A := (SELECT User {
                cards := .deck {
                    name,
                    multi tag := User.name ++ " - " ++ .name,
                }
            }),
            FOR x IN A UNION (x.cards.tag);
        `);
    expect((baseline).length).toEqual(22);
    let res = queryRows<string>(h, `
            WITH A := (SELECT User {
                cards := .deck {
                    name,
                    multi tag := User.name ++ " - " ++ .name,
                }
            }),
            SELECT A.cards.tag;
        `);
    expect((res).length).toEqual(9);
    expect(res.every((item) => baseline.includes(item))).toBeTruthy();
  });

  it("test_edgeql_scope_ref_outer_08", () => {
    assertQueryResult(
      h,
      `
            SELECT User { avatar := .avatar {
                tag := User.name ++ ' - ' ++ .name
            } }
            ORDER BY .avatar.tag
            `,
      [
            {
              "avatar": null,
            },
            {
              "avatar": null,
            },
            {
              "avatar": {
                "tag": "Alice - Dragon",
              },
            },
            {
              "avatar": {
                "tag": "Dave - Djinn",
              },
            },
          ]
    );
  });

  it("test_edgeql_scope_ref_outer_09", () => {
    assertQueryResult(
      h,
      `
            SELECT User { avatar := .avatar {
                tag := User.name ++ ' - ' ++ .name
            } }
            FILTER .avatar.tag != 'Dave - Djinn'
            `,
      [
            {
              "avatar": {
                "tag": "Alice - Dragon",
              },
            },
          ]
    );
  });

  it("test_edgeql_scope_tuple_correlate_03", () => {
    assertQueryResult(
      h,
      `
                WITH X := (User, User.friends)
                SELECT count(X.0.friends.name ++ X.1.name);
            `,
      [36]
    );
  });

  it("test_edgeql_scope_tuple_correlate_04", () => {
    assertQueryResult(
      h,
      `
                WITH X := (User { friends }, User.friends)
                SELECT count(X.0.friends.name ++ X.1.name);
            `,
      [36]
    );
  });

  it("test_edgeql_select_outer_rebind_01", () => {
    assertQueryResult(
      h,
      `
            select User {
              deck := (
                with
                  U := (
                    select User.deck {
                      el := User.deck.element
                    }
                  )
                select U {
                  name,
                  el2 := U.el
                } order by .name
              )
            } filter .name = 'Alice';
            `,
      [
            {
              "deck": [
                {
                  "el2": "Water",
                  "name": "Bog monster",
                },
                {
                  "el2": "Fire",
                  "name": "Dragon",
                },
                {
                  "el2": "Water",
                  "name": "Giant turtle",
                },
                {
                  "el2": "Fire",
                  "name": "Imp",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_outer_rebind_02a", () => {
    assertQueryResult(
      h,
      `
            select Card {
              name,
              owners := (
                with
                  U := (
                    select Card.owners {
                      n := Card.owners.name
                    }
                  )
                select U {
                  n
                } order by .name
              )
            } FILTER .name = 'Djinn';
            `,
      [
            {
              "name": "Djinn",
              "owners": [
                {
                  "n": "Carol",
                },
                {
                  "n": "Dave",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_outer_rebind_02b", () => {
    assertQueryResult(
      h,
      `
            select Card {
              name,
              foo := (
                with
                  U := (
                    select Card.<deck[IS User] {
                      n := Card.<deck[IS User].name
                    }
                  )
                select U {
                  n
                } order by .name
              )
            } FILTER .name = 'Djinn';
            `,
      [
            {
              "name": "Djinn",
              "foo": [
                {
                  "n": "Carol",
                },
                {
                  "n": "Dave",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_outer_rebind_03", () => {
    assertQueryResult(
      h,
      `
            select User {
              deck := (
                with
                  U := (
                    select User.deck {
                      cnt := User.deck@count
                    }
                  )
                select U {
                  name,
                  cnt2 := U.cnt
                } order by .name
              )
            } filter .name = 'Alice';
            `,
      [
            {
              "deck": [
                {
                  "cnt2": 3,
                  "name": "Bog monster",
                },
                {
                  "cnt2": 2,
                  "name": "Dragon",
                },
                {
                  "cnt2": 3,
                  "name": "Giant turtle",
                },
                {
                  "cnt2": 2,
                  "name": "Imp",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_select_outer_rebind_04", () => {
    assertQueryResult(
      h,
      `
            select User {
              avatar := (
                with
                  U := (
                    select User.avatar {
                      t := User.avatar@text,
                      retag := User.avatar@tag,
                    }
                  )
                select U {
                  name,
                  t2 := U.t,
                  retag,
                }
              )
            } order by .name
            `,
      [
            {
              "avatar": {
                "name": "Dragon",
                "retag": "Dragon-Best",
                "t2": "Best",
              },
            },
            {
              "avatar": null,
            },
            {
              "avatar": null,
            },
            {
              "avatar": {
                "name": "Djinn",
                "retag": "Djinn-Wow",
                "t2": "Wow",
              },
            },
          ]
    );
  });

  it("test_edgeql_select_outer_rebind_05", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
              name,
              avatar := (
                WITH
                  nemesis := User.avatar,
                  nemesis_mod := (FOR nem IN {nemesis} UNION (
                    WITH
                      name_len := std::len(nem.name)
                    SELECT nem {
                      name_len := name_len
                    }
                  ))
                SELECT nemesis_mod {
                  name,
                  single nameLen := nemesis_mod.name_len,
                  single nameLen2 := nemesis_mod.name_len
                }
              )
            }
            FILTER .name = 'Alice';
            `,
      [
            {
              "avatar": {
                "name": "Dragon",
                "nameLen": 6,
                "nameLen2": 6,
              },
              "name": "Alice",
            },
          ]
    );
  });

  it("test_edgeql_select_outer_rebind_06", () => {
    assertQueryResult(
      h,
      `
            for User in (select User filter .name = 'Alice') union (
              (
                WITH
                  nemesis := User.avatar,
                  nemesis_mod := (FOR nem IN {nemesis} UNION (
                    WITH
                      name_len := std::len(nem.name)
                    SELECT nem {
                      name_len := name_len
                    }
                  ))
                SELECT nemesis_mod {
                  name,
                  single nameLen := nemesis_mod.name_len,
                  single nameLen2 := nemesis_mod.name_len
                }
              )
            );
            `,
      [
            {
              "name": "Dragon",
              "nameLen": 6,
              "nameLen2": 6,
            },
          ]
    );
  });

  it("test_edgeql_select_outer_rebind_07a", () => {
    assertQueryResult(
      h,
      `
                SELECT assert_single((
                  SELECT User {
                  deck := (
                    WITH
                      User_deck := User.deck
                    SELECT User_deck {
                      awards := (
                        User_deck.awards { name }
                      )
                    }
                  )
                }) filter .name ILIKE 'Alice%');
            `,
      unorderedBag([
            {
              "deck": unorderedBag([
                {
                  "awards": [
                    {
                      "name": "2nd",
                    },
                  ],
                },
                {
                  "awards": unorderedBag([
                    {
                      "name": "1st",
                    },
                    {
                      "name": "3rd",
                    },
                  ]),
                },
                {
                  "awards": [],
                },
                {
                  "awards": [],
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_select_outer_rebind_07b", () => {
    assertQueryResult(
      h,
      `
                SELECT assert_exists((
                  SELECT User {
                  deck := (
                    WITH
                      User_deck := User.deck
                    SELECT User_deck {
                      awards := (
                        User_deck.awards { name }
                      )
                    }
                  )
                }) filter .name ILIKE 'Alice%');
            `,
      unorderedBag([
            {
              "deck": unorderedBag([
                {
                  "awards": [
                    {
                      "name": "2nd",
                    },
                  ],
                },
                {
                  "awards": unorderedBag([
                    {
                      "name": "1st",
                    },
                    {
                      "name": "3rd",
                    },
                  ]),
                },
                {
                  "awards": [],
                },
                {
                  "awards": [],
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_scope_linkprop_rebinding_01", () => {
    assertQueryResult(
      h,
      `
            select assert_exists((WITH
              __user := DETACHED User
            SELECT __user {
              deck := (
                WITH
                  __user2 := (
                    SELECT __user.deck {
                      __linkprop_count := __user.deck@count
                    }
                  )
                SELECT __user2 {
                  single @count := __user2.__linkprop_count
                }
              )
            } filter .name = 'Alice'));
            `,
      [
            {
              "deck": unorderedBag([
                {
                  "@count": 2,
                },
                {
                  "@count": 2,
                },
                {
                  "@count": 3,
                },
                {
                  "@count": 3,
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_scope_for_with_computable_01", () => {
    assertQueryResult(
      h,
      `
            with props := (
              for h in User union (
                select h {namelen := len(h.name)}
              )
            )
            select props {
              name,
              namelen
            };
            `,
      unorderedBag([
            {
              "name": "Alice",
              "namelen": 5,
            },
            {
              "name": "Bob",
              "namelen": 3,
            },
            {
              "name": "Carol",
              "namelen": 5,
            },
            {
              "name": "Dave",
              "namelen": 4,
            },
          ])
    );
  });

  it("test_edgeql_scope_for_with_computable_02", () => {
    assertQueryResult(
      h,
      `
            with props := (
              for h in User union (
                with g := h, select g {namelen := len(g.name)}
              )
            )
            select props {
              name,
              namelen
            };
            `,
      unorderedBag([
            {
              "name": "Alice",
              "namelen": 5,
            },
            {
              "name": "Bob",
              "namelen": 3,
            },
            {
              "name": "Carol",
              "namelen": 5,
            },
            {
              "name": "Dave",
              "namelen": 4,
            },
          ])
    );
  });

  it("test_edgeql_shape_intersection_semijoin_01", () => {
    assertQueryResult(
      h,
      `
                select User { name } filter [is Bot].deck.name = 'Dragon'
            `,
      [
            {
              "name": "Dave",
            },
          ]
    );
  });

  it("test_edgeql_computable_join_01", () => {
    assertQueryResult(
      h,
      `
            select Card {
                multi w := (
                    select .awards { name }
                    filter .name = Card.best_award.name
                )
            }
            filter .name = 'Dragon';
            `,
      [
            {
              "w": [
                {
                  "name": "1st",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_intersection_semijoin_01", () => {
    assertQueryResult(
      h,
      `
                select count(Named[IS User].deck);
            `,
      [9]
    );
  });

  it("test_edgeql_scope_union_backlink_01", () => {
    assertQueryResult(
      h,
      `
                select {Card {name}, Card{element}} {name, owners: {name}}
                filter .name = 'Djinn';
            `,
      [
            {
              "name": "Djinn",
              "owners": unorderedBag([
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ]),
            },
            {
              "name": "Djinn",
              "owners": unorderedBag([
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_scope_schema_computed_01", () => {
    h.script(
      `
            alter type User
            create link lcards := (
                select Card filter Card.name[0] = User.name[0]);
        `
    );
    assertQueryResult(
      h,
      `
                with U := User,
                select U { name } filter exists .lcards;
            `,
      unorderedBag([
            {
              "name": "Bob",
            },
            {
              "name": "Dave",
            },
          ])
    );
    assertQueryResult(
      h,
      `
                select Bot { lcards: {name} }
            `,
      [
            {
              "lcards": unorderedBag([
                {
                  "name": "Dragon",
                },
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Djinn",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_scope_schema_computed_02", () => {
    h.script(
      `
            alter type Named
            create property foo := count(User)
        `
    );
    assertQueryResult(
      h,
      `
                select User { foo }
            `,
      [
            {
              "foo": 4,
            },
            {
              "foo": 4,
            },
            {
              "foo": 4,
            },
            {
              "foo": 4,
            },
          ]
    );
  });

  it("test_edgeql_scope_linkprop_assert_01", () => {
    assertQueryResult(
      h,
      `
            select User {
              cards := assert_exists(User.deck {name, c := User.deck@count})
            }
            filter .name = 'Alice';
            `,
      [
            {
              "cards": unorderedBag([
                {
                  "c": 2,
                  "name": "Imp",
                },
                {
                  "c": 2,
                  "name": "Dragon",
                },
                {
                  "c": 3,
                  "name": "Bog monster",
                },
                {
                  "c": 3,
                  "name": "Giant turtle",
                },
              ]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select User {
              cards := assert_exists(User.deck {name, @c := User.deck@count})
            }
            filter .name = 'Alice';
            `,
      [
            {
              "cards": unorderedBag([
                {
                  "@c": 2,
                  "name": "Imp",
                },
                {
                  "@c": 2,
                  "name": "Dragon",
                },
                {
                  "@c": 3,
                  "name": "Bog monster",
                },
                {
                  "@c": 3,
                  "name": "Giant turtle",
                },
              ]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH U := DETACHED User
            SELECT U {
              deck := assert_exists((
                WITH
                  Q := (
                    SELECT U.deck {
                      __count := U.deck@count
                    }
                  )
                SELECT Q {
                  name,
                  single @count := Q.__count
                }
              ))
            } filter .name = 'Alice';
            `,
      [
            {
              "deck": unorderedBag([
                {
                  "@count": 2,
                  "name": "Imp",
                },
                {
                  "@count": 2,
                  "name": "Dragon",
                },
                {
                  "@count": 3,
                  "name": "Bog monster",
                },
                {
                  "@count": 3,
                  "name": "Giant turtle",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_scope_linkprop_assert_02", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
                cards := assert_exists(.deck {name, @count})
            }
            filter .name = 'Alice';
            `,
      [
            {
              "cards": unorderedBag([
                {
                  "@count": 2,
                  "name": "Imp",
                },
                {
                  "@count": 2,
                  "name": "Dragon",
                },
                {
                  "@count": 3,
                  "name": "Bog monster",
                },
                {
                  "@count": 3,
                  "name": "Giant turtle",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_scope_linkprop_assert_03", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
                cards := assert_exists(User.deck {name, c := @count})
            }
            filter .name = 'Alice';
            `,
      [
            {
              "cards": unorderedBag([
                {
                  "c": 2,
                  "name": "Imp",
                },
                {
                  "c": 2,
                  "name": "Dragon",
                },
                {
                  "c": 3,
                  "name": "Bog monster",
                },
                {
                  "c": 3,
                  "name": "Giant turtle",
                },
              ]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT User {
                cards := assert_exists(.deck {name, c := @count})
            }
            filter .name = 'Alice';
            `,
      [
            {
              "cards": unorderedBag([
                {
                  "c": 2,
                  "name": "Imp",
                },
                {
                  "c": 2,
                  "name": "Dragon",
                },
                {
                  "c": 3,
                  "name": "Bog monster",
                },
                {
                  "c": 3,
                  "name": "Giant turtle",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_scope_filter_qeq_01", () => {
    assertQueryResult(
      h,
      `
            select User filter .avatar ?= <Card>{} and .name = 'Bob';
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select User filter .name = 'Bob' and .avatar ?= <Card>{}
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_scope_mat_issue_6059 [xerror: Issue #6059 (non-group generalization)]", () => {
    assertQueryResult(
      h,
      `
            with
              groups := (
                for k in {'Earth', 'Air', 'Fire', 'Water'} union {
                    elements := (select Card filter .element = k),
                    r := random(),
                }
              ),
            select groups {
              keyCard := (
                select .elements { id }
                limit 1
              ),
            }
            order by .keyCard.cost
            `,
      [
            {
              "keyCard": {},
            },
            {
              "keyCard": {},
            },
            {
              "keyCard": {},
            },
            {
              "keyCard": {},
            },
          ]
    );
  });

  it("test_edgeql_scope_mat_issue_6060 [xerror: Issue #6060 (non-group generalization)]", () => {
    assertQueryResult(
      h,
      `
            with
              groups := (
                for k in {'Earth', 'Air', 'Fire', 'Water'} union {
                    elements := (select Card filter .element = k),
                    r := random(),
                }
              ),
              submissions := (
                groups {
                  minCost := min(.elements.cost)
                }
              )
            select submissions {
              minCost
            }
            order by .minCost;
            `,
      [
            {
              "minCost": 1,
            },
            {
              "minCost": 1,
            },
            {
              "minCost": 1,
            },
            {
              "minCost": 2,
            },
          ]
    );
  });

  it("test_edgeql_scope_implicit_limit_01", () => {
    assertQueryResult(
      h,
      `
                select Card { name } order by .name offset 3
            `,
      [
            {
              "name": "Dwarf",
            },
            {
              "name": "Giant eagle",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Golem",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            with W := Card
            select W { name } order by .name offset 3;
            `,
      [
            {
              "name": "Dwarf",
            },
            {
              "name": "Giant eagle",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Golem",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                select Card { name } order by .name offset 3 limit 2
            `,
      [
            {
              "name": "Dwarf",
            },
            {
              "name": "Giant eagle",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select User { deck: {name} order by .name offset 3 }
            filter .name = 'Carol';
            `,
      [
            {
              "deck": [
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Giant turtle",
                },
                {
                  "name": "Golem",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_scope_implicit_limit_02", () => {
    assertQueryResult(
      h,
      `
            select User { deck: {name} order by .name offset 3 limit 100}
            filter .name = 'Carol';
            `,
      [
            {
              "deck": [
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Giant turtle",
                },
                {
                  "name": "Golem",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select User { cards := (
                select .deck {name} order by .name offset 3 limit 100)}
            filter .name = 'Carol';
            `,
      [
            {
              "cards": [
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Giant turtle",
                },
                {
                  "name": "Golem",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                select Card { name } order by .name offset 3 limit 100
            `,
      [
            {
              "name": "Dwarf",
            },
            {
              "name": "Giant eagle",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Golem",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                select Card { name } order by .name offset 3 limit 1
            `,
      [
            {
              "name": "Dwarf",
            },
          ]
    );
  });
});
