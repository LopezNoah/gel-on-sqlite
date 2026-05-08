import { AppError } from "../errors.js";

export type TokenKind =
  | "kw_select"
  | "kw_insert"
  | "kw_update"
  | "kw_delete"
  | "kw_for"
  | "kw_in"
  | "kw_union"
  | "kw_filter"
  | "kw_set"
  | "kw_with"
  | "kw_order"
  | "kw_by"
  | "kw_limit"
  | "kw_offset"
  | "kw_asc"
  | "kw_desc"
  | "kw_is"
  | "kw_true"
  | "kw_false"
  | "kw_null"
  | "kw_like"
  | "kw_ilike"
  | "kw_and"
  | "kw_or"
  | "kw_not"
  | "kw_distinct"
  | "kw_as"
  | "kw_module"
  | "kw_unless"
  | "kw_conflict"
  | "kw_on"
  | "kw_else"
  | "kw_if"
  | "kw_then"
  | "kw_detached"
  | "identifier"
  | "string"
  | "bytes_string"
  | "number"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "colon"
  | "coloncolon"
  | "equals"
  | "not_equals"
  | "assign"
  | "semi"
  | "dot"
  | "star"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "minus"
  | "plus"
  | "concat"
  | "coalesce"
  | "dollar"
  | "at"
  | "eof";

export interface Token {
  kind: TokenKind;
  lexeme: string;
  line: number;
  column: number;
}

const KEYWORDS: Record<string, TokenKind> = {
  select: "kw_select",
  insert: "kw_insert",
  update: "kw_update",
  delete: "kw_delete",
  for: "kw_for",
  in: "kw_in",
  union: "kw_union",
  filter: "kw_filter",
  set: "kw_set",
  with: "kw_with",
  order: "kw_order",
  by: "kw_by",
  limit: "kw_limit",
  offset: "kw_offset",
  asc: "kw_asc",
  desc: "kw_desc",
  is: "kw_is",
  true: "kw_true",
  false: "kw_false",
  null: "kw_null",
  like: "kw_like",
  ilike: "kw_ilike",
  and: "kw_and",
  or: "kw_or",
  not: "kw_not",
  distinct: "kw_distinct",
  as: "kw_as",
  module: "kw_module",
  unless: "kw_unless",
  conflict: "kw_conflict",
  on: "kw_on",
  else: "kw_else",
  if: "kw_if",
  then: "kw_then",
  detached: "kw_detached",
};

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isAlphaNumeric = (c: string): boolean => isAlpha(c) || isDigit(c);

export const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];

  let i = 0;
  let line = 1;
  let column = 1;

  const isAtEnd = (): boolean => i >= input.length;

  const peek = (): string => (isAtEnd() ? "\0" : input[i]!);
  const peekNext = (): string => (i + 1 >= input.length ? "\0" : input[i + 1]!);

  const advance = (): string => {
    const c = input[i]!;
    i += 1;

    if (c === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }

    return c;
  };

  const match = (expected: string): boolean => {
    if (isAtEnd()) return false;
    if (input[i] !== expected) return false;
    advance();
    return true;
  };

  const push = (kind: TokenKind, lexeme: string, tokenLine: number, tokenColumn: number): void => {
    tokens.push({ kind, lexeme, line: tokenLine, column: tokenColumn });
  };

  const syntaxError = (message: string, tokenLine: number, tokenColumn: number): never => {
    throw new AppError("E_SYNTAX", message, tokenLine, tokenColumn);
  };

  const skipWhitespaceAndComments = (): void => {
    while (!isAtEnd()) {
      const c = peek();

      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        advance();
        continue;
      }

      if (c === "#") {
        while (!isAtEnd() && peek() !== "\n") {
          advance();
        }
        continue;
      }

      break;
    }
  };

  const scanString = (quote: "'" | '"', tokenLine: number, tokenColumn: number, kind: "string" | "bytes_string"): void => {
    advance(); // opening quote

    let value = "";

    while (!isAtEnd()) {
      const c = peek();

      if (c === "\n") {
        syntaxError("Unterminated string literal", tokenLine, tokenColumn);
      }

      if (c === quote) {
        advance(); // closing quote
        push(kind, value, tokenLine, tokenColumn);
        return;
      }

      if (c === "\\") {
        advance(); // backslash
        if (isAtEnd()) {
          syntaxError("Unterminated escape sequence", tokenLine, tokenColumn);
        }

        const esc = advance();
        switch (esc) {
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          case "\\":
            value += "\\";
            break;
          case "'":
            value += "'";
            break;
          case '"':
            value += '"';
            break;
          default:
            syntaxError(`Unsupported escape sequence '\\${esc}'`, tokenLine, tokenColumn);
        }
        continue;
      }

      value += advance();
    }

    syntaxError("Unterminated string literal", tokenLine, tokenColumn);
  };

  const scanNumber = (tokenLine: number, tokenColumn: number): void => {
    let value = "";

    while (isDigit(peek())) {
      value += advance();
    }

    if (peek() === "." && isDigit(peekNext())) {
      value += advance(); // '.'
      while (isDigit(peek())) {
        value += advance();
      }
    }

    if (peek() === "n") {
      value += advance();
    }

    push("number", value, tokenLine, tokenColumn);
  };

  const scanIdentifierOrKeyword = (tokenLine: number, tokenColumn: number): void => {
    let value = "";

    while (isAlphaNumeric(peek())) {
      value += advance();
    }

    const lowered = value.toLowerCase();
    const keyword = KEYWORDS[lowered];

    if (keyword) {
      push(keyword, lowered, tokenLine, tokenColumn);
    } else {
      push("identifier", value, tokenLine, tokenColumn);
    }
  };

  while (!isAtEnd()) {
    skipWhitespaceAndComments();
    if (isAtEnd()) break;

    const tokenLine = line;
    const tokenColumn = column;
    const c = peek();

    // Byte strings: b'...' or b"..."
    if ((c === "b" || c === "B") && (peekNext() === "'" || peekNext() === '"')) {
      advance(); // consume b/B
      scanString(peek() as "'" | '"', tokenLine, tokenColumn, "bytes_string");
      continue;
    }

    // Strings
    if (c === "'" || c === '"') {
      scanString(c, tokenLine, tokenColumn, "string");
      continue;
    }

    // Multi-character operators first
    if (c === ":" && peekNext() === "=") {
      advance();
      advance();
      push("assign", ":=", tokenLine, tokenColumn);
      continue;
    }

    if (c === ":" && peekNext() === ":") {
      advance();
      advance();
      push("coloncolon", "::", tokenLine, tokenColumn);
      continue;
    }

    if (c === "!" && peekNext() === "=") {
      advance();
      advance();
      push("not_equals", "!=", tokenLine, tokenColumn);
      continue;
    }

    if (c === "<" && peekNext() === "=") {
      advance();
      advance();
      push("lte", "<=", tokenLine, tokenColumn);
      continue;
    }

    if (c === ">" && peekNext() === "=") {
      advance();
      advance();
      push("gte", ">=", tokenLine, tokenColumn);
      continue;
    }

    if (c === "+" && peekNext() === "+") {
      advance();
      advance();
      push("concat", "++", tokenLine, tokenColumn);
      continue;
    }

    if (c === "?" && peekNext() === "?") {
      advance();
      advance();
      push("coalesce", "??", tokenLine, tokenColumn);
      continue;
    }

    // Single-character tokens
    switch (c) {
      case "{":
        advance();
        push("lbrace", "{", tokenLine, tokenColumn);
        continue;
      case "}":
        advance();
        push("rbrace", "}", tokenLine, tokenColumn);
        continue;
      case "(":
        advance();
        push("lparen", "(", tokenLine, tokenColumn);
        continue;
      case ")":
        advance();
        push("rparen", ")", tokenLine, tokenColumn);
        continue;
      case "[":
        advance();
        push("lbracket", "[", tokenLine, tokenColumn);
        continue;
      case "]":
        advance();
        push("rbracket", "]", tokenLine, tokenColumn);
        continue;
      case ",":
        advance();
        push("comma", ",", tokenLine, tokenColumn);
        continue;
      case ":":
        advance();
        push("colon", ":", tokenLine, tokenColumn);
        continue;
      case ";":
        advance();
        push("semi", ";", tokenLine, tokenColumn);
        continue;
      case ".":
        advance();
        push("dot", ".", tokenLine, tokenColumn);
        continue;
      case "*":
        advance();
        push("star", "*", tokenLine, tokenColumn);
        continue;
      case "=":
        advance();
        push("equals", "=", tokenLine, tokenColumn);
        continue;
      case "<":
        advance();
        push("lt", "<", tokenLine, tokenColumn);
        continue;
      case ">":
        advance();
        push("gt", ">", tokenLine, tokenColumn);
        continue;
      case "-":
        advance();
        push("minus", "-", tokenLine, tokenColumn);
        continue;
      case "+":
        advance();
        push("plus", "+", tokenLine, tokenColumn);
        continue;
      case "$":
        advance();
        push("dollar", "$", tokenLine, tokenColumn);
        continue;
      case "@":
        advance();
        push("at", "@", tokenLine, tokenColumn);
        continue;
    }

    // Numbers
    if (isDigit(c)) {
      scanNumber(tokenLine, tokenColumn);
      continue;
    }

    // Identifiers / keywords
    if (isAlpha(c)) {
      scanIdentifierOrKeyword(tokenLine, tokenColumn);
      continue;
    }

    syntaxError(`Unexpected token '${c}'`, tokenLine, tokenColumn);
  }

  tokens.push({ kind: "eof", lexeme: "", line, column });
  return tokens;
};