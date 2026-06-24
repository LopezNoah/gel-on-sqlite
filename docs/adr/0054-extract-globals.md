# Extract session globals & query parameters into runtime/globals.ts

The round-10 review's candidate #4 (carded "lowest risk"): engine.ts held the
per-connection session-globals lifecycle — the `globalValuesBySchema` WeakMap
plus `globalValuesFor` / `evaluateGlobalExpr` / `applyCreateGlobalDDL` /
`applySessionGlobal` / `withSessionGlobals` — and the query-variable
normalizer (`normalizeQueryVariables`). A cohesive, orthogonal concern with its
own state, woven through the 11.3k-line engine.

**Finding (unlike candidates #1/#2, the cleanness held):** the cluster's only
back-edges into the engine are the SQL-precompute probe `tryRunSingleSqlRows`
(ADR 0012), `normalizeSecurityContext`, and the `DEFAULT_SECURITY_CONTEXT`
value. The WeakMap and `globalValuesFor`/`evaluateGlobalExpr` have no external
callers; the rest have a handful. No mutual recursion.

**Decision (done):** lift the cluster into `src/runtime/globals.ts`, which now
owns the `globalValuesBySchema` WeakMap. The three back-edges are injected as a
`GlobalsDeps` record (the engine-submodule idiom — evaluator.ts/ADR 0044,
default_resolution.ts/ADR 0039), so the module imports no engine runtime; the
shared types (`SecurityContext`, `QueryVariables`) come in type-only from
`engine.ts` (the established convention) and `isScalarValue` is a local copy of
the same pure two-line guard `default_resolution.ts` already keeps. Each moved
function destructures `deps` at the top, so the bodies are byte-identical; the
only edits thread `deps` through the two intra-cluster `evaluateGlobalExpr`
calls. The engine supplies the deps via a hoisted lazy `globalsDeps()` factory
(`normalizeSecurityContext` is a const arrow declared far below, so a top-level
const object would hit its TDZ — same fix as `selectExprEvaluatorDeps`). Three
call sites pass `globalsDeps()`; `withSessionGlobals` / `normalizeQueryVariables`
need no deps. `tryRunSingleSqlRows` stays in engine.ts (a shared seam used
elsewhere) and `applySessionConfigure` / `allowUserSpecifiedId` stay too (a
distinct session-config concern, not globals).

**Verification.** Behaviour-neutral: `tsc --noEmit` clean, `eslint` clean
(0 errors; the lone `no-non-null-assertion` warning moved verbatim with the
code). The canonical-SQL goldens (`tests/inspect.test.ts`,
`tests/inspect_corpus.test.ts`) pass. Against a stashed committed-`a1a54a8`
baseline, each globals-touching suite is identical run-for-run:
`edgeql_insert` 39f/284p (CONFIGURE + params), `edgeql_expressions` 151f/222p
(params), `edgeql_expr_aliases` 19f/60p (CREATE GLOBAL/ALIAS), and
`access_policy` passes (globals/permissions). New unit surface:
`tests/globals.test.ts` (5 tests) drives the set→merge→reset lifecycle and the
query-variable normalization through stub deps — no DB, no compiler.

**Consequences.** The session-global lifecycle and its WeakMap state have one
home and a focused test surface; engine.ts sheds an orthogonal concern. Modest
leverage (~150 lines) as the review predicted — a tidy win, not a structural
shift.

**Why record it.** This is the one round-10 candidate whose carded cleanness
matched reality (3 narrow injected deps, no mutual recursion) — the contrast
with ADRs 0051/0052 is the point: verifying the dep-closure first is what tells
the clean lifts from the entangled ones.
