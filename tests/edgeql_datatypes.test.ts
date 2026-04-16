import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLDT", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      dbFile: "./tests/.artifacts/datatypes.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_dt_realativedelta_01", () => {
    assertQueryResult(
      h,
      `SELECT <cal::relative_duration>'1 year 2 seconds'`,
      ["P1YT2S"]
    );
    assertQueryResult(
      h,
      `SELECT <str><cal::relative_duration>'1 year 2 seconds'`,
      ["P1YT2S"]
    );
    assertQueryResult(
      h,
      `SELECT <json><cal::relative_duration><json>'1 year 2 seconds'`,
      ["P1YT2S"]
    );
    assertQueryResult(
      h,
      `
            WITH
                dt := <datetime>'2000-01-01T00:00:00Z',
                rd := <cal::relative_duration>'3 years 2 months 14 days'
            SELECT (dt + rd, rd + dt, dt - rd)
            `,
      [
            ["2003-03-15T00:00:00+00:00", "2003-03-15T00:00:00+00:00", "1996-10-18T00:00:00+00:00"],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH
                dt := <cal::local_datetime>'2000-01-01T00:00:00',
                rd := <cal::relative_duration>'3 years 2 months 14 days'
            SELECT (dt + rd, rd + dt, dt - rd)
            `,
      [
            ["2003-03-15T00:00:00", "2003-03-15T00:00:00", "1996-10-18T00:00:00"],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH
                d := <cal::local_date>'2000-01-01',
                rd := <cal::relative_duration>'3 years 2 months 14 days'
            SELECT (d + rd, rd + d, d - rd)
            `,
      [
            ["2003-03-15T00:00:00", "2003-03-15T00:00:00", "1996-10-18T00:00:00"],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH
                t := <cal::local_time>'00:00:00',
                rd := <cal::relative_duration>'3h2m1s'
            SELECT (t + rd, rd + t, t - rd)
            `,
      [
            ["03:02:01", "03:02:01", "20:57:59"],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH rd := <cal::relative_duration>'3h2m1s'
            SELECT (
                rd = rd, rd ?= rd,
                rd != rd, rd ?!= rd,
                rd > rd, rd >= rd,
                rd < rd, rd <= rd,
                rd + rd, rd - rd,
                -rd,
            )
            `,
      [
            [
              true,
              true,
              false,
              false,
              false,
              true,
              false,
              true,
              "PT6H4M2S",
              "PT0S",
              "PT-3H-2M-1S",
            ],
          ]
    );
    assertQueryResult(
      h,
      ` SELECT <json><cal::relative_duration>'3y2h' `,
      ["P3YT2H"]
    );
    assertQueryResult(
      h,
      ` SELECT <cal::relative_duration><json>'P3YT2H' `,
      ["P3YT2H"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                to_str(
                    <cal::relative_duration>'3y' +
                    <cal::relative_duration>'1h'
                ),
                to_str(<cal::relative_duration>'3y1h', 'YYYY"y"HH24"h"'),
            )
            `,
      [
            ["P3YT1H", "0003y01h"],
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT cal::to_relative_duration(
                years := 1,
                months := 2,
                days := 3,
                hours := 4,
                minutes := 5,
                seconds := 6,
                microseconds := 7,
            )
            `,
      ["P1Y2M3DT4H5M6.000007S"]
    );
    assertQueryResult(
      h,
      `
            WITH
                x := <cal::relative_duration>'1y',
                y := <cal::relative_duration>'5y',
            SELECT (
                max({x, y}),
                min({x, y}),
            )
            `,
      [
            ["P5Y", "P1Y"],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH
                rd := <cal::relative_duration>'1s',
                d := <duration>'5s',
            SELECT (<duration>rd, <cal::relative_duration>d)
            `,
      [
            ["PT1S", "PT5S"],
          ]
    );
    expect(() => {
      h.query(
        `
                WITH rd := <cal::relative_duration>'1y'
                SELECT <duration>rd
                `
      );
    }).toThrow(new RegExp("invalid value for scalar type 'std::duration'"));
  });

  it("test_edgeql_dt_realativedelta_02", () => {
    assertQueryResult(
      h,
      `SELECT <str><cal::date_duration>'1 year 2 days'`,
      ["P1Y2D"]
    );
    assertQueryResult(
      h,
      `SELECT <json><cal::date_duration><json>'1 year 2 days'`,
      ["P1Y2D"]
    );
    assertQueryResult(
      h,
      `SELECT <str><cal::date_duration>'0 days'`,
      ["P0D"]
    );
    assertQueryResult(
      h,
      `SELECT <json><cal::date_duration>'0 days'`,
      ["P0D"]
    );
    assertQueryResult(
      h,
      `SELECT <json><cal::date_duration>'5 months -150 days'`,
      ["P5M-150D"]
    );
    assertQueryResult(
      h,
      `
            WITH
                dt := <datetime>'2000-01-01T00:00:00Z',
                rd := <cal::date_duration>'3 years 2 months 14 days'
            SELECT (dt + rd, rd + dt, dt - rd)
            `,
      [
            ["2003-03-15T00:00:00+00:00", "2003-03-15T00:00:00+00:00", "1996-10-18T00:00:00+00:00"],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH
                dt := <cal::local_datetime>'2000-01-01T00:00:00',
                rd := <cal::date_duration>'3 years 2 months 14 days'
            SELECT (dt + rd, rd + dt, dt - rd)
            `,
      [
            ["2003-03-15T00:00:00", "2003-03-15T00:00:00", "1996-10-18T00:00:00"],
          ]
    );
    assertQueryResult(
      h,
      `
            WITH
                d := <cal::local_date>'2000-01-01',
                rd := <cal::date_duration>'3 years 2 months 14 days'
            SELECT (d + rd, rd + d, d - rd)
            `,
      [
            ["2003-03-15", "2003-03-15", "1996-10-18"],
          ]
    );
    assertQueryResult(
      h,
      ` SELECT <json><cal::date_duration>'3y2d' `,
      ["P3Y2D"]
    );
    assertQueryResult(
      h,
      `
            SELECT (
                to_str(
                    <cal::date_duration>'3y' +
                    <cal::date_duration>'1d'
                ),
                to_str(<cal::date_duration>'3y1d', 'YYYY"y"DD"d"'),
            )
            `,
      [
            ["P3Y1D", "0003y01d"],
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT <str>cal::to_date_duration(
                years := 1,
                months := 2,
                days := 3,
            )
            `,
      ["P1Y2M3D"]
    );
    assertQueryResult(
      h,
      `
            WITH
                x := <cal::date_duration>'1y',
                y := <cal::date_duration>'5y',
            SELECT (
                <str>max({x, y}),
                <str>min({x, y}),
            )
            `,
      [
            ["P5Y", "P1Y"],
          ]
    );
    expect(() => {
      h.query(
        `
                    SELECT <str><cal::date_duration>'1s'
                    `
      );
    }).toThrow(new RegExp("invalid input syntax for type std::cal::date_duration: '1s'"));
    expect(() => {
      h.query(
        `
                    SELECT <str><cal::date_duration><json>'1s'
                    `
      );
    }).toThrow(new RegExp("invalid input syntax for type std::cal::date_duration: '1s'"));
  });

  it("test_edgeql_dt_datetime_01", () => {
    assertQueryResult(
      h,
      `SELECT <datetime>'2017-10-10T00:00:00+00' +
                <duration>'24 hours';`,
      ["2017-10-11T00:00:00+00:00"]
    );
    assertQueryResult(
      h,
      `SELECT <duration>'24 hours' +
                <datetime>'2017-10-10 00:00:00+00';`,
      ["2017-10-11T00:00:00+00:00"]
    );
    assertQueryResult(
      h,
      `SELECT <datetime>'2017-10-10T00:00:00+00' -
                <duration>'24 hours';`,
      ["2017-10-09T00:00:00+00:00"]
    );
    assertQueryResult(
      h,
      `SELECT to_str(<duration>'24 hours' + <duration>'24 hours')`,
      ["PT48H"]
    );
    assertQueryResult(
      h,
      `SELECT to_str(<duration>'4 hours' - <duration>'1 hour')`,
      ["PT3H"]
    );
    expect(() => {
      h.query(
        `
                SELECT <duration>'1 hour' - <datetime>'2017-10-10T00:00:00+00';
            `
      );
    }).toThrow(new RegExp("operator '-' cannot be applied.*duration.*datetime"));
  });

  it("test_edgeql_dt_datetime_02", () => {
    assertQueryResult(
      h,
      `SELECT <str><datetime>'2017-10-10T00:00:00+00';`,
      ["2017-10-10T00:00:00+00:00"]
    );
    assertQueryResult(
      h,
      `SELECT <str>(<datetime>'2017-10-10T00:00:00+00' -
                             <duration>'24 hours');
            `,
      ["2017-10-09T00:00:00+00:00"]
    );
  });

  it("test_edgeql_dt_datetime_03", () => {
    assertQueryResult(
      h,
      `SELECT <tuple<str,datetime>>(
                'foo', '2017-10-10T00:00:00+00');
            `,
      [
            ["foo", "2017-10-10T00:00:00+00:00"],
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT (<tuple<str,datetime>>(
                    'foo', '2017-10-10T00:00:00+00')).1 +
                   <duration>'744 hours';
            `,
      ["2017-11-10T00:00:00+00:00"]
    );
  });

  it("test_edgeql_dt_datetime_04", () => {
    assertQueryResult(
      h,
      `SELECT <datetime>'2017-10-11T00:00:00+00' -
                <datetime>'2017-10-10T00:00:00+00';`,
      ["PT24H"]
    );
    assertQueryResult(
      h,
      `SELECT <datetime>'2018-10-10T00:00:00+00' -
                <datetime>'2017-10-10T00:00:00+00';`,
      ["PT8760H"]
    );
    assertQueryResult(
      h,
      `SELECT <datetime>'2017-10-17T01:02:03.004005+00' -
                <datetime>'2017-10-10T00:00:00+00';`,
      ["PT169H2M3.004005S"]
    );
    assertQueryResult(
      h,
      `SELECT <datetime>'2017-10-10T01:02:03.004005-02' -
                <datetime>'2017-10-10T00:00:00+00';`,
      ["PT3H2M3.004005S"]
    );
  });

  it("test_edgeql_dt_duration_01_err", () => {
    expect(() => {
      h.script(
        `SELECT <duration>'7 days';`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::duration: '7 days'"));
  });

  it("test_edgeql_dt_duration_02_err", () => {
    expect(() => {
      h.script(
        `SELECT <duration>'13 months';`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::duration: '13 months'"));
  });

  it("test_edgeql_dt_duration_03_err", () => {
    expect(() => {
      h.script(
        `SELECT <duration>'17 years';`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::duration: '17 years'"));
  });

  it("test_edgeql_dt_duration_04_err", () => {
    expect(() => {
      h.script(
        `SELECT <duration>'100 centuries';`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::duration: '100 centuries'"));
  });

  it("test_edgeql_dt_duration_05_err", () => {
    expect(() => {
      h.script(
        `SELECT <duration>'100 cats';`
      );
    }).toThrow(new RegExp("invalid input syntax for type std::duration: \"100 cats\""));
  });

  it("test_edgeql_dt_duration_06_interval_style", () => {
    assertQueryResult(
      h,
      `SELECT <duration>'-6h51m14.045854s';`,
      ["PT-5H-8M-45.954146S"]
    );
    assertQueryResult(
      h,
      `SELECT <duration>'-6h -51m -14.045854s';`,
      ["PT-6H-51M-14.045854S"]
    );
  });

  it("test_edgeql_dt_duration_07_datetime_range", () => {
    expect(() => {
      h.script(
        `
                SELECT <datetime>'9999-12-31T00:00:00Z' + <duration>'30 hours'
                `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.script(
        `
                SELECT <datetime>'0001-01-01T00:00:00Z' - <duration>'30 hours'
                `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_dt_duration_08_local_datetime_range", () => {
    expect(() => {
      h.script(
        `
                SELECT
                    <cal::local_datetime>'9999-12-31T00:00:00'
                    + <duration>'30 hours'
                `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.script(
        `
                SELECT
                    <cal::local_datetime>'0001-01-01T00:00:00'
                    - <duration>'30 hours'
                `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_dt_duration_09_local_date_range", () => {
    expect(() => {
      h.script(
        `
                SELECT
                    <cal::local_date>'9999-12-31'
                    + <duration>'30 hours'
                `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.script(
        `
                SELECT
                    <cal::local_date>'0001-01-01'
                    - <duration>'30 hours'
                `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_dt_duration_10_datetime_range", () => {
    expect(() => {
      h.script(
        `
                SELECT <datetime>'9999-12-31T00:00:00Z' +
                    <cal::relative_duration>'1 week'
                `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.script(
        `
                SELECT <datetime>'0001-01-01T00:00:00Z' -
                    <cal::relative_duration>'1 week'
                `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_dt_duration_11_local_datetime_range", () => {
    expect(() => {
      h.script(
        `
                SELECT <cal::local_datetime>'9999-12-31T00:00:00' +
                    <cal::relative_duration>'1 week'
                `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.script(
        `
                SELECT <cal::local_datetime>'0001-01-01T00:00:00' -
                    <cal::relative_duration>'1 week'
                `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_dt_duration_12_local_date_range", () => {
    expect(() => {
      h.script(
        `
                SELECT
                    <cal::local_date>'9999-12-31'
                    + <cal::relative_duration>'30 hours'
                `
      );
    }).toThrow(new RegExp("value out of range"));
    expect(() => {
      h.script(
        `
                SELECT
                    <cal::local_date>'0001-01-01'
                    - <cal::relative_duration>'30 hours'
                `
      );
    }).toThrow(new RegExp("value out of range"));
  });

  it("test_edgeql_dt_local_datetime_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <cal::local_datetime>'2017-10-10T13:11' +
                    <duration>'24 hours';
            `,
      ["2017-10-11T13:11:00"]
    );
    assertQueryResult(
      h,
      `
                SELECT <duration>'24 hours' +
                    <cal::local_datetime>'2017-10-10T13:11';
            `,
      ["2017-10-11T13:11:00"]
    );
    assertQueryResult(
      h,
      `
                SELECT <cal::local_datetime>'2017-10-10T13:11' -
                    <duration>'24 hours';
            `,
      ["2017-10-09T13:11:00"]
    );
  });

  it("test_edgeql_dt_local_datetime_02", () => {
    assertQueryResult(
      h,
      `SELECT <cal::local_datetime>'2017-10-11T00:00:00' -
                <cal::local_datetime>'2017-10-10T00:00:00';`,
      ["P1D"]
    );
    assertQueryResult(
      h,
      `SELECT <cal::local_datetime>'2018-10-10T00:00:00' -
                <cal::local_datetime>'2017-10-10T00:00:00';`,
      ["P365D"]
    );
    assertQueryResult(
      h,
      `SELECT <cal::local_datetime>'2017-10-17T01:02:03.004005' -
                <cal::local_datetime>'2017-10-10T00:00:00';`,
      ["P7DT1H2M3.004005S"]
    );
    assertQueryResult(
      h,
      `SELECT <cal::local_datetime>'2017-10-10T01:02:03.004005' -
                <cal::local_datetime>'2017-10-10T00:00:00';`,
      ["PT1H2M3.004005S"]
    );
  });

  it("test_edgeql_dt_local_datetime_03", () => {
    assertQueryResult(
      h,
      `
            with dur := <cal::relative_duration>'1 month'
            select <cal::local_datetime>'2021-01-31T00:00:00' + dur;
            `,
      ["2021-02-28T00:00:00"]
    );
    assertQueryResult(
      h,
      `
            with
                dur := <cal::relative_duration>'1 month',
                date := <cal::local_datetime>'2021-01-31T00:00:00',
            select date + (dur + dur) = (date + dur) + dur;
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
            with
                dur := <cal::relative_duration>'1 month',
                date := <cal::local_datetime>'2021-01-31T00:00:00',
            select date + dur - dur = date;
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
            with
                m1 := <cal::relative_duration>'1 month',
                m11 := <cal::relative_duration>'11 month',
                y1 := <cal::relative_duration>'1 year',
                date := <cal::local_datetime>'2021-01-31T00:00:00',
            select (
                # duration alone
                y1 = m1 + m11,
                # date + duration
                date + y1 = date + m1 + m11,
            );
            `,
      [
            [true, false],
          ]
    );
  });

  it("test_edgeql_dt_local_datetime_04", () => {
    assertQueryResult(
      h,
      `select <cal::local_datetime>'2021-04-30T23:59:59' +
                <cal::relative_duration>'1 hr' +
                <cal::relative_duration>'1 month';`,
      ["2021-06-01T00:59:59"]
    );
    assertQueryResult(
      h,
      `select <cal::local_datetime>'2021-04-30T23:59:59' +
                <cal::relative_duration>'1 month' +
                <cal::relative_duration>'1 hr';`,
      ["2021-05-31T00:59:59"]
    );
    assertQueryResult(
      h,
      `select <cal::local_datetime>'2021-04-30T23:59:59' +
                <cal::relative_duration>'1 hr 1 month';`,
      ["2021-05-31T00:59:59"]
    );
    assertQueryResult(
      h,
      `select <cal::local_datetime>'2021-04-30T23:59:59' +
                <cal::relative_duration>'1 month 1 hr';`,
      ["2021-05-31T00:59:59"]
    );
  });

  it("test_edgeql_dt_local_datetime_05", () => {
    assertQueryResult(
      h,
      `select <cal::local_datetime>'2021-04-30T23:59:59' +
                <cal::relative_duration>'1 day' +
                <cal::relative_duration>'1 month';`,
      ["2021-06-01T23:59:59"]
    );
    assertQueryResult(
      h,
      `select <cal::local_datetime>'2021-04-30T23:59:59' +
                <cal::relative_duration>'1 month' +
                <cal::relative_duration>'1 day';`,
      ["2021-05-31T23:59:59"]
    );
    assertQueryResult(
      h,
      `select <cal::local_datetime>'2021-04-30T23:59:59' +
                <cal::relative_duration>'1 day 1 month';`,
      ["2021-05-31T23:59:59"]
    );
    assertQueryResult(
      h,
      `select <cal::local_datetime>'2021-04-30T23:59:59' +
                <cal::relative_duration>'1 month 1 day';`,
      ["2021-05-31T23:59:59"]
    );
  });

  it("test_edgeql_dt_local_date_01", () => {
    assertQueryResult(
      h,
      `SELECT
                    <cal::local_date>'2017-10-10' + <duration>'24 hours';
            `,
      ["2017-10-11T00:00:00"]
    );
    assertQueryResult(
      h,
      `SELECT
                <duration>'24 hours' + <cal::local_date>'2017-10-10';
            `,
      ["2017-10-11T00:00:00"]
    );
    assertQueryResult(
      h,
      `SELECT <cal::local_date>'2017-10-10' - <duration>'24 hours';
            `,
      ["2017-10-09T00:00:00"]
    );
  });

  it("test_edgeql_dt_local_date_02", () => {
    assertQueryResult(
      h,
      `select <str>(
                    <cal::local_date>'2017-10-11' -
                    <cal::local_date>'2017-10-10');`,
      ["P1D"]
    );
    assertQueryResult(
      h,
      `select <str>(
                    <cal::local_date>'2018-10-10' -
                    <cal::local_date>'2017-10-10');`,
      ["P365D"]
    );
  });

  it("test_edgeql_dt_local_date_03", () => {
    assertQueryResult(
      h,
      `
            with dur := <cal::date_duration>'1 month'
            select <cal::local_date>'2021-01-31' + dur;
            `,
      ["2021-02-28"]
    );
    assertQueryResult(
      h,
      `
            with
                dur := <cal::date_duration>'1 month',
                date := <cal::local_date>'2021-01-31',
            select date + (dur + dur) = (date + dur) + dur;
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
            with
                dur := <cal::date_duration>'1 month',
                date := <cal::local_date>'2021-01-31',
            select date + dur - dur = date;
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
            with
                m1 := <cal::date_duration>'1 month',
                m11 := <cal::date_duration>'11 month',
                y1 := <cal::date_duration>'1 year',
                date := <cal::local_date>'2021-01-31',
            select (
                # duration alone
                y1 = m1 + m11,
                # date + duration
                date + y1 = date + m1 + m11,
            );
            `,
      [
            [true, false],
          ]
    );
  });

  it("test_edgeql_dt_local_date_04", () => {
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::relative_duration>'1 hr' +
                <cal::relative_duration>'1 month';`,
      ["2021-05-30T01:00:00"]
    );
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::relative_duration>'1 month' +
                <cal::relative_duration>'1 hr';`,
      ["2021-05-30T01:00:00"]
    );
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::relative_duration>'1 hr 1 month';`,
      ["2021-05-30T01:00:00"]
    );
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::relative_duration>'1 month 1 hr';`,
      ["2021-05-30T01:00:00"]
    );
  });

  it("test_edgeql_dt_local_date_05", () => {
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::date_duration>'1 day' +
                <cal::date_duration>'1 month';`,
      ["2021-06-01"]
    );
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::date_duration>'1 month' +
                <cal::date_duration>'1 day';`,
      ["2021-05-31"]
    );
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::date_duration>'1 day 1 month';`,
      ["2021-05-31"]
    );
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::date_duration>'1 month 1 day';`,
      ["2021-05-31"]
    );
  });

  it("test_edgeql_dt_local_date_06", () => {
    assertQueryResult(
      h,
      `select <cal::local_date>'2021-04-30' +
                <cal::relative_duration>'20 hr' +
                <cal::relative_duration>'20 hr';`,
      ["2021-05-01T16:00:00"]
    );
  });

  it("test_edgeql_dt_local_time_01", () => {
    assertQueryResult(
      h,
      `select <cal::local_time>'10:01:01' +
                <cal::relative_duration>'24 hours';`,
      ["10:01:01"]
    );
    assertQueryResult(
      h,
      `select <cal::relative_duration>'1 hour' +
                <cal::local_time>'10:01:01';`,
      ["11:01:01"]
    );
    assertQueryResult(
      h,
      `select <cal::local_time>'10:01:01' -
                <cal::relative_duration>'1 hour';`,
      ["09:01:01"]
    );
    assertQueryResult(
      h,
      `select <cal::local_time>'01:02:03.004005' -
                <cal::local_time>'00:00:00';`,
      ["PT1H2M3.004005S"]
    );
    assertQueryResult(
      h,
      `select <cal::local_time>'01:02:03.004005' -
                <cal::local_time>'10:00:00';`,
      ["PT-8H-57M-56.995995S"]
    );
  });

  it("test_edgeql_dt_sequence_01", () => {
    h.script(
      `
                INSERT Obj;
                INSERT Obj;
                INSERT Obj2;
            `
    );
    try {
      assertQueryResult(
        h,
        `SELECT Obj { seq_prop } ORDER BY Obj.seq_prop;`,
        [
              {
                "seq_prop": 1,
              },
              {
                "seq_prop": 2,
              },
            ]
      );
    } catch (_err) {
      if (is_repeat) {
        assertQueryResult(
          h,
          `SELECT Obj { seq_prop } ORDER BY Obj.seq_prop;`,
          [
                {
                  "seq_prop": 3,
                },
                {
                  "seq_prop": 4,
                },
              ]
        );
      } else {
        throw _err;
      }
    }
    try {
      assertQueryResult(
        h,
        `SELECT Obj2 { seq_prop };`,
        [
              {
                "seq_prop": 1,
              },
            ]
      );
    } catch (_err) {
      if (is_repeat) {
        assertQueryResult(
          h,
          `SELECT Obj2 { seq_prop };`,
          [
                {
                  "seq_prop": 2,
                },
              ]
        );
      } else {
        throw _err;
      }
    }
  });

  it("test_edgeql_dt_enum_01", () => {
    assertQueryResult(
      h,
      `
                SELECT <enum_t>'foo' = <enum_t>'bar'
            `,
      [false]
    );
    assertQueryResult(
      h,
      `
                SELECT <enum_t>'foo' = <enum_t>'foo'
            `,
      [true]
    );
    assertQueryResult(
      h,
      `
                SELECT <enum_t>'foo' < <enum_t>'bar'
            `,
      [true]
    );
    expect(() => {
      h.script(
        `SELECT <enum_t>"bad";`
      );
    }).toThrow(new RegExp("invalid input value for enum 'default::enum_t': \"bad\""));
  });

  it("test_edgeql_dt_bigint_01", () => {
    expect(() => {
      h.script(
        `
                    SELECT <bigint>'NaN'
                `
      );
    }).toThrow(new RegExp("invalid input syntax for type std::bigint"));
  });

  it("test_edgeql_dt_bigint_02", () => {
    expect(() => {
      h.script(
        `
                    SELECT <bigint><float64>'NaN'
                `
      );
    }).toThrow(new RegExp("invalid value for scalar type 'std::bigint'"));
  });

  it("test_edgeql_dt_decimal_01", () => {
    expect(() => {
      h.script(
        `
                    SELECT <decimal><float64>'NaN'
                `
      );
    }).toThrow(new RegExp("invalid value for std::decimal"));
  });

  it("test_edgeql_dt_decimal_02", () => {
    expect(() => {
      h.script(
        `
                    SELECT <decimal><float64>'Infinity'
                `
      );
    }).toThrow(new RegExp("invalid value for std::decimal"));
  });

  it("test_edgeql_dt_decimal_03", () => {
    expect(() => {
      h.script(
        `
                    SELECT <decimal><float64>'-Infinity'
                `
      );
    }).toThrow(new RegExp("invalid value for std::decimal"));
  });

  it("test_edgeql_dt_decimal_04", () => {
    expect(() => {
      h.script(
        `
                    SELECT <decimal>(<float64>'Infinity' / <float64>'Infinity')
                `
      );
    }).toThrow(new RegExp("invalid value for std::decimal"));
  });

  it("test_edgeql_dt_decimal_05", () => {
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF 1e100n).name`,
      ["std::bigint"]
    );
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF 1.0e100n).name`,
      ["std::decimal"]
    );
    assertQueryResult(
      h,
      `SELECT 1e100n`,
      [10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000]
    );
    assertQueryResult(
      h,
      `SELECT 1.0e100n`,
      [1e+100]
    );
  });

  it("test_edgeql_named_tuple_typing_01", () => {
    h.script(
      `
            CREATE TYPE Foo { CREATE PROPERTY x -> tuple<a: int64, b: int64> };
        `
    );
    expect(() => {
      h.script(
        `INSERT Foo { x := (b := 1, a := 2) };`
      );
    }).toThrow(new RegExp("invalid target for property 'x' of object type 'default::Foo': 'tuple<b: std::int64, a: std::int64>' \\(expecting 'tuple<a: std::int64, b: std::int64>'"));
  });

  it("test_edgeql_named_tuple_typing_02", () => {
    assertQueryResult(
      h,
      `SELECT (b := 1, a := 2) UNION (a := 3, b := 4)`,
      unorderedBag([
            [1, 2],
            [3, 4],
          ])
    );
  });

  it("test_edgeql_named_tuple_typing_03", () => {
    expect(() => {
      h.script(
        `SELECT (a := 1, a := 2);`
      );
    }).toThrow(new RegExp("named tuple has duplicate field 'a'"));
    expect(() => {
      h.script(
        `
                CREATE TYPE Foo {
                    CREATE PROPERTY x -> tuple<a: int64, a: str>;
                };
            `
      );
    }).toThrow(new RegExp("named tuple has duplicate field 'a'"));
  });

  it("test_edgeql_memory_01", () => {
    expect(() => {
      h.script(
        `SELECT <cfg::memory>-1`
      );
    }).toThrow(new RegExp("invalid value for scalar type 'cfg::memory'"));
    expect(h.query("SELECT <int64><cfg::memory>'1KiB'")).toEqual(1024);
    expect(h.query("SELECT <int64><cfg::memory>1025")).toEqual(1025);
    expect(h.query("SELECT <str><cfg::memory>1025")).toEqual("1025B");
    expect(h.query("SELECT <str><cfg::memory>2272753910888172544")).toEqual("2219486241101731KiB");
    expect(h.query("SELECT <str><cfg::memory>0")).toEqual("0B");
    expect(h.query("SELECT <str><cfg::memory>'0B'")).toEqual("0B");
  });

  it("test_edgeql_staeval_duration_01", () => {
    let v = h.query("\n            SELECT <array<duration>><array<str>>$0\n            ");
    let vs = h.query("\n            SELECT <array<str>><array<duration>><array<str>>$0\n            ");
    for (const [text, value, svalue] of (zip([
  " 100   ",
  "123",
  "-123",
  "  20 mins 1hr ",
  "  20 mins -1hr ",
  "  20us  1h    20   ",
  "  -20us  1h    20   ",
  "  -20US  1H    20   ",
  "1 hour 20 minutes 30 seconds 40 milliseconds 50 microseconds",
  "1 hour 20 minutes +30seconds 40 milliseconds -50microseconds",
  "1 houR  20 minutes 30SECOND 40 milliseconds 50 us",
  "  20 us 1H 20 minutes ",
  "-1h",
  "100h",
  "   12:12:12.2131   ",
  "-12:12:12.21313",
  "-12:12:12.213134",
  "-12:12:12.2131341",
  "-12:12:12.2131341111111",
  "-12:12:12.2131315111111",
  "-12:12:12.2131316111111",
  "-12:12:12.2131314511111",
  "-0:12:12.2131",
  "12:12",
  "-12:12",
  "-12:1:1",
  "+12:1:1",
  "-12:1:1.1234",
  "1211:59:59.9999",
  "-12:",
  "0",
  "00:00:00",
  "00:00:10.9",
  "00:00:10.09",
  "00:00:10.009",
  "00:00:10.0009",
], v, vs) as any)) {
      let ref_value = Number((value / timedelta()));
      try {
        let parsed = statypes.Duration(text);
      } catch (_err) {
        throw AssertionError(`could not parse a valid std::duration: ${text}`);
      }
      expect(ref_value).toEqual(parsed.to_microseconds());
      expect(svalue).toEqual(parsed.to_iso8601());
      expect(to_microseconds()).toEqual(parsed.to_microseconds());
      expect(to_microseconds()).toEqual(parsed.to_microseconds());
    }
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("blah");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("!");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("-");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("  20 us 1H 20 30 minutes ");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("   12:12:121.2131   ");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("   12:60:21.2131   ");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("  20us 20   1h       ");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("  20us $ 20   1h       ");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <duration><str>$0`
      );
    }).toThrow(new RegExp("(invalid input syntax)|(interval field value out)"));
    expect(() => {
      statypes.Duration("1 houR  20 minutes 30SECOND 40 milliseconds 50 uss");
    }).toThrow();
  });

  it("test_edgeql_staeval_memory_01", () => {
    let v = h.query("\n            SELECT  <array<int64>><array<cfg::memory>><array<str>>$0\n            ");
    let vs = h.query("\n            SELECT <array<str>><array<cfg::memory>><array<str>>$0\n            ");
    for (const [text, ref_value, svalue] of (zip([
  "0",
  "0B",
  "123KiB",
  "11MiB",
  "0PiB",
  "1PiB",
  "111111GiB",
  "123B",
  "2219486241101731KiB",
], v, vs) as any)) {
      try {
        let parsed = statypes.ConfigMemory(text);
      } catch (_err) {
        throw AssertionError(`could not parse a valid cfg::memory: ${text}`);
      }
      expect(ref_value).toEqual(parsed.to_nbytes());
      expect(svalue).toEqual(parsed.to_str());
      expect(to_nbytes()).toEqual(parsed.to_nbytes());
    }
    expect(() => {
      h.query(
        `SELECT <int64><cfg::memory><str>$0`
      );
    }).toThrow(new RegExp("(unsupported memory size)|(unable to parse memory)"));
    expect(() => {
      statypes.ConfigMemory("12kB");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <int64><cfg::memory><str>$0`
      );
    }).toThrow(new RegExp("(unsupported memory size)|(unable to parse memory)"));
    expect(() => {
      statypes.ConfigMemory("22KB");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <int64><cfg::memory><str>$0`
      );
    }).toThrow(new RegExp("(unsupported memory size)|(unable to parse memory)"));
    expect(() => {
      statypes.ConfigMemory("-1B");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <int64><cfg::memory><str>$0`
      );
    }).toThrow(new RegExp("(unsupported memory size)|(unable to parse memory)"));
    expect(() => {
      statypes.ConfigMemory("-1");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <int64><cfg::memory><str>$0`
      );
    }).toThrow(new RegExp("(unsupported memory size)|(unable to parse memory)"));
    expect(() => {
      statypes.ConfigMemory("+1");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <int64><cfg::memory><str>$0`
      );
    }).toThrow(new RegExp("(unsupported memory size)|(unable to parse memory)"));
    expect(() => {
      statypes.ConfigMemory("+12TiB");
    }).toThrow();
    expect(() => {
      h.query(
        `SELECT <int64><cfg::memory><str>$0`
      );
    }).toThrow(new RegExp("(unsupported memory size)|(unable to parse memory)"));
    expect(() => {
      statypes.ConfigMemory("123TIB");
    }).toThrow();
  });

  it("test_edgeql_as_cache_key", () => {
    let cache = {[make_key()]: true};
    expect(cache as any).toContain(make_key());
  });
});
