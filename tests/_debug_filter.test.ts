import { describe, it } from "vitest";
import { QueryHarness } from "./utils.js";

describe("debug-filter", () => {
  it("debug", async () => {
    const h = await QueryHarness.create({
      schema: "issues",
      setup: "issues_filter_setup",
      dbFile: "./tests/.artifacts/_debug.sqlite",
      resetDbFile: true,
    });

    console.log("\n=== Assertion 3 ===");
    console.log("Result:", JSON.stringify(h.query(`
      SELECT _ := (
        SELECT Issue
        FILTER Issue.owner.name = 'Elvis'
      ).number ++ Status.name
      FILTER Status.name = 'Open'
      ORDER BY _;
    `)));
  });
});
