# SPEC-034: Select Query Semantics Reference (sqlite-ts)

Status: In Progress (Milestone Slice Implemented)
Owners: sqlite-ts Compiler and Runtime
Last Updated: 2026-04-02

## Purpose

Capture the full `select` behavior contract from the EdgeQL `select.rst` documentation as a sqlite-ts reference spec, so implementation can proceed feature-by-feature without losing semantic parity targets.

## Scope

- `select` statement pipeline semantics for sqlite-ts (parse, semantic validation, IR, SQL, execution shape).
- Object selection, shapes, nested links, computed fields, backlinks, and polymorphic query behavior.
- Ordering and pagination semantics (`order by`, `offset`, `limit`) including singleton constraints.
- Clear "supported now" vs "target behavior" notes for sqlite-ts.

## Non-Goals

- Full parity with every advanced EdgeQL feature in a single milestone.
- Defining storage internals for every link/backlink encoding strategy (covered by storage specs).
- REPL formatting concerns (type labels shown in interactive output are not data contract).

## Requirements

- R1: sqlite-ts MUST define `select` as `select <expr>` with optional `filter`, `order by`, `offset`, and `limit` clauses, and preserve clause order semantics.
- R2: `filter` expressions MUST evaluate per input element and keep the element when at least one filter result is `true`.
- R3: `order by` expressions MUST be singleton-or-empty order keys; multi results in ordering expressions MUST be rejected as compile-time errors.
- R4: `offset` and `limit` expressions MUST be singleton integer expressions and MUST be evaluated once per statement.
- R5: Omitting `limit`/`offset` or passing an empty optional value MUST behave as "no limit"/"no offset" respectively.
- R6: Object shapes MUST support explicit field selection and nested shapes for links.
- R7: Nested shape scope MUST rebind dot-path references (`.field`) to the currently scoped object type.
- R8: Link traversals in shapes MUST allow nested `filter`, `order by`, and `limit` at link scope.
- R9: Computed fields (`name := <expr>`) MUST be allowed in shapes and evaluated in current scope.
- R10: Backlink expressions using `.<link_name` and optional type intersection (`[is Type]`) MUST be representable in query expressions and shape computeds.
- R11: Schema-defined computed links and query-local computed links MUST be shape-traversable equivalently to concrete links.
- R12: Polymorphic sets MUST be representable when selecting abstract supertypes or union-typed links.
- R13: Polymorphic field projections using `[is <Subtype>].field` MUST return empty set on subtype mismatch.
- R14: Polymorphic link filtering (`link[is <Subtype>]`) MUST narrow result elements to the target subtype.
- R15: Type introspection via `.__type__` MUST expose object type metadata (including type name) as link data rather than REPL-only annotation.
- R16: Subqueries inside shapes and computed expressions MUST be supported as composable expressions.
- R17: Validation errors MUST be deterministic and include stable diagnostics for unsupported or invalid `select` forms.
- R18: sqlite-ts MUST document every deliberate deviation from upstream `select.rst` behavior in this spec before marking related requirements as implemented.
- R19: Object identity field `id` MUST be treated as server-generated data and selectable/filterable, but not client-assignable in DML.

## Behavior and Flows

- Parse phase recognizes `select` clause chain and shape grammar, producing AST with explicit scopes.
- Semantic phase resolves type names, link targets, computeds, and polymorphic intersections; enforces cardinality and singleton restrictions for sorting/pagination.
- IR phase preserves nested shape graph, computed expression nodes, and polymorphic/backlink operations.
- SQL lowering maps each shape level to deterministic SQLite queries/subqueries/joins while preserving per-scope filtering and ordering.
- Execution phase assembles nested result objects, including computed fields and polymorphic optional empties.
- Error flow fails fast on unsupported grammar/features until each requirement is implemented.

## sqlite-ts Current Status (2026-04-02)

- Implemented baseline: flat `select Type { field, ... }` with top-level `filter`, single-key `order by`, `limit`, and `offset`.
- Implemented baseline: `select Type` default-id projection when no explicit shape is provided.
- Implemented in this milestone: shape-level computed fields (`name := .field` and `name := <literal>`) and shape-level backlinks (`name := .<link` with optional `[is Type]`) with deterministic AST -> IR -> runtime shaping.
- Implemented in this milestone: server-generated object IDs with global uniqueness enforcement across object tables via registry and triggers.
- Implemented in this milestone: nested link shapes with scoped `filter`/`order by`/`offset`/`limit` clauses and scoped dot-path rebinding.
- Implemented in this milestone: query-local polymorphic field projections (`[is Type].field`) and `.__type__` computed metadata materialization.
- Implemented in this milestone: shape splats (`*`, `**`, `Type.*`, `Type.**`, `[is Type].*`, `[is Type].**`) expanded through semantic lowering and runtime shaping.
- Implemented in this milestone: top-level `with` scalar bindings for select statements and binding references inside filter values.
- Implemented in this milestone: additional filter operators (`!=`, `like`, `ilike`) with semantic typing checks and SQL/runtime lowering for both root and nested link scopes.
- Implemented in this milestone: known-backlink filter predicates (`.<link[is Type] = '<id>'` / `!=`) lowered via correlated existence checks.
- Implemented in this milestone: free-object projections (`select { ... }`) returning singleton object rows with literal, set-literal, and nested object-select entries.
- Implemented in this milestone: polymorphic-set expansion on abstract link targets by unioning concrete subtype tables during nested link materialization.
- Implemented in this milestone: polymorphic link subtype filtering (`link[is Type]`) by narrowing link target tables and compiling nested shape fields against the filtered subtype scope.
- Implemented in this milestone: boolean filter composition (`and`, `or`, `not`, grouped subexpressions) across select filters, including operator-aware SQL lowering.
- Implemented in this milestone: nested-link scoped filter expression trees with independent scope rebinding from the parent select scope.
- Implemented in this milestone: computed subquery expressions in shapes using parenthesized inline `select` expressions.
- Deliberate deviations still open: full polymorphic set unions across abstract supertypes and subtype hierarchy narrowing require richer schema inheritance metadata than the current sqlite-ts model.
- Deliberate performance deviation: nested links/backlinks currently execute via runtime follow-up SQL; single-statement aggregation lowering is tracked in `sqlite-ts/spec/SPEC-035-single-statement-shape-lowering.md`.
- Consequence: sqlite-ts now covers practical nested shaping + polymorphic field slices while broader upstream polymorphic-set parity remains tracked.

## Backlink and Computed Field Representation (sqlite-ts)

### Compiler Structure (AST -> IR)

```text
EdgeQL shape entry
  |
  +-- field
  |     `- name: "title"
  |
  +-- computed
  |     `- name: "nick", expr: field_ref("name") | literal("...")
  |
  `-- backlink
        `- name: "comments", expr: backlink(link="author", sourceType?="default::Comment")

Semantic IR select node
  - columns: base columns required for projection + computed refs + hidden `id` for backlinks
  - shape:
      * field(name, column)
      * computed(name, expr)
      * backlink(name, sources[])
  - backlink sources[] resolves to physical storage metadata:
      * inline: table + `<link>_id` column
      * table: source table + link table (`source`,`target`)
```

### Runtime Materialization Flow

```text
SELECT base columns from target table
  -> for each row:
       - field: copy scalar column
       - computed: evaluate from row (field_ref or literal)
       - backlink: query each resolved source storage by current row.id
           inline:  SELECT id FROM source WHERE <link>_id = row.id
           table:   SELECT s.id FROM source s JOIN source__link l ON l.source=s.id WHERE l.target=row.id
       - normalize backlink output as [{id, __type__}, ...]
```

### Storage Diagram (Backlink Resolution)

```text
default::User (target queried type)
  table: default__user(id, name, ...)
           ^
           | match by id

default::Comment.author (single link, inline)
  table: default__comment(id, body, author_id)
  backlink `. <author` => WHERE default__comment.author_id = default__user.id

default::Post.comments (multi link, table-backed)
  table: default__post__comments(source, target)
  source table: default__post(id, ...)
  backlink `. <comments` => JOIN default__post__comments.target = default__user.id
```

## Metadata Notes (Gel upstream)

- Gel does maintain schema metadata relevant to computeds/backlinks (for example pointer-level `computable` flags and expression metadata) in schema/catalog layers.
- sqlite-ts currently resolves backlinks from in-memory `TypeDef.links` metadata and does not persist a dedicated metadata catalog yet.
- A dedicated metadata-storage spec is tracked in `sqlite-ts/spec/SPEC-015-schema-pointer-metadata.md`.

## Traceability

- Source docs:
  - `docs/reference/edgeql/select.rst`
  - `docs/reference/reference/edgeql/select.rst`
- sqlite-ts baseline code:
  - `sqlite-ts/src/edgeql/parser.ts`
  - `sqlite-ts/src/compiler/semantic.ts`
  - `sqlite-ts/src/sql/compiler.ts`
  - `sqlite-ts/src/runtime/engine.ts`
  - `sqlite-ts/spec/traceability.ts`
- Tests to add (planned):
  - `sqlite-ts/tests/select-shapes.test.ts`
  - `sqlite-ts/tests/select-computed-fields.test.ts`
  - `sqlite-ts/tests/select-backlinks.test.ts`
  - `sqlite-ts/tests/select-polymorphic.test.ts`

## Source Anchors (Documentation)

- Clause syntax and semantics: `docs/reference/reference/edgeql/select.rst:13`, `docs/reference/reference/edgeql/select.rst:25`, `docs/reference/reference/edgeql/select.rst:36`, `docs/reference/reference/edgeql/select.rst:70`, `docs/reference/reference/edgeql/select.rst:82`
- Shapes and nested scope: `docs/reference/edgeql/select.rst:164`, `docs/reference/edgeql/select.rst:186`, `docs/reference/edgeql/select.rst:547`, `docs/reference/edgeql/select.rst:577`
- Link-level filter/order/limit: `docs/reference/edgeql/select.rst:626`, `docs/reference/edgeql/select.rst:639`
- Computed fields and subqueries: `docs/reference/edgeql/select.rst:778`, `docs/reference/edgeql/select.rst:783`, `docs/reference/edgeql/select.rst:901`
- Backlinks: `docs/reference/edgeql/select.rst:833`, `docs/reference/edgeql/select.rst:845`, `docs/reference/edgeql/select.rst:858`
- Polymorphism: `docs/reference/edgeql/select.rst:928`, `docs/reference/edgeql/select.rst:979`, `docs/reference/edgeql/select.rst:985`, `docs/reference/edgeql/select.rst:1050`, `docs/reference/edgeql/select.rst:1076`, `docs/reference/edgeql/select.rst:1108`

## Open Questions

- Q1: Should sqlite-ts represent empty-set results from polymorphic mismatches as omitted JSON fields, explicit `null`, or typed empty collections at the API boundary?
- Q2: What SQL lowering strategy should be preferred first for backlinks in SQLite: correlated subqueries, explicit junction scans, or generated helper views?

## Change Log

- 2026-04-02: Initial sqlite-ts reference spec for full `select.rst` semantics, including computed fields, backlinks, and polymorphism targets.
- 2026-04-02: Marked first implementation slice for shape-level computed fields and backlinks; added AST/IR/runtime/storage diagrams and metadata notes.
- 2026-04-02: Added nested link-shape clause support, polymorphic field projection syntax, and type metadata computeds in runtime shaping.
