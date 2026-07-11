# Gel Golden Comparison

This note compares one Gel compiler-fact golden with sqlite-ts output for the same simple `SELECT`. The goal is to identify the stable structure we should shape our inspection output toward, while deliberately ignoring volatile implementation details such as memory addresses, generated UUIDs, and per-run aliases.

## Example Query

Source golden: `goldens/gel-compiler-facts/edgeql_select/TestEdgeQLSelect/test_edgeql_select_unique_02__001.json`

Source test: `tests/edgeql_select.test.ts`, `test_edgeql_select_unique_02`

Query:

```edgeql
SELECT Issue.owner { name }
ORDER BY Issue.owner.name;
```

This is a good tracer-bullet query because it is still basic, but it exercises a real object path, an explicit shape, an implicit `id` materialization, and an `ORDER BY` path.

## What The Gel Golden Has

The golden is a structured JSON record with these top-level sections:

| Section | Stable meaning | Example from the golden |
| --- | --- | --- |
| `ok` | Whether Gel compiled the query | `true` |
| `query` | Query text captured from the source test | `SELECT Issue.owner{name}\n ORDER BY Issue.owner.name;` |
| `schema_file` | Schema fixture used to compile | `tests/schemas/issues.esdl` |
| `source_test` | Python source location and case index | `TestEdgeQLSelect.test_edgeql_select_unique_02`, `case_index: 1` |
| `inference` | Statement-level semantic facts | `cardinality: MANY`, `multiplicity: UNIQUE`, `volatility: Stable` |
| `ir_kind_tree` | Gel IR shape with node kinds, types, path ids, shape ops | `Statement -> Set -> SelectStmt -> result Set` |
| `path_ids` | Flat list of every captured `Set` path id | `(__derived__::expr~2)`, `(default::Issue).>owner...` |
| `scope_tree` | Gel `scopetree.py`-style pformat | Top-level `FENCE`, nested fences, path nodes |
| `postgres_sql` | Gel's lowered PostgreSQL SQL | `SELECT ROW(...) FROM LATERAL (...) ORDER BY ...` |

Important stable details in this golden:

| Detail | Why it matters |
| --- | --- |
| A statement wrapper exists | Gel prints a top-level `Statement` whose `expr` is a `Set` around the `SelectStmt`. |
| The top-level select is a derived expression | The wrapping set has path id `(__derived__::expr~2)`. The exact number is per-compile, but the existence and derived-expression shape matter. |
| The selected object is a view type | The result type is `__derived__::default|User@view~1`, not plain `default::User`. The exact `view~N` suffix is generated, but the view boundary is meaningful. |
| Shape entries carry operations | The implicit `id` shape entry is `MATERIALIZE`; explicit `name` is `ASSIGN`. |
| The `path_ids` list includes owner, root, id, and name | The list captures both source and shape paths, not just the visible projection. |
| PathIds use Gel debug pointer names | Pointer names appear as `default::__|owner@default|Issue`, not just `owner`. |
| Scope tree is already rendered | It is a human-readable `FENCE` tree, not raw object JSON. |
| SQL contains volatile addresses and schema UUIDs | Comments like `<pg.SelectStmt at 0x...>` and physical table UUIDs should be normalized or ignored. |

## Current sqlite-ts Output

Current commands:

```sh
npx tsx bin/inspect.ts facts "SELECT Issue.owner{name} ORDER BY Issue.owner.name;" --schema issues
npx tsx bin/inspect.ts sql "SELECT Issue.owner{name} ORDER BY Issue.owner.name;" --schema issues
npx tsx bin/inspect.ts raw "SELECT Issue.owner{name} ORDER BY Issue.owner.name;" --schema issues
```

Current `facts` summary:

```json
{
  "statementKind": "select_expr",
  "loweringMode": "single_statement",
  "lowersToSingleSql": true,
  "strategy": "sql",
  "paramCount": 0,
  "subqueryCount": 3,
  "cteCount": 0,
  "valueFacts": {
    "category": "object",
    "typeName": "default::User"
  }
}
```

Current canonical SQLite SQL:

```sql
SELECT DISTINCT a0."id" AS "id", a0."__source_type" AS "__source_type", a0."name" AS "name"
FROM (
  SELECT t0.*
  FROM (SELECT 'default::Issue' AS "__source_type", "id" AS "id" FROM "default__issue") s0
  JOIN "default__issue__owner" a1 ON a1."source" = s0."id"
  JOIN (SELECT 'default::User' AS "__source_type", "id" AS "id", "name" AS "name" FROM "default__user") t0 ON t0."id" = a1."target"
) a0
ORDER BY a0."name" ASC
```

Current raw Live IR already contains more than `facts` exposes:

| Raw Live IR field | Current value for this query |
| --- | --- |
| `kind` | `select_stmt` |
| `cardinality` | `many` |
| `multiplicity` | `unique` |
| `volatility` | `stable` |
| `stype` | `default::User` |
| result path | `Issue -> owner`, held as structured `PathId` JSON |
| shape element | `name`, `shapeOp: assign`, `required: true`, `cardinality: one` |
| scope tree | Raw `scope_tree_node` objects with structural `sig:*` path ids |

## What Is Missing Or Different

| Gel golden feature | sqlite-ts status | Gap |
| --- | --- | --- |
| Golden-shaped top-level record | Missing | `inspect` returns an internal `Inspection`, not a Gel-like JSON document. |
| `source_test` metadata | Missing | We do not record source test class, name, or case index in generated outputs. |
| `schema_file` | Missing from `inspect` | The CLI knows `--schema issues`, but the inspection result does not retain the fixture path. |
| Inference block | Partially present | Raw Live IR has lowercase facts, but `facts` only exposes `valueFacts`; no Gel-style `inference` object is emitted. |
| Gel IR node names | Different | Gel uses `Statement`, `Set`, `SelectStmt`, `Pointer`; sqlite-ts uses `select_stmt`, `set`, `pointer`. This can be normalized. |
| Statement-level wrapping `Set` | Missing | sqlite-ts `select_stmt` is the statement root; Gel wraps the `SelectStmt` in a derived `Set`. Existing tests note the missing `expr~N` wrapper for derived expressions. |
| View type boundary | Missing or collapsed | Gel result type is `__derived__::default|User@view~1`; sqlite-ts reports `default::User`. |
| Shape operation visibility | Partially present | Raw Live IR has `shapeOp: assign`, but the current `irKindTree` strips it; implicit `id` materialization is not represented like Gel's `MATERIALIZE`. |
| Flat `path_ids` list | Partially present | `PathId` structures exist in raw IR and serializers exist, but `inspect` does not emit a flat list with owner, expr kind, node kind, path id, and type. |
| Gel debug PathId strings | Partially present | `serializePathId(..., { debug: true })` can produce Gel-style pointer names for real PathIds, but scope-tree paths are still structural `sig:*` names. |
| Scope-tree pformat | Partially present | `formatScopeTree` exists, but `inspect` does not include it; the tree currently uses structural names for AST-built paths. |
| Postgres SQL | Intentionally different | sqlite-ts lowers to SQLite, so the SQL dialect should not match. We should compare shape-level SQL facts, not byte-for-byte SQL. |
| SQL volatility normalization | Needed for Gel SQL only | Gel SQL includes memory addresses and physical schema UUIDs; these must be stripped or tokenized before comparison. |

## Stable Shape To Aim For

A sqlite-ts golden-alignment output for this query should look more like this shape:

```json
{
  "ok": true,
  "query": "SELECT Issue.owner { name }\\nORDER BY Issue.owner.name;",
  "schema_file": "tests/schemas/issues.esdl",
  "source_test": {
    "class": "TestEdgeQLSelect",
    "test": "test_edgeql_select_unique_02",
    "case_index": 1
  },
  "inference": {
    "cardinality": "MANY",
    "multiplicity": "UNIQUE",
    "stype": "default::User",
    "volatility": "Stable"
  },
  "ir_kind_tree": {},
  "path_ids": [],
  "scope_tree": "...pformat...",
  "sqlite_sql": "...canonical SQLite SQL..."
}
```

This should be a projection layer over the existing compile artifact, not a replacement for the Live IR. The projection can intentionally use Gel-compatible spelling while preserving sqlite-ts internals.

## Normalization Rules

Normalize these values before comparing against Gel-shaped goldens:

| Value | Rule |
| --- | --- |
| Generated expression names | Preserve relative shape like `expr~N`, but do not require the exact number unless the per-compile allocator is part of the test. |
| Generated view names | Preserve that a view type exists, but avoid depending on exact `view~N` unless testing view-name allocation. |
| Memory addresses | Replace `<pg.SelectStmt at 0x...>` with a token such as `<pg.SelectStmt>`. |
| Physical schema UUIDs | Replace table and column UUIDs with stable tokens, or compare logical SQL shape instead. |
| SQL aliases | Canonicalize aliases by first appearance, as `canonicalizeSql` already does for SQLite. |
| Enum case | Normalize Gel `MANY` and sqlite-ts `many` at the projection boundary. |
| Dialect-specific SQL | Keep `postgres_sql` and `sqlite_sql` separate; compare structure and compile facts, not raw dialect strings. |

## Recommended Next Steps

1. Add a `gelFacts` projection next to `src/compiler/inspect.ts` that emits `inference`, `path_ids`, `scope_tree`, and `sqlite_sql` without changing production compile behavior.
2. Build `path_ids` by walking every Live IR `set`, using `serializePathId(pathId, { debug: true })`, and recording `{ expr, node, owner, path_id, type }`.
3. Include `formatScopeTree(statement.scopeTree)` in the projection, accepting the known structural-name gap until scope-tree real PathIds land.
4. Add one snapshot for this exact query before widening to more goldens.
5. Treat missing statement wrapper, view type names, and implicit `id` materialization as real parity gaps, not serializer-only omissions.
