# One home for physical storage layout (and a drift bug closed)

The round-3 architecture review found that "given the logical schema, what is the physical SQLite layout?" had no home. The SQL compiler already exposes the seam — `compileGelIRToSQL` takes the layout it needs as injected callbacks (`resolveTypeColumns`, `resolveLinkStorageType` on its options) — but the **adapters** were hand-mirrored across two modules, and they had already drifted:

- **The link-storage owner walk** ("which type's table physically owns an inherited link's junction table") lived in `runtime/engine.ts` as `resolveLinkStorageOwner` (returning a `TypeDef`, used at 5 sites) and was re-implemented in `compiler/service.ts` as `makeLinkStorageTypeResolver` (returning a qualified name, fed to the SQL compiler). The two were **not equivalent**: the runtime guarded the walk with `linkDefsEquivalent(link, baseLink)`, so a subtype that re-declares a link incompatibly *without* `overloaded` keeps its own storage; the `service.ts` mirror omitted that guard and walked to the base. A schema with such a re-declaration would have the compile-side JOIN target a different table than the runtime writes to.
- **The type column set** (which physical columns a type's table has, with inline-`<link>_id`-FK exclusion when a subtype overloads a link into junction storage) lived only in `service.ts` as `makeTypeColumnsResolver`.
- **The link-storage boolean** `!multi && properties.length === 0` (= `!usesLinkTable`) was still inlined at two live sites ADR 0008's consolidation slice didn't reach: the link-table DDL in `runtime/database.ts:1075` (the very place junction tables are *created*) and inside `service.ts`'s column resolver.

**Decision (done):** Add `src/schema/physical_layout.ts` — the single home for logical-schema → physical-SQLite-layout facts, a cycle-safe leaf that imports only from `schema.ts` (its `usesLinkTable` / `qualifiedTypeName` / `SchemaSnapshot`) and `types.ts` (`TypeDef`):

- `resolveLinkStorageOwner(schema, typeDef, link) → TypeDef` — the owner walk, **with** the `linkDefsEquivalent` guard (the production behaviour). `engine.ts` imports it and its 5 call sites are unchanged; its local copy and the private `linkDefsEquivalent` are deleted.
- `makeLinkStorageOwnerResolver(schema)` — the compile-side adapter, now a thin wrapper: `qualifiedTypeName(resolveLinkStorageOwner(...))`. `service.ts` deletes its mirror and uses this, **gaining the guard** — the drift is closed by construction (both paths now read one walk).
- `makeTypeStorageColumnsResolver(schema)` — the column-set adapter, moved verbatim out of `service.ts` with the inline boolean replaced by `usesLinkTable`.
- `database.ts:1075` now calls `usesLinkTable(link)` instead of the inline negation.

The module is the new test surface: `tests/physical_layout.test.ts` (11 unit tests, synthetic name→TypeDef schema stubs — no SDL) pins the owner walk (overloaded, inherited-equivalent, the **non-equivalent guard**, base-without-link), the qualified-name adapter, and the column set (id + inline FK + inherited fields, FK exclusion for junction links, most-derived-wins).

**Decision (scoped out, deliberately):**

- The **inference oracle** (`semantic.ts:2113`) keeps its inline copy of the storage boolean — quarantined per ADR 0001, slated for wholesale deletion, not refactor.
- `uiSchema.ts:819`'s `properties.length === 0 && annotations.length === 0` is a **different rule** (link triviality including annotations), not the storage predicate; left in place.

**Verification.** The storage-relevant slice (`insert` / `linkprops` / `linkatoms` / `select` / `codegen_sql` / `userddl` / `inspect` / `sql_dml`, 1010 tests) ran `203 failed / 700 passed / 107 skipped` both before and after — the failures are the pre-existing partial-conformance baseline; zero new failures. 0 type errors. The guard addition to the compile path changed no existing test (the divergence is an untested edge case — exactly why it could rot), so the consolidation is behaviour-neutral on the suite while closing the latent bug. 11 new unit tests green.

**Consequences.** Physical layout has one home; the compile path and the runtime path derive link-table ownership from one walk, so they can no longer disagree. The link-storage boolean has no remaining live inline sites (only the quarantined oracle). The two-adapter seam the SQL compiler already exposed now has one adapter source instead of two that drift.

**Why record it:** a future reader will find `resolveLinkStorageOwner` imported into `engine.ts` from a schema module and may think it odd that a runtime concern lives under `schema/`. It is physical-layout knowledge, shared by compile and runtime; this records that the move unified two drifted copies (the `service.ts` mirror lacked `linkDefsEquivalent`), and that the guard is load-bearing — do not "simplify" the walk by dropping it.
