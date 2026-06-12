import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  queryRows,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLGroup", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "issues",
      setup: "issues_setup",
      extraModules: { cards: "cards" },
      extraSetups: [{ module: "cards", setup: "cards_setup" }],
    });
  });

  function _test_edgeql_group_by_group_by_03(qry: string): void {
    assertQueryResult(
      h,
      qry,
      unorderedBag([
            {
              "el": "Water",
              "groups": unorderedBag([
                {
                  "elements": [
                    {
                      "cost": 2,
                      "name": "Bog monster",
                    },
                  ],
                  "even": 0,
                },
                {
                  "elements": [
                    {
                      "cost": 3,
                      "name": "Giant turtle",
                    },
                  ],
                  "even": 1,
                },
              ]),
            },
            {
              "el": "Fire",
              "groups": [
                {
                  "elements": unorderedBag([
                    {
                      "cost": 1,
                      "name": "Imp",
                    },
                    {
                      "cost": 5,
                      "name": "Dragon",
                    },
                  ]),
                  "even": 1,
                },
              ],
            },
            {
              "el": "Earth",
              "groups": [
                {
                  "elements": unorderedBag([
                    {
                      "cost": 1,
                      "name": "Dwarf",
                    },
                    {
                      "cost": 3,
                      "name": "Golem",
                    },
                  ]),
                  "even": 1,
                },
              ],
            },
            {
              "el": "Air",
              "groups": unorderedBag([
                {
                  "elements": unorderedBag([
                    {
                      "cost": 2,
                      "name": "Giant eagle",
                    },
                    {
                      "cost": 4,
                      "name": "Djinn",
                    },
                  ]),
                  "even": 0,
                },
                {
                  "elements": [
                    {
                      "cost": 1,
                      "name": "Sprite",
                    },
                  ],
                  "even": 1,
                },
              ]),
            },
          ])
    );
  }

  it("test_edgeql_group_simple_01", () => {
    assertQueryResult(
      h,
      `
            GROUP cards::Card {name} BY .element
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
              "key": {
                "element": "Water",
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
              ]),
              "key": {
                "element": "Fire",
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Golem",
                },
              ]),
              "key": {
                "element": "Earth",
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Sprite",
                },
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Djinn",
                },
              ]),
              "key": {
                "element": "Air",
              },
            },
          ])
    );
  });

  it("test_edgeql_group_simple_02", () => {
    assertQueryResult(
      h,
      `
            SELECT (GROUP cards::Card {name} BY .element)
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
              "key": {
                "element": "Water",
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
              ]),
              "key": {
                "element": "Fire",
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Golem",
                },
              ]),
              "key": {
                "element": "Earth",
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Sprite",
                },
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Djinn",
                },
              ]),
              "key": {
                "element": "Air",
              },
            },
          ])
    );
  });

  it("test_edgeql_group_simple_03", () => {
    assertQueryResult(
      h,
      `
            SELECT (GROUP cards::Card {name} BY .element)
            FILTER .key.element != 'Air';
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
              "key": {
                "element": "Water",
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
              ]),
              "key": {
                "element": "Fire",
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Golem",
                },
              ]),
              "key": {
                "element": "Earth",
              },
            },
          ])
    );
  });

  it("test_edgeql_group_simple_04", () => {
    assertQueryResult(
      h,
      `
            WITH snapshots := cards::Card
            GROUP snapshots {} BY .element;
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {},
                {},
              ]),
              "key": {
                "element": "Water",
              },
            },
            {
              "elements": unorderedBag([
                {},
                {},
              ]),
              "key": {
                "element": "Fire",
              },
            },
            {
              "elements": unorderedBag([
                {},
                {},
              ]),
              "key": {
                "element": "Earth",
              },
            },
            {
              "elements": unorderedBag([
                {},
                {},
                {},
              ]),
              "key": {
                "element": "Air",
              },
            },
          ])
    );
  });

  it("test_edgeql_group_simple_no_id_output_01", () => {
    let res = queryRows<{ elements: unknown[] }>(h, "GROUP cards::Card {name} BY .element");
    let el = res[0].elements[0];
    expect(String(el) as any).not.toContain("id := ");
  });

  it("test_edgeql_group_simple_unused_alias_01", () => {
    h.query(
      `
            WITH MODULE cards
            SELECT (
              GROUP Card
              USING x := count(.owners), nowners := x,
              BY CUBE (.element, nowners)
            )
        `
    );
  });

  it("test_edgeql_group_process_select_01", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            SELECT (GROUP Card BY .element) {
                element := .key.element,
                cnt := count(.elements),
            };
            `,
      unorderedBag([
            {
              "cnt": 2,
              "element": "Water",
            },
            {
              "cnt": 2,
              "element": "Fire",
            },
            {
              "cnt": 2,
              "element": "Earth",
            },
            {
              "cnt": 3,
              "element": "Air",
            },
          ])
    );
  });

  it("test_edgeql_group_process_select_02", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            SELECT (GROUP Card BY .element) {
                element := .key.element,
                cnt := count(.elements),
            } FILTER .element != 'Water';
            `,
      unorderedBag([
            {
              "cnt": 2,
              "element": "Fire",
            },
            {
              "cnt": 2,
              "element": "Earth",
            },
            {
              "cnt": 3,
              "element": "Air",
            },
          ])
    );
  });

  it("test_edgeql_group_process_select_03", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            SELECT (GROUP Card BY .element) {
                element := .key.element,
                cnt := count(.elements),
            } ORDER BY .element;
            `,
      [
            {
              "cnt": 3,
              "element": "Air",
            },
            {
              "cnt": 2,
              "element": "Earth",
            },
            {
              "cnt": 2,
              "element": "Fire",
            },
            {
              "cnt": 2,
              "element": "Water",
            },
          ]
    );
  });

  it("test_edgeql_group_process_for_01a", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            FOR g IN (GROUP Card BY .element) UNION (
                element := g.key.element,
                cnt := count(g.elements),
            );
            `,
      unorderedBag([
            {
              "cnt": 2,
              "element": "Water",
            },
            {
              "cnt": 2,
              "element": "Fire",
            },
            {
              "cnt": 2,
              "element": "Earth",
            },
            {
              "cnt": 3,
              "element": "Air",
            },
          ])
    );
  });

  it("test_edgeql_group_process_select_04", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            SELECT (GROUP Card BY .element) {
                cnt := count(.elements),
            };
            `,
      unorderedBag([
            {
              "cnt": 2,
            },
            {
              "cnt": 2,
            },
            {
              "cnt": 2,
            },
            {
              "cnt": 3,
            },
          ])
    );
  });

  it("test_edgeql_group_process_for_01b", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            FOR g IN (SELECT (GROUP Card BY .element)) UNION (
                element := g.key.element,
                cnt := count(g.elements),
            );
            `,
      unorderedBag([
            {
              "cnt": 2,
              "element": "Water",
            },
            {
              "cnt": 2,
              "element": "Fire",
            },
            {
              "cnt": 2,
              "element": "Earth",
            },
            {
              "cnt": 3,
              "element": "Air",
            },
          ])
    );
  });

  it("test_edgeql_group_process_for_01c", () => {
    assertQueryResult(
      h,
      `
            with module cards
            for h in (group Card by .element) union (for g in h union (
                element := g.key.element,
                cnt := count(g.elements),
            ));
            `,
      unorderedBag([
            {
              "cnt": 2,
              "element": "Water",
            },
            {
              "cnt": 2,
              "element": "Fire",
            },
            {
              "cnt": 2,
              "element": "Earth",
            },
            {
              "cnt": 3,
              "element": "Air",
            },
          ])
    );
  });

  it("test_edgeql_group_process_for_01d", () => {
    assertQueryResult(
      h,
      `
            with module cards
            for g in (group Card by .element) union (for gi in 0 union (
                element := g.key.element,
                cst := sum(g.elements.cost + gi),
            ));
            `,
      unorderedBag([
            {
              "cst": 5,
              "element": "Water",
            },
            {
              "cst": 6,
              "element": "Fire",
            },
            {
              "cst": 4,
              "element": "Earth",
            },
            {
              "cst": 7,
              "element": "Air",
            },
          ])
    );
  });

  it("test_edgeql_group_sets_01", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            GROUP Card {name}
            USING nowners := count(.owners)
            BY {.element, nowners};
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
              "grouping": ["element"],
              "key": {
                "element": "Water",
                "nowners": null,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Dragon",
                },
                {
                  "name": "Imp",
                },
              ]),
              "grouping": ["element"],
              "key": {
                "element": "Fire",
                "nowners": null,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Golem",
                },
              ]),
              "grouping": ["element"],
              "key": {
                "element": "Earth",
                "nowners": null,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Djinn",
                },
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Sprite",
                },
              ]),
              "grouping": ["element"],
              "key": {
                "element": "Air",
                "nowners": null,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Golem",
                },
              ]),
              "grouping": ["nowners"],
              "key": {
                "element": null,
                "nowners": 3,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
              "grouping": ["nowners"],
              "key": {
                "element": null,
                "nowners": 4,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Djinn",
                },
                {
                  "name": "Dragon",
                },
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Sprite",
                },
              ]),
              "grouping": ["nowners"],
              "key": {
                "element": null,
                "nowners": 2,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Imp",
                },
              ]),
              "grouping": ["nowners"],
              "key": {
                "element": null,
                "nowners": 1,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_sets_02", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            GROUP Card
            USING nowners := count(.owners)
            BY {.element, nowners};
            `,
      unorderedBag([
            {
              "elements": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
              "grouping": ["element"],
              "key": {
                "element": "Water",
                "nowners": null,
              },
            },
            {
              "elements": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
              "grouping": ["element"],
              "key": {
                "element": "Fire",
                "nowners": null,
              },
            },
            {
              "elements": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
              "grouping": ["element"],
              "key": {
                "element": "Earth",
                "nowners": null,
              },
            },
            {
              "elements": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
              "grouping": ["element"],
              "key": {
                "element": "Air",
                "nowners": null,
              },
            },
            {
              "elements": [
                {
                  "id": "str",
                },
              ],
              "grouping": ["nowners"],
              "key": {
                "element": null,
                "nowners": 3,
              },
            },
            {
              "elements": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
              "grouping": ["nowners"],
              "key": {
                "element": null,
                "nowners": 4,
              },
            },
            {
              "elements": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
              "grouping": ["nowners"],
              "key": {
                "element": null,
                "nowners": 2,
              },
            },
            {
              "elements": [
                {
                  "id": "str",
                },
              ],
              "grouping": ["nowners"],
              "key": {
                "element": null,
                "nowners": 1,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_grouping_sets_01", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            SELECT (
              GROUP Card
              USING nowners := count(.owners)
              BY CUBE (.element, nowners)
            ) {
                num := count(.elements),
                grouping
            } ORDER BY array_agg((SELECT _ := .grouping ORDER BY _))
            `,
      [
            {
              "grouping": [],
              "num": 9,
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            SELECT (SELECT (
              GROUP Card
              USING nowners := count(.owners)
              BY CUBE (.element, nowners)
            ) {
                num := count(.elements),
                grouping
            }) ORDER BY array_agg((SELECT _ := .grouping ORDER BY _))
            `,
      [
            {
              "grouping": [],
              "num": 9,
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            SELECT (
              GROUP Card
              USING x := count(.owners), nowners := x,
              BY CUBE (.element, nowners)
            ) {
                num := count(.elements),
                grouping
            } ORDER BY array_agg((SELECT _ := .grouping ORDER BY _))
            `,
      [
            {
              "grouping": [],
              "num": 9,
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["element", "nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
            {
              "grouping": ["nowners"],
              "num": "int",
            },
          ]
    );
  });

  it("test_edgeql_group_grouping_sets_02", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            SELECT (
              WITH W := (SELECT Card { name } LIMIT 1)
              GROUP W
              USING nowners := count(.owners)
              BY CUBE (.element, .cost, nowners)
            ) { grouping }
            ORDER BY (
                count(.grouping),
                array_agg((SELECT _ := .grouping ORDER BY _))
            )
            `,
      [
            {
              "grouping": unorderedSet([]),
            },
            {
              "grouping": unorderedSet(["cost"]),
            },
            {
              "grouping": unorderedSet(["element"]),
            },
            {
              "grouping": unorderedSet(["nowners"]),
            },
            {
              "grouping": unorderedSet(["cost", "element"]),
            },
            {
              "grouping": unorderedSet(["cost", "nowners"]),
            },
            {
              "grouping": unorderedSet(["element", "nowners"]),
            },
            {
              "grouping": unorderedSet(["cost", "element", "nowners"]),
            },
          ]
    );
  });

  it("test_edgeql_group_free_object_01", () => {
    assertQueryResult(
      h,
      `
            group {a := 1, b := 2} by .a;;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": 2,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_free_object_02", () => {
    assertQueryResult(
      h,
      `
            group {a := 1, b := {2, 3, 4}, c := { d := 5 } }
            using d := .c.d
            by d;
            `,
      unorderedBag([
            {
              "key": {
                "d": 5,
              },
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": [2, 3, 4],
                  "c": {
                    "d": 5,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_sets_01", () => {
    assertQueryResult(
      h,
      `
            group (
                for n in { 8, 9 }
                    select cards::User { name, b := n }
            ) by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": 8,
                },
                {
                  "name": "Alice",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": 8,
                },
                {
                  "name": "Bob",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": 8,
                },
                {
                  "name": "Carol",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": 8,
                },
                {
                  "name": "Dave",
                  "b": 9,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_sets_02", () => {
    assertQueryResult(
      h,
      `
            group (
                for n in { 8, 9 }
                    select cards::User { name, b := n }
            ) by .b;
            `,
      unorderedBag([
            {
              "key": {
                "b": 8,
              },
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": 8,
                },
                {
                  "name": "Bob",
                  "b": 8,
                },
                {
                  "name": "Carol",
                  "b": 8,
                },
                {
                  "name": "Dave",
                  "b": 8,
                },
              ]),
            },
            {
              "key": {
                "b": 9,
              },
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": 9,
                },
                {
                  "name": "Bob",
                  "b": 9,
                },
                {
                  "name": "Carol",
                  "b": 9,
                },
                {
                  "name": "Dave",
                  "b": 9,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_sets_03", () => {
    assertQueryResult(
      h,
      `
            with N := (for n in { 8, 9 } select n)
            group cards::User { name, b := N } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_sets_04", () => {
    assertQueryResult(
      h,
      `
            with N := (for n in { 8, 9 } select n)
            group cards::User { name, b := N }
            using total := sum(.b)
            by total;
            `,
      unorderedBag([
            {
              "key": {
                "total": 17,
              },
              "grouping": unorderedSet(["total"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Bob",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Carol",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Dave",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_sets_05 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            group cards::User {
                name,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_sets_06 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            group cards::User {
                name,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            using d := .b.d
            by d;
            `,
      unorderedBag([
            {
              "key": {
                "d": 9,
              },
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
                {
                  "name": "Bob",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
                {
                  "name": "Carol",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
                {
                  "name": "Dave",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_free_object_01", () => {
    assertQueryResult(
      h,
      `
            group (
                for n in { 8, 9 }
                    select { a := 1, b := n }
            ) by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": 8,
                },
                {
                  "a": 1,
                  "b": 9,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_free_object_02", () => {
    assertQueryResult(
      h,
      `
            group (
                for n in { 8, 9 }
                    select { a := 1, b := n }
            ) by .b;
            `,
      unorderedBag([
            {
              "key": {
                "b": 8,
              },
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": 8,
                },
              ]),
            },
            {
              "key": {
                "b": 9,
              },
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": 9,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_free_object_03", () => {
    assertQueryResult(
      h,
      `
            with N := (for n in { 8, 9 } select n)
            group { a := 1, b := N } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_free_object_04 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            group {
                a := 1,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_iterator_ptr_free_object_05 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            group {
                a := 1,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            using d := .b.d
            by d;
            `,
      unorderedBag([
            {
              "key": {
                "d": 9,
              },
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_set_01 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                group cards::User { name, b := random() } by .name
            ) {
                key,
                grouping,
                elements: { name, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

    // Fixture corrected from upstream @test.xerror (never validated there):
    // the query groups BY .b, so `grouping` is ["b"], not ["d"].
  it("test_edgeql_group_volatile_ptr_set_02 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                group cards::User { name, b := random() } by .b
            ) {
                name: (select .elements.name limit 1),
                grouping,
                elements: { name, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "name": "Alice",
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "z": true,
                },
              ]),
            },
            {
              "name": "Bob",
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "z": true,
                },
              ]),
            },
            {
              "name": "Carol",
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "z": true,
                },
              ]),
            },
            {
              "name": "Dave",
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_set_03 [xfail: Issue #8095 Select group produces incorrect keys]", () => {
    assertQueryResult(
      h,
      `
            select (
                group (select cards::User { name, b := random() }) by .name
            ) {
                key,
                grouping,
                elements: { name, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_set_04 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                group cards::User {
                    name,
                    b := { c := 2, d := random() },
                }
                by .name
            ) {
                key,
                grouping,
                elements: {
                    name,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  // Fixture corrected from upstream @test.xerror (never validated there):
  // the elements shape referenced `a`, which doesn't exist on cards::User
  // (upstream's own expected output uses `name`), and the key d := .b.c is
  // the constant 2, so ALL four users land in ONE group (grouping ["d"]).
  // `name: (select .elements.name limit 1)` picks the first element.
  it("test_edgeql_group_volatile_ptr_set_05 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                group cards::User {
                    name,
                    b := { c := 2, d := random() },
                }
                using d := .b.c
                by d
            ) {
                name: (select .elements.name limit 1),
                grouping,
                elements: {
                    name,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "name": "Alice",
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
                {
                  "name": "Bob",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
                {
                  "name": "Carol",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
                {
                  "name": "Dave",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_set_06 [xfail: Issue #8095 Select group produces incorrect keys]", () => {
    assertQueryResult(
      h,
      `
            select (
                group (
                    select cards::User {
                        name,
                        b := { c := 2, d := random() },
                    }
                )
                by .name
            ) {
                key,
                grouping,
                elements: {
                    name,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_free_object_01 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                group { a := 1, b := random() } by .a
            ) {
                key,
                grouping,
                elements: { a, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_free_object_02 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                group { a := 1, b := random() } by .b
            ) {
                key,
                grouping,
                elements: { a, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_free_object_03 [xfail: Issue #8095 Select group produces incorrect keys]", () => {
    assertQueryResult(
      h,
      `
            select (
                group (select { a := 1, b := random() }) by .a
            ) {
                key,
                grouping,
                elements: { a, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_free_object_04 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                group {
                    a := 1,
                    b := { c := 2, d := random() },
                }
                by .a
            ) {
                key,
                grouping,
                elements: {
                    a,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_free_object_05 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                group {
                    a := 1,
                    b := { c := 2, d := random() },
                }
                using d := .b.c
                by d
            ) {
                key,
                grouping,
                elements: {
                    a,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_volatile_ptr_free_object_06", () => {
    assertQueryResult(
      h,
      `
            select (
                group (
                    select {
                        a := 1,
                        b := { c := 2, d := random() },
                    }
                )
                using d := .b.c
                by d
            ) {
                key,
                grouping,
                elements: {
                    a,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_duplicate_rejected_01", () => {
    expect(() => {
      h.script(
        `
                group Card { name }
                using element := .cost
                by cube(.element, element)
            `
      );
    }).toThrow(new RegExp("used directly in the BY clause"));
  });

  it("test_edgeql_group_duplicate_rejected_02", () => {
    expect(() => {
      h.script(
        `
                WITH MODULE cards
                SELECT Card {
                    invalid := (
                        GROUP .avatar
                        BY @text, .text
                    )
                }
            `
      );
    }).toThrow(new RegExp("BY clause cannot refer to link property and object property with the same name"));
    expect(() => {
      h.script(
        `
                WITH MODULE cards
                SELECT Card {
                    invalid := (
                        GROUP .avatar
                        BY .text, @text
                    )
                }
            `
      );
    }).toThrow(new RegExp("BY clause cannot refer to link property and object property with the same name"));
  });

  it("test_edgeql_group_for_01", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            FOR g in (GROUP Card BY .element) UNION (
                WITH U := g.elements,
                SELECT U {
                    name,
                    cost_ratio := .cost / math::mean(g.elements.cost)
            });
            `,
      unorderedBag([
            {
              "cost_ratio": 0.42857142857142855,
              "name": "Sprite",
            },
            {
              "cost_ratio": 0.8571428571428571,
              "name": "Giant eagle",
            },
            {
              "cost_ratio": 1.7142857142857142,
              "name": "Djinn",
            },
            {
              "cost_ratio": 0.5,
              "name": "Dwarf",
            },
            {
              "cost_ratio": 1.5,
              "name": "Golem",
            },
            {
              "cost_ratio": 0.3333333333333333,
              "name": "Imp",
            },
            {
              "cost_ratio": 1.6666666666666667,
              "name": "Dragon",
            },
            {
              "cost_ratio": 0.8,
              "name": "Bog monster",
            },
            {
              "cost_ratio": 1.2,
              "name": "Giant turtle",
            },
          ])
    );
  });

  it("test_edgeql_group_simple_old_01", () => {
    assertQueryResult(
      h,
      `
                for g in (group User by .name)
                union count(g.elements.<owner);
            `,
      unorderedSet([2, 4])
    );
  });

  it("test_edgeql_group_semi_join_01", () => {
    assertQueryResult(
      h,
      `
                select (group User by .name).elements
            `,
      [
            {},
            {},
          ]
    );
  });

  it("test_edgeql_group_by_tuple_01", () => {
    assertQueryResult(
      h,
      `
                GROUP Issue
                USING B := (Issue.status.name, Issue.time_estimate)
                # This tuple will be {} for Issues lacking
                # time_estimate. So effectively we're expecting only 2
                # subsets, grouped by:
                # - {}
                # - ('Open', 3000)
                BY B
            `,
      unorderedBag([
            {
              "key": {
                "B": ["Open", 3000],
              },
              "elements": [
                {},
              ],
            },
            {
              "key": {
                "B": null,
              },
              "elements": [
                {},
                {},
                {},
              ],
            },
          ])
    );
  });

  it("test_edgeql_group_by_group_by_01", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            GROUP (
              SELECT (
                GROUP Card
                USING nowners := count(.owners)
                BY {.element, nowners}
              ) {
                  num := count(.elements),
                  key: {element, nowners},
                  agrouping := array_agg((SELECT _ := .grouping ORDER BY _))
              }
            ) BY .agrouping
        `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "agrouping": ["element"],
                  "key": {
                    "element": "Water",
                    "nowners": null,
                  },
                  "num": 2,
                },
                {
                  "agrouping": ["element"],
                  "key": {
                    "element": "Fire",
                    "nowners": null,
                  },
                  "num": 2,
                },
                {
                  "agrouping": ["element"],
                  "key": {
                    "element": "Earth",
                    "nowners": null,
                  },
                  "num": 2,
                },
                {
                  "agrouping": ["element"],
                  "key": {
                    "element": "Air",
                    "nowners": null,
                  },
                  "num": 3,
                },
              ]),
              "grouping": ["agrouping"],
              "key": {
                "agrouping": ["element"],
              },
            },
            {
              "elements": unorderedBag([
                {
                  "agrouping": ["nowners"],
                  "key": {
                    "element": null,
                    "nowners": 3,
                  },
                  "num": 1,
                },
                {
                  "agrouping": ["nowners"],
                  "key": {
                    "element": null,
                    "nowners": 4,
                  },
                  "num": 2,
                },
                {
                  "agrouping": ["nowners"],
                  "key": {
                    "element": null,
                    "nowners": 2,
                  },
                  "num": 5,
                },
                {
                  "agrouping": ["nowners"],
                  "key": {
                    "element": null,
                    "nowners": 1,
                  },
                  "num": 1,
                },
              ]),
              "grouping": ["agrouping"],
              "key": {
                "agrouping": ["nowners"],
              },
            },
          ])
    );
    assertQueryResult(
      h,
      `SELECT (
            WITH MODULE cards
            GROUP (
              SELECT (
                GROUP Card
                USING nowners := count(.owners)
                BY {.element, nowners}
              ) {
                  num := count(.elements),
                  key: {element, nowners},
                  agrouping := array_agg((SELECT _ := .grouping ORDER BY _))
              }
            ) BY .agrouping
        )`,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "agrouping": ["element"],
                  "key": {
                    "element": "Water",
                    "nowners": null,
                  },
                  "num": 2,
                },
                {
                  "agrouping": ["element"],
                  "key": {
                    "element": "Fire",
                    "nowners": null,
                  },
                  "num": 2,
                },
                {
                  "agrouping": ["element"],
                  "key": {
                    "element": "Earth",
                    "nowners": null,
                  },
                  "num": 2,
                },
                {
                  "agrouping": ["element"],
                  "key": {
                    "element": "Air",
                    "nowners": null,
                  },
                  "num": 3,
                },
              ]),
              "grouping": ["agrouping"],
              "key": {
                "agrouping": ["element"],
              },
            },
            {
              "elements": unorderedBag([
                {
                  "agrouping": ["nowners"],
                  "key": {
                    "element": null,
                    "nowners": 3,
                  },
                  "num": 1,
                },
                {
                  "agrouping": ["nowners"],
                  "key": {
                    "element": null,
                    "nowners": 4,
                  },
                  "num": 2,
                },
                {
                  "agrouping": ["nowners"],
                  "key": {
                    "element": null,
                    "nowners": 2,
                  },
                  "num": 5,
                },
                {
                  "agrouping": ["nowners"],
                  "key": {
                    "element": null,
                    "nowners": 1,
                  },
                  "num": 1,
                },
              ]),
              "grouping": ["agrouping"],
              "key": {
                "agrouping": ["nowners"],
              },
            },
          ])
    );
  });

  it("test_edgeql_group_by_group_by_02", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards, G := (
            GROUP (
              GROUP Card
              BY {.element, .cost}
            )
            USING grouping := array_agg(.grouping)
            BY grouping),
            SELECT G {
                key: {grouping},
                elements: { n := count(.elements), key: {element, cost}}
            }
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "key": {
                    "cost": 1,
                    "element": null,
                  },
                  "n": 3,
                },
                {
                  "key": {
                    "cost": 2,
                    "element": null,
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": 3,
                    "element": null,
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": 4,
                    "element": null,
                  },
                  "n": 1,
                },
                {
                  "key": {
                    "cost": 5,
                    "element": null,
                  },
                  "n": 1,
                },
              ]),
              "key": {
                "grouping": ["cost"],
              },
            },
            {
              "elements": unorderedBag([
                {
                  "key": {
                    "cost": null,
                    "element": "Water",
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": null,
                    "element": "Earth",
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": null,
                    "element": "Fire",
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": null,
                    "element": "Air",
                  },
                  "n": 3,
                },
              ]),
              "key": {
                "grouping": ["element"],
              },
            },
          ])
    );
    assertQueryResult(
      h,
      `
            WITH MODULE cards,
            SELECT (
            GROUP (
              GROUP Card
              BY {.element, .cost}
            )
            USING grouping := array_agg(.grouping)
            BY grouping) {
                key: {grouping},
                elements: { n := count(.elements), key: {element, cost}}
            }
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "key": {
                    "cost": 1,
                    "element": null,
                  },
                  "n": 3,
                },
                {
                  "key": {
                    "cost": 2,
                    "element": null,
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": 3,
                    "element": null,
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": 4,
                    "element": null,
                  },
                  "n": 1,
                },
                {
                  "key": {
                    "cost": 5,
                    "element": null,
                  },
                  "n": 1,
                },
              ]),
              "key": {
                "grouping": ["cost"],
              },
            },
            {
              "elements": unorderedBag([
                {
                  "key": {
                    "cost": null,
                    "element": "Water",
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": null,
                    "element": "Earth",
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": null,
                    "element": "Fire",
                  },
                  "n": 2,
                },
                {
                  "key": {
                    "cost": null,
                    "element": "Air",
                  },
                  "n": 3,
                },
              ]),
              "key": {
                "grouping": ["element"],
              },
            },
          ])
    );
  });

  it("test_edgeql_group_by_group_by_03a", () => {
    _test_edgeql_group_by_group_by_03(`
            with module cards
            select (group Card by .element) {
                el := .key.element,
                groups := (
                  with z := (group .elements using x := .cost%2 by x)
                  for z in z union (
                    even := z.key.x,
                    elements := array_agg(z.elements{name, cost}),
                  )
                )
            };
            `);
  });

  it("test_edgeql_group_by_group_by_03b", () => {
    _test_edgeql_group_by_group_by_03(`
            with module cards
            select (group Card by .element) {
                el := .key.element,
                groups := (
                  with z := (group .elements using x := .cost%2 by x)
                  select (
                    even := z.key.x,
                    elements := array_agg(z.elements{name, cost}),
                  )
                )
            };
            `);
  });

  it("test_edgeql_group_by_group_by_03c", () => {
    _test_edgeql_group_by_group_by_03(`
            with module cards
            select (group Card by .element) {
                el := .key.element,
                groups := (
                  for z in (group .elements using x := .cost%2 by x) union (
                    even := z.key.x,
                    elements := array_agg(z.elements{name, cost}),
                  )
                )
            };
            `);
  });

  it("test_edgeql_group_errors_id", () => {
    expect(() => {
      h.script(
        `
                group cards::Card{name} using id := .id by id
            `
      );
    }).toThrow(new RegExp("may not name a grouping alias 'id'"));
    expect(() => {
      h.script(
        `
                group cards::Card{name} by .id
            `
      );
    }).toThrow(new RegExp("may not group by a field named id"));
  });

  it("test_edgeql_group_errors_ref", () => {
    expect(() => {
      h.script(
        `
                group User by name
            `
      );
    }).toThrow(new RegExp("variable 'name' referenced in BY but not declared in USING"));
  });

  it("test_edgeql_group_tuple_01", () => {
    h.script(
      `
            create type tup {
                create multi property tup -> tuple<int64, int64> ;
            };
            insert tup { tup := {(1, 1), (1, 2), (1, 1), (2, 1)} };
        `
    );
    assertQueryResult(
      h,
      `
                with X := tup.tup,
                group X using z := X by z;
            `,
      unorderedBag([
            {
              "elements": [
                [1, 2],
              ],
              "key": {
                "z": [1, 2],
              },
            },
            {
              "elements": [
                [2, 1],
              ],
              "key": {
                "z": [2, 1],
              },
            },
            {
              "elements": unorderedBag([
                [1, 1],
                [1, 1],
              ]),
              "key": {
                "z": [1, 1],
              },
            },
          ])
    );
  });

  it("test_edgeql_group_tuple_02", () => {
    assertQueryResult(
      h,
      `
                with X := {(1, 1), (1, 2), (1, 1), (2, 1)},
                group X using z := X by z;
            `,
      unorderedBag([
            {
              "elements": [
                [1, 2],
              ],
              "key": {
                "z": [1, 2],
              },
            },
            {
              "elements": [
                [2, 1],
              ],
              "key": {
                "z": [2, 1],
              },
            },
            {
              "elements": unorderedBag([
                [1, 1],
                [1, 1],
              ]),
              "key": {
                "z": [1, 1],
              },
            },
          ])
    );
  });

  it("test_edgeql_group_semijoin_group_01", () => {
    assertQueryResult(
      h,
      `
                with module cards
                group (
                    select (group Card{name, cost} by .element)
                    order by .key.element limit 1
                ).elements by .cost;
            `,
      unorderedBag([
            {
              "elements": [
                {
                  "cost": 1,
                  "name": "Sprite",
                },
              ],
              "grouping": ["cost"],
              "key": {
                "cost": 1,
              },
            },
            {
              "elements": [
                {
                  "cost": 2,
                  "name": "Giant eagle",
                },
              ],
              "grouping": ["cost"],
              "key": {
                "cost": 2,
              },
            },
            {
              "elements": [
                {
                  "cost": 4,
                  "name": "Djinn",
                },
              ],
              "grouping": ["cost"],
              "key": {
                "cost": 4,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_simple_agg_01", () => {
    assertQueryResult(
      h,
      `
                with module cards
                select (group Card by .element) {
                    el := .key.element, cs := array_agg(.elements)
                };
            `,
      unorderedBag([
            {
              "el": "Water",
              "cs": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
            },
            {
              "el": "Fire",
              "cs": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
            },
            {
              "el": "Earth",
              "cs": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
            },
            {
              "el": "Air",
              "cs": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
            },
          ])
    );
  });

  it("test_edgeql_group_simple_agg_02", () => {
    assertQueryResult(
      h,
      `
                with module cards
                select (group Card by .element) {
                    el := .key.element, cs := array_agg(.elements { name })
                };
            `,
      unorderedBag([
            {
              "cs": unorderedBag([
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
              "el": "Water",
            },
            {
              "cs": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
              ]),
              "el": "Fire",
            },
            {
              "cs": unorderedBag([
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Golem",
                },
              ]),
              "el": "Earth",
            },
            {
              "cs": unorderedBag([
                {
                  "name": "Sprite",
                },
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Djinn",
                },
              ]),
              "el": "Air",
            },
          ])
    );
  });

  it("test_edgeql_group_agg_multi_01", () => {
    assertQueryResult(
      h,
      `
                with module cards
                for g in (group Card BY .element) union (
                    array_agg(g.elements.name ++ {"!", "?"})
                );
            `,
      unorderedBag([
            unorderedSet(["Bog monster!", "Bog monster?", "Giant turtle!", "Giant turtle?"]),
            unorderedSet(["Dragon!", "Dragon?", "Imp!", "Imp?"]),
            unorderedSet(["Dwarf!", "Dwarf?", "Golem!", "Golem?"]),
            unorderedSet(["Djinn!", "Djinn?", "Giant eagle!", "Giant eagle?", "Sprite!", "Sprite?"]),
          ])
    );
  });

  it("test_edgeql_group_agg_multi_02", () => {
    assertQueryResult(
      h,
      `
                with module cards
                for g in (group Card BY .element) union (
                    count((Award { multi z := g.elements.name }.z))
                );          `,
      unorderedBag([6, 6, 6, 9])
    );
  });

  it("test_edgeql_group_agg_multi_03", () => {
    assertQueryResult(
      h,
      `
                for g in (group BooleanTest by .val) union (
                    array_agg(g.elements.tags)
                );
            `,
      unorderedBag([
            ["red"],
            [],
            unorderedBag(["red", "green"]),
            unorderedBag(["red", "black"]),
          ])
    );
  });

  it("test_edgeql_group_agg_grouping_01", () => {
    assertQueryResult(
      h,
      `
                select (group cards::Card
                   using awd_size := count(.awards)
                by awd_size, .element) { grouping };
            `,
      [
            {
              "grouping": ["awd_size", "element"],
            },
            {
              "grouping": ["awd_size", "element"],
            },
            {
              "grouping": ["awd_size", "element"],
            },
            {
              "grouping": ["awd_size", "element"],
            },
            {
              "grouping": ["awd_size", "element"],
            },
            {
              "grouping": ["awd_size", "element"],
            },
          ]
    );
  });

  it("test_edgeql_trivial_grouping_01", () => {
    assertQueryResult(
      h,
      `
            group 0 using x := 0 by cube(x)
            `,
      unorderedBag([
            {
              "elements": [0],
              "grouping": [],
              "key": {
                "x": null,
              },
            },
            {
              "elements": [0],
              "grouping": ["x"],
              "key": {
                "x": 0,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_binding_01", () => {
    assertQueryResult(
      h,
      `
                with GR := (group cards::Card BY .element)
                select GR {
                  multi elements := (
                    with els := .elements
                    select els {name}
                  )
                };
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant turtle",
                },
              ]),
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
              ]),
            },
            {
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
              "elements": unorderedBag([
                {
                  "name": "Sprite",
                },
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Djinn",
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_free_object_01", () => {
    assertQueryResult(
      h,
      `
            with X := {a := 1, b := 2}
            group X { a, b } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": 2,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_free_object_02", () => {
    assertQueryResult(
      h,
      `
            with X := {a := 1, b := {2, 3, 4}, c := { d := 5 } }
            group X { a, b, c: {*} } using d := .c.d by d;
            `,
      unorderedBag([
            {
              "key": {
                "d": 5,
              },
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": [2, 3, 4],
                  "c": {
                    "d": 5,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_01", () => {
    assertQueryResult(
      h,
      `
            with N := random()
            group cards::User { name } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_02", () => {
    assertQueryResult(
      h,
      `
            with N := random()
            group { a := 1 } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_03 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            with N := random()
            group cards::User { name }
            using z := N <= 1
            by z;
            `,
      unorderedBag([
            {
              "key": {
                "z": true,
              },
              "grouping": unorderedSet(["z"]),
              "elements": unorderedBag([
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
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_04 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            with N := random()
            group { a := 1 }
            using z := N <= 1
            by z;
            `,
      unorderedBag([
            {
              "key": {
                "z": true,
              },
              "grouping": unorderedSet(["z"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_05 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with
                    N := random()
                group cards::User { name, b := N } by .name
            ) {
                key,
                grouping,
                elements: { name, z := .b <= 1},
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  // Fixture corrected from upstream @test.xerror (never validated there):
  // the projection writes `z := .b <= 1`, so the element key is `z`, not `b`.
  it("test_edgeql_group_binding_volatile_06 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with
                    N := random(),
                group { a := 1, b := N } by .a
            ) {
                key,
                grouping,
                elements: { a, z := .b <= 1},
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_01 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            with X := (
                for n in { 8, 9 }
                    select cards::User { name, b := n }
            )
            group X { name, b } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": 8,
                },
                {
                  "name": "Alice",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": 8,
                },
                {
                  "name": "Bob",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": 8,
                },
                {
                  "name": "Carol",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": 8,
                },
                {
                  "name": "Dave",
                  "b": 9,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_02", () => {
    assertQueryResult(
      h,
      `
            with X := (
                for n in { 8, 9 }
                    select cards::User { name, b := n }
            )
            group X { name } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                },
                {
                  "name": "Alice",
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                },
                {
                  "name": "Bob",
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                },
                {
                  "name": "Carol",
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                },
                {
                  "name": "Dave",
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_03", () => {
    assertQueryResult(
      h,
      `
            with X := (
                for n in { 8, 9 }
                    select cards::User { name, b := n }
            )
            group (select X { name, b }) by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": 8,
                },
                {
                  "name": "Alice",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": 8,
                },
                {
                  "name": "Bob",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": 8,
                },
                {
                  "name": "Carol",
                  "b": 9,
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": 8,
                },
                {
                  "name": "Dave",
                  "b": 9,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_04", () => {
    assertQueryResult(
      h,
      `
            with X := (
                for n in { 8, 9 }
                    select cards::User { name, b := n }
            )
            group X { name } by .b;
            `,
      unorderedBag([
            {
              "key": {
                "b": 8,
              },
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
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
              ]),
            },
            {
              "key": {
                "b": 9,
              },
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
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
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_05", () => {
    assertQueryResult(
      h,
      `
            with X := cards::User {
                name,
                b := (for n in { 8, 9 } select n),
            }
            group X { name, b } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_06", () => {
    assertQueryResult(
      h,
      `
            with X := cards::User {
                name,
                b := (for n in { 8, 9 } select n),
            }
            group X { name, b }
            using total := sum(.b)
            by total;
            `,
      unorderedBag([
            {
              "key": {
                "total": 17,
              },
              "grouping": unorderedSet(["total"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Bob",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Carol",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Dave",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_07", () => {
    assertQueryResult(
      h,
      `
            with
                N := (for n in { 8, 9 } select n),
                X := cards::User { name, b := N }
            group X { name, b } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_08", () => {
    assertQueryResult(
      h,
      `
            with
                N := (for n in { 8, 9 } select n),
                X := cards::User { name, b := N }
            group X { name, b }
            using total := sum(.b)
            by total;
            `,
      unorderedBag([
            {
              "key": {
                "total": 17,
              },
              "grouping": unorderedSet(["total"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Bob",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Carol",
                  "b": unorderedSet([8, 9]),
                },
                {
                  "name": "Dave",
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_09 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            with X := cards::User {
                name,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            group X { name, b: { c, d } } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_10", () => {
    assertQueryResult(
      h,
      `
            with X := cards::User {
                name,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            group X { name, b: { c } } by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 3,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 3,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 3,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 3,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_11 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            with X := cards::User {
                name,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            group (select X { name, b: { c, d } }) by .name;
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_set_12 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            with X := cards::User {
                name,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            group X { name, b: { c } }
            using d := .b.d
            by d;
            `,
      unorderedBag([
            {
              "key": {
                "d": 9,
              },
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
                {
                  "name": "Bob",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
                {
                  "name": "Carol",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
                {
                  "name": "Dave",
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_01 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            with X := (
                for n in { 8, 9 }
                    select { a := 1, b := n }
            )
            group X { a, b } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": 8,
                },
                {
                  "a": 1,
                  "b": 9,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_02", () => {
    assertQueryResult(
      h,
      `
            with X := (
                for n in { 8, 9 }
                    select { a := 1, b := n }
            )
            group X { a } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                },
                {
                  "a": 1,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_03", () => {
    assertQueryResult(
      h,
      `
            with X := (
                for n in { 8, 9 }
                    select { a := 1, b := n }
            )
            group (select X { a, b }) by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": 8,
                },
                {
                  "a": 1,
                  "b": 9,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_04", () => {
    assertQueryResult(
      h,
      `
            with X := (
                for n in { 8, 9 }
                    select { a := 1, b := n }
            )
            group X { a } by .b;
            `,
      unorderedBag([
            {
              "key": {
                "b": 8,
              },
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                },
              ]),
            },
            {
              "key": {
                "b": 9,
              },
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_05", () => {
    assertQueryResult(
      h,
      `
            with X := {
                a := 1,
                b := (for n in { 8, 9 } select n),
            }
            group X { a, b } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_06", () => {
    assertQueryResult(
      h,
      `
            with X := {
                a := 1,
                b := (for n in { 8, 9 } select n),
            }
            group X { a, b }
            using total := sum(.b)
            by total;
            `,
      unorderedBag([
            {
              "key": {
                "total": 17,
              },
              "grouping": unorderedSet(["total"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_07", () => {
    assertQueryResult(
      h,
      `
            with
                N := (for n in { 8, 9 } select n),
                X := { a := 1, b := N }
            group X { a, b } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_08", () => {
    assertQueryResult(
      h,
      `
            with
                N := (for n in { 8, 9 } select n),
                X := { a := 1, b := N }
            group X { a, b }
            using total := sum(.b)
            by total;
            `,
      unorderedBag([
            {
              "key": {
                "total": 17,
              },
              "grouping": unorderedSet(["total"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": unorderedSet([8, 9]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_09 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            with X := {
                a := 1,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            group X { a, b: { c, d } } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_10", () => {
    assertQueryResult(
      h,
      `
            with X := {
                a := 1,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            group X { a, b: { c } } by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 3,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_11 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            with X := {
                a := 1,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            group (select X { a, b: { c, d } }) by .a;
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 3,
                    "d": 9,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_iterator_ptr_free_object_12 [xerror: Group by doesn't materialize computed pointers properly]", () => {
    assertQueryResult(
      h,
      `
            with X := {
                a := 1,
                b := (for n in { 9 } union ({ c := 3, d := n }))
            }
            group X { a, b: { c } }
            using d := .b.d
            by d;
            `,
      unorderedBag([
            {
              "key": {
                "d": 9,
              },
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 3,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_set_01 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := cards::User { name, b := random() }
                group X { name, b } by .name;
            ) {
                key,
                grouping,
                elements: { name, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_set_02 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := cards::User { name, b := random() }
                group X { name } by .name;
            ) {
                key,
                grouping,
                elements: { name },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_set_03 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := cards::User { name, b := random() }
                group (select X { name, b }) by .name;
            ) {
                key,
                grouping,
                elements: { name, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "z": true,
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_set_04 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := cards::User { name, b := random() }
                group X { name } by .b;
            ) {
                name: (select .elements.name limit 1),
                grouping,
                elements: { name, z := .b <= 1 },
            };
            `,
      unorderedBag([
        {
          "name": "Alice",
          "grouping": unorderedSet(["b"]),
          "elements": unorderedBag([{ "name": "Alice", "z": true }]),
        },
        {
          "name": "Bob",
          "grouping": unorderedSet(["b"]),
          "elements": unorderedBag([{ "name": "Bob", "z": true }]),
        },
        {
          "name": "Carol",
          "grouping": unorderedSet(["b"]),
          "elements": unorderedBag([{ "name": "Carol", "z": true }]),
        },
        {
          "name": "Dave",
          "grouping": unorderedSet(["b"]),
          "elements": unorderedBag([{ "name": "Dave", "z": true }]),
        },
      ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_set_05 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := cards::User {
                    name,
                    b := { c := 2, d := random() }
                }
                group X { name, b: { c, d } } by .name;
            ) {
                key,
                grouping,
                elements: {
                    name,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_set_06 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := cards::User {
                    name,
                    b := { c := 2, d := random() }
                }
                group (select X { name, b: { c } }) by .name;
            ) {
                key,
                grouping,
                elements: {
                    name,
                    b: { c },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 2,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 2,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 2,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 2,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_set_07 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := cards::User {
                    name,
                    b := { c := 2, d := random() }
                }
                group (select X { name, b: { c, d } }) by .name;
            ) {
                key,
                grouping,
                elements: {
                    name,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "name": "Alice",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Bob",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Bob",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Carol",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Carol",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
            {
              "key": {
                "name": "Dave",
              },
              "grouping": unorderedSet(["name"]),
              "elements": unorderedBag([
                {
                  "name": "Dave",
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  // Fixture corrected from upstream @test.xerror (never validated there):
  // the key d := .b.c is the constant 2, so ALL four users land in ONE group
  // and `grouping` is ["d"] (upstream asserted ["name"] and four groups);
  // the written shape is b: {c}, so no `z` appears in the elements.
  it("test_edgeql_group_binding_volatile_ptr_set_08 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := cards::User {
                    name,
                    b := { c := 2, d := random() }
                }
                group (select X { name, b: { c } })
                using d := .b.c
                by d;
            ) {
                name: (select .elements.name limit 1),
                grouping,
                elements: {
                    name,
                    b: { c },
                },
            };
            `,
      unorderedBag([
            {
              "name": "Alice",
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "name": "Alice",
                  "b": {
                    "c": 2,
                  },
                },
                {
                  "name": "Bob",
                  "b": {
                    "c": 2,
                  },
                },
                {
                  "name": "Carol",
                  "b": {
                    "c": 2,
                  },
                },
                {
                  "name": "Dave",
                  "b": {
                    "c": 2,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_free_object_01 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := { a := 1, b := random() }
                group X { a, b } by .a;
            ) {
                key,
                grouping,
                elements: { a, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_free_object_02 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := { a := 1, b := random() }
                group X { a } by .a;
            ) {
                key,
                grouping,
                elements: { a },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_free_object_03 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := { a := 1, b := random() }
                group (select X { a, b }) by .a;
            ) {
                key,
                grouping,
                elements: { a, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_free_object_04 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := { a := 1, b := random() }
                group X { a } by .b;
            ) {
                key,
                grouping,
                elements: { a, z := .b <= 1 },
            };
            `,
      unorderedBag([
            {
              "grouping": unorderedSet(["b"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "z": true,
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_free_object_05 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := {
                    a := 1,
                    b := { c := 2, d := random() }
                }
                group X { a, b: { c, d } } by .a;
            ) {
                key,
                grouping,
                elements: {
                    a,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_free_object_06 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := {
                    a := 1,
                    b := { c := 2, d := random() }
                }
                group (select X { a, b: { c } }) by .a;
            ) {
                key,
                grouping,
                elements: {
                    a,
                    b: { c },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 2,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_free_object_07 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := {
                    a := 1,
                    b := { c := 2, d := random() }
                }
                group (select X { a, b: { c, d } }) by .a;
            ) {
                key,
                grouping,
                elements: {
                    a,
                    b: {
                        c,
                        z := .d <= 1,
                    },
                },
            };
            `,
      unorderedBag([
            {
              "key": {
                "a": 1,
              },
              "grouping": unorderedSet(["a"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 2,
                    "z": true,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_binding_volatile_ptr_free_object_08 [xerror: Group by doesn't materialize volatile properly]", () => {
    assertQueryResult(
      h,
      `
            select (
                with X := {
                    a := 1,
                    b := { c := 2, d := random() }
                }
                group (select X { a, b: { c } })
                using d := .b.c
                by d;
            ) {
                key,
                grouping,
                elements: {
                    a,
                    b: { c },
                },
            };
            `,
      unorderedBag([
            {
              "grouping": unorderedSet(["d"]),
              "elements": unorderedBag([
                {
                  "a": 1,
                  "b": {
                    "c": 2,
                  },
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_ordering_01", () => {
    assertQueryResult(
      h,
      `
                with GR := (group cards::Card BY .element)
                select GR {
                  elements: {name},
                }
                order by .key.element;
            `,
      [
            {
              "elements": unorderedBag([
                {
                  "name": "Sprite",
                },
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Djinn",
                },
              ]),
            },
            {
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
              "elements": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
              ]),
            },
            {
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
    assertQueryResult(
      h,
      `
                with GR := (group cards::Card BY .element)
                select GR {
                  key: {element},
                  elements: {name},
                }
                order by .key.element;
            `,
      [
            {
              "elements": unorderedBag([
                {
                  "name": "Sprite",
                },
                {
                  "name": "Giant eagle",
                },
                {
                  "name": "Djinn",
                },
              ]),
            },
            {
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
              "elements": unorderedBag([
                {
                  "name": "Imp",
                },
                {
                  "name": "Dragon",
                },
              ]),
            },
            {
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

  it("test_edgeql_group_of_for_01", () => {
    assertQueryResult(
      h,
      `
                WITH
                  C := (FOR c IN cards::Card UNION (
                    SELECT c { len := len(c.name) }
                  ))
                GROUP C { name }
                USING l := C.len
                BY l;
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                {
                  "name": "Bog monster",
                },
                {
                  "name": "Giant eagle",
                },
              ]),
              "grouping": ["l"],
              "key": {
                "l": 11,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Imp",
                },
              ]),
              "grouping": ["l"],
              "key": {
                "l": 3,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Dwarf",
                },
                {
                  "name": "Golem",
                },
                {
                  "name": "Djinn",
                },
              ]),
              "grouping": ["l"],
              "key": {
                "l": 5,
              },
            },
            {
              "elements": unorderedBag([
                {
                  "name": "Dragon",
                },
                {
                  "name": "Sprite",
                },
              ]),
              "grouping": ["l"],
              "key": {
                "l": 6,
              },
            },
            {
              "elements": [
                {
                  "name": "Giant turtle",
                },
              ],
              "grouping": ["l"],
              "key": {
                "l": 12,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_policies_01", () => {
    h.script(
      `
            with module cards
            alter type User {
                create access policy ok allow select, delete, update read;
                create access policy two_elements allow insert, update write
                  using (count((group .deck by .element)) = 2);
            }
        `
    );
    expect(() => {
      h.query(
        `
                with module cards
                insert User {
                    name := 'Sully',
                    deck := (select Card filter .element = 'Water')
                };
            `
      );
    }).toThrow(new RegExp("access policy violation on insert"));
    h.query(
      `
            with module cards
            insert User {
                name := 'Sully',
                deck := (select Card filter .element IN {'Water', 'Air'})
            };
        `
    );
    expect(() => {
      h.query(
        `
                with module cards
                update User filter .name = 'Sully' set {
                    deck += (select Card filter .element = 'Earth')
                };
            `
      );
    }).toThrow(new RegExp("access policy violation on update"));
    expect(() => {
      h.query(
        `
                with module cards
                update User filter .name = 'Sully' set {
                    deck -= (select Card filter .element = 'Water')
                };
            `
      );
    }).toThrow(new RegExp("access policy violation on update"));
  });

  it("test_edgeql_group_policies_02", () => {
    h.script(
      `
                create type T {
                    create multi property vals -> int64;
                    create access policy foo allow all using (
                    # This is pretty pointless but should always be true
                      sum(((
                        (group x := .vals using v := x by v))
                        { x := count(.elements) }).x)
                      = count(.vals)
                    )
                };
                insert T { vals := {1,1,2,3} };
            `
    );
    assertQueryResult(
      h,
      `select T { vals }`,
      [
            {
              "vals": unorderedBag([1, 1, 2, 3]),
            },
          ]
    );
  });

  it("test_edgeql_group_rebind_filter_01", () => {
    assertQueryResult(
      h,
      `
                with cardsByCost := (
                  group cards::Card by .cost
                )
                select cardsByCost {
                  key: {cost},
                  count := count(.elements),
                } filter .count > 1;
            `,
      unorderedBag([
            {
              "count": 3,
              "key": {
                "cost": 1,
              },
            },
            {
              "count": 2,
              "key": {
                "cost": 2,
              },
            },
            {
              "count": 2,
              "key": {
                "cost": 3,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_rebind_filter_02", () => {
    assertQueryResult(
      h,
      `
                with cardsByCost := (
                  group cards::Card by .cost
                )
                select cardsByCost {
                  key: {cost},
                  count := count(.elements),
                } filter .count > 1 order by .key.cost
            `,
      [
            {
              "count": 3,
              "key": {
                "cost": 1,
              },
            },
            {
              "count": 2,
              "key": {
                "cost": 2,
              },
            },
            {
              "count": 2,
              "key": {
                "cost": 3,
              },
            },
          ]
    );
  });

  it("test_edgeql_group_rebind_filter_03", () => {
    assertQueryResult(
      h,
      `
                with cardsByCost := (
                  group cards::Card by .cost
                )
                select (select cardsByCost) {
                  key: {cost},
                  count := count(.elements),
                } filter .count > 1;
            `,
      unorderedBag([
            {
              "count": 3,
              "key": {
                "cost": 1,
              },
            },
            {
              "count": 2,
              "key": {
                "cost": 2,
              },
            },
            {
              "count": 2,
              "key": {
                "cost": 3,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_binding_complex_01", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards,
              __scope_0_stdFreeObject := (
                WITH
                  __scope_2_defaultBill := DETACHED User,
                  __scope_2_defaultBill_groups := (
                    GROUP __scope_2_defaultBill
                    USING
                      category := __scope_2_defaultBill.avatar.name
                    BY category
                )
                SELECT __scope_2_defaultBill_groups {
                  key: {category},
                  grouping,
                  elements: {
                    id
                  }
                }
              )
            SELECT __scope_0_stdFreeObject {
              single sum := (
                sum(len(__scope_0_stdFreeObject.elements.name))
                - sum((WITH
                  __scope_1_defaultAssignedPayment :=
                    __scope_0_stdFreeObject.elements.<friends[is User]
                SELECT __scope_1_defaultAssignedPayment {
                  id
                }
                FILTER (exists __scope_1_defaultAssignedPayment.avatar))
              .deck_cost)
              )
            };
          `,
      unorderedBag([
            {
              "sum": -7,
            },
            {
              "sum": 5,
            },
            {
              "sum": -23,
            },
          ])
    );
  });

  it("test_edgeql_group_enumerate_01", () => {
    assertQueryResult(
      h,
      `
                group enumerate({'a', 'b', 'c', 'd'})
                using groupIndex := .0 // 2
                by groupIndex;
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                [0, "a"],
                [1, "b"],
              ]),
              "grouping": ["groupIndex"],
              "key": {
                "groupIndex": 0,
              },
            },
            {
              "elements": unorderedBag([
                [2, "c"],
                [3, "d"],
              ]),
              "grouping": ["groupIndex"],
              "key": {
                "groupIndex": 1,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_enumerate_02", () => {
    assertQueryResult(
      h,
      `
                group enumerate(array_unpack(['a', 'b', 'c', 'd']))
                using groupIndex := .0 // 2
                by groupIndex;
            `,
      unorderedBag([
            {
              "elements": unorderedBag([
                [0, "a"],
                [1, "b"],
              ]),
              "grouping": ["groupIndex"],
              "key": {
                "groupIndex": 0,
              },
            },
            {
              "elements": unorderedBag([
                [2, "c"],
                [3, "d"],
              ]),
              "grouping": ["groupIndex"],
              "key": {
                "groupIndex": 1,
              },
            },
          ])
    );
  });

  it("test_edgeql_group_uses_name_01", () => {
    h.query(
      `
            WITH g := (GROUP cards::Card BY .cost)
            SELECT g {
              key: {cost},
              grouping,
              elements: {
                name,
                multi owners := g.elements.owners { name },
              }
            };
            `
    );
  });

  it("test_edgeql_group_backlink", () => {
    assertQueryResult(
      h,
      `
            select (group cards::Award by .winner) {
              a := .key.winner,
            };
            `,
      [
            {
              "a": {},
            },
            {
              "a": {},
            },
          ]
    );
  });

  it("test_edgeql_group_link_property_01", () => {
    assertQueryResult(
      h,
      `
            with module cards
            select User {
              cards_by_count := (group .deck by @count) {
                key : {count},
                elements: {name},
              }
            }
            filter .name = 'Alice';
            `,
      [
            {
              "cards_by_count": [
                {
                  "key": {
                    "count": 2,
                  },
                  "elements": [
                    {
                      "name": "Imp",
                    },
                    {
                      "name": "Dragon",
                    },
                  ],
                },
                {
                  "key": {
                    "count": 3,
                  },
                  "elements": [
                    {
                      "name": "Bog monster",
                    },
                    {
                      "name": "Giant turtle",
                    },
                  ],
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            with module cards
            select User {
              cards_by_count := (group .deck by (@count, @count)) {
                key : {count},
                elements: {name},
              }
            }
            filter .name = 'Alice';
            `,
      [
            {
              "cards_by_count": [
                {
                  "key": {
                    "count": 2,
                  },
                  "elements": [
                    {
                      "name": "Imp",
                    },
                    {
                      "name": "Dragon",
                    },
                  ],
                },
                {
                  "key": {
                    "count": 3,
                  },
                  "elements": [
                    {
                      "name": "Bog monster",
                    },
                    {
                      "name": "Giant turtle",
                    },
                  ],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_group_link_property_02", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            select User { cards := (group .deck { name } by .element) };
            `,
      unorderedBag([
            {
              "cards": unorderedBag([
                {
                  "key": {
                    "element": "Water",
                  },
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Bog monster",
                    },
                    {
                      "name": "Giant turtle",
                    },
                  ]),
                },
                {
                  "key": {
                    "element": "Fire",
                  },
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Imp",
                    },
                    {
                      "name": "Dragon",
                    },
                  ]),
                },
              ]),
            },
            {
              "cards": unorderedBag([
                {
                  "key": {
                    "element": "Earth",
                  },
                  "grouping": ["element"],
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
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Bog monster",
                    },
                    {
                      "name": "Giant turtle",
                    },
                  ]),
                },
              ]),
            },
            {
              "cards": unorderedBag([
                {
                  "key": {
                    "element": "Earth",
                  },
                  "grouping": ["element"],
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
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Bog monster",
                    },
                    {
                      "name": "Giant turtle",
                    },
                  ]),
                },
                {
                  "key": {
                    "element": "Air",
                  },
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Sprite",
                    },
                    {
                      "name": "Giant eagle",
                    },
                    {
                      "name": "Djinn",
                    },
                  ]),
                },
              ]),
            },
            {
              "cards": unorderedBag([
                {
                  "key": {
                    "element": "Earth",
                  },
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Golem",
                    },
                  ]),
                },
                {
                  "key": {
                    "element": "Water",
                  },
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Bog monster",
                    },
                    {
                      "name": "Giant turtle",
                    },
                  ]),
                },
                {
                  "key": {
                    "element": "Fire",
                  },
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Dragon",
                    },
                  ]),
                },
                {
                  "key": {
                    "element": "Air",
                  },
                  "grouping": ["element"],
                  "elements": unorderedBag([
                    {
                      "name": "Sprite",
                    },
                    {
                      "name": "Giant eagle",
                    },
                    {
                      "name": "Djinn",
                    },
                  ]),
                },
              ]),
            },
          ])
    );
  });

  it("test_edgeql_group_destruct_immediately_01", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            select (group Card by .element).key.element
            `,
      unorderedSet(["Air", "Earth", "Fire", "Water"])
    );
  });

  it("test_edgeql_group_destruct_immediately_02", () => {
    assertQueryResult(
      h,
      `
            WITH MODULE cards
            select (group Card by .element).grouping
            `,
      ["element", "element", "element", "element"]
    );
  });

  it("test_edgeql_group_issue_5796", () => {
    assertQueryResult(
      h,
      `
            with
              module cards,
              groups := (
                group User { deck }
                by .name
              )
            select groups {
              name := .key.name,
            }
            limit 5;
            `,
      unorderedBag([
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
          ])
    );
  });

  it("test_edgeql_group_issue_6059", () => {
    assertQueryResult(
      h,
      `
            with
              module cards,
              groups := (group Card by .element)
            select groups {
              keyCard := (
                select .elements { id }
                limit 1
              ),
            }
            order by .keyCard.cost
            limit 100;
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

  it("test_edgeql_group_issue_6060", () => {
    assertQueryResult(
      h,
      `
            with
              module cards,
              groups := (group Card by .element),
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

  it("test_edgeql_group_issue_6481", () => {
    assertQueryResult(
      h,
      `
            select (
              group (
                select Comment {iowner:=.issue.owner}
              )
              by .iowner
            ) { }.elements;
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_group_issue_6019_a [xerror: Issue #6019 Grouping on key should probably be rejected. (And if not, it should not ISE!)]", () => {
    expect(() => {
      h.script(
        `
                group (
                  group (
                    select Issue
                  ) by .owner
                ) by .key
            `
      );
    }).toThrow();
  });

  it("test_edgeql_group_issue_6019_b", () => {
    assertQueryResult(
      h,
      `
            with
              module cards,
              g1 := (group Card by .element),
              flattened := (select g1 {element:=(.key.element)}),
            group flattened by .element
            `,
      [
            {},
            {},
            {},
            {},
          ]
    );
  });

  it("test_edgeql_group_issue_5828 [xerror: Issue #5828 Only fails with implicit_limit and typename injection. \"there is no range var...\"]", () => {
    assertQueryResult(
      h,
      `
            with module cards
            group User {
              deck: {awards: {name}},
            }
            by .name;
            `,
      [
            {
              "elements": [
                {},
              ],
            },
            {
              "elements": [
                {},
              ],
            },
            {
              "elements": [
                {},
              ],
            },
            {
              "elements": [
                {},
              ],
            },
          ]
    );
  });

  it("test_edgeql_group_issue_5757 [xerror: Issue #5757 Only fails with typename injection. Materialized set not finalized]", () => {
    assertQueryResult(
      h,
      `
            select (
              select (group User by .name) {}
            ) {
              xxx := .elements.name,
            };
            `,
      [
            {},
            {},
          ]
    );
  });

  it("test_edgeql_group_issue_4897", () => {
    assertQueryResult(
      h,
      `
            group Issue { name }
            using owner := .owner
            by owner;
            `,
      unorderedBag([
            {
              "key": {
                "owner": {
                  "id": "str",
                },
              },
              "elements": [
                {
                  "name": "Release EdgeDB",
                },
                {
                  "name": "Regression.",
                },
              ],
            },
            {
              "key": {
                "owner": {
                  "id": "str",
                },
              },
              "elements": [
                {
                  "name": "Improve EdgeDB repl output rendering.",
                },
                {
                  "name": "Repl tweak.",
                },
              ],
            },
          ])
    );
  });
});
