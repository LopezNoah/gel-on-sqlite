/**
 * Differential parser harness — step 2 of 3 (the sqlite-ts side).
 *
 * Reads the corpus produced by extract_and_parse_gel.py, runs each snippet
 * through sqlite-ts's own recursive-descent parser (`parseEdgeQLScript`), and
 * records accept/reject + the error message on failure. Pure syntax — no schema.
 *
 * Run from the sqlite-ts directory:
 *     npx tsx scripts/diff_parse/parse_ours.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEdgeQLScript } from "../../src/edgeql/parser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = process.argv[2] ?? path.join(here, ".out");

interface CorpusEntry {
  id: string;
  source: string;
}

const corpus: CorpusEntry[] = JSON.parse(
  fs.readFileSync(path.join(outdir, "corpus.json"), "utf8"),
);

const results = corpus.map(({ id, source }) => {
  try {
    const stmts = parseEdgeQLScript(source);
    return { id, ours_ok: true, ours_kinds: stmts.map((s) => s.kind), ours_err: null as string | null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { id, ours_ok: false, ours_kinds: [] as string[], ours_err: msg.split("\n")[0].slice(0, 200) };
  }
});

fs.writeFileSync(path.join(outdir, "ours.json"), JSON.stringify(results, null, 1));
const ok = results.filter((r) => r.ours_ok).length;
console.log(`sqlite-ts parsed ${corpus.length} snippets: accepts ${ok}, rejects ${corpus.length - ok}`);
console.log(`  wrote ${path.join(outdir, "ours.json")}`);
