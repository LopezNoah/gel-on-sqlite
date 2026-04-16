import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLLinkproperties", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "cards",
      setup: "cards_setup",
      dbFile: "./tests/.artifacts/linkprops.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_props_basic_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    deck: {
                        name,
                        element,
                        cost,
                        @count
                    } ORDER BY @count DESC THEN .name ASC
                } ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "deck": [
                {
                  "cost": 2,
                  "name": "Bog monster",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 3,
                  "name": "Giant turtle",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 5,
                  "name": "Dragon",
                  "@count": 2,
                  "element": "Fire",
                },
                {
                  "cost": 1,
                  "name": "Imp",
                  "@count": 2,
                  "element": "Fire",
                },
              ],
            },
            {
              "name": "Bob",
              "deck": [
                {
                  "cost": 2,
                  "name": "Bog monster",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 1,
                  "name": "Dwarf",
                  "@count": 3,
                  "element": "Earth",
                },
                {
                  "cost": 3,
                  "name": "Giant turtle",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 3,
                  "name": "Golem",
                  "@count": 3,
                  "element": "Earth",
                },
              ],
            },
            {
              "name": "Carol",
              "deck": [
                {
                  "cost": 1,
                  "name": "Dwarf",
                  "@count": 4,
                  "element": "Earth",
                },
                {
                  "cost": 1,
                  "name": "Sprite",
                  "@count": 4,
                  "element": "Air",
                },
                {
                  "cost": 2,
                  "name": "Bog monster",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 2,
                  "name": "Giant eagle",
                  "@count": 3,
                  "element": "Air",
                },
                {
                  "cost": 3,
                  "name": "Giant turtle",
                  "@count": 2,
                  "element": "Water",
                },
                {
                  "cost": 3,
                  "name": "Golem",
                  "@count": 2,
                  "element": "Earth",
                },
                {
                  "cost": 4,
                  "name": "Djinn",
                  "@count": 1,
                  "element": "Air",
                },
              ],
            },
            {
              "name": "Dave",
              "deck": [
                {
                  "cost": 1,
                  "name": "Sprite",
                  "@count": 4,
                  "element": "Air",
                },
                {
                  "cost": 2,
                  "name": "Bog monster",
                  "@count": 1,
                  "element": "Water",
                },
                {
                  "cost": 4,
                  "name": "Djinn",
                  "@count": 1,
                  "element": "Air",
                },
                {
                  "cost": 5,
                  "name": "Dragon",
                  "@count": 1,
                  "element": "Fire",
                },
                {
                  "cost": 2,
                  "name": "Giant eagle",
                  "@count": 1,
                  "element": "Air",
                },
                {
                  "cost": 3,
                  "name": "Giant turtle",
                  "@count": 1,
                  "element": "Water",
                },
                {
                  "cost": 3,
                  "name": "Golem",
                  "@count": 1,
                  "element": "Earth",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_props_basic_02", () => {
    assertQueryResult(
      h,
      `
                # get users and only cards that have the same count and
                # cost in the decks
                SELECT User {
                    name,
                    deck: {
                        name,
                        element,
                        cost,
                        @count
                    } FILTER .cost = @count
                      ORDER BY @count DESC THEN .name ASC
                } ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "deck": [
                {
                  "cost": 3,
                  "name": "Giant turtle",
                  "@count": 3,
                  "element": "Water",
                },
              ],
            },
            {
              "name": "Bob",
              "deck": [
                {
                  "cost": 3,
                  "name": "Giant turtle",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 3,
                  "name": "Golem",
                  "@count": 3,
                  "element": "Earth",
                },
              ],
            },
            {
              "name": "Carol",
              "deck": [],
            },
            {
              "name": "Dave",
              "deck": [],
            },
          ]
    );
  });

  it("test_edgeql_props_basic_03", () => {
    assertQueryResult(
      h,
      `
                # get only users who have the same count and cost in the decks
                SELECT User {
                    name,
                    deck: {
                        name,
                        element,
                        cost,
                        @count
                    } ORDER BY @count DESC THEN .name ASC
                } FILTER any((for d in .deck select d.cost = d@count))
                  ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "deck": [
                {
                  "cost": 2,
                  "name": "Bog monster",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 3,
                  "name": "Giant turtle",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 5,
                  "name": "Dragon",
                  "@count": 2,
                  "element": "Fire",
                },
                {
                  "cost": 1,
                  "name": "Imp",
                  "@count": 2,
                  "element": "Fire",
                },
              ],
            },
            {
              "name": "Bob",
              "deck": [
                {
                  "cost": 2,
                  "name": "Bog monster",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 1,
                  "name": "Dwarf",
                  "@count": 3,
                  "element": "Earth",
                },
                {
                  "cost": 3,
                  "name": "Giant turtle",
                  "@count": 3,
                  "element": "Water",
                },
                {
                  "cost": 3,
                  "name": "Golem",
                  "@count": 3,
                  "element": "Earth",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_props_basic_04", () => {
    assertQueryResult(
      h,
      `
                # get all cards that match their cost to the count in at
                # least some deck
                SELECT Card {
                    name,
                    element,
                    cost
                }
                FILTER
                    .cost IN .<deck[IS User]@count
                ORDER BY .name;
            `,
      [
            {
              "cost": 3,
              "name": "Giant turtle",
              "element": "Water",
            },
            {
              "cost": 3,
              "name": "Golem",
              "element": "Earth",
            },
          ]
    );
  });

  it("test_edgeql_props_basic_05", () => {
    assertQueryResult(
      h,
      `
                # get all the friends of Alice and their nicknames
                SELECT User {
                    name,
                    friends: {
                        name,
                        @nickname,
                    } ORDER BY .name,
                }
                FILTER .name = 'Alice';
            `,
      [
            {
              "name": "Alice",
              "friends": [
                {
                  "name": "Bob",
                  "@nickname": "Swampy",
                },
                {
                  "name": "Carol",
                  "@nickname": "Firefighter",
                },
                {
                  "name": "Dave",
                  "@nickname": "Grumpy",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_props_basic_06", () => {
    assertQueryResult(
      h,
      `
                SELECT User.avatar@text;
            `,
      unorderedSet(["Best", "Wow"])
    );
  });

  it("test_edgeql_props_basic_07", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    avatar: {
                        @text
                    }
                } FILTER EXISTS .avatar@text
                ORDER BY .name;
            `,
      [
            {
              "avatar": {
                "@text": "Best",
              },
            },
            {
              "avatar": {
                "@text": "Wow",
              },
            },
          ]
    );
  });

  it("test_edgeql_props_cross_01", () => {
    assertQueryResult(
      h,
      `
                # get cards that have the same count in some deck as their cost
                SELECT Card {
                    name,
                }
                FILTER .cost = .<deck[IS User]@count
                ORDER BY .name;
            `,
      [
            {
              "name": "Giant turtle",
            },
            {
              "name": "Golem",
            },
          ]
    );
  });

  it("test_edgeql_props_cross_02", () => {
    assertQueryResult(
      h,
      `
                # get cards that have the same count in some deck as their cost
                SELECT Card {
                    name,
                    same := EXISTS (
                        SELECT User
                        FILTER any ((
                            FOR User IN User FOR deck IN User.deck SELECT
                            Card.cost = deck@count AND
                            Card = deck
                        ))
                    )
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "Bog monster",
              "same": false,
            },
            {
              "name": "Djinn",
              "same": false,
            },
            {
              "name": "Dragon",
              "same": false,
            },
            {
              "name": "Dwarf",
              "same": false,
            },
            {
              "name": "Giant eagle",
              "same": false,
            },
            {
              "name": "Giant turtle",
              "same": true,
            },
            {
              "name": "Golem",
              "same": true,
            },
            {
              "name": "Imp",
              "same": false,
            },
            {
              "name": "Sprite",
              "same": false,
            },
          ]
    );
  });

  it("test_edgeql_props_cross_04", () => {
    assertQueryResult(
      h,
      `
                # get cards that have the same count in some deck as their cost
                SELECT Card {
                    name,
                    same := (
                        SELECT _ := Card.cost = Card.<deck[IS User]@count
                        ORDER BY _ DESC LIMIT 1
                    )
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "Bog monster",
              "same": false,
            },
            {
              "name": "Djinn",
              "same": false,
            },
            {
              "name": "Dragon",
              "same": false,
            },
            {
              "name": "Dwarf",
              "same": false,
            },
            {
              "name": "Giant eagle",
              "same": false,
            },
            {
              "name": "Giant turtle",
              "same": true,
            },
            {
              "name": "Golem",
              "same": true,
            },
            {
              "name": "Imp",
              "same": false,
            },
            {
              "name": "Sprite",
              "same": false,
            },
          ]
    );
  });

  it("test_edgeql_props_implication_01", () => {
    assertQueryResult(
      h,
      `
                # count of 1 in at least some deck implies 'Fire'
                SELECT Card {
                    name,
                    element,
                    count := (
                        SELECT _ := Card.<deck[IS User]@count ORDER BY _
                    ),
                    expr := (
                        SELECT
                            _ := NOT EXISTS (
                                SELECT Card
                                FILTER Card.<deck[IS User]@count = 1
                            ) OR Card.element = 'Fire'
                        ORDER BY _ DESC LIMIT 1
                    )
                }
                ORDER BY .name;
            `,
      [
            {
              "expr": false,
              "name": "Bog monster",
              "count": [1, 3, 3, 3],
              "element": "Water",
            },
            {
              "expr": false,
              "name": "Djinn",
              "count": [1, 1],
              "element": "Air",
            },
            {
              "expr": true,
              "name": "Dragon",
              "count": [1, 2],
              "element": "Fire",
            },
            {
              "expr": true,
              "name": "Dwarf",
              "count": [3, 4],
              "element": "Earth",
            },
            {
              "expr": false,
              "name": "Giant eagle",
              "count": [1, 3],
              "element": "Air",
            },
            {
              "expr": false,
              "name": "Giant turtle",
              "count": [1, 2, 3, 3],
              "element": "Water",
            },
            {
              "expr": false,
              "name": "Golem",
              "count": [1, 2, 3],
              "element": "Earth",
            },
            {
              "expr": true,
              "name": "Imp",
              "count": [2],
              "element": "Fire",
            },
            {
              "expr": true,
              "name": "Sprite",
              "count": [4, 4],
              "element": "Air",
            },
          ]
    );
  });

  it("test_edgeql_props_implication_02", () => {
    assertQueryResult(
      h,
      `
                # FILTER by NOT (count of 1 implies 'Fire')
                # in at least some deck
                SELECT Card {
                    name,
                }
                FILTER NOT (NOT .<deck[IS User]@count = 1 OR .element = 'Fire')
                ORDER BY .name;
            `,
      [
            {
              "name": "Bog monster",
            },
            {
              "name": "Djinn",
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
  });

  it("test_edgeql_props_implication_03", () => {
    assertQueryResult(
      h,
      `
                # same as above, refactored
                SELECT Card {
                    name,
                }
                FILTER .<deck[IS User]@count = 1 AND .element != 'Fire'
                ORDER BY .name;
            `,
      [
            {
              "name": "Bog monster",
            },
            {
              "name": "Djinn",
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
  });

  it("test_edgeql_props_implication_04", () => {
    assertQueryResult(
      h,
      `
                # count of 1 implies 'Fire' in the deck of Dave
                SELECT User {
                    name,
                    deck: {
                        name,
                        element,
                        @count,
                        expr :=
                            NOT User.deck@count = 1 OR
                                User.deck.element = 'Fire'
                    }
                }
                FILTER .name = 'Dave';
            `,
      [
            {
              "name": "Dave",
              "deck": [
                {
                  "name": "Dragon",
                  "expr": true,
                  "@count": 1,
                  "element": "Fire",
                },
                {
                  "name": "Bog monster",
                  "expr": false,
                  "@count": 1,
                  "element": "Water",
                },
                {
                  "name": "Giant turtle",
                  "expr": false,
                  "@count": 1,
                  "element": "Water",
                },
                {
                  "name": "Golem",
                  "expr": false,
                  "@count": 1,
                  "element": "Earth",
                },
                {
                  "name": "Sprite",
                  "expr": true,
                  "@count": 4,
                  "element": "Air",
                },
                {
                  "name": "Giant eagle",
                  "expr": false,
                  "@count": 1,
                  "element": "Air",
                },
                {
                  "name": "Djinn",
                  "expr": false,
                  "@count": 1,
                  "element": "Air",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_props_setops_01", () => {
    assertQueryResult(
      h,
      `
                SELECT DISTINCT User.deck@count;
            `,
      unorderedSet([1, 2, 3, 4])
    );
    assertQueryResult(
      h,
      `
                SELECT User.deck@count FILTER User.deck.element = 'Fire'
            `,
      unorderedBag([1, 2, 2])
    );
    assertQueryResult(
      h,
      `
                SELECT DISTINCT (
                    SELECT User.deck@count FILTER User.deck.element = 'Fire'
                );
            `,
      unorderedSet([1, 2])
    );
    assertQueryResult(
      h,
      `
                SELECT DISTINCT (
                    SELECT User.deck@count FILTER User.deck.element = 'Water'
                );
            `,
      unorderedSet([1, 2, 3])
    );
    assertQueryResult(
      h,
      `
                SELECT DISTINCT (
                    SELECT (
                        SELECT Card FILTER Card.element = 'Water'
                    ).<deck[IS User]@count
            );
            `,
      unorderedSet([1, 2, 3])
    );
  });

  it("test_edgeql_props_setops_02", () => {
    assertQueryResult(
      h,
      `
                WITH
                    C := (
                        SELECT User FILTER User.name = 'Carol').deck.name,
                    D := (
                        SELECT User FILTER User.name = 'Dave').deck.name
                SELECT _ := C UNION D
                ORDER BY _;
            `,
      [
            "Bog monster",
            "Bog monster",
            "Djinn",
            "Djinn",
            "Dragon",
            "Dwarf",
            "Giant eagle",
            "Giant eagle",
            "Giant turtle",
            "Giant turtle",
            "Golem",
            "Golem",
            "Sprite",
            "Sprite",
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (
                        SELECT User FILTER User.name = 'Carol').deck.name,
                    D := (
                        SELECT User FILTER User.name = 'Dave').deck.name
                SELECT _ := DISTINCT (C UNION D)
                ORDER BY _;
            `,
      [
            "Bog monster",
            "Djinn",
            "Dragon",
            "Dwarf",
            "Giant eagle",
            "Giant turtle",
            "Golem",
            "Sprite",
          ]
    );
  });

  it("test_edgeql_props_setops_03", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := {
                    # this is equivalent to UNION
                    User.name,
                    User.friends@nickname,
                    {'Foo', 'Bob'}
                }
                ORDER BY _;
            `,
      [
            "Alice",
            "Bob",
            "Bob",
            "Carol",
            "Dave",
            "Firefighter",
            "Foo",
            "Grumpy",
            "Swampy",
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT _ := DISTINCT {
                    User.name,
                    User.friends@nickname,
                    {'Foo', 'Bob'}
                }
                ORDER BY _;
            `,
      [
            "Alice",
            "Bob",
            "Carol",
            "Dave",
            "Firefighter",
            "Foo",
            "Grumpy",
            "Swampy",
          ]
    );
  });

  it("test_edgeql_props_setops_04", () => {
    assertQueryResult(
      h,
      `
                WITH
                    A := (SELECT User FILTER User.name = 'Alice')
                    # the set of distinct values of card counts in
                    # the deck of Alice is {2, 3}
                SELECT _ := (DISTINCT A.deck@count, A.name)
                ORDER BY _;
            `,
      [
            [2, "Alice"],
            [3, "Alice"],
          ]
    );
  });

  it("test_edgeql_props_setops_05", () => {
    assertQueryResult(
      h,
      `
                SELECT DISTINCT
                        (
                            SELECT User FILTER User.name = 'Alice'
                        ).deck@count;
            `,
      unorderedSet([2, 3])
    );
  });

  it("test_edgeql_props_computable_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    my_deck := (SELECT Card { @foo := Card.name }
                                FILTER .name = 'Djinn')
                }
                FILTER User.name = 'Alice';
            `,
      [
            {
              "name": "Alice",
              "my_deck": {
                "@foo": "Djinn",
              },
            },
          ]
    );
  });

  it("test_edgeql_props_computable_02", () => {
    assertQueryResult(
      h,
      `
                WITH
                    MyUser := (
                        SELECT
                            User {
                                my_deck := (SELECT Card { @foo := Card.name }
                                            FILTER .name = 'Djinn')
                            }
                        FILTER User.name = 'Alice'
                    )
                SELECT MyUser {
                    name,
                    my_deck: {
                        @foo
                    }
                };
            `,
      [
            {
              "name": "Alice",
              "my_deck": {
                "@foo": "Djinn",
              },
            },
          ]
    );
  });

  it("test_edgeql_props_abbrev", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    my_deck := (SELECT .deck {
                        name,
                        num_cards := @count
                    } ORDER BY .name)
                } FILTER .name = 'Alice';
            `,
      [
            {
              "name": "Alice",
              "my_deck": [
                {
                  "name": "Bog monster",
                  "num_cards": 3,
                },
                {
                  "name": "Dragon",
                  "num_cards": 2,
                },
                {
                  "name": "Giant turtle",
                  "num_cards": 3,
                },
                {
                  "name": "Imp",
                  "num_cards": 2,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_props_agg_01", () => {
    assertQueryResult(
      h,
      `
                SELECT sum(User.deck@count);
            `,
      [51]
    );
    assertQueryResult(
      h,
      `
                SELECT _ := (
                    FOR User in User
                    SELECT (sum(User.deck@count), User.name)
                )
                ORDER BY _;
            `,
      [
            [10, "Alice"],
            [10, "Dave"],
            [12, "Bob"],
            [19, "Carol"],
          ]
    );
  });

  it("test_edgeql_props_link_shadow_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    deck := (SELECT x := User.deck
                             ORDER BY x.name ASC
                             LIMIT 2) {
                                 name
                             }
                } ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "deck": [
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Dragon",
                },
              ],
            },
            {
              "name": "Bob",
              "deck": [
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Dwarf",
                },
              ],
            },
            {
              "name": "Carol",
              "deck": [
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Djinn",
                },
              ],
            },
            {
              "name": "Dave",
              "deck": [
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Djinn",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_props_link_shadow_02", () => {
    assertQueryResult(
      h,
      `
                WITH
                    AliasedUser := User {
                        name,
                        deck := (SELECT User.deck ORDER BY .name LIMIT 2)
                    }
                SELECT
                    AliasedUser {
                        name,
                        deck: {
                            @count
                        }
                    }
                ORDER BY .name;
            `,
      [
            {
              "deck": [
                {
                  "@count": 3,
                },
                {
                  "@count": 2,
                },
              ],
              "name": "Alice",
            },
            {
              "deck": [
                {
                  "@count": 3,
                },
                {
                  "@count": 3,
                },
              ],
              "name": "Bob",
            },
            {
              "deck": [
                {
                  "@count": 3,
                },
                {
                  "@count": 1,
                },
              ],
              "name": "Carol",
            },
            {
              "deck": [
                {
                  "@count": 1,
                },
                {
                  "@count": 1,
                },
              ],
              "name": "Dave",
            },
          ]
    );
  });

  it("test_edgeql_props_link_computed_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    deck: {name, @total_cost} ORDER BY .name
                } FILTER .name = 'Alice';
            `,
      [
            {
              "name": "Alice",
              "deck": [
                {
                  "@total_cost": 6,
                  "name": "Bog monster",
                },
                {
                  "@total_cost": 10,
                  "name": "Dragon",
                },
                {
                  "@total_cost": 9,
                  "name": "Giant turtle",
                },
                {
                  "@total_cost": 2,
                  "name": "Imp",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_props_link_computed_02", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    avatar: { @tag },
                }
                FILTER .name IN {'Alice', 'Bob'} ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "avatar": {
                "@tag": "Dragon-Best",
              },
            },
            {
              "name": "Bob",
              "avatar": null,
            },
          ]
    );
  });

  it("test_edgeql_props_link_union_01", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Tgt2 EXTENDING Tgt;
            CREATE TYPE Bar {
                CREATE LINK l -> Tgt {
                    CREATE PROPERTY x -> str;
                };
            };
            CREATE TYPE Foo {
                CREATE LINK l -> Tgt {
                    CREATE PROPERTY x -> str;
                };
            };
            CREATE TYPE Baz {
                CREATE LINK fubar -> (Bar | Foo);
            };

            INSERT Baz {
                fubar := (INSERT Bar {
                    l := (INSERT Tgt2 { @x := "test" })
                })
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Baz.fubar.l@x;
            `,
      ["test"]
    );
    assertQueryResult(
      h,
      `
                SELECT Baz.fubar.l[IS Tgt2]@x;
            `,
      ["test"]
    );
    assertQueryResult(
      h,
      `
                SELECT (Foo UNION Bar).l@x;
            `,
      ["test"]
    );
  });

  it("test_edgeql_props_link_union_02", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Tgt2 EXTENDING Tgt;
            CREATE TYPE Bar {
                CREATE MULTI LINK l -> Tgt {
                    CREATE PROPERTY x -> str;
                };
            };
            CREATE TYPE Foo {
                CREATE MULTI LINK l -> Tgt {
                    CREATE PROPERTY x -> str;
                };
            };
            CREATE TYPE Baz {
                CREATE LINK fubar -> (Bar | Foo);
            };

            INSERT Baz {
                fubar := (INSERT Bar {
                    l := (INSERT Tgt2 { @x := "test" })
                })
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Baz.fubar.l@x;
            `,
      ["test"]
    );
    assertQueryResult(
      h,
      `
                SELECT Baz.fubar.l[IS Tgt2]@x;
            `,
      ["test"]
    );
    assertQueryResult(
      h,
      `
                SELECT (Foo UNION Bar).l@x;
            `,
      ["test"]
    );
  });

  it("test_edgeql_props_link_union_03", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Tgt2 EXTENDING Tgt;
            CREATE TYPE Bar {
                CREATE LINK l -> Tgt {
                    CREATE PROPERTY x -> str;
                };
            };
            CREATE TYPE Foo {
                CREATE MULTI LINK l -> Tgt {
                    CREATE PROPERTY x -> str;
                };
            };
            CREATE TYPE Baz {
                CREATE LINK fubar -> (Bar | Foo);
            };

            INSERT Baz {
                fubar := (INSERT Bar {
                    l := (INSERT Tgt2 { @x := "test" })
                })
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Baz.fubar.l@x;
            `,
      ["test"]
    );
    assertQueryResult(
      h,
      `
                SELECT Baz.fubar.l[IS Tgt2]@x;
            `,
      ["test"]
    );
    assertQueryResult(
      h,
      `
                SELECT (Foo UNION Bar).l@x;
            `,
      ["test"]
    );
  });

  it("test_edgeql_props_back_01", () => {
    assertQueryResult(
      h,
      `
            with X1 := (Card { z := (
                       for d in .<deck[IS User] union
                       (d, d@count))}),
                 X2 := X1 { owners2 := assert_distinct(
                     .z.0 { count := X1.z.1 }) },
            select X2 { name, owners2: {name, count} order BY .name }
            filter .name = 'Dwarf';
            `,
      [
            {
              "name": "Dwarf",
              "owners2": [
                {
                  "count": 3,
                  "name": "Bob",
                },
                {
                  "count": 4,
                  "name": "Carol",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_props_back_02", () => {
    assertQueryResult(
      h,
      `
            select Card { name, z := .<deck[IS User] { name, @count }}
            filter .name = 'Dragon';
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "@count": 2,
                  "name": "Alice",
                },
                {
                  "@count": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_back_03", () => {
    assertQueryResult(
      h,
      `
            select Card { name, z := .<deck[IS User] { name, x := @count }}
            filter .name = 'Dragon';
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "x": 2,
                  "name": "Alice",
                },
                {
                  "x": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_back_04", () => {
    assertQueryResult(
      h,
      `
            select assert_exists((
                select Card { name, z := .<deck[IS User] { name, @count }}
                filter .name = 'Dragon'
            ));
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "@count": 2,
                  "name": "Alice",
                },
                {
                  "@count": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_back_05", () => {
    assertQueryResult(
      h,
      `
            select assert_exists((
                select Card { name, z := .<deck[IS User] { name, x := @count }}
                filter .name = 'Dragon'
            ));
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "x": 2,
                  "name": "Alice",
                },
                {
                  "x": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_back_06", () => {
    expect(() => {
      h.query(
        `
                    select Card { name, z := .<deck { @count }}
                    filter .name = 'Dragon'
                `
      );
    }).toThrow(new RegExp("has no property 'count'"));
  });

  it.skip("test_edgeql_props_back_07 [xfail: We are too permissive with intersections on supertypes]", () => {
    expect(() => {
      h.query(
        `
                    select Card { name, z := .<deck[IS Object] { @count }}
                    filter .name = 'Dragon'
                `
      );
    }).toThrow(new RegExp("has no property 'count'"));
  });

  it("test_edgeql_props_back_08", () => {
    assertQueryResult(
      h,
      `
            select Card { name, z := .<deck[IS Bot] { name, x := @count }}
            filter .name = 'Dragon';
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "x": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it.skip("test_edgeql_props_back_09 [xerror: Stack overflow!]", () => {
    assertQueryResult(
      h,
      `
            select assert_exists((
                select Card { name, z := .<deck[IS User] {
                  name, @count := @count }}
                filter .name = 'Dragon'
            ));
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "x": 2,
                  "name": "Alice",
                },
                {
                  "x": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_schema_back_00", () => {
    expect(() => {
      h.query(
        `
                    select (Card.name, Card.owners@total_cost)
                `
      );
    }).toThrow(new RegExp("has no property 'total_cost'"));
  });

  it("test_edgeql_props_schema_back_01", () => {
    assertQueryResult(
      h,
      `
                select (
                    for Card in Card
                    for owner in Card.owners
                    select (Card.name, owner.name, owner@count)
                    filter Card.name = 'Dragon'
                )
                order by .1
            `,
      [
            ["Dragon", "Alice", 2],
            ["Dragon", "Dave", 1],
          ]
    );
  });

  it("test_edgeql_props_schema_back_02", () => {
    assertQueryResult(
      h,
      `
            select Card { name, z := .owners { name, @count }}
            filter .name = 'Dragon';
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "@count": 2,
                  "name": "Alice",
                },
                {
                  "@count": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select Card { name, owners: { name, @count }}
            filter .name = 'Dragon';
            `,
      [
            {
              "name": "Dragon",
              "owners": unorderedBag([
                {
                  "@count": 2,
                  "name": "Alice",
                },
                {
                  "@count": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select SpecialCard { name, owners: { name, @count }}
            filter .name = 'Djinn';
            `,
      [
            {
              "name": "Djinn",
              "owners": unorderedBag([
                {
                  "@count": 1,
                  "name": "Carol",
                },
                {
                  "@count": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_schema_back_03", () => {
    assertQueryResult(
      h,
      `
            select Card { name, z := .owners { name, x := @count }}
            filter .name = 'Dragon';
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "x": 2,
                  "name": "Alice",
                },
                {
                  "x": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select Card { name, owners: { name, x := @count }}
            filter .name = 'Dragon';
            `,
      [
            {
              "name": "Dragon",
              "owners": unorderedBag([
                {
                  "x": 2,
                  "name": "Alice",
                },
                {
                  "x": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_schema_back_04", () => {
    assertQueryResult(
      h,
      `
            select assert_exists((
                select Card { name, z := .owners { name, @count }}
                filter .name = 'Dragon'
            ));
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "@count": 2,
                  "name": "Alice",
                },
                {
                  "@count": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select assert_exists((
                select Card { name, owners: { name, @count }}
                filter .name = 'Dragon'
            ));
            `,
      [
            {
              "name": "Dragon",
              "owners": unorderedBag([
                {
                  "@count": 2,
                  "name": "Alice",
                },
                {
                  "@count": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_schema_back_05", () => {
    assertQueryResult(
      h,
      `
            select assert_exists((
                select Card { name, z := .owners { name, x := @count }}
                filter .name = 'Dragon'
            ));
            `,
      [
            {
              "name": "Dragon",
              "z": unorderedBag([
                {
                  "x": 2,
                  "name": "Alice",
                },
                {
                  "x": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select assert_exists((
                select Card { name, owners: { name, x := @count }}
                filter .name = 'Dragon'
            ));
            `,
      [
            {
              "name": "Dragon",
              "owners": unorderedBag([
                {
                  "x": 2,
                  "name": "Alice",
                },
                {
                  "x": 1,
                  "name": "Dave",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_props_intersect_01", () => {
    assertQueryResult(
      h,
      `
            select Named {
               [IS User].deck:{name, @count}
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

  it("test_edgeql_props_bogus_01", () => {
    expect(() => {
      h.query(
        `
                    select (
                      select User
                    ).deck {
                      linkprop := @count
                    };
                `
      );
    }).toThrow(new RegExp("implicit reference to an object changes the interpretation of it elsewhere in the query"));
  });

  it("test_edgeql_props_modification_01", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Src {
                CREATE LINK l -> Tgt {
                    CREATE PROPERTY x -> str;
                };
            };
        `
    );
    expect(() => {
      h.query(
        `
                    insert Src { l := assert_single(Tgt { @y := "..." }) };
                `
      );
    }).toThrow(new RegExp("link 'l' of object type 'default::Src' has no property 'y'"));
  });

  it("test_edgeql_props_tuples_01", () => {
    h.script(
      `
            create type Org;
            create type Foo {
                create multi link orgs -> Org {
                    create property roles -> tuple<role1: bool, role2: bool>;
                }
            };
            insert Org;
            insert Foo { orgs := (select Org {
                @roles := (role1 := true, role2 := false) }) };
        `
    );
    assertQueryResult(
      h,
      `
            select Foo.orgs@roles.role1;
            `,
      [true]
    );
  });

  it("test_edgeql_pure_computed_linkprops_01", () => {
    h.script(
      `
            CREATE TYPE default::Test3 {
                CREATE PROPERTY name: std::str {
                    SET default := 'test3';
                };
            };
            CREATE TYPE default::Test4 {
                CREATE LINK test3ref: default::Test3 {
                    CREATE PROPERTY note := (.name);
                };
                CREATE PROPERTY name: std::str {
                    SET default := 'test4';
                };
            };
            insert Test3;
        `
    );
    assertQueryResult(
      h,
      `
            insert Test4 { test3ref := (select Test3 limit 1)};
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_props_target_06", () => {
    expect(() => {
      h.query(
        `
                SELECT schema::ObjectType {
                  name,
                  is_abstract,
                  bases: {
                    name,
                  } ORDER BY @index ASC,
                  pointers: {
                    cardinality,
                    required,
                    name,
                    target: {
                      name,
                    },
                    kind := 'link' IF @target IS schema::Link ELSE 'property'
                  },
                } FILTER NOT .is_compound_type;
                `
      );
    }).toThrow(new RegExp("@target may only be used in index and constraint definitions"));
  });

  it("test_edgeql_props_dunder_default_01", () => {
    h.script(
      `
            CREATE TYPE Tgt {
                CREATE PROPERTY n -> int64;
            };
            CREATE TYPE Src {
                CREATE PROPERTY n -> int64;
                CREATE LINK l -> Tgt {
                    CREATE PROPERTY x -> int64 {
                        set default := -1;
                    };
                };
            };

            insert Tgt;
        `
    );
    h.query(
      `
            insert Src {
                n := 1,
                l := assert_single(Tgt { @x := __default__ }),
            };
            insert Src {
                n := 2,
                l := assert_single(Tgt) { @x := __default__ },
            };
            insert Src {
                n := 3,
                l := assert_single(Tgt { @x := ( .n ?? __default__ ) }),
            };
            update Tgt set { n := 9 };
            insert Src {
                n := 4,
                l := assert_single(Tgt { @x := ( .n ?? __default__ ) }),
            };
            insert Src {
                n := 5,
                l := (insert Tgt { n := 8, @x := __default__ })
            };
            insert Src {
                n := 6,
                l := (insert Tgt { n := 7 }) { @x := __default__ }
            };
            `
    );
    assertQueryResult(
      h,
      `SELECT Src { n, l: { n, @x } };`,
      [
            {
              "n": 1,
              "l": {
                "n": 9,
                "@x": -1,
              },
            },
            {
              "n": 2,
              "l": {
                "n": 9,
                "@x": -1,
              },
            },
            {
              "n": 3,
              "l": {
                "n": 9,
                "@x": -1,
              },
            },
            {
              "n": 4,
              "l": {
                "n": 9,
                "@x": 9,
              },
            },
            {
              "n": 5,
              "l": {
                "n": 8,
                "@x": -1,
              },
            },
            {
              "n": 6,
              "l": {
                "n": 7,
                "@x": -1,
              },
            },
          ]
    );
  });

  it("test_edgeql_props_dunder_default_02", () => {
    h.script(
      `
            CREATE TYPE Tgt {
                CREATE PROPERTY n -> int64;
            };
            CREATE TYPE Src {
                CREATE PROPERTY n -> int64;
                CREATE LINK l -> Tgt {
                    CREATE PROPERTY x -> int64 {
                        set default := -1;
                    };
                };
            };
            CREATE TYPE Src2 extending Src {
                ALTER LINK l {
                    ALTER PROPERTY x {
                        set default := -2;
                    };
                };
            };

            insert Tgt;
        `
    );
    h.query(
      `
            insert Src {
                n := 1,
                l := assert_single(Tgt { @x := __default__ }),
            };
            insert Src2 {
                n := 2,
                l := assert_single(Tgt { @x := __default__ }),
            };
            `
    );
    assertQueryResult(
      h,
      `SELECT Src { n, l: { n, @x } };`,
      [
            {
              "n": 1,
              "l": {
                "n": null,
                "@x": -1,
              },
            },
            {
              "n": 2,
              "l": {
                "n": null,
                "@x": -2,
              },
            },
          ]
    );
  });

  it("test_edgeql_props_dunder_default_03", () => {
    h.script(
      `
            CREATE TYPE Tgt {
                CREATE PROPERTY n -> int64;
            };
            CREATE TYPE Src {
                CREATE PROPERTY n -> int64;
                CREATE LINK l -> Tgt {
                    CREATE PROPERTY x -> int64 {
                        set default := -1;
                    };
                };
            };

            insert Tgt { n := 1 };
            insert Src {
                n := 0,
                l := assert_single(Tgt),
            };
        `
    );
    h.query(
      `
            update Src set { l := .l { @x := 9 }, };
            update Src set { l := .l { @x := __default__ }, };
            `
    );
    assertQueryResult(
      h,
      `SELECT Src { n, l: { n, @x } };`,
      [
            {
              "n": 0,
              "l": {
                "n": 1,
                "@x": -1,
              },
            },
          ]
    );
    h.query(
      `
            update Src set { l := .l { @x := 9 }, };
            update Src set {
                l := (insert Tgt { n := 2, @x := __default__ }),
            };
            `
    );
    assertQueryResult(
      h,
      `SELECT Src { n, l: { n, @x } };`,
      [
            {
              "n": 0,
              "l": {
                "n": 2,
                "@x": -1,
              },
            },
          ]
    );
    h.query(
      `
            update Src set { l := .l { @x := 9 }, };
            update Src set {
                l := (insert Tgt { n := 3 }) { @x := __default__ },
            };
            `
    );
    assertQueryResult(
      h,
      `SELECT Src { n, l: { n, @x } };`,
      [
            {
              "n": 0,
              "l": {
                "n": 3,
                "@x": -1,
              },
            },
          ]
    );
  });

  it("test_edgeql_props_dunder_default_04", () => {
    h.script(
      `
            CREATE TYPE Tgt {
                CREATE PROPERTY n -> int64;
            };
            CREATE TYPE Src {
                CREATE PROPERTY n -> int64;
                CREATE LINK l -> Tgt {
                    CREATE PROPERTY x -> int64 {
                        set default := -1;
                    };
                };
            };
            CREATE TYPE Src2 extending Src {
                ALTER LINK l {
                    ALTER PROPERTY x {
                        set default := -2;
                    };
                };
            };

            insert Tgt;
            insert Src {
                n := 1,
                l := assert_single(Tgt { @x := 8 }),
            };
            insert Src2 {
                n := 2,
                l := assert_single(Tgt { @x := 9 }),
            };
        `
    );
    h.query(
      `update Src set { l := .l { @x := __default__ }, }`
    );
    assertQueryResult(
      h,
      `SELECT Src { n, l: { @x } };`,
      [
            {
              "n": 1,
              "l": {
                "@x": -1,
              },
            },
            {
              "n": 2,
              "l": {
                "@x": -1,
              },
            },
          ]
    );
    h.query(
      `update Src2 set { l := .l { @x := __default__ }, }`
    );
    assertQueryResult(
      h,
      `SELECT Src { n, l: { @x } };`,
      [
            {
              "n": 1,
              "l": {
                "@x": -1,
              },
            },
            {
              "n": 2,
              "l": {
                "@x": -2,
              },
            },
          ]
    );
  });
});
