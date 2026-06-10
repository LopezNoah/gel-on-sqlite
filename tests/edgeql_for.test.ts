import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLFor", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "cards",
      setup: "cards_setup"
    });
  });

  it("test_edgeql_for_cross_01", () => {
    assertQueryResult(
      h,
      `
                FOR C IN Card
                # C and Card are not related here
                UNION (C.name, Card.name);
            `,
      unorderedBag([
            ["Bog monster", "Bog monster"],
            ["Bog monster", "Djinn"],
            ["Bog monster", "Dragon"],
            ["Bog monster", "Dwarf"],
            ["Bog monster", "Giant eagle"],
            ["Bog monster", "Giant turtle"],
            ["Bog monster", "Golem"],
            ["Bog monster", "Imp"],
            ["Bog monster", "Sprite"],
            ["Djinn", "Bog monster"],
            ["Djinn", "Djinn"],
            ["Djinn", "Dragon"],
            ["Djinn", "Dwarf"],
            ["Djinn", "Giant eagle"],
            ["Djinn", "Giant turtle"],
            ["Djinn", "Golem"],
            ["Djinn", "Imp"],
            ["Djinn", "Sprite"],
            ["Dragon", "Bog monster"],
            ["Dragon", "Djinn"],
            ["Dragon", "Dragon"],
            ["Dragon", "Dwarf"],
            ["Dragon", "Giant eagle"],
            ["Dragon", "Giant turtle"],
            ["Dragon", "Golem"],
            ["Dragon", "Imp"],
            ["Dragon", "Sprite"],
            ["Dwarf", "Bog monster"],
            ["Dwarf", "Djinn"],
            ["Dwarf", "Dragon"],
            ["Dwarf", "Dwarf"],
            ["Dwarf", "Giant eagle"],
            ["Dwarf", "Giant turtle"],
            ["Dwarf", "Golem"],
            ["Dwarf", "Imp"],
            ["Dwarf", "Sprite"],
            ["Giant eagle", "Bog monster"],
            ["Giant eagle", "Djinn"],
            ["Giant eagle", "Dragon"],
            ["Giant eagle", "Dwarf"],
            ["Giant eagle", "Giant eagle"],
            ["Giant eagle", "Giant turtle"],
            ["Giant eagle", "Golem"],
            ["Giant eagle", "Imp"],
            ["Giant eagle", "Sprite"],
            ["Giant turtle", "Bog monster"],
            ["Giant turtle", "Djinn"],
            ["Giant turtle", "Dragon"],
            ["Giant turtle", "Dwarf"],
            ["Giant turtle", "Giant eagle"],
            ["Giant turtle", "Giant turtle"],
            ["Giant turtle", "Golem"],
            ["Giant turtle", "Imp"],
            ["Giant turtle", "Sprite"],
            ["Golem", "Bog monster"],
            ["Golem", "Djinn"],
            ["Golem", "Dragon"],
            ["Golem", "Dwarf"],
            ["Golem", "Giant eagle"],
            ["Golem", "Giant turtle"],
            ["Golem", "Golem"],
            ["Golem", "Imp"],
            ["Golem", "Sprite"],
            ["Imp", "Bog monster"],
            ["Imp", "Djinn"],
            ["Imp", "Dragon"],
            ["Imp", "Dwarf"],
            ["Imp", "Giant eagle"],
            ["Imp", "Giant turtle"],
            ["Imp", "Golem"],
            ["Imp", "Imp"],
            ["Imp", "Sprite"],
            ["Sprite", "Bog monster"],
            ["Sprite", "Djinn"],
            ["Sprite", "Dragon"],
            ["Sprite", "Dwarf"],
            ["Sprite", "Giant eagle"],
            ["Sprite", "Giant turtle"],
            ["Sprite", "Golem"],
            ["Sprite", "Imp"],
            ["Sprite", "Sprite"],
          ])
    );
  });

  it("test_edgeql_for_cross_02", () => {
    assertQueryResult(
      h,
      `
                FOR C IN Card
                # C and Card are not related here, so count(Card) should be 9
                UNION (C.name, count(Card));
            `,
      unorderedBag([
            ["Bog monster", 9],
            ["Djinn", 9],
            ["Dragon", 9],
            ["Dwarf", 9],
            ["Giant eagle", 9],
            ["Giant turtle", 9],
            ["Golem", 9],
            ["Imp", 9],
            ["Sprite", 9],
          ])
    );
  });

  it("test_edgeql_for_cross_03", () => {
    assertQueryResult(
      h,
      `
                FOR Card IN Card
                # Card is shadowed here
                UNION (Card.name, count(Card));
            `,
      unorderedBag([
            ["Bog monster", 1],
            ["Djinn", 1],
            ["Dragon", 1],
            ["Dwarf", 1],
            ["Giant eagle", 1],
            ["Giant turtle", 1],
            ["Golem", 1],
            ["Imp", 1],
            ["Sprite", 1],
          ])
    );
  });

  it("test_edgeql_for_cross_04", () => {
    assertQueryResult(
      h,
      `
                FOR C IN Card
                # C and Card are not related here, so count(Card) should be 9
                UNION (count(C), count(Card));
            `,
      [
            [1, 9],
            [1, 9],
            [1, 9],
            [1, 9],
            [1, 9],
            [1, 9],
            [1, 9],
            [1, 9],
            [1, 9],
          ]
    );
  });

  it("test_edgeql_for_mix_01", () => {
    assertQueryResult(
      h,
      `
                FOR X IN {Card.name, User.name}
                UNION X;
            `,
      unorderedSet([
            "Alice",
            "Bob",
            "Bog monster",
            "Carol",
            "Dave",
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
  });

  it("test_edgeql_for_mix_02", () => {
    assertQueryResult(
      h,
      `
                FOR X IN {Card.name, User.name}
                # both Card and User should be independent of X
                UNION (X, count(Card), count(User));
            `,
      unorderedBag([
            ["Alice", 9, 4],
            ["Bob", 9, 4],
            ["Bog monster", 9, 4],
            ["Carol", 9, 4],
            ["Dave", 9, 4],
            ["Djinn", 9, 4],
            ["Dragon", 9, 4],
            ["Dwarf", 9, 4],
            ["Giant eagle", 9, 4],
            ["Giant turtle", 9, 4],
            ["Golem", 9, 4],
            ["Imp", 9, 4],
            ["Sprite", 9, 4],
          ])
    );
  });

  it("test_edgeql_for_mix_03", () => {
    assertQueryResult(
      h,
      `
                # should be the same result as above
                FOR X IN {Card.name, User.name}
                UNION (X, count(Card FILTER TRUE), count(User FILTER TRUE));
            `,
      unorderedBag([
            ["Alice", 9, 4],
            ["Bob", 9, 4],
            ["Bog monster", 9, 4],
            ["Carol", 9, 4],
            ["Dave", 9, 4],
            ["Djinn", 9, 4],
            ["Dragon", 9, 4],
            ["Dwarf", 9, 4],
            ["Giant eagle", 9, 4],
            ["Giant turtle", 9, 4],
            ["Golem", 9, 4],
            ["Imp", 9, 4],
            ["Sprite", 9, 4],
          ])
    );
  });

  it("test_edgeql_for_mix_04", () => {
    assertQueryResult(
      h,
      `
                FOR X IN {Card.name, User.name}
                # this should be just [3] for each name (9 + 4 of names)
                UNION count(User.friends);
            `,
      [
            3,
            3,
            3,
            3,
            3,
            3,
            3,
            3,
            3,
            3,
            3,
            3,
            3,
          ]
    );
  });

  it("test_edgeql_for_limit_01", () => {
    assertQueryResult(
      h,
      `
                SELECT X := (
                    FOR X IN {User.name}
                    UNION X
                )
                ORDER BY X
                OFFSET 2
                LIMIT 1
            `,
      unorderedSet(["Carol"])
    );
  });

  it("test_edgeql_for_implicit_limit_01", () => {
    assertQueryResult(
      h,
      `
                select sum((
                  for i in range_unpack(range(0, 10000)) union
                    1
                ));
            `,
      [10000]
    );
  });

  it("test_edgeql_for_filter_02", () => {
    assertQueryResult(
      h,
      `
                SELECT X := (
                    FOR X IN {Card.name}
                    UNION X
                )
                # this FILTER should have no impact
                FILTER Card.element = 'Air';
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
  });

  it("test_edgeql_for_filter_03", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    # get a combination of names from different object types
                    FOR X IN {Card.name, User.name}
                    UNION X
                )
                # this FILTER should have no impact
                FILTER Card.element = 'Air';
            `,
      unorderedSet([
            "Alice",
            "Bob",
            "Bog monster",
            "Carol",
            "Dave",
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
  });

  it("test_edgeql_for_in_computable_01", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := assert_distinct((
                        FOR letter IN {'I', 'B'}
                        UNION (
                            SELECT User.deck {
                                name,
                                # just define an ad-hoc link prop
                                @letter := letter
                            }
                            FILTER User.deck.name[0] = letter
                        )
                    ))
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "name": "Bog monster",
                  "@letter": "B",
                },
                {
                  "name": "Imp",
                  "@letter": "I",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_02", () => {
    h.script(
      `
            UPDATE User
            FILTER .name = "Alice"
            SET {
                deck += {
                    (INSERT Card {
                        name := "Ice Elemental",
                        element := "Water",
                        cost := 10
                    }),
                    (INSERT Card {
                        name := "Basilisk",
                        element := "Earth",
                        cost := 20
                    }),
                }
            }
            `
    );
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := (
                        SELECT DISTINCT((
                            FOR letter IN {'I', 'B'}
                            UNION (
                                FOR cost IN {1, 2, 10, 20}
                                UNION (
                                    SELECT User.deck {
                                        name,
                                        letter := letter ++ <str>cost
                                    }
                                    FILTER
                                        .name[0] = letter AND .cost = cost
                                )
                            )
                        ))
                        ORDER BY .name THEN .letter
                    )
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": [
                {
                  "name": "Basilisk",
                  "letter": "B20",
                },
                {
                  "name": "Bog monster",
                  "letter": "B2",
                },
                {
                  "name": "Ice Elemental",
                  "letter": "I10",
                },
                {
                  "name": "Imp",
                  "letter": "I1",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_02b", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := ((
                        WITH cards := (
                            FOR letter IN {'I', 'B'}
                            FOR copy IN {'1', '2'}
                            SELECT User.deck {
                                name,
                                letter := letter ++ copy
                            }
                            FILTER User.deck.name[0] = letter
                        )
                        SELECT cards ORDER BY .name THEN .letter
                    ),)
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": [
                [
                  {},
                ],
                [
                  {},
                ],
                [
                  {},
                ],
                [
                  {},
                ],
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_02c", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := DISTINCT (
                        FOR v IN { ("Imp", 1), ("Dragon", 2) }
                        UNION (
                            SELECT Card {
                                name,
                                count := <int64>v.1
                            }
                            FILTER .name = <str>v.0
                        )
                    )
                } FILTER .name = 'Alice'
            `,
      [
            {
              "select_deck": [
                {
                  "name": "Imp",
                  "count": 1,
                },
                {
                  "name": "Dragon",
                  "count": 2,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_02d", () => {
    h.script(
      `
            UPDATE User
            FILTER .name = "Alice"
            SET {
                deck += {
                    (INSERT Card {
                        name := "Ice Elemental",
                        element := "Water",
                        cost := 10
                    }),
                    (INSERT Card {
                        name := "Basilisk",
                        element := "Earth",
                        cost := 20
                    }),
                }
            }
            `
    );
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := assert_distinct((
                        WITH cards := (
                            FOR letter IN {'I', 'B'}
                            UNION (
                                FOR cost IN {1, 2, 10, 20}
                                UNION (
                                    SELECT User.deck {
                                        name,
                                        letter := letter ++ <str>cost
                                    }
                                    FILTER
                                        .name[0] = letter AND .cost = cost
                                )
                            )
                        )
                        SELECT cards {name, letter} ORDER BY .name THEN .letter
                    ))
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": [
                {
                  "name": "Basilisk",
                  "letter": "B20",
                },
                {
                  "name": "Bog monster",
                  "letter": "B2",
                },
                {
                  "name": "Ice Elemental",
                  "letter": "I10",
                },
                {
                  "name": "Imp",
                  "letter": "I1",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_02e", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := ((
                        WITH cards := (
                            FOR letter IN {'I', 'B'}
                            UNION (
                                FOR copy IN {'1', '2'}
                                UNION (
                                    SELECT User.deck {
                                        name,
                                        letter := letter ++ copy
                                    }
                                    FILTER User.deck.name[0] = letter
                                )
                            )
                        )
                        SELECT cards {name, letter} ORDER BY .name THEN .letter
                    ),)
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": [
                [
                  {
                    "name": "Bog monster",
                    "letter": "B1",
                  },
                ],
                [
                  {
                    "name": "Bog monster",
                    "letter": "B2",
                  },
                ],
                [
                  {
                    "name": "Imp",
                    "letter": "I1",
                  },
                ],
                [
                  {
                    "name": "Imp",
                    "letter": "I2",
                  },
                ],
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_03 [xerror: deeply nested linkprop hoisting is currently broken]", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := (
                        SELECT _ := (
                            FOR letter IN {'I', 'B'}
                            UNION (
                                SELECT User.deck {
                                    name,
                                    @letter := letter
                                }
                                FILTER User.deck.name[0] = letter
                            )
                        ) {
                            name,
                            # redefine the _letter as a link prop
                            @letter := ._letter
                        }
                        ORDER BY _.name
                    )
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": [
                {
                  "name": "Bog monster",
                  "@letter": "B",
                },
                {
                  "name": "Imp",
                  "@letter": "I",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_04 [xerror: See comment on why this test doesn't contain a FOR. The result is *almost* correct, but oddly @letter is not a singleton, even though it's equal to a tuple element, which should be a singleton by definition. See `test_edgeql_scope_tuple_13` for a shorter version of the same issue.]", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := (
                        WITH
                            Deck := User.deck,
                            letter := {'I', 'B'},
                            tup := (
                                SELECT (
                                    letter,
                                    (
                                        SELECT Deck
                                        FILTER Deck.name[0] = letter
                                    )
                                )
                            )
                        SELECT _ := tup.1 {
                            name,
                            # redefine the _letter as a link prop
                            @letter := tup.0
                        }
                        ORDER BY _.name
                    )
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": [
                {
                  "name": "Bog monster",
                  "@letter": "B",
                },
                {
                  "name": "Imp",
                  "@letter": "I",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_05", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := (
                        FOR letter IN {'X'}
                        UNION (
                            (SELECT .deck.name)
                        )
                    )
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag(["Bog monster", "Dragon", "Giant turtle", "Imp"]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := (
                        FOR letter IN 'X'
                        UNION (
                            ((SELECT .deck).name)
                        )
                    )
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag(["Bog monster", "Dragon", "Giant turtle", "Imp"]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_06", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
                select_deck := assert_distinct((
                    WITH ps := (FOR x IN {"!", "?"} UNION (x)),
                    FOR letter IN {'I', 'B'}
                    UNION (
                        SELECT .deck {
                            name,
                            letter := letter ++ "!" ++ ps,
                        }
                        FILTER User.deck.name[0] = letter
                    )
                ))
            } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "letter": unorderedSet(["B!!", "B!?"]),
                  "name": "Bog monster",
                },
                {
                  "letter": unorderedSet(["I!!", "I!?"]),
                  "name": "Imp",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_07", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
                select_deck := assert_distinct((
                    WITH ps := (FOR x IN {"!", "?"} UNION (
                        SELECT { z := x }).z),
                    FOR letter IN {'I', 'B'}
                    UNION (
                        SELECT .deck {
                            name,
                            letter := letter ++ "!" ++ ps,
                        }
                        FILTER User.deck.name[0] = letter
                    )
                ))
            } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "letter": ["B!!", "B!?"],
                  "name": "Bog monster",
                },
                {
                  "letter": ["I!!", "I!?"],
                  "name": "Imp",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_08", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
                select_deck := assert_distinct((
                    WITH ps := (FOR x in {"!", "?"} UNION (x++""))
                    FOR letter IN {'I', 'B'}
                    UNION (
                        SELECT .deck {
                            name,
                            letter := letter ++ "!" ++ ps,
                            correlated := (ps, ps),
                            uncorrelated := ((SELECT ps), (SELECT ps)),
                        }
                        FILTER User.deck.name[0] = letter
                    )
                ))
            } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "name": "Bog monster",
                  "letter": unorderedSet(["B!!", "B!?"]),
                  "correlated": unorderedSet([
                    ["!", "!"],
                    ["!", "?"],
                    ["?", "!"],
                    ["?", "?"],
                  ]),
                  "uncorrelated": unorderedSet([
                    ["!", "!"],
                    ["!", "?"],
                    ["?", "!"],
                    ["?", "?"],
                  ]),
                },
                {
                  "name": "Imp",
                  "letter": unorderedSet(["I!!", "I!?"]),
                  "correlated": unorderedSet([
                    ["!", "!"],
                    ["!", "?"],
                    ["?", "!"],
                    ["?", "?"],
                  ]),
                  "uncorrelated": unorderedSet([
                    ["!", "!"],
                    ["!", "?"],
                    ["?", "!"],
                    ["?", "?"],
                  ]),
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_09 [xerror: 'letter' does not exist]", () => {
    assertQueryResult(
      h,
      `
                WITH
                    U := (
                        SELECT User {
                            select_deck := (
                                FOR letter IN {'I', 'B'}
                                UNION (
                                    SELECT User.deck {
                                        name,
                                        # just define an ad-hoc link prop
                                        @letter := letter
                                    }
                                    FILTER User.deck.name[0] = letter
                                )
                            )
                        } FILTER .name = 'Alice'
                   ),
                SELECT U { name, select_deck: { name, @letter } };
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "name": "Bog monster",
                  "@letter": "B",
                },
                {
                  "name": "Imp",
                  "@letter": "I",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_10 [xerror: This outputs [\"I\", \"B\"] as letter for both objects.]", () => {
    assertQueryResult(
      h,
      `
            SELECT (SELECT User {
                select_deck := (
                    WITH Z := (
                        FOR letter IN {'I', 'B'}
                        UNION (
                            SELECT .deck {
                                name,
                                # just define an ad-hoc link prop
                                letter := letter
                            }
                            FILTER User.deck.name[0] = letter
                        )
                    ),
                    SELECT assert_distinct(Z)
                )
            } FILTER .name = 'Alice') { select_deck: {name, letter} };
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "name": "Bog monster",
                  "letter": "B",
                },
                {
                  "name": "Imp",
                  "letter": "I",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_11", () => {
    assertQueryResult(
      h,
      `
            SELECT
                User {
                    select_deck := DISTINCT (
                        FOR name IN {'Imp', 'Imp'}
                        UNION (
                            SELECT Card {name}
                            FILTER .name = name
                        )
                    )
                }
            FILTER
                .name = 'Alice'
            `,
      [
            {
              "select_deck": [
                {
                  "name": "Imp",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_12", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := (assert_exists((
                        FOR letter IN {'I', 'B'}
                        UNION (
                            SELECT User.deck {
                                name,
                                letter := letter
                            }
                            FILTER User.deck.name[0] = letter
                        )
                    )),)
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag([
                [
                  {
                    "name": "Bog monster",
                    "letter": "B",
                  },
                ],
                [
                  {
                    "name": "Imp",
                    "letter": "I",
                  },
                ],
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_13", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    multi select_deck := assert_single((
                        FOR letter IN {'I', 'Z'}
                        UNION (
                            SELECT User.deck {
                                name,
                                letter := letter
                            }
                            FILTER User.deck.name[0] = letter
                        )
                    ))
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": [
                {
                  "name": "Imp",
                  "letter": "I",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_14", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := DISTINCT assert_exists((
                        FOR letter IN {'I', 'B'}
                        UNION (
                            SELECT User.deck {
                                name,
                                letter := letter
                            }
                            FILTER User.deck.name[0] = letter
                        )
                    ))
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "name": "Bog monster",
                  "letter": "B",
                },
                {
                  "name": "Imp",
                  "letter": "I",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_15", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := assert_distinct(assert_exists((
                        FOR letter IN {'I', 'B'}
                        UNION (
                            SELECT User.deck {
                                name,
                                letter := letter
                            }
                            FILTER User.deck.name[0] = letter
                        )
                    )))
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "name": "Bog monster",
                  "letter": "B",
                },
                {
                  "name": "Imp",
                  "letter": "I",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_computable_16", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    select_deck := assert_exists(assert_distinct((
                        FOR letter IN {'I', 'B'}
                        UNION (
                            SELECT User.deck {
                                name,
                                letter := letter
                            }
                            FILTER User.deck.name[0] = letter
                        )
                    )))
                } FILTER .name = 'Alice';
            `,
      [
            {
              "select_deck": unorderedBag([
                {
                  "name": "Bog monster",
                  "letter": "B",
                },
                {
                  "name": "Imp",
                  "letter": "I",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_for_in_function_01", () => {
    assertQueryResult(
      h,
      `
                SELECT array_unpack([(
                    FOR letter IN {'I', 'Z'}
                    UNION (
                        SELECT Card {name, letter := letter}
                        FILTER .name[0] = letter
                    )
                )]);
            `,
      [
            {
              "letter": "I",
              "name": "Imp",
            },
          ]
    );
  });

  it("test_edgeql_for_in_function_02", () => {
    assertQueryResult(
      h,
      `
                SELECT enumerate((
                    FOR letter IN {'I', 'Z'}
                    UNION (
                        SELECT Card {name, letter := letter}
                        FILTER .name[0] = letter
                    )
                )).1;
            `,
      [
            {
              "letter": "I",
              "name": "Imp",
            },
          ]
    );
  });

  it("test_edgeql_for_in_function_03", () => {
    assertQueryResult(
      h,
      `
                SELECT DISTINCT assert_exists((
                    FOR letter IN {'I', 'Z'}
                    UNION (
                        SELECT Card {name, letter := letter}
                        FILTER .name[0] = letter
                    )
                ));
            `,
      [
            {
              "letter": "I",
              "name": "Imp",
            },
          ]
    );
  });

  it("test_edgeql_for_and_computable_05", () => {
    assertQueryResult(
      h,
      `
                WITH X := (SELECT (FOR x IN {1,2} UNION (
                    SELECT User { m := x }))),
                SELECT count(X.m);
            `,
      [8]
    );
  });

  it("test_edgeql_for_correlated_01", () => {
    assertQueryResult(
      h,
      `
                SELECT count((
                    WITH X := {1, 2}
                    SELECT (X, (FOR x in {X} UNION (SELECT x)))
                ));
            `,
      [4]
    );
    assertQueryResult(
      h,
      `
                SELECT count((
                    WITH X := {1, 2}
                    SELECT ((FOR x in {X} UNION (SELECT x)), X)
                ));
            `,
      [4]
    );
  });

  it("test_edgeql_for_correlated_02", () => {
    assertQueryResult(
      h,
      `
                SELECT count((Card.name,
                              (FOR x in {Card} UNION (SELECT x.name)),
                ));
            `,
      [81]
    );
  });

  it("test_edgeql_for_correlated_03", () => {
    assertQueryResult(
      h,
      `
                SELECT count(((FOR x in {Card} UNION (SELECT x.name)),
                               Card.name,
                ));
            `,
      [81]
    );
  });

  it("test_edgeql_for_empty_01", () => {
    expect(() => {
      h.script(
        `
                SELECT (FOR x in {} UNION ());
            `
      );
    }).toThrow(new RegExp("FOR statement has iterator of indeterminate type"));
  });

  it("test_edgeql_for_empty_02", () => {
    expect(() => {
      h.script(
        `
                WITH s := {} SELECT (FOR x in {s} UNION ());
            `
      );
    }).toThrow(new RegExp("FOR statement has iterator of indeterminate type"));
  });

  it("test_edgeql_for_fake_group_01a", () => {
    assertQueryResult(
      h,
      `
            with GR := (
                for x in {'Earth', 'Water'} union { key := {element := x} }
            )
            select GR {
              key: {element},
            }
            order by .key.element;
            `,
      [
            {
              "key": {
                "element": "Earth",
              },
            },
            {
              "key": {
                "element": "Water",
              },
            },
          ]
    );
  });

  it("test_edgeql_for_fake_group_01b", () => {
    assertQueryResult(
      h,
      `
            with GR := (
                for x in {'Earth', 'Water'} union {
                    key := {element := x},
                    elements := (select Card filter .element = x),
                }
            )
            select GR {
              key: {element},
            }
            order by .key.element;
            `,
      [
            {
              "key": {
                "element": "Earth",
              },
            },
            {
              "key": {
                "element": "Water",
              },
            },
          ]
    );
  });

  it("test_edgeql_for_fake_group_01c", () => {
    assertQueryResult(
      h,
      `
            with GR := (
                for x in {'Earth', 'Water'} union {
                    key := {element := x},
                    elements := (select Card filter .element = x),
                }
            )
            select GR {
              key: {element},
              elements: {name},
            }
            order by .key.element;
            `,
      [
            {
              "key": {
                "element": "Earth",
              },
              "elements": unorderedBag([
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Golem",
                },
              ]),
            },
            {
              "key": {
                "element": "Water",
              },
              "elements": unorderedBag([
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

  it("test_edgeql_for_fake_group_02", () => {
    assertQueryResult(
      h,
      `
            with GR := (for x in {'Earth', 'Water'} union {key := x})
            select GR { key }
            order by .key;
            `,
      [
            {
              "key": "Earth",
            },
            {
              "key": "Water",
            },
          ]
    );
  });

  it("test_edgeql_for_tuple_optional_01", () => {
    assertQueryResult(
      h,
      `
                for user in User union (
                  ((select (1,) filter false) ?? (2,)).0
                );
            `,
      [2, 2, 2, 2]
    );
    assertQueryResult(
      h,
      `
                for user in User union (
                  ((select (1,) filter user.name = 'Alice') ?? (2,)).0
                );
            `,
      unorderedBag([1, 2, 2, 2])
    );
  });

  it("test_edgeql_for_optional_01", () => {
    assertQueryResult(
      h,
      `
                for optional x in
                    ((select User filter .name = 'George'),)
                union x.0.deck_cost ?? 0;
            `,
      [0]
    );
    assertQueryResult(
      h,
      `
                for optional x in
                    ((select User filter .name = 'George'),)
                union x.0
            `,
      []
    );
    assertQueryResult(
      h,
      `
                for optional x in
                    ((select User filter .name = 'George'),)
                union x
            `,
      []
    );
    assertQueryResult(
      h,
      `
                for optional x in
                    ((select User filter .name = 'Alice'),)
                union x.0.deck_cost ?? 0;
            `,
      [11]
    );
    assertQueryResult(
      h,
      `
                for optional x in
                    ((select User filter .name = 'George'),)
                union (insert Award { name := "Participation" })
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
                for optional x in (<bool>{})
                union (insert Award { name := "Participation!" })
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
                for user in (select User filter .name = 'Alice') union (
                  for optional x in (<Card>{},) union (
                    1
                  )
                );
            `,
      [1]
    );
    assertQueryResult(
      h,
      `
                for user in (select User filter .name = 'Alice') union (
                  for optional x in (<Card>{},) union (
                    user.name
                  )
                );
            `,
      ["Alice"]
    );
    assertQueryResult(
      h,
      `
                for user in (select User filter .name = 'Alice') union (
                  for optional x in (<Card>{},) union (
                    user.name ++ (x.0.name ?? "!")
                  )
                );
            `,
      ["Alice!"]
    );
  });

  it("test_edgeql_for_optional_02", () => {
    assertQueryResult(
      h,
      `
                for optional x in
                    (select User filter .name = 'George')
                union x.deck_cost ?? 0;
            `,
      [0]
    );
    assertQueryResult(
      h,
      `
                for optional x in
                    (select User filter .name = 'Alice')
                union x.deck_cost ?? 0;
            `,
      [11]
    );
    assertQueryResult(
      h,
      `
                for optional x in
                    (select User filter .name = 'George')
                union (insert Award { name := "Participation" })
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_for_optional_03", () => {
    assertQueryResult(
      h,
      `
        for dummy in "1"
        for optional x in (delete Card filter .name = 'Yolanda Swaggins')
        select x.cost ?? 420;
        `,
      [420]
    );
  });

  it("test_edgeql_for_lprop_01", () => {
    assertQueryResult(
      h,
      `
            SELECT User {
                cards := (
                    SELECT (FOR d IN .deck SELECT (d.name, d@count))
                    ORDER BY .0
                ),
            }
            filter .name = 'Carol';
            `,
      [
            {
              "cards": [
                ["Bog monster", 3],
                ["Djinn", 1],
                ["Dwarf", 4],
                ["Giant eagle", 3],
                ["Giant turtle", 2],
                ["Golem", 2],
                ["Sprite", 4],
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT User {
                cards := (
                    SELECT (FOR d IN .deck[is SpecialCard]
                            SELECT (d.name, d@count))
                    ORDER BY .0
                ),
            }
            filter .name = 'Carol';
            `,
      [
            {
              "cards": [
                ["Djinn", 1],
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_lprop_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Card {
                users := (
                    SELECT (FOR u IN .<deck[is User] SELECT (u.name, u@count))
                    ORDER BY .0
                ),
            }
            filter .name = 'Dragon'
            `,
      [
            {
              "users": [
                ["Alice", 2],
                ["Dave", 1],
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Card {
                users := (
                    SELECT (FOR u IN .owners SELECT (u.name, u@count))
                    ORDER BY .0
                ),
            }
            filter .name = 'Dragon'
            `,
      [
            {
              "users": [
                ["Alice", 2],
                ["Dave", 1],
              ],
            },
          ]
    );
  });

  it("test_edgeql_for_lprop_03", () => {
    expect(() => {
      h.query(
        `
                FOR d IN User.deck SELECT (d.name, d@count);
            `
      );
    }).toThrow(new RegExp(""));
  });

  it("test_edgeql_for_lprop_04", () => {
    assertQueryResult(
      h,
      `
            for u in User for m in u.avatar select m@text;
            `,
      unorderedSet(["Best", "Wow"])
    );
  });
});
