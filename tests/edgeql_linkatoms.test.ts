import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLLinkToScalarTypes", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "inventory",
      setup: "inventory_setup",
    });
  });

  it("test_edgeql_links_basic_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    tag_set1,
                    tag_set2,
                    tag_array,
                } ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "tag_set1": unorderedSet(["plastic", "round"]),
              "tag_set2": unorderedSet(["plastic", "round"]),
              "tag_array": null,
            },
            {
              "name": "chair",
              "tag_set1": unorderedSet(["rectangle", "wood"]),
              "tag_set2": [],
              "tag_array": ["wood", "rectangle"],
            },
            {
              "name": "ectoplasm",
              "tag_set1": [],
              "tag_set2": [],
              "tag_array": null,
            },
            {
              "name": "floor lamp",
              "tag_set1": unorderedSet(["metal", "plastic"]),
              "tag_set2": unorderedSet(["metal", "plastic"]),
              "tag_array": ["metal", "plastic"],
            },
            {
              "name": "mystery toy",
              "tag_set1": [],
              "tag_set2": [],
              "tag_array": null,
            },
            {
              "name": "table",
              "tag_set1": unorderedSet(["rectangle", "wood"]),
              "tag_set2": unorderedSet(["rectangle", "wood"]),
              "tag_array": ["wood", "rectangle"],
            },
            {
              "name": "teapot",
              "tag_set1": [],
              "tag_set2": [],
              "tag_array": ["ceramic", "round"],
            },
            {
              "name": "tv",
              "tag_set1": [],
              "tag_set2": unorderedSet(["plastic", "rectangle"]),
              "tag_array": ["plastic", "rectangle"],
            },
          ]
    );
  });

  it("test_edgeql_links_map_scalars_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    tag_set1 ORDER BY Item.tag_set1 DESC,
                    tag_set2 ORDER BY Item.tag_set2 ASC,
                } ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "tag_set1": ["round", "plastic"],
              "tag_set2": ["plastic", "round"],
            },
            {
              "name": "chair",
              "tag_set1": ["wood", "rectangle"],
              "tag_set2": [],
            },
            {
              "name": "ectoplasm",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "floor lamp",
              "tag_set1": ["plastic", "metal"],
              "tag_set2": ["metal", "plastic"],
            },
            {
              "name": "mystery toy",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "table",
              "tag_set1": ["wood", "rectangle"],
              "tag_set2": ["rectangle", "wood"],
            },
            {
              "name": "teapot",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "tv",
              "tag_set1": [],
              "tag_set2": ["plastic", "rectangle"],
            },
          ]
    );
  });

  it("test_edgeql_links_map_scalars_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    tag_set1 ORDER BY Item.tag_set1 DESC LIMIT 1,
                    tag_set2 ORDER BY Item.tag_set2 ASC OFFSET 1,
                } ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "tag_set1": ["round"],
              "tag_set2": ["round"],
            },
            {
              "name": "chair",
              "tag_set1": ["wood"],
              "tag_set2": [],
            },
            {
              "name": "ectoplasm",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "floor lamp",
              "tag_set1": ["plastic"],
              "tag_set2": ["plastic"],
            },
            {
              "name": "mystery toy",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "table",
              "tag_set1": ["wood"],
              "tag_set2": ["wood"],
            },
            {
              "name": "teapot",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "tv",
              "tag_set1": [],
              "tag_set2": ["rectangle"],
            },
          ]
    );
  });

  it("test_edgeql_links_map_scalars_03", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    tag_set1 FILTER Item.tag_set1 > 'p',
                    tag_set2 FILTER Item.tag_set2 < 'w',
                } ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "tag_set1": unorderedSet(["plastic", "round"]),
              "tag_set2": unorderedSet(["plastic", "round"]),
            },
            {
              "name": "chair",
              "tag_set1": unorderedSet(["rectangle", "wood"]),
              "tag_set2": [],
            },
            {
              "name": "ectoplasm",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "floor lamp",
              "tag_set1": unorderedSet(["plastic"]),
              "tag_set2": unorderedSet(["metal", "plastic"]),
            },
            {
              "name": "mystery toy",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "table",
              "tag_set1": unorderedSet(["rectangle", "wood"]),
              "tag_set2": unorderedSet(["rectangle"]),
            },
            {
              "name": "teapot",
              "tag_set1": [],
              "tag_set2": [],
            },
            {
              "name": "tv",
              "tag_set1": [],
              "tag_set2": unorderedSet(["plastic", "rectangle"]),
            },
          ]
    );
  });

  it("test_edgeql_links_set_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER 'plastic' IN .tag_set1
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
            },
            {
              "name": "floor lamp",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER 'plastic' IN .tag_set2
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
            },
            {
              "name": "floor lamp",
            },
            {
              "name": "tv",
            },
          ]
    );
  });

  it("test_edgeql_links_set_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER 'plastic' IN .tag_set1
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
            },
            {
              "name": "floor lamp",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER 'plastic' IN .tag_set2
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
            },
            {
              "name": "floor lamp",
            },
            {
              "name": "tv",
            },
          ]
    );
  });

  it("test_edgeql_links_set_03", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER
                    array_agg(Item.tag_set1 ORDER BY Item.tag_set1) =
                        ['rectangle', 'wood']
                ORDER BY .name;
            `,
      [
            {
              "name": "chair",
            },
            {
              "name": "table",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER
                    array_agg(Item.tag_set2 ORDER BY Item.tag_set2) =
                        ['rectangle', 'wood']
                ORDER BY .name;
            `,
      [
            {
              "name": "table",
            },
          ]
    );
  });

  it("test_edgeql_links_set_04", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER .tag_set1 = {'rectangle', 'wood'}
                ORDER BY .name;
            `,
      [
            {
              "name": "chair",
            },
            {
              "name": "table",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER .tag_set2 = {'rectangle', 'wood'}
                ORDER BY .name;
            `,
      [
            {
              "name": "table",
            },
            {
              "name": "tv",
            },
          ]
    );
  });

  it("test_edgeql_links_set_05", () => {
    assertQueryResult(
      h,
      `
                # subsets
                #
                SELECT Item {name}
                FILTER .tag_set1 IN {'rectangle', 'wood'}
                ORDER BY .name;
            `,
      [
            {
              "name": "chair",
            },
            {
              "name": "table",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER .tag_set2 IN {'rectangle', 'wood'}
                ORDER BY .name;
            `,
      [
            {
              "name": "table",
            },
            {
              "name": "tv",
            },
          ]
    );
  });

  it("test_edgeql_links_set_06", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    foo := (
                        # XXX: check test_edgeql_expr_alias for failures first
                        SELECT _ := Item.tag_set1
                        FILTER _ = {'rectangle', 'wood'}
                    ),
                    bar := (
                        # XXX: check test_edgeql_expr_alias for failures first
                        SELECT _ := Item.tag_set2
                        FILTER _ = {'rectangle', 'wood'}
                    ),
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "foo": [],
              "bar": [],
            },
            {
              "name": "chair",
              "foo": unorderedSet(["rectangle", "wood"]),
              "bar": [],
            },
            {
              "name": "ectoplasm",
              "foo": [],
              "bar": [],
            },
            {
              "name": "floor lamp",
              "foo": [],
              "bar": [],
            },
            {
              "name": "mystery toy",
              "foo": [],
              "bar": [],
            },
            {
              "name": "table",
              "foo": unorderedSet(["rectangle", "wood"]),
              "bar": unorderedSet(["rectangle", "wood"]),
            },
            {
              "name": "teapot",
              "foo": [],
              "bar": [],
            },
            {
              "name": "tv",
              "foo": [],
              "bar": unorderedSet(["rectangle"]),
            },
          ]
    );
  });

  it("test_edgeql_links_set_07", () => {
    assertQueryResult(
      h,
      `
                # subsets
                SELECT Item {name}
                FILTER count( (
                    # XXX: check test_edgeql_expr_alias for failures first
                    SELECT _ := Item.tag_set1
                    FILTER _ IN {'rectangle', 'wood'}
                )) = 2
                ORDER BY .name;
            `,
      [
            {
              "name": "chair",
            },
            {
              "name": "table",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER count( (
                    # XXX: check test_edgeql_expr_alias for failures first
                    SELECT _ := Item.tag_set2
                    FILTER _ IN {'rectangle', 'wood'}
                )) = 2
                ORDER BY .name;
            `,
      [
            {
              "name": "table",
            },
          ]
    );
  });

  it("test_edgeql_links_set_08", () => {
    assertQueryResult(
      h,
      `
                # match sets
                WITH
                    cmp := {'rectangle', 'wood'},
                    cmp_count := count(cmp)
                SELECT Item {name}
                FILTER
                    cmp_count = count(Item.tag_set1)
                    AND
                    cmp_count = count(DISTINCT (Item.tag_set1 UNION cmp))
                ORDER BY .name;
            `,
      [
            {
              "name": "chair",
            },
            {
              "name": "table",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    cmp := {'rectangle', 'wood'},
                    cmp_count := count(cmp)
                SELECT Item {name}
                FILTER
                    cmp_count = count(.tag_set2)
                    AND
                    cmp_count = count(DISTINCT (.tag_set2 UNION cmp))
                ORDER BY .name;
            `,
      [
            {
              "name": "table",
            },
          ]
    );
  });

  it("test_edgeql_links_set_10", () => {
    assertQueryResult(
      h,
      `
                # same as previous, but with a different syntax, leading
                # to a different failure scenario
                WITH
                    cmp := {'rectangle', 'wood'},
                    cmp_count := count(cmp)
                # includes tag_set1 in the shape
                SELECT Item {name, tag_set1}
                FILTER
                    cmp_count = count(Item.tag_set1)
                    AND
                    cmp_count = count(DISTINCT (Item.tag_set1 UNION cmp))
                ORDER BY .name;
            `,
      [
            {
              "name": "chair",
              "tag_set1": unorderedSet(["rectangle", "wood"]),
            },
            {
              "name": "table",
              "tag_set1": unorderedSet(["rectangle", "wood"]),
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    cmp := {'rectangle', 'wood'},
                    cmp_count := count(cmp)
                # includes tag_set1 in the shape
                SELECT Item {name, tag_set2}
                FILTER
                    cmp_count = count(Item.tag_set2)
                    AND
                    cmp_count = count(DISTINCT (Item.tag_set2 UNION cmp))
                ORDER BY .name;
            `,
      [
            {
              "name": "table",
              "tag_set2": unorderedSet(["rectangle", "wood"]),
            },
          ]
    );
  });

  it("test_edgeql_links_set_11", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER
                    array_agg(Item.tag_set1 ORDER BY Item.tag_set1) =
                        array_agg(Item.tag_set2 ORDER BY Item.tag_set2)
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
            },
            {
              "name": "ectoplasm",
            },
            {
              "name": "floor lamp",
            },
            {
              "name": "mystery toy",
            },
            {
              "name": "table",
            },
            {
              "name": "teapot",
            },
          ]
    );
  });

  it("test_edgeql_links_set_12", () => {
    assertQueryResult(
      h,
      `
                # find an item with a unique quality
                WITH
                    I2 := Item
                SELECT Item {
                    name,
                    unique := (
                        SELECT _ := Item.tag_set1
                        FILTER _ NOT IN (
                            (SELECT I2 FILTER I2 != Item).tag_set1
                        )
                    )
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "unique": ["round"],
            },
            {
              "name": "chair",
              "unique": [],
            },
            {
              "name": "ectoplasm",
              "unique": [],
            },
            {
              "name": "floor lamp",
              "unique": ["metal"],
            },
            {
              "name": "mystery toy",
              "unique": [],
            },
            {
              "name": "table",
              "unique": [],
            },
            {
              "name": "teapot",
              "unique": [],
            },
            {
              "name": "tv",
              "unique": [],
            },
          ]
    );
  });

  it("test_edgeql_links_set_13", () => {
    assertQueryResult(
      h,
      `
                # find an item with a unique quality
                WITH
                    I2 := Item
                SELECT Item {
                    name,
                    unique := count( (
                        SELECT _ := Item.tag_set1
                        FILTER _ NOT IN (
                            (SELECT I2 FILTER I2 != Item).tag_set1
                        )
                    ))
                }
                FILTER .unique > 0
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "unique": 1,
            },
            {
              "name": "floor lamp",
              "unique": 1,
            },
          ]
    );
  });

  it("test_edgeql_links_set_14", () => {
    assertQueryResult(
      h,
      `
                # find an item with a unique quality
                WITH
                    I2 := Item
                SELECT Item {
                    name,
                    unique := (
                        # XXX: check test_edgeql_expr_alias for failures first
                        SELECT _ := Item.tag_set1
                        FILTER _ NOT IN (
                            (SELECT I2 FILTER I2 != Item).tag_set1
                        )
                    )
                }
                FILTER count(.unique) > 0
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "unique": ["round"],
            },
            {
              "name": "floor lamp",
              "unique": ["metal"],
            },
          ]
    );
  });

  it("test_edgeql_links_set_15", () => {
    assertQueryResult(
      h,
      `
                # subsets
                SELECT Item {name}
                FILTER .tag_set1 IN {'wood', 'plastic'}
                ORDER BY count((
                    SELECT _ := Item.tag_set1
                    FILTER _ IN {'rectangle', 'plastic', 'wood'}
                )) DESC THEN .name;
            `,
      [
            {
              "name": "chair",
            },
            {
              "name": "table",
            },
            {
              "name": "ball",
            },
            {
              "name": "floor lamp",
            },
          ]
    );
  });

  it("test_edgeql_links_array_01", () => {
    assertQueryResult(
      h,
      `
                # just a simple unpack
                SELECT Item {
                    name,
                    unpack := (SELECT array_unpack(Item.tag_array))
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "unpack": [],
            },
            {
              "name": "chair",
              "unpack": unorderedSet(["rectangle", "wood"]),
            },
            {
              "name": "ectoplasm",
              "unpack": [],
            },
            {
              "name": "floor lamp",
              "unpack": unorderedSet(["metal", "plastic"]),
            },
            {
              "name": "mystery toy",
              "unpack": [],
            },
            {
              "name": "table",
              "unpack": unorderedSet(["rectangle", "wood"]),
            },
            {
              "name": "teapot",
              "unpack": unorderedSet(["ceramic", "round"]),
            },
            {
              "name": "tv",
              "unpack": unorderedSet(["plastic", "rectangle"]),
            },
          ]
    );
  });

  it("test_edgeql_links_array_02", () => {
    assertQueryResult(
      h,
      `
                # just a simple unpack
                SELECT Item {
                    name,
                    unpack := array_unpack(Item.tag_array)
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "unpack": [],
            },
            {
              "name": "chair",
              "unpack": unorderedSet(["rectangle", "wood"]),
            },
            {
              "name": "ectoplasm",
              "unpack": [],
            },
            {
              "name": "floor lamp",
              "unpack": unorderedSet(["metal", "plastic"]),
            },
            {
              "name": "mystery toy",
              "unpack": [],
            },
            {
              "name": "table",
              "unpack": unorderedSet(["rectangle", "wood"]),
            },
            {
              "name": "teapot",
              "unpack": unorderedSet(["ceramic", "round"]),
            },
            {
              "name": "tv",
              "unpack": unorderedSet(["plastic", "rectangle"]),
            },
          ]
    );
  });

  it("test_edgeql_links_array_03", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER 'metal' IN array_unpack(.tag_array)
                ORDER BY .name;
            `,
      [
            {
              "name": "floor lamp",
            },
          ]
    );
  });

  it("test_edgeql_links_array_04", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER 'metal' = array_unpack(.tag_array)
                ORDER BY .name;
            `,
      [
            {
              "name": "floor lamp",
            },
          ]
    );
  });

  it("test_edgeql_links_array_05", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                # array_get is used to safely default to {}
                FILTER array_get(.tag_array, 0) = 'metal'
                ORDER BY .name;
            `,
      [
            {
              "name": "floor lamp",
            },
          ]
    );
  });

  it("test_edgeql_links_array_06", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER .tag_array = ['metal', 'plastic']
                ORDER BY .name;
            `,
      [
            {
              "name": "floor lamp",
            },
          ]
    );
  });

  it("test_edgeql_links_array_07", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                FILTER NOT EXISTS .tag_array
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
            },
            {
              "name": "ectoplasm",
            },
            {
              "name": "mystery toy",
            },
          ]
    );
  });

  it("test_edgeql_links_array_08", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {name}
                # no item has 3 elements
                FILTER NOT EXISTS array_get(.tag_array, 3)
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
            },
            {
              "name": "chair",
            },
            {
              "name": "ectoplasm",
            },
            {
              "name": "floor lamp",
            },
            {
              "name": "mystery toy",
            },
            {
              "name": "table",
            },
            {
              "name": "teapot",
            },
            {
              "name": "tv",
            },
          ]
    );
  });

  it("test_edgeql_links_array_09", () => {
    assertQueryResult(
      h,
      `
                # find an item with a unique quality
                WITH
                    I2 := Item
                SELECT Item {
                    name,
                    unique := (
                        SELECT _ := array_unpack(Item.tag_array)
                        FILTER _ NOT IN (
                            SELECT array_unpack(
                                (SELECT I2 FILTER I2 != Item).tag_array
                            )
                        )
                    )
                }
                ORDER BY .name;
            `,
      [
            {
              "name": "ball",
              "unique": [],
            },
            {
              "name": "chair",
              "unique": [],
            },
            {
              "name": "ectoplasm",
              "unique": [],
            },
            {
              "name": "floor lamp",
              "unique": unorderedSet(["metal"]),
            },
            {
              "name": "mystery toy",
              "unique": [],
            },
            {
              "name": "table",
              "unique": [],
            },
            {
              "name": "teapot",
              "unique": unorderedSet(["ceramic", "round"]),
            },
            {
              "name": "tv",
              "unique": [],
            },
          ]
    );
  });

  it("test_edgeql_links_array_10", () => {
    assertQueryResult(
      h,
      `
                # find an item with a unique quality
                WITH
                    I2 := Item
                SELECT Item {
                    name,
                    unique := (
                        SELECT _ := array_unpack(Item.tag_array)
                        FILTER _ NOT IN (
                            SELECT array_unpack(
                                (SELECT I2 FILTER I2 != Item).tag_array
                            )
                        )
                    )
                }
                FILTER count(.unique) > 0
                ORDER BY .name;
            `,
      [
            {
              "name": "floor lamp",
              "unique": unorderedSet(["metal"]),
            },
            {
              "name": "teapot",
              "unique": unorderedSet(["ceramic", "round"]),
            },
          ]
    );
  });

  it("test_edgeql_links_array_11", () => {
    assertQueryResult(
      h,
      `
                # find an item with ALL unique qualities
                WITH
                    I2 := Item
                SELECT Item {
                    name,
                    tag_array,
                }
                FILTER
                    # such that has tag_array
                    EXISTS Item.tag_array AND
                    # and such that does not exist
                    NOT EXISTS (
                        # another item
                        SELECT I2
                        FILTER
                            # different from current one
                            I2 != Item
                            AND
                            # matching at least one tag
                            array_unpack(I2.tag_array) =
                                array_unpack(Item.tag_array)
                    )
                ORDER BY .name;
            `,
      [
            {
              "name": "teapot",
              "tag_array": unorderedSet(["ceramic", "round"]),
            },
          ]
    );
  });

  it("test_edgeql_links_derived_tuple_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    n1 := (Item.name,),
                    n2 := (Item.name,).0,
                    t1 := (Item.tag_set1,),
                    t2 := (Item.tag_set1, Item.tag_set2),
                    t3 := (Item.tag_set1,).0,
                    t4 := (Item.tag_set1, Item.tag_set2).1,
                }
                FILTER .name IN {'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "n1": ["chair"],
              "n2": "chair",
              "t1": [
                ["rectangle"],
                ["wood"],
              ],
              "t2": [],
              "t3": ["rectangle", "wood"],
              "t4": [],
            },
            {
              "n1": ["table"],
              "n2": "table",
              "t1": [
                ["rectangle"],
                ["wood"],
              ],
              "t2": [
                ["rectangle", "rectangle"],
                ["rectangle", "wood"],
                ["wood", "rectangle"],
                ["wood", "wood"],
              ],
              "t3": ["rectangle", "wood"],
              "t4": ["rectangle", "rectangle", "wood", "wood"],
            },
          ])
    );
  });

  it("test_edgeql_links_derived_tuple_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    n1 := (Item.name, 'foo'),
                }
                FILTER
                    .n1.0 = 'chair'
                ORDER BY
                    .name;
            `,
      [
            {
              "n1": ["chair", "foo"],
            },
          ]
    );
  });

  it("test_edgeql_links_derived_array_01", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    n1 := [Item.name],
                    n2 := [Item.name][0],
                    t1 := [Item.tag_set1],
                    t2 := [Item.tag_set1, Item.tag_set2],
                    t3 := [Item.tag_set1][0],
                    t4 := [Item.tag_set1, Item.tag_set2][1],
                    a1 := Item.tag_array,
                    a2 := Item.tag_array[0],
                }
                FILTER .name IN {'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "n1": ["chair"],
              "n2": "chair",
              "t1": [
                ["rectangle"],
                ["wood"],
              ],
              "t2": [],
              "t3": ["rectangle", "wood"],
              "t4": [],
              "a1": ["wood", "rectangle"],
              "a2": "wood",
            },
            {
              "n1": ["table"],
              "n2": "table",
              "t1": [
                ["rectangle"],
                ["wood"],
              ],
              "t2": [
                ["rectangle", "rectangle"],
                ["rectangle", "wood"],
                ["wood", "rectangle"],
                ["wood", "wood"],
              ],
              "t3": ["rectangle", "wood"],
              "t4": ["rectangle", "rectangle", "wood", "wood"],
              "a1": ["wood", "rectangle"],
              "a2": "wood",
            },
          ])
    );
  });

  it("test_edgeql_links_derived_array_02", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    n1 := [Item.name],
                    n2 := array_get([Item.name], 0),
                    t1 := [Item.tag_set1],
                    t2 := [Item.tag_set1, Item.tag_set2],
                    t3 := array_get([Item.tag_set1], 0),
                    t4 := array_get([Item.tag_set1, Item.tag_set2], 1),
                    a1 := Item.tag_array,
                    a2 := array_get(Item.tag_array, 0),
                }
                FILTER .name IN {'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "n1": ["chair"],
              "n2": "chair",
              "t1": [
                ["rectangle"],
                ["wood"],
              ],
              "t2": [],
              "t3": ["rectangle", "wood"],
              "t4": [],
              "a1": ["wood", "rectangle"],
              "a2": "wood",
            },
            {
              "n1": ["table"],
              "n2": "table",
              "t1": [
                ["rectangle"],
                ["wood"],
              ],
              "t2": [
                ["rectangle", "rectangle"],
                ["rectangle", "wood"],
                ["wood", "rectangle"],
                ["wood", "wood"],
              ],
              "t3": ["rectangle", "wood"],
              "t4": ["rectangle", "rectangle", "wood", "wood"],
              "a1": ["wood", "rectangle"],
              "a2": "wood",
            },
          ])
    );
  });

  it("test_edgeql_links_derived_array_03", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    a_a1 := Item.tag_array[{0, 1}],
                    a_t2 := [Item.tag_set1, Item.tag_set2][{0, 1}],
                }
                FILTER .name IN {'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "name": "chair",
              "a_a1": ["rectangle", "wood"],
              "a_t2": [],
            },
            {
              "name": "table",
              "a_a1": ["rectangle", "wood"],
              "a_t2": [
                "rectangle",
                "rectangle",
                "rectangle",
                "rectangle",
                "wood",
                "wood",
                "wood",
                "wood",
              ],
            },
          ])
    );
  });

  it("test_edgeql_links_derived_array_04", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    a_a1 := array_get(Item.tag_array, {0, 1}),
                    a_t2 := array_get([Item.tag_set1, Item.tag_set2], {0, 1}),
                }
                FILTER .name IN {'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "name": "chair",
              "a_a1": ["rectangle", "wood"],
              "a_t2": [],
            },
            {
              "name": "table",
              "a_a1": ["rectangle", "wood"],
              "a_t2": [
                "rectangle",
                "rectangle",
                "rectangle",
                "rectangle",
                "wood",
                "wood",
                "wood",
                "wood",
              ],
            },
          ])
    );
  });

  it("test_edgeql_links_derived_array_05", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    a_a1 := array_get(Item.tag_array, {0, 2}),
                    a_t2 := array_get([Item.tag_set1, Item.tag_set2], {0, 2}),
                }
                FILTER .name IN {'ball', 'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "name": "ball",
              "a_a1": [],
              "a_t2": ["plastic", "plastic", "round", "round"],
            },
            {
              "name": "chair",
              "a_a1": ["wood"],
              "a_t2": [],
            },
            {
              "name": "table",
              "a_a1": ["wood"],
              "a_t2": ["rectangle", "rectangle", "wood", "wood"],
            },
          ])
    );
  });

  it("test_edgeql_links_derived_array_06", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    a_a1 := Item.tag_array[1:20],
                    a_t2 := [Item.tag_set1, Item.tag_set2][1:20],
                }
                FILTER .name IN {'ball', 'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "name": "ball",
              "a_a1": null,
              "a_t2": [
                ["plastic"],
                ["plastic"],
                ["round"],
                ["round"],
              ],
            },
            {
              "name": "chair",
              "a_a1": ["rectangle"],
              "a_t2": [],
            },
            {
              "name": "table",
              "a_a1": ["rectangle"],
              "a_t2": [
                ["rectangle"],
                ["rectangle"],
                ["wood"],
                ["wood"],
              ],
            },
          ])
    );
  });

  it("test_edgeql_links_derived_array_07", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    a_a1 := Item.tag_array[{1, 2}:20],
                    a_t2 := [Item.tag_set1, Item.tag_set2][{1, 2}:20],
                }
                FILTER .name IN {'ball', 'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "name": "ball",
              "a_a1": [],
              "a_t2": [
                [],
                [],
                [],
                [],
                ["plastic"],
                ["plastic"],
                ["round"],
                ["round"],
              ],
            },
            {
              "name": "chair",
              "a_a1": [
                [],
                ["rectangle"],
              ],
              "a_t2": [],
            },
            {
              "name": "table",
              "a_a1": [
                [],
                ["rectangle"],
              ],
              "a_t2": [
                [],
                [],
                [],
                [],
                ["rectangle"],
                ["rectangle"],
                ["wood"],
                ["wood"],
              ],
            },
          ])
    );
  });

  it("test_edgeql_links_derived_array_08", () => {
    assertQueryResult(
      h,
      `
                SELECT Item {
                    name,
                    re := re_match(Item.tag_set1, Item.tag_set2),
                }
                FILTER .name IN {'chair', 'table'}
                ORDER BY .name;
            `,
      unorderedBag([
            {
              "name": "chair",
              "re": [],
            },
            {
              "name": "table",
              "re": [
                ["rectangle"],
                ["wood"],
              ],
            },
          ])
    );
  });
});
