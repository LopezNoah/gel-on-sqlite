// Synthetic PathId name construction — the machinery behind the `expr~N` and
// `@view~N` names Gel mints during compilation. Two Gel sources are ported here:
//
//   * name mangling / specialized names  — edb/schema/name.py
//   * the `<hint>~<serial>` alias counter — edb/common/compiler.py AliasGenerator
//
// These produce the *strings* that appear in golden path_ids, e.g.
//   (__derived__::expr~3)                                  — a derived expr set
//   __derived__::default|User@view~1                       — a derived view type
//   __derived__::__|todo_ids@__derived__|default||User&view~1  — a computed ptr
//
// Per the project mandate, no regex: the trailing-serial strip and digit check
// below are done with plain string ops.

export const DERIVED_MODULE = "__derived__";

/**
 * Port of `edb/schema/name.py:mangle_name`. Order matters: the escapes for the
 * existing `|`/`&` separators run *before* the `::`/`@` substitutions so a real
 * `|` becomes `||` and is not later confused with a mangled `::`.
 */
export const mangleName = (name: string): string =>
  name
    .replaceAll("|", "||")
    .replaceAll("&", "&&")
    .replaceAll("::", "|")
    .replaceAll("@", "&");

/**
 * Port of `edb/schema/name.py:get_specialized_name`:
 *   `mangle(basename)@<'@'.join(mangle(q) for q in quals if q)>`
 */
export const getSpecializedName = (
  basename: string,
  ...qualifiers: string[]
): string => {
  const quals = qualifiers.filter((qual) => qual.length > 0).map(mangleName);
  return `${mangleName(basename)}@${quals.join("@")}`;
};

const inDerivedModule = (name: string): string => `${DERIVED_MODULE}::${name}`;

/**
 * The fully-qualified name of a pointer as it appears in a debug-rendered
 * PathId, e.g. `default::__|name@default|User`. The base name is the pointer's
 * short name in the pseudo-module `__` (mangled to `__|name`), specialized on
 * the source type's fully-qualified name.
 */
export const pointerFullName = (
  module: string,
  pointerShortName: string,
  sourceTypeName: string,
): string =>
  `${module}::${getSpecializedName(`__::${pointerShortName}`, sourceTypeName)}`;

/**
 * A computed/derived pointer's fully-qualified name — `pointerFullName` rooted
 * in the `__derived__` module, e.g.
 * `__derived__::__|todo_ids@__derived__|default||User&view~1`.
 */
export const derivedPointerName = (
  pointerShortName: string,
  sourceTypeName: string,
): string => pointerFullName(DERIVED_MODULE, pointerShortName, sourceTypeName);

/**
 * The root name for a synthetic expression set, e.g. `__derived__::expr~3`.
 * Mirrors `PathId.new_dummy` / the `__derived__::<alias>` typing of anonymous
 * sets in `edb/edgeql/compiler`.
 */
export const derivedExprName = (alias: string): string => inDerivedModule(alias);

/**
 * The name of a derived *view* type, e.g. `__derived__::default|User@view~1` —
 * a base type specialized by a `view~N` alias (see `edb/edgeql/compiler/
 * viewgen.py` `derive_view`).
 */
export const deriveViewTypeName = (
  baseTypeName: string,
  viewAlias: string,
): string => inDerivedModule(getSpecializedName(baseTypeName, viewAlias));

const isAllDigits = (text: string): boolean =>
  text.length > 0 && [...text].every((char) => char >= "0" && char <= "9");

/** Strip a trailing `~<digits>` serial (regex-free `re.search(r'~\d+$')`). */
const stripTrailingSerial = (hint: string): string => {
  const lastTilde = hint.lastIndexOf("~");
  if (lastTilde === -1) return hint;
  return isAllDigits(hint.slice(lastTilde + 1)) ? hint.slice(0, lastTilde) : hint;
};

/**
 * Port of `edb/common/compiler.py:AliasGenerator`. Each base hint owns an
 * independent monotonic counter; `get('expr')` yields `expr~1`, `expr~2`, …
 * while `get('view')` counts separately. An empty hint defaults to `v`, and a
 * hint already carrying a serial is re-based to its stem first.
 */
export class AliasGenerator {
  private readonly counts = new Map<string, number>();

  private nextval(name: string): number {
    const next = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, next);
    return next;
  }

  get(hint = ""): string {
    const base = stripTrailingSerial(hint.length > 0 ? hint : "v");
    return `${base}~${this.nextval(base)}`;
  }
}
