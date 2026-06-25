# A first-party value-kind seam (src/ir/value_facts.ts)

A local SQL fix often has to reconstruct global context. The motivating case:
string index/slice. To lower `'qwerty'[2]` correctly, `compileValueSetSQL` had
to answer "is this base a string?" — and a bare string literal carries
`unknown:std::anyscalar` (not `std::str`), while index/slice chains lose the str
type on their result typeref. So the leaf grew an inline `isStringValuedSet`
helper that peeled `select_expr` wrappers, consulted `qualifyTypeName`, and
recursed through `index_expr`/`slice_expr`. That re-derivation lived next to the
leaf, was duplicated at the slice site, and — crucially — the *scalar-select*
index path (`compileScalarSelectSQL`, a different function) had no access to it
at all, so `'qwerty'[<int16>2]` (a typed-int index, `numericIndex === undefined`)
fell through to the JSON-array idiom (`json_extract` over text → wrong result).

This is the accidental complexity the read-only pass named: scalar/type facts
live partly in parser hints, partly in `ast_to_ir`, partly in SQL lowering, and
a feature has to rebuild them with partial context at each leaf.

**Decision (done): introduce one explicit semantic seam for value kind.**
`src/ir/value_facts.ts` answers "what kind of value does this set produce?"
(`valueFactsOf(set) → {category: scalar|collection|object|unknown, typeName,
collection?}`), folding the wrapper-peeling and the literal / index-slice /
collection special cases into one pure place. It is pure (no IR mutation, no
schema access — reads only the `Set`/`TypeRef` the builder already produced) and
lives in `src/ir/` (the lowest layer) so the SQL compiler imports it without a
cycle. This is **not** the kind of split ADRs 0040/0041 rejected: those failed
because `ast_to_ir`'s expression/shape/pointer resolution is one
mutually-recursive builder. This is a post-builder annotation consulted by a
*different* layer — the same shape as `inference.ts` (which already decorates the
statement with volatility/cardinality/multiplicity/type).

**What changed in the SQL compiler:**

- `qualifyTypeName(typeRef)` now delegates to `value_facts.ts`'s
  `qualifiedTypeRefName` — one implementation of IR-TypeRef name-qualification
  (distinct from `schema/schema.ts`'s `qualifiedTypeName`, which qualifies a
  schema TypeDef, not an IR TypeRef).
- The inline `isStringValuedSet` is deleted; the two index/slice sites consult
  `isStrValued` / `isBytesValued`. Behaviour-identical at the slice site
  (a parity test, below, locks `isStrValued` to the retired helper's logic).
- **Fix, fact-driven:** a string/bytes base is now indexed char/byte-wise via
  `substr` whether the index is a literal *or* a dynamic scalar
  (`'qwerty'[<int16>2]`, `s[$i]`). The decision keys off the *value kind*
  ("the base is a string") rather than "the index happens to be a literal".
  This required the SAME fact at TWO independent sites — `compileValueSetSQL`'s
  index branch and `compileScalarSelectSQL`'s index branch — which is exactly
  the point: with the seam, the scalar-select site just adds
  `&& !isStrValued(base) && !isBytesValued(base)` to skip the JSON path and
  fall through to the (now-fixed) value path, instead of re-implementing the
  peel. Fixes `test_edgeql_expr_string_01`.

**Surface / tests.** `valueFactsOf(gelIr.expr)` is exposed as `facts.valueFacts`
on the compile-inspection seam (`src/compiler/inspect.ts`) — so it crosses the
same boundary the golden tests do and is visible from `bin/inspect.ts facts`.
`tests/value_facts.test.ts` (26 first-party tests) pins the facts per the
failure group it was extracted for (the string/bytes index-slice cluster) plus
category coverage and a regression guard that asserts `isStrValued` still agrees
with a faithful re-creation of the deleted `isStringValuedSet`.

**A note on `isScalar`.** The obvious classifier — "scalar iff `typeref.isScalar`"
— does not work: this IR leaves `isScalar:false` on BOTH object typerefs
(`default::Issue`) AND scalar results of casts/operators (`<int64>1`). So
`valueFactsOf` classifies positively instead: literals by their constant kind;
collections by `typeref.collection` (and the `tuple` expr kind, whose typeref
omits it); objects by schema-structural fields (`inSchema` / concrete-subtype
`children` / `union` / `intersection`); and any other named, non-collection,
non-object typeref as a scalar (the common cast/operator/pointer result).
**Known limit:** a *user-defined* scalar in a user module with `inSchema` set
could be misread as an object — out of scope here (str/bytes, the SQL-relevant
kinds, are pinned by name and unaffected), to be revisited if a fix needs it.

**Verification.** `tsc --noEmit` clean; the three changed source files lint
clean. Full suite: 0 regressions by name-level diff against a fresh baseline
(785 → 783 failing; the one real fix is `test_edgeql_expr_string_01`, the other
delta is the known-flaky `functions_inline_*_link_02`). The deterministic
goldens (`inspect_corpus`) are unaffected — the only literal-index SQL is
byte-identical; just the typed/dynamic-index and scalar-select paths changed.

**Why record it.** This is the first increment of the "preserve value/source
facts before SQL lowering, then consume them" direction. It deliberately took
the lowest-risk fact dimension (value kind) to validate the *pattern* — does an
annotation seam reduce per-fix cost without regressions? — before betting on the
harder, higher-impact dimensions the same direction calls for: **source identity
/ correlation** (would let SQL drop the `outerScopes` / `sourcePathAliases` /
`multiScalarBindings` heuristics in `compiler_types.ts`, which exist precisely
because "the IR doesn't capture this binding") and **param ownership** (SQL
fragments carrying their own `{sql, params}` instead of mutating a shared array —
the `paramInlined` hack in the slice lowering is the symptom). Those are the
next seams; this one proves the shape.
