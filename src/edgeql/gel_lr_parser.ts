import { gelLRSpec } from "./generated_gel_lr_spec.js";
import { tokenizeWithStarts, type Token } from "./tokenizer.js";

type LRAction = { kind: "shift"; state: number }
  | { kind: "reduce"; production: number; count: number; nonterminal: number };
type LRInputTerminal = { id: number; name: string; text: string; start: number; end: number };
export type GelCSTNode = GelCSTEmpty | GelCSTTerminal | GelCSTProduction;
export interface GelCSTEmpty { kind: "empty" }
export interface GelCSTTerminal {
  kind: "terminal";
  terminal: string;
  text: string;
  span: { start: number; end: number };
}
export interface GelCSTProduction {
  kind: "production";
  id: number;
  name: [string, string];
  args: GelCSTNode[];
  inlinedIds?: number[];
  span?: { start: number; end: number };
}

const terminalIds = new Map(gelLRSpec.terminals.map((name, id) => [name, id]));
const keywordTokens = gelLRSpec.keywordTokens;
const multiwordTokens = [...gelLRSpec.multiwordTokens].sort((a, b) => b.length - a.length);
const actions = gelLRSpec.actions.map((state) => {
  const row = new Map<number, LRAction>();
  for (const [terminal, operation, a, b, c] of state) {
    row.set(terminal, operation === 0
      ? { kind: "shift", state: a }
      : { kind: "reduce", production: a, count: b ?? 0, nonterminal: c ?? 0 });
  }
  return row;
});
const gotos = gelLRSpec.gotos.map((state) => new Map<number, number>(
  state.map(([symbol, target]) => [symbol, target] as [number, number]),
));
const epsilonId = terminalIds.get("<e>");
const inlines = new Map<number, number>(gelLRSpec.inlines.map(([id, index]) => [id, index] as [number, number]));

function terminalName(token: Token): string | undefined {
  if (token.kind === "eof") return "EOI";
  if (token.kind === "identifier" || token.kind === "backtick_name") return "IDENT";
  if (token.kind.startsWith("kw_")) {
    return keywordTokens[token.lower.toLowerCase()];
  }
  if (token.kind === "number") {
    const value = token.lexeme.replace(/_/g, "");
    const big = value.endsWith("n");
    const nonInteger = /[.eE]/.test(big ? value.slice(0, -1) : value);
    return big ? nonInteger ? "NFCONST" : "NICONST" : nonInteger ? "FCONST" : "ICONST";
  }
  const fixed: Partial<Record<Token["kind"], string>> = {
    string: "SCONST", bytes_string: "BCONST", parameter: "PARAMETER",
    parameter_and_type: "PARAMETERANDTYPE", substitution: "SUBSTITUTION",
    str_interp_start: "STRINTERPSTART", str_interp_cont: "STRINTERPCONT",
    str_interp_end: "STRINTERPEND", backward_link: ".<", optional_link: ".?>",
    coloncolon: "::", assign: ":=", add_assign: "+=", sub_assign: "-=",
    floor_div: "//", concat: "++", coalesce: "??", distinct_from: "?!=",
    not_distinct_from: "?=", not_equals: "!=", lparen: "(", rparen: ")",
    lbrace: "{", rbrace: "}", lbracket: "[", rbracket: "]", comma: ",",
    colon: ":", semi: ";", dot: ".", plus: "+", minus: "-", star: "*",
    double_splat: "**", slash: "/", modulo: "%", pow: "^", pipe: "|",
    ampersand: "&", equals: "=", lt: "<", lte: "<=", gt: ">", gte: ">=",
    at: "@", arrow: "->",
  };
  return fixed[token.kind];
}

function tokensForBlock(source: string): LRInputTerminal[] | undefined {
  let tokens: Token[];
  try {
    tokens = tokenizeWithStarts(source).tokens;
  } catch {
    return undefined;
  }

  const result: LRInputTerminal[] = [];
  const add = (name: string, text: string, start: number, end: number): boolean => {
    const id = terminalIds.get(name);
    if (id === undefined) return false;
    result.push({ id, name, text, start, end });
    return true;
  };
  if (!add("STARTBLOCK", "", 0, 0)) return undefined;
  for (let i = 0; i < tokens.length;) {
    let phrase: string | undefined;
    let phraseLength = 0;
    for (const multiword of multiwordTokens) {
      const words = multiword.split(" ");
      if (words.every((word, offset) => tokens[i + offset]?.lower.toLowerCase() === word)) {
        phrase = multiword;
        phraseLength = words.length;
        break;
      }
    }
    const token = tokens[i];
    if (!phrase && token.kind === "number" && result[result.length - 1]?.name === "."
        && /^\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)+$/.test(token.lexeme)) {
      const integerId = terminalIds.get("ICONST");
      if (integerId === undefined) return undefined;
      const segments = token.lexeme.split(".");
      let offset = token.offset;
      if (!add("ICONST", segments[0], offset, offset + segments[0].length)) return undefined;
      offset += segments[0].length;
      for (const segment of segments.slice(1)) {
        if (!add(".", ".", offset, offset + 1)) return undefined;
        offset++;
        if (!add("ICONST", segment, offset, offset + segment.length)) return undefined;
        offset += segment.length;
      }
      i++;
      continue;
    }
    const name = phrase ?? terminalName(token);
    if (name === undefined) return undefined;
    const last = phrase ? tokens[i + phraseLength - 1] : token;
    const text = phrase ? tokens.slice(i, i + phraseLength).map((part) => part.lexeme).join(" ") : token.lexeme;
    if (!add(name, text, token.offset, last.offset + last.lexeme.length)) return undefined;
    i += phrase ? phraseLength : 1;
  }

  // The source tokenizer's EOI is included above; Gel's LR parser appends a
  // second EOI sentinel for the grammar's explicit end marker.
  const eoi = terminalIds.get("EOI");
  if (eoi === undefined) return undefined;
  const offset = source.length;
  result.push({ id: eoi, name: "EOI", text: "", start: offset, end: offset });
  return result;
}

/**
 * Recognize a complete EdgeQL block with LR tables generated from Gel's
 * authoritative grammar. This validates syntax only; production reduction to
 * sqlite-ts's executable AST is a separate step.
 */
export function acceptsGelGrammarBlock(source: string): boolean {
  return runGelLR(source, false) === true;
}

/** Parse a block to Gel's generated concrete syntax tree for AST-reducer work. */
export function parseGelGrammarCST(source: string): GelCSTNode | undefined {
  const result = runGelLR(source, true);
  return typeof result === "boolean" ? undefined : result;
}

function runGelLR(source: string, materializeCST: boolean): GelCSTNode | boolean | undefined {
  const input = tokensForBlock(source);
  if (!input) return undefined;
  const stack: Array<{ state: number; node?: GelCSTNode }> = [
    { state: 0, ...(materializeCST ? { node: { kind: "empty" as const } } : {}) },
  ];
  for (const token of input) {
    let steps = 0;
    while (true) {
      if (++steps > 10_000) return false;
      const row = actions[stack[stack.length - 1].state];
      let action = row?.get(token.id);
      let epsilon = false;
      if (!action && epsilonId !== undefined) {
        action = row?.get(epsilonId);
        epsilon = action !== undefined;
      }
      if (!action) return false;
      if (action.kind === "shift") {
        const shifted = epsilon
          ? { id: epsilonId!, name: "<e>", text: "", start: token.start, end: token.start }
          : token;
        const node: GelCSTNode = { kind: "terminal", terminal: shifted.name, text: shifted.text,
          span: { start: shifted.start, end: shifted.end } };
        stack.push({ state: action.state, ...(materializeCST ? { node } : {}) });
        // Epsilon transitions are table actions, not input consumption.
        if (epsilon) continue;
        break;
      }
      if (action.count > stack.length - 1) return false;
      const popped = stack.splice(stack.length - action.count, action.count);
      let node: GelCSTNode | undefined;
      if (materializeCST) {
        const args = popped.map((frame) => frame.node ?? { kind: "empty" as const });
        const inlineIndex = inlines.get(action.production);
        if (inlineIndex !== undefined) {
          const inlineNode = args[inlineIndex] ?? { kind: "empty" as const };
          node = inlineNode.kind === "production"
            ? { ...inlineNode, inlinedIds: [...(inlineNode.inlinedIds ?? []), action.production] }
            : inlineNode;
        } else {
          const spans = args.flatMap((arg) => arg.kind === "empty" || !arg.span ? [] : [arg.span]);
          const span = spans.length ? {
            start: Math.min(...spans.map((item) => item.start)),
            end: Math.max(...spans.map((item) => item.end)),
          } : undefined;
          node = { kind: "production", id: action.production,
            name: gelLRSpec.productionNames[action.production] as [string, string], args,
            ...(span ? { span } : {}) };
        }
      }
      const next = gotos[stack[stack.length - 1].state]?.get(action.nonterminal);
      if (next === undefined) return false;
      stack.push({ state: next, ...(materializeCST && node ? { node } : {}) });
    }
  }
  return materializeCST ? stack[stack.length - 2]?.node : true;
}
