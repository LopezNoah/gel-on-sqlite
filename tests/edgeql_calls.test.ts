import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLFuncCalls", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
    });
  });

  it("test_edgeql_calls_01", () => {
    h.script(
      `
            CREATE FUNCTION call1(
                s: str,
                VARIADIC a: int64,
                NAMED ONLY suffix: str = '-suf',
                NAMED ONLY prefix: str = 'pref-'
            ) -> std::str
                USING (
                    SELECT prefix ++ s ++ <str>sum(array_unpack(a)) ++ suffix
                );
        `
    );
    assertQueryResult(
      h,
      `SELECT call1('-');`,
      ["pref--0-suf"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', suffix := 's1');`,
      ["pref--0s1"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', prefix := 'p1');`,
      ["p1-0-suf"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', suffix := 's1', prefix := 'p1');`,
      ["p1-0s1"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', 1);`,
      ["pref--1-suf"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', 1, suffix := 's1');`,
      ["pref--1s1"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', 1, prefix := 'p1');`,
      ["p1-1-suf"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', 1, 2, 3, 4, 5);`,
      ["pref--15-suf"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', 1, 2, 3, 4, 5, suffix := 's1');`,
      ["pref--15s1"]
    );
    assertQueryResult(
      h,
      `SELECT call1('-', 1, 2, 3, 4, 5, prefix := 'p1');`,
      ["p1-15-suf"]
    );
    assertQueryResult(
      h,
      `
                SELECT call1('-', 1, 2, 3, 4, 5, prefix := 'p1',
                                   suffix := 'aaa');
            `,
      ["p1-15aaa"]
    );
  });

  it("test_edgeql_calls_02", () => {
    h.script(
      `
            CREATE FUNCTION call2(
                VARIADIC a: anytype
            ) -> std::str {
                USING (
                    SELECT '=' ++ <str>len(a) ++ '='
                );
            }
        `
    );
    assertQueryResult(
      h,
      `SELECT call2('a', 'b');`,
      ["=2="]
    );
    assertQueryResult(
      h,
      `SELECT call2(4, 2, 0);`,
      ["=3="]
    );
  });

  it("test_edgeql_calls_03", () => {
    h.script(
      `
            CREATE FUNCTION call3(
                a: int32,
                NAMED ONLY b: int32
            ) -> int32
                USING EdgeQL $$
                    SELECT a + b
                $$;
        `
    );
    expect(() => {
      h.script(
        `SELECT call3(1);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call3(1, 2);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call3(1, 2, 3);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call3(b := 1);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call3(1, 2, b := 1);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
  });

  it("test_edgeql_calls_04", () => {
    h.script(
      `
            CREATE FUNCTION call4(
                a: int32,
                NAMED ONLY b: array<anytype> = []
            ) -> int32
                USING EdgeQL $$
                    SELECT a + len(b)
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call4(100);`,
      [100]
    );
    assertQueryResult(
      h,
      `SELECT call4(100, b := <int32>[]);`,
      [100]
    );
    assertQueryResult(
      h,
      `SELECT call4(100, b := [1, 2]);`,
      [102]
    );
    assertQueryResult(
      h,
      `SELECT call4(100, b := ['a', 'b']);`,
      [102]
    );
  });

  it("test_edgeql_calls_05", () => {
    h.script(
      `
            CREATE FUNCTION call5(
                a: int64,
                NAMED ONLY b: OPTIONAL int64 = <int64>{}
            ) -> int64
                USING EdgeQL $$
                    SELECT a + b ?? -100
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call5(1);`,
      [-99]
    );
    assertQueryResult(
      h,
      `SELECT call5(<int32>2);`,
      [-98]
    );
    assertQueryResult(
      h,
      `SELECT call5(1, b := 20);`,
      [21]
    );
    assertQueryResult(
      h,
      `SELECT call5(1, b := <int16>10);`,
      [11]
    );
    assertQueryResult(
      h,
      `SELECT call5(<int32>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT call5(<int32>{}, b := <int32>{});`,
      []
    );
    assertQueryResult(
      h,
      `SELECT call5(<int32>{}, b := 50);`,
      []
    );
    assertQueryResult(
      h,
      `SELECT call5(1, b := <int32>{});`,
      [-99]
    );
    assertQueryResult(
      h,
      `
            WITH X := (SELECT _:={1,2,3} FILTER _ < 0)
            SELECT call5(1, b := X);`,
      [-99]
    );
  });

  it("test_edgeql_calls_06", () => {
    h.script(
      `
            CREATE FUNCTION call6(
                VARIADIC a: int64
            ) -> int64
                USING EdgeQL $$
                    SELECT <int64>sum(array_unpack(a))
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call6();`,
      [0]
    );
    assertQueryResult(
      h,
      `SELECT call6(1, 2, 3);`,
      [6]
    );
    assertQueryResult(
      h,
      `SELECT call6(<int16>1, <int32>2, 3);`,
      [6]
    );
  });

  it("test_edgeql_calls_07", () => {
    h.script(
      `
            CREATE FUNCTION call7(
                a: int64 = 1,
                b: int64 = 2,
                c: int64 = 3,
                NAMED ONLY d: int64 = 4,
                NAMED ONLY e: int64 = 5
            ) -> array<int64>
                USING EdgeQL $$
                    SELECT [a, b, c, d, e]
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call7();`,
      [
            [1, 2, 3, 4, 5],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call7(e := 100);`,
      [
            [1, 2, 3, 4, 100],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call7(d := 200);`,
      [
            [1, 2, 3, 200, 5],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call7(20, 30, d := 200);`,
      [
            [20, 30, 3, 200, 5],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call7(20, 30, e := 42, d := 200);`,
      [
            [20, 30, 3, 200, 42],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call7(20, 30, 1, d := 200, e := 42);`,
      [
            [20, 30, 1, 200, 42],
          ]
    );
    expect(() => {
      h.script(
        `SELECT call7(1, 2, 3, 4, 5);SELECT call7(1, 2, 3, 4);SELECT call7(1, z := 1);SELECT call7(1, 2, 3, z := 1);SELECT call7(1, 2, 3, 4, z := 1);SELECT call7(1, 2, 3, d := 1, z := 10);SELECT call7(1, 2, 3, d := 1, e := 2, z := 10);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
  });

  it("test_edgeql_calls_08", () => {
    h.script(
      `
            CREATE FUNCTION call8(
                a: int64 = 1,
                NAMED ONLY b: int64 = 2
            ) -> int64
                USING EdgeQL $$
                    SELECT a + b
                $$;

            CREATE FUNCTION call8(
                a: float64 = 1.0,
                NAMED ONLY b: int64 = 2
            ) -> int64
                USING EdgeQL $$
                    SELECT 1000 + <int64>a + b
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call8(1);`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT call8(1.0);`,
      [1003]
    );
    assertQueryResult(
      h,
      `SELECT call8(1, b := 10);`,
      [11]
    );
    assertQueryResult(
      h,
      `SELECT call8(1.0, b := 10);`,
      [1011]
    );
    expect(() => {
      h.script(
        `SELECT call8();`
      );
    }).toThrow(new RegExp("function call8 is not unique"));
  });

  it("test_edgeql_calls_09", () => {
    assertQueryResult(
      h,
      `SELECT sum({1, 2, 3});`,
      unorderedSet([6])
    );
    assertQueryResult(
      h,
      `SELECT sum({<int32>1, 2, 3});`,
      unorderedSet([6])
    );
    assertQueryResult(
      h,
      `SELECT sum({<float32>1, 2, 3});`,
      unorderedSet([6])
    );
    assertQueryResult(
      h,
      `SELECT sum({<float32>1, <int32>2, 3});`,
      unorderedSet([6])
    );
    assertQueryResult(
      h,
      `SELECT sum({<int16>1, <int32>2, <decimal>3});`,
      unorderedSet([6])
    );
    assertQueryResult(
      h,
      `SELECT sum({1.1, 2.2, 3});`,
      unorderedSet([6.3])
    );
  });

  it("test_edgeql_calls_10", () => {
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF sum({1, 2, 3})).name;`,
      unorderedSet(["std::int64"])
    );
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF sum({<int32>1, 2, 3})).name;`,
      unorderedSet(["std::int64"])
    );
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF sum({<float32>1, 2, 3})).name;`,
      unorderedSet(["std::float64"])
    );
    assertQueryResult(
      h,
      `
                SELECT (INTROSPECT TYPEOF
                        sum({<float32>1, <int32>2, 3})).name;
            `,
      unorderedSet(["std::float64"])
    );
    assertQueryResult(
      h,
      `
                SELECT (INTROSPECT TYPEOF
                        sum({<int16>1, <int32>2, <decimal>3})).name;
            `,
      unorderedSet(["std::decimal"])
    );
    assertQueryResult(
      h,
      `
                SELECT (INTROSPECT TYPEOF
                        sum({<int16>1, <int32>2, <bigint>3})).name;
            `,
      unorderedSet(["std::bigint"])
    );
    assertQueryResult(
      h,
      `
                SELECT (INTROSPECT TYPEOF
                        sum({<int16>1, 2, <decimal>3})).name;
            `,
      unorderedSet(["std::decimal"])
    );
    assertQueryResult(
      h,
      `
                SELECT (INTROSPECT TYPEOF
                        sum({1, <float32>2.1, <float64>3})).name;
            `,
      unorderedSet(["std::float64"])
    );
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF sum({1.1, 2.2, 3.3})).name;`,
      unorderedSet(["std::float64"])
    );
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF
                        sum({<float32>1, <int32>2, <float32>3})).name;`,
      unorderedSet(["std::float64"])
    );
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF
                        sum({<float32>1, <float32>2, <float32>3})).name;`,
      unorderedSet(["std::float32"])
    );
    assertQueryResult(
      h,
      `SELECT (INTROSPECT TYPEOF sum({1.1, 2.2, 3})).name;`,
      unorderedSet(["std::float64"])
    );
  });

  it("test_edgeql_calls_11", () => {
    h.script(
      `
            CREATE FUNCTION call11(
                a: array<int32>
            ) -> int64
                USING EdgeQL $$
                    SELECT sum(array_unpack(a))
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call11([<int16>1, <int16>22]);`,
      [23]
    );
    assertQueryResult(
      h,
      `SELECT call11([<int16>1, <int32>23]);`,
      [24]
    );
    assertQueryResult(
      h,
      `SELECT call11([<int32>1, <int32>24]);`,
      [25]
    );
    expect(() => {
      h.script(
        `SELECT call11([<int32>1, 1.1]);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call11([<int32>1, <float32>1]);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call11([1, 2]);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
  });

  it("test_edgeql_calls_12", () => {
    h.script(
      `
            CREATE FUNCTION call12(
                a: anyint
            ) -> int64
                USING EdgeQL $$
                    SELECT <int64>a + 100
                $$;

            CREATE FUNCTION call12(
                a: int64
            ) -> int64
                USING EdgeQL $$
                    SELECT <int64>a + 1
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call12(<int32>1);`,
      [101]
    );
    assertQueryResult(
      h,
      `SELECT call12(1);`,
      [2]
    );
  });

  it("test_edgeql_calls_13", () => {
    h.script(
      `
            CREATE FUNCTION inner(
                a: anytype
            ) -> int64
                USING (
                    SELECT 1
                );

            CREATE FUNCTION call13(
                a: anytype
            ) -> int64
                USING (
                    SELECT inner(a)
                );
        `
    );
    assertQueryResult(
      h,
      `SELECT call13('aaa');`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call13(b'aaaa');`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call13([1, 2, 3, 4, 5]);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call13(['a', 'b']);`,
      [1]
    );
    h.script(
      `
            CREATE FUNCTION inner(
                a: str
            ) -> int64
                USING EdgeQL $$
                    SELECT 2
                $$;

            CREATE FUNCTION call13_2(
                a: anytype
            ) -> int64
                USING EdgeQL $$
                    SELECT inner(a)
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call13_2('aaa');`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT call13_2(b'aaaa');`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call13_2([1, 2, 3, 4, 5]);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call13_2(['a', 'b']);`,
      [1]
    );
  });

  it("test_edgeql_calls_13_sdl", () => {
    h.script(
      `
            function inner(a: anytype) -> str
                using ("anytype");

            function inner(a: int64) -> str
                using ("int64");

            function call13_sdl(a: anytype) -> str
                using (inner(a));
        `
    );
    assertQueryResult(
      h,
      `SELECT call13_sdl(1.0)`,
      ["anytype"]
    );
    assertQueryResult(
      h,
      `SELECT call13_sdl(1)`,
      ["int64"]
    );
  });

  it("test_edgeql_calls_14", () => {
    h.script(
      `
            CREATE FUNCTION call14(
                a: anytype
            ) -> array<anytype>
                USING EdgeQL $$
                    SELECT [a]
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call14('aaa');`,
      [
            ["aaa"],
          ]
    );
    expect(h.query("SELECT call14(b'aaaa');")).toEqual([
  [
    new Uint8Array([97, 97, 97, 97]),
  ],
]);
    assertQueryResult(
      h,
      `SELECT call14(1);`,
      [
            [1],
          ]
    );
  });

  it("test_edgeql_calls_15", () => {
    h.script(
      `
            CREATE FUNCTION call15(
                a: anytype
            ) -> array<anytype>
                USING EdgeQL $$
                    SELECT [a, a, a]
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call15('aaa');`,
      [
            ["aaa", "aaa", "aaa"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call15(1);`,
      [
            [1, 1, 1],
          ]
    );
  });

  it("test_edgeql_calls_16", () => {
    h.script(
      `
            CREATE FUNCTION call16(
                a: array<anytype>,
                idx: int64
            ) -> anytype
                USING EdgeQL $$
                    SELECT a[idx]
                $$;

            CREATE FUNCTION call16(
                a: array<anytype>,
                idx: str
            ) -> anytype
                USING EdgeQL $$
                    SELECT a[<int64>idx + 1]
                $$;

            CREATE FUNCTION call16(
                a: anyscalar,
                idx: int64
            ) -> anytype
                USING EdgeQL $$
                    SELECT a[idx]
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call16([1, 2, 3], 1);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT call16(['a', 'b', 'c'], 1);`,
      ["b"]
    );
    assertQueryResult(
      h,
      `SELECT call16([1, 2, 3], '1');`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT call16(['a', 'b', 'c'], '1');`,
      ["c"]
    );
    assertQueryResult(
      h,
      `SELECT call16('xyz', 1);`,
      ["y"]
    );
  });

  it("test_edgeql_calls_17", () => {
    h.script(
      `
            CREATE FUNCTION call17(
                a: anytype
            ) -> array<anytype>
                USING EdgeQL $$
                    SELECT [a, a, a]
                $$;

            CREATE FUNCTION call17(
                a: str
            ) -> array<str>
                USING EdgeQL $$
                    SELECT ['!!!!', a, '!!!!']
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call17(2);`,
      [
            [2, 2, 2],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call17('aaa');`,
      [
            ["!!!!", "aaa", "!!!!"],
          ]
    );
  });

  it("test_edgeql_calls_18", () => {
    h.script(
      `
            CREATE FUNCTION call18(
                VARIADIC a: anytype
            ) -> int64
                USING EdgeQL $$
                    SELECT len(a)
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call18(2);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call18(1, 2, 3);`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT call18('a', 'b');`,
      [2]
    );
    expect(() => {
      h.script(
        `SELECT call18(1, 2, "a");`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
  });

  it("test_edgeql_calls_19", () => {
    h.script(
      `
            CREATE FUNCTION call19(
                a: anytype
            ) -> array<anytype>
                USING EdgeQL $$
                    SELECT [a]
                $$;
        `
    );
    h.script(
      `SELECT call19((1,2));`
    );
    h.script(
      `SELECT call19((1,));`
    );
  });

  it.skip("test_edgeql_calls_20 [xerror: Polymorphic callable matching is currently too dumb to realize that `+` _is_ defined for 'anyreal', even though there are multiple actual forms defined.]", () => {
    h.script(
      `
            CREATE FUNCTION call20_1(
                a: anyreal, b: anyreal
            ) -> anyreal
                USING EdgeQL $$
                    SELECT a + b
                $$;

            CREATE FUNCTION call20_2(
                a: anyscalar, b: anyscalar
            ) -> bool
                USING EdgeQL $$
                    SELECT a < b
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call20_1(10, 20);`,
      [30]
    );
    assertQueryResult(
      h,
      `SELECT call20_2(1, 2);`,
      [true]
    );
    assertQueryResult(
      h,
      `SELECT call20_2('b', 'a');`,
      [false]
    );
    expect(() => {
      h.script(
        `SELECT call20_1(1, "1");`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
  });

  it("test_edgeql_calls_21", () => {
    h.script(
      `
            CREATE FUNCTION call21(
                a: array<anytype>
            ) -> int64
                USING EdgeQL $$
                    SELECT len(a)
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call21(<array<str>>[]);`,
      [0]
    );
    assertQueryResult(
      h,
      `SELECT call21([1,2]);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT call21(['a', 'b', 'c']);`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT call21([(1, 2), (2, 3), (3, 4), (4, 5)]);`,
      [4]
    );
  });

  it("test_edgeql_calls_22", () => {
    h.script(
      `
            CREATE FUNCTION call22(
                a: str, b: str
            ) -> str
                USING EdgeQL $$
                    SELECT a ++ b
                $$;

            CREATE FUNCTION call22(
                a: array<anytype>, b: array<anytype>
            ) -> array<anytype>
                USING EdgeQL $$
                    SELECT a ++ b
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call22('a', 'b');`,
      ["ab"]
    );
    assertQueryResult(
      h,
      `SELECT call22(['a'], ['b']);`,
      [
            ["a", "b"],
          ]
    );
  });

  it("test_edgeql_calls_23", () => {
    h.script(
      `
            CREATE FUNCTION call23(
                a: anytype,
                idx: int64
            ) -> anytype
                USING EdgeQL $$
                    SELECT a[idx]
                $$;

            CREATE FUNCTION call23(
                a: anytype,
                idx: int32
            ) -> anytype
                USING EdgeQL $$
                    SELECT a[-idx:]
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call23('abcde', 2);`,
      ["c"]
    );
    assertQueryResult(
      h,
      `SELECT call23('abcde', <int32>2);`,
      ["de"]
    );
    expect(h.query("SELECT call23(to_json('[{\"a\":\"b\"}]'), 0);")).toEqual("{\"a\": \"b\"}");
    expect(h.query("SELECT call23(to_json('[{\"a\":\"b\"}]'), 0);")).toEqual("[{\"a\": \"b\"}]");
  });

  it("test_edgeql_calls_24", () => {
    h.script(
      `
            CREATE FUNCTION call24() -> str
                USING EdgeQL $$
                    SELECT 'ab' ++ 'cd'
                $$;

            CREATE FUNCTION call24(
                a: str
            ) -> str
                USING EdgeQL $$
                    SELECT a ++ '!'
                $$;
        `
    );
    assertQueryResult(
      h,
      `select call24();`,
      ["abcd"]
    );
    assertQueryResult(
      h,
      `select call24('aaa');`,
      ["aaa!"]
    );
  });

  it("test_edgeql_calls_26", () => {
    h.script(
      `
            CREATE FUNCTION call26(
                a: array<anyscalar>
            ) -> int64
                USING EdgeQL $$
                    SELECT len(a)
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call26(['aaa']);`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call26([b'', b'aa']);`,
      [2]
    );
    expect(() => {
      h.script(
        `SELECT call26([(1, 2)]);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
  });

  it("test_edgeql_calls_27", () => {
    h.script(
      `
            CREATE FUNCTION call27(
                a: array<anyint>
            ) -> int64
                USING EdgeQL $$
                    SELECT len(a)
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call27([<int32>1, <int32>2]);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT call27([1, 2, 3]);`,
      [3]
    );
    expect(() => {
      h.script(
        `SELECT call27(['aaa']);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call27([b'', b'aa']);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call27([1.0, 2.1]);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
    expect(() => {
      h.script(
        `SELECT call27([('a',), ('b',)]);`
      );
    }).toThrow(new RegExp("function .+ does not exist"));
  });

  it("test_edgeql_calls_28", () => {
    h.script(
      `
            CREATE FUNCTION call28(
                a: array<anyint>
            ) -> int64
                USING EdgeQL $$
                    SELECT len(a)
                $$;

            CREATE FUNCTION call28(
                a: array<anyscalar>
            ) -> int64
                USING EdgeQL $$
                    SELECT len(a) + 1000
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call28([<int32>1, <int32>2]);`,
      [2]
    );
    assertQueryResult(
      h,
      `SELECT call28([1, 2, 3]);`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT call28(['a', 'b']);`,
      [1002]
    );
  });

  it("test_edgeql_calls_29", () => {
    h.script(
      `
            CREATE FUNCTION call29(
                a: anyint
            ) -> anyint
                USING EdgeQL $$
                    SELECT a + 1
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call29(10);`,
      [11]
    );
  });

  it("test_edgeql_calls_30", () => {
    h.script(
      `
            CREATE FUNCTION call30(
                a: anyint
            ) -> int64
                USING EdgeQL $$
                    SELECT <int64>a + 100
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call30(10);`,
      [110]
    );
    assertQueryResult(
      h,
      `SELECT call30(<int32>20);`,
      [120]
    );
  });

  it("test_edgeql_calls_31", () => {
    h.script(
      `
            CREATE FUNCTION call31(
                a: anytype
            ) -> anytype
                USING EdgeQL $$
                    SELECT a
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call31(10);`,
      [10]
    );
    assertQueryResult(
      h,
      `SELECT call31('aa');`,
      ["aa"]
    );
    assertQueryResult(
      h,
      `SELECT call31([1, 2]);`,
      [
            [1, 2],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call31([1, 2])[0];`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=1001, b:=1002)).a;`,
      [1001]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=1001, b:=1002)).1;`,
      [1002]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=['a', 'b'], b:=['x', 'y'])).1;`,
      [
            ["x", "y"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=['a', 'b'], b:=['x', 'y'])).a[1];`,
      ["b"]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=1001, b:=1002));`,
      [
            {
              "a": 1001,
              "b": 1002,
            },
          ]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=[(x:=1)])).a[0].x;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=[(x:=1)])).0[0].x;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=[(x:=1)])).0[0].0;`,
      [1]
    );
    assertQueryResult(
      h,
      `SELECT call31((a:=[(x:=1)])).a[0];`,
      [
            {
              "x": 1,
            },
          ]
    );
  });

  it("test_edgeql_calls_32", () => {
    h.script(
      `
            CREATE FUNCTION call32(
                a: anytype, b: anytype
            ) -> anytype
                USING EdgeQL $$
                    SELECT a ++ b
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call32([1], [<int16>2]);`,
      [
            [1, 2],
          ]
    );
  });

  it("test_edgeql_calls_33", () => {
    h.script(
      `
            CREATE FUNCTION call33(
                a: tuple<int64, tuple<int64>>,
                b: tuple<foo: int64, bar: str>
            ) -> int64
                USING EdgeQL $$
                    SELECT a.0 + b.foo
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call33((1, (2,)), (foo := 10, bar := 'bar'));`,
      [11]
    );
  });

  it("test_edgeql_calls_34", () => {
    h.script(
      `
            CREATE FUNCTION call34(
                a: array<tuple<int64, int64>>
            ) -> int64
                USING EdgeQL $$
                    SELECT a[0].0
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call34([(1, 2), (3, 4)]);`,
      [1]
    );
  });

  it("test_edgeql_calls_35a", () => {
    h.script(
      `
            CREATE FUNCTION call35(
                a: int64
            ) -> tuple<int64, tuple<foo: int64>>
                USING EdgeQL $$
                    SELECT (a, ((a + 1),))
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call35(1);`,
      [
            [
              1,
              {
                "foo": 2,
              },
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call35(1).1.foo;`,
      [2]
    );
  });

  it("test_edgeql_calls_35b", () => {
    h.script(
      `
            CREATE FUNCTION call35(
                a: tuple<int64, array<tuple<int64>>>
            ) -> tuple<int64, array<tuple<foo: int64>>>
                USING EdgeQL $$
                    SELECT a
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call35((1, [(2,)]));`,
      [
            [
              1,
              [
                {
                  "foo": 2,
                },
              ],
            ],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call35((1, [(2,)])).1[0].foo;`,
      [2]
    );
  });

  it("test_edgeql_calls_35c", () => {
    h.script(
      `
            CREATE SCALAR TYPE Foo extending str;
            CREATE FUNCTION call35() -> array<tuple<Foo>>
            USING (SELECT [('1',)] ++ [('2',)]);
        `
    );
    assertQueryResult(
      h,
      `SELECT call35();`,
      [
            [
              ["1"],
              ["2"],
            ],
          ]
    );
  });

  it("test_edgeql_calls_36", () => {
    h.script(
      `
            CREATE FUNCTION call36(
                a: int64
            ) -> array<tuple<int64>>
                USING EdgeQL $$
                    SELECT [(a,)]
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call36(1);`,
      [
            [
              [1],
            ],
          ]
    );
  });

  it("test_edgeql_calls_37", () => {
    h.script(
      `
            CREATE FUNCTION call37(
                a: int64 = 1,
                b: int64 = 2
            ) -> int64
                USING EdgeQL $$
                    SELECT a + b
                $$;
        `
    );
    assertQueryResult(
      h,
      `SELECT call37();`,
      [3]
    );
    assertQueryResult(
      h,
      `SELECT call37(2);`,
      [4]
    );
    assertQueryResult(
      h,
      `SELECT call37(2, 3);`,
      [5]
    );
  });

  it("test_edgeql_calls_38", () => {
    h.script(
      `
            CREATE TYPE C38 { CREATE PROPERTY name -> str };
            INSERT C38 { name := 'yay' };
            CREATE FUNCTION call38(
                a: C38
            ) -> OPTIONAL str
                USING (
                    SELECT a.name
                );
        `
    );
    assertQueryResult(
      h,
      `SELECT call38(C38);`,
      ["yay"]
    );
  });

  it("test_edgeql_calls_39", () => {
    h.script(
      `
            CREATE FUNCTION call39(
                foo: str
            ) -> str
                USING (foo);
        `
    );
    assertQueryResult(
      h,
      `SELECT call39("identity");`,
      ["identity"]
    );
  });

  it("test_edgeql_calls_40", () => {
    h.script(
      `
            CREATE TYPE Rectangle {
                CREATE REQUIRED PROPERTY width -> int64;
                CREATE REQUIRED PROPERTY height -> int64;
            };

            INSERT Rectangle { width := 2, height := 3 };

            CREATE FUNCTION call40(
                r: Rectangle
            ) -> int64
                USING (r.width * r.height);
        `
    );
    assertQueryResult(
      h,
      `SELECT call40(Rectangle);`,
      [6]
    );
  });

  it("test_edgeql_calls_41", () => {
    h.script(
      `
            CREATE FUNCTION call41(
                a: int64, b: int64
            ) -> SET OF int64
                USING ({a, b});
        `
    );
    assertQueryResult(
      h,
      `SELECT call41(1, 2);`,
      [1, 2]
    );
  });

  it("test_edgeql_calls_42", () => {
    h.script(
      `
            CREATE FUNCTION call42(
                a: int64, b: int64
            ) -> SET OF tuple<int64, str>
                USING ({(a, '1'), (b, '2')});
        `
    );
    assertQueryResult(
      h,
      `SELECT call42(1, 2);`,
      [
            [1, "1"],
            [2, "2"],
          ]
    );
    assertQueryResult(
      h,
      `SELECT call42(1, 2).0;`,
      [1, 2]
    );
  });

  it("test_edgeql_calls_obj_01", () => {
    h.script(
      `
            CREATE TYPE Shape;
            CREATE TYPE FlatShape;
            CREATE TYPE Rectangle EXTENDING FlatShape {
                CREATE REQUIRED PROPERTY w -> float64;
                CREATE REQUIRED PROPERTY h -> float64;
            };

            CREATE TYPE Circle EXTENDING FlatShape {
                CREATE REQUIRED PROPERTY r -> float64;
            };

            # Use -1 as the error indicator, as we don't have the means
            # to raise errors directly yet.
            CREATE FUNCTION area(s: FlatShape) -> float64 USING (-1);
            CREATE FUNCTION area(s: Rectangle) -> float64 USING (s.w * s.h);
            CREATE FUNCTION area(s: Circle) -> float64 USING (s.r ^ 2 * 3.14);

            INSERT Rectangle { w := 10, h := 20 };
            INSERT Circle { r := 10 };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT FlatShape {
                    tn := .__type__.name,
                    area := area(FlatShape),
                }
                ORDER BY .tn
            `,
      [
            {
              "tn": "default::Circle",
              "area": 314.0,
            },
            {
              "tn": "default::Rectangle",
              "area": 200.0,
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT area(Circle);
            `,
      [314.0]
    );
    assertQueryResult(
      h,
      `
                SELECT area(Rectangle);
            `,
      [200.0]
    );
    assertQueryResult(
      h,
      `
                WITH r := (Rectangle, [Rectangle])
                SELECT (area(r.0), area(r.1[0]))
            `,
      [
            [200.0, 200.0],
          ]
    );
    expect(() => {
      h.script(
        `SELECT area(Shape)`
      );
    }).toThrow(new RegExp("function \"area\\(.*: default::Shape\\)\" does not exist"));
  });

  it("test_edgeql_calls_obj_02", () => {
    h.script(
      `
            CREATE TYPE Shape;
            CREATE TYPE FlatShape;
            CREATE TYPE Rectangle EXTENDING FlatShape {
                CREATE PROPERTY w -> float64;
                CREATE PROPERTY h -> float64;
            };

            CREATE TYPE Circle EXTENDING FlatShape {
                CREATE PROPERTY r -> float64;
            };

            # Use -1 as the error indicator, as we don't have the means
            # to raise errors directly yet.
            CREATE FUNCTION dimensions(s: FlatShape) -> SET OF float64
                USING (-1);
            CREATE FUNCTION dimensions(s: Rectangle) -> SET OF float64
                USING ({s.w, s.h});
            CREATE FUNCTION dimensions(s: Circle) -> SET OF float64
                USING (s.r);

            INSERT Rectangle { w := 10, h := 20 };
            INSERT Circle { r := 5 };
        `
    );
    assertQueryResult(
      h,
      `
                SELECT FlatShape {
                    tn := .__type__.name,
                    dimensions := dimensions(FlatShape),
                }
                ORDER BY .tn
            `,
      [
            {
              "tn": "default::Circle",
              "dimensions": [5],
            },
            {
              "tn": "default::Rectangle",
              "dimensions": [10, 20],
            },
          ]
    );
    assertQueryResult(
      h,
      `
                SELECT dimensions(Circle);
            `,
      [5]
    );
    assertQueryResult(
      h,
      `
                SELECT dimensions(Rectangle);
            `,
      [10, 20]
    );
  });

  it("test_edgeql_calls_obj_03", () => {
    h.script(
      `
            CREATE TYPE Person {
                CREATE REQUIRED PROPERTY name -> str;
            };
            CREATE FUNCTION fight(one: Person, two: Person) -> str
                USING (one.name ++ " fights " ++ two.name);
            CREATE FUNCTION fight(one: str, two: str) -> str
                USING (one ++ " fights " ++ two);
            CREATE FUNCTION fight(one: Person, two: str) -> str
                USING (one.name ++ " fights " ++ two);
            CREATE FUNCTION fight(one: str, two: Person) -> str
                USING (one ++ " fights " ++ two.name);
            CREATE FUNCTION fight(names: array<str>) -> str
                USING (array_join(names, " fights "));

            INSERT Person { name := "Sub-Zero" };
            INSERT Person { name := "Scorpion" };
        `
    );
    assertQueryResult(
      h,
      `
                WITH
                    Scorpion := (SELECT Person FILTER .name = "Scorpion"),
                    SubZero := (SELECT Person FILTER .name = "Sub-Zero"),
                SELECT
                    fight(Scorpion, SubZero);
            `,
      ["Scorpion fights Sub-Zero"]
    );
    assertQueryResult(
      h,
      `
                WITH
                    Scorpion := (SELECT Person FILTER .name = "Scorpion"),
                    SubZero := (SELECT Person FILTER .name = "Sub-Zero"),
                SELECT
                    fight(Scorpion.name, SubZero.name);
            `,
      ["Scorpion fights Sub-Zero"]
    );
    assertQueryResult(
      h,
      `
                WITH
                    Scorpion := (SELECT Person FILTER .name = "Scorpion"),
                    SubZero := (SELECT Person FILTER .name = "Sub-Zero"),
                SELECT
                    fight(Scorpion.name, SubZero);
            `,
      ["Scorpion fights Sub-Zero"]
    );
    assertQueryResult(
      h,
      `
                WITH
                    Scorpion := (SELECT Person FILTER .name = "Scorpion"),
                    SubZero := (SELECT Person FILTER .name = "Sub-Zero"),
                SELECT
                    fight(Scorpion, SubZero.name);
            `,
      ["Scorpion fights Sub-Zero"]
    );
    assertQueryResult(
      h,
      `
                WITH
                    Scorpion := (SELECT Person FILTER .name = "Scorpion"),
                    SubZero := (SELECT Person FILTER .name = "Sub-Zero"),
                SELECT
                    fight([Scorpion.name, SubZero.name]);
            `,
      ["Scorpion fights Sub-Zero"]
    );
    h.script(
      `DROP FUNCTION fight(one: Person, two: Person)`
    );
    expect(() => {
      h.script(
        `
                WITH
                    Scorpion := (SELECT Person FILTER .name = "Scorpion"),
                    SubZero := (SELECT Person FILTER .name = "Sub-Zero"),
                SELECT
                    fight(Scorpion, SubZero);SELECT area(Shape)
                `
      );
    }).toThrow(new RegExp("function \"fight\\(.*default::Person.*\\)\" does not exist"));
  });

  it("test_edgeql_calls_obj_04", () => {
    h.script(
      `
            CREATE FUNCTION thing(s: schema::Constraint) -> OPTIONAL str
                USING (s.name ++ s.expr);

            CREATE FUNCTION frob(s: schema::Object) -> str
                USING ("ahhhh");
            CREATE FUNCTION frob(s: schema::Constraint) -> OPTIONAL str
                USING (s.name ++ s.expr);
            CREATE FUNCTION frob(s: schema::Pointer) -> OPTIONAL str
                USING (s.name ++ <str>s.required);
        `
    );
  });

  it("test_edgeql_calls_obj_05", () => {
    h.script(
      `
            CREATE TYPE Ghost {
                CREATE PROPERTY name -> str;
            };

            CREATE FUNCTION boo(s: Ghost) -> set of str
                USING ("oh my, " ++ s.name ++ " scared me!");

            INSERT Ghost { name := 'Casper' };
        `
    );
    assertQueryResult(
      h,
      `SELECT boo((SELECT Ghost))`,
      ["oh my, Casper scared me!"]
    );
    expect(() => {
      h.script(
        `SELECT boo((UPDATE Ghost SET { name := 'Tom' }))`
      );
    }).toThrow(new RegExp("newly created or updated objects cannot be passed to functions"));
    expect(() => {
      h.script(
        `SELECT boo((INSERT Ghost { name := 'Jack' }));`
      );
    }).toThrow(new RegExp("newly created or updated objects cannot be passed to functions"));
    expect(() => {
      h.script(
        `
                WITH friendly := (INSERT Ghost { name := 'Jack' })
                SELECT boo(friendly);
                `
      );
    }).toThrow(new RegExp("newly created or updated objects cannot be passed to functions"));
  });

  it("test_edgeql_call_builtin_obj", () => {
    h.script(
      `
                CREATE FUNCTION get_obj(name: str) ->
                  SET OF schema::Object USING (
                    SELECT schema::Object FILTER .name = name);
            `
    );
    let res = h.query("\n            SELECT get_obj('std::BaseObject')\n        ");
    expect(res.rows?.length).toEqual(1);
    //TODO: expect(res.rows?[0]["__tname__"]).toEqual("schema::ObjectType");
  });
});
