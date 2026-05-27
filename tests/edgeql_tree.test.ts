import { beforeEach, describe, it } from "vitest";
import { QueryHarness } from "./utils.js";
import { assertQueryResult, unorderedSet } from "./python_query_test_helpers.js";

// Ported from gel/tests/test_edgeql_tree.py. Schema = tree.esdl, setup =
// tree_setup.edgeql. Tests use the standard QueryHarness; ones marked
// @test.xerror upstream are kept as `it` here, mirroring the Python
// suite's intent. Other tests run against the sqlite-ts pipeline and may
// fail until the relevant EdgeQL features land — failures are real parity
// signal, not noise.

describe("TestTree", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({ schema: "tree", setup: "tree_setup" });
  });

  it("test_edgeql_tree_delete_01", () => {
    h.query(`DELETE Tree;`);
    assertQueryResult(h, `SELECT Tree;`, []);
  });

  it("test_edgeql_tree_delete_02", () => {
    h.query(`DELETE Eert FILTER .val = '0';`);
    assertQueryResult(h, `SELECT Eert FILTER .val = '0';`, []);
  });

  it("test_edgeql_tree_insert_01 [xerror upstream]", () => {
    h.query(`INSERT Tree {
                val := 'i2',
                parent := (
                    INSERT Tree {
                        val := 'i1',
                        parent := (
                            INSERT Tree {
                                val := 'i0',
                            }
                        ),
                    }
                ),
            };`);
    assertQueryResult(h, `SELECT Tree {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            },
                        },
                    },
                }
                FILTER .val = 'i0';`, [
      {
        "val": "i0",
        "children": [
          {
            "val": "i1",
            "children": [
              {
                "val": "i2",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_insert_02 [xerror upstream]", () => {
    h.query(`INSERT Eert {
                val := 'i0',
                children := (
                    INSERT DETACHED Eert {
                        val := 'i1',
                        children := (
                            INSERT DETACHED Eert {
                                val := 'i2',
                            }
                        ),
                    }
                ),
            };`);
    assertQueryResult(h, `SELECT Eert {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            },
                        },
                    },
                }
                FILTER .val = 'i0';`, [
      {
        "val": "i0",
        "children": [
          {
            "val": "i1",
            "children": [
              {
                "val": "i2",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_insert_03 [xerror upstream]", () => {
    h.query(`WITH
                T1 := Tree,
                T2 := Tree,
            INSERT Tree {
                val := 'i2',
                parent := (
                    INSERT T1 {
                        val := 'i1',
                        parent := (
                            INSERT T2 {
                                val := 'i0',
                            }
                        ),
                    }
                ),
            };`);
    assertQueryResult(h, `SELECT Tree {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            },
                        },
                    },
                }
                FILTER .val = 'i0';`, [
      {
        "val": "i0",
        "children": [
          {
            "val": "i1",
            "children": [
              {
                "val": "i2",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_select_01 [unconverted: computed parent/children link not exposed]", () => {
    assertQueryResult(h, `SELECT Tree {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER NOT EXISTS .parent
                ORDER BY .val;`, [
      {
        "val": "0",
        "children": [
          {
            "val": "00",
            "children": [
              {
                "val": "000",
                "children": [],
              },
            ],
          },
          {
            "val": "01",
            "children": [
              {
                "val": "010",
                "children": [],
              },
            ],
          },
          {
            "val": "02",
            "children": [],
          },
        ],
      },
      {
        "val": "1",
        "children": [
          {
            "val": "10",
            "children": [],
          },
          {
            "val": "11",
            "children": [],
          },
          {
            "val": "12",
            "children": [],
          },
          {
            "val": "13",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_select_02 [unconverted: computed parent link not exposed]", () => {
    assertQueryResult(h, `SELECT Eert {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER NOT EXISTS .parent
                ORDER BY .val;`, [
      {
        "val": "0",
        "children": [
          {
            "val": "00",
            "children": [
              {
                "val": "000",
                "children": [],
              },
            ],
          },
          {
            "val": "01",
            "children": [
              {
                "val": "010",
                "children": [],
              },
            ],
          },
          {
            "val": "02",
            "children": [],
          },
        ],
      },
      {
        "val": "1",
        "children": [
          {
            "val": "10",
            "children": [],
          },
          {
            "val": "11",
            "children": [],
          },
          {
            "val": "12",
            "children": [],
          },
          {
            "val": "13",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_select_03", () => {
    assertQueryResult(h, `SELECT Tree.parent.parent.val;`, [
      "0",
    ]);
  });

  it("test_edgeql_tree_select_04 [unconverted: computed parent link not exposed]", () => {
    assertQueryResult(h, `SELECT Eert.parent.parent.val;`, [
      "0",
    ]);
  });

  it("test_edgeql_tree_select_05 [unconverted: backlink chain through aliased target not supported]", () => {
    assertQueryResult(h, `SELECT Eert.<children[IS Eert].<children[IS Eert].val;`, [
      "0",
    ]);
  });

  it("test_edgeql_tree_select_06", () => {
    assertQueryResult(h, `SELECT Eert.children.children.val;`, unorderedSet([
      "000",
      "010",
    ]));
  });

  it("test_edgeql_tree_select_07", () => {
    assertQueryResult(h, `SELECT Tree.children.children.val;`, unorderedSet([
      "000",
      "010",
    ]));
  });

  it("test_edgeql_tree_select_08", () => {
    assertQueryResult(h, `SELECT Tree.<parent[IS Tree].<parent[IS Tree].val;`, unorderedSet([
      "000",
      "010",
    ]));
  });

  it("test_edgeql_tree_select_09", () => {
    assertQueryResult(h, `SELECT Tree {val}
                FILTER
                    any(.children.children.val = '000')
                ORDER BY .val;`, [
      {
        "val": "0",
      },
    ]);
  });

  it("test_edgeql_tree_select_10", () => {
    assertQueryResult(h, `SELECT Eert {val}
                FILTER
                    any(.children.children.val = '000')
                ORDER BY .val;`, [
      {
        "val": "0",
      },
    ]);
  });

  it("test_edgeql_tree_select_11 [unconverted: WITH-binding string literal not evaluated as literal]", () => {
    assertQueryResult(h, `WITH
                    x := '010',
                SELECT Tree {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER
                    NOT EXISTS .parent
                    AND x IN {
                        .val,
                        .children.val,
                        .children.children.val,
                        .children.children.children.val,
                    };`, [
      {
        "val": "0",
        "children": [
          {
            "val": "00",
            "children": [
              {
                "val": "000",
                "children": [],
              },
            ],
          },
          {
            "val": "01",
            "children": [
              {
                "val": "010",
                "children": [],
              },
            ],
          },
          {
            "val": "02",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_select_12 [unconverted: WITH-binding string literal not evaluated as literal]", () => {
    assertQueryResult(h, `WITH
                    x := '12',
                SELECT Tree {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER
                    NOT EXISTS .parent
                    AND x IN {
                        .val,
                        .children.val,
                        .children.children.val,
                        .children.children.children.val,
                    };`, [
      {
        "val": "1",
        "children": [
          {
            "val": "10",
            "children": [],
          },
          {
            "val": "11",
            "children": [],
          },
          {
            "val": "12",
            "children": [],
          },
          {
            "val": "13",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_select_13 [unconverted: WITH-binding string literal not evaluated as literal]", () => {
    assertQueryResult(h, `WITH
                    x := '010',
                SELECT Eert {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER
                    NOT EXISTS .parent
                    AND x IN {
                        .val,
                        .children.val,
                        .children.children.val,
                        .children.children.children.val,
                    };`, [
      {
        "val": "0",
        "children": [
          {
            "val": "00",
            "children": [
              {
                "val": "000",
                "children": [],
              },
            ],
          },
          {
            "val": "01",
            "children": [
              {
                "val": "010",
                "children": [],
              },
            ],
          },
          {
            "val": "02",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_select_14 [unconverted: WITH-binding string literal not evaluated as literal]", () => {
    assertQueryResult(h, `WITH
                    x := '12',
                SELECT Eert {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER
                    NOT EXISTS .parent
                    AND x IN {
                        .val,
                        .children.val,
                        .children.children.val,
                        .children.children.children.val,
                    };`, [
      {
        "val": "1",
        "children": [
          {
            "val": "10",
            "children": [],
          },
          {
            "val": "11",
            "children": [],
          },
          {
            "val": "12",
            "children": [],
          },
          {
            "val": "13",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_update_01 [unconverted: computed parent/children link not exposed]", () => {
    h.query(`UPDATE Tree
                SET {
                    val := array_join(
                        [.val, 'c'] ++ array_agg((
                            SELECT _ := .children.val
                            ORDER BY _
                        )),
                        '_'
                    )
                }`);
    assertQueryResult(h, `SELECT Tree {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER NOT EXISTS .parent
                ORDER BY .val;`, [
      {
        "val": "0_c_00_01_02",
        "children": [
          {
            "val": "00_c_000",
            "children": [
              {
                "val": "000_c",
                "children": [],
              },
            ],
          },
          {
            "val": "01_c_010",
            "children": [
              {
                "val": "010_c",
                "children": [],
              },
            ],
          },
          {
            "val": "02_c",
            "children": [],
          },
        ],
      },
      {
        "val": "1_c_10_11_12_13",
        "children": [
          {
            "val": "10_c",
            "children": [],
          },
          {
            "val": "11_c",
            "children": [],
          },
          {
            "val": "12_c",
            "children": [],
          },
          {
            "val": "13_c",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_update_02 [unconverted: computed parent link not exposed]", () => {
    h.query(`UPDATE Eert
                SET {
                    val := array_join(
                        [.val, 'c'] ++ array_agg((
                            SELECT _ := .children.val
                            ORDER BY _
                        )),
                        '_'
                    )
                }`);
    assertQueryResult(h, `SELECT Eert {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER NOT EXISTS .parent
                ORDER BY .val;`, [
      {
        "val": "0_c_00_01_02",
        "children": [
          {
            "val": "00_c_000",
            "children": [
              {
                "val": "000_c",
                "children": [],
              },
            ],
          },
          {
            "val": "01_c_010",
            "children": [
              {
                "val": "010_c",
                "children": [],
              },
            ],
          },
          {
            "val": "02_c",
            "children": [],
          },
        ],
      },
      {
        "val": "1_c_10_11_12_13",
        "children": [
          {
            "val": "10_c",
            "children": [],
          },
          {
            "val": "11_c",
            "children": [],
          },
          {
            "val": "12_c",
            "children": [],
          },
          {
            "val": "13_c",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_update_03 [unconverted: parent path access in UPDATE assignment not lowered]", () => {
    h.query(`UPDATE Tree
                SET {
                    val := .val ++ '_p' ++ (('_' ++ .parent.val) ?? '')
                };`);
    assertQueryResult(h, `SELECT Tree {val}
                ORDER BY .val;`, [
      {
        "val": "000_p_00",
      },
      {
        "val": "00_p_0",
      },
      {
        "val": "010_p_01",
      },
      {
        "val": "01_p_0",
      },
      {
        "val": "02_p_0",
      },
      {
        "val": "0_p",
      },
      {
        "val": "10_p_1",
      },
      {
        "val": "11_p_1",
      },
      {
        "val": "12_p_1",
      },
      {
        "val": "13_p_1",
      },
      {
        "val": "1_p",
      },
    ]);
  });

  it("test_edgeql_tree_update_04 [unconverted: parent path access in UPDATE assignment not lowered]", () => {
    h.query(`UPDATE Eert
                SET {
                    val := .val ++ '_p' ++ (('_' ++ .parent.val) ?? '')
                };`);
    assertQueryResult(h, `SELECT Eert {val}
                ORDER BY .val;`, [
      {
        "val": "000_p_00",
      },
      {
        "val": "00_p_0",
      },
      {
        "val": "010_p_01",
      },
      {
        "val": "01_p_0",
      },
      {
        "val": "02_p_0",
      },
      {
        "val": "0_p",
      },
      {
        "val": "10_p_1",
      },
      {
        "val": "11_p_1",
      },
      {
        "val": "12_p_1",
      },
      {
        "val": "13_p_1",
      },
      {
        "val": "1_p",
      },
    ]);
  });

  it("test_edgeql_tree_update_05 [unconverted: WITH bindings as type aliases not supported]", () => {
    h.query(`WITH
                    # start with node '00'
                    T00 := (
                        SELECT Tree
                        FILTER .val = '00'
                    ),
                    # update its first child node ('000')
                    TC := (
                        UPDATE (SELECT T00.children
                        ORDER BY .val
                        LIMIT 1)
                        SET {parent := T00.parent}
                    ),
                UPDATE T00
                SET {parent := TC};`);
    assertQueryResult(h, `SELECT Tree {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER .val = '0'
                ORDER BY .val;`, [
      {
        "val": "0",
        "children": [
          {
            "val": "000",
            "children": [
              {
                "val": "00",
                "children": [],
              },
            ],
          },
          {
            "val": "01",
            "children": [
              {
                "val": "010",
                "children": [],
              },
            ],
          },
          {
            "val": "02",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_update_06 [xerror upstream]", () => {
    h.query(`WITH
                    # start with node '00'
                    T00 := (
                        SELECT Eert
                        FILTER .val = '00'
                    ),
                    # grab the parent of '00'
                    TP := T00.parent,
                    # update its first child node ('000')
                    TC := (
                        UPDATE (
                            SELECT T00.children
                            ORDER BY .val
                            LIMIT 1
                        )
                        SET {
                            children := {.children, T00}
                        }
                    ),
                    T00_up := (
                        UPDATE T00
                        SET {
                            children := (
                                SELECT _ := T00.children
                                FILTER _ != TC
                            )
                        }
                    ),
                # update the original parent of '00'
                UPDATE TP
                SET {
                    children := (
                        SELECT _ := {.children, T00_up}
                        FILTER _ != T00
                    )
                }`);
    assertQueryResult(h, `SELECT Eert {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER .val = '0'
                ORDER BY .val;`, [
      {
        "val": "0",
        "children": [
          {
            "val": "000",
            "children": [
              {
                "val": "00",
                "children": [],
              },
            ],
          },
          {
            "val": "01",
            "children": [
              {
                "val": "010",
                "children": [],
              },
            ],
          },
          {
            "val": "02",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_update_07 [unconverted: WITH bindings as type aliases not supported]", () => {
    h.query(`WITH
                    # start with node '000', get its parent
                    TP := (
                        SELECT Tree
                        FILTER .val = '000'
                    ).parent,
                    # move the '000' node
                    T000 := (
                        UPDATE Tree
                        FILTER .val = '000'
                        SET {parent := .parent.parent}
                    )
                UPDATE TP
                SET {parent := T000};`);
    assertQueryResult(h, `SELECT Tree {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER .val = '0'
                ORDER BY .val;`, [
      {
        "val": "0",
        "children": [
          {
            "val": "000",
            "children": [
              {
                "val": "00",
                "children": [],
              },
            ],
          },
          {
            "val": "01",
            "children": [
              {
                "val": "010",
                "children": [],
              },
            ],
          },
          {
            "val": "02",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_update_08 [unconverted: WITH bindings + assert_distinct not supported]", () => {
    h.query(`WITH
                    # start with node '000'
                    T000 := (
                        SELECT Eert
                        FILTER .val = '000'
                    ),
                    # update the parent of '000'
                    TP := (
                        UPDATE (SELECT T000.parent)
                        SET {
                            children := (
                                SELECT _ := .children
                                FILTER _ != T000
                            )
                        }
                    ),
                    # update the grand-parent of '000'
                    TPP := (
                        UPDATE (SELECT TP.parent)
                        SET {
                            children := (
                                SELECT _ := assert_distinct({.children, T000})
                                FILTER _ != TP
                            )
                        }
                    )
                # update node '000'
                UPDATE (SELECT _ := TPP.children FILTER _ = T000)
                SET {
                    children := assert_distinct({.children, TP})
                };`);
    assertQueryResult(h, `SELECT Eert {
                    val,
                    children: {
                        val,
                        children: {
                            val,
                            children: {
                                val,
                            } ORDER BY .val,
                        } ORDER BY .val,
                    } ORDER BY .val,
                }
                FILTER .val = '0'
                ORDER BY .val;`, [
      {
        "val": "0",
        "children": [
          {
            "val": "000",
            "children": [
              {
                "val": "00",
                "children": [],
              },
            ],
          },
          {
            "val": "01",
            "children": [
              {
                "val": "010",
                "children": [],
              },
            ],
          },
          {
            "val": "02",
            "children": [],
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_update_09 [unconverted: empty UPDATE SET {} not supported]", () => {
    assertQueryResult(h, `select (update Tree filter .val = "00" set { }) {
                    children: {val}
                }`, [
      {
        "children": [
          {
            "val": "000",
          },
        ],
      },
    ]);
  });

  it("test_edgeql_tree_update_10 [unconverted: multi-predicate UPDATE FILTER (IN {}) not supported]", () => {
    assertQueryResult(h, `select (
                    update Tree filter .val IN {"0", "00"}
                    set { parent := {} }
               ) {
                   val, children: {val} order by .val
               } order by .val;`, [
      {
        "children": [
          {
            "val": "01",
          },
          {
            "val": "02",
          },
        ],
        "val": "0",
      },
      {
        "children": [
          {
            "val": "000",
          },
        ],
        "val": "00",
      },
    ]);
  });

});