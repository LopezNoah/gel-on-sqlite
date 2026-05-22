import { describe, it } from "vitest";
import { QueryHarness } from "./utils.js";

describe("debug-filter", () => {
  it("debug", async () => {
    const h = await QueryHarness.create({
      schema: "issues",
      setup: "issues_filter_setup"
    });

    console.log("\n=== two_scalar_exists04 ===");
    console.log("Result:", JSON.stringify(h.query(`
      WITH U2 := User
      SELECT User{name}
      FILTER EXISTS (
          SELECT I := User.<owner[IS Issue]
          FILTER NOT (
              NOT EXISTS I.time_estimate OR
              NOT EXISTS (
                  (SELECT U2.<owner[IS Issue] FILTER I = U2.<owner[IS Issue]).due_date
              )
          )
      )
      ORDER BY User.name;
    `)));
  });
});
