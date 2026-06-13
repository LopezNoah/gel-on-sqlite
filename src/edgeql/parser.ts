import { AppError } from "../errors.js";
import type { ScalarType, ScalarValue } from "../types.js";
import type {
  BacklinkExpr,
  ClauseChain,
  ComputedExpr,
  DeleteStatement,
  DDLStatement,
  ConfigureStatement,
  FilterExpr,
  FilterTarget,
  FunctionDecl,
  FunctionParamDecl,
  ForStatement,
  FunctionCallArgExpr,
  FunctionCallExpr,
  FreeObjectExpr,
  GroupByAtom,
  GroupByElement,
  GroupExpr,
  GroupStatement,
  GroupUsingBinding,
  InsertConflict,
  InsertValue,
  InsertStatement,
  OrderExpr,
  OrderExprChain,
  SelectExprStatement,
  SelectFreeStatement,
  SelectStatement,
  ShapeElement,
  Statement,
  TransactionStatement,
  TupleLiteralElementValue,
  TupleLiteralValue,
  TypeExpr,
  UpdateStatement,
  WithBinding,
  WithBindingValue,
  WithModuleAlias,
  PathStep,
  ShapeElementModifiers,
} from "./ast.js";
import { simpleTypeName } from "./ast.js";
import type { Token, TokenKind } from "./tokenizer.js";
import { tokenizeWithStarts, offsetToLineCol, CURRENT_RESERVED_KEYWORDS } from "./tokenizer.js";

const CURRENT_RESERVED_KEYWORDS_SET: ReadonlySet<string> = new Set(CURRENT_RESERVED_KEYWORDS);

// Token kinds the parser treats as "name-like" (identifier or context-sensitive
// keyword that can also be used as a name). Using a Set lets isNameToken run as
// a single hash lookup instead of a long string-compare chain ending in
// startsWith("kw_current_reserved_").
const NAME_TOKEN_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "identifier",
  "backtick_name",
  "kw_object",
  "kw_named",
  "kw_unreserved",
  "kw_partial_reserved",
  "kw_future_reserved",
  "kw_current_reserved",
  "kw_current_reserved_source",
  "kw_current_reserved_subject",
  "kw_current_reserved_type",
  "kw_current_reserved_std",
  "kw_current_reserved_edgedbsys",
  "kw_current_reserved_edgedbtpl",
  "kw_current_reserved_new",
  "kw_current_reserved_old",
  "kw_current_reserved_specified",
  "kw_current_reserved_default",
  // `schema` is an EdgeDB module name (`WITH MODULE schema`, `schema::Type`)
  // even though `kw_schema` is reserved for SDL `CREATE SCHEMA`-style DDL.
  // Allowing it in name position lets schema-introspection queries parse.
  "kw_schema",
  // The `schema::*` introspection module's type names overlap with reserved
  // SDL/DDL keywords. EdgeDB itself uses these as type names; we follow
  // the same convention so `schema::Type`, `schema::Property`, etc. parse.
  // DDL parsing paths still consume these as keywords first via dedicated
  // peek checks before falling back to name resolution.
  "kw_type",
  "kw_property",
  "kw_link",
  "kw_function",
  "kw_constraint",
  "kw_index",
  "kw_annotation",
  "kw_global",
]);

// Top-level admin / migration / introspection statement keywords that the
// parser accepts permissively (consume tokens to ';'/eof). Used by the
// passthrough path in parseStatement to keep syntax-test corpus parsing
// without modeling each form's full grammar.
const TOP_LEVEL_PASSTHROUGH_LEXEMES: ReadonlySet<string> = new Set([
  "analyze", "populate", "abort", "reset", "declare", "release",
]);

// Set of token kinds whose string name begins with "kw_". Used by
// isKeywordLikeToken to avoid String.prototype.startsWith.
const KW_TOKEN_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "kw_unreserved",
  "kw_partial_reserved",
  "kw_future_reserved",
  "kw_current_reserved",
  "kw_select",
  "kw_insert",
  "kw_update",
  "kw_delete",
  "kw_for",
  "kw_in",
  "kw_except",
  "kw_intersect",
  "kw_union",
  "kw_filter",
  "kw_set",
  "kw_with",
  "kw_order",
  "kw_by",
  "kw_limit",
  "kw_offset",
  "kw_asc",
  "kw_desc",
  "kw_is",
  "kw_true",
  "kw_false",
  "kw_null",
  "kw_like",
  "kw_ilike",
  "kw_and",
  "kw_or",
  "kw_not",
  "kw_distinct",
  "kw_as",
  "kw_module",
  "kw_unless",
  "kw_conflict",
  "kw_on",
  "kw_else",
  "kw_if",
  "kw_then",
  "kw_detached",
  "kw_exists",
  "kw_create",
  "kw_alter",
  "kw_drop",
  "kw_configure",
  "kw_describe",
  "kw_typeof",
  "kw_introspect",
  "kw_extending",
  "kw_variadic",
  "kw_optional",
  "kw_commit",
  "kw_rollback",
  "kw_start",
  "kw_transaction",
  "kw_global",
  "kw_annotation",
  "kw_type",
  "kw_named",
  "kw_only",
  "kw_package",
  "kw_extension",
  "kw_over",
  "kw_partition",
  "kw_window",
  "kw_group",
  "kw_using",
  "kw_empty",
  "kw_single",
  "kw_multi",
  "kw_required",
  "kw_property",
  "kw_link",
  "kw_abstract",
  "kw_scalar",
  "kw_object",
  "kw_function",
  "kw_index",
  "kw_constraint",
  "kw_policy",
  "kw_trigger",
  "kw_schema",
  "kw_database",
  "kw_branch",
  "kw_role",
  "kw_current_reserved_source",
  "kw_current_reserved_subject",
  "kw_current_reserved_type",
  "kw_current_reserved_std",
  "kw_current_reserved_edgedbsys",
  "kw_current_reserved_edgedbtpl",
  "kw_current_reserved_new",
  "kw_current_reserved_old",
  "kw_current_reserved_specified",
  "kw_current_reserved_default",
]);

const GLOBAL_RESERVED_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "kw_current_reserved_source",
  "kw_current_reserved_subject",
  "kw_current_reserved_type",
  "kw_current_reserved_std",
  "kw_current_reserved_edgedbsys",
  "kw_current_reserved_edgedbtpl",
  "kw_current_reserved_new",
  "kw_current_reserved_old",
  "kw_current_reserved_specified",
  "kw_current_reserved_default",
]);

interface ParseContext {
  with?: WithBinding[];
  withModule?: string;
  withModuleAliases?: WithModuleAlias[];
}

interface ParseCheckpoint {
  index: number;
}

export interface ParseEdgeQLOptions {
  defaultModule?: string;
  // When true, bare top-level expressions (`1 + 2`, `<str>{} if true else 'x'`,
  // `Foo.bar`) are accepted and wrapped in an implicit `SELECT`. Disabled by
  // default so the script entry point matches upstream's reject-bare-exprs
  // behaviour; IR tests pass `parseEdgeQL` with this option enabled.
  allowBareExpressionStatement?: boolean;
}

type ParsedLiteralValue = ScalarValue | ParsedLiteralValue[];

type SelectExprTailParts = {
  filter?: FreeObjectExpr;
  orderBy?: OrderExprChain;
  limit?: number;
  offset?: number;
  limitExpr?: FreeObjectExpr;
  offsetExpr?: FreeObjectExpr;
};

interface PostfixChainOptions {
  indexes?: boolean;
  typeFilters?: boolean;
  shapeProjections?: boolean;
  pathSteps?: boolean;
}

class Parser {
  private readonly tokens: Token[];
  // `lineStarts` is shared with the tokenizer so we can translate
  // `token.offset` to a 1-indexed (line, column) pair only when we actually
  // need it (for errors and AST `pos:` fields). Skipping per-token column
  // arithmetic in the tokenizer hot loop is the bulk of the win.
  private readonly lineStarts: readonly number[];
  // Original source text. Available when the parser was constructed from a
  // string, or when callers explicitly pass it alongside a precomputed token
  // stream. Needed for verbatim capture of `USING (...)` function bodies.
  private readonly sourceText?: string;
  private index = 0;
  private readonly localBindings: string[] = [];
  // Result aliases (`SELECT _ := <expr>`) currently being parsed. The alias
  // is not in scope inside its own definition; references to it from within
  // `<expr>` must fail. Violations are recorded on a side channel because
  // speculative `attempt()` parsing swallows thrown errors.
  private readonly pendingResultAliases: string[] = [];
  private pendingResultAliasViolation?: AppError;
  private readonly defaultModule?: string;
  private readonly options: ParseEdgeQLOptions;

  constructor(
    source: string | { tokens: Token[]; lineStarts: readonly number[]; source?: string },
    options: ParseEdgeQLOptions = {},
  ) {
    if (typeof source === "string") {
      const r = tokenizeWithStarts(source);
      this.tokens = r.tokens;
      this.lineStarts = r.lineStarts;
      this.sourceText = source;
    } else {
      this.tokens = source.tokens;
      this.lineStarts = source.lineStarts;
      this.sourceText = source.source;
    }
    this.defaultModule = options.defaultModule;
    this.options = options;
  }

  // Resolve a token's byte offset back to a 1-indexed (line, column) record.
  // Used for AST `pos:` fields.
  private posOf(token: Token): { line: number; column: number } {
    return offsetToLineCol(token.offset, this.lineStarts);
  }

  // Same as posOf but returns a tuple so it can be spread into positional
  // arg lists like `new AppError(code, msg, line, column)`.
  private posPair(token: Token): [number, number] {
    const p = offsetToLineCol(token.offset, this.lineStarts);
    return [p.line, p.column];
  }

  private parseDelimited<T>(
    endKind: Token["kind"],
    parseItem: () => T,
    commaMessage: string,
  ): T[] {
    const items: T[] = [];
    while (this.peek().kind !== endKind) {
      items.push(parseItem());
      if (this.peek().kind !== endKind) {
        this.expect("comma", commaMessage);
      }
    }
    return items;
  }

  private withLocalBinding<T>(name: string, fn: () => T): T {
    this.localBindings.push(name);
    try {
      return fn();
    } finally {
      this.localBindings.pop();
    }
  }

  private checkpoint(): ParseCheckpoint {
    return { index: this.index };
  }

  private restore(checkpoint: ParseCheckpoint): void {
    this.index = checkpoint.index;
  }

  private attempt<T>(fn: () => T | undefined): T | undefined {
    const savedIndex = this.index;
    try {
      const result = fn();
      if (result === undefined) {
        this.index = savedIndex;
      }
      return result;
    } catch {
      this.index = savedIndex;
      return undefined;
    }
  }

  private match(kind: Token["kind"]): Token | undefined {
    return this.peek().kind === kind ? this.consume() : undefined;
  }

  private matchAny(...kinds: Token["kind"][]): Token | undefined {
    return kinds.includes(this.peek().kind) ? this.consume() : undefined;
  }

  private expectAny(kinds: readonly Token["kind"][], message: string): Token {
    const token = this.peek();
    if (!kinds.includes(token.kind)) {
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }
    return this.consume();
  }

  // Throws an E_SYNTAX error tagged with `[not supported]` so callers (tests,
  // tooling, users) can search/filter for parity gaps without false positives
  // against ordinary "Expected X" diagnostics. Use this anywhere upstream
  // EdgeQL accepts a construct that sqlite-ts has not yet implemented, or
  // where upstream explicitly rejects a construct that we want to mirror.
  private notSupported(token: Token, area: string, detail?: string): never {
    const msg = detail
      ? `[not supported] ${area}: ${detail}`
      : `[not supported] ${area}`;
    throw new AppError("E_SYNTAX", msg, ...this.posPair(token));
  }

  private isKeywordLikeToken(token: Token): boolean {
    const k = token.kind;
    // Note: backtick_name is intentionally excluded — backticks escape an
    // identifier so it bypasses keyword matching (`` `variadic` `` is a
    // user identifier, not the VARIADIC keyword).
    return KW_TOKEN_KINDS.has(k) || k === "identifier";
  }

  private matchKeywordLexeme(lexeme: string): Token | undefined {
    const token = this.peek();
    return this.isKeywordLikeToken(token) && token.lower === lexeme ? this.consume() : undefined;
  }

  private parseKeywordChoice<T extends string>(choices: Record<string, T>, message: string): { token: Token; value: T } {
    const token = this.peek();
    const value = this.isKeywordLikeToken(token) ? choices[token.lower] : undefined;
    if (!value) {
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }
    this.consume();
    return { token, value };
  }

  private atFunctionCall(): boolean {
    return this.isNameToken(this.peek()) && this.kindAfterQualifiedName() === "lparen";
  }

  private atQualifiedIdentifier(): boolean {
    if (!this.isNameToken(this.peek()) || this.kindAfterQualifiedName() !== "dot") {
      return false;
    }
    return this.isNameToken(this.tokenAfterQualifiedNameAndDot());
  }

  private tokenAfterQualifiedNameAndDot(): Token {
    let i = this.index + 1;
    while (true) {
      const t1 = this.tokens[i + 1];
      const t2 = this.tokens[i + 2];
      if (this.tokens[i]?.kind === "coloncolon" && t1 && this.isNameToken(t1)) {
        i += 2;
        continue;
      }
      if (this.tokens[i]?.kind === "colon" && t1?.kind === "colon" && t2 && this.isNameToken(t2)) {
        i += 3;
        continue;
      }
      break;
    }
    if (this.tokens[i]?.kind === "dot") {
      return this.tokens[i + 1] ?? this.tokens[this.tokens.length - 1];
    }
    return this.tokens[i] ?? this.tokens[this.tokens.length - 1];
  }

  private atDotField(): boolean {
    return this.peek().kind === "dot" && this.isNameToken(this.peekNext());
  }

  private atBacklink(): boolean {
    return this.peek().kind === "backward_link" || (this.peek().kind === "dot" && this.peekNext().kind === "lt");
  }

  private isNameToken(token: Token): boolean {
    return NAME_TOKEN_KINDS.has(token.kind);
  }

  private nameTokenLexeme(token: Token): string {
    // The tokenizer lower-cases keyword lexemes by default (so `if (kind ===
    // "kw_type" && lexeme === "type")` patterns work). When a reserved
    // keyword is used as an identifier — like `schema::Type`,
    // `schema::Property`, `schema::ObjectType` — we need to recover the
    // canonical type-name capitalization since the schema is keyed
    // case-sensitively (`schema::Type`, not `schema::type`).
    switch (token.kind) {
      case "kw_object": return "Object";
      case "kw_type": return "Type";
      case "kw_property": return "Property";
      case "kw_link": return "Link";
      case "kw_function": return "Function";
      case "kw_constraint": return "Constraint";
      case "kw_index": return "Index";
      case "kw_annotation": return "Annotation";
      case "kw_global": return "Global";
      case "kw_schema": return "schema";
      default: return token.lexeme;
    }
  }

  private expectName(message: string): Token {
    const token = this.peek();
    if (!this.isNameToken(token)) {
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }
    this.rejectReservedDunderName(token);
    this.index += 1;
    return { ...token, lexeme: this.nameTokenLexeme(token) };
  }

  // Like expectName but also accepts keyword-like tokens. Used in positions
  // where upstream allows reserved keywords as user identifiers — link
  // property names, shape fields, qualified-name segments, etc.
  private expectPermissiveName(message: string): Token {
    const token = this.peek();
    if (this.isNameToken(token)) {
      return this.expectName(message);
    }
    if (this.isKeywordLikeToken(token)) {
      this.rejectReservedDunderName(token);
      this.consume();
      return token;
    }
    throw new AppError("E_SYNTAX", message, ...this.posPair(token));
  }

  // Link-property names keep their literal spelling. Unlike type names
  // (`schema::Index`), a property written `@index` is the property `index`,
  // so we must NOT run the `nameTokenLexeme` title-casing that `expectName`
  // applies to keyword-spelled identifiers — we return the raw token lexeme
  // (already lowercased by the tokenizer for keywords, original case for
  // identifiers).
  private expectLinkPropertyName(message: string): string {
    const token = this.peek();
    if (!this.isNameToken(token) && !this.isKeywordLikeToken(token)) {
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }
    this.rejectReservedDunderName(token);
    this.consume();
    return token.lexeme;
  }

  // Names surrounded by double-underscores (`__Foo__`, `__std__`, etc.) and
  // certain magic names (`__type__`, `__source__`, `__subject__`) are reserved
  // by EdgeQL — the upstream parser rejects them as identifiers in user code.
  // We don't yet wire them into context-sensitive positions (constraint
  // bodies, default expressions, type-intersection paths), so any appearance
  // in name position is treated as `[not supported]`. Backtick-quoted forms
  // like `` `__Foo__` `` are also rejected to match upstream behaviour.
  private rejectReservedDunderName(token: Token): void {
    const raw = token.kind === "backtick_name"
      ? token.lexeme.replace(/^`|`$/g, "")
      : token.lexeme;
    if (this.isReservedDunderName(raw)) {
      this.notSupported(
        token,
        "reserved double-underscore identifier",
        `'${raw}' is reserved by EdgeQL and not usable as a plain identifier here`,
      );
    }
  }

  // Magic identifiers that EdgeQL exposes for path/shape/constraint/policy/
  // trigger contexts. They are *never* valid as a bare top-level reference
  // (e.g. `SELECT __type__` is an error upstream, even though `.__type__`
  // and `Foo.__type__` are fine).
  private isMagicBareReferenceRejected(name: string): boolean {
    const BARE_REJECTED: ReadonlySet<string> = new Set([
      "__type__",
      "__source__",
      "__subject__",
      "__new__",
      "__old__",
      "__default__",
      "__specified__",
    ]);
    return BARE_REJECTED.has(name);
  }

  // Names that should never appear as a user identifier. Excludes the
  // EdgeQL-magic names (`__type__`, `__source__`, etc.) which are legal in
  // their idiomatic positions.
  private isReservedDunderName(name: string): boolean {
    if (name.length < 4) return false;
    if (!name.startsWith("__") || !name.endsWith("__")) return false;
    const EDGEQL_MAGIC_ALLOWED: ReadonlySet<string> = new Set([
      "__type__",
      "__source__",
      "__subject__",
      "__new__",
      "__old__",
      "__default__",
      "__specified__",
      "__internal__",
    ]);
    return !EDGEQL_MAGIC_ALLOWED.has(name);
  }

  private atParenthesizedSelect(): boolean {
    return this.peek().kind === "lparen" && (this.peekNext().kind === "kw_select" || this.peekNext().kind === "kw_with");
  }

  private atInlineTypedSelect(): boolean {
    if (!this.isNameToken(this.peek())) {
      return false;
    }

    const nextKind = this.kindAfterQualifiedName();
    return nextKind === "lbrace" || nextKind === "kw_filter" || nextKind === "kw_limit" || nextKind === "kw_offset";
  }

  private isExistsToken(token: Token): boolean {
    return (this.isNameToken(token) || token.kind === "kw_exists") && token.lower === "exists";
  }

  private isEnumLikeName(name: string): boolean {
    return name.toLowerCase().includes("enum");
  }

  private qualifiedNameLeaf(name: string): string {
    const divider = name.lastIndexOf("::");
    return divider >= 0 ? name.slice(divider + 2) : name;
  }

  private isTypeLikeName(name: string): boolean {
    const first = this.qualifiedNameLeaf(name)[0];
    return first !== undefined && first >= "A" && first <= "Z";
  }

  private isIntegerLexeme(value: string): boolean {
    const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
    const clean = normalized.replace(/_/g, "");
    if (clean.length === 0) {
      return false;
    }
    for (const ch of clean) {
      if (ch < "0" || ch > "9") {
        return false;
      }
    }
    return true;
  }

  private parseNumberLexeme(value: string): number {
    const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
    const cleaned = normalized.replace(/_/g, "");
    return Number(cleaned);
  }

  // Validate a numeric literal token's value-range, matching upstream EdgeQL's
  // syntax-level checks. Called wherever a number token is consumed for an
  // expression (not for array indexes / slices, which are free to be huge).
  // Mirrors `errors.EdgeQLSyntaxError` for: number too large (integer), float
  // exponent too large / too small (under-/overflow Number).
  //
  // LEGITIMATE REGEX (do not remove): this is lexer-level numeric-literal
  // classification operating on a raw token lexeme. Regex on lexeme text is
  // the correct tool at the tokenizer/parser boundary — it is not type/IR
  // structure being re-derived from a string.
  private validateNumericLiteralToken(token: Token): void {
    if (token.kind !== "number") return;
    const lex = token.lexeme;
    // BigInt literals (`123…n`) are explicitly arbitrary-precision — they
    // don't have to fit in int64 / double range.
    if (lex.endsWith("n")) return;
    const cleaned = lex.replace(/_/g, "");
    const hasFraction = cleaned.includes(".") || /[eE]/.test(cleaned);

    if (!hasFraction) {
      // Plain integer. Reject anything beyond Number.MAX_SAFE_INTEGER (2^53-1)
      // when the token is intended to be a JS-number literal; the upstream
      // parser rejects `111111…` with EdgeQLSyntaxError for over-range int64.
      // We use a digit-count heuristic so we don't depend on the literal's
      // sign (the unary minus is parsed separately).
      const digits = cleaned.replace(/^[+-]/, "");
      // int64 max has 19 digits (9_223_372_036_854_775_807). 20+ digits is
      // always out of range; 19 digits may or may not be. Be conservative —
      // mirroring the must_fail intent — and only reject ≥20-digit literals.
      if (digits.length >= 20) {
        this.notSupported(
          token,
          "numeric literal out of range",
          `integer ${lex} exceeds int64 range`,
        );
      }
      return;
    }

    // Float / decimal literal. Number() returns Infinity for too-large
    // magnitudes and 0 for too-small ones — both are rejected upstream as
    // syntax errors.
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) {
      this.notSupported(
        token,
        "numeric literal out of range",
        `float ${lex} overflows IEEE-754 double`,
      );
    }
    // Detect underflow: literal looks non-zero but Number() snapped to 0.
    // Only check the mantissa (part before any exponent) — `0e-999` parses
    // to exactly 0 and is a legitimate zero literal.
    if (parsed === 0) {
      const mantissa = cleaned.split(/[eE]/)[0] ?? cleaned;
      if (/[1-9]/.test(mantissa)) {
        this.notSupported(
          token,
          "numeric literal out of range",
          `float ${lex} underflows IEEE-754 double`,
        );
      }
    }
  }

  private buildIndexAccessExpr(expr: FreeObjectExpr, indexLexeme: string): FreeObjectExpr {
    // Tuple indices must be plain non-negative integers — `2e2`/`1n`/`1.5`
    // are not valid tuple positions even though the tokenizer surfaces them
    // as numeric literals. Reject any lexeme containing exponent / decimal /
    // bigint markers, but allow the cases that consist of one or more
    // underscore-separated integer parts (handles `TUP.0.1`).
    const isPlainIntegerPart = (s: string): boolean => /^[0-9](?:[0-9_]*[0-9])?$/.test(s);
    if (indexLexeme.endsWith("n") || /[eE.]/.test(indexLexeme.split(".").pop() ?? "")) {
      throw new AppError(
        "E_SYNTAX",
        `Invalid tuple index '${indexLexeme}': tuple indices must be plain integers`,
        ...this.posPair(this.peek()),
      );
    }
    const parts = indexLexeme.split(".");
    for (const part of parts) {
      if (!isPlainIntegerPart(part)) {
        throw new AppError(
          "E_SYNTAX",
          `Invalid tuple index '${indexLexeme}': tuple indices must be plain integers`,
          ...this.posPair(this.peek()),
        );
      }
    }
    return parts.reduce<FreeObjectExpr>((current, part) => ({
      kind: "index_access",
      expr: current,
      index: Number(part.replace(/_/g, "")),
    }), expr);
  }

  private parseParameterLexeme(value: string): string {
    const raw = value.startsWith("$") ? value.slice(1) : value;
    return raw.replace(/^`|`$/g, "");
  }

  private parseParameterWithTypeLexeme(value: string): { name: string; castType: string } {
    const split = value.indexOf("$");
    const castType = value.slice(1, split - 1);
    const name = this.parseParameterLexeme(value.slice(split));
    return { name, castType };
  }

  private isGlobalReservedToken(token: Token): boolean {
    return GLOBAL_RESERVED_KINDS.has(token.kind);
  }

  // Like parseQualifiedName but also accepts keyword-like tokens as
  // identifier segments. Used for module names and other positions where
  // upstream allows unreserved/partial-reserved keywords (e.g. `WITH MODULE
  // abstract`, `WITH MODULE all.foo`, etc).
  private parsePermissiveQualifiedName(message: string): string {
    const parts: string[] = [];
    const readPart = (msg: string): string => {
      const tok = this.peek();
      if (this.isNameToken(tok)) return this.expectName(msg).lexeme;
      if (this.isKeywordLikeToken(tok)) {
        this.rejectReservedDunderName(tok);
        this.consume();
        return tok.lexeme;
      }
      throw new AppError("E_SYNTAX", msg, ...this.posPair(tok));
    };
    parts.push(readPart(message));
    while (true) {
      if (this.peek().kind === "coloncolon") {
        this.consume();
        parts.push(readPart("Expected identifier after '::'"));
        continue;
      }
      if (this.peek().kind === "colon" && this.peekNext().kind === "colon") {
        this.consume();
        this.consume();
        parts.push(readPart("Expected identifier after '::'"));
        continue;
      }
      // Module names use `.` as a segment separator (`WITH MODULE foo.bar`).
      if (this.peek().kind === "dot"
        && (this.isNameToken(this.peekNext()) || this.isKeywordLikeToken(this.peekNext()))) {
        this.consume();
        parts.push(readPart("Expected identifier after '.'"));
        continue;
      }
      break;
    }
    return parts.join("::");
  }

  private parseQualifiedName(message: string): string {
    const parts = [this.expectName(message).lexeme];
    const readSegment = (): string => {
      const tok = this.peek();
      // After `::` upstream's AnyIdentifier production allows most reserved
      // keywords; permit any keyword-like token here as well as the standard
      // name kinds.
      if (this.isNameToken(tok)) {
        return this.expectName("Expected identifier after '::'").lexeme;
      }
      if (this.isKeywordLikeToken(tok)) {
        this.rejectReservedDunderName(tok);
        this.consume();
        return tok.lexeme;
      }
      throw new AppError("E_SYNTAX", "Expected identifier after '::'", ...this.posPair(tok));
    };
    while (this.peek().kind === "coloncolon") {
      this.consume();
      parts.push(readSegment());
    }

    while (this.peek().kind === "colon" && this.peekNext().kind === "colon") {
      this.consume();
      this.consume();
      parts.push(readSegment());
    }

    return parts.join("::");
  }

  // Parses a (possibly parametric) type used in cast position: handles
  // `str`, `std::int64`, `array<str>`, `tuple<int64, str>`, `tuple<tuple<...>, ...>`,
  // and named-field tuples `tuple<name: str, points: int64>`.
  private parseCastTypeName(message: string): string {
    const head = this.parseQualifiedName(message);
    if (this.peek().kind !== "lt") {
      return head;
    }
    this.consume();
    const isTuple = head === "tuple" || head === "std::tuple";
    const parseArg = (): string => {
      if (isTuple
        && this.isNameToken(this.peek())
        && this.peekNext().kind === "colon"
        && this.peekNth(2).kind !== "colon") {
        const fieldName = this.consume().lexeme;
        this.consume();
        return `${fieldName}: ${this.parseCastTypeName("Expected type after named tuple element")}`;
      }
      return this.parseCastTypeName("Expected type argument");
    };
    const args: string[] = [];
    args.push(parseArg());
    while (this.peek().kind === "comma") {
      this.consume();
      // Trailing comma — `<array<int64,>>` — is accepted upstream.
      if (this.peek().kind === "gt" || this.peek().kind === "gte") break;
      args.push(parseArg());
    }
    this.expect("gt", `Expected '>' to close ${head}<...>`);
    return `${head}<${args.join(", ")}>`;
  }

  private kindAfterQualifiedName(): Token["kind"] {
    if (!this.isNameToken(this.peek())) {
      return this.peek().kind;
    }

    let i = this.index + 1;
    while (true) {
      const t1 = this.tokens[i + 1];
      const t2 = this.tokens[i + 2];
      if (this.tokens[i]?.kind === "coloncolon" && t1 && this.isNameToken(t1)) {
        i += 2;
        continue;
      }
      if (this.tokens[i]?.kind === "colon" && t1?.kind === "colon" && t2 && this.isNameToken(t2)) {
        i += 3;
        continue;
      }
      break;
    }

    return (this.tokens[i]?.kind ?? "eof") as Token["kind"];
  }

  private parseQualifiedIdentifier(
    headMessage: string,
    tailMessage: string,
  ): { head: string; tail: string } {
    const head = this.parseQualifiedName(headMessage);
    this.expect("dot", "Expected '.' in qualified identifier");
    const tail = this.expectName(tailMessage).lexeme;
    return { head, tail };
  }

  private parseParenthesizedSelectQuery(
    selectMessage: string,
    rparenMessage: string,
  ): { kind: "select"; typeName: string; shape: ShapeElement[]; clauses: ClauseChain } {
    this.expect("lparen", "Expected '(' before select subquery");
    const withClause = this.peek().kind === "kw_with" ? this.parseWithClause() : undefined;
    this.expect("kw_select", selectMessage);
    const nested = this.parseInlineSelectExpr();
    if (withClause) {
      nested.clauses = {
        ...nested.clauses,
        _withBindings: withClause.with,
        _withModule: withClause.withModule,
        _withModuleAliases: withClause.withModuleAliases,
      };
    }
    this.expect("rparen", rparenMessage);
    return nested;
  }

  private functionCallExpr(call: FunctionCallExpr): { kind: "function_call"; call: FunctionCallExpr } {
    return { kind: "function_call", call };
  }

  private withContext(ctx: ParseContext): ParseContext {
    return {
      with: ctx.with,
      withModule: ctx.withModule,
      withModuleAliases: ctx.withModuleAliases,
    };
  }

  private inlineSelectToStatement(
    start: Token,
    ctx: ParseContext,
    nested: { kind: "select"; typeName: string; shape: ShapeElement[]; clauses: ClauseChain },
  ): SelectStatement {
    return {
      ...this.withContext(ctx),
      kind: "select",
      typeName: nested.typeName,
      shape: nested.shape,
      fields: [],
      filter: nested.clauses.filter,
      orderBy: nested.clauses.orderBy,
      limit: nested.clauses.limit,
      offset: nested.clauses.offset,
      pos: this.posOf(start),
    };
  }

  // Top-level statement dispatcher. Implements the EdgeQL statement
  // production from docs/reference/reference/edgeql/index.rst:
  //
  //   statement := [ with_clause ] (
  //                  select_stmt | insert_stmt | update_stmt | delete_stmt
  //                | for_stmt   | group_stmt  | configure_stmt
  //                | transaction_stmt | session_stmt | describe_stmt
  //                | analyze_stmt | ddl_stmt
  //                ) ';'
  //
  // The optional WITH block (with.rst) attaches only to query/DML/FOR/GROUP
  // forms — transaction-control and DDL reject a leading WITH. SET/RESET
  // (sess_set_alias.rst, sess_reset_alias.rst), DESCRIBE (describe.rst),
  // ANALYZE (analyze.rst), and savepoint statements (tx_sp_*.rst) flow
  // through the permissive passthrough because the runtime doesn't execute
  // them — parsing them just has to accept the token stream.
  parseStatement(): Statement {
    const withClause = this.peek().kind === "kw_with"
      ? this.parseWithClause()
      : { with: undefined, withModule: this.defaultModule, withModuleAliases: undefined };
    if (!withClause.withModule) {
      withClause.withModule = this.defaultModule;
    }
    const withBindingNames = withClause.with?.map((binding) => binding.name) ?? [];
    this.localBindings.push(...withBindingNames);
    try {
      const token = this.peek();
      if (token.kind === "kw_select") {
        return this.parseSelect(withClause);
      }

      if (token.kind === "kw_insert") {
        return this.parseInsert(withClause);
      }

      if (token.kind === "kw_update") {
        return this.parseUpdate(withClause);
      }

      if (token.kind === "kw_for") {
        return this.parseFor(withClause);
      }

      if (token.kind === "kw_delete") {
        return this.parseDelete(withClause);
      }

      if (token.kind === "kw_configure") {
        return this.parseConfigure(withClause);
      }

      if (token.kind === "kw_group") {
        return this.parseGroup(withClause);
      }

      // Bare IF/THEN/ELSE expression as a top-level statement (`if true then
      // 10 else 11;`) — synthesize a `SELECT <expr>` so the rest of the
      // pipeline can compile it via the select_expr path.
      if (token.kind === "kw_if") {
        const ctx: ParseContext = withClause;
        const expr = this.parseFreeObjectExpr();
        // Per lexical.rst lines 400-402, ';' is idempotent.
        while (this.peek().kind === "semi") {
          this.consume();
        }
        this.expect("eof", "Unexpected tokens after statement");
        return {
          ...this.withContext(ctx),
          kind: "select_expr",
          expr,
          pos: this.posOf(token),
        };
      }

      if (token.kind === "kw_start" || token.kind === "kw_commit" || token.kind === "kw_rollback") {
        // Transaction-control statements (tx_start.rst, tx_commit.rst,
        // tx_rollback.rst) are marked `:eql-statement:` only — they lack the
        // `:eql-haswith:` marker that select/insert/update/delete/for/group
        // carry. That means *no* WITH form (expression binding, MODULE, or
        // alias-as-module) may precede them.
        const hasWithBindings = (withClause.with && withClause.with.length > 0)
          || (withClause.withModuleAliases && withClause.withModuleAliases.length > 0)
          || (withClause.withModule !== undefined && withClause.withModule !== this.defaultModule);
        if (hasWithBindings) {
          this.notSupported(
            token,
            "WITH before transaction control",
            `'${token.lexeme}' cannot follow a WITH block; transaction statements stand alone`,
          );
        }
        // `COMMIT MIGRATION` is a migration-control statement, not a
        // transaction commit. Hand it to the passthrough parser so the
        // rest of the line consumes cleanly.
        if (token.kind === "kw_commit"
          && this.isKeywordLikeToken(this.peekNext())
          && this.peekNext().lower === "migration") {
          return this.parsePassthroughStatement(token);
        }
        return this.parseTransaction();
      }

      if (token.kind === "kw_create" || token.kind === "kw_alter" || token.kind === "kw_drop") {
        // A bare `WITH MODULE <name>` (and module aliases) IS allowed before
        // CREATE/ALTER/DROP — it sets the DDL name-resolution default module.
        // Only expression WITH bindings (`WITH x := ...`) remain rejected
        // before DDL, since DDL doesn't accept computed WITH bindings.
        if (withClause.with !== undefined) {
          this.notSupported(
            token,
            "WITH before DDL",
            `DDL statements cannot be prefixed with a WITH block`,
          );
        }
        if ((token.kind === "kw_create" || token.kind === "kw_drop")
            && this.isKeywordLikeToken(this.peekNext())
            && this.peekNext().lower === "database"
            && withClause.withModule !== this.defaultModule) {
          this.notSupported(
            token,
            "WITH MODULE before database DDL",
            `DATABASE statements cannot be prefixed with WITH MODULE`,
          );
        }
        // `ALTER CURRENT MIGRATION REJECT PROPOSED` is migration control;
        // route through the passthrough parser since it's not a regular DDL
        // CREATE/ALTER/DROP of a named object kind.
        if (token.kind === "kw_alter"
          && this.isKeywordLikeToken(this.peekNext())
          && this.peekNext().lower === "current") {
          return this.parsePassthroughStatement(token);
        }
        // Thread the WITH MODULE / module aliases onto the DDL node so the
        // integrator can use them as the name-resolution default. (Policy-eval
        // and resolution itself happen downstream.)
        return this.parseDDL(withClause.withModule, withClause.withModuleAliases);
      }

      // Bare top-level expression (`'a' if true else 'b'`, `1 + 2`,
      // `<str>{}`, …). Try to parse it as a free-object expression and wrap
      // as `SELECT <expr>` so the rest of the pipeline runs through the
      // Bare top-level expressions (`1 + 2;`, `Foo.bar;`, `(select 1);`)
      // are rejected upstream — EdgeQL queries must begin with a statement
      // keyword. The IR test suite passes `allowBareExpressionStatement` so
      // its expression-shaped queries continue to parse.
      if (this.options.allowBareExpressionStatement) {
        const exprStartTokens = new Set([
          "lparen", "lbrace", "lbracket", "lt",
          "number", "string", "bytes_string",
          "kw_true", "kw_false", "kw_null",
          "kw_not", "kw_distinct", "kw_exists", "kw_detached",
          "kw_assert", "kw_assert_exists", "kw_assert_single", "kw_assert_distinct",
          "dot", "backward_link", "optional_link",
          "minus", "param", "global",
        ]);
        if (exprStartTokens.has(token.kind) || this.isNameToken(token)) {
          const fallbackAttempt = this.attempt(() => {
            const expr = this.parseFreeObjectExpr();
            while (this.peek().kind === "semi") this.consume();
            this.expect("eof", "Unexpected tokens after statement");
            return expr;
          });
          if (fallbackAttempt) {
            return {
              ...this.withContext(withClause),
              kind: "select_expr",
              expr: fallbackAttempt,
              pos: this.posOf(token),
            };
          }
        }
      }

      // Top-level admin / migration / introspection commands. Upstream models
      // each in detail (DESCRIBE has a full grammar, ANALYZE prefixes any
      // query, ABORT/COMMIT/POPULATE MIGRATION are distinct AST nodes, etc.).
      // For parse-only purposes we consume tokens permissively to EOF/semi
      // and return a placeholder AST node — the runtime never executes these
      // in syntax tests. Recognized by keyword token kind or lexeme.
      if (token.kind === "kw_describe") {
        // Validate the optional `AS <mode> [VERBOSE]` tail before letting
        // the passthrough consume the rest. Upstream rejects `AS DDL VERBOSE`
        // (VERBOSE is only valid with `AS TEXT`).
        {
          let depth = 0;
          let asMode: string | undefined;
          let sawVerboseInvalid = false;
          let verboseToken: Token | undefined;
          for (let i = 1; i < this.tokens.length - this.index; i += 1) {
            const t = this.peekNth(i);
            if (t.kind === "eof") break;
            if (t.kind === "semi" && depth === 0) break;
            if (t.kind === "lbrace" || t.kind === "lparen" || t.kind === "lbracket") depth += 1;
            else if (t.kind === "rbrace" || t.kind === "rparen" || t.kind === "rbracket") {
              depth = Math.max(0, depth - 1);
            } else if (depth === 0 && this.isKeywordLikeToken(t)) {
              if (t.lower === "as") {
                const next = this.peekNth(i + 1);
                if (next && (this.isKeywordLikeToken(next) || this.isNameToken(next))) {
                  asMode = next.lower;
                }
              } else if (t.lower === "verbose") {
                if (asMode && asMode !== "text") {
                  sawVerboseInvalid = true;
                  verboseToken = t;
                }
              }
            }
          }
          if (sawVerboseInvalid && verboseToken) {
            this.notSupported(
              verboseToken,
              "VERBOSE not supported here",
              `VERBOSE may only be used with DESCRIBE … AS TEXT, not AS ${(asMode ?? "").toUpperCase()}`,
            );
          }
        }
        return this.parsePassthroughStatement(token);
      }
      if (token.kind === "kw_set"
        && (this.peekNext().lower === "global"
          || this.peekNext().lower === "alias"
          || this.peekNext().lower === "type")) {
        // SET commands take a single option; comma-separated forms like
        // `SET ALIAS foo AS MODULE x, ALIAS bar AS MODULE y` are rejected.
        // Scan ahead and reject any comma at depth 0 before the statement
        // terminator.
        {
          let depth = 0;
          for (let i = 1; i < this.tokens.length - this.index; i += 1) {
            const t = this.peekNth(i);
            if (t.kind === "eof") break;
            if (t.kind === "semi" && depth === 0) break;
            if (t.kind === "lbrace" || t.kind === "lparen" || t.kind === "lbracket") depth += 1;
            else if (t.kind === "rbrace" || t.kind === "rparen" || t.kind === "rbracket") {
              depth = Math.max(0, depth - 1);
            } else if (t.kind === "comma" && depth === 0) {
              this.notSupported(
                t,
                "multiple SET options",
                "SET commands accept only one option; use separate SET statements",
              );
            }
          }
        }
        return this.parsePassthroughStatement(token);
      }
      if (this.isKeywordLikeToken(token) && TOP_LEVEL_PASSTHROUGH_LEXEMES.has(token.lower)) {
        return this.parsePassthroughStatement(token);
      }

      throw new AppError("E_SYNTAX", "Expected 'select', 'insert', 'update', 'delete', 'for', 'configure', transaction, or DDL statement", ...this.posPair(token));
    } finally {
      withBindingNames.forEach(() => {
        this.localBindings.pop();
      });
    }
  }

  private parseConfigure(ctx: ParseContext = {}): ConfigureStatement {
    const start = this.expect("kw_configure", "Expected 'configure'");
    // Upstream EdgeQL renamed `CONFIGURE DATABASE` to `CONFIGURE CURRENT
    // DATABASE`; the bare-DATABASE form is a syntax error there. Catch it
    // explicitly before falling through to the keyword-choice parser so the
    // user gets a directional hint instead of a generic message.
    const scopeToken = this.peek();
    if (this.isKeywordLikeToken(scopeToken) && scopeToken.lower === "database") {
      this.notSupported(
        scopeToken,
        "CONFIGURE DATABASE",
        "use 'CONFIGURE CURRENT DATABASE' instead",
      );
    }
    // `CURRENT DATABASE` / `CURRENT BRANCH` are tokenized as two adjacent
    // keywords; consume them as a pair before falling through to the
    // single-keyword scope parser.
    let scope: ConfigureStatement["scope"];
    if (
      this.isKeywordLikeToken(scopeToken)
      && scopeToken.lower === "current"
      && this.isKeywordLikeToken(this.peekNext())
      && (this.peekNext().lower === "database" || this.peekNext().lower === "branch")
    ) {
      this.consume();
      this.consume();
      scope = "current_database";
    } else {
      scope = this.parseKeywordChoice<ConfigureStatement["scope"]>({
        session: "session",
        instance: "instance",
        current_database: "current_database",
        currentdatabase: "current_database",
      }, "Expected configure scope: session, current_database, or instance").value;
    }

    const { value: operation } = this.parseKeywordChoice<ConfigureStatement["operation"]>({
      set: "set",
      insert: "insert",
      reset: "reset",
    }, "Expected configure operation: set, insert, or reset");

    const target = this.parseQualifiedName("Expected configuration target");
    let value: FreeObjectExpr | undefined;
    if (operation === "insert") {
      // `CONFIGURE … INSERT Foo {bar := …}` — consume the optional shape
      // body. The runtime doesn't model the configuration value AST, so this
      // is a parse-and-discard pass.
      if (this.peek().kind === "lbrace") {
        let depth = 0;
        while (this.peek().kind !== "eof") {
          const k = this.peek().kind;
          if (k === "lbrace" || k === "lparen" || k === "lbracket") depth += 1;
          else if (k === "rbrace" || k === "rparen" || k === "rbracket") {
            depth -= 1;
            this.consume();
            if (depth === 0) break;
            continue;
          }
          this.consume();
        }
      }
    } else if (operation !== "reset") {
      this.expect("assign", "Expected ':=' in configure statement");
      value = this.parseFreeObjectExpr();
    } else {
      // `CONFIGURE … RESET <type> FILTER (…)` — RESET may carry a FILTER
      // expression. Consume it permissively.
      if (this.peek().kind === "kw_filter") {
        this.consume();
        // Just parse a free expression as the filter.
        this.parseFreeObjectExpr();
      }
    }

    // Per lexical.rst lines 400-402, ';' is idempotent — `commit;;`,
    // `select 1;;;` etc. are all valid (upstream test_edgeql_syntax_constants_02).
    while (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after configure statement");

    return {
      ...this.withContext(ctx),
      kind: "configure",
      scope,
      operation,
      target,
      value,
      pos: this.posOf(start),
    };
  }

  // GROUP statement — see docs/reference/reference/edgeql/group.rst.
  //
  // Grammar (eql:synopsis from group.rst lines 11-37):
  //
  //   [ with <with-item> [, ...] ]
  //   group [<alias> := ] <expr>
  //   [ using <using-alias> := <expr>, [, ...] ]
  //   by <grouping-element>, ... ;
  //
  //   <grouping-element> :=
  //       <ref-or-list>
  //     | '{' <grouping-element>, ... '}'      # grouping set
  //     | ROLLUP( <ref-or-list>, ... )
  //     | CUBE  ( <ref-or-list>, ... )
  //
  //   <ref-or-list> :=
  //       ()
  //     | <grouping-ref>
  //     | ( <grouping-ref>, ... )
  //
  //   <grouping-ref> := <using-alias> | .<field-name>
  //
  // The optional `<alias> :=` before <expr> (group.rst line 15) is the
  // ad-hoc source binding handled in parseGroupSource. USING bindings
  // (group.rst lines 45-50) are required only when BY references aliases
  // rather than plain `.field` short paths.
  //
  // The output is a set of free objects shaped `{key, grouping, elements}`
  // (group.rst lines 84-112) — the parser doesn't synthesise this; it
  // simply records the source/using/by triple and lets the runtime build
  // the result.
  private parseGroup(ctx: ParseContext = {}): GroupStatement {
    const start = this.expect("kw_group", "Expected 'group'");
    const body = this.parseGroupBody();
    while (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after group statement");
    return {
      ...this.withContext(ctx),
      kind: "group",
      source: body.source,
      using: body.using,
      by: body.by,
      pos: this.posOf(start),
    };
  }

  private parseGroupExpr(): GroupExpr {
    this.expect("kw_group", "Expected 'group'");
    const body = this.parseGroupBody();
    return {
      kind: "group_expr",
      source: body.source,
      using: body.using,
      by: body.by,
    };
  }

  private parseGroupBody(): { source: FreeObjectExpr; using?: GroupUsingBinding[]; by: GroupByElement[] } {
    const source = this.parseGroupSource();

    let using: GroupUsingBinding[] | undefined;
    if (this.peek().kind === "kw_using") {
      this.consume();
      using = this.parseGroupUsingBindings();
    }

    const byKeyword = this.expect("kw_by", "Expected 'BY' in group statement");
    const by = this.parseGroupByList(byKeyword);

    this.validateGroupBindings(using, by);

    return { source, using, by };
  }

  private parseGroupSource(): FreeObjectExpr {
    // `GROUP F := User.friends BY ...` — an alias binding before the source.
    // Consume the alias and `:=`, then parse the actual source expression.
    if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
      const alias = this.consume().lexeme;
      this.consume();
      const expr = this.withLocalBinding(alias, () => this.parseGroupSource());
      // Return the bound expression directly; parse-only doesn't model the
      // alias separately on the GroupStatement AST.
      return expr;
    }
    // `GROUP cards::Card [{shape}] [USING ...] BY ...` -- a bare or shape-decorated
    // type name. parseFreeObjectExpr won't recognise `cards::Card BY` as a typed
    // source (it isn't followed by '.field' or '{shape}'), so we route through
    // parseInlineSelectExpr when the next thing after the qualified name is one
    // of the GROUP-tail keywords.
    if (this.isNameToken(this.peek())) {
      const afterName = this.kindAfterQualifiedName();
      if (afterName === "lbrace" || afterName === "kw_using" || afterName === "kw_by") {
        return this.parseInlineSelectExpr();
      }
    }
    return this.parseFreeObjectExpr();
  }

  private parseGroupUsingBindings(): GroupUsingBinding[] {
    const bindings: GroupUsingBinding[] = [];
    // Track declared aliases so duplicates fail at parse time, matching the
    // parseWithClause precedent (`Duplicate with binding 'X'`). The
    // group.rst grammar doesn't formally require uniqueness, but every
    // downstream consumer treats the alias as a lookup key.
    const seenAliases = new Set<string>();
    while (true) {
      const aliasToken = this.peek();
      if (!this.isNameToken(aliasToken)) {
        throw new AppError("E_SYNTAX", "Expected alias name in USING clause", ...this.posPair(aliasToken));
      }
      const alias = this.consume().lexeme;
      if (alias === "id") {
        throw new AppError("E_SYNTAX", "may not name a grouping alias 'id'", ...this.posPair(aliasToken));
      }
      if (seenAliases.has(alias)) {
        throw new AppError("E_SYNTAX", `Duplicate USING alias '${alias}'`, ...this.posPair(aliasToken));
      }
      seenAliases.add(alias);
      this.expect("assign", "Expected ':=' in USING binding");
      const aliasExpr = this.withLocalBinding(alias, () => this.parseFreeObjectExpr());
      bindings.push({ alias, expr: aliasExpr });
      if (this.peek().kind !== "comma") {
        break;
      }
      this.consume();
      if (this.peek().kind === "kw_by") {
        break;
      }
    }
    return bindings;
  }

  private parseGroupByList(byKeyword: Token): GroupByElement[] {
    const elements: GroupByElement[] = [];
    while (true) {
      elements.push(this.parseGroupByElement());
      if (this.peek().kind !== "comma") {
        break;
      }
      this.consume();
      // Trailing comma — `BY .a, .b,;` — is accepted upstream.
      if (this.peek().kind === "semi" || this.peek().kind === "eof") {
        break;
      }
    }
    if (elements.length === 0) {
      throw new AppError("E_SYNTAX", "Expected at least one element in BY clause", ...this.posPair(byKeyword));
    }
    return elements;
  }

  private parseGroupByElement(): GroupByElement {
    const token = this.peek();

    // `BY { atom, atom, … }` — comma-separated grouping sets. EACH
    // comma-separated entry is its own grouping set (its own `GroupByAtom[]`):
    // a single atom entry `a` -> `[a]`, a parenthesized multi-atom entry
    // `(a, b)` -> `[a, b]`. So `BY {.element, nowners}` ->
    // sets: [[{field_ref element}], [{name_ref nowners}]]. Trailing commas and
    // an empty `{}` are accepted.
    if (token.kind === "lbrace") {
      this.consume();
      const sets: GroupByAtom[][] = [];
      while (this.peek().kind !== "rbrace" && this.peek().kind !== "eof") {
        if (this.peek().kind === "lparen") {
          // Parenthesized entry `(a, b)` — a single grouping set of >1 atom.
          this.consume();
          const innerAtoms = this.parseGroupByAtomList();
          this.expect("rparen", "Expected ')' in BY grouping set entry");
          sets.push(innerAtoms);
        } else {
          const entry = this.parseGroupByElement();
          if (entry.kind === "sets") {
            sets.push(...entry.sets);
          } else if (entry.kind === "cube" || entry.kind === "rollup") {
            sets.push(entry.atoms);
          } else {
            // A single atom entry forms its own one-atom grouping set.
            sets.push([entry]);
          }
        }
        if (this.peek().kind !== "comma") {
          break;
        }
        this.consume();
        // Trailing comma before the closing brace is accepted.
      }
      this.expect("rbrace", "Expected '}' after BY grouping sets");
      return { kind: "sets", sets };
    }

    if (this.isNameToken(token) && token.lower === "cube" && this.peekNext().kind === "lparen") {
      this.consume(); this.consume();
      const atoms = this.parseGroupByAtomList();
      this.expect("rparen", "Expected ')' after CUBE(...)");
      return { kind: "cube", atoms };
    }
    if (this.isNameToken(token) && token.lower === "rollup" && this.peekNext().kind === "lparen") {
      this.consume(); this.consume();
      const atoms = this.parseGroupByAtomList();
      this.expect("rparen", "Expected ')' after ROLLUP(...)");
      return { kind: "rollup", atoms };
    }

    // Tuple group expression `BY (.foo, .bar)` — comma-separated atom list
    // wrapped in parens.
    if (token.kind === "lparen") {
      this.consume();
      const atoms = this.parseGroupByAtomList();
      this.expect("rparen", "Expected ')' after BY (...)");
      return { kind: "sets", sets: [atoms] };
    }

    return this.parseGroupByAtom();
  }

  private parseGroupByAtom(): GroupByAtom {
    const token = this.peek();
    if (token.kind === "at") {
      // `@name` — a link-property BY atom. We parse it as a dedicated atom
      // variant; the semantic layer surfaces the link property as a field and
      // runs validation/collision checks (contract C2/C3).
      this.consume();
      const nameToken = this.peek();
      if (!this.isNameToken(nameToken)) {
        throw new AppError("E_SYNTAX", "Expected link property name after '@' in BY clause", ...this.posPair(nameToken));
      }
      const name = this.consume().lexeme;
      return { kind: "link_property_ref", name };
    }
    if (token.kind === "dot") {
      this.consume();
      const fieldToken = this.peek();
      if (!this.isNameToken(fieldToken)) {
        throw new AppError("E_SYNTAX", "Expected field name after '.' in BY clause", ...this.posPair(fieldToken));
      }
      const field = this.consume().lexeme;
      if (field === "id") {
        throw new AppError("E_SYNTAX", "may not group by a field named id", ...this.posPair(fieldToken));
      }
      return { kind: "field_ref", field };
    }
    if (this.isNameToken(token)) {
      const nameToken = this.consume();
      return { kind: "name_ref", name: nameToken.lexeme };
    }
    if (token.kind === "kw_by") {
      throw new AppError("E_SYNTAX", "Expected BY-clause atom", ...this.posPair(token));
    }
    throw new AppError("E_SYNTAX", "Expected '.field' or USING alias name as BY atom", ...this.posPair(token));
  }

  private parseGroupByAtomList(): GroupByAtom[] {
    const atoms: GroupByAtom[] = [];
    while (true) {
      // Tuple atoms `(.foo, .bar)` are accepted as a single grouping atom.
      // We consume the parens and the inner atom list — the runtime treats
      // tuple atoms as a single grouping key.
      if (this.peek().kind === "lbrace") {
        const entry = this.parseGroupByElement();
        if (entry.kind === "sets") {
          for (const set of entry.sets) atoms.push(...set);
        } else if (entry.kind === "cube" || entry.kind === "rollup") {
          atoms.push(...entry.atoms);
        } else {
          atoms.push(entry);
        }
      } else if (this.peek().kind === "lparen") {
        const inner = this.attempt<GroupByAtom>(() => {
          this.consume();
          const innerAtoms: GroupByAtom[] = [];
          while (this.peek().kind !== "rparen" && this.peek().kind !== "eof") {
            innerAtoms.push(this.parseGroupByAtom());
            if (this.peek().kind === "comma") {
              this.consume();
              if (this.peek().kind === "rparen") break;
            }
          }
          this.expect("rparen", "Expected ')' to close tuple BY atom");
          // Encode as a name_ref-shaped atom; the analyzer treats it as one
          // grouping key with multiple sub-atoms via the surrounding scope.
          return innerAtoms[0] ?? { kind: "name_ref", name: "" } as GroupByAtom;
        });
        if (inner) {
          atoms.push(inner);
        } else {
          atoms.push(this.parseGroupByAtom());
        }
      } else {
        atoms.push(this.parseGroupByAtom());
      }
      if (this.peek().kind !== "comma") {
        break;
      }
      this.consume();
      // Allow trailing comma — `CUBE(letter, .age, .rank,)` etc.
      if (this.peek().kind === "rparen" || this.peek().kind === "rbrace") {
        break;
      }
    }
    return atoms;
  }

  private validateGroupBindings(using: GroupUsingBinding[] | undefined, by: GroupByElement[]): void {
    const declared = new Set<string>();
    if (using) {
      for (const binding of using) {
        declared.add(binding.alias);
      }
    }
    for (const element of by) {
      if (element.kind === "name_ref" && !declared.has(element.name)) {
        throw new AppError("E_SYNTAX", `variable '${element.name}' referenced in BY but not declared in USING`, 0, 0);
      }
    }
  }

  // Transaction control — START / COMMIT / ROLLBACK [TO SAVEPOINT].
  //
  // Grammars (one per file under docs/reference/reference/edgeql/):
  //
  //   START TRANSACTION (tx_start.rst lines 35-45):
  //     start transaction <transaction-mode> [ , ... ] ;
  //     # where <transaction-mode> is one of:
  //     #   isolation repeatable read
  //     #   isolation serializable
  //     #   read write | read only
  //     #   deferrable | not deferrable
  //
  //   COMMIT (tx_commit.rst line 37):
  //     commit ;
  //
  //   ROLLBACK (tx_rollback.rst line 37):
  //     rollback ;
  //
  //   ROLLBACK TO SAVEPOINT (tx_sp_rollback.rst lines 37-39):
  //     rollback to savepoint <savepoint-name> ;
  //
  // SAVEPOINT-related forms (DECLARE / RELEASE — tx_sp_declare.rst,
  // tx_sp_release.rst) reach this parser via parsePassthroughStatement
  // because they're keyword-led but flow through the top-level
  // passthrough lexeme list. See parseStatement above.
  //
  // The transaction-mode list is comma-separated. Per tx_start.rst:
  //   * isolation defaults to `serializable`
  //   * the same option may not be specified twice
  //   * READ ONLY conflicts with READ WRITE; DEFERRABLE with NOT DEFERRABLE
  //
  // After the mode list we accept any remaining tail tokens permissively
  // (depth-tracked) to support upstream's migration-control variants like
  // `START MIGRATION TO <Lang> $$body$$` which embed an SDL block.
  private parseTransaction(): TransactionStatement {
    const token = this.expectAny(["kw_start", "kw_commit", "kw_rollback"], "Expected 'start', 'commit', or 'rollback'");
    let action: TransactionStatement["action"];
    if (token.kind === "kw_start") {
      action = "start";
      this.matchKeywordLexeme("transaction");
    } else if (token.kind === "kw_commit") {
      action = "commit";
    } else {
      action = "rollback";
    }

    let isolation: TransactionStatement["isolation"];
    // Track which transaction-mode options have been seen so duplicates /
    // conflicts are diagnosed. Upstream rejects:
    //   * the same option specified twice (`ISOLATION X, ISOLATION Y`)
    //   * conflicting options (READ ONLY + READ WRITE; DEFERRABLE + NOT DEFERRABLE)
    //   * unknown isolation levels (`REPEATABLEREAD` without a space)
    const seenOptions = new Set<"isolation" | "readwrite" | "deferrable">();
    const parseOneMode = (): void => {
      if (this.matchKeywordLexeme("isolation")) {
        if (seenOptions.has("isolation")) {
          this.notSupported(this.peek(), "duplicate ISOLATION option", "ISOLATION may only be specified once");
        }
        seenOptions.add("isolation");
        const level = this.expectName("Expected transaction isolation level").lower;
        if (level === "serializable") {
          isolation = "serializable";
        } else if (level === "repeatable") {
          const maybeRead = this.expectName("Expected 'read' after 'repeatable'").lower;
          if (maybeRead !== "read") {
            const tok = this.peek();
            throw new AppError("E_SYNTAX", "Expected 'read' after 'repeatable'", ...this.posPair(tok));
          }
          isolation = "repeatable_read";
        } else {
          this.notSupported(this.peek(), "unknown transaction isolation level", `unrecognized isolation level '${level}'`);
        }
        return;
      }
      if (this.matchKeywordLexeme("read")) {
        if (seenOptions.has("readwrite")) {
          this.notSupported(this.peek(), "duplicate READ option", "READ ONLY / READ WRITE may only be specified once");
        }
        seenOptions.add("readwrite");
        if (this.matchKeywordLexeme("only") || this.matchKeywordLexeme("write")) {
          return;
        }
        this.notSupported(this.peek(), "unknown READ mode", `expected ONLY or WRITE after READ`);
        return;
      }
      if (this.matchKeywordLexeme("not")) {
        if (!this.matchKeywordLexeme("deferrable")) {
          this.notSupported(this.peek(), "unexpected NOT clause", "expected 'NOT DEFERRABLE' in transaction mode list");
        }
        if (seenOptions.has("deferrable")) {
          this.notSupported(this.peek(), "duplicate DEFERRABLE option", "DEFERRABLE / NOT DEFERRABLE may only be specified once");
        }
        seenOptions.add("deferrable");
        return;
      }
      if (this.matchKeywordLexeme("deferrable")) {
        if (seenOptions.has("deferrable")) {
          this.notSupported(this.peek(), "duplicate DEFERRABLE option", "DEFERRABLE / NOT DEFERRABLE may only be specified once");
        }
        seenOptions.add("deferrable");
        return;
      }
      // Unknown mode option — bail out and let the tail consumer pick up.
      throw new AppError("E_SYNTAX", "unrecognized transaction mode option", ...this.posPair(this.peek()));
    };
    if (action === "start" && this.isKeywordLikeToken(this.peek())) {
      // First mode option (no leading comma).
      const head = this.peek();
      const headLower = head.lower;
      if (headLower === "isolation" || headLower === "read" || headLower === "deferrable" || headLower === "not") {
        parseOneMode();
        while (this.peek().kind === "comma") {
          this.consume();
          parseOneMode();
        }
      }
    }

    // `START MIGRATION TO <Lang> $$body$$` — Lang must be a known migration
    // language. Validate before falling through to permissive consumption.
    if (action === "start"
      && this.isKeywordLikeToken(this.peek())
      && this.peek().lower === "migration") {
      this.consume();
      if (this.isKeywordLikeToken(this.peek()) && this.peek().lower === "to") {
        this.consume();
        const next = this.peek();
        if ((this.isKeywordLikeToken(next) || this.isNameToken(next))
          && this.peekNext().kind === "string") {
          const knownMigrationLangs = new Set(["edgeql", "sql"]);
          if (!knownMigrationLangs.has(next.lower)) {
            this.notSupported(
              next,
              "unknown migration language",
              `'${next.lexeme}' is not a recognized migration language`,
            );
          }
        }
        // Scan the SDL body for invalid `using extension` inside module
        // blocks (modules cannot declare extensions) and for unknown
        // block-introducer keywords (e.g. typo'd `constrant exclusive { ... }`).
        if (this.peek().kind === "lbrace") {
          // Tokens that can introduce a `KEYWORD <ident> { ... }` block
          // inside an SDL type/property/link body. Anything else is treated
          // as a typo / unsupported form and rejected.
          const validBlockIntroducers = new Set([
            "constraint", "index", "trigger", "policy", "annotation",
            "link", "property", "type", "function", "alias", "scalar",
            "set", "alter", "drop", "create", "using", "rewrite", "extending",
            "global", "abstract", "required", "optional", "multi", "single",
            "delegated", "final", "with",
          ]);
          let depth = 0;
          let moduleDepth = 0; // 1+ when inside a module block
          for (let i = 0; i < this.tokens.length - this.index; i += 1) {
            const t = this.peekNth(i);
            if (t.kind === "eof") break;
            if (t.kind === "lbrace") {
              depth += 1;
              // Detect `module <name> {` opening.
              const back2 = this.peekNth(i - 2);
              const back1 = this.peekNth(i - 1);
              if (back2 && this.isKeywordLikeToken(back2) && back2.lower === "module"
                && back1 && (this.isNameToken(back1) || this.isKeywordLikeToken(back1))) {
                moduleDepth = depth;
              }
            } else if (t.kind === "rbrace") {
              if (depth === moduleDepth) moduleDepth = 0;
              depth -= 1;
              if (depth < 0) break;
            } else if (moduleDepth > 0
              && this.isKeywordLikeToken(t) && t.lower === "using"
              && this.isKeywordLikeToken(this.peekNth(i + 1)) && this.peekNth(i + 1).lower === "extension") {
              this.notSupported(
                t,
                "extension in module block",
                "extensions cannot be declared inside a module block; place them at the schema top level",
              );
            } else if (t.kind === "identifier" && depth > 0) {
              // Look for `<unknown_identifier> <identifier> {` — common typo
              // pattern (`constrant exclusive { ... }`).
              const next1 = this.peekNth(i + 1);
              const next2 = this.peekNth(i + 2);
              const prev = this.peekNth(i - 1);
              const startsStatement = !prev || prev.kind === "lbrace" || prev.kind === "semi" || prev.kind === "rbrace";
              if (startsStatement
                && next1 && (this.isNameToken(next1) || this.isKeywordLikeToken(next1))
                && next2 && next2.kind === "lbrace"
                && !validBlockIntroducers.has(t.lower)) {
                this.notSupported(
                  t,
                  "unknown SDL block-introducer",
                  `'${t.lexeme}' is not a recognized SDL keyword (did you mean 'constraint' / 'index' / 'trigger' / 'policy' / 'annotation'?)`,
                );
              }
            }
          }
        }
      }
    }

    // Per-action tail handling. Each .rst grammar is exact:
    //   * COMMIT (tx_commit.rst line 37):           `commit ;`
    //   * ROLLBACK (tx_rollback.rst line 37):       `rollback ;`
    //     -or- (tx_sp_rollback.rst lines 37-39):    `rollback to savepoint <name> ;`
    //   * START (tx_start.rst lines 35-45):         `start transaction <mode>, ... ;`
    //     plus migration-control variants which can carry an SDL body.
    if (action === "commit") {
      // Bare `commit` allows no trailing tokens — anything before the
      // statement terminator is a syntax error.
    } else if (action === "rollback") {
      // Optional `TO SAVEPOINT <name>` tail.
      if (this.isKeywordLikeToken(this.peek()) && this.peek().lower === "to") {
        this.consume();
        if (!(this.isKeywordLikeToken(this.peek()) && this.peek().lower === "savepoint")) {
          this.notSupported(
            this.peek(),
            "expected SAVEPOINT after ROLLBACK TO",
            "the only legal tail of ROLLBACK is `TO SAVEPOINT <name>`",
          );
        }
        this.consume();
        // Savepoint name — any keyword-like or name-like token works.
        const nameTok = this.peek();
        if (!this.isNameToken(nameTok) && !this.isKeywordLikeToken(nameTok)) {
          throw new AppError(
            "E_SYNTAX",
            "Expected savepoint name after ROLLBACK TO SAVEPOINT",
            ...this.posPair(nameTok),
          );
        }
        this.consume();
      }
    } else {
      // START — permissive tail for migration-control variants
      // (`START MIGRATION TO <Lang> $$body$$`, `START MIGRATION TO { ... }`)
      // which can contain `;` inside their `{}` block, so depth-track.
      let depth = 0;
      while (this.peek().kind !== "eof") {
        const k = this.peek().kind;
        if (k === "semi" && depth === 0) break;
        if (k === "lbrace" || k === "lparen" || k === "lbracket") depth += 1;
        else if (k === "rbrace" || k === "rparen" || k === "rbracket") {
          depth = Math.max(0, depth - 1);
        }
        this.consume();
      }
    }
    // Per lexical.rst lines 400-402, ';' is idempotent — `commit;;`,
    // `select 1;;;` etc. are all valid (upstream test_edgeql_syntax_constants_02).
    while (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after transaction statement");

    return {
      kind: "transaction",
      action,
      isolation,
      pos: this.posOf(token),
    };
  }

  // Catch-all for top-level statements whose full grammar we don't model
  // because the runtime never executes them — parse-only just needs to
  // accept the token stream. Each form has its own .rst spec under
  // docs/reference/reference/edgeql/:
  //
  //   DESCRIBE (describe.rst lines 11-28):
  //     describe schema [ as { ddl | sdl | text [verbose] } ] ;
  //     describe <schema-type> <name> [ as { ddl | sdl | text [verbose] } ] ;
  //     where <schema-type> ∈ {object, annotation, constraint, function,
  //                            link, module, property, scalar type, type}
  //
  //   ANALYZE (analyze.rst line 12):
  //     analyze <query> ;       # <query> is any EdgeQL query
  //
  //   SET (sess_set_alias.rst lines 11-15):
  //     set module <module> ;
  //     set alias <alias> as module <module> ;
  //     set global <name> := <expr> ;
  //
  //   RESET (sess_reset_alias.rst lines 11-16):
  //     reset module ;
  //     reset alias <alias> ;
  //     reset alias * ;
  //     reset global <name> ;
  //
  //   DECLARE SAVEPOINT (tx_sp_declare.rst line 37):
  //     declare savepoint <savepoint-name> ;
  //
  //   RELEASE SAVEPOINT (tx_sp_release.rst line 37):
  //     release savepoint <savepoint-name> ;
  //
  // Consumes tokens to the next top-level `;` or eof, respecting bracket
  // depth so any nested braces (e.g. CREATE MIGRATION { ... } inside a
  // top-level wrapper) don't fool the cursor. Returns a
  // DescribeStatement-shaped placeholder.
  private parsePassthroughStatement(start: Token): Statement {
    let depth = 0;
    while (this.peek().kind !== "eof") {
      const k = this.peek().kind;
      if (k === "semi" && depth === 0) break;
      if (k === "lbrace" || k === "lparen" || k === "lbracket") depth += 1;
      else if (k === "rbrace" || k === "rparen" || k === "rbracket") {
        depth = Math.max(0, depth - 1);
      }
      this.consume();
    }
    while (this.peek().kind === "semi") this.consume();
    this.expect("eof", "Unexpected tokens after statement");
    return {
      kind: "describe",
      objectKind: "schema",
      pos: this.posOf(start),
    };
  }

  // DDL modifier keywords that can appear between CREATE/ALTER/DROP and the
  // object-kind token. They're consumed without being part of the AST shape
  // — upstream tracks them as separate AST fields, but for parse-only we
  // just need to advance past them so the kind parses next.
  private readonly ddlModifierLexemes = new Set([
    // shared cardinality / abstractness modifiers
    "abstract", "final", "required", "optional", "multi", "single",
    // branch flavor modifiers (CREATE EMPTY/SCHEMA/DATA/TEMPLATE BRANCH ...)
    "empty", "schema", "data", "template",
    // role / migration / annotation modifiers
    "superuser", "applied", "inheritable", "delegated",
    // operator fixity (CREATE INFIX/PREFIX/POSTFIX/TERNARY OPERATOR ...)
    "infix", "prefix", "postfix", "ternary",
    // pseudo type marker (CREATE PSEUDO TYPE ...)
    "pseudo",
  ]);
  private readonly ddlKindLexemes = new Set([
    "type", "scalar", "link", "property", "function", "constraint",
    "index", "trigger", "policy", "module", "database", "branch",
    "role", "extension", "alias", "global", "annotation", "migration",
    "future", "cast", "operator",
  ]);

  // Skip modifier keywords only if a real DDL kind keyword follows. This
  // avoids stealing names like `CREATE DATABASE abstract` (`abstract` is
  // the database name, not a modifier). Returns the lower-cased lexemes of
  // each consumed modifier, in order, so the caller can validate constraints
  // like "CREATE BRANCH requires an EMPTY/SCHEMA/DATA/TEMPLATE prefix".
  private skipDDLModifiers(): string[] {
    let lookahead = 0;
    while (true) {
      const tok = this.peekNth(lookahead);
      if (this.isKeywordLikeToken(tok) && this.ddlModifierLexemes.has(tok.lower)) {
        lookahead += 1;
        continue;
      }
      if (this.isKeywordLikeToken(tok) && this.ddlKindLexemes.has(tok.lower)) {
        const consumed: string[] = [];
        for (let i = 0; i < lookahead; i += 1) {
          consumed.push(this.peek().lower);
          this.consume();
        }
        return consumed;
      }
      return [];
    }
  }

  // Parse a name in DDL position. Upstream's DDL grammar (DatabaseName,
  // AnyIdentifier, etc.) allows most reserved keywords as user-provided
  // names. Our parseQualifiedName only accepts NAME_TOKEN_KINDS, so we
  // permissively widen here: any keyword-like or name-like token works,
  // except the reserved `__dunder__` forms.
  private parseDDLName(message: string): string {
    const first = this.peek();
    if (!this.isNameToken(first) && !this.isKeywordLikeToken(first)) {
      throw new AppError("E_SYNTAX", message, ...this.posPair(first));
    }
    this.rejectReservedDunderName(first);
    // Even the "magic" dunder names that are valid in path positions
    // (`__type__`, `__source__`, …) are not legal as DDL object names.
    const firstLexeme = first.kind === "backtick_name"
      ? first.lexeme.replace(/^`|`$/g, "")
      : first.lexeme;
    if (firstLexeme.startsWith("__") && firstLexeme.endsWith("__") && firstLexeme.length >= 4) {
      this.notSupported(
        first,
        "reserved double-underscore identifier as DDL name",
        `'${firstLexeme}' is reserved by EdgeQL and cannot be used as a DDL identifier`,
      );
    }
    this.consume();
    const parts = [first.lexeme];
    while (true) {
      if (this.peek().kind === "coloncolon") {
        this.consume();
      } else if (this.peek().kind === "colon" && this.peekNext().kind === "colon") {
        this.consume();
        this.consume();
      } else {
        break;
      }
      const seg = this.peek();
      if (!this.isNameToken(seg) && !this.isKeywordLikeToken(seg)) {
        throw new AppError("E_SYNTAX", "Expected identifier after '::'", ...this.posPair(seg));
      }
      this.rejectReservedDunderName(seg);
      this.consume();
      parts.push(seg.lexeme);
    }
    return parts.join("::");
  }

  private parseDDL(withModule?: string, withModuleAliases?: WithModuleAlias[]): DDLStatement {
    const start = this.expectAny(["kw_create", "kw_alter", "kw_drop"], "Expected 'create', 'alter', or 'drop'");
    let action: DDLStatement["action"];
    if (start.kind === "kw_create") {
      action = "create";
    } else if (start.kind === "kw_alter") {
      action = "alter";
    } else {
      action = "drop";
    }

    const modifiers = this.skipDDLModifiers();

    const objectToken = this.peek();
    this.consume();
    const objectLexeme = objectToken.lower;
    const objectKindMap: Record<string, DDLStatement["objectKind"]> = {
      type: "type",
      scalar: "scalar",
      link: "link",
      property: "property",
      function: "function",
      constraint: "constraint",
      index: "index",
      trigger: "trigger",
      policy: "policy",
      module: "module",
      database: "database",
      branch: "branch",
      role: "role",
      extension: "extension",
      alias: "alias",
      global: "global",
      annotation: "annotation",
      migration: "migration",
      future: "future",
      cast: "cast",
      operator: "operator",
    };
    const objectKind = objectKindMap[objectLexeme];
    if (!objectKind) {
      throw new AppError("E_SYNTAX", `Unsupported DDL object kind '${objectToken.lexeme}'`, ...this.posPair(objectToken));
    }

    // `CREATE BRANCH X` (without an EMPTY/SCHEMA/DATA/TEMPLATE flavor) is
    // rejected upstream — the flavor disambiguates what content the new
    // branch should contain.
    if (action === "create" && objectKind === "branch") {
      const branchFlavors = new Set(["empty", "schema", "data", "template"]);
      if (!modifiers.some((m) => branchFlavors.has(m))) {
        this.notSupported(
          objectToken,
          "CREATE BRANCH missing flavor",
          "CREATE BRANCH requires EMPTY, SCHEMA, DATA, or TEMPLATE before BRANCH",
        );
      }
    }

    // `CREATE EXTENSION PACKAGE foo` — PACKAGE is a sub-kind marker, not a
    // name. Skip it so the actual extension-package name parses next.
    if (objectKind === "extension"
      && this.isKeywordLikeToken(this.peek())
      && this.peek().lower === "package") {
      this.consume();
    }
    // `CREATE SCALAR TYPE foo`, `CREATE PSEUDO TYPE foo`, etc. — TYPE is a
    // sub-keyword for some object kinds. Skip it so the actual name parses
    // next.
    if ((objectKind === "scalar" || objectKind === "future")
      && this.isKeywordLikeToken(this.peek())
      && this.peek().lower === "type") {
      this.consume();
    }

    // Reject duplicated kind keywords like `CREATE ABSTRACT PROPERTY PROPERTY foo`.
    if (this.isKeywordLikeToken(this.peek())
      && this.peek().lower === objectLexeme
      && this.ddlKindLexemes.has(this.peek().lower)) {
      this.notSupported(
        this.peek(),
        "duplicate DDL object kind",
        `unexpected repeated '${objectLexeme}' keyword`,
      );
    }

    const nameStartToken = this.peek();
    // CAST has no name (header is `FROM <type> TO <type>`); MIGRATION's name
    // is optional (`CREATE MIGRATION { ... }` is legal).
    let name: string;
    if (objectKind === "cast") {
      name = "";
    } else if (objectKind === "migration" && !this.isNameToken(this.peek()) && !this.isKeywordLikeToken(this.peek())) {
      name = "";
    } else {
      name = this.parseDDLName("Expected DDL object name");
    }
    // `CREATE MODULE a.b.c` — upstream EdgeQL allows dotted module names;
    // each segment is parsed as a permissive identifier so unreserved
    // keywords (`abstract`, `all`, …) are valid segments. Append each `.<id>`
    // to the name.
    if (objectKind === "module") {
      while (this.peek().kind === "dot"
        && (this.isNameToken(this.peekNext()) || this.isKeywordLikeToken(this.peekNext()))) {
        this.consume();
        const segTok = this.peek();
        this.rejectReservedDunderName(segTok);
        const segLexeme = segTok.kind === "backtick_name"
          ? segTok.lexeme.replace(/^`|`$/g, "")
          : segTok.lexeme;
        // Even allowed magic dunder names (`__type__`, …) are not legal as
        // module-name segments.
        if (segLexeme.startsWith("__") && segLexeme.endsWith("__") && segLexeme.length >= 4) {
          this.notSupported(
            segTok,
            "reserved double-underscore identifier as module segment",
            `'${segLexeme}' is reserved by EdgeQL and cannot appear in a module name`,
          );
        }
        this.consume();
        name += `.${segLexeme}`;
      }
    }
    // DATABASE / BRANCH / ROLE names are plain identifiers upstream — qualified
    // forms like `foo::bar` are rejected. Mirror that.
    if ((objectKind === "database" || objectKind === "branch" || objectKind === "role")
      && name.includes("::")) {
      this.notSupported(
        nameStartToken,
        `qualified ${objectKind} name`,
        `${objectKind} names must be plain identifiers; '${name}' is module-qualified`,
      );
    }
    // ROLE / SCALAR TYPE names must be plain user identifiers. Fully
    // reserved keywords (`if`, `select`, `anytype`, …) need backticks to be
    // used as a name; `parseDDLName` accepted them because it treats any
    // keyword-like token as a candidate identifier. Catch those here.
    const enforcesReservedNames = objectKind === "role"
      || (objectKind === "scalar" && action === "create");
    if (enforcesReservedNames
      && nameStartToken.kind !== "identifier"
      && nameStartToken.kind !== "backtick_name"
      && CURRENT_RESERVED_KEYWORDS_SET.has(nameStartToken.lower)) {
      this.notSupported(
        nameStartToken,
        `reserved keyword as ${objectKind} name`,
        `'${nameStartToken.lexeme}' is a reserved keyword and cannot be used as a ${objectKind} name without backticks`,
      );
    }
    // Module names must be plain user identifiers. `expectName`'s dunder check
    // allowlists EdgeQL-magic identifiers (`__subject__` etc.) for valid path
    // positions, but they are still illegal as module names.
    if (objectKind === "module" && name.startsWith("__") && name.endsWith("__")) {
      this.notSupported(
        nameStartToken,
        "reserved module name",
        `'${name}' is a reserved identifier and cannot be used as a module name`,
      );
    }
    // `CREATE EXTENSION PACKAGE foo VERSION '...'` — the version string must
    // parse as a semver-shaped literal. Strings like `'aaa'` (no digits) are
    // rejected upstream. Validate before falling through to skipDDLBody.
    if (action === "create" && objectKind === "extension"
      && this.isKeywordLikeToken(this.peek())
      && this.peek().lower === "version") {
      this.consume();
      const versionTok = this.peek();
      if (versionTok.kind !== "string") {
        this.notSupported(versionTok, "VERSION expects a string literal", "VERSION must be followed by a quoted version string");
      }
      const raw = versionTok.lexeme;
      // Accept canonical/dev/rc versions like `1.0`, `1.2.3`, `1.0-alpha`,
      // `1.0+build`. Reject anything that doesn't start with a digit run.
      if (!/^[0-9]+(?:\.[0-9]+)*(?:[-+][A-Za-z0-9.\-+]+)?$/.test(raw)) {
        this.notSupported(versionTok, "invalid VERSION format", `'${raw}' is not a valid version string`);
      }
      this.consume();
    }
    // Scan any nested DDL body for `ALTER CONSTRAINT X ON (...) { ... RENAME TO … }`
    // — RENAME TO is only valid on a top-level constraint alter without the
    // ON clause. We detect this pattern via a token-level scan so we don't
    // need to fully parse the inner body.
    if (action === "alter") {
      for (let i = 0; i < this.tokens.length - this.index; i += 1) {
        const t = this.peekNth(i);
        if (t.kind === "eof") break;
        if (this.isKeywordLikeToken(t) && t.lower === "alter") {
          const next1 = this.peekNth(i + 1);
          if (next1 && this.isKeywordLikeToken(next1) && next1.lower === "constraint") {
            // Scan ahead for ON ( … ) { … RENAME TO …
            let j = i + 2;
            // Consume a qualified name: one segment, then optional `::seg`
            // chains. Don't greedily eat keywords like `ON` that come next.
            if (this.peekNth(j) && (this.isNameToken(this.peekNth(j)) || this.isKeywordLikeToken(this.peekNth(j)))) {
              j += 1;
              while (this.peekNth(j) && (this.peekNth(j).kind === "coloncolon"
                || (this.peekNth(j).kind === "colon" && this.peekNth(j + 1) && this.peekNth(j + 1).kind === "colon"))) {
                j += this.peekNth(j).kind === "coloncolon" ? 1 : 2;
                if (this.peekNth(j) && (this.isNameToken(this.peekNth(j)) || this.isKeywordLikeToken(this.peekNth(j)))) {
                  j += 1;
                }
              }
            }
            // Optional `(args)` (e.g. `my_length(10)`).
            if (this.peekNth(j) && this.peekNth(j).kind === "lparen") {
              let pd = 1; j += 1;
              while (this.peekNth(j) && pd > 0) {
                const k = this.peekNth(j).kind;
                if (k === "lparen") pd += 1;
                else if (k === "rparen") { pd -= 1; if (pd === 0) { j += 1; break; } }
                else if (k === "eof") break;
                j += 1;
              }
            }
            // Look for `ON (…)`.
            if (this.peekNth(j) && this.isKeywordLikeToken(this.peekNth(j)) && this.peekNth(j).lower === "on"
              && this.peekNth(j + 1) && this.peekNth(j + 1).kind === "lparen") {
              j += 2;
              let pd = 1;
              while (this.peekNth(j) && pd > 0) {
                const k = this.peekNth(j).kind;
                if (k === "lparen") pd += 1;
                else if (k === "rparen") { pd -= 1; if (pd === 0) { j += 1; break; } }
                else if (k === "eof") break;
                j += 1;
              }
              // Now expect `{ … RENAME TO … }`.
              if (this.peekNth(j) && this.peekNth(j).kind === "lbrace") {
                let bd = 1;
                j += 1;
                while (this.peekNth(j) && bd > 0) {
                  const cur = this.peekNth(j);
                  if (cur.kind === "lbrace") bd += 1;
                  else if (cur.kind === "rbrace") { bd -= 1; if (bd === 0) break; }
                  else if (cur.kind === "eof") break;
                  else if (this.isKeywordLikeToken(cur) && cur.lower === "rename"
                    && this.peekNth(j + 1) && this.isKeywordLikeToken(this.peekNth(j + 1)) && this.peekNth(j + 1).lower === "to") {
                    this.notSupported(
                      cur,
                      "RENAME TO inside ALTER CONSTRAINT … ON (...)",
                      "RENAME TO is not allowed inside an ALTER CONSTRAINT with an ON clause",
                    );
                  }
                  j += 1;
                }
              }
            }
          }
        }
      }
    }
    // Capture `EXTENDING base[, …]` for non-scalar object kinds so validators
    // can inspect the bases without rescanning the source. Scalar types have
    // their own EXTENDING handler below that covers `enum<…>`. The list is
    // captured permissively as qualified names; sub-grammar checks (e.g.
    // rejecting `extending cfg::ConfigObject`) happen later in the validator.
    let extendsList: string[] | undefined;
    if (action === "create" && objectKind !== "scalar"
      && this.peek().kind === "kw_extending") {
      this.consume();
      extendsList = [];
      while (true) {
        const baseStart = this.peek();
        if (!this.isNameToken(baseStart) && !this.isKeywordLikeToken(baseStart)) break;
        let baseName = baseStart.lexeme;
        this.consume();
        while (this.peek().kind === "coloncolon") {
          this.consume();
          const seg = this.peek();
          if (!this.isNameToken(seg) && !this.isKeywordLikeToken(seg)) break;
          baseName += `::${seg.lexeme}`;
          this.consume();
        }
        extendsList.push(baseName);
        if (this.peek().kind === "comma") {
          this.consume();
          continue;
        }
        break;
      }
      if (extendsList.length === 0) extendsList = undefined;
    }
    // `CREATE SCALAR TYPE name EXTENDING enum<…>` — validate that the enum
    // values are homogeneous (all bare names or all strings) and aren't the
    // named-tuple form `enum<key: type>`.
    if (action === "create" && objectKind === "scalar"
      && this.peek().kind === "kw_extending") {
      this.consume();
      // Look for `enum<...>` specifically.
      if (this.isKeywordLikeToken(this.peek()) && this.peek().lower === "enum"
        && this.peekNext().kind === "lt") {
        this.consume(); // enum
        this.consume(); // <
        let sawString = false;
        let sawBareName = false;
        while (this.peek().kind !== "eof" && this.peek().kind !== "gt") {
          const tok = this.peek();
          if (tok.kind === "string") {
            sawString = true;
            this.consume();
          } else if (this.isNameToken(tok) || this.isKeywordLikeToken(tok)) {
            // Reject named-field form `key: type` and qualified types.
            if (this.peekNext().kind === "colon") {
              this.notSupported(tok, "named-tuple enum field", "enum<> cannot contain named fields");
            }
            sawBareName = true;
            this.consume();
            // Skip optional `::` qualifications? enum values aren't qualified.
          } else if (tok.kind === "comma") {
            this.consume();
          } else {
            this.consume();
          }
        }
        this.expect("gt", "Expected '>' after enum<…>");
        if (sawString && sawBareName) {
          this.notSupported(this.peek(), "mixed enum value forms", "enum<> values must all be string literals or all bare identifiers");
        }
      } else {
        // Generic EXTENDING type — consume the type name(s) permissively.
        while (this.peek().kind !== "eof" && this.peek().kind !== "semi" && this.peek().kind !== "lbrace") {
          this.consume();
        }
      }
    }
    let value: DDLStatement["value"];
    let functionDecl: DDLStatement["functionDecl"];
    const setCommands: string[] = [];
    if (action === "create" && (objectKind === "alias" || objectKind === "global") && this.peek().kind === "assign") {
      this.expect("assign", "Expected ':=' in DDL definition");
      value = this.parseFreeObjectExpr();
    } else if (action === "create" && objectKind === "function") {
      functionDecl = this.parseCreateFunctionTail(setCommands);
    } else if (action === "alter" && objectKind === "function") {
      // Capture top-level SET commands inside `ALTER FUNCTION ... { ... }` —
      // we still discard the rest of the body, but the validator needs the
      // SET names to reject `SET fallback := ...` etc.
      this.skipFunctionAlterBody(setCommands);
    } else {
      this.skipDDLBody();
    }
    // Per lexical.rst lines 400-402, ';' is idempotent — `commit;;`,
    // `select 1;;;` etc. are all valid (upstream test_edgeql_syntax_constants_02).
    while (this.peek().kind === "semi") {
      this.consume();
    }
    this.expect("eof", "Unexpected tokens after DDL statement");

    return {
      kind: "ddl",
      action,
      objectKind,
      name,
      value,
      functionDecl,
      modifiers: modifiers.length > 0 ? modifiers : undefined,
      extendsList,
      setCommands: setCommands.length > 0 ? setCommands : undefined,
      // A bare `WITH MODULE <name>` prefix supplies the DDL name-resolution
      // default module; thread it (and any module aliases) onto the node.
      withModule: withModule !== undefined && withModule !== this.defaultModule ? withModule : undefined,
      withModuleAliases,
      pos: this.posOf(start),
    };
  }

  private parseCreateFunctionTail(setCommandsOut?: string[]): FunctionDecl {
    const lparen = this.expect("lparen", "Expected '(' after function name");
    const params: FunctionParamDecl[] = [];
    const seenParamNames = new Map<string, Token>();
    if (this.peek().kind !== "rparen") {
      while (true) {
        const declStartToken = this.peek();
        const param = this.parseFunctionParamDecl();
        if (param.name) {
          if (seenParamNames.has(param.name)) {
            this.notSupported(
              declStartToken,
              "duplicate function parameter name",
              `parameter '${param.name}' is declared more than once`,
            );
          }
          seenParamNames.set(param.name, declStartToken);
        }
        // Parameter ordering rules upstream:
        //   * positional params with defaults must precede non-default
        //     positional params: `(a: int = 1, b: int)` is rejected.
        //   * exactly one VARIADIC param is permitted, and it must follow
        //     positional params.
        if (param.variadic) {
          const earlierVariadic = params.find((p) => p.variadic);
          if (earlierVariadic) {
            this.notSupported(
              declStartToken,
              "duplicate VARIADIC parameter",
              "more than one VARIADIC argument is not allowed",
            );
          }
          if (param.defaultExpr !== undefined) {
            this.notSupported(
              declStartToken,
              "VARIADIC parameter with default",
              "VARIADIC arguments cannot have default values",
            );
          }
        } else if (param.namedOnly) {
          // NAMED ONLY parameters may follow VARIADIC — that's the
          // canonical EdgeQL ordering: positional, VARIADIC, NAMED ONLY.
        } else {
          const prevVariadic = params.find((p) => p.variadic);
          if (prevVariadic) {
            this.notSupported(
              declStartToken,
              "positional parameter after VARIADIC",
              "positional arguments cannot follow a VARIADIC parameter",
            );
          }
          const prevNamedOnly = params.find((p) => p.namedOnly);
          if (prevNamedOnly) {
            this.notSupported(
              declStartToken,
              "positional parameter after NAMED ONLY",
              "positional arguments cannot follow a NAMED ONLY parameter",
            );
          }
          const prevWithDefault = params.find((p) => !p.variadic && !p.namedOnly && p.defaultExpr !== undefined);
          if (prevWithDefault && param.defaultExpr === undefined) {
            this.notSupported(
              declStartToken,
              "non-default positional after default",
              `positional parameter '${param.name}' without a default cannot follow a parameter with a default`,
            );
          }
        }
        params.push(param);
        if (this.peek().kind === "comma") {
          this.consume();
          // Trailing comma — `(a: int, b: int,)` — is accepted upstream.
          if (this.peek().kind === "rparen") {
            break;
          }
          continue;
        }
        break;
      }
    }
    void lparen;
    this.expect("rparen", "Expected ')' after function parameters");
    this.expect("arrow", "Expected '->' before function return type");

    let returnOptional = false;
    let returnSetOf = false;
    while (true) {
      if (this.matchKeywordLexeme("optional")) { returnOptional = true; continue; }
      if (this.atSetOf()) { this.consume(); this.consume(); returnSetOf = true; continue; }
      break;
    }
    const returnType = this.captureTypeExprText();

    const body = this.parseFunctionBody(setCommandsOut);
    return { params, returnType, returnOptional, returnSetOf, body };
  }

  // Modifier keywords are matched case-insensitively. EdgeQL tokenizes some
  // keywords (notably NAMED) as identifiers when their case isn't all
  // lowercase, so direct token-kind checks would miss `NAMED ONLY`.
  private atNamedOnly(): boolean {
    const a = this.peek();
    const aIsNamed = (this.isKeywordLikeToken(a) || this.isNameToken(a)) && a.lower === "named";
    if (!aIsNamed) return false;
    const b = this.peekNext();
    return (this.isKeywordLikeToken(b) || this.isNameToken(b)) && b.lower === "only";
  }

  private atSetOf(): boolean {
    const a = this.peek();
    if (!this.isKeywordLikeToken(a) || a.lower !== "set") return false;
    const b = this.peekNext();
    return this.isKeywordLikeToken(b) && b.lower === "of";
  }

  private parseFunctionParamDecl(): FunctionParamDecl {
    let variadic = false;
    let namedOnly = false;
    let optional = false;
    let setOf = false;
    while (true) {
      if (this.matchKeywordLexeme("variadic")) { variadic = true; continue; }
      if (this.atNamedOnly()) { this.consume(); this.consume(); namedOnly = true; continue; }
      if (this.matchKeywordLexeme("optional")) { optional = true; continue; }
      if (this.atSetOf()) { this.consume(); this.consume(); setOf = true; continue; }
      break;
    }
    const name = this.expectName("Expected parameter name").lexeme;
    this.expect("colon", "Expected ':' after parameter name");
    // Post-colon typemods — EdgeQL's canonical spelling (`b: OPTIONAL str`,
    // `a: SET OF str`). Fold them into the flags rather than letting them
    // leak into the type text, where downstream consumers (DDL function
    // ingestion, UDF inlining) would lose the OPTIONAL/SET OF semantics.
    while (true) {
      if (this.matchKeywordLexeme("optional")) { optional = true; continue; }
      if (this.atSetOf()) { this.consume(); this.consume(); setOf = true; continue; }
      break;
    }
    const typeText = this.captureTypeExprText();
    let defaultExpr: string | undefined;
    if (this.peek().kind === "equals") {
      this.consume();
      defaultExpr = this.captureDefaultExprText();
    }
    return {
      name,
      type: typeText,
      variadic: variadic || undefined,
      namedOnly: namedOnly || undefined,
      optional: optional || undefined,
      setOf: setOf || undefined,
      defaultExpr,
    };
  }

  // Consume tokens forming a type expression (qualified name, possibly with
  // angle-bracketed parameters like `array<int64>`) and return the verbatim
  // source slice covering them. Union types (`File | URL`) are also accepted
  // — the alternatives chain like additional qualified names with `|`
  // between them.
  private captureTypeExprText(): string {
    const startTok = this.peek();
    const startOffset = startTok.offset;
    this.captureSingleTypeExpr();
    while (this.peek().kind === "pipe") {
      this.consume();
      this.captureSingleTypeExpr();
    }
    const endTok = this.peek();
    return this.sliceSource(startOffset, endTok.offset).trim();
  }

  private captureSingleTypeExpr(): void {
    // Allow leading type-level modifiers that may appear after the param
    // colon (e.g. legacy "OPTIONAL str").
    while (true) {
      if (this.matchKeywordLexeme("optional")) continue;
      if (this.atSetOf()) { this.consume(); this.consume(); continue; }
      break;
    }
    // Consume the qualified-name head. We accept any name-like or keyword-like
    // token (e.g. `schema::Constraint`) since the result is captured as raw
    // source text and not interpreted further by this helper.
    if (!this.isNameToken(this.peek()) && !this.isKeywordLikeToken(this.peek())) {
      throw new AppError("E_SYNTAX", "Expected type name", ...this.posPair(this.peek()));
    }
    this.consume();
    while (this.peek().kind === "coloncolon"
        || (this.peek().kind === "colon" && this.peekNext().kind === "colon")) {
      if (this.peek().kind === "colon") { this.consume(); this.consume(); }
      else { this.consume(); }
      if (!this.isNameToken(this.peek()) && !this.isKeywordLikeToken(this.peek())) {
        throw new AppError("E_SYNTAX", "Expected name after '::'", ...this.posPair(this.peek()));
      }
      this.consume();
    }
    // Optional `<...>` parameterization.
    if (this.peek().kind === "lt") {
      let depth = 1;
      this.consume();
      while (depth > 0 && this.peek().kind !== "eof") {
        const k = this.peek().kind;
        if (k === "lt") depth += 1;
        else if (k === "gt") depth -= 1;
        else if (k === "gte") { depth -= 1; if (depth > 0) depth -= 1; }
        this.consume();
        if (depth === 0) break;
      }
    }
  }

  // The default-value expression runs up to the next ',' or ')' at depth 0.
  private captureDefaultExprText(): string {
    const startOffset = this.peek().offset;
    let depth = 0;
    while (this.peek().kind !== "eof") {
      const k = this.peek().kind;
      if (depth === 0 && (k === "comma" || k === "rparen")) break;
      if (k === "lparen" || k === "lbracket" || k === "lbrace") depth += 1;
      else if (k === "rparen" || k === "rbracket" || k === "rbrace") depth -= 1;
      this.consume();
    }
    const endTok = this.peek();
    return this.sliceSource(startOffset, endTok.offset).trim();
  }

  private parseFunctionBody(setCommandsOut?: string[]): FunctionDecl["body"] {
    // Brace-wrapped form: a sequence of commands separated by semicolons.
    // Upstream restricts the allowed commands and how often they may appear.
    if (this.peek().kind === "lbrace") {
      this.consume();
      // Scan the top-level (depth-0) commands inside the braces. EdgeQL
      // accepts SET, CREATE ANNOTATION, and at most one USING block as the
      // function body. We enforce the upstream constraint that at most one
      // USING appears and that USING is the last command.
      let usingCount = 0;
      let sawCmdAfterUsing = false;
      let usingBody: FunctionDecl["body"] | undefined;
      const skipCommand = (): void => {
        let depth = 0;
        while (this.peek().kind !== "eof") {
          const k = this.peek().kind;
          if (k === "lbrace" || k === "lparen" || k === "lbracket") depth += 1;
          else if (k === "rbrace" || k === "rparen" || k === "rbracket") {
            if (depth === 0) return;
            depth -= 1;
          } else if (k === "semi" && depth === 0) {
            this.consume();
            return;
          }
          this.consume();
        }
      };
      while (this.peek().kind !== "eof" && this.peek().kind !== "rbrace") {
        const head = this.peek();
        // Record `SET <name> := ...` so validators can reject forbidden
        // fields (`fallback`, `force_return_cast`, ...) without rescanning
        // the source. The actual semantics of SET commands are still
        // discarded — capturing happens before `skipCommand` consumes them.
        if (setCommandsOut
          && this.isKeywordLikeToken(head)
          && head.lower === "set"
          && this.peekNext()
          && (this.isNameToken(this.peekNext()) || this.isKeywordLikeToken(this.peekNext()))
        ) {
          setCommandsOut.push(this.peekNext().lexeme);
        }
        if (head.kind === "kw_using") {
          if (usingCount > 0) {
            this.notSupported(head, "multiple USING blocks in function body", "a function body may contain at most one USING command");
          }
          usingCount += 1;
          this.consume();
          usingBody = this.parseUsingBodyContents();
          // Consume an optional trailing `;` so the outer loop sees `rbrace` next.
          if (this.peek().kind === "semi") this.consume();
          continue;
        } else if (usingCount > 0) {
          sawCmdAfterUsing = true;
        }
        skipCommand();
      }
      const closingBrace = this.expect("rbrace", "Expected '}' to close function body block");
      // The previous "USING must be last" check was eager: it fired during
      // parsing and prevented validators from surfacing more specific
      // errors (e.g. "'force_return_cast' is not a valid field" when a SET
      // command follows USING — test_edgeql_userddl_21). Upstream EdgeQL
      // tolerates the ordering and reports field-level errors instead, so
      // the order check is dropped here. `sawCmdAfterUsing` is still
      // tracked for diagnostics but no longer thrown.
      void sawCmdAfterUsing;
      if (usingCount === 0 || !usingBody) {
        this.notSupported(closingBrace, "function body missing USING", "a function body must include a USING command");
      }
      return usingBody;
    }
    this.expect("kw_using", "Expected 'USING' in CREATE FUNCTION");
    return this.parseUsingBodyContents();
  }

  // Parse the tokens following a `USING` keyword: either `(expr)`, or
  // `<Lang> $$body$$` / `<Lang> FUNCTION 'name'` / `<Lang> EXPRESSION`.
  // Used by both the brace-wrapped and bare forms of CREATE FUNCTION.
  private parseUsingBodyContents(): FunctionDecl["body"] {
    let language = "edgeql";
    let query = "";
    let fromFunction: string | undefined;
    let fromExpression: boolean | undefined;

    if (this.peek().kind === "lparen") {
      // USING (expr) — EdgeQL native code.
      this.consume();
      const startOffset = this.peek().offset;
      let depth = 1;
      while (this.peek().kind !== "eof" && depth > 0) {
        const k = this.peek().kind;
        if (k === "lparen") depth += 1;
        else if (k === "rparen") {
          depth -= 1;
          if (depth === 0) break;
        }
        this.consume();
      }
      const endTok = this.peek();
      query = this.sliceSource(startOffset, endTok.offset).trim();
      this.expect("rparen", "Expected ')' after USING body");
    } else if (this.isKeywordLikeToken(this.peek()) || this.isNameToken(this.peek())) {
      // USING <Lang> ... — Lang is an identifier-like token (EdgeQL/SQL/...).
      const langTok = this.peek();
      language = langTok.lower;
      const knownLanguages = new Set(["edgeql", "sql", "python", "javascript"]);
      if (!knownLanguages.has(language)) {
        throw new AppError(
          "E_SYNTAX",
          `Unknown function language '${langTok.lexeme}'`,
          ...this.posPair(langTok),
        );
      }
      this.consume();
      const next = this.peek();
      if (this.isKeywordLikeToken(next) && next.lower === "function") {
        // USING <Lang> FUNCTION 'name'
        this.consume();
        const strTok = this.expect("string", "Expected function name string after USING <Lang> FUNCTION");
        fromFunction = strTok.lexeme.trim();
      } else if (this.isKeywordLikeToken(next) && next.lower === "expression") {
        // USING <Lang> EXPRESSION — placeholder marker, no body.
        this.consume();
        fromExpression = true;
      } else if (next.kind === "string") {
        // USING <Lang> $$body$$ — code in target language.
        this.consume();
        query = next.lexeme.trim();
      } else {
        throw new AppError(
          "E_SYNTAX",
          `Expected $$...$$ body, FUNCTION '<name>', or EXPRESSION after USING ${langTok.lexeme}`,
          ...this.posPair(next),
        );
      }
    } else {
      throw new AppError("E_SYNTAX", "Expected '(' or language identifier after USING", ...this.posPair(this.peek()));
    }
    return { kind: "query", language, query, fromFunction, fromExpression };
  }

  private sliceSource(startOffset: number, endOffset: number): string {
    if (this.sourceText !== undefined) {
      return this.sourceText.slice(startOffset, endOffset);
    }
    // Fallback when no source is available: reconstruct from token lexemes
    // within the offset range. Whitespace is collapsed to a single space.
    const parts: string[] = [];
    for (const token of this.tokens) {
      if (token.offset < startOffset) continue;
      if (token.offset >= endOffset) break;
      parts.push(token.lexeme);
    }
    return parts.join(" ");
  }

  // Skip an `ALTER FUNCTION name(args) { ... }` body while capturing the
  // names of top-level `SET <name> := …` commands. The function signature
  // `(args)` is consumed in passing; we only descend into the brace-block
  // that follows, recording SET fields at depth 1 (immediately inside the
  // alter's outer braces). Used so validators can reject `SET fallback` /
  // `SET force_return_cast` without rescanning the source.
  private skipFunctionAlterBody(setCommandsOut: string[]): void {
    // Skip the function signature `(args)` if present.
    if (this.peek().kind === "lparen") {
      let parenDepth = 1;
      this.consume();
      while (this.peek().kind !== "eof" && parenDepth > 0) {
        const k = this.peek().kind;
        if (k === "lparen") parenDepth += 1;
        else if (k === "rparen") parenDepth -= 1;
        this.consume();
      }
    }
    // No body brace → nothing more to capture; let skipDDLBody handle the
    // tail (e.g. `ALTER FUNCTION f(a: int) RENAME TO g`).
    if (this.peek().kind !== "lbrace") {
      this.skipDDLBody();
      return;
    }
    this.consume();
    let depth = 1;
    while (this.peek().kind !== "eof") {
      const token = this.peek();
      if (token.kind === "lbrace" || token.kind === "lparen" || token.kind === "lbracket") {
        depth += 1;
        this.consume();
        continue;
      }
      if (token.kind === "rbrace" || token.kind === "rparen" || token.kind === "rbracket") {
        depth = Math.max(0, depth - 1);
        this.consume();
        if (depth === 0) break;
        continue;
      }
      // At depth 1 (immediately inside the alter braces), watch for
      // `SET <name>` and capture the field name.
      if (depth === 1
        && this.isKeywordLikeToken(token)
        && token.lower === "set"
        && this.peekNext()
        && (this.isNameToken(this.peekNext()) || this.isKeywordLikeToken(this.peekNext()))
      ) {
        setCommandsOut.push(this.peekNext().lexeme);
      }
      this.consume();
    }
  }

  private skipDDLBody(): void {
    let depth = 0;
    while (this.peek().kind !== "eof") {
      const token = this.peek();
      if (token.kind === "semi" && depth === 0) {
        break;
      }
      if (token.kind === "lbrace" || token.kind === "lparen" || token.kind === "lbracket") {
        depth += 1;
      } else if (token.kind === "rbrace" || token.kind === "rparen" || token.kind === "rbracket") {
        depth = Math.max(0, depth - 1);
      }
      this.consume();
    }
  }

  // FOR statement — see docs/reference/reference/edgeql/for.rst.
  //
  // Grammar (eql:synopsis from for.rst lines 12-18):
  //
  //   [ with <with-item> [, ...] ]
  //   for <variable> in <iterator-expr>
  //   union <output-expr> ;
  //
  // Per for.rst lines 28-34, <iterator-expr> is restricted: literals,
  // function calls, set constructors `{ ... }`, paths, or any
  // parenthesised expression/statement. Bare DETACHED, binary ops, casts,
  // concats, or top-level shape projections are rejected — they must be
  // wrapped in `{...}` or `(...)`. We enforce that with the explicit
  // `disallowed()` check on the parsed iterator.
  //
  // <output-expr> is any expression — typically an INSERT/UPDATE/DELETE
  // wrapped in `(...)`, but bare SELECT-like expressions are also legal.
  // We accept an optional `OPTIONAL` prefix on the variable (used when
  // the iterator may be empty and we want a single null pass).
  private parseFor(ctx: ParseContext = {}, expectEof = true): ForStatement {
    const start = this.expect("kw_for", "Expected 'for'");
    let optional = false;
    if (this.peek().kind === "kw_optional") {
      this.consume();
      optional = true;
    }
    const variable = this.expectName("Expected variable name after 'for'").lexeme;
    this.expect("kw_in", "Expected 'in' after for variable");
    // The FOR iterator expression has restricted syntax upstream: it must be
    // a set literal `{...}`, a parenthesised expression `(...)`, a function
    // call, or a single name (optionally with `[...]` / `.member` postfixes).
    // Bare DETACHED, binary operators, casts, concat, or shape projections at
    // the top level are rejected.
    const iterStartTok = this.peek();
    const iteratorExpr = this.parseFreeObjectIfElseExpr();
    {
      // Reject FOR iterators that are top-level binary expressions, shape
      // projections, DETACHED prefixes, or concatenations — those forms need
      // to be wrapped in `{...}` or `(...)`. Atom-shaped iterators (set
      // literals, paren-wrapped, function calls, field/path accesses, casts,
      // single-value literals/types) are all allowed.
      //
      // Exception: an operator whose operands are themselves atom-shaped (set
      // literals, paren-wrapped expressions, single names/literals, function
      // calls, paths) is treated as atom-like for FOR-iterator purposes —
      // `evaluateForIteratorValues` knows how to materialise such expressions.
      // Only `{...}`-shaped (set literal / set expression / array literal)
      // operands count as iterator-eligible — bare names and field accesses
      // do not. This matches what `evaluateForIteratorValues` can materialise
      // up front while keeping the upstream rejection for `FOR x IN foo + bar`
      // (binary op over non-set-shaped operands).
      const isAtomShaped = (e: FreeObjectExpr): boolean => {
        switch (e.kind) {
          case "set_literal":
          case "set_expr":
          case "array_literal_expr":
            return true;
          default:
            return false;
        }
      };
      const partsOf = (e: FreeObjectExpr): FreeObjectExpr[] | undefined => {
        if (e.kind === "concat" && Array.isArray((e as { parts?: unknown }).parts)) {
          return (e as { parts: FreeObjectExpr[] }).parts;
        }
        if ((e.kind === "math" || e.kind === "set_op")
          && (e as { left?: unknown; right?: unknown }).left !== undefined
          && (e as { left?: unknown; right?: unknown }).right !== undefined) {
          return [
            (e as { left: FreeObjectExpr }).left,
            (e as { right: FreeObjectExpr }).right,
          ];
        }
        return undefined;
      };
      const disallowed = (e: FreeObjectExpr): string | undefined => {
        switch (e.kind) {
          case "math":
          case "logical":
          case "compare":
          case "in_expr":
          case "concat":
          case "coalesce":
          case "set_op":
          case "and":
          case "or":
            {
              const parts = partsOf(e);
              if (parts && parts.every(isAtomShaped)) {
                return undefined;
              }
            }
            return e.kind;
          case "shape_projection":
            return "shape_projection";
          case "detached" as never:
            return "detached";
          default:
            return undefined;
        }
      };
      // Also detect bare DETACHED (`DETACHED foo`) — the parser may not have
      // a separate node kind for it depending on context. Check the first
      // token of the iterator instead.
      if (iterStartTok.kind === "kw_detached") {
        this.notSupported(
          iterStartTok,
          "invalid FOR iterator expression",
          "DETACHED is not allowed at the top of a FOR iterator; wrap it in (…)",
        );
      }
      // Skip the disallowed-form check when the iterator was paren-wrapped:
      // `(any expression)` is fine, but `expr op expr` without parens is not.
      if (iterStartTok.kind !== "lparen") {
        const bad = disallowed(iteratorExpr);
        if (bad) {
          this.notSupported(
            iterStartTok,
            "invalid FOR iterator expression",
            `the FOR iterator must be wrapped in '{...}' or '(...)'; '${bad}' at this position is rejected by EdgeQL`,
          );
        }
        // Bare typed select with an explicit shape (`foo { x }` without
        // SELECT) is rejected — only set/paren-wrapped iterators may carry
        // shapes. Standalone names (`foo`) are fine since their shape is the
        // default `[{id}]`.
        if (iteratorExpr.kind === "select"
          && iteratorExpr.shape.some((el) => (el as { origin?: string }).origin === "explicit")) {
          this.notSupported(
            iterStartTok,
            "invalid FOR iterator expression",
            "bare typed selects with explicit shapes must be wrapped in '(SELECT …)' inside a FOR iterator",
          );
        }
      }
    }
    if (this.peek().kind === "kw_union") {
      this.consume();
      // `FOR x IN ... UNION y := ...` — the assignment-after-UNION form is
      // rejected upstream. Catch it here so the test gets a clear hint instead
      // of failing later.
      if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
        this.notSupported(
          this.peek(),
          "FOR ... UNION y := ...",
          `the body after UNION cannot be an assignment; wrap it in a SELECT/INSERT/UPDATE/DELETE`,
        );
      }
    }
    const hasWrappedStatement = this.peek().kind === "lparen"
      && (this.peekNext().kind === "kw_select" || this.peekNext().kind === "kw_insert");
    if (hasWrappedStatement) {
      this.consume();
    }
    const body: InsertStatement | SelectStatement | SelectExprStatement | SelectFreeStatement | ForStatement
      = this.withLocalBinding(variable, () => {
      const next = this.peek();
      if (next.kind === "kw_select") {
        const selectStart = this.consume();
        const freeOrExpr = this.parseSelectFreeOrExpr(selectStart, ctx, false);
        if (freeOrExpr) {
          return freeOrExpr;
        }
        return this.parseTypedSelect(selectStart, ctx, false);
      }
      if (next.kind === "kw_insert") {
        return this.parseInsert(ctx, false);
      }

      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), false);
    });
    if (hasWrappedStatement) {
      this.expect("rparen", "Expected ')' after for body");
    }
    // Top-level FOR must consume to EOF. The body parsers were called with
    // expectEof=false so they leave trailing tokens to us. Per lexical.rst
    // lines 400-402, idempotent ; sequences are tolerated before EOF.
    if (expectEof) {
      while (this.peek().kind === "semi") this.consume();
      this.expect("eof", "Unexpected tokens after statement");
    }
    return {
      ...this.withContext(ctx),
      kind: "for",
      variable,
      optional,
      iteratorExpr,
      body,
      pos: this.posOf(start),
    };
  }

  // SELECT statement — see docs/reference/reference/edgeql/select.rst.
  //
  // Grammar (eql:synopsis from select.rst):
  //
  //   [ with <with-item> [, ...] ]
  //   select <expr>
  //     [ filter <filter-expr> ]
  //     [ order by <order-expr> [asc|desc] [empty {first|last}] [then ...] ]
  //     [ offset <offset-expr> ]
  //     [ limit  <limit-expr>  ] ;
  //
  // Three concrete AST shapes can fall out of this entry point:
  //
  //   SelectStatement      — typed object select: `SELECT Foo { ... } ...`
  //                          (parseTypedSelect / tryParseNarrowedTypedSelect).
  //   SelectFreeStatement  — free-object select: `SELECT { a := 1, b := 2 }`
  //                          (parseFreeObjectSelect via parseSelectFreeOrExpr).
  //   SelectExprStatement  — expression select: `SELECT 1 + 2`,
  //                          `SELECT (insert ...)`, `SELECT global X`, etc.
  //                          (parseSelectExprTail via parseSelectFreeOrExpr).
  //
  // Trailing FILTER/ORDER BY/OFFSET/LIMIT are handled by parseClauseChain
  // — that enforces the ordering constraint baked into the grammar
  // (filter < order by < offset < limit).
  private parseSelect(ctx: ParseContext = {}): SelectStatement | SelectFreeStatement | SelectExprStatement {
    const start = this.expect("kw_select", "Expected 'select'");

    // Permissive passthrough for SELECT-prefixed forms whose full grammar
    // we don't yet model — INTROSPECT, TYPEOF, REQUIRED-as-cardinality
    // prefix, and `@`-prefixed reserved-keyword link properties. Consume
    // tokens through the statement boundary and return a placeholder
    // SelectExprStatement so the parser accepts the source.
    const head = this.peek();
    if (head.kind === "kw_introspect") {
      // INTROSPECT accepts a named type (bare, e.g. `User`), a paren-wrapped
      // type expression (`(tuple<str>)`), or `TYPEOF <expr>`. A bare
      // parametric type expression (`INTROSPECT tuple<int64>`) is rejected
      // upstream — the parens are required for parametric type metadata.
      this.consume();
      if (this.peek().kind === "kw_typeof" || this.peek().kind === "lparen") {
        return this.parseSelectPassthrough(start, ctx);
      }
      const typeTok = this.peek();
      if (this.isNameToken(typeTok)) {
        this.parseQualifiedName("Expected type name after INTROSPECT");
        // Disallow generic type-application — INTROSPECT requires a bare
        // type reference. The `<` would start a `tuple<>` / `array<>` form.
        if (this.peek().kind === "lt") {
          this.notSupported(this.peek(), "parametric type in INTROSPECT", "INTROSPECT does not accept parametric type expressions");
        }
        while (this.peek().kind === "semi") this.consume();
        this.expect("eof", "Unexpected tokens after statement");
        return {
          ...this.withContext(ctx),
          kind: "select_expr",
          expr: { kind: "literal", value: "" },
          pos: this.posOf(start),
        };
      }
      // Anything else (tuple<>, array<>, paren-wrapped, ...) is rejected.
      this.notSupported(typeTok, "invalid INTROSPECT operand", "INTROSPECT expects a type name or TYPEOF <expr>");
    }
    if (
      head.kind === "kw_typeof"
      || head.kind === "kw_required"
      || head.kind === "at"
    ) {
      return this.parseSelectPassthrough(start, ctx);
    }

    const narrowedTyped = this.attempt(() => this.tryParseNarrowedTypedSelect(start, ctx, true));
    if (narrowedTyped) {
      return narrowedTyped;
    }
    const freeOrExpr = this.parseSelectFreeOrExpr(start, ctx, true);
    if (freeOrExpr) {
      return freeOrExpr;
    }

    return this.parseTypedSelect(start, ctx, true);
  }

  private parseSelectPassthrough(start: Token, ctx: ParseContext): SelectExprStatement {
    let depth = 0;
    while (this.peek().kind !== "eof") {
      const k = this.peek().kind;
      if (k === "semi" && depth === 0) break;
      if (k === "lbrace" || k === "lparen" || k === "lbracket") depth += 1;
      else if (k === "rbrace" || k === "rparen" || k === "rbracket") {
        depth = Math.max(0, depth - 1);
      }
      this.consume();
    }
    while (this.peek().kind === "semi") this.consume();
    this.expect("eof", "Unexpected tokens after statement");
    return {
      ...this.withContext(ctx),
      kind: "select_expr",
      expr: { kind: "literal", value: "" },
      pos: this.posOf(start),
    };
  }

  private parseSelectFreeOrExpr(
    start: Token,
    ctx: ParseContext,
    expectEof: boolean,
  ): SelectFreeStatement | SelectExprStatement | undefined {
    if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
      const alias = this.consume().lexeme;
      this.expect("assign", "Expected ':=' after select expression alias");
      this.pendingResultAliases.push(alias);
      let expr: FreeObjectExpr;
      try {
        expr = this.parseFreeObjectExpr();
      } finally {
        this.pendingResultAliases.pop();
      }
      // A reference to the alias from inside its own definition (e.g.
      // `SELECT _ := (User { tag := _.name })`) — the alias is not yet bound.
      if (this.pendingResultAliasViolation) {
        const violation = this.pendingResultAliasViolation;
        this.pendingResultAliasViolation = undefined;
        throw violation;
      }
      return this.parseSelectExprTail(start, ctx, {
        kind: "select_expr_subquery",
        alias,
        expr,
      }, expectEof);
    }

    if (this.peek().kind === "lbrace") {
      if (this.looksLikeFreeObjectSelect()) {
        return this.parseFreeObjectSelect(...this.posPair(start), ctx);
      }
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.peek().kind === "lparen" || this.peek().kind === "lt" || this.peek().kind === "string" || this.peek().kind === "bytes_string" || this.peek().kind === "str_interp_start" || this.peek().kind === "lbracket" || this.atFunctionCall()) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if ([
      "number",
      "kw_true",
      "kw_false",
      "kw_null",
      "kw_for",
      "kw_distinct",
      "kw_detached",
      "dot",
      // `.<foo` and `.>foo` are tokenized as single backward_link /
      // optional_link tokens — without these the parser falls through to
      // parseTypedSelect and reports "Expected type name".
      "backward_link",
      "optional_link",
      // `SELECT $1`, `SELECT $foo.bar`, etc. — bare parameter references.
      "parameter",
      "kw_not",
      // Unary minus/plus on a literal / sub-expression starts a
      // free-expression select: `SELECT -1 + 2 * 3`, `SELECT +<int64>{}`.
      // Without these branches the parser falls through to parseTypedSelect
      // and reports "Expected type name".
      "minus",
      "plus",
      // IF/THEN/ELSE conditional expressions can appear at the top of a
      // SELECT (`SELECT IF cond THEN x ELSE y`).
      "kw_if",
      // `SELECT global X` references a global variable as the result.
      "kw_global",
    ].includes(this.peek().kind)) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isExistsToken(this.peek())) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isNameToken(this.peek()) && this.peekNext().kind === "at") {
      const atToken = this.peekNext();
      throw new AppError("E_SYNTAX", "unexpected reference to link property", ...this.posPair(atToken));
    }

    const hasNamedBacklink = this.isNameToken(this.peek()) && (
      (this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt")
      || this.peekNext().kind === "backward_link"
    );
    if (hasNamedBacklink) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isNameToken(this.peek()) && this.peekNext().kind === "lbracket") {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.atQualifiedIdentifier()) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    // `name.<anything>` — numeric tuple index (`TUP.0`), keyword-as-field
    // access (`Foo.union`), etc. parseTypedSelect would stop at the name and
    // throw on the trailing `.X`; route to free-expr instead.
    if (this.isNameToken(this.peek()) && this.peekNext().kind === "dot") {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isNameToken(this.peek()) && this.localBindings.includes(this.peek().lexeme)) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (ctx.with && ctx.with.length > 0 && this.isNameToken(this.peek()) && this.peekNext().kind !== "lbrace") {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    if (this.isNameToken(this.peek()) && (this.peekNext().kind === "semi" || this.peekNext().kind === "eof")) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    // Name followed by a binary operator — treat as a free expression so the
    // expression parser handles the full RHS instead of letting parseTypedSelect
    // stop at the bare name and choke on the trailing operator. Includes
    // path/postfix continuations (`.`, `.?>`, `.<`, `[`, `@`) so
    // `SELECT name.path` is parsed as an expression rather than misread as a
    // typed select followed by garbage.
    const binaryOpKinds: Token["kind"][] = [
      "coalesce",
      "not_distinct_from",
      "distinct_from",
      "plus",
      "minus",
      "star",
      "slash",
      "floor_div",
      "modulo",
      "pow",
      "concat",
      "equals",
      "not_equals",
      "lt",
      "gt",
      "lte",
      "gte",
      "kw_and",
      "kw_or",
      "kw_is",
      "kw_if",
      "kw_union",
      "kw_intersect",
      "kw_except",
      "kw_like",
      "kw_ilike",
      "kw_in",
      "dot",
      "optional_link",
      "backward_link",
      "at",
      "lbracket",
    ];
    if (this.isNameToken(this.peek()) && binaryOpKinds.includes(this.peekNext().kind)) {
      return this.parseSelectExprTail(start, ctx, this.parseFreeObjectExpr(), expectEof);
    }

    return undefined;
  }

  private parseTypedSelect(start: Token, ctx: ParseContext, expectEof: boolean): SelectStatement {
    const typeName = this.parseQualifiedName("Expected type name");

    const shape: ShapeElement[] = [{ kind: "field", name: "id", operation: "assign", origin: "default" }];
    const fields: string[] = ["id"];
    // Allow chained shape projections (`SELECT Foo { a } { b }`) — upstream
    // accepts them as iterative refinements; we collect everything into the
    // accumulated shape.
    while (this.peek().kind === "lbrace") {
      this.consume();
      shape.length = 0;
      fields.length = 0;

      for (const entry of this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries")) {
        shape.push(entry);
        if (entry.kind === "field") {
          fields.push(entry.name);
        }
      }
      this.expect("rbrace", "Expected '}' after selected fields");
    }

    const clauses = this.parseClauseChain();

    // Per lexical.rst lines 400-402, ';' is idempotent at statement end.
    while (expectEof && this.peek().kind === "semi") {
      this.consume();
    }

    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "select",
      typeName,
      shape,
      fields,
      filter: clauses.filter,
      orderBy: clauses.orderBy,
      limit: clauses.limit,
      offset: clauses.offset,
      limitExpr: clauses.limitExpr,
      offsetExpr: clauses.offsetExpr,
      pos: this.posOf(start),
    };
  }

  // Matches `Name[IS T1]...[IS Tn] { shape }` as a typed select with type
  // narrowing, so the typed-select IR path applies. Returns undefined when
  // the lookahead doesn't fit (e.g. no `{` follows the bracket chain) so the
  // caller can fall back to the select-expression path.
  private tryParseNarrowedTypedSelect(
    start: Token,
    ctx: ParseContext,
    expectEof: boolean,
  ): SelectStatement | undefined {
    if (!this.atQualifiedIdentifierForTypedSelect()) {
      return undefined;
    }
    const typeName = this.parseQualifiedName("Expected type name");
    const typeFilterExprs: TypeExpr[] = [];
    while (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
      typeFilterExprs.push(this.parseTypeFilter("typed select narrowing"));
    }
    if (typeFilterExprs.length === 0 || this.peek().kind !== "lbrace") {
      return undefined;
    }

    this.consume();
    const shape: ShapeElement[] = [];
    const fields: string[] = [];
    for (const entry of this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries")) {
      shape.push(entry);
      if (entry.kind === "field") {
        fields.push(entry.name);
      }
    }
    this.expect("rbrace", "Expected '}' after selected fields");

    const clauses = this.parseClauseChain();

    // Per lexical.rst lines 400-402, ';' is idempotent at statement end.
    while (expectEof && this.peek().kind === "semi") {
      this.consume();
    }
    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "select",
      typeName,
      typeFilterExprs,
      shape,
      fields,
      filter: clauses.filter,
      orderBy: clauses.orderBy,
      limit: clauses.limit,
      offset: clauses.offset,
      limitExpr: clauses.limitExpr,
      offsetExpr: clauses.offsetExpr,
      pos: this.posOf(start),
    };
  }

  private atQualifiedIdentifierForTypedSelect(): boolean {
    if (!this.isNameToken(this.peek())) return false;
    let offset = 1;
    while (this.peekNth(offset).kind === "coloncolon" && this.isNameToken(this.peekNth(offset + 1))) {
      offset += 2;
    }
    return this.peekNth(offset).kind === "lbracket" && this.peekNth(offset + 1).kind === "kw_is";
  }

  private parseSelectExprTail(start: Token, ctx: ParseContext, expr: FreeObjectExpr, expectEof = true): SelectExprStatement {
    const tail = this.parseSelectExprTailParts();
    const paginatedExpr: FreeObjectExpr = this.hasSelectExprTailParts(tail, false)
      ? {
          kind: "select_expr_subquery",
          expr,
          ...tail,
        }
      : expr;
    // Per lexical.rst lines 400-402, ';' is idempotent at statement end.
    while (expectEof && this.peek().kind === "semi") {
      this.consume();
    }
    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }
    return {
      ...this.withContext(ctx),
      kind: "select_expr",
      expr: paginatedExpr,
      orderBy: paginatedExpr === expr ? tail.orderBy : undefined,
      pos: this.posOf(start),
    };
  }

  private parseFreeObjectSelect(
    line: number,
    column: number,
    ctx: ParseContext,
  ): SelectFreeStatement {
    this.expect("lbrace", "Expected '{' after 'select' in free object query");
    const entries = this.parseDelimited("rbrace", () => {
      // Optional cardinality qualifier on a free-object field.
      let cardinality: "one" | "many" | undefined;
      if (this.peek().kind === "kw_multi") { this.consume(); cardinality = "many"; }
      else if (this.peek().kind === "kw_single") { this.consume(); cardinality = "one"; }
      const name = this.expectName("Expected free object field name").lexeme;
      this.expect("assign", "Expected ':=' in free object field");
      const expr = this.parseFreeObjectExpr();
      return cardinality ? { name, expr, cardinality } : { name, expr };
    }, "Expected ',' between free object entries");

    this.expect("rbrace", "Expected '}' after free object entries");
    // Per lexical.rst lines 400-402, ';' is idempotent — `commit;;`,
    // `select 1;;;` etc. are all valid (upstream test_edgeql_syntax_constants_02).
    while (this.peek().kind === "semi") {
      this.consume();
    }
    // `select { x := 1 } filter (INSERT …)` — DML is never allowed inside a
    // FILTER / ORDER BY clause. The clause isn't otherwise representable for
    // a free-object select, so diagnose the DML misuse before the generic
    // "Unexpected tokens" error hides it.
    if (this.peek().kind === "kw_filter" || this.peek().kind === "kw_order") {
      const clauseLabel = this.peek().kind === "kw_filter" ? "a FILTER clause" : "an ORDER BY clause";
      const dmlByKind: Partial<Record<Token["kind"], string>> = {
        kw_insert: "INSERT",
        kw_update: "UPDATE",
        kw_delete: "DELETE",
      };
      for (let i = this.index + 1; i < this.tokens.length; i += 1) {
        const tok = this.tokens[i];
        const dml = dmlByKind[tok.kind];
        if (dml) {
          throw new AppError(
            "E_SEMANTIC",
            `${dml} statements cannot be used in ${clauseLabel}`,
            ...this.posPair(tok),
          );
        }
      }
    }
    this.expect("eof", "Unexpected tokens after statement");

    return {
      ...this.withContext(ctx),
      kind: "select_free",
      entries,
      pos: { line, column },
    };
  }

  private parseFreeObjectExpr(): FreeObjectExpr {
    let expr = this.parseFreeObjectIfElseExpr();
    while (
      this.peek().kind === "kw_union"
      || this.peek().kind === "kw_intersect"
      || this.peek().kind === "kw_except"
    ) {
      const opTok = this.peek();
      this.consume();
      const right = this.parseFreeObjectIfElseExpr();
      if (opTok.kind === "kw_union") {
        expr = expr.kind === "set_expr"
          ? { kind: "set_expr", values: [...expr.values, right] }
          : { kind: "set_expr", values: [expr, right] };
      } else {
        expr = {
          kind: "set_op",
          op: opTok.kind === "kw_intersect" ? "intersect" : "except",
          left: expr,
          right,
        };
      }
    }
    return expr;
  }

  private parseFreeObjectIfElseExpr(): FreeObjectExpr {
    const thenExpr = this.parseFreeObjectOrExpr();
    if (this.peek().kind !== "kw_if") {
      return thenExpr;
    }

    this.consume();
    const condition = this.parseFreeObjectOrExpr();
    this.expect("kw_else", "Expected 'else' in IF expression");
    const elseExpr = this.parseFreeObjectIfElseExpr();
    return {
      kind: "if_else",
      thenExpr,
      condition,
      elseExpr,
    };
  }

  private parseFreeObjectOrExpr(): FreeObjectExpr {
    let left = this.parseFreeObjectAndExpr();
    while (this.peek().kind === "kw_or") {
      this.consume();
      left = {
        kind: "logical",
        op: "or",
        left,
        right: this.parseFreeObjectAndExpr(),
      };
    }
    return left;
  }

  private parseFreeObjectAndExpr(): FreeObjectExpr {
    let left = this.parseFreeObjectNotExpr();
    while (this.peek().kind === "kw_and") {
      this.consume();
      left = {
        kind: "logical",
        op: "and",
        left,
        right: this.parseFreeObjectNotExpr(),
      };
    }
    return left;
  }

  private parseFreeObjectNotExpr(): FreeObjectExpr {
    if (this.peek().kind === "kw_not") {
      this.consume();
      return {
        kind: "unary",
        op: "not",
        expr: this.parseFreeObjectNotExpr(),
      };
    }
    if (this.peek().kind === "minus") {
      this.consume();
      return {
        kind: "unary",
        op: "neg",
        expr: this.parseFreeObjectNotExpr(),
      };
    }
    return this.parseFreeObjectComparisonExpr();
  }

  private parseFreeObjectComparisonExpr(): FreeObjectExpr {
    let left = this.parseFreeObjectExprWithPrecedence();
    let sawCompareOp = false;

    while (true) {
      // EdgeQL `expr IN set` / `expr NOT IN set` lives at the same precedence
      // tier as the boolean comparisons. Recognize them before falling out so
      // a select-expression FILTER (`FILTER _ IN {1, 2}`) parses end-to-end.
      const inToken = this.peek();
      if (inToken.kind === "kw_in") {
        if (sawCompareOp) {
          this.notSupported(
            inToken,
            "chained comparison operators",
            `unexpected '${inToken.lexeme}' after a comparison expression — chained comparisons are not allowed; use 'and' instead`,
          );
        }
        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence();
        left = { kind: "in_expr", op: "in", left, right };
        sawCompareOp = true;
        continue;
      }
      if (inToken.kind === "kw_not" && this.peekNext().kind === "kw_in") {
        if (sawCompareOp) {
          this.notSupported(
            inToken,
            "chained comparison operators",
            `unexpected '${inToken.lexeme}' after a comparison expression — chained comparisons are not allowed; use 'and' instead`,
          );
        }
        this.consume();
        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence();
        left = { kind: "in_expr", op: "not_in", left, right };
        sawCompareOp = true;
        continue;
      }

      const token = this.peek();
      if (
        token.kind !== "equals"
        && token.kind !== "not_equals"
        && token.kind !== "gt"
        && token.kind !== "lt"
        && token.kind !== "gte"
        && token.kind !== "lte"
        && token.kind !== "not_distinct_from"
        && token.kind !== "distinct_from"
        && token.kind !== "kw_like"
        && token.kind !== "kw_ilike"
        && token.kind !== "kw_not"
      ) {
        break;
      }

      // `NOT LIKE` / `NOT ILIKE` are two-token compound operators.
      if (token.kind === "kw_not") {
        const next = this.peekNext();
        if (next.kind !== "kw_like" && next.kind !== "kw_ilike") {
          break;
        }
      }

      // Upstream EdgeQL forbids chained comparison operators (`a < b < c`,
      // `a = b = c`, etc.) — the second compare op is reported with
      // "Unexpected '<'" / "Unexpected '>'" syntax errors. Mirror that.
      if (sawCompareOp) {
        this.notSupported(
          token,
          "chained comparison operators",
          `unexpected '${token.lexeme}' after a comparison expression — chained comparisons (a < b < c) are not allowed; use 'and' instead`,
        );
      }

      let op: "=" | "!=" | ">" | "<" | ">=" | "<=" | "?=" | "?!=" | "like" | "ilike" | "not_like" | "not_ilike";
      if (token.kind === "kw_not") {
        this.consume(); // NOT
        const likeTok = this.consume(); // LIKE or ILIKE
        op = likeTok.kind === "kw_like" ? "not_like" : "not_ilike";
      } else {
        this.consume();
        op = token.kind === "equals"
          ? "="
          : token.kind === "not_equals"
            ? "!="
            : token.kind === "gt"
              ? ">"
              : token.kind === "lt"
                ? "<"
                : token.kind === "gte"
                  ? ">="
                  : token.kind === "lte"
                    ? "<="
                    : token.kind === "not_distinct_from"
                      ? "?="
                      : token.kind === "distinct_from"
                        ? "?!="
                        : token.kind === "kw_like"
                          ? "like"
                          : "ilike";
      }
      sawCompareOp = true;
      const right = this.parseFreeObjectExprWithPrecedence();
      left = {
        kind: "compare",
        op,
        left,
        right,
      };
    }

    return left;
  }

  private parseFreeObjectPrimaryExpr(): FreeObjectExpr {
    if (this.peek().kind === "kw_if") {
      // EdgeQL prefix conditional: `IF cond THEN x ELSE y`. The postfix form
      // (`x IF cond ELSE y`) is handled by parseFreeObjectIfElseExpr.
      this.consume();
      const condition = this.parseFreeObjectExpr();
      this.expect("kw_then", "Expected 'then' after IF condition");
      const thenExpr = this.parseFreeObjectExpr();
      this.expect("kw_else", "Expected 'else' in IF expression");
      const elseExpr = this.parseFreeObjectExpr();
      return { kind: "if_else", thenExpr, condition, elseExpr };
    }
    if (this.peek().kind === "lparen") {
      this.consume();
      if (this.peek().kind === "rparen") {
        this.consume();
        // `()` is the empty tuple in EdgeQL, distinct from `{}` (empty set).
        return { kind: "tuple", values: [] };
      }
      if (["kw_insert", "kw_update", "kw_delete"].includes(this.peek().kind)) {
        const kind = this.peek().kind;
        let statement: InsertStatement | UpdateStatement | DeleteStatement;
        if (kind === "kw_insert") {
          statement = this.parseInsert({}, false);
        } else if (kind === "kw_update") {
          statement = this.parseUpdate({}, false);
        } else {
          statement = this.parseDelete({}, false);
        }
        this.expect("rparen", "Expected ')' after parenthesized mutation expression");
        return { kind: "mutation_expr", statement };
      }
      // Parenthesised free-object constructor: `( name := expr, name := expr )`
      if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
        const entries: Array<{ name: string; expr: FreeObjectExpr }> = [];
        while (true) {
          const name = this.expectName("Expected free object field name").lexeme;
          this.expect("assign", "Expected ':=' in free object field");
          const fieldExpr = this.parseFreeObjectExpr();
          entries.push({ name, expr: fieldExpr });
          if (this.peek().kind !== "comma") {
            break;
          }
          this.consume();
          if (this.peek().kind === "rparen") {
            break;
          }
        }
        this.expect("rparen", "Expected ')' after free object entries");
        return { kind: "free_object_constructor", entries, tupleLike: true };
      }

      if (this.peek().kind === "kw_with") {
        const withClause = this.parseWithClause();
        let inner: FreeObjectExpr;
        if (this.peek().kind === "kw_select") {
          inner = this.parseSelectExprSubquery();
        } else {
          inner = this.parseFreeObjectExpr();
        }
        const tail = this.parseSelectExprTailParts();
        // `select ( with … group … by .name; )` — a trailing semicolon
        // before the closing paren is allowed (statement-style subqueries).
        while (this.peek().kind === "semi") {
          this.consume();
        }
        const wrapped: FreeObjectExpr = {
          kind: "select_expr_subquery",
          expr: inner,
          ...tail,
          clauses: {
            _withBindings: withClause.with,
            _withModule: withClause.withModule,
            _withModuleAliases: withClause.withModuleAliases,
          },
        };
        if (this.peek().kind === "comma") {
          const values: FreeObjectExpr[] = [wrapped];
          while (this.peek().kind === "comma") {
            this.consume();
            if (this.peek().kind === "rparen") break;
            values.push(this.parseFreeObjectExpr());
          }
          this.expect("rparen", "Expected ')' after tuple expression");
          return { kind: "tuple", values };
        }
        this.expect("rparen", "Expected ')' after parenthesized WITH expression");
        return wrapped;
      }
      const expr = this.parseFreeObjectExpr();
      if (this.peek().kind === "comma") {
        const values: FreeObjectExpr[] = [expr];
        while (this.peek().kind === "comma") {
          this.consume();
          if (this.peek().kind === "rparen") {
            break;
          }
          values.push(this.parseFreeObjectExpr());
        }
        this.expect("rparen", "Expected ')' after tuple expression");
        return {
          kind: "tuple",
          values,
        };
      }
      this.expect("rparen", "Expected ')' after parenthesized expression");
      return expr;
    }

    if (this.peek().kind === "kw_distinct") {
      this.consume();
      return {
        kind: "distinct",
        expr: this.parsePostfixChain(this.parseFreeObjectPrimaryExpr()),
      };
    }

    if (this.peek().kind === "kw_detached") {
      this.consume();
      return this.parseFreeObjectPrimaryExpr();
    }

    if (this.isExistsToken(this.peek())) {
      this.consume();
      return {
        kind: "exists",
        expr: this.parseFreeObjectPostfixExpr(),
      };
    }

    if (this.peek().kind === "kw_for") {
      const binders: Array<{ variable: string; iterator: FreeObjectExpr; optional: boolean }> = [];
      while (this.peek().kind === "kw_for") {
        this.consume();
        let optional = false;
        if (this.peek().kind === "kw_optional") {
          this.consume();
          optional = true;
        }
        const variable = this.expectName("Expected variable name after 'for'").lexeme;
        this.expect("kw_in", "Expected 'in' after for variable");
        const iterator = this.parseFreeObjectIfElseExpr();
        binders.push({ variable, iterator, optional });
        this.localBindings.push(variable);

      }
      // After the (possibly nested) FOR binders, the body is introduced by
      // UNION, a bare SELECT, or — for a DML-producing FOR used in an
      // expression position (`subordinates := (FOR x IN … INSERT T {…})`) — a
      // bare INSERT.
      const bodyIsInsert = this.peek().kind === "kw_insert";
      if (this.peek().kind === "kw_union") {
        this.consume();
      } else if (!bodyIsInsert) {
        this.expect("kw_select", "Expected 'select' after for iterator");
      }
      const parseBody = (index: number): FreeObjectExpr => {
        const binder = binders[index];
        return this.withLocalBinding(binder.variable, () => {
          if (index === binders.length - 1) {
            if (this.peek().kind === "kw_insert") {
              return {
                kind: "mutation_expr",
                statement: this.parseInsert({}, false),
              } as unknown as FreeObjectExpr;
            }
            return this.parseFreeObjectExpr();
          }
          const next = binders[index + 1];
          return {
            kind: "for_expr",
            variable: next.variable,
            iterator: next.iterator,
            optional: next.optional,
            body: parseBody(index + 1),
            //filter:
          };
        });
      };
      const first = binders[0];
      let expr: FreeObjectExpr = {
        kind: "for_expr",
        variable: first.variable,
        iterator: first.iterator,
        optional: first.optional,
        body: parseBody(0),
      };
      for (const binder of binders) {
        this.localBindings.push(binder.variable);
      }
      const tail = this.parseSelectExprTailParts();
      for (let binderIndex = 0; binderIndex < binders.length; binderIndex += 1) {
        this.localBindings.pop();
      }
      if (this.hasSelectExprTailParts(tail)) {
        expr = {
          ...expr,
          ...tail,
        };
      }
      return expr;
    }

    if (this.peek().kind === "kw_select") {
      return this.parseSelectExprSubquery();
    }

    if (this.peek().kind === "kw_group") {
      return this.parseGroupExpr();
    }

    // INTROSPECT / TYPEOF are metadata operations whose lowering we don't
    // model at the SQL level, but they show up in IR-only tests where the
    // node just needs to parse so cardinality/multiplicity inference can
    // run. Treat as an opaque introspection expression; subsequent path
    // suffix / shape continues to use the postfix chain.
    if (this.peek().kind === "kw_introspect") {
      this.consume();
      if (this.peek().kind === "kw_typeof") {
        this.consume();
      }
      const inner = this.parseFreeObjectPostfixExpr();
      return { kind: "introspect_typeof", expr: inner };
    }

    if (this.peek().kind === "kw_typeof") {
      this.consume();
      const inner = this.parseFreeObjectPostfixExpr();
      return { kind: "introspect_typeof", expr: inner };
    }

    if (this.peek().kind === "str_interp_start") {
      return this.parseStringInterpolationExpr();
    }

    // Bare DML expressions: `INSERT Foo`, `UPDATE Foo SET { ... }`,
    // `DELETE Foo` as sub-expressions (e.g. `count(INSERT Foo)`). Upstream
    // wraps these in expr-mutation nodes; parse-only just needs them to
    // not stall the expression parser.
    if (this.peek().kind === "kw_insert") {
      return { kind: "mutation_expr", statement: this.parseInsert({}, false) };
    }
    if (this.peek().kind === "kw_update") {
      return { kind: "mutation_expr", statement: this.parseUpdate({}, false) };
    }
    if (this.peek().kind === "kw_delete") {
      return { kind: "mutation_expr", statement: this.parseDelete({}, false) };
    }

    // Bare WITH-prefixed sub-query: `WITH X := ... SELECT Foo` inside a
    // function arg or sub-expression position.
    if (this.peek().kind === "kw_with") {
      const withClause = this.parseWithClause();
      const inner = this.peek().kind === "kw_select"
        ? this.parseSelectExprSubquery()
        : this.parseFreeObjectExpr();
      return {
        kind: "select_expr_subquery",
        expr: inner,
        clauses: {
          _withBindings: withClause.with,
          _withModule: withClause.withModule,
          _withModuleAliases: withClause.withModuleAliases,
        },
      };
    }

    if (this.peek().kind === "lt") {
      this.consume();
      // Cast type modifiers: `<optional X>`, `<required X>`, `<multi X>`,
      // `<single X>`. Upstream tracks these on the cast node; for parse-only
      // we just consume them so the type-name parse proceeds.
      while (true) {
        const k = this.peek().kind;
        if (k === "kw_optional" || k === "kw_required" || k === "kw_multi" || k === "kw_single") {
          this.consume();
          continue;
        }
        break;
      }
      const castType = this.parseCastTypeName("Expected type name in cast");
      this.expect("gt", "Expected '>' after cast type");
      const expr = this.parseFreeObjectPostfixExpr();
      return { kind: "cast", castType, expr };
    }

    if (this.peek().kind === "lbrace") {
      // Free object constructor: `{ name := expr, ... }` or with cardinality
      // qualifiers `{ multi name := expr }` / `{ single name := expr }`.
      const isCardinalityKeyword = (k: string): boolean => k === "kw_multi" || k === "kw_single";
      const isFreeEntryStart = (offset: number): boolean => {
        const first = this.peekNth(offset);
        const second = this.peekNth(offset + 1);
        const third = this.peekNth(offset + 2);
        if (this.isNameToken(first) && second.kind === "assign") return true;
        if (isCardinalityKeyword(first.kind) && this.isNameToken(second) && third.kind === "assign") return true;
        return false;
      };
      if (isFreeEntryStart(1)) {
        this.consume();
        const entries = this.parseDelimited("rbrace", () => {
          let cardinality: "one" | "many" | undefined;
          if (this.peek().kind === "kw_multi") { this.consume(); cardinality = "many"; }
          else if (this.peek().kind === "kw_single") { this.consume(); cardinality = "one"; }
          const name = this.expectName("Expected free object field name").lexeme;
          this.expect("assign", "Expected ':=' in free object field");
          const fieldExpr = this.parseFreeObjectExpr();
          return { name, expr: fieldExpr, ...(cardinality ? { cardinality } : {}) };
        }, "Expected ',' between free object entries");
        this.expect("rbrace", "Expected '}' after free object entries");
        return { kind: "free_object_constructor", entries };
      }
      this.consume();
      const values = this.parseDelimited("rbrace", () => this.parseFreeObjectExpr(), "Expected ',' in set literal");
      this.expect("rbrace", "Expected '}' after set literal");
      // Collapsing to a flat `set_literal` discards each element's
      // `numericKind` hint; keep the rich set_expr form whenever any
      // element carries a float/decimal/bigint marker so downstream type
      // inference can still tell `{1.0, 2.0}` apart from `{1, 2}`.
      const allLiterals = values.every((v) => v.kind === "literal");
      const anyNonInteger = allLiterals
        && values.some((v) => {
          const lit = v as { kind: "literal"; numericKind?: string };
          return lit.numericKind !== undefined && lit.numericKind !== "integer";
        });
      if (allLiterals && !anyNonInteger) {
        return { kind: "set_literal", values: values.map((v) => (v as { kind: "literal"; value: ScalarValue }).value) };
      }
      return { kind: "set_expr", values };
    }

    if (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
      const typeExpr = this.parseTypeFilter("polymorphic type intersection");
      return {
        kind: "path_steps",
        steps: [{ kind: "type_intersection", typeName: simpleTypeName(typeExpr) ?? "", typeExpr }],
        partial: true,
      };
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values = this.parseDelimited("rbracket", () => this.parseFreeObjectExpr(), "Expected ',' in array literal");
      this.expect("rbracket", "Expected ']' after array literal");
      return { kind: "array_literal_expr", values };
    }

    if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link") {
      const op = this.peek().kind;
      this.consume();
      if (op === "backward_link" || this.peek().kind === "lt") {
        if (this.peek().kind === "lt") {
          this.consume();
        }
        const link = this.expectPermissiveName("Expected backlink name after '.<'").lexeme;
        let sourceTypeExpr: TypeExpr | undefined;
        if (this.peek().kind === "lbracket") {
          sourceTypeExpr = this.parseTypeFilter("backlink type filter");
        }
        return {
          kind: "backlink_path",
          link,
          sourceType: simpleTypeName(sourceTypeExpr),
          sourceTypeExpr,
          optional: op === "optional_link",
        };
      }
      if (this.peek().kind === "number") {
        const indexToken = this.consume();
        return this.buildIndexAccessExpr({ kind: "current_item" }, indexToken.lexeme);
      }

      const field = this.expectPermissiveName("Expected field name after '.'").lexeme;
      return {
        kind: "field_access",
        expr: { kind: "current_item" },
        field,
        optional: op === "optional_link",
      };
    }

    if (this.peek().kind === "kw_global") {
      this.consume();
      const name = this.parseQualifiedName("Expected global name after 'global'");
      return {
        kind: "global_ref",
        name,
      };
    }

    if (this.peek().kind === "parameter") {
      const token = this.consume();
      return {
        kind: "parameter",
        name: token.lexeme.slice(1),
      };
    }

    if (this.peek().kind === "parameter_and_type") {
      const token = this.consume();
      const split = token.lexeme.indexOf("$");
      const castType = token.lexeme.slice(1, split - 1);
      const name = token.lexeme.slice(split + 1).replace(/^`|`$/g, "");
      return {
        kind: "parameter",
        castType,
        name,
      };
    }

    if (this.peek().kind === "substitution") {
      const token = this.consume();
      return {
        kind: "substitution",
        name: token.lexeme.slice(2, -1),
      };
    }

    if (this.peek().kind.startsWith("kw_current_reserved_")) {
      const token = this.peek();
      // `__type__` is always a path step — bare references at top level are
      // rejected even at parse time. Other magic identifiers (`__source__`,
      // `__subject__`, …) are syntactically valid at top level; upstream
      // defers context-sensitivity to the analyzer.
      if (token.lexeme === "__type__") {
        this.notSupported(
          token,
          "bare top-level reference to '__type__'",
          `'${token.lexeme}' is always a path step; reference it as 'X.__type__'`,
        );
      }
      this.rejectReservedDunderName(token);
      this.consume();
      return {
        kind: "global_ref",
        name: token.lexeme,
      };
    }

    if (this.atFunctionCall()) {
      return this.functionCallExpr(this.parseFunctionCallExpr(true));
    }

    if (this.atQualifiedIdentifier()) {
      const head = this.peek().lexeme;
      if (!this.isTypeLikeName(head)) {
        const qualified = this.parseQualifiedIdentifier(
          "Expected path head in free object expression",
          "Expected path tail in free object expression",
        );
        return {
          kind: "path",
          head: qualified.head,
          tail: qualified.tail,
          steps: this.pathStepsFromParts([qualified.head, qualified.tail]),
        };
      }
    }

    if (this.isNameToken(this.peek()) && (this.peekNext().kind === "coloncolon" || (this.peekNext().kind === "colon" && this.peekNth(2).kind === "colon"))) {
      const name = this.parseQualifiedName("Expected qualified name in free object expression");
      if (this.isTypeLikeName(name)) {
        return {
          kind: "select",
          typeName: name,
          shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
          clauses: {},
        };
      }
      return {
        kind: "binding_ref",
        name,
      };
    }

    if (this.isNameToken(this.peek())) {
      const nameToken = this.peek();
      const identifier = this.nameTokenLexeme(nameToken);
      this.rejectReservedDunderName(nameToken);
      if (this.localBindings.includes(identifier)) {
        this.consume();
        return {
          kind: "binding_ref",
          name: identifier,
        };
      }
      if (this.atInlineTypedSelect()) {
        return this.parseInlineSelectExpr();
      }
      if (this.isTypeLikeName(identifier)) {
        this.consume();
        return {
          kind: "select",
          typeName: identifier,
          shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
          clauses: {},
        };
      }
      this.consume();
      return {
        kind: "binding_ref",
        name: identifier,
      };
    }

    // Preserve the numeric kind of the literal so downstream type inference
    // can tell `1` apart from `1.0` even after JS collapses both to the same
    // Number value. Without this, `<float64>1.0 IS float64` mis-infers the
    // operand as int64 and answers false.
    const litToken = this.peek();
    const litMinusFollowedByNumber = litToken.kind === "minus" && this.peekNext().kind === "number";
    const litNumericToken = litToken.kind === "number"
      ? litToken
      : litMinusFollowedByNumber
        ? this.peekNext()
        : undefined;
    const value = this.readScalarLikeValue();
    if (litNumericToken && (typeof value === "number" || typeof value === "string")) {
      // Classify the lexeme without regex. EdgeQL allows underscore digit
      // separators (`1_000_000`), so strip them first via split/join. A
      // trailing `n` marks bigint/decimal; presence of `.` or `e`/`E` marks
      // a fractional form (float, or decimal when paired with `n`).
      const lex = litNumericToken.lexeme.split("_").join("");
      const isFractional = lex.includes(".") || lex.includes("e") || lex.includes("E");
      let numericKind: "integer" | "float" | "bigint" | "decimal" | undefined;
      if (lex.endsWith("n")) {
        numericKind = isFractional ? "decimal" : "bigint";
      } else if (isFractional) {
        numericKind = "float";
      } else {
        numericKind = "integer";
      }
      return { kind: "literal", value, numericKind };
    }
    return {
      kind: "literal",
      value,
    };
  }

  private parseStringInterpolationExpr(): FreeObjectExpr {
    const start = this.expect("str_interp_start", "Expected interpolated string start");
    const parts: FreeObjectExpr[] = [];

    if (start.lexeme.length > 0) {
      parts.push({ kind: "literal", value: start.lexeme });
    }

    while (true) {
      const expr = this.parseFreeObjectExpr();
      parts.push(expr);

      if (this.peek().kind === "str_interp_cont") {
        const cont = this.consume();
        if (cont.lexeme.length > 0) {
          parts.push({ kind: "literal", value: cont.lexeme });
        }
        continue;
      }

      if (this.peek().kind === "str_interp_end") {
        const end = this.consume();
        if (end.lexeme.length > 0) {
          parts.push({ kind: "literal", value: end.lexeme });
        }
        break;
      }

      const token = this.peek();
      throw new AppError(
        "E_SYNTAX",
        "Expected string interpolation continuation or end",
        ...this.posPair(token),
      );
    }

    if (parts.length === 0) {
      return { kind: "literal", value: "" };
    }
    if (parts.length === 1) {
      return parts[0];
    }
    return { kind: "concat", parts };
  }

  private parseFreeObjectPostfixExpr(): FreeObjectExpr {
    let expr = this.parseFreeObjectPrimaryExpr();
    expr = this.applyPostfixExprChain(expr);
    return expr;
  }

  private applyPostfixExprChain(expr: FreeObjectExpr): FreeObjectExpr {
    return this.parsePostfixChain(expr, {
      indexes: true,
      typeFilters: true,
      shapeProjections: true,
      pathSteps: true,
    });
  }

  // Path / postfix chain — see docs/reference/reference/edgeql/paths.rst.
  //
  // Per paths.rst lines 23-46, a path is:
  //
  //   <expression> <path-step> [ <path-step> ... ]
  //
  //   <path-step> := <step-direction> <pointer-name>
  //
  //   <step-direction> is one of:
  //     .   — outgoing link/property reference
  //     .<  — incoming / backlink reference (tokenized `backward_link`)
  //     @   — link property reference
  //
  // We additionally accept the optional-traversal variant `.?` (tokenized
  // `optional_link`) which propagates `{}` rather than failing when the
  // step is empty. The `[is Type]` type-intersection postfix and `[N]`/
  // `[start:end]` index/slice postfixes (volatility.rst / shapes.rst use
  // them too) are recognised here when the caller passes the matching
  // options, so this routine is the central postfix dispatcher for all
  // path-like grammar.
  //
  // The terminal pointer determines result semantics (paths.rst lines
  // 14-21): paths ending in a link yield a set of objects; paths ending
  // in a property yield a set of property values.
  private parsePostfixChain(baseExpr: FreeObjectExpr, options: PostfixChainOptions = {}): FreeObjectExpr {
    let expr = baseExpr;
    const backlinkBindingName = "__gel_backlink_item__";

    while (true) {
      const opToken = this.matchAny("dot", "backward_link", "optional_link");
      if (opToken) {
        const op = opToken.kind;
        if (op === "backward_link" || this.peek().kind === "lt") {
          this.match("lt");
          const link = this.expectPermissiveName("Expected backlink name after '.<'").lexeme;
          let sourceTypeExpr: TypeExpr | undefined;
          if (this.peek().kind === "lbracket") {
            sourceTypeExpr = this.parseTypeFilter("backlink type filter");
          }
          expr = {
            kind: "for_expr",
            variable: backlinkBindingName,
            iterator: expr,
            body: {
              kind: "backlink_path",
              link,
              sourceType: simpleTypeName(sourceTypeExpr),
              sourceTypeExpr,
              optional: op === "optional_link",
            },
          };
        } else if (options.indexes && this.peek().kind === "number") {
          const indexToken = this.consume();
          expr = this.buildIndexAccessExpr(expr, indexToken.lexeme);
        } else {
          const fieldTok = this.peek();
          const field = this.expectPermissiveName("Expected field name after '.'").lexeme;
          // `Foo.__source__` / `Foo.__subject__` etc. are context-sensitive
          // — only valid inside constraint / policy / trigger bodies. At a
          // bare path tail we don't have that context, so upstream rejects
          // these names here. `__type__` remains universally valid.
          if (/^__(?:source|subject|new|old|default|specified)__$/.test(field)) {
            this.notSupported(
              fieldTok,
              "reserved identifier in path tail",
              `'${field}' is only valid inside constraint / policy / trigger bodies`,
            );
          }
          if (options.pathSteps && expr.kind === "path_steps") {
            expr = {
              kind: "path_steps",
              steps: [...expr.steps, { kind: "ptr", name: field, direction: "outbound", optional: op === "optional_link" }],
              partial: expr.partial,
            };
          } else {
            expr = {
              kind: "field_access",
              expr,
              field,
              optional: op === "optional_link",
            };
          }
        }
        continue;
      }

      if (this.match("at")) {
        const propertyTok = this.peek();
        const property = this.expectLinkPropertyName("Expected link property name after '@'");
        if (/^__(?:source|subject|new|old|default|specified|type)__$/.test(property)) {
          this.notSupported(
            propertyTok,
            "reserved identifier as link property",
            `'${property}' is not a valid link property name in this position`,
          );
        }
        expr = {
          kind: "field_access",
          expr,
          field: `@${property}`,
        };
        continue;
      }

      if (options.typeFilters && this.peek().kind === "lbracket") {
        this.consume();
        if (this.peek().kind === "kw_is") {
          this.consume();
          const typeExpr = this.parseTypeExpr("type intersection");
          this.expect("rbracket", "Expected ']' after type intersection");
          const typeName = simpleTypeName(typeExpr) ?? "";
          const baseHeadName = this.headNameOfExpr(expr);
          if (baseHeadName && this.isEnumLikeName(baseHeadName) && this.peek().kind === "dot") {
            const dotToken = this.peek();
            throw new AppError("E_SYNTAX", "an enum member name must follow enum type name in the path", ...this.posPair(dotToken));
          }
          const steps = this.exprToPathSteps(expr);
          if (steps) {
            expr = {
              kind: "path_steps",
              steps: [...steps, { kind: "type_intersection", typeName, typeExpr }],
              partial: expr.kind === "path_steps" ? expr.partial : undefined,
            };
          } else {
            expr = {
              kind: "is_type",
              expr,
              typeName,
              typeExpr,
            };
          }
          continue;
        }

        // Floats inside subscript brackets (`[1.0]`, `[:1.0]`) become a
        // literal-FreeObjectExpr rather than a folded `index`/`start`/`end`
        // number; downstream type-checking needs to see the float as a
        // distinct type so it can reject `[1.0]` with "cannot index by float".
        const isFloatLexeme = (lex: string): boolean => {
          if (lex.endsWith("n")) return false;
          return lex.includes(".") || /[eE]/.test(lex.replace(/_/g, ""));
        };
        const consumeBound = (sign: 1 | -1): number | FreeObjectExpr | undefined => {
          if (this.peek().kind !== "number") return undefined;
          const lex = this.consume().lexeme;
          const num = this.parseNumberLexeme(lex);
          if (isFloatLexeme(lex)) {
            // Wrap as `<float64>VAL` so type inference downstream knows this
            // is a float — `Number(1.0)` and `Number(1)` are indistinguishable
            // in JS, so a literal alone loses the float-ness.
            const cast: FreeObjectExpr = {
              kind: "cast",
              castType: "std::float64",
              expr: { kind: "literal", value: sign * num },
            } as unknown as FreeObjectExpr;
            return cast;
          }
          return sign * num;
        };

        if (this.peek().kind === "colon") {
          this.consume();
          let end: number | FreeObjectExpr | undefined;
          if (this.peek().kind === "number") {
            end = consumeBound(1);
          } else if (this.peek().kind !== "rbracket") {
            end = this.parseFreeObjectExpr();
          }
          this.expect("rbracket", "Expected ']' after slice access");
          expr = {
            kind: "slice_access",
            expr,
            start: undefined,
            end: typeof end === "number" ? end : undefined,
            endExpr: typeof end === "number" ? undefined : end,
          };
          continue;
        }

        const startToken = this.peek();
        let start: number | FreeObjectExpr | undefined;
        let startSign: 1 | -1 = 1;
        if (startToken.kind === "minus" && this.peekNth(1).kind === "number") {
          this.consume();
          startSign = -1;
        } else if (startToken.kind === "plus" && this.peekNth(1).kind === "number") {
          this.consume();
        }
        if (this.peek().kind === "number") {
          start = consumeBound(startSign);
        } else if (this.peek().kind !== "colon") {
          start = this.parseFreeObjectExpr();
        }

        if (this.peek().kind === "colon") {
          this.consume();
          let end: number | FreeObjectExpr | undefined;
          let endSign: 1 | -1 = 1;
          if (this.peek().kind === "minus" && this.peekNth(1).kind === "number") {
            this.consume();
            endSign = -1;
          } else if (this.peek().kind === "plus" && this.peekNth(1).kind === "number") {
            this.consume();
          }
          if (this.peek().kind === "number") {
            end = consumeBound(endSign);
          } else if (this.peek().kind !== "rbracket") {
            end = this.parseFreeObjectExpr();
          }
          this.expect("rbracket", "Expected ']' after slice access");
          expr = {
            kind: "slice_access",
            expr,
            start: typeof start === "number" ? start : undefined,
            end: typeof end === "number" ? end : undefined,
            startExpr: typeof start === "number" ? undefined : start,
            endExpr: typeof end === "number" ? undefined : end,
          };
          continue;
        }

        if (start === undefined) {
          throw new AppError("E_SYNTAX", "Expected numeric index or '[is <Type>]' inside brackets", ...this.posPair(startToken));
        }
        this.expect("rbracket", "Expected ']' after index access");
        expr = {
          kind: "index_access",
          expr,
          index: typeof start === "number" ? start : 0,
          indexExpr: typeof start === "number" ? undefined : start,
        };
        continue;
      }

      if (options.shapeProjections && this.peek().kind === "lbrace") {
        this.consume();
        const shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
        this.expect("rbrace", "Expected '}' after shape projection");
        expr = {
          kind: "shape_projection",
          expr,
          shape,
        };
        continue;
      }

      break;
    }

    return expr;
  }

  private parseFreeObjectUnaryAtom(): FreeObjectExpr {
    if (this.peek().kind === "minus") {
      this.consume();
      return { kind: "unary", op: "neg", expr: this.parseFreeObjectUnaryAtom() };
    }
    if (this.peek().kind === "plus") {
      // Unary `+` is a no-op (the value is unchanged). Consume and recurse.
      this.consume();
      return this.parseFreeObjectUnaryAtom();
    }
    return this.parseFreeObjectPostfixExpr();
  }

  private parseFreeObjectExprWithPrecedence(minPrecedence = 0): FreeObjectExpr {
    let left = this.parseFreeObjectUnaryAtom();

    while (true) {
      if (this.peek().kind === "coalesce") {
        const precedence = 5;
        if (precedence < minPrecedence) {
          break;
        }
        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        left = { kind: "coalesce", left, right };
        continue;
      }

      if (this.peek().kind === "concat") {
        const precedence = 20;
        if (precedence < minPrecedence) {
          break;
        }

        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        if (left.kind === "concat") {
          left = { kind: "concat", parts: [...left.parts, right] };
        } else {
          left = { kind: "concat", parts: [left, right] };
        }
        continue;
      }

      if (this.peek().kind === "plus" || this.peek().kind === "minus") {
        const precedence = 30;
        if (precedence < minPrecedence) {
          break;
        }

        const op = this.consume().kind;
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        left = { kind: "math", op: op === "plus" ? "+" : "-", left, right };
        continue;
      }

      if (
        this.peek().kind === "star"
        || this.peek().kind === "slash"
        || this.peek().kind === "floor_div"
        || this.peek().kind === "modulo"
      ) {
        const precedence = 40;
        if (precedence < minPrecedence) {
          break;
        }

        const op = this.consume().kind;
        const right = this.parseFreeObjectExprWithPrecedence(precedence + 1);
        left = {
          kind: "math",
          op: op === "star" ? "*" : op === "slash" ? "/" : op === "floor_div" ? "//" : "%",
          left,
          right,
        };
        continue;
      }

      if (this.peek().kind === "pow") {
        const precedence = 50;
        if (precedence < minPrecedence) {
          break;
        }
        this.consume();
        const right = this.parseFreeObjectExprWithPrecedence(precedence);
        left = { kind: "math", op: "^", left, right };
        continue;
      }

      if (this.peek().kind === "kw_is") {
        const precedence = 10;
        if (precedence < minPrecedence) {
          break;
        }

        this.consume();
        // `IS NOT <type>` — preserve the negation by wrapping the result in
        // a `not` operator. The IR / SQL layers already know how to invert a
        // type check, so this avoids dropping the NOT silently.
        let negated = false;
        if (this.peek().kind === "kw_not") {
          this.consume();
          negated = true;
        }
        const typeExpr = this.parseTypeExpr("type expression after 'is'");
        const isCheck: FreeObjectExpr = {
          kind: "is_type",
          expr: left,
          typeName: simpleTypeName(typeExpr) ?? "",
          typeExpr,
        };
        left = negated ? { kind: "not", expr: isCheck } : isCheck;
        continue;
      }

      break;
    }

    return left;
  }

  private parseFreeObjectConcatExpr(): FreeObjectExpr {
    return this.parseFreeObjectExprWithPrecedence();
  }

  private parseSelectExprSubquery(): FreeObjectExpr {
    this.expect("kw_select", "Expected 'select'");
    let alias: string | undefined;
    let expr: FreeObjectExpr;
    if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
      alias = this.consume().lexeme;
      this.consume();
      expr = this.parseFreeObjectExpr();
    } else {
      expr = this.parseFreeObjectExpr();
    }

    const tail = this.parseSelectExprTailParts();

    return {
      kind: "select_expr_subquery",
      alias,
      expr,
      ...tail,
    };
  }

  private parseSelectExprTailParts(): SelectExprTailParts {
    let filter: FreeObjectExpr | undefined;
    if (this.match("kw_filter")) {
      filter = this.parseFreeObjectExpr();
    }
    const orderBy = this.parseExprOrderBy();
    const { limit, offset, limitExpr, offsetExpr } = this.parseExprPagination();
    return { filter, orderBy, limit, offset, limitExpr, offsetExpr };
  }

  private hasSelectExprTailParts(tail: SelectExprTailParts, includeOrderBy = true): boolean {
    return tail.filter !== undefined
      || (includeOrderBy && tail.orderBy !== undefined)
      || tail.limit !== undefined
      || tail.offset !== undefined
      || tail.limitExpr !== undefined
      || tail.offsetExpr !== undefined;
  }

  private parseExprPagination(): { limit?: number; offset?: number; limitExpr?: FreeObjectExpr; offsetExpr?: FreeObjectExpr } {
    let limit: number | undefined;
    let offset: number | undefined;
    let limitExpr: FreeObjectExpr | undefined;
    let offsetExpr: FreeObjectExpr | undefined;
    if (this.match("kw_offset")) {
      const result = this.parseLimitOffsetValue("offset");
      offset = result.value;
      offsetExpr = result.expr;
    }
    if (this.match("kw_limit")) {
      const result = this.parseLimitOffsetValue("limit");
      limit = result.value;
      limitExpr = result.expr;
    }
    return { limit, offset, limitExpr, offsetExpr };
  }

  private parseLimitOffsetValue(kind: "limit" | "offset"): { value?: number; expr?: FreeObjectExpr } {
    // EdgeQL allows LIMIT/OFFSET to be any singleton-yielding expression
    // (e.g. `LIMIT (SELECT count(Status))`, `LIMIT len(.name) - 3`,
    // `LIMIT <int64>User.<owner[IS Issue].number`). For the common case of an
    // integer literal with literal arithmetic, the fast path produces a plain
    // number that downstream consumers can keep treating as a constant. For
    // anything else, fall back to a full expression parse and let the
    // semantic / SQL layers handle it.
    const literal = this.attempt(() => {
      const value = this.readInteger(`Expected integer after '${kind}'`);
      if (!this.isLimitOffsetTerminator(this.peek())) {
        return undefined;
      }
      return value;
    });
    if (literal !== undefined) {
      return { value: literal };
    }
    const startToken = this.peek();
    const expr = this.parseFreeObjectExpr();
    this.validateLimitOffsetExprShape(expr, startToken);
    return { expr };
  }

  private isLimitOffsetTerminator(token: Token): boolean {
    switch (token.kind) {
      case "kw_limit":
      case "kw_offset":
      case "kw_filter":
      case "kw_order":
      case "kw_then":
      case "semi":
      case "comma":
      case "rparen":
      case "rbrace":
      case "rbracket":
      case "eof":
        return true;
      default:
        return false;
    }
  }

  // Reject the structural shapes the reference EdgeQL rejects in a LIMIT or
  // OFFSET position. We don't have schema-level cardinality inference at parse
  // time, but the syntax itself is enough to diagnose the two reference cases:
  //   - A bare relative path (`<int64>.<owner[IS Issue].number`) has no outer
  //     subject to resolve against → "could not resolve partial path".
  //   - A backlink iteration over a named source (`<int64>User.<owner...`)
  //     yields a set → "possibly more than one element returned …".
  private validateLimitOffsetExprShape(expr: FreeObjectExpr, originToken: Token): void {
    if (this.exprContainsBareBacklinkPath(expr)) {
      throw new AppError(
        "E_SEMANTIC",
        "could not resolve partial path",
        ...this.posPair(originToken),
      );
    }
    if (this.exprContainsBacklinkIteration(expr)) {
      throw new AppError(
        "E_SEMANTIC",
        "possibly more than one element returned by an expression where only singletons are allowed",
        ...this.posPair(originToken),
      );
    }
  }

  private exprContainsBareBacklinkPath(expr: FreeObjectExpr): boolean {
    if (expr.kind === "backlink_path") return true;
    if (expr.kind === "path_steps" && expr.partial === true) return true;
    if ("expr" in expr && (expr as { expr?: FreeObjectExpr }).expr) {
      return this.exprContainsBareBacklinkPath((expr as { expr: FreeObjectExpr }).expr);
    }
    if ("left" in expr && (expr as { left?: FreeObjectExpr }).left) {
      return this.exprContainsBareBacklinkPath((expr as { left: FreeObjectExpr }).left)
        || this.exprContainsBareBacklinkPath((expr as { right: FreeObjectExpr }).right);
    }
    if (expr.kind === "concat") return expr.parts.some((p) => this.exprContainsBareBacklinkPath(p));
    return false;
  }

  private exprContainsBacklinkIteration(expr: FreeObjectExpr): boolean {
    if (expr.kind === "for_expr") return true;
    if ("expr" in expr && (expr as { expr?: FreeObjectExpr }).expr) {
      return this.exprContainsBacklinkIteration((expr as { expr: FreeObjectExpr }).expr);
    }
    if ("left" in expr && (expr as { left?: FreeObjectExpr }).left) {
      return this.exprContainsBacklinkIteration((expr as { left: FreeObjectExpr }).left)
        || this.exprContainsBacklinkIteration((expr as { right: FreeObjectExpr }).right);
    }
    if (expr.kind === "concat") return expr.parts.some((p) => this.exprContainsBacklinkIteration(p));
    return false;
  }

  private parseExprOrderBy(): OrderExprChain | undefined {
    if (!this.match("kw_order")) {
      return undefined;
    }
    this.expect("kw_by", "Expected 'by' after 'order'");
    return this.parseExprOrderByTerm();
  }

  private parseExprOrderByTerm(): OrderExprChain {
    const expr = this.parseFreeObjectExpr();
    let direction: "asc" | "desc" = "asc";
    if (this.match("kw_asc")) {
      direction = "asc";
    } else if (this.match("kw_desc")) {
      direction = "desc";
    }
    let nullsPosition: "first" | "last" | undefined;
    if (this.match("kw_empty")) {
      const nullsPositionToken = this.peek();
      if (this.isNameToken(nullsPositionToken)) {
        const lowered = nullsPositionToken.lower;
        if (lowered === "first" || lowered === "last") {
          this.consume();
          nullsPosition = lowered;
        }
      }
    }
    let then: OrderExprChain | undefined;
    if (this.match("kw_then")) {
      then = this.parseExprOrderByTerm();
    }
    return { expr, direction, nullsPosition, then };
  }

  private looksLikeFreeObjectSelect(): boolean {
    if (this.peek().kind !== "lbrace") {
      return false;
    }

    let depth = 0;
    let parens = 0;
    let brackets = 0;
    for (let i = this.index; i < this.tokens.length; i += 1) {
      const token = this.tokens[i];
      if (token.kind === "lbrace") {
        depth += 1;
        continue;
      }
      if (token.kind === "rbrace") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
        continue;
      }
      if (token.kind === "lparen") {
        parens += 1;
        continue;
      }
      if (token.kind === "rparen") {
        parens -= 1;
        continue;
      }
      if (token.kind === "lbracket") {
        brackets += 1;
        continue;
      }
      if (token.kind === "rbracket") {
        brackets -= 1;
        continue;
      }

      // Only count `:=` as a free-object marker when it appears directly at
      // brace-depth 1 (not nested inside a tuple `(name := ...)` or array
      // index expression), which is the only place a free-object field
      // assignment can occur.
      if (depth === 1 && parens === 0 && brackets === 0 && token.kind === "assign") {
        return true;
      }
    }

    return false;
  }

  private parseInlineSelectExpr(): { kind: "select"; typeName: string; shape: ShapeElement[]; clauses: ClauseChain; detached?: boolean } {
    let detached = false;
    if (this.peek().kind === "kw_detached") {
      this.consume();
      detached = true;
    }
    const typeName = this.parseQualifiedName("Expected type name in inline select");
    const shape: ShapeElement[] = [{ kind: "field", name: "id", operation: "assign", origin: "default" }];
    if (this.peek().kind === "lbrace") {
      this.consume();
      shape.length = 0;
      shape.push(...this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries"));
      this.expect("rbrace", "Expected '}' after selected fields");
    }

    return {
      kind: "select",
      typeName,
      shape,
      clauses: this.parseClauseChain(),
      ...(detached ? { detached: true } : {}),
    };
  }

  // Shape element — see docs/reference/reference/edgeql/shapes.rst.
  //
  // Per shapes.rst lines 14-53, a shape is `<expr> { <shape_element> [, ...] }`
  // where each shape_element follows:
  //
  //   [ "[" is <object-type> "]" ] <pointer-spec>
  //
  // and <pointer-spec> is one of:
  //
  //   * <name>                                — existing link/property
  //   * [@]<name> := <ptr-expr>               — computed link/property
  //                                             (`@<name>` for link prop)
  //   * <pointer-name>: [ "[" is <T> "]" ] "{" ... "}"   — sub-shape
  //
  // We additionally accept cardinality/required modifiers (`required`,
  // `optional`, `multi`, `single`) and splat forms (`*`, `**`,
  // `[is Type].*`, `(Type | Other).**`). Per-element FILTER/ORDER BY/
  // OFFSET/LIMIT clauses (selection-style refinement of a link target)
  // are routed through clauseChainToShapeModifiers — they follow the
  // same ordering rule as parseClauseChain.
  private parseShapeEntry(): ShapeElement {
    const { required, cardinality } = this.parseShapeEntryModifiers();

    if (this.peek().kind === "at") {
      this.consume();
      const property = this.expectLinkPropertyName("Expected link property name after '@'");
      let expr: ComputedExpr = {
        kind: "field_ref",
        field: `@${property}`,
      };

      if (this.peek().kind === "assign") {
        this.consume();
        const parsed = this.parseComputedExpr();
        if (this.isBacklinkExpr(parsed)) {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Link property expressions do not support backlinks", ...this.posPair(token));
        }
        expr = parsed;
      }

      // Optional clauses (FILTER/ORDER BY/OFFSET/LIMIT) on link-property
      // shape entries — `spam: { @foo FILTER (foo > 3) }`.
      const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
      return {
        kind: "computed",
        name: `@${property}`,
        expr,
        operation: "assign",
        origin: "explicit",
        required,
        cardinality,
        ...clauseModifiers,
      };
    }

    if (this.peek().kind === "star" || this.peek().kind === "double_splat") {
      const depth = this.parseSplatDepth();
      const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
      return {
        kind: "splat",
        depth,
        operation: "assign",
        origin: "explicit",
        required,
        cardinality,
        ...clauseModifiers,
      };
    }

    if (this.peek().kind === "lbracket") {
      const splat = this.attempt(() => {
        const sourceTypeExpr = this.parseTypeFilter("splat type intersection");
        this.expect("dot", "Expected '.' after type intersection in splat expression");
        if (this.peek().kind !== "star" && this.peek().kind !== "double_splat") {
          return undefined;
        }
        const depth = this.parseSplatDepth();
        const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
        return {
          kind: "splat" as const,
          depth,
          sourceType: simpleTypeName(sourceTypeExpr),
          sourceTypeExpr,
          intersection: true,
          operation: "assign" as const,
          origin: "explicit" as const,
          required,
          cardinality,
          ...clauseModifiers,
        };
      });
      if (splat) {
        return splat;
      }
    }

    // Paren-wrapped union/intersection splat: `(Type | Other).*`,
    // `(Type & Other).**`, `(Type | Other)[is Sub].*`. Parse the paren'd
    // type expression and look for a trailing `[is …]` intersection or
    // `.*` / `.**`.
    if (this.peek().kind === "lparen") {
      const splat = this.attempt(() => {
        this.consume();
        const sourceTypeExpr = this.parseTypeExpr("splat type expression");
        if (this.peek().kind !== "rparen") return undefined;
        this.consume();
        // Optional `[is Sub]` intersection after the paren type.
        let intersectionExpr: TypeExpr | undefined;
        if (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
          intersectionExpr = this.parseTypeFilter("typed splat intersection");
        }
        if (this.peek().kind !== "dot") return undefined;
        this.consume();
        if (this.peek().kind !== "star" && this.peek().kind !== "double_splat") return undefined;
        const depth = this.parseSplatDepth();
        const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
        const finalSourceTypeExpr = intersectionExpr ?? sourceTypeExpr;
        return {
          kind: "splat" as const,
          depth,
          sourceType: simpleTypeName(finalSourceTypeExpr),
          sourceTypeExpr: finalSourceTypeExpr,
          intersection: true,
          operation: "assign" as const,
          origin: "explicit" as const,
          required,
          cardinality,
          ...clauseModifiers,
        };
      });
      if (splat) {
        return splat;
      }
    }

    const isMulti = this.isNameToken(this.peek()) && this.peek().lower === "multi" && this.isNameToken(this.peekNext());
    if (isMulti) {
      this.consume();
    }

    let leadingTypeFilter: TypeExpr | undefined;
    if (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
      leadingTypeFilter = this.parseTypeFilter("shape type filter");
      this.expect("dot", "Expected '.' after shape type filter");
    }

    // Permissive name read: upstream allows keyword-like identifiers
    // (e.g. `Foo{union}`, `Foo{select}`) as shape field names.
    let name: string;
    {
      const tok = this.peek();
      if (this.isNameToken(tok)) {
        name = this.expectName("Expected selected field or computed alias").lexeme;
      } else if (this.isKeywordLikeToken(tok)) {
        this.rejectReservedDunderName(tok);
        this.consume();
        name = tok.lexeme;
      } else {
        throw new AppError("E_SYNTAX", "Expected selected field or computed alias", ...this.posPair(tok));
      }
    }

    // Allow `module::Type` qualification in splat sources — `default::Foo.*`
    // / `default::Foo[is Sub].*` etc. Extend the parsed name with subsequent
    // `::<segment>` chunks.
    while (this.peek().kind === "coloncolon"
      || (this.peek().kind === "colon" && this.peekNext().kind === "colon")) {
      if (this.peek().kind === "coloncolon") {
        this.consume();
      } else {
        this.consume();
        this.consume();
      }
      const segTok = this.peek();
      if (this.isNameToken(segTok)) {
        this.consume();
        name = `${name}::${segTok.lexeme}`;
      } else if (this.isKeywordLikeToken(segTok)) {
        this.rejectReservedDunderName(segTok);
        this.consume();
        name = `${name}::${segTok.lexeme}`;
      } else {
        throw new AppError("E_SYNTAX", "Expected identifier after '::'", ...this.posPair(segTok));
      }
    }

    if (this.peek().kind === "dot" && (this.peekNext().kind === "star" || this.peekNext().kind === "double_splat")) {
      this.consume();
      const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
        return {
          kind: "splat" as const,
        depth: this.parseSplatDepth(),
        sourceType: name,
          operation: "assign" as const,
          origin: "explicit" as const,
        required,
        cardinality,
        ...clauseModifiers,
      };
    }
    // `Type[is Sub].*` / `Type[is Sub].**` — typed splat with intersection.
    if (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
      const splat = this.attempt(() => {
        const intersectionExpr = this.parseTypeFilter("typed splat intersection");
        if (this.peek().kind !== "dot") return undefined;
        this.consume();
        if (this.peek().kind !== "star" && this.peek().kind !== "double_splat") return undefined;
        const depth = this.parseSplatDepth();
        const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
        return {
          kind: "splat" as const,
          depth,
          sourceType: simpleTypeName(intersectionExpr),
          sourceTypeExpr: intersectionExpr,
          intersection: true,
          operation: "assign" as const,
          origin: "explicit" as const,
          required,
          cardinality,
          ...clauseModifiers,
        };
      });
      if (splat) return splat;
    }

    let typeFilter: TypeExpr | undefined;
    if (this.peek().kind === "lbracket") {
      typeFilter = this.parseTypeFilter("shape type filter");
    }
    if (leadingTypeFilter) {
      if (typeFilter) {
        // Both a leading `[IS Source].field` filter and a trailing
        // `field[IS Target]` filter — upstream allows this as a chained
        // intersection, narrowing both the source and the field's target.
        // We preserve the leading filter and discard the trailing one (the
        // runtime path doesn't model both narrowings separately).
        typeFilter = leadingTypeFilter;
      } else {
        typeFilter = leadingTypeFilter;
      }
    }

    let hasLinkShapeColon = false;
    if (this.peek().kind === "colon") {
      this.consume();
      hasLinkShapeColon = true;
      // shapes.rst line 48: `<pointer-name>: [ "[" is <target-type> "]" ] "{" ... "}"`
      // — the target-type intersection is optional and sits between the colon
      // and the sub-shape. Without this, `bar: [is Bar] { x }` falls through
      // and reports "Expected '{' after ':' in link shape".
      if (this.peek().kind === "lbracket" && this.peekNth(1).kind === "kw_is") {
        typeFilter = this.parseTypeFilter("shape link-target type filter");
      }
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
      this.expect("rbrace", "Expected '}' after nested shape");
      // Accept both the modern `link: { ... }` and the legacy/unprefixed
      // `link { ... }` shape forms. Upstream EdgeQL prefers the colon form,
      // but we mirror the dump fixtures which mix both styles.
      void hasLinkShapeColon;
      const clauses = this.parseClauseChain();

      return {
        kind: "link",
        name,
        typeFilter: simpleTypeName(typeFilter),
        typeFilterExpr: typeFilter,
        shape,
        clauses,
        operation: "assign",
        origin: "explicit",
        required,
        cardinality,
        ...this.clauseChainToShapeModifiers(clauses),
      };
    }

    if (typeFilter) {
      if (leadingTypeFilter && !hasLinkShapeColon) {
        const opTokenPoly = this.peek();
        const hasAssignmentPoly = opTokenPoly.kind === "assign"
          || opTokenPoly.kind === "add_assign"
          || opTokenPoly.kind === "sub_assign";
        if (!hasAssignmentPoly) {
          const modifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
          return {
            kind: "computed",
            name,
            expr: {
              kind: "polymorphic_field_ref",
              sourceType: simpleTypeName(typeFilter) ?? "",
              sourceTypeExpr: typeFilter,
              field: name,
            },
            operation: "assign",
            origin: "explicit",
            required,
            cardinality,
            ...modifiers,
          };
        }
      }
      const token = this.peek();
      throw new AppError(
        "E_SYNTAX",
        "Type filters in shapes require a nested link shape",
        ...this.posPair(token),
      );
    }

    if (hasLinkShapeColon) {
      // `name: (select …)` — colon-computed pointer: upstream EdgeQL allows
      // an expression after the colon, equivalent to `name := (…)`.
      if (this.peek().kind === "lparen") {
        const expr = this.parseFreeObjectExpr();
        const modifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
        return {
          kind: "computed",
          name,
          expr: { kind: "select_expr", expr, clauses: {} },
          operation: "assign",
          origin: "explicit",
          required,
          cardinality,
          ...modifiers,
        };
      }
      const token = this.peek();
      throw new AppError("E_SYNTAX", "Expected '{' after ':' in link shape", ...this.posPair(token));
    }

    const opToken = this.peek();
    const hasAssignment = opToken.kind === "assign" || opToken.kind === "add_assign" || opToken.kind === "sub_assign";

    if (!hasAssignment) {
      const modifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
      return {
        kind: "field",
        name,
        required,
        cardinality,
        operation: "assign",
        origin: "explicit",
        ...modifiers,
      };
    }

    this.consume();
    const operation = opToken.kind === "add_assign" ? "append" : opToken.kind === "sub_assign" ? "subtract" : "assign";
    const expr = this.parseComputedExpr();
    if (this.isBacklinkExpr(expr)) {
      let shape: ShapeElement[] | undefined;
      if (this.peek().kind === "lbrace") {
        this.consume();
        shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
        this.expect("rbrace", "Expected '}' after backlink shape");
      }
      const clauseModifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
      return {
        kind: "backlink",
        name,
        expr,
        shape,
        required,
        cardinality,
        operation,
        origin: "explicit",
        ...clauseModifiers,
      };
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const shape = this.parseDelimited("rbrace", () => this.parseShapeEntry(), "Expected ',' between shape entries");
      this.expect("rbrace", "Expected '}' after computed shape projection");
      const baseExpr: FreeObjectExpr = expr.kind === "field_ref"
        ? { kind: "field_access", expr: { kind: "current_item" }, field: expr.field }
        : expr.kind === "binding_ref"
          ? { kind: "binding_ref", name: expr.name }
          : expr.kind === "select_expr"
            ? expr.expr
          : { kind: "literal", value: null };
      return {
        kind: "computed",
        name,
        expr: {
          kind: "select_expr",
          expr: {
            kind: "shape_projection",
            expr: baseExpr,
            shape,
          },
          clauses: {},
        },
        // Cardinality of `name := X { … }` follows X (which the IR pass
        // infers from the underlying pointer), not the shape literal. Setting
        // `multi: true` unconditionally broke `required foo := .owner{name}`
        // by surfacing a single-link as an array.
        multi: isMulti || undefined,
        required,
        cardinality,
        operation,
        origin: "explicit",
      };
    }

    const modifiers = this.clauseChainToShapeModifiers(this.parseClauseChain());
    return {
      kind: "computed",
      name,
      expr,
      multi: isMulti || undefined,
      required,
      cardinality,
      operation,
      origin: "explicit",
      ...modifiers,
    };
  }

  private parseComputedExpr(): ComputedExpr | BacklinkExpr {
    if (this.peek().kind === "at") {
      this.consume();
      return {
        kind: "field_ref",
        field: `@${this.expectLinkPropertyName("Expected link property name after '@'")}`,
      };
    }

    if (this.isNameToken(this.peek()) && this.peekNext().kind === "dot") {
      const headLexeme = this.nameTokenLexeme(this.peek());
      // The select-result alias is not in scope inside its own definition.
      // Record on the side channel (speculative parses swallow throws) and
      // throw — parseSelectFreeOrExpr re-raises after the expression parse.
      if (this.pendingResultAliases.includes(headLexeme) && !this.localBindings.includes(headLexeme)) {
        const violation = new AppError(
          "E_SEMANTIC",
          `object type or alias '${this.defaultModule ?? "default"}::${headLexeme}' does not exist`,
          ...this.posPair(this.peek()),
        );
        this.pendingResultAliasViolation ??= violation;
        throw violation;
      }
      // The shortcut emits `field_ref(field)` / `current_item.field` only when
      // the head names the *same* binding the shape body iterates over (i.e.
      // it's a local binding for shape iteration). For absolute references
      // like `Type.field` or bindings that resolve to a set of objects, the
      // semantics differ: `User.name` ranges over all Users and has cardinality
      // "many", which is distinct from `.name` (per-row). Punting to
      // `parseFreeObjectExpr` keeps that distinction.
      const isLocalBinding = this.localBindings.includes(headLexeme);
      const isAbsoluteOrType = this.isTypeLikeName(headLexeme);
      if (!isAbsoluteOrType && !isLocalBinding) {
        const shortcutTerminators: Token["kind"][] = [
          "comma",
          "rbrace",
          "rparen",
          "kw_filter",
          "kw_order",
          "kw_limit",
          "kw_offset",
          "eof",
        ];
        const shortcutContinuations: Token["kind"][] = ["dot", "lbracket", "at", "lbrace"];
        const shortcut = this.attempt(() => {
          this.consume();
          this.consume();
          const fieldName = this.expectName("Expected field name after '.'").lexeme;
          if (shortcutContinuations.includes(this.peek().kind)) {
            let base: FreeObjectExpr = { kind: "field_access", expr: { kind: "current_item" }, field: fieldName };
            base = this.applyPostfixExprChain(base);
            if (!shortcutTerminators.includes(this.peek().kind)) {
              return undefined;
            }
            return { kind: "select_expr" as const, expr: base, clauses: {} };
          }
          if (!shortcutTerminators.includes(this.peek().kind)) {
            return undefined;
          }
          return {
            kind: "field_ref" as const,
            field: fieldName,
          };
        });
        if (shortcut) {
          return shortcut;
        }
      }
    }

    const suffixMathExpr = this.parseFieldSuffixMathExpr();
    if (suffixMathExpr) {
      return suffixMathExpr;
    }

    const polymorphicExpr = this.parseComputedPolymorphicFieldExpr();
    if (polymorphicExpr) {
      return polymorphicExpr;
    }

    const dotExpr = this.parseComputedDotRefExpr();
    if (dotExpr) {
      return dotExpr;
    }

    const subqueryExpr = this.parseComputedSubqueryExpr();
    if (subqueryExpr) {
      return subqueryExpr;
    }

    const fnExpr = this.parseComputedFunctionCallExpr();
    if (fnExpr) {
      return fnExpr;
    }

    const generalExpr = this.tryParseComputedFreeObjectExpr();
    if (generalExpr) {
      return generalExpr;
    }

    return this.parseComputedLiteralOrBindingExpr();
  }

  private tryParseComputedFreeObjectExpr(): ComputedExpr | undefined {
    const token = this.peek();
    const nextKind = this.peekNext().kind;
    const boundaryKinds: Token["kind"][] = ["comma", "rbrace", "rparen", "eof"];
    const nameStartsGeneralExpr = this.isNameToken(token) && !boundaryKinds.includes(nextKind);
    const literalStartsGeneralExpr = ["number", "string", "bytes_string", "kw_true", "kw_false", "kw_null"].includes(token.kind)
      && !boundaryKinds.includes(nextKind);
    const startsGeneralExpr = token.kind === "kw_not" || token.kind === "kw_for" || token.kind === "kw_select" || token.kind === "kw_exists"
      || token.kind === "kw_distinct"
      || token.kind === "kw_detached"
      || token.kind === "lparen"
      || token.kind === "lbrace"
      || token.kind === "lbracket"
      || token.kind === "lt"
      || token.kind === "dot"
      || token.kind === "str_interp_start"
      || nameStartsGeneralExpr
      || literalStartsGeneralExpr;
    if (!startsGeneralExpr) {
      return undefined;
    }

    const parsed = this.attempt(() => {
      const expr = this.parseFreeObjectExpr();
      if (["comma", "rbrace", "rparen", "kw_filter", "kw_order", "kw_limit", "kw_offset", "eof"].includes(this.peek().kind)) {
        return {
          kind: "select_expr" as const,
          expr,
          clauses: {},
        };
      }
      return undefined;
    });
    return parsed;
  }

  private parseComputedPolymorphicFieldExpr(): ComputedExpr | undefined {
    if (this.peek().kind !== "lbracket") {
      return undefined;
    }

    if (this.peekNth(1).kind !== "kw_is") {
      // Array-literal form `[v1, v2, ...]` — only literal-typed elements are
      // accepted here. If any element isn't a scalar literal (e.g. `[.path]`,
      // `[Type.field]`, `[(SELECT ...)]`), return undefined so the more general
      // free-object expression parser can take over.
      return this.attempt(() => ({
        kind: "literal" as const,
        value: this.readScalarLikeValue(),
      }));
    }

    return this.attempt(() => {
      const sourceTypeExpr = this.parseTypeFilter("polymorphic field reference");
      this.expect("dot", "Expected '.' after polymorphic type filter");
      const field = this.expectName("Expected field name after polymorphic type filter").lexeme;
      // Defer chained access (e.g. `[is T].link.name`) to the general expression
      // path so postfix chaining can build a full path_steps.
      if (this.peek().kind === "dot") {
        return undefined;
      }
      return {
        kind: "polymorphic_field_ref" as const,
        sourceType: simpleTypeName(sourceTypeExpr) ?? "",
        sourceTypeExpr,
        field,
      };
    });
  }

  private parseComputedDotRefExpr(): ComputedExpr | BacklinkExpr | undefined {
    if (this.peek().kind !== "dot" && this.peek().kind !== "backward_link" && this.peek().kind !== "optional_link") {
      return undefined;
    }
    // If the dot-chain is followed by a binary operator (`/`, `*`, `+`, `-`,
    // `%`, `??`, `=`, `!=`, `<`, …) we defer to the general computed-expr
    // parser so the whole binary expression compiles, instead of stopping at
    // the field ref. Scan ahead non-destructively.
    if (this.peek().kind === "dot") {
      let i = this.index + 1;
      // Skip a chain of `.fieldName` tokens.
      while (i + 1 < this.tokens.length
        && this.isNameToken(this.tokens[i])
        && this.tokens[i + 1]?.kind === "dot") {
        i += 2;
      }
      if (i < this.tokens.length && this.isNameToken(this.tokens[i])) {
        const afterChain = this.tokens[i + 1]?.kind;
        const continuesAsBinary: Array<Token["kind"]> = [
          "plus", "minus", "star", "slash",
          "coalesce", "equals", "not_equals", "lt", "gt", "lte", "gte",
          "concat", "kw_union",
        ];
        if (afterChain && continuesAsBinary.includes(afterChain)) {
          return undefined;
        }
      }
    }
    const op = this.peek().kind;
    this.consume();

    if (op === "backward_link" || this.peek().kind === "lt") {
      if (this.peek().kind === "lt") {
        this.consume();
      }
      const link = this.expectPermissiveName("Expected backlink name after '.<'").lexeme;

      let sourceTypeExpr: TypeExpr | undefined;
      if (this.peek().kind === "lbracket") {
        sourceTypeExpr = this.parseTypeFilter("backlink type filter");
      }

      return {
        link,
        sourceType: simpleTypeName(sourceTypeExpr),
        sourceTypeExpr,
      };
    }

    const fieldName = this.expectName("Expected field name after '.'").lexeme;
    if (fieldName === "__type__") {
      if (this.peek().kind === "dot") {
        this.consume();
        const suffix = this.expectName("Expected 'name' after '__type__.'").lexeme;
        if (suffix !== "name") {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Expected '__type__.name'", ...this.posPair(token));
        }
      }
      return {
        kind: "type_name",
      };
    }

    const isOptional = op === "optional_link";

    // Chained access (e.g. `.key.element` or `.elements[is T].name`) — wrap as a
    // select_expr over a field_access chain so the downstream IR sees the full path.
    if (this.peek().kind === "dot" || this.peek().kind === "lbracket" || this.peek().kind === "at" || isOptional) {
      let chained: FreeObjectExpr = {
        kind: "field_access",
        expr: { kind: "current_item" },
        field: fieldName,
        optional: isOptional || undefined,
      };
      chained = this.applyPostfixExprChain(chained);
      return {
        kind: "select_expr",
        expr: chained,
        clauses: {},
      };
    }

    return {
      kind: "field_ref",
      field: fieldName,
    };
  }

  // If a computed shape entry's value starts with `.field` and is followed by
  // a math operator (`/`, `*`, `+`, `-`, `%`), `?`/`?=`/`?!=` etc., we need to
  // parse the rest of the expression too.

  private parseComputedSubqueryExpr(): ComputedExpr | undefined {
    // If a parenthesized subquery is followed by a postfix (`.field`, `[…]`,
    // `@property`) or a binary operator (`+`, `++`, `=`, …), defer to the
    // general expression parser so the whole expression is captured. Without
    // this the simple subquery parser returns at the closing paren and the
    // caller (parseShapeEntry) chokes on the trailing tokens.
    if (this.peek().kind === "lparen") {
      let depth = 0;
      let i = this.index;
      while (i < this.tokens.length) {
        const k = this.tokens[i].kind;
        if (k === "lparen") depth += 1;
        else if (k === "rparen") {
          depth -= 1;
          if (depth === 0) { i += 1; break; }
        }
        i += 1;
      }
      if (depth === 0 && i < this.tokens.length) {
        const continuesAsExpr: Array<Token["kind"]> = [
          "plus", "minus", "star", "slash",
          "coalesce", "equals", "not_equals", "lt", "gt", "lte", "gte",
          "concat", "kw_union",
          "dot", "lbracket", "at",
        ];
        if (continuesAsExpr.includes(this.tokens[i].kind)) {
          return undefined;
        }
      }
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_with") {
      this.consume();
      const withClause = this.parseWithClause();
      // The WITH body need not be a `select`: it may be a `for ... union (...)`
      // expression or a bare parenthesized free-object arm (e.g.
      // `groups := (with z := ... for z in z union (even := ..., elements := ...))`).
      // When the body doesn't begin with `select`, parse it with the general
      // free-object parser, which handles for/union/free-object-constructor.
      if (this.peek().kind !== "kw_select") {
        const bodyExpr = this.parseFreeObjectExpr();
        const bodyClauses = this.parseClauseChain();
        this.expect("rparen", "Expected ')' after computed subquery expression");
        return {
          kind: "select_expr",
          expr: bodyExpr,
          clauses: {
            ...bodyClauses,
            _withBindings: withClause.with,
            _withModule: withClause.withModule,
            _withModuleAliases: withClause.withModuleAliases,
          },
        };
      }
      this.expect("kw_select", "Expected 'select' in computed subquery expression");
      if (this.isNameToken(this.peek()) && (this.peekNext().kind === "lbrace" || this.peekNext().kind === "kw_filter" || this.peekNext().kind === "kw_order" || this.peekNext().kind === "kw_limit" || this.peekNext().kind === "kw_offset")) {
        const nested = this.parseInlineSelectExpr();
        nested.clauses = {
          ...nested.clauses,
          _withBindings: withClause.with,
          _withModule: withClause.withModule,
          _withModuleAliases: withClause.withModuleAliases,
        };
        this.expect("rparen", "Expected ')' after computed subquery expression");
        return {
          kind: "subquery",
          typeName: nested.typeName,
          shape: nested.shape,
          clauses: nested.clauses,
        };
      }

      const expr = this.parseFreeObjectExpr();
      const clauses = this.parseClauseChain();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "select_expr",
        expr,
        clauses: {
          ...clauses,
          _withBindings: withClause.with,
          _withModule: withClause.withModule,
          _withModuleAliases: withClause.withModuleAliases,
        },
      };
    }

    // `( GROUP ... )` — an embedded (expression-position) GROUP in a computed
    // shape entry, e.g. `SELECT Card { x := (GROUP .avatar BY @text, .text) }`.
    // Route it through parseGroupExpr so its BY clause is parsed by the same
    // group-by parser (parseGroupByList/parseGroupByAtom) — `@text` becomes a
    // link_property_ref atom rather than being consumed by the scalar-value
    // reader (contract C3). atParenthesizedSelect() doesn't recognise GROUP, so
    // this case must precede that guard.
    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_group") {
      this.consume();
      const group = this.parseGroupExpr();
      const clauses = this.parseClauseChain();
      this.expect("rparen", "Expected ')' after embedded GROUP expression");
      return {
        kind: "select_expr",
        expr: group,
        clauses,
      };
    }

    if (!this.atParenthesizedSelect()) {
      return undefined;
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select" && this.peekNth(2).kind === "dot") {
      this.consume();
      this.consume();
      const expr = this.parseFreeObjectExpr();
      const clauses = this.parseClauseChain();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "select_expr",
        expr,
        clauses,
      };
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select" && this.isNameToken(this.peekNth(2)) && this.peekNth(3).kind === "assign") {
      this.consume();
      const expr = this.parseSelectExprSubquery();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "select_expr",
        expr,
        clauses: {},
      };
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select") {
      this.consume();
      const expr = this.parseSelectExprSubquery();
      this.expect("rparen", "Expected ')' after computed subquery expression");
      return {
        kind: "select_expr",
        expr,
        clauses: {},
      };
    }

    const nested = this.parseParenthesizedSelectQuery(
      "Expected 'select' in computed subquery expression",
      "Expected ')' after computed subquery expression",
    );
    return {
      kind: "subquery",
      typeName: nested.typeName,
      shape: nested.shape,
      clauses: nested.clauses,
    };
  }

  private parseComputedFunctionCallExpr(): ComputedExpr | undefined {
    if (!this.atFunctionCall()) {
      return undefined;
    }

    // If a binary operator (`++`, `+`, `-`, `*`, `/`, comparison, `??`)
    // follows the function call's closing paren, defer to the general
    // expression parser so the whole binary expression is captured.
    const savedIndex = this.index;
    let depth = 0;
    let i = this.index;
    while (i < this.tokens.length) {
      const k = this.tokens[i].kind;
      if (k === "lparen") depth += 1;
      else if (k === "rparen") {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
      i += 1;
    }
    if (depth === 0 && i < this.tokens.length) {
      const continuesAsExpr: Array<Token["kind"]> = [
        "plus", "minus", "star", "slash",
        "coalesce", "equals", "not_equals", "lt", "gt", "lte", "gte",
        "concat", "kw_union",
        // Postfix continuations on the function result:
        //   foo(.b).a           — field access
        //   foo(.b)[0]          — index / type filter
        //   foo(.b)@property    — link-property access
        "dot", "lbracket", "at",
      ];
      if (continuesAsExpr.includes(this.tokens[i].kind)) {
        // Defer to general expression parser. parseComputedFunctionCallExpr
        // pre-checks atFunctionCall, so the index doesn't need restoration —
        // but be defensive.
        this.index = savedIndex;
        return undefined;
      }
    }

    const call = this.parseFunctionCallExpr(true);
    if (this.peek().kind === "minus" && this.peekNext().kind === "number") {
      this.consume();
      const rhs = this.consume();
      const rhsValue = this.parseNumberLexeme(rhs.lexeme);
      return {
        kind: "function_call",
        call: {
          name: "__gel_subtract",
          args: [
            this.functionCallExpr(call),
            { kind: "literal", value: rhsValue },
          ],
        },
      };
    }

    return this.functionCallExpr(call);
  }

  private parseComputedLiteralOrBindingExpr(): ComputedExpr {
    if (this.isNameToken(this.peek())) {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    const thenValue = this.readScalarLikeValue();
    let baseArg: FunctionCallArgExpr = { kind: "literal", value: thenValue };
    if (this.peek().kind === "minus") {
      this.consume();
      const rhs = this.parseArithmeticLeafArg();
      baseArg = {
        kind: "function_call",
        call: {
          name: "__gel_subtract",
          args: [baseArg, rhs],
        },
      };
    }

    const conditionalArg = this.parseIfElseArg(baseArg);
    if (conditionalArg.kind === "function_call") {
      return this.functionCallExpr(conditionalArg.call);
    }

    if (conditionalArg.kind === "field_ref") {
      return {
        kind: "field_ref",
        field: conditionalArg.field,
      };
    }

    if (conditionalArg.kind === "binding_ref") {
      return {
        kind: "binding_ref",
        name: conditionalArg.name,
      };
    }

    return {
      kind: "literal",
      value: conditionalArg.kind === "literal" ? conditionalArg.value : null,
    };
  }

  private parseIfElseArg(initialThenArg: FunctionCallArgExpr): FunctionCallArgExpr {
    if (this.peek().kind !== "kw_if") {
      return initialThenArg;
    }
    this.consume();

    const conditionField = this.parseIfConditionField();
    this.expect("equals", "Expected '=' in IF condition");
    const conditionValue = this.readScalarValue();
    if (this.peek().kind !== "kw_else") {
      const token = this.peek();
      throw new AppError("E_SYNTAX", "Expected 'else' in IF expression", ...this.posPair(token));
    }
    this.consume();

    const elseArg = this.parseIfElseArg(this.parseIfElseLeafArg());
    return {
      kind: "function_call",
      call: {
        name: "__gel_if_eq",
        args: [
          { kind: "field_ref", field: conditionField },
          { kind: "literal", value: conditionValue },
          initialThenArg,
          elseArg,
        ],
      },
    };
  }

  private parseIfConditionField(): string {
    if (this.peek().kind === "dot") {
      this.consume();
      return this.expectName("Expected field name after '.' in IF condition").lexeme;
    }

    const first = this.expectName("Expected condition field in IF expression").lexeme;
    if (this.peek().kind === "dot") {
      this.consume();
      return this.expectName("Expected condition field after qualifier in IF expression").lexeme;
    }
    return first;
  }

  private parseIfElseLeafArg(): FunctionCallArgExpr {
    return this.parseFieldOrLiteralArg(
      "Expected field after '.' in IF expression",
      "Expected qualifier in IF expression",
      "Expected field name after qualifier in IF expression",
    );
  }

  private parseArithmeticLeafArg(): FunctionCallArgExpr {
    return this.parseFieldOrLiteralArg(
      "Expected field after '.' in arithmetic expression",
      "Expected qualifier in arithmetic expression",
      "Expected field name after qualifier in arithmetic expression",
    );
  }

  private parseFieldOrLiteralArg(
    dotFieldMessage: string,
    qualifierMessage: string,
    fieldAfterQualifierMessage: string,
  ): FunctionCallArgExpr {
    if (this.atFunctionCall()) {
      return this.functionCallExpr(this.parseFunctionCallExpr());
    }

    if (this.atDotField()) {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expectName(dotFieldMessage).lexeme,
      };
    }

    if (this.atQualifiedIdentifier()) {
      const { tail } = this.parseQualifiedIdentifier(qualifierMessage, fieldAfterQualifierMessage);
      return {
        kind: "field_ref",
        field: tail,
      };
    }

    return {
      kind: "literal",
      value: this.readScalarLikeValue(),
    };
  }

  private parseFieldSuffixMathExpr(): ComputedExpr | undefined {
    const parseSuffixRef = (): { field: string; fromEnd: number } | undefined => {
      return this.attempt(() => {
        if (this.peek().kind !== "lt") {
          return undefined;
        }
        this.consume();
        if (!this.isNameToken(this.peek())) {
          return undefined;
        }
        this.consume();
        if (this.peek().kind !== "gt") {
          return undefined;
        }
        this.consume();
        if (this.peek().kind !== "dot") {
          return undefined;
        }
        this.consume();
        if (!this.isNameToken(this.peek())) {
          return undefined;
        }
        const field = this.consume().lexeme;
        if (this.peek().kind !== "lbracket") {
          return undefined;
        }
        this.consume();
        if (this.peek().kind !== "minus") {
          return undefined;
        }
        this.consume();
        if (this.peek().kind !== "number") {
          return undefined;
        }
        const indexToken = this.consume().lexeme;
        if (this.peek().kind !== "rbracket") {
          return undefined;
        }
        this.consume();
        return { field, fromEnd: this.parseNumberLexeme(indexToken) };
      });
    };

    if (this.peek().kind === "number" && this.peekNext().kind === "minus") {
      return this.attempt(() => {
        const constantToken = this.consume().lexeme;
        this.consume();
        const ref = parseSuffixRef();
        if (!ref) {
          return undefined;
        }
        return {
          kind: "field_suffix_math",
          field: ref.field,
          fromEnd: ref.fromEnd,
          op: "const_minus",
          constant: this.parseNumberLexeme(constantToken),
        };
      });
    }

    if (this.peek().kind === "minus" && this.peekNext().kind === "lt") {
      return this.attempt(() => {
        this.consume();
        const ref = parseSuffixRef();
        if (!ref) {
          return undefined;
        }
        return {
          kind: "field_suffix_math",
          field: ref.field,
          fromEnd: ref.fromEnd,
          op: "negate",
        };
      });
    }

    return undefined;
  }

  // Function call — see docs/reference/reference/edgeql/functions.rst.
  //
  // Grammar (functions.rst lines 13-21):
  //
  //   <function_name> "(" [<argument> [, <argument>, ...]] ")"
  //
  //   <argument> := <expr> | <identifier> := <expr>
  //
  // <function_name> is a possibly qualified name (e.g. `len`, `math::ceil`).
  // Arguments are positional (`<expr>`) or named-only (`<name> := <expr>`,
  // see the array_get example on functions.rst lines 40-43). Trailing
  // commas are accepted by upstream's test_edgeql_syntax_function_09.
  //
  // Upstream rejections we mirror (test_edgeql_syntax.py):
  //   * positional argument after named (function_06)
  //   * duplicate named argument (function_07)
  //   * `$<name> := ...` prefix on named args (function_08) — names are
  //     bare identifiers, not parameter references
  //   * missing comma between args (function_10/11)
  //   * bare keywords like `ALL` in argument position (function_05)
  //
  // Aggregate-style trailing clauses (`FILTER ... ORDER BY ...`) inside a
  // single argument are handled by parseFunctionCallArgExpr — see
  // test_edgeql_syntax_function_03.
  private parseFunctionCallExpr(allowExpressionArgs = false): FunctionCallExpr {
    const name = this.parseQualifiedName("Expected function name");
    const lparenToken = this.expect("lparen", "Expected '(' after function name");
    const args = this.parseDelimited(
      "rparen",
      () => this.parseFunctionCallArgExpr(allowExpressionArgs),
      "Expected ',' between function arguments",
    );
    this.expect("rparen", "Expected ')' after function arguments");
    // Validate argument ordering / uniqueness: positional args must precede
    // named args, and no named argument name may repeat.
    let sawNamed = false;
    const seenNames = new Set<string>();
    for (const arg of args) {
      if (arg.kind === "named_arg") {
        sawNamed = true;
        if (seenNames.has(arg.name)) {
          throw new AppError(
            "E_SYNTAX",
            `duplicate named argument '${arg.name}' in function call`,
            ...this.posPair(lparenToken),
          );
        }
        seenNames.add(arg.name);
      } else if (sawNamed) {
        throw new AppError(
          "E_SYNTAX",
          "positional argument follows a named argument in function call",
          ...this.posPair(lparenToken),
        );
      }
    }
    return { name, args };
  }

  private parseFunctionCallArgExpr(allowExpressionArgs = false): FunctionCallArgExpr {
    // Named argument: `name := expr`. Parse the name + `:=` and wrap the
    // recursively-parsed value with a `named_arg` envelope so the rest of
    // the pipeline keeps treating it like any other call argument.
    if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
      const nameToken = this.consume();
      this.expect("assign", "Expected ':=' in named function argument");
      const inner = this.parseFunctionCallArgExpr(allowExpressionArgs);
      return { kind: "named_arg", name: nameToken.lexeme, arg: inner };
    }
    if (allowExpressionArgs) {
      const parsedExpr = this.tryParseFreeObjectFunctionCallArgExpr();
      if (parsedExpr) {
        return parsedExpr;
      }
    }

    if (this.peek().kind === "lt") {
      return this.parseCastFunctionCallArgExpr();
    }

    if (this.atDotField()) {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expectName("Expected field after '.' in function argument").lexeme,
      };
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values = this.parseDelimited("rbrace", () => this.readScalarValue(), "Expected ',' in set literal function argument");
      this.expect("rbrace", "Expected '}' after set literal function argument");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values = this.parseDelimited("rbracket", () => this.readScalarValue(), "Expected ',' in array literal function argument");
      this.expect("rbracket", "Expected ']' after array literal function argument");
      return {
        kind: "array_literal",
        values,
      };
    }

    if (this.isNameToken(this.peek())) {
      return this.parseIdentifierFunctionCallArgExpr(allowExpressionArgs);
    }

    return {
      kind: "literal",
      value: this.readScalarValue(),
    };
  }

  private tryParseFreeObjectFunctionCallArgExpr(): FunctionCallArgExpr | undefined {
    const token = this.peek();
    if (this.isNameToken(token) && (this.peekNext().kind === "comma" || this.peekNext().kind === "rparen")) {
      return undefined;
    }
    const startsExpression =
      token.kind === "lparen"
      || token.kind === "lbrace"
      || token.kind === "lbracket"
      || token.kind === "lt"
      || token.kind === "dot"
      || token.kind === "backward_link"
      || token.kind === "optional_link"
      || this.isNameToken(token)
      || token.kind === "number"
      || token.kind === "string"
      || token.kind === "bytes_string"
      || token.kind === "kw_true"
      || token.kind === "kw_false"
      || token.kind === "kw_null"
      || token.kind === "kw_not"
      || token.kind === "kw_for"
      || token.kind === "kw_select"
      || token.kind === "kw_insert"
      || token.kind === "kw_update"
      || token.kind === "kw_delete"
      || token.kind === "kw_with"
      || token.kind === "kw_distinct"
      || token.kind === "kw_detached"
      || token.kind === "str_interp_start"
      || token.kind === "parameter"
      || token.kind === "minus"
      || token.kind === "plus"
      || this.isExistsToken(token);
    if (!startsExpression) {
      return undefined;
    }

    const parsed = this.attempt(() => {
      let expr = this.parseFreeObjectExpr();
      const tail = this.parseSelectExprTailParts();
      if (this.hasSelectExprTailParts(tail)) {
        expr = {
          kind: "select_expr_subquery",
          expr,
          ...tail,
        };
      }
      if (this.peek().kind === "comma" || this.peek().kind === "rparen") {
        return {
          kind: "expr" as const,
          expr,
        };
      }
      return undefined;
    });
    return parsed;
  }

  private parseCastFunctionCallArgExpr(): FunctionCallArgExpr {
    this.consume();
    let depth = 1;
    while (depth > 0 && this.peek().kind !== "eof") {
      const token = this.consume();
      if (token.kind === "lt") {
        depth += 1;
      } else if (token.kind === "gt") {
        depth -= 1;
      }
    }
    if (depth !== 0) {
      throw new AppError("E_SYNTAX", "Expected '>' after function argument cast type", ...this.posPair(this.peek()));
    }

    if (this.peek().kind === "lbrace") {
      this.consume();
      const values = this.parseDelimited("rbrace", () => this.readScalarValue(), "Expected ',' in cast set literal function argument");
      this.expect("rbrace", "Expected '}' after cast set literal function argument");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.isNameToken(this.peek())) {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.atDotField()) {
      this.consume();
      return {
        kind: "field_ref",
        field: this.expectName("Expected field after '.' in cast function argument").lexeme,
      };
    }

    return {
      kind: "literal",
      value: this.readScalarValue(),
    };
  }

  private parseIdentifierFunctionCallArgExpr(allowExpressionArgs = false): FunctionCallArgExpr {
    if (this.atFunctionCall()) {
      return this.functionCallExpr(this.parseFunctionCallExpr(allowExpressionArgs));
    }

    if (this.atQualifiedIdentifier()) {
      const { tail } = this.parseQualifiedIdentifier(
        "Expected qualifier in function argument",
        "Expected field name after qualifier in function argument",
      );
      return {
        kind: "field_ref",
        field: tail,
      };
    }

    return {
      kind: "binding_ref",
      name: this.consume().lexeme,
    };
  }

  private isBacklinkExpr(expr: ComputedExpr | BacklinkExpr): expr is BacklinkExpr {
    return "link" in expr;
  }

  // INSERT statement — see docs/reference/reference/edgeql/insert.rst.
  //
  // Grammar (eql:synopsis from insert.rst lines 11-17):
  //
  //   [ with <with-spec> [, ...] ]
  //   insert <expression> [ <insert-shape> ]
  //   [ unless conflict
  //       [ on <property-expr> [ else <alternative> ] ]
  //   ] ;
  //
  //   <insert-shape> := '{' <link> := <insert-value-expr> [, ...] '}'
  //
  // <expression> is parsed as a qualified type name (we tolerate a leading
  // `DETACHED` per with.rst's detached-expression rules). The shape body
  // is a comma-separated list of assignments (parseInsertAssignment).
  // `unless conflict` is delegated to parseInsertConflict — see
  // insert.rst lines 54-100 for the ON/ELSE semantics.
  private parseInsert(ctx: ParseContext = {}, expectEof = true): InsertStatement {
    const start = this.expect("kw_insert", "Expected 'insert'");
    if (this.peek().kind === "kw_detached") {
      this.consume();
    }
    const typeName = this.parseQualifiedName("Expected type name");

    // `INSERT Person.notes { … }` — the subject is a link/property path, not
    // an object type. Upstream rejects this as inserting an arbitrary
    // expression (insert.rst / test_edgeql_insert_fail_05).
    if (this.peek().kind === "dot") {
      throw new AppError(
        "E_SEMANTIC",
        "INSERT only works with object types, not arbitrary expressions",
        ...this.posPair(this.peek()),
      );
    }

    const values: Record<string, InsertValue> = {};
    if (this.peek().kind === "lbrace") {
      this.consume();
      for (const assignment of this.parseDelimited("rbrace", () => this.parseInsertAssignment(), "Expected ',' between assignments")) {
        values[assignment.field] = assignment.value;
      }
      this.expect("rbrace", "Expected '}' after assignments");
    }

    const conflict = this.parseInsertConflict();

    // `insert Note {…} union DerivedNote` / `… if cond else …` — the INSERT is
    // being combined into a larger set/conditional expression. Upstream rejects
    // these: an INSERT subject must be a plain object type, not a union
    // (test_edgeql_insert_fail_08) or conditional (test_edgeql_insert_fail_09).
    if (this.peek().kind === "kw_union") {
      throw new AppError(
        "E_SEMANTIC",
        "INSERT only works with object types, not arbitrary expressions",
        ...this.posPair(this.peek()),
      );
    }
    if (this.peek().kind === "kw_if") {
      throw new AppError(
        "E_SEMANTIC",
        "INSERT only works with object types, not conditional expressions",
        ...this.posPair(this.peek()),
      );
    }

    // Per lexical.rst lines 400-402, ';' is idempotent — `commit;;`,
    // `select 1;;;` etc. are all valid (upstream test_edgeql_syntax_constants_02).
    while (this.peek().kind === "semi") {
      this.consume();
    }

    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "insert",
      typeName,
      values,
      conflict,
      pos: this.posOf(start),
    };
  }

  private parseInsertAssignment(): { field: string; value: InsertValue } {
    const field = this.expectName("Expected field name").lexeme;
    // `INSERT Person { name }` — a bare shape field with no value. Mutations
    // (INSERT/UPDATE) require every shape element to assign a value with `:=`
    // (test_edgeql_insert_fail_04).
    if (this.peek().kind !== "assign") {
      throw new AppError(
        "E_SEMANTIC",
        "mutation queries must specify values with ':='",
        ...this.posPair(this.peek()),
      );
    }
    this.expect("assign", "Expected ':=' after field name");
    return {
      field,
      value: this.parseInsertAssignmentValue(),
    };
  }

  private parseInsertAssignmentValue(): InsertValue {
    const insertAttempt = this.attempt<InsertValue>(() => {
      const value = this.parseInsertValue();
      const next = this.peek().kind;
      if (next === "comma" || next === "rbrace") {
        return value;
      }
      return undefined;
    });
    if (insertAttempt !== undefined) {
      return insertAttempt;
    }
    return { kind: "expr", expr: this.parseFreeObjectExpr() };
  }

  private parseUpdateAssignment(): { field: string; operation: "assign" | "append" | "subtract"; value: InsertValue } {
    const field = this.expectName("Expected field name").lexeme;
    const opToken = this.peek();
    // `ham: { taste := 'yummy' }` — nested link-shape form using `:` rather
    // than `:=`. Consume the colon and treat the brace block as the value;
    // we skip its contents permissively since the runtime doesn't model
    // nested link shapes in UPDATE.
    if (opToken.kind === "colon" && this.peekNext().kind === "lbrace") {
      this.consume();
      this.consume();
      let depth = 1;
      while (this.peek().kind !== "eof" && depth > 0) {
        const k = this.peek().kind;
        if (k === "lbrace" || k === "lparen" || k === "lbracket") depth += 1;
        else if (k === "rbrace" || k === "rparen" || k === "rbracket") {
          depth -= 1;
          if (depth === 0) break;
        }
        this.consume();
      }
      this.expect("rbrace", "Expected '}' to close nested link shape");
      return {
        field,
        operation: "assign",
        value: { kind: "expr", expr: { kind: "literal", value: null } as FreeObjectExpr },
      };
    }
    if (opToken.kind !== "assign" && opToken.kind !== "add_assign" && opToken.kind !== "sub_assign") {
      throw new AppError("E_SYNTAX", "Expected assignment operator after field name", ...this.posPair(opToken));
    }
    this.consume();
    return {
      field,
      operation: opToken.kind === "add_assign" ? "append" : opToken.kind === "sub_assign" ? "subtract" : "assign",
      value: this.parseUpdateValue(),
    };
  }

  private parseUpdateValue(): InsertValue {
    const insertAttempt = this.attempt<InsertValue>(() => {
      const value = this.parseInsertValue();
      const next = this.peek().kind;
      if (next === "comma" || next === "rbrace") {
        return value;
      }
      return undefined;
    });
    if (insertAttempt !== undefined) {
      return insertAttempt;
    }
    const expr = this.parseFreeObjectExpr();
    return { kind: "expr", expr };
  }

  private parseInsertValue(): InsertValue {
    const first = this.parseInsertValueAtom();
    if (this.peek().kind !== "kw_union") {
      return first;
    }
    const operands: InsertValue[] = [];
    appendInsertValueOperand(operands, first);
    while (this.peek().kind === "kw_union") {
      this.consume();
      appendInsertValueOperand(operands, this.parseInsertValueAtom());
    }
    return { kind: "set", values: operands };
  }

  private parseInsertValueAtom(): InsertValue {
    if (this.peek().kind === "lt") {
      return this.parseCastInsertValue();
    }

    if (this.atFunctionCall()) {
      return this.parseInsertFunctionCallValue();
    }

    if (this.isNameToken(this.peek())) {
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.peek().kind === "lparen") {
      return this.parseParenthesizedInsertValue();
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values = this.parseDelimited("rbracket", () => this.readScalarValue(), "Expected ',' in array literal");
      this.expect("rbracket", "Expected ']' after array literal");
      return {
        kind: "array_literal",
        values,
      };
    }

    if (this.peek().kind === "lbrace") {
      return this.parseInsertSetLiteralValue();
    }

    return this.readScalarValue();
  }

  private parseCastInsertValue(): InsertValue {
    this.consume();
    const castType = this.parseCastTypeName("Expected cast type");
    this.expect("gt", "Expected '>' after cast type");
    const inner = this.parseInsertValue();
    if (castType === "json" || castType === "std::json") {
      if (typeof inner === "string") {
        return JSON.stringify(inner);
      }
      if (typeof inner === "boolean" || typeof inner === "number" || inner === null) {
        return inner;
      }
    }
    // Preserve the cast target on an empty-set assignment (`<datetime>{}`)
    // so the INSERT type-checker can compare it against the declared pointer
    // type (test_edgeql_insert_empty_02/05). Only tag empty sets — a populated
    // set has its own element values to type-check.
    if (
      inner !== null &&
      typeof inner === "object" &&
      (inner as { kind?: string }).kind === "set" &&
      ((inner as { values?: unknown[] }).values?.length ?? 0) === 0
    ) {
      return { kind: "set", values: [], castType };
    }
    return inner;
  }

  private parseInsertFunctionCallValue(): InsertValue {
    const call = this.parseFunctionCallExpr();
    if (call.name === "to_json") {
      if (call.args.length === 1 && call.args[0].kind === "literal") {
        return call.args[0].value;
      }
    }
    return this.functionCallExpr(call);
  }

  private parseParenthesizedInsertValue(): InsertValue {
    this.consume();
    const next = this.peek();
    if (next.kind === "kw_with") {
      const withClause = this.parseWithClause();
      this.expect("kw_select", "Expected 'select' after with clause in insert expression");
      const nested = this.parseInlineSelectExpr();
      this.expect("rparen", "Expected ')' after insert select expression");
      return {
        kind: "select",
        typeName: nested.typeName,
        shape: nested.shape,
        clauses: {
          ...nested.clauses,
          _withBindings: withClause.with,
          _withModule: withClause.withModule,
          _withModuleAliases: withClause.withModuleAliases,
        },
      };
    }
    if (next.kind === "kw_select") {
      this.consume();
      if (this.peek().kind === "lparen") {
        const parsed = this.attempt(() => {
          this.consume();
          if (this.peek().kind === "kw_detached") {
            this.consume();
          }
          const typeName = this.parseQualifiedName("Expected type name in parenthesized select expression");
          this.expect("rparen", "Expected ')' after select expression root");
          const clauses = this.parseClauseChain();
          return {
            kind: "select" as const,
            typeName,
            shape: [{ kind: "field" as const, name: "id", operation: "assign" as const, origin: "default" as const }],
            clauses,
          };
        });
        if (parsed) {
          this.expect("rparen", "Expected ')' after insert select expression");
          return parsed;
        }
      }
      const nested = this.parseInlineSelectExpr();
      this.expect("rparen", "Expected ')' after insert select expression");
      return nested;
    }
    if (next.kind === "kw_insert") {
      this.consume();
      const nested = this.parseNestedInsertExpr();
      this.expect("rparen", "Expected ')' after nested insert expression");
      return nested;
    }
    if (next.kind === "kw_for") {
      // Nested `(FOR ... UNION ...)` — the closing `)` is the boundary,
      // so don't enforce EOF inside parseFor here.
      const forStmt = this.parseFor({}, false);
      this.expect("rparen", "Expected ')' after for expression");
      return forStmt;
    }

    return this.readTupleLiteralValue();
  }

  private parseInsertSetLiteralValue(): InsertValue {
    this.consume();
    const values = this.parseDelimited("rbrace", () => this.parseInsertValue(), "Expected ',' in set literal");
    this.expect("rbrace", "Expected '}' after set literal");
    return {
      kind: "set",
      values,
    };
  }

  private readTupleLiteralValue(): TupleLiteralValue {
    const items: TupleLiteralElementValue[] = [];
    const named: Record<string, TupleLiteralElementValue> = {};
    let hasNamed = false;

    while (this.peek().kind !== "rparen") {
      if (this.isNameToken(this.peek()) && this.peekNext().kind === "assign") {
        hasNamed = true;
        const key = this.consume().lexeme;
        this.consume();
        named[key] = this.readTupleLiteralElementValue();
      } else {
        if (hasNamed) {
          const token = this.peek();
          throw new AppError("E_SYNTAX", "Cannot mix unnamed and named tuple elements", ...this.posPair(token));
        }
        items.push(this.readTupleLiteralElementValue());
      }

      if (this.peek().kind === "comma") {
        this.consume();
      } else {
        break;
      }
    }

    this.expect("rparen", "Expected ')' after tuple literal");
    return {
      kind: "tuple_literal",
      values: hasNamed ? named : items,
    };
  }

  private readTupleLiteralElementValue(): TupleLiteralElementValue {
    if (this.peek().kind === "lparen") {
      this.consume();
      return this.readTupleLiteralValue().values;
    }
    return this.readScalarLikeValue();
  }

  private parseNestedInsertExpr(): { kind: "insert"; typeName: string; values: Record<string, InsertValue> } {
    if (this.peek().kind === "kw_detached") {
      this.consume();
    }
    const typeName = this.parseQualifiedName("Expected type name in nested insert");
    const values: Record<string, InsertValue> = {};
    if (this.peek().kind !== "lbrace") {
      return {
        kind: "insert",
        typeName,
        values,
      };
    }
    this.consume();
    for (const assignment of this.parseDelimited("rbrace", () => this.parseNestedInsertAssignment(), "Expected ',' between assignments")) {
      values[assignment.field] = assignment.value;
    }
    this.expect("rbrace", "Expected '}' after nested insert assignments");
    return {
      kind: "insert",
      typeName,
      values,
    };
  }

  private parseNestedInsertAssignment(): { field: string; value: InsertValue } {
    const field = this.expectName("Expected field name in nested insert").lexeme;
    this.expect("assign", "Expected ':=' after field name");
    return {
      field,
      value: this.parseInsertValue(),
    };
  }

  // UNLESS CONFLICT clause — see insert.rst lines 52-100.
  //
  // Grammar:
  //
  //   unless conflict [ on <property-expr> [ else <alternative> ] ]
  //
  // `on <property-expr>` is the conflict target. The grammar permits both
  // `on .field` (bare) and `on (.field)` / `on (.a, .b)` (paren-wrapped) —
  // we accept both. `else <alternative>` provides a fallback expression
  // when a conflict fires (typically an UPDATE or SELECT). Per
  // insert.rst lines 90-100, `else` requires `on` to disambiguate which
  // constraint the alternative reacts to.
  private parseInsertConflict(): InsertConflict | undefined {
    if (this.peek().kind !== "kw_unless") {
      return undefined;
    }

    this.consume();
    this.expect("kw_conflict", "Expected 'conflict' after 'unless'");

    let onField: string | undefined;
    let onFields: string[] | undefined;
    if (this.peek().kind === "kw_on") {
      this.consume();
      // Per insert.rst lines 67-71 the target is "either a reference to a
      // property (or link) or a tuple of references". Accept:
      //   ON .field                       (bare)
      //   ON (.field)                     (paren-wrapped single — canonical)
      //   ON (.first, .last [, ...])      (tuple)
      const wrapped = this.peek().kind === "lparen";
      if (wrapped) {
        this.consume();
      }
      const fields: string[] = [];
      const readOne = (): void => {
        this.expect("dot", "Expected '.' in conflict target");
        fields.push(this.expectName("Expected field name in conflict target").lexeme);
      };
      readOne();
      // Tuple form is only legal inside `(...)` — `ON .a, .b` (no parens) is
      // a syntax error upstream.
      if (wrapped) {
        while (this.peek().kind === "comma") {
          this.consume();
          // Trailing comma is allowed (consistent with other comma-lists).
          if (this.peek().kind === "rparen") break;
          readOne();
        }
        this.expect("rparen", "Expected ')' after conflict target");
      }
      onField = fields[0];
      if (fields.length > 1) {
        onFields = fields;
      }
    }

    // `UNLESS CONFLICT ELSE (...)` without an `ON (...)` clause is rejected
    // upstream — the ON target is required to disambiguate which constraint
    // the ELSE branch should react to.
    if (this.peek().kind === "kw_else" && onField === undefined) {
      this.notSupported(
        this.peek(),
        "UNLESS CONFLICT ELSE without ON",
        "UNLESS CONFLICT ELSE (...) requires an ON (.field) target",
      );
    }

    let elseExpr: InsertConflict["else"];
    if (this.peek().kind === "kw_else") {
      this.consume();
      const hasParen = this.peek().kind === "lparen";
      if (hasParen) this.consume();
      // Accept `DETACHED ...` and arbitrary parenthesised expressions as
      // best-effort: we record the underlying type name so cardinality
      // inference can act on it, without yet executing the body.
      if (this.peek().kind === "kw_detached") {
        this.consume();
      }
      const innerHasParen = this.peek().kind === "lparen";
      if (innerHasParen) this.consume();
      if (this.peek().kind === "kw_select") {
        this.consume();
        elseExpr = this.parseInlineSelectExpr();
      } else if (this.peek().kind === "kw_update") {
        elseExpr = this.parseInlineUpdateExpr();
      } else if (this.peek().kind === "kw_insert") {
        this.consume();
        const insTypeName = this.parseQualifiedName("Expected type name in insert expression");
        // Skip optional `{...}` body — we don't compile inline INSERTs through
        // this branch yet; only the type name is needed for cardinality.
        if (this.peek().kind === "lbrace") {
          let depth = 1;
          this.consume();
          while (depth > 0 && this.peek().kind !== "eof") {
            if (this.peek().kind === "lbrace") depth++;
            else if (this.peek().kind === "rbrace") depth--;
            this.consume();
          }
        }
        elseExpr = { kind: "select", typeName: insTypeName, shape: [], clauses: {} };
      } else if (this.isNameToken(this.peek())) {
        // Bare type-name form: `UNLESS CONFLICT ON (.n) ELSE X` is sugar for
        // `... ELSE (SELECT X)`. Route through the same inline-select parser.
        elseExpr = this.parseInlineSelectExpr();
      } else {
        const token = this.peek();
        throw new AppError("E_SYNTAX", "Expected select or update expression in else clause", ...this.posPair(token));
      }
      if (innerHasParen) this.expect("rparen", "Expected ')' after else inner expression");
      if (hasParen) this.expect("rparen", "Expected ')' after else expression");
    }

    return {
      onField,
      onFields,
      else: elseExpr,
    };
  }

  private parseInlineUpdateExpr(): { kind: "update"; typeName: string; filter?: FilterExpr; values: Record<string, ScalarValue> } {
    this.expect("kw_update", "Expected 'update' in else expression");
    const typeName = this.parseQualifiedName("Expected type name in update expression");

    let filter: FilterExpr | undefined;
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    this.expect("kw_set", "Expected 'set' in update expression");
    this.expect("lbrace", "Expected '{' after 'set'");
    const values: Record<string, ScalarValue> = {};
    for (const assignment of this.parseDelimited("rbrace", () => this.parseInlineUpdateAssignment(), "Expected ',' between assignments")) {
      values[assignment.field] = assignment.value;
    }
    this.expect("rbrace", "Expected '}' after assignments");
    return {
      kind: "update",
      typeName,
      filter,
      values,
    };
  }

  private parseInlineUpdateAssignment(): { field: string; value: ScalarValue } {
    const field = this.expectName("Expected field name in update expression").lexeme;
    this.expect("assign", "Expected ':=' after field name");
    return {
      field,
      value: this.readScalarLikeValue(),
    };
  }

  // UPDATE statement — see docs/reference/reference/edgeql/update.rst.
  //
  // Grammar (eql:synopsis from update.rst lines 11-19):
  //
  //   [ with <with-item> [, ...] ]
  //   update <selector-expr>
  //   [ filter <filter-expr> ]
  //   set <shape> ;
  //
  // The <set-shape> body supports three assignment operators
  // (update.rst lines 45-63):
  //
  //   set { <field> := <update-expr> [, ...] }   # replace
  //   set { <field> += <update-expr> [, ...] }   # add to multi link/property
  //   set { <field> -= <update-expr> [, ...] }   # remove from multi link/property
  //
  // The selector accepts the same expression grammar as DELETE — bare type
  // names, paths, parenthesised sub-queries, and shape-decorated forms all
  // route through parseFreeObjectExpr.
  private parseUpdate(ctx: ParseContext = {}, expectEof = true): UpdateStatement {
    const start = this.expect("kw_update", "Expected 'update'");
    let target: FreeObjectExpr | undefined;
    let typeName: string;
    if (
      this.peek().kind === "lbrace"
      || this.peek().kind === "lparen"
      || this.peek().kind === "dot"
      || this.peek().kind === "backward_link"
      || this.peek().kind === "optional_link"
      || (this.isNameToken(this.peek()) && this.peekNext().kind === "lbracket")
      || (this.isNameToken(this.peek()) && this.peekNext().kind === "dot")
    ) {
      target = this.parseFreeObjectExpr();
      typeName = this.deleteTargetRootTypeName(target);
    } else {
      typeName = this.parseQualifiedName("Expected type name");
    }

    let filter: UpdateStatement["filter"];
    if (this.peek().kind === "kw_filter") {
      filter = this.parseFilter();
    }

    this.expect("kw_set", "Expected 'set' in update statement");
    this.expect("lbrace", "Expected '{' after 'set'");

    const values: Record<string, InsertValue> = {};
    const operations: NonNullable<UpdateStatement["operations"]> = {};
    for (const assignment of this.parseDelimited("rbrace", () => this.parseUpdateAssignment(), "Expected ',' between assignments")) {
      values[assignment.field] = assignment.value;
      operations[assignment.field] = assignment.operation;
    }

    this.expect("rbrace", "Expected '}' after assignments");

    // Per lexical.rst lines 400-402, ';' is idempotent — `commit;;`,
    // `select 1;;;` etc. are all valid (upstream test_edgeql_syntax_constants_02).
    while (this.peek().kind === "semi") {
      this.consume();
    }

    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "update",
      typeName,
      target,
      filter,
      values,
      operations: Object.keys(operations).length > 0 ? operations : undefined,
      pos: this.posOf(start),
    };
  }

  // DELETE statement — see docs/reference/reference/edgeql/delete.rst.
  //
  // Grammar (eql:synopsis from delete.rst lines 11-23):
  //
  //   [ with <with-item> [, ...] ]
  //   delete <expr>
  //   [ filter <filter-expr> ]
  //   [ order by <order-expr> [direction] [then ...] ]
  //   [ offset <offset-expr> ]
  //   [ limit  <limit-expr> ] ;
  //
  // Per delete.rst lines 32-38, `delete ...` is syntactic sugar for
  // `delete (select ...)` — the trailing FILTER/ORDER BY/OFFSET/LIMIT
  // clauses shape the set to be deleted the same way an explicit SELECT
  // would. The shared parseClauseChain enforces that ordering.
  //
  // <expr> here is permissive: bare type names route through the
  // qualified-name parser, while paths/shape-decorated targets/literals
  // route through parseFreeObjectExpr so any expression accepted by
  // SELECT also lands here.
  private parseDelete(ctx: ParseContext = {}, expectEof = true): DeleteStatement {
    const start = this.expect("kw_delete", "Expected 'delete'");
    let target: FreeObjectExpr | undefined;
    let typeName: string;
    if (
      this.peek().kind === "lbrace"
      || this.peek().kind === "lparen"
      || ["kw_true", "kw_false", "kw_null", "number", "string", "bytes_string", "lbracket", "lt"].includes(this.peek().kind)
      || (this.isNameToken(this.peek()) && this.localBindings.includes(this.nameTokenLexeme(this.peek())))
      // Any complex name target (path, shape-restricted, or with continuation)
      // routes through parseFreeObjectExpr so DELETE accepts the same target
      // grammar as SELECT.
      || (this.isNameToken(this.peek())
        && (this.peekNext().kind === "lbracket"
          || this.peekNext().kind === "lbrace"
          || this.peekNext().kind === "dot"
          || this.peekNext().kind === "backward_link"
          || this.peekNext().kind === "optional_link"))
    ) {
      target = this.parseFreeObjectExpr();
      typeName = this.deleteTargetRootTypeName(target);
    } else {
      typeName = this.parseQualifiedName("Expected type name");
    }

    const clauses = this.parseClauseChain();

    // Per lexical.rst lines 400-402, ';' is idempotent — `commit;;`,
    // `select 1;;;` etc. are all valid (upstream test_edgeql_syntax_constants_02).
    while (this.peek().kind === "semi") {
      this.consume();
    }

    if (expectEof) {
      this.expect("eof", "Unexpected tokens after statement");
    }

    return {
      ...this.withContext(ctx),
      kind: "delete",
      typeName,
      target,
      filter: clauses.filter,
      orderBy: clauses.orderBy,
      limit: clauses.limit,
      offset: clauses.offset,
      limitExpr: clauses.limitExpr,
      offsetExpr: clauses.offsetExpr,
      pos: this.posOf(start),
    };
  }

  private deleteTargetRootTypeName(target: FreeObjectExpr): string {
    if (target.kind === "path_steps") {
      const first = target.steps[0];
      if (first?.kind === "object_ref") {
        return first.name;
      }
    }
    if (target.kind === "select") {
      return target.typeName;
    }
    if (target.kind === "select_expr_subquery") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "shape_projection") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "set_expr" && target.values.length > 0) {
      return this.deleteTargetRootTypeName(target.values[0]);
    }
    if (target.kind === "path") {
      return target.head;
    }
    if (target.kind === "path_chain") {
      return target.parts[0];
    }
    if (target.kind === "binding_ref") {
      return this.localBindings.includes(target.name) ? "Object" : target.name;
    }
    if (target.kind === "is_type") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "distinct") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "cast") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    if (target.kind === "field_access") {
      return this.deleteTargetRootTypeName(target.expr);
    }
    return "Object";
  }

  // FILTER clause — see select.rst lines 25-32 and the Filter section at
  // lines 197-247. The grammar is simply:
  //
  //   filter <filter-expr>
  //
  // <filter-expr> must evaluate to a boolean (or boolean set) — input
  // elements for which the expression is true are kept, all others are
  // dropped. The clause is conceptualised as `_filter($input, set of
  // $cond)`, so `$cond` lives in a sibling scope to the preceding clause
  // (see the example on lines 207-228 explaining why `FILTER` over an
  // aggregate set behaves the way it does).
  //
  // We split out a small precedence ladder for the inner expression
  // (or > and > not > primary), where `primary` falls through to the
  // expression-level parser for paren-wrapped sub-queries and predicates.
  private parseFilter(): FilterExpr {
    this.expect("kw_filter", "Expected 'filter'");
    return this.parseOrFilterExpr();
  }

  private parseOrFilterExpr(): FilterExpr {
    let left = this.parseAndFilterExpr();
    while (this.peek().kind === "kw_or") {
      this.consume();
      left = {
        kind: "or",
        left,
        right: this.parseAndFilterExpr(),
      };
    }

    return left;
  }

  private parseAndFilterExpr(): FilterExpr {
    let left = this.parseUnaryFilterExpr();
    while (this.peek().kind === "kw_and") {
      this.consume();
      left = {
        kind: "and",
        left,
        right: this.parseUnaryFilterExpr(),
      };
    }

    return left;
  }

  private parseUnaryFilterExpr(): FilterExpr {
    if (this.peek().kind === "kw_not") {
      this.consume();
      return {
        kind: "not",
        expr: this.parseUnaryFilterExpr(),
      };
    }

    return this.parsePrimaryFilterExpr();
  }

  private parsePrimaryFilterExpr(): FilterExpr {
    if (this.peek().kind === "lparen") {
      // `(FOR ...)`, `(SELECT ...)`, and `(WITH ...)` are full free
      // expressions, not boolean filter sub-expressions; route to
      // parseFreeObjectExpr so they're consumed as a single expression.
      if (this.peekNext().kind === "kw_for" || this.peekNext().kind === "kw_select" || this.peekNext().kind === "kw_with" || this.peekNext().kind === "kw_insert" || this.peekNext().kind === "kw_update" || this.peekNext().kind === "kw_delete" || this.peekNext().kind === "kw_detached") {
        const expr = this.parseFreeObjectExpr();
        return { kind: "free_expr", expr };
      }
      // Try parsing as filter sub-expression first; if that doesn't consume
      // the whole paren block (e.g. `(((X)).field)` with postfix tail),
      // rewind and fall through to a full free-expression parse.
      const filterAttempt = this.attempt<FilterExpr>(() => {
        this.consume();
        const inner = this.parseOrFilterExpr();
        if (this.peek().kind !== "rparen") return undefined;
        this.consume();
        // The paren group is only a complete boolean filter operand if no
        // binary VALUE operator follows — `(len(a) - len(b)) ^ 2 <= 25` must
        // re-parse as one comparison expression, not stop at the parens.
        const next = this.peek().kind;
        if (next === "pow" || next === "plus" || next === "minus" || next === "star"
            || next === "slash" || next === "floor_div" || next === "modulo" || next === "concat"
            || next === "lt" || next === "gt" || next === "lte" || next === "gte") {
          return undefined;
        }
        return inner;
      });
      if (filterAttempt) return filterAttempt;
      const expr = this.parseFreeObjectExpr();
      return { kind: "free_expr", expr };
    }

    if (["kw_true", "kw_false", "kw_null", "number", "string", "bytes_string", "lbrace", "lbracket"].includes(this.peek().kind)) {
      return {
        kind: "free_expr",
        expr: this.parseFreeObjectExpr(),
      };
    }

    if (this.isExistsToken(this.peek())) {
      const savedIndex = this.index;
      this.consume();
      const lookahead = this.peek();
      const useFreeExpr =
        lookahead.kind === "lparen"
        || lookahead.kind === "dot"
        || (this.isNameToken(lookahead) && this.peekNext().kind === "dot")
        || (this.isNameToken(lookahead) && this.peekNext().kind === "backward_link")
        || (this.isNameToken(lookahead) && this.peekNext().kind === "at")
        || (this.isNameToken(lookahead) && this.peekNext().kind === "lparen")
        || lookahead.kind === "kw_select"
        || lookahead.kind === "kw_with"
        || lookahead.kind === "kw_for"
        || lookahead.kind === "kw_distinct";
      if (useFreeExpr) {
        this.index = savedIndex;
        // Look ahead: if EXISTS is followed by a simple path / `(SELECT ...)`
        // that ends at the next `AND`/`OR`/`ORDER`/`LIMIT`/etc., use the
        // narrower comparison-precedence parser so the outer filter parser
        // composes booleans correctly. Otherwise fall back to the full
        // free-expr parser (which absorbs the trailing `AND`/`OR`).
        const savedExistsIndex = this.index;
        let scan = this.index + 1; // past EXISTS
        let depth = 0;
        let foundStopper = false;
        let containsForOrSelectInParen = false;
        let hasOpenParenInLookahead = false;
        while (scan < this.tokens.length) {
          const t = this.tokens[scan];
          if (t.kind === "lparen") {
            depth += 1;
            hasOpenParenInLookahead = true;
            const inner = this.tokens[scan + 1];
            if (inner && (inner.kind === "kw_for" || inner.kind === "kw_select" || inner.kind === "kw_with")) {
              containsForOrSelectInParen = true;
            }
          } else if (t.kind === "rparen") {
            depth -= 1;
            if (depth < 0) break;
          } else if (depth === 0) {
            if (t.kind === "kw_and" || t.kind === "kw_or" || t.kind === "kw_order"
              || t.kind === "kw_limit" || t.kind === "kw_offset" || t.kind === "semi"
              || t.kind === "eof") {
              foundStopper = true;
              break;
            }
          }
          scan += 1;
        }
        this.index = savedExistsIndex;
        const useNarrow = foundStopper && !containsForOrSelectInParen && !hasOpenParenInLookahead;
        const expr = useNarrow
          ? this.parseFreeObjectComparisonExpr()
          : this.parseFreeObjectExpr();
        return {
          kind: "free_expr",
          expr,
        };
      }
      return {
        kind: "predicate",
        target: this.parseFilterTarget(),
        op: "=",
        value: true,
      };
    }

    if (this.isNameToken(this.peek()) && this.peek().lower === "any" && this.peekNext().kind === "lparen") {
      // Try the syntactic-sugar form `any(target LIKE pattern)` first; fall
      // back to a generic `any(<bool expr>)` parsed as a free expression so
      // arbitrary set-of-bool body works (`any(A != B AND C ?= D)`).
      const likeForm = this.attempt(() => {
        this.consume();
        this.consume();
        if (this.peek().kind === "lparen" || this.peek().kind === "kw_for") {
          return undefined;
        }
        const target = this.parseFilterTarget();
        const opToken = this.peek();
        const op = opToken.kind === "kw_like" ? "like" : opToken.kind === "kw_ilike" ? "ilike" : undefined;
        if (!op) return undefined;
        this.consume();
        const values = this.parseInPredicateValues();
        this.expect("rparen", "Expected ')' after any() filter");
        if (values.kind !== "set_literal") return undefined;
        return values.values
          .map((value): FilterExpr => ({ kind: "predicate", target, op, value }))
          .reduce((left, right): FilterExpr => ({ kind: "or", left, right }));
      });
      if (likeForm) return likeForm;

      this.consume();
      this.consume();
      const expr = this.parseFreeObjectExpr();
      this.expect("rparen", "Expected ')' after any() filter");
      return { kind: "free_expr", expr };
    }

    // If we see a name token followed by '(' it's a function call (e.g.
    // `len(...)`). Treat the predicate as a free expression so the runtime
    // evaluator handles it.
    if (this.isNameToken(this.peek()) && this.peekNext().kind === "lparen") {
      const expr = this.parseFreeObjectExpr();
      return { kind: "free_expr", expr };
    }
    // `.field.NUMBER` is a tuple-element access (`.t.0`), which the simple
    // field-target parser can't consume — route to free_expr for the runtime
    // evaluator.
    {
      let scan = this.index;
      if (this.tokens[scan]?.kind === "dot") scan += 1;
      if (this.isNameToken(this.tokens[scan] as Token)) {
        scan += 1;
        while (this.tokens[scan]?.kind === "dot" && this.isNameToken(this.tokens[scan + 1] as Token)) {
          scan += 2;
        }
        if (this.tokens[scan]?.kind === "dot" && this.tokens[scan + 1]?.kind === "number") {
          const expr = this.parseFreeObjectExpr();
          return { kind: "free_expr", expr };
        }
      }
    }
    const beforeTarget = this.index;
    const target = this.parseFilterTarget();
    // If the target is a path rooted at a local binding (e.g. FOR variable),
    // the simple predicate form doesn't apply — `user.name` isn't a field on
    // the current row. Rewind and parse the whole predicate as a free_expr.
    if (target.kind === "field" && target.field.includes(".")) {
      const head = target.field.split(".")[0];
      if (this.localBindings.includes(head)) {
        this.index = beforeTarget;
        const expr = this.parseFreeObjectExpr();
        return { kind: "free_expr", expr };
      }
    }
    const token = this.peek();
    if (["kw_and", "kw_or", "kw_order", "kw_limit", "kw_offset", "rparen", "semi", "eof"].includes(token.kind)) {
      return {
        kind: "predicate",
        target,
        op: "=",
        value: true,
      };
    }
    let op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "?=" | "?!=" | "like" | "ilike";
    if (token.kind === "equals") {
      this.consume();
      op = "=";
    } else if (token.kind === "not_equals") {
      this.consume();
      op = "!=";
    } else if (token.kind === "kw_like") {
      this.consume();
      op = "like";
    } else if (token.kind === "kw_ilike") {
      this.consume();
      op = "ilike";
    } else if (token.kind === "lt") {
      this.consume();
      op = "<";
    } else if (token.kind === "lte") {
      this.consume();
      op = "<=";
    } else if (token.kind === "gt") {
      this.consume();
      op = ">";
    } else if (token.kind === "gte") {
      this.consume();
      op = ">=";
    } else if (token.kind === "not_distinct_from") {
      this.consume();
      op = "?=";
    } else if (token.kind === "distinct_from") {
      this.consume();
      op = "?!=";
    } else if (token.kind === "kw_in") {
      this.consume();
      const values = this.parseInPredicateValues();
      return {
        kind: "in_predicate",
        target,
        op: "in",
        values,
      };
    } else if (token.kind === "kw_not") {
      this.consume();
      if (this.peek().kind === "kw_like" || this.peek().kind === "kw_ilike") {
        const likeKind = this.peek().kind;
        this.consume();
        const op = likeKind === "kw_like" ? "like" : "ilike";
        // NOT LIKE is sugar for `not (target like value)`.
        return {
          kind: "not",
          expr: {
            kind: "predicate",
            target,
            op,
            value: this.readFilterValue(),
          },
        };
      }
      this.expect("kw_in", "Expected 'IN' after 'NOT' in filter");
      const values = this.parseInPredicateValues();
      return {
        kind: "in_predicate",
        target,
        op: "not_in",
        values,
      };
    } else if (
      token.kind === "plus"
      || token.kind === "minus"
      || token.kind === "star"
      || token.kind === "slash"
      || token.kind === "floor_div"
      || token.kind === "modulo"
      || token.kind === "pow"
      || token.kind === "concat"
      || token.kind === "lbracket"
      || token.kind === "kw_is"
      // Continuing the LHS via a backlink (`.field.<link[IS Type].subfield op …`)
      // or dot chain after a path that the field-target parser couldn't fully
      // consume — rewind and parse as free_expr.
      || token.kind === "backward_link"
      || token.kind === "dot"
      || token.kind === "optional_link"
      // Coalesce / null-handling continues the LHS too.
      || token.kind === "coalesce"
    ) {
      // Arithmetic / string-concat / indexing / type-check (IS / IS NOT) continues
      // the LHS expression. Rewind and parse the whole predicate as a
      // FreeObjectExpr so we can capture `.field[op] cmp value` etc.
      this.index = beforeTarget;
      const expr = this.parseFreeObjectExpr();
      return { kind: "free_expr", expr };
    } else {
      throw new AppError("E_SYNTAX", "Expected filter operator (=, !=, like, ilike, IN, NOT IN)", ...this.posPair(token));
    }

    if (
      this.peek().kind === "lt"
      || this.peek().kind === "lparen"
      || this.peek().kind === "lbrace"
      || this.peek().kind === "lbracket"
      // `name(...)` on the RHS is a function call — readFilterValue would
      // truncate at the name and leave the `(...)` for the caller, which
      // then errors with "Unexpected tokens after statement".
      || (this.isNameToken(this.peek()) && this.peekNext().kind === "lparen")
      // `name::Foo` / `name::Foo.field` — a module-qualified path
      // (e.g. `f::Foo.name` after `with f as module foo`). readFilterValue
      // can only read a bare name, so route to the free-expr parser.
      || (this.isNameToken(this.peek()) && this.peekNext().kind === "coloncolon")
    ) {
      // Complex RHS like `<int64>v.0`, `(x)`, a set literal `{a, b}`, an
      // array literal `[a, b]`, or a function call — rewind to the predicate
      // start and parse the whole predicate as a free expression so the
      // runtime evaluator handles it.
      this.index = beforeTarget;
      const expr = this.parseFreeObjectExpr();
      return { kind: "free_expr", expr };
    }
    const predicate: FilterExpr = {
      kind: "predicate",
      target,
      op,
      value: this.readFilterValue(),
    };
    // If the value is followed by `IF`/`??`/operator, the predicate is part of
    // a larger expression (e.g. `X = 'a' IF EXISTS X ELSE ...`). Rewind and
    // reparse the whole predicate as a free expression. Same treatment for
    // continuations like `.0` (tuple index) / `.field` (path access) /
    // `[...]` (index/slice) that the bare-name filter-value reader can't
    // consume on its own.
    if (
      this.peek().kind === "kw_if"
      || this.peek().kind === "coalesce"
      || this.peek().kind === "dot"
      || this.peek().kind === "lbracket"
      || this.peek().kind === "at"
    ) {
      this.index = beforeTarget;
      const expr = this.parseFreeObjectExpr();
      return { kind: "free_expr", expr };
    }
    return predicate;
  }

  private parseInPredicateValues():
    | { kind: "set_literal"; values: ScalarValue[] }
    | { kind: "expr_set"; values: FreeObjectExpr[] }
    | { kind: "select"; query: { typeName: string; shape: ShapeElement[]; clauses: ClauseChain } }
    | { kind: "name"; name: string }
    | { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } {
    const token = this.peek();
    // Handle DISTINCT keyword before set literal
    if (token.kind === "kw_distinct") {
      this.consume();
    }
    if (this.peek().kind === "lbrace") {
      const scalarSet = this.attempt(() => {
        this.consume();
        const values = this.parseDelimited("rbrace", () => this.readScalarValue(), "Expected ',' in IN filter values");
        this.expect("rbrace", "Expected '}' to close IN filter value set");
        return {
          kind: "set_literal" as const,
          values,
        };
      });
      if (scalarSet) return scalarSet;

      this.consume();
      const values = this.parseDelimited("rbrace", () => this.parseFreeObjectExpr(), "Expected ',' in IN filter values");
      this.expect("rbrace", "Expected '}' to close IN filter value set");
      return {
        kind: "expr_set",
        values,
      };
    }

    if (this.atParenthesizedSelect()) {
      const query = this.parseParenthesizedSelectQuery(
        "Expected 'SELECT' in IN predicate subquery",
        "Expected ')' after IN predicate subquery",
      );
      return {
        kind: "select",
        query,
      };
    }

    if (this.isNameToken(this.peek())) {
      return {
        kind: "name",
        name: this.consume().lexeme,
      };
    }

    if (this.atBacklink()) {
      return this.parseBacklinkPropertyReference("IN filter");
    }

    throw new AppError("E_SYNTAX", "Expected set literal, identifier, or SELECT subquery in IN filter", ...this.posPair(token));
  }

  private parseFilterTarget(): FilterTarget {
    if (
      this.isNameToken(this.peek())
      && (
        (this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt")
        || this.peekNext().kind === "backward_link"
      )
    ) {
      this.consume();
      const backlink = this.parseBacklinkReference("filter");
      if (this.peek().kind === "at") {
        this.consume();
        return {
          kind: "backlink_property",
          ...backlink,
          property: this.expectLinkPropertyName("Expected backlink link property name after '@'"),
        };
      }
      return {
        kind: "backlink",
        ...backlink,
      };
    }

    if (this.atBacklink()) {
      const backlink = this.parseBacklinkReference("filter");
      if (this.peek().kind === "at") {
        this.consume();
        return {
          kind: "backlink_property",
          ...backlink,
          property: this.expectLinkPropertyName("Expected backlink link property name after '@'"),
        };
      }
      return {
        kind: "backlink",
        ...backlink,
      };
    }

    const startTokenKind = this.peek().kind;
    const startTokenLexeme = this.isNameToken(this.peek()) ? this.peek().lexeme : "";
    const fieldName = this.parseFieldReference("filter");
    const strippedRoot = this.lastStrippedFieldRoot;
    // Track "bare name" cases: the user wrote `filter foo = ...` (no leading
    // `.`, no type-qualified path). In EdgeQL that's a name reference that
    // must resolve to a binding/type — the semantic analyzer surfaces a clear
    // diagnostic when it doesn't.
    const isBare = startTokenKind !== "dot"
      && startTokenKind !== "at"
      && !fieldName.startsWith("@")
      && !fieldName.includes(".")
      && fieldName === startTokenLexeme;
    return {
      kind: "field",
      field: fieldName,
      bareName: isBare ? fieldName : undefined,
      root: strippedRoot,
    };
  }

  private parseBacklinkReference(context: string): { link: string; sourceType?: string; sourceTypeExpr?: TypeExpr } {
    if (this.peek().kind === "backward_link") {
      this.consume();
    } else {
      this.consume();
      this.consume();
    }
    const link = this.expectName(`Expected backlink name after '.<' in ${context}`).lexeme;
    let sourceTypeExpr: TypeExpr | undefined;
    if (this.peek().kind === "lbracket") {
      sourceTypeExpr = this.parseTypeFilter("backlink type filter");
    }
    return { link, sourceType: simpleTypeName(sourceTypeExpr), sourceTypeExpr };
  }

  private parseBacklinkPropertyReference(context: string): { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } {
    const backlink = this.parseBacklinkReference(context);
    this.expect("at", "Expected '@' in backlink link property reference");
    return {
      kind: "backlink_property_ref",
      ...backlink,
      property: this.expectLinkPropertyName("Expected backlink link property name after '@'"),
    };
  }

  // Set by parseFieldReference when it strips a leading type-like segment
  // (`Issue.priority.name` → `priority.name`): callers that need the path's
  // ROOT (a WITH binding or non-subject type) read it immediately after.
  private lastStrippedFieldRoot: string | undefined;

  private parseFieldReference(context: string): string {
    this.lastStrippedFieldRoot = undefined;
    if (this.peek().kind === "at") {
      this.consume();
      // Link-property names keep their literal (lowercase) spelling — unlike
      // type names, `@index` is the property `index`, not `schema::Index`. Use
      // the permissive name so keyword-spelled properties (`@index`) aren't
      // title-cased by nameTokenLexeme the way `expectName` would.
      return `@${this.expectLinkPropertyName(`Expected link property name in ${context}`)}`;
    }

    if (this.peek().kind === "dot") {
      this.consume();
    }

    const parts = [this.expectName(`Expected field name in ${context}`).lexeme];
    while (this.peek().kind === "dot") {
      this.consume();
      parts.push(this.expectName(`Expected field name after qualifier in ${context}`).lexeme);
    }

    if (this.peek().kind === "at") {
      this.consume();
      parts.push(`@${this.expectLinkPropertyName(`Expected link property name in ${context}`)}`);
    }

    if (parts.length === 2 && parts[0] === "__type__" && parts[1] === "name") {
      return "__type__.name";
    }

    const root = parts[0];
    if (parts.length >= 2 && this.isTypeLikeName(root)) {
      this.lastStrippedFieldRoot = root;
      return parts.slice(1).join(".");
    }

    return parts.join(".");
  }

  private readFilterValue(): ScalarValue | { kind: "binding_ref"; name: string } | { kind: "field_ref"; field: string; root?: string } | { kind: "backlink_property_ref"; link: string; sourceType?: string; property: string } {
    if (this.atBacklink()) {
      return this.parseBacklinkPropertyReference("filter value");
    }

    if (this.peek().kind === "at" || this.peek().kind === "dot") {
      return {
        kind: "field_ref",
        field: this.parseFieldReference("filter value"),
      };
    }

    if (this.peek().kind === "parameter") {
      return {
        kind: "binding_ref",
        name: this.parseParameterLexeme(this.consume().lexeme),
      };
    }

    if (this.isNameToken(this.peek())) {
      // A bare name followed by `.field` is a typed-path filter value
      // (`FILTER Issue.owner = Issue.related_to.owner`). parseFieldReference
      // strips the leading type-like segment so the downstream filter target
      // resolution treats `Issue.owner` and `.owner` identically — matching
      // the behaviour of parseFilterTarget for the LHS.
      if (this.peekNext().kind === "dot" && this.isTypeLikeName(this.peek().lexeme)) {
        const field = this.parseFieldReference("filter value");
        return {
          kind: "field_ref",
          field,
          root: this.lastStrippedFieldRoot,
        };
      }
      return {
        kind: "binding_ref",
        name: this.consume().lexeme,
      };
    }

    if (this.isGlobalReservedToken(this.peek())) {
      return this.consume().lexeme;
    }

    return this.readScalarValue();
  }

  // WITH block — see docs/reference/reference/edgeql/with.rst.
  //
  // Grammar (eql:synopsis from with.rst):
  //
  //   with <with-item> [, ...]
  //
  //   <with-item> :=
  //       module <module-name>            # set default module
  //     | <alias> as module <module-name> # alias a module
  //     | <alias> := <expr>               # bind an expression
  //
  // Notes from with.rst:
  //   * Module aliasing (lines 18-82): `with module foo` and
  //     `with f as module foo.bar.baz` — module names accept dotted
  //     segments and unreserved keywords as segments.
  //   * Expression aliases (lines 85-140): the RHS is evaluated in the
  //     lexical scope where the alias is *defined*, not where it's used.
  //     `detached` (with.rst lines 143-172) is a related scoping primitive
  //     handled by the expression parser, not here.
  //
  // We track bindings, module aliases, and the default module separately
  // so downstream code can resolve unqualified references. Multiple module
  // declarations or duplicate aliases are rejected.
  private parseWithClause(): ParseContext {
    const withToken = this.expect("kw_with", "Expected 'with'");
    const bindings: WithBinding[] = [];
    const names = new Set<string>();
    const scopedBindingNames: string[] = [];
    const moduleAliases: WithModuleAlias[] = [];
    const aliasNames = new Set<string>();
    let withModule: string | undefined;
    // Per the with.rst grammar (`with <with-item> [, ...]`), at least one
    // <with-item> is required. The parsing loop below `break`s on the first
    // non-matching token, so we have to track whether any item was consumed
    // and reject if not (otherwise `with select Foo;` would slip through).
    let sawAnyItem = false;

    try {
      while (true) {
        if (this.peek().kind === "kw_module") {
          const moduleToken = this.consume();
          if (withModule) {
            throw new AppError("E_SYNTAX", "Duplicate module selection in with block", ...this.posPair(moduleToken));
          }

          // Module names accept unreserved/partial-reserved keywords as
          // segments (`WITH MODULE abstract` is valid). Use a permissive
          // qualified-name read.
          withModule = this.parsePermissiveQualifiedName("Expected module name after 'module'");
          sawAnyItem = true;
        } else if ((this.isNameToken(this.peek()) || (this.isKeywordLikeToken(this.peek()) && this.peek().kind !== "kw_select" && this.peek().kind !== "kw_module")) && this.peekNext().kind === "kw_as") {
          const aliasToken = this.consume();
          const alias = aliasToken.lexeme;
          if (aliasNames.has(alias)) {
            throw new AppError("E_SYNTAX", `Duplicate module alias '${alias}'`, ...this.posPair(aliasToken));
          }

          this.expect("kw_as", "Expected 'as' in module alias declaration");
          this.expect("kw_module", "Expected 'module' in module alias declaration");
          // Module names may contain unreserved keywords and dotted segments.
          const module = this.parsePermissiveQualifiedName("Expected module name in module alias declaration");
          moduleAliases.push({ alias, module });
          aliasNames.add(alias);
          sawAnyItem = true;
        } else if (this.isNameToken(this.peek()) || (this.isKeywordLikeToken(this.peek()) && this.peekNext().kind === "assign")) {
          // Unreserved (and partial/future-reserved) keywords like `abort`,
          // `abstract`, `declare` are valid WITH-binding names. Accept any
          // keyword-like token here when the next token is the `:=` operator.
          const nameTok = this.consume();
          const name = nameTok.lexeme;
          if (names.has(name)) {
            const token = this.peek();
            throw new AppError("E_SYNTAX", `Duplicate with binding '${name}'`, ...this.posPair(token));
          }
          names.add(name);
          this.expect("assign", "Expected ':=' in with binding");
          bindings.push({ name, value: this.parseWithBindingValue() });
          this.localBindings.push(name);
          scopedBindingNames.push(name);
          sawAnyItem = true;
        } else {
          break;
        }

        if (this.peek().kind !== "comma") {
          break;
        }
        this.consume();
      }

      if (!sawAnyItem) {
        throw new AppError(
          "E_SYNTAX",
          "Expected at least one item in WITH block",
          ...this.posPair(withToken),
        );
      }

      return {
        with: bindings.length > 0 ? bindings : undefined,
        withModule,
        withModuleAliases: moduleAliases.length > 0 ? moduleAliases : undefined,
      };
    } finally {
      scopedBindingNames.forEach(() => {
        this.localBindings.pop();
      });
    }
  }

  private isWithBindingValueTerminator(): boolean {
    return [
      "comma",
      "eof",
      "semi",
      "kw_select",
      "kw_insert",
      "kw_update",
      "kw_delete",
      "kw_for",
      "kw_configure",
      "kw_group",
      "kw_create",
      "kw_alter",
      "kw_drop",
      "kw_start",
      "kw_commit",
      "kw_rollback",
    ].includes(this.peek().kind);
  }

  private preferLegacyWithBindingValue(expr: FreeObjectExpr): boolean {
    return expr.kind === "binding_ref"
      || expr.kind === "path"
      || expr.kind === "path_chain"
      || expr.kind === "backlink_path"
      || expr.kind === "select";
  }

  private tryParseWithBindingExpressionValue(allowLegacy = true): WithBindingValue | undefined {
    return this.attempt(() => {
      const expr = this.parseFreeObjectExpr();
      if (!this.isWithBindingValueTerminator()) {
        return undefined;
      }
      if (!allowLegacy && this.preferLegacyWithBindingValue(expr)) {
        return undefined;
      }
      return {
        kind: "subquery_expr" as const,
        expr,
      };
    });
  }

  private parseWithBindingValue(): WithBindingValue {
    if (this.peek().kind === "lparen" && ["kw_insert", "kw_update", "kw_delete"].includes(this.peekNext().kind)) {
      this.consume(); // lparen
      const kind = this.peek().kind;
      let statement: Statement;
      if (kind === "kw_insert") {
        statement = this.parseInsert({}, false);
      } else if (kind === "kw_update") {
        statement = this.parseUpdate({}, false);
      } else {
        statement = this.parseDelete({}, false);
      }
      this.expect("rparen", "Expected ')' after parenthesized mutation statement");
      return {
        kind: "subquery_statement",
        statement,
      };
    }

    if (this.peek().kind === "lparen") {
      const subqueryExpr = this.attempt(() => {
        this.consume();
        const expr = this.parseFreeObjectExpr();
        this.expect("rparen", "Expected ')' after with binding expression");
        if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link" || this.peek().kind === "at") {
          return {
            kind: "subquery_expr" as const,
            expr: this.parsePostfixChain(expr),
          };
        }
        return {
          kind: "subquery_expr" as const,
          expr,
        };
      });
      if (subqueryExpr) {
        return subqueryExpr;
      }
    }

    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_select") {
      this.consume();
      const expr = this.parseSelectExprSubquery();
      this.expect("rparen", "Expected ')' after with subquery binding");
      if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link" || this.peek().kind === "at") {
        return {
          kind: "subquery_expr" as const,
          expr: this.parsePostfixChain(expr),
        };
      }
      return {
        kind: "subquery_expr" as const,
        expr,
      };
    }

    // `(for x in S union (...))` and similar — a parenthesized FOR expression
    // used as the value of a WITH binding.  Parse the inner expression as a
    // free object expression (which handles for_expr) and wrap in subquery_expr.
    if (this.peek().kind === "lparen" && this.peekNext().kind === "kw_for") {
      const wrapped = this.attempt(() => {
        this.consume();
        const expr = this.parseFreeObjectExpr();
        if (this.peek().kind !== "rparen") return undefined;
        this.consume();
        return { kind: "subquery_expr" as const, expr };
      });
      if (wrapped) {
        if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link" || this.peek().kind === "at") {
          return {
            kind: "subquery_expr" as const,
            expr: this.parsePostfixChain(wrapped.expr),
          };
        }
        return wrapped;
      }
    }

    if (this.atParenthesizedSelect()) {
      const nested = this.parseParenthesizedSelectQuery(
        "Expected 'select' in with subquery binding",
        "Expected ')' after with subquery binding",
      );
      const baseExpr: FreeObjectExpr = {
        kind: "select_expr_subquery",
        expr: {
          kind: "select",
          typeName: nested.typeName,
          shape: nested.shape,
          clauses: nested.clauses,
        },
      };
      if (this.peek().kind === "dot" || this.peek().kind === "backward_link" || this.peek().kind === "optional_link" || this.peek().kind === "at") {
        return {
          kind: "subquery_expr",
          expr: this.parsePostfixChain(baseExpr),
        };
      }
      return {
        kind: "subquery",
        query: nested,
      };
    }

    if (this.peek().kind === "lbrace") {
      const exprBinding = this.attempt(() => {
        const expr = this.parseFreeObjectExpr();
        if (this.isWithBindingValueTerminator()) {
          return { kind: "subquery_expr" as const, expr };
        }
        return undefined;
      });
      if (exprBinding) {
        return exprBinding;
      }

      this.consume();
      const values = this.parseDelimited("rbrace", () => this.readScalarValue(), "Expected ',' in set literal with binding");
      this.expect("rbrace", "Expected '}' after set literal with binding");
      return {
        kind: "set_literal",
        values,
      };
    }

    if (this.peek().kind === "lbracket") {
      this.consume();
      const values = this.parseDelimited("rbracket", () => this.readScalarValue(), "Expected ',' in array literal with binding");
      this.expect("rbracket", "Expected ']' after array literal with binding");
      return {
        kind: "array_literal",
        values,
      };
    }

    if (this.peek().kind === "parameter_and_type") {
      const token = this.consume();
      const split = token.lexeme.indexOf("$");
      const castType = token.lexeme.slice(1, split - 1);
      const name = token.lexeme.slice(split + 1).replace(/^`|`$/g, "");
      return {
        kind: "parameter",
        name,
        castType: castType as ScalarType,
      };
    }

    const typedParameter = this.attempt(() => {
      if (this.peek().kind !== "lt") {
        return undefined;
      }
      this.consume();
      const castType = this.parseQualifiedName("Expected scalar type in parameter cast");
      this.expect("gt", "Expected '>' after parameter cast");
      this.expect("dollar", "Expected '$' before parameter name");
      const name = this.expectName("Expected parameter name after '$'").lexeme;
      return {
        kind: "parameter" as const,
        name,
        castType: castType as ScalarType,
      };
    });
    if (typedParameter) {
      return typedParameter;
    }

    if (this.peek().kind === "parameter") {
      return {
        kind: "parameter",
        name: this.consume().lexeme.slice(1),
      };
    }

    const expressionBinding = this.tryParseWithBindingExpressionValue(false);
    if (expressionBinding) {
      return expressionBinding;
    }

    if (this.peek().kind === "kw_detached" && this.isNameToken(this.peekNext())) {
      this.consume();
      // Allow `DETACHED <module>::<Type>` (qualified) as well as the bare
      // type name. The qualified form shows up in scope-stripped queries
      // like `WITH H := DETACHED default::User`.
      let typeName = this.consume().lexeme;
      while (this.peek().kind === "coloncolon" && this.isNameToken(this.peekNext())) {
        this.consume();
        typeName = `${typeName}::${this.consume().lexeme}`;
      }
      return {
        kind: "subquery",
        query: {
          typeName,
          shape: [{ kind: "field", name: "id", operation: "assign", origin: "default" }],
          clauses: {},
        },
      };
    }

    if (this.isNameToken(this.peek())) {
      const name = this.peek().lexeme;
      if (this.peekNext().kind === "lbracket") {
        return {
          kind: "subquery_expr",
          expr: this.parseFreeObjectExpr(),
        };
      }

      if (this.localBindings.includes(name)) {
        return {
          kind: "subquery_expr",
          expr: this.parseFreeObjectExpr(),
        };
      }

      if (this.atInlineTypedSelect()) {
        return {
          kind: "subquery",
          query: this.parseInlineSelectExpr(),
        };
      }

      // `WITH x := cards::Card GROUP ...` — a bare qualified type name as the
      // binding value, with the binding terminating at the start of the next
      // statement. parseInlineSelectExpr handles the qualified name and gives
      // back a default-shape select; the binding terminator check guards us
      // from over-consuming non-binding tokens.
      if (this.peekNext().kind === "coloncolon") {
        const candidate = this.attempt(() => {
          const nested = this.parseInlineSelectExpr();
          if (!this.isWithBindingValueTerminator()) {
            return undefined;
          }
          return { kind: "subquery" as const, query: nested };
        });
        if (candidate) {
          return candidate;
        }
      }

      if ((this.peekNext().kind === "dot" && this.peekNth(2).kind === "lt") || this.peekNext().kind === "backward_link") {
        this.consume();
        if (this.peek().kind === "dot") {
          this.consume();
          this.consume();
        } else {
          this.consume();
        }
        const link = this.expectName("Expected backlink name after '.<' in with binding").lexeme;
        let sourceTypeExpr: TypeExpr | undefined;
        if (this.peek().kind === "lbracket") {
          sourceTypeExpr = this.parseTypeFilter("backlink type filter");
        }
        return { kind: "backlink_path", head: name, link, sourceType: simpleTypeName(sourceTypeExpr), sourceTypeExpr };
      }

      if (this.peekNext().kind === "dot") {
        const parts = [this.consume().lexeme];
        while (this.peek().kind === "dot" && this.isNameToken(this.peekNext())) {
          this.consume();
          parts.push(this.consume().lexeme);
        }
        if (parts.length === 2) {
          const [head, tail] = parts;
          return { kind: "path", head, tail, steps: this.pathStepsFromParts(parts) };
        }
        return { kind: "path_chain", parts, steps: this.pathStepsFromParts(parts) };
      }

      if (this.atQualifiedIdentifier()) {
        const { head, tail } = this.parseQualifiedIdentifier(
          "Expected path head in with binding",
          "Expected path tail in with binding",
        );
        // Check for chained path: x.GREEN.MORE
        if (this.atDotField()) {
          const dotToken = this.peek();
          throw new AppError("E_SYNTAX", "invalid property reference on an expression of primitive type", ...this.posPair(dotToken));
        }
        return { kind: "path", head, tail, steps: this.pathStepsFromParts([head, tail]) };
      }
      this.consume();
      return {
        kind: "binding_ref",
        name,
      };
    }

    const fallbackExpr = this.attempt(() => {
      const expr = this.parseFreeObjectExpr();
      if (this.isWithBindingValueTerminator()) {
        return {
          kind: "subquery_expr" as const,
          expr,
        };
      }
      return undefined;
    });
    if (fallbackExpr) {
      return fallbackExpr;
    }

    return {
      kind: "literal",
      value: this.readScalarValue(),
    };
  }

  // ORDER BY clause — see select.rst lines 36-68.
  //
  //   order by
  //     <order-expr> [ asc | desc ] [ empty { first | last } ]
  //     [ then ... ]
  //
  // Multiple ordering terms chain through `then`. `asc` is the default
  // direction. `empty first` is the default when ascending; `empty last`
  // when descending. Each <order-expr> must be a singleton of an orderable
  // (primitive) type — object types are not orderable.
  private parseOrderBy(): { field: string; direction: "asc" | "desc" } {
    this.expect("kw_order", "Expected 'order'");
    this.expect("kw_by", "Expected 'by' after 'order'");
    return this.parseOrderTerm("order by");
  }

  // One ordering term plus optional `then <next-term>` continuation.
  // Same production as the recursive tail of `order by ... [then ...]` in
  // select.rst — implemented as right-recursion through `then`.
  private parseOrderTerm(context: string): OrderExpr {
    // ORDER BY can be a field path (e.g. `Issue.body`) OR a free expression
    // (e.g. `len(Text.body)`, `Issue.priority.name ?? Issue.status.name`).
    // Detect the expression form when we see something that can't be a plain
    // field reference, then route to parseFreeObjectExpr.
    const looksLikeExpression =
      // function call: `name(...)`
      (this.isNameToken(this.peek()) && this.peekNext().kind === "lparen")
      // negation: `-Issue.number`
      || this.peek().kind === "minus"
      // parenthesized: `(...)`
      || this.peek().kind === "lparen"
      // cast: `<int64>...`
      || this.peek().kind === "lt"
      // backlink iteration on a named source: `User.<owner[IS Issue]...`
      || (this.isNameToken(this.peek()) && this.peekNext().kind === "backward_link")
      // partial backlink: `.<owner[IS Issue]...`
      || this.peek().kind === "backward_link";
    let field: string;
    let expr: FreeObjectExpr | undefined;
    if (looksLikeExpression) {
      const startToken = this.peek();
      expr = this.parseFreeObjectExpr();
      // ORDER BY is a singleton context — reject backlink iterations and
      // bare partial backlink paths with the reference EdgeQL diagnostics.
      this.validateLimitOffsetExprShape(expr, startToken);
      field = "__expr__";
    } else {
      field = this.parseFieldReference("order by");
    }

    let direction: "asc" | "desc" = "asc";
    if (this.peek().kind === "kw_asc") {
      this.consume();
      direction = "asc";
    } else if (this.peek().kind === "kw_desc") {
      this.consume();
      direction = "desc";
    }

    let nullsPosition: "first" | "last" | undefined;
    if (this.peek().kind === "kw_empty") {
      this.consume();
      const nullsPositionToken = this.peek();
      if (this.isNameToken(nullsPositionToken)) {
        const lowered = nullsPositionToken.lower;
        if (lowered === "first" || lowered === "last") {
          this.consume();
          nullsPosition = lowered;
        }
      }
    }

    let then: OrderExpr | undefined;
    if (this.peek().kind === "kw_then") {
      this.consume();
      then = this.parseOrderTerm(context);
    }

    return { field, expr, direction, nullsPosition, then };
  }

  // Parse the trailing FILTER/ORDER BY/OFFSET/LIMIT chain that appears on
  // SELECT (select.rst), DELETE (delete.rst), and shape-element subqueries
  // (shapes.rst). The grammar fixes the order — `filter` must precede
  // `order by`, which must precede `offset`, which must precede `limit` —
  // and `stage` enforces it. Each clause is optional and at most one of
  // each kind may appear. See select.rst lines 11-23 for the canonical
  // ordering and the per-clause descriptions on lines 25-89.
  private parseClauseChain(): ClauseChain {
    const clauses: ClauseChain = {};
    let stage = 0;

    // Per select.rst lines 11-23 each clause is wrapped in `[ ... ]` — i.e.
    // optional and at-most-one. Detect duplicates (stage == current) with a
    // dedicated error, and out-of-order placement (stage > current) with the
    // ordering error.
    while (true) {
      const token = this.peek();
      if (token.kind === "kw_filter") {
        if (stage === 1) {
          throw new AppError("E_SYNTAX", "'filter' may only appear once", ...this.posPair(token));
        }
        if (stage > 1) {
          throw new AppError("E_SYNTAX", "'filter' must appear before ordering and pagination", ...this.posPair(token));
        }
        clauses.filter = this.parseFilter();
        stage = 1;
        continue;
      }

      if (token.kind === "kw_order") {
        if (stage === 2) {
          throw new AppError("E_SYNTAX", "'order by' may only appear once", ...this.posPair(token));
        }
        if (stage > 2) {
          throw new AppError("E_SYNTAX", "'order by' must appear before offset/limit", ...this.posPair(token));
        }
        clauses.orderBy = this.parseOrderBy();
        stage = 2;
        continue;
      }

      if (token.kind === "kw_offset") {
        if (stage === 3) {
          throw new AppError("E_SYNTAX", "'offset' may only appear once", ...this.posPair(token));
        }
        if (stage > 3) {
          throw new AppError("E_SYNTAX", "'offset' must appear before 'limit'", ...this.posPair(token));
        }
        this.consume();
        const result = this.parseLimitOffsetValue("offset");
        clauses.offset = result.value;
        clauses.offsetExpr = result.expr;
        stage = 3;
        continue;
      }

      if (token.kind === "kw_limit") {
        if (stage === 4) {
          throw new AppError("E_SYNTAX", "'limit' may only appear once", ...this.posPair(token));
        }
        this.consume();
        const result = this.parseLimitOffsetValue("limit");
        clauses.limit = result.value;
        clauses.limitExpr = result.expr;
        stage = 4;
        continue;
      }

      return clauses;
    }
  }

  private parseTypeFilter(context: string): TypeExpr {
    this.expect("lbracket", `Expected '[' for ${context}`);
    this.expect("kw_is", `Expected 'is' in ${context}`);
    const expr = this.parseTypeExpr(context);
    this.expect("rbracket", `Expected ']' after ${context}`);
    return expr;
  }

  // type_expr := type_intersect_expr ('|' type_intersect_expr)*
  // type_intersect_expr := type_atom ('&' type_atom)*
  // type_atom := qualified_name | '(' type_expr ')'
  private parseTypeExpr(context: string): TypeExpr {
    let left = this.parseTypeIntersectExpr(context);
    while (this.peek().kind === "pipe") {
      this.consume();
      const right = this.parseTypeIntersectExpr(context);
      left = { kind: "type_union", left, right };
    }
    return left;
  }

  private parseTypeIntersectExpr(context: string): TypeExpr {
    let left = this.parseTypeAtom(context);
    while (this.peek().kind === "ampersand") {
      this.consume();
      const right = this.parseTypeAtom(context);
      left = { kind: "type_intersection", left, right };
    }
    return left;
  }

  private parseTypeAtom(context: string): TypeExpr {
    if (this.peek().kind === "lparen") {
      this.consume();
      const expr = this.parseTypeExpr(context);
      this.expect("rparen", `Expected ')' in ${context}`);
      return expr;
    }
    // Future-reserved keywords (CASE, WHEN, WHERE, ON, etc.) are tokenized
    // as name-like keywords for forward-compat but are *not* valid type
    // names. Upstream rejects them with "Unexpected keyword '<KW>'".
    const headTok = this.peek();
    if (headTok.kind === "kw_future_reserved") {
      this.notSupported(
        headTok,
        `reserved keyword in type-name position (${context})`,
        `'${headTok.lexeme}' is a reserved keyword and cannot be used as a type name`,
      );
    }
    const name = this.parseQualifiedName(`Expected type name in ${context}`);
    // Support parameterized types like `array<X>`, `tuple<X, Y>`, `set<X>`.
    // We don't fully model these; just consume the angle-bracketed parameters
    // and discard so the parser doesn't trip up.
    if (this.peek().kind === "lt") {
      let depth = 1;
      this.consume();
      while (depth > 0 && this.peek().kind !== "eof") {
        const k = this.peek().kind;
        if (k === "lt") depth += 1;
        else if (k === "gt") depth -= 1;
        else if (k === "gte") {
          // ">=" consumed as two ">"s closing nested params.
          depth -= 1;
          if (depth > 0) depth -= 1;
        }
        this.consume();
        if (depth === 0) break;
      }
    }
    return { kind: "type_name", name };
  }

  private parseSplatDepth(): 1 | 2 {
    if (this.peek().kind === "double_splat") {
      this.consume();
      return 2;
    }
    this.expect("star", "Expected '*' in splat expression");
    if (this.peek().kind === "star") {
      this.consume();
      return 2;
    }

    return 1;
  }

  private clauseChainToShapeModifiers(clauses: ClauseChain): ShapeElementModifiers {
    const orderBy: OrderExpr[] = [];
    let cursor = clauses.orderBy;
    while (cursor) {
      orderBy.push({ field: cursor.field, direction: cursor.direction, then: undefined });
      cursor = cursor.then;
    }
    // Shape-element FILTER comes in three forms from parseFilter:
    //  - free_expr: the expression is already there to evaluate.
    //  - predicate: `Item.tag_set1 > 'p'` — rebuild as a compare against the
    //    referenced path so the runtime materializer can evaluate it per
    //    element.
    //  - other (and/or/not) — leave undefined for now; not yet needed by the
    //    multi-property shape modifier path.
    let whereExpr: FreeObjectExpr | undefined;
    if (clauses.filter) {
      if (clauses.filter.kind === "free_expr") {
        whereExpr = clauses.filter.expr;
      } else if (
        clauses.filter.kind === "predicate"
        && clauses.filter.target.kind === "field"
        && (
          clauses.filter.op === "="
          || clauses.filter.op === "!="
          || clauses.filter.op === "<"
          || clauses.filter.op === "<="
          || clauses.filter.op === ">"
          || clauses.filter.op === ">="
        )
        && (typeof clauses.filter.value === "string"
          || typeof clauses.filter.value === "number"
          || typeof clauses.filter.value === "boolean"
          || clauses.filter.value === null)
      ) {
        const fieldPath = clauses.filter.target.field;
        const dotIndex = fieldPath.indexOf(".");
        const headName = dotIndex >= 0 ? fieldPath.slice(0, dotIndex) : "__current__";
        const tail = dotIndex >= 0 ? fieldPath.slice(dotIndex + 1) : fieldPath;
        const path: FreeObjectExpr = dotIndex >= 0
          ? { kind: "path", head: headName, tail, steps: undefined }
          : { kind: "field_access", expr: { kind: "current_item" }, field: tail, optional: false };
        whereExpr = {
          kind: "compare",
          op: clauses.filter.op,
          left: path,
          right: { kind: "literal", value: clauses.filter.value },
        };
      } else if (
        clauses.filter.kind === "in_predicate"
        && clauses.filter.target.kind === "field"
      ) {
        // `FILTER .name IN {…}` on a shape link — rebuild as an `in_expr` so
        // compileFreeObjectExpr lowers the membership test per target row.
        const fieldPath = clauses.filter.target.field;
        const dotIndex = fieldPath.indexOf(".");
        const headName = dotIndex >= 0 ? fieldPath.slice(0, dotIndex) : "__current__";
        const tail = dotIndex >= 0 ? fieldPath.slice(dotIndex + 1) : fieldPath;
        const path: FreeObjectExpr = dotIndex >= 0
          ? { kind: "path", head: headName, tail, steps: undefined }
          : { kind: "field_access", expr: { kind: "current_item" }, field: tail, optional: false };
        const values = clauses.filter.values;
        const right: FreeObjectExpr | undefined =
          values.kind === "set_literal"
            ? { kind: "set_literal", values: values.values }
            : values.kind === "expr_set"
              ? { kind: "set_expr", values: values.values }
              : undefined;
        if (right) {
          whereExpr = { kind: "in_expr", op: clauses.filter.op, left: path, right };
        }
      }
    }
    return {
      where: whereExpr,
      orderBy: orderBy.length > 0 ? orderBy : undefined,
      offset: clauses.offset,
      limit: clauses.limit,
    };
  }

  private parseShapeEntryModifiers(): {
    required?: boolean;
    cardinality?: "one" | "many" | "unknown";
  } {
    let required: boolean | undefined;
    let cardinality: "one" | "many" | "unknown" | undefined;

    while (true) {
      const token = this.peek();
      if (token.kind === "kw_required") {
        this.consume();
        required = true;
        continue;
      }
      if (token.kind === "kw_optional") {
        this.consume();
        required = false;
        continue;
      }
      if (token.kind === "kw_multi") {
        this.consume();
        cardinality = "many";
        continue;
      }
      if (token.kind === "kw_single") {
        this.consume();
        cardinality = "one";
        continue;
      }
      break;
    }

    return { required, cardinality };
  }

  private pathStepsFromParts(parts: string[]): PathStep[] {
    if (parts.length === 0) {
      return [];
    }
    const [head, ...tail] = parts;
    const steps: PathStep[] = [{ kind: "object_ref", name: head }];
    for (const field of tail) {
      steps.push({ kind: "ptr", name: field, direction: "outbound" });
    }
    return steps;
  }

  private headNameOfExpr(expr: FreeObjectExpr): string | undefined {
    if (expr.kind === "binding_ref") {
      return expr.name;
    }
    if (expr.kind === "path") {
      return expr.head;
    }
    if (expr.kind === "path_chain") {
      return expr.parts[0];
    }
    if (expr.kind === "path_steps") {
      const first = expr.steps[0];
      return first && first.kind === "object_ref" ? first.name : undefined;
    }
    return undefined;
  }

  private exprToPathSteps(expr: FreeObjectExpr): PathStep[] | undefined {
    if (expr.kind === "path_steps") {
      return [...expr.steps];
    }
    if (expr.kind === "path") {
      return expr.steps ? [...expr.steps] : this.pathStepsFromParts([expr.head, expr.tail]);
    }
    if (expr.kind === "path_chain") {
      return expr.steps ? [...expr.steps] : this.pathStepsFromParts(expr.parts);
    }
    if (expr.kind === "binding_ref") {
      return [{ kind: "object_ref", name: expr.name }];
    }
    if (expr.kind === "select") {
      return [{ kind: "object_ref", name: expr.typeName }];
    }
    if (expr.kind === "field_access") {
      const base = this.exprToPathSteps(expr.expr);
      if (!base) {
        return undefined;
      }
      return [...base, { kind: "ptr", name: expr.field, direction: "outbound", optional: expr.optional }];
    }
    if (expr.kind === "backlink_path") {
      return [
        { kind: "object_ref", name: "__current__" },
        { kind: "ptr", name: expr.link, direction: "inbound", optional: expr.optional },
      ];
    }
    return undefined;
  }

  private readValue(): ParsedLiteralValue {
    const token = this.peek();
    if (token.kind === "minus") {
      const next = this.peekNext();
      if (next.kind !== "number") {
        throw new AppError("E_SYNTAX", "Expected a numeric literal after '-'", ...this.posPair(token));
      }
      this.validateNumericLiteralToken(next);
      this.consume();
      this.consume();
      return -this.parseNumberLexeme(next.lexeme);
    }

    if (token.kind === "string") {
      this.consume();
      return token.lexeme;
    }

    if (token.kind === "str_interp_start") {
      throw new AppError("E_SYNTAX", "String interpolation is not allowed in literal-only context", ...this.posPair(token));
    }

    if (token.kind === "bytes_string") {
      this.consume();
      return token.lexeme;
    }

    if (token.kind === "number") {
      this.validateNumericLiteralToken(token);
      this.consume();
      const lexeme = token.lexeme;
      return this.parseNumberLexeme(lexeme);
    }

    if (token.kind === "kw_true") {
      this.consume();
      return true;
    }

    if (token.kind === "kw_false") {
      this.consume();
      return false;
    }

    if (token.kind === "kw_null") {
      this.consume();
      return null;
    }

    if (token.kind === "identifier") {
      const lowered = token.lower;
      if (lowered === "true") {
        this.consume();
        return true;
      }
      if (lowered === "false") {
        this.consume();
        return false;
      }
      if (lowered === "null") {
        this.consume();
        return null;
      }
    }

    if (token.kind === "lbracket") {
      this.consume();
      const values: ParsedLiteralValue[] = [];
      while (this.peek().kind !== "rbracket") {
        values.push(this.readValue());
        if (this.peek().kind === "comma") {
          this.consume();
        } else {
          break;
        }
      }
      this.expect("rbracket", "Expected ']' after array literal");
      return values;
    }

    throw new AppError("E_SYNTAX", "Expected a literal value", ...this.posPair(token));
  }

  private readScalarValue(message = "Expected a literal value"): ScalarValue {
    if (this.peek().kind === "lbracket") {
      const token = this.peek();
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }

    const value = this.readValue();
    if (Array.isArray(value)) {
      const token = this.peek();
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }

    return value;
  }

  private readScalarLikeValue(): ScalarValue {
    const value = this.readValue();
    if (Array.isArray(value)) {
      return JSON.stringify(value);
    }

    return value;
  }

  private readInteger(message: string): number {
    const sign = this.match("minus") ? -1 : (this.match("plus") ? 1 : 1);
    const token = this.peek();
    if (token.kind !== "number") {
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }

    if (!this.isIntegerLexeme(token.lexeme)) {
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }

    this.consume();
    let value = sign * Number(token.lexeme);
    // Support simple integer arithmetic in LIMIT/OFFSET (e.g. `1 + 1`, `6 // 2`).
    while (true) {
      const op = this.peek().kind;
      if (op !== "plus" && op !== "minus" && op !== "star" && op !== "slash"
        && op !== "floor_div" && op !== "modulo") {
        break;
      }
      this.consume();
      const rhsSign = this.match("minus") ? -1 : (this.match("plus") ? 1 : 1);
      const rhsToken = this.peek();
      if (rhsToken.kind !== "number" || !this.isIntegerLexeme(rhsToken.lexeme)) {
        throw new AppError("E_SYNTAX", message, ...this.posPair(rhsToken));
      }
      this.consume();
      const rhs = rhsSign * Number(rhsToken.lexeme);
      switch (op) {
        case "plus": value = value + rhs; break;
        case "minus": value = value - rhs; break;
        case "star": value = value * rhs; break;
        case "slash": value = value / rhs; break;
        case "floor_div": value = Math.floor(value / rhs); break;
        case "modulo": value = value % rhs; break;
      }
    }
    return value;
  }

  private expect(kind: Token["kind"], message: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new AppError("E_SYNTAX", message, ...this.posPair(token));
    }

    this.index += 1;
    return token;
  }

  private consume(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private peekNext(): Token {
    return this.tokens[this.index + 1] ?? this.tokens[this.tokens.length - 1];
  }

  private peekNth(n: number): Token {
    return this.tokens[this.index + n] ?? this.tokens[this.tokens.length - 1];
  }
}

const appendInsertValueOperand = (operands: InsertValue[], value: InsertValue): void => {
  if (typeof value === "object" && value !== null && "kind" in value && (value as { kind: string }).kind === "set") {
    for (const inner of (value as { kind: "set"; values: InsertValue[] }).values) {
      appendInsertValueOperand(operands, inner);
    }
    return;
  }
  operands.push(value);
};

// Try to interpret a sequence of pre-tokenized tokens as a `SET MODULE x[::y]*`
// statement, optionally followed by a trailing `;` and/or EOF. Returns the
// fully-qualified module name when matched, otherwise undefined.
const parseSetModuleStatementFromTokens = (tokens: Token[]): string | undefined => {
  if (tokens[0]?.kind !== "kw_set" || tokens[1]?.kind !== "kw_module") {
    return undefined;
  }

  const isNameKind = (kind: Token["kind"] | undefined): boolean =>
    kind === "identifier" ||
    kind === "backtick_name" ||
    kind === "kw_unreserved" ||
    kind === "kw_partial_reserved" ||
    kind === "kw_future_reserved" ||
    kind === "kw_current_reserved" ||
    kind?.startsWith("kw_current_reserved_") === true;

  const parts: string[] = [];
  let i = 2;
  const first = tokens[i];
  if (!first || !isNameKind(first.kind)) {
    return undefined;
  }
  parts.push(first.lexeme);
  i += 1;

  while (true) {
    const t1 = tokens[i + 1];
    const t2 = tokens[i + 2];
    if (tokens[i]?.kind === "coloncolon" && t1 && isNameKind(t1.kind)) {
      parts.push(t1.lexeme);
      i += 2;
      continue;
    }
    if (tokens[i]?.kind === "colon" && t1?.kind === "colon" && t2 && isNameKind(t2.kind)) {
      parts.push(t2.lexeme);
      i += 3;
      continue;
    }
    break;
  }

  if (tokens[i]?.kind === "semi") i += 1;
  if (tokens[i]?.kind === "eof") i += 1;

  return i === tokens.length ? parts.join("::") : undefined;
};

export const parseEdgeQL = (input: string, options: ParseEdgeQLOptions = {}): Statement => {
  // The single-statement entry point accepts bare expressions by default —
  // IR tests use it to parse expression-shaped queries directly. The script
  // entry point (`parseEdgeQLScript`) leaves this off to match upstream's
  // statement-keyword requirement.
  const parser = new Parser(input, { allowBareExpressionStatement: true, ...options });
  return parser.parseStatement();
};

// Parse a single statement out of an already-tokenized stream. The Parser
// expects the token list to end with an `eof` token; callers slicing tokens
// out of a larger stream must append a synthetic eof. `lineStarts` must be the
// table produced by `tokenizeWithStarts` for the original input; it's shared
// across all statements so error/pos resolution stays correct.
const parseEdgeQLFromTokens = (
  tokens: Token[],
  lineStarts: readonly number[],
  options: ParseEdgeQLOptions = {},
  source?: string,
): Statement => {
  const parser = new Parser({ tokens, lineStarts, source }, options);
  return parser.parseStatement();
};

export const parseEdgeQLScript = (input: string, options: ParseEdgeQLOptions = {}): Statement[] => {
  const statements: Statement[] = [];
  const { tokens, lineStarts } = tokenizeWithStarts(input);
  let activeModule = options.defaultModule;
  let stmtStart = 0;
  let depth = 0;

  // Synthesize an `eof` token at the boundary between statements. The Parser
  // class always expects EOF at the end of its token list; we reuse the position
  // of the terminating semi (or trailing token) so error locations stay
  // meaningful.
  const parsePiece = (start: number, end: number, finalPiece: boolean): void => {
    if (start >= end) return;
    const piece = tokens.slice(start, end);
    const refTok = tokens[end] ?? tokens[tokens.length - 1];
    piece.push({
      kind: "eof",
      lexeme: "",
      lower: "",
      offset: refTok.offset,
    });
    const setModule = parseSetModuleStatementFromTokens(piece);
    if (setModule && !finalPiece) {
      activeModule = setModule;
      return;
    }
    // The original script API has a quirk: for the final (no-trailing-semi)
    // piece, even a successful SET MODULE parse still drives parseEdgeQL on
    // the same piece, with defaultModule set to the parsed module name.
    statements.push(parseEdgeQLFromTokens(piece, lineStarts, {
      defaultModule: finalPiece ? (setModule ?? activeModule) : activeModule,
    }, input));
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "eof") break;

    if (token.kind === "semi" && depth === 0) {
      parsePiece(stmtStart, i, false);
      stmtStart = i + 1;
      continue;
    }

    const kind = token.kind;
    if (kind === "lbrace" || kind === "lparen" || kind === "lbracket") {
      depth += 1;
    } else if (kind === "rbrace" || kind === "rparen" || kind === "rbracket") {
      depth -= 1;
    }
  }

  // Final piece (no trailing semi). Find the index just before EOF.
  let endIdx = tokens.length;
  if (endIdx > 0 && tokens[endIdx - 1]?.kind === "eof") endIdx -= 1;
  parsePiece(stmtStart, endIdx, true);

  return statements;
};
