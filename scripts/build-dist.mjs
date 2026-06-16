/* eslint-disable */
// Transpiles src/**/*.ts -> dist/src/**/*.js (per-file, no bundle) with esbuild.
//
// Why esbuild and not tsc: the test runner already transforms source with
// esbuild, so esbuild-built output is behavior-equivalent to running against
// src (lowest risk), and esbuild is fast + low-memory — important because the
// whole point is to avoid transpiling on the constrained box at test time. Run
// tests against this output with VITEST_USE_DIST=1 (see vitest.config.ts) to
// skip the cold TS transpile entirely.
//
// Run: node scripts/build-dist.mjs   (or `npm run build:dist`)
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist", "src");

// Sourcemaps default off (smaller, faster, less memory); VITEST_NO_SOURCEMAP=0
// or BUILD_SOURCEMAP=1 turns them back on for debuggable dist stack traces.
const sourcemap = process.env.BUILD_SOURCEMAP === "1" || process.env.VITEST_NO_SOURCEMAP === "0";

const entryPoints = fs
  .readdirSync(SRC, { recursive: true })
  .map((p) => path.join(SRC, p.toString()))
  .filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));

console.log(`Building ${entryPoints.length} files -> dist/src (sourcemap=${sourcemap})`);
const t0 = performance.now();
await esbuild.build({
  entryPoints,
  outdir: OUT,
  outbase: SRC,
  // Match tsconfig (target ES2022, NodeNext ESM). bundle:false keeps the
  // per-file layout and leaves the source's explicit `.js` import specifiers
  // untouched, so dist/src/a.js imports ./b.js -> dist/src/b.js.
  format: "esm",
  platform: "node",
  target: "es2022",
  bundle: false,
  sourcemap,
  logLevel: "warning",
});
console.log(`Done in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
