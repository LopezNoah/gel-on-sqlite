import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";

describe("TestDump01", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "dump01_test",
      setup: "dump01_setup",
      dbFile: "./tests/.artifacts/dump01.sqlite",
    });
  });

  it("should expose object type annotations via schema::ObjectType", () => {
    h.assertQueryResult(`
      WITH MODULE schema
      SELECT ObjectType {
        name,
        annotations: {
          name,
          @value,
        } ORDER BY .name
      }
      FILTER
        EXISTS .annotations
        AND
        .name LIKE 'default::%'
      ORDER BY .name;
    `, [
      {
        name: "default::A",
        annotations: [{ name: "std::title", "@value": "A" }],
      },
      {
        name: "default::B",
        annotations: [{ name: "std::title", "@value": "B" }],
      },
      {
        name: "default::C",
        annotations: [{ name: "std::title", "@value": "C" }],
      },
      {
        name: "default::D",
        annotations: [
          { name: "default::heritable_user_anno", "@value": "all D" },
          { name: "default::user_anno", "@value": "D only" },
          { name: "std::title", "@value": "D" },
        ],
      },
      {
        name: "default::E",
        annotations: [
          { name: "default::heritable_user_anno", "@value": "all D" },
          { name: "std::title", "@value": "E" },
        ],
      },
      {
        name: "default::F",
        annotations: [
          { name: "default::heritable_user_anno", "@value": "all D" },
          { name: "std::title", "@value": "F" },
        ],
      },
    ]);
  });

  it("should expose prop and link annotations", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        properties: {
          name,
          annotations: {
            name,
            @value,
          },
        }
        FILTER EXISTS .annotations
        ORDER BY .name,
        links: {
          name,
          annotations: {
            name,
            @value,
          },
        }
        FILTER EXISTS .annotations
        ORDER BY .name,
      }
      FILTER
        EXISTS .pointers.annotations
        AND
        .name LIKE 'default::%'
      ORDER BY .name;
      `,
      [
        {
          name: "default::A",
          properties: [
            {
              name: "p_bool",
              annotations: [
                {
                  name: "std::title",
                  "@value": "single bool",
                },
              ],
            },
          ],
          links: [],
        },
        {
          name: "default::B",
          properties: [
            {
              name: "p_bool",
              annotations: [
                {
                  name: "std::title",
                  "@value": "multi bool",
                },
              ],
            },
          ],
          links: [],
        },
        {
          name: "default::C",
          properties: [
            {
              name: "val",
              annotations: [
                {
                  name: "std::title",
                  "@value": "val",
                },
              ],
            },
          ],
          links: [],
        },
        {
          name: "default::D",
          properties: [],
          links: [
            {
              name: "multi_link",
              annotations: [
                {
                  name: "std::title",
                  "@value": "multi link to C",
                },
              ],
            },
            {
              name: "single_link",
              annotations: [
                {
                  name: "std::title",
                  "@value": "single link to C",
                },
              ],
            },
          ],
        },
      ],
    );
  });

  it("should expose link property annotations", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        links: {
          name,
          properties: {
            name,
            annotations: {
              name,
              @value,
            },
          }
          FILTER EXISTS .annotations
          ORDER BY .name,
        }
        FILTER 'std::title' IN .properties.annotations.name
        ORDER BY .name,
      }
      FILTER
        .name = 'default::E'
      ORDER BY .name;
      `,
      [
        {
          name: "default::E",
          links: [
            {
              name: "multi_link",
              properties: [
                {
                  name: "lp1",
                  annotations: [
                    {
                      name: "std::title",
                      "@value": "single lp1",
                    },
                  ],
                },
              ],
            },
            {
              name: "single_link",
              properties: [
                {
                  name: "lp0",
                  annotations: [
                    {
                      name: "std::title",
                      "@value": "single lp0",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    );
  });

  it("should expose constraint annotations", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        properties: {
          name,
          constraints: {
            name,
            annotations: {
              name,
              @value,
            },
          },
        }
        ORDER BY .name,
      }
      FILTER
        .name = 'default::C'
      ORDER BY .name;
      `,
      [
        {
          name: "default::C",
          properties: [
            {
              name: "id",
              constraints: [{ annotations: [] }],
            },
            {
              name: "val",
              constraints: [
                {
                  annotations: [
                    {
                      name: "std::title",
                      "@value": "exclusive C val",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    );
  });

  it("should expose abstract constraint annotations", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        properties: {
          name,
          constraints: {
            annotations: {
              name,
              @value,
            },
          },
        }
        FILTER EXISTS .constraints
        ORDER BY .name,
      }
      FILTER
        .name = 'default::M'
      ORDER BY .name;
      `,
      [
        {
          name: "default::M",
          properties: [
            {
              name: "id",
              constraints: [{ annotations: [] }],
            },
            {
              name: "m0",
              constraints: [
                {
                  annotations: [
                    {
                      name: "std::title",
                      "@value": "user_int_constraint constraint",
                    },
                  ],
                },
              ],
            },
            {
              name: "m1",
              constraints: [],
            },
          ],
        },
      ],
    );
  });

  it.skip("should expose function annotations", () => {
    h.assertQueryResult(
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
        EXISTS .annotations
        AND
        .name LIKE 'default::%'
      ORDER BY .name;
      `,
      [
        {
          name: "default::user_func_0",
          annotations: [
            {
              name: "std::title",
              "@value": "user_func(int64) -> str",
            },
          ],
          vol: "Immutable",
        },
      ],
    );
  });

  it.skip("should expose indexes", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        indexes: {
          expr
        },
      }
      FILTER
        EXISTS .indexes
        AND
        .name LIKE 'default::%'
      ORDER BY .name;
      `,
      [
        {
          name: "default::K",
          indexes: [{ expr: ".k" }],
        },
        {
          name: "default::L",
          indexes: [{ expr: "(.l0 ++ .l1)" }],
        },
      ],
    );
  });

  it.skip("should expose custom scalars", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ScalarType {
        name,
        ancestors: {
          name,
        } ORDER BY @index,
        constraints: {
          name,
          params: {
            name,
            @value,
          } FILTER .name != '__subject__',
        },
      }
      FILTER
        .name LIKE 'default::User%'
      ORDER BY .name;
      `,
      [
        {
          name: "default::UserEnum",
          ancestors: [
            { name: "std::anyenum" },
            { name: "std::anyscalar" },
          ],
          constraints: [],
        },
        {
          name: "default::UserInt",
          ancestors: [
            { name: "std::int64" },
            { name: "std::anyint" },
            { name: "std::anyreal" },
            { name: "std::anydiscrete" },
            { name: "std::anypoint" },
            { name: "std::anyscalar" },
          ],
          constraints: [
            {
              name: "default::user_int_constr",
              params: [{ name: "x", "@value": "5" }],
            },
          ],
        },
        {
          name: "default::UserStr",
          ancestors: [
            { name: "std::str" },
            { name: "std::anyscalar" },
          ],
          constraints: [
            {
              name: "std::max_len_value",
              params: [{ name: "max", "@value": "5" }],
            },
          ],
        },
      ],
    );
  });

  it.skip("should expose custom scalar constraints on M", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        properties: {
          name,
          constraints: {
            name,
            params: {
              name,
              @value,
            } FILTER .name != '__subject__',
          },
        }
        FILTER .name IN {'m0', 'm1'}
        ORDER BY .name,
      }
      FILTER
        .name = 'default::M';
      `,
      [
        {
          name: "default::M",
          properties: [
            {
              name: "m0",
              constraints: [
                {
                  name: "default::user_int_constr",
                  params: [{ name: "x", "@value": "3" }],
                },
              ],
            },
            {
              name: "m1",
              constraints: [
                {
                  name: "std::max_len_value",
                  params: [{ name: "max", "@value": "3" }],
                },
              ],
            },
          ],
        },
      ],
    );
  });

  it.skip("should expose custom scalar targets on N", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        properties: {
          name,
          target: {
            name,
          },
        }
        FILTER .name IN {'n0', 'n1'}
        ORDER BY .name,
      }
      FILTER
        .name = 'default::N';
      `,
      [
        {
          name: "default::N",
          properties: [
            {
              name: "n0",
              target: { name: "default::UserInt" },
            },
            {
              name: "n1",
              target: { name: "default::UserStr" },
            },
          ],
        },
      ],
    );
  });

  it.skip("should preserve bases and ancestors order", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        bases: {
          name,
          @index,
        } ORDER BY @index,
        ancestors: {
          name,
          @index,
        } ORDER BY @index,
      }
      FILTER
        .name = 'default::V';
      `,
      [
        {
          name: "default::V",
          bases: [
            { name: "default::U", "@index": 0 },
            { name: "default::S", "@index": 1 },
            { name: "default::T", "@index": 2 },
          ],
          ancestors: [
            { name: "default::U", "@index": 0 },
            { name: "default::S", "@index": 1 },
            { name: "default::T", "@index": 2 },
            { name: "default::R", "@index": 3 },
            { name: "std::Object", "@index": 4 },
            { name: "std::BaseObject", "@index": 5 },
          ],
        },
      ],
    );
  });

  it.skip("should expose delegated constraints", () => {
    h.assertQueryResult(
      `
      WITH MODULE schema
      SELECT ObjectType {
        name,
        properties: {
          name,
          constraints: {
            name,
            delegated,
          },
        } ORDER BY .name,
      }
      FILTER
        .name = 'default::R'
        OR
        .name = 'default::S'
      ORDER BY .name;
      `,
      [
        {
          name: "default::R",
          properties: [
            {
              name: "id",
              constraints: [
                {
                  name: "std::exclusive",
                  delegated: false,
                },
              ],
            },
            {
              name: "name",
              constraints: [
                {
                  name: "std::exclusive",
                  delegated: true,
                },
              ],
            },
          ],
        },
        {
          name: "default::S",
          properties: [
            {
              name: "id",
              constraints: [
                {
                  name: "std::exclusive",
                  delegated: false,
                },
              ],
            },
            {
              name: "name",
              constraints: [
                {
                  name: "std::exclusive",
                  delegated: false,
                },
              ],
            },
            {
              name: "s",
              constraints: [],
            },
          ],
        },
      ],
    );
  });

  it("should preserve scalar data integrity for A and B", () => {
    h.assertQueryResult(
      `
      SELECT default::A {
        p_bool,
        p_str,
        p_int16,
        p_int32,
        p_int64,
        p_float32,
        p_float64,
        p_bigint,
        p_decimal,
      };
      `,
      [
        {
          p_bool: true,
          p_str: "Hello",
          p_int16: 12345,
          p_int32: 1234567890,
          p_int64: 1234567890123,
          p_float32: 2.5,
          p_float64: 2.5,
          p_bigint: 123456789123456789123456789,
          p_decimal: 123456789123456790000000000,
        },
      ],
    );

    h.assertQueryResult(
      `
      SELECT default::A {
        p_datetime,
        p_local_datetime,
        p_local_date,
        p_local_time,
        p_duration,
      };
      `,
      [{
        p_datetime: "2018-05-07T20:01:22.306916+00:00",
        p_local_datetime: "2018-05-07T20:01:22.306916",
        p_local_date: "2018-05-07",
        p_local_time: "20:01:22.306916",
        p_duration: "20 hrs",
      }],
    );

    h.assertQueryResult(
      `
      SELECT default::A { p_json };
      `,
      [{ p_json: [{ a: null, b: true }, 1, 2.5, "foo"] }],
    );

    h.assertQueryResult(
      `
      SELECT default::B {
        p_bool,
        p_str,
        p_int16,
        p_int32,
        p_int64,
        p_float32,
        p_float64,
        p_bigint,
        p_decimal,
      };
      `,
      [
        {
          p_bool: [true, false],
          p_str: ["Hello", "world"],
          p_int16: [12345, -42],
          p_int32: [1234567890, -42],
          p_int64: [1234567890123, -42],
          p_float32: [2.5, -42],
          p_float64: [2.5, -42],
          p_bigint: [123456789123456789123456789, -42],
          p_decimal: [123456789123456790000000000, -42],
        },
      ],
    );

    h.assertQueryResult(
      `
      SELECT default::B {
        p_datetime,
        p_local_datetime,
        p_local_date,
        p_local_time,
        p_duration,
      };
      `,
      [
        {
          p_datetime: [
            "2018-05-07T20:01:22.306916+00:00",
            "2019-05-07T20:01:22.306916+00:00",
          ],
          p_local_datetime: [
            "2018-05-07T20:01:22.306916",
            "2019-05-07T20:01:22.306916",
          ],
          p_local_date: ["2018-05-07", "2019-05-07"],
          p_local_time: ["20:01:22.306916", "20:02:22.306916"],
          p_duration: ["20 hrs", "20 sec"],
        },
      ],
    );

    h.assertQueryResult(
      `
      SELECT default::B { p_json };
      `,
      [
        {
          p_json: [[{ a: null, b: true }, 1, 2.5, "foo"], "bar", false],
        },
      ],
    );
  });

  it("should store multi properties and overloaded link props in tables", () => {
    const bColumns = h.db.prepare('PRAGMA table_info("default__b")').all() as Array<{ name: string; type: string }>;
    const bTypes = new Map(bColumns.map((column) => [column.name, column.type] as const));
    expect(bTypes.get("p_bool")).toBe("TEXT");
    expect(bTypes.get("p_json")).toBe("TEXT");

    const eSingleLinkColumns = h.db.prepare('PRAGMA table_info("default__e__single_link")').all() as Array<{ name: string }>;
    expect(eSingleLinkColumns.map((column) => column.name)).toContain("lp0");

    const eMultiLinkColumns = h.db.prepare('PRAGMA table_info("default__e__multi_link")').all() as Array<{ name: string }>;
    expect(eMultiLinkColumns.map((column) => column.name)).toContain("lp1");
  });

  it("should validate C data", () => {
    h.assertQueryResult(
      `
      SELECT C {val}
      ORDER BY val;
      `,
      [
        { val: "D00" },
        { val: "D01" },
        { val: "D02" },
        { val: "D03" },
        { val: "E00" },
        { val: "E01" },
        { val: "E02" },
        { val: "E03" },
        { val: "F00" },
        { val: "F01" },
        { val: "F02" },
        { val: "F03" },
      ],
    );
  });

  it("should validate D link data", () => {
    const rows = h.db
      .prepare(
        'SELECT d.num AS num, c.val AS single_val FROM "default__d" d LEFT JOIN "default__c" c ON c.id = d.single_link_id ORDER BY d.num',
      )
      .all() as Array<{ num: number; single_val: string | null }>;

    const multiRows = h.db
      .prepare(
        'SELECT d.num AS num, c.val AS val FROM "default__d__multi_link" ml JOIN "default__d" d ON d.id = ml.source JOIN "default__c" c ON c.id = ml.target ORDER BY d.num, c.val',
      )
      .all() as Array<{ num: number; val: string }>;

    const multiByNum = new Map<number, Array<{ val: string }>>();
    for (const row of multiRows) {
      const list = multiByNum.get(row.num) ?? [];
      list.push({ val: row.val });
      multiByNum.set(row.num, list);
    }

    const result = rows.map((row) => ({
      num: row.num,
      single_link: row.single_val ? [{ val: row.single_val }] : null,
      multi_link: multiByNum.get(row.num) ?? [],
    }));

    expect(result).toEqual([
      {
        num: 0,
        single_link: null,
        multi_link: [],
      },
      {
        num: 1,
        single_link: [{ val: "D00" }],
        multi_link: [],
      },
      {
        num: 2,
        single_link: null,
        multi_link: [
          { val: "D01" },
          { val: "D02" },
        ],
      },
      {
        num: 3,
        single_link: [{ val: "D00" }],
        multi_link: [
          { val: "D01" },
          { val: "D02" },
          { val: "D03" },
        ],
      },
    ]);
  });

  it("should validate E link data", () => {
    h.assertQueryResult(
      `
      SELECT E {
        num,
        single_link {
          val,
        },
        multi_link {
          val,
        } ORDER BY val,
      }
      ORDER BY num;
      `,
      [
        {
          num: 4,
          single_link: [],
          multi_link: [],
        },
        {
          num: 5,
          single_link: [{ val: "E00" }],
          multi_link: [],
        },
        {
          num: 6,
          single_link: [],
          multi_link: [
            { val: "E01" },
            { val: "E02" },
          ],
        },
        {
          num: 7,
          single_link: [{ val: "E00" }],
          multi_link: [
            { val: "E01" },
            { val: "E02" },
            { val: "E03" },
          ],
        },
      ],
    );
  });

  it("should validate F link data", () => {
    h.assertQueryResult(
      `
      SELECT F {
        num,
        single_link {
          val,
        },
        multi_link {
          val,
        } ORDER BY val,
      }
      ORDER BY num;
      `,
      [
        {
          num: 8,
          single_link: [{ val: "F00" }],
          multi_link: [
            { val: "F01" },
            { val: "F02" },
            { val: "F03" },
          ],
        },
      ],
    );
  });

  it.skip("should validate link property values", () => {
    h.assertQueryResult(
      `
      SELECT E {
        num,
        single_link: {
          val,
          @lp0,
        },
        multi_link: {
          val,
          @lp1,
        } ORDER BY .val,
      } ORDER BY .num;
      `,
      [
        {
          num: 4,
          single_link: null,
          multi_link: [],
        },
        {
          num: 5,
          single_link: { val: "E00", "@lp0": null },
          multi_link: [],
        },
        {
          num: 6,
          single_link: null,
          multi_link: [
            { val: "E01", "@lp1": null },
            { val: "E02", "@lp1": null },
          ],
        },
        {
          num: 7,
          single_link: { val: "E00", "@lp0": "E00" },
          multi_link: [
            { val: "E01", "@lp1": "E01" },
            { val: "E02", "@lp1": "E02" },
            { val: "E03", "@lp1": "E03" },
          ],
        },
      ],
    );
  });

  it("should validate data for types with computables and defaults", () => {
    h.assertQueryResult(
      `
      SELECT K {
        k,
      };
      `,
      [{ k: "k0" }],
    );

    h.assertQueryResult(
      `
      SELECT L {
        l0,
        l1,
      };
      `,
      [{ l0: "l0_0", l1: "l1_0" }],
    );
  });

  it("should validate indexed type G", () => {
    h.assertQueryResult(
      `
      SELECT G {g0, g1, g2};
      `,
      [{ g0: "fixed", g1: "func1", g2: "2" }],
    );
  });

  it("should validate types with constraints M and N", () => {
    h.assertQueryResult(
      `
      SELECT M {
        m0,
        m1,
      };
      `,
      [{ m0: 10, m1: "m1" }],
    );

    h.assertQueryResult(
      `
      SELECT N {
        n0,
        n1,
      };
      `,
      [{ n0: 10, n1: "n1" }],
    );
  });

  it.skip("should validate user functions", () => {
    h.assertQueryResult(
      `
      SELECT user_func_0(99);
      `,
      ["func99"],
    );

    h.assertQueryResult(
      `
      SELECT user_func_1([1, 3, -88], '+');
      `,
      ["1+3+-88"],
    );

    h.assertQueryResult(
      `
      SELECT user_func_2(<int64>{});
      `,
      ["x"],
    );

    h.assertQueryResult(
      `
      SELECT user_func_2(11);
      `,
      ["11", "x"],
    );

    h.assertQueryResult(
      `
      SELECT user_func_2(22, 'a');
      `,
      ["22", "a"],
    );
  });

  it.skip("should validate user enum", () => {
    h.assertQueryResult(
      `
      WITH w := {'Lorem', 'ipsum', 'dolor', 'sit', 'amet'}
      SELECT w
      ORDER BY str_lower(w);
      `,
      ["amet", "dolor", "ipsum", "Lorem", "sit"],
    );

    h.assertQueryResult(
      `
      WITH w := {'Lorem', 'ipsum', 'dolor', 'sit', 'amet'}
      SELECT w
      ORDER BY <UserEnum>w;
      `,
      ["Lorem", "ipsum", "dolor", "sit", "amet"],
    );
  });

  it.skip("should validate O data", () => {
    h.assertQueryResult(
      `
      SELECT <str>{O.o0, O.o1, O.o2};
      `,
      ["ipsum", "Lorem", "dolor"],
    );

    h.assertQueryResult(
      `
      SELECT <str>(
          SELECT _ := {O.o0, O.o1, O.o2}
          ORDER BY _
      );
      `,
      ["Lorem", "ipsum", "dolor"],
    );

    h.assertQueryResult(
      `
      SELECT {O.o0, O.o1, O.o2} IS UserEnum;
      `,
      [true, true, true],
    );
  });

  it.skip("should validate collection properties P", () => {
    h.assertQueryResult(
      `
      SELECT P {
        plink0: {val, @p0},
        plink1: {val, @p1},
        p2,
        p3,
      };
      `,
      [
        {
          plink0: { val: "E00", "@p0": ["hello", "world"] },
          plink1: { val: "E00", "@p1": [2.5, -4.25] },
          p2: ["hello", "world"],
          p3: [2.5, -4.25],
        },
      ],
    );
  });

  it.skip("should validate Q data", () => {
    h.assertQueryResult(
      `
      SELECT Q {q0, q1, q2, q3};
      `,
      [
        {
          q0: [2, false],
          q1: ["p3", 3.33],
          q2: { x: 2, y: false },
          q3: { x: "p11", y: 3.33 },
        },
      ],
    );
  });

  it.skip("should validate multiple inheritance S, T, V", () => {
    h.assertQueryResult(
      `
      SELECT S {name, s}
      ORDER BY .name;
      `,
      [
        { name: "name0", s: "s0" },
        { name: "name1", s: "s1" },
      ],
    );

    h.assertQueryResult(
      `
      SELECT T {name, t}
      ORDER BY .name;
      `,
      [
        { name: "name0", t: "t0" },
        { name: "name1", t: "t1" },
      ],
    );

    h.assertQueryResult(
      `
      SELECT V {name, s, t, u};
      `,
      [
        {
          name: "name1",
          s: "s1",
          t: "t1",
          u: "u1",
        },
      ],
    );
  });

  it.skip("should validate aliases Primes", () => {
    h.assertQueryResult(
      `
      SELECT Primes;
      `,
      [2, 3, 5, 7],
    );
  });

  it.skip("should validate self/mutually-referencing types W", () => {
    h.assertQueryResult(
      `
      SELECT W {
        name,
        w: {
          name
        }
      }
      ORDER BY .name;
      `,
      [
        { name: "w0", w: null },
        { name: "w1", w: { name: "w2" } },
        { name: "w2", w: null },
        { name: "w3", w: { name: "w4" } },
        { name: "w4", w: { name: "w3" } },
      ],
    );
  });

  it.skip("should validate self/mutually-referencing types X and Y", () => {
    h.assertQueryResult(
      `
      SELECT X {
        name,
        y: {
          name,
          x: {
            name
          }
        }
      }
      ORDER BY .name;
      `,
      [
        {
          name: "x0",
          y: {
            name: "y0",
            x: {
              name: "x0",
            },
          },
        },
      ],
    );
  });

  it.skip("should validate Z with union link types", () => {
    h.assertQueryResult(
      `
      SELECT Z {
        ck: {
          typename := .__type__.name,
        },
        stw: {
          name,
          typename := .__type__.name,
        } ORDER BY .typename,
      }
      ORDER BY .ck.typename;
      `,
      [
        {
          ck: { typename: "default::C" },
          stw: [
            { name: "name0", typename: "default::S" },
          ],
        },
        {
          ck: { typename: "default::K" },
          stw: [
            { name: "name0", typename: "default::S" },
            { name: "name0", typename: "default::T" },
            { name: "w1", typename: "default::W" },
          ],
        },
      ],
    );
  });

  it.skip("should validate cross module types DefA", () => {
    h.assertQueryResult(
      `
      SELECT DefA {a};
      `,
      [{ a: "DefA" }],
    );
  });

  it.skip("should validate cross module types DefB", () => {
    h.assertQueryResult(
      `
      SELECT DefB {
        name,
        other: {
          b,
          blink: {
            a
          }
        }
      };
      `,
      [
        {
          name: "test0",
          other: {
            b: "TestB",
            blink: {
              a: "DefA",
            },
          },
        },
      ],
    );
  });

  it.skip("should validate cross module types DefC", () => {
    h.assertQueryResult(
      `
      SELECT DefC {
        name,
        other: {
          c,
          clink: {
            name
          }
        }
      };
      `,
      [
        {
          name: "test1",
          other: {
            c: "TestC",
            clink: {
              name: "test1",
            },
          },
        },
      ],
    );
  });

  it.skip("should validate on delete delete source", () => {
    h.assertQueryResult(
      `
      SELECT SourceA {
        name,
        link1: {
          name,
        },
      }
      FILTER .name = 's1';
      `,
      [
        {
          name: "s1",
          link1: {
            name: "t1",
          },
        },
      ],
    );

    h.query('DELETE TargetA FILTER .name = "t1"');

    h.assertQueryResult(
      `
      SELECT SourceA {name}
      FILTER .name = 's1';
      `,
      [],
    );
  });

  it.skip("should validate on delete allow", () => {
    h.assertQueryResult(
      `
      SELECT SourceA {
        name,
        link2: {
          name,
        },
      }
      FILTER .name = 's2';
      `,
      [
        {
          name: "s2",
          link2: {
            name: "t2",
          },
        },
      ],
    );

    h.query('DELETE TargetA FILTER .name = "t2"');

    h.assertQueryResult(
      `
      SELECT SourceA {
        name,
        link2: {
          name,
        },
      }
      FILTER .name = 's2';
      `,
      [
        {
          name: "s2",
          link2: null,
        },
      ],
    );
  });

  it.skip("should validate on delete restrict", () => {
    h.assertQueryResult(
      `
      SELECT SourceA {
        name,
        link0: {
          name,
        },
      }
      FILTER .name = 's0';
      `,
      [
        {
          name: "s0",
          link0: {
            name: "t0",
          },
        },
      ],
    );

    expect(() => {
      h.query('DELETE TargetA FILTER .name = "t0"');
    }).toThrow();
  });

  it.skip("should validate read-only ROPropsA", () => {
    h.assertQueryResult(
      `
      SELECT ROPropsA {
        name,
        rop0,
        rop1,
      }
      ORDER BY .name;
      `,
      [
        {
          name: "ro0",
          rop0: null,
          rop1: expect.any(Number),
        },
        {
          name: "ro1",
          rop0: 100,
          rop1: expect.any(Number),
        },
        {
          name: "ro2",
          rop0: null,
          rop1: -2,
        },
      ],
    );

    expect(() => {
      h.query(`
        UPDATE ROPropsA
        SET {
          rop0 := 99,
        };
      `);
    }).toThrow();

    expect(() => {
      h.query(`
        UPDATE ROPropsA
        SET {
          rop1 := 99,
        };
      `);
    }).toThrow();
  });

  it.skip("should validate read-only ROLinksA", () => {
    h.assertQueryResult(
      `
      SELECT ROLinksA {
        name,
        rol0: {val},
        rol1: {val},
        rol2: {val} ORDER BY .val,
      }
      ORDER BY .name;
      `,
      [
        {
          name: "ro0",
          rol0: null,
          rol1: { val: "D00" },
          rol2: [{ val: "D01" }, { val: "D02" }],
        },
        {
          name: "ro1",
          rol0: { val: "F00" },
          rol1: { val: "D00" },
          rol2: [{ val: "D01" }, { val: "D02" }],
        },
        {
          name: "ro2",
          rol0: null,
          rol1: { val: "F00" },
          rol2: [{ val: "D01" }, { val: "D02" }],
        },
        {
          name: "ro3",
          rol0: null,
          rol1: { val: "D00" },
          rol2: [{ val: "F01" }, { val: "F02" }],
        },
      ],
    );

    expect(() => {
      h.query(`
        UPDATE ROLinksA
        SET {
          rol0 := <C>{},
        };
      `);
    }).toThrow();

    expect(() => {
      h.query(`
        UPDATE ROLinksA
        SET {
          rol1 := <C>{},
        };
      `);
    }).toThrow();

    expect(() => {
      h.query(`
        UPDATE ROLinksA
        SET {
          rol2 := <C>{},
        };
      `);
    }).toThrow();
  });

  it.skip("should validate read-only ROLinksB", () => {
    h.assertQueryResult(
      `
      SELECT ROLinksB {
        name,
        rol0: {val, @rolp00, @rolp01},
        rol1: {val, @rolp10, @rolp11} ORDER BY .val,
      }
      ORDER BY .name;
      `,
      [
        {
          name: "ro0",
          rol0: { val: "D00", "@rolp00": null, "@rolp01": expect.any(Number) },
          rol1: [
            { val: "D01", "@rolp10": null, "@rolp11": expect.any(Number) },
            { val: "D02", "@rolp10": null, "@rolp11": expect.any(Number) },
          ],
        },
        {
          name: "ro1",
          rol0: { val: "D00", "@rolp00": 99, "@rolp01": expect.any(Number) },
          rol1: [
            { val: "D01", "@rolp10": 99, "@rolp11": expect.any(Number) },
            { val: "D02", "@rolp10": 98, "@rolp11": expect.any(Number) },
          ],
        },
        {
          name: "ro2",
          rol0: { val: "E00", "@rolp00": null, "@rolp01": -10 },
          rol1: [
            { val: "E01", "@rolp10": null, "@rolp11": -1 },
            { val: "E02", "@rolp10": null, "@rolp11": -2 },
          ],
        },
      ],
    );
  });
});
