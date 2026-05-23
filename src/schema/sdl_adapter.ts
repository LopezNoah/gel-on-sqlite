import { AppError } from "../errors.js";
import type {
  AnnotationDef,
  CollectionTypeDef,
  ComputedDef,
  ComputedValuePart,
  ConstraintDef,
  FieldDefaultExpr,
  OnTargetDeleteAction,
  ScalarType,
  ScalarValue,
} from "../types.js";
import { normalizeAnnotationName } from "./annos.js";
import { parseComputedSetLiteralExpr } from "./computed_expr.js";
import type {
  AliasDeclaration,
  AbstractAnnotationDeclaration,
  ConstraintDeclaration,
  DeclarativeSchema,
  FunctionDeclaration,
  ComputedLinkPropertyExpr,
  LinkMember,
  LinkMemberProperty,
  ObjectTypeDeclaration,
  PropertyMember,
  SchemaModule,
  TypeMember,
} from "./declarative.js";
import { tokenize, type Token } from "../edgeql/tokenizer.js";
import { parseEdgeQL } from "../edgeql/parser.js";
import type { ScalarTypeDeclaration } from "./scalar.js";
import { ScalarRegistry } from "./scalar.js";
import {
  parseDocument,
  type AbstractAnnotationNode,
  type AnnotationAssignmentNode,
  type ConstraintDeclarationNode,
  type DeclarationNode,
  type DocumentNode,
  type FunctionDeclarationNode,
  type IndexDeclarationNode,
  type LinkBodyNode,
  type LinkDeclarationNode,
  type PropertyBodyNode,
  type PropertyDeclarationNode,
  type QualifiedNameNode,
  type ScalarTypeDeclarationNode,
  type TopLevelDeclarationNode,
  type TypeDeclarationNode,
  type AliasDeclarationNode,
} from "./schema_tokenizer.js";

export interface NewSDLAdapterOptions {
  legacySyntaxCompat: boolean;
}

interface ParsedModuleDocument {
  moduleName: string;
  document: DocumentNode;
  explicit: boolean;
}

interface ParsedModuleBodies {
  moduleBodies: Map<string, string[]>;
  topLevelBody: string;
}

export class UnsupportedSDLFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSDLFeatureError";
  }
}

const unsupported = (message: string): never => {
  throw new UnsupportedSDLFeatureError(message);
};

const isIdentifierStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isIdentifierPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

const skipQuotedString = (source: string, start: number): number => {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  throw new AppError("E_SYNTAX", "Unterminated string literal", 1, start + 1);
};

const skipDollarQuotedString = (source: string, start: number): number | null => {
  if (source[start] !== "$") {
    return null;
  }

  let i = start + 1;
  while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
    i += 1;
  }

  if (source[i] !== "$") {
    return null;
  }

  const tag = source.slice(start, i + 1);
  const end = source.indexOf(tag, i + 1);
  if (end < 0) {
    throw new AppError("E_SYNTAX", "Unterminated dollar-quoted string", 1, start + 1);
  }

  return end + tag.length;
};

const skipWhitespaceAndComments = (source: string, start: number): number => {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "#") {
      i += 1;
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) {
        throw new AppError("E_SYNTAX", "Unterminated block comment", 1, i + 1);
      }
      i = end + 2;
      continue;
    }

    break;
  }

  return i;
};

const readQualifiedIdentifier = (source: string, start: number): { name: string; next: number } => {
  let i = start;
  if (!isIdentifierStart(source[i] ?? "")) {
    throw new AppError("E_SYNTAX", "Expected module name", 1, i + 1);
  }

  i += 1;
  while (i < source.length && isIdentifierPart(source[i])) {
    i += 1;
  }

  while (source[i] === ":" && source[i + 1] === ":") {
    i += 2;
    if (!isIdentifierStart(source[i] ?? "")) {
      throw new AppError("E_SYNTAX", "Expected module name after '::'", 1, i + 1);
    }
    i += 1;
    while (i < source.length && isIdentifierPart(source[i])) {
      i += 1;
    }
  }

  return {
    name: source.slice(start, i),
    next: i,
  };
};

const findMatchingBrace = (source: string, openBraceIndex: number): number => {
  let depth = 1;
  let i = openBraceIndex + 1;

  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipQuotedString(source, i);
      continue;
    }

    const dollarEnd = skipDollarQuotedString(source, i);
    if (dollarEnd !== null) {
      i = dollarEnd;
      continue;
    }

    if (ch === "#") {
      i += 1;
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) {
        throw new AppError("E_SYNTAX", "Unterminated block comment", 1, i + 1);
      }
      i = end + 2;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  throw new AppError("E_SYNTAX", "Unterminated module block", 1, openBraceIndex + 1);
};

const startsWithKeyword = (source: string, index: number, keyword: string): boolean => {
  if (!source.startsWith(keyword, index)) {
    return false;
  }

  const prev = index > 0 ? source[index - 1] : "";
  const next = source[index + keyword.length] ?? "";
  return !isIdentifierPart(prev) && !isIdentifierPart(next);
};

const resolveNestedModuleName = (parentModuleName: string | undefined, name: string): string => {
  if (!parentModuleName || name.includes("::")) {
    return name;
  }
  return `${parentModuleName}::${name}`;
};

const appendModuleBody = (moduleBodies: Map<string, string[]>, moduleName: string, body: string): void => {
  const existing = moduleBodies.get(moduleName);
  if (existing) {
    existing.push(body);
    return;
  }

  moduleBodies.set(moduleName, [body]);
};

const extractModuleBodies = (
  source: string,
  parentModuleName: string | undefined,
  moduleBodies: Map<string, string[]>,
): string => {
  let i = 0;
  let depth = 0;
  let segmentStart = 0;
  const nonModuleSegments: string[] = [];

  while (i < source.length) {
    const ch = source[i];

    if (ch === "'" || ch === '"') {
      i = skipQuotedString(source, i);
      continue;
    }

    const dollarEnd = skipDollarQuotedString(source, i);
    if (dollarEnd !== null) {
      i = dollarEnd;
      continue;
    }

    if (ch === "#") {
      i += 1;
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) {
        throw new AppError("E_SYNTAX", "Unterminated block comment", 1, i + 1);
      }
      i = end + 2;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }

    if (depth === 0 && startsWithKeyword(source, i, "module")) {
      nonModuleSegments.push(source.slice(segmentStart, i));

      let cursor = i + "module".length;
      cursor = skipWhitespaceAndComments(source, cursor);

      const moduleName = readQualifiedIdentifier(source, cursor);
      cursor = moduleName.next;
      cursor = skipWhitespaceAndComments(source, cursor);

      if (source[cursor] !== "{") {
        throw new AppError("E_SYNTAX", "Expected '{' after module name", 1, cursor + 1);
      }

      const bodyStart = cursor + 1;
      const bodyEnd = findMatchingBrace(source, cursor);
      const fullModuleName = resolveNestedModuleName(parentModuleName, moduleName.name);
      if (!moduleBodies.has(fullModuleName)) {
        moduleBodies.set(fullModuleName, []);
      }
      const body = source.slice(bodyStart, bodyEnd);
      const bodyWithoutNestedModules = extractModuleBodies(body, fullModuleName, moduleBodies);
      appendModuleBody(moduleBodies, fullModuleName, bodyWithoutNestedModules);

      i = bodyEnd + 1;
      segmentStart = i;
      continue;
    }

    i += 1;
  }

  nonModuleSegments.push(source.slice(segmentStart));
  return nonModuleSegments.join("");
};

const parseModuleBlocks = (source: string): ParsedModuleBodies => {
  const moduleBodies = new Map<string, string[]>();
  const topLevelBody = extractModuleBodies(source, undefined, moduleBodies);
  return {
    moduleBodies,
    topLevelBody,
  };
};

const qualifiedNameToString = (name: QualifiedNameNode): string => name.parts.join("::");

interface ResolvedDeclarationName {
  moduleName: string;
  localName: string;
}

const resolveDeclarationName = (
  contextModuleName: string,
  name: QualifiedNameNode,
): ResolvedDeclarationName => {
  if (name.parts.length > 1) {
    return {
      moduleName: name.parts.slice(0, -1).join("::"),
      localName: name.parts.at(-1) ?? "",
    };
  }

  return {
    moduleName: contextModuleName,
    localName: name.parts[0] ?? "",
  };
};

const normalizeTypeName = (moduleName: string, name: string): string => {
  if (name.includes("::")) {
    return name;
  }
  return `${moduleName}::${name}`;
};

const normalizeConstraintName = (moduleName: string, name: string): string => {
  if (name.includes("::")) {
    return name;
  }

  if (["exclusive", "max_len_value", "min_len_value"].includes(name)) {
    return `std::${name}`;
  }

  return `${moduleName}::${name}`;
};

const defaultConstraintParamNames = (name: string, arity: number): string[] | undefined => {
  const shortName = name.includes("::") ? name.split("::").at(-1) ?? name : name;
  if (shortName === "max_len_value") {
    return arity > 0 ? ["max"] : [];
  }
  if (shortName === "min_len_value") {
    return arity > 0 ? ["min"] : [];
  }
  return undefined;
};

const parseStringLiteral = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return undefined;
  }

  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed.at(-1) !== quote) {
    return undefined;
  }

  let out = "";
  for (let i = 1; i < trimmed.length - 1; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length - 1) {
      out += trimmed[i + 1];
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
};

const parseScalarLiteral = (text: string): ScalarValue | undefined => {
  const trimmed = text.trim();
  const stringValue = parseStringLiteral(trimmed);
  if (stringValue !== undefined) {
    return stringValue;
  }

  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isNaN(numeric) ? undefined : numeric;
  }

  return undefined;
};

type ComputedLinkPropertyToken =
  | { kind: "at" }
  | { kind: "dot" }
  | { kind: "op"; value: "*" | "+" | "-" | "/" | "++" | "??" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "identifier"; value: string }
  | { kind: "literal"; value: ScalarValue };

const tokenizeComputedLinkPropertyExpr = (text: string): ComputedLinkPropertyToken[] => {
  const tokens: ComputedLinkPropertyToken[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "@") {
      tokens.push({ kind: "at" });
      i += 1;
      continue;
    }
    if (ch === ".") {
      tokens.push({ kind: "dot" });
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: ch === "(" ? "lparen" : "rparen" });
      i += 1;
      continue;
    }
    if (ch === "?" && text[i + 1] === "?") {
      tokens.push({ kind: "op", value: "??" });
      i += 2;
      continue;
    }
    if (ch === "+" && text[i + 1] === "+") {
      tokens.push({ kind: "op", value: "++" });
      i += 2;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "-" || ch === "/") {
      const next = text[i + 1];
      const prev = tokens.at(-1);
      if (
        ch === "-"
        && next !== undefined
        && /\d/.test(next)
        && (!prev || prev.kind === "op" || prev.kind === "lparen")
      ) {
        const start = i;
        i += 1;
        while (i < text.length && /\d/.test(text[i])) i += 1;
        if (text[i] === ".") {
          i += 1;
          while (i < text.length && /\d/.test(text[i])) i += 1;
        }
        tokens.push({ kind: "literal", value: Number(text.slice(start, i)) });
        continue;
      }
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const end = skipQuotedString(text, i);
      const value = parseStringLiteral(text.slice(i, end));
      if (value === undefined) {
        unsupported(`Invalid computed link property string literal '${text.slice(i, end)}'`);
      }
      tokens.push({ kind: "literal", value: value as string });
      i = end;
      continue;
    }

    if (/\d/.test(ch)) {
      const start = i;
      while (i < text.length && /\d/.test(text[i])) i += 1;
      if (text[i] === ".") {
        i += 1;
        while (i < text.length && /\d/.test(text[i])) i += 1;
      }
      tokens.push({ kind: "literal", value: Number(text.slice(start, i)) });
      continue;
    }

    if (isIdentifierStart(ch)) {
      const start = i;
      i += 1;
      while (i < text.length && isIdentifierPart(text[i])) i += 1;
      const value = text.slice(start, i);
      const literal = parseScalarLiteral(value);
      tokens.push(literal === undefined ? { kind: "identifier", value } : { kind: "literal", value: literal });
      continue;
    }

    unsupported(`Unsupported computed link property expression token '${ch}'`);
  }

  return tokens;
};

class ComputedLinkPropertyExprParser {
  private pos = 0;

  constructor(private readonly tokens: ComputedLinkPropertyToken[]) {}

  parse(): ComputedLinkPropertyExpr {
    const expr = this.parseCoalesce();
    if (this.current()) {
      unsupported("Unexpected token in computed link property expression");
    }
    return expr;
  }

  private parseCoalesce(): ComputedLinkPropertyExpr {
    let left = this.parseConcat();
    while (this.matchOp("??")) {
      const op = this.previous().value;
      const right = this.parseConcat();
      left = { kind: "binary_op", op, left, right };
    }
    return left;
  }

  private parseConcat(): ComputedLinkPropertyExpr {
    let left = this.parseAdditive();
    while (this.matchOp("++")) {
      const op = this.previous().value;
      const right = this.parseAdditive();
      left = { kind: "binary_op", op, left, right };
    }
    return left;
  }

  private parseAdditive(): ComputedLinkPropertyExpr {
    let left = this.parseMultiplicative();
    while (this.matchOp("+") || this.matchOp("-")) {
      const op = this.previous().value;
      const right = this.parseMultiplicative();
      left = { kind: "binary_op", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): ComputedLinkPropertyExpr {
    let left = this.parsePrimary();
    while (this.matchOp("*") || this.matchOp("/")) {
      const op = this.previous().value;
      const right = this.parsePrimary();
      left = { kind: "binary_op", op, left, right };
    }
    return left;
  }

  private parsePrimary(): ComputedLinkPropertyExpr {
    const token = this.current();
    if (!token) {
      return unsupported("Expected computed link property expression");
    }

    if (token.kind === "literal") {
      this.pos += 1;
      return { kind: "literal", value: token.value };
    }

    if (this.match("dot")) {
      const name = this.expectIdentifier("Expected field name after '.' in computed link property expression");
      return { kind: "field_ref", name };
    }

    if (this.match("at")) {
      const name = this.expectIdentifier("Expected link property name after '@' in computed link property expression");
      return { kind: "link_property_ref", name };
    }

    if (this.match("lparen")) {
      const expr = this.parseCoalesce();
      if (!this.match("rparen")) {
        unsupported("Expected ')' in computed link property expression");
      }
      return expr;
    }

    return unsupported("Expected literal, field reference, link property reference, or parenthesized expression");
  }

  private current(): ComputedLinkPropertyToken | undefined {
    return this.tokens[this.pos];
  }

  private previous(): Extract<ComputedLinkPropertyToken, { kind: "op" }> {
    return this.tokens[this.pos - 1] as Extract<ComputedLinkPropertyToken, { kind: "op" }>;
  }

  private match(kind: ComputedLinkPropertyToken["kind"]): boolean {
    if (this.current()?.kind !== kind) {
      return false;
    }
    this.pos += 1;
    return true;
  }

  private matchOp(op: "*" | "+" | "-" | "/" | "++" | "??"): boolean {
    const token = this.current();
    if (!token || token.kind !== "op" || token.value !== op) {
      return false;
    }
    this.pos += 1;
    return true;
  }

  private expectIdentifier(message: string): string {
    const token = this.current();
    if (token?.kind !== "identifier") {
      return unsupported(message);
    }
    this.pos += 1;
    return token.value;
  }
}

const parseComputedLinkPropertyExpr = (text: string): ComputedLinkPropertyExpr =>
  new ComputedLinkPropertyExprParser(tokenizeComputedLinkPropertyExpr(text)).parse();

const parseAliasSetLiteralValues = (exprText: string): ScalarValue[] | undefined => {
  const trimmed = exprText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }

  const parts = inner.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  const values = parts.map((part) => parseScalarLiteral(part));
  if (values.some((value) => value === undefined)) {
    return undefined;
  }
  return values as ScalarValue[];
};

const stripAliasOuterParens = (exprText: string): string => {
  let trimmed = exprText.trim();
  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const parseAliasSourceTypeCandidate = (exprText: string): string | undefined => {
  const stripped = stripAliasOuterParens(exprText).replace(/^select\s+/i, "").trim();
  const match = /^([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)(?:\s*\{|\s+filter\b|\s+order\b|\s+limit\b|\s*$)/i.exec(stripped);
  return match?.[1];
};

const parseAliasProjections = (exprText: string): AliasDeclaration["projections"] => {
  const bodyMatch = /\{([\s\S]*)\}/.exec(stripAliasOuterParens(exprText));
  if (!bodyMatch) {
    return undefined;
  }

  const projections: AliasDeclaration["projections"] = [];
  const directProjectionPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const match of bodyMatch[1].matchAll(directProjectionPattern)) {
    projections.push({ name: match[1], sourceField: match[2] });
  }

  return projections.length > 0 ? projections : undefined;
};

// Strip an optional balanced pair of outer parens from a tokenized alias body.
// Returns the (possibly-trimmed) token slice. Skips trailing semicolons / EOF.
const stripAliasOuterParenTokens = (tokens: Token[]): Token[] => {
  const trimmed = tokens.filter((token) => token.kind !== "eof");
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].kind === "semi") {
    trimmed.pop();
  }
  if (trimmed.length >= 2 && trimmed[0].kind === "lparen" && trimmed[trimmed.length - 1].kind === "rparen") {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i].kind === "lparen") depth++;
      else if (trimmed[i].kind === "rparen") {
        depth--;
        if (depth === 0 && i !== trimmed.length - 1) {
          balanced = false;
          break;
        }
      }
    }
    if (balanced) {
      return stripAliasOuterParenTokens(trimmed.slice(1, -1));
    }
  }
  return trimmed;
};

// Walk tokens from `start`, skipping a balanced `{ ... }` block when present.
// Returns the index immediately after the closing brace, or `start` if there is no block.
const skipBalancedBraceBlock = (tokens: Token[], start: number): number => {
  if (tokens[start]?.kind !== "lbrace") {
    return start;
  }
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].kind === "lbrace") depth++;
    else if (tokens[i].kind === "rbrace") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
};

// Locate the top-level `FILTER` keyword's token index inside an alias body
// (post-paren-strip). Returns -1 if not found at the top level.
const findTopLevelFilterTokenIndex = (tokens: Token[]): number => {
  let cursor = 0;
  if (tokens[cursor]?.kind === "kw_select") cursor++;
  // Skip an identifier (the source type / scalar expression)
  if (tokens[cursor] && (tokens[cursor].kind === "identifier" || tokens[cursor].kind.startsWith("kw_"))) {
    cursor++;
    while (tokens[cursor]?.kind === "coloncolon") {
      cursor += 2; // :: <ident>
    }
  }
  cursor = skipBalancedBraceBlock(tokens, cursor);
  let depth = 0;
  for (let i = cursor; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "lparen" || token.kind === "lbrace" || token.kind === "lbracket") depth++;
    else if (token.kind === "rparen" || token.kind === "rbrace" || token.kind === "rbracket") depth--;
    else if (depth === 0 && token.kind === "kw_filter") return i;
  }
  return -1;
};

// Collect tokens that belong to the FILTER clause body — i.e. everything between
// `FILTER` and the next top-level `ORDER BY`, `LIMIT`, or `OFFSET`.
const collectFilterClauseTokens = (tokens: Token[], filterIndex: number): Token[] => {
  const out: Token[] = [];
  let depth = 0;
  for (let i = filterIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "lparen" || token.kind === "lbrace" || token.kind === "lbracket") {
      depth++;
    } else if (token.kind === "rparen" || token.kind === "rbrace" || token.kind === "rbracket") {
      depth--;
      if (depth < 0) break;
    } else if (depth === 0 && (token.kind === "kw_order" || token.kind === "kw_limit" || token.kind === "kw_offset")) {
      break;
    }
    out.push(token);
  }
  return out;
};

// Match a backlink-membership filter of the shape
//   <literal> IN [TypeName].<link [IS SourceType].field
// purely from a token stream (no regex). Returns undefined when the tokens
// don't match the pattern exactly.
const matchBacklinkMembershipFilter = (filterTokens: Token[]): AliasDeclaration["filter"] => {
  let i = 0;
  if (filterTokens[i]?.kind !== "string") return undefined;
  const value = filterTokens[i].lexeme;
  i++;

  let op: "in" | "not_in";
  if (filterTokens[i]?.kind === "kw_in") {
    op = "in";
    i++;
  } else if (filterTokens[i]?.kind === "kw_not" && filterTokens[i + 1]?.kind === "kw_in") {
    op = "not_in";
    i += 2;
  } else {
    return undefined;
  }

  // Optional leading type name preceding the backlink (e.g. `Card`)
  if (filterTokens[i]?.kind === "identifier") {
    i++;
  }

  // The backlink: either the combined `.<` token or `.` followed by `<`.
  if (filterTokens[i]?.kind === "backward_link") {
    i++;
  } else if (filterTokens[i]?.kind === "dot" && filterTokens[i + 1]?.kind === "lt") {
    i += 2;
  } else {
    return undefined;
  }

  const linkToken = filterTokens[i];
  if (linkToken?.kind !== "identifier") return undefined;
  const link = linkToken.lexeme;
  i++;

  // Optional type intersection: [ IS SourceType ]
  let sourceType: string | undefined;
  if (filterTokens[i]?.kind === "lbracket") {
    i++;
    if (filterTokens[i]?.kind !== "kw_is") return undefined;
    i++;
    const sourceTypeToken = filterTokens[i];
    if (sourceTypeToken?.kind !== "identifier") return undefined;
    sourceType = sourceTypeToken.lexeme;
    i++;
    while (filterTokens[i]?.kind === "coloncolon") {
      i++;
      if (filterTokens[i]?.kind !== "identifier") return undefined;
      sourceType += `::${filterTokens[i].lexeme}`;
      i++;
    }
    if (filterTokens[i]?.kind !== "rbracket") return undefined;
    i++;
  }

  // .field
  if (filterTokens[i]?.kind !== "dot") return undefined;
  i++;
  const fieldToken = filterTokens[i];
  if (fieldToken?.kind !== "identifier") return undefined;
  const field = fieldToken.lexeme;
  i++;

  if (i !== filterTokens.length) return undefined;

  return {
    kind: "backlink_membership",
    op,
    value,
    link,
    sourceType,
    field,
  };
};

// Map a parser-level FilterExpr (predicate against a plain field with a scalar
// value) into the AliasDeclaration field_predicate shape. Returns undefined if
// the filter is not in that simple form.
const aliasFilterFromParserFilter = (filter: unknown): AliasDeclaration["filter"] => {
  if (!filter || typeof filter !== "object") return undefined;
  const f = filter as { kind: string };
  if (f.kind !== "predicate") return undefined;
  const predicate = filter as {
    kind: "predicate";
    target: { kind: string; field?: string };
    op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
    value: unknown;
  };
  if (predicate.target.kind !== "field" || !predicate.target.field) return undefined;
  if (
    predicate.op !== "=" &&
    predicate.op !== "!=" &&
    predicate.op !== "like" &&
    predicate.op !== "ilike"
  ) {
    return undefined;
  }
  if (typeof predicate.value === "object" && predicate.value !== null) return undefined;
  return {
    kind: "field_predicate",
    field: predicate.target.field,
    op: predicate.op,
    value: predicate.value as ScalarValue,
  };
};

// Use the tokenizer to determine whether `source` has balanced outer parens
// and, if so, return the inner substring with those parens removed.
const stripBalancedOuterParens = (source: string): string => {
  const trimmed = source.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return trimmed;
  let tokens: Token[];
  try {
    tokens = tokenize(trimmed);
  } catch {
    return trimmed;
  }
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === "lparen") {
      depth++;
    } else if (tokens[i].kind === "rparen") {
      depth--;
      if (depth === 0) {
        // If the matching `)` for the leading `(` is also the very last paren
        // (the `eof`/`semi` may follow), the outer parens are balanced.
        const rest = tokens.slice(i + 1).filter((token) => token.kind !== "eof" && token.kind !== "semi");
        if (rest.length === 0) {
          const openIndex = trimmed.indexOf("(");
          const closeIndex = trimmed.lastIndexOf(")");
          return stripBalancedOuterParens(trimmed.slice(openIndex + 1, closeIndex));
        }
        return trimmed;
      }
    }
  }
  return trimmed;
};

const parseAliasFilter = (exprText: string): AliasDeclaration["filter"] => {
  let tokens: Token[];
  try {
    tokens = tokenize(exprText);
  } catch {
    return undefined;
  }
  const stripped = stripAliasOuterParenTokens(tokens);
  const filterIndex = findTopLevelFilterTokenIndex(stripped);
  if (filterIndex < 0) return undefined;
  const filterTokens = collectFilterClauseTokens(stripped, filterIndex);
  if (filterTokens.length === 0) return undefined;

  // Reject compound filters (AND/OR/NOT) at the top level — those will be
  // handled by other runtime/compiler paths, not by simple alias filter lowering.
  let depth = 0;
  for (let i = 0; i < filterTokens.length; i++) {
    const token = filterTokens[i];
    if (token.kind === "lparen" || token.kind === "lbrace" || token.kind === "lbracket") depth++;
    else if (token.kind === "rparen" || token.kind === "rbrace" || token.kind === "rbracket") depth--;
    else if (depth === 0 && (token.kind === "kw_and" || token.kind === "kw_or" || token.kind === "kw_not")) {
      // `NOT IN` is a single operator we do want to recognize.
      if (token.kind === "kw_not" && filterTokens[i + 1]?.kind === "kw_in") continue;
      return undefined;
    }
  }

  // Backlink membership: matched directly off the tokens, since EdgeQL's
  // parser doesn't currently accept `<literal> IN <backlink-path>` in the
  // FILTER position.
  const backlinkFilter = matchBacklinkMembershipFilter(filterTokens);
  if (backlinkFilter) return backlinkFilter;

  // Otherwise, run the alias body through the full EdgeQL parser to obtain
  // a FilterExpr AST and translate it into the AliasDeclaration filter shape.
  const strippedSource = stripBalancedOuterParens(exprText);
  let parsed;
  try {
    parsed = parseEdgeQL(strippedSource);
  } catch {
    return undefined;
  }
  if (parsed.kind !== "select") return undefined;
  return aliasFilterFromParserFilter(parsed.filter);
};

const parseAliasDeclaration = (
  moduleName: string,
  node: AliasDeclarationNode,
): AliasDeclaration => {
  const resolvedName = resolveDeclarationName(moduleName, node.name);
  const exprText = node.expr.text.trim();
  const values = parseAliasSetLiteralValues(exprText);
  const sourceTypeCandidate = parseAliasSourceTypeCandidate(exprText);
  const sourceType =
    values
    || !sourceTypeCandidate
      ? undefined
      : normalizeTypeName(resolvedName.moduleName, sourceTypeCandidate);

  return {
    module: resolvedName.moduleName,
    name: resolvedName.localName,
    exprText,
    values,
    sourceType,
    projections: parseAliasProjections(exprText),
    filter: sourceType ? parseAliasFilter(exprText) : undefined,
  };
};

const parseFieldDefaultExpr = (text: string): FieldDefaultExpr | undefined => {
  const scalar = parseScalarLiteral(text) ?? parseCastScalarLiteral(text);
  if (scalar !== undefined) {
    return {
      kind: "literal",
      value: scalar,
    };
  }

  const trimmed = text.trim();
  const callMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_:]*)\s*\((.*)\)$/s);
  if (!callMatch) {
    return undefined;
  }

  const argsRaw = callMatch[2].trim();
  if (argsRaw.length === 0) {
    return {
      kind: "function_call",
      name: callMatch[1],
      args: [],
    };
  }

  const args = argsRaw.split(",").map((part) => parseScalarLiteral(part));
  if (args.some((arg) => arg === undefined)) {
    return undefined;
  }

  return {
    kind: "function_call",
    name: callMatch[1],
    args: args as ScalarValue[],
  };
};

const parseCastScalarLiteral = (text: string): ScalarValue | undefined => {
  const tokens = tokenize(text.trim());
  let index = 0;
  const consume = (): Token => tokens[index++]!;
  const peek = (): Token => tokens[index]!;

  if (consume().kind !== "lt") {
    return undefined;
  }

  if (!isComputedLinkNameToken(peek())) {
    return undefined;
  }
  consume();
  while (peek().kind === "coloncolon") {
    consume();
    if (!isComputedLinkNameToken(peek())) {
      return undefined;
    }
    consume();
  }

  if (consume().kind !== "gt") {
    return undefined;
  }

  const literalToken = consume();
  if (peek().kind !== "eof") {
    return undefined;
  }

  if (literalToken.kind === "string") {
    return literalToken.lexeme;
  }

  return parseScalarLiteral(literalToken.lexeme);
};

const stripOuterParens = (text: string): string => {
  let trimmed = text.trim();
  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const splitComputedConcatParts = (text: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && ch === "+" && text[i + 1] === "+") {
      parts.push(text.slice(start, i).trim());
      i += 1;
      start = i + 1;
    }
  }

  parts.push(text.slice(start).trim());
  return parts;
};

const parseComputedValuePart = (text: string): ComputedValuePart => {
  const trimmed = stripOuterParens(text);
  const scalar = parseScalarLiteral(trimmed) ?? parseCastScalarLiteral(trimmed);
  if (scalar !== undefined) {
    return { kind: "literal", value: scalar };
  }
  const fieldMatch = /^\.?([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (fieldMatch && trimmed.startsWith(".")) {
    return { kind: "field_ref", field: fieldMatch[1] };
  }
  const castFieldMatch = /^<[A-Za-z_][A-Za-z0-9_:]*>\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (castFieldMatch) {
    return { kind: "field_ref", field: castFieldMatch[1] };
  }
  return unsupported(`Unsupported computed declaration expression part '${text}'`);
};

const parseComputedPropertyExpr = (text: string): Extract<ComputedDef, { kind: "property" }>["expr"] => {
  const trimmed = stripOuterParens(text);
  const aggregateMatch = /^sum\(\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\)$/i.exec(trimmed);
  if (aggregateMatch) {
    return {
      kind: "link_aggregate",
      functionName: "sum",
      link: aggregateMatch[1],
      field: aggregateMatch[2],
    };
  }

  const concatParts = splitComputedConcatParts(trimmed);
  if (concatParts.length > 1) {
    return {
      kind: "concat",
      parts: concatParts.map(parseComputedValuePart),
    };
  }

  const scalar = parseScalarLiteral(trimmed) ?? parseCastScalarLiteral(trimmed);
  if (scalar !== undefined) {
    return { kind: "literal", value: scalar };
  }

  const setLiteral = parseComputedSetLiteralExpr(trimmed);
  if (setLiteral) {
    return setLiteral;
  }

  const fieldMatch = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (fieldMatch) {
    return { kind: "field_ref", field: fieldMatch[1] };
  }

  const callMatch = /^([A-Za-z_][A-Za-z0-9_:]*)\((.*)\)$/s.exec(trimmed);
  if (callMatch) {
    const argsRaw = callMatch[2].trim();
    const args = argsRaw.length === 0 ? [] : argsRaw.split(",").map((arg) => parseScalarLiteral(arg));
    if (args.some((arg) => arg === undefined)) {
      unsupported(`Unsupported computed declaration function arguments '${argsRaw}'`);
    }
    return { kind: "function_call", name: callMatch[1], args: args as ScalarValue[] };
  }

  return unsupported(`Unsupported computed property declaration expression '${text}'`);
};

const parseComputedLinkExpr = (text: string): Extract<ComputedDef, { kind: "link" }>["expr"] => {
  const trimmed = stripOuterParens(text);
  const selectTypeExpr = parseComputedSelectTypeLinkExpr(trimmed, text);
  if (selectTypeExpr) {
    return selectTypeExpr;
  }

  const backlinkMatch = /^\.<([A-Za-z_][A-Za-z0-9_]*)(?:\[\s*is\s+([A-Za-z_][A-Za-z0-9_:]*)\s*\])?$/i.exec(trimmed);
  if (backlinkMatch) {
    return {
      kind: "backlink",
      link: backlinkMatch[1],
      sourceType: backlinkMatch[2],
    };
  }

  const selectMatch = /^select\s+\.([A-Za-z_][A-Za-z0-9_]*)(?:\s+filter\s+\.([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|like|ilike)\s*(.+))?(?:\s+order\s+by\s+\.[A-Za-z_][A-Za-z0-9_]*)?(?:\s+limit\s+\d+)?$/i.exec(trimmed);
  if (selectMatch) {
    const expr: Extract<ComputedDef, { kind: "link" }>["expr"] = { kind: "link_ref", link: selectMatch[1] };
    if (selectMatch[2] && selectMatch[3] && selectMatch[4]) {
      const value = parseScalarLiteral(selectMatch[4]);
      if (value === undefined) {
        return unsupported(`Unsupported computed link filter value '${selectMatch[4]}'`);
      }
      expr.filter = {
        field: selectMatch[2],
        op: selectMatch[3].toLowerCase() as "=" | "!=" | "like" | "ilike",
        value,
      };
    }
    return expr;
  }

  const linkMatch = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (linkMatch) {
    return { kind: "link_ref", link: linkMatch[1] };
  }

  return unsupported(`Unsupported computed link declaration expression '${text}'`);
};

const isComputedLinkNameToken = (token: Token | undefined): token is Token =>
  token !== undefined && (
    token.kind === "identifier"
    || token.kind === "backtick_name"
    || token.kind === "kw_named"
    || token.kind === "kw_unreserved"
    || token.kind === "kw_partial_reserved"
    || token.kind === "kw_future_reserved"
    || token.kind === "kw_current_reserved"
    || token.kind.startsWith("kw_current_reserved_")
  );

const parseComputedSelectTypeLinkExpr = (
  trimmed: string,
  originalText: string,
): Extract<ComputedDef, { kind: "link" }>["expr"] | undefined => {
  const tokens = tokenize(trimmed);
  let index = 0;
  const peek = (): Token => tokens[index]!;
  const consume = (): Token => tokens[index++]!;

  if (peek().kind !== "kw_select") {
    return undefined;
  }
  consume();

  if (peek().kind === "kw_detached") {
    consume();
  }

  if (!isComputedLinkNameToken(peek())) {
    return undefined;
  }

  const typeParts = [consume().lexeme];
  while (peek().kind === "coloncolon") {
    consume();
    if (!isComputedLinkNameToken(peek())) {
      return undefined;
    }
    typeParts.push(consume().lexeme);
  }

  const nextKind = peek().kind;
  if (
    nextKind !== "eof"
    && nextKind !== "kw_filter"
    && nextKind !== "kw_order"
    && nextKind !== "kw_limit"
    && nextKind !== "kw_offset"
  ) {
    return undefined;
  }

  return {
    kind: "select_type",
    typeName: typeParts.join("::"),
    exprText: originalText.trim(),
  };
};

const parseLinkDefaultTargetValues = (text: string): string[] | undefined => {
  let statement;
  try {
    statement = parseEdgeQL(stripOuterParens(text));
  } catch {
    return undefined;
  }
  if (statement.kind !== "select" || !statement.filter) {
    return undefined;
  }

  if (statement.filter.kind === "predicate" && statement.filter.op === "=" && typeof statement.filter.value === "string") {
    return [statement.filter.value];
  }

  if (statement.filter.kind === "in_predicate" && statement.filter.op === "in" && statement.filter.values.kind === "set_literal") {
    return statement.filter.values.values.filter((value): value is string => typeof value === "string");
  }

  return undefined;
};

const convertComputedDeclarationToMember = (
  node: PropertyDeclarationNode | LinkDeclarationNode,
): TypeMember => {
  const exprText = node.expr?.text.trim();
  if (!exprText) {
    return unsupported("Computed declaration requires an expression");
  }

  const parsedExpr = node.kind === "LinkDeclaration" || exprText.startsWith(".<") || /^\(?\s*select\s+\./i.test(exprText)
    ? { computedKind: "link" as const, expr: parseComputedLinkExpr(exprText) }
    : { computedKind: "property" as const, expr: parseComputedPropertyExpr(exprText) };

  return {
    kind: "computed",
    name: qualifiedNameToString(node.name),
    required: node.required === true,
    multi: node.cardinality === "multi",
    overloaded: node.overloaded,
    annotations: [],
    computedKind: parsedExpr.computedKind,
    expr: parsedExpr.expr,
  };
};

const parseOnTargetDeleteAction = (text: string): OnTargetDeleteAction => {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, "_");
  if (
    normalized === "restrict"
    || normalized === "delete_source"
    || normalized === "allow"
    || normalized === "deferred_restrict"
  ) {
    return normalized;
  }

  throw new AppError("E_SYNTAX", `Unsupported on target delete action '${text.trim()}'`, 1, 1);
};

const normalizeLinkTargetType = (moduleName: string, targetType: string): string =>
  targetType
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeTypeName(moduleName, entry))
    .join(" | ");

const parseIndexExpression = (node: IndexDeclarationNode): string => {
  const content = node.content.text.trim();
  const onIndex = (() => {
    let depth = 0;
    let i = 0;
    while (i < content.length) {
      const ch = content[i];
      if (ch === "'" || ch === '"') {
        i = skipQuotedString(content, i);
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "<") {
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === ">") {
        depth -= 1;
      } else if (
        depth === 0
        && ch === "o"
        && content[i + 1] === "n"
        && (i === 0 || !isIdentifierPart(content[i - 1] ?? ""))
        && !isIdentifierPart(content[i + 2] ?? "")
      ) {
        return i;
      }
      i += 1;
    }
    return -1;
  })();

  if (onIndex < 0) {
    unsupported(`Unsupported index declaration form '${content}'`);
  }
  const afterOn = content.slice(onIndex + 2).trimStart();
  if (afterOn.length === 0) {
    unsupported(`Unsupported index declaration form '${content}'`);
  }

  const openParen = afterOn.indexOf("(");
  if (openParen < 0) {
    unsupported(`Unsupported index declaration form '${content}'`);
  }

  let depth = 1;
  let i = openParen + 1;
  while (i < afterOn.length && depth > 0) {
    const ch = afterOn[i];
    if (ch === "'" || ch === '"') {
      i = skipQuotedString(afterOn, i);
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    i += 1;
  }

  if (depth !== 0) {
    unsupported(`Unterminated index expression '${content}'`);
  }

  const expr = afterOn.slice(openParen + 1, i - 1).trim();
  const suffix = afterOn.slice(i).trim();
  if (suffix.length > 0) {
    unsupported(`Unsupported index suffix '${suffix}'`);
  }

  return expr.includes("++") ? `(${expr})` : expr;
};

const convertAnnotation = (moduleName: string, node: AnnotationAssignmentNode): AnnotationDef => {
  const value = parseStringLiteral(node.value.text);
  if (value === undefined) {
    throw new AppError("E_SYNTAX", "Expected annotation string value", 1, 1);
  }

  return {
    name: normalizeAnnotationName(moduleName, qualifiedNameToString(node.name)),
    value,
  };
};

const resolveFieldTargetTypeName = (moduleName: string, declaredType: string, enumTypeName?: string): string | undefined => {
  if (enumTypeName) {
    return normalizeTypeName(moduleName, enumTypeName);
  }

  const lowered = declaredType.toLowerCase();
  if (
    [
      "str",
      "bytes",
      "bool",
      "int16",
      "int32",
      "int64",
      "bigint",
      "float32",
      "float64",
      "decimal",
      "json",
      "datetime",
      "duration",
      "uuid",
      "cal::local_datetime",
      "cal::local_date",
      "cal::local_time",
      "array",
      "tuple",
    ].includes(lowered)
  ) {
    return undefined;
  }

  return normalizeTypeName(moduleName, declaredType);
};

const splitTopLevelComma = (text: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[") {
      depth += 1;
    } else if (ch === ">" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
};

const extractCollectionType = (declaredType: string): CollectionTypeDef | undefined => {
  const trimmed = declaredType.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("array<") && trimmed.endsWith(">")) {
    return { kind: "array" };
  }
  if (!lower.startsWith("tuple<") || !trimmed.endsWith(">")) {
    return undefined;
  }

  const inner = trimmed.slice(trimmed.indexOf("<") + 1, -1);
  const names = splitTopLevelComma(inner).map((part) => {
    const colon = part.indexOf(":");
    return colon > 0 ? part.slice(0, colon).trim() : undefined;
  });
  return names.every((name) => name !== undefined && name.length > 0)
    ? { kind: "tuple", elementNames: names as string[] }
    : { kind: "tuple" };
};

const parseConstraintParams = (
  moduleName: string,
  node: ConstraintDeclarationNode,
  constraintParamNames: Map<string, string[]>,
): ConstraintDef["params"] => {
  if (node.args.length === 0) {
    return undefined;
  }

  const qualifiedConstraintName = normalizeConstraintName(moduleName, qualifiedNameToString(node.name));
  const fallbackNames =
    constraintParamNames.get(qualifiedConstraintName)
    ?? defaultConstraintParamNames(qualifiedConstraintName, node.args.length)
    ?? node.args.map((_, index) => `arg${index + 1}`);

  return node.args.map((arg, index) => ({
    name: arg.name ?? fallbackNames[index] ?? `arg${index + 1}`,
    value: parseScalarLiteral(arg.value.text) ?? null,
  }));
};

const convertConstraint = (
  moduleName: string,
  node: ConstraintDeclarationNode,
  constraintParamNames: Map<string, string[]>,
): ConstraintDef => ({
  name: normalizeConstraintName(moduleName, qualifiedNameToString(node.name)),
  annotations: node.annotations.map((annotation) => convertAnnotation(moduleName, annotation)),
  delegated: node.delegated,
  params: parseConstraintParams(moduleName, node, constraintParamNames),
});

const convertLinkProperty = (
  moduleName: string,
  node: PropertyDeclarationNode,
  scalarRegistry: ScalarRegistry,
): LinkMemberProperty => {
  if (node.computed) {
    const exprText = node.expr?.text.trim();
    if (!exprText) {
      return unsupported("Computed link property declaration requires an expression");
    }

    return {
      name: qualifiedNameToString(node.name),
      computed: true,
      exprText,
      computedExpr: parseComputedLinkPropertyExpr(exprText),
      annotations: (node.body?.annotations ?? []).map((annotation) => convertAnnotation(moduleName, annotation)),
    };
  }

  const declaredType = node.typeExpr?.text
    ?? (node.declaredType ? qualifiedNameToString(node.declaredType) : undefined)
    ?? unsupported("Link property declaration requires a scalar type");
  const collection = extractCollectionType(declaredType);
  const scalarResolution = collection ? { scalar: "json" as const } : scalarRegistry.resolve(declaredType, moduleName);
  if (!scalarResolution) {
    throw new AppError("E_SYNTAX", `Unknown scalar type '${declaredType}'`, 1, 1);
  }

  const body: PropertyBodyNode | null = node.body;
  if (body?.using || (body?.extending.length ?? 0) > 0) {
    unsupported("Link property using/extending clauses are not supported by the new SDL adapter yet");
  }

  const constraints = body?.constraints ?? [];
  if (constraints.length > 0) {
    unsupported("Link property constraints are not supported by the new SDL adapter yet");
  }

  return {
    name: qualifiedNameToString(node.name),
    scalar: scalarResolution.scalar,
    required: node.required === true,
    computed: false,
    hasDefault: body?.default !== null && body?.default !== undefined,
    readonly: body?.readonly ?? false,
    collection,
    annotations: (body?.annotations ?? []).map((annotation) => convertAnnotation(moduleName, annotation)),
  };
};

const convertPropertyMember = (
  moduleName: string,
  node: PropertyDeclarationNode,
  scalarRegistry: ScalarRegistry,
  constraintParamNames: Map<string, string[]>,
  overrideDeclaredType?: string,
): PropertyMember => {
  if (node.computed) {
    //unsupported("Computed properties are not supported by the new SDL adapter yet");

  }

  const declaredType = overrideDeclaredType
    ?? node.typeExpr?.text
    ?? (node.declaredType ? qualifiedNameToString(node.declaredType) : undefined)
    ?? unsupported("Property declaration requires a scalar type");
  const collection = extractCollectionType(declaredType);
  const scalarResolution = collection ? { scalar: "json" as const } : scalarRegistry.resolve(declaredType, moduleName);
  if (!scalarResolution) {
    throw new AppError("E_SYNTAX", `Unknown scalar type '${declaredType}'`, 1, 1);
  }

  const body: PropertyBodyNode | null = node.body;
  if (body?.using || (body?.extending.length ?? 0) > 0) {
    //unsupported("Property using/extending clauses are not supported by the new SDL adapter yet");
  }

  const multi = node.cardinality === "multi";
  const required = multi ? false : node.required === true;
  const hasDefault = body?.default !== null && body?.default !== undefined;

  return {
    kind: "property",
    name: qualifiedNameToString(node.name),
    scalar: scalarResolution.scalar,
    required,
    multi,
    computed: node.computed,
    expr: node.body?.using?.text,
    overloaded: node.overloaded,
    hasDefault,
    defaultExpr: body?.default ? parseFieldDefaultExpr(body.default.text) : undefined,
    readonly: body?.readonly ?? false,
    collection,
    annotations: (body?.annotations ?? []).map((annotation) => convertAnnotation(moduleName, annotation)),
    targetTypeName: collection ? undefined : resolveFieldTargetTypeName(moduleName, declaredType, scalarResolution.enumTypeName),
    enumValues: scalarResolution.enumValues,
    enumTypeName: scalarResolution.enumTypeName,
    constraints: (body?.constraints ?? []).map((constraint) =>
      convertConstraint(moduleName, constraint, constraintParamNames),
    ),
  };
};

const convertLinkMember = (
  moduleName: string,
  node: LinkDeclarationNode,
  scalarRegistry: ScalarRegistry,
  inheritedTarget: string | undefined,
): LinkMember => {
  if (node.computed) {
    unsupported("Computed links are not supported by the new SDL adapter yet");
  }

  const declaredType = node.targetType?.text
    ?? (node.declaredType ? qualifiedNameToString(node.declaredType) : undefined)
    ?? inheritedTarget
    ?? unsupported("Link declaration requires a target type");
  const body: LinkBodyNode | null = node.body;
  if (body?.using || (body?.extending.length ?? 0) > 0) {
    unsupported("Link using/extending clauses are not supported by the new SDL adapter yet");
  }

  if (body?.onSourceDelete) {
    unsupported("on source delete is not supported by the new SDL adapter yet");
  }

  if ((body?.indexes.length ?? 0) > 0) {
    unsupported("Link-level indexes are not supported by the new SDL adapter yet");
  }

  const linkProperties = (body?.properties ?? [])
    .map((property) => convertLinkProperty(moduleName, property, scalarRegistry));
  const multi = node.cardinality === "multi";

  return {
    kind: "link",
    name: qualifiedNameToString(node.name),
    target: normalizeLinkTargetType(moduleName, declaredType),
    required: multi ? false : node.required === true,
    multi,
    overloaded: node.overloaded,
    hasDefault: body?.default !== null && body?.default !== undefined,
    defaultTargetValues: body?.default ? parseLinkDefaultTargetValues(body.default.text) : undefined,
    readonly: body?.readonly ?? false,
    onTargetDelete: body?.onTargetDelete ? parseOnTargetDeleteAction(body.onTargetDelete) : undefined,
    annotations: (body?.annotations ?? []).map((annotation) => convertAnnotation(moduleName, annotation)),
    properties: linkProperties,
  };
};

const convertInferredLinkMember = (
  moduleName: string,
  node: PropertyDeclarationNode,
  overrideDeclaredType?: string,
): LinkMember => {
  const declaredType = overrideDeclaredType
    ?? node.typeExpr?.text
    ?? (node.declaredType ? qualifiedNameToString(node.declaredType) : undefined)
    ?? unsupported("Link declaration requires a target type");

  const body = node.body;
  if (body?.using) {
    unsupported("Link using clauses are not supported by the new SDL adapter yet");
  }
  if ((body?.extending.length ?? 0) > 0) {
    unsupported("Link extending clauses are not supported by the new SDL adapter yet");
  }

  const multi = node.cardinality === "multi";
  return {
    kind: "link",
    name: qualifiedNameToString(node.name),
    target: normalizeLinkTargetType(moduleName, declaredType),
    required: multi ? false : node.required === true,
    multi,
    overloaded: node.overloaded,
    hasDefault: body?.default !== null && body?.default !== undefined,
    defaultTargetValues: body?.default ? parseLinkDefaultTargetValues(body.default.text) : undefined,
    readonly: body?.readonly ?? false,
    annotations: (body?.annotations ?? []).map((annotation) => convertAnnotation(moduleName, annotation)),
    properties: [],
  };
};

const convertDeclarationToMember = (
  moduleName: string,
  declaration: DeclarationNode,
  scalarRegistry: ScalarRegistry,
  objectTypeNames: Set<string>,
  constraintParamNames: Map<string, string[]>,
  ownerTypeFullName: string,
  inheritanceResolver: PointerInheritanceResolver,
): TypeMember | null => {
  if (declaration.kind === "LinkDeclaration") {
    if (declaration.computed) {
      try {
        return convertComputedDeclarationToMember(declaration);
      } catch (err) {
        if (err instanceof UnsupportedSDLFeatureError) {
          return null;
        }
        throw err;
      }
    }
    const inheritedTarget = (declaration.targetType?.text || declaration.declaredType)
      ? undefined
      : inheritanceResolver.resolve(ownerTypeFullName, qualifiedNameToString(declaration.name))?.target;
    return convertLinkMember(moduleName, declaration, scalarRegistry, inheritedTarget);
  }

  if (declaration.kind === "PropertyDeclaration") {
    if (declaration.computed) {
      try {
        return convertComputedDeclarationToMember(declaration);
      } catch (err) {
        if (err instanceof UnsupportedSDLFeatureError) {
          return null;
        }
        throw err;
      }
    }

    let declaredType = declaration.typeExpr?.text
      ?? (declaration.declaredType ? qualifiedNameToString(declaration.declaredType) : undefined);
    if (declaredType === undefined) {
      const inherited = inheritanceResolver.resolve(ownerTypeFullName, qualifiedNameToString(declaration.name));
      declaredType = inherited?.target;
    }
    if (declaredType === undefined) {
      const usingExpr = declaration.body?.using?.text;
      if (usingExpr) {
        try {
          return convertComputedDeclarationToMember({
            ...declaration,
            computed: true,
            expr: declaration.body!.using!,
          });
        } catch (err) {
          if (err instanceof UnsupportedSDLFeatureError) {
            return null;
          }
          throw err;
        }
      }
      unsupported("Property or link declaration requires a declared type");
    }
    const scalarResolution = extractCollectionType(declaredType) ? { scalar: "json" as const } : scalarRegistry.resolve(declaredType, moduleName);
    const inferredLink =
      !declaration.explicitKeyword
      && !scalarResolution
      && (
        objectTypeNames.has(normalizeTypeName(moduleName, declaredType))
        || declaredType.includes("::")
        || declaredType.length > 0
      );

    if (inferredLink) {
      return convertInferredLinkMember(moduleName, declaration, declaredType);
    }

    return convertPropertyMember(moduleName, declaration, scalarRegistry, constraintParamNames, declaredType);
  }

  if (declaration.kind === "ConstraintDeclaration") {
    return null;
  }

  if (declaration.kind === "AnnotationAssignment") {
    return null;
  }

  if (declaration.kind === "IndexDeclaration") {
    return null;
  }

  return null;
};

const convertTypeDeclaration = (
  moduleName: string,
  node: TypeDeclarationNode,
  scalarRegistry: ScalarRegistry,
  objectTypeNames: Set<string>,
  constraintParamNames: Map<string, string[]>,
  inheritanceResolver: PointerInheritanceResolver,
): ObjectTypeDeclaration => {
  const resolvedName = resolveDeclarationName(moduleName, node.name);
  const typeModuleName = resolvedName.moduleName;
  const typeName = resolvedName.localName;
  const typeFullName = `${typeModuleName}::${typeName}`;
  const annotations: AnnotationDef[] = [];
  const indexes: Array<{ expr: string }> = [];
  const members: TypeMember[] = [];

  for (const declaration of node.body?.declarations ?? []) {
    if (declaration.kind === "AnnotationAssignment") {
      annotations.push(convertAnnotation(typeModuleName, declaration));
      continue;
    }

    if (declaration.kind === "IndexDeclaration") {
      try {
        indexes.push({ expr: parseIndexExpression(declaration) });
      } catch (err) {
        if (!(err instanceof UnsupportedSDLFeatureError)) {
          throw err;
        }
      }
      continue;
    }

    const member = convertDeclarationToMember(
      typeModuleName,
      declaration,
      scalarRegistry,
      objectTypeNames,
      constraintParamNames,
      typeFullName,
      inheritanceResolver,
    );
    if (member) {
      members.push(member);
    }
  }

  return {
    kind: "object",
    module: typeModuleName,
    name: typeName,
    abstract: node.abstract,
    extends: node.extends.map((base) => normalizeTypeName(typeModuleName, qualifiedNameToString(base))),
    annotations,
    indexes,
    members,
    triggers: [],
    accessPolicies: [],
  };
};

const convertAbstractAnnotation = (
  moduleName: string,
  node: AbstractAnnotationNode,
): AbstractAnnotationDeclaration => {
  const resolvedName = resolveDeclarationName(moduleName, node.name);
  return {
    module: resolvedName.moduleName,
    name: normalizeAnnotationName(resolvedName.moduleName, resolvedName.localName),
    inheritable: node.inheritable,
    annotations: (node.body?.declarations ?? []).map((declaration) =>
      convertAnnotation(resolvedName.moduleName, declaration),
    ),
  };
};

const convertAbstractConstraint = (
  moduleName: string,
  node: ConstraintDeclarationNode,
  constraintParamNames: Map<string, string[]>,
): ConstraintDeclaration => {
  if (!node.abstract) {
    unsupported("Concrete top-level constraints are not supported by the new SDL adapter yet");
  }

  const resolvedName = resolveDeclarationName(moduleName, node.name);
  const name = normalizeConstraintName(resolvedName.moduleName, resolvedName.localName);
  const params = node.args.map((arg, index) => arg.name ?? `arg${index + 1}`);
  constraintParamNames.set(name, params);

  return {
    module: resolvedName.moduleName,
    name,
    params,
    annotations: node.annotations.map((annotation) => convertAnnotation(resolvedName.moduleName, annotation)),
  };
};

const convertFunctionDeclaration = (
  moduleName: string,
  node: FunctionDeclarationNode,
): FunctionDeclaration => {
  const resolvedName = resolveDeclarationName(moduleName, node.name);

  const params = node.params.map((param) => {
    let defaultValue: ScalarValue | undefined;
    if (param.defaultExpr) {
      const parsedDefault = parseScalarLiteral(param.defaultExpr.text);
      if (parsedDefault === undefined) {
        unsupported(`Unsupported function parameter default value '${param.defaultExpr.text}'`);
      }
      defaultValue = parsedDefault;
    }

    if (param.setOf) {
      unsupported("User defined functions cannot declare set of parameters");
    }

    return {
      name: param.name,
      type: param.type,
      optional: param.optional,
      setOf: param.setOf,
      variadic: param.variadic,
      namedOnly: param.namedOnly,
      default: defaultValue,
    };
  });

  return {
    module: resolvedName.moduleName,
    name: resolvedName.localName,
    params,
    returnType: node.returnType,
    returnOptional: node.returnOptional,
    returnSetOf: node.returnSetOf,
    volatility: node.volatility ?? undefined,
    annotations: node.annotations.map((annotation) => convertAnnotation(resolvedName.moduleName, annotation)),
    body: {
      language: "edgeql",
      text: node.body.text,
    },
  };
};

const resolveScalarBaseType = (
  moduleName: string,
  baseTypeName: string,
  scalarRegistry: ScalarRegistry,
): ScalarType => {
  const lookupName = baseTypeName.split("<", 1)[0]?.trim() ?? baseTypeName;
  const resolution = scalarRegistry.resolve(lookupName, moduleName);
  if (!resolution) {
    throw new AppError("E_SYNTAX", `Unknown scalar type '${lookupName}'`, 1, 1);
  }
  return resolution.scalar;
};

const convertScalarTypeDeclaration = (
  moduleName: string,
  node: ScalarTypeDeclarationNode,
  scalarRegistry: ScalarRegistry,
  constraintParamNames: Map<string, string[]>,
): ScalarTypeDeclaration => {
  const resolvedName = resolveDeclarationName(moduleName, node.name);
  const scalarModule = resolvedName.moduleName;
  const scalarName = resolvedName.localName;

  let alias: ScalarType = "str";
  let enumValues: string[] | undefined;
  let baseTypeName: string | undefined;

  if (node.enumValues && node.enumValues.length > 0) {
    enumValues = [...node.enumValues];
    baseTypeName = "std::anyenum";
  } else if (node.baseType) {
    baseTypeName = node.baseType.text;
    alias = resolveScalarBaseType(scalarModule, baseTypeName, scalarRegistry);
  }

  scalarRegistry.register(scalarName, {
    scalar: alias,
    enumValues,
    bases: baseTypeName ? [baseTypeName] : undefined,
  });

  return {
    module: scalarModule,
    name: scalarName,
    enumValues,
    baseTypeName,
    annotations: (node.body?.annotations ?? []).map((annotation) =>
      convertAnnotation(scalarModule, annotation),
    ),
    constraints: (node.body?.constraints ?? []).map((constraint) =>
      convertConstraint(scalarModule, constraint, constraintParamNames),
    ),
  };
};

const collectObjectTypeNames = (documents: ParsedModuleDocument[]): Set<string> => {
  const names = new Set<string>();
  for (const parsed of documents) {
    for (const declaration of parsed.document.declarations) {
      if (declaration.kind === "TypeDeclaration") {
        const resolvedName = resolveDeclarationName(parsed.moduleName, declaration.name);
        names.add(`${resolvedName.moduleName}::${resolvedName.localName}`);
      }
    }
  }
  return names;
};

interface InheritedPointerInfo {
  target: string;
  isLink: boolean;
  required?: boolean;
  multi?: boolean;
}

interface DeclaredTypeInfo {
  extends: string[];
  pointers: Map<string, InheritedPointerInfo>;
}

class PointerInheritanceResolver {
  private readonly types = new Map<string, DeclaredTypeInfo>();

  register(fullName: string, info: DeclaredTypeInfo): void {
    this.types.set(fullName, info);
  }

  resolve(typeFullName: string, pointerName: string): InheritedPointerInfo | undefined {
    const visited = new Set<string>();
    const queue: string[] = [typeFullName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const info = this.types.get(current);
      if (!info) continue;
      const found = info.pointers.get(pointerName);
      if (found) return found;
      for (const base of info.extends) {
        queue.push(base);
      }
    }
    return undefined;
  }
}

const buildPointerInheritance = (documents: ParsedModuleDocument[]): PointerInheritanceResolver => {
  const resolver = new PointerInheritanceResolver();
  for (const parsed of documents) {
    for (const declaration of parsed.document.declarations) {
      if (declaration.kind !== "TypeDeclaration") continue;
      const resolvedName = resolveDeclarationName(parsed.moduleName, declaration.name);
      const fullName = `${resolvedName.moduleName}::${resolvedName.localName}`;
      const typeModuleName = resolvedName.moduleName;
      const pointers = new Map<string, InheritedPointerInfo>();
      for (const member of declaration.body?.declarations ?? []) {
        if (member.kind === "LinkDeclaration") {
          if (member.computed) continue;
          const declaredType = member.targetType?.text
            ?? (member.declaredType ? qualifiedNameToString(member.declaredType) : undefined);
          if (declaredType === undefined) continue;
          pointers.set(qualifiedNameToString(member.name), {
            target: declaredType,
            isLink: true,
            required: member.required === true,
            multi: member.cardinality === "multi",
          });
        } else if (member.kind === "PropertyDeclaration") {
          if (member.computed) continue;
          const declaredType = member.typeExpr?.text
            ?? (member.declaredType ? qualifiedNameToString(member.declaredType) : undefined);
          if (declaredType === undefined) continue;
          pointers.set(qualifiedNameToString(member.name), {
            target: declaredType,
            isLink: false,
            required: member.required === true,
            multi: member.cardinality === "multi",
          });
        }
      }
      const extendsList = declaration.extends.map((base) =>
        normalizeTypeName(typeModuleName, qualifiedNameToString(base)),
      );
      resolver.register(fullName, {
        extends: extendsList,
        pointers,
      });
    }
  }
  return resolver;
};

const parseDocuments = (source: string, options: NewSDLAdapterOptions): ParsedModuleDocument[] => {
  const parsedModuleBodies = parseModuleBlocks(source);
  const parsedDocuments: ParsedModuleDocument[] = [];

  for (const [moduleName, bodies] of parsedModuleBodies.moduleBodies) {
    parsedDocuments.push({
      moduleName,
      explicit: true,
      document: parseDocument(bodies.join("\n"), {
        legacySyntaxCompat: options.legacySyntaxCompat,
      }),
    });
  }

  const topLevelBody = parsedModuleBodies.topLevelBody.trim();
  if (topLevelBody.length > 0) {
    parsedDocuments.push({
      moduleName: "default",
      explicit: false,
      document: parseDocument(topLevelBody, {
        legacySyntaxCompat: options.legacySyntaxCompat,
      }),
    });
  }

  if (parsedDocuments.length === 0) {
    throw new AppError("E_SYNTAX", "Expected module declaration or top-level schema declaration", 1, 1);
  }

  return parsedDocuments;
};

export const parseDeclarativeSchema = (
  source: string,
  options: NewSDLAdapterOptions,
): DeclarativeSchema => {
  const parsedModules = parseDocuments(source, options);
  const modules: SchemaModule[] = [];
  const seenModules = new Set<string>();
  const registerModule = (moduleName: string): void => {
    if (seenModules.has(moduleName)) {
      return;
    }
    seenModules.add(moduleName);
    modules.push({ name: moduleName });
  };

  for (const parsedModule of parsedModules) {
    if (parsedModule.explicit) {
      registerModule(parsedModule.moduleName);
    }
  }

  const objectTypeNames = collectObjectTypeNames(parsedModules);
  const inheritanceResolver = buildPointerInheritance(parsedModules);
  const scalarRegistry = new ScalarRegistry();
  const constraintParamNames = new Map<string, string[]>();

  const scalarTypes: ScalarTypeDeclaration[] = [];
  const types: ObjectTypeDeclaration[] = [];
  const functions: FunctionDeclaration[] = [];
  const abstractAnnotations: AbstractAnnotationDeclaration[] = [];
  const constraints: ConstraintDeclaration[] = [];
  const aliases: AliasDeclaration[] = [];

  for (const parsedModule of parsedModules) {
    for (const declaration of parsedModule.document.declarations) {
      if (declaration.kind === "ConstraintDeclaration" && declaration.abstract) {
        const resolvedName = resolveDeclarationName(parsedModule.moduleName, declaration.name);
        const name = normalizeConstraintName(resolvedName.moduleName, resolvedName.localName);
        constraintParamNames.set(name, declaration.args.map((arg, index) => arg.name ?? `arg${index + 1}`));
      }
    }
  }

  for (const parsedModule of parsedModules) {
    for (const declaration of parsedModule.document.declarations) {
      if (declaration.kind !== "ScalarTypeDeclaration") {
        continue;
      }

      const scalarDecl = convertScalarTypeDeclaration(
        parsedModule.moduleName,
        declaration,
        scalarRegistry,
        constraintParamNames,
      );
      registerModule(scalarDecl.module);
      scalarTypes.push(scalarDecl);
    }
  }

  for (const parsedModule of parsedModules) {
    for (const declaration of parsedModule.document.declarations) {
      switch (declaration.kind) {
        case "ScalarTypeDeclaration":
          break;

        case "TypeDeclaration": {
          const typeDecl = convertTypeDeclaration(
            parsedModule.moduleName,
            declaration,
            scalarRegistry,
            objectTypeNames,
            constraintParamNames,
            inheritanceResolver,
          );
          registerModule(typeDecl.module);
          types.push(typeDecl);
          break;
        }

        case "AbstractAnnotation": {
          const abstractAnnotation = convertAbstractAnnotation(parsedModule.moduleName, declaration);
          registerModule(abstractAnnotation.module);
          abstractAnnotations.push(abstractAnnotation);
          break;
        }

        case "ConstraintDeclaration": {
          const constraint = convertAbstractConstraint(parsedModule.moduleName, declaration, constraintParamNames);
          registerModule(constraint.module);
          constraints.push(constraint);
          break;
        }

        case "FunctionDeclaration": {
          const fn = convertFunctionDeclaration(parsedModule.moduleName, declaration);
          registerModule(fn.module);
          functions.push(fn);
          break;
        }

        case "AliasDeclaration": {
          const alias = parseAliasDeclaration(parsedModule.moduleName, declaration);
          registerModule(alias.module);
          aliases.push(alias);
          break;
        }

        case "IgnoredDeclaration":
          break;

        default:
          unsupported(`Unsupported top-level declaration '${(declaration as TopLevelDeclarationNode).kind}'`);
      }
    }
  }

  return {
    modules,
    types,
    functions: functions.length ? functions : undefined,
    permissions: [],
    scalarTypes: scalarTypes.length ? scalarTypes : undefined,
    abstractAnnotations: abstractAnnotations.length ? abstractAnnotations : undefined,
    constraints: constraints.length ? constraints : undefined,
    aliases: aliases.length ? aliases : undefined,
  };
};
