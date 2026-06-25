// Bundle the Worker into a single self-contained ESM file for wrangler.
//
// Solves the deploy-time bundling problem: the codebase uses NodeNext `.js`
// import specifiers that resolve to `.ts` sources, which wrangler's esbuild
// won't resolve on its own. A tiny resolve plugin rewrites `.js`→`.ts`, and we
// pre-bundle here so `wrangler dev`/`deploy` consume one already-resolved JS
// file (no `.ts` resolution needed downstream).
//
// Also neutralizes the engine's dev-only `process.env.DBG_*` reads via `define`
// so the output needs no node `process` global — and therefore no
// `nodejs_compat` flag. Run: node smoke/build-worker.mjs

import fs from "node:fs";
import path from "node:path";

import esbuild from "esbuild";

const here = import.meta.dirname;
const outfile = path.join(here, "dist/worker.js");

// Resolve the codebase's `.js` specifiers to their `.ts` sources.
const jsToTs = {
  name: "js-to-ts",
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith(".")) return undefined;
      const tsPath = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      return fs.existsSync(tsPath) ? { path: tsPath } : undefined;
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(here, "worker.ts")],
  outfile,
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  mainFields: ["module", "main"],
  // The engine reads dev-only `process.env.DBG_*` flags. Inject a tiny
  // `process` shim so those reads return undefined without needing a node
  // `process` global — and therefore without the `nodejs_compat` flag.
  banner: { js: "var process = globalThis.process ?? { env: {} };" },
  plugins: [jsToTs],
  logLevel: "warning",
});

const code = fs.readFileSync(outfile, "utf8");
const forbidden = ['from "node:', 'require("', "better-sqlite3"];
const offenders = forbidden.filter((f) => code.includes(f));
if (offenders.length > 0) {
  console.error(`bundle is NOT self-contained — found: ${offenders.join(", ")}`);
  process.exit(1);
}
console.log(
  `bundled → ${path.relative(process.cwd(), outfile)} (${(fs.statSync(outfile).size / 1024).toFixed(1)} KB), self-contained ✓`,
);
