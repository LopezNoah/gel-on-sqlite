import { defineConfig } from "vitest/config";
import { transformWithEsbuild, type Plugin } from "vite";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// --- Persistent TS transform cache -----------------------------------------
//
// vite 5 / vitest 2 re-transpile every source + test file on every run
// (~1.5s single-fork, ~4.8s parallel) and persist nothing between runs. This
// plugin memoizes the TypeScript→JS transform to disk, keyed by file content,
// so unchanged files are read straight from cache on subsequent runs. The
// agentic dev loop reruns tests constantly with few files actually changing,
// so almost every transform becomes a cache hit.
//
// The transform itself is delegated to vite's own `transformWithEsbuild`, so
// output is byte-identical to what vite would produce; we just cache it. We
// run as an `enforce: "pre"` plugin AND set `esbuild: false` below so vite's
// built-in esbuild pass doesn't re-transform our cached output (which would
// negate the savings). The cache key folds in tsconfig.json so a compiler-
// option change invalidates every entry.
function persistentTsTransformCache(): Plugin {
  const root = __dirname;
  const cacheDir = path.join(root, "node_modules", ".cache", "vitest-ts-transform");
  let salt = "";
  try {
    salt = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8");
  } catch {
    // No tsconfig → empty salt; content hashing still keys correctly.
  }
  // Bump when the transform logic here changes in a way that should
  // invalidate previously-cached output.
  const VERSION = "v1";

  // Sourcemaps are ~33% of transform CPU and ~2/3 of the cache size, and on a
  // RAM-constrained box that extra memory churn during the cold transpile is
  // what tips the first run into swapping. Drop them in low-memory mode (where
  // run speed matters more than exact stack-trace line mapping); keep them on
  // otherwise for debuggable failure traces. `VITEST_NO_SOURCEMAP=1|0` forces
  // it either way. The choice is folded into the cache key so the two variants
  // don't clobber each other's entries.
  const emitSourcemap = process.env.VITEST_NO_SOURCEMAP === "1"
    ? false
    : process.env.VITEST_NO_SOURCEMAP === "0"
      ? true
      : process.env.VITEST_LOW_MEM !== "1";

  return {
    name: "persistent-ts-transform-cache",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.tsx?$/.test(file) || file.endsWith(".d.ts") || file.includes("/node_modules/")) {
        return null;
      }
      const key = createHash("sha1")
        .update(VERSION).update("\0")
        .update(emitSourcemap ? "map" : "nomap").update("\0")
        .update(salt).update("\0")
        .update(file).update("\0")
        .update(code)
        .digest("hex");
      const entryPath = path.join(cacheDir, `${key}.json`);

      try {
        // One read + parse for both code and map keeps the warm path cheap.
        return JSON.parse(fs.readFileSync(entryPath, "utf8")) as { code: string; map: unknown };
      } catch {
        // Cache miss — fall through to transform.
      }

      const result = await transformWithEsbuild(code, id, { sourcemap: emitSourcemap });
      const entry = { code: result.code, map: emitSourcemap ? (result.map ?? null) : null };
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(entryPath, JSON.stringify(entry));
      } catch {
        // A cache-write failure is non-fatal: the transform still succeeded.
      }
      return entry;
    },
  };
}

// --- Run against prebuilt dist/ (VITEST_USE_DIST=1) -------------------------
//
// Redirects every `../src/**.js` import to the matching prebuilt
// `dist/src/**.js` (see scripts/build-dist.mjs). Because the transform-cache
// plugin only handles `.tsx?` and `esbuild` is off globally, those `.js`
// modules are served untransformed — so the heavy engine/compiler graph isn't
// transpiled at test time at all, only the (small) test files are. This is the
// fix for the slow *first* run on RAM-constrained boxes: build dist once (ideally
// on a capable machine, then ship it), and the cold TS transpile disappears.
//
// The source test files themselves keep running through vitest (so `__dirname`
// and `tests/schemas/` paths still resolve), only their src imports are
// redirected. Falls back to the source `.ts` for any file not present in dist,
// so a partial/missing build degrades gracefully instead of failing.
function resolveSrcToDist(): Plugin {
  const srcPrefix = path.join(__dirname, "src") + path.sep;
  const distPrefix = path.join(__dirname, "dist", "src") + path.sep;
  return {
    name: "resolve-src-to-dist",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const id = resolved.id.split("?")[0];
      if (id.startsWith(srcPrefix) && id.endsWith(".ts")) {
        const distId = distPrefix + id.slice(srcPrefix.length).replace(/\.ts$/, ".js");
        if (fs.existsSync(distId)) return { id: distId };
      }
      return resolved;
    },
  };
}

const useDist = process.env.VITEST_USE_DIST === "1";

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
// to available RAM (see the per-fork budget below). Override explicitly with
// VITEST_MAX_FORKS / VITEST_LOW_MEM.

const totalMemGB = os.totalmem() / 1024 ** 3;
const cpuCount = os.availableParallelism?.() ?? os.cpus().length;

// Budget ~1GB of RAM per fork. A fork's committed V8 heap stays well under
// ~700MB (verified under a hard --max-old-space-size cap); the extra headroom
// covers the native better-sqlite3 binding and the OS. This scales smoothly:
// a 1GB VM runs a single fork (~14s), a 2GB VM runs two (~10s), and a 16GB
// workstation saturates its cores. VITEST_LOW_MEM=1 forces a single fork as a
// hard safety valve; VITEST_MAX_FORKS pins an exact count.
const maxForks = process.env.VITEST_MAX_FORKS
  ? Math.max(1, Number(process.env.VITEST_MAX_FORKS))
  : process.env.VITEST_LOW_MEM === "1"
    ? 1
    : Math.max(1, Math.min(cpuCount - 1, Math.floor(totalMemGB)));

export default defineConfig({
  plugins: useDist ? [resolveSrcToDist(), persistentTsTransformCache()] : [persistentTsTransformCache()],
  // Our plugin owns the TS→JS transform (and caches it); turn off vite's
  // built-in esbuild pass so it doesn't redundantly re-transform the output.
  esbuild: false,
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
