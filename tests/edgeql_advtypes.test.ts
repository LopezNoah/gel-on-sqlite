import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLAdvancedTypes", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "advtypes",
      dbFile: "./tests/.artifacts/advtypes.sqlite",
      resetDbFile: true
    });
  });

  function _setup_basic_data(): void {
    h.script(
      `
            INSERT CBa {ba := 'cba0'};
            INSERT CBa {ba := 'cba1'};
            INSERT CBb {bb := 0};
            INSERT CBb {bb := 1};
            INSERT CBc {bc := 0.5};
            INSERT CBc {bc := 1.5};
            INSERT CBaBb {ba := 'cba2', bb := 2};
            INSERT CBaBb {ba := 'cba3', bb := 3};
            INSERT CBaBc {ba := 'cba4', bc := 4.5};
            INSERT CBaBc {ba := 'cba5', bc := 5.5};
            INSERT CBbBc {bb := 6, bc := 6.5};
            INSERT CBbBc {bb := 7, bc := 7.5};
            INSERT CBaBbBc {ba := 'cba8', bb := 8, bc := 8.5};
            INSERT CBaBbBc {ba := 'cba9', bb := 9, bc := 9.5};
            INSERT XBa {ba := 'xba0'};
            INSERT XBa {ba := 'xba1'};
            INSERT XBb {bb := 90};
            INSERT XBb {bb := 91};
            INSERT XBc {bc := 90.5};
            INSERT XBc {bc := 90.5};
        `
    );
  }

  it("test_edgeql_advtypes_overlapping_union", () => {
    h.script(
      `
            INSERT V {name:= 'v0', s := 's0', t := 't0', u := 'u0'};

            INSERT Z {
                name := 'z0',
                stw0 := (
                    SELECT V FILTER .name = 'v0'
                ),
            };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT Z {stw0: {name}} FILTER .name = 'z0';
            `,
      [
            {
              "stw0": [
                {
                  "name": "v0",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_advtypes_overlapping_link_union", () => {
    h.script(
      `
            INSERT A { name := 'a1' };
            INSERT V {
                name:= 'v1',
                s := 's1',
                t := 't1',
                u := 'u1',
                l_a := (SELECT A FILTER .name = 'a1'),
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT (DISTINCT (SELECT S UNION T)) {
                cla := count(.l_a)
            }
            `,
      [
            {
              "cla": 1,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_basic_union_01", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT (DISTINCT {Ba, Bb}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            } ORDER BY
                .ba EMPTY LAST THEN
                .bb EMPTY LAST THEN
                .bc EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_basic_union_02", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT {CBaBb, CBbBc} {
                tn := .__type__.name,
                bb,
            } ORDER BY .bb;
            `,
      [
            {
              "tn": "default::CBaBb",
              "bb": 2,
            },
            {
              "tn": "default::CBaBb",
              "bb": 3,
            },
            {
              "tn": "default::CBbBc",
              "bb": 6,
            },
            {
              "tn": "default::CBbBc",
              "bb": 7,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_basic_union_03", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT {CBaBb, CBaBbBc} {
                tn := .__type__.name,
                ba,
                bb,
            } ORDER BY .bb;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_basic_intersection_01", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS Bb].__type__.name;
            `,
      unorderedSet(["default::CBaBb", "default::CBaBbBc"])
    );
  });

  it("test_edgeql_advtypes_basic_intersection_02", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS Bb].ba;
            `,
      unorderedSet(["cba2", "cba3", "cba8", "cba9"])
    );
  });

  it("test_edgeql_advtypes_basic_intersection_03", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS Bb].bb;
            `,
      unorderedSet([2, 3, 8, 9])
    );
  });

  it("test_edgeql_advtypes_basic_intersection_04", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS Bb][IS Bc] {
                tn := .__type__.name,
                ba,
                bb,
                bc,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_01", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS Bb | Bc] {
                tn := .__type__.name,
                ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_02", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS Bb & Bc] {
                tn := .__type__.name,
                ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_03", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS CBa | Bb & Bc] {
                tn := .__type__.name,
                ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_04", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT {CBa, Ba[IS Bb & Bc]} {
                tn := .__type__.name,
                ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_05", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS CBaBc | Bb][is Bc] {
                tn := .__type__.name,
                ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_06", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba[IS (CBaBc | Bb) & Bc] {
                tn := .__type__.name,
                ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_07", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[IS (Ba | Bb)][IS (Ba | Bc)] {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY
                .ba EMPTY LAST THEN
                .bb EMPTY LAST THEN
                .bc EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_08", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[IS (Ba | Bb) & (Ba | Bc)] {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY
                .ba EMPTY LAST THEN
                .bb EMPTY LAST THEN
                .bc EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_09", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[IS (Ba | Bb) | (Ba | Bc)] {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY
                .ba EMPTY LAST THEN
                .bb EMPTY LAST THEN
                .bc EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_10", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[IS (Ba & Bb) | (Ba & Bc)] {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY
                .ba EMPTY LAST THEN
                .bb EMPTY LAST THEN
                .bc EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_11", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT {Object[IS Ba & Bb], Object[IS Ba & Bc]} {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            ORDER BY
                .ba EMPTY LAST THEN
                .bb EMPTY LAST THEN
                .bc EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_12", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT {Ba, XBa}[is Bb | XBa] {
                tn := .__type__.name,
                ba,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
            },
            {
              "tn": "default::XBa",
              "ba": "xba0",
            },
            {
              "tn": "default::XBa",
              "ba": "xba1",
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_13", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT {Ba[is Bb], XBa} {
                tn := .__type__.name,
                ba,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
            },
            {
              "tn": "default::XBa",
              "ba": "xba0",
            },
            {
              "tn": "default::XBa",
              "ba": "xba1",
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_14", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[is (Ba & Bb) | XBa | XBb] {
                tn := .__type__.name,
                [is Ba | XBa].ba,
                [is Bb | XBb].bb,
            }
            ORDER BY
                .ba EMPTY LAST THEN
                .bb EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
            },
            {
              "tn": "default::XBa",
              "ba": "xba0",
              "bb": null,
            },
            {
              "tn": "default::XBa",
              "ba": "xba1",
              "bb": null,
            },
            {
              "tn": "default::XBb",
              "ba": null,
              "bb": 90,
            },
            {
              "tn": "default::XBb",
              "ba": null,
              "bb": 91,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_15", () => {
    h.script(
      `
            INSERT A { name := 'a1' };
            INSERT A { name := 'a2' };
            INSERT A { name := 'a3' };
            INSERT S { name := 'sss', s := 's', l_a := (select A) };
            INSERT T { name := 'ttt', t := 't', l_a := (select A) };
            INSERT V {
                name := 'vvv',
                s := 'u',
                t := 'u',
                u := 'u',
                l_a := (select A)
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT A.<l_a[is S | T] { name } ORDER BY .name;
            `,
      [
            {
              "name": "sss",
            },
            {
              "name": "ttt",
            },
            {
              "name": "vvv",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT A.<l_a[is S & T] { name } ORDER BY .name;
            `,
      [
            {
              "name": "vvv",
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_16", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT {CBa, Ba[is Bb]} {
                tn := .__type__.name,
                [IS Ba].ba,
            }
            ORDER BY .ba EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT {CBa, Bb[is Ba]} {
                tn := .__type__.name,
                [IS Ba].ba,
            }
            ORDER BY .ba EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT {Bb[is Ba], Bb[is Ba & Bc | CBaBb]} {
                tn := .__type__.name,
                [IS Ba].ba,
            }
            ORDER BY .ba EMPTY LAST;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_intersection_17", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            WITH x := Ba
            SELECT x[IS Bb]
            {
                tn := .__type__.name,
                ba,
                bb,
                [IS Bc].bc,
            }
            `,
      unorderedBag([
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ])
    );
    assertQueryResult(
      h,
      `
            WITH x := Ba
            SELECT x[IS Bb & Bc]
            {
                tn := .__type__.name,
                ba,
                bb,
                bc,
            }
            `,
      unorderedBag([
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ])
    );
    assertQueryResult(
      h,
      `
            WITH x := {Ba, Bc}
            SELECT x[IS Bb]
            {
                tn := .__type__.name,
                [IS Ba].ba,
                bb,
                [IS Bc].bc,
            }
            `,
      unorderedBag([
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ])
    );
    assertQueryResult(
      h,
      `
            WITH x := Ba
            SELECT x[IS Bb].ba
            `,
      unorderedBag(["cba2", "cba3", "cba8", "cba9"])
    );
    assertQueryResult(
      h,
      `
            WITH x := (SELECT Bb FILTER .bb % 2 = 0)
            SELECT x[IS Ba]
            {
                tn := .__type__.name,
                ba,
                bb,
                [IS Bc].bc,
            }
            `,
      unorderedBag([
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
          ])
    );
  });

  it("test_edgeql_advtypes_complex_intersection_18", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            WITH x := Ba[IS Bb]
            SELECT x[IS Bc]
            {
                tn := .__type__.name,
                ba,
                bb,
                [IS Bc].bc,
            }
            `,
      unorderedBag([
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ])
    );
    assertQueryResult(
      h,
      `
            WITH x := Ba[IS Bb | Bc]
            SELECT x[IS Bb & Bc]
            {
                tn := .__type__.name,
                ba,
                bb,
                bc,
            }
            `,
      unorderedBag([
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ])
    );
    assertQueryResult(
      h,
      `
            WITH x := Object[IS Ba]
            SELECT x[IS Bb]
            {
                tn := .__type__.name,
                ba,
                bb,
                [IS Bc].bc,
            }
            `,
      unorderedBag([
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ])
    );
    assertQueryResult(
      h,
      `
            WITH x := Ba[IS Bb]
            SELECT x[IS Bc].ba
            `,
      unorderedBag(["cba8", "cba9"])
    );
  });

  it("test_edgeql_advtypes_complex_polymorphism_01", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Ba {
                tn := .__type__.name,
                ba,
                [is Bb & Bc].bb,
                [is (CBaBc | Bb) & Bc].bc,
            }
            ORDER BY .ba;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_polymorphism_02", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Bb {
                tn := .__type__.name,
                bb,
                ua := [IS Ba | Bc].bb,
                ia := [IS Ba & Bc].bb,
            }
            ORDER BY .bb;
            `,
      [
            {
              "tn": "default::CBb",
              "bb": 0,
              "ua": null,
              "ia": null,
            },
            {
              "tn": "default::CBb",
              "bb": 1,
              "ua": null,
              "ia": null,
            },
            {
              "tn": "default::CBaBb",
              "bb": 2,
              "ua": 2,
              "ia": null,
            },
            {
              "tn": "default::CBaBb",
              "bb": 3,
              "ua": 3,
              "ia": null,
            },
            {
              "tn": "default::CBbBc",
              "bb": 6,
              "ua": 6,
              "ia": null,
            },
            {
              "tn": "default::CBbBc",
              "bb": 7,
              "ua": 7,
              "ia": null,
            },
            {
              "tn": "default::CBaBbBc",
              "bb": 8,
              "ua": 8,
              "ia": 8,
            },
            {
              "tn": "default::CBaBbBc",
              "bb": 9,
              "ua": 9,
              "ia": 9,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_type_checking_01", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[IS Ba | Bb | Bc] {
                tn := .__type__.name,
                a := Object IS Ba,
                b := Object IS Bb,
                c := Object IS Bc,
            }
            ORDER BY .tn;
            `,
      [
            {
              "tn": "default::CBa",
              "a": true,
              "b": false,
              "c": false,
            },
            {
              "tn": "default::CBa",
              "a": true,
              "b": false,
              "c": false,
            },
            {
              "tn": "default::CBaBb",
              "a": true,
              "b": true,
              "c": false,
            },
            {
              "tn": "default::CBaBb",
              "a": true,
              "b": true,
              "c": false,
            },
            {
              "tn": "default::CBaBbBc",
              "a": true,
              "b": true,
              "c": true,
            },
            {
              "tn": "default::CBaBbBc",
              "a": true,
              "b": true,
              "c": true,
            },
            {
              "tn": "default::CBaBc",
              "a": true,
              "b": false,
              "c": true,
            },
            {
              "tn": "default::CBaBc",
              "a": true,
              "b": false,
              "c": true,
            },
            {
              "tn": "default::CBb",
              "a": false,
              "b": true,
              "c": false,
            },
            {
              "tn": "default::CBb",
              "a": false,
              "b": true,
              "c": false,
            },
            {
              "tn": "default::CBbBc",
              "a": false,
              "b": true,
              "c": true,
            },
            {
              "tn": "default::CBbBc",
              "a": false,
              "b": true,
              "c": true,
            },
            {
              "tn": "default::CBc",
              "a": false,
              "b": false,
              "c": true,
            },
            {
              "tn": "default::CBc",
              "a": false,
              "b": false,
              "c": true,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_type_checking_02", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[IS Ba | Bb | Bc] {
                tn := .__type__.name,
                ab := Object IS (Ba | Bb),
                ac := Object IS (Ba | Bc),
                bc := Object IS (Bb | Bc),
            }
            ORDER BY .tn;
            `,
      [
            {
              "tn": "default::CBa",
              "ab": true,
              "ac": true,
              "bc": false,
            },
            {
              "tn": "default::CBa",
              "ab": true,
              "ac": true,
              "bc": false,
            },
            {
              "tn": "default::CBaBb",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBaBb",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBaBbBc",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBaBbBc",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBaBc",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBaBc",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBb",
              "ab": true,
              "ac": false,
              "bc": true,
            },
            {
              "tn": "default::CBb",
              "ab": true,
              "ac": false,
              "bc": true,
            },
            {
              "tn": "default::CBbBc",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBbBc",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBc",
              "ab": false,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBc",
              "ab": false,
              "ac": true,
              "bc": true,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_type_checking_03", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[IS Ba | Bb | Bc] {
                tn := .__type__.name,
                ab := Object IS (Ba & Bb),
                ac := Object IS (Ba & Bc),
                bc := Object IS (Bb & Bc),
            }
            ORDER BY .tn;
            `,
      [
            {
              "tn": "default::CBa",
              "ab": false,
              "ac": false,
              "bc": false,
            },
            {
              "tn": "default::CBa",
              "ab": false,
              "ac": false,
              "bc": false,
            },
            {
              "tn": "default::CBaBb",
              "ab": true,
              "ac": false,
              "bc": false,
            },
            {
              "tn": "default::CBaBb",
              "ab": true,
              "ac": false,
              "bc": false,
            },
            {
              "tn": "default::CBaBbBc",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBaBbBc",
              "ab": true,
              "ac": true,
              "bc": true,
            },
            {
              "tn": "default::CBaBc",
              "ab": false,
              "ac": true,
              "bc": false,
            },
            {
              "tn": "default::CBaBc",
              "ab": false,
              "ac": true,
              "bc": false,
            },
            {
              "tn": "default::CBb",
              "ab": false,
              "ac": false,
              "bc": false,
            },
            {
              "tn": "default::CBb",
              "ab": false,
              "ac": false,
              "bc": false,
            },
            {
              "tn": "default::CBbBc",
              "ab": false,
              "ac": false,
              "bc": true,
            },
            {
              "tn": "default::CBbBc",
              "ab": false,
              "ac": false,
              "bc": true,
            },
            {
              "tn": "default::CBc",
              "ab": false,
              "ac": false,
              "bc": false,
            },
            {
              "tn": "default::CBc",
              "ab": false,
              "ac": false,
              "bc": false,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_complex_type_checking_04", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            SELECT Object[IS Ba | Bb | Bc] {
                tn := .__type__.name,
                u := Object IS (Ba | Bb | Bc),
                i := Object IS (Ba & Bb & Bc),
            }
            ORDER BY .tn;
            `,
      [
            {
              "tn": "default::CBa",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBa",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBaBb",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBaBb",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBaBbBc",
              "u": true,
              "i": true,
            },
            {
              "tn": "default::CBaBbBc",
              "u": true,
              "i": true,
            },
            {
              "tn": "default::CBaBc",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBaBc",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBb",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBb",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBbBc",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBbBc",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBc",
              "u": true,
              "i": false,
            },
            {
              "tn": "default::CBc",
              "u": true,
              "i": false,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_union_narrowing_supertype", () => {
    h.script(
      `
            INSERT S { name := 'sss', s := 'sss' };
            INSERT T { name := 'ttt', t := 'ttt' };
            INSERT W { name := 'www' };
            INSERT Z {
                name := 'zzz',
                stw0 := {S, T, W},
            };
        `
    );
    assertQueryResult(
      h,
      `
            WITH My_Z := (SELECT Z FILTER .name = 'zzz')
            SELECT _ := My_Z.stw0[IS R].name
            ORDER BY _
            `,
      ["sss", "ttt"]
    );
  });

  it("test_edgeql_advtypes_union_narrowing_subtype", () => {
    h.script(
      `
            INSERT S { name := 'sss', s := 'sss' };
            INSERT T { name := 'ttt', t := 'ttt' };
            INSERT W { name := 'www' };
            INSERT X { name := 'xxx', u := 'xxx_uuu' };
            INSERT Z {
                name := 'zzz',
                stw0 := {S, T, W},
            };
        `
    );
    assertQueryResult(
      h,
      `
            WITH My_Z := (SELECT Z FILTER .name = 'zzz')
            SELECT _ := My_Z.stw0[IS X].name
            ORDER BY _
            `,
      ["xxx"]
    );
  });

  it("test_edgeql_advtypes_union_opaque_narrowing_subtype", () => {
    h.script(
      `
            INSERT W { name := 'www' };
            INSERT X {
                name := 'xxx',
                u := 'xxx_uuu',
                w := (SELECT DETACHED W LIMIT 1),
            };
            INSERT W {
                name := 'www-2',
                w := (SELECT (DETACHED W) FILTER .name = 'www'),
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT W {
                w_of := .<w[IS X] {
                    name
                }
            }
            FILTER .name = 'www'
            `,
      [
            {
              "w_of": [
                {
                  "name": "xxx",
                },
              ],
            },
          ]
    );
    assertQueryResult(
      h,
      `
            SELECT W {
                w_of := .<w[IS U] {
                    u
                }
            }
            FILTER .name = 'www'
            `,
      [
            {
              "w_of": [
                {
                  "u": "xxx_uuu",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_advtypes_union_opaque_narrowing_nop", () => {
    h.script(
      `
            INSERT A { name := 'aaa' };
            INSERT S { name := 'sss', s := 'sss', l_a := A };
        `
    );
    assertQueryResult(
      h,
      `SELECT A.<l_a[IS R].name`,
      ["sss"]
    );
  });

  it("test_edgeql_advtypes_intersection_with_comp", () => {
    h.script(
      `
            INSERT A { name := 'aaa' };
        `
    );
    assertQueryResult(
      h,
      `
            WITH Rc := R
            SELECT Rc[IS A].name
            `,
      ["aaa"]
    );
  });

  it("test_edgeql_advtypes_intersection_alias", () => {
    h.script(
      `
            INSERT S { name := 'aaa', s := '' };
            INSERT Z { name := 'lol', stw0 := S };
        `
    );
    assertQueryResult(
      h,
      `
            WITH X := Z.stw0
            SELECT X { name }
            `,
      [
            {
              "name": "aaa",
            },
          ]
    );
  });

  it("test_edgeql_advtypes_intersection_semijoin_01", () => {
    h.script(
      `
            insert V {
                name := "x", s := "!", t := "!", u := '...',
                l_a := (insert A { name := "test" })
            };
        `
    );
    assertQueryResult(
      h,
      `
            select S[is T].l_a { name }
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
            select S[is T] { l_a: {name} }
            `,
      [
            {
              "l_a": [
                {
                  "name": "test",
                },
              ],
            },
          ]
    );
  });

  it("test_edgeql_advtypes_update_complex_type_01", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            with
                temp := (
                    update Ba[is Bb] set {
                        ba := .ba ++ '!',
                        bb := .bb + 1,
                    }
                )
            select temp {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2!",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3!",
              "bb": 4,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 9,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 10,
              "bc": 9.5,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2!",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3!",
              "bb": 4,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 9,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 10,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_update_complex_type_02", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            with
                temp := (
                    update Ba[is Bb][is Bc] set {
                        ba := .ba ++ '!',
                        bb := .bb + 1,
                        bc := .bc + 0.1,
                    }
                )
            select temp {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 9,
              "bc": 8.6,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 10,
              "bc": 9.6,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 9,
              "bc": 8.6,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 10,
              "bc": 9.6,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_update_complex_type_03", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            with
                temp := (
                    update Ba[is Bb | Bc] set {
                        ba := .ba ++ '!',
                    }
                )
            select temp {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2!",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3!",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4!",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5!",
              "bb": null,
              "bc": 5.5,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2!",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3!",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4!",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5!",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_update_complex_type_04", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            with
                temp := (
                    update Ba[is Bb & Bc] set {
                        ba := .ba ++ '!',
                        bb := .bb + 1,
                        bc := .bc + 0.1,
                    }
                )
            select temp {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 9,
              "bc": 8.6,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 10,
              "bc": 9.6,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 9,
              "bc": 8.6,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 10,
              "bc": 9.6,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_update_complex_type_05", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            with
                temp := (
                    update Ba[IS CBa | Bb & Bc] set {
                        ba := .ba ++ '!',
                    }
                )
            select temp {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0!",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1!",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0!",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1!",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_update_complex_type_06", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            with
                temp := (
                    update {CBa, Ba[IS Bb & Bc]} set {
                        ba := .ba ++ '!',
                    }
                )
            select temp {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0!",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1!",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0!",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1!",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_update_complex_type_07", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            with
                temp := (
                    update Object[IS (Ba & Bb) | (Ba & Bc)] set {
                        ba := .ba ++ '!',
                    }
                )
            select temp {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2!",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3!",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4!",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5!",
              "bb": null,
              "bc": 5.5,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2!",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3!",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4!",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5!",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_update_complex_type_08", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            with
                temp := (
                    update {Object[IS Ba & Bb], Object[IS Ba & Bc]} set {
                        ba := .ba ++ '!',
                    }
                )
            select temp {
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2!",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3!",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4!",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5!",
              "bb": null,
              "bc": 5.5,
            },
          ]
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2!",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3!",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8!",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9!",
              "bb": 9,
              "bc": 9.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4!",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5!",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_delete_complex_type_01", () => {
    _setup_basic_data();
    h.script(
      `
            delete Ba[is Bb];
            `
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_delete_complex_type_02", () => {
    _setup_basic_data();
    h.script(
      `
            delete Ba[is Bb][is Bc];
            `
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_delete_complex_type_03", () => {
    _setup_basic_data();
    h.script(
      `
            delete Ba[is Bb | Bc];
            `
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_delete_complex_type_04", () => {
    _setup_basic_data();
    h.script(
      `
            delete Ba[is Bb & Bc];
            `
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_delete_complex_type_05", () => {
    _setup_basic_data();
    h.script(
      `
            delete Ba[IS CBa | Bb & Bc];
            `
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_delete_complex_type_06", () => {
    _setup_basic_data();
    h.script(
      `
            delete {CBa, Ba[IS Bb & Bc]};
            `
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba4",
              "bb": null,
              "bc": 4.5,
            },
            {
              "tn": "default::CBaBc",
              "ba": "cba5",
              "bb": null,
              "bc": 5.5,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_delete_complex_type_07", () => {
    _setup_basic_data();
    h.script(
      `
            delete Object[IS (Ba & Bb) | (Ba & Bc)];
            `
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_delete_complex_type_08", () => {
    _setup_basic_data();
    h.script(
      `
            delete {Object[IS Ba & Bb], Object[IS Ba & Bc]};
            `
    );
    assertQueryResult(
      h,
      `
            select (DISTINCT {Ba, Bb, Bc}){
                tn := .__type__.name,
                [IS Ba].ba,
                [IS Bb].bb,
                [IS Bc].bc,
            }
            order by .tn then .ba then .bb then .bc;
            `,
      [
            {
              "tn": "default::CBa",
              "ba": "cba0",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBa",
              "ba": "cba1",
              "bb": null,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 0,
              "bc": null,
            },
            {
              "tn": "default::CBb",
              "ba": null,
              "bb": 1,
              "bc": null,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 6,
              "bc": 6.5,
            },
            {
              "tn": "default::CBbBc",
              "ba": null,
              "bb": 7,
              "bc": 7.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 0.5,
            },
            {
              "tn": "default::CBc",
              "ba": null,
              "bb": null,
              "bc": 1.5,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_for_complex_intersection_01", () => {
    _setup_basic_data();
    assertQueryResult(
      h,
      `
            FOR x IN Ba UNION (
                x[IS Bb]
                {
                    tn := .__type__.name,
                    ba,
                    bb,
                    [IS Bc].bc,
                }
            )
            `,
      unorderedBag([
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ])
    );
    assertQueryResult(
      h,
      `
            SELECT (FOR x IN Ba UNION (x[IS Bb]))
            {
                tn := .__type__.name,
                ba,
                bb,
                [IS Bc].bc,
            }
            `,
      unorderedBag([
            {
              "tn": "default::CBaBb",
              "ba": "cba2",
              "bb": 2,
              "bc": null,
            },
            {
              "tn": "default::CBaBb",
              "ba": "cba3",
              "bb": 3,
              "bc": null,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba8",
              "bb": 8,
              "bc": 8.5,
            },
            {
              "tn": "default::CBaBbBc",
              "ba": "cba9",
              "bb": 9,
              "bc": 9.5,
            },
          ])
    );
  });

  it("test_edgeql_advtypes_intersection_pointers_01", () => {
    h.script(
      `
                            select SoloNonCompSinglePropA {
                                x := (
                                    [is SoloNonCompSinglePropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select SoloNonCompSingleLinkA {
                                x := (
                                    [is SoloNonCompSingleLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select SoloNonCompSinglePropA {
                                    x := (
                                        [is SoloNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSingleLinkA {
                                    x := (
                                        [is SoloNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSinglePropA {
                                    x := (
                                        [is SoloCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSingleLinkA {
                                    x := (
                                        [is SoloCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSinglePropA {
                                    x := (
                                        [is SoloCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSingleLinkA {
                                    x := (
                                        [is SoloCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    h.script(
      `
                            select SoloNonCompSinglePropA {
                                x := (
                                    [is DerivedNonCompSinglePropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select SoloNonCompSingleLinkA {
                                x := (
                                    [is DerivedNonCompSingleLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select SoloNonCompSinglePropA {
                                    x := (
                                        [is DerivedNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSingleLinkA {
                                    x := (
                                        [is DerivedNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSinglePropA {
                                    x := (
                                        [is DerivedCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSingleLinkA {
                                    x := (
                                        [is DerivedCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSinglePropA {
                                    x := (
                                        [is DerivedCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompSingleLinkA {
                                    x := (
                                        [is DerivedCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiPropA {
                                    x := (
                                        [is SoloNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiLinkA {
                                    x := (
                                        [is SoloNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    h.script(
      `
                            select SoloNonCompMultiPropA {
                                x := (
                                    [is SoloNonCompMultiPropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select SoloNonCompMultiLinkA {
                                x := (
                                    [is SoloNonCompMultiLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiPropA {
                                    x := (
                                        [is SoloCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiLinkA {
                                    x := (
                                        [is SoloCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiPropA {
                                    x := (
                                        [is SoloCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiLinkA {
                                    x := (
                                        [is SoloCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiPropA {
                                    x := (
                                        [is DerivedNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiLinkA {
                                    x := (
                                        [is DerivedNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    h.script(
      `
                            select SoloNonCompMultiPropA {
                                x := (
                                    [is DerivedNonCompMultiPropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select SoloNonCompMultiLinkA {
                                x := (
                                    [is DerivedNonCompMultiLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiPropA {
                                    x := (
                                        [is DerivedCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiLinkA {
                                    x := (
                                        [is DerivedCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiPropA {
                                    x := (
                                        [is DerivedCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloNonCompMultiLinkA {
                                    x := (
                                        [is DerivedCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSinglePropA {
                                    x := (
                                        [is SoloNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSingleLinkA {
                                    x := (
                                        [is SoloNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSinglePropA {
                                    x := (
                                        [is SoloNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSingleLinkA {
                                    x := (
                                        [is SoloNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSinglePropA {
                                    x := (
                                        [is SoloCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSingleLinkA {
                                    x := (
                                        [is SoloCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSinglePropA {
                                    x := (
                                        [is SoloCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSingleLinkA {
                                    x := (
                                        [is SoloCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSinglePropA {
                                    x := (
                                        [is DerivedNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSingleLinkA {
                                    x := (
                                        [is DerivedNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSinglePropA {
                                    x := (
                                        [is DerivedNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSingleLinkA {
                                    x := (
                                        [is DerivedNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSinglePropA {
                                    x := (
                                        [is DerivedCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSingleLinkA {
                                    x := (
                                        [is DerivedCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSinglePropA {
                                    x := (
                                        [is DerivedCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompSingleLinkA {
                                    x := (
                                        [is DerivedCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiPropA {
                                    x := (
                                        [is SoloNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiLinkA {
                                    x := (
                                        [is SoloNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiPropA {
                                    x := (
                                        [is SoloNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiLinkA {
                                    x := (
                                        [is SoloNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiPropA {
                                    x := (
                                        [is SoloCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiLinkA {
                                    x := (
                                        [is SoloCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiPropA {
                                    x := (
                                        [is SoloCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiLinkA {
                                    x := (
                                        [is SoloCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiPropA {
                                    x := (
                                        [is DerivedNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiLinkA {
                                    x := (
                                        [is DerivedNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiPropA {
                                    x := (
                                        [is DerivedNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiLinkA {
                                    x := (
                                        [is DerivedNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiPropA {
                                    x := (
                                        [is DerivedCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiLinkA {
                                    x := (
                                        [is DerivedCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiPropA {
                                    x := (
                                        [is DerivedCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select SoloCompMultiLinkA {
                                    x := (
                                        [is DerivedCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    h.script(
      `
                            select DerivedNonCompSinglePropA {
                                x := (
                                    [is SoloNonCompSinglePropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select DerivedNonCompSingleLinkA {
                                x := (
                                    [is SoloNonCompSingleLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSinglePropA {
                                    x := (
                                        [is SoloNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSingleLinkA {
                                    x := (
                                        [is SoloNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSinglePropA {
                                    x := (
                                        [is SoloCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSingleLinkA {
                                    x := (
                                        [is SoloCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSinglePropA {
                                    x := (
                                        [is SoloCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSingleLinkA {
                                    x := (
                                        [is SoloCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    h.script(
      `
                            select DerivedNonCompSinglePropA {
                                x := (
                                    [is DerivedNonCompSinglePropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select DerivedNonCompSingleLinkA {
                                x := (
                                    [is DerivedNonCompSingleLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSinglePropA {
                                    x := (
                                        [is DerivedNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSingleLinkA {
                                    x := (
                                        [is DerivedNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSinglePropA {
                                    x := (
                                        [is DerivedCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSingleLinkA {
                                    x := (
                                        [is DerivedCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSinglePropA {
                                    x := (
                                        [is DerivedCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompSingleLinkA {
                                    x := (
                                        [is DerivedCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiPropA {
                                    x := (
                                        [is SoloNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiLinkA {
                                    x := (
                                        [is SoloNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    h.script(
      `
                            select DerivedNonCompMultiPropA {
                                x := (
                                    [is SoloNonCompMultiPropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select DerivedNonCompMultiLinkA {
                                x := (
                                    [is SoloNonCompMultiLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiPropA {
                                    x := (
                                        [is SoloCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiLinkA {
                                    x := (
                                        [is SoloCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiPropA {
                                    x := (
                                        [is SoloCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiLinkA {
                                    x := (
                                        [is SoloCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiPropA {
                                    x := (
                                        [is DerivedNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiLinkA {
                                    x := (
                                        [is DerivedNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a .* to mix with other versions of .* which have a different cardinality"));
    h.script(
      `
                            select DerivedNonCompMultiPropA {
                                x := (
                                    [is DerivedNonCompMultiPropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select DerivedNonCompMultiLinkA {
                                x := (
                                    [is DerivedNonCompMultiLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiPropA {
                                    x := (
                                        [is DerivedCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiLinkA {
                                    x := (
                                        [is DerivedCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiPropA {
                                    x := (
                                        [is DerivedCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedNonCompMultiLinkA {
                                    x := (
                                        [is DerivedCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSinglePropA {
                                    x := (
                                        [is SoloNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSingleLinkA {
                                    x := (
                                        [is SoloNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSinglePropA {
                                    x := (
                                        [is SoloNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSingleLinkA {
                                    x := (
                                        [is SoloNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSinglePropA {
                                    x := (
                                        [is SoloCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSingleLinkA {
                                    x := (
                                        [is SoloCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSinglePropA {
                                    x := (
                                        [is SoloCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSingleLinkA {
                                    x := (
                                        [is SoloCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSinglePropA {
                                    x := (
                                        [is DerivedNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSingleLinkA {
                                    x := (
                                        [is DerivedNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSinglePropA {
                                    x := (
                                        [is DerivedNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSingleLinkA {
                                    x := (
                                        [is DerivedNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    h.script(
      `
                            select DerivedCompSinglePropA {
                                x := (
                                    [is DerivedCompSinglePropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select DerivedCompSingleLinkA {
                                x := (
                                    [is DerivedCompSingleLinkB]
                                    .siblings
                                )
                            };
                        `
    );
    expect(() => {
      h.script(
        `
                                select DerivedCompSinglePropA {
                                    x := (
                                        [is DerivedCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompSingleLinkA {
                                    x := (
                                        [is DerivedCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiPropA {
                                    x := (
                                        [is SoloNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiLinkA {
                                    x := (
                                        [is SoloNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiPropA {
                                    x := (
                                        [is SoloNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiLinkA {
                                    x := (
                                        [is SoloNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiPropA {
                                    x := (
                                        [is SoloCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiLinkA {
                                    x := (
                                        [is SoloCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiPropA {
                                    x := (
                                        [is SoloCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiLinkA {
                                    x := (
                                        [is SoloCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiPropA {
                                    x := (
                                        [is DerivedNonCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiLinkA {
                                    x := (
                                        [is DerivedNonCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiPropA {
                                    x := (
                                        [is DerivedNonCompMultiPropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiLinkA {
                                    x := (
                                        [is DerivedNonCompMultiLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiPropA {
                                    x := (
                                        [is DerivedCompSinglePropB]
                                        .numbers
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    expect(() => {
      h.script(
        `
                                select DerivedCompMultiLinkA {
                                    x := (
                                        [is DerivedCompSingleLinkB]
                                        .siblings
                                    )
                                };
                            `
      );
    }).toThrow(new RegExp("it is illegal to create a type intersection that causes a computed .* to mix with other versions of the same .*"));
    h.script(
      `
                            select DerivedCompMultiPropA {
                                x := (
                                    [is DerivedCompMultiPropB]
                                    .numbers
                                )
                            };
                        `
    );
    h.script(
      `
                            select DerivedCompMultiLinkA {
                                x := (
                                    [is DerivedCompMultiLinkB]
                                    .siblings
                                )
                            };
                        `
    );
  });

  it("test_edgeql_advtypes_intersection_pointers_02", () => {
    h.script(
      `
            INSERT SoloOriginA { dest := (INSERT Destination{ name := "A" }) };
            INSERT SoloOriginB { dest := (INSERT Destination{ name := "B" }) };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT SoloOriginA {
                x := [is SoloOriginB].dest.name
            }
            `,
      [
            {
              "x": null,
            },
          ]
    );
  });

  it("test_edgeql_advtypes_intersection_pointers_03", () => {
    h.script(
      `
            INSERT BaseOriginA { dest := (INSERT Destination{ name := "A" }) };
            INSERT BaseOriginB { dest := (INSERT Destination{ name := "B" }) };
            INSERT DerivedOriginC {
                dest := (INSERT Destination{ name := "C" })
            };
        `
    );
    assertQueryResult(
      h,
      `
            SELECT BaseOriginA {
                x := [is BaseOriginB].dest.name
            }
            ORDER BY .x
            `,
      [
            {
              "x": null,
            },
            {
              "x": "C",
            },
          ]
    );
  });
});
