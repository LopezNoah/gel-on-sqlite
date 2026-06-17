# Dispatch the cleanly-separable branches of compileScalarSelectSQLInner

`compileScalarSelectSQLInner` (`gel_ir_compiler.ts`) was a ~2,225-line function: a cascade of 15+ guards on `sourceSet.expr.kind`, each lowering one scalar-source shape to SQL, with ~113 return statements. A round-6 review proposed dispatching it into per-source-kind sub-functions for navigability and a per-branch (golden) test surface. This is the **Speculative** candidate — the SQL goldens require byte-identical output — so it is done **incrementally**, extracting only the branches that are provably safe.

**Decision (done):** extract the four largest **cleanly self-contained** guard branches into sibling functions, each `(sourceSet, params, target, options, outerWheres) → string | null`:

- `compileForExprScalarSource` (~229 lines) — `FOR g IN (GROUP …) UNION <body>` and the general iterator × body cross-join;
- `compileTypeCastScalarSource` (~47 lines) — `<T>{}`, `<json>X`, casts from `std::json`, plain casts;
- `compileSelectExprScalarSource` (~41 lines) — `select_expr` ORDER BY / LIMIT / OFFSET wrapping;
- `compileIfElseScalarSource` (~25 lines) — set-valued `IF/ELSE`.

The call sites keep each guard but delegate. Two **distinct return semantics** are preserved exactly:

- branches that *fall through* on failure (`type_cast`, `for_expr`, `if_else_expr` — they continue to later guards) → `if (kind === X) { const r = helper(...); if (r !== null) return r; }`, with the helper returning `null` where the inline code fell through;
- the branch that *always returns* when entered (`select_expr` — its `if (!inner) return null` exits the whole function) → `if (kind === X) return helper(...);`.

The function shrinks ~2,225 → ~1,892 lines; the four shapes now have names and are independently readable.

**Scoped out, deliberately — the boundary:** only the guards **before the first shared mid-function local** are extractable. From the generic pointer/value fallback onward (the `isObjectSourceSet` / `multiScalarSql` / `sources` / `valueSql` / `appliedOuterWheres` … cluster, ~1,200 lines) the branches read locals computed earlier in the function body, so they cannot be lifted without first refactoring that shared state into an explicit object — a separate, larger, behaviour-gated effort. The big `pointer` (×4), `tuple`, and `array` branches live in that region and are **not** extracted here.

**Verification.** Byte-identical SQL, proven directly: `bin/inspect.ts sql` output for representative `for_expr`, `type_cast`, `select_expr` (ORDER BY/LIMIT/OFFSET), and `if_else` queries was diff-empty against the pre-change baseline. The goldens + conformance slice (`inspect`/`sql_query`/`for`/`group`/`select`/`casts`/`expressions`/`coalesce`, 1300 tests) showed a single delta — `test_edgeql_select_cross_04`, whose SQL was separately confirmed byte-identical, so the delta is that test's documented order-flakiness, not a regression. `tsc` clean, lint clean (the moved bodies kept verbatim).

**Consequences.** Four scalar-source shapes have named homes and golden-test surfaces; `compileScalarSelectSQLInner` is ~15% smaller and its remaining guards read more like a dispatch. The decomposition can continue when the shared-local fallback is refactored.

**Why record it:** a future reviewer will see the function still ~1,900 lines and four branches extracted, and may think the dispatch was abandoned. It was scoped to the branches that read only the function's parameters; the rest share mid-function locals (the boundary is the generic pointer/value fallback) and need that state made explicit first. Note the two call-site patterns are not interchangeable — `select_expr` always returns when entered, the others fall through; copying the wrong pattern would change which later guard runs.
