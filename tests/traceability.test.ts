import { describe, expect, it } from "vitest";

import { REQUIREMENT_COVERAGE } from "../spec/traceability.js";

describe("traceability", () => {
  it("[SPEC-070.R1] maps each requirement to at least one test", () => {
    expect(REQUIREMENT_COVERAGE.length).toBeGreaterThan(0);

    const unique = new Set(REQUIREMENT_COVERAGE.map((item) => item.requirement));
    expect(unique.size).toBe(REQUIREMENT_COVERAGE.length);

    for (const item of REQUIREMENT_COVERAGE) {
      expect(item.requirement).toMatch(/^SPEC-\d{3}\.R\d+$/);
      expect(item.tests.length).toBeGreaterThan(0);
    }
  });
});
