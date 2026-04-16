import { beforeEach, describe, expect, it } from "vitest";
import { QueryHarness } from "./utils.js";
import {
  assertQueryResult,
  unorderedBag,
  unorderedSet
} from "./python_query_test_helpers.js";

describe("TestEdgeQLFunctionsInline", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      dbFile: "./tests/.artifacts/functions_inline_testedgeqlfunctionsinline.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_functions_inline_basic_01", () => {
    h.script(
      `
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_basic_02", () => {
    h.script(
      `
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (x * x + 2 * x + 1);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([4, 9, 16])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([4, 9, 16])
    );
  });

  it("test_edgeql_functions_inline_basic_03", () => {
    h.script(
      `
            create function foo(x: int64, y: int64) -> int64 {
                set is_inlined := true;
                using (x + y);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, 1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, 10)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, 10)`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo(1, {10, 20, 30})`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, {10, 20, 30})`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, y)    ))`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
  });

  it("test_edgeql_functions_inline_basic_04", () => {
    h.script(
      `
            create function foo(x: int64 = 9) -> int64 {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [9]
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_basic_05", () => {
    h.script(
      `
            create function foo(x: int64) -> optional int64 {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_basic_06", () => {
    h.script(
      `
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_basic_07", () => {
    h.script(
      `
            create function foo(x: int64, y: int64 = 90) -> int64 {
                set is_inlined := true;
                using (x + y);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [91]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([91, 92, 93])
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, 1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, 10)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, 10)`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo(1, {10, 20, 30})`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, {10, 20, 30})`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([91, 92, 93])
    );
    assertQueryResult(
      h,
      `for y in {10, 20, 30} union (select foo(1, y))`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, y)    ))`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
  });

  it("test_edgeql_functions_inline_basic_08", () => {
    h.script(
      `
            create function foo(x: int64 = 9, y: int64 = 90) -> int64 {
                set is_inlined := true;
                using (x + y);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [91]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([91, 92, 93])
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, 1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, 10)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, 10)`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo(1, {10, 20, 30})`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, {10, 20, 30})`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([91, 92, 93])
    );
    assertQueryResult(
      h,
      `for y in {10, 20, 30} union (select foo(1, y))`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, y)    ))`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
  });

  it("test_edgeql_functions_inline_basic_09", () => {
    h.script(
      `
            create function foo(variadic x: int64) -> int64 {
                set is_inlined := true;
                using (sum(array_unpack(x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [0]
    );
    assertQueryResult(
      h,
      `select foo(1,<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{},1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, 10)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, 10)`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo(1, {10, 20, 30})`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, {10, 20, 30}, 100)`,
      unorderedBag([
            111,
            112,
            113,
            121,
            122,
            123,
            131,
            132,
            133,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, y, 100)    ))`,
      unorderedBag([
            111,
            112,
            113,
            121,
            122,
            123,
            131,
            132,
            133,
          ])
    );
  });

  it("test_edgeql_functions_inline_basic_10", () => {
    h.script(
      `
            create function foo(named only a: int64) -> int64 {
                set is_inlined := true;
                using (a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(a := 1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo(a := {1,2,3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(a := x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_basic_11", () => {
    h.script(
      `
            create function foo(x: int64, named only a: int64) -> int64 {
                set is_inlined := true;
                using (x + a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, a := 10)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, a := 10)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, a := 10)`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo(1, a := {10, 20, 30})`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, a := {10, 20, 30})`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x, a := 10))`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `for y in {10, 20, 30} union (select foo(1, a := y))`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, a := y)    ))`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
  });

  it("test_edgeql_functions_inline_basic_12", () => {
    h.script(
      `
            create function foo(
                x: int64 = 9,
                named only a: int64
            ) -> int64 {
                set is_inlined := true;
                using (x + a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(a := 10)`,
      [19]
    );
    assertQueryResult(
      h,
      `select foo(a := {10, 20, 30})`,
      unorderedBag([19, 29, 39])
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, a := 10)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, a := 10)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, a := 10)`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo(1, a := {10, 20, 30})`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, a := {10, 20, 30})`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x, a := 10))`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `for y in {10, 20, 30} union (select foo(a := y))`,
      unorderedBag([19, 29, 39])
    );
    assertQueryResult(
      h,
      `for y in {10, 20, 30} union (select foo(1, a := y))`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, a := y)    ))`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
  });

  it("test_edgeql_functions_inline_basic_13", () => {
    h.script(
      `
            create function foo(
                x: int64,
                named only a: int64 = 90
            ) -> int64 {
                set is_inlined := true;
                using (x + a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [91]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([91, 92, 93])
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, a := 10)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, a := 10)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, a := 10)`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo(1, a := {10, 20, 30})`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, a := {10, 20, 30})`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([91, 92, 93])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x, a := 10))`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `for y in {10, 20, 30} union (select foo(1, a := y))`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, a := y)    ))`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
  });

  it("test_edgeql_functions_inline_basic_14", () => {
    h.script(
      `
            create function foo(
                x: int64 = 9,
                named only a: int64 = 90
            ) -> int64 {
                set is_inlined := true;
                using (x + a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [91]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([91, 92, 93])
    );
    assertQueryResult(
      h,
      `select foo(a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(a := 10)`,
      [19]
    );
    assertQueryResult(
      h,
      `select foo(a := {10, 20, 30})`,
      unorderedBag([19, 29, 39])
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, a := 10)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, a := 10)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, a := 10)`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo(1, a := {10, 20, 30})`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, a := {10, 20, 30})`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([91, 92, 93])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x, a := 10))`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `for y in {10, 20, 30} union (select foo(a := y))`,
      unorderedBag([19, 29, 39])
    );
    assertQueryResult(
      h,
      `for y in {10, 20, 30} union (select foo(1, a := y))`,
      unorderedBag([11, 21, 31])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, a := y)    ))`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
  });

  it("test_edgeql_functions_inline_basic_15", () => {
    h.script(
      `
            create function foo(
                x: int64,
                y: int64 = 90,
                variadic z: int64,
                named only a: int64,
                named only b: int64 = 90000
            ) -> int64 {
                set is_inlined := true;
                using (x + y + sum(array_unpack(z)) + a + b);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, a := 1000)`,
      [91091]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, a := 1000)`,
      [91011]
    );
    assertQueryResult(
      h,
      `select foo(1, a := 1000, b := 10000)`,
      [11091]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, a := 1000, b := 10000)`,
      [11011]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, 100, a := 1000)`,
      [91111]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, 100, a := 1000, b := 10000)`,
      [11111]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, 100, 200, a := 1000)`,
      [91311]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, 100, 200, a := 1000, b := 10000)`,
      [11311]
    );
  });

  it("test_edgeql_functions_inline_basic_16", () => {
    h.script(
      `
            create function foo(x: optional int64) -> optional int64 {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_basic_17", () => {
    h.script(
      `
            create function foo(
                x: optional int64
            ) -> int64 {
                set is_inlined := true;
                using (x ?? 5);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      [5]
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_basic_18", () => {
    h.script(
      `
            create function foo(
                x: optional int64 = 9
            ) -> int64 {
                set is_inlined := true;
                using (x ?? 5);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [9]
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      [5]
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_basic_19", () => {
    h.script(
      `
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (for y in {x, x + 1, x + 2} union (y));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1, 2, 3]
    );
    assertQueryResult(
      h,
      `select foo({11, 21, 31})`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `for x in {11, 21, 31} union (select foo(x))`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
  });

  it("test_edgeql_functions_inline_array_01", () => {
    h.script(
      `
            create function foo(x: int64) -> array<int64> {
                set is_inlined := true;
                using ([x]);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
  });

  it("test_edgeql_functions_inline_array_02", () => {
    h.script(
      `
            create function foo(x: array<int64>) -> array<int64> {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([
            [1],
            [2, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_array_03", () => {
    h.script(
      `
            create function foo(
                x: array<int64> = [9]
            ) -> array<int64> {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([
            [1],
            [2, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_array_04", () => {
    h.script(
      `
            create function foo(x: array<int64>) -> int64 {
                set is_inlined := true;
                using (sum(array_unpack(x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([1, 5])
    );
  });

  it("test_edgeql_functions_inline_array_05", () => {
    h.script(
      `
            create function foo(x: array<int64>) -> set of int64 {
                set is_inlined := true;
                using (array_unpack(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_tuple_01", () => {
    h.script(
      `
            create function foo(x: int64) -> tuple<int64> {
                set is_inlined := true;
                using ((x,));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
  });

  it("test_edgeql_functions_inline_tuple_02", () => {
    h.script(
      `
            create function foo(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
  });

  it("test_edgeql_functions_inline_tuple_03", () => {
    h.script(
      `
            create function foo(
                x: tuple<int64> = (9,)
            ) -> tuple<int64> {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      [
            [1],
            [2],
            [3],
          ]
    );
  });

  it("test_edgeql_functions_inline_tuple_04", () => {
    h.script(
      `
            create function foo(
                x: tuple<int64>
            ) -> int64 {
                set is_inlined := true;
                using (x.0);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_tuple_05", () => {
    h.script(
      `
            create function foo(x: int64) -> tuple<a: int64> {
                set is_inlined := true;
                using ((a:=x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            {
              "a": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      [
            {
              "a": 1,
            },
            {
              "a": 2,
            },
            {
              "a": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_tuple_06", () => {
    h.script(
      `
            create function foo(
                x: tuple<a: int64>
            ) -> tuple<a: int64> {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [
            {
              "a": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      [
            {
              "a": 1,
            },
            {
              "a": 2,
            },
            {
              "a": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_tuple_07", () => {
    h.script(
      `
            create function foo(
                x: tuple<a: int64> = (a:=9)
            ) -> tuple<a: int64> {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            {
              "a": 9,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [
            {
              "a": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      [
            {
              "a": 1,
            },
            {
              "a": 2,
            },
            {
              "a": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_tuple_08", () => {
    h.script(
      `
            create function foo(
                x: tuple<a: int64>
            ) -> int64 {
                set is_inlined := true;
                using (x.a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      [1, 2, 3]
    );
  });

  it("test_edgeql_functions_inline_object_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: int64) -> optional Bar {
                set is_inlined := true;
                using ((select Bar{a} filter .a = x limit 1));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(-1).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_object_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: Bar) -> Bar {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_object_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: optional Bar) -> optional Bar {
                set is_inlined := true;
                using (x ?? (select Bar filter .a = 1 limit 1));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_object_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: Bar) -> int64 {
                set is_inlined := true;
                using (x.a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_object_05", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: Bar) -> set of Bar {
                set is_inlined := true;
                using ((select Bar{a} filter .a <= x.a));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 1, 1, 2, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_object_06", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using ((select Bar{a} filter .a <= x).a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1,2,3})`,
      unorderedBag([1, 1, 1, 2, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_object_07", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo() -> int64 {
                set is_inlined := true;
                using (count(Bar));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [3]
    );
    assertQueryResult(
      h,
      `select (foo(), foo())`,
      unorderedBag([
            [3, 3],
          ])
    );
    assertQueryResult(
      h,
      `select (Bar.a, foo())`,
      unorderedBag([
            [1, 3],
            [2, 3],
            [3, 3],
          ])
    );
    assertQueryResult(
      h,
      `select (foo(), Bar.a)`,
      unorderedBag([
            [3, 1],
            [3, 2],
            [3, 3],
          ])
    );
    assertQueryResult(
      h,
      `select (Bar.a, foo(), Bar.a, foo())`,
      unorderedBag([
            [1, 3, 1, 3],
            [2, 3, 2, 3],
            [3, 3, 3, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_object_08", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo() -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (for Bar in Bar union (Bar.a, count(Bar)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [1, 1],
            [2, 1],
            [3, 1],
          ]
    );
    assertQueryResult(
      h,
      `select (foo(), foo())`,
      unorderedBag([
            [
              [1, 1],
              [1, 1],
            ],
            [
              [1, 1],
              [2, 1],
            ],
            [
              [1, 1],
              [3, 1],
            ],
            [
              [2, 1],
              [1, 1],
            ],
            [
              [2, 1],
              [2, 1],
            ],
            [
              [2, 1],
              [3, 1],
            ],
            [
              [3, 1],
              [1, 1],
            ],
            [
              [3, 1],
              [2, 1],
            ],
            [
              [3, 1],
              [3, 1],
            ],
          ])
    );
    assertQueryResult(
      h,
      `select (Bar.a, foo())`,
      unorderedBag([
            [
              1,
              [1, 1],
            ],
            [
              1,
              [2, 1],
            ],
            [
              1,
              [3, 1],
            ],
            [
              2,
              [1, 1],
            ],
            [
              2,
              [2, 1],
            ],
            [
              2,
              [3, 1],
            ],
            [
              3,
              [1, 1],
            ],
            [
              3,
              [2, 1],
            ],
            [
              3,
              [3, 1],
            ],
          ])
    );
    assertQueryResult(
      h,
      `select (foo(), Bar.a)`,
      unorderedBag([
            [
              [1, 1],
              1,
            ],
            [
              [1, 1],
              2,
            ],
            [
              [1, 1],
              3,
            ],
            [
              [2, 1],
              1,
            ],
            [
              [2, 1],
              2,
            ],
            [
              [2, 1],
              3,
            ],
            [
              [3, 1],
              1,
            ],
            [
              [3, 1],
              2,
            ],
            [
              [3, 1],
              3,
            ],
          ])
    );
  });

  it("test_edgeql_functions_inline_object_09", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: Bar) -> tuple<int64, int64> {
                set is_inlined := true;
                using ((x.a, count(Bar)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select (Bar.a, foo((select Bar filter .a = 1)))`,
      [
            [
              1,
              [1, 3],
            ],
          ]
    );
    assertQueryResult(
      h,
      `select (Bar.a, foo((select detached Bar filter .a = 1)))`,
      unorderedBag([
            [
              1,
              [1, 3],
            ],
            [
              2,
              [1, 3],
            ],
            [
              3,
              [1, 3],
            ],
          ])
    );
    assertQueryResult(
      h,
      `select (Bar.a, foo(Bar))`,
      unorderedBag([
            [
              1,
              [1, 3],
            ],
            [
              2,
              [2, 3],
            ],
            [
              3,
              [3, 3],
            ],
          ])
    );
    assertQueryResult(
      h,
      `select (foo(Bar), foo(Bar))`,
      unorderedBag([
            [
              [1, 3],
              [1, 3],
            ],
            [
              [2, 3],
              [2, 3],
            ],
            [
              [3, 3],
              [3, 3],
            ],
          ])
    );
    assertQueryResult(
      h,
      `select (foo(Bar), foo(detached Bar))`,
      unorderedBag([
            [
              [1, 3],
              [1, 3],
            ],
            [
              [1, 3],
              [2, 3],
            ],
            [
              [1, 3],
              [3, 3],
            ],
            [
              [2, 3],
              [1, 3],
            ],
            [
              [2, 3],
              [2, 3],
            ],
            [
              [2, 3],
              [3, 3],
            ],
            [
              [3, 3],
              [1, 3],
            ],
            [
              [3, 3],
              [2, 3],
            ],
            [
              [3, 3],
              [3, 3],
            ],
          ])
    );
  });

  it("test_edgeql_functions_inline_object_10", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function foo(x: Bar) -> set of Baz {
                set is_inlined := true;
                using ((select Baz filter .b <= x.a));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([4, 4, 4, 5, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_object_11", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function foo(x: Bar | Baz) -> Bar | Baz {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar | Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select foo((select Baz filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Baz)).a`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select foo((select {Bar, Baz})).a`,
      unorderedBag([1, 2, 3, 4, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_object_12", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function foo(x: int64) -> optional Bar | Baz {
                set is_inlined := true;
                using ((select {Bar, Baz} filter .a = x limit 1));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 4}).a`,
      unorderedBag([1, 4])
    );
    assertQueryResult(
      h,
      `select foo({0, 1, 2, 3, 4, 5, 6, 7, 8}).a`,
      unorderedBag([1, 2, 3, 4, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_object_13", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function foo(x: Bar | Baz) -> optional Bar {
                set is_inlined := true;
                using (x[is Bar]);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar | Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select foo((select Baz filter .a = 4)).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Baz)).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select {Bar, Baz})).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_object_14", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function foo(x: Bar | Baz) -> optional int64 {
                set is_inlined := true;
                using (
                    x[is Baz].b
                )
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Baz>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar | Baz>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1))`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar))`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select foo((select Baz filter .a = 4))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Baz))`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select foo((select {Bar, Baz}))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_object_15", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function foo(x: Bar | Baz) -> optional int64 {
                set is_inlined := true;
                using (
                    if x is Bar
                    then x.a*2
                    else 10 + assert_exists(x[is Baz]).b
                )
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Baz>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar | Baz>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1))`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo((select Bar))`,
      unorderedBag([2, 4, 6])
    );
    assertQueryResult(
      h,
      `select foo((select Baz filter .a = 4))`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo((select Baz))`,
      unorderedBag([11, 12, 13])
    );
    assertQueryResult(
      h,
      `select foo((select {Bar, Baz}))`,
      unorderedBag([2, 4, 6, 11, 12, 13])
    );
  });

  it("test_edgeql_functions_inline_object_16", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Bar2 extending Bar;
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Bar2{a := 4};
            insert Bar2{a := 5};
            insert Bar2{a := 6};
            create function foo(x: Bar) -> optional Bar2 {
                set is_inlined := true;
                using (x[is Bar2]);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar2>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Bar2 filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select foo((select Bar2)).a`,
      unorderedBag([4, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_object_17", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{
                b := 4,
                bar := assert_exists((select Bar filter .a = 1 limit 1)),
            };
            insert Baz{
                b := 5,
                bar := assert_exists((select Bar filter .a = 2 limit 1)),
            };
            insert Baz{
                b := 6,
                bar := assert_exists((select Bar filter .a = 3 limit 1)),
            };
            create function foo(x: Baz) -> Bar {
                set is_inlined := true;
                using (x.bar);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Baz filter .b = 4)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Baz)).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_shape_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select Bar{    a,    b := foo(.a)} order by .a`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 3,
              "b": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_02", () => {
    h.script(
      `
            create type Bar {
                create property a -> int64;
            };
            insert Bar{};
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: optional int64) -> optional int64 {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select Bar{    a,    b := foo(.a)} order by .a`,
      [
            {
              "a": null,
              "b": null,
            },
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 3,
              "b": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: optional int64) -> set of int64 {
                set is_inlined := true;
                using ({10 + x, 20 + x, 30 + x});
            };
        `
    );
    assertQueryResult(
      h,
      `select Bar{    a,    b := foo(.a)} order by .a`,
      [
            {
              "a": 1,
              "b": [11, 21, 31],
            },
            {
              "a": 2,
              "b": [12, 22, 32],
            },
            {
              "a": 3,
              "b": [13, 23, 33],
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo() -> int64 {
                set is_inlined := true;
                using (count(Bar));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [3]
    );
    assertQueryResult(
      h,
      `select Bar {    a,    n := foo(),} order by .a`,
      [
            {
              "a": 1,
              "n": 3,
            },
            {
              "a": 2,
              "n": 3,
            },
            {
              "a": 3,
              "n": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_05", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo() -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (for Bar in Bar union (Bar.a, count(Bar)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [1, 1],
            [2, 1],
            [3, 1],
          ]
    );
    assertQueryResult(
      h,
      `select Bar {    a,    n := foo(),} order by .a`,
      [
            {
              "a": 1,
              "n": [
                [1, 1],
                [2, 1],
                [3, 1],
              ],
            },
            {
              "a": 2,
              "n": [
                [1, 1],
                [2, 1],
                [3, 1],
              ],
            },
            {
              "a": 3,
              "n": [
                [1, 1],
                [2, 1],
                [3, 1],
              ],
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_06", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: Bar) -> tuple<int64, int64> {
                set is_inlined := true;
                using ((x.a, count(Bar)));
            };
        `
    );
    assertQueryResult(
      h,
      `select Bar {    a,    n := foo(Bar),} order by .a`,
      [
            {
              "a": 1,
              "n": [1, 3],
            },
            {
              "a": 2,
              "n": [2, 3],
            },
            {
              "a": 3,
              "n": [3, 3],
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_07", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using (assert_exists((select Bar filter .a = x limit 1)));
            };
        `
    );
    assertQueryResult(
      h,
      `select Baz{    a,    c := foo(.b).a,} order by .a`,
      [
            {
              "a": 4,
              "c": 1,
            },
            {
              "a": 5,
              "c": 2,
            },
            {
              "a": 6,
              "c": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_08", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            insert Baz{a := 7, b := 4};
            create function foo(x: int64) -> optional Bar {
                set is_inlined := true;
                using ((select Bar filter .a = x limit 1));
            };
        `
    );
    assertQueryResult(
      h,
      `select Baz{    a,    c := foo(.b).a,} order by .a`,
      [
            {
              "a": 4,
              "c": 1,
            },
            {
              "a": 5,
              "c": 2,
            },
            {
              "a": 6,
              "c": 3,
            },
            {
              "a": 7,
              "c": null,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_09", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((select Bar filter .a <= x));
            };
        `
    );
    assertQueryResult(
      h,
      `select Baz{    a,    c := foo(.b).a,} order by .a`,
      [
            {
              "a": 4,
              "c": [1],
            },
            {
              "a": 5,
              "c": [1, 2],
            },
            {
              "a": 6,
              "c": [1, 2, 3],
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_10", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{
                b := 4,
                bar := assert_exists((select Bar filter .a = 1 limit 1)),
            };
            insert Baz{
                b := 5,
                bar := assert_exists((select Bar filter .a = 2 limit 1)),
            };
            insert Baz{
                b := 6,
                bar := assert_exists((select Bar filter .a = 3 limit 1)),
            };
            create function foo(x: Bar) -> Bar {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select Baz{    a := foo(.bar).a,    b,} order by .a`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_11", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{
                b := 4,
                bar := assert_exists((select Bar filter .a = 1 limit 1)),
            };
            insert Baz{
                b := 5,
                bar := assert_exists((select Bar filter .a = 2 limit 1)),
            };
            insert Baz{
                b := 6,
                bar := assert_exists((select Bar filter .a = 3 limit 1)),
            };
            create function foo(x: Bar) -> int64 {
                set is_inlined := true;
                using (x.a);
            };
        `
    );
    assertQueryResult(
      h,
      `select Baz{    a := foo(.bar),    b,} order by .a`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_12", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create multi link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{
                b := 4,
                bar := assert_exists((select Bar filter .a <= 1)),
            };
            insert Baz{
                b := 5,
                bar := assert_exists((select Bar filter .a <= 2)),
            };
            insert Baz{
                b := 6,
                bar := assert_exists((select Bar filter .a <= 3)),
            };
            create function foo(x: Bar) -> Bar {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select Baz{    a := foo(.bar).a,    b,} order by .b`,
      [
            {
              "a": [1],
              "b": 4,
            },
            {
              "a": [1, 2],
              "b": 5,
            },
            {
              "a": [1, 2, 3],
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_shape_13", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required link bar -> Bar {
                    create property b -> int64;
                };
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{
                bar := assert_exists((select Bar filter .a = 1 limit 1)) {
                    @b := 4
                },
            };
            insert Baz{
                bar := assert_exists((select Bar filter .a = 2 limit 1)) {
                    @b := 5
                }
            };
            insert Baz{
                bar := assert_exists((select Bar filter .a = 3 limit 1)) {
                    @b := 6
                }
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
        `
    );
    assertQueryResult(
      h,
      `select Baz{    a := .bar.a,    b := foo(.bar@b),} order by .a`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_global_01", () => {
    h.script(
      `
            create global a := 1;
            create function foo() -> int64 {
                set is_inlined := true;
                using (global a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [1]
    );
  });

  it("test_edgeql_functions_inline_global_02", () => {
    h.script(
      `
            create global a -> int64;
            create function foo() -> optional int64 {
                set is_inlined := true;
                using (global a);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      []
    );
    h.script(
      `
            set global a := 1;
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [1]
    );
  });

  it("test_edgeql_functions_inline_global_03", () => {
    h.script(
      `
            create global a := 1;
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (global a + x);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_global_04", () => {
    h.script(
      `
            create global a -> int64;
            create function foo(x: int64) -> optional int64 {
                set is_inlined := true;
                using (global a + x)
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([])
    );
    h.script(
      `
            set global a := 1;
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_01", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x)
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (inner(x))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_02", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x * x)
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (inner(x + 1))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([4, 9, 16])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([4, 9, 16])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_03", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x * x)
            };
            create function foo(x: int64, y: int64) -> int64 {
                set is_inlined := true;
                using (inner(x) + inner(y));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}, 1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1, 10)`,
      [101]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, 10)`,
      unorderedBag([101, 104, 109])
    );
    assertQueryResult(
      h,
      `select foo(1, {10, 20, 30})`,
      unorderedBag([101, 401, 901])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}, {10, 20, 30})`,
      unorderedBag([
            101,
            104,
            109,
            401,
            404,
            409,
            901,
            904,
            909,
          ])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    for y in {10, 20, 30} union (        select foo(x, y)    ))`,
      unorderedBag([
            101,
            104,
            109,
            401,
            404,
            409,
            901,
            904,
            909,
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_04", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x * x)
            };
            create function foo(x: int64 = 9) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [81]
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 4, 9])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 4, 9])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_05", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x * x)
            };
            create function foo(x: int64 = 9) -> int64 {
                set is_inlined := true;
                using (inner(x+1));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [100]
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([4, 9, 16])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([4, 9, 16])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_06", () => {
    h.script(
      `
            create function inner(x: int64 = 9) -> int64 {
                set is_inlined := true;
                using (x * x)
            };
            create function foo1() -> int64 {
                set is_inlined := true;
                using (inner());
            };
            create function foo2(x: int64) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo1()`,
      [81]
    );
    assertQueryResult(
      h,
      `select foo2(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo2(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo2({1, 2, 3})`,
      unorderedBag([1, 4, 9])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo2(x))`,
      unorderedBag([1, 4, 9])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_07", () => {
    h.script(
      `
            create function inner(x: optional int64) -> optional int64 {
                set is_inlined := true;
                using (x * x)
            };
            create function foo(x: optional int64) -> int64 {
                set is_inlined := true;
                using (inner(x) ?? 99);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 4, 9])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 4, 9])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_08", () => {
    h.script(
      `
            create function inner(x: optional int64) -> optional int64 {
                set is_inlined := true;
                using (x * x)
            };
            create function foo(x: optional int64) -> int64 {
                set is_inlined := true;
                using (inner(x+1) ?? 99);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([4, 9, 16])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([4, 9, 16])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_09", () => {
    h.script(
      `
            create function inner(x: optional int64) -> int64 {
                set is_inlined := true;
                using ((x * x) ?? 99)
            };
            create function foo1() -> int64 {
                set is_inlined := true;
                using (inner(<int64>{}));
            };
            create function foo2(x: int64) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo1()`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo2(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo2(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo2({1, 2, 3})`,
      unorderedBag([1, 4, 9])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo2(x))`,
      unorderedBag([1, 4, 9])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_10", () => {
    h.script(
      `
            create function inner(x: array<int64>) -> int64 {
                set is_inlined := true;
                using (sum(array_unpack(x)))
            };
            create function foo(variadic x: int64) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [0]
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo(1, 2, 3)`,
      unorderedBag([6])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select foo({1, 2}, {10, 20})`,
      unorderedBag([11, 12, 21, 22])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_11", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x)
            };
            create function foo(variadic x: int64) -> int64 {
                set is_inlined := true;
                using (inner(sum(array_unpack(x))));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [0]
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo(1, 2, 3)`,
      unorderedBag([6])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select foo({1, 2}, {10, 20})`,
      unorderedBag([11, 12, 21, 22])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_12", () => {
    h.script(
      `
            create function inner(variadic x: int64) -> int64 {
                set is_inlined := true;
                using (sum(array_unpack(x)))
            };
            create function foo1() -> int64 {
                set is_inlined := true;
                using (inner());
            };
            create function foo2(x: int64, y: int64, z: int64) -> int64 {
                set is_inlined := true;
                using (inner(x, y, z));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo1()`,
      [0]
    );
    assertQueryResult(
      h,
      `select foo2(<int64>{}, <int64>{}, <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo2(1, 2, 3)`,
      unorderedBag([6])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo2(x, x * 10, x * 100))`,
      unorderedBag([111, 222, 333])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_13", () => {
    h.script(
      `
            create function inner(named only a: int64) -> int64 {
                set is_inlined := true;
                using (a * a)
            };
            create function foo(named only a: int64) -> int64 {
                set is_inlined := true;
                using (inner(a := a));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(a := 1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo(a := {1, 2, 3})`,
      unorderedBag([1, 4, 9])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(a := x))`,
      unorderedBag([1, 4, 9])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_14", () => {
    h.script(
      `
            create function inner(named only a: int64) -> int64 {
                set is_inlined := true;
                using (a * a)
            };
            create function foo(named only a: int64) -> int64 {
                set is_inlined := true;
                using (inner(a := a + 1));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(a := 1)`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo(a := {1, 2, 3})`,
      unorderedBag([4, 9, 16])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(a := x))`,
      unorderedBag([4, 9, 16])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_15", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x * x)
            };
            create function foo(named only a: int64) -> int64 {
                set is_inlined := true;
                using (inner(a));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(a := <int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(a := 1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo(a := {1, 2, 3})`,
      unorderedBag([1, 4, 9])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(a := x))`,
      unorderedBag([1, 4, 9])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_16", () => {
    h.script(
      `
            create function inner(named only a: int64) -> int64 {
                set is_inlined := true;
                using (a * a)
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (inner(a := x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([1, 4, 9])
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 4, 9])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_17", () => {
    h.script(
      `
            create function inner1(x: int64, y: int64) -> int64 {
                set is_inlined := true;
                using (x + y)
            };
            create function inner2(x: array<int64>) -> int64 {
                set is_inlined := true;
                using (sum(array_unpack(x)))
            };
            create function foo(
                x: int64,
                y: int64 = 90,
                variadic z: int64,
                named only a: int64,
                named only b: int64 = 90000
            ) -> int64 {
                set is_inlined := true;
                using (inner1(x, a) + inner1(y, b) + inner2(z));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, a := 1000)`,
      [91091]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, a := 1000)`,
      [91011]
    );
    assertQueryResult(
      h,
      `select foo(1, a := 1000, b := 10000)`,
      [11091]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, a := 1000, b := 10000)`,
      [11011]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, 100, a := 1000)`,
      [91111]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, 100, a := 1000, b := 10000)`,
      [11111]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, 100, 200, a := 1000)`,
      [91311]
    );
    assertQueryResult(
      h,
      `select foo(1, 10, 100, 200, a := 1000, b := 10000)`,
      [11311]
    );
  });

  it("test_edgeql_functions_inline_nested_basic_18", () => {
    h.script(
      `
            create function inner(x: int64) -> set of int64 {
                set is_inlined := true;
                using (for y in {x, x + 1, x + 2} union (y))
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(10)`,
      [10, 11, 12]
    );
    assertQueryResult(
      h,
      `select foo({10, 20, 30})`,
      unorderedBag([
            10,
            11,
            12,
            20,
            21,
            22,
            30,
            31,
            32,
          ])
    );
    assertQueryResult(
      h,
      `for x in {10, 20, 30} union (select foo(x))`,
      unorderedBag([
            10,
            11,
            12,
            20,
            21,
            22,
            30,
            31,
            32,
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_19", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x)
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (for y in {x, x + 1, x + 2} union (inner(y)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(10)`,
      [10, 11, 12]
    );
    assertQueryResult(
      h,
      `select foo({10, 20, 30})`,
      unorderedBag([
            10,
            11,
            12,
            20,
            21,
            22,
            30,
            31,
            32,
          ])
    );
    assertQueryResult(
      h,
      `for x in {10, 20, 30} union (select foo(x))`,
      unorderedBag([
            10,
            11,
            12,
            20,
            21,
            22,
            30,
            31,
            32,
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_20", () => {
    h.script(
      `
            create function inner1(x: int64) -> int64 {
                set is_inlined := true;
                using (x+1)
            };
            create function inner2(x: int64) -> int64 {
                set is_inlined := true;
                using (inner1(x+2))
            };
            create function inner3(x: int64) -> int64 {
                set is_inlined := true;
                using (inner2(x+3))
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (inner3(x+4))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [11]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([11, 12, 13])
    );
  });

  it("test_edgeql_functions_inline_nested_basic_21", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (select x)
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (for y in {x, x + 1, x + 2} union (inner(y)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(10)`,
      [10, 11, 12]
    );
    assertQueryResult(
      h,
      `select foo({10, 20, 30})`,
      unorderedBag([
            10,
            11,
            12,
            20,
            21,
            22,
            30,
            31,
            32,
          ])
    );
    assertQueryResult(
      h,
      `for x in {10, 20, 30} union (select foo(x))`,
      unorderedBag([
            10,
            11,
            12,
            20,
            21,
            22,
            30,
            31,
            32,
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_array_01", () => {
    h.script(
      `
            create function inner(x: int64) -> array<int64> {
                set is_inlined := true;
                using ([x]);
            };
            create function foo(x: int64) -> array<int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_array_02", () => {
    h.script(
      `
            create function inner(x: array<int64>) -> int64 {
                set is_inlined := true;
                using (x[0]);
            };
            create function foo(x: array<int64>) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([1, 2])
    );
  });

  it("test_edgeql_functions_inline_nested_array_03", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: array<int64>) -> int64 {
                set is_inlined := true;
                using (inner(x[0]));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([1, 2])
    );
  });

  it("test_edgeql_functions_inline_nested_array_04", () => {
    h.script(
      `
            create function inner(x: array<int64>) -> array<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: array<int64>) -> array<int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([
            [1],
            [2, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_array_05", () => {
    h.script(
      `
            create function inner(x: array<int64>) -> array<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: array<int64>) -> array<int64> {
                set is_inlined := true;
                using (inner((select x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([
            [1],
            [2, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_array_06", () => {
    h.script(
      `
            create function inner(x: array<int64>) -> array<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: int64) -> array<int64> {
                set is_inlined := true;
                using (inner([x]));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_array_07", () => {
    h.script(
      `
            create function inner(x: array<int64>) -> array<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: array<int64> = [9]
            ) -> array<int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([
            [1],
            [2, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_array_08", () => {
    h.script(
      `
            create function inner(x: array<int64>) -> array<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: array<int64> = [9]
            ) -> array<int64> {
                set is_inlined := true;
                using (inner((select x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([
            [1],
            [2, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_array_09", () => {
    h.script(
      `
            create function inner(x: array<int64> = [9]) -> array<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo1() -> array<int64> {
                set is_inlined := true;
                using (inner());
            };
            create function foo2(
                x: array<int64>
            ) -> array<int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo1()`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `select foo2(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo2([1])`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo2({[1], [2, 3]})`,
      unorderedBag([
            [1],
            [2, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_array_10", () => {
    h.script(
      `
            create function inner(x: array<int64>) -> set of int64 {
                set is_inlined := true;
                using (array_unpack(x));
            };
            create function foo(x: array<int64>) -> set of int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_array_11", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: array<int64>) -> set of int64 {
                set is_inlined := true;
                using (inner(array_unpack(x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<array<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo([1])`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({[1], [2, 3]})`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_01", () => {
    h.script(
      `
            create function inner(x: int64) -> tuple<int64> {
                set is_inlined := true;
                using ((x,));
            };
            create function foo(x: int64) -> tuple<int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}).0`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_02", () => {
    h.script(
      `
            create function inner(x: int64) -> tuple<a: int64> {
                set is_inlined := true;
                using ((a := x));
            };
            create function foo(x: int64) -> tuple<a: int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            {
              "a": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}) order by .a`,
      [
            {
              "a": 1,
            },
            {
              "a": 2,
            },
            {
              "a": 3,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_03", () => {
    h.script(
      `
            create function inner(
                x: tuple<int64>
            ) -> int64 {
                set is_inlined := true;
                using (x.0);
            };
            create function foo(
                x: tuple<int64>
            ) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_04", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: tuple<int64>
            ) -> int64 {
                set is_inlined := true;
                using (inner(x.0));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      [1, 2, 3]
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_05", () => {
    h.script(
      `
            create function inner(
                x: tuple<a: int64>
            ) -> int64 {
                set is_inlined := true;
                using (x.a);
            };
            create function foo(
                x: tuple<a: int64>
            ) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<a: int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((a := 1))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({(a := 1), (a := 2), (a := 3)})`,
      [1, 2, 3]
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_06", () => {
    h.script(
      `
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: tuple<a: int64>
            ) -> int64 {
                set is_inlined := true;
                using (inner(x.a));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((a := 1))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({(a := 1), (a := 2), (a := 3)})`,
      [1, 2, 3]
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_07", () => {
    h.script(
      `
            create function inner(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_08", () => {
    h.script(
      `
            create function inner(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (inner((select x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_09", () => {
    h.script(
      `
            create function inner(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: int64
            ) -> tuple<int64> {
                set is_inlined := true;
                using (inner((x,)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1],
            [2],
            [3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_10", () => {
    h.script(
      `
            create function inner(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: tuple<int64> = (9,)
            ) -> tuple<int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      [
            [1],
            [2],
            [3],
          ]
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_11", () => {
    h.script(
      `
            create function inner(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo(
                x: tuple<int64> = (9,)
            ) -> tuple<int64> {
                set is_inlined := true;
                using (inner((select x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `select foo(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((1,))`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo({(1,), (2,), (3,)})`,
      [
            [1],
            [2],
            [3],
          ]
    );
  });

  it("test_edgeql_functions_inline_nested_tuple_12", () => {
    h.script(
      `
            create function inner(
                x: tuple<int64> = (9,)
            ) -> tuple<int64> {
                set is_inlined := true;
                using (x);
            };
            create function foo1() -> tuple<int64> {
                set is_inlined := true;
                using (inner());
            };
            create function foo2(
                x: tuple<int64>
            ) -> tuple<int64> {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo1()`,
      [
            [9],
          ]
    );
    assertQueryResult(
      h,
      `select foo2(<tuple<int64>>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo2((1,))`,
      [
            [1],
          ]
    );
    assertQueryResult(
      h,
      `select foo2({(1,), (2,), (3,)})`,
      [
            [1],
            [2],
            [3],
          ]
    );
  });

  it("test_edgeql_functions_inline_nested_object_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: Bar) -> Bar {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: Bar) -> Bar {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: Bar) -> Bar {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: Bar) -> Bar {
                set is_inlined := true;
                using (inner((select x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: Bar) -> Bar {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: int64) -> optional Bar {
                set is_inlined := true;
                using (inner((select Bar filter .a = x limit 1)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3, 4}).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: int64) -> optional Bar {
                set is_inlined := true;
                using ((select Bar filter .a = x limit 1));
            };
            create function foo(x: int64) -> optional Bar {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3, 4}).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_05", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: int64) -> optional Bar {
                set is_inlined := true;
                using ((select Bar filter .a = inner(x) limit 1));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3, 4}).a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_06", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((select Bar filter .a <= x));
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}).a`,
      unorderedBag([1, 1, 1, 2, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_07", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((select Bar filter .a <= inner(x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(2).a`,
      [1, 2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3}).a`,
      unorderedBag([1, 1, 1, 2, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_08", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: optional Bar) -> optional int64 {
                set is_inlined := true;
                using (x.a ?? 99);
            };
            create function foo(x: optional Bar) -> optional int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_09", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: optional Bar) -> optional int64 {
                set is_inlined := true;
                using (x.a ?? 99);
            };
            create function foo(x: optional Bar) -> optional int64 {
                set is_inlined := true;
                using (inner((select x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_10", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: optional Bar) -> int64 {
                set is_inlined := true;
                using (x.a ?? 99);
            };
            create function foo1() -> int64 {
                set is_inlined := true;
                using (inner(<Bar>{}));
            };
            create function foo2(x: Bar) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo1()`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo2(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo2((select Bar filter .a = 1))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo2((select Bar))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_object_11", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner() -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (for Bar in Bar select (Bar.a, count(Bar)));
            };
            create function foo() -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (inner());
            };
        `
    );
    assertQueryResult(
      h,
      `select foo()`,
      [
            [1, 1],
            [2, 1],
            [3, 1],
          ]
    );
    assertQueryResult(
      h,
      `select (foo(), foo())`,
      unorderedBag([
            [
              [1, 1],
              [1, 1],
            ],
            [
              [1, 1],
              [2, 1],
            ],
            [
              [1, 1],
              [3, 1],
            ],
            [
              [2, 1],
              [1, 1],
            ],
            [
              [2, 1],
              [2, 1],
            ],
            [
              [2, 1],
              [3, 1],
            ],
            [
              [3, 1],
              [1, 1],
            ],
            [
              [3, 1],
              [2, 1],
            ],
            [
              [3, 1],
              [3, 1],
            ],
          ])
    );
    assertQueryResult(
      h,
      `select (Bar.a, foo())`,
      unorderedBag([
            [
              1,
              [1, 1],
            ],
            [
              1,
              [2, 1],
            ],
            [
              1,
              [3, 1],
            ],
            [
              2,
              [1, 1],
            ],
            [
              2,
              [2, 1],
            ],
            [
              2,
              [3, 1],
            ],
            [
              3,
              [1, 1],
            ],
            [
              3,
              [2, 1],
            ],
            [
              3,
              [3, 1],
            ],
          ])
    );
    assertQueryResult(
      h,
      `select (foo(), Bar.a)`,
      unorderedBag([
            [
              [1, 1],
              1,
            ],
            [
              [1, 1],
              2,
            ],
            [
              [1, 1],
              3,
            ],
            [
              [2, 1],
              1,
            ],
            [
              [2, 1],
              2,
            ],
            [
              [2, 1],
              3,
            ],
            [
              [3, 1],
              1,
            ],
            [
              [3, 1],
              2,
            ],
            [
              [3, 1],
              3,
            ],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_object_12", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner1(x: Bar) -> int64 {
                set is_inlined := true;
                using (x.a);
            };
            create function inner2(x: Bar) -> int64 {
                set is_inlined := true;
                using (count(Bar));
            };
            create function foo(x: Bar) -> tuple<int64, int64> {
                set is_inlined := true;
                using ((inner1(x), inner2(x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1))`,
      [
            [1, 3],
          ]
    );
    assertQueryResult(
      h,
      `select (    foo((select Bar filter .a = 1)),    foo((select Bar filter .a = 2)),)`,
      [
            [
              [1, 3],
              [2, 3],
            ],
          ]
    );
    assertQueryResult(
      h,
      `select foo((select Bar))`,
      unorderedBag([
            [1, 3],
            [2, 3],
            [3, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_object_13", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function inner(x: Bar | Baz) -> Bar | Baz {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: Bar | Baz) -> Bar | Baz {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar | Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select foo((select Baz filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Baz)).a`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select foo((select {Bar, Baz})).a`,
      unorderedBag([1, 2, 3, 4, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_nested_object_14", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function inner(x: Bar | Baz) -> Bar | Baz {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: Bar | Baz) -> Bar | Baz {
                set is_inlined := true;
                using (inner((select x)));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar | Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select foo((select Baz filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Baz)).a`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select foo((select {Bar, Baz})).a`,
      unorderedBag([1, 2, 3, 4, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_nested_object_15", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function inner(x: Bar | Baz) -> Bar | Baz {
                set is_inlined := true;
                using (x);
            };
            create function foo1(x: Bar) -> Bar | Baz {
                set is_inlined := true;
                using (inner(x));
            };
            create function foo2(x: Baz) -> Bar | Baz {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo1(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo2(<Baz>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo1((select Bar filter .a = 1)).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo1((select Bar)).a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select foo2((select Baz filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo2((select Baz)).a`,
      unorderedBag([4, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_nested_object_16", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Bar2 extending Bar;
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Bar2{a := 4};
            insert Bar2{a := 5};
            insert Bar2{a := 6};
            create function inner(x: Bar) -> optional Bar2 {
                set is_inlined := true;
                using (x[is Bar2]);
            };
            create function foo(x: Bar) -> optional Bar2 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar2>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Bar2 filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select foo((select Bar2)).a`,
      unorderedBag([4, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_nested_object_17", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Bar2 extending Bar;
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Bar2{a := 4};
            insert Bar2{a := 5};
            insert Bar2{a := 6};
            create function inner(x: Bar2) -> optional Bar2 {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: Bar) -> optional Bar2 {
                set is_inlined := true;
                using (inner(x[is Bar2]));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(<Bar2>{}).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1)).a`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Bar2 filter .a = 4)).a`,
      [4]
    );
    assertQueryResult(
      h,
      `select foo((select Bar)).a`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select foo((select Bar2)).a`,
      unorderedBag([4, 5, 6])
    );
  });

  it("test_edgeql_functions_inline_nested_object_18", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required link bar -> Bar;
            };
            create type Bazz {
                create required link baz -> Baz;
            };
            insert Bazz{baz := (insert Baz{bar := (insert Bar{a := 1})})};
            insert Bazz{baz := (insert Baz{bar := (insert Bar{a := 2})})};
            insert Bazz{baz := (insert Baz{bar := (insert Bar{a := 3})})};
            create function inner1(x: Bar) -> int64 {
                set is_inlined := true;
                using (x.a);
            };
            create function inner2(x: Baz) -> int64 {
                set is_inlined := true;
                using (inner1(x.bar));
            };
            create function foo(x: Bazz) -> int64 {
                set is_inlined := true;
                using (inner2(x.baz));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bazz>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bazz filter .baz.bar.a = 1))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo((select Bazz))`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_shape_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: Bar) -> int64 {
                set is_inlined := true;
                using ((select x{a, b := inner(x.a)}).b);
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1))`,
      [1]
    );
    assertQueryResult(
      h,
      `select foo(Bar)`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_nested_shape_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: Bar) -> int64 {
                set is_inlined := true;
                using (x.a + 90);
            };
            create function foo(x: Bar) -> tuple<int64, int64> {
                set is_inlined := true;
                using (
                    with y := (select x{a, b := inner(x)})
                    select (y.a, y.b)
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<Bar>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo((select Bar filter .a = 1))`,
      [
            [1, 91],
          ]
    );
    assertQueryResult(
      h,
      `select foo(Bar)`,
      unorderedBag([
            [1, 91],
            [2, 92],
            [3, 93],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_shape_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x + 90);
            };
            create function foo(x: int64) -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (
                    with y := (select Bar{a, b := inner(x)})
                    for y in y
                    select (y.a, y.b)
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      unorderedBag([
            [1, 91],
            [2, 91],
            [3, 91],
          ])
    );
    assertQueryResult(
      h,
      `select foo(Bar.a)`,
      unorderedBag([
            [1, 91],
            [1, 92],
            [1, 93],
            [2, 91],
            [2, 92],
            [2, 93],
            [3, 91],
            [3, 92],
            [3, 93],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_shape_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function inner() -> int64 {
                set is_inlined := true;
                using (count(Bar));
            };
            create function foo(x: int64) -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (
                    with y := (select Bar{a, b := inner()} filter .a = x)
                    select (y.a, y.b)
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      unorderedBag([
            [1, 3],
          ])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1, 3],
            [2, 3],
            [3, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_shape_05", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property a -> int64;
                create required property b -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{a := 4, b := 1};
            insert Baz{a := 5, b := 2};
            insert Baz{a := 6, b := 3};
            create function inner(x: int64) -> Bar {
                set is_inlined := true;
                using (assert_exists((select Bar filter .a = x limit 1)));
            };
            create function foo(x: int64) -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (
                    with y := (select Baz{a, c := inner(.b).a} filter .b = x)
                    select (y.a, y.b)
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      unorderedBag([
            [4, 1],
          ])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [4, 1],
            [5, 2],
            [6, 3],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_shape_06", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{
                b := 4,
                bar := assert_exists((select Bar filter .a = 1 limit 1)),
            };
            insert Baz{
                b := 5,
                bar := assert_exists((select Bar filter .a = 2 limit 1)),
            };
            insert Baz{
                b := 6,
                bar := assert_exists((select Bar filter .a = 3 limit 1)),
            };
            create function inner(x: Bar) -> int64 {
                set is_inlined := true;
                using (x.a);
            };
            create function foo(x: int64) -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (
                    with y := (select Baz{a := inner(.bar), b} filter .a = x)
                    select (y.a, y.b)
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      unorderedBag([
            [1, 4],
          ])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1, 4],
            [2, 5],
            [3, 6],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_shape_07", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required link bar -> Bar {
                    create property b -> int64;
                };
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Baz{
                bar := assert_exists((select Bar filter .a = 1 limit 1)) {
                    @b := 4
                }
            };
            insert Baz{
                bar := assert_exists((select Bar filter .a = 2 limit 1)) {
                    @b := 5
                }
            };
            insert Baz{
                bar := assert_exists((select Bar filter .a = 3 limit 1)) {
                    @b := 6
                }
            };
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (x);
            };
            create function foo(x: int64) -> set of tuple<int64, int64> {
                set is_inlined := true;
                using (
                    with y := (
                        select Baz{a := .bar.a, b := inner(.bar@b)}
                        filter .a = x
                    )
                    select (y.a, y.b)
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      unorderedBag([
            [1, 4],
          ])
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([
            [1, 4],
            [2, 5],
            [3, 6],
          ])
    );
  });

  it("test_edgeql_functions_inline_nested_global_01", () => {
    h.script(
      `
            create global a := 1;
            create function inner(x: int64) -> int64 {
                set is_inlined := true;
                using (global a + x);
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_02", () => {
    h.script(
      `
            create global a -> int64;
            create function inner(x: int64) -> optional int64 {
                set is_inlined := true;
                using (global a + x);
            };
            create function foo(x: int64) -> optional int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([])
    );
    h.script(
      `
            set global a := 1;
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_03", () => {
    h.script(
      `
            create global a := 1;
            create function inner(x: int64, y: int64) -> int64 {
                set is_inlined := true;
                using (x + y);
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (inner(global a, x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_04", () => {
    h.script(
      `
            create global a -> int64;
            create function inner(x: int64, y: int64) -> optional int64 {
                set is_inlined := true;
                using (x + y);
            };
            create function foo(x: int64) -> optional int64 {
                set is_inlined := true;
                using (inner(global a, x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([])
    );
    h.script(
      `
            set global a := 1;
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_05", () => {
    h.script(
      `
            create global a := 1;
            create function inner(x: int64) -> int64 {
                using (global a + x);
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_06", () => {
    h.script(
      `
            create global a -> int64;
            create function inner(x: int64) -> optional int64 {
                using (global a + x);
            };
            create function foo(x: int64) -> optional int64 {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([])
    );
    h.script(
      `
            set global a := 1;
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_07", () => {
    h.script(
      `
            create global a := 1;
            create function inner1(x: int64) -> int64 {
                using (global a + x);
            };
            create function inner2(x: int64) -> int64 {
                set is_inlined := true;
                using (inner1(x));
            };
            create function foo(x: int64) -> int64 {
                using (inner2(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_08", () => {
    h.script(
      `
            create global a -> int64;
            create function inner1(x: int64) -> optional int64 {
                using (global a + x);
            };
            create function inner2(x: int64) -> optional int64 {
                set is_inlined := true;
                using (inner1(x));
            };
            create function foo(x: int64) -> optional int64 {
                using (inner2(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([])
    );
    h.script(
      `
            set global a := 1;
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_09", () => {
    h.script(
      `
            create global a := 1;
            create function inner1(x: int64) -> int64 {
                using (global a + x);
            };
            create function inner2(x: int64) -> int64 {
                set is_inlined := true;
                using (inner1(x));
            };
            create function inner3(x: int64) -> int64 {
                set is_inlined := true;
                using (inner2(x));
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using (inner3(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_nested_global_10", () => {
    h.script(
      `
            create global a -> int64;
            create function inner1(x: int64) -> optional int64 {
                using (global a + x);
            };
            create function inner2(x: int64) -> optional int64 {
                set is_inlined := true;
                using (inner1(x));
            };
            create function inner3(x: int64) -> optional int64 {
                set is_inlined := true;
                using (inner2(x));
            };
            create function foo(x: int64) -> optional int64 {
                set is_inlined := true;
                using (inner3(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      []
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([])
    );
    h.script(
      `
            set global a := 1;
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [2]
    );
    assertQueryResult(
      h,
      `select foo({1, 2, 3})`,
      unorderedBag([2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_modifying_cardinality_01", () => {
    h.script(
      `
            create function foo(x: int64) -> int64 {
                set volatility := schema::Volatility.Modifying;
                using (x)
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
  });

  it("test_edgeql_functions_inline_modifying_cardinality_02", () => {
    h.script(
      `
            create function foo(x: int64) -> int64 {
                set volatility := schema::Volatility.Modifying;
                using (x)
            };
        `
    );
    expect(() => {
      h.script(
        `
                select foo(<int64>{})
            `
      );
    }).toThrow(new RegExp("possibly an empty set passed as non-optional argument into modifying function"));
  });

  it("test_edgeql_functions_inline_modifying_cardinality_03", () => {
    h.script(
      `
            create function foo(x: int64) -> int64 {
                set volatility := schema::Volatility.Modifying;
                using (x)
            };
        `
    );
    expect(() => {
      h.script(
        `
                select foo({1, 2, 3})
            `
      );
    }).toThrow(new RegExp("possibly more than one element passed into modifying function"));
  });

  it("test_edgeql_functions_inline_modifying_cardinality_04", () => {
    h.script(
      `
            create function foo(x: optional int64) -> optional int64 {
                set volatility := schema::Volatility.Modifying;
                using (x)
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
  });

  it("test_edgeql_functions_inline_modifying_cardinality_05", () => {
    h.script(
      `
            create function foo(x: optional int64) -> optional int64 {
                set volatility := schema::Volatility.Modifying;
                using (x)
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      []
    );
  });

  it("test_edgeql_functions_inline_modifying_cardinality_06", () => {
    h.script(
      `
            create function foo(x: optional int64) -> optional int64 {
                set volatility := schema::Volatility.Modifying;
                using (x)
            };
        `
    );
    expect(() => {
      h.script(
        `
                select foo({1, 2, 3})
            `
      );
    }).toThrow(new RegExp("possibly more than one element passed into modifying function"));
  });

  it("test_edgeql_functions_inline_insert_basic_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo() -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := 1 }));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo().a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
  });

  it("test_edgeql_functions_inline_insert_basic_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
  });

  it("test_edgeql_functions_inline_insert_basic_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using ((insert Bar{ a := x }).a)
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
  });

  it("test_edgeql_functions_inline_insert_basic_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x + 1 }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [2]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [2]
    );
  });

  it("test_edgeql_functions_inline_insert_basic_05", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using ((insert Bar{ a := 2 * x + 1 }).a + 10)
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [13]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
  });

  it("test_edgeql_functions_inline_insert_basic_06", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64 = 0) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo().a`,
      [0]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [0]
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [0, 1]
    );
  });

  it("test_edgeql_functions_inline_insert_basic_07", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: optional int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x ?? 0 }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(<int64>{}).a`,
      [0]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [0]
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1])
    );
  });

  it("test_edgeql_functions_inline_insert_basic_08", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(named only x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(x := 1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
  });

  it("test_edgeql_functions_inline_insert_basic_09", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(variadic x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := sum(array_unpack(x)) }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo().a`,
      [0]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [0]
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1])
    );
    assertQueryResult(
      h,
      `select foo(2, 3).a`,
      [5]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 5])
    );
  });

  it("test_edgeql_functions_inline_insert_basic_10", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
                create required property b -> int64;
            };
            create function foo(x: int64, y: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x, b := y }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, 10){a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_basic_11", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }))
            };
        `
    );
    assertQueryResult(
      h,
      `with temp := foo(1)select temp.a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `with temp := (for x in {2, 3, 4} union (select foo(x)))select temp.a`,
      unorderedBag([2, 3, 4])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4])
    );
    assertQueryResult(
      h,
      `with temp := (if true then foo(5) else <Bar>{})select temp.a`,
      [5]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `with temp := (if false then foo(6) else <Bar>{})select temp.a`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `with temp := (if true then <Bar>{} else foo(7))select temp.a`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `with temp := (if false then <Bar>{} else foo(8))select temp.a`,
      [8]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5, 8])
    );
  });

  it("test_edgeql_functions_inline_insert_basic_12", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }))
            };
        `
    );
    assertQueryResult(
      h,
      `with temp := foo(1)select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `with temp := (for x in {2, 3, 4} union (select foo(x)))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4])
    );
    assertQueryResult(
      h,
      `with temp := (if true then foo(5) else <Bar>{})select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `with temp := (if false then foo(6) else <Bar>{})select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `with temp := (if true then <Bar>{} else foo(7))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `with temp := (if false then <Bar>{} else foo(8))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5, 8])
    );
  });

  it("test_edgeql_functions_inline_insert_iterator_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4} union (select foo(x).a)`,
      unorderedBag([2, 3, 4])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4])
    );
    assertQueryResult(
      h,
      `select if true then foo(5).a else 99`,
      [5]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `select if false then foo(6).a else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `select if true then 99 else foo(7).a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    assertQueryResult(
      h,
      `select if false then 99 else foo(8).a`,
      [8]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5, 8])
    );
    assertQueryResult(
      h,
      `select foo(9).a ?? 99`,
      [9]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            4,
            5,
            8,
            9,
          ])
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(10).a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            4,
            5,
            8,
            9,
          ])
    );
  });

  it("test_edgeql_functions_inline_insert_iterator_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
                create required property b -> int64;
            };
            create function foo(x: int64, y: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x, b := y }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, 10){a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    for x in {2, 3} union(        for y in {20, 30} union(            select foo(x, y)        )    )){a, b}order by .a then .b`,
      [
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then foo(5, 50)    else (select Bar filter .a = 1)){a, b}order by .a then .b`,
      [
            {
              "a": 5,
              "b": 50,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
            {
              "a": 5,
              "b": 50,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then foo(6, 60)    else (select Bar filter .a = 1)){a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
            {
              "a": 5,
              "b": 50,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then (select Bar filter .a = 1)    else foo(7, 70)){a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
            {
              "a": 5,
              "b": 50,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then (select Bar filter .a = 1)    else foo(8, 80)){a, b}order by .a then .b`,
      [
            {
              "a": 8,
              "b": 80,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
            {
              "a": 5,
              "b": 50,
            },
            {
              "a": 8,
              "b": 80,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (foo(9, 90) ?? (select Bar filter .a = 1)){a, b}`,
      [
            {
              "a": 9,
              "b": 90,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
            {
              "a": 5,
              "b": 50,
            },
            {
              "a": 8,
              "b": 80,
            },
            {
              "a": 9,
              "b": 90,
            },
          ]
    );
    assertQueryResult(
      h,
      `select ((select Bar filter .a = 1) ?? foo(10, 100)){a, b}`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar{a, b}order by .a then .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
            {
              "a": 5,
              "b": 50,
            },
            {
              "a": 8,
              "b": 80,
            },
            {
              "a": 9,
              "b": 90,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_iterator_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using (
                    for y in {x, x + 1, x + 2} union (
                        (insert Bar{ a := y })
                    )
                )
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `for x in {11, 21, 31} union (select foo(x).a)`,
      unorderedBag([
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
          ])
    );
    assertQueryResult(
      h,
      `select if true then foo(51).a else 99`,
      unorderedBag([51, 52, 53])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
            51,
            52,
            53,
          ])
    );
    assertQueryResult(
      h,
      `select if false then foo(61).a else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
            51,
            52,
            53,
          ])
    );
    assertQueryResult(
      h,
      `select if true then 99 else foo(71).a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
            51,
            52,
            53,
          ])
    );
    assertQueryResult(
      h,
      `select if false then 99 else foo(81).a`,
      unorderedBag([81, 82, 83])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
            51,
            52,
            53,
            81,
            82,
            83,
          ])
    );
    assertQueryResult(
      h,
      `select foo(91).a ?? 99`,
      [91, 92, 93]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
            51,
            52,
            53,
            81,
            82,
            83,
            91,
            92,
            93,
          ])
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(101).a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            3,
            11,
            12,
            13,
            21,
            22,
            23,
            31,
            32,
            33,
            51,
            52,
            53,
            81,
            82,
            83,
            91,
            92,
            93,
          ])
    );
  });

  it("test_edgeql_functions_inline_insert_iterator_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: bool, y: int64) -> optional Bar {
                set is_inlined := true;
                using (
                    if x then (insert Bar{ a := y }) else <Bar>{}
                )
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(false, 0).a`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    assertQueryResult(
      h,
      `select foo(true, 1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4, 5} union (select foo(x % 2 = 0, x).a)`,
      unorderedBag([2, 4])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4])
    );
    assertQueryResult(
      h,
      `select if true then foo(false, 6).a else 99`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4])
    );
    assertQueryResult(
      h,
      `select if true then foo(true, 6).a else 99`,
      [6]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6])
    );
    assertQueryResult(
      h,
      `select if false then foo(false, 7).a else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6])
    );
    assertQueryResult(
      h,
      `select if false then foo(true, 7).a else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6])
    );
    assertQueryResult(
      h,
      `select if true then 99 else foo(false, 8).a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6])
    );
    assertQueryResult(
      h,
      `select if true then 99 else foo(true, 8).a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6])
    );
    assertQueryResult(
      h,
      `select if false then 99 else foo(false, 9).a`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6])
    );
    assertQueryResult(
      h,
      `select if false then 99 else foo(true, 9).a`,
      [9]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6, 9])
    );
    assertQueryResult(
      h,
      `select foo(false, 10).a ?? 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6, 9])
    );
    assertQueryResult(
      h,
      `select foo(true, 10).a ?? 99`,
      [10]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6, 9, 10])
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(false, 11).a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6, 9, 10])
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(true, 11).a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 4, 6, 9, 10])
    );
  });

  it("test_edgeql_functions_inline_insert_correlate_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> tuple<Bar, int64> {
                set is_inlined := true;
                using (((insert Bar{ a := x }), x))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [
            [
              [],
              1,
            ],
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4} union (select foo(x).a)`,
      unorderedBag([2, 3, 4])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_insert_correlate_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> int64 {
                set is_inlined := true;
                using ((insert Bar{ a := 2 * x + 1 }).a + x * x)
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      [4]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4} union (select foo(x))`,
      unorderedBag([9, 16, 25])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 5, 7, 9])
    );
  });

  it("test_edgeql_functions_inline_insert_correlate_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> tuple<int64, int64> {
                set is_inlined := true;
                using ((
                    (insert Bar{ a := x }).a,
                    (insert Bar{ a := x + 1 }).a,
                ))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1)`,
      unorderedBag([
            [1, 2],
          ])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `for x in {11, 21, 31} union (select foo(x))`,
      unorderedBag([
            [11, 12],
            [21, 22],
            [31, 32],
          ])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            11,
            12,
            21,
            22,
            31,
            32,
          ])
    );
  });

  it("test_edgeql_functions_inline_insert_correlate_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64, y: int64) -> tuple<int64, int64> {
                set is_inlined := true;
                using ((
                    (insert Bar{ a := x }).a,
                    (insert Bar{ a := y }).a,
                ))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, 2)`,
      [
            [1, 2],
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `for x in {1, 5} union (    for y in {10, 20} union (        select foo(x + y, x + y + 1)    ))`,
      unorderedBag([
            [11, 12],
            [15, 16],
            [21, 22],
            [25, 26],
          ])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            1,
            2,
            11,
            12,
            15,
            16,
            21,
            22,
            25,
            26,
          ])
    );
  });

  it("test_edgeql_functions_inline_insert_correlate_05", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64, y: int64) -> int64 {
                set is_inlined := true;
                using ((insert Bar{ a := 2 * x + 1 }).a + y)
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, 10)`,
      [13]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    assertQueryResult(
      h,
      `for x in {2, 3} union(    for y in {20, 30} union(        select foo(x, y)    ))`,
      unorderedBag([25, 27, 35, 37])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 5, 5, 7, 7])
    );
  });

  it("test_edgeql_functions_inline_insert_conflict_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
                create constraint exclusive on (.a)
            };
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using ((
                    insert Bar{a := x}
                    unless conflict on .a
                    else ((update Bar set {a := x + 10}))
                ))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x).a)`,
      unorderedBag([2, 3, 11])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [2, 3, 11]
    );
  });

  it("test_edgeql_functions_inline_insert_conflict_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create type Baz {
                create link bar -> Bar;
                create constraint exclusive on (.bar)
            };
            create function foo(x: Bar) -> Baz {
                set is_inlined := true;
                using ((
                    insert Baz{bar := x}
                    unless conflict on .bar
                    else ((
                        update Baz set {bar := (insert Bar{a := x.a + 10})}
                    ))
                ))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(    assert_exists((select Bar filter .a = 1 limit 1))).bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1, 2, 3]
    );
    assertQueryResult(
      h,
      `select Baz.bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (    select foo(        assert_exists((select Bar filter .a = x limit 1))    ).bar.a)`,
      unorderedBag([2, 3, 11])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1, 2, 3, 11]
    );
    assertQueryResult(
      h,
      `select Baz.bar.a`,
      [2, 3, 11]
    );
  });

  it("test_edgeql_functions_inline_insert_link_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(n: int64, x: Bar) -> Baz {
                set is_inlined := true;
                using ((insert Baz{ b := n, bar := x }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(    4,    assert_exists((select Bar filter .a = 1 limit 1))){a := .bar.a, b}`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(    5,    assert_exists((select Bar filter .a = 2 limit 1))){a := .bar.a, b}`,
      [
            {
              "a": 2,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_link_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create multi link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: int64, y: int64) -> Baz {
                set is_inlined := true;
                using (
                    (insert Baz{
                        b := x,
                        bar := (select Bar filter .a <= y),
                    })
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(4, 1){a := .bar.a, b}`,
      [
            {
              "a": [1],
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz {    a := (select .bar order by .a).a,    b,} order by .b`,
      [
            {
              "a": [1],
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(5, 2){a := .bar.a, b}`,
      [
            {
              "a": [1, 2],
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz {    a := (select .bar order by .a).a,    b,} order by .b`,
      [
            {
              "a": [1],
              "b": 4,
            },
            {
              "a": [1, 2],
              "b": 5,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_link_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            create function foo(x: int64, y: int64) -> Baz {
                set is_inlined := true;
                using (
                    (insert Baz {
                        b := y,
                        bar := (insert Bar{ a := x })
                    })
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, 4).b`,
      [4]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(2, 5).b`,
      [5]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1, 2]
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_link_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar {a := x}))
            };
        `
    );
    assertQueryResult(
      h,
      `select (insert Baz{b := 4, bar := foo(1)}){a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (insert Baz{b := 5, bar := foo(2)}){a := .bar.a, b} order by .b`,
      [
            {
              "a": 2,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1, 2]
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_link_iterator_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Bar{a := 4};
            create function foo(n: int64, x: Bar) -> Baz {
                set is_inlined := true;
                using ((insert Baz{ b := n, bar := x }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(    1, assert_exists((select Bar filter .a = 1 limit 1))){a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4} union (    select foo(        x, assert_exists((select Bar filter .a = 2 limit 1))    ).b)`,
      unorderedBag([2, 3, 4])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then foo(        5, assert_exists((select Bar filter .a = 3 limit 1))    ).b    else 99)`,
      [5]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then foo(        6, assert_exists((select Bar filter .a = 3 limit 1))    ).b    else 99)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then 99    else foo(        7, assert_exists((select Bar filter .a = 3 limit 1))    ).b)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then 99    else foo(        8, assert_exists((select Bar filter .a = 3 limit 1))    ).b)`,
      [8]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
            {
              "a": 3,
              "b": 8,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(    9, assert_exists((select Bar filter .a = 4 limit 1))).b ?? 99`,
      [9]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
            {
              "a": 3,
              "b": 8,
            },
            {
              "a": 4,
              "b": 9,
            },
          ]
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(    9, assert_exists((select Bar filter .a = 4 limit 1))).b`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
            {
              "a": 3,
              "b": 8,
            },
            {
              "a": 4,
              "b": 9,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_link_iterator_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create multi link bar -> Bar;
            };
            create function foo(x: int64, y: int64) -> Baz {
                set is_inlined := true;
                using (
                    (insert Baz {
                        b := y,
                        bar := (for z in {x, x + 1, x + 2} union(
                            (insert Bar{ a := z })
                        ))
                    })
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(10, 1).b`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([10, 11, 12])
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b then sum(.a)`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `for x in {20, 30} union (    for y in {2, 3} union (        select foo(x, y).b    ))`,
      unorderedBag([2, 2, 3, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            10,
            11,
            12,
            20,
            20,
            21,
            21,
            22,
            22,
            30,
            30,
            31,
            31,
            32,
            32,
          ])
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b then sum(.a)`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
            {
              "a": [30, 31, 32],
              "b": 2,
            },
            {
              "a": [20, 21, 22],
              "b": 3,
            },
            {
              "a": [30, 31, 32],
              "b": 3,
            },
          ]
    );
    assertQueryResult(
      h,
      `select if true then foo(40, 4).b else 999`,
      [4]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            10,
            11,
            12,
            20,
            20,
            21,
            21,
            22,
            22,
            30,
            30,
            31,
            31,
            32,
            32,
            40,
            41,
            42,
          ])
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b then sum(.a)`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
            {
              "a": [30, 31, 32],
              "b": 2,
            },
            {
              "a": [20, 21, 22],
              "b": 3,
            },
            {
              "a": [30, 31, 32],
              "b": 3,
            },
            {
              "a": [40, 41, 42],
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select if false then foo(50, 5).b else 999`,
      [999]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            10,
            11,
            12,
            20,
            20,
            21,
            21,
            22,
            22,
            30,
            30,
            31,
            31,
            32,
            32,
            40,
            41,
            42,
          ])
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b then sum(.a)`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
            {
              "a": [30, 31, 32],
              "b": 2,
            },
            {
              "a": [20, 21, 22],
              "b": 3,
            },
            {
              "a": [30, 31, 32],
              "b": 3,
            },
            {
              "a": [40, 41, 42],
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select if true then 999 else foo(60, 6).b`,
      [999]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            10,
            11,
            12,
            20,
            20,
            21,
            21,
            22,
            22,
            30,
            30,
            31,
            31,
            32,
            32,
            40,
            41,
            42,
          ])
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b then sum(.a)`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
            {
              "a": [30, 31, 32],
              "b": 2,
            },
            {
              "a": [20, 21, 22],
              "b": 3,
            },
            {
              "a": [30, 31, 32],
              "b": 3,
            },
            {
              "a": [40, 41, 42],
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select if false then 999 else foo(70, 7).b`,
      [7]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            10,
            11,
            12,
            20,
            20,
            21,
            21,
            22,
            22,
            30,
            30,
            31,
            31,
            32,
            32,
            40,
            41,
            42,
            70,
            71,
            72,
          ])
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b then sum(.a)`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
            {
              "a": [30, 31, 32],
              "b": 2,
            },
            {
              "a": [20, 21, 22],
              "b": 3,
            },
            {
              "a": [30, 31, 32],
              "b": 3,
            },
            {
              "a": [40, 41, 42],
              "b": 4,
            },
            {
              "a": [70, 71, 72],
              "b": 7,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(80, 8).b ?? 999`,
      [8]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            10,
            11,
            12,
            20,
            20,
            21,
            21,
            22,
            22,
            30,
            30,
            31,
            31,
            32,
            32,
            40,
            41,
            42,
            70,
            71,
            72,
            80,
            81,
            82,
          ])
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b then sum(.a)`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
            {
              "a": [30, 31, 32],
              "b": 2,
            },
            {
              "a": [20, 21, 22],
              "b": 3,
            },
            {
              "a": [30, 31, 32],
              "b": 3,
            },
            {
              "a": [40, 41, 42],
              "b": 4,
            },
            {
              "a": [70, 71, 72],
              "b": 7,
            },
            {
              "a": [80, 81, 82],
              "b": 8,
            },
          ]
    );
    assertQueryResult(
      h,
      `select 999 ?? foo(90, 9).b`,
      [999]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([
            10,
            11,
            12,
            20,
            20,
            21,
            21,
            22,
            22,
            30,
            30,
            31,
            31,
            32,
            32,
            40,
            41,
            42,
            70,
            71,
            72,
            80,
            81,
            82,
          ])
    );
    assertQueryResult(
      h,
      `select Baz {a := .bar.a, b} order by .b then sum(.a)`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
            {
              "a": [30, 31, 32],
              "b": 2,
            },
            {
              "a": [20, 21, 22],
              "b": 3,
            },
            {
              "a": [30, 31, 32],
              "b": 3,
            },
            {
              "a": [40, 41, 42],
              "b": 4,
            },
            {
              "a": [70, 71, 72],
              "b": 7,
            },
            {
              "a": [80, 81, 82],
              "b": 8,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_link_iterator_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Bar{a := 4};
            create function foo(n: int64, x: Bar, flag: bool) -> optional Baz {
                set is_inlined := true;
                using (
                    if flag then (insert Baz{ b := n, bar := x }) else <Baz>{}
                )
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(    0, assert_exists((select Bar filter .a = 1 limit 1)), false){a := .bar.a, b} order by .a then .b`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      []
    );
    assertQueryResult(
      h,
      `select foo(    1, assert_exists((select Bar filter .a = 1 limit 1)), true){a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4} union (    select foo(        x,        assert_exists((select Bar filter .a = 3 limit 1)),        false,    ).b)`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4} union (    select foo(        x,        assert_exists((select Bar filter .a = 2 limit 1)),        true,    ).b)`,
      [2, 3, 4]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then foo(        5,        assert_exists((select Bar filter .a = 3 limit 1)),        false,    ).b    else 99)`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then foo(        6,        assert_exists((select Bar filter .a = 3 limit 1)),        false,    ).b    else 99)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then 99    else foo(        7,        assert_exists((select Bar filter .a = 3 limit 1)),        false,    ).b)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then 99    else foo(        8,        assert_exists((select Bar filter .a = 3 limit 1)),        false,    ).b)`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then foo(        9,        assert_exists((select Bar filter .a = 3 limit 1)),        true,    ).b    else 99)`,
      [9]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 9,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then foo(        10,        assert_exists((select Bar filter .a = 3 limit 1)),        true,    ).b    else 99)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 9,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then 99    else foo(        11,        assert_exists((select Bar filter .a = 3 limit 1)),        true,    ).b)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 9,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then 99    else foo(        12,        assert_exists((select Bar filter .a = 3 limit 1)),        true,    ).b)`,
      [12]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 9,
            },
            {
              "a": 3,
              "b": 12,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(    13, assert_exists((select Bar filter .a = 4 limit 1)), false).b ?? 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 9,
            },
            {
              "a": 3,
              "b": 12,
            },
          ]
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(    14, assert_exists((select Bar filter .a = 4 limit 1)), false).b`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 9,
            },
            {
              "a": 3,
              "b": 12,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(    15, assert_exists((select Bar filter .a = 4 limit 1)), true).b ?? 99`,
      [15]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 9,
            },
            {
              "a": 3,
              "b": 12,
            },
            {
              "a": 4,
              "b": 15,
            },
          ]
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(    16, assert_exists((select Bar filter .a = 4 limit 1)), true).b`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 9,
            },
            {
              "a": 3,
              "b": 12,
            },
            {
              "a": 4,
              "b": 15,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_linkprop_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required link bar -> Bar {
                    create property b -> int64;
                }
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(x: Bar) -> Baz {
                set is_inlined := true;
                using ((insert Baz{ bar := x { @b := 10 } }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(    assert_exists((select Bar filter .a = 1 limit 1))){a := .bar.a, b := .bar@b}`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_linkprop_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required link bar -> Bar {
                    create property b -> int64;
                }
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            create function foo(n: int64, x: Bar) -> Baz {
                set is_inlined := true;
                using ((insert Baz{ bar := x { @b := n } }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(    4,    assert_exists((select Bar filter .a = 1 limit 1))){a := .bar.a, b := .bar@b}`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_linkprop_iterator_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required link bar -> Bar {
                    create property b -> int64;
                }
            };
            insert Bar{a := 1};
            insert Bar{a := 2};
            insert Bar{a := 3};
            insert Bar{a := 4};
            create function foo(n: int64, x: Bar) -> Baz {
                set is_inlined := true;
                using ((insert Baz{ bar := x { @b := n } }))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(    1,    assert_exists((select Bar filter .a = 1 limit 1))){a := .bar.a, b := .bar@b}`,
      [
            {
              "a": 1,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a`,
      [
            {
              "a": 1,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4} union (    select foo(        x, assert_exists((select Bar filter .a = 2 limit 1))    ).bar@b)`,
      unorderedBag([2, 3, 4])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then foo(        5, assert_exists((select Bar filter .a = 3 limit 1))    ).bar@b    else 99)`,
      [5]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then foo(        6, assert_exists((select Bar filter .a = 3 limit 1))    ).bar@b    else 99)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if true    then 99    else foo(        7, assert_exists((select Bar filter .a = 3 limit 1))    ).bar@b)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    if false    then 99    else foo(        8, assert_exists((select Bar filter .a = 3 limit 1))    ).bar@b)`,
      [8]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
            {
              "a": 3,
              "b": 8,
            },
          ]
    );
    assertQueryResult(
      h,
      `select foo(    9, assert_exists((select Bar filter .a = 4 limit 1))).bar@b ?? 99`,
      [9]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
            {
              "a": 3,
              "b": 8,
            },
            {
              "a": 4,
              "b": 9,
            },
          ]
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(    9, assert_exists((select Bar filter .a = 4 limit 1))).bar@b`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a then .b`,
      [
            {
              "a": 1,
              "b": 1,
            },
            {
              "a": 2,
              "b": 2,
            },
            {
              "a": 2,
              "b": 3,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": 5,
            },
            {
              "a": 3,
              "b": 8,
            },
            {
              "a": 4,
              "b": 9,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_nested_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function inner(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }));
            };
            create function foo(x: int64) -> Bar {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `for x in {2, 3, 4} union (foo(x).a)`,
      unorderedBag([2, 3, 4])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4])
    );
  });

  it("test_edgeql_functions_inline_insert_nested_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create required link bar -> Bar;
            };
            create function inner1(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }))
            };
            create function inner2(x: int64, y: int64) -> Baz {
                set is_inlined := true;
                using ((insert Baz{ b := y, bar := inner1(x) }))
            };
            create function foo(x: int64, y: int64) -> Baz {
                set is_inlined := true;
                using (inner2(x, y))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, 10){a := .bar.a, b := .b}`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .b} order by .a`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    for x in {2, 3} union (        for y in {20, 30} union (            foo(x, y){a := .bar.a, b := .b}        )    )) order by .a then .b`,
      [
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 2, 3, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .b} order by .a`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_nested_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required link bar -> Bar {
                    create property b -> int64;
                };
            };
            create function inner1(x: int64) -> Bar {
                set is_inlined := true;
                using ((insert Bar{ a := x }))
            };
            create function inner2(x: int64, y: int64) -> Baz {
                set is_inlined := true;
                using ((insert Baz{ bar := inner1(x){ @b := y } }))
            };
            create function foo(x: int64, y: int64) -> Baz {
                set is_inlined := true;
                using (inner2(x, y))
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1, 10){a := .bar.a, b := .bar@b}`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select (    for x in {2, 3} union (        for y in {20, 30} union (            foo(x, y){a := .bar.a, b := .bar@b}        )    )) order by .a then .b`,
      [
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 2, 3, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": 2,
              "b": 30,
            },
            {
              "a": 3,
              "b": 20,
            },
            {
              "a": 3,
              "b": 30,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_insert_nested_scopes_01", () => {
    h.script(
      `
            create type Foo { create property num: int64 };

            create function foo(num: int64) -> Foo
            {
                using (
                    with
                        a := (num),
                        b := ((insert Foo { num := 0 }).num ?? a)
                    insert Foo { num := num }
                );
            };
        `
    );
    assertQueryResult(
      h,
      `select foo(1) { num }`,
      [
            {
              "num": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Foo.num`,
      unorderedBag([0, 1])
    );
  });

  it("test_edgeql_functions_inline_update_basic_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((update Bar set { a := x }));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1).a`,
      unorderedBag([1, 1, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 1, 1])
    );
  });

  it("test_edgeql_functions_inline_update_basic_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64, y: int64) -> set of int64 {
                set is_inlined := true;
                using ((update Bar filter .a <= y set { a := x }).a);
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 0)`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1)`,
      unorderedBag([0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 2)`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 3)`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
  });

  it("test_edgeql_functions_inline_update_basic_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(
                named only m: int64,
                named only n: int64,
            ) -> set of int64 {
                set is_inlined := true;
                using ((update Bar filter .a <= n set { a := m }).a);
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(m := 0, n := 0)`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(m := 0, n := 1)`,
      unorderedBag([0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(m := 0, n := 2)`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(m := 0, n := 3)`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
  });

  it("test_edgeql_functions_inline_update_basic_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(
                x: optional int64,
                y: optional int64,
            ) -> set of int64 {
                set is_inlined := true;
                using ((update Bar filter .a <= y ?? 9 set { a := x ?? 9 }).a);
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(<int64>{}, <int64>{})`,
      unorderedBag([9, 9, 9])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([9, 9, 9])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(<int64>{}, 2)`,
      unorderedBag([9, 9])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 9, 9])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2, <int64>{})`,
      unorderedBag([2, 2, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 2, 2])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 0)`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1)`,
      unorderedBag([0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 2)`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 3)`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
  });

  it("test_edgeql_functions_inline_update_basic_05", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(
                x: int64,
                variadic y: int64,
            ) -> set of int64 {
                set is_inlined := true;
                using (
                    (
                        update Bar
                        filter .a <= sum(array_unpack(y))
                        set { a := x }
                    ).a
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1)`,
      unorderedBag([0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1, 2)`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
  });

  it("test_edgeql_functions_inline_update_basic_06", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64, y: int64) -> set of Bar {
                set is_inlined := true;
                using ((update Bar filter .a <= y set { a := x }));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := foo(0, 2)select temp.a`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (for x in {1, 2, 3} union (select foo(x-1, x)))select temp.a`,
      unorderedBag([0, 1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 2, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if true then foo(0, 2) else <Bar>{})select temp.a`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if false then foo(0, 2) else <Bar>{})select temp.a`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if true then <Bar>{} else foo(0, 2))select temp.a`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if false then <Bar>{} else foo(0, 2))select temp.a`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3, 4, 5])
    );
  });

  it("test_edgeql_functions_inline_update_basic_07", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64, y: int64) -> set of Bar {
                set is_inlined := true;
                using ((update Bar filter .a <= y set { a := x }));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := foo(0, 2)select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (for x in {1, 2, 3} union (select foo(x-1, x)))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 2, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if true then foo(0, 2) else <Bar>{})select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if false then foo(0, 2) else <Bar>{})select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if true then <Bar>{} else foo(0, 2))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if false then <Bar>{} else foo(0, 2))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3, 4, 5])
    );
  });

  it("test_edgeql_functions_inline_update_iterator_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64, y: int64) -> set of int64 {
                set is_inlined := true;
                using ((update Bar filter .a <= y set { a := x }).a);
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 0)`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1)`,
      unorderedBag([0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 2)`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 3)`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {0, 1} union (select foo(0, x))`,
      unorderedBag([0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(0, x))`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x - 1, 0))`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x - 1, 3))`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1} union (select foo(x - 1, x))`,
      unorderedBag([0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {2, 3} union (select foo(x - 1, x))`,
      unorderedBag([1, 1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 1, 2])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x - 1, x))`,
      unorderedBag([0, 1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 2])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(0, 2) else 99`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(0, 2) else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(0, 2)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(0, 2)`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 0) ?? 99`,
      unorderedBag([99])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 2) ?? 99`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(0, 2)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_update_iterator_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64, y: int64) -> set of int64 {
                set is_inlined := true;
                using (
                    for z in {0, 1} union (
                        (update Bar filter .a <= y + z set { a := x + z }).a
                    )
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 0)`,
      unorderedBag([1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1)`,
      unorderedBag([0, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 2)`,
      unorderedBag([0, 0, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 1])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 3)`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {0, 1} union (select foo(0, x))`,
      unorderedBag([1, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 1, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(0, x))`,
      unorderedBag([0, 1, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 1])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x - 1, 0))`,
      unorderedBag([1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x - 1, 3))`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1} union (select foo(x - 1, x))`,
      unorderedBag([0, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {2, 3} union (select foo(x - 1, x))`,
      unorderedBag([1, 1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 1, 2])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x - 1, x))`,
      unorderedBag([0, 1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 2])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(0, 1) else 99`,
      unorderedBag([0, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(0, 1) else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(0, 1)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(0, 1)`,
      unorderedBag([0, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, -1) ?? 99`,
      unorderedBag([99])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1) ?? 99`,
      unorderedBag([0, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(0, 1)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_update_iterator_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(
                x: int64, y: int64, z: bool
            ) -> set of int64 {
                set is_inlined := true;
                using (
                    if z
                    then (update Bar filter .a <= y set { a := x }).a
                    else <int64>{}
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 2, false)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(0, 3, false)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 2, true)`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 3, true)`,
      unorderedBag([0, 0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 0])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {0, 1} union (select foo(0, x, false))`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `for x in {2, 3} union (select foo(x - 1, x, false))`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {0, 1} union (select foo(0, x, true))`,
      unorderedBag([0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {2, 3} union (select foo(x - 1, x, true))`,
      unorderedBag([1, 1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 1, 2])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(0, 2, false) else 99`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select if false then foo(0, 2, false) else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select if true then 99 else foo(0, 2, false)`,
      [99]
    );
    assertQueryResult(
      h,
      `select if false then 99 else foo(0, 2, false)`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(0, 2, true) else 99`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(0, 2, true) else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(0, 2, true)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(0, 2, true)`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 0, false) ?? 99`,
      unorderedBag([99])
    );
    assertQueryResult(
      h,
      `select foo(0, 2, false) ?? 99`,
      unorderedBag([99])
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(0, 2, false)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 0, true) ?? 99`,
      unorderedBag([99])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 2, true) ?? 99`,
      unorderedBag([0, 0])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 0, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(0, 2, true)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_update_link_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create link bar -> Bar;
            };
            create function foo(n: int64, x: Bar) -> set of Baz {
                set is_inlined := true;
                using ((update Baz filter .b <= n set { bar := x }))
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(    4,    assert_exists((select Bar filter .a = 1 limit 1))){a := .bar.a, b}`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": null,
              "b": 5,
            },
            {
              "a": null,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(    5,    assert_exists((select Bar filter .a = 1 limit 1))){a := .bar.a, b}`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 1,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 1,
              "b": 5,
            },
            {
              "a": null,
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_update_link_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create multi link bar -> Bar;
            };
            create function foo(x: int64, y: int64) -> set of Baz {
                set is_inlined := true;
                using (
                    (update Baz filter .b <= x set {
                        bar := (select Bar filter .a <= y),
                    })
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(4, 1){a := .bar.a, b}`,
      [
            {
              "a": [1],
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz {    a := (select .bar order by .a).a,    b,} order by .b`,
      [
            {
              "a": [1],
              "b": 4,
            },
            {
              "a": [],
              "b": 5,
            },
            {
              "a": [],
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(5, 2){a := .bar.a, b}`,
      [
            {
              "a": [1, 2],
              "b": 4,
            },
            {
              "a": [1, 2],
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz {    a := (select .bar order by .a).a,    b,} order by .b`,
      [
            {
              "a": [1, 2],
              "b": 4,
            },
            {
              "a": [1, 2],
              "b": 5,
            },
            {
              "a": [],
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_update_link_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create optional link bar -> Bar;
            };
            create function foo(x: int64, y: int64) -> set of Baz {
                set is_inlined := true;
                using (
                    (update Baz filter .b <= x set {
                        bar := (insert Bar{a := y}),
                    })
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(4, 1){a := .bar.a, b}`,
      [
            {
              "a": 1,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz {    a := (select .bar order by .a).a,    b,} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": null,
              "b": 5,
            },
            {
              "a": null,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(5, 2){a := .bar.a, b}`,
      [
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [2, 2]
    );
    assertQueryResult(
      h,
      `select Baz {    a := (select .bar order by .a).a,    b,} order by .b`,
      [
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": null,
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_update_link_iterator_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create link bar -> Bar;
            };
            create function foo(n: int64, x: Bar) -> set of Baz {
                set is_inlined := true;
                using ((update Baz filter .b = n set { bar := x }))
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(    10,    assert_exists((select Bar filter .a = 1 limit 1))){a := .bar.a, b}`,
      [
            {
              "a": 1,
              "b": 10,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": null,
              "b": 20,
            },
            {
              "a": null,
              "b": 30,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select (    for x in {1, 2} union(        select foo(            x * 10,            assert_exists((select Bar filter .a = x limit 1))        ).b    ))`,
      unorderedBag([10, 20])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": 2,
              "b": 20,
            },
            {
              "a": null,
              "b": 30,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select (    if true    then foo(        10,        assert_exists((select Bar filter .a = 1 limit 1)),    ).b    else 99)`,
      [10]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": null,
              "b": 20,
            },
            {
              "a": null,
              "b": 30,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select (    if false    then foo(        10,        assert_exists((select Bar filter .a = 1 limit 1)),    ).b    else 99)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 10,
            },
            {
              "a": null,
              "b": 20,
            },
            {
              "a": null,
              "b": 30,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select (    if true    then 99    else foo(        10,        assert_exists((select Bar filter .a = 1 limit 1)),    ).b)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 10,
            },
            {
              "a": null,
              "b": 20,
            },
            {
              "a": null,
              "b": 30,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select (    if false    then 99    else foo(        10,        assert_exists((select Bar filter .a = 1 limit 1)),    ).b)`,
      [10]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": null,
              "b": 20,
            },
            {
              "a": null,
              "b": 30,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(    10,    assert_exists((select Bar filter .a = 1 limit 1)),).b ?? 99`,
      unorderedBag([10])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 10,
            },
            {
              "a": null,
              "b": 20,
            },
            {
              "a": null,
              "b": 30,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(    10,    assert_exists((select Bar filter .a = 1 limit 1)),).b`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 10,
            },
            {
              "a": null,
              "b": 20,
            },
            {
              "a": null,
              "b": 30,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_update_link_iterator_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create multi link bar -> Bar;
            };
            create function foo(x: int64, y: int64) -> set of Baz {
                set is_inlined := true;
                using ((
                    update Baz filter .b = x set {
                        bar := (for z in {y, y + 1, y + 2} union (
                               insert Bar{a := z}
                            )
                        )
                    }
                ))
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1, 10){a := .bar.a, b}`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [],
              "b": 2,
            },
            {
              "a": [],
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2} union (select foo(x, x * 10){a := .bar.a, b})`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [20, 21, 22],
              "b": 2,
            },
            {
              "a": [],
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(1, 10).b else 99`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [],
              "b": 2,
            },
            {
              "a": [],
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(1, 10).b else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": [],
              "b": 1,
            },
            {
              "a": [],
              "b": 2,
            },
            {
              "a": [],
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(1, 10).b`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": [],
              "b": 1,
            },
            {
              "a": [],
              "b": 2,
            },
            {
              "a": [],
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(1, 10).b`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [],
              "b": 2,
            },
            {
              "a": [],
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1, 10).b ?? 99`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": [10, 11, 12],
              "b": 1,
            },
            {
              "a": [],
              "b": 2,
            },
            {
              "a": [],
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(1, 10).b`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": [],
              "b": 1,
            },
            {
              "a": [],
              "b": 2,
            },
            {
              "a": [],
              "b": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_update_link_iterator_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create link bar -> Bar;
            };
            create function foo(x: int64, y: int64, flag: bool) -> set of Baz {
                set is_inlined := true;
                using ((
                    update Baz filter .b = x set {
                        bar := (
                            if flag
                            then (insert Bar{a := y})
                            else <Bar>{}
                        )
                    }
                ))
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1, 10, false){a := .bar.a, b}`,
      [
            {
              "a": null,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1, 10, true){a := .bar.a, b}`,
      [
            {
              "a": 10,
              "b": 1,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [10]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 10,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2} union (    select foo(x, x * 10, false){a := .bar.a, b})`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2} union (    select foo(x, x * 10, true){a := .bar.a, b})`,
      [
            {
              "a": 10,
              "b": 1,
            },
            {
              "a": 20,
              "b": 2,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 10,
              "b": 1,
            },
            {
              "a": 20,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(1, 10, false).bar.a else 99`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(1, 10, false).bar.a else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(1, 10, false).bar.a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(1, 10, false).bar.a`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(1, 10, true).bar.a else 99`,
      [10]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 10,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(1, 10, true).bar.a else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(1, 10, true).bar.a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(1, 10, true).bar.a`,
      [10]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 10,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1, 10, false).bar.a ?? 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(1, 10, false).bar.a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1, 10, true).bar.a ?? 99`,
      [10]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 10,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(1, 10, true).bar.a`,
      [99]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 1,
            },
            {
              "a": null,
              "b": 2,
            },
            {
              "a": null,
              "b": 3,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_update_linkprop_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required link bar -> Bar {
                    create property b -> int64;
                }
            };
            create function foo(x: int64, y: int64) -> set of Baz {
                set is_inlined := true;
                using ((
                    update Baz filter .bar.a <= x set {
                        bar := .bar { @b := y }
                    }
                ))
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2, 4){a := .bar.a, b := .bar@b}`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b := .bar@b} order by .a`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 4,
            },
            {
              "a": 3,
              "b": null,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_update_nested_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function inner(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((update Bar set { a := x }));
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1).a`,
      unorderedBag([1, 1, 1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 1, 1])
    );
  });

  it("test_edgeql_functions_inline_update_nested_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create multi link bar -> Bar;
            };
            create function inner1(y: int64) -> set of Bar {
                set is_inlined := true;
                using ((update Bar filter .a <= y set { a := .a - 1 }));
            };
            create function inner2(x: int64, y: int64) -> set of Baz {
                set is_inlined := true;
                using (
                    (update Baz filter .b <= x set {
                        bar := assert_distinct(inner1(y)),
                    })
                );
            };
            create function foo(x: int64, y: int64) -> set of Baz {
                set is_inlined := true;
                using (inner2(x, y));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(4, 1){a := .bar.a, b}`,
      [
            {
              "a": [0],
              "b": 4,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz {    a := (select .bar order by .a).a,    b,} order by .b`,
      [
            {
              "a": [0],
              "b": 4,
            },
            {
              "a": [],
              "b": 5,
            },
            {
              "a": [],
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(5, 2){a := .bar.a, b}`,
      [
            {
              "a": [0, 1],
              "b": 4,
            },
            {
              "a": [],
              "b": 5,
            },
          ]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([0, 1, 3])
    );
    assertQueryResult(
      h,
      `select Baz {    a := (select .bar order by .a).a,    b,} order by .b`,
      [
            {
              "a": [0, 1],
              "b": 4,
            },
            {
              "a": [],
              "b": 5,
            },
            {
              "a": [],
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_delete_basic_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((delete Bar filter .a <= x));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2).a`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
  });

  it("test_edgeql_functions_inline_delete_basic_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using ((delete Bar filter .a <= x).a);
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(3)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
  });

  it("test_edgeql_functions_inline_delete_basic_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(named only m: int64) -> set of int64 {
                set is_inlined := true;
                using ((delete Bar filter .a <= m).a);
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(m := 0)`,
      unorderedBag([])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(m := 1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(m := 2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(m := 3)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
  });

  it("test_edgeql_functions_inline_delete_basic_04", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: optional int64) -> set of int64 {
                set is_inlined := true;
                using ((delete Bar filter .a <= x ?? 9).a);
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(<int64>{})`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(3)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
  });

  it("test_edgeql_functions_inline_delete_basic_05", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(
                variadic x: int64,
            ) -> set of int64 {
                set is_inlined := true;
                using (
                    (
                        delete Bar
                        filter .a <= sum(array_unpack(x))
                    ).a
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, 1, 2)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
  });

  it("test_edgeql_functions_inline_delete_basic_06", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((delete Bar filter .a <= x));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := foo(2)select temp.a`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (for x in {1, 2, 3} union (select foo(x)))select temp.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if true then foo(2) else <Bar>{})select temp.a`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if false then foo(2) else <Bar>{})select temp.a`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if true then <Bar>{} else foo(2))select temp.a`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if false then <Bar>{} else foo(2))select temp.a`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 4, 5])
    );
  });

  it("test_edgeql_functions_inline_delete_basic_07", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((delete Bar filter .a <= x));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := foo(2)select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (for x in {1, 2, 3} union (select foo(x)))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if true then foo(2) else <Bar>{})select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if false then foo(2) else <Bar>{})select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if true then <Bar>{} else foo(2))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3, 4, 5])
    );
    reset_data();
    assertQueryResult(
      h,
      `with temp := (if false then <Bar>{} else foo(2))select 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3, 4, 5])
    );
  });

  it("test_edgeql_functions_inline_delete_iterator_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using ((delete Bar filter .a <= x).a);
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(3)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {0, 1} union (select foo(x))`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(2) else 99`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(2) else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(2)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0) ?? 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2) ?? 99`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(2)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_delete_iterator_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (
                    for z in {0, 1} union (
                        (delete Bar filter .a <= x).a
                    )
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(3)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {0, 1} union (select foo(x))`,
      unorderedBag([1])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [2, 3]
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {1, 2, 3} union (select foo(x))`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(2) else 99`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(2) else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(2)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0) ?? 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2) ?? 99`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(2)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_delete_iterator_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function foo(
                x: int64, y: bool
            ) -> set of int64 {
                set is_inlined := true;
                using (
                    if y
                    then (delete Bar filter .a <= x).a
                    else <int64>{}
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2, false)`,
      []
    );
    assertQueryResult(
      h,
      `select foo(3, false)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2, true)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(3, true)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {0, 1} union (select foo(x, false))`,
      []
    );
    assertQueryResult(
      h,
      `for x in {2, 3} union (select foo(x, false))`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {0, 1} union (select foo(x, true))`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `for x in {2, 3} union (select foo(x, true))`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(2, false) else 99`,
      []
    );
    assertQueryResult(
      h,
      `select if false then foo(2, false) else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select if true then 99 else foo(2, false)`,
      [99]
    );
    assertQueryResult(
      h,
      `select if false then 99 else foo(2, false)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then foo(2, true) else 99`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then foo(2, true) else 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if true then 99 else foo(2, true)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select if false then 99 else foo(2, true)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, false) ?? 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select foo(2, false) ?? 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select 99 ?? foo(2, false)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0, true) ?? 99`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2, true) ?? 99`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select 99 ?? foo(2, true)`,
      [99]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
  });

  it("test_edgeql_functions_inline_delete_policy_target_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create link bar -> Bar {
                    on target delete allow;
                };
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (
                    (delete Bar filter .a <= x).a
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 4,
            },
            {
              "a": null,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(3)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": null,
              "b": 4,
            },
            {
              "a": null,
              "b": 5,
            },
            {
              "a": null,
              "b": 6,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_delete_policy_target_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create link bar -> Bar {
                    on target delete delete source;
                };
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (
                    (delete Bar filter .a <= x).a
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b}`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1)`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b}`,
      [
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2)`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b}`,
      [
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(3)`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b}`,
      []
    );
  });

  it("test_edgeql_functions_inline_delete_policy_source_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create link bar -> Bar {
                    on source delete allow;
                };
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (
                    (delete Baz filter .b <= x).b
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(4)`,
      [4]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(5)`,
      unorderedBag([4, 5])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(6)`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      []
    );
  });

  it("test_edgeql_functions_inline_delete_policy_source_02", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create link bar -> Bar {
                    on source delete delete target;
                };
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (
                    (delete Baz filter .b <= x).b
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(4)`,
      [4]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(5)`,
      unorderedBag([4, 5])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 3,
              "b": 6,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(6)`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      []
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      []
    );
  });

  it("test_edgeql_functions_inline_delete_policy_source_03", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create type Baz {
                create required property b -> int64;
                create link bar -> Bar {
                    on source delete delete target if orphan;
                };
            };
            create function foo(x: int64) -> set of int64 {
                set is_inlined := true;
                using (
                    (delete Baz filter .b <= x).b
                );
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(0)`,
      []
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 4,
            },
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
            {
              "a": 1,
              "b": 7,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(4)`,
      [4]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([1, 2, 3])
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 2,
              "b": 5,
            },
            {
              "a": 3,
              "b": 6,
            },
            {
              "a": 1,
              "b": 7,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(5)`,
      unorderedBag([4, 5])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1, 3]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 3,
              "b": 6,
            },
            {
              "a": 1,
              "b": 7,
            },
          ]
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(6)`,
      unorderedBag([4, 5, 6])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Baz{a := .bar.a, b} order by .b`,
      [
            {
              "a": 1,
              "b": 7,
            },
          ]
    );
  });

  it("test_edgeql_functions_inline_delete_nested_01", () => {
    h.script(
      `
            create type Bar {
                create required property a -> int64;
            };
            create function inner(x: int64) -> set of Bar {
                set is_inlined := true;
                using ((delete Bar filter .a <= x));
            };
            create function foo(x: int64) -> set of Bar {
                set is_inlined := true;
                using (inner(x));
            };
        `
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(1).a`,
      [1]
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      unorderedBag([2, 3])
    );
    reset_data();
    assertQueryResult(
      h,
      `select foo(2).a`,
      unorderedBag([1, 2])
    );
    assertQueryResult(
      h,
      `select Bar.a`,
      [3]
    );
  });
});

describe("TestEdgeQLFunctionsInlineTransaction", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      dbFile: "./tests/.artifacts/functions_inline_testedgeqlfunctionsinlinetransaction.sqlite",
      resetDbFile: true
    });
  });

  it("test_edgeql_functions_inline_transaction_dml_01", () => {
    let con = with_transaction_options(edgedb.TransactionOptions());
    try {
      expect(() => {
        for (const tx of (con.transaction() as any)) {
          h.script(
            "select foo()"
          );
        }
      }).toThrow(new RegExp("Modifications not allowed in a read-only transaction"));
    } finally {
      // ignored awaited call: con.aclose
    }
  });
});
