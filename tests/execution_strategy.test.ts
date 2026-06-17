import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEdgeQL } from "../src/edgeql/parser.js";
import { classifyExecutionStrategy } from "../src/compiler/execution_strategy.js";
import { schemaFromSdl } from "../src/compiler/inspect.js";
import type { GelIRSQLArtifact } from "../src/sql/compiler_types.js";

// Unit tests for the strategy classifier, driven by synthetic artifacts so every
// branch is pinned deterministically (the live compiler happens to lower the
// whole corpus to single-statement SQL, so the runtime/reject branches need
// hand-built non-lowering artifacts to exercise).

const schema = schemaFromSdl(
  fs.readFileSync(new URL("./schemas/issues.esdl", import.meta.url), "utf8"),
);
const ast = (q: string) => parseEdgeQL(q);
const single = (sql = "SELECT 1"): GelIRSQLArtifact => ({ sql, params: [], loweringMode: "single_statement" });
const fallback = (sql = ""): GelIRSQLArtifact => ({ sql, params: [], loweringMode: "fallback_multi_query" });

describe("classifyExecutionStrategy", () => {
  it("anything that lowers to one statement is sql", () => {
    expect(classifyExecutionStrategy(ast("GROUP Issue BY .status"), single(), schema)).toBe("sql");
    expect(classifyExecutionStrategy(ast("SELECT Issue { name }"), single(), schema)).toBe("sql");
    expect(classifyExecutionStrategy(ast("INSERT Status { name := 'x' }"), single(), schema)).toBe("sql");
  });

  it("a GROUP that does not lower is rejected (engine throws E_UNSUPPORTED)", () => {
    expect(classifyExecutionStrategy(ast("GROUP Issue BY .status"), fallback(), schema)).toBe("reject");
  });

  it("a select_free that does not reach single_statement mode is rejected", () => {
    expect(classifyExecutionStrategy(ast("SELECT { a := 1 }"), fallback(), schema)).toBe("reject");
  });

  it("a non-lowering select_expr with no runtime need still runs the SQL path", () => {
    // count(...) is not a runtime construct; the engine runs runGelSelectSQL on
    // the (incomplete) artifact rather than rejecting — strategy is sql, even
    // though lowersToSingleSql is false.
    expect(classifyExecutionStrategy(ast("SELECT 1 + 1"), fallback(), schema)).toBe("sql");
  });

  it("a non-lowering select_expr that needs runtime eval is runtime (UDF call)", () => {
    expect(classifyExecutionStrategy(ast("SELECT ident('x')"), fallback(), schema)).toBe("runtime");
  });

  it("a non-lowering FOR runs via the runtime evaluator", () => {
    expect(classifyExecutionStrategy(ast("FOR x IN {1, 2} UNION (SELECT x)"), fallback(), schema)).toBe("runtime");
  });

  it("a non-lowering mutation runs via the write path", () => {
    expect(classifyExecutionStrategy(ast("DELETE Issue"), fallback(), schema)).toBe("runtime");
  });
});
