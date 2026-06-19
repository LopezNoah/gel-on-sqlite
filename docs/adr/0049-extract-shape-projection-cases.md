# Extract two shape-projection cases from compileShapeProjection

The round-9 review's candidate #2 found `compileShapeProjection`
(`src/sql/gel_ir_compiler.ts`, ~800 lines) to be a **shallow interface over deep
logic**: a top-level dispatcher with 12+ *positional* `if`-guards over distinct
EdgeQL shape patterns (synthetic `__type__`, embedded group, link arrays,
object-set coalesce, shapes-on-paths, foreign-type computeds, leaf-over-call,
leaf-through-link, projected columns, optional-operator subqueries). Six
parameters hide ~12 patterns, the guards read as a checklist rather than named
cases, and the whole thing is exercised only end-to-end — a regression surfaces
as a golden diff, not a named failure.

Two of those cases are **cleanly separable**: they depend only on the local
`shapeExpr` (`unwrapSelectExprSet(shape.expr)`) plus the function's parameters,
*not* on the shared mid-function locals (`elementIsManyViaChain` /
`elementRootsAtForeignType`) that entangle the later cases.

**Decision (done):** Lift two cases into named module-level helpers, bodies
byte-identical to the inline blocks:

- `compileShapeLinkArray` — a non-scalar pointer projected as a JSON array of
  shaped rows (`watchers: { name }`), with the single-cardinality unwrap to the
  first element. Always returns a projection.
- `compileShapeLeafThroughForeignLink` — a scalar leaf read through an
  intermediate *single* object link **not** joined into the outer row
  (`owner_name := .owner.name`), lowered as a correlated `LIMIT 1` subquery over
  the link's target rows. Returns `null` to fall through to the
  projected-column / multi-scalar lowering when the narrow pattern doesn't
  match — preserving the exact control flow of the inline detection IIFE.

The dispatcher now calls both by name. One **type-only** `as Pointer` cast was
added in `compileShapeLinkArray` to restore the flow-narrowing the enclosing
`if (… .kind === "pointer")` provided inline (the caller still guards it); it
changes no emitted SQL.

**Decision (scoped out, deliberately):** the entangled cases — object-set
coalesce (`compileSideArray`) and the optional-operator subqueries (#10/#11/#12)
— are **not** extracted. They share a "build a correlated shape subquery"
shape but diverge at the path extractor, the clause handling, and the result
wrapper, and they read the shared mid-function locals. Naming that subquery
pattern is the prerequisite for carving them, and is left as the follow-up
(the same reasoning ADR 0035 used to leave the three pointer-path lowerings
separate rather than force one leaf-callback harness).

**Verification.** `tsc --noEmit` clean; `eslint` on the file unchanged (0
errors, 0 warnings, before and after). Behaviour-neutral: the deterministic
canonical-SQL goldens (`tests/inspect.test.ts`, `tests/inspect_corpus.test.ts`)
pass, and the four shape-heavy suites (`edgeql_select` / `edgeql_advtypes` /
`edgeql_linkprops` / `edgeql_linkatoms`) produced an **identical set of 181
failing test names** before and after — captured by stashing the file back to
HEAD and diffing (empty diff). `tests/shape_projection.test.ts` (3 tests) pins
both cases' canonical SQL through the inspect seam (ADR 0002): the multi-link
`json_group_array`, the single-link `json_extract(…,'$[0]')` unwrap, and the
leaf-through-foreign-link correlated `LIMIT 1` subquery (asserting it is *not*
the wrong bare-column read).

**Consequences.** The link-array and leaf-through-foreign-link cases have named
homes and a named test surface; `compileShapeProjection`'s dispatch reads as two
named cases plus the still-positional remainder. A change to either case's
lowering now fails `shape_projection.test.ts` by name.

**Why record it.** A future reader will find `compileShapeProjection` still
large with only two cases extracted and may think the deepening was abandoned
half-done. It was scoped: only the two cases independent of the shared
mid-function locals were cleanly separable. The rest read
`elementIsManyViaChain` / `elementRootsAtForeignType` or the coalesce /
optional-operator subquery shape, and need that pattern named first — a separate,
behaviour-gated change, not folded in silently.
