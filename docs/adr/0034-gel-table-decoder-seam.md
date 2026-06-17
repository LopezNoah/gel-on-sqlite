# A decoder seam for the gel_* table read path (and its test surface)

A round-5 architecture review found that decoding the `gel_*` metadata tables back into a `SchemaSnapshot` — the read counterpart of `serializeSchemaToGelTables` — was ~8 module-private helpers in `gel_persistence.ts` wired into the 320-line `deserializeSchemaFromGelTables` through a shared `idToRow` local (the `gel_schema` row index). Four of them resolved type ids against that map (`inferScalarType` / `resolveTargetType` / `typeNameFromId` / `mapFunctionMetadataParams`); four were pure parsers over the stored metadata strings (`parseComputedPropertyExpr` / `parseComputedLinkExpr` / `parseRewriteExpr` / `parseScalarValueFromMetadata`). None had a test surface: the only way to exercise a decode rule was a full schema round-trip, and the row-format coupling had no single home.

**Decision (done):** add `src/schema/gel_table_decoder.ts`.

- `GelTableDecoder` binds the row index once (as a `ReadonlyMap` — the decoder only reads, and the covariant value type lets the caller pass its richer `gel_schema` row map) and exposes the four id-resolving rules as methods: `scalarType` / `targetType` / `typeName` / `functionParams`.
- The four metadata-string parsers move out verbatim as pure exported functions.

`deserializeSchemaFromGelTables` now constructs `const dec = new GelTableDecoder(idToRow)` and calls `dec.scalarType(...)` / `dec.targetType(...)` / `dec.typeName(...)` / `dec.functionParams(...)`, importing the parsers by name. `gel_persistence.ts` shrinks by 113 lines (–125/+12); the serializers (the write path) stay put.

`parseComputedPropertyExpr` / `parseComputedLinkExpr` keep the names they share with the SDL-side parsers in `sdl_adapter.ts`, and stay separate from them: these decode the closed canonical output of `serializeComputedExpr`, not arbitrary user SDL (`docs/adr/0024`). Relocating the persistence-side copies does not change that boundary — they move within the persistence side, they do not merge with the front-end.

**Verification.** Behaviour-neutral by construction: the id-resolving rules moved field-for-field into methods reading `this.idToRow`, the parsers moved verbatim, and the JSON-blob path (`deserializeSchemaFromInstdata`, with its own `deserializeTypeDef`) is untouched. The round-trip slice (`dump01` / `edgeql_explain_lite` / `edgeql_userddl` / `edgeql_syntax`, 796 tests) ran `2 failed / 794 passed` both before and after — the same two pre-existing `edgeql_userddl` failures, zero new. `tsc` clean. New test surface: `tests/gel_table_decoder.test.ts` (26 unit tests) drives every decoder method against a fixture row index and every parser directly, including the two corrupt-metadata `throw` paths that previously had no isolated coverage.

**Consequences.** The `gel_*` row format has one decode home with a small interface and a real test surface. A change to the stored format — a new pointer kind, a new typemod — happens in `gel_table_decoder.ts`, guarded by its unit tests, instead of inside a 320-line reconstruction loop reachable only through a full round-trip.

**Why record it:** a future reader will see decoders in `gel_table_decoder.ts` and serializers still in `gel_persistence.ts` and may want to "complete" the move by pulling the serializers across too. The serializers depend on the live `SchemaSnapshot` and the write-side `idMap` (name → id), not the read-side row index; they are the inverse concern and are left where the write path lives, deliberately.
