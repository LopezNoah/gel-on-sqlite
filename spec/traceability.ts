export interface RequirementCoverage {
  requirement: string;
  tests: string[];
}

export const REQUIREMENT_COVERAGE: RequirementCoverage[] = [
  {
    requirement: "SPEC-001.R1",
    tests: ["tests/lifecycle.test.ts"],
  },
  {
    requirement: "SPEC-001.R2",
    tests: ["tests/lifecycle.test.ts"],
  },
  {
    requirement: "SPEC-001.R3",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-010.R1",
    tests: ["tests/schema.test.ts"],
  },
  {
    requirement: "SPEC-010.R3",
    tests: ["tests/schema.test.ts"],
  },
  {
    requirement: "SPEC-020.R1",
    tests: ["tests/parser.test.ts"],
  },
  {
    requirement: "SPEC-020.R2",
    tests: ["tests/parser.test.ts"],
  },
  {
    requirement: "SPEC-021.R3",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-021.R2",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-040.R1",
    tests: ["tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-043.R1",
    tests: ["tests/http.test.ts"],
  },
  {
    requirement: "SPEC-043.R2",
    tests: ["tests/http.test.ts"],
  },
  {
    requirement: "SPEC-034.R9",
    tests: ["tests/parser.test.ts", "tests/semantic.test.ts", "tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-034.R10",
    tests: ["tests/parser.test.ts", "tests/semantic.test.ts", "tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-034.R17",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-034.R19",
    tests: ["tests/semantic.test.ts", "tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-034.R6",
    tests: ["tests/parser.test.ts", "tests/semantic.test.ts", "tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-034.R7",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-034.R8",
    tests: ["tests/parser.test.ts", "tests/semantic.test.ts", "tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-034.R13",
    tests: ["tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-034.R15",
    tests: ["tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-023.R1",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-023.R2",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-023.R3",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-022.R1",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-022.R2",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-022.R3",
    tests: ["tests/semantic.test.ts"],
  },
  {
    requirement: "SPEC-033.R1",
    tests: ["tests/parser.test.ts", "tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-033.R2",
    tests: ["tests/semantic.test.ts", "tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-033.R3",
    tests: ["tests/semantic.test.ts", "tests/engine.test.ts", "tests/http.test.ts"],
  },
  {
    requirement: "SPEC-035.R1",
    tests: ["tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-035.R2",
    tests: ["tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-035.R6",
    tests: ["tests/http.test.ts", "tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-041.R1",
    tests: ["tests/engine.test.ts", "tests/http.test.ts"],
  },
  {
    requirement: "SPEC-041.R2",
    tests: ["tests/engine.test.ts"],
  },
  {
    requirement: "SPEC-041.R3",
    tests: ["tests/engine.test.ts", "tests/http.test.ts"],
  },
  {
    requirement: "SPEC-052.R1",
    tests: ["tests/http.test.ts"],
  },
  {
    requirement: "SPEC-052.R2",
    tests: ["tests/http.test.ts"],
  },
  {
    requirement: "SPEC-052.R3",
    tests: ["tests/http.test.ts"],
  },
  {
    requirement: "SPEC-052.R8",
    tests: ["tests/http.test.ts"],
  },
];
