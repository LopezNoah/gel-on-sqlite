# Give the schema write-path a test surface

The round-9 review's candidate #3 found three correctness-critical modules on
the schema **write** path exercised only end-to-end (or as test *setup*), with
no direct test of their own logic — while their **read** twin, the gel_* table
decoder, had a seam and a test (`GelTableDecoder`, ADR 0034). The asymmetry let
the write halves drift from the read half silently:

- `gel_persistence.ts` serializers (`serializeSchemaToGelTables`,
  `serializeSchemaToInstdata`) — the inverse of the pinned decoder.
- `migrations.ts` — `planSchemaMigration` and its SQL renderers / checksum.
- `schema_introspection.ts` — `schemaIntrospectionTypeDefs` and
  `populateSchemaIntrospection`.

**Finding:** the interfaces were **already testable** — no extraction or new
seam was needed (the report's "expose behind small interfaces" over-stated the
work). `planSchemaMigration` / `renderMigrationSQL` / `renderSchemaSQL` /
`calculateMigrationChecksum` are pure over `DeclarativeSchema`; the serializers
and `deserialize*` are callable with an in-memory `openSQLite(":memory:")`;
`schemaIntrospectionTypeDefs` is a pure factory and `populateSchemaIntrospection`
runs against a materialized db. The friction was **missing tests**, not an
untestable interface.

**Decision (done):** add three additive test files, **no production change**:

- `tests/gel_persistence.test.ts` — round-trips **both** persistence paths
  (the normalized gel_* tables and the instdata JSON blob): a snapshot
  serialized then deserialized must come back equal. This pins read/write
  **symmetry** — the serializers can no longer drift from the decoder.
- `tests/migrations.test.ts` — `planSchemaMigration` over create / no-op /
  add-property / drop-type deltas, plus `calculateMigrationChecksum`
  determinism and sensitivity.
- `tests/schema_introspection.test.ts` — the meta-type catalog, and a populate
  that writes one `schema::ObjectType` row per user type and is idempotent
  (re-populate clears then rewrites — no duplicates).

**Known asymmetry, recorded not fixed.** The round-trip is **not byte-perfect**:
an inline single link's `<link>_id` FK column loses its `isLinkColumn` marker
and re-derives as a plain column, and some computed properties deserialize as
stored fields. The round-trip tests therefore compare a **normalized**
projection — property *names* (fields ∪ computeds, minus FK columns), type
names, the abstract flag, link target/cardinality, and function arity — which
are the dimensions the serializers are contracted to preserve. Closing the
asymmetry (so `isLinkColumn` / the computed flag survive) is a behaviour change,
out of scope here; the test surface now makes it visible.

**Verification.** `tsc --noEmit` clean; 17 new tests pass; no `src/` file
touched (purely additive). The round-trip runs against the full `issues.esdl`
fixture (28 types, 7 functions, inheritance, single/multi links, link
properties, computeds, exclusive constraints).

**Why record it.** A future reader sees round-trip tests that *normalize away*
FK columns and the computed-vs-stored distinction and may think the comparison
is too loose. It is deliberate: those two are the documented serialization
normalizations. The tests pin the contracted dimensions and surface the
asymmetry, rather than asserting an idealized equality the serializers do not
provide — closing that gap is its own behaviour-gated change.
