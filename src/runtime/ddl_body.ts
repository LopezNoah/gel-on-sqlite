// Structured parser for a `CREATE TYPE { … }` body.
//
// The EdgeQL DDL parser (`edgeql/parser.ts`) keeps a `CREATE TYPE` body as raw
// text (`skipDDLBody`); the runtime used to re-parse that text by hand in
// `registerDynamicTypeDDL` via a token-walker plus regex helpers, with no test
// surface but executed rows. This module is the one structured home for that
// body grammar: it turns the body text into a list of `CreateTypeBodyEntry`
// nodes, which the runtime then converts to `TypeDef` (the conversion — scalar
// resolution, FK synthesis, inheritance merging — stays in the runtime). It
// reuses the EdgeQL tokenizer (as the old token-walker did) and the brace
// helpers in `ddl.ts`; it is parse-only, so it has a real unit-test surface
// (`tests/ddl_body.test.ts`). See docs/adr/0026.
import { tokenize, type Token } from "../edgeql/tokenizer.js";
import { tryResult } from "../errors.js";
import { extractTrailingBraceBlock, stripTrailingBraceBlock } from "./ddl.js";

/** A `CREATE [DELEGATED] CONSTRAINT exclusive [ON (…)] [EXCEPT (…)]` descriptor. */
export interface ExclusiveConstraintSpec {
  delegated: boolean;
  onExpr?: string;
  exceptExpr?: string;
}

/** A link property declared inside a `CREATE LINK x { CREATE PROPERTY … }` body. */
export interface DdlLinkProperty {
  name: string;
  targetType: string;
  required: boolean;
  multi: boolean;
}

/** One parsed entry of a `CREATE TYPE` body. */
export type CreateTypeBodyEntry =
  | {
      kind: "property";
      name: string;
      targetType: string;
      required: boolean;
      multi: boolean;
      constraints: ExclusiveConstraintSpec[];
      defaultText?: string;
    }
  | {
      kind: "link";
      name: string;
      targetType: string;
      required: boolean;
      multi: boolean;
      properties: DdlLinkProperty[];
      constraints: ExclusiveConstraintSpec[];
    }
  | {
      kind: "computed_link";
      name: string;
      exprText: string;
    }
  | {
      // `ALTER PROPERTY|LINK <name> { CREATE [DELEGATED] CONSTRAINT exclusive … }`
      // — adds an exclusive constraint to a (usually inherited) pointer without
      // redeclaring it.
      kind: "alter_pointer";
      pointerKind: "property" | "link";
      name: string;
      constraints: ExclusiveConstraintSpec[];
    }
  | {
      // A type-level `CREATE [DELEGATED] CONSTRAINT exclusive [ON (…)] [EXCEPT (…)]`.
      kind: "type_exclusive_constraint";
      delegated: boolean;
      onExpr?: string;
      exceptExpr?: string;
    };

const MEMBER_MODIFIER_KINDS = new globalThis.Set(["kw_required", "kw_optional", "kw_multi", "kw_single"]);

const stripBacktickName = (lexeme: string): string =>
  lexeme.startsWith("`") && lexeme.endsWith("`") ? lexeme.slice(1, -1) : lexeme;

const nameFromToken = (tok: Token | undefined): string | undefined => {
  if (!tok || (tok.kind !== "identifier" && tok.kind !== "backtick_name")) return undefined;
  return tok.kind === "backtick_name" ? stripBacktickName(tok.lexeme) : tok.lexeme;
};

// The byte range from `tokens[startIdx]` through the last non-eof token,
// sliced out of `source` and trimmed (so a `-> tuple<int64, str>` target or a
// `:= <expr>` body comes back verbatim).
const sliceTokenRange = (tokens: readonly Token[], startIdx: number, source: string): string => {
  if (startIdx >= tokens.length) return "";
  const startTok = tokens[startIdx];
  let endOffset = source.length;
  for (let j = tokens.length - 1; j >= startIdx; j -= 1) {
    const t = tokens[j];
    if (t.kind === "eof") continue;
    endOffset = t.offset + t.lexeme.length;
    break;
  }
  return source.slice(startTok.offset, endOffset).trim();
};

// Split a script body into top-level `;`-separated statements, respecting
// nesting (braces/parens/brackets), single/double quotes, and dollar-quoted
// strings so a `;` inside an expression or string doesn't split a statement.
const splitTopLevelStatements = (script: string): string[] => {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let dollarMarker: string | undefined;

  const dollarQuoteAt = (idx: number): string | undefined => {
    if (script[idx] !== "$") return undefined;
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(idx));
    return match?.[0];
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (dollarMarker) {
      if (script.startsWith(dollarMarker, i)) {
        i += dollarMarker.length - 1;
        dollarMarker = undefined;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    const marker = dollarQuoteAt(i);
    if (marker) {
      dollarMarker = marker;
      i += marker.length - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === ";" && depth === 0) {
      const piece = script.slice(start, i).trim();
      if (piece) statements.push(piece);
      start = i + 1;
    }
  }
  const tail = script.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
};

type MemberHeader =
  | { kind: "property" | "link"; required: boolean; multi: boolean; name: string; targetType: string }
  | { kind: "computed_link"; required: boolean; multi: boolean; name: string; exprText: string };

// `CREATE [required|optional|multi|single] property|link <name> (-> | : | :=) …`
const parseMemberHeader = (entry: string): MemberHeader | undefined => {
  const tokenized = tryResult(() => tokenize(entry));
  if (!tokenized.ok) return undefined;
  const tokens: readonly Token[] = tokenized.value;
  let i = 0;
  if (tokens[i]?.kind !== "kw_create") return undefined;
  i += 1;
  let required = false;
  let multi = false;
  while (tokens[i] && MEMBER_MODIFIER_KINDS.has(tokens[i].kind)) {
    if (tokens[i].kind === "kw_required") required = true;
    else if (tokens[i].kind === "kw_multi") multi = true;
    i += 1;
  }
  const memberKindTok = tokens[i];
  let memberKind: "property" | "link";
  if (memberKindTok?.kind === "kw_property") memberKind = "property";
  else if (memberKindTok?.kind === "kw_link") memberKind = "link";
  else return undefined;
  i += 1;
  const memberName = nameFromToken(tokens[i]);
  if (memberName === undefined) return undefined;
  i += 1;
  const sepTok = tokens[i];
  if (!sepTok) return undefined;
  // `:=` introduces a computed link alias; `->`/`:` a stored property/link.
  if (sepTok.kind === "assign") {
    if (memberKind !== "link") return undefined;
    const exprText = sliceTokenRange(tokens, i + 1, entry);
    if (exprText.length === 0) return undefined;
    return { kind: "computed_link", required, multi, name: memberName, exprText };
  }
  if (sepTok.kind === "arrow" || sepTok.kind === "colon") {
    const targetType = sliceTokenRange(tokens, i + 1, entry);
    if (targetType.length === 0) return undefined;
    return { kind: memberKind, required, multi, name: memberName, targetType };
  }
  return undefined;
};

// `ALTER PROPERTY|LINK <name>` header.
const parseAlterPointer = (entry: string): { kind: "property" | "link"; name: string } | undefined => {
  const tokenized = tryResult(() => tokenize(entry));
  if (!tokenized.ok) return undefined;
  const tokens: readonly Token[] = tokenized.value;
  if (tokens[0]?.kind !== "kw_alter") return undefined;
  const kindTok = tokens[1];
  let kind: "property" | "link";
  if (kindTok?.kind === "kw_property") kind = "property";
  else if (kindTok?.kind === "kw_link") kind = "link";
  else return undefined;
  const name = nameFromToken(tokens[2]);
  if (name === undefined) return undefined;
  return { kind, name };
};

// `CREATE [DELEGATED] CONSTRAINT exclusive [ON (<expr>)] [EXCEPT (<expr>)]`.
// Only `exclusive` is recognised — other constraint kinds aren't enforced by
// the runtime, so they're dropped (return undefined).
const parseExclusiveConstraint = (entry: string): ExclusiveConstraintSpec | undefined => {
  const tokenized = tryResult(() => tokenize(entry));
  if (!tokenized.ok) return undefined;
  const tokens: readonly Token[] = tokenized.value;
  let i = 0;
  if (tokens[i]?.kind !== "kw_create") return undefined;
  i += 1;
  let delegated = false;
  if (tokens[i] && tokens[i].kind === "identifier" && tokens[i].lower === "delegated") {
    delegated = true;
    i += 1;
  }
  if (tokens[i]?.kind !== "kw_constraint") return undefined;
  i += 1;
  let constraintName = nameFromToken(tokens[i]);
  if (constraintName === undefined) return undefined;
  i += 1;
  // Optional `std::` (or other) module qualifier emitted as `:: <name>`.
  if (tokens[i]?.kind === "coloncolon") {
    const qual = nameFromToken(tokens[i + 1]);
    if (qual !== undefined) {
      constraintName = qual;
      i += 2;
    }
  }
  if (constraintName.includes("::")) {
    constraintName = constraintName.slice(constraintName.lastIndexOf("::") + 2);
  }
  if (constraintName !== "exclusive") return undefined;

  let onExpr: string | undefined;
  let exceptExpr: string | undefined;
  const sliceParen = (startIdx: number): { text: string; next: number } | undefined => {
    if (tokens[startIdx]?.kind !== "lparen") return undefined;
    let depth = 0;
    for (let j = startIdx; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.kind === "lparen") depth += 1;
      else if (t.kind === "rparen") {
        depth -= 1;
        if (depth === 0) return { text: entry.slice(tokens[startIdx].offset + 1, t.offset).trim(), next: j + 1 };
      }
    }
    return undefined;
  };
  while (tokens[i]) {
    if (tokens[i].kind === "kw_on") {
      const sliced = sliceParen(i + 1);
      if (!sliced) break;
      onExpr = sliced.text;
      i = sliced.next;
      continue;
    }
    if (tokens[i].kind === "kw_except") {
      const sliced = sliceParen(i + 1);
      if (!sliced) break;
      exceptExpr = sliced.text;
      i = sliced.next;
      continue;
    }
    break;
  }
  return { delegated, onExpr, exceptExpr };
};

// Collect every exclusive constraint declared inside a property/link `{ … }`
// inner body.
const collectExclusiveConstraints = (innerBody: string): ExclusiveConstraintSpec[] => {
  const out: ExclusiveConstraintSpec[] = [];
  for (const bodyEntry of splitTopLevelStatements(innerBody)) {
    const spec = parseExclusiveConstraint(stripTrailingBraceBlock(bodyEntry));
    if (spec) out.push(spec);
  }
  return out;
};

// Extract the `[SET] default := <expr>` text from a property `{ … }` inner body.
const extractDefaultText = (innerBody: string): string | undefined => {
  for (const rawEntry of splitTopLevelStatements(innerBody)) {
    const entry = rawEntry.trim();
    const tokenized = tryResult(() => tokenize(entry));
    if (!tokenized.ok) continue;
    const tokens: readonly Token[] = tokenized.value;
    let i = 0;
    if (tokens[i]?.kind === "kw_set") i += 1;
    if (tokens[i]?.lower !== "default") continue;
    i += 1;
    if (tokens[i]?.kind !== "assign") continue;
    i += 1;
    if (i >= tokens.length || tokens[i].kind === "eof") return undefined;
    const startOffset = tokens[i].offset;
    let endOffset = entry.length;
    for (let j = tokens.length - 1; j >= i; j -= 1) {
      if (tokens[j].kind === "eof" || tokens[j].kind === "semi") continue;
      endOffset = tokens[j].offset + tokens[j].lexeme.length;
      break;
    }
    // A trailing string token's lexeme excludes its quotes, so prefer slicing
    // to the entry end (drop a trailing `;`) and fall back to the token range.
    const text = entry.slice(startOffset).trim().replace(/;\s*$/, "");
    return text.length > 0 ? text : entry.slice(startOffset, endOffset).trim();
  }
  return undefined;
};

const parseLinkProperties = (innerBody: string): DdlLinkProperty[] => {
  const out: DdlLinkProperty[] = [];
  for (const linkBodyEntry of splitTopLevelStatements(innerBody)) {
    const header = parseMemberHeader(stripTrailingBraceBlock(linkBodyEntry));
    if (!header || header.kind !== "property") continue;
    out.push({ name: header.name, targetType: header.targetType, required: header.required, multi: header.multi });
  }
  return out;
};

/**
 * Parse a `CREATE TYPE` body into structured entries. The body text is the
 * content between the type's `{` and `}` (what `extractTrailingBraceBlock`
 * yields for `CREATE TYPE X { … }`). Pure and total: an entry that isn't a
 * recognised member/constraint shape is silently skipped (the old token-walker
 * did the same), so callers see only the declarations the runtime models.
 */
export const parseCreateTypeBody = (bodyText: string): CreateTypeBodyEntry[] => {
  const entries: CreateTypeBodyEntry[] = [];
  for (const rawEntry of splitTopLevelStatements(bodyText)) {
    const innerBody = extractTrailingBraceBlock(rawEntry);
    const entry = stripTrailingBraceBlock(rawEntry);
    const member = parseMemberHeader(entry);
    if (member) {
      if (member.kind === "computed_link") {
        entries.push({ kind: "computed_link", name: member.name, exprText: member.exprText });
      } else if (member.kind === "property") {
        entries.push({
          kind: "property",
          name: member.name,
          targetType: member.targetType,
          required: member.required,
          multi: member.multi,
          constraints: innerBody ? collectExclusiveConstraints(innerBody) : [],
          defaultText: innerBody ? extractDefaultText(innerBody) : undefined,
        });
      } else {
        entries.push({
          kind: "link",
          name: member.name,
          targetType: member.targetType,
          required: member.required,
          multi: member.multi,
          properties: innerBody ? parseLinkProperties(innerBody) : [],
          constraints: innerBody ? collectExclusiveConstraints(innerBody) : [],
        });
      }
      continue;
    }
    const altered = parseAlterPointer(entry);
    if (altered && innerBody) {
      const constraints = collectExclusiveConstraints(innerBody);
      if (constraints.length > 0) {
        entries.push({ kind: "alter_pointer", pointerKind: altered.kind, name: altered.name, constraints });
      }
      continue;
    }
    const typeExcl = parseExclusiveConstraint(entry);
    if (typeExcl) {
      entries.push({ kind: "type_exclusive_constraint", delegated: typeExcl.delegated, onExpr: typeExcl.onExpr, exceptExpr: typeExcl.exceptExpr });
    }
  }
  return entries;
};
