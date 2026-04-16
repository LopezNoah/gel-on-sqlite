import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLDDL", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      dbFile: "./tests/.artifacts/ddl_testedgeqlddl.sqlite",
      resetDbFile: true
    });
  });

  function _check_ddl_global_type_changes(): void {
    let existing_types = h.query("select schema::Type.id");
    for (const [ddl, expected_types] of (ddls_and_expected_types as any)) {
      h.script(
        `
                ${ddl};
            `
      );
      assertQueryResult(
        h,
        `
                    select schema::Type {
                        name,
                        from_alias,
                        type_name := (.__type__.name),
                    }
                    filter not contains(<array<uuid>>$existing_types, .id)
                    order by .name
                `,
        expected_types
      );
    }
  }

  function _check_ddl_alias_type_changes(): void {
    let existing_types = h.query("select schema::Type.id");
    for (const [ddl, expected_types] of (ddls_and_expected_types as any)) {
      h.script(
        `
                ${ddl};
            `
      );
      assertQueryResult(
        h,
        `
                    select schema::Type {
                        name,
                        from_alias,
                        type_name := (.__type__.name),
                    }
                    filter not contains(<array<uuid>>$existing_types, .id)
                    order by .name
                `,
        expected_types
      );
    }
  }

  function order_migrations(): void {
    let ordered = undefined;
    let prev_ids = undefined;
    while (prev_ids) {
      let curr_migrations = undefined;
      ordered.extend(curr_migrations);
      prev_ids = undefined;
    }
    return ordered;
  }

  function _simple_rename_ref_test(): void {
    h.script(
      `
            CREATE TYPE Note {
                CREATE PROPERTY note -> str;
            };

            ${ddl.lstrip()}
        `
    );
    let type_rename = undefined;
    let prop_rename = undefined;
    h.script(
      `
            ALTER TYPE Note {
                ${type_rename.lstrip()}
                ${prop_rename.lstrip()}
            }
        `
    );
    if (rename_module) {
      h.script(
        `
            CREATE MODULE foo;
            ALTER TYPE Note RENAME TO foo::Note;
            `
      );
    } else {
      let res = h.query("\n                DESCRIBE MODULE default\n            ");
      let total_type = (1 + type_refs);
      let num_type_orig = undefined;
      expect(res.count("Note")).toEqual((num_type_orig + type_extra));
      expect(res.count("Remark")).toEqual((total_type - num_type_orig));
      let total_prop = (1 + prop_refs);
      let num_prop_orig = undefined;
      expect(res.count("note")).toEqual((num_prop_orig + type_extra));
      expect(res.count("remark")).toEqual((total_prop - num_prop_orig));
    }
    if (cleanup) {
      if (rename_prop) {
        let cleanup = cleanup.replace("note", "remark");
      }
      if (rename_type) {
        let cleanup = cleanup.replace("Note", "Remark");
      }
      if (rename_module) {
        let cleanup = cleanup.replace("default", "foo");
      }
      h.script(
        `
                ${cleanup.lstrip()}
            `
      );
    }
  }

  function _simple_rename_ref_tests(): void {
    _simple_rename_ref_test();
    _simple_rename_ref_test();
    _simple_rename_ref_test();
    _simple_rename_ref_test();
  }

  it("test_edgeql_ddl_04", () => {
    h.script(
      `
            CREATE TYPE A;
            CREATE TYPE B EXTENDING A;

            CREATE TYPE Object1 {
                CREATE REQUIRED LINK a -> A;
            };

            CREATE TYPE Object2 {
                CREATE LINK a -> B;
            };

            CREATE TYPE Object_12
                EXTENDING Object1, Object2;
        `
    );
  });

  it("test_edgeql_ddl_type_05", () => {
    h.script(
      `
            CREATE TYPE A5;
            CREATE TYPE Object5 {
                CREATE REQUIRED LINK a -> A5;
                CREATE REQUIRED PROPERTY b -> str;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    links: {
                        name,
                        required,
                    }
                    FILTER .name = 'a'
                    ORDER BY .name,

                    properties: {
                        name,
                        required,
                    }
                    FILTER .name = 'b'
                    ORDER BY .name
                }
                FILTER .name = 'default::Object5';
            `,
      [
            {
              "links": [
                {
                  "name": "a",
                  "required": true,
                },
              ],
              "properties": [
                {
                  "name": "b",
                  "required": true,
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Object5 {
                ALTER LINK a SET OPTIONAL;
            };

            ALTER TYPE Object5 {
                ALTER PROPERTY b SET OPTIONAL;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    links: {
                        name,
                        required,
                    }
                    FILTER .name = 'a'
                    ORDER BY .name,

                    properties: {
                        name,
                        required,
                    }
                    FILTER .name = 'b'
                    ORDER BY .name
                }
                FILTER .name = 'default::Object5';
            `,
      [
            {
              "links": [
                {
                  "name": "a",
                  "required": false,
                },
              ],
              "properties": [
                {
                  "name": "b",
                  "required": false,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_type_06", () => {
    h.script(
      `
            CREATE TYPE A6 {
                CREATE PROPERTY name -> str;
            };

            CREATE TYPE Object6 {
                CREATE SINGLE LINK a -> A6;
                CREATE SINGLE PROPERTY b -> str;
            };

            INSERT A6 { name := 'a6' };
            INSERT Object6 {
                a := (SELECT A6 LIMIT 1),
                b := 'foo'
            };
            INSERT Object6;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    links: {
                        name,
                        cardinality,
                    }
                    FILTER .name = 'a'
                    ORDER BY .name,

                    properties: {
                        name,
                        cardinality,
                    }
                    FILTER .name = 'b'
                    ORDER BY .name
                }
                FILTER .name = 'default::Object6';
            `,
      [
            {
              "links": [
                {
                  "name": "a",
                  "cardinality": "One",
                },
              ],
              "properties": [
                {
                  "name": "b",
                  "cardinality": "One",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Object6 {
                a: {name},
                b,
            } FILTER EXISTS .a
            `,
      [
            {
              "a": {
                "name": "a6",
              },
              "b": "foo",
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Object6 {
                ALTER LINK a SET MULTI;
            };

            ALTER TYPE Object6 {
                ALTER PROPERTY b SET MULTI;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    links: {
                        name,
                        cardinality,
                    }
                    FILTER .name = 'a'
                    ORDER BY .name,

                    properties: {
                        name,
                        cardinality,
                    }
                    FILTER .name = 'b'
                    ORDER BY .name
                }
                FILTER .name = 'default::Object6';
            `,
      [
            {
              "links": [
                {
                  "name": "a",
                  "cardinality": "Many",
                },
              ],
              "properties": [
                {
                  "name": "b",
                  "cardinality": "Many",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Object6 {
                a: {name},
                b,
            } FILTER EXISTS .a
            `,
      [
            {
              "a": [
                {
                  "name": "a6",
                },
              ],
              "b": ["foo"],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Object6 {
                ALTER LINK a SET SINGLE USING (SELECT .a LIMIT 1);
            };

            ALTER TYPE Object6 {
                ALTER PROPERTY b SET SINGLE USING (SELECT .b LIMIT 1);
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    links: {
                        name,
                        cardinality,
                    }
                    FILTER .name = 'a'
                    ORDER BY .name,

                    properties: {
                        name,
                        cardinality,
                    }
                    FILTER .name = 'b'
                    ORDER BY .name
                }
                FILTER .name = 'default::Object6';
            `,
      [
            {
              "links": [
                {
                  "name": "a",
                  "cardinality": "One",
                },
              ],
              "properties": [
                {
                  "name": "b",
                  "cardinality": "One",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT Object6 {
                a: {name},
                b,
            } FILTER EXISTS .a
            `,
      [
            {
              "a": {
                "name": "a6",
              },
              "b": "foo",
            },
          ]
    );
  });

  it.skip("test_edgeql_ddl_rename_type_and_add_01 [xerror: Known collation issue on Heroku Postgres]", () => {
    h.script(
      `

            CREATE TYPE Foo {
                CREATE PROPERTY x -> str;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                DROP PROPERTY x;
                RENAME TO Bar;
                CREATE PROPERTY a -> str;
                CREATE LINK b -> Object;
                CREATE CONSTRAINT expression ON (true);
                CREATE ANNOTATION description := 'hello';
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::ObjectType {
                links: {name} ORDER BY .name,
                properties: {name} ORDER BY .name,
                constraints: {name},
                annotations: {name}
            }
            FILTER .name = 'default::Bar';
            `,
      [
            {
              "annotations": [
                {
                  "name": "std::description",
                },
              ],
              "constraints": [
                {
                  "name": "std::expression",
                },
              ],
              "links": [
                {
                  "name": "__type__",
                },
                {
                  "name": "b",
                },
              ],
              "properties": [
                {
                  "name": "a",
                },
                {
                  "name": "id",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Bar {
                DROP PROPERTY a;
                DROP link b;
                DROP CONSTRAINT expression ON (true);
                DROP ANNOTATION description;
            };
        `
    );
  });

  it.skip("test_edgeql_ddl_rename_type_and_add_02 [xerror: Known collation issue on Heroku Postgres]", () => {
    h.script(
      `

            CREATE TYPE Foo;
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                CREATE PROPERTY a -> str;
                CREATE LINK b -> Object;
                CREATE CONSTRAINT expression ON (true);
                CREATE ANNOTATION description := 'hello';
                RENAME TO Bar;
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::ObjectType {
                links: {name} ORDER BY .name,
                properties: {name} ORDER BY .name,
                constraints: {name},
                annotations: {name}
            }
            FILTER .name = 'default::Bar';
            `,
      [
            {
              "annotations": [
                {
                  "name": "std::description",
                },
              ],
              "constraints": [
                {
                  "name": "std::expression",
                },
              ],
              "links": [
                {
                  "name": "__type__",
                },
                {
                  "name": "b",
                },
              ],
              "properties": [
                {
                  "name": "a",
                },
                {
                  "name": "id",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Bar {
                DROP PROPERTY a;
                DROP link b;
                DROP CONSTRAINT expression ON (true);
                DROP ANNOTATION description;
            };
        `
    );
  });

  it("test_edgeql_ddl_rename_type_and_drop_01", () => {
    h.script(
      `

            CREATE TYPE Foo {
                CREATE PROPERTY a -> str;
                CREATE LINK b -> Object;
                CREATE CONSTRAINT expression ON (true);
                CREATE ANNOTATION description := 'hello';
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                RENAME TO Bar;
                DROP PROPERTY a;
                DROP link b;
                DROP CONSTRAINT expression ON (true);
                DROP ANNOTATION description;
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::ObjectType {
                links: {name} ORDER BY .name,
                properties: {name} ORDER BY .name,
                constraints: {name},
                annotations: {name}
            }
            FILTER .name = 'default::Bar';
            `,
      [
            {
              "annotations": [],
              "constraints": [],
              "links": [
                {
                  "name": "__type__",
                },
              ],
              "properties": [
                {
                  "name": "id",
                },
              ],
            },
          ]
    );
    h.script(
      `
            DROP TYPE Bar;
        `
    );
  });

  it("test_edgeql_ddl_rename_type_and_drop_02", () => {
    h.script(
      `

            CREATE TYPE Foo {
                CREATE PROPERTY a -> str;
                CREATE LINK b -> Object;
                CREATE CONSTRAINT expression ON (true);
                CREATE ANNOTATION description := 'hello';
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                DROP PROPERTY a;
                DROP link b;
                DROP CONSTRAINT expression ON (true);
                DROP ANNOTATION description;
                RENAME TO Bar;
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::ObjectType {
                links: {name} ORDER BY .name,
                properties: {name} ORDER BY .name,
                constraints: {name},
                annotations: {name}
            }
            FILTER .name = 'default::Bar';
            `,
      [
            {
              "annotations": [],
              "constraints": [],
              "links": [
                {
                  "name": "__type__",
                },
              ],
              "properties": [
                {
                  "name": "id",
                },
              ],
            },
          ]
    );
    h.script(
      `
            DROP TYPE Bar;
        `
    );
  });

  it("test_edgeql_ddl_rename_type_and_prop_01", () => {
    h.script(
      `

            CREATE TYPE Note {
                CREATE PROPERTY note -> str;
                CREATE LINK friend -> Object;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Note {
                RENAME TO Remark;
                ALTER PROPERTY note RENAME TO remark;
                ALTER LINK friend RENAME TO enemy;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Remark {
                DROP PROPERTY remark;
                DROP LINK enemy;
            };
        `
    );
  });

  it("test_edgeql_ddl_11", () => {
    h.script(
      `
            CREATE TYPE TestContainerLinkObjectType {
                CREATE PROPERTY test_array_link -> array<std::str>;
                # FIXME: for now dimension specs on the array are
                # disabled pending a syntax change
                # CREATE PROPERTY test_array_link_2 ->
                #     array<std::str[10]>;
            };
        `
    );
  });

  it("test_edgeql_ddl_12", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE TestBadContainerLinkObjectType {
                    CREATE PROPERTY foo -> std::str {
                        CREATE CONSTRAINT expression
                            ON (\`__subject__\` = 'foo');
                    };
                };
            `
      );
    }).toThrow(new RegExp("backtick-quoted names surrounded by double underscores are forbidden"));
  });

  it("test_edgeql_ddl_13", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE TestBadContainerLinkObjectType {
                    CREATE PROPERTY foo -> std::str {
                        CREATE CONSTRAINT expression ON (\`self\` = 'foo');
                    };
                };
            `
      );
    }).toThrow(new RegExp("object type or alias 'default::self' does not exist"));
  });

  it("test_edgeql_ddl_14", () => {
    h.script(
      `
            CREATE TYPE TestSelfLink1 {
                CREATE PROPERTY foo1 -> std::str;
                CREATE PROPERTY bar1 -> std::str {
                    SET default := __source__.foo1;
                };
            };
        `
    );
    h.script(
      `
            INSERT TestSelfLink1 { foo1 := 'hello' };
            `
    );
  });

  it("test_edgeql_ddl_15", () => {
    h.script(
      `
            CREATE TYPE TestSelfLink2 {
                CREATE PROPERTY foo2 -> std::str;
                CREATE MULTI PROPERTY bar2 -> std::str {
                    # NOTE: this is a set of all TestSelfLink2.foo2
                    SET default := TestSelfLink2.foo2;
                };
            };

            INSERT TestSelfLink2 {
                foo2 := 'Alice'
            };
            INSERT TestSelfLink2 {
                foo2 := 'Bob'
            };
            INSERT TestSelfLink2 {
                foo2 := 'Carol'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT TestSelfLink2 {
                    foo2,
                    bar2,
                } ORDER BY TestSelfLink2.foo2;
            `,
      [
            {
              "bar2": [],
              "foo2": "Alice",
            },
            {
              "bar2": unorderedSet(["Alice"]),
              "foo2": "Bob",
            },
            {
              "bar2": unorderedSet(["Alice", "Bob"]),
              "foo2": "Carol",
            },
          ]
    );
  });

  it("test_edgeql_ddl_16", () => {
    h.script(
      `
            CREATE TYPE TestSelfLink3 {
                CREATE PROPERTY foo3 -> std::str;
                CREATE PROPERTY bar3 -> std::str {
                    SET default := .foo3;
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_18", () => {
    h.script(
      `
            CREATE MODULE foo;
            CREATE MODULE bar;

            SET MODULE foo;
            SET ALIAS b AS MODULE bar;

            CREATE SCALAR TYPE foo_t EXTENDING int64 {
                CREATE CONSTRAINT expression ON (__subject__ > 0);
            };

            CREATE SCALAR TYPE b::bar_t EXTENDING int64;

            CREATE TYPE Obj {
                CREATE PROPERTY foo -> foo_t {
                    SET default := <foo::foo_t>20;
                };
                CREATE PROPERTY bar -> b::bar_t;
            };

            CREATE TYPE b::Obj2 {
                CREATE LINK obj -> Obj;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    name,
                    constraints: {
                        name,
                        subjectexpr,
                    }
                }
                FILTER .name LIKE '%bar%' OR .name LIKE '%foo%'
                ORDER BY .name;
            `,
      [
            {
              "name": "bar::bar_t",
              "constraints": [],
            },
            {
              "name": "foo::foo_t",
              "constraints": [
                {
                  "name": "std::expression",
                  "subjectexpr": "(__subject__ > 0)",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER SCALAR TYPE foo::foo_t RENAME TO foo::baz_t;
        `
    );
    h.script(
      `
            ALTER SCALAR TYPE foo::baz_t RENAME TO bar::quux_t;
        `
    );
    h.script(
      `
            DROP TYPE bar::Obj2;
            DROP TYPE foo::Obj;
            DROP SCALAR TYPE bar::quux_t;
        `
    );
  });

  it("test_edgeql_ddl_19", () => {
    h.script(
      `

            CREATE TYPE ActualType {
                CREATE REQUIRED PROPERTY foo -> str;
            };

            CREATE ALIAS Alias1 := ActualType {
                bar := 9
            };

            CREATE ALIAS Alias2 := ActualType {
                connected := (SELECT Alias1 ORDER BY Alias1.foo)
            };


            INSERT ActualType {
                foo := 'obj1'
            };
            INSERT ActualType {
                foo := 'obj2'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Alias2 {
                    foo,
                    connected: {
                        foo,
                        bar
                    }
                }
                ORDER BY Alias2.foo;
            `,
      [
            {
              "foo": "obj1",
              "connected": [
                {
                  "foo": "obj1",
                  "bar": 9,
                },
                {
                  "foo": "obj2",
                  "bar": 9,
                },
              ],
            },
            {
              "foo": "obj2",
              "connected": [
                {
                  "foo": "obj1",
                  "bar": 9,
                },
                {
                  "foo": "obj2",
                  "bar": 9,
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Link {
                    pnames := .properties.name
                } FILTER .name IN {"connected", '__type__'}
                  AND .source.name = 'default::Alias2'
            `,
      [
            {
              "pnames": unorderedSet(["source", "target"]),
            },
            {
              "pnames": unorderedSet(["source", "target"]),
            },
          ]
    );
  });

  it("test_edgeql_ddl_20", () => {
    h.script(
      `

            CREATE TYPE A20 {
                CREATE REQUIRED PROPERTY foo -> str;
            };

            CREATE TYPE B20 {
                CREATE LINK l -> A20;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    links: {
                        name,
                        bases: {
                            name
                        }
                    } FILTER .name = 'l'
                }
                FILTER .name = 'default::B20'
            `,
      [
            {
              "links": [
                {
                  "name": "l",
                  "bases": [
                    {
                      "name": "std::link",
                    },
                  ],
                },
              ],
            },
          ]
    );
    h.script(
      `

            CREATE ABSTRACT LINK l20;

            ALTER TYPE B20 {
                ALTER LINK l EXTENDING l20;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    links: {
                        name,
                        bases: {
                            name
                        }
                    } FILTER .name = 'l'
                }
                FILTER .name = 'default::B20'
            `,
      [
            {
              "links": [
                {
                  "name": "l",
                  "bases": [
                    {
                      "name": "default::l20",
                    },
                  ],
                },
              ],
            },
          ]
    );
    h.script(
      `

            ALTER TYPE B20 {
                ALTER LINK l DROP EXTENDING l20;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    links: {
                        name,
                        bases: {
                            name
                        }
                    } FILTER .name = 'l'
                }
                FILTER .name = 'default::B20'
            `,
      [
            {
              "links": [
                {
                  "name": "l",
                  "bases": [
                    {
                      "name": "std::link",
                    },
                  ],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_23", () => {
    h.script(
      `

            CREATE TYPE User;
            CREATE TYPE Award {
                CREATE LINK user -> User;
            };

            CREATE ALIAS Alias1 := (SELECT User {
                awards := .<user
            });
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::Alias1')
                SELECT
                    C.pointers { target: { name } }
                FILTER
                    C.pointers.name = 'awards'
            `,
      [
            {
              "target": {
                "name": "std::BaseObject",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_24", () => {
    h.script(
      `
            CREATE TYPE Desc;
            CREATE TYPE Named {
                CREATE PROPERTY name -> str;
                CREATE LINK desc -> Desc;
            };
            CREATE TYPE User EXTENDING Named;
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::User')
                SELECT
                    C {
                        pointers: { @owned }
                        FILTER .name IN {'name', 'desc'}
                    };
            `,
      [
            {
              "pointers": [
                {
                  "@owned": false,
                },
                {
                  "@owned": false,
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE User {
                ALTER PROPERTY name SET OWNED;
                ALTER LINK desc SET OWNED;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::User')
                SELECT
                    C {
                        pointers: { @owned }
                        FILTER .name IN {'name', 'desc'}
                    };
            `,
      [
            {
              "pointers": [
                {
                  "@owned": true,
                },
                {
                  "@owned": true,
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE User {
                ALTER PROPERTY name {
                    SET REQUIRED;
                    CREATE CONSTRAINT exclusive;
                };

                ALTER LINK desc {
                    SET REQUIRED;
                    CREATE CONSTRAINT exclusive;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::User')
                SELECT
                    C {
                        pointers: {
                            @owned,
                            required,
                            constraints: {
                                name,
                            }
                        }
                        FILTER .name IN {'name', 'desc'}
                    };
            `,
      [
            {
              "pointers": [
                {
                  "@owned": true,
                  "required": true,
                  "constraints": [
                    {
                      "name": "std::exclusive",
                    },
                  ],
                },
                {
                  "@owned": true,
                  "required": true,
                  "constraints": [
                    {
                      "name": "std::exclusive",
                    },
                  ],
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE User {
                ALTER PROPERTY name DROP OWNED;
                ALTER LINK desc DROP OWNED;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::User')
                SELECT
                    C {
                        pointers: {
                            @owned,
                            required,
                            constraints: {
                                name,
                            }
                        }
                        FILTER .name IN {'name', 'desc'}
                    };
            `,
      [
            {
              "pointers": [
                {
                  "@owned": false,
                  "required": false,
                  "constraints": [],
                },
                {
                  "@owned": false,
                  "required": false,
                  "constraints": [],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_25", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Named {
                    CREATE PROPERTY name -> str;
                };
                ALTER TYPE Named ALTER PROPERTY name DROP OWNED;
            `
      );
    }).toThrow(new RegExp("cannot drop owned property 'name'.*not inherited"));
  });

  it("test_edgeql_ddl_26", () => {
    h.script(
      `
            CREATE TYPE Target;
            CREATE TYPE Source {
                CREATE LINK target -> Source;
            };
            CREATE TYPE Child EXTENDING Source {
                ALTER LINK target {
                    SET REQUIRED;
                    CREATE PROPERTY foo -> str;
                }
            };
            CREATE TYPE Grandchild EXTENDING Child {
                ALTER LINK target {
                    ALTER PROPERTY foo {
                        CREATE CONSTRAINT exclusive;
                    }
                }
            };
        `
    );
    h.script(
      `
            ALTER TYPE Child ALTER LINK target DROP OWNED;
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::Child')
                SELECT
                    C {
                        links: {
                            @owned,
                            required,
                            properties: {
                                name,
                            } ORDER BY .name
                        }
                        FILTER .name = 'target'
                    };
            `,
      [
            {
              "links": [
                {
                  "@owned": false,
                  "required": false,
                  "properties": [
                    {
                      "name": "source",
                    },
                    {
                      "name": "target",
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
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::Grandchild')
                SELECT
                    C {
                        links: {
                            @owned,
                            required,
                            properties: {
                                name,
                                @owned,
                                constraints: {
                                    name,
                                }
                            } FILTER .name = 'foo'
                        }
                        FILTER .name = 'target'
                    };
            `,
      [
            {
              "links": [
                {
                  "@owned": true,
                  "required": true,
                  "properties": [
                    {
                      "name": "foo",
                      "@owned": true,
                      "constraints": [
                        {
                          "name": "std::exclusive",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_27", () => {
    h.script(
      `
            CREATE TYPE Base {
                CREATE PROPERTY foo -> str;
            };
            CREATE TYPE Derived EXTENDING Base {
                ALTER PROPERTY foo SET REQUIRED;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::Derived')
                SELECT
                    C {
                        properties: {
                            @owned,
                            required,
                            inherited_fields,
                        }
                        FILTER .name = 'foo'
                    };
            `,
      [
            {
              "properties": [
                {
                  "@owned": true,
                  "required": true,
                  "inherited_fields": unorderedSet(["cardinality", "readonly", "target"]),
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Base DROP PROPERTY foo;
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::Derived')
                SELECT
                    C {
                        properties: {
                            @owned,
                            required,
                            inherited_fields,
                        }
                        FILTER .name = 'foo'
                    };
            `,
      [
            {
              "properties": [
                {
                  "@owned": true,
                  "required": true,
                  "inherited_fields": [],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_28", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY left -> str;
                CREATE PROPERTY smallint -> str;
                CREATE PROPERTY natural -> str;
                CREATE PROPERTY null -> str;
                CREATE PROPERTY \`like\` -> str;
                CREATE PROPERTY \`create\` -> str;
                CREATE PROPERTY \`link\` -> str;
            };
        `
    );
  });

  it("test_edgeql_ddl_sequence_01", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY index -> std::int64;
            };
        `
    );
    h.script(
      `
            CREATE SCALAR TYPE ctr EXTENDING std::sequence;
            ALTER TYPE Foo {
                ALTER PROPERTY index {
                    SET TYPE ctr;
                };
            };
        `
    );
    h.script(
      `
            INSERT Foo;
        `
    );
  });

  it("test_edgeql_ddl_abstract_link_01", () => {
    h.script(
      `
            CREATE ABSTRACT LINK test_link;
        `
    );
  });

  it("test_edgeql_ddl_abstract_link_02", () => {
    h.script(
      `
            CREATE ABSTRACT LINK test_object_link {
                CREATE PROPERTY test_link_prop -> std::int64;
            };

            CREATE TYPE TestObjectType {
                CREATE LINK test_object_link -> std::Object {
                    CREATE PROPERTY test_link_prop -> std::int64 {
                        CREATE ANNOTATION title := 'Test Property';
                    };
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_abstract_link_03", () => {
    h.script(
      `
            CREATE ABSTRACT LINK test_object_link_prop {
                CREATE PROPERTY link_prop1 -> std::str;
            };
        `
    );
  });

  it("test_edgeql_ddl_abstract_link_04", () => {
    h.script(
      `

            CREATE ABSTRACT LINK test_object_link {
                CREATE PROPERTY test_link_prop -> int64;
                CREATE PROPERTY computed_prop := @test_link_prop * 2;
            };

            CREATE TYPE Target;
            CREATE TYPE TestObjectType {
                CREATE LINK test_object_link EXTENDING test_object_link
                   -> Target;
            };

            INSERT TestObjectType {
                test_object_link := (INSERT Target { @test_link_prop := 42 })
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT TestObjectType {
                    test_object_link: { @test_link_prop, @computed_prop },
                };
            `,
      [
            {
              "test_object_link": {
                "@computed_prop": 84,
                "@test_link_prop": 42,
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_drop_extending_01", () => {
    h.script(
      `

            CREATE TYPE Parent {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Child EXTENDING Parent;
        `
    );
    h.script(
      `
            ALTER TYPE Child DROP EXTENDING Parent;
        `
    );
    expect(() => {
      h.script(
        `
                SELECT Child.name
            `
      );
    }).toThrow(new RegExp("object type 'default::Child' has no link or property 'name'"));
    h.script(
      `
            DROP TYPE Parent;
        `
    );
  });

  it("test_edgeql_ddl_drop_extending_02", () => {
    h.script(
      `

            CREATE TYPE Parent {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Child EXTENDING Parent {
                ALTER PROPERTY name {
                    SET OWNED;
                    ALTER CONSTRAINT exclusive SET OWNED;
                };
            };
        `
    );
    h.script(
      `
            ALTER TYPE Child DROP EXTENDING Parent;
        `
    );
    h.script(
      `
            INSERT Child { name := "foo" };
            INSERT Parent { name := "foo" };
        `
    );
    h.script(
      `
            INSERT Parent { name := "bar" };
            INSERT Child { name := "bar" };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Parent { name := "bar" };
            `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                INSERT Child { name := "bar" };
            `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
    h.script(
      `
            DROP TYPE Parent;
        `
    );
  });

  it("test_edgeql_ddl_drop_extending_03", () => {
    h.script(
      `

            CREATE TYPE Parent {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Child EXTENDING Parent {
                ALTER PROPERTY name {
                    SET OWNED;
                    ALTER CONSTRAINT exclusive SET OWNED;
                };
            };
            CREATE TYPE Grandchild EXTENDING Child;
        `
    );
    h.script(
      `
            ALTER TYPE Child DROP EXTENDING Parent;
        `
    );
    h.script(
      `
            DROP TYPE Parent;
        `
    );
  });

  it("test_edgeql_ddl_drop_extending_04", () => {
    h.script(
      `

            CREATE TYPE Parent {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Child EXTENDING Parent {
                ALTER PROPERTY name {
                    SET OWNED;
                    ALTER CONSTRAINT exclusive SET OWNED;
                };
            };
            CREATE TYPE Grandchild EXTENDING Child {
                ALTER PROPERTY name {
                    SET OWNED;
                    ALTER CONSTRAINT exclusive SET OWNED;
                };
            };
        `
    );
    h.script(
      `
            ALTER TYPE Grandchild DROP EXTENDING Child;
        `
    );
    h.script(
      `
            DROP TYPE Child;
            DROP TYPE Parent;
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Grandchild { name := "bar" };
                INSERT Grandchild { name := "bar" };
            `
      );
    }).toThrow(new RegExp("name violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_drop_extending_05", () => {
    h.script(
      `

            CREATE TYPE Parent {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Child EXTENDING Parent {
                ALTER PROPERTY name {
                    SET OWNED;
                };
            };
        `
    );
    h.script(
      `
            ALTER TYPE Child DROP EXTENDING Parent;
        `
    );
    h.script(
      `
            INSERT Child { name := "foo" };
            INSERT Child { name := "foo" };
        `
    );
  });

  it("test_edgeql_ddl_drop_extending_06", () => {
    h.script(
      `

            CREATE ABSTRACT TYPE Named {
                CREATE OPTIONAL SINGLE PROPERTY name -> str;
            };
            CREATE TYPE Foo EXTENDING Named;
        `
    );
    h.script(
      `
            INSERT Foo { name := "Phil Emarg" };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY name {
                    SET OWNED;
                };
                DROP EXTENDING Named;
            };
            DROP TYPE Named;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo.name;
            `,
      ["Phil Emarg"]
    );
  });

  it("test_edgeql_ddl_drop_extending_07", () => {
    h.script(
      `

            CREATE ABSTRACT TYPE Named {
                CREATE PROPERTY name -> str;
            };
            CREATE ABSTRACT TYPE Noted {
                CREATE PROPERTY note -> str;
            };
            CREATE TYPE Foo EXTENDING Named {
                CREATE PROPERTY note -> str;
            };
        `
    );
    h.script(
      `
            INSERT Foo { name := "Phil Emarg", note := "foo" };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY name {
                    SET OWNED;
                };
                DROP EXTENDING Named;
                EXTENDING Noted LAST;
                ALTER PROPERTY note {
                    DROP OWNED;
                };
            };
            DROP TYPE Named;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo { note, name };
            `,
      [
            {
              "name": "Phil Emarg",
              "note": "foo",
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Foo {
                DROP EXTENDING Noted;
            };
        `
    );
    expect(() => {
      h.script(
        `
                SELECT Foo.note;
            `
      );
    }).toThrow(new RegExp("has no link or property 'note'"));
  });

  it("test_edgeql_ddl_drop_extending_08", () => {
    h.script(
      `

            CREATE ABSTRACT TYPE Named {
                CREATE OPTIONAL SINGLE PROPERTY name -> str;
            };
            CREATE ABSTRACT TYPE Named2 {
                CREATE OPTIONAL SINGLE PROPERTY name -> str;
            };
            CREATE TYPE Foo EXTENDING Named;
        `
    );
    h.script(
      `
            INSERT Foo { name := "Phil Emarg" };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                DROP EXTENDING Named;
                EXTENDING Named2 LAST;
            };
            DROP TYPE Named;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo.name;
            `,
      ["Phil Emarg"]
    );
  });

  it("test_edgeql_ddl_add_extending_01", () => {
    h.script(
      `

            CREATE TYPE Thing;

            CREATE TYPE Foo {
                CREATE LINK item -> Object {
                    CREATE PROPERTY foo -> str;
                };
            };

            INSERT Foo { item := (INSERT Thing { @foo := "test" }) };
        `
    );
    h.script(
      `
            CREATE TYPE Base {
                CREATE OPTIONAL SINGLE LINK item -> Object {
                    CREATE OPTIONAL SINGLE PROPERTY foo -> str;
                };
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                EXTENDING Base LAST;
                ALTER LINK item {
                    ALTER PROPERTY foo {
                        DROP OWNED;
                    };
                    DROP OWNED;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo { item: {@foo} };
            `,
      [
            {
              "item": {
                "@foo": "test",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_default_01", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE TestDefault01 {
                    CREATE PROPERTY def01 -> str {
                        # int64 doesn't have an assignment cast into str
                        SET default := 42;
                    };
                };
            `
      );
    }).toThrow(new RegExp("default expression is of invalid type: std::int64, expected std::str"));
  });

  it("test_edgeql_ddl_default_02", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE TestDefault02 {
                    CREATE PROPERTY def02 -> str {
                        SET default := '42';
                    };
                };

                ALTER TYPE TestDefault02 {
                    ALTER PROPERTY def02 SET default := 42;
                };
            `
      );
    }).toThrow(new RegExp("default expression is of invalid type: std::int64, expected std::str"));
  });

  it("test_edgeql_ddl_default_03", () => {
    h.script(
      `
            CREATE TYPE TestDefaultInsert03;

            CREATE TYPE TestDefault03 {
                CREATE LINK def03 -> TestDefaultInsert03 {
                    SET default := (INSERT TestDefaultInsert03);
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (
                    count(TestDefault03),
                    count(TestDefaultInsert03)
                );
            `,
      [
            [0, 0],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefault03 {
                    def03
                };
            `,
      []
    );
    assertQueryResult(
      h,
      `INSERT TestDefault03;`,
      [
            {
              "id": "UUID",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (
                    count(TestDefault03),
                    count(TestDefaultInsert03)
                );
            `,
      [
            [1, 1],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefault03 {
                    def03
                };
            `,
      [
            {
              "def03": {
                "id": "UUID",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_default_04", () => {
    h.script(
      `
            CREATE TYPE TestDefaultUpdate04 {
                CREATE PROPERTY val -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };

            CREATE TYPE TestDefault04 {
                CREATE LINK def04 -> TestDefaultUpdate04 {
                    SET default := (
                        UPDATE TestDefaultUpdate04
                        FILTER .val = 'def04'
                        SET {
                            val := .val ++ '!'
                        }
                    );
                };
            };

            INSERT TestDefaultUpdate04 {
                val := 'notdef04'
            };
            INSERT TestDefaultUpdate04 {
                val := 'def04'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefaultUpdate04.val;
            `,
      unorderedSet(["def04", "notdef04"])
    );
    assertQueryResult(
      h,
      `
            SELECT {
                (INSERT TestDefault04),
                (INSERT TestDefault04)
            };
        `,
      [
            {
              "id": "UUID",
            },
            {
              "id": "UUID",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefaultUpdate04.val;
            `,
      unorderedSet(["def04!", "notdef04"])
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefault04 {
                    def04: {
                        val
                    }
                } ORDER BY .def04.val EMPTY FIRST;
            `,
      [
            {
              "def04": null,
            },
            {
              "def04": {
                "val": "def04!",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_default_05", () => {
    h.script(
      `
            CREATE TYPE TestDefaultDelete05 {
                CREATE PROPERTY val -> str;
            };

            CREATE TYPE TestDefault05 {
                CREATE PROPERTY def05 -> str {
                    SET default := (SELECT (
                        DELETE TestDefaultDelete05
                        FILTER .val = 'def05'
                        LIMIT 1
                    ).val);
                };
            };

            INSERT TestDefaultDelete05 {
                val := 'notdef05'
            };
            INSERT TestDefaultDelete05 {
                val := 'def05'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefaultDelete05.val;
            `,
      unorderedSet(["def05", "notdef05"])
    );
    h.script(
      `
            INSERT TestDefault05;
            INSERT TestDefault05;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefaultDelete05.val;
            `,
      unorderedSet(["notdef05"])
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefault05 {
                    def05
                } ORDER BY .def05 EMPTY FIRST;
            `,
      [
            {
              "def05": null,
            },
            {
              "def05": "def05",
            },
          ]
    );
  });

  it("test_edgeql_ddl_default_06", () => {
    h.script(
      `
            CREATE TYPE TestDefaultDelete06 {
                CREATE PROPERTY val -> str;
            };

            CREATE TYPE TestDefault06 {
                CREATE REQUIRED LINK def06 -> TestDefaultDelete06 {
                    SET default := (
                        DELETE TestDefaultDelete06
                        FILTER .val = 'def06'
                        LIMIT 1
                    );
                };
            };

            INSERT TestDefaultDelete06 {
                val := 'notdef06'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT TestDefaultDelete06.val;
            `,
      unorderedSet(["notdef06"])
    );
    expect(() => {
      h.script(
        `
                INSERT TestDefault06;
            `
      );
    }).toThrow(new RegExp("missing value for required link 'def06'"));
  });

  it("test_edgeql_ddl_default_07", () => {
    h.script(
      `
            CREATE TYPE Foo;
            INSERT Foo;

            alter type Foo {
                create required property name -> str {
                    set default := 'something'
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo.name;
            `,
      unorderedSet(["something"])
    );
  });

  it("test_edgeql_ddl_default_08", () => {
    h.script(
      `
            CREATE TYPE Foo;
            INSERT Foo;

            alter type Foo {
                create required multi property name -> str {
                    set default := 'something'
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo.name;
            `,
      unorderedSet(["something"])
    );
  });

  it("test_edgeql_ddl_default_09", () => {
    h.script(
      `
            CREATE TYPE Foo;
        `
    );
    expect(() => {
      h.script(
        `
                create type Bar {
                    create link asdf -> Foo {
                        create property x -> int64 {
                            set default := count(Object)
                        }
                    }
                };
            `
      );
    }).toThrow(new RegExp("default value for property 'x' of link 'asdf' of object type 'default::Bar' is too complicated; link property defaults must not depend on database contents"));
  });

  it("test_edgeql_ddl_default_10", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE X {
                    CREATE PROPERTY y -> array<int16> {
                        SET default := <array<int32>>[]
                    };
                };
            `
      );
    }).toThrow(new RegExp("default expression is of invalid type: array<std::int32>, expected array<std::int16>"));
  });

  it("test_edgeql_ddl_default_11", () => {
    expect(() => {
      h.script(
        `
                CREATE GLOBAL y -> array<int16> {
                    SET default := <array<int32>>[]
                };
            `
      );
    }).toThrow(new RegExp("default expression is of invalid type: array<std::int32>, expected array<std::int16>"));
  });

  it("test_edgeql_ddl_default_12", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Test3 {
                    CREATE LINK d7 : Test3 {
                        SET default := (INSERT Test3 {})
                    }
                }
                `
      );
    }).toThrow(new RegExp("is part of a default cycle"));
  });

  it("test_edgeql_ddl_default_13", () => {
    expect(() => {
      h.script(
        `
                create type User;

                create type Project {
                    create required link owner -> User;
                };

                alter type User {
                    create link default_project -> Project {
                        set default := (insert Project {
                            owner := User
                        })
                    };
                };
                `
      );
    }).toThrow(new RegExp("possibly more than one element returned by an expression"));
  });

  it("test_edgeql_ddl_default_14", () => {
    h.script(
      `
            create type X;
            insert X;
        `
    );
    expect(() => {
      h.script(
        `
                alter type X {
                    create required property foo -> str {
                        set default := (select "!" filter false);
                    }
                };
            `
      );
    }).toThrow(new RegExp("missing value for required property"));
  });

  it("test_edgeql_ddl_default_15", () => {
    h.script(
      `
            create type T;
            insert T;
            alter type T {
                create required property tup: tuple<int32, int32> {
                    set default := ((0, 0));
                };
            };
            insert T;
        `
    );
  });

  it("test_edgeql_ddl_default_16", () => {
    h.script(
      `
            create type T;
            insert T;
            alter type T {
                create required property y: str {
                    set default := (with x := { y := "lol" }, select x.y)
                }
            };
            insert T;
        `
    );
    assertQueryResult(
      h,
      `
                select T { y }
            `,
      [
            {
              "y": "lol",
            },
            {
              "y": "lol",
            },
          ]
    );
  });

  it("test_edgeql_ddl_default_circular", () => {
    h.script(
      `
            CREATE TYPE TestDefaultCircular {
                CREATE PROPERTY def01 -> int64 {
                    SET default := (SELECT count(TestDefaultCircular));
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_default_id", () => {
    h.script(
      `
            create type A {
                alter property id {
                    set default := std::uuid_generate_v4()
                }
            };
        `
    );
    h.script(
      `
            create type B {
                alter property id {
                    set default := (select std::uuid_generate_v4())
                }
            };
        `
    );
    expect(() => {
      h.script(
        `
                create type C {
                    alter property id {
                        set default :=
                          <uuid>"00000000-0000-0000-0000-000000000000"
                    }
                };
            `
      );
    }).toThrow(new RegExp("invalid default value for 'id' property"));
  });

  it("test_edgeql_ddl_property_alter_01", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY bar -> float32;
            };
        `
    );
    h.script(
      `
            CREATE TYPE TestDefaultCircular {
                CREATE PROPERTY def01 -> int64 {
                    SET default := (SELECT count(TestDefaultCircular));
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_link_target_bad_01", () => {
    h.script(
      `

            CREATE TYPE A;
            CREATE TYPE B;

            CREATE TYPE Base0 {
                CREATE LINK foo -> A;
            };
            CREATE TYPE Base1 {
                CREATE LINK foo -> B;
            };
        `
    );
    expect(() => {
      h.script(
        `
                CREATE TYPE Derived EXTENDING Base0, Base1;
            `
      );
    }).toThrow(new RegExp("inherited link 'foo' of object type 'default::Derived' has a type conflict"));
  });

  it("test_edgeql_ddl_link_target_bad_02", () => {
    h.script(
      `

            CREATE TYPE A;
            CREATE TYPE B;
            CREATE TYPE C;

            CREATE TYPE Base0 {
                CREATE LINK foo -> A | B;
            };
            CREATE TYPE Base1 {
                CREATE LINK foo -> C;
            };
        `
    );
    expect(() => {
      h.script(
        `
                CREATE TYPE Derived EXTENDING Base0, Base1;
            `
      );
    }).toThrow(new RegExp("inherited link 'foo' of object type 'default::Derived' has a type conflict"));
  });

  it("test_edgeql_ddl_link_target_bad_03", () => {
    h.script(
      `
            CREATE TYPE A;
            CREATE TYPE Foo {
                CREATE LINK a -> A;
                CREATE PROPERTY b -> str;
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK a RESET TYPE;
            `
      );
    }).toThrow(new RegExp("cannot RESET TYPE of link 'a' of object type 'default::Foo' because it is not inherited"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY b RESET TYPE;
            `
      );
    }).toThrow(new RegExp("cannot RESET TYPE of property 'b' of object type 'default::Foo' because it is not inherited"));
  });

  it("test_edgeql_ddl_link_target_bad_04", () => {
    h.script(
      `
            CREATE TYPE Foo;
            CREATE TYPE Bar;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE TYPE Spam {
                    CREATE MULTI LINK foobar := Foo[IS Bar]
                };
            `
      );
    }).toThrow(new RegExp("unsupported type intersection in schema"));
  });

  it("test_edgeql_ddl_link_target_bad_05", () => {
    expect(() => {
      h.script(
        `
                create type Foo {
                    create link bar -> array<Foo>;
                };
            `
      );
    }).toThrow(new RegExp("invalid link target type, expected object type, got.+array"));
  });

  it("test_edgeql_ddl_link_target_bad_06", () => {
    expect(() => {
      h.script(
        `
                create type Foo {
                    create multi link bar -> array<Foo>;
                };
            `
      );
    }).toThrow(new RegExp("invalid link target type, expected object type, got.+array"));
  });

  it("test_edgeql_ddl_link_target_bad_07", () => {
    expect(() => {
      h.script(
        `
                create type A;
                create type Foo {
                    create required link bar -> A {
                        on target delete deferred restrict;
                    };
                };
            `
      );
    }).toThrow(new RegExp("required links may not use `on target delete deferred restrict`"));
  });

  it("test_edgeql_ddl_link_target_merge_01", () => {
    h.script(
      `

            CREATE TYPE A;
            CREATE TYPE B EXTENDING A;

            CREATE TYPE Base0 {
                CREATE LINK foo -> B;
            };
            CREATE TYPE Base1 {
                CREATE LINK foo -> A;
            };
            CREATE TYPE Derived EXTENDING Base0, Base1;
        `
    );
  });

  it("test_edgeql_ddl_link_target_merge_02", () => {
    h.script(
      `

            CREATE TYPE A;
            CREATE TYPE B;
            CREATE TYPE C;

            CREATE TYPE Base0 {
                CREATE LINK foo -> A;
            };
            CREATE TYPE Base1 {
                CREATE LINK foo -> A | B;
            };
            CREATE TYPE Derived EXTENDING Base0, Base1;
        `
    );
  });

  it("test_edgeql_ddl_link_target_alter_01", () => {
    h.script(
      `
            CREATE TYPE GrandParent01 {
                CREATE PROPERTY foo -> int64;
            };

            CREATE TYPE Parent01 EXTENDING GrandParent01;
            CREATE TYPE Parent02 EXTENDING GrandParent01;

            CREATE TYPE Child EXTENDING Parent01, Parent02;

            ALTER TYPE GrandParent01 {
                ALTER PROPERTY foo SET TYPE int16;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name IN
                          {'default::Child', 'default::Parent01'})
                SELECT
                    C.pointers { target: { name } }
                FILTER
                    C.pointers.name = 'foo'
            `,
      [
            {
              "target": {
                "name": "std::int16",
              },
            },
            {
              "target": {
                "name": "std::int16",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_link_target_alter_02", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Parent01 {
                    CREATE PROPERTY foo -> int64;
                };

                CREATE TYPE Parent02 {
                    CREATE PROPERTY foo -> int64;
                };

                CREATE TYPE Child
                    EXTENDING Parent01, Parent02;

                ALTER TYPE Parent02 {
                    ALTER PROPERTY foo SET TYPE int16;
                };
            `
      );
    }).toThrow(new RegExp("inherited property 'foo' of object type 'default::Child' has a type conflict"));
  });

  it("test_edgeql_ddl_link_target_alter_03", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY bar -> int64;
            };

            CREATE TYPE Bar {
                CREATE MULTI PROPERTY foo -> int64 {
                    SET default := (SELECT Foo.bar);
                }
            };

            ALTER TYPE Foo ALTER PROPERTY bar SET TYPE int32;
        `
    );
  });

  it("test_edgeql_ddl_link_target_alter_04", () => {
    h.script(
      `

            CREATE TYPE A;
            CREATE TYPE B;

            CREATE TYPE Base0 {
                CREATE LINK foo -> A | B;
            };

            CREATE TYPE Derived EXTENDING Base0 {
                ALTER LINK foo SET TYPE B;
            }
        `
    );
  });

  it("test_edgeql_ddl_link_target_alter_05", () => {
    h.script(
      `

            CREATE TYPE A;
            CREATE TYPE B EXTENDING A;

            CREATE TYPE Base0 {
                CREATE LINK foo -> B;
            };

            CREATE TYPE Base1;

            CREATE TYPE Derived EXTENDING Base0, Base1;

            ALTER TYPE Base1 CREATE LINK foo -> A;
        `
    );
  });

  it("test_edgeql_ddl_link_target_alter_06", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY foo -> int64;
                CREATE PROPERTY bar := .foo + .foo;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY foo SET TYPE int16;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C := (SELECT schema::ObjectType
                          FILTER .name = 'default::Foo')
                SELECT
                    C.pointers { target: { name } }
                FILTER
                    C.pointers.name = 'bar'
            `,
      [
            {
              "target": {
                "name": "std::int16",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_prop_target_alter_array_01", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY foo -> array<int32>;
            };

            ALTER TYPE Foo {
                ALTER PROPERTY foo SET TYPE array<float64>;
            };

            ALTER TYPE Foo {
                ALTER PROPERTY foo {
                    SET TYPE array<int32> USING (<array<int32>>.foo);
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_prop_target_subtype_01", () => {
    h.script(
      `
            CREATE SCALAR TYPE mystr EXTENDING std::str {
                CREATE CONSTRAINT std::max_len_value(5)
            };

            CREATE TYPE Foo {
                CREATE PROPERTY a -> std::str;
            };

            CREATE TYPE Bar EXTENDING Foo {
                ALTER PROPERTY a SET TYPE mystr;
            };
        `
    );
    h.script(
      `INSERT Foo { a := "123456" }`
    );
    expect(() => {
      h.script(
        `INSERT Bar { a := "123456" }`
      );
    }).toThrow(new RegExp("must be no longer than 5 characters"));
    h.script(
      `
            ALTER TYPE Bar ALTER PROPERTY a RESET TYPE;
        `
    );
    h.script(
      `INSERT Bar { a := "123456" }`
    );
  });

  it("test_edgeql_ddl_ptr_set_type_using_01", () => {
    h.script(
      `

            CREATE SCALAR TYPE mystr EXTENDING str;

            CREATE TYPE Bar {
                CREATE PROPERTY name -> str;
            };

            CREATE TYPE SubBar EXTENDING Bar;

            CREATE TYPE Foo {
                CREATE PROPERTY p -> str {
                    CREATE CONSTRAINT exclusive;
                };
                CREATE CONSTRAINT exclusive ON (.p);
                CREATE REQUIRED PROPERTY r_p -> str;
                CREATE MULTI PROPERTY m_p -> str;
                CREATE REQUIRED MULTI PROPERTY rm_p -> str;

                CREATE LINK l -> Bar {
                    CREATE PROPERTY lp -> str;
                };
                CREATE REQUIRED LINK r_l -> Bar {
                    CREATE PROPERTY lp -> str;
                };
                CREATE MULTI LINK m_l -> Bar {
                    CREATE PROPERTY lp -> str;
                };
                CREATE REQUIRED MULTI LINK rm_l -> Bar {
                    CREATE PROPERTY lp -> str;
                };
            };

            INSERT Bar {name := 'bar1'};
            INSERT SubBar {name := 'bar2'};

            WITH
                bar := (SELECT Bar FILTER .name = 'bar1' LIMIT 1),
                bars := (SELECT Bar),
            INSERT Foo {
                p := '1',
                r_p := '10',
                m_p := {'1', '2'},
                rm_p := {'10', '20'},

                l := bar { @lp := '1' },
                r_l := bar { @lp := '10' },
                m_l := (
                    FOR bar IN {enumerate(bars)}
                    UNION (SELECT bar.1 { @lp := <str>(bar.0 + 1) })
                ),
                rm_l := (
                    FOR bar IN {enumerate(bars)}
                    UNION (SELECT bar.1 { @lp := <str>((bar.0 + 1) * 10) })
                )
            };

            WITH
                bar := (SELECT Bar FILTER .name = 'bar2' LIMIT 1),
                bars := (SELECT Bar),
            INSERT Foo {
                p := '3',
                r_p := '30',
                m_p := {'3', '4'},
                rm_p := {'30', '40'},

                l := bar { @lp := '3' },
                r_l := bar { @lp := '30' },
                m_l := (
                    FOR bar IN {enumerate(bars)}
                    UNION (SELECT bar.1 { @lp := <str>(bar.0 + 3) })
                ),
                rm_l := (
                    FOR bar IN {enumerate(bars)}
                    UNION (SELECT bar.1 { @lp := <str>((bar.0 + 3) * 10) })
                )
            };
        `
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET TYPE int64 USING (<int64>.p)
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { p } ORDER BY .p`,
      [
            {
              "p": 1,
            },
            {
              "p": 3,
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY m_p {
                    SET TYPE int64 USING (<int64>.m_p)
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { m_p } ORDER BY .p`,
      [
            {
              "m_p": unorderedSet([1, 2]),
            },
            {
              "m_p": unorderedSet([3, 4]),
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET TYPE mystr USING (.p ++ '!')
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { p } ORDER BY .p`,
      [
            {
              "p": "1!",
            },
            {
              "p": "3!",
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET TYPE str USING (.p ++ '!')
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { p } ORDER BY .p`,
      [
            {
              "p": "1!",
            },
            {
              "p": "3!",
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET TYPE int64 USING (<int64>.r_p)
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { p } ORDER BY .p`,
      [
            {
              "p": 10,
            },
            {
              "p": 30,
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY m_p {
                    SET TYPE int64 USING (<int64>.m_p + <int64>.r_p)
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { m_p } ORDER BY .p`,
      [
            {
              "m_p": unorderedSet([11, 12]),
            },
            {
              "m_p": unorderedSet([33, 34]),
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY m_p {
                    SET TYPE int64 USING (SELECT <int64>.m_p + <int64>.r_p)
                }
            `
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET TYPE int64 USING (<int64>{})
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { p } ORDER BY .p`,
      [
            {
              "p": null,
            },
            {
              "p": null,
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY m_p {
                    SET TYPE int64 USING (
                        <int64>{} IF <int64>.m_p % 2 = 0 ELSE <int64>.m_p
                    )
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { m_p } ORDER BY .p`,
      [
            {
              "m_p": unorderedSet([1]),
            },
            {
              "m_p": unorderedSet([3]),
            },
          ]
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY r_p {
                    SET TYPE int64 USING (<int64>{})
                }
            `
      );
    }).toThrow(new RegExp("missing value for required property 'r_p' of object type 'default::Foo'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY rm_p {
                    SET TYPE int64 USING (
                        <int64>{} IF True ELSE <int64>.rm_p
                    )
                }
            `
      );
    }).toThrow(new RegExp("missing value for required property 'rm_p' of object type 'default::Foo'"));
    h.script(
      `
                ALTER TYPE Foo ALTER LINK l {
                    SET TYPE SubBar USING (.l[IS SubBar])
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { l: {name} } ORDER BY .p`,
      [
            {
              "l": null,
            },
            {
              "l": {
                "name": "bar2",
              },
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER LINK m_l {
                    SET TYPE SubBar USING (.m_l[IS SubBar])
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { m_l: {name} } ORDER BY .p`,
      [
            {
              "m_l": [
                {
                  "name": "bar2",
                },
              ],
            },
            {
              "m_l": [
                {
                  "name": "bar2",
                },
              ],
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER LINK l {
                    SET TYPE SubBar USING (SELECT .m_l[IS SubBar] LIMIT 1)
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { l: {name, @lp} } ORDER BY .p`,
      [
            {
              "l": {
                "name": "bar2",
                "@lp": "1",
              },
            },
            {
              "l": {
                "name": "bar2",
                "@lp": "3",
              },
            },
          ]
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK r_l {
                    SET TYPE SubBar USING (.r_l[IS SubBar])
                }
            `
      );
    }).toThrow(new RegExp("missing value for required link 'r_l' of object type 'default::Foo'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK rm_l {
                    SET TYPE SubBar USING (SELECT SubBar FILTER False LIMIT 1)
                }
            `
      );
    }).toThrow(new RegExp("missing value for required link 'rm_l' of object type 'default::Foo'"));
    h.script(
      `
                ALTER TYPE Foo ALTER LINK l ALTER PROPERTY lp {
                    SET TYPE int64 USING (<int64>@lp)
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { l: { @lp } } ORDER BY .p`,
      [
            {
              "l": {
                "@lp": 1,
              },
            },
            {
              "l": {
                "@lp": 3,
              },
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER LINK l ALTER PROPERTY lp {
                    SET TYPE int64 USING (SELECT <int64>@lp)
                }
            `
    );
  });

  it("test_edgeql_ddl_ptr_set_type_using_02", () => {
    h.script(
      `

            CREATE ABSTRACT TYPE Parent {
                CREATE PROPERTY name -> str;
            };
            CREATE TYPE Child EXTENDING Parent;
            INSERT Child { name := "10" };
        `
    );
    h.script(
      `
            ALTER TYPE Parent {
                ALTER PROPERTY name {
                    SET TYPE int64 USING (<int64>.name)
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Child { name }`,
      [
            {
              "name": 10,
            },
          ]
    );
  });

  it("test_edgeql_ddl_ptr_set_type_using_03", () => {
    h.script(
      `
            create type Foo {
                create property x -> str {
                    set default := '';
                };
                create multi property y -> str {
                    set default := '';
                };
            };
            # And that aliases don't either
            create alias Alias := Foo;
        `
    );
    h.script(
      `
            alter type Foo {
                alter property x {
                    set default := 0;
                    set type int64 using (<int64>.x);
                };
                alter property y {
                    set default := 0;
                    set type int64 using (<int64>.y);
                };
            };
        `
    );
    h.script(
      `
            create type Bar {
                create link l -> Foo {
                    create property x -> str {
                        set default := '';
                    }
                }
            };
        `
    );
    h.script(
      `
            alter type Bar {
                alter link l {
                    alter property x {
                        set default := 0;
                        set type int64 using (<int64>@x);
                    }
                }
            };
        `
    );
  });

  it("test_edgeql_ddl_ptr_set_type_using_04", () => {
    h.script(
      `
            create scalar type X extending sequence;
            create type Foo {
                create property x -> X;
            };
        `
    );
    h.script(
      `
            alter type Foo {
                alter property x {
                    set type array<str> using ([<str>.x]);
                }
            };
        `
    );
    h.script(
      `
            create type Bar {
                create property x -> int64;
            };
        `
    );
    h.script(
      `
            alter type Bar {
                alter property x {
                    set type X using (<X>.x);
                }
            };
        `
    );
    h.script(
      `
            create type Baz {
                create multi property x -> int64;
            };
        `
    );
    h.script(
      `
            alter type Baz {
                alter property x {
                    set type X using (<X>.x);
                }
            };
        `
    );
  });

  it("test_edgeql_ddl_ptr_set_type_validation", () => {
    h.script(
      `

            CREATE TYPE Bar;
            CREATE TYPE Spam;
            CREATE TYPE Egg;
            CREATE TYPE Foo {
                CREATE PROPERTY p -> str;
                CREATE LINK l -> Bar {
                    CREATE PROPERTY lp -> str;
                };
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY p SET TYPE int64;
            `
      );
    }).toThrow(new RegExp("property 'p' of object type 'default::Foo' cannot be cast automatically from scalar type 'std::str' to scalar type 'std::int64'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY p
                    SET TYPE int64 USING (<float64>.p)
            `
      );
    }).toThrow(new RegExp("result of USING clause for the alteration of property 'p' of object type 'default::Foo' cannot be cast automatically from scalar type 'std::float64' to scalar type 'std::int64'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY p SET TYPE int64 USING ({1, 2})
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by the USING clause for the alteration of property 'p' of object type 'default::Foo', while a singleton is expected"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK l SET TYPE Spam;
            `
      );
    }).toThrow(new RegExp("link 'l' of object type 'default::Foo' cannot be cast automatically from object type 'default::Bar' to object type 'default::Spam'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK l SET TYPE Spam USING (.l[IS Egg])
            `
      );
    }).toThrow(new RegExp("result of USING clause for the alteration of link 'l' of object type 'default::Foo' cannot be cast automatically from object type '\\(default::Bar & default::Egg\\)' to object type 'default::Spam'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK l SET TYPE Spam USING (SELECT Spam)
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by the USING clause for the alteration of link 'l' of object type 'default::Foo', while a singleton is expected"));
  });

  it("test_edgeql_ddl_ptr_using_dml_01", () => {
    h.script(
      `
            CREATE TYPE Hello;
            CREATE TYPE World {
                CREATE LINK hell -> Hello;
                CREATE MULTI LINK heaven -> Hello;
            };
            INSERT World {
                heaven := {
                    (INSERT Hello),
                    (INSERT Hello),
                    (INSERT Hello),
                }
            };
            INSERT World {
                hell := (INSERT Hello),
                heaven := {
                    (INSERT Hello),
                    (INSERT Hello),
                }
            };
            `
    );
    expect((h.query("SELECT Hello")).length).toEqual(6);
    h.script(
      `
            ALTER TYPE World {
                ALTER LINK hell SET REQUIRED USING (INSERT Hello);
                ALTER LINK heaven SET SINGLE USING (INSERT Hello);
            }
            `
    );
    expect((h.query("SELECT Hello")).length).toEqual(9);
    let res = h.query("SELECT World { hell: { id }, heaven: { id } }");
    expect((res).length).toEqual(2);
    let set_of_hellos = union(undefined);
    expect((set_of_hellos).length).toEqual(4);
  });

  it("test_edgeql_ddl_ptr_using_dml_02", () => {
    h.script(
      `
            CREATE TYPE Hello;
            CREATE TYPE World {
                CREATE LINK hell -> Hello;
                CREATE MULTI LINK heaven -> Hello;
            };
            `
    );
    h.script(
      `
            ALTER TYPE World {
                ALTER LINK hell SET REQUIRED USING (INSERT Hello);
                ALTER LINK heaven SET SINGLE USING (INSERT Hello);
            }
            `
    );
  });

  it("test_edgeql_ddl_ptr_using_dml_03", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Hello;
                CREATE TYPE Goodbye;
                CREATE TYPE World {
                    CREATE LINK hell -> Hello;
                };
                INSERT World { hell:= (INSERT Hello) };
                INSERT World {};
                ALTER TYPE World {
                    ALTER LINK hell SET TYPE Goodbye USING (INSERT Goodbye);
                }
                `
      );
      assertQueryResult(
        h,
        `select Goodbye`,
        [
              {},
              {},
            ]
      );
    }).toThrow(new RegExp("cannot include mutating statements"));
  });

  it("test_edgeql_ddl_ptr_using_dml_04", () => {
    h.script(
      `
            CREATE TYPE Box {
                CREATE PROPERTY chance_of_success -> str;
            };
            INSERT Box { chance_of_success := 'low' };
            INSERT Box { chance_of_success := 'high' };
            INSERT Box { chance_of_success := 'none' };
            ALTER TYPE Box {
                ALTER PROPERTY chance_of_success
                    SET TYPE float64
                    USING (random());
            }
            `
    );
    let res = h.query("select Box { chance_of_success }");
    expect((res).length).toEqual(3);
    expect(res[0].chance_of_success).not.toEqual(res[1].chance_of_success);
    expect(res[1].chance_of_success).not.toEqual(res[2].chance_of_success);
    expect(res[2].chance_of_success).not.toEqual(res[0].chance_of_success);
  });

  it("test_edgeql_ddl_ptr_using_dml_05", () => {
    h.script(
      `
            CREATE TYPE Hello {
                CREATE PROPERTY bar -> str;
            };
            CREATE TYPE World {
                CREATE PROPERTY foo -> str;
                CREATE LINK hell -> Hello;
            };
            INSERT World { foo := 'hello' };
            `
    );
    h.script(
      `
            ALTER TYPE World {
                ALTER LINK hell SET REQUIRED
                    USING (INSERT Hello { bar := World.foo });
            }
            `
    );
  });

  it("test_edgeql_ddl_ptr_set_cardinality_01", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE MULTI PROPERTY bar -> str;
            };
            INSERT Foo { bar := "foo" };
            ALTER TYPE Foo { ALTER PROPERTY bar {
                SET SINGLE USING (assert_single(.bar))
            } };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo { bar }
            `,
      [
            {
              "bar": "foo",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                DELETE Foo
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_ddl_ptr_set_cardinality_02", () => {
    h.script(
      `
            create type B {
                create multi property x -> str {
                    create constraint exclusive;
                };
            };
            create type C extending B;
        `
    );
    h.script(
      `
            alter type B alter property x set single using (select .x limit 1);
        `
    );
    h.script(
      `
            insert B { x := 'a' };
        `
    );
    expect(() => {
      h.script(
        `
                insert B { x := 'a' };
            `
      );
    }).toThrow(new RegExp(""));
    expect(() => {
      h.script(
        `
                insert C { x := 'a' };
            `
      );
    }).toThrow(new RegExp(""));
    h.script(
      `
            drop type C;
            drop type B;
        `
    );
  });

  it("test_edgeql_ddl_ptr_set_cardinality_03", () => {
    h.script(
      `
            create type B {
                create property x -> str {
                    create constraint exclusive;
                }
            };
            create type C extending B;
        `
    );
    h.script(
      `
            alter type B alter property x set multi;
        `
    );
    h.script(
      `
            insert B { x := 'a' };
        `
    );
    expect(() => {
      h.script(
        `
                insert B { x := 'a' };
            `
      );
    }).toThrow(new RegExp(""));
    expect(() => {
      h.script(
        `
                insert C { x := 'a' };
            `
      );
    }).toThrow(new RegExp(""));
    h.script(
      `
            drop type C;
            drop type B;
        `
    );
  });

  it("test_edgeql_ddl_ptr_set_cardinality_validation", () => {
    h.script(
      `
            CREATE TYPE Bar;
            CREATE TYPE Egg;
            CREATE TYPE Foo {
                CREATE MULTI PROPERTY p -> str;
                CREATE MULTI LINK l -> Bar {
                    CREATE PROPERTY lp -> str;
                };
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY p SET SINGLE;
            `
      );
    }).toThrow(new RegExp("cannot automatically convert property 'p' of object type 'default::Foo' to 'single' cardinality"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY p
                    SET TYPE int64 USING (<float64>.p)
            `
      );
    }).toThrow(new RegExp("result of USING clause for the alteration of property 'p' of object type 'default::Foo' cannot be cast automatically from scalar type 'std::float64' to scalar type 'std::int64'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY p SET SINGLE USING ({1, 2})
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by the USING clause for the alteration of property 'p' of object type 'default::Foo', while a singleton is expected"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK l SET SINGLE;
            `
      );
    }).toThrow(new RegExp("cannot automatically convert link 'l' of object type 'default::Foo' to 'single' cardinality"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK l
                    SET SINGLE USING (SELECT Egg LIMIT 1);
            `
      );
    }).toThrow(new RegExp("result of USING clause for the alteration of link 'l' of object type 'default::Foo' cannot be cast automatically from object type 'default::Egg' to object type 'default::Bar'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK l SET SINGLE USING (SELECT Bar)
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by the USING clause for the alteration of link 'l' of object type 'default::Foo', while a singleton is expected"));
  });

  it("test_edgeql_ddl_ptr_using_01", () => {
    h.script(
      `
            create type B {
                create property y -> str;
                create property x -> str {
                    create constraint exclusive;
                };
                create constraint exclusive on (.x);
            };
            create type C extending B;
        `
    );
    h.script(
      `
            alter type B alter property x using (.y);
        `
    );
    h.script(
      `
            insert B { y := 'a' };
        `
    );
    expect(() => {
      h.script(
        `
                insert B { y := 'a' };
            `
      );
    }).toThrow(new RegExp(""));
    expect(() => {
      h.script(
        `
                insert C { y := 'a' };
            `
      );
    }).toThrow(new RegExp(""));
    h.script(
      `
            drop type C;
            drop type B;
        `
    );
  });

  it("test_edgeql_ddl_ptr_using_02", () => {
    h.script(
      `
            create type B {
                create multi property y -> str;
                create multi property x -> str {
                    create constraint exclusive;
                };
            };
            create type C extending B;
        `
    );
    h.script(
      `
            alter type B alter property x using (.y);
        `
    );
    h.script(
      `
            insert B { y := 'a' };
        `
    );
    expect(() => {
      h.script(
        `
                insert B { y := 'a' };
            `
      );
    }).toThrow(new RegExp(""));
    expect(() => {
      h.script(
        `
                insert C { y := 'a' };
            `
      );
    }).toThrow(new RegExp(""));
    h.script(
      `
            drop type C;
            drop type B;
        `
    );
  });

  it("test_edgeql_ddl_ptr_set_required_01", () => {
    h.script(
      `

            CREATE TYPE Bar {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT std::exclusive;
                }
            };

            CREATE TYPE Foo {
                CREATE PROPERTY p -> str;
                CREATE PROPERTY p2 -> str;
                CREATE MULTI PROPERTY m_p -> str;

                CREATE LINK l -> Bar {
                    CREATE PROPERTY lp -> str;
                };
                CREATE MULTI LINK m_l -> Bar {
                    CREATE PROPERTY lp -> str;
                };
            };

            INSERT Bar {name := 'bar1'};
            INSERT Bar {name := 'bar2'};

            WITH
                bar := (SELECT Bar FILTER .name = 'bar1' LIMIT 1),
                bars := (SELECT Bar),
            INSERT Foo {
                p := '1',
                p2 := '1',
                m_p := {'1', '2'},

                l := bar { @lp := '1' },
                m_l := (
                    FOR bar IN {enumerate(bars)}
                    UNION (SELECT bar.1 { @lp := <str>(bar.0 + 1) })
                ),
            };

            INSERT Foo {
                p2 := '3',
            };
        `
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET REQUIRED USING ('3')
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { p } ORDER BY .p`,
      [
            {
              "p": "1",
            },
            {
              "p": "3",
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY m_p {
                    SET REQUIRED USING ('3')
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { m_p } ORDER BY .p`,
      [
            {
              "m_p": unorderedSet(["1", "2"]),
            },
            {
              "m_p": unorderedSet(["3"]),
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET REQUIRED USING (
                        assert_exists((select '3' filter true)))
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { p } ORDER BY .p`,
      [
            {
              "p": "1",
            },
            {
              "p": "3",
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET REQUIRED USING (.p2)
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { p } ORDER BY .p`,
      [
            {
              "p": "1",
            },
            {
              "p": "3",
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER PROPERTY m_p {
                    SET REQUIRED USING (.p2)
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { m_p } ORDER BY .p`,
      [
            {
              "m_p": unorderedSet(["1", "2"]),
            },
            {
              "m_p": unorderedSet(["3"]),
            },
          ]
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY p {
                    SET REQUIRED USING (<str>{})
                }
            `
      );
    }).toThrow(new RegExp("missing value for required property 'p' of object type 'default::Foo'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY m_p {
                    SET REQUIRED USING (
                        <str>{} IF True ELSE .p2
                    )
                }
            `
      );
    }).toThrow(new RegExp("missing value for required property 'm_p' of object type 'default::Foo'"));
    h.script(
      `
                ALTER TYPE Foo ALTER LINK l {
                    SET REQUIRED USING (SELECT Bar FILTER .name = 'bar2')
                }
            `
    );
    assertQueryResult(
      h,
      `SELECT Foo { l: {name} } ORDER BY .p EMPTY LAST`,
      [
            {
              "l": {
                "name": "bar1",
              },
            },
            {
              "l": {
                "name": "bar2",
              },
            },
          ]
    );
    h.script(
      `
                ALTER TYPE Foo ALTER LINK m_l {
                    SET REQUIRED USING (SELECT Bar FILTER .name = 'bar2')
                }
            `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo { m_l: {name} ORDER BY .name }
                ORDER BY .p EMPTY LAST
                `,
      [
            {
              "m_l": [
                {
                  "name": "bar1",
                },
                {
                  "name": "bar2",
                },
              ],
            },
            {
              "m_l": [
                {
                  "name": "bar2",
                },
              ],
            },
          ]
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK l {
                    SET REQUIRED USING (SELECT Bar FILTER false LIMIT 1)
                }
            `
      );
    }).toThrow(new RegExp("missing value for required link 'l' of object type 'default::Foo'"));
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK m_l {
                    SET REQUIRED USING (SELECT Bar FILTER false LIMIT 1)
                }
            `
      );
    }).toThrow(new RegExp("missing value for required link 'm_l' of object type 'default::Foo'"));
  });

  it("test_edgeql_ddl_ptr_set_required_02", () => {
    h.script(
      `
            create type X { create required multi property foo -> str };
            insert X { foo := "test" };
            alter type X alter property foo set single
                using (assert_single(.foo));
            `
    );
    assertQueryResult(
      h,
      `select X { foo }`,
      [
            {
              "foo": "test",
            },
          ]
    );
  });

  it("test_edgeql_ddl_ptr_set_required_03", () => {
    h.script(
      `
            CREATE TYPE Agent;
            CREATE TYPE AgentVersion {
                CREATE SINGLE LINK agent2 -> Agent;
                CREATE SINGLE LINK agent := .agent2;
            };
            CREATE TYPE Obj {
                CREATE REQUIRED SINGLE LINK agentVersion: AgentVersion;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Obj {
                CREATE REQUIRED SINGLE LINK agent: Agent {
                    SET REQUIRED USING (.agentVersion.agent);
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_link_property_01", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            INSERT Tgt;
            CREATE TYPE TestLinkPropType_01 {
                CREATE LINK test_linkprop_link_01 -> std::Object {
                    CREATE REQUIRED PROPERTY test_link_prop_01
                        -> std::int64;
                };
            };
        `
    );
    h.script(
      `
            insert TestLinkPropType_01 {
                test_linkprop_link_01 := (select Tgt limit 1) {
                    @test_link_prop_01 := 12
                }
            }
        `
    );
    expect(() => {
      h.script(
        `
                insert TestLinkPropType_01 {
                    test_linkprop_link_01 := (select Tgt limit 1) {
                        @test_link_prop_01 := (select 12 filter false)
                    }
                }
            `
      );
    }).toThrow(new RegExp("required property 'test_link_prop_01'"));
    expect(() => {
      h.script(
        `
                insert TestLinkPropType_01 {
                    test_linkprop_link_01 := (select Tgt limit 1)
                }
            `
      );
    }).toThrow(new RegExp("required property 'test_link_prop_01'"));
    h.script(
      `
            alter type TestLinkPropType_01
            alter link test_linkprop_link_01
            alter property test_link_prop_01
            set optional
        `
    );
    h.script(
      `
            insert TestLinkPropType_01 {
                test_linkprop_link_01 := (select Tgt limit 1)
            }
        `
    );
    expect(() => {
      h.script(
        `
                alter type TestLinkPropType_01
                alter link test_linkprop_link_01
                alter property test_link_prop_01
                set required
            `
      );
    }).toThrow(new RegExp("required property 'test_link_prop_01'"));
    h.script(
      `
            delete TestLinkPropType_01
        `
    );
    h.script(
      `
            alter type TestLinkPropType_01
            alter link test_linkprop_link_01
            alter property test_link_prop_01
            set required
        `
    );
    expect(() => {
      h.script(
        `
                insert TestLinkPropType_01 {
                    test_linkprop_link_01 := (select Tgt limit 1) {
                        @test_link_prop_01 := (select 12 filter false)
                    }
                }
            `
      );
    }).toThrow(new RegExp("required property 'test_link_prop_01'"));
  });

  it("test_edgeql_ddl_link_property_02", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE TestLinkPropType_02 {
                    CREATE LINK test_linkprop_link_02 -> std::Object {
                        CREATE MULTI PROPERTY test_link_prop_02 -> std::int64;
                    };
                };
            `
      );
    }).toThrow(new RegExp("multi properties aren't supported for links"));
  });

  it("test_edgeql_ddl_link_property_03", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE TestLinkPropType_04 {
                    CREATE LINK test_linkprop_link_04 -> std::Object;
                };

                ALTER TYPE TestLinkPropType_04 {
                    ALTER LINK test_linkprop_link_04 {
                        CREATE MULTI PROPERTY test_link_prop_04 -> std::int64;
                    };
                };
            `
      );
    }).toThrow(new RegExp("multi properties aren't supported for links"));
  });

  it("test_edgeql_ddl_link_property_04", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE TestLinkPropType_06 {
                    CREATE LINK test_linkprop_link_06 -> std::Object {
                        CREATE MULTI PROPERTY test_link_prop_06 -> std::int64;
                    };
                };

                ALTER TYPE TestLinkPropType_06 {
                    ALTER LINK test_linkprop_link_06 {
                        ALTER PROPERTY test_link_prop_06 {
                            SET MULTI;
                        };
                    };
                };
            `
      );
    }).toThrow(new RegExp("multi properties aren't supported for links"));
  });

  it("test_edgeql_ddl_link_property_07", () => {
    h.script(
      `
            CREATE ABSTRACT LINK link_with_value {
                CREATE SINGLE PROPERTY value -> int64;
                CREATE INDEX on (__subject__@value);
                CREATE INDEX on ((__subject__@source, __subject__@value));
                CREATE INDEX on ((__subject__@target, __subject__@value));
                # FIXME: this is broken
                # CREATE INDEX on ((__subject__, __subject__@value));
            };

            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE LINK l1 EXTENDING link_with_value -> Tgt;
            };
        `
    );
  });

  it("test_edgeql_ddl_link_property_08", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE LINK l2 -> Tgt {
                    CREATE SINGLE PROPERTY value -> int64;
                    CREATE INDEX on (__subject__@value);
                    CREATE INDEX on ((__subject__@target, __subject__@value));
                };

            };

            ALTER TYPE Foo {
                ALTER LINK l2 {
                    ALTER INDEX on ((__subject__@target, __subject__@value)) {
                        CREATE ANNOTATION description := "woo";
                    };
                    CREATE INDEX on ((__subject__@source, __subject__@value));
                    DROP INDEX on (__subject__@value);
                }
            };
        `
    );
  });

  it("test_edgeql_ddl_link_property_09", () => {
    h.script(
      `
            create type T;
            create type S {
                create multi link x -> T {
                    create property id -> str;
                    create index on (__subject__@id);
                }
            };
            insert T;
            insert S { x := (select T { @id := "lol" }) };
        `
    );
    assertQueryResult(
      h,
      `
                select S { x: {id, @id} }
            `,
      [
            {
              "x": [
                {
                  "id": "str",
                  "@id": "lol",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_link_property_10", () => {
    h.script(
      `
            CREATE TYPE default::User;
            CREATE TYPE default::Survey {
                CREATE MULTI LINK recipients -> default::User;
            };
            insert Survey { recipients := (insert User) };
        `
    );
    h.script(
      `
            alter type Survey alter link recipients
            create property destination -> str { set default := "email" };
        `
    );
    assertQueryResult(
      h,
      `
                select Survey { recipients: {@destination} };
            `,
      [
            {
              "recipients": [
                {
                  "@destination": "email",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_bad_01", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY bar -> array;
                };
            `
      );
    }).toThrow(new RegExp("type 'default::array' does not exist"));
  });

  it("test_edgeql_ddl_bad_02", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY bar -> tuple;
                };
            `
      );
    }).toThrow(new RegExp("type 'default::tuple' does not exist"));
  });

  it("test_edgeql_ddl_bad_03", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY bar -> array<int64, int64, int64>;
                };
            `
      );
    }).toThrow(new RegExp("unexpected number of subtypes, expecting 1"));
  });

  it("test_edgeql_ddl_bad_04", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY bar -> array<array<int64>>;
                };
            `
      );
    }).toThrow(new RegExp("nested arrays are not supported"));
  });

  it("test_edgeql_ddl_bad_05", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY bar -> tuple<int64, foo:int64>;
                };
            `
      );
    }).toThrow(new RegExp("mixing named and unnamed subtype declarations is not supported"));
  });

  it("test_edgeql_ddl_bad_07", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo;

                    CREATE TYPE Bar {
                        CREATE LINK foo := (INSERT Foo);
                    };
                `
      );
    }).toThrow(new RegExp("mutations are invalid in computed link 'foo'"));
  });

  it("test_edgeql_ddl_bad_08", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo;

                    CREATE TYPE Bar {
                        CREATE LINK foo := (
                            WITH x := (INSERT Foo)
                            SELECT x
                        );
                    };
                `
      );
    }).toThrow(new RegExp("mutations are invalid in computed link 'foo'"));
  });

  it("test_edgeql_ddl_bad_09", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo;

                    CREATE TYPE Bar {
                        CREATE PROPERTY foo := (INSERT Foo).id;
                    };
                `
      );
    }).toThrow(new RegExp("mutations are invalid in computed property 'foo'"));
  });

  it("test_edgeql_ddl_bad_10", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo;
                    CREATE TYPE Bar;

                    CREATE ALIAS Baz := Bar {
                        foo := (INSERT Foo)
                    };
                `
      );
    }).toThrow(new RegExp("mutations are invalid in alias definition"));
  });

  it("test_edgeql_ddl_bad_11", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo;
                    CREATE TYPE Bar;

                    CREATE ALIAS Baz := Bar {
                        foo := (INSERT Foo).id
                    };
                `
      );
    }).toThrow(new RegExp("mutations are invalid in alias definition"));
  });

  it("test_edgeql_ddl_bad_12", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo;
                    CREATE TYPE Bar {
                        CREATE LINK foo -> Foo;
                    };

                    CREATE ALIAS Baz := Bar {
                        foo: {
                            fuz := (INSERT Foo)
                        }
                    };
                `
      );
    }).toThrow(new RegExp("mutations are invalid in alias definition"));
  });

  it("test_edgeql_ddl_bad_13", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo;
                    CREATE TYPE Bar {
                        CREATE LINK foo -> Foo;
                    };

                    CREATE ALIAS Baz := (
                        WITH x := (INSERT Foo)
                        SELECT Bar {
                            foo: {
                                fuz := x
                            }
                        }
                    );
                `
      );
    }).toThrow(new RegExp("mutations are invalid in alias definition"));
  });

  it("test_edgeql_ddl_link_long_01", () => {
    h.script(
      `
            CREATE ABSTRACT LINK f123456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789;
        `
    );
    h.script(
      `
            CREATE TYPE Foo {
                CREATE LINK f123456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789 -> Foo;
            };
        `
    );
    h.query(
      `SELECT Foo.f123456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789`
    );
  });

  it("test_edgeql_ddl_link_bad_02", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo {
                        CREATE LINK foo::bar -> Foo;
                    };
                `
      );
    }).toThrow(new RegExp("unexpected fully-qualified name"));
  });

  it("test_edgeql_ddl_link_bad_03", () => {
    expect(() => {
      h.script(
        `
                    CREATE ABSTRACT LINK bar {
                        SET default := Object;
                    };
                `
      );
    }).toThrow(new RegExp("'default' is not a valid field for an abstract link"));
  });

  it("test_edgeql_ddl_link_bad_04", () => {
    expect(() => {
      h.script(
        `
                    abstract link bar {
                        default := Object;
                    };
                `
      );
    }).toThrow(new RegExp("'default' is not a valid field for an abstract link"));
  });

  it("test_edgeql_ddl_link_bad_05", () => {
    expect(() => {
      h.script(
        `
                    CREATE ABSTRACT LINK Foo extending Bar {
                        EXTENDING Bar;
                    };
                `
      );
    }).toThrow(new RegExp("specifying EXTENDING twice is not allowed"));
  });

  it("test_edgeql_ddl_property_long_01", () => {
    h.script(
      `
            CREATE ABSTRACT PROPERTY f123456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789
        `
    );
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY f123456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789 -> std::str;
            };
        `
    );
    h.query(
      `SELECT Foo.f123456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789`
    );
  });

  it("test_edgeql_ddl_property_bad_02", () => {
    expect(() => {
      h.script(
        `
                    CREATE TYPE Foo {
                        CREATE PROPERTY foo::bar -> Foo;
                    };
                `
      );
    }).toThrow(new RegExp("unexpected fully-qualified name"));
  });

  it("test_edgeql_ddl_property_bad_03", () => {
    expect(() => {
      h.script(
        `
                    CREATE ABSTRACT PROPERTY bar {
                        SET default := 'bad';
                    };
                `
      );
    }).toThrow(new RegExp("'default' is not a valid field for an abstract property"));
  });

  it("test_edgeql_ddl_property_bad_04", () => {
    expect(() => {
      h.script(
        `
                    abstract property currency_fallback {
                        default := 'EUR';
                    };
                `
      );
    }).toThrow(new RegExp("'default' is not a valid field for an abstract property"));
  });

  it("test_edgeql_ddl_function_01", () => {
    h.script(
      `
            CREATE FUNCTION my_lower(s: std::str) -> std::str
                USING SQL FUNCTION 'lower';
        `
    );
    expect(() => {
      h.script(
        `
                    CREATE FUNCTION my_lower(s: SET OF std::str)
                        -> std::str {
                        SET initial_value := '';
                        USING SQL FUNCTION 'count';
                    };
                `
      );
    }).toThrow(new RegExp("cannot create.*my_lower.*func"));
    h.script(
      `
            DROP FUNCTION my_lower(s: std::str);
        `
    );
    h.script(
      `
            CREATE FUNCTION my_lower(s: SET OF anytype)
                -> std::str {
                USING SQL FUNCTION 'count';
                SET initial_value := '';
            };
        `
    );
    expect(() => {
      h.script(
        `
                    CREATE FUNCTION my_lower(s: anytype) -> std::str
                        USING SQL FUNCTION 'lower';
                `
      );
    }).toThrow(new RegExp("cannot create.*my_lower.*func"));
    h.script(
      `
            DROP FUNCTION my_lower(s: anytype);
        `
    );
  });

  it("test_edgeql_ddl_function_02", () => {
    h.script(
      `
            CREATE FUNCTION my_sql_func1()
                -> std::str
                USING SQL $$
                    SELECT 'spam'::text
                $$;

            CREATE FUNCTION my_sql_func2(foo: std::str)
                -> std::str
                USING SQL $$
                    SELECT "foo"::text
                $$;

            CREATE FUNCTION my_sql_func4(VARIADIC s: std::str)
                -> std::str
                USING SQL $$
                    SELECT array_to_string(s, '-')
                $$;

            CREATE FUNCTION my_sql_func5_abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc()
                -> std::str
                USING SQL $$
                    SELECT 'my_sql_func5_abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc'::text
                $$;

            CREATE FUNCTION my_sql_func6(a: std::str='a' ++ 'b')
                -> std::str
                USING SQL $$
                    SELECT $1 || 'c'
                $$;

            CREATE FUNCTION my_sql_func7(s: array<std::int64>)
                -> std::int64
                USING SQL $$
                    SELECT sum(s)::bigint FROM UNNEST($1) AS s
                $$;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT my_sql_func1();
            `,
      ["spam"]
    );
    assertQueryResult(
      h,
      `
                SELECT my_sql_func2('foo');
            `,
      ["foo"]
    );
    assertQueryResult(
      h,
      `
                SELECT my_sql_func4('fizz', 'buzz');
            `,
      ["fizz-buzz"]
    );
    assertQueryResult(
      h,
      `
                SELECT my_sql_func5_abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc();
            `,
      ["my_sql_func5_abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc"]
    );
    assertQueryResult(
      h,
      `
                SELECT my_sql_func6();
            `,
      ["abc"]
    );
    assertQueryResult(
      h,
      `
                SELECT my_sql_func6('xy');
            `,
      ["xyc"]
    );
    assertQueryResult(
      h,
      `
                SELECT my_sql_func7([1, 2, 3, 10]);
            `,
      [16]
    );
    h.script(
      `
            DROP FUNCTION my_sql_func1();
            DROP FUNCTION my_sql_func2(foo: std::str);
            DROP FUNCTION my_sql_func4(VARIADIC s: std::str);
            DROP FUNCTION my_sql_func5_abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc();
            DROP FUNCTION my_sql_func6(a: std::str='a' ++ 'b');
            DROP FUNCTION my_sql_func7(s: array<std::int64>);
        `
    );
  });

  it("test_edgeql_ddl_function_03", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION broken_sql_func1(
                    a: std::int64=(SELECT schema::ObjectType))
                -> std::str
                USING SQL $$
                    SELECT 'spam'::text
                $$;
            `
      );
    }).toThrow(new RegExp("invalid default value"));
  });

  it("test_edgeql_ddl_function_04", () => {
    h.script(
      `
            CREATE FUNCTION my_edgeql_func1()
                -> std::str
                USING EdgeQL $$
                    SELECT 'sp' ++ 'am'
                $$;

            CREATE FUNCTION my_edgeql_func2(s: std::str)
                -> OPTIONAL schema::ObjectType
                USING EdgeQL $$
                    SELECT
                        schema::ObjectType
                    FILTER schema::ObjectType.name = s
                    LIMIT 1
                $$;

            CREATE FUNCTION my_edgeql_func3(s: std::int64)
                -> std::int64
                USING EdgeQL $$
                    SELECT s + 10
                $$;

            CREATE FUNCTION my_edgeql_func4(i: std::int64)
                -> array<std::int64>
                USING EdgeQL $$
                    SELECT [i, 1, 2, 3]
                $$;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT my_edgeql_func1();
            `,
      ["spam"]
    );
    assertQueryResult(
      h,
      `
                SELECT my_edgeql_func2('schema::Object').name;
            `,
      ["schema::Object"]
    );
    assertQueryResult(
      h,
      `
                SELECT (SELECT my_edgeql_func2('schema::Object')).name;
            `,
      ["schema::Object"]
    );
    assertQueryResult(
      h,
      `
                SELECT my_edgeql_func3(1);
            `,
      [11]
    );
    assertQueryResult(
      h,
      `
                SELECT my_edgeql_func4(42);
            `,
      [
            [42, 1, 2, 3],
          ]
    );
    h.script(
      `
            DROP FUNCTION my_edgeql_func1();
            DROP FUNCTION my_edgeql_func2(s: std::str);
            DROP FUNCTION my_edgeql_func3(s: std::int64);
            DROP FUNCTION my_edgeql_func4(i: std::int64);
        `
    );
  });

  it("test_edgeql_ddl_function_05", () => {
    h.script(
      `
            CREATE FUNCTION attr_func_1() -> std::str {
                CREATE ANNOTATION description := 'hello';
                USING EdgeQL "SELECT '1'";
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Function {
                    annotations: {
                        @value
                    } FILTER .name = 'std::description'
                } FILTER .name = 'default::attr_func_1';
            `,
      [
            {
              "annotations": [
                {
                  "@value": "hello",
                },
              ],
            },
          ]
    );
    h.script(
      `
            DROP FUNCTION attr_func_1();
        `
    );
  });

  it("test_edgeql_ddl_function_06", () => {
    h.script(
      `
            CREATE FUNCTION int_func_1() -> std::int64 {
                USING EdgeQL "SELECT 1";
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT int_func_1();
            `,
      [1]
    );
  });

  it("test_edgeql_ddl_function_07", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION my_agg(
                        s: anytype = [1]) -> array<anytype>
                    USING SQL FUNCTION "my_agg";
            `
      );
    }).toThrow(new RegExp("cannot create.*my_agg.*function:.+anytype.+cannot have a non-empty default"));
  });

  it("test_edgeql_ddl_function_08", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_08(s: std::str = 1) -> std::str
                    USING EdgeQL $$ SELECT "1" $$;
            `
      );
    }).toThrow(new RegExp("invalid declaration.*unexpected type of the default"));
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_08(s: std::str = ()) -> std::str
                    USING EdgeQL $$ SELECT "1" $$;
            `
      );
    }).toThrow(new RegExp("invalid declaration.*unexpected type of the default"));
  });

  it("test_edgeql_ddl_function_09", () => {
    h.script(
      `
            CREATE FUNCTION ddlf_09(
                NAMED ONLY a: int64,
                NAMED ONLY b: int64
            ) -> std::str
                USING EdgeQL $$ SELECT "1" $$;
        `
    );
    expect(() => {
      h.script(
        `
                    CREATE FUNCTION ddlf_09(
                        NAMED ONLY b: int64,
                        NAMED ONLY a: int64 = 1
                    ) -> std::str
                        USING EdgeQL $$ SELECT "1" $$;
                `
      );
    }).toThrow(new RegExp("already defined"));
    h.script(
      `
            CREATE FUNCTION ddlf_09(
                NAMED ONLY b: str,
                NAMED ONLY a: int64
            ) -> std::str
                USING EdgeQL $$ SELECT "2" $$;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT ddlf_09(a:=1, b:=1);
            `,
      ["1"]
    );
    assertQueryResult(
      h,
      `
                SELECT ddlf_09(a:=1, b:='a');
            `,
      ["2"]
    );
  });

  it("test_edgeql_ddl_function_10", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_10(
                    sum: int64
                ) -> int64
                    USING (
                        SELECT <int64>sum(sum)
                    );
            `
      );
    }).toThrow(new RegExp("parameter `sum` is not callable"));
  });

  it("test_edgeql_ddl_function_11", () => {
    h.script(
      `
            CREATE FUNCTION ddlf_11_1() -> str
                USING EdgeQL $$
                    SELECT '\u0062'
                $$;

            CREATE FUNCTION ddlf_11_2() -> str
                USING EdgeQL $$
                    SELECT r'\u0062'
                $$;

            CREATE FUNCTION ddlf_11_3() -> str
                USING EdgeQL $$
                    SELECT $a$\u0062$a$
                $$;
        `
    );
    try {
      assertQueryResult(
        h,
        `
                    SELECT ddlf_11_1();
                `,
        ["b"]
      );
      assertQueryResult(
        h,
        `
                    SELECT ddlf_11_2();
                `,
        ["\\u0062"]
      );
      assertQueryResult(
        h,
        `
                    SELECT ddlf_11_3();
                `,
        ["\\u0062"]
      );
    } finally {
      h.script(
        `
                DROP FUNCTION ddlf_11_1();
                DROP FUNCTION ddlf_11_2();
                DROP FUNCTION ddlf_11_3();
            `
      );
    }
  });

  it("test_edgeql_ddl_function_12", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_12(a: int64) -> int64
                    USING EdgeQL $$ SELECT 11 $$;

                CREATE FUNCTION ddlf_12(a: int64) -> float64
                    USING EdgeQL $$ SELECT 11 $$;
            `
      );
    }).toThrow(new RegExp("cannot create.*ddlf_12\\(a: std::int64\\).*function with the same signature is already defined"));
  });

  it("test_edgeql_ddl_function_13", () => {
    expect(() => {
      h.script(
        `
                    CREATE FUNCTION ddlf_13(a: SET OF int64) -> int64
                        USING EdgeQL $$ SELECT 11 $$;
                `
      );
    }).toThrow(new RegExp("cannot create.*ddlf_13\\(a: SET OF std::int64\\).*SET OF parameters in user-defined EdgeQL functions are not supported"));
    expect(() => {
      h.script(
        `
                DROP FUNCTION ddlf_13(a: SET OF int64);
            `
      );
    }).toThrow();
  });

  it("test_edgeql_ddl_function_14", () => {
    h.script(
      `
            CREATE FUNCTION ddlf_14(
                    a: int64, NAMED ONLY f: int64) -> int64
                USING EdgeQL $$ SELECT 11 $$;

            CREATE FUNCTION ddlf_14(
                    a: int32, NAMED ONLY f: str) -> int64
                USING EdgeQL $$ SELECT 12 $$;
        `
    );
    try {
      assertQueryResult(
        h,
        `
                    SELECT ddlf_14(<int64>10, f := 11);
                `,
        [11]
      );
      assertQueryResult(
        h,
        `
                    SELECT ddlf_14(<int32>10, f := '11');
                `,
        [12]
      );
    } finally {
      h.script(
        `
                DROP FUNCTION ddlf_14(a: int64, NAMED ONLY f: int64);
                DROP FUNCTION ddlf_14(a: int32, NAMED ONLY f: str);
            `
      );
    }
  });

  it("test_edgeql_ddl_function_15", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_15(
                        a: int64, NAMED ONLY f: int64) -> int64
                    USING EdgeQL $$ SELECT 11 $$;

                CREATE FUNCTION ddlf_15(
                        a: int32, NAMED ONLY h: str) -> int64
                    USING EdgeQL $$ SELECT 12 $$;
            `
      );
    }).toThrow(new RegExp("cannot create.*ddlf_15.*NAMED ONLY h:.*different named only parameters"));
  });

  it("test_edgeql_ddl_function_16", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_16(
                        a: anytype, b: int64) -> OPTIONAL int64
                    USING EdgeQL $$ SELECT 11 $$;

                CREATE FUNCTION ddlf_16(a: anytype, b: float64) -> str
                    USING EdgeQL $$ SELECT '12' $$;
            `
      );
    }).toThrow(new RegExp("cannot create the polymorphic.*ddlf_16.*function with different return type"));
  });

  it("test_edgeql_ddl_function_17", () => {
    h.script(
      `
            CREATE FUNCTION ddlf_17(str: std::str) -> int32
                USING SQL FUNCTION 'char_length';
        `
    );
    expect(() => {
      h.script(
        `
                    CREATE FUNCTION ddlf_17(str: std::int64) -> int32
                        USING SQL FUNCTION 'whatever2';
                `
      );
    }).toThrow(new RegExp("cannot create.*ddlf_17.*overloading \"USING SQL FUNCTION\""));
    h.script(
      `
            DROP FUNCTION ddlf_17(str: std::str);
        `
    );
  });

  it("test_edgeql_ddl_function_18", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_18(str: std::str) -> anytype
                    USING EdgeQL $$ SELECT 1 $$;
            `
      );
    }).toThrow(new RegExp("cannot create.*ddlf_18.*function returns a generic type but has no generic parameters"));
  });

  it("test_edgeql_ddl_function_19", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_19(f: std::anytype) -> int64
                    USING EdgeQL $$ SELECT 1 $$;
            `
      );
    }).toThrow(new RegExp("type 'std::anytype' does not exist"));
  });

  it("test_edgeql_ddl_function_20", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_20(f: int64) -> int64
                    USING EdgeQL $$ SELECT 1; SELECT f; $$;
            `
      );
    }).toThrow(new RegExp("Unexpected ';'"));
  });

  it("test_edgeql_ddl_function_22", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION broken_edgeql_func22(
                    a: std::str) -> std::int64
                USING EdgeQL $$
                    SELECT a
                $$;
            `
      );
    }).toThrow(new RegExp("return type mismatch.*scalar type 'std::int64'"));
  });

  it("test_edgeql_ddl_function_23", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION broken_edgeql_func23(
                    a: std::str) -> std::int64
                USING EdgeQL $$
                    SELECT [a]
                $$;
            `
      );
    }).toThrow(new RegExp("return type mismatch.*scalar type 'std::int64'"));
  });

  it("test_edgeql_ddl_function_24", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION broken_edgeql_func24(
                    a: std::str) -> std::str
                USING EdgeQL $$
                    SELECT [a]
                $$;
            `
      );
    }).toThrow(new RegExp("return type mismatch.*scalar type 'std::str'"));
  });

  it("test_edgeql_ddl_function_25", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION broken_edgeql_func25(
                    a: std::str) -> std::str
                USING EdgeQL $$
                    SELECT {a, a}
                $$;
            `
      );
    }).toThrow(new RegExp("return cardinality mismatch"));
  });

  it("test_edgeql_ddl_function_26", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION foo26;

            CREATE FUNCTION edgeql_func26(a: std::str) -> std::str {
                USING EdgeQL $$
                    SELECT a ++ 'aaa'
                $$;
                # volatility must be case insensitive
                SET volatility := 'Volatile';
            };

            ALTER FUNCTION edgeql_func26(a: std::str) {
                CREATE ANNOTATION foo26 := 'aaaa';
            };

            ALTER FUNCTION edgeql_func26(a: std::str) {
                # volatility must be case insensitive
                SET volatility := 'immutable';
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT edgeql_func26('b')
            `,
      ["baaa"]
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Function {
                    name,
                    annotations: {
                        name,
                        @value,
                    },
                    vol := <str>.volatility,
                }
                FILTER
                    .name = 'default::edgeql_func26';
            `,
      [
            {
              "name": "default::edgeql_func26",
              "annotations": [
                {
                  "name": "default::foo26",
                  "@value": "aaaa",
                },
              ],
              "vol": "Immutable",
            },
          ]
    );
    h.script(
      `
            ALTER FUNCTION edgeql_func26(a: std::str) {
                DROP ANNOTATION foo26;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Function {
                    name,
                    annotations: {
                        name,
                        @value,
                    },
                }
                FILTER
                    .name = 'default::edgeql_func26';
            `,
      [
            {
              "name": "default::edgeql_func26",
              "annotations": [],
            },
          ]
    );
    h.script(
      `
            ALTER FUNCTION edgeql_func26(a: std::str) {
                USING (
                    SELECT a ++ 'bbb'
                )
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT edgeql_func26('b')
            `,
      ["bbbb"]
    );
    h.script(
      `
            ALTER FUNCTION edgeql_func26(a: std::str) {
                USING EdgeQL $$
                    SELECT a ++ 'zzz'
                $$
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT edgeql_func26('b')
            `,
      ["bzzz"]
    );
  });

  it("test_edgeql_ddl_function_27", () => {
    h.script(
      `
            CREATE FUNCTION constant_int() -> std::int64 {
                USING (SELECT 1_024);
            };
            CREATE FUNCTION constant_bigint() -> std::bigint {
                USING (SELECT 1_024n);
            };
            CREATE FUNCTION constant_float() -> std::float64 {
                USING (SELECT 1_024.1_250);
            };
            CREATE FUNCTION constant_decimal() -> std::decimal {
                USING (SELECT 1_024.1_024n);
            };
        `
    );
    try {
      assertQueryResult(
        h,
        `
                    SELECT (
                        int := constant_int(),
                        bigint := constant_bigint(),
                        float := constant_float(),
                        decimal := constant_decimal(),
                    )
                `,
        [
              {
                "int": 1024,
                "bigint": 1024,
                "float": 1024.125,
                "decimal": 1024.1024,
              },
            ]
      );
    } finally {
      h.script(
        `
                DROP FUNCTION constant_int();
                DROP FUNCTION constant_float();
                DROP FUNCTION constant_bigint();
                DROP FUNCTION constant_decimal();
            `
      );
    }
  });

  it("test_edgeql_ddl_function_28", () => {
    expect(() => {
      h.script(
        `                CREATE TYPE foo;
                CREATE FUNCTION foo() -> str USING ('a');
            `
      );
    }).toThrow(new RegExp("'default::foo' already exists"));
  });

  it("test_edgeql_ddl_function_29", () => {
    expect(() => {
      h.script(
        `                CREATE FUNCTION foo() -> str USING ('a');
                CREATE TYPE foo;
            `
      );
    }).toThrow(new RegExp("'default::foo\\(\\)' already exists"));
  });

  it("test_edgeql_ddl_function_30", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION ddlf_30(str: std::str) -> int64
                    USING SQL FUNCTION 'char_length';
            `
      );
    }).toThrow(new RegExp("declared to return SQL type \"int8\", but the underlying SQL function returns \"integer\""));
  });

  it("test_edgeql_ddl_function_31", () => {
    h.script(
      `
            CREATE FUNCTION foo() -> str USING ('a');
        `
    );
    expect(() => {
      h.script(
        `
                ALTER FUNCTION foo() USING (1);
            `
      );
    }).toThrow(new RegExp("return type mismatch"));
  });

  it("test_edgeql_ddl_function_32", () => {
    h.script(
      `
            CREATE TYPE Foo;
            CREATE TYPE Bar;
            INSERT Foo;
            INSERT Bar;
        `
    );
    h.script(
      `
            CREATE FUNCTION func32_ok(obj: Foo, a: int64) -> str
                USING ('Foo int64');
            CREATE FUNCTION func32_ok(obj: Bar, a: int64) -> str
                USING ('Bar int64');
            CREATE FUNCTION func32_ok(s: str, a: int64) -> str
                USING ('str int64');
            CREATE FUNCTION func32_ok(s: str, a: Foo) -> str
                USING ('str Foo');
            CREATE FUNCTION func32_ok(s: str, a: Bar) -> str
                USING ('str Bar');
            CREATE FUNCTION func32_ok(s: str, a: str, b: str) -> str
                USING ('str str str');
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    Foo := assert_single(Foo),
                    Bar := assert_single(Bar),
                SELECT {
                    Foo_int64 := func32_ok(Foo, 1),
                    Bar_int64 := func32_ok(Bar, 1),
                    str_int64 := func32_ok("a", 1),
                    str_Foo := func32_ok("a", Foo),
                    str_Bar := func32_ok("a", Bar),
                    str_str_str := func32_ok("a", "b", "c"),
                }
            `,
      [
            {
              "Foo_int64": "Foo int64",
              "Bar_int64": "Bar int64",
              "str_int64": "str int64",
              "str_Foo": "str Foo",
              "str_Bar": "str Bar",
              "str_str_str": "str str str",
            },
          ]
    );
    expect(() => {
      h.script(
        `
                CREATE FUNCTION func32_a(obj: Foo, a: int32) -> str
                    USING ('foo');
                CREATE FUNCTION func32_a(obj: Bar, a: int64) -> str
                    USING ('bar');
            `
      );
    }).toThrow(new RegExp("cannot create the .* function: overloading an object type-receiving function with differences in the remaining parameters is not supported"));
    expect(() => {
      h.script(
        `
                CREATE FUNCTION func32_a(obj: Foo, obj2: Bar) -> str
                    USING ('foo');
                CREATE FUNCTION func32_a(obj: Bar, obj2: Foo) -> str
                    USING ('bar');
            `
      );
    }).toThrow(new RegExp("cannot create the .* function: overloading an object type-receiving function with differences in the remaining parameters is not supported"));
    expect(() => {
      h.script(
        `
                CREATE FUNCTION func32_a(obj: Foo, a: int32, b: int64) -> str
                    USING ('foo');
                CREATE FUNCTION func32_a(obj: Bar, a: int32) -> str
                    USING ('bar');
            `
      );
    }).toThrow(new RegExp("cannot create the .* function: overloading an object type-receiving function with differences in the remaining parameters is not supported"));
    expect(() => {
      h.script(
        `
                CREATE FUNCTION func32_a(obj: Foo, a: int32) -> str
                    USING ('foo');
                CREATE FUNCTION func32_a(obj: Bar, b: int32) -> str
                    USING ('bar');
            `
      );
    }).toThrow(new RegExp("cannot create the .* function: overloading an object type-receiving function with differences in the names of parameters is not supported"));
    expect(() => {
      h.script(
        `
                CREATE FUNCTION func32_a(obj: Foo, a: int32) -> str
                    USING ('foo');
                CREATE FUNCTION func32_a(obj: Bar, a: OPTIONAL int32) -> str
                    USING ('bar');
            `
      );
    }).toThrow(new RegExp("cannot create the .* function: overloading an object type-receiving function with differences in the type modifiers of parameters is not supported"));
    expect(() => {
      h.script(
        `
                CREATE FUNCTION func32_a(obj: OPTIONAL Foo) -> str
                    USING ('foo');
                CREATE FUNCTION func32_a(obj: OPTIONAL Bar) -> str
                    USING ('bar');
            `
      );
    }).toThrow(new RegExp("cannot create the .* function: object type-receiving functions may not be overloaded on an OPTIONAL parameter"));
  });

  it("test_edgeql_ddl_function_33", () => {
    h.script(
      `
            CREATE TYPE Parent;
            CREATE TYPE Foo EXTENDING Parent;
            CREATE TYPE Bar EXTENDING Parent;
            INSERT Foo;
            INSERT Bar;
            CREATE FUNCTION func33(obj: Parent) -> str USING ('parent');
            CREATE FUNCTION func33(obj: Foo) -> str USING ('foo');
            CREATE FUNCTION func33(obj: Bar) -> str USING ('bar');
        `
    );
    assertQueryResult(
      h,
      `
                SELECT {
                    foo := assert_single(func33(Foo)),
                    bar := assert_single(func33(Bar)),
                }
            `,
      [
            {
              "foo": "foo",
              "bar": "bar",
            },
          ]
    );
    h.script(
      `
            CREATE TYPE Baz EXTENDING Parent;
            INSERT Baz;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT {
                    baz := assert_single(func33(Baz)),
                }
            `,
      [
            {
              "baz": "parent",
            },
          ]
    );
    h.script(
      `
            CREATE FUNCTION func33(obj: Baz) -> str USING ('baz');
        `
    );
    assertQueryResult(
      h,
      `
                SELECT {
                    baz := assert_single(func33(Baz)),
                }
            `,
      [
            {
              "baz": "baz",
            },
          ]
    );
    h.script(
      `
            DROP FUNCTION func33(obj: Baz);
        `
    );
    assertQueryResult(
      h,
      `
                SELECT {
                    foo := assert_single(func33(Foo)),
                    bar := assert_single(func33(Bar)),
                    baz := assert_single(func33(Baz)),
                }
            `,
      [
            {
              "foo": "foo",
              "bar": "bar",
              "baz": "parent",
            },
          ]
    );
    h.script(
      `
            CREATE TYPE PriorityParent;
            ALTER TYPE Baz EXTENDING PriorityParent FIRST;
            CREATE FUNCTION func33(obj: PriorityParent) -> str
                USING ('priority parent');
        `
    );
    assertQueryResult(
      h,
      `
                SELECT {
                    foo := assert_single(func33(Foo)),
                    bar := assert_single(func33(Bar)),
                    baz := assert_single(func33(Baz)),
                }
            `,
      [
            {
              "foo": "foo",
              "bar": "bar",
              "baz": "priority parent",
            },
          ]
    );
    h.script(
      `
                CREATE FUNCTION func33_no(NAMED ONLY obj: Parent) -> str
                    USING ('parent');
                CREATE FUNCTION func33_no(NAMED ONLY obj: Foo) -> str
                    USING ('foo');
                CREATE FUNCTION func33_no(NAMED ONLY obj: Bar) -> str
                    USING ('bar');
            `
    );
    assertQueryResult(
      h,
      `
                SELECT {
                    foo := assert_single(func33_no(obj := Foo)),
                    bar := assert_single(func33_no(obj := Bar)),
                    baz := assert_single(func33_no(obj := Baz)),
                }
            `,
      [
            {
              "foo": "foo",
              "bar": "bar",
              "baz": "parent",
            },
          ]
    );
  });

  it("test_edgeql_ddl_function_34", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION broken_edgeql_func25(
                    a: std::int64) -> std::int64
                USING EdgeQL $$
                    SELECT a FILTER a > 0
                $$;
            `
      );
    }).toThrow(new RegExp("return cardinality mismatch"));
  });

  it("test_edgeql_ddl_function_35", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION broken_edgeql_func35(
                    a: optional std::int64) -> std::int64
                USING EdgeQL $$
                    SELECT a
                $$;
            `
      );
    }).toThrow(new RegExp("return cardinality mismatch"));
  });

  it("test_edgeql_ddl_function_36", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION broken_edgeql_func36(
                    variadic foo: optional std::int64) -> array<std::int64>
                USING (assert_exists(foo));
            `
      );
    }).toThrow(new RegExp("cannot create the `default::broken_edgeql_func36\\(VARIADIC foo: OPTIONAL array<std::int64>\\)` function: variadic argument `foo` illegally declared with optional type in user-defined function"));
  });

  it("test_edgeql_ddl_function_37", () => {
    let obj = h.query("\n            create type X;\n            create function getUser(id: uuid) -> set of X {\n                using(\n                    select X filter .id = id\n                )\n            };\n            insert X;\n            insert X;\n        ");
    let val = h.query("\n                select count(getUser(<uuid>$0))\n            ");
    expect(val).toEqual(1);
  });

  it("test_edgeql_ddl_function_38", () => {
    h.script(
      `
            create function myFuncFailA(character: int64) -> float64
            using (
              select 2.3
            );
            create function myFuncFailB(interval: str) -> float64
            using (
              select 2.3
            );
        `
    );
  });

  it("test_edgeql_ddl_function_39", () => {
    h.script(
      `
            create function get_singleton(
                a: array<range<int64>>
            ) -> array<range<int64>> using(
                a[:1]
            );
        `
    );
    assertQueryResult(
      h,
      `
                select get_singleton([range(1, 3), range(1, 2)]) =
                    [range(1, 3)];
            `,
      [true]
    );
  });

  it("test_edgeql_ddl_function_40", () => {
    h.script(
      `
            create type Bar;
            create type Bar2 extending Bar;
            create function foo(x: Bar) -> int64 {
                using (1);
            };
        `
    );
    expect(() => {
      h.script(
        `
                create function foo(x: Bar2) -> int64 {
                    set volatility := schema::Volatility.Modifying;
                    using (1);
                };
            `
      );
    }).toThrow(new RegExp("cannot overload an existing function with a modifying function"));
  });

  it("test_edgeql_ddl_function_41", () => {
    h.script(
      `
            create type Bar;
            create type Bar2 extending Bar;
            create function foo(x: Bar) -> int64 {
                set volatility := schema::Volatility.Modifying;
                using (1);
            };
        `
    );
    expect(() => {
      h.script(
        `
                create function foo(x: Bar2) -> int64 {
                    using (1);
                };
            `
      );
    }).toThrow(new RegExp("cannot overload an existing modifying function"));
  });

  it("test_edgeql_ddl_function_42", () => {
    h.script(
      `
            create abstract type Named {
                create required property name: str;
            };
            create function all_names() -> SET OF str {
                USING (Named.name)
            };
            create type Z extending Named {
                create access policy ok allow all;
            };
            create type T;
        `
    );
    h.script(
      `
            drop type Z;
        `
    );
  });

  it("test_edgeql_ddl_function_43", () => {
    h.script(
      `
            create future warn_old_scoping;
            create type T;
            create function all_objects() -> SET OF T USING (T);
        `
    );
  });

  it("test_edgeql_ddl_function_inh_01", () => {
    h.script(
      `
            create abstract type T;
            create function countall() -> int64 USING (count(T));
        `
    );
    assertQueryResult(
      h,
      `SELECT countall()`,
      [0]
    );
    h.script(
      `
            create type S1 extending T;
            insert S1;
        `
    );
    assertQueryResult(
      h,
      `SELECT countall()`,
      [1]
    );
    h.script(
      `
            create type S2 extending T;
            insert S2;
            insert S2;
        `
    );
    assertQueryResult(
      h,
      `SELECT countall()`,
      [3]
    );
    h.script(
      `
            drop type S2;
        `
    );
    assertQueryResult(
      h,
      `SELECT countall()`,
      [1]
    );
  });

  it("test_edgeql_ddl_function_inh_02", () => {
    h.script(
      `
            create abstract type T { create multi property n -> int64 };
            create function countall() -> int64 USING (sum(T.n));
        `
    );
    assertQueryResult(
      h,
      `SELECT countall()`,
      [0]
    );
    h.script(
      `
            create type S1 extending T;
            insert S1 { n := {3, 4} };
        `
    );
    assertQueryResult(
      h,
      `SELECT countall()`,
      [7]
    );
    h.script(
      `
            create type S2 extending T;
            insert S2 { n := 1 };
            insert S2 { n := {2, 2, 2} };
        `
    );
    assertQueryResult(
      h,
      `SELECT countall()`,
      [14]
    );
    h.script(
      `
            drop type S2;
        `
    );
    assertQueryResult(
      h,
      `SELECT countall()`,
      [7]
    );
  });

  it("test_edgeql_ddl_function_rename_01", () => {
    h.script(
      `
            CREATE FUNCTION foo(s: str) -> str {
                USING (SELECT s)
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT foo("a")`,
      ["a"]
    );
    h.script(
      `
            ALTER FUNCTION foo(s: str)
            RENAME TO bar;
        `
    );
    assertQueryResult(
      h,
      `SELECT bar("a")`,
      ["a"]
    );
    h.script(
      `
            DROP FUNCTION bar(s: str)
        `
    );
  });

  it("test_edgeql_ddl_function_rename_02", () => {
    h.script(
      `
            CREATE FUNCTION foo(s: str) -> str {
                USING (SELECT s)
            };

            CREATE FUNCTION bar(s: int64) -> str {
                USING (SELECT <str>s)
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER FUNCTION bar(s: int64)
                RENAME TO foo;
            `
      );
    }).toThrow(new RegExp("can not rename function to 'default::foo' because a function with the same name already exists"));
  });

  it("test_edgeql_ddl_function_rename_03", () => {
    h.script(
      `
            CREATE FUNCTION foo(s: str) -> str {
                USING (SELECT s)
            };

            CREATE FUNCTION foo(s: int64) -> str {
                USING (SELECT <str>s)
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER FUNCTION foo(s: int64)
                RENAME TO bar;
            `
      );
    }).toThrow(new RegExp("renaming an overloaded function is not allowed"));
  });

  it("test_edgeql_ddl_function_rename_04", () => {
    h.script(
      `
            CREATE FUNCTION foo(s: str) -> str {
                USING (SELECT s)
            };
            CREATE MODULE foo;
        `
    );
    assertQueryResult(
      h,
      `SELECT foo("a")`,
      ["a"]
    );
    h.script(
      `
            ALTER FUNCTION foo(s: str)
            RENAME TO foo::bar;
        `
    );
    assertQueryResult(
      h,
      `SELECT foo::bar("a")`,
      ["a"]
    );
    h.script(
      `
            DROP FUNCTION foo::bar(s: str)
        `
    );
  });

  it("test_edgeql_ddl_function_rename_05", () => {
    h.script(
      `
            CREATE FUNCTION foo(s: str) -> str {
                USING (SELECT s)
            };
            CREATE FUNCTION call(s: str) -> str {
                USING (SELECT foo(s))
            };
        `
    );
    h.script(
      `
            ALTER FUNCTION foo(s: str) RENAME TO bar;
        `
    );
    assertQueryResult(
      h,
      `SELECT call("a")`,
      ["a"]
    );
  });

  it("test_edgeql_ddl_function_rename_06", () => {
    h.script(
      `
            CREATE FUNCTION foo(s: str) -> str {
                USING (SELECT s)
            };
            CREATE FUNCTION call(s: str) -> str {
                USING (SELECT foo(s))
            };
        `
    );
    h.script(
      `
            CREATE MODULE foo;
            ALTER FUNCTION foo(s: str) RENAME TO foo::foo;
        `
    );
    assertQueryResult(
      h,
      `SELECT call("a")`,
      ["a"]
    );
  });

  it("test_edgeql_ddl_function_volatility_01", () => {
    h.script(
      `
            CREATE FUNCTION foo() -> int64 {
                USING (SELECT 1)
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function { volatility }
            FILTER .name = 'default::foo';
            `,
      [
            {
              "volatility": "Immutable",
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT (foo(), {1,2})`,
      [
            [1, 1],
            [1, 2],
          ]
    );
  });

  it("test_edgeql_ddl_function_volatility_02", () => {
    h.script(
      `
            CREATE FUNCTION foo() -> int64 {
                USING (SELECT <int64>random())
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function {volatility}
            FILTER .name = 'default::foo';
            `,
      [
            {
              "volatility": "Volatile",
            },
          ]
    );
    expect(() => {
      h.query(
        `SELECT (foo(), {1,2})`
      );
    }).toThrow(new RegExp("can not take cross product of volatile operation"));
  });

  it("test_edgeql_ddl_function_volatility_03", () => {
    h.script(
      `
            CREATE FUNCTION foo() -> int64 {
                USING (SELECT 1);
                SET volatility := "volatile";
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function {volatility}
            FILTER .name = 'default::foo';
            `,
      [
            {
              "volatility": "Volatile",
            },
          ]
    );
    expect(() => {
      h.query(
        `SELECT (foo(), {1,2})`
      );
    }).toThrow(new RegExp("can not take cross product of volatile operation"));
  });

  it("test_edgeql_ddl_function_volatility_04", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION foo() -> int64 {
                    USING (SELECT <int64>random());
                    SET volatility := "stable";
                }
            `
      );
    }).toThrow(new RegExp("(?s)volatility mismatch in function declared as stable"));
  });

  it("test_edgeql_ddl_function_volatility_05", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION foo() -> int64 {
                    USING (SELECT count(Object));
                    SET volatility := "immutable";
                }
            `
      );
    }).toThrow(new RegExp("(?s)volatility mismatch in function declared as immutable"));
  });

  it("test_edgeql_ddl_function_volatility_06", () => {
    h.script(
      `
            CREATE FUNCTION foo() -> float64 {
                USING (1);
            };
            CREATE FUNCTION bar() -> float64 {
                USING (foo());
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function {name, volatility}
            FILTER .name LIKE 'default::%'
            ORDER BY .name;
            `,
      [
            {
              "name": "default::bar",
              "volatility": "Immutable",
            },
            {
              "name": "default::foo",
              "volatility": "Immutable",
            },
          ]
    );
    h.script(
      `
            ALTER FUNCTION foo() SET volatility := "stable";
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function {name, volatility, computed_fields}
            FILTER .name LIKE 'default::%'
            ORDER BY .name;
            `,
      [
            {
              "name": "default::bar",
              "volatility": "Stable",
              "computed_fields": ["volatility"],
            },
            {
              "name": "default::foo",
              "volatility": "Stable",
              "computed_fields": [],
            },
          ]
    );
    h.script(
      `
            ALTER FUNCTION foo() {
                RESET volatility;
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function {name, volatility, computed_fields}
            FILTER .name LIKE 'default::%'
            ORDER BY .name;
            `,
      [
            {
              "name": "default::bar",
              "volatility": "Immutable",
              "computed_fields": ["volatility"],
            },
            {
              "name": "default::foo",
              "volatility": "Immutable",
              "computed_fields": ["volatility"],
            },
          ]
    );
    h.script(
      `
            ALTER FUNCTION foo() {
                RESET volatility;
                USING (random());
            }
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function {name, volatility}
            FILTER .name LIKE 'default::%'
            ORDER BY .name;
            `,
      [
            {
              "name": "default::bar",
              "volatility": "Volatile",
            },
            {
              "name": "default::foo",
              "volatility": "Volatile",
            },
          ]
    );
  });

  it("test_edgeql_ddl_function_volatility_07", () => {
    h.script(
      `
            CREATE FUNCTION foo() -> float64 {
                USING (1);
            };
            CREATE FUNCTION bar() -> float64 {
                USING (foo());
            };
            CREATE FUNCTION baz() -> float64 {
                USING (bar());
            };
        `
    );
    h.script(
      `
            ALTER FUNCTION foo() SET volatility := "stable";
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function {name, volatility}
            FILTER .name LIKE 'default::%'
            ORDER BY .name;
            `,
      [
            {
              "name": "default::bar",
              "volatility": "Stable",
            },
            {
              "name": "default::baz",
              "volatility": "Stable",
            },
            {
              "name": "default::foo",
              "volatility": "Stable",
            },
          ]
    );
  });

  it("test_edgeql_ddl_function_volatility_08", () => {
    h.script(
      `
            CREATE FUNCTION foo() -> float64 {
                USING (1);
            };
            CREATE FUNCTION bar() -> float64 {
                SET volatility := "stable";
                USING (foo());
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER FUNCTION foo() SET volatility := "volatile";
            `
      );
    }).toThrow(new RegExp("cannot alter function 'default::foo\\(\\)' because this affects .*function 'default::bar\\(\\)'"));
  });

  it("test_edgeql_ddl_function_volatility_09", () => {
    h.script(
      `
            CREATE TYPE FuncVol { CREATE REQUIRED PROPERTY i -> int64 };
            CREATE FUNCTION obj_func(obj: FuncVol) -> int64 {
                USING (obj.i)
            };
            CREATE FUNCTION obj_func_tuple(
                obj: tuple<array<FuncVol>>
            ) -> SET OF int64 {
                USING (array_unpack(obj.0).i)
            };
            CREATE FUNCTION obj_func_tuple_not_referring(
                arg: tuple<array<FuncVol>, int64>
            ) -> int64 {
                USING (arg.1)
            };
            CREATE FUNCTION obj_func_const(obj: FuncVol) -> int64 {
                USING (1)
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::Function { name, volatility }
            FILTER .name LIKE 'default::obj_func%'
            ORDER BY .name;
            `,
      [
            {
              "name": "default::obj_func",
              "volatility": "Stable",
            },
            {
              "name": "default::obj_func_const",
              "volatility": "Immutable",
            },
            {
              "name": "default::obj_func_tuple",
              "volatility": "Stable",
            },
            {
              "name": "default::obj_func_tuple_not_referring",
              "volatility": "Immutable",
            },
          ]
    );
  });

  it("test_edgeql_ddl_function_fallback_01", () => {
    expect(() => {
      h.script(
        `
                CREATE FUNCTION foo(a: int64) -> str {
                    USING (SELECT 'foo' ++ <str>(a + 1));
                };
                CREATE FUNCTION foo(a: bytes) -> str {
                    USING (SELECT 'foobytes' ++ <str>len(a));
                };
                CREATE FUNCTION foo(a: array<anytype>) -> str {
                    SET fallback := True;
                    USING (SELECT 'fooarray' ++ <str>len(a));
                };
                CREATE FUNCTION foo(a: anytype) -> str {
                    SET fallback := True;
                    USING (SELECT 'foo' ++ <str>a);
                };
            `
      );
    }).toThrow(new RegExp("cannot create.*foo\\(a: anytype\\).*only one generic fallback per polymorphic function is allowed"));
  });

  it("test_edgeql_ddl_function_fallback_02", () => {
    h.script(
      `
            CREATE FUNCTION foo(a: int64) -> str {
                USING (SELECT 'foo' ++ <str>(a + 1));
            };
            CREATE FUNCTION foo(a: bytes) -> str {
                USING (SELECT 'foobytes' ++ <str>len(a));
            };
            CREATE FUNCTION foo(a: array<anytype>) -> str {
                USING (SELECT 'fooarray' ++ <str>len(a));
            };
            CREATE FUNCTION foo(a: anytype) -> str {
                USING (SELECT 'foo' ++ <str>a);
            };
        `
    );
    h.script(
      `
            ALTER FUNCTION foo(a: array<anytype>) {
                SET fallback := true;
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER FUNCTION foo(a: anytype) {
                    SET fallback := true;
                };
            `
      );
    }).toThrow(new RegExp("cannot alter.*foo\\(a: anytype\\).*only one generic fallback per polymorphic function is allowed"));
  });

  it("test_edgeql_ddl_function_splat_01", () => {
    expect(() => {
      h.script(
        `
                    CREATE FUNCTION my_splat() -> std::json USING (
                        SELECT <json>Object { ** } LIMIT 1
                    );
                `
      );
    }).toThrow(new RegExp("splat operators in function bodies are not supported"));
  });

  it("test_edgeql_ddl_function_recompile_01", () => {
    h.script(
      `
            create alias X0 := '1';
            create alias X := X0;
            create global Y -> str { set default := '2' };
            create type Z { create property p := '3' };
            insert Z;
            create function W() -> str using ('4');
            create function V0() -> str {
                set is_inlined := true;
                using ('5')
            };
            create function V() -> str using (V0());
            create function inner() -> set of str using (
                X ++ (global Y) ++ Z.p ++ W() ++ V()
            );
            create function test() -> set of str using (inner());
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["12345"]
    );
    h.script(
      `
            alter alias X0 using ('A');
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["A2345"]
    );
    h.script(
      `
            alter global Y { set default := 'B' };
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["AB345"]
    );
    h.script(
      `
            alter type Z alter property p using ('C');
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["ABC45"]
    );
    h.script(
      `
            alter function W() {
                using ('D')
            };
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["ABCD5"]
    );
    h.script(
      `
            alter function V0() {
                using ('E')
            };
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["ABCDE"]
    );
    h.script(
      `
            alter function inner() {
                set is_inlined := true;
                using (X ++ (global Y) ++ Z.p ++ W() ++ V() ++ '!');
            };
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["ABCDE!"]
    );
  });

  it("test_edgeql_ddl_function_recompile_02", () => {
    h.script(
      `
            create alias X0 := '1';
            create alias X := X0;
            create global Y -> str { set default := '2' };
            create type Z { create property p := '3' };
            insert Z;
            create function W() -> str using ('4');
            create function V0() -> str {
                set is_inlined := true;
                using ('5')
            };
            create function V() -> str using (V0());
            create function inner() -> set of str {
                set is_inlined := true;
                using (X ++ (global Y) ++ Z.p ++ W() ++ V())
            };
            create function test() -> set of str using (inner());
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["12345"]
    );
    h.script(
      `
            alter alias X0 using ('A');
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["A2345"]
    );
    h.script(
      `
            alter global Y { set default := 'B' };
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["AB345"]
    );
    h.script(
      `
            alter type Z alter property p using ('C');
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["ABC45"]
    );
    h.script(
      `
            alter function W() {
                using ('D')
            };
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["ABCD5"]
    );
    h.script(
      `
            alter function V0() {
                using ('E')
            };
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["ABCDE"]
    );
    h.script(
      `
            alter function inner() {
                set is_inlined := false;
                using (X ++ (global Y) ++ Z.p ++ W() ++ V() ++ '!');
            };
        `
    );
    assertQueryResult(
      h,
      `select test()`,
      ["ABCDE!"]
    );
  });

  it("test_edgeql_ddl_function_recompile_03", () => {
    h.script(
      `
            create type Bar { create property a -> int64 };
            create function inner(x: int64) -> Bar using ((
                insert Bar { a := x }
            ));
            create function test(x: int64) -> Bar using (inner(x));
        `
    );
    assertQueryResult(
      h,
      `select test(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    h.script(
      `
            alter function test(x: int64) {
                using ((insert Bar { a := x + 10 }));
            };
        `
    );
    assertQueryResult(
      h,
      `select test(2).a`,
      [12]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 12])
    );
  });

  it("test_edgeql_ddl_module_01", () => {
    expect(() => {
      h.script(
        `                CREATE MODULE spam;
                CREATE MODULE spam;
            `
      );
    }).toThrow(new RegExp("'spam' already exists"));
  });

  it("test_edgeql_ddl_module_02", () => {
    h.script(
      `            CREATE MODULE spam IF NOT EXISTS;
            CREATE MODULE spam IF NOT EXISTS;

            # Just to validate that the module was indeed created,
            # make something inside it.
            CREATE TYPE spam::Test;
        `
    );
  });

  it("test_edgeql_ddl_module_03", () => {
    assertQueryResult(
      h,
      `
            select _test::abs(-1)
            `,
      [1]
    );
    h.script(
      `            CREATE MODULE _test
        `
    );
    expect(() => {
      h.script(
        `            select _test::abs(-1)
            `
      );
    }).toThrow(new RegExp("'_test::abs' does not exist"));
  });

  it("test_edgeql_ddl_module_04", () => {
    expect(() => {
      h.script(
        `                CREATE MODULE foo::bar;
            `
      );
    }).toThrow(new RegExp("module 'foo' is not in this schema"));
    h.script(
      `            CREATE MODULE foo;
            CREATE MODULE foo::bar;
            CREATE TYPE foo::Foo;
            CREATE TYPE foo::bar::Baz;
        `
    );
    assertQueryResult(
      h,
      `
            select foo::bar::Baz
            `,
      []
    );
    assertQueryResult(
      h,
      `
            with module foo::bar
            select Baz
            `,
      []
    );
    h.script(
      `            SET MODULE foo::bar;
        `
    );
    assertQueryResult(
      h,
      `
            select foo::bar::Baz
            `,
      []
    );
    assertQueryResult(
      h,
      `
            select Baz
            `,
      []
    );
    h.script(
      `            SET MODULE foo;
        `
    );
    expect(() => {
      h.script(
        `                SELECT bar::Baz
            `
      );
    }).toThrow(new RegExp("'bar::Baz' does not exist"));
    assertQueryResult(
      h,
      `
            select Foo
            `,
      []
    );
    h.script(
      `            RESET MODULE;
        `
    );
    expect(() => {
      h.script(
        `                WITH MODULE foo
                SELECT bar::Baz
            `
      );
    }).toThrow(new RegExp("'bar::Baz' does not exist"));
    assertQueryResult(
      h,
      `
            with m as module foo::bar
            select m::Baz
            `,
      []
    );
    assertQueryResult(
      h,
      `
            with m as module foo
            select m::bar::Baz
            `,
      []
    );
  });

  it("test_edgeql_ddl_module_05", () => {
    h.script(
      `            CREATE MODULE foo;
            CREATE MODULE foo::bar;
            SET MODULE foo::bar;
            CREATE TYPE Baz;
        `
    );
    assertQueryResult(
      h,
      `
            select foo::bar::Baz
            `,
      []
    );
  });

  it("test_edgeql_ddl_operator_01", () => {
    h.script(
      `
            CREATE INFIX OPERATOR \`+++\`
                (left: int64, right: int64) -> int64
            {
                SET commutator := 'default::+++';
                USING SQL OPERATOR r'+';
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Operator {
                    name,
                    params: {
                        name,
                        type: {
                            name
                        },
                        typemod
                    } ORDER BY .name,
                    operator_kind,
                    return_typemod
                }
                FILTER
                    .name = 'default::+++';
            `,
      [
            {
              "name": "default::+++",
              "params": [
                {
                  "name": "left",
                  "type": {
                    "name": "std::int64",
                  },
                  "typemod": "SingletonType",
                },
                {
                  "name": "right",
                  "type": {
                    "name": "std::int64",
                  },
                  "typemod": "SingletonType",
                },
              ],
              "operator_kind": "Infix",
              "return_typemod": "SingletonType",
            },
          ]
    );
    h.script(
      `
            ALTER INFIX OPERATOR \`+++\`
                (left: int64, right: int64)
                CREATE ANNOTATION description := 'my plus';
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Operator {
                    name,
                }
                FILTER
                    .name = 'default::+++'
                    AND any(
                        .annotations.name = 'std::description'
                        AND .annotations@value = 'my plus'
                    );
            `,
      [
            {
              "name": "default::+++",
            },
          ]
    );
    h.script(
      `
            DROP INFIX OPERATOR \`+++\` (left: int64, right: int64);
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Operator {
                    name,
                    params: {
                        name,
                        type: {
                            name
                        },
                        typemod
                    },
                    operator_kind,
                    return_typemod
                }
                FILTER
                    .name = 'default::+++';
            `,
      []
    );
  });

  it("test_edgeql_ddl_operator_02", () => {
    try {
      h.script(
        `
                CREATE PREFIX OPERATOR \`!\`
                    (operand: int64) -> int64
                {
                    USING SQL OPERATOR r'+';
                };

                CREATE INFIX OPERATOR \`!\`
                    (l: int64, r: int64) -> int64
                {
                    SET commutator := 'default::!';
                    USING SQL OPERATOR r'+';
                };
            `
      );
      assertQueryResult(
        h,
        `
                    WITH MODULE schema
                    SELECT Operator {
                        name,
                        operator_kind,
                    }
                    FILTER
                        .name = 'default::!'
                    ORDER BY
                        .operator_kind;
                `,
        [
              {
                "name": "default::!",
                "operator_kind": "Infix",
              },
              {
                "name": "default::!",
                "operator_kind": "Prefix",
              },
            ]
      );
    } finally {
      h.script(
        `
                DROP INFIX OPERATOR \`!\`
                    (l: int64, r: int64);

                DROP PREFIX OPERATOR \`!\`
                    (operand: int64);
            `
      );
    }
  });

  it("test_edgeql_ddl_operator_03", () => {
    expect(() => {
      h.script(
        `
                CREATE PREFIX OPERATOR \`NOT\`() -> bool
                    USING SQL EXPRESSION;
            `
      );
    }).toThrow(new RegExp("cannot create the `default::NOT\\(\\)` operator: an operator must have operands"));
  });

  it("test_edgeql_ddl_operator_04", () => {
    expect(() => {
      h.script(
        `
                CREATE INFIX OPERATOR
                \`=\` (l: array<anytype>, r: str) -> std::bool {
                    USING SQL EXPRESSION;
                    SET recursive := true;
                };
            `
      );
    }).toThrow(new RegExp("cannot create the `default::=\\(l: array<anytype>, r: std::str\\)` operator: operands of a recursive operator must either be all arrays or all tuples"));
  });

  it("test_edgeql_ddl_operator_05", () => {
    expect(() => {
      h.script(
        `
                CREATE INFIX OPERATOR
                \`=\` (l: array<anytype>, r: anytuple) -> std::bool {
                    USING SQL EXPRESSION;
                    SET recursive := true;
                };
            `
      );
    }).toThrow(new RegExp("cannot create the `default::=\\(l: array<anytype>, r: anytuple\\)` operator: operands of a recursive operator must either be all arrays or all tuples"));
  });

  it("test_edgeql_ddl_operator_06", () => {
    expect(() => {
      h.script(
        `
                CREATE INFIX OPERATOR
                \`=\` (l: array<anytype>, r: array<anytype>) -> std::bool {
                    SET recursive := true;
                    USING SQL EXPRESSION;
                };

                CREATE INFIX OPERATOR
                \`=\` (l: array<int64>, r: array<int64>) -> std::bool {
                    USING SQL EXPRESSION;
                };
            `
      );
    }).toThrow(new RegExp("cannot create the non-recursive `default::=\\(l: array<std::int64>, r: array<std::int64>\\)` operator: overloading a recursive operator `array<anytype> = array<anytype>` with a non-recursive one is not allowed"));
  });

  it("test_edgeql_ddl_operator_07", () => {
    expect(() => {
      h.script(
        `
                CREATE INFIX OPERATOR
                \`=\` (l: array<anytype>, r: array<anytype>)
                    -> std::bool {
                    USING SQL EXPRESSION;
                };

                CREATE INFIX OPERATOR
                \`=\` (l: array<int64>, r: array<int64>) -> std::bool {
                    USING SQL EXPRESSION;
                    SET recursive := true;
                };
            `
      );
    }).toThrow(new RegExp("cannot create the recursive `default::=\\(l: array<std::int64>, r: array<std::int64>\\)` operator: overloading a non-recursive operator `array<anytype> = array<anytype>` with a recursive one is not allowed"));
  });

  it("test_edgeql_ddl_operator_08", () => {
    try {
      h.script(
        `
                CREATE ABSTRACT INFIX OPERATOR \`>\`
                    (left: anytype, right: anytype) -> bool;
            `
      );
      assertQueryResult(
        h,
        `
                    WITH MODULE schema
                    SELECT Operator {
                        name,
                        abstract,
                    }
                    FILTER
                        .name = 'default::>'
                `,
        [
              {
                "name": "default::>",
                "abstract": true,
              },
            ]
      );
    } finally {
      h.script(
        `
                DROP INFIX OPERATOR \`>\`
                    (left: anytype, right: anytype);
            `
      );
    }
  });

  it("test_edgeql_ddl_operator_09", () => {
    expect(() => {
      h.script(
        `
                CREATE ABSTRACT INFIX OPERATOR
                \`=\` (l: array<anytype>, r: array<anytype>) -> std::bool {
                    USING SQL EXPRESSION;
                };
            `
      );
    }).toThrow(new RegExp("unexpected USING clause in abstract operator definition"));
  });

  it("test_edgeql_ddl_operator_10", () => {
    expect(() => {
      h.script(
        `
                CREATE INFIX OPERATOR
                \`IN\` (l: std::float64, r: std::float64) -> std::bool {
                    USING SQL EXPRESSION;
                    SET derivative_of := 'std::=';
                };

                CREATE INFIX OPERATOR
                \`IN\` (l: std::int64, r: std::int64) -> std::bool {
                    USING SQL EXPRESSION;
                };
            `
      );
    }).toThrow(new RegExp("cannot create the `default::IN\\(l: std::int64, r: std::int64\\)` operator: there exists a derivative operator of the same name"));
  });

  it("test_edgeql_ddl_operator_11", () => {
    expect(() => {
      h.script(
        `
                CREATE INFIX OPERATOR
                \`IN\` (l: std::float64, r: std::float64) -> std::bool {
                    USING SQL EXPRESSION;
                };

                CREATE INFIX OPERATOR
                \`IN\` (l: std::int64, r: std::int64) -> std::bool {
                    USING SQL EXPRESSION;
                    SET derivative_of := 'std::=';
                };
            `
      );
    }).toThrow(new RegExp("cannot create `default::IN\\(l: std::int64, r: std::int64\\)` as a derivative operator: there already exists an operator of the same name"));
  });

  it("test_edgeql_ddl_operator_12", () => {
    expect(() => {
      h.script(
        `
                CREATE PREFIX OPERATOR
                \`!\` (l: std::int64) -> std::int64 {
                    USING SQL FUNCTION 'factorial';
                };
            `
      );
    }).toThrow(new RegExp("operator \"! std::int64\" is declared to return SQL type \"int8\", but the underlying SQL function returns \"numeric\""));
  });

  it("test_edgeql_ddl_scalar_01", () => {
    expect(() => {
      h.script(
        `
                CREATE SCALAR TYPE myint EXTENDING std::int64, std::str;
            `
      );
    }).toThrow(new RegExp("may not have more than one concrete base type"));
  });

  it("test_edgeql_ddl_scalar_02", () => {
    h.script(
      `
            CREATE ABSTRACT SCALAR TYPE a EXTENDING std::int64;
            CREATE ABSTRACT SCALAR TYPE b EXTENDING std::str;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE SCALAR TYPE myint EXTENDING a, b;
            `
      );
    }).toThrow(new RegExp("may not have more than one concrete base type"));
  });

  it("test_edgeql_ddl_scalar_03", () => {
    h.script(
      `
            CREATE ABSTRACT SCALAR TYPE a EXTENDING std::int64;
            CREATE ABSTRACT SCALAR TYPE b EXTENDING std::str;
            CREATE SCALAR TYPE myint EXTENDING a;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE myint EXTENDING b;
            `
      );
    }).toThrow(new RegExp("scalar type may not have more than one concrete base type"));
  });

  it("test_edgeql_ddl_scalar_04", () => {
    h.script(
      `
            CREATE ABSTRACT SCALAR TYPE a;
            CREATE SCALAR TYPE myint EXTENDING int64, a;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE a EXTENDING str;
            `
      );
    }).toThrow(new RegExp("scalar type may not have more than one concrete base type"));
  });

  it("test_edgeql_ddl_scalar_05", () => {
    h.script(
      `
            CREATE ABSTRACT SCALAR TYPE a EXTENDING std::int64;
            CREATE ABSTRACT SCALAR TYPE b EXTENDING std::int64;
            CREATE SCALAR TYPE myint EXTENDING a, b;
        `
    );
  });

  it("test_edgeql_ddl_scalar_06", () => {
    h.script(
      `
            CREATE SCALAR TYPE myint EXTENDING int64;
            CREATE SCALAR TYPE myint2 EXTENDING myint;
        `
    );
  });

  it("test_edgeql_ddl_scalar_07", () => {
    h.script(
      `
            CREATE SCALAR TYPE a EXTENDING std::str;
            CREATE SCALAR TYPE b EXTENDING std::str;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE SCALAR TYPE myint EXTENDING a, b;
            `
      );
    }).toThrow(new RegExp("may not have more than one concrete base type"));
  });

  it("test_edgeql_ddl_scalar_08", () => {
    h.script(
      `

            CREATE SCALAR TYPE myint EXTENDING int64;
            CREATE TYPE Bar {
                CREATE PROPERTY b1 -> tuple<myint, tuple<myint>>;
                CREATE PROPERTY b2 -> tuple<myint, tuple<myint>>;
                CREATE MULTI PROPERTY b3 -> tuple<z: myint, y: array<myint>>;
            };
            CREATE TYPE Foo {
                CREATE PROPERTY a1 -> array<myint>;
                CREATE PROPERTY a2 -> tuple<array<myint>>;
                CREATE PROPERTY a3 -> array<tuple<array<myint>>>;
                CREATE PROPERTY a4 -> tuple<myint, str>;
                CREATE PROPERTY a5 -> tuple<myint, myint>;
                CREATE PROPERTY a6 -> tuple<myint, tuple<myint>>;
                CREATE PROPERTY a6b -> tuple<myint, tuple<myint>>;
                CREATE LINK l -> Bar {
                    CREATE PROPERTY l1 -> tuple<str, myint>;
                    CREATE PROPERTY l2 -> tuple<myint, tuple<myint>>;
                };
            };
        `
    );
    let orig_count = h.query("SELECT count(schema::CollectionType);");
    h.script(
      `
            ALTER SCALAR TYPE myint CREATE CONSTRAINT std::one_of(1, 2);
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(orig_count);
    expect(() => {
      h.script(
        `
                INSERT Foo { a4 := (10, "oops") };
            `
      );
    }).toThrow(new RegExp("myint must be one of"));
    h.script(
      `
            INSERT Foo { a3 := [([2],)] };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE myint DROP CONSTRAINT std::one_of(1, 2);
                ALTER SCALAR TYPE myint CREATE CONSTRAINT std::one_of(1);
            `
      );
    }).toThrow(new RegExp("myint must be one of:"));
  });

  it("test_edgeql_ddl_scalar_09", () => {
    h.script(
      `
            CREATE FINAL SCALAR TYPE my_enum EXTENDING enum<'foo', 'bar'>;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE FINAL SCALAR TYPE myint EXTENDING std::int64;
            `
      );
    }).toThrow(new RegExp("FINAL is not supported"));
  });

  it("test_edgeql_ddl_scalar_10", () => {
    expect(() => {
      h.script(
        `
                create scalar type Foo;
            `
      );
    }).toThrow(new RegExp("scalar type must have a concrete base type"));
  });

  it("test_edgeql_ddl_scalar_11", () => {
    h.script(
      `
            create scalar type Foo extending str;
        `
    );
    expect(() => {
      h.script(
        `
                alter scalar type Foo drop extending str;
            `
      );
    }).toThrow(new RegExp("scalar type must have a concrete base type"));
  });

  it("test_edgeql_ddl_scalar_12", () => {
    h.script(
      `
            create scalar type Foo extending str;
        `
    );
    expect(() => {
      h.script(
        `
                alter scalar type Foo {
                    drop extending str;
                    extending int64 LAST;
                };
            `
      );
    }).toThrow(new RegExp("cannot change concrete base of scalar type default::Foo from std::str to std::int64"));
  });

  it("test_edgeql_ddl_scalar_13", () => {
    expect(() => {
      h.script(
        `
                create scalar type Foo extending array<str>;
            `
      );
    }).toThrow(new RegExp("scalar type may not have a collection base type"));
    h.script(
      `
            create scalar type Foo extending str;
        `
    );
    expect(() => {
      h.script(
        `
                alter scalar type Foo {
                    drop extending str; extending array<str> last;
                };
            `
      );
    }).toThrow(new RegExp("scalar type may not have a collection base type"));
  });

  it("test_edgeql_ddl_scalar_14", () => {
    expect(() => {
      h.script(
        `
                create scalar type Age extending int16;
                create type User {
                    create property age -> range<Age>;
                };
            `
      );
    }).toThrow(new RegExp("unsupported range subtype"));
    expect(() => {
      h.script(
        `
                create type User {
                    create property age -> range<schema::Object>;
                };
            `
      );
    }).toThrow(new RegExp("unsupported range subtype"));
    expect(() => {
      h.script(
        `
                create type User {
                    create property age -> multirange<int16>;
                };
            `
      );
    }).toThrow(new RegExp("unsupported range subtype"));
    expect(() => {
      h.script(
        `
                create type User {
                    create property age -> multirange<schema::Object>;
                };
            `
      );
    }).toThrow(new RegExp("unsupported range subtype"));
  });

  it("test_edgeql_ddl_cast_01", () => {
    h.script(
      `
            CREATE SCALAR TYPE type_a EXTENDING std::str;
            CREATE SCALAR TYPE type_b EXTENDING std::int64;
            CREATE SCALAR TYPE type_c EXTENDING std::datetime;

            CREATE CAST FROM type_a TO type_b {
                USING SQL CAST;
                ALLOW IMPLICIT;
            };

            CREATE CAST FROM type_a TO type_c {
                USING SQL CAST;
                ALLOW ASSIGNMENT;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Cast {
                    from_type: {name},
                    to_type: {name},
                    allow_implicit,
                    allow_assignment,
                }
                FILTER
                    .from_type.name LIKE 'default::%'
                ORDER BY
                    .allow_implicit;
            `,
      [
            {
              "from_type": {
                "name": "default::type_a",
              },
              "to_type": {
                "name": "default::type_c",
              },
              "allow_implicit": false,
              "allow_assignment": true,
            },
            {
              "from_type": {
                "name": "default::type_a",
              },
              "to_type": {
                "name": "default::type_b",
              },
              "allow_implicit": true,
              "allow_assignment": false,
            },
          ]
    );
    h.script(
      `
            DROP CAST FROM type_a TO type_b;
            DROP CAST FROM type_a TO type_c;
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Cast {
                    from_type: {name},
                    to_type: {name},
                    allow_implicit,
                    allow_assignment,
                }
                FILTER
                    .from_type.name LIKE 'default::%'
                ORDER BY
                    .allow_implicit;
            `,
      []
    );
  });

  it("test_edgeql_ddl_policies_01", () => {
    h.script(
      `
            create required global filtering -> bool { set default := false };
            create global cur -> str;

            create type User {
                create required property name -> str;
                create access policy all_on allow all using (true);
                create access policy filtering
                    when (global filtering)
                    deny select, delete using (.name ?!= global cur);
            };
            create type Bot extending User;
        `
    );
    assertQueryResult(
      h,
      `
                select schema::AccessPolicy {
                    name, condition, expr, action, access_kinds,
                    sname := .subject.name, root := not exists .bases }
                filter .sname like 'default::%'
            `,
      unorderedBag([
            {
              "access_kinds": unorderedSet(["Delete", "Insert", "Select", "UpdateRead", "UpdateWrite"]),
              "action": "Allow",
              "condition": null,
              "expr": "true",
              "name": "all_on",
              "sname": "default::User",
              "root": true,
            },
            {
              "access_kinds": unorderedSet(["Delete", "Select"]),
              "action": "Deny",
              "condition": "global default::filtering",
              "expr": "(.name ?!= global default::cur)",
              "name": "filtering",
              "sname": "default::User",
              "root": true,
            },
            {
              "access_kinds": unorderedSet(["Delete", "Insert", "Select", "UpdateRead", "UpdateWrite"]),
              "action": "Allow",
              "condition": null,
              "expr": "true",
              "name": "all_on",
              "sname": "default::Bot",
              "root": false,
            },
            {
              "access_kinds": unorderedSet(["Delete", "Select"]),
              "action": "Deny",
              "condition": "global default::filtering",
              "expr": "(.name ?!= global default::cur)",
              "name": "filtering",
              "sname": "default::Bot",
              "root": false,
            },
          ])
    );
    h.script(
      `
            alter type User {
                alter access policy filtering {
                    reset when;
                    deny select;
                    using (false);
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                select schema::AccessPolicy {
                    name, condition, expr, action, access_kinds,
                    sname := .subject.name, root := not exists .bases }
                filter .sname = 'default::User' and .name = 'filtering'
            `,
      [
            {
              "access_kinds": unorderedSet(["Select"]),
              "action": "Deny",
              "condition": null,
              "expr": "false",
              "name": "filtering",
              "sname": "default::User",
              "root": true,
            },
          ]
    );
    expect(() => {
      h.script(
        `
                alter type Bot alter access policy filtering allow all;
            `
      );
    }).toThrow(new RegExp("cannot alter the definition of inherited access policy"));
  });

  it("test_edgeql_ddl_policies_02", () => {
    expect(() => {
      h.script(
        `
                create type X {
                    create access policy test
                        when (1)
                        allow all using (true);
                };
            `
      );
    }).toThrow(new RegExp("when expression.* is of invalid type"));
    expect(() => {
      h.script(
        `
                create type X {
                    create access policy test
                        allow all using (1);
                };
            `
      );
    }).toThrow(new RegExp("using expression.* is of invalid type"));
    expect(() => {
      h.script(
        `
                create type X {
                    create access policy test
                        allow all using (());
                };
            `
      );
    }).toThrow(new RegExp("using expression.* is of invalid type"));
    expect(() => {
      h.script(
        `
                create type X {
                    create property x -> str;
                    create access policy test
                        allow all using (.x not like '%redacted%');
                };
            `
      );
    }).toThrow(new RegExp("possibly an empty set returned"));
    expect(() => {
      h.script(
        `
                create type X {
                    create access policy test
                        allow all using ({true, false});
                };
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned"));
    expect(() => {
      h.script(
        `
                create type X {
                    create access policy test
                        allow all using (random() < 0.5);
                };
            `
      );
    }).toThrow(new RegExp("has a volatile using expression"));
  });

  it("test_edgeql_ddl_policies_03", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE MULTI LINK tgt -> Tgt {
                    CREATE PROPERTY foo -> str;
                };
                CREATE ACCESS POLICY asdf
                    ALLOW ALL USING (all(.tgt@foo LIKE '%!'));
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK tgt ALTER property foo
                  SET default := "!!!";
            `
      );
    }).toThrow(new RegExp("may not refer to link properties with default values"));
  });

  it("test_edgeql_ddl_policies_04", () => {
    h.script(
      `
            create global current_user -> uuid;

            create type User {
                create access policy ins allow insert;
                create access policy sel allow select
                  using (.id ?= global current_user);
            };
            create type User2 extending User;

            create type Obj {
                create optional multi link user -> User;
            };
        `
    );
    h.script(
      `
            alter type Obj {
                alter link user set required using (select User limit 1);
            };
        `
    );
    h.script(
      `
            alter type Obj {
                alter link user set single using (select User limit 1);
            };
        `
    );
    h.script(
      `
            alter type Obj {
                alter link user set type User2 using (select User2 limit 1);
            };
        `
    );
  });

  it("test_edgeql_ddl_func_policies_01", () => {
    h.script(
      `
            create type X;
            insert X;
            create function get_x() -> set of uuid using (X.id);
            alter type X {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_02", () => {
    h.script(
      `
            create type Y;
            create type X extending Y;
            insert X;
            create function get_x() -> set of uuid using (X.id);
            alter type Y {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_03", () => {
    h.script(
      `
            create type X;
            create type W extending X;
            insert W;
            create function get_x() -> set of uuid using (X.id);
            alter type W {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_04", () => {
    h.script(
      `
            create type Y;
            create type X;
            create type W extending X, Y;
            insert W;
            create function get_x() -> set of uuid using (X.id);
            alter type Y {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_05", () => {
    h.script(
      `
            create type X;
            create type T { create link x -> X };
            insert T { x := (insert X) };
            create function get_x() -> set of uuid using (T.x.id);
            alter type X {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_06", () => {
    h.script(
      `
            create type T;
            create type X { create link t -> T };

            insert X { t := (insert T) };
            create function get_x() -> set of uuid using (T.<t[IS X].id);
            alter type X {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_07", () => {
    h.script(
      `
            create type T;
            create type X { create link t -> T };

            insert X { t := (insert T) };
            create function get_x() -> set of uuid using (T.<t.id);
            alter type X {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_08", () => {
    h.script(
      `
            create type X;
            create type Y;
            create type T { create link x -> X | Y };
            insert T { x := (insert X) };
            create function get_x() -> set of uuid using (T.x.id);
            alter type X {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_09", () => {
    h.script(
      `
            create type X;
            insert X;
            create alias Y := X;
            create function get_x() -> set of uuid using (Y.id);
            alter type X {
                create access policy test allow select using (false) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
  });

  it("test_edgeql_ddl_func_policies_10", () => {
    h.script(
      `
            create type X;
            insert X;
            create function get_xi() -> set of uuid using (X.id);
            create function get_x() -> set of uuid using (get_xi());
            create required global en -> bool { set default := false };
            alter type X {
                create access policy test allow select using (global en) };
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      []
    );
    h.script(
      `
            set global en := true;
        `
    );
    assertQueryResult(
      h,
      `select get_x()`,
      [
            "str",
          ]
    );
  });

  it("test_edgeql_ddl_global_01", () => {
    h.script(
      `
            create global foo -> str;
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Global {
                required, typ := .target.name, default }
            filter .name = 'default::foo';
        `,
      [
            {
              "required": false,
              "typ": "std::str",
              "default": null,
            },
          ]
    );
    expect(() => {
      h.script(
        `
                alter global foo set required;
            `
      );
    }).toThrow(new RegExp("required globals must have a default"));
    h.script(
      `
            drop global foo;
            create required global foo -> str { set default := "" };
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Global {
                required, typ := .target.name, default }
            filter .name = 'default::foo';
        `,
      [
            {
              "required": true,
              "typ": "std::str",
              "default": "''",
            },
          ]
    );
    expect(() => {
      h.script(
        `
                alter global foo set type array<uuid> reset to default;
            `
      );
    }).toThrow(new RegExp("default expression is of invalid type"));
    expect(() => {
      h.script(
        `
                alter global foo reset default;
            `
      );
    }).toThrow(new RegExp("required globals must have a default"));
    h.script(
      `
            alter global foo set optional;
            alter global foo reset default;
            alter global foo set type array<int64> reset to default;
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Global {
                required, typ := .target.name, default }
            filter .name = 'default::foo';
        `,
      [
            {
              "required": false,
              "typ": "array<std::int64>",
              "default": null,
            },
          ]
    );
  });

  it("test_edgeql_ddl_global_02", () => {
    expect(() => {
      h.script(
        `
                create multi global foo -> str;
            `
      );
    }).toThrow(new RegExp("non-computed globals may not be multi"));
    expect(() => {
      h.script(
        `
                create global foo -> str {
                    set default := {"foo", "bar"}
                };
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned"));
    expect(() => {
      h.script(
        `
                create required global foo -> str {
                    set default := (select "foo" filter false)
                };
            `
      );
    }).toThrow(new RegExp("possibly no elements returned"));
    expect(() => {
      h.script(
        `
                create global foo -> Object;
            `
      );
    }).toThrow(new RegExp("non-computed globals may not have have object type"));
    expect(() => {
      h.script(
        `
                create global foo -> array<Object>;
            `
      );
    }).toThrow(new RegExp("non-computed globals may not have have object type"));
    expect(() => {
      h.script(
        `
                create global foo -> float64 { set default := random(); };
            `
      );
    }).toThrow(new RegExp("has a volatile default expression, which is not allowed"));
    expect(() => {
      h.script(
        `
                create global test {
                    using ('abc');
                    set default := 'def';
                }
            `
      );
    }).toThrow(new RegExp("computed globals may not have default values"));
  });

  it("test_edgeql_ddl_global_03", () => {
    h.script(
      `
            create global foo -> str;
        `
    );
    expect(() => {
      h.script(
        `
                create type X {
                    create property foo -> str {
                        create constraint expression on (
                            __subject__ != global foo)
                    }
                }
            `
      );
    }).toThrow(new RegExp("global variables cannot be referenced from constraint"));
    expect(() => {
      h.script(
        `
                create type X {
                    create index on (global foo);
                }
            `
      );
    }).toThrow(new RegExp("global variables cannot be referenced from index"));
    h.script(
      `
            create type X;
        `
    );
    h.script(
      `
            set global foo := "test"
        `
    );
    h.script(
      `
            create type Y {
                create property foo -> str {
                    set default := (global foo);
                }
            };
        `
    );
    h.query(
      `
            insert Y;
        `
    );
    assertQueryResult(
      h,
      `
                select Y.foo
            `,
      ["test"]
    );
    h.script(
      `
            alter type X {
                create property foo -> str;
            };
            alter type X {
                alter property foo {
                    set default := (global foo);
                }
            };
        `
    );
    h.query(
      `
            insert X;
        `
    );
    assertQueryResult(
      h,
      `
                select X.foo
            `,
      ["test"]
    );
  });

  it("test_edgeql_ddl_global_04", () => {
    h.script(
      `
            create global foo -> str;
            create function gfoo() -> optional str using (global foo)
        `
    );
    expect(() => {
      h.script(
        `
                create type X {
                    create property foo -> str {
                        create constraint expression on (
                            __subject__ != gfoo())
                    }
                }
            `
      );
    }).toThrow(new RegExp("functions that reference global variables cannot be called from constraint"));
    expect(() => {
      h.script(
        `
                create type X {
                    create index on (gfoo());
                }
            `
      );
    }).toThrow(new RegExp("functions that reference global variables cannot be called from index"));
  });

  it("test_edgeql_ddl_global_05", () => {
    h.script(
      `
            create global foo -> str;
            create function gfoo() -> optional str using ("test");
            create function gbar() -> optional str using (gfoo());
        `
    );
    h.script(
      `
            set global foo := "!!"
        `
    );
    h.script(
      `
            alter function gfoo() using (global foo)
        `
    );
    assertQueryResult(
      h,
      `select gbar()`,
      ["!!"]
    );
  });

  it("test_edgeql_ddl_global_06", () => {
    h.script(
      `
            create global foo := 10;
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Global {
                required, cardinality, typ := .target.name,
                req_comp := contains(.computed_fields, 'required'),
                card_comp := contains(.computed_fields, 'cardinality'),
                computed := exists .expr,
            }
            filter .name = 'default::foo';
        `,
      [
            {
              "computed": true,
              "card_comp": true,
              "req_comp": true,
              "required": true,
              "cardinality": "One",
              "typ": "default::foo",
            },
          ]
    );
    h.script(
      `
            drop global foo;
            create optional multi global foo := 10;
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Global {
                required, cardinality, typ := .target.name,
                req_comp := contains(.computed_fields, 'required'),
                card_comp := contains(.computed_fields, 'cardinality'),
                computed := exists .expr,
            }
            filter .name = 'default::foo';
        `,
      [
            {
              "computed": true,
              "card_comp": false,
              "req_comp": false,
              "required": false,
              "cardinality": "Many",
              "typ": "default::foo",
            },
          ]
    );
    h.script(
      `
            alter global foo reset optionality;
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Global {
                required, cardinality, typ := .target.name,
                req_comp := contains(.computed_fields, 'required'),
                card_comp := contains(.computed_fields, 'cardinality'),
                computed := exists .expr,
            }
            filter .name = 'default::foo';
        `,
      [
            {
              "computed": true,
              "card_comp": false,
              "req_comp": true,
              "required": true,
              "cardinality": "Many",
              "typ": "default::foo",
            },
          ]
    );
    h.script(
      `
            alter global foo {
                reset cardinality;
                reset expression;
                set type str reset to default;
            };
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Global {
                required, cardinality, typ := .target.name,
                req_comp := contains(.computed_fields, 'required'),
                card_comp := contains(.computed_fields, 'cardinality'),
                computed := exists .expr,
            }
            filter .name = 'default::foo';
        `,
      [
            {
              "computed": false,
              "card_comp": false,
              "req_comp": false,
              "required": false,
              "cardinality": "One",
              "typ": "std::str",
            },
          ]
    );
  });

  it("test_edgeql_ddl_global_07", () => {
    h.script(
      `
            create global foo := <str>Object.id
        `
    );
    expect(() => {
      h.script(
        `
                alter global foo set required;
            `
      );
    }).toThrow(new RegExp("possibly an empty set returned"));
    expect(() => {
      h.script(
        `
                alter global foo set single;
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned"));
    expect(() => {
      h.script(
        `
                alter global foo set type str reset to default;
            `
      );
    }).toThrow(new RegExp("cannot specify a type and an expression for a global"));
  });

  it("test_edgeql_ddl_global_08", () => {
    h.script(
      `
            create global foo -> str;
            set global foo := "test";
        `
    );
    h.script(
      `
            alter global foo set type int64 reset to default;
        `
    );
    assertQueryResult(
      h,
      `select global foo`,
      []
    );
    expect(() => {
      h.script(
        `
                alter global foo set type str;
            `
      );
    }).toThrow(new RegExp("SET TYPE on global must explicitly reset the global's value"));
    expect(() => {
      h.script(
        `
                alter global foo set type str using ('lol');
            `
      );
    }).toThrow(new RegExp("USING casts for SET TYPE on globals are not supported"));
  });

  it("test_edgeql_ddl_global_09", () => {
    h.script(
      `
            create type Org;

            create global current_org_id -> uuid;
            create global current_org := (
              select Org filter .id = global current_org_id
            );

            create type Widget {
              create required link org -> Org {
                set default := global current_org;
              }
            };
        `
    );
    let obj = h.query("insert Org");
    h.script(
      `
            set global current_org_id := <uuid>$0
            `
    );
    h.script(
      `insert Widget`
    );
    assertQueryResult(
      h,
      `
                select Widget { org }
            `,
      [{"org": {"id": obj.id}}]
    );
  });

  it("test_edgeql_ddl_global_10", () => {
    h.script(
      `
            create type Org;

            create global current_org_id -> uuid;
            create global current_org := (
              select Org filter .id = global current_org_id
            );

            create type Widget {
              create required link org -> Org {
                create rewrite insert using (global current_org)
              }
            };
        `
    );
    let obj = h.query("insert Org");
    h.script(
      `
            set global current_org_id := <uuid>$0
            `
    );
    h.script(
      `insert Widget`
    );
    assertQueryResult(
      h,
      `
                select Widget { org }
            `,
      [{"org": {"id": obj.id}}]
    );
  });

  it("test_edgeql_ddl_global_11", () => {
    h.script(
      `
            create type Org;

            create global current_org_id -> uuid;
            create global current_org := (
              select Org { * } filter .id = global current_org_id
            );

            create type Widget {
              create required link org -> Org {
                set default := global current_org;
              }
            };
        `
    );
    let obj = h.query("insert Org");
    h.script(
      `
            set global current_org_id := <uuid>$0
            `
    );
    h.script(
      `insert Widget`
    );
    assertQueryResult(
      h,
      `
                select Widget { org }
            `,
      [{"org": {"id": obj.id}}]
    );
  });

  it("test_edgeql_ddl_global_default", () => {
    h.script(
      `
            create global foo -> str;
            create type Foo;
        `
    );
    h.script(
      `
            alter type Foo { create required property name -> str {
                set default := (global foo);
            } }
        `
    );
    h.script(
      `
            set global foo := "test";
            insert Foo;
            reset global foo;
        `
    );
    assertQueryResult(
      h,
      `
                select Foo { name }
            `,
      [
            {
              "name": "test",
            },
          ]
    );
    expect(() => {
      h.script(
        `
                alter type Foo { create required property name2 -> str {
                    set default := (global foo);
                } }
            `
      );
    }).toThrow(new RegExp("missing value for required property"));
    h.script(
      `
            alter global foo set default := "!";
            create function get_foo() -> optional str using (global foo);
        `
    );
    h.script(
      `
            alter type Foo { create required property name2 -> str {
                set default := (global foo);
            } };
            alter type Foo { create required property name3 -> str {
                set default := (get_foo());
            } };
        `
    );
    assertQueryResult(
      h,
      `
                select Foo { name, name2, name3 }
            `,
      [
            {
              "name": "test",
              "name2": "!",
              "name3": "!",
            },
          ]
    );
  });

  it("test_edgeql_ddl_global_type_changes_01", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_02", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_03", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_04", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_05", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_06", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_07", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_08", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_09", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_10", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_11", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_12", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_13", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_14", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_15", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_16", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_17", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_18", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_19", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_20", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_21", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_22", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_23", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_24", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_25", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_26", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_27", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_28", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_global_type_changes_29", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_permissions_01", () => {
    h.script(
      `
            create permission foo;
        `
    );
    assertQueryResult(
      h,
      `select global foo;`,
      [true]
    );
    h.script(
      `
            drop permission foo;
        `
    );
    expect(() => {
      h.script(
        `
                select global foo;
            `
      );
    }).toThrow(new RegExp("global 'default::foo' does not exist"));
  });

  it("test_edgeql_ddl_permissions_02", () => {
    h.script(
      `
            create permission foo {
                create annotation title := 'A';
            };
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Permission {
                name,
                annotations: {n := .name, v := @value},
            }
            filter .name = 'default::foo';
            `,
      [
            {
              "name": "default::foo",
              "annotations": unorderedBag([
                {
                  "n": "std::title",
                  "v": "A",
                },
              ]),
            },
          ]
    );
    h.script(
      `
            alter permission foo {
                create annotation description := 'B';
            };
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Permission {
                name,
                annotations: {n := .name, v := @value},
            }
            filter .name = 'default::foo';
            `,
      [
            {
              "name": "default::foo",
              "annotations": unorderedBag([
                {
                  "n": "std::title",
                  "v": "A",
                },
                {
                  "n": "std::description",
                  "v": "B",
                },
              ]),
            },
          ]
    );
    h.script(
      `
            alter permission foo {
                alter annotation description := 'C';
            };
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Permission {
                name,
                annotations: {n := .name, v := @value},
            }
            filter .name = 'default::foo';
            `,
      [
            {
              "name": "default::foo",
              "annotations": unorderedBag([
                {
                  "n": "std::title",
                  "v": "A",
                },
                {
                  "n": "std::description",
                  "v": "C",
                },
              ]),
            },
          ]
    );
    h.script(
      `
            alter permission foo {
                drop annotation description;
            };
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Permission {
                name,
                annotations: {n := .name, v := @value},
            }
            filter .name = 'default::foo';
            `,
      [
            {
              "name": "default::foo",
              "annotations": unorderedBag([
                {
                  "n": "std::title",
                  "v": "A",
                },
              ]),
            },
          ]
    );
  });

  it("test_edgeql_ddl_permissions_03", () => {
    h.script(
      `
            create permission foo;
        `
    );
    assertQueryResult(
      h,
      `select global foo;`,
      [true]
    );
    h.script(
      `
            alter permission foo {
                rename to bar;
            };
        `
    );
    assertQueryResult(
      h,
      `select global bar;`,
      [true]
    );
    expect(() => {
      h.script(
        `
                select global foo;
            `
      );
    }).toThrow(new RegExp("global 'default::foo' does not exist"));
  });

  it("test_edgeql_ddl_property_computable_01", () => {
    h.script(
      `            CREATE TYPE CompProp;
            ALTER TYPE CompProp {
                CREATE PROPERTY prop := 'I am a computable';
            };
            INSERT CompProp;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT CompProp {
                    prop
                };
            `,
      [
            {
              "prop": "I am a computable",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    properties: {
                        name,
                        target: {
                            name
                        }
                    } FILTER .name = 'prop'
                }
                FILTER
                    .name = 'default::CompProp';
            `,
      [
            {
              "properties": [
                {
                  "name": "prop",
                  "target": {
                    "name": "std::str",
                  },
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_property_computable_02", () => {
    h.script(
      `            CREATE TYPE CompProp {
                CREATE PROPERTY prop := 'I am a computable';
            };
            INSERT CompProp;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT CompProp {
                    prop
                };
            `,
      [
            {
              "prop": "I am a computable",
            },
          ]
    );
    h.script(
      `            ALTER TYPE CompProp {
                ALTER PROPERTY prop {
                    RESET EXPRESSION;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT CompProp {
                    prop
                };
            `,
      [
            {
              "prop": null,
            },
          ]
    );
  });

  it("test_edgeql_ddl_property_computable_03", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY bar -> str;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo { ALTER PROPERTY bar { USING (1) } };
        `
    );
    h.script(
      `
            ALTER TYPE Foo { ALTER PROPERTY bar { USING ("1") } };
        `
    );
  });

  it("test_edgeql_ddl_property_computable_circular", () => {
    h.script(
      `            CREATE TYPE CompPropCircular {
                CREATE PROPERTY prop := (SELECT count(CompPropCircular))
            };
        `
    );
  });

  it("test_edgeql_ddl_property_computable_add_dep", () => {
    h.script(
      `
            create type A {
                create property foo := "!";
                create property bar -> str;
            };
            alter type A alter property foo using (.bar);
            create type B extending A;
        `
    );
  });

  it("test_edgeql_ddl_property_computable_bad_01", () => {
    expect(() => {
      h.script(
        `                CREATE TYPE CompPropBad;
                ALTER TYPE CompPropBad {
                    CREATE PROPERTY prop := (SELECT std::Object LIMIT 1);
                };
            `
      );
    }).toThrow(new RegExp("invalid property type: expected.* got .* 'std::Object'"));
  });

  it("test_edgeql_ddl_link_computable_01", () => {
    h.script(
      `            CREATE TYPE LinkTarget;
            CREATE TYPE CompLink {
                CREATE MULTI LINK l := LinkTarget;
            };

            INSERT LinkTarget;
            INSERT CompLink;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT CompLink {
                    l: {
                        id
                    }
                };
            `,
      [
            {
              "l": [
                {
                  "id": "UUID",
                },
              ],
            },
          ]
    );
    h.script(
      `            ALTER TYPE CompLink {
                ALTER LINK l {
                    RESET EXPRESSION;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT CompLink {
                    l: {
                        id
                    }
                };
            `,
      [
            {
              "l": [],
            },
          ]
    );
  });

  it("test_edgeql_ddl_link_computable_02", () => {
    h.script(
      `
            CREATE TYPE LinkTarget;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE TYPE X { CREATE LINK x := LinkTarget { z := 1 } };
            `
      );
    }).toThrow(new RegExp("including a shape on schema-defined computed links is not yet supported"));
  });

  it("test_edgeql_ddl_link_computable_circular_01", () => {
    h.script(
      `            CREATE TYPE CompLinkCircular {
                CREATE LINK l := (SELECT CompLinkCircular LIMIT 1)
            };
        `
    );
  });

  it("test_edgeql_ddl_link_target_circular_01", () => {
    h.script(
      `            CREATE TYPE LinkCircularA;
            CREATE TYPE LinkCircularB {
                CREATE LINK l -> LinkCircularA
                                 | LinkCircularB;
            };
        `
    );
  });

  it("test_edgeql_ddl_annotation_01", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION attr1;

            CREATE SCALAR TYPE TestAttrType1 EXTENDING std::str {
                CREATE ANNOTATION attr1 := 'aaaa';
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    annotations: {
                        name,
                        @value,
                    }
                }
                FILTER
                    .name = 'default::TestAttrType1';
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::attr1",
                  "@value": "aaaa",
                },
              ],
            },
          ]
    );
    h.script(
      `
            abstract annotation attr2;

            scalar type TestAttrType1 extending std::str {
                annotation attr2 := 'aaaa';
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    annotations: {
                        name,
                        @value,
                    }
                }
                FILTER
                    .name = 'default::TestAttrType1';
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::attr2",
                  "@value": "aaaa",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_02", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION attr1;

            CREATE TYPE TestAttrType2 {
                CREATE ANNOTATION attr1 := 'aaaa';
            };
        `
    );
    h.script(
      `
            abstract annotation attr2;

            type TestAttrType2 {
                annotation attr2 := 'aaaa';
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    annotations: {
                        name,
                        @value,
                    } FILTER .name = 'default::attr2'
                }
                FILTER
                    .name = 'default::TestAttrType2';
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::attr2",
                  "@value": "aaaa",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_03", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION noninh;
            CREATE ABSTRACT INHERITABLE ANNOTATION inh;

            CREATE TYPE TestAttr1 {
                CREATE ANNOTATION noninh := 'no inherit';
                CREATE ANNOTATION inh := 'inherit me';
            };

            CREATE TYPE TestAttr2 EXTENDING TestAttr1;
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    annotations: {
                        name,
                        inheritable,
                        @value,
                    }
                    FILTER .name LIKE 'default::%'
                    ORDER BY .name
                }
                FILTER
                    .name LIKE 'default::TestAttr%'
                ORDER BY
                    .name;
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::inh",
                  "inheritable": true,
                  "@value": "inherit me",
                },
                {
                  "name": "default::noninh",
                  "@value": "no inherit",
                },
              ],
            },
            {
              "annotations": [
                {
                  "name": "default::inh",
                  "inheritable": true,
                  "@value": "inherit me",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_04", () => {
    h.script(
      `
            CREATE TYPE BaseAnno4;
            CREATE TYPE DerivedAnno4 EXTENDING BaseAnno4;
            CREATE ABSTRACT ANNOTATION noninh_anno;
            CREATE ABSTRACT INHERITABLE ANNOTATION inh_anno;
            ALTER TYPE BaseAnno4
                CREATE ANNOTATION noninh_anno := '1';
            ALTER TYPE BaseAnno4
                CREATE ANNOTATION inh_anno := '2';
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    annotations: {
                        name,
                        inheritable,
                        @value,
                    }
                    FILTER .name LIKE 'default::%_anno'
                    ORDER BY .name
                }
                FILTER
                    .name = 'default::DerivedAnno4'
                ORDER BY
                    .name;
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::inh_anno",
                  "inheritable": true,
                  "@value": "2",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_05", () => {
    h.script(
      `
            CREATE TYPE BaseAnno05 {
                CREATE PROPERTY name -> str;
                CREATE INDEX ON (.name) {
                    CREATE ANNOTATION title := 'name index'
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    indexes: {
                        expr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::BaseAnno05';
            `,
      [
            {
              "indexes": [
                {
                  "expr": ".name",
                  "annotations": [
                    {
                      "name": "std::title",
                      "@value": "name index",
                    },
                  ],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_06", () => {
    h.script(
      `
            CREATE TYPE BaseAnno06 {
                CREATE PROPERTY name -> str;
                CREATE INDEX ON (.name);
            };
        `
    );
    h.script(
      `
            ALTER TYPE BaseAnno06 {
                ALTER INDEX ON (.name) {
                    CREATE ANNOTATION title := 'name index'
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    indexes: {
                        expr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::BaseAnno06';
            `,
      [
            {
              "indexes": [
                {
                  "expr": ".name",
                  "annotations": [
                    {
                      "name": "std::title",
                      "@value": "name index",
                    },
                  ],
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE BaseAnno06 {
                ALTER INDEX ON (.name) {
                    DROP ANNOTATION title;
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    indexes: {
                        expr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::BaseAnno06';
            `,
      [
            {
              "indexes": [
                {
                  "expr": ".name",
                  "annotations": [],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_07", () => {
    h.script(
      `
            CREATE TYPE BaseAnno07 {
                CREATE PROPERTY name -> str;
                CREATE INDEX ON (.name) {
                    CREATE ANNOTATION title := 'name index'
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    indexes: {
                        expr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::BaseAnno07';
            `,
      [
            {
              "indexes": [
                {
                  "expr": ".name",
                  "annotations": [
                    {
                      "name": "std::title",
                      "@value": "name index",
                    },
                  ],
                },
              ],
            },
          ]
    );
    h.script(
      `
            type BaseAnno07 {
                property name -> str;
                index ON (.name);
            }
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    indexes: {
                        expr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::BaseAnno07';
            `,
      [
            {
              "indexes": [
                {
                  "expr": ".name",
                  "annotations": [],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_08", () => {
    h.script(
      `
            CREATE TYPE BaseAnno08 {
                CREATE PROPERTY name -> str;
                CREATE INDEX ON (.name);
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    indexes: {
                        expr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::BaseAnno08';
            `,
      [
            {
              "indexes": [
                {
                  "expr": ".name",
                  "annotations": [],
                },
              ],
            },
          ]
    );
    h.script(
      `
            type BaseAnno08 {
                property name -> str;
                index ON (.name) {
                    annotation title := 'name index';
                    annotation lang::py::type := 'asdf';
                }
            }
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    indexes: {
                        expr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::BaseAnno08';
            `,
      [
            {
              "indexes": [
                {
                  "expr": ".name",
                  "annotations": unorderedBag([
                    {
                      "name": "std::title",
                      "@value": "name index",
                    },
                    {
                      "name": "std::lang::py::type",
                      "@value": "asdf",
                    },
                  ]),
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_09", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION anno09;

            CREATE TYPE TestTypeAnno09 {
                CREATE ANNOTATION anno09 := 'A';
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    annotations: {
                        name,
                        @value,
                    } FILTER .name = 'default::anno09'
                }
                FILTER
                    .name = 'default::TestTypeAnno09';
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::anno09",
                  "@value": "A",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE TestTypeAnno09 {
                ALTER ANNOTATION anno09 := 'B';
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    annotations: {
                        name,
                        @value,
                    } FILTER .name = 'default::anno09'
                }
                FILTER
                    .name = 'default::TestTypeAnno09';
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::anno09",
                  "@value": "B",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_10", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION anno10;
            CREATE ABSTRACT INHERITABLE ANNOTATION anno10_inh;

            CREATE TYPE TestTypeAnno10
            {
                CREATE ANNOTATION anno10 := 'A';
                CREATE ANNOTATION anno10_inh := 'A';
            };

            CREATE TYPE TestSubTypeAnno10
                    EXTENDING TestTypeAnno10
            {
                CREATE ANNOTATION anno10 := 'B';
                ALTER ANNOTATION anno10_inh := 'B';
            }
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    annotations: {
                        name,
                        @value,
                    }
                    FILTER .name LIKE 'default::anno10%'
                    ORDER BY .name
                }
                FILTER
                    .name LIKE 'default::%Anno10'
                ORDER BY
                    .name
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::anno10",
                  "@value": "B",
                },
                {
                  "name": "default::anno10_inh",
                  "@value": "B",
                },
              ],
            },
            {
              "annotations": [
                {
                  "name": "default::anno10",
                  "@value": "A",
                },
                {
                  "name": "default::anno10_inh",
                  "@value": "A",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE TestSubTypeAnno10 {
                DROP ANNOTATION anno10;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ObjectType {
                    annotations: {
                        name,
                        @value,
                    } FILTER .name LIKE 'default::anno10%'
                }
                FILTER
                    .name = 'default::TestSubTypeAnno10';
            `,
      [
            {
              "annotations": [
                {
                  "name": "default::anno10_inh",
                  "@value": "B",
                },
              ],
            },
          ]
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE TestSubTypeAnno10 {
                    DROP ANNOTATION anno10_inh;
                };
            `
      );
    }).toThrow(new RegExp("cannot drop inherited annotation 'default::anno10_inh'"));
  });

  it("test_edgeql_ddl_annotation_11", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION anno11;
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Annotation {
                    name,
                }
                FILTER
                    .name LIKE 'default::anno11%';
            `,
      [
            {
              "name": "default::anno11",
            },
          ]
    );
    h.script(
      `
            ALTER ABSTRACT ANNOTATION anno11
                RENAME TO anno11_new_name;
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Annotation {
                    name,
                }
                FILTER
                    .name LIKE 'default::anno11%';
            `,
      [
            {
              "name": "default::anno11_new_name",
            },
          ]
    );
    h.script(
      `
            CREATE MODULE foo;

            ALTER ABSTRACT ANNOTATION anno11_new_name
                RENAME TO foo::anno11_new_name;
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Annotation {
                    name,
                }
                FILTER
                    .name LIKE 'foo::anno11%';
            `,
      [
            {
              "name": "foo::anno11_new_name",
            },
          ]
    );
    h.script(
      `
            DROP ABSTRACT ANNOTATION foo::anno11_new_name;
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Annotation {
                    name,
                }
                FILTER
                    .name LIKE 'foo::anno11%';
            `,
      []
    );
  });

  it("test_edgeql_ddl_annotation_12", () => {
    expect(() => {
      h.script(
        `
                CREATE ABSTRACT ANNOTATION bogus::anno12;
            `
      );
    }).toThrow(new RegExp("module 'bogus' is not in this schema"));
  });

  it("test_edgeql_ddl_annotation_13", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION anno13;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER ABSTRACT ANNOTATION anno13 RENAME TO bogus::anno13;
            `
      );
    }).toThrow(new RegExp("module 'bogus' is not in this schema"));
  });

  it("test_edgeql_ddl_annotation_14", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION anno;
            CREATE TYPE Foo {
                CREATE ANNOTATION anno := "test";
            };
        `
    );
    h.script(
      `
            ALTER ABSTRACT ANNOTATION anno
                RENAME TO anno_new_name;
        `
    );
    assertQueryResult(
      h,
      `DESCRIBE MODULE default as sdl`,
      ["abstract annotation default::anno_new_name;\ntype default::Foo {\n    annotation default::anno_new_name := 'test';\n};"]
    );
    h.script(
      `
            DROP TYPE Foo;
        `
    );
  });

  it("test_edgeql_ddl_annotation_15", () => {
    h.script(
      `
            CREATE ABSTRACT INHERITABLE ANNOTATION anno;
            CREATE TYPE Foo {
                CREATE PROPERTY prop -> str {
                    CREATE ANNOTATION anno := "parent";
                };
            };
            CREATE TYPE Bar EXTENDING Foo {
                ALTER PROPERTY prop {
                    ALTER ANNOTATION anno := "child";
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
            WITH MODULE schema
            SELECT Property {
                obj := .source.name,
                annotations: {name, @value, @owned}
                ORDER BY .name
            }
            FILTER
                .name = 'prop'
            ORDER BY
                (.obj, .name);
        `,
      [
            {
              "annotations": [
                {
                  "@value": "child",
                  "@owned": true,
                  "name": "default::anno",
                },
              ],
              "obj": "default::Bar",
            },
            {
              "annotations": [
                {
                  "@value": "parent",
                  "@owned": true,
                  "name": "default::anno",
                },
              ],
              "obj": "default::Foo",
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Bar {
                ALTER PROPERTY prop {
                    ALTER ANNOTATION anno DROP OWNED;
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
            WITH MODULE schema
            SELECT Property {
                obj := .source.name,
                annotations: {name, @value, @owned}
                ORDER BY .name
            }
            FILTER
                .name = 'prop'
            ORDER BY
                (.obj, .name);
        `,
      [
            {
              "annotations": [
                {
                  "@value": "parent",
                  "@owned": false,
                  "name": "default::anno",
                },
              ],
              "obj": "default::Bar",
            },
            {
              "annotations": [
                {
                  "@value": "parent",
                  "@owned": true,
                  "name": "default::anno",
                },
              ],
              "obj": "default::Foo",
            },
          ]
    );
  });

  it("test_edgeql_ddl_annotation_16", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION attr1;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE SCALAR TYPE TestAttrType1 EXTENDING std::str {
                    CREATE ANNOTATION attr1 := 10;
                };
            `
      );
    }).toThrow(new RegExp("annotation values must be 'std::str', got scalar type 'std::int64'"));
  });

  it("test_edgeql_ddl_annotation_17", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION attr1;
            CREATE SCALAR TYPE TestAttrType1 EXTENDING std::str {
                CREATE ANNOTATION attr1 := '10';
            };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE TestAttrType1 {
                    ALTER ANNOTATION attr1 := 10;
                };
            `
      );
    }).toThrow(new RegExp("annotation values must be 'std::str', got scalar type 'std::int64'"));
  });

  it("test_edgeql_ddl_annotation_18", () => {
    h.script(
      `
            CREATE ABSTRACT ANNOTATION ann {
                CREATE ANNOTATION description := "foo";
            };
        `
    );
    assertQueryResult(
      h,
      `
            WITH MODULE schema
            SELECT Annotation {
                annotations: {name, @value}
            }
            FILTER .name = 'default::ann'
        `,
      [
            {
              "annotations": [
                {
                  "@value": "foo",
                  "name": "std::description",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER ABSTRACT ANNOTATION ann {
                ALTER ANNOTATION description := "bar";
            };
        `
    );
    assertQueryResult(
      h,
      `
            WITH MODULE schema
            SELECT Annotation {
                annotations: {name, @value}
            }
            FILTER .name = 'default::ann'
        `,
      [
            {
              "annotations": [
                {
                  "@value": "bar",
                  "name": "std::description",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER ABSTRACT ANNOTATION ann {
                DROP ANNOTATION description;
            };
        `
    );
    assertQueryResult(
      h,
      `
            WITH MODULE schema
            SELECT Annotation {
                annotations: {name, @value}
            }
            FILTER .name = 'default::ann'
        `,
      [
            {
              "annotations": [],
            },
          ]
    );
  });

  it("test_edgeql_ddl_anytype_01", () => {
    expect(() => {
      h.script(
        `
                CREATE ABSTRACT LINK test_object_link_prop {
                    CREATE PROPERTY link_prop1 -> anytype;
                };
            `
      );
    }).toThrow(new RegExp("invalid property type"));
  });

  it("test_edgeql_ddl_anytype_02", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE AnyObject2 {
                    CREATE LINK a -> anytype;
                };
            `
      );
    }).toThrow(new RegExp("invalid link target"));
  });

  it("test_edgeql_ddl_anytype_03", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE AnyObject3 {
                    CREATE PROPERTY a -> anytype;
                };
            `
      );
    }).toThrow(new RegExp("invalid property type"));
  });

  it("test_edgeql_ddl_anytype_04", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE AnyObject4 {
                    CREATE PROPERTY a -> anyscalar;
                };
            `
      );
    }).toThrow(new RegExp("invalid property type"));
  });

  it("test_edgeql_ddl_anytype_05", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE AnyObject5 {
                    CREATE PROPERTY a -> anyint;
                };
            `
      );
    }).toThrow(new RegExp("invalid property type"));
  });

  it("test_edgeql_ddl_anytype_06", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE AnyObject6 EXTENDING anytype {
                    CREATE REQUIRED LINK a -> AnyObject6;
                    CREATE REQUIRED PROPERTY b -> str;
                };
            `
      );
    }).toThrow(new RegExp("'anytype' cannot be a parent type"));
  });

  it("test_edgeql_ddl_extending_01", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE ExtA1;
                CREATE TYPE ExtB1;
                # create two types with incompatible linearized bases
                CREATE TYPE ExtC1 EXTENDING ExtA1, ExtB1;
                CREATE TYPE ExtD1 EXTENDING ExtB1, ExtA1;
                # extending from both of these incompatible types
                CREATE TYPE Merged1 EXTENDING ExtC1, ExtD1;
            `
      );
    }).toThrow(new RegExp("could not find consistent ancestor order for object type 'default::Merged1'"));
  });

  it("test_edgeql_ddl_extending_02", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE ExtA2;
                CREATE TYPE ExtC2 EXTENDING ExtA2, Object;
                # This is busted because no ordering can be consistent
                # with the base ordering here.
                CREATE TYPE ExtD2 EXTENDING Object, ExtA2;
            `
      );
    }).toThrow(new RegExp("could not find consistent ancestor order for object type 'default::ExtD2'"));
  });

  it("test_edgeql_ddl_extending_03", () => {
    h.script(
      `
            CREATE TYPE ExtA3;
            CREATE TYPE ExtB3 EXTENDING ExtA3;
            CREATE TYPE ExtC3 EXTENDING ExtB3;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    ancestors: {
                        name
                    } ORDER BY @index
                }
                FILTER .name = 'default::ExtC3'
            `,
      [
            {
              "ancestors": [
                {
                  "name": "default::ExtB3",
                },
                {
                  "name": "default::ExtA3",
                },
                {
                  "name": "std::Object",
                },
                {
                  "name": "std::BaseObject",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE ExtB3 DROP EXTENDING ExtA3;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    ancestors: {
                        name
                    } ORDER BY @index
                }
                FILTER .name = 'default::ExtC3'
            `,
      [
            {
              "ancestors": [
                {
                  "name": "default::ExtB3",
                },
                {
                  "name": "std::Object",
                },
                {
                  "name": "std::BaseObject",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_extending_04", () => {
    h.script(
      `
            CREATE TYPE ExtA4 {
                CREATE PROPERTY a -> int64;
            };

            CREATE ABSTRACT INHERITABLE ANNOTATION a_anno;

            CREATE TYPE ExtB4 {
                CREATE PROPERTY a -> int64 {
                    CREATE ANNOTATION a_anno := 'anno';
                };

                CREATE PROPERTY b -> str;
            };

            CREATE TYPE Ext4Child EXTENDING ExtA4;
            CREATE TYPE Ext4GrandChild EXTENDING Ext4Child;
            CREATE TYPE Ext4GrandGrandChild
                EXTENDING Ext4GrandChild;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT (
                    SELECT schema::ObjectType
                    FILTER .name = 'default::Ext4Child'
                ).properties.name;
            `,
      unorderedSet(["a", "id"])
    );
    h.script(
      `
            ALTER TYPE Ext4Child EXTENDING ExtB4;
        `
    );
    assertQueryResult(
      h,
      `
                    SELECT (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::Ext4Child'
                    ).properties.name;
                `,
      unorderedSet(["a", "b", "id"])
    );
    assertQueryResult(
      h,
      `
                    SELECT (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::Ext4GrandGrandChild'
                    ).properties.name;
                `,
      unorderedSet(["a", "b", "id"])
    );
    assertQueryResult(
      h,
      `
                    SELECT (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::Ext4GrandChild'
                    ).properties.name;
                `,
      unorderedSet(["a", "b", "id"])
    );
    assertQueryResult(
      h,
      `
                WITH
                    ggc := (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::Ext4GrandGrandChild'
                    )
                SELECT
                    (SELECT ggc.properties FILTER .name = 'a')
                        .annotations@value;
            `,
      unorderedSet(["anno"])
    );
    h.script(
      `
            ALTER TYPE Ext4Child DROP EXTENDING ExtB4;
        `
    );
    assertQueryResult(
      h,
      `
                    SELECT (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::Ext4Child'
                    ).properties.name;
                `,
      unorderedSet(["a", "id"])
    );
    assertQueryResult(
      h,
      `
                    SELECT (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::Ext4GrandGrandChild'
                    ).properties.name;
                `,
      unorderedSet(["a", "id"])
    );
    assertQueryResult(
      h,
      `
                    SELECT (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::Ext4GrandChild'
                    ).properties.name;
                `,
      unorderedSet(["a", "id"])
    );
    assertQueryResult(
      h,
      `
                WITH
                    ggc := (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::Ext4GrandGrandChild'
                    )
                SELECT
                    (SELECT ggc.properties FILTER .name = 'a')
                        .annotations@value;
            `,
      []
    );
  });

  it.skip("test_edgeql_ddl_extending_05 [xfail: Default value ought to get reset back to non-existent, since it was inherited? (Or actually maybe not, since the prop is owned by then?)]", () => {
    h.script(
      `
            CREATE TYPE ExtA5 {
                CREATE PROPERTY a -> int64 {
                    SET default := 1;
                };
            };

            CREATE TYPE ExtB5 {
                CREATE PROPERTY a -> int64 {
                    SET default := 2;
                };
            };

            CREATE TYPE ExtC5 EXTENDING ExtB5;
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C5 := (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::ExtC5'
                    )
                SELECT
                    (SELECT C5.properties FILTER .name = 'a')
                        .default;
            `,
      unorderedSet(["2"])
    );
    h.script(
      `
            ALTER TYPE ExtC5 EXTENDING ExtA5 FIRST;
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C5 := (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::ExtC5'
                    )
                SELECT
                    (SELECT C5.properties FILTER .name = 'a')
                        .default;
            `,
      unorderedSet(["1"])
    );
    h.script(
      `
            ALTER TYPE ExtC5 DROP EXTENDING ExtA5;
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C5 := (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::ExtC5'
                    )
                SELECT
                    (SELECT C5.properties FILTER .name = 'a')
                        .default;
            `,
      unorderedSet(["2"])
    );
    h.script(
      `
            ALTER TYPE ExtC5 ALTER PROPERTY a SET REQUIRED;
            ALTER TYPE ExtC5 DROP EXTENDING ExtB5;
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    C5 := (
                        SELECT schema::ObjectType
                        FILTER .name = 'default::ExtC5'
                    )
                SELECT
                    (SELECT C5.properties FILTER .name = 'a')
                        .default;
            `,
      []
    );
  });

  it("test_edgeql_ddl_extending_06", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE SomeObject6 EXTENDING FreeObject;
            `
      );
    }).toThrow(new RegExp("'std::FreeObject' cannot be a parent type"));
    expect(() => {
      h.script(
        `
                CREATE TYPE SomeObject6;
                ALTER TYPE SomeObject6 EXTENDING FreeObject;
            `
      );
    }).toThrow(new RegExp("'std::FreeObject' cannot be a parent type"));
  });

  it("test_edgeql_ddl_extending_07", () => {
    h.script(
      `
            create type A;
            create type B extending A;
        `
    );
    expect(() => {
      h.script(
        `
                create type C extending A, B;
            `
      );
    }).toThrow(new RegExp("could not find consistent ancestor order"));
  });

  it("test_edgeql_ddl_modules_01", () => {
    try {
      h.script(
        `
                CREATE MODULE test_other;

                CREATE TYPE ModuleTest01 {
                    CREATE PROPERTY clash -> str;
                };

                CREATE TYPE test_other::Target;
                CREATE TYPE test_other::ModuleTest01 {
                    CREATE LINK clash -> test_other::Target;
                };
            `
      );
      h.script(
        `
                DROP TYPE test_other::ModuleTest01;
                DROP TYPE test_other::Target;
            `
      );
    } finally {
      h.script(
        `
                DROP MODULE test_other;
            `
      );
    }
  });

  it("test_edgeql_ddl_modules_02", () => {
    h.script(
      `
            CREATE MODULE test_other;

            CREATE ABSTRACT TYPE test_other::Named {
                CREATE REQUIRED PROPERTY name -> str;
            };

            CREATE ABSTRACT TYPE test_other::UniquelyNamed
                EXTENDING test_other::Named
            {
                ALTER PROPERTY name {
                    CREATE DELEGATED CONSTRAINT exclusive;
                }
            };

            CREATE TYPE Priority EXTENDING test_other::Named;

            CREATE TYPE Status
                EXTENDING test_other::UniquelyNamed;

            INSERT Priority {name := 'one'};
            INSERT Priority {name := 'two'};
            INSERT Status {name := 'open'};
            INSERT Status {name := 'closed'};
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE test_other
                SELECT Named.name;
            `,
      unorderedSet(["closed", "one", "open", "two"])
    );
    assertQueryResult(
      h,
      `
                WITH MODULE test_other
                SELECT UniquelyNamed.name;
            `,
      unorderedSet(["closed", "open"])
    );
    h.script(
      `
            DROP TYPE Status;
            DROP TYPE Priority;
            DROP TYPE test_other::UniquelyNamed;
            DROP TYPE test_other::Named;
            DROP MODULE test_other;
        `
    );
  });

  it.skip("test_edgeql_ddl_modules_03 [xerror: Currently declarative.py doesn't have the up-to-date module list at the time it tries interpreting the migration. InvalidReferenceError: reference to a non-existent schema item: test_other::UniquelyNamed]", () => {
    h.script(
      `
            CREATE MODULE test_other;

            CREATE ABSTRACT TYPE test_other::Named {
                CREATE REQUIRED PROPERTY name -> str;
            };

            CREATE ABSTRACT TYPE test_other::UniquelyNamed
                EXTENDING test_other::Named
            {
                ALTER PROPERTY name {
                    CREATE DELEGATED CONSTRAINT exclusive;
                }
            };
        `
    );
    try {
      h.script(
        `
                    type Status extending test_other::UniquelyNamed;
                `
      );
      h.script(
        `
                DROP TYPE Status;
            `
      );
    } finally {
      h.script(
        `
                DROP TYPE test_other::UniquelyNamed;
                DROP TYPE test_other::Named;
                DROP MODULE test_other;
            `
      );
    }
  });

  it("test_edgeql_ddl_modules_04", () => {
    h.script(
      `
            CREATE MODULE test_other;

            CREATE ABSTRACT TYPE test_other::Named {
                CREATE REQUIRED PROPERTY name -> str;
            };

            CREATE ABSTRACT TYPE test_other::UniquelyNamed
                EXTENDING test_other::Named
            {
                ALTER PROPERTY name {
                    CREATE DELEGATED CONSTRAINT exclusive;
                }
            };

            CREATE ABSTRACT ANNOTATION whatever;

            CREATE TYPE test_other::Foo;
            CREATE TYPE test_other::Bar {
                CREATE LINK foo -> test_other::Foo;
                CREATE ANNOTATION whatever := "huh";
            };
            ALTER TYPE test_other::Foo {
                CREATE LINK bar -> test_other::Bar;
            };
        `
    );
    expect(() => {
      h.script(
        `
                DROP MODULE test_other;
            `
      );
    }).toThrow(new RegExp("cannot drop module 'test_other' because it is not empty"));
  });

  it("test_edgeql_ddl_modules_05", () => {
    h.script(
      `
            CREATE MODULE foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER MODULE foo RENAME TO bar;
            `
      );
    }).toThrow(new RegExp("renaming modules is not supported"));
  });

  it("test_edgeql_ddl_extension_package_01", () => {
    h.script(
      `
            CREATE EXTENSION PACKAGE foo_01 VERSION '1.0' {
                CREATE MODULE foo_ext;;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::ExtensionPackage {
                    name,
                    script,
                    ver := (.version.major, .version.minor),
                }
                FILTER .name LIKE 'foo_%'
                ORDER BY .name
            `,
      [
            {
              "name": "foo_01",
              "script": "CREATE MODULE foo_ext;;",
              "ver": [1, 0],
            },
          ]
    );
    h.script(
      `
            CREATE EXTENSION PACKAGE foo_01 VERSION '2.0-beta.1' {
                SELECT 1/0;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::ExtensionPackage {
                    name,
                    script,
                    ver := (.version.major, .version.minor, .version.stage),
                }
                FILTER .name LIKE 'foo_%'
                ORDER BY .name THEN .version
            `,
      [
            {
              "name": "foo_01",
              "script": "CREATE MODULE foo_ext;;",
              "ver": [1, 0, "final"],
            },
            {
              "name": "foo_01",
              "script": "SELECT 1/0;",
              "ver": [2, 0, "beta"],
            },
          ]
    );
    h.script(
      `
            DROP EXTENSION PACKAGE foo_01 VERSION '1.0';
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::ExtensionPackage {
                    name,
                    script,
                }
                FILTER .name LIKE 'foo_%'
                ORDER BY .name
            `,
      [
            {
              "name": "foo_01",
              "script": "SELECT 1/0;",
            },
          ]
    );
  });

  it("test_edgeql_ddl_extension_01", () => {
    h.script(
      `
            CREATE EXTENSION PACKAGE MyExtension VERSION '1.0';
            CREATE EXTENSION PACKAGE MyExtension VERSION '1.1';
            CREATE EXTENSION PACKAGE MyExtension VERSION '2.0';
        `
    );
    h.script(
      `
            CREATE EXTENSION MyExtension;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Extension {
                    name,
                    package: {
                        ver := (.version.major, .version.minor)
                    }
                }
                FILTER .name = 'MyExtension'
            `,
      [
            {
              "name": "MyExtension",
              "package": {
                "ver": [2, 0],
              },
            },
          ]
    );
    h.script(
      `
            DROP EXTENSION MyExtension;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Extension {
                    name,
                    package: {
                        ver := (.version.major, .version.minor)
                    }
                }
                FILTER .name = 'MyExtension'
            `,
      []
    );
    h.script(
      `
            CREATE EXTENSION MyExtension VERSION '1.0';
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Extension {
                    name,
                    package: {
                        ver := (.version.major, .version.minor)
                    }
                }
                FILTER .name = 'MyExtension'
            `,
      [
            {
              "name": "MyExtension",
              "package": {
                "ver": [1, 0],
              },
            },
          ]
    );
    expect(() => {
      h.script(
        `
                CREATE EXTENSION MyExtension VERSION '2.0';
            `
      );
    }).toThrow(new RegExp("version 1.0 is already installed"));
    h.script(
      `
            DROP EXTENSION MyExtension;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE EXTENSION MyExtension VERSION '3.0';
            `
      );
    }).toThrow(new RegExp("cannot create extension 'MyExtension': extension package 'MyExtension' version '3.0' does not exist"));
  });

  it("test_edgeql_ddl_extension_02", () => {
    h.script(
      `
            CREATE EXTENSION PACKAGE TestAuthExtension VERSION '1.0' {
                set ext_module := "ext::auth";

                create module ext::auth;

                create type ext::auth::Identity extending std::BaseObject {
                    create required property provider: std::str;
                };

                create type ext::auth::Email extending std::BaseObject {
                    create required property primary: std::bool;
                    create required link identity: ext::auth::Identity;
                    create constraint exclusive on ((.identity, .primary));
                };

                create scalar type ext::auth::JWTAlgo extending enum<RS256>;

                create function ext::auth::_jwt_check_signature(
                    algo: ext::auth::JWTAlgo = ext::auth::JWTAlgo.RS256,
                ) -> bool
                {
                    set volatility := 'Immutable';
                    using (
                        algo = ext::auth::JWTAlgo.RS256
                    );
                };

                create type ext::auth::Config extending std::BaseObject {
                    create property supported_algos:
                        array<ext::auth::JWTAlgo>;
                    create multi property algo_config:
                        tuple<algo: ext::auth::JWTAlgo, cfg: str>;
                };
            }
        `
    );
    h.script(
      `
            CREATE EXTENSION TestAuthExtension;
        `
    );
    h.script(
      `
            DROP EXTENSION TestAuthExtension;
        `
    );
  });

  it("test_edgeql_ddl_role_01", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE ROLE foo_01;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    superuser,
                    password,
                } FILTER .name = 'foo_01'
            `,
      [
            {
              "name": "foo_01",
              "superuser": false,
              "password": null,
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_02", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE SUPERUSER ROLE foo2 {
                SET password := 'secret';
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    superuser,
                } FILTER .name = 'foo2'
            `,
      [
            {
              "name": "foo2",
              "superuser": true,
            },
          ]
    );
    let role = h.query("\n            SELECT sys::Role { password }\n            FILTER .name = 'foo2'\n        ");
    expect(role.password).not.toBeNull();
    h.script(
      `
            ALTER ROLE foo2 {
                SET password := {}
            };
        `
    );
    role = h.query("\n            SELECT sys::Role { password }\n            FILTER .name = 'foo2'\n        ");
    expect(role.password).toBeNull();
  });

  it("test_edgeql_ddl_role_03", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE SUPERUSER ROLE foo3 {
                SET password := 'secret';
            };
        `
    );
    h.script(
      `
            CREATE ROLE foo4 EXTENDING foo3;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    superuser,
                    password,
                    member_of: {
                        name
                    },
                } FILTER .name = 'foo4'
            `,
      [
            {
              "name": "foo4",
              "superuser": false,
              "password": null,
              "member_of": [
                {
                  "name": "foo3",
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER ROLE foo4 DROP EXTENDING foo3;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    member_of: {
                        name
                    },
                } FILTER .name = 'foo4'
            `,
      [
            {
              "name": "foo4",
              "member_of": [],
            },
          ]
    );
    h.script(
      `
            ALTER ROLE foo4 EXTENDING foo3;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    member_of: {
                        name
                    },
                } FILTER .name = 'foo4'
            `,
      [
            {
              "name": "foo4",
              "member_of": [
                {
                  "name": "foo3",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_04", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE SUPERUSER ROLE foo5 IF NOT EXISTS {
                SET password := 'secret';
            };
            CREATE SUPERUSER ROLE foo5 IF NOT EXISTS {
                SET password := 'secret';
            };
            CREATE SUPERUSER ROLE foo5 IF NOT EXISTS {
                SET password := 'secret';
            };
            CREATE ROLE foo6 EXTENDING foo5 IF NOT EXISTS;
            CREATE ROLE foo6 EXTENDING foo5 IF NOT EXISTS;
            CREATE ROLE foo6 EXTENDING foo5 IF NOT EXISTS;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    superuser,
                    password,
                    member_of: {
                        name
                    },
                } FILTER .name = 'foo6'
            `,
      [
            {
              "name": "foo6",
              "superuser": false,
              "password": null,
              "member_of": [
                {
                  "name": "foo5",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_05", () => {
    if (has_create_role) {
      self.skipTest("create role is supported by the backend");
    }
    let con = connect();
    try {
      h.script(
        "\n                ALTER ROLE edgedb SET password := 'test_role_05'\n            "
      );
      if (has_create_database) {
        h.script(
          "CREATE DATABASE test_role_05"
        );
      }
    } finally {
      // ignored awaited call: con.aclose
    }
    if (has_create_database) {
      ({
  "password": "test_role_05",
})["database"] = "test_role_05";
    }
    con = connect();
    try {
      h.script(
        "\n                ALTER ROLE edgedb SET password := 'test'\n            "
      );
    } finally {
      // ignored awaited call: con.aclose
    }
    con = connect();
    try {
      if (has_create_database) {
        // ignored awaited call: tb.drop_db
      }
    } finally {
      // ignored awaited call: con.aclose
    }
  });

  it("test_edgeql_ddl_role_06", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE ROLE foo_06;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    permissions,
                } FILTER .name = 'foo_06'
            `,
      [
            {
              "name": "foo_06",
              "permissions": [],
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_07", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE ROLE foo_07 {
                SET permissions := default::foo
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    permissions,
                } FILTER .name = 'foo_07'
            `,
      [
            {
              "name": "foo_07",
              "permissions": ["default::foo"],
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_08", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE ROLE foo_08 {
                SET permissions := {
                    default::foo, custom::bar, sys::perm::data_modification
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    permissions,
                } FILTER .name = 'foo_08'
            `,
      [
            {
              "name": "foo_08",
              "permissions": ["custom::bar", "default::foo", "sys::perm::data_modification"],
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_09", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE ROLE foo_09;
        `
    );
    h.script(
      `
            ALTER ROLE foo_09 {
                SET permissions := default::foo
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    permissions,
                } FILTER .name = 'foo_09'
            `,
      [
            {
              "name": "foo_09",
              "permissions": ["default::foo"],
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_10", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE ROLE foo_10;
        `
    );
    h.script(
      `
            ALTER ROLE foo_10 {
                SET permissions := {
                    default::foo, custom::bar, sys::perm::data_modification
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    permissions,
                } FILTER .name = 'foo_10'
            `,
      [
            {
              "name": "foo_10",
              "permissions": ["custom::bar", "default::foo", "sys::perm::data_modification"],
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_11", () => {
    expect(() => {
      h.script(
        `
                create superuser role foo_11a {
                    set permissions := sys::perm::superuser;
                };
            `
      );
    }).toThrow(new RegExp("Permission \"sys::perm::superuser\" cannot be explicitly granted"));
    expect(() => {
      h.script(
        `
                create superuser role foo_11b {
                    set permissions := { sys::perm::superuser, default::foo };
                };
            `
      );
    }).toThrow(new RegExp("Permission \"sys::perm::superuser\" cannot be explicitly granted"));
    expect(() => {
      h.script(
        `
                create role foo_11c {
                    set permissions := sys::perm::superuser;
                };
            `
      );
    }).toThrow(new RegExp("Permission \"sys::perm::superuser\" cannot be explicitly granted"));
    expect(() => {
      h.script(
        `
                create role foo_11d {
                    set permissions := { sys::perm::superuser, default::foo };
                };
            `
      );
    }).toThrow(new RegExp("Permission \"sys::perm::superuser\" cannot be explicitly granted"));
    h.script(
      `
            create superuser role foo_11e {
                set permissions := default::foo
            };
        `
    );
    expect(() => {
      h.script(
        `
                alter role foo_11e {
                    set permissions := sys::perm::superuser;
                };
            `
      );
    }).toThrow(new RegExp("Permission \"sys::perm::superuser\" cannot be explicitly granted"));
    expect(() => {
      h.script(
        `
                alter role foo_11e {
                    set permissions := { sys::perm::superuser, default::foo };
                };
            `
      );
    }).toThrow(new RegExp("Permission \"sys::perm::superuser\" cannot be explicitly granted"));
    h.script(
      `
            create role foo_11f {
                set permissions := default::foo
            };
        `
    );
    expect(() => {
      h.script(
        `
                alter role foo_11f {
                    set permissions := sys::perm::superuser;
                };
            `
      );
    }).toThrow(new RegExp("Permission \"sys::perm::superuser\" cannot be explicitly granted"));
    expect(() => {
      h.script(
        `
                alter role foo_11f {
                    set permissions := { sys::perm::superuser, default::foo };
                };
            `
      );
    }).toThrow(new RegExp("Permission \"sys::perm::superuser\" cannot be explicitly granted"));
  });

  it("test_edgeql_ddl_role_permission_inheritance_01", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE ROLE perm_inh_01_a {
                SET permissions := default::foo
            };
            CREATE ROLE perm_inh_01_b {
                SET permissions := default::foo
            };
            CREATE ROLE perm_inh_01_c {
                SET permissions := { custom::bar, custom::baz }
            };
            CREATE ROLE perm_inh_01_d EXTENDING perm_inh_01_a;
            CREATE ROLE perm_inh_01_e EXTENDING perm_inh_01_a, perm_inh_01_b;
            CREATE ROLE perm_inh_01_f EXTENDING perm_inh_01_a, perm_inh_01_b {
                SET permissions := default::foo
            };
            CREATE ROLE perm_inh_01_g EXTENDING perm_inh_01_a, perm_inh_01_c;
            CREATE ROLE perm_inh_01_h EXTENDING perm_inh_01_a {
                SET permissions := sys::perm::data_modification
            };
            CREATE ROLE perm_inh_01_i EXTENDING perm_inh_01_h, perm_inh_01_c;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT sys::Role {
                    name,
                    permissions,
                    all_permissions,
                }
                FILTER contains(.name, 'perm_inh_01')
                ORDER BY .name
            `,
      [
            {
              "name": "perm_inh_01_a",
              "permissions": ["default::foo"],
              "all_permissions": unorderedBag(["default::foo"]),
            },
            {
              "name": "perm_inh_01_b",
              "permissions": ["default::foo"],
              "all_permissions": unorderedBag(["default::foo"]),
            },
            {
              "name": "perm_inh_01_c",
              "permissions": ["custom::bar", "custom::baz"],
              "all_permissions": unorderedBag(["custom::bar", "custom::baz"]),
            },
            {
              "name": "perm_inh_01_d",
              "permissions": [],
              "all_permissions": unorderedBag(["default::foo"]),
            },
            {
              "name": "perm_inh_01_e",
              "permissions": [],
              "all_permissions": unorderedBag(["default::foo"]),
            },
            {
              "name": "perm_inh_01_f",
              "permissions": ["default::foo"],
              "all_permissions": unorderedBag(["default::foo"]),
            },
            {
              "name": "perm_inh_01_g",
              "permissions": [],
              "all_permissions": unorderedBag(["custom::bar", "custom::baz", "default::foo"]),
            },
            {
              "name": "perm_inh_01_h",
              "permissions": ["sys::perm::data_modification"],
              "all_permissions": unorderedBag(["default::foo", "sys::perm::data_modification"]),
            },
            {
              "name": "perm_inh_01_i",
              "permissions": [],
              "all_permissions": unorderedBag(["custom::bar", "custom::baz", "default::foo", "sys::perm::data_modification"]),
            },
          ]
    );
  });

  it("test_edgeql_ddl_role_permission_inheritance_02", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE ROLE perm_inh_02_a {
                SET permissions := default::foo
            };
            CREATE ROLE perm_inh_02_b {
                SET permissions := custom::bar
            };
            CREATE ROLE perm_inh_02_c extending perm_inh_02_a {
                SET permissions := custom::baz
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT sys::Role {
                name,
                permissions,
                all_permissions,
            }
            FILTER contains(.name, 'perm_inh_02')
            ORDER BY .name
        `,
      [
            {
              "name": "perm_inh_02_a",
              "permissions": ["default::foo"],
              "all_permissions": unorderedBag(["default::foo"]),
            },
            {
              "name": "perm_inh_02_b",
              "permissions": ["custom::bar"],
              "all_permissions": unorderedBag(["custom::bar"]),
            },
            {
              "name": "perm_inh_02_c",
              "permissions": ["custom::baz"],
              "all_permissions": unorderedBag(["default::foo", "custom::baz"]),
            },
          ]
    );
    h.script(
      `
            ALTER ROLE perm_inh_02_c {
                DROP EXTENDING perm_inh_02_a
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT sys::Role {
                name,
                permissions,
                all_permissions,
            }
            FILTER contains(.name, 'perm_inh_02')
            ORDER BY .name
        `,
      [
            {
              "name": "perm_inh_02_a",
              "permissions": ["default::foo"],
              "all_permissions": unorderedBag(["default::foo"]),
            },
            {
              "name": "perm_inh_02_b",
              "permissions": ["custom::bar"],
              "all_permissions": unorderedBag(["custom::bar"]),
            },
            {
              "name": "perm_inh_02_c",
              "permissions": ["custom::baz"],
              "all_permissions": unorderedBag(["custom::baz"]),
            },
          ]
    );
    h.script(
      `
            ALTER ROLE perm_inh_02_c {
                EXTENDING perm_inh_02_b
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT sys::Role {
                name,
                permissions,
                all_permissions,
            }
            FILTER contains(.name, 'perm_inh_02')
            ORDER BY .name
        `,
      [
            {
              "name": "perm_inh_02_a",
              "permissions": ["default::foo"],
              "all_permissions": unorderedBag(["default::foo"]),
            },
            {
              "name": "perm_inh_02_b",
              "permissions": ["custom::bar"],
              "all_permissions": unorderedBag(["custom::bar"]),
            },
            {
              "name": "perm_inh_02_c",
              "permissions": ["custom::baz"],
              "all_permissions": unorderedBag(["custom::bar", "custom::baz"]),
            },
          ]
    );
  });

  it("test_edgeql_ddl_describe_roles", () => {
    if ((!has_create_role)) {
      self.skipTest("create role is not supported by the backend");
    }
    h.script(
      `
            CREATE SUPERUSER ROLE base1;
            CREATE SUPERUSER ROLE \`base 2\`;
            CREATE SUPERUSER ROLE child1 EXTENDING base1;
            CREATE SUPERUSER ROLE child2 EXTENDING \`base 2\`;
            CREATE SUPERUSER ROLE child3 EXTENDING base1, child2 {
                SET password := 'test_a';
            };
            CREATE ROLE subuser1;
            CREATE ROLE subuser2 EXTENDING subuser1 {
                SET password := 'test_b';
            };
            CREATE ROLE subuser3 EXTENDING subuser1 {
                SET permissions := default::foo;
            };
            CREATE ROLE subuser4 EXTENDING subuser1 {
                SET password := 'test_c';
                SET permissions := {
                    default::foo, custom::bar, sys::perm::data_modification
                };
            };
            CREATE ROLE subuser5 EXTENDING subuser3;
            CREATE ROLE subuser6 EXTENDING subuser3 {
                SET permissions := custom::bar;
            };
        `
    );
    let roles = cast("str", next(iter(h.query("DESCRIBE ROLES"))));
    let base1 = _look_for("CREATE SUPERUSER ROLE `base1`;");
    let base2 = _look_for("CREATE SUPERUSER ROLE `base 2`;");
    let child1 = _look_for("CREATE SUPERUSER ROLE `child1` EXTENDING `base1`;");
    let child2 = _look_for("CREATE SUPERUSER ROLE `child2` EXTENDING `base 2`;");
    let child3 = _look_for("CREATE SUPERUSER ROLE `child3` EXTENDING `base1`, `child2` { SET password_hash := 'SCRAM-SHA-256\\$4096:.{114}'; };");
    let subuser1 = _look_for("CREATE ROLE `subuser1`;");
    let subuser2 = _look_for("CREATE ROLE `subuser2` EXTENDING `subuser1` { SET password_hash := 'SCRAM-SHA-256\\$4096:.{114}'; };");
    let subuser3 = _look_for("CREATE ROLE `subuser3` EXTENDING `subuser1` { SET permissions := { default::foo }; };");
    let subuser4 = _look_for("CREATE ROLE `subuser4` EXTENDING `subuser1` { SET password_hash := 'SCRAM-SHA-256\\$4096:.{114}'; SET permissions := { custom::bar, default::foo, sys::perm::data_modification }; };");
    let subuser5 = _look_for("CREATE ROLE `subuser5` EXTENDING `subuser3`;");
    let subuser6 = _look_for("CREATE ROLE `subuser6` EXTENDING `subuser3` { SET permissions := { custom::bar }; };");
    expect(child1).toBeGreaterThan(base1);
    expect(child2).toBeGreaterThan(base2);
    expect(child3).toBeGreaterThan(child2);
    expect(child3).toBeGreaterThan(base1);
    expect(subuser2).toBeGreaterThan(subuser1);
    expect(subuser3).toBeGreaterThan(subuser1);
    expect(subuser4).toBeGreaterThan(subuser1);
    expect(subuser5).toBeGreaterThan(subuser3);
    expect(subuser6).toBeGreaterThan(subuser3);
  });

  it("test_edgeql_ddl_describe_schema", () => {
    let result = h.query("\n            DESCRIBE MODULE std\n        ");
    let result_stripped = lower();
    expect(((result_stripped) as any).includes("createscalartypestd::float32extendingstd::anyfloat;")).toBeTruthy();
    expect(((result_stripped) as any).includes("createfunctionstd::str_lower(s:std::str)->std::str{setvolatility:='immutable';createannotationstd::description:='returnalowercasecopyoftheinput*string*.';usingsqlfunction'lower';};")).toBeTruthy();
    expect(((result_stripped) as any).includes("createinfixoperatorstd::`and`(a:std::bool,b:std::bool)->std::bool{setvolatility:='immutable';createannotationstd::description:='logicalconjunction.';usingsqlexpression;};")).toBeTruthy();
    expect(((result_stripped) as any).includes("createabstractinfixoperatorstd::`>=`(l:anytype,r:anytype)->std::bool;")).toBeTruthy();
    expect(((result_stripped) as any).includes("createcastfromstd::strtostd::bool{setvolatility:='immutable';usingsqlfunction'edgedb.str_to_bool';};")).toBeTruthy();
    expect(((result_stripped) as any).includes("createcastfromstd::int64tostd::int16{setvolatility:='immutable';usingsqlcast;allowassignment;};")).toBeTruthy();
  });

  it("test_edgeql_ddl_rename_01", () => {
    h.script(
      `
            CREATE TYPE RenameObj01 {
                CREATE PROPERTY name -> str;
            };

            INSERT RenameObj01 {name := 'rename 01'};

            ALTER TYPE RenameObj01 {
                RENAME TO NewNameObj01;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT NewNameObj01.name;
            `,
      ["rename 01"]
    );
  });

  it("test_edgeql_ddl_rename_02", () => {
    h.script(
      `
            CREATE TYPE RenameObj02 {
                CREATE PROPERTY name -> str;
            };

            INSERT RenameObj02 {name := 'rename 02'};

            ALTER TYPE RenameObj02 {
                ALTER PROPERTY name {
                    RENAME TO new_name_02;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT RenameObj02.new_name_02;
            `,
      ["rename 02"]
    );
  });

  it("test_edgeql_ddl_rename_03", () => {
    h.script(
      `

            CREATE TYPE RenameObj03 {
                CREATE PROPERTY name -> str;
            };

            INSERT RenameObj03 {name := 'rename 03'};

            ALTER TYPE RenameObj03 {
                ALTER PROPERTY name {
                    RENAME TO new_name_03;
                };
            };

            RESET MODULE;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT RenameObj03.new_name_03;
            `,
      ["rename 03"]
    );
  });

  it("test_edgeql_ddl_rename_04", () => {
    h.script(
      `
            CREATE ABSTRACT LINK rename_link_04 {
                CREATE PROPERTY rename_prop_04 -> std::int64;
            };

            CREATE TYPE LinkedObj04;
            CREATE TYPE RenameObj04 {
                CREATE MULTI LINK rename_link_04 EXTENDING rename_link_04
                    -> LinkedObj04;
            };

            INSERT LinkedObj04;
            INSERT RenameObj04 {
                rename_link_04 := LinkedObj04 {@rename_prop_04 := 123}
            };

            ALTER ABSTRACT LINK rename_link_04 {
                ALTER PROPERTY rename_prop_04 {
                    RENAME TO new_prop_04;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT RenameObj04.rename_link_04@new_prop_04;
            `,
      [123]
    );
  });

  it("test_edgeql_ddl_rename_05", () => {
    h.script(
      `
            CREATE TYPE GrandParent01 {
                CREATE PROPERTY foo -> int64;
            };

            CREATE TYPE Parent01 EXTENDING GrandParent01;
            CREATE TYPE Parent02 EXTENDING GrandParent01;

            CREATE TYPE Child EXTENDING Parent01, Parent02;

            ALTER TYPE GrandParent01 {
                ALTER PROPERTY foo RENAME TO renamed;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Child.renamed;
            `,
      []
    );
  });

  it("test_edgeql_ddl_rename_06", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Parent01 {
                    CREATE PROPERTY foo -> int64;
                };

                CREATE TYPE Parent02 {
                    CREATE PROPERTY foo -> int64;
                };

                CREATE TYPE Child
                    EXTENDING Parent01, Parent02;

                ALTER TYPE Parent02 {
                    ALTER PROPERTY foo RENAME TO renamed;
                };
            `
      );
    }).toThrow(new RegExp("cannot rename inherited property 'foo'"));
  });

  it("test_edgeql_ddl_rename_07", () => {
    h.script(
      `
            CREATE TYPE Foo;

            CREATE TYPE Bar {
                CREATE MULTI LINK foo -> Foo {
                    SET default := (SELECT Foo);
                }
            };

            ALTER TYPE Foo RENAME TO FooRenamed;
        `
    );
  });

  it("test_edgeql_ddl_rename_abs_ptr_01", () => {
    h.script(
      `
            CREATE ABSTRACT LINK abs_link {
                CREATE PROPERTY prop -> std::int64;
            };

            CREATE TYPE LinkedObj;
            CREATE TYPE RenameObj {
                CREATE MULTI LINK link EXTENDING abs_link
                    -> LinkedObj;
            };

            INSERT LinkedObj;
            INSERT RenameObj {
                link := LinkedObj {@prop := 123}
            };
        `
    );
    h.script(
      `
            ALTER ABSTRACT LINK abs_link
            RENAME TO new_abs_link;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT RenameObj.link@prop;
            `,
      [123]
    );
    h.script(
      `
            CREATE TYPE RenameObj2 {
                CREATE MULTI LINK link EXTENDING new_abs_link
                    -> LinkedObj;
            };
        `
    );
    h.script(
      `
            CREATE ABSTRACT LINK abs_link {
                CREATE PROPERTY prop -> std::int64;
            };
        `
    );
    h.script(
      `
            CREATE MODULE foo;

            ALTER ABSTRACT LINK new_abs_link
            RENAME TO foo::new_abs_link2;
        `
    );
    h.script(
      `
            ALTER TYPE RenameObj DROP LINK link;
            ALTER TYPE RenameObj2 DROP LINK link;
            DROP ABSTRACT LINK foo::new_abs_link2;
        `
    );
  });

  it("test_edgeql_ddl_rename_abs_ptr_02", () => {
    h.script(
      `
            CREATE ABSTRACT PROPERTY abs_prop {
                CREATE ANNOTATION title := "lol";
            };

            CREATE TYPE RenameObj {
                CREATE PROPERTY prop EXTENDING abs_prop -> str;
            };
        `
    );
    h.script(
      `
            ALTER ABSTRACT PROPERTY abs_prop
            RENAME TO new_abs_prop;
        `
    );
    h.script(
      `
            CREATE TYPE RenameObj2 {
                CREATE PROPERTY prop EXTENDING new_abs_prop -> str;
            };
        `
    );
    h.script(
      `
            CREATE ABSTRACT PROPERTY abs_prop {
                CREATE ANNOTATION title := "lol";
            };
        `
    );
    h.script(
      `
            CREATE MODULE foo;

            ALTER ABSTRACT PROPERTY new_abs_prop
            RENAME TO foo::new_abs_prop2;
        `
    );
    h.script(
      `
            ALTER TYPE RenameObj DROP PROPERTY prop;
            ALTER TYPE RenameObj2 DROP PROPERTY prop;
            DROP ABSTRACT PROPERTY foo::new_abs_prop2;
        `
    );
  });

  it("test_edgeql_ddl_rename_annotated_01", () => {
    h.script(
      `
            CREATE TYPE RenameObj {
                CREATE PROPERTY prop -> str {
                   CREATE ANNOTATION title := "lol";
                }
            };
        `
    );
    h.script(
      `
            ALTER TYPE RenameObj {
                ALTER PROPERTY prop RENAME TO prop2;
            };
        `
    );
  });

  it("test_edgeql_ddl_delete_abs_link_01", () => {
    h.script(
      `
            CREATE ABSTRACT LINK abs_link;
        `
    );
    h.script(
      `
            DROP ABSTRACT LINK abs_link;
        `
    );
  });

  it("test_edgeql_ddl_alias_01", () => {
    h.script(
      `

            CREATE TYPE User {
                CREATE REQUIRED PROPERTY name -> str;
            };

            CREATE TYPE Award {
                CREATE LINK user -> User;
            };

            CREATE ALIAS Alias1 := Award {
                user2 := (SELECT .user {name2 := .name ++ '!'})
            };

            CREATE ALIAS Alias2 := Alias1;

            INSERT Award { user := (INSERT User { name := 'Corvo' }) };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Alias1 {
                    user2: {
                        name2
                    }
                }
            `,
      [
            {
              "user2": {
                "name2": "Corvo!",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Alias2 {
                    user2: {
                        name2
                    }
                }
            `,
      [
            {
              "user2": {
                "name2": "Corvo!",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_alias_02", () => {
    h.script(
      `

            CREATE TYPE User {
                CREATE REQUIRED PROPERTY name -> str;
            };

            CREATE TYPE Award {
                CREATE REQUIRED PROPERTY name -> str;
            };

            CREATE ALIAS Alias1 := Award {
                a_user := (SELECT User { name } LIMIT 1)
            };

            CREATE ALIAS Alias2 := Alias1;

            INSERT User { name := 'Corvo' };
            INSERT Award { name := 'Rune' };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Alias1 {
                    a_user: {
                        name
                    }
                }
            `,
      [
            {
              "a_user": {
                "name": "Corvo",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT Alias2 {
                    a_user: {
                        name
                    }
                }
            `,
      [
            {
              "a_user": {
                "name": "Corvo",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_alias_03", () => {
    h.script(
      `
            CREATE ALIAS RenameAlias03 := (
                SELECT BaseObject {
                    alias_computable := 'rename alias 03'
                }
            );

            ALTER ALIAS RenameAlias03 {
                RENAME TO NewAlias03;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT NewAlias03.alias_computable LIMIT 1;
            `,
      ["rename alias 03"]
    );
    h.script(
      `
            CREATE MODULE foo;

            ALTER ALIAS NewAlias03 {
                RENAME TO foo::NewAlias03;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT foo::NewAlias03.alias_computable LIMIT 1;
            `,
      ["rename alias 03"]
    );
    h.script(
      `
            DROP ALIAS foo::NewAlias03;
        `
    );
  });

  it("test_edgeql_ddl_alias_04", () => {
    h.script(
      `
            CREATE ALIAS DupAlias04_1 := BaseObject {
                foo := 'hello world 04'
            };

            # create an identical alias with a different name
            CREATE ALIAS DupAlias04_2 := BaseObject {
                foo := 'hello world 04'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT DupAlias04_1.foo LIMIT 1;
            `,
      ["hello world 04"]
    );
    assertQueryResult(
      h,
      `
                SELECT DupAlias04_2.foo LIMIT 1;
            `,
      ["hello world 04"]
    );
  });

  it("test_edgeql_ddl_alias_05", () => {
    h.script(
      `

            CREATE TYPE BaseType05 {
                CREATE PROPERTY name -> str;
            };

            CREATE ALIAS BT05Alias1 := BaseType05 {
                a := .name ++ '_more'
            };

            # alias of an alias
            CREATE ALIAS BT05Alias2 := BT05Alias1 {
                b := .a ++ '_stuff'
            };

            INSERT BaseType05 {name := 'bt05'};
        `
    );
    assertQueryResult(
      h,
      `
                SELECT BT05Alias1 {name, a};
            `,
      [
            {
              "name": "bt05",
              "a": "bt05_more",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT BT05Alias2 {name, a, b};
            `,
      [
            {
              "name": "bt05",
              "a": "bt05_more",
              "b": "bt05_more_stuff",
            },
          ]
    );
  });

  it("test_edgeql_ddl_alias_06", () => {
    h.script(
      `

            CREATE TYPE BaseType06 {
                CREATE PROPERTY name -> str;
            };

            INSERT BaseType06 {
                name := 'bt06',
            };

            INSERT BaseType06 {
                name := 'bt06_1',
            };

            CREATE ALIAS BT06Alias1 := BaseType06 {
                a := .name ++ '_a'
            };

            CREATE ALIAS BT06Alias2 := BT06Alias1 {
                b := .a ++ '_b'
            };

            CREATE ALIAS BT06Alias3 := BaseType06 {
                b := BT06Alias1
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT BT06Alias1 {name, a} FILTER .name = 'bt06';
            `,
      [
            {
              "name": "bt06",
              "a": "bt06_a",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT BT06Alias2 {name, a, b} FILTER .name = 'bt06';
            `,
      [
            {
              "name": "bt06",
              "a": "bt06_a",
              "b": "bt06_a_b",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT BT06Alias3 {
                    name,
                    b: {name, a} ORDER BY .name
                }
                FILTER .name = 'bt06';
            `,
      [
            {
              "name": "bt06",
              "b": [
                {
                  "name": "bt06",
                  "a": "bt06_a",
                },
                {
                  "name": "bt06_1",
                  "a": "bt06_1_a",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_alias_07", () => {
    expect(() => {
      h.script(
        `
                CREATE ALIAS IllegalAlias07 := Object {a := IllegalAlias07};
            `
      );
    }).toThrow(new RegExp("illegal self-reference in definition of 'default::IllegalAlias07'"));
  });

  it("test_edgeql_ddl_alias_08", () => {
    h.script(
      `

            CREATE TYPE BaseType08 {
                CREATE PROPERTY name -> str;
            };

            INSERT BaseType08 {
                name := 'bt08',
            };

            CREATE ALIAS BT08Alias1 := BaseType08 {
                a := .name ++ '_a'
            };

            CREATE ALIAS BT08Alias2 := BT08Alias1 {
                b := .a ++ '_b'
            };

            # drop the freshly created alias
            DROP ALIAS BT08Alias2;

            # re-create the alias that was just dropped
            CREATE ALIAS BT08Alias2 := BT08Alias1 {
                b := .a ++ '_bb'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT BT08Alias1 {name, a} FILTER .name = 'bt08';
            `,
      [
            {
              "name": "bt08",
              "a": "bt08_a",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT BT08Alias2 {name, a, b} FILTER .name = 'bt08';
            `,
      [
            {
              "name": "bt08",
              "a": "bt08_a",
              "b": "bt08_a_bb",
            },
          ]
    );
  });

  it("test_edgeql_ddl_alias_09", () => {
    h.script(
      `
            CREATE ALIAS CreateAlias09 := (
                SELECT BaseObject {
                    alias_computable := 'rename alias 03'
                }
            );
        `
    );
    expect(() => {
      h.script(
        `
                CREATE TYPE AliasType09 {
                    CREATE OPTIONAL SINGLE LINK a -> CreateAlias09;
                }
            `
      );
    }).toThrow(new RegExp("invalid link type: 'default::CreateAlias09' is an expression alias, not a proper object type"));
  });

  it("test_edgeql_ddl_alias_10", () => {
    h.script(
      `
            create type Foo;
            create type Bar;
            create alias X := Foo { bar := Bar { z := 1 } };
            alter alias X using (Bar);
        `
    );
  });

  it("test_edgeql_ddl_alias_11", () => {
    h.script(
      `
            create type X;
            create alias Z := (with lol := X, select count(lol));
        `
    );
    h.script(
      `
            drop alias Z
        `
    );
    h.script(
      `
            create alias Z := (with lol := X, select count(lol));
        `
    );
  });

  it("test_edgeql_ddl_alias_12", () => {
    h.script(
      `
            create alias X := 1;
            create type Y;
            create global Z -> int64;
            `
    );
    expect(() => {
      h.script(
        `
                create alias X := 2;
                `
      );
    }).toThrow(new RegExp("scalar type 'default::X' already exists"));
    expect(() => {
      h.script(
        `
                create alias Y := 2;
                `
      );
    }).toThrow(new RegExp("type 'default::Y' already exists"));
    expect(() => {
      h.script(
        `
                create alias Z := 2;
                `
      );
    }).toThrow(new RegExp("global 'default::Z' already exists"));
  });

  it("test_edgeql_ddl_alias_13", () => {
    h.script(
      `
            create alias ArrAlias := [range(0, 1)];
        `
    );
    assertQueryResult(
      h,
      `
                select ArrAlias = [range(0, 1)];
            `,
      [true]
    );
  });

  it("test_edgeql_ddl_alias_14", () => {
    h.script(
      `
            create global One := 1;
            create alias MyAlias := global One;
        `
    );
    expect(() => {
      h.script(
        `
                create type Foo { create index on (MyAlias) };
                `
      );
    }).toThrow(new RegExp("index expressions must be immutable"));
  });

  it("test_edgeql_ddl_alias_15", () => {
    h.script(
      `
            create global One := 1;
            create alias MyAlias := 1;
            create type Foo { create index on (MyAlias) };
            `
    );
    expect(() => {
      h.script(
        `
                alter alias MyAlias {using (global One)};
                `
      );
    }).toThrow(new RegExp("cannot alter alias 'default::MyAlias' because this affects expression of index of object type 'default::Foo'"));
  });

  it("test_edgeql_ddl_alias_type_changes_01", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_02", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_03", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_04", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_05", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_06", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_07", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_08", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_09", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_10", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_11", () => {
    _check_ddl_global_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_12", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_alias_type_changes_13", () => {
    _check_ddl_alias_type_changes();
  });

  it("test_edgeql_ddl_inheritance_alter_01", () => {
    h.script(
      `
            CREATE TYPE InhTest01 {
                CREATE PROPERTY testp -> int64;
            };

            CREATE TYPE InhTest01_child EXTENDING InhTest01;
        `
    );
    h.script(
      `
            ALTER TYPE InhTest01 {
                DROP PROPERTY testp;
            }
        `
    );
  });

  it("test_edgeql_ddl_inheritance_alter_02", () => {
    h.script(
      `
            CREATE TYPE InhTest01 {
                CREATE PROPERTY testp -> int64;
            };

            CREATE TYPE InhTest01_child EXTENDING InhTest01;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE InhTest01_child {
                    DROP PROPERTY testp;
                }
            `
      );
    }).toThrow(new RegExp("cannot drop inherited property 'testp'"));
  });

  it("test_edgeql_ddl_inheritance_alter_03", () => {
    h.script(
      `
            CREATE TYPE Owner;

            CREATE TYPE Stuff1 {
                # same link name, but NOT related via explicit inheritance
                CREATE LINK owner -> Owner
            };

            CREATE TYPE Stuff2 {
                # same link name, but NOT related via explicit inheritance
                CREATE LINK owner -> Owner
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT Owner.<owner;
        `,
      []
    );
  });

  it("test_edgeql_ddl_inheritance_alter_04", () => {
    h.script(
      `
            CREATE TYPE InhTest04 {
                CREATE PROPERTY testp -> int64;
            };

            CREATE TYPE InhTest04_child EXTENDING InhTest04;
        `
    );
    h.script(
      `
            ALTER TYPE InhTest04_child {
                ALTER PROPERTY testp {
                    SET default := 42;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    properties: {
                        name,
                        default,
                    }
                    FILTER .name = 'testp',
                }
                FILTER .name = 'default::InhTest04_child';
            `,
      [
            {
              "properties": [
                {
                  "name": "testp",
                  "default": "42",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_constraint_01", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE BaseTypeCon01;
            CREATE TYPE TypeCon01 EXTENDING BaseTypeCon01;
            ALTER TYPE BaseTypeCon01
                CREATE SINGLE PROPERTY name -> std::str;
            # make sure that we can create a constraint in the base
            # type now
            ALTER TYPE BaseTypeCon01
                ALTER PROPERTY name
                    CREATE DELEGATED CONSTRAINT exclusive;
        `
    );
    assertQueryResult(
      h,
      `
            WITH MODULE schema
            SELECT ObjectType {
                name,
                properties: {
                    name,
                    constraints: {
                        name,
                        delegated,
                    }
                } FILTER .name = 'name'
            }
            FILTER .name LIKE 'default::%TypeCon01'
            ORDER BY .name;
        `,
      [
            {
              "name": "default::BaseTypeCon01",
              "properties": [
                {
                  "name": "name",
                  "constraints": [
                    {
                      "name": "std::exclusive",
                      "delegated": true,
                    },
                  ],
                },
              ],
            },
            {
              "name": "default::TypeCon01",
              "properties": [
                {
                  "name": "name",
                  "constraints": [
                    {
                      "name": "std::exclusive",
                      "delegated": false,
                    },
                  ],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_constraint_02", () => {
    expect(() => {
      h.script(
        `
                    CREATE ABSTRACT CONSTRAINT aaa EXTENDING max_len_value;

                    CREATE SCALAR TYPE foo EXTENDING str {
                        CREATE CONSTRAINT aaa(10);
                    };
                `
      );
    }).toThrow(new RegExp("must define parameters"));
  });

  it("test_edgeql_ddl_constraint_03", () => {
    h.script(
      `
            CREATE TYPE TypeCon03 {
                CREATE PROPERTY name -> str {
                    # emulating "required"
                    CREATE CONSTRAINT expression ON (EXISTS __subject__)
                }
            };
        `
    );
    h.script(
      `
            INSERT TypeCon03 {name := 'OK'};
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT TypeCon03;
                `
      );
    }).toThrow(new RegExp("invalid name"));
  });

  it.skip("test_edgeql_ddl_constraint_04 [xerror: Reports an schema error. Maybe that is exactly what we want?]", () => {
    h.script(
      `
            CREATE TYPE TypeCon04 {
                CREATE MULTI PROPERTY name -> str {
                    # emulating "required"
                    CREATE CONSTRAINT expression ON (EXISTS __subject__)
                }
            };
        `
    );
    h.script(
      `
            INSERT TypeCon04 {name := 'OK'};
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT TypeCon04 {name := {}};
                `
      );
    }).toThrow(new RegExp("invalid name"));
    expect(() => {
      h.script(
        `
                    INSERT TypeCon04;
                `
      );
    }).toThrow(new RegExp("invalid name"));
  });

  it("test_edgeql_ddl_constraint_05", () => {
    h.script(
      `
            CREATE TYPE Child05;
            CREATE TYPE TypeCon05 {
                CREATE LINK child -> Child05 {
                    # emulating "required"
                    CREATE CONSTRAINT expression ON (EXISTS __subject__)
                }
            };
        `
    );
    h.script(
      `
            INSERT Child05;
            INSERT TypeCon05 {child := (SELECT Child05 LIMIT 1)};
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT TypeCon05;
                `
      );
    }).toThrow(new RegExp("invalid child"));
  });

  it.skip("test_edgeql_ddl_constraint_06 [xerror: Reports an schema error. Maybe that is exactly what we want?]", () => {
    h.script(
      `
            CREATE TYPE Child06;
            CREATE TYPE TypeCon06 {
                CREATE MULTI LINK children -> Child06 {
                    # emulating "required"
                    CREATE CONSTRAINT expression ON (EXISTS __subject__)
                }
            };
        `
    );
    h.script(
      `
            INSERT Child06;
            INSERT TypeCon06 {children := Child06};
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT TypeCon06;
                `
      );
    }).toThrow(new RegExp("invalid children"));
  });

  it("test_edgeql_ddl_constraint_07", () => {
    h.script(
      `
            CREATE TYPE Child07;
            CREATE TYPE TypeCon07 {
                CREATE LINK child -> Child07 {
                    CREATE PROPERTY index -> int64;
                    # emulating "required"
                    CREATE CONSTRAINT expression ON (EXISTS __subject__@index)
                }
            };
        `
    );
    h.script(
      `
            INSERT Child07;
            INSERT TypeCon07 {
                child := (SELECT Child07 LIMIT 1){@index := 0}
            };
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT TypeCon07 {
                        child := (SELECT Child07 LIMIT 1)
                    };
                `
      );
    }).toThrow(new RegExp("invalid child"));
  });

  it("test_edgeql_ddl_constraint_08", () => {
    h.script(
      `
            CREATE TYPE Base {
                CREATE PROPERTY x -> str {
                    CREATE CONSTRAINT exclusive;
                }
            };
            CREATE TYPE Foo EXTENDING Base;
            CREATE TYPE Bar EXTENDING Base;

            INSERT Foo { x := "a" };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo { x := "a" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_09", () => {
    h.script(
      `

            CREATE ABSTRACT TYPE Text {
                CREATE REQUIRED SINGLE PROPERTY body -> str {
                    CREATE CONSTRAINT max_len_value(10000);
                };
            };
            CREATE TYPE Comment EXTENDING Text;
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Constraint {
                name, params: {name, @index} order by @index
            }
            filter .name = 'std::max_len_value'
            and .subject.name = 'body'
            and .subject[is schema::Pointer].source.name ='default::Text';
            `,
      [
            {
              "name": "std::max_len_value",
              "params": [
                {
                  "name": "__subject__",
                  "@index": 0,
                },
                {
                  "name": "max",
                  "@index": 1,
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Text
                ALTER PROPERTY body
                    DROP CONSTRAINT max_len_value(10000);
        `
    );
  });

  it("test_edgeql_ddl_constraint_10", () => {
    h.script(
      `

            CREATE ABSTRACT TYPE Text {
                CREATE REQUIRED SINGLE PROPERTY body -> str {
                    CREATE CONSTRAINT max_len_value(10000);
                };
            };
            CREATE TYPE Comment EXTENDING Text;
        `
    );
    h.script(
      `
            ALTER TYPE Text
                DROP PROPERTY body;
        `
    );
  });

  it("test_edgeql_ddl_constraint_11", () => {
    h.script(
      `

            CREATE ABSTRACT TYPE Text {
                CREATE REQUIRED SINGLE PROPERTY body -> str {
                    CREATE CONSTRAINT max_value(10000)
                        ON (len(__subject__));
                };
            };
            CREATE TYPE Comment EXTENDING Text;
            CREATE TYPE Troll EXTENDING Comment;
        `
    );
    h.script(
      `
            ALTER TYPE Text
                ALTER PROPERTY body
                    DROP CONSTRAINT max_value(10000)
                        ON (len(__subject__));
        `
    );
  });

  it("test_edgeql_ddl_constraint_12", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Base {
                    CREATE PROPERTY firstname -> str {
                        CREATE CONSTRAINT max_len_value(10);
                        CREATE CONSTRAINT max_len_value(10);
                    }
                }
            `
      );
    }).toThrow(new RegExp("constraint 'std::max_len_value' of property 'firstname' of object type 'default::Base' already exists"));
  });

  it("test_edgeql_ddl_constraint_13", () => {
    h.script(
      `
            CREATE ABSTRACT CONSTRAINT Lol {
                USING ((__subject__ < 10));
            };
            CREATE TYPE Foo {
                CREATE PROPERTY x -> int64 {
                    CREATE CONSTRAINT Lol;
                };
            };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    h.script(
      `
            ALTER ABSTRACT CONSTRAINT Lol RENAME TO Lolol;
        `
    );
    h.script(
      `
            ALTER TYPE Foo DROP PROPERTY x;
        `
    );
  });

  it("test_edgeql_ddl_constraint_14", () => {
    h.script(
      `
            CREATE TYPE Foo;
            CREATE TYPE Bar {
                CREATE MULTI LINK children -> Foo {
                    CREATE PROPERTY lprop -> str {
                        CREATE CONSTRAINT expression ON (EXISTS __subject__)
                    }
                }
            };
        `
    );
    h.script(
      `
            INSERT Foo;
            INSERT Bar {children := (SELECT Foo {@lprop := "test"})};
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT Bar { children := Foo };
                `
      );
    }).toThrow(new RegExp("invalid lprop"));
  });

  it("test_edgeql_ddl_constraint_15", () => {
    h.script(
      `
            CREATE TYPE Foo;
            CREATE TYPE Bar {
                CREATE MULTI LINK children -> Foo {
                    CREATE PROPERTY lprop -> str {
                        CREATE CONSTRAINT expression ON (
                            __subject__ ?!= <str>{})
                    }
                }
            };
        `
    );
    h.script(
      `
            INSERT Foo;
            INSERT Bar {children := (SELECT Foo {@lprop := "test"})};
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT Bar { children := Foo };
                `
      );
    }).toThrow(new RegExp("invalid lprop"));
  });

  it("test_edgeql_ddl_constraint_16", () => {
    h.script(
      `
            create type Foo {
                create property x -> tuple<x: str, y: str> {
                    create constraint exclusive;
                }
             };
        `
    );
    h.script(
      `
            INSERT Foo { x := ('1', '2') };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo { x := ('1', '2') };
            `
      );
    }).toThrow(new RegExp("x violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_17", () => {
    h.script(
      `
            create type Post {
                create link original -> Post;
                create constraint expression ON ((.original != __subject__));
            };
        `
    );
    h.script(
      `
            insert Post;
        `
    );
    expect(() => {
      h.script(
        `
                update Post set { original := Post };
            `
      );
    }).toThrow(new RegExp("invalid Post"));
  });

  it("test_edgeql_ddl_constraint_18", () => {
    h.script(
      `
            create type Foo {
                create property flag -> bool;
                create property except -> bool;
                create constraint expression on (.flag) except (.except);
             };
        `
    );
    let op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    op;
    op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    op;
    op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    op;
    op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    op;
    op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    expect(() => {
      op;
    }).toThrow(new RegExp("invalid Foo"));
    op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    expect(() => {
      op;
    }).toThrow(new RegExp("invalid Foo"));
    op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    op;
    op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    op;
    op = h.query("\n                    INSERT Foo {\n                        flag := <optional bool>$flag,\n                        except := <optional bool>$ex,\n                    }\n                    ");
    op;
  });

  it("test_edgeql_ddl_constraint_19", () => {
    h.script(
      `
            create abstract constraint always_fail extending constraint {
                using (false)
            };
            create type Foo;
            create type OnTest {
                create link l -> Foo {
                    create property flag -> bool;
                    create constraint always_fail on (@flag);
                };
            };
            create type ExceptTest {
                create link l -> Foo {
                    create property flag -> bool;
                    create constraint always_fail except (@flag);
                };
            };
        `
    );
    expect(() => {
      h.script(
        `
                insert OnTest { l := (insert Foo) { @flag := false } }
            `
      );
    }).toThrow(new RegExp("invalid l"));
    expect(() => {
      h.script(
        `
                insert OnTest { l := (insert Foo) { @flag := true } }
            `
      );
    }).toThrow(new RegExp("invalid l"));
    expect(() => {
      h.script(
        `
                insert ExceptTest { l := (insert Foo) { @flag := false } }
            `
      );
    }).toThrow(new RegExp("invalid l"));
    h.script(
      `
            insert ExceptTest { l := (insert Foo) { @flag := true } }
        `
    );
  });

  it("test_edgeql_ddl_constraint_20", () => {
    expect(() => {
      h.script(
        `
                create type Foo {
                    create constraint expression on (false)
                        except (.__type__.name = 'default::Bar') ;
                };
            `
      );
    }).toThrow(new RegExp("constraints cannot contain paths with more than one hop"));
  });

  it("test_edgeql_ddl_constraint_21", () => {
    h.script(
      `
            create type A {
                create property x -> str;
                create constraint exclusive on (A.x);
            };
            create type B extending A;
            insert A { x := "!" };
        `
    );
    expect(() => {
      h.script(
        `
                insert B { x := "!" }
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_22", () => {
    expect(() => {
      h.script(
        `
                create type X {
                    create property y -> str {
                        create constraint expression on (<array<int32>>[]);
                    }
                };
            `
      );
    }).toThrow(new RegExp("expected to return a bool value, got collection"));
  });

  it("test_edgeql_ddl_constraint_23", () => {
    expect(() => {
      h.script(
        `
                create type X {
                    create constraint exclusive;
                };
            `
      );
    }).toThrow(new RegExp("constraints on object types must have an 'on' clause"));
  });

  it("test_edgeql_ddl_constraint_24", () => {
    expect(() => {
      h.script(
        `
                create type X {
                    create constraint exclusive on (random());
                };
            `
      );
    }).toThrow(new RegExp("constraint expressions must be immutable"));
  });

  it("test_edgeql_ddl_constraint_25", () => {
    h.script(
      `
            create scalar type Status extending enum<open, closed>;
            create type Order {
                create required property status -> Status;
            }
        `
    );
    h.script(
      `
            alter type Order {
                create constraint exclusive on ((Status.open = .status));
            };
        `
    );
    h.script(
      `
            alter type Order {
                create constraint exclusive on ((<Status>'open' = .status));
            };
        `
    );
    h.script(
      `
            alter type Order {
                create constraint exclusive on (('open' = <str>.status));
            };
        `
    );
    h.script(
      `
            alter type Order {
                create index on ((Status.open = .status));
            };
        `
    );
    h.script(
      `
            alter type Order {
                create index on ((<Status>'open' = .status));
            };
        `
    );
    h.script(
      `
            alter type Order {
                create index on (('open' = <str>.status));
            };
        `
    );
  });

  it("test_edgeql_ddl_constraint_26", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY val: tuple<int64, int64> {
                    CREATE CONSTRAINT exclusive ON (.0);
                };
                CREATE CONSTRAINT exclusive ON (.val.1);
                CREATE PROPERTY x: int64;
                CREATE CONSTRAINT exclusive ON (<str>.x);
            };
        `
    );
    h.script(
      `
            insert Foo { val := (1, 2), x := 3 };
        `
    );
    expect(() => {
      h.script(
        `
                insert Foo { val := (1, -1), x := -1 };
            `
      );
    }).toThrow(new RegExp("val violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                insert Foo { val := (-1, 2), x := -1 };
            `
      );
    }).toThrow(new RegExp("Foo violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                insert Foo { val := (-1, -2), x := 3 };
            `
      );
    }).toThrow(new RegExp("Foo violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_27", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE default::ConstraintNonSingletonTest {
                    CREATE PROPERTY has_bad_constraint: std::str {
                        CREATE CONSTRAINT std::expression ON (
                            (distinct __subject__ = __subject__)
                        );
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot use SET OF operator 'std::DISTINCT' in a constraint"));
  });

  it("test_edgeql_ddl_constraint_28", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE default::ConstraintNonSingletonTest {
                    CREATE PROPERTY has_bad_constraint: std::str {
                        CREATE CONSTRAINT std::exclusive ON (
                            distinct __subject__
                        );
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot use SET OF operator 'std::DISTINCT' in a constraint"));
  });

  it("test_edgeql_ddl_constraint_29", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE default::ConstraintNonSingletonTest {
                    CREATE PROPERTY has_bad_constraint: std::str;
                    CREATE CONSTRAINT std::exclusive ON (
                        DISTINCT(.has_bad_constraint)
                    );
                };
            `
      );
    }).toThrow(new RegExp("cannot use SET OF operator 'std::DISTINCT' in a constraint"));
  });

  it("test_edgeql_ddl_constraint_30", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE default::ConstraintNonSingletonTest {
                    CREATE PROPERTY has_bad_constraint: std::str;
                    CREATE CONSTRAINT std::exclusive ON (.has_bad_constraint)
                        EXCEPT ((DISTINCT (__subject__) = __subject__));
                };
            `
      );
    }).toThrow(new RegExp("set returning operator 'std::DISTINCT' is not supported in singleton expressions"));
  });

  it("test_edgeql_ddl_constraint_31", () => {
    expect(() => {
      h.script(
        `
                CREATE ABSTRACT CONSTRAINT default::bad_constraint {
                    USING ((DISTINCT __subject__ = __subject__));
                };
            `
      );
    }).toThrow(new RegExp("set returning operator 'std::DISTINCT' is not supported in singleton expressions"));
  });

  it.skip("test_edgeql_ddl_constraint_32 [xerror: We should reject this but I don't want to do it in a point release]", () => {
    expect(() => {
      h.script(
        `
                create type S {
                    create constraint expression on (((0, 0)).0 = 0);
                };
            `
      );
    }).toThrow(new RegExp(""));
    expect(() => {
      h.script(
        `
                create type S {
                    create constraint expression on (((true, 0)).0);
                };
            `
      );
    }).toThrow(new RegExp(""));
  });

  it("test_edgeql_ddl_constraint_check_01a", () => {
    h.script(
      `
            create type Foo {
                create property foo -> str;
            };
            create type Bar extending Foo;

            insert Foo { foo := "x" };
            insert Bar { foo := "x" };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Foo alter property foo {
                    create constraint exclusive
                };
            `
      );
    }).toThrow(new RegExp("foo violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_01b", () => {
    h.script(
      `
            create type Foo {
                create property foo -> str {create constraint exclusive;};
            };
            create type Bar {
                create property foo -> str {create constraint exclusive;};
            };

            insert Foo { foo := "x" };
            insert Bar { foo := "x" };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Bar extending Foo;
            `
      );
    }).toThrow(new RegExp("foo violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_02a", () => {
    h.script(
      `
            create type Foo {
                create property foo -> str;
            };
            create type Bar extending Foo;

            insert Foo { foo := "x" };
            insert Bar { foo := "x" };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Foo {
                    create constraint exclusive on (.foo);
                };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_02b", () => {
    h.script(
      `
            create type Foo {
                create property foo -> str;
                create constraint exclusive on (.foo);
            };
            create type Bar {
                CREATE PROPERTY foo -> str;
                create constraint exclusive on (.foo);
            };

            insert Foo { foo := "x" };
            insert Bar { foo := "x" };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Bar extending Foo;
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_03a", () => {
    h.script(
      `
            create type Foo {
                create multi property foo -> str;
            };
            create type Bar extending Foo;

            insert Foo { foo := "x" };
            insert Bar { foo := "x" };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Foo alter property foo {
                    create constraint exclusive
                };
            `
      );
    }).toThrow(new RegExp("foo violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_03b", () => {
    h.script(
      `
            create type Foo {
                create multi property foo -> str {create constraint exclusive;}
            };
            create type Bar {
                create multi property foo -> str {create constraint exclusive;}
            };

            insert Foo { foo := "x" };
            insert Bar { foo := "x" };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Bar extending Foo;
            `
      );
    }).toThrow(new RegExp("foo violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_04", () => {
    h.script(
      `
            create type Tgt;
            create type Foo {
                create link foo -> Tgt
            };
            create type Bar extending Foo;

            insert Tgt;
            insert Foo { foo := assert_single(Tgt) };
            insert Bar { foo := assert_single(Tgt) };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Foo alter link foo {
                    create constraint exclusive
                };
            `
      );
    }).toThrow(new RegExp("foo violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_05", () => {
    h.script(
      `
            create type Tgt;
            create type Foo {
                create multi link foo -> Tgt { create property x -> str; }
            };
            create type Bar extending Foo;

            insert Tgt;
            insert Foo { foo := assert_single(Tgt) };
            insert Bar { foo := assert_single(Tgt) };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Foo alter link foo {
                    create constraint exclusive
                };
            `
      );
    }).toThrow(new RegExp("foo violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_06", () => {
    h.script(
      `
            create type Tgt;
            create type Foo {
                create link foo -> Tgt { create property x -> str; }
            };
            create type Bar extending Foo;

            insert Tgt;
            insert Foo { foo := assert_single(Tgt { @x := "foo" }) };
            insert Bar { foo := assert_single(Tgt { @x := "foo" }) };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Foo alter link foo alter property x {
                    create constraint exclusive
                };
            `
      );
    }).toThrow(new RegExp("x violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_07", () => {
    h.script(
      `
            create type Tgt;
            create type Foo {
                create link foo -> Tgt { create property x -> str; }
            };
            create type Bar extending Foo;

            insert Tgt;
            insert Foo { foo := assert_single(Tgt { @x := "foo" }) };
            insert Bar { foo := assert_single(Tgt { @x := "foo" }) };
        `
    );
    expect(() => {
      h.script(
        `
                alter type Foo alter link foo  {
                    create constraint exclusive on (__subject__@x)
                };
            `
      );
    }).toThrow(new RegExp("foo violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_08", () => {
    h.script(
      `
            create type Tgt;
            create abstract link Lnk { create property x -> str; };
            create type Foo {
                create link foo extending Lnk -> Tgt;
            };
            create type Bar extending Foo;

            insert Tgt;
            insert Foo { foo := assert_single(Tgt { @x := "foo" }) };
            insert Bar { foo := assert_single(Tgt { @x := "foo" }) };
        `
    );
    expect(() => {
      h.script(
        `
                alter abstract link Lnk alter property x {
                    create constraint exclusive
                };
            `
      );
    }).toThrow(new RegExp("x violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_check_09", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE R {
                CREATE REQUIRED PROPERTY name -> std::str {
                    CREATE DELEGATED CONSTRAINT std::exclusive;
                };
            };
            CREATE TYPE S EXTENDING R;
            CREATE TYPE T EXTENDING R;
            CREATE TYPE V EXTENDING S, T;

            INSERT S { name := "S" };
            INSERT T { name := "T" };
            INSERT V { name := "V" };
        `
    );
    for (const [t1, t2] of (["SV", "TV", "VT", "VS"] as any)) {
      expect(() => {
        h.script(
          `
                        insert ${t1} { name := "${t2}" }
                    `
        );
      }).toThrow(new RegExp("violates exclusivity constraint"));
      expect(() => {
        h.script(
          `
                        select {
                            (insert ${t1} { name := "!" }),
                            (insert ${t2} { name := "!" }),
                        }
                    `
        );
      }).toThrow(new RegExp("violates exclusivity constraint"));
    }
    h.script(
      `
            ALTER TYPE default::R {
                DROP PROPERTY name;
            };
        `
    );
  });

  it("test_edgeql_ddl_constraint_check_10", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE R {
                CREATE REQUIRED PROPERTY name -> std::str {
                    CREATE DELEGATED CONSTRAINT std::exclusive;
                };
            };
            CREATE TYPE S EXTENDING R;
            CREATE TYPE T {
                CREATE REQUIRED PROPERTY name -> std::str {
                    CREATE CONSTRAINT std::exclusive;
                };
            };
            CREATE TYPE V EXTENDING S, T;

            INSERT S { name := "S" };
            INSERT T { name := "T" };
            INSERT V { name := "V" };
        `
    );
    for (const [t1, t2] of (["SV", "TV", "VT", "VS"] as any)) {
      expect(() => {
        h.script(
          `
                        insert ${t1} { name := "${t2}" }
                    `
        );
      }).toThrow(new RegExp("violates exclusivity constraint"));
      expect(() => {
        h.script(
          `
                        select {
                            (insert ${t1} { name := "!" }),
                            (insert ${t2} { name := "!" }),
                        }
                    `
        );
      }).toThrow(new RegExp("violates exclusivity constraint"));
    }
  });

  it("test_edgeql_ddl_constraint_alter_01", () => {
    h.script(
      `
            CREATE TYPE ConTest01 {
                CREATE PROPERTY con_test -> int64;
            };

            ALTER TYPE ConTest01
                ALTER PROPERTY con_test
                    CREATE CONSTRAINT min_value(0);
        `
    );
    h.script(
      `
            ALTER TYPE ConTest01
                ALTER PROPERTY con_test
                    DROP CONSTRAINT min_value(0);
        `
    );
    assertQueryResult(
      h,
      `
            WITH MODULE schema
            SELECT ObjectType {
                name,
                properties: {
                    name,
                    constraints: { name }
                } FILTER .name = 'con_test'
            }
            FILTER .name = 'default::ConTest01';
        `,
      [
            {
              "name": "default::ConTest01",
              "properties": [
                {
                  "name": "con_test",
                  "constraints": [],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_constraint_alter_02", () => {
    h.script(
      `
            CREATE SCALAR TYPE contest2_t EXTENDING int64 {
                CREATE CONSTRAINT expression ON (__subject__ > 0);
            };
        `
    );
    h.script(
      `
            ALTER SCALAR TYPE contest2_t {
                ALTER CONSTRAINT expression ON (__subject__ > 0) {
                    CREATE ANNOTATION title := 'my constraint 2'
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    constraints: {
                        subjectexpr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::contest2_t';
            `,
      [
            {
              "constraints": [
                {
                  "subjectexpr": "(__subject__ > 0)",
                  "annotations": [
                    {
                      "name": "std::title",
                      "@value": "my constraint 2",
                    },
                  ],
                },
              ],
            },
          ]
    );
    h.script(
      `
            ALTER SCALAR TYPE contest2_t {
                ALTER CONSTRAINT expression ON (__subject__ > 0) {
                    DROP ANNOTATION title;
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    constraints: {
                        subjectexpr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::contest2_t';
            `,
      [
            {
              "constraints": [
                {
                  "subjectexpr": "(__subject__ > 0)",
                  "annotations": [],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_constraint_alter_03", () => {
    h.script(
      `
            CREATE SCALAR TYPE contest3_t EXTENDING int64 {
                CREATE CONSTRAINT expression ON (__subject__ > 0) {
                    CREATE ANNOTATION title := 'my constraint 3';
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    constraints: {
                        subjectexpr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::contest3_t';
            `,
      [
            {
              "constraints": [
                {
                  "subjectexpr": "(__subject__ > 0)",
                  "annotations": [
                    {
                      "name": "std::title",
                      "@value": "my constraint 3",
                    },
                  ],
                },
              ],
            },
          ]
    );
    h.script(
      `
            scalar type contest3_t extending int64 {
                constraint expression on (__subject__ > 0);
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    constraints: {
                        subjectexpr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::contest3_t';
            `,
      [
            {
              "constraints": [
                {
                  "subjectexpr": "(__subject__ > 0)",
                  "annotations": [],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_constraint_alter_04", () => {
    h.script(
      `
            CREATE SCALAR TYPE contest4_t EXTENDING int64 {
                CREATE CONSTRAINT expression ON (__subject__ > 0);
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    constraints: {
                        subjectexpr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::contest4_t';
            `,
      [
            {
              "constraints": [
                {
                  "subjectexpr": "(__subject__ > 0)",
                  "annotations": [],
                },
              ],
            },
          ]
    );
    h.script(
      `
            scalar type contest4_t extending int64 {
                constraint expression on (__subject__ > 0) {
                    annotation title := 'my constraint 5';
                }
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT ScalarType {
                    constraints: {
                        subjectexpr,
                        annotations: {
                            name,
                            @value,
                        }
                    }
                }
                FILTER
                    .name = 'default::contest4_t';
            `,
      [
            {
              "constraints": [
                {
                  "subjectexpr": "(__subject__ > 0)",
                  "annotations": [
                    {
                      "name": "std::title",
                      "@value": "my constraint 5",
                    },
                  ],
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_constraint_alter_05", () => {
    h.script(
      `
            CREATE TYPE Base {
                CREATE PROPERTY firstname -> str {
                    CREATE CONSTRAINT max_len_value(10);
                }
            }
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Base {
                    ALTER PROPERTY firstname {
                        CREATE CONSTRAINT max_len_value(10);
                    }
                }
            `
      );
    }).toThrow(new RegExp("constraint 'std::max_len_value' of property 'firstname' of object type 'default::Base' already exists"));
  });

  it("test_edgeql_ddl_constraint_alter_06", () => {
    h.script(
      `
            create type Foo {
                create property foo -> str {create constraint exclusive;};
            };
            create type Bar extending Foo;
        `
    );
    expect(() => {
      h.script(
        `
                insert Bar { foo := "x" }; insert Foo { foo := "x" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                insert Foo { foo := "x" }; insert Bar { foo := "x" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_alter_07", () => {
    h.script(
      `
            create type Foo {
                create property foo -> str;
            };
            create type Bar extending Foo;
            alter type Foo alter property foo {
                create constraint exclusive
            };
        `
    );
    expect(() => {
      h.script(
        `
                insert Bar { foo := "x" }; insert Foo { foo := "x" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                insert Foo { foo := "x" }; insert Bar { foo := "x" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_alter_08", () => {
    h.script(
      `
            create type Foo {
                create property foo -> str {create constraint exclusive;};
            };
            create type Bar {
                create property foo -> str {create constraint exclusive;};
            };
            alter type Bar extending Foo;
        `
    );
    expect(() => {
      h.script(
        `
                insert Bar { foo := "x" }; insert Foo { foo := "x" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
    expect(() => {
      h.script(
        `
                insert Foo { foo := "x" }; insert Bar { foo := "x" };
            `
      );
    }).toThrow(new RegExp("violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_constraint_alter_09", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE default::T;
            CREATE ABSTRACT TYPE default::Sub1 EXTENDING default::T;
            CREATE TYPE default::Sub2 EXTENDING default::Sub1, default::T;
            ALTER TYPE default::T {
                CREATE PROPERTY foo -> std::str {
                    CREATE CONSTRAINT std::exclusive;
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_drop_inherited_link", () => {
    h.script(
      `
            CREATE TYPE Target;
            CREATE TYPE Parent {
                CREATE LINK dil_foo -> Target;
            };

            CREATE TYPE Child EXTENDING Parent;
            CREATE TYPE GrandChild EXTENDING Child;
       `
    );
    h.script(
      `
            ALTER TYPE Parent DROP LINK dil_foo;
        `
    );
  });

  it("test_edgeql_ddl_drop_01", () => {
    h.script(
      `
            CREATE SCALAR TYPE a1 EXTENDING std::str;

            ALTER SCALAR TYPE a1 {
                CREATE CONSTRAINT std::one_of('a', 'b') {
                    CREATE ANNOTATION description :=
                        'test_delta_drop_01_constraint';
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Constraint {name}
                FILTER any(
                    .annotations.name = 'std::description'
                    AND .annotations@value = 'test_delta_drop_01_constraint'
                )
            `,
      [
            {
              "name": "std::one_of",
            },
          ]
    );
    h.script(
      `
            DROP SCALAR TYPE a1;
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Constraint {name}
                FILTER any(
                    .annotations.name = 'std::description'
                    AND .annotations@value = 'test_delta_drop_01_constraint'
                )
            `,
      []
    );
  });

  it("test_edgeql_ddl_drop_02", () => {
    h.script(
      `
            CREATE TYPE C1 {
                CREATE PROPERTY l1 -> std::str {
                    CREATE ANNOTATION description := 'test_delta_drop_02_link';
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Property {name}
                FILTER any(
                    .annotations.name = 'std::description'
                    AND .annotations@value = 'test_delta_drop_02_link'
                )
            `,
      [
            {
              "name": "l1",
            },
          ]
    );
    h.script(
      `
            DROP TYPE C1;
        `
    );
    assertQueryResult(
      h,
      `
                WITH MODULE schema
                SELECT Property {name}
                FILTER any(
                    .annotations.name = 'std::description'
                    AND .annotations@value = 'test_delta_drop_02_link'
                )
            `,
      []
    );
  });

  it("test_edgeql_ddl_drop_03", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED SINGLE PROPERTY name -> std::str;
            };
        `
    );
    h.script(
      `
            CREATE TYPE Bar {
                CREATE OPTIONAL SINGLE LINK lol -> Foo {
                    CREATE PROPERTY note -> str;
                };
            };
        `
    );
    h.script(
      `
            DROP TYPE Bar;
        `
    );
  });

  it("test_edgeql_ddl_drop_refuse_01", () => {
    h.script(
      `
            CREATE TYPE DropA;
            CREATE ABSTRACT ANNOTATION dropattr;
            CREATE ABSTRACT LINK l1_parent;
            CREATE TYPE DropB {
                CREATE LINK l1 EXTENDING l1_parent -> DropA {
                    CREATE ANNOTATION dropattr := 'foo';
                };
            };
            CREATE SCALAR TYPE dropint EXTENDING int64;
            CREATE FUNCTION dropfunc(a: dropint) -> int64
                USING EdgeQL $$ SELECT a $$;
        `
    );
    expect(() => {
      h.script(
        `DROP TYPE DropA`
      );
    }).toThrow(new RegExp("cannot drop object type.*DropA.*other objects"));
    expect(() => {
      h.script(
        `DROP ABSTRACT ANNOTATION dropattr`
      );
    }).toThrow(new RegExp("cannot drop abstract anno.*dropattr.*other objects"));
    expect(() => {
      h.script(
        `DROP ABSTRACT LINK l1_parent`
      );
    }).toThrow(new RegExp("cannot drop abstract link.*l1_parent.*other objects"));
    expect(() => {
      h.script(
        `DROP SCALAR TYPE dropint`
      );
    }).toThrow(new RegExp("cannot drop.*dropint.*other objects"));
  });

  it("test_edgeql_ddl_drop_refuse_02", () => {
    h.script(
      `
            create type Player;
            create global current_player_id: uuid;
            create global current_player := (
                select Player filter .id = global current_player_id
            );

            create type Clan;
            alter type Player {
                create link clan: Clan;
            };
            alter type Clan {
                create access policy allow_select_players
                    allow select using (
                        global current_player.clan.id ?= .id
                    );
            };
            `
    );
    expect(() => {
      h.script(
        `drop type Player;`
      );
    }).toThrow(new RegExp("cannot drop .+ because this affects expression of access"));
  });

  it("test_edgeql_ddl_unicode_01", () => {
    h.script(
      `
            type Пример {
                required property номер -> int16;
            };
        `
    );
    h.script(
      `
            INSERT Пример {
                номер := 987
            };
            INSERT Пример {
                номер := 456
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT
                    Пример {
                        номер
                    }
                ORDER BY
                    Пример.номер;
            `,
      [
            {
              "\u043d\u043e\u043c\u0435\u0440": 456,
            },
            {
              "\u043d\u043e\u043c\u0435\u0440": 987,
            },
          ]
    );
  });

  it("test_edgeql_ddl_tuple_properties", () => {
    h.script(
      `
            CREATE TYPE TupProp01 {
                CREATE PROPERTY p1 -> tuple<int64, str>;
                CREATE PROPERTY p2 -> tuple<foo: int64, bar: str>;
                CREATE PROPERTY p3 -> tuple<foo: int64,
                                            bar: tuple<json, json>>;
            };

            CREATE TYPE TupProp02 {
                CREATE PROPERTY p1 -> tuple<int64, str>;
                CREATE PROPERTY p2 -> tuple<json, json>;
            };
        `
    );
    h.script(
      `
            ALTER TYPE TupProp01 {
                DROP PROPERTY p1;
            };
        `
    );
    h.script(
      `
            ALTER TYPE TupProp02 {
                DROP PROPERTY p1;
            };
        `
    );
    h.script(
      `
            ALTER TYPE TupProp02 {
                CREATE PROPERTY p1 -> tuple<int64, str>;
            };
        `
    );
    h.script(
      `
            ALTER TYPE TupProp01 {
                DROP PROPERTY p3;
            };
        `
    );
    h.script(
      `
            ALTER TYPE TupProp02 {
                DROP PROPERTY p2;
            };
        `
    );
    h.script(
      `
            ALTER TYPE TupProp02 {
                CREATE PROPERTY p3 -> tuple<json, json>;
                CREATE PROPERTY p4 -> tuple<a: json, b: json>;
            };
        `
    );
    h.script(
      `
            ALTER TYPE TupProp02 {
                CREATE PROPERTY p5 -> array<tuple<int64>>;
            };
        `
    );
    h.query(
      `DECLARE SAVEPOINT t0`
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE TupProp02 {
                    CREATE PROPERTY p6 -> tuple<TupProp02>;
                };
            `
      );
    }).toThrow(new RegExp("expected a scalar type, or a scalar collection"));
    h.query(
      `ROLLBACK TO SAVEPOINT t0;`
    );
  });

  it("test_edgeql_ddl_enum_01", () => {
    h.script(
      `
            CREATE SCALAR TYPE my_enum EXTENDING enum<'foo', 'bar'>;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ScalarType {
                    enum_values,
                }
                FILTER .name = 'default::my_enum';
            `,
      [
            {
              "enum_values": ["foo", "bar"],
            },
          ]
    );
    h.script(
      `
            CREATE TYPE EnumHost {
                CREATE PROPERTY foo -> my_enum;
            }
        `
    );
    h.query(
      `DECLARE SAVEPOINT t0`
    );
    expect(() => {
      h.script(
        `
                CREATE SCALAR TYPE my_enum_2
                    EXTENDING enum<'foo', 'bar'>,
                    std::int32;
            `
      );
    }).toThrow(new RegExp("enumeration must be the only supertype specified"));
    h.query(
      `ROLLBACK TO SAVEPOINT t0;`
    );
    h.script(
      `
            CREATE SCALAR TYPE my_enum_2
                EXTENDING enum<'foo', 'bar'>;
        `
    );
    h.query(
      `DECLARE SAVEPOINT t1`
    );
    expect(() => {
      h.script(
        `
                CREATE SCALAR TYPE my_enum_3
                    EXTENDING enum<'foo', 'bar', 'baz'> {
                    CREATE CONSTRAINT expression ON (EXISTS(__subject__))
                };
            `
      );
    }).toThrow(new RegExp("constraints cannot be defined on enumerated type.*"));
    h.query(
      `ROLLBACK TO SAVEPOINT t1;`
    );
    h.script(
      `
            ALTER SCALAR TYPE my_enum_2
                RENAME TO my_enum_3;
        `
    );
    h.script(
      `
            CREATE MODULE foo;
            ALTER SCALAR TYPE my_enum_3
                RENAME TO foo::my_enum_4;
        `
    );
    h.script(
      `
            DROP SCALAR TYPE foo::my_enum_4;
        `
    );
  });

  it("test_edgeql_ddl_enum_02", () => {
    h.script(
      `
            CREATE SCALAR TYPE my_enum EXTENDING enum<'foo', 'bar'>;
        `
    );
    h.script(
      `
            CREATE TYPE Obj {
                CREATE PROPERTY e -> my_enum {
                    SET default := <my_enum>'foo';
                }
            }
        `
    );
    h.script(
      `
            CREATE MODULE foo;
            ALTER SCALAR TYPE my_enum
                RENAME TO foo::my_enum_2;
        `
    );
    h.script(
      `
            DROP TYPE Obj;
            DROP SCALAR TYPE foo::my_enum_2;
        `
    );
  });

  it("test_edgeql_ddl_enum_03", () => {
    expect(() => {
      h.script(
        `
                CREATE SCALAR TYPE Color
                    EXTENDING enum<Red, Green, Blue, Red>;
            `
      );
    }).toThrow(new RegExp("enums cannot contain duplicate values"));
  });

  it("test_edgeql_ddl_enum_05", () => {
    h.script(
      `
            CREATE SCALAR TYPE Color
                EXTENDING enum<Red, Green, Blue>;

             CREATE FUNCTION asdf(x: Color) -> str USING (
                 <str>(x));
             CREATE FUNCTION asdf2() -> str USING (
                 asdf(<Color>'Red'));
             CREATE FUNCTION asdf3(x: tuple<Color>) -> str USING (
                 <str>(x.0));

             CREATE TYPE Entry {
                 CREATE PROPERTY num -> int64;
                 CREATE PROPERTY color -> Color;
                 CREATE PROPERTY colors -> array<Color>;
                 CREATE PROPERTY colorst -> array<tuple<Color>>;
                 CREATE CONSTRAINT expression ON (
                     <str>.num != asdf2()
                 );
                 CREATE INDEX ON (asdf(.color));
                 CREATE PROPERTY lol -> str {
                     SET default := asdf2();
                 }
             };
             INSERT Entry { num := 1, color := "Red" };
             INSERT Entry {
                 num := 2, color := "Green", colors := ["Red", "Green"],
                 colorst := [("Red",), ("Green",)]
             };
        `
    );
    h.script(
      `
            ALTER SCALAR TYPE Color
                EXTENDING enum<Red, Green>;
        `
    );
    h.script(
      `
            ALTER SCALAR TYPE Color
                EXTENDING enum<Green, Red>;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Entry { num, color, colorst } ORDER BY .color;
            `,
      [
            {
              "num": 2,
              "color": "Green",
              "colorst": [
                ["Red"],
                ["Green"],
              ],
            },
            {
              "num": 1,
              "color": "Red",
            },
          ]
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE Color
                    EXTENDING enum<Green>;
            `
      );
    }).toThrow(new RegExp("invalid input value for enum"));
  });

  it("test_edgeql_ddl_enum_06", () => {
    h.script(
      `CREATE SCALAR TYPE default::LongLabel EXTENDING enum<
    AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGG
>`
    );
  });

  it("test_edgeql_ddl_enum_07", () => {
    h.script(
      `CREATE SCALAR TYPE default::LongLabel EXTENDING enum<
    'AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGG'
>`
    );
  });

  it("test_edgeql_ddl_enum_08", () => {
    expect(() => {
      h.script(
        `CREATE SCALAR TYPE default::LongLabel EXTENDING enum<
    AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGGG
>`
      );
    }).toThrow(new RegExp("enum labels cannot exceed 63 characters"));
  });

  it("test_edgeql_ddl_enum_09", () => {
    expect(() => {
      h.script(
        `CREATE SCALAR TYPE default::LongLabel EXTENDING enum<
    'AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGGG'
>`
      );
    }).toThrow(new RegExp("enum labels cannot exceed 63 characters"));
  });

  it("test_edgeql_ddl_enum_10", () => {
    h.script(
      `CREATE SCALAR TYPE default::LongLabel EXTENDING enum<
    AAAAAAAAAA
>`
    );
    expect(() => {
      h.script(
        `ALTER SCALAR TYPE default::LongLabel EXTENDING enum<
    AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGGG
>`
      );
    }).toThrow(new RegExp("enum labels cannot exceed 63 characters"));
  });

  it("test_edgeql_ddl_enum_11", () => {
    h.script(
      `CREATE SCALAR TYPE default::LongLabel EXTENDING enum<
    'AAAAAAAAAA'
>`
    );
    expect(() => {
      h.script(
        `ALTER SCALAR TYPE default::LongLabel EXTENDING enum<
    'AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGGG'
>`
      );
    }).toThrow(new RegExp("enum labels cannot exceed 63 characters"));
  });

  it("test_edgeql_ddl_explicit_id", () => {
    h.script(
      `
            CREATE TYPE ExID {
                SET id := <uuid>'00000000-0000-0000-0000-0000feedbeef'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::ObjectType {
                    id
                }
                FILTER .name = 'default::ExID';
            `,
      [
            {
              "id": "00000000-0000-0000-0000-0000feedbeef",
            },
          ]
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE ExID {
                    SET id := <uuid>'00000000-0000-0000-0000-0000feedbeef'
                }
            `
      );
    }).toThrow(new RegExp("cannot alter object id"));
  });

  it("test_edgeql_ddl_quoting_01", () => {
    h.script(
      `
            CREATE TYPE \`U S\`\`E R\` {
                CREATE PROPERTY \`n ame\` -> str;
            };
        `
    );
    h.script(
      `
            INSERT \`U S\`\`E R\` {
                \`n ame\` := 'quoting_01'
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT \`U S\`\`E R\` {
                    __type__: {
                        name
                    },
                    \`n ame\`
                };
            `,
      [
            {
              "__type__": {
                "name": "default::U S`E R",
              },
              "n ame": "quoting_01",
            },
          ]
    );
    h.script(
      `
            DROP TYPE \`U S\`\`E R\`;
        `
    );
  });

  it("test_edgeql_ddl_prop_overload_01", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE UniqueName {
                    CREATE PROPERTY val -> str;
                };
                CREATE TYPE UniqueName_2 EXTENDING UniqueName {
                    ALTER PROPERTY val {
                        USING ('bad');
                    };
                };
            `
      );
    }).toThrow(new RegExp("it is illegal for the computed property 'val' of object type 'default::UniqueName_2' to overload an existing property"));
  });

  it("test_edgeql_ddl_prop_overload_02", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE UniqueName {
                    CREATE PROPERTY val := 'bad';
                };
                CREATE TYPE UniqueName_2 EXTENDING UniqueName {
                    ALTER PROPERTY val {
                        CREATE CONSTRAINT exclusive;
                    };
                };
            `
      );
    }).toThrow(new RegExp("it is illegal for the computed property 'val' of object type 'default::UniqueName_2' to overload an existing property"));
  });

  it("test_edgeql_ddl_prop_overload_03", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE UniqueName {
                    CREATE PROPERTY val := 'ok';
                };
                CREATE TYPE UniqueName_2 {
                    CREATE PROPERTY val -> str;
                };
                CREATE TYPE UniqueName_3 EXTENDING UniqueName, UniqueName_2;
            `
      );
    }).toThrow(new RegExp("it is illegal for the property 'val' of object type 'default::UniqueName_3' to extend both a computed and a non-computed property"));
  });

  it("test_edgeql_ddl_prop_overload_04", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE UniqueName {
                    CREATE PROPERTY val := 'ok';
                };
                CREATE TYPE UniqueName_2 {
                    CREATE PROPERTY val := 'ok';
                };
                CREATE TYPE UniqueName_3 EXTENDING UniqueName, UniqueName_2;
            `
      );
    }).toThrow(new RegExp("it is illegal for the property 'val' of object type 'default::UniqueName_3' to extend more than one computed property"));
  });

  it("test_edgeql_ddl_prop_overload_05", () => {
    h.script(
      `
            CREATE TYPE UniqueName {
                CREATE PROPERTY val -> str;
            };
            CREATE TYPE UniqueName_2 {
                CREATE PROPERTY val -> str;
            };
            CREATE TYPE UniqueName_3 EXTENDING UniqueName, UniqueName_2;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE UniqueName {
                    ALTER PROPERTY val {
                        USING ('bad');
                    };
                };
            `
      );
    }).toThrow(new RegExp("it is illegal for the property 'val' of object type 'default::UniqueName_3' to extend both a computed and a non-computed property"));
  });

  it("test_edgeql_ddl_prop_overload_06", () => {
    h.script(
      `
            CREATE TYPE UniqueName {
                CREATE PROPERTY val -> str;
            };
            CREATE TYPE UniqueName_2 {
                CREATE PROPERTY val -> str;
            };
            CREATE TYPE UniqueName_3 {
                CREATE PROPERTY val := 'ok';
            };
            CREATE TYPE UniqueName_4 EXTENDING UniqueName, UniqueName_2;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE UniqueName_4 EXTENDING UniqueName_3;
            `
      );
    }).toThrow(new RegExp("it is illegal for the property 'val' of object type 'default::UniqueName_4' to extend both a computed and a non-computed property"));
  });

  it("test_edgeql_ddl_prop_overload_07", () => {
    h.script(
      `
            CREATE TYPE UniqueName {
                CREATE PROPERTY val -> str;
            };
            CREATE TYPE UniqueName_2 {
                CREATE PROPERTY val := 'ok';
            };
            CREATE TYPE UniqueName_3;
            CREATE TYPE UniqueName_4 EXTENDING UniqueName, UniqueName_3;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE UniqueName_3 EXTENDING UniqueName_2;
            `
      );
    }).toThrow(new RegExp("it is illegal for the property 'val' of object type 'default::UniqueName_4' to extend both a computed and a non-computed property"));
  });

  it("test_edgeql_ddl_link_overload_01", () => {
    h.script(
      `
            CREATE TYPE T;
            CREATE TYPE A {
                CREATE MULTI LINK t -> T;
            };
            CREATE TYPE B EXTENDING A;
            INSERT T;
            INSERT B {
                t := T
            };
            ALTER TYPE B ALTER LINK t CREATE ANNOTATION title := 'overloaded';
            UPDATE B SET { t := T };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT A { ct := count(.t) };
            `,
      [
            {
              "ct": 1,
            },
          ]
    );
  });

  it("test_edgeql_ddl_readonly_01", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE PROPERTY foo -> str;
                };
                CREATE TYPE Derived EXTENDING Base {
                    ALTER PROPERTY foo {
                        SET readonly := True;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of property 'foo' of object type 'default::Derived': it is defined as True in property 'foo' of object type 'default::Derived' and as False in property 'foo' of object type 'default::Base'."));
  });

  it("test_edgeql_ddl_readonly_02", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE PROPERTY foo -> str {
                        SET readonly := True;
                    };
                };
                CREATE TYPE Derived EXTENDING Base {
                    ALTER PROPERTY foo {
                        SET readonly := False;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of property 'foo' of object type 'default::Derived': it is defined as False in property 'foo' of object type 'default::Derived' and as True in property 'foo' of object type 'default::Base'."));
  });

  it("test_edgeql_ddl_readonly_03", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base0 {
                    CREATE PROPERTY foo -> str;
                };
                CREATE TYPE Base1 {
                    CREATE PROPERTY foo -> str {
                        SET readonly := True;
                    };
                };
                CREATE TYPE Derived EXTENDING Base0, Base1;
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of property 'foo' of object type 'default::Derived': it is defined as False in property 'foo' of object type 'default::Base0' and as True in property 'foo' of object type 'default::Base1'."));
  });

  it("test_edgeql_ddl_readonly_04", () => {
    h.script(
      `

            CREATE TYPE Base0 {
                CREATE PROPERTY foo -> str;
            };
            CREATE TYPE Base1 {
                CREATE PROPERTY foo -> str;
            };
            CREATE TYPE Derived EXTENDING Base0, Base1;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Base1 {
                    ALTER PROPERTY foo {
                        SET readonly := True;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of property 'foo' of object type 'default::Derived': it is defined as False in property 'foo' of object type 'default::Base0' and as True in property 'foo' of object type 'default::Base1'."));
  });

  it("test_edgeql_ddl_readonly_05", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE LINK foo -> Object;
                };
                CREATE TYPE Derived EXTENDING Base {
                    ALTER LINK foo {
                        SET readonly := True;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of link 'foo' of object type 'default::Derived': it is defined as True in link 'foo' of object type 'default::Derived' and as False in link 'foo' of object type 'default::Base'."));
  });

  it("test_edgeql_ddl_readonly_06", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE LINK foo -> Object {
                        SET readonly := True;
                    };
                };
                CREATE TYPE Derived EXTENDING Base {
                    ALTER LINK foo {
                        SET readonly := False;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of link 'foo' of object type 'default::Derived': it is defined as False in link 'foo' of object type 'default::Derived' and as True in link 'foo' of object type 'default::Base'."));
  });

  it("test_edgeql_ddl_readonly_07", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base0 {
                    CREATE LINK foo -> Object;
                };
                CREATE TYPE Base1 {
                    CREATE LINK foo -> Object {
                        SET readonly := True;
                    };
                };
                CREATE TYPE Derived EXTENDING Base0, Base1;
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of link 'foo' of object type 'default::Derived': it is defined as False in link 'foo' of object type 'default::Base0' and as True in link 'foo' of object type 'default::Base1'."));
  });

  it("test_edgeql_ddl_readonly_08", () => {
    h.script(
      `

            CREATE TYPE Base0 {
                CREATE LINK foo -> Object;
            };
            CREATE TYPE Base1 {
                CREATE LINK foo -> Object;
            };
            CREATE TYPE Derived EXTENDING Base0, Base1;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Base1 {
                    ALTER LINK foo {
                        SET readonly := True;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of link 'foo' of object type 'default::Derived': it is defined as False in link 'foo' of object type 'default::Base0' and as True in link 'foo' of object type 'default::Base1'."));
  });

  it("test_edgeql_ddl_readonly_09", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE LINK foo -> Object {
                        CREATE PROPERTY bar -> str;
                    };
                };
                CREATE TYPE Derived EXTENDING Base {
                    ALTER LINK foo {
                        ALTER PROPERTY bar {
                            SET readonly := True;
                        }
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of property 'bar' of link 'foo' of object type 'default::Derived': it is defined as True in property 'bar' of link 'foo' of object type 'default::Derived' and as False in property 'bar' of link 'foo' of object type 'default::Base'."));
  });

  it("test_edgeql_ddl_readonly_10", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE LINK foo -> Object {
                        CREATE PROPERTY bar -> str {
                            SET readonly := True;
                        };
                    };
                };
                CREATE TYPE Derived EXTENDING Base {
                    ALTER LINK foo {
                        ALTER PROPERTY bar {
                            SET readonly := False;
                        }
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of property 'bar' of link 'foo' of object type 'default::Derived': it is defined as False in property 'bar' of link 'foo' of object type 'default::Derived' and as True in property 'bar' of link 'foo' of object type 'default::Base'."));
  });

  it("test_edgeql_ddl_readonly_11", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base0 {
                    CREATE LINK foo -> Object {
                        CREATE PROPERTY bar -> str;
                    };
                };
                CREATE TYPE Base1 {
                    CREATE LINK foo -> Object {
                        CREATE PROPERTY bar -> str {
                            SET readonly := True;
                        };
                    };
                };
                CREATE TYPE Derived EXTENDING Base0, Base1;
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of property 'bar' of link 'foo' of object type 'default::Derived': it is defined as False in property 'bar' of link 'foo' of object type 'default::Base0' and as True in property 'bar' of link 'foo' of object type 'default::Base1'."));
  });

  it("test_edgeql_ddl_readonly_12", () => {
    h.script(
      `

            CREATE TYPE Base0 {
                CREATE LINK foo -> Object {
                    CREATE PROPERTY bar -> str;
                };
            };
            CREATE TYPE Base1 {
                CREATE LINK foo -> Object {
                    CREATE PROPERTY bar -> str;
                };
            };
            CREATE TYPE Derived EXTENDING Base0, Base1;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Base1 {
                    ALTER LINK foo {
                        ALTER PROPERTY bar {
                            SET readonly := True;
                        };
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot redefine the readonly flag of property 'bar' of link 'foo' of object type 'default::Derived': it is defined as False in property 'bar' of link 'foo' of object type 'default::Base0' and as True in property 'bar' of link 'foo' of object type 'default::Base1'."));
  });

  it("test_edgeql_ddl_required_01", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE REQUIRED PROPERTY foo -> str;
                };
                CREATE TYPE Derived EXTENDING Base;
                ALTER TYPE Derived {
                    ALTER PROPERTY foo {
                        SET OPTIONAL;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot make.*optional"));
  });

  it("test_edgeql_ddl_required_02", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE REQUIRED PROPERTY foo -> str;
                };
                CREATE TYPE Derived EXTENDING Base {
                    ALTER PROPERTY foo {
                        SET OPTIONAL;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot make.*optional"));
  });

  it("test_edgeql_ddl_required_03", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE REQUIRED LINK foo -> Object;
                };
                CREATE TYPE Derived EXTENDING Base;
                ALTER TYPE Derived {
                    ALTER LINK foo {
                        SET OPTIONAL;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot make.*optional"));
  });

  it("test_edgeql_ddl_required_04", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE REQUIRED LINK foo -> Object;
                };
                CREATE TYPE Derived EXTENDING Base {
                    ALTER LINK foo {
                        SET OPTIONAL;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot make.*optional"));
  });

  it("test_edgeql_ddl_required_05", () => {
    expect(() => {
      h.script(
        `

                CREATE TYPE Base {
                    CREATE OPTIONAL LINK foo -> Object;
                };
                CREATE TYPE Base2 {
                    CREATE REQUIRED LINK foo -> Object;
                };
                CREATE TYPE Derived EXTENDING Base, Base2 {
                    ALTER LINK foo {
                        SET OPTIONAL;
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot make.*optional"));
  });

  it("test_edgeql_ddl_required_08", () => {
    h.script(
      `

            CREATE TYPE Base {
                CREATE REQUIRED PROPERTY foo -> str;
            };
            CREATE TYPE Derived EXTENDING Base {
                ALTER PROPERTY foo {
                    # overloading the property to be required
                    # regardless of the ancestors
                    SET REQUIRED;
                };
            };
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT Base;
                `
      );
    }).toThrow(new RegExp("missing value for required property 'foo' of object type 'default::Base'"));
    expect(() => {
      h.script(
        `
                    INSERT Derived;
                `
      );
    }).toThrow(new RegExp("missing value for required property 'foo' of object type 'default::Derived'"));
    h.script(
      `
            ALTER TYPE Base {
                ALTER PROPERTY foo {
                    SET OPTIONAL;
                };
            };
        `
    );
    h.script(
      `
            INSERT Base;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT count(Base);
            `,
      [1]
    );
    expect(() => {
      h.script(
        `
                    INSERT Derived;
                `
      );
    }).toThrow(new RegExp("missing value for required property 'foo' of object type 'default::Derived'"));
    h.script(
      `
            ALTER TYPE Derived {
                ALTER PROPERTY foo {
                    SET OPTIONAL;
                };
            };
        `
    );
    h.script(
      `
            INSERT Derived;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT count(Derived);
            `,
      [1]
    );
  });

  it("test_edgeql_ddl_required_09", () => {
    h.script(
      `

            CREATE TYPE Base {
                CREATE OPTIONAL PROPERTY foo -> str;
            };
            CREATE TYPE Derived EXTENDING Base {
                ALTER PROPERTY foo {
                    # overloading the property to be required
                    # regardless of the ancestors
                    SET REQUIRED;
                };
            };
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT Derived;
                `
      );
    }).toThrow(new RegExp("missing value for required property 'foo' of object type 'default::Derived'"));
    h.script(
      `
            INSERT Base;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT count(Base);
            `,
      [1]
    );
    expect(() => {
      h.script(
        `
                    INSERT Derived;
                `
      );
    }).toThrow(new RegExp("missing value for required property 'foo' of object type 'default::Derived'"));
    h.script(
      `
            ALTER TYPE Derived {
                ALTER PROPERTY foo {
                    SET OPTIONAL;
                };
            };
        `
    );
    h.script(
      `
            INSERT Derived;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT count(Derived);
            `,
      [1]
    );
  });

  it("test_edgeql_ddl_required_10", () => {
    h.script(
      `
            CREATE TYPE Base {
                CREATE REQUIRED MULTI PROPERTY name -> str;
            };
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT Base;
                `
      );
    }).toThrow(new RegExp("missing value for required property 'name' of object type 'default::Base'"));
    expect(() => {
      h.script(
        `
                    INSERT Base {name := {}};
                `
      );
    }).toThrow(new RegExp("missing value for required property 'name' of object type 'default::Base'"));
    expect(() => {
      h.script(
        `
                    WITH names := {'A', 'B'}
                    INSERT Base {
                        name := (SELECT names FILTER names = 'C'),
                    };
                `
      );
    }).toThrow(new RegExp("missing value for required property 'name' of object type 'default::Base'"));
  });

  it("test_edgeql_ddl_required_11", () => {
    h.script(
      `
            CREATE TYPE Child;
            CREATE TYPE Base {
                CREATE REQUIRED MULTI LINK children -> Child;
            };
        `
    );
    expect(() => {
      h.script(
        `
                    INSERT Base;
                `
      );
    }).toThrow(new RegExp("missing value for required link 'children' of object type 'default::Base'"));
    expect(() => {
      h.script(
        `
                    INSERT Base {children := {}};
                `
      );
    }).toThrow(new RegExp("missing value for required link 'children' of object type 'default::Base'"));
    expect(() => {
      h.script(
        `
                    INSERT Base {
                        children := (SELECT Child FILTER false)
                    };
                `
      );
    }).toThrow(new RegExp("missing value for required link 'children' of object type 'default::Base'"));
  });

  it("test_edgeql_ddl_prop_alias", () => {
    h.script(
      `
            CREATE TYPE Named {
                CREATE REQUIRED PROPERTY name -> str;
                CREATE PROPERTY canonical_name := .name;
            };
        `
    );
  });

  it("test_edgeql_ddl_index_01", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE MULTI PROPERTY a -> int64;
                    CREATE INDEX ON (.a);
                }
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by the index expression"));
  });

  it("test_edgeql_ddl_index_02", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY a -> int64;
                    CREATE PROPERTY b -> int64;
                    CREATE INDEX ON ({.a, .b});
                }
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by the index expression"));
  });

  it("test_edgeql_ddl_index_03", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY a -> int64;
                    CREATE PROPERTY b -> int64;
                    CREATE INDEX ON (array_unpack([.a, .b]));
                }
            `
      );
    }).toThrow(new RegExp("possibly more than one element returned by the index expression"));
  });

  it("test_edgeql_ddl_index_04", () => {
    expect(() => {
      h.script(
        `
                create function f(s: str) -> str {
                    set volatility := "stable";
                    using (s)
                };

                create type Bar {
                    create property x -> str;
                    create index on (f(.x));
                };
            `
      );
    }).toThrow(new RegExp("index expressions must be immutable"));
  });

  it("test_edgeql_ddl_index_05", () => {
    h.script(
      `
            create type Artist {
                create property oid -> bigint;
                create index on (<str>.oid)
            };
        `
    );
  });

  it("test_edgeql_ddl_index_06", () => {
    h.script(
      `
            create type Foo {
                create property name -> str;
                create property exclude -> bool;
                create index on (.name) except (.exclude);
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::ObjectType {
                indexes: {expr, except_expr}
            } FILTER .name = 'default::Foo'
            `,
      [
            {
              "indexes": [
                {
                  "except_expr": ".exclude",
                  "expr": ".name",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_index_07", () => {
    h.script(
      `
            create type Foo {
                create property fields -> array<str>;
                create index pg::gin on (.fields);
            };
        `
    );
  });

  it("test_edgeql_ddl_index_08", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE default::IndexNonSingletonTest {
                    CREATE PROPERTY has_bad_index: std::str;
                    CREATE INDEX ON (DISTINCT (.has_bad_index));
                };
            `
      );
    }).toThrow(new RegExp("cannot use SET OF operator 'std::DISTINCT' in an index expression"));
  });

  it("test_edgeql_ddl_index_09", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE default::IndexNonSingletonTest {
                    CREATE PROPERTY has_bad_index: std::str;
                    CREATE INDEX ON (std::count (.has_bad_index));
                };
            `
      );
    }).toThrow(new RegExp("cannot use SET OF function 'std::count' in an index expression"));
  });

  it("test_edgeql_ddl_index_10", () => {
    h.script(
      `
            create type T {
                create property foo -> json;
                create index on (<str>.foo);
                create index on (<int64>.foo);
            };
        `
    );
  });

  it("test_edgeql_ddl_index_fts_01", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE default::Named {
                CREATE REQUIRED PROPERTY name: std::str;
                CREATE INDEX fts::index ON (
                  fts::with_options(.name, language := fts::Language.eng)
                );
            };

            CREATE ABSTRACT TYPE default::Project EXTENDING default::Named
            {
                ALTER PROPERTY name {
                    SET OWNED;
                    CREATE CONSTRAINT std::exclusive;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Index { name }
            filter exists .<indexes[is schema::ObjectType]
            and .name like '%index';
            `,
      [
            {
              "name": "std::fts::index",
            },
            {
              "name": "std::fts::index",
            },
          ]
    );
  });

  it("test_edgeql_ddl_abstract_index_01", () => {
    h.script(
      `
                create abstract index test(
                    named only lists: int64
                ) {
                    set code := ' ((__col__) NULLS FIRST)';
                };
            `
    );
    h.script(
      `
                drop abstract index test;
            `
    );
    h.script(
      `
                create abstract index test(
                    named only lists: int64
                ) {
                    set code := ' ((__col__) NULLS FIRST)';
                };
            `
    );
    h.script(
      `
                drop abstract index test;
            `
    );
  });

  it("test_edgeql_ddl_abstract_index_02", () => {
    h.script(
      `
            create abstract index test(
                named only lists: int64
            ) {
                set code := ' ((__col__) NULLS FIRST)';
            };
        `
    );
    h.script(
      `
            create abstract type default::Foo {
                create property content: std::str;
                create index test(lists := 5) on (.content);
            };
            create abstract type default::Bar extending default::Foo;
            create type default::Baz extending default::Bar;
        `
    );
    assertQueryResult(
      h,
      `
            select schema::Index { name, kwargs }
            filter .name = 'default::test'
            `,
      unorderedBag([
            {
              "name": "default::test",
              "kwargs": [],
            },
            {
              "name": "default::test",
              "kwargs": [
                {
                  "name": "lists",
                  "expr": "5",
                },
              ],
            },
            {
              "name": "default::test",
              "kwargs": [
                {
                  "name": "lists",
                  "expr": "5",
                },
              ],
            },
            {
              "name": "default::test",
              "kwargs": [
                {
                  "name": "lists",
                  "expr": "5",
                },
              ],
            },
          ])
    );
    h.script(
      `
            alter type Foo
            drop index test(lists := 5) on (.content);
        `
    );
  });

  it("test_edgeql_ddl_deferred_index_01", () => {
    expect(() => {
      h.script(
        `
                create abstract index test() {
                    set code := ' ((__col__) NULLS FIRST)';
                };

                create type Foo {
                    create property bar -> str;
                    create deferred index test on (.bar);
                };
            `
      );
    }).toThrow(new RegExp("cannot be declared as deferred"));
  });

  it("test_edgeql_ddl_deferred_index_02", () => {
    expect(() => {
      h.script(
        `
                create abstract index test() {
                    set code := ' ((__col__) NULLS FIRST)';
                    set deferrability := 'Required';
                };

                create type Foo {
                    create property bar -> str;
                    create index test on (.bar);
                };
            `
      );
    }).toThrow(new RegExp("must be declared as deferred"));
  });

  it("test_edgeql_ddl_deferred_index_03", () => {
    expect(() => {
      h.script(
        `
                create abstract index test() {
                    set code := ' ((__col__) NULLS FIRST)';
                    set deferrability := 'Prohibited';
                };

                create type Foo {
                    create property bar -> str;
                    create index test on (.bar);
                };

                alter type Foo alter index test on (.bar) set deferred;
            `
      );
    }).toThrow(new RegExp("cannot be declared as deferred"));
  });

  it("test_edgeql_ddl_deferred_index_04", () => {
    expect(() => {
      h.script(
        `
                create abstract index test() {
                    set code := ' ((__col__) NULLS FIRST)';
                    set deferrability := 'Required';
                };

                create type Foo {
                    create property bar -> str;
                    create deferred index test on (.bar);
                };

                alter type Foo alter index test on (.bar) drop deferred;
            `
      );
    }).toThrow(new RegExp("must be declared as deferred"));
  });

  it("test_edgeql_ddl_deferred_index_05", () => {
    expect(() => {
      h.script(
        `
                create type Foo {
                    create property bar -> str;
                    create index on (.bar) {
                        set deferrability := 'Permitted';
                    };
                };
            `
      );
    }).toThrow(new RegExp("deferrability can only be specified on abstract indexes"));
  });

  it("test_edgeql_ddl_deferred_index_06", () => {
    h.script(
      `
            create abstract index test() {
                set code := ' ((__col__) NULLS FIRST)';
                set deferrability := 'Permitted';
            };

            create type Foo {
                create property bar -> str;
                create deferred index test on (.bar);
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::ObjectType {
                name,
                indexes: {
                    deferred,
                    deferrability,
                }
            } FILTER .name = 'default::Foo'
            `,
      [
            {
              "name": "default::Foo",
              "indexes": [
                {
                  "deferred": true,
                  "deferrability": "Permitted",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_errors_01", () => {
    h.script(
      `
            CREATE TYPE Err1 {
                CREATE REQUIRED PROPERTY foo -> str;
            };

            ALTER TYPE Err1
            CREATE REQUIRED LINK bar -> Err1;
        `
    );
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 ALTER PROPERTY b
                    CREATE CONSTRAINT std::regexp(r'b');
                `
      );
    }).toThrow(new RegExp("property 'b' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 DROP PROPERTY b
                `
      );
    }).toThrow(new RegExp("property 'b' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 ALTER PROPERTY foo
                    DROP CONSTRAINT a;
                `
      );
    }).toThrow(new RegExp("constraint 'default::a' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 ALTER PROPERTY foo
                    ALTER CONSTRAINT a ON (foo > 0) {
                        CREATE ANNOTATION title := 'test'
                    }
                `
      );
    }).toThrow(new RegExp("constraint 'default::a' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 ALTER PROPERTY foo
                    ALTER ANNOTATION title := 'aaa'
                `
      );
    }).toThrow(new RegExp("annotation 'std::title' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 ALTER PROPERTY foo
                    DROP ANNOTATION title;
                `
      );
    }).toThrow(new RegExp("annotation 'std::title' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1
                    ALTER ANNOTATION title := 'aaa'
                `
      );
    }).toThrow(new RegExp("annotation 'std::title' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1
                    DROP ANNOTATION title
                `
      );
    }).toThrow(new RegExp("annotation 'std::title' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1
                    DROP INDEX ON (.foo)
                `
      );
    }).toThrow(new RegExp("index on \\(.foo\\) does not exist on object type 'default::Err1'"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1
                    DROP INDEX ON (.zz)
                `
      );
    }).toThrow(new RegExp("index on \\(.zz\\) does not exist on object type 'default::Err1'"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1
                    CREATE INDEX ON (.zz)
                `
      );
    }).toThrow(new RegExp("object type 'default::Err1' has no link or property 'zz'"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1
                    CREATE INDEX ON ((.foo, .zz))
                `
      );
    }).toThrow(new RegExp("object type 'default::Err1' has no link or property 'zz'"));
    expect(() => {
      h.script(
        `
                    CREATE TYPE Err1 EXTENDING blah {
                        CREATE PROPERTY foo -> str;
                    };
                `
      );
    }).toThrow(new RegExp("object type 'default::blah' does not exist"));
    expect(() => {
      h.script(
        `
                    CREATE TYPE Err2 EXTENDING blah {
                        CREATE PROPERTY foo -> str;
                    };
                `
      );
    }).toThrow(new RegExp("object type 'default::blah' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 ALTER LINK b
                    CREATE CONSTRAINT std::regexp(r'b');
                `
      );
    }).toThrow(new RegExp("link 'b' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 DROP LINK b;
                `
      );
    }).toThrow(new RegExp("link 'b' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 ALTER LINK bar
                    DROP ANNOTATION title;
                `
      );
    }).toThrow(new RegExp("annotation 'std::title' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1 ALTER LINK bar
                    DROP CONSTRAINT min_value(0);
                `
      );
    }).toThrow(new RegExp("constraint 'std::min_value' does not exist"));
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err1
                    ALTER LINK bar
                    DROP PROPERTY spam;
                `
      );
    }).toThrow(new RegExp("property 'spam' does not exist"));
  });

  it.skip("test_edgeql_ddl_errors_02 [xfail: The test currently fails with the ugly \"'default::__|foo@default|Err2' exists, but is a property, not a link\" but it should fail with \"link 'foo' does not exist\", as `ALTER LINK foo` is the preceeding invalid command.]", () => {
    h.script(
      `
            CREATE TYPE Err2 {
                CREATE REQUIRED PROPERTY foo -> str;
            };

            ALTER TYPE Err2
            CREATE REQUIRED LINK bar -> Err2;
        `
    );
    expect(() => {
      h.script(
        `
                    ALTER TYPE Err2
                    ALTER LINK foo
                    DROP PROPERTY spam;
                `
      );
    }).toThrow(new RegExp("link 'foo' does not exist"));
  });

  it("test_edgeql_ddl_errors_03", () => {
    expect(() => {
      h.script(
        `
                    ALTER FUNCTION foo___1(a: int64)
                    SET volatility := 'Stable';
                `
      );
    }).toThrow(new RegExp("function 'default::foo___1' does not exist"));
    expect(() => {
      h.script(
        `
                    DROP FUNCTION foo___1(a: int64);
                `
      );
    }).toThrow(new RegExp("function 'default::foo___1' does not exist"));
  });

  it("test_edgeql_ddl_migration_sdl_01", () => {
    h.script(
      `
            CONFIGURE SESSION SET store_migration_sdl :=
                cfg::StoreMigrationSDL.AlwaysStore;
        `
    );
    h.script(
      `
            create type A;
            create type B {
                create property n -> int64;
            };
            alter type A {
                create link b -> B;
            };
            alter type A {
                alter link b {
                    create property n -> int64
                };
            };
            alter type A {
                alter link b {
                    drop property n;
                };
            };
            alter type B {
                drop property n;
            };
        `
    );
    h.script(
      `
            drop type A;
        `
    );
    let migrations = TestEdgeQLDDL.order_migrations(json.loads(con.query_json("\n                select schema::Migration { id, parents: { id }, sdl }\n            ")));
    let sdl = undefined;
    expect(true).toBe(true);
  });

  it("test_edgeql_ddl_create_migration_01", () => {
    h.script(
      `
            CONFIGURE SESSION SET store_migration_sdl :=
                cfg::StoreMigrationSDL.AlwaysStore;
        `
    );
    h.script(
      `
            CREATE MIGRATION
            {
                CREATE TYPE Type1 {
                    CREATE PROPERTY field1 -> str;
                };
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT schema::ObjectType {
                name
            } FILTER .name = 'default::Type1'
            `,
      [
            {
              "name": "default::Type1",
            },
          ]
    );
    let migrations = TestEdgeQLDDL.order_migrations(json.loads(con.query_json("\n                select schema::Migration {\n                    id, parents: { id }, script, sdl\n                }\n            ")));
    expect(true).toBe(true);
  });

  it("test_edgeql_ddl_create_migration_02", () => {
    h.script(
      `
            CONFIGURE SESSION SET store_migration_sdl :=
                cfg::StoreMigrationSDL.AlwaysStore;
        `
    );
    h.script(
      `
CREATE MIGRATION m1kmv2mcizpj2twxlxxerkgngr2fkto7wnjd6uig3aa3x67dykvspq
    ONTO initial
{
  CREATE GLOBAL default::foo -> std::bool;
  CREATE TYPE default::Foo {
      CREATE ACCESS POLICY foo
          ALLOW ALL USING ((GLOBAL default::foo ?? true));
  };
};
        `
    );
    h.script(
      `
CREATE MIGRATION m14i24uhm6przo3bpl2lqndphuomfrtq3qdjaqdg6fza7h6m7tlbra
    ONTO m1kmv2mcizpj2twxlxxerkgngr2fkto7wnjd6uig3aa3x67dykvspq
{
  CREATE TYPE default::X;

  INSERT Foo;
};
        `
    );
    let migrations = TestEdgeQLDDL.order_migrations(json.loads(con.query_json("\n                select schema::Migration {\n                    id, parents: { id }, script, sdl\n                }\n            ")));
    expect(true).toBe(true);
  });

  it("test_edgeql_ddl_create_migration_03", () => {
    h.script(
      `
            CONFIGURE SESSION SET store_migration_sdl :=
                cfg::StoreMigrationSDL.AlwaysStore;
        `
    );
    h.script(
      `
            CREATE MIGRATION
            {
                SET message := "migration2";
                SET generated_by := schema::MigrationGeneratedBy.DevMode;
                CREATE TYPE Type2 {
                    CREATE PROPERTY field2 -> int32;
                };
            };
        `
    );
    let migrations = TestEdgeQLDDL.order_migrations(json.loads(con.query_json("\n                select schema::Migration {\n                    id,\n                    parents: { id },\n                    message,\n                    generated_by,\n                    script,\n                    sdl,\n                }\n            ")));
    expect(true).toBe(true);
    h.script(
      `
            CREATE TYPE Type3
        `
    );
    migrations = TestEdgeQLDDL.order_migrations(json.loads(con.query_json("\n                select schema::Migration {\n                    id,\n                    parents: { id },\n                    message,\n                    generated_by,\n                    script,\n                    sdl,\n                }\n            ")));
    expect(true).toBe(true);
  });

  it("test_edgeql_ddl_create_migration_04", () => {
    h.script(
      `
            CREATE MIGRATION
            {
                create global foo -> str;
                create type Foo;
            };
        `
    );
    h.script(
      `
            insert Foo;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE MIGRATION
                {
                    set global foo := "test";
                    alter type Foo {
                        create required property name -> str {
                        set default := (global foo);
                    }
                };
            `
      );
    }).toThrow(new RegExp("Unexpected keyword 'GLOBAL'"));
  });

  it("test_edgeql_ddl_create_migration_05", () => {
    h.script(
      `
            create type X { create property x -> str; };
        `
    );
    expect(() => {
      h.script(
        `
                CREATE MIGRATION
                {
                    alter type default::X {
                        alter property x rename to y;
                    };
                    alter type default::X {
                        alter property x create constraint exclusive;
                    };
                };
            `
      );
    }).toThrow(new RegExp("property 'x' does not"));
  });

  it("test_edgeql_ddl_naked_backlink_in_computable", () => {
    h.script(
      `
            CREATE TYPE User {
                CREATE PROPERTY name -> str {
                    CREATE CONSTRAINT exclusive;
                };
            };
            CREATE TYPE Post {
                CREATE LINK author -> User;
            };
            CREATE TYPE Video {
                CREATE LINK author -> User;
            };
            ALTER TYPE User {
                CREATE MULTI LINK authored := .<author;
            };
            INSERT User { name := 'Lars' };
            INSERT Post { author := (SELECT User FILTER .name = 'Lars') };
            INSERT Video { author := (SELECT User FILTER .name = 'Lars') };
        `
    );
    assertQueryResult(
      h,
      `
            WITH
                User := (SELECT schema::ObjectType
                         FILTER .name = 'default::User')
            SELECT
                User.pointers {
                    target: {
                        name
                    }
                }
            FILTER
                .name = 'authored'
            `,
      [
            {
              "target": {
                "name": "std::BaseObject",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT _ := User.authored.__type__.name
            ORDER BY _
            `,
      ["default::Post", "default::Video"]
    );
  });

  it("test_edgeql_ddl_change_module_01", () => {
    h.script(
      `
            CREATE MODULE foo;

            CREATE TYPE Note {
                CREATE PROPERTY note -> str;
            };
            ALTER TYPE Note RENAME TO foo::Note;
            DROP TYPE foo::Note;
        `
    );
  });

  it("test_edgeql_ddl_change_module_02", () => {
    h.script(
      `
            CREATE MODULE foo;

            CREATE TYPE Parent {
                CREATE PROPERTY note -> str;
            };
            CREATE TYPE Sub EXTENDING Parent;
            ALTER TYPE Parent RENAME TO foo::Parent;
            DROP TYPE Sub;
            DROP TYPE foo::Parent;
        `
    );
  });

  it("test_edgeql_ddl_change_module_03", () => {
    h.script(
      `
            CREATE MODULE foo;

            CREATE TYPE Note {
                CREATE PROPERTY note -> str {
                    CREATE CONSTRAINT exclusive;
                }
            };
            ALTER TYPE Note RENAME TO foo::Note;
            DROP TYPE foo::Note;
        `
    );
  });

  it("test_edgeql_ddl_change_module_04", () => {
    h.script(
      `
            CREATE MODULE foo;

            CREATE TYPE Tag;

            CREATE TYPE Note {
                CREATE SINGLE LINK tags -> Tag {
                    ON TARGET DELETE DELETE SOURCE;
                }
            };

            INSERT Note { tags := (INSERT Tag) };
        `
    );
    h.script(
      `
            ALTER TYPE Tag RENAME TO foo::Tag;
            DELETE foo::Tag FILTER true;
        `
    );
    assertQueryResult(
      h,
      `SELECT Note;`,
      []
    );
    h.script(
      `
            ALTER TYPE Note RENAME TO foo::Note;
            DROP TYPE foo::Note;
            DROP TYPE foo::Tag;
        `
    );
  });

  it("test_edgeql_ddl_rewrite_and_trigger_01", () => {
    h.script(
      `
            create type Entry {
                create property x := 0;
                create property y -> int64 {
                    create rewrite insert, update using (.x);
                };
            };
            create type Foo {
                create trigger log0 after insert for each do (insert Entry);
            };
            create type Bar {
                create trigger log1 after insert for each do (insert Foo);
            };
        `
    );
    h.script(
      `
            alter type Entry alter property x using (1)
        `
    );
    h.script(
      `
            alter type Entry alter property y drop rewrite insert, update;
        `
    );
    h.script(
      `
            alter type Foo drop trigger log0;
        `
    );
  });

  it("test_edgeql_ddl_rename_ref_function_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_function_02", () => {
    h.script(
      `
            CREATE TYPE Note {
                CREATE PROPERTY note -> str;
            };

            CREATE TYPE Name {
                CREATE PROPERTY name -> str;
            };

            CREATE FUNCTION foo(x: Note, y: Name) -> OPTIONAL str {
                USING (SELECT (x.note ++ " " ++ y.name))
            };
        `
    );
    h.script(
      `
            INSERT Note { note := "hello" }
        `
    );
    h.script(
      `
            INSERT Name { name := "world" }
        `
    );
    h.script(
      `
            CREATE MIGRATION {
                ALTER TYPE Note RENAME TO Remark;
                ALTER TYPE Name RENAME TO Handle;
            }
            `
    );
    let res = h.query("\n            DESCRIBE MODULE default\n        ");
    expect(res.count("Note")).toEqual(0);
    expect(res.count("Name")).toEqual(0);
    expect(res.count("Remark")).toEqual(2);
    expect(res.count("Handle")).toEqual(2);
    assertQueryResult(
      h,
      `
                SELECT foo(Remark, Handle);
            `,
      ["hello world"]
    );
    h.script(
      `
            DROP FUNCTION foo(x: Remark, y: Handle);
        `
    );
  });

  it("test_edgeql_ddl_rename_ref_function_03", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_function_04", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_function_05", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_default_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_constraint_01", () => {
    h.script(
      `
            CREATE TYPE Note {
                CREATE PROPERTY name -> str;
                CREATE PROPERTY note -> str;
                CREATE CONSTRAINT exclusive ON (
                    (__subject__.name, __subject__.note));
            };
        `
    );
    h.script(
      `
            ALTER TYPE Note {
                ALTER PROPERTY note {
                    RENAME TO remark;
                };
                ALTER PROPERTY name {
                    RENAME TO callsign;
                };
            }
        `
    );
    let res = h.query("\n            DESCRIBE MODULE default\n        ");
    expect(res.count("note")).toEqual(0);
    expect(res.count("remark")).toEqual(2);
    expect(res.count("name")).toEqual(0);
    expect(res.count("callsign")).toEqual(2);
    h.script(
      `
            ALTER TYPE Note
            DROP CONSTRAINT exclusive ON ((
                (__subject__.callsign, __subject__.remark)));
        `
    );
  });

  it("test_edgeql_ddl_rename_ref_index_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_default_02", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_computable_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_computable_02", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_type_alias_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_expr_alias_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_shape_alias_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_rewrites_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_triggers_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_rename_ref_prop_alias_01", () => {
    _simple_rename_ref_tests();
  });

  it("test_edgeql_ddl_describe_nested_module_01", () => {
    h.script(
      `
            create module foo;
            create module foo::bar;
            create type foo::bar::T;
        `
    );
    assertQueryResult(
      h,
      `describe module foo::bar;`,
      ["create type foo::bar::T;"]
    );
  });

  it("test_edgeql_ddl_drop_multi_prop_01", () => {
    h.script(
      `

            CREATE TYPE Test {
                CREATE MULTI PROPERTY x -> str;
                CREATE MULTI PROPERTY y := {1, 2, 3};
            };
        `
    );
    h.script(
      `
            ALTER TYPE Test DROP PROPERTY x;
        `
    );
    h.script(
      `
            ALTER TYPE Test DROP PROPERTY y;
        `
    );
    h.script(
      `
            INSERT Test;
            DELETE Test;
        `
    );
  });

  it("test_edgeql_ddl_collection_cleanup_01", () => {
    let orig_count = h.query("SELECT count(schema::Tuple);");
    h.script(
      `

            CREATE SCALAR TYPE a extending str;
            CREATE SCALAR TYPE b extending str;
            CREATE SCALAR TYPE c extending str;

            CREATE TYPE TestTuples {
                CREATE PROPERTY x -> tuple<a>;
                CREATE PROPERTY y -> tuple<b>;
            };
        `
    );
    expect(h.query("SELECT count(schema::Tuple);")).toEqual((orig_count + 2));
    h.script(
      `
            ALTER TYPE TestTuples {
                DROP PROPERTY x;
            };
        `
    );
    expect(h.query("SELECT count(schema::Tuple);")).toEqual((orig_count + 1));
    h.script(
      `
            ALTER TYPE TestTuples {
                ALTER PROPERTY y {
                    SET TYPE tuple<c> USING (
                        <tuple<c>><tuple<str>>.y);
                }
            };
        `
    );
    expect(h.query("SELECT count(schema::Tuple);")).toEqual((orig_count + 1));
    h.script(
      `
            DROP TYPE TestTuples;
        `
    );
    expect(h.query("SELECT count(schema::Tuple);")).toEqual(orig_count);
  });

  it("test_edgeql_ddl_collection_cleanup_01b", () => {
    let orig_count = h.query("SELECT count(schema::Tuple);");
    h.script(
      `

            CREATE SCALAR TYPE a extending str;
            CREATE SCALAR TYPE b extending str;
            CREATE SCALAR TYPE c extending str;

            CREATE TYPE TestTuples {
                CREATE PROPERTY x -> tuple<a>;
                CREATE PROPERTY y -> tuple<b>;
                CREATE PROPERTY z -> tuple<b>;
            };
        `
    );
    expect(h.query("SELECT count(schema::Tuple);")).toEqual((orig_count + 2));
    h.script(
      `
            ALTER TYPE TestTuples {
                DROP PROPERTY x;
            };
        `
    );
    expect(h.query("SELECT count(schema::Tuple);")).toEqual((orig_count + 1));
    h.script(
      `
            ALTER TYPE TestTuples {
                ALTER PROPERTY y {
                    SET TYPE tuple<c> USING (
                        <tuple<c>><tuple<str>>.y);
                }
            };
        `
    );
    expect(h.query("SELECT count(schema::Tuple);")).toEqual((orig_count + 2));
    h.script(
      `
            DROP TYPE TestTuples;
        `
    );
    expect(h.query("SELECT count(schema::Tuple);")).toEqual(orig_count);
  });

  it("test_edgeql_ddl_collection_cleanup_02", () => {
    let orig_count = h.query("SELECT count(schema::CollectionType);");
    h.script(
      `

            CREATE SCALAR TYPE a extending str;
            CREATE SCALAR TYPE b extending str;
            CREATE SCALAR TYPE c extending str;

            CREATE TYPE TestArrays {
                CREATE PROPERTY x -> array<tuple<a, b>>;
            };
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 3) + 2));
    h.script(
      `
            DROP TYPE TestArrays;
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual((orig_count + 3));
  });

  it("test_edgeql_ddl_collection_cleanup_03", () => {
    let orig_count = h.query("SELECT count(schema::CollectionType);");
    let orig_elem_count = h.query("SELECT count(schema::TupleElement);");
    h.script(
      `

            CREATE SCALAR TYPE a extending str;
            CREATE SCALAR TYPE b extending str;
            CREATE SCALAR TYPE c extending str;

            CREATE FUNCTION foo(x: array<a>, z: tuple<b, c>,
                                y: array<tuple<b, c>>)
                 -> array<b> USING (SELECT [<b>""]);
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 3) + 2));
    h.script(
      `
            DROP FUNCTION foo(
                x: array<a>, z: tuple<b, c>, y: array<tuple<b, c>>);
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual((orig_count + 3));
    expect(h.query("SELECT count(schema::TupleElement);")).toEqual(orig_elem_count);
  });

  it("test_edgeql_ddl_collection_cleanup_04", () => {
    let orig_count = h.query("SELECT count(schema::CollectionType);");
    h.script(
      `

            CREATE SCALAR TYPE a extending str;
            CREATE SCALAR TYPE b extending str;
            CREATE SCALAR TYPE c extending str;

            CREATE TYPE Foo {
                CREATE PROPERTY a -> a;
                CREATE PROPERTY b -> b;
                CREATE PROPERTY c -> c;
            };

            CREATE ALIAS Bar := Foo { thing := (.a, .b) };
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 3) + 1));
    h.script(
      `
            ALTER ALIAS Bar USING (Foo { thing := (.a, .b, .c) });
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 3) + 1));
    h.script(
      `
            ALTER ALIAS Bar USING (Foo { thing := (.a, (.b, .c)) });
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 3) + 2));
    h.script(
      `
            ALTER ALIAS Bar USING (Foo { thing := ((.a, .b), .c) });
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 3) + 2));
    h.script(
      `
            ALTER ALIAS Bar USING (Foo { thing := ((.a, .b), .c, "foo") });
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 3) + 2));
    h.script(
      `
            ALTER ALIAS Bar USING (Foo { thing := ((.a, .b), .c, "bar") });
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 3) + 2));
    h.script(
      `
            DROP ALIAS Bar;
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual((orig_count + 3));
  });

  it("test_edgeql_ddl_collection_cleanup_05", () => {
    let orig_count = h.query("SELECT count(schema::CollectionType);");
    h.script(
      `

            CREATE SCALAR TYPE a extending str;
            CREATE SCALAR TYPE b extending str;

            CREATE ALIAS Bar := (<a>"", <b>"");
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 2) + 2));
    h.script(
      `
            ALTER ALIAS Bar USING ((<b>"", <a>""));
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual(((orig_count + 2) + 2));
    h.script(
      `
            DROP ALIAS Bar;
        `
    );
    expect(h.query("SELECT count(schema::CollectionType);")).toEqual((orig_count + 2));
  });

  it("test_edgeql_ddl_drop_field_01", () => {
    h.script(
      `

            CREATE FUNCTION foo() -> str USING ("test");

            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY a -> str {
                    SET default := foo();
                }
            };
        `
    );
    h.script(
      `
            INSERT Foo;
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY a {
                    RESET default;
                }
            };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo;
            `
      );
    }).toThrow(new RegExp("missing value for required property 'a' of object type 'default::Foo'"));
    h.script(
      `
            DROP FUNCTION foo();
        `
    );
  });

  it("test_edgeql_ddl_drop_field_02", () => {
    h.script(
      `

            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY a -> str {
                    CREATE CONSTRAINT exclusive {
                        SET errmessage := "whoops";
                    }
                }
            };
        `
    );
    h.script(
      `
            INSERT Foo { a := "x" };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo { a := "x" };
            `
      );
    }).toThrow(new RegExp("whoops"));
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY a {
                    ALTER CONSTRAINT exclusive {
                        RESET errmessage;
                    }
                }
            };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo { a := "x" };
            `
      );
    }).toThrow(new RegExp("a violates exclusivity constraint"));
  });

  it("test_edgeql_ddl_drop_field_03", () => {
    h.script(
      `

            CREATE ABSTRACT CONSTRAINT bogus {
                USING (false);
                SET errmessage := "never!";
            };

            CREATE TYPE Foo {
                CREATE CONSTRAINT bogus on (true);
            };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo;
            `
      );
    }).toThrow(new RegExp("never!"));
    h.script(
      `
            ALTER ABSTRACT CONSTRAINT bogus
            RESET errmessage;
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo;
            `
      );
    }).toThrow(new RegExp("invalid Foo"));
  });

  it("test_edgeql_ddl_bad_field_01", () => {
    expect(() => {
      h.script(
        `
                CREATE SCALAR TYPE Lol extending str {SET ha := "crash"};
            `
      );
    }).toThrow(new RegExp("'ha' is not a valid field"));
  });

  it("test_edgeql_ddl_bad_field_02", () => {
    expect(() => {
      h.script(
        `
                START MIGRATION TO {
                    scalar type default::Lol extending str {
                        ha := "crash"
                    }
                }
            `
      );
    }).toThrow(new RegExp("'ha' is not a valid field"));
  });

  it("test_edgeql_ddl_adjust_computed_01", () => {
    h.script(
      `

            CREATE TYPE Foo {
                CREATE PROPERTY foo := {1, 2, 3};
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY foo SET MULTI;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY foo RESET CARDINALITY;
            };
        `
    );
  });

  it("test_edgeql_ddl_adjust_computed_02", () => {
    h.script(
      `

            CREATE TYPE Foo {
                CREATE PROPERTY foo := 1;
            };
        `
    );
    h.script(
      `
            INSERT Foo;
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo { foo }`,
      [
            {
              "foo": 1,
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY foo SET MULTI;
            };
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo { foo }`,
      [
            {
              "foo": [1],
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY foo RESET CARDINALITY;
            };
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo { foo }`,
      [
            {
              "foo": 1,
            },
          ]
    );
  });

  it("test_edgeql_ddl_adjust_computed_03", () => {
    h.script(
      `

            CREATE TYPE Foo {
                CREATE PROPERTY foo := 1;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Pointer {
                    required,
                    has_required := contains(.computed_fields, "required")
                } FILTER .name = "foo"
            `,
      [
            {
              "required": true,
              "has_required": true,
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY foo SET OPTIONAL;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Pointer {
                    required,
                    has_required := contains(.computed_fields, "required")
                } FILTER .name = "foo"
            `,
      [
            {
              "required": false,
              "has_required": false,
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY foo RESET OPTIONALITY;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Pointer {
                    required,
                    has_required := contains(.computed_fields, "required")
                } FILTER .name = "foo"
            `,
      [
            {
              "required": true,
              "has_required": true,
            },
          ]
    );
    h.script(
      `
            ALTER TYPE Foo {
                ALTER PROPERTY foo SET REQUIRED;
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT schema::Pointer {
                    required,
                    has_required := contains(.computed_fields, "required")
                } FILTER .name = "foo"
            `,
      [
            {
              "required": true,
              "has_required": false,
            },
          ]
    );
  });

  it("test_edgeql_ddl_adjust_computed_04", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE REQUIRED PROPERTY bar -> str;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo { ALTER PROPERTY bar { USING ("1") } };
        `
    );
    h.script(
      `
            INSERT Foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo { ALTER PROPERTY bar RESET EXPRESSION };
            `
      );
    }).toThrow(new RegExp("missing value for required property"));
    h.script(
      `
            DELETE Foo;
            ALTER TYPE Foo { ALTER PROPERTY bar RESET EXPRESSION };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo;
            `
      );
    }).toThrow(new RegExp("missing value for required property"));
  });

  it("test_edgeql_ddl_adjust_computed_05", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE REQUIRED LINK bar -> Tgt;
            };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    h.script(
      `
            ALTER TYPE Foo { ALTER LINK bar {
                USING (assert_exists((SELECT Tgt LIMIT 1)))
            } };
        `
    );
    h.script(
      `
            INSERT Foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo { ALTER LINK bar RESET EXPRESSION };
            `
      );
    }).toThrow(new RegExp("missing value for required link"));
    h.script(
      `
            DELETE Foo;
            ALTER TYPE Foo { ALTER LINK bar RESET EXPRESSION };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo;
            `
      );
    }).toThrow(new RegExp("missing value for required link"));
  });

  it("test_edgeql_ddl_adjust_computed_06", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE REQUIRED MULTI LINK bar -> Tgt;
            };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    h.script(
      `
            ALTER TYPE Foo { ALTER LINK bar {
                USING (assert_exists((SELECT Tgt)))
            } };
        `
    );
    h.script(
      `
            INSERT Foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo { ALTER LINK bar RESET EXPRESSION };
            `
      );
    }).toThrow(new RegExp("missing value for required link"));
    h.script(
      `
            DELETE Foo;
            ALTER TYPE Foo { ALTER LINK bar RESET EXPRESSION };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Foo;
            `
      );
    }).toThrow(new RegExp("missing value for required link"));
  });

  it("test_edgeql_ddl_adjust_computed_07", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY bar -> str;
            };
            CREATE TYPE Bar EXTENDING Foo;
            INSERT Foo { bar := "hello" };
            ALTER TYPE Foo { ALTER PROPERTY bar { USING ("world") } };
            ALTER TYPE Foo { ALTER PROPERTY bar RESET expression };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo { bar }
            `,
      [
            {
              "bar": null,
            },
          ]
    );
  });

  it("test_edgeql_ddl_adjust_computed_08", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE MULTI PROPERTY bar -> str;
            };
            CREATE TYPE Bar EXTENDING Foo;
            INSERT Foo { bar := {"foo", "bar"} };
            ALTER TYPE Foo { ALTER PROPERTY bar { USING ({"a", "b"}) } };
            ALTER TYPE Foo { ALTER PROPERTY bar RESET expression };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo { bar }
            `,
      [
            {
              "bar": [],
            },
          ]
    );
  });

  it("test_edgeql_ddl_adjust_computed_09", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE MULTI LINK bar -> Tgt;
            };
            CREATE TYPE Bar EXTENDING Foo;
            INSERT Foo { bar := (INSERT Tgt) };
            ALTER TYPE Foo { ALTER LINK bar { USING (Tgt) } };
            ALTER TYPE Foo { ALTER LINK bar RESET expression };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo { bar }
            `,
      [
            {
              "bar": [],
            },
          ]
    );
  });

  it("test_edgeql_ddl_adjust_computed_10", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE MULTI PROPERTY bar -> str;
            };
            CREATE TYPE Bar EXTENDING Foo;
            INSERT Foo { bar := {"foo", "bar"} };
            ALTER TYPE Foo { ALTER PROPERTY bar { USING ({"a", "b"}) } };
        `
    );
    assertQueryResult(
      h,
      `
                DELETE Foo
            `,
      [
            {},
          ]
    );
  });

  it("test_edgeql_ddl_adjust_computed_11", () => {
    h.script(
      `
            CREATE TYPE default::Foo;
            CREATE TYPE default::Bar {
                CREATE LINK foos := (default::Foo);
            };
        `
    );
    h.script(
      `
            ALTER TYPE default::Bar {
                ALTER LINK foos {
                    RESET EXPRESSION;
                    RESET CARDINALITY using (<Foo>{});
                    RESET OPTIONALITY;
                    SET TYPE default::Foo;
                };
            }
        `
    );
  });

  it("test_edgeql_ddl_adjust_computed_12", () => {
    h.script(
      `
            CREATE TYPE default::Foo {
                CREATE PROPERTY foo := 'hello';
            };
            ALTER TYPE default::Foo {
                ALTER PROPERTY foo {
                    RESET EXPRESSION;
                    RESET OPTIONALITY;
                    SET TYPE std::str;
                }
            };
        `
    );
    h.script(
      `
            TYPE default::Foo {
                PROPERTY foo: std::str;
            };
            ALIAS default::FooAlias := default::Foo;
        `
    );
  });

  it("test_edgeql_ddl_adjust_computed_13", () => {
    h.script(
      `
            create type X {
                create property bar -> int64 {
                    create constraint std::exclusive
                }
            };
        `
    );
    h.script(
      `
            alter type X alter property bar using ('1');
        `
    );
  });

  it("test_edgeql_ddl_adjust_computed_14", () => {
    h.script(
      `
            create type X {
                create property bar -> int64;
                create constraint std::exclusive on (.bar);
            };
        `
    );
    h.script(
      `
            alter type X alter property bar using ('1');
        `
    );
  });

  it("test_edgeql_ddl_adjust_computed_15", () => {
    h.script(
      `
            create type Away {
                create property x -> str;
                create property y {
                    using (.x ++ "!");
                    create constraint exclusive;
                }
            };
            create type Away2 extending Away;
        `
    );
    h.script(
      `
            alter type Away alter property y reset expression;
        `
    );
    h.script(
      `
            insert Away { x := '1', y := '1' }
        `
    );
    expect(() => {
      h.script(
        `
                insert Away { x := '2', y := '1' }
            `
      );
    }).toThrow(new RegExp(""));
  });

  it("test_edgeql_ddl_adjust_computed_16", () => {
    h.script(
      `
            create type Away {
                create property x -> str;
                create property y {
                    using (.x);
                    create constraint exclusive;
                }
            };
            create type Away2 extending Away;
        `
    );
    h.script(
      `
            alter type Away alter property y reset expression;
        `
    );
    h.script(
      `
            insert Away { x := '2', y := '1' }
        `
    );
    expect(() => {
      h.script(
        `
                insert Away { x := '1', y := '1' }
            `
      );
    }).toThrow(new RegExp(""));
  });

  it("test_edgeql_ddl_captured_as_migration_01", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY foo := 1;
            };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    MODULE schema,
                    LM := (
                        SELECT Migration
                        FILTER NOT EXISTS(.<parents[IS Migration])
                    )
                    SELECT LM {
                        script
                    }
            `,
      [
            {
              "script": "SET generated_by := (schema::MigrationGeneratedBy.DDLStatement);\nCREATE TYPE Foo {\n    CREATE PROPERTY foo := (1);\n};",
            },
          ]
    );
  });

  it("test_edgeql_ddl_link_policy_01", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Foo { CREATE MULTI LINK tgt -> Tgt; };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    h.script(
      `
            INSERT Bar { tgt := (INSERT Tgt) };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt;
            `
      );
    }).toThrow(new RegExp("prohibited by link target policy"));
  });

  it("test_edgeql_ddl_link_policy_02", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Base { CREATE MULTI LINK tgt -> Tgt; };
            CREATE TYPE Foo;
            ALTER TYPE Foo EXTENDING Base;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt) };
        `
    );
    h.script(
      `
            DELETE Foo;
        `
    );
    h.script(
      `
            DELETE Tgt;
        `
    );
  });

  it("test_edgeql_ddl_link_policy_03", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Base;
            CREATE TYPE Foo EXTENDING Base { CREATE MULTI LINK tgt -> Tgt; };
            ALTER TYPE Base CREATE MULTI LINK foo -> Tgt;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt) };
        `
    );
    h.script(
      `
                WITH D := Foo,
                SELECT {(DELETE D.tgt), (DELETE D)};
            `
    );
    h.script(
      `
            WITH D := Foo,
            SELECT {(DELETE D), (DELETE D.tgt)};
        `
    );
  });

  it("test_edgeql_ddl_link_policy_04", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Foo { CREATE MULTI LINK tgt -> Tgt; };
            CREATE TYPE Tgt2 EXTENDING Tgt;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt2) };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt2;
            `
      );
    }).toThrow(new RegExp("prohibited by link target policy"));
  });

  it("test_edgeql_ddl_link_policy_05", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Foo { CREATE MULTI LINK tgt -> Tgt; };
            CREATE TYPE Tgt2;
            ALTER TYPE Tgt2 EXTENDING Tgt;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt2) };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt2;
            `
      );
    }).toThrow(new RegExp("prohibited by link target policy"));
    h.script(
      `
            DELETE Foo;
            ALTER TYPE Tgt2 DROP EXTENDING Tgt;
            DROP TYPE Foo;
        `
    );
    h.script(
      `
            DELETE Tgt2;
        `
    );
  });

  it("test_edgeql_ddl_link_policy_06", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Tgt2 EXTENDING Tgt;
            CREATE TYPE Foo { CREATE MULTI LINK tgt -> Tgt2; };
            CREATE TYPE Bar { CREATE MULTI LINK tgt -> Tgt; };
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt2) };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt2;
            `
      );
    }).toThrow(new RegExp("prohibited by link target policy"));
  });

  it("test_edgeql_ddl_link_policy_07", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE MULTI LINK tgt -> Tgt;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Foo ALTER LINK tgt ON TARGET DELETE DEFERRED RESTRICT;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt) };
        `
    );
    h.script(
      `
            DELETE Tgt;
            DELETE Foo;
        `
    );
  });

  it("test_edgeql_ddl_link_policy_08", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE LINK tgt -> Tgt;
            };
            ALTER TYPE Foo ALTER LINK tgt SET MULTI;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt) };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt;
            `
      );
    }).toThrow(new RegExp("prohibited by link target policy"));
    h.script(
      `
            DELETE Foo;
            DELETE Tgt;
        `
    );
  });

  it("test_edgeql_ddl_link_policy_09", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE LINK tgt -> Tgt;
            };
            CREATE TYPE Bar EXTENDING Foo {
                ALTER LINK tgt SET OWNED;
            };
            ALTER TYPE Bar DROP EXTENDING Foo;
        `
    );
    h.script(
      `
            INSERT Bar { tgt := (INSERT Tgt) };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt;
            `
      );
    }).toThrow(new RegExp("prohibited by link target policy"));
    h.script(
      `
            DELETE Bar;
            DELETE Tgt;
        `
    );
  });

  it("test_edgeql_ddl_link_policy_10", () => {
    h.script(
      `

            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE LINK tgt -> Tgt {
                    ON TARGET DELETE ALLOW;
                };
                CREATE CONSTRAINT expression on (EXISTS .tgt);

            };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    h.script(
      `
            INSERT Bar { tgt := (INSERT Tgt) };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt;
            `
      );
    }).toThrow(new RegExp("invalid Bar"));
    h.script(
      `
            DELETE Bar;
            DELETE Tgt;
        `
    );
  });

  it("test_edgeql_ddl_link_policy_11", () => {
    h.script(
      `

            CREATE TYPE Tgt { CREATE PROPERTY name -> str };
            CREATE TYPE Foo {
                CREATE REQUIRED MULTI LINK tgt -> Tgt {
                    ON TARGET DELETE ALLOW;
                };
            };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    h.script(
      `
            INSERT Bar { tgt := {(INSERT Tgt { name := "foo" }),
                                 (INSERT Tgt { name := "bar" })} };
            INSERT Bar { tgt := (INSERT Tgt { name := "foo" }) };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt FILTER .name = "foo";
            `
      );
    }).toThrow(new RegExp("missing value for required link 'tgt'"));
    h.script(
      `
            DELETE Tgt FILTER .name = "bar";
            DELETE Bar;
            DELETE Tgt;
        `
    );
  });

  it("test_edgeql_ddl_link_policy_12", () => {
    h.script(
      `
            create type Tgt;
            create type Foo {
                create link tgt -> Tgt {
                    on target delete allow;
                }
            };
            create type Bar extending Foo {
                alter link tgt {
                    on target delete restrict;
                }
            };
        `
    );
    h.script(
      `
            insert Foo { tgt := (insert Tgt) };
            delete Tgt;
        `
    );
    h.script(
      `
             insert Bar { tgt := (insert Tgt) };
        `
    );
    expect(() => {
      h.script(
        `
                delete Tgt;
            `
      );
    }).toThrow(new RegExp("prohibited by link target policy"));
    h.script(
      `
            alter type Bar {
                alter link tgt {
                    reset on target delete;
                }
            };
        `
    );
    h.script(
      `
            delete Tgt
        `
    );
    assertQueryResult(
      h,
      `
                select schema::Link {name, on_target_delete, source: {name}}
                filter .name = 'tgt';

            `,
      unorderedBag([
            {
              "name": "tgt",
              "on_target_delete": "Allow",
              "source": {
                "name": "default::Foo",
              },
            },
            {
              "name": "tgt",
              "on_target_delete": "Allow",
              "source": {
                "name": "default::Bar",
              },
            },
          ])
    );
  });

  it("test_edgeql_ddl_link_policy_13", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE LINK tgt -> Tgt;
            };
            ALTER TYPE Foo ALTER LINK tgt ON SOURCE DELETE DELETE TARGET;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt) };
            DELETE Foo;
        `
    );
    assertQueryResult(
      h,
      `select Tgt`,
      []
    );
    h.script(
      `
            ALTER TYPE Foo ALTER LINK tgt ON SOURCE DELETE ALLOW;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt) };
            DELETE Foo;
        `
    );
    assertQueryResult(
      h,
      `select Tgt`,
      [
            {},
          ]
    );
  });

  it("test_edgeql_ddl_link_policy_14", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE LINK tgt -> Tgt {
                    ON SOURCE DELETE DELETE TARGET;
                }
            };
            ALTER TYPE Foo ALTER LINK tgt SET MULTI;
        `
    );
    h.script(
      `
            INSERT Foo { tgt := (INSERT Tgt) };
        `
    );
    h.script(
      `
            DELETE Foo;
        `
    );
    assertQueryResult(
      h,
      `select Tgt`,
      []
    );
  });

  it("test_edgeql_ddl_link_policy_15", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Foo {
                CREATE LINK tgt -> Tgt {
                    ON SOURCE DELETE DELETE TARGET;
                }
            };
            CREATE TYPE Bar EXTENDING Foo;
        `
    );
    h.script(
      `
            INSERT Bar { tgt := (INSERT Tgt) };
        `
    );
    h.script(
      `
            DELETE Foo;
        `
    );
    assertQueryResult(
      h,
      `select Tgt`,
      []
    );
  });

  it("test_edgeql_ddl_link_policy_16", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Tgt2 EXTENDING Tgt;
            CREATE TYPE Tgt3;
            CREATE TYPE Foo {
                CREATE MULTI LINK tgt -> Tgt | Tgt3 {
                    ON SOURCE DELETE DELETE TARGET;
                }
            };
        `
    );
    h.script(
      `
            INSERT Foo { tgt := {(INSERT Tgt), (INSERT Tgt2), (INSERT Tgt3)} };
        `
    );
    h.script(
      `
            DELETE Foo;
        `
    );
    assertQueryResult(
      h,
      `select Tgt UNION Tgt3`,
      []
    );
  });

  it("test_edgeql_ddl_link_policy_17", () => {
    h.script(
      `
            CREATE TYPE Tgt;
            CREATE TYPE Src {
                CREATE MULTI LINK tgt -> Tgt {
                    ON TARGET DELETE ALLOW;
                }
            };
        `
    );
    h.script(
      `
            INSERT Src { tgt := (INSERT Tgt) };
        `
    );
    h.script(
      `
            ALTER TYPE Src {
                ALTER LINK tgt {
                    SET REQUIRED
                }
            };
        `
    );
    expect(() => {
      h.script(
        `
                DELETE Tgt;
            `
      );
    }).toThrow(new RegExp(""));
    h.script(
      `
            ALTER TYPE Src {
                ALTER LINK tgt {
                    SET OPTIONAL
                }
            };
        `
    );
    h.script(
      `
            DELETE Tgt;
        `
    );
  });

  it("test_edgeql_ddl_link_policy_implicit_01", () => {
    h.script(
      `
            create type T;
            create type X {
                create link foo -> schema::ObjectType;
            };
        `
    );
    h.script(
      `
            drop type T;
        `
    );
  });

  it("test_edgeql_ddl_dupe_link_storage_01", () => {
    h.script(
      `

            CREATE TYPE Foo {
                CREATE PROPERTY name -> str;
            };
            CREATE TYPE Bar {
                CREATE PROPERTY name -> str;
                CREATE LINK foo -> Foo;
                CREATE PROPERTY x -> int64;
            };
            CREATE TYPE Baz {
                CREATE PROPERTY name -> str;
                CREATE MULTI LINK foo -> Foo;
                CREATE MULTI PROPERTY x -> int64
            };
            INSERT Foo { name := "foo" };
            INSERT Bar { name := "bar", foo := (SELECT Foo LIMIT 1), x := 1 };
            INSERT Baz { name := "baz", foo := (SELECT Foo), x := {2, 3} };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Foo {bars := .<foo[IS Bar] {name}};
            `,
      [
            {
              "bars": [
                {
                  "name": "bar",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (Bar UNION Baz).foo { name };
            `,
      [
            {
              "name": "foo",
            },
          ]
    );
    assertQueryResult(
      h,
      `
                WITH W := (Bar UNION Baz)
                SELECT _ := (W { name }, W.foo) ORDER BY _.0.name;
            `,
      [
            [
              {
                "name": "bar",
              },
              {},
            ],
            [
              {
                "name": "baz",
              },
              {},
            ],
          ]
    );
    h.script(
      `
            WITH W := (Bar UNION Baz), SELECT (W, W.foo.id);
        `
    );
  });

  it("test_edgeql_ddl_scoping_future_01", () => {
    h.script(
      `
            configure session reset simple_scoping
        `
    );
    h.script(
      `
            create type T;
            insert T;
            insert T;
            create function f(x: int64 = 0) -> int64 using (x);
            create function get_whatever() -> bool using (
                all(T = T)
            );
            create alias X := all(T = T)
        `
    );
    assertQueryResult(
      h,
      `
            select { func := get_whatever(), alias := X, query := all(T = T) }
        `,
      [
            {
              "func": false,
              "alias": false,
              "query": false,
            },
          ]
    );
    h.script(
      `
            create future warn_old_scoping
        `
    );
    h.script(
      `
            configure session set simple_scoping := true
        `
    );
    assertQueryResult(
      h,
      `
            select { func := get_whatever(), alias := X, query := all(T = T) }
        `,
      [
            {
              "func": false,
              "alias": false,
              "query": false,
            },
          ]
    );
    h.script(
      `
            create future simple_scoping
        `
    );
    assertQueryResult(
      h,
      `
            select { func := get_whatever(), alias := X, query := all(T = T) }
        `,
      [
            {
              "func": false,
              "alias": false,
              "query": false,
            },
          ]
    );
    h.script(
      `
            configure session set simple_scoping := false
        `
    );
    assertQueryResult(
      h,
      `
            select { func := get_whatever(), alias := X, query := all(T = T) }
        `,
      [
            {
              "func": false,
              "alias": false,
              "query": false,
            },
          ]
    );
    h.script(
      `
            configure session reset simple_scoping
        `
    );
    assertQueryResult(
      h,
      `
            select { func := get_whatever(), alias := X, query := all(T = T) }
        `,
      [
            {
              "func": false,
              "alias": false,
              "query": false,
            },
          ]
    );
  });

  it("test_edgeql_ddl_scoping_future_02", () => {
    h.script(
      `
            create future simple_scoping;
        `
    );
    h.script(
      `
            drop future simple_scoping;
        `
    );
  });

  it("test_edgeql_ddl_scoping_future_03", () => {
    expect(() => {
      h.script(
        `
                start migration to {
                    module default {
                        type T;
                    }
                 }
            `
      );
    }).toThrow(new RegExp("Schema does not have 'using future simple_scoping'"));
    h.script(
      `
                start migration to {
                    using future simple_scoping;
                    module default {
                        type T;
                    }
                 }
            `
    );
    h.script(
      `
                start migration to {
                    using future warn_old_scoping;
                    module default {
                        type T;
                    }
                 }
            `
    );
  });

  it("test_edgeql_ddl_no_volatile_computable_01", () => {
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY foo := random();
                }
            `
      );
    }).toThrow(new RegExp("volatile functions are not permitted in schema-defined computed expressions"));
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY foo := (SELECT {
                        asdf := random()
                    }).asdf
                }
            `
      );
    }).toThrow(new RegExp("volatile functions are not permitted in schema-defined computed expressions"));
    expect(() => {
      h.script(
        `
                CREATE TYPE Noob {
                    CREATE MULTI LINK friends -> Noob;
                    CREATE LINK best_friends := (
                        SELECT .friends FILTER random() > 0.5
                    );
                }
            `
      );
    }).toThrow(new RegExp("volatile functions are not permitted in schema-defined computed expressions"));
    expect(() => {
      h.script(
        `
                CREATE TYPE Noob {
                    CREATE LINK noob -> Noob {
                        CREATE PROPERTY foo := random();
                    }
                }
            `
      );
    }).toThrow(new RegExp("volatile functions are not permitted in schema-defined computed expressions"));
    expect(() => {
      h.script(
        `
                CREATE ALIAS Asdf := Object { foo := random() };
            `
      );
    }).toThrow(new RegExp("volatile functions are not permitted in schema-defined computed expressions"));
  });

  it("test_edgeql_ddl_new_required_pointer_01", () => {
    h.script(
      `
            CREATE TYPE Foo;
            INSERT Foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo CREATE REQUIRED PROPERTY name -> str;
            `
      );
    }).toThrow(new RegExp("missing value for required property 'name' of object type 'default::Foo'"));
  });

  it("test_edgeql_ddl_new_required_pointer_02", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY num -> int64;
            };
            INSERT Foo { num := 20 };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                CREATE PROPERTY name -> str {
                    SET REQUIRED USING (<str>.num ++ "!")
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo {name, num}`,
      [
            {
              "name": "20!",
              "num": 20,
            },
          ]
    );
  });

  it("test_edgeql_ddl_new_required_pointer_03", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY num -> int64;
            };
            INSERT Foo { num := 20 };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                CREATE MULTI PROPERTY name -> str {
                    SET REQUIRED USING (<str>.num ++ "!")
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo {name, num}`,
      [
            {
              "name": ["20!"],
              "num": 20,
            },
          ]
    );
  });

  it("test_edgeql_ddl_new_required_pointer_04", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY num -> int64;
            };
            CREATE TYPE Bar {
                CREATE PROPERTY code -> int64 {
                    CREATE CONSTRAINT exclusive;
                }
            };
            INSERT Foo { num := 20 };
            INSERT Bar { code := 40 };
            INSERT Foo { num := 30 };
            INSERT Bar { code := 60 };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                CREATE LINK partner -> Bar {
                    SET REQUIRED USING (SELECT Bar FILTER Bar.code = 2*Foo.num)
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo {num, partner: {code}} ORDER BY .num`,
      [
            {
              "num": 20,
              "partner": {
                "code": 40,
              },
            },
            {
              "num": 30,
              "partner": {
                "code": 60,
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_new_required_pointer_05", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY num -> int64;
            };
            CREATE TYPE Bar {
                CREATE PROPERTY code -> int64 {
                    CREATE CONSTRAINT exclusive;
                }
            };
            INSERT Foo { num := 20 };
            INSERT Bar { code := 40 };
            INSERT Foo { num := 30 };
            INSERT Bar { code := 60 };
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                CREATE MULTI LINK partner -> Bar {
                    SET REQUIRED USING (SELECT Bar FILTER Bar.code = 2*Foo.num)
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo {num, partner: {code}} ORDER BY .num`,
      [
            {
              "num": 20,
              "partner": [
                {
                  "code": 40,
                },
              ],
            },
            {
              "num": 30,
              "partner": [
                {
                  "code": 60,
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_ddl_new_required_pointer_06", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE Bar  {
                CREATE PROPERTY num -> int64;
            };
            CREATE TYPE Foo EXTENDING Bar;
            INSERT Foo { num := 20 };
        `
    );
    h.script(
      `
            ALTER TYPE Bar {
                CREATE PROPERTY name -> str {
                    SET REQUIRED USING (<str>.num ++ "!")
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo {name, num}`,
      [
            {
              "name": "20!",
              "num": 20,
            },
          ]
    );
  });

  it("test_edgeql_ddl_new_required_pointer_07", () => {
    h.script(
      `
            CREATE ABSTRACT TYPE Bar  {
                CREATE PROPERTY num -> int64;
                CREATE PROPERTY name -> str;
            };
            CREATE TYPE Foo EXTENDING Bar;
            INSERT Foo { num := 20 };
        `
    );
    h.script(
      `
            ALTER TYPE Bar {
                ALTER PROPERTY name {
                    SET REQUIRED USING (<str>.num ++ "!")
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo {name, num}`,
      [
            {
              "name": "20!",
              "num": 20,
            },
          ]
    );
  });

  it("test_edgeql_ddl_new_required_pointer_08", () => {
    h.script(
      `
            CREATE TYPE Bar  {
                CREATE PROPERTY num -> int64;
                CREATE PROPERTY name -> str;
            };
            CREATE TYPE Foo EXTENDING Bar;
            INSERT Bar { num := 10 };
            INSERT Foo { num := 20 };
        `
    );
    h.script(
      `
            ALTER TYPE Bar {
                ALTER PROPERTY name {
                    SET REQUIRED USING (<str>.num ++ "!")
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Bar {name, num} ORDER BY .num`,
      [
            {
              "name": "10!",
              "num": 10,
            },
            {
              "name": "20!",
              "num": 20,
            },
          ]
    );
  });

  it("test_edgeql_ddl_new_required_pointer_09", () => {
    h.script(
      `
            CREATE TYPE Foo;
            INSERT Foo;
        `
    );
    h.script(
      `
            ALTER TYPE Foo {
                CREATE MULTI PROPERTY name -> str {
                    SET REQUIRED USING ({"hello", "world"})
                }
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT Foo {name}`,
      [
            {
              "name": unorderedSet(["hello", "world"]),
            },
          ]
    );
  });

  it("test_edgeql_ddl_new_required_multi_pointer_01", () => {
    h.script(
      `
            CREATE TYPE Foo;
            INSERT Foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo CREATE REQUIRED MULTI PROPERTY name -> str;
            `
      );
    }).toThrow(new RegExp("missing value for required property 'name' of object type 'default::Foo'"));
  });

  it("test_edgeql_ddl_new_required_multi_pointer_02", () => {
    h.script(
      `
            CREATE TYPE Foo;
            INSERT Foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo CREATE REQUIRED MULTI LINK link -> Object;
            `
      );
    }).toThrow(new RegExp("missing value for required link 'link' of object type 'default::Foo'"));
  });

  it("test_edgeql_ddl_new_required_multi_pointer_03", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE MULTI PROPERTY name -> str;
            };
            INSERT Foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER PROPERTY name SET REQUIRED;
            `
      );
    }).toThrow(new RegExp("missing value for required property 'name' of object type 'default::Foo'"));
  });

  it("test_edgeql_ddl_new_required_multi_pointer_04", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE MULTI LINK link -> Object;
            };
            INSERT Foo;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo ALTER LINK link SET REQUIRED;
            `
      );
    }).toThrow(new RegExp("missing value for required link 'link' of object type 'default::Foo'"));
  });

  it("test_edgeql_ddl_set_required_lprop_01", () => {
    h.script(
      `
            CREATE TYPE default::User {
                CREATE PROPERTY name: std::str;
            };
            CREATE TYPE default::Post {
                CREATE MULTI LINK author: default::User {
                    CREATE PROPERTY created_at: std::str;
                };
                CREATE PROPERTY title: std::str;
            };
            INSERT Post { author := {
                (insert User { name := "1" }),
                (insert User { name := "2" }),
            } };
        `
    );
    h.script(
      `
            ALTER TYPE default::Post {
                ALTER LINK author {
                    ALTER PROPERTY created_at {
                        SET REQUIRED USING (.name);
                    };
                };
            };
        `
    );
    expect(() => {
      h.script(
        `
                INSERT Post { author := {(insert User), (insert User)} };
            `
      );
    }).toThrow(new RegExp("missing value"));
  });

  it("test_edgeql_ddl_set_required_lprop_02", () => {
    h.script(
      `
            CREATE TYPE default::User {
                CREATE PROPERTY name: std::str;
            };
            CREATE TYPE default::Post {
                CREATE LINK author: default::User {
                    CREATE PROPERTY created_at: std::str;
                };
                CREATE PROPERTY title: std::str;
            };
            INSERT Post { author := (insert User { name := "asdf" }) };
        `
    );
    h.script(
      `
            ALTER TYPE default::Post {
                ALTER LINK author {
                    ALTER PROPERTY created_at {
                        SET REQUIRED USING (<str>.name);
                    };
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_set_required_lprop_03", () => {
    h.script(
      `
            CREATE TYPE default::User;
            CREATE TYPE default::Post {
                CREATE MULTI LINK author: default::User {
                    CREATE PROPERTY created_at: std::str;
                };
                CREATE PROPERTY title: std::str;
            };
            INSERT Post { author := {(insert User), (insert User)} };
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE default::Post {
                    ALTER LINK author {
                        ALTER PROPERTY created_at {
                            SET REQUIRED USING (<str>(insert User).id);
                        };
                    };
                };
            `
      );
    }).toThrow(new RegExp("cannot include mutating statements"));
  });

  it("test_edgeql_ddl_link_union_delete_01", () => {
    h.script(
      `
            CREATE TYPE default::M;
            CREATE ABSTRACT TYPE default::Base {
                CREATE LINK l -> default::M;
            };
            CREATE TYPE default::A EXTENDING default::Base;
            CREATE TYPE default::B EXTENDING default::Base;
            CREATE TYPE default::L {
                CREATE LINK l -> (default::B | default::A);
            };
            CREATE TYPE ForceRedo {
                CREATE LINK l -> default::M;
            };
        `
    );
    h.script(
      `
            insert M;
        `
    );
    h.script(
      `
            delete M;
        `
    );
  });

  it("test_edgeql_ddl_alter_union_01", () => {
    h.script(
      `
            CREATE TYPE Foo;
            CREATE TYPE Bar;
        `
    );
    h.script(
      `
            CREATE TYPE Ref {
                CREATE LINK fubar -> Foo | Bar;
            }
        `
    );
    h.script(
      `
            ALTER TYPE Foo CREATE PROPERTY x -> str;
            ALTER TYPE Bar CREATE PROPERTY x -> str;
        `
    );
    assertQueryResult(
      h,
      `SELECT Ref.fubar.x`,
      []
    );
  });

  it("test_edgeql_ddl_alter_union_02", () => {
    h.script(
      `
            CREATE TYPE Foo { CREATE PROPERTY x -> str; };
            CREATE TYPE Bar { CREATE PROPERTY x -> str; };
            CREATE TYPE Baz { CREATE PROPERTY x -> str; };
        `
    );
    h.script(
      `
            CREATE TYPE Ref {
                CREATE LINK everything -> Foo | Bar | Baz;
                CREATE LINK fubar -> Foo | Bar;
                CREATE LINK barbaz -> Bar | Baz;
            }
        `
    );
    h.script(
      `
            ALTER TYPE Baz DROP PROPERTY x;
        `
    );
    assertQueryResult(
      h,
      `SELECT Ref.fubar.x`,
      []
    );
    h.script(
      `
            ALTER TYPE Baz CREATE PROPERTY x -> str;
        `
    );
    assertQueryResult(
      h,
      `SELECT Ref.everything.x`,
      []
    );
  });

  it("test_edgeql_ddl_alter_union_03", () => {
    h.script(
      `
            CREATE TYPE Parent;
            CREATE TYPE Child EXTENDING Parent {
                CREATE PROPERTY prop -> str;
            };
            CREATE TYPE Foo {CREATE LINK y -> Child};
            CREATE TYPE Bar {CREATE LINK y -> Child};
        `
    );
    h.script(
      `
            CREATE TYPE Ref {
                CREATE LINK fubar -> Foo | Bar;
            }
        `
    );
    h.script(
      `
            ALTER TYPE Foo ALTER LINK y SET TYPE Parent;
        `
    );
    expect(() => {
      assertQueryResult(
        h,
        `SELECT Ref.fubar.y.prop`,
        []
      );
    }).toThrow(new RegExp("object type 'default::Parent' has no link or property 'prop'"));
  });

  it("test_edgeql_ddl_extending_scalar_wrongly", () => {
    expect(() => {
      h.script(
        `CREATE TYPE MyStr EXTENDING str;`
      );
    }).toThrow(new RegExp("'str' exists, but is a scalar type, not an object type"));
  });

  it("test_edgeql_ddl_required_computed_01", () => {
    h.script(
      `
            CREATE TYPE Profile;
            CREATE TYPE User {
                CREATE REQUIRED SINGLE LINK profile -> Profile;
            };
        `
    );
    h.script(
      `
            ALTER TYPE Profile {
                CREATE REQUIRED LINK user := (std::assert_exists((SELECT
                    .<profile[IS User]
                )));
            };
            ALTER TYPE Profile {
                ALTER LINK user SET OPTIONAL;
            };
        `
    );
  });

  it("test_edgeql_ddl_required_computed_02", () => {
    h.script(
      `
            CREATE TYPE Foo;
            ALTER TYPE Foo {
                CREATE PROPERTY z := {1, 2};
            };
            ALTER TYPE Foo {
                ALTER PROPERTY z SET OPTIONAL;
            };
        `
    );
  });

  it("test_edgeql_ddl_recursive_func", () => {
    h.script(
      `
            CREATE TYPE SomeThing {
                CREATE LINK child -> SomeThing;
            }
        `
    );
    expect(() => {
      h.script(
        `
                CREATE FUNCTION get_all_children_ordered(parent: SomeThing)
                -> SET OF SomeThing Using (
                    SELECT SomeThing UNION get_all_children_ordered(parent))
            `
      );
    }).toThrow(new RegExp("function 'get_all_children_ordered' does not exist"));
    h.script(
      `
            CREATE FUNCTION get_all_children_ordered(parent: SomeThing)
            -> SET OF SomeThing Using (
                SELECT SomeThing
            )
        `
    );
    expect(() => {
      h.script(
        `
                ALTER FUNCTION get_all_children_ordered(parent: SomeThing)
                USING (
                    SELECT parent.child
                        UNION get_all_children_ordered(parent)
                );
            `
      );
    }).toThrow(new RegExp("function 'default::get_all_children_ordered\\(parent: default::SomeThing\\)' is defined recursively"));
  });

  it("test_edgeql_ddl_duplicates_01", () => {
    h.script(
      `
            CREATE TYPE Foo;
        `
    );
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo;
            `
      );
    }).toThrow(new RegExp("object type 'default::Foo' already exists"));
  });

  it("test_edgeql_ddl_duplicates_02", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY foo -> str;
            }
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo {
                    CREATE PROPERTY foo -> str;
                }
            `
      );
    }).toThrow(new RegExp("property 'foo' of object type 'default::Foo' already exists"));
  });

  it("test_edgeql_ddl_duplicates_03", () => {
    h.script(
      `
            CREATE TYPE Foo;
            CREATE TYPE Bar;
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Bar RENAME TO Foo;
            `
      );
    }).toThrow(new RegExp("object type 'default::Foo' already exists"));
  });

  it("test_edgeql_ddl_duplicates_04", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE PROPERTY foo -> str;
                CREATE PROPERTY bar -> str;
            }
        `
    );
    expect(() => {
      h.script(
        `
                ALTER TYPE Foo {
                    ALTER PROPERTY bar RENAME TO foo;
                }
            `
      );
    }).toThrow(new RegExp("property 'foo' of object type 'default::Foo' already exists"));
  });

  it("test_edgeql_ddl_alias_in_computable_01", () => {
    h.script(
      `
            CREATE ALIAS Alias := {0, 1, 2, 3};
        `
    );
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY bar := Alias;
                };
            `
      );
    }).toThrow(new RegExp("referring to alias 'default::Alias' from computed property"));
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY bar := {Alias, Alias};
                };
            `
      );
    }).toThrow(new RegExp("referring to alias 'default::Alias' from computed property"));
  });

  it("test_edgeql_ddl_linkprop_partial_paths", () => {
    h.script(
      `
            CREATE TYPE Foo {
                CREATE LINK x -> Object {
                    CREATE PROPERTY z -> str;
                    CREATE CONSTRAINT expression ON (@z != "lol");
                    CREATE INDEX ON (@z);
                    CREATE PROPERTY y := @z ++ "!";
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_drop_parent_multi_link", () => {
    h.script(
      `
            CREATE TYPE C;
            CREATE TYPE D {
                CREATE MULTI LINK multi_link -> C;
            };
            CREATE TYPE E EXTENDING D;
            INSERT C;
        `
    );
    h.script(
      `
            ALTER TYPE D {
                DROP LINK multi_link;
            };
        `
    );
    h.script(
      `
            DELETE C;
        `
    );
  });

  it("test_edgeql_ddl_drop_multi_parent_multi_link", () => {
    h.script(
      `
            CREATE TYPE C;
            INSERT C;
            CREATE TYPE D {
                CREATE MULTI LINK multi_link -> C;
            };
            CREATE TYPE E {
                CREATE MULTI LINK multi_link -> C;
            };
            CREATE TYPE F EXTENDING D, E;
        `
    );
    h.script(
      `
            ALTER TYPE D {
                DROP LINK multi_link;
            };
        `
    );
    h.script(
      `
            DELETE C;
        `
    );
  });

  it("test_edgeql_ddl_drop_incoming_link", () => {
    h.script(
      `
            create type Foo;
            create type Bar { create link foo -> Foo; };
            alter type Bar { drop link foo; };
            insert Foo;
            delete Foo;
        `
    );
  });

  it("test_edgeql_ddl_switch_link_to_computed", () => {
    h.script(
      `
            create type Identity;
            create type User {
                create required property name -> str {
                    create constraint exclusive;
                };
                create multi link identities -> Identity {
                    create constraint exclusive;
                };
            };
            alter type Identity {
                create link user -> User {
                    on target delete delete source;
                };
            };
        `
    );
    h.script(
      `
            alter type User {
                alter link identities {
                    drop constraint exclusive;
                };
                alter link identities {
                    using (.<user[IS Identity]);
                };
            };
        `
    );
    h.script(
      `
            insert Identity { user := (insert User { name := 'foo' }) }
        `
    );
    h.script(
      `
            delete User filter true
        `
    );
  });

  it("test_edgeql_ddl_switch_link_target", () => {
    h.script(
      `
            create type Foo;
            create type Bar;
            create type Ptr { create link p -> Foo; };
            alter type Ptr { alter link p set type Bar using (<Bar>{}); };
            insert Ptr { p := (insert Bar) };
        `
    );
    expect(() => {
      h.script(
        `
                delete Bar;
            `
      );
    }).toThrow(new RegExp("prohibited by link target policy"));
    h.script(
      `
            drop type Ptr;
        `
    );
    h.script(
      `
            insert Foo;
            delete Foo;
        `
    );
  });

  it("test_edgeql_ddl_switch_link_computed_01", () => {
    h.script(
      `
            create type Tgt;
            create type Src {
                create multi link l1 -> Tgt { create property s1 -> str; };
                create multi link l2 -> Tgt { create property s2 -> str; };
                create link c := (.l1);
            };
        `
    );
    h.script(
      `
            select Src { c: {@s1} };
        `
    );
    h.script(
      `
            alter type Src alter link c using (.l2);
        `
    );
    h.script(
      `
            select Src { c: {@s2} };
        `
    );
  });

  it("test_edgeql_ddl_set_abs_linkprop_type", () => {
    h.script(
      `
            CREATE ABSTRACT LINK orderable {
                CREATE PROPERTY orderVal -> str {
                    CREATE DELEGATED CONSTRAINT exclusive;
                };
            };
            CREATE ABSTRACT TYPE Entity;
            CREATE TYPE Video EXTENDING Entity;
            CREATE TYPE Topic EXTENDING Entity {
                CREATE MULTI LINK videos EXTENDING orderable -> Video;
            };
        `
    );
    h.script(
      `
            ALTER ABSTRACT LINK orderable {
                ALTER PROPERTY orderVal {
                    SET TYPE decimal using (<decimal>@orderVal);
                };
            };
        `
    );
  });

  it("test_edgeql_ddl_set_multi_with_children_01", () => {
    h.script(
      `
            create type Person { create link lover -> Person; };
            create type NPC extending Person;
            alter type Person { alter link lover { set multi; }; };
        `
    );
    h.script(
      `
            drop type NPC;
            drop type Person;
        `
    );
  });

  it("test_edgeql_ddl_set_multi_with_children_02", () => {
    h.script(
      `
            create abstract type Person { create link lover -> Person; };
            create type NPC extending Person;
            alter type Person { alter link lover { set multi; }; };
        `
    );
    h.script(
      `
            drop type NPC;
            drop type Person;
        `
    );
  });

  it("test_edgeql_ddl_set_multi_with_children_03", () => {
    h.script(
      `
            create type Person { create property foo -> str; };
            create type NPC extending Person;
            alter type Person { alter property foo { set multi; }; };
        `
    );
    h.script(
      `
            drop type NPC;
            drop type Person;
        `
    );
  });

  it("test_edgeql_ddl_set_multi_with_children_04", () => {
    h.script(
      `
            create abstract type Person { create property foo -> str; };
            create type NPC extending Person;
            alter type Person { alter property foo { set multi; }; };
        `
    );
    h.script(
      `
            drop type NPC;
            drop type Person;
        `
    );
  });

  it("test_edgeql_ddl_set_single_with_children_01", () => {
    h.script(
      `
            create abstract type Person { create multi link foo -> Person; };
            create type NPC extending Person;
            alter type Person alter link foo {
                set single USING (SELECT .foo LIMIT 1);
            };
        `
    );
    h.script(
      `
            drop type NPC;
            drop type Person;
        `
    );
  });

  it("test_edgeql_ddl_set_single_with_children_02", () => {
    h.script(
      `
            create abstract type Person { create multi property foo -> str; };
            create type NPC extending Person;
            alter type Person alter property foo {
                set single USING (SELECT .foo LIMIT 1);
            };
        `
    );
    h.script(
      `
            drop type NPC;
            drop type Person;
        `
    );
  });

  it("test_edgeql_ddl_drop_multi_child_01", () => {
    h.script(
      `
            create abstract type Person { create multi property foo -> str; };
            create type NPC extending Person;
        `
    );
    h.script(
      `
            drop type NPC;
            drop type Person;
        `
    );
  });

  it("test_edgeql_ddl_drop_multi_child_02", () => {
    h.script(
      `
            create abstract type Person { create multi link foo -> Person; };
            create type NPC extending Person;
        `
    );
    h.script(
      `
            drop type NPC;
            drop type Person;
        `
    );
  });

  it("test_edgeql_ddl_set_abstract_bogus_01", () => {
    h.script(
      `
            create type Foo;
            insert Foo;
        `
    );
    expect(() => {
      h.script(
        `
                alter type Foo set abstract;
            `
      );
    }).toThrow(new RegExp("may not make non-empty object type 'default::Foo' abstract"));
  });

  it("test_edgeql_no_type_intro_in_default", () => {
    h.script(
      `
            create scalar type Foo extending sequence;
            create type Project {
                create required property number -> Foo {
                    set default := sequence_next(introspect Foo);
                }
            };
        `
    );
    h.script(
      `
            insert Project;
            insert Project;
        `
    );
  });

  it("test_edgeql_ddl_no_shapes_in_using", () => {
    h.script(
      `
            create type Foo;
            create type Bar extending Foo;
            create type Baz {
                create multi link foo -> Foo;
            };
        `
    );
    expect(() => {
      h.script(
        `
                    alter type Baz {
                        alter link foo {
                            set required using (select Bar { x := "oops" } limit 1)
                        }
                     };
                `
      );
    }).toThrow(new RegExp("may not include a shape"));
    expect(() => {
      h.script(
        `
                    alter type Baz {
                        alter link foo {
                            set single using (select Bar { x := "oops" } limit 1)
                        }
                     };
                `
      );
    }).toThrow(new RegExp("may not include a shape"));
    expect(() => {
      h.script(
        `
                    alter type Baz {
                        alter link foo {
                            set default := (select Bar { x := "oops" } limit 1)
                        }
                     };
                `
      );
    }).toThrow(new RegExp("may not include a shape"));
    expect(() => {
      h.script(
        `
                    alter type Baz {
                        alter link foo {
                            set type Bar using (select Bar { x := "oops" } limit 1)
                        }
                     };
                `
      );
    }).toThrow(new RegExp("may not include a shape"));
  });

  it("test_edgeql_ddl_uuid_array_01", () => {
    h.script(
      `
            create type Foo {
                create property uuid_array_prop -> array<uuid>
            }
        `
    );
    assertQueryResult(
      h,
      `
                select schema::Property {target: {name}}
                filter .name = 'uuid_array_prop';
            `,
      [
            {
              "target": {
                "name": "array<std::uuid>",
              },
            },
          ]
    );
  });

  it("test_edgeql_ddl_computed_and_alias", () => {
    h.script(
      `
            create type Tgt;
            create type X { create link foo -> Tgt };
            create alias Y := X { foo: {id} };
            alter type X { create link bar := .foo };
        `
    );
  });

  it("test_edgeql_ddl_computed_intersection_lprop_01", () => {
    h.script(
      `
            create type Pointer;
            create type Property extending Pointer;
            create type Link extending Pointer;
            create type ObjectType {
                create multi link pointers -> Pointer {
                    create property owned -> bool;
                };
                create link links := .pointers[is Link];
            };
        `
    );
    h.query(
      `
            select ObjectType {links: {@owned}};
        `
    );
  });

  it("test_edgeql_ddl_union_link_target_alter_01", () => {
    h.script(
      `
            create type X;
            create type Y;
            create type T { create link xy -> X | Y; };
        `
    );
    h.query(
      `
            alter type X create required property foo -> str;
        `
    );
    h.query(
      `
            alter type Y create required property foo -> str;
        `
    );
    h.query(
      `
            alter type X alter property foo set multi;
        `
    );
  });

  it("test_edgeql_ddl_rebase_views_01", () => {
    h.script(
      `
            CREATE TYPE default::Foo {
                CREATE PROPERTY x -> std::str {
                    CREATE CONSTRAINT std::exclusive;
                };
            };
            CREATE TYPE default::Bar EXTENDING default::Foo;
            CREATE TYPE default::Baz EXTENDING default::Foo;
        `
    );
    h.script(
      `
            CREATE TYPE default::Foo2 EXTENDING default::Foo;
            ALTER TYPE default::Bar {
                DROP EXTENDING default::Foo;
                EXTENDING default::Foo2 LAST;
            };

            INSERT Bar;
        `
    );
    assertQueryResult(
      h,
      `select Foo`,
      [
            {},
          ]
    );
    assertQueryResult(
      h,
      `select Object`,
      [
            {},
          ]
    );
  });

  it("test_edgeql_ddl_rebase_views_02", () => {
    h.script(
      `
            CREATE TYPE default::Foo {
                CREATE PROPERTY x -> std::str {
                    CREATE CONSTRAINT std::exclusive;
                };
            };
            CREATE TYPE default::Bar EXTENDING default::Foo;
            CREATE TYPE default::Baz EXTENDING default::Foo;
        `
    );
    h.script(
      `
            CREATE TYPE default::Foo2 {
                CREATE PROPERTY x -> std::str {
                    CREATE CONSTRAINT std::exclusive;
                };
            };
            ALTER TYPE default::Bar {
                DROP EXTENDING default::Foo;
                EXTENDING default::Foo2 LAST;
            };

            INSERT Bar;
        `
    );
    assertQueryResult(
      h,
      `select Foo`,
      []
    );
    assertQueryResult(
      h,
      `select Object`,
      [
            {},
          ]
    );
  });

  it("test_edgeql_ddl_alias_and_create_set_required", () => {
    h.script(
      `
            create type T;
            create alias A := T;
            alter type T {
                create required property bar -> str {
                    set required using ('!')
                }
            };
        `
    );
  });
});

describe("TestDDLNonIsolated", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      dbFile: "./tests/.artifacts/ddl_testddlnonisolated.sqlite",
      resetDbFile: true
    });
  });

  function _test_edgeql_ddl_reindex(): void {
    h.script(
      `
            create type Tgt;
            create type Foo {
                create property foo -> str {
                    create constraint exclusive;
                };
                create property bar -> str;
                create index on (.foo);
                create constraint exclusive on ((.foo, .bar));
                create link tgt -> Tgt {
                    create property foo -> str;
                };
                create link tgts -> Tgt {
                    create property foo -> str;
                };
            };
            create module test;
            create type test::Bar extending Foo;
        `
    );
    try {
      h.script(
        `
                administer reindex(Foo)
            `
      );
      h.script(
        `
                administer reindex(Foo.foo)
            `
      );
      h.script(
        `
                administer reindex(Foo.bar)
            `
      );
      h.script(
        `
                administer reindex(Foo.tgt)
            `
      );
      h.script(
        `
                administer reindex(Foo.tgts)
            `
      );
      h.script(
        `
                administer reindex(test::Bar)
            `
      );
      h.script(
        `
                administer reindex(Object)
            `
      );
    } finally {
      h.script(
        `
                drop type test::Bar;
                drop type Foo;
                drop type Tgt;
                drop module test;
            `
      );
    }
  }

  function _deadlock_tester(): void {
    let con1 = h;
    h.script(
      setup
    );
    try {
      let con = connect();
      h.query(
        "select 1"
      );
      [].append(con);
      con = connect();
      h.query(
        "select 1"
      );
      [].append(con);
      let [con2, con3] = [];
      let long_call = asyncio.create_task(con1.query_single(`
                select (count(${query}), sys::_sleep(3));
            `));
      // ignored awaited call: asyncio.sleep
      let ddl = asyncio.create_task(con2.execute(modification));
      // ignored awaited call: asyncio.sleep
      let short_call = con3.query(`
                select ${query}
            `);
      return asyncio.gather(long_call, ddl, short_call);
    } finally {
      h.script(
        teardown
      );
    }
  }

  it("test_edgeql_ddl_consecutive_create_migration_01", () => {
    h.script(
      `
        CREATE MIGRATION m1dpxyvsejl6b2tqe5nzpy6wpk5zzjhm7gwky7jn5vmnqrqoujxn6q
            ONTO initial
        {
            CREATE TYPE default::A;
        };
        `
    );
    h.query(
      `
        CREATE MIGRATION m1xuduby4e6u2sraygw352y553ltcj4cyz4dijuwlbqqq34ap43yca
            ONTO m1dpxyvsejl6b2tqe5nzpy6wpk5zzjhm7gwky7jn5vmnqrqoujxn6q
        {
            CREATE TYPE default::B;
        };
        `
    );
  });

  it("test_edgeql_ddl_no_tx_mig_error_01", () => {
    h.script(
      `
            create type Mig01;
            insert Mig01;
        `
    );
    expect(() => {
      h.query(
        `
                alter type Mig01 create required property n -> int64;
            `
      );
    }).toThrow(new RegExp("missing value for required property 'n'"));
  });

  it("test_edgeql_ddl_no_tx_mig_error_02", () => {
    h.script(
      `
            create type Mig02;
            insert Mig02;
        `
    );
    expect(() => {
      h.query(
        `
                alter type Mig02 create required property n -> int64;
                create type Mig02b;
            `
      );
    }).toThrow(new RegExp("missing value for required property 'n'"));
  });

  it("test_edgeql_ddl_no_tx_mig_error_03", () => {
    h.script(
      `
            create type Mig03;
        `
    );
    expect(() => {
      h.query(
        `
                alter type Mig03 create required property n -> int64;
                insert Mig03 { n := <int64>{} };
            `
      );
    }).toThrow(new RegExp("missing value for required property 'n'"));
  });

  it("test_edgeql_ddl_reindex_old_scoping", () => {
    _test_edgeql_ddl_reindex();
  });

  it("test_edgeql_ddl_reindex_simple_scoping", () => {
    h.script(
      `
            create future simple_scoping;
        `
    );
    try {
      _test_edgeql_ddl_reindex();
    } finally {
      h.script(
        `
                drop future simple_scoping;
            `
      );
    }
  });

  it("test_edgeql_ddl_deadlock_01", () => {
    let cnt; let _; let objs; ([[cnt, _], _, objs] = _deadlock_tester());
    expect(cnt).toEqual(1);
    expect((objs).length).toEqual(1);
  });

  it("test_edgeql_ddl_deadlock_02", () => {
    let cnt; let _; let objs; ([[cnt, _], _, objs] = _deadlock_tester());
    expect(cnt).toEqual(1);
    expect((objs).length).toEqual(1);
  });

  it("test_edgeql_ddl_single_index", () => {
    h.script(
      `
            create type DDLSingleIndex;
        `
    );
    let objid = h.query("\n            select (introspect DDLSingleIndex).id\n        ");
    let res = scon.fetch("\n                select indexname, tablename, indexdef from pg_indexes\n                where tablename = $1::text\n                ", String(objid));
    expect((res).length).toEqual(1);
  });

  it("test_edgeql_ddl_function_drop_tuple_cache", () => {
    h.script(
      `
            create function lol() -> SET OF tuple<str, str> using (('x', 'y'));
        `
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `select lol()`,
      [
            ["x", "y"],
          ]
    );
    h.script(
      `
            drop function lol();
        `
    );
  });

  it("test_edgeql_ddl_rollback_enum_01", () => {
    h.query(
      `START TRANSACTION`
    );
    h.script(
      `
            CREATE SCALAR TYPE Color
                EXTENDING enum<Red, Green, Blue>;
        `
    );
    h.query(
      `DECLARE SAVEPOINT t0`
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE Color
                    DROP EXTENDING enum<Red, Green, Blue>;
            `
      );
    }).toThrow(new RegExp("cannot DROP EXTENDING enum"));
    h.query(
      `ROLLBACK TO SAVEPOINT t0;`
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE Color EXTENDING str FIRST;
            `
      );
    }).toThrow(new RegExp("cannot add supertype scalar type 'std::str' to enum type default::Color"));
    h.query(
      `ROLLBACK TO SAVEPOINT t0;`
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE Color
                    EXTENDING enum<Bad> LAST;
            `
      );
    }).toThrow(new RegExp("cannot add supertype enum<Bad> to enum type default::Color"));
    h.query(
      `ROLLBACK TO SAVEPOINT t0;`
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE Color
                    EXTENDING enum<Bad>, enum<AlsoBad>;
            `
      );
    }).toThrow(new RegExp("enum default::Color may not have multiple supertypes"));
    h.query(
      `ROLLBACK TO SAVEPOINT t0;`
    );
    expect(() => {
      h.script(
        `
                ALTER SCALAR TYPE Color
                    EXTENDING enum<Red, Green, Blue, Red>;
            `
      );
    }).toThrow(new RegExp("enums cannot contain duplicate values"));
    h.query(
      `ROLLBACK TO SAVEPOINT t0;`
    );
    h.script(
      `
            ALTER SCALAR TYPE Color
                EXTENDING enum<Red, Green, Blue, Magic>;
        `
    );
    h.query(
      `COMMIT`
    );
    assertQueryResult(
      h,
      `
                SELECT <Color>'Magic' >
                    <Color>'Red';
            `,
      [true]
    );
  });

  it("test_edgeql_ddl_concurrent_index_01", () => {
    h.script(
      `
            create type T { create required property n -> str; };
        `
    );
    h.script(
      `
            alter type T {
                create index on (.n) { set build_concurrently := true; }
            };
        `
    );
    expect(() => {
      h.script(
        `
                alter type T {
                    alter index on (.n) { set build_concurrently := false; }
                };
            `
      );
    }).toThrow(new RegExp("not active"));
    create_concurrent_indexes(h);
    expect([]).toEqual(["Creating concurrent index on 'default::T' with expr (.n)"]);
    h.script(
      `
            alter type T {
                alter index on (.n) { set build_concurrently := false; }
            };
        `
    );
  });

  it("test_edgeql_ddl_concurrent_index_02", () => {
    h.script(
      `
            create type T {
                create required property n -> str;
                create required property s -> int64;
                create index on (.n) { set build_concurrently := true; };
                create index on (.s) { set build_concurrently := true; };
            };
        `
    );
    create_concurrent_indexes(h);
    [].sort();
    expect([]).toEqual(["Creating concurrent index on 'default::T' with expr (.n)", "Creating concurrent index on 'default::T' with expr (.s)"]);
  });

  it("test_edgeql_ddl_concurrent_index_03", () => {
    h.script(
      `
            create type T { create required property n -> str; };
        `
    );
    h.script(
      `
            alter type T {
                create index on (.n) { set build_concurrently := true; }
            };
        `
    );
    let con2 = connect();
    try {
      h.script(
        `
                    insert T { n := "0123" };
                `
      );
      let task = asyncio.create_task(create_concurrent_indexes(con2));
      // ignored awaited call: ev.wait
      // ignored awaited call: asyncio.sleep
      h.script(
        `
                    insert T { n := "789" };
                `
      );
      expect((!task.done())).toBeTruthy();
      expect(task).toEqual(1);
    } finally {
      // ignored awaited call: con2.aclose
    }
    expect(create_concurrent_indexes(h)).toEqual(0);
  });

  it("test_administer_fixup_backend_upgrade", () => {
    h.script(
      `
            administer fixup_backend_upgrade()
        `
    );
  });
});
