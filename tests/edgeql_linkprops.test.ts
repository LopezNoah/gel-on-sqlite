import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";

describe("LinkProps", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "cards",
      setup: "cards_setup",
      dbFile: "./tests/.artifacts/linkprops.sqlite",
      resetDbFile: true
    });
  });

  it ("Should expect cards", () => {
    h.assertQueryResult(`
        SELECT User {
            name,
            deck: {
                name,
                element,
                cost,
                @count
            } ORDER BY @count DESC THEN .name ASC
        } ORDER BY .name;`,
        [
                {
                    'name': 'Alice',
                    'deck': [
                        {
                            'cost': 2,
                            'name': 'Bog monster',
                            '@count': 3,
                            'element': 'Water'
                        },
                        {
                            'cost': 3,
                            'name': 'Giant turtle',
                            '@count': 3,
                            'element': 'Water'
                        },
                        {
                            'cost': 5,
                            'name': 'Dragon',
                            '@count': 2,
                            'element': 'Fire'
                        },
                        {
                            'cost': 1,
                            'name': 'Imp',
                            '@count': 2,
                            'element': 'Fire'
                        },
                    ],
                },
                {
                    'name': 'Bob',
                    'deck': [
                        {
                            'cost': 2,
                            'name': 'Bog monster',
                            '@count': 3,
                            'element': 'Water'
                        },
                        {
                            'cost': 1,
                            'name': 'Dwarf',
                            '@count': 3,
                            'element': 'Earth'
                        },
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
                    'deck': [
                        {
                            'cost': 1,
                            'name': 'Dwarf',
                            '@count': 4,
                            'element': 'Earth'
                        },
                        {
                            'cost': 1,
                            'name': 'Sprite',
                            '@count': 4,
                            'element': 'Air'
                        },
                        {
                            'cost': 2,
                            'name': 'Bog monster',
                            '@count': 3,
                            'element': 'Water'
                        },
                        {
                            'cost': 2,
                            'name': 'Giant eagle',
                            '@count': 3,
                            'element': 'Air'
                        },
                        {
                            'cost': 3,
                            'name': 'Giant turtle',
                            '@count': 2,
                            'element': 'Water'
                        },
                        {
                            'cost': 3,
                            'name': 'Golem',
                            '@count': 2,
                            'element': 'Earth'
                        },
                        {
                            'cost': 4,
                            'name': 'Djinn',
                            '@count': 1,
                            'element': 'Air'
                        },
                    ],
                },
                {
                    'name': 'Dave',
                    'deck': [
                        {
                            'cost': 1,
                            'name': 'Sprite',
                            '@count': 4,
                            'element': 'Air'
                        },
                        {
                            'cost': 2,
                            'name': 'Bog monster',
                            '@count': 1,
                            'element': 'Water'
                        },
                        {
                            'cost': 4,
                            'name': 'Djinn',
                            '@count': 1,
                            'element': 'Air'
                        },
                        {
                            'cost': 5,
                            'name': 'Dragon',
                            '@count': 1,
                            'element': 'Fire'
                        },
                        {
                            'cost': 2,
                            'name': 'Giant eagle',
                            '@count': 1,
                            'element': 'Air'
                        },
                        {
                            'cost': 3,
                            'name': 'Giant turtle',
                            '@count': 1,
                            'element': 'Water'
                        },
                        {
                            'cost': 3,
                            'name': 'Golem',
                            '@count': 1,
                            'element': 'Earth'
                        },
                    ],
                }
            ]
        )
  })

})
