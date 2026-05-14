import { AppError } from "../errors.js";
import type {
  AnnotationDef,
  ComputedDef,
  ComputedValuePart,
  ConstraintDef,
  FieldDefaultExpr,
  OnTargetDeleteAction,
  ScalarType,
  ScalarValue,
} from "../types.js";
import { normalizeAnnotationName } from "./annos.js";
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
  };
};

const parseFieldDefaultExpr = (text: string): FieldDefaultExpr | undefined => {
  const scalar = parseScalarLiteral(text);
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
  const scalar = parseScalarLiteral(trimmed);
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

  const scalar = parseScalarLiteral(trimmed);
  if (scalar !== undefined) {
    return { kind: "literal", value: scalar };
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

const parseIndexExpression = (node: IndexDeclarationNode): string => {
  const content = node.content.text.trim();
  if (!content.startsWith("on")) {
    unsupported(`Unsupported index declaration form '${content}'`);
  }

  const openParen = content.indexOf("(");
  if (openParen < 0) {
    unsupported(`Unsupported index declaration form '${content}'`);
  }

  let depth = 1;
  let i = openParen + 1;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === "'" || ch === '"') {
      i = skipQuotedString(content, i);
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

  const expr = content.slice(openParen + 1, i - 1).trim();
  const suffix = content.slice(i).trim();
  if (suffix.length > 0) {
    unsupported(`Unsupported index suffix '${suffix}'`);
  }

  return expr;
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

  const declaredTypeNode = node.declaredType;
  if (!declaredTypeNode) {
    unsupported("Link property declaration requires a scalar type");
  }

  const declaredType = qualifiedNameToString(declaredTypeNode!);
  const scalarResolution = scalarRegistry.resolve(declaredType, moduleName);
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
    annotations: (body?.annotations ?? []).map((annotation) => convertAnnotation(moduleName, annotation)),
  };
};

const convertPropertyMember = (
  moduleName: string,
  node: PropertyDeclarationNode,
  scalarRegistry: ScalarRegistry,
  constraintParamNames: Map<string, string[]>,
): PropertyMember => {
  if (node.computed) {
    //unsupported("Computed properties are not supported by the new SDL adapter yet");
    
  }

  const declaredTypeNode = node.declaredType;
  if (!declaredTypeNode) {
    unsupported("Property declaration requires a scalar type");
  }

  const declaredType = qualifiedNameToString(declaredTypeNode!);
  const scalarResolution = scalarRegistry.resolve(declaredType, moduleName);
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
    annotations: (body?.annotations ?? []).map((annotation) => convertAnnotation(moduleName, annotation)),
    targetTypeName: resolveFieldTargetTypeName(moduleName, declaredType, scalarResolution.enumTypeName),
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
): LinkMember => {
  if (node.computed) {
    unsupported("Computed links are not supported by the new SDL adapter yet");
  }

  const declaredTypeNode = node.declaredType;
  if (!declaredTypeNode) {
    unsupported("Link declaration requires a target type");
  }

  const declaredType = qualifiedNameToString(declaredTypeNode!);
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
    target: normalizeTypeName(moduleName, declaredType),
    required: multi ? false : node.required === true,
    multi,
    overloaded: node.overloaded,
    hasDefault: body?.default !== null && body?.default !== undefined,
    readonly: body?.readonly ?? false,
    onTargetDelete: body?.onTargetDelete ? parseOnTargetDeleteAction(body.onTargetDelete) : undefined,
    annotations: (body?.annotations ?? []).map((annotation) => convertAnnotation(moduleName, annotation)),
    properties: linkProperties,
  };
};

const convertInferredLinkMember = (
  moduleName: string,
  node: PropertyDeclarationNode,
): LinkMember => {
  const declaredTypeNode = node.declaredType;
  if (!declaredTypeNode) {
    unsupported("Link declaration requires a target type");
  }

  const body = node.body;
  if (
    body
    && (
      body.using
      || body.default
      || body.readonly !== null
      || body.extending.length > 0
      || body.annotations.length > 0
    )
  ) {
    unsupported("Implicit links with link bodies are not supported by the new SDL adapter yet");
  }

  const declaredType = qualifiedNameToString(declaredTypeNode!);
  const multi = node.cardinality === "multi";
  return {
    kind: "link",
    name: qualifiedNameToString(node.name),
    target: normalizeTypeName(moduleName, declaredType),
    required: multi ? false : node.required === true,
    multi,
    overloaded: node.overloaded,
    hasDefault: false,
    readonly: false,
    annotations: [],
    properties: [],
  };
};

const convertDeclarationToMember = (
  moduleName: string,
  declaration: DeclarationNode,
  scalarRegistry: ScalarRegistry,
  objectTypeNames: Set<string>,
  constraintParamNames: Map<string, string[]>,
): TypeMember | null => {
  if (declaration.kind === "LinkDeclaration") {
    if (declaration.computed) {
      return convertComputedDeclarationToMember(declaration);
    }
    return convertLinkMember(moduleName, declaration, scalarRegistry, constraintParamNames);
  }

  if (declaration.kind === "PropertyDeclaration") {
    if (declaration.computed) {
      return convertComputedDeclarationToMember(declaration);
    }

    const declaredTypeNode = declaration.declaredType;
    if (!declaredTypeNode) {
      unsupported("Property or link declaration requires a declared type");
    }

    const declaredType = qualifiedNameToString(declaredTypeNode!);
    const scalarResolution = scalarRegistry.resolve(declaredType, moduleName);
    const inferredLink =
      !declaration.explicitKeyword
      && !scalarResolution
      && (
        objectTypeNames.has(normalizeTypeName(moduleName, declaredType))
        || declaredType.includes("::")
        || declaredType.length > 0
      );

    if (inferredLink) {
      return convertInferredLinkMember(moduleName, declaration);
    }

    return convertPropertyMember(moduleName, declaration, scalarRegistry, constraintParamNames);
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
): ObjectTypeDeclaration => {
  const resolvedName = resolveDeclarationName(moduleName, node.name);
  const typeModuleName = resolvedName.moduleName;
  const typeName = resolvedName.localName;
  const annotations: AnnotationDef[] = [];
  const indexes: Array<{ expr: string }> = [];
  const members: TypeMember[] = [];

  for (const declaration of node.body?.declarations ?? []) {
    if (declaration.kind === "AnnotationAssignment") {
      annotations.push(convertAnnotation(typeModuleName, declaration));
      continue;
    }

    if (declaration.kind === "IndexDeclaration") {
      indexes.push({ expr: parseIndexExpression(declaration) });
      continue;
    }

    const member = convertDeclarationToMember(
      typeModuleName,
      declaration,
      scalarRegistry,
      objectTypeNames,
      constraintParamNames,
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
