// tests/engine.enums.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { QueryHarness } from "./utils.js";

describe("EdgeQL Enums (SPEC-PARITY)", () => {
  let h: QueryHarness;

  beforeEach(async () => {
    h = await QueryHarness.create({
      schema: "enums",
      dbFile: "./tests/.artifacts/enums.sqlite",
    });
  });

  it("test_edgeql_enums_assignment_01", () => {
    h.query(`INSERT default::Foo { color := 'RED' };`);
    const res = h.query(`SELECT default::Foo { color };`);
    expect(res.rows).toEqual([{ color: "RED" }]);
  });

  it("test_edgeql_enums_assignment_02", () => {
    h.query(`INSERT default::Foo { color := 'RED' };`);
    h.query(`UPDATE default::Foo SET { color := 'GREEN' };`);
    const res = h.query(`SELECT default::Foo { color };`);
    expect(res.rows).toEqual([{ color: "GREEN" }]);
  });

  it("test_edgeql_enums_assignment_03_default", () => {
    h.query(`INSERT default::Bar { color := 'RED' };`);
    const res = h.query(`SELECT default::Bar { color };`);
    expect(res.rows).toEqual([{ color: "RED" }]);
  });
});
