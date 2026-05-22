import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  queryRows,
  querySingle,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestDelete", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      dbFile: "./tests/.artifacts/delete.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_delete_bad_01", () => {
    expect(() => {
      h.script(
        `                DELETE 42;
            `
      );
    }).toThrow(new RegExp("cannot delete non-ObjectType object"));
  });

  it("test_edgeql_delete_bad_02", () => {
    expect(() => {
      h.script(
        `                WITH foo := {bar := 1}
                DELETE foo
            `
      );
    }).toThrow(new RegExp("free objects cannot be deleted"));
    expect(() => {
      h.script(
        `                DELETE std::FreeObject
            `
      );
    }).toThrow(new RegExp("free objects cannot be deleted"));
  });

  it("test_edgeql_delete_bad_03", () => {
    expect(() => {
      h.script(
        `                DELETE schema::Object;
            `
      );
    }).toThrow(new RegExp("delete standard library type"));
    expect(() => {
      h.script(
        `                DELETE {default::LinkingType, schema::Object};
            `
      );
    }).toThrow(new RegExp("delete standard library type"));
  });

  it("test_edgeql_delete_simple_01", () => {
    h.script(
      `
            DELETE DeleteTest;
        `
    );
    h.script(
      `
            INSERT DeleteTest {
                name := 'delete-test'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DeleteTest;
            `,
      [
            {},
          ]
    );
    h.script(
      `
            DELETE DeleteTest;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DeleteTest;
            `,
      []
    );
  });

  it("test_edgeql_delete_simple_02", () => {
    let id1 = String(querySingle<{ id: string }>(h, "\n            SELECT(INSERT DeleteTest {\n                name := 'delete-test1'\n            }) LIMIT 1;\n        ").id);
    let id2 = String(querySingle<{ id: string }>(h, "\n            SELECT(INSERT DeleteTest {\n                name := 'delete-test2'\n            }) LIMIT 1;\n        ").id);
    assertQueryResult(
      h,
      `
                DELETE (SELECT DeleteTest
                        FILTER DeleteTest.name = 'bad name');
            `,
      []
    );
    assertQueryResult(
      h,
      `
                SELECT DeleteTest ORDER BY DeleteTest.name;
            `,
      [{"id": id1}, {"id": id2}]
    );
    assertQueryResult(
      h,
      `
                SELECT (DELETE (SELECT DeleteTest
                        FILTER DeleteTest.name = 'delete-test1'));
            `,
      [{"id": id1}]
    );
    assertQueryResult(
      h,
      `
                SELECT DeleteTest ORDER BY DeleteTest.name;
            `,
      [{"id": id2}]
    );
    assertQueryResult(
      h,
      `
                SELECT (DELETE (SELECT DeleteTest
                        FILTER DeleteTest.name = 'delete-test2'));
            `,
      [{"id": id2}]
    );
    assertQueryResult(
      h,
      `
                SELECT DeleteTest ORDER BY DeleteTest.name;
            `,
      []
    );
  });

  it("test_edgeql_delete_returning_01", () => {
    let id1 = String(querySingle<{ id: string }>(h, "\n            SELECT (INSERT DeleteTest {\n                name := 'delete-test1'\n            }) LIMIT 1;\n        ").id);
    h.script(
      `
            INSERT DeleteTest {
                name := 'delete-test2'
            };
            INSERT DeleteTest {
                name := 'delete-test3'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (DELETE DeleteTest
                        FILTER DeleteTest.name = 'delete-test1');
            `,
      [{"id": id1}]
    );
    assertQueryResult(
      h,
      `
                WITH
                    D := (DELETE DeleteTest
                          FILTER DeleteTest.name = 'delete-test2')
                SELECT D {name};
            `,
      [
            {
              "name": "delete-test2",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT
                    (DELETE DeleteTest
                     FILTER DeleteTest.name = 'delete-test3'
                    ).name ++ '--DELETED';
            `,
      ["delete-test3--DELETED"]
    );
  });

  it("test_edgeql_delete_returning_02", () => {
    h.script(
      `
            INSERT DeleteTest {
                name := 'delete-test1'
            };
            INSERT DeleteTest {
                name := 'delete-test2'
            };
            INSERT DeleteTest {
                name := 'delete-test3'
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH D := (DELETE DeleteTest)
                SELECT count(D);
            `,
      [3]
    );
  });

  it("test_edgeql_delete_returning_03", () => {
    h.script(
      `
            INSERT DeleteTest {
                name := 'dt1.1'
            };
            INSERT DeleteTest {
                name := 'dt1.2'
            };
            INSERT DeleteTest {
                name := 'dt1.3'
            };
            # create a different object
            INSERT DeleteTest2 {
                name := 'dt2.1'
            };

            INSERT DeleteTest2 {
                name := 'delete test2.2'
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    D := (DELETE DeleteTest)
                SELECT DeleteTest2 {
                    name,
                    foo := 'bar'
                } FILTER any(DeleteTest2.name LIKE D.name[:2] ++ '%');
            `,
      [
            {
              "name": "dt2.1",
              "foo": "bar",
            },
          ]
    );
    let deleted = queryRows<Record<string, unknown>>(h, "\n                DELETE DeleteTest2;\n            ");
    expect(Object.prototype.hasOwnProperty.call(deleted[0], "__tid__")).toBeTruthy();
    expect(deleted[0].__tname__).toEqual("default::DeleteTest2");
  });

  it("test_edgeql_delete_returning_04", () => {
    h.script(
      `
            INSERT DeleteTest {
                name := 'dt1.1'
            };
            INSERT DeleteTest {
                name := 'dt1.2'
            };
            INSERT DeleteTest {
                name := 'dt1.3'
            };
            # create a different object
            INSERT DeleteTest2 {
                name := 'dt2.1'
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    # make sure that aliased deletion works as an expression
                    #
                    Q := (DELETE DeleteTest)
                SELECT DeleteTest2 {
                    name,
                    count := count(Q),
                } FILTER DeleteTest2.name = 'dt2.1';
            `,
      [
            {
              "name": "dt2.1",
              "count": 3,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (DELETE DeleteTest2) {name};
            `,
      [
            {
              "name": "dt2.1",
            },
          ]
    );
  });

  it("test_edgeql_delete_returning_05", () => {
    h.script(
      `
            INSERT DeleteTest {
                name := 'dt1.1'
            };
            INSERT DeleteTest {
                name := 'dt1.2'
            };
            INSERT DeleteTest {
                name := 'dt1.3'
            };
            # create a different object
            INSERT DeleteTest2 {
                name := 'dt2.1'
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    D := (DELETE DeleteTest)
                # the returning clause is actually trying to simulate
                # returning "stats" of deleted objects
                #
                SELECT DeleteTest2 {
                    name,
                    count := count(D),
                } FILTER DeleteTest2.name = 'dt2.1';
            `,
      [
            {
              "name": "dt2.1",
              "count": 3,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (DELETE DeleteTest2) {name};
            `,
      [
            {
              "name": "dt2.1",
            },
          ]
    );
  });

  it("test_edgeql_delete_sugar_01", () => {
    h.script(
      `
            FOR x IN {'1', '2', '3', '4', '5', '6'}
            UNION (INSERT DeleteTest {
                name := 'sugar delete ' ++ x
            });
        `
    );
    h.script(
      `
            DELETE
                DeleteTest
            FILTER
                .name[-1] != '2'
            ORDER BY .name
            OFFSET 2 LIMIT 2;
            # should delete 4 and 5
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DeleteTest.name;
            `,
      unorderedSet(["sugar delete 1", "sugar delete 2", "sugar delete 3", "sugar delete 6"])
    );
  });

  it("test_edgeql_delete_union", () => {
    h.script(
      `
            FOR x IN {'1', '2', '3', '4', '5', '6'}
            UNION (INSERT DeleteTest {
                name := 'delete union ' ++ x
            });

            FOR x IN {'7', '8', '9'}
            UNION (INSERT DeleteTest2 {
                name := 'delete union ' ++ x
            });

            INSERT DeleteTest { name := 'not delete union 1' };

            INSERT DeleteTest2 { name := 'not delete union 2' };
        `
    );
    h.script(
      `
            WITH
                ToDelete := (
                    (SELECT DeleteTest FILTER .name ILIKE 'delete union%')
                    UNION
                    (SELECT DeleteTest2 FILTER .name ILIKE 'delete union%')
                )
            DELETE ToDelete;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    DeleteTest
                FILTER
                    .name ILIKE 'delete union%';

            `,
      []
    );
    assertQueryResult(
      h,
      `
                SELECT
                    DeleteTest {name}
                FILTER
                    .name ILIKE 'not delete union%';

            `,
      [
            {
              "name": "not delete union 1",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT
                    DeleteTest2
                FILTER
                    .name ILIKE 'delete union%';

            `,
      []
    );
    assertQueryResult(
      h,
      `
                SELECT
                    DeleteTest2 {name}
                FILTER
                    .name ILIKE 'not delete union%';

            `,
      [
            {
              "name": "not delete union 2",
            },
          ]
    );
  });

  it("test_edgeql_delete_abstract_01", () => {
    h.script(
      `

            INSERT DeleteTest { name := 'child of abstract 1' };
            INSERT DeleteTest2 { name := 'child of abstract 2' };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    D := (
                        DELETE
                            AbstractDeleteTest
                        FILTER
                            .name ILIKE 'child of abstract%'
                    )
                SELECT D { name } ORDER BY .name;
            `,
      [
            {
              "name": "child of abstract 1",
            },
            {
              "name": "child of abstract 2",
            },
          ]
    );
  });

  it("test_edgeql_delete_assert_exists", () => {
    h.script(
      `
            INSERT DeleteTest2 { name := 'x' };
        `
    );
    assertQueryResult(
      h,
      `
            select assert_exists((delete DeleteTest2 filter .name = 'x'));
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_delete_then_union", () => {
    h.script(
      `
            INSERT DeleteTest2 { name := 'x' };
            INSERT DeleteTest2 { name := 'y' };
        `
    );
    assertQueryResult(
      h,
      `
            with
            delete1 := assert_exists((delete DeleteTest2 filter .name = 'x')),
            delete2 := assert_exists((delete DeleteTest2 filter .name = 'y')),
            select {delete1, delete2};
            `,
      [
            {},
            {},
          ]
    );
  });

  it("test_edgeql_delete_multi_simultaneous_01", () => {
    const setup = `
            with
              a := (insert DeleteTest { name := '1' }),
              b := (insert DeleteTest { name := '2' }),
              c := (insert LinkingType { objs := {a, b} })
            select c;
        `;
    const deletions = {
      a: "(DELETE DeleteTest)",
      b: "(DELETE LinkingType)",
    } as const;
    const perms = [["a", "b"], ["b", "a"]] as const;

    for (const bindOrder of perms) {
      for (const useOrder of perms) {
        h.script(setup);
        const bind_q = bindOrder
          .map((name) => `${name} := ${deletions[name]},`)
          .join("\n                  ");
        const q = `
                with
                  ${bind_q}
                select {${useOrder.join(", ")}};
            `;
        h.script(q);
      }
    }
  });

  it("test_edgeql_delete_multi_simultaneous_02", () => {
    h.script(
      `
            with
              a := (insert DeleteTest { name := '1' }),
              b := (insert DeleteTest2 { name := '2' }),
              c := (insert LinkingType { objs := {a, b} })
            select c;
        `
    );
    h.script(
      `
             with
               a := (DELETE AbstractDeleteTest),
               b := (DELETE LinkingType),
             select {a, b};
        `
    );
    h.script(
      `
            with
              a := (insert DeleteTest { name := '1' }),
              b := (insert DeleteTest2 { name := '2' }),
              c := (insert LinkingType { objs := {a, b} })
            select c;
        `
    );
    h.script(
      `
             with
               a := (DELETE AbstractDeleteTest),
               b := (DELETE LinkingType),
             select {b, a};
        `
    );
  });

  it("test_edgeql_delete_where_order_dml", () => {
    expect(() => {
      h.query(
        `
                delete DeleteTest
                filter
                        (INSERT DeleteTest {
                            name := 't1',
                        })
            `
      );
    }).toThrow(new RegExp("INSERT statements cannot be used in a FILTER clause"));
    expect(() => {
      h.query(
        `
                delete DeleteTest
                filter
                        (UPDATE DeleteTest set {
                            name := 't1',
                        })
            `
      );
    }).toThrow(new RegExp("UPDATE statements cannot be used in a FILTER clause"));
    expect(() => {
      h.query(
        `
                delete DeleteTest
                filter
                        (DELETE DeleteTest filter .name = 't1')
            `
      );
    }).toThrow(new RegExp("DELETE statements cannot be used in a FILTER clause"));
    expect(() => {
      h.query(
        `
                delete DeleteTest
                order by
                        (INSERT DeleteTest {
                            name := 't1',
                        })
                limit 1
            `
      );
    }).toThrow(new RegExp("INSERT statements cannot be used in an ORDER BY clause"));
    expect(() => {
      h.query(
        `
                delete DeleteTest
                order by
                        (UPDATE DeleteTest set {
                            name := 't1',
                        })
                limit 1
            `
      );
    }).toThrow(new RegExp("UPDATE statements cannot be used in an ORDER BY clause"));
    expect(() => {
      h.query(
        `
                delete DeleteTest
                order by
                        (DELETE DeleteTest filter .name = 't1')
                limit 1
            `
      );
    }).toThrow(new RegExp("DELETE statements cannot be used in an ORDER BY clause"));
  });

  it.skip("test_edgeql_delete_read_only_tx_01", () => {
    // The Python original exercises EdgeDB client read-only transactions;
    // QueryHarness does not expose transaction options yet.
  });
});
