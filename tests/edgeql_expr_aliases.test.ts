import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLExprAliases", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "cards",
      setup: "cards_setup",
      dbFile: "./tests/.artifacts/expr_aliases.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_aliases_basic_01", () => {
    assertQueryResult(
      h,
      `
                SELECT AirCard {
                    name,
                    owners: {
                        name
                    } ORDER BY .name
                } ORDER BY AirCard.name;
            `,
      [
            {
              "name": "Djinn",
              "owners": [
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Giant eagle",
              "owners": [
                {
                  "name": "Carol",
                },
                {
                  "name": "Dave",
                },
              ],
            },
            {
              "name": "Sprite",
              "owners": [
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

  it("test_edgeql_aliases_basic_02", () => {
    h.script(
      `
            CREATE ALIAS expert_map := (
                SELECT {
                    ('Alice', 'pro'),
                    ('Bob', 'noob'),
                    ('Carol', 'noob'),
                    ('Dave', 'casual'),
                }
            );
        `
    );
    assertQueryResult(
      h,
      `
                SELECT expert_map
                ORDER BY expert_map;
            `,
      [
            ["Alice", "pro"],
            ["Bob", "noob"],
            ["Carol", "noob"],
            ["Dave", "casual"],
          ]
    );
    h.script(
      `
            DROP ALIAS expert_map;
        `
    );
  });

  it("test_edgeql_aliases_basic_03", () => {
    h.script(
      `
            CREATE ALIAS scores := (
                SELECT {
                    (name := 'Alice', score := 100, games := 10),
                    (name := 'Bob', score := 11, games := 2),
                    (name := 'Carol', score := 31, games := 5),
                    (name := 'Dave', score := 78, games := 10),
                }
            );
        `
    );
    assertQueryResult(
      h,
      `
                SELECT scores ORDER BY scores.name;
            `,
      [
            {
              "name": "Alice",
              "score": 100,
              "games": 10,
            },
            {
              "name": "Bob",
              "score": 11,
              "games": 2,
            },
            {
              "name": "Carol",
              "score": 31,
              "games": 5,
            },
            {
              "name": "Dave",
              "score": 78,
              "games": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <tuple<str, int64, int64>>scores
                ORDER BY .0;
            `,
      [
            ["Alice", 100, 10],
            ["Bob", 11, 2],
            ["Carol", 31, 5],
            ["Dave", 78, 10],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <tuple<name: str, points: int64, plays: int64>>scores
                ORDER BY .name;
            `,
      [
            {
              "name": "Alice",
              "points": 100,
              "plays": 10,
            },
            {
              "name": "Bob",
              "points": 11,
              "plays": 2,
            },
            {
              "name": "Carol",
              "points": 31,
              "plays": 5,
            },
            {
              "name": "Dave",
              "points": 78,
              "plays": 10,
            },
          ]
    );
    h.script(
      `
            DROP ALIAS scores;
        `
    );
  });

  it("test_edgeql_aliases_basic_04", () => {
    h.script(
      `
            CREATE ALIAS levels := {'pro', 'casual', 'noob'};
        `
    );
    assertQueryResult(
      h,
      `
                SELECT levels;
            `,
      unorderedSet(["casual", "noob", "pro"])
    );
  });

  it("test_edgeql_aliases_create_01", () => {
    h.script(
      `
            CREATE ALIAS DCard := (
                SELECT Card {
                    # This is an identical computable to the one
                    # present in the type, but it must be legal to
                    # override the link with any compatible
                    # expression.
                    owners := (
                        SELECT Card.<deck[IS User] {
                            name_upper := str_upper(.name)
                        }
                    )
                } FILTER Card.name LIKE 'D%'
            );
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DCard {
                    name,
                    owners: {
                        name_upper,
                    } ORDER BY .name
                } ORDER BY DCard.name;
            `,
      [
            {
              "name": "Djinn",
              "owners": [
                {
                  "name_upper": "CAROL",
                },
                {
                  "name_upper": "DAVE",
                },
              ],
            },
            {
              "name": "Dragon",
              "owners": [
                {
                  "name_upper": "ALICE",
                },
                {
                  "name_upper": "DAVE",
                },
              ],
            },
            {
              "name": "Dwarf",
              "owners": [
                {
                  "name_upper": "BOB",
                },
                {
                  "name_upper": "CAROL",
                },
              ],
            },
          ]
    );
    h.script(
      `DROP ALIAS DCard;`
    );
    h.script(
      `
            CREATE ALIAS DCard := (
                SELECT Card {
                    owners := (
                        SELECT Card.<deck[IS User] {
                            name_upper := str_upper(.name)
                        }
                    )
                } FILTER Card.name LIKE 'D%'
            );
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE schema,
                    DCardT := (SELECT ObjectType
                               FILTER .name = 'default::DCard'),
                    DCardOwners := (SELECT DCardT.links
                                    FILTER .name = 'owners')
                SELECT
                    DCardOwners {
                        target[IS ObjectType]: {
                            name,
                            pointers: {
                                name
                            } FILTER .name = 'name_upper'
                        }
                    }
            `,
      [
            {
              "target": {
                "name": "default::__DCard__owners",
                "pointers": [
                  {
                    "name": "name_upper",
                  },
                ],
              },
            },
          ]
    );
  });

  it("test_edgeql_aliases_filter_01", () => {
    assertQueryResult(
      h,
      `
                SELECT FireCard {name}
                FILTER FireCard IN DaveCard
                ORDER BY FireCard.name;
            `,
      [
            {
              "name": "Dragon",
            },
          ]
    );
  });

  it("test_edgeql_aliases_filter02", () => {
    assertQueryResult(
      h,
      `
                SELECT AirCard {name}
                FILTER AirCard NOT IN (SELECT Card FILTER Card.name LIKE 'D%')
                ORDER BY AirCard.name;
            `,
      [
            {
              "name": "Giant eagle",
            },
            {
              "name": "Sprite",
            },
          ]
    );
  });

  it("test_edgeql_computable_link_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Card {
                    owners: {
                        name
                    } ORDER BY .name
                }
                FILTER .name = 'Djinn';
            `,
      [
            {
              "owners": [
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

  it("test_edgeql_computable_link_02", () => {
    assertQueryResult(
      h,
      `
                SELECT User {
                    name,
                    deck_cost
                }
                ORDER BY User.name;
            `,
      [
            {
              "name": "Alice",
              "deck_cost": 11,
            },
            {
              "name": "Bob",
              "deck_cost": 9,
            },
            {
              "name": "Carol",
              "deck_cost": 16,
            },
            {
              "name": "Dave",
              "deck_cost": 20,
            },
          ]
    );
  });

  it("test_edgeql_computable_aliased_link_01", () => {
    assertQueryResult(
      h,
      `
                SELECT AliasedFriends {
                    my_name,
                    my_friends: {
                        @nickname
                    } ORDER BY .name
                }
                FILTER .name = 'Alice';
            `,
      [
            {
              "my_name": "Alice",
              "my_friends": [
                {
                  "@nickname": "Swampy",
                },
                {
                  "@nickname": "Firefighter",
                },
                {
                  "@nickname": "Grumpy",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_computable_nested_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Card {
                    name,
                    owned := (
                        WITH O := Card.<deck[IS User]
                        SELECT O {
                            name,
                            # simple computable
                            fr0 := count(O.friends),
                            # computable with an alias defined
                            fr1 := (WITH F := O.friends SELECT count(F)),
                        }
                        ORDER BY .name
                    )
                } FILTER .name = 'Giant turtle';
            `,
      [
            {
              "name": "Giant turtle",
              "owned": [
                {
                  "fr0": 3,
                  "fr1": 3,
                  "name": "Alice",
                },
                {
                  "fr0": 0,
                  "fr1": 0,
                  "name": "Bob",
                },
                {
                  "fr0": 0,
                  "fr1": 0,
                  "name": "Carol",
                },
                {
                  "fr0": 1,
                  "fr1": 1,
                  "name": "Dave",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_computable_nested_02", () => {
    assertQueryResult(
      h,
      `
                WITH C := Card { ava_owners := .<avatar }
                SELECT C {
                    name,
                    ava_owners: {
                        typename := (
                            WITH name := C.ava_owners.__type__.name
                            SELECT name
                        )
                    }
                }
                FILTER EXISTS .ava_owners
                ORDER BY .name
            `,
      [
            {
              "name": "Djinn",
              "ava_owners": [
                {
                  "typename": "default::Bot",
                },
              ],
            },
            {
              "name": "Dragon",
              "ava_owners": [
                {
                  "typename": "default::User",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_computable_nested_03", () => {
    assertQueryResult(
      h,
      `
                WITH C := Card { ava_owners := .<avatar }
                SELECT C {
                    name,
                    ava_owners: {
                        multi typename := (
                            WITH name := C.ava_owners.__type__.name
                            SELECT name
                        )
                    }
                }
                FILTER EXISTS .ava_owners
                ORDER BY .name;
            `,
      [
            {
              "name": "Djinn",
              "ava_owners": [
                {
                  "typename": unorderedSet(["default::Bot"]),
                },
              ],
            },
            {
              "name": "Dragon",
              "ava_owners": [
                {
                  "typename": unorderedSet(["default::User"]),
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_aliases_shape_propagation_01", () => {
    assertQueryResult(
      h,
      `
                SELECT _ := {
                    (SELECT User FILTER .name = 'Alice').deck,
                    (SELECT User FILTER .name = 'Bob').deck
                } {name}
                ORDER BY _.name;
            `,
      [
            {
              "name": "Bog monster",
            },
            {
              "name": "Bog monster",
            },
            {
              "name": "Dragon",
            },
            {
              "name": "Dwarf",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Golem",
            },
            {
              "name": "Imp",
            },
          ]
    );
  });

  it("test_edgeql_aliases_shape_propagation_02", () => {
    assertQueryResult(
      h,
      `
                # the alias should be propagated through _ := DISTINCT since it
                # maps \`any\` to \`any\`
                SELECT _ := DISTINCT {
                    (SELECT User FILTER .name = 'Alice').deck,
                    (SELECT User FILTER .name = 'Bob').deck
                } {name}
                ORDER BY _.name;
            `,
      [
            {
              "name": "Bog monster",
            },
            {
              "name": "Dragon",
            },
            {
              "name": "Dwarf",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Golem",
            },
            {
              "name": "Imp",
            },
          ]
    );
  });

  it("test_edgeql_aliases_shape_propagation_03", () => {
    assertQueryResult(
      h,
      `
                # the alias should be propagated through _ := DETACHED
                SELECT _ := DETACHED {
                    (SELECT User FILTER .name = 'Alice').deck,
                    (SELECT User FILTER .name = 'Bob').deck
                } {name}
                ORDER BY _.name;
            `,
      [
            {
              "name": "Bog monster",
            },
            {
              "name": "Bog monster",
            },
            {
              "name": "Dragon",
            },
            {
              "name": "Dwarf",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Golem",
            },
            {
              "name": "Imp",
            },
          ]
    );
  });

  it("test_edgeql_aliases_shape_propagation_04", () => {
    assertQueryResult(
      h,
      `
                # the alias should be propagated through _ := DETACHED
                SELECT _ := DETACHED ({
                    (SELECT User FILTER .name = 'Alice').deck,
                    (SELECT User FILTER .name = 'Bob').deck
                } {name})
                ORDER BY _.name;
            `,
      [
            {
              "name": "Bog monster",
            },
            {
              "name": "Bog monster",
            },
            {
              "name": "Dragon",
            },
            {
              "name": "Dwarf",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Giant turtle",
            },
            {
              "name": "Golem",
            },
            {
              "name": "Imp",
            },
          ]
    );
  });

  it("test_edgeql_aliases_if_else_01", () => {
    assertQueryResult(
      h,
      `
                SELECT
                    _ := 'yes' IF Card.cost > 4 ELSE 'no'
                ORDER BY _;
            `,
      [
            "no",
            "no",
            "no",
            "no",
            "no",
            "no",
            "no",
            "no",
            "yes",
          ]
    );
  });

  it("test_edgeql_aliases_if_else_02 [xerror: Known collation issue on Heroku Postgres]", () => {
    assertQueryResult(
      h,
      `
                # working with singletons
                SELECT
                    _ := (
                      for u in User
                      select 'ok' IF u.deck_cost < 19 ELSE u.deck.name
                    )
                ORDER BY _;
            `,
      [
            "Bog monster",
            "Djinn",
            "Dragon",
            "Giant eagle",
            "Giant turtle",
            "Golem",
            "Sprite",
            "ok",
            "ok",
            "ok",
          ]
    );
    assertQueryResult(
      h,
      `
                # either result is a set, but the condition is a singleton
                SELECT
                    _ := (
                        for u in User
                         select u.deck.element IF u.deck_cost < 19
                                ELSE u.deck.name
                    )
                ORDER BY _;
            `,
      [
            "Air",
            "Air",
            "Air",
            "Bog monster",
            "Djinn",
            "Dragon",
            "Earth",
            "Earth",
            "Earth",
            "Earth",
            "Fire",
            "Fire",
            "Giant eagle",
            "Giant turtle",
            "Golem",
            "Sprite",
            "Water",
            "Water",
            "Water",
            "Water",
            "Water",
            "Water",
          ]
    );
  });

  it("test_edgeql_aliases_if_else_03", () => {
    assertQueryResult(
      h,
      `
                # get the data that this test relies upon in a format
                # that's easy to analyze
                SELECT _ := User.deck.element
                ORDER BY _;
            `,
      [
            "Air",
            "Air",
            "Air",
            "Earth",
            "Earth",
            "Fire",
            "Fire",
            "Water",
            "Water",
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT _ := <str>User.deck.cost
                ORDER BY _;
            `,
      [
            "1",
            "1",
            "1",
            "2",
            "2",
            "3",
            "3",
            "4",
            "5",
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT _ := {User.name[0] = 'A', EXISTS User.friends}
                ORDER BY _;
            `,
      [false, false, false, true, true]
    );
    assertQueryResult(
      h,
      `
                # results and conditions are sets
                SELECT _ :=
                    User.deck.element
                    # because the elements of {} are treated as SET OF,
                    # all of the paths in this expression are independent sets
                    IF {User.name[0] = 'A', EXISTS User.friends} ELSE
                    <str>User.deck.cost
                ORDER BY _;
            `,
      [
            "1",
            "1",
            "1",
            "1",
            "1",
            "1",
            "1",
            "1",
            "1",
            "2",
            "2",
            "2",
            "2",
            "2",
            "2",
            "3",
            "3",
            "3",
            "3",
            "3",
            "3",
            "4",
            "4",
            "4",
            "5",
            "5",
            "5",
            "Air",
            "Air",
            "Air",
            "Air",
            "Air",
            "Air",
            "Earth",
            "Earth",
            "Earth",
            "Earth",
            "Fire",
            "Fire",
            "Fire",
            "Fire",
            "Water",
            "Water",
            "Water",
            "Water",
          ]
    );
  });

  it("test_edgeql_aliases_if_else_04", () => {
    assertQueryResult(
      h,
      `
                FOR User in User
                SELECT
                    1   IF User.name[0] = 'A' ELSE
                    10  IF User.name[0] = 'B' ELSE
                    100 IF User.name[0] = 'C' ELSE
                    0;
            `,
      unorderedSet([0, 1, 10, 100])
    );
    assertQueryResult(
      h,
      `
                FOR User in User
                SELECT (
                    User.name,
                    sum((
                        FOR f in User.friends SELECT
                        1   IF f.name[0] = 'A' ELSE
                        10  IF f.name[0] = 'B' ELSE
                        100 IF f.name[0] = 'C' ELSE
                        0
                    )),
                ) ORDER BY .0;
            `,
      [
            ["Alice", 110],
            ["Bob", 0],
            ["Carol", 0],
            ["Dave", 10],
          ]
    );
  });

  it("test_edgeql_aliases_if_else_05", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                FOR Card in Card
                SELECT
                    (Card.name, 'yes' IF Card.cost > 4 ELSE 'no')
                )
                ORDER BY .0;
            `,
      [
            ["Bog monster", "no"],
            ["Djinn", "no"],
            ["Dragon", "yes"],
            ["Dwarf", "no"],
            ["Giant eagle", "no"],
            ["Giant turtle", "no"],
            ["Golem", "no"],
            ["Imp", "no"],
            ["Sprite", "no"],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (
                FOR Card in Card
                SELECT
                    (Card.name, 'yes') IF Card.cost > 4 ELSE (Card.name, 'no')
                )
                ORDER BY .0;
            `,
      [
            ["Bog monster", "no"],
            ["Djinn", "no"],
            ["Dragon", "yes"],
            ["Dwarf", "no"],
            ["Giant eagle", "no"],
            ["Giant turtle", "no"],
            ["Golem", "no"],
            ["Imp", "no"],
            ["Sprite", "no"],
          ]
    );
  });

  it("test_edgeql_aliases_nested_01", () => {
    assertQueryResult(
      h,
      `
                SELECT AwardAlias {
                    name,
                    winner: {
                        name
                    }
                } ORDER BY .name;
            `,
      [
            {
              "name": "1st",
              "winner": {
                "name": "Alice",
              },
            },
            {
              "name": "2nd",
              "winner": {
                "name": "Alice",
              },
            },
            {
              "name": "3rd",
              "winner": {
                "name": "Bob",
              },
            },
          ]
    );
  });

  it("test_edgeql_aliases_nested_02", () => {
    assertQueryResult(
      h,
      `
                SELECT {
                    foo := (
                        SELECT AwardAlias {
                            name,
                            winner: {
                                name
                            }
                        } ORDER BY .name
                    )
                };
            `,
      [
            {
              "foo": [
                {
                  "name": "1st",
                  "winner": {
                    "name": "Alice",
                  },
                },
                {
                  "name": "2nd",
                  "winner": {
                    "name": "Alice",
                  },
                },
                {
                  "name": "3rd",
                  "winner": {
                    "name": "Bob",
                  },
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_aliases_nested_03", () => {
    assertQueryResult(
      h,
      `
                SELECT AwardAlias {
                    winner: {
                        name_upper
                    }
                }
                FILTER
                    .winner.name_upper = 'ALICE';
            `,
      [
            {
              "winner": {
                "name_upper": "ALICE",
              },
            },
            {
              "winner": {
                "name_upper": "ALICE",
              },
            },
          ]
    );
  });

  it("test_edgeql_aliases_deep_01", () => {
    const res = h.query(`
            SELECT AwardAlias {
                winner: {
                    deck: {
                        owners
                    }
                }
            }
            FILTER .name = '1st'
            LIMIT 1;
        `).rows;
    assertQueryResult(
      h,
      `
                SELECT AwardAlias2 {
                    winner: {
                        deck: {
                            owners
                        }
                    }
                }
                FILTER .name = '1st';
            `,
      res
    );
  });

  it("test_edgeql_aliases_clauses_01", () => {
    const res = h.query(`
      SELECT User {
        deck: {
          id
        } ORDER BY User.deck.cost DESC
        LIMIT 1,
      }
      FILTER .name = 'Alice';`).rows;
    assertQueryResult(
      h,
      `
                SELECT UserAlias {
                    deck,
                }
                FILTER .name = 'Alice';
            `,
      res
    );
  });

  it("test_edgeql_aliases_limit_01", () => {
    h.script(
      `
            CREATE ALIAS FirstUser := (
                SELECT User {
                    name_upper := str_upper(User.name)
                }
                ORDER BY .name
                LIMIT 1
            );
        `
    );
    assertQueryResult(
      h,
      `
                SELECT FirstUser {
                    name_upper,
                }
            `,
      [
            {
              "name_upper": "ALICE",
            },
          ]
    );
  });

  it("test_edgeql_aliases_ignore_alias", () => {
    h.script(
      `

            CREATE ALIAS UserAlias2 := (
                SELECT User {
                    deck: {
                        id
                    } ORDER BY User.deck.cost DESC
                    LIMIT 1,
                }
            );
        `
    );
    h.script(
      `
            SET MODULE std;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT default::UserAlias2 {
                    deck,
                }
                FILTER .name = 'Alice';
            `,
      [
            {
              "deck": [
                {},
              ],
            },
          ]
    );
  });

  it("test_edgeql_aliases_esdl_01", () => {
    assertQueryResult(
      h,
      `
                SELECT WaterOrEarthCard {
                    name,
                    owned_by_alice,
                }
                FILTER any(.name ILIKE {'%turtle%', 'dwarf'})
                ORDER BY .name;
            `,
      [
            {
              "name": "Dwarf",
              "owned_by_alice": true,
            },
            {
              "name": "Giant turtle",
              "owned_by_alice": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT EarthOrFireCard {
                    name,
                }
                FILTER .name IN {'Imp', 'Dwarf'}
                ORDER BY .name;
            `,
      [
            {
              "name": "Dwarf",
            },
            {
              "name": "Imp",
            },
          ]
    );
  });

  it("test_edgeql_aliases_collection_01", () => {
    assertQueryResult(
      h,
      `
                SELECT SpecialCardAlias {
                    name,
                    el_cost,
                };
            `,
      [
            {
              "name": "Djinn",
              "el_cost": ["Air", 4],
            },
          ]
    );
  });

  it("test_edgeql_aliases_collection_02", () => {
    assertQueryResult(
      h,
      `
                SELECT SpecialCardAlias.el_cost;
            `,
      [
            ["Air", 4],
          ]
    );
  });

  it("test_edgeql_aliases_collection_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    X := SpecialCard {
                        el_cost := (.element, .cost)
                    }
                SELECT X.el_cost;
            `,
      [
            ["Air", 4],
          ]
    );
  });

  it("test_edgeql_aliases_collection_04", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    SpecialCard {
                        el_cost := (.element,)
                    }
                ).el_cost;
            `,
      [
            ["Air"],
          ]
    );
  });

  it("test_edgeql_aliases_collection_05", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    SpecialCard {
                        el_cost := [.element]
                    }
                ).el_cost;
            `,
      [
            ["Air"],
          ]
    );
  });

  it("test_edgeql_aliases_subqueries_01", () => {
    assertQueryResult(
      h,
      `
                SELECT count((
                    (SELECT EarthOrFireCard.name),
                    (EarthOrFireCard.name)
                ))
            `,
      [16]
    );
  });

  it("test_edgeql_aliases_subqueries_02", () => {
    assertQueryResult(
      h,
      `
                SELECT count((
                    (EarthOrFireCard.name),
                    (SELECT EarthOrFireCard.name)
                ))
            `,
      [16]
    );
  });

  it("test_edgeql_aliases_subqueries_03", () => {
    assertQueryResult(
      h,
      `
                SELECT count((
                    (EarthOrFireCard.name),
                    (EarthOrFireCard.name)
                ))
            `,
      [16]
    );
  });

  it("test_edgeql_aliases_subqueries_04", () => {
    assertQueryResult(
      h,
      `
                SELECT count((
                    (SELECT EarthOrFireCard.name),
                    (SELECT EarthOrFireCard.name)
                ))
            `,
      [16]
    );
  });

  it("test_edgeql_aliases_introspection", () => {
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Type {
                    name
                }
                FILTER .from_alias AND .name LIKE 'default::Air%'
                ORDER BY .name
            `,
      [
            {
              "name": "default::AirCard",
            },
          ]
    );
    h.script(
      `
            CREATE ALIAS tuple_alias := ('foo', 10);
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Tuple {
                    name,
                    element_types: {
                        name := .type.name
                    } ORDER BY @index
                }
                FILTER
                    .from_alias
                    AND .name = 'default::tuple_alias'
                ORDER BY .name
            `,
      [
            {
              "name": "default::tuple_alias",
              "element_types": [
                {
                  "name": "std::str",
                },
                {
                  "name": "std::int64",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                select schema::Pointer {name, target: {from_alias}}
                filter .name = 'winner'
                and .source.name = 'default::AwardAlias'
            `,
      [
            {
              "name": "winner",
              "target": {
                "from_alias": true,
              },
            },
          ]
    );
  });

  it("test_edgeql_aliases_backlinks_01", () => {
    expect(() => {
      h.script(
        `
                SELECT User.<owners[Is Card];
            `
      );
    }).toThrow(new RegExp("cannot follow backlink 'owners'"));
  });

  it("test_edgeql_aliases_backlinks_02", () => {
    expect(() => {
      h.script(
        `
                SELECT User.<owners;
            `
      );
    }).toThrow(new RegExp("cannot follow backlink 'owners'"));
  });

  it("test_edgeql_aliases_helper_01", () => {
    expect(() => {
      h.script(
        `
                SELECT __AwardAlias2__winner
            `
      );
    }).toThrow(new RegExp("cannot refer to alias link helper type 'default::__AwardAlias2__winner'"));
  });

  it("test_edgeql_aliases_detached_01", () => {
    assertQueryResult(
      h,
      `
                select count((detached FireCard, detached FireCard))
            `,
      [4]
    );
  });

  it("test_edgeql_aliases_coll_types_01", () => {
    h.script(
      `
                create type X;
                create global y := (select
                    (a := 'hello', b := [(select X limit 1)])
                );
                create alias z := (
                   a := 'hello', b := [(select X limit 1)]
                );
            `
    );
  });

  it("test_edgeql_aliases_schema_types_01", () => {
    h.script(
      `
            create alias best_card := 'Dragon';
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      [
            {
              "name": "default::best_card",
            },
          ]
    );
    h.script(
      `
            drop alias best_card;
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      []
    );
    h.script(
      `
            create module my_mod;
            create alias my_mod::best_card := 'Dragon';
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      [
            {
              "name": "my_mod::best_card",
            },
          ]
    );
    h.script(
      `
            drop alias my_mod::best_card;
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      []
    );
  });

  it("test_edgeql_aliases_schema_types_02", () => {
    h.script(
      `
            create alias best_card := (
                select Card filter .name = 'Dragon' limit 1
            );
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      [
            {
              "name": "default::best_card",
            },
          ]
    );
    h.script(
      `
            drop alias best_card;
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      []
    );
    h.script(
      `
            create module my_mod;
            create alias my_mod::best_card := (
                select Card filter .name = 'Dragon' limit 1
            );
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      [
            {
              "name": "my_mod::best_card",
            },
          ]
    );
    h.script(
      `
            drop alias my_mod::best_card;
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      []
    );
  });

  it("test_edgeql_aliases_schema_types_03", () => {
    h.script(
      `
            create alias best_card := (
                select Card {name}
                filter .name = 'Dragon' limit 1
            );
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%"
            order by .name;
            `,
      [
            {
              "name": "default::__best_card__Card",
            },
            {
              "name": "default::best_card",
            },
          ]
    );
    h.script(
      `
            drop alias best_card;
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      []
    );
    h.script(
      `
            create module my_mod;
            create alias my_mod::best_card := (
                select Card {name}
                filter .name = 'Dragon' limit 1
            );
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%"
            order by .name;
            `,
      [
            {
              "name": "my_mod::__best_card__Card",
            },
            {
              "name": "my_mod::best_card",
            },
          ]
    );
    h.script(
      `
            drop alias my_mod::best_card;
        `
    );
    assertQueryResult(
      h,
      `
            with module schema select Type { name }
            filter .name ilike "%best_card%";
            `,
      []
    );
  });

  it("test_edgeql_aliases_array_of_array_01", () => {
    assertQueryResult(
      h,
      `
                select AliasArrayOfArrayOfScalar;
            `,
      [
            [
              [1, 2, 3],
              [4, 5, 6],
            ],
          ]
    );
  });

  it("test_edgeql_aliases_array_of_array_02", () => {
    assertQueryResult(
      h,
      `
                select array_agg((
                    for card_group in array_unpack(AliasCardsByCost)
                        select array_agg((
                            for card in array_unpack(card_group)
                                select card.name
                        ))
                ))
            `,
      [
            [
              unorderedBag([]),
              unorderedBag(["Imp", "Dwarf", "Sprite"]),
              unorderedBag(["Bog monster", "Giant eagle"]),
              unorderedBag(["Giant turtle", "Golem"]),
              unorderedBag(["Djinn"]),
              unorderedBag(["Dragon"]),
            ],
          ]
    );
  });
});
