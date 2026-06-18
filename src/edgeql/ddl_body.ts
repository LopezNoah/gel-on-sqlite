// Structured parser for a `CREATE TYPE { … }` body, and the brace-block text
// helpers it (and the runtime DDL path) rely on. Lives in the edgeql layer so
// `parser.ts` can parse DDL bodies into the AST without a cycle (the runtime's
// `ddl.ts` imports `parser.ts`); `ddl.ts` re-exports the brace helpers for its
// callers. See docs/adr/0026 (structured parser), 0028 (relocation).
//
// `parseCreateTypeBody` turns the body text into a list of `CreateTypeBodyEntry`
// nodes, which the runtime converts to `TypeDef` (scalar resolution, FK
// synthesis, inheritance merging stay in the runtime). It reuses the EdgeQL
// tokenizer; it is parse-only, so it has a real unit-test surface
// (`tests/ddl_body.test.ts`).
import { tokenize, type Token } from "./tokenizer.js";
import { tryResult } from "../errors.js";

// Return the text inside an entry's trailing `{ … }` block (excluding the
// braces), or undefined when no balanced trailing block exists.
export const extractTrailingBraceBlock = (entry: string): string | undefined => {
  const tokenized = tryResult(() => tokenize(entry));
  if (!tokenized.ok) return undefined;
  const tokens: readonly Token[] = tokenized.value;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i];
    if (t.kind === "rbrace") {
      let trailingOk = true;
      for (let k = i + 1; k < tokens.length; k += 1) {
        const next = tokens[k];
        if (next.kind === "eof" || next.kind === "semi") continue;
        trailingOk = false;
        break;
      }
      if (!trailingOk) return undefined;
      let depth = 1;
      for (let j = i - 1; j >= 0; j -= 1) {
        const u = tokens[j];
        if (u.kind === "rbrace") depth += 1;
        else if (u.kind === "lbrace") {
          depth -= 1;
          if (depth === 0) return entry.slice(u.offset + 1, t.offset).trim();
        }
      }
      return undefined;
    }
    if (t.kind === "eof" || t.kind === "semi") continue;
    return undefined;
  }
  return undefined;
};

// Return the entry with its trailing `{ … }` block removed (the prefix), or the
// entry unchanged when no balanced trailing block exists.
export const stripTrailingBraceBlock = (entry: string): string => {
  const tokenized = tryResult(() => tokenize(entry));
  if (!tokenized.ok) return entry;
  const tokens: readonly Token[] = tokenized.value;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i];
    if (t.kind === "rbrace") {
      let trailingOk = true;
      for (let k = i + 1; k < tokens.length; k += 1) {
        const next = tokens[k];
        if (next.kind === "eof" || next.kind === "semi") continue;
        trailingOk = false;
        break;
      }
      if (!trailingOk) return entry;
      let depth = 1;
      for (let j = i - 1; j >= 0; j -= 1) {
        const u = tokens[j];
        if (u.kind === "rbrace") depth += 1;
        else if (u.kind === "lbrace") {
          depth -= 1;
          if (depth === 0) return entry.slice(0, u.offset).trimEnd();
        }
      }
      return entry;
    }
    if (t.kind === "eof" || t.kind === "semi") continue;
    return entry;
  }
  return entry;
};

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

/** One operation parsed from an `ALTER TYPE …` tail (everything after the type
 * name). `pointerPath` is the link/property chain the op applies to. */
export type AlterTypeOp =
  | { kind: "set_default"; pointerPath: string[]; exprText: string }
  | { kind: "drop_constraint"; constraint: ExclusiveConstraintSpec }
  | { kind: "create_constraint"; constraint: ExclusiveConstraintSpec }
  | {
      kind: "create_access_policy";
      name: string;
      effect: "allow" | "deny";
      // Raw operation phrases as written: "select" | "insert" | "delete" |
      // "update" | "update read" | "update write" | "all". The runtime
      // normalizes these to AccessPolicyOperation[].
      operations: string[];
      // The `USING (...)` predicate source text (undefined ⇒ no predicate).
      usingExprText?: string;
    };

/**
 * Parse the tail of an `ALTER TYPE <name> …` statement (the text after the type
 * name — either a `{ … }` block or chained `ALTER LINK/PROPERTY … SET … `
 * clauses) into structured ops. Handles `SET default := <expr>` on a pointer
 * path and `(CREATE|DROP) [DELEGATED] CONSTRAINT exclusive [ON …] [EXCEPT …]`
 * (the only constraint the runtime enforces). Pure and total.
 */
export const parseAlterTypeBody = (tail: string): AlterTypeOp[] => {
  const src = tail;
  const tokenized = tryResult(() => tokenize(src));
  if (!tokenized.ok) return [];
  const tokens: readonly Token[] = tokenized.value;
  const ops: AlterTypeOp[] = [];

  const sliceParen = (startIdx: number): { text: string; next: number } | undefined => {
    if (tokens[startIdx]?.kind !== "lparen") return undefined;
    let depth = 0;
    for (let j = startIdx; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.kind === "lparen") depth += 1;
      else if (t.kind === "rparen") {
        depth -= 1;
        if (depth === 0) return { text: src.slice(tokens[startIdx].offset + 1, t.offset).trim(), next: j + 1 };
      }
    }
    return undefined;
  };

  const parseConstraintOp = (idx: number): { op: AlterTypeOp; next: number } | undefined => {
    const verb = tokens[idx];
    const isDrop = verb?.kind === "kw_drop";
    const isCreate = verb?.kind === "kw_create";
    if (!isDrop && !isCreate) return undefined;
    let j = idx + 1;
    let delegated = false;
    if (tokens[j]?.kind === "identifier" && tokens[j].lower === "delegated") { delegated = true; j += 1; }
    if (tokens[j]?.kind !== "kw_constraint") return undefined;
    j += 1;
    const cnameTok = tokens[j];
    if (!cnameTok) return undefined;
    let cname = stripBacktickName(cnameTok.lexeme);
    j += 1;
    if (tokens[j]?.kind === "coloncolon" && tokens[j + 1]) { cname = stripBacktickName(tokens[j + 1].lexeme); j += 2; }
    if (cname.includes("::")) cname = cname.slice(cname.lastIndexOf("::") + 2);
    if (cname !== "exclusive") return undefined;
    let onExpr: string | undefined;
    let exceptExpr: string | undefined;
    while (tokens[j]) {
      if (tokens[j].kind === "kw_on") {
        const sliced = sliceParen(j + 1);
        if (!sliced) break;
        onExpr = sliced.text; j = sliced.next; continue;
      }
      if (tokens[j].kind === "kw_except") {
        const sliced = sliceParen(j + 1);
        if (!sliced) break;
        exceptExpr = sliced.text; j = sliced.next; continue;
      }
      break;
    }
    const constraint: ExclusiveConstraintSpec = { delegated, onExpr, exceptExpr };
    return { op: { kind: isDrop ? "drop_constraint" : "create_constraint", constraint }, next: j };
  };

  // `CREATE ACCESS POLICY <name> (ALLOW|DENY) <ops> [USING (<expr>)] [{ … }]`.
  // Parsed off the token stream (the USING predicate is sliced by balanced
  // parens, not pattern-matched) so the predicate text flows into the normal
  // EdgeQL pipeline for lowering. Returns undefined when this isn't an access
  // policy (so `parseConstraintOp` gets its turn on the same `CREATE`).
  const parseAccessPolicyOp = (idx: number): { op: AlterTypeOp; next: number } | undefined => {
    if (tokens[idx]?.kind !== "kw_create") return undefined;
    let j = idx + 1;
    if (tokens[j]?.lower !== "access") return undefined;
    j += 1;
    if (tokens[j]?.kind !== "kw_policy") return undefined;
    j += 1;
    const nameTok = tokens[j];
    if (!nameTok || nameTok.kind === "semi" || nameTok.kind === "eof"
      || nameTok.kind === "lbrace" || nameTok.kind === "rbrace") return undefined;
    const name = stripBacktickName(nameTok.lexeme);
    j += 1;
    const effectLower = tokens[j]?.lower;
    if (effectLower !== "allow" && effectLower !== "deny") return undefined;
    const effect = effectLower as "allow" | "deny";
    j += 1;
    const operations: string[] = [];
    let parseOk = true;
    while (tokens[j]) {
      const t = tokens[j];
      if (t.kind === "kw_using" || t.kind === "semi" || t.kind === "rbrace"
        || t.kind === "eof" || t.kind === "lbrace") break;
      if (t.kind === "comma") { j += 1; continue; }
      if (t.kind === "kw_select") { operations.push("select"); j += 1; continue; }
      if (t.kind === "kw_insert") { operations.push("insert"); j += 1; continue; }
      if (t.kind === "kw_delete") { operations.push("delete"); j += 1; continue; }
      if (t.lower === "all") { operations.push("all"); j += 1; continue; }
      if (t.kind === "kw_update") {
        j += 1;
        if (tokens[j]?.lower === "read") { operations.push("update read"); j += 1; }
        else if (tokens[j]?.lower === "write") { operations.push("update write"); j += 1; }
        else operations.push("update");
        continue;
      }
      parseOk = false;
      break;
    }
    if (!parseOk) return undefined;
    let usingExprText: string | undefined;
    if (tokens[j]?.kind === "kw_using") {
      const sliced = sliceParen(j + 1);
      if (!sliced) return undefined;
      usingExprText = sliced.text;
      j = sliced.next;
    }
    // Skip an optional trailing `{ … }` body (annotations, set errmessage, …)
    // so the outer walk doesn't reparse its contents.
    if (tokens[j]?.kind === "lbrace") {
      let depth = 1;
      j += 1;
      while (tokens[j] && depth > 0) {
        if (tokens[j].kind === "lbrace") depth += 1;
        else if (tokens[j].kind === "rbrace") depth -= 1;
        j += 1;
      }
    }
    return { op: { kind: "create_access_policy", name, effect, operations, usingExprText }, next: j };
  };

  const sliceDefaultExpr = (assignIdx: number): { text: string; next: number } => {
    const startTok = tokens[assignIdx + 1];
    let depth = 0;
    let j = assignIdx + 1;
    for (; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.kind === "eof") break;
      if (t.kind === "lparen" || t.kind === "lbrace" || t.kind === "lbracket") depth += 1;
      else if (t.kind === "rparen" || t.kind === "rbracket") depth -= 1;
      else if (t.kind === "rbrace") {
        if (depth === 0) break;
        depth -= 1;
      } else if (t.kind === "semi" && depth === 0) break;
    }
    const endTok = tokens[j];
    const endOffset = endTok && endTok.kind !== "eof" ? endTok.offset : src.length;
    return { text: startTok ? src.slice(startTok.offset, endOffset).trim() : "", next: j };
  };

  const skipPointerClause = (start: number, end: number): number => {
    let j = start + 3; // past ALTER <kind> <name>
    while (j < end && tokens[j]?.kind !== "lbrace" && tokens[j]?.kind !== "kw_alter"
      && tokens[j]?.kind !== "kw_set" && tokens[j]?.kind !== "semi"
      && tokens[j]?.kind !== "kw_drop" && tokens[j]?.kind !== "kw_create") {
      j += 1;
    }
    return j;
  };

  const walkAlterPointer = (start: number, end: number, path: string[], braceDepth: number): void => {
    const nameT = tokens[start + 2];
    const name = stripBacktickName(nameT.lexeme);
    const nextPath = [...path, name];
    const j = start + 3;
    if (tokens[j]?.kind === "lbrace") {
      let depth = 1; let k = j + 1;
      while (k < end && depth > 0) {
        if (tokens[k].kind === "lbrace") depth += 1;
        else if (tokens[k].kind === "rbrace") depth -= 1;
        if (depth === 0) break;
        k += 1;
      }
      walk(j + 1, k, nextPath, braceDepth + 1);
    } else {
      walk(j, end, nextPath, braceDepth);
    }
  };

  function walk(start: number, end: number, path: string[], braceDepth: number): void {
    let j = start;
    while (j < end) {
      const t = tokens[j];
      if (!t || t.kind === "eof") break;
      if (t.kind === "lbrace") {
        let depth = 1; let k = j + 1;
        while (k < end && depth > 0) {
          if (tokens[k].kind === "lbrace") depth += 1;
          else if (tokens[k].kind === "rbrace") depth -= 1;
          if (depth === 0) break;
          k += 1;
        }
        walk(j + 1, k, path, braceDepth + 1);
        j = k + 1;
        continue;
      }
      if (t.kind === "rbrace" || t.kind === "semi") { j += 1; continue; }
      if (t.kind === "kw_alter") {
        const kindTok = tokens[j + 1];
        const nameT = tokens[j + 2];
        if ((kindTok?.kind === "kw_link" || kindTok?.kind === "kw_property") && nameT) {
          walkAlterPointer(j, end, path, braceDepth);
          j = skipPointerClause(j, end);
          continue;
        }
        j += 1;
        continue;
      }
      if (t.kind === "kw_set" && tokens[j + 1]?.lower === "default" && tokens[j + 2]?.kind === "assign") {
        const sliced = sliceDefaultExpr(j + 2);
        if (path.length > 0) ops.push({ kind: "set_default", pointerPath: [...path], exprText: sliced.text });
        j = sliced.next;
        continue;
      }
      const ap = parseAccessPolicyOp(j);
      if (ap) { ops.push(ap.op); j = ap.next; continue; }
      const con = parseConstraintOp(j);
      if (con) { ops.push(con.op); j = con.next; continue; }
      j += 1;
    }
  }

  walk(0, tokens.length, [], 0);
  return ops;
};
