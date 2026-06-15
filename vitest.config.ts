import { defineConfig } from "vitest/config";
import os from "node:os";

// --- Resource-adaptive test runner configuration ---------------------------
//
// The suite's cost is dominated by two things, both per *worker*:
//   1. Transpiling/importing the ~18k-line runtime/engine.ts module graph.
//   2. The ~100ms one-time build of each (schema, setup) pair (parse schema,
//      materialize tables, run the .edgeql setup script). After that first
//      build the snapshot cache in tests/utils.ts restores a fresh in-memory
//      DB from a serialized buffer in ~0.2ms, so per-test "rebuilds" are
//      effectively free — there is no need to special-case read-only tests.
//
// With vitest's default `isolate: true`, the module registry (including the
// transpiled engine and that snapshot cache) is torn down and rebuilt for
// *every test file*, so all 36 files re-pay both costs. Disabling isolation
// keeps one copy of the engine and one shared snapshot cache alive for the
// whole worker. Each test still gets a fresh DB in its `beforeEach`, and DDL
// mutates a per-harness clone of the schema (see cloneSchemaSnapshot), so this
// is safe: failure counts are identical with isolation on vs off.
//
// Measured (full suite, 4483 tests):
//   - 12 forks, isolate on  (old default): ~6.7s wall, but 12 engine copies
//   - 1 fork,   isolate on  (~1GB VM):     ~25s
//   - 1 fork,   isolate off (~1GB VM):     ~16s   <- low-memory target
//
// Memory is bounded by the number of forks: each fork holds its own engine +
// caches. A 1-2GB VM cannot afford one fork per core, so we scale fork count
// to available RAM (budgeting ~1.5GB/fork) and fall back to a single fork on
// low-memory hosts. Override explicitly with VITEST_MAX_FORKS / VITEST_LOW_MEM.

const totalMemGB = os.totalmem() / 1024 ** 3;
const cpuCount = os.availableParallelism?.() ?? os.cpus().length;

const lowMem = process.env.VITEST_LOW_MEM === "1" || totalMemGB < 4;

const maxForks = process.env.VITEST_MAX_FORKS
  ? Math.max(1, Number(process.env.VITEST_MAX_FORKS))
  : lowMem
    ? 1
    : Math.max(1, Math.min(cpuCount - 1, Math.floor(totalMemGB / 1.5)));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Share the engine module + snapshot cache across files within a worker.
    isolate: false,
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks,
      },
    },
    env: {
      GEL_EXPERIMENTAL_GEL_IR_SQL_LOWERING: "true",
      GEL_SQLITE_IR_FIRST: "1",
    },
  },
});
