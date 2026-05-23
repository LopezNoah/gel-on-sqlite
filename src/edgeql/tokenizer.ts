import { AppError } from "../errors.js";

export type TokenKind =
  | "kw_unreserved"
  | "kw_partial_reserved"
  | "kw_future_reserved"
  | "kw_current_reserved"
  | "kw_select"
  | "kw_insert"
  | "kw_update"
  | "kw_delete"
  | "kw_for"
  | "kw_in"
  | "kw_except"
  | "kw_intersect"
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
  | "kw_exists"
  | "kw_create"
  | "kw_alter"
  | "kw_drop"
  | "kw_configure"
  | "kw_describe"
  | "kw_typeof"
  | "kw_introspect"
  | "kw_extending"
  | "kw_variadic"
  | "kw_optional"
  | "kw_commit"
  | "kw_rollback"
  | "kw_start"
  | "kw_transaction"
  | "kw_global"
  | "kw_annotation"
  | "kw_type"
  | "kw_named"
  | "kw_only"
  | "kw_package"
  | "kw_extension"
  | "kw_over"
  | "kw_partition"
  | "kw_window"
  | "kw_group"
  | "kw_using"
  | "kw_empty"
  | "kw_single"
  | "kw_multi"
  | "kw_required"
  | "kw_property"
  | "kw_link"
  | "kw_abstract"
  | "kw_scalar"
  | "kw_object"
  | "kw_function"
  | "kw_index"
  | "kw_constraint"
  | "kw_policy"
  | "kw_trigger"
  | "kw_schema"
  | "kw_database"
  | "kw_branch"
  | "kw_role"
  | "kw_current_reserved_source"
  | "kw_current_reserved_subject"
  | "kw_current_reserved_type"
  | "kw_current_reserved_std"
  | "kw_current_reserved_edgedbsys"
  | "kw_current_reserved_edgedbtpl"
  | "kw_current_reserved_new"
  | "kw_current_reserved_old"
  | "kw_current_reserved_specified"
  | "kw_current_reserved_default"
  | "identifier"
  | "backtick_name"
  | "string"
  | "str_interp_start"
  | "str_interp_cont"
  | "str_interp_end"
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
  | "add_assign"
  | "sub_assign"
  | "semi"
  | "dot"
  | "star"
  | "double_splat"
  | "arrow"
  | "backward_link"
  | "optional_link"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "distinct_from"
  | "not_distinct_from"
  | "minus"
  | "plus"
  | "slash"
  | "floor_div"
  | "modulo"
  | "pow"
  | "concat"
  | "coalesce"
  | "pipe"
  | "ampersand"
  | "dollar"
  | "parameter"
  | "parameter_and_type"
  | "substitution"
  | "at"
  | "eof";

export const UNRESERVED_KEYWORDS = [
  "abort", "abstract", "access", "after", "alias", "allow", "all", "annotation", "applied",
  "as", "asc", "assignment", "before", "branch", "cardinality", "cast", "committed",
  "config", "conflict", "constraint", "cube", "current", "data", "database", "ddl", "declare",
  "default", "deferrable", "deferred", "delegated", "deny", "desc", "each", "empty", "expression",
  "extension", "final", "first", "force", "from", "function", "future", "implicit", "index", "infix",
  "inheritable", "instance", "into", "isolation", "json", "last", "link", "migration", "multi",
  "named", "object", "of", "only", "onto", "operator", "optionality", "order", "orphan", "overloaded",
  "owned", "package", "permission", "policy", "populate", "postfix", "prefix", "property",
  "proposed", "pseudo", "read", "reject", "release", "rename", "repeatable", "required", "reset",
  "restrict", "rewrite", "role", "roles", "rollup", "savepoint", "scalar", "schema", "sdl",
  "serializable", "session", "source", "superuser", "system", "target", "template", "ternary",
  "text", "then", "to", "transaction", "trigger", "type", "unless", "using", "verbose", "version",
  "view", "write",
] as const;

export const PARTIAL_RESERVED_KEYWORDS = ["except", "intersect", "union"] as const;

export const FUTURE_RESERVED_KEYWORDS = [
  "anyarray", "begin", "case", "check", "deallocate", "discard", "end", "explain", "fetch", "get",
  "global", "grant", "import", "listen", "load", "lock", "match", "move", "notify", "on", "over",
  "partition", "prepare", "raise", "refresh", "revoke", "single", "when", "window", "never",
] as const;

export const CURRENT_RESERVED_KEYWORDS = [
  "__source__", "__subject__", "__type__", "__std__", "__edgedbsys__", "__edgedbtpl__",
  "__new__", "__old__", "__specified__", "__default__", "administer", "alter", "analyze",
  "and", "anytuple", "anytype", "anyobject", "by", "commit", "configure", "create", "delete",
  "describe", "detached", "distinct", "do", "drop", "else", "exists", "extending", "false",
  "filter", "for", "group", "if", "ilike", "in", "insert", "introspect", "is", "like", "limit",
  "module", "not", "offset", "optional", "or", "rollback", "select", "set", "start", "true", "typeof",
  "update", "variadic", "with",
] as const;

export const COMBINED_KEYWORDS = ["named only", "set annotation", "set type", "extension package", "order by"] as const;

export interface Token {
  kind: TokenKind;
  lexeme: string;
  line: number;
  column: number;
  hint?: string;
}

const KEYWORDS: Record<string, TokenKind> = {
  __source__: "kw_current_reserved_source",
  __subject__: "kw_current_reserved_subject",
  __type__: "kw_current_reserved_type",
  __std__: "kw_current_reserved_std",
  __edgedbsys__: "kw_current_reserved_edgedbsys",
  __edgedbtpl__: "kw_current_reserved_edgedbtpl",
  __new__: "kw_current_reserved_new",
  __old__: "kw_current_reserved_old",
  __specified__: "kw_current_reserved_specified",
  __default__: "kw_current_reserved_default",
  select: "kw_select",
  insert: "kw_insert",
  update: "kw_update",
  delete: "kw_delete",
  for: "kw_for",
  in: "kw_in",
  except: "kw_except",
  intersect: "kw_intersect",
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
  exists: "kw_exists",
  create: "kw_create",
  alter: "kw_alter",
  drop: "kw_drop",
  configure: "kw_configure",
  describe: "kw_describe",
  typeof: "kw_typeof",
  introspect: "kw_introspect",
  extending: "kw_extending",
  variadic: "kw_variadic",
  optional: "kw_optional",
  commit: "kw_commit",
  rollback: "kw_rollback",
  start: "kw_start",
  transaction: "kw_transaction",
  global: "kw_global",
  annotation: "kw_annotation",
  type: "kw_type",
  named: "kw_named",
  only: "kw_only",
  package: "kw_package",
  extension: "kw_extension",
  over: "kw_over",
  partition: "kw_partition",
  window: "kw_window",
  group: "kw_group",
  using: "kw_using",
  empty: "kw_empty",
  single: "kw_single",
  multi: "kw_multi",
  required: "kw_required",
  property: "kw_property",
  link: "kw_link",
  abstract: "kw_abstract",
  scalar: "kw_scalar",
  object: "kw_object",
  function: "kw_function",
  index: "kw_index",
  constraint: "kw_constraint",
  policy: "kw_policy",
  trigger: "kw_trigger",
  schema: "kw_schema",
  database: "kw_database",
  branch: "kw_branch",
  role: "kw_role",
};

for (const keyword of UNRESERVED_KEYWORDS) {
  if (!KEYWORDS[keyword]) {
    KEYWORDS[keyword] = "kw_unreserved";
  }
}

for (const keyword of PARTIAL_RESERVED_KEYWORDS) {
  if (!KEYWORDS[keyword]) {
    KEYWORDS[keyword] = "kw_partial_reserved";
  }
}

for (const keyword of FUTURE_RESERVED_KEYWORDS) {
  if (!KEYWORDS[keyword]) {
    KEYWORDS[keyword] = "kw_future_reserved";
  }
}

for (const keyword of CURRENT_RESERVED_KEYWORDS) {
  if (!KEYWORDS[keyword]) {
    KEYWORDS[keyword] = "kw_current_reserved";
  }
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isAlphaNumeric = (c: string): boolean => isAlpha(c) || isDigit(c);
const isIdentStart = (c: string): boolean => isAlpha(c);
const isIdentPart = (c: string): boolean => isAlphaNumeric(c);

// Character code constants for the hot tokenizer paths. Using charCodeAt
// avoids allocating one-character strings for every byte of input.
const CC_TAB = 9;
const CC_LF = 10;
const CC_CR = 13;
const CC_SPACE = 32;
const CC_EXCL = 33;
const CC_DQUOTE = 34;
const CC_HASH = 35;
const CC_DOLLAR = 36;
const CC_PERCENT = 37;
const CC_AMP = 38;
const CC_SQUOTE = 39;
const CC_LPAREN = 40;
const CC_RPAREN = 41;
const CC_STAR = 42;
const CC_PLUS = 43;
const CC_COMMA = 44;
const CC_MINUS = 45;
const CC_DOT = 46;
const CC_SLASH = 47;
const CC_0 = 48;
const CC_9 = 57;
const CC_COLON = 58;
const CC_SEMI = 59;
const CC_LT = 60;
const CC_EQ = 61;
const CC_GT = 62;
const CC_QMARK = 63;
const CC_AT = 64;
const CC_A = 65;
const CC_B_UP = 66;
const CC_E_UP = 69;
const CC_R_UP = 82;
const CC_Z = 90;
const CC_LBRACK = 91;
const CC_BACKSLASH = 92;
const CC_RBRACK = 93;
const CC_CARET = 94;
const CC_UNDERSCORE = 95;
const CC_BACKTICK = 96;
const CC_a = 97;
const CC_b = 98;
const CC_e = 101;
const CC_n = 110;
const CC_r = 114;
const CC_z = 122;
const CC_LBRACE = 123;
const CC_PIPE = 124;
const CC_RBRACE = 125;

const isAlphaCC = (cc: number): boolean =>
  (cc >= CC_a && cc <= CC_z) || (cc >= CC_A && cc <= CC_Z) || cc === CC_UNDERSCORE;
const isDigitCC = (cc: number): boolean => cc >= CC_0 && cc <= CC_9;
const isIdentPartCC = (cc: number): boolean =>
  (cc >= CC_a && cc <= CC_z) ||
  (cc >= CC_A && cc <= CC_Z) ||
  (cc >= CC_0 && cc <= CC_9) ||
  cc === CC_UNDERSCORE;

type FixedToken = readonly [lexeme: string, kind: TokenKind];

const FIXED_TOKENS_BY_START: Partial<Record<string, readonly FixedToken[]>> = {
  ".": [
    [".?>", "optional_link"],
    [".<", "backward_link"],
  ],
  "-": [
    ["->", "arrow"],
    ["-=", "sub_assign"],
  ],
  "+": [
    ["+=", "add_assign"],
    ["++", "concat"],
  ],
  "/": [["//", "floor_div"]],
  "*": [["**", "double_splat"]],
  ":": [
    [":=", "assign"],
    ["::", "coloncolon"],
  ],
  "!": [["!=", "not_equals"]],
  "<": [["<=", "lte"]],
  ">": [[">=", "gte"]],
  "?": [
    ["??", "coalesce"],
    ["?=", "not_distinct_from"],
    ["?!=", "distinct_from"],
  ],
};

export const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  const len = input.length;

  let i = 0;
  let line = 1;
  let column = 1;
  let openParens = 0;
  const strInterpStack: Array<{ quote: number; parenDepth: number }> = [];

  const syntaxError = (message: string, tokenLine: number, tokenColumn: number): never => {
    throw new AppError("E_SYNTAX", message, tokenLine, tokenColumn);
  };

  // scanEscapeValue: at entry, `i` is just past the leading backslash; the
  // escape character has not been consumed yet. Returns the unescaped char.
  const scanEscapeValue = (tokenLine: number, tokenColumn: number): string => {
    if (i >= len) {
      syntaxError("Unterminated escape sequence", tokenLine, tokenColumn);
    }
    const esc = input.charCodeAt(i);
    i += 1;
    column += 1;
    switch (esc) {
      case CC_n: return "\n";
      case CC_r: return "\r";
      // 't' is 116
      case 116: return "\t";
      case CC_BACKSLASH: return "\\";
      case CC_SQUOTE: return "'";
      case CC_DQUOTE: return '"';
      default:
        return syntaxError(`Unsupported escape sequence '\\${input[i - 1]}'`, tokenLine, tokenColumn);
    }
  };

  // scanParameterLexeme: enters at the '$' starting the parameter.
  const scanParameterLexeme = (): string => {
    const start = i;
    i += 1;
    column += 1;

    if (i < len && input.charCodeAt(i) === CC_BACKTICK) {
      i += 1;
      column += 1;
      while (i < len) {
        const cc = input.charCodeAt(i);
        i += 1;
        if (cc === CC_LF) {
          line += 1;
          column = 1;
        } else {
          column += 1;
        }
        if (cc === CC_BACKTICK) break;
      }
      return input.slice(start, i);
    }

    while (i < len) {
      const cc = input.charCodeAt(i);
      if (!isIdentPartCC(cc)) break;
      i += 1;
      column += 1;
    }
    return input.slice(start, i);
  };

  const scanBacktickName = (tokenLine: number, tokenColumn: number): void => {
    i += 1; // opening backtick
    column += 1;
    let value = "";
    let segStart = i;

    while (i < len) {
      const cc = input.charCodeAt(i);
      if (cc === CC_LF) {
        line += 1;
        column = 1;
        i += 1;
        continue;
      }
      if (cc === CC_BACKTICK) {
        // Append any pending segment.
        if (i > segStart) value += input.slice(segStart, i);
        i += 1;
        column += 1;
        if (i < len && input.charCodeAt(i) === CC_BACKTICK) {
          // escaped backtick
          value += "`";
          i += 1;
          column += 1;
          segStart = i;
          continue;
        }
        if (value.length === 0) {
          syntaxError("backtick quotes cannot be empty", tokenLine, tokenColumn);
        }
        if (value.charCodeAt(0) === CC_AT || value.charCodeAt(0) === CC_DOLLAR) {
          syntaxError("backtick-quoted name cannot start with '@' or '$'", tokenLine, tokenColumn);
        }
        if (value.includes("::")) {
          syntaxError("backtick-quoted name cannot contain '::'", tokenLine, tokenColumn);
        }
        tokens.push({ kind: "backtick_name", lexeme: value, line: tokenLine, column: tokenColumn });
        return;
      }
      i += 1;
      column += 1;
    }

    syntaxError("unterminated backtick name", tokenLine, tokenColumn);
  };

  const scanString = (
    quoteCC: number,
    tokenLine: number,
    tokenColumn: number,
    kind: "string" | "bytes_string",
    raw: boolean,
  ): void => {
    i += 1; // opening quote
    column += 1;

    let segStart = i;
    let value: string | undefined;

    while (i < len) {
      const cc = input.charCodeAt(i);
      if (cc === CC_LF) {
        syntaxError("Unterminated string literal", tokenLine, tokenColumn);
      }
      if (cc === quoteCC) {
        const seg = input.slice(segStart, i);
        const out = value === undefined ? seg : value + seg;
        i += 1;
        column += 1;
        tokens.push({ kind, lexeme: out, line: tokenLine, column: tokenColumn });
        return;
      }
      if (cc === CC_BACKSLASH && !raw) {
        if (value === undefined) {
          value = input.slice(segStart, i);
        } else {
          value += input.slice(segStart, i);
        }
        i += 1;
        column += 1;
        if (kind === "string" && i < len && input.charCodeAt(i) === CC_LPAREN) {
          i += 1;
          column += 1;
          tokens.push({ kind: "str_interp_start", lexeme: value, line: tokenLine, column: tokenColumn });
          strInterpStack.push({ quote: quoteCC, parenDepth: openParens });
          return;
        }
        value += scanEscapeValue(tokenLine, tokenColumn);
        segStart = i;
        continue;
      }
      i += 1;
      column += 1;
    }

    syntaxError("Unterminated string literal", tokenLine, tokenColumn);
  };

  const scanStringInterpolationCont = (
    quoteCC: number,
    tokenLine: number,
    tokenColumn: number,
  ): void => {
    i += 1; // consume ')'
    column += 1;
    let segStart = i;
    let value: string | undefined;

    while (i < len) {
      const cc = input.charCodeAt(i);
      if (cc === CC_BACKSLASH) {
        if (value === undefined) value = input.slice(segStart, i);
        else value += input.slice(segStart, i);
        i += 1;
        column += 1;
        if (i < len && input.charCodeAt(i) === CC_LPAREN) {
          i += 1;
          column += 1;
          tokens.push({ kind: "str_interp_cont", lexeme: value, line: tokenLine, column: tokenColumn });
          return;
        }
        value += scanEscapeValue(tokenLine, tokenColumn);
        segStart = i;
        continue;
      }
      if (cc === quoteCC) {
        const seg = input.slice(segStart, i);
        const out = value === undefined ? seg : value + seg;
        i += 1;
        column += 1;
        tokens.push({ kind: "str_interp_end", lexeme: out, line: tokenLine, column: tokenColumn });
        strInterpStack.pop();
        return;
      }
      if (cc === CC_LF) {
        line += 1;
        column = 1;
        i += 1;
        continue;
      }
      i += 1;
      column += 1;
    }

    syntaxError("Unterminated string interpolation", tokenLine, tokenColumn);
  };

  const advanceColumnFor = (start: number, end: number): void => {
    // Used after slicing a span we already know contains no newlines.
    column += end - start;
  };

  const scanDollarQuotedString = (tokenLine: number, tokenColumn: number): boolean => {
    // First char is '$'.
    if (i + 1 >= len) return false;
    const next = input.charCodeAt(i + 1);
    if (next === CC_DOLLAR) {
      const contentStart = i + 2;
      const close = input.indexOf("$$", contentStart);
      if (close < 0) {
        syntaxError("Unterminated string started with $$", tokenLine, tokenColumn);
      }
      const value = input.slice(contentStart, close);
      // Advance through the literal, updating line/column.
      const endIdx = close + 2;
      for (let k = i; k < endIdx; k += 1) {
        if (input.charCodeAt(k) === CC_LF) {
          line += 1;
          column = 1;
        } else {
          column += 1;
        }
      }
      i = endIdx;
      tokens.push({ kind: "string", lexeme: value, line: tokenLine, column: tokenColumn });
      return true;
    }

    if (!isAlphaCC(next)) return false;

    let j = i + 1;
    while (j < len) {
      const cc = input.charCodeAt(j);
      if (cc === CC_DOLLAR) break;
      if (!isIdentPartCC(cc)) return false;
      j += 1;
    }
    if (j >= len || input.charCodeAt(j) !== CC_DOLLAR) return false;

    const marker = input.slice(i, j + 1);
    const contentStart = j + 1;
    const close = input.indexOf(marker, contentStart);
    if (close < 0) {
      syntaxError(`Unterminated string started with ${marker}`, tokenLine, tokenColumn);
    }
    const value = input.slice(contentStart, close);
    const endIdx = close + marker.length;
    for (let k = i; k < endIdx; k += 1) {
      if (input.charCodeAt(k) === CC_LF) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    i = endIdx;
    tokens.push({ kind: "string", lexeme: value, line: tokenLine, column: tokenColumn });
    return true;
  };

  const scanNumber = (tokenLine: number, tokenColumn: number): void => {
    const start = i;

    if (
      input.charCodeAt(i) === CC_0 &&
      i + 1 < len &&
      isDigitCC(input.charCodeAt(i + 1))
    ) {
      syntaxError("leading zeros are not allowed in numbers", tokenLine, tokenColumn);
    }

    while (i < len) {
      const cc = input.charCodeAt(i);
      if (!isDigitCC(cc) && cc !== CC_UNDERSCORE) break;
      i += 1;
    }

    if (
      i < len &&
      input.charCodeAt(i) === CC_DOT &&
      i + 1 < len &&
      isDigitCC(input.charCodeAt(i + 1))
    ) {
      i += 1;
      while (i < len) {
        const cc = input.charCodeAt(i);
        if (!isDigitCC(cc) && cc !== CC_UNDERSCORE) break;
        i += 1;
      }
    }

    if (i < len) {
      const cc = input.charCodeAt(i);
      if (cc === CC_e || cc === CC_E_UP) {
        i += 1;
        if (i < len) {
          const sign = input.charCodeAt(i);
          if (sign === CC_PLUS || sign === CC_MINUS) i += 1;
        }
        if (i >= len || !isDigitCC(input.charCodeAt(i))) {
          syntaxError("expected digit after exponent marker", tokenLine, tokenColumn);
        }
        while (i < len) {
          const dc = input.charCodeAt(i);
          if (!isDigitCC(dc) && dc !== CC_UNDERSCORE) break;
          i += 1;
        }
      }
    }

    if (i < len && input.charCodeAt(i) === CC_n) i += 1;

    advanceColumnFor(start, i);
    tokens.push({ kind: "number", lexeme: input.slice(start, i), line: tokenLine, column: tokenColumn });
  };

  // Scan an identifier or keyword starting at `i`. Caller has verified the
  // first char is an alpha/underscore. Returns true on success.
  const scanIdentifierOrKeyword = (tokenLine: number, tokenColumn: number): void => {
    const start = i;
    let hasUppercase = false;

    while (i < len) {
      const cc = input.charCodeAt(i);
      if (cc >= CC_a && cc <= CC_z) { i += 1; continue; }
      if (cc >= CC_A && cc <= CC_Z) { hasUppercase = true; i += 1; continue; }
      if (cc === CC_UNDERSCORE) { i += 1; continue; }
      if (cc >= CC_0 && cc <= CC_9) { i += 1; continue; }
      break;
    }

    advanceColumnFor(start, i);
    const value = input.slice(start, i);
    const lowered = hasUppercase ? value.toLowerCase() : value;
    const keyword = KEYWORDS[lowered];

    if (keyword !== undefined && !(keyword === "kw_named" && hasUppercase)) {
      tokens.push({ kind: keyword, lexeme: lowered, line: tokenLine, column: tokenColumn });
    } else {
      tokens.push({ kind: "identifier", lexeme: value, line: tokenLine, column: tokenColumn });
    }
  };

  while (i < len) {
    // Skip whitespace and comments inline. This is the hottest path between
    // tokens; using charCodeAt avoids one-char string allocations.
    while (i < len) {
      const cc = input.charCodeAt(i);
      if (cc === CC_SPACE || cc === CC_TAB || cc === CC_CR) {
        i += 1;
        column += 1;
        continue;
      }
      if (cc === CC_LF) {
        i += 1;
        line += 1;
        column = 1;
        continue;
      }
      if (cc === CC_HASH) {
        i += 1;
        column += 1;
        while (i < len) {
          const cc2 = input.charCodeAt(i);
          if (cc2 === CC_LF) break;
          i += 1;
          column += 1;
        }
        continue;
      }
      break;
    }

    if (i >= len) break;

    const tokenLine = line;
    const tokenColumn = column;
    const cc = input.charCodeAt(i);

    // String interpolation continuation: ')' that closes a held interpolation.
    if (
      strInterpStack.length > 0 &&
      cc === CC_RPAREN &&
      strInterpStack[strInterpStack.length - 1]!.parenDepth === openParens
    ) {
      const top = strInterpStack[strInterpStack.length - 1]!;
      scanStringInterpolationCont(top.quote, tokenLine, tokenColumn);
      continue;
    }

    // Single-character punctuation: handle the common cases first since they
    // dominate the token stream after whitespace.
    switch (cc) {
      case CC_LBRACE:
        i += 1; column += 1;
        tokens.push({ kind: "lbrace", lexeme: "{", line: tokenLine, column: tokenColumn });
        continue;
      case CC_RBRACE:
        i += 1; column += 1;
        tokens.push({ kind: "rbrace", lexeme: "}", line: tokenLine, column: tokenColumn });
        continue;
      case CC_LPAREN:
        i += 1; column += 1;
        openParens += 1;
        tokens.push({ kind: "lparen", lexeme: "(", line: tokenLine, column: tokenColumn });
        continue;
      case CC_RPAREN:
        i += 1; column += 1;
        if (openParens > 0) openParens -= 1;
        tokens.push({ kind: "rparen", lexeme: ")", line: tokenLine, column: tokenColumn });
        continue;
      case CC_LBRACK:
        i += 1; column += 1;
        tokens.push({ kind: "lbracket", lexeme: "[", line: tokenLine, column: tokenColumn });
        continue;
      case CC_RBRACK:
        i += 1; column += 1;
        tokens.push({ kind: "rbracket", lexeme: "]", line: tokenLine, column: tokenColumn });
        continue;
      case CC_COMMA:
        i += 1; column += 1;
        tokens.push({ kind: "comma", lexeme: ",", line: tokenLine, column: tokenColumn });
        continue;
      case CC_SEMI:
        i += 1; column += 1;
        tokens.push({ kind: "semi", lexeme: ";", line: tokenLine, column: tokenColumn });
        continue;
      case CC_AT:
        i += 1; column += 1;
        tokens.push({ kind: "at", lexeme: "@", line: tokenLine, column: tokenColumn });
        continue;
      case CC_PIPE:
        i += 1; column += 1;
        tokens.push({ kind: "pipe", lexeme: "|", line: tokenLine, column: tokenColumn });
        continue;
      case CC_AMP:
        i += 1; column += 1;
        tokens.push({ kind: "ampersand", lexeme: "&", line: tokenLine, column: tokenColumn });
        continue;
      case CC_PERCENT:
        i += 1; column += 1;
        tokens.push({ kind: "modulo", lexeme: "%", line: tokenLine, column: tokenColumn });
        continue;
      case CC_CARET:
        i += 1; column += 1;
        tokens.push({ kind: "pow", lexeme: "^", line: tokenLine, column: tokenColumn });
        continue;
      case CC_EQ:
        i += 1; column += 1;
        tokens.push({ kind: "equals", lexeme: "=", line: tokenLine, column: tokenColumn });
        continue;
      case CC_STAR: {
        // '*' or '**'
        if (i + 1 < len && input.charCodeAt(i + 1) === CC_STAR) {
          i += 2; column += 2;
          tokens.push({ kind: "double_splat", lexeme: "**", line: tokenLine, column: tokenColumn });
        } else {
          i += 1; column += 1;
          tokens.push({ kind: "star", lexeme: "*", line: tokenLine, column: tokenColumn });
        }
        continue;
      }
      case CC_SLASH: {
        // '/' or '//'
        if (i + 1 < len && input.charCodeAt(i + 1) === CC_SLASH) {
          i += 2; column += 2;
          tokens.push({ kind: "floor_div", lexeme: "//", line: tokenLine, column: tokenColumn });
        } else {
          i += 1; column += 1;
          tokens.push({ kind: "slash", lexeme: "/", line: tokenLine, column: tokenColumn });
        }
        continue;
      }
      case CC_PLUS: {
        // '+', '++', or '+='
        if (i + 1 < len) {
          const n = input.charCodeAt(i + 1);
          if (n === CC_PLUS) {
            i += 2; column += 2;
            tokens.push({ kind: "concat", lexeme: "++", line: tokenLine, column: tokenColumn });
            continue;
          }
          if (n === CC_EQ) {
            i += 2; column += 2;
            tokens.push({ kind: "add_assign", lexeme: "+=", line: tokenLine, column: tokenColumn });
            continue;
          }
        }
        i += 1; column += 1;
        tokens.push({ kind: "plus", lexeme: "+", line: tokenLine, column: tokenColumn });
        continue;
      }
      case CC_MINUS: {
        // '-', '->', or '-='
        if (i + 1 < len) {
          const n = input.charCodeAt(i + 1);
          if (n === CC_GT) {
            i += 2; column += 2;
            tokens.push({ kind: "arrow", lexeme: "->", line: tokenLine, column: tokenColumn });
            continue;
          }
          if (n === CC_EQ) {
            i += 2; column += 2;
            tokens.push({ kind: "sub_assign", lexeme: "-=", line: tokenLine, column: tokenColumn });
            continue;
          }
        }
        i += 1; column += 1;
        tokens.push({ kind: "minus", lexeme: "-", line: tokenLine, column: tokenColumn });
        continue;
      }
      case CC_COLON: {
        // ':', ':=', '::'
        if (i + 1 < len) {
          const n = input.charCodeAt(i + 1);
          if (n === CC_EQ) {
            i += 2; column += 2;
            tokens.push({ kind: "assign", lexeme: ":=", line: tokenLine, column: tokenColumn });
            continue;
          }
          if (n === CC_COLON) {
            i += 2; column += 2;
            tokens.push({ kind: "coloncolon", lexeme: "::", line: tokenLine, column: tokenColumn });
            continue;
          }
        }
        i += 1; column += 1;
        tokens.push({ kind: "colon", lexeme: ":", line: tokenLine, column: tokenColumn });
        continue;
      }
      case CC_LT: {
        // '<', '<=', or '<NN>$param'
        if (i + 1 < len) {
          const n = input.charCodeAt(i + 1);
          if (n === CC_EQ) {
            i += 2; column += 2;
            tokens.push({ kind: "lte", lexeme: "<=", line: tokenLine, column: tokenColumn });
            continue;
          }
          if (isDigitCC(n)) {
            const start = i;
            const startLine = line;
            const startCol = column;
            i += 1; column += 1;
            while (i < len && isDigitCC(input.charCodeAt(i))) {
              i += 1; column += 1;
            }
            if (
              i < len &&
              input.charCodeAt(i) === CC_GT &&
              i + 1 < len &&
              input.charCodeAt(i + 1) === CC_DOLLAR
            ) {
              i += 1; column += 1; // consume '>'
              const param = scanParameterLexeme();
              const lex = input.slice(start, i - param.length) + param;
              tokens.push({ kind: "parameter_and_type", lexeme: lex, line: tokenLine, column: tokenColumn });
              continue;
            }
            i = start;
            line = startLine;
            column = startCol;
          }
        }
        i += 1; column += 1;
        tokens.push({ kind: "lt", lexeme: "<", line: tokenLine, column: tokenColumn });
        continue;
      }
      case CC_GT: {
        if (i + 1 < len && input.charCodeAt(i + 1) === CC_EQ) {
          i += 2; column += 2;
          tokens.push({ kind: "gte", lexeme: ">=", line: tokenLine, column: tokenColumn });
        } else {
          i += 1; column += 1;
          tokens.push({ kind: "gt", lexeme: ">", line: tokenLine, column: tokenColumn });
        }
        continue;
      }
      case CC_DOT: {
        // '.', '.?>', '.<', '.?' (error)
        if (i + 1 < len) {
          const n = input.charCodeAt(i + 1);
          if (n === CC_QMARK) {
            if (i + 2 < len && input.charCodeAt(i + 2) === CC_GT) {
              i += 3; column += 3;
              tokens.push({ kind: "optional_link", lexeme: ".?>", line: tokenLine, column: tokenColumn });
              continue;
            }
            syntaxError(".? is not an operator, did you mean .?> ?", tokenLine, tokenColumn);
          }
          if (n === CC_LT) {
            i += 2; column += 2;
            tokens.push({ kind: "backward_link", lexeme: ".<", line: tokenLine, column: tokenColumn });
            continue;
          }
        }
        i += 1; column += 1;
        tokens.push({ kind: "dot", lexeme: ".", line: tokenLine, column: tokenColumn });
        continue;
      }
      case CC_QMARK: {
        if (i + 1 < len) {
          const n = input.charCodeAt(i + 1);
          if (n === CC_QMARK) {
            i += 2; column += 2;
            tokens.push({ kind: "coalesce", lexeme: "??", line: tokenLine, column: tokenColumn });
            continue;
          }
          if (n === CC_EQ) {
            i += 2; column += 2;
            tokens.push({ kind: "not_distinct_from", lexeme: "?=", line: tokenLine, column: tokenColumn });
            continue;
          }
          if (n === CC_EXCL) {
            if (i + 2 < len && input.charCodeAt(i + 2) === CC_EQ) {
              i += 3; column += 3;
              tokens.push({ kind: "distinct_from", lexeme: "?!=", line: tokenLine, column: tokenColumn });
              continue;
            }
            syntaxError("?! is not an operator, did you mean ?!= ?", tokenLine, tokenColumn);
          }
        }
        syntaxError("Bare '?' is not an operator, did you mean '?=' or '??'?", tokenLine, tokenColumn);
        continue;
      }
      case CC_EXCL: {
        if (i + 1 < len && input.charCodeAt(i + 1) === CC_EQ) {
          i += 2; column += 2;
          tokens.push({ kind: "not_equals", lexeme: "!=", line: tokenLine, column: tokenColumn });
          continue;
        }
        syntaxError("Bare '!' is not an operator, did you mean '!='?", tokenLine, tokenColumn);
        continue;
      }
      case CC_BACKTICK: {
        scanBacktickName(tokenLine, tokenColumn);
        continue;
      }
      case CC_SQUOTE:
      case CC_DQUOTE: {
        scanString(cc, tokenLine, tokenColumn, "string", false);
        continue;
      }
      case CC_DOLLAR: {
        // dollar-quoted string, parameter, or bare $
        if (scanDollarQuotedString(tokenLine, tokenColumn)) continue;
        if (i + 1 < len) {
          const n = input.charCodeAt(i + 1);
          if (isAlphaCC(n) || isDigitCC(n) || n === CC_BACKTICK) {
            const value = scanParameterLexeme();
            tokens.push({ kind: "parameter", lexeme: value, line: tokenLine, column: tokenColumn });
            continue;
          }
        }
        i += 1; column += 1;
        tokens.push({ kind: "dollar", lexeme: "$", line: tokenLine, column: tokenColumn });
        continue;
      }
      case CC_BACKSLASH: {
        if (i + 1 < len && input.charCodeAt(i + 1) === CC_LPAREN) {
          const start = i;
          i += 2; column += 2;
          while (i < len) {
            const cc2 = input.charCodeAt(i);
            if (cc2 === CC_RPAREN) break;
            if (!isIdentPartCC(cc2)) {
              syntaxError("only alphanumerics are allowed in \\(name) token", tokenLine, tokenColumn);
            }
            i += 1; column += 1;
          }
          if (i >= len || input.charCodeAt(i) !== CC_RPAREN) {
            syntaxError("unclosed \\(name) token", tokenLine, tokenColumn);
          }
          i += 1; column += 1;
          tokens.push({ kind: "substitution", lexeme: input.slice(start, i), line: tokenLine, column: tokenColumn });
          continue;
        }
        break; // fall through to error
      }
      default:
        break;
    }

    // Byte strings: b'...' or b"..."
    if ((cc === CC_b || cc === CC_B_UP) && i + 1 < len) {
      const n = input.charCodeAt(i + 1);
      if (n === CC_SQUOTE || n === CC_DQUOTE) {
        i += 1; column += 1; // consume 'b'/'B'
        scanString(n, tokenLine, tokenColumn, "bytes_string", false);
        continue;
      }
    }

    // Raw strings: r'...' or r"..."
    if ((cc === CC_r || cc === CC_R_UP) && i + 1 < len) {
      const n = input.charCodeAt(i + 1);
      if (n === CC_SQUOTE || n === CC_DQUOTE) {
        i += 1; column += 1;
        scanString(n, tokenLine, tokenColumn, "string", true);
        continue;
      }
    }

    // Numbers
    if (isDigitCC(cc)) {
      scanNumber(tokenLine, tokenColumn);
      continue;
    }

    // Identifiers / keywords
    if (isAlphaCC(cc)) {
      scanIdentifierOrKeyword(tokenLine, tokenColumn);
      continue;
    }

    syntaxError(`Unexpected token '${input[i]}'`, tokenLine, tokenColumn);
  }

  tokens.push({ kind: "eof", lexeme: "", line, column });
  return tokens;
};
