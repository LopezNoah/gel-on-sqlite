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

  it ("Should expect cards", () => {
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

  it ("Should expect users and only cards with same count as cost", () => {
    h.assertQueryResult(`  
        #  get users and only cards that have the same count and
        #  cost in the decks 
        SELECT User {
            name,
            deck: {
                name,
                element,
                cost,
                @count
            } FILTER .cost = @count
                ORDER BY @count DESC THEN .name ASC
        } ORDER BY .name;`, 
            [
            {
                'name': 'Alice',
                'deck': [
                    {
                        'cost': 3,
                        'name': 'Giant turtle',
                        '@count': 3,
                        'element': 'Water'
                    },
                ],
            },
            {
                'name': 'Bob',
                'deck': [
                    {
                        'cost': 3,
                        'name': 'Giant turtle',
                        '@count': 3,
                        'element': 'Water'
                    },
                    {
                        'cost': 3,
                        'name': 'Golem',
                        '@count': 3,
                        'element': 'Earth'
                    },
                ],
            },
            {
                'name': 'Carol',
                'deck': [],
            },
            {
                'name': 'Dave',
                'deck': [],
            }
        ]);
  })

})
