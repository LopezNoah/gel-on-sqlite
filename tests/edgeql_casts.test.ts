import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLCasts", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "casts",
      setup: "casts_setup",
      dbFile: "./tests/.artifacts/casts.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_casts_bytes_01", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>True;
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_02", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>uuid_generate_v1mc();
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_03", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>'Hello';
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_04", () => {
    expect(() => {
      h.query(
        `SELECT <bytes>to_json('1');`
      );
    }).toThrow(new RegExp("expected JSON string or null"));
    expect(h.query("\n                SELECT <bytes>to_json('\"aGVsbG8=\"');\n            ")).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    expect(() => {
      h.query(
        `
                SELECT <bytes>to_json('"not base64!"');
            `
      );
    }).toThrow(new RegExp("invalid symbol"));
    expect(() => {
      h.query(
        `
                SELECT <bytes>to_json('"a"');
            `
      );
    }).toThrow(new RegExp("invalid base64 end sequence"));
  });

  it("test_edgeql_casts_bytes_05", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>datetime_current();
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_06", () => {
    expect(() => {
      h.script(
        `
                SELECT
                  <bytes>cal::to_local_datetime('2018-05-07T20:01:22.306916');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_07", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>cal::to_local_date('2018-05-07');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_08", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>cal::to_local_time('20:01:22.306916');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_09", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>to_duration(hours:=20);
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_10", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>to_int16('2');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_11", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>to_int32('2');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_12", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>to_int64('2');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_13", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>to_float32('2');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_14", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>to_float64('2');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_15", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>to_decimal('2');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_bytes_16", () => {
    expect(() => {
      h.script(
        `
                SELECT <bytes>to_bigint('2');
            `
      );
    }).toThrow(new RegExp("cannot cast"));
  });

  it("test_edgeql_casts_idempotence_01", () => {
    assertQueryResult(
      h,
      `SELECT <bool><bool>True IS bool;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <bytes><bytes>b'Hello' IS bytes;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <str><str>'Hello' IS str;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <json><json>to_json('1') IS json;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <uuid><uuid>uuid_generate_v1mc() IS uuid;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <datetime><datetime>datetime_current() IS datetime;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_datetime><cal::local_datetime>
                    cal::to_local_datetime(
                    '2018-05-07T20:01:22.306916') IS cal::local_datetime;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_date><cal::local_date>cal::to_local_date(
                    '2018-05-07') IS cal::local_date;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_time><cal::local_time>cal::to_local_time(
                    '20:01:22.306916') IS cal::local_time;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <duration><duration>to_duration(
                    hours:=20) IS duration;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int16><int16>to_int16('12345') IS int16;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int32><int32>to_int32('1234567890') IS int32;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int64><int64>to_int64('1234567890123') IS int64;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <float32><float32>to_float32('2.5') IS float32;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <float64><float64>to_float64('2.5') IS float64;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <bigint><bigint>to_bigint(
                    '123456789123456789123456789')
                IS bigint;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <decimal><decimal>to_decimal(
                    '123456789123456789123456789.123456789123456789123456789')
                IS decimal;
            `,
      [true]
    );
  });

  it("test_edgeql_casts_idempotence_02", () => {
    assertQueryResult(
      h,
      `SELECT <bool><bool>True = True;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <bytes><bytes>b'Hello' = b'Hello';`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <str><str>'Hello' = 'Hello';`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <json><json>to_json('1') = to_json('1');`,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH U := uuid_generate_v4()
                SELECT <uuid><uuid>U = U;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <datetime><datetime>datetime_of_statement() =
                    datetime_of_statement();
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_datetime><cal::local_datetime>
                    cal::to_local_datetime('2018-05-07T20:01:22.306916') =
                    cal::to_local_datetime('2018-05-07T20:01:22.306916');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_date><cal::local_date>
                    cal::to_local_date('2018-05-07') =
                    cal::to_local_date('2018-05-07');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_time><cal::local_time>cal::to_local_time(
                    '20:01:22.306916') = cal::to_local_time('20:01:22.306916');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <duration><duration>to_duration(hours:=20) =
                    to_duration(hours:=20);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int16><int16>to_int16('12345') = 12345;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int32><int32>to_int32('1234567890') = 1234567890;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <int64><int64>to_int64('1234567890123') =
                    1234567890123;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <float32><float32>to_float32('2.5') = 2.5;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <float64><float64>to_float64('2.5') = 2.5;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <bigint><bigint>to_bigint(
                    '123456789123456789123456789')
                = to_bigint(
                    '123456789123456789123456789');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <decimal><decimal>to_decimal(
                    '123456789123456789123456789.123456789123456789123456789')
                = to_decimal(
                    '123456789123456789123456789.123456789123456789123456789');
            `,
      [true]
    );
  });

  it("test_edgeql_casts_str_01", () => {
    assertQueryResult(
      h,
      `SELECT <bool><str>True = True;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <bool><str>False = False;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <json><str>to_json('"Hello"') = to_json('"Hello"');`,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH U := uuid_generate_v1mc()
                SELECT <uuid><str>U = U;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <datetime><str>datetime_of_statement() =
                    datetime_of_statement();
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_datetime><str>cal::to_local_datetime(
                        '2018-05-07T20:01:22.306916') =
                    cal::to_local_datetime('2018-05-07T20:01:22.306916');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_date><str>cal::to_local_date('2018-05-07') =
                    cal::to_local_date('2018-05-07');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_time><str>
                    cal::to_local_time('20:01:22.306916') =
                    cal::to_local_time('20:01:22.306916');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <duration><str>to_duration(hours:=20) =
                    to_duration(hours:=20);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int16><str>to_int16('12345') = 12345;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int32><str>to_int32('1234567890') = 1234567890;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <int64><str>to_int64(
                    '1234567890123') = 1234567890123;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <float32><str>to_float32('2.5') = 2.5;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <float64><str>to_float64('2.5') = 2.5;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <bigint><str>to_bigint(
                    '123456789123456789123456789')
                = to_bigint(
                    '123456789123456789123456789');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <decimal><str>to_decimal(
                    '123456789123456789123456789.123456789123456789123456789')
                = to_decimal(
                    '123456789123456789123456789.123456789123456789123456789');
            `,
      [true]
    );
  });

  it("test_edgeql_casts_str_02", () => {
    assertQueryResult(
      h,
      `
                FOR x in {'true', 'false'}
                SELECT <str><bool>x = x;
            `,
      [true, true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {'True', 'False', 'TRUE', 'FALSE', '  TrUe   '}
                SELECT <str><bool>x = x;
            `,
      [false, false, false, false, false]
    );
    assertQueryResult(
      h,
      `
                FOR x in {'True', 'False', 'TRUE', 'FALSE', 'TrUe'}
                SELECT <str><bool>x = str_lower(x);
            `,
      [true, true, true, true, true]
    );
    expect(() => {
      h.query(
        `SELECT <bool>"yes"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: 'yes'"));
    expect(() => {
      h.query(
        `SELECT <bool>"1"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: '1'"));
    expect(() => {
      h.query(
        `SELECT <bool>"t"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: 't'"));
    expect(() => {
      h.query(
        `SELECT <bool>"OFF"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: 'OFF'"));
    expect(() => {
      h.query(
        `SELECT <bool>"no"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: 'no'"));
    expect(() => {
      h.query(
        `SELECT <bool>"😈"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: '\ud83d\ude08'"));
    expect(() => {
      h.query(
        `SELECT <bool>"tr"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: 'tr'"));
    expect(() => {
      h.query(
        `SELECT <bool>"f"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: 'f'"));
    expect(() => {
      h.query(
        `SELECT <bool>"fa"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: 'fa'"));
    expect(() => {
      h.query(
        `SELECT <bool>"on"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bool: 'on'"));
    expect(h.query("SELECT <bool>\"    TruE   \"")).toBeTruthy();
    expect(h.query("SELECT <bool>\"    FalsE   \"")).toBeFalsy();
  });

  it("test_edgeql_casts_str_03", () => {
    assertQueryResult(
      h,
      `
                FOR x in {'any', 'arbitrary', '♠gibberish♠'}
                SELECT <str><json>x = x;
            `,
      [true, true, true]
    );
  });

  it("test_edgeql_casts_str_04", () => {
    assertQueryResult(
      h,
      `
                FOR x in 'd4288330-eea3-11e8-bc5f-7faf132b1d84'
                SELECT <str><uuid>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    'D4288330-EEA3-11E8-BC5F-7FAF132B1D84',
                    'D4288330-Eea3-11E8-Bc5F-7Faf132B1D84',
                    'D4288330-eea3-11e8-bc5f-7faf132b1d84',
                }
                SELECT <str><uuid>x = x;
            `,
      [false, false, false]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    'D4288330-EEA3-11E8-BC5F-7FAF132B1D84',
                    'D4288330-Eea3-11E8-Bc5F-7Faf132B1D84',
                    'D4288330-eea3-11e8-bc5f-7faf132b1d84',
                }
                SELECT <str><uuid>x = str_lower(x);
            `,
      [true, true, true]
    );
  });

  it("test_edgeql_casts_str_05", () => {
    assertQueryResult(
      h,
      `
                FOR x in '2018-05-07T20:01:22.306916+00:00'
                SELECT <str><datetime>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '2018-05-07T15:01:22.306916-05:00',
                    '2018-05-07T15:01:22.306916-05',
                    '2018-05-07T20:01:22.306916Z',
                    '2018-05-07T20:01:22.306916+0000',
                    '2018-05-07T20:01:22.306916+00',
                    # the '-' and ':' separators may be omitted
                    '20180507T200122.306916+00',
                    # acceptable RFC 3339
                    '2018-05-07 20:01:22.306916+00:00',
                    '2018-05-07t20:01:22.306916z',
                }
                SELECT <datetime>x =
                    <datetime>'2018-05-07T20:01:22.306916+00:00';
            `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
    expect(() => {
      h.query(
        `SELECT <datetime>"2018-05-07;20:01:22.306916+00:00"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
    expect(() => {
      h.query(
        `SELECT <datetime>"2018-05-07T20:01:22.306916"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
    expect(() => {
      h.query(
        `SELECT <datetime>"2018-05-07T20:01:22.306916 1000"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
    expect(() => {
      h.query(
        `SELECT <datetime>"2018-05-07T20:01:22.306916 US/Central"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
    expect(() => {
      h.query(
        `SELECT <datetime>"2018-05-07T20:01:22.306916 +GMT1"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
  });

  it("test_edgeql_casts_str_06", () => {
    assertQueryResult(
      h,
      `
                FOR x in '2018-05-07T20:01:22.306916'
                SELECT <str><cal::local_datetime>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    # the '-' and ':' separators may be omitted
                    '20180507T200122.306916',
                    # acceptable RFC 3339
                    '2018-05-07 20:01:22.306916',
                    '2018-05-07t20:01:22.306916',
                }
                SELECT <cal::local_datetime>x =
                    <cal::local_datetime>'2018-05-07T20:01:22.306916';
            `,
      [true, true, true]
    );
    expect(() => {
      h.query(
        `SELECT <cal::local_datetime>"2018-05-07;20:01:22.306916"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `
                    SELECT
                        <cal::local_datetime>"2018-05-07T20:01:22.306916+01:00"
                `
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_datetime>"2018-05-07T20:01:22.306916 GMT"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `
                    SELECT
                      <cal::local_datetime>"2018-05-07T20:01:22.306916 GMT0"
                `
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_datetime>
                    "2018-05-07T20:01:22.306916 US/Central"
                `
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
  });

  it("test_edgeql_casts_str_07", () => {
    assertQueryResult(
      h,
      `
                FOR x in '2018-05-07'
                SELECT <str><cal::local_date>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    # the '-' separators may be omitted
                    '20180507',
                }
                SELECT <cal::local_date>x = <cal::local_date>'2018-05-07';
            `,
      [true]
    );
    expect(() => {
      h.query(
        `SELECT <cal::local_date>"2018-05-07T20:01:22.306916"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_date>"2018/05/07"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_date>"2018.05.07"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_date>"2018-05-07+01:00"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
  });

  it("test_edgeql_casts_str_08", () => {
    assertQueryResult(
      h,
      `
                FOR x in '20:01:22.306916'
                SELECT <str><cal::local_time>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '20:01',
                    '20:01:00',
                    # the ':' separators may be omitted
                    '2001',
                    '200100',
                }
                SELECT <cal::local_time>x = <cal::local_time>'20:01:00';
            `,
      [true, true, true, true]
    );
    expect(() => {
      h.query(
        `SELECT <cal::local_time>'2018-05-07 20:01:22'`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::cal::local_time"));
    expect(() => {
      h.query(
        `SELECT <cal::local_time>"20:01:22.306916+01:00"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
  });

  it("test_edgeql_casts_str_09", () => {
    assertQueryResult(
      h,
      `
                FOR x in 'PT20H1M22.306916S'
                SELECT <str><duration>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '20:01:22.306916',
                    '20h 1m 22.306916s',
                    '20 hours 1 minute 22.306916 seconds',
                    '72082.306916',  # the duration in seconds
                    '0.834285959675926 days',
                }
                SELECT <str><duration>x = x;
            `,
      [false, false, false, false, false]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '20:01:22.306916',
                    '20h 1m 22.306916s',
                    '20 hours 1 minute 22.306916 seconds',
                    '72082.306916',  # the duration in seconds
                    '0.834285959675926 days',
                }
                SELECT <duration>x = <duration>'PT20H1M22.306916S';
            `,
      [true, true, true, true, true]
    );
  });

  it("test_edgeql_casts_str_10", () => {
    assertQueryResult(
      h,
      `
                FOR x in {'-20', '0', '7', '12345'}
                SELECT <str><int16>x = x;
            `,
      [true, true, true, true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {'-20', '0', '7', '12345'}
                SELECT <str><int32>x = x;
            `,
      [true, true, true, true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {'-20', '0', '7', '12345'}
                SELECT <str><int64>x = x;
            `,
      [true, true, true, true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '       42',
                    '42     ',
                    '       42      ',
                }
                SELECT <str><int16>x = x;
            `,
      [false, false, false]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '       42',
                    '42     ',
                    '       42      ',
                }
                SELECT <int16>x = 42;
            `,
      [true, true, true]
    );
  });

  it("test_edgeql_casts_str_11", () => {
    assertQueryResult(
      h,
      `
                FOR x in {'-20', '0', '7.2'}
                SELECT <str><float32>x = x;
            `,
      [true, true, true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {'-20', '0', '7.2'}
                SELECT <str><float64>x = x;
            `,
      [true, true, true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '0.0000000001234',
                    '1234E-13',
                    '0.1234e-9',
                }
                SELECT <str><float32>x = x;
            `,
      [false, false, false]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '0.0000000001234',
                    '1234E-13',
                    '0.1234e-9',
                }
                SELECT <str><float64>x = x;
            `,
      [false, false, false]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '0.0000000001234',
                    '1234E-13',
                    '0.1234e-9',
                }
                SELECT <float64>x = 1234e-13;
            `,
      [true, true, true]
    );
  });

  it("test_edgeql_casts_str_12", () => {
    assertQueryResult(
      h,
      `
                FOR x in {
                    '-20', '0', '7.2', '0.0000000001234', '1234.00000001234'
                }
                SELECT <str><decimal>x = x;
            `,
      [true, true, true, true, true]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '1234E-13',
                    '0.1234e-9',
                }
                SELECT <str><decimal>x = x;
            `,
      [false, false]
    );
    assertQueryResult(
      h,
      `
                FOR x in {
                    '1234E-13',
                    '0.1234e-9',
                }
                SELECT <decimal>x = <decimal>'0.0000000001234';
            `,
      [true, true]
    );
  });

  it("test_edgeql_casts_str_13", () => {
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <uuid><str>T.id = T.id;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <bool><str>T.p_bool = T.p_bool;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <str><str>T.p_str = T.p_str;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <datetime><str>T.p_datetime = T.p_datetime;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <cal::local_datetime><str>T.p_local_datetime =
                    T.p_local_datetime;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <cal::local_date><str>T.p_local_date = T.p_local_date;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <cal::local_time><str>T.p_local_time = T.p_local_time;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <duration><str>T.p_duration = T.p_duration;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <int16><str>T.p_int16 = T.p_int16;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <int32><str>T.p_int32 = T.p_int32;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <int64><str>T.p_int64 = T.p_int64;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <float32><str>T.p_float32 = T.p_float32;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <float64><str>T.p_float64 = T.p_float64;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <bigint><str>T.p_bigint = T.p_bigint;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <decimal><str>T.p_decimal = T.p_decimal;
            `,
      [true]
    );
  });

  it("test_edgeql_casts_numeric_01", () => {
    assertQueryResult(
      h,
      `
                    FOR x in <int16>{-32768, -32767, -100,
                                      0, 13, 32766, 32767}
                    SELECT <int16><decimal>x = x;
                `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
    assertQueryResult(
      h,
      `
                    FOR x in <int32>{-2147483648, -2147483647, -65536, -100,
                                      0, 13, 32768, 2147483646, 2147483647}
                    SELECT <int32><decimal>x = x;
                `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
    assertQueryResult(
      h,
      `
                    FOR x in <int64>{
                        -9223372036854775808,
                        -9223372036854775807,
                        -4294967296,
                        -65536,
                        -100,
                        0,
                        13,
                        65536,
                        4294967296,
                        9223372036854775806,
                        9223372036854775807
                    }
                    SELECT <int64><decimal>x = x;
                `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
    assertQueryResult(
      h,
      `
                    FOR x in <int16>{-32768, -32767, -100,
                                      0, 13, 32766, 32767}
                    SELECT <int16><bigint>x = x;
                `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
    assertQueryResult(
      h,
      `
                    FOR x in <int32>{-2147483648, -2147483647, -65536, -100,
                                      0, 13, 32768, 2147483646, 2147483647}
                    SELECT <int32><bigint>x = x;
                `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
    assertQueryResult(
      h,
      `
                    FOR x in <int64>{
                        -9223372036854775808,
                        -9223372036854775807,
                        -4294967296,
                        -65536,
                        -100,
                        0,
                        13,
                        65536,
                        4294967296,
                        9223372036854775806,
                        9223372036854775807
                    }
                    SELECT <int64><bigint>x = x;
                `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
  });

  it("test_edgeql_casts_numeric_02", () => {
    assertQueryResult(
      h,
      `
                FOR x in <float32>{-3.31234e+38, -1.234e+12, -1.234e-12,
                                    -100, 0, 13, 1.234e-12, 1.234e+12, 3.4e+38}
                SELECT <float32><decimal>x = x;
            `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
    assertQueryResult(
      h,
      `
                FOR x in <float64>{-1.61234e+308, -1.234e+42, -1.234e-42,
                                    -100, 0, 13, 1.234e-42, 1.234e+42,
                                    1.7e+308}
                SELECT <float64><decimal>x = x;
            `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
  });

  it("test_edgeql_casts_numeric_03", () => {
    assertQueryResult(
      h,
      `
            FOR x in <int32>{16777216, 16777215, 16777214,
                              1677721, 167772, 16777}
            SELECT <int32><float32>x = x;
            `,
      [true, true, true, true, true, true]
    );
    assertQueryResult(
      h,
      `
            FOR x in <int32>{2147483548, 2147482648}
            SELECT <int32><float32>x = x;
            `,
      [false, false]
    );
    assertQueryResult(
      h,
      `
            FOR x in <int32>{2147483548, 2147482648}
            SELECT <int32><float32>x;
            `,
      [2147483520, 2147482624]
    );
  });

  it("test_edgeql_casts_numeric_04", () => {
    assertQueryResult(
      h,
      `
                FOR x in <int32>{16777216, 16777215, 16777214,
                                  1677721, 167772, 16777}
                SELECT <int32><float64>x = x;
            `,
      [true, true, true, true, true, true]
    );
    assertQueryResult(
      h,
      `
            FOR x in <int32>{2147483647, 2147483646, 2147483645,
                              2147483638, 2147483548, 2147482648}
            SELECT <int32><float64>x = x;
            `,
      [true, true, true, true, true, true]
    );
  });

  it("test_edgeql_casts_numeric_05", () => {
    assertQueryResult(
      h,
      `
                # 2^31 -1, -2, -3, -10
                FOR x in <int32>{2147483647, 2147483646, 2147483645,
                                  2147483638}
                # 2147483647 is the max int32
                SELECT x <= <int32>2147483647;
            `,
      [true, true, true, true]
    );
    expect(() => {
      h.script(
        `
                    SELECT <int32><float32><int32>2147483647;
                `
      );
    }).toThrow(new RegExp("std::int32 out of range"));
    expect(() => {
      h.script(
        `
                    SELECT <int32><float32><int32>2147483646;
                `
      );
    }).toThrow(new RegExp("std::int32 out of range"));
    expect(() => {
      h.script(
        `
                    SELECT <int32><float32><int32>2147483645;
                `
      );
    }).toThrow(new RegExp("std::int32 out of range"));
    expect(() => {
      h.script(
        `
                    SELECT <int32><float32><int32>2147483638;
                `
      );
    }).toThrow(new RegExp("std::int32 out of range"));
  });

  it("test_edgeql_casts_numeric_06", () => {
    assertQueryResult(
      h,
      `SELECT <int16>1;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT <int32>1;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT <int64>1;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT <float32>1;`,
      [1.0]
    );
    assertQueryResult(
      h,
      `SELECT <float64>1;`,
      [1.0]
    );
    assertQueryResult(
      h,
      `SELECT <bigint>1;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT <decimal>1;`,
      [1]
    );
  });

  it("test_edgeql_casts_numeric_07", () => {
    assertQueryResult(
      h,
      `
                    SELECT <int16><int16>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int16><int32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int16><int64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int16><float32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int16><float64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int16><bigint>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int16><decimal>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int32><int16>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int32><int32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int32><int64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int32><float32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int32><float64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int32><bigint>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int32><decimal>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int64><int16>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int64><int32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int64><int64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int64><float32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int64><float64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int64><bigint>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <int64><decimal>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float32><int16>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float32><int32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float32><int64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float32><float32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float32><float64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float32><bigint>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float32><decimal>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float64><int16>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float64><int32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float64><int64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float64><float32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float64><float64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float64><bigint>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <float64><decimal>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <bigint><int16>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <bigint><int32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <bigint><int64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <bigint><float32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <bigint><float64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <bigint><bigint>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <bigint><decimal>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <decimal><int16>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <decimal><int32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <decimal><int64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <decimal><float32>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <decimal><float64>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <decimal><bigint>1;
                `,
      [1]
    );
    assertQueryResult(
      h,
      `
                    SELECT <decimal><decimal>1;
                `,
      [1]
    );
  });

  it("test_edgeql_casts_numeric_08", () => {
    expect(() => {
      h.query(
        `SELECT <bigint>"100000n"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bigint"));
    expect(() => {
      h.query(
        `SELECT <decimal>"12313.132n"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::decimal"));
    expect(() => {
      h.query(
        `SELECT <bigint>"bigint"`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bigint: 'bigint'"));
  });

  it("test_edgeql_casts_collections_01", () => {
    assertQueryResult(
      h,
      `SELECT <array<str>>[1, 2, 3];`,
      [
            ["1", "2", "3"],
          ]
    );
    assertQueryResult(
      h,
      `WITH X := [1, 2, 3] SELECT <array<str>> X;`,
      [
            ["1", "2", "3"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT <tuple<str, float64>> (1, '2');`,
      [
            ["1", 2.0],
          ]
    );
    assertQueryResult(
      h,
      `WITH X := (1, '2') SELECT <tuple<str, float64>> X;`,
      [
            ["1", 2.0],
          ]
    );
    assertQueryResult(
      h,
      `SELECT <array<tuple<str, float64>>> [(1, '2')];`,
      [
            [
              ["1", 2.0],
            ],
          ]
    );
    assertQueryResult(
      h,
      `WITH X := [(1, '2')]
                SELECT <array<tuple<str, float64>>> X;`,
      [
            [
              ["1", 2.0],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT <tuple<array<float64>>> (['1'],);`,
      [
            [
              [1.0],
            ],
          ]
    );
  });

  it("test_edgeql_casts_collections_02", () => {
    assertQueryResult(
      h,
      `
                WITH
                    std AS MODULE math,
                    foo := (SELECT [1, 2, 3])
                SELECT <array<str>>foo;
            `,
      [
            ["1", "2", "3"],
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    std AS MODULE math,
                    foo := (SELECT [<int32>1, <int32>2, <int32>3])
                SELECT <array<str>>foo;
            `,
      [
            ["1", "2", "3"],
          ]
    );
    assertQueryResult(
      h,
      `
                WITH
                    std AS MODULE math,
                    foo := (SELECT [(1,), (2,), (3,)])
                SELECT <array<tuple<str>>>foo;
            `,
      [
            [
              ["1"],
              ["2"],
              ["3"],
            ],
          ]
    );
  });

  it("test_edgeql_casts_collection_errors_01", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<int64>>1;
            `
      );
    }).toThrow(new RegExp("cannot cast 'std::int64' to 'array<std::int64>'"));
  });

  it("test_edgeql_casts_collection_errors_02", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<int64>>(1,);
            `
      );
    }).toThrow(new RegExp("cannot cast 'tuple<std::int64>' to 'array<std::int64>'"));
  });

  it("test_edgeql_casts_collection_errors_03", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<int64>>{a := 1};
            `
      );
    }).toThrow(new RegExp("cannot cast 'std::FreeObject' to 'array<std::int64>'"));
  });

  it("test_edgeql_casts_collection_errors_04", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<int64>>[(1,)];
            `
      );
    }).toThrow(new RegExp("while casting 'array<tuple<std::int64>>' to 'array<std::int64>', in array elements, cannot cast 'tuple<std::int64>' to 'std::int64'"));
  });

  it("test_edgeql_casts_collection_errors_05", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64>>1;
            `
      );
    }).toThrow(new RegExp("cannot cast 'std::int64' to 'tuple<std::int64>'"));
  });

  it("test_edgeql_casts_collection_errors_06", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64>>[1];
            `
      );
    }).toThrow(new RegExp("cannot cast 'array<std::int64>' to 'tuple<std::int64>'"));
  });

  it("test_edgeql_casts_collection_errors_07", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64>>{a := 1};
            `
      );
    }).toThrow(new RegExp("cannot cast 'std::FreeObject' to 'tuple<std::int64>'"));
  });

  it("test_edgeql_casts_collection_errors_08", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64>>([1],);
            `
      );
    }).toThrow(new RegExp("while casting 'tuple<array<std::int64>>' to 'tuple<std::int64>', at tuple element '0', cannot cast 'array<std::int64>' to 'std::int64'"));
  });

  it("test_edgeql_casts_collection_errors_09", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<a: int64>>(b := [1]);
            `
      );
    }).toThrow(new RegExp("while casting 'tuple<b: array<std::int64>>' to 'tuple<a: std::int64>', at tuple element 'a', cannot cast 'array<std::int64>' to 'std::int64'"));
  });

  it("test_edgeql_casts_collection_errors_10", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<a: tuple<b: int64>>>(([1],),);
            `
      );
    }).toThrow(new RegExp("while casting 'tuple<tuple<array<std::int64>>>' to 'tuple<a: tuple<b: std::int64>>', at tuple element 'a', at tuple element 'b', cannot cast 'array<std::int64>' to 'std::int64'"));
  });

  it("test_edgeql_casts_collection_errors_11", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<tuple<array<int64>>>>[([(1,)],)];
            `
      );
    }).toThrow(new RegExp("while casting 'array<tuple<array<tuple<std::int64>>>>' to 'array<tuple<array<std::int64>>>', in array elements, at tuple element '0', in array elements, cannot cast 'tuple<std::int64>' to 'std::int64'"));
  });

  it("test_edgeql_casts_collection_errors_12", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64, int64, array<int64>>>(1, 2, 3);
            `
      );
    }).toThrow(new RegExp("while casting 'tuple<std::int64, std::int64, std::int64>' to 'tuple<std::int64, std::int64, array<std::int64>>', at tuple element '2', cannot cast 'std::int64' to 'array<std::int64>"));
  });

  it("test_edgeql_casts_illegal_01", () => {
    expect(() => {
      h.script(
        `
                SELECT <anytype>123;
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*'anytype'"));
  });

  it("test_edgeql_casts_illegal_02", () => {
    expect(() => {
      h.script(
        `
                SELECT <anyscalar>123;
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anyscalar'"));
  });

  it("test_edgeql_casts_illegal_03", () => {
    expect(() => {
      h.script(
        `
                SELECT <anyreal>123;
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anyreal'"));
  });

  it("test_edgeql_casts_illegal_04", () => {
    expect(() => {
      h.script(
        `
                SELECT <anyint>123;
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anyint'"));
  });

  it("test_edgeql_casts_illegal_05", () => {
    expect(() => {
      h.script(
        `
                SELECT <anyfloat>123;
            `
      );
    }).toThrow(new RegExp("cannot cast.*"));
  });

  it("test_edgeql_casts_illegal_06", () => {
    expect(() => {
      h.script(
        `
                SELECT <sequence>123;
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*sequence'"));
  });

  it("test_edgeql_casts_illegal_07", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<anytype>>[123];
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anytype"));
  });

  it("test_edgeql_casts_illegal_08", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64, anytype>>(123, 123);
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anytype"));
  });

  it("test_edgeql_casts_illegal_09", () => {
    expect(() => {
      h.script(
        `
                SELECT <schema::Object>std::Object;
            `
      );
    }).toThrow(new RegExp("cannot cast.*std::Object.*use.*IS schema::Object.*"));
  });

  it("test_edgeql_casts_illegal_10", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<anyenum>>{};
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anyenum"));
  });

  it("test_edgeql_casts_illegal_11", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64, anyenum>>{};
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anyenum"));
  });

  it("test_edgeql_casts_illegal_12", () => {
    expect(() => {
      h.script(
        `
                SELECT <range<anypoint>>{};
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anypoint"));
  });

  it("test_edgeql_casts_illegal_13", () => {
    expect(() => {
      h.script(
        `
                SELECT <multirange<anypoint>>{};
            `
      );
    }).toThrow(new RegExp("cannot cast into generic.*anypoint"));
  });

  it("test_edgeql_casts_illegal_param_01", () => {
    expect(() => {
      h.script(
        `
                SELECT <anytype>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*'anytype'"));
  });

  it("test_edgeql_casts_illegal_param_02", () => {
    expect(() => {
      h.script(
        `
                SELECT <anyscalar>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anyscalar'"));
  });

  it("test_edgeql_casts_illegal_param_03", () => {
    expect(() => {
      h.script(
        `
                SELECT <anyreal>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anyreal'"));
  });

  it("test_edgeql_casts_illegal_param_04", () => {
    expect(() => {
      h.script(
        `
                SELECT <anyint>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anyint'"));
  });

  it("test_edgeql_casts_illegal_param_05", () => {
    expect(() => {
      h.script(
        `
                SELECT <anyfloat>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anyfloat'"));
  });

  it("test_edgeql_casts_illegal_param_06", () => {
    expect(() => {
      h.script(
        `
                SELECT <sequence>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*sequence'"));
  });

  it("test_edgeql_casts_illegal_param_07", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<anytype>>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anytype"));
  });

  it("test_edgeql_casts_illegal_param_08", () => {
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64, anytype>>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anytype"));
  });

  it("test_edgeql_casts_illegal_param_10", () => {
    expect(() => {
      h.script(
        `
                SELECT <array<anyenum>>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anyenum"));
  });

  it("test_edgeql_casts_illegal_param_11", () => {
    expect(() => {
      h.script(
        `
                SELECT <optional tuple<int64, anyenum>>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anyenum"));
  });

  it("test_edgeql_casts_illegal_param_12", () => {
    expect(() => {
      h.script(
        `
                SELECT <optional range<anypoint>>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anypoint"));
  });

  it("test_edgeql_casts_illegal_param_13", () => {
    expect(() => {
      h.script(
        `
                SELECT <optional multirange<anypoint>>$0;
            `
      );
    }).toThrow(new RegExp("parameter cannot be a generic type.*anypoint"));
  });

  it("test_edgeql_casts_json_01", () => {
    assertQueryResult(
      h,
      `SELECT <bool><json>True = True;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <bool><json>False = False;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <str><json>"Hello" = 'Hello';`,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH U := uuid_generate_v1mc()
                SELECT <uuid><json>U = U;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <datetime><json>datetime_of_statement() =
                    datetime_of_statement();
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_datetime><json>cal::to_local_datetime(
                        '2018-05-07T20:01:22.306916') =
                    cal::to_local_datetime('2018-05-07T20:01:22.306916');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_date><json>cal::to_local_date('2018-05-07')
                    = cal::to_local_date('2018-05-07');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_time><json>
                    cal::to_local_time('20:01:22.306916') =
                    cal::to_local_time('20:01:22.306916');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <duration><json>to_duration(hours:=20) =
                    to_duration(hours:=20);
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int16><json>to_int16('12345') = 12345;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <int32><json>to_int32('1234567890') = 1234567890;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <int64><json>to_int64(
                    '1234567890123') = 1234567890123;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <float32><json>to_float32('2.5') = 2.5;`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT <float64><json>to_float64('2.5') = 2.5;`,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <bigint><json>to_bigint(
                    '123456789123456789123456789')
                = to_bigint(
                    '123456789123456789123456789');
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <decimal><json>to_decimal(
                    '123456789123456789123456789.123456789123456789123456789')
                = to_decimal(
                    '123456789123456789123456789.123456789123456789123456789');
            `,
      [true]
    );
  });

  it("test_edgeql_casts_json_02", () => {
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <bool><json>T.p_bool = T.p_bool;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <str><json>T.p_str = T.p_str;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <datetime><json>T.p_datetime = T.p_datetime;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <cal::local_datetime><json>T.p_local_datetime =
                    T.p_local_datetime;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <cal::local_date><json>T.p_local_date = T.p_local_date;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <cal::local_time><json>T.p_local_time = T.p_local_time;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <duration><json>T.p_duration = T.p_duration;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <int16><json>T.p_int16 = T.p_int16;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <int32><json>T.p_int32 = T.p_int32;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <int64><json>T.p_int64 = T.p_int64;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <float32><json>T.p_float32 = T.p_float32;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <float64><json>T.p_float64 = T.p_float64;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <bigint><json>T.p_bigint = T.p_bigint;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH T := (SELECT Test FILTER .p_str = 'Hello')
                SELECT <decimal><json>T.p_decimal = T.p_decimal;
            `,
      [true]
    );
  });

  it("test_edgeql_casts_json_03", () => {
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <bool>J.j_bool = T.p_bool;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <str>J.j_str = T.p_str;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <datetime>J.j_datetime = T.p_datetime;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <cal::local_datetime>J.j_local_datetime =
                    T.p_local_datetime;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <cal::local_date>J.j_local_date = T.p_local_date;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <cal::local_time>J.j_local_time = T.p_local_time;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <duration>J.j_duration = T.p_duration;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <int16>J.j_int16 = T.p_int16;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <int32>J.j_int32 = T.p_int32;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <int64>J.j_int64 = T.p_int64;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <float32>J.j_float32 = T.p_float32;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <float64>J.j_float64 = T.p_float64;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <bigint>J.j_bigint = T.p_bigint;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                WITH
                    T := (SELECT Test FILTER .p_str = 'Hello'),
                    J := (SELECT JSONTest FILTER .j_str = <json>'Hello')
                SELECT <decimal>J.j_decimal = T.p_decimal;
            `,
      [true]
    );
  });

  it("test_edgeql_casts_json_04", () => {
    expect(h.query("\n                select <json>(\n                    select schema::Type{name} filter .name = 'std::bool'\n                )\n            ")).toEqual(edgedb.Set(["{\"name\": \"std::bool\"}"]));
  });

  it("test_edgeql_casts_json_05", () => {
    expect(h.query("select <json>{(1, 2), (3, 4)}")).toEqual(["[1, 2]", "[3, 4]"]);
    expect(h.query("select <json>{(a := 1, b := 2), (a := 3, b := 4)}")).toEqual(["{\"a\": 1, \"b\": 2}", "{\"a\": 3, \"b\": 4}"]);
    expect(h.query("select <json>{[1, 2], [3, 4]}")).toEqual(["[1, 2]", "[3, 4]"]);
    expect(h.query("select <json>{[(1, 2)], [(3, 4)]}")).toEqual(["[[1, 2]]", "[[3, 4]]"]);
  });

  it("test_edgeql_casts_json_06", () => {
    expect(con.query_json("select <json>{(1, 2), (3, 4)}")).toEqual("[[1, 2], [3, 4]]");
    expect(con.query_json("select <json>{[1, 2], [3, 4]}")).toEqual("[[1, 2], [3, 4]]");
    expect(con.query_json("select <json>{[(1, 2)], [(3, 4)]}")).toEqual("[[[1, 2]], [[3, 4]]]");
  });

  it("test_edgeql_casts_json_07", () => {
    assertQueryResult(
      h,
      `
                FOR x in <json>'2018-05-07T20:01:22.306916+00:00'
                SELECT <json><datetime>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in <json>{
                    '2018-05-07T15:01:22.306916-05:00',
                    '2018-05-07T15:01:22.306916-05',
                    '2018-05-07T20:01:22.306916Z',
                    '2018-05-07T20:01:22.306916+0000',
                    '2018-05-07T20:01:22.306916+00',
                    # the '-' and ':' separators may be omitted
                    '20180507T200122.306916+00',
                    # acceptable RFC 3339
                    '2018-05-07 20:01:22.306916+00:00',
                    '2018-05-07t20:01:22.306916z',
                }
                SELECT <datetime>x =
                    <datetime><json>'2018-05-07T20:01:22.306916+00:00';
            `,
      [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
          ]
    );
    expect(() => {
      h.query(
        `SELECT <datetime><json>"2018-05-07;20:01:22.306916+00:00"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
    expect(() => {
      h.query(
        `SELECT <datetime><json>"2018-05-07T20:01:22.306916"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
    expect(() => {
      h.query(
        `SELECT <datetime><json>"2018-05-07T20:01:22.306916 1000"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
    expect(() => {
      h.query(
        `SELECT <datetime><json>
                    "2018-05-07T20:01:22.306916 US/Central"
                `
      );
    }).toThrow(new RegExp("invalid input syntax"));
    expect(() => {
      h.query(
        `SELECT <datetime><json>"2018-05-07T20:01:22.306916 +GMT1"`
      );
    }).toThrow(new RegExp("invalid input syntax"));
  });

  it("test_edgeql_casts_json_08", () => {
    assertQueryResult(
      h,
      `
                FOR x in <json>'2018-05-07T20:01:22.306916'
                SELECT <json><cal::local_datetime>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in <json>{
                    # the '-' and ':' separators may be omitted
                    '20180507T200122.306916',
                    # acceptable RFC 3339
                    '2018-05-07 20:01:22.306916',
                    '2018-05-07t20:01:22.306916',
                }
                SELECT <cal::local_datetime>x =
                    <cal::local_datetime><json>'2018-05-07T20:01:22.306916';
            `,
      [true, true, true]
    );
    expect(() => {
      h.query(
        `SELECT
                    <cal::local_datetime><json>"2018-05-07;20:01:22.306916"
                `
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_datetime><json>
                    "2018-05-07T20:01:22.306916+01:00"
                `
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_datetime><json>
                    "2018-05-07T20:01:22.306916 GMT"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_datetime><json>
                    "2018-05-07T20:01:22.306916 GMT0"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_datetime><json>
                    "2018-05-07T20:01:22.306916 US/Central"
                `
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
  });

  it("test_edgeql_casts_json_09", () => {
    assertQueryResult(
      h,
      `
                FOR x in <json>'2018-05-07'
                SELECT <json><cal::local_date>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                # the '-' separators may be omitted
                FOR x in <json>'20180507'
                SELECT
                    <cal::local_date>x = <cal::local_date><json>'2018-05-07';
            `,
      [true]
    );
    expect(() => {
      h.query(
        `SELECT <cal::local_date><json>"2018-05-07T20:01:22.306916"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_date><json>"2018/05/07"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_date><json>"2018.05.07"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
    expect(() => {
      h.query(
        `SELECT <cal::local_date><json>"2018-05-07+01:00"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
  });

  it("test_edgeql_casts_json_10", () => {
    assertQueryResult(
      h,
      `
                FOR x in <json>'20:01:22.306916'
                SELECT <json><cal::local_time>x = x;
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                FOR x in <json>{
                    '20:01',
                    '20:01:00',
                    # the ':' separators may be omitted
                    '2001',
                    '200100',
                }
                SELECT <cal::local_time>x = <cal::local_time>'20:01:00';
            `,
      [true, true, true, true]
    );
    expect(() => {
      h.query(
        `SELECT <cal::local_time><json>'2018-05-07 20:01:22'`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::cal::local_time"));
    expect(() => {
      h.query(
        `SELECT <cal::local_time><json>"20:01:22.306916+01:00"`
      );
    }).toThrow(new RegExp("invalid input syntax for type"));
  });

  it("test_edgeql_casts_json_11", () => {
    assertQueryResult(
      h,
      `SELECT <array<int64>><json>[1, 1, 2, 3, 5]`,
      [
            [1, 1, 2, 3, 5],
          ]
    );
    expect(() => {
      h.query(
        `SELECT <array<int64>><json>'asdf'`
      );
    }).toThrow(new RegExp("expected JSON array; got JSON string"));
    expect(() => {
      h.query(
        `SELECT <array<int64>><json>['asdf']`
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'array<std::int64>', in array elements, expected JSON number or null; got JSON string"));
    expect(() => {
      h.query(
        `SELECT <array<int64>>to_json('[1, 2, \"asdf\"]')`
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'array<std::int64>', in array elements, expected JSON number or null; got JSON string"));
    expect(() => {
      h.script(
        `
                SELECT <array<int64>>to_json('["a"]');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'array<std::int64>', in array elements, expected JSON number or null; got JSON string"));
    expect(() => {
      h.query(
        `SELECT <array<int64>>[to_json('1'), to_json('null')]`
      );
    }).toThrow(new RegExp("while casting 'array<std::json>' to 'array<std::int64>', in array elements, invalid null value in cast"));
    expect(() => {
      h.query(
        `SELECT <array<int64>>to_json('[1, 2, null]')`
      );
    }).toThrow(new RegExp("array<std::int64>', in array elements, invalid null value in cast"));
    expect(() => {
      h.query(
        `SELECT <array<int64>><array<json>>to_json('[1, 2, null]')`
      );
    }).toThrow(new RegExp("while casting 'array<std::json>' to 'array<std::int64>', in array elements, invalid null value in cast"));
    expect(() => {
      h.query(
        `select <tuple<array<str>>>to_json('[null]')`
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<array<std::str>>', at tuple element '0', invalid null value in cast"));
    expect(() => {
      h.query(
        `select <tuple<array<str>>>to_json('[[null]]')`
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<array<std::str>>', at tuple element '0', in array elements, invalid null value in cast"));
    expect(() => {
      h.script(
        `
                SELECT <array<int64>>to_json('{"a": 1}');
            `
      );
    }).toThrow(new RegExp("expected JSON array; got JSON object"));
    expect(() => {
      h.script(
        `
                SELECT <array<int64>>to_json('[{"a": 1}]');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'array<std::int64>', in array elements, expected JSON number or null; got JSON object"));
    expect(() => {
      h.script(
        `
                SELECT <array<tuple<array<str>>>>to_json('[[[1]]]');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'array<tuple<array<std::str>>>', in array elements, at tuple element '0', in array elements, expected JSON string or null; got JSON number"));
  });

  it("test_edgeql_casts_json_12", () => {
    expect(h.query("\n                    SELECT <tuple<a: int64, b: int64>>\n                    to_json('{\"a\": 1, \"b\": 2}')\n                ")).toEqual([edgedb.NamedTuple()]);
    assertQueryResult(
      h,
      `
                SELECT <tuple<a: int64, b: int64>>
                to_json({'{"a": 3000, "b": -1}', '{"a": 1, "b": 12}'});
            `,
      [
            {
              "a": 3000,
              "b": -1,
            },
            {
              "a": 1,
              "b": 12,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT <tuple<int64, int64>>
                to_json({'[3000, -1]', '[1, 12]'})
            `,
      [
            [3000, -1],
            [1, 12],
          ]
    );
    expect(h.query("\n                    SELECT <tuple<int64, int64>>\n                    to_json({'[3000, -1]', '[1, 12]'})\n                ")).toEqual([
  [3000, -1],
  [1, 12],
]);
    expect(h.query("\n                    SELECT <tuple<json, json>>\n                    to_json({'[3000, -1]', '[1, 12]'})\n                ")).toEqual([
  ["3000", "-1"],
  ["1", "12"],
]);
    expect(h.query("\n                    SELECT <tuple<json, json>>\n                    to_json({'[3000, -1]', '[1, null]'})\n                ")).toEqual([
  ["3000", "-1"],
  ["1", "null"],
]);
    expect(h.query("\n                    SELECT <tuple<int64, tuple<a: int64, b: int64>>>\n                    to_json('[3000, {\"a\": 1, \"b\": 2}]')\n                ")).toEqual([3000, edgedb.NamedTuple()]);
    expect(h.query("\n                    SELECT <tuple<int64, array<tuple<a: int64, b: str>>>>\n                    to_json('[3000, [{\"a\": 1, \"b\": \"foo\"},\n                                     {\"a\": 12, \"b\": \"bar\"}]]')\n                ")).toEqual([3000, [edgedb.NamedTuple(), edgedb.NamedTuple()]]);
    expect(() => {
      h.query(
        `
                    SELECT <tuple<a: int64, b: int64>>
                    to_json('{"a": 1, "b": "2"}')
                `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<a: std::int64, b: std::int64>', at tuple element 'b', expected JSON number or null; got JSON string"));
    expect(() => {
      h.query(
        `SELECT <tuple<a: int64>>to_json('{"a": null}')`
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<a: std::int64>', at tuple element 'a', invalid null value in cast"));
    expect(() => {
      h.query(
        `SELECT <tuple<a: int64, b: int64>>to_json('{"a": 1}')`
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<a: std::int64, b: std::int64>', at tuple element 'b', missing value in JSON object"));
    expect(() => {
      h.query(
        `SELECT <tuple<int64, int64>>to_json('[3000]')`
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<std::int64, std::int64>', at tuple element '1', missing value in JSON object"));
    expect(() => {
      h.query(
        `
                    SELECT <tuple<a: int64, b: int64>>
                    to_json('[3000, 1000]')
                `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<a: std::int64, b: std::int64>', at tuple element 'a', missing value in JSON object"));
    expect(() => {
      h.query(
        `SELECT <tuple<a: int64, b: int64>> to_json('"test"')`
      );
    }).toThrow(new RegExp("expected JSON array or object or null; got JSON string"));
    expect(() => {
      h.query(
        `SELECT <tuple<json, json>> to_json('[3000]')`
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<std::json, std::json>', at tuple element '1', missing value in JSON object"));
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64>>to_json('{"a": 1}');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<std::int64>', at tuple element '0', missing value in JSON object"));
    expect(() => {
      h.script(
        `
                SELECT <tuple<a: tuple<b: str>>>to_json('{"a": {"b": 1}}');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<a: tuple<b: std::str>>', at tuple element 'a', at tuple element 'b', expected JSON string or null; got JSON number"));
    expect(() => {
      h.script(
        `
                SELECT <tuple<int64, int64>>to_json('[1, null]');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<std::int64, std::int64>', at tuple element '1', invalid null value in cast"));
    expect(() => {
      h.script(
        `
                SELECT <tuple<a: int64>>to_json('{"a": null}');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<a: std::int64>', at tuple element 'a', invalid null value in cast"));
    expect(() => {
      h.script(
        `
                SELECT <tuple<a: array<int64>>>to_json('{"a": null}');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<a: array<std::int64>>', at tuple element 'a', invalid null value in cast"));
    expect(() => {
      h.script(
        `
                SELECT <tuple<a: tuple<b: str>>>to_json('{"a": null}');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'tuple<a: tuple<b: std::str>>', at tuple element 'a', invalid null value in cast"));
  });

  it("test_edgeql_casts_json_13", () => {
    assertQueryResult(
      h,
      `
                select <array<json>>to_json('null')
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select <array<str>>to_json('null')
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select <array<int64>>json_get(to_json('{}'), 'foo')
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select <tuple<str>>to_json('null')
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select <tuple<json>>to_json('null')
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select <bigint>to_json('null')
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select <decimal>to_json('null')
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select <bigint><str>to_json('null')
            `,
      []
    );
    assertQueryResult(
      h,
      `
                select <decimal><str>to_json('null')
            `,
      []
    );
  });

  it("test_edgeql_casts_json_14", () => {
    assertQueryResult(
      h,
      `
                select <array<json>>to_json('[]')
            `,
      [
            [],
          ]
    );
    assertQueryResult(
      h,
      `
                select <array<str>>to_json('[]')
            `,
      [
            [],
          ]
    );
  });

  it("test_edgeql_casts_json_15", () => {
    h.script(
      `
            create type Z { create link z -> Z; };
        `
    );
    h.query(
      `
            select <json>Z union <json>Z;
        `
    );
  });

  it("test_edgeql_casts_json_16", () => {
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('1');
            `
      );
    }).toThrow(new RegExp("expected JSON object or null; got JSON number"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('[1]');
            `
      );
    }).toThrow(new RegExp("expected JSON object or null; got JSON array"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('{
                    "empty": 1
                }');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'range<std::int64>', in range parameter 'empty', expected JSON boolean or null; got JSON number"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('{
                    "empty": true,
                    "lower": 1,
                    "upper": 2
                }');
            `
      );
    }).toThrow(new RegExp("conflicting arguments in range constructor: 'empty' is `true` while the specified bounds suggest otherwise"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('{
                    "empty": true,
                    "lower": 1,
                    "upper": 2,
                    "inc_lower": true,
                    "inc_upper": true
                }');
            `
      );
    }).toThrow(new RegExp("conflicting arguments in range constructor: 'empty' is `true` while the specified bounds suggest otherwise"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('{
                    "inc_upper": false
                }');
            `
      );
    }).toThrow(new RegExp("JSON object representing a range must include an 'inc_lower'"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('{
                    "inc_lower": false
                }');
            `
      );
    }).toThrow(new RegExp("JSON object representing a range must include an 'inc_upper'"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('{
                    "inc_lower": 1,
                    "inc_upper": false
                }');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'range<std::int64>', in range parameter 'inc_lower', expected JSON boolean or null; got JSON number"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('{
                    "inc_lower": false,
                    "inc_upper": 1
                }');
            `
      );
    }).toThrow(new RegExp("while casting 'std::json' to 'range<std::int64>', in range parameter 'inc_upper', expected JSON boolean or null; got JSON number"));
    expect(() => {
      h.script(
        `
                SELECT <range<int64>>to_json('{
                    "lower": 1,
                    "upper": 2,
                    "inc_lower": true,
                    "inc_upper": true,
                    "foo": "foo",
                    "bar": "bar"
                }');
            `
      );
    }).toThrow(new RegExp("JSON object representing a range contains unexpected keys: bar, foo"));
  });

  it("test_edgeql_casts_json_17", () => {
    expect(() => {
      h.script(
        `
                SELECT <multirange<int64>>to_json('1');
            `
      );
    }).toThrow(new RegExp("expected JSON array; got JSON number"));
    expect(() => {
      h.script(
        `
                SELECT <multirange<int64>>to_json('{"a": 1}');
            `
      );
    }).toThrow(new RegExp("expected JSON array; got JSON object"));
  });

  it("test_edgeql_casts_multirange_set_01", () => {
    assertQueryResult(
      h,
      `
                select count(
                  <multirange<int32>>{range(0, 10), range(12, 15)}
                 );
            `,
      [2]
    );
  });

  it("test_edgeql_casts_assignment_01", () => {
    h.script(
      `

                # int64 is assignment castable or implicitly castable
                # into any other numeric type
                INSERT ScalarTest {
                    p_int16 := 1,
                    p_int32 := 1,
                    p_int64 := 1,
                    p_float32 := 1,
                    p_float64 := 1,
                    p_bigint := 1,
                    p_decimal := 1,
                };
            `
    );
    assertQueryResult(
      h,
      `
                    SELECT ScalarTest {
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
              "p_int16": 1,
              "p_int32": 1,
              "p_int64": 1,
              "p_float32": 1,
              "p_float64": 1,
              "p_bigint": 1,
              "p_decimal": 1,
            },
          ]
    );
  });

  it("test_edgeql_casts_assignment_02", () => {
    h.script(
      `

                # float64 is assignment castable to float32
                INSERT ScalarTest {
                    p_float32 := 1.5,
                };
            `
    );
    assertQueryResult(
      h,
      `
                    SELECT ScalarTest {
                        p_float32,
                    };
                `,
      [
            {
              "p_float32": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_casts_assignment_03", () => {
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_int16 := <decimal>3,
                            p_decimal := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_decimal = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_int16 := <bigint>3,
                            p_bigint := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_bigint = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_int32 := <decimal>3,
                            p_decimal := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_decimal = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_int32 := <bigint>3,
                            p_bigint := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_bigint = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_int64 := <decimal>3,
                            p_decimal := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_decimal = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_int64 := <bigint>3,
                            p_bigint := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_bigint = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_float32 := <decimal>3,
                            p_decimal := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_decimal = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_float32 := <bigint>3,
                            p_bigint := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_bigint = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_float64 := <decimal>3,
                            p_decimal := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_decimal = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
    expect(() => {
      h.script(
        `
                        INSERT ScalarTest {
                            p_float64 := <bigint>3,
                            p_bigint := 1001,
                        };
                    
                            # clean up, so other tests can proceed
                            DELETE (
                                SELECT ScalarTest
                                FILTER .p_bigint = 1001
                            );
                        `
      );
    }).toThrow(new RegExp("invalid target for property"));
  });

  it("test_edgeql_casts_custom_scalar_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <custom_str_t>'ABC'
            `,
      ["ABC"]
    );
    expect(() => {
      h.query(
        `SELECT <custom_str_t>'123'`
      );
    }).toThrow(new RegExp("invalid custom_str_t"));
  });

  it("test_edgeql_casts_custom_scalar_02", () => {
    assertQueryResult(
      h,
      `
                SELECT <foo><bar>'test'
            `,
      ["test"]
    );
    assertQueryResult(
      h,
      `
                SELECT <array<foo>><array<bar>>['test']
            `,
      [
            ["test"],
          ]
    );
  });

  it("test_edgeql_casts_custom_scalar_03", () => {
    assertQueryResult(
      h,
      `
                SELECT <array<custom_str_t>><array<bar>>['TEST']
            `,
      [
            ["TEST"],
          ]
    );
    expect(() => {
      h.query(
        `
                SELECT <custom_str_t><bar>'test'
            `
      );
    }).toThrow(new RegExp("invalid"));
    expect(() => {
      h.query(
        `
                SELECT <array<custom_str_t>><array<bar>>['test']
            `
      );
    }).toThrow(new RegExp("invalid"));
  });

  it("test_edgeql_casts_custom_scalar_04", () => {
    h.script(
      `
            create abstract scalar type abs extending int64;
            create scalar type foo2 extending abs;
            create scalar type bar2 extending abs;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT <foo2><bar2>42
            `,
      [42]
    );
    assertQueryResult(
      h,
      `
                SELECT <array<foo2>><array<bar2>>[42]
            `,
      [
            [42],
          ]
    );
  });

  it("test_edgeql_casts_custom_scalar_05", () => {
    h.script(
      `
            create abstract scalar type xfoo extending int64;
            create abstract scalar type xbar extending int64;
            create scalar type bar1 extending xfoo, xbar;
            create scalar type bar2 extending xfoo, xbar;
        `
    );
    assertQueryResult(
      h,
      `
                SELECT <bar1><bar2>42
            `,
      [42]
    );
    assertQueryResult(
      h,
      `
                SELECT <array<bar1>><array<bar2>>[42]
            `,
      [
            [42],
          ]
    );
  });

  it("test_edgeql_casts_custom_scalar_06", () => {
    h.script(
      `
            create scalar type x extending str {
                create constraint expression on (false)
            };
        `
    );
    expect(() => {
      h.query(
        `SELECT <x>42`
      );
    }).toThrow(new RegExp("invalid x"));
    expect(() => {
      h.query(
        `SELECT <x>to_json('"a"')`
      );
    }).toThrow(new RegExp("invalid x"));
  });

  it("test_edgeql_casts_tuple_params_01", () => {
    let tests = {"tuple<str, bool>": [
  ["x", true],
  ["y", false],
], "optional tuple<str, bool>": [
  ["x", true],
  null,
], "tuple<tuple<str, bool>>": [
  [
    ["x", true],
  ],
], "tuple<tuple<str, bool>, int64>": [
  [
    ["x", true],
    1,
  ],
], "array<tuple<int64, str>>": [
  [],
  [
    [0, "zero"],
  ],
  [
    [0, "zero"],
    [1, "one"],
  ],
], "optional array<tuple<int64, str>>": [
  null,
  [],
  [
    [0, "zero"],
  ],
  [
    [0, "zero"],
    [1, "one"],
  ],
], "array<tuple<str, array<int64>>>": [
  [],
  [
    [
      "x",
      [],
    ],
  ],
  [
    [
      "x",
      [1],
    ],
  ],
  [
    [
      "x",
      [],
    ],
    [
      "y",
      [],
    ],
    [
      "z",
      [],
    ],
  ],
  [
    [
      "x",
      [1],
    ],
    [
      "y",
      [],
    ],
    [
      "z",
      [],
    ],
  ],
  [
    [
      "x",
      [],
    ],
    [
      "y",
      [1],
    ],
    [
      "z",
      [],
    ],
  ],
  [
    [
      "x",
      [],
    ],
    [
      "y",
      [],
    ],
    [
      "z",
      [1],
    ],
  ],
  [
    [
      "x",
      [],
    ],
    [
      "y",
      [1, 2],
    ],
    [
      "z",
      [1, 2, 3],
    ],
  ],
], "array<tuple<tuple<str, bool>, int64>>": [
  [],
  [
    [
      ["x", true],
      1,
    ],
  ],
  [
    [
      ["x", true],
      1,
    ],
    [
      ["z", false],
      2,
    ],
  ],
], "array<tuple<tuple<array<str>, bool>, int64>>": [
  [],
  [
    [
      [
        [],
        true,
      ],
      1,
    ],
  ],
  [
    [
      [
        ["x", "y", "z"],
        true,
      ],
      1,
    ],
    [
      [
        ["z"],
        false,
      ],
      2,
    ],
  ],
], "array<tuple<array<int64>>>": undefined, "array<tuple<array<tuple<array<int64>>>>>": undefined};
    for (const [typ, vals] of (tests.items() as any)) {
      let qry = `SELECT <${typ}>$0`;
      for (const val of (vals as any)) {
        assertQueryResult(
          h,
          qry,
          undefined
        );
      }
    }
  });

  it("test_edgeql_casts_tuple_params_02", () => {
    assertQueryResult(
      h,
      `
            SELECT Test {
                id,
                num := (<tuple<int64, float64, str, bytes>>$tup).0,
                st := (<tuple<int64, float64, str, bytes>>$tup).2,
            };
            `,
      [
            {
              "num": 0,
              "st": "str",
            },
          ]
    );
  });

  it("test_edgeql_casts_tuple_params_03", () => {
    h.query(
      `
            create type Record {
                 create required property name -> str;
                 create multi property tags -> int64;
            }
            `
    );
    h.script(
      `
        for row in array_unpack(<array<tuple<str, array<int64>>>>$0) union ((
            insert Record { name := row.0, tags := array_unpack(row.1) }
        ))
        `
    );
    assertQueryResult(
      h,
      `
                    select Record { name, tags }
                    `,
      unorderedBag([])
    );
    h.script(
      `
        for row in array_unpack(<array<tuple<str, array<int64>>>>$0) union ((
            insert Record { name := row.0, tags := array_unpack(row.1) }
        ))
        `
    );
    assertQueryResult(
      h,
      `
                    select Record { name, tags }
                    `,
      unorderedBag([
            {
              "name": "x",
              "tags": unorderedBag([]),
            },
          ])
    );
    h.script(
      `
        for row in array_unpack(<array<tuple<str, array<int64>>>>$0) union ((
            insert Record { name := row.0, tags := array_unpack(row.1) }
        ))
        `
    );
    assertQueryResult(
      h,
      `
                    select Record { name, tags }
                    `,
      unorderedBag([
            {
              "name": "x",
              "tags": unorderedBag([1]),
            },
          ])
    );
    h.script(
      `
        for row in array_unpack(<array<tuple<str, array<int64>>>>$0) union ((
            insert Record { name := row.0, tags := array_unpack(row.1) }
        ))
        `
    );
    assertQueryResult(
      h,
      `
                    select Record { name, tags }
                    `,
      unorderedBag([
            {
              "name": "x",
              "tags": unorderedBag([]),
            },
            {
              "name": "y",
              "tags": unorderedBag([]),
            },
            {
              "name": "z",
              "tags": unorderedBag([]),
            },
          ])
    );
    h.script(
      `
        for row in array_unpack(<array<tuple<str, array<int64>>>>$0) union ((
            insert Record { name := row.0, tags := array_unpack(row.1) }
        ))
        `
    );
    assertQueryResult(
      h,
      `
                    select Record { name, tags }
                    `,
      unorderedBag([
            {
              "name": "x",
              "tags": unorderedBag([1]),
            },
            {
              "name": "y",
              "tags": unorderedBag([]),
            },
            {
              "name": "z",
              "tags": unorderedBag([]),
            },
          ])
    );
    h.script(
      `
        for row in array_unpack(<array<tuple<str, array<int64>>>>$0) union ((
            insert Record { name := row.0, tags := array_unpack(row.1) }
        ))
        `
    );
    assertQueryResult(
      h,
      `
                    select Record { name, tags }
                    `,
      unorderedBag([
            {
              "name": "x",
              "tags": unorderedBag([]),
            },
            {
              "name": "y",
              "tags": unorderedBag([1]),
            },
            {
              "name": "z",
              "tags": unorderedBag([]),
            },
          ])
    );
    h.script(
      `
        for row in array_unpack(<array<tuple<str, array<int64>>>>$0) union ((
            insert Record { name := row.0, tags := array_unpack(row.1) }
        ))
        `
    );
    assertQueryResult(
      h,
      `
                    select Record { name, tags }
                    `,
      unorderedBag([
            {
              "name": "x",
              "tags": unorderedBag([]),
            },
            {
              "name": "y",
              "tags": unorderedBag([]),
            },
            {
              "name": "z",
              "tags": unorderedBag([1]),
            },
          ])
    );
    h.script(
      `
        for row in array_unpack(<array<tuple<str, array<int64>>>>$0) union ((
            insert Record { name := row.0, tags := array_unpack(row.1) }
        ))
        `
    );
    assertQueryResult(
      h,
      `
                    select Record { name, tags }
                    `,
      unorderedBag([
            {
              "name": "x",
              "tags": unorderedBag([]),
            },
            {
              "name": "y",
              "tags": unorderedBag([1, 2]),
            },
            {
              "name": "z",
              "tags": unorderedBag([1, 2, 3]),
            },
          ])
    );
  });

  it("test_edgeql_casts_tuple_params_04", () => {
    assertQueryResult(
      h,
      `
            select (<optional tuple<str, int64>>$0) ?? ('foo', 0)
            `,
      [
            ["foo", 0],
          ]
    );
  });

  it("test_edgeql_casts_tuple_params_05", () => {
    assertQueryResult(
      h,
      `
            select <tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<int64>>>>>>>>>>>>>>>>>>>>>$0
            `,
      [
            [
              [
                [
                  [
                    [
                      [
                        [
                          [
                            [
                              [
                                [
                                  [
                                    [
                                      [
                                        [
                                          [
                                            [
                                              [
                                                [
                                                  [0],
                                                ],
                                              ],
                                            ],
                                          ],
                                        ],
                                      ],
                                    ],
                                  ],
                                ],
                              ],
                            ],
                          ],
                        ],
                      ],
                    ],
                  ],
                ],
              ],
            ],
          ]
    );
    expect(() => {
      h.query(
        `
                select <tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<tuple<int64>>>>>>>>>>>>>>>>>>>>>>$0
            `
      );
    }).toThrow(new RegExp("too deeply nested"));
  });

  it("test_edgeql_casts_tuple_params_06", () => {
    assertQueryResult(
      h,
      `
            select
                (<tuple<str, str>>$0).0 ++ <str>$1 ++ (<tuple<str, str>>$0).1
            `,
      ["foo bar"]
    );
    assertQueryResult(
      h,
      `
            select
                (<tuple<str, str>>$0).0 ++ <str>$1 ++ (<tuple<str, str>>$0).1
                ++ '!'
            `,
      ["foo bar!"]
    );
    assertQueryResult(
      h,
      `
            select
                (<tuple<str, str>>$0).0 ++ <str>$1 ++ (<tuple<str, str>>$0).1
                ++ (with z := (<tuple<str, str>>$2) select (z.0 ++ z.1))
                ++ '!'
            `,
      ["foo barxy!"]
    );
  });

  it("test_edgeql_casts_tuple_params_07", () => {
    assertQueryResult(
      h,
      `
            select <tuple<name: str, flag: bool>>$0
            `,
      [
            {
              "name": "a",
              "flag": true,
            },
          ]
    );
  });

  it("test_edgeql_casts_tuple_params_08", () => {
    assertQueryResult(
      h,
      `
            select { x := <optional tuple<str, str>>$0, y := <str>$1 };
            `,
      [
            {
              "x": null,
              "y": "test",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select { x := <optional tuple<str, str>>$0, y := <int64>$1 };
            `,
      [
            {
              "x": null,
              "y": 11111,
            },
          ]
    );
  });

  it("test_edgeql_casts_tuple_params_09", () => {
    h.query(
      `
            WITH
              p := <tuple<test: str>>$0
            insert Test { p_tup := p };
        `
    );
    assertQueryResult(
      h,
      `
            select Test { p_tup } filter exists .p_tup
            `,
      [
            {
              "p_tup": {
                "test": "foo",
              },
            },
          ]
    );
    assertQueryResult(
      h,
      `
            WITH
              p := <tuple<test: str>>$0
            select p
            `,
      [
            {
              "test": "foo",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select <tuple<test: str>>$0
            `,
      [
            {
              "test": "foo",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select <array<tuple<test: str>>>$0
            `,
      [
            [
              {
                "test": "foo",
              },
              {
                "test": "bar",
              },
            ],
          ]
    );
  });

  it("test_edgeql_cast_empty_set_to_array_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <array<Object>>{};
            `,
      []
    );
  });

  it("test_edgeql_casts_std_enum_01", () => {
    assertQueryResult(
      h,
      `
            select <schema::Cardinality>{}
            `,
      []
    );
  });

  it("test_edgeql_casts_json_set_02", () => {
    assertQueryResult(
      h,
      `
            select <tuple<str>>json_set(
                to_json('["b"]'), "0", value := <json>"a");
            `,
      [
            ["a"],
          ]
    );
  });

  it("test_edgeql_casts_all_null", () => {
    let casts = h.query("\n            select schema::Cast { from_type: {name}, to_type: {name} }\n            filter not .from_type is schema::ObjectType\n        ");
    let from_types = undefined;
    let type_keys = undefined;
    let props = sep.join(undefined);
    let setup = `
            CREATE TYPE Null {
                ${props}
            };
            INSERT Null;
        `;
    h.script(
      setup
    );
    for (const cast of (casts as any)) {
      let prop = type_keys[_t(cast.from_type.name)];
      assertQueryResult(
        h,
        `
                SELECT Null {
                    res := <${_t(cast.to_type.name)}>.${prop}
                }
                `,
        [
              {
                "res": null,
              },
            ]
      );
      if ((cast.from_type.name === "std::json")) {
        assertQueryResult(
          h,
          `
                    SELECT <${_t(cast.to_type.name)}>to_json('null')
                    `,
          []
        );
      }
    }
  });

  it("test_edgeql_casts_uuid_to_object", () => {
    let persons = h.query("select Person { id }");
    let res = h.query("select <Person><uuid>$0");
    expect((res).length).toEqual(1);
    expect(() => {
      h.query(
        `select <Person><uuid>$0`
      );
    }).toThrow(new RegExp("with id .* does not exist"));
    assertQueryResult(
      h,
      `
            select (<Person>{<uuid>$0, <uuid>$1}) { name }
            order by .name;
            `,
      [
            {
              "name": "kelly",
            },
            {
              "name": "tom",
            },
          ]
    );
    expect(() => {
      h.query(
        `
                select (<Person>{<uuid>$0, <uuid>$1}) { name }
                order by .name;
                `
      );
    }).toThrow(new RegExp("with id .* does not exist"));
    res = h.query("select <Person><optional uuid>$0");
    expect((res).length).toEqual(1);
    res = h.query("select <optional Person><optional uuid>$0");
    expect((res).length).toEqual(0);
    res = h.query("select <optional Person><optional uuid>{}");
    expect((res).length).toEqual(0);
    res = h.query("select <Person><optional uuid>$0");
    expect((res).length).toEqual(0);
    res = h.query("select <Person>$0");
    expect((res).length).toEqual(1);
    res = h.query("select <optional Person>$0");
    expect((res).length).toEqual(0);
    expect(() => {
      h.query(
        `select <optional Person>$0`
      );
    }).toThrow(new RegExp("with id .* does not exist"));
    expect(() => {
      h.query(
        `select <Person>$0`
      );
    }).toThrow(new RegExp("with id .* does not exist"));
  });
});
