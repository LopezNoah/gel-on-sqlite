import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";

describe("TestDump01 (Clean Version)", () => {
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
});
