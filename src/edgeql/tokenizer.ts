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
  | "identifier"
  | "string"
  | "number"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "comma"
  | "colon"
  | "equals"
  | "not_equals"
  | "assign"
  | "semi"
  | "dot"
  | "star"
  | "lt"
  | "gt"
  | "minus"
  | "concat"
  | "dollar"
  | "at"
  | "lbracket"
  | "rbracket"
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
};

export const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];

  let i = 0;
  let line = 1;
  let column = 1;

  const push = (kind: TokenKind, lexeme: string, tokenLine: number, tokenColumn: number): void => {
    tokens.push({ kind, lexeme, line: tokenLine, column: tokenColumn });
  };

  while (i < input.length) {
    const c = input[i];

    if (c === " " || c === "\t" || c === "\r") {
      i += 1;
      column += 1;
      continue;
    }

    if (c === "\n") {
      i += 1;
      line += 1;
      column = 1;
      continue;
    }

    const tokenLine = line;
    const tokenColumn = column;

    if (c === "!" && input[i + 1] === "=") {
      push("not_equals", "!=", tokenLine, tokenColumn);
      i += 2;
      column += 2;
      continue;
    }

    if (c === ":") {
      if (input[i + 1] === "=") {
        push("assign", ":=", tokenLine, tokenColumn);
        i += 2;
        column += 2;
        continue;
      }

      push("colon", c, tokenLine, tokenColumn);
      i += 1;
      column += 1;
      continue;
    }

    if (
      c === "{"
      || c === "}"
      || c === ","
      || c === ";"
      || c === "="
      || c === "."
      || c === "*"
      || c === "<"
      || c === ">"
      || c === "-"
      || c === "$"
      || c === "@"
      || c === "["
      || c === "]"
      || c === "("
      || c === ")"
    ) {
      if (c === "{") {
        push("lbrace", c, tokenLine, tokenColumn);
      } else if (c === "}") {
        push("rbrace", c, tokenLine, tokenColumn);
      } else if (c === ",") {
        push("comma", c, tokenLine, tokenColumn);
      } else if (c === ";") {
        push("semi", c, tokenLine, tokenColumn);
      } else if (c === ".") {
        push("dot", c, tokenLine, tokenColumn);
      } else if (c === "*") {
        push("star", c, tokenLine, tokenColumn);
      } else if (c === "<") {
        push("lt", c, tokenLine, tokenColumn);
      } else if (c === ">") {
        push("gt", c, tokenLine, tokenColumn);
      } else if (c === "-") {
        push("minus", c, tokenLine, tokenColumn);
      } else if (c === "$") {
        push("dollar", c, tokenLine, tokenColumn);
      } else if (c === "@") {
        push("at", c, tokenLine, tokenColumn);
      } else if (c === "[") {
        push("lbracket", c, tokenLine, tokenColumn);
      } else if (c === "]") {
        push("rbracket", c, tokenLine, tokenColumn);
      } else if (c === "(") {
        push("lparen", c, tokenLine, tokenColumn);
      } else if (c === ")") {
        push("rparen", c, tokenLine, tokenColumn);
      } else {
        push("equals", c, tokenLine, tokenColumn);
      }

      i += 1;
      column += 1;
      continue;
    }

    if (c === "+" && input[i + 1] === "+") {
      push("concat", "++", tokenLine, tokenColumn);
      i += 2;
      column += 2;
      continue;
    }

    if (c === "\"" || c === "'") {
      const quote = c;
      i += 1;
      column += 1;

      let value = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\n") {
          throw new AppError("E_SYNTAX", "Unterminated string literal", tokenLine, tokenColumn);
        }

        value += input[i];
        i += 1;
        column += 1;
      }

      if (input[i] !== quote) {
        throw new AppError("E_SYNTAX", "Unterminated string literal", tokenLine, tokenColumn);
      }

      i += 1;
      column += 1;
      push("string", value, tokenLine, tokenColumn);
      continue;
    }

    if (/[0-9]/.test(c)) {
      let value = c;
      i += 1;
      column += 1;

      while (i < input.length && /[0-9.]/.test(input[i])) {
        value += input[i];
        i += 1;
        column += 1;
      }

      push("number", value, tokenLine, tokenColumn);
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let value = c;
      i += 1;
      column += 1;

      while (i < input.length) {
        const next = input[i];
        if (/[A-Za-z0-9_]/.test(next)) {
          value += next;
          i += 1;
          column += 1;
        } else if (next === ":" && input[i + 1] === ":") {
          value += "::";
          i += 2;
          column += 2;
        } else {
          break;
        }
      }

      const lowered = value.toLowerCase();
      const keyword = KEYWORDS[lowered];
      if (keyword) {
        push(keyword, lowered, tokenLine, tokenColumn);
      } else {
        push("identifier", value, tokenLine, tokenColumn);
      }

      continue;
    }

    throw new AppError("E_SYNTAX", `Unexpected token '${c}'`, tokenLine, tokenColumn);
  }

  tokens.push({ kind: "eof", lexeme: "", line, column });
  return tokens;
};
