import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";

describe("LinkProps", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "cards",
      setup: "cards_setup",
      dbFile: "./tests/.artifacts/expr.sqlite",
      resetDbFile: true
    });
  });

  it ("Should expect AirCards", () => {
    h.assertQueryResult(`
        SELECT AirCard {
            name,
            owners: {
                name
            } ORDER BY .name
        } ORDER BY AirCard.name;`,
        [
                {
                    'name': 'Djinn',
                    'owners': [{'name': 'Carol'}, {'name': 'Dave'}]
                },
                {
                    'name': 'Giant eagle',
                    'owners': [{'name': 'Carol'}, {'name': 'Dave'}]
                },
                {
                    'name': 'Sprite',
                    'owners': [{'name': 'Carol'}, {'name': 'Dave'}]
                }
            ]
        )
  })

  it("FireCard filtering", () => {
    h.assertQueryResult(`
        SELECT FireCard {name}
        FILTER FireCard IN DaveCard
        ORDER BY FireCard.name;
    `,
    [{'name': 'Dragon'}])
  })

  it("Aircard filtering", () => {
    h.assertQueryResult(`
                SELECT AirCard {name}
                FILTER AirCard NOT IN (SELECT Card FILTER Card.name LIKE 'D%')
                ORDER BY AirCard.name;
            `,
            [
                {'name': 'Giant eagle'},
                {'name': 'Sprite'},
            ])
  })

  it("Computable link", () => {
    h.assertQueryResult(`
                SELECT Card {
                    owners: {
                        name
                    } ORDER BY .name
                }
                FILTER .name = 'Djinn';
            `,
            [{
                'owners': [
                    {'name': 'Carol'},
                    {'name': 'Dave'}
                ]
            }])
  })  

  it("computable link deck_cost", () => {
    h.assertQueryResult(`
                SELECT User {
                    name,
                    deck_cost
                }
                ORDER BY User.name;
            `,
            [
                {
                    'name': 'Alice',
                    'deck_cost': 11
                },
                {
                    'name': 'Bob',
                    'deck_cost': 9
                },
                {
                    'name': 'Carol',
                    'deck_cost': 16
                },
                {
                    'name': 'Dave',
                    'deck_cost': 20
                }
            ])
  })
})
