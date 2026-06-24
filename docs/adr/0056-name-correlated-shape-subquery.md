# Name the correlated-shape-subquery result wrapper

The round-10 review's candidate #5 ("name the shared lowering frame — unblock
the stalled ADR 0042/0049 decompositions") — the deepest, behaviour-gated one.
Both `compileScalarSelectSQLInner` (~1,960 lines) and `compileShapeProjection`
(~800 lines) stalled their per-branch decomposition at a shared obstacle:
branches read mid-function state with no name. ADR 0049 was specific about the
shape side — the entangled cases "share a 'build a correlated shape subquery'
shape … Naming that subquery pattern is the prerequisite for carving them."

**Finding:** that subquery pattern is concrete and repeated. Five sites across
`compileShapeProjection` and `compileShapeLeafThroughForeignLink` emit the
identical result wrapper — a multi-cardinality element as
`COALESCE((SELECT json_group_array(<value>) FROM <source>), '[]') AS <alias>`,
a single element as `(SELECT <value> FROM <source> LIMIT 1) AS <alias>` —
varying only in the value expression (`"value"`, a leaf column expr,
`json("item")`), the FROM source, and the alias.

**Decision (done):** extract `wrapCorrelatedShapeSubquery(valueExpr, sourceSql,
isMany, alias)` — a pure string builder (`quoteIdent` only) — and route all five
sites through it. This names exactly the pattern ADR 0049 deferred, giving the
correlated-shape-subquery result shape one home: a change to how shaped
subqueries wrap (e.g. the empty-array sentinel, the single-element peel) now
happens in one place instead of five. Byte-identical: each site passed the same
value/source/alias it built inline, and `sourceSql` is the exact post-`FROM`
text (some sites parenthesize a bare SELECT, others pass an already-aliased
source — the helper does not re-parenthesize).

**Scoped out, deliberately — the rest of candidate 5:** this names the *result
wrapper* the entangled shape cases share; it does **not** yet lift those cases
(the object-set coalesce `compileSideArray`, the optional-operator subqueries)
into named helpers, nor does it touch `compileScalarSelectSQLInner`'s state frame
(ADR 0042's `sources` / `valueSql` / `appliedOuterWheres` cluster feeding ~360
lines of pointer/tuple/array branches). Those remain the larger behaviour-gated
continuation. They were deferred for the same reason ADRs 0042/0049 deferred
them: promoting a giant function's shared SQL state into an explicit frame and
lifting intricate per-branch logic, byte-identical, is a high-risk refactor whose
correctness is hard to fully verify — best done incrementally, one named seam at
a time. This is the next such seam, not the whole job.

**Verification.** Behaviour-neutral: `tsc --noEmit` clean, `eslint` clean
(0 errors). The deterministic goldens (`tests/inspect.test.ts`,
`tests/inspect_corpus.test.ts`) and `tests/shape_projection.test.ts` (ADR 0049,
which already pins the wrapped `json_group_array` / `LIMIT 1` output) pass — no
emitted SQL changed. The shape-heavy suites are identical to a stashed
committed-`15f7c08` baseline: `edgeql_linkprops` 41f/14p, `edgeql_advtypes`
34f/26p, `edgeql_select` 85f/338p/3s. The wrapper's output is pinned by those
goldens; being an internal helper, it is not separately exported for a unit test.

**Consequences.** The correlated-shape-subquery result shape has one named home
— the prerequisite ADR 0049 called for. Carving the entangled shape cases, and
the scalar-dispatch frame, can now build on it.

**Why record it.** Candidate 5 was carded as the big speculative unblock for two
giant functions. What landed is the safe, on-target slice: the one shared
pattern ADR 0049 explicitly named as the prerequisite, extracted byte-identically.
A future reviewer should know the prerequisite seam now exists, and that the
per-branch lifts + the scalar frame are the remaining (still-deferred) work — not
assume candidate 5's decomposition is finished.
