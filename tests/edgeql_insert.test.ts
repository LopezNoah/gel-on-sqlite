import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  queryRows,
  querySingle,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestInsert", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "insert"
    });
  });

  it("test_edgeql_insert_fail_01", () => {
    expect(() => {
      h.script(
        `
                INSERT InsertTest;
            `
      );
    }).toThrow(new RegExp("missing value for required property 'l2' of object type 'default::InsertTest'"));
  });

  it("test_edgeql_insert_fail_02", () => {
    expect(() => {
      h.script(
        `
                INSERT InsertTest {
                    l2 := assert_single({})
                };
            `
      );
    }).toThrow(new RegExp("missing value for required property 'l2' of object type 'default::InsertTest'"));
  });

  it("test_edgeql_insert_fail_03", () => {
    expect(() => {
      h.script(
        `
                INSERT Person2b {
                    first := "foo",
                    last := "bar",
                    name := "something else",
                };
            `
      );
    }).toThrow(new RegExp("modification of computed property 'name' of object type 'default::Person2b' is prohibited"));
  });

  it("test_edgeql_insert_fail_04", () => {
    expect(() => {
      h.script(
        `
                INSERT Person { name };
            `
      );
    }).toThrow(new RegExp("mutation queries must specify values with ':='"));
  });

  it("test_edgeql_insert_fail_05", () => {
    expect(() => {
      h.script(
        `
                INSERT Person.notes { name := "note1" };
            `
      );
    }).toThrow(new RegExp("INSERT only works with object types, not arbitrary expressions"));
  });

  it("test_edgeql_insert_fail_06", () => {
    expect(() => {
      h.script(
        `
                INSERT Person { name := .name };
            `
      );
    }).toThrow(new RegExp("could not resolve partial path"));
  });

  it("test_edgeql_insert_fail_07", () => {
    expect(() => {
      h.script(
        `
                INSERT schema::Migration { script := 'foo' };
            `
      );
    }).toThrow(new RegExp("insert standard library type"));
  });

  it("test_edgeql_insert_fail_08", () => {
    expect(() => {
      h.script(
        `
                insert Note {name := 'bad note'} union DerivedNote;
            `
      );
    }).toThrow(new RegExp("INSERT only works with object types, not arbitrary expressions"));
  });

  it("test_edgeql_insert_fail_09", () => {
    expect(() => {
      h.script(
        `
                insert Note {
                    name := 'bad note'
                } if not exists DerivedNote else DerivedNote;
            `
      );
    }).toThrow(new RegExp("INSERT only works with object types, not conditional expressions"));
  });

  it("test_edgeql_insert_simple_01", () => {
    h.script(
      `
            INSERT InsertTest {
                name := 'insert simple 01',
                l2 := 0,
            };

            INSERT InsertTest {
                name := 'insert simple 01',
                l3 := "Test\"1\"",
                l2 := 1
            };

            INSERT InsertTest {
                name := 'insert simple 01',
                l3 := 'Test\'2\'',
                l2 := 2
            };

            INSERT InsertTest {
                name := 'insert simple 01',
                l3 := '\"Test\'3\'\"',
                l2 := 3
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    InsertTest {
                        l2, l3
                    }
                FILTER
                    InsertTest.name = 'insert simple 01'
                ORDER BY
                    InsertTest.l2;
            `,
      [
            {
              "l2": 0,
              "l3": "test",
            },
            {
              "l2": 1,
              "l3": "Test\"1\"",
            },
            {
              "l2": 2,
              "l3": "Test'2'",
            },
            {
              "l2": 3,
              "l3": "\"Test'3'\"",
            },
          ]
    );
  });

  it("test_edgeql_insert_simple_02", () => {
    h.script(
      `
            INSERT DefaultTest1 { foo := '02' };

            INSERT DefaultTest1 { foo := '02' };

            INSERT DefaultTest1 { foo := '02' };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DefaultTest1 { num } FILTER DefaultTest1.foo = '02';
            `,
      [
            {
              "num": 42,
            },
            {
              "num": 42,
            },
            {
              "num": 42,
            },
          ]
    );
  });

  it("test_edgeql_insert_simple_03", () => {
    h.script(
      `
            INSERT DefaultTest1 { num := 100 };

            INSERT DefaultTest2;

            INSERT DefaultTest1 { num := 101 };

            INSERT DefaultTest2;

            INSERT DefaultTest1 { num := 102 };

            INSERT DefaultTest2;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DefaultTest2 { num }
                ORDER BY DefaultTest2.num;
            `,
      [
            {
              "num": 101,
            },
            {
              "num": 102,
            },
            {
              "num": 103,
            },
          ]
    );
  });

  it("test_edgeql_insert_unused_01", () => {
    h.script(
      `
            with _ := (
                INSERT InsertTest {
                    name := 'insert simple 01',
                    l2 := 0,
                }
            ), select 1;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    InsertTest {
                        l2
                    }
                FILTER
                    InsertTest.name = 'insert simple 01'
            `,
      [
            {
              "l2": 0,
            },
          ]
    );
    h.script(
      `
            with _ := (
                INSERT InsertTest {
                    name := 'insert simple 01',
                    l2 := (select 1 filter true),
                }
            ),
            INSERT InsertTest {
                name := 'insert simple 01',
                l2 := 2,
            }
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    InsertTest {
                        l2
                    }
                FILTER
                    InsertTest.name = 'insert simple 01'
                ORDER BY .l2
            `,
      [
            {
              "l2": 0,
            },
            {
              "l2": 1,
            },
            {
              "l2": 2,
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_01", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'subtest 1'
            };

            INSERT Subordinate {
                name := 'subtest 2'
            };

            INSERT InsertTest {
                name := 'insert nested',
                l2 := 0,
                subordinates := (
                    SELECT Subordinate
                    FILTER Subordinate.name LIKE 'subtest%'
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    subordinates: {
                        name,
                        @comment,
                    } ORDER BY InsertTest.subordinates.name
                }
                FILTER
                    InsertTest.name = 'insert nested';
            `,
      [
            {
              "subordinates": [
                {
                  "name": "subtest 1",
                  "@comment": null,
                },
                {
                  "name": "subtest 2",
                  "@comment": null,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_02", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'subtest 3'
            };

            INSERT Subordinate {
                name := 'subtest 4'
            };

            INSERT InsertTest {
                name := 'insert nested 2',
                l2 := 0,
                subordinates := (
                    SELECT Subordinate {
                        @comment := (SELECT 'comment ' ++ Subordinate.name)
                    }
                    FILTER Subordinate.name IN {'subtest 3', 'subtest 4'}
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    subordinates: {
                        name,
                        @comment,
                    } ORDER BY InsertTest.subordinates.name
                }
                FILTER
                    InsertTest.name = 'insert nested 2';
            `,
      [
            {
              "subordinates": [
                {
                  "name": "subtest 3",
                  "@comment": "comment subtest 3",
                },
                {
                  "name": "subtest 4",
                  "@comment": "comment subtest 4",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_03", () => {
    h.script(
      `
            INSERT InsertTest {
                name := 'insert nested 3',
                l2 := 0,
                subordinates := (INSERT Subordinate {
                    name := 'nested sub 3.1'
                })
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    subordinates: {
                        name
                    } ORDER BY InsertTest.subordinates.name
                }
                FILTER
                    InsertTest.name = 'insert nested 3';
            `,
      [
            {
              "subordinates": [
                {
                  "name": "nested sub 3.1",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_04", () => {
    h.script(
      `
            INSERT InsertTest {
                name := 'insert nested 4',
                l2 := 0,
                subordinates := (INSERT Subordinate {
                    name := 'nested sub 4.1',
                    @comment := 'comment 4.1'
                })
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    subordinates: {
                        name,
                        @comment,
                    } ORDER BY InsertTest.subordinates.name
                }
                FILTER
                    InsertTest.name = 'insert nested 4';
            `,
      [
            {
              "subordinates": [
                {
                  "name": "nested sub 4.1",
                  "@comment": "comment 4.1",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_05", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'only subordinate'
            };

            INSERT Subordinate {
                name := 'never subordinate'
            };

            INSERT InsertTest {
                name := 'insert nested 5',
                l2 := 0,
                subordinates := (
                    SELECT Subordinate
                    FILTER Subordinate.name = 'only subordinate'
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    name,
                    l2,
                    subordinates: {
                        name
                    }
                } FILTER InsertTest.name = 'insert nested 5';
            `,
      [
            {
              "name": "insert nested 5",
              "l2": 0,
              "subordinates": [
                {
                  "name": "only subordinate",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_06", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'linkprop test target 6'
            };

            INSERT InsertTest {
                name := 'insert nested 6',
                l2 := 0,
                subordinates := (
                    SELECT Subordinate {
                        @comment := 'comment 6'
                    }
                    LIMIT 1
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    subordinates: {
                        name,
                        @comment,
                    }
                }
                FILTER
                    InsertTest.name = 'insert nested 6';
            `,
      [
            {
              "subordinates": [
                {
                  "name": "linkprop test target 6",
                  "@comment": "comment 6",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_07", () => {
    expect(() => {
      h.script(
        `
                INSERT InsertTest {
                    subordinates: Subordinate {
                        name := 'nested sub 7.1',
                        @comment := 'comment 7.1',
                    }
                };
            `
      );
    }).toThrow(new RegExp("Unexpected 'Subordinate'"));
  });

  it("test_edgeql_insert_nested_08", () => {
    assertQueryResult(
      h,
      `
            WITH
                x1 := (
                    INSERT InsertTest {
                        name := 'insert nested 8',
                        l2 := 0,
                        subordinates := (
                            INSERT Subordinate {
                                name := 'nested sub 8.1'
                            }
                        )
                    }
                )
            SELECT x1 {
                name,
                subordinates: {
                    name
                }
            };
        `,
      [
            {
              "name": "insert nested 8",
              "subordinates": [
                {
                  "name": "nested sub 8.1",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_09", () => {
    h.script(
      `
            INSERT InsertTest {
                name := 'insert nested 9',
                l2 := 0,
                sub := (
                    INSERT Subordinate {
                        name := 'nested sub 9',
                        @note := 'sub note 9',
                    }
                )
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT InsertTest {
                name,
                sub: {
                    name,
                    @note
                }
            } FILTER
                .name = 'insert nested 9'
        `,
      [
            {
              "name": "insert nested 9",
              "sub": {
                "name": "nested sub 9",
                "@note": "sub note 9",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_10", () => {
    h.script(
      `

            INSERT Subordinate {
                name := 'nested sub 10',
            };

            INSERT InsertTest {
                name := 'insert nested 10',
                l2 := 0,
                sub := (
                    SELECT Subordinate {
                        @note := 'sub note 10',
                    }
                    FILTER .name = 'nested sub 10'
                    LIMIT 1
                )
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT InsertTest {
                name,
                sub: {
                    name,
                    @note
                }
            } FILTER
                .name = 'insert nested 10'
        `,
      [
            {
              "name": "insert nested 10",
              "sub": {
                "name": "nested sub 10",
                "@note": "sub note 10",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_11", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'linkprop test target 6'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (
                    INSERT InsertTest {
                        name := 'insert nested 6',
                        l2 := 0,
                        subordinates := (
                            SELECT (SELECT Subordinate LIMIT 1) {
                                @comment := 'comment 6'
                            }
                        )
                    }
                ) {
                    subordinates: { name, @comment }
                }
            `,
      [
            {
              "subordinates": [
                {
                  "name": "linkprop test target 6",
                  "@comment": "comment 6",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_nested_12", () => {
    h.script(
      `
            ALTER TYPE InsertTest
              ALTER LINK subordinates
                ALTER PROPERTY comment
                  SET default := "!!!";
        `
    );
    h.script(
      `
            INSERT Subordinate {
                name := 'linkprop test target 6'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (
                    INSERT InsertTest {
                        name := 'insert nested 6',
                        l2 := 0,
                        subordinates := (
                            SELECT Subordinate LIMIT 1
                        )
                    }
                ) {
                    subordinates: { name, @comment }
                }
            `,
      [
            {
              "subordinates": [
                {
                  "name": "linkprop test target 6",
                  "@comment": "!!!",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_01", () => {
    h.script(
      `
            INSERT DefaultTest1 {
                foo := 'ret1',
                num := 1,
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest1 {
                    foo := 'ret2',
                    num := 2
                }) {foo};
            `,
      [
            {
              "foo": "ret2",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest1 {
                    foo := 'ret3',
                    num := 3
                }).num;
            `,
      [3]
    );
  });

  it("test_edgeql_insert_returning_02", () => {
    assertQueryResult(
      h,
      `
                INSERT DefaultTest1 {
                    foo := 'ret1',
                    num := 1,
                };
            `,
      [
            {
              "id": "UUID",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest1 {
                    foo := 'ret2',
                    num := 2
                }) {foo};
            `,
      [
            {
              "foo": "ret2",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest1 {
                    foo := 'ret3',
                    num := 3
                }).num;
            `,
      [3]
    );
    let obj = queryRows<Record<string, unknown>>(h, "\n                INSERT DefaultTest1 {\n                    foo := 'ret1',\n                    num := 1,\n                };\n            ");
    expect(Object.prototype.hasOwnProperty.call(obj[0], "id")).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(obj[0], "__tid__")).toBeTruthy();
    expect(obj[0].__tname__).toEqual("default::DefaultTest1");
  });

  it("test_edgeql_insert_returning_03", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'sub returning 3'
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (INSERT InsertTest {
                        name := 'insert nested returning 3',
                        l2 := 0,
                        subordinates := (
                            SELECT Subordinate
                            FILTER Subordinate.name = 'sub returning 3'
                        )
                    })
                SELECT I {
                    name,
                    l2,
                    subordinates: {
                        name
                    }
                };
            `,
      [
            {
              "name": "insert nested returning 3",
              "l2": 0,
              "subordinates": [
                {
                  "name": "sub returning 3",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_04", () => {
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest1 {
                    foo := 'DT returning 4',
                    num := 33
                }) {foo, num};
            `,
      [
            {
              "foo": "DT returning 4",
              "num": 33,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (INSERT InsertTest {
                        name := 'IT returning 4',
                        l2 := 9999
                    })
                SELECT
                    DefaultTest1 {foo, num}
                    FILTER DefaultTest1.num > I.l2;
            `,
      []
    );
    assertQueryResult(
      h,
      `
                WITH
                    I := (INSERT InsertTest {
                        name := 'IT returning 4',
                        l2 := 9
                    })
                SELECT
                    DefaultTest1 {foo, num}
                    FILTER DefaultTest1.num > I.l2;
            `,
      [
            {
              "foo": "DT returning 4",
              "num": 33,
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_05", () => {
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest1 {
                    foo := 'DT returning 5'
                }) {
                    foo,
                    # test that num will show up with the default value
                    num,
                };
            `,
      [
            {
              "foo": "DT returning 5",
              "num": 42,
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_06", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'DefaultTest5/Sub'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest5 {
                    name := 'ret6/DT5'
                }) {
                    name,
                    # test that other will show up with the default value
                    other: {
                        name
                    },
                };
            `,
      [
            {
              "name": "ret6/DT5",
              "other": {
                "name": "DefaultTest5/Sub",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_07", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'DefaultTest5/Sub'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest6 {
                    name := 'ret7/DT6'
                }) {
                    name,
                    # test that other will show up with the default value
                    other: {
                        name,
                        other: {
                            name
                        },
                    },
                };
            `,
      [
            {
              "name": "ret7/DT6",
              "other": {
                "name": "DefaultTest6/5",
                "other": {
                  "name": "DefaultTest5/Sub",
                },
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_08", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'DefaultTest5/Sub'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (INSERT DefaultTest7 {
                    name := 'ret8/DT7'
                }) {
                    name,
                    # test that other will show up with the default value
                    other: {
                        name,
                        other: {
                            name,
                            other: {
                                name,
                            },
                        },
                    },
                };
            `,
      [
            {
              "name": "ret8/DT7",
              "other": {
                "name": "DefaultTest7/6",
                "other": {
                  "name": "DefaultTest6/5",
                  "other": {
                    "name": "DefaultTest5/Sub",
                  },
                },
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_09", () => {
    assertQueryResult(
      h,
      `
                WITH N := (INSERT Note {name := "!" }),
                SELECT ((
                    INSERT Person {
                        name := "Phil Emarg",
                        notes := N,
                    }
                )) { name, notes: {name} };

            `,
      [
            {
              "name": "Phil Emarg",
              "notes": [
                {
                  "name": "!",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH S := (INSERT Subordinate { name := "sub" }),
                     N := (INSERT Note {name := "!", subject := S }),
                SELECT ((
                    INSERT Person {
                        name := "Madeline Hatch",
                        notes := N,
                    }
                )) { name, notes: {name, subject[IS Subordinate]: {name}} };

            `,
      [
            {
              "name": "Madeline Hatch",
              "notes": [
                {
                  "name": "!",
                  "subject": {
                    "name": "sub",
                  },
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH N := (INSERT Note {name := "!" }),
                 P := (INSERT Person {
                    name := "Emmanuel Villip",
                    notes := N
                 }),
            SELECT ((
                INSERT PersonWrapper { person := P }
            )) { person: { name, notes: {name} } };
            `,
      [
            {
              "person": {
                "name": "Emmanuel Villip",
                "notes": [
                  {
                    "name": "!",
                  },
                ],
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_10", () => {
    assertQueryResult(
      h,
      `
                SELECT
                (INSERT Note {
                     name := "test",
                     subject := (INSERT Subordinate { name := "sub" })})
                { name, subject };
            `,
      [
            {
              "name": "test",
              "subject": {
                "id": "str",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_11", () => {
    h.script(
      `
            INSERT Note { name := "note", note := "a" };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                (INSERT Person {
                     name := "test",
                     notes := (
                         UPDATE Note FILTER .name = "note"
                         SET { note := "b" }
                     )
                })
                { name, notes: {note} };
            `,
      [
            {
              "name": "test",
              "notes": [
                {
                  "note": "b",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_12", () => {
    h.script(
      `
            INSERT DerivedNote { name := "note", note := "a" };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                (INSERT Person {
                     name := "test",
                     notes := (
                         UPDATE DerivedNote FILTER .name = "note"
                         SET { note := "b" }
                     )
                })
                { name, notes: {note} };
            `,
      [
            {
              "name": "test",
              "notes": [
                {
                  "note": "b",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_13", () => {
    h.script(
      `
            INSERT DerivedNote { name := "dnote", note := "a" };
            INSERT DerivedNote { name := "anote", note := "some note" };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT
            (INSERT Person {
                name := "test",
                notes := assert_distinct({
                    (SELECT Note FILTER .name = "anote"),
                    (INSERT DerivedNote { name := "new note", note := "hi" }),
                    (UPDATE Note FILTER .name = "dnote" SET { note := "b" })
                })
            })
            { name, notes: {name, note} ORDER BY .name };
            `,
      [
            {
              "name": "test",
              "notes": [
                {
                  "name": "anote",
                  "note": "some note",
                },
                {
                  "name": "dnote",
                  "note": "b",
                },
                {
                  "name": "new note",
                  "note": "hi",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_14", () => {
    h.script(
      `
            INSERT DerivedNote { name := "dnote", note := "a" };
            INSERT DerivedNote { name := "anote", note := "some note" };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT
            (INSERT Person {
                name := "test",
                notes := assert_distinct({
                    (SELECT Note FILTER .name = "anote"),
                    (INSERT DerivedNote { name := "new note", note := "hi" }),
                    (UPDATE Note FILTER .name = "dnote" SET { note := "b" })
                })
            })
            {
                name,
                dnotes := (SELECT .notes[IS DerivedNote] {name, note}
                           ORDER BY .name)
            }
            `,
      [
            {
              "name": "test",
              "dnotes": [
                {
                  "name": "anote",
                  "note": "some note",
                },
                {
                  "name": "dnote",
                  "note": "b",
                },
                {
                  "name": "new note",
                  "note": "hi",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_returning_15", () => {
    h.script(
      `
            alter type Person {
                create access policy ok allow all using (true);
            };
        `
    );
    assertQueryResult(
      h,
      `
            WITH P := (INSERT Person {name := "Emmanuel Villip"}),
            SELECT ((
                INSERT PersonWrapper { person := P }
            )) { person: { name } };
            `,
      [
            {
              "person": {
                "name": "Emmanuel Villip",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_conflict_policy_01", () => {
    h.script(
      `
            create type Tgt {
                create access policy test allow all using (true);
            };
            create type Src {
                create link tgt -> Tgt;
                create constraint exclusive on (.tgt);
            };
        `
    );
    h.script(
      `
            INSERT Src {
                tgt := (SELECT Tgt LIMIT 1)
            }
            UNLESS CONFLICT ON (.tgt)
        `
    );
  });

  it("test_edgeql_insert_conflict_policy_02", () => {
    h.script(
      `
            alter type Person {
                create access policy yes allow all using (true);
                create access policy no deny select using (true);
            };
        `
    );
    h.script(
      `
            insert Person { name := "test" }
            unless conflict on (.name) else (Person);
        `
    );
    expect(() => {
      h.script(
        `
            insert Person { name := "test" }
            unless conflict on (.name) else (Person);
        `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    h.script(
      `
            insert Person {
                name := "test2", note := (insert Note { name := "" }) }
            unless conflict on (.name) else (Person);
        `
    );
    expect(() => {
      h.script(
        `
            insert Person {
                name := "test2", note := (insert Note { name := "" }) }
            unless conflict on (.name) else (Person);
        `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_policy_cast", () => {
    h.script(
      `
            create global sub_id -> uuid;
            create global sub := <Subordinate>(global sub_id);
            alter type Note {
                create access policy asdf allow all using (
                    (.subject in global sub) ?? false
                )
            };
        `
    );
    let sub = h.query("\n            insert Subordinate { name := \"asdf\" };\n        ");
    expect(() => {
      h.script(
        `
                insert Person { notes := (insert Note { name := "" }) };
            `
      );
    }).toThrow(new RegExp("violation on insert of default::Note"));
    expect(() => {
      h.script(
        `
                insert Person {
                    notes := (insert Note {
                        name := "",
                        subject := assert_single(
                          (select Subordinate filter .name = 'asdf'))
                    })
                };
            `
      );
    }).toThrow(new RegExp("violation on insert of default::Note"));
    h.script(
      `
            set global sub_id := <uuid>$0
        `
    );
    h.script(
      `
            insert Person {
                notes := (insert Note {
                    name := "",
                    subject := assert_single(
                      (select Subordinate filter .name = 'asdf'))
                })
            };
        `
    );
  });

  it("test_edgeql_insert_for_01", () => {
    h.script(
      `
            FOR x IN {3, 5, 7, 2}
            INSERT InsertTest {
                name := 'insert for 1',
                l2 := x,
            };

            FOR Q IN (SELECT InsertTest{foo := 'foo' ++ <str> InsertTest.l2}
                      FILTER .name = 'insert for 1')
            INSERT InsertTest {
                name := 'insert for 1',
                l2 := 35 % Q.l2,
                l3 := Q.foo,
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest{name, l2, l3}
                FILTER .name = 'insert for 1'
                ORDER BY .l2 THEN .l3;
            `,
      [
            {
              "name": "insert for 1",
              "l2": 0,
              "l3": "foo5",
            },
            {
              "name": "insert for 1",
              "l2": 0,
              "l3": "foo7",
            },
            {
              "name": "insert for 1",
              "l2": 1,
              "l3": "foo2",
            },
            {
              "name": "insert for 1",
              "l2": 2,
              "l3": "foo3",
            },
            {
              "name": "insert for 1",
              "l2": 2,
              "l3": "test",
            },
            {
              "name": "insert for 1",
              "l2": 3,
              "l3": "test",
            },
            {
              "name": "insert for 1",
              "l2": 5,
              "l3": "test",
            },
            {
              "name": "insert for 1",
              "l2": 7,
              "l3": "test",
            },
          ]
    );
  });

  it("test_edgeql_insert_for_02", () => {
    h.script(
      `
            # create 10 DefaultTest3 objects, each object is defined
            # as having a randomly generated value for 'foo'
            FOR x IN {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
            UNION (INSERT DefaultTest3);
        `
    );
    assertQueryResult(
      h,
      `
                # statistically, randomly generated value for 'foo'
                # should not be identical for all 10 records
                WITH
                    DT3 := DefaultTest3
                SELECT count(
                    DefaultTest3 FILTER DefaultTest3.foo != DT3.foo) > 0;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_insert_for_03", () => {
    h.script(
      `
            # Create 5 DefaultTest4 objects. The default value for
            # 'bar' is technically evaluated for each object, but
            # because it is deterministic it will be same for all 5
            # new objects.
            FOR x IN {1, 2, 3, 4, 5}
            UNION (INSERT DefaultTest4);
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DefaultTest4.bar
                ORDER BY DefaultTest4.bar;
            `,
      [0, 0, 0, 0, 0]
    );
  });

  it("test_edgeql_insert_for_04", () => {
    h.script(
      `
            INSERT InsertTest {
                name := 'nested-insert-for',
                l2 := 999,
                subordinates := (
                    FOR x IN {('sub1', 'first'), ('sub2', 'second')}
                    INSERT Subordinate {
                        name := x.0,
                        @comment := x.1,
                    }
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    subordinates: {
                        name,
                        @comment,
                    } ORDER BY .name
                }
                FILTER .name = 'nested-insert-for'
            `,
      [
            {
              "subordinates": [
                {
                  "name": "sub1",
                  "@comment": "first",
                },
                {
                  "name": "sub2",
                  "@comment": "second",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_for_06", () => {
    let res = queryRows(h, "\n            FOR a IN {\"a\", \"b\"}\n            FOR b IN {\"c\", \"d\"}\n            INSERT Note {name := b};\n        ");
    expect((res).length).toEqual(4);
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      ["c", "c", "d", "d"]
    );
  });

  it("test_edgeql_insert_for_07", () => {
    let res = queryRows(h, "\n            FOR a IN {\"a\", \"b\"}\n            FOR b IN {a++\"c\", a++\"d\"}\n            INSERT Note {name := b};\n        ");
    expect((res).length).toEqual(4);
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      ["ac", "ad", "bc", "bd"]
    );
  });

  it("test_edgeql_insert_for_08", () => {
    let res = queryRows(h, "\n            FOR a IN {\"a\", \"b\"}\n            FOR b IN {\"a\", \"b\"}\n            FOR c IN {a++b++\"a\", a++b++\"b\"}\n            INSERT Note {name := c};\n        ");
    expect((res).length).toEqual(8);
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      [
            "aaa",
            "aab",
            "aba",
            "abb",
            "baa",
            "bab",
            "bba",
            "bbb",
          ]
    );
  });

  it("test_edgeql_insert_for_09", () => {
    let res = queryRows(h, "\n            FOR a in {\"a\", \"b\"} UNION (\n                FOR b in {\"a\", \"b\"} UNION (\n                    FOR c in {\"a\", \"b\"} UNION (\n                        INSERT Note {name := a++b++c})));\n        ");
    expect((res).length).toEqual(8);
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      [
            "aaa",
            "aab",
            "aba",
            "abb",
            "baa",
            "bab",
            "bba",
            "bbb",
          ]
    );
  });

  it("test_edgeql_insert_for_10", () => {
    let res = queryRows(h, "\n            FOR a in {\"a\", \"b\"} UNION (\n                FOR b in {\"a\", \"b\"} UNION (\n                    FOR c in {\"a\", \"b\"} UNION (\n                        INSERT Note {name := a++b})));\n        ");
    expect((res).length).toEqual(8);
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      [
            "aa",
            "aa",
            "ab",
            "ab",
            "ba",
            "ba",
            "bb",
            "bb",
          ]
    );
  });

  it("test_edgeql_insert_for_11", () => {
    let res = queryRows(h, "\n            FOR a in {\"a\", \"b\"} UNION (\n                FOR b in {\"a\", \"b\"} UNION (\n                    FOR c in {\"a\", \"b\"} UNION (\n                        INSERT Note {name := a})));\n        ");
    expect((res).length).toEqual(8);
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      [
            "a",
            "a",
            "a",
            "a",
            "b",
            "b",
            "b",
            "b",
          ]
    );
  });

  it("test_edgeql_insert_for_12", () => {
    assertQueryResult(
      h,
      `
                FOR a in {"foo", "bar"} UNION (
                    (a,(INSERT Note {name:=a}))
                )
            `,
      unorderedBag([
            [
              "bar",
              {},
            ],
            [
              "foo",
              {},
            ],
          ])
    );
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      ["bar", "foo"]
    );
  });

  it("test_edgeql_insert_for_13", () => {
    assertQueryResult(
      h,
      `
                FOR a in {"foo", "bar"} UNION (
                    SELECT (INSERT Note {name:=a}) {name}
                )
            `,
      unorderedBag([
            {
              "name": "bar",
            },
            {
              "name": "foo",
            },
          ])
    );
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      ["bar", "foo"]
    );
  });

  it("test_edgeql_insert_for_14", () => {
    assertQueryResult(
      h,
      `
                FOR a in {"a", "b"} UNION (
                    FOR b in {"c", "d"} UNION (
                        (a, b, (INSERT Note {name:=a++b}).name)
                    )
                )
            `,
      unorderedBag([
            ["a", "c", "ac"],
            ["a", "d", "ad"],
            ["b", "c", "bc"],
            ["b", "d", "bd"],
          ])
    );
    assertQueryResult(
      h,
      `
                SELECT Note.name
                ORDER BY Note.name;
            `,
      ["ac", "ad", "bc", "bd"]
    );
  });

  it("test_edgeql_insert_for_15", () => {
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                INSERT Person {name := noob ++ "!",
                               notes := (INSERT Note {name := noob})});
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { name, notes: {name} } ORDER BY .name DESC`,
      [
            {
              "name": "Phil Emarg!",
              "notes": [
                {
                  "name": "Phil Emarg",
                },
              ],
            },
            {
              "name": "Madeline Hatch!",
              "notes": [
                {
                  "name": "Madeline Hatch",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_for_16", () => {
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                INSERT Person {name := noob,
                               notes := (
                    FOR suffix in {"?", "!"} UNION (
                        INSERT Note {name := noob ++ suffix}))});
        `
    );
    assertQueryResult(
      h,
      `SELECT Person {
               name, notes: {name} ORDER BY .name DESC} ORDER BY .name DESC`,
      [
            {
              "name": "Phil Emarg",
              "notes": [
                {
                  "name": "Phil Emarg?",
                },
                {
                  "name": "Phil Emarg!",
                },
              ],
            },
            {
              "name": "Madeline Hatch",
              "notes": [
                {
                  "name": "Madeline Hatch?",
                },
                {
                  "name": "Madeline Hatch!",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_for_17", () => {
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                INSERT Person {name := noob,
                               notes := (SELECT (
                    FOR suffix in {"?", "!"} UNION (
                        INSERT Note {name := noob ++ suffix})))});
        `
    );
    assertQueryResult(
      h,
      `SELECT Person {
               name, notes: {name} ORDER BY .name DESC} ORDER BY .name DESC`,
      [
            {
              "name": "Phil Emarg",
              "notes": [
                {
                  "name": "Phil Emarg?",
                },
                {
                  "name": "Phil Emarg!",
                },
              ],
            },
            {
              "name": "Madeline Hatch",
              "notes": [
                {
                  "name": "Madeline Hatch?",
                },
                {
                  "name": "Madeline Hatch!",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_for_18", () => {
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                INSERT Person {name := noob ++ "!",
                               note := (INSERT Note {name := noob})});
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { name, note: {name} } ORDER BY .name DESC`,
      [
            {
              "name": "Phil Emarg!",
              "note": {
                "name": "Phil Emarg",
              },
            },
            {
              "name": "Madeline Hatch!",
              "note": {
                "name": "Madeline Hatch",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_for_19", () => {
    h.script(
      `
            FOR t IN array_unpack(<array<InsertTest>>[])
            UNION (
                INSERT InsertTest {
                    name := t.name, l2 := t.l2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT InsertTest`,
      []
    );
  });

  it("test_edgeql_insert_for_20", () => {
    h.script(
      `
            INSERT InsertTest { name := "a", l2 := 1 };
        `
    );
    h.script(
      `
            FOR t IN array_unpack([InsertTest])
            UNION (
                INSERT InsertTest {
                    name := t.name ++ "!", l2 := t.l2 + 1,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT InsertTest { name, l2 } ORDER BY .l2`,
      [
            {
              "name": "a",
              "l2": 1,
            },
            {
              "name": "a!",
              "l2": 2,
            },
          ]
    );
  });

  it("test_edgeql_insert_for_21", () => {
    h.script(
      `
            FOR t IN array_unpack(<array<tuple<InsertTest>>>[])
            UNION (
                INSERT InsertTest {
                    name := t.0.name, l2 := t.0.l2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT InsertTest`,
      []
    );
  });

  it("test_edgeql_insert_for_22", () => {
    h.script(
      `
            INSERT InsertTest { name := "a", l2 := 1 };
        `
    );
    h.script(
      `
            FOR t IN array_unpack([(InsertTest,)])
            UNION (
                INSERT InsertTest {
                    name := t.0.name ++ "!", l2 := t.0.l2 + 1,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT InsertTest { name, l2 } ORDER BY .l2`,
      [
            {
              "name": "a",
              "l2": 1,
            },
            {
              "name": "a!",
              "l2": 2,
            },
          ]
    );
  });

  it("test_edgeql_insert_for_23", () => {
    h.script(
      `
            INSERT Subordinate { name := "a" }
        `
    );
    assertQueryResult(
      h,
      `
            for x in {Subordinate, Subordinate} union (
              (x { name }, (insert Note { name := '', subject := x }))
            );
            `,
      [
            [
              {
                "name": "a",
              },
              {},
            ],
            [
              {
                "name": "a",
              },
              {},
            ],
          ]
    );
    assertQueryResult(
      h,
      `
            for x in {Subordinate, Subordinate} union (
              (x { name }, (insert InsertTest { l2 := 0, sub := x }))
            );
            `,
      [
            [
              {
                "name": "a",
              },
              {},
            ],
            [
              {
                "name": "a",
              },
              {},
            ],
          ]
    );
  });

  it("test_edgeql_insert_for_bad_01", () => {
    expect(() => {
      h.script(
        `
                SELECT (Person,
                        (FOR x in Person UNION (
                             INSERT Note {name := x.name})));
            `
      );
    }).toThrow(new RegExp("cannot reference correlated set"));
  });

  it("test_edgeql_insert_for_bad_02", () => {
    expect(() => {
      h.script(
        `
                SELECT (Person,
                        (FOR x in Person UNION (
                             SELECT (INSERT Note {name := x.name}))));
            `
      );
    }).toThrow(new RegExp("cannot reference correlated set"));
  });

  it("test_edgeql_insert_for_bad_03", () => {
    expect(() => {
      h.script(
        `
                SELECT ((FOR x in Person UNION (
                             INSERT Note {name := x.name})),
                        Person);
            `
      );
    }).toThrow(new RegExp("cannot reference correlated set"));
  });

  it("test_edgeql_insert_for_bad_04", () => {
    expect(() => {
      h.script(
        `
                SELECT (Person,
                        (FOR x in Person UNION (
                             SELECT (
                                 20,
                                 (FOR y in {"hello", "world"} UNION (
                                  INSERT Note {name := y ++ x.name}))))));
            `
      );
    }).toThrow(new RegExp("cannot reference correlated set"));
  });

  it("test_edgeql_insert_for_iterator_01", () => {
    assertQueryResult(
      h,
      `
                with noobs := {
                  (insert InsertTest { l2 := 1 }),
                },
                for n in noobs select assert_exists((select n filter true));
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
                with noobs := {
                  ((insert InsertTest { l2 := 1 }), "bar"),
                  ((insert InsertTest { l2 := 2 }), "eggs"),
                },
                for n in noobs select n.0;
            `,
      [
            {},
            {},
          ]
    );
  });

  it("test_edgeql_insert_default_01", () => {
    h.script(
      `
            # create 10 DefaultTest3 objects, each object is defined
            # as having a randomly generated value for 'foo'
            INSERT DefaultTest3;
            INSERT DefaultTest3;
            INSERT DefaultTest3;
            INSERT DefaultTest3;
            INSERT DefaultTest3;

            INSERT DefaultTest3;
            INSERT DefaultTest3;
            INSERT DefaultTest3;
            INSERT DefaultTest3;
            INSERT DefaultTest3;
        `
    );
    assertQueryResult(
      h,
      `
                # statistically, randomly generated value for 'foo'
                # should not be identical for all 10 records
                WITH
                    DT3 := DefaultTest3
                SELECT count(
                    DefaultTest3 FILTER DefaultTest3.foo != DT3.foo) > 0;
            `,
      unorderedSet([true])
    );
  });

  it("test_edgeql_insert_default_02", () => {
    h.script(
      `
            # by default the 'bar' value is simply going to be "indexing" the
            # created objects
            INSERT DefaultTest4;
            INSERT DefaultTest4;
            INSERT DefaultTest4;
            INSERT DefaultTest4;
            INSERT DefaultTest4;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DefaultTest4 { bar }
                ORDER BY DefaultTest4.bar;
            `,
      [
            {
              "bar": 0,
            },
            {
              "bar": 1,
            },
            {
              "bar": 2,
            },
            {
              "bar": 3,
            },
            {
              "bar": 4,
            },
          ]
    );
  });

  it("test_edgeql_insert_default_03", () => {
    h.script(
      `
            # by default the 'bar' value is simply going to be "indexing" the
            # created objects
            INSERT DefaultTest4 { bar:= 10 };
            INSERT DefaultTest4;
            INSERT DefaultTest4;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DefaultTest4 { bar }
                ORDER BY DefaultTest4.bar;
            `,
      [
            {
              "bar": 1,
            },
            {
              "bar": 2,
            },
            {
              "bar": 10,
            },
          ]
    );
  });

  it("test_edgeql_insert_default_04", () => {
    h.script(
      `
            # by default the 'bar' value is simply going to be "indexing" the
            # created objects
            INSERT DefaultTest4;
            INSERT DefaultTest4;
            INSERT DefaultTest4 { bar:= 0 };
            INSERT DefaultTest4;
            INSERT DefaultTest4;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DefaultTest4 { bar }
                ORDER BY DefaultTest4.bar;
            `,
      [
            {
              "bar": 0,
            },
            {
              "bar": 0,
            },
            {
              "bar": 1,
            },
            {
              "bar": 3,
            },
            {
              "bar": 4,
            },
          ]
    );
  });

  it("test_edgeql_insert_default_05", () => {
    h.script(
      `
            # The 'number' property is supposed to be
            # self-incrementing and read-only.
            INSERT DefaultTest8;
            INSERT DefaultTest8;
            INSERT DefaultTest8;
        `
    );
    try {
      assertQueryResult(
        h,
        `
                    SELECT DefaultTest8.number;
                `,
        unorderedSet([1, 2, 3])
      );
    } catch (_err) {
      throw _err;
    }
  });

  it("test_edgeql_insert_default_06", () => {
    let res = queryRows<Record<string, unknown>>(h, "\n            INSERT DefaultTest1;\n        ");
    expect(((res).length === 1)).toBeTruthy();
    let obj = res[0];
    expect(!Object.prototype.hasOwnProperty.call(obj, "num")).toBeTruthy();
  });

  it("test_edgeql_insert_default_07", () => {
    h.query(
      `
            create type Foo {
                create property n -> int32;
                create property a -> str;
                create property b -> str;
                create property c -> str;
            };

            alter type Foo {
                alter property a { set default := 'a=' ++ .b };
                alter property b { set default := 'b=' ++ .c };
                alter property c { set default := 'c=' ++ .a };
            };
        `
    );
    h.query(
      `insert Foo { n := 0, a := 'given' };`
    );
    h.query(
      `insert Foo { n := 1, b := 'given' };`
    );
    h.query(
      `insert Foo { n := 2, c := 'given' };`
    );
    assertQueryResult(
      h,
      `select Foo { a, b, c } order by .n`,
      [
            {
              "a": "given",
              "b": "b=c=given",
              "c": "c=given",
            },
            {
              "a": "a=given",
              "b": "given",
              "c": "c=a=given",
            },
            {
              "a": "a=b=given",
              "b": "b=given",
              "c": "given",
            },
          ]
    );
  });

  it("test_edgeql_insert_default_08", () => {
    h.query(
      `
            create type Bar {
                create property f -> float64;
                create property g -> float64 {
                    set default := .f
                };
            };
            `
    );
    h.query(
      `insert Bar { f := random() };`
    );
    let res = queryRows<{ f: unknown; g: unknown }>(h, "select Bar { f, g }");
    expect((res[0].f === res[0].g)).toBeTruthy();
  });

  it("test_edgeql_insert_default_09", () => {
    expect(() => {
      h.script(
        `
                type Hello {
                    multi property b -> int32;
                    property a -> int32 {
                        default := count(.b);
                    };
                }
            `
      );
    }).toThrow(new RegExp("default expression cannot refer to multi properties"));
    expect(() => {
      h.script(
        `
                type World {
                    property w -> int32;
                }

                type Hello {
                    link world -> World;

                    property hello -> int32 {
                        default := .world.w;
                    };
                }
            `
      );
    }).toThrow(new RegExp("default expression cannot refer to links"));
    expect(() => {
      h.script(
        `
                type World {
                    property w -> int32;
                }

                type Hello {
                    multi link world -> World;

                    property hello -> int32 {
                        default := count(.world);
                    };
                }
            `
      );
    }).toThrow(new RegExp("default expression cannot refer to links"));
  });

  it("test_edgeql_insert_dunder_default_01", () => {
    h.script(
      `
            INSERT DunderDefaultTest01 { a := 1, c := __default__ };
            INSERT DunderDefaultTest01 { a := 1, c := __default__ + 3 };
            INSERT DunderDefaultTest01 {
                a := 1,
                c := __default__ + __default__,
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DunderDefaultTest01 { a, b, c };
            `,
      [
            {
              "a": 1,
              "b": 2,
              "c": 1,
            },
            {
              "a": 1,
              "b": 2,
              "c": 4,
            },
            {
              "a": 1,
              "b": 2,
              "c": 2,
            },
          ]
    );
    expect(() => {
      h.script(
        `
                INSERT DunderDefaultTest01 { a := __default__ };
            `
      );
    }).toThrow(new RegExp("__default__ cannot be used in this expression"));
    expect(() => {
      h.script(
        `
                INSERT DunderDefaultTest01 { a := 1, b := __default__ };
            `
      );
    }).toThrow(new RegExp("__default__ cannot be used in this expression"));
  });

  it("test_edgeql_insert_dunder_default_02", () => {
    expect(() => {
      h.script(
        `
                INSERT DunderDefaultTest02_B {
                    default_with_insert := __default__
                };
            `
      );
    }).toThrow(new RegExp("__default__ cannot be used in this expression"));
    expect(() => {
      h.script(
        `
                INSERT DunderDefaultTest02_B {
                    default_with_update := __default__
                };
            `
      );
    }).toThrow(new RegExp("__default__ cannot be used in this expression"));
    expect(() => {
      h.script(
        `
                INSERT DunderDefaultTest02_B {
                    default_with_delete := __default__
                };
            `
      );
    }).toThrow(new RegExp("__default__ cannot be used in this expression"));
    h.script(
      `
            INSERT DunderDefaultTest02_A { a := 1 };
            INSERT DunderDefaultTest02_A { a := 2 };
            INSERT DunderDefaultTest02_A { a := 3 };
            INSERT DunderDefaultTest02_A { a := 4 };
            INSERT DunderDefaultTest02_B {
                default_with_insert := (
                    select DunderDefaultTest02_A
                    filter DunderDefaultTest02_A.a = 1
                ),
                default_with_update := (
                    select DunderDefaultTest02_A
                    filter DunderDefaultTest02_A.a = 2
                ),
                default_with_delete := (
                    select DunderDefaultTest02_A
                    filter DunderDefaultTest02_A.a = 3
                ),
                default_with_select := __default__
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DunderDefaultTest02_B {
                    a := .default_with_select.a
                };
            `,
      [
            {
              "a": [4],
            },
          ]
    );
  });

  it("test_edgeql_insert_dunder_default_03", () => {
    h.script(
      `
            INSERT DunderDefaultTest03_A {
                x := (
                    INSERT DunderDefaultTest03_C { x := __default__ }
                ).x
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DunderDefaultTest03_A { x };
            `,
      [
            {
              "x": 2,
            },
          ]
    );
    h.script(
      `
            INSERT DunderDefaultTest03_B {
                x := (
                    INSERT DunderDefaultTest03_C { x := __default__ }
                ).x
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DunderDefaultTest03_B { x };
            `,
      [
            {
              "x": 2,
            },
          ]
    );
    expect(() => {
      h.script(
        `
                INSERT DunderDefaultTest03_B {
                    x := (
                        INSERT DunderDefaultTest03_A { x := __default__ }
                    ).x
                };
            `
      );
    }).toThrow(new RegExp("__default__ cannot be used in this expression"));
  });

  it("test_edgeql_insert_dunder_default_04", () => {
    h.script(
      `
            INSERT DunderDefaultTest04_A { x := 1 };
        `
    );
    h.script(
      `
            INSERT DunderDefaultTest04_B {
                x := 2,
                l := __default__,
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DunderDefaultTest04_B { x, l: { x } };
            `,
      [
            {
              "x": 2,
              "l": {
                "x": 1,
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_as_expr_01", () => {
    h.script(
      `
            # insert several objects, then annotate one of the inserted batch
            FOR x IN {(
                    SELECT _i := (
                        FOR y IN {3, 5, 7, 2}
                        UNION (INSERT InsertTest {
                            name := 'insert expr 1',
                            l2 := y
                        })
                    ) ORDER BY _i.l2 DESC LIMIT 1
                )}
            UNION (INSERT Note {
                name := 'insert expr 1',
                note := 'largest ' ++ <str>x.l2,
                subject := x
            });
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    InsertTest {
                        name,
                        l2,
                        l3,
                        subject := .<subject[IS Note] {
                            name,
                            note,
                        }
                    }
                FILTER .name = 'insert expr 1'
                ORDER BY .l2;
            `,
      [
            {
              "name": "insert expr 1",
              "l2": 2,
              "l3": "test",
              "subject": [],
            },
            {
              "name": "insert expr 1",
              "l2": 3,
              "l3": "test",
              "subject": [],
            },
            {
              "name": "insert expr 1",
              "l2": 5,
              "l3": "test",
              "subject": [],
            },
            {
              "name": "insert expr 1",
              "l2": 7,
              "l3": "test",
              "subject": [
                {
                  "name": "insert expr 1",
                  "note": "largest 7",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_polymorphic_01", () => {
    h.script(
      `
            INSERT Directive {
                args := (INSERT InputValue {
                    val := "something"
                }),
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Callable {
                    args: {
                        val
                    }
                };
            `,
      [
            {
              "args": [
                {
                  "val": "something",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Field {
                    args: {
                        val
                    }
                };
            `,
      []
    );
    assertQueryResult(
      h,
      `
                SELECT Directive {
                    args: {
                        val
                    }
                };
            `,
      [
            {
              "args": [
                {
                  "val": "something",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT InputValue {
                    val
                };
            `,
      [
            {
              "val": "something",
            },
          ]
    );
  });

  it("test_edgeql_insert_linkprops_with_for_01", () => {
    h.script(
      `
            FOR i IN {'1', '2', '3'} UNION (
                INSERT Subordinate {
                    name := 'linkproptest ' ++ i
                }
            );

            INSERT InsertTest {
                l2 := 99,
                subordinates := DISTINCT(
                    FOR x IN {('a', '1'), ('b', '2'), ('c', '3')} UNION (
                        SELECT Subordinate {@comment := x.0}
                        FILTER .name[-1] = x.1
                    )
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    l2,
                    subordinates: {
                        name,
                        @comment,
                    } ORDER BY InsertTest.subordinates.name
                } FILTER .l2 = 99;
            `,
      [
            {
              "l2": 99,
              "subordinates": [
                {
                  "name": "linkproptest 1",
                  "@comment": "a",
                },
                {
                  "name": "linkproptest 2",
                  "@comment": "b",
                },
                {
                  "name": "linkproptest 3",
                  "@comment": "c",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_empty_01", () => {
    h.script(
      `
            INSERT InsertTest {
                l1 := {},
                l2 := 99,
                # l3 has a default value
                l3 := {},
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    l1,
                    l2,
                    l3
                };
            `,
      [
            {
              "l1": null,
              "l2": 99,
              "l3": null,
            },
          ]
    );
  });

  it("test_edgeql_insert_empty_02", () => {
    expect(() => {
      h.script(
        `
                INSERT InsertTest {
                    l1 := <datetime>{},
                    l2 := 99,
                };
                `
      );
    }).toThrow(new RegExp("invalid target.*std::datetime.*expecting 'std::int64'"));
  });

  it("test_edgeql_insert_empty_03", () => {
    expect(() => {
      h.script(
        `
                    INSERT InsertTest {
                        l2 := {},
                    };
                `
      );
    }).toThrow(new RegExp("missing value for required property"));
  });

  it("test_edgeql_insert_empty_04", () => {
    h.script(
      `
            INSERT InsertTest {
                l2 := 99,
                subordinates := {}
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT InsertTest {
                    l2,
                    subordinates
                };
            `,
      [
            {
              "l2": 99,
              "subordinates": [],
            },
          ]
    );
  });

  it("test_edgeql_insert_empty_05", () => {
    expect(() => {
      h.script(
        `
                INSERT InsertTest {
                    l2 := 99,
                    subordinates := <Object>{}
                };
                `
      );
    }).toThrow(new RegExp("invalid target for link.*std::Object.*expecting 'default::Subordinate'"));
  });

  it("test_edgeql_insert_abstract", () => {
    expect(() => {
      h.script(
        `                INSERT Object;
            `
      );
    }).toThrow(new RegExp("cannot insert into abstract object type 'std::Object'"));
  });

  it("test_edgeql_insert_alias", () => {
    h.script(
      `
            CREATE ALIAS Foo := (SELECT InsertTest);
        `
    );
    expect(() => {
      h.script(
        `                INSERT Foo;
            `
      );
    }).toThrow(new RegExp("cannot insert into expression alias 'default::Foo'"));
  });

  it("test_edgeql_insert_free_obj", () => {
    expect(() => {
      h.script(
        `                INSERT std::FreeObject;
            `
      );
    }).toThrow(new RegExp("free objects cannot be inserted"));
  });

  it("test_edgeql_insert_selfref_01", () => {
    expect(() => {
      h.script(
        `
                INSERT SelfRef {
                    name := 'myself',
                    ref := SelfRef
                };
            `
      );
    }).toThrow(new RegExp("self-referencing INSERTs are not allowed"));
  });

  it("test_edgeql_insert_selfref_02", () => {
    expect(() => {
      h.script(
        `
                INSERT SelfRef {
                    name := 'other'
                };

                INSERT SelfRef {
                    name := 'myself',
                    ref := (
                        SELECT SelfRef
                        FILTER .name = 'other'
                    )
                };
            `
      );
    }).toThrow(new RegExp("self-referencing INSERTs are not allowed"));
  });

  it("test_edgeql_insert_selfref_03", () => {
    expect(() => {
      h.script(
        `
                INSERT SelfRef {
                    name := 'other'
                };

                INSERT SelfRef {
                    name := 'myself',
                    ref := (
                        WITH X := SelfRef
                        SELECT X
                        FILTER .name = 'other'
                    )
                };
            `
      );
    }).toThrow(new RegExp("self-referencing INSERTs are not allowed"));
  });

  it("test_edgeql_insert_selfref_04", () => {
    h.script(
      `
            INSERT SelfRef {
                name := 'ok other'
            };

            INSERT SelfRef {
                name := 'ok myself',
                ref := (
                    SELECT DETACHED SelfRef
                    FILTER .name = 'ok other'
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT SelfRef {
                    name,
                    ref: {
                        name
                    }
                } ORDER BY .name;
            `,
      [
            {
              "name": "ok myself",
              "ref": [
                {
                  "name": "ok other",
                },
              ],
            },
            {
              "name": "ok other",
              "ref": [],
            },
          ]
    );
  });

  it("test_edgeql_insert_cardinality_01", () => {
    expect(() => {
      h.script(
        `

                INSERT Subordinate { name := 'sub1_cardinality_01'};
                INSERT Subordinate { name := 'sub2_cardinality_01'};
                INSERT Note {
                    name := 'note_cardinality_01',
                    subject := (
                        SELECT Subordinate
                        FILTER .name LIKE '%cardinality_01'
                    )
                };
            `
      );
    }).toThrow(new RegExp("single"));
  });

  it("test_edgeql_insert_derived_01", () => {
    h.script(
      `
            INSERT DerivedTest {
                name := 'insert derived 01',
                l2 := 0,
            };

            INSERT DerivedTest {
                name := 'insert derived 01',
                l3 := "Test\"1\"",
                l2 := 1
            };

            INSERT DerivedTest {
                name := 'insert derived 01',
                l3 := 'Test\'2\'',
                l2 := 2
            };

            INSERT DerivedTest {
                name := 'insert derived 01',
                l3 := '\"Test\'3\'\"',
                l2 := 3
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    DerivedTest {
                        l2, l3
                    }
                FILTER
                    DerivedTest.name = 'insert derived 01'
                ORDER BY
                    DerivedTest.l2;
            `,
      [
            {
              "l2": 0,
              "l3": "test",
            },
            {
              "l2": 1,
              "l3": "Test\"1\"",
            },
            {
              "l2": 2,
              "l3": "Test'2'",
            },
            {
              "l2": 3,
              "l3": "\"Test'3'\"",
            },
          ]
    );
  });

  it("test_edgeql_insert_derived_02", () => {
    h.script(
      `
            INSERT DerivedTest {
                name := 'insert derived 02',
                l2 := 0,
                sub :=  (
                    INSERT Subordinate {
                        name := 'nested derived sub 02'
                    }
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    DerivedTest {
                        name,
                        sub: {
                            name,
                            @note
                        }
                    }
                FILTER
                    .name = 'insert derived 02'
                ORDER BY
                    .l2;
            `,
      [
            {
              "name": "insert derived 02",
              "sub": {
                "name": "nested derived sub 02",
                "@note": null,
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_tuples_01", () => {
    assertQueryResult(
      h,
      `
                with noobs := {
                  ((insert InsertTest { l2 := 1 }), "bar"),
                  ((insert InsertTest { l2 := 2 }), "eggs"),
                },
                select noobs;
            `,
      [
            [
              {},
              "bar",
            ],
            [
              {},
              "eggs",
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                select {
                  ((insert InsertTest { l2 := 1 }), "bar"),
                  ((insert InsertTest { l2 := 2 }), "eggs"),
                }
            `,
      [
            [
              {},
              "bar",
            ],
            [
              {},
              "eggs",
            ],
          ]
    );
  });

  it("test_edgeql_insert_tuples_02", () => {
    assertQueryResult(
      h,
      `
                with noobs := {
                  ((insert InsertTest { l2 := 1 }), "bar"),
                  ((insert DerivedTest { l2 := 2 }), "eggs"),
                },
                select noobs;
            `,
      [
            [
              {},
              "bar",
            ],
            [
              {},
              "eggs",
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                select {
                  ((insert InsertTest { l2 := 1 }), "bar"),
                  ((insert DerivedTest { l2 := 2 }), "eggs"),
                }
            `,
      [
            [
              {},
              "bar",
            ],
            [
              {},
              "eggs",
            ],
          ]
    );
  });

  it("test_edgeql_insert_tuples_03", () => {
    assertQueryResult(
      h,
      `
                with noobs := {
                  ((insert InsertTest { l2 := 1 }), "bar"),
                  ((insert Person { name := "x" }), "eggs"),
                },
                select noobs;
            `,
      [
            [
              {},
              "bar",
            ],
            [
              {},
              "eggs",
            ],
          ]
    );
    assertQueryResult(
      h,
      `
                select {
                  ((insert InsertTest { l2 := 1 }), "bar"),
                  ((insert Person { name := "y" }), "eggs"),
                }
            `,
      [
            [
              {},
              "bar",
            ],
            [
              {},
              "eggs",
            ],
          ]
    );
  });

  it("test_edgeql_insert_tuples_04", () => {
    assertQueryResult(
      h,
      `
            with noobs := {
              ((insert Subordinate { name := "foo" }), "bar"),
              ((insert Subordinate { name := "spam" }), "eggs"),
            },
            select (insert InsertTest {
                l2 := 1,
                subordinates := assert_distinct(
                    noobs.0 { @comment := noobs.1 })
            }) { subordinates: {name, @comment} order by .name };
            `,
      [
            {
              "subordinates": [
                {
                  "name": "foo",
                  "@comment": "bar",
                },
                {
                  "name": "spam",
                  "@comment": "eggs",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select InsertTest { subordinates: {name, @comment} };
            `,
      [
            {
              "subordinates": [
                {
                  "name": "foo",
                  "@comment": "bar",
                },
                {
                  "name": "spam",
                  "@comment": "eggs",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_collection_01", () => {
    h.script(
      `
            INSERT CollectionTest {
                some_tuple := ('collection_01', 99),
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    CollectionTest {
                        some_tuple
                    }
                FILTER
                    .some_tuple.0 = 'collection_01';
            `,
      [
            {
              "some_tuple": ["collection_01", 99],
            },
          ]
    );
  });

  it("test_edgeql_insert_collection_02", () => {
    h.script(
      `
            INSERT CollectionTest {
                str_array := ['collection_02', '99'],
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    CollectionTest {
                        str_array
                    }
                FILTER
                    .str_array[0] = 'collection_02';
            `,
      [
            {
              "str_array": ["collection_02", "99"],
            },
          ]
    );
  });

  it("test_edgeql_insert_collection_03", () => {
    h.script(
      `
            INSERT CollectionTest {
                float_array := [3, 1234.5],
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    CollectionTest {
                        float_array
                    }
                FILTER
                    .float_array[0] = 3;
            `,
      [
            {
              "float_array": [3, 1234.5],
            },
          ]
    );
  });

  it("test_edgeql_insert_collection_04", () => {
    h.script(
      `
            INSERT CollectionTest {
                some_tuple := ('huh', -1),
                some_multi_tuple := ('foo', 0),
            };

            INSERT CollectionTest {
                some_tuple := ('foo', 0),
                some_multi_tuple := {('foo', 0), ('bar', 1)},
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT count(
                    CollectionTest FILTER ('bar', 1) IN .some_multi_tuple
                );
            `,
      [1]
    );
    assertQueryResult(
      h,
      `
                SELECT count(
                    CollectionTest FILTER .some_tuple IN .some_multi_tuple
                );
            `,
      [1]
    );
    assertQueryResult(
      h,
      `
                SELECT count(
                    CollectionTest FILTER ('foo', '0') IN
                    <tuple<str, str>>.some_multi_tuple
                );
            `,
      [2]
    );
  });

  it("test_edgeql_insert_collection_05", () => {
    h.script(
      `
            INSERT CollectionTest {
                str_array := [],
                float_array := [],
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    CollectionTest {
                        str_array,
                        float_array
                    }
                FILTER
                    len(.float_array) = 0;
            `,
      [
            {
              "str_array": [],
              "float_array": [],
            },
          ]
    );
  });

  it("test_edgeql_insert_correlated_bad_01", () => {
    expect(() => {
      h.script(
        `
                SELECT (
                    Subordinate,
                    (INSERT InsertTest {
                        name := 'insert bad',
                        l2 := 0,
                        subordinates := Subordinate
                    })
                );
            `
      );
    }).toThrow(new RegExp("cannot reference correlated set 'Subordinate' here"));
  });

  it("test_edgeql_insert_correlated_bad_02", () => {
    expect(() => {
      h.script(
        `
                SELECT (
                    (INSERT InsertTest {
                        name := 'insert bad',
                        l2 := 0,
                        subordinates := Subordinate
                    }),
                    Subordinate,
                );
            `
      );
    }).toThrow(new RegExp("cannot reference correlated set 'Subordinate' here"));
  });

  it("test_edgeql_insert_correlated_bad_03", () => {
    expect(() => {
      h.script(
        `
                SELECT (
                    Person,
                    (INSERT Person {name := 'insert bad'}),
                )
            `
      );
    }).toThrow(new RegExp("cannot reference correlated set 'Person' here"));
  });

  it("test_edgeql_insert_unless_conflict_01", () => {
    assertQueryResult(
      h,
      `
            SELECT
             ((INSERT Person {name := "test"} UNLESS CONFLICT)
              ?? (SELECT Person FILTER .name = "test")) {name};
        `,
      [
            {
              "name": "test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT
             ((INSERT Person {name := "test"} UNLESS CONFLICT)
              ?? (SELECT Person FILTER .name = "test")) {name};
        `,
      [
            {
              "name": "test",
            },
          ]
    );
    let res = h.query("\n            SELECT\n             ((INSERT Person {name := <str>$0} UNLESS CONFLICT ON .name)\n              ?? (SELECT Person FILTER .name = <str>$0));\n        ");
    let res2 = h.query("\n            SELECT\n             ((INSERT Person {name := <str>$0} UNLESS CONFLICT ON .name)\n              ?? (SELECT Person FILTER .name = <str>$0));\n        ");
    expect(undefined).toEqual(undefined);
    let res3 = h.query("\n            SELECT\n             ((INSERT Person {name := <str>$0} UNLESS CONFLICT ON .name)\n              ?? (SELECT Person FILTER .name = <str>$0));\n        ");
    expect(undefined).not.toEqual(undefined);
  });

  it("test_edgeql_insert_unless_conflict_02", () => {
    expect(() => {
      h.query(
        `
                INSERT Person {name := "hello"}
                UNLESS CONFLICT ON 20;
            `
      );
    }).toThrow(new RegExp("UNLESS CONFLICT argument must be a property"));
    expect(() => {
      h.query(
        `
                INSERT Person {name := "hello"}
                UNLESS CONFLICT ON Note.name;
            `
      );
    }).toThrow(new RegExp("UNLESS CONFLICT argument must be a property of the type being inserted"));
    expect(() => {
      h.query(
        `
                INSERT Note {name := "hello"}
                UNLESS CONFLICT ON .name;
            `
      );
    }).toThrow(new RegExp("UNLESS CONFLICT property must have a single exclusive constraint"));
    expect(() => {
      h.query(
        `
                SELECT (
                    INSERT Person {name := "hello"}
                    UNLESS CONFLICT ON .name
                    ELSE DefaultTest1
                ) {name};
            `
      );
    }).toThrow(new RegExp("object type 'std::Object' has no link or property 'name'"));
    expect(() => {
      h.query(
        `
                WITH X := (
                        INSERT Person {name := "hello"}
                        UNLESS CONFLICT ON .name
                        ELSE (DETACHED Person)
                    )
                SELECT {
                    single foo := X
                };
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by an expression for a computed link 'foo' declared as 'single'"));
    expect(() => {
      h.query(
        `
                WITH X := (
                        INSERT Person {name := "hello"}
                        UNLESS CONFLICT ON .name
                        ELSE Note
                    )
                SELECT {
                    single foo := X
                };
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by an expression for a computed link 'foo' declared as 'single'"));
    expect(() => {
      h.query(
        `
                WITH X := (
                        INSERT Person {name := "hello"}
                        UNLESS CONFLICT ON .name
                    )
                SELECT {
                    required foo := X
                };
            `
      );
    }).toThrow(new RegExp("possibly an empty set returned by an expression for a computed link 'foo' declared as 'required'"));
  });

  it("test_edgeql_insert_unless_conflict_03", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {name := "test"} UNLESS CONFLICT) {name};
        `,
      [
            {
              "name": "test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {name := "test"} UNLESS CONFLICT) {name};
        `,
      []
    );
  });

  it("test_edgeql_insert_unless_conflict_04", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {name := "test"} UNLESS CONFLICT
                ON .name ELSE (SELECT Person)
            ) {name};
        `,
      [
            {
              "name": "test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {name := "test"} UNLESS CONFLICT
                ON .name ELSE (SELECT Person)
            ) {name};
        `,
      [
            {
              "name": "test",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Person {name}`,
      [
            {
              "name": "test",
            },
          ]
    );
    let res = h.query("\n            INSERT Person {name := <str>$0} UNLESS CONFLICT\n            ON .name ELSE (SELECT Person)\n        ");
    let res2 = h.query("\n            INSERT Person {name := <str>$0} UNLESS CONFLICT\n            ON .name ELSE (SELECT Person)\n        ");
    expect(undefined).toEqual(undefined);
    let res3 = h.query("\n            INSERT Person {name := <str>$0} UNLESS CONFLICT\n            ON .name ELSE (SELECT Person)\n        ");
    expect(undefined).not.toEqual(undefined);
  });

  it("test_edgeql_insert_unless_conflict_05", () => {
    h.script(
      `
            INSERT Person { name := "Phil Emarg" }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {name := "Emmanuel Villip"} UNLESS CONFLICT
                ON .name ELSE (UPDATE Person SET { tag := "redo" })
            ) {name, tag};
        `,
      [
            {
              "name": "Emmanuel Villip",
              "tag": null,
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Person {name, tag} ORDER BY .name`,
      [
            {
              "name": "Emmanuel Villip",
              "tag": null,
            },
            {
              "name": "Phil Emarg",
              "tag": null,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {name := "Emmanuel Villip"} UNLESS CONFLICT
                ON .name ELSE (UPDATE Person SET { tag := "redo" })
            ) {name, tag};
        `,
      [
            {
              "name": "Emmanuel Villip",
              "tag": "redo",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Person {name, tag} ORDER BY .name`,
      unorderedBag([
            {
              "name": "Emmanuel Villip",
              "tag": "redo",
            },
            {
              "name": "Phil Emarg",
              "tag": null,
            },
          ])
    );
  });

  it("test_edgeql_insert_unless_conflict_06", () => {
    h.script(
      `
            INSERT Person { name := "Phil Emarg" };
            INSERT Person { name := "Madeline Hatch" };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
                FOR noob in {"Emmanuel Villip", "Madeline Hatch"} UNION (
                    INSERT Person {name := noob} UNLESS CONFLICT
                    ON .name ELSE (UPDATE Person SET { tag := "redo" })
                )
            ) {name, tag} ORDER BY .name;
        `,
      [
            {
              "name": "Emmanuel Villip",
              "tag": null,
            },
            {
              "name": "Madeline Hatch",
              "tag": "redo",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Person {name, tag} ORDER BY .name`,
      [
            {
              "name": "Emmanuel Villip",
              "tag": null,
            },
            {
              "name": "Madeline Hatch",
              "tag": "redo",
            },
            {
              "name": "Phil Emarg",
              "tag": null,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                FOR noob in {"Emmanuel Villip", "Madeline Hatch"} UNION (
                    INSERT Person {name := noob} UNLESS CONFLICT
                    ON .name ELSE (UPDATE Person SET { tag := "redo" })
                )
            ) {name, tag} ORDER BY .name;
        `,
      [
            {
              "name": "Emmanuel Villip",
              "tag": "redo",
            },
            {
              "name": "Madeline Hatch",
              "tag": "redo",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Person {name, tag} ORDER BY .name`,
      [
            {
              "name": "Emmanuel Villip",
              "tag": "redo",
            },
            {
              "name": "Madeline Hatch",
              "tag": "redo",
            },
            {
              "name": "Phil Emarg",
              "tag": null,
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_07", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person UNLESS CONFLICT
                ON .name ELSE (UPDATE Person SET { tag := "redo" })
            ) {name};
        `,
      [
            {
              "name": "Nemo",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Person {name, tag}`,
      [
            {
              "name": "Nemo",
              "tag": null,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person UNLESS CONFLICT
                ON .name ELSE (UPDATE Person SET { tag := "redo" })
            ) {name};
        `,
      [
            {
              "name": "Nemo",
            },
          ]
    );
    h.script(
      `
            INSERT Person { name := "Phil Emarg" }
        `
    );
    assertQueryResult(
      h,
      `SELECT Person {name, tag} ORDER BY .name`,
      [
            {
              "name": "Nemo",
              "tag": "redo",
            },
            {
              "name": "Phil Emarg",
              "tag": null,
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_08", () => {
    let res1 = querySingle<{ id: unknown; person: { id: unknown } }>(h, "\n            SELECT (\n                INSERT PersonWrapper {\n                    person := (\n                        INSERT Person { name := \"foo\" }\n                        UNLESS CONFLICT ON .name ELSE (SELECT Person)\n                    )\n                }\n            ) {id, person};\n        ");
    let res2 = querySingle<{ id: unknown; person: { id: unknown } }>(h, "\n            SELECT (\n                INSERT PersonWrapper {\n                    person := (\n                        INSERT Person { name := \"foo\" }\n                        UNLESS CONFLICT ON .name ELSE (SELECT Person)\n                    )\n                }\n            ) {id, person};\n        ");
    expect(res1.id).not.toEqual(res2.id);
    expect(res1.person.id).toEqual(res2.person.id);
  });

  it("test_edgeql_insert_unless_conflict_09", () => {
    h.script(
      `
            INSERT Person {
                name := 'Cap',
                tag := 'hero',
            } UNLESS CONFLICT ON .name ELSE (
                UPDATE Person SET {
                    tag := 'super ' ++ .tag
                }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { tag } FILTER .name = 'Cap'`,
      [
            {
              "tag": "hero",
            },
          ]
    );
    h.script(
      `
            INSERT Person {
                name := 'Cap',
                tag := 'hero',
            } UNLESS CONFLICT ON .name ELSE (
                UPDATE Person SET {
                    tag := 'super ' ++ .tag
                }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { tag } FILTER .name = 'Cap'`,
      [
            {
              "tag": "super hero",
            },
          ]
    );
    h.script(
      `
            INSERT Person {
                name := 'Cap',
                tag := 'hero',
            } UNLESS CONFLICT ON .name ELSE (
                UPDATE Person SET {
                    tag := 'super ' ++ .tag
                }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { tag } FILTER .name = 'Cap'`,
      [
            {
              "tag": "super super hero",
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_10", () => {
    h.script(
      `
            INSERT Person {
                name := "Foo",
                case_name := "Foo",
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Bar",
                    case_name := "foo",
                }
                UNLESS CONFLICT ON (.case_name)
                ELSE (SELECT Person)
            ) {name, case_name};
            `,
      [
            {
              "name": "Foo",
              "case_name": "Foo",
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_11", () => {
    expect(() => {
      h.script(
        `
                SELECT (
                    INSERT Person {name := "Madz"}
                    UNLESS CONFLICT ON (.name)
                    ELSE (INSERT Person {name := "Maddy"})
                ) {name};
            `
      );
    }).toThrow(new RegExp("self-referencing INSERTs are not allowed"));
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {name := "Madz"}
                UNLESS CONFLICT ON (.name)
                ELSE (DETACHED (INSERT Person {name := "Maddy"}))
            ) {name};
        `,
      [
            {
              "name": "Madz",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {name := "Madz"}
                UNLESS CONFLICT ON (.name)
                ELSE (DETACHED (INSERT Person {name := "Maddy"}))
            ) {name};
        `,
      [
            {
              "name": "Maddy",
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_12", () => {
    let res1 = queryRows<{ id: unknown }>(h, "\n            INSERT Person {name := \"Emmanuel Villip\"} UNLESS CONFLICT\n            ON .name ELSE (UPDATE Person SET { tag := \"redo\" })\n        ");
    let res2 = queryRows<{ id: unknown }>(h, "\n            INSERT Person {name := \"Emmanuel Villip\"} UNLESS CONFLICT\n            ON .name ELSE (UPDATE Person SET { tag := \"redo\" })\n        ");
    expect(res1[0].id).toEqual(res2[0].id);
  });

  it("test_edgeql_insert_unless_conflict_13", () => {
    let res1 = queryRows<{ id: unknown }>(h, "\n            INSERT Person {name := \"Emmanuel Villip\"} UNLESS CONFLICT\n            ON .name ELSE (SELECT Person)\n        ");
    let res2 = queryRows<{ id: unknown }>(h, "\n            INSERT Person {name := \"Emmanuel Villip\"} UNLESS CONFLICT\n            ON .name ELSE (SELECT Person)\n        ");
    expect(res1[0].id).toEqual(res2[0].id);
  });

  it("test_edgeql_insert_unless_conflict_14", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2a {first := "Phil", last := "Emarg"}
                UNLESS CONFLICT ON (.first, .last) ELSE (SELECT Person2a)
            ) {first, last};
        `,
      [
            {
              "first": "Phil",
              "last": "Emarg",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2a {first := "Phil", last := "Emarg"}
                UNLESS CONFLICT ON (.first, .last) ELSE (SELECT Person2a)
            ) {first, last};
        `,
      [
            {
              "first": "Phil",
              "last": "Emarg",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Person2a {first, last}`,
      [
            {
              "first": "Phil",
              "last": "Emarg",
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_15", () => {
    h.script(
      `
            INSERT Person {
                name := "Phil Emarg",
            };

            INSERT Person {
                name := "Madeline Hatch",
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2a {
                    first := "Emmanuel",
                    last := "Villip",
                    bff := (SELECT Person FILTER .name = "Phil Emarg")
                }
                UNLESS CONFLICT ON (.first, .bff) ELSE (SELECT Person2a)
            ) {first, last};
        `,
      [
            {
              "first": "Emmanuel",
              "last": "Villip",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2a {
                    first := "Emmanuel",
                    last := "Villip",
                    bff := (SELECT Person FILTER .name = "Phil Emarg")
                }
                UNLESS CONFLICT ON (.first, .bff) ELSE (SELECT Person2a)
            ) {first, last};
        `,
      [
            {
              "first": "Emmanuel",
              "last": "Villip",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2a {
                    first := "Emmanuel",
                    last := "Vi11ip",
                    bff := (SELECT Person FILTER .name = "Phil Emarg")
                }
                UNLESS CONFLICT ON (.first, .bff) ELSE (SELECT Person2a)
            ) {first, last};
        `,
      [
            {
              "first": "Emmanuel",
              "last": "Villip",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Person2a {first, last, friend := .bff.name}`,
      [
            {
              "first": "Emmanuel",
              "last": "Villip",
              "friend": "Phil Emarg",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2a {
                    first := "Emmanuel",
                    last := "Vi11ip",
                    bff := (SELECT Person FILTER .name = "Madeline Hatch")
                }
                UNLESS CONFLICT ON (.first, .bff) ELSE (SELECT Person2a)
            ) {first, last};
        `,
      [
            {
              "first": "Emmanuel",
              "last": "Vi11ip",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Person2a {first, last, friend := .bff.name}
                ORDER BY .last
            `,
      [
            {
              "first": "Emmanuel",
              "last": "Vi11ip",
              "friend": "Madeline Hatch",
            },
            {
              "first": "Emmanuel",
              "last": "Villip",
              "friend": "Phil Emarg",
            },
          ]
    );
  });

  it.skip("test_edgeql_insert_unless_conflict_16", () => {
    h.script(
      `
                DELETE Person;
            `
    );
    let res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    h.script(
      `
                DELETE Person;
            `
    );
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
    res = h.query("\n                    INSERT Person { name := <str>math::floor(random() * 2) }\n                    UNLESS CONFLICT ON (.name) ELSE (Person)\n                ");
    expect((res as any).length).toEqual(1);
  });

  it("test_edgeql_insert_unless_conflict_16b", () => {
    expect(() => {
      h.script(
        `
                INSERT Person { name := <str>math::floor(random() * 2) }
                UNLESS CONFLICT ON (.name) ELSE (Person)
            `
      );
    }).toThrow(new RegExp("INSERT UNLESS CONFLICT ON does not support volatile properties"));
  });

  it("test_edgeql_insert_unless_conflict_17", () => {
    h.script(
      `
            FOR x IN {"1", "2", "3", "4"} UNION (
                INSERT Person { name := x }
            );
        `
    );
    assertQueryResult(
      h,
      `
            FOR x IN {"1", "2", "3", "4"} UNION (
                INSERT Person { name := x }
                UNLESS CONFLICT ON (.name)
                ELSE (UPDATE Person SET { tag := "!" })
            );
            `,
      [
            {},
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Person.tag
            `,
      ["!", "!", "!", "!"]
    );
  });

  it("test_edgeql_insert_unless_conflict_18a", () => {
    h.script(
      `
            INSERT Person { name := "Phil Emarg" };
        `
    );
    assertQueryResult(
      h,
      `
            INSERT DerivedPerson { name := "Phil Emarg" } UNLESS CONFLICT;
            `,
      []
    );
    assertQueryResult(
      h,
      `
            INSERT DerivedPerson { name := "Phil Emarg" }
            UNLESS CONFLICT ON (.name);
            `,
      []
    );
  });

  it("test_edgeql_insert_unless_conflict_18b", () => {
    h.script(
      `
            INSERT DerivedPerson { name := "Phil Emarg" };
        `
    );
    assertQueryResult(
      h,
      `
            INSERT Person { name := "Phil Emarg" } UNLESS CONFLICT;
            `,
      []
    );
    assertQueryResult(
      h,
      `
            INSERT Person { name := "Phil Emarg" }
            UNLESS CONFLICT ON (.name);
            `,
      []
    );
  });

  it("test_edgeql_insert_unless_conflict_19", () => {
    h.script(
      `
            INSERT DerivedPerson { name := "Phil Emarg", sub_key := "1" };
        `
    );
    assertQueryResult(
      h,
      `
            INSERT DerivedPerson { name := "Madeline Hatch", sub_key := "1" }
            UNLESS CONFLICT;
            `,
      []
    );
  });

  it("test_edgeql_insert_unless_conflict_20a", () => {
    expect(() => {
      h.script(
        `
                INSERT DerivedPerson { name := "Madeline Hatch" }
                UNLESS CONFLICT ON (.name) ELSE (SELECT DerivedPerson)
            `
      );
    }).toThrow(new RegExp("UNLESS CONFLICT can not use ELSE when constraint is from a parent type"));
  });

  it("test_edgeql_insert_unless_conflict_20b", () => {
    h.script(
      `
            INSERT Person { name := "1" };
        `
    );
    assertQueryResult(
      h,
      `
            FOR x IN {"1", "2"} UNION (
                INSERT DerivedPerson { name := x }
                UNLESS CONFLICT ON (.name)
                ELSE (UPDATE Person SET { tag := "!" })
            );
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Person {name, tag, sub: Person IS DerivedPerson}
            ORDER BY .name
            `,
      [
            {
              "name": "1",
              "tag": "!",
              "sub": false,
            },
            {
              "name": "2",
              "tag": null,
              "sub": true,
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_21", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Bar {
                CREATE REQUIRED PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Baz extending Foo, Bar;
        `
    );
    h.script(
      `
            INSERT Foo { name := "foo" };
            INSERT Foo { name := "both" };
            INSERT Bar { name := "bar" };
            INSERT Bar { name := "both" };
        `
    );
    assertQueryResult(
      h,
      `
            FOR x IN {"foo", "bar", "both", "asdf"} UNION (
                INSERT Baz { name := x }
                UNLESS CONFLICT ON (.name)
            );
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_22", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY foo -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Bar {
                CREATE REQUIRED PROPERTY bar -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Baz extending Foo, Bar;
        `
    );
    h.script(
      `
            INSERT Foo { foo := "foo" };
            INSERT Bar { bar := "bar" };
        `
    );
    assertQueryResult(
      h,
      `
            INSERT Baz { foo := "!", bar := "bar" }
            UNLESS CONFLICT ON (.bar)
            `,
      []
    );
    expect(() => {
      h.script(
        `
                INSERT Baz { foo := "!", bar := "bar" }
                UNLESS CONFLICT ON (.foo)
                `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    assertQueryResult(
      h,
      `
            INSERT Baz { foo := "foo", bar := "!" }
            UNLESS CONFLICT
            `,
      []
    );
    assertQueryResult(
      h,
      `
            INSERT Baz { foo := "!", bar := "bar" }
            UNLESS CONFLICT
            `,
      []
    );
    assertQueryResult(
      h,
      `
            INSERT Baz { foo := "foo", bar := "bar" }
            UNLESS CONFLICT
            `,
      []
    );
  });

  it("test_edgeql_insert_unless_conflict_23", () => {
    let obj1 = querySingle<{ id: unknown }>(h, "\n            insert DerivedPerson { sub_key := \"foo\" };\n        ");
    let obj2 = querySingle<{ id: unknown }>(h, "\n            insert DerivedPerson {\n                name := \"new\",\n                sub_key := <str>json_get(\n                    to_json('{ \"sub_key\": \"foo\"}'), 'sub_key')\n            }\n            unless conflict on .sub_key else (select DerivedPerson);\n        ");
    expect(obj1.id).toEqual(obj2.id);
    let obj3 = queryRows<{ id: unknown }>(h, "\n            with\n              raw_data := to_json('[{\"sub_key\": \"foo\"}]')\n            for item in json_array_unpack(raw_data) union (\n                insert DerivedPerson {\n                    name := \"new\",\n                    sub_key := <str>json_get(item, 'sub_key')\n                }\n                unless conflict on .sub_key else (select DerivedPerson)\n            );\n        ");
    expect((obj3).length).toEqual(1);
    expect(obj1.id).toEqual(obj3[0].id);
  });

  it("test_edgeql_insert_unless_conflict_24", () => {
    h.script(
      `
            WITH
                raw_data := to_json('[1,2]')
            for data in {<int64>json_array_unpack(raw_data)} union(
                INSERT Person {
                    note := (INSERT Note { name := 'x' }),
                    name := <str>data,
                }
                UNLESS conflict on .name
            );
        `
    );
  });

  it("test_edgeql_insert_unless_conflict_25", () => {
    h.script(
      `
            create type X {
                create required property n -> str {
                    create constraint exclusive;
                }
            };
            create type Y {
                create required link l -> X {
                    create constraint exclusive;
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
            INSERT Y {
              l := (INSERT X { n := <str>$n } UNLESS CONFLICT ON (.n) ELSE (X))
            }
            UNLESS CONFLICT ON (.l);
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            INSERT Y {
              l := (INSERT X { n := <str>$n } UNLESS CONFLICT ON (.n) ELSE (X))
            }
            UNLESS CONFLICT ON (.l);
        `,
      []
    );
    h.script(
      `
            insert X { n := "2" }
        `
    );
    assertQueryResult(
      h,
      `
            INSERT Y {
              l := (INSERT X { n := <str>$n } UNLESS CONFLICT ON (.n) ELSE (X))
            }
            UNLESS CONFLICT ON (.l);
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            INSERT Y {
              l := (INSERT X { n := <str>$n } UNLESS CONFLICT ON (.n) ELSE (X))
            }
            UNLESS CONFLICT ON (.l);
        `,
      []
    );
  });

  it("test_edgeql_insert_unless_conflict_26", () => {
    h.script(
      `
            INSERT Person {
              name := "Colin"
            }
            UNLESS CONFLICT ON .case_name
            ELSE (Person)
        `
    );
  });

  it("test_edgeql_insert_unless_conflict_27", () => {
    assertQueryResult(
      h,
      `
            WITH P := (
                insert Person { name := <str>$0 }
                unless conflict on .name else (Person)
            )
            insert Person2a {
                first := <str>$1, last := '', bff := P
            } unless conflict on (.first, .last) else (
                update Person2a set { bff := P }
            )
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select Person2a { bff: {name} } filter .first = <str>$0
        `,
      [
            {
              "bff": {
                "name": "a",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH P := (
                insert Person { name := <str>$0 }
                unless conflict on .name else (Person)
            )
            insert Person2a {
                first := <str>$1, last := '', bff := P
            } unless conflict on (.first, .last) else (
                update Person2a set { bff := P }
            )
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select Person2a { bff: {name} } filter .first = <str>$0
        `,
      [
            {
              "bff": {
                "name": "b",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH P := (
                insert Person { name := <str>$0 }
                unless conflict on .name else (Person)
            )
            insert Person2a {
                first := <str>$1, last := '', bff := P
            } unless conflict on (.first, .last) else (
                update Person2a set { bff := P }
            )
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select Person2a { bff: {name} } filter .first = <str>$0
        `,
      [
            {
              "bff": {
                "name": "b",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH P := (
                insert Person { name := <str>$0 }
                unless conflict on .name else (Person)
            )
            insert Person2a {
                first := <str>$1, last := '', bff := P
            } unless conflict on (.first, .last) else (
                update Person2a set { bff := P }
            )
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select Person2a { bff: {name} } filter .first = <str>$0
        `,
      [
            {
              "bff": {
                "name": "c",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_28", () => {
    h.script(
      `
            create type T {
                create multi property name -> str {
                    create constraint exclusive; } };
            insert T { name := {'foo', 'bar'} };
        `
    );
    assertQueryResult(
      h,
      `
            insert T { name := {'baz', 'bar'} } unless conflict
            `,
      []
    );
    assertQueryResult(
      h,
      `
            select (
                insert T { name := {'baz', 'bar'} }
                unless conflict on (.name) else (T)
            ) { name }
            `,
      [
            {
              "name": unorderedSet(["bar", "foo"]),
            },
          ]
    );
  });

  it("test_edgeql_insert_unless_conflict_29", () => {
    h.script(
      `
            with
                sub := <Subordinate>{},
                upsert := (
                    insert InsertTest {
                        l2 := 0,
                        sub_ex := sub
                    }
                    unless conflict
                ),
            insert Note {
                name := '', subject := upsert,
            };
        `
    );
  });

  it("test_edgeql_insert_dependent_01", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name :=  "Test",
                    notes := (INSERT Note {name := "tag!" })
                } UNLESS CONFLICT
            ) {name};
        `,
      [
            {
              "name": "Test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name :=  "Test",
                    notes := (INSERT Note {name := "tag!" })
                } UNLESS CONFLICT
            ) {name};
        `,
      []
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_02", () => {
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                INSERT Person {name := noob,
                               notes := (INSERT Note {name := "tag" })});
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { name, notes: {name} } ORDER BY .name`,
      [
            {
              "name": "Madeline Hatch",
              "notes": [
                {
                  "name": "tag",
                },
              ],
            },
            {
              "name": "Phil Emarg",
              "notes": [
                {
                  "name": "tag",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(DISTINCT Person.notes)`,
      [2]
    );
  });

  it("test_edgeql_insert_dependent_03", () => {
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                INSERT Person {
                    name := noob,
                    notes := (FOR note in {"hello", "world"}
                              UNION (INSERT Note { name := note }))});
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { name, notes: {name} } ORDER BY .name`,
      [
            {
              "name": "Madeline Hatch",
              "notes": [
                {
                  "name": "hello",
                },
                {
                  "name": "world",
                },
              ],
            },
            {
              "name": "Phil Emarg",
              "notes": [
                {
                  "name": "hello",
                },
                {
                  "name": "world",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(DISTINCT Person.notes)`,
      [4]
    );
  });

  it("test_edgeql_insert_dependent_04", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name :=  "Zendaya",
                    notes := (FOR note in {"hello", "world"}
                              UNION (INSERT Note { name := note }))
                } UNLESS CONFLICT
            ) { name, notes: {name} ORDER BY .name};
        `,
      [
            {
              "name": "Zendaya",
              "notes": [
                {
                  "name": "hello",
                },
                {
                  "name": "world",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name :=  "Zendaya",
                    notes := (FOR note in {"hello", "world"}
                              UNION (INSERT Note { name := note }))
                } UNLESS CONFLICT
            ) { name, notes: {name} ORDER BY .name};
        `,
      []
    );
    assertQueryResult(
      h,
      `SELECT DISTINCT count(Person.notes)`,
      [2]
    );
  });

  it("test_edgeql_insert_dependent_05", () => {
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                INSERT Person {name := noob}
            );
        `
    );
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                UPDATE Person FILTER .name = noob
                SET {notes := (INSERT Note { name := "tag" }) }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { name, notes: {name} } ORDER BY .name DESC`,
      [
            {
              "name": "Phil Emarg",
              "notes": [
                {
                  "name": "tag",
                },
              ],
            },
            {
              "name": "Madeline Hatch",
              "notes": [
                {
                  "name": "tag",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(DISTINCT Person.notes)`,
      [2]
    );
  });

  it("test_edgeql_insert_dependent_06", () => {
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                INSERT Person {name := noob}
            );
        `
    );
    h.script(
      `
            FOR noob in {"Phil Emarg", "Madeline Hatch"}
            UNION (
                UPDATE Person FILTER .name = noob
                SET {
                    notes := (FOR note in {"hello", "world"}
                              UNION (INSERT Note { name := note }))
                }
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { name, notes: {name} } ORDER BY .name DESC`,
      [
            {
              "name": "Phil Emarg",
              "notes": [
                {
                  "name": "hello",
                },
                {
                  "name": "world",
                },
              ],
            },
            {
              "name": "Madeline Hatch",
              "notes": [
                {
                  "name": "hello",
                },
                {
                  "name": "world",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(DISTINCT Person.notes)`,
      [4]
    );
  });

  it("test_edgeql_insert_dependent_07", () => {
    expect(() => {
      h.script(
        `
                    SELECT Person {
                        name,
                        foo := (
                            INSERT Note {name := 'NoteDep07'}
                        ) {
                            name,
                        }
                    };
                `
      );
    }).toThrow(new RegExp("mutations are invalid in a shape's computed expression"));
  });

  it("test_edgeql_insert_dependent_08", () => {
    h.script(
      `
            INSERT Person {
                name := 'PersonDep08'
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    foo := (
                        INSERT Note {name := 'NoteDep08'}
                    )
                SELECT Person {
                    name,
                    foo := foo {
                        name,
                    }
                };
            `,
      [
            {
              "name": "PersonDep08",
              "foo": {
                "name": "NoteDep08",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Person {
                    name,
                    notes: {
                        name,
                    }
                };
            `,
      [
            {
              "name": "PersonDep08",
              "notes": [],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Note {
                    name,
                };
            `,
      [
            {
              "name": "NoteDep08",
            },
          ]
    );
  });

  it("test_edgeql_insert_dependent_09", () => {
    h.script(
      `
            INSERT Person {
                name := 'PersonDep09'
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    foo := (
                        INSERT Note {name := 'NoteDep09'}
                    )
                SELECT Person {
                    name,
                    # Fake having an actual linked Note
                    notes := foo {
                        name,
                    }
                };
            `,
      [
            {
              "name": "PersonDep09",
              "notes": [
                {
                  "name": "NoteDep09",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Person {
                    name,
                    notes: {
                        name,
                    }
                };
            `,
      [
            {
              "name": "PersonDep09",
              "notes": [],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Note {
                    name,
                };
            `,
      [
            {
              "name": "NoteDep09",
            },
          ]
    );
  });

  it("test_edgeql_insert_dependent_10", () => {
    h.script(
      `INSERT Note { name := "foo" };`
    );
    h.script(
      `
            FOR noob in {"foo", "bar"} UNION (
                INSERT Person { name := noob,
                                notes := (UPDATE Note FILTER .name = noob
                                          SET { name := noob ++ "!"})
                }
                UNLESS CONFLICT
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { name, notes: {name} } ORDER BY .name DESC`,
      [
            {
              "name": "foo",
              "notes": [
                {
                  "name": "foo!",
                },
              ],
            },
            {
              "name": "bar",
              "notes": [],
            },
          ]
    );
    h.script(
      `INSERT Note { name := "bar" };`
    );
    h.script(
      `
            FOR noob in {"foo", "bar"} UNION (
                INSERT Person { name := noob,
                                notes := (UPDATE Note FILTER .name = noob
                                          SET { name := noob ++ "!"})
                }
                UNLESS CONFLICT
            );
        `
    );
    assertQueryResult(
      h,
      `SELECT Person { name, notes: {name} } ORDER BY .name`,
      [
            {
              "name": "bar",
              "notes": [],
            },
            {
              "name": "foo",
              "notes": [
                {
                  "name": "foo!",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Note.name`,
      unorderedSet(["bar", "foo!"])
    );
  });

  it("test_edgeql_insert_dependent_11", () => {
    h.script(
      `
                WITH N := (INSERT Note {name := "tag!" }),
                FOR name in {"Phil", "Madz"} UNION (
                    INSERT Person {
                        name := name,
                        notes := N,
                    }
                );
            `
    );
    assertQueryResult(
      h,
      `SELECT Note { name }`,
      [
            {
              "name": "tag!",
            },
          ]
    );
  });

  it("test_edgeql_insert_dependent_12", () => {
    h.script(
      `
                WITH N := (INSERT Note {name := "tag!" }),
                FOR name in {"Phil", "Madz"} UNION (
                    INSERT Person {
                        name := name,
                        note := N,
                    }
                );
            `
    );
    assertQueryResult(
      h,
      `SELECT Note { name }`,
      [
            {
              "name": "tag!",
            },
          ]
    );
  });

  it("test_edgeql_insert_dependent_13", () => {
    assertQueryResult(
      h,
      `
        WITH N := (INSERT Note {name := "tag!" }),
        SELECT (
            INSERT Person {
                name := "Test",
                notes := N,
            } UNLESS CONFLICT
        ) {name};
        `,
      [
            {
              "name": "Test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
        WITH N := (INSERT Note {name := "tag!" }),
        SELECT (
            INSERT Person {
                name := "Test",
                notes := N,
            } UNLESS CONFLICT
        ) {name};
        `,
      []
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [2]
    );
  });

  it("test_edgeql_insert_dependent_14", () => {
    assertQueryResult(
      h,
      `
                WITH N := (INSERT Note {name := "tag!" }),
                    X := (FOR name in {"Phil", "Madz"} UNION (
                        INSERT Person {
                            name := name,
                            notes := N,
                        }
                    )),
                SELECT {
                    x := (SELECT X { name } ORDER BY .name),
                    n := N { name },
                };
            `,
      [
            {
              "n": {
                "name": "tag!",
              },
              "x": [
                {
                  "name": "Madz",
                },
                {
                  "name": "Phil",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_15", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Test",
                    note := (INSERT Note {name := "tag!" })
                } UNLESS CONFLICT
            ) {name};
        `,
      [
            {
              "name": "Test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Test",
                    note := (INSERT Note {name := "tag!" })
                } UNLESS CONFLICT
            ) {name};
        `,
      []
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_16", () => {
    assertQueryResult(
      h,
      `
                SELECT (
                    INSERT Person {
                        name := "Test",
                        note := (INSERT Note {name := "tag!" })
                    } UNLESS CONFLICT
                ) {name};
            `,
      [
            {
              "name": "Test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (
                    INSERT Person {
                        name := "Test",
                        note := (
                            UPDATE (SELECT Note LIMIT 1)
                            SET { name := "owned" })
                    } UNLESS CONFLICT
                ) {name};
            `,
      []
    );
    assertQueryResult(
      h,
      `SELECT Note { name }`,
      [
            {
              "name": "tag!",
            },
          ]
    );
  });

  it("test_edgeql_insert_dependent_17", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Test",
                    note := (INSERT Note {name := "tag!" })
                } UNLESS CONFLICT ON (.name) ELSE (SELECT Person)
            ) {name};
        `,
      [
            {
              "name": "Test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Test",
                    note := (INSERT Note {name := "tag!" })
                } UNLESS CONFLICT ON (.name) ELSE (SELECT Person)
            ) {name};
        `,
      [
            {
              "name": "Test",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_18", () => {
    h.script(
      `
            INSERT Person { name := "foo" }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
            FOR name in {"foo", "bar"} UNION (
                SELECT (
                    INSERT Person {
                        name := name,
                        note := (INSERT Note {name := "tag!" })
                    } UNLESS CONFLICT ON (.name) ELSE (SELECT Person)
                ) {name}
            )) ORDER BY .name;
        `,
      [
            {
              "name": "bar",
            },
            {
              "name": "foo",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_19", () => {
    h.script(
      `
            INSERT Person { name := "foo" }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
            FOR name in {"foo", "bar"} UNION (
                SELECT (
                    INSERT Person {
                        name := name,
                        note := (INSERT Note {name := "tag!" })
                    } UNLESS CONFLICT ON (.name)
                ) {name}
            )) ORDER BY .name;
        `,
      [
            {
              "name": "bar",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_20", () => {
    h.script(
      `
            INSERT Person { name := "foo" }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
            FOR name in {"foo", "bar"} UNION (
                SELECT (
                    INSERT Person {
                        name := name,
                        tag2 := (INSERT Note {name := "tag!" }).name
                    } UNLESS CONFLICT ON (.name)
                ) {name, tag2}
            )) ORDER BY .name;
        `,
      [
            {
              "name": "bar",
              "tag2": "tag!",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_21", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Test",
                    note := (INSERT Note {name := "tag!" }),
                    multi_prop := {},
                } UNLESS CONFLICT
            ) {name};
        `,
      [
            {
              "name": "Test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Test",
                    note := (INSERT Note {name := "tag!" }),
                    multi_prop := {},
                } UNLESS CONFLICT
            ) {name};
        `,
      []
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_22", () => {
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Test",
                    note := (INSERT Note {name := "tag!" }),
                    case_name := "Foo",
                } UNLESS CONFLICT
            ) {name};
            `,
      [
            {
              "name": "Test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person {
                    name := "Test2",
                    note := (INSERT Note {name := "tag!" }),
                    case_name := "foo",
                } UNLESS CONFLICT
            ) {name};
            `,
      []
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_23", () => {
    h.script(
      `
            INSERT Person2a {
                first := "Madeline",
                last := "Hatch1",
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2a {
                    first := "Phil",
                    last := "Emarg",
                    note := (INSERT Note {name := "tag!" }),
                } UNLESS CONFLICT
            ) {first, last};
        `,
      [
            {
              "first": "Phil",
              "last": "Emarg",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2a {
                    first := "Phil",
                    last := "Emarg",
                    note := (INSERT Note {name := "tag!" }),
                } UNLESS CONFLICT
            ) {first, last};
        `,
      []
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_24", () => {
    h.script(
      `
            INSERT Person2b {
                first := "Madeline",
                last := "Hatch2",
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2b {
                    first := "Phil",
                    last := "Emarg",
                    note := (INSERT Note {name := "tag!" }),
                } UNLESS CONFLICT
            ) {name};
        `,
      [
            {
              "name": "Phil Emarg",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2b {
                    first := "Phil",
                    last := "Emarg",
                    note := (INSERT Note {name := "tag!" }),
                } UNLESS CONFLICT
            ) {name};
        `,
      []
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_25", () => {
    h.script(
      `
            INSERT Person2b {
                first := "Madeline",
                last := "Hatch3",
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2b {
                    first := "Phil",
                    last := "Emarg",
                    note := (INSERT Note {name := "tag!" }),
                }
                UNLESS CONFLICT ON (.name)
                ELSE (SELECT Person2b)
            ) {name};
        `,
      [
            {
              "name": "Phil Emarg",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2b {
                    first := "Phil",
                    last := "Emarg",
                    note := (INSERT Note {name := "tag!" }),
                }
                UNLESS CONFLICT ON (.name)
                ELSE (SELECT Person2b)
            ) {name};
        `,
      [
            {
              "name": "Phil Emarg",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_dependent_26", () => {
    h.script(
      `
            INSERT Person2b {
                first := "Madeline",
                last := "Hatch4",
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2b {
                    first := "Phil",
                    note := (INSERT Note {name := "tag!" }),
                } UNLESS CONFLICT
            ) {first, name};
        `,
      [
            {
              "first": "Phil",
              "name": null,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                INSERT Person2b {
                    first := "Phil",
                    note := (INSERT Note {name := "tag!" }),
                } UNLESS CONFLICT
            ) {first, name};
        `,
      [
            {
              "first": "Phil",
              "name": null,
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [2]
    );
  });

  it("test_edgeql_insert_dependent_27", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE Named {
                CREATE REQUIRED PROPERTY name -> str {
                    CREATE DELEGATED CONSTRAINT exclusive;
                };
            };

            CREATE TYPE Foo EXTENDING Named;
            CREATE TYPE Bar EXTENDING Named;

            CREATE TYPE Obj extending Named {
                CREATE LINK foo -> Foo;
                CREATE LINK bar -> Bar;
            };
        `
    );
    assertQueryResult(
      h,
      `
                INSERT Obj {
                    name := "obj",
                    foo := (
                        INSERT Foo {name := "foo"}
                        UNLESS CONFLICT ON .name ELSE (SELECT Foo)
                    ),
                    bar := (
                        INSERT Bar {name := "bar"}
                        UNLESS CONFLICT ON .name ELSE (SELECT Bar)
                    ),
                }
                UNLESS CONFLICT ON .name ELSE (SELECT Obj);
            `,
      [
            {
              "id": "str",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT Obj {name, foo: {name}, bar: {name}}`,
      [
            {
              "name": "obj",
              "foo": {
                "name": "foo",
              },
              "bar": {
                "name": "bar",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_dependent_28", () => {
    h.script(
      `
            create type X {
                create required property name -> str {
                    create constraint exclusive
                };
                create multi link notes -> Note;
            };
        `
    );
    h.query(
      `
            INSERT X {name := "Madeline Hatch",
                      notes := (INSERT Note {name := "tag" })}
            UNLESS CONFLICT;
        `
    );
    h.query(
      `
            INSERT X {name := "Madeline Hatch",
                      notes := (INSERT Note {name := "tag" })}
            UNLESS CONFLICT;
        `
    );
    assertQueryResult(
      h,
      `SELECT count(Note)`,
      [1]
    );
  });

  it("test_edgeql_insert_unless_conflict_self_01", () => {
    expect(() => {
      h.script(
        `
            SELECT (
              FOR x in {"Phil Emarg", "Phil Emarg"} UNION (
                INSERT Person {name := x}
                UNLESS CONFLICT ON (.name)
                ELSE (SELECT Person)
              )
            ) { name }
            ORDER BY .name;
        `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_unless_conflict_self_02", () => {
    expect(() => {
      h.script(
        `
            SELECT (
              (INSERT Person {name := "Emmanuel Villip"} UNLESS CONFLICT),
              (INSERT Person {name := "Emmanuel Villip"} UNLESS CONFLICT),
            )
        `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_unless_conflict_self_03", () => {
    expect(() => {
      h.script(
        `
            INSERT Person {
                name := "Madeline Hatch",
                note := (
                    INSERT Note {
                        name := "wtvr",
                        subject := (
                            DETACHED (
                                INSERT Person { name := "Madeline Hatch" })
                        ),
                     }
                )
            }
            UNLESS CONFLICT;
        `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_nested_volatile_01", () => {
    h.script(
      `
            INSERT Subordinate {
                name := 'subtest 1'
            };

            INSERT Subordinate {
                name := 'subtest 2'
            };

            INSERT InsertTest {
                name := 'insert nested',
                l2 := 0,
                subordinates := (
                    SELECT Subordinate {
                        @comment := <str>uuid_generate_v1mc()
                    }
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT count(DISTINCT InsertTest.subordinates@comment);
            `,
      [2]
    );
  });

  it("test_edgeql_insert_cross_type_conflict_01a", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := name}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_01b", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := name}),
                 Z := (B, F),
            SELECT Z;
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_01c", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := name}),
            SELECT (SELECT (B, F));
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_01d", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := name}),
            SELECT (B, F) FILTER false;
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_01e", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := name}),
            SELECT (B, F, <str>{});
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_02", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 F := (INSERT DerivedPerson {name := name}),
                 B := (INSERT Person {name := name}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_03", () => {
    h.script(
      `
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (UPDATE Person FILTER .name = 'Bar' SET {name := name}),
                 F := (INSERT Person {name := name})
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_04", () => {
    expect(() => {
      h.script(
        `
        WITH
             B := (INSERT Person {name := "Foo", case_name := "asdf"}),
             F := (INSERT DerivedPerson {name := "Bar", case_name := "ASDF"}),
        SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("case_name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_05", () => {
    expect(() => {
      h.script(
        `
        WITH
             B := (INSERT Person {name := "Bar", multi_prop := {"1", "2"}}),
             F := (INSERT DerivedPerson {
                      name := "Foo", multi_prop := {"2","3"}}),
        SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("multi_prop violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_06", () => {
    h.script(
      `
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (UPDATE Person FILTER .name = 'Bar'
                       SET {multi_prop += "a"}),
                 F := (INSERT Person {name := name, multi_prop := {"a", "b"}})
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("multi_prop violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_07a", () => {
    h.script(
      `
            INSERT Person { name := 'Foo' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH
                 B := (UPDATE Person FILTER .name = 'Foo'
                       SET {name := "Bar"}),
                 F := (INSERT Person {name := "Foo"})
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_07b", () => {
    h.script(
      `
            INSERT DerivedPerson { name := 'Bar', multi_prop := "a" };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (UPDATE Person FILTER .name = 'Bar'
                       SET {multi_prop -= "a"}),
                 F := (INSERT Person {name := name, multi_prop := {"a", "b"}})
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("multi_prop violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_08", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := name} UNLESS CONFLICT),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_09", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 F := (INSERT DerivedPerson {name := name} UNLESS CONFLICT),
                 B := (INSERT Person {name := name}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_10", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE Named {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                }
            };
            CREATE ABSTRACT TYPE Titled {
                CREATE PROPERTY title -> str {
                    CREATE CONSTRAINT exclusive;
                }
            };
            CREATE TYPE Foo EXTENDING Named, Titled;
            CREATE TYPE Bar EXTENDING Named, Titled;
        `
    );
    expect(() => {
      h.script(
        `
                WITH name := 'Madeline Hatch',
                     B := (INSERT Bar {name := name}),
                     F := (INSERT Foo {name := name}),
                SELECT (B, F);
            `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                WITH name := 'Madeline Hatch',
                     B := (INSERT Bar {title := name}),
                     F := (INSERT Foo {title := name}),
                SELECT (B, F);
            `
      );
    }).toThrow(new RegExp("title violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_11", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE Named {
                CREATE PROPERTY name -> str {
                    CREATE DELEGATED CONSTRAINT exclusive;
                }
            };
            CREATE TYPE Foo EXTENDING Named;
            CREATE TYPE Bar EXTENDING Named;
        `
    );
    h.script(
      `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Bar {name := name}),
                 F := (INSERT Foo {name := name}),
            SELECT (B, F);
        `
    );
  });

  it("test_edgeql_insert_cross_type_conflict_12", () => {
    expect(() => {
      h.script(
        `
        WITH
             B := (INSERT Person {name := "foo"}),
             F := (FOR a in {"b", "f"} UNION (
                   FOR b in {"ar", "oo"} UNION (
                       INSERT DerivedPerson {name := a ++ b}
                  ))),
        SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_13", () => {
    expect(() => {
      h.script(
        `
        WITH
             F := (FOR a in {"b", "f"} UNION (
                   FOR b in {"ar", "oo"} UNION (
                       INSERT DerivedPerson {name := a ++ b}
                  ))),
             B := (INSERT Person {name := "foo"}),
        SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_14", () => {
    h.script(
      `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := <str>random()}),
            SELECT (B, F);
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := <str>(0*random())}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_15", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE LINK foo -> Foo;
                CREATE REQUIRED PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Alice'
            INSERT Foo {
                name := name,
                foo := (
                    INSERT Bar {
                        name := name,
                    }
                )
            };
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_16", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE MULTI LINK foo -> Foo;
                CREATE REQUIRED PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Alice'
            INSERT Foo {
                name := name,
                foo := (
                    INSERT Bar {
                        name := name,
                    }
                )
            };
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_17", () => {
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (INSERT Person {name := name}),
                 F := (INSERT DerivedPerson {name := name}),
                 L := (FOR x IN {F} UNION (INSERT Note {name := "bs"})),
            SELECT (B, L);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_18", () => {
    h.script(
      `
            create type Foo {
                create property foo -> str {
                    create constraint exclusive on (__subject__ ?? '');
                };
                create property bar -> str;
                create constraint exclusive on (.bar ?? '');
            };
            create type Bar extending Foo;
        `
    );
    expect(() => {
      h.script(
        `
            SELECT ((insert Foo), (insert Bar));
        `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_cross_type_conflict_19", () => {
    h.script(
      `
            create required global break -> bool { set default := false; };
            create type X {
                create property foo -> str {
                    create constraint exclusive;
                };
                create access policy yes allow all using (true);
                create access policy no deny select using (global break);
            };
            create type Y extending X;
        `
    );
    h.script(
      `
            set global break := true
        `
    );
    expect(() => {
      h.query(
        `
                select {
                    (insert X { foo := "!" }),
                    (insert Y { foo := "!" }),
                };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_01a", () => {
    h.script(
      `
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 F := (INSERT Person {name := name}),
                 B := (UPDATE Person FILTER .name = 'Bar' SET {name := name}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_01b", () => {
    h.script(
      `
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 F := (INSERT Person {name := name}),
                 B := (UPDATE Person FILTER .name = 'Bar' SET {name := name}),
            SELECT (SELECT (B, F));
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_02", () => {
    h.script(
      `
            INSERT Person { name := 'Foo' };
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := 'Madeline Hatch',
                 B := (UPDATE Person FILTER .name = 'Bar' SET {name := name}),
                 F := (UPDATE Person FILTER .name = 'Foo' SET {name := name}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_03", () => {
    h.script(
      `
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH
                 F := (INSERT Person {name := 'Bar!'}),
                 B := (UPDATE Person FILTER .name = 'Bar'
                       SET {name := .name ++ "!"}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_04", () => {
    h.script(
      `
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    h.script(
      `
            WITH
                 F := (INSERT Person {name := 'Bar?'}),
                 B := (UPDATE Person FILTER .name = 'Bar'
                       SET {name := .name ++ "!"}),
            SELECT (B, F);
        `
    );
  });

  it("test_edgeql_insert_update_cross_type_conflict_05a", () => {
    h.script(
      `
            INSERT Person { name := 'Foo' };
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            UPDATE Person FILTER true SET { name := "!" };
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_05b", () => {
    h.script(
      `
            INSERT Person { name := 'Foo' };
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH P := Person
            UPDATE P FILTER true SET { name := "!" };
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_06", () => {
    h.script(
      `
            INSERT Person { name := 'Foo' };
            INSERT DerivedPerson { name := 'Bar' };
        `
    );
    expect(() => {
      h.script(
        `
            UPDATE Person FILTER true SET { multi_prop := "!" };
        `
      );
    }).toThrow(new RegExp("multi_prop violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_07a", () => {
    h.script(
      `
            INSERT Person2a { first := 'foo', last := 'bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH
                 F := (INSERT DerivedPerson2a {first := 'foo', last := 'baz'}),
                 B := (UPDATE Person2a FILTER .first = 'foo' and .last = 'bar'
                       SET {last := 'baz'}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("Person2a violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_07b", () => {
    h.script(
      `
            INSERT Person2a { first := 'foo', last := 'bar' };
            INSERT DerivedPerson2a { first := 'spam', last := 'eggs' };
        `
    );
    h.script(
      `
            UPDATE Person2a SET { first := "!" };
        `
    );
  });

  it("test_edgeql_insert_update_cross_type_conflict_08a", () => {
    h.script(
      `
            INSERT Person2b { first := 'foo', last := 'bar' };
        `
    );
    expect(() => {
      h.script(
        `
            WITH
                 F := (INSERT DerivedPerson2b {first := 'foo', last := 'baz'}),
                 B := (UPDATE Person2b FILTER .first = 'foo' and .last = 'bar'
                       SET {last := 'baz'}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_08b", () => {
    h.script(
      `
            INSERT Person2b { first := 'foo', last := 'bar' };
            INSERT DerivedPerson2b { first := 'spam', last := 'eggs' };
        `
    );
    h.script(
      `
            UPDATE Person2b SET { first := "!" };
        `
    );
  });

  it("test_edgeql_insert_update_cross_type_conflict_09a", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str;
            };
            CREATE TYPE Bar EXTENDING Foo  {
                ALTER PROPERTY name {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Baz EXTENDING Bar;

            INSERT Bar { name := "bar" };
            INSERT Baz { name := "baz" };
        `
    );
    expect(() => {
      h.script(
        `
            UPDATE Foo FILTER true SET { name := "!" };
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_09b", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str;
            };
            CREATE TYPE Bar EXTENDING Foo  {
                ALTER PROPERTY name {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Baz EXTENDING Bar;

            INSERT Bar { name := "bar" };
            # INSERT Baz { name := "baz" };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := '!',
                 B := (UPDATE Foo FILTER .name = 'bar' SET {name := name}),
                 F := (INSERT Bar {name := name}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_09c", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str;
            };
            CREATE TYPE Bar EXTENDING Foo  {
                ALTER PROPERTY name {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Baz EXTENDING Bar;

            INSERT Bar { name := "bar" };
            INSERT Baz { name := "baz" };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := '!',
                 B := (UPDATE Foo FILTER .name = 'bar' SET {name := name}),
                 Z := (UPDATE Foo FILTER .name = 'baz' SET {name := name}),
            SELECT (B, Z);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_10", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str;
                CREATE MULTI PROPERTY tags -> str;
            };
            CREATE TYPE Bar EXTENDING Foo  {
                ALTER PROPERTY tags {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Baz EXTENDING Bar;

            INSERT Bar { name := "bar" };
            INSERT Baz { name := "baz" };
        `
    );
    expect(() => {
      h.script(
        `
            UPDATE Foo FILTER true SET { tags := "!" };
        `
      );
    }).toThrow(new RegExp("tags violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_11", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str;
            };
            CREATE TYPE Bar {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Baz EXTENDING Foo, Bar;

            INSERT Baz { name := "baz" };
        `
    );
    expect(() => {
      h.script(
        `
            WITH name := '!',
                 F := (INSERT Bar {name := name}),
                 B := (UPDATE Foo FILTER .name = 'baz' SET {name := name}),
            SELECT (B, F);
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_12", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str;
                CREATE REQUIRED PROPERTY x -> int64;
            };
            CREATE TYPE Bar EXTENDING Foo {
                CREATE REQUIRED PROPERTY y -> int64;
                CREATE CONSTRAINT exclusive on
                    ((__subject__.x + __subject__.y));
            };
            CREATE TYPE Baz EXTENDING Bar;

            INSERT Bar { name := "bar", x := 1, y := 1 };
            INSERT Baz { name := "baz", x := 2, y := 2 };
        `
    );
    expect(() => {
      h.script(
        `
            UPDATE Foo FILTER true SET { x := - .x };
        `
      );
    }).toThrow(new RegExp("Bar violates exclusivity constraint"));
    h.script(
      `
            UPDATE Foo FILTER .name = 'baz' SET { x := 3 };
        `
    );
    h.script(
      `
            UPDATE Foo FILTER true SET { x := - .x };
        `
    );
  });

  it("test_edgeql_insert_update_cross_type_conflict_13", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str;
                CREATE REQUIRED PROPERTY x -> int64;
                CREATE CONSTRAINT expression on ((.x >= 0));
            };
            INSERT Foo { name := "bar", x := 1 };
            INSERT Foo { name := "baz", x := 2 };
        `
    );
    h.script(
      `
            UPDATE Foo FILTER true SET { name := .name };
        `
    );
    h.script(
      `
            UPDATE Foo FILTER true SET { x := .x + 1 };
        `
    );
    h.script(
      `
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    h.script(
      `
            UPDATE Foo FILTER true SET { name := .name };
        `
    );
    h.script(
      `
            UPDATE Foo FILTER true SET { x := .x + 1 };
        `
    );
  });

  it("test_edgeql_insert_update_cross_type_conflict_14", () => {
    h.script(
      `
            create type A {
                create property foo -> int64 {
                    create constraint exclusive;
                }
            };
            create type B extending A;
            create type X extending B;
            create type Y extending B;
        `
    );
    expect(() => {
      h.script(
        `
                with x := (insert X { foo := 0 }),
                     y := (insert Y { foo := 0 }),
                select {x, y};
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_15", () => {
    h.script(
      `
            create required global break -> bool { set default := false; };
            create type X {
                create property foo -> str {
                    create constraint exclusive;
                };
                create access policy yes allow all using (true);
                create access policy no deny select using (
                    global break and exists .foo);
            };
            create type Y extending X;
        `
    );
    h.query(
      `
            insert X;
        `
    );
    h.query(
      `
            insert Y;
        `
    );
    h.script(
      `
            set global break := true
        `
    );
    expect(() => {
      h.query(
        `
                update X set { foo := "!" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_16", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Bar EXTENDING Foo;
            CREATE TYPE Baz EXTENDING Foo;

            INSERT Bar { name := "bar" };
            INSERT Baz { name := "baz" };
        `
    );
    expect(() => {
      h.script(
        `
            UPDATE {Bar, Baz} FILTER true SET { name := "!" };
        `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_insert_update_cross_type_conflict_17", () => {
    h.script(
      `
            create type T;
            create type X {
                create multi link l -> T {
                    create property x -> str { create constraint exclusive; }
                };
            };
            create type Y extending X;
            insert X;
            insert Y;
        `
    );
    expect(() => {
      h.script(
        `
                update X set { l := (insert T { @x := 'x' }) };
            `
      );
    }).toThrow(new RegExp("do not support exclusive constraints on link properties"));
  });

  it("test_edgeql_insert_and_update_01", () => {
    h.script(
      `
            INSERT Person { name := 'foo' };
        `
    );
    expect(() => {
      h.script(
        `
                SELECT (
                    (UPDATE Person FILTER .name = 'foo'
                        SET { name := 'foo' }),
                    (INSERT Person { name := 'foo' })
                )
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_and_delete_01", () => {
    h.script(
      `
            INSERT Person { name := 'foo' };
        `
    );
    expect(() => {
      h.script(
        `
                SELECT (
                    (DELETE Person FILTER .name = 'foo'),
                    (INSERT Person { name := 'foo' })
                )
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_and_delete_02", () => {
    h.script(
      `
            INSERT Note { name := 'delete me' };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Person {
                    name := 'foo',
                    note := (
                        DELETE Note FILTER .name = 'delete me' LIMIT 1
                    )
                }
            `
      );
    }).toThrow(new RegExp("deletion of default::Note.+ is prohibited by link target policy"));
  });

  it("test_edgeql_insert_cardinality_assertion", () => {
    expect(() => {
      h.query(
        `
                INSERT InsertTest {
                    l2 := 10,
                    sub := Subordinate,
                }
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by an expression for a link 'sub' declared as 'single'"));
  });

  it("test_edgeql_insert_volatile_01", () => {
    h.script(
      `
            WITH name := <str>random(),
            INSERT Person { name := name, tag := name };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_02", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                name := x ++ "!",
            INSERT Person { name := name, tag := name };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_03", () => {
    h.script(
      `
            WITH
                x := "!",
                name := x ++ <str>random(),
            INSERT Person { name := name, tag := name };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_04", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                name := x ++ <str>random(),
            INSERT Person { name := name, tag := name };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_05", () => {
    h.script(
      `
            WITH name := <str>random(),
            SELECT (INSERT Person { name := name, tag := name });
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_06", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                name := x ++ "!",
            SELECT (INSERT Person { name := name, tag := name });
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_07", () => {
    h.script(
      `
            WITH
                x := "!",
                name := x ++ <str>random(),
            SELECT (INSERT Person { name := name, tag := name });
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_08", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                name := x ++ <str>random(),
            SELECT (INSERT Person { name := name, tag := name });
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_09", () => {
    h.script(
      `
            WITH x := <str>random()
            SELECT (
                WITH name := x ++ "!"
                INSERT Person { name := name, tag := name }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_10", () => {
    h.script(
      `
            WITH x := "!"
            SELECT (
                WITH name := x ++ <str>random()
                INSERT Person { name := name, tag := name }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_11", () => {
    h.script(
      `
            WITH x := <str>random()
            SELECT (
                WITH name := x ++ <str>random()
                INSERT Person { name := name, tag := name }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_12", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                y := x ++ <str>random(),
            SELECT (
                WITH name := y ++ <str>random()
                INSERT Person { name := name, tag := name }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_13", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := name }
                )
            SELECT (
                INSERT Person {
                    name := x.name ++ "!",
                    tag := x.tag ++ "!",
                    tag2 := x.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_14", () => {
    h.script(
      `
            WITH
                x := "!",
                y := (
                    WITH name := <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
            SELECT (
                INSERT Person {
                    name := x ++ y.name,
                    tag := x ++ y.tag,
                    tag2 := y.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_15", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                y := (
                    WITH name := "!",
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
            SELECT (
                INSERT Person {
                    name := x ++ y.name,
                    tag := x ++ y.tag,
                    tag2 := y.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_16", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                y := (
                    WITH name := <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
            SELECT (
                INSERT Person {
                    name := x ++ y.name,
                    tag := x ++ y.tag,
                    tag2 := y.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_17", () => {
    h.script(
      `
            WITH
                x := "!",
                y := (
                    WITH name := x ++ <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := x }
                ),
            SELECT (
                INSERT Person {
                    name := y.name ++ "!",
                    tag := y.tag ++ "!",
                    tag2 := y.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_18", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                y := (
                    WITH name := x ++ "!",
                    INSERT Person { name := name, tag := name, tag2 := x }
                ),
            SELECT (
                INSERT Person {
                    name := y.name ++ "!",
                    tag := y.tag ++ "!",
                    tag2 := y.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_19", () => {
    h.script(
      `
            WITH
                x := <str>random(),
                y := (
                    WITH name := x ++ <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := x }
                ),
            SELECT (
                INSERT Person {
                    name := y.name ++ "!",
                    tag := y.tag ++ "!",
                    tag2 := y.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_20", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := "!",
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
                y := <str>random(),
            SELECT (
                INSERT Person {
                    name := x.name ++ y,
                    tag := x.tag ++ y,
                    tag2 := x.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_21", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
                y := "!",
            SELECT (
                INSERT Person {
                    name := x.name ++ y,
                    tag := x.tag ++ y,
                    tag2 := x.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_22", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
                y := <str>random(),
            SELECT (
                INSERT Person {
                    name := x.name ++ y,
                    tag := x.tag ++ y,
                    tag2 := x.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_23", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := "!",
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
                y := x.name ++ <str>random(),
            SELECT (
                INSERT Person {
                    name := y,
                    tag := y,
                    tag2 := x.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_24", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
                y := x.name ++ "!",
            SELECT (
                INSERT Person {
                    name := y,
                    tag := y,
                    tag2 := x.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_25", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := <str>random(),
                    INSERT Person { name := name, tag := name, tag2 := name }
                ),
                y := x.name ++ <str>random(),
            SELECT (
                INSERT Person {
                    name := y,
                    tag := y,
                    tag2 := x.tag2,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_26", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := <str>random(),
                    INSERT Person {
                        name := name,
                        tag := name,
                        tag2 := name,
                    }
                ),
                y := (
                    WITH r := <str>random(),
                    INSERT Person {
                        name := x.name ++ r,
                        tag := x.tag ++ r,
                        tag2 := x.tag,
                    }
                ),
            SELECT (
                WITH r := <str>random(),
                INSERT Person {
                    name := y.name ++ r,
                    tag := y.name ++ r,
                    tag2 := y.tag ++ r,
                }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [2]
    );
  });

  it("test_edgeql_insert_volatile_27", () => {
    h.script(
      `
            WITH x := "!"
            INSERT Person {
                name := x,
                tag := x,
                note := (
                    WITH y := <str>random()
                    insert Note { name := y, note := y }
                )
            };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `WITH N := (Note {ok := .name = .note}) SELECT all(N.ok)`,
      [true]
    );
  });

  it("test_edgeql_insert_volatile_28", () => {
    h.script(
      `
            WITH x := <str>random(),
            INSERT Person {
                name := x,
                tag := x,
                note := (
                    WITH y := <str>random()
                    insert Note { name := y, note := y }
                )
            };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `WITH N := (Note {ok := .name = .note}) SELECT all(N.ok)`,
      [true]
    );
  });

  it("test_edgeql_insert_volatile_29", () => {
    h.script(
      `
            WITH x := "!",
            INSERT Person {
                name := x,
                tag := x,
                note := (
                    WITH y := x ++ <str>random()
                    insert Note { name := y, note := y }
                )
            };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `WITH N := (Note {ok := .name = .note}) SELECT all(N.ok)`,
      [true]
    );
  });

  it("test_edgeql_insert_volatile_30", () => {
    h.script(
      `
            WITH x := <str>random(),
            INSERT Person {
                name := x,
                tag := x,
                note := (
                    WITH y := x ++ "!"
                    insert Note { name := y, note := y }
                )
            };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `WITH N := (Note {ok := .name = .note}) SELECT all(N.ok)`,
      [true]
    );
  });

  it("test_edgeql_insert_volatile_31", () => {
    h.script(
      `
            WITH x := <str>random(),
            INSERT Person {
                name := x,
                tag := x,
                note := (
                    WITH y := x ++ <str>random()
                    insert Note { name := y, note := y }
                )
            };
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `WITH N := (Note {ok := .name = .note}) SELECT all(N.ok)`,
      [true]
    );
  });

  it("test_edgeql_insert_volatile_32", () => {
    h.script(
      `
            FOR name in {<str>random(), <str>random()}
            UNION (INSERT Person { name := name, tag := name });
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
  });

  it("test_edgeql_insert_volatile_33", () => {
    h.script(
      `
            WITH x := "!"
            FOR y in {<str>random(), <str>random()}
            UNION (
                WITH name := x ++ y
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_34", () => {
    h.script(
      `
            WITH x := <str>random()
            FOR y in {"A", "B"}
            UNION (
                WITH name := x ++ y
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_35", () => {
    h.script(
      `
            WITH x := <str>random()
            FOR y in {<str>random(), <str>random()}
            UNION (
                WITH name := x ++ y
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_36", () => {
    h.script(
      `
            WITH x := "!"
            FOR name in {x ++ <str>random(), x ++ <str>random()}
            UNION (
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_37", () => {
    h.script(
      `
            WITH x := <str>random()
            FOR name in {x ++ "A", x ++ "B"}
            UNION (
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_38", () => {
    h.script(
      `
            WITH x := <str>random()
            FOR name in {x ++ <str>random(), x ++ <str>random()}
            UNION (
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_volatile_39", () => {
    h.script(
      `
            FOR x in {"A", "B"}
            UNION (
                WITH name := x ++ <str>random()
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [2]
    );
  });

  it("test_edgeql_insert_volatile_40", () => {
    h.script(
      `
            FOR x in {<str>random(), <str>random()}
            UNION (
                WITH name := x ++ "!"
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [2]
    );
  });

  it("test_edgeql_insert_volatile_41", () => {
    h.script(
      `
            FOR x in {<str>random(), <str>random()}
            UNION (
                WITH name := x ++ <str>random()
                INSERT Person { name := name, tag := name, tag2 := x }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [2]
    );
  });

  it("test_edgeql_insert_volatile_42", () => {
    h.script(
      `
            WITH
                x := (
                    WITH name := <str>random(),
                    INSERT Person {
                        name := name,
                        tag := name,
                        tag2 := name,
                    }
                )
            FOR y in {<str>random(), <str>random()}
            UNION (
                WITH name := x.name ++ y
                INSERT Person { name := name, tag := name, tag2 := x.tag2 }
            );
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.tag2))`,
      [1]
    );
  });

  it("test_edgeql_insert_with_freeobject_01", () => {
    h.script(
      `
            WITH free := { name := "asdf" },
            SELECT (INSERT Person { name := free.name });
        `
    );
    assertQueryResult(
      h,
      `SELECT Person.name = "asdf"`,
      [true]
    );
  });

  it("test_edgeql_insert_with_freeobject_02", () => {
    h.script(
      `
            WITH free := { name := <str>random() },
            SELECT (INSERT Person { name := free.name, tag := free.name });
        `
    );
    assertQueryResult(
      h,
      `WITH P := (Person {ok := .name = .tag}) SELECT all(P.ok)`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT count(distinct(Person.name))`,
      [1]
    );
  });

  it("test_edgeql_insert_multi_exclusive_01", () => {
    h.script(
      `
            INSERT Person { name := "asdf", multi_prop := "a" };
        `
    );
    h.script(
      `
            DELETE Person;
        `
    );
    h.script(
      `
            INSERT Person { name := "asdf", multi_prop := "a" };
        `
    );
  });

  it("test_edgeql_insert_enumerate_01", () => {
    assertQueryResult(
      h,
      `
                WITH
                     F := (INSERT Subordinate {name := "!"}),
                     B := (INSERT Subordinate {name := "??"}),
                     Z := enumerate((F, B)),
                SELECT (Z.0, Z.1.0, Z.1.1);
            `,
      [
            [
              0,
              {},
              {},
            ],
          ]
    );
  });

  it("test_edgeql_insert_nested_and_with_01", () => {
    assertQueryResult(
      h,
      `
                WITH
                    New := (
                        INSERT Person {
                            name := "test",
                            notes := (INSERT Note { name := "test" })
                         }
                    ),
                SELECT (
                    INSERT Person2a {
                        first := New.name, last := "!", bff := New,
                    }
                ) {
                    first,
                    bff: {
                        name,
                        notes: { name }
                    }
                };
            `,
      [
            {
              "first": "test",
              "bff": {
                "name": "test",
                "notes": [
                  {
                    "name": "test",
                  },
                ],
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_specified_type", () => {
    expect(() => {
      h.script(
        `
                INSERT Person {
                    __type__ := (introspect Object),
                    name := "test",
                 }
            `
      );
    }).toThrow(new RegExp("cannot assign to link '__type__'"));
  });

  it("test_edgeql_insert_explicit_id_00", () => {
    expect(() => {
      h.script(
        `
                INSERT Person {
                    id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    name := "test",
                 }
            `
      );
    }).toThrow(new RegExp("cannot assign to property 'id'"));
  });

  it("test_edgeql_insert_explicit_id_01", () => {
    h.script(
      `
            configure session set allow_user_specified_id := true
        `
    );
    h.script(
      `
            INSERT Person {
                id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                name := "test",
             }
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Person
            `,
      [
            {
              "id": "ffffffff-ffff-ffff-ffff-ffffffffffff",
            },
          ]
    );
  });

  it("test_edgeql_insert_explicit_id_02", () => {
    h.script(
      `
            configure session set allow_user_specified_id := true
        `
    );
    h.script(
      `
            INSERT Person {
                id := <uuid>to_json('"ffffffff-ffff-ffff-ffff-ffffffffffff"'),
                name := "test",
             }
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Person {
                    id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    name := "test2",
                 }
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_explicit_id_03", () => {
    h.script(
      `
            configure session set allow_user_specified_id := true
        `
    );
    h.script(
      `
            INSERT Person {
                id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                name := "test",
             }
        `
    );
    expect(() => {
      h.script(
        `
                INSERT DerivedPerson {
                    id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    name := "test2",
                 }
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_explicit_id_04", () => {
    h.script(
      `
            configure session set allow_user_specified_id := true
        `
    );
    h.script(
      `
            create required global break -> bool { set default := false; };
            create type X {
                create access policy yes allow all using (true);
                create access policy no deny select using (global break);
            };
            create type Y;
        `
    );
    h.query(
      `
            insert X {
                id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff'
            };
        `
    );
    h.script(
      `
            set global break := true
        `
    );
    expect(() => {
      h.query(
        `
                insert Y {
                    id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff'
                };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_explicit_id_05", () => {
    h.script(
      `
            configure session set allow_user_specified_id := true
        `
    );
    h.script(
      `
            INSERT Person {
                id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                name := "test",
             }
        `
    );
    assertQueryResult(
      h,
      `
                INSERT Person {
                    id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    name := "test",
                 } UNLESS CONFLICT
            `,
      []
    );
    assertQueryResult(
      h,
      `
                INSERT Person {
                    id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    name := "test",
                 } UNLESS CONFLICT ON (.id)
            `,
      []
    );
    assertQueryResult(
      h,
      `
                INSERT Note {
                    id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    name := "test",
                 } UNLESS CONFLICT
            `,
      []
    );
    assertQueryResult(
      h,
      `
                INSERT Note {
                    id := <uuid>'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    name := "test",
                 } UNLESS CONFLICT ON (.id)
            `,
      []
    );
  });

  it("test_edgeql_insert_explicit_id_06", () => {
    h.script(
      `
            configure session set allow_user_specified_id := true
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Person {
                    id := <optional uuid>{},
                    name := "test",
                }
            `
      );
    }).toThrow(new RegExp("missing value for required property"));
  });

  it("test_edgeql_insert_optional_cast_01", () => {
    assertQueryResult(
      h,
      `
                insert CollectionTest {
                    str_array := <array<str>>to_json('null')
                };
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_insert_except_constraint_01", () => {
    h.script(
      `
            insert ExceptTest { name := "foo" };
        `
    );
    expect(() => {
      h.script(
        `
                insert ExceptTest { name := "foo" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                insert ExceptTest { name := "foo", deleted := false };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    h.script(
      `
            insert ExceptTest { name := "foo", deleted := true };
        `
    );
    h.script(
      `
            insert ExceptTest { name := "bar", deleted := true };
        `
    );
    h.script(
      `
            insert ExceptTest { name := "bar", deleted := true };
        `
    );
    h.script(
      `
            insert ExceptTest { name := "bar" };
        `
    );
    expect(() => {
      h.script(
        `
                insert ExceptTest { name := "bar" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    h.script(
      `
            insert ExceptTest { name := "baz" };
        `
    );
    h.script(
      `
            insert ExceptTestSub { name := "bar", deleted := true };
        `
    );
    h.script(
      `
            alter type ExceptTest {
                drop constraint exclusive on (.name) except (.deleted);
            };
        `
    );
    h.script(
      `
            alter type ExceptTest {
                create constraint exclusive on (.name) except (.deleted);
            };
        `
    );
    h.script(
      `
            alter type ExceptTest {
                drop constraint exclusive on (.name) except (.deleted);
            };
        `
    );
    h.script(
      `
            insert ExceptTestSub { name := "baz" };
        `
    );
    expect(() => {
      h.script(
        `
                alter type ExceptTest {
                    create constraint exclusive on (.name) except (.deleted);
                };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_except_constraint_02", () => {
    expect(() => {
      h.script(
        `
                select {
                    (insert ExceptTest { name := "foo" }),
                    (insert ExceptTestSub { name := "foo" }),
                };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                select {
                    (insert ExceptTest { name := "foo" }),
                    (insert ExceptTestSub { name := "foo", deleted := false }),
                };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    h.script(
      `
            select {
                (insert ExceptTest { name := "foo" }),
                (insert ExceptTestSub { name := "foo", deleted := true }),
            };
        `
    );
  });

  it("test_edgeql_insert_except_constraint_03", () => {
    h.script(
      `
            insert ExceptTest { name := "a" };
            insert ExceptTestSub { name := "b" };
        `
    );
    expect(() => {
      h.script(
        `
                update ExceptTest set { name := "foo" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    h.script(
      `
            update ExceptTest set { name := "foo", deleted := true };
        `
    );
    expect(() => {
      h.script(
        `
                update ExceptTest set { deleted := false };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                update ExceptTest set { deleted := {} };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_insert_except_constraint_04", () => {
    expect(() => {
      h.query(
        `
                select { single x := (select ExceptTest filter .name = 'foo') }
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned"));
  });

  it("test_edgeql_insert_in_free_object_01", () => {
    assertQueryResult(
      h,
      `
                select {
                    obj := (
                        INSERT InsertTest {
                            name := 'insert simple 01',
                            l2 := 0,
                        }
                     )
                }
            `,
      [
            {
              "obj": {
                "id": "str",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
                select {
                    obj := (
                        INSERT InsertTest {
                            name := 'insert simple 02',
                            l2 := 0,
                        }
                     ) { name, l2 }
                }
            `,
      [
            {
              "obj": {
                "name": "insert simple 02",
                "l2": 0,
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
                select {
                    objs := (
                        for name in {'one', 'two'} union (
                            INSERT InsertTest {
                                name := name, l2 := 0,
                            }
                        )
                    )
                }
            `,
      [
            {
              "objs": [
                {
                  "id": "str",
                },
                {
                  "id": "str",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_insert_in_free_object_02", () => {
    expect(() => {
      h.query(
        `
                select { foo := 1 } {
                    obj := (
                        INSERT InsertTest {
                            name := 'insert simple 02',
                            l2 := 0,
                        }
                     ) { name, l2 }
                }
            `
      );
    }).toThrow(new RegExp("mutations are invalid in a shape's computed expression"));
    expect(() => {
      h.query(
        `
                select (for x in {1,2} union FreeObject) {
                    obj := (
                        INSERT InsertTest {
                            name := 'insert simple 01',
                            l2 := 0,
                        }
                     )
                };
            `
      );
    }).toThrow(new RegExp("mutations are invalid in a shape's computed expression"));
    expect(() => {
      h.query(
        `
                with X := {
                    obj := (
                        INSERT InsertTest {
                            name := 'insert simple 01',
                            l2 := 0,
                        }
                     )
                }, select X;
            `
      );
    }).toThrow(new RegExp("mutations are invalid in a shape's computed expression"));
  });

  it("test_edgeql_insert_rebind_with_typenames_01", () => {
    assertQueryResult(
      h,
      `
            with
              update1 := (insert InsertTest {l2:=1}),
            select (select update1);
            `,
      [
            {
              "id": "str",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            with
              update1 := (insert InsertTest {l2:=1}),
            select {update1};
            `,
      [
            {
              "id": "str",
            },
          ]
    );
  });

  it("test_edgeql_insert_pointless_shape_elements_01", () => {
    h.script(
      `
            insert Person {
                name := "test",
                notes := (select Note { foo := 0 })
            };
        `
    );
  });

  it("test_edgeql_insert_bogus_correlation_typenames", () => {
    h.query(
      `
            for l2 in <int64>{} union (
                with
                  subs := (select Subordinate filter .name = '')
                insert InsertTest {
                  subordinates := subs,
                  l2 := l2,
                }
            );
        `
    );
  });

  it("test_edgeql_insert_single_linkprop", () => {
    h.script(
      `
            insert Subordinate { name := "1" };
            insert Subordinate { name := "2" };
        `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    h.script(
      `
                insert InsertTest {
                    l2 := -1,
                    sub := (select Subordinate { @note := "!" }
                             order by random() limit 1)
                };
            `
    );
    assertQueryResult(
      h,
      `
            select InsertTest { sub: {name, @note} };
            `,
      [
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
          ]
    );
    h.script(
      `
            update InsertTest set {
                sub := (select Subordinate { @note := "!" }
                         order by random() limit 1)
            };
        `
    );
    assertQueryResult(
      h,
      `
            select InsertTest { sub: {name, @note} };
            `,
      [
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
            {
              "sub": {
                "name": "str",
                "@note": "!",
              },
            },
          ]
    );
  });

  it("test_edgeql_insert_conditional_01", () => {
    assertQueryResult(
      h,
      `
            select if <bool>$0 then (
                insert InsertTest { l2 := 2 }
            ) else (
                insert DerivedTest { l2 := 200 }
            )
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select InsertTest { l2, tname := .__type__.name }
            `,
      [
            {
              "l2": 2,
              "tname": "default::InsertTest",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select if <bool>$0 then (
                insert InsertTest { l2 := 2 }
            ) else (
                insert DerivedTest { l2 := 200 }
            )
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select InsertTest { l2, tname := .__type__.name } order by  .l2
            `,
      [
            {
              "l2": 2,
              "tname": "default::InsertTest",
            },
            {
              "l2": 200,
              "tname": "default::DerivedTest",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select if array_unpack(<array<bool>>$0) then (
                insert InsertTest { l2 := 2 }
            ) else (
                insert DerivedTest { l2 := 200 }
            )
            `,
      [
            {},
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            with go := <bool>$0
            select if go then (
                insert InsertTest { l2 := 100 }
            ) else {}
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select InsertTest { l2, tname := .__type__.name } order by  .l2
            `,
      [
            {
              "l2": 2,
              "tname": "default::InsertTest",
            },
            {
              "l2": 2,
              "tname": "default::InsertTest",
            },
            {
              "l2": 100,
              "tname": "default::InsertTest",
            },
            {
              "l2": 200,
              "tname": "default::DerivedTest",
            },
            {
              "l2": 200,
              "tname": "default::DerivedTest",
            },
          ]
    );
  });

  it("test_edgeql_insert_conditional_02", () => {
    h.script(
      `
            select ((if ExceptTest.deleted then (
                insert InsertTest { l2 := 2 }
            ) else (
                insert DerivedTest { l2 := 200 }
            )), (select ExceptTest.deleted limit 1));
        `
    );
  });

  it("test_edgeql_insert_conditional_03", () => {
    assertQueryResult(
      h,
      `
            select (for n in array_unpack(<array<int64>>$0) union (
                if n % 2 = 0 then
                  (insert InsertTest { l2 := n }) else {}
            )) { l2 } order by .l2;
            `,
      [
            {
              "l2": 2,
            },
            {
              "l2": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select InsertTest { l2 } order by .l2;
            `,
      [
            {
              "l2": 2,
            },
            {
              "l2": 4,
            },
          ]
    );
  });

  it("test_edgeql_insert_coalesce_01", () => {
    assertQueryResult(
      h,
      `
            select (select InsertTest filter .l2 = 2) ??
              (insert InsertTest { l2 := 2 });
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select (select InsertTest filter .l2 = 2) ??
              (insert InsertTest { l2 := 2 });
            `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
            select count((delete InsertTest))
            `,
      [1]
    );
  });

  it("test_edgeql_insert_coalesce_02", () => {
    assertQueryResult(
      h,
      `
            select ((select InsertTest filter .l2 = 2), true) ??
              ((insert InsertTest { l2 := 2 }), false);
            `,
      [
            [
              {},
              false,
            ],
          ]
    );
    assertQueryResult(
      h,
      `
            select ((select InsertTest filter .l2 = 2), true) ??
              ((insert InsertTest { l2 := 2 }), false);
            `,
      [
            [
              {},
              true,
            ],
          ]
    );
  });

  it("test_edgeql_insert_coalesce_03", () => {
    assertQueryResult(
      h,
      `
            select (
                (update InsertTest filter .l2 = 2 set { name := "!" }) ??
                  (insert InsertTest { l2 := 2, name := "?" })
            ) { l2, name }
            `,
      [
            {
              "l2": 2,
              "name": "?",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (
                (update InsertTest filter .l2 = 2 set { name := "!" }) ??
                  (insert InsertTest { l2 := 2, name := "?" })
            ) { l2, name }
            `,
      [
            {
              "l2": 2,
              "name": "!",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select InsertTest { l2, name }
            `,
      [
            {
              "l2": 2,
              "name": "!",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select count((delete InsertTest))
            `,
      [1]
    );
  });

  it("test_edgeql_insert_coalesce_04", () => {
    assertQueryResult(
      h,
      `
        select (for n in array_unpack(<array<int64>>$0) union (
            (update InsertTest filter .l2 = n set { name := "!" }) ??
              (insert InsertTest { l2 := n, name := "?" })
        )) { l2, name, new := .id not in InsertTest.id } order by .l2
        `,
      [
            {
              "l2": 1,
              "name": "?",
              "new": true,
            },
            {
              "l2": 2,
              "name": "?",
              "new": true,
            },
          ]
    );
    assertQueryResult(
      h,
      `
        select (for n in array_unpack(<array<int64>>$0) union (
            (update InsertTest filter .l2 = n set { name := "!" }) ??
              (insert InsertTest { l2 := n, name := "?" })
        )) { l2, name, new := .id not in InsertTest.id } order by .l2
        `,
      [
            {
              "l2": 0,
              "name": "?",
              "new": true,
            },
            {
              "l2": 1,
              "name": "!",
              "new": false,
            },
            {
              "l2": 2,
              "name": "!",
              "new": false,
            },
            {
              "l2": 3,
              "name": "?",
              "new": true,
            },
          ]
    );
  });

  it("test_edgeql_insert_coalesce_05", () => {
    h.script(
      `
            insert Subordinate { name := "foo" };
        `
    );
    assertQueryResult(
      h,
      `
        for sub in Subordinate union (
          (select Note filter .subject = sub) ??
          (insert Note { name := "", subject := sub })
        );
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
        for sub in Subordinate union (
          (select Note filter .subject = sub) ??
          (insert Note { name := "", subject := sub })
        );
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `select count(Note)`,
      [1]
    );
    h.script(
      `
            insert Subordinate { name := "bar" };
            insert Subordinate { name := "baz" };
        `
    );
    assertQueryResult(
      h,
      `
        for sub in Subordinate union (
          (select Note filter .subject = sub) ??
          (insert Note { name := "", subject := sub })
        );
        `,
      [
            {},
            {},
            {},
          ]
    );
    assertQueryResult(
      h,
      `
        for sub in Subordinate union (
          (select Note filter .subject = sub) ??
          (insert Note { name := "", subject := sub })
        );
        `,
      [
            {},
            {},
            {},
          ]
    );
    assertQueryResult(
      h,
      `select count(Note)`,
      [3]
    );
  });

  it("test_edgeql_insert_coalesce_nulls_01", () => {
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Person filter .name = name) ??
               (insert Person { name := name})
             ),
        select { new := new }
        `,
      [
            {
              "new": {},
            },
          ]
    );
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Person filter .name = name) ??
               (insert Person { name := name})
             ),
        select { new := new }
        `,
      [
            {
              "new": {},
            },
          ]
    );
  });

  it("test_edgeql_insert_coalesce_nulls_02", () => {
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Person filter .name = name) ??
               (insert Person { name := name})
             ),
        select (
          insert Note { name := '??', subject := new }
        ) { subject }
        `,
      [
            {
              "subject": {},
            },
          ]
    );
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Person filter .name = name) ??
               (insert Person { name := name})
             ),
        select (
          insert Note { name := '??', subject := new }
        ) { subject }
        `,
      [
            {
              "subject": {},
            },
          ]
    );
  });

  it("test_edgeql_insert_coalesce_nulls_03", () => {
    h.script(
      `
            insert Note { name := 'x' }
        `
    );
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Person filter .name = name) ??
               (insert Person { name := name})
             ),
        select (update Note filter .name = 'x' set { subject := new })
               { subject }
        `,
      [
            {
              "subject": {},
            },
          ]
    );
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Person filter .name = name) ??
               (insert Person { name := name})
             ),
        select (update Note filter .name = 'x' set { subject := new })
               { subject }
        `,
      [
            {
              "subject": {},
            },
          ]
    );
  });

  it("test_edgeql_insert_coalesce_nulls_04", () => {
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Note filter .name = name) ??
               (insert Note { name := name })
             ),
        select { new := assert_single(new) }
        `,
      [
            {
              "new": {},
            },
          ]
    );
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Note filter .name = name) ??
               (insert Note { name := name })
             ),
        select { new := assert_single(new) }
        `,
      [
            {
              "new": {},
            },
          ]
    );
  });

  it("test_edgeql_insert_coalesce_nulls_05", () => {
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Note filter .name = name) ??
               (insert Note { name := name})
             ),
        select (
          insert Note { name := '??', subject := assert_single(new) }
        ) { subject }
        `,
      [
            {
              "subject": {},
            },
          ]
    );
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Note filter .name = name) ??
               (insert Note { name := name})
             ),
        select (
          insert Note { name := '??', subject := assert_single(new) }
        ) { subject }
        `,
      [
            {
              "subject": {},
            },
          ]
    );
  });

  it("test_edgeql_insert_coalesce_nulls_06", () => {
    h.script(
      `
            insert Note { name := 'x' }
        `
    );
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Note filter .name = name) ??
               (insert Note { name := name })
             ),
        select (update Note filter .name = 'x' set {
                  subject := assert_single(new) })
               { subject }
        `,
      [
            {
              "subject": {},
            },
          ]
    );
    assertQueryResult(
      h,
      `
        with name := 'name',
             new := (
               (select Note filter .name = name) ??
               (insert Note { name := name })
             ),
        select (update Note filter .name = 'x' set {
                  subject := assert_single(new) })
               { subject }
        `,
      [
            {
              "subject": {},
            },
          ]
    );
  });

  it("test_edgeql_insert_coalesce_nulls_08", () => {
    assertQueryResult(
      h,
      `
        with l2 := 420,
        select (
          if <bool>$0 then (
            (delete DerivedTest filter .l2 = l2)
            ??
            (insert DerivedTest {l2 := l2})
          ) else (
            (update Note filter .name = <str>l2 set { note := "note" })
            ??
            (insert Note {name := <str>l2})
          )
        );
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
        with l2 := 420,
        select (
          if <bool>$0 then (
            (delete DerivedTest filter .l2 = l2)
            ??
            (insert DerivedTest {l2 := l2})
          ) else (
            (update Note filter .name = <str>l2 set { note := "note" })
            ??
            (insert Note {name := <str>l2})
          )
        );
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `select DerivedTest`,
      []
    );
    assertQueryResult(
      h,
      `
        with l2 := 420,
        select (
          if <bool>$0 then (
            (delete DerivedTest filter .l2 = l2)
            ??
            (insert DerivedTest {l2 := l2})
          ) else (
            (update Note filter .name = <str>l2 set { note := "note" })
            ??
            (insert Note {name := <str>l2})
          )
        );
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `
        with l2 := 420,
        select (
          if <bool>$0 then (
            (delete DerivedTest filter .l2 = l2)
            ??
            (insert DerivedTest {l2 := l2})
          ) else (
            (update Note filter .name = <str>l2 set { note := "note" })
            ??
            (insert Note {name := <str>l2})
          )
        );
        `,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `select Note { note }`,
      [
            {
              "note": "note",
            },
          ]
    );
  });

  it("test_edgeql_insert_empty_array_01", () => {
    expect(() => {
      h.script(
        `
                insert InsertTest {
                    name := [],
                    l2 := 0,
                };
            `
      );
    }).toThrow(new RegExp("expression returns value of indeterminate type"));
  });

  it("test_edgeql_insert_empty_array_02", () => {
    expect(() => {
      h.script(
        `
                insert InsertTest {
                    name := ['a'] ++ [],
                    l2 := 0,
                };
            `
      );
    }).toThrow(new RegExp("invalid target for property 'name' of object type 'default::InsertTest': 'array<std::str>' \\(expecting 'std::str'\\)"));
  });

  it("test_edgeql_insert_empty_array_03", () => {
    expect(() => {
      h.script(
        `
                insert InsertTest {
                    name := array_unpack([1] ++ []),
                    l2 := 0,
                };
            `
      );
    }).toThrow(new RegExp("invalid target for property 'name' of object type 'default::InsertTest': 'std::int64' \\(expecting 'std::str'\\)"));
  });

  it("test_edgeql_insert_empty_array_04", () => {
    expect(() => {
      h.script(
        `
                insert InsertTest {
                    l2 := 0,
                    subordinates := (
                        select Subordinate {
                            @comment := []
                        }
                    )
                };
            `
      );
    }).toThrow(new RegExp("expression returns value of indeterminate type"));
  });

  it("test_edgeql_insert_empty_array_05", () => {
    assertQueryResult(
      h,
      `
            insert Subordinate { name := 'hi' };
            select ( insert InsertTest {
                l2 := 0,
                subordinates := (
                    select Subordinate {
                        @comment := array_join(['a'] ++ [], '')
                    }
                )
            }) { l2, subordinates: { name, @comment } };
            `,
      [
            {
              "l2": 0,
              "subordinates": [
                {
                  "name": "hi",
                  "@comment": "a",
                },
              ],
            },
          ]
    );
  });

  it.skip("test_edgeql_insert_read_only_tx_01", () => {
    // The Python original exercises EdgeDB client read-only transactions;
    // QueryHarness does not expose transaction options yet.
  });

  it.skip("test_edgeql_insert_read_only_tx_02", () => {
    h.script(
      `insert Subordinate { name := 'hi' }`
    );
  });
});

describe("TestRepeatableReadInsert", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "insert"
    });
  });

  it("test_edgeql_rr_insert_01", () => {
    h.script(
      `
            insert ConflictA {
                name := "test"
            };
        `
    );
  });

  it("test_edgeql_rr_insert_02", () => {
    expect(() => {
      h.script(
        `
                insert ConflictB {
                    name := "test"
                };
            `
      );
    }).toThrow(new RegExp("INSERT to object type 'default::ConflictB' affects an exclusive constraint on property 'name' of object type 'default::ConflictB' that is shared with descendant types: 'default::ConflictAB'"));
  });

  it("test_edgeql_rr_insert_03", () => {
    expect(() => {
      h.script(
        `
                insert ConflictAB {
                    name := "test"
                };
            `
      );
    }).toThrow(new RegExp("INSERT to object type 'default::ConflictAB' affects an exclusive constraint on property 'name' of object type 'default::ConflictAB' that is defined in ancestor object type 'default::ConflictB'"));
  });

  it("test_edgeql_rr_insert_04", () => {
    expect(() => {
      h.script(
        `
                INSERT Person2a {
                    first := "Emmanuel",
                    last := "Villip",
                }
            `
      );
    }).toThrow(new RegExp("an exclusive constraint on object type 'default::Person2a' with expression '\\(\\.first, \\.bff\\)'"));
  });

  it("test_edgeql_rr_update_01", () => {
    expect(() => {
      h.script(
        `
                update ConflictA set {
                    name := "test"
                };
            `
      );
    }).toThrow(new RegExp("UPDATE to object type 'default::ConflictAB' affects an exclusive constraint on property 'name' of object type 'default::ConflictAB' that is defined in ancestor object type 'default::ConflictB'"));
  });

  it("test_edgeql_rr_update_02", () => {
    expect(() => {
      h.script(
        `
                update ConflictB set {
                    name := "test"
                };
            `
      );
    }).toThrow(new RegExp("UPDATE to object type 'default::ConflictB' affects an exclusive constraint on property 'name' of object type 'default::ConflictB' that is shared with descendant types: 'default::ConflictAB'"));
  });

  it("test_edgeql_rr_update_03", () => {
    expect(() => {
      h.script(
        `
                update ConflictAB set {
                    name := "test"
                };
            `
      );
    }).toThrow(new RegExp("UPDATE to object type 'default::ConflictAB' affects an exclusive constraint on property 'name' of object type 'default::ConflictAB' that is defined in ancestor object type 'default::ConflictB'"));
  });

  it("test_edgeql_rr_update_04", () => {
    h.query(
      `
                update (
                    select Person
                    filter .name = 'adsf'
                ).note set {};
            `
    );
  });
});
