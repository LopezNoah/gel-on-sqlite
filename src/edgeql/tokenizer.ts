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

  let i = 0;
  let line = 1;
  let column = 1;
  let openParens = 0;
  const strInterpStack: Array<{ quote: "'" | '"'; parenDepth: number }> = [];

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

  const push = (kind: TokenKind, lexeme: string, tokenLine: number, tokenColumn: number): void => {
    tokens.push({ kind, lexeme, line: tokenLine, column: tokenColumn });
  };

  const syntaxError = (message: string, tokenLine: number, tokenColumn: number): never => {
    throw new AppError("E_SYNTAX", message, tokenLine, tokenColumn);
  };

  const scanEscapeValue = (tokenLine: number, tokenColumn: number): string => {
    if (isAtEnd()) {
      syntaxError("Unterminated escape sequence", tokenLine, tokenColumn);
    }

    const esc = advance();
    switch (esc) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "\\":
        return "\\";
      case "'":
        return "'";
      case '"':
        return '"';
      default:
        return syntaxError(`Unsupported escape sequence '\\${esc}'`, tokenLine, tokenColumn);
    }
  };

  const scanParameterLexeme = (): string => {
    advance(); // '$'
    let value = "$";

    if (peek() === "`") {
      advance();
      value += "`";
      while (!isAtEnd()) {
        const ch = advance();
        value += ch;
        if (ch === "`") {
          break;
        }
      }
      return value;
    }

    while (isIdentPart(peek()) || isDigit(peek())) {
      value += advance();
    }
    return value;
  };

  const scanFixedToken = (tokenLine: number, tokenColumn: number): boolean => {
    const candidates = FIXED_TOKENS_BY_START[peek()];
    if (!candidates) {
      return false;
    }

    for (const [lexeme, kind] of candidates) {
      if (!input.startsWith(lexeme, i)) {
        continue;
      }
      for (let j = 0; j < lexeme.length; j += 1) {
        advance();
      }
      push(kind, lexeme, tokenLine, tokenColumn);
      return true;
    }
    return false;
  };

  const scanBacktickName = (tokenLine: number, tokenColumn: number): void => {
    advance();
    let value = "";

    while (!isAtEnd()) {
      const c = advance();
      if (c === "`") {
        if (peek() === "`") {
          advance();
          value += "`";
          continue;
        }
        if (value.length === 0) {
          syntaxError("backtick quotes cannot be empty", tokenLine, tokenColumn);
        }
        if (value.startsWith("@") || value.startsWith("$")) {
          syntaxError("backtick-quoted name cannot start with '@' or '$'", tokenLine, tokenColumn);
        }
        if (value.includes("::")) {
          syntaxError("backtick-quoted name cannot contain '::'", tokenLine, tokenColumn);
        }
        push("backtick_name", value, tokenLine, tokenColumn);
        return;
      }
      value += c;
    }

    syntaxError("unterminated backtick name", tokenLine, tokenColumn);
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

  const scanString = (
    quote: "'" | '"',
    tokenLine: number,
    tokenColumn: number,
    kind: "string" | "bytes_string",
    opts?: { raw?: boolean },
  ): void => {
    const raw = opts?.raw ?? false;
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

      if (c === "\\" && !raw) {
        advance(); // backslash

        if (kind === "string" && peek() === "(") {
          advance();
          push("str_interp_start", value, tokenLine, tokenColumn);
          strInterpStack.push({ quote, parenDepth: openParens });
          return;
        }

        value += scanEscapeValue(tokenLine, tokenColumn);
        continue;
      }

      value += advance();
    }

    syntaxError("Unterminated string literal", tokenLine, tokenColumn);
  };

  const scanStringInterpolationCont = (
    quote: "'" | '"',
    tokenLine: number,
    tokenColumn: number,
  ): void => {
    advance(); // consume ')'
    let value = "";

    while (!isAtEnd()) {
      const c = peek();

      if (c === "\\") {
        advance();
        if (peek() === "(") {
          advance();
          push("str_interp_cont", value, tokenLine, tokenColumn);
          return;
        }
        value += scanEscapeValue(tokenLine, tokenColumn);
        continue;
      }

      if (c === quote) {
        advance();
        push("str_interp_end", value, tokenLine, tokenColumn);
        strInterpStack.pop();
        return;
      }

      value += advance();
    }

    syntaxError("Unterminated string interpolation", tokenLine, tokenColumn);
  };

  const scanDollarQuotedString = (tokenLine: number, tokenColumn: number): boolean => {
    if (peek() !== "$") {
      return false;
    }
    const next = peekNext();
    if (next === "$") {
      const contentStart = i + 2;
      const close = input.indexOf("$$", contentStart);
      if (close < 0) {
        syntaxError("Unterminated string started with $$", tokenLine, tokenColumn);
      }
      const value = input.slice(contentStart, close);
      const totalLen = close + 2 - i;
      for (let k = 0; k < totalLen; k += 1) {
        advance();
      }
      push("string", value, tokenLine, tokenColumn);
      return true;
    }

    if (!isAlpha(next) && next !== "_") {
      return false;
    }

    let j = i + 1;
    while (j < input.length) {
      const ch = input[j]!;
      if (ch === "$") break;
      if (!isAlphaNumeric(ch) && ch !== "_") {
        return false;
      }
      j += 1;
    }
    if (j >= input.length || input[j] !== "$") {
      return false;
    }

    const marker = input.slice(i, j + 1);
    const contentStart = j + 1;
    const close = input.indexOf(marker, contentStart);
    if (close < 0) {
      syntaxError(`Unterminated string started with ${marker}`, tokenLine, tokenColumn);
    }
    const value = input.slice(contentStart, close);
    const totalLen = close + marker.length - i;
    for (let k = 0; k < totalLen; k += 1) {
      advance();
    }
    push("string", value, tokenLine, tokenColumn);
    return true;
  };

  const scanNumber = (tokenLine: number, tokenColumn: number): void => {
    const start = i;

    if (peek() === "0" && isDigit(peekNext())) {
      syntaxError("leading zeros are not allowed in numbers", tokenLine, tokenColumn);
    }

    while (isDigit(peek()) || peek() === "_") {
      advance();
    }

    if (peek() === "." && isDigit(peekNext())) {
      advance(); // '.'
      while (isDigit(peek()) || peek() === "_") {
        advance();
      }
    }

    if (peek() === "e" || peek() === "E") {
      advance();
      if (peek() === "+" || peek() === "-") {
        advance();
      }
      if (!isDigit(peek())) {
        syntaxError("expected digit after exponent marker", tokenLine, tokenColumn);
      }
      while (isDigit(peek()) || peek() === "_") {
        advance();
      }
    }

    if (peek() === "n") {
      advance();
    }

    push("number", input.slice(start, i), tokenLine, tokenColumn);
  };

  const scanIdentifierOrKeyword = (tokenLine: number, tokenColumn: number): void => {
    const start = i;
    let hasUppercase = false;

    while (isIdentPart(peek())) {
      const c = advance();
      hasUppercase ||= c >= "A" && c <= "Z";
    }

    const value = input.slice(start, i);
    const lowered = hasUppercase ? value.toLowerCase() : value;
    const keyword = KEYWORDS[lowered];

    if (keyword && !(keyword === "kw_named" && hasUppercase)) {
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

    if (
      strInterpStack.length > 0 &&
      c === ")" &&
      strInterpStack[strInterpStack.length - 1]!.parenDepth === openParens
    ) {
      scanStringInterpolationCont(strInterpStack[strInterpStack.length - 1]!.quote, tokenLine, tokenColumn);
      continue;
    }

    // Byte strings: b'...' or b"..."
    if ((c === "b" || c === "B") && (peekNext() === "'" || peekNext() === '"')) {
      advance(); // consume b/B
      scanString(peek() as "'" | '"', tokenLine, tokenColumn, "bytes_string");
      continue;
    }

    // Raw strings: r'...' or r"..."
    if ((c === "r" || c === "R") && (peekNext() === "'" || peekNext() === '"')) {
      advance();
      scanString(peek() as "'" | '"', tokenLine, tokenColumn, "string", { raw: true });
      continue;
    }

    if (c === "$" && scanDollarQuotedString(tokenLine, tokenColumn)) {
      continue;
    }

    if (c === "`") {
      scanBacktickName(tokenLine, tokenColumn);
      continue;
    }

    // Strings
    if (c === "'" || c === '"') {
      scanString(c, tokenLine, tokenColumn, "string");
      continue;
    }

    if (scanFixedToken(tokenLine, tokenColumn)) {
      continue;
    }

    if (c === "." && peekNext() === "?") {
      syntaxError(".? is not an operator, did you mean .?> ?", tokenLine, tokenColumn);
    }

    if (c === "?" && peekNext() === "!") {
      syntaxError("?! is not an operator, did you mean ?!= ?", tokenLine, tokenColumn);
    }

    if (c === "?" ) {
      syntaxError("Bare '?' is not an operator, did you mean '?=' or '??'?", tokenLine, tokenColumn);
    }

    if (c === "!") {
      syntaxError("Bare '!' is not an operator, did you mean '!='?", tokenLine, tokenColumn);
    }

    if (c === "<" && isDigit(peekNext())) {
      const start = i;
      advance();
      while (isDigit(peek())) {
        advance();
      }
      if (peek() === ">" && input[i + 1] === "$") {
        advance();
        const param = scanParameterLexeme();
        push("parameter_and_type", `${input.slice(start, i - param.length)}${param}`, tokenLine, tokenColumn);
        continue;
      }
      i = start;
    }

    if (c === "$" && (isIdentStart(peekNext()) || isDigit(peekNext()) || peekNext() === "`")) {
      const value = scanParameterLexeme();
      push("parameter", value, tokenLine, tokenColumn);
      continue;
    }

    if (c === "\\" && peekNext() === "(") {
      advance();
      advance();
      let value = "\\(";
      while (!isAtEnd() && peek() !== ")") {
        const ch = peek();
        if (!isAlphaNumeric(ch) && ch !== "_") {
          syntaxError("only alphanumerics are allowed in \\(name) token", tokenLine, tokenColumn);
        }
        value += advance();
      }
      if (peek() !== ")") {
        syntaxError("unclosed \\(name) token", tokenLine, tokenColumn);
      }
      value += advance();
      push("substitution", value, tokenLine, tokenColumn);
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
        openParens += 1;
        push("lparen", "(", tokenLine, tokenColumn);
        continue;
      case ")":
        advance();
        if (openParens > 0) {
          openParens -= 1;
        }
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
      case "/":
        advance();
        push("slash", "/", tokenLine, tokenColumn);
        continue;
      case "%":
        advance();
        push("modulo", "%", tokenLine, tokenColumn);
        continue;
      case "^":
        advance();
        push("pow", "^", tokenLine, tokenColumn);
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
      case "|":
        advance();
        push("pipe", "|", tokenLine, tokenColumn);
        continue;
      case "&":
        advance();
        push("ampersand", "&", tokenLine, tokenColumn);
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
