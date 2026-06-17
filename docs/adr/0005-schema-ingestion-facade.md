# A single SDL-ingestion facade; document the schema-representation graph

The architecture review's candidate #3 found that schema lives in six representations (SDL text → DeclarativeSchema → SchemaSnapshot → GeneratedSchema → generated `schema_model.ts` → SQL DDL, plus the reverse snapshot→declarative path) with no documented map, so understanding "how does SDL become a snapshot?" meant tracing imports across `sdl_adapter.ts`, `schema_tokenizer.ts`, `declarative.ts`, and `uiSchema.ts`. The `SchemaSnapshot` itself is a clean deep module; the friction was **navigability**, not depth. Compounding it, the two-step ingestion chain `parseDeclarativeSchema(...) → schemaSnapshotFromDeclarative(...)` was hand-rolled across 20+ call sites (the engine, the HTTP entry, every inference test, the test harness, the dev runners).

**Decision (done):**

1. **Document the conversion graph** in `CONTEXT.md` ("Schema representations") — which form produces which, in one diagram, so the web is no longer tribal knowledge. It also records that schema parsing (`schema_tokenizer.ts`/`sdl_adapter.ts`) is a deliberately separate front end from query parsing (`edgeql/tokenizer.ts`/`parser.ts`): SDL declaration syntax and the EdgeQL expression language are different grammars and intentionally do not share a tokenizer.
2. **Add `loadSchema(source, options)`** in `src/schema/load.ts` — the one canonical SDL → SchemaSnapshot entry, hiding the parse-then-snapshot chain. The compile-inspection seam's `schemaFromSdl` and the test harness (`tests/utils.ts`, the suite-wide schema loader) now delegate to it — two adapters, so it's a real seam, not indirection.

**Decision (scoped out):** the *other* representations (the reverse `declarativeSchemaFromTypeDefs`, the codegen `GeneratedSchema`/`schema_model.ts`, the SQL-DDL renderer) are **not** collapsed — they are distinct, legitimately-separate concerns (round-trip editing, code generation, migration rendering), and `SchemaSnapshot` already gives each a clean interface. Only the ingestion chain was duplicated enough to warrant a facade. The remaining 18 hand-rolled chains (engine, inference tests, runners) can migrate to `loadSchema` opportunistically; they are behaviour-identical today.

**Consequences.** New callers learn one ingestion interface; the conversion web is documented rather than reverse-engineered. `SchemaSnapshot` stays the authoritative deep core, with the conversions as named spokes around it.

**Why record it:** a future reader will see several schema representations and may suspect accidental duplication. It is deliberate — each spoke is a distinct concern; only ingestion got a facade, and the graph in CONTEXT.md is the map.
