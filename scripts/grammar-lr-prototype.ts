// Throwaway proof: run Gel's generated LR action/goto tables in TypeScript.
// Run from sqlite-ts: npx tsx scripts/grammar-lr-prototype.ts
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptsGelGrammarBlock } from "../src/edgeql/gel_lr_parser.js";
import { parseEdgeQLGrammarScript } from "../src/edgeql/grammar_parser.js";
import { parseEdgeQLScript } from "../src/edgeql/parser.js";
import { tokenizeWithStarts, type Token } from "../src/edgeql/tokenizer.js";
import { extractSuiteQueries } from "./grammar-query-corpus.js";

type LRAction = { Shift: number } | { Reduce: { non_term: string; cnt: number } };
type LRSpec = {
  actions: Array<Array<[string, LRAction]>>;
  goto: Array<Array<[string, number]>>;
  keyword_tokens: Record<string, string>;
  multiword_tokens: string[];
  production_names: unknown[];
};
type GelVerdict = { accepted: boolean; ast?: unknown; unmapped?: string; error?: string };

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.GEL_PYTHON ?? resolve(root, ".venv/bin/python");
const exporter = fileURLToPath(new URL("./export-gel-lr-spec.py", import.meta.url));
const bridge = fileURLToPath(new URL("./grammar-spike.py", import.meta.url));
const env = {
  ...process.env,
  PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
};

const exported = spawnSync(python, [exporter], {
  cwd: root,
  encoding: "utf8",
  env,
  maxBuffer: 24 * 1024 * 1024,
});
if (exported.error || exported.status !== 0) {
  throw new Error(`Gel LR-table export failed: ${exported.error ?? exported.stderr}`);
}
const spec = JSON.parse(exported.stdout) as LRSpec;
const actions = spec.actions.map(
  (row) => new Map(row.map(([name, action]) => [normalizeTableToken(name), action])),
);
const gotos = spec.goto.map((row) => new Map(row));

const cases = [
  "SELECT 1 + 2 * 3;",
  "SELECT User {friends: {name} FILTER .name != 'x'};",
  "SELECT (Foo.baz ?? ((1, 2), 'huh')).0.1;",
  "SELECT call21(<array<str>>[]);",
  "WITH val := <int16>1234, FOR X IN {(2, 2), (10, 10)} SELECT bit_lshift(bit_lshift(val, X.0), X.1) = bit_lshift(val, X.0 + X.1);",
  "SELECT _ := DETACHED {x := (SELECT User)};",
  "SELECT (FOR u IN .<deck[IS User] SELECT (u.name, u@count)) ORDER BY .0;",
  "if true then 10 else 11",
  "SELECT array_agg('x' ORDER BY 'x');",
  "WITH MODULE schema SELECT Type {name};",
  "CREATE TYPE Foo { CREATE PROPERTY name -> str; };",
  'SELECT "1 + 1 = \\(1 + 1)";',
  "SELECT 1 +;",
];
const gelRun = spawnSync(python, [bridge], {
  cwd: root,
  encoding: "utf8",
  input: JSON.stringify(cases),
  env,
  maxBuffer: 4 * 1024 * 1024,
});
if (gelRun.error || gelRun.status !== 0) {
  throw new Error(`Gel syntax oracle failed: ${gelRun.error ?? gelRun.stderr}`);
}
const gel = JSON.parse(gelRun.stdout) as GelVerdict[];

function normalizeTableToken(name: string): string {
  return name === "<$>" ? "EOI" : name;
}

function tokenName(token: Token): string {
  if (token.kind === "eof") return "EOI";
  if (token.kind === "identifier" || token.kind === "backtick_name") return "IDENT";
  if (
    token.kind.startsWith("kw_") ||
    token.kind === "kw_unreserved" ||
    token.kind === "kw_partial_reserved" ||
    token.kind === "kw_future_reserved"
  ) {
    return spec.keyword_tokens[token.lower.toLowerCase()] ?? token.lower.toUpperCase();
  }
  if (token.kind === "number") {
    const value = token.lexeme.replace(/_/g, "");
    const big = value.endsWith("n");
    const nonInteger = /[.eE]/.test(big ? value.slice(0, -1) : value);
    return big ? (nonInteger ? "NFCONST" : "NICONST") : nonInteger ? "FCONST" : "ICONST";
  }
  const fixed: Partial<Record<Token["kind"], string>> = {
    string: "SCONST",
    bytes_string: "BCONST",
    parameter: "PARAMETER",
    parameter_and_type: "PARAMETERANDTYPE",
    substitution: "SUBSTITUTION",
    str_interp_start: "STRINTERPSTART",
    str_interp_cont: "STRINTERPCONT",
    str_interp_end: "STRINTERPEND",
    backward_link: ".<",
    optional_link: ".?>",
    coloncolon: "::",
    assign: ":=",
    add_assign: "+=",
    sub_assign: "-=",
    floor_div: "//",
    concat: "++",
    coalesce: "??",
    distinct_from: "?!=",
    not_distinct_from: "?=",
    not_equals: "!=",
    lparen: "(",
    rparen: ")",
    lbrace: "{",
    rbrace: "}",
    lbracket: "[",
    rbracket: "]",
    comma: ",",
    colon: ":",
    semi: ";",
    dot: ".",
    plus: "+",
    minus: "-",
    star: "*",
    double_splat: "**",
    slash: "/",
    modulo: "%",
    pow: "^",
    pipe: "|",
    ampersand: "&",
    equals: "=",
    lt: "<",
    lte: "<=",
    gt: ">",
    gte: ">=",
    at: "@",
    arrow: "->",
  };
  return fixed[token.kind] ?? token.lexeme;
}

function tableTokens(source: string): string[] {
  const tokens = tokenizeWithStarts(source).tokens;
  const multiword = [...spec.multiword_tokens].sort((a, b) => b.length - a.length);
  const result: string[] = ["STARTBLOCK"];
  for (let i = 0; i < tokens.length;) {
    let matched: string | undefined;
    let count = 0;
    for (const phrase of multiword) {
      const words = phrase.split(" ");
      if (words.every((word, offset) => tokens[i + offset]?.lower.toLowerCase() === word)) {
        matched = phrase;
        count = words.length;
        break;
      }
    }
    if (matched) {
      result.push(matched);
      i += count;
    } else {
      const token = tokens[i];
      if (
        token.kind === "number" &&
        result[result.length - 1] === "." &&
        /^\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)+$/.test(token.lexeme)
      ) {
        const indices = token.lexeme.split(".");
        result.push("ICONST");
        for (const _index of indices.slice(1)) result.push(".", "ICONST");
        i++;
        continue;
      }
      result.push(tokenName(token));
      i++;
    }
  }
  // Gel's tokenizer emits one EOI; the LR parser appends a second sentinel.
  result.push("EOI");
  return result;
}

function parseWithGeneratedTable(source: string): boolean {
  const stack = [0];
  let input: string[];
  try {
    input = tableTokens(source);
  } catch {
    return false;
  }
  const trace = process.env.GEL_LR_TRACE === "1";
  if (trace) console.log("LR input:", input.join(" "));
  for (let inputIndex = 0; inputIndex < input.length; inputIndex++) {
    const token = input[inputIndex];
    let reductions = 0;
    while (true) {
      if (++reductions > 10_000) throw new Error("LR reduction loop did not converge");
      const state = stack[stack.length - 1];
      let action = actions[state]?.get(token);
      let epsilon = false;
      if (!action) {
        action = actions[state]?.get("<e>");
        epsilon = action !== undefined;
      }
      if (!action) {
        if (trace)
          console.log(
            `No action at input[${inputIndex}]=${token}, state=${state}, keys=${[...(actions[state]?.keys() ?? [])].join(",")}`,
          );
        return false;
      }
      if ("Shift" in action) {
        stack.push(action.Shift);
        if (!epsilon) break;
        continue;
      }
      stack.splice(stack.length - action.Reduce.cnt, action.Reduce.cnt);
      const next = gotos[stack[stack.length - 1]]?.get(action.Reduce.non_term);
      if (next === undefined) return false;
      stack.push(next);
    }
  }
  return true;
}

let matches = 0;
let generatedArtifactMismatches = 0;
for (const [index, source] of cases.entries()) {
  const accepted = parseWithGeneratedTable(source);
  const checkedInAccepted = acceptsGelGrammarBlock(source);
  if (checkedInAccepted !== accepted) generatedArtifactMismatches++;
  if (checkedInAccepted === gel[index].accepted) matches++;
  else
    console.log(
      `Mismatch: Gel ${gel[index].accepted ? "accepts" : "rejects"}, LR ${accepted ? "accepts" : "rejects"}: ${source}`,
    );
}
console.log(
  `Gel LR table: ${spec.actions.length} states, ${spec.production_names.length} productions`,
);
console.log(
  `Checked-in generated parser matched Gel syntax acceptance for ${matches}/${cases.length} cases`,
);
if (matches !== cases.length) process.exitCode = 1;

const queryCounts = new Map<string, { seen: number; accepted: number; examples: string[] }>();
const corpus = extractSuiteQueries();
const total = corpus.queries.length;
let accepted = 0;
let acceptedBySuiteExtension = 0;
let acceptedByProductionParser = 0;
const compatibilityGaps = new Set<string>();
const rejectedQueries = new Set<string>();
for (const { query } of corpus.queries) {
  const kind = /^\s*(\w+)/.exec(query)?.[1].toUpperCase() ?? "OTHER";
  const stats = queryCounts.get(kind) ?? { seen: 0, accepted: 0, examples: [] };
  stats.seen++;
  const freshTableAccepted = parseWithGeneratedTable(query);
  const acceptedQuery = acceptsGelGrammarBlock(query);
  if (acceptedQuery !== freshTableAccepted) generatedArtifactMismatches++;
  if (acceptedQuery) {
    accepted++;
    stats.accepted++;
  } else {
    try {
      parseEdgeQLGrammarScript(query);
      acceptedBySuiteExtension++;
    } catch {
      try {
        parseEdgeQLScript(query);
        acceptedByProductionParser++;
      } catch {
        compatibilityGaps.add(query);
        if (stats.examples.length < 2)
          stats.examples.push(query.replace(/\s+/g, " ").slice(0, 150));
      }
    }
  }
  if (!acceptedQuery) rejectedQueries.add(query);
  queryCounts.set(kind, stats);
}
console.log(
  `Generated Gel LR syntax coverage: ${accepted}/${total} (${((accepted / total) * 100).toFixed(1)}%); skipped ${corpus.skippedInterpolated} interpolated templates.`,
);
console.log(
  `Additional forms accepted by the working-AST grammar reducer: ${acceptedBySuiteExtension}.`,
);
console.log(
  `Further suite forms accepted by the production compatibility parser: ${acceptedByProductionParser}; combined: ${accepted + acceptedBySuiteExtension + acceptedByProductionParser}/${total}.`,
);
for (const query of compatibilityGaps) {
  console.log(`  parser compatibility gap: ${query.replace(/\s+/g, " ").slice(0, 180)}`);
}
for (const [kind, stats] of [...queryCounts].sort((a, b) => b[1].seen - a[1].seen)) {
  console.log(
    `  ${kind.padEnd(10)} ${stats.accepted}/${stats.seen}${stats.examples.length ? `; gaps: ${stats.examples.join(" | ")}` : ""}`,
  );
}
const rejected = [...rejectedQueries];
if (rejected.length) {
  const syntaxCheck = spawnSync(python, [bridge], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(rejected),
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (syntaxCheck.error || syntaxCheck.status !== 0) {
    throw new Error(`Gel rejection audit failed: ${syntaxCheck.error ?? syntaxCheck.stderr}`);
  }
  const gelVerdicts = JSON.parse(syntaxCheck.stdout) as Verdict[];
  const gelAccepts = gelVerdicts.filter((verdict) => verdict.accepted).length;
  console.log(
    `Gel accepts ${gelAccepts}/${rejected.length} syntax queries rejected by the generated LR prototype.`,
  );
  for (let i = 0; i < rejected.length; i++) {
    const verdict = gelVerdicts[i];
    console.log(
      `  table gap (${verdict.accepted ? "Gel accepts" : `Gel rejects: ${verdict.error}`}): ${rejected[i].replace(/\s+/g, " ").slice(0, 180)}`,
    );
  }
}
console.log(
  `Checked-in LR table differs from fresh Gel table in ${generatedArtifactMismatches} cases.`,
);
if (generatedArtifactMismatches) process.exitCode = 1;
