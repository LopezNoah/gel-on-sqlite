import type { DDLStatement, Statement } from "../edgeql/ast.js";
import { parseEdgeQLScript, type ParseEdgeQLOptions } from "../edgeql/parser.js";
import { tokenize, type Token } from "../edgeql/tokenizer.js";
import { AppError, tryResult } from "../errors.js";

// Exact module names that are owned by the system / stdlib and may not be
// mutated by user-issued DDL. The match is exact: `std::Foo` and
// `std::math::Foo` are rejected because their parent modules (`std`,
// `std::math`) are in this set, but `std::test::Foo` is allowed because
// `std::test` is not — its parent module is a user-namespace sibling of the
// stdlib submodules. This matches the behaviour
// `test_edgeql_expr_with_module_07/_08` relies on (creating `std::test`
// during a test) alongside the rejections in `test_edgeql_userddl_09–18`.
const PROTECTED_MODULES = new Set<string>([
  "std",
  "std::math",
  "std::enc",
  "std::lang",
  "std::net",
  "std::net::http",
  "std::net::webhook",
  "std::pg",
  "schema",
  "cfg",
  "sys",
  "cal",
  "fts",
  "ext",
]);

// Module prefixes that protect everything underneath them, not just exact
// matches. `ext::*` is the extension namespace — anything below `ext` is
// system-managed even if the user creates a sub-module (test_edgeql_userddl_29).
// This is stricter than the `std::*` rule, where user-created sibling modules
// like `std::test` are deliberately allowed.
const PROTECTED_MODULE_PREFIXES = ["ext::"];

const isProtectedModule = (modulePath: string): boolean => {
  if (PROTECTED_MODULES.has(modulePath)) return true;
  for (const prefix of PROTECTED_MODULE_PREFIXES) {
    if (modulePath.startsWith(prefix)) return true;
  }
  return false;
};

const verbForAction = (action: DDLStatement["action"]): string => {
  switch (action) {
    case "create": return "create";
    case "drop": return "delete";
    case "alter": return "alter";
  }
};

// Extract the module path that a DDL statement targets. For `CREATE TYPE
// std::Foo` → `std`; for `CREATE FUNCTION std::math::f(...)` → `std::math`;
// for `CREATE MODULE std` / `DROP MODULE std::math` the whole name *is* the
// module path. Returns `undefined` when the statement targets the default
// module (unqualified name with non-module objectKind).
const targetModulePath = (ast: DDLStatement): string | undefined => {
  const fullName = ast.name;
  if (!fullName) return undefined;
  if (ast.objectKind === "module") return fullName;
  const parts = fullName.split("::");
  if (parts.length < 2) return undefined;
  parts.pop();
  return parts.join("::");
};

// Strip the optional `std::` module prefix from a type name so we can match
// against the bare scalar names below regardless of how the user spelled them.
const stripStdPrefix = (typeName: string): string =>
  typeName.startsWith("std::") ? typeName.slice("std::".length) : typeName;

// Abstract/generic type names that are reserved for built-in polymorphic
// resolution and are not legal in user-defined function signatures.
const GENERIC_USER_FUNCTION_TYPES = new Set<string>([
  "anytype",
  "anyobject",
  "anyscalar",
  "anyreal",
  "anyint",
  "anyfloat",
  "anynumeric",
  "anyenum",
  "anytuple",
  "anyrange",
  "anycontiguous",
  "anydiscrete",
  "anypoint",
]);

const stripTypeModifiers = (typeText: string): string => {
  let cleaned = typeText.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const lower = cleaned.toLowerCase();
    if (lower.startsWith("optional ") || lower.startsWith("optional\t")) {
      cleaned = cleaned.slice("optional".length).trimStart();
      changed = true;
      continue;
    }
    if (lower.startsWith("set of ") || lower.startsWith("set of\t")) {
      cleaned = cleaned.slice("set of".length).trimStart();
      changed = true;
    }
  }
  return cleaned;
};

const isGenericFunctionType = (typeText: string | undefined): boolean => {
  if (!typeText) return false;
  const cleaned = stripTypeModifiers(typeText).toLowerCase();
  return GENERIC_USER_FUNCTION_TYPES.has(stripStdPrefix(cleaned));
};

// True when a param's type expression carries a leading `set of` keyword —
// catches `a: SET OF str` (test 19). Param-level `setOf` flag in the AST
// only covers the pre-colon form which isn't what user-defined functions
// write; the in-type-expression form is the real-world case here.
const isSetOfTypeText = (typeText: string | undefined): boolean => {
  if (!typeText) return false;
  const lower = typeText.trim().toLowerCase();
  return lower.startsWith("set of ") || lower.startsWith("set of\t");
};

// Field names that cannot be set via `SET <name> := …` inside a
// CREATE FUNCTION / ALTER FUNCTION body. These are internal compiler flags
// that user-DDL doesn't have access to (test_edgeql_userddl_21, 25, 26, 27).
const FORBIDDEN_FUNCTION_SET_FIELDS = new Set<string>([
  "fallback",
  "force_return_cast",
]);

// `cfg::*` types are the configuration-object hierarchy. Extending them is
// rejected upstream (test_edgeql_userddl_28).
const SYSTEM_EXTENDABLE_TYPE_PREFIXES = ["cfg::"];

const isSystemTypeName = (typeName: string): boolean =>
  SYSTEM_EXTENDABLE_TYPE_PREFIXES.some((prefix) => typeName.startsWith(prefix));

// Per-statement validator. Rejects DDL whose target lives in a read-only
// module — the upstream Python suite (test_edgeql_userddl.py 09-13, 15,
// 17, 18) drives the exact error-message shape, so the formats here are
// designed to match `cannot create|delete|alter.*module <head> is read-only`.
// `strict` mirrors `INTERNAL_TESTMODE = False` upstream: when true, the
// validator enforces user-DDL restrictions on object kinds, function
// signatures and extending clauses. The read-only-module guard is also
// enforced under strict mode, but `internalTestMode` (toggled by
// `configure session set __internal_testmode := true`) bypasses it so the
// upstream "internal test mode" escape hatch works (test_edgeql_userddl_29).
export const validateUserDDL = (
  ast: DDLStatement,
  strict: boolean = false,
  internalTestMode: boolean = false,
): void => {
  if (strict) {
    // Object-kind / function-decl checks run before the read-only-module
    // check so an unsupported kind reports its dedicated error message even
    // when it happens to target the stdlib namespace (e.g. CREATE INFIX
    // OPERATOR std::`+` ... reports "user-defined operators are not supported"
    // rather than the more generic "module std is read-only").
    validateUnsupportedObjectKind(ast);
    validateFunctionDecl(ast);
    validateFunctionSetCommands(ast);
    validateExtendingClause(ast);
  }
  if (!internalTestMode) {
    validateReadOnlyModule(ast);
  }
};

const validateReadOnlyModule = (ast: DDLStatement): void => {
  const modulePath = targetModulePath(ast);
  if (modulePath === undefined) return;

  if (!isProtectedModule(modulePath)) return;

  const verb = verbForAction(ast.action);
  const reportedHead = modulePath.split("::")[0];
  throw new AppError(
    "E_SEMANTIC",
    `cannot ${verb} ${ast.objectKind} '${ast.name}': module ${reportedHead} is read-only`,
    ast.pos.line,
    ast.pos.column,
  );
};

// Reject DDL targeting object kinds / modifiers that are reserved for the
// system and not exposed to user-DDL: CREATE INFIX/PREFIX/POSTFIX OPERATOR
// (07), CREATE CAST (08), CREATE PSEUDO TYPE (23).
const validateUnsupportedObjectKind = (ast: DDLStatement): void => {
  if (ast.action !== "create") return;
  if (ast.objectKind === "operator") {
    throw new AppError(
      "E_UNSUPPORTED",
      `user-defined operators are not supported`,
      ast.pos.line,
      ast.pos.column,
    );
  }
  if (ast.objectKind === "cast") {
    throw new AppError(
      "E_UNSUPPORTED",
      `user-defined casts are not supported`,
      ast.pos.line,
      ast.pos.column,
    );
  }
  if (ast.objectKind === "type" && ast.modifiers?.includes("pseudo")) {
    throw new AppError(
      "E_UNSUPPORTED",
      `user-defined pseudo types are not supported`,
      ast.pos.line,
      ast.pos.column,
    );
  }
};

// CREATE FUNCTION enforcement — generic param/return types and SET OF
// parameters are rejected (tests 01-04, 19); USING SQL bodies / USING SQL
// FUNCTION are rejected (tests 05-06). The shortName is taken from the
// trailing `::`-segment of the qualified name for the error message so it
// reads like `cannot create.*func_NN.*` regardless of how the user spelled
// the module.
const validateFunctionDecl = (ast: DDLStatement): void => {
  if (ast.action !== "create" || ast.objectKind !== "function") return;
  const decl = ast.functionDecl;
  if (!decl) return;

  const shortName = ast.name.split("::").at(-1) ?? ast.name;
  const throwFuncErr = (code: "E_UNSUPPORTED" | "E_SEMANTIC", reason: string): never => {
    throw new AppError(
      code,
      `cannot create function '${shortName}': ${reason}`,
      ast.pos.line,
      ast.pos.column,
    );
  };

  for (const param of decl.params) {
    if (isGenericFunctionType(param.type)) {
      throwFuncErr(
        "E_UNSUPPORTED",
        `generic types are not supported in user-defined functions`,
      );
    }
    if (param.setOf || isSetOfTypeText(param.type)) {
      throwFuncErr(
        "E_UNSUPPORTED",
        `SET OF parameters in user-defined EdgeQL functions are not supported`,
      );
    }
  }
  if (isGenericFunctionType(decl.returnType)) {
    throwFuncErr(
      "E_UNSUPPORTED",
      `generic types are not supported in user-defined functions`,
    );
  }
  if (decl.body.language === "sql") {
    if (decl.body.fromFunction !== undefined) {
      throwFuncErr(
        "E_UNSUPPORTED",
        `USING SQL FUNCTION is not supported in user-defined functions`,
      );
    }
    throwFuncErr(
      "E_UNSUPPORTED",
      `USING SQL is not supported in user-defined functions`,
    );
  }
};

// Reject `SET fallback := …` / `SET force_return_cast := …` inside CREATE
// FUNCTION or ALTER FUNCTION bodies (tests 21, 25, 26, 27). These fields
// are internal compiler flags that user-DDL doesn't have access to. The
// parser captures the SET command names; we only need to scan the list.
const validateFunctionSetCommands = (ast: DDLStatement): void => {
  if (ast.objectKind !== "function") return;
  const sets = ast.setCommands;
  if (!sets || sets.length === 0) return;
  for (const field of sets) {
    if (FORBIDDEN_FUNCTION_SET_FIELDS.has(field.toLowerCase())) {
      throw new AppError(
        "E_SEMANTIC",
        `'${field}' is not a valid field`,
        ast.pos.line,
        ast.pos.column,
      );
    }
  }
};

// `CREATE TYPE Foo EXTENDING cfg::ConfigObject` is rejected — the cfg::
// hierarchy is reserved for the configuration system (test 28).
const validateExtendingClause = (ast: DDLStatement): void => {
  if (ast.action !== "create") return;
  const bases = ast.extendsList;
  if (!bases || bases.length === 0) return;
  for (const base of bases) {
    if (isSystemTypeName(base)) {
      throw new AppError(
        "E_SEMANTIC",
        `cannot extend system type '${base}'`,
        ast.pos.line,
        ast.pos.column,
      );
    }
  }
};

// Convenience pass: parse the script and validate every DDL statement.
// Used at script-execution entry points so registration / pre-pass logic
// never runs against a statement that would have been rejected.
export const validateScriptUserDDL = (
  script: string,
  parserOptions: ParseEdgeQLOptions = {},
  strict: boolean = false,
): void => {
  // Surface the parse error from the main execution path so error
  // messages and positions stay consistent. The pre-validation pass is
  // best-effort: if the script doesn't parse, downstream will report it.
  // tryResult only captures query failures (E_SYNTAX, …) — engine bugs
  // inside the parser still propagate.
  const parsed = tryResult(() => parseEdgeQLScript(script, parserOptions));
  if (!parsed.ok) return;
  const statements: Statement[] = parsed.value;
  // Track `configure session set __internal_testmode := true` / `reset`
  // as we walk the script so subsequent DDL in the same script can
  // legitimately target otherwise-protected modules (test 29's setup
  // creates `ext::_test` under testmode, then resets).
  let internalTestMode = false;
  for (const ast of statements) {
    if (ast.kind === "configure"
      && ast.target.toLowerCase() === "__internal_testmode"
    ) {
      if (ast.operation === "set") internalTestMode = true;
      else if (ast.operation === "reset") internalTestMode = false;
      continue;
    }
    if (ast.kind === "ddl") {
      validateUserDDL(ast, strict, internalTestMode);
    }
  }
};

// Single-statement variant for callers that have already parsed
// (`executeQuery` parses a single Statement up front).
export const validateUserDDLStatement = (ast: Statement, strict: boolean = false): void => {
  if (ast.kind === "ddl") validateUserDDL(ast, strict);
};


