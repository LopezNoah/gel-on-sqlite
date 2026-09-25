// Regenerate the checked-in syntax table from Gel's authoritative grammar.
// Requires the repository Gel Python environment: npm run codegen:edgeql-lr
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type RawAction = { Shift: number } | { Reduce: { production_id: number; non_term: string; cnt: number } };
type RawSpec = {
  actions: Array<Array<[string, RawAction]>>;
  goto: Array<Array<[string, number]>>;
  keyword_tokens: Record<string, string>;
  multiword_tokens: string[];
  inlines: Array<[number, number]>;
  production_names: Array<[string, string]>;
};

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.GEL_PYTHON ?? resolve(root, ".venv/bin/python");
const exporter = fileURLToPath(new URL("./export-gel-lr-spec.py", import.meta.url));
const result = spawnSync(python, [exporter], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  maxBuffer: 24 * 1024 * 1024,
});
if (result.error || result.status !== 0) {
  throw new Error(`Gel LR-table export failed: ${result.error ?? result.stderr}`);
}

const raw = JSON.parse(result.stdout) as RawSpec;
const normalize = (token: string) => token === "<$>" ? "EOI" : token;
const terminals = [...new Set(raw.actions.flatMap((row) => row.map(([token]) => normalize(token))))].sort();
const terminalId = new Map(terminals.map((token, id) => [token, id]));
const nonterminals = [...new Set([
  ...raw.goto.flatMap((row) => row.map(([name]) => name)),
  ...raw.actions.flatMap((row) => row.flatMap(([, action]) => "Reduce" in action ? [action.Reduce.non_term] : [])),
])].sort();
const nonterminalId = new Map(nonterminals.map((name, id) => [name, id]));

const actions = raw.actions.map((row) => {
  // Gel can expose both its physical EOI and the LR sentinel in the same
  // state. The Rust parser uses the last action for their shared token kind.
  const normalized = new Map<string, RawAction>();
  for (const [token, action] of row) normalized.set(normalize(token), action);
  return [...normalized].map(([token, action]) => "Shift" in action
    ? [terminalId.get(token)!, 0, action.Shift]
    : [terminalId.get(token)!, 1, action.Reduce.production_id, action.Reduce.cnt,
        nonterminalId.get(action.Reduce.non_term)!]);
});
const gotos = raw.goto.map((row) => row.map(([name, state]) => [nonterminalId.get(name)!, state]));
const compact = {
  terminals,
  actions,
  gotos,
  inlines: raw.inlines,
  productionNames: raw.production_names,
  keywordTokens: raw.keyword_tokens,
  multiwordTokens: raw.multiword_tokens,
};

const file = fileURLToPath(new URL("../src/edgeql/generated_gel_lr_spec.ts", import.meta.url));
const source = `// Generated from Gel's EdgeQL grammar. Do not edit by hand.
export const gelLRSpec = JSON.parse(${JSON.stringify(JSON.stringify(compact))}) as {
  terminals: string[];
  actions: number[][][];
  gotos: number[][][];
  inlines: number[][];
  productionNames: string[][];
  keywordTokens: Record<string, string>;
  multiwordTokens: string[];
};
`;
writeFileSync(file, source);
console.log(`Wrote ${file} (${source.length} bytes; ${terminals.length} terminals, ${actions.length} states).`);
