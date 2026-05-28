import { describe, it, expect } from "vitest";
import { QueryHarness } from "./utils.js";
import { executeQueryWithTrace } from "../src/runtime/engine.js";

describe("which assertion fails?", () => {
  it("step by step", async () => {
    const h = await QueryHarness.create({schema: "dump01_test", setup: "dump01_setup"});
    console.log('user_func_0(99) =', JSON.stringify(h.query(`SELECT user_func_0(99)`)));
    console.log('user_func_1([1,3,-88], +) =', JSON.stringify(h.query(`SELECT user_func_1([1, 3, -88], '+')`)));
    console.log('user_func_2(<int64>{}) =', JSON.stringify(h.query(`SELECT user_func_2(<int64>{})`)));
    console.log('user_func_2(11) =', JSON.stringify(h.query(`SELECT user_func_2(11)`)));
    console.log('user_func_2(22, a) =', JSON.stringify(h.query(`SELECT user_func_2(22, 'a')`)));
    expect(true).toBe(true);
  });
});
